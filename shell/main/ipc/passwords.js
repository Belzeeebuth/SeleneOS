'use strict';
// Passwords backend: stores the encrypted vault of the Passwords app (renderer/apps/passwords).
// This file only ever sees the encrypted blob: encryption and decryption happen in the renderer with WebCrypto
// (AES-GCM 256, key from the master password through PBKDF2-SHA256). It never logs or inspects the contents.
//
// File: ${XDG_DATA_HOME:-~/.local/share}/aurora/passwords.vault  (mode 0600, folder 0700)
//   JSON text: { "format": "aurora-vault", "version": 1, "kdf": {…}, "cipher": {…}, "data": "<base64>" }
// Every write goes to a temporary 0600 file in the same folder, is fsync'ed and renamed over the vault (atomic on
// POSIX), and writes are serialized.
//
// Channels:
//   passwords:status ()      -> { exists, path, size, mtime }
//   passwords:read ()        -> string (the blob) | null when there is no vault yet
//   passwords:write (blob)   -> { mtime }   rejects EINVAL for anything that is not a well-formed encrypted vault
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const MAX_BLOB = 64 * 1024 * 1024;

function vaultFile() {
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'aurora', 'passwords.vault');
}

function err(message, code) {
  const e = new Error(message);
  e.code = code;
  return e;
}

// Structure check only (header fields present and of the right type); the payload stays opaque.
function validBlob(text) {
  if (typeof text !== 'string' || !text || text.length > MAX_BLOB) return false;
  let v;
  try {
    v = JSON.parse(text);
  } catch {
    return false;
  }
  const b64 = (s) => typeof s === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(s);
  return (
    !!v && v.format === 'aurora-vault' && Number.isInteger(v.version) && v.version >= 1 &&
    !!v.kdf && typeof v.kdf.name === 'string' && Number.isInteger(v.kdf.iterations) && b64(v.kdf.salt) &&
    !!v.cipher && typeof v.cipher.name === 'string' && b64(v.cipher.iv) && b64(v.data)
  );
}

let queue = Promise.resolve();
function serialize(fn) {
  const next = queue.catch(() => {}).then(fn);
  queue = next.catch(() => {});
  return next;
}

async function atomicWrite(file, data) {
  const dir = path.dirname(file);
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  const fh = await fsp.open(tmp, 'wx', 0o600);
  try {
    await fh.writeFile(data, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await fsp.chmod(tmp, 0o600);
    await fsp.rename(tmp, file);
  } catch (e) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
  try {
    const d = await fsp.open(dir, 'r');
    try {
      await d.sync();
    } finally {
      await d.close();
    }
  } catch {}
}

module.exports = function register(api) {
  api.handle('passwords:status', async () => {
    const file = vaultFile();
    const st = await fsp.stat(file).catch(() => null);
    return { exists: !!st && st.isFile(), path: file, size: st ? st.size : 0, mtime: st ? st.mtimeMs : 0 };
  });

  api.handle('passwords:read', async () => {
    const file = vaultFile();
    const st = await fsp.lstat(file).catch(() => null);
    if (!st) return null;
    if (!st.isFile()) throw err('The vault is not a regular file', 'EACCES');
    if (st.size > MAX_BLOB) throw err('The vault is too large', 'ETOOBIG');
    // Tighten permissions of a vault copied in with a looser mode.
    if ((st.mode & 0o077) !== 0) await fsp.chmod(file, 0o600).catch(() => {});
    return fsp.readFile(file, 'utf8');
  });

  api.handle('passwords:write', (blob) =>
    serialize(async () => {
      if (!validBlob(blob)) throw err('Not an encrypted vault', 'EINVAL');
      const file = vaultFile();
      const st = await fsp.lstat(file).catch(() => null);
      if (st && !st.isFile()) throw err('The vault is not a regular file', 'EACCES');
      await atomicWrite(file, blob);
      const after = fs.statSync(file);
      return { mtime: after.mtimeMs };
    }),
  );
};

module.exports.validBlob = validBlob;
module.exports.vaultFile = vaultFile;
