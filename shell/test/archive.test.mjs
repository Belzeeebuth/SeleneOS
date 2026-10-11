// Archive Manager tests.
//   Part 1 (no Electron): the backend main/ipc/archive.js driven directly — listing of zip / tar.gz / tar.xz /
//   tar.zst / tar.bz2 / tar / 7z / rar / single .gz (nested folders, unicode names), extraction (all, selected,
//   overwrite policies), path traversal ('../x', '/abs', 'a/../../x'), symlink escapes (tar + zip, absolute and
//   relative, hard links), zip bombs, passwords (AES zip, 7z with encrypted names, wrong / missing password),
//   creation in every format (with progress events), add / delete (zip, 7z, tar.gz, tar.zst), test (ok and
//   damaged), cancel, preview (text / binary), temp-folder cleanup and argument validation.
//   Part 2 (Electron shell, Playwright): welcome page, opening, folder navigation (double-click, breadcrumb,
//   back / up, nav tree, keyboard), sorting, search, extract all / selected dialogs, unsafe-items dialog,
//   password prompt (wrong then right), new-archive dialog, add / delete, cancel from the progress dialog,
//   preview pane (text and image), properties, test, the {extract} and {compress} launch flows, recent list,
//   EN / FR, light / dark, minimum and maximized sizes, and zero console errors.
// Fixtures are generated here: system tools (7z, bsdtar) for regular archives, and small JS writers for the
// malicious tar / zip files and the RAR file (no `rar` tool is available).
// Usage:  cd aurora-os/shell && xvfb-run -a -s "-screen 0 1600x900x24" node test/archive.test.mjs [--only=name] [--backend]
// Screenshots: aurora-os/docs/screenshots/archive-*.png
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { launchShell, ROOT } from './lib.mjs';

const require = createRequire(import.meta.url);
const DOCS = path.join(ROOT, '..', 'docs', 'screenshots');
fs.mkdirSync(DOCS, { recursive: true });
const only = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7).toLowerCase();
const backendOnly = process.argv.includes('--backend');

let passed = 0;
const failures = [];
function check(name, actual, expected) {
  const ok = typeof expected === 'function' ? !!expected(actual) : Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++;
  else failures.push(`${name}\n      expected: ${typeof expected === 'function' ? '(predicate)' : JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)?.slice(0, 600)}`);
  return ok;
}
let recover = null;
async function section(name, fn) {
  if (only && !name.toLowerCase().includes(only)) return;
  const t0 = Date.now();
  const before = failures.length;
  try {
    await fn();
    console.log(`  ${failures.length === before ? '✓' : '✗'} ${name} (${Date.now() - t0} ms)`);
  } catch (err) {
    failures.push(`${name}: threw ${err?.stack || err}`);
    console.log(`  ✗ ${name}: ${err?.message || err}`);
  }
  await recover?.();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, { timeout = 8000, step = 60, label = 'condition' } = {}) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    last = await fn();
    if (last) return last;
    await sleep(step);
  }
  throw new Error(`timed out waiting for ${label} (last: ${JSON.stringify(last)?.slice(0, 300)})`);
}

// ================================================================== fixture writers
const crc32 = (buf) => zlib.crc32(buf) >>> 0;

/** Minimal ustar writer: entries [{ name, data?, type: 'file'|'dir'|'symlink'|'hardlink', link?, mode? }]. */
function makeTar(entries) {
  const blocks = [];
  for (const e of entries) {
    const hdr = Buffer.alloc(512);
    const data = e.type === 'file' || !e.type ? Buffer.from(e.data ?? '') : Buffer.alloc(0);
    hdr.write(e.name, 0, 100, 'utf8');
    hdr.write(((e.mode ?? (e.type === 'dir' ? 0o755 : 0o644)) & 0o7777).toString(8).padStart(7, '0') + '\0', 100, 8, 'latin1');
    hdr.write('0000000\0', 108, 8, 'latin1');
    hdr.write('0000000\0', 116, 8, 'latin1');
    hdr.write(data.length.toString(8).padStart(11, '0') + '\0', 124, 12, 'latin1');
    hdr.write(Math.floor(Date.UTC(2024, 4, 17, 11, 45) / 1000).toString(8).padStart(11, '0') + '\0', 136, 12, 'latin1');
    hdr.write('        ', 148, 8, 'latin1');
    hdr.write({ file: '0', dir: '5', symlink: '2', hardlink: '1' }[e.type || 'file'], 156, 1, 'latin1');
    if (e.link) hdr.write(e.link, 157, 100, 'utf8');
    hdr.write('ustar\0', 257, 6, 'latin1');
    hdr.write('00', 263, 2, 'latin1');
    let sum = 0;
    for (const b of hdr) sum += b;
    hdr.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'latin1');
    blocks.push(hdr, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

/** Minimal stored-zip writer: entries [{ name, data, mode? (unix, e.g. 0o120777 for a symlink) }]. */
function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const data = Buffer.from(e.data ?? '');
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt16LE(0, 8);
    lh.writeUInt16LE(0x5aa0, 10);
    lh.writeUInt16LE(0x58b1, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE((3 << 8) | 20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(0x5aa0, 12);
    ch.writeUInt16LE(0x58b1, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(((e.mode ?? 0o100644) << 16) >>> 0, 38);
    ch.writeUInt32LE(offset, 42);
    locals.push(lh, name, data);
    centrals.push(ch, name);
    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** RAR 4.x writer with stored files (there is no free `rar` tool to make one). */
function makeRar(entries) {
  const hdr = (type, flags, body) => {
    const rest = Buffer.concat([Buffer.from([type]), u16(flags), u16(7 + body.length), body]);
    return Buffer.concat([u16(crc32(rest) & 0xffff), rest]);
  };
  const u16 = (v) => {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(v);
    return b;
  };
  const u32 = (v) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(v >>> 0);
    return b;
  };
  const dos = ((2024 - 1980) << 25) | (5 << 21) | (17 << 16) | (13 << 11) | (45 << 5) | 15;
  const parts = [Buffer.from('Rar!\x1a\x07\x00', 'latin1'), hdr(0x73, 0, Buffer.alloc(6))];
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const data = Buffer.from(e.data ?? '');
    const flags = 0x8000 | (e.dir ? 0xe0 : 0) | (name.some((c) => c > 127) ? 0x200 : 0);
    const body = Buffer.concat([u32(data.length), u32(data.length), Buffer.from([3]), u32(crc32(data)), u32(dos), Buffer.from([20, 0x30]), u16(name.length), u32(e.dir ? 0o40755 : 0o100644), name]);
    parts.push(hdr(0x74, flags, body), data);
  }
  parts.push(hdr(0x7b, 0x4000, Buffer.alloc(0)));
  return Buffer.concat(parts);
}

/** A small gradient PNG (w x h, RGB). */
function makePng(w, h) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = Math.round((x / w) * 255);
      raw[o + 1] = Math.round((y / h) * 200) + 30;
      raw[o + 2] = 220;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, LC_ALL: 'C.UTF-8' }, ...opts });
const has = (cmd) => {
  try {
    execFileSync('which', [cmd], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};
if (!has('7z') || !has('bsdtar')) {
  console.error('This test needs 7z (package 7zip) and bsdtar (libarchive-tools).');
  process.exit(2);
}

// ================================================================== fixtures
const FIX = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-arc-fix-'));
const SRC = path.join(FIX, 'src');
const TAG = Math.random().toString(36).slice(2, 8);
const UNI = 'Ünïcødé ✓ 文件.txt';
function makeFixtures() {
  const w = (rel, data) => {
    const p = path.join(SRC, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, data);
  };
  w('docs/readme.txt', 'Hello from the Aurora archive test.\nSecond line.\n');
  w('docs/notes/été 2024.md', '# Été\n\nNotes *with* accents: àéîõü.\n');
  w('docs/notes/deep/deeper/leaf.txt', 'leaf');
  w('images/photo.png', makePng(160, 120));
  w('code/main.js', 'export const answer = 42;\n'.repeat(40));
  w(UNI, 'unicode name');
  w('data.bin', Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 7) & 255)));
  w('[weird] *name?.txt', 'glob characters');
  fs.mkdirSync(path.join(SRC, 'empty'), { recursive: true });
  fs.symlinkSync('../docs/readme.txt', path.join(SRC, 'code', 'readme-link'));
  const A = (n) => path.join(FIX, n);
  const items = fs.readdirSync(SRC);
  run('7z', ['a', '-tzip', '-snl', '-bd', A('t.zip'), ...items], { cwd: SRC });
  run('7z', ['a', '-t7z', '-bd', A('t.7z'), ...items], { cwd: SRC });
  run('bsdtar', ['-czf', A('t.tar.gz'), ...items], { cwd: SRC });
  run('bsdtar', ['-cJf', A('t.tar.xz'), ...items], { cwd: SRC });
  run('bsdtar', ['--zstd', '-cf', A('t.tar.zst'), ...items], { cwd: SRC });
  run('bsdtar', ['-cjf', A('t.tar.bz2'), ...items], { cwd: SRC });
  run('bsdtar', ['-cf', A('t.tar'), ...items], { cwd: SRC });
  fs.writeFileSync(A('notes.txt.gz'), zlib.gzipSync(Buffer.from('single gzip file\n')));
  fs.writeFileSync(A('t.rar'), makeRar([{ name: 'docs', dir: true }, { name: 'docs/readme.txt', data: 'Hello from RAR\n' }, { name: 'docs/café.txt', data: 'unicode in rar\n' }, { name: 'top.txt', data: 'top level\n' }]));
  run('7z', ['a', '-tzip', '-mem=AES256', '-psecret', '-bd', A('enc.zip'), 'docs', 'code'], { cwd: SRC });
  run('7z', ['a', '-t7z', '-mhe=on', '-psecret', '-bd', A('enchdr.7z'), 'docs', 'images'], { cwd: SRC });
  // malicious archives: names relative to the destination climb into FIX (the destination's parent)
  fs.writeFileSync(A('evil.tar'), makeTar([
    { name: 'ok.txt', data: 'fine' },
    { name: `../evil-${TAG}.txt`, data: 'escaped' },
    { name: `/tmp/aurora-evil-abs-${TAG}.txt`, data: 'absolute' },
    { name: `sub/../../evil2-${TAG}.txt`, data: 'escaped 2' },
  ]));
  fs.writeFileSync(A('symevil.tar'), makeTar([
    { name: 'ok.txt', data: 'fine' },
    { name: 'esc', type: 'symlink', link: FIX },
    { name: `esc/pwned-${TAG}.txt`, data: 'through the link' },
    { name: 'up', type: 'symlink', link: '../../..' },
    { name: 'hl', type: 'hardlink', link: '/etc/hostname' },
    { name: 'inside', type: 'symlink', link: 'ok.txt' },
  ]));
  fs.writeFileSync(A('evil.zip'), makeZip([
    { name: 'ok.txt', data: 'fine' },
    { name: `../evil-zip-${TAG}.txt`, data: 'escaped' },
    { name: `/tmp/aurora-evil-zipabs-${TAG}.txt`, data: 'absolute' },
  ]));
  fs.writeFileSync(A('symevil.zip'), makeZip([
    { name: 'ok.txt', data: 'fine' },
    { name: 'esc', data: FIX, mode: 0o120777 },
    { name: `esc/pwned-zip-${TAG}.txt`, data: 'through the link' },
  ]));
  // zip bomb: 200 MB of zeros (sparse file) -> ~200 KB archive
  const zeros = path.join(FIX, 'zeros.bin');
  fs.writeFileSync(zeros, '');
  fs.truncateSync(zeros, 200 * 1024 * 1024);
  run('7z', ['a', '-tzip', '-mx=1', '-bd', A('bomb.zip'), zeros]);
  fs.rmSync(zeros);
  // a big archive: 20,000 files in one folder (virtual list, listing speed)
  fs.writeFileSync(A('huge.tar'), makeTar(Array.from({ length: 20000 }, (_, i) => ({ name: `many/file-${String(i).padStart(5, '0')}.txt`, data: `#${i}` }))));
  // something slow to compress (cancel tests)
  fs.writeFileSync(path.join(FIX, 'random.bin'), Buffer.from(Array.from({ length: 48 * 1024 * 1024 }, () => (Math.random() * 256) | 0)));
  // something slow to extract (close-cancels test): 400 MB in a plain tar (written, not sparse)
  fs.mkdirSync(path.join(FIX, 'slow'));
  const fd = fs.openSync(path.join(FIX, 'slow', 'big.bin'), 'w');
  const chunk = Buffer.alloc(8 * 1024 * 1024, 7);
  for (let i = 0; i < 50; i++) fs.writeSync(fd, chunk);
  fs.closeSync(fd);
  run('bsdtar', ['-cf', A('slow.tar'), 'slow'], { cwd: FIX });
  fs.rmSync(path.join(FIX, 'slow'), { recursive: true, force: true });
  // damaged copies
  run('7z', ['a', '-tzip', '-mx=0', '-bd', A('stored.zip'), 'code', 'docs'], { cwd: SRC });
  const bad = fs.readFileSync(A('stored.zip'));
  const at = bad.indexOf(Buffer.from('export const answer'));
  bad[at + 100] ^= 0xff;
  fs.writeFileSync(A('damaged.zip'), bad);
  fs.rmSync(A('stored.zip'));
  const tg = fs.readFileSync(A('t.tar.gz'));
  fs.writeFileSync(A('truncated.tar.gz'), tg.subarray(0, Math.floor(tg.length * 0.6)));
  fs.writeFileSync(A('not-an-archive.zip'), 'just text, not a zip');
}
const fx = (n) => path.join(FIX, n);
const outsideEvil = () => fs.readdirSync(FIX).filter((n) => n.includes(TAG)).concat(fs.readdirSync('/tmp').filter((n) => n.includes(`aurora-evil`) && n.includes(TAG)));
const listTree = (dir) => {
  const out = [];
  const walk = (d, rel) => {
    for (const n of fs.readdirSync(d).sort()) {
      const p = path.join(d, n);
      const st = fs.lstatSync(p);
      const r = rel ? `${rel}/${n}` : n;
      out.push(st.isSymbolicLink() ? `${r} -> ${fs.readlinkSync(p)}` : st.isDirectory() ? `${r}/` : r);
      if (st.isDirectory()) walk(p, r);
    }
  };
  walk(dir, '');
  return out;
};

// ================================================================== part 1: backend
async function backendTests() {
  const register = require(path.join(ROOT, 'main', 'ipc', 'archive.js'));
  const handlers = new Map();
  const events = [];
  register({ handle: (c, f) => handlers.set(c, f), sendTo: (_s, ch, p) => ch === 'archive:progress' && events.push(p), broadcast() {}, error: (m, c) => Object.assign(new Error(m), { code: c }) });
  const call = async (ch, ...a) => {
    try {
      return await handlers.get(ch)(...a, { sender: {} });
    } catch (e) {
      return { ERR: e.code, msg: e.message };
    }
  };
  const names = (l) => (l.ERR ? l : l.entries.map((e) => (e.dir ? `${e.path}/` : e.path)).sort());
  const expected = ['[weird] *name?.txt', 'code/', 'code/main.js', 'code/readme-link', 'data.bin', 'docs/', 'docs/notes/', 'docs/notes/deep/', 'docs/notes/deep/deeper/', 'docs/notes/deep/deeper/leaf.txt', 'docs/notes/été 2024.md', 'docs/readme.txt', 'empty/', 'images/', 'images/photo.png', UNI].sort();
  const O = fs.mkdtempSync(path.join(FIX, 'out-'));

  await section('backend: list every format (nested folders, unicode names)', async () => {
    for (const f of ['t.zip', 't.7z', 't.tar.gz', 't.tar.xz', 't.tar.zst', 't.tar.bz2', 't.tar']) {
      const l = await call('archive:list', fx(f), {});
      check(`${f} entries`, names(l), expected);
      if (l.ERR) continue;
      check(`${f} format`, l.format, f.replace(/^t\./, ''));
      check(`${f} no unsafe`, l.unsafe.length, 0);
      check(`${f} totals`, l.totalSize, (v) => v > 4096);
      check(`${f} writable`, l.canAdd && l.canDelete, true);
      const leaf = l.entries.find((e) => e.path === 'docs/readme.txt');
      check(`${f} size`, leaf?.size, fs.statSync(path.join(SRC, 'docs/readme.txt')).size);
      check(`${f} mtime`, typeof leaf?.mtime === 'number' && Math.abs(leaf.mtime - fs.statSync(path.join(SRC, 'docs/readme.txt')).mtimeMs) < 120000, true);
    }
    const z = await call('archive:list', fx('t.zip'), {});
    check('zip per-entry packed sizes', z.perEntryPacked, true);
    check('zip symlink detected', z.entries.find((e) => e.path === 'code/readme-link')?.link != null, true);
    const tg = await call('archive:list', fx('t.tar.gz'), {});
    check('tar.gz symlink target', tg.entries.find((e) => e.path === 'code/readme-link')?.link, '../docs/readme.txt');
    check('tar.gz no per-entry packed sizes', tg.perEntryPacked, false);
    const rar = await call('archive:list', fx('t.rar'), {});
    check('rar entries', names(rar), ['docs/', 'docs/café.txt', 'docs/readme.txt', 'top.txt']);
    check('rar read-only', rar.canAdd, false);
    const gz = await call('archive:list', fx('notes.txt.gz'), {});
    check('single gz entry', names(gz), ['notes.txt']);
    check('single gz size from trailer', gz.entries?.[0]?.size, 17);
    check('not an archive', (await call('archive:list', fx('not-an-archive.zip'), {})).ERR, 'EFORMAT');
    check('missing file', (await call('archive:list', fx('nope.zip'), {})).ERR, 'ENOENT');
    check('relative path refused', (await call('archive:list', 'relative.zip', {})).ERR, 'EINVAL');
    check('folder refused', (await call('archive:list', FIX, {})).ERR, 'EFORMAT');
    const tr = await call('archive:list', fx('truncated.tar.gz'), {});
    check('truncated tar.gz: partial listing or corrupt error', tr.ERR === 'ECORRUPT' || (Array.isArray(tr.entries) && !!tr.damaged), true);
  });

  await section('backend: extract all and selected (every format)', async () => {
    for (const f of ['t.zip', 't.7z', 't.tar.gz', 't.tar.xz', 't.tar.zst', 't.tar', 't.rar', 'notes.txt.gz']) {
      const d = path.join(O, `all-${f}`);
      events.length = 0;
      const r = await call('archive:extract', fx(f), d, { opId: `x-${f}` });
      check(`${f} extract ok`, r.ERR || 'ok', 'ok');
      if (r.ERR) {
        console.log(r);
        continue;
      }
      check(`${f} progress events`, events.some((e) => e.opId === `x-${f}`), true);
      check(`${f} last progress = 100%`, events.filter((e) => e.opId === `x-${f}`).at(-1)?.percent, 1);
      if (f === 't.rar') {
        check('rar files', listTree(d), ['docs/', 'docs/café.txt', 'docs/readme.txt', 'top.txt']);
        check('rar content', fs.readFileSync(path.join(d, 'docs/café.txt'), 'utf8'), 'unicode in rar\n');
      } else if (f === 'notes.txt.gz') {
        check('gz content', fs.readFileSync(path.join(d, 'notes.txt'), 'utf8'), 'single gzip file\n');
      } else {
        check(`${f} unicode content`, fs.readFileSync(path.join(d, UNI), 'utf8'), 'unicode name');
        check(`${f} deep file`, fs.readFileSync(path.join(d, 'docs/notes/deep/deeper/leaf.txt'), 'utf8'), 'leaf');
        check(`${f} png bytes`, fs.readFileSync(path.join(d, 'images/photo.png')).equals(fs.readFileSync(path.join(SRC, 'images/photo.png'))), true);
        check(`${f} glob-named file`, fs.existsSync(path.join(d, '[weird] *name?.txt')), true);
        check(`${f} empty folder`, fs.statSync(path.join(d, 'empty')).isDirectory(), true);
        if (f !== 't.7z') check(`${f} internal symlink kept`, fs.readlinkSync(path.join(d, 'code/readme-link')), '../docs/readme.txt');
        check(`${f} no staging folder left`, fs.readdirSync(d).some((n) => n.startsWith('.aurora-extract-')), false);
      }
    }
    // selected items land under their own names, relative to nothing
    const d = path.join(O, 'sel');
    const r = await call('archive:extract', fx('t.tar.xz'), d, { entries: ['docs/notes', 'code/main.js'] });
    check('selected items', r.ERR || r.items.map((p) => path.relative(d, p)).sort(), ['main.js', 'notes']);
    check('selected tree', listTree(d), ['main.js', 'notes/', 'notes/deep/', 'notes/deep/deeper/', 'notes/deep/deeper/leaf.txt', 'notes/été 2024.md']);
    // overwrite policies
    const again = await call('archive:extract', fx('t.zip'), d, { entries: ['code/main.js'] });
    check('rename policy keeps both', again.ERR || [again.renamed, path.basename(again.items[0])], [1, 'main (2).js']);
    fs.writeFileSync(path.join(d, 'main.js'), 'changed');
    const skip = await call('archive:extract', fx('t.zip'), d, { entries: ['code/main.js'], overwrite: 'skip' });
    check('skip policy', skip.ERR || [skip.kept, fs.readFileSync(path.join(d, 'main.js'), 'utf8')], [1, 'changed']);
    const repl = await call('archive:extract', fx('t.7z'), d, { entries: ['code/main.js'], overwrite: 'replace' });
    check('replace policy', repl.ERR || [repl.replaced, fs.readFileSync(path.join(d, 'main.js'), 'utf8').startsWith('export')], [1, true]);
    check('unknown entry', (await call('archive:extract', fx('t.zip'), d, { entries: ['nope/x'] })).ERR, 'ENOENT');
    check('relative destination refused', (await call('archive:extract', fx('t.zip'), 'rel/dest', {})).ERR, 'EINVAL');
  });

  await section('backend: path traversal and symlink escapes are refused', async () => {
    for (const f of ['evil.tar', 'evil.zip', 'symevil.tar']) {
      const l = await call('archive:list', fx(f), {});
      check(`${f} unsafe listed`, l.unsafe?.length, (n) => n >= 2);
      check(`${f} unsafe entries not shown`, l.entries?.map((e) => e.path).filter((p) => p.includes(TAG) || p === 'esc' || p === 'up' || p === 'hl'), []);
      const d = path.join(O, `evil-${f}`);
      check(`${f} refused without consent`, (await call('archive:extract', fx(f), d, {})).ERR, 'EUNSAFE');
      check(`${f} nothing written when refused`, fs.existsSync(d) ? listTree(d) : [], []);
      const r = await call('archive:extract', fx(f), d, { skipUnsafe: true });
      check(`${f} safe part extracted`, r.ERR || r.items.map((p) => path.basename(p)).sort(), f === 'symevil.tar' ? ['inside', 'ok.txt'] : ['ok.txt']);
      check(`${f} skipped reported`, r.skipped?.length, (n) => n >= 2);
      check(`${f} dest content`, listTree(d), f === 'symevil.tar' ? ['inside -> ok.txt', 'ok.txt'] : ['ok.txt']);
    }
    check('symevil.tar: relative escape link classified', (await call('archive:list', fx('symevil.tar'), {})).unsafe.map((u) => u.path).sort(), ['esc', `esc/pwned-${TAG}.txt`, 'hl', 'up']);
    // zip symlink with a target only known at extraction time: refused by the extractor, then cleaned up
    const d = path.join(O, 'evil-symzip');
    const r = await call('archive:extract', fx('symevil.zip'), d, {});
    check('symevil.zip extracted without escaping', r.ERR || listTree(d).filter((x) => !x.startsWith('esc/') && x !== 'esc/'), ['ok.txt']);
    check('symevil.zip: escaping link not left behind', fs.existsSync(path.join(d, 'esc')) ? fs.lstatSync(path.join(d, 'esc')).isSymbolicLink() : false, false);
    check('symevil.zip skipped reported', r.skipped?.length, (n) => n >= 1);
    check('nothing written outside any destination', outsideEvil(), []);
    // selecting a folder never pulls unsafe entries along
    const d2 = path.join(O, 'evil-sel');
    const r2 = await call('archive:extract', fx('evil.tar'), d2, { entries: ['ok.txt'] });
    check('selection in unsafe archive', r2.ERR || listTree(d2), ['ok.txt']);
    check('still nothing outside', outsideEvil(), []);
  });

  await section('backend: zip bomb guard', async () => {
    const l = await call('archive:list', fx('bomb.zip'), {});
    check('bomb detected', l.bomb?.reason, 'ratio');
    const d = path.join(O, 'bomb');
    check('bomb refused', (await call('archive:extract', fx('bomb.zip'), d, {})).ERR, 'EBOMB');
    check('bomb: nothing extracted', fs.existsSync(d) ? listTree(d) : [], []);
    const r = await call('archive:extract', fx('bomb.zip'), d, { allowBomb: true });
    check('bomb allowed explicitly', r.ERR || r.bytes, 200 * 1024 * 1024);
    fs.rmSync(d, { recursive: true, force: true });
  });

  await section('backend: passwords (AES zip, 7z with encrypted names)', async () => {
    const z = await call('archive:list', fx('enc.zip'), {});
    check('enc.zip listed without password', z.ERR || z.encrypted, true);
    check('enc.zip entries flagged', z.entries?.filter((e) => !e.dir).every((e) => e.encrypted), true);
    const d = path.join(O, 'enc');
    check('enc.zip needs password', (await call('archive:extract', fx('enc.zip'), d, {})).ERR, 'EPASSWORD');
    check('enc.zip wrong password', (await call('archive:extract', fx('enc.zip'), d, { password: 'wrong' })).ERR, 'EBADPASSWORD');
    check('enc.zip: nothing left after a wrong password', fs.existsSync(d) ? listTree(d) : [], []);
    const ok = await call('archive:extract', fx('enc.zip'), d, { password: 'secret' });
    check('enc.zip right password', ok.ERR || fs.readFileSync(path.join(d, 'docs/readme.txt'), 'utf8').startsWith('Hello'), true);
    check('enchdr.7z needs password to list', (await call('archive:list', fx('enchdr.7z'), {})).ERR, 'EPASSWORD');
    check('enchdr.7z wrong password', (await call('archive:list', fx('enchdr.7z'), { password: 'nope' })).ERR, 'EBADPASSWORD');
    const h = await call('archive:list', fx('enchdr.7z'), { password: 'secret' });
    check('enchdr.7z listed', h.ERR || [h.headersEncrypted, h.entries.some((e) => e.path === 'images/photo.png')], [true, true]);
    const d2 = path.join(O, 'enchdr');
    const r = await call('archive:extract', fx('enchdr.7z'), d2, { password: 'secret', entries: ['images'] });
    check('enchdr.7z extract selected', r.ERR || listTree(d2), ['images/', 'images/photo.png']);
    const pv = await call('archive:preview', fx('enc.zip'), 'docs/readme.txt', { password: 'secret', session: 'pw', text: 1000 });
    check('preview of an encrypted entry', pv.ERR || pv.text, 'Hello from the Aurora archive test.\nSecond line.\n');
    check('test enc.zip', (await call('archive:test', fx('enc.zip'), { password: 'secret' })).ok, true);
    check('test enc.zip wrong password', (await call('archive:test', fx('enc.zip'), { password: 'x' })).ERR, 'EBADPASSWORD');
  });

  await section('backend: create every format with progress', async () => {
    const srcs = [path.join(SRC, 'docs'), path.join(SRC, UNI), path.join(SRC, '[weird] *name?.txt')];
    for (const fmt of ['zip', '7z', 'tar', 'tar.gz', 'tar.xz', 'tar.zst', 'tar.bz2']) {
      const dest = path.join(O, `new.${fmt}`);
      events.length = 0;
      const r = await call('archive:create', srcs, dest, { format: fmt, level: 5, opId: `c-${fmt}` });
      check(`create ${fmt}`, r.ERR || r.size > 0, true);
      check(`create ${fmt} progress`, events.filter((e) => e.opId === `c-${fmt}`).length, (n) => n >= 2);
      const l = await call('archive:list', dest, {});
      check(`create ${fmt} content`, names(l), ['[weird] *name?.txt', 'docs/', 'docs/notes/', 'docs/notes/deep/', 'docs/notes/deep/deeper/', 'docs/notes/deep/deeper/leaf.txt', 'docs/notes/été 2024.md', 'docs/readme.txt', UNI].sort());
      check(`create ${fmt}: no temp file left`, fs.readdirSync(O).some((n) => n.startsWith('.aurora-new-')), false);
    }
    const pz = path.join(O, 'pw.zip');
    check('zip password must be ASCII', (await call('archive:create', [path.join(SRC, 'docs')], pz, { format: 'zip', password: 'p w é' })).ERR, 'EZIPPASSWORD');
    check('create AES zip', (await call('archive:create', [path.join(SRC, 'docs')], pz, { format: 'zip', password: 'p w !' })).ERR || 'ok', 'ok');
    const lz = await call('archive:list', pz, {});
    check('AES zip entries encrypted', lz.entries?.filter((e) => !e.dir).every((e) => e.encrypted && /AES/.test(e.method)), true);
    const dz = path.join(O, 'pwz');
    check('AES zip round trip', (await call('archive:extract', pz, dz, { password: 'p w !' })).ERR || fs.existsSync(path.join(dz, 'docs/readme.txt')), true);
    const p7 = path.join(O, 'pw.7z');
    check('create 7z with encrypted names (unicode password)', (await call('archive:create', [path.join(SRC, 'docs')], p7, { format: '7z', password: 'clé été', encryptNames: true })).ERR || 'ok', 'ok');
    check('7z names hidden without password', (await call('archive:list', p7, {})).ERR, 'EPASSWORD');
    check('7z unicode password round trip', names(await call('archive:list', p7, { password: 'clé été' })).includes('docs/readme.txt'), true);
    check('tar.gz cannot be encrypted', (await call('archive:create', [path.join(SRC, 'docs')], path.join(O, 'x.tar.gz'), { format: 'tar.gz', password: 'x' })).ERR, 'ENOTSUP');
    check('password with a newline refused', (await call('archive:create', [path.join(SRC, 'docs')], path.join(O, 'x.zip'), { format: 'zip', password: 'a\nb' })).ERR, 'EINVAL');
    check('missing source', (await call('archive:create', [path.join(SRC, 'nope')], path.join(O, 'x.zip'), { format: 'zip' })).ERR, 'ENOENT');
    // an archive written inside the folder being compressed does not contain itself
    const inside = path.join(SRC, 'docs', 'self.zip');
    const ri = await call('archive:create', [path.join(SRC, 'docs')], inside, { format: 'zip' });
    check('archive inside its own source folder', ri.ERR || names(await call('archive:list', inside, {})).includes('docs/self.zip'), false);
    fs.rmSync(inside, { force: true });
  });

  await section('backend: add and delete (zip, 7z, tar.gz, tar.zst; read-only formats refused)', async () => {
    for (const fmt of ['zip', '7z', 'tar.gz', 'tar.zst']) {
      const a = path.join(O, `upd.${fmt}`);
      fs.copyFileSync(fx(`t.${fmt}`), a);
      const r = await call('archive:add', a, [path.join(SRC, 'images/photo.png'), path.join(SRC, 'docs/notes')], { base: 'code' });
      check(`add ${fmt}`, r.ERR || r.added, 2);
      let l = await call('archive:list', a, {});
      check(`add ${fmt} placed in folder`, names(l).filter((n) => n.startsWith('code/')), ['code/', 'code/main.js', 'code/notes/', 'code/notes/deep/', 'code/notes/deep/deeper/', 'code/notes/deep/deeper/leaf.txt', 'code/notes/été 2024.md', 'code/photo.png', 'code/readme-link']);
      // adding a file with an existing name replaces it (no duplicates)
      fs.writeFileSync(path.join(FIX, 'data.bin'), 'replacement');
      await call('archive:add', a, [path.join(FIX, 'data.bin')], {});
      l = await call('archive:list', a, {});
      check(`add ${fmt} replaces`, l.entries.filter((e) => e.path === 'data.bin').map((e) => e.size), [11]);
      const del = await call('archive:delete', a, ['docs', 'data.bin', '[weird] *name?.txt'], {});
      check(`delete ${fmt}`, del.ERR || 'ok', 'ok');
      l = await call('archive:list', a, {});
      check(`delete ${fmt} result`, names(l).filter((n) => !n.startsWith('code/')), ['empty/', 'images/', 'images/photo.png', UNI].sort());
      check(`${fmt} still valid`, (await call('archive:test', a, {})).ok, true);
    }
    check('add to rar refused', (await call('archive:add', fx('t.rar'), [path.join(SRC, UNI)], {})).ERR, 'ENOTSUP');
    check('delete from single gz refused', (await call('archive:delete', fx('notes.txt.gz'), ['notes.txt'], {})).ERR, 'ENOTSUP');
    check('archive cannot be added to itself', (await call('archive:add', path.join(O, 'upd.zip'), [path.join(O, 'upd.zip')], {})).ERR, 'EINVAL');
    const p7 = path.join(O, 'upd-enc.7z');
    fs.copyFileSync(fx('enchdr.7z'), p7);
    check('add to encrypted 7z needs password', (await call('archive:add', p7, [path.join(SRC, UNI)], {})).ERR, 'EPASSWORD');
    check('add to encrypted 7z', (await call('archive:add', p7, [path.join(SRC, UNI)], { password: 'secret' })).ERR || 'ok', 'ok');
    check('encrypted 7z keeps hidden names', (await call('archive:list', p7, {})).ERR, 'EPASSWORD');
    check('delete from encrypted 7z', (await call('archive:delete', p7, ['images'], { password: 'secret' })).ERR || names(await call('archive:list', p7, { password: 'secret' })).some((n) => n.startsWith('images')), false);
  });

  await section('backend: test, cancel, preview, cleanup', async () => {
    check('test zip ok', await call('archive:test', fx('t.zip'), {}), (r) => r.ok === true && r.files > 5);
    check('test tar.gz ok', (await call('archive:test', fx('t.tar.gz'), {})).ok, true);
    check('test rar ok', (await call('archive:test', fx('t.rar'), {})).ok, true);
    const bad = await call('archive:test', fx('damaged.zip'), {});
    check('test damaged zip', [bad.ok, bad.errors?.length > 0], [false, true]);
    const tr = await call('archive:test', fx('truncated.tar.gz'), {});
    check('test truncated tar.gz', tr.ok, false);
    // cancel a slow creation
    const dest = path.join(O, 'cancel.7z');
    const p = call('archive:create', [fx('random.bin')], dest, { format: '7z', level: 9, opId: 'cancel-me' });
    await sleep(500);
    await call('archive:cancel', 'cancel-me');
    const r = await p;
    check('cancel create', r.ERR, 'ECANCELED');
    check('cancel create leaves nothing', fs.readdirSync(O).filter((n) => n.includes('cancel') || n.startsWith('.aurora-new-')), []);
    // cancel an extraction
    const big = path.join(O, 'big.zip');
    await call('archive:create', [fx('random.bin')], big, { format: 'zip', level: 0 });
    const d = path.join(O, 'cancel-x');
    const px = call('archive:extract', big, d, { opId: 'cancel-x' });
    await sleep(60);
    await call('archive:cancel', 'cancel-x');
    const rx = await px;
    check('cancel extract (or finished first)', rx.ERR === 'ECANCELED' || !!rx.items, true);
    check('cancel extract leaves no staging folder', fs.existsSync(d) ? fs.readdirSync(d).filter((n) => n.startsWith('.aurora-extract-')) : [], []);
    // preview
    const pt = await call('archive:preview', fx('t.tar.gz'), 'docs/notes/été 2024.md', { session: 'w1', text: 4096 });
    check('preview text', pt.ERR || pt.text, '# Été\n\nNotes *with* accents: àéîõü.\n');
    check('preview file is private', pt.ERR || (fs.statSync(path.dirname(path.dirname(pt.path))).mode & 0o777).toString(8), '700');
    const pb = await call('archive:preview', fx('t.zip'), 'data.bin', { session: 'w1', text: 4096 });
    check('preview binary detected', pb.binary, true);
    const pi = await call('archive:preview', fx('t.rar'), 'docs/café.txt', { session: 'w1' });
    check('preview from rar', pi.ERR || fs.readFileSync(pi.path, 'utf8'), 'unicode in rar\n');
    const again = await call('archive:preview', fx('t.tar.gz'), 'docs/notes/été 2024.md', { session: 'w1' });
    check('preview cached', again.path, pt.path);
    check('preview refuses traversal names', (await call('archive:preview', fx('t.zip'), '../x', { session: 'w1' })).ERR, 'EINVAL');
    check('session names are validated', (await call('archive:preview', fx('t.zip'), 'data.bin', { session: '../../etc' })).ERR, 'EINVAL');
    const tmp = await call('archive:tempDir', 'w1');
    check('temp dir mode 0700 root', (fs.statSync(path.dirname(tmp)).mode & 0o777).toString(8), '700');
    const et = await call('archive:extractTemp', fx('t.zip'), { entries: ['docs/readme.txt', 'images'], session: 'w1', sub: 'd1' });
    check('extractTemp for drag & drop', et.ERR || et.items.map((p) => path.relative(tmp, p)), ['x-d1/readme.txt', 'x-d1/images']);
    await call('archive:cleanup', 'w1');
    check('cleanup removes the session folder', fs.existsSync(tmp), false);
  });

  // QA regressions (adversarial pass)
  await section('backend: QA regressions (pseudo-fs hang, permissions, progress, cancel, symlink chains)', async () => {
    const timed = (p, ms = 8000) => Promise.race([p, sleep(ms).then(() => ({ ERR: 'HANG' }))]);
    // Node's recursive mkdir never settles under /proc: the destination must fail fast, not hang
    check('extract to /proc/x/y fails fast with EACCES', (await timed(call('archive:extract', fx('t.zip'), '/proc/aurora-nope/deeper', {}))).ERR, 'EACCES');
    check('extract into /proc/sys: EACCES, not "disk full"', (await timed(call('archive:extract', fx('t.zip'), '/proc/sys', {}))).ERR, 'EACCES');
    check('create into /proc: EACCES', (await timed(call('archive:create', [path.join(SRC, 'docs')], '/proc/aurora-new.zip', {}))).ERR, 'EACCES');
    check('extract into a file: EINVAL', (await call('archive:extract', fx('t.zip'), path.join(SRC, 'data.bin', 'x'), {})).ERR, 'EINVAL');
    // read-only archive (no write bit; 7-Zip refuses those even as root): add/delete disabled with a reason
    const ro = path.join(O, 'ro.zip');
    fs.copyFileSync(fx('t.zip'), ro);
    fs.chmodSync(ro, 0o444);
    const lro = await call('archive:list', ro, {});
    check('read-only archive: canAdd/canDelete false, reason perm', [lro.canAdd, lro.canDelete, lro.readOnly], [false, false, 'perm']);
    fs.writeFileSync(path.join(O, 'add-me.txt'), 'x');
    check('add to a read-only archive: EACCES', (await call('archive:add', ro, [path.join(O, 'add-me.txt')], {})).ERR, 'EACCES');
    check('delete from a read-only archive: EACCES', (await call('archive:delete', ro, ['data.bin'], {})).ERR, 'EACCES');
    fs.chmodSync(ro, 0o644);
    const lrw = await call('archive:list', ro, {});
    check('permissions re-checked on every listing (cache)', [lrw.canAdd, lrw.readOnly], [true, null]);
    check('format read-only reason (rar)', (await call('archive:list', fx('t.rar'), {})).readOnly, 'format');
    // progress: "done" counts finished items (the tools print a name when they START it)
    events.length = 0;
    const r = await call('archive:extract', fx('t.tar.gz'), path.join(O, 'prog-check'), { opId: 'qa-prog' });
    const ev = events.filter((e) => e.opId === 'qa-prog');
    check('progress: extraction ok', r.ERR || r.files > 0, true);
    check('progress: never "all done" before the end', ev.slice(0, -1).every((e) => e.done < e.total || e.percent === 1), true);
    check('progress: final event done = total', [ev.at(-1)?.done, ev.at(-1)?.percent], [ev.at(-1)?.total, 1]);
    // cancel right away (during the listing): nothing is extracted afterwards
    const dc = path.join(O, 'cancel-early');
    const pc = call('archive:extract', fx('t.tar.xz'), dc, { opId: 'qa-early' });
    await call('archive:cancel', 'qa-early');
    check('early cancel -> ECANCELED', (await pc).ERR, 'ECANCELED');
    check('early cancel: nothing written', fs.existsSync(dc) ? fs.readdirSync(dc) : [], []);
    // archive:cleanup stops a running preview of that session before deleting its folder
    run('bsdtar', ['-cf', path.join(O, 'bigentry.tar'), 'random.bin'], { cwd: FIX });
    const tmpS = await call('archive:tempDir', 'qa-sess');
    const pv = call('archive:preview', path.join(O, 'bigentry.tar'), 'random.bin', { session: 'qa-sess' });
    await sleep(60);
    await call('archive:cleanup', 'qa-sess');
    check('cleanup cancels the running preview', (await pv).ERR, 'ECANCELED');
    await sleep(400);
    check('cleanup: session folder gone, not recreated', fs.existsSync(tmpS), false);
    // symlink chains whose targets look harmless one by one ("d/e/up -> ../..", "esc -> d/e/up/../..")
    fs.writeFileSync(path.join(O, 'chain.tar'), makeTar([
      { name: 'd/', type: 'dir' },
      { name: 'd/e/', type: 'dir' },
      { name: 'd/e/up', type: 'symlink', link: '../..' },
      { name: 'esc', type: 'symlink', link: 'd/e/up/../..' },
      { name: `esc/chain-${TAG}.txt`, data: 'escaped' },
      { name: 'a/', type: 'dir' },
      { name: 'a/u0', type: 'symlink', link: '..' },
      { name: 'x', type: 'symlink', link: 'a/u0/..' },
      { name: 'y', type: 'symlink', link: 'x/..' },
      { name: `y/chain2-${TAG}.txt`, data: 'escaped' },
    ]));
    const outer = path.join(O, 'chain-outer');
    fs.mkdirSync(outer);
    await call('archive:extract', path.join(O, 'chain.tar'), path.join(outer, 'dest'), { skipUnsafe: true });
    const leaked = [];
    const walk = (d) => {
      for (const n of fs.readdirSync(d)) {
        const p = path.join(d, n);
        if (n.includes(TAG) && !p.startsWith(path.join(outer, 'dest') + path.sep)) leaked.push(path.relative(FIX, p));
        if (fs.lstatSync(p).isDirectory()) walk(p);
      }
    };
    walk(FIX);
    check('symlink chains: nothing written outside the destination', leaked, []);
    // an unsafe name with a line break can't go in an exclusion list (nor in 7-Zip's listing): still skipped
    for (const fmt of ['tar', 'tar.gz']) {
      const nl = makeTar([{ name: 'ok.txt', data: 'fine' }, { name: '../evil\nnl.txt', data: 'x' }, { name: '/tmp/x\n.txt', data: 'y' }, { name: 'up', type: 'symlink', link: '/etc' }, { name: 'up\n/pw', data: 'z' }]);
      const f = path.join(O, `nl.${fmt}`);
      fs.writeFileSync(f, fmt === 'tar' ? nl : zlib.gzipSync(nl));
      const d = path.join(O, `nl-out-${fmt.replace('.', '-')}`);
      const rn = await call('archive:extract', f, d, { skipUnsafe: true });
      check(`${fmt}: newline-named unsafe entries are skipped too`, rn.ERR || fs.readdirSync(d), ['ok.txt']);
    }
    check('symlink chains: nothing outside any destination', outsideEvil(), []);
  });
}

// ================================================================== part 2: UI
const WIN = '.win.app-archive';
let s = null;
const W = (fn, arg, index = -1) => s.page.evaluate(`(() => { const all = [...document.querySelectorAll(${JSON.stringify(WIN)})].filter((el) => !el.classList.contains('closing')); const el = all.at(${index}); return (${fn.toString()})(el && el.__archive, el, ${JSON.stringify(arg ?? null)}); })()`);
const evalJs = (expr) => s.page.evaluate(expr);
const DLG = `${WIN} > .dialog-layer:not(.closing) .dialog`;
const dialogOpen = () => evalJs(`!!document.querySelector(${JSON.stringify(DLG)})`);
const dialogText = () => evalJs(`[...document.querySelectorAll(${JSON.stringify(DLG)})].map((d) => d.innerText).join('\\n---\\n')`);
async function dialogButton(label) {
  await until(() => dialogOpen(), { label: `dialog with ${label}` });
  await s.page.locator(`${DLG} .dialog-footer button`, { hasText: label }).last().click();
  await sleep(250);
}
const winCount = () => evalJs(`[...document.querySelectorAll(${JSON.stringify(WIN)})].filter((el) => !el.classList.contains('closing')).length`);
const rows = () => W((w) => w?.list.items.map((n) => n.name) || null);
const visibleRows = () => evalJs(`[...document.querySelectorAll('${WIN}:last-of-type .arc-row .arc-name')].map((e) => e.textContent)`);
const listingOf = () => W((w) => (w?.listing ? { path: w.listing.path, folder: w.folder?.path ?? null, count: w.list.items.length } : null));
async function closeAll() {
  await s.aurora(() => {
    for (const w of window.__aurora.wm.list()) if (w.appId === 'archive' || w.appId === 'files') w.close(true);
  });
  await until(async () => (await winCount()) === 0, { label: 'windows closed' });
  await sleep(250);
}
async function openArchive(file) {
  await s.aurora((p) => { window.__aurora.shell.openFile(p); }, file);
  await until(async () => (await listingOf())?.path === file, { label: `listing of ${path.basename(file)}`, timeout: 15000 });
  await sleep(300);
}
async function shotDoc(name) {
  await sleep(400);
  const f = await s.shot(name);
  fs.copyFileSync(f, path.join(DOCS, `${name}.png`));
}
async function dblRow(name) {
  await s.page.locator(`${WIN} .arc-row`, { has: s.page.locator('.arc-name', { hasText: name }) }).first().dblclick();
  await sleep(250);
}
async function clickRow(name, mods) {
  await s.page.locator(`${WIN} .arc-row`, { has: s.page.locator('.arc-name', { hasText: name }) }).first().click({ modifiers: mods });
  await sleep(120);
}

async function uiTests() {
  const fresh = async (opts = {}) => {
    if (s) await s.close();
    s = await launchShell({ open: opts.open ?? [], lang: opts.lang || 'en', theme: opts.theme || 'light', ...opts });
    s.errors = () => s.logs.filter((l) => /^\[(error|pageerror)\]/.test(l) && !/favicon|ResizeObserver loop/.test(l));
  };
  await fresh({ open: ['archive'] });
  recover = async () => {
    try {
      if (s && (await dialogOpen())) await s.page.keyboard.press('Escape');
    } catch {}
  };

  await section('ui: welcome page', async () => {
    await until(async () => evalJs(`!!document.querySelector('${WIN} .arc-welcome:not([hidden])')`), { label: 'welcome' });
    check('two action cards', await evalJs(`document.querySelectorAll('${WIN} .arc-wcard').length`), 2);
    check('title', await evalJs(`document.querySelector('${WIN} .arc-hero .title').textContent`), 'Archive Manager');
    check('empty recent list', await evalJs(`!!document.querySelector('${WIN} .arc-recent-empty')`), true);
    await shotDoc('archive-welcome-en-light');
  });

  await section('ui: open and browse a zip (navigation, breadcrumb, keyboard)', async () => {
    await closeAll();
    await openArchive(fx('t.zip'));
    check('window title', await s.aurora(() => window.__aurora.wm.list().find((w) => w.appId === 'archive')?.title), 't.zip - Archive Manager');
    check('root rows (folders first, sorted)', await rows(), ['code', 'docs', 'empty', 'images', '[weird] *name?.txt', 'data.bin', UNI]);
    check('rows rendered', (await visibleRows()).includes(UNI), true);
    check('compressed size column for zip', await evalJs(`[...document.querySelectorAll('${WIN} .arc-dh-cell')].map((c) => c.dataset.key)`), ['name', 'type', 'packed', 'size', 'ratio', 'mtime']);
    await dblRow('docs');
    check('entered docs', (await listingOf()).folder, 'docs');
    check('breadcrumb', await evalJs(`[...document.querySelectorAll('${WIN} .arc-crumb')].map((c) => c.textContent)`), ['t.zip', 'docs']);
    await dblRow('notes');
    await dblRow('deep');
    check('deep folder', (await listingOf()).folder, 'docs/notes/deep');
    await s.page.keyboard.press('Alt+ArrowUp');
    await sleep(200);
    check('Alt+Up goes to parent', (await listingOf()).folder, 'docs/notes');
    check('came-from folder selected', await W((w) => [...w.list.selected]), ['docs/notes/deep']);
    await s.page.keyboard.press('Alt+ArrowLeft');
    await sleep(200);
    check('Alt+Left goes back', (await listingOf()).folder, 'docs/notes/deep');
    await s.page.locator(`${WIN} .arc-crumb`, { hasText: 't.zip' }).click();
    await sleep(200);
    check('breadcrumb root', (await listingOf()).folder, '');
    // nav tree
    await s.page.locator(`${WIN} .arc-tnode`, { hasText: 'images' }).click();
    await sleep(200);
    check('nav tree navigates', (await listingOf()).folder, 'images');
    check('nav tree selection', await evalJs(`document.querySelector('${WIN} .arc-tnode.selected')?.textContent`), 'images');
    await s.page.keyboard.press('Backspace');
    await sleep(200);
    check('Backspace = up', (await listingOf()).folder, '');
    // keyboard selection in the list
    await s.page.locator(`${WIN} .arc-scroll`).focus();
    await s.page.keyboard.press('Home');
    await s.page.keyboard.press('Shift+ArrowDown');
    await s.page.keyboard.press('Shift+ArrowDown');
    check('shift selection', await W((w) => [...w.list.selected].sort()), ['code', 'docs', 'empty']);
    await s.page.keyboard.press('Control+a');
    check('Ctrl+A', await W((w) => w.list.selected.size), 7);
    check('status shows selection', await evalJs(`document.querySelector('${WIN} .arc-status-l').innerText`), (t) => /7 items selected/.test(t));
    await s.page.keyboard.press('Escape');
    await s.page.keyboard.type('da');
    check('type-ahead', await W((w) => [...w.list.selected]), ['data.bin']);
    await s.page.keyboard.press('Enter');
    await sleep(150);
    // data.bin opens with the default app (none for .bin -> a notification); just make sure nothing broke
    await clickRow('docs');
    await s.page.keyboard.press('Enter');
    await sleep(200);
    check('Enter opens a folder', (await listingOf()).folder, 'docs');
    await s.page.keyboard.press('Alt+ArrowUp');
    await sleep(200);
    // live language switch keeps the folder and the selection
    await dblRow('docs');
    await clickRow('readme.txt');
    const listeners = await W((w) => w.win._h?.get?.('resize')?.size ?? 0);
    await s.aurora(() => window.__aurora.i18n.setLang('fr'));
    await sleep(300);
    check('live relabel: French headers', await evalJs(`[...document.querySelectorAll('${WIN} .arc-dh-cell')].map((c) => c.textContent).slice(0, 2)`), ['Nom', 'Type']);
    check('live relabel: same folder and selection', [(await listingOf()).folder, await W((w) => [...w.list.selected])], ['docs', ['docs/readme.txt']]);
    await s.aurora(() => window.__aurora.i18n.setLang('en'));
    await sleep(300);
    check('back to English', await evalJs(`document.querySelector('${WIN} .arc-cmd[data-cmd="extractAll"]').textContent`), 'Extract all');
    check('relabel adds no listeners', await W((w) => w.win._h?.get?.('resize')?.size ?? 0), listeners);
    await s.page.keyboard.press('Alt+ArrowUp');
    await sleep(200);
    await shotDoc('archive-browse-en-light');
  });

  await section('ui: sort and search', async () => {
    await s.page.locator(`${WIN} .arc-dh-cell[data-key="size"]`).click();
    await sleep(200);
    check('sort by size (desc first)', (await rows()).slice(4), ['data.bin', '[weird] *name?.txt', UNI]);
    await s.page.locator(`${WIN} .arc-dh-cell[data-key="name"]`).click();
    await sleep(200);
    check('sort by name again', (await rows()).slice(0, 2), ['code', 'docs']);
    await s.page.keyboard.press('Control+f');
    await s.page.keyboard.type('txt');
    await until(async () => (await W((w) => w.query)) === 'txt', { label: 'search applied' });
    check('search results (recursive)', (await rows()).sort(), ['[weird] *name?.txt', 'leaf.txt', 'readme.txt', UNI].sort());
    check('location column in search', await evalJs(`[...document.querySelectorAll('${WIN} .arc-dh-cell')].map((c) => c.dataset.key).includes('location')`), true);
    await s.page.keyboard.press('Escape');
    await until(async () => (await W((w) => w.query)) === '', { label: 'search cleared' });
    check('search cleared', (await rows()).length, 7);
  });

  await section('ui: huge archive (20,000 items, virtual list)', async () => {
    await closeAll();
    const t0 = Date.now();
    await openArchive(fx('huge.tar'));
    await dblRow('many');
    check('20,000 items listed', (await listingOf()).count, 20000);
    check('opened in reasonable time', Date.now() - t0, (ms) => ms < 15000);
    check('only visible rows in the DOM', await evalJs(`document.querySelectorAll('${WIN} .arc-row').length`), (n) => n > 5 && n < 120);
    await s.page.locator(`${WIN} .arc-scroll`).focus();
    await s.page.keyboard.press('End');
    await sleep(200);
    check('End selects the last item', await W((w) => [...w.list.selected]), ['many/file-19999.txt']);
    check('last row rendered', (await visibleRows()).includes('file-19999.txt'), true);
    await s.page.keyboard.press('Control+a');
    check('status counts all', await evalJs(`document.querySelector('${WIN} .arc-status-l').innerText`), (t) => /20,000 items selected/.test(t));
  });

  await section('ui: extract all (dialog, show files off) and selected', async () => {
    await closeAll();
    await openArchive(fx('t.zip'));
    const dest = path.join(FIX, 'ui-extract-all');
    await s.page.locator(`${WIN} .arc-cmd[data-cmd="extractAll"]`).click();
    await until(() => dialogOpen(), { label: 'extract dialog' });
    check('default destination', await evalJs(`document.querySelector('${DLG} input.input').value`), fx('t'));
    await shotDoc('archive-extract-dialog-en-light');
    await s.page.locator(`${DLG} input.input`).fill(dest);
    await s.page.locator(`${DLG} .checkbox input`).uncheck();
    await dialogButton('Extract');
    await until(() => fs.existsSync(path.join(dest, 'docs/notes/deep/deeper/leaf.txt')), { label: 'files extracted' });
    check('unicode file extracted', fs.readFileSync(path.join(dest, UNI), 'utf8'), 'unicode name');
    await until(async () => evalJs(`!document.querySelector('${WIN} .arc-toast').hidden`), { label: 'toast' });
    check('toast', await evalJs(`document.querySelector('${WIN} .arc-toast').innerText`), (t) => /files extracted to ui-extract-all/.test(t));
    check('no Files window opened', await s.aurora(() => window.__aurora.wm.list().filter((w) => w.appId === 'files').length), 0);
    // selected
    const dest2 = path.join(FIX, 'ui-extract-sel');
    await clickRow('images');
    await clickRow(UNI, ['Control']);
    await s.page.locator(`${WIN} .arc-cmd[data-cmd="extractSel"]`).click();
    await until(() => dialogOpen(), { label: 'extract dialog' });
    check('selected intro', await dialogText(), (t) => /2 selected items/.test(t));
    await s.page.locator(`${DLG} input.input`).fill(dest2);
    await s.page.locator(`${DLG} .checkbox input`).check();
    await dialogButton('Extract');
    await until(() => fs.existsSync(path.join(dest2, 'images/photo.png')) && fs.existsSync(path.join(dest2, UNI)), { label: 'selected extracted' });
    check('selected only', fs.readdirSync(dest2).sort(), ['images', UNI].sort());
    await until(async () => (await s.aurora(() => window.__aurora.wm.list().filter((w) => w.appId === 'files').length)) === 1, { label: 'Files window (show extracted files)' });
    await s.aurora(() => window.__aurora.wm.list().find((w) => w.appId === 'files')?.close(true));
    await sleep(300);
  });

  await section('ui: unsafe archive (traversal + symlink) is refused / skipped', async () => {
    await closeAll();
    await openArchive(fx('symevil.tar'));
    check('unsafe infobar', await evalJs(`document.querySelector('${WIN} .arc-info.warning')?.innerText || ''`), (t) => /unsafe path/.test(t));
    check('unsafe items hidden from the list', await rows(), ['inside', 'ok.txt']);
    await shotDoc('archive-unsafe-en-light');
    const dest = path.join(FIX, 'ui-unsafe');
    await s.page.locator(`${WIN} .arc-cmd[data-cmd="extractAll"]`).click();
    await until(() => dialogOpen(), { label: 'extract dialog' });
    await s.page.locator(`${DLG} input.input`).fill(dest);
    await s.page.locator(`${DLG} .checkbox input`).uncheck();
    await dialogButton('Extract');
    await until(async () => (await dialogText()).includes('outside the destination'), { label: 'unsafe dialog' });
    check('unsafe dialog lists items', await dialogText(), (t) => t.includes('esc') && t.includes('Link to another location'));
    await shotDoc('archive-unsafe-dialog-en-light');
    await dialogButton('Cancel');
    check('cancel: nothing extracted', fs.existsSync(dest), false);
    await s.page.locator(`${WIN} .arc-cmd[data-cmd="extractAll"]`).click();
    await until(() => dialogOpen(), { label: 'extract dialog' });
    await s.page.locator(`${DLG} input.input`).fill(dest);
    await s.page.locator(`${DLG} .checkbox input`).uncheck();
    await dialogButton('Extract');
    await until(async () => (await dialogText()).includes('outside the destination'), { label: 'unsafe dialog' });
    await dialogButton('Skip them and extract');
    await until(() => fs.existsSync(path.join(dest, 'ok.txt')), { label: 'safe items extracted' });
    await sleep(300);
    check('only safe items', listTree(dest), ['inside -> ok.txt', 'ok.txt']);
    check('nothing outside', outsideEvil(), []);
  });

  await section('ui: password prompt (wrong, then right) and encrypted names', async () => {
    await closeAll();
    s.aurora((p) => { window.__aurora.shell.openFile(p); }, fx('enchdr.7z'));
    await until(async () => (await dialogText()).includes('password protected'), { label: 'password dialog', timeout: 15000 });
    await shotDoc('archive-password-en-light');
    await s.page.locator(`${DLG} input[type="password"]`).fill('wrong');
    await dialogButton('OK');
    await until(async () => (await dialogText()).includes('The password is incorrect'), { label: 'wrong password message' });
    await s.page.locator(`${DLG} input[type="password"]`).fill('secret');
    await s.page.keyboard.press('Enter');
    await until(async () => (await listingOf())?.path === fx('enchdr.7z'), { label: 'encrypted listing' });
    check('encrypted listing rows', await rows(), ['docs', 'images']);
    check('lock icons', await evalJs(`document.querySelectorAll('${WIN} .arc-row .arc-lock').length`), 0); // folders: no lock
    await dblRow('images');
    check('file rows locked', await evalJs(`document.querySelectorAll('${WIN} .arc-row .arc-lock').length`), 1);
    // extraction reuses the password typed for the listing
    const dest = path.join(FIX, 'ui-enc');
    await clickRow('photo.png');
    await W((w, el, d) => w.runExtract({ nodes: w.list.selectedNodes(), dest: d }), dest);
    await until(() => fs.existsSync(path.join(dest, 'photo.png')), { label: 'encrypted extract' });
    // AES zip: listing works, extraction asks for the password
    await closeAll();
    await openArchive(fx('enc.zip'));
    const dest2 = path.join(FIX, 'ui-enc2');
    W((w, el, d) => w.runExtract({ nodes: null, dest: d }), dest2);
    await until(async () => (await dialogText()).includes('password protected'), { label: 'password dialog for extraction' });
    await s.page.locator(`${DLG} input[type="password"]`).fill('nope');
    await s.page.keyboard.press('Enter');
    await until(async () => (await dialogText()).includes('The password is incorrect'), { label: 'wrong password' });
    await s.page.locator(`${DLG} input[type="password"]`).fill('secret');
    await s.page.keyboard.press('Enter');
    await until(() => fs.existsSync(path.join(dest2, 'docs/readme.txt')), { label: 'AES extract' });
  });

  await section('ui: preview pane (text + image) and properties', async () => {
    await closeAll();
    await openArchive(fx('t.tar.gz'));
    await s.page.keyboard.press('Alt+p');
    await until(async () => evalJs(`!document.querySelector('${WIN} .arc-preview').hidden`), { label: 'preview pane' });
    await dblRow('docs');
    await clickRow('readme.txt');
    await until(async () => evalJs(`document.querySelector('${WIN} .arc-pv-text')?.textContent || ''`), { label: 'text preview' });
    check('text preview', await evalJs(`document.querySelector('${WIN} .arc-pv-text').textContent`), 'Hello from the Aurora archive test.\nSecond line.\n');
    await s.page.keyboard.press('Alt+ArrowUp');
    await dblRow('images');
    await clickRow('photo.png');
    await until(async () => evalJs(`(() => { const i = document.querySelector('${WIN} .arc-pv-img'); return !!i && i.complete && i.naturalWidth === 160; })()`), { label: 'image preview' });
    await shotDoc('archive-preview-en-light');
    await s.page.keyboard.press('Alt+Enter');
    await until(() => dialogOpen(), { label: 'properties' });
    check('properties of a file', await dialogText(), (t) => /photo\.png/.test(t) && /PNG File/.test(t) && /Location in the archive/.test(t));
    await dialogButton('OK');
    await s.page.keyboard.press('Alt+ArrowUp');
    await s.page.keyboard.press('Escape');
    await W((w) => w.list.clearSelection());
    W((w) => w.properties()); // resolves when the dialog closes: don't await
    await until(() => dialogOpen(), { label: 'archive properties' });
    check('archive properties', await dialogText(), (t) => /TAR\.GZ archive/.test(t) && /Uncompressed size/.test(t));
    await shotDoc('archive-properties-en-light');
    await dialogButton('OK');
    await s.page.keyboard.press('Alt+p');
  });

  await section('ui: test archive (ok + damaged)', async () => {
    await s.page.locator(`${WIN} .arc-cmd[data-cmd="test"]`).click();
    await until(async () => (await dialogText()).includes('No errors were found'), { label: 'test ok', timeout: 15000 });
    await dialogButton('OK');
    await closeAll();
    await openArchive(fx('damaged.zip'));
    await s.page.locator(`${WIN} .arc-cmd[data-cmd="test"]`).click();
    await until(async () => (await dialogText()).includes('contains errors'), { label: 'test damaged', timeout: 15000 });
    check('error detail', await dialogText(), (t) => /CRC|Data Error|main\.js/i.test(t));
    await dialogButton('OK');
  });

  await section('ui: add (confirm) and delete on a zip', async () => {
    await closeAll();
    const a = path.join(FIX, 'ui-edit.zip');
    fs.copyFileSync(fx('t.zip'), a);
    await openArchive(a);
    await dblRow('code');
    W((w, el, p) => w.addFiles(p), [path.join(SRC, 'images/photo.png'), path.join(SRC, 'docs/notes')]);
    await until(async () => (await dialogText()).includes('Add 2 items to ui-edit.zip/code'), { label: 'add confirm' });
    await dialogButton('Add');
    await until(async () => (await rows())?.includes('photo.png'), { label: 'added rows', timeout: 15000 });
    check('added + selected', await W((w) => [...w.list.selected].sort()), ['code/notes', 'code/photo.png']);
    check('rows after add', await rows(), ['notes', 'main.js', 'photo.png', 'readme-link']);
    await clickRow('main.js');
    await s.page.keyboard.press('Delete');
    await until(async () => (await dialogText()).includes('Delete “main.js” from the archive?'), { label: 'delete confirm' });
    await dialogButton('Delete');
    await until(async () => !(await rows())?.includes('main.js'), { label: 'deleted', timeout: 15000 });
    const l = execFileSync('7z', ['l', '-ba', '-slt', a]).toString();
    check('zip on disk updated', [/Path = code\/main\.js/.test(l), /Path = code\/photo\.png/.test(l)], [false, true]);
    // read-only formats
    await closeAll();
    await openArchive(fx('t.rar'));
    check('add disabled for rar', await evalJs(`document.querySelector('${WIN} .arc-cmd[data-cmd="add"]').disabled`), true);
    check('read-only in status', await evalJs(`document.querySelector('${WIN} .arc-status-r').innerText`), (t) => /Read-only/.test(t));
  });

  await section('ui: clipboard (copy out, paste in) and drag & drop', async () => {
    await closeAll();
    const a = path.join(FIX, 'ui-dnd.zip');
    fs.copyFileSync(fx('t.zip'), a);
    await openArchive(a);
    // Ctrl+C: the selection is extracted to the window's private temp folder and put on the files clipboard
    await clickRow('docs');
    await clickRow(UNI, ['Control']);
    await s.page.keyboard.press('Control+c');
    await until(async () => (await s.aurora(() => window.__aurora.shell.clipboard.getFiles()?.paths?.length)) === 2, { label: 'files clipboard' });
    const clip = await s.aurora(() => window.__aurora.shell.clipboard.getFiles());
    check('copied paths exist', clip.paths.every((p) => fs.existsSync(p)), true);
    check('copied folder content', fs.readFileSync(path.join(clip.paths.find((p) => p.endsWith('/docs')), 'readme.txt'), 'utf8').startsWith('Hello'), true);
    check('copied into a private folder', (fs.statSync(path.dirname(path.dirname(path.dirname(clip.paths[0])))).mode & 0o777).toString(8), '700');
    // Ctrl+V of our own copy is ignored (it would add the archive's files to itself)
    await s.page.keyboard.press('Control+v');
    await sleep(400);
    check('own clipboard not pasted back', await dialogOpen(), false);
    // Ctrl+V of files copied elsewhere adds them to the current folder
    await dblRow('images');
    await s.aurora((p) => window.__aurora.shell.clipboard.setFiles(p, 'copy'), [path.join(SRC, 'code/main.js')]);
    await s.page.locator(`${WIN} .arc-scroll`).focus();
    await s.page.keyboard.press('Control+v');
    await until(async () => (await dialogText()).includes('Add “main.js” to ui-dnd.zip/images'), { label: 'paste confirm' });
    await dialogButton('Add');
    await until(async () => (await rows())?.includes('main.js'), { label: 'pasted', timeout: 15000 });
    // drag a row out: the drag data points into the temp folder, filled right away
    const drag = await evalJs(`(() => {
      const row = [...document.querySelectorAll('${WIN} .arc-row')].find((r) => r.textContent.includes('photo.png'));
      const dt = new DataTransfer();
      row.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
      const out = { paths: JSON.parse(dt.getData('application/x-aurora-paths') || '[]'), uri: dt.getData('text/uri-list') };
      row.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
      return out;
    })()`);
    check('drag-out data', drag.paths.length === 1 && drag.paths[0].endsWith('/photo.png') && drag.uri.startsWith('file:///'), true);
    await until(() => fs.existsSync(drag.paths[0]), { label: 'drag-out file extracted' });
    check('drag-out file content', fs.readFileSync(drag.paths[0]).equals(fs.readFileSync(path.join(SRC, 'images/photo.png'))), true);
    // drop files from the shell (File Explorer / desktop) onto the window -> confirm -> add
    evalJs(`(() => {
      document.dispatchEvent(new DragEvent('dragstart', { bubbles: true }));
      const dt = new DataTransfer();
      dt.setData('application/x-aurora-paths', JSON.stringify([${JSON.stringify(path.join(SRC, 'docs/notes'))}]));
      const el = document.querySelector('${WIN} .arc-scroll');
      el.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
      el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
      document.dispatchEvent(new DragEvent('dragend', { bubbles: true }));
    })()`);
    await until(async () => (await dialogText()).includes('Add “notes” to ui-dnd.zip/images'), { label: 'drop confirm' });
    await dialogButton('Add');
    await until(async () => (await rows())?.includes('notes'), { label: 'dropped', timeout: 15000 });
    check('drop overlay hidden', await evalJs(`document.querySelector('${WIN} .arc-drop').hidden`), true);
    // dropping files on the welcome page offers to compress them
    await s.aurora(() => window.__aurora.shell.launch('archive', {}));
    await until(async () => evalJs(`!!document.querySelector('${WIN}:last-of-type .arc-welcome:not([hidden])')`), { label: 'welcome' });
    evalJs(`(() => {
      document.dispatchEvent(new DragEvent('dragstart', { bubbles: true }));
      const dt = new DataTransfer();
      dt.setData('application/x-aurora-paths', JSON.stringify([${JSON.stringify(path.join(SRC, 'docs'))}]));
      const all = [...document.querySelectorAll('${WIN}')];
      const el = all[all.length - 1].querySelector('.arc-welcome');
      el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
      document.dispatchEvent(new DragEvent('dragend', { bubbles: true }));
    })()`);
    await until(async () => (await dialogText()).includes('Create an archive'), { label: 'compress dialog from drop' });
    check('dropped item listed', await evalJs(`[...document.querySelectorAll('${DLG} .arc-src')].map((e) => e.textContent)`), ['docs']);
    await dialogButton('Cancel');
  });

  await section('ui: new archive dialog + progress, and cancel', async () => {
    await closeAll();
    await s.aurora(() => window.__aurora.shell.launch('archive', {}));
    await until(async () => evalJs(`!!document.querySelector('${WIN} .arc-welcome:not([hidden])')`), { label: 'welcome' });
    W((w, el, p) => w.newArchive(p), [path.join(SRC, 'docs'), path.join(SRC, 'code')]);
    await until(async () => (await dialogText()).includes('Create an archive'), { label: 'new archive dialog' });
    check('suggested name', await evalJs(`document.querySelector('${DLG} .arc-grid input.input').value`), 'src');
    check('two items listed', await evalJs(`document.querySelectorAll('${DLG} .arc-src').length`), 2);
    await s.page.locator(`${DLG} .arc-grid input.input`).first().fill('made-by-ui');
    await s.page.locator(`${DLG} select.arc-fmt`).selectOption('7z');
    await s.page.locator(`${DLG} .arc-enc input[type="password"]`).first().fill('pw1');
    await s.page.locator(`${DLG} .arc-enc input[type="password"]`).nth(1).fill('pw2');
    check('new archive dialog: no horizontal overflow', await evalJs(`(() => { const b = document.querySelector('${DLG} .dialog-body'); return b.scrollWidth <= b.clientWidth + 1; })()`), true);
    await shotDoc('archive-new-dialog-en-light');
    await dialogButton('Create');
    check('mismatch error', await dialogText(), (t) => /don't match/.test(t));
    await s.page.locator(`${DLG} .arc-enc input[type="password"]`).nth(1).fill('pw1');
    await dialogButton('Create');
    await until(async () => (await listingOf())?.path === path.join(SRC, 'made-by-ui.7z'), { label: 'new archive opened', timeout: 20000 });
    check('new archive content', (await rows()).sort(), ['code', 'docs']);
    let listed = '';
    try {
      listed = execFileSync('7z', ['l', path.join(SRC, 'made-by-ui.7z')], { input: '\n', stdio: ['pipe', 'pipe', 'pipe'] }).toString();
    } catch (e) {
      listed = String(e.stdout || '');
    }
    check('names encrypted (7z cannot list without the password)', listed.includes('docs/readme.txt'), false);
    fs.rmSync(path.join(SRC, 'made-by-ui.7z'));
    // cancel a slow 7z (ultra) through the progress dialog
    await closeAll();
    await s.aurora(() => window.__aurora.shell.launch('archive', {}));
    await until(async () => evalJs(`!!document.querySelector('${WIN} .arc-welcome:not([hidden])')`), { label: 'welcome' });
    W((w, el, p) => w.newArchive(p), [fx('random.bin')]);
    await until(async () => (await dialogText()).includes('Create an archive'), { label: 'new archive dialog' });
    await s.page.locator(`${DLG} select.arc-fmt`).selectOption('7z');
    await s.page.locator(`${DLG} .arc-grid select`).nth(1).selectOption('9');
    await dialogButton('Create');
    await until(async () => evalJs(`!!document.querySelector('${WIN} .arc-prog-dialog')`), { label: 'progress dialog', timeout: 10000 });
    await until(async () => evalJs(`(document.querySelector('${WIN} .arc-prog-pct')?.textContent || '').includes('%')`), { label: 'progress percent', timeout: 10000 });
    await shotDoc('archive-progress-en-light');
    await s.page.locator(`${DLG} .dialog-footer button`, { hasText: 'Cancel' }).click();
    await until(async () => !(await evalJs(`!!document.querySelector('${WIN} .arc-prog-dialog')`)), { label: 'progress closed', timeout: 10000 });
    check('canceled: no archive', fs.existsSync(fx('random.7z')), false);
    check('canceled: no temp file', fs.readdirSync(FIX).filter((n) => n.startsWith('.aurora-new-')), []);
  });

  await section('ui: launch flows {extract} and {compress}', async () => {
    await closeAll();
    const dir = fs.mkdtempSync(path.join(FIX, 'flow-'));
    fs.copyFileSync(fx('t.tar.zst'), path.join(dir, 't.tar.zst'));
    await s.aurora((p) => window.__aurora.shell.launch('archive', { extract: p, show: false }), path.join(dir, 't.tar.zst'));
    await until(() => fs.existsSync(path.join(dir, 't', 'docs/readme.txt')), { label: 'extract flow', timeout: 15000 });
    await until(async () => (await winCount()) === 0, { label: 'flow window closed' });
    check('extract flow: folder named after the archive', fs.readdirSync(dir).sort(), ['t', 't.tar.zst']);
    await s.aurora((p) => window.__aurora.shell.launch('archive', { extract: p, show: false }), path.join(dir, 't.tar.zst'));
    await until(() => fs.existsSync(path.join(dir, 't (2)')), { label: 'second extract -> unique folder', timeout: 15000 });
    await until(async () => (await winCount()) === 0, { label: 'flow window closed' });
    await s.aurora((p) => window.__aurora.shell.launch('archive', { compress: p, format: 'zip' }), [path.join(dir, 't'), path.join(dir, 't (2)')]);
    await until(() => fs.existsSync(path.join(dir, `${path.basename(dir)}.zip`)), { label: 'compress flow', timeout: 15000 });
    await until(async () => (await winCount()) === 0, { label: 'compress window closed' });
    check('compress flow archive', execFileSync('7z', ['l', '-ba', path.join(dir, `${path.basename(dir)}.zip`)]).toString().includes('t (2)/docs/readme.txt'), true);
    // a flow that fails stays open with an error and a Close button
    await s.aurora((p) => window.__aurora.shell.launch('archive', { extract: p }), fx('not-an-archive.zip'));
    await until(async () => evalJs(`!!document.querySelector('${WIN} .arc-task-error')`), { label: 'flow error' });
    check('flow error text', await evalJs(`document.querySelector('${WIN} .arc-task-error').innerText`), (t) => /isn't an archive/.test(t));
    await shotDoc('archive-flow-error-en-light');
    await s.page.locator(`${WIN} .arc-task-error .btn.primary`).click();
    await until(async () => (await winCount()) === 0, { label: 'closed' });
  });

  await section('ui: recent list + already-open archive is focused', async () => {
    await closeAll();
    await openArchive(fx('t.rar'));
    await closeAll();
    await s.aurora(() => window.__aurora.shell.launch('archive', {}));
    await until(async () => evalJs(`document.querySelectorAll('${WIN} .arc-recent-row').length >= 3`), { label: 'recent rows' });
    check('recent first = last opened', await evalJs(`document.querySelector('${WIN} .arc-recent-row').dataset.path`), fx('t.rar'));
    await until(async () => evalJs(`[...document.querySelectorAll('${WIN} .arc-recent-row.missing')].map((r) => r.dataset.path)`).then((l) => l.includes(path.join(SRC, 'made-by-ui.7z'))), { label: 'deleted archive flagged as missing' });
    await s.page.locator(`${WIN} .arc-recent-row`).first().click();
    await until(async () => (await listingOf())?.path === fx('t.rar'), { label: 'opened from recent' });
    await s.aurora((p) => window.__aurora.shell.openFile(p), fx('t.rar'));
    await sleep(800);
    check('same archive not opened twice', await winCount(), 1);
  });

  await section('ui: QA regressions (races, close cancels, keyboard, read-only, leaks)', async () => {
    const dialogs = () => evalJs(`document.querySelectorAll(${JSON.stringify(DLG)}).length`);
    const escAll = async () => {
      for (let i = 0; i < 5 && (await dialogs()); i++) {
        await s.page.keyboard.press('Escape');
        await sleep(250);
      }
    };
    // search placeholder survives a live language switch
    await closeAll();
    await openArchive(fx('t.zip'));
    const ph = () => evalJs(`document.querySelector('${WIN} .arc-search-input').placeholder`);
    check('placeholder', await ph(), 'Search t.zip');
    await s.aurora(() => window.__aurora.i18n.setLang('fr'));
    await sleep(300);
    check('placeholder after switching to French', await ph(), 'Rechercher dans t.zip');
    await s.aurora(() => window.__aurora.i18n.setLang('en'));
    await sleep(300);
    check('placeholder after switching back', await ph(), 'Search t.zip');
    // a crumb click while searching clears the search box state
    await s.page.keyboard.press('Control+f');
    await s.page.keyboard.type('txt');
    await until(async () => (await W((w) => w.query)) === 'txt', { label: 'search' });
    await s.page.locator(`${WIN} .arc-crumb`, { hasText: 't.zip' }).first().click();
    await sleep(200);
    check('crumb during search: search box reset', await evalJs(`document.querySelector('${WIN} .arc-search').classList.contains('has-text')`), false);
    check('crumb click keeps the keyboard in the window (list focused)', await evalJs(`document.activeElement === document.querySelector('${WIN} .arc-scroll')`), true);
    // a drag that starts inside a multi-selection swallows the pointerup: the next click must not snap the
    // selection back to the dragged row (stale "collapse on release" listener)
    await clickRow('code');
    await clickRow('docs', ['Control']);
    const afterDrag = await W((w, el) => {
      const rowOf = (name) => [...el.querySelectorAll('.arc-row')].find((r) => r.querySelector('.arc-name')?.textContent === name);
      const a = rowOf('docs');
      a.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
      a.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: new DataTransfer() }));
      a.dispatchEvent(new DragEvent('dragend', { bubbles: true }));
      const b = rowOf('empty');
      b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
      b.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
      return [...w.list.selected];
    });
    check('click after a drag selects the clicked row', afterDrag, ['empty']);
    // Tab stays in the window (it used to walk out to the taskbar); the command bar is one Tab stop
    const inWin = [];
    for (let i = 0; i < 14; i++) {
      await s.page.keyboard.press('Tab');
      inWin.push(await evalJs(`!!document.activeElement?.closest('${WIN}')`));
    }
    check('Tab cycles inside the window', inWin.every(Boolean), true);
    check('command bar = one Tab stop', await evalJs(`[...document.querySelectorAll('${WIN} .arc-cmd')].filter((b) => b.tabIndex === 0).length`), 1);
    await s.page.locator(`${WIN} .arc-cmd[data-cmd="new"]`).focus();
    await s.page.keyboard.press('ArrowRight');
    check('arrows move inside the command bar', await evalJs(`document.activeElement?.dataset.cmd`), 'extractAll');
    check('roving tabindex follows', await evalJs(`document.activeElement?.tabIndex`), 0);
    await s.page.locator(`${WIN} .arc-scroll`).focus();
    // Ctrl+N twice in a row: one dialog (the dialog opens after an async call)
    await W((w) => {
      w.newArchive();
      w.newArchive();
    });
    await until(() => dialogOpen(), { label: 'new archive dialog' });
    await sleep(300);
    check('double Ctrl+N: one dialog', await dialogs(), 1);
    await escAll();
    // Ctrl+C with text selected in the preview pane copies the text, not the file
    await s.page.keyboard.press('Alt+p');
    await dblRow('docs');
    await clickRow('readme.txt');
    await until(async () => evalJs(`!!document.querySelector('${WIN} .arc-pv-text')`), { label: 'text preview' });
    await s.aurora(() => window.__aurora.shell.clipboard.setFiles([], 'copy'));
    await evalJs(`(() => { const pre = document.querySelector('${WIN} .arc-pv-text'); pre.focus(); const r = document.createRange(); r.selectNodeContents(pre); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); })()`);
    await s.page.keyboard.press('Control+c');
    await sleep(600);
    check('Ctrl+C on selected preview text: no file copy', await s.aurora(() => window.__aurora.shell.clipboard.getFiles()?.paths?.length || 0), 0);
    await evalJs(`getSelection().removeAllRanges()`);
    await s.page.keyboard.press('Alt+p');
    // Delete in the navigation tree does not delete the list's selection
    await clickRow('readme.txt');
    await s.page.locator(`${WIN} .arc-tree`).focus();
    await s.page.keyboard.press('Delete');
    await sleep(300);
    check('Delete in the tree: no delete prompt', await dialogs(), 0);
    await escAll();
    await closeAll();
    // a double-click on a Recent archive with encrypted names: a single password prompt
    await openArchive(fx('t.zip'));
    await closeAll();
    await s.aurora((p) => window.__aurora.shell.openFile(p), fx('enchdr.7z'));
    await until(() => dialogOpen(), { label: 'password prompt' });
    await s.page.locator(`${DLG} input[type=password]`).fill('secret');
    await s.page.keyboard.press('Enter');
    await until(async () => (await listingOf())?.path === fx('enchdr.7z'), { label: 'encrypted archive listed' });
    await closeAll();
    await s.aurora(() => window.__aurora.shell.launch('archive', {}));
    await until(async () => evalJs(`document.querySelector('${WIN} .arc-recent-row')?.dataset.path`).then((p) => p === fx('enchdr.7z')), { label: 'recent row' });
    await s.page.locator(`${WIN} .arc-recent-row`).first().dblclick();
    await until(() => dialogOpen(), { label: 'password prompt from recent' });
    await sleep(800);
    check('double-click on a recent encrypted archive: one password prompt', await dialogs(), 1);
    await escAll();
    await closeAll();
    // read-only archive: Add / Delete disabled, the reason is shown
    const ro = path.join(FIX, 'readonly.zip');
    fs.copyFileSync(fx('t.zip'), ro);
    fs.chmodSync(ro, 0o444);
    await openArchive(ro);
    await clickRow('data.bin');
    check('read-only: Add and Delete disabled', await evalJs(`['add', 'delete'].map((k) => document.querySelector('${WIN} .arc-cmd[data-cmd="' + k + '"]').disabled)`), [true, true]);
    check('read-only: reason in the Add tooltip', await evalJs(`document.querySelector('${WIN} .arc-cmd[data-cmd="add"]').dataset.tip`), (t) => /permission/.test(t));
    check('read-only: status bar flag', await evalJs(`document.querySelector('${WIN} .arc-status-r').innerText`), (t) => /Read-only/.test(t));
    await closeAll();
    // closing the window during an extraction cancels it ("Closing the window cancels the current operation")
    const slowDest = path.join(FIX, 'close-cancel');
    // archive tools whose working directory is inside that destination (other agents may run 7z too)
    const procs = () => {
      let pids = [];
      try {
        pids = execFileSync('pgrep', ['-x', '7z|7zz|bsdtar|bsdcat'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
      } catch {}
      return pids.filter((pid) => {
        try {
          return fs.readlinkSync(`/proc/${pid}/cwd`).startsWith(slowDest);
        } catch {
          return false;
        }
      }).join(',');
    };
    await openArchive(fx('slow.tar'));
    W((w, el, d) => w.runExtract({ nodes: null, dest: d, overwrite: 'rename', show: false }), slowDest);
    await until(async () => (await W((w) => w.busy)) > 0, { label: 'busy' });
    await until(() => fs.existsSync(slowDest) && fs.readdirSync(slowDest).some((n) => n.startsWith('.aurora-extract-')), { label: 'extraction started' });
    await sleep(200);
    check('extraction running before the close', procs() !== '', true);
    await s.aurora(() => {
      void window.__aurora.wm.list().find((x) => x.appId === 'archive').close();
    });
    await until(async () => (await dialogText()).includes('Close anyway'), { label: 'close confirmation' });
    await dialogButton('Close');
    const t0 = Date.now();
    await until(async () => !procs() && !(await W((w) => !!w)), { label: 'tools stopped', timeout: 6000 }).catch(() => {});
    check('close cancels: no tool still running', procs(), '');
    check('close cancels: stopped quickly', Date.now() - t0 < 6000, true);
    await sleep(500);
    check('close cancels: nothing left in the destination', fs.existsSync(slowDest) ? fs.readdirSync(slowDest) : [], []);
    // compact "Extract here" flow: the Cancel button is inside the window
    const flowDest = path.join(FIX, 'flow-fit');
    await s.aurora((a) => window.__aurora.shell.launch('archive', a), { extract: fx('slow.tar'), dest: flowDest, show: false });
    await until(async () => evalJs(`!!document.querySelector('${WIN} .arc-task .arc-prog-actions .btn')`), { label: 'flow progress' });
    await sleep(400);
    check('flow: Cancel inside the window', await evalJs(`(() => { const w = document.querySelector('${WIN}'); const b = w.querySelector('.arc-task .arc-prog-actions .btn').getBoundingClientRect(); return b.bottom <= w.getBoundingClientRect().bottom - 8; })()`), true);
    await s.page.locator(`${WIN} .arc-task .arc-prog-actions .btn`).click();
    await until(async () => (await winCount()) === 0, { label: 'flow canceled' });
    check('flow cancel: nothing extracted', fs.existsSync(flowDest) ? fs.readdirSync(flowDest) : [], []);
    // extracting to a folder that can't be created: an error, not an endless "Extracting…"
    await openArchive(fx('t.zip'));
    W((w) => w.runExtract({ nodes: null, dest: '/proc/aurora-nope/x', overwrite: 'rename', show: false }));
    await until(async () => (await dialogText()).includes("Can't extract"), { label: 'extract error', timeout: 8000 });
    check('bad destination: access error shown', await dialogText(), (t) => /permission|access/i.test(t));
    await escAll();
    await closeAll();
    // open / close 15 times: no window, listener or DOM growth
    const snap = () => evalJs(`import('app://shell/apps/archive/lib/shared.js').then((m) => ({ windows: m.shared.windows.size, prefs: m.shared._h.get('prefs')?.size || 0, recent: m.shared._h.get('recent')?.size || 0, nodes: document.getElementsByTagName('*').length, ctx: Object.keys(m.shared.ctx || {}).sort().join(',') }))`);
    const before = await snap();
    for (let i = 0; i < 15; i++) {
      await openArchive(fx('t.zip'));
      await closeAll();
    }
    await sleep(500);
    const after = await snap();
    check('15 open/close: no leaked windows or listeners', [after.windows, after.prefs, after.recent], [0, 0, 0]);
    check('15 open/close: DOM size stable', after.nodes - before.nodes, (d) => Math.abs(d) < 40);
    check('shared state keeps no window ctx', after.ctx, 'api,storage');
  });

  await section('ui: sizes (minimum, maximized) + no console errors', async () => {
    await closeAll();
    await openArchive(fx('t.zip'));
    await s.aurora(() => {
      const w = window.__aurora.wm.list().find((x) => x.appId === 'archive');
      w.setSize(460, 340);
    });
    await sleep(400);
    check('min size: no horizontal overflow of the command bar', await evalJs(`(() => { const c = document.querySelector('${WIN} .arc-cmdbar'); return c.scrollWidth <= c.clientWidth + 1; })()`), true);
    check('min size: search still visible', await evalJs(`document.querySelector('${WIN} .arc-search').getBoundingClientRect().width > 100`), true);
    check('min size: "See more" replaces hidden commands', await evalJs(`(() => { const m = document.querySelector('${WIN} .arc-cmd[data-cmd="more"]'); const t = document.querySelector('${WIN} .arc-cmd[data-cmd="test"]'); return m.offsetWidth > 0 && t.offsetWidth === 0; })()`), true);
    await s.page.locator(`${WIN} .arc-cmd[data-cmd="more"]`).click();
    await until(async () => evalJs(`[...document.querySelectorAll('.menu .menu-item')].map((m) => m.textContent).join('|')`), { label: 'more menu' });
    check('more menu items', await evalJs(`[...document.querySelectorAll('.menu .menu-item .label')].map((m) => m.textContent)`), (l) => l.includes('Test') && l.includes('Properties') && l.includes('Sort'));
    await s.page.keyboard.press('Escape');
    await shotDoc('archive-min-en-light');
    await s.aurora(() => window.__aurora.wm.list().find((x) => x.appId === 'archive').maximize());
    await sleep(500);
    await shotDoc('archive-max-en-light');
    check('console errors', s.errors(), []);
  });

  // ---------------------------------------------------------------- French + dark
  await fresh({ open: [], lang: 'fr', theme: 'dark' });
  await section('ui: French + dark', async () => {
    await s.aurora(() => window.__aurora.shell.launch('archive', {}));
    await until(async () => evalJs(`!!document.querySelector('${WIN} .arc-welcome:not([hidden])')`), { label: 'welcome' });
    check('fr title', await evalJs(`document.querySelector('${WIN} .arc-hero .title').textContent`), "Gestionnaire d'archives");
    await shotDoc('archive-welcome-fr-dark');
    await closeAll();
    await openArchive(fx('t.zip'));
    check('fr columns', await evalJs(`[...document.querySelectorAll('${WIN} .arc-dh-cell')].map((c) => c.textContent)`), ['Nom', 'Type', 'Taille compressée', 'Taille', 'Taux', 'Modifié le']);
    check('fr types', await evalJs(`document.querySelector('${WIN} .arc-row .c-type').textContent`), 'Dossier de fichiers');
    check('fr status', await evalJs(`document.querySelector('${WIN} .arc-status-l').innerText`), (t) => /7 éléments/.test(t));
    await s.page.keyboard.press('Alt+p');
    await dblRow('images');
    await clickRow('photo.png');
    await until(async () => evalJs(`(() => { const i = document.querySelector('${WIN} .arc-pv-img'); return !!i && i.complete && i.naturalWidth > 0; })()`), { label: 'image preview' });
    check('columns fit next to the preview pane (no horizontal scrollbar)', await evalJs(`(() => { const sc = document.querySelector('${WIN} .arc-scroll'); return sc.scrollWidth <= sc.clientWidth + 1; })()`), true);
    await shotDoc('archive-browse-fr-dark');
    await s.page.keyboard.press('Alt+ArrowUp');
    await s.page.locator(`${WIN} .arc-cmd[data-cmd="extractAll"]`).click();
    await until(() => dialogOpen(), { label: 'extract dialog' });
    check('fr extract dialog', await dialogText(), (t) => /Sélectionner une destination/.test(t) && /Afficher les fichiers extraits/.test(t));
    await shotDoc('archive-extract-dialog-fr-dark');
    await dialogButton('Annuler');
    // overflow check: no label is clipped in the French command bar at default size
    check('fr command labels fit', await evalJs(`[...document.querySelectorAll('${WIN} .arc-cmd-label')].every((l) => l.scrollWidth <= l.clientWidth + 1)`), true);
    // shortcuts with French key names (Windows: Maj, Suppr, Entrée)
    check('fr shortcut names in tooltips', await evalJs(`['extractAll', 'delete', 'props'].map((k) => document.querySelector('${WIN} .arc-cmd[data-cmd="' + k + '"]').dataset.tip)`), ['Extraire tout (Ctrl+Maj+E)', 'Supprimer (Suppr)', 'Propriétés (Alt+Entrée)']);
    await clickRow('images');
    await until(async () => evalJs(`document.querySelector('${WIN} .arc-preview')?.innerText || ''`).then((t) => /1 fichier, 0 dossier\b/.test(t)), { label: 'fr singular "1 fichier, 0 dossier"' });
    check('fr plurals in the preview pane', await evalJs(`document.querySelector('${WIN} .arc-preview').innerText`), (t) => /1 fichier, 0 dossier\b/.test(t) && !/1 fichiers/.test(t));
    await s.page.locator(`${WIN} .arc-row`, { has: s.page.locator('.arc-name', { hasText: 'images' }) }).click({ button: 'right' });
    await until(async () => evalJs(`document.querySelectorAll('.menu .menu-item').length`), { label: 'fr item menu' });
    check('fr item menu shortcuts', await evalJs(`[...document.querySelectorAll('.menu .menu-item .shortcut')].map((e) => e.textContent)`), (l) => l.includes('Entrée') && l.includes('Suppr') && !l.includes('Enter') && !l.includes('Del'));
    await s.page.keyboard.press('Escape');
    W((w, el, p) => w.newArchive(p), [path.join(SRC, 'docs')]);
    await until(async () => (await dialogText()).includes('Créer une archive'), { label: 'fr new archive' });
    await s.page.locator(`${DLG} select.arc-fmt`).selectOption('tar.gz');
    await shotDoc('archive-new-dialog-fr-dark');
    check('fr no encryption hint', await dialogText(), (t) => /ne peuvent pas être protégées/.test(t));
    await dialogButton('Annuler');
    await s.aurora(() => window.__aurora.wm.list().find((x) => x.appId === 'archive').setSize(460, 340));
    await sleep(400);
    await shotDoc('archive-min-fr-dark');
    check('fr console errors', s.errors(), []);
  });
}

// ================================================================== main
console.log(`Archive Manager tests (fixtures in ${FIX})`);
makeFixtures();
try {
  await backendTests();
  if (!backendOnly) await uiTests();
} finally {
  if (s) await s.close();
  fs.rmSync(FIX, { recursive: true, force: true });
  for (const n of fs.readdirSync('/tmp')) if (n.includes('aurora-evil') && n.includes(TAG)) fs.rmSync(path.join('/tmp', n), { force: true });
}
console.log(`\n${passed} checks passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
