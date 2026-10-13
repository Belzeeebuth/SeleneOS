'use strict';
// Print pipeline: the app side of the Selene print dialog (renderer/core/print.js).
// The dialog turns what an app shows into a PDF, previews it, then hands the file to the printing
// backend ('printers:print', main/ipc/printers.js) or copies it where the user chose (« Enregistrer en PDF »).
//
//   print:render ({ html, pageSize, landscape, pageRanges, margins }) -> { path, size }
//       html is a whole document built by the app (text already escaped). It is rendered in a hidden,
//       sandboxed window with JavaScript off, then webContents.printToPDF. Fonts and pictures can use
//       app://shell/… and media://local/… URLs.
//   print:store (bytes) -> { path, size }             PDF bytes made in the renderer (a <webview>'s printToPDF)
//   print:extract (src, ranges) -> { path, size }     only the chosen pages of a PDF ("1-3,5"; qpdf, else poppler)
//   print:read (path) -> Uint8Array                   a spooled PDF, for the preview
//   print:saveAs (path, dest) -> { path, size }       copies a spooled PDF to the user's file
//   print:discard (path)                               removes a spooled PDF
// Spooled files live in a private folder (0700) under the temporary directory; print:read / saveAs /
// discard only accept files from there. Every argument is checked; programs get argv arrays, never a shell.
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { run, which } = require('../lib/exec');

const MAX_HTML = 64 * 1024 * 1024;
const MAX_PDF = 1024 * 1024 * 1024;
const PAGE_SIZES = new Set(['A4', 'Letter', 'A3', 'A5', 'Legal']);

/** "1-3, 5" / "2-" -> "1-3,5" (validated, spaces removed). Throws on anything else. */
function normalizeRanges(s) {
  if (s == null || s === '') return '';
  if (typeof s !== 'string' || s.length > 200) throw new Error('Invalid page range');
  const parts = s
    .replace(/[–—]/g, '-')
    .split(/[,;]/)
    .map((p) => p.replace(/\s+/g, ''))
    .filter(Boolean);
  if (!parts.length) throw new Error('Invalid page range');
  for (const p of parts) {
    const m = /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(p);
    if (!m || Number(m[1]) < 1 || (m[2] && Number(m[2]) < Number(m[1]))) throw new Error('Invalid page range');
  }
  return parts.join(',');
}

function spoolDir() {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'u';
  const dir = path.join(os.tmpdir(), `aurora-print-${uid}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink() || (typeof process.getuid === 'function' && st.uid !== process.getuid())) {
    throw Object.assign(new Error('Print spool folder is not safe'), { code: 'EPERM' });
  }
  fs.chmodSync(dir, 0o700);
  return dir;
}

function spoolPath(ext = '.pdf') {
  return path.join(spoolDir(), `job-${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}${ext}`);
}

function isSpooled(p) {
  if (typeof p !== 'string' || !path.isAbsolute(p) || p.includes('\0')) return false;
  const dir = spoolDir();
  const n = path.normalize(p);
  return path.dirname(n) === dir && /^job-[a-z0-9]+-[0-9a-f]{12}\.pdf$/.test(path.basename(n));
}

function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return null;
}

async function writeSpool(buf) {
  const p = spoolPath();
  await fsp.writeFile(p, buf, { mode: 0o600, flag: 'wx' });
  return { path: p, size: buf.length };
}

async function have(cmd) {
  return !!which(cmd);
}

/** Copy only the pages in `ranges` ("1-3,5") of `src` into a new spooled PDF. */
async function extractPages(src, ranges, maxPages) {
  const out = spoolPath();
  if (await have('qpdf')) {
    // qpdf reads "1-3,5"; an open range "5-" is written "5-z" (z = last page).
    const q = ranges.replace(/-(?=,|$)/g, '-z');
    await run('qpdf', ['--empty', '--pages', src, q, '--', out], { timeout: 120000, check: true });
    return out;
  }
  // poppler-utils fallback: one file per page, then joined in order.
  const tmp = fs.mkdtempSync(path.join(spoolDir(), 'x-'));
  try {
    const pages = [];
    for (const part of ranges.split(',')) {
      const [a, b] = part.split('-');
      const from = Number(a);
      const to = b === undefined ? from : b === '' ? maxPages || from : Number(b);
      for (let i = from; i <= to; i++) pages.push(i);
    }
    if (!pages.length || pages.length > 5000) throw new Error('Invalid page range');
    const files = [];
    for (const [i, pg] of pages.entries()) {
      const f = path.join(tmp, `p${String(i).padStart(5, '0')}.pdf`);
      await run('pdfseparate', ['-f', String(pg), '-l', String(pg), src, f], { timeout: 60000, check: true });
      files.push(f);
    }
    await run('pdfunite', [...files, out], { timeout: 120000, check: true });
    return out;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function register(api) {
  const { BrowserWindow } = require('electron');

  api.handle('print:render', async (opts = {}) => {
    const html = opts?.html;
    if (typeof html !== 'string' || !html || html.length > MAX_HTML) throw api.error('Invalid document', 'EINVAL');
    const pageSize = PAGE_SIZES.has(opts.pageSize) ? opts.pageSize : 'A4';
    let pageRanges = '';
    try {
      pageRanges = normalizeRanges(opts.pageRanges || '');
    } catch (err) {
      throw api.error(err.message, 'EINVAL');
    }
    const margin = Number.isFinite(opts.margin) ? Math.min(2, Math.max(0, opts.margin)) : 0.6; // inches
    const htmlFile = spoolPath('.html');
    await fsp.writeFile(htmlFile, html, { mode: 0o600, flag: 'wx' });
    const win = new BrowserWindow({
      show: false,
      width: 900,
      height: 1200,
      webPreferences: { javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false, webSecurity: true },
    });
    const wc = win.webContents;
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('will-navigate', (e) => e.preventDefault());
    try {
      await win.loadFile(htmlFile);
      // Web fonts and pictures: give them a moment (JavaScript is off, so document.fonts can't be awaited).
      await new Promise((r) => setTimeout(r, 150));
      let data;
      try {
        data = await wc.printToPDF({
          landscape: !!opts.landscape,
          pageSize,
          printBackground: true,
          pageRanges,
          margins: { top: margin, bottom: margin, left: margin, right: margin },
        });
      } catch (err) {
        // A range past the last page: Chromium refuses the whole job.
        if (pageRanges) throw api.error('The pages chosen are not in the document', 'ERANGE');
        throw err;
      }
      return await writeSpool(Buffer.from(data));
    } finally {
      if (!win.isDestroyed()) win.destroy();
      fsp.rm(htmlFile, { force: true }).catch(() => {});
    }
  });

  api.handle('print:store', async (data) => {
    const buf = toBuffer(data);
    if (!buf || buf.length < 8 || buf.length > MAX_PDF || buf.subarray(0, 1024).indexOf('%PDF-') < 0) throw api.error('Not a PDF document', 'EINVAL');
    return writeSpool(buf);
  });

  api.handle('print:extract', async (src, ranges, maxPages) => {
    if (typeof src !== 'string' || !path.isAbsolute(src) || src.includes('\0')) throw api.error('Invalid file path', 'EINVAL');
    let r;
    try {
      r = normalizeRanges(ranges);
    } catch (err) {
      throw api.error(err.message, 'EINVAL');
    }
    if (!r) throw api.error('Invalid page range', 'EINVAL');
    const st = await fsp.stat(src);
    if (!st.isFile()) throw api.error('Not a file', 'EINVAL');
    const out = await extractPages(src, r, Number.isInteger(maxPages) && maxPages > 0 ? maxPages : 0);
    return { path: out, size: (await fsp.stat(out)).size };
  });

  api.handle('print:read', async (p) => {
    if (!isSpooled(p)) throw api.error('Not a print file', 'EINVAL');
    return new Uint8Array(await fsp.readFile(p));
  });

  api.handle('print:saveAs', async (p, dest) => {
    if (!isSpooled(p)) throw api.error('Not a print file', 'EINVAL');
    if (typeof dest !== 'string' || !path.isAbsolute(dest) || dest.includes('\0') || !path.basename(dest)) throw api.error('Invalid file path', 'EINVAL');
    const tmp = path.join(path.dirname(dest), `.${path.basename(dest).slice(0, 200)}.${crypto.randomBytes(6).toString('hex')}.tmp`);
    try {
      await fsp.copyFile(p, tmp);
      await fsp.chmod(tmp, 0o644);
      await fsp.rename(tmp, dest);
    } catch (err) {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
    return { path: dest, size: (await fsp.stat(dest)).size };
  });

  api.handle('print:discard', async (p) => {
    if (!isSpooled(p)) return false;
    await fsp.rm(p, { force: true });
    return true;
  });
}

module.exports = register;
module.exports.normalizeRanges = normalizeRanges;
module.exports.isSpooledForTest = isSpooled;
