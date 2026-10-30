// "Is the live session still this account?" — a heuristic guard that runs before
// Hatswap auto-saves over an account.
//
// Sites refresh some login cookies all the time (that's normal and must be saved),
// while a manual sign-in to another account replaces the ones that identify the
// user. Hatswap can't read cookie meanings, so it learns per account which login
// cookies normally survive a stretch of use unchanged ("stable"). If one of those
// is now different or gone, the live session probably belongs to someone else.
//
// Only httpOnly cookies count: login cookies almost always are, while analytics
// and preference cookies (which survive a change of user) usually aren't.

// Bot-protection and load-balancer cookies rotate on their own schedule.
const INFRASTRUCTURE = /^(__cf_bm|cf_clearance|_cfuvid|__cflb|AWSALB|AWSALBCORS|AWSALBTG|AWSALBTGCORS|ak_bmsc|bm_sv|bm_sz|bm_mi|_abck|incap_ses_|visid_incap_|nlbi_|TS01)/i;

// Cookies that expire within a day are transient, not identity.
const MIN_LIFETIME_SECONDS = 24 * 3600;

export function cookieKey(cookie) {
  return [cookie.name, cookie.domain, cookie.path, cookie.partitionKey?.topLevelSite || ''].join('|');
}

const nameOf = (key) => key.split('|')[0];

/** Login-cookie candidates in a cookie list, as key -> value. */
function loginCookies(cookies, atMs) {
  const now = atMs / 1000;
  const out = new Map();
  for (const cookie of cookies) {
    if (!cookie.httpOnly || INFRASTRUCTURE.test(cookie.name)) continue;
    if (!cookie.session && cookie.expirationDate && cookie.expirationDate - now < MIN_LIFETIME_SECONDS) continue;
    out.set(cookieKey(cookie), cookie.value);
  }
  return out;
}

/**
 * Learning state to store with a new snapshot. For each login cookie:
 *   kept     how many cycles of use it survived with the same value
 *   rotates  the user confirmed it changes on its own, so it's ignored
 * `previous` is the account's last snapshot (null starts fresh); `rotating` lists
 * cookie keys to mark as rotating. `usedSince` says whether the previous snapshot
 * was restored and used before this save. Only then does an unchanged cookie
 * count: two saves seconds apart (save, then New account) prove nothing, and a
 * cookie that rotates on every page load would otherwise look stable.
 */
export function nextIdentity(previous, cookies, { rotating = [], usedSince = false } = {}) {
  const before = previous ? loginCookies(previous.cookies, previous.savedAt) : new Map();
  const state = previous?.identity || {};
  const out = {};
  for (const [key, value] of loginCookies(cookies, Date.now())) {
    const kept = state[key]?.kept || 0;
    out[key] = {
      kept: before.get(key) !== value ? 0 : usedSince ? kept + 1 : kept,
      rotates: Boolean(state[key]?.rotates) || rotating.includes(key),
    };
  }
  return out;
}

/**
 * Compares live cookies with an account's saved snapshot.
 * Returns { status: 'match' | 'mismatch' | 'unknown', basis, changed, names, signedOut }.
 *   basis 'stable'  some learned stable cookie changed (strong signal)
 *   basis 'all'     nothing learned yet, and no saved login cookie is unchanged
 */
export function compareIdentity(saved, liveCookies) {
  const before = loginCookies(saved.cookies || [], saved.savedAt || Date.now());
  if (!before.size) return { status: 'unknown' };
  const live = new Map(liveCookies.map((cookie) => [cookieKey(cookie), cookie.value]));
  const signedOut = ![...before.keys()].some((key) => live.has(key));
  const result = (basis, changed) => ({
    status: 'mismatch',
    basis,
    changed,
    names: [...new Set(changed.map(nameOf))],
    signedOut,
  });

  const state = saved.identity || {};
  const stable = [...before.keys()].filter((key) => state[key]?.kept >= 1 && !state[key]?.rotates);
  if (stable.length) {
    const changed = stable.filter((key) => live.get(key) !== before.get(key));
    return changed.length ? result('stable', changed) : { status: 'match' };
  }

  // Nothing learned yet: only call it a mismatch when no login cookie is unchanged.
  const unchanged = [...before.keys()].some((key) => live.get(key) === before.get(key));
  return unchanged ? { status: 'match' } : result('all', [...before.keys()]);
}

/** Whether a cookie list contains anything that looks like a login cookie. */
export function hasLoginCookies(cookies) {
  return loginCookies(cookies, Date.now()).size > 0;
}

/** True when every login cookie in `saved` is still there with the same value. */
export function loginCookiesUnchanged(saved, liveCookies) {
  const before = loginCookies(saved.cookies || [], saved.savedAt || Date.now());
  const live = new Map(liveCookies.map((cookie) => [cookieKey(cookie), cookie.value]));
  return before.size > 0 && [...before].every(([key, value]) => live.get(key) === value);
}
