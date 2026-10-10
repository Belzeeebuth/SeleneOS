// Media Player engine: one <video> element plays audio and video (src = api.mediaUrl(path),
// Range-seekable media:// URLs), routed through WebAudio (MediaElementSource -> gain -> speakers,
// and -> AnalyserNode for the visualizer).
//
//   const p = new Player({ api });
//   p.load(path, { autoplay, at })  p.play() p.pause() p.toggle() p.seek(t) p.seekBy(dt) p.stop()
//   p.setVolume(0..1) p.setMuted(bool) p.setRate(x)
//   p.on('time'|'state'|'meta'|'ended'|'error'|'volume'|'rate'|'buffering'|'load', fn)
import { clamp } from './util.js';

export class Player {
  constructor({ api }) {
    this.api = api;
    this.el = document.createElement('video');
    this.el.className = 'mp-video';
    this.el.playsInline = true;
    this.el.preload = 'auto';
    this.el.crossOrigin = 'anonymous';
    this.el.disablePictureInPicture = true;
    this.el.setAttribute('aria-hidden', 'true');
    this.path = null;
    this.volume = 0.8;
    this.muted = false;
    this.rate = 1;
    this._at = 0;
    this._subs = new Map();
    this.ctx = null;
    this.analyser = null;
    this.gain = null;
    const el = this.el;
    const fire =
      (ev, ...a) =>
      () =>
        this._emit(ev, ...a);
    el.addEventListener('timeupdate', fire('time'));
    el.addEventListener('seeked', fire('time'));
    el.addEventListener('play', fire('state'));
    el.addEventListener('pause', fire('state'));
    el.addEventListener('playing', () => {
      this._emit('buffering', false);
      this._emit('state');
    });
    el.addEventListener('waiting', fire('buffering', true));
    el.addEventListener('ended', fire('ended'));
    el.addEventListener('ratechange', fire('rate'));
    el.addEventListener('durationchange', fire('meta'));
    el.addEventListener('loadedmetadata', () => {
      if (this._at > 0 && Number.isFinite(el.duration) && this._at < el.duration - 1) el.currentTime = this._at;
      this._at = 0;
      this._emit('meta');
      this._emit('time');
    });
    el.addEventListener('error', () => {
      if (!this.path || !el.error) return;
      this._emit('error', { code: el.error.code, message: el.error.message, path: this.path });
    });
    this._applyVolume();
  }

  on(ev, fn) {
    if (!this._subs.has(ev)) this._subs.set(ev, new Set());
    this._subs.get(ev).add(fn);
    return () => this._subs.get(ev)?.delete(fn);
  }
  _emit(ev, ...a) {
    for (const fn of [...(this._subs.get(ev) || [])]) {
      try {
        fn(...a);
      } catch (err) {
        console.error(`[media] player ${ev} listener failed`, err);
      }
    }
  }

  // WebAudio graph, created lazily (an element can only ever get one MediaElementSource).
  _graph() {
    if (this.ctx || this._graphFailed) return;
    try {
      const ctx = new AudioContext({ latencyHint: 'playback' });
      const src = ctx.createMediaElementSource(this.el);
      const gain = ctx.createGain();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.72;
      src.connect(gain);
      gain.connect(ctx.destination);
      src.connect(analyser);
      this.ctx = ctx;
      this.gain = gain;
      this.analyser = analyser;
      this._applyVolume();
    } catch (err) {
      console.warn('[media] WebAudio unavailable, playing without visualizer', err);
      this._graphFailed = true;
    }
  }
  _applyVolume() {
    // Perceptual curve: the slider is linear, loudness is not.
    const v = this.muted ? 0 : this.volume ** 2;
    if (this.gain) {
      this.el.volume = 1;
      this.gain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
    } else this.el.volume = clamp(v, 0, 1);
  }

  get currentTime() {
    return this.el.currentTime || 0;
  }
  get duration() {
    const d = this.el.duration;
    return Number.isFinite(d) ? d : 0;
  }
  get paused() {
    return this.el.paused;
  }
  get loaded() {
    return !!this.path;
  }
  get hasVideo() {
    return this.el.videoWidth > 0;
  }
  get buffering() {
    return !this.el.paused && this.el.readyState < 3;
  }

  load(path, { autoplay = true, at = 0 } = {}) {
    this._graph();
    this.path = path;
    this._at = at > 0 ? at : 0;
    this.el.src = this.api.mediaUrl(path);
    this.el.defaultPlaybackRate = this.rate;
    this.el.playbackRate = this.rate;
    this._emit('load', path);
    if (autoplay) this.play();
    else this.el.load();
  }
  play() {
    if (!this.path) return Promise.resolve(false);
    this._graph();
    if (this.ctx?.state === 'suspended') this.ctx.resume().catch(() => {});
    return this.el.play().then(
      () => true,
      (err) => {
        // Unsupported sources also fire 'error' on the element, which is reported there.
        if (err?.name !== 'AbortError' && err?.name !== 'NotSupportedError') console.warn('[media] play() failed', err);
        return false;
      },
    );
  }
  pause() {
    this.el.pause();
  }
  toggle() {
    if (this.el.paused) return this.play();
    this.pause();
    return Promise.resolve(false);
  }
  seek(t) {
    if (!this.path) return;
    const d = this.duration;
    this.el.currentTime = clamp(t, 0, d > 0 ? Math.max(0, d - 0.05) : t);
    this._emit('time');
  }
  seekBy(dt) {
    this.seek(this.currentTime + dt);
  }
  stop() {
    this.path = null;
    this.el.pause();
    this.el.removeAttribute('src');
    this.el.load();
    this._emit('load', null);
    this._emit('state');
    this._emit('time');
  }
  setVolume(v) {
    this.volume = clamp(Number(v) || 0, 0, 1);
    if (this.volume > 0 && this.muted) this.muted = false;
    this._applyVolume();
    this._emit('volume');
  }
  setMuted(m) {
    this.muted = !!m;
    this._applyVolume();
    this._emit('volume');
  }
  setRate(r) {
    this.rate = clamp(Number(r) || 1, 0.25, 4);
    this.el.defaultPlaybackRate = this.rate;
    this.el.playbackRate = this.rate;
    this._emit('rate');
  }
  destroy() {
    this._subs.clear();
    this.stop();
    this.ctx?.close().catch(() => {});
  }
}
