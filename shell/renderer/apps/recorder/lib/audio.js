// Voice Recorder audio helpers (renderer): decode, waveform peaks, encode a slice back to Opus/WebM.
//
//   decode(bytes)                     -> AudioBuffer (48 kHz)
//   peaks(buffer, n)                  -> Float32Array(n) of 0..1 (max |sample| per bucket, all channels)
//   encodeSlice(buffer, from, to)     -> { bytes: Uint8Array, ext: '.webm' | '.wav' }   (seconds; WebCodecs Opus when
//                                        available, 16-bit WAV otherwise)
//   fmtTime(sec, { tenths })          -> '1:05' / '1:02:05' / '0:05.3'
import { muxOpus } from './webm.js';

let ctx = null;
const audioCtx = () => (ctx ||= new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 }));

export async function decode(bytes) {
  const ab = bytes.buffer ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : bytes;
  return audioCtx().decodeAudioData(ab);
}

export function peaks(buffer, n) {
  const out = new Float32Array(n);
  if (!buffer || !buffer.length) return out;
  const chans = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) chans.push(buffer.getChannelData(c));
  const step = buffer.length / n;
  for (let i = 0; i < n; i++) {
    const s = Math.floor(i * step);
    const e = Math.min(buffer.length, Math.max(s + 1, Math.floor((i + 1) * step)));
    let m = 0;
    // sample at most ~400 points per bucket: long files stay fast
    const inc = Math.max(1, Math.floor((e - s) / 400));
    for (const d of chans) for (let j = s; j < e; j += inc) {
      const v = d[j] < 0 ? -d[j] : d[j];
      if (v > m) m = v;
    }
    out[i] = Math.min(1, m);
  }
  return out;
}

function wav(buffer, s, e) {
  const ch = buffer.numberOfChannels;
  const n = e - s;
  const out = new DataView(new ArrayBuffer(44 + n * ch * 2));
  const w = (o, txt) => [...txt].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF');
  out.setUint32(4, 36 + n * ch * 2, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  out.setUint32(16, 16, true);
  out.setUint16(20, 1, true);
  out.setUint16(22, ch, true);
  out.setUint32(24, buffer.sampleRate, true);
  out.setUint32(28, buffer.sampleRate * ch * 2, true);
  out.setUint16(32, ch * 2, true);
  out.setUint16(34, 16, true);
  w(36, 'data');
  out.setUint32(40, n * ch * 2, true);
  const data = [];
  for (let c = 0; c < ch; c++) data.push(buffer.getChannelData(c));
  let o = 44;
  for (let i = s; i < e; i++)
    for (let c = 0; c < ch; c++) {
      const v = Math.max(-1, Math.min(1, data[c][i]));
      out.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      o += 2;
    }
  return new Uint8Array(out.buffer);
}

export async function encodeSlice(buffer, from, to, { forceWav = false } = {}) {
  const rate = buffer.sampleRate;
  const s = Math.max(0, Math.min(buffer.length, Math.round(from * rate)));
  const e = Math.max(s + 1, Math.min(buffer.length, Math.round(to * rate)));
  const channels = Math.min(2, buffer.numberOfChannels);
  const ok =
    !forceWav &&
    typeof AudioEncoder === 'function' &&
    rate === 48000 &&
    (await AudioEncoder.isConfigSupported({ codec: 'opus', sampleRate: rate, numberOfChannels: channels, bitrate: 96000 }).then((r) => r.supported).catch(() => false));
  if (!ok) return { bytes: wav(buffer, s, e), ext: '.wav' };
  const frames = [];
  let description = null;
  let failure = null;
  const enc = new AudioEncoder({
    output: (chunk, meta) => {
      if (meta?.decoderConfig?.description && !description) description = new Uint8Array(meta.decoderConfig.description.buffer || meta.decoderConfig.description).slice();
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      frames.push({ data, timestamp: chunk.timestamp });
    },
    error: (err) => (failure = err),
  });
  enc.configure({ codec: 'opus', sampleRate: rate, numberOfChannels: channels, bitrate: 96000 });
  const CH = 4800; // 100 ms per AudioData
  for (let i = s; i < e; i += CH) {
    const n = Math.min(CH, e - i);
    const planes = new Float32Array(n * channels);
    for (let c = 0; c < channels; c++) planes.set(buffer.getChannelData(c).subarray(i, i + n), c * n);
    const ad = new AudioData({ format: 'f32-planar', sampleRate: rate, numberOfFrames: n, numberOfChannels: channels, timestamp: Math.round(((i - s) / rate) * 1e6), data: planes });
    enc.encode(ad);
    ad.close();
  }
  await enc.flush();
  enc.close();
  if (failure || !frames.length) return { bytes: wav(buffer, s, e), ext: '.wav' };
  // timestamps from 0, in order
  const t0 = frames[0].timestamp;
  for (const f of frames) f.timestamp -= t0;
  return { bytes: muxOpus({ frames, sampleRate: rate, channels, description, durationMs: ((e - s) / rate) * 1000 }), ext: '.webm' };
}

export function fmtTime(sec, { tenths = false, sep = '.' } = {}) {
  const v = Math.max(0, sec || 0);
  const whole = Math.floor(v);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  const base = h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
  return tenths ? `${base}${sep}${Math.floor((v - whole) * 10)}` : base;
}
