// PDF Reader tests — drive the real Electron shell with Playwright on PDFs generated here by hand.
//   Fixtures (written by makePdf below, no external tools): a 12-page document with text, an outline,
//   an internal and an external link, an image and document info; a 3-page one with attachments; an
//   RC4-encrypted one (password "secret"); a damaged file, a non-PDF and a missing path.
//   Covered: start page, open via args / relaunch / picker / drag & drop, tabs (state kept per tab,
//   Ctrl+T/W/Tab), page navigation (keys, page box, Ctrl+G), zoom (buttons, keys, menu presets),
//   rotation, page layouts, find (count, next/prev, match case, whole word, highlights), thumbnails,
//   outline, attachments, links (internal + confirmed external), copy / select all, dark reading mode,
//   properties, highlight / ink / free text annotations, save + reopen, save as, unsaved-changes
//   prompts, presentation mode, password prompt (wrong / right / cancel), error pages, recent list
//   (last page, thumbnail, remove), French + dark theme, minimum and maximized window sizes, console errors.
//   QA regressions: no stacked save prompts, middle-click links confirmed, Tab / F6 stay in the window,
//   crash-safe save (symlinks, temp files, failure kept + explained), background tabs, tampered Recent
//   list, Open with list, attachment name sanitizing, other apps' drag & drop, worker / DOM released
//   after 15 open-close cycles, French key names, maximized at 1280x720 and 1920x1080.
//   Documentation screenshots: aurora-os/docs/screenshots/pdf-*.png
// Usage:  cd aurora-os/shell && xvfb-run -a -s "-screen 0 1600x900x24" node test/pdf.test.mjs [--only=find]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { launchShell, ROOT } from './lib.mjs';

const DOCS = path.join(ROOT, '..', 'docs', 'screenshots');
fs.mkdirSync(DOCS, { recursive: true });
const only = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7).toLowerCase();

let passed = 0;
const failures = [];
function check(name, actual, expected) {
  const ok = typeof expected === 'function' ? !!expected(actual) : Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++;
  else failures.push(`${name}\n      expected: ${typeof expected === 'function' ? '(predicate)' : JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
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
async function until(fn, { timeout = 6000, step = 60, label = 'condition' } = {}) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    last = await fn();
    if (last) return last;
    await sleep(step);
  }
  throw new Error(`timed out waiting for ${label} (last: ${JSON.stringify(last)})`);
}

// ---------------------------------------------------------------- shell helpers
const WIN = '.win.app-pdf';
const DLG = `${WIN} > .dialog-layer:not(.closing) .dialog`;
// Evaluate fn(w, el, arg) for the last (or index-th) PDF Reader window. Built as an expression string:
// the shell's CSP forbids eval / new Function inside the page.
function W(s, fn, arg, index = -1) {
  const expr = `(() => { const all = [...document.querySelectorAll(${JSON.stringify(WIN)})]; const el = all.at(${index}); return (${fn.toString()})(el && el.__pdf, el, ${JSON.stringify(arg ?? null)}); })()`;
  return s.page.evaluate(expr);
}
const run = (s, expr) => s.page.evaluate(expr);
const winCount = (s) => run(s, `document.querySelectorAll(${JSON.stringify(WIN)}).length`);
const dialogOpen = (s) => run(s, `!!document.querySelector(${JSON.stringify(DLG)})`);
const dialogText = (s) => run(s, `document.querySelector(${JSON.stringify(DLG)})?.innerText || ''`);
async function dialogButton(s, label) {
  await until(() => dialogOpen(s), { label: 'dialog' });
  const btn = s.page.locator(`${DLG} .dialog-footer button`, { hasText: label }).first();
  await btn.click();
  await sleep(250);
}
const state = (s, index) =>
  W(
    s,
    (w) => {
      const d = w?.active;
      return d
        ? { state: d.state, page: d.pageNum, pages: d.pages, scale: d.viewer?.currentScale, scaleValue: d.scaleValue, rotation: d.viewer?.pagesRotation, mode: d.mode, dirty: d.dirty, path: d.path, error: d.error?.kind || null }
        : null;
    },
    null,
    index,
  );
const ready = (s, label = 'document ready') => until(async () => (await state(s))?.state === 'ready' && (await run(s, `!!document.querySelector('${WIN} .pdf-doc:not([hidden]) .textLayer span')`)), { label, timeout: 15000 });
async function openFile(s, file) {
  await s.aurora((p) => window.__aurora.shell.openFile(p), file);
}
async function focusDoc(s) {
  await W(s, (w) => w.active?.focus());
  await sleep(50);
}
async function shotDoc(s, name) {
  await sleep(350);
  const file = await s.shot(name);
  fs.copyFileSync(file, path.join(DOCS, `${name}.png`));
}
/** Drag across a text run of the given page that contains `text` (fraction of its width). */
async function dragText(s, page, text, frac = 0.6) {
  const box = await run(
    s,
    `(() => { const spans = [...document.querySelectorAll('${WIN} .pdf-doc:not([hidden]) .page[data-page-number="${page}"] .textLayer span')]; const sp = spans.find((x) => x.textContent.includes(${JSON.stringify(text)})); if (!sp) return null; const r = sp.getBoundingClientRect(); return { x: r.left, y: r.top + r.height / 2, w: r.width }; })()`,
  );
  if (!box) throw new Error(`text "${text}" not found on page ${page}`);
  await s.page.mouse.move(box.x + 2, box.y);
  await s.page.mouse.down();
  await s.page.mouse.move(box.x + box.w * frac, box.y, { steps: 10 });
  await s.page.mouse.up();
  return box;
}
/** Part of a page that is visible in the document view. */
async function visibleRect(s, page) {
  return run(
    s,
    `(() => { const sc = document.querySelector('${WIN} .pdf-doc:not([hidden]) .pdf-scroller').getBoundingClientRect(); const r = document.querySelector('${WIN} .pdf-doc:not([hidden]) .page[data-page-number="${page}"]').getBoundingClientRect(); const x = Math.max(r.left, sc.left), y = Math.max(r.top, sc.top); return { x, y, w: Math.min(r.right, sc.right) - x, h: Math.min(r.bottom, sc.bottom) - y }; })()`,
  );
}
async function pageRect(s, page) {
  return run(s, `(() => { const p = document.querySelector('${WIN} .pdf-doc:not([hidden]) .page[data-page-number="${page}"]'); const r = p.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
}

// ================================================================== PDF generator
// Writes real PDF files by hand: multi-page text (Helvetica), an outline, link annotations, an RGB image,
// document info, embedded files and the standard security handler (RC4, revision 2).

const PAD = Buffer.from('28BF4E5E4E758A4164004E56FFFA01082E2E00B6D0683E802F0CA9FE6453697A', 'hex');

function rc4(key, data) {
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i++) s[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
  }
  const out = Buffer.alloc(data.length);
  let i = 0;
  j = 0;
  for (let k = 0; k < data.length; k++) {
    i = (i + 1) & 255;
    j = (j + s[i]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
    out[k] = data[k] ^ s[(s[i] + s[j]) & 255];
  }
  return out;
}
const md5 = (...parts) => crypto.createHash('md5').update(Buffer.concat(parts.map((p) => Buffer.from(p)))).digest();
const padPw = (pw) => Buffer.concat([Buffer.from(pw || '', 'latin1'), PAD]).subarray(0, 32);

// Standard security handler, revision 2 (40-bit RC4).
function makeEncryption(userPw, ownerPw, id0) {
  const P = -4; // all permissions
  const oKey = md5(padPw(ownerPw || userPw)).subarray(0, 5);
  const O = rc4(oKey, padPw(userPw));
  const pBuf = Buffer.alloc(4);
  pBuf.writeInt32LE(P);
  const key = md5(padPw(userPw), O, pBuf, id0).subarray(0, 5);
  const U = rc4(key, PAD);
  return { O, U, P, key };
}

const esc = (s) => String(s).replace(/[\\()]/g, (m) => `\\${m}`);

/**
 * makePdf({ pages, title, author, ..., outline, links, image, password }) -> Buffer
 */
function makePdf(opts = {}) {
  const n = opts.pages ?? 12;
  const W = 595;
  const H = 842;
  const objs = []; // index = obj number - 1 ; value = { dict: string|fn, stream?: Buffer }
  const alloc = () => {
    objs.push(null);
    return objs.length;
  };
  const catalog = alloc();
  const pagesObj = alloc();
  const fontR = alloc();
  const fontB = alloc();
  const info = alloc();
  const imgObj = opts.image !== false ? alloc() : 0;
  const pageNums = [];
  const contentNums = [];
  for (let i = 0; i < n; i++) {
    pageNums.push(alloc());
    contentNums.push(alloc());
  }
  const id0 = crypto.createHash('md5').update(`aurora-${opts.title || ''}-${n}`).digest();
  const enc = opts.password ? makeEncryption(opts.password, opts.ownerPassword || `${opts.password}-owner`, id0) : null;
  const encObj = enc ? alloc() : 0;

  // string serializer that encrypts per object
  const strFor = (num) => (s) => {
    const raw = Buffer.from(String(s), 'latin1');
    if (!enc) return `(${esc(s)})`;
    const k = objKey(enc.key, num);
    return `<${rc4(k, raw).toString('hex')}>`;
  };
  function objKey(key, num, gen = 0) {
    const b = Buffer.alloc(5);
    b.writeUIntLE(num, 0, 3);
    b.writeUInt16LE(gen, 3);
    return md5(key, b).subarray(0, Math.min(key.length + 5, 16));
  }

  const set = (num, dict, stream) => {
    objs[num - 1] = { dict, stream };
  };

  // ---- fonts
  set(fontR, () => '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  set(fontB, () => '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');

  // ---- image: 64x64 RGB gradient with a circle
  if (imgObj) {
    const S = 64;
    const px = Buffer.alloc(S * S * 3);
    for (let y = 0; y < S; y++)
      for (let x = 0; x < S; x++) {
        const o = (y * S + x) * 3;
        const inC = (x - 32) ** 2 + (y - 32) ** 2 < 18 ** 2;
        px[o] = inC ? 250 : 30 + x * 3;
        px[o + 1] = inC ? 200 : 90 + y * 2;
        px[o + 2] = inC ? 40 : 200;
      }
    set(imgObj, (len) => `<< /Type /XObject /Subtype /Image /Width ${S} /Height ${S} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${len} >>`, px);
  }

  // ---- page texts
  const pageText = opts.pageText || ((i) => defaultPageText(i, n));
  const annotsByPage = new Map();
  if (opts.links !== false && n >= 5) {
    // page 1: internal link to page 5 + external link
    const l1 = alloc();
    const l2 = alloc();
    set(l1, () => `<< /Type /Annot /Subtype /Link /Rect [68 598 220 620] /Border [0 0 0] /Dest [${pageNums[4]} 0 R /Fit] >>`);
    set(l2, (_, S) => `<< /Type /Annot /Subtype /Link /Rect [68 568 220 590] /Border [0 0 0] /A << /S /URI /URI ${S('https://example.com/aurora')} >> >>`);
    annotsByPage.set(0, [l1, l2]);
  }
  for (let i = 0; i < n; i++) {
    const lines = pageText(i);
    let content = 'BT\n';
    let y = H - 90;
    lines.forEach((ln, k) => {
      const big = k === 0;
      content += `/${big ? 'F2' : 'F1'} ${big ? 24 : 12} Tf\n1 0 0 1 72 ${y} Tm\n(${esc(ln)}) Tj\n`;
      y -= big ? 40 : 20;
    });
    if (i === 0 && annotsByPage.has(0)) {
      content += `/F1 12 Tf\n0 0 0.8 rg\n1 0 0 1 72 605 Tm\n(Go to page 5) Tj\n1 0 0 1 72 575 Tm\n(Visit example.com) Tj\n0 0 0 rg\n`;
    }
    content += 'ET\n';
    // footer page number
    content += `BT /F1 10 Tf 1 0 0 1 ${W / 2 - 10} 40 Tm (${i + 1}) Tj ET\n`;
    if (imgObj && i === 1) content += `q 200 0 0 200 72 300 cm /Im1 Do Q\n`;
    // a colored rectangle to make thumbnails distinguishable
    content += `q ${[0.2, 0.5, 0.8][i % 3]} 0.4 ${[0.8, 0.3, 0.2][i % 3]} rg 72 ${H - 60} ${60 + i * 30} 8 re f Q\n`;
    const buf = Buffer.from(content, 'latin1');
    set(contentNums[i], (len) => `<< /Length ${len} >>`, buf);
    const annots = annotsByPage.get(i);
    set(
      pageNums[i],
      () =>
        `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 ${fontR} 0 R /F2 ${fontB} 0 R >>${imgObj ? ` /XObject << /Im1 ${imgObj} 0 R >>` : ''} >> /Contents ${contentNums[i]} 0 R${annots ? ` /Annots [${annots.map((a) => `${a} 0 R`).join(' ')}]` : ''} >>`,
    );
  }
  set(pagesObj, () => `<< /Type /Pages /Kids [${pageNums.map((p) => `${p} 0 R`).join(' ')}] /Count ${n} >>`);

  // ---- outline
  let outlineRoot = 0;
  if (opts.outline !== false && n >= 6) {
    outlineRoot = alloc();
    const items = [
      { title: 'Introduction', page: 0 },
      { title: 'Chapter 2: Details', page: 2, kids: [{ title: 'Section 2.1', page: 3 }, { title: 'Section 2.2', page: 4 }] },
      { title: 'Chapter 3: Conclusion', page: n - 1 },
    ];
    const build = (list, parent) => {
      const nums = list.map(() => alloc());
      list.forEach((it, k) => {
        const kidsNums = it.kids ? build(it.kids, nums[k]) : null;
        set(nums[k], (_, S) => {
          let d = `<< /Title ${S(it.title)} /Parent ${parent} 0 R /Dest [${pageNums[it.page]} 0 R /XYZ 0 ${H} null]`;
          if (k > 0) d += ` /Prev ${nums[k - 1]} 0 R`;
          if (k < list.length - 1) d += ` /Next ${nums[k + 1]} 0 R`;
          if (kidsNums) d += ` /First ${kidsNums[0]} 0 R /Last ${kidsNums.at(-1)} 0 R /Count ${kidsNums.length}`;
          return `${d} >>`;
        });
      });
      return nums;
    };
    const top = build(items, outlineRoot);
    set(outlineRoot, () => `<< /Type /Outlines /First ${top[0]} 0 R /Last ${top.at(-1)} 0 R /Count ${top.length} >>`);
  }

  // ---- embedded files (attachments)
  let namesDict = '';
  if (opts.attachments?.length) {
    const specs = [];
    for (const a of opts.attachments) {
      const fileObj = alloc();
      const specObj = alloc();
      set(fileObj, (len) => `<< /Type /EmbeddedFile /Length ${len} >>`, Buffer.from(a.content, 'utf8'));
      set(specObj, (_, S) => `<< /Type /Filespec /F ${S(a.name)} /UF ${S(a.name)} /EF << /F ${fileObj} 0 R >> >>`);
      specs.push([a.name, specObj]);
    }
    specs.sort((x, y) => (x[0] < y[0] ? -1 : 1));
    namesDict = (S) => ` /Names << /EmbeddedFiles << /Names [${specs.map(([n, o]) => `${S(n)} ${o} 0 R`).join(' ')}] >> >>`;
  }
  // A document-level script (must never run in the reader).
  const openAction = opts.openActionJS ? (S) => ` /OpenAction << /S /JavaScript /JS ${S(opts.openActionJS)} >>` : null;
  set(catalog, (_, S) => `<< /Type /Catalog /Pages ${pagesObj} 0 R${outlineRoot ? ` /Outlines ${outlineRoot} 0 R` : ''}${namesDict ? namesDict(S) : ''}${openAction ? openAction(S) : ''} >>`);
  set(info, (_, S) => {
    const f = (k, v) => (v ? ` /${k} ${S(v)}` : '');
    return `<<${f('Title', opts.title ?? 'Aurora Test Document')}${f('Author', opts.author ?? 'Ada Lovelace')}${f('Subject', opts.subject ?? 'Testing the PDF Reader')}${f('Keywords', opts.keywords ?? 'aurora, pdf, test')}${f('Creator', opts.creator ?? 'Aurora Test Suite')}${f('Producer', opts.producer ?? 'mkpdf.mjs')}${f('CreationDate', "D:20240115103000+01'00'")}${f('ModDate', "D:20240220143000+01'00'")} >>`;
  });
  if (enc) {
    set(encObj, () => `<< /Filter /Standard /V 1 /R 2 /O <${enc.O.toString('hex')}> /U <${enc.U.toString('hex')}> /P ${enc.P} >>`);
  }

  // ---- serialize
  const chunks = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  let pos = chunks[0].length;
  const offsets = [];
  objs.forEach((o, idx) => {
    const num = idx + 1;
    offsets[num] = pos;
    const isEncDict = num === encObj;
    const S = isEncDict || !enc ? (s) => `(${esc(s)})` : strFor(num);
    let stream = o.stream;
    if (stream && enc && !isEncDict) stream = rc4(objKey(enc.key, num), stream);
    const dict = o.dict(stream ? stream.length : 0, S);
    const parts = [Buffer.from(`${num} 0 obj\n${dict}\n`, 'latin1')];
    if (stream) parts.push(Buffer.from('stream\n', 'latin1'), stream, Buffer.from('\nendstream\n', 'latin1'));
    parts.push(Buffer.from('endobj\n', 'latin1'));
    const b = Buffer.concat(parts);
    chunks.push(b);
    pos += b.length;
  });
  const xrefPos = pos;
  let xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objs.length; i++) xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  xref += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R /ID [<${id0.toString('hex')}> <${id0.toString('hex')}>]${enc ? ` /Encrypt ${encObj} 0 R` : ''} >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  chunks.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(chunks);
}

function defaultPageText(i, n) {
  const p = i + 1;
  const lines = [i === 0 ? 'Introduction' : i === 2 ? 'Chapter 2: Details' : i === n - 1 ? 'Chapter 3: Conclusion' : `Page ${p}`];
  lines.push(`This is page ${p} of the test document.`);
  // "Aurora" (capitalised) once on every odd page -> ceil(n/2) case-sensitive matches
  if (p % 2 === 1) lines.push('The Aurora reader renders this paragraph.');
  if (p === 2) lines.push('Lowercase aurora appears here once.');
  if (p === 4) lines.push('Several auroras were seen tonight.');
  lines.push('Lorem ipsum dolor sit amet, consectetur adipiscing elit.');
  lines.push('Sed do eiusmod tempor incididunt ut labore et dolore magna.');
  if (p === 7) lines.push('Unique needle: zebrafinch.');
  return lines;
}

// ================================================================== fixtures
function writeFixtures(home) {
  const dir = path.join(home, 'Documents');
  const f = {
    guide: path.join(dir, 'Aurora guide.pdf'),
    second: path.join(dir, 'Second document.pdf'),
    att: path.join(dir, 'With attachments.pdf'),
    enc: path.join(dir, 'Locked.pdf'),
    broken: path.join(dir, 'Broken.pdf'),
    notPdf: path.join(dir, 'Not really.pdf'),
    truncated: path.join(dir, 'Truncated.pdf'),
    missing: path.join(dir, 'Gone.pdf'),
    other: path.join(home, 'Downloads', 'Picked.pdf'),
    script: path.join(dir, 'Scripted.pdf'),
  };
  fs.writeFileSync(f.guide, makePdf());
  fs.writeFileSync(f.second, makePdf({ pages: 3, outline: false, links: false, image: false, title: 'Second Document', author: 'Grace Hopper' }));
  fs.writeFileSync(f.att, makePdf({ pages: 3, outline: false, links: false, attachments: [{ name: 'notes.txt', content: 'Hello from the attachment' }, { name: 'data.csv', content: 'a,b\n1,2\n' }] }));
  fs.writeFileSync(f.enc, makePdf({ pages: 3, outline: false, links: false, password: 'secret', title: 'Locked Document' }));
  fs.writeFileSync(f.broken, Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R\nthis is not a valid pdf at all\n%%EOF\n'));
  fs.writeFileSync(f.notPdf, 'Just some text, definitely not a PDF document.\n');
  const g = makePdf();
  fs.writeFileSync(f.truncated, g.subarray(0, Math.floor(g.length / 3)));
  fs.writeFileSync(f.other, makePdf({ pages: 2, outline: false, links: false, title: 'Picked' }));
  fs.writeFileSync(f.script, makePdf({ pages: 2, outline: false, links: false, title: 'Scripted', openActionJS: 'app.alert("script ran"); this.zoom = 400; this.pageNum = 1;' }));
  return f;
}

// ================================================================== run 1: English, light theme
async function runMain() {
  console.log('PDF Reader — English / light');
  const s = await launchShell({ lang: 'en', theme: 'light' });
  const f = writeFixtures(s.home);
  const bad404 = [];
  s.page.on('response', (r) => {
    if (r.status() >= 400 && /\/apps\/pdf\/|pdfjs-dist/.test(r.url())) bad404.push(`${r.status()} ${r.url()}`);
  });
  recover = async () => {
    for (let i = 0; i < 6; i++) {
      const busy = await run(s, `!!document.querySelector('body > .menu, ${DLG}, ${WIN} .pdf-flyout')`).catch(() => false);
      if (!busy) break;
      await s.page.keyboard.press('Escape').catch(() => {});
      // dialogs only see keys when they hold the focus: close leftovers directly
      await run(s, `[...document.querySelectorAll('.dialog-layer:not(.closing) .dialog')].reverse().forEach((d) => d._done?.(null))`).catch(() => {});
      await sleep(250);
    }
    await W(s, (w) => {
      if (!w) return;
      if (w.presenting) w.exitPresentation();
      w.find.close({ focusDoc: false });
      if (w.active?.mode) {
        w.active.tool = 0;
        w.active.setMode(0);
      }
    }).catch(() => {});
  };

  await section('start page', async () => {
    await s.aurora(() => window.__aurora.registry.launch('pdf'));
    await until(() => run(s, `!!document.querySelector('${WIN} .pdf-start:not([hidden]) .pdf-start-open')`), { label: 'start page' });
    check('start: one tab', await W(s, (w) => w.tabs.length), 1);
    check('start: toolbar hidden', await run(s, `document.querySelector('${WIN} .pdf-toolbar').hidden`), true);
    check('start: tab title', await run(s, `document.querySelector('${WIN} .pdf-tab .pdf-tab-title').textContent`), 'New tab');
    check('start: empty recent', await run(s, `document.querySelector('${WIN} .pdf-recent-empty')?.textContent || ''`), (t) => t.includes('Documents you open will appear here'));
    check('start: window title', await W(s, (w) => w.win.title), 'PDF Reader');
    await shotDoc(s, 'pdf-start');
  });

  await section('open via args', async () => {
    await openFile(s, f.guide);
    await ready(s);
    const st = await state(s);
    check('open: pages', st.pages, 12);
    check('open: start tab reused', await W(s, (w) => w.tabs.length), 1);
    check('open: tab title', await run(s, `document.querySelector('${WIN} .pdf-tab.active .pdf-tab-title').textContent`), 'Aurora guide.pdf');
    check('open: window title', await W(s, (w) => w.win.title), 'Aurora guide.pdf - PDF Reader');
    check('open: text layer', await run(s, `document.querySelector('${WIN} .page[data-page-number="1"] .textLayer').textContent`), (t) => t.includes('Introduction') && t.includes('Aurora reader'));
    check('open: canvas rendered', await run(s, `!!document.querySelector('${WIN} .page[data-page-number="1"] canvas')`), true);
    check('open: page box', await run(s, `[document.querySelector('${WIN} .pdf-pagebox').value, document.querySelector('${WIN} .pdf-pagecount').textContent]`), ['1', '/ 12']);
    check('open: zoom label is a percentage', await run(s, `document.querySelector('${WIN} .pdf-zoom-label').textContent`), (t) => /^\d+%$/.test(t));
    check('open: default for .pdf', await s.aurora(() => window.__aurora.registry.handlerFor('/x/y.PDF')), 'pdf');
    await until(() => run(s, `document.querySelectorAll('${WIN} .pdf-thumb-frame canvas').length >= 2`), { label: 'thumbnails rendered' });
    await shotDoc(s, 'pdf-document');
  });

  await section('page navigation', async () => {
    await focusDoc(s);
    await s.page.keyboard.press('End');
    await until(async () => (await state(s)).page === 12, { label: 'End -> last page' });
    check('nav: End', (await state(s)).page, 12);
    await s.page.keyboard.press('Home');
    await until(async () => (await state(s)).page === 1, { label: 'Home -> first page' });
    await s.page.keyboard.press('ArrowRight');
    await until(async () => (await state(s)).page === 2, { label: 'ArrowRight -> next page' });
    await s.page.keyboard.press('ArrowLeft');
    await until(async () => (await state(s)).page === 1, { label: 'ArrowLeft -> previous page' });
    const topA = await run(s, `document.querySelector('${WIN} .pdf-doc:not([hidden]) .pdf-scroller').scrollTop`);
    await s.page.keyboard.press('ArrowDown');
    await sleep(400);
    check('nav: ArrowDown scrolls', await run(s, `document.querySelector('${WIN} .pdf-doc:not([hidden]) .pdf-scroller').scrollTop`), (v) => v > topA);
    await s.page.keyboard.press('Home');
    await sleep(200);
    const top0 = await run(s, `document.querySelector('${WIN} .pdf-doc:not([hidden]) .pdf-scroller').scrollTop`);
    await s.page.keyboard.press('PageDown');
    await sleep(500);
    check('nav: PageDown scrolls a screen', await run(s, `document.querySelector('${WIN} .pdf-doc:not([hidden]) .pdf-scroller').scrollTop`), (v) => v > top0 + 300);
    for (let i = 0; i < 3; i++) await s.page.keyboard.press('PageDown');
    await until(async () => (await state(s)).page >= 2, { label: 'PageDown reaches page 2' });
    await s.page.click(`${WIN} .pdf-pagebox`);
    await s.page.keyboard.type('7');
    await s.page.keyboard.press('Enter');
    await until(async () => (await state(s)).page === 7, { label: 'page box -> 7' });
    check('nav: page box', (await state(s)).page, 7);
    check('nav: focus back in document', await run(s, `document.activeElement?.classList.contains('pdf-scroller')`), true);
    await s.page.keyboard.press('Control+g');
    check('nav: Ctrl+G focuses the page box', await run(s, `document.activeElement?.classList.contains('pdf-pagebox')`), true);
    await s.page.keyboard.type('99');
    await s.page.keyboard.press('Enter');
    await until(async () => (await state(s)).page === 12, { label: 'page box clamps to 12' });
    await s.page.keyboard.press('Control+g');
    await s.page.keyboard.type('3');
    await s.page.keyboard.press('Escape');
    check('nav: Escape restores page box', await run(s, `document.querySelector('${WIN} .pdf-pagebox').value`), '12');
    await W(s, (w) => w.active.goToPage(3));
    await until(async () => (await state(s)).page === 3, { label: 'goToPage 3' });
  });

  await section('zoom', async () => {
    await W(s, (w) => w.active.setZoom('page-actual'));
    await until(async () => Math.abs((await state(s)).scale - 1) < 0.01, { label: 'actual size' });
    await s.page.click(`${WIN} [data-cmd="zoomIn"]`);
    await until(async () => Math.abs((await state(s)).scale - 1.1) < 0.01, { label: 'zoom in -> 110%' });
    check('zoom: label 110%', await run(s, `document.querySelector('${WIN} .pdf-zoom-label').textContent`), '110%');
    await focusDoc(s);
    await s.page.keyboard.press('Control+=');
    await until(async () => Math.abs((await state(s)).scale - 1.25) < 0.01, { label: 'Ctrl+= -> 125%' });
    await s.page.keyboard.press('Control+-');
    await s.page.keyboard.press('Control+-');
    await until(async () => Math.abs((await state(s)).scale - 1) < 0.01, { label: 'Ctrl+- twice -> 100%' });
    await s.page.click(`${WIN} [data-cmd="zoomOut"]`);
    await until(async () => Math.abs((await state(s)).scale - 0.9) < 0.01, { label: 'zoom out -> 90%' });
    await s.page.keyboard.press('Control+0');
    await until(async () => (await state(s)).scaleValue === 'auto', { label: 'Ctrl+0 -> automatic' });
    await s.page.click(`${WIN} .pdf-tb-zoom`);
    await until(() => run(s, `!!document.querySelector('body > .menu')`), { label: 'zoom menu' });
    check('zoom: menu entries', await run(s, `[...document.querySelectorAll('body > .menu .menu-item .label')].map((e) => e.textContent)`), (l) => ['Automatic', 'Actual size', 'Fit to page', 'Fit to width', '50%', '200%', '400%'].every((x) => l.includes(x)));
    check('zoom: Automatic checked', await run(s, `[...document.querySelectorAll('body > .menu .menu-item')].find((e) => e.textContent.includes('Automatic'))?.querySelector('.check .icon') != null`), true);
    await s.page.click('body > .menu .menu-item >> text=Fit to width');
    await until(async () => (await state(s)).scaleValue === 'page-width', { label: 'page width' });
    const pw = await run(s, `(() => { const sc = document.querySelector('${WIN} .pdf-doc:not([hidden]) .pdf-scroller'); const p = sc.querySelector('.page'); return { sw: sc.clientWidth, pw: p.getBoundingClientRect().width }; })()`);
    check('zoom: page width fills the view', pw.pw, (v) => v > pw.sw - 60 && v <= pw.sw);
    await s.page.click(`${WIN} .pdf-tb-zoom`);
    await s.page.click('body > .menu .menu-item >> text=Fit to page');
    await until(async () => (await state(s)).scaleValue === 'page-fit', { label: 'page fit' });
    const fit = await run(s, `(() => { const sc = document.querySelector('${WIN} .pdf-doc:not([hidden]) .pdf-scroller'); const p = sc.querySelector('.page'); return { sh: sc.clientHeight, ph: p.getBoundingClientRect().height }; })()`);
    check('zoom: whole page fits', fit.ph, (v) => v <= fit.sh + 20 && v > fit.sh - 80);
    await s.page.click(`${WIN} .pdf-tb-zoom`);
    await s.page.click('body > .menu .menu-item >> text=200%');
    await until(async () => Math.abs((await state(s)).scale - 2) < 0.01, { label: '200%' });
    check('zoom: label 200%', await run(s, `document.querySelector('${WIN} .pdf-zoom-label').textContent`), '200%');
    // Ctrl + wheel zooms around the pointer
    const r = await pageRect(s, 3);
    await s.page.mouse.move(r.x + 100, r.y + 100);
    await s.page.keyboard.down('Control');
    await s.page.mouse.wheel(0, 120);
    await s.page.keyboard.up('Control');
    await until(async () => Math.abs((await state(s)).scale - 1.75) < 0.01, { label: 'Ctrl+wheel -> 175%' });
    await W(s, (w) => w.active.setZoom('auto'));
    await until(async () => (await state(s)).scaleValue === 'auto', { label: 'auto' });
  });

  await section('rotate and layout', async () => {
    await s.page.click(`${WIN} [data-cmd="rotateRight"]`);
    await until(async () => (await state(s)).rotation === 90, { label: 'rotate right' });
    check('rotate: page is landscape', await run(s, `(() => { const p = document.querySelector('${WIN} .pdf-doc:not([hidden]) .page[data-page-number="3"]'); return p.clientWidth > p.clientHeight; })()`), true);
    await until(() => run(s, `(() => { const c = document.querySelector('${WIN} .pdf-thumb[data-page="1"] canvas'); return !!c && c.width > c.height; })()`), { label: 'thumbnail rotated' });
    await focusDoc(s);
    await s.page.keyboard.press('Control+[');
    await until(async () => (await state(s)).rotation === 0, { label: 'Ctrl+[ rotates back' });
    await s.page.click(`${WIN} [data-cmd="rotateLeft"]`);
    await until(async () => (await state(s)).rotation === 270, { label: 'rotate left' });
    await W(s, (w) => w.active.rotate(90));
    await until(async () => (await state(s)).rotation === 0, { label: 'rotation 0' });
    await s.page.click(`${WIN} [data-cmd="layout"]`);
    await until(() => run(s, `!!document.querySelector('body > .menu')`), { label: 'layout menu' });
    await s.page.click('body > .menu .menu-item >> text=Two pages with cover');
    await until(() => W(s, (w) => w.active.viewer.spreadMode === 2), { label: 'cover spread' });
    check('layout: spread shown', await run(s, `document.querySelectorAll('${WIN} .pdf-doc:not([hidden]) .spread').length > 0`), true);
    await s.page.click(`${WIN} [data-cmd="layout"]`);
    await s.page.click('body > .menu .menu-item >> text=Two pages');
    await until(() => W(s, (w) => w.active.viewer.spreadMode === 1), { label: 'odd spread' });
    await shotDoc(s, 'pdf-two-pages');
    await s.page.click(`${WIN} [data-cmd="layout"]`);
    await s.page.click('body > .menu .menu-item >> text=Single page');
    await until(() => W(s, (w) => w.active.viewer.scrollMode === 3 && w.active.viewer.spreadMode === 0), { label: 'single page' });
    const p0 = (await state(s)).page;
    await focusDoc(s);
    await s.page.keyboard.press('PageDown');
    await until(async () => (await state(s)).page === p0 + 1, { label: 'single page: PageDown -> next page' });
    check('layout: single page kept on the document', await W(s, (w) => w.active.layout), 'single');
    await s.page.click(`${WIN} [data-cmd="layout"]`);
    await s.page.click('body > .menu .menu-item >> text=Continuous scrolling');
    await until(() => W(s, (w) => w.active.viewer.scrollMode === 0 && w.active.viewer.spreadMode === 0), { label: 'continuous' });
  });

  await section('find', async () => {
    await W(s, (w) => w.active.goToPage(1));
    await until(async () => (await state(s)).page === 1, { label: 'page 1' });
    await focusDoc(s);
    await s.page.keyboard.press('Control+f');
    await until(() => run(s, `!document.querySelector('${WIN} .pdf-find').hidden && document.activeElement?.classList.contains('pdf-find-input')`), { label: 'find bar' });
    await s.page.keyboard.type('aurora');
    const count = () => run(s, `document.querySelector('${WIN} .pdf-find-count').textContent`);
    await until(async () => (await count()) === '1 of 8', { label: 'find: 1 of 8' });
    check('find: highlights shown', await run(s, `document.querySelectorAll('${WIN} .pdf-doc:not([hidden]) .textLayer .highlight').length`), (n) => n >= 1);
    check('find: current match selected', await run(s, `!!document.querySelector('${WIN} .pdf-doc:not([hidden]) .textLayer .highlight.selected')`), true);
    await s.page.keyboard.press('Enter');
    await until(async () => (await count()) === '2 of 8', { label: 'Enter -> 2 of 8' });
    await s.page.keyboard.press('Shift+Enter');
    await until(async () => (await count()) === '1 of 8', { label: 'Shift+Enter -> 1 of 8' });
    await s.page.keyboard.press('F3');
    await until(async () => (await count()) === '2 of 8', { label: 'F3 -> 2 of 8' });
    await s.page.click(`${WIN} .pdf-find-btn.next`);
    await until(async () => (await count()) === '3 of 8', { label: 'next button -> 3 of 8' });
    await s.page.click(`${WIN} .pdf-find-btn.case`);
    // lower-case "aurora": page 2 ("aurora") and page 4 ("auroras") only
    await until(async () => /of 2$/.test(await count()), { label: 'match case -> 2' });
    check('find: match case pressed', await run(s, `document.querySelector('${WIN} .pdf-find-btn.case').getAttribute('aria-pressed')`), 'true');
    await s.page.click(`${WIN} .pdf-find-btn.case`);
    await s.page.click(`${WIN} .pdf-find-btn.word`);
    await until(async () => /of 7$/.test(await count()), { label: 'whole word -> 7' });
    await s.page.click(`${WIN} .pdf-find-btn.word`);
    await until(async () => /of 8$/.test(await count()), { label: 'back to 8' });
    await shotDoc(s, 'pdf-find');
    await s.page.fill(`${WIN} .pdf-find-input`, 'zebrafinch');
    await until(async () => (await count()) === '1 of 1', { label: 'unique needle' });
    await until(async () => (await state(s)).page === 7, { label: 'jumped to page 7' });
    await s.page.fill(`${WIN} .pdf-find-input`, 'qwertyuiop');
    await until(async () => (await count()) === 'No results', { label: 'no results' });
    check('find: not-found style', await run(s, `document.querySelector('${WIN} .pdf-find').classList.contains('not-found')`), true);
    check('find: prev/next disabled', await run(s, `document.querySelector('${WIN} .pdf-find-btn.next').disabled`), true);
    await s.page.keyboard.press('Escape');
    await until(() => run(s, `document.querySelector('${WIN} .pdf-find').hidden`), { label: 'find closed' });
    check('find: highlights cleared', await run(s, `document.querySelectorAll('${WIN} .pdf-doc:not([hidden]) .textLayer .highlight').length`), 0);
  });

  await section('thumbnails', async () => {
    check('thumbs: sidebar open', await run(s, `!document.querySelector('${WIN} .pdf-sidebar').hidden`), true);
    check('thumbs: 12 pages', await run(s, `document.querySelectorAll('${WIN} .pdf-thumb').length`), 12);
    await s.page.click(`${WIN} .pdf-thumb[data-page="2"]`);
    await until(async () => (await state(s)).page === 2, { label: 'thumb 2' });
    check('thumbs: selected follows', await run(s, `document.querySelector('${WIN} .pdf-thumb.selected')?.dataset.page`), '2');
    await W(s, (w) => w.active.goToPage(9));
    await until(() => run(s, `document.querySelector('${WIN} .pdf-thumb.selected')?.dataset.page === '9'`), { label: 'thumb follows page 9' });
    await until(() => run(s, `!!document.querySelector('${WIN} .pdf-thumb[data-page="9"] canvas')`), { label: 'thumb 9 rendered (lazy)' });
    // keyboard in the thumbnail list
    await s.page.focus(`${WIN} .pdf-thumbs`);
    await s.page.keyboard.press('ArrowDown');
    await until(async () => (await state(s)).page === 10, { label: 'ArrowDown in thumbnails' });
    await s.page.keyboard.press('Home');
    await until(async () => (await state(s)).page === 1, { label: 'Home in thumbnails' });
    // toggle the sidebar
    await s.page.click(`${WIN} [data-cmd="sidebar"]`);
    await until(() => run(s, `document.querySelector('${WIN} .pdf-sidebar').hidden`), { label: 'sidebar hidden' });
    await focusDoc(s);
    await s.page.keyboard.press('F4');
    await until(() => run(s, `!document.querySelector('${WIN} .pdf-sidebar').hidden`), { label: 'F4 shows sidebar' });
  });

  await section('outline', async () => {
    await s.page.click(`${WIN} .pdf-pivot[data-view="outline"]`);
    await until(() => run(s, `document.querySelectorAll('${WIN} .pdf-ol-label').length === 5`), { label: 'outline items' });
    check('outline: titles', await run(s, `[...document.querySelectorAll('${WIN} .pdf-ol-label')].map((e) => e.textContent)`), ['Introduction', 'Chapter 2: Details', 'Section 2.1', 'Section 2.2', 'Chapter 3: Conclusion']);
    await s.page.click(`${WIN} .pdf-ol-label >> text=Section 2.2`);
    await until(async () => (await state(s)).page === 5, { label: 'Section 2.2 -> page 5' });
    await s.page.click(`${WIN} .pdf-ol-label >> text=Chapter 3: Conclusion`);
    await until(async () => (await state(s)).page === 12, { label: 'Chapter 3 -> page 12' });
    await until(() => run(s, `document.querySelector('${WIN} .pdf-ol-row.current')?.textContent === 'Chapter 3: Conclusion'`), { label: 'current outline item' });
    await s.page.click(`${WIN} .pdf-ol-item.has-kids > .pdf-ol-row .pdf-ol-chev`);
    check('outline: collapsed', await run(s, `document.querySelector('${WIN} .pdf-ol-item.has-kids').getAttribute('aria-expanded')`), 'false');
    check('outline: children hidden', await run(s, `[...document.querySelectorAll('${WIN} .pdf-ol-label')].filter((e) => e.offsetParent).length`), 3);
    await s.page.focus(`${WIN} .pdf-ol-item.has-kids`);
    await s.page.keyboard.press('ArrowRight');
    check('outline: ArrowRight expands', await run(s, `document.querySelector('${WIN} .pdf-ol-item.has-kids').getAttribute('aria-expanded')`), 'true');
    await s.page.keyboard.press('ArrowDown');
    await s.page.keyboard.press('Enter');
    await until(async () => (await state(s)).page === 4, { label: 'keyboard Enter -> Section 2.1 (page 4)' });
    await shotDoc(s, 'pdf-outline');
    await s.page.click(`${WIN} .pdf-pivot[data-view="thumbs"]`);
  });

  await section('links', async () => {
    await W(s, (w) => w.active.goToPage(1));
    await until(() => run(s, `document.querySelectorAll('${WIN} .pdf-doc:not([hidden]) .page[data-page-number="1"] .annotationLayer a').length === 2`), { label: 'link annotations' });
    await s.page.click(`${WIN} .pdf-doc:not([hidden]) .page[data-page-number="1"] .annotationLayer a[href^="#"]`);
    await until(async () => (await state(s)).page === 5, { label: 'internal link -> page 5' });
    await s.aurora(() => {
      window.__pdfTestUrls = [];
      window.__pdfTestOpenUrl = window.__aurora.shell.openUrl;
      window.__aurora.shell.openUrl = (u) => window.__pdfTestUrls.push(u);
    });
    await W(s, (w) => w.active.goToPage(1));
    await sleep(400);
    const ext = `${WIN} .pdf-doc:not([hidden]) .page[data-page-number="1"] .annotationLayer a[href^="https"]`;
    check('links: external href shown', await run(s, `document.querySelector('${ext}')?.title`), 'https://example.com/aurora');
    await s.page.click(ext);
    await until(() => dialogOpen(s), { label: 'link confirmation' });
    check('links: dialog shows the URL', await dialogText(s), (t) => t.includes('https://example.com/aurora') && t.includes('Open this link?'));
    await dialogButton(s, 'Cancel');
    check('links: canceled -> nothing opened', await s.aurora(() => window.__pdfTestUrls.length), 0);
    check('links: shell not navigated', await run(s, `location.href.startsWith('app://shell/')`), true);
    await s.page.click(ext);
    await dialogButton(s, 'Open');
    check('links: opened in the browser', await s.aurora(() => window.__pdfTestUrls), ['https://example.com/aurora']);
    await s.page.click(ext);
    await dialogButton(s, 'Copy link');
    check('links: copy link', await s.page.evaluate(() => window.aurora.invoke('clipboard:readText')), 'https://example.com/aurora');
    await s.aurora(() => {
      window.__aurora.shell.openUrl = window.__pdfTestOpenUrl;
    });
  });

  await section('copy and context menu', async () => {
    await W(s, (w) => w.active.goToPage(1));
    await focusDoc(s);
    await s.page.keyboard.press('Control+a');
    check('copy: select all selects document text', await W(s, (w) => w.active.selectionInDoc()), (t) => t.includes('Introduction'));
    await s.page.keyboard.press('Control+c');
    await until(async () => (await s.page.evaluate(() => window.aurora.invoke('clipboard:readText'))).includes('Introduction'), { label: 'copied text' });
    const r = await pageRect(s, 1);
    await s.page.mouse.click(r.x + r.w / 2, r.y + r.h * 0.6, { button: 'right' });
    await until(() => run(s, `!!document.querySelector('body > .menu')`), { label: 'context menu' });
    check('ctx: entries', await run(s, `[...document.querySelectorAll('body > .menu .menu-item .label')].map((e) => e.textContent)`), (l) => ['Copy', 'Highlight', 'Select all', 'Rotate clockwise', 'Document properties'].every((x) => l.includes(x)));
    await s.page.keyboard.press('Escape');
    await run(s, `document.getSelection().removeAllRanges()`);
  });

  await section('dark reading mode', async () => {
    await s.page.click(`${WIN} [data-cmd="darkPages"]`);
    check('dark pages: on', await run(s, `document.querySelector('${WIN} .pdf-root').classList.contains('dark-pages')`), true);
    check('dark pages: canvas inverted', await run(s, `getComputedStyle(document.querySelector('${WIN} .pdf-doc:not([hidden]) .canvasWrapper')).filter`), (v) => v.includes('invert'));
    await shotDoc(s, 'pdf-dark-reading');
    await s.page.click(`${WIN} [data-cmd="darkPages"]`);
    check('dark pages: off', await run(s, `document.querySelector('${WIN} .pdf-root').classList.contains('dark-pages')`), false);
  });

  await section('properties', async () => {
    await focusDoc(s);
    await s.page.keyboard.press('Control+d');
    await until(() => run(s, `!!document.querySelector('${DLG} .pdf-props')`), { label: 'properties dialog' });
    const val = (k) => run(s, `document.querySelector('${DLG} dd[data-key="${k}"]')?.textContent`);
    check('props: title', await val('title'), 'Aurora Test Document');
    check('props: author', await val('author'), 'Ada Lovelace');
    check('props: subject', await val('subject'), 'Testing the PDF Reader');
    check('props: keywords', await val('keywords'), 'aurora, pdf, test');
    check('props: creator', await val('creator'), 'Aurora Test Suite');
    check('props: producer', await val('producer'), 'mkpdf.mjs');
    check('props: version', await val('version'), '1.4');
    check('props: pages', await val('pages'), '12');
    check('props: page size', await val('pageSize'), '8.26 × 11.69 in (A4, portrait)');
    check('props: created', await val('created'), (t) => t.includes('2024'));
    check('props: modified', await val('modified'), (t) => t.includes('2024'));
    check('props: file size', await val('size'), (t) => /bytes\)$/.test(t));
    check('props: location', await val('location'), path.dirname(f.guide));
    await shotDoc(s, 'pdf-properties');
    await s.page.keyboard.press('Enter');
    await until(async () => !(await dialogOpen(s)), { label: 'properties closed' });
  });

  await section('highlight, save and reopen', async () => {
    await W(s, (w) => w.active.goToPage(1));
    await sleep(300);
    await s.page.click(`${WIN} [data-cmd="highlight"]`);
    await until(async () => (await state(s)).mode === 9, { label: 'highlight mode' });
    check('highlight: button pressed', await run(s, `document.querySelector('${WIN} [data-cmd="highlight"]').getAttribute('aria-pressed')`), 'true');
    await dragText(s, 1, 'Aurora reader');
    await until(() => run(s, `document.querySelectorAll('${WIN} .pdf-doc:not([hidden]) .highlightEditor').length === 1`), { label: 'highlight created' });
    await until(async () => (await state(s)).dirty, { label: 'dirty' });
    check('highlight: tab shows unsaved dot', await run(s, `document.querySelector('${WIN} .pdf-tab.active').classList.contains('dirty')`), true);
    check('highlight: save enabled', await run(s, `document.querySelector('${WIN} [data-cmd="save"]').disabled`), false);
    await shotDoc(s, 'pdf-highlight');
    const before = fs.statSync(f.guide).size;
    await s.page.keyboard.press('Escape');
    await until(async () => (await state(s)).mode === 0, { label: 'Esc leaves highlight mode' });
    await focusDoc(s);
    await s.page.keyboard.press('Control+s');
    await until(() => fs.statSync(f.guide).size > before, { label: `file written (${JSON.stringify(await state(s))})` });
    await until(async () => !(await state(s)).dirty, { label: 'saved' });
    check('save: flash message', await run(s, `document.querySelector('${WIN} .pdf-hint').textContent`), 'Saved to Aurora guide.pdf');
    check('save: still a PDF', fs.readFileSync(f.guide).subarray(0, 5).toString(), '%PDF-');
    check('save: tab clean', await run(s, `document.querySelector('${WIN} .pdf-tab.active').classList.contains('dirty')`), false);
    // reopen: the highlight is now part of the file
    await s.page.keyboard.press('Control+t');
    await until(() => W(s, (w) => w.tabs.length === 2 && !w.active), { label: 'new tab' });
    await s.page.keyboard.press('Control+Tab');
    await until(() => W(s, (w) => !!w.active), { label: 'back to doc' });
    await s.page.keyboard.press('Control+w');
    await until(() => W(s, (w) => w.tabs.length === 1 && !w.active), { label: 'doc tab closed' });
    await openFile(s, f.guide);
    await ready(s);
    const ann = await W(s, async (w) => (await (await w.active.pdf.getPage(1)).getAnnotations()).map((a) => a.subtype));
    check('reopen: highlight annotation saved', ann, (a) => a.includes('Highlight'));
    await until(() => run(s, `!!document.querySelector('${WIN} .pdf-doc:not([hidden]) .page[data-page-number="1"] .annotationLayer .highlightAnnotation, ${WIN} .pdf-doc:not([hidden]) .page[data-page-number="1"] .annotationEditorLayer .highlightEditor, ${WIN} .pdf-doc:not([hidden]) .page[data-page-number="1"] .canvasWrapper')`), { label: 'highlight rendered' });
    check('reopen: not dirty', (await state(s)).dirty, false);
  });

  await section('ink, free text and unsaved prompts', async () => {
    await openFile(s, f.second);
    await ready(s);
    check('second: new tab', await W(s, (w) => w.tabs.length), 2);
    await s.page.click(`${WIN} [data-cmd="ink"]`);
    await until(async () => (await state(s)).mode === 15, { label: 'ink mode' });
    const r = await visibleRect(s, 1);
    await s.page.mouse.move(r.x + r.w * 0.3, r.y + r.h * 0.5);
    await s.page.mouse.down();
    for (let i = 1; i <= 12; i++) await s.page.mouse.move(r.x + r.w * (0.3 + i * 0.02), r.y + r.h * (0.5 + Math.sin(i / 2) * 0.03));
    await s.page.mouse.up();
    await s.page.click(`${WIN} [data-cmd="text"]`);
    await until(async () => (await state(s)).mode === 3, { label: 'text mode' });
    await until(async () => (await state(s)).dirty, { label: 'ink stroke made the document dirty' });
    check('ink: editor created', await run(s, `document.querySelectorAll('${WIN} .pdf-doc:not([hidden]) .inkEditor').length`), (n) => n >= 1);
    const click = { x: r.x + r.w * 0.3, y: r.y + r.h * 0.75 };
    await s.page.mouse.click(click.x, click.y);
    await until(() => run(s, `!!document.querySelector('${WIN} .pdf-doc:not([hidden]) .freeTextEditor .internal')`), { label: 'free text editor' });
    const ft = await run(s, `(() => { const r = document.querySelector('${WIN} .pdf-doc:not([hidden]) .freeTextEditor').getBoundingClientRect(); return { x: r.left, y: r.top }; })()`);
    check('text: editor placed where clicked', Math.abs(ft.x - click.x) < 40 && Math.abs(ft.y - click.y) < 60, true);
    await sleep(200);
    await s.page.keyboard.type('Hello Aurora');
    await s.page.keyboard.press('Escape');
    await sleep(300);
    check('text: free text kept', await run(s, `[...document.querySelectorAll('${WIN} .pdf-doc:not([hidden]) .freeTextEditor')].map((e) => e.textContent).join('|')`), (t) => t.includes('Hello Aurora'));
    await s.page.keyboard.press('Escape');
    await until(async () => (await state(s)).mode === 0, { label: 'Esc leaves text mode' });
    await shotDoc(s, 'pdf-annotations');
    // close the tab: Save / Don't save / Cancel
    await s.page.keyboard.press('Control+w');
    await until(() => dialogOpen(s), { label: 'unsaved prompt' });
    check('prompt: message', await dialogText(s), (t) => t.includes('Do you want to save the changes to Second document.pdf?'));
    check('prompt: buttons', await run(s, `[...document.querySelectorAll('${DLG} .dialog-footer button')].map((b) => b.textContent)`), ['Save', "Don't save", 'Cancel']);
    await dialogButton(s, 'Cancel');
    check('prompt: canceled keeps the tab', await W(s, (w) => w.tabs.length), 2);
    // closing the window prompts too
    await W(s, (w) => {
      w.win.close();
    });
    await until(() => dialogOpen(s), { label: 'window close prompt' });
    await dialogButton(s, 'Cancel');
    check('prompt: window kept', await winCount(s), 1);
    // Save as a new file
    const target = path.join(s.home, 'Documents', 'Annotated copy.pdf');
    await focusDoc(s);
    await s.page.keyboard.press('Control+Shift+s');
    // (the picker moves the focus to its name field a moment after opening: wait for it)
    await until(() => run(s, `!!document.querySelector('${DLG} .fp') && document.activeElement === document.querySelector('${DLG} .fp-bottom input')`), { label: 'save as picker' });
    await sleep(150);
    await s.page.fill(`${DLG} .fp-bottom input`, 'Annotated copy');
    await s.page.keyboard.press('Enter');
    await until(() => fs.existsSync(target), { label: 'saved copy exists' });
    await until(async () => !(await state(s)).dirty, { label: 'clean after save as' });
    check('save as: tab follows the new file', (await state(s)).path, target);
    check('save as: original untouched', fs.statSync(f.second).size < fs.statSync(target).size, true);
    check('save as: tab title', await run(s, `document.querySelector('${WIN} .pdf-tab.active .pdf-tab-title').textContent`), 'Annotated copy.pdf');
    // Don't save path
    await s.page.click(`${WIN} [data-cmd="highlight"]`);
    await until(async () => (await state(s)).mode === 9, { label: 'highlight mode (copy)' });
    await dragText(s, 1, 'test document', 0.9);
    await until(async () => (await state(s)).dirty, { label: 'dirty again' });
    await s.page.keyboard.press('Escape');
    await s.page.keyboard.press('Control+w');
    await dialogButton(s, "Don't save");
    await until(() => W(s, (w) => w.tabs.length === 1), { label: "Don't save closes the tab" });
    const annCopy = fs.readFileSync(target).toString('latin1');
    check("don't save: file unchanged (no highlight)", (annCopy.match(/\/Subtype\s*\/Highlight/g) || []).length, 0);
    check('save as: ink annotation written', /\/Subtype\s*\/Ink/.test(annCopy), true);
    check('save as: free text annotation written', /\/Subtype\s*\/FreeText/.test(annCopy) && annCopy.includes('Hello Aurora'), true);
  });

  await section('presentation', async () => {
    await W(s, (w) => w.active.goToPage(2));
    await until(async () => (await state(s)).page === 2, { label: 'page 2' });
    const zoom0 = (await state(s)).scaleValue;
    await focusDoc(s);
    await s.page.keyboard.press('F5');
    await until(() => W(s, (w) => !!w.presenting && w.win.fullscreen && w.active.viewer.scrollMode === 3), { label: 'presentation' });
    check('present: chrome hidden', await run(s, `getComputedStyle(document.querySelector('${WIN} .pdf-toolbar')).display`), 'none');
    check('present: page fit', (await state(s)).scaleValue, 'page-fit');
    await shotDoc(s, 'pdf-presentation');
    await s.page.keyboard.press('ArrowRight');
    await until(async () => (await state(s)).page === 3, { label: 'ArrowRight -> 3' });
    await s.page.keyboard.press('Space');
    await until(async () => (await state(s)).page === 4, { label: 'Space -> 4' });
    await s.page.mouse.click(800, 450);
    await until(async () => (await state(s)).page === 5, { label: 'click -> 5' });
    await s.page.keyboard.press('ArrowLeft');
    await until(async () => (await state(s)).page === 4, { label: 'ArrowLeft -> 4' });
    await s.page.keyboard.press('End');
    await until(async () => (await state(s)).page === 12, { label: 'End -> 12' });
    await s.page.keyboard.press('Escape');
    await until(() => W(s, (w) => !w.presenting && !w.win.fullscreen), { label: 'presentation ended' });
    await focusDoc(s);
    await s.page.keyboard.press('F11');
    await until(() => W(s, (w) => !!w.presenting), { label: 'F11 presents' });
    await s.page.keyboard.press('F11');
    await until(() => W(s, (w) => !w.presenting && !w.win.fullscreen), { label: 'F11 again ends it' });
    check('present: layout and zoom restored', await W(s, (w) => [w.active.viewer.scrollMode, w.active.scaleValue]), [0, zoom0]);
    check('present: stays on the last shown page', (await state(s)).page, 12);
    check('present: toolbar back', await run(s, `getComputedStyle(document.querySelector('${WIN} .pdf-toolbar')).display`), 'flex');
  });

  await section('password', async () => {
    await openFile(s, f.enc);
    await until(() => run(s, `!!document.querySelector('${DLG} .pdf-pw input[type=password]')`), { label: 'password dialog' });
    check('password: dialog text', await dialogText(s), (t) => t.includes('Locked.pdf is protected'));
    await shotDoc(s, 'pdf-password');
    await until(() => run(s, `document.activeElement?.type === 'password'`), { label: 'password field focused' });
    await s.page.keyboard.type('nope');
    await s.page.keyboard.press('Enter');
    await until(async () => (await dialogText(s)).includes('Incorrect password'), { label: 'wrong password message' });
    await until(() => run(s, `document.activeElement?.type === 'password' && !document.activeElement.value`), { label: 'password field focused again' });
    await s.page.keyboard.type('secret');
    await s.page.keyboard.press('Enter');
    await ready(s, 'encrypted document ready');
    check('password: pages', (await state(s)).pages, 3);
    check('password: text decrypted', await run(s, `document.querySelector('${WIN} .pdf-doc:not([hidden]) .textLayer').textContent`), (t) => t.includes('Introduction'));
    await W(s, (w) => {
      w.closeTab();
    });
    await until(() => W(s, (w) => !w.tabs.some((t) => t.doc?.name === 'Locked.pdf')), { label: 'locked tab closed' });
    // cancel -> "password protected" page with a retry button
    await openFile(s, f.enc);
    await until(() => run(s, `!!document.querySelector('${DLG} .pdf-pw')`), { label: 'password dialog again' });
    await dialogButton(s, 'Cancel');
    await until(async () => (await state(s))?.error === 'locked', { label: 'locked page' });
    check('password: locked page', await run(s, `document.querySelector('${WIN} .pdf-doc:not([hidden]) .pdf-error')?.innerText`), (t) => t.includes('This PDF is password protected') && t.includes('Enter password'));
    await s.page.click(`${WIN} .pdf-doc:not([hidden]) .pdf-error button >> text=Enter password`);
    await until(() => run(s, `!!document.querySelector('${DLG} .pdf-pw') && document.activeElement?.type === 'password'`), { label: 'password dialog from the page' });
    await s.page.keyboard.type('secret');
    await s.page.keyboard.press('Enter');
    await ready(s, 'unlocked');
    await W(s, (w) => {
      w.closeTab();
    });
    await sleep(300);
  });

  await section('error pages', async () => {
    await openFile(s, f.broken);
    await until(async () => (await state(s))?.state === 'error', { label: 'broken -> error', timeout: 10000 });
    check('error: corrupt kind', (await state(s)).error, 'corrupt');
    check('error: friendly text', await run(s, `document.querySelector('${WIN} .pdf-doc:not([hidden]) .pdf-error').innerText`), (t) => t.includes("Can't open this file") && t.includes('Broken.pdf is damaged'));
    check('error: actions', await run(s, `[...document.querySelectorAll('${WIN} .pdf-doc:not([hidden]) .pdf-error button')].map((b) => b.textContent)`), ['Try again', 'Open another file', 'Close tab']);
    check('error: tab icon', await run(s, `!!document.querySelector('${WIN} .pdf-tab.active .pdf-tab-icon .icon')`), true);
    check('error: toolbar disabled', await run(s, `document.querySelector('${WIN} [data-cmd="zoomIn"]').disabled`), true);
    await shotDoc(s, 'pdf-error');
    await s.page.click(`${WIN} .pdf-doc:not([hidden]) .pdf-error button >> text=Close tab`);
    await sleep(300);
    await openFile(s, f.notPdf);
    await until(async () => (await state(s))?.error === 'corrupt', { label: 'not a pdf' });
    check('error: not a PDF detail', await run(s, `document.querySelector('${WIN} .pdf-doc:not([hidden]) .pdf-error-detail')?.textContent`), (t) => t.includes("doesn't start like a PDF"));
    await W(s, (w) => {
      w.closeTab();
    });
    await openFile(s, f.truncated);
    await until(async () => ['error', 'ready'].includes((await state(s))?.state), { label: 'truncated settles', timeout: 10000 });
    check('error: truncated file handled', (await state(s)).state, (v) => v === 'error' || v === 'ready');
    await W(s, (w) => {
      w.closeTab();
    });
    await W(s, (w, el, p) => w.openPath(p), f.missing);
    await until(async () => (await state(s))?.error === 'missing', { label: 'missing file' });
    check('error: missing text', await run(s, `document.querySelector('${WIN} .pdf-doc:not([hidden]) .pdf-error').innerText`), (t) => t.includes('File not found'));
    await W(s, (w) => {
      w.closeTab();
    });
  });

  await section('attachments', async () => {
    await openFile(s, f.att);
    await ready(s);
    await until(() => run(s, `!document.querySelector('${WIN} .pdf-pivot[data-view="attachments"]').hidden`), { label: 'attachments pivot' });
    await s.page.click(`${WIN} .pdf-pivot[data-view="attachments"]`);
    await until(() => run(s, `document.querySelectorAll('${WIN} .pdf-att').length === 2`), { label: 'attachment rows' });
    check('att: names', await run(s, `[...document.querySelectorAll('${WIN} .pdf-att .ellipsis')].map((e) => e.textContent).sort()`), ['data.csv', 'notes.txt']);
    // Save as… writes the embedded file
    const row = `${WIN} .pdf-att:has(.ellipsis:text-is("notes.txt"))`;
    await s.page.click(`${row} .pdf-att-more`);
    await s.page.click('body > .menu .menu-item >> text=Save as…');
    await until(() => run(s, `!!document.querySelector('${DLG} .fp') && document.activeElement?.value === 'notes.txt'`), { label: 'attachment save picker' });
    await s.page.keyboard.press('Enter');
    const saved = path.join(s.home, 'Downloads', 'notes.txt');
    await until(() => fs.existsSync(saved), { label: 'attachment saved' });
    check('att: content', fs.readFileSync(saved, 'utf8'), 'Hello from the attachment');
    await s.page.click(`${WIN} .pdf-pivot[data-view="thumbs"]`);
    await W(s, (w) => {
      w.closeTab();
    });
    await sleep(300);
  });

  await section('tabs keep their state', async () => {
    await openFile(s, f.second);
    await ready(s);
    await openFile(s, f.guide);
    await ready(s);
    check('tabs: guide is not opened twice', await W(s, (w) => w.tabs.filter((t) => t.doc?.name === 'Aurora guide.pdf').length), 1);
    await W(s, (w) => {
      w.active.setZoom(1.5);
      w.active.goToPage(7);
    });
    await until(async () => (await state(s)).page === 7, { label: 'guide p7' });
    await s.page.keyboard.press('Control+Tab');
    await until(async () => (await state(s)).path !== f.guide, { label: 'switched tab' });
    await W(s, (w) => w.active.goToPage(2));
    await s.page.keyboard.press('Control+Shift+Tab');
    await until(async () => (await state(s)).path === f.guide, { label: 'back to guide' });
    const st = await state(s);
    check('tabs: page kept', st.page, 7);
    check('tabs: zoom kept', Math.round(st.scale * 100), 150);
    check('tabs: scroll position kept', await run(s, `document.querySelector('${WIN} .pdf-doc:not([hidden]) .pdf-scroller').scrollTop > 1000`), true);
    // relaunch with an open file activates it (no duplicate)
    await s.page.keyboard.press('Control+Tab');
    await openFile(s, f.guide);
    await until(async () => (await state(s)).path === f.guide, { label: 'relaunch activates guide' });
    check('tabs: still one window', await winCount(s), 1);
    // drag to reorder
    const n = await W(s, (w) => w.tabs.length);
    const order0 = await W(s, (w) => w.tabs.map((t) => t.doc?.name || 'start'));
    const a = await run(s, `(() => { const r = document.querySelectorAll('${WIN} .pdf-tab')[0].getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    const b = await run(s, `(() => { const r = document.querySelectorAll('${WIN} .pdf-tab')[${n - 1}].getBoundingClientRect(); return { x: r.right - 10, y: r.top + r.height / 2 }; })()`);
    await s.page.mouse.move(a.x, a.y);
    await s.page.mouse.down();
    await s.page.mouse.move(b.x, b.y, { steps: 12 });
    await s.page.mouse.up();
    await sleep(300);
    const order1 = await W(s, (w) => w.tabs.map((t) => t.doc?.name || 'start'));
    check('tabs: drag reorders', order1, [...order0.slice(1), order0[0]]);
    // tab context menu
    await s.page.click(`${WIN} .pdf-tab.active`, { button: 'right' });
    await until(() => run(s, `!!document.querySelector('body > .menu')`), { label: 'tab menu' });
    check('tabs: menu', await run(s, `[...document.querySelectorAll('body > .menu .menu-item .label')].map((e) => e.textContent)`), (l) => l.includes('Close other tabs') && l.includes('Open file location'));
    await s.page.keyboard.press('Escape');
  });

  await section('recent list', async () => {
    await s.page.keyboard.press('Control+t');
    await until(() => run(s, `document.querySelectorAll('${WIN} .pdf-start:not([hidden]) .pdf-recent-row').length >= 3`), { label: 'recent rows' });
    const rows = await run(s, `[...document.querySelectorAll('${WIN} .pdf-recent-row')].map((r) => ({ name: r.querySelector('.pdf-recent-name').textContent, meta: r.querySelector('.pdf-recent-meta').textContent, thumb: !!r.querySelector('.pdf-recent-thumb img'), path: r.dataset.path }))`);
    const g = rows.find((r) => r.path === f.guide);
    check('recent: guide listed', !!g, true);
    check('recent: last page shown', g?.meta, 'Page 7 of 12');
    check('recent: thumbnail', g?.thumb, true);
    check('recent: missing file not listed', rows.some((r) => r.path === f.missing), false);
    check('recent: persisted', (() => {
      try {
        return JSON.parse(fs.readFileSync(path.join(s.home, '.config/aurora/apps/pdf/recent.json'), 'utf8')).some((r) => r.path === f.guide && r.page === 7);
      } catch {
        return false;
      }
    })(), true);
    await shotDoc(s, 'pdf-recent');
    // remove one entry
    const sel = `${WIN} .pdf-recent-row[data-path="${f.att}"]`;
    await s.page.hover(sel);
    await s.page.click(`${sel} .pdf-recent-remove`);
    await until(() => run(s, `!document.querySelector('${sel}')`), { label: 'entry removed' });
    // reopening restores the last page
    await W(s, (w) => {
      w.closeTab(w.tabs.find((x) => x.doc?.name === 'Aurora guide.pdf'));
    });
    await sleep(300);
    await W(s, (w) => w.activate(w.tabs.find((t) => !t.doc)));
    await s.page.click(`${WIN} .pdf-recent-row[data-path="${f.guide}"]`);
    await ready(s);
    check('recent: reopened at the last page', (await state(s)).page, 7);
    check('recent: zoom remembered', Math.round((await state(s)).scale * 100), 150);
  });

  await section('open via picker and drag & drop', async () => {
    await s.page.keyboard.press('Control+o');
    await until(() => run(s, `!!document.querySelector('${DLG} .fp') && document.activeElement?.classList.contains('fp-path')`), { label: 'open picker' });
    await sleep(150);
    await s.page.fill(`${DLG} .fp-path`, path.dirname(f.other));
    await s.page.press(`${DLG} .fp-path`, 'Enter');
    await until(() => run(s, `[...document.querySelectorAll('${DLG} .fp-row')].some((r) => r.textContent.includes('Picked.pdf'))`), { label: 'picker lists the file' });
    await s.page.dblclick(`${DLG} .fp-row:has-text("Picked.pdf")`);
    await until(async () => (await state(s))?.path === f.other, { label: 'picked file opened' });
    await ready(s);
    // drop a file from the Files app
    await W(s, (w) => {
      w.closeTab();
    });
    const dropPaths = (shellStart) =>
      s.page.evaluate(
        ({ sel, p, shellStart }) => {
          // A shell drag fires 'dragstart' in the shell document first; a drag from web content does not.
          window.dispatchEvent(new PointerEvent('pointerdown'));
          if (shellStart) document.dispatchEvent(new DragEvent('dragstart', { bubbles: true }));
          const el = document.querySelector(sel);
          const dt = new DataTransfer();
          dt.setData('application/x-aurora-paths', JSON.stringify([p]));
          for (const type of ['dragenter', 'dragover', 'drop']) el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
          if (shellStart) document.dispatchEvent(new DragEvent('dragend', { bubbles: true }));
        },
        { sel: `${WIN} .pdf-root`, p: f.other, shellStart },
      );
    await dropPaths(false);
    await sleep(600);
    check('drop: forged paths from web content ignored', (await state(s))?.path === f.other, false);
    await dropPaths(true);
    await until(async () => (await state(s))?.path === f.other, { label: 'dropped file opened' });
    await ready(s);
    check('drop: overlay hidden', await run(s, `document.querySelector('${WIN} .pdf-drop').hidden`), true);
  });

  await section('scripts never run', async () => {
    await openFile(s, f.script);
    await ready(s);
    await sleep(800);
    check('script: no dialog', await dialogOpen(s), false);
    const st = await state(s);
    check('script: zoom untouched', st.scaleValue, (v) => v !== 400 && v !== '400');
    check('script: stays on page 1', st.page, 1);
    await W(s, (w) => {
      w.closeTab();
    });
    await sleep(300);
  });

  await section('more menu commands', async () => {
    await openFile(s, f.second);
    await ready(s);
    await s.aurora(() => {
      window.__pdfLaunches = [];
      window.__pdfTestLaunch = window.__aurora.shell.launch;
      window.__aurora.shell.launch = (id, args) => window.__pdfLaunches.push([id, args]);
    });
    await s.page.click(`${WIN} [data-cmd="more"]`);
    await until(() => run(s, `!!document.querySelector('body > .menu')`), { label: 'more menu' });
    check('more: entries', await run(s, `[...document.querySelectorAll('body > .menu .menu-item .label')].map((e) => e.textContent)`), (l) => ['Open…', 'New tab', 'Copy', 'Select all', 'Go to page', 'Open file location', 'Open with', 'Document properties', 'Close tab'].every((x) => l.includes(x)) && !l.includes('Print'));
    await s.page.click('body > .menu .menu-item >> text=Open file location');
    check('more: open file location', await s.aurora(() => window.__pdfLaunches), [['files', { select: f.second }]]);
    await s.page.click(`${WIN} [data-cmd="more"]`);
    await s.page.hover('body > .menu .menu-item >> text=Open with');
    await until(() => run(s, `document.querySelectorAll('body > .menu').length === 2`), { label: 'open with submenu' });
    await s.page.click('body > .menu .menu-item >> text=Choose another app…');
    await until(() => run(s, `!!document.querySelector('${DLG} .pdf-apps')`), { label: 'app chooser' });
    check('more: chooser lists apps', await run(s, `document.querySelectorAll('${DLG} .pdf-app-row').length`), (n) => n >= 3);
    await s.page.click(`${DLG} .pdf-app-row[data-id="notepad"]`);
    await dialogButton(s, 'Open');
    check('more: open with', await s.aurora(() => window.__pdfLaunches.at(-1)), ['notepad', { file: f.second }]);
    await s.aurora(() => {
      window.__aurora.shell.launch = window.__pdfTestLaunch;
    });
  });

  await section('annotation tools stay inside the PDF window', async () => {
    // Ink mode on, then another app gets the focus: its keys and clipboard must not reach pdf.js.
    await W(s, (w) => w.active.goToPage(1));
    await until(async () => (await state(s)).page === 1, { label: 'page 1' });
    await s.page.click(`${WIN} [data-cmd="ink"]`);
    await until(async () => (await state(s)).mode === 15, { label: 'ink mode' });
    const r = await visibleRect(s, 1);
    await s.page.mouse.move(r.x + r.w * 0.4, r.y + r.h * 0.5);
    await s.page.mouse.down();
    for (let i = 1; i <= 8; i++) await s.page.mouse.move(r.x + r.w * (0.4 + i * 0.02), r.y + r.h * 0.5 + i * 3);
    await s.page.mouse.up();
    // The drawing is committed when the tool is left (Esc), then the tool goes back on.
    await s.page.keyboard.press('Escape');
    await until(() => run(s, `document.querySelectorAll('${WIN} .pdf-doc:not([hidden]) .inkEditor').length >= 1`), { label: 'ink stroke' });
    check('isolation: committed drawing makes the document dirty', (await state(s)).dirty, true);
    await s.page.click(`${WIN} [data-cmd="ink"]`);
    await until(async () => (await state(s)).mode === 15, { label: 'ink mode again' });
    const inks = await run(s, `document.querySelectorAll('${WIN} .pdf-doc:not([hidden]) .inkEditor').length`);
    await s.aurora(() => window.__aurora.registry.launch('notepad', { newWindow: true }));
    await until(() => run(s, `!!document.querySelector('.win.app-notepad textarea') && document.activeElement?.tagName === 'TEXTAREA'`), { label: 'notepad focused', timeout: 10000 });
    await s.page.keyboard.type('hello world');
    await s.page.keyboard.press('Control+a');
    await s.page.keyboard.press('Control+c');
    await until(async () => (await s.page.evaluate(() => window.aurora.invoke('clipboard:readText'))) === 'hello world', { label: 'copy in another app works' });
    await s.page.keyboard.press('Backspace');
    check('isolation: Backspace edits the other app', await run(s, `document.querySelector('.win.app-notepad textarea').value`), '');
    await s.page.keyboard.press('Control+z');
    await sleep(200);
    check('isolation: Ctrl+Z goes to the other app', await run(s, `document.querySelector('.win.app-notepad textarea').value`), 'hello world');
    check('isolation: PDF drawing untouched', await run(s, `document.querySelectorAll('${WIN} .pdf-doc:not([hidden]) .inkEditor').length`), inks);
    // an image dropped on the desktop must not become a stamp in the PDF
    const storage0 = await W(s, (w) => w.active.pdf.annotationStorage.size);
    await s.page.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], 'x.png', { type: 'image/png' }));
      for (const type of ['dragover', 'drop']) document.querySelector('#desktop').dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
    });
    await sleep(400);
    check('isolation: drop elsewhere ignored', await W(s, (w) => w.active.pdf.annotationStorage.size), storage0);
    await s.aurora(() => {
      const w = window.__aurora.wm.byApp('notepad')[0];
      w?.close(true);
    });
    await W(s, (w) => w.win.focus());
    await until(async () => (await state(s)).mode === 15, { label: 'tool back when the window is focused again' });
    // a drawing still in progress is not lost on close: it is committed, so the save prompt appears
    await W(s, (w) => {
      w.active.pdf.annotationStorage.resetModified();
    });
    const r2 = await visibleRect(s, 1);
    await s.page.mouse.move(r2.x + r2.w * 0.3, r2.y + r2.h * 0.3);
    await s.page.mouse.down();
    for (let i = 1; i <= 8; i++) await s.page.mouse.move(r2.x + r2.w * (0.3 + i * 0.03), r2.y + r2.h * 0.3 + i * 2);
    await s.page.mouse.up();
    await s.page.keyboard.press('Control+w');
    await until(() => dialogOpen(s), { label: 'prompt for an uncommitted drawing' });
    await dialogButton(s, "Don't save");
    await until(async () => !(await W(s, (w) => w.tabs.some((t) => t.doc?.name === 'Second document.pdf'))), { label: 'closed' });
  });

  await section('language switch', async () => {
    await openFile(s, f.second);
    await ready(s);
    await s.aurora(() => window.__aurora.settings.set('lang', 'fr'));
    await until(() => run(s, `document.querySelector('${WIN} [data-cmd="find"]').dataset.tip === 'Rechercher (Ctrl+F)'`), { label: 'live switch to French' });
    check('lang: sidebar title', await run(s, `document.querySelector('${WIN} .pdf-side-title').textContent`), 'Pages');
    check('lang: tab tooltip of new tab button', await run(s, `document.querySelector('${WIN} .pdf-newtab').dataset.tip`), 'Nouvel onglet (Ctrl+T)');
    await s.aurora(() => window.__aurora.settings.set('lang', 'en'));
    await until(() => run(s, `document.querySelector('${WIN} [data-cmd="find"]').dataset.tip === 'Find (Ctrl+F)'`), { label: 'back to English' });
  });

  await section('per-app theme and visual styles', async () => {
    await s.aurora(() => window.__aurora.settings.set('appThemes', { pdf: { theme: 'dark', accent: null } }));
    await until(() => run(s, `document.querySelector('${WIN}').dataset.theme === 'dark'`), { label: 'window dark', timeout: 4000 });
    check('theme: dark tokens inside the window', await run(s, `getComputedStyle(document.querySelector('${WIN} .pdf-root')).getPropertyValue('--text').trim().toLowerCase()`), (v) => {
      // dark mode text is a light tone of the ambiance (#e6eaf2 in Nocturne), not the light-mode ink
      const m = /^#([0-9a-f]{6})$/.exec(v);
      if (!m) return v === 'white';
      const n = parseInt(m[1], 16);
      return ((n >> 16) + ((n >> 8) & 255) + (n & 255)) / 3 > 200;
    });
    check('theme: shell stays light', await run(s, `document.documentElement.dataset.theme`), 'light');
    await shotDoc(s, 'pdf-app-theme-dark');
    await s.aurora(() => window.__aurora.settings.set('appThemes', {}));
    for (const style of ['glass', 'contrast']) {
      await s.aurora((st) => window.__aurora.settings.set('style', st), style);
      await sleep(600);
      check(`style ${style}: toolbar still fits`, await run(s, `(() => { const tb = document.querySelector('${WIN} .pdf-toolbar'); return tb.scrollWidth <= tb.clientWidth + 1; })()`), true);
      await shotDoc(s, `pdf-style-${style}`);
    }
    await s.aurora(() => window.__aurora.settings.set('style', 'win11'));
    await sleep(400);
  });

  await section('minimum and maximized sizes', async () => {
    await W(s, (w) => {
      w.win.restore?.();
      w.win.setSize(500, 380);
    });
    await sleep(600);
    const m = await run(s, `(() => { const tb = document.querySelector('${WIN} .pdf-toolbar'); const r = document.querySelector('${WIN}').getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), fits: tb.scrollWidth <= tb.clientWidth + 1, overflowed: tb.querySelectorAll('.pdf-overflowed:not(.pdf-tb-sep)').length, more: !document.querySelector('${WIN} [data-cmd="more"]').classList.contains('pdf-overflowed'), page: !document.querySelector('${WIN} .pdf-tb-page').classList.contains('pdf-overflowed') }; })()`);
    check('min: window size', [m.w, m.h], [500, 380]);
    check('min: toolbar fits', m.fits, true);
    check('min: commands moved to overflow', m.overflowed, (n) => n >= 3);
    check('min: page box kept', m.page, true);
    check('min: more button kept', m.more, true);
    await s.page.click(`${WIN} [data-cmd="more"]`);
    await until(() => run(s, `!!document.querySelector('body > .menu')`), { label: 'more menu' });
    check('min: overflow items in the menu', await run(s, `[...document.querySelectorAll('body > .menu .menu-item .label')].map((e) => e.textContent)`), (l) => l.includes('Present') && l.includes('Document properties') && l.includes('Open with'));
    await s.page.keyboard.press('Escape');
    check('min: sidebar closed in a narrow window', await run(s, `document.querySelector('${WIN} .pdf-sidebar').hidden`), true);
    await focusDoc(s);
    await s.page.keyboard.press('F4');
    await until(() => run(s, `!document.querySelector('${WIN} .pdf-sidebar').hidden`), { label: 'F4 opens the floating sidebar' });
    check('min: sidebar floats over the page', await run(s, `getComputedStyle(document.querySelector('${WIN} .pdf-sidebar')).position`), 'absolute');
    await shotDoc(s, 'pdf-min-size-sidebar');
    await s.page.click(`${WIN} .pdf-thumb[data-page="2"]`);
    await until(() => run(s, `document.querySelector('${WIN} .pdf-sidebar').hidden`), { label: 'picking a page closes it' });
    check('min: page picked', (await state(s)).page, 2);
    await shotDoc(s, 'pdf-min-size');
    await W(s, (w) => w.win.maximize());
    await sleep(700);
    const mx = await run(s, `(() => { const tb = document.querySelector('${WIN} .pdf-toolbar'); return { overflowed: tb.querySelectorAll('.pdf-overflowed:not(.pdf-tb-sep)').length }; })()`);
    check('max: every command visible', mx.overflowed, 0);
    await shotDoc(s, 'pdf-maximized');
    await W(s, (w) => w.win.restore());
    await sleep(300);
  });

  // ================================================================ QA regressions (adversarial pass)
  const layers = () => run(s, `document.querySelectorAll('${WIN} > .dialog-layer:not(.closing)').length`);
  const errorLogs = (from) => s.logs.slice(from).filter((l) => /^\[(error|pageerror)\]/.test(l) && !/Failed to load resource/.test(l));

  await section('qa: close prompts are never stacked', async () => {
    // (a regular window size: the earlier size checks leave it at its minimum)
    await W(s, (w) => {
      if (w) w.win.setSize(1100, 760);
    });
    await sleep(400);
    // (two documents: closing the last tab would close the window)
    await openFile(s, f.guide);
    await ready(s);
    await openFile(s, f.second);
    await ready(s);
    const n0 = await W(s, (w) => w.tabs.length);
    await W(s, (w) => w.active.setDirty(true));
    await W(s, (w) => {
      w.closeTab();
      w.closeTab();
    });
    await until(() => dialogOpen(s), { label: 'prompt' });
    await sleep(300);
    check('qa: closing a tab twice asks once', await layers(), 1);
    await W(s, (w) => {
      w.win.close();
    });
    await sleep(400);
    check('qa: closing the window during the question asks nothing more', await layers(), 1);
    check('qa: window kept', await winCount(s), 1);
    await dialogButton(s, 'Cancel');
    await until(async () => (await layers()) === 0, { label: 'prompt closed' });
    check('qa: cancel keeps the tab', await W(s, (w) => w.tabs.length), n0);
    await W(s, (w) => {
      w.win.close();
      w.win.close();
    });
    await until(() => dialogOpen(s), { label: 'window prompt' });
    await sleep(300);
    check('qa: closing the window twice asks once', await layers(), 1);
    await dialogButton(s, 'Cancel');
    await until(async () => (await layers()) === 0, { label: 'window prompt closed' });
    // double click on the tab's close button
    const x = await run(s, `(() => { const r = document.querySelector('${WIN} .pdf-tab.active .pdf-tab-close').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    await s.page.mouse.move(x.x, x.y);
    await sleep(150);
    await s.page.mouse.click(x.x, x.y);
    await s.page.mouse.click(x.x, x.y).catch(() => {});
    await until(() => dialogOpen(s), { label: 'tab close prompt' });
    await sleep(300);
    check('qa: double click on the close button asks once', await layers(), 1);
    await dialogButton(s, "Don't save");
    await until(() => W(s, (w, el, n) => w.tabs.length === n - 1, n0), { label: "Don't save closes the tab" });
    check('qa: no prompt left', await layers(), 0);
  });

  await section('qa: middle-click on links asks first', async () => {
    await openFile(s, f.guide);
    await ready(s);
    await W(s, (w) => w.active.goToPage(1));
    await until(async () => (await state(s)).page === 1, { label: 'page 1' });
    await sleep(300);
    await s.aurora(() => {
      window.__qaUrls = [];
      window.__qaOpenUrl = window.__aurora.shell.openUrl;
      window.__aurora.shell.openUrl = (u) => window.__qaUrls.push(u);
    });
    try {
      const ext = `${WIN} .pdf-doc:not([hidden]) .page[data-page-number="1"] .annotationLayer a[href^="https"]`;
      await s.page.click(ext, { button: 'middle' });
      await until(() => dialogOpen(s), { label: 'confirmation after a middle-click' });
      check('qa: middle-click does not open the page directly', await s.aurora(() => window.__qaUrls.length), 0);
      check('qa: the confirmation shows the address', await dialogText(s), (t) => t.includes('https://example.com/aurora'));
      await dialogButton(s, 'Cancel');
      check('qa: Cancel opens nothing', await s.aurora(() => window.__qaUrls.length), 0);
      const wins0 = await s.aurora(() => window.__aurora.wm.list().length);
      await s.page.click(`${WIN} .pdf-doc:not([hidden]) .page[data-page-number="1"] .annotationLayer a[href^="#"]`, { button: 'middle' });
      await sleep(500);
      check('qa: middle-click on an internal link opens nothing', [await s.aurora(() => window.__aurora.wm.list().length), await dialogOpen(s), await s.aurora(() => window.__qaUrls.length)], [wins0, false, 0]);
      check('qa: the shell page did not navigate', await run(s, 'location.href'), (u) => u.startsWith('app://shell/'));
    } finally {
      await s.aurora(() => {
        window.__aurora.shell.openUrl = window.__qaOpenUrl;
      });
    }
  });

  await section('qa: keyboard focus stays in the window (Tab, Shift+Tab, F6)', async () => {
    await W(s, (w) => w.toggleSidebar(true));
    await sleep(300);
    await focusDoc(s);
    const inWin = () => run(s, `!!document.activeElement?.closest('${WIN}')`);
    let out = 0;
    for (let i = 0; i < 45; i++) {
      await s.page.keyboard.press('Tab');
      if (!(await inWin())) out++;
    }
    check('qa: Tab never leaves the window', out, 0);
    out = 0;
    for (let i = 0; i < 45; i++) {
      await s.page.keyboard.press('Shift+Tab');
      if (!(await inWin())) out++;
    }
    check('qa: Shift+Tab never leaves the window', out, 0);
    check('qa: the active tab is a Tab stop', await run(s, `[...document.querySelectorAll('${WIN} .pdf-tab')].map((t) => t.tabIndex).filter((i) => i === 0).length`), 1);
    const where = () =>
      run(s, `(() => { const a = document.activeElement; return a.closest('.pdf-tabs') ? 'tabs' : a.closest('.pdf-toolbar') ? 'toolbar' : a.closest('.pdf-sidebar') ? 'sidebar' : a.closest('.pdf-scroller') ? 'document' : 'other'; })()`);
    await focusDoc(s);
    const seq = [];
    for (let i = 0; i < 4; i++) {
      await s.page.keyboard.press('F6');
      seq.push(await where());
    }
    check('qa: F6 cycles tabs, command bar, sidebar, document', seq, ['tabs', 'toolbar', 'sidebar', 'document']);
    await s.page.keyboard.press('Shift+F6');
    check('qa: Shift+F6 goes back', await where(), 'sidebar');
    await focusDoc(s);
  });

  await section('qa: the floating sidebar of a narrow window closes on tab switch', async () => {
    await openFile(s, f.second);
    await ready(s);
    await W(s, (w) => w.win.setSize(600, 500));
    await until(() => run(s, `document.querySelector('${WIN} .pdf-root').classList.contains('narrow')`), { label: 'narrow layout' });
    await focusDoc(s);
    await s.page.keyboard.press('F4');
    await until(() => run(s, `!document.querySelector('${WIN} .pdf-sidebar').hidden`), { label: 'floating sidebar open' });
    await s.page.keyboard.press('Control+Tab');
    await until(() => W(s, (w) => w.active?.name !== 'Second document.pdf'), { label: 'other tab' });
    check('qa: floating sidebar closed after a tab switch', await run(s, `document.querySelector('${WIN} .pdf-sidebar').hidden`), true);
    await W(s, (w) => {
      w.win.setSize(1100, 760);
      w.activate(w.tabs.find((t) => t.doc?.ready));
      w.toggleSidebar(true);
    });
    await sleep(400);
    check('qa: docked sidebar back in a wide window', await run(s, `!document.querySelector('${WIN} .pdf-sidebar').hidden && getComputedStyle(document.querySelector('${WIN} .pdf-sidebar')).position !== 'absolute'`), true);
  });

  await section('qa: crash-safe save', async () => {
    const docs = path.join(s.home, 'Documents');
    const real = path.join(docs, 'Real target.pdf');
    const link = path.join(docs, 'Shortcut.pdf');
    fs.writeFileSync(real, makePdf({ pages: 2, outline: false, links: false, image: false, title: 'Real target' }));
    fs.symlinkSync(real, link);
    await openFile(s, link);
    await ready(s);
    await W(s, (w) => w.active.goToPage(1));
    await sleep(300);
    await s.page.click(`${WIN} [data-cmd="highlight"]`);
    await until(async () => (await state(s)).mode === 9, { label: 'highlight mode' });
    const box = await dragText(s, 1, 'test document', 0.9);
    await until(async () => (await state(s)).dirty, { label: 'dirty' }).catch(async (err) => {
      const info = await run(s, `(() => { const e = document.elementFromPoint(${box.x + 4}, ${box.y}); return { at: e?.className + ' / ' + e?.parentElement?.className, sel: String(document.getSelection()), path: document.querySelector('${WIN}').__pdf.active.path, layout: document.querySelector('${WIN}').__pdf.active.layout }; })()`);
      throw new Error(`${err.message} ${JSON.stringify({ box, info, st: await state(s) })}`);
    });
    await s.page.keyboard.press('Escape');
    await until(async () => (await state(s)).mode === 0, { label: 'tool off' });
    const before = fs.statSync(real).size;
    await focusDoc(s);
    await s.page.keyboard.press('Control+s');
    check('qa: still unsaved while the file is being written', await W(s, (w) => !w.active.saving || w.active.dirty), true);
    await until(() => W(s, (w) => !w.active.saving && !w.active.dirty), { label: 'saved', timeout: 15000 });
    check('qa: a symbolic link stays a link', fs.lstatSync(link).isSymbolicLink(), true);
    check('qa: the file it points to got the highlight', fs.statSync(real).size > before && /\/Subtype\s*\/Highlight/.test(fs.readFileSync(real, 'latin1')), true);
    check('qa: no temporary file left behind', fs.readdirSync(docs).filter((n) => n.endsWith('.tmp')), []);
    // A failing save (disk full) keeps the file and the changes, and says why in the user's language.
    const bytes0 = fs.readFileSync(real);
    await W(s, (w) => {
      const api = w.ctx.api;
      window.__qaInvoke = api.invoke;
      api.invoke = (ch, ...a) => (ch === 'pdf:save' ? Promise.reject(Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })) : window.__qaInvoke(ch, ...a));
      w.active.setDirty(true);
    });
    try {
      await focusDoc(s);
      await s.page.keyboard.press('Control+s');
      await until(() => dialogOpen(s), { label: 'save error' });
      const txt = await dialogText(s);
      check('qa: save error explained', txt, (t) => t.includes("Couldn't save") && t.includes("There isn't enough space on the disk.") && !t.includes('ENOSPC'));
      await dialogButton(s, 'OK');
      check('qa: changes kept after a failed save', (await state(s)).dirty, true);
      check('qa: file untouched by a failed save', Buffer.compare(fs.readFileSync(real), bytes0), 0);
    } finally {
      await W(s, (w) => {
        w.ctx.api.invoke = window.__qaInvoke;
      });
    }
    await W(s, (w) => w.active.setDirty(false));
    await W(s, (w) => {
      w.closeTab();
    });
    await sleep(300);
  });

  await section('qa: documents opened in background tabs', async () => {
    await openFile(s, f.guide);
    await ready(s);
    await W(s, (w) => w.active.goToPage(7));
    await until(async () => (await state(s)).page === 7, { label: 'page 7' });
    await sleep(900); // remembered after 600 ms
    await W(s, (w) => {
      if (w.tabs.length < 2) w.newTab({ activate: false }); // closing the last tab would close the window
      w.closeTab();
    });
    await until(() => W(s, (w) => !w.tabs.some((t) => t.doc?.name === 'Aurora guide.pdf')), { label: 'guide closed' });
    const from = s.logs.length;
    // The guide starts loading, then another file takes the front: the guide finishes loading hidden.
    await W(
      s,
      (w, el, p) => {
        w.openPath(p.guide, { newTab: true });
        w.openPath(p.other, { newTab: true });
      },
      { guide: f.guide, other: f.other },
    );
    await until(() => W(s, (w) => ['Aurora guide.pdf', 'Picked.pdf'].every((n) => w.tabs.find((t) => t.doc?.name === n)?.doc.ready)), { label: 'both loaded', timeout: 15000 });
    await sleep(700);
    check('qa: the hidden document waits to be shown', await W(s, (w) => !!w.tabs.find((t) => t.doc?.name === 'Aurora guide.pdf').doc.deferredInit), true);
    const recentPage = () => run(s, `(async () => (await import('app://shell/apps/pdf/lib/shared.js')).shared.recentGet(${JSON.stringify(f.guide)})?.page)()`);
    check('qa: its remembered page is kept meanwhile', await recentPage(), 7);
    await W(s, (w) => w.activate(w.tabs.find((t) => t.doc?.name === 'Aurora guide.pdf')));
    await until(async () => (await state(s)).page === 7, { label: 'shown at the remembered page' });
    check('qa: shown with a real zoom', (await state(s)).scale, (z) => z > 0.4);
    await ready(s, 'text of the shown background tab');
    check('qa: no console errors from background loading', errorLogs(from), []);
  });

  await section('qa: tampered Recent list', async () => {
    await sleep(1500); // let the previous documents' Recent updates (debounced save, thumbnails) land first
    const from = s.logs.length;
    const saved = await run(s, `(async () => (await import('app://shell/apps/pdf/lib/shared.js')).shared.recent.slice())()`);
    await run(
      s,
      `(async () => {
        await window.aurora.invoke('storage:set', 'pdf', 'recent', [
          { path: '/tmp/bad-date.pdf', name: 'Bad date', date: 'garbage', page: 'x', pages: { a: 1 } },
          { path: '/tmp/huge-date.pdf', name: 'Huge', date: 1e20, page: -5, pages: 3 },
          { path: '/tmp/thumb.pdf', name: 'Tracker', thumb: 'https://tracker.invalid/pixel.png', date: Date.now() },
          { path: '/tmp/<img src=x onerror=alert(1)>.pdf', name: '<img src=x onerror=alert(1)>', date: Date.now() },
          { path: 'relative.pdf' }, null, 5, { path: '/tmp/noname.pdf', name: 42 },
        ]);
        const { shared } = await import('app://shell/apps/pdf/lib/shared.js');
        shared.ready = null;
        await shared.init({ api: window.aurora, storage: { get: (n, fb) => window.aurora.invoke('storage:get', 'pdf', n, fb) } });
      })()`,
    );
    await W(s, (w) => {
      w.newTab();
    });
    const expected = ['Bad date', 'Huge', 'Tracker', '<img src=x onerror=alert(1)>', 'noname.pdf'];
    const names = () => run(s, `[...document.querySelectorAll('${WIN} .pdf-start:not([hidden]) .pdf-recent-name')].map((e) => e.textContent)`);
    await until(
      async () => {
        const shown = await names();
        return expected.every((n) => shown.includes(n));
      },
      { label: 'start page with the sanitized list' },
    );
    check('qa: rows of a tampered list (bad entries dropped, the rest kept in order)', (await names()).filter((n) => expected.includes(n)), expected);
    check('qa: no row for the relative path or junk values', (await names()).filter((n) => /relative|^5$|^null$/.test(n)), []);
    check('qa: no remote thumbnail', await run(s, `[...document.querySelectorAll('${WIN} .pdf-recent-row img')].filter((i) => !i.src.startsWith('data:')).length`), 0);
    check('qa: no markup injected', await run(s, `document.querySelectorAll('img[src="x"]').length`), 0);
    check('qa: no errors from a tampered list', errorLogs(from), []);
    await run(s, `(async () => { const { shared } = await import('app://shell/apps/pdf/lib/shared.js'); shared.recent = ${JSON.stringify(saved)}; shared.saveRecent(); })()`);
    await W(s, (w) => {
      w.closeTab();
    });
    await sleep(300);
  });

  await section('qa: open with lists apps that open files', async () => {
    await openFile(s, f.guide);
    await ready(s);
    await W(s, (w) => {
      w.openWith();
    });
    await until(() => run(s, `!!document.querySelector('${DLG} .pdf-apps .pdf-app-row')`), { label: 'open with dialog' });
    const ids = await run(s, `[...document.querySelectorAll('${DLG} .pdf-app-row')].map((r) => r.dataset.id)`);
    check('qa: file apps offered', ids, (l) => l.includes('notepad') && l.includes('photos'));
    check('qa: games and system tools not offered', ids.filter((id) => ['minesweeper', 'chess', 'solitaire', 'snake', 'game2048', 'winver', 'settings', 'calculator', 'taskmgr', 'pdf'].includes(id)), []);
    await dialogButton(s, 'Cancel');
  });

  await section('qa: attachment names from the PDF are sanitized', async () => {
    const p = path.join(s.home, 'Documents', 'Tricky attachments.pdf');
    fs.writeFileSync(p, makePdf({ pages: 2, outline: false, links: false, image: false, attachments: [{ name: '../../evil.txt', content: 'evil' }, { name: '..', content: 'dots' }] }));
    await openFile(s, p);
    await ready(s);
    await until(() => run(s, `!document.querySelector('${WIN} .pdf-pivot[data-view="attachments"]').hidden`), { label: 'attachments pivot' });
    await s.page.click(`${WIN} .pdf-pivot[data-view="attachments"]`);
    await until(() => run(s, `document.querySelectorAll('${WIN} .pdf-att').length === 2`), { label: 'attachment rows' });
    check('qa: names without folders or dots', await run(s, `[...document.querySelectorAll('${WIN} .pdf-att .ellipsis')].map((e) => e.textContent).sort()`), ['attachment', 'evil.txt']);
    await s.aurora(() => {
      window.__qaOpened = [];
      window.__qaOpenFile = window.__aurora.shell.openFile;
      window.__aurora.shell.openFile = async (p) => window.__qaOpened.push(p);
    });
    try {
      for (const name of ['evil.txt', 'attachment']) {
        await s.page.dblclick(`${WIN} .pdf-att:has(.ellipsis:text-is("${name}"))`);
        await until(() => s.aurora((n) => window.__qaOpened.some((x) => x.endsWith('/' + n)), name), { label: `opened ${name}` });
      }
      const opened = await s.aurora(() => window.__qaOpened);
      const cache = path.join(s.home, '.cache', 'aurora', 'pdf-attachments');
      check('qa: attachments written inside the cache folder', opened.every((x) => path.resolve(x).startsWith(cache + path.sep) && fs.statSync(x).isFile()), true);
      check('qa: content of the ".." attachment', fs.readFileSync(opened.find((x) => x.endsWith('/attachment')), 'utf8'), 'dots');
      check('qa: nothing written outside', fs.existsSync(path.join(s.home, '.cache', 'evil.txt')) || fs.existsSync(path.join(s.home, '.cache', 'aurora', 'evil.txt')), false);
    } finally {
      await s.aurora(() => {
        window.__aurora.shell.openFile = window.__qaOpenFile;
      });
    }
    await s.page.click(`${WIN} .pdf-pivot[data-view="thumbs"]`);
    await W(s, (w) => {
      w.closeTab();
    });
    await sleep(300);
  });

  await section('qa: other apps keep their document-level drag & drop', async () => {
    await focusDoc(s);
    const got = await run(
      s,
      `(() => { let n = 0; const fn = () => n++; document.addEventListener('dragover', fn); document.addEventListener('drop', fn);
        const dt = new DataTransfer(); dt.setData('text/plain', 'hello');
        for (const type of ['dragover', 'drop']) document.body.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
        document.removeEventListener('dragover', fn); document.removeEventListener('drop', fn); return n; })()`,
    );
    check('qa: a listener added after the PDF engine still gets dragover and drop', got, 2);
  });

  await section('qa: Ctrl+O twice opens one picker', async () => {
    await focusDoc(s);
    await s.page.keyboard.press('Control+o');
    await s.page.keyboard.press('Control+o');
    await until(() => run(s, `!!document.querySelector('${DLG} .fp')`), { label: 'picker' });
    await sleep(500);
    check('qa: one picker', await run(s, `document.querySelectorAll('${WIN} > .dialog-layer:not(.closing) .fp').length`), 1);
    await s.page.keyboard.press('Escape');
    await until(async () => (await layers()) === 0, { label: 'picker closed' });
  });

  await section('qa: 15 open/close cycles release everything', async () => {
    await W(s, (w) => {
      for (const d of w.docs()) d.setDirty(false);
      w.win.close(true);
    });
    await until(async () => (await winCount(s)) === 0, { label: 'window closed' });
    const cdp = await s.page.context().newCDPSession(s.page);
    await cdp.send('Performance.enable');
    const measure = async () => {
      await cdp.send('HeapProfiler.collectGarbage');
      await sleep(250);
      await cdp.send('HeapProfiler.collectGarbage');
      const m = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((x) => [x.name, x.value]));
      return { nodes: m.Nodes, listeners: m.JSEventListeners };
    };
    const cycle = async () => {
      await s.aurora((p) => window.__aurora.registry.launch('pdf', { file: p }), f.second);
      await ready(s);
      await s.aurora(() => window.__aurora.wm.byApp('pdf').forEach((w) => w.close(true)));
      await until(async () => (await winCount(s)) === 0, { label: 'cycle closed' });
      await sleep(150);
    };
    await cycle();
    await sleep(3600);
    const m0 = await measure();
    for (let i = 0; i < 15; i++) await cycle();
    await sleep(3600);
    const m1 = await measure();
    const eng = await run(s, `(async () => { const e = await import('app://shell/apps/pdf/lib/engine.js'); const { shared } = await import('app://shell/apps/pdf/lib/shared.js'); return { ...e.workerInfo(), windows: shared.windows.size }; })()`);
    check('qa: pdf.js worker destroyed after the last window', eng, { refs: 0, alive: false, pendingDestroy: false, windows: 0 });
    check(`qa: DOM nodes released (+${m1.nodes - m0.nodes} after 15 cycles)`, m1.nodes - m0.nodes, (d) => d < 600);
    check(`qa: event listeners released (+${m1.listeners - m0.listeners} after 15 cycles)`, m1.listeners - m0.listeners, (d) => d < 200);
    await cdp.detach().catch(() => {});
    await openFile(s, f.guide);
    await ready(s);
  });

  await section('console errors', async () => {
    const errs = s.logs.filter((l) => /^\[(error|pageerror)\]/.test(l) && !/Failed to load resource/.test(l));
    check('no console errors', errs, []);
    check('no failed pdf requests', bad404, []);
  });

  // Unsaved changes + window close: Don't save closes the window.
  await section('window close', async () => {
    await W(s, (w) => w.active && w.active.setDirty(true));
    await W(s, (w) => {
      w.win.close();
    });
    await until(() => dialogOpen(s), { label: 'close prompt' });
    check('close: prompt names the document', await dialogText(s), (t) => t.includes('Do you want to save the changes to'));
    for (let i = 0; i < 8 && (await winCount(s)) > 0; i++) {
      if (await dialogOpen(s)) await dialogButton(s, "Don't save");
      else await sleep(200);
    }
    await until(async () => (await winCount(s)) === 0, { label: 'window closed' });
  });
  await s.close();
}

// ================================================================== run 2: French, dark theme
async function runFrench() {
  console.log('PDF Reader — français / sombre');
  const s = await launchShell({ lang: 'fr', theme: 'dark' });
  const f = writeFixtures(s.home);
  recover = async () => {
    for (let i = 0; i < 6; i++) {
      const busy = await run(s, `!!document.querySelector('body > .menu, ${DLG}, ${WIN} .pdf-flyout')`).catch(() => false);
      if (!busy) break;
      await s.page.keyboard.press('Escape').catch(() => {});
      await sleep(250);
    }
  };
  await section('fr: start page', async () => {
    await s.aurora(() => window.__aurora.registry.launch('pdf'));
    await until(() => run(s, `!!document.querySelector('${WIN} .pdf-start:not([hidden]) .pdf-start-open')`), { label: 'start page' });
    check('fr: open button', await run(s, `document.querySelector('${WIN} .pdf-start-open').textContent`), 'Ouvrir un fichier');
    check('fr: tab title', await run(s, `document.querySelector('${WIN} .pdf-tab .pdf-tab-title').textContent`), 'Nouvel onglet');
    check('fr: window title', await W(s, (w) => w.win.title), 'Lecteur PDF');
    await shotDoc(s, 'pdf-start-fr-dark');
  });
  await section('fr: document', async () => {
    await openFile(s, f.guide);
    await ready(s);
    const tb = await run(s, `(() => { const tb = document.querySelector('${WIN} .pdf-toolbar'); return { fits: tb.scrollWidth <= tb.clientWidth + 1, overflowed: tb.querySelectorAll('.pdf-overflowed:not(.pdf-tb-sep)').length }; })()`);
    check('fr: toolbar fits', tb.fits, true);
    check('fr: tooltips translated', await run(s, `['find', 'save', 'present', 'darkPages'].map((c) => document.querySelector('${WIN} [data-cmd="' + c + '"]').dataset.tip)`), ['Rechercher (Ctrl+F)', 'Enregistrer (Ctrl+S)', 'Présenter (F5)', 'Mode lecture sombre']);
    check('fr: zoom label', await run(s, `document.querySelector('${WIN} .pdf-zoom-label').textContent`), (t) => /^\d+ %$|^\d+ %$/.test(t));
    check('fr: sidebar title', await run(s, `document.querySelector('${WIN} .pdf-side-title').textContent`), 'Pages');
    await focusDoc(s);
    await s.page.keyboard.press('Control+f');
    await s.page.keyboard.type('aurora');
    await until(() => run(s, `document.querySelector('${WIN} .pdf-find-count').textContent === '1 sur 8'`), { label: 'fr find count' });
    await shotDoc(s, 'pdf-document-fr-dark');
    await s.page.keyboard.press('Escape');
    await s.page.click(`${WIN} .pdf-pivot[data-view="outline"]`);
    await until(() => run(s, `document.querySelector('${WIN} .pdf-side-title').textContent === 'Plan'`), { label: 'fr outline title' });
    await s.page.click(`${WIN} .pdf-pivot[data-view="thumbs"]`);
  });
  await section('fr: properties and tools', async () => {
    await focusDoc(s);
    await s.page.keyboard.press('Control+d');
    await until(() => run(s, `!!document.querySelector('${DLG} .pdf-props')`), { label: 'properties' });
    check('fr: properties title', await run(s, `document.querySelector('${DLG} .dialog-title').textContent`), 'Propriétés du document');
    check('fr: page size in mm', await run(s, `document.querySelector('${DLG} dd[data-key="pageSize"]').textContent`), '210 × 297 mm (A4, portrait)');
    await shotDoc(s, 'pdf-properties-fr-dark');
    await s.page.keyboard.press('Escape');
    await s.page.click(`${WIN} [data-cmd="highlightOptions"]`);
    await until(() => run(s, `!!document.querySelector('${WIN} .pdf-flyout .pdf-swatch')`), { label: 'highlight flyout' });
    check('fr: swatch names', await run(s, `[...document.querySelectorAll('${WIN} .pdf-flyout .pdf-swatch')].map((b) => b.getAttribute('aria-label'))`), ['Jaune', 'Vert', 'Bleu', 'Rose', 'Rouge']);
    await s.page.click(`${WIN} .pdf-flyout .pdf-swatch[aria-label="Vert"]`);
    check('fr: highlight colour shown on the tool', await run(s, `document.querySelector('${WIN} [data-cmd="highlight"] .pdf-tool-swatch').style.getPropertyValue('--c')`), '#53FFBC');
    await shotDoc(s, 'pdf-tools-fr-dark');
    await s.page.keyboard.press('Escape');
    await s.page.click(`${WIN} [data-cmd="highlight"]`);
    await until(async () => (await state(s)).mode === 9, { label: 'highlight' });
    await dragText(s, 1, 'Aurora reader');
    await until(() => run(s, `!!document.querySelector('${WIN} .pdf-doc:not([hidden]) .highlightEditor')`), { label: 'highlight' });
    check('fr: editor toolbar translated', await run(s, `document.querySelector('${WIN} .editToolbar .deleteButton')?.title`), 'Supprimer le surlignage');
    check('fr: highlight uses the chosen colour', await W(s, (w) => [...w.active.pdf.annotationStorage.serializable.map.values()].map((v) => Array.from(v.color || []).join(','))), (c) => c.includes('83,255,188'));
    await s.page.keyboard.press('Escape');
    await s.page.keyboard.press('Escape');
    await s.page.keyboard.press('Control+w');
    await until(() => dialogOpen(s), { label: 'fr unsaved prompt' });
    check('fr: prompt buttons', await run(s, `[...document.querySelectorAll('${DLG} .dialog-footer button')].map((b) => b.textContent)`), ['Enregistrer', 'Ne pas enregistrer', 'Annuler']);
    await dialogButton(s, 'Annuler');
  });
  await section('fr: password and errors', async () => {
    await openFile(s, f.enc);
    await until(() => run(s, `!!document.querySelector('${DLG} .pdf-pw')`), { label: 'password' });
    check('fr: password title', await run(s, `document.querySelector('${DLG} .dialog-title').textContent`), 'Mot de passe requis');
    await dialogButton(s, 'Annuler');
    await until(async () => (await state(s))?.error === 'locked', { label: 'locked' });
    check('fr: locked text', await run(s, `document.querySelector('${WIN} .pdf-doc:not([hidden]) .pdf-error').innerText`), (t) => t.includes('Ce PDF est protégé par mot de passe'));
    await shotDoc(s, 'pdf-error-fr-dark');
  });
  await section('fr: small window', async () => {
    await W(s, (w) => {
      w.win.restore?.();
      w.win.setSize(500, 380);
    });
    await sleep(500);
    const noOverflow = `(() => { const r = document.querySelector('${WIN} .pdf-root'); const tb = document.querySelector('${WIN} .pdf-toolbar'); return r.scrollWidth <= r.clientWidth + 1 && (tb.hidden || tb.scrollWidth <= tb.clientWidth + 1); })()`;
    check('fr small: error page fits', await run(s, noOverflow), true);
    check('fr small: error buttons inside', await run(s, `(() => { const o = document.querySelector('${WIN} .pdf-doc:not([hidden]) .pdf-doc-overlay').getBoundingClientRect(); return [...document.querySelectorAll('${WIN} .pdf-doc:not([hidden]) .pdf-error button')].every((b) => { const r = b.getBoundingClientRect(); return r.left >= o.left - 1 && r.right <= o.right + 1; }); })()`), true);
    await shotDoc(s, 'pdf-error-fr-small');
    await s.page.keyboard.press('Control+t');
    await until(() => run(s, `!!document.querySelector('${WIN} .pdf-start:not([hidden])')`), { label: 'start tab' });
    check('fr small: start page fits', await run(s, `(() => { const st = document.querySelector('${WIN} .pdf-start'); return st.scrollWidth <= st.clientWidth + 1; })()`), true);
    check('fr small: recent rows fit', await run(s, `[...document.querySelectorAll('${WIN} .pdf-recent-row')].every((r) => r.scrollWidth <= r.clientWidth + 1)`), true);
    await shotDoc(s, 'pdf-start-fr-small');
    await W(s, (w) => w.activate(w.tabs.find((t) => t.doc?.name === 'Aurora guide.pdf')));
    await sleep(400);
    check('fr small: document toolbar fits', await run(s, noOverflow), true);
    await shotDoc(s, 'pdf-document-fr-small');
  });

  await section('fr: key names in tooltips and menus', async () => {
    await W(s, (w) => w.activate(w.tabs.find((t) => t.doc?.name === 'Aurora guide.pdf')));
    await sleep(300);
    const tips = await run(s, `Object.fromEntries([['saveAs', '[data-cmd="saveAs"]'], ['prev', '.pdf-find-btn.prev'], ['close', '.pdf-find-btn.close'], ['tab', '.pdf-tab.active .pdf-tab-close']].map(([k, sel]) => [k, document.querySelector('${WIN} ' + sel)?.dataset.tip]))`);
    check('fr: Save as tooltip', tips.saveAs, 'Enregistrer sous (Ctrl+Maj+S)');
    check('fr: previous result tooltip', tips.prev, 'Résultat précédent (Maj+F3)');
    check('fr: find close tooltip', tips.close, 'Fermer (Échap)');
    check('fr: tab close tooltip', tips.tab, 'Fermer l’onglet (Ctrl+W)');
    await s.page.click(`${WIN} [data-cmd="more"]`);
    await until(() => run(s, `!!document.querySelector('body > .menu')`), { label: 'more menu' });
    const shortcuts = await run(s, `[...document.querySelectorAll('body > .menu .menu-item .shortcut')].map((e) => e.textContent)`);
    check('fr: menu shortcuts use French key names', shortcuts.filter((k) => /Shift|Esc\b|Del\b/.test(k)), []);
    check('fr: Ctrl+Maj+S in the menu', shortcuts, (l) => l.includes('Ctrl+Maj+S'));
    await s.page.keyboard.press('Escape');
  });

  await section('fr: save errors in French', async () => {
    await W(s, (w) => {
      const api = w.ctx.api;
      window.__qaInvoke = api.invoke;
      api.invoke = (ch, ...a) => (ch === 'pdf:save' ? Promise.reject(Object.assign(new Error('EACCES: permission denied, open'), { code: 'EACCES' })) : window.__qaInvoke(ch, ...a));
      w.active.setDirty(true);
    });
    try {
      await focusDoc(s);
      await s.page.keyboard.press('Control+s');
      await until(() => dialogOpen(s), { label: 'save error' });
      check('fr: save error text', await dialogText(s), (t) => t.includes('Échec de l’enregistrement') && t.includes('Vous n’avez pas l’autorisation d’enregistrer dans ce dossier.') && !/EACCES|permission/.test(t));
      await dialogButton(s, 'OK');
    } finally {
      await W(s, (w) => {
        w.ctx.api.invoke = window.__qaInvoke;
      });
    }
  });

  await section('fr: console errors', async () => {
    const errs = s.logs.filter((l) => /^\[(error|pageerror)\]/.test(l) && !/Failed to load resource/.test(l));
    check('fr: no console errors', errs, []);
  });
  await s.close();
}

// ================================================================== run 3: maximized on real screen sizes
async function runSizes() {
  console.log('PDF Reader — maximized at 1280x720 and 1920x1080');
  for (const [size, lang, theme] of [
    ['1280x720', 'en', 'light'],
    ['1920x1080', 'fr', 'dark'],
  ]) {
    const s = await launchShell({ size, lang, theme });
    const f = writeFixtures(s.home);
    recover = null;
    await section(`sizes: ${size} maximized (${lang}, ${theme})`, async () => {
      await s.aurora((p) => window.__aurora.registry.launch('pdf', { file: p }), f.guide);
      await ready(s);
      await W(s, (w) => w.win.maximize());
      await sleep(900);
      const r = await run(
        s,
        `(() => { const win = document.querySelector('${WIN}').getBoundingClientRect(); const tb = document.querySelector('${WIN} .pdf-toolbar');
          const out = [...document.querySelectorAll('${WIN} .pdf-toolbar *, ${WIN} .pdf-strip *, ${WIN} .pdf-sidebar *')].filter((e) => { const b = e.getBoundingClientRect(); return b.width && (b.right > win.right + 1 || b.left < win.left - 1); }).length;
          const clipped = [...document.querySelectorAll('${WIN} *')].filter((el) => { if (el.closest('.pdf-scroller, svg')) return false; const cs = getComputedStyle(el); if (cs.display === 'none' || !el.offsetWidth) return false; const txt = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()); return txt && el.scrollWidth > el.clientWidth + 1 && cs.overflow !== 'visible' && cs.textOverflow !== 'ellipsis' && !el.closest('.pdf-tab-title'); }).map((e) => e.className);
          return { w: Math.round(win.width), fits: tb.scrollWidth <= tb.clientWidth + 1, overflowed: tb.querySelectorAll('.pdf-overflowed:not(.pdf-tb-sep)').length, out, clipped, sidebar: !document.querySelector('${WIN} .pdf-sidebar').hidden }; })()`,
      );
      check(`${size}: maximized to the screen width`, r.w, Number(size.split('x')[0]));
      check(`${size}: command bar fits`, r.fits, true);
      check(`${size}: every command visible`, r.overflowed, 0);
      check(`${size}: nothing sticks out of the window`, r.out, 0);
      check(`${size}: no clipped labels`, r.clipped, []);
      check(`${size}: sidebar docked`, r.sidebar, true);
      await shotDoc(s, `pdf-maximized-${size}-${lang}`);
      const errs = s.logs.filter((l) => /^\[(error|pageerror)\]/.test(l) && !/Failed to load resource/.test(l));
      check(`${size}: no console errors`, errs, []);
    });
    await s.close();
  }
}

// ================================================================== main
const wantFr = !only || only.startsWith('fr');
const wantSizes = !only || only.startsWith('sizes');
const wantMain = !only || (!only.startsWith('fr') && !only.startsWith('sizes'));
try {
  if (wantMain) await runMain();
  if (wantFr) await runFrench();
  if (wantSizes) await runSizes();
} catch (err) {
  failures.push(`fatal: ${err?.stack || err}`);
}
console.log(`\n${passed} checks passed, ${failures.length} failed`);
if (failures.length) {
  console.log(`\nFailures:\n  - ${failures.join('\n  - ')}`);
  process.exitCode = 1;
}
