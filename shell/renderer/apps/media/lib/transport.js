// Media Player transport bar: artwork + title, shuffle / previous / play-pause / next / repeat,
// seek bar with elapsed / remaining time, volume flyout, full screen, mini player and "…" menu.
import { formatTime, clamp } from './util.js';
import { entryArt } from './components.js';

export class Transport {
  constructor(app) {
    this.app = app;
    const { h, t, icon } = app;
    this.showRemaining = !!app.prefs.showRemaining;
    const B = (cls, ic, label, onClick, extra = {}) => {
      const b = h('button', { class: ['btn subtle mp-tb', cls], 'aria-label': label, 'data-tip': label, onclick: onClick, ...extra }, icon(ic));
      // Keep keyboard focus on the content (so Space / arrows keep controlling playback).
      b.addEventListener('mousedown', (e) => e.preventDefault());
      return b;
    };
    this.bShuffle = B('mp-shuffle', 'arrow_shuffle_off', t('transport.shuffleOff'), () => app.toggleShuffle());
    this.bPrev = B('mp-prev', 'previous', t('transport.previous'), () => app.prev());
    this.bPlay = B('mp-play', 'play', t('transport.play'), () => app.togglePlay());
    this.bNext = B('mp-next', 'next', t('transport.next'), () => app.next());
    this.bRepeat = B('mp-repeat', 'arrow_repeat_all_off', t('transport.repeat_off'), () => app.cycleRepeat());
    this.bVol = B('mp-vol', 'speaker_2', t('transport.volume'), (e) => this.toggleVolume(e), { 'aria-haspopup': 'dialog' });
    this.bFull = B('mp-full', 'full_screen_maximize', t('transport.fullscreen'), () => app.toggleFullscreen());
    this.bMini = B('mp-mini', 'picture_in_picture_enter', t('transport.mini'), () => app.toggleMini());
    this.bMore = B('mp-more', 'more_horizontal', t('transport.more'), (e) => app.moreMenu(e), { 'aria-haspopup': 'menu' });
    this.bVol.addEventListener('wheel', (e) => {
      e.preventDefault();
      app.setVolume(app.player.volume + (e.deltaY < 0 ? 0.05 : -0.05));
    });
    this.artBox = h('button', { class: 'mp-bar-art', 'aria-label': t('transport.openNowPlaying'), 'data-tip': t('transport.openNowPlaying'), onclick: () => app.toggleStage() });
    this.artBox.addEventListener('mousedown', (e) => e.preventDefault());
    this.titleEl = h('div', { class: 'mp-bar-title ellipsis' });
    this.subEl = h('div', { class: 'mp-bar-sub caption text-2 ellipsis' });
    this.tLeft = h('span', { class: 'mp-time mp-elapsed', 'aria-label': t('transport.elapsed') }, '0:00');
    this.tRight = h('button', { class: 'mp-time mp-remaining', 'data-tip': t('transport.timeToggle'), onclick: () => this.toggleRemaining() }, '0:00');
    this.tRight.addEventListener('mousedown', (e) => e.preventDefault());
    this.seek = h('input', { type: 'range', class: 'mp-seekbar', min: '0', max: '1', step: 'any', value: '0', 'aria-label': t('transport.seek'), disabled: true });
    this.seekTip = h('div', { class: 'mp-seek-tip', hidden: true });
    this.seekWrap = h('div', { class: 'mp-seek-wrap' }, this.seek, this.seekTip);
    this.el = h(
      'footer',
      { class: 'mp-bar', role: 'region', 'aria-label': t('transport.label') },
      h('div', { class: 'mp-seek' }, this.tLeft, this.seekWrap, this.tRight),
      h(
        'div',
        { class: 'mp-bar-row' },
        h('div', { class: 'mp-bar-left' }, this.artBox, h('div', { class: 'mp-bar-meta' }, this.titleEl, this.subEl)),
        h('div', { class: 'mp-bar-center' }, this.bShuffle, this.bPrev, this.bPlay, this.bNext, this.bRepeat),
        h('div', { class: 'mp-bar-right' }, this.bVol, this.bFull, this.bMini, this.bMore),
      ),
    );
    this._bindSeek();
    this._raf = 0;
    this._loop = this._loop.bind(this);
  }

  _bindSeek() {
    const s = this.seek;
    const app = this.app;
    s.addEventListener('input', () => {
      this.dragging = true;
      this._paintSeek();
      this.tLeft.textContent = formatTime(Number(s.value));
    });
    s.addEventListener('change', () => {
      app.player.seek(Number(s.value));
      this.dragging = false;
    });
    s.addEventListener('pointerup', () => setTimeout(() => (this.dragging = false), 0));
    s.addEventListener('keydown', (e) => {
      const d = app.player.duration;
      if (!d) return;
      const step = { ArrowLeft: -5, ArrowRight: 5, ArrowDown: -5, ArrowUp: 5, PageDown: -30, PageUp: 30 }[e.key];
      if (step !== undefined) {
        e.preventDefault();
        e.stopPropagation();
        app.player.seekBy(step);
      } else if (e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        e.stopPropagation();
        app.player.seek(e.key === 'Home' ? 0 : d - 0.5);
      }
    });
    s.addEventListener('pointermove', (e) => {
      const d = app.player.duration;
      if (!d) return;
      const r = s.getBoundingClientRect();
      const f = clamp((e.clientX - r.left) / r.width, 0, 1);
      this.seekTip.hidden = false;
      this.seekTip.textContent = formatTime(f * d);
      this.seekTip.style.left = `${f * 100}%`;
    });
    s.addEventListener('pointerleave', () => (this.seekTip.hidden = true));
  }

  _paintSeek() {
    const max = Number(this.seek.max) || 1;
    this.seek.style.setProperty('--val', `${(Number(this.seek.value) / max) * 100}%`);
  }

  toggleRemaining() {
    this.showRemaining = !this.showRemaining;
    this.app.setPref('showRemaining', this.showRemaining);
    this.updateTime();
  }

  updateTime() {
    const p = this.app.player;
    const d = p.duration;
    const cur = p.currentTime;
    this.seek.disabled = !p.loaded || !d;
    if (!this.dragging) {
      this.seek.max = String(d || 1);
      this.seek.value = String(Math.min(cur, d || 0));
      this.seek.setAttribute('aria-valuetext', `${formatTime(cur)} / ${formatTime(d)}`);
      this._paintSeek();
      this.tLeft.textContent = formatTime(cur);
    }
    this.tRight.textContent = this.showRemaining && d ? `-${formatTime(Math.max(0, d - cur))}` : formatTime(d);
    this.tRight.setAttribute('aria-label', this.showRemaining ? this.app.t('transport.remaining') : this.app.t('transport.total'));
  }

  // Smooth progress while playing (timeupdate only fires ~4x per second).
  _loop() {
    this._raf = 0;
    this.updateTime();
    if (!this.app.player.paused && this.el.isConnected) this._raf = requestAnimationFrame(this._loop);
  }
  startLoop() {
    if (!this._raf && !this.app.player.paused) this._raf = requestAnimationFrame(this._loop);
  }

  setIcon(btn, name, filled = false) {
    btn.querySelector('.icon')?.replaceWith(this.app.icon(name, { filled }));
  }
  label(btn, text) {
    btn.setAttribute('aria-label', text);
    btn.dataset.tip = text;
  }

  update() {
    const { app } = this;
    const { t, player, queue } = app;
    const e = app.currentEntry();
    const has = !!queue.current;
    // Now playing text + art
    this.titleEl.textContent = e ? app.titleOf(e) : '';
    this.subEl.textContent = e ? (e.kind === 'video' ? t('kind.video') : [app.artistOf(e), e.album].filter(Boolean).join(' · ')) : '';
    const artKey = e ? `${e.path}|${e.art || e.thumb || ''}` : '';
    if (this._artKey !== artKey) {
      this._artKey = artKey;
      this.artBox.replaceChildren(e ? entryArt(app, e) : app.h('div', { class: 'mp-art gen mp-art-none' }, app.icon('music_note_2', { class: 'mp-art-glyph' })));
    }
    this.artBox.disabled = !has;
    this.el.classList.toggle('no-media', !has);
    // Play / pause
    const playing = !player.paused;
    this.setIcon(this.bPlay, playing ? 'pause' : 'play', true);
    this.label(this.bPlay, playing ? t('transport.pause') : t('transport.play'));
    this.bPlay.classList.toggle('playing', playing);
    this.bPrev.disabled = !has;
    this.bNext.disabled = !has || queue.peekNext() < 0;
    // Modes
    this.setIcon(this.bShuffle, queue.shuffle ? 'arrow_shuffle' : 'arrow_shuffle_off');
    this.bShuffle.classList.toggle('on', queue.shuffle);
    this.bShuffle.setAttribute('aria-pressed', String(queue.shuffle));
    this.label(this.bShuffle, queue.shuffle ? t('transport.shuffleOn') : t('transport.shuffleOff'));
    const rep = queue.repeat;
    this.setIcon(this.bRepeat, rep === 'one' ? 'arrow_repeat_1' : rep === 'all' ? 'arrow_repeat_all' : 'arrow_repeat_all_off');
    this.bRepeat.classList.toggle('on', rep !== 'off');
    this.bRepeat.dataset.mode = rep;
    this.label(this.bRepeat, t(`transport.repeat_${rep}`));
    this.updateVolume();
    this.bFull.disabled = !has;
    this.setIcon(this.bFull, app.win.fullscreen ? 'full_screen_minimize' : 'full_screen_maximize');
    this.label(this.bFull, app.win.fullscreen ? t('transport.exitFullscreen') : t('transport.fullscreen'));
    this.bMini.disabled = !has && !app.mini;
    this.setIcon(this.bMini, app.mini ? 'picture_in_picture_exit' : 'picture_in_picture_enter');
    this.label(this.bMini, app.mini ? t('transport.exitMini') : t('transport.mini'));
    this.updateTime();
    this.startLoop();
  }

  updateVolume() {
    const p = this.app.player;
    const v = p.muted ? 0 : p.volume;
    const ic = p.muted || v === 0 ? 'speaker_mute' : v < 0.34 ? 'speaker_0' : v < 0.67 ? 'speaker_1' : 'speaker_2';
    this.setIcon(this.bVol, ic);
    this.label(this.bVol, p.muted ? this.app.t('transport.volumeMuted') : this.app.t('transport.volumeValue', { v: Math.round(p.volume * 100) }));
    if (this.fly) {
      this.flySlider.setValue(Math.round(p.volume * 100));
      this.flyValue.textContent = String(Math.round(p.volume * 100));
      this.flyMute.replaceChildren(this.app.icon(p.muted ? 'speaker_mute' : 'speaker_2'));
      this.flyMute.setAttribute('aria-label', p.muted ? this.app.t('transport.unmute') : this.app.t('transport.mute'));
      this.flyMute.dataset.tip = this.flyMute.getAttribute('aria-label');
    }
  }

  // ---------------------------------------------------------------- volume flyout
  toggleVolume(ev) {
    if (this.fly) return this.closeVolume();
    const { app } = this;
    const { h, t, ui } = app;
    this.flyMute = h('button', { class: 'btn subtle icon-btn mp-fly-mute', onclick: () => app.setMuted(!app.player.muted) });
    this.flySlider = ui.slider({ min: 0, max: 100, value: Math.round(app.player.volume * 100), oninput: (v) => app.setVolume(v / 100) });
    this.flySlider.classList.add('mp-fly-slider');
    this.flySlider.setAttribute('aria-label', t('transport.volume'));
    this.flyValue = h('span', { class: 'mp-fly-value' });
    this.fly = h('div', { class: 'mp-flyout mp-vol-fly', role: 'dialog', 'aria-label': t('transport.volume') }, this.flyMute, this.flySlider, this.flyValue);
    const host = app.win.el;
    host.appendChild(this.fly);
    const br = this.bVol.getBoundingClientRect();
    const hr = host.getBoundingClientRect();
    const fw = this.fly.offsetWidth;
    const left = clamp(br.left + br.width / 2 - fw / 2 - hr.left, 8, hr.width - fw - 8);
    this.fly.style.left = `${left}px`;
    this.fly.style.bottom = `${hr.bottom - br.top + 6}px`;
    this.updateVolume();
    this.bVol.setAttribute('aria-expanded', 'true');
    // Keyboard activation (detail 0) moves focus into the flyout; a click leaves it on the content.
    if (!ev || ev.detail === 0) setTimeout(() => this.flySlider.focus(), 30);
    this._outside = (e) => {
      if (!this.fly?.contains(e.target) && !this.bVol.contains(e.target)) this.closeVolume();
    };
    this._esc = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        this.closeVolume();
        app.focusContent();
      }
    };
    document.addEventListener('pointerdown', this._outside, true);
    this.fly.addEventListener('keydown', this._esc);
  }
  closeVolume() {
    if (!this.fly) return;
    document.removeEventListener('pointerdown', this._outside, true);
    const f = this.fly;
    this.fly = null;
    this.bVol.setAttribute('aria-expanded', 'false');
    f.classList.add('closing');
    setTimeout(() => f.remove(), 120);
  }
}
