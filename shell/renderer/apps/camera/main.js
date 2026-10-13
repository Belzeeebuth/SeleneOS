// Camera: live preview of a webcam (getUserMedia), photos (JPEG) and videos (WebM VP9 / Opus) saved to the Camera
// Roll: <XDG pictures>/Pellicule (French) or <XDG pictures>/Camera Roll (English; an existing folder in the other
// language is kept).
//   Photo / Video modes, one big shutter button; 3 / 10 s timer; mirrored preview (the files are never mirrored);
//   camera choice when there are several; resolution from what the camera reports (getCapabilities); rule-of-thirds
//   grid; the last capture opens in Photos (videos in their default app); a calm empty state with Try again when no
//   camera is found (it also starts by itself when a camera is plugged in).
//   While recording: a timer and a red dot on the preview, and a status button in the bar (shell.setStatusItem) to
//   stop it. Videos are streamed to disk by main/ipc/camera.js, which also writes their duration when they end.
// Keys: Space / Enter = shutter, Escape = cancel the timer.
// Settings (ctx.storage 'prefs'): mode, timer, mirror, grid, mic, deviceId, res { deviceId: 'WxH' }.
// Selene has no camera / microphone privacy setting yet: access is Chromium's (granted to the shell's own pages).

const PRESETS = [
  [640, 480],
  [1280, 720],
  [1920, 1080],
  [2560, 1440],
  [3840, 2160],
];
const ROLL_NAMES = ['Pellicule', 'Camera Roll'];
const pad = (n) => String(n).padStart(2, '0');
const stamp = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}`;
const clock = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  return h ? `${h}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}` : `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
};
const errText = (e) => String(e?.message || e || '').replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

export default {
  async launch(ctx) {
    const { win, h, icon, ui, t, api, shell } = ctx;
    const md = navigator.mediaDevices;
    const S = { mode: 'photo', timer: 0, mirror: true, grid: false, mic: true, deviceId: '', res: {} };
    Object.assign(S, (await ctx.storage.get('prefs', {}).catch(() => ({}))) || {});
    const save = () => ctx.storage.set('prefs', S).catch(() => {});

    let stream = null;
    let cams = [];
    let status = 'starting'; // starting | live | error
    let errKind = '';
    let rec = null; // { recorder, id, path, audio, start, q, error, thumb, stopping }
    let count = null; // { left, timer }
    let last = null; // { path, kind, thumb }
    let startSeq = 0;
    let closed = false;
    let noteTimer = 0;
    let tick = 0;

    // ---------------------------------------------------------------- DOM
    const video = h('video', { class: 'cam-video', muted: true, playsInline: true, autoplay: true });
    video.muted = true;
    const grid = h('div', { class: 'cam-grid', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'), h('i'));
    const countEl = h('div', { class: 'cam-count', 'aria-live': 'assertive' });
    const flashEl = h('div', { class: 'cam-flash' });
    const frame = h('div', { class: 'cam-frame' }, video, grid, flashEl, countEl);
    const recTime = h('span', { class: 'cam-rec-time' }, '00:00');
    const recBadge = h('div', { class: 'cam-rec', role: 'status' }, h('span', { class: 'cam-rec-dot' }), h('span', { class: 'cam-rec-label' }, t('recording')), recTime);
    const note = h('div', { class: 'cam-note', role: 'status', 'aria-live': 'polite' });
    const empty = h('div', { class: 'cam-empty' });
    const stage = h('div', { class: 'cam-stage' }, frame, recBadge, note, empty);

    const camSel = h('select', { class: 'select cam-select', 'aria-label': t('camera'), onchange: (e) => switchCamera(e.target.value) });
    const resSel = h('select', { class: 'select cam-res', 'aria-label': t('resolution'), onchange: (e) => switchRes(e.target.value) });
    const iconBtn = (name, label, onclick, cls = '') => h('button', { class: ['btn', 'subtle', 'cam-ib', cls], type: 'button', 'aria-label': label, 'data-tip': label, onclick }, icon(name, { size: 18 }));
    const timerLabel = h('span', { class: 'cam-timer-label' });
    const timerBtn = h('button', { class: 'btn subtle cam-ib cam-timer', type: 'button', onclick: cycleTimer }, icon('timer', { size: 18 }), timerLabel);
    const gridBtn = iconBtn('grid-four', t('grid'), () => setPref('grid', !S.grid), 'cam-grid-btn');
    const mirrorBtn = iconBtn('flip-horizontal', t('mirror'), () => {
      setPref('mirror', !S.mirror);
      if (S.mirror) showNote(t('mirrorHint'));
    }, 'cam-mirror-btn');
    const micBtn = iconBtn('microphone', t('micOn'), () => setPref('mic', !S.mic), 'cam-mic-btn');
    const folderBtn = iconBtn('folder-open', t('openFolder'), openFolder, 'cam-folder-btn');
    const bar = h(
      'div',
      { class: 'cam-bar' },
      h('div', { class: 'cam-bar-l' }, camSel, resSel),
      h('div', { class: 'cam-bar-r' }, timerBtn, gridBtn, mirrorBtn, micBtn, h('span', { class: 'cam-sep' }), folderBtn),
    );

    const thumbBtn = h('button', { class: 'cam-thumb', type: 'button', onclick: openLast });
    const shutterBtn = h('button', { class: 'cam-shutter', type: 'button', onclick: shutter }, h('span', { class: 'cam-shutter-in' }));
    const modeSeg = h(
      'div',
      { class: 'segmented cam-mode', role: 'radiogroup', 'aria-label': t('mode') },
      ['photo', 'video'].map((m) =>
        h('button', { type: 'button', role: 'radio', dataset: { mode: m }, onclick: () => setMode(m) }, icon(m === 'photo' ? 'camera' : 'video-camera', { size: 16 }), h('span', null, t(m === 'photo' ? 'modePhoto' : 'modeVideo'))),
      ),
    );
    const controls = h('div', { class: 'cam-controls' }, h('div', { class: 'cam-c-l' }, thumbBtn), h('div', { class: 'cam-c-m' }, shutterBtn), h('div', { class: 'cam-c-r' }, modeSeg));
    const root = h('div', { class: 'cam-root', tabIndex: -1 }, bar, stage, controls);
    win.body.appendChild(root);
    if (win.el) win.el.__camera = { S, get status() { return status; }, get errKind() { return errKind; }, get stream() { return stream; }, get cams() { return cams; }, get rec() { return rec; }, get last() { return last; }, get counting() { return !!count; } };

    // ---------------------------------------------------------------- layout: the frame fits the video in the stage
    function layout() {
      const vw = video.videoWidth || 16;
      const vh = video.videoHeight || 9;
      const sw = stage.clientWidth;
      const sh = stage.clientHeight;
      if (!sw || !sh) return;
      const k = Math.min(sw / vw, sh / vh);
      const w = Math.round(vw * k);
      const hh = Math.round(vh * k);
      Object.assign(frame.style, { width: `${w}px`, height: `${hh}px`, left: `${Math.round((sw - w) / 2)}px`, top: `${Math.round((sh - hh) / 2)}px` });
    }
    const ro = new ResizeObserver(layout);
    ro.observe(stage);
    video.addEventListener('loadedmetadata', layout);
    video.addEventListener('resize', layout);

    // ---------------------------------------------------------------- state -> DOM
    function paint() {
      root.dataset.status = status;
      root.dataset.mode = S.mode;
      root.classList.toggle('is-recording', !!rec);
      root.classList.toggle('is-counting', !!count);
      frame.classList.toggle('mirror', !!S.mirror);
      grid.hidden = !S.grid;
      gridBtn.classList.toggle('on', !!S.grid);
      gridBtn.setAttribute('aria-pressed', String(!!S.grid));
      mirrorBtn.classList.toggle('on', !!S.mirror);
      mirrorBtn.setAttribute('aria-pressed', String(!!S.mirror));
      const micLabel = S.mic ? t('micOn') : t('micOff');
      micBtn.replaceChildren(icon(S.mic ? 'microphone' : 'microphone-slash', { size: 18 }));
      micBtn.setAttribute('aria-label', micLabel);
      micBtn.dataset.tip = micLabel;
      micBtn.setAttribute('aria-pressed', String(!!S.mic));
      micBtn.hidden = S.mode !== 'video';
      micBtn.disabled = !!rec;
      const tv = S.timer ? t('timerS', { s: S.timer }) : t('timerOff');
      timerLabel.textContent = S.timer ? t('timerS', { s: S.timer }) : '';
      timerBtn.classList.toggle('on', !!S.timer);
      timerBtn.setAttribute('aria-label', t('timerTip', { value: tv }));
      timerBtn.dataset.tip = t('timerTip', { value: tv });
      const live = status === 'live';
      camSel.hidden = cams.length < 2;
      camSel.disabled = !!rec || !live;
      resSel.hidden = !live || resSel.options.length < 1;
      resSel.disabled = !!rec;
      for (const b of modeSeg.querySelectorAll('button')) {
        const on = b.dataset.mode === S.mode;
        b.classList.toggle('selected', on);
        b.setAttribute('aria-checked', String(on));
        b.disabled = !!rec || !!count;
      }
      const label = count ? t('cancelTimer') : rec ? t('stopRec') : S.mode === 'photo' ? t('takePhoto') : t('startRec');
      shutterBtn.setAttribute('aria-label', label);
      shutterBtn.dataset.tip = label;
      shutterBtn.disabled = !live;
      recBadge.hidden = !rec;
      paintThumb();
      paintEmpty();
    }
    function paintThumb() {
      thumbBtn.replaceChildren();
      thumbBtn.disabled = !last;
      thumbBtn.setAttribute('aria-label', last ? t('lastCapture') : t('noCapture'));
      thumbBtn.dataset.tip = last ? t('lastCapture') : t('noCapture');
      thumbBtn.classList.toggle('video', last?.kind === 'video');
      if (!last) return thumbBtn.append(icon('image', { size: 20 }));
      if (last.thumb) thumbBtn.append(h('img', { src: last.thumb, alt: '', draggable: false }));
      else if (last.kind === 'photo') thumbBtn.append(h('img', { src: `${api.mediaUrl(last.path)}?v=${Date.now()}`, alt: '', draggable: false }));
      else thumbBtn.append(h('video', { src: `${api.mediaUrl(last.path)}#t=0.1`, muted: true, preload: 'metadata' }));
      if (last.kind === 'video') thumbBtn.append(h('span', { class: 'cam-thumb-badge' }, icon('video-camera', { size: 12, filled: true })));
    }
    function paintEmpty() {
      empty.hidden = status === 'live';
      empty.replaceChildren();
      if (status === 'starting') {
        empty.append(h('div', { class: 'cam-empty-body' }, h('div', { class: 'cam-spinner', 'aria-hidden': 'true' }), h('div', { class: 'text-2' }, t('starting'))));
        return;
      }
      if (status !== 'error') return;
      const [title, help] = { none: ['noCamera', 'noCameraHelp'], denied: ['denied', 'deniedHelp'], busy: ['busy', 'busyHelp'] }[errKind] || ['failed', 'failedHelp'];
      empty.append(
        h(
          'div',
          { class: 'cam-empty-body', role: 'status' },
          h('div', { class: 'cam-empty-icon' }, icon(errKind === 'denied' ? 'lock-simple' : 'camera', { size: 40 })),
          h('div', { class: 'subtitle cam-empty-title' }, t(title)),
          h('div', { class: 'text-2 cam-empty-help' }, t(help)),
          h('button', { class: 'btn cam-retry', type: 'button', onclick: () => start() }, icon('arrow-clockwise', { size: 16 }), t('retry')),
        ),
      );
    }
    function showNote(text, ms = 3600) {
      note.textContent = text;
      note.classList.add('show');
      clearTimeout(noteTimer);
      noteTimer = setTimeout(() => note.classList.remove('show'), ms);
    }

    function setPref(k, v) {
      S[k] = v;
      save();
      paint();
    }
    function setMode(m) {
      if (rec || count || S.mode === m) return;
      setPref('mode', m);
    }
    function cycleTimer() {
      const order = [0, 3, 10];
      setPref('timer', order[(order.indexOf(Number(S.timer) || 0) + 1) % order.length]);
    }

    // ---------------------------------------------------------------- stream
    function stopStream() {
      for (const tr of stream?.getTracks() || []) {
        tr.onended = null;
        tr.stop();
      }
      stream = null;
      video.srcObject = null;
    }
    const kindOf = (e) => {
      const n = e?.name || '';
      if (/NotFound|DevicesNotFound|Overconstrained/.test(n)) return 'none';
      if (/NotAllowed|Security|PermissionDenied/.test(n)) return 'denied';
      if (/NotReadable|TrackStart|Abort/.test(n)) return 'busy';
      return 'failed';
    };
    async function listCams() {
      try {
        return (await md.enumerateDevices()).filter((d) => d.kind === 'videoinput');
      } catch {
        return [];
      }
    }
    async function start() {
      const my = ++startSeq;
      if (rec) return;
      stopStream();
      status = 'starting';
      errKind = '';
      paint();
      if (!md?.getUserMedia) return fail(my, { name: 'NotFoundError' });
      cams = await listCams();
      if (my !== startSeq || closed) return;
      if (!cams.length) return fail(my, { name: 'NotFoundError' });
      const known = cams.some((c) => c.deviceId && c.deviceId === S.deviceId);
      const want = (known && S.res[S.deviceId]) || '';
      const [w, hh] = want.split('x').map(Number);
      const v = {};
      if (known) v.deviceId = { exact: S.deviceId };
      if (w && hh) Object.assign(v, { width: { ideal: w }, height: { ideal: hh } });
      else Object.assign(v, { width: { ideal: 1280 }, height: { ideal: 720 } });
      let s = null;
      try {
        s = await md.getUserMedia({ video: v, audio: false });
      } catch (e) {
        // a camera that left, or a size it refuses: any camera, its default size
        if (known || w) {
          try {
            s = await md.getUserMedia({ video: true, audio: false });
          } catch (e2) {
            return fail(my, e2);
          }
        } else return fail(my, e);
      }
      if (my !== startSeq || closed) {
        for (const tr of s.getTracks()) tr.stop();
        return;
      }
      stream = s;
      const track = s.getVideoTracks()[0];
      S.deviceId = track?.getSettings?.().deviceId || S.deviceId;
      track.onended = () => {
        if (stream !== s) return;
        if (rec) stopRec();
        showNote(t('lost'));
        start();
      };
      cams = await listCams(); // labels are there once access is granted
      fillCams();
      fillRes(track);
      video.srcObject = s;
      try {
        await video.play();
      } catch {}
      status = 'live';
      paint();
      layout();
      const a = document.activeElement;
      if (a === root || a === document.body || !a) shutterBtn.focus({ preventScroll: true });
    }
    function fail(my, e) {
      if (my !== startSeq || closed) return;
      stopStream();
      status = 'error';
      errKind = kindOf(e);
      if (e?.message) console.warn('[camera]', e.name, e.message);
      paint();
    }
    function fillCams() {
      camSel.replaceChildren(...cams.map((c, i) => h('option', { value: c.deviceId, selected: c.deviceId === S.deviceId }, c.label || t('cameraN', { n: i + 1 }))));
    }
    function fillRes(track) {
      const caps = track?.getCapabilities?.() || {};
      const set = track?.getSettings?.() || {};
      const maxW = caps.width?.max || set.width || 1280;
      const maxH = caps.height?.max || set.height || 720;
      const list = PRESETS.filter(([w, hh]) => w <= maxW && hh <= maxH).map(([w, hh]) => `${w}x${hh}`);
      const cur = set.width && set.height ? `${set.width}x${set.height}` : '';
      if (cur && !list.includes(cur)) list.push(cur);
      list.sort((a, b) => Number(a.split('x')[0]) * Number(a.split('x')[1]) - Number(b.split('x')[0]) * Number(b.split('x')[1]));
      const name = (r) => {
        const [w, hh] = r.split('x').map(Number);
        const tag = { 480: '480p', 720: '720p', 1080: '1080p', 1440: '1440p', 2160: '4K' }[hh];
        return `${w} × ${hh}${tag ? ` (${tag})` : ''}`;
      };
      resSel.replaceChildren(...list.map((r) => h('option', { value: r, selected: r === cur }, name(r))));
    }
    function switchCamera(id) {
      if (rec || id === S.deviceId) return;
      S.deviceId = id;
      save();
      start();
    }
    function switchRes(r) {
      if (rec || !S.deviceId) return;
      S.res = { ...S.res, [S.deviceId]: r };
      save();
      start();
    }
    const onDeviceChange = () => {
      clearTimeout(onDeviceChange.t);
      onDeviceChange.t = setTimeout(async () => {
        if (closed) return;
        if (status !== 'live') return start();
        cams = await listCams();
        fillCams();
        paint();
      }, 400);
    };
    md?.addEventListener?.('devicechange', onDeviceChange);

    // ---------------------------------------------------------------- saving
    async function rollDir() {
      const x = shell.xdg || (await api.invoke('fs:xdg').catch(() => null));
      const pics = String(x?.pictures || `${ctx.env?.home || ''}/Pictures`).replace(/\/$/, '');
      const mine = t('folderName');
      if (!(await api.invoke('fs:exists', `${pics}/${mine}`).catch(() => false))) {
        for (const other of ROLL_NAMES.filter((n) => n !== mine)) if (await api.invoke('fs:exists', `${pics}/${other}`).catch(() => false)) return `${pics}/${other}`;
      }
      return `${pics}/${mine}`;
    }
    function frameCanvas(maxH = 0) {
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (!vw || !vh) return null;
      const k = maxH ? Math.min(1, maxH / vh) : 1;
      const c = document.createElement('canvas');
      c.width = Math.round(vw * k);
      c.height = Math.round(vh * k);
      c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
      return c;
    }
    const thumbOf = () => frameCanvas(120)?.toDataURL('image/jpeg', 0.8) || null;

    async function takePhoto() {
      const c = frameCanvas();
      if (!c) return;
      flashEl.classList.remove('go');
      void flashEl.offsetWidth;
      flashEl.classList.add('go');
      shell.sounds?.play?.('screenshot');
      const thumb = thumbOf();
      try {
        const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.92));
        const dir = await rollDir();
        await api.invoke('fs:mkdir', dir);
        const name = await api.invoke('fs:uniqueName', dir, `${t('photoBase')} ${stamp()}.jpg`);
        const path = `${dir}/${name}`;
        await api.invoke('fs:writeBytes', path, new Uint8Array(await blob.arrayBuffer()));
        last = { path, kind: 'photo', thumb };
        paint();
      } catch (e) {
        showNote(t('saveFailed', { error: errText(e) }), 6000);
      }
    }

    const MIMES = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
    const MIMES_NOAUDIO = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    async function startRec() {
      if (rec || !stream) return;
      let audio = null;
      if (S.mic) {
        try {
          audio = await md.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
        } catch {
          showNote(t('micMissing'), 5000);
        }
      }
      if (closed || !stream) return audio?.getTracks().forEach((tr) => tr.stop());
      const mix = new MediaStream([...stream.getVideoTracks(), ...(audio?.getAudioTracks() || [])]);
      const mime = (audio ? MIMES : MIMES_NOAUDIO).find((m) => window.MediaRecorder?.isTypeSupported?.(m)) || '';
      const hh = video.videoHeight || 720;
      let r;
      try {
        const dir = await rollDir();
        await api.invoke('fs:mkdir', dir);
        const name = await api.invoke('fs:uniqueName', dir, `${t('videoBase')} ${stamp()}.webm`);
        const { id, path } = await api.invoke('camera:begin', `${dir}/${name}`);
        const recorder = new MediaRecorder(mix, { mimeType: mime || undefined, videoBitsPerSecond: hh >= 1440 ? 16e6 : hh >= 1080 ? 8e6 : hh >= 720 ? 5e6 : 2.5e6, audioBitsPerSecond: 128000 });
        r = { recorder, id, path, audio, start: 0, q: Promise.resolve(), error: null, thumb: thumbOf(), stopping: false };
      } catch (e) {
        audio?.getTracks().forEach((tr) => tr.stop());
        return showNote(t('saveFailed', { error: errText(e) }), 6000);
      }
      r.recorder.ondataavailable = (e) => {
        if (!e.data?.size) return;
        const blob = e.data;
        r.q = r.q.then(async () => {
          if (r.error) return;
          try {
            await api.invoke('camera:append', r.id, new Uint8Array(await blob.arrayBuffer()));
          } catch (err) {
            r.error = err;
            if (rec === r) stopRec();
          }
        });
      };
      r.recorder.onerror = (e) => {
        r.error = e?.error || new Error('MediaRecorder');
        if (rec === r) stopRec();
      };
      rec = r;
      r.recorder.start(1000);
      r.start = performance.now();
      shell.sounds?.play?.('click');
      clearInterval(tick);
      tick = setInterval(paintRec, 500);
      paintRec();
      paint();
    }
    function paintRec() {
      if (!rec) return;
      const time = clock(performance.now() - rec.start);
      recTime.textContent = time;
      shell.setStatusItem?.('camera-rec', {
        icon: 'record-fill',
        text: time,
        tip: t('trayRec', { time }),
        onClick: (e) =>
          ui.menu(e.currentTarget, [
            { label: t('trayStop'), icon: 'stop', action: () => stopRec() },
            { label: t('trayShow'), icon: 'app-window', action: () => win.focus() },
          ]),
      });
    }
    async function stopRec() {
      const r = rec;
      if (!r || r.stopping) return;
      r.stopping = true;
      clearInterval(tick);
      shell.setStatusItem?.('camera-rec', null);
      const duration = performance.now() - r.start;
      if (r.recorder.state !== 'inactive') {
        const done = new Promise((res) => r.recorder.addEventListener('stop', res, { once: true }));
        try {
          r.recorder.stop();
        } catch {}
        await Promise.race([done, new Promise((res) => setTimeout(res, 3000))]);
      }
      await r.q;
      r.audio?.getTracks().forEach((tr) => tr.stop());
      rec = null;
      paint();
      if (r.error) {
        await api.invoke('camera:abort', r.id).catch(() => {});
        showNote(t('recFailed', { error: errText(r.error) }), 6000);
        return;
      }
      try {
        const res = await api.invoke('camera:finish', r.id, duration);
        last = { path: res.path, kind: 'video', thumb: r.thumb };
        if (!closed) paint();
        showNote(t('savedVideo'), 2600);
      } catch (e) {
        showNote(t('saveFailed', { error: errText(e) }), 6000);
      }
    }

    // ---------------------------------------------------------------- shutter, timer
    function cancelCount() {
      if (!count) return;
      clearInterval(count.timer);
      count = null;
      countEl.textContent = '';
      paint();
    }
    function shutter() {
      if (status !== 'live') return;
      if (count) return cancelCount();
      if (rec) return stopRec();
      const act = S.mode === 'video' ? startRec : takePhoto;
      const secs = Number(S.timer) || 0;
      if (!secs) return act();
      count = { left: secs, timer: 0 };
      countEl.textContent = String(secs);
      count.timer = setInterval(() => {
        if (!count) return;
        count.left -= 1;
        if (count.left <= 0) {
          cancelCount();
          act();
        } else countEl.textContent = String(count.left);
      }, 1000);
      paint();
    }
    root.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && count) {
        e.preventDefault();
        e.stopPropagation();
        return cancelCount();
      }
      if ((e.key === ' ' || e.key === 'Enter') && !e.ctrlKey && !e.altKey && !e.metaKey) {
        if (e.target.closest?.('button, select, input, a, [role="radio"]')) return;
        e.preventDefault();
        shutter();
      }
    });

    // ---------------------------------------------------------------- last capture, folder
    async function findLast() {
      try {
        const dir = await rollDir();
        const list = (await api.invoke('fs:list', dir)) || [];
        const pick = list.filter((e) => !e.dir && /\.(jpe?g|png|webm)$/i.test(e.name)).sort((a, b) => (b.mtime || 0) - (a.mtime || 0))[0];
        if (pick && !last) {
          last = { path: pick.path || `${dir}/${pick.name}`, kind: /\.webm$/i.test(pick.name) ? 'video' : 'photo', thumb: null };
          paint();
        }
      } catch {}
    }
    async function openLast() {
      if (!last) return;
      if (!(await api.invoke('fs:exists', last.path).catch(() => false))) {
        last = null;
        paint();
        return findLast();
      }
      if (last.kind === 'photo') shell.openFile(last.path, { appId: 'photos' });
      else shell.openFile(last.path);
    }
    async function openFolder() {
      const dir = await rollDir();
      await api.invoke('fs:mkdir', dir).catch(() => {});
      shell.openFile(dir);
    }

    // ---------------------------------------------------------------- lifecycle
    win.onBeforeClose(async () => {
      if (rec) await stopRec();
      return true;
    });
    ctx.onClose(() => {
      closed = true;
      startSeq++;
      cancelCount();
      clearInterval(tick);
      clearTimeout(noteTimer);
      shell.setStatusItem?.('camera-rec', null);
      if (rec) {
        // closed without onBeforeClose (forced): keep what was recorded so far
        const r = rec;
        rec = null;
        try {
          r.recorder.stop();
        } catch {}
        r.audio?.getTracks().forEach((tr) => tr.stop());
        r.q.then(() => api.invoke('camera:finish', r.id, performance.now() - r.start)).catch(() => {});
      }
      md?.removeEventListener?.('devicechange', onDeviceChange);
      ro.disconnect();
      stopStream();
    });

    paint();
    findLast();
    start();
    requestAnimationFrame(() => root.focus({ preventScroll: true }));
    return {
      onRelaunch() {
        win.focus();
      },
    };
  },
};
