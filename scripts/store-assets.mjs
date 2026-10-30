// Generates the Chrome Web Store listing images into store/:
//   5 screenshots (1280×800), small promo tile (440×280), marquee (1400×560),
//   and a store icon with the padding Google recommends (128×128, 96 px art).
//
// The popup is the real extension UI rendered in Chromium with a stubbed state
// (example client accounts on buffer.com), so the images stay true to the product
// and can be regenerated after any UI change:
//
//   PLAYWRIGHT=/path/to/node_modules/playwright node scripts/store-assets.mjs

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(ROOT, 'extension');
const OUT = path.join(ROOT, 'store');
const { chromium } = await import(process.env.PLAYWRIGHT ? path.join(process.env.PLAYWRIGHT, 'index.mjs') : 'playwright');
mkdirSync(OUT, { recursive: true });

const FONT = readFileSync(path.join(EXT, 'fonts/outfit.woff2')).toString('base64');
const ICON = readFileSync(path.join(EXT, 'icons/icon128.png')).toString('base64');
const now = Date.now();
const HOUR = 3600_000;

// Example accounts (fictional stores): an agency running clients' Shopify admins.
const ACCOUNTS = [
  { id: 'a1', name: 'Fjord & Pine', group: 'Fjord & Pine', color: '#2F9E64', site: 'shopify.com', updatedAt: now - 2 * HOUR, lastUsedAt: now - 2 * HOUR },
  { id: 'a2', name: 'Nordlys Candles', group: 'Nordlys', color: '#EF6A1F', site: 'shopify.com', updatedAt: now - 5 * 60_000, lastUsedAt: now - 5 * 60_000 },
  { id: 'a3', name: 'Nordlys Wholesale', group: 'Nordlys', color: '#6E56CF', site: 'shopify.com', updatedAt: now - 26 * HOUR, lastUsedAt: now - 26 * HOUR },
  { id: 'a4', name: 'Salt Supply Co.', group: 'Salt Supply', color: '#1F7AE0', site: 'shopify.com', updatedAt: now - 3 * 24 * HOUR, lastUsedAt: now - 3 * 24 * HOUR },
];

function state(overrides = {}) {
  return {
    status: 'unlocked',
    settings: { autoLockMinutes: 15, autoSave: true, afterSwitch: 'lastPage' },
    version: '1.6.0',
    shortcuts: { 'switch-next': '⌥⇧H', 'switch-previous': '', _execute_action: '' },
    tab: { supported: true, site: 'shopify.com', pattern: '*://*.shopify.com/*' },
    hasAccess: true,
    groups: ['Fjord & Pine', 'Nordlys', 'Salt Supply'],
    sites: [{ site: 'shopify.com', count: 4 }, { site: 'buffer.com', count: 3 }, { site: 'facebook.com', count: 2 }],
    bytesInUse: 184_000,
    accounts: ACCOUNTS,
    activeId: 'a2',
    sessionCheck: { status: 'match', names: [], signedOut: false },
    ...overrides,
  };
}

// --- 1. Capture the popup (and the backup page) with a stubbed service worker.

const ctx = await chromium.launchPersistentContext(mkdtempSync(path.join(tmpdir(), 'hatswap-store-')), {
  channel: 'chromium',
  headless: true,
  colorScheme: 'dark',
  deviceScaleFactor: 2,
  viewport: { width: 360, height: 500 },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker'));
const extensionId = sw.url().split('/')[2];

async function capture(url, stubbedState, { viewport, setup, settle = 800 } = {}) {
  const page = await ctx.newPage();
  if (viewport) await page.setViewportSize(viewport);
  await page.addInitScript((s) => { chrome.runtime.sendMessage = async () => s; }, stubbedState);
  await page.goto(`chrome-extension://${extensionId}/${url}`);
  await page.waitForFunction(() => document.fonts.status === 'loaded');
  await page.waitForTimeout(300);
  if (setup) await setup(page);
  await page.waitForTimeout(settle);
  const png = await page.screenshot({ type: 'png' });
  await page.close();
  return png.toString('base64');
}

const shots = {
  list: await capture('popup.html?tabId=1', state()),
  save: await capture('popup.html?tabId=1', state(), {
    setup: async (page) => {
      await page.getByRole('button', { name: 'Save as New Account' }).click();
      await page.fill('[name=name]', 'Harbor Bikes');
      await page.fill('[name=group]', 'Harbor');
      await page.click('input[aria-label=Red]');
    },
    settle: 1000,
  }),
  guard: await capture('popup.html?tabId=1', state({ sessionCheck: { status: 'mismatch', names: ['session'], signedOut: false } }), {
    setup: (page) => page.click('#drift button'),
    settle: 1000,
  }),
  settings: await capture('popup.html?tabId=1', state(), { setup: (page) => page.click('#settings'), settle: 900 }),
  backup: await capture('backup.html', state(), { viewport: { width: 560, height: 500 }, settle: 400 }),
};
await ctx.close();

// --- 2. Compose the listing images in a plain browser at 1:1 pixels.

const browser = await chromium.launch({ channel: 'chromium' });

const BASE_CSS = `
  @font-face { font-family: Outfit; src: url(data:font/woff2;base64,${FONT}) format("woff2-variations"); font-weight: 100 900; }
  * { box-sizing: border-box; }
  html, body { margin: 0; }
  body { position: relative; overflow: hidden; background: #0d0d10; color: #f4f3f6; font-family: Outfit, sans-serif; -webkit-font-smoothing: antialiased; }
  .blob { position: absolute; border-radius: 50%; filter: blur(90px); opacity: 0.55; }
  .title { font-weight: 700; letter-spacing: -0.03em; line-height: 1.05; }
  .sub { color: rgb(244 243 246 / 0.64); line-height: 1.4; }
  .shot { position: absolute; border-radius: 26px; box-shadow: 0 0 0 1px rgb(255 255 255 / 0.1), 0 50px 100px -30px rgb(0 0 0 / 0.9); }
  .brand { display: flex; align-items: center; gap: 12px; font-weight: 650; letter-spacing: 0.005em; }
  .brand img { border-radius: 22%; }
`;

const blobs = (a, b) => `
  <span class="blob" style="width:720px;height:720px;top:-330px;left:-260px;background:${a}"></span>
  <span class="blob" style="width:620px;height:620px;bottom:-320px;right:-240px;background:${b};opacity:0.4"></span>`;

async function compose(file, { width, height, html, transparent = false }) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  await page.setContent(`<!doctype html><html><head><style>${BASE_CSS}</style></head><body>${html}</body></html>`);
  await page.waitForFunction(() => document.fonts.status === 'loaded');
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(OUT, file), type: 'png', omitBackground: transparent });
  await page.close();
  console.log(`wrote store/${file}`);
}

/** 1280×800: caption on the left, the popup on the right. */
function screenshot(file, { title, sub, shot, colors, shotWidth = 504, shotHeight = 700 }) {
  return compose(file, {
    width: 1280,
    height: 800,
    html: `
      ${blobs(...colors)}
      <div style="position:absolute;left:84px;top:84px;width:560px">
        <div class="brand" style="font-size:22px"><img src="data:image/png;base64,${ICON}" width="36" height="36" alt="">Hatswap</div>
        <div class="title" style="font-size:54px;margin-top:150px">${title}</div>
        <div class="sub" style="font-size:22px;margin-top:22px;max-width:500px">${sub}</div>
      </div>
      <img class="shot" src="data:image/png;base64,${shot}" style="right:84px;top:${(800 - shotHeight) / 2}px;width:${shotWidth}px;height:${shotHeight}px" alt="">`,
  });
}

await screenshot('screenshot-1-switch.png', {
  title: 'Switch accounts without logging out.',
  sub: 'One click, same tab. Every client’s login a click apart, with a badge that shows who you are.',
  shot: shots.list,
  colors: ['#EF6A1F', '#2F9E64'],
});
await screenshot('screenshot-2-save.png', {
  title: 'Name it. Colour it. Group it by client.',
  sub: 'Save the login you’re in, then switch back to it any time. Search when the list gets long.',
  shot: shots.save,
  colors: ['#E5484D', '#6E56CF'],
});
await screenshot('screenshot-3-guard.png', {
  title: 'It asks before saving over the wrong account.',
  sub: 'Signed in to someone else by hand? Hatswap notices the login changed and checks with you first.',
  shot: shots.guard,
  colors: ['#f5a623', '#EF6A1F'],
});
await screenshot('screenshot-4-security.png', {
  title: 'Encrypted. Local only. Locks itself.',
  sub: 'AES-256 with your master password. No account, no server, no telemetry, and the source is public.',
  shot: shots.settings,
  colors: ['#1F7AE0', '#2F9E64'],
});
await screenshot('screenshot-5-backup.png', {
  title: 'A backup you can keep anywhere.',
  sub: 'One encrypted file with every login and your settings. Restore it on any computer with the password.',
  shot: shots.backup,
  colors: ['#2F9E64', '#ff5a3c'],
  shotWidth: 560,
  shotHeight: 500,
});

/** 440×280 small promo tile. */
await compose('promo-small-440x280.png', {
  width: 440,
  height: 280,
  html: `
    <span class="blob" style="width:360px;height:360px;top:-180px;left:-120px;background:#ff5a3c;filter:blur(60px)"></span>
    <span class="blob" style="width:300px;height:300px;bottom:-170px;right:-120px;background:#6E56CF;filter:blur(60px);opacity:0.4"></span>
    <div style="position:absolute;left:36px;top:52px">
      <img src="data:image/png;base64,${ICON}" width="72" height="72" style="border-radius:17px;box-shadow:0 14px 30px rgb(0 0 0 / 0.5)" alt="">
      <div class="title" style="font-size:40px;margin-top:22px">Hatswap</div>
      <div class="sub" style="font-size:18px;margin-top:6px;color:#f4f3f6">Switch accounts without logging out.</div>
    </div>`,
});

/** 1400×560 marquee. */
await compose('promo-marquee-1400x560.png', {
  width: 1400,
  height: 560,
  html: `
    ${blobs('#ff5a3c', '#2F9E64')}
    <div style="position:absolute;left:90px;top:112px;width:620px">
      <div class="brand" style="font-size:26px"><img src="data:image/png;base64,${ICON}" width="44" height="44" alt="">Hatswap</div>
      <div class="title" style="font-size:58px;margin-top:58px">Switch accounts without logging out.</div>
      <div class="sub" style="font-size:22px;margin-top:20px;max-width:540px">For people who manage several clients on Buffer, Meta Business Suite, Shopify and Google. Encrypted, local only, open source.</div>
    </div>
    <img class="shot" src="data:image/png;base64,${shots.list}" style="right:90px;top:40px;width:346px;height:480px" alt="">`,
});

/** 128×128 store icon: 96 px of art with 16 px transparent padding, as Google suggests. */
await compose('icon-128-store.png', {
  width: 128,
  height: 128,
  transparent: true,
  html: `<img src="data:image/png;base64,${ICON}" width="96" height="96" style="position:absolute;left:16px;top:16px;border-radius:22px" alt="">`,
});

await browser.close();
