// localStorage / sessionStorage snapshot and restore, done by injecting small
// functions into the site's open tabs with chrome.scripting.

// --- Injected functions. These run inside the page, so they must not reference
// --- anything outside their own body.

function readPageStorage() {
  const dump = (store) => {
    const entries = [];
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      entries.push([key, store.getItem(key)]);
    }
    return entries;
  };
  const out = { origin: location.origin, local: null, session: null };
  try { out.local = dump(localStorage); } catch { /* storage blocked for this page */ }
  try { out.session = dump(sessionStorage); } catch { /* storage blocked for this page */ }
  return out;
}

// Runs in the page's MAIN world. Besides writing the new account's storage it
// silences the outgoing page: Storage writes, document.cookie and new network
// requests become no-ops, so the old app can't write its state back. With
// `leave`, the page then unloads to a same-origin about:blank, which also
// cancels requests the old account still has in flight. (A response landing
// after the cookie swap would otherwise set the old session cookie again.)
function writePageStorage(snapshot, freeze, leave) {
  const proto = Storage.prototype;
  const { clear, setItem } = proto;
  const result = { origin: location.origin, errors: [] };
  const replace = (name, entries) => {
    try {
      const store = window[name];
      clear.call(store);
      for (const [key, value] of entries || []) setItem.call(store, key, value);
    } catch (error) {
      result.errors.push(`${name}: ${error.message || error}`);
    }
  };
  replace('localStorage', snapshot?.local);
  replace('sessionStorage', snapshot?.session);
  if (freeze) {
    const ignore = function () {};
    proto.setItem = ignore;
    proto.removeItem = ignore;
    proto.clear = ignore;
    try {
      Object.defineProperty(document, 'cookie', { configurable: true, get: () => '', set: ignore });
    } catch { /* not fatal */ }
    window.fetch = () => new Promise(() => {});
    XMLHttpRequest.prototype.send = ignore;
    if (navigator.sendBeacon) navigator.sendBeacon = () => true;
  }
  if (leave) {
    // Switching is the user's explicit choice; a "Leave site?" prompt would stall it.
    window.onbeforeunload = null;
    window.addEventListener('beforeunload', (event) => event.stopImmediatePropagation(), true);
    location.replace('about:blank');
  }
  return result;
}

// --- Extension side

function originOf(tab) {
  try {
    return new URL(tab.url).origin;
  } catch {
    return null;
  }
}

function describeError(error) {
  const message = error?.message || String(error);
  if (/cannot access|cannot be scripted|extensions gallery/i.test(message)) return 'Chrome blocks extensions on this page';
  if (/no tab with id|frame with id|tab was closed/i.test(message)) return 'the tab closed';
  return message;
}

/**
 * Reads Web Storage from each tab. Tabs are expected primary-first: when several
 * tabs share an origin, the first one's sessionStorage is kept.
 * Returns { storage: { [origin]: { local, session } }, failures: [string] }.
 */
export async function captureTabs(tabs) {
  const storage = {};
  const failures = [];
  for (const tab of tabs) {
    const origin = originOf(tab);
    if (!origin || storage[origin]) continue;
    try {
      const [frame] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: readPageStorage });
      const data = frame?.result;
      if (data && (data.local || data.session)) storage[data.origin] = { local: data.local || [], session: data.session || [] };
    } catch (error) {
      failures.push(`${origin}: ${describeError(error)}`);
    }
  }
  return { storage, failures };
}

/**
 * Replaces Web Storage in each tab with the snapshot for its origin. Origins
 * missing from `storage` are cleared, so the next account starts clean. With
 * `leave`, each page is unloaded afterwards (see writePageStorage).
 * Returns { failures: [string], unreached: [tabId] }.
 */
export async function restoreTabs(tabs, storage = {}, { freeze = true, leave = false } = {}) {
  const failures = [];
  const unreached = [];
  await Promise.all(
    tabs.map(async (tab) => {
      const origin = originOf(tab);
      if (!origin) return;
      try {
        const [frame] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          world: 'MAIN',
          func: writePageStorage,
          args: [storage[origin] || null, freeze, leave],
        });
        for (const error of frame?.result?.errors || []) failures.push(`${origin}: ${error}`);
      } catch (error) {
        failures.push(`${origin}: ${describeError(error)}`);
        unreached.push(tab.id);
      }
    }),
  );
  return { failures, unreached };
}
