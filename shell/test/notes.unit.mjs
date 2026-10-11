// Notes data layer + security unit tests (no UI):
//   1. backend main/ipc/notes.js in plain Node with a fake IPC registry and a throwaway HOME: atomic writes,
//      concurrent saves, crash / corruption recovery (truncated index, backup, truncated or missing note
//      file, stale temp files), input validation (ids, sizes, payload types), path traversal and symlinks
//      (attachments, exports, data URLs, note folders), unsafe SVG pictures.
//   2. Markdown import (markdownToHtml / markdownTitle) in plain Node: hostile input stays text.
//   3. In the real Electron renderer (test/lib.mjs, no app window): the DOM sanitizer against a large XSS /
//      mutation-XSS corpus (nothing runs, nothing executable survives, output is stable when re-parsed),
//      formatting that must survive, Markdown export -> import round trips, and the NotesStore model
//      (reconciliation at load, 30-day purge, serialized saves, failed-write retry, oversized notes).
// Run:  cd aurora-os/shell && xvfb-run -a -s "-screen 0 1600x900x24" node test/notes.unit.mjs
//       (add --node-only to skip the Electron part). Prints "N passed, M failed"; exit code 1 on failure.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SHELL = path.join(here, '..');
const LIB = path.join(SHELL, 'renderer', 'apps', 'notes', 'lib');
const require = createRequire(import.meta.url);

let passed = 0;
let failed = 0;
const failures = [];
function check(name, actual, expected) {
  const ok = typeof expected === 'function' ? !!expected(actual) : JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++;
  else {
    failed++;
    failures.push(name);
    console.log(`  ✗ ${name}\n      got:      ${JSON.stringify(actual)?.slice(0, 600)}${typeof expected === 'function' ? '' : `\n      expected: ${JSON.stringify(expected)?.slice(0, 600)}`}`);
  }
}
async function rejects(name, p, code) {
  try {
    await p;
    check(`${name} (rejected)`, 'resolved', `error ${code}`);
  } catch (e) {
    check(name, e.code, code);
  }
}
function section(title) {
  console.log(title);
}

// ======================================================================== 1. backend
section('backend: main/ipc/notes.js');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-notes-unit-'));
const OUTSIDE = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-notes-outside-'));
fs.mkdirSync(path.join(HOME, 'Documents'), { recursive: true });
process.env.HOME = HOME;
const backend = require(path.join(SHELL, 'main', 'ipc', 'notes.js'));
const H = {};
backend({
  handle: (ch, fn) => (H[ch] = fn),
  error: (message, code) => Object.assign(new Error(message), { code }),
});
const call = (ch, ...args) => Promise.resolve().then(() => H[ch](...args));
const ROOT = path.join(HOME, 'Documents', 'Notes');

function png(w = 2, h = 2) {
  const crcT = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b) => {
    let c = 0xffffffff;
    for (const x of b) c = crcT[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  const zlib = require('node:zlib');
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const PNG = png();

{
  const first = await call('notes:open');
  check('open: creates ~/Documents/Notes, first run', [first.root, first.firstRun, first.notes.length, first.index], [ROOT, true, 0, null]);

  // ---- ids
  for (const bad of ['../evil', 'a/b/c/d/e', '..', '.hidden', 'abc', 'x'.repeat(65), '', null, 42, { id: 'nabcdef1' }, 'nabc def', 'nabc\u0000def', 'n%2e%2e%2f']) {
    await rejects(`writeNote refuses id ${JSON.stringify(bad)}`, call('notes:writeNote', bad, { html: '<p>x</p>' }), 'EINVAL');
  }
  await rejects('attach refuses traversal id', call('notes:attach', '../../tmp', { bytes: PNG }), 'EINVAL');
  await rejects('gc refuses traversal id', call('notes:gc', '..', []), 'EINVAL');
  await rejects('duplicate refuses traversal target', call('notes:duplicate', 'nabcdef1', '../../x'), 'EINVAL');
  check('nothing was written outside the notes folder', fs.readdirSync(HOME).sort(), ['Documents']);

  // ---- payload validation
  await rejects('writeNote: null payload', call('notes:writeNote', 'nvalid01', null), 'EINVAL');
  await rejects('writeNote: html must be a string', call('notes:writeNote', 'nvalid01', { html: { toString: () => 'x' } }), 'EINVAL');
  await rejects('writeNote: too large', call('notes:writeNote', 'nvalid01', { html: 'x'.repeat(33 * 1024 * 1024) }), 'ETOOBIG');
  await rejects('writeIndex: array', call('notes:writeIndex', []), 'EINVAL');
  await rejects('writeIndex: notes must be an object', call('notes:writeIndex', { notes: [1, 2] }), 'EINVAL');
  await rejects('writeIndex: notebooks must be an array', call('notes:writeIndex', { notebooks: 'x' }), 'EINVAL');
  await rejects('attach: no source', call('notes:attach', 'nvalid01', null), 'EINVAL');
  await rejects('attach: bytes of the wrong type', call('notes:attach', 'nvalid01', { bytes: 'not bytes' }), 'EINVAL');
  await rejects('attach: not a picture', call('notes:attach', 'nvalid01', { bytes: Buffer.from('#!/bin/sh\necho pwned\n') }), 'ENOTIMAGE');
  await rejects('attach: html disguised as png data URL', call('notes:attach', 'nvalid01', { dataUrl: `data:image/png;base64,${Buffer.from('<html><script>alert(1)</script>').toString('base64')}` }), 'ENOTIMAGE');
  await rejects('attach: malformed data URL', call('notes:attach', 'nvalid01', { dataUrl: 'data:image/png,%E0%A4%A' }), 'EINVAL');
  await rejects('attach: relative path refused', call('notes:attach', 'nvalid01', { path: '../../etc/hostname' }), 'EINVAL');
  await rejects('attach: url must be http(s)', call('notes:attach', 'nvalid01', { url: 'file:///etc/passwd' }), 'EINVAL');
  const huge = path.join(OUTSIDE, 'huge.png');
  fs.writeFileSync(huge, PNG);
  fs.truncateSync(huge, 51 * 1024 * 1024);
  await rejects('attach: picture over 50 MB refused (size checked before reading)', call('notes:attach', 'nvalid01', { path: huge }), 'ETOOBIG');
  fs.rmSync(huge);
  await rejects('remove: too many ids', call('notes:remove', Array.from({ length: 10001 }, (_, i) => `n${String(i).padStart(6, '0')}`)), 'EINVAL');

  // ---- attachments: names are generated, never taken from the caller
  const a1 = await call('notes:attach', 'nvalid01', { bytes: new Uint8Array(PNG), name: '../../../.bashrc/évil name.png' });
  check('attach: generated safe name', a1.name, (n) => /^att-[a-z0-9]{8}-[a-z0-9-]+\.png$/.test(n) && n.includes('evil-name'));
  check('attach: stored inside the note folder', path.dirname(a1.path), path.join(ROOT, 'nvalid01'));
  check('attach: type from bytes', a1.mime, 'image/png');
  const a2 = await call('notes:attach', 'nvalid01', { dataUrl: `data:image/jpeg;base64,${PNG.toString('base64')}` });
  check('attach: declared type ignored (png bytes -> .png)', a2.name.endsWith('.png'), true);
  const goodSvg = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10"><defs><linearGradient id="g"/></defs><rect width="10" height="10" fill="url(#g)"/><use xlink:href="#g"/><image xlink:href="data:image/png;base64,AAAA"/></svg>';
  const sv = await call('notes:attach', 'nvalid01', { bytes: Buffer.from(goodSvg), name: 'logo.svg' });
  check('attach: plain SVG accepted', sv.mime, 'image/svg+xml');
  const badSvgs = [
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>',
    '<svg xmlns="http://www.w3.org/2000/svg"><rect ONCLICK = "alert(1)"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><iframe src="https://evil.example"/></foreignObject></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><a xlink:href="javascript:alert(1)"><rect/></a></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><a href="jAvAsCrIpT:alert(1)"><rect/></a></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><use href="https://evil.example/x.svg#a"/></svg>',
    '<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg"><text>&x;</text></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><image xlink:href="https://tracker.example/p.png"/></svg>',
  ];
  for (const [i, svg] of badSvgs.entries()) await rejects(`attach: active SVG #${i + 1} refused`, call('notes:attach', 'nvalid01', { bytes: Buffer.from(svg) }), 'ENOTIMAGE');

  // ---- writes: atomic, serialized, no temp files left
  const html = '<p>Hello <b>world</b> &amp; "quotes" <!--aurora:body--> fake marker <!--/aurora:body--> end</p>';
  const meta = { id: 'nvalid01', title: 'T "q" </title><script>x</script> -->', notebook: { id: 'bxx1', name: '"><img src=x onerror=1>' } };
  await call('notes:writeNote', 'nvalid01', { html, meta, title: meta.title, lang: 'fr"><script>' });
  const page1 = fs.readFileSync(path.join(ROOT, 'nvalid01', 'note.html'), 'utf8');
  check('note.html: title escaped in <title> and <h1>', [page1.includes('<script>x</script>'), page1.includes('&lt;/title&gt;&lt;script&gt;')], [false, true]);
  check('note.html: lang attribute cannot be injected', page1.includes('<html lang="en">'), true);
  const parsed = backend.parsePage(page1);
  check('note.html: body round trip (even with marker look-alikes inside)', parsed.html, html);
  check('note.html: metadata round trip', parsed.meta, meta);

  // concurrent saves: 40 writes in flight, the last one wins and the file is always complete
  const writes = [];
  for (let i = 0; i < 40; i++) writes.push(call('notes:writeNote', 'nvalid01', { html: `<p>${'v'.repeat(2000)}${i}</p>`, meta: { i } }));
  await Promise.all(writes);
  const last = backend.parsePage(fs.readFileSync(path.join(ROOT, 'nvalid01', 'note.html'), 'utf8'));
  check('concurrent saves: last write wins', [last.meta.i, last.html.endsWith('39</p>')], [39, true]);
  check('concurrent saves: no temp file left', fs.readdirSync(path.join(ROOT, 'nvalid01')).filter((f) => f.endsWith('.tmp')), []);

  // ---- index: backup, corruption recovery
  const idx1 = { version: 1, notebooks: [{ id: 'bxx1', name: 'One' }], notes: { nvalid01: { title: 'one', modified: 1 } } };
  const idx2 = { version: 1, notebooks: [{ id: 'bxx1', name: 'Two' }], notes: { nvalid01: { title: 'two', modified: 2 } } };
  await call('notes:writeIndex', idx1);
  await call('notes:writeIndex', idx2);
  check('index: previous version kept as .bak', JSON.parse(fs.readFileSync(path.join(ROOT, 'notes.json.bak'), 'utf8')).notebooks[0].name, 'One');
  const full = fs.readFileSync(path.join(ROOT, 'notes.json'), 'utf8');
  fs.writeFileSync(path.join(ROOT, 'notes.json'), full.slice(0, Math.floor(full.length / 2))); // truncated by a crash / full disk
  let o = await call('notes:open');
  check('truncated index: recovered from the backup', [o.indexSource, o.index?.notebooks?.[0]?.name, o.firstRun], ['backup', 'One', false]);
  // the next save must not copy the damaged file over the good backup
  await call('notes:writeIndex', idx2);
  check('damaged index never replaces the backup', JSON.parse(fs.readFileSync(path.join(ROOT, 'notes.json.bak'), 'utf8')).notebooks[0].name, 'One');
  fs.writeFileSync(path.join(ROOT, 'notes.json'), '{"version":1,"notes":');
  fs.writeFileSync(path.join(ROOT, 'notes.json.bak'), 'garbage\u0000');
  o = await call('notes:open');
  check('index and backup unreadable: notes still listed from their files', [o.index, o.indexSource, o.notes.map((n) => n.id), o.notes[0].meta.i], [null, 'none', ['nvalid01'], 39]);
  fs.writeFileSync(path.join(ROOT, 'notes.json'), '[1,2,3]');
  o = await call('notes:open');
  check('index of the wrong shape ignored', o.index, null);

  // ---- note file recovery
  fs.mkdirSync(path.join(ROOT, 'ntrunc01'));
  const page = fs.readFileSync(path.join(ROOT, 'nvalid01', 'note.html'), 'utf8');
  fs.writeFileSync(path.join(ROOT, 'ntrunc01', 'note.html'), page.slice(0, page.indexOf('<!--/aurora:body-->') - 10));
  fs.mkdirSync(path.join(ROOT, 'nnofile1'));
  fs.writeFileSync(path.join(ROOT, 'nnofile1', 'att-aaaaaaaa.png'), PNG); // pictures but no note.html
  fs.mkdirSync(path.join(ROOT, 'nhand001'));
  fs.writeFileSync(path.join(ROOT, 'nhand001', 'note.html'), '<html><head><title>Edited &amp; saved</title></head><body><h1 class="aurora-title">Edited</h1><p>by hand</p></body></html>');
  fs.writeFileSync(path.join(ROOT, 'nvalid01', '.note.html.123.dead.tmp'), 'partial');
  fs.utimesSync(path.join(ROOT, 'nvalid01', '.note.html.123.dead.tmp'), new Date(Date.now() - 3600e3), new Date(Date.now() - 3600e3));
  fs.writeFileSync(path.join(ROOT, 'nvalid01', '.note.html.124.live.tmp'), 'being written');
  o = await call('notes:open');
  const byId = Object.fromEntries(o.notes.map((n) => [n.id, n]));
  check('truncated note file: body recovered', byId.ntrunc01 && byId.ntrunc01.html.startsWith('<p>vvvv') && !byId.ntrunc01.html.includes('<style'), true);
  check('folder without note.html is not a note', 'nnofile1' in byId, false);
  check('note edited by hand: body and title recovered', [byId.nhand001?.html, byId.nhand001?.meta?.title], ['<p>by hand</p>', 'Edited & saved']);
  check('stale temp file removed, fresh one kept', fs.readdirSync(path.join(ROOT, 'nvalid01')).filter((f) => f.endsWith('.tmp')), ['.note.html.124.live.tmp']);
  check('parsePage: garbage does not throw', typeof backend.parsePage('<meta name="aurora-note" content="{&quot;x">\u0000<!--aurora:body-->').html, 'string');

  // ---- symlinks and traversal
  const secret = path.join(OUTSIDE, 'secret.png');
  fs.writeFileSync(secret, PNG);
  fs.writeFileSync(path.join(OUTSIDE, 'secret.txt'), 'top secret');
  const nd = path.join(ROOT, 'nvalid01');
  fs.symlinkSync(secret, path.join(nd, 'att-linklink.png'));
  fs.symlinkSync(path.join(OUTSIDE, 'secret.txt'), path.join(nd, 'att-linktext.png'));
  await rejects('dataUrl: symlink out of the notes folder refused', call('notes:dataUrl', path.join(nd, 'att-linklink.png')), 'EACCES');
  await rejects('dataUrl: ../ out of the notes folder refused', call('notes:dataUrl', `${nd}/../../../${path.relative(HOME, secret)}`), 'EACCES');
  await rejects('dataUrl: relative path refused', call('notes:dataUrl', 'nvalid01/att-x.png'), 'EACCES');
  await rejects('dataUrl: non-string refused', call('notes:dataUrl', { toString: () => secret }), 'EACCES');
  check('dataUrl: real attachment', (await call('notes:dataUrl', a1.path)).startsWith('data:image/png;base64,iVBOR'), true);
  await rejects('dataUrl: not a picture', call('notes:dataUrl', path.join(nd, 'note.html')), 'ENOTIMAGE');
  const exp = path.join(OUTSIDE, 'export_files');
  const copied = await call('notes:exportAssets', 'nvalid01', [a1.name, 'att-linklink.png', 'att-linktext.png', '../../../.bashrc', 'note.html', '.note.html.124.live.tmp', a1.name], exp);
  check('exportAssets: only real attachments copied (no symlink, traversal, note file, duplicates)', [copied, fs.readdirSync(exp)], [1, [a1.name]]);
  await rejects('exportAssets: relative destination refused', call('notes:exportAssets', 'nvalid01', [a1.name], 'rel/dir'), 'EINVAL');
  await rejects('exportAssets: names must be a list', call('notes:exportAssets', 'nvalid01', 'att-x.png', exp), 'EINVAL');
  // a note folder replaced by a link to somewhere else
  fs.symlinkSync(OUTSIDE, path.join(ROOT, 'nlinked1'));
  await rejects('writeNote: symlinked note folder refused', call('notes:writeNote', 'nlinked1', { html: 'x' }), 'EACCES');
  await rejects('attach: symlinked note folder refused', call('notes:attach', 'nlinked1', { bytes: PNG }), 'EACCES');
  await rejects('gc: symlinked note folder refused', call('notes:gc', 'nlinked1', []), 'EACCES');
  check('nothing written through the link', fs.readdirSync(OUTSIDE).sort(), ['export_files', 'secret.png', 'secret.txt']);
  o = await call('notes:open');
  check('open: symlinked note folder ignored', o.notes.some((n) => n.id === 'nlinked1'), false);
  fs.mkdirSync(path.join(ROOT, 'nlinkfil'));
  fs.symlinkSync(path.join(OUTSIDE, 'secret.txt'), path.join(ROOT, 'nlinkfil', 'note.html'));
  o = await call('notes:open');
  check('open: symlinked note.html not read', o.notes.some((n) => n.id === 'nlinkfil'), false);

  // ---- gc: only unreferenced attachments, never other files or link targets
  fs.writeFileSync(path.join(nd, 'notes-extra.txt'), 'keep me');
  const removed = await call('notes:gc', 'nvalid01', [a1.name, '../../notes.json']);
  const left = fs.readdirSync(nd).sort();
  check('gc: unreferenced attachments removed, referenced kept', [left.includes(a1.name), left.includes(a2.name), left.includes(sv.name), left.includes('note.html'), left.includes('notes-extra.txt')], [true, false, false, true, true]);
  check('gc: links removed, their targets untouched', [left.includes('att-linklink.png'), fs.existsSync(secret), fs.existsSync(path.join(OUTSIDE, 'secret.txt'))], [false, true, true]);
  check('gc: count', removed, 4);
  await rejects('gc: keep must be a list', call('notes:gc', 'nvalid01', 'att-x.png'), 'EINVAL');
  // gc running while a picture is being written never deletes the new picture's bytes mid-write
  const big = Buffer.concat([PNG, Buffer.alloc(4 * 1024 * 1024)]);
  const [att] = await Promise.all([call('notes:attach', 'nvalid01', { bytes: big }), call('notes:gc', 'nvalid01', [a1.name])]);
  check('gc + attach race: the attach either completes before or after the collection', fs.existsSync(att.path) ? fs.statSync(att.path).size : 'collected', (v) => v === big.length || v === 'collected');

  // ---- duplicate / remove
  await rejects('duplicate: missing source', call('notes:duplicate', 'nmissing', 'ncopy001'), 'ENOENT');
  check('duplicate: no half-made target left', fs.existsSync(path.join(ROOT, 'ncopy001')), false);
  await rejects('duplicate: existing target', call('notes:duplicate', 'nvalid01', 'ntrunc01'), 'EEXIST');
  await rejects('duplicate: onto itself', call('notes:duplicate', 'nvalid01', 'nvalid01'), 'EINVAL');
  fs.symlinkSync(secret, path.join(nd, 'att-linklnk2.png'));
  await call('notes:duplicate', 'nvalid01', 'ncopy002');
  check('duplicate: files copied, symlinks and temp files not', fs.readdirSync(path.join(ROOT, 'ncopy002')).sort(), fs.readdirSync(nd).filter((f) => !f.endsWith('.tmp') && f !== 'att-linklnk2.png').sort());
  await rejects('remove: one bad id -> nothing removed', call('notes:remove', ['ncopy002', '../Documents']), 'EINVAL');
  check('remove: valid ids before the bad one survive', fs.existsSync(path.join(ROOT, 'ncopy002')), true);
  check('remove: removes the folders', [await call('notes:remove', ['ncopy002', 'nlinked1']), fs.existsSync(path.join(ROOT, 'ncopy002')), fs.existsSync(path.join(ROOT, 'nlinked1')), fs.existsSync(OUTSIDE)], [2, false, false, true]);
  check('remove: a link is removed, never what it points to', fs.readdirSync(OUTSIDE).sort(), ['export_files', 'secret.png', 'secret.txt']);
  // a save racing with the removal never resurrects a half note after it
  const wr = call('notes:writeNote', 'nrace001', { html: '<p>x</p>' });
  const rm = call('notes:remove', ['nrace001']);
  await Promise.all([wr, rm]);
  check('write then remove (serialized): folder gone', fs.existsSync(path.join(ROOT, 'nrace001')), false);

  check('sniff: types from magic bytes', [backend.sniff(PNG), backend.sniff(Buffer.from([0xff, 0xd8, 0xff, 0])), backend.sniff(Buffer.from('GIF89a')), backend.sniff(Buffer.from('  <svg>')), backend.sniff(Buffer.from('PK\u0003\u0004')), backend.sniff(null)], ['png', 'jpg', 'gif', 'svg', null, null]);
}

// ======================================================================== 2. Markdown import (pure)
section('markdown import (Node)');
{
  const md = await import(pathToFileURL(path.join(LIB, 'markdown.js')).href);
  const T = (s) => md.markdownToHtml(s);
  check('md: script tag stays text', T('<script>alert(1)</script>'), '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  check('md: raw img with handler stays text', T('<img src=x onerror=alert(1)>'), '<p>&lt;img src=x onerror=alert(1)&gt;</p>');
  check('md: allowed raw tags only without attributes', T('<u>u</u> <u onclick="x">v</u> <mark style="x">m</mark>'), (h) => h.startsWith('<p><u>u</u> &lt;u onclick=&quot;x&quot;&gt;v') && !/<(u|mark)\s/.test(h));
  check('md: link URL attribute cannot be broken out of', T('[x](https://a.example/"onmouseover="alert(1))'), (h) => !/"\s*onmouseover=/.test(h) && h.includes('&quot;'));
  check('md: image alt cannot be broken out of', T('![a" onerror="alert(1)](x.png)'), (h) => !/" onerror="/.test(h));
  check('md: code fence content escaped', T('```\n<script>x</script>\n```'), '<pre>&lt;script&gt;x&lt;/script&gt;</pre>');
  check('md: inline code escaped', T('`<b>`'), '<p><code>&lt;b&gt;</code></p>');
  check('md: headings, quote, lists, task list, hr, table', T('# H1\n## H2\n#### H4\n> quoted\n\n- a\n- b\n\n1. one\n2. two\n\n- [x] done\n- [ ] todo\n\n---\n\n| A | B |\n| --- | --- |\n| 1 | 2 |'),
    '<h1>H1</h1><h2>H2</h2><h3>H4</h3><blockquote>quoted</blockquote><ul><li>a</li><li>b</li></ul><ol><li>one</li><li>two</li></ol><ul data-type="checklist"><li data-checked="true">done</li><li data-checked="false">todo</li></ul><hr><table><tbody><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></tbody></table>');
  check('md: emphasis', T('**b** *i* ~~s~~ ==m== __b2__ _i2_ snake_case'), '<p><b>b</b> <i>i</i> <s>s</s> <mark>m</mark> <b>b2</b> <i>i2</i> snake_case</p>');
  check('md: backslash escapes', T('\\# not \\*em\\* \\[x\\] 1\\. \\<b\\>'), '<p># not *em* [x] 1. &lt;b&gt;</p>');
  check('md: nested list', T('- a\n  - b\n    - c\n- d'), '<ul><li>a<ul><li>b<ul><li>c</li></ul></li></ul></li><li>d</li></ul>');
  check('md: title from leading heading', md.markdownTitle('﻿# My \\*title\\*\n\nbody'), { title: 'My *title*', body: '\nbody' });
  check('md: CRLF + tabs', T('a\r\nb\r\n\r\n\tcode'), '<p>a b</p><pre>code</pre>');
  check('md: pathological input is linear-ish (no ReDoS)', (() => {
    const t0 = Date.now();
    T(`${'*'.repeat(20000)}a${'_'.repeat(20000)} ${'['.repeat(5000)}x${']('.repeat(5000)} ${'`'.repeat(5000)} ${'=='.repeat(5000)}`);
    T(`${'> '.repeat(400)}deep`);
    T(`${'- '.repeat(2000)}x`);
    return Date.now() - t0;
  })(), (ms) => ms < 4000);
}

// text helpers (pure parts)
{
  const tx = await import(pathToFileURL(path.join(LIB, 'text.js')).href);
  const ids = new Set(Array.from({ length: 2000 }, () => tx.newId('n')));
  check('newId: unique and valid for the backend', [ids.size, [...ids].every((id) => /^[A-Za-z0-9_-]{6,64}$/.test(id))], [2000, true]);
  check('extractTags: #tags only, no html', tx.extractTags('#work and #été, not a#b, <#x> #tag_1 #123'), (t) => Array.isArray(t) && t.includes('work') && !t.some((x) => /[<>"]/.test(x)));
}

const nodeOnly = process.argv.includes('--node-only');

// ======================================================================== 3. renderer (Electron)
if (!nodeOnly) {
  section('renderer: sanitizer, Markdown round trip, store (Electron)');
  console.log('  (expected: a few "Failed to load resource" lines, the corpus\' allowed remote / attachment pictures loading)');
  const { launchShell } = await import('./lib.mjs');
  const s = await launchShell({ settle: 300 });
  const errors = [];
  s.page.on('pageerror', (e) => errors.push(e.message));
  s.page.on('dialog', (d) => {
    errors.push(`dialog: ${d.message()}`);
    d.dismiss().catch(() => {});
  });
  try {
    // ---------------------------------------------------------------- XSS corpus
    const res = await s.page.evaluate(async () => {
      const S = await import('app://shell/apps/notes/lib/sanitize.js');
      window.__xss = 0;
      const X = 'window.__xss=(window.__xss||0)+1';
      const js = [
        'javascript:' + X,
        'JaVaScRiPt:' + X,
        ' javascript:' + X,
        '\u0001javascript:' + X,
        'java\u0000script:' + X,
        'java&#x09;script:' + X,
        'java&#10;script:' + X,
        'java&Tab;script:' + X,
        '&#106;&#97;&#118;&#97;&#115;&#99;&#114;&#105;&#112;&#116;&#58;' + X,
        '&#x6A&#x61&#x76&#x61&#x73&#x63&#x72&#x69&#x70&#x74&#x3A' + X,
        'javascript&colon;' + X,
        'jav&#x0D;ascript:' + X,
        '​javascript:' + X,
        'vbscript:msgbox(1)',
        'VBScript:msgbox(1)',
        'data:text/html,<script>' + X + '</script>',
        'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
        'DATA:text/html;charset=utf-8,<script>' + X + '</script>',
        'data:image/svg+xml,<svg onload="' + X + '">',
        'data:application/javascript,' + X,
        'file:///etc/passwd',
        'app://shell/index.html',
        'blob:null/123',
        '//evil.example/x',
        'about:blank',
        'chrome://settings',
      ];
      const P = [];
      for (const u of js) {
        P.push(`<a href="${u}">link</a>`, `<img src="${u}">`, `<a href='${u}'>q</a>`, `<a href=${u.replace(/ /g, '')}>u</a>`);
      }
      const handlers = ['onerror', 'onload', 'ONERROR', 'oNlOaD', 'onmouseover', 'onclick', 'onfocus', 'onanimationstart', 'onpointerenter', 'onbegin', 'ontoggle', 'onbeforetoggle', 'onscrollend', 'onfocusin'];
      for (const h of handlers) {
        P.push(`<img src=x ${h}="${X}">`, `<div ${h}="${X}">d</div>`, `<p tabindex=1 autofocus ${h}=${X}>p</p>`, `<b ${h} = '${X}'>b</b>`, `<a href="https://ok.example" ${h}="${X}">ok</a>`);
      }
      P.push(
        `<script>${X}</script>`,
        `<SCRIPT SRC=https://evil.example/x.js></SCRIPT>`,
        `<scr<script>ipt>${X}</scr</script>ipt>`,
        `<script\x20type="text/javascript">${X}</script>`,
        `<<script>${X};//<</script>`,
        `<style>@import 'https://evil.example/x.css'; body{background:url("javascript:${X}")}</style>`,
        `<div style="background:url(javascript:${X})">s</div>`,
        `<div style="width:expression(${X})">e</div>`,
        `<div style="behavior:url(x.htc);-moz-binding:url(x.xml#x)">b</div>`,
        `<span style="font-weight:bold;background-image:url('javascript:${X}')">bold</span>`,
        `<iframe src="javascript:${X}"></iframe>`,
        `<iframe srcdoc="<script>parent.${X}</script>"></iframe>`,
        `<frameset onload="${X}"><frame src="javascript:${X}"></frameset>`,
        `<object data="javascript:${X}"></object>`,
        `<object data="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=="></object>`,
        `<embed src="javascript:${X}">`,
        `<embed src="data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+">`,
        `<applet code="x"></applet>`,
        `<svg onload="${X}"><circle r=1 /></svg>`,
        `<svg><script>${X}</script></svg>`,
        `<svg><animate onbegin="${X}" attributeName=x dur=1s></svg>`,
        `<svg><set attributeName="href" to="javascript:${X}"/><a><text>t</text></a></svg>`,
        `<svg><use href="data:image/svg+xml,&lt;svg id='x' xmlns='http://www.w3.org/2000/svg'&gt;&lt;image href='x' onerror='${X}'/&gt;&lt;/svg&gt;#x"/></svg>`,
        `<svg><foreignObject><img src=x onerror="${X}"></foreignObject></svg>`,
        `<math><maction actiontype="statusline" xlink:href="javascript:${X}">m</maction></math>`,
        `<math href="javascript:${X}">CLICK</math>`,
        `<template><img src=x onerror="${X}"></template>`,
        `<details open ontoggle="${X}"><summary>s</summary>d</details>`,
        `<video><source onerror="${X}"></video>`,
        `<audio src=x onerror="${X}"></audio>`,
        `<video poster=javascript:${X}></video>`,
        `<input autofocus onfocus="${X}">`,
        `<input type="image" src=x onerror="${X}">`,
        `<keygen autofocus onfocus="${X}">`,
        `<select autofocus onfocus="${X}"><option>o</option></select>`,
        `<textarea autofocus onfocus="${X}">t</textarea>`,
        `<marquee onstart="${X}">m</marquee>`,
        `<body onload="${X}">body</body>`,
        `<html onmouseover="${X}">html</html>`,
        `<isindex type=image src=1 onerror="${X}">`,
        `<form action="javascript:${X}"><button>go</button></form>`,
        `<form><button formaction="javascript:${X}">f</button></form>`,
        `<form id=f></form><button form=f formaction="javascript:${X}">x</button>`,
        `<meta http-equiv="refresh" content="0;url=javascript:${X}">`,
        `<meta charset="x-imap4-modified-utf7">`,
        `<base href="javascript:${X}//">`,
        `<link rel="stylesheet" href="https://evil.example/x.css">`,
        `<link rel="import" href="data:text/html,<script>${X}</script>">`,
        `<img src="x" srcset="javascript:${X} 1x, https://evil.example/t.png 2x">`,
        `<picture><source srcset="https://evil.example/x.png"><img src=x onerror="${X}"></picture>`,
        `<img src=x:alert(alt) onerror=eval(src) alt=0>`,
        `<img """><script>${X}</script>">`,
        `<img src="x` + '`' + `onerror=${X}>`,
        `<img/src="x"/onerror="${X}">`,
        `<img src=x onerror\x0b="${X}">`,
        `<img src=x onerror　="${X}">`,
        `<a href="https://ok.example" target="_blank" rel="opener" ping="https://evil.example" download>t</a>`,
        `<a href="https://ok.example" style="position:fixed;inset:0">overlay</a>`,
        `<div id="__aurora" class="win app-notes" name="x" role="dialog" data-tip="x" contenteditable="true">attrs</div>`,
        `<x-custom onclick="${X}" is="x">custom</x-custom>`,
        `<dialog open onclose="${X}">dlg</dialog>`,
        `<portal src="https://evil.example"></portal>`,
        `<slot onslotchange="${X}">s</slot>`,
        // mutation XSS (parser differentials, re-parse of serialized output)
        `<noscript><p title="</noscript><img src=x onerror=${X}>"></noscript>`,
        `<svg></p><style><a id="</style><img src=1 onerror=${X}>">`,
        `<svg><p><style><img src=x onerror=${X}></style></p></svg>`,
        `<math><mtext><table><mglyph><style><img src=x onerror="${X}"></style></mglyph></table></mtext></math>`,
        `<form><math><mtext></form><form><mglyph><svg><mtext><style><path id="</style><img onerror=${X} src>">`,
        `<math><mi//xlink:href="data:x,<script>${X}</script>">`,
        `<listing>&lt;img src=x onerror=${X}&gt;</listing>`,
        `<xmp><img src=x onerror="${X}"></xmp>`,
        `<plaintext><img src=x onerror="${X}">`,
        `<title><img src=x onerror="${X}"></title>`,
        `<noembed><img src=x onerror="${X}"></noembed>`,
        `<noframes><img src=x onerror="${X}"></noframes>`,
        `<iframe><img src=x onerror="${X}"></iframe>`,
        `<textarea><img src=x onerror="${X}"></textarea>`,
        `<!--<img src=x onerror="${X}">-->`,
        `<!--><img src=x onerror="${X}">-->`,
        `<![CDATA[<img src=x onerror="${X}">]]>`,
        `<?xml version="1.0"?><img src=x onerror="${X}">`,
        `<a href="https://ok.example"><a href="javascript:${X}">nested</a></a>`,
        `<table><tr><td><style><img src=x onerror="${X}"></style></td></tr><img src=x onerror="${X}"></table>`,
        `<table><caption><img src=x onerror="${X}"></caption></table>`,
        `<p>${'<b>'.repeat(600)}deep${'</b>'.repeat(600)}</p>`,
        `<div title="&lt;img src=x onerror=${X}&gt;">entity title</div>`,
        `<a href="https://ok.example" title="&quot;&gt;&lt;img src=x onerror=${X}&gt;">t</a>`,
        `<pre>&lt;/pre&gt;&lt;img src=x onerror=${X}&gt;</pre>`,
        `<code>&lt;script&gt;${X}&lt;/script&gt;</code>`,
        `<img src="data:image/png;base64,iVBORw0KGgo=" onerror="${X}" alt="&quot;onerror=&quot;${X}">`,
        `<img src="https://evil.example/t.png" onerror="${X}">`,
        `<img src="media:///etc/passwd" onerror="${X}">`,
        `<li data-checked="true\" onclick=\"${X}">x</li>`,
        `<ul data-type="checklist" onclick="${X}"><li data-checked="maybe">x</li></ul>`,
        `<span data-color="red;background:url(javascript:${X})">c</span>`,
        `<mark data-hl="url(javascript:${X})">h</mark>`,
        `<ol start="1e9" type="javascript:${X}"><li>x</li></ol>`,
        `<td colspan="999999" rowspan="-1">x</td>`,
        `<img src="att-abcdefgh-pic.png" data-att="../../../etc/passwd">`,
        `<img src="../../../.ssh/id_rsa.png">`,
        `<img src="/etc/passwd">`,
      );
      const OPTS = [
        { name: 'paste', o: { collapseWhitespace: true, allowMedia: true, allowRemote: true } },
        { name: 'stored', o: { attachments: true, allowMedia: true, allowRemote: true } },
        { name: 'strict', o: {} },
      ];
      const ALLOWED_TAGS = new Set(['B', 'I', 'U', 'S', 'MARK', 'CODE', 'SUB', 'SUP', 'A', 'IMG', 'BR', 'HR', 'SPAN', 'P', 'DIV', 'H1', 'H2', 'H3', 'BLOCKQUOTE', 'PRE', 'UL', 'OL', 'LI', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH']);
      const ALLOWED_ATTRS = { A: ['href', 'title'], IMG: ['src', 'alt', 'width', 'data-att'], OL: ['start'], UL: ['data-type'], LI: ['data-checked'], TD: ['colspan', 'rowspan'], TH: ['colspan', 'rowspan'], SPAN: ['data-color'], MARK: ['data-hl'] };
      const bad = [];
      const unstable = [];
      const outs = {};
      const audit = (root, label) => {
        for (const el of root.querySelectorAll('*')) {
          if (!ALLOWED_TAGS.has(el.tagName)) bad.push(`${label}: tag ${el.tagName}`);
          if (el.namespaceURI !== 'http://www.w3.org/1999/xhtml') bad.push(`${label}: ns ${el.namespaceURI}`);
          for (const a of el.attributes) {
            if (!(ALLOWED_ATTRS[el.tagName] || []).includes(a.name)) bad.push(`${label}: attr ${el.tagName}[${a.name}]`);
            if (a.name === 'href' && !/^(https?:|mailto:|tel:)/.test(a.value)) bad.push(`${label}: href ${a.value}`);
            if (a.name === 'src' && !/^(https?:|media:|data:image\/(png|jpe?g|gif|webp|bmp|avif|svg\+xml|x-icon|vnd\.microsoft\.icon);base64,|att-[a-z0-9]{8}(-[a-z0-9-]{1,40})?\.[a-z0-9]{2,5}$)/.test(a.value)) bad.push(`${label}: src ${a.value}`);
            if (a.name === 'data-att' && !/^att-[a-z0-9]{8}(-[a-z0-9-]{1,40})?\.[a-z0-9]{2,5}$/.test(a.value)) bad.push(`${label}: data-att ${a.value}`);
            if (a.name === 'data-color' && !S.TEXT_COLORS.includes(a.value)) bad.push(`${label}: color ${a.value}`);
            if (a.name === 'data-hl' && !S.HIGHLIGHTS.includes(a.value)) bad.push(`${label}: hl ${a.value}`);
          }
        }
      };
      const host = document.createElement('div');
      host.style.cssText = 'position:fixed;left:-9999px;top:0;width:400px;height:400px;overflow:hidden';
      document.body.appendChild(host);
      // links must never navigate (or run) while the corpus is live
      const stopNav = (e) => e.preventDefault();
      host.addEventListener('click', stopNav, true);
      for (const { name, o } of OPTS) {
        outs[name] = P.map((p) => S.sanitizeHtml(p, o));
        outs[name].forEach((out, i) => {
          // the string output is re-parsed by the editor (innerHTML): it must come back identical
          const live = document.createElement('div');
          live.innerHTML = out;
          host.appendChild(live);
          audit(live, `${name}#${i}`);
          if (live.innerHTML !== out) unstable.push(`${name}#${i}: ${out.slice(0, 200)} -> ${live.innerHTML.slice(0, 200)}`);
          // sanitizing twice changes nothing
          if (S.sanitizeHtml(out, o) !== out) unstable.push(`${name}#${i} not idempotent`);
          // the fragment API (used for paste into the editor) gives the same tree
          const frag = S.sanitizeFragment(P[i], { ...o, doc: S.inertDocument() });
          const box = S.inertDocument().createElement('div');
          box.appendChild(frag);
          if (box.innerHTML !== out) unstable.push(`${name}#${i} fragment differs`);
        });
      }
      // interact with everything that could fire a handler
      for (const el of host.querySelectorAll('*')) {
        for (const type of ['mouseover', 'click', 'focus', 'pointerenter', 'animationstart', 'toggle', 'load', 'error']) el.dispatchEvent(new Event(type, { bubbles: true }));
        el.focus?.();
      }
      await new Promise((r) => setTimeout(r, 800));
      host.removeEventListener('click', stopNav, true);
      host.remove();
      return { n: P.length, xss: window.__xss, bad: [...new Set(bad)], unstable, sample: { link: outs.paste[0], okHandler: outs.paste[js.length * 4 + 4] } };
    });
    check(`XSS corpus: ${res.n} payloads x 3 option sets, nothing ran`, res.xss, 0);
    check('XSS corpus: only allowed tags / attributes / URL schemes survive', res.bad, []);
    check('XSS corpus: output stable when re-parsed (no mutation XSS) and idempotent', res.unstable, []);
    check('XSS corpus: javascript: link keeps its text only', res.sample.link, '<div>link</div>');
    check('XSS corpus: safe link keeps href, loses handler', res.sample.okHandler, '<div><a href="https://ok.example/">ok</a></div>');

    // ---------------------------------------------------------------- formatting that must survive
    const keep = await s.page.evaluate(async () => {
      const S = await import('app://shell/apps/notes/lib/sanitize.js');
      const paste = { collapseWhitespace: true, allowMedia: true, allowRemote: true };
      const stored = { attachments: true, allowMedia: true, allowRemote: true };
      const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
      return {
        inline: S.sanitizeHtml('<p><strong>b</strong> <em>i</em> <u>u</u> <del>s</del> <mark data-hl="green">m</mark> <code>c</code> x<sub>2</sub> y<sup>3</sup> <span data-color="red">red</span></p>', paste),
        blocks: S.sanitizeHtml('<h1>A</h1><h2>B</h2><h5>C</h5><blockquote>q</blockquote><pre>  code\n  more</pre><hr>', stored),
        lists: S.sanitizeHtml('<ul><li>a</li></ul><ol start="3"><li>c</li></ol><ul data-type="checklist"><li data-checked="true">t</li><li data-checked="false">f</li></ul>', stored),
        table: S.sanitizeHtml('<table><thead><tr><th>H</th></tr></thead><tbody><tr><td colspan="2">x</td></tr></tbody></table>', stored),
        links: S.sanitizeHtml('<p><a href="https://example.com/a?b=1&amp;c=2#d" title="T">web</a> <a href="mailto:me@example.com">mail</a> <a href="tel:+33123456789">tel</a> <a href="example.com/page">bare</a></p>', paste),
        img: S.sanitizeHtml(`<img src="${png}" alt="dot" width="120">`, paste),
        att: S.sanitizeHtml('<img src="att-abcdefgh-pic.png" data-att="att-abcdefgh-pic.png">', stored),
        pastedAtt: S.sanitizeHtml('<img src="media://local/home/u/Documents/Notes/nother01/att-abcdefgh-pic.png" data-att="att-abcdefgh-pic.png">', paste),
        styles: S.sanitizeHtml('<span style="font-weight:700">B</span><span style="font-style:italic">I</span><span style="text-decoration:underline line-through">US</span>', paste),
        word: S.sanitizeHtml('<p class="MsoNormal" style="margin:0"><span lang="FR" style="font-family:Calibri">Bonjour <o:p></o:p></span></p>', paste),
        text: S.sanitizeHtml('<p>5 &lt; 6 &amp;&amp; "quotes" \'apos\' © ✓ 😀</p>', paste),
      };
    });
    check('keeps: inline formatting (strong/em/del -> b/i/s, mark, code, sub/sup, colour)', keep.inline, '<p><b>b</b> <i>i</i> <u>u</u> <s>s</s> <mark data-hl="green">m</mark> <code>c</code> x<sub>2</sub> y<sup>3</sup> <span data-color="red">red</span></p>');
    check('keeps: headings (h5 -> h3), quote, code block whitespace, rule', keep.blocks, '<h1>A</h1><h2>B</h2><h3>C</h3><blockquote>q</blockquote><pre>  code\n  more</pre><hr>');
    check('keeps: lists, start, checklist states', keep.lists, '<ul><li>a</li></ul><ol start="3"><li>c</li></ol><ul data-type="checklist"><li data-checked="true">t</li><li data-checked="false">f</li></ul>');
    check('keeps: tables with colspan', keep.table, '<table><thead><tr><th>H</th></tr></thead><tbody><tr><td colspan="2">x</td></tr></tbody></table>');
    check('keeps: http(s) / mailto / tel / bare-domain links', keep.links, '<p><a href="https://example.com/a?b=1&amp;c=2#d" title="T">web</a> <a href="mailto:me@example.com">mail</a> <a href="tel:+33123456789">tel</a> <a href="https://example.com/page">bare</a></p>');
    check('keeps: data:image pictures with alt and width', keep.img, (h) => /^<div><img src="data:image\/png;base64,[^"]+" alt="dot" width="120"><\/div>$/.test(h));
    check('keeps: stored attachment names', keep.att, '<div><img src="att-abcdefgh-pic.png" data-att="att-abcdefgh-pic.png"></div>');
    check('pasted picture from another note loses its attachment name (it gets copied into this note)', keep.pastedAtt, '<div><img src="media://local/home/u/Documents/Notes/nother01/att-abcdefgh-pic.png"></div>');
    check('keeps: pasted CSS bold / italic / underline / strike as tags', keep.styles, '<div><b>B</b><i>I</i><u><s>US</s></u></div>');
    check('Word paste: classes, styles, lang and o:p dropped', keep.word, '<p>Bonjour</p>');
    check('keeps: special characters as text', keep.text, '<p>5 &lt; 6 &amp;&amp; "quotes" \'apos\' © ✓ 😀</p>');

    // ---------------------------------------------------------------- Markdown round trip
    const md = await s.page.evaluate(async () => {
      const S = await import('app://shell/apps/notes/lib/sanitize.js');
      const M = await import('app://shell/apps/notes/lib/markdown.js');
      const doc = S.inertDocument();
      const opts = { attachments: true, allowMedia: true, allowRemote: true };
      const norm = (h) => h.replace(/<(\/?)p>/g, '<$1div>');
      const toMd = (html, o = {}) => {
        const box = doc.createElement('div');
        box.appendChild(S.sanitizeFragment(html, { ...opts, doc }));
        return M.htmlToMarkdown(box, o);
      };
      const back = (mdText) => norm(S.sanitizeHtml(M.markdownToHtml(mdText), opts));
      const cases = {
        headings: '<h1>Title</h1><h2>Sub</h2><h3>Small</h3>',
        inline: '<div><b>bold</b> <i>it</i> <s>gone</s> <u>under</u> <mark data-hl="yellow">hl</mark> <code>a &lt; b</code></div>',
        lists: '<ul><li>one</li><li>two<ul><li>nested</li></ul></li></ul><ol start="4"><li>four</li><li>five</li></ol>',
        checklist: '<ul data-type="checklist"><li data-checked="true">done</li><li data-checked="false">[x] literally</li></ul>',
        quote: '<blockquote>wise words</blockquote>',
        code: '<pre>if (a &lt; b) {\n  return "```";\n}</pre>',
        rule: '<div>above</div><hr><div>below</div>',
        links: '<div><a href="https://example.com/a_(b)?q=1&amp;r=[2]">a [link] (x)</a> <a href="mailto:me@example.com">me</a></div>',
        table: '<table><tbody><tr><th>A|B</th><th>C</th></tr><tr><td>1 *x*</td><td>`2`</td></tr></tbody></table>',
        special: '<div>1. not a list</div><div># not a heading</div><div>&gt; not a quote</div><div>- not a bullet</div><div>+ plus</div><div>--- not a rule</div><div>snake_case *star* _under_ `tick` [br] &lt;tag&gt; \\back ~~st~~ ==hl== | pipe &amp; amp</div><div>2) paren</div>',
        leading: '<div>    four spaces</div><div>\ttab start</div>',
        trailingHash: '<h2>C #</h2><h1>Issue #42</h1>',
        brs: '<div>line one<br>line two</div>',
      };
      const out = {};
      // Markdown has no leading indentation in paragraphs: it is dropped (and never turns a line into code)
      const WANT = { leading: '<div>four spaces</div><div>tab start</div>' };
      for (const [k, html] of Object.entries(cases)) {
        const want = WANT[k] || norm(S.sanitizeHtml(html, opts));
        const text = toMd(html);
        const got = back(text);
        out[k] = { ok: got === want, want, got, md: text };
      }
      // pictures: exported through the callback (attachment -> relative file), imported back as an <img>
      const picMd = toMd('<div><img src="att-abcdefgh-pic.png" data-att="att-abcdefgh-pic.png" alt="a (1)"></div>', { image: (img) => `My Note_files/${img.getAttribute('data-att')}` });
      const picBack = new DOMParser().parseFromString(M.markdownToHtml(picMd), 'text/html').querySelector('img');
      // hostile Markdown never produces anything executable after sanitizing
      const hostile = S.sanitizeHtml(M.markdownToHtml('[x](javascript:alert(1)) [y](<javascript:alert(1)>) ![z](javascript:alert(1)) <https://ok.example> [d](data:text/html,<script>alert(1)</script>) ![e](data:image/svg+xml;base64,PHN2Zz4=) <script>alert(1)</script> <img src=x onerror=alert(1)>'), { allowRemote: true });
      // export -> import -> export is a fixed point
      const all = Object.values(cases).join('');
      const md1 = toMd(all);
      const md2 = toMd(M.markdownToHtml(md1));
      return { out, picMd, pic: [picBack?.getAttribute('src'), picBack?.getAttribute('alt')], hostile, fixed: md1 === md2, md1, md2 };
    });
    for (const [k, v] of Object.entries(md.out)) check(`md round trip: ${k}`, v.ok ? 'same' : { want: v.want, got: v.got, md: v.md }, 'same');
    check('md export: picture -> relative file path (parentheses / spaces encoded)', md.picMd, '![a (1)](My%20Note_files/att-abcdefgh-pic.png)\n');
    check('md import: picture path and alt back', md.pic, ['My Note_files/att-abcdefgh-pic.png', 'a (1)']);
    check('md import: hostile links / pictures / tags neutralised', md.hostile, (h) => {
      const tags = h.match(/<[a-z][^>]*>/gi) || [];
      return tags.every((t) => /^<(p|a href="https:\/\/ok\.example\/"|img src="data:image\/svg\+xml;base64,[^"]+" alt="e")>$/.test(t)) && !/href="(javascript|data)/i.test(h);
    });
    check('md: export -> import -> export is stable', md.fixed ? 'stable' : { md1: md.md1, md2: md.md2 }, 'stable');

    // ---------------------------------------------------------------- store model
    const st = await s.page.evaluate(async () => {
      const { NotesStore, PURGE_DAYS } = await import('app://shell/apps/notes/lib/store.js');
      const DAY = 86400000;
      const now = Date.now();
      const log = [];
      let fail = false;
      const files = {};
      const fakeApi = (open) => ({
        async invoke(ch, ...args) {
          log.push([ch, ...args.map((a) => (typeof a === 'string' ? a : Array.isArray(a) ? a.join(',') : '…'))]);
          await new Promise((r) => setTimeout(r, Math.random() * 8));
          if (fail && ch !== 'notes:open') throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
          if (ch === 'notes:open') return open;
          if (ch === 'notes:writeNote') {
            files[args[0]] = args[1].html;
            return { mtime: Date.now() };
          }
          if (ch === 'notes:remove') return args[0].length;
          return true;
        },
      });
      const open = {
        root: '/home/u/Documents/Notes',
        indexSource: 'main',
        firstRun: false,
        index: {
          notebooks: [{ id: 'bwork01', name: 'Work', color: 'nope', emoji: '<img src=x onerror=alert(1)>' }, { id: '../x', name: 'bad id' }, null, 'junk'],
          notes: {
            nold0001: { title: 'Old trash', notebookId: 'bwork01', modified: now - 40 * DAY, deletedAt: now - 31 * DAY },
            nnew0001: { title: 'Recent trash', notebookId: 'bwork01', modified: now - 2 * DAY, deletedAt: now - 29 * DAY },
            nidx0001: { title: 'index older', notebookId: 'bwork01', modified: 100 },
            ngone001: { title: 'folder deleted outside the app', modified: 5 },
            nbig0001: { title: 'Huge', notebookId: 'bwork01', modified: 50 },
          },
        },
        notes: [
          { id: 'nold0001', meta: null, html: '<p>old</p>', mtime: 1 },
          { id: 'nnew0001', meta: null, html: '<p>recent</p>', mtime: 1 },
          { id: 'nidx0001', meta: { title: 'file newer', notebookId: 'bhome01', notebook: { id: 'bhome01', name: 'Home', color: 'green' }, modified: 200 }, html: '<p>body <img src=x onerror="window.__storeXss=1"> #tag</p><script>window.__storeXss=1</script>', mtime: 1 },
          { id: 'nadopt01', meta: { title: 'adopted', notebookId: 'bmissing', modified: 7 }, html: '<p>found on disk</p>', mtime: 1 },
          { id: 'nbig0001', meta: null, html: '', mtime: 1, tooBig: true },
        ],
      };
      const store = new NotesStore(fakeApi(open));
      const loaded = await store.load();
      const r = { loaded };
      r.ids = [...store.notes.keys()].sort();
      r.purgedRemove = log.filter((l) => l[0] === 'notes:remove').map((l) => l[1]);
      r.notebooks = store.notebooks.map((b) => [b.id, b.name, b.color, b.emoji]);
      const fileNewer = store.get('nidx0001');
      r.fileWins = [fileNewer.title, fileNewer.notebookId, fileNewer.tags, /onerror|script/i.test(fileNewer.html)];
      r.adoptedNb = store.get('nadopt01').notebookId;
      r.indexWritten = log.some((l) => l[0] === 'notes:writeIndex');
      // an unreadable (too big) note file is never overwritten with the empty body we have
      log.length = 0;
      await store.pin('nbig0001', true);
      await store.update('nbig0001', { html: '<p>typed</p>' });
      await store.updateNotebook('bwork01', { name: 'Work 2' });
      await store.flush();
      r.bigWrites = log.filter((l) => l[0] === 'notes:writeNote' && l[1] === 'nbig0001').length;
      // 30-day purge, at any time (hourly while the app is open)
      await store.trash(['nadopt01']);
      store.get('nadopt01').deletedAt = now - (PURGE_DAYS + 1) * DAY;
      r.purgeLater = [await store.purgeExpired(), store.notes.has('nadopt01'), store.notes.has('nnew0001')];
      // rapid edits: serialized per note, the file ends with the last version
      const n = await store.create({ title: 'fast', html: '<p>0</p>' });
      await Promise.all(Array.from({ length: 30 }, (_, i) => store.update(n.id, { html: `<p>${i + 1}</p>` })));
      await store.flush();
      r.lastWins = files[n.id];
      // a failed write is kept, retried, and recovers
      fail = true;
      const events = [];
      store.on((what) => events.push(what));
      await store.update(n.id, { html: '<p>while the disk is full</p>' }).catch(() => {});
      await store.saveIndex(true).catch(() => {});
      r.pending = store.pending;
      fail = false;
      r.retry = [await store.retryNow(), store.pending, files[n.id]];
      r.events = [...new Set(events)];
      // a failure schedules a background retry; fixing it by hand (Retry button = a direct write) cancels it,
      // so no stale retry fires later and re-reports errors
      fail = true;
      await store.update(n.id, { html: '<p>again</p>' }).catch(() => {});
      r.timerAfterFail = !!store.retryTimer;
      fail = false;
      await store.writeNote(n.id);
      r.timerAfterManual = [!!store.retryTimer, store.retryCount, store.pending];
      store.dispose();
      return { ...r, xss: window.__storeXss || 0 };
    });
    check('store load: expired trash purged (> 30 days), recent trash kept', [st.purgedRemove, st.ids.includes('nold0001'), st.ids.includes('nnew0001')], [['nold0001'], false, true]);
    check('store load: folder deleted outside the app dropped, unknown folder adopted', [st.ids.includes('ngone001'), st.ids.includes('nadopt01')], [false, true]);
    check('store load: note file newer than the index wins, its notebook recreated, body sanitized', st.fileWins, ['file newer', 'bhome01', ['tag'], false]);
    check('store load: invalid notebooks dropped, bad colour / emoji cleaned, notebooks known from note files recreated', st.notebooks, [['bwork01', 'Work', 'blue', ''], ['bhome01', 'Home', 'green', ''], ['bmissing', 'Notebook', 'blue', '']]);
    check('store load: adopted note keeps its (recreated) notebook; index rewritten', [st.adoptedNb, st.indexWritten], ['bmissing', true]);
    check('store: unreadable (too big) note file never overwritten', st.bigWrites, 0);
    check('store: purge after 30 days while open', st.purgeLater, [1, false, true]);
    check('store: 30 rapid saves, last version on disk', st.lastWins, '<p>30</p>');
    check('store: failed write kept in memory and retried', [st.pending, ...st.retry], [true, true, false, '<p>while the disk is full</p>']);
    check('store: error then saved events', st.events.includes('error') && st.events.includes('saved'), true);
    check('store: background retry scheduled on failure, cancelled by a successful manual retry', [st.timerAfterFail, ...st.timerAfterManual], [true, false, 0, false]);
    check('store: nothing ran while loading hostile note files', st.xss, 0);
    check('renderer: no page errors / dialogs', errors, []);
  } finally {
    await s.close();
  }
}

fs.rmSync(HOME, { recursive: true, force: true });
fs.rmSync(OUTSIDE, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) console.log(`Failed: ${failures.join(' | ')}`);
process.exit(failed ? 1 : 0);
