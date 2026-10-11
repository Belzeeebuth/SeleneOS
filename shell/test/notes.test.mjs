// Notes tests — the real Electron shell driven by Playwright.
//   Sanitizer against XSS payloads (and nothing executes when the output is inserted), Markdown import /
//   export, first-run welcome note (EN / FR), create + edit + autosave + persistence across a restart (files on
//   disk, crash-safe writes), Markdown shortcuts while typing (+ undo back to the literal text), checklist
//   toggles, lists (Tab / Shift+Tab nesting, separate list kinds, toolbar toggles, Markdown export of nesting),
//   toolbar formatting (bold, highlight, colour, style, link + link card, table, clear), picture paste / drop /
//   insert / pasted HTML pictures stored as attachments, paste sanitization in the editor (lines -> list items in
//   a list), search (accent-insensitive, #tags, highlights), pin + sort, delete / restore / purge / 30-day auto
//   purge, notebooks (create, rename, colour, delete) + move (menu and drag & drop), export (.md with pictures,
//   .txt, .html) + import roundtrip, opening a .md with Notes, share by Mail, keyboard shortcuts, find in note,
//   save failures (error state, background retry, Retry, close prompt), responsive layouts, light / dark,
//   English / French (key names too), minimum and maximized sizes, console errors.
//   Documentation screenshots: aurora-os/docs/screenshots/notes-*.png
// Usage:  cd aurora-os/shell && xvfb-run -a -s "-screen 0 1600x900x24" node test/notes.test.mjs [--only=name]
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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

// ---------------------------------------------------------------- helpers
const WIN = '.win.app-notes';
const DLG = `${WIN} > .dialog-layer:not(.closing) .dialog`;
const BODY = `${WIN} .nt-body`;
async function until(fn, { timeout = 6000, step = 50, label = 'condition' } = {}) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    last = await fn();
    if (last) return last;
    await sleep(step);
  }
  throw new Error(`timed out waiting for ${label} (last: ${JSON.stringify(last)})`);
}
const run = (s, expr) => s.page.evaluate(expr);
// Evaluate fn(app, arg) in the shell (expression string, like the other app tests).
function N(s, fn, arg) {
  const expr = `(async () => { const el = document.querySelector(${JSON.stringify(WIN)}); const app = el && el.__notes; return (${fn.toString()})(app, ${JSON.stringify(arg ?? null)}); })()`;
  return s.page.evaluate(expr);
}
const dialogOpen = (s) => run(s, `!!document.querySelector(${JSON.stringify(DLG)})`);
async function dialogButton(s, label) {
  await until(() => dialogOpen(s), { label: 'dialog' });
  await sleep(150);
  await s.page.locator(DLG).last().locator('.dialog-footer .btn', { hasText: label }).first().click();
  await sleep(250);
}
async function menuClick(s, label) {
  await until(() => run(s, `!!document.querySelector('body > .menu')`), { label: 'menu' });
  await sleep(80);
  await s.page.locator('body > .menu .menu-item', { hasText: label }).first().click();
  await sleep(200);
}
async function closeFlyouts(s) {
  for (let i = 0; i < 6; i++) {
    const busy = await run(s, `!!document.querySelector('body > .menu, ${DLG}, ${WIN} .nt-pop:not(.closing)')`).catch(() => false);
    if (!busy) break;
    await s.page.keyboard.press('Escape').catch(() => {});
    await sleep(200);
  }
}
const notes = (s) => N(s, (app) => app.store.all().map((n) => ({ id: n.id, title: n.title, text: n.text, html: n.html, pinned: n.pinned, deletedAt: n.deletedAt, notebookId: n.notebookId, tags: n.tags, created: n.created, modified: n.modified })));
const byTitle = async (s, title) => (await notes(s)).find((n) => n.title === title);
const bodyHtml = (s) => run(s, `document.querySelector(${JSON.stringify(BODY)}).innerHTML`);
const selectedId = (s) => N(s, (app) => app.selectedId);
async function focusBodyEnd(s) {
  await run(`(() => { const b = document.querySelector(${JSON.stringify(BODY)}); b.focus(); const r = document.createRange(); r.selectNodeContents(b.lastElementChild || b); r.collapse(false); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); })()`.replace(/^/, '') && s, `(() => { const b = document.querySelector(${JSON.stringify(BODY)}); b.focus(); const r = document.createRange(); r.selectNodeContents(b.lastElementChild || b); r.collapse(false); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); })()`);
}
async function newNote(s, title) {
  const before = await N(s, (app) => app.selectedId);
  await s.page.keyboard.press('Control+n');
  // the new note is selected and its (empty) title focused
  await until(() => N(s, (app, prev) => app.selectedId !== prev && document.activeElement === app.editor.title && !app.editor.title.value, before), { label: 'title focused' });
  if (title) await s.page.keyboard.type(title, { delay: 5 });
  await s.page.keyboard.press('Enter');
  await until(() => run(s, `document.activeElement === document.querySelector(${JSON.stringify(BODY)})`), { label: 'body focused' });
}
async function typeLines(s, lines) {
  for (let i = 0; i < lines.length; i++) {
    await s.page.keyboard.type(lines[i], { delay: 5 });
    if (i < lines.length - 1) await s.page.keyboard.press('Enter');
  }
}
const flush = (s) => N(s, async (app) => {
  await app.saveCurrent();
  await app.store.flush();
  return true;
});
function notesDir(home) {
  return path.join(home, 'Documents', 'Notes');
}
async function rect(s, sel) {
  return run(s, `(() => { const r = document.querySelector(${JSON.stringify(sel)})?.getBoundingClientRect(); return r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null; })()`);
}
async function shot(s, name, { clip = true } = {}) {
  await sleep(350);
  const file = path.join(DOCS, `notes-${name}.png`);
  if (clip) {
    const r = await rect(s, WIN);
    const x = Math.max(0, r.x - 16);
    const y = Math.max(0, r.y - 16);
    await s.page.screenshot({ path: file, clip: { x, y, width: Math.min(1600 - x, r.w + 32), height: Math.min(900 - y, r.h + 32) } });
  } else await s.page.screenshot({ path: file });
  return file;
}
function errorsSince(s, mark) {
  return s.logs.slice(mark).filter((l) => /^\[(error|pageerror)\]/.test(l) && !/status of 404/.test(l) && !/net::ERR_/.test(l));
}
async function setWinSize(s, w, h) {
  await N(s, (app, a) => {
    if (app.win.isMaximized?.()) app.win.restore();
    app.win.setSize(a.w, a.h);
    app.win.center?.();
  }, { w, h });
  await sleep(400);
}
// a small real PNG (solid colour) built in Node
function png(w, h, rgb) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
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
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      const shade = (x + y) % 32 < 16 ? 1 : 0.85;
      raw[o] = rgb[0] * shade;
      raw[o + 1] = rgb[1] * shade;
      raw[o + 2] = rgb[2] * shade;
    }
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const PNG_BLUE = png(96, 64, [40, 120, 220]);
const PNG_ORANGE = png(80, 80, [240, 140, 40]);

// ================================================================= session 1: English, light
console.log('Notes — English / light');
let s = await launchShell({ open: ['notes'], lang: 'en', theme: 'light', keepHome: true });
const home = s.home;
setRecover(s);
function setRecover(sess) {
  recover = () => closeFlyouts(sess);
}
await until(() => run(s, `!!document.querySelector('${WIN} .nt-item')`), { timeout: 20000, label: 'notes list' });
await sleep(500);
let mark = 0;

await section('sanitizer: XSS payloads', async () => {
  const res = await run(
    s,
    `(async () => {
      const { sanitizeHtml, sanitizeFragment } = await import('app://shell/apps/notes/lib/sanitize.js');
      window.__xss = 0;
      const payloads = [
        '<script>window.__xss=1</script>ok',
        '<img src=x onerror="window.__xss=1">',
        '<img src="data:image/png;base64,iVBORw0KGgo=" onerror="window.__xss=1" onload="window.__xss=1">',
        '<a href="javascript:window.__xss=1">js</a>',
        '<a href="  java\\nscript:window.__xss=1">js2</a>',
        '<a href="JaVaScRiPt:window.__xss=1">js3</a>',
        '<a href="&#106;avascript:window.__xss=1">js4</a>',
        '<a href="data:text/html,<script>window.__xss=1</script>">data</a>',
        '<a href="vbscript:msgbox(1)">vb</a>',
        '<iframe src="javascript:window.__xss=1"></iframe><iframe srcdoc="<script>parent.__xss=1</script>"></iframe>',
        '<svg onload="window.__xss=1"><script>window.__xss=1</script></svg>',
        '<math><mi xlink:href="javascript:window.__xss=1">m</mi></math>',
        '<div style="background:url(javascript:window.__xss=1)" onclick="window.__xss=1" class="evil" id="evil">styled</div>',
        '<form action="javascript:window.__xss=1"><input autofocus onfocus="window.__xss=1"><button formaction="javascript:1">b</button></form>',
        '<style>@import url(https://evil.example/x.css); body{display:none}</style>',
        '<object data="javascript:window.__xss=1"></object><embed src="javascript:window.__xss=1">',
        '<template><img src=x onerror="window.__xss=1"></template>',
        '<noscript><p title="</noscript><img src=x onerror=window.__xss=1>">t</p></noscript>',
        '<details open ontoggle="window.__xss=1">d</details>',
        '<video><source onerror="window.__xss=1"></video><audio src=x onerror="window.__xss=1"></audio>',
        '<meta http-equiv="refresh" content="0;url=javascript:window.__xss=1"><base href="javascript:/">',
        '<img src="file:///etc/passwd"><img src="http://example.com/a.png">',
        '<a href="https://example.com/ok" target="_blank" onmouseover="window.__xss=1">fine</a><a href="mailto:a@b.example">mail</a>',
        '<span data-color="javascript:alert(1)">c</span><mark data-hl="x" style="color:red">m</mark>',
        '<p><b>bold</b><i>it</i><u>u</u><s>s</s><code>c</code></p>',
        '<x-custom onclick="window.__xss=1"><p>custom</p></x-custom>',
        '<table onmouseover="window.__xss=1"><tr><td colspan="2" style="x">cell</td></tr></table>',
        '<img src="x" srcset="javascript:alert(1)" data-att="../../etc/passwd">',
        '<a href="https://ok.example" xlink:href="javascript:1" formaction="javascript:1">x</a>',
        '<svg><a href="javascript:window.__xss=1"><text>svg link</text></a></svg>',
        '<a href="javascript&colon;window.__xss=1">colon</a><a href="file:///etc/passwd">file</a>',
        '<math><mtext><table><mglyph><style><img src=x onerror="window.__xss=1"></style></mglyph></table></mtext></math>',
        '<form><math><mtext></form><form><mglyph><svg><mtext><style><path id="</style><img onerror=window.__xss=1 src>">',
      ];
      const out = payloads.map((p) => sanitizeHtml(p, { collapseWhitespace: true, allowRemote: false, allowMedia: true }));
      const box = document.createElement('div');
      box.innerHTML = out.join('');
      document.body.appendChild(box); // live: nothing must run
      await new Promise((r) => setTimeout(r, 400));
      box.remove();
      const bad = [];
      for (const el of box.querySelectorAll('*')) {
        if (['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'SVG', 'MATH', 'FORM', 'INPUT', 'BUTTON', 'TEMPLATE', 'NOSCRIPT', 'META', 'BASE', 'VIDEO', 'AUDIO', 'SOURCE', 'DETAILS', 'X-CUSTOM'].includes(el.tagName.toUpperCase())) bad.push('tag ' + el.tagName);
        for (const a of el.attributes) {
          if (/^on/i.test(a.name) || ['style', 'class', 'id', 'srcset', 'srcdoc', 'formaction', 'xlink:href', 'target', 'action'].includes(a.name)) bad.push('attr ' + a.name);
          if (/^\\s*(javascript|vbscript|data:text)/i.test(a.value)) bad.push('url ' + a.value);
        }
      }
      const deep = sanitizeHtml('<div>'.repeat(3000) + 'deep' + '</div>'.repeat(3000));
      return {
        xss: window.__xss,
        bad,
        out,
        deepKept: deep.includes('deep'),
        googleDocs: sanitizeHtml('<b style="font-weight:normal;" id="docs-internal-guid-1"><p dir="ltr"><span style="font-weight:700">Hello</span> <span style="font-style:italic">world</span></p></b>', { collapseWhitespace: true }),
        tasks: sanitizeHtml('<ul><li><input type="checkbox" checked disabled> done</li><li><input type="checkbox"> todo</li></ul>', { collapseWhitespace: true }),
        stored: sanitizeHtml('<img src="att-abcdefgh-pic.png" data-att="att-abcdefgh-pic.png"><img src="../secret.png">', { attachments: true }),
        notStored: sanitizeHtml('<img src="att-abcdefgh-pic.png">', {}),
      };
    })()`,
  );
  check('no payload executed', res.xss, 0);
  check('no dangerous tag / attribute / URL survives', res.bad, []);
  check('script dropped, text kept', res.out[0], '<div>ok</div>');
  check('img with invalid src dropped', res.out[1], '');
  check('data: image kept without handlers', res.out[2], (v) => /^<div><img src="data:image\/png;base64,iVBORw0KGgo="><\/div>$/.test(v));
  check('javascript: links lose the link', res.out.slice(3, 9).every((o) => !o.includes('<a')), true);
  check('link text kept', res.out[3], '<div>js</div>');
  check('iframes removed', res.out[9], '');
  check('svg / math removed', [res.out[10], res.out[11]], ['', '']);
  check('styles / classes / handlers stripped', res.out[12], '<div>styled</div>');
  check('style element dropped', res.out[14], '');
  check('remote image dropped unless allowed, file: never', res.out[21], '');
  check('safe links kept (only href)', res.out[22], '<div><a href="https://example.com/ok">fine</a><a href="mailto:a@b.example">mail</a></div>');
  check('unknown colours unwrapped, bad highlight -> yellow', res.out[23], '<div>c<mark data-hl="yellow">m</mark></div>');
  check('basic formatting kept', res.out[24], '<p><b>bold</b><i>it</i><u>u</u><s>s</s><code>c</code></p>');
  check('custom element unwrapped', res.out[25], '<p>custom</p>');
  check('table kept with colspan only', res.out[26], '<table><tbody><tr><td colspan="2">cell</td></tr></tbody></table>');
  check('srcset / bad data-att dropped', res.out[27], '');
  check('svg link dropped', res.out[29], '');
  check('entity-encoded javascript: and file: links lose the link', res.out[30], '<div>colonfile</div>');
  check('math / mglyph / style mutation vectors removed', [res.out[31], res.out[32].includes('<img')], ['', false]);
  check('deep nesting does not crash', res.deepKept, true);
  check('Google Docs paste: wrapper bold ignored, styles -> b / i', res.googleDocs, '<p><b>Hello</b> <i>world</i></p>');
  check('GitHub task list -> checklist', res.tasks, '<ul data-type="checklist"><li data-checked="true">done</li><li data-checked="false">todo</li></ul>');
  check('stored notes keep attachment names only', res.stored, '<div><img src="att-abcdefgh-pic.png" data-att="att-abcdefgh-pic.png"></div>');
  check('relative src refused outside stored notes', res.notStored, '');
});

await section('markdown: import and export', async () => {
  const res = await run(
    s,
    `(async () => {
      const md = await import('app://shell/apps/notes/lib/markdown.js');
      const { sanitizeFragment } = await import('app://shell/apps/notes/lib/sanitize.js');
      const html = '<h1>Big</h1><div>Some <b>bold</b>, <i>it</i>, <s>gone</s>, <u>u</u>, <mark data-hl="green">hl</mark>, <code>a*b</code> and <a href="https://example.com/x_y">a link</a>.</div>' +
        '<ul><li>one</li><li>two<ul><li>nested</li></ul></li></ul><ol start="3"><li>three</li><li>four</li></ol>' +
        '<ul data-type="checklist"><li data-checked="true">done</li><li data-checked="false">todo</li></ul>' +
        '<blockquote>quoted</blockquote><pre>let a = 1;\\n  let b = "*x*";</pre><hr><table><tbody><tr><th>K</th><th>V</th></tr><tr><td>a|b</td><td>2</td></tr></tbody></table>' +
        '<div>1. not a list</div><div># not a heading</div><div>snake_case *star*</div><div><img src="att-abcdefgh-pic.png" alt="pic"></div>';
      const doc = document.implementation.createHTMLDocument(''); // inert: attachment names are never fetched
      const box = doc.createElement('div');
      box.appendChild(sanitizeFragment(html, { attachments: true, doc }));
      const text = md.htmlToMarkdown(box, { image: (img) => 'Note_files/' + img.getAttribute('src') });
      const back = doc.createElement('div');
      back.appendChild(sanitizeFragment(md.markdownToHtml(text), { attachments: true, allowRemote: true, doc }));
      return { text, back: back.innerHTML, title: md.markdownTitle('# My *title*\\n\\nBody'), setext: md.markdownToHtml('Title\\n=====\\n\\ntext') };
    })()`,
  );
  const t = res.text;
  check('md: heading', t.startsWith('# Big\n'), true);
  check('md: inline marks', t.includes('**bold**') && t.includes('*it*') && t.includes('~~gone~~') && t.includes('<u>u</u>') && t.includes('==hl==') && t.includes('`a*b`'), true);
  check('md: link', t.includes('[a link](https://example.com/x_y)'), true);
  check('md: nested bullet', t.includes('- two\n  - nested'), true);
  check('md: ordered start', t.includes('3. three\n4. four'), true);
  check('md: task list', t.includes('- [x] done\n- [ ] todo'), true);
  check('md: quote, fence, rule', t.includes('> quoted') && t.includes('```\nlet a = 1;\n  let b = "*x*";\n```') && t.includes('\n---\n'), true);
  check('md: table with escaped pipe', t.includes('| K | V |\n| --- | --- |\n| a\\|b | 2 |'), true);
  check('md: block markers escaped', t.includes('1\\. not a list') && t.includes('\\# not a heading'), true);
  check('md: emphasis characters escaped', t.includes('snake\\_case \\*star\\*'), true);
  check('md: picture path', t.includes('![pic](Note_files/att-abcdefgh-pic.png)'), true);
  const b = res.back;
  check('roundtrip: structure back', ['<h1>Big</h1>', '<b>bold</b>', '<i>it</i>', '<s>gone</s>', '<u>u</u>', '<mark data-hl="yellow">hl</mark>', '<code>a*b</code>', '<a href="https://example.com/x_y">a link</a>', '<li>two<ul><li>nested</li></ul></li>', '<ol start="3">', '<ul data-type="checklist"><li data-checked="true">done</li><li data-checked="false">todo</li></ul>', '<blockquote>quoted</blockquote>', '<pre>let a = 1;\n  let b = "*x*";</pre>', '<hr>', '<th>K</th>', '<td>a|b</td>', '<p>1. not a list</p>', '<p># not a heading</p>', '<p>snake_case *star*</p>'].filter((x) => !b.includes(x)), []);
  check('markdownTitle', res.title, { title: 'My *title*', body: '\nBody' });
  check('setext heading', res.setext, '<h1>Title</h1><p>text</p>');
});

await section('first run: welcome note, notebook, tags (English)', async () => {
  const all = await notes(s);
  check('one note seeded', all.length, 1);
  check('welcome title', all[0]?.title, 'Welcome to Notes');
  check('welcome pinned', all[0]?.pinned, true);
  check('welcome tags', all[0]?.tags, ['tips', 'welcome']);
  check('default notebook', await N(s, (app) => app.store.notebooks.map((b) => b.name)), ['My notes']);
  check('welcome open in the editor', await run(s, `document.querySelector('${WIN} .nt-title').value`), 'Welcome to Notes');
  check('nav shows tags', await run(s, `[...document.querySelectorAll('${WIN} .nt-nav-tag .label')].map((e) => e.textContent)`), ['tips', 'welcome']);
  const dir = notesDir(home);
  check('stored in ~/Documents/Notes', fs.existsSync(path.join(dir, 'notes.json')) && fs.existsSync(path.join(dir, all[0].id, 'note.html')), true);
  const page = fs.readFileSync(path.join(dir, all[0].id, 'note.html'), 'utf8');
  check('note file is a standalone page with metadata', page.includes('<meta name="aurora-note"') && page.includes('<title>Welcome to Notes</title>') && page.includes('<!--aurora:body-->'), true);
  check('window title', await run(s, `document.querySelector('${WIN} .win-title, ${WIN} .win-titlebar')?.textContent || ''`), (v) => v.includes('Welcome to Notes'));
  await shot(s, 'welcome-light-en');
});

let groceriesId = null;
await section('create, edit, autosave, saved indicator', async () => {
  mark = s.logs.length;
  await newNote(s, 'Groceries');
  await typeLines(s, ['Milk and eggs', 'Café crème for the morning']);
  await until(() => run(s, `document.querySelector('${WIN} .nt-saved')?.dataset.state === 'saved'`), { label: 'saved indicator', timeout: 4000 });
  const n = await byTitle(s, 'Groceries');
  groceriesId = n?.id;
  check('note created with title', !!n, true);
  check('body autosaved', n?.text, 'Milk and eggs\nCafé crème for the morning');
  const file = path.join(notesDir(home), n.id, 'note.html');
  check('note file written', fs.readFileSync(file, 'utf8').includes('Café crème for the morning'), true);
  check('no temp files left', fs.readdirSync(path.join(notesDir(home), n.id)).filter((f) => f.endsWith('.tmp')), []);
  await flush(s);
  const index = JSON.parse(fs.readFileSync(path.join(notesDir(home), 'notes.json'), 'utf8'));
  check('index has the note', index.notes[n.id]?.title, 'Groceries');
  // title + body: 1 + 3 + 5 words; characters without line breaks
  check('word / character count', await run(s, `document.querySelector('${WIN} .nt-count').textContent`), '9 words · 48 characters');
  check('last edited', await run(s, `document.querySelector('${WIN} .nt-edited').textContent`), 'Last edited just now');
  check('list item shows title + preview', await run(s, `(() => { const el = document.querySelector('${WIN} .nt-item.selected'); return el && [el.querySelector('.nt-item-title').textContent, el.querySelector('.nt-item-preview').textContent]; })()`), ['Groceries', 'Milk and eggs Café crème for the morning']);
  check('no console errors', errorsSince(s, mark), []);
});

await section('markdown shortcuts while typing (+ undo to literal)', async () => {
  await newNote(s, 'Shortcuts');
  await s.page.keyboard.type('# Heading one', { delay: 5 });
  await s.page.keyboard.press('Enter');
  await s.page.keyboard.type('## Sub', { delay: 5 });
  await s.page.keyboard.press('Enter');
  await s.page.keyboard.type('- apple', { delay: 5 });
  await s.page.keyboard.press('Enter');
  await s.page.keyboard.type('pear', { delay: 5 });
  await s.page.keyboard.press('Enter');
  await s.page.keyboard.press('Enter'); // leave the list
  await s.page.keyboard.type('1. first', { delay: 5 });
  await s.page.keyboard.press('Enter');
  await s.page.keyboard.press('Enter');
  await s.page.keyboard.type('[] task one', { delay: 5 });
  await s.page.keyboard.press('Enter');
  await s.page.keyboard.type('task two', { delay: 5 });
  await s.page.keyboard.press('Enter');
  await s.page.keyboard.press('Enter');
  await s.page.keyboard.type('> wise words', { delay: 5 });
  await s.page.keyboard.press('Enter');
  await s.page.keyboard.press('Enter');
  await s.page.keyboard.type('Make it **bold** and *slanted* and ~~old~~ and `x()` and ==marked== ok', { delay: 5 });
  await s.page.keyboard.press('Enter');
  await s.page.keyboard.type('```', { delay: 20 });
  await s.page.keyboard.type('code line', { delay: 5 });
  await s.page.keyboard.press('Enter');
  await s.page.keyboard.type('second', { delay: 5 });
  await s.page.keyboard.press('Enter');
  await s.page.keyboard.press('Enter'); // leave the code block
  await s.page.keyboard.type('---', { delay: 5 });
  await s.page.keyboard.press('Enter');
  await s.page.keyboard.type('after rule', { delay: 5 });
  const html = await bodyHtml(s);
  check('# -> h1', html.includes('<h1>Heading one</h1>'), true);
  check('## -> h2', html.includes('<h2>Sub</h2>'), true);
  check('- -> bullet list', /<ul><li>apple<\/li><li>pear<\/li><\/ul>/.test(html), true);
  check('1. -> numbered list', /<ol><li>first<\/li><\/ol>/.test(html), true);
  check('[] -> checklist', /<ul data-type="checklist"><li data-checked="false">task one<\/li><li data-checked="false">task two<\/li><\/ul>/.test(html), true);
  check('> -> quote', html.includes('<blockquote>wise words</blockquote>'), true);
  check('**bold** *italic* ~~strike~~ `code` ==mark==', ['<b>bold</b>', '<i>slanted</i>', '<s>old</s>', '<code>x()</code>', '<mark data-hl="yellow">marked</mark>'].filter((x) => !html.includes(x)), []);
  check('typing continues outside the format', /<\/mark>​? ok/.test(html), true);
  check('``` -> code block with lines', html.includes('<pre>code line\nsecond</pre>'), true);
  check('--- -> divider', /<hr><div>after rule<\/div>/.test(html), true);
  check('body stays flat after leaving lists', await run(s, `[...document.querySelector('${BODY}').children].map((c) => c.tagName).join(' ')`), 'H1 H2 UL OL UL BLOCKQUOTE DIV PRE HR DIV');
  // undo turns a shortcut back into the typed characters
  await s.page.keyboard.press('Enter');
  await s.page.keyboard.type('### ', { delay: 10 });
  check('### -> h3', await run(s, `!!document.querySelector('${BODY} h3')`), true);
  await s.page.keyboard.press('Control+z');
  check('undo restores the literal "### "', await run(s, `(() => { const b = document.querySelector('${BODY}'); return !b.querySelector('h3') && b.lastElementChild.textContent; })()`), (v) => typeof v === 'string' && v.startsWith('###'));
  await s.page.keyboard.press('Control+y');
  check('redo converts again', await run(s, `!!document.querySelector('${BODY} h3')`), true);
  await flush(s);
  const n = await byTitle(s, 'Shortcuts');
  check('saved html has no zero-width spaces', n.html.includes('​'), false);
  check('stored structure', n.html.includes('<h1>Heading one</h1>') && n.html.includes('<pre>code line\nsecond</pre>'), true);
  await shot(s, 'markdown-light-en');
});

await section('checklist: click and Ctrl+Enter toggle, persisted', async () => {
  const li = `${BODY} ul[data-type="checklist"] > li`;
  const r = await rect(s, li);
  await s.page.mouse.click(r.x + 10, r.y + 12);
  await sleep(150);
  check('click on the box ticks the item', await run(s, `document.querySelector('${li}').dataset.checked`), 'true');
  check('caret did not move into the text', await run(s, `getSelection().anchorNode?.parentElement?.closest('li') === document.querySelector('${li}')`), false);
  await s.page.mouse.click(r.x + 10, r.y + 12);
  await sleep(150);
  check('second click unticks', await run(s, `document.querySelector('${li}').dataset.checked`), 'false');
  // keyboard: caret in the second item, Ctrl+Enter
  await run(s, `(() => { const el = document.querySelectorAll('${li}')[1]; el.closest('.nt-body').focus(); const r = document.createRange(); r.selectNodeContents(el); r.collapse(false); getSelection().removeAllRanges(); getSelection().addRange(r); })()`);
  await s.page.keyboard.press('Control+Enter');
  await sleep(100);
  check('Ctrl+Enter ticks the current item', await run(s, `document.querySelectorAll('${li}')[1].dataset.checked`), 'true');
  await flush(s);
  check('checked state saved', (await byTitle(s, 'Shortcuts')).html.includes('<li data-checked="true">task two</li>'), true);
  await s.page.keyboard.press('Control+z');
  check('undo unticks', await run(s, `document.querySelectorAll('${li}')[1].dataset.checked`), 'false');
});

await section('lists: Tab / Shift+Tab, separate kinds, toolbar toggles, export of nesting', async () => {
  mark = s.logs.length;
  await newNote(s, 'Lists');
  const k = s.page.keyboard;
  check('title previewed live in the list', await run(s, `document.querySelector('${WIN} .nt-item.selected .nt-item-title').textContent`), 'Lists');
  await k.type('- one', { delay: 5 });
  await k.press('Enter');
  await k.press('Tab');
  await k.type('nested', { delay: 5 });
  await k.press('Enter');
  await k.press('Tab');
  await k.type('deeper', { delay: 5 });
  check('Tab nests inside the item above (li > ul)', await bodyHtml(s), '<ul><li>one<ul><li>nested<ul><li>deeper</li></ul></li></ul></li></ul>');
  await k.press('Shift+Tab');
  await k.press('Shift+Tab');
  check('Shift+Tab back to the top level', await bodyHtml(s), '<ul><li>one<ul><li>nested</li></ul></li><li>deeper</li></ul>');
  await k.press('Enter');
  await k.press('Enter');
  check('Enter on an empty item leaves the list', await run(s, `document.querySelector('${BODY}').lastElementChild.tagName`), 'DIV');
  await k.type('[] milk', { delay: 5 });
  await k.press('Enter');
  await k.type('bread', { delay: 5 });
  const html = await bodyHtml(s);
  check('a checklist under a bullet list stays a separate list', html, '<ul><li>one<ul><li>nested</li></ul></li><li>deeper</li></ul><ul data-type="checklist"><li data-checked="false">milk</li><li data-checked="false">bread</li></ul>');
  // toolbar: checklist -> numbers -> off
  await N(s, (app) => app.editor.command('ol'));
  check('toolbar switches the list kind', await run(s, `document.querySelector('${BODY}').lastElementChild.outerHTML`), '<ol><li>milk</li><li>bread</li></ol>');
  check('numbers button pressed', await run(s, `document.querySelector('${WIN} .nt-cmd[data-cmd="ol"]').getAttribute('aria-pressed')`), 'true');
  await N(s, (app) => app.editor.command('ol'));
  check('toggle off: the item becomes a line, the list splits', await run(s, `[...document.querySelector('${BODY}').children].slice(-2).map((e) => e.outerHTML)`), ['<ol><li>milk</li></ol>', '<div>bread</div>']);
  await N(s, (app) => app.editor.command('ul'));
  check('a line under a numbered list becomes a separate bullet list', await run(s, `[...document.querySelector('${BODY}').children].slice(-2).map((e) => e.outerHTML)`), ['<ol><li>milk</li></ol>', '<ul><li>bread</li></ul>']);
  await N(s, (app) => app.editor.command('ol'));
  check('same kind as the list above: it joins it', await run(s, `document.querySelector('${BODY}').lastElementChild.outerHTML`), '<ol><li>milk</li><li>bread</li></ol>');
  // undo restores the previous structure
  await k.press('Control+z');
  check('undo of a list command', await run(s, `document.querySelector('${BODY}').lastElementChild.outerHTML`), '<ul><li>bread</li></ul>');
  await k.press('Control+y');
  await flush(s);
  const n = await byTitle(s, 'Lists');
  const md = await N(s, (app, html) => import('app://shell/apps/notes/lib/markdown.js').then((m) => {
    const doc = document.implementation.createHTMLDocument('');
    const box = doc.createElement('div');
    box.innerHTML = html;
    return m.htmlToMarkdown(box);
  }), n.html);
  check('nested items exported as indented Markdown', md, '- one\n  - nested\n- deeper\n\n1. milk\n2. bread\n');
  // keyboard shortcuts on a new line
  await focusBodyEnd(s);
  await k.press('Enter');
  await k.press('Enter');
  await k.type('keys', { delay: 5 });
  const last = () => run(s, `document.querySelector('${BODY}').lastElementChild.outerHTML`);
  await k.press('Control+Shift+8');
  check('Ctrl+Shift+8: bullets', await last(), '<ul><li>keys</li></ul>');
  await k.press('Control+Shift+C');
  check('Ctrl+Shift+C: checklist', await last(), '<ul data-type="checklist"><li data-checked="false">keys</li></ul>');
  await k.press('Control+Enter');
  check('Ctrl+Enter ticks it', await last(), '<ul data-type="checklist"><li data-checked="true">keys</li></ul>');
  await k.press('Control+Shift+C');
  check('Ctrl+Shift+C again: back to a line', await last(), '<div>keys</div>');
  await k.press('Tab');
  check('Tab in text inserts a tab', await last(), '<div>keys\t</div>');
  await k.press('Shift+Tab');
  check('Shift+Tab in text leaves the body (no keyboard trap)', await run(s, `document.activeElement?.classList.contains('nt-title')`), true);
  check('no console errors', errorsSince(s, mark), []);
});

await section('toolbar: bold, highlight, colour, style, link, table, clear', async () => {
  await newNote(s, 'Formatting');
  await typeLines(s, ['alpha beta gamma', 'second line']);
  const selectWord = (word) =>
    run(s, `(() => { const b = document.querySelector('${BODY}'); const w = document.createTreeWalker(b, NodeFilter.SHOW_TEXT); for (let n = w.nextNode(); n; n = w.nextNode()) { const i = n.data.indexOf(${JSON.stringify(word)}); if (i >= 0) { b.focus(); const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + ${word.length}); getSelection().removeAllRanges(); getSelection().addRange(r); return true; } } return false; })()`);
  await selectWord('beta');
  await s.page.click(`${WIN} .nt-cmd[data-cmd="bold"]`);
  check('bold button', await bodyHtml(s), (h) => h.includes('<b>beta</b>'));
  check('bold button shows pressed', await run(s, `document.querySelector('${WIN} .nt-cmd[data-cmd="bold"]').getAttribute('aria-pressed')`), 'true');
  // highlight colour from the palette
  await selectWord('gamma');
  const hlArrow = `${WIN} .nt-cmd[data-cmd="hlMenu"]`;
  if (!(await run(s, `!!document.querySelector('${hlArrow}')?.offsetParent`))) await N(s, (app) => app.editor.colorPopover('hl', app.editor.cmdbar));
  else await s.page.click(hlArrow);
  await until(() => run(s, `!!document.querySelector('${WIN} .nt-pop .nt-swatch')`), { label: 'palette' });
  await shot(s, 'highlight-palette');
  await s.page.click(`${WIN} .nt-pop .nt-swatch[data-hl="green"]`);
  check('green highlight', await bodyHtml(s), (h) => h.includes('<mark data-hl="green">gamma</mark>'));
  // text colour (command API: the button may be in the overflow menu at this width)
  await selectWord('alpha');
  await N(s, (app) => app.editor.run(() => app.editor.applyColor('color', 'blue')));
  check('blue text', await bodyHtml(s), (h) => h.includes('<span data-color="blue">alpha</span>'));
  await selectWord('alpha');
  await N(s, (app) => app.editor.run(() => app.editor.applyColor('color', 'red')));
  check('recolour replaces (no nesting)', await bodyHtml(s), (h) => h.includes('<span data-color="red">alpha</span>') && !h.includes('data-color="blue"'));
  // style menu -> Heading 2 for the second line
  await selectWord('second');
  await s.page.click(`${WIN} .nt-style-btn`);
  await menuClick(s, 'Heading 2');
  check('style menu: heading 2', await bodyHtml(s), (h) => h.includes('<h2>second line</h2>'));
  check('style button shows the style', await run(s, `document.querySelector('${WIN} .nt-style-label').textContent`), 'Heading 2');
  // link: Ctrl+K dialog
  await selectWord('beta');
  await s.page.keyboard.press('Control+k');
  await until(() => dialogOpen(s), { label: 'link dialog' });
  await sleep(100);
  await s.page.keyboard.type('javascript:alert(1)');
  await s.page.keyboard.press('Enter');
  await sleep(200);
  check('bad URL refused', await run(s, `document.querySelector('${DLG} .nt-field-error')?.textContent || ''`), (v) => v.length > 5);
  await s.page.fill(`${DLG} input[type="url"]`, 'example.com/page');
  await s.page.keyboard.press('Enter');
  await sleep(250);
  check('link created around the selection', await bodyHtml(s), (h) => /<a href="https:\/\/example\.com\/page"><b>beta<\/b><\/a>|<b><a href="https:\/\/example\.com\/page">beta<\/a><\/b>/.test(h));
  // link card + Ctrl+click opens Aurora Browser
  await N(s, (app) => {
    window.__opened = [];
    app.__openUrl = app.ctx.shell.openUrl;
    app.ctx.shell.openUrl = (u) => window.__opened.push(u);
  });
  const a = await rect(s, `${BODY} a`);
  await s.page.mouse.click(a.x + 4, a.y + a.h / 2);
  await until(() => run(s, `!!document.querySelector('${WIN} .nt-linkpop:not(.closing)')`), { label: 'link card' });
  await shot(s, 'link-card');
  await s.page.keyboard.down('Control');
  await s.page.mouse.click(a.x + 4, a.y + a.h / 2);
  await s.page.keyboard.up('Control');
  await sleep(100);
  check('Ctrl+click opens the browser', await run(s, `window.__opened`), ['https://example.com/page']);
  await N(s, (app) => {
    app.ctx.shell.openUrl = app.__openUrl;
  });
  // table + rows / columns
  await focusBodyEnd(s);
  await N(s, (app) => app.editor.run(() => app.editor.insertTable()));
  check('3x3 table inserted', await run(s, `(() => { const t = document.querySelector('${BODY} table'); return t ? [t.rows.length, t.rows[0].cells.length] : null; })()`), [3, 3]);
  await s.page.keyboard.type('K1');
  await s.page.keyboard.press('Tab');
  await s.page.keyboard.type('K2');
  check('Tab moves to the next cell', await run(s, `[...document.querySelector('${BODY} table').rows[0].cells].map((c) => c.textContent)`), ['K1', 'K2', '']);
  await N(s, (app) => app.editor.run(() => app.editor.tableRow(1)));
  await N(s, (app) => app.editor.run(() => app.editor.tableCol(1)));
  check('row and column added', await run(s, `(() => { const t = document.querySelector('${BODY} table'); return [t.rows.length, t.rows[0].cells.length]; })()`), [4, 4]);
  await N(s, (app) => app.editor.run(() => app.editor.tableDeleteCol()));
  check('column deleted', await run(s, `document.querySelector('${BODY} table').rows[0].cells.length`), 3);
  // clear formatting on the first line
  await selectWord('alpha beta gamma'.slice(0, 5));
  await run(s, `(() => { const b = document.querySelector('${BODY}'); const r = document.createRange(); r.selectNodeContents(b.firstElementChild); getSelection().removeAllRanges(); getSelection().addRange(r); })()`);
  await s.page.keyboard.press('Control+Space');
  check('clear formatting removes b / mark / colour (keeps the link)', await run(s, `document.querySelector('${BODY}').firstElementChild.innerHTML`), (h) => !/<b>|<mark|data-color/.test(h) && h.includes('alpha'));
  // undo / redo buttons
  await s.page.click(`${WIN} .nt-cmd[data-cmd="undo"]`);
  check('undo button restores formatting', await run(s, `document.querySelector('${BODY}').firstElementChild.innerHTML`), (h) => /data-color="red"/.test(h));
  await s.page.click(`${WIN} .nt-cmd[data-cmd="redo"]`);
  check('redo button', await run(s, `document.querySelector('${BODY}').firstElementChild.innerHTML`), (h) => !/data-color/.test(h));
  await flush(s);
  await shot(s, 'formatting-light-en');
});

await section('pictures: paste, drop, pasted HTML pictures -> attachments', async () => {
  await newNote(s, 'Pictures');
  await s.page.keyboard.type('Here is a picture:', { delay: 5 });
  const id = await selectedId(s);
  const b64 = PNG_BLUE.toString('base64');
  // clipboard paste of an image file
  await run(
    s,
    `(() => {
      const bytes = Uint8Array.from(atob(${JSON.stringify(b64)}), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], 'shot.png', { type: 'image/png' }));
      document.querySelector('${BODY}').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    })()`,
  );
  await until(() => run(s, `!!document.querySelector('${BODY} img[data-att]')`), { label: 'pasted picture stored' });
  const att = await run(s, `document.querySelector('${BODY} img[data-att]').dataset.att`);
  check('a picture gets a line of its own', await run(s, `(() => { const i = document.querySelector('${BODY} img[data-att]'); return [i.parentElement.tagName, i.parentElement.childNodes.length, i.parentElement.previousElementSibling?.textContent]; })()`), ['DIV', 1, 'Here is a picture:']);
  check('attachment named att-…', /^att-[a-z0-9]{8}-shot\.png$/.test(att), true);
  check('attachment file next to the note', fs.existsSync(path.join(notesDir(home), id, att)) && fs.readFileSync(path.join(notesDir(home), id, att)).equals(PNG_BLUE), true);
  check('shown through media://', await run(s, `document.querySelector('${BODY} img[data-att]').src`), (v) => v.startsWith('media://local/'));
  check('picture loads', await until(() => run(s, `(() => { const i = document.querySelector('${BODY} img[data-att]'); return i.complete && i.naturalWidth; })()`), { label: 'image decode' }), 96);
  // drop of a file from the desktop (DataTransfer with a File)
  const b64b = PNG_ORANGE.toString('base64');
  const target = await rect(s, BODY);
  await run(
    s,
    `(() => {
      const bytes = Uint8Array.from(atob(${JSON.stringify(b64b)}), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], 'dropped.png', { type: 'image/png' }));
      const b = document.querySelector('${BODY}');
      const opts = { dataTransfer: dt, bubbles: true, cancelable: true, clientX: ${Math.round(target.x + target.w - 12)}, clientY: ${Math.round(target.y + 10)} };
      b.dispatchEvent(new DragEvent('dragover', opts));
      b.dispatchEvent(new DragEvent('drop', opts));
    })()`,
  );
  await until(() => run(s, `document.querySelectorAll('${BODY} img[data-att]').length === 2`), { label: 'dropped picture stored' });
  // a File Explorer drag (application/x-aurora-paths)
  const picPath = path.join(home, 'Pictures', 'holiday.png');
  fs.writeFileSync(picPath, PNG_ORANGE);
  fs.writeFileSync(path.join(home, 'Pictures', 'readme.txt'), 'not a picture');
  await run(
    s,
    `(() => {
      const dt = new DataTransfer();
      dt.setData('application/x-aurora-paths', JSON.stringify([${JSON.stringify(picPath)}, ${JSON.stringify(path.join(home, 'Pictures', 'readme.txt'))}]));
      const b = document.querySelector('${BODY}');
      b.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true, clientX: ${Math.round(target.x + target.w - 12)}, clientY: ${Math.round(target.y + 10)} }));
    })()`,
  );
  await until(() => run(s, `document.querySelectorAll('${BODY} img[data-att]').length === 3`), { label: 'explorer drop stored' });
  check('non-picture files are refused with a message', await until(() => run(s, `document.querySelector('${WIN} .nt-toast')?.textContent || ''`), { label: 'toast' }), (v) => v.includes('Only pictures'));
  // pasted HTML with an inline data: picture and an event handler
  await run(
    s,
    `(() => {
      window.__xss = 0;
      const dt = new DataTransfer();
      dt.setData('text/html', '<p>From the web <img src="data:image/png;base64,${b64}" onerror="window.__xss=1"></p><script>window.__xss=1</script>');
      dt.setData('text/plain', 'From the web');
      document.querySelector('${BODY}').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    })()`,
  );
  await until(() => run(s, `document.querySelectorAll('${BODY} img[data-att]').length === 4`), { label: 'pasted HTML picture localized' });
  check('pasted HTML: no script, no handler, nothing ran', await run(s, `[!!document.querySelector('${BODY} script'), !!document.querySelector('${BODY} [onerror]'), window.__xss]`), [false, false, 0]);
  await flush(s);
  const n = await byTitle(s, 'Pictures');
  const files = fs.readdirSync(path.join(notesDir(home), id)).filter((f) => f.startsWith('att-'));
  check('four attachments on disk', files.length, 4);
  check('stored body references attachments by name', (n.html.match(/<img src="att-[^"]+" data-att="att-[^"]+">/g) || []).length, 4);
  check('list thumbnail', await run(s, `!!document.querySelector('${WIN} .nt-item.selected .nt-item-thumb')`), true);
  // deleting a picture + leaving the note removes the orphan file
  await run(s, `document.querySelector('${BODY} img[data-att]').remove()`);
  await N(s, (app) => app.editor.changed());
  await flush(s);
  await N(s, (app, gid) => app.select(gid, { focus: false }), groceriesId);
  await until(() => fs.readdirSync(path.join(notesDir(home), id)).filter((f) => f.startsWith('att-')).length === 3, { label: 'orphan attachment collected' });
  check('orphan attachment collected', true, true);
  await N(s, (app, pid) => app.select(pid, { focus: false }), id);
  // toolbar: Insert picture -> file picker
  await focusBodyEnd(s);
  const pickPath = path.join(home, 'Pictures', 'picked.png');
  fs.writeFileSync(pickPath, PNG_BLUE);
  const imgBtn = `${WIN} .nt-cmd[data-cmd="image"]`;
  if (await run(s, `!!document.querySelector('${imgBtn}')?.offsetParent`)) await s.page.click(imgBtn);
  else N(s, (app) => app.editor.command('image')).catch(() => {});
  await until(() => run(s, `!!document.querySelector('${DLG}.fp-dialog .fp-bottom input')`), { label: 'open picker' });
  await sleep(150);
  await s.page.fill(`${DLG}.fp-dialog .fp-bottom input`, pickPath);
  await s.page.keyboard.press('Enter');
  await until(() => run(s, `document.querySelectorAll('${BODY} img[data-att]').length === 4`), { label: 'picked picture inserted' });
  check('picked picture stored as an attachment', await run(s, `[...document.querySelectorAll('${BODY} img[data-att]')].some((i) => /-picked\\.png$/.test(i.dataset.att))`), true);
  await shot(s, 'pictures-light-en');
});

await section('paste sanitization in the editor (plain text, rich HTML)', async () => {
  await newNote(s, 'Pasted');
  await run(
    s,
    `(() => {
      window.__xss = 0;
      const dt = new DataTransfer();
      dt.setData('text/html', '<meta charset="utf-8"><h4 style="color:red" onclick="window.__xss=1">Title</h4>\\n  <ul>\\n <li><a href="javascript:window.__xss=1">bad</a></li>\\n <li><span style="font-weight:bold">strong</span> item</li></ul><iframe src="https://evil.example"></iframe><img src=x onerror="window.__xss=1">');
      dt.setData('text/plain', 'Title');
      document.querySelector('${BODY}').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    })()`,
  );
  await sleep(300);
  const html = await bodyHtml(s);
  check('pasted rich HTML is clean', html, (h) => h.includes('<h3>Title</h3>') && h.includes('<li>bad</li>') && h.includes('<li><b>strong</b> item</li>') && !/iframe|onclick|style=|javascript|<img/.test(h));
  check('nothing executed', await run(s, `window.__xss`), 0);
  await run(
    s,
    `(() => {
      const dt = new DataTransfer();
      dt.setData('text/plain', 'line A\\nline B\\n<b>not html</b>');
      document.querySelector('${BODY}').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    })()`,
  );
  await sleep(200);
  // the caret was at the end of the pasted list: lines become list items
  check('plain text lines pasted in a list item become items', await bodyHtml(s), (h) => h.includes('<li><b>strong</b> itemline A</li><li>line B</li><li>&lt;b&gt;not html&lt;/b&gt;</li></ul>'));
  check('caret after the pasted text', await run(s, `(() => { const n = getSelection().anchorNode; return (n?.nodeType === 1 ? n : n?.parentElement)?.closest('li')?.textContent; })()`), '<b>not html</b>');
  // leave the list (Enter on an empty item) and paste again on a normal line
  await s.page.keyboard.press('Enter');
  await s.page.keyboard.press('Enter');
  await run(
    s,
    `(() => {
      const dt = new DataTransfer();
      dt.setData('text/plain', 'line A\\nline B\\n<b>not html</b>');
      document.querySelector('${BODY}').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    })()`,
  );
  await sleep(200);
  check('plain text lines become lines, markup stays text', await bodyHtml(s), (h) => h.includes('</ul><div>line A</div><div>line B</div><div>&lt;b&gt;not html&lt;/b&gt;</div>'));
  check('body stays flat (no nested lines)', await run(s, `[...document.querySelector('${BODY}').children].some((c) => c.tagName === 'DIV' && c.querySelector('div, ul, ol, h1, h2, h3, pre, blockquote, table'))`), false);
});

await section('search: full text, accents, #tags, highlights', async () => {
  await s.page.keyboard.press('Control+e');
  check('Ctrl+E focuses search', await run(s, `document.activeElement?.classList.contains('nt-search-input')`), true);
  await s.page.keyboard.type('creme', { delay: 10 });
  await sleep(400);
  check('accent-insensitive full-text match', await run(s, `[...document.querySelectorAll('${WIN} .nt-item .nt-item-title')].map((e) => e.textContent)`), ['Groceries']);
  check('list title is Search results', await run(s, `document.querySelector('${WIN} .nt-list-title').textContent`), 'Search results');
  check('snippet highlights the match', await run(s, `document.querySelector('${WIN} .nt-item mark')?.textContent`), 'crème');
  check('snippet text (no repeated first line)', await run(s, `document.querySelector('${WIN} .nt-item .nt-item-preview').textContent`), 'Milk and eggs Café crème for the morning');
  check('the result opens', await selectedId(s), groceriesId);
  check('editor highlights matches', await run(s, `CSS.highlights.get('nt-match')?.size || 0`), 1);
  await shot(s, 'search-light-en');
  await s.page.fill(`${WIN} .nt-search-input`, '#welcome');
  await sleep(400);
  check('#tag query', await run(s, `[...document.querySelectorAll('${WIN} .nt-item .nt-item-title')].map((e) => e.textContent)`), ['Welcome to Notes']);
  await s.page.fill(`${WIN} .nt-search-input`, 'zzzz-nothing');
  await sleep(400);
  check('no results state', await run(s, `!document.querySelector('${WIN} .nt-list-empty').hidden && document.querySelector('${WIN} .nt-list-empty').textContent`), (v) => typeof v === 'string' && v.includes('No notes found'));
  await s.page.focus(`${WIN} .nt-search-input`);
  await s.page.keyboard.press('Escape');
  await sleep(250);
  check('Esc clears the search', await run(s, `[document.querySelector('${WIN} .nt-search-input').value, document.querySelector('${WIN} .nt-list-title').textContent]`), ['', 'All notes']);
  // tag view in the navigation
  await s.page.click(`${WIN} .nt-nav-item[data-key="tag:tips"]`);
  await sleep(200);
  check('tag view lists tagged notes', await run(s, `[...document.querySelectorAll('${WIN} .nt-item .nt-item-title')].map((e) => e.textContent)`), ['Welcome to Notes']);
  await s.page.click(`${WIN} .nt-nav-item[data-key="all"]`);
});

await section('find in note (Ctrl+F)', async () => {
  await N(s, (app) => {
    const id = app.store.all().find((n) => n.title === 'Welcome to Notes').id;
    return app.select(id, { focus: true });
  });
  await sleep(200);
  await s.page.keyboard.press('Control+f');
  await until(() => run(s, `!document.querySelector('${WIN} .nt-find').hidden`), { label: 'find bar' });
  await s.page.keyboard.type('note');
  await sleep(250);
  const count = await run(s, `document.querySelector('${WIN} .nt-find-count').textContent`);
  check('find count', count, (v) => /^1 of \d+$/.test(v) && Number(v.split(' of ')[1]) >= 3);
  await s.page.keyboard.press('Enter');
  check('Enter goes to the next match', await run(s, `document.querySelector('${WIN} .nt-find-count').textContent`), (v) => v.startsWith('2 of'));
  check('current match highlighted', await run(s, `CSS.highlights.get('nt-match-current')?.size || 0`), 1);
  await shot(s, 'find-light-en');
  await s.page.keyboard.press('Escape');
  check('Esc closes the find bar', await run(s, `document.querySelector('${WIN} .nt-find').hidden`), true);
});

await section('pin + sort', async () => {
  await N(s, (app, id) => app.select(id, { focus: false }), groceriesId);
  await s.page.focus(`${WIN} .nt-item.selected`);
  await s.page.keyboard.press('Control+p');
  await sleep(300);
  check('Ctrl+P pins', (await notes(s)).find((n) => n.id === groceriesId).pinned, true);
  check('pinned group on top', await run(s, `(() => { const kids = [...document.querySelector('${WIN} .nt-list').children]; return kids[0].textContent + '|' + kids.slice(1, 3).map((e) => e.querySelector?.('.nt-item-title')?.textContent).join(','); })()`), (v) => v.startsWith('Pinned|') && v.includes('Groceries') && v.includes('Welcome to Notes'));
  check('pin icon in the list', await run(s, `!!document.querySelector('${WIN} .nt-item[data-id="${groceriesId}"] .nt-item-pin')`), true);
  check('Pinned view', await N(s, (app) => app.store.counts().pinned), 2);
  await s.page.click(`${WIN} .nt-listpane .btn[aria-haspopup="menu"][aria-label="Sort by"]`);
  await menuClick(s, 'Title');
  const titles = await run(s, `[...document.querySelectorAll('${WIN} .nt-item .nt-item-title')].map((e) => e.textContent)`);
  check('sort by title', titles, [...titles].sort((a, b) => a.localeCompare(b)));
  check('no date groups when sorted by title', await run(s, `document.querySelectorAll('${WIN} .nt-group-head').length`), 0);
  await s.page.click(`${WIN} .nt-listpane .btn[aria-label="Sort by"]`);
  await menuClick(s, 'Date created');
  const created = await N(s, (app) => app.visibleNotes().filter((n) => !n.pinned).map((n) => n.created));
  check('sort by date created (newest first)', created, [...created].sort((a, b) => b - a));
  await s.page.click(`${WIN} .nt-listpane .btn[aria-label="Sort by"]`);
  await menuClick(s, 'Date modified');
  await s.page.keyboard.press('Control+p');
  await sleep(200);
  check('Ctrl+P again unpins', (await notes(s)).find((n) => n.id === groceriesId).pinned, false);
  check('sort saved', await N(s, async (app) => (await app.ctx.storage.get('prefs', {})).sort), 'modified');
});

await section('delete, undo, restore, purge, 30-day auto purge', async () => {
  const pasted = await byTitle(s, 'Pasted');
  await N(s, (app, id) => app.select(id, { focus: false }), pasted.id);
  await s.page.focus(`${WIN} .nt-item.selected`);
  await s.page.keyboard.press('Delete');
  await sleep(300);
  check('Delete moves to Recently deleted', !!(await byTitle(s, 'Pasted')).deletedAt, true);
  check('next note selected', await selectedId(s), (v) => v && v !== pasted.id);
  check('undo toast', await run(s, `document.querySelector('${WIN} .nt-toast')?.textContent || ''`), (v) => v.includes('Recently deleted') && v.includes('Undo'));
  await s.page.click(`${WIN} .nt-toast-action`);
  await sleep(300);
  check('Undo restores', (await byTitle(s, 'Pasted')).deletedAt, null);
  // delete again from the note menu, then restore from the Recently deleted view
  await N(s, (app, id) => app.deleteNotes([id]), pasted.id);
  await s.page.click(`${WIN} .nt-nav-item[data-key="deleted"]`);
  await sleep(250);
  check('Recently deleted lists it with days left', await run(s, `[...document.querySelectorAll('${WIN} .nt-item')].map((e) => e.querySelector('.nt-item-title').textContent + ' / ' + e.querySelector('.nt-item-days')?.textContent)`), ['Pasted / 30 days left']);
  await s.page.click(`${WIN} .nt-item`);
  await sleep(250);
  check('deleted note is read-only with a banner', await run(s, `[document.querySelector('${BODY}').contentEditable, !document.querySelector('${WIN} .nt-deleted-bar').hidden]`), ['false', true]);
  await shot(s, 'deleted-light-en');
  await s.page.click(`${WIN} .nt-deleted-bar .btn:not(.nt-danger-text)`);
  await sleep(300);
  check('banner Restore', (await byTitle(s, 'Pasted')).deletedAt, null);
  // purge for good (confirm)
  await N(s, (app, id) => app.deleteNotes([id]), pasted.id);
  await N(s, (app, id) => app.select(id, { focus: false }), pasted.id);
  await s.page.focus(`${WIN} .nt-item.selected`);
  await s.page.keyboard.press('Delete');
  await dialogButton(s, 'Delete');
  await until(async () => !(await byTitle(s, 'Pasted')), { label: 'purged' });
  check('purged note folder removed', fs.existsSync(path.join(notesDir(home), pasted.id)), false);
  // auto purge after 30 days
  const fmt = await byTitle(s, 'Formatting');
  await N(s, (app, id) => app.store.setMeta(id, { deletedAt: Date.now() - 31 * 86400000 }), fmt.id);
  const purged = await N(s, (app) => app.store.purgeExpired());
  check('expired notes purged', purged, 1);
  check('expired folder removed', fs.existsSync(path.join(notesDir(home), fmt.id)), false);
  await s.page.click(`${WIN} .nt-nav-item[data-key="all"]`);
});

let workId = null;
await section('notebooks: create, rename, colour, emoji, move (menu + drag), delete', async () => {
  await s.page.keyboard.press('Control+Shift+N');
  await until(() => dialogOpen(s), { label: 'notebook dialog' });
  await sleep(100);
  await s.page.keyboard.press('Enter');
  check('empty name refused', await run(s, `document.querySelector('${DLG} .nt-field-error').textContent`), 'Enter a name for the notebook.');
  await s.page.fill(`${DLG} input`, 'My notes');
  await s.page.keyboard.press('Enter');
  check('duplicate name refused', await run(s, `document.querySelector('${DLG} .nt-field-error').textContent`), (v) => v.includes('already'));
  await s.page.fill(`${DLG} input`, 'Work');
  check('error cleared while typing', await run(s, `[document.querySelector('${DLG} .nt-field-error').textContent, document.querySelector('${DLG} input').classList.contains('invalid')]`), ['', false]);
  await s.page.click(`${DLG} .nt-color-dot[data-color="green"]`);
  await s.page.click(`${DLG} .nt-emoji-btn[data-emoji="💼"]`);
  await shot(s, 'notebook-dialog');
  await dialogButton(s, 'Create');
  const nb = await N(s, (app) => app.store.notebooks.find((b) => b.name === 'Work'));
  workId = nb?.id;
  check('notebook created with colour + emoji', nb && [nb.color, nb.emoji], ['green', '💼']);
  check('new notebook view selected', await run(s, `document.querySelector('${WIN} .nt-list-title').textContent`), 'Work');
  // a note created here belongs to it
  await newNote(s, 'Meeting notes');
  await s.page.keyboard.type('Agenda #work', { delay: 5 });
  await flush(s);
  check('new note in the current notebook', (await byTitle(s, 'Meeting notes')).notebookId, workId);
  // rename via the context menu
  await s.page.click(`${WIN} .nt-nav-item[data-key="nb:${workId}"]`, { button: 'right' });
  await menuClick(s, 'Rename, colour and icon');
  await until(() => dialogOpen(s), { label: 'edit dialog' });
  await s.page.fill(`${DLG} input`, 'Work stuff');
  await dialogButton(s, 'Save');
  check('renamed', await N(s, (app, id) => app.store.notebook(id).name, workId), 'Work stuff');
  check('index updated on disk', await until(async () => {
    await flush(s);
    return JSON.parse(fs.readFileSync(path.join(notesDir(home), 'notes.json'), 'utf8')).notebooks.some((b) => b.name === 'Work stuff');
  }, { label: 'index' }), true);
  // move Groceries via drag & drop onto the notebook
  await s.page.click(`${WIN} .nt-nav-item[data-key="all"]`);
  await sleep(200);
  await s.page.dragAndDrop(`${WIN} .nt-item[data-id="${groceriesId}"]`, `${WIN} .nt-nav-item[data-key="nb:${workId}"]`);
  await sleep(400);
  check('drag & drop moves the note', (await notes(s)).find((n) => n.id === groceriesId).notebookId, workId);
  check('move toast', await run(s, `document.querySelector('${WIN} .nt-toast')?.textContent || ''`), (v) => v.includes('Work stuff'));
  // move back with the menu
  await N(s, (app, id) => app.select(id, { focus: false }), groceriesId);
  await s.page.click(`${WIN} .nt-meta .nt-nb-chip`);
  await menuClick(s, 'My notes');
  check('menu move', (await notes(s)).find((n) => n.id === groceriesId).notebookId, await N(s, (app) => app.store.notebooks[0].id));
  // delete the notebook: its notes go to Recently deleted
  await s.page.click(`${WIN} .nt-nav-item[data-key="nb:${workId}"]`, { button: 'right' });
  await menuClick(s, 'Delete notebook');
  check('confirmation names the notebook', await run(s, `document.querySelector('${DLG}').textContent`), (v) => v.includes('Work stuff') && v.includes('Recently deleted'));
  await dialogButton(s, 'Delete');
  await sleep(300);
  check('notebook removed', await N(s, (app, id) => !!app.store.notebook(id), workId), false);
  check('its note is in Recently deleted', !!(await byTitle(s, 'Meeting notes')).deletedAt, true);
  check('view back to All notes', await run(s, `document.querySelector('${WIN} .nt-list-title').textContent`), 'All notes');
  await N(s, async (app) => {
    const id = app.store.all().find((n) => n.title === 'Meeting notes').id;
    await app.restoreNotes([id], { reveal: false });
  });
  check('restored note lands in an existing notebook', await N(s, (app) => {
    const n = app.store.all().find((x) => x.title === 'Meeting notes');
    return !!app.store.notebook(n.notebookId);
  }), true);
  check('last notebook cannot be deleted', await N(s, async (app) => {
    try {
      await app.store.removeNotebook(app.store.notebooks[0].id);
      return app.store.notebooks.length > 0 ? 'kept' : 'deleted';
    } catch {
      return 'refused';
    }
  }), (v) => v === 'refused' || v === 'kept');
});

await section('export (.md + pictures, .txt, .html) and import roundtrip', async () => {
  const pics = await byTitle(s, 'Pictures');
  await N(s, (app, id) => app.select(id, { focus: false }), pics.id);
  const out = path.join(home, 'Documents', 'Pictures note.md');
  await s.page.click(`${WIN} .nt-cmd-right .btn[aria-label="Note actions"]`);
  await menuClick(s, 'Export');
  await menuClick(s, 'Markdown');
  await until(() => run(s, `!!document.querySelector('${DLG}.fp-dialog .fp-bottom input')`), { label: 'save picker' });
  check('suggested file name from the title', await run(s, `document.querySelector('${DLG}.fp-dialog .fp-bottom input').value`), 'Pictures.md');
  await s.page.fill(`${DLG}.fp-dialog .fp-bottom input`, out);
  await s.page.keyboard.press('Enter');
  await until(() => fs.existsSync(out), { label: 'exported md' });
  await sleep(300);
  const md = fs.readFileSync(out, 'utf8');
  check('md: title + text', md.slice(0, 30), '# Pictures\n\nHere is a picture:');
  const refs = [...md.matchAll(/!\[\]\((Pictures%20note_files\/att-[^)]+)\)/g)].map((m) => decodeURI(m[1]));
  check('md: pictures referenced in a _files folder', refs.length, 4);
  check('md: pictures copied', refs.every((r) => fs.existsSync(path.join(home, 'Documents', r))), true);
  // txt and html through the export API (same picker flow)
  const exportVia = async (fmt, file) => {
    const p = N(s, (app, a) => {
      const n = app.store.all().find((x) => x.title === a.title);
      return import('app://shell/apps/notes/ui/dialogs.js').then((d) => d.exportNote(app, n, a.fmt));
    }, { title: 'Shortcuts', fmt });
    p.catch(() => {}); // reported when awaited below
    await until(() => run(s, `!!document.querySelector('${DLG}.fp-dialog .fp-bottom input')`), { label: 'picker' });
    await sleep(150);
    await s.page.fill(`${DLG}.fp-dialog .fp-bottom input`, file);
    await s.page.keyboard.press('Enter');
    return p;
  };
  const txt = path.join(home, 'Documents', 'shortcuts.txt');
  await exportVia('txt', txt);
  const tt = fs.readFileSync(txt, 'utf8');
  check('txt export', tt.startsWith('Shortcuts\n\nHeading one') && tt.includes('• apple') && tt.includes('☑ task two') === false && tt.includes('☐ task two'), true);
  const htmlOut = path.join(home, 'Documents', 'shortcuts.html');
  await exportVia('html', htmlOut);
  const ht = fs.readFileSync(htmlOut, 'utf8');
  check('html export is a standalone page', ht.startsWith('<!doctype html>') && ht.includes('<title>Shortcuts</title>') && ht.includes('<h1>Heading one</h1>') && !ht.includes('<script'), true);
  // import the Markdown back
  const before = (await notes(s)).length;
  const ids = await N(s, (app, p) => import('app://shell/apps/notes/ui/dialogs.js').then((d) => d.importFiles(app, [p])), out);
  check('one note imported', ids.length, 1);
  const imported = (await notes(s)).find((n) => n.id === ids[0]);
  check('imported title from # heading', imported?.title, 'Pictures');
  check('imported text', imported?.text.slice(0, 18), 'Here is a picture:');
  check('imported pictures copied into the note', fs.readdirSync(path.join(notesDir(home), ids[0])).filter((f) => f.startsWith('att-')).length, 4);
  check('note count +1', (await notes(s)).length, before + 1);
  // Markdown file from elsewhere (with a task list, table and a relative picture)
  const mdDir = path.join(home, 'Downloads', 'trip');
  fs.mkdirSync(path.join(mdDir, 'img'), { recursive: true });
  fs.writeFileSync(path.join(mdDir, 'img', 'map.png'), PNG_BLUE);
  fs.writeFileSync(path.join(mdDir, 'Trip plan.md'), '# Trip to Lyon\n\n- [x] Book train\n- [ ] Pack\n\n| Day | Plan |\n|---|---|\n| Sat | Museum |\n\n![map](img/map.png)\n\n<script>alert(1)</script>\n');
  fs.writeFileSync(path.join(mdDir, 'todo.txt'), 'First line\n\nThird <line>');
  const ids2 = await N(s, (app, ps) => import('app://shell/apps/notes/ui/dialogs.js').then((d) => d.importFiles(app, ps)), [path.join(mdDir, 'Trip plan.md'), path.join(mdDir, 'todo.txt')]);
  const trip = (await notes(s)).find((n) => n.id === ids2[0]);
  check('md import: checklist + table + picture', trip && [trip.title, trip.html.includes('<ul data-type="checklist"><li data-checked="true">Book train</li>'), trip.html.includes('<th>Day</th>'), /<img src="att-[a-z0-9]{8}-map\.png"/.test(trip.html), /<script/i.test(trip.html)], ['Trip to Lyon', true, true, true, false]);
  const txtNote = (await notes(s)).find((n) => n.id === ids2[1]);
  check('txt import keeps lines and escapes markup', txtNote && [txtNote.title, txtNote.text], ['todo', 'First line\n\nThird <line>']);
});

await section('open a .md file with Notes (single instance relaunch)', async () => {
  const file = path.join(home, 'Downloads', 'Ideas.md');
  fs.writeFileSync(file, '# Ideas for the weekend\n\n- [ ] Hike\n- [x] Call Sam\n');
  const before = (await notes(s)).length;
  await run(s, `window.__aurora.registry.launch('notes', { file: ${JSON.stringify(file)} })`);
  const id = await until(async () => {
    const n = (await notes(s)).find((x) => x.title === 'Ideas for the weekend');
    return n && n.id;
  }, { label: 'imported from launch args' });
  check('one window only', await run(s, `window.__aurora.wm.list().filter((w) => w.appId === 'notes').length`), 1);
  check('imported note opened', await until(async () => (await selectedId(s)) === id && id, { label: 'imported note selected' }).catch(() => selectedId(s)), id);
  check('note count +1', (await notes(s)).length, before + 1);
  check('checklist kept', (await notes(s)).find((x) => x.id === id).html, '<ul data-type="checklist"><li data-checked="false">Hike</li><li data-checked="true">Call Sam</li></ul>');
  check('Notes offered for .md (Notepad stays the default)', await run(s, `[window.__aurora.registry.get('notes').fileTypes.includes('.md'), window.__aurora.registry.handlerFor('/x/a.md')]`), [true, 'notepad']);
});

await section('share by Mail', async () => {
  await N(s, (app, id) => app.select(id, { focus: false }), groceriesId);
  await N(s, (app) => {
    window.__launched = null;
    app.__launch = app.ctx.shell.launch;
    app.ctx.shell.launch = (id, args) => {
      window.__launched = { id, args };
    };
  });
  await s.page.click(`${WIN} .nt-cmd-right .btn[aria-label="Note actions"]`);
  await menuClick(s, 'Send by e-mail');
  await sleep(200);
  check('Mail launched with subject + body', await run(s, `window.__launched`), { id: 'mail', args: { subject: 'Groceries', body: 'Milk and eggs\nCafé crème for the morning' } });
  await N(s, (app) => {
    app.ctx.shell.launch = app.__launch;
  });
});

await section('keyboard: list navigation, F2, duplicate', async () => {
  await s.page.click(`${WIN} .nt-item`);
  await s.page.focus(`${WIN} .nt-item.selected`);
  const first = await selectedId(s);
  await s.page.keyboard.press('ArrowDown');
  await sleep(150);
  const second = await selectedId(s);
  check('ArrowDown selects the next note', second !== first && !!second, true);
  check('focus stays in the list', await run(s, `!!document.activeElement?.closest('.nt-list')`), true);
  await s.page.keyboard.press('ArrowUp');
  await sleep(150);
  check('ArrowUp back', await selectedId(s), first);
  await s.page.keyboard.press('Enter');
  await sleep(150);
  check('Enter opens the note for editing', await run(s, `!!document.activeElement?.closest('.nt-editor')`), true);
  const g = await byTitle(s, 'Groceries');
  await N(s, (app, id) => app.duplicate(id), g.id);
  await sleep(300);
  const dup = await byTitle(s, 'Groceries (copy)');
  check('duplicate', dup && dup.text, g.text);
  check('duplicate opened', await selectedId(s), dup?.id);
});

await section('save failure: error state, background retry, Retry button, close prompt', async () => {
  const k = s.page.keyboard;
  const state = () => run(s, `document.querySelector('${WIN} .nt-saved').dataset.state`);
  await newNote(s, 'Fragile');
  await k.type('first text', { delay: 5 });
  await until(async () => (await state()) === 'saved', { label: 'saved' });
  const id = await selectedId(s);
  const dir = path.join(notesDir(home), id);
  const file = path.join(dir, 'note.html');
  // running as root, permissions can't make a write fail: replace the note folder with a file (ENOTDIR)
  const breakIt = () => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.writeFileSync(dir, 'not a folder');
  };
  const fixIt = () => fs.rmSync(dir, { force: true });
  breakIt();
  await k.type(' more', { delay: 5 });
  await until(async () => (await state()) === 'error', { label: 'error state' });
  check('error shown in the status bar', await run(s, `document.querySelector('${WIN} .nt-saved').textContent`), 'Not saved — retry');
  await until(() => dialogOpen(s), { label: 'error dialog' });
  check('one error dialog', await run(s, `document.querySelectorAll('${DLG}').length`), 1);
  await dialogButton(s, 'OK');
  fixIt();
  await until(async () => (await state()) === 'saved', { timeout: 8000, label: 'background retry' });
  check('the background retry wrote the note', fs.readFileSync(file, 'utf8').includes('first text more'), true);
  // second failure: the Retry button
  breakIt();
  await N(s, (app) => app.editor.focusBody());
  await k.press('End');
  await k.type(' again', { delay: 5 });
  await until(async () => (await state()) === 'error', { label: 'error state 2' });
  await until(() => dialogOpen(s), { label: 'error dialog 2' });
  await dialogButton(s, 'OK');
  fixIt();
  await s.page.click(`${WIN} .nt-retry`);
  await until(async () => (await state()) === 'saved', { label: 'retry button' });
  check('Retry wrote the note', fs.readFileSync(file, 'utf8').includes('first text more again'), true);
  // closing while a write fails asks before losing anything
  breakIt();
  await N(s, (app) => app.editor.focusBody());
  await k.type('!', { delay: 5 });
  await until(async () => (await state()) === 'error', { label: 'error state 3' });
  await until(() => dialogOpen(s), { label: 'error dialog 3' });
  await dialogButton(s, 'OK');
  N(s, (app) => app.win.close()).catch(() => {});
  await until(() => run(s, `document.querySelector('${DLG} .dialog-footer')?.textContent || ''`), { label: 'close prompt' });
  check('close prompt', await run(s, `document.querySelector('${DLG}').innerText`), (v) => v.includes("couldn't be saved") && v.includes('Close anyway'));
  await dialogButton(s, 'Cancel');
  check('window stays open', await run(s, `!!document.querySelector('${WIN}')`), true);
  fixIt();
  await s.page.click(`${WIN} .nt-retry`);
  await until(async () => (await state()) === 'saved', { label: 'saved again' });
  check('nothing lost', fs.readFileSync(file, 'utf8').includes('first text more again!'), true);
});

await section('persistence across restart + recovery from a lost index', async () => {
  await flush(s);
  const before = (await notes(s)).map((n) => [n.id, n.title, n.text, !!n.deletedAt, n.pinned]).sort();
  await s.close();
  s = await launchShell({ open: ['notes'], home, lang: 'en', theme: 'light' });
  setRecover(s);
  await until(() => run(s, `!!document.querySelector('${WIN} .nt-item')`), { timeout: 20000, label: 'notes after restart' });
  await sleep(400);
  const after = (await notes(s)).map((n) => [n.id, n.title, n.text, !!n.deletedAt, n.pinned]).sort();
  check('everything back after a restart', after, before);
  check('no second welcome note', (await notes(s)).filter((n) => n.title === 'Welcome to Notes').length, 1);
  // simulate a crash that corrupted the index: notes are rebuilt from the note files
  await s.close();
  fs.writeFileSync(path.join(notesDir(home), 'notes.json'), '{ broken');
  fs.rmSync(path.join(notesDir(home), 'notes.json.bak'), { force: true });
  fs.writeFileSync(path.join(notesDir(home), '.notes.json.123.abcd.tmp'), 'partial');
  s = await launchShell({ open: ['notes'], home, lang: 'en', theme: 'light' });
  setRecover(s);
  await until(() => run(s, `!!document.querySelector('${WIN} .nt-item')`), { timeout: 20000, label: 'notes after index loss' });
  await sleep(400);
  const rebuilt = (await notes(s)).map((n) => [n.id, n.title, n.text, !!n.deletedAt, n.pinned]).sort();
  check('notes rebuilt from the note files', rebuilt, before);
  check('notebooks rebuilt', await N(s, (app) => app.store.notebooks.map((b) => b.name).sort()), ['My notes']);
  await flush(s);
  check('index rewritten', JSON.parse(fs.readFileSync(path.join(notesDir(home), 'notes.json'), 'utf8')).version, 1);
});

await section('layouts: medium (overlay nav), narrow (one pane), min size, maximized', async () => {
  mark = s.logs.length;
  await setWinSize(s, 860, 640);
  check('medium layout', await run(s, `document.querySelector('${WIN} .nt-root').dataset.layout`), 'medium');
  check('nav hidden', await run(s, `getComputedStyle(document.querySelector('${WIN} .nt-nav')).visibility`), 'hidden');
  await s.page.click(`${WIN} .nt-nav-toggle`);
  await sleep(400);
  check('nav opens as an overlay', await run(s, `[document.querySelector('${WIN} .nt-root').classList.contains('nav-open'), getComputedStyle(document.querySelector('${WIN} .nt-nav')).visibility]`), [true, 'visible']);
  await shot(s, 'medium-nav-open');
  await s.page.keyboard.press('Escape');
  await sleep(300);
  check('Esc closes the overlay', await run(s, `document.querySelector('${WIN} .nt-root').classList.contains('nav-open')`), false);
  await setWinSize(s, 480, 400);
  check('narrow layout at the minimum size', await run(s, `document.querySelector('${WIN} .nt-root').dataset.layout`), 'narrow');
  await s.page.click(`${WIN} .nt-item`);
  await sleep(400);
  check('narrow: the editor replaces the list', await run(s, `[getComputedStyle(document.querySelector('${WIN} .nt-listpane')).display, getComputedStyle(document.querySelector('${WIN} .nt-editor')).display]`), ['none', 'flex']);
  check('narrow: toolbar fits (overflow menu)', await run(s, `(() => { const g = document.querySelector('${WIN} .nt-groups'); return g.scrollWidth <= g.clientWidth + 1 && !document.querySelector('${WIN} .nt-overflow').hidden; })()`), true);
  await shot(s, 'min-size-editor');
  await s.page.click(`${WIN} .nt-back`);
  await sleep(300);
  check('Back returns to the list', await run(s, `getComputedStyle(document.querySelector('${WIN} .nt-listpane')).display`), 'flex');
  await shot(s, 'min-size-list');
  await N(s, (app) => app.win.maximize());
  await sleep(500);
  check('maximized: three panes', await run(s, `document.querySelector('${WIN} .nt-root').dataset.layout`), 'wide');
  check('maximized: full toolbar', await run(s, `document.querySelector('${WIN} .nt-overflow').hidden`), true);
  await N(s, (app) => app.select(app.store.all().find((n) => n.title === 'Welcome to Notes').id, { focus: false }));
  await shot(s, 'maximized-light-en', { clip: false });
  await N(s, (app) => app.win.restore());
  await sleep(400);
  check('no console errors', errorsSince(s, mark), []);
});
await s.close();
fs.rmSync(home, { recursive: true, force: true });

// ================================================================= session 2: French, dark
if (!only || 'french dark fr'.includes(only) || only.includes('fr')) {
  console.log('Notes — French / dark');
  s = await launchShell({ open: ['notes'], lang: 'fr', theme: 'dark' });
  setRecover(s);
  await until(() => run(s, `!!document.querySelector('${WIN} .nt-item')`), { timeout: 20000, label: 'notes list (fr)' });
  await sleep(500);
  await section('French: welcome note, strings, dark theme', async () => {
    mark = 0;
    const all = await notes(s);
    check('bienvenue', all.map((n) => n.title), ['Bienvenue dans Notes']);
    check('carnet par défaut', await N(s, (app) => app.store.notebooks.map((b) => b.name)), ['Mes notes']);
    check('étiquettes', all[0].tags, ['astuces', 'bienvenue']);
    check('libellés FR', await run(s, `[document.querySelector('${WIN} .nt-new').textContent, document.querySelector('${WIN} .nt-list-title').textContent, document.querySelector('${WIN} .nt-search-input').placeholder]`), ['Nouvelle note', 'Toutes les notes', 'Rechercher dans toutes les notes']);
    check('compteur FR', await run(s, `document.querySelector('${WIN} .nt-count').textContent`), (v) => /mots · \d+ caractères$/.test(v));
    // no English left in the visible chrome
    const english = await run(s, `[...document.querySelectorAll('${WIN} .nt-nav, ${WIN} .nt-listpane, ${WIN} .nt-status, ${WIN} .nt-cmdbar')].map((e) => e.innerText).join(' ')`);
    check('no English strings', english, (v) => !/\b(All notes|Pinned|Recently deleted|Notebooks|Tags|words|characters|Import notes)\b/.test(v));
    check('dark theme', await run(s, `document.documentElement.dataset.theme`), 'dark');
    await shot(s, 'welcome-dark-fr');
    await newNote(s, 'Courses');
    await typeLines(s, ['[] lait', 'pain', '', 'Un *très* bon **fromage**']);
    await sleep(800);
    await N(s, (app) => app.editor.run(() => {
      const b = app.editor.body;
      const r = document.createRange();
      r.selectNodeContents(b.lastElementChild);
      getSelection().removeAllRanges();
      getSelection().addRange(r);
      app.editor.applyColor('hl', 'pink');
    }));
    await flush(s);
    check('saved (FR)', await run(s, `document.querySelector('${WIN} .nt-saved').textContent`), 'Enregistrée');
    await shot(s, 'editor-dark-fr');
    await s.page.keyboard.press('F1');
    await until(() => dialogOpen(s), { label: 'shortcuts (fr)' });
    check('French key names', await run(s, `[...document.querySelectorAll('${DLG} kbd')].map((k) => k.textContent)`), (v) => v.includes('Ctrl+Maj+N') && v.includes('Suppr') && !v.some((x) => /Shift|Delete/.test(x)));
    check('French key names in tooltips', await run(s, `document.querySelector('${WIN} .nt-nav-add').dataset.tip`), 'Nouveau carnet (Ctrl+Maj+N)');
    await dialogButton(s, 'Fermer');
    await s.page.keyboard.press('Control+Shift+N');
    await until(() => dialogOpen(s), { label: 'dialog (fr)' });
    check('dialog FR', await run(s, `document.querySelector('${DLG} .dialog-title').textContent`), 'Nouveau carnet');
    await s.page.fill(`${DLG} input`, 'Recettes de cuisine');
    await s.page.click(`${DLG} .nt-color-dot[data-color="orange"]`);
    await shot(s, 'notebook-dialog-dark-fr');
    await dialogButton(s, 'Créer');
    await N(s, (app) => app.deleteNotes([app.store.all().find((n) => n.title === 'Courses').id]));
    check('toast FR', await run(s, `document.querySelector('${WIN} .nt-toast')?.textContent || ''`), (v) => v.includes('Supprimées récemment'));
    await s.page.click(`${WIN} .nt-nav-item[data-key="deleted"]`);
    await sleep(300);
    await s.page.click(`${WIN} .nt-item`);
    await sleep(300);
    check('bannière FR', await run(s, `document.querySelector('${WIN} .nt-deleted-bar').innerText`), (v) => v.includes('Restaurez-la pour la modifier') && v.includes('30 jours'));
    await shot(s, 'deleted-dark-fr');
    await setWinSize(s, 480, 400);
    await N(s, (app) => app.toast('Note déplacée dans Supprimées récemment', { action: 'Annuler', onAction: () => {} }));
    await shot(s, 'min-size-dark-fr');
    check('toast text on one line at the minimum size', await run(s, `document.querySelector('${WIN} .nt-toast').getBoundingClientRect().height`), (v) => v < 60);
    check('short search placeholder when narrow', await run(s, `document.querySelector('${WIN} .nt-search-input').placeholder`), 'Rechercher');
    check('narrow FR: nothing overflows the list header', await run(s, `(() => { const h = document.querySelector('${WIN} .nt-list-head'); return h.scrollWidth <= h.clientWidth + 1; })()`), true);
    await N(s, (app) => app.win.maximize());
    await sleep(400);
    await s.page.click(`${WIN} .nt-nav-item[data-key="all"]`);
    await sleep(300);
    await shot(s, 'maximized-dark-fr', { clip: false });
    check('no console errors (fr)', errorsSince(s, 0), []);
  });
  await s.close();
}

console.log(`\n${passed} checks passed, ${failures.length} failed`);
if (failures.length) {
  console.log(`\nFailures:\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
process.exit(0);
