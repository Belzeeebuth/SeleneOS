// Screen Recorder: records the whole screen or a drawn area to WebM (MP4 through ffmpeg), with the microphone and the
// computer sound if asked. lib/capture.js holds the pipeline and the overlays; main/ipc/screenrec.js writes the file.
//
// Flow: Start -> (Area: draw it) -> the window hides -> 3-2-1 -> recording, with a small floating control (time,
// pause, stop) that is never in the video, and a red tray chip « Arrêter l'enregistrement ». Stop -> the file is
// saved to ~/Vidéos/Enregistrements d'écran (EN: ~/Videos/Screen recordings) -> notification « Enregistrement
// sauvegardé » with Ouvrir / Afficher dans Fichiers; the window comes back with the last recording (when it was shown).
// Launch args: { toggle: true } (Super+Shift+R, features/hotkeys.js) starts with the saved choices, or stops.
// Test hooks: win.el.__screenrec = { app } (state, rec, start(), stop()).
import { wm } from '../../core/wm.js';
import { pickRegion, countdown, controlPlace, Recording, fmtTime } from './lib/capture.js';

const TRAY_ID = 'screenrec';
const DEFAULTS = { mode: 'full', mic: false, system: false, format: 'webm' };

class ScreenRecorder {
  constructor(ctx) {
    this.ctx = ctx;
    this.t = ctx.t;
    this.state = 'idle'; // idle | picking | starting | countdown | recording | paused | saving
    this.prefs = { ...DEFAULTS, ...(ctx.storage.get('prefs', {}) || {}) };
    this.last = null; // { path, size, duration, format }
    this.warnings = [];
    this.wasShown = false;
  }

  // ------------------------------------------------------------------ window
  build() {
    const { h, icon, ui, t, win } = this.ctx;
    const savePrefs = () => this.ctx.storage.set('prefs', this.prefs);
    const row = (ic, title, desc, control) =>
      h('div', { class: 'sr-row' }, icon(ic, { size: 20 }), h('div', { class: 'sr-row-text' }, h('div', { class: 'sr-row-title' }, title), desc ? h('div', { class: 'sr-row-desc' }, desc) : null), control);
    this.modeSeg = ui.segmented({
      options: [
        { value: 'full', label: t('modes.full'), icon: 'monitor' },
        { value: 'region', label: t('modes.region'), icon: 'selection' },
      ],
      value: this.prefs.mode,
      onchange: (v) => {
        this.prefs.mode = v;
        savePrefs();
      },
    });
    this.modeSeg.classList.add('sr-modes');
    const micT = ui.toggle({ checked: this.prefs.mic, ariaLabel: t('mic'), onchange: (v) => ((this.prefs.mic = v), savePrefs()) });
    const sysT = ui.toggle({ checked: this.prefs.system, ariaLabel: t('system'), onchange: (v) => ((this.prefs.system = v), savePrefs()) });
    micT.dataset.opt = 'mic';
    sysT.dataset.opt = 'system';
    const fmt = ui.select({
      options: [
        { value: 'webm', label: t('formatWebm') },
        { value: 'mp4', label: t('formatMp4') },
      ],
      value: this.prefs.format,
      onchange: (v) => ((this.prefs.format = v), savePrefs()),
    });
    fmt.classList.add('sr-format');
    this.startBtn = h('button', { class: 'btn primary sr-start', onclick: () => this.start() }, h('span', { class: 'sr-start-dot', 'aria-hidden': 'true' }), h('span', null, t('start')));
    this.info = h('div', { class: 'sr-info' });
    this.lastBox = h('div', { class: 'sr-last', hidden: true });
    this.root = h(
      'div',
      { class: 'sr-root' },
      h('div', { class: 'sr-section-title' }, t('whatTitle')),
      this.modeSeg,
      h('div', { class: 'sr-card' }, row('microphone', t('mic'), t('micDesc'), micT), row('speaker-high', t('system'), t('systemDesc'), sysT), row('film-strip', t('format'), null, fmt)),
      this.info,
      this.startBtn,
      this.lastBox,
      h('div', { class: 'sr-foot' }, h('span', { class: 'sr-hint' }, t('hint')), h('button', { class: 'btn subtle small sr-folder', onclick: () => this.openFolder() }, icon('folder-open', { size: 16 }), h('span', null, t('openFolder')))),
    );
    win.body.appendChild(this.root);
  }

  showInfo(kind, text) {
    const { h, icon } = this.ctx;
    this.info.replaceChildren(text ? h('div', { class: `infobar ${kind}` }, icon(kind === 'error' ? 'warning-circle' : 'info', { size: 16 }), h('span', null, text)) : '');
  }

  renderLast() {
    const { h, icon, t, api } = this.ctx;
    const l = this.last;
    this.lastBox.hidden = !l;
    if (!l) return;
    const name = l.path.split('/').pop();
    const preview = h('video', { class: 'sr-last-thumb', src: `${api.mediaUrl(l.path)}#t=0.1`, muted: true, preload: 'metadata', 'aria-hidden': 'true' });
    const sizeTxt = this.ctx.i18n?.formatSize ? this.ctx.i18n.formatSize(l.size || 0) : `${Math.round((l.size || 0) / 1024)} KB`;
    this.lastBox.replaceChildren(
      h('div', { class: 'sr-section-title' }, t('last')),
      h(
        'div',
        { class: 'sr-last-card' },
        preview,
        h('div', { class: 'sr-last-text' }, h('div', { class: 'sr-last-name ellipsis', title: name }, name), h('div', { class: 'sr-last-meta' }, `${fmtTime(l.duration || 0)} · ${sizeTxt} · ${l.format.toUpperCase()}`)),
        h('div', { class: 'sr-last-actions' }, h('button', { class: 'btn small sr-open', onclick: () => this.openLast() }, icon('play', { size: 16 }), h('span', null, t('open'))), h('button', { class: 'btn subtle small sr-reveal', onclick: () => this.revealLast() }, icon('folder-open', { size: 16 }), h('span', null, t('showInFiles')))),
      ),
    );
  }

  hideWindow() {
    const { win } = this.ctx;
    this.wasShown = win.el.classList.contains('sr-ready') && !win.el.classList.contains('sr-hidden') && !win.minimized;
    win.el.classList.add('sr-hidden');
    if (!win.opts.skipTaskbar) {
      win.opts.skipTaskbar = true;
      this.skipSet = true;
      wm.emit('change', win);
    }
    if (wm.focused() === win) wm.focusTop?.(win);
  }

  showWindow(focus = true) {
    const { win } = this.ctx;
    if (win.closed) return;
    win.el.classList.remove('sr-hidden');
    win.el.classList.add('sr-ready');
    if (this.skipSet) {
      win.opts.skipTaskbar = false;
      this.skipSet = false;
      wm.emit('change', win);
    }
    if (win.minimized) win.restoreFromMinimize?.();
    if (focus) win.focus();
  }

  setBusy(on) {
    this.startBtn.disabled = on;
    this.root.classList.toggle('busy', on);
  }

  // ------------------------------------------------------------------ folder
  async folder() {
    const { api, shell } = this.ctx;
    const x = shell.xdg || (await api.invoke('fs:xdg').catch(() => null));
    const videos = x?.videos || `${x?.home || (await api.invoke('fs:home'))}/Videos`;
    return `${videos.replace(/\/$/, '')}/${this.t('folderName')}`;
  }

  async openFolder() {
    const dir = await this.folder();
    await this.ctx.api.invoke('fs:mkdir', dir).catch(() => {});
    this.ctx.shell.openFile(dir);
  }

  openLast() {
    if (this.last) this.ctx.shell.openFile(this.last.path);
  }

  revealLast() {
    if (!this.last) return;
    const p = this.last.path;
    this.ctx.shell.launch('files', { path: p.slice(0, p.lastIndexOf('/')) || '/', select: p });
  }

  // ------------------------------------------------------------------ recording
  async start({ fromHotkey = false } = {}) {
    if (this.state !== 'idle') return;
    const { t } = this;
    this.showInfo(null);
    this.setBusy(true);
    this.warnings = [];
    let rect = { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight };
    this.hideWindow();
    if (fromHotkey) this.wasShown = false;
    try {
      if (this.prefs.mode === 'region') {
        this.state = 'picking';
        await new Promise((r) => setTimeout(r, 60));
        const r = await pickRegion({ h: this.ctx.h, t });
        if (!r) return this.backToIdle();
        if (r !== 'full') rect = r;
      }
      this.state = 'starting';
      this.rect = rect;
      // the file first: chunks are written as they come
      const dir = await this.folder();
      const stamp = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const date = `${stamp.getFullYear()}-${pad(stamp.getMonth() + 1)}-${pad(stamp.getDate())} ${pad(stamp.getHours())}.${pad(stamp.getMinutes())}.${pad(stamp.getSeconds())}`;
      this.writeChain = Promise.resolve();
      this.writeError = null;
      const rec = new Recording({
        api: this.ctx.api,
        rect,
        mic: this.prefs.mic,
        system: this.prefs.system,
        onChunk: (blob) => this.write(blob),
        onEnded: () => this.stop(),
      });
      this.rec = rec;
      const { warnings } = await rec.open();
      this.warnings = warnings;
      this.file = await this.ctx.api.invoke('screenrec:open', dir, t('fileBase', { date }));
      this.state = 'countdown';
      const go = await countdown({ h: this.ctx.h, t, rect });
      if (!go || this.state !== 'countdown') {
        rec.dispose();
        await this.ctx.api.invoke('screenrec:abort', this.file.id).catch(() => {});
        this.file = null;
        return this.backToIdle();
      }
      await rec.start(() => this.showControl(rect));
      this.state = 'recording';
      this.setTray();
      this.tick = setInterval(() => this.paintTime(), 500);
      this.offLock = this.ctx.shell.on?.('lock', () => this.stop());
    } catch (err) {
      console.warn('[screenrec] start failed', err);
      this.rec?.dispose();
      this.rec = null;
      if (this.file) await this.ctx.api.invoke('screenrec:abort', this.file.id).catch(() => {});
      this.file = null;
      this.hideControl();
      this.backToIdle(true);
      this.showInfo('error', err?.code === 'ENOSCREEN' ? t('errScreen') : t('errStart', { msg: err?.message || String(err) }));
    }
  }

  backToIdle(show = this.wasShown) {
    this.state = 'idle';
    this.setBusy(false);
    if (show) this.showWindow();
  }

  write(blob) {
    if (!this.file) return;
    const id = this.file.id;
    this.writeChain = this.writeChain
      .then(async () => this.ctx.api.invoke('screenrec:append', id, new Uint8Array(await blob.arrayBuffer())))
      .catch((err) => {
        this.writeError = err;
      });
  }

  // floating control: time, pause / resume, stop
  showControl(rect) {
    const { h, icon, t } = this.ctx;
    this.hideControl();
    this.timeEl = h('span', { class: 'sr-ctl-time' }, '0:00');
    this.pauseBtn = h('button', { class: 'sr-ctl-btn sr-ctl-pause', 'aria-label': t('pause'), 'data-tip': t('pause'), onclick: () => this.togglePause() }, icon('pause', { size: 16, filled: true }));
    const stopBtn = h('button', { class: 'sr-ctl-btn sr-ctl-stop', 'aria-label': t('stop'), 'data-tip': t('stop'), onclick: () => this.stop() }, icon('stop', { size: 16, filled: true }));
    this.ctl = h('div', { class: 'app-screenrec sr-control', role: 'toolbar', 'aria-label': t('recording') }, h('span', { class: 'sr-ctl-dot', 'aria-hidden': 'true' }), this.timeEl, this.pauseBtn, stopBtn);
    (document.getElementById('overlays') || document.body).appendChild(this.ctl);
    const box = this.ctl.getBoundingClientRect();
    const pos = controlPlace(rect, { width: box.width, height: box.height });
    Object.assign(this.ctl.style, { left: `${pos.left}px`, top: `${pos.top}px` });
    // a dashed frame just outside the area (never inside it, so never in the video)
    if (rect.width < window.innerWidth - 4 || rect.height < window.innerHeight - 4) {
      this.frame = h('div', { class: 'app-screenrec sr-frame', 'aria-hidden': 'true' });
      Object.assign(this.frame.style, { left: `${rect.x - 3}px`, top: `${rect.y - 3}px`, width: `${rect.width + 6}px`, height: `${rect.height + 6}px` });
      (document.getElementById('overlays') || document.body).appendChild(this.frame);
    }
    return this.ctl.getBoundingClientRect();
  }

  hideControl() {
    this.ctl?.remove();
    this.frame?.remove();
    this.ctl = this.frame = null;
  }

  paintTime() {
    if (!this.rec) return;
    const txt = fmtTime(this.rec.elapsed());
    if (this.timeEl) this.timeEl.textContent = this.state === 'paused' ? `${txt} · ${this.t('paused')}` : txt;
    const chip = document.querySelector(`.tb-btn[data-status="${TRAY_ID}"]`);
    const label = chip?.querySelector('.tb-status-text');
    if (label) label.textContent = txt;
    if (chip) {
      chip.dataset.tip = this.t('trayTip', { time: txt });
      chip.classList.toggle('sr-paused', this.state === 'paused');
    }
  }

  setTray() {
    const pos = document.documentElement.dataset.tbPos || 'bottom';
    this.ctx.shell.setStatusItem?.(TRAY_ID, {
      icon: 'record-fill',
      text: ['left', 'right'].includes(pos) ? '' : '0:00',
      tip: this.t('stop'),
      onClick: () => this.stop(),
    });
  }

  togglePause() {
    if (!this.rec) return;
    const { icon, t } = this.ctx;
    if (this.state === 'recording') {
      this.rec.pause();
      this.state = 'paused';
      this.pauseBtn.replaceChildren(icon('play', { size: 16, filled: true }));
      this.pauseBtn.setAttribute('aria-label', t('resume'));
      this.pauseBtn.dataset.tip = t('resume');
      this.ctl?.classList.add('paused');
    } else if (this.state === 'paused') {
      this.rec.resume();
      this.state = 'recording';
      this.pauseBtn.replaceChildren(icon('pause', { size: 16, filled: true }));
      this.pauseBtn.setAttribute('aria-label', t('pause'));
      this.pauseBtn.dataset.tip = t('pause');
      this.ctl?.classList.remove('paused');
    }
    this.paintTime();
  }

  async stop() {
    if (this.state === 'countdown' || this.state === 'picking' || this.state === 'starting') {
      // Esc-like cancel: the countdown / picker listen to Escape
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return;
    }
    if (this.state !== 'recording' && this.state !== 'paused') return;
    const { t, api, shell } = this.ctx;
    this.state = 'saving';
    clearInterval(this.tick);
    this.offLock?.();
    this.hideControl();
    shell.setStatusItem?.(TRAY_ID, null);
    const rec = this.rec;
    await rec.stop();
    await this.writeChain;
    const file = this.file;
    this.file = null;
    this.rec = null;
    const mp4 = this.prefs.format === 'mp4';
    if (this.wasShown) {
      this.showWindow(false);
      this.showInfo('info', mp4 ? t('converting') : t('saving'));
    }
    try {
      if (this.writeError) throw this.writeError;
      const res = await api.invoke('screenrec:finish', file.id, { mp4 });
      this.last = { ...res, duration: rec.duration || 0 };
      const warn = [...this.warnings.map((w) => (w === 'mic' ? t('warnMic') : t('warnSystem'))), res.warning === 'ENOFFMPEG' ? t('warnNoFfmpeg') : res.warning === 'EMP4' ? t('warnMp4') : null].filter(Boolean);
      this.showInfo(warn.length ? 'warning' : null, warn.join(' '));
      this.renderLast();
      const p = res.path;
      shell.notify({
        appId: 'screenrec',
        title: t('savedTitle'),
        body: p.split('/').pop(),
        onClick: () => shell.openFile(p),
        actions: [
          { label: t('open'), onClick: () => shell.openFile(p) },
          { label: t('showInFiles'), onClick: () => shell.launch('files', { path: p.slice(0, p.lastIndexOf('/')), select: p }) },
        ],
      });
    } catch (err) {
      console.warn('[screenrec] save failed', err);
      await api.invoke('screenrec:abort', file?.id).catch(() => {});
      this.showInfo('error', t('errSave', { msg: err?.message || String(err) }));
      this.wasShown = true;
    }
    this.state = 'idle';
    this.setBusy(false);
    if (this.wasShown) this.showWindow();
  }

  toggle() {
    if (this.state === 'idle') return this.start({ fromHotkey: true });
    return this.stop();
  }

  dispose() {
    clearInterval(this.tick);
    this.offLock?.();
    this.hideControl();
    this.ctx.shell.setStatusItem?.(TRAY_ID, null);
    this.rec?.dispose();
    if (this.file) this.ctx.api.invoke('screenrec:abort', this.file.id).catch(() => {});
  }
}

export default {
  async launch(ctx) {
    const app = new ScreenRecorder(ctx);
    ctx.win.el.__screenrec = { app };
    app.build();
    ctx.win.onBeforeClose(async () => {
      if (app.state === 'recording' || app.state === 'paused') await app.stop();
      app.dispose();
      return true;
    });
    if (ctx.args?.toggle) app.start({ fromHotkey: true });
    else app.showWindow();
    return {
      onRelaunch(args) {
        if (args?.toggle) return app.toggle();
        if (app.state === 'idle') app.showWindow();
      },
    };
  },
};
