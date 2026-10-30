// Hatswap service worker. Owns everything that touches sessions: snapshots,
// switching, encryption, the badge and the keyboard shortcut. The popup is a thin
// UI that talks to it with runtime messages.

import { describeUrl, hostPattern } from './lib/site.js';
import { cookieStoreForTab, readSiteCookies, serializeCookie, clearSiteCookies, restoreSiteCookies } from './lib/cookies.js';
import { captureTabs, restoreTabs } from './lib/webstorage.js';
import * as vault from './lib/vault.js';
import { cleanMeta, defaultColor, initials, siteKey, sortAccounts, textColorOn } from './lib/accounts.js';
import { compareIdentity, hasLoginCookies, loginCookiesUnchanged, nextIdentity } from './lib/identity.js';
import { createBackup, parseBackup, openBackup, restoreBackup } from './lib/backup.js';

// ---------------------------------------------------------------------------
// Helpers

// Switching rewrites shared state (cookies, the index), so every mutating
// operation runs one at a time.
let queue = Promise.resolve();
function serial(task) {
  const run = queue.then(task, task);
  queue = run.catch(() => {});
  return run;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(condition, timeoutMs) {
  for (const end = Date.now() + timeoutMs; Date.now() < end; await sleep(100)) {
    if (await condition()) return true;
  }
  return false;
}

function lockedError() {
  const error = new Error('Hatswap is locked. Unlock it with your master password.');
  error.code = 'locked';
  return error;
}

async function requireKey() {
  const key = await vault.getKey();
  if (!key) throw lockedError();
  return key;
}

/**
 * Everything an operation needs to know about the tab's site: the tab, the site,
 * its cookie store, and every open tab on the same site (primary tab first).
 */
async function siteContext(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) throw new Error('That tab was closed. Open the site again and retry.');
  const info = describeUrl(tab.url || '');
  if (!info.supported) throw new Error(info.reason);
  if (!(await chrome.permissions.contains({ origins: [info.pattern] }))) {
    const error = new Error(`Hatswap doesn't have access to ${info.site}. Allow access and try again.`);
    error.code = 'no-access';
    throw error;
  }
  const storeId = await cookieStoreForTab(tab.id);
  const siteTabs = await chrome.tabs.query({ url: info.pattern }).catch(() => []);
  const others = siteTabs.filter((t) => t.id !== tab.id && t.incognito === tab.incognito && describeUrl(t.url || '').site === info.site);
  return { tab, info, storeId, tabs: [tab, ...others], key: siteKey(info.site, tab.incognito) };
}

/**
 * Snapshot of the site's current session: cookies, Web Storage of open tabs, URL,
 * plus the login-cookie learning state (see lib/identity.js). `previous` is the
 * account's last snapshot when updating it, null for a fresh baseline.
 */
async function captureSession(ctx, previous, { cookies, rotating = [], usedSince = false } = {}) {
  const serialized = (cookies || (await readSiteCookies(ctx.info.site, ctx.storeId))).map(serializeCookie);
  const { storage, failures } = await captureTabs(ctx.tabs);
  return {
    session: {
      version: 1,
      savedAt: Date.now(),
      url: ctx.tab.url,
      cookies: serialized,
      // Storage of origins without an open tab can't be read, so keep what was saved before.
      storage: { ...previous?.storage, ...storage },
      identity: nextIdentity(previous, serialized, { rotating, usedSince }),
    },
    warnings: failures.map((failure) => `Page storage wasn't saved for ${failure}.`),
  };
}

function sessionMismatchError(account, check, site) {
  const error = new Error(check.signedOut
    ? `${site} looks signed out, so Hatswap didn't save over “${account.name}”.`
    : `The session on ${site} doesn't look like “${account.name}” anymore, so Hatswap didn't save over it.`);
  error.code = 'session-mismatch';
  error.details = { accountId: account.id, accountName: account.name, names: check.names, signedOut: check.signedOut };
  return error;
}

/** How the live session compares with the active account's snapshot, or null if there's no active account. */
async function checkActiveSession(key, ctx, index, liveCookies) {
  const id = index.active[ctx.key];
  if (!id || !index.accounts[id]) return null;
  const saved = await vault.readAccountSession(key, id).catch(() => null);
  if (!saved) return null;
  const cookies = liveCookies || (await readSiteCookies(ctx.info.site, ctx.storeId));
  return cookies.length ? compareIdentity(saved, cookies) : { status: 'mismatch', basis: 'all', changed: [], names: [], signedOut: true };
}

async function storeSession(key, index, id, session) {
  await vault.writeAccountSession(key, id, session);
  delete index.accounts[id].rejectedAt;
  Object.assign(index.accounts[id], {
    updatedAt: session.savedAt,
    cookieCount: session.cookies.length,
    origins: Object.keys(session.storage),
  });
}

/**
 * Saves the live session into the site's active account. Refuses (throws
 * 'session-mismatch') when the live session no longer looks like that account,
 * unless the user confirmed it is (`resolution: 'update'`), in which case the
 * login cookies that changed are remembered as ones that rotate on their own.
 */
async function saveIntoActive(key, ctx, index, resolution) {
  const id = index.active[ctx.key];
  const account = index.accounts[id];
  const cookies = await readSiteCookies(ctx.info.site, ctx.storeId);
  // An empty cookie jar means cookies were cleared by hand; keep the good snapshot.
  if (!cookies.length) return [`Didn't save “${account.name}” because the site has no cookies right now.`];

  const previous = await vault.readAccountSession(key, id).catch(() => null);
  const check = previous ? compareIdentity(previous, cookies) : { status: 'unknown' };
  if (check.status === 'mismatch' && resolution !== 'update') throw sessionMismatchError(account, check, ctx.info.site);

  const rotating = resolution === 'update' && check.basis === 'stable' ? check.changed : [];
  const usedSince = Boolean(previous && account.restoredAt > previous.savedAt);
  const { session, warnings } = await captureSession(ctx, previous, { cookies, rotating, usedSince });
  await storeSession(key, index, id, session);
  return warnings;
}

/** Auto-save before switching away, so refreshed tokens aren't lost. */
async function autoSaveActive(key, ctx, index, resolution) {
  const settings = await vault.getSettings();
  const id = index.active[ctx.key];
  if (!settings.autoSave || !id || !index.accounts[id] || resolution === 'skip') return [];
  return saveIntoActive(key, ctx, index, resolution);
}

// Pages that only make sense mid-login. Returning to one would break the session.
const AUTH_PATH = /(log|sign)[-_]?(in|out|off|up)|oauth|callback|\bsso\b|\bauth\b/i;
const AUTH_HOST = /^(login|signin|auth|accounts|sso|id)\./i;

function isLoginPage(url) {
  try {
    const parsed = new URL(url);
    return AUTH_PATH.test(parsed.pathname) || AUTH_HOST.test(parsed.hostname);
  } catch {
    return false;
  }
}

/** Where to send the tab after switching: the account's last page, if it's safe. */
function returnUrl(url, site) {
  const info = describeUrl(url || '');
  if (!info.supported || info.site !== site) return null;
  const parsed = new URL(url);
  return AUTH_PATH.test(parsed.pathname) ? `${parsed.origin}/` : url;
}

/**
 * Writes the next account's Web Storage into every open tab of the site, then
 * unloads those pages. Busy apps (Buffer, for one) always have API requests in
 * flight, and their responses renew the session cookie. One that lands after
 * the cookie swap would put the old account back, so the old pages must be gone
 * before any cookie changes.
 */
async function parkTabs(tabs, storage) {
  const { failures, unreached } = await restoreTabs(tabs, storage, { leave: true });
  // Pages the script couldn't reach still have to stop.
  await Promise.allSettled(unreached.map((id) => chrome.tabs.update(id, { url: 'about:blank' })));
  await waitFor(async () => {
    const current = await Promise.all(tabs.map((tab) => chrome.tabs.get(tab.id).catch(() => null)));
    return current.every((tab) => !tab || (tab.url === 'about:blank' && tab.status === 'complete'));
  }, 3000);
  await sleep(200); // let responses that were already arriving settle before the swap
  return failures;
}

/** Loads the site again in every parked tab. The primary tab goes to `destination` if given. */
async function returnTabs(ctx, destination) {
  await Promise.allSettled(ctx.tabs.map(async (tab, i) => {
    const url = (i === 0 && destination) || tab.url;
    try {
      // From the parked (same-origin) blank page, location.replace leaves no extra history entry.
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', func: (to) => location.replace(to), args: [url] });
    } catch {
      await chrome.tabs.update(tab.id, { url });
    }
  }));
}

/**
 * After a switch, checks that the site kept the restored session: the tab must
 * not have bounced to a login page, and the login cookies must still look like
 * the account's. When the site threw the session away (usually because it
 * expired on the server), the account is flagged, so the badge and popup say so
 * instead of the switch silently "just reloading".
 */
async function verifySwitch(ctx, accountId, session, destination) {
  const loaded = await waitFor(async () => {
    const tab = await chrome.tabs.get(ctx.tab.id).catch(() => null);
    return !tab || (tab.status === 'complete' && !tab.url.startsWith('about:'));
  }, 20_000);
  if (!loaded) return;
  await sleep(1500); // redirects to a login page take a moment
  await serial(async () => {
    const index = await vault.getIndex();
    const account = index.accounts[accountId];
    if (!account || index.active[ctx.key] !== accountId) return;
    const tab = await chrome.tabs.get(ctx.tab.id).catch(() => null);
    const bounced = Boolean(tab && isLoginPage(tab.url) && !isLoginPage(destination));
    const check = compareIdentity(session, await readSiteCookies(ctx.info.site, ctx.storeId));
    if (!bounced && check.status !== 'mismatch') return;
    account.rejectedAt = Date.now();
    await vault.saveIndex(index);
    refreshAllBadges();
  });
}

/** True when the site threw away this account's session right after Hatswap restored it. */
function isRejected(account) {
  return Boolean(account?.rejectedAt && account.rejectedAt >= (account.restoredAt || 0));
}

// ---------------------------------------------------------------------------
// Site actions (need host access to the site)

async function saveNewAccount(tabId, meta = {}) {
  const key = await requireKey();
  const ctx = await siteContext(tabId);
  const index = await vault.getIndex();
  const count = Object.values(index.accounts).filter((a) => a.site === ctx.info.site).length;

  const { session, warnings } = await captureSession(ctx, null);
  if (!session.cookies.length) throw new Error(`No cookies found for ${ctx.info.site}. Sign in first, then save the account.`);

  const id = crypto.randomUUID();
  const now = Date.now();
  index.accounts[id] = {
    id,
    site: ctx.info.site,
    ...cleanMeta({ ...meta, color: meta.color || defaultColor(count) }, `Account ${count + 1}`),
    createdAt: now,
    lastUsedAt: now,
  };
  await storeSession(key, index, id, session);
  index.active[ctx.key] = id;
  await vault.saveIndex(index);
  refreshBadges(ctx.tabs);
  return { account: index.accounts[id], warnings };
}

/**
 * `resolution` answers a 'session-mismatch' question: 'update' (it's still the
 * active account, save it) or 'skip' (don't save the live session).
 */
async function switchAccount(tabId, accountId, resolution) {
  const key = await requireKey();
  const ctx = await siteContext(tabId);
  const index = await vault.getIndex();
  const target = index.accounts[accountId];
  if (!target) throw new Error('That account no longer exists.');
  if (target.site !== ctx.info.site) throw new Error(`"${target.name}" is saved for ${target.site}, not ${ctx.info.site}.`);

  const isActive = index.active[ctx.key] === accountId;
  if (isActive && resolution !== 'skip') {
    // Re-applying the active account's (older) snapshot could undo token refreshes,
    // so that only happens when the live session isn't that account anymore.
    const check = await checkActiveSession(key, ctx, index);
    if (check?.status !== 'mismatch') return { account: target, already: true, warnings: [] };
    throw sessionMismatchError(target, check, ctx.info.site);
  }

  const warnings = isActive ? [] : await autoSaveActive(key, ctx, index, resolution);
  const session = await vault.readAccountSession(key, accountId);

  // 1. Put the account's Web Storage in place and unload the site's pages, so
  //    requests the old account still has in flight can't set its cookies again.
  for (const failure of await parkTabs(ctx.tabs, session.storage)) warnings.push(`Page storage wasn't restored for ${failure}.`);

  // 2. Delete every cookie for the site.
  const cleared = await clearSiteCookies(ctx.info.site, ctx.storeId, ctx.info.scheme);
  if (cleared.remaining.length) warnings.push(`Couldn't delete ${cleared.remaining.length} cookie(s): ${cleared.remaining.join(', ')}.`);

  // 3. Restore the account's cookies.
  const restored = await restoreSiteCookies(session.cookies, ctx.storeId, ctx.info.scheme);
  for (const failure of restored.failed) warnings.push(`Cookie "${failure.name}" (${failure.domain}) wasn't restored: ${failure.error}`);

  index.active[ctx.key] = accountId;
  target.lastUsedAt = Date.now();
  target.restoredAt = target.lastUsedAt; // lets the login-cookie learning know this snapshot gets used
  await vault.saveIndex(index);

  // 4. Load the site again with the new session, then check in the background that it stuck.
  const settings = await vault.getSettings();
  const destination = (settings.afterSwitch === 'lastPage' && returnUrl(session.url, ctx.info.site)) || ctx.tab.url;
  await returnTabs(ctx, destination);
  refreshBadges(ctx.tabs);
  verifySwitch(ctx, accountId, session, destination);
  return { account: target, restored: restored.restored, expired: restored.expired, warnings };
}

/** "New account": signs the browser out of the site (locally only) so another account can sign in. */
async function startNewLogin(tabId, resolution) {
  const ctx = await siteContext(tabId);
  const index = await vault.getIndex();
  const warnings = index.active[ctx.key] ? await autoSaveActive(await requireKey(), ctx, index, resolution) : [];

  for (const failure of await parkTabs(ctx.tabs, {})) warnings.push(`Page storage wasn't cleared for ${failure}.`);
  const cleared = await clearSiteCookies(ctx.info.site, ctx.storeId, ctx.info.scheme);
  if (cleared.remaining.length) warnings.push(`Couldn't delete ${cleared.remaining.length} cookie(s): ${cleared.remaining.join(', ')}.`);

  delete index.active[ctx.key];
  await vault.saveIndex(index);
  await returnTabs(ctx, null);
  refreshBadges(ctx.tabs);
  return { removed: cleared.removed, warnings };
}

/** Replaces an account's saved session with whatever the site is signed in as now. */
async function refreshAccount(tabId, accountId) {
  const key = await requireKey();
  const ctx = await siteContext(tabId);
  const index = await vault.getIndex();
  const account = index.accounts[accountId];
  if (!account) throw new Error('That account no longer exists.');
  if (account.site !== ctx.info.site) throw new Error(`"${account.name}" is saved for ${account.site}, not ${ctx.info.site}.`);

  const { session, warnings } = await captureSession(ctx, null);
  if (!session.cookies.length) throw new Error(`No cookies found for ${ctx.info.site}. Sign in first.`);
  // Don't replace a real login with a signed-out page, or re-save the very
  // cookies the site just rejected (the user hasn't signed in again yet).
  const previous = await vault.readAccountSession(key, accountId).catch(() => null);
  const signedOut = previous && hasLoginCookies(previous.cookies) && !hasLoginCookies(session.cookies);
  const stillRejected = previous && isRejected(account) && loginCookiesUnchanged(previous, session.cookies);
  if (signedOut || stillRejected) {
    throw new Error(`${ctx.info.site} doesn't look signed in as “${account.name}” yet. Sign in on the page first, then update it.`);
  }
  await storeSession(key, index, accountId, session);
  index.active[ctx.key] = accountId;
  await vault.saveIndex(index);
  refreshBadges(ctx.tabs);
  return { account, warnings };
}

/** "It's still this account": saves the live session into the active account and learns from it. */
async function confirmActiveSession(tabId) {
  const key = await requireKey();
  const ctx = await siteContext(tabId);
  const index = await vault.getIndex();
  const account = index.accounts[index.active[ctx.key]];
  if (!account) throw new Error(`No account is active on ${ctx.info.site}.`);
  const warnings = await saveIntoActive(key, ctx, index, 'update');
  await vault.saveIndex(index);
  return { account, warnings };
}

/**
 * Before a backup: saves the live session of every active account whose site has
 * an open tab, so the file isn't a token rotation behind. The manual-login guard
 * applies as usual; a mismatch is reported, not forced.
 */
async function refreshActiveSessions(key) {
  const index = await vault.getIndex();
  const warnings = [];
  for (const [siteKey, id] of Object.entries(index.active)) {
    const account = index.accounts[id];
    if (!account) continue;
    const incognito = siteKey.endsWith('#incognito');
    try {
      const tabs = await chrome.tabs.query({ url: hostPattern(account.site) });
      const tab = tabs.find((t) => t.incognito === incognito && describeUrl(t.url || '').site === account.site);
      if (!tab) continue;
      const ctx = await siteContext(tab.id);
      warnings.push(...(await saveIntoActive(key, ctx, index)).map((w) => `${account.name}: ${w}`));
    } catch (error) {
      warnings.push(`${account.name} wasn't refreshed before the backup: ${error.message}`);
    }
  }
  await vault.saveIndex(index);
  return warnings;
}

function runSiteAction(action) {
  switch (action?.kind) {
    case 'save': return saveNewAccount(action.tabId, action.meta);
    case 'switch': return switchAccount(action.tabId, action.accountId, action.resolution);
    case 'newLogin': return startNewLogin(action.tabId, action.resolution);
    case 'refresh': return refreshAccount(action.tabId, action.accountId);
    case 'keep': return confirmActiveSession(action.tabId);
    default: throw new Error('Unknown action.');
  }
}

// ---------------------------------------------------------------------------
// Actions waiting on a host-permission prompt.
//
// chrome.permissions.request must be called from the popup, and on some
// platforms the popup closes as soon as Chrome's permission dialog appears. So
// the popup queues the action here first; it runs when the popup reports the
// grant, or from permissions.onAdded if the popup is already gone.

const PENDING_TTL = 10 * 60_000;

async function loadPending() {
  const { pending = {} } = await chrome.storage.session.get('pending');
  for (const [id, entry] of Object.entries(pending)) {
    if (Date.now() - entry.createdAt > PENDING_TTL) delete pending[id];
  }
  return pending;
}

const savePending = (pending) => chrome.storage.session.set({ pending });

async function queueAction(pendingId, action) {
  const tab = await chrome.tabs.get(action.tabId);
  const pending = await loadPending();
  pending[pendingId] ??= { action, pattern: describeUrl(tab.url || '').pattern, status: 'queued', createdAt: Date.now() };
  await savePending(pending);
  return {};
}

async function runPending(pendingId, fallbackAction) {
  const pending = await loadPending();
  const entry = pending[pendingId];
  if (entry?.status === 'done') return entry.result;
  const result = await runSiteAction(entry?.action || fallbackAction).then(
    (value) => ({ ok: true, ...value }),
    (error) => errorResponse(error),
  );
  pending[pendingId] = { status: 'done', result, createdAt: entry?.createdAt || Date.now() };
  await savePending(pending);
  return result;
}

async function dropPending(pendingId) {
  const pending = await loadPending();
  delete pending[pendingId];
  await savePending(pending);
  return {};
}

chrome.permissions.onAdded.addListener(() =>
  serial(async () => {
    const pending = await loadPending();
    let ran = false;
    for (const [id, entry] of Object.entries(pending)) {
      if (entry.status !== 'queued' || !entry.pattern) continue;
      if (!(await chrome.permissions.contains({ origins: [entry.pattern] }))) continue;
      await runPending(id);
      ran = true;
    }
    // If the popup closed during the prompt, reopen it so the user sees the result.
    if (ran) {
      try {
        const popups = await chrome.runtime.getContexts({ contextTypes: ['POPUP'] });
        if (!popups.length) await chrome.action.openPopup();
      } catch { /* openPopup isn't always allowed; the badge still shows the result */ }
    }
  }),
);

// ---------------------------------------------------------------------------
// Account metadata

async function updateAccount(id, meta) {
  await requireKey();
  const index = await vault.getIndex();
  const account = index.accounts[id];
  if (!account) throw new Error('That account no longer exists.');
  Object.assign(account, cleanMeta({ ...account, ...meta }, account.name));
  await vault.saveIndex(index);
  refreshAllBadges();
  return { account };
}

async function deleteAccount(id) {
  await requireKey();
  const index = await vault.getIndex();
  const account = index.accounts[id];
  if (!account) return {};
  delete index.accounts[id];
  for (const [key, activeId] of Object.entries(index.active)) if (activeId === id) delete index.active[key];
  await vault.deleteAccountSession(id);
  await vault.saveIndex(index);
  // Keep host access only for sites that still have saved accounts.
  if (!Object.values(index.accounts).some((a) => a.site === account.site)) {
    await chrome.permissions.remove({ origins: [hostPattern(account.site)] }).catch(() => {});
  }
  refreshAllBadges();
  return {};
}

// ---------------------------------------------------------------------------
// Popup state

async function getState(tabId) {
  const settings = await vault.getSettings();
  let status = 'setup';
  if (await vault.hasVault()) status = (await vault.getKey()) ? 'unlocked' : 'locked';

  const tab = tabId ? await chrome.tabs.get(tabId).catch(() => null) : null;
  const info = tab ? describeUrl(tab.url || '') : { supported: false, reason: 'Open a website to manage its accounts.' };
  const commands = await chrome.commands.getAll();
  const state = {
    status,
    settings,
    tab: info,
    shortcuts: Object.fromEntries(commands.map((c) => [c.name, c.shortcut || ''])),
    version: chrome.runtime.getManifest().version,
  };
  if (status !== 'unlocked') return state;

  const index = await vault.getIndex();
  const all = Object.values(index.accounts);
  state.groups = [...new Set(all.map((a) => a.group).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  state.sites = Object.entries(all.reduce((acc, a) => ({ ...acc, [a.site]: (acc[a.site] || 0) + 1 }), {}))
    .map(([site, count]) => ({ site, count }))
    .sort((a, b) => a.site.localeCompare(b.site));
  state.bytesInUse = await vault.bytesInUse();
  if (info.supported) {
    state.hasAccess = await chrome.permissions.contains({ origins: [info.pattern] });
    state.accounts = sortAccounts(all.filter((a) => a.site === info.site));
    state.activeId = index.active[siteKey(info.site, tab.incognito)] || null;
    // Tell the user up front when the live session has drifted from the active account.
    if (state.hasAccess && state.activeId) {
      const key = await vault.getKey({ touch: false });
      const ctx = { info, storeId: await cookieStoreForTab(tab.id), key: siteKey(info.site, tab.incognito) };
      const check = await checkActiveSession(key, ctx, index).catch(() => null);
      if (check) state.sessionCheck = { status: check.status, names: check.names || [], signedOut: Boolean(check.signedOut) };
    }
  }
  return state;
}

// ---------------------------------------------------------------------------
// Badge: initials + colour of the active account on the tab's site.

const NEUTRAL = '#5E6470';
const REJECTED = '#CF3628';

async function refreshBadge(tab, index) {
  if (!tab || !(tab.id >= 0)) return;
  index ||= await vault.getIndex();
  const info = describeUrl(tab.url || '');
  const id = info.supported ? index.active[siteKey(info.site, tab.incognito)] : null;
  const account = id ? index.accounts[id] : null;
  const rejected = isRejected(account);
  const color = rejected ? REJECTED : account?.color;
  const tabId = tab.id;
  try {
    await chrome.action.setBadgeText({ tabId, text: account ? (rejected ? '!' : initials(account.name)) : '' });
    if (account) {
      await chrome.action.setBadgeBackgroundColor({ tabId, color });
      await chrome.action.setBadgeTextColor?.({ tabId, color: textColorOn(color) });
    }
    let title = 'Hatswap';
    if (rejected) title = `Hatswap: ${info.site} rejected the saved session for ${account.name}. Open Hatswap for what to do.`;
    else if (account) title = `Hatswap: ${account.name}${account.group ? ` · ${account.group}` : ''} on ${info.site}`;
    await chrome.action.setTitle({ tabId, title });
  } catch { /* the tab closed meanwhile */ }
}

async function refreshBadges(tabs) {
  const index = await vault.getIndex();
  await Promise.all(tabs.map((tab) => refreshBadge(tab, index)));
}

async function refreshAllBadges() {
  await refreshBadges(await chrome.tabs.query({}));
}

/** Briefly shows a status on the badge, e.g. when the shortcut can't switch. */
async function flashBadge(tab, text, title) {
  if (!tab?.id) return;
  try {
    await chrome.action.setBadgeText({ tabId: tab.id, text });
    await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: NEUTRAL });
    await chrome.action.setBadgeTextColor?.({ tabId: tab.id, color: '#FFFFFF' });
    if (title) await chrome.action.setTitle({ tabId: tab.id, title: `Hatswap: ${title}` });
  } catch { return; }
  setTimeout(() => chrome.tabs.get(tab.id).then((fresh) => refreshBadge(fresh), () => {}), 2500);
}

// ---------------------------------------------------------------------------
// Keyboard shortcut: cycle through the site's accounts in display order.

async function runCommand(command, tab) {
  const step = { 'switch-next': 1, 'switch-previous': -1 }[command];
  if (!step) return;
  if (!tab?.id) [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) return;

  const info = describeUrl(tab.url || '');
  if (!info.supported) return flashBadge(tab, '–', info.reason);
  if (!(await vault.getKey({ touch: false }))) {
    try {
      await chrome.action.openPopup(); // lets the user unlock right away
    } catch {
      await flashBadge(tab, 'LOCK', 'locked. Click the icon to unlock.');
    }
    return;
  }

  const index = await vault.getIndex();
  const accounts = sortAccounts(Object.values(index.accounts).filter((a) => a.site === info.site));
  if (!accounts.length) return flashBadge(tab, '0', `no saved accounts for ${info.site}.`);
  const current = accounts.findIndex((a) => a.id === index.active[siteKey(info.site, tab.incognito)]);
  const next = current === -1 ? (step > 0 ? 0 : accounts.length - 1) : (current + step + accounts.length) % accounts.length;
  if (next === current) return flashBadge(tab, '1', `only one account saved for ${info.site}.`);

  try {
    await serial(() => switchAccount(tab.id, accounts[next].id));
  } catch (error) {
    await flashBadge(tab, error.code === 'session-mismatch' ? '?' : '!', error.message);
    // The popup explains the mismatch and offers what to do about it.
    if (error.code === 'session-mismatch') await chrome.action.openPopup().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Auto-lock. vault.getKey() enforces the timeout on every use; this timer also
// wipes the key from memory on time while the service worker happens to be awake.

let lockTimer;
async function scheduleAutoLock() {
  clearTimeout(lockTimer);
  const deadline = await vault.lockDeadline();
  if (deadline) lockTimer = setTimeout(() => vault.getKey({ touch: false }), Math.max(0, deadline - Date.now()) + 1000);
}

// ---------------------------------------------------------------------------
// Messages from the popup

function errorResponse(error) {
  return { ok: false, error: error?.message || String(error), code: error?.code, details: error?.details };
}

const handlers = {
  getState: ({ tabId }) => getState(tabId),
  setup: async ({ password, autoLockMinutes }) => {
    await vault.createVault(password, { autoLockMinutes });
    return {};
  },
  unlock: async ({ password }) => {
    if (!(await vault.unlock(password))) throw new Error('Wrong master password.');
    return {};
  },
  lock: async () => {
    await vault.lock();
    return {};
  },
  run: ({ action }) => runSiteAction(action),
  queue: ({ pendingId, action }) => queueAction(pendingId, action),
  runQueued: ({ pendingId, action }) => runPending(pendingId, action),
  dropQueued: ({ pendingId }) => dropPending(pendingId),
  updateAccount: ({ id, meta }) => updateAccount(id, meta),
  deleteAccount: ({ id }) => deleteAccount(id),
  saveSettings: async ({ settings }) => {
    await requireKey();
    return { settings: await vault.saveSettings(settings) };
  },
  changePassword: async ({ current, next }) => {
    await vault.changePassword(current, next);
    return {};
  },
  backupExport: async ({ password }) => {
    const key = await vault.keyFromPassword(String(password || ''));
    if (!key) throw new Error('Wrong master password.');
    const warnings = await refreshActiveSessions(key);
    const backup = await createBackup(password);
    return { ...backup, warnings };
  },
  backupImport: async ({ text, password }) => {
    const file = parseBackup(text);
    const bundle = await openBackup(file, password);
    const result = await restoreBackup(bundle, password, await vault.getKey());
    const sites = await Promise.all(result.sites.map(async (s) => ({ ...s, granted: await chrome.permissions.contains({ origins: [s.pattern] }) })));
    refreshAllBadges();
    return { ...result, sites, createdAt: file.createdAt };
  },
  reset: async () => {
    await vault.resetAll();
    const { origins = [] } = await chrome.permissions.getAll();
    if (origins.length) await chrome.permissions.remove({ origins }).catch(() => {});
    refreshAllBadges();
    return {};
  },
};

// Reads skip the queue so the popup opens instantly even while a switch runs.
const READ_ONLY = new Set(['getState']);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Only the extension's own pages may talk to the service worker.
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(''))) return false;
  const handler = handlers[message?.type];
  if (!handler) return false;
  const task = () => handler(message);
  (READ_ONLY.has(message.type) ? task() : serial(task))
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => sendResponse(errorResponse(error)))
    .finally(scheduleAutoLock);
  return true;
});

// ---------------------------------------------------------------------------
// Lifecycle

chrome.commands.onCommand.addListener((command, tab) => runCommand(command, tab));
chrome.runtime.onInstalled.addListener(refreshAllBadges);
chrome.runtime.onStartup.addListener(refreshAllBadges);
chrome.tabs.onActivated.addListener(({ tabId }) => chrome.tabs.get(tabId).then((tab) => refreshBadge(tab), () => {}));
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.url || change.status === 'complete') refreshBadge(tab);
});

// Handy from the service worker console (chrome://extensions → Hatswap → service worker).
globalThis.hatswap = { runCommand, refreshAllBadges };
