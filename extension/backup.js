// Backup & Restore page. Talks to the service worker like the popup does; the
// file leaves the browser only as a download the user triggers, and comes back
// only through the file picker.

const $ = (id) => document.getElementById(id);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

async function send(message) {
  try {
    return (await chrome.runtime.sendMessage(message)) || { ok: false, error: 'Hatswap did not respond. Try again.' };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function show(el, { type = 'ok', title, lines = [], extra = null }) {
  el.className = `result ${type}`;
  el.replaceChildren();
  el.append(Object.assign(document.createElement('strong'), { textContent: title }));
  if (lines.length) {
    const ul = document.createElement('ul');
    for (const line of lines) ul.append(Object.assign(document.createElement('li'), { textContent: line }));
    el.append(ul);
  }
  if (extra) el.append(extra);
  el.hidden = false;
}

function setBusy(button, busy, label) {
  if (busy) {
    button.dataset.idle = button.textContent;
    button.textContent = label;
  } else if (button.dataset.idle) {
    button.textContent = button.dataset.idle;
  }
  button.disabled = busy;
}

// ---------------------------------------------------------------------------
// State-dependent copy

async function refresh() {
  const state = await send({ type: 'getState' });
  const status = state.status || 'setup';
  const line = {
    setup: 'No vault on this computer yet. Restoring a backup creates one with the backup’s password.',
    locked: 'Hatswap is locked. Exporting works with your master password; restoring into your existing accounts needs an unlock.',
    unlocked: 'Hatswap is unlocked.',
  }[status];
  $('status-line').textContent = line;
  $('export-form').querySelectorAll('input, button').forEach((el) => { el.disabled = status === 'setup'; });
  $('export').querySelector('.hint').textContent = status === 'setup'
    ? 'Nothing to export yet: save an account first.'
    : 'Hatswap first saves the live session of each active account whose site is open in a tab, so the backup is current.';
  $('import-lede').textContent = status === 'setup'
    ? 'Pick a Hatswap backup file and enter the password it was made with. Your vault is created with that password.'
    : 'Pick a Hatswap backup file and enter the password it was made with. New accounts are added; ones you already have are updated if the backup is newer.';
  return state;
}

// ---------------------------------------------------------------------------
// Export

$('export-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $('export-btn');
  const result = $('export-result');
  result.hidden = true;
  setBusy(button, true, 'Encrypting…');
  const response = await send({ type: 'backupExport', password: form.elements.password.value });
  setBusy(button, false);
  if (!response.ok) return show(result, { type: 'error', title: response.error });

  const date = new Date().toISOString().slice(0, 10);
  const blob = new Blob([JSON.stringify(response.file)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: `hatswap-backup-${date}.json` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);

  form.reset();
  const lines = [...response.warnings, ...response.skipped.map((name) => `“${name}” couldn't be read and was left out.`)];
  show(result, {
    type: lines.length ? 'warn' : 'ok',
    title: `Backup saved with ${plural(response.count, 'account')}.`,
    lines,
  });
});

// ---------------------------------------------------------------------------
// Import

let fileText = null;

async function takeFile(file) {
  if (!file) return;
  fileText = await file.text();
  $('drop').classList.add('has-file');
  $('drop-text').textContent = file.name;
  $('import-btn').disabled = false;
  $('import-result').hidden = true;
}

$('file').addEventListener('change', (event) => takeFile(event.target.files[0]));
const drop = $('drop');
drop.addEventListener('dragover', (event) => { event.preventDefault(); drop.classList.add('is-over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
drop.addEventListener('drop', (event) => {
  event.preventDefault();
  drop.classList.remove('is-over');
  takeFile(event.dataTransfer.files[0]);
});

async function runImport(password) {
  const button = $('import-btn');
  const result = $('import-result');
  result.hidden = true;
  setBusy(button, true, 'Restoring…');
  const response = await send({ type: 'backupImport', text: fileText, password });
  setBusy(button, false);

  if (response.code === 'locked') {
    $('unlock-form').hidden = false;
    $('unlock-form').elements.password.focus();
    return;
  }
  if (!response.ok) return show(result, { type: 'error', title: response.error });

  $('unlock-form').hidden = true;
  const parts = [];
  if (response.added) parts.push(`${plural(response.added, 'account')} added`);
  if (response.updated) parts.push(`${plural(response.updated, 'account')} updated`);
  if (response.unchanged) parts.push(`${response.unchanged} already up to date`);
  if (response.invalid) parts.push(`${response.invalid} skipped (damaged)`);
  const lines = [];
  if (response.created) lines.push('Your vault was created with this password. It is your master password from now on.');
  const made = response.createdAt ? new Date(response.createdAt).toLocaleString() : null;
  if (made) lines.push(`Backup made ${made}.`);

  // Sites the backup covers that this browser hasn't granted access to yet.
  const missing = response.sites.filter((s) => !s.granted);
  let extra = null;
  if (missing.length) {
    extra = document.createElement('div');
    const note = Object.assign(document.createElement('p'), { className: 'sites', textContent: `Hatswap needs access to ${missing.map((s) => s.site).join(', ')} before it can switch there.` });
    const allow = Object.assign(document.createElement('button'), { className: 'btn large', type: 'button', textContent: `Allow access to ${plural(missing.length, 'site')}` });
    allow.addEventListener('click', () => {
      chrome.permissions.request({ origins: missing.map((s) => s.pattern) }).then((granted) => {
        note.textContent = granted ? 'Access granted. Open the Hatswap popup on a site and pick an account.' : 'Access wasn’t granted. The popup will ask again on each site.';
        allow.remove();
      });
    });
    extra.append(note, allow);
  }
  show(result, { title: parts.length ? `Restored: ${parts.join(', ')}.` : 'Nothing to restore: the backup has no accounts.', lines, extra });
  $('import-form').reset();
  fileText = null;
  $('drop').classList.remove('has-file');
  $('drop-text').textContent = 'Choose a file, or drop it here';
  $('import-btn').disabled = true;
  refresh();
}

$('import-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (!fileText) return;
  runImport(event.currentTarget.elements.password.value);
});

$('unlock-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const response = await send({ type: 'unlock', password: form.elements.password.value });
  if (!response.ok) return show($('import-result'), { type: 'error', title: response.error });
  form.hidden = true;
  form.reset();
  runImport($('import-form').elements.password.value);
});

document.documentElement.style.setProperty('--wash', 'var(--coral)');
refresh();
