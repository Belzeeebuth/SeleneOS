'use strict';
// Video Editor backend (apps/videoeditor): media probing and MP4 export with ffmpeg.
//   videoeditor:tools()                    -> { ffmpeg: bool, ffprobe: bool }
//   videoeditor:probe(path)                -> { kind: 'video'|'image'|'audio', duration, width, height, audio }
//   videoeditor:export(project, { out, height: 720|1080 }) -> { id, duration }
//        (+videoeditor:progress { id, percent, time, state: 'running'|'done'|'error'|'canceled', out, error })
//   videoeditor:cancel(id)                 -> true
// The project (apps/videoeditor/lib/model.js) is validated here before anything runs: absolute existing files,
// finite numbers in range, #rrggbb colours, short texts. ffmpeg gets an argv array (never a shell); inputs use the
// file: protocol; texts go through temporary text files (drawtext textfile=, expansion=none), so no user text is
// ever parsed as filtergraph syntax. Progress comes from -progress pipe:1, cancel kills the process and removes the
// partial file. Pure helpers (validateProject, buildArgs, parseProgress, totalDuration) are exported for the unit test.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');

const KINDS = new Set(['video', 'image', 'audio']);
const POS = new Set(['top', 'center', 'bottom']);
const HEIGHTS = { 720: [1280, 720], 1080: [1920, 1080] };
const FPS = 30;
const MAX_CLIPS = 300;
const FONTS = ['/usr/share/fonts/opentype/inter/Inter-Bold.otf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'];
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif']);
const AUDIO_EXT = new Set(['.mp3', '.wav', '.ogg', '.oga', '.opus', '.flac', '.m4a', '.aac']);

const err = (message, code = 'EINVAL') => Object.assign(new Error(message), { code });
const num = (v, min, max, name) => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw err(`invalid ${name}`);
  return v;
};
const color = (v, name) => {
  if (typeof v !== 'string' || !/^#[0-9a-f]{6}$/i.test(v)) throw err(`invalid ${name}`);
  return v.toLowerCase();
};
const str = (v, max, name) => {
  if (typeof v !== 'string' || v.length > max || v.includes('\0')) throw err(`invalid ${name}`);
  return v;
};
const absPath = (p, name) => {
  str(p, 4096, name);
  if (!path.isAbsolute(p) || path.normalize(p) !== p) throw err(`invalid ${name}`);
  return p;
};

function validateText(t, where) {
  if (t == null) return null;
  if (typeof t !== 'object') throw err(`invalid ${where}.text`);
  const value = str(t.value ?? '', 300, `${where}.text.value`);
  if (!value.trim()) return null;
  return { value, size: num(t.size ?? 48, 10, 200, `${where}.text.size`), pos: POS.has(t.pos) ? t.pos : 'center', color: color(t.color ?? '#ffffff', `${where}.text.color`) };
}

/** A normalized copy of a project, or throws EINVAL. `exists(path)` checks media files (default fs.existsSync). */
function validateProject(p, { exists = (f) => fs.existsSync(f) } = {}) {
  if (!p || typeof p !== 'object') throw err('invalid project');
  if (!Array.isArray(p.media) || !Array.isArray(p.video) || !Array.isArray(p.music || [])) throw err('invalid project');
  if (p.video.length + (p.music || []).length > MAX_CLIPS || p.media.length > MAX_CLIPS) throw err('too many clips');
  const media = new Map();
  for (const m of p.media) {
    if (!m || typeof m !== 'object' || typeof m.id !== 'string' || !KINDS.has(m.kind)) throw err('invalid media');
    const file = absPath(m.path, 'media path');
    media.set(m.id, { id: m.id, path: file, kind: m.kind, duration: m.kind === 'image' ? 0 : num(m.duration, 0, 86400, 'media duration'), audio: !!m.audio, used: false });
  }
  const need = (id, kinds) => {
    const m = media.get(id);
    if (!m || !kinds.includes(m.kind)) throw err('unknown media');
    if (!m.used && !exists(m.path)) throw err(`missing file ${m.path}`, 'ENOENT');
    m.used = true;
    return m;
  };
  const video = p.video.map((c, i) => {
    if (!c || typeof c !== 'object') throw err('invalid clip');
    const where = `clip ${i + 1}`;
    const base = { fade: num(c.fade ?? 0, 0, 3, `${where} fade`), text: validateText(c.text, where) };
    if (c.type === 'title') return { type: 'title', duration: num(c.duration, 0.2, 600, `${where} duration`), bg: color(c.bg ?? '#000000', `${where} bg`), ...base };
    if (c.type !== 'media') throw err(`invalid ${where}`);
    const m = need(c.mediaId, ['video', 'image']);
    if (m.kind === 'image') return { type: 'image', path: m.path, duration: num(c.out - c.in, 0.2, 600, `${where} duration`), ...base };
    const inn = num(c.in, 0, 86400, `${where} in`);
    const out = num(c.out, inn + 0.05, 86400, `${where} out`);
    if (m.duration && out > m.duration + 0.05) throw err(`invalid ${where} out`);
    return { type: 'video', path: m.path, in: inn, out, duration: out - inn, audio: m.audio, volume: num(c.volume ?? 1, 0, 2, `${where} volume`), ...base };
  });
  const music = (p.music || []).map((c, i) => {
    const where = `music ${i + 1}`;
    if (!c || typeof c !== 'object') throw err(`invalid ${where}`);
    const m = need(c.mediaId, ['audio', 'video']);
    const inn = num(c.in, 0, 86400, `${where} in`);
    const out = num(c.out, inn + 0.05, 86400, `${where} out`);
    const d = out - inn;
    return { path: m.path, in: inn, out, duration: d, volume: num(c.volume ?? 1, 0, 2, `${where} volume`), fadeIn: num(c.fadeIn ?? 0, 0, Math.min(10, d), `${where} fade in`), fadeOut: num(c.fadeOut ?? 0, 0, Math.min(10, d), `${where} fade out`) };
  });
  if (!video.length) throw err('the timeline is empty', 'EEMPTY');
  return { video, music };
}

const totalDuration = (v) => v.video.reduce((s, c) => s + c.duration, 0);
const r3 = (n) => String(Math.round(n * 1000) / 1000);
const hex = (c) => `0x${c.slice(1)}`;
/** A path that may sit inside a filtergraph option without escaping (we only build such paths ourselves). */
const safeGraphPath = (p) => {
  if (!/^[A-Za-z0-9_./-]+$/.test(p)) throw err('unsafe path for the filtergraph', 'EUNSAFE');
  return p;
};

/**
 * ffmpeg argv for a validated project (validateProject's result).
 *   opts: { out, height: 720|1080, font, tmpDir }
 *   -> { args, duration, textFiles: [{ path, text }] }   (write textFiles before spawning)
 */
function buildArgs(v, { out, height = 1080, font = FONTS[0], tmpDir = '/tmp/selene-videoeditor' } = {}) {
  const [W, H] = HEIGHTS[height] || HEIGHTS[1080];
  absPath(out, 'output');
  if (!/\.mp4$/i.test(out)) throw err('output must be .mp4');
  const args = ['-hide_banner', '-nostdin', '-y'];
  const graph = [];
  const textFiles = [];
  let n = 0; // input index
  const duration = totalDuration(v);
  const segs = [];
  v.video.forEach((c, k) => {
    const prev = v.video[k - 1];
    const fadeIn = prev?.fade ? prev.fade / 2 : 0;
    const fadeOut = c.fade ? (k === v.video.length - 1 ? c.fade : c.fade / 2) : 0;
    const D = c.duration;
    let src;
    if (c.type === 'title') src = `color=c=${hex(c.bg)}:s=${W}x${H}:r=${FPS}:d=${r3(D)}`;
    else if (c.type === 'image') {
      args.push('-loop', '1', '-framerate', String(FPS), '-t', r3(D), '-i', `file:${c.path}`);
      src = `[${n++}:v]trim=duration=${r3(D)},setpts=PTS-STARTPTS`;
    } else {
      args.push('-i', `file:${c.path}`);
      src = `[${n}:v]trim=start=${r3(c.in)}:end=${r3(c.out)},setpts=PTS-STARTPTS`;
      c._input = n++;
    }
    let f = `${src},scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${FPS},format=yuv420p`;
    if (c.text) {
      const tf = safeGraphPath(path.join(tmpDir, `text${k}.txt`));
      textFiles.push({ path: tf, text: c.text.value });
      const size = Math.round((c.text.size * H) / 720);
      const y = c.text.pos === 'top' ? `h*0.08` : c.text.pos === 'bottom' ? `h*0.92-text_h` : `(h-text_h)/2`;
      f += `,drawtext=fontfile=${safeGraphPath(font)}:textfile=${tf}:expansion=none:fontsize=${size}:fontcolor=${hex(c.text.color)}:shadowcolor=black@0.45:shadowx=${Math.max(1, Math.round(H / 360))}:shadowy=${Math.max(1, Math.round(H / 360))}:line_spacing=${Math.round(size / 5)}:x=(w-text_w)/2:y=${y}`;
    }
    if (fadeIn) f += `,fade=t=in:st=0:d=${r3(fadeIn)}`;
    if (fadeOut) f += `,fade=t=out:st=${r3(Math.max(0, D - fadeOut))}:d=${r3(fadeOut)}`;
    graph.push(`${f}[v${k}]`);
    let a;
    if (c.type === 'video' && c.audio) {
      a = `[${c._input}:a]atrim=start=${r3(c.in)}:end=${r3(c.out)},asetpts=PTS-STARTPTS,aformat=sample_rates=48000:channel_layouts=stereo,volume=${r3(c.volume)}`;
      a += `,apad,atrim=duration=${r3(D)}`;
      if (fadeIn) a += `,afade=t=in:st=0:d=${r3(fadeIn)}`;
      if (fadeOut) a += `,afade=t=out:st=${r3(Math.max(0, D - fadeOut))}:d=${r3(fadeOut)}`;
    } else a = `anullsrc=r=48000:cl=stereo,atrim=duration=${r3(D)},asetpts=PTS-STARTPTS`;
    graph.push(`${a}[a${k}]`);
    segs.push(`[v${k}][a${k}]`);
    delete c._input;
  });
  graph.push(`${segs.join('')}concat=n=${segs.length}:v=1:a=1[vout][vaud]`);
  let aout = '[vaud]';
  if (v.music.length) {
    const ms = [];
    v.music.forEach((m, j) => {
      args.push('-i', `file:${m.path}`);
      let a = `[${n++}:a]atrim=start=${r3(m.in)}:end=${r3(m.out)},asetpts=PTS-STARTPTS,aformat=sample_rates=48000:channel_layouts=stereo,volume=${r3(m.volume)}`;
      if (m.fadeIn) a += `,afade=t=in:st=0:d=${r3(m.fadeIn)}`;
      if (m.fadeOut) a += `,afade=t=out:st=${r3(Math.max(0, m.duration - m.fadeOut))}:d=${r3(m.fadeOut)}`;
      graph.push(`${a}[m${j}]`);
      ms.push(`[m${j}]`);
    });
    graph.push(ms.length > 1 ? `${ms.join('')}concat=n=${ms.length}:v=0:a=1[mus]` : `[m0]anull[mus]`);
    graph.push(`[vaud][mus]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]`);
    aout = '[aout]';
  }
  args.push('-filter_complex', graph.join(';'), '-map', '[vout]', '-map', aout);
  args.push('-c:v', 'libx264', '-preset', 'medium', '-crf', '21', '-pix_fmt', 'yuv420p', '-r', String(FPS));
  args.push('-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-t', r3(duration), '-movflags', '+faststart');
  args.push('-progress', 'pipe:1', '-nostats', '-loglevel', 'error', `file:${out}`);
  return { args, duration, textFiles };
}

/** Seconds done from a chunk of -progress output (last out_time_us / out_time_ms), or null; `end` when finished. */
function parseProgress(chunk) {
  let time = null;
  let end = false;
  for (const line of String(chunk).split(/\r?\n/)) {
    const m = /^out_time_(us|ms)=(\d+)$/.exec(line.trim());
    if (m) time = Number(m[2]) / 1e6; // ffmpeg's out_time_ms is in microseconds too
    if (line.trim() === 'progress=end') end = true;
  }
  return { time, end };
}

// ------------------------------------------------------------------ system side
const which = (bin) => ['/usr/bin', '/usr/local/bin', '/bin'].map((d) => path.join(d, bin)).find((p) => fs.existsSync(p)) || null;

function probe(file) {
  return new Promise((resolve) => {
    const ext = path.extname(file).toLowerCase();
    const guess = IMAGE_EXT.has(ext) ? { kind: 'image', duration: 0, width: 0, height: 0, audio: false } : AUDIO_EXT.has(ext) ? { kind: 'audio', duration: 0, width: 0, height: 0, audio: true } : { kind: 'video', duration: 0, width: 0, height: 0, audio: true };
    const bin = which('ffprobe');
    if (!bin) return resolve(guess);
    execFile(bin, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', `file:${file}`], { timeout: 15000, maxBuffer: 4 << 20 }, (e, stdout) => {
      if (e) return resolve({ ...guess, error: true });
      try {
        const j = JSON.parse(stdout);
        const vs = (j.streams || []).find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
        const as = (j.streams || []).find((s) => s.codec_type === 'audio');
        const d = Number(j.format?.duration) || Number(vs?.duration) || Number(as?.duration) || 0;
        const still = vs && (IMAGE_EXT.has(ext) || /^(png|mjpeg|webp|bmp|gif)$/.test(vs.codec_name || '') && d < 0.1);
        if (still) return resolve({ kind: 'image', duration: 0, width: vs.width || 0, height: vs.height || 0, audio: false });
        if (vs) return resolve({ kind: 'video', duration: d, width: vs.width || 0, height: vs.height || 0, audio: !!as });
        if (as) return resolve({ kind: 'audio', duration: d, width: 0, height: 0, audio: true });
        resolve({ ...guess, error: true });
      } catch {
        resolve({ ...guess, error: true });
      }
    });
  });
}

module.exports = function register(api) {
  const jobs = new Map();
  let seq = 0;
  api.handle('videoeditor:tools', async () => ({ ffmpeg: !!which('ffmpeg'), ffprobe: !!which('ffprobe') }));
  api.handle('videoeditor:probe', async (file) => probe(absPath(file, 'path')));
  api.handle('videoeditor:cancel', async (id) => {
    const job = jobs.get(id);
    if (job) {
      job.canceled = true;
      try {
        job.proc.kill('SIGTERM');
      } catch {}
    }
    return true;
  });
  api.handle('videoeditor:export', async (project, opts = {}, event) => {
    const bin = which('ffmpeg');
    if (!bin) throw err('ffmpeg is not installed', 'ENOFFMPEG');
    const v = validateProject(project);
    const out = absPath(opts.out, 'output');
    if (!fs.existsSync(path.dirname(out))) throw err('the destination folder does not exist', 'ENOENT');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'selene-videoeditor-'));
    const font = FONTS.find((f) => fs.existsSync(f)) || FONTS[0];
    const { args, duration, textFiles } = buildArgs(v, { out, height: opts.height === 720 ? 720 : 1080, font, tmpDir });
    for (const t of textFiles) fs.writeFileSync(t.path, t.text);
    const id = `ve${Date.now().toString(36)}${++seq}`;
    const sender = event?.sender;
    const send = (p) => api.sendTo(sender, 'videoeditor:progress', { id, out, ...p });
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const job = { proc, canceled: false };
    jobs.set(id, job);
    let stderr = '';
    let last = 0;
    proc.stdout.on('data', (d) => {
      const { time } = parseProgress(d);
      if (time == null) return;
      const percent = Math.max(0, Math.min(99, Math.round((time / duration) * 100)));
      if (percent !== last) send({ state: 'running', percent, time });
      last = percent;
    });
    proc.stderr.on('data', (d) => (stderr = (stderr + d).slice(-4000)));
    const finish = (state, error) => {
      jobs.delete(id);
      fs.rm(tmpDir, { recursive: true, force: true }, () => {});
      if (state !== 'done') fs.rm(out, { force: true }, () => {});
      send({ state, percent: state === 'done' ? 100 : last, error });
    };
    proc.on('error', (e) => finish('error', String(e.message || e)));
    proc.on('close', (code) => {
      if (!jobs.has(id)) return;
      if (job.canceled) finish('canceled');
      else if (code === 0) finish('done');
      else finish('error', stderr.trim().split('\n').slice(-3).join('\n') || `ffmpeg exited with ${code}`);
    });
    send({ state: 'running', percent: 0, time: 0 });
    return { id, duration };
  });
};
module.exports.validateProject = validateProject;
module.exports.buildArgs = buildArgs;
module.exports.parseProgress = parseProgress;
module.exports.totalDuration = totalDuration;
