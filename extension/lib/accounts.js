// Account metadata helpers shared by the service worker and the popup.

export const COLORS = [
  { name: 'Red', hex: '#E5484D' },
  { name: 'Orange', hex: '#EF6A1F' },
  { name: 'Amber', hex: '#D99A1E' },
  { name: 'Green', hex: '#2F9E64' },
  { name: 'Teal', hex: '#0F9A8C' },
  { name: 'Blue', hex: '#1F7AE0' },
  { name: 'Violet', hex: '#6E56CF' },
  { name: 'Pink', hex: '#D6409F' },
  { name: 'Slate', hex: '#5E6470' },
];

const HEX = /^#[0-9a-f]{6}$/i;

/** Colour for the n-th account on a site, so new accounts don't all look alike. */
export function defaultColor(n) {
  return COLORS[n % COLORS.length].hex;
}

/** Trims and bounds user input; falls back to sensible defaults. */
export function cleanMeta(meta = {}, fallbackName = 'Account') {
  const name = String(meta.name ?? '').trim().slice(0, 60) || fallbackName;
  const group = String(meta.group ?? '').trim().slice(0, 40);
  const color = HEX.test(meta.color || '') ? meta.color.toUpperCase() : COLORS[COLORS.length - 1].hex;
  return { name, group, color };
}

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

/** Display order (also the order the keyboard shortcut cycles through): by group, then name. Ungrouped last. */
export function sortAccounts(accounts) {
  return [...accounts].sort((a, b) => {
    if (!a.group !== !b.group) return a.group ? -1 : 1;
    return collator.compare(a.group, b.group) || collator.compare(a.name, b.name) || a.createdAt - b.createdAt;
  });
}

/** "Fjord & Pine" -> "FP", "Nordlys" -> "NO", "acme" -> "AC", "Ørsta (main)" -> "ØM". */
export function initials(name) {
  const words = String(name)
    .replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2')
    .match(/[\p{L}\p{N}]+/gu) || [];
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return (words[0] || '?').slice(0, 2).toUpperCase();
}

/** Black or white, whichever reads better on `hex`. */
export function textColorOn(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const luminance = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return luminance > 0.36 ? '#111318' : '#FFFFFF';
}

/** Key for the "active account" marker. Incognito has its own cookie jar, so it gets its own marker. */
export function siteKey(site, incognito) {
  return incognito ? `${site}#incognito` : site;
}
