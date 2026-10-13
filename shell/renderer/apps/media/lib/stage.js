// Media Player "now playing" stage: immersive view over the library.
//   audio: blurred artwork backdrop, large artwork, title / artist / album, "up next" and the
//          WebAudio visualizer;
//   video: the <video> fills the stage; click toggles play, double-click toggles full screen;
//   mini player: artwork or video with compact hover controls.
import { artColors, formatTime } from './util.js';
import { entryArt } from './components.js';
import { Visualizer } from './visualizer.js';
import { parseLrc, lineAt, lrcPathOf } from './lyrics.js';
import { readTags, urlReader } from './tags.js';

export class Stage {
  constructor(app) {
    this.app = app;
    const { h, t, icon } = app;
    this.bgImg = h('div', { class: 'mp-stage-bg-img' });
    this.bg = h('div', { class: 'mp-stage-bg' }, this.bgImg);
    this.videoHost = h('div', { class: 'mp-video-host' }, app.player.el);
    this.artWrap = h('div', { class: 'mp-np-art' });
    this.npTitle = h('div', { class: 'mp-np-title' });
    this.npArtist = h('div', { class: 'mp-np-artist' });
    this.npAlbum = h('div', { class: 'mp-np-album' });
    this.npNext = h('div', { class: 'mp-np-next caption' });
    this.np = h(
      'div',
      { class: 'mp-np' },
      this.artWrap,
      h('div', { class: 'mp-np-meta' }, h('div', { class: 'mp-np-kicker caption' }, t('np.nowPlaying')), this.npTitle, this.npArtist, this.npAlbum, this.npNext),
    );
    // Lyrics: the .lrc file next to the track (synced: the current line is highlighted) or the embedded lyrics.
    this.lyricsList = h('div', { class: 'mp-lyrics-list', role: 'list' });
    this.lyricsEl = h('div', { class: 'mp-lyrics', hidden: true, 'aria-label': t('np.lyrics') }, h('div', { class: 'mp-np-kicker caption' }, t('np.lyrics')), this.lyricsList);
    this.np.appendChild(this.lyricsEl);
    this.canvas = h('canvas', { class: 'mp-viz', 'aria-hidden': 'true' });
    this.viz = new Visualizer(this.canvas, () => app.player.analyser, { style: app.prefs.visualizer || 'bars', isPlaying: () => !app.player.paused });
    this.back = h('button', { class: 'btn subtle icon-btn mp-stage-back', 'aria-label': t('nav.back'), 'data-tip': t('nav.back'), onclick: () => app.closeStage() }, icon('arrow_left'));
    this.vTitle = h('div', { class: 'mp-stage-title ellipsis' });
    this.top = h('div', { class: 'mp-stage-top' }, this.back, this.vTitle);
    this.spinner = h('div', { class: 'spinner mp-stage-spin', hidden: true });
    // Mini player controls
    const mb = (cls, ic, label, fn) => {
      const b = h('button', { class: ['mp-mini-btn', cls], 'aria-label': label, 'data-tip': label, onclick: fn }, icon(ic, { filled: true }));
      b.addEventListener('mousedown', (e) => e.preventDefault());
      return b;
    };
    this.miniPlay = mb('mp-mini-play', 'play', t('transport.play'), () => app.togglePlay());
    this.miniTitle = h('div', { class: 'mp-mini-title ellipsis' });
    this.miniSub = h('div', { class: 'mp-mini-sub ellipsis' });
    this.miniBar = h('div', { class: 'mp-mini-progress' }, h('div', { class: 'mp-mini-fill' }));
    this.mini = h(
      'div',
      { class: 'mp-mini-ctl' },
      h(
        'div',
        { class: 'mp-mini-top' },
        mb('mp-mini-exit', 'picture_in_picture_exit', t('transport.exitMini'), () => app.toggleMini(false)),
      ),
      h('div', { class: 'mp-mini-meta' }, this.miniTitle, this.miniSub),
      h(
        'div',
        { class: 'mp-mini-row' },
        mb('mp-mini-prev', 'previous', t('transport.previous'), () => app.prev()),
        this.miniPlay,
        mb('mp-mini-next', 'next', t('transport.next'), () => app.next()),
      ),
      this.miniBar,
    );
    this.el = h('div', { class: 'mp-stage', 'aria-hidden': 'true' }, this.bg, this.videoHost, this.canvas, this.np, this.spinner, this.top, this.mini);
    // Video: single click toggles playback, double click toggles full screen.
    let clickTimer = null;
    this.videoHost.addEventListener('click', () => {
      clearTimeout(clickTimer);
      clickTimer = setTimeout(() => app.togglePlay(), 230);
    });
    this.videoHost.addEventListener('dblclick', () => {
      clearTimeout(clickTimer);
      app.toggleFullscreen();
    });
    this.np.addEventListener('dblclick', () => app.toggleFullscreen());
  }

  update() {
    const { app } = this;
    const e = app.currentEntry();
    const isVideo = app.isVideo();
    this.el.classList.toggle('video', isVideo);
    const key = e ? `${e.path}|${e.art || ''}|${e.thumb || ''}` : '';
    this.loadLyrics(e).catch(() => {});
    if (key !== this._key) {
      this._key = key;
      this.artWrap.replaceChildren(e ? entryArt(app, e) : app.h('div'));
      const [c1, c2] = artColors(e?.album || e?.path || 'aurora');
      this.el.style.setProperty('--np1', c1);
      this.el.style.setProperty('--np2', c2);
      const img = e && (e.art || e.thumb);
      this.bgImg.style.backgroundImage = img ? `url("${app.api.mediaUrl(img)}")` : '';
      this.bgImg.classList.toggle('has-img', !!img);
      if (img) this._tint(app.api.mediaUrl(img), key);
      else this.viz.setColors(['rgba(255,255,255,0.28)', 'rgba(255,255,255,0.92)']);
    }
    const title = e ? app.titleOf(e) : '';
    this.npTitle.textContent = title;
    this.npArtist.textContent = e && e.kind !== 'video' ? app.artistOf(e) : '';
    this.npAlbum.textContent = e?.album || '';
    const n = app.queue.peekNext();
    const nextEntry = n >= 0 && n !== app.queue.index ? app.lib.get(app.queue.items[n].path) || { path: app.queue.items[n].path, guessTitle: app.queue.items[n].path.split('/').pop() } : null;
    this.npNext.textContent = nextEntry ? app.t('np.upNext', { title: app.titleOf(nextEntry) }) : '';
    this.vTitle.textContent = title;
    this.miniTitle.textContent = title;
    this.miniSub.textContent = e && e.kind !== 'video' ? app.artistOf(e) : '';
    const playing = !app.player.paused;
    this.miniPlay.replaceChildren(app.icon(playing ? 'pause' : 'play', { filled: true }));
    this.miniPlay.setAttribute('aria-label', playing ? app.t('transport.pause') : app.t('transport.play'));
    this.miniPlay.dataset.tip = this.miniPlay.getAttribute('aria-label');
    this.updateTime();
    this.syncViz();
  }

  /** Tint the backdrop with the artwork's own colours (top / bottom averages). */
  _tint(url, key) {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      if (this._key !== key) return;
      try {
        const c = document.createElement('canvas');
        c.width = 4;
        c.height = 4;
        const g = c.getContext('2d', { willReadFrequently: true });
        g.drawImage(img, 0, 0, 4, 4);
        const d = g.getImageData(0, 0, 4, 4).data;
        const avg = (y0, y1) => {
          const s = [0, 0, 0];
          for (let y = y0; y < y1; y++) for (let x = 0; x < 4; x++) for (let k = 0; k < 3; k++) s[k] += d[(y * 4 + x) * 4 + k];
          const n = (y1 - y0) * 4;
          return s.map((v) => Math.round(v / n));
        };
        const top = avg(0, 2);
        const bottom = avg(2, 4);
        const all = avg(0, 4);
        const toward = (c, f) => c.map((v) => Math.round(v + (255 - v) * f)).join(',');
        this.el.style.setProperty('--np1', `rgb(${top.join(' ')})`);
        this.el.style.setProperty('--np2', `rgb(${bottom.join(' ')})`);
        // Visualizer: the artwork's colour, lifted towards white so it reads on the dark backdrop.
        this.viz.setColors([`rgba(${toward(all, 0.35)},0.35)`, `rgba(${toward(all, 0.7)},0.95)`]);
      } catch {}
    };
    img.src = url;
  }

  /** Finds and shows the lyrics of the current audio track (once per track). */
  async loadLyrics(e) {
    const path = e && e.kind === 'audio' ? e.path : null;
    if (path === this._lyrPath) return;
    this._lyrPath = path;
    this.lyrics = null;
    this._lyrIdx = -1;
    this.lyricsList.replaceChildren();
    this.lyricsEl.hidden = true;
    this.el.classList.remove('has-lyrics');
    if (!path) return;
    const { api } = this.app;
    let text = null;
    const lrc = lrcPathOf(path);
    if (await api.invoke('fs:exists', lrc).catch(() => false)) text = await api.invoke('fs:readText', lrc, { maxBytes: 512 * 1024 }).catch(() => null);
    if (!text) {
      try {
        text = (await readTags(urlReader(api.mediaUrl(path), e.size), e.ext)).lyrics || null;
      } catch {}
    }
    if (this._lyrPath !== path || this.app._destroyed || typeof text !== 'string') return;
    const parsed = parseLrc(text);
    if (!parsed.lines.some((l) => l.text)) return;
    this.lyrics = parsed;
    const { h } = this.app;
    this.lyricsEl.classList.toggle('synced', parsed.synced);
    this.lyricsList.replaceChildren(
      ...parsed.lines.map((l, i) =>
        h(
          'div',
          {
            class: 'mp-lyr-line',
            role: 'listitem',
            dataset: { i: String(i) },
            onclick: parsed.synced ? () => this.app.player.seek(l.t) : null,
          },
          l.text || '\u266a',
        ),
      ),
    );
    this.lyricsEl.hidden = false;
    this.el.classList.add('has-lyrics');
    this.syncLyrics(this.app.player.currentTime);
  }
  syncLyrics(time) {
    if (!this.lyrics?.synced) return;
    const i = lineAt(this.lyrics.lines, time);
    if (i === this._lyrIdx) return;
    this.lyricsList.children[this._lyrIdx]?.classList.remove('current');
    this._lyrIdx = i;
    const el = this.lyricsList.children[i];
    if (!el) return;
    el.classList.add('current');
    const box = this.lyricsList;
    box.scrollTo({ top: el.offsetTop - box.clientHeight / 2 + el.offsetHeight / 2, behavior: document.documentElement.dataset.animations === 'off' ? 'auto' : 'smooth' });
  }

  updateTime() {
    this.syncLyrics(this.app.player.currentTime);
    const p = this.app.player;
    const d = p.duration;
    this.miniBar.firstChild.style.transform = `scaleX(${d ? Math.min(1, p.currentTime / d) : 0})`;
    this.miniBar.title = `${formatTime(p.currentTime)} / ${formatTime(d)}`;
  }

  setBuffering(on) {
    clearTimeout(this._spinT);
    if (on) this._spinT = setTimeout(() => (this.spinner.hidden = false), 400);
    else this.spinner.hidden = true;
  }

  /** Run the visualizer only when it can be seen. */
  syncViz() {
    const { app } = this;
    const style = app.prefs.visualizer || 'bars';
    this.viz.setStyle(style);
    const animOff = document.documentElement.dataset.animations === 'off';
    const visible = app.stageOpen && !app.isVideo() && style !== 'off' && !animOff && !app.mini;
    this.canvas.hidden = !visible;
    if (visible) this.viz.start();
    else this.viz.stop();
  }
}
