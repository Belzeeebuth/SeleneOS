// Podcast player engine: one <audio> element (src = api.mediaUrl(downloaded file), Range-seekable media:// URLs; the
// shell CSP allows no remote media, so episodes are downloaded first), speed 0.8–2×, skips, sleep timer.
//
//   const p = new PodcastPlayer({ api });
//   p.load(key, path, { at, autoplay, rate })   p.play() p.pause() p.toggle() p.seek(t) p.skip(dt) p.setRate(r)
//   p.setSleep(minutes | 'end' | null)   p.sleepLeft (s | 'end' | null)
//   p.on('state'|'time'|'meta'|'ended'|'error'|'sleep', fn) -> off
export const SPEEDS = [0.8, 1, 1.2, 1.5, 1.75, 2];

export class PodcastPlayer {
  constructor({ api }) {
    this.api = api;
    this.el = document.createElement('audio');
    this.el.preload = 'auto';
    this.el.className = 'fd-audio';
    this.key = null;
    this.path = null;
    this.rate = 1;
    this._at = 0;
    this._subs = new Map();
    this.sleep = null; // { until: ms } | { end: true }
    this._sleepTimer = null;
    const el = this.el;
    const fire = (ev) => () => this._emit(ev);
    el.addEventListener('timeupdate', fire('time'));
    el.addEventListener('seeked', fire('time'));
    el.addEventListener('play', fire('state'));
    el.addEventListener('pause', fire('state'));
    el.addEventListener('playing', fire('state'));
    el.addEventListener('waiting', fire('state'));
    el.addEventListener('ratechange', fire('state'));
    el.addEventListener('durationchange', fire('meta'));
    el.addEventListener('loadedmetadata', () => {
      if (this._at > 0 && Number.isFinite(el.duration) && this._at < el.duration - 2) el.currentTime = this._at;
      this._at = 0;
      this._emit('meta');
      this._emit('time');
    });
    el.addEventListener('ended', () => {
      if (this.sleep?.end) this.setSleep(null);
      this._emit('ended');
      this._emit('state');
    });
    el.addEventListener('error', () => {
      if (!this.path || !el.error) return;
      this._emit('error', { code: el.error.code, message: el.error.message });
    });
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
        console.error(`[feeds] player ${ev} listener failed`, err);
      }
    }
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

  load(key, path, { at = 0, autoplay = true, rate } = {}) {
    this.key = key;
    this.path = path;
    this._at = at > 0 ? at : 0;
    if (rate) this.rate = rate;
    this.el.src = this.api.mediaUrl(path);
    this.el.defaultPlaybackRate = this.rate;
    this.el.playbackRate = this.rate;
    this._emit('state');
    if (autoplay) return this.play();
    this.el.load();
    return Promise.resolve(false);
  }
  play() {
    if (!this.path) return Promise.resolve(false);
    return this.el.play().then(
      () => true,
      (err) => {
        if (err?.name !== 'AbortError' && err?.name !== 'NotSupportedError') console.warn('[feeds] play() failed', err);
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
    this.el.currentTime = Math.max(0, d > 0 ? Math.min(t, Math.max(0, d - 0.25)) : t);
    this._emit('time');
  }
  skip(dt) {
    this.seek(this.currentTime + dt);
  }
  setRate(r) {
    const v = Math.min(3, Math.max(0.5, Number(r) || 1));
    this.rate = v;
    this.el.defaultPlaybackRate = v;
    this.el.playbackRate = v;
    this._emit('state');
  }
  setVolume(v) {
    this.el.volume = Math.min(1, Math.max(0, Number(v)));
  }

  /** Pause after `minutes`, at the end of the episode ('end'), or never (null). */
  setSleep(v) {
    clearInterval(this._sleepTimer);
    this._sleepTimer = null;
    if (v === 'end') this.sleep = { end: true };
    else if (Number(v) > 0) {
      this.sleep = { until: Date.now() + Number(v) * 60000 };
      this._sleepTimer = setInterval(() => {
        if (!this.sleep?.until) return;
        if (Date.now() >= this.sleep.until) {
          this.pause();
          this.setSleep(null);
        } else this._emit('sleep');
      }, 1000);
    } else this.sleep = null;
    this._emit('sleep');
  }
  /** Seconds left on the sleep timer, 'end', or null. */
  get sleepLeft() {
    if (!this.sleep) return null;
    if (this.sleep.end) return 'end';
    return Math.max(0, Math.round((this.sleep.until - Date.now()) / 1000));
  }

  stop() {
    this.key = null;
    this.path = null;
    this.el.pause();
    this.el.removeAttribute('src');
    this.el.load();
    this.setSleep(null);
    this._emit('state');
    this._emit('time');
  }
  destroy() {
    this.stop();
    this._subs.clear();
  }
}
