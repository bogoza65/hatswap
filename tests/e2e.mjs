// End-to-end test: loads the extension into Playwright's Chromium, drives the real
// popup UI against the local two-account test site, and checks every layer of the
// session after each switch.
//
//   PLAYWRIGHT=/path/to/node_modules/playwright node tests/e2e.mjs [--out dir] [--headed]
//
// The test copy of the extension gets `host_permissions` for *.hatswap.localhost so
// chrome.permissions.request resolves without Chrome's native dialog (which
// automation can't click). Everything else is the shipped code.

import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const args = process.argv.slice(2);
const OUT = args.includes('--out') ? path.resolve(args[args.indexOf('--out') + 1]) : mkdtempSync(path.join(tmpdir(), 'hatswap-e2e-'));
const HEADED = args.includes('--headed');
const { chromium } = await import(process.env.PLAYWRIGHT ? path.join(process.env.PLAYWRIGHT, 'index.mjs') : 'playwright');

const APP = 'http://app.hatswap.localhost:8787/';
const ADMIN = 'http://admin.hatswap.localhost:8787/';
const MASTER = 'correct-horse-battery';
const NEW_MASTER = 'staple-hat-swap-2026';

// --- tiny test harness ------------------------------------------------------
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? '  ok ' : 'FAIL '} ${name}${detail ? `  (${detail})` : ''}`);
}

// --- setup --------------------------------------------------------------------
mkdirSync(OUT, { recursive: true });
const EXT = path.join(OUT, 'extension');
rmSync(EXT, { recursive: true, force: true });
cpSync(path.join(ROOT, 'extension'), EXT, { recursive: true });
const manifest = JSON.parse(readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
manifest.host_permissions = ['*://*.hatswap.localhost/*'];
writeFileSync(path.join(EXT, 'manifest.json'), JSON.stringify(manifest, null, 2));

const server = spawn(process.execPath, [path.join(ROOT, 'test-site/server.mjs')], { stdio: 'ignore' });
await new Promise((resolve) => setTimeout(resolve, 400));

const context = await chromium.launchPersistentContext(mkdtempSync(path.join(OUT, 'profile-')), {
  channel: 'chromium',
  headless: !HEADED,
  viewport: { width: 1000, height: 760 },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});

const consoleErrors = [];
context.on('page', (page) => page.on('pageerror', (e) => consoleErrors.push(`${page.url()}: ${e.message}`)));
try {
  const sw = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
  const extensionId = sw.url().split('/')[2];

  const app = await context.newPage();
  await app.goto(APP);
  const admin = await context.newPage();
  await admin.goto(ADMIN);
  const tabIdOf = (url) => sw.evaluate(async (pattern) => (await chrome.tabs.query({ url: pattern }))[0]?.id, url);
  const appTab = await tabIdOf('*://app.hatswap.localhost/*');

  const popup = await context.newPage();
  await popup.setViewportSize({ width: 360, height: 500 }); // the popup's real size
  const openPopup = async (tab = appTab) => {
    await popup.goto(`chrome-extension://${extensionId}/popup.html?tabId=${tab}`);
    await popup.waitForSelector('#view > *');
  };
  const shot = async (name) => {
    await popup.waitForTimeout(500); // let screen transitions finish
    await popup.locator('body').screenshot({ path: path.join(OUT, `${name}.png`) });
  };
  const toastText = async () => (await popup.locator('#toast').textContent()).trim();

  const signIn = async (user) => {
    await app.fill('#username', user);
    await app.fill('#password', `${user}-test-pass`);
    await Promise.all([app.waitForURL(APP), app.click('#login')]);
    await app.waitForSelector('#cookie-user');
  };
  // A switch parks each page on about:blank first, so wait for the real page's load.
  const nextLoad = (page) => page.waitForEvent('load', { predicate: () => page.url().startsWith('http') });
  /** Waits for the next load of the app and admin tabs after `action`. */
  const afterReload = async (action) => {
    const loads = Promise.all([nextLoad(app), nextLoad(admin)]);
    loads.catch(() => {}); // a failure is reported by the await below, not as an unhandled rejection
    await action();
    await loads;
    await app.waitForFunction(() => !document.querySelector('#api-user') || document.querySelector('#api-user').textContent !== '…');
  };
  const readApp = async () => app.evaluate(() => {
    const text = (id) => document.getElementById(id)?.textContent ?? null;
    return { state: text('state'), cookie: text('cookie-user'), api: text('api-user'), workspace: text('workspace'), tab: text('tab-state'), theme: text('theme'), seen: text('cookies-seen'), url: location.href };
  });
  const readAdmin = async () => admin.evaluate(() => ({ user: document.getElementById('admin-user').textContent, note: document.getElementById('admin-note').textContent }));
  const badge = () => sw.evaluate(async (tabId) => ({ text: await chrome.action.getBadgeText({ tabId }), color: await chrome.action.getBadgeBackgroundColor({ tabId }), title: await chrome.action.getTitle({ tabId }) }), appTab);
  const expectUser = async (user, label) => {
    const a = await readApp();
    const ad = await readAdmin();
    const u = JSON.parse(readFileSync(path.join(ROOT, 'test-site/accounts.json'), 'utf8'))[user];
    u.ws = u.workspace;
    check(`${label}: server session (httpOnly sid + parent-domain acct) is ${user}`, a.cookie === user, a.state);
    check(`${label}: bearer token from localStorage is ${user}`, a.api === user, a.api);
    check(`${label}: localStorage.workspace restored`, a.workspace === u.ws, a.workspace);
    check(`${label}: sessionStorage restored`, a.tab === `${user}-tab`, a.tab);
    check(`${label}: JS-readable parent-domain cookie restored`, a.theme === u.theme, a.theme);
    check(`${label}: all 8 cookies arrive (incl. __Host-, Secure, CHIPS, shadowed)`, a.seen?.split(', ').length === 8, a.seen);
    check(`${label}: second origin (admin.) sees ${user} + its own storage`, ad.user === user && ad.note === `${user}'s admin note`, `${ad.user} / ${ad.note}`);
    return a;
  };

  // 1. First run
  await openPopup();
  check('first run shows setup with the storage warning', await popup.locator('.features').isVisible());
  await shot('01-setup');
  await popup.getByRole('button', { name: 'Continue' }).click();
  await popup.fill('[name=password]', MASTER);
  await popup.fill('[name=confirm]', MASTER);
  await shot('01b-setup-password');
  await popup.click('button[type=submit]');
  await popup.waitForSelector('.empty');
  check('vault created, empty state shown', (await popup.textContent('.empty')).includes('hatswap.localhost'));
  await shot('02-empty');

  // 2. Save Alice
  await signIn('alice');
  await admin.reload();
  await popup.getByRole('button', { name: 'Save as new account' }).click();
  await popup.fill('[name=name]', 'Alice');
  await popup.fill('[name=group]', 'Kinn');
  await popup.check('input[aria-label=Green]');
  await shot('03-save-form');
  await popup.click('button[type=submit]');
  await popup.waitForSelector('.account');
  check('Alice saved and marked active', await popup.locator('.account.is-active').textContent().then((t) => t.includes('Alice')), await toastText());
  const b1 = await badge();
  check('badge shows active account initials + colour', b1.text === 'AL' && b1.color.join() === '47,158,100,255', JSON.stringify(b1));

  // 3. Encryption at rest
  const dump = await sw.evaluate(async () => JSON.stringify(await chrome.storage.local.get(null)));
  const alice = await readApp();
  const token = await app.evaluate(() => localStorage.getItem('hs_api_token'));
  check('storage.local holds no plaintext session data', !dump.includes(token) && !dump.includes('alice-tab') && !dump.includes('"sid"'), `${dump.length} bytes`);
  check('key lives only in storage.session', await sw.evaluate(async () => Boolean((await chrome.storage.session.get('unlocked')).unlocked?.key)));

  // 4. New account -> sign in as Bob -> save
  await openPopup();
  await afterReload(() => popup.getByRole('button', { name: 'New Account', exact: true }).click());
  const cleared = await readApp();
  check('New account signs the site out locally', cleared.state.startsWith('Signed out'), cleared.state);
  check('New account clears the other origin too', (await readAdmin()).note === '(empty)');
  check('badge cleared after New account', (await badge()).text === '');
  await signIn('bob');
  await admin.reload();
  await openPopup();
  await popup.getByRole('button', { name: 'Save as new account' }).click();
  await popup.fill('[name=name]', 'Bob');
  await popup.fill('[name=group]', 'NordWeb');
  await popup.click('button[type=submit]');
  await popup.waitForSelector('.account-main:has-text("Bob")');
  await shot('04-list');

  // 5. Rotate Bob's token and move Alice to a deeper page before switching.
  for (let i = 0; i < 3; i++) await app.reload();

  // 6. Switch Bob -> Alice -> Bob through the popup
  const switchTo = async (name) => {
    await openPopup();
    await afterReload(() => popup.click(`.account-main:has-text("${name}")`));
    await popup.waitForSelector('.account.is-active');
    return toastText();
  };
  let toast = await switchTo('Alice');
  await expectUser('alice', 'switch to Alice');
  check('switch reported no warnings', !toast.includes('warning'), toast);
  await app.goto(`${APP}?view=alice-reports`);
  toast = await switchTo('Bob');
  await expectUser('bob', 'switch to Bob (after 3 token rotations)');
  const b2 = await badge();
  check('badge follows the switch', b2.text === 'BO' && b2.title.includes('Bob'), JSON.stringify(b2));
  await switchTo('Alice');
  const back = await expectUser('alice', 'switch back to Alice');
  check("tab returns to Alice's last page", back.url.endsWith('?view=alice-reports'), back.url);

  // 7. Keyboard shortcut (same code path as chrome.commands)
  const command = async (name) => {
    const loads = Promise.all([nextLoad(app), nextLoad(admin)]);
    loads.catch(() => {});
    await sw.evaluate(async ([cmd, tabId]) => globalThis.hatswap.runCommand(cmd, await chrome.tabs.get(tabId)), [name, appTab]);
    await loads;
    await app.waitForFunction(() => document.querySelector('#api-user')?.textContent !== '…');
  };
  await command('switch-next');
  await expectUser('bob', 'shortcut: next account');
  await command('switch-previous');
  await expectUser('alice', 'shortcut: previous account');

  // 7b. Manual-login guard: Hatswap must not auto-save a different login over Alice.
  // After each switch Hatswap checks in the background that the site kept the
  // session; let that finish before simulating anything done by hand.
  const settle = () => app.waitForTimeout(4000);
  const clearSiteData = async () => {
    // What Chrome's "Clear site data" does: every cookie, plus both origins' Web Storage.
    // The pages are closed first: the dashboard's polling would otherwise renew the
    // cookies right after they're deleted (the same race Hatswap guards against).
    for (const page of [app, admin]) await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
    await app.goto('about:blank');
    await admin.goto('about:blank');
    await app.waitForTimeout(600);
    for (let pass = 0; pass < 3; pass++) {
      await sw.evaluate(async () => {
        for (const c of await chrome.cookies.getAll({ domain: 'hatswap.localhost', partitionKey: {} })) {
          const scheme = c.partitionKey ? c.partitionKey.topLevelSite.split(':')[0] : c.secure ? 'https' : 'http';
          await chrome.cookies.remove({ url: `${scheme}://${c.domain.replace(/^\./, '')}${c.path}`, name: c.name, partitionKey: c.partitionKey });
        }
      });
    }
  };
  const signInByHand = async (user) => {
    await clearSiteData();
    await app.goto(APP);
    await signIn(user);
    await admin.goto(ADMIN);
  };
  const driftBanner = async () => {
    await openPopup();
    return (await popup.locator('#drift').count()) ? (await popup.textContent('#drift')).trim() : null;
  };

  // A login cookie the site refreshes on its own: one question, then Hatswap learns it.
  await settle();
  await app.goto(`${APP}?refresh=1`);
  let banner = await driftBanner();
  check('guard: a refreshed long-lived login cookie raises the question', banner?.includes('“Alice”'), banner);
  await popup.click('#drift >> text=Review');
  await shot('12-guard-question');
  await popup.getByRole('button', { name: /^It's still/i }).click();
  await popup.waitForFunction(() => document.querySelector('#toast').textContent.includes('Updated'));
  check('guard: "It\'s still Alice" clears the warning', !(await driftBanner()));
  await app.goto(`${APP}?refresh=1`);
  check('guard: learned that cookie rotates, no question the next time', !(await driftBanner()));

  // Signing in to another account by hand.
  await signInByHand('carol');
  banner = await driftBanner();
  check('guard: a manual sign-in to another account is detected', banner?.includes('“Alice”'), banner);
  await popup.click('.account-main:has-text("Bob")');
  await popup.waitForSelector('.choices');
  check('guard: switching away asks first instead of saving over Alice', (await readApp()).cookie === 'carol');
  await popup.getByRole('button', { name: 'Save it as a new account' }).click();
  await popup.fill('[name=name]', 'Carol by hand');
  await afterReload(() => popup.click('button[type=submit]'));
  await expectUser('bob', 'guard: saved the new login, then carried on to Bob');
  await switchTo('Alice');
  await expectUser('alice', 'guard: Alice was not overwritten');
  await switchTo('Carol by hand');
  await expectUser('carol', 'guard: the manual login was kept as its own account');
  await switchTo('Alice');

  // Keyboard shortcut while the session has drifted: no switch, the badge asks.
  await settle();
  await signInByHand('dave');
  const flash = await sw.evaluate(async (tabId) => {
    await globalThis.hatswap.runCommand('switch-next', await chrome.tabs.get(tabId));
    return chrome.action.getBadgeText({ tabId });
  }, appTab);
  check('guard: the shortcut refuses to save over Alice and flags it', flash === '?' && (await readApp()).cookie === 'dave', `badge ${flash}`);
  await openPopup();
  await popup.click('#drift >> text=Review');
  await afterReload(() => popup.getByRole('button', { name: /^Restore saved/i }).click());
  await expectUser('alice', 'guard: restore Alice over the manual login');

  // Signed out by hand: nothing worth saving, one click restores Alice.
  await settle();
  await clearSiteData();
  await app.goto(APP);
  await admin.goto(ADMIN);
  banner = await driftBanner();
  check('guard: a signed-out site is recognised', banner?.includes('Signed out here'), banner || (await popup.textContent('#view')).trim().slice(0, 160));
  await popup.click('.account-main:has-text("Alice")');
  await shot('13-guard-signed-out');
  await afterReload(() => popup.getByRole('button', { name: 'Restore “Alice”' }).click());
  await expectUser('alice', 'guard: restore after signing out by hand');

  await openPopup();
  await popup.click('[aria-label="Edit Carol by hand"]');
  await popup.getByRole('button', { name: 'Delete account' }).click();
  await popup.click('.confirm >> text=Delete account');
  await popup.waitForSelector('.account-main:has-text("Carol by hand")', { state: 'detached' });

  // 7c. A saved session the server already ended: the switch is flagged, not silent.
  await switchTo('Bob');
  await app.evaluate(() => fetch('/__expire?user=alice', { method: 'POST' }));
  await switchTo('Alice');
  const flagged = await sw.evaluate(async (tabId) => {
    for (let i = 0; i < 100; i++) {
      if ((await chrome.action.getBadgeText({ tabId })) === '!') return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  }, appTab);
  check('rejected session: site bounced to its login page, badge shows !', flagged && app.url().includes('/login'), app.url());
  await openPopup();
  const rejectedText = (await popup.locator('#rejected').count()) ? (await popup.textContent('#rejected')).trim() : null;
  check('rejected session: the popup explains what happened', rejectedText?.includes("rejected Alice's saved session"), rejectedText);
  await shot('15-rejected');
  await popup.click('#rejected button');
  await popup.click('.sheet-actions >> text=Replace session');
  await popup.waitForFunction(() => document.querySelector('#toast').textContent.includes("doesn't look signed in"));
  check('rejected session: Update refuses to save a signed-out page', true);
  await signIn('alice');
  await admin.reload();
  await openPopup();
  await popup.click('#rejected button');
  await popup.click('.sheet-actions >> text=Replace session');
  await popup.waitForFunction(() => document.querySelector('#toast').textContent.includes('Updated'));
  check('rejected session: after signing in again, Update fixes the account', !(await popup.locator('#rejected').count()));
  await switchTo('Bob');
  await switchTo('Alice');
  await expectUser('alice', 'rejected session: Alice works again after the update');

  // 8. Lock, wrong password, unlock
  await openPopup();
  await popup.click('#lock');
  await popup.waitForSelector('.lock-screen');
  await shot('05-locked');
  const lockedCmd = await sw.evaluate(async (tabId) => {
    await globalThis.hatswap.runCommand('switch-next', await chrome.tabs.get(tabId));
    return chrome.action.getBadgeText({ tabId });
  }, appTab);
  check('shortcut does nothing while locked', (await readApp()).cookie === 'alice', `badge: ${lockedCmd}`);
  await popup.fill('[name=password]', 'wrong-password');
  await popup.click('button[type=submit]');
  await popup.waitForFunction(() => document.querySelector('#toast').textContent.includes('Wrong'));
  check('wrong master password rejected', true);
  await popup.fill('[name=password]', MASTER);
  await popup.click('button[type=submit]');
  await popup.waitForSelector('.account');
  check('unlock with the right password', true);

  // 9. Auto-lock after idle time
  await popup.click('#settings');
  await popup.selectOption('#autoLock', '1');
  await popup.waitForTimeout(200);
  await shot('06-settings');
  await sw.evaluate(async () => {
    const { unlocked } = await chrome.storage.session.get('unlocked');
    await chrome.storage.session.set({ unlocked: { ...unlocked, lastActive: Date.now() - 2 * 60_000 } });
  });
  await openPopup();
  check('auto-locks after the idle timeout', await popup.locator('.lock-screen').isVisible());
  check('idle timeout wiped the key from memory', await sw.evaluate(async () => !(await chrome.storage.session.get('unlocked')).unlocked));
  await popup.fill('[name=password]', MASTER);
  await popup.click('button[type=submit]');
  await popup.waitForSelector('.account');
  await popup.click('#settings');
  await popup.selectOption('#autoLock', '15');
  await popup.waitForTimeout(150);

  // 10. Edit: rename + recolour
  await openPopup();
  await popup.click('[aria-label="Edit Bob"]');
  await popup.fill('[name=name]', 'Bob Builder');
  await popup.check('input[aria-label=Violet]');
  await popup.click('button[type=submit]');
  await popup.waitForSelector('.account-main:has-text("Bob Builder")');
  check('rename + recolour saved', true);

  // 11. Many accounts (each a real sign-in via New account): search
  for (const name of ['Carol', 'Dave', 'Erin']) {
    await openPopup();
    await afterReload(() => popup.getByRole('button', { name: 'New Account', exact: true }).click());
    await signIn(name.toLowerCase());
    await openPopup();
    await popup.getByRole('button', { name: 'Save as new account' }).click();
    await popup.fill('[name=name]', name);
    await popup.fill('[name=group]', 'Test');
    await popup.click('button[type=submit]');
    await popup.waitForSelector(`.account-main:has-text("${name}")`);
  }
  await openPopup();
  check('search appears with more than 4 accounts', await popup.locator('#search').isVisible());
  await popup.keyboard.type('bui');
  check('search filters by name', (await popup.locator('.account').count()) === 1);
  await shot('07-search');
  await afterReload(() => popup.keyboard.press('Enter'));
  await expectUser('bob', 'Enter in search switches to the match');

  // 12. Delete with confirmation
  await openPopup();
  await popup.click('[aria-label="Edit Erin"]');
  await popup.getByRole('button', { name: 'Delete account' }).click();
  await shot('08-delete-confirm');
  await popup.click('.confirm >> text=Delete account');
  await popup.waitForSelector('.account-main:has-text("Erin")', { state: 'detached' });
  check('delete (after confirm) removes the account', !(await popup.locator('.account-main:has-text("Erin")').count()));
  for (const name of ['Carol', 'Dave']) {
    await popup.click(`[aria-label="Edit ${name}"]`);
    await popup.getByRole('button', { name: 'Delete account' }).click();
    await popup.click('.confirm >> text=Delete account');
    await popup.waitForSelector(`.account-main:has-text("${name}")`, { state: 'detached' });
  }
  await shot('09-list-final');
  await popup.emulateMedia({ colorScheme: 'dark' });
  await shot('10-list-dark');
  await popup.emulateMedia({ colorScheme: 'light' });

  // 13. Change master password, then the sessions must still decrypt
  await popup.click('#settings');
  await popup.click('text=Change master password');
  await popup.fill('[name=current]', MASTER);
  await popup.fill('[name=next]', NEW_MASTER);
  await popup.fill('[name=confirm]', NEW_MASTER);
  await popup.click('#password-save');
  await popup.waitForFunction(() => document.querySelector('#toast').textContent.includes('re-encrypted'));
  await openPopup();
  await popup.click('#lock');
  await popup.fill('[name=password]', MASTER);
  await popup.click('button[type=submit]');
  await popup.waitForFunction(() => document.querySelector('#toast').textContent.includes('Wrong'));
  await popup.fill('[name=password]', NEW_MASTER);
  await popup.click('button[type=submit]');
  await popup.waitForSelector('.account');
  await switchTo('Alice');
  await expectUser('alice', 'after password change');

  // 13b. Backup export. Switching to Bob first saves Alice's live session, so the
  // backup's copy of Alice is current (the test site retires old session tokens).
  await switchTo('Bob Builder');
  const backupPage = await context.newPage();
  await backupPage.setViewportSize({ width: 720, height: 900 });
  const openBackupPage = async (expect) => {
    await backupPage.goto(`chrome-extension://${extensionId}/backup.html`);
    await backupPage.waitForFunction((text) => document.querySelector('#status-line').textContent.includes(text), expect);
  };
  await openBackupPage('unlocked');
  await backupPage.fill('#export-form [name=password]', NEW_MASTER);
  const [download] = await Promise.all([backupPage.waitForEvent('download'), backupPage.click('#export-btn')]);
  const backupFile = path.join(OUT, 'hatswap-backup.json');
  await download.saveAs(backupFile);
  const backupText = readFileSync(backupFile, 'utf8');
  const backupJson = JSON.parse(backupText);
  check('backup: downloaded file is a Hatswap backup', backupJson.format === 'hatswap-backup' && backupJson.version === 1 && Boolean(backupJson.data?.ct), download.suggestedFilename());
  check('backup: nothing readable in the file (names, cookies, settings)', !/Alice|Bob|"cookies"|"settings"|autoLock/.test(backupText), `${backupText.length} bytes`);
  await backupPage.waitForSelector('#export-result');
  const exportText = (await backupPage.textContent('#export-result')).trim();
  check('backup: export reports both accounts', exportText.includes('2 accounts'), exportText);
  await backupPage.screenshot({ path: path.join(OUT, '16-backup-export.png'), fullPage: true });

  // 14. Pages where Chrome blocks extensions
  const chromePage = await context.newPage();
  await chromePage.goto('chrome://version');
  const chromeTab = await tabIdOf('chrome://version/*');
  await openPopup(chromeTab);
  check('chrome:// page gets a clear message', (await popup.textContent('.empty')).includes("Chrome doesn't let extensions"), await popup.textContent('.empty p'));
  await shot('11-unsupported');
  await chromePage.close();

  // 15. Erase everything
  const eraseAll = async () => {
    await openPopup();
    await popup.click('#settings');
    await popup.click('text=Erase All Data');
    await popup.click('.sheet-actions button:has-text("Erase Everything")');
    await popup.waitForSelector('.features');
  };
  await eraseAll();
  check('erase returns to first-run setup', (await sw.evaluate(async () => Object.keys(await chrome.storage.local.get(null)).length)) === 0);

  // 15b. Restore on a fresh install, then again into the existing vault.
  await openBackupPage('No vault');
  const importResult = () => backupPage.textContent('#import-result').then((t) => t.trim());
  await backupPage.setInputFiles('#file', backupFile);
  await backupPage.fill('#import-form [name=password]', 'wrong-password');
  await backupPage.click('#import-btn');
  await backupPage.waitForSelector('#import-result.error');
  check('restore: wrong password is rejected', (await importResult()).includes('Wrong password'), await importResult());
  await backupPage.fill('#import-form [name=password]', NEW_MASTER);
  await backupPage.click('#import-btn');
  await backupPage.waitForFunction(() => /Restored/.test(document.querySelector('#import-result').textContent));
  const restored = await importResult();
  check('restore: fresh install creates the vault and adds both accounts', restored.includes('2 accounts added') && restored.includes('vault was created'), restored);
  await backupPage.screenshot({ path: path.join(OUT, '17-backup-restored.png'), fullPage: true });
  await openPopup();
  check('restore: popup is unlocked with the restored accounts, none active', (await popup.locator('.account').count()) === 2 && !(await popup.locator('.account.is-active').count()));
  await switchTo('Alice');
  await expectUser('alice', 'restore: switching to a restored account works');
  await openBackupPage('unlocked');
  await backupPage.setInputFiles('#file', backupFile);
  await backupPage.fill('#import-form [name=password]', NEW_MASTER);
  await backupPage.click('#import-btn');
  await backupPage.waitForFunction(() => /Restored|Nothing/.test(document.querySelector('#import-result').textContent));
  check('restore: importing again into the existing vault changes nothing', (await importResult()).includes('2 already up to date'), await importResult());
  await eraseAll();
  check('final erase leaves storage empty', (await sw.evaluate(async () => Object.keys(await chrome.storage.local.get(null)).length)) === 0);
} catch (error) {
  check('test run finished without exceptions', false, error.message.split('\n').slice(0, 12).join(' | '));
  // Leave evidence behind: a screenshot of every open page.
  for (const [i, page] of context.pages().entries()) {
    await page.screenshot({ path: path.join(OUT, `failure-${i}.png`) }).catch(() => {});
  }
  for (const line of consoleErrors) console.log('console:', line);
} finally {
  await context.close();
  server.kill();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed. Screenshots: ${OUT}`);
process.exit(failed.length ? 1 : 0);
