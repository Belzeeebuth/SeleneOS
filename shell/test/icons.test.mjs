// UI icons (Phosphor): every icon name the code uses resolves to a real Phosphor glyph, and the shell draws them.
//   xvfb-run -a -s '-screen 0 1600x900x24' node test/icons.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { launchShell, ROOT } from './lib.mjs';
import { scanIconNames, EXTRA, DYNAMIC } from '../tools/vendor-icons.mjs';

let passed = 0;
let failed = 0;
function check(ok, label, extra = '') {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && extra ? ` -> ${extra}` : ''}`);
}

const ICONS = path.join(ROOT, 'renderer', 'assets', 'icons');
const pack = JSON.parse(fs.readFileSync(path.join(ICONS, 'phosphor.json'), 'utf8'));
const aliasSrc = JSON.parse(fs.readFileSync(path.join(ICONS, 'aliases.json'), 'utf8'));

// The same resolution rules as renderer/core/icons.js (kept tiny on purpose).
function resolve(name) {
  let n = name.replace(/_filled$/, '');
  if (pack.aliases[n]) return pack.glyphs[pack.aliases[n].split(':')[0]] ? pack.aliases[n].split(':')[0] : null;
  if (pack.glyphs[n]) return n;
  n = n.replace(/-(fill|bold|regular)$/, '');
  return pack.glyphs[n] ? n : null;
}

// ------------------------------------------------------------------ static checks
{
  check(pack.v === 256 && Object.keys(pack.glyphs).length > 300, `phosphor.json: ${Object.keys(pack.glyphs).length} glyphs, viewBox 256`);
  check(JSON.stringify(pack.aliases) === JSON.stringify(aliasSrc), 'phosphor.json aliases match aliases.json (run tools/vendor-icons.mjs after editing it)');
  const badGlyph = Object.entries(pack.glyphs).filter(([, g]) => !['r', 'f', 'b'].every((k) => /^<path d="[^"]+"\/>/.test(g[k] || '')) || /fill="(?!currentColor)/.test(g.r));
  check(!badGlyph.length, 'every glyph has regular, fill and bold paths that take currentColor', badGlyph.map(([k]) => k).slice(0, 10).join(', '));
  check(EXTRA.every((n) => pack.glyphs[n]) && pack.glyphs['circle-dashed'], 'extra glyphs (fallback, window controls, night) are packed');
  check(fs.existsSync(path.join(ICONS, 'LICENSE-phosphor.txt')) && /MIT License/.test(fs.readFileSync(path.join(ICONS, 'LICENSE-phosphor.txt'), 'utf8')), 'Phosphor MIT licence is vendored next to the icons');

  // Fluent names the code used before the switch: fluent.json while it is still in the tree, else the alias keys.
  const fluentFile = path.join(ICONS, 'fluent.json');
  const fluentNames = fs.existsSync(fluentFile) ? new Set(Object.keys(JSON.parse(fs.readFileSync(fluentFile, 'utf8')))) : null;
  const { legacy, direct } = scanIconNames({ fluentNames });
  const unresolvedLegacy = [...legacy].filter((n) => !resolve(n));
  check(legacy.size >= 600 && !unresolvedLegacy.length, `${legacy.size} legacy (Fluent) names found in the code all resolve to a Phosphor glyph`, unresolvedLegacy.join(', '));
  check(DYNAMIC.every((n) => resolve(n)), 'names built at run time (battery_N, battery_charge_N, wifi_N, speaker_N) resolve');
  // Terminal profiles use { icon: 'shell' | 'python' | 'root' } for their own drawings (apps/terminal/lib/icons.js).
  const NOT_ICONS = new Set(['shell', 'python', 'root']);
  const unresolvedDirect = [...direct].filter(([n]) => !NOT_ICONS.has(n) && !resolve(n));
  check(direct.size > 300 && !unresolvedDirect.length, `${direct.size} names at icon call sites resolve`, unresolvedDirect.map(([n, f]) => `${n} (${f})`).join(', '));
  const winLike = Object.entries(pack.aliases).filter(([, v]) => /^(squares-four|windows-logo)/.test(v));
  check(pack.aliases.app_generic === 'app-window' && !winLike.length, 'no alias uses the Windows-like four squares (app_generic -> app-window)', winLike.map(([k]) => k).join(', '));
  const spot = { folder: 'folder-simple', arrow_download: 'download-simple', window_console: 'terminal-window', settings: 'gear-six', search: 'magnifying-glass', dismiss: 'x', wifi_1: 'wifi-high', speaker_mute: 'speaker-slash', weather_moon: 'moon' };
  const wrong = Object.entries(spot).filter(([k, v]) => pack.aliases[k] !== v);
  check(!wrong.length, 'semantic spot checks (folder, download, terminal, settings, search, close, wifi, mute, moon)', wrong.map(([k]) => k).join(', '));
  const src = fs.readFileSync(path.join(ROOT, 'renderer', 'core', 'icons.js'), 'utf8');
  check(!/fluent\.json/.test(src) && /phosphor\.json/.test(src), 'icons.js loads phosphor.json, not fluent.json');
}

// ------------------------------------------------------------------ live shell
{
  const s = await launchShell({ open: ['settings', 'files'], theme: 'dark', lang: 'fr', settle: 1500 });
  const P = s.page;
  try {
    const svgOk = (sel) =>
      P.evaluate((q) => {
        const icons = [...document.querySelectorAll(q)];
        const drawn = icons.filter((el) => {
          const svg = el.querySelector('svg');
          const r = el.getBoundingClientRect();
          return svg && svg.getAttribute('viewBox') === '0 0 256 256' && svg.querySelector('path')?.getAttribute('d')?.length > 10 && (r.width > 0 || getComputedStyle(el).display === 'none' || !el.offsetParent);
        });
        const bad = icons.filter((el) => !drawn.includes(el)).map((el) => `${el.dataset.icon || el.className}:${el.querySelector('svg')?.getAttribute('viewBox')}:${Math.round(el.getBoundingClientRect().width)}`);
        return { total: icons.length, drawn: drawn.length, bad: bad.join(' ') };
      }, sel);

    // [data-icon] = drawn by icon(); the tray's hand-drawn network / battery glyphs (taskbar.js) are phase B's.
    const tb = await svgOk('#taskbar .icon[data-icon]');
    check(tb.total >= 3 && tb.drawn === tb.total, `taskbar: ${tb.drawn}/${tb.total} icons are Phosphor SVGs`, tb.bad);

    const sn = await svgOk('.st-nav .icon');
    check(sn.total >= 5 && sn.drawn === sn.total, `Settings nav: ${sn.drawn}/${sn.total} icons are Phosphor SVGs`);
    const filledNav = await P.evaluate(() => {
      const el = document.querySelector('.st-nav .st-nav-icon .icon');
      return el ? el.querySelector('path').getAttribute('d') : '';
    });
    check(filledNav.length > 10, 'Settings nav uses the fill weight (filled: true) without error');

    const fx = await svgOk('.fx-toolbar .icon');
    check(fx.total >= 4 && fx.drawn === fx.total, `Fichiers toolbar: ${fx.drawn}/${fx.total} icons are Phosphor SVGs`);

    await P.click('.tb-start');
    await P.waitForTimeout(600);
    const st = await svgOk('#start .icon');
    check(st.total >= 2 && st.drawn === st.total, `Lanceur: ${st.drawn}/${st.total} icons are Phosphor SVGs`);
    await s.shot('icons-launcher');
    await P.keyboard.press('Escape');
    await P.waitForTimeout(300);

    // context menu on the Fichiers list
    const box = await P.evaluate(() => {
      const el = document.querySelector('.fx-cmdbar')?.closest('.window')?.querySelector('.fx-list, .fx-view, .fx-content, [role="grid"], [role="listbox"]');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height - 30 };
    });
    if (box) await P.mouse.click(box.x, box.y, { button: 'right' });
    else await P.mouse.click(800, 450, { button: 'right' });
    await P.waitForTimeout(400);
    const cm = await svgOk('.menu .menu-item .icon');
    check(cm.total >= 3 && cm.drawn === cm.total, `context menu: ${cm.drawn}/${cm.total} icons are Phosphor SVGs`);
    await s.shot('icons-context-menu');
    await P.keyboard.press('Escape');

    // Unknown names: neutral fallback glyph + one warning
    const fb = await P.evaluate(async () => {
      const { icon, hasIcon, resolveIcon } = await import('app://shell/core/icons.js');
      const a = icon('no_such_icon_xyz', { size: 20 });
      const b = icon('no_such_icon_xyz', { size: 20 });
      const fill = icon('folder', { filled: true }).innerHTML !== icon('folder').innerHTML;
      const small = icon('folder', { size: 12 }).innerHTML !== icon('folder', { size: 20 }).innerHTML;
      return {
        path: a.querySelector('path')?.getAttribute('d')?.length || 0,
        same: a.innerHTML === b.innerHTML,
        has: hasIcon('no_such_icon_xyz'),
        res: resolveIcon('wifi_1'),
        direct: resolveIcon('caret-down-bold'),
        fill,
        small,
      };
    });
    // Paint's tool cursors pull the paths out of iconSvg(): they must follow the 256-unit viewBox
    const cur = await P.evaluate(async () => {
      const { cursorFor } = await import('app://shell/apps/paint/art.js');
      return ['pencil', 'fill', 'picker', 'zoom'].map((t) => decodeURIComponent(cursorFor(t)));
    });
    check(cur.every((c) => /viewBox="-12\.8 -12\.8 281\.6 281\.6"/.test(c) && /stroke-width="19\.2/.test(c) && /<path d="[^"]{20,}/.test(c)), 'Paint tool cursors scale the Phosphor glyphs (viewBox and outline follow the 256 grid)');
    await P.waitForTimeout(100);
    const warns =s.logs.filter((l) => l.includes('unknown icon "no_such_icon_xyz"')).length;
    check(fb.path > 10 && fb.same && !fb.has && warns === 1, `unknown name renders the fallback glyph and warns once (${warns} warning)`);
    check(fb.res?.glyph === 'wifi-high' && fb.direct?.glyph === 'caret-down' && fb.direct.weight === 'bold', 'resolveIcon: aliases and Phosphor names with a weight suffix');
    check(fb.fill && fb.small, 'filled: true uses the fill weight; 12 px icons use the bold weight');

    const otherWarn = s.logs.filter((l) => l.includes('[icons] unknown icon') && !l.includes('no_such_icon_xyz'));
    check(!otherWarn.length, 'no other unknown-icon warnings while the shell, Settings and Fichiers run', otherWarn.slice(0, 5).join(' | '));

    // visual weight at 16 / 20 / 24 px
    await P.evaluate(() => {
      const host = document.createElement('div');
      host.id = 'icon-probe';
      host.style.cssText = 'position:fixed;left:40px;top:40px;z-index:99999;padding:16px;background:#14161c;color:#e6e8ee;display:grid;gap:12px;font:13px sans-serif';
      document.body.appendChild(host);
      return import('app://shell/core/icons.js').then(({ icon }) => {
        for (const size of [16, 20, 24]) {
          const row = document.createElement('div');
          row.style.cssText = 'display:flex;gap:12px;align-items:center';
          row.append(`${size}px`);
          for (const n of ['folder', 'settings', 'search', 'wifi_1', 'speaker_2', 'battery_6', 'mail', 'window_console', 'delete', 'chevron_right', 'star']) row.append(icon(n, { size }));
          row.append(icon('star', { size, filled: true }));
          host.append(row);
        }
      });
    });
    await P.waitForTimeout(200);
    await P.locator('#icon-probe').screenshot({ path: path.join(ROOT, 'test', 'out', 'icons-sizes.png') });
    check(true, 'sizes sheet written to test/out/icons-sizes.png');

    // No Fluent asset requested at run time (reload the shell and watch every request)
    const reqs = [];
    P.on('request', (r) => reqs.push(r.url()));
    await P.reload();
    await P.waitForSelector('body.ready', { timeout: 60000 });
    await P.waitForTimeout(1500);
    check(reqs.some((n) => n.endsWith('/assets/icons/phosphor.json')) && !reqs.some((n) => /fluent/i.test(n)), `phosphor.json is loaded and no Fluent asset is requested (${reqs.length} requests)`, reqs.filter((n) => /fluent/i.test(n)).join(', '));
  } catch (err) {
    check(false, 'live shell checks', err.stack || String(err));
  } finally {
    await s.close();
  }
}

// ------------------------------------------------------------------ Selene app icons follow the look
// The default icon pack ("selene") draws the Selene icon for the current ambiance and mode (core/app-icon-art.js):
// night blue for cold, warm charcoal for neutral, plum for warm, with no blue cast and no blue / cyan symbol outside
// cold; the static icon.svg files are the cold dark look.
const rgbOf = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
/** hue in degrees and chroma (0–1) of [r, g, b] */
function hueChroma([r, g, b]) {
  const [R, G, B] = [r / 255, g / 255, b / 255];
  const mx = Math.max(R, G, B);
  const c = mx - Math.min(R, G, B);
  if (!c) return { h: 0, c: 0 };
  const h = mx === R ? ((G - B) / c) % 6 : mx === G ? (B - R) / c + 2 : (R - G) / c + 4;
  return { h: (h * 60 + 360) % 360, c };
}
const blueCast = ([r, g, b]) => b > Math.max(r, g) + 8;
const blueSymbol = (px) => {
  const { h, c } = hueChroma(px);
  return (c > 0.08 && h >= 185 && h <= 250) || (c <= 0.08 && blueCast(px));
};
{
  const art = await import(path.join(ROOT, 'renderer', 'core', 'app-icon-art.js'));
  const { APP_GLYPHS } = await import(path.join(ROOT, 'renderer', 'core', 'app-glyphs.js'));
  for (const amb of ['neutral', 'warm']) {
    const L = art.ICON_LOOKS[amb];
    const bases = [...L.dark, ...L.light];
    const blue = Object.entries(L.hues).filter(([, c]) => blueSymbol(rgbOf(c)));
    check(!bases.some((b) => blueCast(rgbOf(b))) && !blue.length, `${amb} palette: no blue cast in the base (${bases.join(' ')}), no blue / cyan symbol`, blue.map(([k, c]) => `${k} ${c}`).join(', '));
    // neighbours stay distinguishable: every pair of slot colours differs (RGB distance > 24)
    const vals = Object.entries(L.hues);
    const close = [];
    for (let i = 0; i < vals.length; i++) for (let j = i + 1; j < vals.length; j++) {
      const d = Math.hypot(...rgbOf(vals[i][1]).map((v, k) => v - rgbOf(vals[j][1])[k]));
      if (d <= 24) close.push(`${vals[i][0]}/${vals[j][0]} ${d.toFixed(0)}`);
    }
    check(!close.length && new Set(Object.values(L.hues)).size === art.HUE_SLOTS.length, `${amb} palette: ${art.HUE_SLOTS.length} distinct symbol colours`, close.join(', '));
  }
  check(art.ICON_LOOKS.cold.dark.every((b) => blueCast(rgbOf(b))), `cold keeps the night-blue base (${art.ICON_LOOKS.cold.dark.join(' → ')})`);
  check(Object.values(APP_GLYPHS).every((g) => art.HUE_SLOTS.includes(g.hue)) && Object.keys(APP_GLYPHS).length >= 40, `app-glyphs.js: every app (${Object.keys(APP_GLYPHS).length}) has a palette slot`);
  // the static files are the cold dark look, byte for byte
  const files = { 'special:thispc': 'assets/icons/this-pc.svg', 'special:trash': 'assets/icons/recycle-bin.svg', default: 'assets/app-default.svg' };
  const differ = Object.entries(APP_GLYPHS).filter(([id, g]) => {
    const f = path.join(ROOT, 'renderer', files[id] || `apps/${id}/icon.svg`);
    const key = id === 'default' ? 'app-default' : id.replace(/[^a-z0-9]+/gi, '-');
    return art.seleneIconSvg(key, g, art.iconLook('cold-dark')) !== fs.readFileSync(f, 'utf8');
  });
  check(!differ.length, 'the static icon.svg files are the cold dark look of core/app-icon-art.js (unchanged design)', differ.map(([k]) => k).join(', '));
  check(['nocturne', 'eclipse', 'clairdelune'].every((st, i) => art.lookKey({ style: st, ambiance: ['cold', 'neutral', 'warm'][i], theme: 'dark' }) === `${['cold', 'neutral', 'warm'][i]}-dark`) && art.lookKey({ style: 'nocturne', ambiance: 'warm', theme: 'light' }) === 'warm-light' && art.lookKey({ style: 'contrast', ambiance: 'neutral', theme: 'light' }) === 'contrast-light', 'lookKey: the ambiance (not the style) picks the palette; Contraste élevé has its own');
}
{
  const s = await launchShell({ theme: 'dark', lang: 'fr', size: '1280x720', settle: 1200 });
  const P = s.page;
  try {
    // Draw every icon of a selector at 48 px and sample it: the base (a pixel left of the symbol) and the symbol (the
    // mean of the pixels far from the base). Desktop specials are mapped with CSS `content: url()`: read that URL.
    const sample = (sel) =>
      P.evaluate(async (q) => {
        const urlOf = (img) => {
          const c = getComputedStyle(img).content;
          const m = /^url\("(.*)"\)$/.exec(c || '');
          return m ? m[1].replace(/\\([0-9a-f]{1,6}) ?/gi, (_, x) => String.fromCodePoint(parseInt(x, 16))) : img.currentSrc || img.src;
        };
        const out = [];
        for (const img of document.querySelectorAll(q)) {
          if (!img.offsetParent) continue;
          const src = urlOf(img);
          const im = new Image();
          im.src = src;
          await im.decode().catch(() => {});
          const cv = document.createElement('canvas');
          cv.width = cv.height = 48;
          const g = cv.getContext('2d');
          g.drawImage(im, 0, 0, 48, 48);
          const d = g.getImageData(0, 0, 48, 48).data;
          const px = (x, y) => [0, 1, 2].map((k) => d[(y * 48 + x) * 4 + k]);
          const base = px(5, 26);
          const sum = [0, 0, 0];
          let n = 0;
          for (let y = 8; y < 40; y++) for (let x = 8; x < 40; x++) {
            const p = px(x, y);
            if (d[(y * 48 + x) * 4 + 3] > 250 && Math.hypot(p[0] - base[0], p[1] - base[1], p[2] - base[2]) > 70) {
              p.forEach((v, k) => (sum[k] += v));
              n++;
            }
          }
          out.push({ src: src.slice(0, 40), base, sym: n ? sum.map((v) => Math.round(v / n)) : null, n });
        }
        return out;
      }, sel);
    const setLook = (patch) => P.evaluate(async (pt) => {
      if (pt.style) await (await import('app://shell/core/theme.js')).chooseStyle(pt.style);
      const rest = { ...pt };
      delete rest.style;
      if (Object.keys(rest).length) await window.__aurora.api.invoke('settings:setMany', rest);
    }, patch);
    const look = () => P.evaluate(() => window.__aurora.packs.iconLook);
    const openStart = async () => {
      await P.evaluate(() => document.querySelector('#start')?.classList.contains('open') || window.__aurora.shell.emit('start:toggle'));
      await P.waitForTimeout(700);
    };
    const report = (arr) => arr.map((r) => `${r.base}|${r.sym}`).slice(0, 4).join(' ');

    // cold (Nocturne, the default): night-blue base everywhere
    await openStart();
    const coldBar = await sample('#taskbar .tb-app img');
    const coldStart = await sample('#start img[src^="data:image/svg"]');
    check((await look()) === 'cold-dark' && coldBar.length >= 5 && coldStart.length >= 8 && [...coldBar, ...coldStart].every((r) => r.base[2] > Math.max(r.base[0], r.base[1]) + 15), `cold: bar (${coldBar.length}) and Lanceur (${coldStart.length}) icons keep the night-blue base`, report(coldBar));
    const coldSrc = await P.evaluate(() => ({ bar: document.querySelector('#taskbar .tb-app img').getAttribute('src'), start: document.querySelector('#start img[src^="data:image/svg"]').getAttribute('src'), desk: document.querySelector('#desktop [data-special="thispc"] img').getAttribute('src') }));
    const staticSame = await P.evaluate(async () => {
      const own = await fetch('app://shell/apps/browser/icon.svg').then((r) => r.text());
      return decodeURIComponent(window.__aurora.registry.iconUrl('browser').replace(/^data:image\/svg\+xml,/, '')) === own;
    });
    check(staticSame, 'cold dark: the drawn icon is the static icon.svg, byte for byte');

    // switching the ambiance (Lanceur still open): bar, Lanceur and desktop follow live, in the same frame
    const frame = await P.evaluate(
      () =>
        new Promise((resolve) => {
          const html = document.documentElement;
          const mo = new MutationObserver(() => {
            if (html.dataset.ambiance !== 'neutral') return;
            mo.disconnect();
            // read right away (same task) and one frame later
            const now = document.querySelector('#taskbar .tb-app img').getAttribute('src');
            requestAnimationFrame(() => resolve({ now, want: window.__aurora.registry.iconUrl(document.querySelector('#taskbar .tb-app').dataset.app), look: window.__aurora.packs.iconLook }));
          });
          mo.observe(html, { attributes: true, attributeFilter: ['data-ambiance'] });
          window.__aurora.settings.set('ambiance', 'neutral');
        }),
    );
    check(frame.look === 'neutral-dark' && frame.now === frame.want, `the bar's icons are redrawn as soon as <html data-ambiance> changes (no stale frame; look ${frame.look})`);
    await P.waitForTimeout(900);
    const neuSrc = await P.evaluate(() => ({ bar: document.querySelector('#taskbar .tb-app img').getAttribute('src'), start: document.querySelector('#start img[src^="data:image/svg"]')?.getAttribute('src'), desk: document.querySelector('#desktop [data-special="thispc"] img').getAttribute('src'), open: document.querySelector('#start').getBoundingClientRect().width > 0 }));
    check(neuSrc.bar !== coldSrc.bar && neuSrc.start && neuSrc.start !== coldSrc.start && neuSrc.desk !== coldSrc.desk && neuSrc.desk.startsWith('data:image/svg'), 'switching the ambiance updates the bar, the open Lanceur and the desktop icons live');

    // every non-cold look: no blue cast in the base, no blue / cyan symbol (bar, Lanceur; the desktop's Ordinateur and
    // Corbeille are flat symbols with no tile: every drawn pixel is checked, and most of the picture is see-through)
    const flat = (sel) =>
      P.evaluate(async (q) => {
        const out = [];
        for (const img of document.querySelectorAll(q)) {
          const im = new Image();
          im.src = img.getAttribute('src');
          await im.decode().catch(() => {});
          const cv = document.createElement('canvas');
          cv.width = cv.height = 48;
          const g = cv.getContext('2d');
          g.drawImage(im, 0, 0, 48, 48);
          const d = g.getImageData(0, 0, 48, 48).data;
          let solid = 0;
          const inks = [];
          for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 200) (solid++, inks.push([d[i], d[i + 1], d[i + 2]]));
          out.push({ id: img.closest('[data-special]').dataset.special, solid: solid / (48 * 48), inks });
        }
        return out;
      }, sel);
    const looks = [
      [{ style: 'eclipse', theme: 'dark' }, 'neutral-dark'],
      [{ style: 'eclipse', theme: 'light' }, 'neutral-light'],
      [{ style: 'clairdelune', theme: 'light' }, 'warm-light'],
      [{ style: 'clairdelune', theme: 'dark' }, 'warm-dark'],
      [{ style: 'nocturne', ambiance: 'warm', theme: 'dark' }, 'warm-dark'],
    ];
    for (const [patch, want] of looks) {
      await setLook(patch);
      await P.waitForTimeout(1200);
      await openStart();
      const all = [...(await sample('#taskbar .tb-app img')), ...(await sample('#start img[src^="data:image/svg"]')), ...(await sample('#desktop [data-special="installer"] img'))];
      const specials = await flat('#desktop [data-special="thispc"] img, #desktop [data-special="trash"] img');
      const sb = specials.map((r) => ({ id: r.id, solid: r.solid.toFixed(2), blue: r.inks.filter(blueSymbol).length }));
      check(specials.length === 2 && specials.every((r) => r.solid < 0.5 && r.inks.length > 80 && !r.inks.some(blueSymbol)), `${want}: Ordinateur and Corbeille are flat symbols (no tile) without blue / cyan`, JSON.stringify(sb));
      const cast = all.filter((r) => blueCast(r.base));
      const blue = all.filter((r) => !r.sym || blueSymbol(r.sym));
      check((await look()) === want && all.length >= 15 && !cast.length && !blue.length, `${JSON.stringify(patch)} → ${want}: ${all.length} icons, bases without blue cast, symbols not blue / cyan`, `look ${await look()}; cast ${report(cast)}; blue ${report(blue)}`);
      await s.shot(`icons-look-${want}-${patch.style}`);
    }
    // Contraste élevé: black tile, white symbol
    await setLook({ style: 'contrast', theme: 'dark' });
    await P.waitForTimeout(1200);
    const hc = await sample('#taskbar .tb-app img');
    check((await look()) === 'contrast-dark' && hc.length >= 5 && hc.every((r) => r.base.every((v) => v < 16) && r.sym && r.sym.every((v) => v > 170) && Math.max(...r.sym) - Math.min(...r.sym) < 8), 'Contraste élevé: black tiles, white symbols', hc.map((r) => `${r.base}|${r.sym}|${r.n}`).join(' '));
    // other packs still win over the look; back to Selene redraws for the look
    await P.evaluate(() => window.__aurora.settings.set('iconPack', 'tiles'));
    await P.waitForTimeout(500);
    const tiles = await P.evaluate(() => decodeURIComponent(document.querySelector('#taskbar .tb-app img').getAttribute('src')));
    await P.evaluate(() => window.__aurora.settings.set('iconPack', 'selene'));
    await P.waitForTimeout(500);
    const back = await P.evaluate(() => decodeURIComponent(document.querySelector('#taskbar .tb-app img').getAttribute('src')));
    check(!tiles.includes('Selene app icon') && back.includes('Selene app icon') && back.includes('stroke="#ffffff"'), 'other packs keep their own pictures; Selene comes back in the current look', `${tiles.slice(0, 90)} | ${back.slice(0, 90)}`);
    const errs = s.logs.filter((l) => /^\[(error|pageerror)\]/.test(l) && !/Failed to load resource/.test(l));
    check(!errs.length, 'no console errors while switching looks', errs.slice(0, 3).join(' | '));
  } catch (err) {
    check(false, 'Selene icon looks', err.stack || String(err));
  } finally {
    await s.close();
  }
}

// ------------------------------------------------------------------ Fichiers icons follow the look
// The folder, file-type and drive icons (core/file-icon-art.js, drawn by core/file-icons.js) take the same palette:
// the static apps/files/icons/*.svg files are the cold look; neutral and warm show no blue or cyan; the Phosphor
// file-type glyphs of the desktop and the Lanceur (.ft-*) follow too.
{
  const fa = await import(path.join(ROOT, 'renderer', 'core', 'file-icon-art.js'));
  const { glyphs } = pack;
  const glyphOf = (n, w) => glyphs[n]?.[w];
  const names = Object.keys(fa.FILE_ICONS);
  const dir = path.join(ROOT, 'renderer', 'apps', 'files', 'icons');
  const onDisk = fs.readdirSync(dir).filter((f) => f.endsWith('.svg')).map((f) => f.slice(0, -4)).sort();
  check(names.length === 33 && JSON.stringify(onDisk) === JSON.stringify([...names].sort()), `Fichiers: ${names.length} icons, one static file each`, onDisk.filter((n) => !names.includes(n)).join(', '));
  const differ = names.filter((n) => fa.fileIconSvg(n, fa.fileIconLook('cold'), glyphOf) !== fs.readFileSync(path.join(dir, `${n}.svg`), 'utf8'));
  check(!differ.length, 'Fichiers: the static icons/*.svg files are the cold look of core/file-icon-art.js, byte for byte (tools/gen-files-icons.mjs)', differ.join(', '));
  check(['nocturne', 'eclipse', 'clairdelune'].every((st, i) => fa.fileLookKey(`${['cold', 'neutral', 'warm'][i]}-light`) === ['cold', 'neutral', 'warm'][i]) && fa.fileLookKey('contrast-light') === 'contrast-light', 'Fichiers looks: cold / neutral / warm (any mode), Contraste élevé per mode');
  for (const amb of ['neutral', 'warm']) {
    const L = fa.fileIconLook(amb);
    const colours = { ...L.folder, ...Object.fromEntries(Object.entries(L.page).map(([k, v]) => [`page.${k}`, v])), ...Object.fromEntries(Object.entries(L.device).map(([k, v]) => [`device.${k}`, v])), ...L.types };
    const blue = Object.entries(colours).filter(([, c]) => blueSymbol(rgbOf(c)));
    check(!blue.length, `Fichiers ${amb}: no blue / cyan in the folder, page, device and ${Object.keys(L.types).length} file-type colours`, blue.map(([k, c]) => `${k} ${c}`).join(', '));
    const low = Object.entries(L.types).filter(([, c]) => fa.contrast(c, L.page.sheet) < 4.5);
    check(!low.length, `Fichiers ${amb}: every file-type glyph is >= 4.5:1 on its page`, low.map(([k, c]) => `${k} ${c}`).join(', '));
    check(L.types['file-doc'] !== L.types['file-text'], `Fichiers ${amb}: documents and plain text (same glyph) keep different colours`);
    for (const m of ['dark', 'light']) {
      const t = fa.fileTypeTints(amb, m);
      const bt = Object.entries(t).filter(([, c]) => blueSymbol(rgbOf(c)));
      check(!bt.length, `.ft-* tints ${amb} ${m}: no blue / cyan`, bt.map(([k, c]) => `${k} ${c}`).join(', '));
    }
  }
  const hc = fa.fileIconLook('contrast-dark');
  check(Object.values(hc.types).every((c) => c === '#ffffff') && hc.page.sheet === '#000000' && hc.flat, 'Fichiers Contraste élevé: white on black, flat');
  check(fa.fileTypeTints('cold', 'dark') === null && fa.fileTypeTints('contrast-dark', 'dark') === null, '.ft-* tints: cold and Contraste élevé keep their own style sheets');
}
{
  const home = fs.mkdtempSync(path.join((await import('node:os')).tmpdir(), 'aurora-home-'));
  for (const d of ['Desktop', 'Documents', 'Downloads', 'Pictures', 'Music', 'Videos']) fs.mkdirSync(path.join(home, d), { recursive: true });
  for (const n of ['lettre.docx', 'budget.xlsx', 'rapport.pdf', 'notes.txt', 'archive.zip']) fs.writeFileSync(path.join(home, 'Desktop', n), 'x');
  fs.mkdirSync(path.join(home, 'Desktop', 'Dossier'));
  const s = await launchShell({ home, theme: 'dark', lang: 'fr', size: '1280x720', settle: 1500 });
  const P = s.page;
  try {
    const setLook = (patch) => P.evaluate(async (pt) => {
      if (pt.style) await (await import('app://shell/core/theme.js')).chooseStyle(pt.style);
      const rest = { ...pt };
      delete rest.style;
      if (Object.keys(rest).length) await window.__aurora.api.invoke('settings:setMany', rest);
    }, patch);
    // the desktop's file glyphs and a probe of every Fichiers icon (an <img> with the static src, as Fichiers draws it)
    await P.evaluate((list) => {
      const host = document.createElement('div');
      host.id = 'fi-probe';
      host.style.cssText = 'position:fixed;right:20px;top:20px;z-index:99999;display:flex;flex-wrap:wrap;width:400px;gap:4px';
      for (const n of list) {
        const img = document.createElement('img');
        img.src = `app://shell/apps/files/icons/${n}.svg`;
        img.width = img.height = 32;
        host.append(img);
      }
      document.body.append(host);
    }, Object.keys((await import(path.join(ROOT, 'renderer', 'core', 'file-icon-art.js'))).FILE_ICONS));
    const read = () =>
      P.evaluate(() => {
        const rgb = (c) => (c.match(/\d+(\.\d+)?/g) || []).slice(0, 3).map(Number);
        const desk = [...document.querySelectorAll('#desktop .desk-fi')].map((el) => ({ cls: el.getAttribute('class'), c: rgb(getComputedStyle(el).color) }));
        const probe = [...document.querySelectorAll('#fi-probe img')].map((img) => getComputedStyle(img).content);
        return { look: window.__aurora.packs.iconLook, desk, mapped: probe.filter((c) => c.startsWith('url("data:image/svg')).length, total: probe.length };
      });
    const cold = await read();
    const docCold = cold.desk.find((d) => /ft-doc/.test(d.cls));
    check(cold.look === 'cold-dark' && cold.mapped === 0 && cold.total === 33 && docCold && docCold.c.join() === '106,167,255', `cold: no Fichiers mapping, the desktop keeps its tints (document ${docCold?.c})`);
    for (const [patch, want] of [
      [{ style: 'eclipse', theme: 'dark' }, 'neutral-dark'],
      [{ style: 'eclipse', theme: 'light' }, 'neutral-light'],
      [{ style: 'clairdelune', theme: 'light' }, 'warm-light'],
      [{ style: 'clairdelune', theme: 'dark' }, 'warm-dark'],
    ]) {
      await setLook(patch);
      await P.waitForTimeout(1000);
      const r = await read();
      const blue = r.desk.filter((d) => blueSymbol(d.c));
      check(r.look === want && r.mapped === 33 && r.desk.length >= 6 && !blue.length, `${want}: 33/33 Fichiers icons mapped to the look, ${r.desk.length} desktop file glyphs without blue`, `${r.look} ${r.mapped}; ${blue.map((d) => `${d.cls} ${d.c}`).join(', ')}`);
      if (want === 'neutral-dark' || want === 'warm-light') await s.shot(`icons-files-${want}`);
    }
    // the other icon packs keep their own file-type tints
    await P.evaluate(() => window.__aurora.settings.set('iconPack', 'graphite'));
    await P.waitForTimeout(500);
    const gr = await P.evaluate(() => {
      const el = document.querySelector('#desktop .ft-doc');
      const ref = document.createElement('span');
      ref.style.color = 'var(--text-2)';
      document.body.append(ref);
      const want = getComputedStyle(ref).color;
      ref.remove();
      return el ? { got: getComputedStyle(el).color, want } : null;
    });
    await P.evaluate(() => window.__aurora.settings.set('iconPack', 'selene'));
    check(gr && gr.got === gr.want, 'other icon packs (graphite): the desktop file glyphs keep the pack tint', JSON.stringify(gr));
    await setLook({ style: 'nocturne', theme: 'dark' });
    await P.waitForTimeout(1000);
    const back = await read();
    check(back.mapped === 0 && back.desk.find((d) => /ft-doc/.test(d.cls))?.c.join() === '106,167,255', 'back to Nocturne: static Fichiers icons and the original desktop tints');
    const errs = s.logs.filter((l) => /^\[(error|pageerror)\]/.test(l) && !/Failed to load resource/.test(l));
    check(!errs.length, 'no console errors while the Fichiers icons switch looks', errs.slice(0, 3).join(' | '));
  } catch (err) {
    check(false, 'Fichiers icon looks', err.stack || String(err));
  } finally {
    await s.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------ desktop icons: no tile, no label plate
// The names are plain text with a halo (light text over a dark shadow, or dark text in a light halo, by the tone of the
// wallpaper behind each icon; core/desktop.js sets it). Effective contrast: the text colour against what is drawn right
// around each glyph (wallpaper + halo), read from two screenshots (with the text, then the text made transparent).
{
  const home = fs.mkdtempSync(path.join((await import('node:os')).tmpdir(), 'aurora-home-'));
  for (const d of ['Desktop', 'Documents', 'Downloads', 'Pictures', 'Music', 'Videos']) fs.mkdirSync(path.join(home, d), { recursive: true });
  fs.writeFileSync(path.join(home, 'Desktop', 'Welcome.txt'), 'x');
  fs.mkdirSync(path.join(home, 'Desktop', 'Projets'));
  const s = await launchShell({ home, theme: 'dark', lang: 'fr', size: '1280x720', settle: 1500, live: true });
  const P = s.page;
  try {
    const labels = () =>
      P.evaluate(() =>
        [...document.querySelectorAll('#desktop .desk-icon')].map((el) => {
          const l = el.querySelector('.desk-label');
          const cs = getComputedStyle(l);
          const r = l.getBoundingClientRect();
          return { id: el.dataset.special || el.dataset.id.split('/').pop(), tone: el.dataset.theme, color: cs.color, bg: cs.backgroundColor, plate: getComputedStyle(el).backgroundColor, fs: parseFloat(cs.fontSize), shadow: cs.textShadow !== 'none', clip: { x: Math.floor(r.left) - 2, y: Math.floor(r.top) - 2, width: Math.ceil(r.width) + 4, height: Math.ceil(r.height) + 4 } };
        }),
      );
    const effective = async (list) => {
      const A = await Promise.all(list.map((l) => P.screenshot({ clip: l.clip }).then((b) => b.toString('base64'))));
      await P.evaluate(() => document.head.append(Object.assign(document.createElement('style'), { id: 'desk-probe', textContent: '#desktop .desk-label { color: transparent !important; }' })));
      await P.waitForTimeout(150);
      const B = await Promise.all(list.map((l) => P.screenshot({ clip: l.clip }).then((b) => b.toString('base64'))));
      await P.evaluate(() => document.getElementById('desk-probe').remove());
      return P.evaluate(
        async ({ A, B, colors }) => {
          const dec = async (b64) => {
            const im = new Image();
            im.src = `data:image/png;base64,${b64}`;
            await im.decode();
            const c = document.createElement('canvas');
            c.width = im.width;
            c.height = im.height;
            c.getContext('2d').drawImage(im, 0, 0);
            return c.getContext('2d').getImageData(0, 0, c.width, c.height);
          };
          const lin = (v) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
          const L = (d, p) => 0.2126 * lin(d[p]) + 0.7152 * lin(d[p + 1]) + 0.0722 * lin(d[p + 2]);
          const out = [];
          for (let i = 0; i < A.length; i++) {
            const a = await dec(A[i]);
            const b = await dec(B[i]);
            const tc = colors[i].match(/[\d.]+/g).map(Number);
            const Lt = 0.2126 * lin(tc[0]) + 0.7152 * lin(tc[1]) + 0.0722 * lin(tc[2]);
            const diff = (p) => Math.abs(a.data[p] - b.data[p]) + Math.abs(a.data[p + 1] - b.data[p + 1]) + Math.abs(a.data[p + 2] - b.data[p + 2]);
            const core = new Set();
            for (let p = 0; p < a.data.length; p += 4) if (diff(p) > 60 && Math.abs(a.data[p] - tc[0]) + Math.abs(a.data[p + 1] - tc[1]) + Math.abs(a.data[p + 2] - tc[2]) < 60) core.add(p / 4);
            const ring = [];
            for (let q = 0; q < a.width * a.height; q++) {
              if (core.has(q) || diff(q * 4) > 30) continue;
              const x = q % a.width;
              const y = Math.floor(q / a.width);
              let near = false;
              for (let dy = -2; dy <= 2 && !near; dy++) for (let dx = -2; dx <= 2 && !near; dx++) near = core.has((y + dy) * a.width + x + dx);
              if (!near) continue;
              const Lb = L(b.data, q * 4);
              ring.push((Math.max(Lt, Lb) + 0.05) / (Math.min(Lt, Lb) + 0.05));
            }
            ring.sort((p, q) => p - q);
            out.push({ n: core.size, p10: ring.length ? ring[Math.floor(ring.length * 0.1)] : 0 });
          }
          return out;
        },
        { A, B, colors: list.map((l) => l.color) },
      );
    };
    const looks = [
      ['nocturne', 'dark'], ['nocturne', 'light'], ['eclipse', 'dark'], ['eclipse', 'light'], ['clairdelune', 'light'], ['clairdelune', 'dark'], ['contrast', 'dark'],
      // a wallpaper of the other mode: the icons take the wallpaper's tone
      ['nocturne', 'dark', 'peaks-light', 'light'], ['nocturne', 'light', 'milkyway', 'dark'],
    ];
    for (const [style, mode, wp, tone] of looks) {
      const tag = `${style}-${mode}${wp ? `@${wp}` : ''}`;
      await P.evaluate(async ([st, m, w]) => {
        await (await import('app://shell/core/theme.js')).chooseStyle(st);
        await window.__aurora.settings.set('theme', m);
        if (w) await window.__aurora.settings.set('wallpaper', `app://shell/assets/wallpapers/${w}.jpg`);
        window.__aurora.desktop.select([]);
      }, [style, mode, wp]);
      await P.mouse.move(1000, 300);
      await P.waitForTimeout(1500);
      const ls = await labels();
      const hc = style === 'contrast';
      const plain = ls.every((l) => l.plate === 'rgba(0, 0, 0, 0)' && (hc ? l.bg !== 'rgba(0, 0, 0, 0)' : l.bg === 'rgba(0, 0, 0, 0)' && l.shadow) && l.fs >= 12 && l.fs <= 13);
      check(ls.length === 5 && plain, `desktop ${tag}: nothing behind the icons at rest, ${hc ? 'names on a solid plate' : 'names in plain text with a halo'} (12–13 px)`, JSON.stringify(ls.map(({ id, bg, plate, fs }) => ({ id, bg, plate, fs }))));
      const eff = await effective(ls);
      const worst = Math.min(...eff.map((e) => e.p10));
      check(eff.every((e) => e.n > 15) && worst >= 4.5, `desktop ${tag}: every name reads >= 4.5:1 against the wallpaper and its halo (worst ${worst.toFixed(1)}:1)`, JSON.stringify(eff.map((e, i) => `${ls[i].id} ${e.p10.toFixed(2)} n${e.n}`)));
      if (tone) check(ls.every((l) => l.tone === tone), `desktop ${tag}: the icons take the tone of the wallpaper behind them (${tone})`, ls.map((l) => `${l.id} ${l.tone}`).join(', '));
      if (!wp) {
        // hover: a faint highlight; selection: the accent-subtle highlight; the focus ring only for the keyboard
        await P.hover('.desk-icon[data-special="trash"]');
        await P.click('.desk-icon[data-id$="Projets"]');
        await P.hover('.desk-icon[data-special="trash"]');
        await P.waitForTimeout(250);
        const st = await P.evaluate(() => {
          const cs = (sel) => getComputedStyle(document.querySelector(sel));
          return { hover: [cs('.desk-icon[data-special="trash"]').backgroundColor, cs('.desk-icon[data-special="trash"]').boxShadow], sel: cs('.desk-icon[data-id$="Projets"]').backgroundColor, selShadow: cs('.desk-icon[data-id$="Projets"]').boxShadow, ring: cs('.desk-icon[data-id$="Projets"]').outlineStyle };
        });
        await s.shot(`desktop-icons-${tag}`);
        await P.keyboard.press('ArrowDown');
        await P.waitForTimeout(150);
        const kb = await P.evaluate(() => getComputedStyle(document.activeElement).outlineStyle);
        const hoverOn = st.hover[0] !== 'rgba(0, 0, 0, 0)' || st.hover[1] !== 'none';
        const selOn = st.sel !== 'rgba(0, 0, 0, 0)' || st.selShadow !== 'none';
        check(hoverOn && selOn && st.ring === 'none' && kb === 'solid', `desktop ${tag}: hover and selection highlights, a focus ring for the keyboard only`, JSON.stringify({ ...st, kb }));
      }
    }
    const errs = s.logs.filter((l) => /^\[(error|pageerror)\]/.test(l) && !/Failed to load resource/.test(l));
    check(!errs.length, 'no console errors while the desktop icons switch looks', errs.slice(0, 3).join(' | '));
  } catch (err) {
    check(false, 'desktop icons', err.stack || String(err));
  } finally {
    await s.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
