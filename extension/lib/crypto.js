// Web Crypto helpers: PBKDF2 key derivation and AES-GCM encryption of JSON values.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// OWASP's 2023 recommendation for PBKDF2-HMAC-SHA256. Stored per vault, so it can
// be raised later without breaking existing vaults.
export const PBKDF2_ITERATIONS = 600_000;

export function randomBytes(length) {
  return crypto.getRandomValues(new Uint8Array(length));
}

export function toBase64(bytes) {
  bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  // Chunked so large payloads don't blow the argument limit of fromCharCode.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function fromBase64(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Derives the AES-256-GCM vault key from the master password. The key is
 * extractable only so it can be parked in chrome.storage.session (memory only)
 * while the vault is unlocked; it never touches disk.
 */
export async function deriveKey(password, salt, iterations = PBKDF2_ITERATIONS) {
  const material = await crypto.subtle.importKey('raw', encoder.encode(password.normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    material,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  );
}

export async function exportKey(key) {
  return toBase64(await crypto.subtle.exportKey('raw', key));
}

export function importKey(base64) {
  return crypto.subtle.importKey('raw', fromBase64(base64), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/**
 * Encrypts a JSON-serialisable value. `context` is bound in as additional
 * authenticated data, so a blob copied onto another record fails to decrypt.
 */
export async function encryptJSON(key, value, context = '') {
  const iv = randomBytes(12);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(context) },
    key,
    encoder.encode(JSON.stringify(value)),
  );
  return { iv: toBase64(iv), ct: toBase64(ciphertext) };
}

/** Throws if the key is wrong or the data was tampered with. */
export async function decryptJSON(key, box, context = '') {
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(box.iv), additionalData: encoder.encode(context) },
    key,
    fromBase64(box.ct),
  );
  return JSON.parse(decoder.decode(plaintext));
}
