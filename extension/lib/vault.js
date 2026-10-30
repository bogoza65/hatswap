// Local storage layout, encryption at rest and the lock.
//
// chrome.storage.local (on disk):
//   vault         { version, kdf: { iterations, salt }, check }   password verifier
//   settings      user preferences
//   index         { accounts: { [id]: meta }, active: { [siteKey]: id } }
//                 meta = name, group, color, timestamps. Not encrypted, so the
//                 toolbar badge can show the active account while locked.
//   account:<id>  AES-GCM encrypted session (cookies, Web Storage, last URL)
//
// chrome.storage.session (memory only, cleared when Chrome quits):
//   unlocked      { key, lastActive }   the derived key while unlocked

import { PBKDF2_ITERATIONS, randomBytes, toBase64, fromBase64, deriveKey, exportKey, importKey, encryptJSON, decryptJSON } from './crypto.js';

const CHECK_CONTEXT = 'hatswap:vault-check';
const accountStorageKey = (id) => `account:${id}`;
const accountContext = (id) => `hatswap:account:${id}`;

/** Auto-lock choices in minutes. 0 = only when Chrome closes. */
export const AUTO_LOCK_CHOICES = [1, 5, 15, 30, 60, 240, 0];
export const MIN_PASSWORD_LENGTH = 8;

export const DEFAULT_SETTINGS = {
  autoLockMinutes: 15,
  autoSave: true, // save the outgoing account's session before every switch
  afterSwitch: 'lastPage', // 'lastPage' (where you were in that account) or 'reload'
};

const EMPTY_INDEX = { accounts: {}, active: {} };

// chrome.storage.local throws a terse error when the 10 MB quota is hit.
async function write(items) {
  try {
    await chrome.storage.local.set(items);
  } catch (error) {
    if (/quota/i.test(error.message)) {
      throw new Error("Hatswap's local storage is full (Chrome allows 10 MB). Delete accounts you no longer use and try again.");
    }
    throw error;
  }
}

export async function hasVault() {
  const { vault } = await chrome.storage.local.get('vault');
  return Boolean(vault);
}

async function rememberKey(key) {
  await chrome.storage.session.set({ unlocked: { key: await exportKey(key), lastActive: Date.now() } });
}

function checkPassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Use at least ${MIN_PASSWORD_LENGTH} characters for the master password.`);
  }
}

export async function createVault(password, settings = {}) {
  checkPassword(password);
  if (await hasVault()) throw new Error('Hatswap is already set up.');
  const salt = randomBytes(16);
  const key = await deriveKey(password, salt, PBKDF2_ITERATIONS);
  const check = await encryptJSON(key, { createdAt: Date.now() }, CHECK_CONTEXT);
  await write({
    vault: { version: 1, kdf: { name: 'PBKDF2-SHA256', iterations: PBKDF2_ITERATIONS, salt: toBase64(salt) }, check },
    settings: normalizeSettings({ ...DEFAULT_SETTINGS, ...settings }),
    index: EMPTY_INDEX,
  });
  await rememberKey(key);
  return key;
}

/** The vault key for `password`, or null if the password is wrong. */
export async function keyFromPassword(password) {
  const { vault } = await chrome.storage.local.get('vault');
  if (!vault) throw new Error('Hatswap is not set up yet.');
  const key = await deriveKey(password, fromBase64(vault.kdf.salt), vault.kdf.iterations);
  try {
    await decryptJSON(key, vault.check, CHECK_CONTEXT);
    return key;
  } catch {
    return null; // AES-GCM authentication failed: wrong password
  }
}

/** Returns false for a wrong password. */
export async function unlock(password) {
  const key = await keyFromPassword(String(password || ''));
  if (!key) return false;
  await rememberKey(key);
  return true;
}

export async function lock() {
  await chrome.storage.session.remove('unlocked');
}

/**
 * The vault key, or null when locked. Enforces the idle timeout here, so an
 * expired key is never used even if the service worker slept through the
 * moment it should have locked. `touch` counts the call as activity.
 */
export async function getKey({ touch = true } = {}) {
  const { unlocked } = await chrome.storage.session.get('unlocked');
  if (!unlocked) return null;
  const { autoLockMinutes } = await getSettings();
  if (autoLockMinutes > 0 && Date.now() - unlocked.lastActive > autoLockMinutes * 60_000) {
    await lock();
    return null;
  }
  if (touch) await chrome.storage.session.set({ unlocked: { ...unlocked, lastActive: Date.now() } });
  return importKey(unlocked.key);
}

/** Timestamp when the vault will auto-lock, or null if locked / no timeout. */
export async function lockDeadline() {
  const { unlocked } = await chrome.storage.session.get('unlocked');
  const { autoLockMinutes } = await getSettings();
  if (!unlocked || !autoLockMinutes) return null;
  return unlocked.lastActive + autoLockMinutes * 60_000;
}

export async function changePassword(currentPassword, newPassword) {
  checkPassword(newPassword);
  const oldKey = await keyFromPassword(String(currentPassword || ''));
  if (!oldKey) throw new Error('The current master password is wrong.');

  const { vault } = await chrome.storage.local.get('vault');
  const index = await getIndex();
  const salt = randomBytes(16);
  const newKey = await deriveKey(newPassword, salt, PBKDF2_ITERATIONS);

  // Re-encrypt everything in memory first, then write it all in one call.
  const items = {
    vault: { ...vault, kdf: { ...vault.kdf, iterations: PBKDF2_ITERATIONS, salt: toBase64(salt) }, check: await encryptJSON(newKey, { createdAt: Date.now() }, CHECK_CONTEXT) },
  };
  const ids = Object.keys(index.accounts);
  const stored = await chrome.storage.local.get(ids.map(accountStorageKey));
  for (const id of ids) {
    const box = stored[accountStorageKey(id)];
    if (!box) continue;
    const session = await decryptJSON(oldKey, box, accountContext(id));
    items[accountStorageKey(id)] = await encryptJSON(newKey, session, accountContext(id));
  }
  await write(items);
  await rememberKey(newKey);
}

/** Wipes every saved account, the vault and the settings. */
export async function resetAll() {
  await chrome.storage.local.clear();
  await chrome.storage.session.clear();
}

export function normalizeSettings(settings) {
  const out = { ...DEFAULT_SETTINGS, ...settings };
  if (!AUTO_LOCK_CHOICES.includes(Number(out.autoLockMinutes))) out.autoLockMinutes = DEFAULT_SETTINGS.autoLockMinutes;
  out.autoLockMinutes = Number(out.autoLockMinutes);
  out.autoSave = Boolean(out.autoSave);
  if (!['lastPage', 'reload'].includes(out.afterSwitch)) out.afterSwitch = DEFAULT_SETTINGS.afterSwitch;
  return out;
}

export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return normalizeSettings(settings);
}

export async function saveSettings(patch) {
  const settings = normalizeSettings({ ...(await getSettings()), ...patch });
  await write({ settings });
  return settings;
}

export async function getIndex() {
  const { index } = await chrome.storage.local.get('index');
  return { accounts: { ...index?.accounts }, active: { ...index?.active } };
}

export async function saveIndex(index) {
  await write({ index });
}

export async function writeAccountSession(key, id, session) {
  await write({ [accountStorageKey(id)]: await encryptJSON(key, session, accountContext(id)) });
}

export async function readAccountSession(key, id) {
  const storageKey = accountStorageKey(id);
  const { [storageKey]: box } = await chrome.storage.local.get(storageKey);
  if (!box) throw new Error('The saved session for this account is missing.');
  return decryptJSON(key, box, accountContext(id));
}

export async function deleteAccountSession(id) {
  await chrome.storage.local.remove(accountStorageKey(id));
}

export function bytesInUse() {
  return chrome.storage.local.getBytesInUse(null);
}
