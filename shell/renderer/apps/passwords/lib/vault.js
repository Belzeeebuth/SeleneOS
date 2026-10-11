// Vault crypto (WebCrypto only). The plaintext never leaves the renderer: the backend stores the blob below.
//   Blob (JSON text), version 1:
//   { format: 'aurora-vault', version: 1,
//     kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: 600000, salt: b64(16 bytes) },
//     cipher: { name: 'AES-GCM', bits: 256, iv: b64(12 bytes) },
//     data: b64(ciphertext + tag) }
//   The header (format, version, kdf, cipher name) is bound to the ciphertext as AES-GCM additional data, so editing
//   it makes decryption fail. A new random IV is drawn for every save; the salt is drawn once when the vault is created.
//   Future versions add a new `version` and keep a reader for the old ones (see openVault).
export const FORMAT = 'aurora-vault';
export const VERSION = 1;
export const ITERATIONS = 600000;
export const MAX_ITERATIONS = 10000000;

const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64(bytes) {
  let s = '';
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s);
}
export function unb64(s) {
  const bin = atob(s);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

function aad(header) {
  const k = header.kdf;
  return enc.encode(`${header.format}/${header.version}/${k.name}/${k.hash}/${k.iterations}/${k.salt}/${header.cipher.name}/${header.cipher.bits}`);
}

/** CryptoKey (non-extractable) for a master password and salt. */
export async function deriveKey(password, salt, iterations = ITERATIONS) {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** A new vault session: { key, header } with a fresh random salt. */
export async function createSession(password, iterations = ITERATIONS) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const header = {
    format: FORMAT,
    version: VERSION,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations, salt: b64(salt) },
    cipher: { name: 'AES-GCM', bits: 256 },
  };
  return { key: await deriveKey(password, salt, iterations), header };
}

/** Encrypts the plaintext model with a fresh IV -> blob text. */
export async function seal(session, model) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const { header, key } = session;
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(header), tagLength: 128 }, key, enc.encode(JSON.stringify(model)));
  return JSON.stringify({ ...header, cipher: { ...header.cipher, iv: b64(iv) }, data: b64(new Uint8Array(ct)) });
}

/** Parses the header of a blob; throws EFORMAT / ENEWER. */
export function parseBlob(text) {
  let v;
  try {
    v = JSON.parse(text);
  } catch {
    throw Object.assign(new Error('Damaged vault'), { code: 'EFORMAT' });
  }
  if (!v || v.format !== FORMAT || !Number.isInteger(v.version)) throw Object.assign(new Error('Damaged vault'), { code: 'EFORMAT' });
  if (v.version > VERSION) throw Object.assign(new Error('Vault from a newer version'), { code: 'ENEWER' });
  // Iterations are capped so a tampered header cannot freeze the window in PBKDF2; salt/iv/data must be base64.
  const b64ok = (x) => typeof x === 'string' && /^[A-Za-z0-9+/]*={0,2}$/.test(x) && x.length % 4 === 0;
  if (v.kdf?.name !== 'PBKDF2' || v.kdf?.hash !== 'SHA-256' || !Number.isInteger(v.kdf?.iterations) || v.kdf.iterations < 1 || v.kdf.iterations > MAX_ITERATIONS ||
      v.cipher?.name !== 'AES-GCM' || !b64ok(v.kdf.salt) || !b64ok(v.cipher.iv) || !b64ok(v.data)) {
    throw Object.assign(new Error('Damaged vault'), { code: 'EFORMAT' });
  }
  return v;
}

/** Opens a blob with the master password -> { session, model }; throws EBADPASS (wrong password or tampered). */
export async function openVault(text, password) {
  const v = parseBlob(text);
  const header = { format: v.format, version: v.version, kdf: { ...v.kdf }, cipher: { name: v.cipher.name, bits: v.cipher.bits } };
  delete header.cipher.iv;
  const key = await deriveKey(password, unb64(v.kdf.salt), v.kdf.iterations);
  let plain;
  try {
    plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(v.cipher.iv), additionalData: aad(header), tagLength: 128 }, key, unb64(v.data));
  } catch {
    throw Object.assign(new Error('Wrong master password'), { code: 'EBADPASS' });
  }
  let model;
  try {
    model = JSON.parse(dec.decode(plain));
  } catch {
    throw Object.assign(new Error('Damaged vault'), { code: 'EFORMAT' });
  }
  return { session: { key, header }, model: normalizeModel(model) };
}

export function newId() {
  const u = crypto.getRandomValues(new Uint8Array(9));
  return b64(u).replace(/\+/g, '-').replace(/\//g, '_');
}

const str = (v, max = 10000) => (typeof v === 'string' ? v.slice(0, max) : v == null ? '' : String(v).slice(0, max));
export function normalizeEntry(e) {
  const now = Date.now();
  return {
    id: typeof e?.id === 'string' && e.id ? e.id.slice(0, 64) : newId(),
    title: str(e?.title, 500),
    username: str(e?.username, 1000),
    password: str(e?.password, 4000),
    url: str(e?.url, 4000),
    notes: str(e?.notes, 100000),
    favorite: !!e?.favorite,
    created: Number.isFinite(e?.created) ? e.created : now,
    modified: Number.isFinite(e?.modified) ? e.modified : now,
  };
}
export function normalizeModel(m) {
  const entries = Array.isArray(m?.entries) ? m.entries.map(normalizeEntry) : [];
  return { entries };
}
