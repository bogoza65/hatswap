// Works out which "site" a tab belongs to.
//
// Accounts are scoped to the registrable domain (eTLD+1), e.g. "buffer.com" for
// publish.buffer.com and login.buffer.com, because login cookies are usually set
// on the parent domain and shared by every subdomain.

// Multi-label public suffixes. This is not the full Public Suffix List, only the
// ones people realistically hit, so "shop.co.uk" doesn't collapse to "co.uk".
const MULTI_LABEL_SUFFIXES = new Set([
  // Country second-level domains
  'co.uk', 'org.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'ac.uk', 'gov.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au',
  'co.nz', 'net.nz', 'org.nz',
  'co.jp', 'ne.jp', 'or.jp', 'co.kr', 'co.in', 'net.in', 'org.in',
  'com.br', 'net.br', 'org.br', 'com.mx', 'com.ar', 'com.tr', 'com.cn',
  'com.hk', 'com.sg', 'com.tw', 'com.my', 'com.ph', 'co.id', 'co.il',
  'co.za', 'com.ua', 'com.pl', 'co.at', 'or.at',
  // Hosting platforms where every subdomain belongs to someone else
  'github.io', 'gitlab.io', 'vercel.app', 'netlify.app', 'pages.dev',
  'workers.dev', 'web.app', 'firebaseapp.com', 'herokuapp.com',
  'myshopify.com', 'azurewebsites.net', 'cloudfront.net', 'appspot.com',
  'blogspot.com', 'onrender.com', 'fly.dev', 'glitch.me', 'webflow.io',
]);

// Hosts where Chrome refuses to let extensions run scripts.
const BLOCKED_HOSTS = new Set(['chromewebstore.google.com']);

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** True for IPv4 literals and bracket-less IPv6 literals. */
function isIpAddress(host) {
  return IPV4.test(host) || host.includes(':');
}

/** "publish.buffer.com" -> "buffer.com", "shop.example.co.uk" -> "example.co.uk". */
export function registrableDomain(host) {
  host = host.toLowerCase().replace(/\.$/, '');
  if (isIpAddress(host)) return host;
  const labels = host.split('.');
  if (labels.length <= 2) return host;
  const lastTwo = labels.slice(-2).join('.');
  return MULTI_LABEL_SUFFIXES.has(lastTwo) ? labels.slice(-3).join('.') : lastTwo;
}

/** Host permission pattern that covers the site and all its subdomains. */
export function hostPattern(site) {
  if (isIpAddress(site) || !site.includes('.')) {
    return `*://${site.includes(':') ? `[${site}]` : site}/*`;
  }
  return `*://*.${site}/*`;
}

/**
 * Describes a tab URL: whether Hatswap can work there and, if so, its site.
 * `reason` is a user-facing sentence for unsupported pages.
 */
export function describeUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { supported: false, reason: 'Open a website in this tab to manage its accounts.' };
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    const scheme = parsed.protocol.replace(':', '');
    const reason = ['chrome', 'edge', 'about', 'chrome-extension', 'devtools', 'view-source'].includes(scheme)
      ? `Chrome doesn't let extensions work on ${scheme}:// pages. Open a regular website instead.`
      : `Hatswap only works on http:// and https:// websites, not ${scheme}:// pages.`;
    return { supported: false, reason };
  }

  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (BLOCKED_HOSTS.has(host) || (host === 'chrome.google.com' && parsed.pathname.startsWith('/webstore'))) {
    return { supported: false, reason: "Chrome doesn't let extensions work on the Chrome Web Store." };
  }

  const site = registrableDomain(host);
  return {
    supported: true,
    site,
    host,
    origin: parsed.origin,
    scheme: parsed.protocol.replace(':', ''),
    pattern: hostPattern(site),
  };
}
