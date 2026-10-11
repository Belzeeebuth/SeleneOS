'use strict';
// PDF Reader backend: crash-safe saving.
//   pdf:save (path, bytes) -> { path, size, mtime }
// The new bytes go to a temporary file next to the target, are flushed to disk, then renamed over the
// target. A failed save (disk full, I/O error, power loss) never leaves a truncated PDF behind: the original
// file stays as it was. Symbolic links are followed (the file they point to is replaced, not the link) and
// the original file's permissions are kept.
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const MAX_BYTES = 2 * 1024 * 1024 * 1024;

function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return null;
}

module.exports = function register(api) {
  api.handle('pdf:save', async (target, data) => {
    if (typeof target !== 'string' || !path.isAbsolute(target) || target.includes('\0') || !path.basename(target)) {
      throw api.error('Invalid file path', 'EINVAL');
    }
    const buf = toBuffer(data);
    if (!buf || buf.length < 8 || buf.length > MAX_BYTES) throw api.error('Invalid document data', 'EINVAL');
    // Only PDF documents go through here (the header may follow a little junk, as readers allow).
    if (buf.subarray(0, 1024).indexOf('%PDF-') < 0) throw api.error('Not a PDF document', 'EINVAL');

    let real = path.normalize(target);
    let mode = 0o644;
    try {
      real = await fsp.realpath(target);
      const st = await fsp.stat(real);
      if (st.isDirectory()) throw api.error('A folder has this name', 'EISDIR');
      mode = st.mode & 0o7777;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err; // a new file (Save as)
    }
    const dir = path.dirname(real);
    const tmp = path.join(dir, `.${path.basename(real).slice(0, 200)}.${crypto.randomBytes(6).toString('hex')}.tmp`);
    let fh = null;
    try {
      fh = await fsp.open(tmp, 'wx', 0o600);
      await fh.writeFile(buf);
      await fh.chmod(mode);
      await fh.sync();
      await fh.close();
      fh = null;
      await fsp.rename(tmp, real);
    } catch (err) {
      try {
        await fh?.close();
      } catch {}
      await fsp.rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
    const st = await fsp.stat(real);
    return { path: target, size: st.size, mtime: st.mtimeMs };
  });
};
