// System sounds synthesised with WebAudio (no binary assets needed).
//   sounds.play('notify' | 'startup' | 'error' | 'click' | 'logon' | 'unlock' | 'screenshot')
import { settings } from './settings.js';

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

const PRESETS = {
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

export const sounds = {
  /** sounds.play('notify') or sounds.play([{ freq: 880, dur: 0.2 }, …]) (a tone pattern) */
  play(name) {
    if (settings.get('sounds') === false) return;
    const p = Array.isArray(name) ? sanitizePattern(name) : PRESETS[name];
    if (!p) return;
    try {
      const ac = audio();
      for (const t of p) tone(ac, t);
    } catch {}
  },
};
