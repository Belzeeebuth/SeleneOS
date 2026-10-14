// Polices (Fonts) tests: renderer/apps/fonts + main/ipc/fonts.js, in the real Electron shell driven by Playwright.
//   Fontconfig is pinned to test/fixtures/fonts/fonts.conf (FONTCONFIG_FILE): the « system » fonts are the fixture
//   fonts (Atkinson Hyperlegible ×4, Fira Mono, Libre Baskerville variable, Sacramento) and the user fonts are the
//   throwaway HOME's ~/.local/share/fonts, so the list is the same on every machine.
//   1. Parser (plain Node): names, version, licence, PANOSE / shape categories, fvar instances, cmap coverage,
//      collections (a .ttc built here), WOFF and WOFF2 (built here), magic-byte and directory checks.
//   2. Shell: list, filters, search, sample text, size, grid / list, preview background, prefs; family page (every
//      style in its own face, variable instances, size waterfall), character map (covered groups, click / Enter to
//      copy), details (version, licence); a font file opened from Fichiers -> preview window -> « Installer pour moi »
//      -> user font (fc-list in the test HOME, notepad:fonts and paint:fonts see it) -> « Déjà installée » ->
//      uninstall (Trash); a fake .ttf (wrong magic) refused; WOFF previewed but not installable; conflict + replace;
//      drag and drop with confirmation; preview faces released when windows close; en / fr, light / dark screenshots.
// Usage:  cd aurora-os/shell && xvfb-run -a -s "-screen 0 1600x900x24" node test/fonts.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { launchShell, ROOT } from './lib.mjs';

const require = createRequire(import.meta.url);
const FIX = path.join(ROOT, 'test', 'fixtures', 'fonts');
const CONF = path.join(FIX, 'fonts.conf');
const SYS = path.join(FIX, 'system');
const EXTRA = path.join(FIX, 'extra');
const fontsBackend = require(path.join(ROOT, 'main', 'ipc', 'fonts.js'));
const P = fontsBackend.parse;

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

// ------------------------------------------------------------------ font builders (collections, web fonts)
function sfntTables(buf) {
  const n = buf.readUInt16BE(4);
  const tables = [];
  for (let i = 0; i < n; i++) {
    const o = 12 + 16 * i;
    const off = buf.readUInt32BE(o + 8);
    const len = buf.readUInt32BE(o + 12);
    tables.push({ tag: buf.toString('latin1', o, o + 4), checksum: buf.readUInt32BE(o + 4), data: buf.subarray(off, off + len) });
  }
  return { version: buf.readUInt32BE(0), tables };
}
const pad4 = (n) => (n + 3) & ~3;
/** A TrueType collection of several sfnt files. */
function buildTTC(bufs) {
  const fonts = bufs.map(sfntTables);
  let off = 12 + 4 * fonts.length;
  const dirs = fonts.map((f) => {
    const at = off;
    off += 12 + 16 * f.tables.length;
    return at;
  });
  for (const f of fonts) for (const t of f.tables) {
    t.offset = off;
    off += pad4(t.data.length);
  }
  const out = Buffer.alloc(off);
  out.write('ttcf', 0, 'latin1');
  out.writeUInt32BE(0x00010000, 4);
  out.writeUInt32BE(fonts.length, 8);
  fonts.forEach((f, i) => {
    out.writeUInt32BE(dirs[i], 12 + 4 * i);
    const d = dirs[i];
    out.writeUInt32BE(f.version, d);
    out.writeUInt16BE(f.tables.length, d + 4);
    f.tables.forEach((t, k) => {
      const r = d + 12 + 16 * k;
      out.write(t.tag, r, 'latin1');
      out.writeUInt32BE(t.checksum, r + 4);
      out.writeUInt32BE(t.offset, r + 8);
      out.writeUInt32BE(t.data.length, r + 12);
      t.data.copy(out, t.offset);
    });
  });
  return out;
}
/** WOFF 1.0 (zlib per table). */
function buildWOFF(buf) {
  const f = sfntTables(buf);
  const n = f.tables.length;
  let off = 44 + 20 * n;
  const parts = f.tables.map((t) => {
    const z = zlib.deflateSync(t.data);
    const data = z.length < t.data.length ? z : t.data;
    const at = off;
    off += pad4(data.length);
    return { ...t, comp: data, at };
  });
  const out = Buffer.alloc(off);
  out.write('wOFF', 0, 'latin1');
  out.writeUInt32BE(f.version, 4);
  out.writeUInt32BE(off, 8);
  out.writeUInt16BE(n, 12);
  out.writeUInt32BE(12 + 16 * n + f.tables.reduce((s, t) => s + pad4(t.data.length), 0), 16);
  out.writeUInt16BE(1, 20);
  parts.forEach((t, i) => {
    const r = 44 + 20 * i;
    out.write(t.tag, r, 'latin1');
    out.writeUInt32BE(t.at, r + 4);
    out.writeUInt32BE(t.comp.length, r + 8);
    out.writeUInt32BE(t.data.length, r + 12);
    out.writeUInt32BE(t.checksum, r + 16);
    t.comp.copy(out, t.at);
  });
  return out;
}
const WOFF2_TAGS = ['cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca', 'prep', 'CFF ', 'VORG', 'EBDT', 'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB'];
function base128(v) {
  const bytes = [];
  do {
    bytes.unshift(v & 0x7f);
    v = Math.floor(v / 128);
  } while (v > 0);
  return bytes.map((b, i) => (i < bytes.length - 1 ? b | 0x80 : b));
}
/** WOFF2 with null transforms (glyf / loca stored as they are), brotli-compressed. */
function buildWOFF2(buf) {
  const f = sfntTables(buf);
  const dir = [];
  for (const t of f.tables) {
    const known = WOFF2_TAGS.indexOf(t.tag);
    const nullT = t.tag === 'glyf' || t.tag === 'loca' ? 3 << 6 : 0;
    if (known >= 0) dir.push(known | nullT);
    else dir.push(63 | nullT, ...Buffer.from(t.tag, 'latin1'));
    dir.push(...base128(t.data.length));
  }
  const comp = zlib.brotliCompressSync(Buffer.concat(f.tables.map((t) => t.data)));
  const len = pad4(48 + dir.length + comp.length);
  const out = Buffer.alloc(len);
  out.write('wOF2', 0, 'latin1');
  out.writeUInt32BE(f.version, 4);
  out.writeUInt32BE(len, 8);
  out.writeUInt16BE(f.tables.length, 12);
  out.writeUInt32BE(12 + 16 * f.tables.length + f.tables.reduce((s, t) => s + pad4(t.data.length), 0), 16);
  out.writeUInt32BE(comp.length, 20);
  out.writeUInt16BE(1, 24);
  Buffer.from(dir).copy(out, 48);
  comp.copy(out, 48 + dir.length);
  return out;
}

async function info(buf, index = 0) {
  const dir = await P.directory(P.bufferReader(buf), index);
  return { dir, d: await P.describe(dir) };
}
const covers = (ranges, c) => ranges.some(([a, z]) => c >= a && c <= z);

// ------------------------------------------------------------------ shell helpers
const fixtureEnv = (home) => ({
  FONTCONFIG_FILE: CONF,
  XDG_DATA_HOME: path.join(home, '.local', 'share'),
  XDG_CACHE_HOME: path.join(home, '.cache'),
  XDG_CONFIG_HOME: path.join(home, '.config'),
});
async function launch(opts = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-home-'));
  const s = await launchShell({ home, size: '1440x900', settle: 600, ...opts, env: fixtureEnv(home) });
  s.cleanup = async () => {
    await s.close();
    fs.rmSync(home, { recursive: true, force: true });
  };
  return s;
}
/** Families fontconfig lists in this HOME (same config as the shell). */
function fcFamilies(home) {
  const out = execFileSync('fc-list', ['--format', '%{family[0]}|%{file}\n'], { env: { ...process.env, HOME: home, ...fixtureEnv(home) }, encoding: 'utf8' });
  const map = {};
  for (const line of out.split('\n').filter(Boolean)) {
    const [fam, file] = line.split('|');
    (map[fam] ||= []).push(file);
  }
  return map;
}
const MAN = '.fv-manager';
/** Evaluate fn(app, arg) with the Manager (kind 'm') or the newest Preview (kind 'p') object. */
function W(s, kind, fn, arg) {
  return s.page.evaluate(
    `(async () => {
      const wins = [...document.querySelectorAll('.win.app-fonts')].filter((w) => w.__fonts && !w.__fonts.win?.closed);
      const pick = ${JSON.stringify(kind)} === 'm' ? wins.find((w) => w.__fonts.families) : wins.filter((w) => w.__fonts.file != null).pop();
      return (${fn.toString()})(pick && pick.__fonts, ${JSON.stringify(arg ?? null)});
    })()`,
  );
}
const M = (s, fn, arg) => W(s, 'm', fn, arg);
const PV = (s, fn, arg) => W(s, 'p', fn, arg);
async function until(s, kind, fn, { timeout = 10000, label = 'condition', arg } = {}) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    last = await W(s, kind, fn, arg).catch((e) => `ERR ${e.message}`);
    if (last && !String(last).startsWith('ERR')) return last;
    await sleep(100);
  }
  throw new Error(`timeout waiting for ${label} (last: ${JSON.stringify(last)})`);
}
async function clickDialogButton(s, label) {
  await s.page.waitForSelector('.dialog-footer button', { timeout: 5000 });
  const ok = await s.page.evaluate((l) => {
    const b = [...document.querySelectorAll('.dialog-footer button')].find((x) => x.textContent.trim() === l);
    b?.click();
    return !!b;
  }, label);
  if (!ok) throw new Error(`no dialog button ${label}`);
  await sleep(250);
}
const appErrors = (s) => s.logs.filter((l) => /pageerror|\[error\]/.test(l) && !/favicon|net::ERR|Failed to load resource|Autofill|dbus|GPU|gpu|weather|open-meteo/i.test(l));
/** Width of a text drawn with font-family: <name> (another app's text field): equal widths = the same fallback. */
const drawnWidth = (s, family) =>
  s.page.evaluate((ff) => {
    const el = document.createElement('span');
    el.style.cssText = `position:fixed;left:0;top:0;font-size:40px;white-space:nowrap;font-family:${ff}`;
    el.textContent = 'Portez ce vieux whisky au juge blond';
    document.body.appendChild(el);
    const w = Math.round(el.getBoundingClientRect().width);
    el.remove();
    return w;
  }, family);
const invoke = (s, ch, ...args) => s.page.evaluate(([c, a]) => window.aurora.invoke(c, ...a), [ch, args]);
async function closeFontsWindows(s, kind) {
  await s.page.evaluate((k) => {
    for (const w of window.__aurora.wm.list().filter((x) => x.appId === 'fonts')) {
      const app = w.el.__fonts;
      if (k === 'all' || (k === 'p' && app?.file != null) || (k === 'm' && app?.families)) w.close(true);
    }
  }, kind);
  await sleep(400);
}

console.log('Fonts');

// ================================================================== 1. parser (plain Node)
await section('parser: names, version, licence, categories, variable instances, coverage', async () => {
  const atk = await info(fs.readFileSync(path.join(SYS, 'AtkinsonHyperlegible-Regular.ttf')));
  check('atkinson family / style', [atk.d.family, atk.d.style, atk.d.container, atk.d.format], ['Atkinson Hyperlegible', 'Regular', 'sfnt', 'truetype']);
  check('atkinson version, licence, embedding', [atk.d.version, atk.d.licenseKind, atk.d.embedding], ['1.006', 'OFL-1.1', 'installable']);
  check('atkinson: no PANOSE, sans by name / shape', [atk.d.panose.every((x) => x === 0), atk.d.category, atk.d.shape.foot < 1.2], [true, 'sans', true]);
  const crimson = await info(fs.readFileSync(path.join(EXTRA, 'CrimsonText-Regular.ttf')));
  check('crimson: serif feet found in the outlines', [crimson.d.shape.foot >= 1.45, P.classify({ name: 'Unknown Face', shape: crimson.d.shape })], [true, 'serif']);
  const sac = await info(fs.readFileSync(path.join(SYS, 'Sacramento-Regular.ttf')));
  check('sacramento: an upright face that leans = script', [sac.d.italic, Math.abs(sac.d.shape.slant) >= 8, sac.d.category], [false, true, 'script']);
  const fira = await info(fs.readFileSync(path.join(SYS, 'FiraMono-Regular.ttf')));
  check('fira mono: fixed pitch -> mono', [fira.d.fixedPitch, fira.d.category], [true, 'mono']);
  const fcm = P.parseCmap(await fira.dir.table('cmap'));
  check('fira mono covers é, «, —, Greek Ω, Cyrillic Ж', [0xe9, 0xab, 0x2014, 0x3a9, 0x416].map((c) => covers(fcm, c)), [true, true, true, true, true]);
  const acm = P.parseCmap(await atk.dir.table('cmap'));
  check('atkinson covers œ but no Cyrillic', [covers(acm, 0x153), covers(acm, 0x416)], [true, false]);
  const lb = await info(fs.readFileSync(path.join(SYS, 'LibreBaskerville[wght].ttf')));
  check('libre baskerville: variable, wght 400–700, named instances', [lb.d.variable, lb.d.axes.map((a) => [a.tag, a.min, a.max]), lb.d.instances.map((i) => `${i.name}:${i.coords.wght}`)], [
    true,
    [['wght', 400, 700]],
    ['Regular:400', 'Medium:500', 'SemiBold:600', 'Bold:700'],
  ]);
  const cant = await info(fs.readFileSync(path.join(EXTRA, 'Cantarell-VF.otf')));
  check('cantarell: CFF2 OpenType, variable', [cant.d.family, cant.d.format, cant.d.variable], ['Cantarell', 'cff2', true]);
  check('classify by name', ['DejaVu Sans Mono', 'Noto Serif', 'Noto Sans', 'Dancing Script', 'Noto Color Emoji', 'Big Shoulders Display'].map((n) => P.classify({ name: n })), ['mono', 'serif', 'sans', 'script', 'symbol', 'decorative']);
  check('classify by PANOSE / IBM class', [P.classify({ name: 'X', panose: [3] }), P.classify({ name: 'X', panose: [2, 2] }), P.classify({ name: 'X', familyClass: 8 << 8 }), P.classify({ name: 'X' })], ['script', 'serif', 'sans', 'other']);
  check('licences', [P.licenseKind('', 'https://scripts.sil.org/OFL'), P.licenseKind('Licensed under the Apache License, Version 2.0'), P.licenseKind('whatever')], ['OFL-1.1', 'Apache-2.0', null]);
  check('fontconfig weights -> CSS', [0, 50, 80, 100, 180, 200, 210].map(P.cssWeight), [100, 300, 400, 500, 600, 700, 900]);
  check('Mac Roman table has 128 characters', P.MAC_ROMAN.length, 128);
  const rows = P.parseFcList('Noto Sans,Noto Sans Medium\ten,en\tMedium,Regular\ten,en\t/x/NotoSans-Medium.ttf\t0\t\t100\t0\t100\tFalse\tTrueType\taa|en|fr|ru\n.Hidden\ten\tRegular\ten\t/x/h.ttf\t0\t\t80\t0\t100\tFalse\tTrueType\ten\nBitmap\ten\tRegular\ten\t/x/b.pcf.gz\t0\t\t80\t0\t100\tFalse\tPCF\ten\n');
  check('fc-list rows: typographic family, CSS weight, langs; hidden and bitmap fonts skipped', rows.map((r) => [r.family, r.style, r.weight, r.langs.join(',')]), [['Noto Sans', 'Medium', 500, 'en,fr,ru']]);
});

await section('parser: collections, WOFF, WOFF2, invalid files', async () => {
  const reg = fs.readFileSync(path.join(SYS, 'AtkinsonHyperlegible-Regular.ttf'));
  const bold = fs.readFileSync(path.join(SYS, 'AtkinsonHyperlegible-Bold.ttf'));
  const ttc = buildTTC([reg, bold]);
  const f1 = await info(ttc, 1);
  check('ttc: two faces, face 1 is Bold', [f1.d.container, f1.d.faces, f1.d.face, f1.d.style], ['collection', 2, 1, 'Bold']);
  const solo = await P.standalone(f1.dir);
  const s1 = await info(solo);
  check('ttc face cut out as a standalone sfnt', [s1.d.container, s1.d.style, s1.d.glyphs === f1.d.glyphs], ['sfnt', 'Bold', true]);
  const woff = await info(buildWOFF(reg));
  check('woff: names and coverage through zlib', [woff.d.container, woff.d.family, woff.d.version, covers(P.parseCmap(await woff.dir.table('cmap')), 0xe9)], ['woff', 'Atkinson Hyperlegible', '1.006', true]);
  const woff2 = await info(buildWOFF2(reg));
  check('woff2: names and shape through brotli', [woff2.d.container, woff2.d.family, woff2.d.style, woff2.d.category], ['woff2', 'Atkinson Hyperlegible', 'Regular', 'sans']);
  const fake = Buffer.from('This is not a font, just text.\n'.repeat(20));
  const err = async (buf) => {
    try {
      await P.directory(P.bufferReader(buf));
      return 'parsed';
    } catch (e) {
      return e.code;
    }
  };
  check('wrong magic -> ENOTFONT', await err(fake), 'ENOTFONT');
  const broken = Buffer.alloc(64);
  broken.writeUInt32BE(0x00010000, 0);
  broken.writeUInt16BE(9, 4); // nine tables announced, the directory runs past the end
  check('right magic, broken directory -> ENOTFONT', await err(broken), 'ENOTFONT');
  const noGlyphs = Buffer.from(reg);
  const dir = await P.directory(P.bufferReader(noGlyphs));
  let refused = 'accepted';
  try {
    for (const t of ['cmap', 'head', 'name']) if (!dir.tables.has(t)) throw new Error('missing');
    await P.validateFace({ ...dir, tables: new Map([...dir.tables].filter(([k]) => k !== 'glyf')) });
  } catch (e) {
    refused = e.code;
  }
  check('a face without outlines is refused', refused, 'ENOTFONT');
});

// ================================================================== 2. shell, French, light
const s = await launch({ lang: 'fr', theme: 'light', open: ['fonts'] });
const home = s.home;
const userFonts = path.join(home, '.local', 'share', 'fonts');
try {
  await s.page.waitForSelector(`${MAN} .fv-card.ready`, { timeout: 20000 });

  await section('list: the fixture families, each drawn in its own face', async () => {
    const st = await until(s, 'm', (m) => m.loaded && m.families.length && [...m.els.grid.querySelectorAll('.fv-card')].every((c) => c.classList.contains('ready')) && m, { label: 'cards ready' }).then(() =>
      M(s, (m) =>
        [...m.els.grid.querySelectorAll('.fv-card')].map((c) => {
          const fam = c.querySelector('.fv-card-sample').style.fontFamily.replace(/"/g, '');
          const face = [...document.fonts].find((f) => f.family.replace(/"/g, '') === fam);
          return [c.dataset.family, c.querySelector('.fv-card-sample').textContent, fam.startsWith('selene-fonts-'), face?.status];
        }),
      ),
    );
    check('families in order, French pangram, scoped aliases, loaded faces', st, [
      ['Atkinson Hyperlegible', 'Portez ce vieux whisky au juge blond qui fume', true, 'loaded'],
      ['Fira Mono', 'Portez ce vieux whisky au juge blond qui fume', true, 'loaded'],
      ['Libre Baskerville', 'Portez ce vieux whisky au juge blond qui fume', true, 'loaded'],
      ['Sacramento', 'Portez ce vieux whisky au juge blond qui fume', true, 'loaded'],
    ]);
    const widths = await M(s, (m) => [...m.els.grid.querySelectorAll('.fv-card-sample')].map((el) => {
      const r = document.createRange();
      r.selectNodeContents(el);
      return Math.round(r.getBoundingClientRect().width);
    }));
    check('the faces really differ (sample widths)', new Set(widths).size, 4);
    const lb = await M(s, (m) => m.families.find((f) => f.name === 'Libre Baskerville'));
    check('variable family: 4 named instances with their variation', lb.styles.map((x) => [x.style, x.weight, x.variation]), [
      ['Regular', 400, null],
      ['Medium', 500, '"wght" 500'],
      ['SemiBold', 600, '"wght" 600'],
      ['Bold', 700, '"wght" 700'],
    ]);
    const cats = await M(s, (m) => Object.fromEntries(m.families.map((f) => [f.name, [f.category, f.system, f.user]])));
    check('categories and origin', cats, {
      'Atkinson Hyperlegible': ['sans', true, false],
      'Fira Mono': ['mono', true, false],
      'Libre Baskerville': ['serif', true, false],
      Sacramento: ['script', true, false],
    });
    const nav = await M(s, (m) => [...m.els.nav.querySelectorAll('.fv-filter')].map((b) => [b.dataset.filter, b.querySelector('.fv-filter-label').textContent, b.querySelector('.fv-filter-count').textContent]));
    check('filters with counts (Décoratives / Symboles hidden: none)', nav, [
      ['all', 'Toutes', '4'],
      ['serif', 'Serif', '1'],
      ['sans', 'Sans serif', '1'],
      ['mono', 'Chasse fixe', '1'],
      ['script', 'Manuscrites', '1'],
      ['user', 'Installées par moi', '0'],
    ]);
    check('count line', await M(s, (m) => m.els.count.textContent), '4 polices');
    await s.shot('fonts-grid-fr-light');
  });

  await section('filters and search', async () => {
    const pick = async (id) => {
      await s.page.click(`${MAN} .fv-filter[data-filter="${id}"]`);
      return M(s, (m) => [...m.els.grid.querySelectorAll('.fv-card')].map((c) => c.dataset.family));
    };
    check('Serif', await pick('serif'), ['Libre Baskerville']);
    check('Sans serif', await pick('sans'), ['Atkinson Hyperlegible']);
    check('Chasse fixe', await pick('mono'), ['Fira Mono']);
    check('Manuscrites', await pick('script'), ['Sacramento']);
    check('Installées par moi: none', await pick('user'), []);
    check('empty state for « Installées par moi »', await M(s, (m) => [m.els.empty.hidden, m.els.empty.querySelector('.fv-empty-title')?.textContent]), [false, 'Vous n’avez installé aucune police']);
    check('selected filter is marked', await M(s, (m) => m.els.nav.querySelector('.fv-filter.selected')?.dataset.filter + ':' + m.els.nav.querySelector('[aria-pressed="true"]')?.dataset.filter), 'user:user');
    await pick('all');
    await s.page.fill(`${MAN} .fv-search`, 'fira');
    check('search « fira »', await M(s, (m) => [...m.els.grid.querySelectorAll('.fv-card')].map((c) => c.dataset.family)), ['Fira Mono']);
    await s.page.fill(`${MAN} .fv-search`, 'BASKÉRVILLE');
    check('search ignores case and accents', await M(s, (m) => [...m.els.grid.querySelectorAll('.fv-card')].map((c) => c.dataset.family)), ['Libre Baskerville']);
    await s.page.fill(`${MAN} .fv-search`, 'zzz');
    check('no match: empty state', await M(s, (m) => [m.els.grid.children.length, m.els.empty.querySelector('.fv-empty-title')?.textContent, m.els.count.textContent]), [0, 'Aucune police ne correspond à « zzz »', '0 police']);
    await s.page.focus(`${MAN} .fv-search`);
    await s.page.keyboard.press('Escape');
    check('Escape clears the search', await M(s, (m) => [m.els.search.value, m.els.grid.children.length]), ['', 4]);
    await s.page.keyboard.press('Control+f');
    check('Ctrl+F focuses the search', await M(s, (m) => document.activeElement === m.els.search), true);
    await s.page.keyboard.press('ArrowDown');
    await s.page.keyboard.press('ArrowRight');
    check('arrows move between cards', await M(s, (m) => document.activeElement?.dataset?.family), 'Fira Mono');
  });

  await section('sample text, size, list view, preview background, saved preferences', async () => {
    await s.page.fill(`${MAN} .fv-sample`, 'Bœuf, crème brûlée & « déjà » 2026');
    check('every card shows the typed text', await M(s, (m) => [...new Set([...m.els.grid.querySelectorAll('.fv-card-sample')].map((c) => c.textContent))]), ['Bœuf, crème brûlée & « déjà » 2026']);
    check('reset button appears', await M(s, (m) => m.els.sampleReset.hidden), false);
    await s.page.evaluate(() => {
      const el = document.querySelector('.fv-manager .fv-size-slider');
      el.value = '64';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    check('size 64 px: label and sample size', await M(s, (m) => [m.els.sizeVal.textContent, getComputedStyle(m.els.grid.querySelector('.fv-card-sample')).fontSize]), ['64 px', '64px']);
    await s.page.click(`${MAN} .fv-view button:nth-child(2)`);
    check('list view', await M(s, (m) => [m.els.grid.classList.contains('list'), getComputedStyle(m.els.grid.querySelector('.fv-card')).flexDirection]), [true, 'row-reverse']);
    await s.page.click(`${MAN} .fv-theme button:nth-child(3)`);
    check('dark preview background on a light window', await M(s, (m) => [m.els.content.getAttribute('data-theme'), m.els.content.hasAttribute('data-theme-scope'), document.documentElement.dataset.theme]), ['dark', true, 'light']);
    await sleep(500);
    await s.shot('fonts-list-dark-preview-fr-light');
    const saved = await until(s, 'm', (m) => m.ctx.storage.get('prefs', null).then((p) => (p && p.size === 64 && p.view === 'list' && p.theme === 'dark' ? p : null)), { label: 'prefs saved' });
    check('preferences saved', [saved.sample, saved.size, saved.view, saved.theme], ['Bœuf, crème brûlée & « déjà » 2026', 64, 'list', 'dark']);
    // back to the defaults
    await s.page.click(`${MAN} .fv-sample-reset`);
    await s.page.click(`${MAN} .fv-theme button:nth-child(1)`);
    await s.page.click(`${MAN} .fv-view button:nth-child(1)`);
    await M(s, (m) => m.setSize(32));
    check('default text, size, grid and window background again', await M(s, (m) => [m.els.grid.querySelector('.fv-card-sample').textContent, m.els.sizeVal.textContent, m.els.grid.classList.contains('list'), m.els.content.hasAttribute('data-theme')]), [
      'Portez ce vieux whisky au juge blond qui fume',
      '32 px',
      false,
      false,
    ]);
  });

  await section('family page: every style, variable instances, size waterfall', async () => {
    await s.page.click(`${MAN} .fv-card[data-family="Atkinson Hyperlegible"]`);
    await until(s, 'm', (m) => m.family && [...m.family.els.panel.querySelectorAll('.fv-style-sample')].every((e) => e.classList.contains('ready')), { label: 'styles drawn' });
    const st = await M(s, (m) => ({
      title: m.win.title ?? document.querySelector('.win.app-fonts .win-title')?.textContent,
      name: m.family.els.root.querySelector('.fv-fam-name').textContent,
      sub: m.family.els.sub.textContent,
      note: m.family.els.note.textContent,
      uninstall: !!m.family.els.root.querySelector('.fv-uninstall'),
      styles: [...m.family.els.panel.querySelectorAll('.fv-style')].map((r) => [r.querySelector('.fv-style-name').textContent, r.querySelector('.fv-style-sample').style.fontFamily]),
      back: !m.els.back.hidden,
    }));
    check('header', [st.name, st.sub, st.note, st.uninstall, st.back], ['Atkinson Hyperlegible', 'Sans serif · 4 styles Système', 'Police du système : elle est disponible pour tous les comptes et ne peut pas être désinstallée ici.', false, true]);
    check('four styles, each its own face', [st.styles.map((x) => x[0]), new Set(st.styles.map((x) => x[1])).size], [['Regular', 'Italic', 'Bold', 'Bold Italic'], 4]);
    await s.shot('fonts-family-fr-light');
    await s.page.keyboard.press('Escape');
    check('Escape goes back to the list, focus on the card', await M(s, (m) => [!!m.family, document.activeElement?.dataset?.family]), [false, 'Atkinson Hyperlegible']);
    await s.page.click(`${MAN} .fv-card[data-family="Libre Baskerville"]`);
    await until(s, 'm', (m) => m.family && [...m.family.els.panel.querySelectorAll('.fv-style-sample')].every((e) => e.classList.contains('ready')), { label: 'variable styles drawn' });
    const vb = await M(s, (m) => [...m.family.els.panel.querySelectorAll('.fv-style-sample')].map((e) => [e.style.fontFamily, getComputedStyle(e).fontVariationSettings]));
    check('variable instances share one face, each with its weight', [new Set(vb.map((x) => x[0])).size, vb.map((x) => x[1])], [1, ['normal', '"wght" 500', '"wght" 600', '"wght" 700']]);
    const widths = await M(s, (m) => [...m.family.els.panel.querySelectorAll('.fv-style-sample')].map((el) => {
      const r = document.createRange();
      r.selectNodeContents(el);
      return Math.round(r.getBoundingClientRect().width);
    }));
    check('heavier instances are wider', widths[3] > widths[0], true);
    await s.page.click(`${MAN} .fv-tab[data-tab="sizes"]`);
    const wf = await until(s, 'm', (m) => {
      const rows = [...m.family.els.panel.querySelectorAll('.fv-wf-row')];
      return rows.length && rows.every((r) => r.querySelector('.fv-text').classList.contains('ready')) && rows.map((r) => [r.querySelector('.fv-wf-size').textContent, getComputedStyle(r.querySelector('.fv-text')).fontSize]);
    }, { label: 'waterfall' });
    check('waterfall 10 … 96 px', [wf.length, wf[0], wf[wf.length - 1]], [14, ['10 px', '10px'], ['96 px', '96px']]);
    await s.page.selectOption(`${MAN} .fv-style-select`, '3');
    const bold = await until(s, 'm', (m) => [...m.family.els.panel.querySelectorAll('.fv-wf-sample.ready')].length === 14 && getComputedStyle(m.family.els.panel.querySelector('.fv-wf-sample')).fontVariationSettings, { label: 'waterfall in Bold' });
    check('style picker: waterfall in Bold', bold, '"wght" 700');
    check('tabs: aria-selected follows', await M(s, (m) => [...m.family.els.tabs.querySelectorAll('[role="tab"]')].map((b) => b.getAttribute('aria-selected'))), ['false', 'true', 'false', 'false']);
    await s.page.focus(`${MAN} .fv-tab[data-tab="sizes"]`);
    await s.page.keyboard.press('ArrowRight');
    check('arrow keys switch tabs', await M(s, (m) => [m.family.tab, document.activeElement?.dataset?.tab]), ['chars', 'chars']);
  });

  await section('character map: covered groups, click / Enter copies', async () => {
    await M(s, (m) => m.closeFamily());
    await s.page.click(`${MAN} .fv-card[data-family="Fira Mono"]`);
    await s.page.click(`${MAN} .fv-tab[data-tab="chars"]`);
    const blocks = await until(s, 'm', (m) => {
      const b = [...m.family.els.panel.querySelectorAll('.fv-block')];
      return b.length && b.map((x) => [x.dataset.block, x.querySelector('.fv-block-count').textContent]);
    }, { label: 'char blocks' });
    check('Fira Mono groups (Greek and Cyrillic covered)', blocks.map((b) => b[0]), ['upper', 'lower', 'digits', 'accents', 'punct', 'symbols', 'latinExt', 'greek', 'cyrillic', 'other']);
    check('full Latin, accents for French', [blocks[0][1], blocks[1][1], blocks.find((b) => b[0] === 'accents')[1]], ['26 sur 26', '26 sur 26', '65 sur 65']);
    const cells = await M(s, (m) => {
      const one = (cp) => m.family.els.panel.querySelector(`.fv-glyph[data-cp="${cp}"]`);
      return [0xe9, 0x153, 0xab, 0xbb, 0x2013, 0x2014, 0x2026, 0x3a9, 0x416].map((cp) => !!one(cp));
    });
    check('é œ « » – — … Ω Ж are in the map', cells, [true, true, true, true, true, true, true, true, true]);
    check('glyphs drawn in the face', await until(s, 'm', (m) => m.family.els.panel.querySelector('.fv-glyph')?.style.fontFamily.includes('selene-fonts-')), true);
    await s.page.click(`${MAN} .fv-glyph[data-cp="233"]`);
    check('click copies « é »', await invoke(s, 'clipboard:readText'), 'é');
    check('copy feedback', await M(s, (m) => [m.family.els.charStatus.textContent, m.els.toast.textContent, !!m.family.els.panel.querySelector('.fv-glyph.copied[data-cp="233"]')]), [
      '« é » (U+00E9) copié dans le presse-papiers',
      '« é » (U+00E9) copié dans le presse-papiers',
      true,
    ]);
    await s.page.focus(`${MAN} .fv-glyph[data-cp="65"]`);
    await s.page.keyboard.press('ArrowRight');
    await s.page.keyboard.press('Enter');
    check('arrows + Enter copy « B »', await invoke(s, 'clipboard:readText'), 'B');
    check('roving focus: one tabbable glyph', await M(s, (m) => m.family.els.panel.querySelectorAll('.fv-glyph[tabindex="0"]').length), 1);
    await s.shot('fonts-chars-fr-light');
    // a Latin-only family has no Greek group
    await M(s, (m) => m.openFamily('Atkinson Hyperlegible', { tab: 'chars' }));
    const atk = await until(s, 'm', (m) => {
      const b = [...m.family.els.panel.querySelectorAll('.fv-block')];
      return b.length && Object.fromEntries(b.map((x) => [x.dataset.block, x.querySelectorAll('.fv-glyph').length]));
    }, { label: 'atkinson blocks' });
    check('Atkinson: accents, a few Greek signs (Ω µ π…), no Cyrillic', [atk.accents, atk.greek > 0 && atk.greek < 10, 'cyrillic' in atk], [65, true, false]);
  });

  await section('details: version, format, licence, files', async () => {
    await s.page.click(`${MAN} .fv-tab[data-tab="details"]`);
    const rows = await until(s, 'm', (m) => {
      const r = [...m.family.els.panel.querySelectorAll('.fv-drow')];
      return r.length && Object.fromEntries(r.map((x) => [x.querySelector('.fv-dlabel').textContent, x.querySelector('.fv-dvalue').textContent]));
    }, { label: 'details' });
    check('details', [rows['Famille'], rows['Version'], rows['Format'], rows['Catégorie'], rows['Intégration dans les documents']], ['Atkinson Hyperlegible', '1.006', 'TrueType', 'Sans serif', 'Autorisée']);
    check('licence: name, link, text toggle', rows['Licence'], (v) => v.startsWith('SIL Open Font License 1.1 — https://') && v.includes('Afficher le texte de la licence'));
    check('four files listed', await M(s, (m) => [...m.family.els.panel.querySelectorAll('.fv-file-path')].map((e) => e.textContent.split('/').pop())), [
      'AtkinsonHyperlegible-Regular.ttf',
      'AtkinsonHyperlegible-Italic.ttf',
      'AtkinsonHyperlegible-Bold.ttf',
      'AtkinsonHyperlegible-BoldItalic.ttf',
    ]);
    await s.page.click(`${MAN} .fv-license-toggle`);
    check('licence text shown', await M(s, (m) => [m.family.els.panel.querySelector('.fv-license-text').hidden, m.family.els.panel.querySelector('.fv-license-text').textContent.includes('Open Font License'), m.family.els.panel.querySelector('.fv-license-toggle').getAttribute('aria-expanded')]), [false, true, 'true']);
    await M(s, (m) => m.closeFamily());
  });

  // ---------------------------------------------------------------- install from a file opened in Fichiers
  const dl = path.join(home, 'Downloads');
  const crimson = path.join(dl, 'CrimsonText-Regular.ttf');
  fs.copyFileSync(path.join(EXTRA, 'CrimsonText-Regular.ttf'), crimson);

  await section('open a font file -> preview -> install for me -> user font everywhere', async () => {
    check('Fichiers opens .ttf / .otf / .ttc / .otc / .woff2 with Polices', await s.page.evaluate(() => ['a.ttf', 'a.OTF', 'a.ttc', 'a.otc', 'a.woff', 'a.woff2'].map((n) => window.__aurora.registry.handlerFor(`/tmp/${n}`))), ['fonts', 'fonts', 'fonts', 'fonts', 'fonts', 'fonts']);
    const before = await invoke(s, 'notepad:fonts');
    const paintBefore = await invoke(s, 'paint:fonts');
    await s.page.evaluate(() => window.__aurora.registry.launch('notepad'));
    await sleep(800);
    const npShared = () => s.page.evaluate(async () => {
      const { shared } = await import('app://shell/apps/notepad/lib/shared.js');
      return (await shared.loadFonts()).all.includes('Crimson Text');
    });
    check('Text Editor window: its font list (renderer cache) has no Crimson Text', await npShared(), false);
    check('before: no font named Crimson Text in the shell', (await drawnWidth(s, '"Crimson Text"')) === (await drawnWidth(s, '"No Such Font"')), true);
    check('before: Text Editor and Draw do not list Crimson Text', [before.all.includes('Crimson Text'), paintBefore.includes('Crimson Text'), before.all.includes('Fira Mono'), before.mono.includes('Fira Mono')], [false, false, true, true]);
    await s.page.evaluate((p) => window.__aurora.shell.openFile(p), crimson);
    const pv = await until(s, 'p', (p) => p.d && p.els.install && p.els.big?.style.fontFamily && p, { label: 'preview ready' }).then(() =>
      PV(s, (p) => ({
        title: document.querySelectorAll('.win.app-fonts').length,
        name: p.els.root.querySelector('.fv-pv-name').textContent,
        sub: p.els.root.querySelector('.fv-pv-sub').textContent,
        big: [p.els.big.textContent, p.els.big.style.fontFamily.includes('selene-fonts-')],
        button: [p.els.install.textContent, p.els.install.disabled],
        state: p.els.foot.querySelector('.fv-pv-state').textContent,
        details: Object.fromEntries([...p.els.root.querySelectorAll('.fv-drow')].map((x) => [x.querySelector('.fv-dlabel').textContent, x.querySelector('.fv-dvalue').textContent])),
      })),
    );
    check('preview window', [pv.title, pv.name, pv.sub, pv.big], [2, 'Crimson Text', 'Regular · TrueType · Version 1.100', ['Portez ce vieux whisky au juge blond qui fume', true]]);
    check('« Installer pour moi », for this account only', [pv.button, pv.state], [['Installer pour moi', false], 'Les polices sont installées pour votre compte seulement (dans ~/.local/share/fonts). L’installation pour tous les comptes n’est pas proposée ici.']);
    check('preview details: licence', pv.details['Licence'], (v) => v.startsWith('SIL Open Font License 1.1'));
    await sleep(400);
    await s.shot('fonts-preview-fr-light');
    await s.page.click('.fv-preview .fv-install-one');
    const after = await until(s, 'p', (p) => p.d.installed === 'same' && p.els.install?.disabled && p.els.install.textContent, { label: 'installed', timeout: 20000 });
    check('button becomes « Installée pour vous »', after, 'Installée pour vous');
    check('« Afficher dans Polices » offered', await PV(s, (p) => !!p.els.foot.querySelector('.fv-open-app')), true);
    const dest = path.join(userFonts, 'Crimson Text', 'CrimsonText-Regular.ttf');
    check('copied to ~/.local/share/fonts/Crimson Text/', [fs.existsSync(dest), fs.existsSync(dest) && fs.readFileSync(dest).equals(fs.readFileSync(crimson)), fs.existsSync(crimson)], [true, true, true]);
    check('fc-list in the test HOME lists it (fc-cache ran)', fcFamilies(home)['Crimson Text'], [dest]);
    const fam = await until(s, 'm', (m) => m.families.find((f) => f.name === 'Crimson Text'), { label: 'manager reloaded' });
    check('main window: new family, user font, Serif', [fam.user, fam.system, fam.category, fam.styles[0].file], [true, false, 'serif', dest]);
    check('« Installées par moi » counts it', await M(s, (m) => m.els.nav.querySelector('[data-filter="user"] .fv-filter-count').textContent), '1');
    const card = await M(s, (m) => m.cards.get('Crimson Text')?.querySelector('.fv-badge.user')?.textContent);
    check('card badge', card, 'Installée par moi');
    const np = await invoke(s, 'notepad:fonts');
    const pt = await invoke(s, 'paint:fonts');
    check('Text Editor and Draw list Crimson Text on their next list', [np.all.includes('Crimson Text'), pt.includes('Crimson Text')], [true, true]);
    check('the open Text Editor sees it too (fonts:changed drops its cache)', await npShared(), true);
    await s.page.waitForFunction(() => document.fonts.check('40px "Crimson Text"') && [...document.fonts].some((f) => f.family.replace(/"/g, '') === 'Crimson Text' && f.status === 'loaded'), null, { timeout: 5000 });
    check('drawn by name in every app at once (session FontFace, weight 400 normal)', [(await drawnWidth(s, '"Crimson Text"')) !== (await drawnWidth(s, '"No Such Font"')), await s.page.evaluate(() => [...document.fonts].filter((f) => f.family.replace(/"/g, '') === 'Crimson Text').map((f) => `${f.weight} ${f.style} ${f.stretch}`))], [true, ['400 normal 100%']]);
    await s.page.evaluate(() => window.__aurora.wm.list().filter((w) => w.appId === 'notepad').forEach((w) => w.close(true)));
    // the same file again, and the installed file itself
    await closeFontsWindows(s, 'p');
    await s.page.evaluate((p) => window.__aurora.shell.openFile(p), crimson);
    const again = await until(s, 'p', (p) => p.els.install && [p.els.install.textContent, p.els.install.disabled, p.els.foot.querySelector('.fv-pv-state').textContent], { label: 'second preview' });
    check('same font again: « Déjà installée »', again, ['Déjà installée', true, 'Cette police est déjà installée. Vous pouvez l’utiliser dans vos applications.']);
    await closeFontsWindows(s, 'p');
    await s.page.evaluate((p) => window.__aurora.shell.openFile(p), dest);
    check('the installed file itself: « Déjà installée »', await until(s, 'p', (p) => p.els.install && [p.els.install.textContent, p.els.install.disabled], { label: 'third preview' }), ['Déjà installée', true]);
    await s.page.click('.fv-preview .fv-open-app');
    check('« Afficher dans Polices » opens the family in the main window', await until(s, 'm', (m) => m.family?.fam.name, { label: 'family shown' }), 'Crimson Text');
    await closeFontsWindows(s, 'p');
  });

  await section('uninstall a user font (to the Trash)', async () => {
    await M(s, (m) => m.openFamily('Crimson Text'));
    check('user family: « Désinstaller », no system note', await M(s, (m) => [!!m.family.els.root.querySelector('.fv-uninstall'), m.family.els.note.hidden]), [true, true]);
    await s.page.click(`${MAN} .fv-uninstall`);
    check('confirmation', await s.page.evaluate(() => document.querySelector('.dialog-title')?.textContent), 'Désinstaller « Crimson Text » ?');
    await clickDialogButton(s, 'Désinstaller');
    await until(s, 'm', (m) => !m.families.some((f) => f.name === 'Crimson Text') && !m.family, { label: 'family gone' });
    const dest = path.join(userFonts, 'Crimson Text', 'CrimsonText-Regular.ttf');
    const trash = path.join(home, '.local', 'share', 'Trash');
    check('file in the Trash with its .trashinfo, family folder removed', [fs.existsSync(dest), fs.existsSync(path.join(trash, 'files', 'CrimsonText-Regular.ttf')), fs.existsSync(path.join(trash, 'info', 'CrimsonText-Regular.ttf.trashinfo')), fs.existsSync(path.dirname(dest))], [false, true, true, false]);
    check('fc-list no longer lists it', fcFamilies(home)['Crimson Text'], undefined);
    check('Text Editor list updated', (await invoke(s, 'notepad:fonts')).all.includes('Crimson Text'), false);
    check('no longer drawn by name (session face removed)', (await drawnWidth(s, '"Crimson Text"')) === (await drawnWidth(s, '"No Such Font"')), true);
    check('toast + counts', await M(s, (m) => [m.els.toast.textContent, m.els.nav.querySelector('[data-filter="user"] .fv-filter-count').textContent]), ['« Crimson Text » est désinstallée (dans la corbeille)', '0']);
    const refused = await invoke(s, 'fonts:uninstall', [path.join(SYS, 'FiraMono-Regular.ttf')]);
    check('system fonts cannot be uninstalled', [refused.removed.length, refused.errors[0]?.code, fs.existsSync(path.join(SYS, 'FiraMono-Regular.ttf'))], [0, 'EPERM', true]);
  });

  await section('fake .ttf refused, WOFF preview only, conflicts', async () => {
    const fake = path.join(dl, 'pas-une-police.ttf');
    fs.writeFileSync(fake, 'Ceci n’est pas une police.\n'.repeat(40));
    await s.page.evaluate((p) => window.__aurora.shell.openFile(p), fake);
    const err = await until(s, 'p', (p) => p.error && p.els.root?.querySelector('.fv-pv-error') && [p.error, p.els.root.querySelector('.fv-empty-title').textContent, p.els.root.querySelector('.fv-empty-hint').textContent, !!p.els.root.querySelector('.fv-install-one')], { label: 'error page' });
    check('wrong magic: error page, no install button', err, ['ENOTFONT', 'Impossible d’ouvrir ce fichier', '« pas-une-police.ttf » n’est pas un fichier de police valide.', false]);
    await sleep(500);
    await s.shot('fonts-preview-error-fr-light');
    await closeFontsWindows(s, 'p');
    const res = await invoke(s, 'fonts:install', [fake]);
    check('backend refuses it (ENOTFONT), nothing written', [res.results[0].status, res.results[0].code, fs.existsSync(userFonts) ? fs.readdirSync(userFonts).length : 0], ['error', 'ENOTFONT', 0]);
    const renamed = path.join(dl, 'vraie-police.ttc');
    fs.copyFileSync(path.join(SYS, 'FiraMono-Regular.ttf'), renamed);
    check('a .ttc that is not a collection is refused', (await invoke(s, 'fonts:install', [renamed])).results[0].code, 'ENOTFONT');
    check('outside paths / bad arguments', [(await invoke(s, 'fonts:install', ['relative.ttf'])).results[0].code, (await invoke(s, 'fonts:install', [path.join(dl, 'missing.ttf')])).results[0].code], ['EINVAL', 'ENOENT']);
    // WOFF: previewed, never installed
    const woff = path.join(dl, 'Atkinson.woff');
    fs.writeFileSync(woff, buildWOFF(fs.readFileSync(path.join(SYS, 'AtkinsonHyperlegible-Bold.ttf'))));
    await s.page.evaluate((p) => window.__aurora.shell.openFile(p), woff);
    const w = await until(s, 'p', (p) => p.d && p.els.foot?.querySelector('.fv-pv-state') && [p.els.root.querySelector('.fv-pv-sub').textContent, !!p.els.install, p.els.foot.querySelector('.fv-pv-state').textContent, p.els.big.style.fontFamily.includes('selene-fonts-')], { label: 'woff preview' });
    check('WOFF preview: drawn, no install button', w, ['Bold · Police Web WOFF (TrueType) · Version 1.006', false, 'Les polices Web (WOFF) s’affichent mais ne s’installent pas. Installez plutôt la version TrueType ou OpenType.', true]);
    await closeFontsWindows(s, 'p');
    check('WOFF install refused (EUNSUPPORTED)', (await invoke(s, 'fonts:install', [woff])).results[0].code, 'EUNSUPPORTED');
    const woff2 = path.join(dl, 'Atkinson.woff2');
    fs.writeFileSync(woff2, buildWOFF2(fs.readFileSync(path.join(SYS, 'AtkinsonHyperlegible-Italic.ttf'))));
    await s.page.evaluate((p) => window.__aurora.shell.openFile(p), woff2);
    const w2 = await until(s, 'p', (p) => (p.d || p.error) && p.els.root && [p.d?.container, p.d?.style, !!p.alias], { label: 'woff2 preview' });
    check('WOFF2 (null transforms) previewed', w2, ['woff2', 'Italic', true]);
    await closeFontsWindows(s, 'p');
    // a collection: face picker
    const ttc = path.join(dl, 'Atkinson.ttc');
    fs.writeFileSync(ttc, buildTTC([fs.readFileSync(path.join(SYS, 'AtkinsonHyperlegible-Regular.ttf')), fs.readFileSync(path.join(SYS, 'AtkinsonHyperlegible-Bold.ttf'))]));
    await s.page.evaluate((p) => window.__aurora.shell.openFile(p), ttc);
    const c1 = await until(s, 'p', (p) => p.d && p.els.root.querySelector('.fv-face-select') && [p.els.root.querySelector('.fv-pv-sub').textContent, [...p.els.root.querySelectorAll('.fv-face-select option')].map((o) => o.textContent), !!p.alias], { label: 'ttc preview' });
    check('collection preview: faces listed, first face drawn', c1, ['Regular · Collection TrueType, 2 polices · Version 1.006', ['Atkinson Hyperlegible Regular', 'Atkinson Hyperlegible Bold'], true]);
    await s.page.selectOption('.fv-preview .fv-face-select', '1');
    check('second face', await until(s, 'p', (p) => p.d?.style === 'Bold' && p.alias && p.els.root.querySelector('.fv-pv-sub').textContent, { label: 'face 1' }), (v) => v.startsWith('Bold ·'));
    check('collection already installed (same family, style and version)', await PV(s, (p) => p.els.install?.textContent), 'Déjà installée');
    await closeFontsWindows(s, 'p');
    // conflict: another file with the same name and different bytes
    const v1 = path.join(dl, 'CrimsonText-Regular.ttf');
    const first = await invoke(s, 'fonts:install', [v1]);
    check('install again after the uninstall', first.results[0].status, 'installed');
    const otherDir = path.join(dl, 'autre');
    fs.mkdirSync(otherDir);
    const v2 = path.join(otherDir, 'CrimsonText-Regular.ttf');
    fs.writeFileSync(v2, Buffer.concat([fs.readFileSync(v1), Buffer.alloc(8)]));
    const conflict = await invoke(s, 'fonts:install', [v2]);
    const dest = path.join(userFonts, 'Crimson Text', 'CrimsonText-Regular.ttf');
    check('different bytes, same name: conflict, nothing overwritten', [conflict.results[0].status, conflict.results[0].existing, fs.statSync(dest).size === fs.statSync(v1).size], ['conflict', [dest], true]);
    const replaced = await invoke(s, 'fonts:install', [v2], { replace: true });
    const trashed = fs.readdirSync(path.join(home, '.local', 'share', 'Trash', 'files')).filter((n) => n.startsWith('CrimsonText-Regular'));
    check('replace: new bytes in place, old file in the Trash', [replaced.results[0].status, fs.statSync(dest).size === fs.statSync(v2).size, trashed.length], ['replaced', true, 2]);
    check('identical bytes: « already »', (await invoke(s, 'fonts:install', [v2])).results[0].status, 'already');
    // the UI asks before replacing
    await M(s, (m, v) => (m.__v1 = v), v1);
    await M(s, (m) => {
      m.__done = null;
      import('app://shell/apps/fonts/lib/install.js').then((mod) => mod.installFiles(m, [m.__v1], { confirm: false }).then((r) => (m.__done = r)));
    });
    await s.page.waitForSelector('.dialog-title', { timeout: 8000 });
    check('conflict dialog', await s.page.evaluate(() => [document.querySelector('.dialog-title')?.textContent, [...document.querySelectorAll('.dialog-footer button')].map((b) => b.textContent)]), ['Remplacer la police installée ?', ['Remplacer', 'Garder celles installées']]);
    await clickDialogButton(s, 'Garder celles installées');
    check('kept: still the second version', [await until(s, 'm', (m) => m.__done && m.__done[0].status, { label: 'install done' }), fs.statSync(dest).size === fs.statSync(v2).size], ['conflict', true]);
    await invoke(s, 'fonts:uninstall', [dest]);
  });

  await section('drag and drop installs after a confirmation', async () => {
    const a = path.join(dl, 'CrimsonText-Regular.ttf');
    const txt = path.join(dl, 'notes.txt');
    fs.writeFileSync(txt, 'hello');
    await M(s, (m) => m.closeFamily());
    const drop = (paths) =>
      s.page.evaluate((list) => {
        const el = document.querySelector('.fv-manager');
        document.dispatchEvent(new DragEvent('dragstart', { bubbles: true }));
        const dt = new DataTransfer();
        dt.setData('application/x-aurora-paths', JSON.stringify(list));
        el.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
        const hint = !document.querySelector('.fv-manager .fv-drop').hidden;
        el.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
        el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
        document.dispatchEvent(new DragEvent('dragend', { bubbles: true }));
        return hint;
      }, paths);
    check('drop hint while dragging', await drop([txt]), true);
    check('no font in the drop: message', await until(s, 'm', (m) => !m.els.toast.hidden && m.els.toast.textContent, { label: 'drop none' }), 'Aucun fichier de police dans ce que vous avez déposé (.ttf, .otf, .ttc, .otc)');
    await drop([a, txt]);
    await s.page.waitForSelector('.dialog-title', { timeout: 5000 });
    const dlg = await s.page.evaluate(() => [document.querySelector('.dialog-title').textContent, [...document.querySelectorAll('.fv-confirm-list li')].map((l) => l.textContent), [...document.querySelectorAll('.dialog-footer button')].map((b) => b.textContent)]);
    check('confirmation lists the fonts only', dlg, ['Installer cette police pour vous ?', ['CrimsonText-Regular.ttf'], ['Installer pour moi', 'Annuler']]);
    await sleep(500);
    await s.shot('fonts-drop-confirm-fr-light');
    await clickDialogButton(s, 'Annuler');
    await sleep(300);
    check('cancel: nothing installed', fs.existsSync(path.join(userFonts, 'Crimson Text', 'CrimsonText-Regular.ttf')), false);
    await drop([a]);
    await s.page.waitForSelector('.dialog-title', { timeout: 5000 });
    await clickDialogButton(s, 'Installer pour moi');
    await until(s, 'm', (m) => m.families.some((f) => f.name === 'Crimson Text' && f.user), { label: 'dropped font installed', timeout: 15000 });
    check('installed by drop + toast', [fs.existsSync(path.join(userFonts, 'Crimson Text', 'CrimsonText-Regular.ttf')), await M(s, (m) => m.els.toast.textContent)], [true, '« Crimson Text » est installée']);
  });

  await section('F5 reads the font folders again (a font copied by hand)', async () => {
    const manual = path.join(userFonts, 'Copie manuelle');
    fs.mkdirSync(manual, { recursive: true });
    fs.copyFileSync(path.join(EXTRA, 'Cantarell-VF.otf'), path.join(manual, 'Cantarell-VF.otf'));
    const gen0 = await M(s, (m) => m.api.invoke('fonts:list').then((r) => r.generation));
    check('not seen before a refresh (cached list)', await M(s, (m) => m.families.some((f) => f.name === 'Cantarell')), false);
    await s.page.focus(`${MAN} .fv-search`);
    await s.page.keyboard.press('F5');
    const fam = await until(s, 'm', (m) => m.families.find((f) => f.name === 'Cantarell'), { label: 'cantarell after F5' });
    check('after F5: listed as a user font', [fam.user, fam.styles.length], [true, 5]);
    check('the generation moved (other apps re-list too)', (await M(s, (m) => m.api.invoke('fonts:list').then((r) => r.generation))) > gen0, true);
    fs.rmSync(manual, { recursive: true, force: true });
    await s.page.click(`${MAN} .fv-refresh`);
    await until(s, 'm', (m) => !m.families.some((f) => f.name === 'Cantarell'), { label: 'cantarell gone after refresh' });
    check('refresh button: gone again', await M(s, (m) => m.families.length), 5);
  });

  await section('language switch while open (family page kept)', async () => {
    await M(s, (m) => m.openFamily('Fira Mono', { tab: 'chars' }));
    await s.page.evaluate(() => window.__aurora.settings.set('lang', 'en'));
    const en = await until(s, 'm', (m) => m.family?.els.root.isConnected && m.els.nav.querySelector('.fv-filter-label')?.textContent === 'All fonts' && [m.family.fam.name, m.family.tab, m.els.root.querySelector('.fv-tab.selected')?.textContent, m.els.install.textContent], { label: 'English UI' });
    check('relabelled in English, same family and tab', en, ['Fira Mono', 'chars', 'Characters', 'Install a font…']);
    await s.page.evaluate(() => window.__aurora.settings.set('lang', 'fr'));
    await until(s, 'm', (m) => m.els.nav.querySelector('.fv-filter-label')?.textContent === 'Toutes', { label: 'French UI again' });
    await M(s, (m) => m.closeFamily());
  });

  await section('preview faces are scoped and released', async () => {
    const st = await M(s, (m) => {
      const aliases = [...document.fonts].map((f) => f.family.replace(/"/g, '')).filter((f) => f.startsWith('selene-fonts-'));
      return { pool: m.pool.loadedCount(), doc: aliases.length, prefixed: aliases.every((a) => a.startsWith(m.pool.prefix)) };
    });
    check('loaded faces all belong to the main window pool', [st.pool > 0, st.pool === st.doc, st.prefixed], [true, true, true]);
    check('the shell fonts are untouched (Inter / Manrope still there)', await s.page.evaluate(() => [...document.fonts].some((f) => f.family.replace(/"/g, '') === 'Inter')), true);
    await s.page.evaluate((p) => window.__aurora.shell.openFile(p), path.join(SYS, 'Sacramento-Regular.ttf'));
    await until(s, 'p', (p) => p.alias, { label: 'preview face' });
    const two = await s.page.evaluate(() => [...document.fonts].filter((f) => f.family.replace(/"/g, '').startsWith('selene-fonts-')).length);
    await closeFontsWindows(s, 'p');
    const afterPreview = await s.page.evaluate(() => [...document.fonts].filter((f) => f.family.replace(/"/g, '').startsWith('selene-fonts-')).length);
    check('closing the preview releases its face', afterPreview, two - 1);
    await closeFontsWindows(s, 'all');
    check('closing every window releases every face', await s.page.evaluate(() => [...document.fonts].filter((f) => f.family.replace(/"/g, '').startsWith('selene-fonts-')).length), 0);
    check('no page errors (fr light)', appErrors(s), []);
  });
} finally {
  await s.cleanup();
}
check('fixtures untouched (fontconfig wrote nothing next to them)', fs.readdirSync(SYS).sort(), [
  'AtkinsonHyperlegible-Bold.ttf',
  'AtkinsonHyperlegible-BoldItalic.ttf',
  'AtkinsonHyperlegible-Italic.ttf',
  'AtkinsonHyperlegible-Regular.ttf',
  'FiraMono-Regular.ttf',
  'LibreBaskerville[wght].ttf',
  'Sacramento-Regular.ttf',
]);

// ================================================================== 3. dark / English screenshots
await section('French, dark: grid, family page, details', async () => {
  const d = await launch({ lang: 'fr', theme: 'dark', open: ['fonts'] });
  try {
    await d.page.waitForSelector(`${MAN} .fv-card.ready`, { timeout: 20000 });
    await until(d, 'm', (m) => [...m.els.grid.querySelectorAll('.fv-card')].every((c) => c.classList.contains('ready')), { label: 'dark cards' });
    await d.shot('fonts-grid-fr-dark');
    // the smallest window: the toolbar wraps, nothing overflows sideways
    await d.page.evaluate(() => window.__aurora.wm.list().find((w) => w.appId === 'fonts').setSize(640, 460));
    await sleep(500);
    const fit = await M(d, (m) => {
      const over = [m.els.root, m.els.toolbar, m.els.grid, m.els.side].filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.className);
      const r = m.els.root.getBoundingClientRect();
      const out = [...m.els.toolbar.children].filter((c) => !c.hidden && c.getBoundingClientRect().right > r.right + 1).map((c) => c.className);
      return { over, out, wrapped: m.els.toolbar.getBoundingClientRect().height > 50 };
    });
    check('minimum size: no sideways overflow, the toolbar wraps', fit, { over: [], out: [], wrapped: true });
    await d.shot('fonts-minsize-fr-dark');
    await d.page.evaluate(() => window.__aurora.wm.list().find((w) => w.appId === 'fonts').setSize(1120, 740));
    await sleep(300);
    await d.page.click(`${MAN} .fv-card[data-family="Libre Baskerville"]`);
    await until(d, 'm', (m) => m.family && [...m.family.els.panel.querySelectorAll('.fv-style-sample')].every((e) => e.classList.contains('ready')), { label: 'dark styles' });
    await d.shot('fonts-family-fr-dark');
    await d.page.click(`${MAN} .fv-tab[data-tab="chars"]`);
    await until(d, 'm', (m) => m.family.els.panel.querySelector('.fv-glyph')?.style.fontFamily, { label: 'dark chars' });
    await d.shot('fonts-chars-fr-dark');
    await d.page.click(`${MAN} .fv-theme button:nth-child(2)`);
    check('light preview background on a dark window', await M(d, (m) => [m.els.content.getAttribute('data-theme'), getComputedStyle(m.els.content).backgroundColor !== getComputedStyle(m.els.side).backgroundColor]), ['light', true]);
    await sleep(300);
    await d.shot('fonts-chars-light-preview-fr-dark');
    await d.page.click(`${MAN} .fv-theme button:nth-child(1)`);
    await d.page.click(`${MAN} .fv-tab[data-tab="details"]`);
    await until(d, 'm', (m) => m.family.els.panel.querySelector('.fv-drow'), { label: 'dark details' });
    await d.shot('fonts-details-fr-dark');
    const crimson = path.join(d.home, 'Downloads', 'CrimsonText-Regular.ttf');
    fs.copyFileSync(path.join(EXTRA, 'CrimsonText-Regular.ttf'), crimson);
    await d.page.evaluate((p) => window.__aurora.shell.openFile(p), crimson);
    await until(d, 'p', (p) => p.els.install, { label: 'dark preview' });
    await sleep(400);
    await d.shot('fonts-preview-fr-dark');
    check('no page errors (fr dark)', appErrors(d), []);
  } finally {
    await d.cleanup();
  }
});

await section('English, light and dark: strings, preview, list view', async () => {
  for (const theme of ['light', 'dark']) {
    const e = await launch({ lang: 'en', theme, open: ['fonts'] });
    try {
      await e.page.waitForSelector(`${MAN} .fv-card.ready`, { timeout: 20000 });
      await until(e, 'm', (m) => [...m.els.grid.querySelectorAll('.fv-card')].every((c) => c.classList.contains('ready')), { label: 'en cards' });
      if (theme === 'light') {
        const st = await M(e, (m) => ({
          sample: m.els.grid.querySelector('.fv-card-sample').textContent,
          nav: [...m.els.nav.querySelectorAll('.fv-filter-label')].map((x) => x.textContent),
          count: m.els.count.textContent,
          install: m.els.install.textContent,
          search: m.els.search.placeholder,
        }));
        check('English strings', st, {
          sample: 'The quick brown fox jumps over the lazy dog',
          nav: ['All fonts', 'Serif', 'Sans serif', 'Monospace', 'Handwritten', 'Installed by me'],
          count: '4 fonts',
          install: 'Install a font…',
          search: 'Search fonts',
        });
        await e.shot('fonts-grid-en-light');
      } else {
        await e.page.click(`${MAN} .fv-view button:nth-child(2)`);
        await sleep(300);
        await e.shot('fonts-list-en-dark');
      }
      const otf = path.join(e.home, 'Downloads', 'Cantarell-VF.otf');
      fs.copyFileSync(path.join(EXTRA, 'Cantarell-VF.otf'), otf);
      await e.page.evaluate((p) => window.__aurora.shell.openFile(p), otf);
      const pv = await until(e, 'p', (p) => (p.d || p.error) && p.els.root && [p.error, p.d && p.els.root.querySelector('.fv-pv-sub').textContent, p.els.install?.textContent, !!p.alias], { label: 'otf preview' });
      check(`OpenType CFF2 preview + « Install for me » (${theme})`, pv, [null, 'Regular · OpenType (CFF2) · Version 0.311', 'Install for me', true]);
      await sleep(400);
      await e.shot(`fonts-preview-en-${theme}`);
      if (theme === 'dark') {
        await e.page.click('.fv-preview .fv-install-one');
        check('CFF2 font installed for the user', await until(e, 'p', (p) => p.d.installed === 'same' && p.els.install?.disabled && p.els.install.textContent, { label: 'otf installed', timeout: 20000 }), 'Installed for you');
        check('fc-list sees Cantarell in the test HOME', !!fcFamilies(e.home).Cantarell, true);
        await e.page.evaluate(() => {
          for (const w of window.__aurora.wm.list().filter((x) => x.appId === 'fonts' && x.el.__fonts?.file != null)) w.close(true);
        });
        await until(e, 'm', (m) => m.families.some((f) => f.name === 'Cantarell'), { label: 'cantarell listed' });
        await M(e, (m) => m.openFamily('Cantarell'));
        await until(e, 'm', (m) => m.family && [...m.family.els.panel.querySelectorAll('.fv-style-sample')].every((x) => x.classList.contains('ready')), { label: 'cantarell styles' });
        check('Cantarell styles (named instances of the CFF2 font)', await M(e, (m) => m.family.fam.styles.map((x) => x.style)), ['Thin', 'Light', 'Regular', 'Bold', 'Extra Bold']);
        await e.shot('fonts-family-en-dark');
      }
      check(`no page errors (en ${theme})`, appErrors(e), []);
    } finally {
      await e.cleanup();
    }
  }
});

console.log(`\nfonts: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
