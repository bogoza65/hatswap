// Local two-account test site for Hatswap. Zero dependencies: `node test-site/server.mjs`.
//
// Open http://app.hatswap.localhost:8787 (Chrome resolves *.localhost to this machine).
// It deliberately uses the session tricks real apps use, so a switch only "works" if
// all of them survive:
//   sid          host-only, HttpOnly, session cookie, ROTATED on every page load.
//                Like refresh-token rotation, a value stops working once its
//                successor has been used, so a stale saved copy really fails.
//   acct         Domain=hatswap.localhost (parent domain), HttpOnly, SameSite=Strict
//   __Host-csrf  Secure, host-only, path=/
//   chips        Secure, SameSite=None, Partitioned (CHIPS)
//   theme        readable by JS, parent domain, SameSite=Lax
//   shadow       same name on host and parent domain (tests cookie shadowing)
//   ts           long-lived HttpOnly token that only rotates on /?refresh=1, like a
//                periodic token refresh (tests the manual-login guard's learning)
// The dashboard also polls /api/poll constantly, and each slow response renews
// the session cookies it was sent with (a "rolling" session, like Buffer's busy
// app). A response that lands after a switch writes the old account back, unless
// the old page is stopped first.
//   localStorage hs_api_token (bearer token for /api/me) and workspace
//   sessionStorage tab_state
// admin.hatswap.localhost is a second origin that only sees the parent-domain cookie.

import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

const PORT = Number(process.env.PORT || 8787);
const USERS = JSON.parse(readFileSync(new URL('./accounts.json', import.meta.url), 'utf8'));
delete USERS._note;

const sessions = new Map(); // sid -> { user, previous }
const acctTokens = new Map(); // acct cookie -> user
const apiTokens = new Map(); // bearer token -> user
const token = () => randomBytes(12).toString('hex');

function parseCookies(header = '') {
  const out = [];
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out.push([part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim())]);
  }
  return out;
}

const DAY = 86400;
const tsCookie = () => `ts=${token()}; Path=/; Max-Age=${365 * DAY}; HttpOnly; SameSite=Lax`;
function loginCookies(user, sid, acct) {
  const u = USERS[user];
  return [
    `sid=${sid}; Path=/; HttpOnly; SameSite=Lax`,
    `acct=${acct}; Domain=hatswap.localhost; Path=/; Max-Age=${30 * DAY}; HttpOnly; SameSite=Strict`,
    `__Host-csrf=${token()}; Path=/; Secure; SameSite=Strict`,
    `chips=${user}; Path=/; Secure; SameSite=None; Partitioned; Max-Age=${7 * DAY}`,
    `theme=${u.theme}; Domain=hatswap.localhost; Path=/; Max-Age=${30 * DAY}; SameSite=Lax`,
    `shadow=host-${user}; Path=/; Max-Age=${DAY}`,
    `shadow=domain-${user}; Domain=hatswap.localhost; Path=/; Max-Age=${DAY}`,
    tsCookie(),
  ];
}

const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:15px system-ui;max-width:560px;margin:40px auto;padding:0 16px;color:#1b1d22}
dt{color:#6b7080;font-size:12px;margin-top:10px}dd{margin:2px 0 0;font-weight:600}
input,button{font:inherit;padding:8px 10px;margin:4px 0}.bad{color:#c0362c}.ok{color:#1d7a46}</style>
</head><body>${body}</body></html>`;

function loginPage(reason) {
  return page('Test site · Sign in', `<h1>Hatswap test site</h1>
<p id="state" class="bad">Signed out${reason ? ` (${reason})` : ''}</p>
<form method="post" action="/login">
  <input id="username" name="username" placeholder="Username" autocomplete="off"><br>
  <input id="password" name="password" type="password" placeholder="Password"><br>
  <button id="login">Sign in</button>
</form>`);
}

function dashboard(user, cookieNames) {
  return page(`Test site · ${user}`, `<h1>Hatswap test site</h1>
<p id="state" class="ok">Signed in</p>
<dl>
  <dt>Cookie session user (sid + acct, server-side)</dt><dd id="cookie-user">${user}</dd>
  <dt>API user (Bearer token from localStorage)</dt><dd id="api-user">…</dd>
  <dt>localStorage.workspace</dt><dd id="workspace"></dd>
  <dt>sessionStorage.tab_state</dt><dd id="tab-state"></dd>
  <dt>theme cookie (document.cookie)</dt><dd id="theme"></dd>
  <dt>Cookies the server received</dt><dd id="cookies-seen">${cookieNames.join(', ')}</dd>
</dl>
<form method="post" action="/logout"><button id="logout">Log out (kills the session server-side)</button></form>
<script>
  const get = (k) => localStorage.getItem(k);
  document.getElementById('workspace').textContent = get('workspace') || '(empty)';
  document.getElementById('tab-state').textContent = sessionStorage.getItem('tab_state') || '(empty)';
  document.getElementById('theme').textContent = (document.cookie.match(/(?:^|; )theme=([^;]*)/) || [])[1] || '(none)';
  fetch('/api/me', { headers: { Authorization: 'Bearer ' + (get('hs_api_token') || '') } })
    .then((r) => r.ok ? r.json() : { user: 'unauthorized' })
    .then((d) => { document.getElementById('api-user').textContent = d.user; });
  setInterval(() => fetch('/api/poll').catch(() => {}), 150);
</script>`);
}

function adminPage(user) {
  return page('Test admin', `<h1>Test admin (second origin)</h1>
<dl>
  <dt>Parent-domain cookie user</dt><dd id="admin-user">${user || 'signed out'}</dd>
  <dt>localStorage.admin_note (this origin only)</dt><dd id="admin-note"></dd>
</dl>
<script>
  ${user ? `if (!localStorage.getItem('admin_note')) localStorage.setItem('admin_note', ${JSON.stringify(user + "'s admin note")});` : ''}
  document.getElementById('admin-note').textContent = localStorage.getItem('admin_note') || '(empty)';
</script>`);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(new URLSearchParams(data)));
  });
}

const server = http.createServer(async (req, res) => {
  const host = (req.headers.host || '').split(':')[0];
  const url = new URL(req.url, `http://${req.headers.host}`);
  const cookies = parseCookies(req.headers.cookie);
  const cookie = (name) => cookies.find(([n]) => n === name)?.[1];
  const send = (status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    res.end(body);
  };

  if (host === 'admin.hatswap.localhost') return send(200, adminPage(acctTokens.get(cookie('acct'))));

  if (req.method === 'POST' && url.pathname === '/login') {
    const form = await readBody(req);
    const user = form.get('username');
    if (!USERS[user] || USERS[user].password !== form.get('password')) return send(401, loginPage('wrong username or password'));
    const sid = token();
    const acct = token();
    const api = token();
    sessions.set(sid, { user });
    acctTokens.set(acct, user);
    apiTokens.set(api, user);
    // The client-side half of the session lives in Web Storage, like most SPAs.
    return send(200, page('Signing in…', `<script>
      localStorage.setItem('hs_api_token', ${JSON.stringify(api)});
      localStorage.setItem('workspace', ${JSON.stringify(USERS[user].workspace)});
      sessionStorage.setItem('tab_state', ${JSON.stringify(user + '-tab')});
      location.replace('/');
    </script>`), { 'Set-Cookie': loginCookies(user, sid, acct) });
  }

  if (req.method === 'POST' && url.pathname === '/logout') {
    sessions.delete(cookie('sid'));
    acctTokens.delete(cookie('acct'));
    return send(303, '', {
      Location: '/',
      'Set-Cookie': ['sid=; Path=/; Max-Age=0', 'acct=; Domain=hatswap.localhost; Path=/; Max-Age=0'],
    });
  }

  if (req.method === 'POST' && url.pathname === '/__expire') {
    // Test hook: end all of a user's sessions on the server, like an expired login.
    const user = url.searchParams.get('user');
    for (const [key, value] of sessions) if (value.user === user) sessions.delete(key);
    for (const [key, value] of acctTokens) if (value === user) acctTokens.delete(key);
    res.writeHead(204);
    return res.end();
  }

  if (req.method === 'GET' && url.pathname === '/login') return send(200, loginPage(url.searchParams.get('reason')));

  if (url.pathname === '/api/poll') {
    await new Promise((resolve) => setTimeout(resolve, 400));
    const renew = [];
    if (sessions.has(cookie('sid'))) renew.push(`sid=${cookie('sid')}; Path=/; HttpOnly; SameSite=Lax`);
    if (acctTokens.has(cookie('acct'))) renew.push(`acct=${cookie('acct')}; Domain=hatswap.localhost; Path=/; Max-Age=${30 * DAY}; HttpOnly; SameSite=Strict`);
    res.writeHead(204, renew.length ? { 'Set-Cookie': renew } : {});
    return res.end();
  }

  if (url.pathname === '/api/me') {
    const bearer = (req.headers.authorization || '').replace(/^Bearer /, '');
    const user = apiTokens.get(bearer);
    res.writeHead(user ? 200 : 401, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ user: user || null }));
  }

  if (url.pathname === '/') {
    const sid = cookie('sid');
    const sidUser = sessions.get(sid)?.user;
    const acctUser = acctTokens.get(cookie('acct'));
    // Like most apps, an invalid session redirects to the login page.
    const toLogin = (reason) => send(302, '', { Location: reason ? `/login?reason=${encodeURIComponent(reason)}` : '/login' });
    if (!sid && !acctUser) return toLogin();
    if (!sidUser) return toLogin('session cookie expired or was rotated away');
    if (sidUser !== acctUser) return toLogin('session and account cookies belong to different users');
    // Rotate: using this sid retires the one before it; this one stays valid
    // until its own successor is used.
    sessions.delete(sessions.get(sid).previous);
    const fresh = token();
    sessions.set(fresh, { user: sidUser, previous: sid });
    const names = cookies.map(([n]) => n);
    const setCookies = [`sid=${fresh}; Path=/; HttpOnly; SameSite=Lax`];
    if (url.searchParams.has('refresh')) setCookies.push(tsCookie());
    return send(200, dashboard(sidUser, names), { 'Set-Cookie': setCookies });
  }

  send(404, page('Not found', '<p>Not found</p>'));
});

server.listen(PORT, () => {
  console.log(`Hatswap test site: http://app.hatswap.localhost:${PORT}  (second origin: http://admin.hatswap.localhost:${PORT})`);
});
