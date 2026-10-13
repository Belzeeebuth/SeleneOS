// Voice Recorder (Enregistreur vocal): record from a microphone to Opus/WebM files in
// ~/Documents/Sound recordings (EN) or ~/Documents/Enregistrements audio (FR).
//
//   Record view   big record / stop button, pause and resume, markers (button or M), live waveform, timer,
//                 microphone choice with a level meter and a test button. Recording goes on while the window is
//                 minimized; a red dot with the elapsed time sits in the bar tray (shell.setStatusItem 'recorder').
//                 The microphone test stops when the window is minimized or the record view is left (no hidden open
//                 microphone). A microphone unplugged during a recording: what was recorded is saved, like Stop,
//                 and a notification says so.
//   Recordings    list (name, date, duration), newest first; select one to play it with a seekable waveform (WebAudio,
//                 exact seeking), its markers, rename, delete (to the Trash), show in Files, trim (two handles, save as
//                 a copy or replace). Trimming re-encodes the kept part to Opus with WebCodecs (lib/audio.js), muxed by
//                 lib/webm.js; MediaRecorder files get their missing Duration written (fixDuration) so other players
//                 can seek them. With ffmpeg in the image, MP3 / M4A copies via main/ipc/recorder.js (Export button).
//   Metadata      per-file duration and markers in the app storage ('meta': { [fileName]: { duration, markers } }).
//   Keyboard      Ctrl+R record / stop, Space pause / resume (play / pause on a recording), M add a marker,
//                 F2 rename, Delete delete, arrows seek 5 s. None of them act while a dialog is open, and Ctrl+R
//                 does nothing from a text field.
// Test hook: the window element carries `__recorder` (this object).
import { decode, peaks, encodeSlice, fmtTime } from './lib/audio.js';
import { fixDuration } from './lib/webm.js';

const AUDIO_EXT = ['.webm', '.ogg', '.opus', '.oga', '.wav', '.m4a', '.mp3', '.flac'];
const TRAY_ID = 'recorder';
const LIVE_RATE = 20; // live waveform bars per second

const css = (el, name) => getComputedStyle(el).getPropertyValue(name).trim();
const extOf = (name) => (/\.[^.]+$/.exec(name) || [''])[0].toLowerCase();
const baseOf = (name) => name.replace(/\.[^.]+$/, '');

class Recorder {
  constructor(ctx) {
    this.ctx = ctx;
    this.t = ctx.t;
    this.h = ctx.h;
    this.items = [];
    this.meta = {};
    this.selected = null; // file name
    this.rec = null; // { stream, mr, chunks, t0, pausedMs, pauseAt, markers, levels }
    this.monitor = null; // { stream, ac, an } (mic test or recording)
    this.play = null; // { name, buffer, peaks, pos, playing, src, at }
    this.trim = null; // { a, b }
    this.devices = [];
    this.deviceId = '';
    this.saving = false;
    this.els = {};
    this.raf = 0;
  }

  // ------------------------------------------------------------------ setup
  async init() {
    const { win, api, storage } = this.ctx;
    win.body.classList.add('rc-root');
    this.meta = (await storage.get('meta', {}).catch(() => ({}))) || {};
    const prefs = (await storage.get('prefs', {}).catch(() => ({}))) || {};
    this.deviceId = prefs.deviceId || '';
    this.xdg = await api.invoke('fs:xdg').catch(async () => ({ documents: `${await api.invoke('fs:home')}/Documents` }));
    this.dir = await this.folder();
    this.tools = (await api.invoke('recorder:tools').catch(() => null)) || { ffmpeg: false };
    this.render();
    await this.refresh();
    this.listDevices();
    this.onDeviceChange = () => this.listDevices();
    navigator.mediaDevices?.addEventListener?.('devicechange', this.onDeviceChange);
    this.keyHandler = (e) => this.onKey(e);
    win.body.addEventListener('keydown', this.keyHandler);
    this.ro = new ResizeObserver(() => this.drawWave());
    this.unTheme = this.ctx.settings.on?.('theme', () => requestAnimationFrame(() => this.drawWave()));
    this.ctx.onLangChange(() => {
      this.render();
      this.renderList();
      this.paintTray();
    });
    win.onBeforeClose(async () => {
      if (!this.rec) return true;
      const ok = await this.ctx.ui.confirm(this.t('closeWhileRecording'), { title: this.t('title'), okLabel: this.t('stopAndSave'), parent: win });
      if (!ok) return false;
      await this.stopRecording();
      return true;
    });
    win.on('close', () => this.dispose());
    win.on('minimize', () => this.stopTest()); // no microphone left open behind a minimized window
    this.loop();
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.stopPlayback();
    this.stopMonitor();
    if (this.rec) for (const tr of this.rec.stream.getTracks()) tr.stop();
    this.rec = null;
    this.ctx.shell.setStatusItem?.(TRAY_ID, null);
    navigator.mediaDevices?.removeEventListener?.('devicechange', this.onDeviceChange);
    this.ro?.disconnect();
    if (typeof this.unTheme === 'function') this.unTheme();
    if (this.watchId) this.ctx.api.invoke('fs:unwatch', this.watchId).catch(() => {});
  }

  /** ~/Documents/<localized name>; an existing folder of the other language is kept. */
  async folder() {
    const { api } = this.ctx;
    const docs = String(this.xdg.documents || '').replace(/\/$/, '');
    const mine = `${docs}/${this.t('folderName')}`;
    if (await api.invoke('fs:exists', mine).catch(() => false)) return mine;
    for (const other of ['Sound recordings', 'Enregistrements audio']) {
      const p = `${docs}/${other}`;
      if (p !== mine && (await api.invoke('fs:exists', p).catch(() => false))) return p;
    }
    return mine;
  }

  async saveMeta() {
    await this.ctx.storage.set('meta', this.meta).catch(() => {});
  }

  // ------------------------------------------------------------------ list
  async refresh() {
    const { api } = this.ctx;
    let list = [];
    try {
      if (await api.invoke('fs:exists', this.dir)) list = await api.invoke('fs:list', this.dir);
    } catch {
      list = [];
    }
    this.items = list.filter((e) => !e.dir && AUDIO_EXT.includes(e.ext)).sort((a, b) => b.mtime - a.mtime);
    if (this.selected && !this.items.some((i) => i.name === this.selected)) this.select(null);
    this.renderList();
    if (!this.watchId && list.length >= 0 && (await api.invoke('fs:exists', this.dir).catch(() => false))) {
      try {
        this.watchId = await api.invoke('fs:watch', this.dir);
        this.offWatch = api.on('fs:changed', (ev) => {
          if (ev?.watchId !== this.watchId) return;
          clearTimeout(this.watchTimer);
          this.watchTimer = setTimeout(() => this.refresh(), 250);
        });
        this.ctx.onClose(() => this.offWatch?.());
      } catch {
        /* no watch: the list refreshes after our own changes */
      }
    }
  }

  fmtDate(ms) {
    const lang = this.ctx.lang === 'fr' ? 'fr-FR' : 'en-GB';
    const d = new Date(ms);
    const date = d.toLocaleDateString(lang, { day: 'numeric', month: 'short', year: 'numeric' });
    const time = d.toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' });
    return this.t('dateAt', { date, time });
  }

  renderList() {
    const { h, t } = this;
    const list = this.els.list;
    if (!list) return;
    list.replaceChildren();
    this.els.empty.hidden = this.items.length > 0;
    for (const it of this.items) {
      const dur = this.meta[it.name]?.duration;
      const row = h(
        'div',
        {
          class: ['rc-item', it.name === this.selected && 'selected'],
          role: 'option',
          tabindex: it.name === this.selected || (!this.selected && it === this.items[0]) ? '0' : '-1',
          'aria-selected': String(it.name === this.selected),
          dataset: { name: it.name },
          onclick: () => this.select(it.name),
          oncontextmenu: (e) => {
            e.preventDefault();
            this.select(it.name);
            this.itemMenu(e, it.name);
          },
          onkeydown: (e) => this.listKey(e, it.name),
        },
        h('span', { class: 'rc-item-icon' }, this.ctx.icon('microphone', { size: 18 })),
        h(
          'span',
          { class: 'rc-item-text' },
          h('span', { class: 'rc-item-name' }, baseOf(it.name)),
          h('span', { class: 'rc-item-sub' }, h('span', { class: 'rc-item-date' }, this.fmtDate(it.mtime)), h('span', { class: 'rc-item-dur' }, dur != null ? fmtTime(dur) : t('durationUnknown'))),
        ),
      );
      list.appendChild(row);
    }
  }

  listKey(e, name) {
    const i = this.items.findIndex((x) => x.name === name);
    const go = (j) => {
      const it = this.items[Math.max(0, Math.min(this.items.length - 1, j))];
      if (!it) return;
      this.select(it.name);
      this.els.list.querySelector(`[data-name="${CSS.escape(it.name)}"]`)?.focus();
    };
    if (e.key === 'ArrowDown') go(i + 1);
    else if (e.key === 'ArrowUp') go(i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(this.items.length - 1);
    else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) this.itemMenu(e.currentTarget, name);
    else return;
    e.preventDefault();
    e.stopPropagation();
  }

  itemMenu(at, name) {
    const { t } = this;
    this.ctx.ui.menu(at, [
      { label: t('play'), icon: 'play', action: () => this.select(name).then(() => this.togglePlay()) },
      { label: t('rename'), icon: 'pencil-simple', shortcut: 'F2', action: () => this.rename(name) },
      { label: t('trim'), icon: 'scissors', action: () => this.select(name).then(() => this.startTrim()) },
      { label: t('showInFiles'), icon: 'folder-open', action: () => this.showInFiles(name) },
      ...(this.tools?.ffmpeg ? ['-', ...this.exportItems(name)] : []),
      '-',
      { label: t('delete'), icon: 'trash', danger: true, shortcut: t('delete') === 'Supprimer' ? 'Suppr' : 'Del', action: () => this.remove(name) },
    ]);
  }

  // ------------------------------------------------------------------ layout
  render() {
    const { h, t } = this;
    const { win, icon } = this.ctx;
    win.setTitle?.(t('title'));
    const els = (this.els = {});
    els.list = h('div', { class: 'rc-list', role: 'listbox', 'aria-label': t('recordings') });
    els.empty = h('div', { class: 'rc-empty' }, t('emptyList'));
    const side = h(
      'aside',
      { class: 'rc-side' },
      h('button', { class: 'btn primary rc-new', onclick: () => this.showRecordView() }, icon('microphone', { size: 16 }), h('span', null, t('newRecording'))),
      h('div', { class: 'rc-side-title' }, t('recordings')),
      els.list,
      els.empty,
      h('button', { class: 'btn subtle rc-folder', onclick: () => this.showInFiles(null) }, icon('folder-open', { size: 16 }), h('span', null, t('openFolder'))),
    );

    // record view
    els.timer = h('div', { class: 'rc-timer', 'aria-live': 'off' }, '0:00.0');
    els.state = h('div', { class: 'rc-state', role: 'status' }, t('ready'));
    els.live = h('canvas', { class: 'rc-live', 'aria-hidden': 'true' });
    els.recBtn = h('button', { class: 'rc-rec', 'aria-label': t('start'), dataset: { tip: `${t('start')} (Ctrl+R)` }, onclick: () => this.toggleRecord() }, h('span', { class: 'rc-rec-dot' }));
    els.pauseBtn = h('button', { class: 'rc-round', 'aria-label': t('pause'), dataset: { tip: `${t('pause')} (${this.ctx.lang === 'fr' ? 'Espace' : 'Space'})` }, disabled: true, onclick: () => this.togglePause() }, icon('pause', { size: 20, filled: true }));
    els.markBtn = h('button', { class: 'rc-round', 'aria-label': t('addMarker'), dataset: { tip: `${t('addMarker')} (M)` }, disabled: true, onclick: () => this.addMarker() }, icon('flag', { size: 20 }));
    els.liveMarks = h('div', { class: 'rc-live-marks', 'aria-label': t('markers') });
    els.micSel = this.ctx.ui.select({ options: [{ value: '', label: t('defaultMic') }], value: this.deviceId, onchange: (v) => this.setDevice(v) });
    els.micSel.classList?.add('rc-mic-select');
    els.micSel.setAttribute?.('aria-label', t('microphone'));
    els.meter = h('div', { class: 'rc-meter', role: 'meter', 'aria-label': t('level'), 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0' }, h('i'));
    els.testBtn = h('button', { class: 'btn rc-test', onclick: () => (this.monitor && !this.rec ? this.stopMonitor() : this.startMonitor()) }, t('testMic'));
    els.micMsg = h('div', { class: 'rc-mic-msg', role: 'alert' });
    els.recView = h(
      'section',
      { class: 'rc-recview' },
      h('div', { class: 'rc-rec-top' }, els.timer, els.state),
      h('div', { class: 'rc-live-wrap' }, els.live),
      els.liveMarks,
      h('div', { class: 'rc-controls' }, els.markBtn, els.recBtn, els.pauseBtn),
      h('div', { class: 'rc-mic' }, h('span', { class: 'rc-mic-label' }, icon('microphone', { size: 16 }), h('span', null, t('microphone'))), els.micSel, els.meter, els.testBtn),
      els.micMsg,
      h('div', { class: 'rc-hint' }, t('shortcuts')),
    );

    // playback view
    els.name = h('h2', { class: 'rc-name' });
    els.date = h('div', { class: 'rc-date' });
    const act = (key, ic, fn, cls = '') => h('button', { class: `btn subtle rc-act ${cls}`, dataset: { act: key, tip: t(key) }, 'aria-label': t(key), onclick: fn }, icon(ic, { size: 18 }));
    els.actions = h(
      'div',
      { class: 'rc-actions' },
      act('trim', 'scissors', () => this.startTrim()),
      act('rename', 'pencil-simple', () => this.rename(this.selected)),
      act('showInFiles', 'folder-open', () => this.showInFiles(this.selected)),
      ...(this.tools?.ffmpeg ? [act('export', 'export', (e) => this.ctx.ui.menu(e.currentTarget, this.exportItems(this.selected)))] : []),
      act('delete', 'trash', () => this.remove(this.selected)),
    );
    els.wave = h('canvas', { class: 'rc-wave', 'aria-hidden': 'true' });
    els.seek = h('div', {
      class: 'rc-seek',
      role: 'slider',
      tabindex: '0',
      'aria-label': t('position'),
      'aria-valuemin': '0',
      onpointerdown: (e) => this.seekPointer(e),
      onkeydown: (e) => this.seekKey(e),
    });
    els.hA = h('div', { class: 'rc-handle', role: 'slider', tabindex: '0', 'aria-label': t('trimStart'), hidden: true, onpointerdown: (e) => this.handlePointer(e, 'a'), onkeydown: (e) => this.handleKey(e, 'a') });
    els.hB = h('div', { class: 'rc-handle', role: 'slider', tabindex: '0', 'aria-label': t('trimEnd'), hidden: true, onpointerdown: (e) => this.handlePointer(e, 'b'), onkeydown: (e) => this.handleKey(e, 'b') });
    els.waveWrap = h('div', { class: 'rc-wave-wrap' }, els.wave, els.seek, els.hA, els.hB);
    els.cur = h('span', { class: 'rc-cur' }, '0:00');
    els.total = h('span', { class: 'rc-total' }, '0:00');
    els.playBtn = h('button', { class: 'rc-play', 'aria-label': t('play'), dataset: { tip: t('play') }, onclick: () => this.togglePlay() }, icon('play', { size: 22, filled: true }));
    els.transport = h(
      'div',
      { class: 'rc-transport' },
      els.cur,
      h('button', { class: 'btn subtle rc-skip', 'aria-label': t('back10'), dataset: { tip: t('back10') }, onclick: () => this.seek((this.play?.pos || 0) - 10) }, icon('arrow-counter-clockwise', { size: 18 }), h('span', null, '10')),
      els.playBtn,
      h('button', { class: 'btn subtle rc-skip', 'aria-label': t('forward10'), dataset: { tip: t('forward10') }, onclick: () => this.seek((this.play?.pos || 0) + 10) }, h('span', null, '10'), icon('arrow-clockwise', { size: 18 })),
      els.total,
    );
    els.trimBar = h('div', { class: 'rc-trimbar', hidden: true });
    els.markList = h('div', { class: 'rc-marks' });
    els.loadMsg = h('div', { class: 'rc-load-msg', role: 'alert', hidden: true });
    els.playView = h(
      'section',
      { class: 'rc-playview', hidden: true },
      h('header', { class: 'rc-play-head' }, h('div', { class: 'rc-titles' }, els.name, els.date), els.actions),
      els.waveWrap,
      els.loadMsg,
      els.transport,
      els.trimBar,
      h('div', { class: 'rc-marks-title' }, t('markers')),
      els.markList,
    );
    const main = h('main', { class: 'rc-main' }, els.recView, els.playView);
    win.body.replaceChildren(h('div', { class: 'rc-app' }, side, main));
    this.ro?.disconnect();
    this.ro?.observe(els.wave);
    this.fillDevices();
    this.paintRecordState();
    if (this.selected && !this.rec) this.showPlayView();
  }

  showRecordView() {
    if (this.trim) this.cancelTrim();
    this.stopPlayback();
    this.selected = null;
    this.play = null;
    this.els.playView.hidden = true;
    this.els.recView.hidden = false;
    this.renderList();
    this.els.recBtn.focus();
  }

  showPlayView() {
    this.stopTest(); // the test panel is in the record view
    this.els.recView.hidden = true;
    this.els.playView.hidden = false;
  }

  // ------------------------------------------------------------------ microphone
  async listDevices() {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      this.devices = all.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications');
    } catch {
      this.devices = [];
    }
    this.fillDevices();
  }

  fillDevices() {
    const sel = this.els.micSel;
    if (!sel) return;
    const native = sel.tagName === 'SELECT' ? sel : sel.querySelector('select');
    const opts = [{ value: '', label: this.t('defaultMic') }, ...this.devices.map((d, i) => ({ value: d.deviceId, label: d.label || `${this.t('microphone')} ${i + 1}` }))];
    if (native) {
      native.replaceChildren(...opts.map((o) => this.h('option', { value: o.value }, o.label)));
      native.value = opts.some((o) => o.value === this.deviceId) ? this.deviceId : '';
    } else if (typeof sel.setOptions === 'function') sel.setOptions(opts, this.deviceId);
  }

  async setDevice(id) {
    this.deviceId = id || '';
    await this.ctx.storage.set('prefs', { deviceId: this.deviceId }).catch(() => {});
    if (this.monitor && !this.rec) {
      this.stopMonitor();
      this.startMonitor();
    }
  }

  async openMic() {
    const audio = { echoCancellation: false, noiseSuppression: false, autoGainControl: true, channelCount: 1 };
    if (this.deviceId) audio.deviceId = { exact: this.deviceId };
    try {
      return await navigator.mediaDevices.getUserMedia({ audio });
    } catch (err) {
      if (this.deviceId && (err?.name === 'OverconstrainedError' || err?.name === 'NotFoundError')) {
        delete audio.deviceId;
        return navigator.mediaDevices.getUserMedia({ audio });
      }
      throw err;
    }
  }

  attachMeter(stream) {
    const ac = new AudioContext();
    const src = ac.createMediaStreamSource(stream);
    const an = ac.createAnalyser();
    an.fftSize = 1024;
    src.connect(an);
    return { stream, ac, an, buf: new Float32Array(an.fftSize) };
  }

  async startMonitor() {
    this.els.micMsg.textContent = '';
    try {
      const stream = await this.openMic();
      // (recording started, window closed or minimized, or the record view left meanwhile)
      if (this.rec || this.monitor || this.ctx.win.closed || this.ctx.win.minimized || this.els.recView.hidden) return stream.getTracks().forEach((tr) => tr.stop());
      this.monitor = this.attachMeter(stream);
      this.monitor.test = true;
      this.els.testBtn.textContent = this.t('stopTest');
      this.listDevices();
    } catch {
      this.els.micMsg.textContent = this.t('micError');
    }
  }

  /** Stops the microphone test (not the meter of a recording). */
  stopTest() {
    if (this.monitor?.test) this.stopMonitor();
  }

  stopMonitor() {
    if (!this.monitor) return;
    if (this.monitor.test) this.monitor.stream.getTracks().forEach((tr) => tr.stop());
    this.monitor.ac.close().catch(() => {});
    this.monitor = null;
    if (this.els.testBtn) this.els.testBtn.textContent = this.t('testMic');
    this.paintLevel(0);
  }

  level() {
    const m = this.monitor;
    if (!m) return 0;
    m.an.getFloatTimeDomainData(m.buf);
    let peak = 0;
    for (const x of m.buf) {
      const v = x < 0 ? -x : x;
      if (v > peak) peak = v;
    }
    return Math.min(1, peak * 1.4);
  }

  paintLevel(v) {
    const m = this.els.meter;
    if (!m) return;
    m.firstChild.style.transform = `scaleX(${v.toFixed(3)})`;
    m.setAttribute('aria-valuenow', String(Math.round(v * 100)));
  }

  // ------------------------------------------------------------------ recording
  elapsed() {
    const r = this.rec;
    if (!r) return 0;
    const now = performance.now();
    return Math.max(0, (now - r.t0 - r.pausedMs - (r.pauseAt ? now - r.pauseAt : 0)) / 1000);
  }

  toggleRecord() {
    if (this.saving) return;
    return this.rec ? this.stopRecording() : this.startRecording();
  }

  async startRecording() {
    if (this.rec || this.saving) return;
    if (this.trim) this.cancelTrim();
    this.stopPlayback();
    this.selected = null;
    this.renderList();
    this.els.playView.hidden = true;
    this.els.recView.hidden = false;
    this.stopMonitor();
    this.els.micMsg.textContent = '';
    let stream;
    try {
      stream = await this.openMic();
    } catch {
      this.els.micMsg.textContent = this.t('micError');
      return;
    }
    if (this.ctx.win.closed) return stream.getTracks().forEach((tr) => tr.stop());
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'].find((m) => MediaRecorder.isTypeSupported?.(m)) || '';
    const mr = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 128000 } : {});
    const rec = { stream, mr, mime: mr.mimeType || mime, chunks: [], t0: performance.now(), pausedMs: 0, pauseAt: 0, markers: [], levels: [], lastBar: 0 };
    mr.ondataavailable = (e) => e.data?.size && rec.chunks.push(e.data);
    rec.done = new Promise((res) => (mr.onstop = res));
    // the microphone goes away (unplugged): keep what was recorded
    for (const tr of stream.getAudioTracks()) tr.addEventListener('ended', () => this.micLost(rec), { once: true });
    this.rec = rec;
    this.monitor = this.attachMeter(stream);
    mr.start(1000);
    this.listDevices();
    this.paintRecordState();
    this.paintTray();
    this.trayTimer = setInterval(() => this.paintTray(), 1000);
  }

  togglePause() {
    const r = this.rec;
    if (!r) return;
    if (r.pauseAt) {
      r.pausedMs += performance.now() - r.pauseAt;
      r.pauseAt = 0;
      r.mr.resume();
    } else {
      r.pauseAt = performance.now();
      r.mr.pause();
    }
    this.paintRecordState();
    this.paintTray();
  }

  addMarker() {
    const r = this.rec;
    if (!r) return;
    const at = Math.round(this.elapsed() * 10) / 10;
    if (r.markers.some((m) => Math.abs(m - at) < 0.3)) return;
    r.markers.push(at);
    this.paintLiveMarks();
  }

  paintLiveMarks() {
    const r = this.rec;
    const box = this.els.liveMarks;
    box.replaceChildren(...(r?.markers || []).map((m, i) => this.h('span', { class: 'rc-chip' }, this.ctx.icon('flag', { size: 14, filled: true }), `${this.t('marker', { n: i + 1 })} · ${fmtTime(m)}`)));
  }

  /** The microphone ended during the recording: save what was recorded (as Stop does) and say so calmly. */
  async micLost(rec) {
    if (this.rec !== rec || this.saving) return;
    const name = await this.stopRecording();
    const { t } = this;
    const body = name ? t('micLostSaved', { name: baseOf(name) }) : '';
    this.ctx.shell.notify?.({ appId: 'recorder', title: t('micLostTitle'), body, silent: true, onClick: () => !this.ctx.win.closed && this.ctx.win.focus() });
  }

  /** Stops and saves; resolves to the saved file name (undefined when nothing was saved). */
  async stopRecording() {
    const r = this.rec;
    if (!r || this.saving) return;
    this.saving = true;
    const clockSec = this.elapsed();
    if (r.pauseAt) {
      r.pausedMs += performance.now() - r.pauseAt;
      r.pauseAt = 0;
    }
    try {
      if (r.mr.state !== 'inactive') r.mr.stop();
    } catch {
      /* already stopped */
    }
    // (a recorder already stopped by an ended track has fired 'stop' or is about to; never wait forever)
    await Promise.race([r.done, new Promise((res) => setTimeout(res, 4000))]);
    r.stream.getTracks().forEach((tr) => tr.stop());
    clearInterval(this.trayTimer);
    this.monitor?.ac.close().catch(() => {});
    this.monitor = null;
    this.rec = null;
    this.ctx.shell.setStatusItem?.(TRAY_ID, null);
    this.paintRecordState();
    this.els.state.textContent = this.t('saving');
    try {
      const blob = new Blob(r.chunks, { type: r.mime || 'audio/webm' });
      let bytes = new Uint8Array(await blob.arrayBuffer());
      let duration = clockSec;
      let buffer = null;
      try {
        buffer = await decode(bytes);
        if (buffer.duration > 0) duration = buffer.duration;
      } catch {
        /* keep the clock duration */
      }
      const ext = /ogg/.test(r.mime) ? '.ogg' : '.webm';
      if (ext === '.webm') bytes = fixDuration(bytes, duration * 1000);
      const name = await this.freeName(this.t('fileBase'), ext);
      await this.ctx.api.invoke('fs:writeBytes', `${this.dir}/${name}`, bytes);
      this.meta[name] = { duration, markers: r.markers.filter((m) => m <= duration + 0.5) };
      await this.saveMeta();
      await this.refresh();
      this.saving = false;
      await this.select(name, buffer);
      return name;
    } catch (err) {
      this.saving = false;
      this.ctx.ui.alert(this.t('saveError', { error: err?.message || String(err) }), { title: this.t('title'), parent: this.ctx.win });
    } finally {
      this.saving = false;
      this.paintRecordState();
    }
  }

  /** "Recording 3.webm": the first number after the highest in use. */
  async freeName(base, ext) {
    let n = 0;
    const re = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} (\\d+)\\.[^.]+$`);
    for (const it of this.items) {
      const m = re.exec(it.name);
      if (m) n = Math.max(n, Number(m[1]));
    }
    let name = `${base} ${n + 1}${ext}`;
    while (await this.ctx.api.invoke('fs:exists', `${this.dir}/${name}`).catch(() => false)) name = `${base} ${++n + 1}${ext}`;
    return name;
  }

  paintRecordState() {
    const { els, t, rec } = this;
    if (!els.recBtn) return;
    const on = !!rec;
    const paused = !!rec?.pauseAt;
    els.recBtn.classList.toggle('on', on);
    els.recBtn.setAttribute('aria-label', on ? t('stop') : t('start'));
    els.recBtn.dataset.tip = `${on ? t('stop') : t('start')} (Ctrl+R)`;
    els.pauseBtn.disabled = !on;
    els.markBtn.disabled = !on;
    els.pauseBtn.replaceChildren(this.ctx.icon(paused ? 'record' : 'pause', { size: 20, filled: true }));
    els.pauseBtn.setAttribute('aria-label', paused ? t('resume') : t('pause'));
    els.pauseBtn.dataset.tip = `${paused ? t('resume') : t('pause')} (${this.ctx.lang === 'fr' ? 'Espace' : 'Space'})`;
    els.state.textContent = this.saving ? t('saving') : on ? (paused ? t('paused') : t('recording')) : t('ready');
    els.recView.classList.toggle('recording', on && !paused);
    els.recView.classList.toggle('paused', paused);
    els.testBtn.disabled = on;
    els.testBtn.textContent = this.monitor?.test ? t('stopTest') : t('testMic');
    if (!on && !this.saving) {
      els.timer.textContent = fmtTime(0, { tenths: true, sep: this.decSep() });
      this.paintLiveMarks();
    }
    this.ctx.win.el?.classList.toggle('rc-is-recording', on);
  }

  decSep() {
    return this.ctx.lang === 'fr' ? ',' : '.';
  }

  paintTray() {
    const r = this.rec;
    if (!r) return this.ctx.shell.setStatusItem?.(TRAY_ID, null);
    const pos = document.documentElement.dataset.tbPos || 'bottom';
    this.ctx.shell.setStatusItem?.(TRAY_ID, {
      icon: r.pauseAt ? 'pause-fill' : 'record-fill',
      text: ['left', 'right'].includes(pos) ? '' : fmtTime(this.elapsed()),
      tip: this.t('trayTip'),
      onClick: () => {
        this.ctx.win.focus();
      },
    });
  }

  // ------------------------------------------------------------------ animation loop (live waveform, meter, playhead)
  loop() {
    const tick = () => {
      if (this.ctx.win.closed) return;
      this.raf = requestAnimationFrame(tick);
      const lv = this.monitor ? this.level() : 0;
      if (this.monitor) this.paintLevel(lv);
      const r = this.rec;
      if (r) {
        const el = this.elapsed();
        this.els.timer.textContent = fmtTime(el, { tenths: true, sep: this.decSep() });
        if (!r.pauseAt) {
          const want = Math.floor(el * LIVE_RATE);
          while (r.levels.length <= want) r.levels.push(Math.max(lv, r.levels.length === want ? 0 : r.levels[r.levels.length - 1] || 0));
          r.levels[want] = Math.max(r.levels[want] || 0, lv);
        }
        this.drawLive();
      }
      if (this.play?.playing) {
        const p = this.play;
        p.pos = p.from + (this.audio.currentTime - p.at);
        const end = this.trim ? this.trim.b : p.buffer.duration;
        if (p.pos >= end) {
          this.stopPlayback();
          p.pos = this.trim ? this.trim.a : 0;
        }
        this.drawWave();
      }
    };
    this.raf = requestAnimationFrame(tick);
  }

  drawLive() {
    const cv = this.els.live;
    if (!cv || !cv.isConnected) return;
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth;
    const hgt = cv.clientHeight;
    if (!w || !hgt) return;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(hgt * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(hgt * dpr);
    }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, hgt);
    const r = this.rec;
    const levels = r?.levels || [];
    const step = 4;
    const n = Math.floor(w / step);
    const start = Math.max(0, levels.length - n);
    const mid = hgt / 2;
    g.fillStyle = css(cv, '--line-soft') || '#888';
    g.fillRect(0, Math.round(mid), w, 1);
    g.fillStyle = r?.pauseAt ? css(cv, '--text-3') : css(cv, '--danger');
    for (let i = start; i < levels.length; i++) {
      const x = w - (levels.length - i) * step;
      const amp = Math.max(1.5, levels[i] * (hgt / 2 - 4));
      g.fillRect(x, mid - amp, 2.5, amp * 2);
    }
    // markers
    g.fillStyle = css(cv, '--warning') || css(cv, '--accent');
    for (const m of r?.markers || []) {
      const i = Math.floor(m * LIVE_RATE);
      if (i < start) continue;
      const x = w - (levels.length - i) * step;
      g.fillRect(x, 4, 2, hgt - 8);
      g.beginPath();
      g.moveTo(x + 2, 4);
      g.lineTo(x + 10, 8);
      g.lineTo(x + 2, 12);
      g.fill();
    }
  }

  // ------------------------------------------------------------------ selection and playback
  async select(name, preDecoded = null) {
    if (this.rec) return;
    if (this.trim) this.cancelTrim();
    if (name === this.selected && this.play?.buffer) return;
    this.stopPlayback();
    this.selected = name;
    this.renderList();
    if (!name) {
      this.play = null;
      this.els.playView.hidden = true;
      this.els.recView.hidden = false;
      return;
    }
    this.showPlayView();
    const it = this.items.find((i) => i.name === name);
    this.els.name.textContent = baseOf(name);
    this.els.date.textContent = it ? this.fmtDate(it.mtime) : '';
    this.els.loadMsg.hidden = true;
    this.play = { name, buffer: null, peaks: null, pos: 0, playing: false };
    this.paintMarks();
    this.drawWave();
    const play = this.play;
    try {
      const buffer = preDecoded || (await decode(await this.ctx.api.invoke('fs:readBytes', `${this.dir}/${name}`)));
      if (this.play !== play) return;
      play.buffer = buffer;
      play.peaks = peaks(buffer, 1600);
      const m = (this.meta[name] ||= { markers: [] });
      if (Math.abs((m.duration || 0) - buffer.duration) > 0.05) {
        m.duration = buffer.duration;
        this.saveMeta();
        this.renderList();
      }
    } catch {
      if (this.play !== play) return;
      this.els.loadMsg.textContent = this.t('loadError');
      this.els.loadMsg.hidden = false;
    }
    this.paintMarks();
    this.paintTransport();
    this.drawWave();
  }

  get duration() {
    return this.play?.buffer?.duration || 0;
  }

  paintMarks() {
    const { h, t } = this;
    const marks = this.meta[this.selected]?.markers || [];
    this.els.markList.replaceChildren(
      ...(marks.length
        ? marks.map((m, i) => h('button', { class: 'rc-chip', onclick: () => this.seek(m) }, this.ctx.icon('flag', { size: 14, filled: true }), `${t('marker', { n: i + 1 })} · ${fmtTime(m)}`))
        : [h('div', { class: 'rc-marks-empty' }, t('noMarkers'))]),
    );
  }

  paintTransport() {
    const p = this.play;
    const { els, t } = this;
    if (!els.playBtn) return;
    els.playBtn.replaceChildren(this.ctx.icon(p?.playing ? 'pause' : 'play', { size: 22, filled: true }));
    els.playBtn.setAttribute('aria-label', p?.playing ? t('pausePlay') : t('play'));
    els.playBtn.dataset.tip = p?.playing ? t('pausePlay') : t('play');
    els.playBtn.disabled = !p?.buffer;
    els.total.textContent = fmtTime(this.duration);
  }

  togglePlay() {
    const p = this.play;
    if (!p?.buffer) return;
    if (p.playing) this.stopPlayback();
    else this.startPlayback();
  }

  startPlayback() {
    const p = this.play;
    if (!p?.buffer) return;
    this.audio ||= new AudioContext();
    this.audio.resume?.();
    const lo = this.trim ? this.trim.a : 0;
    const hi = this.trim ? this.trim.b : p.buffer.duration;
    if (p.pos < lo || p.pos >= hi - 0.05) p.pos = lo;
    const src = this.audio.createBufferSource();
    src.buffer = p.buffer;
    src.connect(this.audio.destination);
    src.start(0, p.pos, hi - p.pos);
    p.src = src;
    p.from = p.pos;
    p.at = this.audio.currentTime;
    p.playing = true;
    this.paintTransport();
  }

  stopPlayback() {
    const p = this.play;
    if (!p?.playing) return;
    p.pos = p.from + (this.audio.currentTime - p.at);
    try {
      p.src.stop();
    } catch {
      /* ended */
    }
    p.src.disconnect();
    p.src = null;
    p.playing = false;
    this.paintTransport();
    this.drawWave();
  }

  seek(sec) {
    const p = this.play;
    if (!p?.buffer) return;
    const was = p.playing;
    if (was) this.stopPlayback();
    p.pos = Math.max(0, Math.min(p.buffer.duration, sec));
    if (was) this.startPlayback();
    this.drawWave();
  }

  xToTime(clientX) {
    const r = this.els.wave.getBoundingClientRect();
    return (Math.max(0, Math.min(r.width, clientX - r.left)) / (r.width || 1)) * this.duration;
  }

  seekPointer(e) {
    if (!this.play?.buffer || e.button !== 0) return;
    const el = this.els.seek;
    el.setPointerCapture?.(e.pointerId);
    this.seek(this.xToTime(e.clientX));
    const move = (ev) => this.seek(this.xToTime(ev.clientX));
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  seekKey(e) {
    const p = this.play;
    if (!p?.buffer) return;
    const d = { ArrowLeft: -5, ArrowRight: 5, PageDown: -30, PageUp: 30 }[e.key];
    if (d != null) this.seek(p.pos + d);
    else if (e.key === 'Home') this.seek(0);
    else if (e.key === 'End') this.seek(this.duration);
    else return;
    e.preventDefault();
    e.stopPropagation();
  }

  drawWave() {
    const cv = this.els.wave;
    if (!cv || !cv.isConnected || this.els.playView.hidden) return;
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth;
    const hgt = cv.clientHeight;
    if (!w || !hgt) return;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(hgt * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(hgt * dpr);
    }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, hgt);
    const p = this.play;
    const mid = hgt / 2;
    const dur = this.duration;
    const played = css(cv, '--accent');
    const rest = css(cv, '--text-3');
    g.fillStyle = css(cv, '--line-soft');
    g.fillRect(0, Math.round(mid), w, 1);
    if (p?.peaks && dur) {
      const step = 3;
      const n = Math.floor(w / step);
      const posX = (p.pos / dur) * w;
      for (let i = 0; i < n; i++) {
        const k = Math.floor((i / n) * p.peaks.length);
        let v = 0;
        const k2 = Math.max(k + 1, Math.floor(((i + 1) / n) * p.peaks.length));
        for (let j = k; j < k2; j++) v = Math.max(v, p.peaks[j]);
        const amp = Math.max(1, Math.sqrt(v) * (hgt / 2 - 6));
        const x = i * step;
        g.fillStyle = x < posX ? played : rest;
        g.fillRect(x, mid - amp, 2, amp * 2);
      }
      // trimmed-away parts
      if (this.trim) {
        g.fillStyle = css(cv, '--subtle-pressed') || 'rgba(0,0,0,.3)';
        g.fillRect(0, 0, (this.trim.a / dur) * w, hgt);
        g.fillRect((this.trim.b / dur) * w, 0, w - (this.trim.b / dur) * w, hgt);
      }
      // markers
      g.fillStyle = css(cv, '--warning') || played;
      for (const m of this.meta[this.selected]?.markers || []) {
        const x = Math.round((m / dur) * w);
        g.fillRect(x - 1, 2, 2, hgt - 4);
        g.beginPath();
        g.moveTo(x + 1, 2);
        g.lineTo(x + 9, 6);
        g.lineTo(x + 1, 10);
        g.fill();
      }
      // playhead
      g.fillStyle = css(cv, '--text');
      g.fillRect(Math.min(w - 2, Math.round(posX)), 0, 2, hgt);
    }
    const cur = p?.pos || 0;
    this.els.cur.textContent = fmtTime(cur);
    this.els.seek.setAttribute('aria-valuemax', String(Math.round(dur)));
    this.els.seek.setAttribute('aria-valuenow', String(Math.round(cur)));
    this.els.seek.setAttribute('aria-valuetext', `${fmtTime(cur)} / ${fmtTime(dur)}`);
    if (this.trim) this.placeHandles();
  }

  // ------------------------------------------------------------------ trim
  startTrim() {
    if (!this.play?.buffer || this.trim) return;
    this.stopPlayback();
    this.trim = { a: 0, b: this.duration };
    this.els.hA.hidden = false;
    this.els.hB.hidden = false;
    this.els.waveWrap.classList.add('trimming');
    const { h, t } = this;
    this.els.trimA = h('span', { class: 'rc-trim-time' });
    this.els.trimB = h('span', { class: 'rc-trim-time' });
    this.els.trimBar.replaceChildren(
      h('div', { class: 'rc-trim-info' }, h('div', { class: 'rc-trim-hint' }, t('trimHint')), h('div', { class: 'rc-trim-times' }, t('trimStart'), ' ', this.els.trimA, ' · ', t('trimEnd'), ' ', this.els.trimB)),
      h(
        'div',
        { class: 'rc-trim-btns' },
        h('button', { class: 'btn', dataset: { trim: 'cancel' }, onclick: () => this.cancelTrim() }, this.ctx.t('common.cancel')),
        h('button', { class: 'btn', dataset: { trim: 'replace' }, onclick: () => this.applyTrim(true) }, t('replace')),
        h('button', { class: 'btn primary', dataset: { trim: 'copy' }, onclick: () => this.applyTrim(false) }, t('saveCopy')),
      ),
    );
    this.els.trimBar.hidden = false;
    this.els.actions.querySelectorAll('button').forEach((b) => (b.disabled = true));
    this.drawWave();
    this.els.hA.focus();
  }

  cancelTrim() {
    if (!this.trim) return;
    this.stopPlayback();
    this.trim = null;
    this.els.hA.hidden = true;
    this.els.hB.hidden = true;
    this.els.waveWrap.classList.remove('trimming');
    this.els.trimBar.hidden = true;
    this.els.actions.querySelectorAll('button').forEach((b) => (b.disabled = false));
    this.drawWave();
  }

  setTrim(which, sec) {
    const tr = this.trim;
    if (!tr) return;
    const min = 0.2;
    if (which === 'a') tr.a = Math.max(0, Math.min(tr.b - min, sec));
    else tr.b = Math.min(this.duration, Math.max(tr.a + min, sec));
    if (this.play) {
      if (this.play.playing) this.stopPlayback();
      this.play.pos = Math.max(tr.a, Math.min(tr.b, this.play.pos));
    }
    this.drawWave();
  }

  placeHandles() {
    const tr = this.trim;
    const dur = this.duration || 1;
    for (const [k, el] of [['a', this.els.hA], ['b', this.els.hB]]) {
      el.style.left = `${(tr[k] / dur) * 100}%`;
      el.setAttribute('aria-valuemin', '0');
      el.setAttribute('aria-valuemax', String(Math.round(dur * 10) / 10));
      el.setAttribute('aria-valuenow', String(Math.round(tr[k] * 10) / 10));
      el.setAttribute('aria-valuetext', fmtTime(tr[k], { tenths: true, sep: this.decSep() }));
    }
    this.els.trimA.textContent = fmtTime(tr.a, { tenths: true, sep: this.decSep() });
    this.els.trimB.textContent = fmtTime(tr.b, { tenths: true, sep: this.decSep() });
  }

  handlePointer(e, which) {
    if (e.button !== 0) return;
    e.stopPropagation();
    const el = which === 'a' ? this.els.hA : this.els.hB;
    el.setPointerCapture?.(e.pointerId);
    el.focus();
    const move = (ev) => this.setTrim(which, this.xToTime(ev.clientX));
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  handleKey(e, which) {
    const d = { ArrowLeft: -0.1, ArrowRight: 0.1, ArrowDown: -1, ArrowUp: 1, PageDown: -10, PageUp: 10 }[e.key];
    if (d == null) return;
    e.preventDefault();
    e.stopPropagation();
    this.setTrim(which, this.trim[which] + d);
  }

  async applyTrim(replace) {
    const tr = this.trim;
    const p = this.play;
    if (!tr || !p?.buffer || this.saving) return;
    const name = this.selected;
    const { api, ui, win } = this.ctx;
    if (replace && !(await ui.confirm(this.t('replaceConfirm', { name: baseOf(name) }), { title: this.t('trim'), okLabel: this.t('replace'), danger: true, parent: win }))) return;
    this.saving = true;
    this.els.trimBar.querySelectorAll('button').forEach((b) => (b.disabled = true));
    try {
      const { bytes, ext } = await encodeSlice(p.buffer, tr.a, tr.b);
      const markers = (this.meta[name]?.markers || []).filter((m) => m >= tr.a && m <= tr.b).map((m) => Math.round((m - tr.a) * 10) / 10);
      const duration = tr.b - tr.a;
      let target;
      if (replace) {
        target = baseOf(name) + ext;
        if (target !== name) {
          target = await this.uniqueIn(baseOf(name), ext);
          await api.invoke('fs:writeBytes', `${this.dir}/${target}`, bytes);
          await api.invoke('fs:delete', [`${this.dir}/${name}`]);
          delete this.meta[name];
        } else await api.invoke('fs:writeBytes', `${this.dir}/${target}`, bytes);
      } else {
        target = await this.uniqueIn(`${baseOf(name)} (${this.t('trimSuffix')})`, ext);
        await api.invoke('fs:writeBytes', `${this.dir}/${target}`, bytes);
      }
      this.meta[target] = { duration, markers };
      await this.saveMeta();
      this.saving = false;
      this.cancelTrim();
      this.selected = null;
      await this.refresh();
      await this.select(target);
    } catch (err) {
      this.saving = false;
      this.els.trimBar.querySelectorAll('button').forEach((b) => (b.disabled = false));
      ui.alert(this.t('saveError', { error: err?.message || String(err) }), { title: this.t('title'), parent: win });
    }
  }

  // ------------------------------------------------------------------ export (.m4a / .mp3 through ffmpeg, main/ipc/recorder.js)
  exportItems(name) {
    return [
      { label: this.t('exportMp3'), icon: 'export', action: () => this.exportAs(name, 'mp3') },
      { label: this.t('exportM4a'), icon: 'export', action: () => this.exportAs(name, 'm4a') },
    ];
  }

  async exportAs(name, fmt) {
    if (!name || this.rec || this.saving) return;
    const { api, ui, win } = this.ctx;
    this.saving = true;
    this.els.actions.querySelectorAll('button').forEach((b) => (b.disabled = true));
    try {
      const { path } = await api.invoke('recorder:export', `${this.dir}/${name}`, fmt);
      const target = path.split('/').pop();
      if (this.meta[name]) this.meta[target] = { ...this.meta[name] };
      await this.saveMeta();
      this.saving = false;
      this.selected = null;
      await this.refresh();
      await this.select(target);
    } catch (err) {
      ui.alert(this.t('saveError', { error: err?.message || String(err) }), { title: this.t('title'), parent: win });
    } finally {
      this.saving = false;
      if (!this.trim) this.els.actions.querySelectorAll('button').forEach((b) => (b.disabled = false));
    }
  }

  async uniqueIn(base, ext) {
    let name = `${base}${ext}`;
    let n = 2;
    while (await this.ctx.api.invoke('fs:exists', `${this.dir}/${name}`).catch(() => false)) name = `${base} ${n++}${ext}`;
    return name;
  }

  // ------------------------------------------------------------------ file actions
  async rename(name) {
    if (!name || this.rec) return;
    const { ui, api, win } = this.ctx;
    const ext = extOf(name);
    const taken = (v) => this.items.some((i) => i.name.toLowerCase() === `${v}${ext}`.toLowerCase() && i.name !== name);
    const value = await ui.prompt({
      title: this.t('renameTitle'),
      label: this.t('newName'),
      value: baseOf(name),
      parent: win,
      maxlength: 200,
      validate: (v) => {
        const s = String(v || '').trim();
        if (!s || s.includes('/') || s === '.' || s === '..') return this.t('nameInvalid');
        if (taken(s)) return this.t('nameTaken');
        return null;
      },
    });
    const s = String(value ?? '').trim();
    if (!s || s === baseOf(name) || s.includes('/') || taken(s)) return;
    const wasPlaying = this.selected === name;
    this.stopPlayback();
    await api.invoke('fs:rename', `${this.dir}/${name}`, `${s}${ext}`);
    if (this.meta[name]) {
      this.meta[`${s}${ext}`] = this.meta[name];
      delete this.meta[name];
      await this.saveMeta();
    }
    if (wasPlaying && this.play) {
      this.selected = `${s}${ext}`;
      this.play.name = this.selected;
      this.els.name.textContent = s;
    }
    await this.refresh();
  }

  async remove(name) {
    if (!name || this.rec) return;
    const { ui, api, win } = this.ctx;
    const ok = await ui.confirm(this.t('deleteConfirm', { name: baseOf(name) }), { title: this.t('delete'), okLabel: this.t('delete'), danger: true, parent: win });
    if (!ok) return;
    const idx = this.items.findIndex((i) => i.name === name);
    if (this.selected === name) {
      this.stopPlayback();
      this.play = null;
    }
    await api.invoke('fs:trash', [`${this.dir}/${name}`]);
    delete this.meta[name];
    await this.saveMeta();
    const wasSelected = this.selected === name;
    if (wasSelected) this.selected = null;
    await this.refresh();
    if (wasSelected) {
      const next = this.items[Math.min(idx, this.items.length - 1)];
      if (next) await this.select(next.name);
      else this.select(null);
    }
  }

  async showInFiles(name) {
    const { api, shell } = this.ctx;
    const exists = await api.invoke('fs:exists', this.dir).catch(() => false);
    if (!exists && !name) await api.invoke('fs:mkdir', this.dir).catch(() => {});
    if (name) return shell.launch('files', { path: this.dir, select: `${this.dir}/${name}` });
    return shell.launch('files', { path: this.dir });
  }

  // ------------------------------------------------------------------ keyboard
  onKey(e) {
    const tag = e.target?.tagName;
    const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target?.isContentEditable;
    // a dialog (rename, confirm…) over this window or the whole shell: no shortcut acts behind it
    const dialog = '.dialog-layer:not(.closing)';
    if (e.target?.closest?.(dialog) || this.ctx.win.el?.querySelector(dialog) || document.querySelector(`${dialog}.global`)) return;
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'r') {
      e.preventDefault();
      const textField = tag === 'INPUT' || tag === 'TEXTAREA' || e.target?.isContentEditable;
      if (!textField) this.toggleRecord();
      return;
    }
    if (typing || e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.key === 'm' || e.key === 'M') {
      if (this.rec) {
        e.preventDefault();
        this.addMarker();
      }
    } else if (e.key === ' ') {
      if (e.target?.tagName === 'BUTTON' && !this.rec) return; // a focused button activates itself
      if (this.rec) this.togglePause();
      else if (this.play?.buffer) this.togglePlay();
      else return;
      e.preventDefault();
    } else if (e.key === 'F2' && this.selected && !this.rec) {
      e.preventDefault();
      this.rename(this.selected);
    } else if (e.key === 'Delete' && this.selected && !this.rec && !this.trim) {
      e.preventDefault();
      this.remove(this.selected);
    } else if (e.key === 'Escape' && this.trim) {
      e.preventDefault();
      this.cancelTrim();
    }
  }
}

export default {
  async launch(ctx) {
    const app = new Recorder(ctx);
    const winEl = ctx.win.el || ctx.win.body.closest('.win');
    if (winEl) winEl.__recorder = app;
    await app.init();
    return {
      onRelaunch() {
        ctx.win.focus();
      },
    };
  },
};
