// System sounds synthesised with WebAudio (no binary assets needed), in sound packs.
//   sounds.play('notify' | 'startup' | 'shutdown' | 'error' | 'click' | 'logon' | 'unlock' | 'screenshot' | 'alarm')
//   sounds.play([{ freq: 880, dur: 0.2 }, …])        a tone pattern (e.g. an app's alarm tone)
//   await sounds.playAndWait('shutdown', 1500)       resolves when the sound has played (max ms)
//   sounds.preview(ref)                              plays a sound reference even when system sounds are off
//   SOUND_PACKS / sounds.packs                       [{ id, name: { en, fr } }]
//   SOUND_EVENTS                                     ['notification', 'startup', 'shutdown'] (settings soundEvents)
//   sounds.choices(event)                            -> sound ids a Settings combo offers for an event
// Personalization (docs/PERSONALIZATION.md §11.3):
//   settings.soundPack      'aurora' | 'chimes' | 'retro' | 'soft' | 'silent'   (the scheme of every system sound)
//   settings.soundEvents    { notification, startup, shutdown }: null = the pack's sound, 'none' = silent,
//                           '<pack>.<sound>' (e.g. 'chimes.notify') = another pack's sound, '/abs/path.ogg' = a file
//   settings.sounds         false = every system sound off (pre-existing)
// Alarms keep ringing with the "silent" pack (they are not decoration).
import { settings } from './settings.js';
import { api } from './api.js';

let ctx = null;
function audio() {
  if (!ctx) ctx = new AudioContext();
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

function tone(ac, { freq, start = 0, dur = 0.25, type = 'sine', gain = 0.18, glide }) {
  const o = ac.createOscillator();
  const g = ac.createGain();
  const t0 = ac.currentTime + start;
  o.type = type;
  o.frequency.setValueAtTime(freq, t0);
  if (glide) o.frequency.exponentialRampToValueAtTime(glide, t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g).connect(ac.destination);
  o.start(t0);
  o.stop(t0 + dur + 0.05);
}

// Bell-like tone: the fundamental plus a quiet inharmonic partial.
const bell = (freq, start, dur, gain) => [
  { freq, start, dur, gain, type: 'sine' },
  { freq: freq * 2.76, start, dur: dur * 0.4, gain: gain * 0.22, type: 'sine' },
];

const AURORA = {
  alarm: [
    { freq: 1046.5, dur: 0.16, gain: 0.16, type: 'triangle' },
    { freq: 1318.5, start: 0.2, dur: 0.16, gain: 0.16, type: 'triangle' },
    { freq: 1046.5, start: 0.4, dur: 0.16, gain: 0.16, type: 'triangle' },
    { freq: 1568, start: 0.6, dur: 0.3, gain: 0.14, type: 'triangle' },
  ],
  notify: [
    { freq: 880, dur: 0.18, gain: 0.12 },
    { freq: 1318.5, start: 0.09, dur: 0.32, gain: 0.1 },
  ],
  startup: [
    { freq: 523.25, dur: 0.9, gain: 0.08 },
    { freq: 659.25, start: 0.12, dur: 0.9, gain: 0.08 },
    { freq: 783.99, start: 0.24, dur: 1.0, gain: 0.08 },
    { freq: 1046.5, start: 0.36, dur: 1.3, gain: 0.07 },
  ],
  shutdown: [
    { freq: 1046.5, dur: 0.7, gain: 0.07 },
    { freq: 783.99, start: 0.14, dur: 0.7, gain: 0.07 },
    { freq: 659.25, start: 0.28, dur: 0.8, gain: 0.07 },
    { freq: 523.25, start: 0.42, dur: 1.0, gain: 0.07 },
  ],
  logon: [
    { freq: 659.25, dur: 0.5, gain: 0.08 },
    { freq: 987.77, start: 0.1, dur: 0.7, gain: 0.07 },
  ],
  unlock: [{ freq: 740, dur: 0.2, gain: 0.08, glide: 1100 }],
  error: [
    { freq: 330, dur: 0.18, type: 'triangle', gain: 0.15 },
    { freq: 262, start: 0.12, dur: 0.3, type: 'triangle', gain: 0.15 },
  ],
  click: [{ freq: 1500, dur: 0.04, gain: 0.05, type: 'square' }],
  screenshot: [
    { freq: 2200, dur: 0.05, gain: 0.06, type: 'square' },
    { freq: 1400, start: 0.06, dur: 0.06, gain: 0.05, type: 'square' },
  ],
};
const CHIMES = {
  alarm: [...bell(1318.5, 0, 0.5, 0.14), ...bell(1568, 0.25, 0.5, 0.12), ...bell(1318.5, 0.5, 0.5, 0.14), ...bell(2093, 0.75, 0.8, 0.1)],
  notify: [...bell(1568, 0, 0.7, 0.09), ...bell(2093, 0.14, 0.9, 0.07)],
  startup: [...bell(523.25, 0, 1.6, 0.06), ...bell(783.99, 0.18, 1.6, 0.06), ...bell(1046.5, 0.36, 1.8, 0.06), ...bell(1318.5, 0.54, 2.0, 0.05)],
  shutdown: [...bell(1318.5, 0, 1.2, 0.05), ...bell(1046.5, 0.2, 1.2, 0.05), ...bell(783.99, 0.4, 1.4, 0.06), ...bell(523.25, 0.6, 1.8, 0.06)],
  logon: [...bell(987.77, 0, 1.0, 0.07), ...bell(1318.5, 0.16, 1.2, 0.06)],
  unlock: [...bell(1318.5, 0, 0.6, 0.07)],
  error: [...bell(392, 0, 0.6, 0.12), ...bell(311.13, 0.16, 0.8, 0.11)],
  click: [{ freq: 2637, dur: 0.06, gain: 0.04 }],
  screenshot: [...bell(2093, 0, 0.3, 0.06)],
};
const RETRO = {
  alarm: [
    { freq: 1760, dur: 0.1, type: 'square', gain: 0.07 },
    { freq: 1760, start: 0.15, dur: 0.1, type: 'square', gain: 0.07 },
    { freq: 1760, start: 0.3, dur: 0.1, type: 'square', gain: 0.07 },
    { freq: 2349, start: 0.45, dur: 0.25, type: 'square', gain: 0.06 },
  ],
  notify: [
    { freq: 987.77, dur: 0.08, type: 'square', gain: 0.05 },
    { freq: 1318.5, start: 0.09, dur: 0.16, type: 'square', gain: 0.05 },
  ],
  startup: [
    { freq: 523.25, dur: 0.12, type: 'square', gain: 0.05 },
    { freq: 659.25, start: 0.12, dur: 0.12, type: 'square', gain: 0.05 },
    { freq: 783.99, start: 0.24, dur: 0.12, type: 'square', gain: 0.05 },
    { freq: 1046.5, start: 0.36, dur: 0.4, type: 'square', gain: 0.05 },
  ],
  shutdown: [
    { freq: 1046.5, dur: 0.12, type: 'square', gain: 0.05 },
    { freq: 783.99, start: 0.12, dur: 0.12, type: 'square', gain: 0.05 },
    { freq: 659.25, start: 0.24, dur: 0.12, type: 'square', gain: 0.05 },
    { freq: 523.25, start: 0.36, dur: 0.45, type: 'square', gain: 0.05 },
  ],
  logon: [
    { freq: 783.99, dur: 0.1, type: 'square', gain: 0.05 },
    { freq: 1174.66, start: 0.1, dur: 0.2, type: 'square', gain: 0.05 },
  ],
  unlock: [{ freq: 660, dur: 0.12, type: 'square', gain: 0.05, glide: 1320 }],
  error: [
    { freq: 196, dur: 0.18, type: 'square', gain: 0.07 },
    { freq: 147, start: 0.18, dur: 0.3, type: 'square', gain: 0.07 },
  ],
  click: [{ freq: 1200, dur: 0.03, type: 'square', gain: 0.04 }],
  screenshot: [{ freq: 3000, dur: 0.04, type: 'square', gain: 0.05, glide: 800 }],
};
const SOFT = {
  alarm: AURORA.alarm,
  notify: [
    { freq: 659.25, dur: 0.35, gain: 0.05 },
    { freq: 880, start: 0.16, dur: 0.45, gain: 0.04 },
  ],
  startup: [
    { freq: 392, dur: 1.4, gain: 0.04, type: 'triangle' },
    { freq: 493.88, start: 0.25, dur: 1.4, gain: 0.04, type: 'triangle' },
    { freq: 587.33, start: 0.5, dur: 1.8, gain: 0.04, type: 'triangle' },
  ],
  shutdown: [
    { freq: 587.33, dur: 1.2, gain: 0.04, type: 'triangle' },
    { freq: 493.88, start: 0.25, dur: 1.2, gain: 0.04, type: 'triangle' },
    { freq: 392, start: 0.5, dur: 1.5, gain: 0.04, type: 'triangle' },
  ],
  logon: [{ freq: 587.33, dur: 0.6, gain: 0.04 }],
  unlock: [{ freq: 587.33, dur: 0.25, gain: 0.04, glide: 784 }],
  error: [{ freq: 294, dur: 0.4, type: 'triangle', gain: 0.07 }],
  click: [{ freq: 1000, dur: 0.03, gain: 0.025 }],
  screenshot: [{ freq: 1400, dur: 0.08, gain: 0.03 }],
};
const PACKS = { aurora: AURORA, chimes: CHIMES, retro: RETRO, soft: SOFT, silent: { alarm: AURORA.alarm } };
// Kept for callers that read the default scheme.
const PRESETS = AURORA;

export const SOUND_PACKS = [
  { id: 'aurora', name: { en: 'Aurora', fr: 'Aurora' } },
  { id: 'chimes', name: { en: 'Chimes', fr: 'Carillons' } },
  { id: 'retro', name: { en: 'Retro 8-bit', fr: 'Rétro 8 bits' } },
  { id: 'soft', name: { en: 'Soft', fr: 'Doux' } },
  { id: 'silent', name: { en: 'Silent', fr: 'Silencieux' } },
];
export const SOUND_EVENTS = ['notification', 'startup', 'shutdown'];
const EVENT_SOUND = { notification: 'notify', startup: 'startup', shutdown: 'shutdown' };
const SOUND_EVENT = { notify: 'notification', startup: 'startup', shutdown: 'shutdown' };
const AUDIO_FILE = /\.(ogg|oga|opus|wav|mp3|flac|m4a|webm)$/i;

// A pattern is an array of tones [{ freq, start, dur, type, gain, glide }] (e.g. an app's alarm tone).
const TYPES = ['sine', 'square', 'triangle', 'sawtooth'];
const num = (v, min, max, def) => (Number.isFinite(Number(v)) ? Math.min(max, Math.max(min, Number(v))) : def);
export function sanitizePattern(p) {
  if (!Array.isArray(p)) return null;
  const out = p.slice(0, 32).filter((x) => x && Number.isFinite(Number(x.freq))).map((x) => ({
    freq: num(x.freq, 20, 8000, 440),
    start: num(x.start, 0, 3, 0),
    dur: num(x.dur, 0.02, 3, 0.25),
    type: TYPES.includes(x.type) ? x.type : 'sine',
    gain: num(x.gain, 0.001, 0.3, 0.15),
    ...(Number.isFinite(Number(x.glide)) ? { glide: num(x.glide, 20, 8000, 440) } : {}),
  }));
  return out.length ? out : null;
}

const packId = () => (PACKS[settings.get('soundPack')] ? settings.get('soundPack') : 'aurora');
const lengthOf = (p) => (p || []).reduce((m, t) => Math.max(m, (t.start || 0) + (t.dur || 0.25)), 0) * 1000;

/**
 * What to play for a name: { pattern } | { file } | null (nothing). Applies the pack and the per-event choice.
 * A reference may also be '<pack>.<sound>', 'none', null (the pack's sound) or an audio file path.
 */
function resolve(name, ref) {
  if (ref === 'none') return null;
  if (typeof ref === 'string' && ref.startsWith('/') && AUDIO_FILE.test(ref) && !ref.includes('\0')) return { file: ref };
  if (typeof ref === 'string' && /^[a-z]+\.[a-z]+$/.test(ref)) {
    const [p, s] = ref.split('.');
    if (PACKS[p]?.[s]) return { pattern: PACKS[p][s] };
  }
  const pack = PACKS[packId()];
  const p = pack[name] || (name === 'alarm' ? AURORA.alarm : null);
  return p ? { pattern: p } : null;
}

let fileEl = null;
function playFile(path) {
  try {
    fileEl?.pause();
    fileEl = new Audio(api.mediaUrl(path));
    fileEl.volume = 0.9;
    const done = new Promise((res) => {
      fileEl.addEventListener('ended', res, { once: true });
      fileEl.addEventListener('error', res, { once: true });
    });
    fileEl.play().catch(() => {});
    return done;
  } catch {
    return Promise.resolve();
  }
}
function playPattern(p) {
  try {
    const ac = audio();
    for (const t of p) tone(ac, t);
  } catch {}
  return new Promise((res) => setTimeout(res, lengthOf(p)));
}
function run(what) {
  if (!what) return Promise.resolve();
  return what.file ? playFile(what.file) : playPattern(what.pattern);
}

export const sounds = {
  packs: SOUND_PACKS,
  events: SOUND_EVENTS,
  /** sounds.play('notify') or sounds.play([{ freq: 880, dur: 0.2 }, …]) (a tone pattern) */
  play(name) {
    if (settings.get('sounds') === false) return;
    if (Array.isArray(name)) {
      const p = sanitizePattern(name);
      if (p) playPattern(p);
      return;
    }
    const ev = SOUND_EVENT[name];
    run(resolve(name, ev ? settings.get(`soundEvents.${ev}`) : null));
  },
  /** Play and wait until it has finished (at most `max` ms): the shutdown sound before powering off. */
  playAndWait(name, max = 1500) {
    if (settings.get('sounds') === false) return Promise.resolve();
    const ev = SOUND_EVENT[name];
    const what = resolve(name, ev ? settings.get(`soundEvents.${ev}`) : null);
    if (!what) return Promise.resolve();
    return Promise.race([run(what), new Promise((res) => setTimeout(res, max))]);
  },
  /** Settings previews: a sound name in the current pack, '<pack>.<sound>', or a file — even with system sounds off. */
  preview(ref, name = 'notify') {
    if (ref && PACKS[ref]) return run({ pattern: PACKS[ref][name] || PACKS[ref].notify || AURORA.notify });
    return run(resolve(name, ref));
  },
  /** Sound ids offered for an event in Settings: '<pack>.<sound>' for every pack that has one. */
  choices(event) {
    const s = EVENT_SOUND[event];
    return SOUND_PACKS.filter((p) => PACKS[p.id][s]).map((p) => ({ id: `${p.id}.${s}`, pack: p }));
  },
  presets: PRESETS,
};
