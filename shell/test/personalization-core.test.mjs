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

// ===================================================================== launch 1: engine, styles, profiles, pages
const s = await launchShell({ lang: 'en', theme: 'light', size: '1600x900', open: ['calculator', 'notepad'] });
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
  // transparency level → alpha of the taskbar / window tint
  const alphaAt = async (lvl) => {
    await setKey(s, 'transparencyLevel', lvl);
    return T(s, () => ({ tb: window.__t.alpha(window.__t.cs('#taskbar', 'backgroundColor')), mica: window.__t.alpha(window.__t.cs(window.__t.probe('<div style="background-color: var(--mica-tint)"></div>'), 'backgroundColor')), tp: window.__t.root('--tp') }));
  };
  const a0 = await alphaAt(0);
  const a50 = await alphaAt(50);
  const a100 = await alphaAt(100);
  check(a0.tb === 1 && a0.mica === 1 && a50.tb < 0.9 && a50.tb > 0.75 && a100.tb < a50.tb && a100.mica < 0.65, `transparencyLevel: taskbar alpha ${a0.tb} → ${a50.tb.toFixed(2)} → ${a100.tb.toFixed(2)}, window tint ${a0.mica} → ${a100.mica.toFixed(2)}`);
  await setKey(s, 'transparencyLevel', 50);
  await setKey(s, 'transparency', false);
  const off = await T(s, () => ({ attr: document.documentElement.dataset.transparency, bf: window.__t.cs('#taskbar', 'backdropFilter'), a: window.__t.alpha(window.__t.cs('#taskbar', 'backgroundColor')) }));
  check(off.attr === 'off' && off.bf === 'none' && off.a === 1, 'transparency off: opaque surfaces, no backdrop blur');
  await setKey(s, 'transparency', true);
  // blur intensity → backdrop-filter of the taskbar, flyouts, menus
  await setKey(s, 'blur', 0);
  const b0 = await T(s, () => window.__t.cs('#taskbar', 'backdropFilter'));
  await setKey(s, 'blur', 100);
  const b100 = await T(s, () => ({ tb: window.__t.cs('#taskbar', 'backdropFilter'), menu: window.__t.cs(window.__t.probe('<div class="menu"></div>'), 'backdropFilter'), start: window.__t.cs('#start', 'backdropFilter') }));
  check(/blur\(0px\)/.test(b0) && /blur\(80px\)/.test(b100.tb) && /blur\(60px\)/.test(b100.menu) && /blur\(80px\)/.test(b100.start), `blur intensity: taskbar ${b0} → ${b100.tb}; menu ${b100.menu}`);
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
  check(r0.btn === '0px' && r0.win === '0px' && r200.btn === '8px' && r200.win === '16px', `corner radius 0 % → 200 %: button ${r0.btn} → ${r200.btn}, window ${r0.win} → ${r200.win}`);
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
  check(t150.cap === '18px' && t150.row === '21px' && t150.title === '18px', `text size reaches captions, title bars and px sizes in app style sheets (Settings row ${t100.row} → ${t150.row})`);
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
  const tbDark = await T(s, () => ({ theme: document.getElementById('taskbar').dataset.theme, bg: window.__t.cs('#taskbar', 'backgroundColor'), text: window.__t.cs('#taskbar .tb-btn', 'color') }));
  check(tbDark.theme === 'dark' && /^rgba?\(16, 24, 32/.test(tbDark.bg) && tbDark.text === 'rgb(255, 255, 255)', `taskbar colour: custom dark colour, light icons/text (${tbDark.bg})`);
  await setKey(s, 'taskbar.color', '#f4e8c1');
  check((await T(s, () => document.getElementById('taskbar').dataset.theme)) === 'light', 'taskbar colour: light custom colour keeps dark text');
  await setKey(s, 'taskbar.color', 'accent');
  const tbAcc = await T(s, () => window.__t.cs('#taskbar', 'backgroundColor'));
  await setKey(s, 'taskbar.opacity', 30);
  const tbOp = await T(s, () => window.__t.alpha(window.__t.cs('#taskbar', 'backgroundColor')));
  await setKey(s, 'taskbar.opacity', null);
  await setKey(s, 'taskbar.color', null);
  const tbDef = await T(s, () => ({ theme: document.getElementById('taskbar').dataset.theme || null, bg: window.__t.cs('#taskbar', 'backgroundColor') }));
  check(/^rgba?\(\d+, \d+, \d+/.test(tbAcc) && !/^rgba?\(238, 238, 238/.test(tbAcc) && Math.abs(tbOp - 0.3) < 0.01 && tbDef.theme === null && /^rgba?\(238, 238, 238/.test(tbDef.bg), `taskbar accent colour (${tbAcc}), opacity 30 % (${tbOp}), back to default`);
  // accent + light/dark
  await setKey(s, 'accent', '#e3008c', 600);
  await waitTransitions(s);
  check((await T(s, () => window.__t.root('--accent-base'))) === '#e3008c', 'accent colour');
  await setKey(s, 'theme', 'dark', 600);
  await waitTransitions(s);
  check((await T(s, () => window.__t.cs(document.body, 'color'))) === 'rgb(255, 255, 255)', 'dark mode');
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
  await setKey(s, 'accent', '#0078d4', 800);
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
        tbBlur: window.__t.cs('#taskbar', 'backdropFilter'),
        tbAlpha: window.__t.alpha(window.__t.cs('#taskbar', 'backgroundColor')),
        transp: document.documentElement.dataset.transparency,
        accent: window.__t.root('--accent'),
      };
    });
  const res = {};
  for (const st of ['win11', 'minimal', 'glass', 'retro', 'contrast']) {
    await setKey(s, 'style', st, 700);
    await waitTransitions(s);
    res[st] = await sample();
  }
  const w = res.win11;
  check(Object.entries(res).every(([k, v]) => v.style === k), 'data-style follows the setting');
  check(w.btnRadius === '4px' && /blur\(40px\)/.test(w.tbBlur) && w.transp === 'on' && w.tbAlpha < 1, `Fluent: 4 px buttons, acrylic taskbar (${w.tbBlur})`);
  check(res.minimal.btnRadius === '6px' && res.minimal.tbBlur === 'none' && res.minimal.tbAlpha === 1 && res.minimal.winShadow !== w.winShadow && res.minimal.accent === '#262626', 'Minimal: flat, opaque, no blur, softer shadows, graphite accent');
  check(res.glass.btnRadius === '8px' && /blur\(50px\)/.test(res.glass.tbBlur) && res.glass.tbAlpha < w.tbAlpha && /inset/.test(res.glass.winShadow) && /inset/.test(res.glass.btnShadow), `Glass: rounder, stronger blur (${res.glass.tbBlur}), more translucent taskbar (${res.glass.tbAlpha.toFixed(2)}), highlights`);
  check(res.retro.btnRadius === '0px' && /inset/.test(res.retro.btnShadow) && /linear-gradient/.test(res.retro.titleBg) && res.retro.tbBlur === 'none' && res.retro.tbAlpha === 1, 'Retro: square bevelled buttons, gradient title bars, opaque taskbar');
  check(res.contrast.btnBorder === '2px' && res.contrast.winBorder === '2px' && res.contrast.winShadow === 'none' && res.contrast.tbAlpha === 1 && res.contrast.transp === 'off', 'High contrast: thick borders, no shadows, no transparency');

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
  await setKey(s, 'style', 'win11', 800);
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
      calcBg: getComputedStyle(calc).backgroundColor,
      npTheme: np.dataset.theme || null,
      npText: getComputedStyle(np).color,
      npAccent: v(np, '--accent-base'),
      root: document.documentElement.dataset.theme,
    };
  });
  check(r.calcTheme === 'dark' && r.calcText === 'rgb(255, 255, 255)' && r.calcBg === 'rgb(32, 32, 32)' && r.calcAccent === '#e81123', `Calculator alone is dark with its own accent (${JSON.stringify(r)})`);
  check(r.calcAppVar.replace(/\s/g, '') === 'rgba(255,255,255,0.0837)', `the app's own dark rules follow its window (--ck-num ${r.calcAppVar})`);
  check(r.npTheme === null && r.npText !== 'rgb(255, 255, 255)' && r.npAccent === '#0078d4' && r.root === 'light', 'Notepad and the shell keep the system theme');
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
  check(m.theme === 'dark' && /^rgba?\(44, 44, 44/.test(m.bg), 'a menu opened from that app uses its theme');
  // new window of a themed app, and system dark + app forced light
  await T(s, () => window.__aurora.settings.set('appThemes', { notepad: { theme: 'light', accent: null } }));
  await setKey(s, 'theme', 'dark', 900);
  await waitTransitions(s);
  const r2 = await T(s, () => {
    const calc = document.querySelector('#windows > .win.app-calculator');
    const np = document.querySelector('#windows > .win.app-notepad');
    return { calc: calc.dataset.theme || null, calcText: getComputedStyle(calc).color, np: np.dataset.theme, npText: getComputedStyle(np).color, npAccent: getComputedStyle(np).getPropertyValue('--on-accent').trim() };
  });
  check(r2.calc === null && r2.calcText === 'rgb(255, 255, 255)' && r2.np === 'light' && r2.npText !== 'rgb(255, 255, 255)' && r2.npAccent === '#ffffff', `system dark + Notepad forced light: only Notepad is light (light accent shades); Calculator back to the system theme (${JSON.stringify(r2)})`);
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
    await profiles.apply('retro');
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
  check(['aurora-light', 'aurora-dark', 'glass', 'minimal', 'retro', 'contrast', 'night-owl'].every((id) => r.builtins.includes(id)), `built-in profiles (${r.builtins.join(', ')})`);
  check(r.style === 'retro' && r.font === 'liberation-sans' && r.wall && r.attr === 'retro' && r.current === 'retro', 'one click applies a built-in profile (style, font, wallpaper)');
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
  check(u.afterDark.style === 'win11' && u.afterDark.theme === 'dark' && u.afterDark.textScale === 110, 'built-in profiles change the look but keep accessibility choices (text size)');
  check(u.back.style === 'retro' && u.back.theme === 'light' && u.back.textScale === 110 && u.back.corner === 100 && u.back.cur === u.id, 'a saved profile restores the whole look (keys missing from it go back to their defaults)');
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
  await T(s, () => window.__aurora.shell.emit('profiles:apply', { id: 'minimal' }));
  await sleep(1200);
  check((await T(s, () => window.__t.get('style'))) === 'minimal', "shell.emit('profiles:apply', { id }) applies a profile from anywhere");
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
      shortcuts: { 'shell.start': 'Super+S', evil: { nested: true }, 'x"y': 'Ctrl+K', inject: 'Ctrl+<script>', off: null },
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
  check(!('cursorPack' in v) && v.iconPack === 'fluent' && !('soundPack' in v) && !('taskbar.position' in v) && v['taskbar.size'] === 'large' && JSON.stringify(v['taskbar.widgets']) === '["weather"]' && !('start.background' in v) && JSON.stringify(v['start.folders']) === '["documents"]', 'import: pack ids, taskbar and Start values are strictly validated (no CSS / HTML injection, no path tricks)');
  check(JSON.stringify(v['start.groups'][0].apps) === '["files"]' && v['start.groups'][0].name.length <= 60 && !/[<>]/.test(v['start.groups'][0].name) && JSON.stringify(v.snapPresets[0].zones) === '[{"x":0,"y":0,"w":0.5,"h":1}]', 'import: Start groups and snap layout zones are validated (bounded names, zones inside the screen)');
  check(JSON.stringify(v.shortcuts) === '{"shell.start":"Super+S","off":null}' && JSON.stringify(v.soundEvents) === '{"shutdown":"/usr/share/sounds/x.ogg"}' && JSON.stringify(v.focusMode) === '{"duration":30}', `import: shortcuts, sound files and focus mode values are validated (${JSON.stringify(v.shortcuts)} ${JSON.stringify(v.soundEvents)})`);
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
  for (const [st, mode] of [['retro', 'light'], ['retro', 'dark'], ['contrast', 'dark'], ['contrast', 'light']]) {
    await T(s, ([a, b]) => window.__aurora.api.invoke('settings:setMany', { style: a, theme: b }), [st, mode]);
    await sleep(900);
    await waitTransitions(s);
    ratios[`${st}-${mode}`] = await tabRatio();
  }
  check(Object.entries(ratios).every(([k, x]) => x >= (k.startsWith('contrast') ? 7 : 4.5)), `Notepad's tab in the title bar is readable in Retro and High contrast (${JSON.stringify(ratios)})`);
  // the taskbar clock fits the taskbar at the largest text size
  await T(s, () => window.__aurora.api.invoke('settings:setMany', { style: 'retro', theme: 'light', textScale: 150 }));
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
    await new Promise((r) => setTimeout(r, 900));
    off?.();
    await window.__aurora.settings.set('blur', 50);
    return n;
  });
  check(mica >= 1 && mica <= 2, `blur slider drag: the wallpaper copy is re-blurred ${mica}× for 12 steps`);
  await sleep(500);
}

console.log('\n# Leaks');
{
  const r = {};
  await T(s, async () => {
    const A = window.__aurora;
    const count = () => ({ nodes: document.getElementsByTagName('*').length, head: document.head.children.length, sheets: document.styleSheets.length });
    const before = count();
    const styles = ['win11', 'minimal', 'glass', 'retro', 'contrast'];
    for (let i = 0; i < 20; i++) {
      await A.settings.set('style', styles[i % 5]);
      await A.settings.set('theme', i % 2 ? 'dark' : 'light');
      await new Promise((res) => setTimeout(res, 50));
    }
    await A.api.invoke('settings:setMany', { style: 'win11', theme: 'light' });
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
  check(r.after.head === r.before.head && r.after.sheets === r.before.sheets && Math.abs(r.after.nodes - r.before.nodes) < 10 && r.style === 'win11' && r.theme === 'light' && !r.switching, `20 rapid style + mode switches: no leaked nodes / style sheets, screen in sync (${JSON.stringify(r.before)} → ${JSON.stringify(r.after)}, ${r.style}/${r.theme}${r.switching ? ', still switching' : ''})`);
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
  check(['Theme designer', 'Visual style', 'Profiles', 'App themes', 'Animated & dynamic wallpapers', 'Focus mode', 'Cursors', 'Icon packs', 'Sound packs', 'Keyboard shortcuts', 'Snap layouts', 'Taskbar', 'Start'].every((x) => home.includes(x)), 'Personalization lists every personalization page');
  // Theme designer
  await go('themeDesigner');
  check((await s.page.locator(S('.pz-mock .win')).count()) === 1 && (await s.page.locator(S('.pz-mock-taskbar')).count()) === 1 && (await s.page.locator(S('.pz-mock-start')).count()) === 1 && (await s.page.locator(S('.pz-mock-qs')).count()) === 1, 'Theme designer: live preview with a window, Start, a flyout and the taskbar');
  await s.page.locator(S('.pz-style-card[data-style-id="glass"]')).first().click();
  await sleep(900);
  await waitTransitions(s);
  const pvGlass = await T(s, () => ({ style: window.__t.get('style'), pv: getComputedStyle(document.querySelector('.app-settings .pz-mock .win-ctl')).width, radius: getComputedStyle(document.querySelector('.app-settings .pz-mock .win')).borderTopLeftRadius }));
  check(pvGlass.style === 'glass' && pvGlass.radius === '14px', 'Theme designer: style card applies the style, the preview follows (14 px glass windows)');
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
  check(mockR === '21px', `the preview reflects the corner radius instantly (${mockR})`);
  await s.page.locator(S('.pz-mode button'), { hasText: 'Dark' }).click();
  await sleep(900);
  await waitTransitions(s);
  check((await T(s, () => document.documentElement.dataset.theme)) === 'dark', 'Theme designer: mode');
  await s.page.locator(S('.pz-mode button'), { hasText: 'Auto' }).click();
  await sleep(400);
  check((await T(s, () => window.__t.get('autoTheme').enabled)) === true && (await s.page.locator(S('.pz-auto')).first().isVisible()), 'Theme designer: Auto mode shows the light / dark times');
  await s.page.locator(S('.pz-mode button'), { hasText: 'Dark' }).click();
  await sleep(700);
  await s.page.locator(S('.pz-swatches .pz-swatch[aria-label="#00b294"]')).first().click();
  await sleep(700);
  check((await T(s, () => window.__t.get('accent'))) === '#00b294', 'Theme designer: accent swatch');
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
  check(kb.cardStops.length === 1 && kb.right !== kb.cardStops[0] && kb.end === 'contrast' && kb.home === 'win11', `keyboard: style cards are one Tab stop, arrows / Home / End move between them (${JSON.stringify(kb.cardStops)} → ${kb.right}, ${kb.end}, ${kb.home})`);
  check(kb.swStops.length === 1 && kb.swStops[0] === '#00b294' && kb.next === '#038387' && kb.accent === '#038387' && kb.focused === '#038387' && kb.selected === 'true', `keyboard: accent swatches — one Tab stop on the selected colour, arrows move, Enter picks and the focus stays (${JSON.stringify(kb)})`);
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
  check(!!saved && saved.values.style === 'glass' && saved.values.fontFamily === 'dejavu-sans' && saved.values['taskbar.color'] === 'accent', 'Theme designer: “Save as profile” stores the current look');
  // Profiles page
  await go('profiles');
  check((await s.page.locator(S('.pz-profile')).count()) >= 8 && (await s.page.locator(S('.pz-profile.current')).count()) === 1, 'Profiles page: built-in + saved profiles, the current one marked');
  const cards = await T(s, () => ({
    cut: [...document.querySelectorAll('.app-settings .pz-profile-name')].filter((e) => e.scrollHeight > e.clientHeight + 1 || e.scrollWidth > e.clientWidth + 1).map((e) => e.textContent),
    hc: getComputedStyle(document.querySelector('.app-settings .pz-profile[data-profile-id="contrast"] .pz-profile-accent')).backgroundColor,
  }));
  check(!cards.cut.length && cards.hc === 'rgb(255, 255, 0)', `Profiles page: names are never cut; the colour dot shows the accent the profile really uses (High contrast ${cards.hc}) ${cards.cut.join(', ')}`);
  await docShot(s, 'profiles-dark-en');
  await s.page.locator(S('.pz-profile[data-profile-id="minimal"] .pz-apply')).click();
  await sleep(1500);
  await waitTransitions(s);
  check((await T(s, () => window.__t.get('style'))) === 'minimal' && (await s.page.locator(S('.pz-profile[data-profile-id="minimal"].current')).count()) === 1, 'Profiles page: Apply (one click) and the card becomes current');
  await s.page.locator(S('.pz-profile'), { hasText: 'Designer test' }).first().locator('.pz-more').click({ timeout: 8000 });
  await s.page.locator('body > .menu .menu-item', { hasText: 'Delete' }).click();
  await s.page.waitForSelector('.dialog .btn.primary', { timeout: 4000 });
  await s.page.locator('.dialog .btn.primary').click();
  await sleep(800);
  check(!(await T(s, async () => (await window.__aurora.theme.profiles.list()).some((p) => p.name === 'Designer test'))), 'Profiles page: delete from the … menu (with confirmation)');
  // Visual style page
  await go('visualStyle');
  check((await s.page.locator(S('.pz-style-card')).count()) === 5 && (await s.page.locator(S('.pz-style-card .pz-spv[data-style="retro"] .win-titlebar')).count()) === 1, 'Visual style page: five cards with real mini renderings');
  const cardTitle = await T(s, () => getComputedStyle(document.querySelector('.app-settings .pz-spv[data-style="retro"] .win-titlebar')).backgroundImage);
  check(/linear-gradient/.test(cardTitle), 'the Retro card is rendered in the Retro style while the desktop uses another style');
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
  check((await s.page.locator(S('.pz-profile-name'), { hasText: 'Oiseau de nuit' }).count()) === 1, 'French: built-in profile names');
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
    for (const st of ['win11', 'minimal', 'glass', 'retro', 'contrast']) {
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
  await setKey(s, 'style', 'win11', 600);
  await setKey(s, 'theme', 'light', 600);
  await setKey(s, 'lang', 'en', 500);
  check(true, 'style screenshots written to docs/screenshots/style-*.png');
}

const errs1 = errorsOf(s).filter((l) => !/net::ERR_|favicon/.test(l));
check(!errs1.length, `no console errors (${errs1.slice(0, 3).join(' | ')})`);
await s.close();

// ===================================================================== launches 2–3: 1280×720 and 1920×1080
for (const [size, theme, lang] of [['1280x720', 'dark', 'fr'], ['1920x1080', 'light', 'en']]) {
  console.log(`\n# ${size} ${theme} ${lang}`);
  const t = await launchShell({ size, theme, lang, settings: { style: theme === 'dark' ? 'glass' : 'win11' } });
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
  const t1 = await launchShell({ home, settings: { style: 'retro', textScale: 120, blur: 20, cornerRadius: 150, fontFamily: 'dejavu-serif', accent: '#e3008c', reducedMotion: true, taskbar: { color: '#101820' }, appThemes: { notepad: { theme: 'dark', accent: null } } }, open: ['notepad'] });
  const r = await T(t1, () => ({
    style: document.documentElement.dataset.style,
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
  check(r.style === 'retro' && r.body === '16.8px' && r.np === 'dark' && r.tb === 'none', `settings are restored at boot (style ${r.style}, text ${r.body}, Notepad ${r.np})`);
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
  check((await g.page.evaluate(() => document.documentElement.dataset.style)) === 'retro', 'sign-in screen: data-style applied');
  await g.close();
  fs.rmSync(home, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
