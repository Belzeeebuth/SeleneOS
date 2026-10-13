// Lyrics for the now playing view: a .lrc file next to the track (synced, "[mm:ss.xx] line"), or the lyrics embedded
// in the tags (ID3 USLT, Vorbis LYRICS, MP4 ©lyr: unsynced, or LRC text that parses as synced).
//   parseLrc(text) -> { synced, lines: [{ t, text }] }     lineAt(lines, seconds) -> index | -1
//   lrcPathOf('/m/a/01 Song.mp3') -> '/m/a/01 Song.lrc'
const STAMP = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;

export function parseLrc(text) {
  const src = String(text || '').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  let offset = 0;
  const off = /^\s*\[offset:\s*([+-]?\d+)\s*\]/im.exec(src);
  if (off) offset = Number(off[1]) / 1000;
  const timed = [];
  const plain = [];
  for (const raw of src.split('\n')) {
    const line = raw.trimEnd();
    STAMP.lastIndex = 0;
    const stamps = [];
    let m;
    let end = 0;
    while ((m = STAMP.exec(line)) && m.index === end) {
      const frac = m[3] ? Number(m[3]) / 10 ** m[3].length : 0;
      stamps.push(Number(m[1]) * 60 + Number(m[2]) + frac);
      end = STAMP.lastIndex;
    }
    const rest = line.slice(end).trim();
    if (stamps.length) for (const t of stamps) timed.push({ t: Math.max(0, t - offset), text: rest });
    else if (/^\s*\[[a-z]+:.*\]\s*$/i.test(line)) continue; // [ar:…] [ti:…] [length:…] header tags
    else plain.push(line.trim());
  }
  if (timed.length) {
    timed.sort((a, b) => a.t - b.t);
    return { synced: true, lines: timed };
  }
  while (plain.length && !plain[0]) plain.shift();
  while (plain.length && !plain[plain.length - 1]) plain.pop();
  return { synced: false, lines: plain.map((text) => ({ t: null, text })) };
}

/** Index of the line sung at `time` (the last line whose stamp is <= time), -1 before the first one. */
export function lineAt(lines, time) {
  let lo = 0;
  let hi = lines.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].t <= time + 0.05) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

export const lrcPathOf = (path) => String(path).replace(/\.[^./]+$/, '') + '.lrc';
