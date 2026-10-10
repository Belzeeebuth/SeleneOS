#!/usr/bin/env node
// Generates the ORIGINAL, royalty-free sample media shipped in new users' home folders
// (rootfs/etc/skel/Music and rootfs/etc/skel/Videos) and used by the Media Player tests.
//
//   cd aurora-os/shell && xvfb-run -a node tools/gen-media-samples.mjs
//   xvfb-run -a node tools/gen-media-samples.mjs --only=night-drive --music=/tmp/m --videos=/tmp/v
//
// Everything is synthesised from scratch inside an offscreen Electron/Chromium page (driven by
// playwright-core, like test/lib.mjs):
//   * music: a small WebAudio "studio" (OfflineAudioContext: detuned-saw pads, plucks, FM bells,
//     drums, bass, reverb and delay sends) renders each composition faster than real time; WebCodecs
//     AudioEncoder encodes it to Opus and this script muxes the packets into an Ogg Opus file with
//     Vorbis-comment tags (title, artist, album, track, genre…) and embedded cover art
//     (METADATA_BLOCK_PICTURE, drawn on a canvas).
//   * video: a canvas animation (stars, aurora curtains, mountains, the Aurora logo and wordmark)
//     encoded frame by frame with WebCodecs VideoEncoder (VP9) plus an Opus soundtrack, muxed by
//     this script into a seekable WebM (Duration + Cues).
// All randomness is seeded, so re-running produces the same compositions. The compositions, art and
// animation are original works made for Aurora OS and are dedicated to the public domain (CC0).
import { _electron as electron } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const AURORA = path.join(here, '..', '..');
const arg = (n, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.slice(n.length + 3) : d;
};

const MUSIC_DIR = path.resolve(arg('music', path.join(AURORA, 'rootfs', 'etc', 'skel', 'Music')));
const VIDEOS_DIR = path.resolve(arg('videos', path.join(AURORA, 'rootfs', 'etc', 'skel', 'Videos')));
const ALBUM = 'Aurora Sessions';
const ARTIST = 'Aurora';
const YEAR = '2026';
const COMMENT = 'Original music generated for Aurora OS. Public domain (CC0).';

export const JOBS = [
  { id: 'morning-light', kind: 'track', file: 'Aurora - Morning Light.ogg', title: 'Morning Light', track: 1, genre: 'Ambient Pop', bitrate: 88000 },
  { id: 'night-drive', kind: 'track', file: 'Aurora - Night Drive.ogg', title: 'Night Drive', track: 2, genre: 'Synthwave', bitrate: 88000 },
  { id: 'northern-lights', kind: 'track', file: 'Aurora - Northern Lights.ogg', title: 'Northern Lights', track: 3, genre: 'Ambient', bitrate: 80000 },
  { id: 'intro', kind: 'video', file: 'Aurora Intro.webm', title: 'Aurora Intro', width: 1280, height: 720, fps: 30, seconds: 12, bitrate: 700000, audioBitrate: 64000 },
];
const only = arg('only', '') ? arg('only', '').split(',') : JOBS.map((j) => j.id);

// =============================================================================================
// Runs inside Chromium (serialised by Playwright): must be self-contained.
async function studio(job) {
  const SR = 48000;
  const TAU = Math.PI * 2;
  function rng(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const mtof = (m) => 440 * 2 ** ((m - 69) / 12);
  function b64(u8) {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function concat(parts) {
    const n = parts.reduce((a, p) => a + p.length, 0);
    const out = new Uint8Array(n);
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }

  // ------------------------------------------------------------------ the studio (WebAudio)
  function makeStudio(seconds, seed) {
    const ctx = new OfflineAudioContext(2, Math.ceil(seconds * SR), SR);
    const rnd = rng(seed);
    const master = ctx.createGain();
    master.gain.value = 0.7;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.knee.value = 12;
    comp.ratio.value = 3;
    comp.attack.value = 0.008;
    comp.release.value = 0.3;
    master.connect(comp);
    comp.connect(ctx.destination);
    // Reverb: exponentially decaying stereo noise.
    const irLen = Math.floor(SR * 3.2);
    const ir = ctx.createBuffer(2, irLen, SR);
    for (let c = 0; c < 2; c++) {
      const d = ir.getChannelData(c);
      for (let i = 0; i < irLen; i++) d[i] = (rnd() * 2 - 1) * Math.pow(1 - i / irLen, 3.2) * (i < 200 ? i / 200 : 1);
    }
    const rev = ctx.createConvolver();
    rev.buffer = ir;
    const revOut = ctx.createGain();
    revOut.gain.value = 0.42;
    rev.connect(revOut);
    revOut.connect(master);
    // Tempo-synced delay (set per song).
    const dly = ctx.createDelay(2);
    const fb = ctx.createGain();
    fb.gain.value = 0.38;
    const dlyTone = ctx.createBiquadFilter();
    dlyTone.type = 'lowpass';
    dlyTone.frequency.value = 2800;
    dly.connect(dlyTone);
    dlyTone.connect(fb);
    fb.connect(dly);
    const dlyOut = ctx.createGain();
    dlyOut.gain.value = 0.5;
    dlyTone.connect(dlyOut);
    dlyOut.connect(master);
    const dlyRev = ctx.createGain();
    dlyRev.gain.value = 0.3;
    dlyOut.connect(dlyRev);
    dlyRev.connect(rev);
    const noise = ctx.createBuffer(1, SR * 2, SR);
    {
      const d = noise.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = rnd() * 2 - 1;
    }

    const S = {
      ctx,
      rnd,
      setDelay(sec) {
        dly.delayTime.value = sec;
      },
      channel({ gain = 1, pan = 0, rev: r = 0.2, dly: dl = 0 } = {}) {
        const g = ctx.createGain();
        g.gain.value = gain;
        const p = ctx.createStereoPanner();
        p.pan.value = pan;
        g.connect(p);
        p.connect(master);
        if (r) {
          const s = ctx.createGain();
          s.gain.value = r;
          p.connect(s);
          s.connect(rev);
        }
        if (dl) {
          const s = ctx.createGain();
          s.gain.value = dl;
          p.connect(s);
          s.connect(dly);
        }
        return g;
      },
      osc(type, freq, t0, t1, dest, detune = 0) {
        const o = ctx.createOscillator();
        o.type = type;
        o.frequency.value = freq;
        o.detune.value = detune;
        o.connect(dest);
        o.start(t0);
        o.stop(t1);
        return o;
      },
      env(t, a, peak, hold, release, dest, curve = 'exp') {
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(peak, t + a);
        if (hold > 0) g.gain.setValueAtTime(peak, t + a + hold);
        if (curve === 'exp') g.gain.exponentialRampToValueAtTime(0.0001, t + a + hold + release);
        else g.gain.linearRampToValueAtTime(0.0001, t + a + hold + release);
        g.connect(dest);
        return g;
      },
      filter(type, freq, q, dest) {
        const f = ctx.createBiquadFilter();
        f.type = type;
        f.frequency.value = freq;
        f.Q.value = q;
        f.connect(dest);
        return f;
      },
      // Soft detuned-saw pad.
      pad(ch, notes, t, dur, { attack = 1.2, release = 1.8, cutoff = 1200, level = 0.2, type = 'sawtooth', width = 9 } = {}) {
        const e = ctx.createGain();
        e.gain.setValueAtTime(0.0001, t);
        e.gain.linearRampToValueAtTime(level, t + attack);
        e.gain.setValueAtTime(level, t + Math.max(attack, dur));
        e.gain.linearRampToValueAtTime(0.0001, t + Math.max(attack, dur) + release);
        e.connect(ch);
        const f = ctx.createBiquadFilter();
        f.type = 'lowpass';
        f.Q.value = 0.6;
        f.frequency.setValueAtTime(cutoff * 0.45, t);
        f.frequency.linearRampToValueAtTime(cutoff, t + attack * 1.6);
        f.connect(e);
        const end = t + Math.max(attack, dur) + release + 0.05;
        for (const m of notes) {
          for (const d of [-width, width]) {
            const g = ctx.createGain();
            g.gain.value = 1 / (notes.length * 2.2);
            g.connect(f);
            S.osc(type, mtof(m), t, end, g, d + (rnd() - 0.5) * 3);
          }
        }
      },
      pluck(ch, m, t, { decay = 0.9, level = 0.22, type = 'triangle', bright = 3600 } = {}) {
        const e = S.env(t, 0.004, level, 0, decay, ch);
        const f = ctx.createBiquadFilter();
        f.type = 'lowpass';
        f.Q.value = 1.2;
        f.frequency.setValueAtTime(bright, t);
        f.frequency.exponentialRampToValueAtTime(380, t + decay);
        f.connect(e);
        S.osc(type, mtof(m), t, t + decay + 0.05, f);
        const g = ctx.createGain();
        g.gain.value = 0.28;
        g.connect(f);
        S.osc('sine', mtof(m + 12), t, t + decay + 0.05, g);
      },
      bell(ch, m, t, { decay = 2.6, level = 0.16, ratio = 3.5, index = 2.2 } = {}) {
        const fc = mtof(m);
        const e = S.env(t, 0.003, level, 0, decay, ch);
        const car = ctx.createOscillator();
        car.type = 'sine';
        car.frequency.value = fc;
        const mod = ctx.createOscillator();
        mod.type = 'sine';
        mod.frequency.value = fc * ratio;
        const mg = ctx.createGain();
        mg.gain.setValueAtTime(fc * index, t);
        mg.gain.exponentialRampToValueAtTime(fc * 0.05, t + decay * 0.6);
        mod.connect(mg);
        mg.connect(car.frequency);
        car.connect(e);
        car.start(t);
        mod.start(t);
        car.stop(t + decay + 0.1);
        mod.stop(t + decay + 0.1);
        const g = ctx.createGain();
        g.gain.value = 0.18;
        g.connect(e);
        S.osc('sine', fc * 2, t, t + decay, g);
      },
      bass(ch, m, t, dur, { level = 0.32, cutoff = 420, type = 'sawtooth', q = 3 } = {}) {
        const e = S.env(t, 0.006, level, Math.max(0, dur - 0.05), 0.08, ch, 'lin');
        const f = ctx.createBiquadFilter();
        f.type = 'lowpass';
        f.Q.value = q;
        f.frequency.setValueAtTime(cutoff * 3.2, t);
        f.frequency.exponentialRampToValueAtTime(cutoff, t + Math.min(0.25, dur));
        f.connect(e);
        S.osc(type, mtof(m), t, t + dur + 0.12, f);
        const g = ctx.createGain();
        g.gain.value = 0.55;
        g.connect(e);
        S.osc('sine', mtof(m - 12), t, t + dur + 0.12, g);
      },
      lead(ch, m, t, dur, { level = 0.12, cutoff = 2600 } = {}) {
        const e = S.env(t, 0.025, level, Math.max(0, dur - 0.03), 0.3, ch, 'lin');
        const f = S.filter('lowpass', cutoff, 1.5, e);
        const lfo = ctx.createOscillator();
        lfo.frequency.value = 5.2;
        const lg = ctx.createGain();
        lg.gain.setValueAtTime(0, t);
        lg.gain.linearRampToValueAtTime(9, t + Math.min(dur, 0.6));
        lfo.connect(lg);
        lfo.start(t);
        lfo.stop(t + dur + 0.4);
        for (const d of [-6, 6]) {
          const o = S.osc('sawtooth', mtof(m), t, t + dur + 0.4, f, d);
          lg.connect(o.detune);
        }
      },
      kick(ch, t, level = 0.9) {
        const e = S.env(t, 0.002, level, 0, 0.42, ch);
        const o = ctx.createOscillator();
        o.type = 'sine';
        o.frequency.setValueAtTime(150, t);
        o.frequency.exponentialRampToValueAtTime(44, t + 0.12);
        o.connect(e);
        o.start(t);
        o.stop(t + 0.5);
      },
      noiseHit(ch, t, { type = 'highpass', freq = 8000, q = 0.7, level = 0.2, decay = 0.05 } = {}) {
        const e = S.env(t, 0.001, level, 0, decay, ch);
        const f = S.filter(type, freq, q, e);
        const n = ctx.createBufferSource();
        n.buffer = noise;
        n.playbackRate.value = 0.9 + rnd() * 0.2;
        n.connect(f);
        n.start(t, rnd() * 1.5);
        n.stop(t + decay + 0.05);
      },
      snare(ch, t, level = 0.5) {
        S.noiseHit(ch, t, { type: 'bandpass', freq: 1900, q: 0.8, level, decay: 0.22 });
        const e = S.env(t, 0.001, level * 0.6, 0, 0.12, ch);
        const o = ctx.createOscillator();
        o.type = 'triangle';
        o.frequency.setValueAtTime(220, t);
        o.frequency.exponentialRampToValueAtTime(160, t + 0.1);
        o.connect(e);
        o.start(t);
        o.stop(t + 0.2);
      },
      hat(ch, t, level = 0.12, open = false) {
        S.noiseHit(ch, t, { type: 'highpass', freq: 7600, q: 0.6, level, decay: open ? 0.26 : 0.045 });
      },
      swell(ch, t, dur, level = 0.08) {
        // Filtered-noise riser.
        const e = ctx.createGain();
        e.gain.setValueAtTime(0.0001, t);
        e.gain.linearRampToValueAtTime(level, t + dur);
        e.gain.linearRampToValueAtTime(0.0001, t + dur + 0.2);
        e.connect(ch);
        const f = ctx.createBiquadFilter();
        f.type = 'bandpass';
        f.Q.value = 2;
        f.frequency.setValueAtTime(400, t);
        f.frequency.exponentialRampToValueAtTime(6000, t + dur);
        f.connect(e);
        const n = ctx.createBufferSource();
        n.buffer = noise;
        n.loop = true;
        n.connect(f);
        n.start(t);
        n.stop(t + dur + 0.3);
      },
    };
    return S;
  }

  function finish(buf, fadeOut = 1.5) {
    // Gentle fade-out at the very end, then normalise to -1 dBFS.
    const n = buf.length;
    const fo = Math.floor(fadeOut * SR);
    let peak = 0;
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < fo; i++) d[n - 1 - i] *= (i / fo) ** 2;
      for (let i = 0; i < 960; i++) d[i] *= i / 960;
      for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(d[i]));
    }
    const gain = peak > 0 ? 0.89 / peak : 1;
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < n; i++) d[i] *= gain;
    }
    return buf;
  }

  // ------------------------------------------------------------------ compositions
  const songs = {
    // D major, 84 BPM: warm pads, plucked arpeggios and a bell melody.
    'morning-light': () => {
      const beat = 60 / 84;
      const bar = beat * 4;
      const S = makeStudio(10 * bar + 5.5, 1201);
      S.setDelay(beat * 0.75);
      const padCh = S.channel({ gain: 0.9, rev: 0.35 });
      const arpCh = S.channel({ gain: 0.7, pan: -0.15, rev: 0.25, dly: 0.35 });
      const bellCh = S.channel({ gain: 0.85, pan: 0.15, rev: 0.45, dly: 0.25 });
      const bassCh = S.channel({ gain: 0.8, rev: 0.05 });
      const drumCh = S.channel({ gain: 0.7, rev: 0.12 });
      const C = {
        D: [50, 57, 64, 66, 69],
        A: [49, 57, 61, 64, 69],
        Bm: [47, 54, 62, 66, 69],
        G: [43, 50, 59, 62, 66],
        Em: [40, 52, 59, 62, 67],
        As: [45, 52, 57, 62, 64],
      };
      const prog = ['D', 'A', 'Bm', 'G', 'D', 'A', 'Bm', 'G', 'Em', 'As'];
      prog.forEach((k, i) => {
        const t = i * bar;
        S.pad(padCh, C[k], t, bar, { attack: i === 0 ? 1.6 : 0.5, release: 1.2, cutoff: 1500, level: 0.17 });
        // Arpeggio (8ths) over the upper chord tones.
        const tones = C[k].slice(1).map((m) => m + 12);
        const pat = [0, 1, 2, 3, 2, 1, 2, 3];
        for (let s = 0; s < 8; s++) {
          const vel = (i === 0 ? 0.35 + s * 0.06 : 0.75) * (s % 2 ? 0.8 : 1);
          S.pluck(arpCh, tones[pat[s]], t + s * beat * 0.5 + S.rnd() * 0.006, { level: 0.16 * vel, decay: 0.9 });
        }
        if (i >= 2) {
          const root = C[k][0] - 12 < 33 ? C[k][0] : C[k][0] - 12;
          S.bass(bassCh, root, t, beat * 1.5, { level: 0.28, cutoff: 260, type: 'triangle', q: 1 });
          S.bass(bassCh, root, t + beat * 2, beat * 1.5, { level: 0.24, cutoff: 260, type: 'triangle', q: 1 });
          S.kick(drumCh, t, 0.55);
          S.kick(drumCh, t + beat * 2, 0.45);
        }
        if (i >= 4) for (let s = 0; s < 8; s++) S.hat(drumCh, t + s * beat * 0.5, s % 2 ? 0.07 : 0.035);
        if (i >= 4 && i % 2 === 1) S.hat(drumCh, t + beat * 3, 0.08, true);
      });
      // Final chord.
      const end = prog.length * bar;
      S.pad(padCh, C.D, end, 2.5, { attack: 0.3, release: 2.5, cutoff: 1300, level: 0.18 });
      S.pluck(arpCh, 74, end, { level: 0.18, decay: 2 });
      S.bass(bassCh, 38, end, 2.5, { level: 0.26, cutoff: 240, type: 'triangle', q: 1 });
      S.kick(drumCh, end, 0.5);
      // Bell melody, bars 5-10 (+ final note): [bar, beat (1-based), length in beats, midi]
      const mel = [
        [5, 1, 1.5, 78], [5, 2.5, 0.5, 76], [5, 3, 1, 74], [5, 4, 1, 69],
        [6, 1, 2, 76], [6, 3, 1, 73], [6, 4, 1, 69],
        [7, 1, 1.5, 74], [7, 2.5, 0.5, 76], [7, 3, 1, 78], [7, 4, 1, 81],
        [8, 1, 2, 79], [8, 3, 1, 78], [8, 4, 1, 74],
        [9, 1, 1.5, 76], [9, 2.5, 0.5, 78], [9, 3, 1, 79], [9, 4, 1, 83],
        [10, 1, 2, 81], [10, 3, 0.5, 79], [10, 3.5, 0.5, 78], [10, 4, 1, 76],
        [11, 1, 4, 74],
      ];
      for (const [b, bt, len, m] of mel) S.bell(bellCh, m, (b - 1) * bar + (bt - 1) * beat, { decay: Math.max(1.4, len * beat * 1.6), level: 0.13 });
      return S;
    },

    // A minor, 100 BPM synthwave: four-on-the-floor, 8th-note bass, 16th arps and a saw lead.
    'night-drive': () => {
      const beat = 60 / 100;
      const bar = beat * 4;
      const S = makeStudio(12 * bar + 4.5, 2203);
      S.setDelay(beat * 0.75);
      const padCh = S.channel({ gain: 0.75, rev: 0.4 });
      const arpCh = S.channel({ gain: 0.55, pan: 0.2, rev: 0.2, dly: 0.4 });
      const leadCh = S.channel({ gain: 0.8, pan: -0.1, rev: 0.3, dly: 0.3 });
      const bassCh = S.channel({ gain: 0.85, rev: 0.02 });
      const kickCh = S.channel({ gain: 0.85, rev: 0.03 });
      const snCh = S.channel({ gain: 0.6, rev: 0.45 });
      const hatCh = S.channel({ gain: 0.6, pan: 0.25, rev: 0.08 });
      const C = {
        Am: { pad: [57, 60, 64, 69], root: 33, arp: [69, 72, 76, 81] },
        F: { pad: [53, 57, 60, 65], root: 29, arp: [65, 69, 72, 77] },
        C: { pad: [55, 60, 64, 67], root: 36, arp: [67, 72, 76, 79] },
        G: { pad: [55, 59, 62, 67], root: 31, arp: [67, 71, 74, 79] },
      };
      const prog = ['Am', 'F', 'C', 'G', 'Am', 'F', 'C', 'G', 'Am', 'F', 'C', 'G'];
      S.swell(padCh, bar, bar, 0.05);
      prog.forEach((k, i) => {
        const t = i * bar;
        const ch = C[k];
        S.pad(padCh, ch.pad, t, bar, { attack: i === 0 ? 1.8 : 0.25, release: 0.8, cutoff: i < 2 ? 900 : 1800, level: 0.16 });
        const pat = [0, 1, 2, 3, 2, 1, 2, 3, 0, 1, 2, 3, 3, 2, 1, 2];
        for (let s = 0; s < 16; s++) {
          const vel = i < 2 ? 0.4 + (i * 16 + s) / 64 : s % 4 === 0 ? 1 : 0.7;
          S.pluck(arpCh, ch.arp[pat[s]] + (s >= 12 && i % 2 ? 12 : 0), t + s * beat * 0.25, { type: 'square', level: 0.075 * vel, decay: 0.28, bright: i < 2 ? 1400 + i * 900 : 3000 });
        }
        if (i >= 2) {
          for (let s = 0; s < 8; s++) S.bass(bassCh, ch.root + 12 + (s % 2 ? 12 : 0), t + s * beat * 0.5, beat * 0.42, { level: 0.22, cutoff: 380 });
          for (let s = 0; s < 4; s++) S.kick(kickCh, t + s * beat, 0.8);
          S.snare(snCh, t + beat, 0.42);
          S.snare(snCh, t + beat * 3, 0.42);
          for (let s = 0; s < 8; s++) S.hat(hatCh, t + s * beat * 0.5, s % 2 ? 0.1 : 0.045, s === 7 && i % 4 === 3);
        }
      });
      const end = prog.length * bar;
      S.pad(padCh, C.Am.pad, end, 2, { attack: 0.2, release: 2.8, cutoff: 1500, level: 0.17 });
      S.kick(kickCh, end, 0.8);
      S.bass(bassCh, 33 + 12, end, 1.6, { level: 0.22, cutoff: 300 });
      S.hat(hatCh, end, 0.12, true);
      // Lead melody bars 5-12 + final note: [bar, beat, beats, midi]
      const mel = [
        [5, 1, 0.5, 69], [5, 1.5, 0.5, 72], [5, 2, 1.5, 76], [5, 3.5, 0.5, 74], [5, 4, 1, 72],
        [6, 1, 1.5, 69], [6, 2.5, 0.5, 72], [6, 3, 1, 77], [6, 4, 1, 76],
        [7, 1, 1.5, 76], [7, 2.5, 0.5, 79], [7, 3, 0.5, 76], [7, 3.5, 0.5, 74], [7, 4, 1, 72],
        [8, 1, 2, 74], [8, 3, 1, 71], [8, 4, 1, 67],
        [9, 1, 1, 81], [9, 2, 0.5, 79], [9, 2.5, 0.5, 76], [9, 3, 1, 81], [9, 4, 1, 84],
        [10, 1, 1.5, 84], [10, 2.5, 0.5, 81], [10, 3, 1, 77], [10, 4, 1, 81],
        [11, 1, 1.5, 79], [11, 2.5, 0.5, 76], [11, 3, 0.5, 79], [11, 3.5, 0.5, 81], [11, 4, 1, 79],
        [12, 1, 2, 83], [12, 3, 0.5, 81], [12, 3.5, 0.5, 79], [12, 4, 1, 76],
        [13, 1, 3, 81],
      ];
      for (const [b, bt, len, m] of mel) S.lead(leadCh, m, (b - 1) * bar + (bt - 1) * beat, len * beat * 0.92, { level: 0.1 });
      return S;
    },

    // E major, 70 BPM: slow pads, pentatonic bells and a soft heartbeat.
    'northern-lights': () => {
      const beat = 60 / 70;
      const bar = beat * 4;
      const S = makeStudio(8 * bar + 5, 3307);
      S.setDelay(beat * 1.5);
      const padCh = S.channel({ gain: 0.9, rev: 0.5 });
      const bellCh = S.channel({ gain: 0.8, rev: 0.6, dly: 0.45 });
      const subCh = S.channel({ gain: 0.7, rev: 0.05 });
      const shCh = S.channel({ gain: 0.5, rev: 0.7, pan: 0.3 });
      const chords = [
        [40, 52, 56, 59, 63, 66],
        [37, 49, 56, 59, 64, 68],
        [45, 52, 56, 61, 64, 71],
        [47, 54, 59, 61, 64, 66],
      ];
      const penta = [64, 66, 68, 71, 73, 76, 78, 80, 83];
      for (let i = 0; i < 8; i++) {
        const t = i * bar;
        const ch = chords[i % 4];
        S.pad(padCh, ch.slice(1), t, bar, { attack: i === 0 ? 2.5 : 1.2, release: 2.2, cutoff: 1000 + (i % 4) * 150, level: 0.16, type: i % 2 ? 'sawtooth' : 'triangle', width: 12 });
        if (i >= 2) {
          S.bass(subCh, ch[0], t, bar * 0.9, { level: 0.2, cutoff: 180, type: 'sine', q: 0.5 });
          S.kick(subCh, t, 0.32);
          S.kick(subCh, t + beat * 0.5, 0.18);
        }
        // Sparse bells: 3-6 notes per bar from the pentatonic scale.
        const n = 3 + Math.floor(S.rnd() * 4);
        let pos = 0;
        for (let k = 0; k < n && pos < 4; k++) {
          const m = penta[Math.floor(S.rnd() * penta.length)];
          S.bell(bellCh, m, t + pos * beat, { decay: 3.2, level: 0.1 + S.rnd() * 0.04, ratio: 3.01, index: 1.6 });
          pos += [0.5, 1, 1, 1.5][Math.floor(S.rnd() * 4)];
        }
        if (i % 2 === 0) S.bell(shCh, ch[ch.length - 1] + 24, t + beat * 2, { decay: 4, level: 0.05, ratio: 2, index: 0.8 });
      }
      const end = 8 * bar;
      S.pad(padCh, [52, 56, 59, 63, 66, 71], end, 1, { attack: 0.8, release: 3.2, cutoff: 1100, level: 0.17, type: 'triangle', width: 12 });
      S.bell(bellCh, 76, end, { decay: 4, level: 0.14, ratio: 3.01, index: 1.6 });
      S.bass(subCh, 40, end, 2.5, { level: 0.2, cutoff: 160, type: 'sine', q: 0.5 });
      return S;
    },

    // Soundtrack for the intro video (12 s): swelling pad, riser, chime at the logo reveal.
    intro: () => {
      const S = makeStudio(job.seconds, 4409);
      S.setDelay(0.42);
      const padCh = S.channel({ gain: 0.9, rev: 0.5 });
      const bellCh = S.channel({ gain: 0.85, rev: 0.55, dly: 0.35 });
      const subCh = S.channel({ gain: 0.8, rev: 0.1 });
      S.pad(padCh, [40, 52, 56, 59, 63, 66], 0, 6.5, { attack: 3.2, release: 3.5, cutoff: 1300, level: 0.2, width: 11 });
      S.swell(padCh, 1.2, 2.2, 0.06);
      S.kick(subCh, 3.4, 0.6);
      S.bass(subCh, 28, 3.4, 3, { level: 0.22, cutoff: 120, type: 'sine', q: 0.5 });
      [71, 76, 80, 83, 88].forEach((m, i) => S.bell(bellCh, m, 3.45 + i * 0.14, { decay: 3.4, level: 0.12, ratio: 3.01, index: 1.4 }));
      S.pad(padCh, [45, 52, 57, 61, 64, 68], 6.2, 3.2, { attack: 1.4, release: 2.6, cutoff: 1500, level: 0.16, width: 11 });
      S.bell(bellCh, 88, 7.6, { decay: 3.5, level: 0.07, ratio: 2, index: 0.8 });
      return S;
    },
  };

  async function encodeOpus(buf, bitrate) {
    const packets = [];
    let desc = null;
    let failure = null;
    const enc = new AudioEncoder({
      output: (chunk, meta) => {
        const b = new Uint8Array(chunk.byteLength);
        chunk.copyTo(b);
        packets.push({ data: b, ts: chunk.timestamp, dur: chunk.duration });
        const d = meta?.decoderConfig?.description;
        if (d && !desc) desc = d instanceof ArrayBuffer ? new Uint8Array(d) : new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
      },
      error: (e) => (failure = e),
    });
    enc.configure({ codec: 'opus', sampleRate: SR, numberOfChannels: 2, bitrate, opus: { frameDuration: 20000, complexity: 10 } });
    const N = buf.length;
    for (let off = 0; off < N; off += SR) {
      const n = Math.min(SR, N - off);
      const data = new Float32Array(n * 2);
      data.set(buf.getChannelData(0).subarray(off, off + n), 0);
      data.set(buf.getChannelData(1).subarray(off, off + n), n);
      const ad = new AudioData({ format: 'f32-planar', sampleRate: SR, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round((off * 1e6) / SR), data });
      enc.encode(ad);
      ad.close();
    }
    await enc.flush();
    enc.close();
    if (failure) throw failure;
    return {
      samples: N,
      head: desc ? b64(desc) : null,
      blob: b64(concat(packets.map((p) => p.data))),
      sizes: packets.map((p) => p.data.length),
      ts: packets.map((p) => p.ts),
    };
  }

  // ------------------------------------------------------------------ cover art
  function cover(id) {
    const W = 480;
    const c = document.createElement('canvas');
    c.width = c.height = W;
    const g = c.getContext('2d');
    const r = rng(id.length * 7919 + 13);
    const lin = (x0, y0, x1, y1, stops) => {
      const gr = g.createLinearGradient(x0, y0, x1, y1);
      stops.forEach(([o, col]) => gr.addColorStop(o, col));
      return gr;
    };
    const rad = (x, y, r0, r1, stops) => {
      const gr = g.createRadialGradient(x, y, r0, x, y, r1);
      stops.forEach(([o, col]) => gr.addColorStop(o, col));
      return gr;
    };
    if (id === 'morning-light') {
      g.fillStyle = lin(0, 0, 0, W, [[0, '#6f7ff0'], [0.45, '#f39bb8'], [0.75, '#ffc48f'], [1, '#ffe3b0']]);
      g.fillRect(0, 0, W, W);
      g.fillStyle = rad(W * 0.5, W * 0.66, 10, W * 0.5, [[0, 'rgba(255,250,220,0.95)'], [0.18, 'rgba(255,226,170,0.75)'], [1, 'rgba(255,200,150,0)']]);
      g.fillRect(0, 0, W, W);
      g.fillStyle = '#fff8e6';
      g.beginPath();
      g.arc(W * 0.5, W * 0.66, W * 0.1, 0, TAU);
      g.fill();
      const hills = [['#c97a9e', 0.7, 0.06], ['#9a5f93', 0.78, 0.05], ['#5b3f7a', 0.87, 0.04]];
      for (const [col, y, a] of hills) {
        g.fillStyle = col;
        g.beginPath();
        g.moveTo(0, W);
        for (let x = 0; x <= W; x += 8) g.lineTo(x, W * y + Math.sin(x * 0.012 + y * 20) * W * a + Math.sin(x * 0.031) * W * 0.012);
        g.lineTo(W, W);
        g.fill();
      }
    } else if (id === 'night-drive') {
      g.fillStyle = lin(0, 0, 0, W, [[0, '#140a2e'], [0.5, '#4a1460'], [0.62, '#d1367f'], [0.63, '#1a0b30'], [1, '#07040f']]);
      g.fillRect(0, 0, W, W);
      for (let i = 0; i < 90; i++) {
        g.fillStyle = `rgba(255,255,255,${0.2 + r() * 0.6})`;
        g.fillRect(r() * W, r() * W * 0.45, 1.5, 1.5);
      }
      const sy = W * 0.5;
      g.save();
      g.beginPath();
      g.arc(W / 2, sy, W * 0.22, 0, TAU);
      g.clip();
      g.fillStyle = lin(0, sy - W * 0.22, 0, sy + W * 0.22, [[0, '#ffe36e'], [0.6, '#ff7a59'], [1, '#e2337e']]);
      g.fillRect(0, 0, W, W);
      g.fillStyle = '#4a1460';
      for (let k = 0; k < 6; k++) g.fillRect(0, sy + k * 14 - 2, W, 3 + k * 1.6);
      g.restore();
      g.fillStyle = '#12082a';
      g.fillRect(0, W * 0.625, W, W);
      g.strokeStyle = 'rgba(255,80,200,0.75)';
      g.lineWidth = 1.6;
      for (let k = 0; k < 12; k++) {
        const y = W * 0.625 + ((k / 12) ** 2) * W * 0.375;
        g.beginPath();
        g.moveTo(0, y);
        g.lineTo(W, y);
        g.stroke();
      }
      for (let k = -10; k <= 10; k++) {
        g.beginPath();
        g.moveTo(W / 2 + k * 14, W * 0.625);
        g.lineTo(W / 2 + k * 70, W);
        g.stroke();
      }
    } else {
      g.fillStyle = lin(0, 0, 0, W, [[0, '#020617'], [0.6, '#0b2545'], [1, '#13406b']]);
      g.fillRect(0, 0, W, W);
      for (let i = 0; i < 160; i++) {
        g.fillStyle = `rgba(255,255,255,${0.15 + r() * 0.7})`;
        const s = r() < 0.1 ? 2 : 1.2;
        g.fillRect(r() * W, r() * W * 0.7, s, s);
      }
      g.globalCompositeOperation = 'lighter';
      g.filter = 'blur(6px)';
      const cols = [['rgba(61,255,168,', 0.75], ['rgba(34,211,238,', 0.55], ['rgba(167,139,250,', 0.4]];
      cols.forEach(([col, base], j) => {
        for (let x = -20; x < W + 20; x += 3) {
          const y = W * (0.25 + j * 0.08) + Math.sin(x * 0.011 + j * 1.7) * W * 0.09 + Math.sin(x * 0.027 + j) * W * 0.03;
          const h = W * (0.22 + 0.12 * Math.sin(x * 0.019 + j * 2.1));
          const a = 0.5 + 0.5 * Math.sin(x * 0.05 + j * 3);
          g.fillStyle = lin(0, y - h, 0, y + 8, [[0, `${col}0)`], [0.85, `${col}${(base * a).toFixed(3)})`], [1, `${col}0)`]]);
          g.fillRect(x, y - h, 3, h + 8);
        }
      });
      g.filter = 'none';
      g.globalCompositeOperation = 'source-over';
      g.fillStyle = '#04101f';
      g.beginPath();
      g.moveTo(0, W);
      for (let x = 0; x <= W; x += 6) g.lineTo(x, W * 0.8 - Math.abs(Math.sin(x * 0.009 + 1)) * W * 0.12 - Math.sin(x * 0.04) * 6);
      g.lineTo(W, W);
      g.fill();
    }
    // Subtle vignette + grain
    g.globalCompositeOperation = 'source-over';
    g.fillStyle = rad(W / 2, W / 2, W * 0.35, W * 0.75, [[0, 'rgba(0,0,0,0)'], [1, 'rgba(0,0,0,0.28)']]);
    g.fillRect(0, 0, W, W);
    const img = g.getImageData(0, 0, W, W);
    for (let i = 0; i < img.data.length; i += 4) {
      const n = (r() - 0.5) * 6;
      img.data[i] += n;
      img.data[i + 1] += n;
      img.data[i + 2] += n;
    }
    g.putImageData(img, 0, 0);
    return c.toDataURL('image/jpeg', 0.84).split(',')[1];
  }

  // ------------------------------------------------------------------ video
  async function video() {
    const { width: W, height: H, fps, seconds, bitrate } = job;
    const frames = Math.round(fps * seconds);
    const r = rng(777);
    const mk = (w, h) => {
      const cv = document.createElement('canvas');
      cv.width = w;
      cv.height = h;
      return [cv, cv.getContext('2d')];
    };
    const [main, g] = mk(W, H);
    // Static layers: sky, mountains.
    const [sky, sg] = mk(W, H);
    {
      const gr = sg.createLinearGradient(0, 0, 0, H);
      gr.addColorStop(0, '#02040d');
      gr.addColorStop(0.55, '#081a35');
      gr.addColorStop(0.82, '#0f3554');
      gr.addColorStop(1, '#14485f');
      sg.fillStyle = gr;
      sg.fillRect(0, 0, W, H);
    }
    const stars = Array.from({ length: 260 }, () => ({ x: r() * W, y: r() * H * 0.78, s: r() < 0.08 ? 2.2 : 1 + r(), a: 0.25 + r() * 0.7, f: 0.6 + r() * 2.4, p: r() * TAU }));
    const [mtn, mg] = mk(W, H);
    {
      const ridge = (base, amp, col, seed) => {
        const rr = rng(seed);
        const ks = Array.from({ length: 5 }, () => [0.002 + rr() * 0.012, rr() * TAU, rr()]);
        mg.fillStyle = col;
        mg.beginPath();
        mg.moveTo(0, H);
        for (let x = 0; x <= W; x += 4) {
          let y = 0;
          for (const [k, p, a] of ks) y += Math.sin(x * k + p) * a;
          mg.lineTo(x, H * base - Math.abs(y) * amp);
        }
        mg.lineTo(W, H);
        mg.fill();
      };
      ridge(0.86, 70, '#0a1c30', 11);
      ridge(0.93, 46, '#050d18', 12);
      const fog = mg.createLinearGradient(0, H * 0.75, 0, H);
      fog.addColorStop(0, 'rgba(40,120,150,0)');
      fog.addColorStop(1, 'rgba(10,30,45,0.5)');
      mg.fillStyle = fog;
      mg.fillRect(0, H * 0.75, W, H * 0.25);
    }
    // Aurora streak sprites (one per ribbon colour).
    const ribbons = [
      { rgb: [61, 255, 168], base: 0.34, amp: 0.07, k1: 0.009, w1: 0.35, k2: 0.023, w2: 0.6, h: 0.3, p: 0.4, a: 0.85 },
      { rgb: [34, 211, 238], base: 0.42, amp: 0.06, k1: 0.012, w1: -0.28, k2: 0.017, w2: 0.45, h: 0.24, p: 2.1, a: 0.6 },
      { rgb: [167, 139, 250], base: 0.27, amp: 0.05, k1: 0.007, w1: 0.22, k2: 0.029, w2: -0.5, h: 0.2, p: 4.2, a: 0.45 },
    ];
    for (const rb of ribbons) {
      const [cv, cg] = mk(1, 128);
      const gr = cg.createLinearGradient(0, 0, 0, 128);
      const [R, G, B] = rb.rgb;
      gr.addColorStop(0, `rgba(${R},${G},${B},0)`);
      gr.addColorStop(0.7, `rgba(${R},${G},${B},0.55)`);
      gr.addColorStop(0.9, `rgba(${Math.min(255, R + 60)},${Math.min(255, G + 40)},${Math.min(255, B + 40)},1)`);
      gr.addColorStop(1, `rgba(${R},${G},${B},0)`);
      cg.fillStyle = gr;
      cg.fillRect(0, 0, 1, 128);
      rb.sprite = cv;
    }
    const LW = W / 2;
    const LH = H / 2;
    const [aur, ag] = mk(LW, LH);
    const logo = {
      mark: new Path2D('M10 34c6-1 9-9 14-18 1.6-2.9 4.4-2.9 6 0 4 7.6 5.6 12.6 8 18'),
      bar: new Path2D('M16.5 27.5c4.2-1.4 9.8-1.6 15 0'),
    };
    const ease = (x) => 1 - (1 - Math.min(1, Math.max(0, x))) ** 3;

    function draw(t) {
      g.globalCompositeOperation = 'source-over';
      g.globalAlpha = 1;
      g.filter = 'none';
      g.drawImage(sky, 0, 0);
      for (const s of stars) {
        g.globalAlpha = s.a * (0.65 + 0.35 * Math.sin(t * s.f + s.p));
        g.fillStyle = '#fff';
        g.fillRect(s.x, s.y, s.s, s.s);
      }
      g.globalAlpha = 1;
      // Aurora (low-res layer, then blurred glow + crisp pass).
      ag.globalCompositeOperation = 'source-over';
      ag.clearRect(0, 0, LW, LH);
      ag.globalCompositeOperation = 'lighter';
      for (const rb of ribbons) {
        for (let x = -4; x < LW + 4; x += 2) {
          const X = x * 2;
          const yb = LH * rb.base + Math.sin(X * rb.k1 + t * rb.w1 + rb.p) * LH * rb.amp + Math.sin(X * rb.k2 + t * rb.w2) * LH * rb.amp * 0.45;
          const h = LH * rb.h * (0.55 + 0.45 * Math.sin(X * 0.004 + t * 0.4 + rb.p * 2));
          const inten = rb.a * (0.35 + 0.65 * (0.5 + 0.5 * Math.sin(X * 0.021 + t * 1.1 + rb.p))) * (0.6 + 0.4 * Math.sin(X * 0.0023 - t * 0.25));
          ag.globalAlpha = Math.max(0, Math.min(1, inten));
          ag.drawImage(rb.sprite, x, yb - h, 2.2, h * 1.12);
        }
      }
      ag.globalAlpha = 1;
      g.globalCompositeOperation = 'lighter';
      g.filter = 'blur(14px)';
      g.globalAlpha = 0.85;
      g.drawImage(aur, 0, 0, W, H);
      g.filter = 'blur(2px)';
      g.globalAlpha = 0.75;
      g.drawImage(aur, 0, 0, W, H);
      g.filter = 'none';
      g.globalAlpha = 1;
      g.globalCompositeOperation = 'source-over';
      g.drawImage(mtn, 0, 0);
      // Logo reveal.
      const p = ease((t - 3.2) / 1.5);
      if (p > 0) {
        const size = 168 * (0.86 + 0.14 * p);
        const cx = W / 2;
        const cy = H * 0.42 - (1 - p) * 10;
        g.save();
        g.globalAlpha = p;
        g.translate(cx - size / 2, cy - size / 2);
        g.scale(size / 48, size / 48);
        g.shadowColor = 'rgba(60,200,255,0.55)';
        g.shadowBlur = 40;
        const bg = g.createLinearGradient(4, 44, 44, 4);
        bg.addColorStop(0, '#2b6cf6');
        bg.addColorStop(0.5, '#18b6e8');
        bg.addColorStop(1, '#7be3c6');
        g.fillStyle = bg;
        g.beginPath();
        g.roundRect(3, 3, 42, 42, 11);
        g.fill();
        g.shadowBlur = 0;
        g.lineCap = 'round';
        g.lineJoin = 'round';
        const hg = g.createLinearGradient(8, 40, 40, 10);
        hg.addColorStop(0, 'rgba(255,255,255,0.95)');
        hg.addColorStop(1, 'rgba(255,255,255,0.55)');
        g.strokeStyle = hg;
        g.lineWidth = 4.2;
        g.stroke(logo.mark);
        g.strokeStyle = 'rgba(255,255,255,0.8)';
        g.lineWidth = 3;
        g.stroke(logo.bar);
        g.restore();
      }
      const q = ease((t - 4.6) / 1.4);
      if (q > 0) {
        g.save();
        g.globalAlpha = q;
        g.fillStyle = '#ffffff';
        g.textAlign = 'center';
        g.textBaseline = 'alphabetic';
        g.font = '600 64px "Inter Display", Inter, "Segoe UI", "DejaVu Sans", sans-serif';
        g.shadowColor = 'rgba(0,0,0,0.35)';
        g.shadowBlur = 18;
        g.fillText('Aurora OS', W / 2, H * 0.42 + 140 - (1 - q) * 14);
        g.restore();
      }
      const fadeIn = Math.min(1, t / 0.8);
      const fadeOut = Math.max(0, (t - (seconds - 1.1)) / 1.0);
      const black = Math.min(1, (1 - fadeIn) + fadeOut);
      if (black > 0) {
        g.fillStyle = `rgba(0,0,0,${black})`;
        g.fillRect(0, 0, W, H);
      }
    }

    const chunks = [];
    let failure = null;
    const enc = new VideoEncoder({
      output: (chunk) => {
        const b = new Uint8Array(chunk.byteLength);
        chunk.copyTo(b);
        chunks.push({ data: b, ts: chunk.timestamp, key: chunk.type === 'key' });
      },
      error: (e) => (failure = e),
    });
    enc.configure({ codec: 'vp09.00.10.08', width: W, height: H, bitrate, framerate: fps, latencyMode: 'quality' });
    for (let i = 0; i < frames; i++) {
      draw(i / fps);
      const vf = new VideoFrame(main, { timestamp: Math.round((i * 1e6) / fps), duration: Math.round(1e6 / fps) });
      enc.encode(vf, { keyFrame: i % (fps * 2) === 0 });
      vf.close();
      while (enc.encodeQueueSize > 6) await new Promise((res) => setTimeout(res, 2));
      if (failure) throw failure;
    }
    await enc.flush();
    enc.close();
    if (failure) throw failure;
    // Poster for sanity checks (frame at 10%).
    draw(seconds * 0.1);
    const S = songs.intro();
    const buf = finish(await S.ctx.startRendering(), 1.0);
    const audio = await encodeOpus(buf, job.audioBitrate);
    return {
      video: { blob: b64(concat(chunks.map((c) => c.data))), sizes: chunks.map((c) => c.data.length), ts: chunks.map((c) => c.ts), keys: chunks.map((c) => c.key) },
      audio,
      poster: main.toDataURL('image/jpeg', 0.8).split(',')[1],
    };
  }

  if (job.kind === 'video') return video();
  const S = songs[job.id]();
  const buf = finish(await S.ctx.startRendering());
  const enc = await encodeOpus(buf, job.bitrate);
  return { ...enc, art: cover(job.id) };
}

// =============================================================================================
// Ogg Opus muxer (RFC 7845) with Vorbis comments and METADATA_BLOCK_PICTURE cover art.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let k = 0; k < 8; k++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    t[i] = r >>> 0;
  }
  return t;
})();
function oggCrc(buf) {
  let crc = 0;
  for (let i = 0; i < buf.length; i++) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ buf[i]) & 0xff]) >>> 0;
  return crc >>> 0;
}

class OggWriter {
  constructor(serial) {
    this.serial = serial;
    this.seq = 0;
    this.segs = []; // { len, data, granule|null }
    this.pages = [];
    this.continued = false;
    this.first = true;
  }
  packet(data, granule, flush = false) {
    const n = Math.floor(data.length / 255);
    for (let i = 0; i <= n; i++) {
      const len = i < n ? 255 : data.length % 255;
      this.segs.push({ len, data: data.subarray(i * 255, i * 255 + len), granule: i === n ? granule : null });
      if (this.segs.length === 255) this.page(false);
    }
    if (flush) while (this.segs.length) this.page(false);
  }
  page(last) {
    const segs = this.segs.splice(0, 255);
    let granule = -1n;
    for (const s of segs) if (s.granule != null) granule = BigInt(s.granule);
    const flags = (this.continued ? 1 : 0) | (this.first ? 2 : 0) | (last && !this.segs.length ? 4 : 0);
    this.continued = segs.length > 0 && segs[segs.length - 1].len === 255;
    this.first = false;
    const body = Buffer.concat(segs.map((s) => Buffer.from(s.data)));
    const head = Buffer.alloc(27 + segs.length);
    head.write('OggS', 0, 'latin1');
    head[4] = 0;
    head[5] = flags;
    head.writeBigUInt64LE(BigInt.asUintN(64, granule), 6);
    head.writeUInt32LE(this.serial, 14);
    head.writeUInt32LE(this.seq++, 18);
    head.writeUInt32LE(0, 22);
    head[26] = segs.length;
    segs.forEach((s, i) => (head[27 + i] = s.len));
    const pg = Buffer.concat([head, body]);
    pg.writeUInt32LE(oggCrc(pg), 22);
    this.pages.push(pg);
  }
  end() {
    if (!this.segs.length) {
      // Mark the last written page as EOS.
      const pg = this.pages[this.pages.length - 1];
      pg[5] |= 4;
      pg.writeUInt32LE(0, 22);
      pg.writeUInt32LE(oggCrc(pg), 22);
    }
    while (this.segs.length) this.page(true);
    return Buffer.concat(this.pages);
  }
}

function opusHead(preSkip, channels = 2) {
  const b = Buffer.alloc(19);
  b.write('OpusHead', 0, 'latin1');
  b[8] = 1;
  b[9] = channels;
  b.writeUInt16LE(preSkip, 10);
  b.writeUInt32LE(48000, 12);
  b.writeInt16LE(0, 16);
  b[18] = 0;
  return b;
}

function pictureBlock(jpeg, w, h) {
  const mime = Buffer.from('image/jpeg');
  const desc = Buffer.from('Cover');
  const b = Buffer.alloc(32 + mime.length + desc.length);
  let o = 0;
  b.writeUInt32BE(3, o); // front cover
  b.writeUInt32BE(mime.length, (o += 4));
  mime.copy(b, (o += 4));
  b.writeUInt32BE(desc.length, (o += mime.length));
  desc.copy(b, (o += 4));
  o += desc.length;
  b.writeUInt32BE(w, o);
  b.writeUInt32BE(h, o + 4);
  b.writeUInt32BE(24, o + 8);
  b.writeUInt32BE(0, o + 12);
  b.writeUInt32BE(jpeg.length, o + 16);
  return Buffer.concat([b, jpeg]);
}

function opusTags(comments) {
  const vendor = Buffer.from('Aurora gen-media-samples (WebCodecs Opus)');
  const parts = [Buffer.from('OpusTags', 'latin1')];
  const u32 = (n) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n);
    return b;
  };
  parts.push(u32(vendor.length), vendor, u32(comments.length));
  for (const c of comments) {
    const s = Buffer.from(c, 'utf8');
    parts.push(u32(s.length), s);
  }
  return Buffer.concat(parts);
}

function preSkipOf(res) {
  if (res.head) {
    const h = Buffer.from(res.head, 'base64');
    if (h.length >= 12 && h.toString('latin1', 0, 8) === 'OpusHead') return h.readUInt16LE(10);
  }
  return 312; // libopus look-ahead at 48 kHz
}

function splitPackets(res) {
  const all = Buffer.from(res.blob, 'base64');
  const out = [];
  let o = 0;
  for (const n of res.sizes) {
    out.push(all.subarray(o, o + n));
    o += n;
  }
  return out;
}

function muxOgg(job, res) {
  const preSkip = preSkipOf(res);
  const w = new OggWriter(0x41555200 + job.track);
  w.packet(opusHead(preSkip), 0, true);
  const art = Buffer.from(res.art, 'base64');
  const comments = [
    `TITLE=${job.title}`,
    `ARTIST=${ARTIST}`,
    `ALBUMARTIST=${ARTIST}`,
    `ALBUM=${ALBUM}`,
    `TRACKNUMBER=${job.track}`,
    `TRACKTOTAL=${JOBS.filter((j) => j.kind === 'track').length}`,
    `DATE=${YEAR}`,
    `GENRE=${job.genre}`,
    `COMMENT=${COMMENT}`,
    `LICENSE=CC0-1.0`,
    `METADATA_BLOCK_PICTURE=${pictureBlock(art, 480, 480).toString('base64')}`,
  ];
  w.packet(opusTags(comments), 0, true);
  const packets = splitPackets(res);
  const total = preSkip + res.samples;
  let granule = preSkip;
  packets.forEach((p, i) => {
    granule += 960;
    const last = i === packets.length - 1;
    w.packet(p, last ? total : Math.min(granule, total), false);
    if ((i + 1) % 50 === 0 && !last) while (w.segs.length) w.page(false);
  });
  return w.end();
}

// =============================================================================================
// Minimal WebM (Matroska) muxer: VP9 + Opus, with Duration, SeekHead and Cues so it seeks well.
function vintSize(n) {
  for (let len = 1; len <= 8; len++) {
    if (n < 2 ** (7 * len) - 1) {
      const b = Buffer.alloc(len);
      let v = BigInt(n) | (1n << BigInt(7 * len));
      for (let i = len - 1; i >= 0; i--) {
        b[i] = Number(v & 0xffn);
        v >>= 8n;
      }
      return b;
    }
  }
  throw new Error('EBML size too large');
}
function idBytes(id) {
  const hex = id.toString(16);
  return Buffer.from(hex.length % 2 ? `0${hex}` : hex, 'hex');
}
function el(id, ...children) {
  const body = Buffer.concat(children.flat().map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(c))));
  return Buffer.concat([idBytes(id), vintSize(body.length), body]);
}
function uintBytes(v, width) {
  let n = BigInt(v);
  if (!width) {
    width = 1;
    while (n >> BigInt(8 * width) && width < 8) width++;
  }
  const b = Buffer.alloc(width);
  for (let i = width - 1; i >= 0; i--) {
    b[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return b;
}
const eUint = (id, v, width) => el(id, uintBytes(v, width));
const eStr = (id, s) => el(id, Buffer.from(s, 'utf8'));
const eFloat = (id, v) => {
  const b = Buffer.alloc(8);
  b.writeDoubleBE(v);
  return el(id, b);
};

function muxWebM(job, res) {
  const { width, height, fps, seconds, title } = job;
  const header = el(0x1a45dfa3, eUint(0x4286, 1), eUint(0x42f7, 1), eUint(0x42f2, 4), eUint(0x42f3, 8), eStr(0x4282, 'webm'), eUint(0x4287, 4), eUint(0x4285, 2));
  const preSkip = preSkipOf(res.audio);
  const info = el(0x1549a966, eUint(0x2ad7b1, 1000000), eStr(0x4d80, 'Aurora gen-media-samples'), eStr(0x5741, 'Aurora gen-media-samples'), eFloat(0x4489, seconds * 1000), eStr(0x7ba9, title));
  const tracks = el(
    0x1654ae6b,
    el(0xae, eUint(0xd7, 1), eUint(0x73c5, 1), eUint(0x83, 1), eUint(0x9c, 0), eStr(0x86, 'V_VP9'), eUint(0x23e383, Math.round(1e9 / fps)), el(0xe0, eUint(0xb0, width), eUint(0xba, height))),
    el(0xae, eUint(0xd7, 2), eUint(0x73c5, 2), eUint(0x83, 2), eUint(0x9c, 0), eStr(0x86, 'A_OPUS'), el(0x63a2, opusHead(preSkip)), eUint(0x56aa, Math.round((preSkip / 48000) * 1e9)), eUint(0x56bb, 80000000), el(0xe1, eFloat(0xb5, 48000), eUint(0x9f, 2))),
  );
  // Blocks, sorted by time (video first on ties).
  const vids = splitPackets(res.video).map((d, i) => ({ track: 1, ts: res.video.ts[i], key: res.video.keys[i], data: d }));
  const auds = splitPackets(res.audio).map((d, i) => ({ track: 2, ts: res.audio.ts[i], key: true, data: d }));
  const blocks = [...vids, ...auds].sort((a, b) => a.ts - b.ts || a.track - b.track);
  const clusters = [];
  let cur = null;
  for (const b of blocks) {
    if (!cur || (b.track === 1 && b.key)) {
      cur = { tc: Math.round(b.ts / 1000), blocks: [] };
      clusters.push(cur);
    }
    cur.blocks.push(b);
  }
  const clusterBufs = clusters.map((c) =>
    el(
      0x1f43b675,
      eUint(0xe7, c.tc),
      c.blocks.map((b) => {
        const rel = Math.round(b.ts / 1000) - c.tc;
        const hd = Buffer.alloc(4);
        hd[0] = 0x80 | b.track;
        hd.writeInt16BE(rel, 1);
        hd[3] = b.key ? 0x80 : 0;
        return el(0xa3, hd, b.data);
      }),
    ),
  );
  const seekHead = (pos) => el(0x114d9b74, ...[[0x1549a966, pos.info], [0x1654ae6b, pos.tracks], [0x1c53bb6b, pos.cues]].map(([id, p]) => el(0x4dbb, el(0x53ab, idBytes(id)), eUint(0x53ac, p, 8))));
  const shLen = seekHead({ info: 0, tracks: 0, cues: 0 }).length;
  const pos = { info: shLen, tracks: shLen + info.length };
  let off = pos.tracks + tracks.length;
  const clusterPos = clusterBufs.map((b) => {
    const p = off;
    off += b.length;
    return p;
  });
  pos.cues = off;
  const cues = el(
    0x1c53bb6b,
    clusters.map((c, i) => (c.blocks[0].track === 1 && c.blocks[0].key ? el(0xbb, eUint(0xb3, c.tc), el(0xb7, eUint(0xf7, 1), eUint(0xf1, clusterPos[i]))) : Buffer.alloc(0))),
  );
  const segment = el(0x18538067, seekHead(pos), info, tracks, clusterBufs, cues);
  return Buffer.concat([header, segment]);
}

// =============================================================================================
async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-mediagen-'));
  const mainJs = path.join(tmp, 'main.js');
  // WebCodecs needs a secure context: serve a blank file:// page.
  fs.writeFileSync(path.join(tmp, 'index.html'), '<!doctype html><meta charset="utf-8"><title>media samples</title><body></body>');
  fs.writeFileSync(
    mainJs,
    `const { app, BrowserWindow } = require('electron');
const path = require('path');
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.whenReady().then(() => {
  const w = new BrowserWindow({ show: false, width: 320, height: 200, webPreferences: { backgroundThrottling: false } });
  w.loadFile(path.join(__dirname, 'index.html'));
});`,
  );
  const app = await electron.launch({ executablePath: require('electron'), args: ['--no-sandbox', mainJs], timeout: 60000 });
  let total = 0;
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('load');
    page.on('console', (m) => console.log(`[page] ${m.text()}`));
    fs.mkdirSync(MUSIC_DIR, { recursive: true });
    fs.mkdirSync(VIDEOS_DIR, { recursive: true });
    for (const job of JOBS.filter((j) => only.includes(j.id))) {
      const t0 = Date.now();
      const res = await page.evaluate(studio, job);
      const isVideo = job.kind === 'video';
      const buf = isVideo ? muxWebM(job, res) : muxOgg(job, res);
      const file = path.join(isVideo ? VIDEOS_DIR : MUSIC_DIR, job.file);
      fs.writeFileSync(file, buf);
      total += buf.length;
      const dur = isVideo ? job.seconds : res.samples / 48000;
      console.log(`${job.file.padEnd(34)} ${dur.toFixed(1).padStart(5)} s  ${(buf.length / 1024).toFixed(0).padStart(5)} KB  ${Date.now() - t0} ms`);
      if (isVideo && arg('poster', '')) fs.writeFileSync(arg('poster', ''), Buffer.from(res.poster, 'base64'));
    }
    console.log(`total ${(total / 1024 / 1024).toFixed(2)} MB`);
  } finally {
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
