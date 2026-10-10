// Media Player: metadata readers for the common audio containers (no DOM; Node-testable).
//
//   const tags = await readTags(reader, '.mp3');
//     reader = { size, read(offset, length) -> Promise<Uint8Array> }
//   -> { title, artist, album, albumArtist, track, year, genre, duration, picture: { mime, data } | null }
//
// Supported: ID3v2.2/2.3/2.4 (+ ID3v1 fallback) in MP3/AAC/WAV/FLAC, FLAC metadata blocks
// (Vorbis comments, PICTURE, STREAMINFO duration), Ogg Opus / Vorbis / FLAC comment headers
// (incl. METADATA_BLOCK_PICTURE), MP4/M4A iTunes atoms (ilst, covr, mvhd duration), RIFF WAVE
// LIST/INFO + fmt/data duration. Anything unknown or malformed yields an empty result, never throws.
const MAX_TAG = 16 * 1024 * 1024;

const GENRES = ['Blues', 'Classic Rock', 'Country', 'Dance', 'Disco', 'Funk', 'Grunge', 'Hip-Hop', 'Jazz', 'Metal', 'New Age', 'Oldies', 'Other', 'Pop', 'R&B', 'Rap', 'Reggae', 'Rock', 'Techno', 'Industrial', 'Alternative', 'Ska', 'Death Metal', 'Pranks', 'Soundtrack', 'Euro-Techno', 'Ambient', 'Trip-Hop', 'Vocal', 'Jazz+Funk', 'Fusion', 'Trance', 'Classical', 'Instrumental', 'Acid', 'House', 'Game', 'Sound Clip', 'Gospel', 'Noise', 'Alternative Rock', 'Bass', 'Soul', 'Punk', 'Space', 'Meditative', 'Instrumental Pop', 'Instrumental Rock', 'Ethnic', 'Gothic', 'Darkwave', 'Techno-Industrial', 'Electronic', 'Pop-Folk', 'Eurodance', 'Dream', 'Southern Rock', 'Comedy', 'Cult', 'Gangsta', 'Top 40', 'Christian Rap', 'Pop/Funk', 'Jungle', 'Native American', 'Cabaret', 'New Wave', 'Psychedelic', 'Rave', 'Showtunes', 'Trailer', 'Lo-Fi', 'Tribal', 'Acid Punk', 'Acid Jazz', 'Polka', 'Retro', 'Musical', 'Rock & Roll', 'Hard Rock'];

const latin1 = (u8) => {
  let s = '';
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return s;
};
const ascii = (u8, o, n) => latin1(u8.subarray(o, o + n));
const u32be = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const u32le = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const u16be = (b, o) => (b[o] << 8) | b[o + 1];
const syncsafe = (b, o) => ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f);
const startsWith = (b, s, o = 0) => b.length >= o + s.length && ascii(b, o, s.length) === s;
const utf8 = (u8) => new TextDecoder('utf-8').decode(u8);
const clean = (s) => (typeof s === 'string' ? s.replace(/\0+$/g, '').replace(/\0/g, ' ').trim() : s) || null;

function b64decode(s) {
  const bin = atob(String(s).replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function sniffMime(data, fallback = 'image/jpeg') {
  if (data[0] === 0x89 && data[1] === 0x50) return 'image/png';
  if (data[0] === 0xff && data[1] === 0xd8) return 'image/jpeg';
  if (startsWith(data, 'GIF8')) return 'image/gif';
  if (startsWith(data, 'RIFF') && startsWith(data, 'WEBP', 8)) return 'image/webp';
  return fallback;
}

function genreName(g) {
  if (!g) return null;
  const m = /^\(?(\d{1,3})\)?$/.exec(String(g).trim());
  if (m) return GENRES[Number(m[1])] || null;
  return String(g).replace(/^\(\d+\)/, '').trim() || null;
}
const yearOf = (s) => {
  const m = /(\d{4})/.exec(String(s || ''));
  return m ? Number(m[1]) : null;
};
const trackOf = (s) => {
  const n = parseInt(String(s || ''), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
};

// ------------------------------------------------------------------ ID3v2
function decodeText(u8, enc) {
  if (!u8.length) return '';
  try {
    if (enc === 0) return new TextDecoder('windows-1252').decode(u8);
    if (enc === 3) return utf8(u8);
    if (enc === 1) {
      if (u8[0] === 0xff && u8[1] === 0xfe) return new TextDecoder('utf-16le').decode(u8.subarray(2));
      if (u8[0] === 0xfe && u8[1] === 0xff) return new TextDecoder('utf-16be').decode(u8.subarray(2));
      return new TextDecoder('utf-16le').decode(u8);
    }
    if (enc === 2) return new TextDecoder('utf-16be').decode(u8);
  } catch {}
  return latin1(u8);
}
/** Index just past the encoded NUL terminator starting at `o`. */
function skipTerm(b, o, enc) {
  if (enc === 1 || enc === 2) {
    for (let i = o; i + 1 < b.length; i += 2) if (b[i] === 0 && b[i + 1] === 0) return [i, i + 2];
    return [b.length, b.length];
  }
  for (let i = o; i < b.length; i++) if (b[i] === 0) return [i, i + 1];
  return [b.length, b.length];
}
function unsync(b) {
  const out = new Uint8Array(b.length);
  let n = 0;
  for (let i = 0; i < b.length; i++) {
    out[n++] = b[i];
    if (b[i] === 0xff && b[i + 1] === 0x00) i++;
  }
  return out.subarray(0, n);
}

export function parseId3v2(buf) {
  if (!startsWith(buf, 'ID3') || buf.length < 10) return null;
  const ver = buf[3];
  if (ver < 2 || ver > 4) return null;
  const flags = buf[5];
  const size = syncsafe(buf, 6);
  let data = buf.subarray(10, 10 + size);
  if (flags & 0x80 && ver < 4) data = unsync(data);
  let pos = 0;
  if (flags & 0x40 && ver === 3) pos = u32be(data, 0) + 4;
  else if (flags & 0x40 && ver === 4) pos = syncsafe(data, 0);
  const out = {};
  const pics = [];
  const hdr = ver === 2 ? 6 : 10;
  while (pos + hdr <= data.length) {
    let id;
    let fsize;
    let fflags = 0;
    if (ver === 2) {
      id = ascii(data, pos, 3);
      fsize = (data[pos + 3] << 16) | (data[pos + 4] << 8) | data[pos + 5];
    } else {
      id = ascii(data, pos, 4);
      fsize = ver === 4 ? syncsafe(data, pos + 4) : u32be(data, pos + 4);
      fflags = u16be(data, pos + 8);
    }
    if (!/^[A-Z0-9]{3,4}$/.test(id) || fsize <= 0 || pos + hdr + fsize > data.length + 4) break;
    let body = data.subarray(pos + hdr, pos + hdr + fsize);
    pos += hdr + fsize;
    if (ver === 3 && fflags & 0x00c0) continue; // compressed / encrypted
    if (ver === 4) {
      if (fflags & 0x000c) continue;
      if (fflags & 0x0002) body = unsync(body);
      if (fflags & 0x0001) body = body.subarray(4);
    }
    const key = id.length === 3 ? { TT2: 'TIT2', TP1: 'TPE1', TAL: 'TALB', TP2: 'TPE2', TRK: 'TRCK', TYE: 'TYER', TCO: 'TCON', PIC: 'APIC', TLE: 'TLEN' }[id] || id : id;
    if (key[0] === 'T' && key !== 'TXXX') {
      const txt = clean(decodeText(body.subarray(1), body[0]).split('\0')[0]);
      if (!txt) continue;
      if (key === 'TIT2') out.title ??= txt;
      else if (key === 'TPE1') out.artist ??= txt;
      else if (key === 'TALB') out.album ??= txt;
      else if (key === 'TPE2') out.albumArtist ??= txt;
      else if (key === 'TRCK') out.track ??= trackOf(txt);
      else if (key === 'TYER' || key === 'TDRC' || key === 'TORY' || key === 'TDOR') out.year ??= yearOf(txt);
      else if (key === 'TCON') out.genre ??= genreName(txt);
      else if (key === 'TLEN') {
        const ms = Number(txt);
        if (ms > 0) out.duration ??= ms / 1000;
      }
    } else if (key === 'APIC') {
      const enc = body[0];
      let mime;
      let o;
      if (id === 'PIC') {
        const fmt = ascii(body, 1, 3).toUpperCase();
        mime = fmt === 'PNG' ? 'image/png' : 'image/jpeg';
        o = 4;
      } else {
        const [end, next] = skipTerm(body, 1, 0);
        mime = ascii(body, 1, end - 1).toLowerCase() || 'image/jpeg';
        if (!mime.includes('/')) mime = `image/${mime === 'jpg' ? 'jpeg' : mime}`;
        o = next;
      }
      const type = body[o];
      const [, after] = skipTerm(body, o + 1, enc);
      const pic = body.subarray(after);
      if (pic.length > 16) pics.push({ type, mime: sniffMime(pic, mime), data: pic });
    }
  }
  const pic = pics.find((p) => p.type === 3) || pics[0];
  if (pic) out.picture = { mime: pic.mime, data: pic.data };
  return out;
}

export function parseId3v1(tail) {
  if (tail.length < 128 || !startsWith(tail, 'TAG', tail.length - 128)) return null;
  const b = tail.subarray(tail.length - 128);
  const s = (o, n) => clean(new TextDecoder('windows-1252').decode(b.subarray(o, o + n)));
  const out = { title: s(3, 30), artist: s(33, 30), album: s(63, 30), year: yearOf(s(93, 4)) };
  if (b[125] === 0 && b[126]) out.track = b[126];
  if (b[127] < GENRES.length) out.genre = GENRES[b[127]];
  return out;
}

// ------------------------------------------------------------------ Vorbis comments / FLAC
export function parsePictureBlock(b) {
  try {
    let o = 0;
    const type = u32be(b, o);
    const ml = u32be(b, (o += 4));
    const mime = ascii(b, (o += 4), ml);
    const dl = u32be(b, (o += ml));
    o += 4 + dl + 16;
    const len = u32be(b, o);
    const data = b.subarray(o + 4, o + 4 + len);
    if (data.length < 16) return null;
    return { type, mime: sniffMime(data, mime || 'image/jpeg'), data };
  } catch {
    return null;
  }
}

export function parseVorbisComments(b, o = 0) {
  const out = {};
  const pics = [];
  try {
    const vl = u32le(b, o);
    o += 4 + vl;
    const n = u32le(b, o);
    o += 4;
    let coverArt = null;
    let coverMime = null;
    for (let i = 0; i < n && o + 4 <= b.length; i++) {
      const len = u32le(b, o);
      o += 4;
      if (o + len > b.length) break;
      const raw = b.subarray(o, o + len);
      o += len;
      const eq = raw.indexOf(0x3d);
      if (eq <= 0) continue;
      const key = ascii(raw, 0, eq).toUpperCase();
      if (key === 'METADATA_BLOCK_PICTURE') {
        const p = parsePictureBlock(b64decode(latin1(raw.subarray(eq + 1))));
        if (p) pics.push(p);
        continue;
      }
      const val = clean(utf8(raw.subarray(eq + 1)));
      if (!val) continue;
      if (key === 'COVERART') coverArt = val;
      else if (key === 'COVERARTMIME') coverMime = val;
      else if (key === 'TITLE') out.title ??= val;
      else if (key === 'ARTIST') out.artist ??= val;
      else if (key === 'ALBUM') out.album ??= val;
      else if (key === 'ALBUMARTIST' || key === 'ALBUM ARTIST') out.albumArtist ??= val;
      else if (key === 'TRACKNUMBER') out.track ??= trackOf(val);
      else if (key === 'DATE' || key === 'YEAR') out.year ??= yearOf(val);
      else if (key === 'GENRE') out.genre ??= genreName(val);
    }
    if (!pics.length && coverArt) {
      const data = b64decode(coverArt);
      pics.push({ type: 3, mime: sniffMime(data, coverMime || 'image/jpeg'), data });
    }
  } catch {}
  const pic = pics.find((p) => p.type === 3) || pics[0];
  if (pic) out.picture = { mime: pic.mime, data: pic.data };
  return out;
}

async function parseFlac(reader, start) {
  let o = start + 4;
  const out = {};
  for (let guard = 0; guard < 64 && o + 4 <= reader.size; guard++) {
    const h = await reader.read(o, 4);
    const last = h[0] & 0x80;
    const type = h[0] & 0x7f;
    const len = (h[1] << 16) | (h[2] << 8) | h[3];
    o += 4;
    if (type === 0 && len >= 18) {
      const b = await reader.read(o, 18);
      const rate = (b[10] << 12) | (b[11] << 4) | (b[12] >> 4);
      const total = (b[13] & 0x0f) * 2 ** 32 + u32be(b, 14);
      if (rate > 0 && total > 0) out.duration = total / rate;
    } else if (type === 4 && len < MAX_TAG) {
      Object.assign(out, { ...parseVorbisComments(await reader.read(o, len)), ...out });
    } else if (type === 6 && len < MAX_TAG && !out.picture) {
      const p = parsePictureBlock(await reader.read(o, len));
      if (p) out.picture = { mime: p.mime, data: p.data };
    }
    o += len;
    if (last) break;
  }
  return out;
}

// ------------------------------------------------------------------ Ogg
export function oggPackets(buf, max = 3) {
  const packets = [];
  let cur = [];
  let serial = null;
  let o = 0;
  while (o + 27 <= buf.length && packets.length < max) {
    if (!startsWith(buf, 'OggS', o)) break;
    const ser = u32le(buf, o + 14);
    const nseg = buf[o + 26];
    const lace = buf.subarray(o + 27, o + 27 + nseg);
    let p = o + 27 + nseg;
    if (serial === null) serial = ser;
    const mine = ser === serial;
    for (let i = 0; i < nseg; i++) {
      const len = lace[i];
      if (mine) cur.push(buf.subarray(p, p + len));
      p += len;
      if (mine && len < 255) {
        const total = cur.reduce((a, c) => a + c.length, 0);
        const pk = new Uint8Array(total);
        let q = 0;
        for (const c of cur) {
          pk.set(c, q);
          q += c.length;
        }
        packets.push(pk);
        cur = [];
        if (packets.length >= max) break;
      }
    }
    if (p > buf.length) return { packets, truncated: true };
    o = p;
  }
  return { packets, truncated: packets.length < max && o + 27 > buf.length };
}

async function parseOgg(reader) {
  let len = Math.min(reader.size, 256 * 1024);
  for (;;) {
    const buf = await reader.read(0, len);
    const { packets, truncated } = oggPackets(buf, 2);
    if (packets.length >= 2 || !truncated || len >= reader.size || len >= MAX_TAG) {
      const [id, com] = packets;
      if (!id || !com) return {};
      if (startsWith(id, 'OpusHead') && startsWith(com, 'OpusTags')) return parseVorbisComments(com, 8);
      if (id[0] === 1 && startsWith(id, 'vorbis', 1) && com[0] === 3) return parseVorbisComments(com, 7);
      if (id[0] === 0x7f && startsWith(id, 'FLAC', 1)) return parseVorbisComments(com, 4);
      return {};
    }
    len = Math.min(reader.size, len * 4, MAX_TAG);
  }
}

// ------------------------------------------------------------------ MP4 / M4A
function* atoms(b, start, end) {
  let o = start;
  while (o + 8 <= end) {
    let size = u32be(b, o);
    const type = ascii(b, o + 4, 4);
    let hdr = 8;
    if (size === 1) {
      size = u32be(b, o + 8) * 2 ** 32 + u32be(b, o + 12);
      hdr = 16;
    } else if (size === 0) size = end - o;
    if (size < hdr) return;
    yield { type, start: o + hdr, end: Math.min(end, o + size) };
    o += size;
  }
}

async function parseMp4(reader) {
  let o = 0;
  let moov = null;
  for (let guard = 0; guard < 64 && o + 8 <= reader.size; guard++) {
    const h = await reader.read(o, 16);
    let size = u32be(h, 0);
    const type = ascii(h, 4, 4);
    if (size === 1) size = u32be(h, 8) * 2 ** 32 + u32be(h, 12);
    else if (size === 0) size = reader.size - o;
    if (size < 8) break;
    if (type === 'moov') {
      if (size > 64 * 1024 * 1024) return {};
      moov = await reader.read(o, size);
      break;
    }
    o += size;
  }
  if (!moov) return {};
  const out = {};
  const find = (b, s, e, type) => {
    for (const a of atoms(b, s, e)) if (a.type === type) return a;
    return null;
  };
  const top = { start: 8, end: moov.length };
  const mvhd = find(moov, top.start, top.end, 'mvhd');
  if (mvhd) {
    const v = moov[mvhd.start];
    const ts = v === 1 ? u32be(moov, mvhd.start + 20) : u32be(moov, mvhd.start + 12);
    const dur = v === 1 ? u32be(moov, mvhd.start + 24) * 2 ** 32 + u32be(moov, mvhd.start + 28) : u32be(moov, mvhd.start + 16);
    if (ts > 0 && dur > 0) out.duration = dur / ts;
  }
  const udta = find(moov, top.start, top.end, 'udta');
  const meta = udta && find(moov, udta.start, udta.end, 'meta');
  if (!meta) return out;
  // 'meta' is a full box in ISO files (4 bytes version/flags) but not in some QuickTime files.
  const metaStart = ascii(moov, meta.start + 4, 4) === 'hdlr' ? meta.start : meta.start + 4;
  const ilst = find(moov, metaStart, meta.end, 'ilst');
  if (!ilst) return out;
  for (const it of atoms(moov, ilst.start, ilst.end)) {
    const data = find(moov, it.start, it.end, 'data');
    if (!data) continue;
    const kind = u32be(moov, data.start) & 0xffffff;
    const val = moov.subarray(data.start + 8, data.end);
    const text = () => clean(utf8(val));
    switch (it.type) {
      case '©nam':
        out.title ??= text();
        break;
      case '©ART':
        out.artist ??= text();
        break;
      case '©alb':
        out.album ??= text();
        break;
      case 'aART':
        out.albumArtist ??= text();
        break;
      case '©day':
        out.year ??= yearOf(text());
        break;
      case '©gen':
        out.genre ??= text();
        break;
      case 'gnre':
        if (val.length >= 2) out.genre ??= GENRES[u16be(val, 0) - 1] || null;
        break;
      case 'trkn':
        if (val.length >= 4) out.track ??= u16be(val, 2) || null;
        break;
      case 'covr':
        if (!out.picture && val.length > 16) out.picture = { mime: kind === 14 ? 'image/png' : sniffMime(val), data: val };
        break;
      default:
    }
  }
  return out;
}

// ------------------------------------------------------------------ WAV
async function parseWav(reader) {
  const out = {};
  let o = 12;
  let byteRate = 0;
  for (let guard = 0; guard < 64 && o + 8 <= reader.size; guard++) {
    const h = await reader.read(o, 8);
    const id = ascii(h, 0, 4);
    const size = u32le(h, 4);
    if (id === 'fmt ') {
      const f = await reader.read(o + 8, Math.min(size, 16));
      byteRate = u32le(f, 8);
    } else if (id === 'data') {
      if (byteRate > 0) out.duration = Math.min(size, reader.size - o - 8) / byteRate;
    } else if (id === 'LIST' && size < MAX_TAG) {
      const b = await reader.read(o + 8, size);
      if (ascii(b, 0, 4) === 'INFO') {
        let p = 4;
        while (p + 8 <= b.length) {
          const sid = ascii(b, p, 4);
          const sl = u32le(b, p + 4);
          const val = clean(utf8(b.subarray(p + 8, p + 8 + sl)));
          if (val) {
            if (sid === 'INAM') out.title ??= val;
            else if (sid === 'IART') out.artist ??= val;
            else if (sid === 'IPRD') out.album ??= val;
            else if (sid === 'ICRD') out.year ??= yearOf(val);
            else if (sid === 'IGNR') out.genre ??= val;
            else if (sid === 'ITRK' || sid === 'IPRT') out.track ??= trackOf(val);
          }
          p += 8 + sl + (sl & 1);
        }
      }
    } else if ((id === 'id3 ' || id === 'ID3 ') && size < MAX_TAG) {
      Object.assign(out, { ...(parseId3v2(await reader.read(o + 8, size)) || {}), ...out });
    }
    o += 8 + size + (size & 1);
  }
  return out;
}

// ------------------------------------------------------------------ entry point
export async function readTags(reader, ext = '') {
  const result = {};
  const merge = (src) => {
    for (const [k, v] of Object.entries(src || {})) if (result[k] == null && v != null && v !== '') result[k] = v;
  };
  try {
    if (!reader || !(reader.size > 0)) return result;
    const head = await reader.read(0, Math.min(reader.size, 64 * 1024));
    let off = 0;
    if (startsWith(head, 'ID3')) {
      const size = 10 + syncsafe(head, 6) + (head[5] & 0x10 ? 10 : 0);
      const buf = size <= head.length ? head : await reader.read(0, Math.min(size, MAX_TAG));
      merge(parseId3v2(buf));
      off = size;
    }
    const at = off ? await reader.read(off, 16) : head.subarray(0, 16);
    if (startsWith(at, 'fLaC')) merge(await parseFlac(reader, off));
    else if (startsWith(head, 'OggS')) merge(await parseOgg(reader));
    else if (startsWith(head, 'ftyp', 4)) merge(await parseMp4(reader));
    else if (startsWith(head, 'RIFF') && startsWith(head, 'WAVE', 8)) merge(await parseWav(reader));
    if ((ext === '.mp3' || ext === '.aac') && (!result.title || !result.artist) && reader.size > 128) {
      merge(parseId3v1(await reader.read(reader.size - 128, 128)));
    }
  } catch (err) {
    result.error = String(err?.message || err);
  }
  return result;
}

/** Reader over a URL that honours HTTP Range (the shell's media:// protocol does). */
export function urlReader(url, size) {
  const cache = { off: 0, buf: null };
  return {
    size,
    async read(off, len) {
      len = Math.max(0, Math.min(len, size - off));
      if (!len) return new Uint8Array(0);
      if (cache.buf && off >= cache.off && off + len <= cache.off + cache.buf.length) return cache.buf.subarray(off - cache.off, off - cache.off + len);
      const res = await fetch(url, { headers: { Range: `bytes=${off}-${off + len - 1}` } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      let b = new Uint8Array(await res.arrayBuffer());
      if (res.status === 200) b = b.subarray(off, off + len);
      if (len >= 4096) {
        cache.off = off;
        cache.buf = b;
      }
      return b;
    },
  };
}
