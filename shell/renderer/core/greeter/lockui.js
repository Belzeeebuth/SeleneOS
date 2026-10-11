// Windows 11 style lock / sign-in screen, shared by the sign-in screen (core/greeter/greeter.js,
// greeter mode) and the desktop lock screen (core/features/lock.js).
//
//   const ls = new LockScreen({
//     mode: 'greeter' | 'lock',
//     users: [{ name, fullName, avatarUrl, passwordless }],  selected: 'name',
//     wallpaper: url,                               // sharp picture of the first ("curtain") view
//     clock24h: () => true|false|null,             // null = locale default
//     onAuth: async (user, password) => ({ ok: true } | { error: 'auth'|'rate'|'expired'|'other', retryAfter, message, detail }),
//     onSuccess: (user) => {},                     // the screen stays in its "Welcome" state; the owner dismisses it
//     onPower: async ('sleep'|'shutdown'|'restart') => {},   confirmPower: bool | () => bool (warn that apps are open)
//     onSwitchUser: async () => {},                 // lock mode: bottom-left "Switch user" (signs out)
//     confirmSwitch: bool | () => bool              // ask first (apps are open and will close)
//     input: { langs: [{id, label}], lang, onLang(id), layouts: [{id, label}], layout, onLayout(id) }  // greeter
//     accessibility: [{ label, checked: () => bool, toggle: () => {} }],
//     onUserChange: (user) => {},  onError: () => {},
//   });
//   host.append(ls.el); ls.show();      ls.reveal() / ls.cover()   ls.focus()   ls.refresh() (language changed)
//   ls.setNetwork(status|null)  ls.setBattery(b|null)  ls.setBadges([{ icon, count, label }])  ls.setRetry(ms)
//   await ls.dismiss()  ls.destroy()
// Keyboard: any key / click / wheel / swipe up opens the sign-in view (typed characters go to the password box),
// Esc goes back, Alt+F8 reveals the password, Enter signs in. Tab order: user name/password, buttons, the user list
// (one stop: arrow keys / Home / End move inside it), the tray buttons.
import { h, icon, ui } from '../ui.js';
import { i18n, t } from '../i18n.js';
import { blurredImage, topLuminance } from './backdrop.js';
import { KB_CODES, LANG_CODES } from './strings.js';

const IDLE_COVER_MS = 60000;

export function initials(name) {
  const parts = String(name || '')
    .trim()
    .split(/[\s._-]+/)
    .filter(Boolean);
  if (!parts.length) return '?';
  const first = [...parts[0]][0] || '';
  const last = parts.length > 1 ? [...parts[parts.length - 1]][0] || '' : '';
  return (first + last).toUpperCase();
}

function hueOf(name) {
  let x = 0;
  for (const c of String(name || '')) x = (x * 31 + c.codePointAt(0)) >>> 0;
  return [212, 262, 190, 330, 24, 150, 288, 200][x % 8];
}

/** Round account picture (image, or initials on a soft gradient). */
export function avatar(user, cls = '') {
  const el = h('div', { class: ['lk-avatar', cls], 'aria-hidden': 'true' });
  const fill = () => {
    el.classList.add('initials');
    el.style.setProperty('--lk-hue', String(hueOf(user?.name)));
    el.textContent = user?.other ? '' : initials(user?.fullName || user?.name);
    if (user?.other) el.append(icon('person', { size: 48 }));
  };
  if (user?.avatarUrl) {
    const img = h('img', { src: user.avatarUrl, alt: '', draggable: false });
    img.addEventListener('error', () => {
      img.remove();
      fill();
    });
    el.append(img);
  } else fill();
  return el;
}

/** The Windows "orbiting dots" progress indicator. */
export function spinner(cls = '') {
  return h('div', { class: ['lk-spinner', cls], role: 'progressbar', 'aria-label': t('common.loading') }, [0, 1, 2, 3, 4].map((i) => h('i', { style: `--i:${i}` })));
}

// Wired network: the same monitor-and-cable glyph as the taskbar tray.
const ETHERNET_SVG =
  '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="4.3" y="3.3" width="13.4" height="9.4" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8.5 16.5h5M11 12.8v3.6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M1.8 9.5h2.6M3.1 9.5v6.5h2.4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function netIcon(st) {
  if (!st) return null;
  if (st.airplane) return 'airplane';
  const p = st.primary || {};
  if (p.type === 'ethernet') return st.connectivity === 'none' ? 'globe_prohibited' : 'ethernet';
  if (p.type === 'wifi') {
    if (st.connectivity === 'limited') return 'wifi_warning';
    const s = Number(p.strength) || 0;
    return s > 75 ? 'wifi_1' : s > 50 ? 'wifi_2' : s > 25 ? 'wifi_3' : 'wifi_4';
  }
  return 'globe_prohibited';
}

function netGlyph(name, size = 20) {
  if (name !== 'ethernet') return icon(name, { size });
  return h('span', { class: 'icon', style: `width:${size}px;height:${size}px`, html: ETHERNET_SVG });
}

function netLabel(st) {
  const p = st?.primary || {};
  if (!st || st.connectivity === 'none' || !p.type) return t('lockui.noInternet');
  if (st.connectivity === 'limited') return t('lockui.limited', { name: p.name || t('lockui.network') });
  if (p.type === 'ethernet') return t('lockui.connectedWired');
  return t('lockui.connected', { name: p.name || 'Wi-Fi' });
}

function batteryIcon(b) {
  const pct = Math.max(0, Math.min(100, Number(b.percent) || 0));
  if (b.charging) return 'battery_charge';
  return `battery_${Math.min(10, Math.round(pct / 10))}`;
}

const reduceMotion = () => document.documentElement.dataset.animations === 'off';

export class LockScreen {
  constructor(opts = {}) {
    this.o = opts;
    this.mode = opts.mode === 'lock' ? 'lock' : 'greeter';
    this.users = Array.isArray(opts.users) ? opts.users.slice() : [];
    if (this.mode === 'greeter' && !this.users.length) this.users.push({ name: '', fullName: '', other: true });
    this.user = this.users.find((u) => u.name === opts.selected) || this.users[0] || null;
    this.stage = 'curtain';
    this.busy = false;
    this.retryUntil = 0;
    this.revealed = false;
    this.disposers = [];
    this.timers = { clock: 0, idle: 0, retry: 0 };
    this.net = null;
    this.battery = null;
    this.badges = [];
    this._build();
  }

  // ---------------------------------------------------------------- DOM
  _build() {
    const o = this.o;
    this.el = h('div', {
      class: ['lockui', `lk-${this.mode}`, 'stage-curtain', 'wm-keep-focus'],
      role: 'dialog',
      'aria-modal': 'true',
      tabindex: '-1',
      // The lock and sign-in screens use the dark tokens whatever the desktop theme (light text on the
      // picture); the curtain switches to the light tokens over a light picture (see _loadBlur).
      'data-theme-scope': '',
      'data-theme': 'dark',
    });
    if (o.wallpaper) this.el.style.setProperty('--lk-wall-img', `url("${o.wallpaper}")`);

    // ---- sign-in view
    this.blur = h('div', { class: 'lk-blur' });
    this.avatarSlot = h('div', { class: 'lk-avatar-slot' });
    this.nameEl = h('div', { class: 'lk-name', id: `lk-name-${Math.random().toString(36).slice(2, 8)}` });
    this.userInput = h('input', { class: 'lk-input lk-user-input', type: 'text', autocomplete: 'username', spellcheck: 'false', autocapitalize: 'off', maxlength: '64' });
    this.userField = h('div', { class: 'lk-field lk-user-field' }, this.userInput);
    this.input = h('input', { class: 'lk-input', type: 'password', autocomplete: 'current-password', spellcheck: 'false', autocapitalize: 'off', maxlength: '4096' });
    this.revealBtn = h('button', { type: 'button', class: 'lk-icon-btn lk-reveal', tabindex: '-1' }, icon('eye', { size: 16 }));
    this.goBtn = h('button', { type: 'submit', class: 'lk-icon-btn lk-go' }, icon('arrow_right', { size: 16 }));
    this.field = h('div', { class: 'lk-field lk-pw-field' }, this.input, this.revealBtn, this.goBtn);
    this.signBtn = h('button', { type: 'submit', class: 'lk-signin-btn' });
    this.msg = h('div', { class: 'lk-msg', role: 'alert', 'aria-live': 'assertive' });
    this.caps = h('div', { class: 'lk-caps', 'aria-live': 'polite' }, icon('keyboard_shift_uppercase', { size: 14 }), h('span'));
    this.forgot = h('button', { type: 'button', class: 'lk-link' });
    this.help = h('div', { class: 'lk-help', hidden: true });
    this.form = h(
      'form',
      {
        class: 'lk-form',
        novalidate: true,
        onsubmit: (e) => {
          e.preventDefault();
          this.submit();
        },
      },
      this.userField,
      this.field,
      this.signBtn,
      this.msg,
      this.caps,
      this.forgot,
      this.help,
    );
    this.busyText = h('div', { class: 'lk-busy-text' });
    this.busyEl = h('div', { class: 'lk-busy', 'aria-live': 'polite' }, spinner(), this.busyText);
    this.card = h('div', { class: 'lk-card' }, this.avatarSlot, this.nameEl, h('div', { class: 'lk-form-slot' }, this.form, this.busyEl));
    this.usersEl = h('div', { class: 'lk-users', role: 'listbox' });
    this.usersEl.addEventListener('scroll', () => this._usersScrolled(), { passive: true });
    this.tray = h('div', { class: 'lk-tray' });
    this.signin = h('div', { class: 'lk-signin' }, this.blur, h('div', { class: 'lk-scrim' }), h('div', { class: 'lk-center' }, this.card), this.usersEl, this.tray);

    // ---- curtain (clock)
    this.wall = h('div', { class: 'lk-wall' });
    this.timeEl = h('div', { class: 'lk-time' });
    this.dateEl = h('div', { class: 'lk-date' });
    this.badgesEl = h('div', { class: 'lk-badges', hidden: true });
    this.statusEl = h('div', { class: 'lk-status', 'aria-hidden': 'true' });
    this.hintEl = h('div', { class: 'lk-sr' });
    this.curtain = h(
      'div',
      { class: 'lk-curtain', 'data-theme-scope': '', 'data-theme': 'dark' },
      this.wall,
      h('div', { class: 'lk-shade' }),
      h('div', { class: 'lk-clock' }, this.timeEl, this.dateEl),
      this.badgesEl,
      this.statusEl,
      this.hintEl,
    );
    this.el.append(this.signin, this.curtain);
    this.signin.inert = true;

    // ---- behaviour
    this.input.addEventListener('input', () => this._onInput());
    this.userInput.addEventListener('input', () => this._onInput());
    this.input.addEventListener('keyup', (e) => this._caps(e));
    this.input.addEventListener('keydown', (e) => this._caps(e));
    this.revealBtn.addEventListener('click', () => this._toggleReveal());
    this.forgot.addEventListener('click', () => {
      this.help.hidden = !this.help.hidden;
      this.forgot.setAttribute('aria-expanded', String(!this.help.hidden));
    });
    this._curtainPointer();
    const onKey = (e) => this._onKey(e);
    document.addEventListener('keydown', onKey, true);
    this.disposers.push(() => document.removeEventListener('keydown', onKey, true));
    const onResize = () => this._usersScrolled();
    window.addEventListener('resize', onResize);
    this.disposers.push(() => window.removeEventListener('resize', onResize));
    const onActivity = () => this._bumpIdle();
    for (const ev of ['pointermove', 'pointerdown', 'wheel']) {
      this.el.addEventListener(ev, onActivity, { passive: true });
    }
    // Clicking the empty background of the sign-in view puts the focus back in the password box.
    this.signin.addEventListener('pointerdown', (e) => {
      if (e.target === this.signin || e.target.classList?.contains('lk-center') || e.target.classList?.contains('lk-scrim')) {
        setTimeout(() => this._focusPrimary(), 0);
      }
    });

    this._renderUser();
    this._renderUsers();
    this._renderTray();
    this.refresh();
    this._loadBlur();
  }

  async _loadBlur() {
    const url = this.o.wallpaper;
    if (!url) return;
    // Contrast >= 4.5:1 for every text over the picture, from the mean luminance (linear) of its top part:
    //  - curtain: a light picture gets dark text (light tokens) on a light veil; a dark one keeps light
    //    text under a night shade dense enough to bring the background to L <= 0.15 (white text >= 5:1);
    //  - sign-in: light text over the pre-blurred copy (brightness 0.72, about x0.48 in linear light),
    //    under a night veil computed the same way.
    topLuminance(url).then((lum) => {
      const light = lum != null && lum > 0.28;
      this.el.classList.toggle('lk-light-wall', light);
      this.curtain.dataset.theme = light ? 'light' : 'dark';
      const veil = (l) => Math.min(0.82, Math.max(0, 1 - 0.15 / Math.max(l, 0.001)));
      this.el.style.setProperty('--lk-shade-a', (light ? 0.42 : Math.max(0.24, veil(lum || 0))).toFixed(2));
      this.el.style.setProperty('--lk-veil', Math.max(0.12, veil((lum || 0) * 0.48)).toFixed(2));
    });
    const blurred = await blurredImage(url, { blur: 30, brightness: 0.72, saturate: 1.3 });
    if (blurred) {
      this.blur.style.backgroundImage = `url("${blurred}")`;
      this.blur.classList.add('ready');
    }
  }

  // ---------------------------------------------------------------- texts (language switch)
  refresh() {
    this.el.setAttribute('aria-label', t(this.mode === 'lock' ? 'lockui.lockLabel' : 'lockui.screenLabel'));
    this.hintEl.textContent = t('lockui.curtainHint');
    this.input.placeholder = t('lockui.password');
    this.input.setAttribute('aria-label', t('lockui.password'));
    this.userInput.placeholder = t('lockui.username');
    this.userInput.setAttribute('aria-label', t('lockui.username'));
    this.goBtn.setAttribute('aria-label', t('lockui.submit'));
    this.goBtn.dataset.tip = t('lockui.submit');
    this._revealLabel();
    this.signBtn.textContent = t('lockui.signIn');
    this.caps.querySelector('span').textContent = t('lockui.capsLock');
    this.forgot.textContent = t('lockui.forgot');
    this.help.textContent = t(this.mode === 'lock' ? 'lockui.forgotHelpLock' : 'lockui.forgotHelp');
    this.busyText.textContent = t('lockui.welcome');
    this.usersEl.setAttribute('aria-label', t('lockui.users'));
    if (this.user?.other) this.nameEl.textContent = t('lockui.otherUser');
    if (this._msgKey) this._showMsg(this._msgKey, this._msgVars, this._msgDetail);
    this._renderUsers();
    this._renderTray();
    this._renderStatus();
    this._renderBadges();
    this._tick(true);
  }

  _revealLabel() {
    const shown = this.input.type === 'text';
    const label = t(shown ? 'lockui.conceal' : 'lockui.reveal');
    this.revealBtn.setAttribute('aria-label', label);
    this.revealBtn.dataset.tip = `${label} (Alt+F8)`;
    this.revealBtn.replaceChildren(icon(shown ? 'eye_off' : 'eye', { size: 16 }));
  }

  // ---------------------------------------------------------------- clock
  _tick(force) {
    const now = new Date();
    const h24 = this.o.clock24h?.();
    const opts = { hour: 'numeric', minute: '2-digit' };
    if (h24 != null) opts.hour12 = !h24;
    // The big clock never shows AM/PM (like Windows): drop the day period from the 12-hour format.
    let time;
    try {
      const parts = new Intl.DateTimeFormat(i18n.locale, opts).formatToParts(now);
      time = parts
        .filter((p) => p.type !== 'dayPeriod')
        .map((p) => p.value)
        .join('')
        .trim();
    } catch {
      time = i18n.formatTime(now, opts);
    }
    let date = i18n.formatDate(now, { weekday: 'long', month: 'long', day: 'numeric' });
    date = date.charAt(0).toUpperCase() + date.slice(1);
    if (force || this.timeEl.textContent !== time) this.timeEl.textContent = time;
    if (force || this.dateEl.textContent !== date) this.dateEl.textContent = date;
  }

  // ---------------------------------------------------------------- lifecycle
  /** Start the clock and fade in (animate: false = at once, e.g. when the screen must never be seen through). */
  show({ animate = true } = {}) {
    this._tick(true);
    clearInterval(this.timers.clock);
    this.timers.clock = setInterval(() => this._tick(false), 1000);
    if (animate && !reduceMotion()) {
      this.el.classList.add('lk-entering');
      setTimeout(() => this.el.classList.remove('lk-entering'), 1500);
    }
    setTimeout(() => this.el.focus({ preventScroll: true }), 0);
  }

  /** Fade the whole screen out, then remove it. */
  dismiss() {
    return new Promise((resolve) => {
      this.el.classList.add('lk-leaving', 'closing');
      this.el.inert = true;
      const done = () => {
        this.destroy();
        this.el.remove();
        resolve();
      };
      if (reduceMotion()) done();
      else setTimeout(done, 380);
    });
  }

  destroy() {
    for (const d of this.disposers.splice(0)) {
      try {
        d();
      } catch {}
    }
    clearInterval(this.timers.clock);
    clearTimeout(this.timers.idle);
    clearInterval(this.timers.retry);
    ui.closeMenus?.();
  }

  // ---------------------------------------------------------------- stages
  reveal({ typed = '' } = {}) {
    if (this.stage === 'signin') return;
    this.stage = 'signin';
    this.revealed = true;
    this.el.classList.remove('stage-curtain');
    this.el.classList.add('stage-signin');
    this.curtain.style.transform = '';
    this.curtain.classList.remove('dragging');
    this.signin.inert = false;
    this.curtain.inert = true;
    if (typed && !this.user?.passwordless && !this.busy && !this._retryLeft()) {
      const target = this.user?.other && !this.userInput.value ? this.userInput : this.input;
      target.value += typed;
      this._onInput();
    }
    this._focusPrimary();
    this._bumpIdle();
    this.o.onReveal?.();
  }

  cover() {
    if (this.stage === 'curtain' || this.busy) return;
    ui.closeMenus?.();
    this._closeDialog(false);
    this.stage = 'curtain';
    this.el.classList.remove('stage-signin');
    this.el.classList.add('stage-curtain');
    this.input.value = '';
    this.input.type = 'password';
    this._revealLabel();
    this._onInput();
    this.help.hidden = true;
    if (!this._retryLeft()) this._clearMsg();
    this.signin.inert = true;
    this.curtain.inert = false;
    clearTimeout(this.timers.idle);
    this.el.focus({ preventScroll: true });
  }

  _bumpIdle() {
    clearTimeout(this.timers.idle);
    if (this.stage !== 'signin') return;
    this.timers.idle = setTimeout(() => {
      if (this.stage === 'signin' && !this.busy && !this.input.value && !this.dialog && !document.querySelector('body > .menu')) this.cover();
      else this._bumpIdle();
    }, IDLE_COVER_MS);
  }

  /** Put the keyboard focus where it belongs (password box, Sign in button, or the screen itself). */
  focus() {
    if (this.stage === 'signin' && !this.busy) this._focusPrimary();
    else this.el.focus({ preventScroll: true });
  }

  _focusPrimary() {
    if (this.stage !== 'signin' || this.busy) return;
    let target = this.input;
    if (this.user?.passwordless) target = this.signBtn;
    else if (this.user?.other && !this.userInput.value) target = this.userInput;
    if (this._retryLeft()) target = this.el;
    try {
      target.focus({ preventScroll: true });
    } catch {}
  }

  // ---------------------------------------------------------------- curtain gestures
  _curtainPointer() {
    const c = this.curtain;
    let drag = null;
    let raf = 0;
    c.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || this.stage !== 'curtain') return;
      drag = { y: e.clientY, t: performance.now(), dy: 0, id: e.pointerId };
      try {
        c.setPointerCapture(e.pointerId);
      } catch {}
    });
    c.addEventListener('pointermove', (e) => {
      if (drag) {
        drag.dy = Math.min(0, e.clientY - drag.y);
        if (Math.abs(drag.dy) > 6) {
          c.classList.add('dragging');
          c.style.transform = `translate3d(0, ${drag.dy}px, 0)`;
        }
        return;
      }
      if (reduceMotion() || this.stage !== 'curtain') return;
      // Subtle parallax: the picture drifts a few pixels against the pointer.
      const x = (e.clientX / window.innerWidth - 0.5) * -14;
      const y = (e.clientY / window.innerHeight - 0.5) * -9;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        this.wall.style.setProperty('--px', `${x.toFixed(1)}px`);
        this.wall.style.setProperty('--py', `${y.toFixed(1)}px`);
      });
    });
    const end = (e) => {
      if (!drag) return;
      const d = drag;
      drag = null;
      try {
        c.releasePointerCapture(d.id);
      } catch {}
      const speed = d.dy / Math.max(1, performance.now() - d.t);
      c.classList.remove('dragging');
      if (e.type === 'pointercancel') {
        c.style.transform = '';
        return;
      }
      if (Math.abs(d.dy) <= 6 || d.dy < -window.innerHeight * 0.16 || speed < -0.5) this.reveal();
      else c.style.transform = '';
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener(
      'wheel',
      (e) => {
        if (this.stage === 'curtain' && Math.abs(e.deltaY) > 2) this.reveal();
      },
      { passive: true },
    );
    this.disposers.push(() => cancelAnimationFrame(raf));
  }

  // ---------------------------------------------------------------- keyboard
  _onKey(e) {
    if (!this.el.isConnected || this.el.classList.contains('lk-leaving')) return;
    if (document.querySelector('body > .menu')) return; // an open tray menu handles its own keys
    if (this.dialog) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this._closeDialog(false);
      }
      return;
    }
    this._bumpIdle();
    if (this.stage === 'curtain') {
      if (['Shift', 'Control', 'Alt', 'AltGraph', 'Meta', 'OS', 'CapsLock', 'NumLock', 'Fn', 'Dead', 'Unidentified'].includes(e.key)) return;
      if (/^(Audio|Volume|Brightness|Media)/.test(e.key)) return;
      if (e.ctrlKey || e.metaKey) return;
      e.preventDefault();
      e.stopPropagation();
      const typed = e.key.length === 1 && e.key !== ' ' && !e.altKey ? e.key : '';
      this.reveal({ typed });
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (!this.help.hidden) this.help.hidden = true;
      else this.cover();
      return;
    }
    if (e.key === 'F8' && e.altKey) {
      e.preventDefault();
      this._toggleReveal();
      return;
    }
    // Focus is on the background: typing goes to the password box.
    const a = document.activeElement;
    if ((a === this.el || a === document.body || !this.el.contains(a)) && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && !this.busy && !this.user?.passwordless && !this._retryLeft()) {
      e.preventDefault();
      const target = this.user?.other && !this.userInput.value ? this.userInput : this.input;
      target.value += e.key;
      this._onInput();
      target.focus({ preventScroll: true });
    }
    // Arrow keys / Home / End move between the accounts of the user list (roving Tab stop).
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key) && this.usersEl.contains(a) && this.mode === 'greeter') {
      e.preventDefault();
      const items = [...this.usersEl.querySelectorAll('.lk-user')];
      const i = items.indexOf(a);
      const n = items.length;
      const j = e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : (i + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
      const next = items[j];
      if (next) {
        for (const it of items) it.tabIndex = it === next ? 0 : -1;
        next.focus();
        next.scrollIntoView?.({ block: 'nearest' });
      }
    }
  }

  _caps(e) {
    const on = !!e.getModifierState?.('CapsLock');
    this.caps.classList.toggle('show', on && !this.user?.passwordless);
  }

  _onInput() {
    this.field.classList.toggle('has-text', !!this.input.value);
    if (['lockui.wrong', 'lockui.wrongUser', 'lockui.verifyError', 'lockui.loginError', 'lockui.expired'].includes(this._msgKey)) {
      if (this.input.value) this._clearMsg();
    }
    this._bumpIdle();
  }

  _toggleReveal() {
    if (this.user?.passwordless) return;
    const pos = this.input.selectionStart;
    this.input.type = this.input.type === 'password' ? 'text' : 'password';
    this._revealLabel();
    this.input.focus({ preventScroll: true });
    try {
      this.input.setSelectionRange(pos, pos);
    } catch {}
  }

  // ---------------------------------------------------------------- user
  _renderUser() {
    const u = this.user;
    this.avatarSlot.replaceChildren(avatar(u || { name: '?' }));
    this.nameEl.textContent = u?.other ? t('lockui.otherUser') : u?.fullName || u?.name || '';
    this.el.classList.toggle('lk-passwordless', !!u?.passwordless);
    this.el.classList.toggle('lk-other', !!u?.other);
    this.userField.hidden = !u?.other;
    this.field.hidden = !!u?.passwordless;
    this.signBtn.hidden = !u?.passwordless;
    this.forgot.hidden = !!u?.passwordless || !!u?.other;
    this.help.hidden = true;
    this.input.value = '';
    this.input.type = 'password';
    this._revealLabel();
    this._onInput();
    this.caps.classList.remove('show');
    this.input.setAttribute('aria-describedby', this.nameEl.id);
  }

  selectUser(name) {
    if (this.busy) return;
    const u = this.users.find((x) => x.name === name && !x.other) || (name === null ? this.users.find((x) => x.other) : null);
    if (!u || u === this.user) {
      this._focusPrimary();
      return;
    }
    this.user = u;
    if (!this._retryLeft()) this._clearMsg();
    this._renderUser();
    this._renderUsers();
    // A gentle swap animation of the card.
    if (!reduceMotion()) {
      this.card.classList.remove('lk-swap');
      void this.card.offsetWidth;
      this.card.classList.add('lk-swap');
    }
    this.o.onUserChange?.(u);
    this._focusPrimary();
  }

  _renderUsers() {
    const list = this.usersEl;
    if (this.mode === 'lock') {
      if (!this.o.onSwitchUser) {
        list.replaceChildren();
        return;
      }
      const btn = h(
        'button',
        { type: 'button', class: 'lk-user lk-switch', onclick: () => this._switchUser() },
        h('div', { class: 'lk-avatar lk-avatar-icon' }, icon('person_swap', { size: 20 })),
        h('span', { class: 'lk-user-name' }, t('lockui.switchUser')),
      );
      list.setAttribute('role', 'group');
      list.replaceChildren(btn);
      return;
    }
    const real = this.users.filter((u) => !u.other);
    if (real.length < 2) {
      list.replaceChildren();
      return;
    }
    list.setAttribute('role', 'listbox');
    list.replaceChildren(
      ...this.users.map((u) => {
        const sel = u === this.user;
        return h(
          'button',
          {
            type: 'button',
            class: ['lk-user', sel && 'selected'],
            role: 'option',
            'aria-selected': String(sel),
            // One Tab stop for the whole list (the selected account); the arrow keys move inside it.
            tabindex: sel ? '0' : '-1',
            dataset: { user: u.name },
            onclick: () => this.selectUser(u.other ? null : u.name),
          },
          avatar(u, 'small'),
          h('span', { class: 'lk-user-name' }, u.other ? t('lockui.otherUser') : u.fullName || u.name),
        );
      }),
    );
    // A long list scrolls: keep the selected account in view, fade the edges that have more accounts behind them.
    requestAnimationFrame(() => {
      const sel = list.querySelector('.lk-user.selected');
      if (sel && list.scrollHeight > list.clientHeight) {
        const top = sel.offsetTop;
        if (top < list.scrollTop || top + sel.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = top - (list.clientHeight - sel.offsetHeight) / 2;
      }
      this._usersScrolled();
    });
  }

  _usersScrolled() {
    const l = this.usersEl;
    const over = l.scrollHeight > l.clientHeight + 1;
    l.classList.toggle('lk-scroll', over);
    l.classList.toggle('lk-at-top', !over || l.scrollTop <= 1);
    l.classList.toggle('lk-at-end', !over || l.scrollTop + l.clientHeight >= l.scrollHeight - 1);
  }

  // ---------------------------------------------------------------- tray
  _trayBtn(cls, label, content, onclick) {
    return h('button', { type: 'button', class: ['lk-tray-btn', cls], 'aria-label': label, 'data-tip': label, onclick }, content);
  }

  _renderTray() {
    const o = this.o;
    const items = [];
    const inp = o.input;
    if (inp && (inp.langs?.length || inp.layouts?.length)) {
      const lang = inp.lang?.() ?? i18n.lang;
      const kb = inp.layout?.() || 'us';
      const kbName = t(`lockui.kb.${kb}`);
      const langName = (inp.langs || []).find((l) => l.id === lang)?.label || lang;
      const label = t('lockui.inputIndicator', { lang: langName, kb: kbName.startsWith('lockui.') ? kb : kbName });
      items.push(
        this._trayBtn(
          'lk-ind',
          label,
          [h('span', { class: 'lk-ind-lang' }, LANG_CODES[lang] || lang.toUpperCase()), h('span', { class: 'lk-ind-kb' }, KB_CODES[kb] || kb.toUpperCase())],
          (e) => this._inputMenu(e.currentTarget),
        ),
      );
    }
    this.netBtn = this._trayBtn('lk-net', t('lockui.network'), icon('wifi_1', { size: 20 }), (e) => {
      const n = netIcon(this.net);
      this._menu(e.currentTarget, [{ header: t('lockui.network') }, { label: netLabel(this.net), icon: n === 'ethernet' ? 'desktop' : n || 'globe_prohibited', disabled: true }]);
    });
    this.netBtn.hidden = !this.net;
    items.push(this.netBtn);
    if (o.accessibility?.length) {
      items.push(
        this._trayBtn('lk-a11y', t('lockui.accessibility'), icon('accessibility', { size: 20 }), (e) =>
          this._menu(e.currentTarget, [
            { header: t('lockui.accessibility') },
            ...o.accessibility.map((a) => ({
              label: typeof a.label === 'function' ? a.label() : a.label,
              checked: !!a.checked(),
              action: () => a.toggle(),
            })),
          ]),
        ),
      );
    }
    if (o.onPower) {
      items.push(
        this._trayBtn('lk-power', t('lockui.power'), icon('power', { size: 20 }), (e) =>
          this._menu(e.currentTarget, [
            { label: t('power.sleep'), icon: 'weather_moon', action: () => this._power('sleep') },
            { label: t('power.shutdown'), icon: 'power', action: () => this._power('shutdown') },
            { label: t('power.restart'), icon: 'arrow_clockwise', action: () => this._power('restart') },
          ]),
        ),
      );
    }
    this.tray.replaceChildren(...items);
    this._renderNet();
  }

  _menu(anchor, items) {
    this._bumpIdle();
    const p = ui.menu(anchor, items, { above: true, class: 'lk-menu' });
    // ui.menu opens at the button's left edge and clamps to the screen edge; align the menu's right edge with the
    // button instead, a little above it.
    const m = [...document.querySelectorAll('body > .menu.lk-menu')].pop();
    // Same dark tokens as the lock screen itself (the menu lives in <body>, outside .lockui).
    if (m) {
      m.setAttribute('data-theme-scope', '');
      m.dataset.theme = 'dark';
    }
    if (m && anchor?.getBoundingClientRect) {
      const a = anchor.getBoundingClientRect();
      const r = m.getBoundingClientRect();
      const left = Math.max(8, Math.min(window.innerWidth - r.width - 8, a.right - r.width));
      const top = Math.max(8, a.top - r.height - 8);
      m.style.left = `${left}px`;
      m.style.top = `${top}px`;
    }
    return p.then((r) => {
      // Like Windows, the keyboard goes back to the password box once a tray menu closes.
      setTimeout(() => {
        if (this.stage === 'signin' && !this.dialog && this.el.isConnected) this._focusPrimary();
      }, 0);
      return r;
    });
  }

  _inputMenu(anchor) {
    const inp = this.o.input;
    const lang = inp.lang?.() ?? i18n.lang;
    const kb = inp.layout?.() || 'us';
    const items = [];
    if (inp.langs?.length) {
      items.push({ header: t('lockui.language') });
      for (const l of inp.langs) items.push({ label: l.label, checked: l.id === lang, action: () => inp.onLang?.(l.id) });
    }
    if (inp.layouts?.length) {
      if (items.length) items.push('-');
      items.push({ header: t('lockui.keyboard') });
      for (const l of inp.layouts) {
        const name = t(`lockui.kb.${l.id}`);
        items.push({ label: name.startsWith('lockui.') ? l.id : name, checked: l.id === kb, action: () => inp.onLayout?.(l.id) });
      }
    }
    this._menu(anchor, items);
  }

  _wants(opt) {
    const v = this.o[opt];
    try {
      return typeof v === 'function' ? !!v() : !!v;
    } catch {
      return true;
    }
  }

  async _power(action) {
    if (action !== 'sleep' && this._wants('confirmPower')) {
      const ok = await this.confirm({
        title: t('lockui.powerTitle'),
        body: t('lockui.powerBody'),
        ok: t(action === 'shutdown' ? 'lockui.shutdownAnyway' : 'lockui.restartAnyway'),
        danger: true,
      });
      if (!ok) return;
    }
    try {
      await this.o.onPower(action);
    } catch (err) {
      // Localized sentence; the system's own (English) explanation as a secondary line.
      this._showMsg('lockui.powerError', null, err?.message || '');
    }
  }

  async _switchUser() {
    const name = this.user?.fullName || this.user?.name || '';
    if (this.o.confirmSwitch === undefined || this._wants('confirmSwitch')) {
      const ok = await this.confirm({ title: t('lockui.switchTitle', { name }), body: t('lockui.switchBody', { name }), ok: t('lockui.signOut'), danger: true });
      if (!ok) return;
    }
    await this.o.onSwitchUser?.();
  }

  setNetwork(status) {
    this.net = status || null;
    this._renderNet();
    this._renderStatus();
  }

  setBattery(b) {
    this.battery = b && typeof b === 'object' && b.percent != null ? b : null;
    this._renderStatus();
  }

  setBadges(list) {
    this.badges = Array.isArray(list) ? list.filter((b) => b && b.count > 0) : [];
    this._renderBadges();
  }

  _renderNet() {
    if (!this.netBtn) return;
    const name = netIcon(this.net);
    this.netBtn.hidden = !name;
    if (!name) return;
    this.netBtn.replaceChildren(netGlyph(name, 20));
    const label = netLabel(this.net);
    this.netBtn.dataset.tip = label;
    this.netBtn.setAttribute('aria-label', t('lockui.networkStatus', { status: label }));
  }

  _renderStatus() {
    const items = [];
    const n = netIcon(this.net);
    if (n) items.push(h('span', { class: 'lk-status-item', title: netLabel(this.net) }, netGlyph(n, 20)));
    if (this.battery) {
      const pct = Math.round(Number(this.battery.percent) || 0);
      items.push(
        h(
          'span',
          { class: 'lk-status-item', title: t(this.battery.charging ? 'lockui.batteryCharging' : 'lockui.battery', { pct }) },
          icon(batteryIcon(this.battery), { size: 20 }),
        ),
      );
    }
    this.statusEl.replaceChildren(...items);
  }

  _renderBadges() {
    const list = this.badges.slice(0, 6);
    this.badgesEl.hidden = !list.length;
    if (!list.length) {
      this.badgesEl.replaceChildren();
      return;
    }
    const total = this.badges.reduce((a, b) => a + b.count, 0);
    this.badgesEl.setAttribute('aria-label', t('lockui.notifications', { count: total }));
    this.badgesEl.replaceChildren(
      ...list.map((b) =>
        h(
          'div',
          { class: 'lk-badge', title: b.label ? t('lockui.notifFrom', { app: b.label, count: b.count }) : '' },
          b.icon && /^(app|media|data|blob|https?):|^\//.test(b.icon) ? h('img', { src: b.icon, alt: '', draggable: false }) : icon(b.icon || 'alert', { size: 18 }),
          h('span', null, b.count > 99 ? '99+' : String(b.count)),
        ),
      ),
    );
  }

  // ---------------------------------------------------------------- messages
  _showMsg(key, vars, detail) {
    this._msgKey = key;
    this._msgVars = vars;
    this._msgDetail = detail || '';
    const lines = [h('div', null, t(key, vars))];
    if (detail) lines.push(h('div', { class: 'lk-msg-detail' }, detail));
    this.msg.replaceChildren(...lines);
    this.msg.classList.add('show');
  }

  _clearMsg() {
    this._msgKey = null;
    this.msg.replaceChildren();
    this.msg.classList.remove('show');
  }

  _shake() {
    if (reduceMotion()) return;
    const target = this.user?.passwordless ? this.signBtn : this.field;
    target.classList.remove('lk-shake');
    void target.offsetWidth;
    target.classList.add('lk-shake');
  }

  _retryLeft() {
    return Math.max(0, this.retryUntil - Date.now());
  }

  /** Disable sign-in for `ms` (rate limiting) with a live countdown. */
  setRetry(ms) {
    clearInterval(this.timers.retry);
    this.retryUntil = ms > 0 ? Date.now() + ms : 0;
    const update = () => {
      const left = this._retryLeft();
      const locked = left > 0;
      this.el.classList.toggle('lk-rate', locked);
      this.input.disabled = locked;
      this.goBtn.disabled = locked;
      this.signBtn.disabled = locked;
      if (locked) {
        this._showMsg('lockui.rate', { count: Math.ceil(left / 1000) });
      } else {
        clearInterval(this.timers.retry);
        if (this._msgKey === 'lockui.rate') this._clearMsg();
        this._focusPrimary();
      }
    };
    update();
    if (this.retryUntil) this.timers.retry = setInterval(update, 250);
  }

  _setBusy(on) {
    this.busy = on;
    this.el.classList.toggle('busy', on);
    this.form.inert = on;
    this.usersEl.inert = on;
    this.tray.inert = on;
    this.el.setAttribute('aria-busy', String(on));
  }

  // ---------------------------------------------------------------- sign in
  async submit() {
    if (this.busy || this._retryLeft() || !this.user) return;
    let user = this.user;
    if (user.other) {
      const name = this.userInput.value.trim();
      if (!name) {
        this.userInput.focus();
        return;
      }
      // Enter in the user name box moves on to the password box first.
      if (document.activeElement === this.userInput && !this.input.value) {
        this.input.focus();
        return;
      }
      user = { ...user, name, fullName: name };
    }
    const password = user.passwordless ? '' : this.input.value;
    this._clearMsg();
    this.help.hidden = true;
    this._setBusy(true);
    let res;
    try {
      res = await this.o.onAuth(user, password);
    } catch (err) {
      res = { error: 'other', message: err?.message };
    }
    if (res?.ok) {
      this.input.value = '';
      this.o.onSuccess?.(user);
      return;
    }
    this._setBusy(false);
    this.fail(res || { error: 'other' });
  }

  fail(res) {
    this.input.value = '';
    this._onInput();
    this.o.onError?.(res);
    if (res.error === 'rate') {
      this.setRetry(res.retryAfter || 30000);
      this._shake();
      return;
    }
    // "Other user": the name may be wrong as well as the password (never say which).
    if (res.error === 'auth') this._showMsg(this.user?.other ? 'lockui.wrongUser' : 'lockui.wrong', null, res.detail);
    else if (res.error === 'expired') this._showMsg('lockui.expired', null, res.detail);
    else if (this.mode === 'greeter') this._showMsg('lockui.loginError', null, res.message || '');
    else this._showMsg('lockui.verifyError', null, res.message);
    this._shake();
    if (res.retryAfter > 0) this.setRetry(res.retryAfter);
    else this._focusPrimary();
  }

  // ---------------------------------------------------------------- in-screen confirmation dialog
  confirm({ title, body, ok, cancel, danger = false }) {
    this._closeDialog(false);
    return new Promise((resolve) => {
      const okBtn = h('button', { type: 'button', class: ['lk-dbtn', 'primary', danger && 'danger'] }, ok || t('common.ok'));
      const cancelBtn = h('button', { type: 'button', class: 'lk-dbtn' }, cancel || t('common.cancel'));
      const titleId = `lk-dt-${Math.random().toString(36).slice(2, 8)}`;
      const box = h(
        'div',
        { class: 'lk-dialog', role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
        h('div', { class: 'lk-dialog-main' }, h('div', { class: 'lk-dialog-title', id: titleId }, title), h('div', { class: 'lk-dialog-body' }, body)),
        h('div', { class: 'lk-dialog-btns' }, okBtn, cancelBtn),
      );
      const layer = h('div', { class: 'lk-dialog-layer' }, box);
      this.dialog = { layer, resolve };
      okBtn.addEventListener('click', () => this._closeDialog(true));
      cancelBtn.addEventListener('click', () => this._closeDialog(false));
      layer.addEventListener('pointerdown', (e) => {
        if (e.target === layer) this._closeDialog(false);
      });
      box.addEventListener('keydown', (e) => {
        if (e.key === 'Tab') {
          e.preventDefault();
          (document.activeElement === okBtn ? cancelBtn : okBtn).focus();
        }
      });
      this.signin.inert = true;
      this.curtain.inert = true;
      this.el.append(layer);
      setTimeout(() => cancelBtn.focus(), 30);
    });
  }

  _closeDialog(value) {
    const d = this.dialog;
    if (!d) return;
    this.dialog = null;
    d.layer.classList.add('closing');
    setTimeout(() => d.layer.remove(), reduceMotion() ? 0 : 160);
    this.signin.inert = this.stage !== 'signin';
    this.curtain.inert = this.stage === 'signin';
    d.resolve(value);
    if (!value) setTimeout(() => this._focusPrimary(), 0);
  }
}
