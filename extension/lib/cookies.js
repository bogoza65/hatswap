// Cookie snapshot and restore for one site (registrable domain + subdomains).
//
// chrome.cookies sees httpOnly cookies too, which page JavaScript can't, so this is
// where the actual login session gets copied.

/** The cookie store a tab lives in ("0" for regular windows, another id for incognito). */
export async function cookieStoreForTab(tabId) {
  const stores = await chrome.cookies.getAllCookieStores();
  return stores.find((store) => store.tabIds.includes(tabId))?.id;
}

/** Every cookie for `site` and its subdomains, partitioned (CHIPS) cookies included. */
export async function readSiteCookies(site, storeId) {
  try {
    // An empty partitionKey returns cookies from all partitions, not just unpartitioned ones.
    return await chrome.cookies.getAll({ domain: site, storeId, partitionKey: {} });
  } catch {
    // Chrome versions without partitionKey support.
    return chrome.cookies.getAll({ domain: site, storeId });
  }
}

/** Keeps only the fields needed to recreate the cookie later. */
export function serializeCookie(cookie) {
  const out = {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    hostOnly: cookie.hostOnly,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite,
    session: cookie.session,
  };
  if (!cookie.session && cookie.expirationDate) out.expirationDate = cookie.expirationDate;
  if (cookie.partitionKey) out.partitionKey = cookie.partitionKey;
  return out;
}

/**
 * URL that chrome.cookies.set/remove use to locate a cookie. Secure cookies need an
 * https URL; others use the scheme of the tab so plain-http dev sites work too.
 */
function cookieUrl(cookie, scheme) {
  let host = cookie.domain.startsWith('.') ? cookie.domain.slice(1) : cookie.domain;
  if (host.includes(':')) host = `[${host}]`;
  let protocol = cookie.secure ? 'https' : scheme;
  // A first-party partitioned cookie must be set from a URL that is same-site
  // (scheme included) with its partition's top-level site.
  const topLevelSite = cookie.partitionKey?.topLevelSite;
  if (topLevelSite && cookie.partitionKey.hasCrossSiteAncestor !== true) {
    protocol = topLevelSite.split(':')[0] || protocol;
  }
  return `${protocol}://${host}${cookie.path || '/'}`;
}

function removeCookie(cookie, storeId, scheme) {
  const details = { url: cookieUrl(cookie, scheme), name: cookie.name, storeId };
  if (cookie.partitionKey) details.partitionKey = cookie.partitionKey;
  return chrome.cookies.remove(details);
}

/**
 * Deletes every cookie for the site. chrome.cookies.remove deletes one cookie per
 * call, and cookies that share a name (different path or host-only vs. domain)
 * can shadow each other, so this repeats until nothing is left or nothing changes.
 */
export async function clearSiteCookies(site, storeId, scheme) {
  let remaining = await readSiteCookies(site, storeId);
  const initial = remaining.length;
  for (let pass = 0; pass < 4 && remaining.length; pass++) {
    await Promise.allSettled(remaining.map((cookie) => removeCookie(cookie, storeId, scheme)));
    const next = await readSiteCookies(site, storeId);
    if (next.length >= remaining.length) {
      remaining = next;
      break;
    }
    remaining = next;
  }
  return { removed: initial - remaining.length, remaining: remaining.map((c) => `${c.name} (${c.domain})`) };
}

function setDetails(cookie, storeId, scheme) {
  const details = {
    url: cookieUrl(cookie, scheme),
    name: cookie.name,
    value: cookie.value,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite,
    storeId,
  };
  // Host-only cookies must be set without `domain`, otherwise Chrome turns them
  // into domain cookies (and __Host- cookies are rejected outright).
  if (!cookie.hostOnly) details.domain = cookie.domain;
  // Leaving out expirationDate recreates a session cookie.
  if (!cookie.session && cookie.expirationDate) details.expirationDate = cookie.expirationDate;
  if (cookie.partitionKey) details.partitionKey = cookie.partitionKey;
  return details;
}

/** Recreates saved cookies. Expired ones are skipped; failures are reported, not thrown. */
export async function restoreSiteCookies(cookies, storeId, scheme) {
  const now = Date.now() / 1000;
  const live = cookies.filter((c) => c.session || !c.expirationDate || c.expirationDate > now);
  const results = await Promise.allSettled(
    live.map(async (cookie) => {
      const result = await chrome.cookies.set(setDetails(cookie, storeId, scheme));
      if (!result) throw new Error(chrome.runtime.lastError?.message || 'Chrome rejected the cookie');
    }),
  );
  const failed = [];
  results.forEach((result, i) => {
    if (result.status === 'rejected') {
      failed.push({ name: live[i].name, domain: live[i].domain, error: result.reason?.message || String(result.reason) });
    }
  });
  return { restored: live.length - failed.length, expired: cookies.length - live.length, failed };
}
