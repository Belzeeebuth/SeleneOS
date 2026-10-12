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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
