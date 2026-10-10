// Snipping Tool — Windows 11-style screen capture and markup for Aurora OS.
//
// Views (one window, resized with a smooth animation between them):
//   compact   the small toolbar window: New, snipping mode, delay, "See more" (not resizable)
//   editor    the snip with pen / highlighter / eraser / crop, undo/redo, zoom, save as, copy, Paint
//   settings  auto-copy, auto-save to ~/Pictures/Screenshots, ask to save edited snips, border, about
//
// Launch args:  { mode: 'region'|'rect'|'window'|'full'|'free', immediate: true }  starts a snip right
// away without showing the window (PrintScreen / Super+Shift+S); after the snip the editor opens.
//               { snip: id }  reopen a recent snip (toast click)      { file: path }  open an image
// The capture flow lives in capture.js, the canvas editor in editor.js.
// Test hook: win.el.__snip (this controller).
import { wm } from '../../core/wm.js';
import { sounds } from '../../core/sounds.js';
import { SnipSession, MODES, MODE_ICONS } from './capture.js';
import { SnipEditor, PEN_COLORS, HL_COLORS } from './editor.js';

const DELAYS = [0, 3, 5, 10];
const SETTINGS_DEFAULTS = { autoCopy: true, autoSave: true, askSave: true, border: false, borderColor: '#1f1f1f', borderWidth: 2 };
const BORDER_COLORS = [
  ['black', '#1f1f1f'], ['gray', '#808080'], ['white', '#ffffff'], ['red', '#e81224'], ['orange', '#f7630c'],
  ['yellow', '#fff100'], ['green', '#16a34a'], ['blue', '#0078d4'], ['purple', '#8a4fff'],
];
const MODE_ALIASES = { region: 'rect', rect: 'rect', rectangle: 'rect', window: 'window', full: 'full', fullscreen: 'full', screen: 'full', free: 'free', freeform: 'free', 'free-form': 'free' };
const COMPACT = { w: 548, h: 178 };
const EDITOR_MIN = { w: 560, h: 400 };
const EDITOR_PREF = { w: 1000, h: 620 };
const EASE = 'cubic-bezier(0.1, 0.9, 0.2, 1)';
const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.bmp', '.gif', '.webp'];

// Recent snips, shared by every instance, so a toast can reopen its snip even after the app was closed.
const recent = new Map();
let snipSeq = 0;
function remember(snip) {
  recent.set(snip.id, snip);
  while (recent.size > 8) recent.delete(recent.keys().next().value);
}

const pad = (n) => String(n).padStart(2, '0');
export const stamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
const reduceMotion = () => document.documentElement.dataset.animations === 'off';
const isLocked = () => document.body.classList.contains('aurora-locked');
const baseName = (p) => String(p || '').split('/').pop();
const dirName = (p) => String(p || '').replace(/\/[^/]*$/, '') || '/';

function canvasBytes(canvas, type = 'image/png', quality = 0.92) {
  let src = canvas;
  if (type === 'image/jpeg') {
    // JPEG has no alpha: flatten transparent (free-form) areas onto white.
    src = document.createElement('canvas');
    src.width = canvas.width;
    src.height = canvas.height;
    const g = src.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, src.width, src.height);
    g.drawImage(canvas, 0, 0);
  }
  return new Promise((resolve, reject) =>
    src.toBlob(
      (b) => (b ? b.arrayBuffer().then((ab) => resolve(new Uint8Array(ab)), reject) : reject(new Error('Image encoding failed'))),
      type,
      quality,
    ),
  );
}

async function bytesToCanvas(bytes) {
  const bmp = await createImageBitmap(new Blob([bytes]));
  const c = document.createElement('canvas');
  c.width = bmp.width;
  c.height = bmp.height;
  c.getContext('2d').drawImage(bmp, 0, 0);
  bmp.close?.();
  return c;
}

// Image clipboard through the app's own backend (main/ipc/snipping.js), which supports both the classic
// and the newer Electron clipboard APIs; the core clipboard:writeImage channel is the fallback.
async function writeClipboardImage(api, bytes) {
  try {
    return await api.invoke('snipping:clipboardWriteImage', bytes);
  } catch (err) {
    if (err?.code !== 'ENOHANDLER') throw err;
    return api.invoke('clipboard:writeImage', bytes);
  }
}

function withBorder(canvas, color, width) {
  const b = Math.max(1, Math.min(20, Math.round(width) || 1));
  const c = document.createElement('canvas');
  c.width = canvas.width + 2 * b;
  c.height = canvas.height + 2 * b;
  const g = c.getContext('2d');
  g.fillStyle = color;
  g.fillRect(0, 0, c.width, c.height);
  g.clearRect(b, b, canvas.width, canvas.height);
  g.drawImage(canvas, b, b);
  return c;
}

export default {
  async launch(ctx) {
    const app = new Snipping(ctx);
    ctx.win.el.__snip = app;
    await app.init();
    return { onRelaunch: (args) => app.handleArgs(args || {}) };
  },
};

class Snipping {
  constructor(ctx) {
    this.ctx = ctx;
    this.win = ctx.win;
    this.view = 'compact';
    this.prefs = { mode: 'rect', delay: 0 };
    this.settings = { ...SETTINGS_DEFAULTS };
    this.session = null;
    this.snip = null;
    this.shown = false;
    this.closed = false;
    this.flyout = null;
    this.prevView = null;
    this.offs = [];
    this.timers = new Set();
  }

  get t() {
    return this.ctx.t;
  }

  // ------------------------------------------------------------------ lifecycle
  async init() {
    const { ctx, win } = this;
    const args = ctx.args || {};
    // Hide at once when the window only exists to host a snip (PrintScreen) or to open one.
    const deferReveal = !!(args.immediate || args.snip || args.file);
    if (deferReveal) this.hideWindow({ skipTaskbar: true });
    else this.markReady();

    const [prefs, settings] = await Promise.all([ctx.storage.get('prefs', {}).catch(() => ({})), ctx.storage.get('settings', {}).catch(() => ({}))]);
    if (prefs && typeof prefs === 'object') {
      if (MODES.includes(prefs.mode)) this.prefs.mode = prefs.mode;
      if (DELAYS.includes(prefs.delay)) this.prefs.delay = prefs.delay;
      if (prefs.pen && /^#[0-9a-f]{6}$/i.test(prefs.pen.color)) this.penPref = { color: prefs.pen.color, size: Math.max(1, Math.min(24, Number(prefs.pen.size) || 4)) };
      if (prefs.hl && /^#[0-9a-f]{6}$/i.test(prefs.hl.color)) this.hlPref = { color: prefs.hl.color, size: Math.max(4, Math.min(40, Number(prefs.hl.size) || 18)) };
    }
    if (settings && typeof settings === 'object') {
      for (const k of ['autoCopy', 'autoSave', 'askSave', 'border']) if (typeof settings[k] === 'boolean') this.settings[k] = settings[k];
      if (/^#[0-9a-f]{6}$/i.test(settings.borderColor || '')) this.settings.borderColor = settings.borderColor;
      if (Number(settings.borderWidth) >= 1) this.settings.borderWidth = Math.min(10, Math.round(settings.borderWidth));
    }

    this.editor = new SnipEditor({
      h: ctx.h,
      t: ctx.t,
      onChange: (kind) => this.onEditorChange(kind),
      onZoom: () => this.updateUI(),
      onToolChange: () => this.updateUI(),
      onCropChange: () => {},
      onRulerChange: () => this.updateUI(),
    });
    if (this.penPref) Object.assign(this.editor.pen, this.penPref);
    if (this.hlPref) Object.assign(this.editor.hl, this.hlPref);
    this.build();
    this.applyView('compact', { size: false });

    win.el.addEventListener('keydown', (e) => this.onKey(e));
    // Shortcuts keep working when the keyboard focus fell back to <body> while this window is active.
    this.docKey = (e) => {
      if (this.hidden || this.closed || wm.focused() !== this.win) return;
      if (e.target !== document.body && e.target !== document.documentElement) return;
      this.onKey(e);
    };
    document.addEventListener('keydown', this.docKey);
    win.onBeforeClose(() => this.beforeClose());
    ctx.onClose(() => this.dispose());
    this.offs.push(ctx.shell.on?.('lock', () => this.session?.cancel()));
    ctx.onLangChange(() => this.rebuild());
    this.tbObserver = new ResizeObserver(() => this.layoutToolbar());
    this.tbObserver.observe(win.titlebarSlot);
    win.on('resize', () => this.layoutToolbar());

    if (deferReveal || args.mode) this.handleArgs(args);
    else if (wm.focused() === win) {
      // Like Windows: Enter starts a snip right away; the focus ring only shows once the keyboard is used.
      const btn = this.btnNew;
      btn.classList.add('snip-quiet');
      const loud = () => btn.classList.remove('snip-quiet');
      btn.addEventListener('keydown', loud, { once: true });
      btn.addEventListener('blur', loud, { once: true });
      btn.focus({ preventScroll: true });
    }
    return this;
  }

  dispose() {
    this.closed = true;
    document.removeEventListener('keydown', this.docKey);
    this.session?.cancel();
    this.closeFlyout();
    this.tbObserver?.disconnect();
    for (const off of this.offs) typeof off === 'function' && off();
    for (const id of this.timers) {
      clearTimeout(id);
      clearInterval(id);
    }
    clearTimeout(this.copyTimer);
    clearTimeout(this.flashTimer);
  }

  async beforeClose() {
    if (this.session) {
      this.session.cancel();
      return true;
    }
    return this.confirmDiscard();
  }

  handleArgs(args = {}) {
    if (this.closed) return;
    if (args.snip != null) return this.openSnipById(args.snip);
    if (args.file) return this.openPath(args.file);
    if (args.immediate || args.mode) {
      const mode = MODE_ALIASES[String(args.mode || '').toLowerCase()] || this.prefs.mode;
      if (!args.immediate) {
        // A mode without "immediate" only preselects it.
        this.setMode(mode);
        return;
      }
      return this.newSnip({ mode, delay: Number(args.delay) || 0, source: 'hotkey' });
    }
    if (!this.shown && !this.session) this.showWindow();
  }

  // ------------------------------------------------------------------ window visibility
  markReady() {
    this.win.el.classList.add('snip-ready');
    this.shown = true;
  }
  hideWindow({ skipTaskbar = false } = {}) {
    const { win } = this;
    win.el.classList.add('snip-hidden');
    if (skipTaskbar && !win.opts.skipTaskbar) {
      win.opts.skipTaskbar = true;
      wm.emit('change', win);
    }
    if (wm.focused() === win) wm.focusTop(win);
  }
  showWindow({ focus = true, animate = true } = {}) {
    const { win } = this;
    if (this.closed) return;
    const el = win.el;
    const wasHidden = el.classList.contains('snip-hidden') || !el.classList.contains('snip-ready');
    el.classList.remove('snip-hidden');
    el.classList.add('snip-ready');
    this.shown = true;
    if (win.opts.skipTaskbar) {
      win.opts.skipTaskbar = false;
      wm.emit('change', win);
    }
    if (wasHidden && animate && !reduceMotion() && !win.minimized) {
      el.animate(
        [
          { opacity: 0, transform: 'scale(0.96) translateY(6px)' },
          { opacity: 1, transform: 'none' },
        ],
        { duration: 240, easing: EASE },
      );
    }
    if (focus) win.focus();
    requestAnimationFrame(() => this.layoutToolbar());
  }
  get hidden() {
    return this.win.el.classList.contains('snip-hidden') || !this.win.el.classList.contains('snip-ready');
  }
  /** Dialogs are scoped to the window when it is big enough to hold them, otherwise global. */
  dlgParent() {
    const w = this.win;
    return !this.hidden && !w.minimized && w.w >= 520 && w.h >= 380 ? w : undefined;
  }
  alert(message) {
    return this.ctx.ui.alert(message, { title: this.t('errorTitle'), parent: this.dlgParent() });
  }

  // ------------------------------------------------------------------ UI
  build() {
    const { h, icon, win } = this.ctx;
    const t = this.t;
    const btn = (cls, tip, ic, onclick, extra = {}) =>
      h('button', { class: `btn subtle icon-btn ${cls}`, 'data-tip': tip, 'aria-label': tip, onclick, ...extra }, typeof ic === 'string' ? icon(ic) : ic);

    // -- title bar: left group
    this.btnNew = h('button', { class: 'btn primary snip-new', 'data-tip': t('newTip'), 'aria-label': t('newTip'), onclick: () => this.newSnip({ source: 'app' }) }, icon('add'), h('span', null, t('new')));
    this.modeIcon = h('span', { class: 'snip-dd-icon' });
    this.btnMode = h('button', { class: 'btn subtle snip-dd snip-mode', 'aria-haspopup': 'menu', onclick: (e) => this.modeMenu(e) }, this.modeIcon, icon('chevron_down', { size: 12, class: 'snip-chev' }));
    this.delayLabel = h('span', { class: 'snip-dd-label' });
    this.btnDelay = h('button', { class: 'btn subtle snip-dd snip-delay', 'aria-haspopup': 'menu', onclick: (e) => this.delayMenu(e) }, icon('timer'), this.delayLabel, icon('chevron_down', { size: 12, class: 'snip-chev' }));
    this.left = h('div', { class: 'snip-tb-left' }, this.btnNew, this.btnMode, this.btnDelay);
    this.btnBack = btn('snip-back', t('back'), 'arrow_left', () => this.closeSettings());
    this.setHead = h('div', { class: 'snip-tb-settings' }, this.btnBack, h('span', { class: 'snip-tb-title' }, this.ctx.i18n.name(this.ctx.manifest.name)));

    // -- editing tools (in the title bar when it is wide enough, otherwise in a row below it)
    this.btnUndo = btn('snip-undo', t('undo'), 'arrow_undo', () => this.editor.undo());
    this.btnRedo = btn('snip-redo', t('redo'), 'arrow_redo', () => this.editor.redo());
    const inkBtn = (tool, ic, name) => {
      const bar = h('span', { class: 'snip-ink-bar' });
      const b = h(
        'button',
        { class: 'btn subtle icon-btn snip-tool', dataset: { tool }, 'data-tip': name, 'aria-label': name, 'aria-pressed': 'false', onclick: (e) => this.toolClick(tool, e.currentTarget), oncontextmenu: (e) => (e.preventDefault(), this.openToolFlyout(tool, e.currentTarget)) },
        h('span', { class: 'snip-ink' }, icon(ic), bar),
      );
      b._bar = bar;
      return b;
    };
    this.btnPen = inkBtn('pen', 'pen', t('pen'));
    this.btnHl = inkBtn('hl', 'highlight', t('highlighter'));
    this.btnEraser = inkBtn('eraser', 'eraser', t('eraser'));
    this.btnRuler = h('button', { class: 'btn subtle icon-btn snip-tool snip-ruler-btn', dataset: { tool: 'ruler' }, 'data-tip': t('ruler'), 'aria-label': t('ruler'), 'aria-pressed': 'false', onclick: () => this.editor.toggleRuler() }, icon('ruler'));
    this.btnCrop = h('button', { class: 'btn subtle icon-btn snip-tool', dataset: { tool: 'crop' }, 'data-tip': t('crop'), 'aria-label': t('crop'), 'aria-pressed': 'false', onclick: () => this.toolClick('crop') }, icon('crop'));
    this.btnCropOk = h('button', { class: 'btn subtle icon-btn snip-crop-ok', 'data-tip': t('cropApply'), 'aria-label': t('cropApply'), onclick: () => this.editor.applyCrop() }, icon('checkmark'));
    this.btnCropNo = h('button', { class: 'btn subtle icon-btn snip-crop-no', 'data-tip': t('cropCancel'), 'aria-label': t('cropCancel'), onclick: () => this.editor.cancelCrop() }, icon('dismiss'));
    this.btnCropReset = h('button', { class: 'btn subtle snip-crop-reset', onclick: () => this.editor.resetCrop() }, icon('arrow_reset'), h('span', null, t('cropReset')));
    this.inkGroup = h('div', { class: 'snip-tools-ink' }, this.btnUndo, this.btnRedo, h('div', { class: 'snip-sep' }), this.btnPen, this.btnHl, this.btnEraser, this.btnRuler, this.btnCrop);
    this.cropGroup = h('div', { class: 'snip-tools-crop' }, this.btnCropReset, h('div', { class: 'snip-sep' }), this.btnCropOk, this.btnCropNo);
    this.tools = h('div', { class: 'snip-tools', role: 'toolbar', 'aria-label': t('canvas') }, this.inkGroup, this.cropGroup);

    // -- title bar: right group
    this.zoomLabel = h('span', { class: 'snip-zoom-label' });
    this.btnZoom = h('button', { class: 'btn subtle snip-dd snip-zoom', 'data-tip': t('zoom'), 'aria-label': t('zoom'), 'aria-haspopup': 'menu', onclick: (e) => this.zoomMenu(e) }, icon('zoom_in'), this.zoomLabel);
    this.btnSave = btn('snip-save', t('save'), 'save', () => this.saveAs());
    this.btnCopy = btn('snip-copy', t('copy'), 'copy', () => this.copy());
    this.btnPaint = btn('snip-paint', t('paint'), 'paint_brush', () => this.editInPaint());
    this.btnMore = btn('snip-more', t('more'), 'more_horizontal', (e) => this.moreMenu(e), { 'aria-haspopup': 'menu' });
    this.editActions = h('div', { class: 'snip-tb-edit' }, this.btnZoom, this.btnSave, this.btnCopy, this.btnPaint);
    this.right = h('div', { class: 'snip-tb-right' }, this.editActions, this.btnMore);
    this.tb = h('div', { class: 'snip-tb' }, this.left, this.setHead, this.tools, this.right);
    win.titlebarSlot.appendChild(this.tb);

    // -- body
    this.toolrow = h('div', { class: 'snip-toolrow' });
    const kbd = (k) => h('kbd', null, k);
    const plus = () => h('span', { class: 'snip-plus' }, '+');
    this.compactEl = h(
      'div',
      { class: 'snip-compact' },
      h(
        'p',
        { class: 'snip-hint' },
        `${t('hintStart')} `,
        h('span', { class: 'snip-keys' }, kbd(t('keySuper')), plus(), kbd(t('keyShift')), plus(), kbd('S')),
        ` ${t('hintOr')} `,
        h('span', { class: 'snip-keys' }, kbd(t('keyPrint'))),
        ` ${t('hintEnd')}`,
      ),
    );
    this.flashEl = h('div', { class: 'snip-flash', role: 'status', 'aria-live': 'polite' });
    this.editorEl = h('div', { class: 'snip-editor' }, this.editor.el, this.flashEl);
    this.settingsEl = this.buildSettings();
    this.root = h('div', { class: 'snip-app', dataset: { view: this.view } }, this.toolrow, this.compactEl, this.editorEl, this.settingsEl);
    win.body.appendChild(this.root);
    this.editor.el.setAttribute('aria-label', t('canvas'));
    this.editor.rulerEl.setAttribute('aria-label', t('ruler'));
    this.updateUI();
  }

  rebuild() {
    if (this.closed) return;
    this.closeFlyout();
    this.tb?.remove();
    this.root?.remove();
    this.build();
    this.applyView(this.view, { size: false });
  }

  buildSettings() {
    const { h, icon, ui } = this.ctx;
    const t = this.t;
    const s = this.settings;
    const row = (key, title, desc, extra) =>
      h(
        'div',
        { class: 'card-row snip-set-row', dataset: { key } },
        h('div', { class: 'grow' }, h('div', { class: 'snip-set-title' }, title), h('div', { class: 'caption text-2' }, desc, extra || null)),
        ui.toggle({ checked: s[key], onchange: (v) => this.setSetting(key, v) }),
      );
    const swatches = h(
      'div',
      { class: 'snip-swatches', role: 'radiogroup', 'aria-label': t('borderColor') },
      BORDER_COLORS.map(([name, hex]) =>
        h('button', {
          class: ['snip-swatch', hex === s.borderColor && 'selected'],
          role: 'radio',
          'aria-checked': String(hex === s.borderColor),
          'aria-label': t(`colorNames.${name}`),
          'data-tip': t(`colorNames.${name}`),
          style: { background: hex },
          onclick: (e) => {
            this.setSetting('borderColor', hex);
            for (const b of swatches.children) {
              b.classList.toggle('selected', b === e.currentTarget);
              b.setAttribute('aria-checked', String(b === e.currentTarget));
            }
          },
        }),
      ),
    );
    const widthVal = h('span', { class: 'snip-set-val' }, t('borderPx', { n: s.borderWidth }));
    const widthSlider = ui.slider({
      min: 1,
      max: 10,
      value: s.borderWidth,
      oninput: (v) => {
        widthVal.textContent = t('borderPx', { n: v });
        this.setSetting('borderWidth', v);
      },
    });
    widthSlider.setAttribute('aria-label', t('borderWidth'));
    const borderSub = h(
      'div',
      { class: 'snip-set-sub', hidden: !s.border },
      h('div', { class: 'snip-set-subrow' }, h('span', { class: 'grow' }, t('borderColor')), swatches),
      h('div', { class: 'snip-set-subrow' }, h('span', { class: 'grow' }, t('borderWidth')), widthSlider, widthVal),
    );
    const borderRow = row('border', t('border'), t('borderDesc'));
    borderRow.querySelector('input').addEventListener('change', (e) => (borderSub.hidden = !e.target.checked));
    const openFolder = h('button', { class: 'snip-link', onclick: () => this.openScreenshotsFolder() }, t('openFolder'));
    const env = this.ctx.env || {};
    return h(
      'div',
      { class: 'snip-settings', tabindex: '-1' },
      h(
        'div',
        { class: 'snip-set-inner' },
        h('h1', { class: 'title snip-set-h1' }, t('settingsTitle')),
        h('h2', { class: 'snip-set-h2' }, t('secSnipping')),
        row('autoCopy', t('autoCopy'), t('autoCopyDesc')),
        row('autoSave', t('autoSave'), t('autoSaveDesc'), h('span', null, ' · ', openFolder)),
        row('askSave', t('askSave'), t('askSaveDesc')),
        h('div', { class: 'snip-set-group' }, borderRow, borderSub),
        h('h2', { class: 'snip-set-h2' }, t('secAbout')),
        h(
          'div',
          { class: 'card snip-set-about' },
          h('img', { src: this.ctx.appUrl('icon.svg'), alt: '', width: 40, height: 40 }),
          h(
            'div',
            { class: 'grow' },
            h('div', { class: 'snip-set-title' }, this.ctx.i18n.name(this.ctx.manifest.name)),
            h('div', { class: 'caption text-2' }, t('version', { v: env.version || '1.0' })),
            h('div', { class: 'caption text-2 snip-set-desc' }, t('aboutDesc')),
            h('div', { class: 'caption text-3' }, t('aboutLicense')),
          ),
        ),
      ),
    );
  }

  setSetting(key, value) {
    this.settings[key] = value;
    clearTimeout(this.saveSetTimer);
    this.saveSetTimer = setTimeout(() => this.ctx.storage.set('settings', this.settings).catch(() => {}), 150);
  }
  savePrefs() {
    clearTimeout(this.savePrefTimer);
    this.savePrefTimer = setTimeout(
      () => this.ctx.storage.set('prefs', { ...this.prefs, pen: { ...this.editor.pen }, hl: { ...this.editor.hl } }).catch(() => {}),
      200,
    );
  }
  setMode(m) {
    if (!MODES.includes(m)) return;
    this.prefs.mode = m;
    this.savePrefs();
    this.updateUI();
  }
  setDelay(d) {
    if (!DELAYS.includes(d)) return;
    this.prefs.delay = d;
    this.savePrefs();
    this.updateUI();
  }

  updateUI() {
    if (!this.btnMode) return;
    const { icon } = this.ctx;
    const t = this.t;
    const ed = this.editor;
    this.modeIcon.replaceChildren(icon(MODE_ICONS[this.prefs.mode]));
    const modeTip = `${t('mode')}: ${t(`modes.${this.prefs.mode}`)}`;
    this.btnMode.dataset.tip = modeTip;
    this.btnMode.setAttribute('aria-label', modeTip);
    this.delayLabel.textContent = this.prefs.delay ? t('delayShort', { n: this.prefs.delay }) : t('noDelay');
    const delayTip = `${t('delay')}: ${this.prefs.delay ? t('delaySeconds', { n: this.prefs.delay }) : t('noDelay')}`;
    this.btnDelay.dataset.tip = delayTip;
    this.btnDelay.setAttribute('aria-label', delayTip);
    const has = ed.hasImage;
    this.btnUndo.disabled = !ed.canUndo;
    this.btnRedo.disabled = !ed.canRedo;
    for (const b of [this.btnPen, this.btnHl, this.btnEraser, this.btnRuler, this.btnCrop]) {
      const on = b === this.btnRuler ? !!ed.ruler : ed.tool === b.dataset.tool;
      b.classList.toggle('selected', on);
      b.setAttribute('aria-pressed', String(on));
      b.disabled = !has;
    }
    this.btnPen._bar.style.background = ed.pen.color;
    this.btnHl._bar.style.background = ed.hl.color;
    for (const [b, name] of [[this.btnPen, t('pen')], [this.btnHl, t('highlighter')], [this.btnEraser, t('eraser')]]) {
      b.dataset.tip = ed.tool === b.dataset.tool ? t('toolTipAgain', { name }) : name;
    }
    const cropping = !!ed.crop;
    this.inkGroup.hidden = cropping;
    this.cropGroup.hidden = !cropping;
    this.zoomLabel.textContent = `${Math.round(ed.zoom * 100)}%`;
    for (const b of [this.btnZoom, this.btnSave, this.btnCopy, this.btnPaint]) b.disabled = !has;
    this.btnPaint.hidden = !this.ctx.shell.registry?.get?.('paint');
    this.root?.classList.toggle('cropping', cropping);
    // A focused button that just got disabled (or hidden) drops the keyboard focus to <body>, where the
    // window shortcuts (Ctrl+Y…) no longer arrive: hand it to the canvas instead.
    const a = document.activeElement;
    if (a && this.win.el.contains(a) && (a.disabled || !a.offsetParent) && this.view === 'editor') this.editor.el.focus({ preventScroll: true });
    else if ((!a || a === document.body) && this.view === 'editor' && this.win.isFocused?.() && !this.hidden) this.editor.el.focus({ preventScroll: true });
    this.layoutToolbar();
  }

  // ------------------------------------------------------------------ views
  applyView(v, { size = true, animate = true } = {}) {
    const { win } = this;
    this.view = v;
    if (this.root) this.root.dataset.view = v;
    win.el.classList.toggle('snip-compact', v === 'compact');
    win.el.classList.toggle('snip-editing', v === 'editor');
    const compact = v === 'compact';
    if (compact && (win.isMaximized() || win.isSnapped())) win.restore();
    win.opts.resizable = !compact;
    win.opts.maximizable = !compact;
    win.opts.minWidth = compact ? 440 : v === 'editor' ? EDITOR_MIN.w : 480;
    win.opts.minHeight = compact ? 150 : v === 'editor' ? EDITOR_MIN.h : 420;
    this.left.hidden = v === 'settings';
    this.setHead.hidden = v !== 'settings';
    this.editActions.hidden = v !== 'editor';
    this.tools.hidden = v !== 'editor';
    if (v !== 'editor') {
      this.closeFlyout();
      if (this.editor.crop) this.editor.cancelCrop();
    }
    if (size) this.sizeWindow(v, animate);
    this.updateUI();
    if (v === 'editor' && this.editor.fitMode) requestAnimationFrame(() => this.editor.fit());
  }

  sizeWindow(v, animate) {
    const { win } = this;
    if (win.isMaximized() || win.isSnapped()) return;
    const wa = wm.workarea();
    const cur = win.rect();
    const cx = cur.x + cur.width / 2;
    const place = (w, hgt, center) => {
      w = Math.round(Math.min(w, wa.width));
      hgt = Math.round(Math.min(hgt, wa.height));
      let x = center ? wa.x + (wa.width - w) / 2 : cx - w / 2;
      let y = center ? wa.y + (wa.height - hgt) / 2 : cur.y;
      x = Math.max(wa.x, Math.min(wa.x + wa.width - w, x));
      y = Math.max(wa.y, Math.min(wa.y + wa.height - hgt, y));
      win.setRect({ x, y, width: w, height: hgt }, animate && !this.hidden && !reduceMotion());
    };
    if (v === 'compact') place(COMPACT.w, COMPACT.h, false);
    else if (v === 'settings') place(Math.max(cur.width, 680), Math.max(cur.height, Math.min(720, wa.height * 0.85)), false);
    else if (v === 'editor') {
      const dpr = window.devicePixelRatio || 1;
      const maxW = Math.min(wa.width, window.innerWidth * 0.8);
      const maxH = Math.min(wa.height, window.innerHeight * 0.8);
      const imgW = this.editor.W / dpr;
      const imgH = this.editor.H / dpr;
      const chrome = 44 + 2;
      const w = Math.max(Math.min(EDITOR_PREF.w, maxW), Math.min(maxW, imgW + 50));
      const hgt = Math.max(Math.min(EDITOR_PREF.h, maxH), Math.min(maxH, imgH + 50 + chrome + 48));
      place(Math.max(EDITOR_MIN.w, w), Math.max(EDITOR_MIN.h, hgt), true);
    }
  }

  layoutToolbar() {
    if (!this.tb || this.closed) return;
    const tb = this.tb;
    const slot = this.win.titlebarSlot;
    const avail = slot.clientWidth;
    if (!avail) return;
    tb.classList.remove('narrow', 'narrower');
    const editor = this.view === 'editor';
    let inline = true;
    if (editor) {
      const need = this.left.offsetWidth + this.tools.offsetWidth + this.right.offsetWidth + 40;
      inline = need <= avail;
    }
    if (inline && this.tools.parentNode !== tb) tb.insertBefore(this.tools, this.right);
    else if (!inline && this.tools.parentNode !== this.toolrow) this.toolrow.appendChild(this.tools);
    this.root.classList.toggle('has-toolrow', editor && !inline);
    // Narrow windows: drop the text labels (they stay in the tooltips), then the New label.
    const fits = () => this.left.offsetWidth + this.setHead.offsetWidth + this.right.offsetWidth + (inline && editor ? this.tools.offsetWidth + 24 : 0) + 12 <= avail;
    if (!fits()) {
      tb.classList.add('narrow');
      if (!fits()) tb.classList.add('narrower');
    }
  }

  openSettings() {
    if (this.view === 'settings') return;
    this.prevView = this.view;
    this.prevRect = this.win.isMaximized() ? null : this.win.rect();
    this.applyView('settings');
    this.settingsEl.scrollTop = 0;
    if (this.hidden) this.showWindow();
    this.settingsEl.focus({ preventScroll: true });
  }
  closeSettings() {
    const back = this.prevView && this.prevView !== 'settings' ? this.prevView : this.editor.hasImage ? 'editor' : 'compact';
    const rect = this.prevRect;
    this.applyView(back, { size: !rect || back === 'compact' });
    if (rect && back !== 'compact' && !this.win.isMaximized()) this.win.setRect(rect, !reduceMotion());
    this.prevView = null;
    this.prevRect = null;
  }

  // ------------------------------------------------------------------ menus
  /** Open a menu from a button; when it closes the keyboard goes back to that button (Windows behaviour). */
  menuFrom(e, items) {
    const btn = e?.currentTarget;
    return this.ctx.ui.menu(e, items).then((v) => {
      const a = document.activeElement;
      if (btn?.isConnected && !this.hidden && !this.closed && (!a || a === document.body)) btn.focus({ preventScroll: true });
      return v;
    });
  }
  modeMenu(e) {
    const t = this.t;
    return this.menuFrom(
      e,
      MODES.map((m) => ({ label: t(`modes.${m}`), icon: MODE_ICONS[m], checked: this.prefs.mode === m, action: () => this.setMode(m) })),
    );
  }
  delayMenu(e) {
    const t = this.t;
    return this.menuFrom(
      e,
      DELAYS.map((d) => ({ label: d ? t('delaySeconds', { n: d }) : t('noDelay'), checked: this.prefs.delay === d, action: () => this.setDelay(d) })),
    );
  }
  zoomMenu(e) {
    const t = this.t;
    const ed = this.editor;
    return this.menuFrom(e, [
      { header: t('zoomLevel', { p: Math.round(ed.zoom * 100) }) },
      { label: t('zoomIn'), icon: 'zoom_in', shortcut: 'Ctrl++', action: () => ed.zoomIn() },
      { label: t('zoomOut'), icon: 'zoom_out', shortcut: 'Ctrl+-', action: () => ed.zoomOut() },
      { label: t('actualSize'), icon: 'ratio_one_to_one', shortcut: 'Ctrl+0', action: () => ed.setZoom(1) },
      { label: t('fit'), icon: 'zoom_fit', checked: ed.fitMode, action: () => ed.fit() },
    ]);
  }
  moreMenu(e) {
    const t = this.t;
    const editing = this.view === 'editor' && this.editor.hasImage;
    return this.menuFrom(e, [
      { label: t('openFile'), icon: 'folder_open', shortcut: 'Ctrl+O', action: () => this.openFileDialog() },
      { label: t('openFolder'), icon: 'folder', action: () => this.openScreenshotsFolder() },
      editing ? { label: t('paint'), icon: 'paint_brush', action: () => this.editInPaint(), hidden: !this.ctx.shell.registry?.get?.('paint') } : null,
      '-',
      { label: t('settings'), icon: 'settings', action: () => this.openSettings() },
      { label: t('about'), icon: 'info', action: () => this.about() },
    ].filter(Boolean));
  }

  about() {
    const { h, ui, appUrl, env } = this.ctx;
    const t = this.t;
    const body = h(
      'div',
      { class: 'snip-about' },
      h('img', { src: appUrl('icon.svg'), alt: '', width: 56, height: 56 }),
      h(
        'div',
        null,
        h('div', { class: 'subtitle' }, this.ctx.i18n.name(this.ctx.manifest.name)),
        h('div', { class: 'caption text-2' }, t('version', { v: env?.version || '1.0' })),
        h('p', { class: 'snip-about-desc' }, t('aboutDesc')),
        h('div', { class: 'caption text-3' }, t('aboutLicense')),
      ),
    );
    return ui.dialog({ title: t('aboutTitle'), body, parent: this.dlgParent(), className: 'snip-about-dialog', buttons: [{ label: t('common.ok'), value: true, primary: true }] });
  }

  // ------------------------------------------------------------------ tool flyouts (pen / highlighter / eraser options)
  toolClick(tool, btn) {
    const ed = this.editor;
    if (!ed.hasImage) return;
    if (tool === 'crop') {
      if (ed.tool === 'crop') ed.cancelCrop();
      else ed.setTool('crop');
      return;
    }
    if (ed.tool === tool) {
      if (this.flyout?.tool === tool) this.closeFlyout();
      else this.openToolFlyout(tool, btn);
      return;
    }
    this.closeFlyout();
    ed.setTool(tool);
  }

  openToolFlyout(tool, anchor) {
    const { h, ui } = this.ctx;
    const t = this.t;
    const ed = this.editor;
    this.closeFlyout();
    if (ed.tool !== tool) ed.setTool(tool);
    const name = tool === 'pen' ? t('pen') : tool === 'hl' ? t('highlighter') : t('eraser');
    const fl = h('div', { class: 'app-snipping snip-flyout', role: 'dialog', 'aria-label': name, tabindex: '-1' });
    if (tool === 'eraser') {
      fl.append(
        h('div', { class: 'caption text-2 snip-fl-hint' }, t('eraserHint')),
        h(
          'button',
          {
            class: 'btn snip-erase-all',
            disabled: !ed.strokes.length,
            onclick: () => {
              ed.eraseAll();
              this.closeFlyout();
            },
          },
          this.ctx.icon('delete'),
          t('eraseAll'),
        ),
      );
    } else {
      const ink = tool === 'hl' ? ed.hl : ed.pen;
      const colors = tool === 'hl' ? HL_COLORS : PEN_COLORS;
      const grid = h('div', { class: ['snip-swatches', 'snip-fl-grid', tool === 'hl' && 'hl'], role: 'radiogroup', 'aria-label': t('colors') });
      const pick = (hex) => {
        ed.setInk(tool, { color: hex });
        for (const b of grid.children) {
          const on = b.dataset.color === hex;
          b.classList.toggle('selected', on);
          b.setAttribute('aria-checked', String(on));
          b.tabIndex = on ? 0 : -1;
        }
        this.updateUI();
        this.savePrefs();
        paintPreview();
      };
      for (const [cname, hex] of colors) {
        grid.appendChild(
          h('button', {
            class: ['snip-swatch', hex === ink.color && 'selected'],
            role: 'radio',
            tabindex: hex === ink.color ? '0' : '-1',
            'aria-checked': String(hex === ink.color),
            'aria-label': t(`colorNames.${cname}`),
            'data-tip': t(`colorNames.${cname}`),
            dataset: { color: hex },
            style: { background: hex },
            onclick: () => pick(hex),
          }),
        );
      }
      if (!colors.some(([, hex]) => hex === ink.color)) grid.firstChild.tabIndex = 0;
      grid.addEventListener('keydown', (e) => {
        const items = [...grid.children];
        const i = items.indexOf(document.activeElement);
        if (i < 0) return;
        const cols = 8;
        const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols }[e.key];
        if (!step) return;
        e.preventDefault();
        const n = items[(i + step + items.length) % items.length];
        n.focus();
        pick(n.dataset.color);
      });
      const [min, max] = tool === 'hl' ? [4, 40] : [1, 24];
      const val = h('span', { class: 'snip-set-val' }, String(ink.size));
      const preview = h('span', { class: 'snip-size-dot' });
      const paintPreview = () => {
        const d = Math.max(2, Math.min(28, ink.size));
        Object.assign(preview.style, { width: `${tool === 'hl' ? Math.max(4, d * 0.45) : d}px`, height: `${d}px`, background: ink.color, opacity: tool === 'hl' ? 0.7 : 1 });
      };
      const slider = ui.slider({
        min,
        max,
        value: ink.size,
        oninput: (v) => {
          ed.setInk(tool, { size: v });
          val.textContent = String(v);
          paintPreview();
          this.savePrefs();
        },
      });
      slider.setAttribute('aria-label', t('size'));
      paintPreview();
      fl.append(h('div', { class: 'snip-fl-label' }, t('colors')), grid, h('div', { class: 'snip-fl-label' }, t('size')), h('div', { class: 'snip-fl-size' }, slider, h('span', { class: 'snip-size-box' }, preview), val));
    }
    document.body.appendChild(fl);
    const r = anchor.getBoundingClientRect();
    const fr = fl.getBoundingClientRect();
    const x = Math.max(4, Math.min(window.innerWidth - fr.width - 4, r.left + r.width / 2 - fr.width / 2));
    const y = Math.min(window.innerHeight - fr.height - 4, r.bottom + 6);
    fl.style.left = `${Math.round(x)}px`;
    fl.style.top = `${Math.round(y)}px`;
    const outside = (e) => {
      if (!fl.contains(e.target) && !anchor.contains(e.target)) this.closeFlyout();
    };
    const keys = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.closeFlyout();
        anchor.focus();
      } else if (e.ctrlKey) this.onKey(e); // window shortcuts (Ctrl+Z, Ctrl+S…) work from the flyout too
    };
    setTimeout(() => document.addEventListener('pointerdown', outside, true));
    fl.addEventListener('keydown', keys);
    const offWin = this.win.on('blur', () => this.closeFlyout());
    this.flyout = {
      el: fl,
      tool,
      close: () => {
        document.removeEventListener('pointerdown', outside, true);
        offWin?.();
        // The keyboard goes back to the tool button (or the canvas) instead of a vanishing flyout.
        if (fl.contains(document.activeElement)) {
          if (anchor.isConnected && !anchor.disabled && anchor.offsetParent) anchor.focus({ preventScroll: true });
          else this.editor.el.focus({ preventScroll: true });
        }
        fl.classList.add('closing');
        fl.inert = true;
        setTimeout(() => fl.remove(), 120);
      },
    };
    (fl.querySelector('.snip-swatch[tabindex="0"]') || fl.querySelector('button:not([disabled])') || fl).focus({ preventScroll: true });
  }
  closeFlyout() {
    const f = this.flyout;
    this.flyout = null;
    f?.close();
  }

  // ------------------------------------------------------------------ keyboard
  onKey(e) {
    if (e.defaultPrevented || this.closed) return;
    if (e.target.closest?.('.dialog-layer')) return;
    const inField = !!e.target.closest?.('input:not([type="range"]):not([type="checkbox"]), textarea, select, [contenteditable="true"]');
    const ctrl = e.ctrlKey && !e.altKey && !e.metaKey;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const run = (fn) => {
      e.preventDefault();
      e.stopPropagation();
      fn();
    };
    const ed = this.editor;
    if (ctrl && k === 'n') return run(() => this.newSnip({ source: 'app' }));
    if (ctrl && k === 'o') return run(() => this.openFileDialog());
    if (this.view === 'settings') {
      if ((e.altKey && e.key === 'ArrowLeft') || (e.key === 'Backspace' && !inField) || e.key === 'Escape') run(() => this.closeSettings());
      return;
    }
    if (this.view !== 'editor' || !ed.hasImage) return;
    if (ed.crop) {
      if (e.key === 'Enter') return run(() => ed.applyCrop());
      if (e.key === 'Escape') return run(() => ed.cancelCrop());
      const dir = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
      if (dir && !e.target.closest?.('button')) {
        const step = e.ctrlKey ? 10 : 1;
        return run(() => ed.nudgeCrop(dir[0] * step, dir[1] * step, e.shiftKey));
      }
    }
    if (ctrl && k === 's') return run(() => this.saveAs());
    if (ctrl && k === 'c' && !inField) return run(() => this.copy());
    if (ctrl && k === 'z' && !e.shiftKey) return run(() => ed.undo());
    if ((ctrl && k === 'y') || (ctrl && e.shiftKey && k === 'z')) return run(() => ed.redo());
    if (ctrl && (k === '=' || k === '+')) return run(() => ed.zoomIn());
    if (ctrl && (k === '-' || k === '_')) return run(() => ed.zoomOut());
    if (ctrl && k === '0') return run(() => ed.setZoom(1));
  }

  // ------------------------------------------------------------------ editor events
  onEditorChange(kind) {
    this.updateUI();
    if (kind === 'load') return;
    if (this.settings.autoCopy) {
      clearTimeout(this.copyTimer);
      this.copyTimer = setTimeout(() => this.copy({ quiet: true }), 600);
    }
  }

  // ------------------------------------------------------------------ snipping
  /** Start a snip: hide the window, optional delay, overlay, then the editor. */
  async newSnip({ mode = this.prefs.mode, delay = this.prefs.delay, source = 'app' } = {}) {
    if (this.session || this.closed) return;
    const { ctx } = this;
    const t = this.t;
    if (isLocked()) {
      if (this.shown && !this.hidden) this.alert(t('locked'));
      else if (!this.shown) this.win.close(true);
      return;
    }
    // From the app, unsaved edits are offered for saving before the window goes away.
    if (source === 'app' && this.shown && !this.hidden && !(await this.confirmDiscard())) return;
    if (this.session || this.closed) return;
    this.closeFlyout();
    ctx.ui.closeMenus();
    if (this.editor.crop) this.editor.cancelCrop();
    const wasFocused = wm.focused() === this.win;
    const wasHidden = this.hidden;
    // A window that was never shown also leaves the taskbar: give its button time to animate out.
    const settle = !this.shown || this.win.opts.skipTaskbar ? 260 : 40;
    this.hideWindow({ skipTaskbar: !this.shown });
    const session = new SnipSession({ api: ctx.api, h: ctx.h, icon: ctx.icon, t, mode, delay, exclude: this.win, onMode: (m) => this.setMode(m), settle });
    this.session = session;
    let res = null;
    let error = null;
    try {
      res = await session.run();
    } catch (err) {
      error = err;
      console.error('[snipping] capture failed', err);
    }
    if (this.session === session) this.session = null;
    if (this.closed) return;
    if (!res) {
      if (!this.shown) {
        // Launched only for this snip (PrintScreen): nothing to come back to.
        if (error) await ctx.ui.alert(t('captureFailed', { msg: error.message || '' }), { title: t('errorTitle') });
        this.win.close(true);
        return;
      }
      if (!wasHidden) this.showWindow({ focus: wasFocused, animate: false });
      if (error) this.alert(t('captureFailed', { msg: error.message || '' }));
      return;
    }
    await this.acceptSnip(res.canvas, { source });
  }

  async writeToScreenshots(bytes, time = new Date()) {
    const { api } = this.ctx;
    const dir = await this.screenshotsDir();
    await api.invoke('fs:mkdir', dir);
    const name = await api.invoke('fs:uniqueName', dir, `${this.t('fileBase')} ${stamp(time)}.png`);
    const path = `${dir}/${name}`;
    await api.invoke('fs:writeBytes', path, bytes);
    return path;
  }
  async picturesDir() {
    const x = this.ctx.shell.xdg || (await this.ctx.api.invoke('fs:xdg').catch(() => null));
    return x?.pictures || `${this.ctx.env?.home || ''}/Pictures`;
  }
  async screenshotsDir() {
    return `${(await this.picturesDir()).replace(/\/$/, '')}/Screenshots`;
  }

  /** Post-capture pipeline: border, clipboard, auto-save, sound, editor and (for hotkey snips) the toast. */
  async acceptSnip(canvas, { source = 'app' } = {}) {
    const { api, shell } = this.ctx;
    const t = this.t;
    if (this.settings.border) canvas = withBorder(canvas, this.settings.borderColor, this.settings.borderWidth);
    const time = new Date();
    const errors = [];
    let bytes = null;
    try {
      bytes = await canvasBytes(canvas);
    } catch (err) {
      errors.push(t('captureFailed', { msg: err.message || '' }));
    }
    const snip = { id: ++snipSeq, time, savedPath: null, bytes: null };
    let copied = false;
    if (bytes && this.settings.autoCopy) {
      try {
        await writeClipboardImage(api, bytes);
        copied = true;
      } catch (err) {
        errors.push(t('copyFailed', { msg: err.message || '' }));
      }
    }
    if (bytes && this.settings.autoSave) {
      try {
        snip.savedPath = await this.writeToScreenshots(bytes, time);
      } catch (err) {
        errors.push(t('autoSaveFailed', { msg: err.message || '' }));
      }
    }
    if (!snip.savedPath) snip.bytes = bytes;
    remember(snip);
    sounds.play('screenshot');
    if (this.closed) return;

    // Unsaved edits of the snip already in the editor: offer to save them first.
    let replace = true;
    if (this.needsSave()) {
      this.applyView('editor', { size: false });
      this.showWindow();
      replace = await this.confirmDiscard();
    }
    if (replace) this.loadSnip(canvas, snip);
    const wasShown = !this.hidden;
    if (!wasShown) this.applyView('editor', { animate: false });
    else this.applyView('editor');
    this.showWindow();
    if (source === 'hotkey') {
      const title = copied ? t('toastCopied') : snip.savedPath ? t('toastSaved') : t('toastTaken');
      shell.notify({ appId: 'snipping', title, body: t('toastBody'), onClick: () => shell.launch('snipping', { snip: snip.id }) });
    }
    if (errors.length) this.alert(errors.join('\n'));
    return snip;
  }

  loadSnip(canvas, snip) {
    this.snip = snip;
    this.editor.load(canvas, { saved: !!snip.savedPath });
    this.updateUI();
  }

  async openSnipById(id) {
    const snip = recent.get(Number(id));
    if (this.session) return;
    if (!snip) {
      if (this.hidden) {
        this.applyView(this.editor.hasImage ? 'editor' : 'compact', { animate: false });
        this.showWindow();
      }
      return;
    }
    if (this.snip?.id === snip.id && this.editor.hasImage) {
      if (this.view !== 'editor') this.applyView('editor', { animate: !this.hidden });
      this.showWindow();
      return;
    }
    if (!this.hidden && !(await this.confirmDiscard())) return;
    let canvas;
    try {
      canvas = await bytesToCanvas(snip.bytes || (await this.ctx.api.invoke('fs:readBytes', snip.savedPath)));
    } catch (err) {
      if (this.hidden && !this.editor.hasImage) this.applyView('compact', { size: false });
      this.showWindow();
      this.alert(this.t('openFailed', { msg: err.message || '' }));
      return;
    }
    const wasHidden = this.hidden;
    this.loadSnip(canvas, snip);
    this.applyView('editor', { animate: !wasHidden });
    this.showWindow();
  }

  async openFileDialog() {
    const { ui } = this.ctx;
    const t = this.t;
    const dir = await this.screenshotsDir();
    const exists = await this.ctx.api.invoke('fs:exists', dir).catch(() => false);
    const path = await ui.filePicker({ mode: 'open', title: t('openFile'), filters: [{ name: t('images'), ext: IMAGE_EXTS }], path: exists ? dir : await this.picturesDir(), parent: this.dlgParent() });
    if (path) await this.openPath(Array.isArray(path) ? path[0] : path);
  }

  async openPath(path) {
    const t = this.t;
    let canvas;
    try {
      canvas = await bytesToCanvas(await this.ctx.api.invoke('fs:readBytes', path));
    } catch (err) {
      if (this.hidden) {
        this.applyView(this.editor.hasImage ? 'editor' : 'compact', { size: false });
        this.showWindow();
      }
      this.alert(t('openFailed', { msg: err.message || '' }));
      return false;
    }
    if (!this.hidden && !(await this.confirmDiscard())) return false;
    const wasHidden = this.hidden;
    this.loadSnip(canvas, { id: ++snipSeq, time: new Date(), savedPath: path, bytes: null });
    this.applyView('editor', { animate: !wasHidden });
    this.showWindow();
    return true;
  }

  async openScreenshotsFolder() {
    const dir = await this.screenshotsDir();
    await this.ctx.api.invoke('fs:mkdir', dir).catch(() => {});
    this.ctx.shell.openFile(dir);
  }

  // ------------------------------------------------------------------ save / copy / paint
  needsSave() {
    return this.settings.askSave && this.editor.hasImage && this.editor.isEdited() && this.editor.isDirty();
  }
  /** Ask to save edited snips (Save / Don't save / Cancel). Resolves true when it is OK to go on. */
  async confirmDiscard() {
    if (!this.needsSave()) return true;
    const { ui } = this.ctx;
    const t = this.t;
    if (this.hidden) this.showWindow();
    const v = await ui.dialog({
      title: this.ctx.i18n.name(this.ctx.manifest.name),
      body: t('askSaveBody'),
      parent: this.dlgParent(),
      buttons: [
        { label: t('common.save'), value: 'save', primary: true },
        { label: t('common.dontSave'), value: 'discard' },
        { label: t('common.cancel'), value: null },
      ],
    });
    if (v === 'save') return !!(await this.saveAs());
    return v === 'discard';
  }

  async saveAs() {
    const { ui, api } = this.ctx;
    const t = this.t;
    const ed = this.editor;
    if (!ed.hasImage) return null;
    if (ed.crop) ed.cancelCrop();
    const prev = this.snip?.savedPath;
    let dir = prev ? dirName(prev) : await this.screenshotsDir();
    if (!(await api.invoke('fs:exists', dir).catch(() => false))) dir = await this.picturesDir();
    const stem = prev ? baseName(prev).replace(/\.[^.]+$/, '') : `${t('fileBase')} ${stamp(this.snip?.time || new Date())}`;
    const path = await ui.filePicker({
      mode: 'save',
      filters: [
        { name: t('pngImage'), ext: ['.png'] },
        { name: t('jpegImage'), ext: ['.jpg', '.jpeg'] },
      ],
      path: dir,
      name: stem,
      parent: this.dlgParent(),
    });
    if (!path || this.closed) return null;
    const jpeg = /\.jpe?g$/i.test(path);
    try {
      const bytes = await canvasBytes(ed.render(), jpeg ? 'image/jpeg' : 'image/png');
      await api.invoke('fs:writeBytes', path, bytes);
    } catch (err) {
      await this.alert(t('saveFailed', { msg: err.message || '' }));
      return null;
    }
    ed.markSaved();
    if (this.snip) this.snip.savedPath = path;
    this.flash(t('saved', { name: baseName(path) }));
    this.updateUI();
    return path;
  }

  async copy({ quiet = false } = {}) {
    const ed = this.editor;
    if (!ed.hasImage || this.closed) return false;
    try {
      const bytes = await canvasBytes(ed.render());
      await writeClipboardImage(this.ctx.api, bytes);
      if (!quiet) this.flash(this.t('copied'));
      return true;
    } catch (err) {
      if (!quiet) this.alert(this.t('copyFailed', { msg: err.message || '' }));
      else console.warn('[snipping] auto-copy failed', err);
      return false;
    }
  }

  async editInPaint() {
    const { shell } = this.ctx;
    const t = this.t;
    const ed = this.editor;
    if (!ed.hasImage) return;
    if (!shell.registry?.get?.('paint')) return this.alert(t('paintMissing'));
    let path = this.snip?.savedPath;
    if (!path || ed.isDirty() || !/\.png$/i.test(path)) {
      try {
        path = await this.writeToScreenshots(await canvasBytes(ed.render()), new Date());
      } catch (err) {
        return this.alert(t('saveFailed', { msg: err.message || '' }));
      }
      ed.markSaved();
      if (this.snip) this.snip.savedPath = path;
      this.updateUI();
    }
    return shell.launch('paint', { file: path });
  }

  flash(text) {
    if (!this.flashEl) return;
    this.flashEl.textContent = text;
    this.flashEl.classList.add('show');
    clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => this.flashEl?.classList.remove('show'), 1800);
  }
}
