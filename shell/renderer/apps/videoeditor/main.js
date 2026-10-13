// Video Editor (Éditeur vidéo): a project with a media bin, a video track and a music track, a preview player kept in
// step with the timeline, title cards and text over the picture, fades, per-clip volume, undo / redo, projects saved
// as JSON in ~/Vidéos/Projets, and MP4 export (H.264 + AAC, 720p / 1080p) through ffmpeg (main/ipc/videoeditor.js).
// The project model and the timeline maths are in lib/model.js. Keyboard: Space / K play-pause, J / L back / forward
// 5 s, ← → 1 frame-ish (0.1 s), Home / End, S split, Delete, Ctrl+Z / Ctrl+Y (Ctrl+Shift+Z), Ctrl+S, Ctrl+O, Ctrl+E,
// Ctrl+N, + / - zoom. The window element carries `__videoeditor` (the app object) for the tests.
import * as M from './lib/model.js';
import { trustedDragPaths } from '../../core/desktop.js';

const VIDEO_EXT = ['.mp4', '.m4v', '.webm', '.mkv', '.mov', '.ogv', '.avi'];
const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif'];
const AUDIO_EXT = ['.mp3', '.wav', '.ogg', '.oga', '.opus', '.flac', '.m4a', '.aac'];
const ALL_EXT = [...VIDEO_EXT, ...IMAGE_EXT, ...AUDIO_EXT];
const BIN_MIME = 'application/x-videoeditor-media';
const ext = (p) => (/\.[^./]+$/.exec(p)?.[0] || '').toLowerCase();
const base = (p) => p.split('/').pop();
const dirOf = (p) => p.slice(0, p.lastIndexOf('/')) || '/';
const FADES = [0, 0.5, 1, 2];

export default {
  async launch(ctx) {
    const app = new VideoEditor(ctx);
    await app.init();
    return { onRelaunch: (args) => app.onArgs(args) };
  },
};

class VideoEditor {
  constructor(ctx) {
    Object.assign(this, { ctx, win: ctx.win, h: ctx.h, ui: ctx.ui, t: ctx.t, api: ctx.api, shell: ctx.shell, icon: ctx.icon });
    this.p = M.newProject(this.t('untitled'));
    this.hist = M.history();
    this.file = null; // saved path
    this.dirty = false;
    this.sel = null; // selected clip id
    this.time = 0;
    this.playing = false;
    this.pps = 40; // timeline pixels per second
    this.job = null; // running export
    this.win.el.__videoeditor = this;
  }

  async init() {
    const { h, t } = this;
    this.xdg = await this.api.invoke('fs:xdg').catch(() => ({}));
    this.tools = await this.api.invoke('videoeditor:tools').catch(() => ({ ffmpeg: false, ffprobe: false }));
    const btn = (ic, label, onclick, cls = 'subtle', text) =>
      h('button', { class: ['btn', cls, 've-btn'], title: label, 'aria-label': label, onclick }, this.icon(ic, { size: 18 }), text ? h('span', {}, text) : null);
    this.nameInput = h('input', { class: 'input ve-name', 'aria-label': t('projectName'), value: this.p.name, maxlength: 80, onchange: () => this.rename(this.nameInput.value) });
    this.undoBtn = btn('arrow-counter-clockwise', `${t('undo')} (Ctrl+Z)`, () => this.undo());
    this.redoBtn = btn('arrow-clockwise', `${t('redo')} (Ctrl+Y)`, () => this.redo());
    this.exportBtn = h('button', { class: 'btn primary ve-export', onclick: () => this.exportDialog() }, this.icon('export', { size: 18 }), h('span', {}, t('export')));
    const toolbar = h(
      'div',
      { class: 'toolbar ve-toolbar' },
      btn('file-plus', `${t('new')} (Ctrl+N)`, () => this.newProject(), 'subtle', t('new')),
      btn('folder-open', `${t('open')} (Ctrl+O)`, () => this.openDialog(), 'subtle', t('open')),
      btn('floppy-disk', `${t('save')} (Ctrl+S)`, () => this.save(), 'subtle', t('save')),
      h('span', { class: 've-sep' }),
      this.undoBtn,
      this.redoBtn,
      h('span', { class: 've-sep' }),
      this.nameInput,
      h('span', { class: 've-grow' }),
      this.exportBtn,
    );
    // media bin
    this.binList = h('div', { class: 've-bin-list', role: 'list' });
    const bin = h(
      'section',
      { class: 've-bin', 'aria-label': t('media') },
      h('div', { class: 've-head' }, h('h2', { class: 've-h' }, t('media')), h('button', { class: 'btn ve-import', onclick: () => this.importDialog() }, this.icon('plus', { size: 16 }), h('span', {}, t('import')))),
      this.binList,
    );
    // preview
    this.vid = h('video', { class: 've-vid', preload: 'auto', playsinline: true });
    this.img = h('img', { class: 've-img', alt: '' });
    this.titleBg = h('div', { class: 've-titlebg' });
    this.overlay = h('div', { class: 've-overlay' });
    this.picture = h('div', { class: 've-picture' }, this.titleBg, this.vid, this.img, this.overlay);
    this.stageEmpty = h('div', { class: 've-stage-empty' }, t('previewEmpty'));
    this.stage = h('div', { class: 've-stage' }, this.picture, this.stageEmpty);
    this.aud = h('audio', { preload: 'auto' });
    this.playBtn = h('button', { class: 'btn subtle ve-play', onclick: () => this.toggle() });
    this.timeLabel = h('span', { class: 've-time' });
    const preview = h(
      'section',
      { class: 've-preview' },
      h('div', { class: 've-stage-wrap' }, this.stage),
      h(
        'div',
        { class: 've-transport' },
        btn('skip-back', t('toStart'), () => this.seek(0)),
        btn('rewind', t('back'), () => this.seek(this.time - 5)),
        this.playBtn,
        btn('fast-forward', t('forward'), () => this.seek(this.time + 5)),
        this.timeLabel,
      ),
      this.aud,
    );
    this.inspector = h('aside', { class: 've-inspector', 'aria-label': t('inspector') });
    // timeline
    this.zoomSlider = this.ui.slider({ min: 8, max: 200, value: this.pps, oninput: (v) => this.setZoom(Number(v)) });
    this.zoomSlider.classList.add('ve-zoom');
    this.zoomSlider.setAttribute('aria-label', t('zoom'));
    const tbar = h(
      'div',
      { class: 've-tbar' },
      btn('scissors', t('split'), () => this.split(), 'subtle', null),
      btn('trash', t('delete'), () => this.deleteSel(), 'subtle', null),
      btn('text-t', t('addTitle'), () => this.addTitle(), 'subtle', t('titleCard')),
      h('span', { class: 've-grow' }),
      btn('magnifying-glass-minus', t('zoomOut'), () => this.setZoom(this.pps / 1.4)),
      this.zoomSlider,
      btn('magnifying-glass-plus', t('zoomIn'), () => this.setZoom(this.pps * 1.4)),
    );
    tbar.querySelector('[aria-label="' + t('split') + '"]')?.classList.add('ve-split');
    tbar.querySelector('[aria-label="' + t('delete') + '"]')?.classList.add('ve-delete');
    tbar.querySelector('[aria-label="' + t('addTitle') + '"]')?.classList.add('ve-addtitle');
    this.ruler = h('div', { class: 've-ruler' });
    this.laneV = h('div', { class: 've-lane ve-lane-video', dataset: { track: 'video' }, 'aria-label': t('trackVideo') });
    this.laneM = h('div', { class: 've-lane ve-lane-music', dataset: { track: 'music' }, 'aria-label': t('trackMusic') });
    this.playhead = h('div', { class: 've-playhead' }, h('div', { class: 've-playhead-knob' }));
    this.tlInner = h('div', { class: 've-tl-inner' }, this.ruler, this.laneV, this.laneM, this.playhead);
    this.tlScroll = h('div', { class: 've-tl-scroll' }, this.tlInner);
    const heads = h(
      'div',
      { class: 've-heads' },
      h('div', { class: 've-head-ruler' }),
      h('div', { class: 've-track-head', title: t('trackVideo') }, this.icon('film-strip', { size: 18 })),
      h('div', { class: 've-track-head', title: t('trackMusic') }, this.icon('music-notes', { size: 18 })),
    );
    const timeline = h('section', { class: 've-timeline' }, tbar, h('div', { class: 've-tl' }, heads, this.tlScroll));
    this.banner = h('div', { class: 've-banner', hidden: true });
    this.root = h('div', { class: 've-root', tabindex: '-1' }, toolbar, this.banner, h('div', { class: 've-main' }, bin, preview, this.inspector), timeline);
    this.win.body.appendChild(this.root);

    this.bindTimeline();
    this.bindDrops();
    this.root.addEventListener('keydown', (e) => this.onKey(e));
    this.tlScroll.addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      this.setZoom(this.pps * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
    }, { passive: false });
    this.win.onBeforeClose(async () => {
      this.pause();
      if (this.job) await this.cancelExport();
      return this.confirmDiscard();
    });
    this.render();
    if (this.ctx.args?.file) await this.onArgs(this.ctx.args);
  }

  // ---------------------------------------------------------------- state
  change(fn, { soft = false } = {}) {
    if (!soft) this.hist.commit(this.p);
    fn(this.p);
    this.dirty = true;
    this.render();
  }
  undo() {
    const p = this.hist.undo(this.p);
    if (p) this.replace(p);
  }
  redo() {
    const p = this.hist.redo(this.p);
    if (p) this.replace(p);
  }
  replace(p) {
    this.p = p;
    this.dirty = true;
    if (this.sel && !M.find(p, this.sel)) this.sel = null;
    this.render();
  }
  rename(v) {
    const name = v.trim() || this.t('untitled');
    if (name !== this.p.name) this.change((p) => (p.name = name));
  }

  // ---------------------------------------------------------------- media
  async importDialog() {
    const res = await this.ui.filePicker({ mode: 'open', multiple: true, title: this.t('importTitle'), filters: [{ name: this.t('filterMedia'), ext: ALL_EXT }], path: this.xdg.videos, parent: this.win });
    const paths = [].concat(res || []).filter(Boolean);
    if (paths.length) await this.importPaths(paths);
  }
  /** Adds files to the bin; `toTimeline` also puts them on their track (at index `at` of the video track). */
  async importPaths(paths, { toTimeline = false, at } = {}) {
    const added = [];
    for (const path of paths) {
      if (!ALL_EXT.includes(ext(path))) {
        this.toast(this.t('importFailed', { name: base(path) }), 'error');
        continue;
      }
      const info = await this.api.invoke('videoeditor:probe', path).catch(() => null);
      if (!info || info.error) {
        this.toast(this.t('importFailed', { name: base(path) }), 'error');
        continue;
      }
      added.push({ path, name: base(path), ...info });
    }
    if (!added.length) return [];
    let out = [];
    this.change((p) => {
      out = added.map((m) => M.addMedia(p, m));
      if (toTimeline) {
        let i = at;
        for (const m of out) {
          const c = M.addToTimeline(p, m.id, m.kind === 'audio' ? undefined : i);
          if (m.kind !== 'audio' && i != null) i++;
          this.sel = c?.id || this.sel;
        }
      }
    });
    return out;
  }
  addFromBin(mediaId, at) {
    this.change((p) => {
      const c = M.addToTimeline(p, mediaId, at);
      if (c) this.sel = c.id;
    });
  }

  // ---------------------------------------------------------------- editing
  split() {
    const f = this.sel && M.find(this.p, this.sel);
    const track = f?.track === 'music' ? 'music' : 'video';
    if (!M.clipAt(this.p, this.time, track)) return;
    const probe = JSON.parse(JSON.stringify(this.p));
    if (!M.split(probe, this.time, track)) return;
    this.change((p) => {
      const r = M.split(p, this.time, track);
      if (r) this.sel = r[1].id;
    });
  }
  deleteSel() {
    if (!this.sel) return;
    this.change((p) => M.remove(p, this.sel));
    this.sel = null;
    this.render();
  }
  addTitle() {
    const f = this.sel && M.find(this.p, this.sel);
    const at = f?.track === 'video' ? f.index + 1 : M.clipAt(this.p, this.time) ? M.clipAt(this.p, this.time).index + 1 : this.p.video.length;
    this.change((p) => {
      const c = M.addTitle(p, at, { value: this.t('newTitle'), color: '#ffffff' });
      this.sel = c.id;
    });
    this.seek(M.starts(this.p)[at] + 0.01);
    this.inspector.querySelector('textarea')?.focus();
  }
  setZoom(v) {
    this.pps = Math.max(8, Math.min(200, v));
    this.zoomSlider.setValue(Math.round(this.pps));
    this.renderTimeline();
  }

  // ---------------------------------------------------------------- render
  render() {
    this.nameInput.value = this.p.name;
    this.undoBtn.disabled = !this.hist.canUndo;
    this.redoBtn.disabled = !this.hist.canRedo;
    this.win.setTitle(`${this.dirty ? '• ' : ''}${this.p.name} – ${this.ctx.manifest?.name?.[this.lang()] || this.t('untitled')}`);
    this.renderBin();
    this.renderTimeline();
    this.renderInspector();
    this.renderPreview();
  }
  lang() {
    return document.documentElement.lang?.startsWith('fr') ? 'fr' : 'en';
  }
  renderBin() {
    const { h, t } = this;
    this.binList.replaceChildren();
    if (!this.p.media.length) {
      this.binList.append(h('div', { class: 've-bin-empty' }, this.icon('film-slate', { size: 32 }), h('p', {}, t('binEmpty'))));
      return;
    }
    for (const m of this.p.media) {
      const url = this.api.mediaUrl(m.path);
      const thumb =
        m.kind === 'image' ? h('img', { class: 've-thumb', src: url, alt: '', draggable: false }) : m.kind === 'video' ? h('video', { class: 've-thumb', src: `${url}#t=0.5`, preload: 'metadata', muted: true }) : h('div', { class: 've-thumb ve-thumb-audio' }, this.icon('music-notes', { size: 24 }));
      const item = h(
        'div',
        {
          class: 've-media',
          role: 'listitem',
          tabindex: '0',
          draggable: 'true',
          dataset: { id: m.id, kind: m.kind },
          title: m.path,
          ondblclick: () => this.addFromBin(m.id),
          onkeydown: (e) => e.key === 'Enter' && this.addFromBin(m.id),
          ondragstart: (e) => {
            e.dataTransfer.setData(BIN_MIME, m.id);
            e.dataTransfer.effectAllowed = 'copy';
          },
          oncontextmenu: (e) => {
            e.preventDefault();
            this.ui.menu(e, [
              { label: t('addToTimeline'), icon: 'plus', action: () => this.addFromBin(m.id) },
              { label: t('removeMedia'), icon: 'trash', danger: true, action: () => this.change((p) => M.removeMedia(p, m.id)) },
            ]);
          },
        },
        thumb,
        h('div', { class: 've-media-text' }, h('div', { class: 've-media-name' }, m.name), h('div', { class: 've-media-meta' }, `${t(`kind_${m.kind}`)}${m.duration ? ` · ${M.fmtTime(m.duration)}` : ''}`)),
        h('button', { class: 'btn subtle ve-media-add', title: t('addToTimeline'), 'aria-label': t('addToTimeline'), onclick: (e) => (e.stopPropagation(), this.addFromBin(m.id)) }, this.icon('plus', { size: 16 })),
      );
      this.binList.append(item);
    }
  }
  renderTimeline() {
    const { h, t, pps } = this;
    const total = M.totalDuration(this.p);
    const span = Math.max(total, M.musicDuration(this.p), 30) + 10;
    const width = Math.ceil(span * pps);
    this.tlInner.style.width = `${width}px`;
    // ruler: a tick every step seconds
    const step = pps >= 80 ? 1 : pps >= 30 ? 5 : pps >= 14 ? 10 : 30;
    this.ruler.replaceChildren();
    for (let s = 0; s <= span; s += step) this.ruler.append(h('span', { class: 've-tick', style: { left: `${s * pps}px` } }, M.fmtTime(s)));
    for (const [lane, track] of [[this.laneV, 'video'], [this.laneM, 'music']]) {
      lane.replaceChildren();
      const list = M.trackOf(this.p, track);
      if (!list.length) lane.append(h('div', { class: 've-lane-empty' }, t(track === 'video' ? 'timelineEmpty' : 'musicEmpty')));
      const st = M.starts(this.p, track);
      list.forEach((c, i) => {
        const m = c.mediaId ? M.mediaOf(this.p, c.mediaId) : null;
        const d = M.clipDuration(c);
        const kind = track === 'music' ? 'music' : c.type === 'title' ? 'title' : m?.kind === 'image' ? 'image' : 'video';
        const label = kind === 'title' ? c.text?.value || t('titleCard') : m?.name || '?';
        const el = h(
          'div',
          {
            class: ['ve-clip', `ve-clip-${kind}`, c.id === this.sel && 'selected'],
            dataset: { id: c.id, track, index: String(i) },
            style: { left: `${st[i] * pps}px`, width: `${Math.max(4, d * pps)}px` },
            tabindex: '0',
            role: 'button',
            'aria-label': `${t(`clip_${kind}`)} ${label}, ${M.fmtTime(d, true)}`,
            'aria-pressed': c.id === this.sel ? 'true' : 'false',
          },
          h('div', { class: 've-handle ve-handle-start', dataset: { edge: 'start' } }),
          h('div', { class: 've-clip-body' }, this.icon(kind === 'title' ? 'text-t' : kind === 'image' ? 'image' : kind === 'music' ? 'music-notes' : 'film-strip', { size: 14 }), h('span', { class: 've-clip-label' }, label), c.text && kind !== 'title' ? this.icon('text-aa', { size: 14 }) : null),
          c.fade && track === 'video' ? h('div', { class: 've-fade-mark', title: t('fade') }) : null,
          track === 'music' && c.fadeIn ? h('div', { class: 've-mfade ve-mfade-in', style: { width: `${Math.min(d, c.fadeIn) * pps}px` } }) : null,
          track === 'music' && c.fadeOut ? h('div', { class: 've-mfade ve-mfade-out', style: { width: `${Math.min(d, c.fadeOut) * pps}px` } }) : null,
          h('div', { class: 've-handle ve-handle-end', dataset: { edge: 'end' } }),
        );
        lane.append(el);
      });
    }
    this.placePlayhead();
  }
  placePlayhead() {
    this.playhead.style.transform = `translateX(${this.time * this.pps}px)`;
    const total = M.totalDuration(this.p);
    this.timeLabel.textContent = `${M.fmtTime(this.time, true)} / ${M.fmtTime(total, true)}`;
    this.playBtn.replaceChildren(this.icon(this.playing ? 'pause' : 'play', { size: 20, filled: true }));
    this.playBtn.title = this.t(this.playing ? 'pause' : 'play');
    this.playBtn.setAttribute('aria-label', this.playBtn.title);
  }
  renderInspector() {
    const { h, t } = this;
    const f = this.sel && M.find(this.p, this.sel);
    this.inspector.replaceChildren();
    if (!f) {
      this.inspector.append(h('div', { class: 've-insp-empty' }, this.icon('cursor-click', { size: 28 }), h('p', {}, t('inspectorEmpty'))));
      return;
    }
    const c = f.clip;
    const m = c.mediaId ? M.mediaOf(this.p, c.mediaId) : null;
    const kind = f.track === 'music' ? 'music' : c.type === 'title' ? 'title' : m?.kind === 'image' ? 'image' : 'video';
    const set = (fn, soft) => this.change(() => fn(M.find(this.p, c.id).clip), { soft });
    const row = (label, ...ctl) => h('div', { class: 've-field' }, h('label', { class: 've-label' }, label), ...ctl);
    // sliders: one undo step per gesture (commit on pointerdown / keydown, soft updates while dragging)
    const slider = (min, max, step, value, fmt, apply) => {
      const out = h('span', { class: 've-val' }, fmt(value));
      let armed = false;
      const s = this.ui.slider({
        min, max, step, value,
        oninput: (v) => {
          if (!armed) (this.hist.commit(this.p), (armed = true));
          out.textContent = fmt(Number(v));
          apply(M.find(this.p, c.id).clip, Number(v));
          this.dirty = true;
          this.renderPreview();
        },
        onchange: () => {
          armed = false;
          this.render();
        },
      });
      return h('div', { class: 've-slider-row' }, s, out);
    };
    this.inspector.append(
      h('div', { class: 've-insp-head' }, h('h2', { class: 've-h' }, t(`clip_${kind}`)), h('div', { class: 've-insp-sub' }, kind === 'title' ? '' : m?.name || ''), h('div', { class: 've-insp-sub' }, t('duration', { d: M.fmtTime(M.clipDuration(c), true) }))),
    );
    if (kind === 'video' || kind === 'music') this.inspector.append(row(t('volume'), slider(0, 200, 5, Math.round((c.volume ?? 1) * 100), (v) => `${v} %`, (cl, v) => (cl.volume = v / 100))));
    if (kind === 'music') {
      this.inspector.append(row(t('fadeIn'), slider(0, 10, 0.5, c.fadeIn || 0, (v) => t('seconds', { n: v }), (cl, v) => (cl.fadeIn = v))));
      this.inspector.append(row(t('fadeOut'), slider(0, 10, 0.5, c.fadeOut || 0, (v) => t('seconds', { n: v }), (cl, v) => (cl.fadeOut = v))));
      return;
    }
    const last = f.index === this.p.video.length - 1;
    this.inspector.append(
      row(
        t(last ? 'fadeLast' : 'fade'),
        this.ui.segmented({ options: FADES.map((v) => ({ value: String(v), label: v ? t('seconds', { n: String(v).replace('.', this.lang() === 'fr' ? ',' : '.') }) : t('fadeNone') })), value: String(c.fade || 0), onchange: (v) => set((cl) => (cl.fade = Number(v))) }),
      ),
    );
    if (kind === 'title') this.inspector.append(row(t('bgColor'), this.swatches(c.bg, (v) => set((cl) => (cl.bg = v)))));
    const txt = c.text || { value: '', size: kind === 'title' ? 64 : 40, pos: kind === 'title' ? 'center' : 'bottom', color: '#ffffff' };
    const ta = h('textarea', { class: 'input ve-text-input', rows: 2, maxlength: 300, placeholder: t(kind === 'title' ? 'titlePlaceholder' : 'textPlaceholder'), 'aria-label': t('text') });
    ta.value = txt.value;
    let armed = false;
    ta.addEventListener('input', () => {
      if (!armed) (this.hist.commit(this.p), (armed = true));
      const cl = M.find(this.p, c.id).clip;
      cl.text = { ...txt, ...(cl.text || {}), value: ta.value };
      this.dirty = true;
      this.renderPreview();
    });
    ta.addEventListener('change', () => {
      armed = false;
      this.renderTimeline();
      this.render();
    });
    const setText = (patch) => set((cl) => (cl.text = { ...txt, ...(cl.text || {}), ...patch }));
    this.inspector.append(
      row(t('text'), ta),
      row(t('textSize'), slider(16, 160, 2, txt.size, (v) => `${v}`, (cl, v) => (cl.text = { ...txt, ...(cl.text || {}), size: v }))),
      row(t('textPos'), this.ui.segmented({ options: [['top', 'posTop'], ['center', 'posCenter'], ['bottom', 'posBottom']].map(([value, k]) => ({ value, label: t(k) })), value: txt.pos, onchange: (v) => setText({ pos: v }) })),
      row(t('textColor'), this.swatches(txt.color, (v) => setText({ color: v }))),
    );
  }
  /** Colour choices for texts and title cards, taken from the theme tokens (stored as #rrggbb in the project). */
  palette() {
    const cs = getComputedStyle(document.documentElement);
    const cv = document.createElement('canvas').getContext('2d');
    const hex = (v, fb) => {
      cv.fillStyle = fb;
      cv.fillStyle = v.trim() || fb;
      return /^#[0-9a-f]{6}$/i.test(cv.fillStyle) ? cv.fillStyle : fb;
    };
    return [
      ['white', '#ffffff'],
      ['black', '#000000'],
      ['night', '#101820'],
      ['accent', hex(cs.getPropertyValue('--accent-base'), '#c9d3e6')],
      ['warning', hex(cs.getPropertyValue('--warning'), '#e9b566')],
      ['danger', hex(cs.getPropertyValue('--danger'), '#e5484d')],
      ['success', hex(cs.getPropertyValue('--success'), '#3fb950')],
    ];
  }
  swatches(value, onpick) {
    const { h, t } = this;
    return h(
      'div',
      { class: 've-swatches', role: 'radiogroup' },
      this.palette().map(([k, v]) =>
        h('button', { class: ['ve-swatch', value?.toLowerCase() === v.toLowerCase() && 'selected'], role: 'radio', 'aria-checked': String(value?.toLowerCase() === v.toLowerCase()), title: t(`color_${k}`), 'aria-label': t(`color_${k}`), dataset: { color: v }, style: { '--sw': v }, onclick: () => onpick(v) }),
      ),
    );
  }

  // ---------------------------------------------------------------- preview / playback
  renderPreview() {
    const t = this.time;
    const total = M.totalDuration(this.p);
    this.stageEmpty.hidden = total > 0;
    this.picture.hidden = !(total > 0);
    const hit = M.clipAt(this.p, Math.min(t, Math.max(0, total - 0.001)));
    const c = hit?.clip;
    const m = c?.mediaId ? M.mediaOf(this.p, c.mediaId) : null;
    const kind = !c ? null : c.type === 'title' ? 'title' : m?.kind;
    this.picture.dataset.kind = kind || '';
    this.vid.hidden = kind !== 'video';
    this.img.hidden = kind !== 'image';
    this.titleBg.hidden = kind !== 'title';
    if (kind === 'video') {
      const url = this.api.mediaUrl(m.path);
      if (this.vid.dataset.path !== m.path) {
        this.vid.dataset.path = m.path;
        this.vid.src = url;
      }
      const want = c.in + hit.offset;
      this.vid.volume = Math.min(1, c.volume ?? 1);
      if (this.playing) {
        if (this.vid.paused) {
          this.vid.currentTime = want;
          this.vid.play().catch(() => {});
        } else if (Math.abs(this.vid.currentTime - want) > 0.35) this.vid.currentTime = want;
      } else {
        if (!this.vid.paused) this.vid.pause();
        if (Math.abs(this.vid.currentTime - want) > 0.04) this.vid.currentTime = want;
      }
    } else if (!this.vid.paused) this.vid.pause();
    if (kind === 'image' && this.img.dataset.path !== m.path) {
      this.img.dataset.path = m.path;
      this.img.src = this.api.mediaUrl(m.path);
    }
    if (kind === 'title') this.titleBg.style.background = c.bg;
    // text over the picture: size relative to a 720 px high frame
    const txt = c?.text?.value?.trim() ? c.text : null;
    this.overlay.hidden = !txt;
    if (txt) {
      this.overlay.textContent = txt.value;
      this.overlay.dataset.pos = txt.pos;
      this.overlay.style.color = txt.color;
      this.overlay.style.fontSize = `${(txt.size * (this.stage.clientHeight || 360)) / 720}px`;
    }
    this.picture.style.opacity = String(c ? M.fadeAt(this.p, t) : 1);
    // music
    const mh = M.clipAt(this.p, t, 'music');
    const mm = mh ? M.mediaOf(this.p, mh.clip.mediaId) : null;
    if (mm && t < total) {
      if (this.aud.dataset.path !== mm.path) {
        this.aud.dataset.path = mm.path;
        this.aud.src = this.api.mediaUrl(mm.path);
      }
      const want = mh.clip.in + mh.offset;
      this.aud.volume = M.musicGainAt(this.p, t);
      if (this.playing) {
        if (this.aud.paused) {
          this.aud.currentTime = want;
          this.aud.play().catch(() => {});
        } else if (Math.abs(this.aud.currentTime - want) > 0.35) this.aud.currentTime = want;
      } else if (!this.aud.paused) this.aud.pause();
    } else if (!this.aud.paused) this.aud.pause();
    this.placePlayhead();
  }
  seek(t) {
    this.time = Math.max(0, Math.min(t, M.totalDuration(this.p)));
    this.renderPreview();
    this.scrollToPlayhead();
  }
  scrollToPlayhead() {
    const x = this.time * this.pps;
    const sc = this.tlScroll;
    if (x < sc.scrollLeft || x > sc.scrollLeft + sc.clientWidth - 20) sc.scrollLeft = Math.max(0, x - sc.clientWidth / 3);
  }
  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }
  play() {
    const total = M.totalDuration(this.p);
    if (!total) return;
    if (this.time >= total - 0.01) this.time = 0;
    this.playing = true;
    let last = performance.now();
    const tick = (now) => {
      if (!this.playing || this.win.closed) return;
      this.time += (now - last) / 1000;
      last = now;
      if (this.time >= M.totalDuration(this.p)) {
        this.time = M.totalDuration(this.p);
        this.pause();
        return;
      }
      this.renderPreview();
      this.scrollToPlayhead();
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
    this.renderPreview();
  }
  pause() {
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.vid.pause();
    this.aud.pause();
    this.renderPreview();
  }

  // ---------------------------------------------------------------- timeline pointer work
  bindTimeline() {
    const xToTime = (clientX) => {
      const r = this.tlInner.getBoundingClientRect();
      return Math.max(0, (clientX - r.left) / this.pps);
    };
    const scrub = (e) => {
      e.preventDefault();
      this.pause();
      this.seek(xToTime(e.clientX));
      const mv = (ev) => this.seek(xToTime(ev.clientX));
      const up = () => (window.removeEventListener('pointermove', mv), window.removeEventListener('pointerup', up));
      window.addEventListener('pointermove', mv);
      window.addEventListener('pointerup', up);
    };
    this.ruler.addEventListener('pointerdown', scrub);
    this.playhead.addEventListener('pointerdown', scrub);
    for (const lane of [this.laneV, this.laneM]) {
      lane.addEventListener('pointerdown', (e) => {
        const clipEl = e.target.closest('.ve-clip');
        if (!clipEl) {
          this.sel = null;
          this.renderInspector();
          this.renderTimeline();
          return scrub(e);
        }
        e.preventDefault();
        this.root.focus({ preventScroll: true });
        const id = clipEl.dataset.id;
        const track = clipEl.dataset.track;
        const edge = e.target.closest('.ve-handle')?.dataset.edge;
        if (this.sel !== id) {
          this.sel = id;
          this.renderInspector();
          for (const el of this.tlInner.querySelectorAll('.ve-clip')) el.classList.toggle('selected', el.dataset.id === id), el.setAttribute('aria-pressed', String(el.dataset.id === id));
        }
        const x0 = e.clientX;
        const before = M.serialize(this.p);
        const orig = JSON.parse(JSON.stringify(M.find(this.p, id).clip));
        let moved = false;
        const mv = (ev) => {
          const dx = ev.clientX - x0;
          if (!moved && Math.abs(dx) < 4) return;
          moved = true;
          if (edge) {
            Object.assign(M.find(this.p, id).clip, JSON.parse(JSON.stringify(orig)));
            M.trim(this.p, id, edge, dx / this.pps);
            this.renderTimeline();
            const f = M.find(this.p, id);
            const st = M.starts(this.p, track)[f.index];
            this.seek(edge === 'start' ? st : st + M.clipDuration(f.clip) - 0.001);
          } else {
            clipEl.classList.add('dragging');
            clipEl.style.transform = `translateX(${dx}px)`;
          }
        };
        const up = (ev) => {
          window.removeEventListener('pointermove', mv);
          window.removeEventListener('pointerup', up);
          if (!moved) {
            if (!edge) this.seek(xToTime(ev.clientX));
            return;
          }
          if (edge) {
            this.hist.commit(M.parse(before));
            this.dirty = true;
            this.render();
            return;
          }
          // reorder: the clip goes where the pointer is (before or after the clip under it)
          const f = M.find(this.p, id);
          const st = M.starts(this.p, track);
          const at = xToTime(ev.clientX);
          const list = M.trackOf(this.p, track);
          let to = 0;
          for (let i = 0; i < list.length; i++) if (i !== f.index && st[i] + M.clipDuration(list[i]) / 2 < at) to++;
          if (to === f.index) return this.renderTimeline();
          this.change((p) => M.move(p, track, id, to));
        };
        window.addEventListener('pointermove', mv);
        window.addEventListener('pointerup', up);
      });
    }
  }
  /** Index of the video track where a drop at clientX lands. */
  dropIndex(clientX) {
    const t = Math.max(0, (clientX - this.tlInner.getBoundingClientRect().left) / this.pps);
    const st = M.starts(this.p);
    let i = 0;
    while (i < st.length && st[i] + M.clipDuration(this.p.video[i]) / 2 < t) i++;
    return i;
  }
  bindDrops() {
    const types = (e) => [...(e.dataTransfer?.types || [])];
    this.root.addEventListener('dragover', (e) => {
      const ty = types(e);
      if (!ty.includes(BIN_MIME) && !ty.includes('application/x-aurora-paths') && !ty.includes('Files')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      this.root.classList.toggle('ve-drop-tl', !!e.target.closest?.('.ve-timeline'));
    });
    this.root.addEventListener('dragleave', (e) => {
      if (!this.root.contains(e.relatedTarget)) this.root.classList.remove('ve-drop-tl');
    });
    this.root.addEventListener('drop', async (e) => {
      this.root.classList.remove('ve-drop-tl');
      const onTl = !!e.target.closest?.('.ve-timeline');
      const id = e.dataTransfer.getData(BIN_MIME);
      e.preventDefault();
      if (id) {
        if (onTl) this.addFromBin(id, M.mediaOf(this.p, id)?.kind === 'audio' ? undefined : this.dropIndex(e.clientX));
        return;
      }
      let paths = trustedDragPaths(e.dataTransfer);
      if (!paths.length) paths = [...(e.dataTransfer.files || [])].map((f) => this.api.pathForFile?.(f) || f.path).filter(Boolean);
      if (paths.length) await this.importPaths(paths, { toTimeline: onTl, at: onTl ? this.dropIndex(e.clientX) : undefined });
    });
  }

  // ---------------------------------------------------------------- keyboard
  onKey(e) {
    const typing = e.target.closest?.('input, textarea, select, [contenteditable="true"]');
    const k = e.key.toLowerCase();
    if (e.ctrlKey || e.metaKey) {
      const map = { z: () => (e.shiftKey ? this.redo() : this.undo()), y: () => this.redo(), s: () => this.save(), o: () => this.openDialog(), e: () => this.exportDialog(), n: () => this.newProject() };
      if (typing && (k === 'z' || k === 'y')) return;
      if (map[k]) {
        e.preventDefault();
        map[k]();
      }
      return;
    }
    if (typing || e.altKey) return;
    const act = {
      ' ': () => this.toggle(),
      k: () => this.pause(),
      j: () => this.seek(this.time - 5),
      l: () => this.seek(this.time + 5),
      arrowleft: () => this.seek(this.time - 0.1),
      arrowright: () => this.seek(this.time + 0.1),
      home: () => this.seek(0),
      end: () => this.seek(M.totalDuration(this.p)),
      s: () => this.split(),
      delete: () => this.deleteSel(),
      backspace: () => this.deleteSel(),
      '+': () => this.setZoom(this.pps * 1.4),
      '=': () => this.setZoom(this.pps * 1.4),
      '-': () => this.setZoom(this.pps / 1.4),
    }[k];
    if (act && !(k === ' ' && e.target.closest?.('button'))) {
      e.preventDefault();
      act();
    }
  }

  // ---------------------------------------------------------------- files
  async projectsDir() {
    const dir = `${this.xdg.videos || `${this.xdg.home}/Videos`}/${this.t('projectsFolder')}`;
    await this.api.invoke('fs:mkdir', dir).catch(() => {});
    return dir;
  }
  async confirmDiscard() {
    if (!this.dirty || !(this.p.video.length || this.p.music.length || this.p.media.length)) return true;
    const v = await this.ui.dialog({
      title: this.t('unsaved', { name: this.p.name }),
      body: this.t('unsavedBody'),
      parent: this.win,
      buttons: [
        { label: this.t('save'), value: 'save', primary: true },
        { label: this.t('dontSave'), value: 'discard' },
        { label: this.t('cancel'), value: null },
      ],
    });
    if (v === 'save') return this.save();
    return v === 'discard';
  }
  async newProject() {
    if (!(await this.confirmDiscard())) return;
    this.pause();
    this.p = M.newProject(this.t('untitled'));
    this.hist = M.history();
    this.file = null;
    this.dirty = false;
    this.sel = null;
    this.time = 0;
    this.render();
  }
  async save() {
    const dir = this.file ? dirOf(this.file) : await this.projectsDir();
    let file = this.file;
    const safe = this.p.name.replace(/[/\\\0]/g, '-').trim() || this.t('untitled');
    if (!file || base(file) !== `${safe}.json`) {
      const want = `${dir}/${safe}.json`;
      const exists = await this.api.invoke('fs:exists', want).catch(() => false);
      file = exists && want !== this.file ? `${dir}/${await this.api.invoke('fs:uniqueName', dir, `${safe}.json`)}` : want;
    }
    try {
      await this.api.invoke('fs:writeText', file, M.serialize(this.p));
    } catch (err) {
      this.toast(String(err.message || err), 'error');
      return false;
    }
    this.file = file;
    this.dirty = false;
    this.render();
    this.toast(this.t('saved', { folder: dir.replace(this.xdg.home || '\0', '~') }));
    return true;
  }
  async openDialog() {
    if (!(await this.confirmDiscard())) return;
    const dir = await this.projectsDir();
    const res = await this.ui.filePicker({ mode: 'open', title: this.t('open'), filters: [{ name: this.t('filterProjects'), ext: ['.json'] }], path: dir, parent: this.win });
    if (res) await this.openPath([].concat(res)[0]);
  }
  async openPath(file) {
    let p;
    try {
      p = M.parse(await this.api.invoke('fs:readText', file));
    } catch {
      this.toast(this.t('openFailed'), 'error');
      return false;
    }
    this.pause();
    this.p = p;
    this.hist = M.history();
    this.file = file;
    this.dirty = false;
    this.sel = null;
    this.time = 0;
    this.render();
    const missing = [];
    for (const m of p.media) if (!(await this.api.invoke('fs:exists', m.path).catch(() => false))) missing.push(m);
    if (missing.length) this.toast(this.t('missingMedia', { count: missing.length }), 'warning');
    return true;
  }
  async onArgs(args) {
    const f = args?.file;
    if (!f) return;
    if (/\.json$/i.test(f)) await this.openPath(f);
    else if (ALL_EXT.includes(ext(f))) await this.importPaths([f], { toTimeline: true });
  }

  // ---------------------------------------------------------------- export
  async exportDialog() {
    const { h, t } = this;
    if (this.job) return;
    if (!this.p.video.length) return this.toast(t('emptyTimeline'), 'warning');
    if (!this.tools.ffmpeg) return this.toast(t('noFfmpeg'), 'error');
    let height = 1080;
    let folder = this.xdg.videos || this.xdg.home;
    const nameIn = h('input', { class: 'input ve-out-name', value: `${this.p.name.replace(/[/\\\0]/g, '-')}.mp4`, 'aria-label': t('fileName') });
    const folderLabel = h('span', { class: 've-out-folder' }, folder.replace(this.xdg.home || '\0', '~'));
    const body = h(
      'div',
      { class: 've-export-form' },
      h('p', { class: 've-export-intro' }, t('exportBody')),
      h('div', { class: 've-field' }, h('label', { class: 've-label' }, t('quality')), this.ui.segmented({ options: [{ value: '720', label: '720p' }, { value: '1080', label: '1080p' }], value: '1080', onchange: (v) => (height = Number(v)) })),
      h('div', { class: 've-field' }, h('label', { class: 've-label' }, t('fileName')), nameIn),
      h(
        'div',
        { class: 've-field' },
        h('label', { class: 've-label' }, t('folder')),
        h('div', { class: 've-folder-row' }, this.icon('folder-simple', { size: 16 }), folderLabel, h('button', {
          class: 'btn subtle',
          onclick: async () => {
            const d = await this.ui.filePicker({ mode: 'folder', title: t('chooseFolder'), path: folder, parent: this.win });
            if (d) (folder = [].concat(d)[0]), (folderLabel.textContent = folder.replace(this.xdg.home || '\0', '~'));
          },
        }, t('change'))),
      ),
    );
    const ok = await this.ui.dialog({ title: t('exportTitle'), body, parent: this.win, className: 've-export-dialog', buttons: [{ label: t('export'), value: true, primary: true }, { label: t('cancel'), value: null }] });
    if (!ok) return;
    let name = nameIn.value.trim().replace(/[/\\\0]/g, '-') || `${this.p.name}.mp4`;
    if (!/\.mp4$/i.test(name)) name += '.mp4';
    return this.startExport(`${folder}/${name}`, height);
  }
  async startExport(out, height = 1080) {
    const { h, t } = this;
    const name = base(out);
    this.pause();
    const bar = h('div', { class: 've-progress-bar' }, h('div', { class: 've-progress-fill' }));
    const label = h('span', { class: 've-banner-text' }, t('exporting', { name, percent: 0 }));
    this.showBanner('info', this.icon('export', { size: 18 }), label, bar, h('button', { class: 'btn ve-cancel', onclick: () => this.cancelExport() }, t('cancel')));
    this.exportBtn.disabled = true;
    return new Promise((resolve) => {
      const off = this.api.on('videoeditor:progress', (ev) => {
        if (!this.job || ev.id !== this.job.id) return;
        if (ev.state === 'running') {
          label.textContent = t('exporting', { name, percent: ev.percent });
          bar.firstChild.style.transform = `scaleX(${ev.percent / 100})`;
          return;
        }
        off?.();
        this.job = null;
        this.exportBtn.disabled = false;
        if (ev.state === 'done') {
          const folder = dirOf(out);
          this.showBanner('success', this.icon('check-circle', { size: 18 }), h('span', { class: 've-banner-text' }, `${t('exportDone')} : ${name}`), h('button', { class: 'btn', onclick: () => this.shell.openFile(out) }, t('openVideo')), h('button', { class: 'btn subtle', onclick: () => this.shell.openFile(folder) }, t('showFolder')), this.closeBannerBtn());
          this.shell.notify({ title: t('exportDone'), body: t('exportDoneBody', { name, folder: folder.replace(this.xdg.home || '\0', '~') }), appId: 'videoeditor', actions: [{ label: t('openVideo'), onClick: () => this.shell.openFile(out) }] });
        } else if (ev.state === 'canceled') this.showBanner('info', this.icon('info', { size: 18 }), h('span', { class: 've-banner-text' }, t('exportCanceled')), this.closeBannerBtn());
        else this.showBanner('error', this.icon('warning-circle', { size: 18 }), h('span', { class: 've-banner-text', title: ev.error || '' }, t('exportFailed')), this.closeBannerBtn());
        resolve(ev.state);
      });
      this.api
        .invoke('videoeditor:export', M.forExport(this.p), { out, height })
        .then((r) => (this.job = { id: r.id, out }))
        .catch((err) => {
          off?.();
          this.exportBtn.disabled = false;
          this.showBanner('error', this.icon('warning-circle', { size: 18 }), h('span', { class: 've-banner-text' }, `${t('exportFailed')} : ${err.message || err}`), this.closeBannerBtn());
          resolve('error');
        });
    });
  }
  async cancelExport() {
    if (this.job) await this.api.invoke('videoeditor:cancel', this.job.id).catch(() => {});
  }
  closeBannerBtn() {
    return this.h('button', { class: 'btn subtle ve-banner-close', 'aria-label': this.t('cancel'), onclick: () => (this.banner.hidden = true) }, this.icon('x', { size: 16 }));
  }
  showBanner(kind, ...children) {
    this.banner.className = `ve-banner infobar ${kind}`;
    this.banner.replaceChildren(...children);
    this.banner.hidden = false;
  }
  toast(msg, kind = 'info') {
    clearTimeout(this.toastTimer);
    this.toastEl?.remove();
    this.toastEl = this.h('div', { class: ['ve-toast', kind], role: 'status' }, msg);
    this.root.append(this.toastEl);
    this.toastTimer = setTimeout(() => this.toastEl?.remove(), 4000);
  }
}
