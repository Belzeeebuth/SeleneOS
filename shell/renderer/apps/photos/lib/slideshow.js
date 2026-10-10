// Full-screen slideshow: crossfade or Ken Burns transitions, interval, shuffle, loop.
// Space pauses / resumes, arrows browse, Esc exits. Controls appear when the mouse moves.
import { reduceMotion, EASE } from './util.js';

export class Slideshow {
  constructor(app) {
    this.app = app;
    this.h = app.h;
    this.t = app.t;
    this.icon = app.icon;
    this.lib = app.lib;
    this.list = [];
    this.order = [];
    this.pos = 0;
    this.playing = false;
    this.timer = null;
    this.token = 0;
    this._build();
  }

  _build() {
    const { h, t, icon } = this;
    this.layers = h('div', { class: 'ph-ss-layers' });
    const btn = (ic, label, onclick, cmd) => h('button', { class: 'btn subtle icon-btn ph-ss-btn', 'aria-label': label, 'data-tip': label, dataset: { cmd }, onclick }, icon(ic, { size: 20 }));
    this.playBtn = btn('pause', t('pause'), () => this.toggle(), 'ss-play');
    this.caption = h('div', { class: 'ph-ss-caption caption' });
    this.controls = h(
      'div',
      { class: 'ph-ss-controls', role: 'toolbar', 'aria-label': t('slideshow') },
      btn('previous', t('previous'), () => this.step(-1), 'ss-prev'),
      this.playBtn,
      btn('next', t('next'), () => this.step(1), 'ss-next'),
      h('div', { class: 'vsep' }),
      btn('settings', t('slideshowSettings'), (e) => this.settingsMenu(e), 'ss-settings'),
      btn('dismiss', t('exitSlideshow'), () => this.app.stopSlideshow(), 'ss-exit'),
    );
    this.el = h('div', { class: 'ph-slideshow', tabindex: '-1', role: 'region', 'aria-label': t('slideshow') }, this.layers, this.caption, this.controls);
    this.el.addEventListener('pointermove', () => this._poke());
    this.el.addEventListener('click', (e) => {
      if (!e.target.closest('.ph-ss-controls')) this._poke();
    });
  }

  start(list, index = 0) {
    this.list = list.filter(Boolean);
    if (!this.list.length) return;
    const p = this.lib.prefs;
    this.order = this.list.map((_, i) => i);
    if (p.slideshowShuffle) {
      const first = index;
      const rest = this.order.filter((i) => i !== first);
      for (let i = rest.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [rest[i], rest[j]] = [rest[j], rest[i]];
      }
      this.order = [first, ...rest];
      this.pos = 0;
    } else this.pos = Math.max(0, Math.min(this.list.length - 1, index));
    this.app.ui.clear(this.layers);
    this.playing = true;
    this._setPlayIcon();
    this._show(true);
    this._poke();
    setTimeout(() => this.el.focus({ preventScroll: true }), 30);
  }

  stop() {
    this.playing = false;
    clearTimeout(this.timer);
    clearTimeout(this._idleT);
    this.token++;
    this.app.ui.clear(this.layers);
  }

  get current() {
    return this.list[this.order[this.pos]];
  }
  get index() {
    return this.order[this.pos];
  }

  _interval() {
    return Math.max(1, Number(this.lib.prefs.slideshowInterval) || 5) * 1000;
  }

  async _show(first = false) {
    const it = this.current;
    if (!it) return;
    const token = ++this.token;
    clearTimeout(this.timer);
    this.caption.textContent = `${it.name} · ${this.pos + 1} / ${this.order.length}`;
    const img = this.h('img', { class: 'ph-ss-img', alt: it.name, draggable: false });
    img.src = `${this.app.api.mediaUrl(it.path)}?v=${Math.round(it.mtime || 0)}-${it.size || 0}`;
    try {
      await img.decode();
    } catch {
      // Unreadable file: skip it.
      if (token === this.token) this.timer = setTimeout(() => this.step(1, true), 400);
      return;
    }
    if (token !== this.token) return;
    const kb = this.lib.prefs.slideshowTransition === 'kenburns' && !reduceMotion();
    const layer = this.h('div', { class: 'ph-ss-layer' }, img);
    this.layers.appendChild(layer);
    const fade = first || reduceMotion() ? 0 : 900;
    if (fade) layer.animate([{ opacity: 0 }, { opacity: 1 }], { duration: fade, easing: 'ease-in-out', fill: 'both' });
    if (kb) {
      // Slow pan + zoom across the whole display time.
      const dur = this._interval() + fade + 400;
      const zIn = Math.random() < 0.5;
      const dx = (Math.random() * 2 - 1) * 3;
      const dy = (Math.random() * 2 - 1) * 3;
      const a = zIn ? { transform: 'scale(1.0) translate(0%, 0%)' } : { transform: `scale(1.14) translate(${dx}%, ${dy}%)` };
      const b = zIn ? { transform: `scale(1.14) translate(${dx}%, ${dy}%)` } : { transform: 'scale(1.0) translate(0%, 0%)' };
      img.animate([a, b], { duration: dur, easing: 'linear', fill: 'forwards' });
    }
    const olds = [...this.layers.children].filter((c) => c !== layer);
    for (const o of olds) {
      if (fade) o.animate([{ opacity: 1 }, { opacity: 0 }], { duration: fade, easing: 'ease-in-out', fill: 'forwards' }).finished.finally(() => o.remove());
      else o.remove();
    }
    // Preload the next one.
    const next = this.list[this.order[(this.pos + 1) % this.order.length]];
    if (next) {
      const pre = new Image();
      pre.src = `${this.app.api.mediaUrl(next.path)}?v=${Math.round(next.mtime || 0)}-${next.size || 0}`;
    }
    this.el.dataset.index = String(this.index);
    if (this.playing) this._schedule();
  }

  _schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.step(1, true), this._interval());
  }

  step(dir, auto = false) {
    let p = this.pos + dir;
    if (p >= this.order.length) {
      if (!this.lib.prefs.slideshowLoop && auto) {
        this.app.stopSlideshow();
        return;
      }
      p = 0;
    }
    if (p < 0) p = this.order.length - 1;
    this.pos = p;
    this._show();
  }

  toggle(force) {
    this.playing = force ?? !this.playing;
    this._setPlayIcon();
    if (this.playing) this._schedule();
    else clearTimeout(this.timer);
    this.app.announce(this.playing ? this.t('playing') : this.t('paused'));
    this._poke();
    // Freeze Ken Burns motion while paused.
    for (const a of this.layers.getAnimations({ subtree: true })) {
      if (this.playing) a.play();
      else if (a.effect?.target?.classList?.contains('ph-ss-img')) a.pause();
    }
  }

  _setPlayIcon() {
    this.playBtn.replaceChildren(this.icon(this.playing ? 'pause' : 'play', { size: 20 }));
    const lab = this.playing ? this.t('pause') : this.t('play');
    this.playBtn.setAttribute('aria-label', lab);
    this.playBtn.dataset.tip = `${lab} (Space)`;
    this.el.classList.toggle('paused', !this.playing);
  }

  settingsMenu(e) {
    const p = this.lib.prefs;
    const t = this.t;
    this._menuOpen = true;
    this.app.ui
      .menu(e, [
        { header: t('set.interval') },
        ...[2, 3, 5, 10, 20, 30].map((s) => ({ label: t('seconds', { count: s }), checked: p.slideshowInterval === s, action: () => {
          this.lib.setPref('slideshowInterval', s);
          if (this.playing) this._schedule();
        } })),
        '-',
        { header: t('set.transition') },
        { label: t('set.crossfade'), checked: p.slideshowTransition === 'crossfade', action: () => this.lib.setPref('slideshowTransition', 'crossfade') },
        { label: t('set.kenburns'), checked: p.slideshowTransition === 'kenburns', action: () => this.lib.setPref('slideshowTransition', 'kenburns') },
        '-',
        { label: t('set.shuffle'), checked: !!p.slideshowShuffle, action: () => this.lib.setPref('slideshowShuffle', !p.slideshowShuffle) },
        { label: t('set.loop'), checked: !!p.slideshowLoop, action: () => this.lib.setPref('slideshowLoop', !p.slideshowLoop) },
      ])
      .finally(() => {
        this._menuOpen = false;
        this._poke();
      });
  }

  _poke() {
    this.el.classList.remove('idle');
    clearTimeout(this._idleT);
    this._idleT = setTimeout(() => {
      if (!this._menuOpen && !this.controls.matches(':hover')) this.el.classList.add('idle');
    }, 2500);
  }

  onKey(e) {
    switch (e.key) {
      case ' ':
      case 'Spacebar':
        if (e.target.closest?.('button')) return false;
        this.toggle();
        return true;
      case 'ArrowRight':
      case 'PageDown':
        this.step(1);
        return true;
      case 'ArrowLeft':
      case 'PageUp':
        this.step(-1);
        return true;
      case 'Escape':
      case 'F5':
        this.app.stopSlideshow();
        return true;
      default:
        return false;
    }
  }
}

export const _ease = EASE;
