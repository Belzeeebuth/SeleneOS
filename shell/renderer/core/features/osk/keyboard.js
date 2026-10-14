// « Clavier visuel » — the on-screen keyboard panel: keys, modifier state, dead keys, key repeat, press feedback,
// move / resize. It never takes the keyboard focus: every pointer event on it is handled at the window's capture
// phase and cancelled (no focus change, no "click outside" closing the Lanceur or a menu), so the field being typed
// into keeps the focus. What a key does is handed to opts.deliver(); the desktop (core/features/osk.js) sends real
// key events from the main process or through XTest, the sign-in screen (core/greeter/greeter.js) edits its own fields.
//
//   const kb = new OnScreenKeyboard({
//     layout: 'fr',                          // LAYOUTS id (osk/layouts.js)
//     deliver(ev),                           // see below
//     sound: () => bool,                     // play a key click for this press (false for password fields)
//     chrome: { close(), settings() | null, dock() | null, move: bool, resize: bool },
//     mode: 'docked' | 'floating', size: 'small' | 'medium' | 'large', rect: { x, y, width } (floating),
//     onGeometry({ x, y, width }),           // the user moved / resized the floating keyboard
//     bottom: () => px,                      // docked: distance from the bottom edge (above the bar)
//   });
//   host.append(kb.el); kb.show(); kb.hide(); kb.visible; kb.setLayout(id); kb.setMode(m); kb.setSize(s); kb.reset()
//   kb.state -> { page, shift, caps, altgr, ctrl, alt, super, dead }   (0 off, 1 once, 2 locked)
//   kb.press(id) / kb.keyFor(ch) -> id   test hooks (a press without the pointer; the key that types ch now)
//
// deliver(ev) receives:
//   { type: 'text', text, mods: { ctrl, alt, super } }       a character (dead keys already composed); with mods it is
//                                                            a shortcut (Ctrl+C: text 'c'; digits on AZERTY: '1'…)
//   { type: 'key', key, mods: { ctrl, alt, super, shift } }  Enter Backspace Tab Escape Delete Home End PageUp PageDown
//                                                            ArrowLeft ArrowRight ArrowUp ArrowDown
//   { type: 'super' }                                        Super pressed and released alone (opens the Lanceur)
//   { type: 'hold', mods: { ctrl, alt } }                    locked modifiers: the target holds them down until released
// Every event also carries `repeat: true` when it comes from a held key.
import { h, icon } from '../../ui.js';
import { i18n, t } from '../../i18n.js';
import { LAYOUTS, PAGES, DEAD, output, isDead, compose, deadSpacing, isLetter, deadName } from './layouts.js';

const STRINGS = {
  en: {
    osk: {
      title: 'On-screen keyboard',
      move: 'Move the keyboard',
      resize: 'Resize the keyboard',
      dock: 'Dock at the bottom of the screen',
      undock: 'Float the keyboard',
      settings: 'On-screen keyboard settings',
      close: 'Close the on-screen keyboard',
      locked: '{key} (locked)',
      dead: '{key} (dead key)',
      k: {
        Escape: 'Esc', Backspace: '', Tab: 'Tab', Caps: 'Caps', Enter: 'Enter', Shift: 'Shift', Ctrl: 'Ctrl', Super: 'Super', Alt: 'Alt', AltGr: 'Alt Gr',
        Space: 'Space', Home: 'Home', End: 'End', Delete: 'Del', PageUp: 'PgUp', PageDown: 'PgDn', sym: '&123', acc: 'àéç', abc: 'ABC',
      },
      name: {
        Escape: 'Escape', Backspace: 'Backspace', Tab: 'Tab', Caps: 'Caps Lock', Enter: 'Enter', Shift: 'Shift', Ctrl: 'Control', Super: 'Super (press twice for the Launcher)',
        Alt: 'Alt', AltGr: 'Alt Gr', Space: 'Space', Home: 'Home', End: 'End', Delete: 'Delete', PageUp: 'Page up', PageDown: 'Page down',
        ArrowLeft: 'Left arrow', ArrowRight: 'Right arrow', ArrowUp: 'Up arrow', ArrowDown: 'Down arrow', sym: 'Numbers and symbols', acc: 'Accented letters', abc: 'Letters',
      },
      deadName: { circumflex: 'circumflex', diaeresis: 'diaeresis', grave: 'grave accent', acute: 'acute accent', tilde: 'tilde', cedilla: 'cedilla', abovering: 'ring', caron: 'caron', macron: 'macron', breve: 'breve', ogonek: 'ogonek', doubleacute: 'double acute' },
    },
  },
  fr: {
    osk: {
      title: 'Clavier visuel',
      move: 'Déplacer le clavier',
      resize: 'Redimensionner le clavier',
      dock: 'Ancrer en bas de l’écran',
      undock: 'Détacher le clavier',
      settings: 'Paramètres du clavier visuel',
      close: 'Fermer le clavier visuel',
      locked: '{key} (verrouillée)',
      dead: '{key} (touche morte)',
      k: {
        Escape: 'Échap', Backspace: '', Tab: 'Tab', Caps: 'Verr. maj', Enter: 'Entrée', Shift: 'Maj', Ctrl: 'Ctrl', Super: 'Super', Alt: 'Alt', AltGr: 'Alt Gr',
        Space: 'Espace', Home: 'Début', End: 'Fin', Delete: 'Suppr', PageUp: 'Pg ↑', PageDown: 'Pg ↓', sym: '&123', acc: 'àéç', abc: 'ABC',
      },
      name: {
        Escape: 'Échap', Backspace: 'Retour arrière', Tab: 'Tabulation', Caps: 'Verrouillage des majuscules', Enter: 'Entrée', Shift: 'Majuscule', Ctrl: 'Contrôle',
        Super: 'Super (deux fois pour le Lanceur)', Alt: 'Alt', AltGr: 'Alt Gr', Space: 'Espace', Home: 'Origine', End: 'Fin', Delete: 'Supprimer', PageUp: 'Page précédente',
        PageDown: 'Page suivante', ArrowLeft: 'Flèche gauche', ArrowRight: 'Flèche droite', ArrowUp: 'Flèche haut', ArrowDown: 'Flèche bas', sym: 'Chiffres et symboles',
        acc: 'Lettres accentuées', abc: 'Lettres',
      },
      deadName: { circumflex: 'accent circonflexe', diaeresis: 'tréma', grave: 'accent grave', acute: 'accent aigu', tilde: 'tilde', cedilla: 'cédille', abovering: 'rond en chef', caron: 'caron', macron: 'macron', breve: 'brève', ogonek: 'ogonek', doubleacute: 'double accent aigu' },
    },
  },
};
i18n.extend(STRINGS); // at import: the sign-in screen's menu names the keyboard before one exists

// Geometry: the main block is 16 units wide (64 grid columns of a quarter unit), plus a 1-unit column on the right.
const MODS = ['Shift', 'ShiftR', 'Caps', 'AltGr', 'Ctrl', 'Alt', 'Super'];
const NAV = { Home: 'Home', End: 'End', Delete: 'Delete', PageUp: 'PageUp', PageDown: 'PageDown', Escape: 'Escape', Backspace: 'Backspace', Tab: 'Tab', Enter: 'Enter', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight', ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown' };
const ICONS = { Backspace: 'backspace', Enter: 'arrow-elbow-down-left', Shift: 'arrow-fat-up', ShiftR: 'arrow-fat-up', Caps: 'keyboard_shift_uppercase', ArrowLeft: 'arrow-left', ArrowRight: 'arrow-right', ArrowUp: 'arrow-up', ArrowDown: 'arrow-down' };
const WIDTHS = { small: 760, medium: 980, large: 1240 };
const REPEAT_DELAY = 480;
const REPEAT_EVERY = 60;
const NO_REPEAT = new Set(['Page', 'Enter', 'Escape', 'Tab', ...MODS]);

function rowsOf(L, page) {
  const P = page === 'main' ? L : PAGES[page];
  const chars = (row, list) => list.map((levels, i) => ({ id: `${row}-${i}`, levels }));
  const r3 = chars('r3', P.r3);
  const shiftL = r3.length >= 11 ? 1.25 : 2.25;
  return [
    [{ id: 'Escape', w: 1 }, ...chars('r0', P.r0), { id: 'Backspace', w: 2 }],
    [{ id: 'Tab', w: 1.5 }, ...chars('r1', P.r1), { id: 'r1-x', levels: P.r1x, w: 1.5 }],
    [{ id: 'Caps', w: 1.75 }, ...chars('r2', P.r2), { id: 'Enter', w: 3.25 }],
    [{ id: 'Shift', w: shiftL }, ...r3, { id: 'ShiftR', w: 1.75 }, { id: 'ArrowUp', w: 1 }, { spacer: true, w: 1 }],
    [{ id: 'Ctrl', w: 1.5 }, { id: 'Super', w: 1.25 }, { id: 'Alt', w: 1.25 }, { id: 'Page', w: 1.5 }, { id: 'Space', w: 6.25 }, { id: L.noAltGr ? 'CtrlR' : 'AltGr', w: 1.25 }, { id: 'ArrowLeft', w: 1 }, { id: 'ArrowDown', w: 1 }, { id: 'ArrowRight', w: 1 }],
  ];
}
const SIDE = ['Home', 'End', 'Delete', 'PageUp', 'PageDown'];
export const OSK_CSS = 'app://shell/core/features/osk.css';

/** Resolves once osk.css is applied (ui.loadCss has added it): no unstyled keyboard flashes on screen. */
export function cssReady() {
  const link = document.querySelector(`link[data-href="${OSK_CSS}"]`);
  if (!link || link.sheet) return Promise.resolve();
  return new Promise((res) => {
    link.addEventListener('load', res, { once: true });
    link.addEventListener('error', res, { once: true });
    setTimeout(res, 2000);
  });
}

let audioCtx = null;
function click() {
  try {
    audioCtx = audioCtx || new AudioContext();
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    const t0 = audioCtx.currentTime;
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = 'triangle';
    o.frequency.setValueAtTime(1700, t0);
    o.frequency.exponentialRampToValueAtTime(900, t0 + 0.03);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.07, t0 + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.045);
    o.connect(g).connect(audioCtx.destination);
    o.start(t0);
    o.stop(t0 + 0.06);
  } catch {}
}

export class OnScreenKeyboard {
  constructor(opts = {}) {
    this.o = opts;
    this.layoutId = LAYOUTS[opts.layout] ? opts.layout : 'us';
    this.mode = opts.mode === 'floating' ? 'floating' : 'docked';
    this.size = WIDTHS[opts.size] ? opts.size : 'medium';
    this.rect = opts.rect && typeof opts.rect === 'object' ? { ...opts.rect } : null;
    this.state = { page: 'main', shift: 0, caps: false, altgr: 0, ctrl: 0, alt: 0, super: 0, dead: null };
    this.visible = false;
    this.keys = new Map(); // id -> { el, spec }
    this.down = null; // { id, el, ev, timer, pointerId }
    this.drag = null;
    this.el = h('div', { class: 'osk', role: 'group', hidden: true, 'data-theme-scope': opts.themeScope ? '' : null, 'data-theme': opts.themeScope || null });
    this.bar = h('div', { class: 'osk-bar' });
    this.mainEl = h('div', { class: 'osk-main' });
    this.sideEl = h('div', { class: 'osk-side' });
    this.el.append(this.bar, h('div', { class: 'osk-body' }, this.mainEl, this.sideEl), h('div', { class: 'osk-resize', 'data-act': 'resize', 'aria-hidden': 'true' }));
    if (opts.className) this.el.classList.add(...String(opts.className).split(/\s+/).filter(Boolean));
    this._onPointer = (e) => this._pointer(e);
    this._onResize = () => this.visible && this._place();
    for (const type of ['pointerdown', 'pointerup', 'pointercancel', 'pointermove', 'mousedown', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu', 'touchstart', 'touchend', 'lostpointercapture']) {
      window.addEventListener(type, this._onPointer, { capture: true, passive: false });
    }
    window.addEventListener('resize', this._onResize);
    this._langOff = i18n.on?.('change', () => this.render());
    this.render();
  }

  // ---------------------------------------------------------------- building
  get layout() {
    return LAYOUTS[this.layoutId] || LAYOUTS.us;
  }
  setLayout(id) {
    const next = LAYOUTS[id] ? id : 'us';
    if (next === this.layoutId) return;
    this.layoutId = next;
    this.state.dead = null;
    this.render();
  }
  setMode(mode) {
    this.mode = mode === 'floating' ? 'floating' : 'docked';
    this.render();
  }
  setSize(size) {
    this.size = WIDTHS[size] ? size : 'medium';
    if (this.mode === 'docked' || !this.rect) this._place();
    else this.render();
  }
  setRect(rect) {
    this.rect = rect && typeof rect === 'object' ? { ...rect } : null;
    this._place();
  }

  render() {
    const L = this.layout;
    this.el.setAttribute('aria-label', t('osk.title'));
    this.el.classList.toggle('osk-docked', this.mode === 'docked');
    this.el.classList.toggle('osk-floating', this.mode === 'floating');
    this.el.dataset.layout = L.id;
    // tool bar
    const c = this.o.chrome || {};
    const btn = (act, ic, label) => h('button', { type: 'button', tabindex: '-1', class: ['osk-tb', `osk-${act}`], 'data-act': act, 'aria-label': label, 'data-tip': label }, icon(ic, { size: 16 }));
    this.bar.replaceChildren(
      h('div', { class: 'osk-grip', 'data-act': c.move === false ? null : 'move', 'aria-label': c.move === false ? null : t('osk.move') }, c.move === false ? null : icon('dots-six-vertical', { size: 16 }), h('span', { class: 'osk-title' }, t('osk.title'))),
      h('div', { class: 'osk-bar-btns' }, c.dock ? btn('dock', this.mode === 'docked' ? 'push-pin-slash' : 'push-pin', this.mode === 'docked' ? t('osk.undock') : t('osk.dock')) : null, c.settings ? btn('settings', 'gear-six', t('osk.settings')) : null, c.close ? btn('close', 'x', t('osk.close')) : null),
    );
    // keys
    this.keys.clear();
    const rows = rowsOf(L, this.state.page);
    this.mainEl.replaceChildren(
      ...rows.map((row) =>
        h(
          'div',
          { class: 'osk-row' },
          row.map((spec) => {
            const span = Math.round((spec.w || 1) * 4);
            if (spec.spacer) return h('span', { class: 'osk-spacer', style: { gridColumn: `span ${span}` } });
            return this._keyEl(spec, span);
          }),
        ),
      ),
    );
    this.sideEl.replaceChildren(...SIDE.map((id) => this._keyEl({ id }, 4)));
    this.refresh();
    this._place();
  }

  _keyEl(spec, span) {
    const el = h('button', { type: 'button', tabindex: '-1', class: 'osk-key', 'data-k': spec.id, style: { gridColumn: `span ${span}` } });
    if (spec.levels) el.classList.add('osk-char');
    else el.classList.add('osk-fn', `osk-k-${spec.id}`);
    if (MODS.includes(spec.id) || spec.id === 'CtrlR') el.classList.add('osk-mod');
    this.keys.set(spec.id, { el, spec });
    return el;
  }

  /** Labels and pressed states for the current modifier state (and the pending dead key's previews). */
  refresh() {
    const s = this.state;
    const st = { shift: s.shift > 0, caps: s.caps, altgr: s.altgr > 0 };
    const page = s.page;
    for (const [id, { el, spec }] of this.keys) {
      if (spec.levels) {
        const v = output(spec.levels, st);
        let main = v == null ? '' : isDead(v) ? deadSpacing(v) : v;
        let label = main;
        if (s.dead && v != null && !isDead(v)) {
          const c = compose(s.dead, v);
          if (c) main = label = c;
        }
        if (isDead(v)) label = t('osk.dead', { key: t(`osk.deadName.${deadName(v)}`) });
        if (main === ' ' || main === ' ') main = '⍽';
        const hints = [];
        if (page === 'main') {
          const L = spec.levels;
          const shown = (x) => (x == null ? '' : isDead(x) ? deadSpacing(x) : x);
          if (!st.shift && !st.altgr && L[1] != null && !(isLetter(L[0]) && L[1] === L[0].toLocaleUpperCase())) hints.push(h('span', { class: 'k-sh' }, shown(L[1])));
          if (!st.altgr && L[2] != null && !this.layout.noAltGr) hints.push(h('span', { class: 'k-alt' }, shown(L[st.shift ? 3 : 2] ?? L[2])));
        }
        el.replaceChildren(h('span', { class: 'k-main' }, main), ...hints);
        el.classList.toggle('osk-dead', isDead(v));
        el.classList.toggle('osk-empty', v == null);
        el.dataset.out = v == null ? '' : v;
        el.setAttribute('aria-label', label || ' ');
        continue;
      }
      const name = id === 'ShiftR' ? 'Shift' : id === 'CtrlR' ? 'Ctrl' : id;
      if (id === 'Space') {
        el.replaceChildren(h('span', { class: 'k-space' }, this.layout.name[i18n.lang === 'fr' ? 'fr' : 'en']));
        el.setAttribute('aria-label', t('osk.name.Space'));
        continue;
      }
      if (id === 'Page') {
        const next = page === 'main' ? 'sym' : page === 'sym' ? 'acc' : 'abc';
        el.replaceChildren(h('span', { class: 'k-txt' }, t(`osk.k.${next}`)));
        el.setAttribute('aria-label', t(`osk.name.${next}`));
        continue;
      }
      const ic = ICONS[id];
      const txt = /^Arrow/.test(id) ? null : t(`osk.k.${name}`);
      el.replaceChildren(...[ic ? icon(ic, { size: 16 }) : null, txt ? h('span', { class: 'k-txt' }, txt) : null].filter(Boolean));
      let aria = t(`osk.name.${name}`);
      const lvl = this._modLevel(id);
      if (lvl != null) {
        el.setAttribute('aria-pressed', String(lvl > 0));
        el.classList.toggle('osk-on', lvl > 0);
        el.classList.toggle('osk-locked', lvl > 1);
        if (lvl > 1) aria = t('osk.locked', { key: aria });
      }
      el.setAttribute('aria-label', aria);
    }
    this.el.classList.toggle('osk-shifted', st.shift || st.caps);
  }

  _modLevel(id) {
    const s = this.state;
    switch (id) {
      case 'Shift':
      case 'ShiftR':
        return s.shift;
      case 'Caps':
        return s.caps ? 2 : 0;
      case 'AltGr':
        return s.altgr;
      case 'Ctrl':
      case 'CtrlR':
        return s.ctrl;
      case 'Alt':
        return s.alt;
      case 'Super':
        return s.super;
      default:
        return null;
    }
  }

  // ---------------------------------------------------------------- showing and placement
  show() {
    if (this.visible) return;
    this.visible = true;
    this.el.hidden = false;
    this._place();
    // slide in (the `translate` property composes with the docked keyboard's centring transform)
    if (document.documentElement.dataset.animations !== 'off') {
      this.el.animate([{ translate: '0 24px', opacity: 0 }, { translate: '0 0', opacity: 1 }], { duration: 220, easing: 'cubic-bezier(0.1, 0.9, 0.2, 1)' });
    }
  }
  hide() {
    if (!this.visible) return;
    this._release();
    this.reset();
    this.visible = false;
    this.el.hidden = true;
  }
  /** Back to letters, every modifier off (locked ones are released on the target). */
  reset() {
    const s = this.state;
    const held = s.ctrl === 2 || s.alt === 2;
    Object.assign(s, { page: 'main', shift: 0, caps: false, altgr: 0, ctrl: 0, alt: 0, super: 0, dead: null });
    if (held) this._send({ type: 'hold', mods: { ctrl: false, alt: false } });
    if (this.keys.size) this.refresh();
  }

  widthFor() {
    const vw = window.innerWidth;
    if (this.mode === 'floating' && this.rect?.width) return Math.max(480, Math.min(this.rect.width, vw - 16));
    return Math.max(320, Math.min(WIDTHS[this.size] || WIDTHS.medium, vw - 16));
  }
  _place() {
    const w = this.widthFor();
    // key height follows the width (17 units), within reason
    const kh = Math.round(Math.max(30, Math.min(72, (w / 17) * 0.8)));
    this.el.style.setProperty('--osk-w', `${w}px`);
    this.el.style.setProperty('--osk-kh', `${kh}px`);
    this.el.style.setProperty('--osk-fs', `${Math.round(Math.max(13, Math.min(22, kh * 0.4)))}px`);
    this.el.classList.toggle('osk-compact', w < 700);
    if (this.mode === 'docked') {
      this.el.style.left = '';
      this.el.style.top = '';
      this.el.style.bottom = `${Math.max(0, Number(this.o.bottom?.() ?? 0))}px`;
      return;
    }
    this.el.style.bottom = '';
    const r = this.el.getBoundingClientRect();
    const hgt = r.height || kh * 5 + 60;
    const x = this.rect?.x ?? (window.innerWidth - w) / 2;
    const y = this.rect?.y ?? window.innerHeight - hgt - 80;
    const cx = Math.round(Math.max(0, Math.min(x, window.innerWidth - Math.min(w, window.innerWidth))));
    const cy = Math.round(Math.max(0, Math.min(y, window.innerHeight - 40)));
    this.el.style.left = `${cx}px`;
    this.el.style.top = `${cy}px`;
  }

  // ---------------------------------------------------------------- pointer
  _pointer(e) {
    const inside = e.target instanceof Node && this.el.contains(e.target);
    if (this.drag && (e.type === 'pointermove' || e.type === 'pointerup' || e.type === 'pointercancel')) {
      if (e.pointerId !== this.drag.pointerId) return;
      e.preventDefault();
      e.stopPropagation();
      this._dragMove(e, e.type !== 'pointermove');
      return;
    }
    // a key held down ends with its pointer's release wherever it happens (the capture may have been lost meanwhile)
    if (this.down && e.pointerId === this.down.pointerId && (e.type === 'pointerup' || e.type === 'pointercancel' || (e.type === 'pointermove' && e.buttons === 0))) {
      if (!inside) return this._keyUp();
    }
    if (!inside) return;
    // Inside the keyboard: nobody else sees it, and the focus stays where it is.
    e.stopPropagation();
    if (e.cancelable && e.type !== 'pointermove' && e.type !== 'lostpointercapture') e.preventDefault();
    switch (e.type) {
      case 'pointerdown': {
        if (e.button !== 0 && e.pointerType === 'mouse') return;
        const key = e.target.closest('.osk-key');
        const act = e.target.closest('[data-act]')?.dataset.act;
        if (key) this._keyDown(key, e);
        else if (act === 'move' || act === 'resize') this._dragStart(act, e);
        else if (act) {
          this.pressedAct = { act, el: e.target.closest('[data-act]') };
          this.pressedAct.el.classList.add('osk-pressed');
        }
        break;
      }
      case 'pointerup':
      case 'pointercancel':
        if (this.down && e.pointerId === this.down.pointerId) this._keyUp();
        if (this.pressedAct) {
          const { act, el } = this.pressedAct;
          this.pressedAct = null;
          el.classList.remove('osk-pressed');
          if (e.type === 'pointerup' && el.contains(e.target)) this._act(act);
        }
        break;
      case 'pointermove':
        if (this.down && e.pointerId === this.down.pointerId && e.buttons === 0) this._keyUp();
        break;
      default:
        break;
    }
  }

  _act(act) {
    const c = this.o.chrome || {};
    if (act === 'close') c.close?.();
    else if (act === 'settings') c.settings?.();
    else if (act === 'dock') c.dock?.();
  }

  _dragStart(kind, e) {
    if (this.mode !== 'floating') {
      if (kind === 'resize') return;
      // dragging the docked keyboard's grip floats it where it is dropped
      if (!this.o.chrome?.dock) return;
    }
    for (const a of this.el.getAnimations()) a.finish(); // (the slide-in must not offset the drag)
    const r = this.el.getBoundingClientRect();
    this.drag = { kind, pointerId: e.pointerId, sx: e.clientX, sy: e.clientY, r, moved: false };
    try {
      this.el.setPointerCapture(e.pointerId);
    } catch {}
    this.el.classList.add('osk-dragging');
  }
  _dragMove(e, done) {
    const d = this.drag;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (!d.moved && Math.hypot(dx, dy) < 4) {
      if (done) this._dragEnd();
      return;
    }
    if (!d.moved) {
      d.moved = true;
      if (this.mode !== 'floating') {
        // undock in place
        this.rect = { x: d.r.left, y: d.r.top, width: d.r.width };
        this.o.chrome?.dock?.({ rect: this.rect });
        this.mode = 'floating';
        this.el.classList.add('osk-floating');
        this.el.classList.remove('osk-docked');
      }
    }
    if (d.kind === 'move') {
      this.rect = { ...(this.rect || {}), x: d.r.left + dx, y: d.r.top + dy, width: this.rect?.width || d.r.width };
    } else {
      this.rect = { x: d.r.left, y: d.r.top, width: Math.max(480, Math.min(window.innerWidth - d.r.left, d.r.width + dx)) };
    }
    this._place();
    this.o.onMove?.();
    if (done) this._dragEnd();
  }
  _dragEnd() {
    const d = this.drag;
    this.drag = null;
    this.el.classList.remove('osk-dragging');
    try {
      this.el.releasePointerCapture(d.pointerId);
    } catch {}
    if (d.moved && this.rect) {
      const r = this.el.getBoundingClientRect();
      this.rect = { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width) };
      this.o.onGeometry?.({ ...this.rect });
    }
  }

  // ---------------------------------------------------------------- keys
  _keyDown(el, e) {
    if (this.down) this._keyUp();
    const id = el.dataset.k;
    el.classList.add('osk-pressed');
    try {
      el.setPointerCapture(e.pointerId);
    } catch {}
    const ev = this._activate(id);
    this.down = { id, el, ev, pointerId: e.pointerId, timer: 0 };
    if (ev && !NO_REPEAT.has(id) && !ev.noRepeat) {
      this.down.timer = setTimeout(() => {
        const until = Date.now() + 60000;
        const tick = () => {
          if (!this.down || this.down.id !== id) return;
          if (Date.now() > until) return this._keyUp();
          this._send({ ...ev, repeat: true });
          this.down.timer = setTimeout(tick, REPEAT_EVERY);
        };
        tick();
      }, REPEAT_DELAY);
    }
  }
  _keyUp() {
    const d = this.down;
    if (!d) return;
    this.down = null;
    clearTimeout(d.timer);
    d.el.classList.remove('osk-pressed');
    if (d.ev) this._afterKey();
  }
  _release() {
    if (this.down) this._keyUp();
    if (this.drag) this._dragEnd();
  }

  /** Test hook / programmatic press: what a tap on key `id` does (press then release). */
  press(id) {
    const k = this.keys.get(id);
    if (!k) return false;
    const ev = this._activate(id);
    if (ev) this._afterKey();
    k.el.classList.add('osk-pressed');
    setTimeout(() => k.el.classList.remove('osk-pressed'), 90);
    return true;
  }
  /**
   * The taps that type `ch` on this page from a state without modifiers: key ids, modifiers first ('Shift', 'AltGr'),
   * a dead key then the letter for accents the layout composes (ê = ^ then e); null when it cannot. (Tests, help.)
   */
  plan(ch) {
    const states = [[false, false], [true, false], [false, true], [true, true]].filter(([, g]) => !g || this.keys.has('AltGr'));
    const find = (want) => {
      for (const [shift, altgr] of states) {
        for (const [id, { spec }] of this.keys) {
          if (spec.levels && output(spec.levels, { shift, caps: false, altgr }) === want) return [...(altgr ? ['AltGr'] : []), ...(shift ? ['Shift'] : []), id];
        }
      }
      return null;
    };
    if (ch === ' ') return ['Space'];
    const direct = find(ch);
    if (direct) return direct;
    const [base, ...marks] = [...String(ch).normalize('NFD')];
    const dead = marks.length === 1 ? Object.keys(DEAD).find((n) => DEAD[n].mark === marks[0]) : null;
    const dk = dead && find(`dead_${dead}`);
    const b = dk && find(base);
    return dk && b ? [...dk, ...b] : null;
  }
  /** The key that types `ch` in the current state (null if none on this page). */
  keyFor(ch) {
    for (const [id, { el, spec }] of this.keys) if (spec.levels && el.dataset.out === ch) return id;
    return null;
  }

  _send(ev) {
    try {
      this.o.deliver?.(ev);
    } catch (err) {
      console.error('[osk] deliver failed', err);
    }
  }

  // A tap on a key: modifiers change state; other keys produce an event (returned, for the key repeat).
  _activate(id) {
    const s = this.state;
    const k = this.keys.get(id);
    if (!k) return null;
    if (this.o.sound?.()) click();
    const cycle = (v) => (v + 1) % 3;
    switch (id) {
      case 'Shift':
      case 'ShiftR':
        s.shift = cycle(s.shift);
        this.refresh();
        return null;
      case 'Caps':
        s.caps = !s.caps;
        s.shift = 0;
        this.refresh();
        return null;
      case 'AltGr':
        s.altgr = cycle(s.altgr);
        this.refresh();
        return null;
      case 'Ctrl':
      case 'CtrlR':
      case 'Alt': {
        const m = id === 'Alt' ? 'alt' : 'ctrl';
        const was = s[m];
        s[m] = cycle(was);
        if (was === 2 || s[m] === 2) this._send({ type: 'hold', mods: { ctrl: s.ctrl === 2, alt: s.alt === 2 } });
        this.refresh();
        return null;
      }
      case 'Super':
        if (s.super) {
          // pressed twice with nothing in between: Super alone (the Lanceur)
          s.super = 0;
          this.refresh();
          this._send({ type: 'super' });
          return null;
        }
        s.super = 1;
        this.refresh();
        return null;
      case 'Page':
        s.page = s.page === 'main' ? 'sym' : s.page === 'sym' ? 'acc' : 'main';
        s.dead = null;
        this.render();
        return null;
      default:
        break;
    }
    const mods = { ctrl: s.ctrl > 0, alt: s.alt > 0, super: s.super > 0 };
    const combo = mods.ctrl || mods.alt || mods.super;
    if (id === 'Space') {
      let text = ' ';
      if (s.dead && !combo) text = deadSpacing(s.dead);
      s.dead = null;
      const ev = { type: 'text', text, mods };
      this._send(ev);
      return ev;
    }
    if (NAV[id]) {
      if (s.dead) {
        s.dead = null; // a dead key then Backspace / an arrow: the accent is dropped
        this.refresh();
        if (id === 'Backspace') return { noRepeat: true };
      }
      const ev = { type: 'key', key: NAV[id], mods: { ...mods, shift: s.shift > 0 } };
      this._send(ev);
      return ev;
    }
    if (!k.spec.levels) return null;
    const levels = k.spec.levels;
    const v = output(levels, { shift: s.shift > 0, caps: s.caps, altgr: s.altgr > 0 });
    if (v == null) return { noRepeat: true };
    if (combo) {
      // a shortcut: the digit of an AZERTY digit-row key (Super+1, Ctrl+1), else the key's character
      let text = s.page === 'main' ? levels.find((x) => typeof x === 'string' && /^[0-9]$/.test(x)) : null;
      if (!text) text = isDead(v) ? deadSpacing(v) : v;
      s.dead = null;
      const ev = { type: 'text', text, mods };
      this._send(ev);
      return ev;
    }
    if (isDead(v)) {
      if (s.dead) {
        const prev = s.dead;
        s.dead = prev === v ? null : v;
        this._send({ type: 'text', text: deadSpacing(prev), mods });
      } else s.dead = v;
      this.refresh();
      return { noRepeat: true };
    }
    let text = v;
    if (s.dead) {
      text = compose(s.dead, v) ?? deadSpacing(s.dead) + v;
      s.dead = null;
    }
    const ev = { type: 'text', text, mods };
    this._send(ev);
    return ev;
  }

  // After a key (not a modifier): the one-shot modifiers end; locked ones stay.
  _afterKey() {
    const s = this.state;
    let changed = false;
    for (const m of ['shift', 'altgr', 'ctrl', 'alt', 'super']) {
      if (s[m] === 1) {
        s[m] = 0;
        changed = true;
      }
    }
    if (changed || this.keys.size) this.refresh();
  }

  destroy() {
    this._release();
    for (const type of ['pointerdown', 'pointerup', 'pointercancel', 'pointermove', 'mousedown', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu', 'touchstart', 'touchend', 'lostpointercapture']) {
      window.removeEventListener(type, this._onPointer, { capture: true });
    }
    window.removeEventListener('resize', this._onResize);
    this._langOff?.();
    this.el.remove();
  }
}
