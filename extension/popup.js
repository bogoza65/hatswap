// Hatswap popup. All state lives in the service worker; this file renders it,
// animates it and turns clicks into messages. User data is only ever inserted as
// text nodes.
//
// Layout: a stack of screens that push and pop, a modal sheet for saving and
// editing, and a floating card for confirmations. The whole popup sits on a
// colour wash that takes the active account's colour.

import { COLORS, initials, textColorOn } from './lib/accounts.js';

const params = new URLSearchParams(location.search);
// ?tabId= opens the popup against a specific tab, e.g. when testing it in a normal tab.
const pinnedTab = params.has('tabId');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const isMac = /mac/i.test(navigator.userAgentData?.platform || navigator.platform);
const HERE = isMac ? 'this Mac' : 'this computer';
const MOD = isMac ? '⌘' : 'Ctrl+';

const AUTO_LOCK_LABELS = new Map([
  [1, '1 Minute'], [5, '5 Minutes'], [15, '15 Minutes'], [30, '30 Minutes'],
  [60, '1 Hour'], [240, '4 Hours'], [0, isMac ? 'When Chrome Quits' : 'When Chrome Closes'],
]);
const SEARCH_THRESHOLD = 4; // show the search field above this many accounts
const STORAGE_QUOTA = 10 * 1024 * 1024;
const SWITCH_MIN_MS = 520; // let the check and the hat finish before the popup closes

const app = document.getElementById('app');
const view = document.getElementById('view');
const sheetLayer = document.getElementById('sheet-layer');
const sheet = sheetLayer.querySelector('.sheet');
const actionLayer = document.getElementById('action-layer');
const actionSheet = actionLayer.querySelector('.action-sheet');

let tabId;
let state;
const ui = {
  view: 'main', // main | settings | password
  setupStep: 'welcome', // welcome | password
  query: '',
  selected: 0,
  sheet: null, // null | 'form' | 'decision'
  form: null,
  decision: null,
  confirm: null, // action sheet
  busyId: null,
};

// ---------------------------------------------------------------------------
// Tiny DOM helpers

const SPOKES = Array.from({ length: 8 }, (_, i) => {
  const a = (i * Math.PI) / 4;
  const [s, c] = [Math.sin(a), Math.cos(a)];
  return `<path d="M${(12 + 4.4 * s).toFixed(2)} ${(12 - 4.4 * c).toFixed(2)}L${(12 + 8 * s).toFixed(2)} ${(12 - 8 * c).toFixed(2)}" opacity="${(0.22 + (i / 7) * 0.78).toFixed(2)}"/>`;
}).join('');

// Drawn to sit next to SF Symbols: 24px grid, rounded joins.
const ICONS = {
  'chevron-left': '<path d="M14.5 5.5 8 12l6.5 6.5"/>',
  'chevron-right': '<path d="m9.5 6 6 6-6 6"/>',
  check: '<path d="m5.5 12.5 4 4L18.5 7"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5"/><circle cx="12" cy="7.8" r="1.1" fill="currentColor" stroke="none"/>',
  gear: '<path d="M9.81 4.93L10.07 2.49A9.7 9.7 0 0 1 13.93 2.49L14.19 4.93A7.4 7.4 0 0 1 15.45 5.45L17.36 3.92A9.7 9.7 0 0 1 20.08 6.64L18.55 8.55A7.4 7.4 0 0 1 19.07 9.81L21.51 10.07A9.7 9.7 0 0 1 21.51 13.93L19.07 14.19A7.4 7.4 0 0 1 18.55 15.45L20.08 17.36A9.7 9.7 0 0 1 17.36 20.08L15.45 18.55A7.4 7.4 0 0 1 14.19 19.07L13.93 21.51A9.7 9.7 0 0 1 10.07 21.51L9.81 19.07A7.4 7.4 0 0 1 8.55 18.55L6.64 20.08A9.7 9.7 0 0 1 3.92 17.36L5.45 15.45A7.4 7.4 0 0 1 4.93 14.19L2.49 13.93A9.7 9.7 0 0 1 2.49 10.07L4.93 9.81A7.4 7.4 0 0 1 5.45 8.55L3.92 6.64A9.7 9.7 0 0 1 6.64 3.92L8.55 5.45A7.4 7.4 0 0 1 9.81 4.93Z"/><circle cx="12" cy="12" r="3"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2.5"/><path class="shackle" d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  'lock-fill': '<path class="shackle" d="M8 11V8a4 4 0 0 1 8 0v3"/><rect x="5" y="11" width="14" height="10" rx="2.5" fill="currentColor"/>',
  search: '<circle cx="10.5" cy="10.5" r="6"/><path d="m15 15 4.5 4.5"/>',
  clear: '<circle cx="12" cy="12" r="9" fill="currentColor" stroke="none"/><path d="m9.2 9.2 5.6 5.6m0-5.6-5.6 5.6" style="stroke: var(--cell)"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  'person-plus': '<circle cx="10" cy="8" r="3.5"/><path d="M3.5 19.5a6.5 6.5 0 0 1 13 0"/><path d="M19 8v6M16 11h6"/>',
  arrow: '<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>',
  refresh: '<path d="M4 12a8 8 0 1 0 2.3-5.7"/><path d="M4 5v4.5h4.5"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  key: '<circle cx="7.5" cy="15.5" r="3.5"/><path d="m10 13 9-9M16 7l2.5 2.5M13.5 9.5l2 2"/>',
  alert: '<path d="M10.3 4.3 2.6 18a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0z" fill="currentColor" stroke="none"/><path d="M12 9.3v4.2" style="stroke:#fff" stroke-width="2"/><circle cx="12" cy="16.9" r="1.15" fill="#fff" stroke="none"/>',
  shield: '<path d="M12 3 5 6v5c0 4.5 3 8.3 7 10 4-1.7 7-5.5 7-10V6z" fill="currentColor" stroke="none"/><path d="m9 12 2.2 2.2L15.5 10" style="stroke:#fff" stroke-width="2"/>',
};

/** The brand hat: the artwork plus a band layer the UI can tint (see .hat-band in popup.css). */
function hatMark(props = {}) {
  return h('span', { ...props, class: cls('mark', props.class) }, h('img', { class: 'hat', src: 'icons/hat.png', alt: '' }), h('span', { class: 'hat-band', 'aria-hidden': 'true' }));
}

function svg(markup) {
  const template = document.createElement('template');
  template.innerHTML = markup.trim();
  return template.content.firstChild;
}

function icon(name, extraClass = '') {
  return svg(`<svg class="i ${extraClass}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`);
}

function spinner() {
  return svg(`<svg class="spinner" viewBox="0 0 24 24" aria-label="Working">${SPOKES}</svg>`);
}

/** h('button', { class: 'btn', onclick }, 'Label') */
function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key === 'class') el.className = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

const cls = (...names) => names.filter(Boolean).join(' ');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
function timeAgo(timestamp) {
  if (!timestamp) return 'never';
  const seconds = (timestamp - Date.now()) / 1000;
  for (const [unit, size] of [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]]) {
    if (Math.abs(seconds) >= size) return rtf.format(Math.round(seconds / size), unit);
  }
  return 'just now';
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// Building blocks: screens, bars, grouped sections

/** A screen: nav bar over a scrolling body, optional toolbar. `as` lets a screen be a <form>. */
function screen({ as = 'div', props = {}, nav, body, toolbar }) {
  return h(as, { ...props, class: cls('screen', props.class) },
    nav,
    h('div', { class: 'scroll' }, body),
    toolbar ? h('div', { class: 'toolbar' }, toolbar) : null);
}

function navbar({ leading, title, trailing }) {
  return h('header', { class: 'navbar' },
    h('div', { class: 'nav-leading' }, leading),
    h('div', { class: 'nav-title' }, title || ''),
    h('div', { class: 'nav-trailing' }, trailing));
}

function backButton(label, onClick) {
  return h('button', { class: 'text-btn back', type: 'button', onclick: onClick }, icon('chevron-left'), label);
}

function section({ header, footer, footerClass, children }) {
  return h('div', { class: 'section' },
    header ? h('div', { class: 'section-header' }, header) : null,
    children,
    footer ? h('div', { class: cls('section-footer', footerClass) }, footer) : null);
}

function group(...rows) {
  return h('div', { class: 'group' }, rows);
}

function cell(props, ...children) {
  return h(props.onclick ? 'button' : 'div', { type: props.onclick ? 'button' : null, ...props, class: cls('cell', props.class) }, children);
}

function inputCell(label, props) {
  return h('label', { class: 'cell input-cell' }, h('span', { class: 'label' }, label), h('input', { autocomplete: 'off', spellcheck: 'false', ...props }));
}

/** Keeps the bars clear at rest and frosted while content scrolls under them. */
function wireScroll(screenEl) {
  const scroller = screenEl?.querySelector(':scope > .scroll');
  if (!scroller) return;
  const update = () => {
    screenEl.toggleAttribute('data-scrolled', scroller.scrollTop > 1);
    screenEl.toggleAttribute('data-more', scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 1);
  };
  scroller.addEventListener('scroll', update, { passive: true });
  requestAnimationFrame(update);
}

// ---------------------------------------------------------------------------
// Talking to the service worker

async function send(message) {
  try {
    return (await chrome.runtime.sendMessage(message)) || { ok: false, error: 'Hatswap did not respond. Try again.' };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function refresh() {
  state = await send({ type: 'getState', tabId });
  return render();
}

/**
 * Runs an action that needs host access to the site. If access hasn't been
 * granted yet this asks Chrome for it, which only works inside a click handler,
 * so call this synchronously from the event, before any await.
 */
function runSiteAction(action) {
  action = { ...action, tabId };
  if (state.hasAccess) return send({ type: 'run', action });

  const pendingId = crypto.randomUUID();
  // Queued first: if the popup closes during Chrome's prompt, the service worker finishes the job.
  send({ type: 'queue', pendingId, action });
  return chrome.permissions.request({ origins: [state.tab.pattern] }).then(
    (granted) => {
      if (!granted) {
        send({ type: 'dropQueued', pendingId });
        return { ok: false, error: `Hatswap needs access to ${state.tab.site} for this. Nothing was changed.` };
      }
      return send({ type: 'runQueued', pendingId, action });
    },
    (error) => {
      send({ type: 'dropQueued', pendingId });
      return { ok: false, error: error.message };
    },
  );
}

function handleError(response) {
  if (response.code === 'locked' || response.code === 'no-access') return refresh().then(() => toast(response.error, { type: 'error' }));
  toast(response.error, { type: 'error' });
}

/** Feedback on a button while a slow call (PBKDF2, a switch) runs. */
function setBusy(button, busy, label) {
  if (!button) return;
  if (busy) {
    button.dataset.idle = button.innerHTML;
    button.replaceChildren(spinner(), label ? h('span', null, label) : null);
  } else if (button.dataset.idle) {
    button.innerHTML = button.dataset.idle;
  }
  button.disabled = busy;
}

// ---------------------------------------------------------------------------
// Toast: a capsule that drops in from the top

let toastTimer;
function toast(message, { type = 'ok', details = [] } = {}) {
  const el = document.getElementById('toast');
  clearTimeout(toastTimer);
  el.className = `toast ${type}`;
  el.replaceChildren(icon(type === 'ok' ? 'check' : 'alert'), h('span', null, message));
  if (details.length) el.append(h('ul', { class: 'toast-details' }, details.map((d) => h('li', null, d))));
  el.dataset.show = 'true';
  toastTimer = setTimeout(hideToast, details.length ? 9000 : type === 'error' ? 6000 : 2800);
}

function hideToast() {
  document.getElementById('toast').dataset.show = 'false';
}

// ---------------------------------------------------------------------------
// Rendering

// Navigation depth of each base screen: deeper pushes in from the right, shallower
// pops back, equal depth crossfades (e.g. unlocking).
const DEPTH = { welcome: 0, 'setup-password': 1, locked: 0, unsupported: 0, main: 0, settings: 1, password: 2 };
const SCREENS = {
  welcome: () => welcomeScreen(),
  'setup-password': () => setupPasswordScreen(),
  locked: () => lockedScreen(),
  unsupported: () => unsupportedScreen(),
  main: () => mainScreen(),
  settings: () => settingsScreen(),
  password: () => passwordScreen(),
};
let shown = null;

function baseScreen() {
  if (state.status === 'setup') return ui.setupStep === 'password' ? 'setup-password' : 'welcome';
  if (state.status === 'locked') return 'locked';
  if (ui.view === 'settings' || ui.view === 'password') return ui.view;
  return state.tab.supported ? 'main' : 'unsupported';
}

/** Renders everything. Resolves once the base screen is in the DOM. */
function render() {
  const key = baseScreen();
  const from = shown;
  shown = key;
  const swap = () => {
    view.replaceChildren(SCREENS[key]());
    wireScroll(view.firstChild);
    if (!ui.sheet && !ui.confirm) view.querySelector('[data-autofocus]')?.focus({ preventScroll: true });
  };
  let done;
  if (!from || from === key || reducedMotion.matches || !document.startViewTransition) {
    swap();
    done = Promise.resolve();
  } else {
    document.documentElement.dataset.nav = DEPTH[key] > DEPTH[from] ? 'forward' : DEPTH[key] < DEPTH[from] ? 'back' : 'fade';
    done = document.startViewTransition(swap).updateCallbackDone;
  }
  setWash(state.status === 'unlocked' ? activeAccount()?.color : null);
  renderSheet();
  renderActionSheet();
  document.body.classList.toggle('modal-open', Boolean(ui.confirm) && !ui.sheet);
  app.inert = Boolean(ui.sheet || ui.confirm);
  sheetLayer.inert = !ui.sheet || Boolean(ui.confirm);
  return done;
}

function goTo(name) {
  ui.view = name;
  ui.sheet = null;
  ui.confirm = null;
  return render();
}

// --- Modal sheet

let sheetOpen = false;
let sheetBuiltFor = null;
let sheetClearTimer;

function renderSheet() {
  const kind = state.status === 'unlocked' ? ui.sheet : null;
  const model = kind === 'form' ? ui.form : kind === 'decision' ? ui.decision : null;
  if (kind) {
    clearTimeout(sheetClearTimer);
    // Rebuild only for a new form or question, so typing isn't lost on unrelated renders.
    if (sheetBuiltFor !== model) {
      sheet.replaceChildren(h('div', { class: 'grabber' }), kind === 'form' ? formSheet() : decisionSheet(model));
      wireScroll(sheet.querySelector('.screen'));
      sheetBuiltFor = model;
      if (!ui.confirm) requestAnimationFrame(() => sheet.querySelector('[data-autofocus]')?.focus({ preventScroll: true }));
    }
    if (!sheetOpen) {
      sheetOpen = true;
      sheet.getBoundingClientRect(); // start from the closed position
      sheetLayer.dataset.open = 'true';
      document.body.classList.add('sheet-open');
    }
  } else if (sheetOpen) {
    sheetOpen = false;
    sheetBuiltFor = null;
    sheetLayer.dataset.open = 'false';
    document.body.classList.remove('sheet-open');
    sheetClearTimer = setTimeout(() => sheet.replaceChildren(), 400);
  }
}

function closeSheet() {
  ui.sheet = null;
  ui.form = null;
  ui.decision = null;
  return render();
}

// --- Action sheet

let actionOpen = false;
let actionBuiltFor = null;
let actionClearTimer;

function renderActionSheet() {
  const c = ui.confirm;
  if (c) {
    clearTimeout(actionClearTimer);
    if (actionBuiltFor !== c) {
      const cancel = () => (c.onCancel || cancelConfirm)();
      actionSheet.replaceChildren(
        h('div', { class: 'action-group' },
          h('div', { class: 'action-message' }, h('strong', null, c.title), c.body),
          h('button', {
            class: cls('action-btn', c.danger && 'destructive'),
            type: 'button',
            onclick: (event) => {
              setBusy(event.currentTarget, true);
              c.onConfirm();
            },
          }, c.confirmLabel)),
        h('div', { class: 'action-group' }, h('button', { class: 'action-btn cancel', type: 'button', onclick: cancel }, 'Cancel')));
      actionBuiltFor = c;
      requestAnimationFrame(() => actionSheet.querySelector('.cancel')?.focus({ preventScroll: true }));
    }
    if (!actionOpen) {
      actionOpen = true;
      actionSheet.getBoundingClientRect();
      actionLayer.dataset.open = 'true';
      actionLayer.inert = false;
      document.body.classList.add('confirm-open');
    }
  } else if (actionOpen) {
    actionOpen = false;
    actionBuiltFor = null;
    actionLayer.dataset.open = 'false';
    actionLayer.inert = true;
    document.body.classList.remove('confirm-open');
    actionClearTimer = setTimeout(() => actionSheet.replaceChildren(), 400);
  }
}

function cancelConfirm() {
  ui.confirm = null;
  return render();
}

sheetLayer.querySelector('.scrim').addEventListener('click', () => closeSheet());
document.getElementById('toast').addEventListener('click', hideToast);
actionLayer.querySelector('.scrim').addEventListener('click', () => (ui.confirm?.onCancel || cancelConfirm)());

// ---------------------------------------------------------------------------
// Shared bits of state

function activeAccount() {
  return state.accounts?.find((a) => a.id === state.activeId) || null;
}

/** True when the site threw away this account's session right after Hatswap restored it. */
function isRejected(account) {
  return Boolean(account?.rejectedAt && account.rejectedAt >= (account.restoredAt || 0));
}

/** True when the live session no longer looks like the active account (see lib/identity.js). */
function sessionDrifted() {
  return state.sessionCheck?.status === 'mismatch';
}

/** The colour wash behind everything: the active account's colour, or Hatswap coral. */
function setWash(color) {
  document.documentElement.style.setProperty('--wash', color || 'var(--coral)');
}

/** The hat in the nav bar wears the active account's colour on its band. */
function setMark(color, { swap = false } = {}) {
  setWash(color);
  const mark = document.getElementById('mark');
  if (!mark) return;
  mark.style.setProperty('--band', color || 'var(--coral)');
  if (swap && !reducedMotion.matches) {
    mark.classList.remove('is-swapping');
    void mark.offsetWidth; // restart the animation
    mark.classList.add('is-swapping');
  }
}

function brandBar() {
  const mark = hatMark({ id: 'mark' });
  mark.style.setProperty('--band', activeAccount()?.color || 'var(--coral)');
  mark.addEventListener('animationend', () => mark.classList.remove('is-swapping'));
  return h('header', { class: 'navbar brand-bar' },
    h('div', { class: 'brand' }, mark, h('span', { class: 'brand-site', title: state.tab.supported ? `Accounts for ${state.tab.site} and its subdomains` : null }, state.tab.supported ? state.tab.site : 'Hatswap')),
    h('div', { class: 'nav-trailing' },
      h('button', { class: 'icon-btn', id: 'lock', type: 'button', title: `Lock (${MOD}L)`, 'aria-label': 'Lock Hatswap', onclick: lockNow }, icon('lock')),
      h('button', { class: 'icon-btn', id: 'settings', type: 'button', title: `Settings (${MOD},)`, 'aria-label': 'Settings', onclick: () => goTo('settings') }, icon('gear'))));
}

/** Backup & Restore lives on its own page: file pickers and downloads don't suit a popup. */
function openBackupPage() {
  chrome.tabs.create({ url: chrome.runtime.getURL('backup.html') });
  if (!pinnedTab) window.close();
}

function appIcon() {
  return h('img', { class: 'app-icon', src: 'icons/icon128.png', alt: '' });
}

// ---------------------------------------------------------------------------
// First run: welcome, then the master password

function welcomeScreen() {
  const feature = (name, color, title, text, muted) => h('div', { class: cls('feature', 'glass', muted && 'muted') },
    name ? icon(name) : h('span', { class: 'i' }),
    h('div', null, h('strong', null, title), h('span', null, text)));
  const features = h('div', { class: 'features' },
    feature('key', '', 'A saved login is a key', 'Anyone who has it can use that account, without its password or 2FA.'),
    feature('shield', '', `Encrypted on ${HERE}`, 'Your master password locks every login with AES-256. Hatswap never goes online.'),
    feature('alert', '', 'No way to recover it', "Forget the master password and you'll sign in to each account again."));
  const [key, shield, alert] = features.querySelectorAll('.i');
  key.style.color = 'var(--coral)';
  shield.style.color = 'var(--ok)';
  alert.style.color = 'var(--warn)';
  return screen({
    body: h('div', { class: 'welcome' },
      appIcon(),
      h('h1', { class: 'title-large' }, 'Welcome to Hatswap'),
      h('p', { class: 'subtitle' }, 'Switch accounts on the same site in one click.'),
      features,
      h('p', { class: 'section-footer' }, "Account names and colors aren't encrypted, so the toolbar badge works while Hatswap is locked."),
      h('button', { class: 'text-btn small', type: 'button', onclick: openBackupPage }, 'Have a backup? Restore it')),
    toolbar: h('button', { class: 'btn filled large grow', type: 'button', 'data-autofocus': true, onclick: () => { ui.setupStep = 'password'; render(); } }, 'Continue'),
  });
}

function setupPasswordScreen() {
  return screen({
    as: 'form',
    props: { onsubmit: submitSetup },
    nav: navbar({ leading: backButton('Back', () => { ui.setupStep = 'welcome'; render(); }), title: 'Master Password' }),
    body: [
      section({
        footer: 'At least 8 characters. A short sentence is easy to remember and hard to guess.',
        children: group(
          inputCell('Password', { type: 'password', name: 'password', placeholder: 'Required', autocomplete: 'new-password', minlength: 8, required: true, 'data-autofocus': true }),
          inputCell('Repeat', { type: 'password', name: 'confirm', placeholder: 'Required', autocomplete: 'new-password', required: true })),
      }),
      section({
        footer: 'Hatswap locks itself after this long without being used.',
        children: group(cell({}, h('span', { class: 'cell-title' }, 'Auto-Lock'), autoLockMenu('autoLockMinutes', 15))),
      }),
      h('p', { class: 'section-footer error', id: 'setup-error', hidden: true }),
    ],
    toolbar: h('button', { class: 'btn filled large grow', type: 'submit' }, 'Create Vault'),
  });
}

async function submitSetup(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  const error = form.querySelector('#setup-error');
  const fail = (message) => { error.textContent = message; error.hidden = false; };
  if (data.get('password') !== data.get('confirm')) return fail("The passwords don't match.");
  const button = form.querySelector('[type=submit]');
  setBusy(button, true, 'Creating Vault');
  const response = await send({ type: 'setup', password: data.get('password'), autoLockMinutes: Number(data.get('autoLockMinutes')) });
  setBusy(button, false);
  if (!response.ok) return fail(response.error);
  ui.setupStep = 'welcome';
  await refresh();
  toast('Ready. Sign in on this page, then save the account.');
}

function autoLockMenu(name, current) {
  return h('select', { class: 'menu', name, id: name },
    [...AUTO_LOCK_LABELS].map(([minutes, label]) => h('option', { value: minutes, selected: minutes === current }, label)));
}

// ---------------------------------------------------------------------------
// Locked

function lockedScreen() {
  return screen({
    body: h('div', { class: 'center lock-screen' },
      h('div', { class: 'glyph lock-glyph' }, icon('lock-fill')),
      h('h1', { class: 'title' }, 'Hatswap Is Locked'),
      h('p', null, 'Enter your master password to switch accounts.'),
      h('form', { class: 'lock-form', onsubmit: submitUnlock },
        h('input', { class: 'field-rounded', type: 'password', name: 'password', placeholder: 'Master Password', autocomplete: 'current-password', required: true, 'aria-label': 'Master password', 'data-autofocus': true }),
        h('button', { class: 'btn filled large', type: 'submit' }, 'Unlock')),
      h('button', { class: 'text-btn small', type: 'button', onclick: () => askEraseAll(true) }, 'Forgot Password?')),
  });
}

async function submitUnlock(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const field = form.elements.password;
  const button = form.querySelector('[type=submit]');
  setBusy(button, true);
  const response = await send({ type: 'unlock', password: field.value });
  setBusy(button, false);
  if (!response.ok) {
    form.classList.remove('shake');
    void form.offsetWidth; // shake again on every wrong try
    form.classList.add('shake');
    field.select();
    return toast(response.error, { type: 'error' });
  }
  // The shackle pops open before the accounts fade in.
  hideToast();
  form.closest('.lock-screen').classList.add('is-open');
  await sleep(reducedMotion.matches ? 0 : 220);
  await refresh();
}

async function lockNow() {
  await send({ type: 'lock' });
  ui.view = 'main';
  ui.sheet = null;
  ui.confirm = null;
  await refresh();
}

// ---------------------------------------------------------------------------
// Not a website

function unsupportedScreen() {
  return screen({
    nav: brandBar(),
    body: [
      h('div', { class: 'center empty' },
        h('div', { class: 'glyph' }, icon('globe')),
        h('h1', { class: 'title' }, 'Nothing to Switch Here'),
        h('p', null, state.tab.reason)),
      state.sites?.length
        ? section({ header: `Saved on ${HERE}`, children: group(...state.sites.map((s) => cell({}, h('span', { class: 'cell-title' }, s.site), h('span', { class: 'cell-value' }, plural(s.count, 'account'))))) })
        : null,
    ],
  });
}

// ---------------------------------------------------------------------------
// Account list

function mainScreen() {
  const accounts = state.accounts || [];
  const active = activeAccount();
  const site = state.tab.site;
  const body = [];

  if (accounts.length > SEARCH_THRESHOLD) body.push(searchField(accounts.length));
  if (accounts.length && !state.hasAccess) {
    body.push(notice({ text: `Allow access to ${site} to switch accounts.`, action: 'Allow', onAction: grantAccess }));
  }
  if (active && isRejected(active)) {
    body.push(notice({ id: 'rejected', danger: true, text: `${site} rejected ${active.name}'s saved session. Sign in again on the page, then update it.`, action: 'Update', onAction: () => askReplace(active) }));
  } else if (active && sessionDrifted()) {
    body.push(notice({
      id: 'drift',
      text: state.sessionCheck.signedOut ? `Signed out here. “${active.name}” is still saved.` : `This doesn't look like “${active.name}” anymore.`,
      action: 'Review',
      onAction: () => openDecision({ kind: 'restore' }),
    }));
  }

  if (!accounts.length) {
    body.push(h('div', { class: 'center empty' },
      appIcon(),
      h('h1', { class: 'title' }, 'No Saved Logins'),
      h('p', null, `Sign in to ${site} on this page, then save the login here. New Account clears the way for the next one.`)));
  } else {
    const list = h('div', { class: 'accounts', id: 'accounts', 'aria-label': `Accounts for ${site}` });
    renderList(list);
    body.push(list);
    const shortcut = state.shortcuts['switch-next'];
    if (accounts.length >= 2 && shortcut) body.push(h('p', { class: 'key-hint' }, h('kbd', null, shortcut), 'Next account'));
  }

  return screen({
    nav: brandBar(),
    body,
    toolbar: [
      h('button', { class: 'btn filled grow', type: 'button', onclick: () => openForm('save') }, icon('plus'), 'Save as New Account'),
      h('button', { class: 'btn tinted', type: 'button', onclick: newAccount, title: "Clear this site's login here so you can sign in with another account" }, 'New Account'),
    ],
  });
}

function notice({ id, danger, text, action, onAction }) {
  return h('div', { class: 'section' },
    h('div', { class: cls('notice-cell', danger && 'danger'), id }, icon('alert'), h('p', null, text),
      h('button', { class: 'text-btn bold', type: 'button', onclick: onAction }, action)));
}

function searchField(count) {
  const clear = h('button', { class: 'clear', type: 'button', 'aria-label': 'Clear search', hidden: !ui.query, onclick: () => setQuery('', true) }, icon('clear'));
  return h('div', { class: 'search' },
    icon('search'),
    h('input', { type: 'search', id: 'search', placeholder: `Search ${count} accounts`, value: ui.query, autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Search accounts', oninput: (e) => setQuery(e.target.value), onkeydown: onSearchKey, 'data-autofocus': true }),
    clear);
}

function setQuery(query, refocus = false) {
  ui.query = query;
  ui.selected = 0;
  const input = document.getElementById('search');
  if (input && input.value !== query) input.value = query;
  input?.parentElement.querySelector('.clear')?.toggleAttribute('hidden', !query);
  if (refocus) input?.focus();
  renderList();
}

function filteredAccounts() {
  const query = ui.query.trim().toLowerCase();
  if (!query) return state.accounts;
  return state.accounts.filter((a) => a.name.toLowerCase().includes(query) || a.group.toLowerCase().includes(query));
}

/** Accounts as inset grouped sections, one per client/group. */
function renderList(list = document.getElementById('accounts')) {
  if (!list) return;
  const accounts = filteredAccounts();
  const showGroups = state.accounts.some((a) => a.group);
  const sections = [];
  let current;
  accounts.forEach((account, i) => {
    if (!current || (showGroups && account.group !== current.name)) {
      current = { name: account.group, rows: [] };
      sections.push(current);
    }
    current.rows.push(accountRow(account, ui.query && i === ui.selected));
  });
  list.replaceChildren(...sections.map((s) => section({
    header: showGroups ? s.name || 'Other' : null,
    children: h('ul', { class: 'group' }, h('li', { class: 'pill instant', 'aria-hidden': 'true' }), s.rows),
  })));
  if (!accounts.length) list.append(h('p', { class: 'no-results' }, `No accounts match “${ui.query.trim()}”.`));
  placePill(list.querySelector('.account.is-active'));
}

/**
 * Moves the glass pill behind `row`. Each group has its own pill, so a switch
 * within a group glides, and a switch across groups hands over from one pill
 * to the other.
 */
function placePill(row, animate = false) {
  for (const pill of document.querySelectorAll('.pill')) {
    const mine = row && pill.parentElement === row.parentElement;
    pill.classList.toggle('instant', !animate);
    if (mine) {
      pill.style.height = `${row.offsetHeight}px`;
      pill.style.transform = `translateY(${row.offsetTop}px)`;
    }
    pill.style.opacity = mine ? '1' : '0';
    if (!animate) pill.getBoundingClientRect(); // commit the jump before transitions are back on
  }
}

function accountRow(account, selected) {
  const active = account.id === state.activeId;
  return h('li', { class: cls('account', active && 'is-active', selected && 'is-selected'), 'data-row': account.id },
    h('button', {
      class: 'account-main',
      type: 'button',
      'data-id': account.id,
      'aria-current': active ? 'true' : null,
      title: active ? `${account.name} is active` : `Switch to ${account.name}`,
      onclick: () => switchTo(account),
      onkeydown: onRowKey,
    },
      h('span', { class: 'avatar', style: `--c:${account.color};--fg:${textColorOn(account.color)}` }, initials(account.name)),
      h('span', { class: 'account-text' }, h('span', { class: 'account-name' }, account.name), accountSub(account, active)),
      h('span', { class: 'state', 'aria-hidden': 'true' }, ui.busyId === account.id ? spinner() : icon('check', 'check'))),
    h('button', { class: 'info-btn', type: 'button', title: 'Edit', 'aria-label': `Edit ${account.name}`, onclick: () => openForm('edit', account) }, icon('info')));
}

function accountSub(account, active) {
  if (active && isRejected(account)) return h('span', { class: 'account-sub warn' }, 'Signed out by the site');
  if (active && sessionDrifted()) return h('span', { class: 'account-sub warn' }, 'The live login looks different');
  return h('span', { class: 'account-sub' }, active ? `Active · saved ${timeAgo(account.updatedAt)}` : `Used ${timeAgo(account.lastUsedAt)}`);
}

function onSearchKey(event) {
  const matches = filteredAccounts();
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    if (!ui.query) return document.querySelector('.account-main')?.focus();
    ui.selected = Math.max(0, Math.min(matches.length - 1, ui.selected + (event.key === 'ArrowDown' ? 1 : -1)));
    renderList();
  } else if (event.key === 'Enter' && matches[ui.selected]) {
    event.preventDefault();
    switchTo(matches[ui.selected]);
  } else if (event.key === 'Escape' && ui.query) {
    event.preventDefault();
    event.stopPropagation();
    setQuery('');
  }
}

/** Arrow keys move between account rows. */
function onRowKey(event) {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  event.preventDefault();
  const rows = [...document.querySelectorAll('.account-main')];
  const i = rows.indexOf(event.currentTarget) + (event.key === 'ArrowDown' ? 1 : -1);
  if (i < 0) document.getElementById('search')?.focus();
  else rows[Math.min(i, rows.length - 1)]?.focus();
}

function grantAccess() {
  chrome.permissions.request({ origins: [state.tab.pattern] }).then(
    (granted) => (granted ? refresh() : toast(`Access to ${state.tab.site} wasn't granted.`, { type: 'error' })),
    (error) => toast(error.message, { type: 'error' }),
  );
}

// ---------------------------------------------------------------------------
// Switching

/** `resolution` answers the "is this still X?" question: 'update' or 'skip'. */
function switchTo(account, resolution) {
  if (ui.busyId) return;
  if (account.id === state.activeId && !resolution) {
    if (isRejected(account)) return askReplace(account);
    return sessionDrifted() ? openDecision({ kind: 'restore' }) : toast(`${account.name} is already active.`);
  }
  ui.busyId = account.id;
  const pending = runSiteAction({ kind: 'switch', accountId: account.id, resolution });
  const started = performance.now();
  showSwitching(account);
  pending.then(async (response) => {
    ui.busyId = null;
    if (response.code === 'session-mismatch') {
      undoSwitching();
      return openDecision({ kind: 'switch', accountId: account.id }, response.details);
    }
    if (!response.ok) {
      undoSwitching();
      return handleError(response);
    }
    // The page is reloading and the badge shows the new account, so get out of the way.
    if (!response.warnings?.length && !pinnedTab) {
      await sleep(SWITCH_MIN_MS - (performance.now() - started));
      return window.close();
    }
    await refresh();
    toast(response.warnings?.length ? `Switched to ${account.name}, with warnings` : `Switched to ${account.name}`, {
      type: response.warnings?.length ? 'warn' : 'ok',
      details: response.warnings || [],
    });
  });
}

/** The pill flows to the new row (spinner while it loads), the wash and the hat take its colour. */
function showSwitching(account) {
  const row = document.querySelector(`.account[data-row="${account.id}"]`);
  if (!row) return;
  for (const other of document.querySelectorAll('.account')) other.classList.toggle('is-active', other === row);
  row.querySelector('.state')?.replaceChildren(spinner());
  placePill(row, true);
  setMark(account.color, { swap: true });
}

/** A switch that didn't happen: everything flows back to the account that's still active. */
function undoSwitching() {
  for (const row of document.querySelectorAll('.account')) {
    row.classList.toggle('is-active', row.dataset.row === state.activeId);
    row.querySelector('.state')?.replaceChildren(icon('check', 'check'));
  }
  placePill(document.querySelector('.account.is-active'), true);
  setMark(activeAccount()?.color);
}

function newAccount() {
  if (state.activeId) return runNewAccount();
  // Nothing saved to fall back on: make sure the user means it.
  ui.confirm = {
    title: 'Clear This Login?',
    body: `It isn't saved in Hatswap, so clearing it signs ${state.tab.site} out in this browser for good.`,
    confirmLabel: 'Clear Login',
    danger: true,
    onConfirm: runNewAccount,
  };
  render();
}

function runNewAccount(resolution) {
  const site = state.tab.site;
  runSiteAction({ kind: 'newLogin', resolution }).then(async (response) => {
    ui.confirm = null;
    if (response.code === 'session-mismatch') return openDecision({ kind: 'newLogin' }, response.details);
    if (!response.ok) {
      render();
      return handleError(response);
    }
    await refresh();
    setMark(null, { swap: true });
    toast(`Signed out of ${site} here. Sign in, then save the account.`, {
      type: response.warnings?.length ? 'warn' : 'ok',
      details: response.warnings || [],
    });
  });
}

// ---------------------------------------------------------------------------
// Save / edit sheet

/** `then` is what to do after a successful save: { kind: 'switch', accountId } or { kind: 'newLogin' }. */
function openForm(mode, account, then = null) {
  const count = state.accounts?.length || 0;
  ui.form = mode === 'edit'
    ? { mode, id: account.id, name: account.name, group: account.group, color: account.color }
    : { mode, name: `Account ${count + 1}`, group: '', color: COLORS[count % COLORS.length].hex, then };
  ui.sheet = 'form';
  ui.decision = null;
  render();
}

function saveFormNote(active) {
  if (!active) return null;
  if (sessionDrifted() && !state.sessionCheck.signedOut) {
    return h('p', { class: 'note calm' }, `This isn't “${active.name}” anymore, so saving it as a new account is right.`);
  }
  if (state.sessionCheck?.status === 'match') {
    return h('p', { class: 'note' }, `This is the same login as “${active.name}”. Saving it twice breaks both copies. To add someone else, cancel and use New Account first.`);
  }
  return h('p', { class: 'note' }, `Last switched to “${active.name}”. To add someone else, cancel and use New Account first.`);
}

function formSheet() {
  const f = ui.form;
  const editing = f.mode === 'edit';
  const account = editing ? state.accounts?.find((a) => a.id === f.id) : null;

  const preview = h('span', { class: 'avatar', style: `--c:${f.color};--fg:${textColorOn(f.color)}` }, initials(f.name));
  const updatePreview = (form) => {
    const color = new FormData(form).get('color') || f.color;
    preview.textContent = initials(form.elements.name.value || '?');
    preview.style.setProperty('--c', color);
    preview.style.setProperty('--fg', textColorOn(color));
  };

  const form = h('form', { class: 'screen', onsubmit: submitForm },
    navbar({
      leading: h('button', { class: 'text-btn', type: 'button', onclick: closeSheet }, 'Cancel'),
      title: editing ? 'Edit Account' : 'Save Account',
      trailing: h('button', { class: 'text-btn bold', type: 'submit' }, editing ? 'Done' : 'Save'),
    }),
    h('div', { class: 'scroll' },
      h('div', { class: 'preview' }, preview),
      editing ? null : saveFormNote(activeAccount()),
      section({
        footer: editing ? `${account.site} · saved ${timeAgo(account.updatedAt)}` : `Saves the login that's open on ${state.tab.site} right now.`,
        children: group(
          inputCell('Name', { type: 'text', name: 'name', value: f.name, maxlength: 60, required: true, placeholder: 'Required', 'data-autofocus': true, oninput: (e) => updatePreview(e.target.form) }),
          inputCell('Client', { type: 'text', name: 'group', value: f.group, maxlength: 40, list: 'group-options', placeholder: 'e.g. Fjord & Pine' })),
      }),
      h('datalist', { id: 'group-options' }, (state.groups || []).map((g) => h('option', { value: g }))),
      section({
        header: 'Color',
        children: group(h('fieldset', { class: 'swatches', style: 'border:0;margin:0', 'aria-label': 'Color' }, COLORS.map((c) =>
          h('label', { class: 'swatch', title: c.name, style: `--c:${c.hex}` },
            h('input', {
              type: 'radio',
              name: 'color',
              value: c.hex,
              checked: c.hex === f.color,
              'aria-label': c.name,
              onchange: (e) => {
                updatePreview(e.target.form);
                preview.classList.remove('bump');
                void preview.offsetWidth;
                preview.classList.add('bump');
              },
            }),
            h('span', { 'aria-hidden': 'true' }))))),
      }),
      editing ? [
        section({
          footer: 'Use this if you signed in to the account again without Hatswap.',
          children: group(cell({ class: 'tint', onclick: () => askReplace(account) }, h('span', { class: 'cell-title' }, 'Replace with Current Session'))),
        }),
        section({ children: group(cell({ class: 'destructive', onclick: () => askDelete(account) }, h('span', { class: 'cell-title' }, 'Delete Account'))) }),
      ] : null));
  form.elements.name.addEventListener('focus', (e) => e.target.select(), { once: true });
  return form;
}

function submitForm(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  const meta = { name: data.get('name'), group: data.get('group'), color: data.get('color') };
  const button = form.querySelector('[type=submit]');

  if (ui.form.mode === 'edit') {
    send({ type: 'updateAccount', id: ui.form.id, meta }).then(async (response) => {
      if (!response.ok) return handleError(response);
      ui.sheet = null;
      ui.form = null;
      await refresh();
      toast(`Saved “${response.account.name}”`);
    });
    return;
  }

  // Saving may trigger Chrome's permission prompt, so this must stay synchronous up to here.
  const pending = runSiteAction({ kind: 'save', meta });
  const then = ui.form.then;
  setBusy(button, true);
  pending.then(async (response) => {
    setBusy(button, false);
    if (!response.ok) return handleError(response);
    ui.sheet = null;
    ui.form = null;
    await refresh();
    toast(`Saved “${response.account.name}”`, { type: response.warnings?.length ? 'warn' : 'ok', details: response.warnings || [] });
    // Saved while answering "is this still X?": carry on with what the user was doing.
    const target = then?.kind === 'switch' && state.accounts.find((a) => a.id === then.accountId);
    if (target) switchTo(target);
    else if (then?.kind === 'newLogin') runNewAccount();
  });
}

function askReplace(account) {
  ui.confirm = {
    title: `Replace “${account.name}”?`,
    body: `Its saved session becomes the login that's open on ${state.tab.site} now.`,
    confirmLabel: 'Replace Session',
    onConfirm: () => runSiteAction({ kind: 'refresh', accountId: account.id }).then(async (response) => {
      ui.confirm = null;
      if (!response.ok) {
        render();
        return handleError(response);
      }
      ui.sheet = null;
      ui.form = null;
      await refresh();
      toast(`Updated “${account.name}”`, { type: response.warnings?.length ? 'warn' : 'ok', details: response.warnings || [] });
    }),
  };
  render();
}

function askDelete(account) {
  ui.confirm = {
    title: `Delete “${account.name}”?`,
    body: "Its saved session is removed from Hatswap. The site isn't touched.",
    confirmLabel: 'Delete Account',
    danger: true,
    onConfirm: async () => {
      const response = await send({ type: 'deleteAccount', id: account.id });
      ui.confirm = null;
      if (!response.ok) {
        render();
        return handleError(response);
      }
      ui.sheet = null;
      ui.form = null;
      await refresh();
      toast(`Deleted “${account.name}”`);
    },
  };
  render();
}

// ---------------------------------------------------------------------------
// "Is this still X?"

/**
 * Shown when the live session no longer looks like the active account, before
 * Hatswap would save over it. `context.kind` is what the user was doing:
 * 'switch' (to context.accountId), 'newLogin', or 'restore' (the notice, or a
 * click on the active account).
 */
function openDecision(context, details) {
  const active = activeAccount();
  ui.decision = {
    context,
    details: details || { accountId: active?.id, accountName: active?.name, names: state.sessionCheck?.names || [], signedOut: state.sessionCheck?.signedOut },
  };
  ui.sheet = 'decision';
  ui.form = null;
  render();
}

function decisionSheet({ context, details }) {
  const name = details.accountName;
  const site = state.tab.site;
  const active = state.accounts.find((a) => a.id === details.accountId) || activeAccount();
  const target = context.kind === 'switch' ? state.accounts.find((a) => a.id === context.accountId) : null;
  const names = details.names?.length ? ` (${details.names.slice(0, 3).join(', ')}${details.names.length > 3 ? ', …' : ''})` : '';

  /** Leaves the sheet, then acts, so a switch animates on the list behind it. */
  const choice = ({ iconName, title, sub, primary = false, onPick }) => cell({
    class: cls(primary && 'primary'),
    'data-autofocus': primary || null,
    onclick: () => {
      ui.sheet = null;
      ui.decision = null;
      render();
      onPick();
    },
  }, icon(iconName), h('span', { class: 'cell-title' }, h('strong', null, title), sub ? h('small', null, sub) : null));
  const saveAsNew = (then, sub) => cell({ class: 'primary', 'data-autofocus': true, onclick: () => openForm('save', null, then) },
    icon('plus'), h('span', { class: 'cell-title' }, h('strong', null, 'Save It as a New Account'), h('small', null, sub)));
  const keep = () => runSiteAction({ kind: 'keep' }).then(async (response) => {
    if (!response.ok) return handleError(response);
    await refresh();
    toast(`Updated “${name}”`);
  });

  let choices;
  if (context.kind === 'switch') {
    choices = details.signedOut
      ? [choice({ iconName: 'arrow', title: `Switch to “${target.name}”`, primary: true, onPick: () => switchTo(target, 'skip') })]
      : [saveAsNew({ kind: 'switch', accountId: target.id }, `Then switch to “${target.name}”`),
        choice({ iconName: 'check', title: `It's Still “${name}”`, sub: 'Save it and switch', onPick: () => switchTo(target, 'update') }),
        choice({ iconName: 'arrow', title: 'Switch Without Saving It', sub: `“${name}” stays as it was saved`, onPick: () => switchTo(target, 'skip') })];
  } else if (context.kind === 'newLogin') {
    choices = details.signedOut
      ? [choice({ iconName: 'arrow', title: 'Continue Without Saving', primary: true, onPick: () => runNewAccount('skip') })]
      : [saveAsNew({ kind: 'newLogin' }, 'Then start a new login'),
        choice({ iconName: 'check', title: `It's Still “${name}”`, sub: 'Save it, then start a new login', onPick: () => runNewAccount('update') }),
        choice({ iconName: 'arrow', title: "Don't Save It", sub: 'Just start a new login', onPick: () => runNewAccount('skip') })];
  } else {
    choices = details.signedOut
      ? [choice({ iconName: 'refresh', title: `Restore “${name}”`, sub: 'Sign back in with the saved session', primary: true, onPick: () => switchTo(active, 'skip') })]
      : [saveAsNew(null, 'Keep this login as its own account'),
        choice({ iconName: 'check', title: `It's Still “${name}”`, sub: `Update “${name}” with it`, onPick: keep }),
        choice({ iconName: 'refresh', title: `Restore Saved “${name}”`, sub: 'Swap this login for the saved one', onPick: () => switchTo(active, 'skip') })];
  }

  return screen({
    nav: navbar({ leading: h('button', { class: 'text-btn', type: 'button', onclick: closeSheet }, 'Cancel'), title: 'Check Login' }),
    body: [
      h('div', { class: 'question' },
        h('div', { class: 'glyph warn' }, icon('alert')),
        h('h1', { class: 'title' }, details.signedOut ? `Signed Out of ${site}` : `Is This Still “${name}”?`),
        h('p', null, details.signedOut
          ? `None of “${name}”'s login cookies are here, so there's nothing to save. “${name}” is still saved.`
          : `Its login cookies changed${names}, so someone may have signed in by hand. Hatswap didn't save over it.`)),
      section({ children: h('div', { class: 'group choices' }, choices) }),
    ],
  });
}

// ---------------------------------------------------------------------------
// Settings

function askEraseAll(fromLock) {
  ui.confirm = {
    title: 'Erase Everything?',
    body: fromLock
      ? "Without the password the saved logins can't be opened. Erasing lets you start over. Sites stay signed in as they are now."
      : 'Deletes every saved account, your settings and the site access you granted. Sites stay signed in as they are now.',
    confirmLabel: 'Erase Everything',
    danger: true,
    onConfirm: async () => {
      const response = await send({ type: 'reset' });
      ui.confirm = null;
      ui.view = 'main';
      ui.setupStep = 'welcome';
      if (!response.ok) {
        render();
        return handleError(response);
      }
      await refresh();
      toast('Hatswap was erased');
    },
  };
  render();
}

function settingsScreen() {
  const s = state.settings;
  const total = state.sites?.reduce((sum, site) => sum + site.count, 0) || 0;
  const save = (patch) => send({ type: 'saveSettings', settings: patch }).then((response) => {
    if (!response.ok) return handleError(response);
    state.settings = response.settings;
  });
  const autoLock = autoLockMenu('autoLock', s.autoLockMinutes);
  autoLock.addEventListener('change', () => save({ autoLockMinutes: Number(autoLock.value) }));
  const shortcutRow = (label, name) => cell({}, h('span', { class: 'cell-title' }, label),
    state.shortcuts[name] ? h('kbd', null, state.shortcuts[name]) : h('span', { class: 'unset' }, 'Not Set'));
  const segment = (value, label) => h('label', null,
    h('input', { type: 'radio', name: 'afterSwitch', value, checked: s.afterSwitch === value, onchange: () => save({ afterSwitch: value }) }), label);

  return screen({
    nav: navbar({ leading: backButton(state.tab.supported ? 'Accounts' : 'Back', () => goTo('main')), title: 'Settings' }),
    body: [
      section({
        header: 'Switching',
        footer: 'Auto-save keeps refreshed login tokens. Turn it off if you often sign in and out by hand.',
        children: group(
          h('label', { class: 'cell', for: 'autoSave' },
            h('span', { class: 'cell-title' }, 'Auto-Save Before Switching'),
            h('input', { type: 'checkbox', class: 'switch', id: 'autoSave', checked: s.autoSave, onchange: (e) => save({ autoSave: e.target.checked }) })),
          cell({}, h('span', { class: 'cell-title' }, 'After Switching'),
            h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'After switching' }, h('span', { class: 'thumb' }), segment('lastPage', 'Last Page'), segment('reload', 'Reload')))),
      }),
      section({
        header: 'Security',
        children: group(
          cell({}, h('label', { class: 'cell-title', for: 'autoLock' }, 'Auto-Lock'), autoLock),
          cell({ onclick: () => goTo('password') }, h('span', { class: 'cell-title' }, 'Change Master Password'), icon('chevron-right', 'chev'))),
      }),
      section({
        header: 'Keyboard',
        footer: `In this popup: ${MOD}, opens Settings, ${MOD}F searches, ${MOD}L locks, ↑ ↓ and Return switch.`,
        children: group(
          shortcutRow('Next Account', 'switch-next'),
          shortcutRow('Previous Account', 'switch-previous'),
          shortcutRow('Open Hatswap', '_execute_action'),
          cell({ class: 'tint', onclick: () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }) }, h('span', { class: 'cell-title' }, 'Customize Shortcuts…'))),
      }),
      section({
        header: 'Data',
        footer: `Hatswap ${state.version}. Everything is stored on ${HERE} and never goes online.`,
        children: group(
          cell({}, h('span', { class: 'cell-title' }, 'Saved Accounts'), h('span', { class: 'cell-value' }, `${total} on ${plural(state.sites?.length || 0, 'site')}`)),
          cell({}, h('span', { class: 'cell-title' }, 'Storage'), h('span', { class: 'cell-value' }, `${formatBytes(state.bytesInUse || 0)} of ${formatBytes(STORAGE_QUOTA)}`)),
          cell({ onclick: openBackupPage }, h('span', { class: 'cell-title' }, 'Backup & Restore'), icon('chevron-right', 'chev')),
          cell({ class: 'destructive', onclick: () => askEraseAll(false) }, h('span', { class: 'cell-title' }, 'Erase All Data…'))),
      }),
    ],
  });
}

function passwordScreen() {
  const submit = async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const error = form.querySelector('#password-error');
    const fail = (message) => { error.textContent = message; error.hidden = false; };
    error.hidden = true;
    if (data.get('next') !== data.get('confirm')) return fail("The new passwords don't match.");
    const button = form.querySelector('[type=submit]');
    setBusy(button, true);
    const response = await send({ type: 'changePassword', current: data.get('current'), next: data.get('next') });
    setBusy(button, false);
    if (!response.ok) return fail(response.error);
    await goTo('settings');
    toast('Password changed. All sessions re-encrypted.');
  };
  return screen({
    as: 'form',
    props: { onsubmit: submit },
    nav: navbar({
      leading: backButton('Settings', () => goTo('settings')),
      title: 'Master Password',
      trailing: h('button', { class: 'text-btn bold', type: 'submit', id: 'password-save' }, 'Change'),
    }),
    body: [
      section({ children: group(inputCell('Current', { type: 'password', name: 'current', placeholder: 'Required', autocomplete: 'current-password', required: true, 'data-autofocus': true })) }),
      section({
        footer: 'Every saved login is re-encrypted with the new password.',
        children: group(
          inputCell('New', { type: 'password', name: 'next', placeholder: 'At least 8 characters', autocomplete: 'new-password', minlength: 8, required: true }),
          inputCell('Repeat', { type: 'password', name: 'confirm', placeholder: 'Required', autocomplete: 'new-password', required: true })),
      }),
      h('p', { class: 'section-footer error', id: 'password-error', hidden: true }),
    ],
  });
}

// ---------------------------------------------------------------------------
// Keyboard: Mac conventions inside the popup

document.addEventListener('keydown', (event) => {
  const mod = isMac ? event.metaKey : event.ctrlKey;
  if (event.key === 'Escape') {
    if (ui.confirm) (ui.confirm.onCancel || cancelConfirm)();
    else if (ui.sheet) closeSheet();
    else if (ui.view === 'password') goTo('settings');
    else if (ui.view !== 'main') goTo('main');
    else return;
    event.preventDefault();
    return;
  }
  if (state?.status !== 'unlocked' || ui.confirm) return;
  const key = event.key.toLowerCase();
  if (mod && key === ',') {
    event.preventDefault();
    goTo(ui.view === 'main' ? 'settings' : 'main');
  } else if (mod && key === 'l') {
    event.preventDefault();
    lockNow();
  } else if (mod && key === 'f') {
    event.preventDefault();
    document.getElementById('search')?.focus();
  } else if (!ui.sheet && !event.metaKey && !event.ctrlKey && !event.altKey) {
    // Typing anywhere in the account list goes to the search field.
    const search = document.getElementById('search');
    if (!search || document.activeElement === search) return;
    if (event.key === '/' || (event.key.length === 1 && /\S/.test(event.key) && document.activeElement?.tagName !== 'INPUT')) {
      search.focus();
      if (event.key === '/') event.preventDefault();
    }
  }
});

// ---------------------------------------------------------------------------

tabId = pinnedTab
  ? Number(params.get('tabId'))
  : (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
await refresh();
// Row heights settle once the bundled font is in; keep the pill aligned.
document.fonts.ready.then(() => placePill(document.querySelector('.account.is-active')));
