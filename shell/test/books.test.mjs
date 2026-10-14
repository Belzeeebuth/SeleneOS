// Livres (Books, EPUB reader) tests: the backend directly (ZIP reader, EPUB parsing, limits) and the app in the
// real Electron shell, on EPUB fixtures written by test/fixtures/books/make-fixtures.mjs (no external tool).
//   Backend: metadata / spine / nested TOC of an EPUB 3 (nav) and an EPUB 2 (NCX), cover, de-obfuscated font,
//   path traversal names, damaged ZIP / not a ZIP / DRM / damaged entry, 500 MB and inflated-size caps (a ZIP
//   bomb), folder scan limited to $HOME and to the depth.
//   App (en, light): library (folder scan of Documents / Downloads, covers, sort, search, « Add books » picker,
//   drag and drop from Files), open from Files (defaultFor .epub), pagination (keys, click zones, wheel, two
//   pages side by side, resize), table of contents jumps, text size / font / line spacing / alignment / margins,
//   themes Light / Sepia / Dark / automatic, bookmarks, search (accent- and case-insensitive, highlight), notes
//   in a popover, cross-chapter link + back, external link -> Navigateur, hostile chapter neutralised (no script
//   ran, no network request: local HTTP server + session webRequest log), embedded obfuscated font, scroll mode,
//   position restored after reopening, full screen, DRM / damaged books, remove from the library, move a file
//   to the trash, console errors.
//   App (fr, dark, same home): settings and position kept across a restart, French strings, screenshots.
// Usage:  cd aurora-os/shell && xvfb-run -a -s "-screen 0 1600x900x24" node test/books.test.mjs [--only=hostile]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { launchShell, ROOT } from './lib.mjs';
import { writeBookFixtures, zip } from './fixtures/books/make-fixtures.mjs';

const require = createRequire(import.meta.url);
const only = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7).toLowerCase();

let passed = 0;
const failures = [];
function check(name, actual, expected) {
  const ok = typeof expected === 'function' ? !!expected(actual) : Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++;
  else failures.push(`${name}\n      expected: ${typeof expected === 'function' ? '(predicate)' : JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
  return ok;
}
let traceLogs = null;
async function section(name, fn) {
  if (only && !only.split('|').some((o) => name.toLowerCase().includes(o))) return;
  const t0 = Date.now();
  const before = failures.length;
  try {
    await fn();
    console.log(`  ${failures.length === before ? '✓' : '✗'} ${name} (${Date.now() - t0} ms)`);
  } catch (err) {
    failures.push(`${name}: threw ${err?.stack || err}`);
    if (process.env.BOOKS_TRACE && traceLogs) console.log(traceLogs().filter((l) => /TRACE/.test(l)).join('\n'));
    console.log(`  ✗ ${name}: ${err?.message || err}`);
  }
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
  throw new Error(`timed out waiting for ${label} (last: ${JSON.stringify(last)})`);
}

// ================================================================== backend (no Electron)
async function runBackend() {
  console.log('Livres — backend');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'books-backend-'));
  const savedHome = process.env.HOME;
  process.env.HOME = tmp; // the folder scan only looks inside $HOME
  const reg = require(path.join(ROOT, 'main', 'ipc', 'books.js'));
  const H = {};
  reg({ handle: (c, f) => (H[c] = f), error: (m, c) => Object.assign(new Error(m), { code: c }) });
  const f = writeBookFixtures(path.join(tmp, 'Documents'), { port: 9 });
  const code = (p) => p.then(() => 'ok', (e) => e.code);
  const flat = (items) => items.map((t) => (t.children.length ? [t.label, flat(t.children)] : t.label));

  await section('backend: EPUB 3 (nav, cover, metadata)', async () => {
    check('channels', Object.keys(H).sort(), ['books:meta', 'books:open', 'books:resource', 'books:scan']);
    const b = await H['books:open'](f.voyage);
    check('title', b.title, 'Le Voyage de Sélène');
    check('authors: only the author (not the illustrator)', b.authors, ['Jeanne Martin']);
    check('author sort key (refines file-as)', b.authorSort, 'Martin, Jeanne');
    check('language', b.language, 'fr');
    check('series', [b.series, b.seriesIndex], ['Les Récits de la Lune', 2]);
    check('description without markup', b.description, 'Un voyage au long cours vers les îles.');
    check('cover (properties="cover-image")', b.cover, 'OEBPS/images/cover.png');
    check('spine in reading order', b.spine.map((s) => s.href.split('/').pop()), ['cover.xhtml', 'ch1.xhtml', 'ch2.xhtml', 'ch3.xhtml', 'ch4.xhtml', 'notes.xhtml', 'hostile.xhtml']);
    check('spine sizes (progress weights)', b.spine.every((s) => s.size > 100), true);
    check('nested table of contents (nav toc, not landmarks)', flat(b.toc), [
      'Couverture',
      ['Première partie', ['Chapitre 1 — Le départ', ["Chapitre 2 — L'astrolabe", ['Une section']]]],
      ['Deuxième partie', ['Chapitre 3 — La traversée', "Chapitre 4 — L'arrivée"]],
      'Notes',
      'Annexe',
    ]);
    const sec = b.toc[1].children[1].children[0];
    check('toc entry: path, fragment, spine index', [sec.href, sec.frag, sec.spine], ['OEBPS/text/ch2.xhtml', 'section-2', 2]);
    check('toc heading without link', [b.toc[2].href, b.toc[2].spine], ['', -1]);
  });

  await section('backend: EPUB 2 (NCX, opf:role, meta cover, ISO-8859-1)', async () => {
    const b = await H['books:open'](f.classique);
    check('title', b.title, 'Les Contemplations (extrait)');
    check('author + file-as', [b.authors, b.authorSort], [['Victor Hugo'], 'Hugo, Victor']);
    check('cover from <meta name="cover">', b.cover, 'cover.png');
    check('calibre series', [b.series, b.seriesIndex], ['Poésie', 1]);
    check('NCX nested', flat(b.toc), [['Livre premier', ['I. Aurore', ['II. Midi', ['Strophe']]]], ['Livre deuxième', ['III. Soir']]]);
    const r = await H['books:resource'](f.classique, 'c3.xhtml');
    check('chapter bytes + mime from the manifest', [r.mime, r.data instanceof Uint8Array, r.data.length > 500], ['application/xhtml+xml', true, true]);
    check('ISO-8859-1 bytes kept as they are (decoded by the reader)', Buffer.from(r.data).includes(Buffer.from('été', 'latin1')), true);
  });

  await section('backend: resources, font de-obfuscation, traversal', async () => {
    const font = await H['books:resource'](f.voyage, 'OEBPS/fonts/book.woff2');
    check('obfuscated font restored (IDPF algorithm)', [font.mime, Buffer.from(font.data.subarray(0, 4)).toString('latin1')], ['font/woff2', 'wOF2']);
    const css = await H['books:resource'](f.voyage, 'OEBPS/styles/book.css');
    check('style sheet', [css.mime, Buffer.from(css.data).toString('utf8').includes('BookFont')], ['text/css', true]);
    const png = await H['books:resource'](f.voyage, '/OEBPS/images/cover.png');
    check('leading slash tolerated', png.mime, 'image/png');
    check('"../evil.txt" refused', await code(H['books:resource'](f.voyage, '../evil.txt')), 'EINVAL');
    check('"OEBPS/../../evil.txt" refused', await code(H['books:resource'](f.voyage, 'OEBPS/../../evil.txt')), 'EINVAL');
    check('entry named "/abs.txt" never addressable', await code(H['books:resource'](f.voyage, '/abs.txt')), 'ENOENT');
    check('missing file', await code(H['books:resource'](f.voyage, 'OEBPS/nope.xhtml')), 'ENOENT');
    check('bad arguments', [await code(H['books:open']('relative.epub')), await code(H['books:open'](42)), await code(H['books:resource'](f.voyage, 7))], ['EINVAL', 'EINVAL', 'EINVAL']);
    check('missing book', await code(H['books:open'](path.join(tmp, 'nope.epub'))), 'ENOENT');
  });

  await section('backend: damaged, protected, too large', async () => {
    check('half a ZIP', await code(H['books:open'](f.broken)), 'EBADZIP');
    check('not a ZIP', await code(H['books:open'](f.notzip)), 'EBADZIP');
    check('DRM (encryption.xml lists the chapters)', await code(H['books:open'](f.drm)), 'EDRM');
    check('damaged chapter: the book opens', (await H['books:open'](f.badentry)).title, 'Chapitre abîmé');
    check('damaged chapter: checksum refused', await code(H['books:resource'](f.badentry, 'OEBPS/c2.xhtml')), 'EBADZIP');
    const big = path.join(tmp, 'big.epub');
    fs.writeFileSync(big, '');
    fs.truncateSync(big, 501 * 1024 * 1024); // sparse
    check('over 500 MB refused', await code(H['books:open'](big)), 'ETOOBIG');
    fs.rmSync(big);
    // a ZIP bomb: 70 MB of zeros deflate to ~70 KB
    const bomb = path.join(tmp, 'bomb.epub');
    const opf = '<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata><title>Bomb</title></metadata><manifest><item id="c" href="c.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c"/></spine></package>';
    const zeros = Buffer.alloc(70 * 1024 * 1024);
    fs.writeFileSync(bomb, zip([{ name: 'META-INF/container.xml', data: '<container><rootfiles><rootfile full-path="p.opf" media-type="application/oebps-package+xml"/></rootfiles></container>' }, { name: 'p.opf', data: opf }, { name: 'c.xhtml', data: zeros }]));
    check('bomb file is small', fs.statSync(bomb).size < 200000, true);
    check('entry over 64 MB inflated refused', await code(H['books:resource'](bomb, 'c.xhtml')), 'ETOOBIG');
    // declared size smaller than the real data: inflating stops at the declared size
    const liar = path.join(tmp, 'liar.epub');
    fs.writeFileSync(liar, zip([{ name: 'META-INF/container.xml', data: '<container><rootfiles><rootfile full-path="p.opf"/></rootfiles></container>' }, { name: 'p.opf', data: opf }, { name: 'c.xhtml', data: Buffer.alloc(5 * 1024 * 1024), usize: 1000 }]));
    check('entry larger than declared refused', await code(H['books:resource'](liar, 'c.xhtml')), 'EBADZIP');
    const noSpine = path.join(tmp, 'nospine.epub');
    fs.writeFileSync(noSpine, zip([{ name: 'META-INF/container.xml', data: '<container><rootfiles><rootfile full-path="p.opf"/></rootfiles></container>' }, { name: 'p.opf', data: '<package version="3.0"><metadata/><manifest/><spine/></package>' }]));
    check('no reading order', await code(H['books:open'](noSpine)), 'ENOTEPUB');
    const meta = await H['books:meta'](f.garden);
    check('meta for the library (+ cover bytes)', [meta.title, meta.authors, meta.cover?.mime, meta.cover?.data.length > 1000, meta.spineCount], ['The Night Garden', ['Amelia Hart'], 'image/png', true, 3]);
  });

  await section('backend: folder scan', async () => {
    fs.mkdirSync(path.join(tmp, 'Documents', 'Livres', 'deeper', 'deepest'), { recursive: true });
    fs.copyFileSync(f.garden, path.join(tmp, 'Documents', 'Livres', 'garden2.epub'));
    fs.copyFileSync(f.garden, path.join(tmp, 'Documents', 'Livres', 'deeper', 'deep.epub'));
    fs.copyFileSync(f.garden, path.join(tmp, 'Documents', '.hidden.epub'));
    const names = (list) => list.map((x) => path.relative(tmp, x.path)).sort();
    const d1 = await H['books:scan']([path.join(tmp, 'Documents')], { depth: 1 });
    check('depth 1: the folder and its direct subfolders', names(d1).filter((n) => /garden|deep/.test(n)), ['Documents/Livres/garden2.epub', 'Documents/garden.epub']);
    check('hidden files skipped', names(d1).some((n) => n.includes('.hidden')), false);
    const d0 = await H['books:scan']([path.join(tmp, 'Documents')], { depth: 0 });
    check('depth 0: only the folder', names(d0).some((n) => n.includes('Livres')), false);
    const d2 = await H['books:scan']([path.join(tmp, 'Documents')], { depth: 2 });
    check('depth 2', names(d2).includes('Documents/Livres/deeper/deep.epub'), true);
    check('outside $HOME refused', await H['books:scan'](['/usr/share', '/tmp', 'relative', path.join(tmp, '..')]), []);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'books-elsewhere-'));
    fs.copyFileSync(f.garden, path.join(outside, 'linked.epub'));
    fs.symlinkSync(outside, path.join(tmp, 'Linked'));
    check('a user folder linked to another disk is scanned', names(await H['books:scan']([path.join(tmp, 'Linked')])), ['Linked/linked.epub']);
    check('… but not the same folder by its real path', await H['books:scan']([outside]), []);
    fs.rmSync(outside, { recursive: true, force: true });
    check('entries carry size and mtime', d1.every((x) => x.size > 0 && x.mtime > 0 && x.name.endsWith('.epub')), true);
  });

  process.env.HOME = savedHome;
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ================================================================== app helpers
const WIN = '.win.app-books';
const DLG = `${WIN} > .dialog-layer:not(.closing) .dialog`;
/** Evaluate fn(app, winEl, arg) in the shell for the Livres window (expression string: no eval in the page). */
function A(s, fn, arg) {
  return s.page.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(WIN)}); return (${fn.toString()})(el && el.__books, el, ${JSON.stringify(arg ?? null)}); })()`);
}
const run = (s, expr) => s.page.evaluate(expr);
const R = (s) =>
  A(s, (app) => {
    const r = app?.reader;
    if (!r) return null;
    const c = r.cur;
    return { spine: c?.spine ?? null, view: c?.view ?? null, views: c?.views ?? null, n: c?.n ?? null, error: !!c?.error, loading: !!r.loadingChapter, layout: r.layout, title: r.book?.title || null, errorShown: !r.errorEl.hidden, sideOpen: !r.side.hidden };
  });
async function atChapter(s, spine, label = `chapter ${spine}`) {
  let last = null;
  try {
    return await until(async () => {
      const st = await R(s);
      last = st;
      return st && st.spine === spine && !st.loading ? st : null;
    }, { label, timeout: 10000 });
  } catch (err) {
    const extra = await A(s, (app) => ({ active: `${document.activeElement?.tagName}.${document.activeElement?.className}`, queued: app?.reader?.queued, wins: document.querySelectorAll('.win.app-books').length })).catch(() => null);
    throw new Error(`${err.message} — reader: ${JSON.stringify(last)} ${JSON.stringify(extra)}`);
  }
}
async function frameEval(s, fn, arg) {
  return A(s, `(app, el, arg) => { const d = app.reader.cur.doc; const f = app.reader.cur.frame; return (${fn.toString()})(d, f, app, arg); }`, arg);
}
async function press(s, key, n = 1) {
  for (let i = 0; i < n; i++) {
    await s.page.keyboard.press(key);
    await sleep(60);
  }
  await sleep(150);
}
async function libCards(s) {
  return A(s, (app, el) => [...el.querySelectorAll('.books-grid .books-card')].map((c) => ({ path: c.dataset.path, title: c.querySelector('.books-card-title')?.textContent, cover: !!c.querySelector('.books-cover img'), status: c.querySelector('.books-card-status')?.textContent || '' })));
}
async function dialogButton(s, label) {
  await until(() => run(s, `!!document.querySelector(${JSON.stringify(DLG)})`), { label: 'dialog' });
  await s.page.locator(`${DLG} .dialog-footer button`, { hasText: label }).first().click();
  await sleep(250);
}
/** Screen point of an element inside the reading frame. */
async function framePoint(s, selector, fx = 0.5) {
  return A(
    s,
    (app, el, a) => {
      const f = app.reader.cur.frame;
      const e = app.reader.cur.doc.querySelector(a.sel);
      if (!e) return null;
      const fr = f.getBoundingClientRect();
      const r = e.getClientRects()[0] || e.getBoundingClientRect();
      return { x: fr.left + r.left + r.width * a.fx, y: fr.top + r.top + r.height / 2, inView: r.left >= -1 && r.right <= f.clientWidth + 1 };
    },
    { sel: selector, fx },
  );
}

// ================================================================== app, English, light
async function runMain(state) {
  console.log('Livres — app (en, light)');
  // local server: any request the hostile chapter might make lands here
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const s = await launchShell({ lang: 'en', theme: 'light', keepHome: true });
  state.home = s.home;
  traceLogs = () => s.logs;
  const fx = writeBookFixtures(path.join(s.home, '.fixtures'), { port });
  const place = (src, rel) => {
    const p = path.join(s.home, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.copyFileSync(src, p);
    return p;
  };
  const F = {
    voyage: place(fx.voyage, 'Documents/Le Voyage de Sélène.epub'),
    classique: place(fx.classique, 'Downloads/classique.epub'),
    garden: place(fx.garden, 'Documents/Livres/garden.epub'),
    deep: place(fx.garden, 'Documents/a/b/deep.epub'),
    added: place(fx.added, 'Desktop/added.epub'),
    drm: place(fx.drm, 'Desktop/drm.epub'),
    broken: place(fx.broken, 'Desktop/broken.epub'),
    notzip: place(fx.notzip, 'Desktop/notzip.epub'),
    badentry: place(fx.badentry, 'Desktop/badentry.epub'),
    rtl: place(fx.rtl, 'Desktop/rtl.epub'),
    notes: path.join(s.home, 'Desktop', 'notes.txt'),
  };
  fs.writeFileSync(F.notes, 'hello');
  state.F = F;
  // every http(s) request of the whole session (main process)
  await s.app.evaluate(({ session }) => {
    globalThis.__booksNet = [];
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (d, cb) => {
      globalThis.__booksNet.push(d.url);
      cb({});
    });
  });
  const netLog = () => s.app.evaluate(() => globalThis.__booksNet || []);
  // external links: recorded instead of opening the Navigateur
  await run(s, `window.__opened = []; window.__aurora.shell.openUrl = (u) => { window.__opened.push(u); return null; }; true`);

  if (process.env.BOOKS_TRACE) {
    await run(s, `import('app://shell/apps/books/lib/reader.js').then((m) => { const proto = m.Reader.prototype; for (const k of ['next', 'goTo', 'prev', 'open', 'showView', 'loadChapter']) { const o = proto[k]; proto[k] = function (...a) { console.log('TRACE ' + k + ' ' + JSON.stringify(a[0] ?? null) + ' ' + new Error().stack.split('\\n').slice(2, 6).map((x) => x.trim()).join(' / ')); return o.apply(this, a); }; } return 1; })`);
  }
  await section('library: folder scan, metadata, covers', async () => {
    check('.epub opens with Livres by default', await run(s, `window.__aurora.registry.handlerFor('/x/y/Book.EPUB')`), 'books');
    await s.aurora(() => window.__aurora.registry.launch('books'));
    await until(() => run(s, `!!document.querySelector('${WIN} .books-library:not([hidden])')`), { label: 'library' });
    const cards = await until(async () => {
      const c = await libCards(s);
      return c.length === 3 && c.every((x) => x.title && !x.title.endsWith('.epub')) && c.filter((x) => x.cover).length === 3 ? c : null;
    }, { label: 'three books with metadata and covers', timeout: 12000 });
    check('found in Documents, Downloads and Documents/Livres (not deeper)', cards.map((c) => path.relative(s.home, c.path)).sort(), ['Documents/Le Voyage de Sélène.epub', 'Documents/Livres/garden.epub', 'Downloads/classique.epub']);
    check('titles from the books', cards.map((c) => c.title).sort(), ['Le Voyage de Sélène', 'Les Contemplations (extrait)', 'The Night Garden']);
    check('not started yet', cards.every((c) => c.status === 'New'), true);
    check('count', await run(s, `document.querySelector('${WIN} .books-lib-count').textContent`), '3 books');
    check('no « Continue reading » yet', await run(s, `document.querySelector('${WIN} .books-continue').closest('section').hidden`), true);
    await s.page.selectOption(`${WIN} .books-lib-sort`, 'title');
    check('sort by title', (await libCards(s)).map((c) => c.title), ['Le Voyage de Sélène', 'Les Contemplations (extrait)', 'The Night Garden']);
    await s.page.selectOption(`${WIN} .books-lib-sort`, 'author');
    check('sort by author (last name)', (await libCards(s)).map((c) => c.title), ['The Night Garden', 'Les Contemplations (extrait)', 'Le Voyage de Sélène']);
    await s.page.fill(`${WIN} .books-lib-search`, 'hugo');
    await sleep(100);
    check('search by author', (await libCards(s)).map((c) => c.title), ['Les Contemplations (extrait)']);
    await s.page.fill(`${WIN} .books-lib-search`, 'SELENE');
    await sleep(100);
    check('search ignores case and accents', (await libCards(s)).map((c) => c.title), ['Le Voyage de Sélène']);
    await s.page.fill(`${WIN} .books-lib-search`, 'zzz');
    await sleep(100);
    check('no match message', await run(s, `!document.querySelector('${WIN} .books-lib-nomatch').hidden`), true);
    await s.page.fill(`${WIN} .books-lib-search`, '');
    await s.page.selectOption(`${WIN} .books-lib-sort`, 'recent');
    await sleep(100);
    check('all back', (await libCards(s)).length, 3);
  });

  await section('library: « Add books » picker and drag and drop', async () => {
    await s.page.click(`${WIN} .books-lib-head .books-add`);
    await until(() => run(s, `!!document.querySelector('${WIN} .fp-dialog')`), { label: 'file picker' });
    await s.page.fill(`${WIN} .fp-path`, path.join(s.home, 'Desktop'));
    await s.page.press(`${WIN} .fp-path`, 'Enter');
    await until(() => run(s, `[...document.querySelectorAll('${WIN} .fp-row')].some((r) => r.textContent.includes('added.epub'))`), { label: 'Desktop listed' });
    check('picker lists EPUB books only', await run(s, `[...document.querySelectorAll('${WIN} .fp-row')].some((r) => r.textContent.includes('notes.txt'))`), false);
    await s.page.locator(`${WIN} .fp-row`, { hasText: 'added.epub' }).dblclick();
    const added = await until(async () => {
      const c = await libCards(s);
      return c.find((x) => x.title === 'Winter Letters');
    }, { label: 'Winter Letters added' });
    check('added from the picker, generated cover', [added.cover, await run(s, `!!document.querySelector('${WIN} .books-card[data-path="${F.added}"] .books-cover.generated')`)], [false, true]);
    // drag and drop from Files (the shell's own drag payload)
    await run(
      s,
      `(() => { const root = document.querySelector('${WIN} .books-root'); document.dispatchEvent(new DragEvent('dragstart', { bubbles: true }));
        const dt = new DataTransfer(); dt.setData('application/x-aurora-paths', JSON.stringify(${JSON.stringify([F.badentry, F.notes])}));
        root.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer: dt }));
        window.__dropShown = !document.querySelector('${WIN} .books-drop').hidden;
        root.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
        document.dispatchEvent(new DragEvent('dragend', { bubbles: true })); return true; })()`,
    );
    check('drop zone shown while dragging', await run(s, 'window.__dropShown'), true);
    await until(async () => (await libCards(s)).some((c) => c.title === 'Chapitre abîmé'), { label: 'dropped book added' });
    check('only the EPUB was added', (await libCards(s)).length, 5);
    check('drop zone hidden after the drop', await run(s, `document.querySelector('${WIN} .books-drop').hidden`), true);
    check('toast', await until(() => run(s, `document.querySelector('${WIN} .books-toast').textContent`), { label: 'toast' }), (t) => /added to the library/.test(t));
  });

  await section('library: keyboard', async () => {
    await A(s, (app, el) => el.querySelector('.books-grid .books-card').focus());
    const first = await run(s, `document.activeElement.dataset.path`);
    await press(s, 'ArrowRight');
    const second = await run(s, `document.activeElement.dataset.path`);
    check('arrow moves between cards', second && second !== first, true);
    await press(s, 'ArrowLeft');
    check('and back', await run(s, `document.activeElement.dataset.path`), first);
    await press(s, 'Shift+F10');
    check('Shift+F10 opens the card menu', await until(() => run(s, `[...document.querySelectorAll('.menu .menu-item')].map((m) => m.textContent.trim()).join('|')`), { label: 'menu' }), (t) => /Open\|Show in Files\|Remove from the library\|Delete the file/.test(t));
    await press(s, 'Escape');
    check('Escape closes the menu', await run(s, `!document.querySelector('.menu')`), true);
    await s.shot('books-library-en-light');
  });

  await section('open from Files and page turning', async () => {
    await s.aurora((p) => window.__aurora.shell.openFile(p), F.voyage);
    let st = await atChapter(s, 0, 'cover');
    check('reader opened at the cover', [st.title, st.views], ['Le Voyage de Sélène', 1]);
    check('window title', await A(s, (app) => app.win.title), 'Le Voyage de Sélène');
    check('cover fitted as one page', await frameEval(s, (d) => [d.documentElement.querySelector('style[data-books="layout"]').textContent.includes('column-count: 1'), d.images[0].getBoundingClientRect().height > 300]), [true, true]);
    await press(s, 'ArrowRight');
    st = await atChapter(s, 1);
    check('→ next chapter at its first page', st.view, 0);
    check('two pages side by side in a wide window', st.n, 2);
    check('chapter 1 has several pages', st.views >= 3, true);
    const views = st.views;
    await press(s, 'ArrowRight');
    check('→ next page', (await R(s)).view, 1);
    await press(s, 'PageDown');
    check('PageDown', (await R(s)).view, 2);
    await press(s, 'PageUp');
    check('PageUp', (await R(s)).view, 1);
    await press(s, ' ');
    check('Space', (await R(s)).view, 2);
    await press(s, 'Shift+ ');
    check('Shift+Space', (await R(s)).view, 1);
    await press(s, 'End');
    check('End: last page of the chapter', (await R(s)).view, views - 1);
    await press(s, 'Home');
    check('Home: first page of the chapter', (await R(s)).view, 0);
    check('footer page count', await run(s, `document.querySelector('${WIN} .books-foot-page').textContent`), `Page 1 of ${views}`);
    const tr = await frameEval(s, (d, f, app) => ({ t: d.body.style.transform, step: app.reader.cur.step }));
    check('page 1 not shifted', tr.t, 'translateX(0px)');
    // click zones on the page edges
    const box = await A(s, (app) => {
      const r = app.reader.cur.frame.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    });
    await s.page.mouse.click(box.x + box.w * 0.95, box.y + box.h * 0.5);
    await sleep(250);
    check('click on the right edge: next page', (await R(s)).view, 1);
    check('page shifted by one step', await frameEval(s, (d, f, app) => d.body.style.transform === `translateX(${-app.reader.cur.step}px)`), true);
    await s.page.mouse.click(box.x + box.w * 0.04, box.y + box.h * 0.5);
    await sleep(250);
    check('click on the left edge: previous page', (await R(s)).view, 0);
    await s.page.mouse.click(box.x + box.w * 0.5, box.y + box.h * 0.5);
    await sleep(250);
    check('click in the middle: stays', (await R(s)).view, 0);
    await s.page.mouse.move(box.x + box.w * 0.5, box.y + box.h * 0.5);
    await s.page.mouse.wheel(0, 120);
    await sleep(400);
    check('mouse wheel: next page', (await R(s)).view, 1);
    await press(s, 'End');
    await press(s, 'ArrowRight');
    st = await atChapter(s, 2);
    check('past the last page: next chapter', st.view, 0);
    await press(s, 'ArrowLeft');
    st = await atChapter(s, 1);
    check('← from a first page: previous chapter, last page', st.view, views - 1);
    await press(s, 'ArrowRight');
    await atChapter(s, 2);
    // narrow window: one page at a time, more pages
    const v2 = (await R(s)).views;
    await A(s, (app) => app.win.setSize(640, 700));
    await until(async () => (await R(s)).n === 1, { label: 'one column' });
    const narrow = await R(s);
    check('narrow window: one page at a time', narrow.n, 1);
    check('more pages when narrow', narrow.views > v2, true);
    await A(s, (app) => app.win.setSize(1120, 780));
    await until(async () => (await R(s)).n === 2, { label: 'two columns again' });
    check('position kept on resize (chapter)', (await R(s)).spine, 2);
    await s.shot('books-reader-en-light');
    // progress bar: seek to the middle of the book
    await run(s, `(() => { const r = document.querySelector('${WIN} .books-seek'); r.value = 500; r.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    check('seek preview shows the target', await run(s, `document.querySelector('${WIN} .books-foot-pct').textContent`), '50%');
    await run(s, `(() => { const r = document.querySelector('${WIN} .books-seek'); r.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await until(async () => { const st = await R(s); return st.spine !== 2 || !st.loading; }, { label: 'seek' });
    await sleep(300);
    const pct = parseInt(await run(s, `document.querySelector('${WIN} .books-foot-pct').textContent`), 10);
    check('seek: about the middle of the book', [(await R(s)).spine, pct >= 42 && pct <= 62], [2, true]);
    check('footer shows the chapter', await run(s, `document.querySelector('${WIN} .books-foot-chap').textContent`), (t) => /Chapitre 2|Une section/.test(t));
    // about this book
    await s.page.click(`${WIN} [data-cmd="more"]`);
    await s.page.locator('.menu .menu-item', { hasText: 'About this book' }).click();
    const info = await until(() => run(s, `document.querySelector(${JSON.stringify(DLG)})?.innerText`), { label: 'info dialog' });
    check('book information', info, (t) => /Le Voyage de Sélène/.test(t) && /Jeanne Martin/.test(t) && /Éditions de la Lune/.test(t) && /EPUB 3\.0/.test(t) && /Les Récits de la Lune \(2\)/.test(t) && /au long cours/.test(t));
    await dialogButton(s, 'OK');
  });

  await section('table of contents', async () => {
    await A(s, (app) => app.reader.goTo({ spine: 2, ratio: 0 }));
    await atChapter(s, 2);
    await s.page.click(`${WIN} [data-cmd="toc"]`);
    await until(async () => (await R(s)).sideOpen, { label: 'side panel' });
    const items = await run(s, `[...document.querySelectorAll('${WIN} .books-toc [role="treeitem"]')].map((b) => b.tagName + ':' + b.textContent + ':' + b.getAttribute('aria-level'))`);
    check('nested entries with levels', items, [
      'BUTTON:Couverture:1',
      'BUTTON:Première partie:1',
      'BUTTON:Chapitre 1 — Le départ:2',
      "BUTTON:Chapitre 2 — L'astrolabe:2",
      'BUTTON:Une section:3',
      'DIV:Deuxième partie:1',
      'BUTTON:Chapitre 3 — La traversée:2',
      "BUTTON:Chapitre 4 — L'arrivée:2",
      'BUTTON:Notes:1',
      'BUTTON:Annexe:1',
    ]);
    check('current chapter marked', await run(s, `document.querySelector('${WIN} .books-toc [aria-current]')?.textContent`), "Chapitre 2 — L'astrolabe");
    await s.page.locator(`${WIN} .books-toc-item`, { hasText: 'Une section' }).click();
    await atChapter(s, 2);
    const pt = await until(() => framePoint(s, '#section-2'), { label: 'section heading' });
    check('jumped to the page holding the section', pt.inView, true);
    check('section is the current entry', await until(() => run(s, `document.querySelector('${WIN} .books-toc [aria-current]')?.textContent === 'Une section'`), { label: 'aria-current' }), true);
    check('toolbar shows the chapter', await run(s, `document.querySelector('${WIN} .books-rchap').textContent`), 'Une section');
    await s.shot('books-toc-en-light');
    await s.page.locator(`${WIN} .books-toc-item`, { hasText: 'Chapitre 3' }).click();
    const st = await atChapter(s, 3);
    check('chapter 3 from its first page', st.view, 0);
    await s.page.click(`${WIN} [data-cmd="toc"]`);
    check('panel closes', (await R(s)).sideOpen, false);
  });

  await section('text size, font, spacing, alignment, margins', async () => {
    await A(s, (app) => app.reader.goTo({ spine: 1, ratio: 0 }));
    const before = await atChapter(s, 1);
    const fs0 = await frameEval(s, (d) => parseFloat(getComputedStyle(d.querySelector('p')).fontSize));
    await s.page.click(`${WIN} [data-cmd="appearance"]`);
    await until(() => run(s, `!document.querySelector('${WIN} .books-flyout').hidden`), { label: 'flyout' });
    await s.page.click(`${WIN} [data-cmd="font-bigger"]`);
    await s.page.click(`${WIN} [data-cmd="font-bigger"]`);
    await sleep(400);
    check('size label', await run(s, `document.querySelector('${WIN} .books-size-val').textContent`), '120%');
    const fs1 = await frameEval(s, (d) => parseFloat(getComputedStyle(d.querySelector('p')).fontSize));
    check('text 20 % larger', Math.abs(fs1 / fs0 - 1.2) < 0.02, true);
    check('more pages with larger text', (await R(s)).views > before.views, true);
    await s.shot('books-flyout-en-light');
    await s.page.selectOption(`${WIN} .books-font-select`, 'sans');
    await sleep(300);
    check('sans serif font', await frameEval(s, (d) => getComputedStyle(d.querySelector('p')).fontFamily), (f) => /^"?Inter/.test(f));
    await s.page.selectOption(`${WIN} .books-font-select`, 'serif');
    await sleep(300);
    check('serif font', await frameEval(s, (d) => getComputedStyle(d.querySelector('p')).fontFamily), (f) => /^"?Noto Serif/.test(f));
    await s.page.selectOption(`${WIN} .books-font-select`, 'readable');
    await sleep(300);
    check('readable font', await frameEval(s, (d) => getComputedStyle(d.querySelector('p')).fontFamily), (f) => /Atkinson Hyperlegible/.test(f));
    await s.page.click(`${WIN} [data-pref="lineHeight"] [data-value="loose"]`);
    await sleep(300);
    check('line spacing', await frameEval(s, (d) => { const cs = getComputedStyle(d.querySelector('p')); return Math.round((parseFloat(cs.lineHeight) / parseFloat(cs.fontSize)) * 100) / 100; }), 1.85);
    await s.page.click(`${WIN} [data-pref="align"] [data-value="justify"]`);
    await sleep(300);
    check('justified', await frameEval(s, (d) => getComputedStyle(d.querySelector('p')).textAlign), 'justify');
    const w0 = await A(s, (app) => app.reader.cur.frame.clientWidth);
    await s.page.click(`${WIN} [data-pref="margins"] [data-value="wide"]`);
    await sleep(400);
    check('wide margins: narrower text', (await A(s, (app) => app.reader.cur.frame.clientWidth)) < w0, true);
    // keyboard in the flyout: arrows move along a choice
    await s.page.focus(`${WIN} [data-pref="margins"] [data-value="wide"]`);
    await press(s, 'ArrowLeft');
    check('arrow keys pick the previous choice', await A(s, () => document.querySelector('.app-books .books-flyout [data-pref="margins"] [aria-checked="true"]').dataset.value), 'normal');
    // back to the book's own look
    await s.page.click(`${WIN} [data-pref="lineHeight"] [data-value="book"]`);
    await s.page.click(`${WIN} [data-pref="align"] [data-value="book"]`);
    await s.page.selectOption(`${WIN} .books-font-select`, 'book');
    await s.page.click(`${WIN} [data-cmd="font-smaller"]`);
    await s.page.click(`${WIN} [data-cmd="font-smaller"]`);
    await sleep(300);
    check('settings back to the book', await A(s, (app) => ({ ...app.store.prefs })), (p) => p.fontSize === 100 && p.font === 'book' && p.margins === 'normal' && p.lineHeight === 'book' && p.align === 'book');
    await sleep(400);
    check('settings saved', JSON.parse(fs.readFileSync(path.join(s.home, '.config/aurora/apps/books/prefs.json'), 'utf8')).margins, 'normal');
    check('book font again', await frameEval(s, (d) => getComputedStyle(d.querySelector('p')).fontFamily), (f) => !/Inter|Atkinson/.test(f));
    await press(s, 'Escape');
    check('Escape closes the flyout', await run(s, `document.querySelector('${WIN} .books-flyout').hidden`), true);
    check('focus back on its button', await run(s, `document.activeElement?.dataset?.cmd`), 'appearance');
    await press(s, 'Control+=');
    check('Ctrl+= larger text', await frameEval(s, (d) => parseFloat(getComputedStyle(d.documentElement).fontSize)), (v) => Math.abs(v - 17.6) < 0.2);
    await press(s, 'Control+0');
    check('Ctrl+0 resets', await frameEval(s, (d) => parseFloat(getComputedStyle(d.documentElement).fontSize)), (v) => Math.abs(v - 16) < 0.2);
  });

  await section('themes: light, sepia, dark, automatic', async () => {
    const lum = (rgb) => {
      const m = /(\d+(?:\.\d+)?)[ ,]+(\d+(?:\.\d+)?)[ ,]+(\d+(?:\.\d+)?)/.exec(rgb || '');
      return m ? (0.2126 * m[1] + 0.7152 * m[2] + 0.0722 * m[3]) / 255 : -1;
    };
    const look = () => frameEval(s, (d, f, app) => ({ bg: getComputedStyle(d.documentElement).backgroundColor, fg: getComputedStyle(d.body).color, p: getComputedStyle(d.querySelector('p')).color, theme: app.reader.el.dataset.theme, reading: app.reader.el.dataset.reading, amb: app.reader.el.dataset.ambiance || null, chrome: getComputedStyle(app.reader.el).backgroundColor }));
    const setTheme = async (v) => {
      await s.page.click(`${WIN} [data-cmd="appearance"]`);
      await s.page.click(`${WIN} .books-theme[data-value="${v}"]`);
      await sleep(300);
      await press(s, 'Escape');
    };
    let l = await look();
    check('automatic in a light shell: light page', [l.reading, l.theme, lum(l.bg) > 0.9, lum(l.fg) < 0.3], ['light', 'light', true, true]);
    check('page and window share the paper colour', l.bg, l.chrome);
    await setTheme('dark');
    l = await look();
    check('dark: dark page, light text', [l.reading, lum(l.bg) < 0.15, lum(l.fg) > 0.7, lum(l.p) > 0.7], ['dark', true, true, true]);
    await s.shot('books-reader-en-dark-theme');
    await setTheme('sepia');
    l = await look();
    const rgb = /(\d+)[ ,]+(\d+)[ ,]+(\d+)/.exec(l.bg).slice(1).map(Number);
    check('sepia: warm paper (red > blue), dark brown ink', [l.reading, rgb[0] > rgb[2] + 16, lum(l.fg) < 0.3, l.bg], ['sepia', true, true, 'rgb(244, 236, 218)']);
    await s.shot('books-reader-en-sepia');
    await setTheme('light');
    l = await look();
    check('light', [l.reading, lum(l.bg) > 0.9], ['light', true]);
    await setTheme('auto');
    await s.aurora(() => window.__aurora.settings.set('theme', 'dark'));
    await sleep(800);
    l = await look();
    check('automatic follows the shell (dark)', [l.reading, lum(l.bg) < 0.15], ['dark', true]);
    await s.shot('books-reader-en-dark');
    await s.aurora(() => window.__aurora.settings.set('theme', 'light'));
    await sleep(800);
    l = await look();
    check('automatic follows the shell (light)', [l.reading, lum(l.bg) > 0.9], ['light', true]);
  });

  await section('bookmarks', async () => {
    await A(s, (app) => app.reader.goTo({ spine: 1, ratio: 0 }));
    await atChapter(s, 1);
    await press(s, 'ArrowRight');
    await A(s, (app) => app.reader.viewEl.focus());
    await press(s, 'Control+d');
    check('Ctrl+D: bookmark ribbon + pressed button', await run(s, `[!document.querySelector('${WIN} .books-ribbon').hidden, document.querySelector('${WIN} [data-cmd="bookmark"]').getAttribute('aria-pressed')]`), [true, 'true']);
    await A(s, (app) => app.reader.goTo({ spine: 3, ratio: 0.5 }));
    await atChapter(s, 3);
    check('no ribbon on another page', await run(s, `document.querySelector('${WIN} .books-ribbon').hidden`), true);
    await s.page.click(`${WIN} [data-cmd="bookmark"]`);
    await sleep(200);
    await s.page.click(`${WIN} [data-cmd="toc"]`);
    await s.page.click(`${WIN} .books-side-tab[data-tab="bookmarks"]`);
    const list = await run(s, `[...document.querySelectorAll('${WIN} .books-mark')].map((m) => ({ label: m.querySelector('.body-strong').textContent, pct: m.querySelector('.books-mark-top .caption').textContent, ex: m.querySelector('.books-mark-excerpt')?.textContent || '' }))`);
    check('two bookmarks in reading order', list.map((x) => x.label), ['Chapitre 1 — Le départ', 'Chapitre 3 — La traversée']);
    check('bookmarks show a percentage and an excerpt', list.every((x) => /%$/.test(x.pct) && x.ex.length > 20), true);
    const words = new Set('la lune éclaire le port pendant que les marins préparent la grande traversée vers les îles lointaines où personne ne revient jamais sans une histoire nouvelle à raconter aux enfants du village et aux voyageurs fatigués qui attendent le matin près du feu en écoutant le vent du large chanter dans les voiles'.split(' '));
    check('excerpts start with a whole word', list.map((x) => words.has(x.ex.split(/[\s.,]/)[0].toLowerCase())), [true, true]);
    await s.shot('books-bookmarks-en-light');
    await s.page.locator(`${WIN} .books-mark-go`).first().click();
    const st = await atChapter(s, 1);
    check('bookmark jump', st.view, 1);
    check('ribbon again', await run(s, `!document.querySelector('${WIN} .books-ribbon').hidden`), true);
    await s.page.locator(`${WIN} .books-mark-del`).nth(1).click();
    await sleep(200);
    check('removed from the list', await run(s, `document.querySelectorAll('${WIN} .books-mark').length`), 1);
    await A(s, (app) => app.reader.viewEl.focus());
    await press(s, 'Control+d');
    check('Ctrl+D on a bookmarked page removes it', await run(s, `document.querySelectorAll('${WIN} .books-mark').length`), 0);
    check('empty state', await run(s, `!!document.querySelector('${WIN} .books-marks .empty')`), true);
    await press(s, 'Control+d'); // keep one for the French run
    await s.page.click(`${WIN} [data-cmd="toc"]`);
  });

  await section('search in the book', async () => {
    await A(s, (app) => app.reader.viewEl.focus());
    await press(s, 'Control+f');
    check('Ctrl+F opens the search tab, focused', await run(s, `document.activeElement === document.querySelector('${WIN} .books-search-input')`), true);
    await s.page.keyboard.type('astrolabe');
    await press(s, 'Enter');
    await until(() => run(s, `/5 results/.test(document.querySelector('${WIN} .books-search-status').textContent)`), { label: '5 results' });
    const res = await run(s, `[...document.querySelectorAll('${WIN} .books-result')].map((b) => [b.dataset.spine, b.querySelector('mark').textContent])`);
    check('4 in chapter 2 (title, one across <em>) + 1 in chapter 3', res, [['2', 'astrolabe'], ['2', 'astrolabe'], ['2', 'astrolabe'], ['2', 'astrolabe'], ['3', 'astrolabe']]);
    check('results grouped under their chapter', await run(s, `[...document.querySelectorAll('${WIN} .books-result-chap')].map((x) => x.textContent)`), ["Chapitre 2 — L'astrolabe", 'Chapitre 3 — La traversée']);
    check('context around the match', await run(s, `document.querySelectorAll('${WIN} .books-result')[1].textContent`), (t) => /vieil astrolabe de cuivre/.test(t));
    await s.shot('books-search-en-light');
    await s.page.locator(`${WIN} .books-result`).nth(3).click();
    await atChapter(s, 2);
    const hit = await until(() => frameEval(s, (d) => [...d.querySelectorAll('mark[data-books-hit]')].map((m) => m.textContent).join('|')), { label: 'highlight' });
    check('match across two elements highlighted', hit, 'astro|labe');
    const pt = await framePoint(s, 'mark[data-books-hit]');
    check('highlight on the page shown', pt.inView, true);
    await s.page.fill(`${WIN} .books-search-input`, 'ÉCLAIRE');
    await press(s, 'Enter');
    await until(() => run(s, `/results?/.test(document.querySelector('${WIN} .books-search-status').textContent) && document.querySelectorAll('${WIN} .books-result').length > 3`), { label: 'accent-insensitive results' });
    check('accent- and case-insensitive', await run(s, `document.querySelector('${WIN} .books-result mark').textContent`), 'éclaire');
    await s.page.fill(`${WIN} .books-search-input`, 'zzzqqq');
    await press(s, 'Enter');
    await until(() => run(s, `document.querySelector('${WIN} .books-search-status').textContent === 'No results'`), { label: 'no results' });
    check('no results', true, true);
    await press(s, 'Escape'); // clears
    await press(s, 'Escape'); // closes
    check('Escape twice closes the panel', (await R(s)).sideOpen, false);
  });

  await section('notes, links, back', async () => {
    await A(s, (app) => app.reader.goTo({ spine: 1, ratio: 0 }));
    await atChapter(s, 1);
    let pt = await framePoint(s, '#r1');
    await s.page.mouse.click(pt.x, pt.y);
    await until(() => run(s, `!document.querySelector('${WIN} .books-note').hidden`), { label: 'footnote popover' });
    check('footnote text in a popover', await run(s, `document.querySelector('${WIN} .books-note-text').textContent`), "Note de bas de page : l'aube se lève sur la mer.");
    check('still on the same page', [(await R(s)).spine, (await R(s)).view], [1, 0]);
    await press(s, 'Escape');
    check('Escape closes the note', await run(s, `document.querySelector('${WIN} .books-note').hidden`), true);
    pt = await framePoint(s, '#r2');
    await s.page.mouse.click(pt.x, pt.y);
    await until(() => run(s, `!document.querySelector('${WIN} .books-note').hidden`), { label: 'endnote popover' });
    check('endnote from another chapter', await run(s, `document.querySelector('${WIN} .books-note-text').textContent`), 'Note de fin : la carte des étoiles.');
    await sleep(250);
    await s.shot('books-note-en-light');
    await s.page.click(`${WIN} [data-cmd="note-go"]`);
    await atChapter(s, 5, 'notes chapter');
    check('« Go to the note » opens the notes', (await R(s)).spine, 5);
    check('back chip', await run(s, `!document.querySelector('${WIN} .books-backchip').hidden`), true);
    await s.page.click(`${WIN} .books-backchip`);
    await atChapter(s, 1);
    check('back to the page', (await R(s)).view, 0);
    pt = await framePoint(s, '#xref');
    await s.page.mouse.click(pt.x, pt.y);
    await atChapter(s, 3, 'cross-reference');
    check('cross-chapter link lands on its target', (await framePoint(s, '#arrivee-port')).inView, true);
    await s.page.click(`${WIN} .books-backchip`);
    await atChapter(s, 1);
    pt = await framePoint(s, '#extlink');
    await s.page.mouse.click(pt.x, pt.y);
    await sleep(300);
    check('external link opens in the Navigateur', await run(s, 'window.__opened'), ['https://example.org/selene']);
    check('… and the reader itself loads nothing', (await netLog()).filter((u) => u.includes('example.org')), []);
    check('still in the book', (await R(s)).spine, 1);
  });

  await section('hostile chapter neutralised', async () => {
    await A(s, (app) => app.reader.goTo({ spine: 6, ratio: 0 }));
    await atChapter(s, 6, 'hostile chapter');
    await sleep(1200);
    const r = await frameEval(s, (d, f) => {
      const all = [...d.querySelectorAll('*')];
      return {
        sandbox: f.getAttribute('sandbox'),
        url: d.URL,
        csp: d.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content || '',
        marker: !!d.getElementById('hostile-marker'),
        dangerous: d.querySelectorAll('script, iframe, object, embed, form, input, button, base, link, meta[http-equiv="refresh"], noscript').length,
        handlers: all.filter((e) => [...e.attributes].some((a) => /^on/i.test(a.name))).length,
        js: /javascript:/i.test(d.documentElement.outerHTML),
        net: (d.documentElement.outerHTML.replace(/data-books-url="[^"]*"/g, '').match(/127\.0\.0\.1|evil\.invalid/g) || []).length,
        imgs: [...d.images].map((i) => i.getAttribute('src') || ''),
        svgImage: [...d.querySelectorAll('image')].map((i) => i.getAttribute('href') || i.getAttribute('xlink:href') || ''),
        media: [...d.querySelectorAll('video, audio')].map((m) => [m.getAttribute('src'), m.getAttribute('poster'), m.hasAttribute('autoplay')]),
        styled: d.getElementById('styled').getAttribute('style'),
        spoof: d.querySelectorAll('[data-books-href]:not(a), [data-books-url]:not(a)').length,
        netlink: d.getElementById('netlink').getAttribute('data-books-url'),
        jslink: [d.getElementById('jslink').getAttribute('href'), d.getElementById('jslink').getAttribute('data-books-url'), d.getElementById('jslink').getAttribute('data-books-href')],
      };
    });
    check('frame sandbox has no allow-scripts', r.sandbox, 'allow-same-origin');
    check('frame never navigated (meta refresh ignored)', r.url, 'about:srcdoc');
    check('CSP meta in the chapter', r.csp, (c) => c.includes("default-src 'none'") && c.includes('img-src blob: data:') && !c.includes('http'));
    check('chapter shown', r.marker, true);
    check('no script / frame / plugin / form / base / link / refresh left', r.dangerous, 0);
    check('no event-handler attribute left', r.handlers, 0);
    check('no javascript: URL left', r.js, false);
    check('no remote URL left anywhere in the markup (but the link kept for the Navigateur)', r.net, 0);
    check('images: book images as blob:, remote ones without src', r.imgs.every((u) => u === '' || u.startsWith('blob:')), true);
    check('SVG <image> pointing outside dropped', r.svgImage.every((u) => u === '' || u.startsWith('blob:')), true);
    check('media: no remote src / poster, no autoplay', r.media.every(([src, poster, auto]) => !src && !poster && !auto), true);
    check('inline style url() neutralised', r.styled, (st) => !/url\(\s*['"]?http/i.test(st) && /color:\s*red/.test(st));
    check('book cannot fake our link attributes', r.spoof, 0);
    check('http link kept for the Navigateur', r.netlink, `http://127.0.0.1:${port}/clicked-link`);
    check('javascript: link inert', r.jslink, [null, null, null]);
    let pt = await framePoint(s, '#jslink');
    await s.page.mouse.click(pt.x, pt.y);
    pt = await framePoint(s, '#jslink2');
    await s.page.mouse.click(pt.x, pt.y);
    await sleep(300);
    check('clicking javascript: links does nothing', [(await R(s)).spine, await run(s, 'window.__booksPwned ?? null')], [6, null]);
    check('no script of the book ran (script, onerror, onclick, svg, srcdoc, refresh)', await run(s, 'window.__booksPwned ?? null'), null);
    const fpt = await framePoint(s, 'h1');
    await s.page.mouse.click(fpt.x, fpt.y);
    await s.page.mouse.move(fpt.x, fpt.y + 200);
    await sleep(300);
    check('… even after clicks and hovers', await run(s, 'window.__booksPwned ?? null'), null);
    await sleep(800);
    check('local server got no request', hits, []);
    const net = (await netLog()).filter((u) => u.includes(`127.0.0.1:${port}`) || u.includes('evil.invalid'));
    check('no network request at all (session log)', net, []);
    await s.shot('books-hostile-en-light');
  });

  await section('embedded font (obfuscated) and images', async () => {
    await A(s, (app) => app.reader.goTo({ spine: 2, ratio: 0 }));
    await atChapter(s, 2);
    const r = await until(
      () =>
        frameEval(s, (d) => {
          const faces = [...d.fonts].filter((x) => x.family.replace(/"/g, '') === 'BookFont');
          const fancy = d.getElementById('fancy');
          return faces.length && faces.every((x) => x.status === 'loaded') ? { status: faces[0].status, family: getComputedStyle(fancy).fontFamily, imgs: [...d.images].map((i) => [i.getAttribute('src').slice(0, 5), i.naturalWidth > 0]) } : null;
        }),
      { label: 'BookFont loaded', timeout: 6000 },
    );
    check('font restored and loaded from a data: URL', [r.status, /BookFont/.test(r.family)], ['loaded', true]);
    check('SVG image file shown (blob:)', r.imgs, [['blob:', true]]);
    check('inline SVG kept', await frameEval(s, (d) => !!d.getElementById('inline-svg')), true);
    check('book style sheet inlined, @namespace kept', await frameEval(s, (d) => [...d.querySelectorAll('style:not([data-books])')].some((st) => st.textContent.includes('@namespace epub "http://www.idpf.org/2007/ops"'))), true);
    check('figure picture in chapter 1 decoded', await A(s, (app) => app.reader.goTo({ spine: 1, ratio: 0 }).then(() => app.reader.cur.doc.getElementById('fig1').naturalWidth)), 240);
    check('epub|type selectors of the book still apply', await frameEval(s, (d) => getComputedStyle(d.querySelector('#fn1 p')).fontStyle), 'italic');
  });

  await section('scroll mode', async () => {
    await A(s, (app) => app.reader.goTo({ spine: 1, ratio: 0 }));
    await atChapter(s, 1);
    await s.page.click(`${WIN} [data-cmd="appearance"]`);
    await s.page.click(`${WIN} [data-pref="layout"] [data-value="scroll"]`);
    await press(s, 'Escape');
    await until(async () => (await R(s)).layout === 'scroll' && !(await R(s)).loading, { label: 'scroll mode' });
    const m = await until(() => A(s, (app) => (app.reader.cur?.height > 0 ? { h: app.reader.cur.height, vh: app.reader.viewEl.clientHeight, top: app.reader.viewEl.scrollTop } : null)), { label: 'measured' });
    check('the frame is as tall as the chapter', m.h > m.vh * 2, true);
    await A(s, (app) => app.reader.viewEl.focus());
    await press(s, 'PageDown');
    const top = await A(s, (app) => app.reader.viewEl.scrollTop);
    check('PageDown scrolls one screen', top > m.vh * 0.8, true);
    check('position follows the scroll', await A(s, (app) => app.reader.position().ratio), (v) => v > 0.05);
    const box = await A(s, (app) => { const r = app.reader.viewEl.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    await s.page.mouse.move(box.x, box.y);
    await s.page.mouse.wheel(0, 300);
    await sleep(300);
    check('mouse wheel over the page scrolls', (await A(s, (app) => app.reader.viewEl.scrollTop)) > top + 100, true);
    await A(s, (app) => (app.reader.viewEl.scrollTop = app.reader.viewEl.scrollHeight));
    await sleep(200);
    await press(s, 'PageDown');
    await atChapter(s, 2, 'next chapter in scroll mode');
    check('at the bottom, PageDown goes to the next chapter (top)', await A(s, (app) => app.reader.viewEl.scrollTop), 0);
    await s.shot('books-scroll-en-light');
    await s.page.click(`${WIN} [data-cmd="appearance"]`);
    await s.page.click(`${WIN} [data-pref="layout"] [data-value="paged"]`);
    await press(s, 'Escape');
    await until(async () => (await R(s)).layout === 'paged' && !(await R(s)).loading, { label: 'paged again' });
    check('paged again, same chapter', (await R(s)).spine, 2);
  });

  await section('position restored after reopening', async () => {
    await A(s, (app) => app.reader.goTo({ spine: 2, ratio: 0 }));
    await atChapter(s, 2);
    await press(s, 'ArrowRight', 2);
    const before = await R(s);
    check('on page 3 of chapter 2', before.view, 2);
    const pct = await run(s, `document.querySelector('${WIN} .books-foot-pct').textContent`);
    await A(s, (app) => app.win.close());
    await until(() => run(s, `!document.querySelector('${WIN}')`), { label: 'window closed' });
    const saved = JSON.parse(fs.readFileSync(path.join(s.home, '.config/aurora/apps/books/library.json'), 'utf8')).books.find((b) => b.path === F.voyage);
    check('position saved (spine + ratio)', [saved.pos.spine, Math.abs(saved.pos.ratio - before.view / before.views) < 1e-6, saved.progress > 0], [2, true, true]);
    await s.aurora((p) => window.__aurora.shell.openFile(p), F.voyage);
    const after = await atChapter(s, 2, 'reopened');
    check('reopened at the same page', [after.view, after.views], [before.view, before.views]);
    check('same percentage', await run(s, `document.querySelector('${WIN} .books-foot-pct').textContent`), pct);
    await s.page.click(`${WIN} [data-cmd="library"]`);
    await until(() => run(s, `!document.querySelector('${WIN} .books-library').hidden`), { label: 'library' });
    const cont = await run(s, `[...document.querySelectorAll('${WIN} .books-continue .books-card')].map((c) => [c.querySelector('.books-card-title').textContent, c.querySelector('.books-card-progress .caption')?.textContent])`);
    check('« Continue reading » lists the book with its progress', cont, [['Le Voyage de Sélène', pct]]);
    await s.shot('books-library-continue-en-light');
  });

  await section('full screen', async () => {
    await s.aurora((p) => window.__aurora.shell.openFile(p), F.voyage);
    await atChapter(s, 2);
    await A(s, (app) => app.reader.viewEl.focus());
    await press(s, 'F11');
    check('F11: full screen', await A(s, (app) => app.win.fullscreen), true);
    check('button label', await run(s, `document.querySelector('${WIN} [data-cmd="fullscreen"]').getAttribute('aria-label')`), 'Exit full screen');
    await until(async () => (await R(s)).spine === 2 && !(await R(s)).loading, { label: 'relayout' });
    await press(s, 'Escape');
    check('Escape leaves full screen', await A(s, (app) => app.win.fullscreen), false);
  });

  await section('right-to-left book', async () => {
    await s.aurora((p) => window.__aurora.shell.openFile(p), F.rtl);
    let st = await atChapter(s, 0, 'rtl chapter');
    check('several pages', st.views > 1, true);
    await A(s, (app) => app.reader.viewEl.focus());
    await press(s, 'ArrowLeft');
    st = await R(s);
    check('← is the next page in a right-to-left book', st.view, 1);
    check('pages move to the right', await frameEval(s, (d, f, app) => d.body.style.transform === `translateX(${app.reader.cur.step}px)`), true);
    const pt = await A(s, (app) => {
      const r = app.reader.cur.frame.getBoundingClientRect();
      return { x: r.left + r.width * 0.05, y: r.top + r.height / 2 };
    });
    await s.page.mouse.click(pt.x, pt.y);
    await sleep(250);
    check('click on the left edge: next page', (await R(s)).view, 2);
    await press(s, 'ArrowRight', 2);
    check('→ goes back', (await R(s)).view, 0);
    await press(s, 'End');
    await press(s, 'ArrowLeft');
    st = await atChapter(s, 1, 'rtl chapter 2');
    check('past the last page: next chapter', st.view, 0);
    check('the heading of a page is found in its page', await A(s, (app) => app.reader.viewOf(app.reader.cur.doc.getElementById('start-2'))), 0);
    await s.shot('books-rtl-en-light');
  });

  await section('protected and damaged books', async () => {
    await s.aurora((p) => window.__aurora.shell.openFile(p), F.drm);
    await until(async () => (await R(s))?.errorShown, { label: 'DRM message' });
    check('DRM: clear message', await run(s, `document.querySelector('${WIN} .books-error-card').innerText`), (t) => /This book is protected/.test(t) && /DRM/.test(t));
    await s.shot('books-drm-en-light');
    await s.page.click(`${WIN} [data-cmd="error-back"]`);
    await until(() => run(s, `!document.querySelector('${WIN} .books-library').hidden`), { label: 'library' });
    check('library card marked protected', await run(s, `document.querySelector('${WIN} .books-grid .books-card[data-path="${F.drm}"] .books-card-status').textContent`), 'Protected (DRM)');
    for (const [name, p] of [['broken', F.broken], ['notzip', F.notzip]]) {
      await s.aurora((x) => window.__aurora.shell.openFile(x), p);
      await until(async () => (await R(s))?.errorShown, { label: `${name} message` });
      check(`${name}: damaged message`, await run(s, `document.querySelector('${WIN} .books-error-card .subtitle').textContent`), 'This book can’t be opened');
    }
    await s.aurora((x) => window.__aurora.shell.openFile(x), F.badentry);
    await atChapter(s, 0, 'good chapter');
    check('good chapter of a damaged book shown', await frameEval(s, (d) => d.body.textContent.includes('Ce chapitre se lit')), true);
    await A(s, (app) => app.reader.viewEl.focus());
    await press(s, 'ArrowRight');
    await until(async () => (await R(s)).error, { label: 'chapter error' });
    check('damaged chapter: message in the page, no crash', await run(s, `document.querySelector('${WIN} .books-chap-error')?.innerText`), (t) => /can’t be shown/.test(t));
    await press(s, 'ArrowLeft');
    const st = await atChapter(s, 0, 'back to chapter 1');
    check('navigation still works', st.error, false);
    await s.page.click(`${WIN} [data-cmd="library"]`);
  });

  await section('remove from the library, move to the trash', async () => {
    await until(() => run(s, `!document.querySelector('${WIN} .books-library').hidden`), { label: 'library' });
    const n0 = (await libCards(s)).length;
    await s.page.click(`${WIN} .books-grid .books-card[data-path="${F.garden}"]`, { button: 'right' });
    await s.page.locator('.menu .menu-item', { hasText: 'Remove from the library' }).click();
    await sleep(200);
    check('removed from the library', (await libCards(s)).some((c) => c.path === F.garden), false);
    check('… the file is kept', fs.existsSync(F.garden), true);
    await A(s, (app) => app.scan());
    await sleep(300);
    check('the folder scan does not bring it back', (await libCards(s)).some((c) => c.path === F.garden), false);
    // trash: cancel first
    await s.page.click(`${WIN} .books-grid .books-card[data-path="${F.added}"]`, { button: 'right' });
    await s.page.locator('.menu .menu-item', { hasText: 'Delete the file' }).click();
    check('confirmation asked', await until(() => run(s, `document.querySelector(${JSON.stringify(DLG)})?.innerText`), { label: 'confirm' }), (t) => /Winter Letters/.test(t) && /trash/.test(t));
    await dialogButton(s, 'Cancel');
    check('cancel keeps the file and the book', [fs.existsSync(F.added), (await libCards(s)).some((c) => c.path === F.added)], [true, true]);
    await s.page.click(`${WIN} .books-grid .books-card[data-path="${F.added}"]`, { button: 'right' });
    await s.page.locator('.menu .menu-item', { hasText: 'Delete the file' }).click();
    await dialogButton(s, 'Move to trash');
    await until(async () => !(await libCards(s)).some((c) => c.path === F.added), { label: 'gone from the library' });
    check('file moved to the trash', [fs.existsSync(F.added), fs.existsSync(path.join(s.home, '.local/share/Trash/files/added.epub'))], [false, true]);
    check('library count', (await libCards(s)).length, n0 - 2);
    // a book whose file disappeared
    fs.renameSync(F.classique, `${F.classique}.moved`);
    await A(s, (app) => app.library.checkMissing());
    await until(() => run(s, `(() => { const c = document.querySelector('${WIN} .books-grid .books-card[data-path="${F.classique}"]'); return !c || c.classList.contains('missing'); })()`), { label: 'missing' }).catch(() => null);
    // (found books never opened disappear; this one was not opened)
    check('vanished found book dropped or marked missing', await run(s, `(() => { const c = document.querySelector('${WIN} .books-grid .books-card[data-path="${F.classique}"]'); return !c || c.classList.contains('missing'); })()`), true);
    fs.renameSync(`${F.classique}.moved`, F.classique);
  });

  await section('console errors', async () => {
    const errs = s.logs.filter((l) => /^\[(error|pageerror)\]/.test(l) && !/Failed to load resource|Content Security Policy|Blocked script execution|sandboxed|Refused to/.test(l));
    check('no console errors', errs, []);
  });

  // settings kept across a restart: the French run checks this text size
  await A(s, (app) => app.store.setPref('fontSize', 110));
  await A(s, (app) => app.store.flush());
  await s.close();
  server.close();
}

// ================================================================== app, French, dark, same home
async function runFrench(state) {
  console.log('Livres — app (fr, dark, after a restart)');
  const s = await launchShell({ lang: 'fr', theme: 'dark', home: state.home });
  const F = state.F;
  await section('fr: library after a restart', async () => {
    await s.aurora(() => window.__aurora.registry.launch('books'));
    await until(async () => (await libCards(s)).length >= 3, { label: 'library' });
    check('French strings', await run(s, `[document.querySelector('${WIN} .books-lib-title').textContent, document.querySelector('${WIN} .books-section-title').textContent, document.querySelector('${WIN} .books-lib-head .books-add').textContent]`), ['Bibliothèque', 'Continuer la lecture', 'Ajouter des livres']);
    check('progress kept', await run(s, `document.querySelector('${WIN} .books-continue .books-card-progress .caption')?.textContent`), (t) => /\d+\s?%/.test(t || ''));
    check('removed book still hidden', (await libCards(s)).some((c) => c.path === F.garden), false);
    await sleep(300);
    await s.shot('books-library-fr-dark');
    // live language switch
    await s.aurora(() => window.__aurora.settings.set('lang', 'en'));
    await until(() => run(s, `document.querySelector('${WIN} .books-lib-title')?.textContent === 'Library'`), { label: 'English' });
    check('language switch: English labels', await run(s, `document.querySelector('${WIN} .books-lib-head .books-add').textContent`), 'Add books');
    await s.aurora(() => window.__aurora.settings.set('lang', 'fr'));
    await until(() => run(s, `document.querySelector('${WIN} .books-lib-title')?.textContent === 'Bibliothèque'`), { label: 'French again' });
    check('language switch back: French labels, cards kept', [await run(s, `document.querySelector('${WIN} .books-lib-head .books-add').textContent`), (await libCards(s)).length >= 3], ['Ajouter des livres', true]);
  });
  await section('fr: reader in the dark shell, position kept', async () => {
    check('« Continuer la lecture » lists the books in progress', await run(s, `[...document.querySelectorAll('${WIN} .books-continue .books-card-title')].map((x) => x.textContent)`), (l) => l.includes('Le Voyage de Sélène'));
    await s.page.click(`${WIN} .books-continue .books-card[data-path="${F.voyage}"]`);
    const st = await atChapter(s, 2, 'restored chapter');
    const saved = JSON.parse(fs.readFileSync(path.join(state.home, '.config/aurora/apps/books/library.json'), 'utf8')).books.find((b) => b.path === F.voyage);
    check('restored at the saved position', st.view, Math.floor(saved.pos.ratio * st.views + 1e-6));
    check('automatic theme: dark in a dark shell', await A(s, (app) => app.reader.el.dataset.reading), 'dark');
    check('reading settings kept across a restart (text size 110 %)', await frameEval(s, (d) => parseFloat(getComputedStyle(d.documentElement).fontSize)), (v) => Math.abs(v - 17.6) < 0.2);
    await A(s, (app) => app.store.setPref('fontSize', 100));
    check('French chrome', await run(s, `[document.querySelector('${WIN} [data-cmd="library"]').textContent.trim(), document.querySelector('${WIN} .books-foot-page').textContent]`), (v) => v[0] === 'Bibliothèque' && /^Page \d+ sur \d+$/.test(v[1]));
    await s.shot('books-reader-fr-dark');
    await s.page.click(`${WIN} [data-cmd="appearance"]`);
    check('flyout in French', await run(s, `document.querySelector('${WIN} .books-flyout').innerText`), (t) => /Taille du texte/.test(t) && /Interligne/.test(t) && /Sépia/.test(t) && /Défilement/.test(t));
    await s.shot('books-flyout-fr-dark');
    await s.page.click(`${WIN} .books-theme[data-value="sepia"]`);
    await sleep(300);
    await press(s, 'Escape');
    await s.shot('books-reader-fr-sepia');
    await s.page.click(`${WIN} [data-cmd="appearance"]`);
    await s.page.click(`${WIN} .books-theme[data-value="auto"]`);
    await press(s, 'Escape');
    await s.page.click(`${WIN} [data-cmd="toc"]`);
    await s.page.click(`${WIN} .books-side-tab[data-tab="bookmarks"]`);
    check('bookmark kept across the restart', await run(s, `document.querySelectorAll('${WIN} .books-mark').length`), 1);
    await s.page.click(`${WIN} .books-side-tab[data-tab="search"]`);
    await s.page.fill(`${WIN} .books-search-input`, 'astrolabe');
    await press(s, 'Enter');
    await until(() => run(s, `/5 résultats/.test(document.querySelector('${WIN} .books-search-status').textContent)`), { label: 'résultats' });
    check('French result count', await run(s, `document.querySelector('${WIN} .books-search-status').textContent`), '5 résultats');
    await s.shot('books-search-fr-dark');
  });
  await section('fr: protected book message', async () => {
    await s.aurora((p) => window.__aurora.shell.openFile(p), F.drm);
    await until(async () => (await R(s))?.errorShown, { label: 'DRM message' });
    check('DRM message in French', await run(s, `document.querySelector('${WIN} .books-error-card').innerText`), (t) => /Ce livre est protégé/.test(t) && /Retour à la bibliothèque/.test(t));
    await s.shot('books-drm-fr-dark');
  });
  await section('fr: narrow window', async () => {
    await s.aurora((p) => window.__aurora.shell.openFile(p), F.voyage);
    await atChapter(s, 2);
    await A(s, (app) => app.win.setSize(480, 600));
    await sleep(600);
    const r = await run(
      s,
      `(() => { const win = document.querySelector('${WIN}').getBoundingClientRect(); const out = [...document.querySelectorAll('${WIN} .books-rbar *, ${WIN} .books-foot *')].filter((e) => { const b = e.getBoundingClientRect(); return b.width && (b.right > win.right + 1 || b.left < win.left - 1); }).length; return { out, label: getComputedStyle(document.querySelector('${WIN} .books-back-label')).display }; })()`,
    );
    check('toolbar fits a narrow window', r, { out: 0, label: 'none' });
    await s.page.click(`${WIN} [data-cmd="toc"]`);
    check('side panel overlays in a narrow window', await run(s, `document.querySelector('${WIN} .books-side').classList.contains('overlay')`), true);
    await sleep(300);
    await s.shot('books-narrow-fr-dark');
    await press(s, 'Escape');
  });
  await section('fr: light shell', async () => {
    await s.aurora(() => window.__aurora.settings.set('theme', 'light'));
    await A(s, (app) => app.win.setSize(1120, 780));
    await sleep(800);
    check('automatic theme: light in a light shell', await A(s, (app) => app.reader.el.dataset.reading), 'light');
    await s.shot('books-reader-fr-light');
    await s.page.click(`${WIN} [data-cmd="library"]`);
    await until(() => run(s, `!document.querySelector('${WIN} .books-library').hidden`), { label: 'library' });
    await sleep(300);
    await s.shot('books-library-fr-light');
  });
  await section('fr: console errors', async () => {
    const errs = s.logs.filter((l) => /^\[(error|pageerror)\]/.test(l) && !/Failed to load resource|Content Security Policy|Blocked script execution|sandboxed|Refused to/.test(l));
    check('no console errors', errs, []);
  });
  await s.close();
}

// ================================================================== main
const state = {};
try {
  if (!only || only.includes('backend')) await runBackend();
  if (!only || only.split('|').some((o) => !o.startsWith('backend'))) {
    await runMain(state);
    if (!only || only.split('|').some((o) => o.startsWith('fr'))) await runFrench(state);
  }
} catch (err) {
  failures.push(`fatal: ${err?.stack || err}`);
} finally {
  if (state.home) fs.rmSync(state.home, { recursive: true, force: true });
}
console.log(`\n${passed} checks passed, ${failures.length} failed`);
if (failures.length) {
  console.log(`\nFailures:\n  - ${failures.join('\n  - ')}`);
  process.exitCode = 1;
}
