// Numérisation (apps/scan) + main/ipc/scan.js + Paramètres > Imprimantes et scanners « Scanners », against the fake
// scanimage of test/fixtures/scan/bin (put first on PATH, AURORA_SCAN_FIXTURE=1; its scanners and failures are set
// through $AURORA_SCAN_FAKE_DIR/ctl.json and it logs every argv to calls.log). No real scanner is used.
//   Device list (webcam left out, a network scanner seen three times listed once), options (modes, sources,
//   150 / 300 / 600 presets on the scanner's own values), preview (75 dpi, whole glass), the selection (handle drag,
//   move, draw, keyboard, « Détecter le document »), scans with the chosen area / resolution / mode, progress, pages
//   (rotate, move by buttons / Ctrl+arrows / drag, delete + undo, brightness), saving: multi-page PDF read back by
//   pdf.js (page count, MediaBox = pixels / dpi × 72), JPEG / PNG one file per page with their dpi, « Enregistrer
//   sous », « Ouvrir » / « Afficher dans Fichiers », « Envoyer par courriel » (Courrier with the files attached),
//   cancel (process group gone, nothing kept), errors (busy, cover, empty feeder, jam with pages kept, disconnected,
//   permission denied), feeder batch + duplex, no scanner, backend argument checks, close with unsaved pages, the
//   Scanners section of Paramètres, English folder « Scans ». Screenshots fr / en × dark / light in test/out/scan-*.
// Usage:  cd aurora-os/shell && xvfb-run -a -s "-screen 0 1600x900x24" node test/scan.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launchShell } from './lib.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE_BIN = path.join(ROOT, 'test', 'fixtures', 'scan', 'bin');
let passed = 0;
const failures = [];
function check(name, actual, expected) {
  const ok = typeof expected === 'function' ? !!expected(actual) : Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++;
  else failures.push(`${name}\n      expected: ${typeof expected === 'function' ? '(predicate)' : JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
  return ok;
}
async function section(name, fn) {
  const t0 = Date.now();
  const before = failures.length;
  try {
    await fn();
    console.log(`  ${failures.length === before ? '✓' : '✗'} ${name} (${Date.now() - t0} ms)`);
  } catch (err) {
    failures.push(`${name}: threw ${err?.stack || err}`);
    console.log(`  ✗ ${name}: ${err?.message || err}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const unit = spawnSync(process.execPath, ['--no-warnings', path.join(ROOT, 'test', 'scan.unit.mjs')], { encoding: 'utf8' });
process.stdout.write(unit.stdout.split('\n').filter((l) => !/^\s+ok /.test(l)).join('\n'));
check('scan.unit.mjs passes', unit.status, 0);

const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-scan-fake-'));
const ctl = (o = {}) => fs.writeFileSync(path.join(fakeDir, 'ctl.json'), JSON.stringify(o));
const calls = () => (fs.existsSync(path.join(fakeDir, 'calls.log')) ? fs.readFileSync(path.join(fakeDir, 'calls.log'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const lastScan = () => calls().filter((c) => c.args.some((a) => a.startsWith('--format='))).pop();
const argOf = (c, name) => {
  const a = c?.args || [];
  const eq = a.find((x) => x.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = a.indexOf(name);
  return i >= 0 ? a[i + 1] : null;
};
const ENV = { PATH: `${FAKE_BIN}:${process.env.PATH}`, AURORA_SCAN_FIXTURE: '1', AURORA_SCAN_FAKE_DIR: fakeDir };
const pdfjs = await import(pathToFileURL(path.join(ROOT, 'node_modules/pdfjs-dist/legacy/build/pdf.mjs')).href);
const require = (await import('node:module')).createRequire(import.meta.url);
const sane = require(path.join(ROOT, 'main/lib/sane.js'));

const W = '.win.app-scan';
const S = (s, fn, arg) => s.page.evaluate(`(async () => { const c = document.querySelector('.win.app-scan')?.__scan; return (${fn.toString()})(c, ${JSON.stringify(arg ?? null)}); })()`);
async function until(s, fn, { timeout = 12000, label = 'condition', arg } = {}) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    last = await S(s, fn, arg).catch((e) => `ERR ${e.message}`);
    if (last && !String(last).startsWith('ERR')) return last;
    await sleep(80);
  }
  throw new Error(`timeout waiting for ${label} (last: ${JSON.stringify(last)})`);
}
const inv = (s, ch, ...a) => s.page.evaluate(([c, args]) => window.__aurora.api.invoke(c, ...args).then((v) => v, (e) => ({ error: e.code || e.message, message: e.message })), [ch, a]);
const errorsOf = (s) => s.logs.filter((l) => /^\[(error|pageerror)\]/.test(l) && !/favicon|ERR_FILE_NOT_FOUND|net::|Autofill/.test(l));
const text = (s, sel) => s.page.textContent(sel).catch(() => null);
const texts = (s, sel) => s.page.$$eval(sel, (els) => els.map((e) => e.textContent.trim()));
async function waitIdle(s) {
  await sleep(150);
  await until(s, (c) => c && !c.job && !c.saving && c.status !== 'searching', { label: 'idle' });
  await sleep(120);
}
async function saveAndWait(s, selector = `${W} .scan-save`) {
  const before = JSON.stringify(await S(s, (c) => c.lastSaved));
  await s.page.click(selector);
  await until(s, (c, b) => JSON.stringify(c.lastSaved) !== b && !c.saving, { label: 'saved', arg: before });
  await sleep(100);
}
async function scanOnce(s, { button = `${W} .scan-scan-btn` } = {}) {
  const before = (await S(s, (c) => c.pages.length)) || 0;
  await s.page.click(button);
  await until(s, (c) => !!c.job, { label: 'job started', timeout: 4000 }).catch(() => {});
  await waitIdle(s);
  return (await S(s, (c) => c.pages.length)) - before;
}
async function closeApps(s, cls) {
  await s.aurora((c) => {
    for (const w of window.__aurora.wm.list()) if (w.el.classList.contains(c)) w.close(true);
  }, cls);
  await s.page.waitForFunction((c) => !document.querySelector(`.win.${c}`), cls, { timeout: 5000 }).catch(() => {});
  await s.aurora(() => window.__aurora.wm.list().find((w) => w.el.classList.contains('app-scan'))?.focus());
  await sleep(300);
}
async function dragBy(s, selector, dx, dy) {
  const b = await s.page.locator(selector).boundingBox();
  const x = b.x + b.width / 2;
  const y = b.y + b.height / 2;
  await s.page.mouse.move(x, y);
  await s.page.mouse.down();
  for (let i = 1; i <= 8; i++) await s.page.mouse.move(x + (dx * i) / 8, y + (dy * i) / 8);
  await s.page.mouse.up();
  await sleep(80);
}
function pdfBoxesOf(bytes) {
  return pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, verbosity: 0 }).promise.then(async (doc) => {
    const views = [];
    for (let i = 1; i <= doc.numPages; i++) views.push((await doc.getPage(i)).view.map((v) => Math.round(v * 100) / 100));
    const ops = await (await doc.getPage(1)).getOperatorList();
    const images = ops.fnArray.filter((f) => f === pdfjs.OPS.paintImageXObject).length;
    return { pages: doc.numPages, views, images };
  });
}
const jfifDpi = (b) => (b[2] === 0xff && b[3] === 0xe0 && b.toString('latin1', 6, 10) === 'JFIF' ? [b[13], b.readUInt16BE(14)] : null);
const jpegSize = (b) => {
  let p = 2;
  while (p < b.length) {
    const m = b[p + 1];
    const len = b.readUInt16BE(p + 2);
    if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return [b.readUInt16BE(p + 7), b.readUInt16BE(p + 5)];
    p += 2 + len;
  }
  return null;
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const shots = [];

// ==================================================================== French, dark: the whole flow
let s;
try {
  ctl({});
  console.log('Numérisation — fake scanners, French, dark');
  s = await launchShell({ open: ['scan'], lang: 'fr', theme: 'dark', size: '1280x720', env: ENV });
  const docs = path.join(s.home, 'Documents', 'Numérisations');

  await section('device list: USB flatbed + network MFP (webcam left out, eSCL / WSD / escl duplicates merged)', async () => {
    await until(s, (c) => c?.status === 'ready' && c.opts, { label: 'ready' });
    const st = await S(s, (c) => ({ devices: c.devices.map((d) => [d.name, d.label, d.connection, d.protocol]), simulated: c.simulated, device: c.P.device }));
    check('two scanners', st.devices, [['genesys:libusb:001:004', 'Canon LiDE 300', 'usb', null], ['airscan:e0:Brother MFC-L2710DW series', 'Brother MFC-L2710DW series', 'network', 'eSCL']]);
    check('fake scanimage in use (simulated)', st.simulated, true);
    check('first scanner chosen', st.device, 'genesys:libusb:001:004');
    check('picker lists them by name', await texts(s, `${W} select[data-k="device"] option`), ['Canon LiDE 300', 'Brother MFC-L2710DW series']);
    check('connection under the picker: « USB »', await text(s, `${W} [data-field="device"] .scan-hint`), 'USB');
    check('scanimage -f with the U+001F separated format', calls()[0].args, ['-f', '%d\x1f%v\x1f%m\x1f%t%n']);
    check('scanimage never runs as root (same user as the test)', calls().every((c) => c.uid === process.getuid() && c.uid !== 0), true);
    check('empty glass explained', await text(s, `${W} .scan-glass-hint`), (v) => /Posez le document face contre la vitre/.test(v));
    check('Aperçu and Numériser enabled, Enregistrer disabled (no page)', [await s.page.isEnabled(`${W} .scan-preview-btn`), await s.page.isEnabled(`${W} .scan-scan-btn`), await s.page.isEnabled(`${W} .scan-save`)], [true, true, false]);
  });

  await section('options: modes, resolution presets, sources', async () => {
    check('Canon modes in French', await texts(s, `${W} select[data-k="mode"] option`), ['Couleur', 'Niveaux de gris', 'Noir et blanc']);
    check('Canon: flatbed only, no source choice', await s.page.locator(`${W} select[data-k="source"]`).count(), 0);
    check('Canon presets 150 / 300 / 600 ppp, 300 chosen', [await texts(s, `${W} [data-k="res"] button`), await text(s, `${W} [data-k="res"] button[aria-checked="true"]`)], [['150 ppp', '300 ppp', '600 ppp'], '300 ppp']);
    check('hint « Recommandé pour les documents »', await text(s, `${W} [data-field="res"] .scan-hint`), 'Recommandé pour les documents');
    shots.push(await s.shot('scan-start-fr-dark'));
    await s.page.selectOption(`${W} select[data-k="device"]`, 'airscan:e0:Brother MFC-L2710DW series');
    await until(s, (c) => c.opts?.device === 'airscan:e0:Brother MFC-L2710DW series' && document.querySelector('.app-scan select[data-k="source"]'), { label: 'brother options' });
    check('Brother sources: Vitre / Chargeur / Chargeur recto verso', await texts(s, `${W} select[data-k="source"] option`), ['Vitre', 'Chargeur', 'Chargeur recto verso']);
    check('Brother: no black and white', await texts(s, `${W} select[data-k="mode"] option`), ['Couleur', 'Niveaux de gris']);
    check('Brother presets on 100|200|300|600: 200 / 300 / 600 ppp', await texts(s, `${W} [data-k="res"] button`), ['200 ppp', '300 ppp', '600 ppp']);
    check('Brother hint « Réseau · eSCL »', await text(s, `${W} [data-field="device"] .scan-hint`), 'Réseau · eSCL');
    await s.page.selectOption(`${W} select[data-k="device"]`, 'genesys:libusb:001:004');
    await until(s, (c) => c.opts?.device === 'genesys:libusb:001:004' && !c.job, { label: 'canon again' });
  });

  await section('preview: fast low-resolution scan of the whole glass, with progress', async () => {
    ctl({ slowMs: 1600 });
    await s.page.click(`${W} .scan-preview-btn`);
    await until(s, (c) => c.job && c.job.percent > 0, { label: 'preview progress' });
    check('progress shown « Aperçu… N % » with Annuler', [await text(s, `${W} .scan-progress-text`), await s.page.isVisible(`${W} .scan-cancel`)], (v) => /^Aperçu… \d+ %$/.test(v[0]) && v[1]);
    check('buttons disabled while scanning', [await s.page.isEnabled(`${W} .scan-scan-btn`), await s.page.isEnabled(`${W} select[data-k="device"]`)], [false, false]);
    await waitIdle(s);
    const c = lastScan();
    check('preview argv: 75 dpi, colour, whole glass, PNG to a temp file', [argOf(c, '--resolution'), argOf(c, '--mode'), argOf(c, '-l'), argOf(c, '-t'), argOf(c, '-x'), argOf(c, '-y'), argOf(c, '--format'), /\/aurora-scan-[^/]+\/preview-[^/]+\/preview\.png$/.test(argOf(c, '--output-file'))], ['75', 'Color', '0', '0', '216.7', '299.7', 'png', true]);
    const pv = await S(s, (c) => ({ path: c.preview?.path, w: c.preview?.width, sel: c.sel, img: document.querySelector('.app-scan .scan-preview-img').naturalWidth, shown: !document.querySelector('.app-scan .scan-sel').hidden }));
    check('preview picture shown (640 px wide = 216.7 mm at 75 dpi)', [pv.w, pv.img], [640, 640]);
    check('temp file is private (0700 folder)', (fs.statSync(path.dirname(path.dirname(pv.path))).mode & 0o777).toString(8), '700');
    check('selection = whole glass', [pv.shown, pv.sel], [true, { left: 0, top: 0, width: 216.7, height: 299.7 }]);
    check('toolbar « Zone à numériser : 217 × 300 mm »', await text(s, `${W} .scan-tb-title`), 'Zone à numériser : 217 × 300 mm');
    ctl({});
  });

  await section('selection: resize by a handle, move, draw, keyboard, document detection', async () => {
    const box = await s.page.locator(`${W} .scan-glass`).boundingBox();
    const mmPx = box.width / 216.7;
    await dragBy(s, `${W} .scan-handle.h-se`, -50 * mmPx, -80 * mmPx);
    let sel = await S(s, (c) => c.sel);
    check('se handle: width / height smaller by 50 / 80 mm', [Math.round(sel.width), Math.round(sel.height), sel.left, sel.top], (v) => Math.abs(v[0] - 167) <= 2 && Math.abs(v[1] - 220) <= 2 && v[2] === 0 && v[3] === 0);
    await dragBy(s, `${W} .scan-sel`, 20 * mmPx, 30 * mmPx);
    sel = await S(s, (c) => c.sel);
    check('drag inside: moved by 20 / 30 mm, same size', [Math.round(sel.left), Math.round(sel.top), Math.round(sel.width)], (v) => Math.abs(v[0] - 20) <= 2 && Math.abs(v[1] - 30) <= 2 && Math.abs(v[2] - 167) <= 2);
    await dragBy(s, `${W} .scan-handle.h-nw`, -30 * mmPx, -40 * mmPx);
    sel = await S(s, (c) => c.sel);
    check('nw handle: back to the corner, clamped to the glass', [Math.round(sel.left), Math.round(sel.top)], [0, 0]);
    // draw a new one from outside the selection (bottom right of the glass)
    await s.page.mouse.move(box.x + box.width - 10, box.y + box.height - 10);
    await s.page.mouse.down();
    await s.page.mouse.move(box.x + box.width - 40 * mmPx, box.y + box.height - 50 * mmPx, { steps: 6 });
    await s.page.mouse.up();
    sel = await S(s, (c) => c.sel);
    const ew = 40 - 10 / mmPx;
    const eh = 50 - 10 / (box.height / 299.7);
    check('draw outside: a new selection where the pointer went', [Math.round(sel.width), Math.round(sel.height)], (v) => Math.abs(v[0] - ew) <= 2 && Math.abs(v[1] - eh) <= 2);
    await s.page.focus(`${W} .scan-sel`);
    const k0 = await S(s, (c) => c.sel);
    await s.page.keyboard.press('ArrowLeft');
    await s.page.keyboard.press('Control+ArrowUp');
    await s.page.keyboard.press('Shift+ArrowRight');
    const k1 = await S(s, (c) => c.sel);
    check('keyboard: ← moves 1 mm, Ctrl+↑ 10 mm, Maj+→ widens 1 mm', [Math.round((k0.left - k1.left) * 10) / 10, Math.round((k0.top - k1.top) * 10) / 10, Math.round((k1.width - k0.width) * 10) / 10], [1, 10, 1]);
    check('selection labelled for screen readers', await s.page.getAttribute(`${W} .scan-sel`, 'aria-label'), (v) => /^Zone à numériser, \d+ × \d+ mm\. Les flèches la déplacent/.test(v));
    await s.page.click(`${W} .scan-detect`);
    await sleep(300);
    sel = await S(s, (c) => c.sel);
    check('« Détecter le document »: the A5 letter at (20, 15) mm, 148 × 210 mm', [sel.left, sel.top, sel.width, sel.height].map((v) => Math.round(v)), (v) => Math.abs(v[0] - 19) <= 2 && Math.abs(v[1] - 14) <= 2 && Math.abs(v[2] - 150) <= 3 && Math.abs(v[3] - 212) <= 3);
    shots.push(await s.shot('scan-preview-fr-dark'));
    await s.page.click(`${W} .scan-whole`);
    check('« Toute la vitre » resets the selection', await S(s, (c) => c.sel), { left: 0, top: 0, width: 216.7, height: 299.7 });
    await s.page.click(`${W} .scan-detect`);
    await sleep(200);
  });

  let page1;
  await section('scan: chosen area, 150 ppp, grey; the page shows', async () => {
    await s.page.click(`${W} [data-k="res:150"]`);
    await s.page.selectOption(`${W} select[data-k="mode"]`, 'gray');
    const sel = await S(s, (c) => c.sel);
    ctl({ slowMs: 1200 });
    await s.page.click(`${W} .scan-scan-btn`);
    await until(s, (c) => c.job && c.job.percent > 0, { label: 'scan progress' });
    check('progress « Numérisation… N % »', await text(s, `${W} .scan-progress-text`), (v) => /^Numérisation… \d+ %$/.test(v));
    check('taskbar progress on the window', await s.page.evaluate(() => !!document.querySelector('.win.app-scan')), true);
    await waitIdle(s);
    ctl({});
    const c = lastScan();
    check('argv: --mode=Gray --resolution=150, the selection in mm', [argOf(c, '--mode'), argOf(c, '--resolution'), Number(argOf(c, '-l')), Number(argOf(c, '-x'))], [`Gray`, '150', Math.round(sel.left * 100) / 100, Math.round(sel.width * 100) / 100]);
    const st = await S(s, (c) => ({ pages: c.pages, current: c.current, dirty: c.dirty }));
    page1 = st.pages[0];
    check('one page, grey, 150 dpi, size from the PNG', [st.pages.length, page1.mode, page1.dpi, page1.width], (v) => v[0] === 1 && v[1] === 'gray' && v[2] === 150 && Math.abs(v[3] - Math.round((sel.width / 25.4) * 150)) <= 2);
    check('the new page is shown (« Page 1 sur 1 »)', [st.current === page1.id, await text(s, `${W} .scan-tb-title`)], [true, 'Page 1 sur 1']);
    check('document marked unsaved', st.dirty, true);
    check('save buttons enabled', await s.page.isEnabled(`${W} .scan-save`), true);
  });

  await section('second page from the whole glass at 300 ppp in colour (« Ajouter une page »)', async () => {
    await s.page.click(`${W} .scan-tile-preview`);
    await s.page.click(`${W} .scan-whole`);
    await s.page.click(`${W} [data-k="res:300"]`);
    await s.page.selectOption(`${W} select[data-k="mode"]`, 'color');
    check('one page added', await scanOnce(s, { button: `${W} .scan-tile-add` }), 1);
    const c = lastScan();
    check('argv: Color, 300, whole glass', [argOf(c, '--mode'), argOf(c, '--resolution'), argOf(c, '-x'), argOf(c, '-y')], ['Color', '300', '216.7', '299.7']);
    check('strip: Aperçu, 1, 2, Ajouter une page', await texts(s, `${W} .scan-tile .scan-tile-label`), ['Aperçu', '1', '2', 'Ajouter une page']);
    check('pages listbox', [await s.page.getAttribute(`${W} .scan-tiles`, 'role'), await s.page.getAttribute(`${W} .scan-tile.selected`, 'aria-selected')], ['listbox', 'true']);
  });

  await section('pages: rotate, move (buttons, Ctrl+arrows, drag), delete + undo, brightness', async () => {
    const ids = async () => S(s, (c) => c.pages.map((p) => p.id));
    const [a, b] = await ids();
    await s.page.click(`${W} .scan-tile[data-id="${b}"]`);
    await s.page.click(`${W} .scan-rotr`);
    check('rotate right: 90°', (await S(s, (c) => c.pages))[1].rotation, 90);
    await s.page.click(`${W} .scan-rotl`);
    await s.page.click(`${W} .scan-rotl`);
    check('rotate left twice: 270°', (await S(s, (c) => c.pages))[1].rotation, 270);
    await s.page.click(`${W} .scan-rotr`);
    await s.page.click(`${W} .scan-rotr`);
    check('the thumbnail turns with the page (landscape)', await s.page.$eval(`${W} .scan-tile[data-id="${b}"] canvas`, (cv) => cv.width > cv.height), true);
    await s.page.click(`${W} .scan-movel`);
    check('« Déplacer vers la gauche »: page 2 first', await ids(), [b, a]);
    await s.page.focus(`${W} .scan-tile[data-id="${b}"]`);
    await s.page.keyboard.press('Control+ArrowRight');
    check('Ctrl+→ in the strip: back in place', await ids(), [a, b]);
    check('focus stays on the moved page', await s.page.evaluate(() => document.activeElement?.dataset?.id), String(b));
    await s.page.keyboard.press('ArrowLeft');
    check('← picks the previous page', await S(s, (c) => c.current), a);
    // drag page 2 before page 1
    const t1 = await s.page.locator(`${W} .scan-tile[data-id="${a}"]`).boundingBox();
    const t2 = await s.page.locator(`${W} .scan-tile[data-id="${b}"]`).boundingBox();
    await s.page.mouse.move(t2.x + t2.width / 2, t2.y + t2.height / 2);
    await s.page.mouse.down();
    await s.page.mouse.move(t2.x + t2.width / 2 - 20, t2.y + t2.height / 2, { steps: 3 });
    await s.page.mouse.move(t1.x + 10, t1.y + t1.height / 2, { steps: 8 });
    await s.page.mouse.up();
    await sleep(150);
    check('drag in the strip: page 2 dropped before page 1', await ids(), [b, a]);
    await s.page.click(`${W} .scan-tile[data-id="${b}"]`);
    await s.page.click(`${W} .scan-mover`);
    check('and moved back', await ids(), [a, b]);
    // delete + undo
    await s.page.click(`${W} .scan-tile[data-id="${a}"]`);
    await s.page.click(`${W} .scan-delete`);
    check('deleted: one page left, « Page 1 supprimée. »', [await ids(), await text(s, `${W} .scan-note-msg`)], [[b], 'Page 1 supprimée.']);
    await s.page.click(`${W} .scan-undo`);
    check('« Annuler » puts it back in place', await ids(), [a, b]);
    // brightness on page 2
    await s.page.click(`${W} .scan-tile[data-id="${b}"]`);
    await s.page.click(`${W} .scan-adjust-btn`);
    await s.page.waitForSelector(`${W} .scan-adjust:not([hidden]) .scan-adj-brightness`);
    check('« Retouches » opens with focus on Luminosité', await s.page.evaluate(() => document.activeElement?.classList.contains('scan-adj-brightness')), true);
    await s.page.$eval(`${W} .scan-adj-brightness`, (el) => {
      el.value = '40';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await s.page.$eval(`${W} .scan-adj-contrast`, (el) => {
      el.value = '10';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    check('brightness +40, contrast +10 on page 2 only', (await S(s, (c) => c.pages)).map((p) => [p.brightness, p.contrast]), [[0, 0], [40, 10]]);
    check('values shown', await texts(s, `${W} .scan-adj-val`), ['+40', '+10']);
    shots.push(await s.shot('scan-page-fr-dark'));
    await s.page.keyboard.press('Escape');
    check('Échap closes « Retouches »', await s.page.isHidden(`${W} .scan-adjust`), true);
    await s.page.click(`${W} .scan-tile[data-id="${a}"]`);
  });

  let pdfPath;
  await section('save as PDF to Documents/Numérisations: two pages at their physical size', async () => {
    const pages = await S(s, (c) => c.pages);
    await saveAndWait(s);
    const files = fs.existsSync(docs) ? fs.readdirSync(docs) : [];
    check('one PDF « Numérisation <date>.pdf »', files, (v) => v.length === 1 && /^Numérisation \d{4}-\d\d-\d\d \d\d\.\d\d\.\d\d\.pdf$/.test(v[0]));
    pdfPath = path.join(docs, files[0]);
    const bytes = fs.readFileSync(pdfPath);
    const r = await pdfBoxesOf(bytes);
    const expect = pages.map((p) => {
      const rot = p.rotation % 180 !== 0;
      const w = rot ? p.height : p.width;
      const hh = rot ? p.width : p.height;
      return [0, 0, Math.round((w / p.dpi) * 72 * 100) / 100, Math.round((hh / p.dpi) * 72 * 100) / 100];
    });
    check('pdf.js reads 2 pages', r.pages, 2);
    check('MediaBox = pixels / dpi × 72 (page 2 turned a quarter: landscape)', r.views, expect);
    check('page 1 draws one image', r.images, 1);
    check('the images are JPEG streams (DCTDecode)', (bytes.toString('latin1').match(/\/Filter \/DCTDecode/g) || []).length, 2);
    check('note « Enregistré dans Numérisations : … » with Ouvrir / Afficher dans Fichiers', [await text(s, `${W} .scan-note-msg`), await texts(s, `${W} .scan-note-actions .btn`)], (v) => v[0] === `Enregistré dans Numérisations : ${files[0]}` && JSON.stringify(v[1]) === JSON.stringify(['Ouvrir', 'Afficher dans Fichiers']));
    check('document saved (not dirty)', await S(s, (c) => c.dirty), false);
    shots.push(await s.shot('scan-saved-fr-dark'));
  });

  await section('« Afficher dans Fichiers » and « Ouvrir »', async () => {
    const before = await s.aurora(() => window.__aurora.wm.list().length);
    await s.page.click(`${W} .scan-reveal`);
    await s.page.waitForSelector('.win.app-files', { timeout: 10000 });
    let fx = null;
    for (let i = 0; i < 50; i++) {
      fx = await s.page.evaluate(() => {
        const ex = window.__aurora.wm.list().filter((w) => w.explorer && !w._closing).pop()?.explorer;
        return ex ? { path: ex.tab?.loc?.path || null, sel: [...(ex.view?.sel || [])].map(String) } : null;
      });
      if (fx?.sel?.length) break;
      await sleep(100);
    }
    check('Files opens Numérisations with the PDF selected', fx, (v) => v?.path === docs && v.sel.some((x) => x.endsWith(path.basename(pdfPath))));
    await closeApps(s, 'app-files');
    await s.page.click(`${W} .scan-open`);
    await s.page.waitForSelector('.win.app-pdf', { timeout: 10000 });
    check('« Ouvrir » opens the PDF in the Lecteur PDF', await s.page.locator('.win.app-pdf').count(), 1);
    await closeApps(s, 'app-pdf');
    check('windows closed again', await s.aurora(() => window.__aurora.wm.list().length), before);
    await s.aurora(() => window.__aurora.wm.list().find((w) => w.el.classList.contains('app-scan'))?.focus());
  });

  await section('JPEG and PNG: one file per page, dpi written, rotation and brightness applied', async () => {
    const pages = await S(s, (c) => c.pages);
    await s.page.click(`${W} [data-k="format:jpeg"]`);
    await saveAndWait(s);
    let jpgs = fs.readdirSync(docs).filter((f) => f.endsWith('.jpg')).sort();
    check('two JPEG « … - page 1.jpg », « … - page 2.jpg »', jpgs, (v) => v.length === 2 && / - page 1\.jpg$/.test(v[0]) && / - page 2\.jpg$/.test(v[1]));
    const j1 = fs.readFileSync(path.join(docs, jpgs[0]));
    const j2 = fs.readFileSync(path.join(docs, jpgs[1]));
    check('JFIF density = the scan resolution (150 / 300 dpi)', [jfifDpi(j1), jfifDpi(j2)], [[1, 150], [1, 300]]);
    const dims = (p) => (p.rotation % 180 ? [p.height, p.width] : [p.width, p.height]);
    check('page 2 turned a quarter: its JPEG is landscape', [jpegSize(j1), jpegSize(j2), pages[1].rotation], [dims(pages[0]), dims(pages[1]), 90]);
    check('« 2 fichiers enregistrés dans Numérisations »', await text(s, `${W} .scan-note-msg`), '2 fichiers enregistrés dans Numérisations');
    await s.page.click(`${W} [data-k="format:png"]`);
    await saveAndWait(s);
    const pngs = fs.readdirSync(docs).filter((f) => f.endsWith('.png')).sort();
    check('two PNG', pngs.length, 2);
    const p1 = sane.pngInfo(fs.readFileSync(path.join(docs, pngs[0])));
    const p2 = sane.pngInfo(fs.readFileSync(path.join(docs, pngs[1])));
    check('PNG page 1 untouched: the scanner’s own grey PNG (colour type 0), 150 dpi', [p1.colorType, p1.dpiX, p1.width], [0, 150, pages[0].width]);
    check('PNG page 2 re-encoded (rotation, brightness) with pHYs 300 dpi', [p2.dpiX, p2.width, p2.height], [300, ...dims(pages[1])]);
    // brightness: the edited page is lighter than its scan
    const mean = await s.page.evaluate(async ([a, b]) => {
      const m = async (p) => {
        const bmp = await createImageBitmap(await (await fetch(window.__aurora.api.mediaUrl(p))).blob());
        const c = new OffscreenCanvas(200, Math.round((200 * bmp.height) / bmp.width));
        const g = c.getContext('2d');
        g.drawImage(bmp, 0, 0, c.width, c.height);
        const d = g.getImageData(0, 0, c.width, c.height).data;
        let t = 0;
        for (let i = 0; i < d.length; i += 4) t += d[i] + d[i + 1] + d[i + 2];
        return t / (d.length / 4) / 3;
      };
      return [await m(a), await m(b)];
    }, [pages[1].path, path.join(docs, pngs[1])]);
    check('brightness +40 applied (mean grey level higher)', mean[1] > mean[0] + 3, true);
    jpgs = null;
    await s.page.click(`${W} [data-k="format:pdf"]`);
  });

  await section('« Enregistrer sous… »: the name chosen in the file dialog', async () => {
    await s.page.click(`${W} .scan-saveas`);
    await s.page.waitForSelector('.fp-dialog', { timeout: 5000 });
    check('the dialog opens in Numérisations', await s.page.inputValue('.fp-dialog .fp-path'), docs);
    const name = s.page.locator('.fp-dialog .fp-bottom input');
    await name.fill('Contrat signé');
    const before = JSON.stringify(await S(s, (c) => c.lastSaved));
    await s.page.locator('.fp-dialog .dialog-footer .btn.primary').click();
    await until(s, (c, b) => JSON.stringify(c.lastSaved) !== b && !c.saving, { label: 'saved as', arg: before });
    check('saved as « Contrat signé.pdf »', fs.existsSync(path.join(docs, 'Contrat signé.pdf')), true);
    check('note names it', await text(s, `${W} .scan-note-msg`), 'Enregistré dans Numérisations : Contrat signé.pdf');
    check('two pages in it', (await pdfBoxesOf(fs.readFileSync(path.join(docs, 'Contrat signé.pdf')))).pages, 2);
  });

  await section('« Envoyer par courriel »: Courrier opens a message with the PDF attached', async () => {
    await s.page.click(`${W} .scan-mail`);
    await s.page.waitForSelector('.win.app-mail .ml-attach-row:not([hidden])', { timeout: 15000 });
    const att = await s.page.textContent('.win.app-mail .ml-attach-row');
    check('attachment « Contrat signé.pdf » (the last save, no second file)', [att.includes('Contrat signé.pdf'), fs.readdirSync(docs).filter((f) => f.endsWith('.pdf')).length], [true, 2]);
    check('subject = the file name', await s.page.inputValue('.win.app-mail .ml-subject-row input').catch(() => ''), 'Contrat signé');
    await closeApps(s, 'app-mail');
  });

  await section('cancel: the scanner stops (process group), nothing is added', async () => {
    ctl({ slowMs: 30000 });
    const before = await S(s, (c) => c.pages.length);
    await s.page.click(`${W} .scan-scan-btn`);
    await until(s, (c) => c.job && c.job.percent >= 0 && c.job.percent !== null, { label: 'slow scan running' });
    const pid = lastScan().pid;
    check('fake scanimage running', alive(pid), true);
    shots.push(await s.shot('scan-progress-fr-dark'));
    await s.page.click(`${W} .scan-cancel`);
    check('« Arrêt du scanner… » while it stops', await text(s, `${W} .scan-progress-text`), (v) => v === 'Arrêt du scanner…' || v === null);
    await waitIdle(s);
    check('scanimage gone', alive(pid), false);
    check('« Numérisation annulée. », no page added', [await text(s, `${W} .scan-note-msg`), await S(s, (c) => c.pages.length)], ['Numérisation annulée.', before]);
    const out = argOf(lastScan(), '--output-file');
    check('the half-written file is removed', fs.existsSync(out), false);
    ctl({});
  });

  await section('errors said simply', async () => {
    const cases = [
      ['busy', 'Le scanner est occupé', /Une autre application l’utilise/],
      ['cover', 'Le capot du scanner est ouvert', /Fermez le capot/],
      ['gone', 'Le scanner ne répond pas', /Rechercher à nouveau/],
      ['denied', 'Selene n’a pas accès à ce scanner', /Débranchez le scanner/],
      ['io', 'Le scanner ne répond pas', /allumé et branché/],
    ];
    for (const [fail, title, help] of cases) {
      ctl({ fail });
      await s.page.click(`${W} .scan-scan-btn`);
      await until(s, (c) => !!c.job, { timeout: 3000 }).catch(() => {});
      await waitIdle(s);
      const note = await S(s, (c) => c.note);
      check(`${fail}: « ${title} »`, [note?.kind, note?.title, help.test(note?.message || '')], ['error', title, true]);
      if (fail === 'gone') {
        check('gone: « Rechercher à nouveau » offered', await texts(s, `${W} .scan-note-actions .btn`), ['Rechercher à nouveau']);
        shots.push(await s.shot('scan-error-fr-dark'));
      }
    }
    ctl({});
    check('no page added by the failures', (await S(s, (c) => c.pages.length)) >= 2, true);
  });

  await section('feeder: batch until empty, recto verso, empty feeder, paper jam keeps the pages', async () => {
    await s.page.selectOption(`${W} select[data-k="device"]`, 'airscan:e0:Brother MFC-L2710DW series');
    await until(s, (c) => c.opts?.device === 'airscan:e0:Brother MFC-L2710DW series' && !document.querySelector('.app-scan select[data-k="device"]').disabled, { label: 'brother' });
    await s.page.selectOption(`${W} select[data-k="source"]`, 'adf');
    await until(s, (c) => c.opts?.area?.height === 355.6 && document.querySelector('.app-scan select[data-k="paper"]'), { label: 'feeder options' });
    check('feeder: legal length offered, A4 chosen', [await texts(s, `${W} select[data-k="paper"] option`), await s.page.inputValue(`${W} select[data-k="paper"]`)], [['A4 (210 × 297 mm)', 'A5 (148 × 210 mm)', 'Lettre US (216 × 279 mm)', 'Légal US (216 × 356 mm)', 'Taille maximale'], 'a4']);
    check('no preview with the feeder, hint shown', [await s.page.isEnabled(`${W} .scan-preview-btn`), await text(s, `${W} .scan-glass-hint`)], (v) => !v[0] && /Placez les feuilles dans le chargeur/.test(v[1]));
    const before = await S(s, (c) => c.pages.length);
    ctl({ adfPages: 3, slowMs: 500 });
    await s.page.click(`${W} .scan-scan-btn`);
    await until(s, (c) => c.job?.page >= 2, { label: 'page 2 of the batch' });
    check('progress « Page 2 : N % »', await text(s, `${W} .scan-progress-text`), (v) => /^Page [23] : \d+ %$/.test(v));
    check('pages appear while the feeder runs', (await S(s, (c) => c.pages.length)) - before >= 1, true);
    await waitIdle(s);
    check('3 sheets -> 3 pages', (await S(s, (c) => c.pages.length)) - before, 3);
    const c = lastScan();
    check('argv: --source=ADF, A4, --batch with --batch-print', [argOf(c, '--source'), argOf(c, '-x'), argOf(c, '-y'), /page-%03d\.png$/.test(argOf(c, '--batch')), c.args.includes('--batch-print')], ['ADF', '210', '297', true, true]);
    check('the first new page is shown', await S(s, (c, n) => c.current === c.pages[n].id, before), true);
    shots.push(await s.shot('scan-feeder-fr-dark'));
    await s.page.click(`${W} .scan-tile-preview`);
    await s.page.selectOption(`${W} select[data-k="source"]`, 'adf-duplex');
    await until(s, (c) => c.P.source === 'adf-duplex' && !document.querySelector('.app-scan .scan-scan-btn').disabled, { label: 'duplex' });
    ctl({ adfPages: 3 });
    check('recto verso: 3 sheets -> 6 pages', await scanOnce(s), 6);
    check('argv: --source=ADF Duplex', argOf(lastScan(), '--source'), 'ADF Duplex');
    ctl({ fail: 'nopaper' });
    check('empty feeder: no page', await scanOnce(s), 0);
    check('« Le chargeur est vide »', (await S(s, (c) => c.note))?.title, 'Le chargeur est vide');
    ctl({ fail: 'jam', jamAt: 3, adfPages: 4 });
    await s.page.selectOption(`${W} select[data-k="source"]`, 'adf');
    await until(s, (c) => c.P.source === 'adf' && !document.querySelector('.app-scan .scan-scan-btn').disabled, { label: 'adf' });
    check('jam at page 3: the 2 pages before are kept', await scanOnce(s), 2);
    const note = await S(s, (c) => c.note);
    check('« Bourrage papier dans le chargeur … Les 2 pages déjà numérisées sont conservées. »', [note?.title, note?.message], ['Bourrage papier dans le chargeur', 'Retirez la feuille coincée, puis réessayez. Les 2 pages déjà numérisées sont conservées.']);
    ctl({});
  });

  await section('« Nouveau document » asks first, then removes the pages and their temp files', async () => {
    const paths = (await S(s, (c) => c.pages)).map((p) => p.path);
    await s.page.click(`${W} .scan-tile-preview`);
    await s.page.click(`${W} .scan-new`);
    await s.page.waitForSelector('.dialog .dialog-footer', { timeout: 5000 });
    check('confirmation names the count', await s.page.textContent('.dialog'), (v) => /Supprimer les \d+ pages non enregistrées \?/.test(v));
    await s.page.locator('.dialog .dialog-footer .btn.primary, .dialog .dialog-footer .btn.danger').first().click();
    await sleep(400);
    check('no page left', await S(s, (c) => c.pages.length), 0);
    check('their temp files deleted', paths.filter((p) => fs.existsSync(p)).length, 0);
    check('save disabled again', await s.page.isEnabled(`${W} .scan-save`), false);
  });

  await section('backend checks: names, values, TIFF, discard outside the temp folder', async () => {
    check('invalid device name -> EINVAL', (await inv(s, 'scan:scan', 'jtest1', '-x:evil', {})).error, 'EINVAL');
    check('unknown device -> EGONE', (await inv(s, 'scan:scan', 'jtest2', 'pixma:nothere', {})).error, 'EGONE');
    check('resolution the scanner lacks -> EINVAL', (await inv(s, 'scan:scan', 'jtest3', 'genesys:libusb:001:004', { resolution: 333 })).error, 'EINVAL');
    check('unknown mode -> EINVAL', (await inv(s, 'scan:scan', 'jtest4', 'genesys:libusb:001:004', { mode: 'sepia' })).error, 'EINVAL');
    check('bad job id -> EINVAL', (await inv(s, 'scan:scan', '../x', 'genesys:libusb:001:004', {})).error, 'EINVAL');
    check('preview from the feeder -> EINVAL', (await inv(s, 'scan:scan', 'jtest5', 'airscan:e0:Brother MFC-L2710DW series', { kind: 'preview', source: 'adf' })).error, 'EINVAL');
    const r = await inv(s, 'scan:scan', 'jtest6', 'genesys:libusb:001:004', { resolution: 75, mode: 'lineart', format: 'tiff', area: { left: 10, top: 10, width: 50, height: 400 } });
    check('TIFF scan, area clamped to the glass', [r.pages?.[0]?.format, fs.readFileSync(r.pages[0].path).toString('latin1', 0, 2), argOf(lastScan(), '-y'), argOf(lastScan(), '--mode')], ['tiff', 'II', '289.7', 'Lineart']);
    const victim = path.join(s.home, 'keep-me.txt');
    fs.writeFileSync(victim, 'x');
    check('scan:discard ignores files outside its temp folder', [(await inv(s, 'scan:discard', [victim, '/etc/passwd'])).removed, fs.existsSync(victim)], [0, true]);
    check('scan:discard removes its own', (await inv(s, 'scan:discard', [r.pages[0].path])).removed, 1);
    check('scan:options of an unknown source -> EINVAL', (await inv(s, 'scan:options', 'genesys:libusb:001:004', { source: '; rm -rf /' })).error, 'EINVAL');
  });

  await section('no scanner: calm empty state, « Rechercher à nouveau » finds them again', async () => {
    ctl({ devices: 'none' });
    await s.page.click(`${W} .scan-refresh`);
    await until(s, (c) => c.status === 'none', { label: 'none' });
    check('« Aucun scanner détecté » with help', [await text(s, `${W} .scan-none .subtitle`), await text(s, `${W} .scan-empty-help`)], (v) => v[0] === 'Aucun scanner détecté' && /Branchez un scanner USB/.test(v[1]));
    check('scan buttons disabled', await s.page.isEnabled(`${W} .scan-scan-btn`), false);
    shots.push(await s.shot('scan-none-fr-dark'));
    ctl({ devices: 'usb' });
    await s.page.click(`${W} .scan-retry`);
    await until(s, (c) => c.status === 'ready' && c.opts, { label: 'found again' });
    check('found again (the Canon only)', await S(s, (c) => c.devices.map((d) => d.label)), ['Canon LiDE 300']);
    ctl({});
  });

  await section('Paramètres > Imprimantes et scanners: the Scanners section', async () => {
    await s.aurora(() => window.__aurora.registry.launch('settings', { page: 'printers' }));
    await s.page.waitForSelector('.st-scan-device', { timeout: 15000 });
    // the list may come from the last 15 s (the app saw the Canon alone): ask again
    await s.page.click('.st-scan-search');
    await s.page.waitForFunction(() => document.querySelectorAll('.st-scan-device').length === 2, null, { timeout: 10000 });
    check('scanners listed with their connection', [await texts(s, '.st-scan-device .st-row-title'), await texts(s, '.st-scan-device .st-row-desc')], [['Canon LiDE 300', 'Brother MFC-L2710DW series'], ['USB', 'Réseau · eSCL']]);
    check('« Ouvrir Numérisation » at the top of the section', await text(s, '.st-scan-head .st-scan-open'), 'Ouvrir Numérisation');
    check('« Votre scanner n’apparaît pas ? » + Rechercher à nouveau', await text(s, '.st-scan-again'), (v) => /Votre scanner n’apparaît pas \?/.test(v) && /Rechercher à nouveau/.test(v));
    await s.page.locator('.st-scan-device').nth(1).scrollIntoViewIfNeeded();
    shots.push(await s.shot('scan-settings-fr-dark'));
    await s.page.click('.st-scan-device[data-scanner="airscan:e0:Brother MFC-L2710DW series"] .st-scan-use');
    await until(s, (c) => c.P.device === 'airscan:e0:Brother MFC-L2710DW series' && c.opts?.device === 'airscan:e0:Brother MFC-L2710DW series', { label: 'scan app on the Brother' });
    check('« Numériser » on a row opens Numérisation on that scanner (one window)', await s.page.locator(W).count(), 1);
    ctl({ devices: 'none' });
    await s.aurora(() => window.__aurora.registry.launch('settings', { page: 'printers' }));
    await s.page.waitForSelector('.win.app-settings.active .st-scan-search', { timeout: 10000 });
    await sleep(400);
    await s.page.click('.st-scan-search');
    await s.page.waitForSelector('.st-scan-none', { timeout: 10000 });
    check('none: « Aucun scanner détecté »', await text(s, '.st-scan-none .st-row-title'), 'Aucun scanner détecté');
    ctl({});
    await s.page.click('.st-scan-search');
    await s.page.waitForSelector('.st-scan-device', { timeout: 10000 });
    await closeApps(s, 'app-settings');
    await s.page.click(`${W} .scan-refresh`);
    await until(s, (c) => c.status === 'ready' && c.devices.length === 2 && c.opts && !c.job, { label: 'scan app sees both again' });
  });

  await section('closing with unsaved pages asks first; the temp folder goes', async () => {
    await s.aurora(() => window.__aurora.wm.list().find((w) => w.el.classList.contains('app-scan'))?.focus());
    await s.page.selectOption(`${W} select[data-k="device"]`, 'genesys:libusb:001:004');
    await until(s, (c) => c.opts?.device === 'genesys:libusb:001:004' && !c.job, { label: 'canon' });
    await scanOnce(s);
    const tmp = path.dirname(path.dirname((await S(s, (c) => c.pages))[0].path));
    // (not awaited: close() settles only once the question is answered)
    await s.aurora(() => {
      window.__aurora.wm.list().find((w) => w.el.classList.contains('app-scan')).close();
      return null;
    });
    await s.page.waitForSelector('.dialog .dialog-footer', { timeout: 5000 });
    check('« Pages non enregistrées »: Enregistrer / Ne pas enregistrer / Annuler', [await s.page.textContent('.dialog'), await texts(s, '.dialog .dialog-footer .btn')], (v) => /La page numérisée n’est pas enregistrée/.test(v[0]) && JSON.stringify(v[1]) === JSON.stringify(['Enregistrer', 'Ne pas enregistrer', 'Annuler']));
    await s.page.locator('.dialog .dialog-footer .btn', { hasText: 'Ne pas enregistrer' }).click();
    await s.page.waitForSelector(W, { state: 'detached', timeout: 5000 });
    await sleep(400);
    check('temp folder removed', fs.existsSync(tmp), false);
  });

  check('[fr dark] no renderer errors', errorsOf(s), []);
} catch (e) {
  failures.push(`fr dark: ${e.stack || e}`);
  if (s) await s.shot('scan-failure-fr-dark').catch(() => {});
} finally {
  await s?.close();
}

// ==================================================================== the other looks and English
for (const [lang, theme] of [['fr', 'light'], ['en', 'dark'], ['en', 'light']]) {
  let x;
  try {
    ctl({});
    console.log(`Numérisation — ${lang}, ${theme}`);
    x = await launchShell({ open: ['scan'], lang, theme, size: '1280x720', env: ENV });
    await section(`[${lang} ${theme}] preview, selection, a page, screenshots`, async () => {
      await until(x, (c) => c?.status === 'ready' && c.opts, { label: 'ready' });
      if (lang === 'en') {
        check('English labels', [await texts(x, `${W} select[data-k="mode"] option`), await text(x, `${W} .scan-preview-btn`), await text(x, `${W} .scan-scan-btn`), await texts(x, `${W} [data-k="res"] button`)], [['Color', 'Grayscale', 'Black and white'], 'Preview', 'Scan', ['150 dpi', '300 dpi', '600 dpi']]);
      }
      shots.push(await x.shot(`scan-start-${lang}-${theme}`));
      await x.page.click(`${W} .scan-preview-btn`);
      await waitIdle(x);
      await x.page.click(`${W} .scan-detect`);
      await sleep(300);
      shots.push(await x.shot(`scan-preview-${lang}-${theme}`));
      await x.page.click(`${W} [data-k="res:150"]`);
      check(`[${lang} ${theme}] a page scanned`, await scanOnce(x), 1);
      await x.page.click(`${W} .scan-rotr`);
      shots.push(await x.shot(`scan-page-${lang}-${theme}`));
      if (lang === 'en') {
        await saveAndWait(x);
        const dir = path.join(x.home, 'Documents', 'Scans');
        check('English: saved to Documents/Scans as « Scan <date>.pdf »', fs.existsSync(dir) ? fs.readdirSync(dir) : [], (v) => v.length === 1 && /^Scan \d{4}-\d\d-\d\d \d\d\.\d\d\.\d\d\.pdf$/.test(v[0]));
        check('English note', await text(x, `${W} .scan-note-msg`), (v) => /^Saved in Scans: Scan /.test(v));
      }
      if (theme === 'light') {
        await x.aurora(() => window.__aurora.registry.launch('settings', { page: 'printers' }));
        await x.page.waitForSelector('.st-scan-device', { timeout: 15000 });
        await x.page.locator('.st-scan-device').nth(1).scrollIntoViewIfNeeded();
        check(`[${lang} ${theme}] Settings: scanners listed`, await texts(x, '.st-scan-device .st-row-title'), ['Canon LiDE 300', 'Brother MFC-L2710DW series']);
        if (lang === 'en') check('English: « Open Scan »', await text(x, '.st-scan-open'), 'Open Scan');
        shots.push(await x.shot(`scan-settings-${lang}-${theme}`));
      }
    });
    check(`[${lang} ${theme}] no renderer errors`, errorsOf(x), []);
  } catch (e) {
    failures.push(`${lang} ${theme}: ${e.stack || e}`);
    if (x) await x.shot(`scan-failure-${lang}-${theme}`).catch(() => {});
  } finally {
    await x?.close();
  }
}

fs.rmSync(fakeDir, { recursive: true, force: true });
console.log(`\nscreenshots:\n${shots.map((f) => `  ${f}`).join('\n')}`);
console.log(`\nscan: ${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  FAIL ${f}`);
process.exit(failures.length ? 1 : 0);
