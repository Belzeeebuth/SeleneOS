// Personalization core (area A) — theme engine, visual styles, typography / shape / scale, per-app themes,
// profiles, settings:setMany and the Settings pages (Theme designer, Visual style, Profiles, App themes, stubs).
// See docs/PERSONALIZATION.md.
//
//   xvfb-run -a -s "-screen 0 1600x900x24" node test/personalization-core.test.mjs [--no-shots]
//
// Screenshots: docs/screenshots/style-<name>-<mode>-<lang>-{desktop,start}.png, theme-designer-*.png,
// profiles-*.png, app-themes-*.png.
import { launchShell, ROOT, OUT } from './lib.mjs';
import fs from 'node:fs';
import path from 'node:path';

const ARGS = new Set(process.argv.slice(2));
// --only=e2e: only the end-to-end checklist through the Settings UI (last launch)
const E2E_ONLY = ARGS.has('--only=e2e');
const DOCS = path.join(ROOT, '..', 'docs', 'screenshots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const failures = [];
function check(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  ok  ${msg}`);
  } else {
    failures.push(msg);
    console.log(`  FAIL ${msg}`);
  }
}
const S = (sel) => `.app-settings ${sel}`;

async function docShot(s, name) {
  if (ARGS.has('--no-shots')) return;
  const f = await s.shot(name);
  fs.mkdirSync(DOCS, { recursive: true });
  fs.copyFileSync(f, path.join(DOCS, `${name}.png`));
}
const errorsOf = (s) => s.logs.filter((l) => l.startsWith('[error]') || l.startsWith('[pageerror]'));

// in-page helpers (installed once per launch)
async function install(s) {
  await s.aurora(() => {
    const A = window.__aurora;
    window.__t = {
      set: (k, v) => A.settings.set(k, v),
      get: (k) => A.settings.get(k),
      root: (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim(),
      cs: (sel, prop) => {
        const el = typeof sel === 'string' ? document.querySelector(sel) : sel;
        return el ? getComputedStyle(el)[prop] : null;
      },
      // the element that carries the bar's glass (colour, opacity, blur): in the floating modes (islands, pills) the
      // bar itself is transparent and each part is glass (docs/design/SYSTEM.md §3); docked / vertical: the bar
      bar: () => {
        const tb = document.getElementById('taskbar');
        const part = tb.querySelector(':scope > .tb-part');
        const mode = getComputedStyle(document.documentElement).getPropertyValue('--bar-mode').trim();
        const pos = document.documentElement.dataset.tbPos;
        return part && (mode === 'islands' || mode === 'pills') && pos !== 'left' && pos !== 'right' ? part : tb;
      },
      alpha: (c) => {
        const m = /rgba?\(([^)]+)\)/.exec(c || '') || [];
        const p = (m[1] || '').split(/[\s,/]+/).filter(Boolean);
        return p.length >= 4 ? Number(p[3]) : 1;
      },
      // a throw-away element with shell classes, to read computed styles
      probe: (html) => {
        let host = document.getElementById('pz-probe');
        if (!host) {
          host = document.createElement('div');
          host.id = 'pz-probe';
          Object.assign(host.style, { position: 'fixed', left: '-2000px', top: '0', width: '600px' });
          document.body.appendChild(host);
        }
        host.innerHTML = html;
        return host.firstElementChild;
      },
      settled: () => new Promise((r) => setTimeout(r, 120)),
    };
  });
}
const T = (s, fn, arg) => s.aurora(fn, arg);
async function setKey(s, key, value, wait = 250) {
  await T(s, ([k, v]) => window.__t.set(k, v), [key, value]);
  await sleep(wait);
}
async function waitTransitions(s) {
  for (let i = 0; i < 40; i++) {
    if (!(await T(s, () => document.documentElement.classList.contains('theme-switching')))) return;
    await sleep(50);
  }
}

if (!E2E_ONLY) {
// ===================================================================== launch 1: engine, styles, profiles, pages
// The checks of the Selene styles below describe the flat "Sobre" finish (the look of 2026-10-11, unchanged); the glass
// finishes (Halo, Prisme) have their own section at the end of this launch.
const s = await launchShell({ lang: 'en', theme: 'light', size: '1600x900', open: ['calculator', 'notepad'], settings: { finish: 'sobre', accent: '#c9d3e6', wallpaper: 'builtin:nocturne' } });
await install(s);
await sleep(600);

console.log('\n# Pure helpers (in the renderer)');
{
  const r = await T(s, async () => {
    const th = await import('app://shell/core/theme.js');
    const pr = await import('app://shell/core/profiles.js');
    const sel = th.scopeThemeSelector(':root[data-theme="dark"] .app-calculator .x, .plain');
    const sel2 = th.scopeThemeSelector(':root[data-transparency="off"][data-theme="light"] .app-mail');
    const at = (h, m) => {
      const d = new Date(2026, 0, 1, h, m);
      return th.autoThemeAt({ enabled: true, light: '07:00', dark: '19:00' }, d);
    };
    const night = (h) => th.autoThemeAt({ enabled: true, light: '22:00', dark: '06:00' }, new Date(2026, 0, 1, h, 0));
    const clean = pr.sanitizeValues({ style: 'evil', theme: 'dark', textScale: 999, blur: 30, wallpaper: 'javascript:alert(1)', lockWallpaper: '/home/u/../../etc/passwd', unknown: 1, accent: '#ABCDEF', appThemes: { calculator: { theme: 'dark', accent: 'red' }, notepad: { theme: 'light', accent: '#112233' } }, focusMode: { active: true, dimLevel: 20 }, 'taskbar.color': 'url(x)' });
    return {
      sel,
      sel2,
      times: [at(6, 59), at(7, 0), at(18, 59), at(19, 0), at(23, 0)],
      night: [night(23), night(5), night(12)],
      clean,
      keys: pr.PROFILE_KEYS.length,
      look: pr.LOOK_KEYS.every((k) => pr.PROFILE_KEYS.includes(k)),
    };
  });
  check(r.sel.includes(':root[data-theme="dark"] .app-calculator:where(:not(.win[data-theme-scope], .win[data-theme-scope] *)) .x') && r.sel.includes('.app-calculator:where(.win[data-theme-scope])[data-theme="dark"]') && r.sel.endsWith('.plain'), 'app style sheet selectors are rewritten to follow a window\'s own theme');
  check(r.sel2.startsWith(':root[data-transparency="off"][data-theme="light"] .app-mail:where(') && r.sel2.includes(':root[data-transparency="off"] :is('), 'rewritten selectors keep the other :root conditions');
  check(JSON.stringify(r.times) === JSON.stringify(['dark', 'light', 'light', 'dark', 'dark']), `Auto mode schedule 07:00 → 19:00 (${r.times})`);
  check(JSON.stringify(r.night) === JSON.stringify(['light', 'light', 'dark']), 'Auto mode schedule across midnight');
  check(!('style' in r.clean) && r.clean.theme === 'dark' && !('textScale' in r.clean) && r.clean.blur === 30 && !('wallpaper' in r.clean) && !('lockWallpaper' in r.clean) && !('unknown' in r.clean) && r.clean.accent === '#abcdef', 'profile import: invalid values and unknown keys are dropped');
  check(!r.clean.appThemes.calculator && r.clean.appThemes.notepad?.accent === '#112233' && r.clean.focusMode && !('active' in r.clean.focusMode) && !('taskbar.color' in r.clean), 'profile import: nested values validated, runtime state (focusMode.active) never stored');
  check(r.keys >= 40 && r.look, `PROFILE_KEYS lists every personalization key (${r.keys}), LOOK_KEYS ⊂ PROFILE_KEYS`);
}

console.log('\n# Defaults + settings:setMany');
{
  const d = await T(s, () => window.__aurora.api.invoke('settings:defaults'));
  const keys = ['style', 'autoTheme', 'accentFromWallpaper', 'transparencyLevel', 'blur', 'cornerRadius', 'fontFamily', 'textScale', 'reducedMotion', 'appThemes', 'wallpaperMode', 'animatedWallpaper', 'dynamicWallpaper', 'start', 'focusMode', 'cursorPack', 'iconPack', 'soundPack', 'soundEvents', 'snapPresets', 'shortcuts'];
  check(keys.every((k) => k in d) && ['color', 'opacity', 'size', 'position', 'showLabels', 'combine', 'widgets'].every((k) => k in d.taskbar) && d.taskbar.align === 'center', 'every personalization key (implemented + reserved) has a default; old taskbar defaults kept');
  const r = await T(s, async () => {
    const A = window.__aurora;
    let star = 0;
    let raw = 0;
    let keys = null;
    const off1 = A.settings.on('*', () => star++);
    const off2 = A.api.on('settings:changed', (p) => {
      raw++;
      keys = p.keys;
    });
    await A.api.invoke('settings:setMany', { blur: 30, cornerRadius: 120, 'taskbar.opacity': 60 });
    await new Promise((r) => setTimeout(r, 300));
    off1();
    off2();
    return { star, raw, keys, blur: A.settings.get('blur'), corner: A.settings.get('cornerRadius'), op: A.settings.get('taskbar.opacity'), align: A.settings.get('taskbar.align') };
  });
  check(r.raw === 1 && r.star === 1 && JSON.stringify(r.keys) === JSON.stringify(['blur', 'cornerRadius', 'taskbar.opacity']), `setMany broadcasts ONE settings:changed (${r.raw} broadcast, ${r.star} listener call) with the key list`);
  check(r.blur === 30 && r.corner === 120 && r.op === 60 && r.align === 'center', 'setMany applies every key (dotted keys merge into objects)');
  const r2 = await T(s, async () => {
    await window.__aurora.api.invoke('settings:setMany', {}, { reset: ['blur', 'cornerRadius', 'taskbar.opacity'] });
    const bad = await window.__aurora.api.invoke('settings:setMany', { '__proto__.x': 1 }).then(() => 'accepted', (e) => e.code);
    return { blur: window.__aurora.settings.get('blur'), op: window.__aurora.settings.get('taskbar.opacity'), bad };
  });
  check(r2.blur === 50 && r2.op === null && r2.bad === 'EINVAL', 'setMany resets keys to their defaults and refuses prototype keys');
  await sleep(500); // settings.json is written 150 ms after the last change
  const file = JSON.parse(fs.readFileSync(path.join(s.home, '.config', 'aurora', 'settings.json'), 'utf8'));
  check(!('blur' in file) && !('cornerRadius' in file) && !(file.taskbar && 'opacity' in file.taskbar), 'settings.json keeps only user overrides');
}

console.log('\n# Every key applies live');
{
  // transparency level → alpha of the bar's glass (Nocturne: its islands) / window tint
  const alphaAt = async (lvl) => {
    await setKey(s, 'transparencyLevel', lvl);
    return T(s, () => ({ tb: window.__t.alpha(window.__t.cs(window.__t.bar(), 'backgroundColor')), mica: window.__t.alpha(window.__t.cs(window.__t.probe('<div style="background-color: var(--mica-tint)"></div>'), 'backgroundColor')), tp: window.__t.root('--tp') }));
  };
  const a0 = await alphaAt(0);
  const a50 = await alphaAt(50);
  const a100 = await alphaAt(100);
  check(a0.tb === 1 && a0.mica === 1 && a50.tb <= 0.92 && a50.tb >= 0.8 && a100.tb <= a50.tb && a100.tb >= 0.8 && a100.mica === 1, `transparencyLevel (glass stays 80–92 % opaque, windows opaque): taskbar alpha ${a0.tb} → ${a50.tb.toFixed(2)} → ${a100.tb.toFixed(2)}, window tint ${a0.mica} → ${a100.mica.toFixed(2)}`);
  await setKey(s, 'transparencyLevel', 50);
  await setKey(s, 'transparency', false);
  const off = await T(s, () => ({ attr: document.documentElement.dataset.transparency, bf: window.__t.cs(window.__t.bar(), 'backdropFilter'), a: window.__t.alpha(window.__t.cs(window.__t.bar(), 'backgroundColor')), start: window.__t.cs('#start', 'backdropFilter'), qs: window.__t.cs('#quick-settings', 'backdropFilter') }));
  check(off.attr === 'off' && off.bf === 'none' && off.a === 1 && off.start === 'none' && off.qs === 'none', `transparency off: opaque surfaces, no backdrop blur (bar ${off.bf} at ${off.a}, Lanceur ${off.start}, panel ${off.qs})`);
  await setKey(s, 'transparency', true);
  // blur intensity → backdrop-filter of the glass surfaces: the bar (its islands), the Lanceur, the panels.
  // Menus are flat and opaque in Selene (docs/design/SYSTEM.md §5): no blur whatever the setting.
  await setKey(s, 'blur', 0);
  const b0 = await T(s, () => window.__t.cs(window.__t.bar(), 'backdropFilter'));
  await setKey(s, 'blur', 100);
  const b100 = await T(s, () => ({ tb: window.__t.cs(window.__t.bar(), 'backdropFilter'), menu: window.__t.cs(window.__t.probe('<div class="menu"></div>'), 'backdropFilter'), start: window.__t.cs('#start', 'backdropFilter'), qs: window.__t.cs('#quick-settings', 'backdropFilter') }));
  check(/blur\(0px\)/.test(b0) && /blur\(56px\)/.test(b100.tb) && /blur\(56px\)/.test(b100.start) && /blur\(56px\)/.test(b100.qs) && b100.menu === 'none', `blur intensity: bar ${b0} → ${b100.tb}; Lanceur ${b100.start}; panel ${b100.qs}; menu (flat) ${b100.menu}`);
  await setKey(s, 'blur', 50);
  // corner radius
  const radius = async (v) => {
    await setKey(s, 'cornerRadius', v);
    return T(s, () => {
      const b = window.__t.probe('<button class="btn">x</button>');
      return { btn: window.__t.cs(b, 'borderTopLeftRadius'), win: window.__t.cs('#windows > .win', 'borderTopLeftRadius') };
    });
  };
  const r0 = await radius(0);
  const r200 = await radius(200);
  // Nocturne: 6 px controls, 10 px windows (docs/design/SYSTEM.md §2.4), each × the setting
  check(r0.btn === '0px' && r0.win === '0px' && r200.btn === '12px' && r200.win === '20px', `corner radius 0 % → 200 %: button ${r0.btn} → ${r200.btn}, window ${r0.win} → ${r200.win}`);
  await setKey(s, 'cornerRadius', 100);
  // font family
  await setKey(s, 'fontFamily', 'dejavu-serif');
  const ff = await T(s, () => ({ body: window.__t.cs(document.body, 'fontFamily'), win: window.__t.cs('#windows > .win .win-title', 'fontFamily') }));
  check(/DejaVu Serif/.test(ff.body) && /DejaVu Serif/.test(ff.win), `font family applies everywhere (${ff.body.slice(0, 40)}…)`);
  const missing = await T(s, async () => {
    const th = await import('app://shell/core/theme.js');
    return { inter: th.fontInstalled('inter'), bogus: th.FONTS.length };
  });
  check(missing.inter === true, 'installed fonts are detected (Inter)');
  await setKey(s, 'fontFamily', 'inter');
  // text size (tokens + hard-coded px in app style sheets)
  await T(s, () => window.__aurora.registry.launch('settings', { page: 'personalization' }));
  await sleep(1200);
  const ts = async (v) => {
    await setKey(s, 'textScale', v, 400);
    return T(s, () => ({ body: window.__t.cs(document.body, 'fontSize'), cap: window.__t.cs(window.__t.probe('<span class="caption">x</span>'), 'fontSize'), row: window.__t.cs('.app-settings .st-row', 'fontSize'), title: window.__t.cs('#windows > .win .win-title', 'fontSize') }));
  };
  const t100 = await ts(100);
  const t150 = await ts(150);
  const t80 = await ts(80);
  check(t100.body === '14px' && t150.body === '21px' && t80.body === '11.2px', `text size scales the body text (${t100.body} → ${t150.body} / ${t80.body})`);
  // captions 12 px (--fs-caption), window titles 13 px (--fs-small: text people read is ≥ 13 px), Settings rows 14 px
  check(t100.cap === '12px' && t100.title === '13px' && t150.cap === '18px' && t150.row === '21px' && t150.title === '19.5px', `text size reaches captions, title bars and px sizes in app style sheets (caption ${t100.cap} → ${t150.cap}, title ${t100.title} → ${t150.title}, Settings row ${t100.row} → ${t150.row})`);
  await setKey(s, 'textScale', 100, 400);
  // UI scale (zoom)
  await setKey(s, 'scale', 125, 800);
  const dpr = await T(s, () => window.devicePixelRatio);
  await setKey(s, 'scale', 100, 800);
  const dpr1 = await T(s, () => window.devicePixelRatio);
  check(Math.abs(dpr - 1.25) < 0.01 && Math.abs(dpr1 - 1) < 0.01, `UI scale zooms the shell (${dpr} → ${dpr1})`);
  // reduced motion
  await setKey(s, 'reducedMotion', true);
  const rm = await T(s, () => ({ a: document.documentElement.dataset.animations, r: document.documentElement.dataset.reducedMotion, d: window.__t.cs(window.__t.probe('<div class="menu"></div>'), 'animationDuration') }));
  check(rm.a === 'off' && rm.r === 'on' && rm.d === '0.001s', 'reduced motion: animations off everywhere');
  await setKey(s, 'reducedMotion', false);
  check((await T(s, () => document.documentElement.dataset.animations)) === 'on', 'reduced motion off: animations back');
  // taskbar colour + opacity
  await setKey(s, 'taskbar.color', '#101820');
  const tbDark = await T(s, () => ({ theme: document.getElementById('taskbar').dataset.theme, bg: window.__t.cs(window.__t.bar(), 'backgroundColor'), text: window.__t.cs('#taskbar .tb-btn', 'color') }));
  check(tbDark.theme === 'dark' && /^rgba?\(16, 24, 32/.test(tbDark.bg) && tbDark.text === 'rgb(230, 234, 242)', `taskbar colour: custom dark colour, light icons/text (${tbDark.bg})`);
  await setKey(s, 'taskbar.color', '#f4e8c1');
  check((await T(s, () => document.getElementById('taskbar').dataset.theme)) === 'light', 'taskbar colour: light custom colour keeps dark text');
  await setKey(s, 'taskbar.color', 'accent');
  const tbAcc = await T(s, () => window.__t.cs(window.__t.bar(), 'backgroundColor'));
  await setKey(s, 'taskbar.opacity', 30);
  const tbOp = await T(s, () => window.__t.alpha(window.__t.cs(window.__t.bar(), 'backgroundColor')));
  await setKey(s, 'taskbar.opacity', null);
  await setKey(s, 'taskbar.color', null);
  const tbDef = await T(s, () => ({ theme: document.getElementById('taskbar').dataset.theme || null, bg: window.__t.cs(window.__t.bar(), 'backgroundColor') }));
  check(/^rgba?\(\d+, \d+, \d+/.test(tbAcc) && !/^rgba?\(243, 246, 251/.test(tbAcc) && Math.abs(tbOp - 0.8) < 0.01 && tbDef.theme === null && /^rgba?\(243, 246, 251/.test(tbDef.bg), `taskbar accent colour (${tbAcc}), opacity 30 % clamped to the 0.80 glass floor (${tbOp}), back to default`);
  // accent + light/dark
  await setKey(s, 'accent', '#e3008c', 600);
  await waitTransitions(s);
  check((await T(s, () => window.__t.root('--accent-base'))) === '#e3008c', 'accent colour');
  await setKey(s, 'theme', 'dark', 600);
  await waitTransitions(s);
  check((await T(s, () => window.__t.cs(document.body, 'color'))) === 'rgb(230, 234, 242)', 'dark mode (Nocturne ink text #e6eaf2)');
  await setKey(s, 'theme', 'light', 600);
  await waitTransitions(s);
  // Auto mode drives `theme`
  const want = await T(s, async () => {
    const th = await import('app://shell/core/theme.js');
    const now = new Date();
    const hm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    // dark from 1 minute ago until 1 hour from now
    const cfg = { enabled: true, light: hm(new Date(now.getTime() + 3600e3)), dark: hm(new Date(now.getTime() - 60e3)) };
    await window.__aurora.settings.set('autoTheme', cfg);
    return th.autoThemeAt(cfg);
  });
  await sleep(900);
  await waitTransitions(s);
  check(want === 'dark' && (await T(s, () => window.__t.get('theme'))) === 'dark' && (await T(s, () => document.documentElement.dataset.theme)) === 'dark', 'Auto mode switches the theme by time of day');
  await setKey(s, 'autoTheme', { enabled: false, light: '07:00', dark: '19:00' });
  await setKey(s, 'theme', 'light', 600);
  await waitTransitions(s);
  // accent from wallpaper
  await T(s, () => window.__aurora.settings.set('wallpaper', `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="10"><rect width="16" height="10" fill="#2a7c7a"/></svg>')}`));
  await setKey(s, 'accentFromWallpaper', true, 1500);
  const fw = await T(s, () => window.__t.get('accent'));
  const hue = await T(s, (hex) => {
    const n = parseInt(hex.slice(1), 16);
    const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255);
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return Math.round(h * 60);
  }, fw);
  check(/^#[0-9a-f]{6}$/.test(fw) && fw !== '#e3008c' && hue > 160 && hue < 200, `accent picked from the wallpaper (${fw}, hue ${hue}°)`);
  await setKey(s, 'accentFromWallpaper', false);
  await T(s, () => window.__aurora.settings.set('wallpaper', 'builtin:bloom'));
  await setKey(s, 'accent', '#c9d3e6', 800);
  await waitTransitions(s);
}

console.log('\n# Visual styles');
{
  const sample = async () =>
    T(s, () => {
      const b = window.__t.probe('<button class="btn">x</button>');
      const w = document.querySelector('#windows > .win.app-calculator') || document.querySelector('#windows > .win');
      return {
        style: document.documentElement.dataset.style,
        btnRadius: window.__t.cs(b, 'borderTopLeftRadius'),
        btnShadow: window.__t.cs(b, 'boxShadow'),
        btnBorder: window.__t.cs(b, 'borderTopWidth'),
        winShadow: window.__t.cs(w, 'boxShadow'),
        winBorder: window.__t.cs(w, 'borderTopWidth'),
        titleBg: window.__t.cs(w.querySelector('.win-titlebar'), 'backgroundImage'),
        tbBlur: window.__t.cs(window.__t.bar(), 'backdropFilter'),
        tbAlpha: window.__t.alpha(window.__t.cs(window.__t.bar(), 'backgroundColor')),
        transp: document.documentElement.dataset.transparency,
        accent: window.__t.root('--accent'),
      };
    });
  const res = {};
  const hooks = () =>
    T(s, () => {
      const v = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
      return { bar: v('--bar-mode'), align: v('--bar-apps-align'), margin: v('--bar-margin'), winBw: v('--win-border-w'), sel: v('--sel-bar-w'), grain: v('--panel-grain') !== 'none', amb: document.documentElement.dataset.ambiance, acc: document.documentElement.dataset.accent, mica: v('--mica-image') };
    });
  for (const st of ['nocturne', 'eclipse', 'clairdelune', 'contrast']) {
    await setKey(s, 'style', st, 700);
    await waitTransitions(s);
    res[st] = { ...(await sample()), ...(await hooks()) };
  }
  const w = res.nocturne;
  check(Object.entries(res).every(([k, v]) => v.style === k), 'data-style follows the setting');
  check(w.btnRadius === '6px' && w.winBw === '1px' && w.bar === 'islands' && w.margin === '12px' && /blur\(28px\)/.test(w.tbBlur) && w.tbAlpha >= 0.8 && w.transp === 'on' && w.mica === 'none', `Nocturne: 6 px controls, hairline windows, floating islands, glass bar ${w.tbBlur} at ${w.tbAlpha.toFixed(2)}, no Mica`);
  check(res.eclipse.bar === 'full' && res.eclipse.margin === '0px' && res.eclipse.winBw === '0px' && res.eclipse.sel === '3px', `Éclipse: full-width bar, borderless windows, accent bar on selected rows (${JSON.stringify(res.eclipse)})`);
  check(res.clairdelune.bar === 'pills' && res.clairdelune.winBw === '0px' && res.clairdelune.grain, 'Clair de lune: three pills, borderless windows, grain on the panels');
  check(Object.values(res).every((v) => v.align === 'center'), 'every style centres the bar’s app icons');
  // the follow rule: a plain settings.set('style') brings the style's ambiance and accent (they were defaults)
  check(res.eclipse.amb === 'neutral' && res.eclipse.acc === 'amber' && res.clairdelune.amb === 'warm' && res.clairdelune.acc === 'violet', `choosing a style brings its ambiance and accent (${res.eclipse.amb}/${res.eclipse.acc}, ${res.clairdelune.amb}/${res.clairdelune.acc})`);
  check(res.contrast.btnBorder === '2px' && res.contrast.winBorder === '2px' && res.contrast.winShadow === 'none' && res.contrast.tbAlpha === 1 && res.contrast.tbBlur === 'none' && res.contrast.transp === 'off', `High contrast: thick borders, no shadows, no transparency (bar ${res.contrast.tbBlur} at ${res.contrast.tbAlpha})`);
  // an explicit ambiance survives a style change
  await setKey(s, 'style', 'nocturne', 700);
  await setKey(s, 'ambiance', 'warm', 700);
  await setKey(s, 'style', 'eclipse', 700);
  const kept = await hooks();
  check(kept.amb === 'warm' && kept.acc === 'amber', `an ambiance you chose stays when the style changes (${kept.amb}, accent ${kept.acc})`);
  await T(s, () => window.__aurora.api.invoke('settings:setMany', {}, { reset: ['ambiance', 'accent', 'wallpaper'] }));
  await setKey(s, 'style', 'contrast', 700);
  await waitTransitions(s);

  // palettes: every text token ≥ 4.5:1 on every surface, and the four accents, in 3 ambiances × 2 modes
  const pal = await T(s, async () => {
    const th = await import('app://shell/core/theme.js');
    const lum = (c) => {
      const p = c.match(/[\d.]+/g).map(Number);
      const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(p[0]) + 0.7152 * f(p[1]) + 0.0722 * f(p[2]);
    };
    const cr = (a, b) => {
      const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
      return (x + 0.05) / (y + 0.05);
    };
    const out = [];
    for (const amb of ['cold', 'neutral', 'warm']) {
      for (const mode of ['dark', 'light']) {
        for (const acc of th.ACCENT_PRESETS) {
          const host = window.__t.probe(`<div data-style="nocturne" data-ambiance="${amb}" data-theme-scope data-theme="${mode}"><i></i></div>`);
          const el = host.matches('[data-ambiance]') ? host : host.querySelector('[data-ambiance]');
          for (const [k, v] of Object.entries(th.accentVars(acc.hex, mode))) el.style.setProperty(k, v);
          const col = (n) => {
            el.firstElementChild.style.color = `var(${n})`;
            return getComputedStyle(el.firstElementChild).color;
          };
          let min = 99;
          let worst = '';
          for (const bg of ['--bg', '--bg-alt', '--surface-raised']) {
            for (const fg of ['--text', '--text-2', '--text-3', '--accent-text']) {
              const r = cr(col(fg), col(bg));
              if (r < min) [min, worst] = [r, `${fg} on ${bg}`];
            }
          }
          const on = cr(col('--on-accent'), col('--accent'));
          out.push({ amb, mode, acc: acc.id, min: Math.round(min * 10) / 10, worst, on: Math.round(on * 10) / 10 });
          el.remove();
        }
      }
    }
    return out;
  });
  const lowPal = pal.filter((x) => !(x.min >= 4.5 && x.on >= 4.5));
  check(pal.length === 24 && !lowPal.length, `palettes: text and accent text ≥ 4.5:1 on every surface, text on accent ≥ 4.5:1, 3 ambiances × 2 modes × 4 accents (lowest ${Math.min(...pal.map((x) => x.min))}:1)${lowPal.length ? ` — LOW: ${JSON.stringify(lowPal)}` : ''}`);

  // contrast ≥ 7:1 on key surfaces, light and dark
  const ratios = async () =>
    T(s, async () => {
      const lum = (c) => {
        const p = c.match(/[\d.]+/g).map(Number);
        const f = (v) => {
          v /= 255;
          return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * f(p[0]) + 0.7152 * f(p[1]) + 0.0722 * f(p[2]);
      };
      const bgOf = (el) => {
        for (let e = el; e; e = e.parentElement) {
          const c = getComputedStyle(e).backgroundColor;
          const a = window.__t.alpha(c);
          if (a >= 0.99) return c;
          if (a > 0.05) return null; // translucent: not measurable
        }
        return 'rgb(0, 0, 0)';
      };
      const out = [];
      const add = (name, el) => {
        if (!el) return out.push({ name, ratio: 0, missing: true });
        const fg = getComputedStyle(el).color;
        const bg = bgOf(el);
        if (!bg) return out.push({ name, ratio: 0, translucent: true });
        const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
        out.push({ name, ratio: Math.round(((a + 0.05) / (b + 0.05)) * 10) / 10 });
      };
      const settings = document.querySelector('#windows > .win.app-settings');
      settings?.querySelector('.win-titlebar')?.click();
      window.__aurora.wm.byApp('settings')[0]?.focus();
      await new Promise((r) => setTimeout(r, 300));
      add('active title', settings?.querySelector('.win-title'));
      add('settings row title', settings?.querySelector('.st-row-title, .pz-ctl-title'));
      add('settings row description', settings?.querySelector('.st-row-desc, .pz-ctl-desc'));
      add('settings nav item', settings?.querySelector('.st-nav-item .ellipsis'));
      add('inactive window title', document.querySelector('#windows > .win.app-notepad .win-title'));
      add('taskbar clock', document.querySelector('#taskbar .tb-clock-text'));
      const b = window.__t.probe('<div style="background: var(--bg)"><button class="btn">Button</button> <button class="btn primary">Primary</button><span class="text-2">secondary</span><span class="text-3">tertiary</span><a href="#">link</a></div>');
      add('button', b.querySelector('.btn'));
      add('primary button', b.querySelector('.btn.primary'));
      add('secondary text', b.querySelector('.text-2'));
      add('tertiary text', b.querySelector('.text-3'));
      add('link', b.querySelector('a'));
      document.querySelector('.tb-start').click();
      await new Promise((r) => setTimeout(r, 700));
      add('Start tile label', document.querySelector('#start .start-tile-label'));
      add('Start section title', document.querySelector('#start .start-section-title'));
      document.querySelector('.tb-start').click();
      await new Promise((r) => setTimeout(r, 400));
      window.__aurora.ui.menu({ x: 400, y: 300 }, [{ label: 'Menu item' }]);
      await new Promise((r) => setTimeout(r, 300));
      add('menu item', document.querySelector('body > .menu .menu-item .label'));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return out;
    });
  await T(s, () => window.__aurora.registry.launch('settings', { page: 'visualStyle' }));
  await sleep(1200);
  for (const mode of ['dark', 'light']) {
    await setKey(s, 'theme', mode, 800);
    await waitTransitions(s);
    const r = await ratios();
    const low = r.filter((x) => !(x.ratio >= 7));
    check(!low.length, `High contrast (${mode}): every key text ≥ 7:1 — ${r.map((x) => `${x.name} ${x.ratio}`).join(', ')}${low.length ? ` — LOW: ${low.map((x) => x.name).join(', ')}` : ''}`);
  }
  await setKey(s, 'theme', 'light', 800);
  await setKey(s, 'style', 'nocturne', 800);
  await waitTransitions(s);
}

console.log('\n# Per-app themes');
{
  await T(s, () => window.__aurora.settings.set('appThemes', { calculator: { theme: 'dark', accent: '#e81123' } }));
  await sleep(500);
  const r = await T(s, () => {
    const calc = document.querySelector('#windows > .win.app-calculator');
    const np = document.querySelector('#windows > .win.app-notepad');
    const v = (el, n) => getComputedStyle(el).getPropertyValue(n).trim();
    return {
      calcTheme: calc.dataset.theme,
      calcText: getComputedStyle(calc).color,
      calcAccent: v(calc, '--accent-base'),
      calcAppVar: v(calc, '--ck-num'),
      sysRaised: v(document.documentElement, '--surface-raised'),
      calcBg: getComputedStyle(calc).backgroundColor,
      npTheme: np.dataset.theme || null,
      npText: getComputedStyle(np).color,
      npAccent: v(np, '--accent-base'),
      sysAccent: v(document.documentElement, '--accent-base'),
      root: document.documentElement.dataset.theme,
    };
  });
  check(r.calcTheme === 'dark' && r.calcText === 'rgb(230, 234, 242)' && r.calcBg === 'rgb(18, 24, 38)' && r.calcAccent === '#e81123', `Calculator alone is dark with its own accent (${JSON.stringify(r)})`);
  // the Calculator's own key colours are built from tokens on its window (--ck-num: var(--surface-raised)): in its dark
  // window they take the dark raised surface (Nocturne #1a2133), not the system's light one
  check(r.calcAppVar.toLowerCase() === '#1a2133' && r.sysRaised.toLowerCase() !== '#1a2133', `the app's own colours follow its window (--ck-num ${r.calcAppVar}, system raised surface ${r.sysRaised})`);
  check(r.npTheme === null && r.npText !== 'rgb(230, 234, 242)' && r.npAccent === r.sysAccent && !!r.sysAccent && r.root === 'light', 'Notepad and the shell keep the system theme');
  // a menu opened from the calculator matches it
  const m = await T(s, async () => {
    const calc = document.querySelector('#windows > .win.app-calculator');
    window.__aurora.wm.byApp('calculator')[0].focus();
    calc.querySelector('.win-body').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    window.__aurora.ui.menu({ x: 500, y: 300 }, [{ label: 'x' }]);
    await new Promise((r) => setTimeout(r, 200));
    const menu = document.querySelector('body > .menu');
    const out = { theme: menu?.dataset.theme, bg: menu && getComputedStyle(menu).backgroundColor };
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return out;
  });
  // menus are flat and opaque (--surface-raised, docs/design/SYSTEM.md §5): the dark raised surface #1a2133
  check(m.theme === 'dark' && m.bg === 'rgb(26, 33, 51)', `a menu opened from that app uses its theme (${m.theme}, ${m.bg})`);
  // new window of a themed app, and system dark + app forced light
  await T(s, () => window.__aurora.settings.set('appThemes', { notepad: { theme: 'light', accent: null } }));
  await setKey(s, 'theme', 'dark', 900);
  await waitTransitions(s);
  const r2 = await T(s, () => {
    const calc = document.querySelector('#windows > .win.app-calculator');
    const np = document.querySelector('#windows > .win.app-notepad');
    return { calc: calc.dataset.theme || null, calcText: getComputedStyle(calc).color, np: np.dataset.theme, npText: getComputedStyle(np).color, npAccent: getComputedStyle(np).getPropertyValue('--on-accent').trim() };
  });
  check(r2.calc === null && r2.calcText === 'rgb(230, 234, 242)' && r2.np === 'light' && r2.npText !== 'rgb(230, 234, 242)' && r2.npAccent === '#ffffff', `system dark + Notepad forced light: only Notepad is light (light accent shades); Calculator back to the system theme (${JSON.stringify(r2)})`);
  await T(s, () => window.__aurora.registry.launch('calculator', { newWindow: true }));
  await sleep(800);
  await T(s, () => window.__aurora.settings.set('appThemes', { calculator: { theme: 'light', accent: null } }));
  await sleep(400);
  check((await T(s, () => [...document.querySelectorAll('#windows > .win.app-calculator')].map((w) => w.dataset.theme).join(','))) === 'light,light', 'every window of the app (also new ones) follows its theme');
  await T(s, () => {
    for (const w of window.__aurora.wm.byApp('calculator').slice(1)) w.close(true);
    return window.__aurora.settings.set('appThemes', {});
  });
  await setKey(s, 'theme', 'light', 900);
  await waitTransitions(s);
  check((await T(s, () => document.querySelectorAll('#windows > .win[data-theme-scope]').length)) === 0, 'resetting app themes removes every window override');
}

console.log('\n# Profiles');
{
  const r = await T(s, async () => {
    const { profiles } = window.__aurora.theme;
    const list = await profiles.list();
    let vt = 0;
    const orig = document.startViewTransition.bind(document);
    document.startViewTransition = (cb) => {
      vt++;
      return orig(cb);
    };
    await profiles.apply('contrast');
    document.startViewTransition = orig;
    await new Promise((r) => setTimeout(r, 300));
    const A = window.__aurora.settings;
    return {
      builtins: list.filter((p) => p.builtin).map((p) => p.id),
      vt,
      style: A.get('style'),
      font: A.get('fontFamily'),
      wall: String(A.get('wallpaper')).startsWith('data:image/svg+xml'),
      attr: document.documentElement.dataset.style,
      switching: document.documentElement.classList.contains('theme-switching'),
      current: await profiles.current(),
      textScale: A.get('textScale'),
    };
  });
  check(['aurora-light', 'aurora-dark', 'eclipse', 'clairdelune', 'contrast'].every((id) => r.builtins.includes(id)) && !r.builtins.some((id) => ['glass', 'minimal', 'retro', 'night-owl'].includes(id)), `built-in profiles (${r.builtins.join(', ')})`);
  check(r.style === 'contrast' && r.font === 'inter' && r.wall && r.attr === 'contrast' && r.current === 'contrast', 'one click applies a built-in profile (style, font, wallpaper)');
  check(r.vt === 1 && !r.switching, `apply cross-fades the whole UI once and ends cleanly (${r.vt} view transition)`);
  // user profiles: save, change, re-apply, rename, duplicate, export/import, delete
  await T(s, () => window.__aurora.settings.set('textScale', 110));
  await sleep(300);
  const u = await T(s, async () => {
    const { profiles } = window.__aurora.theme;
    const A = window.__aurora.settings;
    const p = await profiles.saveCurrent('  My <b>retro</b>\n look  ');
    const savedName = p.name;
    await profiles.apply('aurora-dark');
    const afterDark = { style: A.get('style'), theme: A.get('theme'), textScale: A.get('textScale') };
    await A.set('cornerRadius', 150);
    await profiles.apply(p.id);
    await new Promise((r) => setTimeout(r, 300));
    const back = { style: A.get('style'), theme: A.get('theme'), textScale: A.get('textScale'), corner: A.get('cornerRadius'), cur: await profiles.current() };
    await profiles.rename(p.id, 'Renamed');
    const dup = await profiles.duplicate(p.id);
    const json = profiles.exportJson(await profiles.get(p.id));
    const imp = await profiles.importJson(json);
    const errs = [];
    for (const bad of ['{nope', JSON.stringify({ format: 'other', version: 1, values: {} }), JSON.stringify({ format: 'aurora-profile', version: 1, values: { evil: 1 } }), 'x'.repeat(300000)]) {
      errs.push(await profiles.importJson(bad).then(() => 'accepted', (e) => e.code));
    }
    const listed = (await profiles.list()).filter((x) => !x.builtin).map((x) => x.name);
    const stored = await window.__aurora.api.invoke('storage:get', 'shell', 'profiles', null);
    await profiles.remove(dup.id);
    await profiles.remove(imp.id);
    const after = (await profiles.list()).filter((x) => !x.builtin).length;
    return { name: savedName, afterDark, back, dup: dup.name, imp: imp.name, impSame: JSON.stringify(imp.values) === JSON.stringify((await profiles.get(p.id)).values), errs, listed, stored: stored?.profiles?.length, after, id: p.id, jsonOk: JSON.parse(json).format === 'aurora-profile' };
  });
  check(u.name === 'My <b>retro</b> look', `saved profile name is cleaned (“${u.name}”)`);
  check(u.afterDark.style === 'nocturne' && u.afterDark.theme === 'dark' && u.afterDark.textScale === 110, 'built-in profiles change the look but keep accessibility choices (text size)');
  check(u.back.style === 'contrast' && u.back.theme === 'dark' && u.back.textScale === 110 && u.back.corner === 100 && u.back.cur === u.id, 'a saved profile restores the whole look (keys missing from it go back to their defaults)');
  check(u.dup === 'Renamed (copy)' && u.imp === 'Renamed' && u.impSame && u.jsonOk, 'rename, duplicate, export → import round trip');
  check(u.errs.every((e) => e === 'EINVAL'), `invalid profile files are refused (${u.errs.join(', ')})`);
  check(u.stored === 3 && u.after === 1, 'profiles persist in storage (shell/profiles) and can be deleted');
  // focusMode.active is never part of a profile
  const fm = await T(s, async (id) => {
    const { profiles } = window.__aurora.theme;
    await window.__aurora.settings.set('focusMode.active', true);
    await profiles.apply(id);
    return window.__aurora.settings.get('focusMode.active');
  }, u.id);
  check(fm === true, 'applying a profile keeps the runtime focus-mode state');
  await T(s, () => window.__aurora.settings.set('focusMode.active', false));
  // shell event
  await T(s, () => window.__aurora.shell.emit('profiles:apply', { id: 'eclipse' }));
  await sleep(1200);
  check((await T(s, () => window.__t.get('style'))) === 'eclipse', "shell.emit('profiles:apply', { id }) applies a profile from anywhere");
  await T(s, () => window.__aurora.theme.profiles.apply('aurora-light'));
  await setKey(s, 'textScale', 100, 300);
}

console.log('\n# Security (settings backend + profile import)');
{
  const r = await T(s, async () => {
    const A = window.__aurora;
    const code = (p) => p.then(() => 'accepted', (e) => e.code || e.message);
    return {
      set: await code(A.api.invoke('settings:set', '__proto__.polluted', 'yes')),
      set2: await code(A.api.invoke('settings:set', 'constructor.prototype.polluted', 'yes')),
      reset: await code(A.api.invoke('settings:reset', '__proto__.toString')),
      empty: await code(A.api.invoke('settings:set', 'a..b', 1)),
    };
  });
  const main = await s.app.evaluate(() => [({}).polluted, typeof ({}).toString]);
  check(r.set === 'EINVAL' && r.set2 === 'EINVAL' && r.reset === 'EINVAL' && r.empty === 'EINVAL' && main[0] === undefined && main[1] === 'function', `settings:set / settings:reset refuse prototype keys; the main process is not polluted (${JSON.stringify(r)})`);
  const v = await T(s, async () => {
    const { profiles } = window.__aurora.theme;
    const values = {
      cursorPack: '"); background: url(javascript:alert(1)',
      iconPack: 'fluent',
      soundPack: 'a'.repeat(500),
      'taskbar.position': 'diagonal',
      'taskbar.size': 'large',
      'taskbar.widgets': ['weather', { evil: 1 }, '<img src=x onerror=alert(1)>'],
      'start.background': 'url(x)',
      'start.folders': ['documents', '../../root'],
      'start.groups': [{ id: 'g', name: `<b>${'x'.repeat(200)}`, apps: ['files', 7, '"x'] }],
      snapPresets: [{ id: 'p', name: 'n', zones: [{ x: -5, y: 'a', w: 2, h: 1e9 }, { x: 0, y: 0, w: 0.5, h: 1 }, { x: 0.8, y: 0, w: 0.5, h: 1 }] }],
      // only catalog actions (core/shortcuts.js) with combos Settings would accept; null = turned off
      shortcuts: { start: 'Super+S', evil: { nested: true }, 'x"y': 'Ctrl+K', run: 'Ctrl+<script>', lock: 'Ctrl+C', search: null, 'app:../x': 'Super+K' },
      soundEvents: { notification: '/etc/shadow', startup: 'javascript:alert(1)', shutdown: '/usr/share/sounds/x.ogg' },
      focusMode: { active: true, dimLevel: 900, hideNotifications: 'yes', duration: 30 },
      wallpaperMode: 'evil',
      animatedWallpaper: { id: '"><x>', speed: 40 },
      dynamicWallpaper: { source: 'weather', set: 'bloom', location: { name: '<b>Paris</b>', lat: 48.8, lon: 2.3 } },
      appThemes: JSON.parse('{"__proto__": {"theme":"dark","accent":null}, "constructor": {"theme":"dark","accent":null}, "calculator": {"theme":"dark","accent":"#112233"}}'),
      wallpaper: 'https://tracker.example/pixel.png',
      lockWallpaper: `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg"><image href="https://tracker.example/x.png"/></svg>')}`,
    };
    const p = await profiles.importJson(JSON.stringify({ format: 'aurora-profile', version: 1, name: 'fuzz', values }));
    await profiles.remove(p.id);
    return p.values;
  });
  check(!('cursorPack' in v) && ['fluent', 'selene'].includes(v.iconPack) && !('soundPack' in v) && !('taskbar.position' in v) && v['taskbar.size'] === 'large' && JSON.stringify(v['taskbar.widgets']) === '["weather"]' && !('start.background' in v) && JSON.stringify(v['start.folders']) === '["documents"]', 'import: pack ids, taskbar and Start values are strictly validated (no CSS / HTML injection, no path tricks)');
  check(JSON.stringify(v['start.groups'][0].apps) === '["files"]' && v['start.groups'][0].name.length <= 60 && !/[<>]/.test(v['start.groups'][0].name) && JSON.stringify(v.snapPresets[0].zones) === '[{"x":0,"y":0,"w":0.5,"h":1}]', 'import: Start groups and snap layout zones are validated (bounded names, zones inside the screen)');
  check(JSON.stringify(v.shortcuts) === '{"start":"Super+S","search":null}' && JSON.stringify(v.soundEvents) === '{"shutdown":"/usr/share/sounds/x.ogg"}' && JSON.stringify(v.focusMode) === '{"duration":30}', `import: shortcuts, sound files and focus mode values are validated (${JSON.stringify(v.shortcuts)} ${JSON.stringify(v.soundEvents)})`);
  check(!('wallpaperMode' in v) && !('animatedWallpaper' in v) && v.dynamicWallpaper?.location?.lat === 48.8 && JSON.stringify(Object.keys(v.appThemes)) === '["calculator"]' && !('wallpaper' in v) && !('lockWallpaper' in v), `import: wallpaper values validated; no prototype keys; remote pictures (tracking) refused (${JSON.stringify(v.dynamicWallpaper)})`);
}

{
  // an error inside the cross-fade (e.g. settings:setMany refusing a patch) reaches the caller, and the UI is not stuck
  const tr = await T(s, async () => {
    const code = await window.__aurora.theme
      .transition(async () => {
        throw Object.assign(new Error('boom'), { code: 'EBOOM' });
      })
      .then(() => 'resolved', (e) => e.code);
    return { code, switching: document.documentElement.classList.contains('theme-switching') };
  });
  check(tr.code === 'EBOOM' && !tr.switching, `theme.transition(): errors reach the caller, the cross-fade ends (${JSON.stringify(tr)})`);
}

console.log('\n# Auto mode respects a manual choice');
{
  const r = await T(s, async () => {
    const A = window.__aurora;
    const wait = (ms) => new Promise((res) => setTimeout(res, ms));
    const now = new Date();
    const hm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const cfg = { enabled: true, light: hm(new Date(now.getTime() + 3600e3)), dark: hm(new Date(now.getTime() - 60e3)) };
    await A.settings.set('autoTheme', cfg);
    await wait(700);
    const auto = A.settings.get('theme');
    await A.settings.set('theme', 'light'); // quick settings "dark mode" off
    await wait(400);
    await A.api.invoke('settings:setMany', { blur: 45 }); // any other change
    await wait(700);
    const kept = A.settings.get('theme');
    await A.settings.set('autoTheme', { ...cfg, enabled: false });
    await A.settings.set('autoTheme', cfg); // turning Auto on again applies the schedule
    await wait(700);
    const again = A.settings.get('theme');
    await A.api.invoke('settings:setMany', { autoTheme: { enabled: false, light: '07:00', dark: '19:00' }, theme: 'light' }, { reset: ['blur'] });
    await wait(600);
    return { auto, kept, again };
  });
  await waitTransitions(s);
  check(r.auto === 'dark' && r.kept === 'light' && r.again === 'dark', `Auto mode: a manual light/dark choice is kept until the next boundary, re-enabling Auto applies the schedule (${JSON.stringify(r)})`);
}

console.log('\n# Title bars, clock, tooltips, motion, Mica');
{
  // tabs / fields that apps put in the title bar stay readable where a style recolours the title bar
  const tabRatio = async () =>
    T(s, () => {
      const w = window.__aurora.wm.byApp('notepad')[0];
      w.focus();
      const tab = w.el.querySelector('.win-tb-slot .active');
      const lum = (c) => {
        const p = (c.match(/[\d.]+/g) || []).map(Number);
        const f = (x) => ((x /= 255) <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
        return 0.2126 * f(p[0]) + 0.7152 * f(p[1]) + 0.0722 * f(p[2]);
      };
      const bgEl = tab.querySelector(':scope > [class$="-bg"]') || tab;
      const [a, b] = [lum(getComputedStyle(tab).color), lum(getComputedStyle(bgEl).backgroundColor)].sort((x, y) => y - x);
      return Math.round(((a + 0.05) / (b + 0.05)) * 10) / 10;
    });
  const ratios = {};
  // only High contrast recolours the title bar (the Selene styles keep it in the window's own colours)
  for (const [st, mode] of [['contrast', 'dark'], ['contrast', 'light']]) {
    await T(s, ([a, b]) => window.__aurora.api.invoke('settings:setMany', { style: a, theme: b }), [st, mode]);
    await sleep(900);
    await waitTransitions(s);
    ratios[`${st}-${mode}`] = await tabRatio();
  }
  check(Object.entries(ratios).every(([k, x]) => x >= (k.startsWith('contrast') ? 7 : 4.5)), `Notepad's tab in the title bar is readable in High contrast (${JSON.stringify(ratios)})`);
  // the taskbar clock fits the taskbar at the largest text size
  await T(s, () => window.__aurora.api.invoke('settings:setMany', { style: 'eclipse', theme: 'light', textScale: 150 }));
  await sleep(900);
  const clock = await T(s, () => {
    const c = document.querySelector('#taskbar .tb-clock-text').getBoundingClientRect();
    const tb = document.getElementById('taskbar').getBoundingClientRect();
    return { inside: c.top >= tb.top && c.bottom <= tb.bottom, fs: getComputedStyle(document.querySelector('#taskbar .tb-clock')).fontSize };
  });
  check(clock.inside, `text size 150 %: the taskbar clock stays inside the taskbar (${clock.fs})`);
  await T(s, () => window.__aurora.api.invoke('settings:setMany', {}, { reset: ['style', 'theme', 'textScale'] }));
  await sleep(900);
  await waitTransitions(s);
  // tooltips over a window with its own theme use that theme
  await T(s, () => window.__aurora.settings.set('appThemes', { notepad: { theme: 'dark', accent: null } }));
  await sleep(400);
  const tipBox = await T(s, () => {
    window.__aurora.wm.byApp('notepad')[0].focus();
    const el = document.querySelector('#windows > .win.app-notepad [data-tip]');
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await s.page.mouse.move(tipBox.x, tipBox.y);
  await sleep(1000);
  const tip = await T(s, () => document.querySelector('body > .tooltip')?.dataset.theme || null);
  await s.page.mouse.move(800, 880);
  await T(s, () => window.__aurora.settings.set('appThemes', {}));
  check(tip === 'dark', `a tooltip over a dark-themed app window is dark (system light) (${tip})`);
  // reduced motion: infinite animations play once (no flickering spinners)
  await setKey(s, 'reducedMotion', true);
  const iter = await T(s, () => {
    const el = window.__t.probe('<div style="animation: spin 1s linear infinite"></div>');
    return getComputedStyle(el).animationIterationCount;
  });
  await setKey(s, 'reducedMotion', false);
  check(iter === '1', `reduced motion: infinite animations run once (${iter})`);
  // dragging the blur slider re-blurs the Mica copy once, when it rests
  const mica = await T(s, async () => {
    let n = 0;
    const off = window.__aurora.theme.on('mica', () => n++);
    for (let i = 0; i < 12; i++) {
      window.__aurora.settings.set('blur', 30 + i * 4);
      await new Promise((r) => setTimeout(r, 70));
    }
    // one re-blur once the slider rests (160 ms); a loaded machine may take a few seconds to decode + blur
    for (let i = 0; i < 40 && !n; i++) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 400));
    off?.();
    await window.__aurora.settings.set('blur', 50);
    return n;
  });
  const micaImg = await T(s, () => document.documentElement.style.getPropertyValue('--mica-image'));
  check(mica === 0 && micaImg === 'none', `blur slider drag: flat windows (no Mica), so no blurred wallpaper copy is ever computed (${mica}× for 12 steps, --mica-image ${micaImg})`);
  await sleep(500);
}

console.log('\n# Leaks');
{
  const r = {};
  // count from a quiet screen: the pointer left over a bar button keeps a window preview open (11 nodes) that would
  // close during the switches and read as a negative "leak"
  await s.page.mouse.move(800, 300);
  await s.page.waitForFunction(() => !document.querySelector('#flyouts .tb-preview'), null, { timeout: 5000 }).catch(() => {});
  await waitTransitions(s);
  await T(s, async () => {
    const A = window.__aurora;
    const count = () => ({ nodes: document.getElementsByTagName('*').length, head: document.head.children.length, sheets: document.styleSheets.length });
    const before = count();
    const styles = ['nocturne', 'eclipse', 'clairdelune', 'contrast'];
    for (let i = 0; i < 20; i++) {
      await A.settings.set('style', styles[i % 5]);
      await A.settings.set('theme', i % 2 ? 'dark' : 'light');
      await new Promise((res) => setTimeout(res, 50));
    }
    await A.api.invoke('settings:setMany', { style: 'nocturne', theme: 'light' });
    window.__leakBefore = before;
  });
  await sleep(1200);
  await waitTransitions(s);
  Object.assign(
    r,
    await T(s, () => ({
      before: window.__leakBefore,
      after: { nodes: document.getElementsByTagName('*').length, head: document.head.children.length, sheets: document.styleSheets.length },
      style: document.documentElement.dataset.style,
      theme: document.documentElement.dataset.theme,
      switching: document.documentElement.classList.contains('theme-switching'),
    })),
  );
  check(r.after.head === r.before.head && r.after.sheets === r.before.sheets && Math.abs(r.after.nodes - r.before.nodes) < 10 && r.style === 'nocturne' && r.theme === 'light' && !r.switching, `20 rapid style + mode switches: no leaked nodes / style sheets, screen in sync (${JSON.stringify(r.before)} → ${JSON.stringify(r.after)}, ${r.style}/${r.theme}${r.switching ? ', still switching' : ''})`);
  // Settings pages release their settings listeners
  await T(s, async () => {
    const m = await import('app://shell/core/settings.js');
    const orig = m.settings.on;
    window.__subs = new Set();
    m.settings.__origOn = orig;
    m.settings.on = function (k, fn) {
      const off = orig.call(this, k, fn);
      const tok = {};
      window.__subs.add(tok);
      return () => {
        window.__subs.delete(tok);
        return off();
      };
    };
  });
  for (let i = 0; i < 3; i++) {
    for (const pg of ['themeDesigner', 'profiles', 'visualStyle', 'appThemes', 'colors', 'textSize', 'visualEffects']) {
      await T(s, (p) => window.__aurora.registry.launch('settings', { page: p }), pg);
      await sleep(300);
    }
  }
  await sleep(500);
  const open = await T(s, () => window.__subs.size);
  await T(s, async () => {
    const m = await import('app://shell/core/settings.js');
    m.settings.on = m.settings.__origOn;
  });
  check(open <= 12, `Settings pages release their listeners when you navigate (${open} live after 21 page switches)`);
}

console.log('\n# Settings pages');
{
  const go = async (page) => {
    await T(s, (p) => window.__aurora.registry.launch('settings', { page: p }), page);
    await s.page.waitForSelector(S(`.st-page[data-page="${page}"]`), { timeout: 8000 });
    await sleep(500);
  };
  await T(s, () => {
    const w = window.__aurora.wm.byApp('settings')[0];
    w.focus();
    if (w.state !== 'maximized') w.maximize();
  });
  await go('personalization');
  const home = await s.page.locator(S('.st-row-title')).allInnerTexts();
  // Selene names (docs/design/BRIEF.md): Concentration → "Focus", Dispositions → "Layouts", Lanceur → "Launcher"
  const pages = ['Theme designer', 'Visual style', 'Profiles', 'App themes', 'Animated & dynamic wallpapers', 'Focus', 'Cursors', 'Icon packs', 'Sound packs', 'Keyboard shortcuts', 'Layouts', 'Taskbar', 'Launcher'];
  check(pages.every((x) => home.includes(x)), `Personalization lists every personalization page${pages.some((x) => !home.includes(x)) ? ` — missing: ${pages.filter((x) => !home.includes(x)).join(', ')} (${home.join(', ')})` : ''}`);
  // Theme designer
  await go('themeDesigner');
  check((await s.page.locator(S('.pz-mock .win')).count()) === 1 && (await s.page.locator(S('.pz-mock-taskbar')).count()) === 1 && (await s.page.locator(S('.pz-mock-start')).count()) === 1 && (await s.page.locator(S('.pz-mock-qs')).count()) === 1, 'Theme designer: live preview with a window, Start, a flyout and the taskbar');
  await s.page.locator(S('.pz-style-card[data-style-id="eclipse"]')).first().click();
  await sleep(900);
  await waitTransitions(s);
  const pvGlass = await T(s, () => ({ style: window.__t.get('style'), pv: getComputedStyle(document.querySelector('.app-settings .pz-mock .win-ctl')).width, radius: getComputedStyle(document.querySelector('.app-settings .pz-mock .win')).borderTopLeftRadius }));
  check(pvGlass.style === 'eclipse' && pvGlass.radius === '8px', `Theme designer: style card applies the style, the preview follows (8 px Éclipse windows, ${pvGlass.radius})`);
  for (const [key, val] of [['blur', 20], ['cornerRadius', 150], ['textScale', 120], ['transparencyLevel', 70]]) {
    await s.page.evaluate(([k, v]) => {
      const inp = document.querySelector(`.app-settings .pz-slider[data-key="${k}"] input.slider`);
      inp.value = v;
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new Event('change', { bubbles: true }));
    }, [key, val]);
  }
  await sleep(600);
  const vals = await T(s, () => ['blur', 'cornerRadius', 'textScale', 'transparencyLevel'].map((k) => window.__t.get(k)));
  check(JSON.stringify(vals) === JSON.stringify([20, 150, 120, 70]), `Theme designer sliders write the settings (${vals})`);
  const mockR = await T(s, () => getComputedStyle(document.querySelector('.app-settings .pz-mock .win')).borderTopLeftRadius);
  check(mockR === '12px', `the preview reflects the corner radius instantly (8 px × 150 % = ${mockR})`);
  await s.page.locator(S('.pz-mode button'), { hasText: 'Dark' }).click();
  await sleep(900);
  await waitTransitions(s);
  check((await T(s, () => document.documentElement.dataset.theme)) === 'dark', 'Theme designer: mode');
  await s.page.locator(S('.pz-mode button'), { hasText: 'Auto' }).click();
  await sleep(400);
  check((await T(s, () => window.__t.get('autoTheme').enabled)) === true && (await s.page.locator(S('.pz-auto')).first().isVisible()), 'Theme designer: Auto mode shows the light / dark times');
  await s.page.locator(S('.pz-mode button'), { hasText: 'Dark' }).click();
  await sleep(700);
  await s.page.locator(S('.pz-swatches .pz-swatch[aria-label="Violet"]')).first().click();
  await sleep(700);
  check((await T(s, () => window.__t.get('accent'))) === '#a58bf2' && (await T(s, () => document.documentElement.dataset.accent)) === 'violet', 'Theme designer: named accent swatch (Violet → data-accent="violet")');
  // keyboard: the style cards and the swatches are one Tab stop each; arrows move, Enter picks, focus stays
  const kb = await T(s, async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const key = (k) => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
    const cards = [...document.querySelectorAll('.app-settings .pz-designer .pz-style-card')];
    const cardStops = cards.filter((c) => c.tabIndex === 0).map((c) => c.dataset.styleId);
    cards.find((c) => c.tabIndex === 0).focus();
    key('ArrowRight');
    const right = document.activeElement.dataset.styleId;
    key('End');
    const end = document.activeElement.dataset.styleId;
    key('Home');
    const home = document.activeElement.dataset.styleId;
    const sw = [...document.querySelectorAll('.app-settings .pz-designer .pz-swatches .pz-swatch')];
    const swStops = sw.filter((b) => b.tabIndex === 0).map((b) => b.getAttribute('aria-label'));
    sw.find((b) => b.tabIndex === 0).focus();
    key('ArrowRight');
    const next = document.activeElement.getAttribute('aria-label');
    document.activeElement.click();
    await wait(800);
    return { cardStops, right, end, home, swStops, next, accent: window.__aurora.settings.get('accent'), focused: document.activeElement.getAttribute('aria-label'), selected: document.activeElement.getAttribute('aria-selected') };
  });
  check(kb.cardStops.length === 1 && kb.right !== kb.cardStops[0] && kb.end === 'contrast' && kb.home === 'nocturne', `keyboard: style cards are one Tab stop, arrows / Home / End move between them (${JSON.stringify(kb.cardStops)} → ${kb.right}, ${kb.end}, ${kb.home})`);
  check(kb.swStops.length === 1 && kb.swStops[0] === 'Violet' && kb.next === 'Amber' && kb.accent === '#e9b566' && kb.focused === 'Amber' && kb.selected === 'true', `keyboard: accent swatches — one Tab stop on the selected colour, arrows move, Enter picks and the focus stays (${JSON.stringify(kb)})`);
  await s.page.locator(S('.st-combo[data-key="fontFamily"]')).click();
  await s.page.locator('.menu.st-combo-menu .menu-item', { hasText: 'DejaVu Sans' }).first().click();
  await sleep(400);
  check((await T(s, () => window.__t.get('fontFamily'))) === 'dejavu-sans', 'Theme designer: font');
  await s.page.locator(S('.st-combo[data-key="taskbar.color"]')).click();
  await s.page.locator('.menu.st-combo-menu .menu-item', { hasText: 'Accent color' }).click();
  await sleep(400);
  check((await T(s, () => window.__t.get('taskbar.color'))) === 'accent' && (await T(s, () => document.querySelector('.app-settings .pz-mock-taskbar').dataset.theme)) === 'dark', 'Theme designer: taskbar colour (the preview taskbar follows)');
  await s.page.locator(S('.pz-ctl[data-section="reducedMotion"] .toggle input')).click();
  await sleep(300);
  check((await T(s, () => window.__t.get('reducedMotion'))) === true, 'Theme designer: reduced motion');
  await s.page.locator(S('.pz-ctl[data-section="reducedMotion"] .toggle input')).click();
  await sleep(300);
  await docShot(s, 'theme-designer-dark-en');
  // Save as profile (prompt)
  await s.page.locator(S('.pz-save-profile')).click();
  await s.page.waitForSelector('.dialog input', { timeout: 4000 });
  // empty name: refused with a message, the prompt stays
  await s.page.locator('.dialog .btn.primary').click();
  await sleep(300);
  check((await s.page.locator('.dialog .field-hint').innerText()) === 'Enter a name.' && (await s.page.locator('.dialog input').count()) === 1, 'Save as profile: an empty name is refused with a message');
  await s.page.locator('.dialog input').fill('Designer test');
  await s.page.locator('.dialog input').press('Enter');
  await s.page.waitForFunction(async () => (await window.__aurora.theme.profiles.list()).some((p) => p.name === 'Designer test'), null, { timeout: 5000 }).catch(() => {});
  const saved = await T(s, async () => (await window.__aurora.theme.profiles.list()).find((p) => p.name === 'Designer test'));
  check(!!saved && saved.values.style === 'eclipse' && saved.values.fontFamily === 'dejavu-sans' && saved.values['taskbar.color'] === 'accent', 'Theme designer: “Save as profile” stores the current look');
  // Profiles page
  await go('profiles');
  check((await s.page.locator(S('.pz-profile')).count()) >= 6 && (await s.page.locator(S('.pz-profile.current')).count()) === 1, 'Profiles page: built-in + saved profiles, the current one marked');
  const cards = await T(s, () => ({
    cut: [...document.querySelectorAll('.app-settings .pz-profile-name')].filter((e) => e.scrollHeight > e.clientHeight + 1 || e.scrollWidth > e.clientWidth + 1).map((e) => e.textContent),
    hc: getComputedStyle(document.querySelector('.app-settings .pz-profile[data-profile-id="contrast"] .pz-profile-accent')).backgroundColor,
  }));
  check(!cards.cut.length && cards.hc === 'rgb(255, 255, 0)', `Profiles page: names are never cut; the colour dot shows the accent the profile really uses (High contrast ${cards.hc}) ${cards.cut.join(', ')}`);
  await docShot(s, 'profiles-dark-en');
  await s.page.locator(S('.pz-profile[data-profile-id="clairdelune"] .pz-apply')).click();
  await sleep(1500);
  await waitTransitions(s);
  check((await T(s, () => window.__t.get('style'))) === 'clairdelune' && (await s.page.locator(S('.pz-profile[data-profile-id="clairdelune"].current')).count()) === 1, 'Profiles page: Apply (one click) and the card becomes current');
  await s.page.locator(S('.pz-profile'), { hasText: 'Designer test' }).first().locator('.pz-more').click({ timeout: 8000 });
  await s.page.locator('body > .menu .menu-item', { hasText: 'Delete' }).click();
  await s.page.waitForSelector('.dialog .btn.primary', { timeout: 4000 });
  await s.page.locator('.dialog .btn.primary').click();
  await sleep(800);
  check(!(await T(s, async () => (await window.__aurora.theme.profiles.list()).some((p) => p.name === 'Designer test'))), 'Profiles page: delete from the … menu (with confirmation)');
  // Visual style page
  await go('visualStyle');
  check((await s.page.locator(S('.pz-style-card')).count()) === 4 && (await s.page.locator(S('.pz-style-card .pz-spv[data-style="clairdelune"] .win-titlebar')).count()) === 1 && (await s.page.locator(S('.pz-style-card .pz-spv .pz-spv-bar')).count()) === 4, 'Visual style page: four cards with real mini renderings (window + bar)');
  const card = await T(s, () => {
    const id = document.documentElement.dataset.style === 'clairdelune' ? 'eclipse' : 'clairdelune';
    const pv = document.querySelector(`.app-settings .pz-spv[data-style="${id}"]`);
    const seg = pv.querySelector('.pz-spv-seg.c');
    return { id, mode: getComputedStyle(pv).getPropertyValue('--bar-mode').trim(), amb: pv.dataset.ambiance, segBg: getComputedStyle(id === 'eclipse' ? pv.querySelector('.pz-spv-bar') : seg).backgroundColor, root: document.documentElement.dataset.style };
  });
  const want = card.id === 'eclipse' ? ['full', 'neutral'] : ['pills', 'warm'];
  check(card.mode === want[0] && card.amb === want[1] && card.segBg !== 'rgba(0, 0, 0, 0)' && card.root !== card.id, `a style card is drawn in its own style (bar ${want[0]}, ${want[1]} mood) while the desktop uses another style (${JSON.stringify(card)})`);
  const ambUi = await T(s, () => [...document.querySelectorAll('.app-settings .pz-style-colors .pz-ambiance')].map((b) => `${b.dataset.ambiance}:${b.getAttribute('aria-checked')}`).join(','));
  check(/^cold:\w+,neutral:\w+,warm:\w+$/.test(ambUi) && (ambUi.match(/true/g) || []).length === 1, `Visual style page: ambiance radio group, one checked (${ambUi})`);
  await s.page.locator(S('.pz-style-colors .pz-ambiance[data-ambiance="warm"]')).click();
  await sleep(700);
  check((await T(s, () => document.documentElement.dataset.ambiance)) === 'warm', 'Visual style page: picking an ambiance applies it');
  await s.page.locator(S('.pz-style-card[data-style-id="contrast"]')).click();
  await sleep(900);
  await waitTransitions(s);
  check((await T(s, () => document.documentElement.dataset.style)) === 'contrast', 'Visual style page: picking a card applies it');
  await T(s, () => window.__aurora.theme.profiles.apply('aurora-light'));
  await sleep(800);
  // App themes page
  await go('appThemes');
  const row = s.page.locator(S('.pz-app-row[data-app="notepad"]'));
  await row.locator('.st-combo').click();
  await s.page.locator('.menu.st-combo-menu .menu-item', { hasText: 'Dark' }).click();
  await sleep(500);
  check((await T(s, () => window.__t.get('appThemes').notepad?.theme)) === 'dark' && (await T(s, () => document.querySelector('#windows > .win.app-notepad').dataset.theme)) === 'dark', 'App themes page: Notepad set to dark, live');
  await s.page.locator(S('.pz-app-search input')).fill('calc');
  await sleep(200);
  check((await s.page.locator(S('.pz-app-row:not([hidden])')).count()) === 1, 'App themes page: search filters the list');
  await s.page.locator(S('.pz-app-search input')).fill('');
  await T(s, () => window.__aurora.wm.byApp('notepad')[0].focus());
  await sleep(300);
  await docShot(s, 'app-themes-light-en');
  await T(s, () => window.__aurora.settings.set('appThemes', {}));
  // stubs + search + accessibility reuse
  for (const p of ['wallpaperEffects', 'focus', 'cursors', 'iconPacks', 'soundPacks', 'shortcuts', 'snapPresets']) {
    await go(p);
    // a stub (coming soon) until areas B1–B3 replace it with the real page: either way it renders without error
    const st = await T(s, (id) => {
      const page = document.querySelector(`.app-settings .st-page[data-page="${id}"]`);
      // a page that fails to load is replaced by the "page error" infobar (and logs a console error)
      return { stub: !!page?.querySelector(`.pz-stub[data-stub="${id}"]`), filled: (page?.textContent.trim().length || 0) > 20 };
    }, p);
    if (!(st.stub || st.filled)) check(false, `page ${p} renders (${JSON.stringify(st)})`);
  }
  check(true, 'pages registered for areas B1–B3 (wallpaperEffects, focus, cursors, iconPacks, soundPacks, shortcuts, snapPresets) render (stub or real page)');
  await go('taskbar');
  check((await s.page.locator(S('.st-row-title'), { hasText: 'Taskbar alignment' }).count()) === 1, 'Taskbar page (moved module) still works');
  const found = await T(s, async () => {
    const idx = await import('app://shell/apps/settings/lib/index.js');
    return [idx.searchIndex('blur', 'en', 3)[0]?.page, idx.searchIndex('profil', 'fr', 3)[0]?.page, idx.searchIndex('contraste', 'fr', 3)[0]?.page, idx.resolvePage('accessibility', 'reducedMotion').page];
  });
  check(JSON.stringify(found) === JSON.stringify(['themeDesigner', 'profiles', 'visualStyle', 'visualEffects']), `Find a setting knows the new pages (${found})`);
  await go('visualEffects');
  check((await s.page.locator(S('.pz-ctl[data-section="reducedMotion"]')).count()) === 1 && (await s.page.locator(S('.pz-slider[data-key="blur"]')).count()) === 1, 'Accessibility > Visual effects reuses the same controls (reduced motion, blur)');
  await go('textSize');
  await s.page.evaluate(() => {
    const inp = document.querySelector('.app-settings .pz-slider[data-key="textScale"] input.slider');
    inp.value = 130;
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await sleep(400);
  check((await T(s, () => window.__t.get('textScale'))) === 130, 'Accessibility > Text size writes the same textScale setting');
  await setKey(s, 'textScale', 100, 300);
}

console.log('\n# French');
{
  await setKey(s, 'lang', 'fr', 800);
  await T(s, () => window.__aurora.registry.launch('settings', { page: 'themeDesigner' }));
  await sleep(1500);
  const fr = await s.page.locator(S('.st-crumb.current')).innerText();
  const labels = await s.page.locator(S('.pz-ctl-title')).allInnerTexts();
  check(fr === 'Concepteur de thème' && labels.includes('Intensité du flou') && labels.includes('Coins arrondis') && labels.includes('Réduire les animations'), `French: ${fr}, ${labels.slice(0, 4).join(' / ')}`);
  const leaks = await T(s, () => [...document.querySelectorAll('.app-settings .st-content *')].filter((e) => e.children.length === 0 && /^pz\./.test(e.textContent.trim())).map((e) => e.textContent.trim()));
  check(!leaks.length, `no untranslated keys (${leaks.slice(0, 3).join(', ')})`);
  await docShot(s, 'theme-designer-light-fr');
  await T(s, () => window.__aurora.registry.launch('settings', { page: 'profiles' }));
  await sleep(1200);
  check((await s.page.locator(S('.pz-profile-name'), { hasText: 'Éclipse' }).count()) === 1, 'French: built-in profile names');
  await docShot(s, 'profiles-light-fr');
  await setKey(s, 'lang', 'en', 800);
}

// screenshots of each style: light/en and dark/fr — desktop with windows (Settings > Visual style + Calculator) and Start
if (!ARGS.has('--no-shots')) {
  console.log('\n# Style screenshots');
  await T(s, () => {
    window.__aurora.registry.launch('settings', { page: 'visualStyle' });
    const w = window.__aurora.wm.byApp('settings')[0];
    if (w.state === 'maximized') w.restore();
    w.setSize(1060, 700);
    w.center();
  });
  await sleep(800);
  for (const [mode, lang] of [['light', 'en'], ['dark', 'fr']]) {
    await setKey(s, 'lang', lang, 500);
    await setKey(s, 'theme', mode, 600);
    for (const st of ['nocturne', 'eclipse', 'clairdelune', 'contrast']) {
      await setKey(s, 'style', st, 900);
      await waitTransitions(s);
      await T(s, () => window.__aurora.wm.byApp('calculator')[0]?.focus());
      await s.page.mouse.move(1500, 300); // no tooltip in the shot
      await sleep(900);
      await docShot(s, `style-${st}-${mode}-${lang}-desktop`);
      await s.page.click('.tb-start');
      await sleep(700);
      await docShot(s, `style-${st}-${mode}-${lang}-start`);
      await s.page.click('.tb-start');
      await sleep(400);
    }
  }
  await setKey(s, 'style', 'nocturne', 600);
  await setKey(s, 'theme', 'light', 600);
  await setKey(s, 'lang', 'en', 500);
  check(true, 'style screenshots written to docs/screenshots/style-*.png');
}

if (!E2E_ONLY) {
  console.log('\n# Finishes (Halo, Prisme, Sobre): core/finishes.js, <html data-finish>, glass levels');
  const fin = await T(s, async () => {
    const m = await import('app://shell/core/finishes.js');
    return { ids: m.FINISHES.map((f) => f.id), def: m.DEFAULT_FINISH, previews: m.FINISHES.every((f) => /^app:\/\/shell\/assets\/finishes\/[a-z]+\.jpg$/.test(f.preview) && f.name.fr && f.desc.fr), d: m.finishDefaults('halo', 'eclipse'), p: m.finishDefaults('prisme', 'clairdelune'), so: m.finishDefaults('sobre', 'nocturne') };
  });
  check(fin.ids.join() === 'halo,prisme,sobre' && fin.def === 'halo' && fin.previews && fin.d.accent === '#ffb547' && fin.d.wallpaper === 'builtin:halo-eclipse' && fin.d.iconPack === 'halo' && fin.p.wallpaper === 'builtin:prisme-clairdelune' && fin.p.iconPack === 'prisme' && fin.so.wallpaper === 'builtin:nocturne' && fin.so.accent === '#c9d3e6' && fin.so.iconPack === 'selene', `FINISHES / DEFAULT_FINISH / finishDefaults follow the contract (${JSON.stringify(fin.d)})`);
  const defs = await T(s, () => window.__aurora.api?.invoke ? window.__aurora.api.invoke('settings:defaults') : null);
  if (defs) check(defs.finish === 'halo' && defs.iconPack === 'auto' && defs.tintFromWallpaper === true && defs.accent === '#7fcbff' && defs.wallpaper === 'builtin:halo-nocturne', `defaults: finish halo, iconPack auto, tintFromWallpaper on, Halo's accent and wallpaper (${defs.finish}, ${defs.iconPack}, ${defs.accent}, ${defs.wallpaper})`);
  await setKey(s, 'style', 'nocturne', 500);
  await setKey(s, 'theme', 'dark', 500);
  await T(s, () => window.__t.set('ambiance', null));
  await T(s, () => window.__t.set('accent', '#c9d3e6'));
  await T(s, () => window.__t.set('wallpaper', 'builtin:nocturne'));
  await sleep(400);
  const mica = () => T(s, () => new Promise((res) => { if (/blob:/.test(document.documentElement.style.getPropertyValue('--mica-image'))) return res(true); const off = window.__aurora.theme.on('mica', (u) => { off?.(); res(!!u); }); setTimeout(() => res(/blob:/.test(document.documentElement.style.getPropertyValue('--mica-image'))), 4000); }));
  const sample = () => T(s, () => {
    const r = document.documentElement;
    const win = document.querySelector('#windows > .win.bg-mica, #windows > .win');
    const num = (v) => Number.parseFloat(v);
    return {
      finish: r.dataset.finish, accent: window.__t.get('accent'), wall: window.__t.get('wallpaper'),
      aWin: num(window.__t.cs(window.__t.probe('<div style="opacity: var(--a-win)"></div>'), 'opacity')),
      floor: num(r.style.getPropertyValue('--a-floor') || '0'),
      bar: window.__t.alpha(window.__t.cs(window.__t.bar(), 'backgroundColor')), barBlur: window.__t.cs(window.__t.bar(), 'backdropFilter'),
      start: window.__t.cs('#start', 'backdropFilter'), startA: window.__t.alpha(window.__t.cs('#start', 'backgroundColor')),
      // the glass: the window's own layers + its .win-glass picture and the tint / sheen / grain above it (core/wm.js)
      winImg: win ? [win, win.querySelector(':scope > .win-glass > .win-glass-img')].map((el) => (el ? getComputedStyle(el).backgroundImage : '')).concat(win.querySelector(':scope > .win-glass') ? getComputedStyle(win.querySelector(':scope > .win-glass'), '::after').backgroundImage : '').join(' ') : '', tint: r.style.getPropertyValue('--wall-tint-d'),
    };
  });
  // the GPU path (live blur on the bar / Lanceur); the software path (<html data-gfx="soft">, core/gfx.js) is checked below
  const gfx = await T(s, () => document.documentElement.dataset.gfx);
  await T(s, () => (document.documentElement.dataset.gfx = 'gpu'));
  await T(s, async () => (await import('app://shell/core/theme.js')).chooseFinish('halo'));
  await sleep(600);
  await waitTransitions(s);
  const micaOk = await mica();
  // the tint and the contrast floor of a new picture are measured after the desktop cross-fade (theme.js GLASS_DEFER_MS)
  const glassMeasured = () => T(s, () => new Promise((res) => { const t0 = Date.now(); const tick = () => (document.documentElement.style.getPropertyValue('--a-floor') || Date.now() - t0 > 6000 ? res() : setTimeout(tick, 100)); tick(); }));
  await glassMeasured();
  const h = await sample();
  check(h.finish === 'halo' && h.accent === '#7fcbff' && h.wall === 'builtin:halo-nocturne', `chooseFinish('halo'): data-finish, and the accent and wallpaper follow (they were Sobre's defaults): ${h.accent}, ${h.wall}`);
  check(micaOk && /blob:/.test(h.winImg) && /linear-gradient/.test(h.winImg) && h.aWin >= 0.7 && h.aWin <= 0.8, `Halo windows: tinted glass over the pre-blurred wallpaper (Mica-like, no live blur), alpha ${h.aWin}`);
  check(/blur\(48/.test(h.barBlur) && h.bar >= 0.78 && h.bar <= 0.84 && /blur\(48/.test(h.start) && h.startA >= 0.78 && h.startA <= 0.84, `Halo bar and Lanceur: live blur ${h.barBlur} at ${h.bar.toFixed(2)}, Lanceur ${h.startA.toFixed(2)}`);
  // software rendering: the Lanceur / Réglages rapides paint the pre-blurred wallpaper under the same tint, no live blur
  await T(s, () => (document.documentElement.dataset.gfx = 'soft'));
  const sw = await T(s, () => ['#start', '#quick-settings'].map((q) => { const cs = getComputedStyle(document.querySelector(q)); return { bf: cs.backdropFilter, img: cs.backgroundImage }; }));
  await T(s, (g) => (document.documentElement.dataset.gfx = g), gfx || 'soft');
  check(['gpu', 'soft'].includes(gfx) && sw.every((x) => x.bf === 'none' && /blob:/.test(x.img) && /linear-gradient/.test(x.img)), `software rendering (detected: ${gfx}): Lanceur and Réglages rapides use the pre-blurred wallpaper under the glass tint, no backdrop-filter (${JSON.stringify(sw.map((x) => x.bf))})`);
  check(/^\d+ \d+ \d+$/.test(h.tint), `tintFromWallpaper: the glass takes the wallpaper's hue (--wall-tint-d ${h.tint})`);
  await setKey(s, 'tintFromWallpaper', false, 700);
  const noTint = await T(s, () => document.documentElement.style.getPropertyValue('--wall-tint-d'));
  check(noTint === '', 'tintFromWallpaper off: the finish keeps its own tint');
  await setKey(s, 'tintFromWallpaper', true, 400);
  // text-3 on the rendered glass: theme.js measures the brightest (dark) / darkest (light) blurred area of the picture
  // and never lets the glass get clearer than the alpha that keeps 4.5:1; every finish × style × mode
  const low = [];
  const seen = [];
  for (const f of ['halo', 'prisme']) {
    await T(s, async (id) => (await import('app://shell/core/theme.js')).chooseFinish(id), f);
    for (const st of ['nocturne', 'eclipse', 'clairdelune']) {
      await T(s, async (id) => (await import('app://shell/core/theme.js')).chooseStyle(id), st);
      for (const mode of ['dark', 'light']) {
        await setKey(s, 'theme', mode, 300);
        await waitTransitions(s);
        await mica();
        // each mode has its own picture (<id>-dark.jpg / -light.jpg): its floor is measured after the cross-fade
        // (theme.js GLASS_DEFER_MS), else the previous picture's floor would be read
        await sleep(1900);
        await glassMeasured();
        const x = await sample();
        const ok = x.floor > 0 && x.aWin >= x.floor - 0.001 && x.bar >= x.floor - 0.001 && x.startA >= x.floor - 0.001;
        seen.push(`${f}/${st}/${mode} ${x.aWin.toFixed(2)}≥${x.floor}`);
        if (!ok || x.finish !== f) low.push(`${f}/${st}/${mode} ${JSON.stringify(x)}`);
      }
    }
  }
  check(!low.length, `text-3 ≥ 4.5:1 on the rendered glass in every finish × style × mode (glass alpha ≥ measured floor): ${seen.join(', ')}${low.length ? ` — LOW: ${low.join(' | ')}` : ''}`);
  const pr = await sample();
  check(pr.finish === 'prisme' && /svg/.test(pr.winImg) && pr.accent === '#b42f78', `Prisme: grain layer on the window glass, its own accent (${pr.accent})`);
  // transparency off, reduced transparency (level 0) and High contrast: solid surfaces
  await setKey(s, 'transparency', false, 700);
  const off = await sample();
  check(off.aWin === 1 && !/blob:/.test(off.winImg) && off.bar === 1, `transparency off: opaque windows (alpha ${off.aWin}, no Mica copy) and bar`);
  await setKey(s, 'transparency', true, 300);
  await setKey(s, 'transparencyLevel', 0, 700);
  const lvl0 = await sample();
  check(lvl0.aWin === 1 && lvl0.bar === 1, `transparency level 0: opaque glass (${lvl0.aWin}, bar ${lvl0.bar})`);
  await setKey(s, 'transparencyLevel', 50, 300);
  await setKey(s, 'style', 'contrast', 900);
  await waitTransitions(s);
  const hc = { ...(await sample()), ...(await T(s, () => ({ fly: window.__t.root('--shadow-flyout'), line: window.__t.root('--glass-line'), r: getComputedStyle(document.querySelector('#windows > .win')).borderTopLeftRadius }))) };
  check(hc.aWin === 1 && !/blob:|svg/.test(hc.winImg) && hc.bar === 1 && hc.start === 'none' && hc.fly === 'none' && !/rgb/.test(hc.line) && hc.r === '6px', `High contrast in a glass finish: solid surfaces, no Mica, no grain, no blur, its own lines and shadows and corners (${hc.fly}, ${hc.line}, ${hc.r})`);
  await setKey(s, 'style', 'nocturne', 900);
  await T(s, async () => (await import('app://shell/core/theme.js')).chooseFinish('sobre'));
  await sleep(900);
  await waitTransitions(s);
  const so = await sample();
  check(so.finish === 'sobre' && so.accent === '#c9d3e6' && so.wall === 'builtin:nocturne' && !/blob:|gradient/.test(so.winImg), `back to Sobre: flat windows, Selene accent and wallpaper (${so.accent}, ${so.wall})`);
  // a plain settings.set('finish') gets the same follow rule
  await setKey(s, 'finish', 'halo', 1200);
  const plain = await sample();
  check(plain.accent === '#7fcbff' && plain.wall === 'builtin:halo-nocturne', `settings.set('finish') follows too (${plain.accent}, ${plain.wall})`);
  await T(s, async () => (await import('app://shell/core/theme.js')).chooseFinish('sobre'));
  await sleep(600);
  await setKey(s, 'theme', 'light', 600);
}

const errs1 = errorsOf(s).filter((l) => !/net::ERR_|favicon/.test(l));
check(!errs1.length, `no console errors (${errs1.slice(0, 3).join(' | ')})`);
await s.close();

// ===================================================================== launches 2–3: 1280×720 and 1920×1080
for (const [size, theme, lang] of [['1280x720', 'dark', 'fr'], ['1920x1080', 'light', 'en']]) {
  console.log(`\n# ${size} ${theme} ${lang}`);
  const t = await launchShell({ size, theme, lang, settings: { style: theme === 'dark' ? 'clairdelune' : 'nocturne' } });
  await install(t);
  await T(t, () => window.__aurora.registry.launch('settings', { page: 'themeDesigner' }));
  await sleep(1800);
  await T(t, () => window.__aurora.wm.byApp('settings')[0].maximize());
  await sleep(900);
  const lay = await T(t, () => {
    const sc = document.querySelector('.app-settings .st-scroll');
    const frame = document.querySelector('.app-settings .pz-mock-frame').getBoundingClientRect();
    const ctl = document.querySelector('.app-settings .pz-designer-controls').getBoundingClientRect();
    const cut = [...document.querySelectorAll('.app-settings .pz-ctl')].filter((r) => {
      const rr = r.getBoundingClientRect();
      return [...r.querySelectorAll('.pz-ctl-right > *, .pz-ctl-body > *')].some((c) => c.getBoundingClientRect().right > rr.right + 1);
    }).length;
    return { overflow: sc.scrollWidth - sc.clientWidth, frameW: Math.round(frame.width), side: ctl.left >= frame.right - 1, cut };
  });
  check(lay.overflow <= 1 && lay.frameW > 300 && lay.cut === 0, `${size}: Theme designer fits (preview ${lay.frameW} px, ${lay.side ? 'side by side' : 'stacked'}, nothing cut off)`);
  await docShot(t, `theme-designer-${size}-${theme}-${lang}`);
  // narrowest Settings window: the designer stacks
  await T(t, () => {
    const w = window.__aurora.wm.byApp('settings')[0];
    w.restore();
    w.setSize(560, 600);
  });
  await sleep(800);
  const narrow = await T(t, () => {
    const sc = document.querySelector('.app-settings .st-scroll');
    return sc.scrollWidth - sc.clientWidth;
  });
  check(narrow <= 1, `${size}: narrow Settings window — no horizontal scrolling`);
  const errs = errorsOf(t).filter((l) => !/net::ERR_|favicon/.test(l));
  check(!errs.length, `${size}: no console errors (${errs.slice(0, 3).join(' | ')})`);
  await t.close();
}

// ===================================================================== launch 4: persistence across restarts + boot with a style
{
  console.log('\n# Persistence');
  const home = fs.mkdtempSync(path.join(OUT, 'pz-home-'));
  const t1 = await launchShell({ home, settings: { style: 'eclipse', textScale: 120, blur: 20, cornerRadius: 150, fontFamily: 'dejavu-serif', accent: '#e3008c', reducedMotion: true, taskbar: { color: '#101820' }, appThemes: { notepad: { theme: 'dark', accent: null } } }, open: ['notepad'] });
  const r = await T(t1, () => ({
    style: document.documentElement.dataset.style,
    amb: document.documentElement.dataset.ambiance,
    body: getComputedStyle(document.body).fontSize,
    np: document.querySelector('#windows > .win.app-notepad')?.dataset.theme,
    tb: getComputedStyle(document.getElementById('taskbar')).backdropFilter,
    corner: getComputedStyle(document.documentElement).getPropertyValue('--corner').trim(),
    font: getComputedStyle(document.body).fontFamily,
    accent: document.documentElement.style.getPropertyValue('--accent-base'),
    motion: document.documentElement.dataset.reducedMotion,
    tbColor: document.getElementById('taskbar').style.getPropertyValue('--taskbar-rgb').trim(),
    tbAlign: window.__aurora.settings.get('taskbar.align'),
  }));
  check(r.style === 'eclipse' && r.amb === 'neutral' && r.body === '16.8px' && r.np === 'dark', `settings are restored at boot (style ${r.style}, ambiance ${r.amb} from the style, text ${r.body}, Notepad ${r.np})`);
  check(r.corner === '1.500' && /DejaVu Serif/.test(r.font) && r.accent === '#e3008c' && r.motion === 'on' && r.tbColor === '16 24 32' && r.tbAlign === 'center', `every personalization key is applied at boot (corners ${r.corner}, accent ${r.accent}, reduced motion ${r.motion}, taskbar ${r.tbColor})`);
  await T(t1, () => window.__aurora.theme.profiles.saveCurrent('Persisted'));
  await t1.close();
  const t2 = await launchShell({ home });
  const names = await T(t2, async () => (await window.__aurora.theme.profiles.list()).filter((p) => !p.builtin).map((p) => p.name));
  check(names.includes('Persisted'), 'profiles survive a restart');
  const errs = errorsOf(t2);
  check(!errs.length, 'restart: no console errors');
  await t2.close();
  // the sign-in screen gets the visual style
  const g = await launchShell({ home, mode: 'greeter' });
  await sleep(1500);
  check((await g.page.evaluate(() => document.documentElement.dataset.style)) === 'eclipse', 'sign-in screen: data-style applied');
  await g.close();
  fs.rmSync(home, { recursive: true, force: true });
}
} // !E2E_ONLY

// ===================================================================== launch 5: end-to-end checklist through the Settings UI
// (1280×720, French, light): every item of the request that area A owns is changed with real clicks in Settings and
// checked in the shell; then a complete profile round trip over every PROFILE_KEYS key, import hardening, and the
// documentation ↔ PROFILE_KEYS contract.
{
  console.log('\n# End to end through Settings (1280x720, fr, light)');
  const e = await launchShell({ lang: 'fr', theme: 'light', size: '1280x720', open: ['notepad', 'calculator'] });
  await install(e);
  await sleep(600);
  const go = async (page) => {
    await T(e, (p) => window.__aurora.registry.launch('settings', { page: p }), page);
    await e.page.waitForSelector(S(`.st-page[data-page="${page}"]`), { timeout: 10000 });
    await sleep(600);
  };
  const slide = (key, val) =>
    e.page.evaluate(([k, v]) => {
      const inp = document.querySelector(`.app-settings .pz-slider[data-key="${k}"] input.slider`);
      inp.value = v;
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new Event('change', { bubbles: true }));
    }, [key, val]);
  const comboPick = async (sel, index) => {
    await e.page.locator(sel).first().click();
    await e.page.locator('.menu.st-combo-menu .menu-item').nth(index).click();
    await sleep(400);
  };
  const setMany = (s, patch) => T(s, (x) => window.__aurora.api.invoke('settings:setMany', x), patch);
  const colorDialog = async (hexValue) => {
    await e.page.waitForSelector('.dialog .pz-hex', { timeout: 5000 });
    await e.page.locator('.dialog .pz-hex').fill(hexValue);
    await e.page.locator('.dialog .btn.primary').click();
    await sleep(500);
  };
  try {
    await T(e, () => {
      const w = window.__aurora.wm.byApp('notepad')[0];
      w.restore?.();
    });
    await go('themeDesigner');
    await T(e, () => {
      const w = window.__aurora.wm.byApp('settings')[0];
      w.focus();
      if (w.state !== 'maximized') w.maximize();
    });
    await sleep(500);

    // custom accent colour (colour dialog, hex field)
    await e.page.locator(S('.pz-custom-color')).click();
    await colorDialog('#c239b3');
    await waitTransitions(e);
    const acc = await T(e, () => ({ v: window.__t.get('accent'), css: document.documentElement.style.getPropertyValue('--accent-base').trim(), btn: getComputedStyle(document.querySelector('.app-settings .pz-custom-color')).getPropertyValue('--sw').trim() }));
    check(acc.v === '#c239b3' && acc.css === '#c239b3', `E2E custom accent colour (dialog → ${acc.v}, --accent-base ${acc.css})`);

    // transparency on/off, transparency level, blur intensity
    const tp0 = await T(e, () => window.__t.root('--tp'));
    await e.page.locator(S('.pz-ctl[data-section="transparency"] .toggle input')).click();
    await sleep(500);
    const off = await T(e, () => ({ v: window.__t.get('transparency'), attr: document.documentElement.dataset.transparency, tb: getComputedStyle(window.__t.bar()).backdropFilter }));
    await e.page.locator(S('.pz-ctl[data-section="transparency"] .toggle input')).click();
    await sleep(500);
    check(off.v === false && off.attr === 'off' && off.tb === 'none' && (await T(e, () => document.documentElement.dataset.transparency)) === 'on', `E2E window transparency toggle (off: data-transparency=${off.attr}, taskbar backdrop ${off.tb})`);
    await slide('transparencyLevel', 85);
    await slide('blur', 90);
    await sleep(700);
    const tb = await T(e, () => ({ tp: window.__t.root('--tp'), blurPx: window.__t.root('--blur-px'), lvl: window.__t.get('transparencyLevel'), blur: window.__t.get('blur'), taskbar: getComputedStyle(window.__t.bar()).backdropFilter }));
    check(tb.lvl === 85 && Number(tb.tp) > Number(tp0), `E2E transparency level slider (85 → --tp ${tp0} → ${tb.tp})`);
    check(tb.blur === 90 && /blur\((\d+)/.test(tb.taskbar) && Number(/blur\((\d+)/.exec(tb.taskbar)[1]) > 40, `E2E blur intensity slider (90 → taskbar ${tb.taskbar}, --blur-px ${tb.blurPx})`);

    // rounded corners, text size, font, UI scale
    await slide('cornerRadius', 40);
    await slide('textScale', 115);
    await sleep(600);
    const shape = await T(e, () => ({ corner: window.__t.root('--corner'), win: getComputedStyle(document.querySelector('#windows > .win.app-notepad')).borderTopLeftRadius, ts: window.__t.root('--text-scale') }));
    check(shape.corner === '0.400' && parseFloat(shape.win) < 8, `E2E rounded-corner intensity (40 % → --corner ${shape.corner}, Notepad window radius ${shape.win})`);
    check(Math.abs(Number(shape.ts) - 1.15) < 0.001, `E2E text size slider (115 % → --text-scale ${shape.ts})`);
    await comboPick(S('.st-combo[data-key="fontFamily"]'), 3); // DejaVu Sans
    const font = await T(e, () => ({ v: window.__t.get('fontFamily'), body: getComputedStyle(document.body).fontFamily }));
    check(font.v !== 'inter' && !/^"?Inter/.test(font.body), `E2E font (${font.v} → body font ${font.body.split(',')[0]})`);
    const dpr0 = await T(e, () => window.devicePixelRatio);
    await slide('scale', 125);
    await e.page.waitForFunction(() => Math.abs(window.devicePixelRatio - 1.25) < 0.01, null, { timeout: 5000 }).catch(() => {});
    const dpr1 = await T(e, () => ({ dpr: window.devicePixelRatio, v: window.__t.get('scale') }));
    await setKey(e, 'scale', 100, 900);
    check(dpr1.v === 125 && Math.abs(dpr1.dpr - 1.25) < 0.01 && dpr0 === 1, `E2E UI scale slider (125 % → zoom ${dpr1.dpr})`);

    // taskbar colour: custom colour through the dialog
    await comboPick(S('.st-combo[data-key="taskbar.color"]'), 2);
    await colorDialog('#203040');
    const tbc = await T(e, () => ({ v: window.__t.get('taskbar.color'), rgb: document.getElementById('taskbar').style.getPropertyValue('--taskbar-rgb').trim(), th: document.getElementById('taskbar').dataset.theme }));
    check(tbc.v === '#203040' && tbc.rgb === '32 48 64' && tbc.th === 'dark', `E2E taskbar colour (custom ${tbc.v} → --taskbar-rgb ${tbc.rgb}, readable ${tbc.th} icons)`);

    // reduced motion
    await e.page.locator(S('.pz-ctl[data-section="reducedMotion"] .toggle input')).click();
    await sleep(400);
    const rm = await T(e, () => ({ v: window.__t.get('reducedMotion'), a: document.documentElement.dataset.animations, r: document.documentElement.dataset.reducedMotion }));
    await e.page.locator(S('.pz-ctl[data-section="reducedMotion"] .toggle input')).click();
    await sleep(400);
    check(rm.v === true && rm.a === 'off' && rm.r === 'on', `E2E reduced-motion mode (data-animations=${rm.a})`);

    // wallpaper + lock screen rows lead to their pages, where a picture is picked
    await e.page.locator(S('.pz-ctl[data-section="wallpaper"] .btn')).click();
    await e.page.waitForSelector(S('.st-page[data-page="background"] .st-wall'), { timeout: 8000 });
    await e.page.locator(S('.st-page[data-page="background"] .st-wall')).nth(2).click();
    await sleep(900);
    const wp = await T(e, () => ({ v: window.__t.get('wallpaper'), url: window.__aurora.theme.wallpaperUrl }));
    check(/^builtin:/.test(wp.v) && wp.v !== 'builtin:bloom' && wp.url.includes(wp.v.slice(8)), `E2E wallpaper picked on the Background page (${wp.v})`);
    await go('themeDesigner');
    await e.page.locator(S('.pz-ctl[data-section="lockscreen"] .btn')).click();
    await e.page.waitForSelector(S('.st-page[data-page="lockscreen"] .st-wall'), { timeout: 8000 });
    await e.page.locator(S('.st-page[data-page="lockscreen"] .st-wall:not(.st-wall-same)')).nth(4).click();
    await sleep(600);
    const lockV = await T(e, () => window.__t.get('lockWallpaper'));
    await T(e, () => window.__aurora.shell.lock());
    await sleep(800);
    const lockImg = await T(e, () => document.querySelector('.lockui')?.style.getPropertyValue('--lk-wall-img') || '');
    await T(e, () => window.__aurora.shell.emit('unlock'));
    await sleep(700);
    check(/^builtin:/.test(lockV || '') && lockImg.includes(lockV.slice(8)), `E2E lock screen picture (${lockV} shown on the lock screen)`);

    // the five visual styles (Visual style page)
    await go('visualStyle');
    const seen = {};
    for (const id of ['clairdelune', 'eclipse', 'contrast', 'nocturne']) {
      await e.page.locator(S(`.pz-style-card[data-style-id="${id}"]`)).first().click();
      await sleep(700);
      await waitTransitions(e);
      seen[id] = await T(e, () => ({ attr: document.documentElement.dataset.style, v: window.__t.get('style'), radius: getComputedStyle(document.querySelector('#windows > .win.app-notepad')).borderTopLeftRadius, title: getComputedStyle(document.querySelector('#windows > .win.app-notepad .win-titlebar')).backgroundImage.slice(0, 15), tb: getComputedStyle(document.getElementById('taskbar')).backgroundColor, bar: getComputedStyle(document.documentElement).getPropertyValue('--bar-mode').trim(), win: getComputedStyle(document.documentElement).getPropertyValue('--win-border-w').trim(), amb: document.documentElement.dataset.ambiance }));
    }
    const sig = Object.values(seen).map((x) => `${x.radius}|${x.title}|${x.tb}|${x.bar}|${x.win}|${x.amb}`);
    check(Object.entries(seen).every(([id, x]) => x.attr === id && x.v === id), `E2E five visual styles applied from their cards (${Object.keys(seen).join(', ')})`);
    check(new Set(sig).size === 4, `E2E each style looks different (window radius / title bar / taskbar: ${sig.join(' ; ')})`);

    // per-app themes: light / dark / system / custom accent
    await go('appThemes');
    await setKey(e, 'theme', 'dark', 900);
    const npRow = S('.pz-app-row[data-app="notepad"]');
    await comboPick(`${npRow} .st-combo`, 1); // light while the system is dark
    const npLight = await T(e, () => document.querySelector('#windows > .win.app-notepad').dataset.theme);
    await e.page.locator(S('.pz-app-row[data-app="calculator"] .pz-app-accent')).click();
    await colorDialog('#00b294');
    const calc = await T(e, () => ({ cfg: window.__t.get('appThemes').calculator, acc: document.querySelector('#windows > .win.app-calculator').style.getPropertyValue('--accent-base').trim() || getComputedStyle(document.querySelector('#windows > .win.app-calculator')).getPropertyValue('--accent').trim() }));
    await comboPick(`${npRow} .st-combo`, 2); // dark
    const npDark = await T(e, () => document.querySelector('#windows > .win.app-notepad').dataset.theme);
    await comboPick(`${npRow} .st-combo`, 0); // system
    const npSys = await T(e, () => ({ cfg: window.__t.get('appThemes').notepad || null, scope: document.querySelector('#windows > .win.app-notepad').hasAttribute('data-theme-scope') }));
    check(npLight === 'light' && npDark === 'dark' && npSys.cfg === null && !npSys.scope, `E2E per-app theme Notepad: light (${npLight}) / dark (${npDark}) / system (override removed)`);
    check(calc.cfg?.accent === '#00b294' && calc.acc === '#00b294', `E2E per-app custom accent: Calculator ${calc.acc}`);

    // profiles: save the current look in Settings, change things, re-apply it with one click
    await go('profiles');
    await e.page.locator(S('.pz-save-current')).first().click();
    await e.page.waitForSelector('.dialog input', { timeout: 4000 });
    await e.page.locator('.dialog input').fill('Mon thème');
    await e.page.locator('.dialog input').press('Enter');
    await e.page.waitForFunction(async () => (await window.__aurora.theme.profiles.list()).some((p) => p.name === 'Mon thème'), null, { timeout: 5000 }).catch(() => {});
    const before = await T(e, async () => {
      const pr = await import('app://shell/core/profiles.js');
      return Object.fromEntries(pr.PROFILE_KEYS.map((k) => [k, pr.stableJson(window.__aurora.settings.get(k))]));
    });
    await T(e, () => window.__aurora.theme.profiles.apply('eclipse'));
    await sleep(900);
    await setMany(e, { cornerRadius: 180, 'taskbar.position': 'top', 'animatedWallpaper.id': 'bokeh', iconPack: 'graphite' });
    await e.page.locator(S('.pz-profile'), { hasText: 'Mon thème' }).first().locator('.pz-apply').click();
    await sleep(1500);
    await waitTransitions(e);
    const after = await T(e, async () => {
      const pr = await import('app://shell/core/profiles.js');
      return Object.fromEntries(pr.PROFILE_KEYS.map((k) => [k, pr.stableJson(window.__aurora.settings.get(k))]));
    });
    const diff = Object.keys(before).filter((k) => before[k] !== after[k] && !(k === 'focusMode'));
    check(!diff.length, `E2E profiles: “Save as profile” then Apply (one click) restores every key (${diff.join(', ') || 'identical'})`);
    await docShot(e, 'profiles-e2e-1280-fr-dark');

    // ---- complete round trip: every PROFILE_KEYS key changed, saved, everything reset, applied again
    const rt = await T(e, async () => {
      const pr = await import('app://shell/core/profiles.js');
      const A = window.__aurora;
      const ALT = {
        finish: 'sobre', tintFromWallpaper: false, style: 'clairdelune', ambiance: 'neutral', theme: 'light', autoTheme: { enabled: false, light: '06:30', dark: '20:15' }, accent: '#c239b3', accentFromWallpaper: true,
        transparency: false, transparencyLevel: 80, blur: 20, cornerRadius: 150, fontFamily: 'dejavu-sans', textScale: 110, scale: 110,
        reducedMotion: true, animations: false, 'taskbar.color': '#203040', 'taskbar.opacity': 70, appThemes: { notepad: { theme: 'dark', accent: '#112233' } },
        // pictures of the Selene set (the redesign retired dunes / glow: an import maps them to Nocturne)
        wallpaper: 'builtin:forest', wallpaperFit: 'fit', lockWallpaper: 'builtin:peaks', wallpaperMode: 'animated',
        animatedWallpaper: { id: 'waves', speed: 70, intensity: 30, fps: 15, pauseOnMaximized: false },
        dynamicWallpaper: { source: 'weather', set: 'dunes', location: { name: 'Lyon', lat: 45.76, lon: 4.84 }, followTheme: true },
        slideshow: { folder: '/tmp', interval: 5, shuffle: false }, lockScreen: { mode: 'spotlight', effect: 'bokeh' },
        'taskbar.align': 'left', 'taskbar.autohide': true, 'taskbar.showSearch': false, 'taskbar.showTaskView': false, 'taskbar.showWidgets': true,
        'taskbar.size': 'large', 'taskbar.position': 'top', 'taskbar.showLabels': true, 'taskbar.combine': 'never', 'taskbar.widgets': ['cpu', 'memory'], 'taskbar.search': 'box',
        'start.layout': 'list', 'start.background': 'glass', 'start.folders': ['documents', 'music'], 'start.groups': [{ id: 'g-test', name: 'Outils', apps: ['calculator', 'notepad'] }],
        startShowRecent: false, focusMode: { hideNotifications: false, dimDesktop: false, dimLevel: 60, hideIcons: true, simplifyTaskbar: false, duration: 25 },
        'taskbar.tray': { network: false, volume: true, battery: false }, 'taskbar.badges': false, 'taskbar.widgetsPos': 'end', 'taskbar.hideDelay': 1200, showSeconds: true,
        'start.showRecentApps': false, 'start.showMostUsed': true,
        cursorPack: 'midnight', cursorSize: 150, iconPack: 'graphite', soundPack: 'chimes', soundEvents: { notification: 'none', startup: 'none', shutdown: null },
        soundVolume: 40, startupSound: false, snapPresets: [{ id: 'p-test', name: 'Moitiés', zones: [{ x: 0, y: 0, w: 0.5, h: 1 }, { x: 0.5, y: 0, w: 0.5, h: 1 }] }],
        snapLayouts: ['p-test'], 'multitasking.snapLayouts': false, 'multitasking.snapBar': false, 'multitasking.snapAssist': false,
        shortcuts: { search: 'Super+Shift+K', widgets: null }, desktopIconSize: 'large',
      };
      const missing = pr.PROFILE_KEYS.filter((k) => !(k in ALT));
      const snap = () => Object.fromEntries(pr.PROFILE_KEYS.map((k) => {
        let v = A.settings.get(k);
        if (k === 'focusMode' && v) v = Object.fromEntries(Object.entries(v).filter(([x]) => !['active', 'endsAt', 'prevDnd'].includes(x)));
        return [k, pr.stableJson(v)];
      }));
      // start from the defaults (the UI checks above changed several keys)
      await A.api.invoke('settings:setMany', {}, { reset: pr.PROFILE_KEYS });
      await new Promise((r) => setTimeout(r, 1200));
      const defaults = snap();
      // with "accent from wallpaper" the accent is derived from the picture on screen (here the still frame of the
      // animated scene, made asynchronously): wait until the wallpaper and the accent rest
      const settle = async () => {
        let prev = '';
        let same = 0;
        for (let i = 0; i < 30 && same < 3; i++) {
          await new Promise((r) => setTimeout(r, 500));
          const cur = `${A.wallpaperEngine.state.overrideUrl}|${A.settings.get('accent')}`;
          same = cur === prev && A.wallpaperEngine.state.overrideUrl ? same + 1 : 0;
          prev = cur;
        }
      };
      await A.api.invoke('settings:setMany', ALT);
      await settle();
      const changed = snap();
      const unchanged = pr.PROFILE_KEYS.filter((k) => changed[k] === defaults[k]);
      const p = await A.theme.profiles.saveCurrent('Tout');
      // everything back to the defaults
      await A.api.invoke('settings:setMany', {}, { reset: pr.PROFILE_KEYS });
      await new Promise((r) => setTimeout(r, 1200));
      const reset = snap();
      const notReset = pr.PROFILE_KEYS.filter((k) => reset[k] !== defaults[k]);
      await A.theme.profiles.apply(p.id);
      await settle();
      const back = snap();
      const diff = pr.PROFILE_KEYS.filter((k) => back[k] !== changed[k]).map((k) => `${k}: ${changed[k]} ≠ ${back[k]}`);
      const live = { style: document.documentElement.dataset.style, cursor: document.documentElement.dataset.cursorPack || getComputedStyle(document.body).cursor, pos: document.getElementById('taskbar').dataset.position || document.body.dataset.taskbarPosition, mode: A.wallpaperEngine.state.mode, effect: A.wallpaperEngine.state.effect, cur: await A.theme.profiles.current() };
      // the saved profile also survives export → import unchanged
      const imp = await A.theme.profiles.importJson(A.theme.profiles.exportJson(await A.theme.profiles.get(p.id)));
      const impSame = pr.stableJson(imp.values) === pr.stableJson((await A.theme.profiles.get(p.id)).values);
      await A.theme.profiles.remove(imp.id);
      await A.theme.profiles.remove(p.id);
      await A.api.invoke('settings:setMany', {}, { reset: pr.PROFILE_KEYS });
      await new Promise((r) => setTimeout(r, 1000));
      return { missing, unchanged, notReset, diff, live, impSame, n: pr.PROFILE_KEYS.length, id: p.id };
    });
    check(!rt.missing.length && !rt.unchanged.length, `profile round trip: all ${rt.n} PROFILE_KEYS keys were changed (${[...rt.missing, ...rt.unchanged].join(', ') || 'none left at its default'})`);
    check(!rt.notReset.length, `profile round trip: resetting every key really changed them back (${rt.notReset.join(', ') || 'ok'})`);
    check(!rt.diff.length, `profile round trip: applying the saved profile restores all ${rt.n} keys identically${rt.diff.length ? `: ${rt.diff.slice(0, 4).join(' | ')}` : ''}`);
    check(rt.live.style === 'clairdelune' && rt.live.mode === 'animated' && rt.live.effect === 'waves' && rt.live.cur === rt.id, `profile round trip: applied live (style ${rt.live.style}, wallpaper ${rt.live.mode}/${rt.live.effect}, current profile marked)`);
    check(rt.impSame, 'profile round trip: export → import keeps every value');

    // ---- import hardening: unknown keys, CSS / HTML injection through colours, fonts, names, ids
    const inj = await T(e, async () => {
      const A = window.__aurora;
      const values = {
        accent: '#fff;}*{display:none}', fontFamily: 'Inter";}*{display:none}/*', 'taskbar.color': 'red;background:url(https://x)', style: 'win11"] *{x', theme: 'dark',
        appThemes: { notepad: { theme: 'dark', accent: '#000000;}body{visibility:hidden' }, 'x"]{}': { theme: 'dark', accent: null }, calculator: { theme: 'light', accent: '#123456' } },
        'start.groups': [{ id: 'g-1', name: '<img src=x onerror=alert(1)>Jeux', apps: ['calculator'] }],
        snapPresets: [{ id: 'p-x', name: '</style><script>alert(1)</script>', zones: [{ x: 0, y: 0, w: 1, h: 1 }] }],
        unknownKey: 'x', evil: { a: 1 }, 'taskbar.evil': 1,
        dynamicWallpaper: { source: 'time', set: 'bloom', location: { name: 'P"aris</style>', lat: 1, lon: 2 }, extra: 'url(x)' },
        wallpaper: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>',
      };
      const p = await A.theme.profiles.importJson(JSON.stringify({ format: 'aurora-profile', version: 1, name: 'Injection <b>', values }));
      await A.theme.profiles.apply(p.id);
      await new Promise((r) => setTimeout(r, 1200));
      const vars = document.getElementById('aurora-theme-vars')?.textContent || '';
      const out = {
        keys: Object.keys(p.values).sort(),
        accent: A.settings.get('accent'),
        font: A.settings.get('fontFamily'),
        tbColor: A.settings.get('taskbar.color'),
        appThemes: A.settings.get('appThemes'),
        group: (A.settings.get('start.groups') || [])[0]?.name,
        preset: (A.settings.get('snapPresets') || [])[0]?.name,
        loc: A.settings.get('dynamicWallpaper')?.location?.name,
        dynKeys: Object.keys(A.settings.get('dynamicWallpaper') || {}).sort().join(),
        injected: /display:\s*none|visibility:\s*hidden|url\(https/.test(vars + document.documentElement.getAttribute('style')),
        hidden: getComputedStyle(document.body).visibility !== 'visible' || getComputedStyle(document.getElementById('taskbar')).display === 'none',
        polluted: ({}).polluted === true,
        unknown: ['unknownKey', 'evil', 'taskbar.evil'].some((k) => A.settings.get(k) !== undefined),
        name: p.name,
        wall: A.settings.get('wallpaper'),
        defs: await A.api.invoke('settings:defaults'),
      };
      await A.theme.profiles.remove(p.id);
      return out;
    });
    check(!inj.keys.includes('unknownKey') && !inj.keys.includes('evil') && !inj.keys.includes('taskbar.evil') && !inj.unknown && !inj.polluted, `import: unknown keys are dropped (${inj.keys.join(', ')})`);
    check(inj.accent === inj.defs.accent && /^#[0-9a-f]{6}$/.test(inj.accent) && inj.font === 'inter' && inj.tbColor === null && !inj.injected && !inj.hidden, `import: no CSS injection through colours, font names or the taskbar colour (accent ${inj.accent}, font ${inj.font})`);
    check(JSON.stringify(inj.appThemes) === '{"calculator":{"theme":"light","accent":"#123456"}}', `import: per-app themes keep only valid app ids and colours (${JSON.stringify(inj.appThemes)})`);
    // (profile names keep their text as typed and are always shown with textContent: see "saved profile name is cleaned")
    check(!/[<>]/.test(`${inj.group}${inj.preset}`) && inj.dynKeys === 'followTheme,location,set,source' && inj.wall === inj.defs.wallpaper && /^builtin:/.test(inj.wall), `import: names lose markup ("${inj.group}", "${inj.preset}", "${inj.name}"), unknown sub-keys and scripted SVG pictures are dropped`);

    // ---- documentation contract: every key documented in PERSONALIZATION.md §1 / §9.1 is saved by profiles
    const doc = fs.readFileSync(path.join(ROOT, '..', 'docs', 'PERSONALIZATION.md'), 'utf8');
    const section = doc.slice(doc.indexOf('## 1. Settings schema'), doc.indexOf('## 2. Theme engine')) + doc.slice(doc.indexOf('### 9.1 Keys'), doc.indexOf('### 9.2'));
    const documented = new Set();
    for (const line of section.split('\n')) {
      const m = /^\|\s*([^|]+)\|/.exec(line);
      if (!m) continue;
      for (const k of m[1].matchAll(/`([A-Za-z][\w.]*)`/g)) documented.add(k[1]);
    }
    const pk = await T(e, async () => (await import('app://shell/core/profiles.js')).PROFILE_KEYS);
    // content (pinned lists) and the master sound switch are not part of a look (documented in §1.2 / §5)
    const NOT_LOOK = ['startPinned', 'pinned', 'sounds'];
    const notSaved = [...documented].filter((k) => !NOT_LOOK.includes(k) && !pk.includes(k) && !pk.some((p) => k.startsWith(`${p}.`)));
    check(documented.size > 50 && !notSaved.length, `every documented personalization key (${documented.size}) is in PROFILE_KEYS${notSaved.length ? `: missing ${notSaved.join(', ')}` : ''}`);

    // ---- theme.js must not keep a closed window alive (last window under the pointer / clicked)
    const cdp = await e.app.context().newCDPSession(e.page).catch(() => null);
    if (cdp) {
      await T(e, async () => {
        const reg = window.__aurora.registry;
        await reg.launch('winver');
        await new Promise((r) => setTimeout(r, 800));
        const ws = window.__aurora.wm.byApp('winver');
        const w = ws[ws.length - 1];
        w.focus();
        const el = w.el;
        const r = el.getBoundingClientRect();
        const opt = { bubbles: true, clientX: r.left + 40, clientY: r.top + 60 };
        const target = el.querySelector('.win-titlebar') || el;
        target.dispatchEvent(new PointerEvent('pointerover', opt));
        target.dispatchEvent(new PointerEvent('pointerdown', opt));
        target.dispatchEvent(new PointerEvent('pointerup', opt));
        window.dispatchEvent(new PointerEvent('pointerup', opt));
        window.__closedWin = new WeakRef(el);
        w.close(true);
      });
      await sleep(1500);
      await T(e, () => {
        for (const m of document.querySelectorAll('body > .menu, body > .tooltip')) m.remove();
      });
      for (let i = 0; i < 3; i++) {
        await cdp.send('HeapProfiler.collectGarbage');
        await sleep(300);
      }
      const alive = await T(e, () => !!window.__closedWin.deref());
      check(!alive, 'theme.js releases a closed window (pointer / hover references dropped; the element is garbage-collected)');
      await cdp.detach().catch(() => {});
    } else check(false, 'CDP session for the garbage-collection check');

    const errs = errorsOf(e).filter((l) => !/net::ERR_|favicon/.test(l));
    check(!errs.length, `E2E: no console errors (${errs.slice(0, 3).join(' | ')})`);
  } finally {
    await e.close();
  }
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
