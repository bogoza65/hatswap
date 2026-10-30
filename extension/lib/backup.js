// Encrypted backup export and restore.
//
// A backup is one JSON file:
//   { format: 'hatswap-backup', version: 1, createdAt, kdf: { iterations, salt }, data: { iv, ct } }
// `data` is the whole bundle (settings and every account with its session),
// encrypted with AES-256-GCM under a key derived from the master password with
// a fresh salt. Unlike the local store, account names and groups are inside the
// encrypted part too, since a backup file may sit in a cloud folder or an email.
//
// Restoring never restores "active account" markers: those only mean something on
// the machine whose cookie jar matches, and after a restore the user picks an
// account to switch to.

import { PBKDF2_ITERATIONS, randomBytes, toBase64, fromBase64, deriveKey, encryptJSON, decryptJSON } from './crypto.js';
import * as vault from './vault.js';
import { cleanMeta } from './accounts.js';
import { hostPattern, registrableDomain } from './site.js';

export const FORMAT = 'hatswap-backup';
export const VERSION = 1;
const CONTEXT = 'hatswap:backup:v1';
const MAX_FILE_BYTES = 50 * 1024 * 1024;

/** Encrypts everything into a backup file object. Needs the master password, not the unlocked key. */
export async function createBackup(password) {
  const key = await vault.keyFromPassword(String(password || ''));
  if (!key) throw new Error('Wrong master password.');

  const index = await vault.getIndex();
  const settings = await vault.getSettings();
  const accounts = [];
  const skipped = [];
  for (const meta of Object.values(index.accounts)) {
    try {
      accounts.push({ ...meta, session: await vault.readAccountSession(key, meta.id) });
    } catch {
      skipped.push(meta.name); // a damaged entry shouldn't block the rest
    }
  }

  const salt = randomBytes(16);
  const backupKey = await deriveKey(password, salt, PBKDF2_ITERATIONS);
  const data = await encryptJSON(backupKey, { settings, accounts }, CONTEXT);
  return {
    file: {
      format: FORMAT,
      version: VERSION,
      createdAt: Date.now(),
      kdf: { name: 'PBKDF2-SHA256', iterations: PBKDF2_ITERATIONS, salt: toBase64(salt) },
      data,
    },
    count: accounts.length,
    skipped,
  };
}

/** Parses and sanity-checks a backup file's text. Throws a user-facing error. */
export function parseBackup(text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error("That file is empty.");
  if (text.length > MAX_FILE_BYTES) throw new Error('That file is too large to be a Hatswap backup.');
  let file;
  try {
    file = JSON.parse(text);
  } catch {
    throw new Error("That isn't a Hatswap backup file.");
  }
  if (file?.format !== FORMAT) throw new Error("That isn't a Hatswap backup file.");
  if (file.version > VERSION) throw new Error('This backup was made by a newer Hatswap. Update Hatswap, then try again.');
  if (!file.kdf?.salt || !(file.kdf.iterations > 0) || !file.data?.iv || !file.data?.ct) throw new Error('This backup file is damaged.');
  return file;
}

/** Decrypts a parsed backup. Throws on a wrong password or a tampered file. */
export async function openBackup(file, password) {
  const key = await deriveKey(String(password || ''), fromBase64(file.kdf.salt), file.kdf.iterations);
  let bundle;
  try {
    bundle = await decryptJSON(key, file.data, CONTEXT);
  } catch {
    throw new Error("Wrong password for this backup, or the file has been changed.");
  }
  if (!Array.isArray(bundle?.accounts)) throw new Error('This backup file is damaged.');
  return bundle;
}

/** Keeps only the fields Hatswap knows, with the same limits as a fresh save. */
function sanitizeAccount(raw) {
  const id = typeof raw?.id === 'string' && /^[0-9a-f-]{36}$/i.test(raw.id) ? raw.id.toLowerCase() : null;
  const site = typeof raw?.site === 'string' ? registrableDomain(raw.site) : null;
  const session = raw?.session;
  if (!id || !site || !Array.isArray(session?.cookies)) return null;
  const number = (value) => (Number.isFinite(value) ? value : undefined);
  return {
    meta: {
      id,
      site,
      ...cleanMeta(raw, 'Account'),
      createdAt: number(raw.createdAt) ?? Date.now(),
      updatedAt: number(raw.updatedAt) ?? number(session.savedAt) ?? Date.now(),
      lastUsedAt: number(raw.lastUsedAt) ?? 0,
      cookieCount: session.cookies.length,
      origins: Object.keys(session.storage || {}),
    },
    session: {
      version: 1,
      savedAt: number(session.savedAt) ?? Date.now(),
      url: typeof session.url === 'string' ? session.url : '',
      cookies: session.cookies,
      storage: session.storage && typeof session.storage === 'object' ? session.storage : {},
      identity: session.identity && typeof session.identity === 'object' ? session.identity : {},
    },
  };
}

/**
 * Writes a decrypted bundle into storage. On a fresh install this creates the
 * vault with the backup's password. Into an existing vault it needs the current
 * key (`currentKey`, null when locked): new accounts are added, existing ones
 * are replaced only if the backup's copy is newer.
 */
export async function restoreBackup(bundle, password, currentKey) {
  const accounts = bundle.accounts.map(sanitizeAccount).filter(Boolean);
  const result = { created: false, added: 0, updated: 0, unchanged: 0, invalid: bundle.accounts.length - accounts.length, sites: [] };

  let key = currentKey;
  let index;
  if (!(await vault.hasVault())) {
    key = await vault.createVault(password, bundle.settings || {});
    index = await vault.getIndex();
    result.created = true;
  } else {
    if (!key) {
      const error = new Error('Hatswap is locked. Unlock it to add this backup to your existing accounts.');
      error.code = 'locked';
      throw error;
    }
    index = await vault.getIndex();
  }

  for (const { meta, session } of accounts) {
    const existing = index.accounts[meta.id];
    if (!existing) {
      index.accounts[meta.id] = meta;
      await vault.writeAccountSession(key, meta.id, session);
      result.added++;
    } else if (meta.updatedAt > (existing.updatedAt || 0)) {
      index.accounts[meta.id] = { ...existing, ...meta };
      await vault.writeAccountSession(key, meta.id, session);
      result.updated++;
    } else {
      result.unchanged++;
    }
  }
  await vault.saveIndex(index);
  result.sites = [...new Set(accounts.map((a) => a.meta.site))].sort().map((site) => ({ site, pattern: hostPattern(site) }));
  return result;
}
