// Settings > Personalization: Theme designer, Visual style, Profiles, App themes (docs/PERSONALIZATION.md).
// Also exports the control builders that other pages reuse, so every setting has one source of truth:
//   modeControl(pc)  accentControls(pc)  taskbarColorControls(pc)  transparencyControls(pc)
//   textSizeControls(pc)  motionControls(pc)  styleCards(pc, { compact })  stylePreview(pc, styleId, opts)
//   pickColorDialog(pc, initial, { title, allowDefault })  livePreview(pc)
import { ACCENTS, STYLES, FONTS, fontInstalled, resolveWallpaper, styleVars, styleAccentVars, theme as coreTheme } from '../../../core/theme.js';
import { profiles, LOOK_KEYS } from '../../../core/profiles.js';
import { ensureStrings } from './personalization-strings.js';
import { PAGES } from '../lib/index.js';

ensureStrings();
const CSS = 'app://shell/apps/settings/pages/personalization.css';
const HEX = /^#[0-9a-f]{6}$/i;
const styleOf = (id) => STYLES.find((s) => s.id === id) || STYLES[0];
const modeOf = (pc) => (pc.settings.get('theme') === 'dark' ? 'dark' : 'light');
const pct = (pc, v) => (pc.lang === 'fr' ? `${v} %` : `${v}%`);

function setup(pc) {
  pc.ui.loadCss(CSS);
}

// ------------------------------------------------------------------ small building blocks
/** A control line: icon + title/description, control on the right or underneath (stacked). */
function ctl(pc, { icon: ic, title, desc, control, stacked = false, section, note, className } = {}) {
  const { h, icon } = pc;
  return h(
    'div',
    { class: ['pz-ctl', stacked && 'stacked', className], dataset: section ? { section } : null },
    h(
      'div',
      { class: 'pz-ctl-head' },
      ic ? h('span', { class: 'pz-ctl-icon' }, icon(ic, { size: 18 })) : null,
      h('div', { class: 'pz-ctl-text' }, h('div', { class: 'pz-ctl-title' }, title), desc ? h('div', { class: 'pz-ctl-desc caption text-2' }, desc) : null),
      !stacked && control ? h('div', { class: 'pz-ctl-right' }, control) : null,
    ),
    stacked && control ? h('div', { class: 'pz-ctl-body' }, control) : null,
    note || null,
  );
}

/** Settings slider: live (throttled) while dragging, committed on release; follows outside changes. */
function liveSlider(pc, { key, min, max, step = 1, def, label, format, live = true, iconStart, iconEnd, disabled }) {
  const cur = () => {
    const raw = pc.settings.get(key);
    const n = raw == null || raw === '' ? NaN : Number(raw);
    return Number.isFinite(n) ? n : def;
  };
  let local = cur();
  let timer = null;
  let pending = null;
  const flush = () => {
    timer = null;
    if (pending != null) {
      const v = pending;
      pending = null;
      pc.settings.set(key, v);
    }
  };
  const s = pc.kit.slider({
    min,
    max,
    step,
    value: local,
    label,
    format: format || ((v) => pct(pc, v)),
    iconStart,
    iconEnd,
    disabled,
    onInput: (v) => {
      local = v;
      if (!live) return;
      pending = v;
      if (!timer) timer = setTimeout(flush, 90);
    },
    onChange: (v) => {
      local = v;
      clearTimeout(timer);
      timer = null;
      pending = null;
      pc.settings.set(key, v);
    },
  });
  s.classList.add('pz-slider');
  s.dataset.key = key;
  pc.onDispose(
    pc.settings.on(key, () => {
      const v = cur();
      if (v !== local) {
        local = v;
        s.set(v);
      }
    }),
  );
  pc.onDispose(() => clearTimeout(timer));
  return s;
}

function bindToggle(pc, key, def, label, { invert = false, onChange } = {}) {
  const read = () => {
    const v = pc.settings.get(key);
    const b = v == null ? def : !!v;
    return invert ? !b : b;
  };
  const tg = pc.kit.toggle({
    value: read(),
    label,
    onChange: (x) => {
      const v = invert ? !x : x;
      onChange?.(v);
      return pc.settings.set(key, v);
    },
  });
  tg.dataset.key = key;
  pc.onDispose(pc.settings.on(key, () => tg.set(read())));
  return tg;
}

/** Keeps a control disabled (with a note) while the visual style overrides it. */
function styleGuard(pc, el, trait, noteEl) {
  const paint = () => {
    const st = styleOf(pc.settings.get('style'));
    const off = !!st.traits[trait];
    el.classList.toggle('pz-overridden', off);
    for (const i of el.querySelectorAll('input, button')) i.disabled = off;
    if (noteEl) {
      noteEl.hidden = !off;
      noteEl.textContent = off ? pc.t('pz.styleOverrides', { style: pc.L(st.name) }) : '';
    }
  };
  paint();
  pc.onDispose(pc.settings.on('style', paint));
}

const noteEl = (pc) => pc.h('div', { class: 'pz-note caption', hidden: true });

/**
 * Arrow-key navigation (roving tabindex) for a group of buttons — style cards, colour swatches: the group is
 * one Tab stop (the selected item), arrows / Home / End move the focus (Up / Down by rows in a grid), Enter /
 * Space activate the focused button. Returns sync() to call after the items or the selection changed.
 */
export function rovingFocus(container, selector) {
  const items = () => [...container.querySelectorAll(selector)].filter((el) => !el.disabled && !el.hidden);
  const isSel = (el) => el.classList.contains('selected') || el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-selected') === 'true';
  const setStop = (list, stop) => {
    for (const el of list) el.tabIndex = el === stop ? 0 : -1;
  };
  const sync = () => {
    const list = items();
    const focused = list.includes(document.activeElement) ? document.activeElement : null;
    setStop(list, focused || list.find(isSel) || list[0]);
  };
  container.addEventListener('keydown', (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const list = items();
    const i = list.indexOf(document.activeElement);
    if (i < 0 || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    let j = i;
    if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = list.length - 1;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const rtl = getComputedStyle(container).direction === 'rtl';
      j = Math.max(0, Math.min(list.length - 1, i + ((e.key === 'ArrowRight') !== rtl ? 1 : -1)));
    } else {
      // the closest item (by centre) in the next / previous row
      const r = list[i].getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const down = e.key === 'ArrowDown';
      const rows = list.map((el) => [el, el.getBoundingClientRect()]).filter(([, b]) => (down ? b.top >= r.bottom - 2 : b.bottom <= r.top + 2));
      if (rows.length) {
        const rowTop = down ? Math.min(...rows.map(([, b]) => b.top)) : Math.max(...rows.map(([, b]) => b.top));
        const row = rows.filter(([, b]) => Math.abs(b.top - rowTop) < 4);
        row.sort((a, b) => Math.abs(a[1].left + a[1].width / 2 - cx) - Math.abs(b[1].left + b[1].width / 2 - cx));
        j = list.indexOf(row[0][0]);
      }
    }
    setStop(list, list[j]);
    list[j].focus();
  });
  container.addEventListener('focusin', (e) => {
    const list = items();
    if (list.includes(e.target)) setStop(list, e.target);
  });
  sync();
  return sync;
}

// ------------------------------------------------------------------ colour picker dialog
export async function pickColorDialog(pc, initial, { title, allowDefault = false } = {}) {
  const { h, t, ui } = pc;
  let value = HEX.test(initial || '') ? initial.toLowerCase() : '#0078d4';
  const input = h('input', { type: 'color', value, class: 'pz-color-input', 'aria-label': t('pz.pickColor') });
  const hex = h('input', { class: 'input pz-hex', value, maxLength: 7, spellcheck: false, 'aria-label': t('pz.hex') });
  const sw = h(
    'div',
    { class: 'pz-swatches small', role: 'listbox', 'aria-label': t('pz.accent') },
    ACCENTS.map((c) => {
      const b = h('button', { type: 'button', class: 'pz-swatch', role: 'option', 'aria-label': c, 'data-tip': c, onclick: () => set(c) });
      b.style.setProperty('--sw', c);
      return b;
    }),
  );
  function set(c) {
    value = c.toLowerCase();
    input.value = value;
    hex.value = value;
    for (const b of sw.children) {
      const on = b.getAttribute('aria-label') === value;
      b.classList.toggle('selected', on);
      b.setAttribute('aria-selected', String(on));
    }
  }
  set(value);
  rovingFocus(sw, '.pz-swatch');
  input.addEventListener('input', () => set(input.value));
  hex.addEventListener('input', () => HEX.test(hex.value) && set(hex.value));
  const body = h('div', { class: 'pz-color-dialog' }, sw, input, h('label', { class: 'row' }, h('span', { class: 'text-2' }, t('pz.hex')), hex));
  const buttons = [{ label: t('common.done'), value: 'ok', primary: true }];
  if (allowDefault) buttons.push({ label: t('pz.useDefault'), value: 'default' });
  buttons.push({ label: t('common.cancel'), value: null });
  const r = await ui.dialog({ title: title || t('pz.pickColor'), body, parent: pc.win, buttons });
  if (r === 'default') return 'default';
  return r === 'ok' && HEX.test(value) ? value : null;
}

// ------------------------------------------------------------------ mode: light / dark / auto
export function modeControl(pc) {
  const { h, t, ui, settings } = pc;
  const current = () => (settings.get('autoTheme')?.enabled ? 'auto' : modeOf(pc));
  const seg = ui.segmented({
    options: [
      { value: 'light', label: t('pz.light'), icon: 'weather_sunny' },
      { value: 'dark', label: t('pz.dark'), icon: 'weather_moon' },
      { value: 'auto', label: t('pz.auto'), icon: 'clock' },
    ],
    value: current(),
    onchange: async (v) => {
      const auto = settings.get('autoTheme') || {};
      if (v === 'auto') {
        await settings.set('autoTheme', { enabled: true, light: auto.light || '07:00', dark: auto.dark || '19:00' });
      } else {
        if (auto.enabled) await settings.set('autoTheme', { ...auto, enabled: false });
        await settings.set('theme', v);
      }
    },
  });
  seg.classList.add('pz-mode');
  seg.setAttribute('role', 'radiogroup');
  seg.setAttribute('aria-label', t('pz.mode'));
  const time = (key, label) => {
    const inp = h('input', {
      class: 'input pz-time',
      type: 'time',
      value: settings.get('autoTheme')?.[key] || (key === 'light' ? '07:00' : '19:00'),
      'aria-label': label,
      onchange: (e) => {
        if (/^\d{2}:\d{2}$/.test(e.target.value)) settings.set('autoTheme', { ...(settings.get('autoTheme') || {}), enabled: true, [key]: e.target.value });
      },
    });
    return h('label', { class: 'pz-time-field' }, h('span', { class: 'caption text-2' }, label), inp);
  };
  const autoRow = h('div', { class: 'pz-auto' }, time('light', t('pz.autoLightAt')), time('dark', t('pz.autoDarkAt')), h('div', { class: 'caption text-2 pz-auto-desc' }, t('pz.autoDesc')));
  const paint = () => {
    seg.setValue(current());
    autoRow.hidden = current() !== 'auto';
  };
  paint();
  pc.onDispose(settings.on('theme', paint));
  pc.onDispose(settings.on('autoTheme', paint));
  return { seg, autoRow };
}

// ------------------------------------------------------------------ accent
export function accentControls(pc, { compact = false } = {}) {
  const { h, t, settings, kit } = pc;
  const swatches = h(
    'div',
    { class: ['pz-swatches', compact && 'small'], role: 'listbox', 'aria-label': t('pz.accent') },
    ACCENTS.map((c) => {
      const b = h('button', { class: 'pz-swatch', type: 'button', role: 'option', 'aria-label': c, 'data-tip': c, onclick: () => setAccent(c) });
      b.style.setProperty('--sw', c);
      return b;
    }),
  );
  let syncFocus = null;
  const paint = () => {
    const cur = String(settings.get('accent') || '#0078d4').toLowerCase();
    // updated in place: rebuilding the buttons would drop the keyboard focus
    for (const b of swatches.children) {
      const on = b.getAttribute('aria-label') === cur;
      b.classList.toggle('selected', on);
      b.setAttribute('aria-selected', String(on));
    }
    syncFocus?.();
    const custom = !ACCENTS.includes(cur);
    customBtn.classList.toggle('selected', custom);
    customBtn.style.setProperty('--sw', cur);
  };
  const setAccent = async (c) => {
    if (settings.get('accentFromWallpaper')) await settings.set('accentFromWallpaper', false);
    await settings.set('accent', c);
  };
  const customBtn = h(
    'button',
    {
      class: 'btn pz-custom-color',
      type: 'button',
      onclick: async () => {
        const c = await pickColorDialog(pc, settings.get('accent'), { title: t('pz.accentCustom') });
        if (c) setAccent(c);
      },
    },
    h('span', { class: 'pz-custom-dot' }),
    t('pz.accentCustom'),
  );
  syncFocus = rovingFocus(swatches, '.pz-swatch');
  paint();
  pc.onDispose(settings.on('accent', paint));
  const note = noteEl(pc);
  const paintNote = () => {
    const st = styleOf(settings.get('style'));
    const own = st.traits.monochrome || st.traits.contrast;
    note.hidden = !own;
    note.textContent = own ? t('pz.accentStyleNote', { style: pc.L(st.name) }) : '';
  };
  paintNote();
  pc.onDispose(settings.on('style', paintNote));
  const fromWall = kit.toggle({
    value: !!settings.get('accentFromWallpaper'),
    label: t('pz.accentFromWallpaper'),
    onChange: (v) => settings.set('accentFromWallpaper', v),
  });
  fromWall.dataset.key = 'accentFromWallpaper';
  pc.onDispose(settings.on('accentFromWallpaper', (v) => fromWall.set(!!v)));
  const body = h('div', { class: 'pz-accent' }, swatches, h('div', { class: 'pz-accent-row' }, customBtn), note);
  const fromRow = ctl(pc, { icon: 'image_sparkle', title: t('pz.accentFromWallpaper'), desc: t('pz.accentFromWallpaperDesc'), control: fromWall, section: 'accentFromWallpaper' });
  return { body, fromRow };
}

// ------------------------------------------------------------------ taskbar colour + opacity
export function taskbarColorControls(pc) {
  const { h, t, settings, kit } = pc;
  const kind = () => {
    const c = settings.get('taskbar.color');
    return c == null ? 'default' : c === 'accent' ? 'accent' : 'custom';
  };
  const dot = h('span', { class: 'pz-tb-dot', 'aria-hidden': 'true' });
  const paintDot = () => {
    const c = settings.get('taskbar.color');
    dot.hidden = !(c && HEX.test(c));
    if (c && HEX.test(c)) dot.style.background = c;
  };
  const combo = kit.combo({
    label: t('pz.taskbarColor'),
    value: kind(),
    options: [
      { value: 'default', label: t('pz.tbDefault') },
      { value: 'accent', label: t('pz.tbAccent') },
      { value: 'custom', label: t('pz.tbCustom') },
    ],
    onChange: async (v) => {
      if (v === 'default') return settings.set('taskbar.color', null);
      if (v === 'accent') return settings.set('taskbar.color', 'accent');
      const cur = settings.get('taskbar.color');
      const c = await pickColorDialog(pc, HEX.test(cur || '') ? cur : '#1f1f3a', { title: t('pz.taskbarColor') });
      if (!c) return false;
      return settings.set('taskbar.color', c);
    },
  });
  combo.dataset.key = 'taskbar.color';
  paintDot();
  pc.onDispose(
    settings.on('taskbar', () => {
      combo.setValue(kind());
      paintDot();
    }),
  );
  const colorNote = noteEl(pc);
  const colorWrap = h('div', { class: 'pz-inline' }, dot, combo);
  styleGuard(pc, colorWrap, 'noTaskbarColor', colorNote);

  // opacity: "Automatic" toggle (null) or a fixed value
  const opNote = noteEl(pc);
  const autoTg = kit.toggle({
    value: settings.get('taskbar.opacity') == null,
    label: t('pz.automatic'),
    onChange: (v) => settings.set('taskbar.opacity', v ? null : 85),
  });
  const slider = liveSlider(pc, { key: 'taskbar.opacity', min: 0, max: 100, step: 5, def: 85, label: t('pz.taskbarOpacity') });
  const paintOp = () => {
    const auto = settings.get('taskbar.opacity') == null;
    autoTg.set(auto);
    slider.hidden = auto;
  };
  paintOp();
  pc.onDispose(settings.on('taskbar', paintOp));
  const opWrap = h('div', { class: 'pz-inline pz-wrap' }, h('span', { class: 'caption text-2' }, t('pz.automatic')), autoTg, slider);
  autoTg.querySelector('.st-toggle-text')?.remove();
  styleGuard(pc, opWrap, 'opaque', opNote);
  return {
    colorRow: ctl(pc, { icon: 'panel_bottom', title: t('pz.taskbarColor'), desc: t('pz.taskbarColorDesc'), control: colorWrap, section: 'taskbarColor', note: colorNote }),
    opacityRow: ctl(pc, { icon: 'transparency_square', title: t('pz.taskbarOpacity'), desc: t('pz.taskbarOpacityDesc'), control: opWrap, stacked: true, section: 'taskbarOpacity', note: opNote }),
  };
}

// ------------------------------------------------------------------ transparency + blur
export function transparencyControls(pc) {
  const { t } = pc;
  const tNote = noteEl(pc);
  const tg = bindToggle(pc, 'transparency', true, t('pz.transparency'));
  const level = liveSlider(pc, { key: 'transparencyLevel', min: 0, max: 100, step: 1, def: 50, label: t('pz.transparencyLevel') });
  const bNote = noteEl(pc);
  const blur = liveSlider(pc, { key: 'blur', min: 0, max: 100, step: 1, def: 50, label: t('pz.blur') });
  const rows = {
    toggleRow: ctl(pc, { icon: 'blur', title: t('pz.transparency'), desc: t('pz.transparencyDesc'), control: tg, section: 'transparency' }),
    levelRow: ctl(pc, { icon: 'transparency_square', title: t('pz.transparencyLevel'), desc: t('pz.transparencyLevelDesc'), control: level, stacked: true, section: 'transparencyLevel', note: tNote }),
    blurRow: ctl(pc, { icon: 'blur', title: t('pz.blur'), desc: t('pz.blurDesc'), control: blur, stacked: true, section: 'blur', note: bNote }),
  };
  styleGuard(pc, rows.levelRow.querySelector('.pz-ctl-body'), 'opaque', tNote);
  styleGuard(pc, rows.blurRow.querySelector('.pz-ctl-body'), 'noBlur', bNote);
  const paintLevel = () => rows.levelRow.classList.toggle('pz-dim', pc.settings.get('transparency') === false);
  paintLevel();
  pc.onDispose(pc.settings.on('transparency', paintLevel));
  return rows;
}

// ------------------------------------------------------------------ text: font, text size, UI scale
export function textSizeControls(pc, { sample = false } = {}) {
  const { h, t, settings, kit } = pc;
  const fontOpts = () =>
    FONTS.map((f) => {
      const ok = fontInstalled(f.id);
      return { value: f.id, label: ok ? pc.L(f.name) : t('pz.fontMissing', { name: pc.L(f.name) }), disabled: !ok };
    });
  const font = kit.combo({ label: t('pz.font'), value: settings.get('fontFamily') || 'inter', options: fontOpts(), width: 220, onChange: (v) => settings.set('fontFamily', v) });
  font.dataset.key = 'fontFamily';
  pc.onDispose(settings.on('fontFamily', (v) => font.setValue(v || 'inter')));
  const size = liveSlider(pc, { key: 'textScale', min: 80, max: 150, step: 5, def: 100, label: t('pz.textSize'), iconStart: 'text_font_size' });
  // UI zoom re-lays out everything: applied when the slider is released
  const cur = Number(settings.get('scale')) || 100;
  const scale = liveSlider(pc, { key: 'scale', min: 100, max: Math.max(cur, Math.min(200, pc.maxScale())), step: 5, def: 100, label: t('pz.uiScale'), live: false, iconStart: 'zoom_in' });
  const sampleEl = sample ? h('div', { class: 'pz-text-sample', 'aria-hidden': 'true' }, h('div', { class: 'subtitle' }, 'Aa'), h('div', null, t('pz.previewText')), h('div', { class: 'caption text-2' }, t('pz.previewText'))) : null;
  return {
    fontRow: ctl(pc, { icon: 'text_font', title: t('pz.font'), desc: t('pz.fontDesc'), control: font, section: 'font' }),
    sizeRow: ctl(pc, { icon: 'text_font_size', title: t('pz.textSize'), desc: t('pz.textSizeDesc'), control: size, stacked: true, section: 'textScale' }),
    scaleRow: ctl(pc, { icon: 'zoom_in', title: t('pz.uiScale'), desc: t('pz.uiScaleDesc'), control: scale, stacked: true, section: 'scale' }),
    sample: sampleEl,
  };
}

export function cornerControl(pc) {
  const s = liveSlider(pc, { key: 'cornerRadius', min: 0, max: 200, step: 5, def: 100, label: pc.t('pz.corners'), iconStart: 'square_shadow' });
  return ctl(pc, { icon: 'shapes', title: pc.t('pz.corners'), desc: pc.t('pz.cornersDesc'), control: s, stacked: true, section: 'corners' });
}

// ------------------------------------------------------------------ motion
export function motionControls(pc) {
  const { t } = pc;
  return {
    animationsRow: ctl(pc, { icon: 'sparkle', title: t('pz.animations'), desc: t('pz.animationsDesc'), control: bindToggle(pc, 'animations', true, t('pz.animations')), section: 'animations' }),
    reducedRow: ctl(pc, { icon: 'accessibility', title: t('pz.reducedMotion'), desc: t('pz.reducedMotionDesc'), control: bindToggle(pc, 'reducedMotion', false, t('pz.reducedMotion')), section: 'reducedMotion' }),
  };
}

// ------------------------------------------------------------------ mini renderings
const SVG_MIN = '<svg viewBox="0 0 10 10"><path d="M0 5h10" stroke="currentColor" stroke-width="1"/></svg>';
const SVG_MAX = '<svg viewBox="0 0 10 10"><rect x=".5" y=".5" width="9" height="9" rx="1.5" fill="none" stroke="currentColor"/></svg>';
const SVG_CLOSE = '<svg viewBox="0 0 10 10"><path d="M.5.5l9 9M9.5.5l-9 9" stroke="currentColor" stroke-width="1"/></svg>';

/** A window drawn with the real shell classes (so every style restyles it), inert. */
function mockWindow(pc, { title, iconUrl, body, className } = {}) {
  const { h } = pc;
  return h(
    'section',
    { class: ['win', 'bg-mica', 'active', 'pz-mock-win', className] },
    h(
      'header',
      { class: 'win-titlebar' },
      h('img', { class: 'win-icon', src: iconUrl || 'app://shell/assets/app-default.svg', alt: '' }),
      h('span', { class: 'win-title ellipsis' }, title),
      h('div', { class: 'win-tb-slot' }),
      h('div', { class: 'win-controls' }, h('span', { class: 'win-ctl win-min', html: SVG_MIN }), h('span', { class: 'win-ctl win-max', html: SVG_MAX }), h('span', { class: 'win-ctl win-close', html: SVG_CLOSE })),
    ),
    h('div', { class: 'win-body' }, body),
  );
}

function mockControls(pc) {
  const { h, t } = pc;
  const tg = h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked: true, tabindex: '-1' }));
  const slider = h('input', { type: 'range', class: 'slider', min: 0, max: 100, value: 60, tabindex: '-1' });
  slider.style.setProperty('--val', '60%');
  return h(
    'div',
    { class: 'pz-mock-content' },
    h('div', { class: 'subtitle' }, t('pz.previewWindow')),
    h('div', { class: 'text-2' }, t('pz.previewText')),
    h('div', { class: 'row' }, h('span', { class: 'btn primary' }, t('pz.previewPrimary')), h('span', { class: 'btn' }, t('pz.previewButton'))),
    h('input', { class: 'input', placeholder: t('pz.previewInput'), tabindex: '-1' }),
    h('div', { class: 'row pz-mock-line' }, tg, h('span', null, t('pz.previewToggle')), h('label', { class: 'checkbox' }, h('input', { type: 'checkbox', checked: true, tabindex: '-1' }))),
    slider,
  );
}

/** Live preview of the whole desktop (wallpaper, a window, Start, a flyout, the taskbar). */
export function livePreview(pc) {
  const { h, t, settings, shell } = pc;
  const reg = shell.registry;
  const icon = (id) => reg?.iconUrl?.(id) || 'app://shell/assets/app-default.svg';
  const apps = ['files', 'browser', 'mail', 'notepad', 'terminal', 'settings'].filter((id) => reg?.get?.(id));
  const wall = h('div', { class: 'pz-mock-wall' });
  const win = mockWindow(pc, { title: t('pz.previewWindow'), iconUrl: icon('settings'), body: mockControls(pc) });
  const start = h(
    'div',
    { class: 'pz-mock-start pz-mock-fly' },
    h('div', { class: 'pz-mock-search' }, pc.icon('search', { size: 14 }), h('span', null, '')),
    h('div', { class: 'pz-mock-label body-strong' }, pc.L({ en: 'Pinned', fr: 'Épinglé' })),
    h(
      'div',
      { class: 'pz-mock-grid' },
      [...apps, 'calculator', 'paint', 'media'].filter((id) => reg?.get?.(id)).slice(0, 8).map((id) => h('div', { class: 'pz-mock-tile' }, h('img', { src: icon(id), alt: '' }), h('span', { class: 'caption ellipsis' }, reg.name(id)))),
    ),
    h('div', { class: 'pz-mock-start-foot' }, h('span', { class: 'avatar pz-mock-avatar' }, 'AU'), h('span', { class: 'caption' }, 'Aurora'), pc.icon('power', { size: 14 })),
  );
  const fly = h(
    'div',
    { class: 'pz-mock-qs pz-mock-fly' },
    h('div', { class: 'pz-mock-tiles' }, ['wifi_1', 'bluetooth', 'airplane', 'weather_moon'].map((ic, i) => h('span', { class: ['pz-mock-qtile', i < 2 && 'on'] }, pc.icon(ic, { size: 14 })))),
    h('div', { class: 'pz-mock-line' }, pc.icon('speaker_2', { size: 14 }), (() => {
      const s = h('input', { type: 'range', class: 'slider', min: 0, max: 100, value: 70, tabindex: '-1' });
      s.style.setProperty('--val', '70%');
      return s;
    })()),
  );
  const menu = h(
    'div',
    { class: 'pz-mock-menu pz-mock-fly' },
    [t('pz.previewMenuOpen'), t('pz.previewMenuShare'), t('pz.previewMenuDelete')].map((x, i) => h('div', { class: ['pz-mock-mi', i === 0 && 'hover'] }, x)),
  );
  const tb = h(
    'div',
    { class: 'pz-mock-taskbar' },
    h('div', { class: 'pz-mock-tb-apps' }, h('span', { class: 'pz-mock-tbb' }, h('img', { src: 'app://shell/assets/aurora-logo.svg', alt: '' })), apps.slice(0, 5).map((id, i) => h('span', { class: ['pz-mock-tbb', i === 0 && 'active'] }, h('img', { src: icon(id), alt: '' }), h('i')))),
    h('div', { class: 'pz-mock-clock caption' }, h('span', null, pc.i18n.formatTime(new Date(), { hour: 'numeric', minute: '2-digit' })), h('span', null, pc.i18n.formatDate(new Date(), { day: 'numeric', month: 'numeric', year: 'numeric' }))),
  );
  const desk = h('div', { class: 'pz-mock', inert: '', 'aria-hidden': 'true' }, wall, win, start, fly, menu, tb);
  const frame = h('div', { class: 'pz-mock-frame' }, desk);
  const paint = () => {
    wall.style.backgroundImage = `url("${coreTheme.wallpaperUrl || resolveWallpaper(settings.get('wallpaper'), modeOf(pc))}")`;
    // the taskbar mock copies the real taskbar's custom colour (data-theme + --taskbar-rgb + accent vars)
    const real = document.getElementById('taskbar');
    for (const a of ['data-theme-scope', 'data-theme']) {
      if (real?.hasAttribute(a)) tb.setAttribute(a, real.getAttribute(a));
      else tb.removeAttribute(a);
    }
    tb.style.cssText = real?.style.cssText || '';
  };
  paint();
  // after theme.js applied the change (it runs in a microtask after the settings event)
  pc.onDispose(settings.on('*', () => setTimeout(paint, 30)));
  pc.onDispose(coreTheme.on('wallpaper', paint));
  return frame;
}

/** Mini rendering of a visual style (real classes inside data-style=<id>). */
export function stylePreview(pc, styleId, { mode, values } = {}) {
  const { h, settings, t } = pc;
  const all = { ...settings.all(), ...(values || {}) };
  const m = mode || (all.theme === 'dark' ? 'dark' : 'light');
  const el = h(
    'div',
    { class: 'pz-spv', inert: '', 'aria-hidden': 'true', 'data-style': styleId, 'data-theme-scope': '', 'data-theme': m },
    h('div', { class: 'pz-spv-wall' }),
    h('div', { class: 'pz-spv-stage' }, mockWindow(pc, { title: pc.L(styleOf(styleId).name), body: h('div', { class: 'pz-spv-body' }, h('div', { class: 'row' }, h('span', { class: 'btn primary' }, t('pz.previewPrimary')), h('span', { class: 'btn' }, t('pz.previewButton'))), h('div', { class: 'row' }, h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked: true, tabindex: '-1' })), h('input', { class: 'input', placeholder: t('pz.previewInput'), tabindex: '-1' }))) })),
    h('div', { class: 'pz-spv-taskbar' }, h('i'), h('i'), h('i'), h('i')),
  );
  for (const [k, v] of Object.entries(styleVars(styleId, all))) el.style.setProperty(k, v);
  for (const [k, v] of Object.entries(styleAccentVars(styleId, all.accent, m))) el.style.setProperty(k, v);
  el.querySelector('.pz-spv-wall').style.backgroundImage = `url("${resolveWallpaper(all.wallpaper, m)}")`;
  return el;
}

/** Radio cards for the visual styles. */
export function styleCards(pc, { compact = false } = {}) {
  const { h, t, settings, icon } = pc;
  const grid = h('div', { class: ['pz-style-grid', compact && 'compact'], role: 'radiogroup', 'aria-label': t('pz.style') });
  const cards = [];
  let syncFocus = null;
  const build = () => {
    const focused = grid.contains(document.activeElement) ? document.activeElement.dataset?.styleId : null;
    grid.replaceChildren();
    cards.length = 0;
    for (const st of STYLES) {
      const card = h(
        'button',
        {
          type: 'button',
          class: 'pz-style-card',
          role: 'radio',
          dataset: { styleId: st.id },
          onclick: () => settings.set('style', st.id),
        },
        stylePreview(pc, st.id),
        h('span', { class: 'pz-style-meta' }, h('span', { class: 'pz-style-name' }, pc.L(st.name)), compact ? null : h('span', { class: 'pz-style-desc caption text-2' }, pc.L(st.desc))),
        h('span', { class: 'pz-style-check' }, icon('checkmark', { size: 12 })),
      );
      cards.push(card);
      grid.appendChild(card);
    }
    mark();
    if (focused) cards.find((c) => c.dataset.styleId === focused)?.focus({ preventScroll: true });
    syncFocus?.();
  };
  const mark = () => {
    const cur = styleOf(settings.get('style')).id;
    for (const c of cards) {
      const on = c.dataset.styleId === cur;
      c.classList.toggle('selected', on);
      c.setAttribute('aria-checked', String(on));
    }
    syncFocus?.();
  };
  build();
  syncFocus = rovingFocus(grid, '.pz-style-card');
  // previews follow the mode, accent, wallpaper and sliders
  let timer = null;
  pc.onDispose(
    settings.on('*', (_v, key) => {
      if (key === 'style') return mark();
      clearTimeout(timer);
      timer = setTimeout(build, 120);
    }),
  );
  pc.onDispose(() => clearTimeout(timer));
  return grid;
}

// ------------------------------------------------------------------ save as profile
async function saveAsProfile(pc) {
  const { t, ui } = pc;
  const name = await ui.prompt({ title: t('pz.saveProfileTitle'), label: t('pz.profileName'), value: '', placeholder: t('pz.profileName'), okLabel: t('common.save'), parent: pc.win, validate: (v) => (v.trim() ? null : t('pz.nameRequired')) });
  if (!name) return null;
  const p = await profiles.saveCurrent(name);
  pc.toast(t('pz.profileSaved', { name: profiles.label(p) }));
  return p;
}

// ================================================================== pages
async function themeDesigner(pc) {
  setup(pc);
  const { h, t, kit, settings, ui } = pc;
  const mode = modeControl(pc);
  const accent = accentControls(pc, { compact: true });
  const tbc = taskbarColorControls(pc);
  const tr = transparencyControls(pc);
  const tx = textSizeControls(pc);
  const mo = motionControls(pc);
  const preview = livePreview(pc);
  const wallThumb = h('span', { class: 'pz-wall-thumb' });
  const paintThumb = () => (wallThumb.style.backgroundImage = `url("${coreTheme.wallpaperUrl || resolveWallpaper(settings.get('wallpaper'), modeOf(pc))}")`);
  paintThumb();
  pc.onDispose(coreTheme.on('wallpaper', paintThumb));
  const lockThumb = h('span', { class: 'pz-wall-thumb' });
  const paintLock = () => (lockThumb.style.backgroundImage = `url("${resolveWallpaper(settings.get('lockWallpaper') || settings.get('wallpaper'), modeOf(pc))}")`);
  paintLock();
  pc.onDispose(settings.on('lockWallpaper', paintLock));
  pc.onDispose(settings.on('wallpaper', paintLock));

  const saveBtn = kit.button(t('pz.saveProfile'), () => saveAsProfile(pc), { primary: true, icon: 'save', className: 'pz-save-profile' });
  const resetBtn = kit.button(t('pz.resetLook'), async () => {
    if (!(await ui.confirm(t('pz.resetLookConfirm'), { title: t('pz.resetLook'), okLabel: t('pz.resetLook'), parent: pc.win }))) return;
    const keys = ['style', 'autoTheme', 'accentFromWallpaper', 'transparency', 'transparencyLevel', 'blur', 'cornerRadius', 'fontFamily', 'taskbar.color', 'taskbar.opacity', 'accent'];
    await coreTheme.transition(() => pc.api.invoke('settings:setMany', {}, { reset: keys }));
    pc.toast(t('pz.resetDone'));
  });

  const card = (title, ...rows) => h('section', { class: 'pz-card' }, title ? h('h3', { class: 'pz-card-title' }, title) : null, ...rows);
  const controls = h(
    'div',
    { class: 'pz-designer-controls' },
    card(t('pz.style'), styleCards(pc, { compact: true })),
    card(
      null,
      ctl(pc, { icon: 'dark_theme', title: t('pz.mode'), desc: t('pz.modeDesc'), control: mode.seg, stacked: true, section: 'mode' }),
      mode.autoRow,
      ctl(pc, { icon: 'color', title: t('pz.accent'), desc: t('pz.accentDesc'), control: accent.body, stacked: true, section: 'accent' }),
      accent.fromRow,
    ),
    card(
      null,
      ctl(pc, { icon: 'image', title: t('pz.wallpaper'), desc: t('pz.wallpaperDesc'), control: h('div', { class: 'pz-inline' }, wallThumb, kit.button(t('pz.change'), () => pc.go('background'))), section: 'wallpaper' }),
      ctl(pc, { icon: 'lock_closed', title: t('pz.lockScreen'), desc: t('pz.lockScreenDesc'), control: h('div', { class: 'pz-inline' }, lockThumb, kit.button(t('pz.change'), () => pc.go('lockscreen'))), section: 'lockscreen' }),
    ),
    card(null, tbc.colorRow, tbc.opacityRow),
    card(null, tr.toggleRow, tr.levelRow, tr.blurRow, cornerControl(pc)),
    card(null, tx.fontRow, tx.sizeRow, tx.scaleRow),
    card(null, mo.reducedRow, mo.animationsRow),
  );
  const previewCol = h(
    'div',
    { class: 'pz-designer-preview' },
    h('div', { class: 'pz-preview-head' }, h('span', { class: 'body-strong' }, t('pz.preview')), h('span', { class: 'caption text-2' }, t('pz.designerIntro'))),
    preview,
    h('div', { class: 'pz-preview-actions' }, saveBtn, resetBtn),
  );
  return h('div', { class: 'pz-designer' }, h('div', { class: 'pz-designer-grid' }, previewCol, controls));
}

async function visualStyle(pc) {
  setup(pc);
  const { h, t } = pc;
  return h(
    'div',
    { class: 'pz-page' },
    h('p', { class: 'pz-intro text-2' }, t('pz.styleIntro')),
    styleCards(pc),
    h('p', { class: 'caption text-2 pz-after' }, t('pz.styleModeNote')),
    pc.kit.related([{ icon: 'window_brush', title: pc.pageTitle('themeDesigner'), desc: pc.L(PAGES.themeDesigner.desc), onClick: () => pc.go('themeDesigner') }]),
  );
}

// ------------------------------------------------------------------ Profiles page
function expandValues(base, values) {
  const out = JSON.parse(JSON.stringify(base || {}));
  for (const [k, v] of Object.entries(values || {})) {
    const parts = k.split('.');
    let o = out;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!o[parts[i]] || typeof o[parts[i]] !== 'object') o[parts[i]] = {};
      o = o[parts[i]];
    }
    o[parts[parts.length - 1]] = v;
  }
  return out;
}

async function profilesPage(pc) {
  setup(pc);
  const { h, t, kit, ui, api, settings, icon } = pc;
  const root = h('div', { class: 'pz-page pz-profiles' });
  const userGrid = h('div', { class: 'pz-profile-grid', dataset: { kind: 'user' } });
  const builtinGrid = h('div', { class: 'pz-profile-grid', dataset: { kind: 'builtin' } });
  let currentId = null;
  let seq = 0;

  async function exportProfile(p) {
    const xdg = pc.shell.xdg || {};
    const safe = profiles.label(p).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').slice(0, 60) || 'profile';
    const path = await ui.filePicker({ mode: 'save', title: t('pz.exportTitle'), path: xdg.documents, name: `${safe}.aurora-profile.json`, filters: [{ name: t('pz.profileFiles'), ext: ['.json'] }], parent: pc.win });
    if (!path) return;
    const values = await profiles.valuesOf(p);
    await api.invoke('fs:writeText', path, profiles.exportJson({ ...p, values }));
    pc.toast(t('pz.exported', { path }));
  }
  async function importProfile() {
    const xdg = pc.shell.xdg || {};
    const path = await ui.filePicker({ mode: 'open', title: t('pz.importTitle'), path: xdg.documents, filters: [{ name: t('pz.profileFiles'), ext: ['.json'] }], parent: pc.win });
    if (!path) return;
    try {
      const text = await api.invoke('fs:readText', path);
      const p = await profiles.importJson(text);
      pc.toast(t('pz.imported', { name: profiles.label(p) }));
    } catch (err) {
      pc.toast(t('pz.importError', { msg: err.message }), 'error');
    }
  }

  function card(p, values) {
    const isCur = p.id === currentId;
    const apply = isCur
      ? h('span', { class: 'pz-current-badge', role: 'img', 'aria-label': t('pz.current'), 'data-tip': t('pz.current') }, icon('checkmark', { size: 14 }))
      : kit.button(t('pz.apply'), () => kit.busy(apply, () => profiles.apply(p.id)), { primary: true, className: 'pz-apply' });
    const more = h(
      'button',
      {
        class: 'btn subtle icon-btn pz-more',
        type: 'button',
        'aria-label': t('pz.moreOptions'),
        'data-tip': t('pz.moreOptions'),
        onclick: (e) => {
          const items = [];
          if (!p.builtin) {
            items.push({ label: t('pz.rename'), icon: 'rename', action: () => renameProfile(p) });
            items.push({ label: t('pz.updateProfile'), icon: 'save', action: async () => (await profiles.update(p.id), pc.toast(t('pz.updated'))) });
          }
          items.push({ label: t('pz.duplicate'), icon: 'copy', action: () => profiles.duplicate(p.id) });
          items.push({ label: t('pz.exportProfile'), icon: 'arrow_export_ltr', action: () => exportProfile(p).catch(pc.toastError) });
          if (!p.builtin) {
            items.push('-');
            items.push({
              label: t('pz.delete'),
              icon: 'delete',
              danger: true,
              action: async () => {
                if (await ui.confirm(t('pz.deleteConfirm', { name: profiles.label(p) }), { title: t('pz.delete'), okLabel: t('pz.delete'), parent: pc.win })) {
                  await profiles.remove(p.id);
                  pc.toast(t('pz.deleted'));
                }
              },
            });
          }
          ui.menu(e.currentTarget, items);
        },
      },
      icon('more_horizontal', { size: 16 }),
    );
    const all = expandValues(settings.all(), values);
    const pv = stylePreview(pc, all.style || 'win11', { values: all });
    const sub = p.builtin ? t('pz.builtin') : t('pz.savedOn', { date: pc.i18n.formatDate(p.updated || p.created, { dateStyle: 'medium' }) });
    const swatch = h('span', { class: 'pz-profile-accent', 'aria-hidden': 'true' });
    // the accent the profile really shows (High contrast and Minimal use their own)
    swatch.style.background = styleAccentVars(all.style, all.accent, all.theme === 'dark' ? 'dark' : 'light')['--accent'];
    return h(
      'div',
      { class: ['pz-profile', isCur && 'current'], dataset: { profileId: p.id } },
      h('button', { class: 'pz-profile-preview', type: 'button', 'aria-label': `${t('pz.apply')} ${profiles.label(p)}`, onclick: () => !isCur && profiles.apply(p.id) }, pv),
      h(
        'div',
        { class: 'pz-profile-info' },
        swatch,
        h('div', { class: 'pz-profile-text' }, h('div', { class: 'pz-profile-name' }, profiles.label(p)), h('div', { class: 'caption text-2 ellipsis' }, isCur ? t('pz.current') : sub)),
        apply,
        more,
      ),
    );
  }
  async function renameProfile(p) {
    const name = await ui.prompt({ title: t('pz.renameTitle'), label: t('pz.profileName'), value: profiles.label(p), okLabel: t('pz.rename'), parent: pc.win, validate: (v) => (v.trim() ? null : t('pz.nameRequired')) });
    if (name) await profiles.rename(p.id, name);
  }
  async function render() {
    const token = ++seq;
    const [list, cur] = await Promise.all([profiles.list(), profiles.current()]);
    if (token !== seq) return;
    currentId = cur;
    const users = list.filter((p) => !p.builtin);
    const built = list.filter((p) => p.builtin);
    const userCards = await Promise.all(users.map(async (p) => card(p, await profiles.valuesOf(p))));
    const builtCards = await Promise.all(built.map(async (p) => card(p, await profiles.valuesOf(p))));
    if (token !== seq) return;
    userGrid.replaceChildren(...(userCards.length ? userCards : [h('div', { class: 'pz-empty text-2' }, t('pz.noProfiles'))]));
    builtinGrid.replaceChildren(...builtCards);
  }
  root.append(
    h('p', { class: 'pz-intro text-2' }, t('pz.profilesIntro')),
    h('div', { class: 'pz-toolbar' }, kit.button(t('pz.saveCurrent'), () => saveAsProfile(pc), { primary: true, icon: 'save', className: 'pz-save-current' }), kit.button(t('pz.importProfile'), () => importProfile().catch(pc.toastError), { icon: 'arrow_import', className: 'pz-import' })),
    h('section', { class: 'pz-section' }, h('h3', { class: 'st-group-title' }, t('pz.yourProfiles')), userGrid),
    h('section', { class: 'pz-section' }, h('h3', { class: 'st-group-title' }, t('pz.builtinProfiles')), builtinGrid),
  );
  await render();
  let timer = null;
  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(render, 150);
  };
  pc.onDispose(profiles.on('change', later));
  pc.onDispose(settings.on('*', later));
  pc.onDispose(() => clearTimeout(timer));
  return root;
}

// ------------------------------------------------------------------ App themes page
async function appThemes(pc) {
  setup(pc);
  const { h, t, kit, settings, ui, shell } = pc;
  const reg = shell.registry;
  const list = h('div', { class: 'st-group-rows pz-app-list' });
  const search = h('input', { class: 'input', type: 'search', placeholder: t('pz.appSearch'), 'aria-label': t('pz.appSearch') });
  const cfgOf = (id) => {
    const c = (settings.get('appThemes') || {})[id] || {};
    return { theme: ['light', 'dark'].includes(c.theme) ? c.theme : 'system', accent: HEX.test(c.accent || '') ? c.accent.toLowerCase() : null };
  };
  async function write(id, patch) {
    const all = { ...(settings.get('appThemes') || {}) };
    const next = { ...cfgOf(id), ...patch };
    if (next.theme === 'system' && !next.accent) delete all[id];
    else all[id] = next;
    await settings.set('appThemes', all);
  }
  const rows = new Map();
  function row(m) {
    const id = m.id;
    const cfg = cfgOf(id);
    const combo = kit.combo({
      label: t('pz.mode'),
      value: cfg.theme,
      width: 170,
      options: [
        { value: 'system', label: t('pz.themeSystem') },
        { value: 'light', label: t('pz.light') },
        { value: 'dark', label: t('pz.dark') },
      ],
      onChange: (v) => write(id, { theme: v }),
    });
    combo.classList.add('pz-app-mode');
    const dot = h('span', { class: 'pz-app-dot' });
    const accBtn = h(
      'button',
      {
        class: 'btn pz-app-accent',
        type: 'button',
        onclick: async () => {
          const c = await pickColorDialog(pc, cfgOf(id).accent || settings.get('accent'), { title: t('pz.appAccentTitle', { app: reg.name(id) }), allowDefault: true });
          if (c === 'default') await write(id, { accent: null });
          else if (c) await write(id, { accent: c });
        },
      },
      dot,
      h('span', { class: 'pz-app-accent-label' }),
    );
    const badge = h('span', { class: 'pz-badge caption' }, t('pz.customized'));
    const paint = () => {
      const c = cfgOf(id);
      combo.setValue(c.theme);
      dot.style.background = c.accent || 'var(--accent-base, var(--accent))';
      accBtn.querySelector('.pz-app-accent-label').textContent = c.accent ? c.accent : t('pz.appAccentDefault');
      accBtn.setAttribute('aria-label', `${t('pz.accent')}: ${c.accent || t('pz.appAccentDefault')}`);
      badge.hidden = c.theme === 'system' && !c.accent;
    };
    paint();
    const el = kit.row({ icon: h('img', { src: reg.iconUrl(id), alt: '', class: 'pz-app-icon' }), title: reg.name(id), desc: badge, control: h('div', { class: 'pz-inline' }, combo, accBtn), className: 'pz-app-row' });
    el.dataset.app = id;
    rows.set(id, { el, paint, name: reg.name(id).toLowerCase() });
    return el;
  }
  const apps = reg.list();
  list.append(...apps.map(row));
  const empty = h('div', { class: 'pz-empty text-2', hidden: true }, t('pz.noApps'));
  search.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase();
    let n = 0;
    for (const r of rows.values()) {
      const show = !q || r.name.includes(q);
      r.el.hidden = !show;
      if (show) n++;
    }
    empty.hidden = n > 0;
  });
  pc.onDispose(settings.on('appThemes', () => rows.forEach((r) => r.paint())));
  const reset = kit.button(t('pz.resetApps'), async () => {
    if (await ui.confirm(t('pz.resetAppsConfirm'), { title: t('pz.resetApps'), okLabel: t('pz.resetApps'), parent: pc.win })) await settings.set('appThemes', {});
  });
  // Minimal and High contrast draw every accent with their own palette: say so (the choice is kept for the other styles)
  const styleNote = noteEl(pc);
  const paintStyleNote = () => {
    const st = styleOf(settings.get('style'));
    const own = st.traits.monochrome || st.traits.contrast;
    styleNote.hidden = !own;
    styleNote.textContent = own ? t('pz.accentStyleNote', { style: pc.L(st.name) }) : '';
  };
  paintStyleNote();
  pc.onDispose(settings.on('style', paintStyleNote));
  return h(
    'div',
    { class: 'pz-page' },
    h('p', { class: 'pz-intro text-2' }, t('pz.appThemesIntro')),
    styleNote,
    h('div', { class: 'pz-toolbar' }, h('div', { class: 'search-box pz-app-search' }, search, pc.icon('search', { size: 16 })), reset),
    h('section', { class: 'st-group' }, list, empty),
  );
}

export default { themeDesigner, visualStyle, profiles: profilesPage, appThemes };
export { saveAsProfile, ctl, liveSlider, bindToggle, LOOK_KEYS };
