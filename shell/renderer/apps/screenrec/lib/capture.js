// Screen recording pipeline and the shell overlays around it (they live in #overlays, outside the app window, and
// carry the .app-screenrec class so style.css stays scoped).
//
//   pickRegion({ h, t })                       -> Promise<rect | 'full' | null>   drag a rectangle (CSS px); Enter = whole
//                                                 screen, Esc = cancel
//   countdown({ h, t, rect, seconds })         -> Promise<boolean>   3-2-1 over the area; false when cancelled (Esc)
//   const rec = new Recording({ api, rect, mic, system, onChunk, onEnded })
//     await rec.open()     the screen (desktopCapturer screen source -> getUserMedia 'desktop'), microphone and
//                          computer sound (desktop loopback, through PulseAudio / PipeWire when Chromium can reach it)
//                          -> { warnings: ['mic' | 'system'] }; throws { code: 'ENOSCREEN' } without a screen
//     await rec.start(controlEl)   takes a clean picture of the area, then records. The floating control is never in
//                          the video: the canvas copies the area frame by frame, and the control's rectangle is painted
//                          from that clean picture.
//     rec.pause() / rec.resume() / rec.elapsed() (ms, pauses excluded) / await rec.stop() / rec.dispose()
//   controlPlace(rect, size)                   -> { left, top } of the floating control: outside the area when it fits
//                                                 (below, then above), else at the top centre inside it.
// rect: { x, y, width, height } in CSS px of the shell page (the shell covers the screen).

const overlayRoot = () => document.getElementById('overlays') || document.body;
const MIN = 48;

export function pickRegion({ h, t }) {
  return new Promise((resolve) => {
    const box = h('div', { class: 'sr-region-box', hidden: true }, h('span', { class: 'sr-region-size' }));
    const hint = h('div', { class: 'sr-region-hint', role: 'status' }, t('regionHint'));
    const ov = h('div', { class: 'app-screenrec sr-region', tabindex: '-1' }, hint, box);
    let start = null;
    let rect = null;
    const finish = (v) => {
      ov.remove();
      document.removeEventListener('keydown', onKey, true);
      resolve(v);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') finish(null);
      else if (e.key === 'Enter') finish('full');
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    const paint = () => {
      box.hidden = !rect;
      ov.classList.toggle('drawing', !!rect);
      if (!rect) return;
      Object.assign(box.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` });
      const s = window.devicePixelRatio || 1;
      box.firstChild.textContent = `${Math.round(rect.width * s)} × ${Math.round(rect.height * s)}`;
    };
    ov.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      ov.setPointerCapture?.(e.pointerId);
      start = [e.clientX, e.clientY];
      rect = null;
      paint();
    });
    ov.addEventListener('pointermove', (e) => {
      if (!start) return;
      const x = Math.max(0, Math.min(start[0], e.clientX));
      const y = Math.max(0, Math.min(start[1], e.clientY));
      const x2 = Math.min(window.innerWidth, Math.max(start[0], e.clientX));
      const y2 = Math.min(window.innerHeight, Math.max(start[1], e.clientY));
      rect = { x, y, width: x2 - x, height: y2 - y };
      paint();
    });
    ov.addEventListener('pointerup', () => {
      if (!start) return;
      start = null;
      if (rect && rect.width >= MIN && rect.height >= MIN) finish({ ...rect });
      else {
        rect = null;
        paint();
      }
    });
    ov.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      finish(null);
    });
    document.addEventListener('keydown', onKey, true);
    overlayRoot().appendChild(ov);
    ov.focus();
  });
}

export function countdown({ h, t, rect, seconds = 3 }) {
  return new Promise((resolve) => {
    const num = h('span', { class: 'sr-count-num' });
    const ov = h('div', { class: 'app-screenrec sr-countdown', role: 'status', 'aria-live': 'assertive' }, h('div', { class: 'sr-count-disc' }, num));
    Object.assign(ov.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    let n = seconds;
    let timer = 0;
    const finish = (v) => {
      clearTimeout(timer);
      document.removeEventListener('keydown', onKey, true);
      ov.remove();
      resolve(v);
    };
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      finish(false);
    };
    const tick = () => {
      if (n <= 0) return finish(true);
      num.textContent = String(n);
      ov.setAttribute('aria-label', t('countdown', { n }));
      num.classList.remove('pop');
      void num.offsetWidth;
      num.classList.add('pop');
      n--;
      timer = setTimeout(tick, 1000);
    };
    document.addEventListener('keydown', onKey, true);
    overlayRoot().appendChild(ov);
    tick();
  });
}

/** Where the floating control goes for an area (CSS px), given its size. */
export function controlPlace(rect, { width, height }, gap = 12) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const left = Math.round(Math.max(8, Math.min(vw - width - 8, rect.x + rect.width / 2 - width / 2)));
  const full = rect.width >= vw - 4 && rect.height >= vh - 4;
  if (!full) {
    if (rect.y + rect.height + gap + height <= vh - 8) return { left, top: Math.round(rect.y + rect.height + gap), inside: false };
    if (rect.y - gap - height >= 8) return { left, top: Math.round(rect.y - gap - height), inside: false };
  }
  return { left, top: Math.round(rect.y + gap), inside: true };
}

const nextVideoFrame = (video) =>
  new Promise((r) => {
    const t = setTimeout(r, 120);
    video.requestVideoFrameCallback?.(() => {
      clearTimeout(t);
      r();
    });
  });

function pickMime() {
  const list = ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8', 'video/webm'];
  return list.find((m) => window.MediaRecorder?.isTypeSupported?.(m)) || '';
}

export class Recording {
  constructor({ api, rect, mic = false, system = false, onChunk, onEnded }) {
    Object.assign(this, { api, rect, wantMic: mic, wantSystem: system, onChunk, onEnded });
    this.streams = [];
    this.state = 'idle'; // idle | ready | recording | paused | stopped
    this.acc = 0;
    this.since = 0;
    this.patch = null; // { x, y, width, height } in canvas px, painted from the clean picture
  }

  async open() {
    const warnings = [];
    const src = await this.api.invoke('screenrec:source').catch(() => null);
    if (!src) throw Object.assign(new Error('no screen'), { code: 'ENOSCREEN' });
    this.geo = src;
    const dpr = window.devicePixelRatio || 1;
    const zoom = src.zoom || 1;
    // the screen at its own resolution (min = max: Chromium would otherwise scale the capture down under load)
    const sw = Math.round((src.display?.width || window.screen.width) * (dpr / zoom));
    const sh = Math.round((src.display?.height || window.screen.height) * (dpr / zoom));
    const video = {
      mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: src.id, minWidth: sw, maxWidth: sw, minHeight: sh, maxHeight: sh, maxFrameRate: 30 },
    };
    let screen = null;
    let systemTrack = null;
    if (this.wantSystem) {
      // computer sound: Chromium's desktop audio loopback (PulseAudio / PipeWire monitor); needs the video in the same call
      try {
        screen = await navigator.mediaDevices.getUserMedia({ audio: { mandatory: { chromeMediaSource: 'desktop' } }, video });
        systemTrack = screen.getAudioTracks().find((x) => x.readyState === 'live') || null;
      } catch (err) {
        console.warn('[screenrec] computer sound not available', err?.name || err);
      }
      if (!systemTrack) warnings.push('system');
    }
    if (!screen) {
      try {
        screen = await navigator.mediaDevices.getUserMedia({ audio: false, video });
      } catch (err) {
        throw Object.assign(new Error(err?.message || 'no screen'), { code: 'ENOSCREEN' });
      }
    }
    this.streams.push(screen);
    let micStream = null;
    if (this.wantMic) {
      try {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true }, video: false });
        this.streams.push(micStream);
      } catch (err) {
        console.warn('[screenrec] microphone not available', err?.name || err);
        warnings.push('mic');
      }
    }
    // the screen in a <video>, copied (cropped) to a canvas frame by frame
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.srcObject = new MediaStream(screen.getVideoTracks());
    await v.play().catch(() => {});
    for (let i = 0; i < 50 && !v.videoWidth; i++) await new Promise((r) => setTimeout(r, 40));
    if (!v.videoWidth) throw Object.assign(new Error('no frames'), { code: 'ENOSCREEN' });
    this.video = v;
    screen.getVideoTracks()[0]?.addEventListener('ended', () => this.onEnded?.());
    // CSS px of the shell -> pixels of the screen picture (the output size is fixed now; the source part is measured
    // again at each frame, in case the capture changes resolution)
    const crop = this.measure();
    crop.width &= ~1;
    crop.height &= ~1;
    this.crop = crop;
    this.canvas = Object.assign(document.createElement('canvas'), { width: crop.width, height: crop.height });
    this.ctx2d = this.canvas.getContext('2d', { alpha: false, willReadFrequently: true }); // a CPU canvas: X11 capture frames are in memory, and captureStream needs no GPU readback
    this.clean = Object.assign(document.createElement('canvas'), { width: crop.width, height: crop.height });
    // one audio track: microphone and computer sound mixed
    const sources = [systemTrack && new MediaStream([systemTrack]), micStream].filter(Boolean);
    if (sources.length) {
      this.audioCtx = new AudioContext();
      const dest = this.audioCtx.createMediaStreamDestination();
      for (const s of sources) this.audioCtx.createMediaStreamSource(s).connect(dest);
      this.audioTrack = dest.stream.getAudioTracks()[0] || null;
    }
    this.hasAudio = !!this.audioTrack;
    this.state = 'ready';
    return { warnings };
  }

  /** The area in pixels of the screen picture as it is now: { x, y, width, height, sx, sy, ox, oy }. */
  measure() {
    // CSS px -> DIP on the screen: content origin + px × page zoom; DIP -> capture px: video size / display size
    const v = this.video;
    const g = this.geo || {};
    const disp = g.display || { x: 0, y: 0, width: window.screen.width, height: window.screen.height };
    const cont = g.content || { x: disp.x + (window.screenX || 0), y: disp.y + (window.screenY || 0) };
    const zoom = g.zoom || 1;
    const kx = v.videoWidth / disp.width;
    const ky = v.videoHeight / disp.height;
    const r = this.rect;
    const x = Math.max(0, Math.round((cont.x - disp.x + r.x * zoom) * kx));
    const y = Math.max(0, Math.round((cont.y - disp.y + r.y * zoom) * ky));
    const width = Math.max(2, Math.min(v.videoWidth - x, Math.round(r.width * zoom * kx)));
    const height = Math.max(2, Math.min(v.videoHeight - y, Math.round(r.height * zoom * ky)));
    return { x, y, width, height };
  }

  draw() {
    this.frames = (this.frames || 0) + 1;
    const { ctx2d, video, crop, patch } = this;
    const src = video.videoWidth === this.srcW && video.videoHeight === this.srcH ? this.src : this.remeasure();
    ctx2d.drawImage(video, src.x, src.y, src.width, src.height, 0, 0, crop.width, crop.height);
    if (patch) ctx2d.drawImage(this.clean, patch.x, patch.y, patch.width, patch.height, patch.x, patch.y, patch.width, patch.height);
  }

  remeasure() {
    this.srcW = this.video.videoWidth;
    this.srcH = this.video.videoHeight;
    this.src = this.measure();
    return this.src;
  }

  // A frame each display refresh, at most ~30 per second (requestVideoFrameCallback is not reliable for a <video> that
  // is not in the page).
  loop() {
    if (this.state === 'stopped' || !this.video) return;
    const now = performance.now();
    if (!this.lastDraw || now - this.lastDraw >= 30) {
      this.lastDraw = now;
      this.draw();
    }
    requestAnimationFrame(() => this.loop());
  }

  /** The control's screen rectangle (CSS px) -> the part of the canvas painted from the clean picture. */
  setControlRect(cr) {
    if (!cr || !this.crop) return (this.patch = null);
    // CSS px -> output canvas px (the canvas holds this.rect at the crop size)
    const kx = this.crop.width / this.rect.width;
    const ky = this.crop.height / this.rect.height;
    const m = 8; // the control's shadow
    const x0 = Math.floor((cr.left - m - this.rect.x) * kx);
    const y0 = Math.floor((cr.top - m - this.rect.y) * ky);
    const x1 = Math.ceil((cr.right + m - this.rect.x) * kx);
    const y1 = Math.ceil((cr.bottom + m - this.rect.y) * ky);
    const x = Math.max(0, x0);
    const y = Math.max(0, y0);
    const w = Math.min(this.crop.width, x1) - x;
    const h = Math.min(this.crop.height, y1) - y;
    this.patch = w > 0 && h > 0 ? { x, y, width: w, height: h } : null;
    return this.patch;
  }

  /** Records from now on. showControl() puts the control on screen once the clean picture is taken. */
  async start(showControl) {
    const v = this.video;
    // the countdown has just left the screen: let the capture catch up, then keep a clean picture of the area
    await nextVideoFrame(v);
    await new Promise((r) => setTimeout(r, 120));
    await nextVideoFrame(v);
    const src = this.remeasure();
    this.clean.getContext('2d').drawImage(v, src.x, src.y, src.width, src.height, 0, 0, this.crop.width, this.crop.height);
    const cr = showControl?.();
    if (cr) this.setControlRect(cr);
    this.draw();
    const stream = this.canvas.captureStream(30);
    const tracks = [...stream.getVideoTracks(), ...(this.audioTrack ? [this.audioTrack] : [])];
    const px = this.crop.width * this.crop.height;
    const mimeType = pickMime();
    this.mime = mimeType || 'video/webm';
    this.recorder = new MediaRecorder(new MediaStream(tracks), {
      ...(mimeType ? { mimeType } : {}),
      videoBitsPerSecond: Math.round(Math.max(2.5e6, Math.min(12e6, px * 3))),
      audioBitsPerSecond: 160000,
    });
    this.recorder.ondataavailable = (e) => {
      if (e.data && e.data.size) this.onChunk?.(e.data);
    };
    this.stopped = new Promise((r) => (this.recorder.onstop = () => r()));
    this.state = 'recording';
    this.since = performance.now();
    this.recorder.start(1000);
    this.loop();
  }

  pause() {
    if (this.state !== 'recording') return;
    this.recorder.pause();
    this.acc += performance.now() - this.since;
    this.state = 'paused';
  }

  resume() {
    if (this.state !== 'paused') return;
    this.recorder.resume();
    this.since = performance.now();
    this.state = 'recording';
  }

  elapsed() {
    return this.acc + (this.state === 'recording' ? performance.now() - this.since : 0);
  }

  async stop() {
    if (this.state !== 'recording' && this.state !== 'paused') return this.dispose();
    this.duration = this.elapsed();
    if (this.recorder.state !== 'inactive') this.recorder.stop();
    await Promise.race([this.stopped, new Promise((r) => setTimeout(r, 4000))]);
    this.dispose();
  }

  dispose() {
    this.state = 'stopped';
    for (const s of this.streams) for (const tr of s.getTracks()) tr.stop();
    this.audioTrack?.stop();
    this.audioCtx?.close().catch(() => {});
    if (this.video) this.video.srcObject = null;
  }
}

export function fmtTime(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return hh ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
}
