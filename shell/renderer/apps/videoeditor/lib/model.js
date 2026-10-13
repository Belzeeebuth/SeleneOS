// Video Editor project model: pure data and timeline maths, no DOM (shared by the app and test/videoeditor.unit.mjs).
//
// A project (saved as JSON in ~/Vidéos/Projets) :
//   { format: 'selene-video', version: 1, name,
//     media: [{ id, path, name, kind: 'video'|'image'|'audio', duration, width, height, audio }],
//     video: [{ id, type: 'media', mediaId, in, out, volume, fade, text } | { id, type: 'title', duration, bg, fade, text }],
//     music: [{ id, mediaId, in, out, volume, fadeIn, fadeOut }] }
// Both tracks are sequential: clips play one after the other from 0. An image clip uses in = 0 and out = its length.
// `fade` is the fade through black between a clip and the next one (the whole length at the end of the last clip).
// `text` = { value, size (px at 720p), pos: 'top'|'center'|'bottom', color: '#rrggbb' } over the clip, or null.
// The backend (main/ipc/videoeditor.js) validates the same shape again before export.

export const FORMAT = 'selene-video';
export const MIN_CLIP = 0.2;
export const IMAGE_DEFAULT = 4;
export const TITLE_DEFAULT = 3;
export const MAX_STILL = 600;

let n = 0;
export const uid = (p = 'c') => `${p}${Date.now().toString(36)}${(++n).toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
const round = (x) => Math.round(x * 1000) / 1000;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export function newProject(name = 'Project') {
  return { format: FORMAT, version: 1, name, media: [], video: [], music: [] };
}

export const mediaOf = (p, id) => p.media.find((m) => m.id === id) || null;

/** Adds a media entry to the bin (once per path); returns the entry. */
export function addMedia(p, m) {
  const had = p.media.find((x) => x.path === m.path);
  if (had) return had;
  const e = { id: m.id || uid('m'), path: m.path, name: m.name || m.path.split('/').pop(), kind: m.kind, duration: m.duration || 0, width: m.width || 0, height: m.height || 0, audio: !!m.audio };
  p.media.push(e);
  return e;
}

export const clipDuration = (c) => (c.type === 'title' ? c.duration : c.out - c.in);
export const trackOf = (p, track) => (track === 'music' ? p.music : p.video);
export const totalDuration = (p) => round(p.video.reduce((s, c) => s + clipDuration(c), 0));
export const musicDuration = (p) => round(p.music.reduce((s, c) => s + clipDuration(c), 0));

/** Start time of every clip of a track. */
export function starts(p, track = 'video') {
  let t = 0;
  return trackOf(p, track).map((c) => {
    const s = t;
    t += clipDuration(c);
    return s;
  });
}

/** The clip playing at time t: { clip, index, start, offset } or null. */
export function clipAt(p, t, track = 'video') {
  const list = trackOf(p, track);
  let s = 0;
  for (let i = 0; i < list.length; i++) {
    const d = clipDuration(list[i]);
    if (t >= s && (t < s + d || (i === list.length - 1 && t <= s + d + 1e-6))) return { clip: list[i], index: i, start: s, offset: t - s };
    s += d;
  }
  return null;
}

export function find(p, id) {
  for (const track of ['video', 'music']) {
    const index = trackOf(p, track).findIndex((c) => c.id === id);
    if (index >= 0) return { clip: trackOf(p, track)[index], track, index };
  }
  return null;
}

/** Puts a bin item on its track (videos and images on the video track, sound on the music track). */
export function addToTimeline(p, mediaId, index) {
  const m = mediaOf(p, mediaId);
  if (!m) return null;
  let clip;
  let list;
  if (m.kind === 'audio') {
    clip = { id: uid(), mediaId, in: 0, out: round(m.duration || 10), volume: 1, fadeIn: 0, fadeOut: 0 };
    list = p.music;
  } else {
    const d = m.kind === 'image' ? IMAGE_DEFAULT : m.duration || IMAGE_DEFAULT;
    clip = { id: uid(), type: 'media', mediaId, in: 0, out: round(d), volume: 1, fade: 0, text: null };
    list = p.video;
  }
  list.splice(index == null ? list.length : clamp(index, 0, list.length), 0, clip);
  return clip;
}

export function addTitle(p, index, text = {}) {
  const clip = { id: uid(), type: 'title', duration: TITLE_DEFAULT, bg: '#101820', fade: 0, text: { value: text.value ?? '', size: text.size ?? 64, pos: text.pos ?? 'center', color: text.color ?? '#ffffff' } };
  p.video.splice(index == null ? p.video.length : clamp(index, 0, p.video.length), 0, clip);
  return clip;
}

/** Cuts the clip under time t in two (video track, or the music track); returns [left, right] or null. */
export function split(p, t, track = 'video') {
  const hit = clipAt(p, t, track);
  if (!hit) return null;
  const { clip, index, offset } = hit;
  const d = clipDuration(clip);
  if (offset < MIN_CLIP || d - offset < MIN_CLIP) return null;
  const right = JSON.parse(JSON.stringify(clip));
  right.id = uid();
  if (clip.type === 'title') {
    clip.duration = round(offset);
    right.duration = round(d - offset);
  } else {
    const cut = round(clip.in + offset);
    clip.out = cut;
    right.in = cut;
  }
  if ('fadeOut' in clip) (right.fadeIn = 0), (clip.fadeOut = 0);
  else clip.fade = 0;
  trackOf(p, track).splice(index + 1, 0, right);
  return [clip, right];
}

/** Moves one edge of a clip by delta seconds (trim handles), within the media and the minimum length. */
export function trim(p, id, edge, delta) {
  const f = find(p, id);
  if (!f) return;
  const c = f.clip;
  if (c.type === 'title') {
    c.duration = round(clamp(c.duration + (edge === 'end' ? delta : -delta), MIN_CLIP, MAX_STILL));
    return;
  }
  const m = mediaOf(p, c.mediaId);
  if (m?.kind === 'image') {
    const d = clamp(c.out - c.in + (edge === 'end' ? delta : -delta), MIN_CLIP, MAX_STILL);
    c.in = 0;
    c.out = round(d);
    return;
  }
  const max = m?.duration || c.out;
  if (edge === 'start') c.in = round(clamp(c.in + delta, 0, c.out - MIN_CLIP));
  else c.out = round(clamp(c.out + delta, c.in + MIN_CLIP, max));
}

export function move(p, track, id, to) {
  const list = trackOf(p, track);
  const i = list.findIndex((c) => c.id === id);
  if (i < 0) return;
  const [c] = list.splice(i, 1);
  list.splice(clamp(to, 0, list.length), 0, c);
}

export function remove(p, id) {
  const f = find(p, id);
  if (f) trackOf(p, f.track).splice(f.index, 1);
  return f;
}

/** Removes a bin item and its clips. */
export function removeMedia(p, mediaId) {
  p.media = p.media.filter((m) => m.id !== mediaId);
  p.video = p.video.filter((c) => c.mediaId !== mediaId);
  p.music = p.music.filter((c) => c.mediaId !== mediaId);
}

/** Opacity of the picture (fades through black) at a time of the timeline. */
export function fadeAt(p, t) {
  const hit = clipAt(p, t);
  if (!hit) return 0;
  const { clip, index, offset } = hit;
  const d = clipDuration(clip);
  const prev = p.video[index - 1];
  const fin = prev?.fade ? prev.fade / 2 : 0;
  const fout = clip.fade ? (index === p.video.length - 1 ? clip.fade : clip.fade / 2) : 0;
  let o = 1;
  if (fin && offset < fin) o = Math.min(o, offset / fin);
  if (fout && d - offset < fout) o = Math.min(o, (d - offset) / fout);
  return clamp(o, 0, 1);
}

/** Music volume (0..1 for the preview) at a time, with its fades. */
export function musicGainAt(p, t) {
  const hit = clipAt(p, t, 'music');
  if (!hit) return 0;
  const { clip, offset } = hit;
  const d = clipDuration(clip);
  let g = clip.volume ?? 1;
  if (clip.fadeIn && offset < clip.fadeIn) g *= offset / clip.fadeIn;
  if (clip.fadeOut && d - offset < clip.fadeOut) g *= (d - offset) / clip.fadeOut;
  return clamp(g, 0, 1);
}

export function fmtTime(s, precise = false) {
  s = Math.max(0, s || 0);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = Math.floor(s % 60);
  const tenth = Math.floor((s * 10) % 10);
  const base = hh ? `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${mm}:${String(ss).padStart(2, '0')}`;
  return precise ? `${base}.${tenth}` : base;
}

export const serialize = (p) => JSON.stringify({ ...p, format: FORMAT, version: 1 }, null, 1);

/** A project from a saved file; throws { code: 'EFORMAT' } for anything else. */
export function parse(text) {
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    j = null;
  }
  if (!j || j.format !== FORMAT || !Array.isArray(j.media) || !Array.isArray(j.video)) throw Object.assign(new Error('not a video project'), { code: 'EFORMAT' });
  j.music = Array.isArray(j.music) ? j.music : [];
  j.name = typeof j.name === 'string' ? j.name : 'Project';
  return j;
}

/** What the backend's videoeditor:export takes. */
export function forExport(p) {
  return {
    media: p.media.map(({ id, path, kind, duration, audio }) => ({ id, path, kind, duration: kind === 'image' ? 0 : duration, audio })),
    video: p.video.map((c) => ({ ...c })),
    music: p.music.map((c) => ({ ...c })),
  };
}

/** Undo / redo by snapshots. commit(p) before a change; undo(p) / redo(p) return the project to show. */
export function history(limit = 100) {
  return {
    past: [],
    future: [],
    current: null,
    commit(p) {
      this.past.push(serialize(p));
      if (this.past.length > limit) this.past.shift();
      this.future = [];
    },
    undo(p) {
      if (!this.past.length) return null;
      this.future.push(serialize(p));
      return (this.current = parse(this.past.pop()));
    },
    redo(p) {
      if (!this.future.length) return null;
      this.past.push(serialize(p));
      return (this.current = parse(this.future.pop()));
    },
    get canUndo() {
      return this.past.length > 0;
    },
    get canRedo() {
      return this.future.length > 0;
    },
  };
}
