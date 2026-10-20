// System sounds synthesised with WebAudio (no binary assets needed), in sound packs.
//   sounds.play(name)                                SOUND_NAMES: 'notify' | 'startup' | 'shutdown' | 'logon' | 'unlock' |
//                                                    'error' | 'warning' | 'click' | 'screenshot' | 'alarm' |
//                                                    'deviceConnect' | 'deviceDisconnect' | 'emptyTrash'
//   sounds.play([{ freq: 880, dur: 0.2 }, …])        a tone pattern (e.g. an app's alarm tone)
//   await sounds.playAndWait('shutdown', 1500)       resolves when the sound has played (max ms)
//   sounds.preview(ref, name)                        plays a sound reference even when system sounds are off
//   SOUND_PACKS / sounds.packs                       [{ id, name: { en, fr } }]
//   SOUND_NAMES                                      [{ id, name: { en, fr } }] every sound a pack defines
//   SOUND_EVENTS                                     ['notification', 'startup', 'shutdown'] (settings soundEvents)
//   sounds.choices(event)                            -> [{ pack, sounds: [{ id: '<pack>.<sound>', sound, own }] }]
//   sounds.packSounds(packId)                        -> the patterns of a pack (tests, previews)
//   sounds.watchSystem()                             starts the system hooks (device plugged / unplugged, recycle bin
//                                                    emptied); called once by core/packs.js at boot
// Personalization (docs/PERSONALIZATION.md §11.3):
//   settings.soundPack      'aurora' | 'chimes' | 'retro' | 'soft' | 'silent'   (the scheme of every system sound)
//   settings.soundEvents    { notification, startup, shutdown }: null = the pack's sound, 'none' = silent,
//                           '<pack>.<sound>' (any sound of any pack, e.g. 'chimes.logon'), '/abs/path.ogg' = a file
//   settings.soundVolume    0–100: volume of every system sound (100 = as designed)
//   settings.startupSound   false = no sound when the session starts
//   settings.sounds         false = every system sound off (pre-existing)
// Alarms keep ringing with the "silent" pack (they are not decoration).
import { settings } from './settings.js';
import { api } from './api.js';

let ctx = null;
// A running AudioContext keeps an output stream open for good (an audio thread in the shell and in Chromium's audio
// service waking every few ms, and the sound server never suspends its sink): suspend it once the last sound is over.
let idleTimer = 0;
function audio() {
  if (!ctx) ctx = new AudioContext();
  clearTimeout(idleTimer);
  if (ctx.state !== 'closed') ctx.resume().catch(() => {}); // also undoes a suspend() still in flight
  return ctx;
}
function releaseSoon(ms) {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => ctx?.state === 'running' && ctx.suspend().catch(() => {}), ms + 1500);
}

function tone(ac, { freq, start = 0, dur = 0.25, type = 'sine', gain = 0.18, glide }, vol = 1) {
  const o = ac.createOscillator();
  const g = ac.createGain();
  const t0 = ac.currentTime + start;
  const peak = Math.max(0.0002, gain * vol);
  o.type = type;
  o.frequency.setValueAtTime(freq, t0);
  if (glide) o.frequency.exponentialRampToValueAtTime(glide, t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(peak, t0 + 0.015);
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
// Marimba-like tone: a soft triangle body and the bar's fourth harmonic, both decaying fast.
const mallet = (freq, start, dur, gain) => [
  { freq, start, dur, gain, type: 'triangle' },
  { freq: freq * 4, start, dur: dur * 0.18, gain: gain * 0.25, type: 'sine' },
];
// 8-bit note.
const sq = (freq, start, dur, gain = 0.05, glide) => ({ freq, start, dur, gain, type: 'square', ...(glide ? { glide } : {}) });

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
  warning: [
    { freq: 587.33, dur: 0.16, type: 'triangle', gain: 0.12 },
    { freq: 587.33, start: 0.2, dur: 0.24, type: 'triangle', gain: 0.11 },
  ],
  click: [{ freq: 1500, dur: 0.04, gain: 0.05, type: 'square' }],
  screenshot: [
    { freq: 2200, dur: 0.05, gain: 0.06, type: 'square' },
    { freq: 1400, start: 0.06, dur: 0.06, gain: 0.05, type: 'square' },
  ],
  deviceConnect: [
    { freq: 587.33, dur: 0.16, gain: 0.09 },
    { freq: 880, start: 0.11, dur: 0.3, gain: 0.08 },
  ],
  deviceDisconnect: [
    { freq: 880, dur: 0.16, gain: 0.08 },
    { freq: 587.33, start: 0.11, dur: 0.3, gain: 0.09 },
  ],
  emptyTrash: [
    { freq: 420, dur: 0.22, gain: 0.07, type: 'sawtooth', glide: 140 },
    { freq: 300, start: 0.12, dur: 0.24, gain: 0.05, type: 'sawtooth', glide: 90 },
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
  warning: [...bell(659.25, 0, 0.5, 0.1), ...bell(659.25, 0.22, 0.6, 0.09)],
  click: [{ freq: 2637, dur: 0.06, gain: 0.04 }],
  screenshot: [...bell(2093, 0, 0.3, 0.06)],
  deviceConnect: [...bell(1046.5, 0, 0.5, 0.08), ...bell(1568, 0.14, 0.7, 0.07)],
  deviceDisconnect: [...bell(1568, 0, 0.5, 0.07), ...bell(1046.5, 0.14, 0.7, 0.08)],
  emptyTrash: [...bell(783.99, 0, 0.3, 0.06), { freq: 360, start: 0.05, dur: 0.3, gain: 0.04, type: 'sawtooth', glide: 120 }],
};
const RETRO = {
  alarm: [sq(1760, 0, 0.1, 0.07), sq(1760, 0.15, 0.1, 0.07), sq(1760, 0.3, 0.1, 0.07), sq(2349, 0.45, 0.25, 0.06)],
  notify: [sq(987.77, 0, 0.08), sq(1318.5, 0.09, 0.16)],
  startup: [sq(523.25, 0, 0.12), sq(659.25, 0.12, 0.12), sq(783.99, 0.24, 0.12), sq(1046.5, 0.36, 0.4)],
  shutdown: [sq(1046.5, 0, 0.12), sq(783.99, 0.12, 0.12), sq(659.25, 0.24, 0.12), sq(523.25, 0.36, 0.45)],
  logon: [sq(783.99, 0, 0.1), sq(1174.66, 0.1, 0.2)],
  unlock: [sq(660, 0, 0.12, 0.05, 1320)],
  error: [sq(196, 0, 0.18, 0.07), sq(147, 0.18, 0.3, 0.07)],
  warning: [sq(440, 0, 0.1, 0.06), sq(440, 0.14, 0.14, 0.06)],
  click: [sq(1200, 0, 0.03, 0.04)],
  screenshot: [sq(3000, 0, 0.04, 0.05, 800)],
  deviceConnect: [sq(659.25, 0, 0.08), sq(987.77, 0.08, 0.08), sq(1318.5, 0.16, 0.14)],
  deviceDisconnect: [sq(1318.5, 0, 0.08), sq(987.77, 0.08, 0.08), sq(659.25, 0.16, 0.14)],
  emptyTrash: [sq(880, 0, 0.18, 0.05, 110)],
};
const SOFT = {
  alarm: AURORA.alarm,
  notify: [...mallet(659.25, 0, 0.35, 0.05), ...mallet(880, 0.16, 0.45, 0.04)],
  startup: [...mallet(392, 0, 1.4, 0.04), ...mallet(493.88, 0.25, 1.4, 0.04), ...mallet(587.33, 0.5, 1.8, 0.04)],
  shutdown: [...mallet(587.33, 0, 1.2, 0.04), ...mallet(493.88, 0.25, 1.2, 0.04), ...mallet(392, 0.5, 1.5, 0.04)],
  logon: [...mallet(587.33, 0, 0.6, 0.04), ...mallet(783.99, 0.14, 0.7, 0.035)],
  unlock: [{ freq: 587.33, dur: 0.25, gain: 0.04, glide: 784, type: 'triangle' }],
  error: [{ freq: 294, dur: 0.4, type: 'triangle', gain: 0.07 }],
  warning: [...mallet(440, 0, 0.3, 0.05), ...mallet(440, 0.2, 0.35, 0.045)],
  click: [{ freq: 1000, dur: 0.03, gain: 0.025 }],
  screenshot: [{ freq: 1400, dur: 0.08, gain: 0.03 }],
  deviceConnect: [...mallet(523.25, 0, 0.4, 0.045), ...mallet(783.99, 0.14, 0.5, 0.04)],
  deviceDisconnect: [...mallet(783.99, 0, 0.4, 0.04), ...mallet(523.25, 0.14, 0.5, 0.045)],
  emptyTrash: [{ freq: 330, dur: 0.3, gain: 0.04, type: 'triangle', glide: 140 }],
};
const PACKS = { aurora: AURORA, chimes: CHIMES, retro: RETRO, soft: SOFT, silent: { alarm: AURORA.alarm } };
// Kept for callers that read the default scheme.
const PRESETS = AURORA;

export const SOUND_PACKS = [
  { id: 'aurora', name: { en: 'Selene', fr: 'Selene' } },
  { id: 'chimes', name: { en: 'Chimes', fr: 'Carillons' } },
  { id: 'retro', name: { en: 'Retro 8-bit', fr: 'Rétro 8 bits' } },
  { id: 'soft', name: { en: 'Soft', fr: 'Doux' } },
  { id: 'silent', name: { en: 'Silent', fr: 'Silencieux' } },
];
export const SOUND_NAMES = [
  { id: 'notify', name: { en: 'Notification', fr: 'Notification' } },
  { id: 'startup', name: { en: 'Startup', fr: 'Démarrage' } },
  { id: 'shutdown', name: { en: 'Shut down', fr: 'Arrêt' } },
  { id: 'logon', name: { en: 'Sign in', fr: 'Connexion' } },
  { id: 'unlock', name: { en: 'Unlock', fr: 'Déverrouillage' } },
  { id: 'error', name: { en: 'Error', fr: 'Erreur' } },
  { id: 'warning', name: { en: 'Warning', fr: 'Avertissement' } },
  { id: 'click', name: { en: 'Click', fr: 'Clic' } },
  { id: 'screenshot', name: { en: 'Screenshot', fr: 'Capture d’écran' } },
  { id: 'alarm', name: { en: 'Alarm', fr: 'Alarme' } },
  { id: 'deviceConnect', name: { en: 'Device connected', fr: 'Périphérique connecté' } },
  { id: 'deviceDisconnect', name: { en: 'Device disconnected', fr: 'Périphérique déconnecté' } },
  { id: 'emptyTrash', name: { en: 'Empty Trash', fr: 'Vider la Corbeille' } },
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
const volume = () => num(settings.get('soundVolume'), 0, 100, 100) / 100;
const lengthOf = (p) => (p || []).reduce((m, t) => Math.max(m, (t.start || 0) + (t.dur || 0.25)), 0) * 1000;
const SOUND_REF = /^([a-z]+)\.([a-zA-Z]+)$/;

/**
 * What to play for a name: { pattern } | { file } | null (nothing). Applies the pack and the per-event choice.
 * A reference may also be '<pack>.<sound>', 'none', null (the pack's sound) or an audio file path.
 */
function resolve(name, ref) {
  if (ref === 'none') return null;
  if (typeof ref === 'string' && ref.startsWith('/') && AUDIO_FILE.test(ref) && !ref.includes('\0') && !/(^|\/)\.\.(\/|$)/.test(ref)) return { file: ref };
  if (typeof ref === 'string') {
    const m = SOUND_REF.exec(ref);
    if (m && Object.prototype.hasOwnProperty.call(PACKS, m[1]) && Object.prototype.hasOwnProperty.call(PACKS[m[1]], m[2])) return { pattern: PACKS[m[1]][m[2]] };
  }
  const pack = PACKS[packId()];
  const p = (Object.prototype.hasOwnProperty.call(pack, name) && pack[name]) || (name === 'alarm' ? AURORA.alarm : null);
  return p ? { pattern: p } : null;
}

let fileEl = null;
function playFile(path, vol) {
  try {
    fileEl?.pause();
    fileEl = new Audio(api.mediaUrl(path));
    fileEl.volume = Math.max(0, Math.min(1, 0.9 * vol));
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
function playPattern(p, vol) {
  try {
    const ac = audio();
    for (const t of p) tone(ac, t, vol);
  } catch {}
  releaseSoon(lengthOf(p));
  return new Promise((res) => setTimeout(res, lengthOf(p)));
}
function run(what, vol = volume()) {
  if (!what || vol <= 0) return Promise.resolve();
  return what.file ? playFile(what.file, vol) : playPattern(what.pattern, vol);
}
const muted = (name) => settings.get('sounds') === false || (name === 'startup' && settings.get('startupSound') === false);

// ------------------------------------------------------------------ system hooks
let watched = false;
let drives = null; // ids of the drives last seen
function drivesChanged(list) {
  const ids = new Set((Array.isArray(list) ? list : []).map((d) => String(d?.id ?? d?.device ?? '')).filter(Boolean));
  const before = drives;
  drives = ids;
  if (!before) return null;
  const added = [...ids].some((id) => !before.has(id));
  const removed = [...before].some((id) => !ids.has(id));
  const name = added ? 'deviceConnect' : removed ? 'deviceDisconnect' : null;
  if (name) sounds.play(name);
  return name;
}

export const sounds = {
  packs: SOUND_PACKS,
  events: SOUND_EVENTS,
  names: SOUND_NAMES,
  /** sounds.play('notify') or sounds.play([{ freq: 880, dur: 0.2 }, …]) (a tone pattern) */
  play(name) {
    if (Array.isArray(name)) {
      if (settings.get('sounds') === false) return;
      const p = sanitizePattern(name);
      if (p) playPattern(p, volume());
      return;
    }
    if (muted(name)) return;
    const ev = SOUND_EVENT[name];
    run(resolve(name, ev ? settings.get(`soundEvents.${ev}`) : null));
  },
  /** Play and wait until it has finished (at most `max` ms): the shutdown sound before powering off. */
  playAndWait(name, max = 1500) {
    if (muted(name)) return Promise.resolve();
    const ev = SOUND_EVENT[name];
    const what = resolve(name, ev ? settings.get(`soundEvents.${ev}`) : null);
    if (!what || volume() <= 0) return Promise.resolve();
    return Promise.race([run(what), new Promise((res) => setTimeout(res, max))]);
  },
  /** Settings previews: a pack id (+ sound name), '<pack>.<sound>', a file or null (the current pack) — even with
   *  system sounds off; at the system-sound volume (at least 30 % so a preview is never silent by surprise). */
  preview(ref, name = 'notify', { volume: vol } = {}) {
    const v = vol ?? Math.max(0.3, volume());
    if (ref && Object.prototype.hasOwnProperty.call(PACKS, ref)) return run({ pattern: PACKS[ref][name] || PACKS[ref].notify || AURORA.notify }, v);
    return run(resolve(name, ref), v);
  },
  /** Sounds offered for an event in Settings, by pack: the event's own sound first, then every other sound. */
  choices(event) {
    const own = EVENT_SOUND[event] || 'notify';
    return SOUND_PACKS.filter((p) => p.id !== 'silent').map((p) => ({
      pack: p,
      sounds: [own, ...SOUND_NAMES.map((s) => s.id).filter((s) => s !== own)]
        .filter((s) => PACKS[p.id][s])
        .map((s) => ({ id: `${p.id}.${s}`, sound: SOUND_NAMES.find((x) => x.id === s), own: s === own })),
    }));
  },
  packSounds: (id) => PACKS[id] || null,
  presets: PRESETS,
  /** System hooks: drives plugged / unplugged (files:drives-changed) and the recycle bin emptied (fs:trash-changed). */
  watchSystem() {
    if (watched) return;
    watched = true;
    api.on?.('fs:trash-changed', (p) => {
      if (p?.emptied) sounds.play('emptyTrash');
    });
    const refresh = () =>
      api
        .invoke('fs:drives')
        .then(drivesChanged)
        .catch(() => {});
    api.on?.('files:drives-changed', refresh);
    refresh().then(() => api.invoke('files:drivesWatch').catch(() => {}));
  },
  /** Test hook: feed a drive list as if it came from fs:drives; returns the sound played (or null). */
  drivesChanged,
};
