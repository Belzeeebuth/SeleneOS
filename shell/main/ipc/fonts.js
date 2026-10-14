'use strict';
// Fonts backend (app « Polices », renderer/apps/fonts): lists the fonts fontconfig knows, reads their details from
// the files themselves (OpenType name / OS/2 / post / head / maxp / fvar / cmap tables, parsed here for TrueType,
// CFF, collections, WOFF and WOFF2; no dependency), installs fonts for the current user and removes them.
// It never writes a system folder: installing is per user (~/.local/share/fonts), system-wide installs are out of scope.
//
//   fonts:list({ force })          -> { families: [Family], userDir, tool, generation }
//       tool: 'fontconfig' (fc-list), or 'scan' when fc-list is missing (the usual font folders are read here)
//       Family = { name, category, mono, user, system, langs, variable, styles: [Style] }
//         category: 'serif' | 'sans' | 'mono' | 'script' | 'decorative' | 'symbol' | 'other' (OS/2 PANOSE and IBM
//                   family class, post.isFixedPitch, fontconfig spacing, then the name: « Sans », « Mono »…)
//         user / system: some style lives in a user font folder (~/.local/share/fonts, ~/.fonts) / elsewhere
//         langs: the languages of interest fontconfig says the family covers (en fr de es it el ru uk ar he hi th ja ko zh)
//       Style  = { style, file, index, weight (CSS 1…1000), italic, oblique, stretch (CSS %), user, format
//                  ('truetype' | 'cff'), variable (a named instance), variation (CSS font-variation-settings | null) }
//       Families are grouped by their English (typographic) family name, sorted by name; styles by width, weight,
//       slant. The list is cached until a font is installed or removed here, or `force` is passed (fontconfig reads
//       the folders again: fonts copied by hand; fonts:changed is sent then too).
//   fonts:details(file, index = 0) -> Details (describe() below) + { file, ext, size, mtime, user, listed, installable,
//                                     installed, installedUser, faceList }
//       installed: 'same' (this file or the same version is installed) | 'other-version' | null; installedUser: the
//       installed copy is a user font; faceList: [{ index, family, style }] for a collection
//       Throws ENOTFONT (not a font: magic bytes / table directory), ETOOBIG (> 50 MB), ENOENT.
//   fonts:charmap(file, index = 0) -> [[first, last], …]  code point ranges the face maps to a glyph (cmap)
//   fonts:bytes(file, index = 0)   -> Uint8Array: the face as a standalone sfnt (one face cut out of a collection),
//                                     WOFF / WOFF2 as stored — for the FontFace API in the renderer
//   fonts:install(files, { replace }) -> { results: [{ file, status, dest, family, style, faces, code, message, existing }] }
//       faces: [{ index, family, weight, style, stretch }] (CSS descriptors, ranges for variable fonts)
//       status: 'installed' | 'replaced' | 'already' (same bytes already there) | 'conflict' (another file with this
//       name, or the same family and style, is installed: nothing written unless replace: true, which moves the old
//       file to the Trash first) | 'error' (code ENOTFONT, ETOOBIG, EUNSUPPORTED for WOFF, ENOENT, EINVAL…).
//       TrueType / OpenType / collections only (.ttf .otf .ttc .otc), checked by magic bytes + table directory,
//       50 MB at most, 64 files per call. Copied (temporary name, then rename) to
//       ~/.local/share/fonts/<family>/<file name>, then `fc-cache -f` on that folder.
//   fonts:uninstall(files)         -> { removed: [file], errors: [{ file, code, message }] }
//       Only files inside the user font folders (real path checked); moved to the Trash (XDG, like fs:trash),
//       the emptied family folder is removed, then `fc-cache -f` on the user font folder.
//   fonts:userDir                  -> absolute ~/.local/share/fonts
//   (+fonts:changed) { generation, installed?: [dest], removed?: [file] }   to every shell window
//
// module.exports.generation() is read by notepad.js / paint.js (notepad:fonts, paint:fonts) to drop their cached
// family lists after an install or a removal. module.exports.parse exposes the parser to the unit tests.
// Tests: FONTCONFIG_FILE points to shell/test/fixtures/fonts/fonts.conf (fixture fonts + the test HOME's fonts).
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { run, which } = require('../lib/exec');

const MAX_BYTES = 50 * 1024 * 1024;
const MAX_INSTALL = 64;
const FONT_EXT = ['.ttf', '.otf', '.ttc', '.otc', '.woff', '.woff2'];
const INSTALL_EXT = ['.ttf', '.otf', '.ttc', '.otc'];
const LANGS = ['en', 'fr', 'de', 'es', 'it', 'el', 'ru', 'uk', 'ar', 'he', 'hi', 'th', 'ja', 'ko', 'zh-cn', 'zh-tw'];

const HOME = os.homedir();
const USER_DIR = path.join(HOME, '.local', 'share', 'fonts');
const TRASH = path.join(HOME, '.local', 'share', 'Trash');

let generation = 1;
let listCache = null; // { gen, value }
let listPending = null;
const metaCache = new Map(); // `${file}#${face}` -> { key, value }

function err(message, code) {
  const e = new Error(message);
  e.code = code;
  return e;
}
const notFont = (m) => err(m || 'This file is not a font', 'ENOTFONT');

function userDirs() {
  const dirs = [USER_DIR, path.join(HOME, '.fonts')];
  const xdg = process.env.XDG_DATA_HOME;
  if (xdg && path.isAbsolute(xdg)) dirs.push(path.join(xdg, 'fonts'));
  return [...new Set(dirs.map((d) => path.resolve(d)))];
}
function inside(child, parent) {
  const rel = path.relative(parent, child);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}
const isUserPath = (p) => userDirs().some((d) => inside(path.resolve(p), d));
const extOf = (p) => path.extname(String(p || '')).toLowerCase();

function validPath(p) {
  if (typeof p !== 'string' || !p || p.length > 4096 || p.includes('\0') || !path.isAbsolute(p)) throw err('Invalid path', 'EINVAL');
  return path.resolve(p);
}
const faceOf = (index) => (Number.isInteger(index) && index > 0 ? index & 0xffff : 0);
const instanceOf = (index) => (Number.isInteger(index) && index > 0 ? index >>> 16 : 0);

// ------------------------------------------------------------------ binary readers
const T_TRUE = 0x00010000;
const T_true = 0x74727565; // 'true' (old Apple TrueType)
const T_OTTO = 0x4f54544f;
const T_TTCF = 0x74746366;
const T_WOFF = 0x774f4646;
const T_WOF2 = 0x774f4632;

function kindOf(tag) {
  if (tag === T_TRUE || tag === T_true) return 'truetype';
  if (tag === T_OTTO) return 'cff';
  if (tag === T_TTCF) return 'collection';
  if (tag === T_WOFF) return 'woff';
  if (tag === T_WOF2) return 'woff2';
  return null;
}

function bufferReader(buf) {
  return { size: buf.length, buf, read: async (off, len) => buf.subarray(Math.min(off, buf.length), Math.min(buf.length, off + len)) };
}
function fileReader(fh, size) {
  return {
    size,
    async read(off, len) {
      const n = Math.max(0, Math.min(len, size - off));
      const b = Buffer.alloc(n);
      let got = 0;
      while (got < n) {
        const { bytesRead } = await fh.read(b, got, n - got, off + got);
        if (!bytesRead) break;
        got += bytesRead;
      }
      return b.subarray(0, got);
    },
  };
}

// WOFF2 known table tags (index = the 6 low bits of a table entry's flags).
const WOFF2_TAGS = [
  'cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca', 'prep', 'CFF ', 'VORG', 'EBDT',
  'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC', 'JSTF', 'MATH',
  'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt', 'avar', 'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar',
  'gvar', 'hsty', 'just', 'lcar', 'mort', 'morx', 'opbd', 'prop', 'trak', 'Zapf', 'Silf', 'Glat', 'Gloc', 'Feat', 'Sill',
];

function base128(buf, pos) {
  let v = 0;
  for (let i = 0; i < 5; i++) {
    if (pos.p >= buf.length) throw notFont();
    const b = buf[pos.p++];
    if (i === 0 && b === 0x80) throw notFont();
    v = v * 128 + (b & 0x7f);
    if (v > 0xffffffff) throw notFont();
    if (!(b & 0x80)) return v;
  }
  throw notFont();
}
function u255(buf, pos) {
  const c = buf[pos.p++];
  if (c === 253) {
    const v = buf.readUInt16BE(pos.p);
    pos.p += 2;
    return v;
  }
  if (c === 255) return 253 + buf[pos.p++];
  if (c === 254) return 506 + buf[pos.p++];
  return c;
}

/**
 * Table directory of one face. rd = bufferReader | fileReader. Returns
 * { container: 'sfnt'|'collection'|'woff'|'woff2', flavor: 'truetype'|'cff', faces, face, tables: Map, table(tag) }.
 * Throws ENOTFONT when the bytes are not a font (magic, sizes, offsets out of the file).
 */
async function directory(rd, index = 0) {
  if (rd.size < 12) throw notFont();
  const head = await rd.read(0, 12);
  const container0 = kindOf(head.readUInt32BE(0));
  if (!container0) throw notFont();
  if (container0 === 'woff') return woffDirectory(rd);
  if (container0 === 'woff2') return woff2Directory(rd, index);
  let base = 0;
  let faces = 1;
  let face = 0;
  if (container0 === 'collection') {
    faces = head.readUInt32BE(8);
    if (!faces || faces > 4096) throw notFont();
    const offs = await rd.read(12, 4 * faces);
    if (offs.length < 4 * faces) throw notFont();
    face = Math.min(faceOf(index), faces - 1);
    base = offs.readUInt32BE(4 * face);
  }
  const off = await rd.read(base, 12);
  if (off.length < 12) throw notFont();
  const sfntVersion = off.readUInt32BE(0);
  const flavor = kindOf(sfntVersion);
  if (flavor !== 'truetype' && flavor !== 'cff') throw notFont();
  const n = off.readUInt16BE(4);
  if (!n || n > 1024) throw notFont();
  const recs = await rd.read(base + 12, 16 * n);
  if (recs.length < 16 * n) throw notFont();
  const tables = new Map();
  for (let i = 0; i < n; i++) {
    const o = 16 * i;
    const tag = recs.toString('latin1', o, o + 4);
    const offset = recs.readUInt32BE(o + 8);
    let length = recs.readUInt32BE(o + 12);
    if (offset > rd.size) throw notFont();
    if (offset + length > rd.size) length = rd.size - offset; // (a few fonts pad the last table past the end)
    tables.set(tag, { tag, offset, length, checksum: recs.readUInt32BE(o + 4) });
  }
  return {
    container: container0 === 'collection' ? 'collection' : 'sfnt',
    flavor: tables.has('CFF2') ? 'cff2' : flavor,
    sfntVersion,
    faces,
    face,
    tables,
    async table(tag) {
      const t = tables.get(tag);
      return t ? rd.read(t.offset, t.length) : null;
    },
    async range(tag, off, len) {
      const t = tables.get(tag);
      if (!t || off < 0 || off >= t.length) return null;
      return rd.read(t.offset + off, Math.min(len, t.length - off));
    },
  };
}

/** Part of a table: the sfnt reader reads only these bytes; WOFF / WOFF2 decompress the table first. */
async function tableRange(dir, tag, off, len) {
  if (dir.range) return dir.range(tag, off, len);
  const b = await dir.table(tag);
  if (!b || off < 0 || off >= b.length) return null;
  return b.subarray(off, Math.min(b.length, off + len));
}

async function woffDirectory(rd) {
  const hdr = await rd.read(0, 44);
  if (hdr.length < 44) throw notFont();
  const sfntVersion = hdr.readUInt32BE(4);
  const flavor = kindOf(sfntVersion);
  if (flavor !== 'truetype' && flavor !== 'cff') throw notFont();
  const n = hdr.readUInt16BE(12);
  if (!n || n > 1024) throw notFont();
  const recs = await rd.read(44, 20 * n);
  if (recs.length < 20 * n) throw notFont();
  const tables = new Map();
  for (let i = 0; i < n; i++) {
    const o = 20 * i;
    const tag = recs.toString('latin1', o, o + 4);
    const offset = recs.readUInt32BE(o + 4);
    const comp = recs.readUInt32BE(o + 8);
    const length = recs.readUInt32BE(o + 12);
    if (offset + comp > rd.size || comp > length || length > MAX_BYTES) throw notFont();
    tables.set(tag, { tag, offset, comp, length });
  }
  return {
    container: 'woff',
    flavor: tables.has('CFF2') ? 'cff2' : flavor,
    sfntVersion,
    faces: 1,
    face: 0,
    tables,
    async table(tag) {
      const t = tables.get(tag);
      if (!t) return null;
      const data = await rd.read(t.offset, t.comp);
      if (t.comp === t.length) return data;
      try {
        return zlib.inflateSync(data, { maxOutputLength: t.length });
      } catch {
        throw notFont();
      }
    },
  };
}

async function woff2Directory(rd, index) {
  if (rd.size > MAX_BYTES) throw err('Font file too large', 'ETOOBIG');
  const buf = rd.buf || (await rd.read(0, rd.size));
  if (buf.length < 48) throw notFont();
  const sfntVersion = buf.readUInt32BE(4);
  const n = buf.readUInt16BE(12);
  const compSize = buf.readUInt32BE(20);
  if (!n || n > 1024) throw notFont();
  const pos = { p: 48 };
  const all = [];
  for (let i = 0; i < n; i++) {
    if (pos.p >= buf.length) throw notFont();
    const flags = buf[pos.p++];
    let tag;
    if ((flags & 63) === 63) {
      tag = buf.toString('latin1', pos.p, pos.p + 4);
      pos.p += 4;
    } else tag = WOFF2_TAGS[flags & 63];
    if (!tag) throw notFont();
    const ver = flags >> 6;
    const origLength = base128(buf, pos);
    const transformed = tag === 'glyf' || tag === 'loca' ? ver !== 3 : ver !== 0;
    const length = transformed ? base128(buf, pos) : origLength;
    all.push({ tag, length, transformed });
  }
  let faces = 1;
  let face = 0;
  let pick = all.map((_, i) => i);
  let flavorTag = sfntVersion;
  if (sfntVersion === T_TTCF) {
    pos.p += 4; // collection version
    faces = u255(buf, pos);
    if (!faces || faces > 4096) throw notFont();
    face = Math.min(faceOf(index), faces - 1);
    for (let f = 0; f < faces; f++) {
      const count = u255(buf, pos);
      const fl = buf.readUInt32BE(pos.p);
      pos.p += 4;
      const idx = [];
      for (let k = 0; k < count; k++) idx.push(u255(buf, pos));
      if (f === face) {
        pick = idx;
        flavorTag = fl;
      }
    }
  }
  const flavor = kindOf(flavorTag);
  if (flavor !== 'truetype' && flavor !== 'cff') throw notFont();
  if (pos.p + compSize > buf.length) throw notFont();
  let data = null;
  const decompress = () => {
    if (data) return data;
    const total = all.reduce((s, t) => s + t.length, 0);
    if (total > 4 * MAX_BYTES) throw notFont();
    try {
      data = zlib.brotliDecompressSync(buf.subarray(pos.p, pos.p + compSize), { maxOutputLength: Math.max(total, 1) });
    } catch {
      throw notFont();
    }
    return data;
  };
  let offset = 0;
  for (const t of all) {
    t.offset = offset;
    offset += t.length;
  }
  const tables = new Map();
  for (const i of pick) if (all[i]) tables.set(all[i].tag, all[i]);
  return {
    container: 'woff2',
    flavor: tables.has('CFF2') ? 'cff2' : flavor,
    sfntVersion: flavorTag,
    faces,
    face,
    tables,
    async table(tag) {
      const t = tables.get(tag);
      if (!t || t.transformed) return null;
      const d = decompress();
      if (t.offset + t.length > d.length) throw notFont();
      return d.subarray(t.offset, t.offset + t.length);
    },
  };
}

// ------------------------------------------------------------------ tables
const MAC_ROMAN =
  'ÄÅÇÉÑÖÜáàâäãåçéèêëíìîïñóòôöõúùûü†°¢£§•¶ß®©™´¨≠ÆØ∞±≤≥¥µ∂∑∏π∫ªºΩæø¿¡¬√ƒ≈∆«»… ÀÃÕŒœ–—“”‘’÷◊ÿŸ⁄€‹›ﬁﬂ‡·‚„‰ÂÊÁËÈÍÎÏÌÓÔÒÚÛÙıˆ˜¯˘˙˚¸˝˛ˇ';

function decodeName(b, platform, encoding) {
  if (platform === 0 || (platform === 3 && (encoding === 0 || encoding === 1 || encoding === 10))) {
    const n = b.length & ~1;
    const sw = Buffer.alloc(n);
    for (let i = 0; i < n; i += 2) {
      sw[i] = b[i + 1];
      sw[i + 1] = b[i];
    }
    return sw.toString('utf16le');
  }
  if (platform === 1 && encoding === 0) {
    let s = '';
    for (const c of b) s += c < 128 ? String.fromCharCode(c) : MAC_ROMAN[c - 128];
    return s;
  }
  return null;
}

/** name table -> { [nameID]: string } in English when the font has it (Windows en-US first). */
function parseName(b) {
  const out = {};
  if (!b || b.length < 6) return out;
  const count = b.readUInt16BE(2);
  const strOff = b.readUInt16BE(4);
  const best = {};
  for (let i = 0; i < count; i++) {
    const o = 6 + 12 * i;
    if (o + 12 > b.length) break;
    const platform = b.readUInt16BE(o);
    const encoding = b.readUInt16BE(o + 2);
    const lang = b.readUInt16BE(o + 4);
    const id = b.readUInt16BE(o + 6);
    const len = b.readUInt16BE(o + 8);
    const off = b.readUInt16BE(o + 10);
    if (id > 25 && id < 256) continue;
    let score;
    if (platform === 3) score = lang === 0x0409 ? 5 : (lang & 0x3ff) === 0x09 ? 4 : 1;
    else if (platform === 0) score = 3;
    else if (platform === 1) score = lang === 0 ? 2 : 0;
    else continue;
    if (best[id] && best[id].score >= score) continue;
    const start = strOff + off;
    if (start + len > b.length) continue;
    const s = decodeName(b.subarray(start, start + len), platform, encoding);
    if (s == null) continue;
    const clean = s.replace(/\0/g, '').trim();
    if (!clean) continue;
    best[id] = { score, s: clean.slice(0, id === 13 ? 20000 : 2000) };
  }
  for (const [id, v] of Object.entries(best)) out[id] = v.s;
  return out;
}

function parseOS2(b) {
  if (!b || b.length < 68) return null;
  const panose = [...b.subarray(32, 42)];
  return {
    version: b.readUInt16BE(0),
    weightClass: b.readUInt16BE(4),
    widthClass: b.readUInt16BE(6),
    fsType: b.readUInt16BE(8),
    familyClass: b.readInt16BE(30),
    panose,
    vendorId: b.toString('latin1', 58, 62).replace(/[\0 ]+$/g, ''),
    fsSelection: b.readUInt16BE(62),
    firstChar: b.readUInt16BE(64),
    lastChar: b.readUInt16BE(66),
  };
}
function parsePost(b) {
  if (!b || b.length < 16) return null;
  return { italicAngle: b.readInt32BE(4) / 65536, fixedPitch: b.readUInt32BE(12) !== 0 };
}
function parseHead(b) {
  if (!b || b.length < 54) return null;
  const date = (o) => {
    const secs = b.readUInt32BE(o) * 4294967296 + b.readUInt32BE(o + 4);
    const ms = (secs - 2082844800) * 1000; // seconds since 1904-01-01
    return Number.isFinite(ms) && ms > 0 && ms < 4102444800000 ? ms : null;
  };
  return { revision: b.readInt32BE(4) / 65536, unitsPerEm: b.readUInt16BE(18), created: date(20), modified: date(28), macStyle: b.readUInt16BE(44) };
}
function parseFvar(b, names) {
  if (!b || b.length < 16) return null;
  const axesOff = b.readUInt16BE(4);
  const axisCount = b.readUInt16BE(8);
  const axisSize = b.readUInt16BE(10);
  const instCount = b.readUInt16BE(12);
  const instSize = b.readUInt16BE(14);
  if (axisSize < 20 || axisCount > 64) return null;
  const axes = [];
  for (let i = 0; i < axisCount; i++) {
    const o = axesOff + i * axisSize;
    if (o + 20 > b.length) return null;
    axes.push({
      tag: b.toString('latin1', o, o + 4),
      min: b.readInt32BE(o + 4) / 65536,
      def: b.readInt32BE(o + 8) / 65536,
      max: b.readInt32BE(o + 12) / 65536,
      hidden: !!(b.readUInt16BE(o + 16) & 1),
      name: names?.[b.readUInt16BE(o + 18)] || null,
    });
  }
  const instances = [];
  const start = axesOff + axisCount * axisSize;
  for (let i = 0; i < instCount && i < 512; i++) {
    const o = start + i * instSize;
    if (o + 4 + 4 * axisCount > b.length) break;
    const nameId = b.readUInt16BE(o);
    const coords = {};
    axes.forEach((a, k) => {
      coords[a.tag] = Math.round((b.readInt32BE(o + 4 + 4 * k) / 65536) * 1000) / 1000;
    });
    instances.push({ name: names?.[nameId] || null, nameId, coords });
  }
  return { axes, instances };
}
const numGlyphs = (b) => (b && b.length >= 6 ? b.readUInt16BE(4) : 0);

/** The cmap subtable to use: Unicode full repertoire first, then BMP, symbol, Mac Roman. */
function cmapBest(b) {
  if (!b || b.length < 4) return null;
  const n = b.readUInt16BE(2);
  let best = null;
  for (let i = 0; i < n; i++) {
    const o = 4 + 8 * i;
    if (o + 8 > b.length) break;
    const platform = b.readUInt16BE(o);
    const encoding = b.readUInt16BE(o + 2);
    const offset = b.readUInt32BE(o + 4);
    if (offset + 2 > b.length) continue;
    const format = b.readUInt16BE(offset);
    let rank = 0;
    if (platform === 3 && encoding === 10 && (format === 12 || format === 13)) rank = 9;
    else if (platform === 0 && (encoding === 4 || encoding === 6) && (format === 12 || format === 13)) rank = 8;
    else if (platform === 3 && encoding === 1 && format === 4) rank = 7;
    else if (platform === 0 && encoding <= 3 && format === 4) rank = 6;
    else if (platform === 3 && encoding === 0 && format === 4) rank = 5; // symbol
    else if (platform === 0 && format === 6) rank = 3;
    else if (platform === 1 && encoding === 0 && (format === 0 || format === 6)) rank = 2;
    if (rank && (!best || rank > best.rank)) best = { rank, offset, format, symbol: platform === 3 && encoding === 0 };
  }
  return best;
}

/** Calls fn(codePoint, glyphId) for every mapping of the subtable (format 12 / 13 groups: fnRange(first, last, gid)). */
function cmapWalk(b, best, fn, fnRange) {
  const o = best.offset;
  try {
    if (best.format === 4) {
      const segX2 = b.readUInt16BE(o + 6);
      const ends = o + 14;
      const starts = ends + segX2 + 2;
      const deltas = starts + segX2;
      const rOffs = deltas + segX2;
      for (let s = 0; s < segX2 / 2; s++) {
        const end = b.readUInt16BE(ends + 2 * s);
        const start = b.readUInt16BE(starts + 2 * s);
        const delta = b.readInt16BE(deltas + 2 * s);
        const ro = b.readUInt16BE(rOffs + 2 * s);
        if (start > end) continue;
        for (let c = start; c <= end && c !== 0xffff; c++) {
          let g;
          if (!ro) g = (c + delta) & 0xffff;
          else {
            const at = rOffs + 2 * s + ro + 2 * (c - start);
            if (at + 2 > b.length) break;
            g = b.readUInt16BE(at);
            if (g) g = (g + delta) & 0xffff;
          }
          if (fn(c, g) === false) return;
        }
      }
    } else if (best.format === 12 || best.format === 13) {
      const groups = b.readUInt32BE(o + 12);
      for (let i = 0; i < groups && i < 200000; i++) {
        const g = o + 16 + 12 * i;
        if (g + 12 > b.length) break;
        const a = b.readUInt32BE(g);
        const z = Math.min(b.readUInt32BE(g + 4), 0x10ffff);
        if (a > z) continue;
        if (fnRange(a, z, b.readUInt32BE(g + 8), best.format === 13) === false) return;
      }
    } else if (best.format === 6) {
      const first = b.readUInt16BE(o + 6);
      const count = b.readUInt16BE(o + 8);
      for (let i = 0; i < count; i++) if (fn(first + i, b.readUInt16BE(o + 10 + 2 * i)) === false) return;
    } else if (best.format === 0) {
      for (let c = 0; c < 256; c++) if (fn(c, b[o + 6 + c]) === false) return;
    }
  } catch {
    // truncated table: keep what was read
  }
}

/** cmap -> sorted, merged [[first, last], …] of code points mapped to a glyph other than .notdef. */
function parseCmap(b) {
  const best = cmapBest(b);
  if (!best) return [];
  const ranges = [];
  const add = (a, z) => {
    const last = ranges[ranges.length - 1];
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], z);
    else ranges.push([a, z]);
  };
  const cps = [];
  const groups = [];
  cmapWalk(
    b,
    best,
    (c, g) => {
      if (g) cps.push(c);
    },
    (a, z, gid, many) => {
      if (gid) groups.push([a, z]);
      else if (!many && a < z) groups.push([a + 1, z]);
    },
  );
  // Symbol fonts map U+F020–F0FF; text in U+0020–00FF reaches those glyphs too (HarfBuzz / FreeType do the same).
  if (best.symbol) for (const c of [...cps]) if (c >= 0xf020 && c <= 0xf0ff) cps.push(c - 0xf000);
  for (const c of cps) groups.push([c, c]);
  groups.sort((x, y) => x[0] - y[0]);
  for (const [a, z] of groups) add(a, z);
  return ranges;
}

/** Glyph ids of a few code points ({ [cp]: gid }, 0 = missing). */
function cmapGlyphs(b, list) {
  const best = cmapBest(b);
  const out = {};
  for (const c of list) out[c] = 0;
  if (!best) return out;
  const want = new Set(list.map((c) => (best.symbol && c < 0x100 ? c + 0xf000 : c)));
  const set = (c, g) => {
    const k = best.symbol && c >= 0xf000 && c <= 0xf0ff ? c - 0xf000 : c;
    if (k in out && !out[k]) out[k] = g;
  };
  cmapWalk(
    b,
    best,
    (c, g) => {
      if (want.has(c)) set(c, g);
    },
    (a, z, gid, many) => {
      for (const c of want) if (c >= a && c <= z) set(c, many ? gid : gid + (c - a));
    },
  );
  return out;
}

// ------------------------------------------------------------------ glyph shapes (TrueType outlines)
/** Contours ([[x, y], …] per contour) and bounds of a simple TrueType glyph; null for composite / empty glyphs. */
function glyphContours(g) {
  if (!g || g.length < 12) return null;
  const nc = g.readInt16BE(0);
  if (nc <= 0 || nc > 200) return null;
  const box = { xMin: g.readInt16BE(2), yMin: g.readInt16BE(4), xMax: g.readInt16BE(6), yMax: g.readInt16BE(8) };
  const ends = [];
  for (let i = 0; i < nc; i++) ends.push(g.readUInt16BE(10 + 2 * i));
  const np = ends[nc - 1] + 1;
  if (np > 4000) return null;
  let p = 10 + 2 * nc;
  p += 2 + g.readUInt16BE(p);
  const flags = new Uint8Array(np);
  for (let i = 0; i < np; ) {
    const f = g[p++];
    flags[i++] = f;
    if (f & 8) for (let r = g[p++]; r > 0 && i < np; r--) flags[i++] = f;
  }
  const coord = (short, same) => {
    const out = new Int32Array(np);
    let v = 0;
    for (let i = 0; i < np; i++) {
      const f = flags[i];
      if (f & short) {
        const d = g[p++];
        v += f & same ? d : -d;
      } else if (!(f & same)) {
        v += g.readInt16BE(p);
        p += 2;
      }
      out[i] = v;
    }
    return out;
  };
  const xs = coord(2, 16);
  const ys = coord(4, 32);
  if (p > g.length) return null;
  const contours = [];
  let start = 0;
  for (const e of ends) {
    const c = [];
    for (let i = start; i <= e && i < np; i++) c.push([xs[i], ys[i]]);
    if (c.length > 1) contours.push(c);
    start = e + 1;
  }
  return { contours, ...box };
}

/** Sorted x of the outline's crossings with the horizontal line y (off-curve points taken as polygon corners). */
function crossings(gl, y) {
  const xs = [];
  for (const c of gl.contours) {
    for (let i = 0; i < c.length; i++) {
      const [x1, y1] = c[i];
      const [x2, y2] = c[(i + 1) % c.length];
      if (y1 === y2) continue;
      if ((y >= y1 && y < y2) || (y >= y2 && y < y1)) xs.push(x1 + ((y - y1) * (x2 - x1)) / (y2 - y1));
    }
  }
  return xs.sort((a, b) => a - b);
}
/** Width covered by the outline on the horizontal line y (even-odd spans). */
function coverAt(gl, y) {
  const xs = crossings(gl, y);
  let w = 0;
  for (let i = 0; i + 1 < xs.length; i += 2) w += xs[i + 1] - xs[i];
  return w;
}

/**
 * Shape hints from the outlines of « n » and « l » (TrueType fonts only):
 *   foot  = width covered just above the baseline / width at 40 % of the « n » (≥ 1.45: foot serifs; ≤ 1.2: none)
 *   slant = lean of the « l » in degrees (a strongly leaning upright face is a script)
 */
async function shapeHints(dir) {
  if (!dir.tables.has('glyf') || !dir.tables.has('loca')) return null;
  try {
    const [cmap, head] = await Promise.all([dir.table('cmap'), dir.table('head')]);
    if (!cmap || !head || head.length < 54) return null;
    const longLoca = head.readInt16BE(50) === 1;
    const gids = cmapGlyphs(cmap, [0x6e, 0x6c]);
    const glyph = async (gid) => {
      if (!gid) return null;
      const sz = longLoca ? 4 : 2;
      const lo = await tableRange(dir, 'loca', gid * sz, 2 * sz);
      if (!lo || lo.length < 2 * sz) return null;
      const a = longLoca ? lo.readUInt32BE(0) : lo.readUInt16BE(0) * 2;
      const z = longLoca ? lo.readUInt32BE(4) : lo.readUInt16BE(2) * 2;
      if (z <= a || z - a > 65536) return null;
      return glyphContours(await tableRange(dir, 'glyf', a, z - a));
    };
    const [n, l] = await Promise.all([glyph(gids[0x6e]), glyph(gids[0x6c])]);
    const out = {};
    if (n) {
      const h = n.yMax - n.yMin;
      const mid = coverAt(n, n.yMin + h * 0.4);
      const foot = coverAt(n, n.yMin + Math.max(1, h * 0.03));
      if (h > 0 && mid > 0) out.foot = Math.round((foot / mid) * 100) / 100;
    }
    if (l) {
      const h = l.yMax - l.yMin;
      const center = (y) => {
        const xs = crossings(l, y);
        return xs.length ? (xs[0] + xs[xs.length - 1]) / 2 : null;
      };
      const lo = center(l.yMin + h * 0.3);
      const hi = center(l.yMin + h * 0.75);
      if (h > 0 && lo != null && hi != null) out.slant = Math.round((Math.atan2(hi - lo, h * 0.45) * 180) / Math.PI);
    }
    return out;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ classification
const CATS = ['serif', 'sans', 'mono', 'script', 'decorative', 'symbol', 'other'];
// Well-known families whose files carry no classification (no PANOSE / IBM class), by name.
const KNOWN_SERIF = /\broman\b|bookman|garamond|baskerville|caslon|bodoni|didot|palatino|\btimes\b|georgia|schoolbook|century|antiqua|minion|merriweather|\blora\b|crimson|playfair|charter|cambria|tinos|libertin|gentium|charis|\bc059\b|\bp052\b|\bdomine\b|\bspectral\b|\bcardo\b|\bvollkorn\b/i;
const KNOWN_SANS = /gothic|helvetica|arial|verdana|tahoma|segoe|ubuntu|cantarell|roboto|\binter\b|\blato\b|montserrat|raleway|arimo|carlito|futura|avenir|frutiger|myriad|hyperlegible|\bmanrope\b|poppins|nunito|\boxygen\b|\bcalibri\b|\bpt sans\b|\bsource sans\b/i;
const KNOWN_SCRIPT = /\bz003\b|pacifico|dancing|lobster|great vibes|parisienne|allura|caveat|satisfy|cookie|kaushan|yellowtail|courgette|handlee|amatic/i;

/**
 * Category of a family. In order: names (symbols, mono, « Sans », « Serif », script / display words), PANOSE and IBM
 * family class from OS/2, a few well-known names, then the outline hints (shapeHints), else 'other'.
 */
function classify({ name = '', panose = [], familyClass = 0, fixedPitch = false, mono = false, nolang = false, shape = null, italic = false } = {}) {
  if (/emoji|symbols?\b|dingbat|webdings|wingdings|icon|octicons|awesome|powerline|\bmath\b|ornaments?\b|\bd050000l\b/i.test(name)) return 'symbol';
  if (mono || fixedPitch || /\bmono\b|monospace|\bcode\b|console|courier|terminal|typewriter/i.test(name)) return 'mono';
  if (/\bsans\b|grotesk|grotesque/i.test(name)) return 'sans';
  if (/\bserif\b/i.test(name)) return 'serif';
  if (/script|handwrit|\bhand\b|brush|calligraph|cursive|chancery|marker|signature/i.test(name) || KNOWN_SCRIPT.test(name)) return 'script';
  if (/display|decorative|\bdeco\b|poster|stencil|blackletter|fraktur/i.test(name)) return 'decorative';
  if (nolang) return 'symbol';
  const ft = panose?.[0];
  if (ft === 3) return 'script';
  if (ft === 4) return 'decorative';
  if (ft === 5) return 'symbol';
  if (ft === 2) {
    if (panose[3] === 9) return 'mono';
    const s = panose[1];
    if (s >= 2 && s <= 10) return 'serif';
    if (s >= 11 && s <= 15) return 'sans';
  }
  const cls = (familyClass >> 8) & 0xff;
  if ([1, 2, 3, 4, 5, 7].includes(cls)) return 'serif';
  if (cls === 8) return 'sans';
  if (cls === 9) return 'decorative';
  if (cls === 10) return 'script';
  if (cls === 12) return 'symbol';
  if (KNOWN_SERIF.test(name)) return 'serif';
  if (KNOWN_SANS.test(name)) return 'sans';
  if (shape) {
    // an upright face whose « l » leans like an italic one is a script
    if (!italic && Math.abs(shape.slant || 0) >= 8) return 'script';
    if (shape.foot >= 1.45) return 'serif';
    if (shape.foot >= 0.85 && shape.foot <= 1.2) return 'sans';
  }
  return 'other';
}

function licenseKind(text = '', url = '') {
  const s = `${text}\n${url}`;
  if (/open font licen[cs]e|scripts\.sil\.org\/OFL|openfontlicense\.org|\bOFL\b/i.test(s)) return /1\.0\b/.test(s) && !/1\.1\b/.test(s) ? 'OFL-1.0' : 'OFL-1.1';
  if (/apache\.org\/licenses|apache license/i.test(s)) return 'Apache-2.0';
  if (/ubuntu font licen[cs]e/i.test(s)) return 'UFL-1.0';
  if (/bitstream vera|vera fonts/i.test(s)) return 'Bitstream-Vera';
  if (/GNU (Lesser |Library )?General Public License|gnu\.org\/licenses\/(l?gpl|agpl)|\bGPL\b/i.test(s)) return 'GPL';
  if (/creativecommons\.org|creative commons/i.test(s)) return 'CC';
  if (/\bMIT License\b|opensource\.org\/licenses\/MIT/i.test(s)) return 'MIT';
  if (/public domain/i.test(s)) return 'PD';
  return null;
}
function embedding(fsType) {
  const v = fsType & 0x000f;
  if (v === 0) return 'installable';
  if (v & 0x0008) return 'editable';
  if (v & 0x0004) return 'preview';
  if (v & 0x0002) return 'restricted';
  return 'installable';
}
function cleanVersion(v) {
  if (!v) return null;
  const m = /version\s*([0-9][^;\s]*)/i.exec(v) || /^([0-9][0-9.]*)/.exec(v);
  return (m ? m[1] : v).slice(0, 80);
}

/** Everything the app shows about one face of an opened directory. */
async function describe(dir) {
  const [name, os2b, postb, headb, maxpb, fvarb] = await Promise.all(['name', 'OS/2', 'post', 'head', 'maxp', 'fvar'].map((t) => dir.table(t).catch(() => null)));
  const n = parseName(name);
  const os2 = parseOS2(os2b);
  const post = parsePost(postb);
  const head = parseHead(headb);
  const fvar = parseFvar(fvarb, n);
  const shape = await shapeHints(dir);
  const family = n[16] || n[1] || null;
  const style = n[17] || n[2] || null;
  const fixedPitch = !!post?.fixedPitch;
  const italic = !!(os2 && os2.fsSelection & 1) || !!(head && head.macStyle & 2) || (post ? post.italicAngle !== 0 : false);
  return {
    container: dir.container,
    format: dir.flavor,
    faces: dir.faces,
    face: dir.face,
    family,
    style,
    fullName: n[4] || [family, style].filter(Boolean).join(' ') || null,
    postscriptName: n[6] || null,
    version: cleanVersion(n[5]) || (head ? head.revision.toFixed(3) : null),
    versionText: n[5] || null,
    copyright: n[0] || null,
    trademark: n[7] || null,
    manufacturer: n[8] || null,
    designer: n[9] || null,
    description: n[10] || null,
    vendorUrl: n[11] || null,
    designerUrl: n[12] || null,
    license: n[13] || null,
    licenseUrl: n[14] || null,
    licenseKind: licenseKind(n[13], n[14]),
    sampleText: n[19] || null,
    weightClass: os2?.weightClass ?? null,
    widthClass: os2?.widthClass ?? null,
    vendorId: os2?.vendorId || null,
    panose: os2?.panose || null,
    familyClass: os2?.familyClass ?? 0,
    embedding: os2 ? embedding(os2.fsType) : null,
    italic,
    fixedPitch,
    unitsPerEm: head?.unitsPerEm ?? null,
    created: head?.created ?? null,
    modified: head?.modified ?? null,
    glyphs: numGlyphs(maxpb),
    variable: !!fvar && fvar.axes.length > 0,
    axes: fvar?.axes || [],
    instances: fvar?.instances || [],
    color: dir.tables.has('COLR') || dir.tables.has('CBDT') || dir.tables.has('sbix') || dir.tables.has('SVG '),
    shape,
    category: classify({ name: `${family || ''} ${n[4] || ''}`, panose: os2?.panose, familyClass: os2?.familyClass, fixedPitch, shape, italic }),
  };
}

/** Structural check used before an install: a real face with the tables a renderer needs. */
async function validateFace(dir) {
  for (const t of ['cmap', 'head', 'name']) if (!dir.tables.has(t)) throw notFont();
  if (!['glyf', 'CFF ', 'CFF2'].some((t) => dir.tables.has(t)) && !['CBDT', 'sbix', 'SVG '].some((t) => dir.tables.has(t))) throw notFont();
  const head = await dir.table('head');
  if (!head || head.length < 54 || head.readUInt32BE(12) !== 0x5f0f3cf5) throw notFont();
}

// ------------------------------------------------------------------ files
async function statFont(file) {
  const abs = validPath(file);
  let st;
  try {
    st = await fsp.stat(abs);
  } catch (e) {
    throw err('File not found', e.code === 'ENOENT' ? 'ENOENT' : e.code || 'ENOENT');
  }
  if (!st.isFile()) throw err('Not a file', 'EINVAL');
  if (st.size > MAX_BYTES) throw err('Font file too large', 'ETOOBIG');
  return { abs, st };
}

/** Opens a font file, runs fn(directory, reader) with it, closes it. */
async function withFont(file, index, fn) {
  const { abs, st } = await statFont(file);
  const fh = await fsp.open(abs, 'r');
  try {
    const rd = fileReader(fh, st.size);
    const dir = await directory(rd, index);
    return await fn(dir, rd, { abs, st });
  } finally {
    await fh.close().catch(() => {});
  }
}

async function cachedMeta(file, index) {
  const { abs, st } = await statFont(file);
  const k = `${abs}#${faceOf(index)}`;
  const key = `${st.size}:${st.mtimeMs}`;
  const hit = metaCache.get(k);
  if (hit && hit.key === key) return hit.value;
  const value = await withFont(abs, index, (dir) => describe(dir));
  if (metaCache.size > 4000) metaCache.clear();
  metaCache.set(k, { key, value });
  return value;
}

/** A collection face (or any sfnt) as one standalone sfnt, for the FontFace API (Chromium's OTS reads one face). */
async function standalone(dir) {
  const tags = [...dir.tables.keys()].sort();
  const n = tags.length;
  let p2 = 1;
  let log = 0;
  while (p2 * 2 <= n) {
    p2 *= 2;
    log++;
  }
  const datas = [];
  for (const tag of tags) datas.push(await dir.table(tag));
  const headerLen = 12 + 16 * n;
  let size = headerLen;
  for (const d of datas) size += (d.length + 3) & ~3;
  if (size > MAX_BYTES * 2) throw err('Font file too large', 'ETOOBIG');
  const out = Buffer.alloc(size);
  out.writeUInt32BE(dir.sfntVersion, 0);
  out.writeUInt16BE(n, 4);
  out.writeUInt16BE(p2 * 16, 6);
  out.writeUInt16BE(log, 8);
  out.writeUInt16BE(n * 16 - p2 * 16, 10);
  let off = headerLen;
  tags.forEach((tag, i) => {
    const d = datas[i];
    const r = 12 + 16 * i;
    out.write(tag, r, 4, 'latin1');
    out.writeUInt32BE(dir.tables.get(tag).checksum || 0, r + 4);
    out.writeUInt32BE(off, r + 8);
    out.writeUInt32BE(d.length, r + 12);
    d.copy(out, off);
    off += (d.length + 3) & ~3;
  });
  return out;
}

// ------------------------------------------------------------------ listing
const FC_FIELDS = ['family', 'familylang', 'style', 'stylelang', 'file', 'index', 'spacing', 'weight', 'slant', 'width', 'variable', 'fontformat', 'lang'];
const FC_FORMAT = `${FC_FIELDS.map((f) => `%{${f}}`).join('\\t')}\\n`;
const FC_WEIGHTS = [
  [0, 100], [40, 200], [50, 300], [55, 350], [75, 380], [80, 400], [100, 500], [180, 600], [200, 700], [205, 800], [210, 900], [215, 1000],
];

function cssWeight(fc) {
  const v = Number(fc);
  if (!Number.isFinite(v)) return 400;
  if (v <= 0) return 100;
  for (let i = 1; i < FC_WEIGHTS.length; i++) {
    const [a, x] = FC_WEIGHTS[i - 1];
    const [b, y] = FC_WEIGHTS[i];
    if (v <= b) return Math.round(x + ((v - a) * (y - x)) / (b - a));
  }
  return 1000;
}
const firstNumber = (s) => {
  const m = /-?\d+(\.\d+)?/.exec(String(s || ''));
  return m ? Number(m[0]) : NaN;
};
function pickLang(values, langs) {
  const v = String(values || '').split(',');
  const l = String(langs || '').split(',');
  if (v.length === l.length) {
    const i = l.findIndex((x) => x === 'en' || x.startsWith('en-'));
    if (i >= 0 && v[i].trim()) return v[i].trim();
  }
  return (v[0] || '').trim();
}

function parseFcList(stdout) {
  const rows = [];
  const seen = new Set();
  for (const line of String(stdout || '').split('\n')) {
    if (!line) continue;
    const f = line.split('\t');
    if (f.length < FC_FIELDS.length) continue;
    const [family, familylang, style, stylelang, file, index, spacing, weight, slant, width, variable, fontformat, lang] = f;
    if (!file || !FONT_EXT.includes(extOf(file))) continue;
    if (fontformat && !/^(TrueType|CFF|CFF2)$/i.test(fontformat)) continue;
    const name = pickLang(family, familylang);
    if (!name || name.startsWith('.')) continue;
    const idx = Number(index) || 0;
    // (a variable font's default instance and the font as a whole share face index 0)
    const k = `${file}#${idx}#${variable}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const langSet = new Set(String(lang || '').split('|'));
    rows.push({
      family: name,
      style: pickLang(style, stylelang) || 'Regular',
      file,
      index: idx,
      spacing: Number(spacing) || 0,
      weight: cssWeight(firstNumber(weight)),
      weightRange: /^\[/.test(weight || ''),
      slant: Number(slant) || 0,
      stretch: Math.round(Number(width) || 100),
      variable: /^true$/i.test(variable || ''),
      format: /^CFF/i.test(fontformat || '') ? 'cff' : 'truetype',
      langs: LANGS.filter((l) => langSet.has(l)),
      nolang: !String(lang || '').trim(),
    });
  }
  return rows;
}

async function limitAll(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k], k).catch(() => null);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Rows (fontconfig or a scan) -> families. Reads one face per family (OS/2, post, fvar) for its category. */
async function buildFamilies(rows) {
  // A variable font is listed once as a whole (variable = True) and once per named instance: keep the instances.
  const hasInstances = new Set(rows.filter((r) => !r.variable && instanceOf(r.index) > 0).map((r) => r.file));
  const groups = new Map();
  for (const r of rows) {
    if (r.variable && hasInstances.has(r.file)) continue;
    const key = r.family.toLowerCase();
    if (!groups.has(key)) groups.set(key, { name: r.family, rows: [] });
    groups.get(key).rows.push(r);
  }
  const fams = [...groups.values()];
  const files = new Map();
  for (const f of fams) for (const r of f.rows) if (r.variable || instanceOf(r.index) > 0 || hasInstances.has(r.file)) files.set(`${r.file}#${faceOf(r.index)}`, r);
  const metas = new Map();
  await limitAll(
    fams.map((f) => f.rows),
    12,
    async (rs) => {
      const rep = representative(rs.map(toStyle));
      const m = await cachedMeta(rep.file, rep.index).catch(() => null);
      if (m) metas.set(`${rep.file}#${faceOf(rep.index)}`, m);
    },
  );
  // fvar coordinates of the named instances (variable fonts only)
  await limitAll([...files.values()], 8, async (r) => {
    const k = `${r.file}#${faceOf(r.index)}`;
    if (!metas.has(k)) {
      const m = await cachedMeta(r.file, r.index).catch(() => null);
      if (m) metas.set(k, m);
    }
  });
  const out = fams.map((f) => {
    const styles = f.rows.map((r) => {
      const s = toStyle(r);
      const m = metas.get(`${r.file}#${faceOf(r.index)}`);
      const inst = instanceOf(r.index);
      if (m?.variable) {
        s.variable = true;
        const coords = inst > 0 ? m.instances[inst - 1]?.coords : null;
        if (coords) s.variation = Object.entries(coords).map(([tag, v]) => `"${tag}" ${v}`).join(', ');
      }
      return s;
    });
    styles.sort((a, b) => (a.stretch === 100 ? 0 : 1) - (b.stretch === 100 ? 0 : 1) || a.stretch - b.stretch || a.weight - b.weight || a.slant - b.slant || a.style.localeCompare(b.style));
    const rep = representative(styles);
    const meta = metas.get(`${rep.file}#${faceOf(rep.index)}`);
    const mono = f.rows.some((r) => r.spacing >= 100);
    const langs = LANGS.filter((l) => f.rows.some((r) => r.langs.includes(l)));
    return {
      name: f.name,
      category: classify({
        name: f.name,
        panose: meta?.panose || [],
        familyClass: meta?.familyClass || 0,
        fixedPitch: meta?.fixedPitch,
        mono,
        nolang: f.rows.every((r) => r.nolang),
        shape: meta?.shape,
        italic: !!meta?.italic,
      }),
      mono: mono || !!meta?.fixedPitch,
      user: styles.some((s) => s.user),
      system: styles.some((s) => !s.user),
      langs,
      variable: styles.some((s) => s.variable),
      color: !!meta?.color,
      styles,
    };
  });
  out.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
  return out;
}

function toStyle(r) {
  return {
    style: r.style,
    file: r.file,
    index: r.index,
    weight: r.weight,
    italic: r.slant === 100,
    oblique: r.slant === 110,
    slant: r.slant,
    stretch: r.stretch,
    user: isUserPath(r.file),
    format: r.format,
    variable: false,
    variation: null,
  };
}
/** The style closest to Regular (weight 400, upright, normal width). */
function representative(styles) {
  let best = styles[0];
  let score = Infinity;
  for (const s of styles) {
    const v = Math.abs(s.weight - 400) + (s.slant ? 1000 : 0) + Math.abs(s.stretch - 100) * 10;
    if (v < score) {
      score = v;
      best = s;
    }
  }
  return best;
}

/** Without fontconfig: walk the usual folders and read each file's names (dev machines without fc-list). */
async function scanRows() {
  const roots = [...userDirs(), '/usr/share/fonts', '/usr/local/share/fonts'];
  const files = [];
  const walk = async (dir, depth) => {
    if (depth > 6 || files.length >= 3000) return;
    let ents = [];
    try {
      ents = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p, depth + 1);
      else if (e.isFile() && FONT_EXT.includes(extOf(e.name))) files.push(p);
    }
  };
  for (const r of roots) await walk(r, 0);
  const rows = [];
  await limitAll(files, 12, async (file) => {
    const first = await cachedMeta(file, 0);
    for (let face = 0; face < Math.min(first.faces, 64); face++) {
      const m = face ? await cachedMeta(file, face) : first;
      if (!m.family) continue;
      rows.push({
        family: m.family,
        style: m.style || 'Regular',
        file,
        index: face,
        spacing: m.fixedPitch ? 100 : 0,
        weight: m.weightClass || 400,
        slant: m.italic ? 100 : 0,
        stretch: [50, 62, 75, 87, 100, 112, 125, 150, 200][(m.widthClass || 5) - 1] || 100,
        variable: false,
        format: m.format === 'truetype' ? 'truetype' : 'cff',
        langs: ['en'], // (no fontconfig: languages unknown, shown as Latin text)
        nolang: false,
      });
    }
  });
  return rows;
}

async function listFonts(force) {
  if (!force && listCache && listCache.gen === generation) return listCache.value;
  if (listPending && !force) return listPending;
  const gen = generation;
  const p = (async () => {
    let tool = 'fontconfig';
    let rows;
    try {
      const res = await run('fc-list', ['--format', FC_FORMAT], { timeout: 30000 });
      if (res.code !== 0) throw err(res.stderr || 'fc-list failed', 'ECMD');
      rows = parseFcList(res.stdout);
    } catch (e) {
      if (e.code !== 'ENOENT') console.warn('[fonts] fc-list failed:', e.message);
      tool = 'scan';
      rows = await scanRows().catch(() => []);
    }
    const value = { families: await buildFamilies(rows), userDir: USER_DIR, tool, generation: gen };
    if (gen === generation) listCache = { gen, value };
    return value;
  })();
  listPending = p;
  try {
    return await p;
  } finally {
    if (listPending === p) listPending = null;
  }
}

// ------------------------------------------------------------------ install / uninstall
function safeDirName(family) {
  const s = String(family || '')
    .replace(/[\0/\\]/g, '-')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s-]+/, '')
    .trim()
    .slice(0, 80)
    .trim();
  return s || 'Fonts';
}
function safeFileName(name, ext) {
  let s = String(name || '')
    .replace(/[\0/\\]/g, '-')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/^[.\s]+/, '')
    .trim();
  if (!s || extOf(s) !== ext) s = `${s.replace(/\.[^.]*$/, '') || 'font'}${ext}`;
  if (s.length > 200) s = `${s.slice(0, 200 - ext.length)}${ext}`;
  return s;
}
async function sameBytes(a, buf) {
  try {
    const st = await fsp.stat(a);
    if (!st.isFile() || st.size !== buf.length) return false;
    const other = await fsp.readFile(a);
    return crypto.createHash('sha256').update(other).digest('hex') === crypto.createHash('sha256').update(buf).digest('hex');
  } catch {
    return false;
  }
}

function trashDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
/** XDG trash (same layout as fs.js fs:trash), so Fichiers can restore the file. */
async function toTrash(abs) {
  const files = path.join(TRASH, 'files');
  const info = path.join(TRASH, 'info');
  await fsp.mkdir(files, { recursive: true });
  await fsp.mkdir(info, { recursive: true });
  const base = path.basename(abs);
  const ext = path.extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;
  let name = base;
  for (let i = 2; i < 10000; i++) {
    const taken = await fsp.lstat(path.join(files, name)).then(() => true, () => false);
    const takenInfo = await fsp.lstat(path.join(info, `${name}.trashinfo`)).then(() => true, () => false);
    if (!taken && !takenInfo) break;
    name = `${stem} (${i})${ext}`;
  }
  const infoFile = path.join(info, `${name}.trashinfo`);
  await fsp.writeFile(infoFile, `[Trash Info]\nPath=${encodeURI(abs)}\nDeletionDate=${trashDate()}\n`);
  try {
    await fsp.rename(abs, path.join(files, name));
  } catch (e) {
    if (e.code !== 'EXDEV') {
      await fsp.rm(infoFile, { force: true });
      throw e;
    }
    await fsp.copyFile(abs, path.join(files, name));
    await fsp.rm(abs, { force: true });
  }
}

async function fcCache(dir) {
  if (!which('fc-cache')) return false;
  const res = await run('fc-cache', ['-f', dir], { timeout: 60000 }).catch(() => null);
  return !!res && res.code === 0;
}

const WIDTHS = [50, 62.5, 75, 87.5, 100, 112.5, 125, 150, 200];

/** CSS @font-face descriptors of a face: weight / stretch ranges for variable fonts. */
function cssDescriptors(d) {
  const axis = (tag) => d.axes?.find((a) => a.tag === tag);
  const wght = axis('wght');
  const wdth = axis('wdth');
  return {
    weight: wght ? `${wght.min} ${wght.max}` : String(d.weightClass || 400),
    style: d.italic ? 'italic' : 'normal',
    stretch: wdth ? `${wdth.min}% ${wdth.max}%` : `${WIDTHS[(d.widthClass || 5) - 1] || 100}%`,
  };
}

/** Family / style / CSS descriptors of every face in a font buffer (collections: each face). */
async function facesOf(buf) {
  const rd = bufferReader(buf);
  const first = await directory(rd, 0);
  const out = [];
  for (let i = 0; i < Math.min(first.faces, 256); i++) {
    const dir = i ? await directory(rd, i) : first;
    await validateFace(dir);
    const d = await describe(dir);
    out.push({ index: i, family: d.family, style: d.style, version: d.version, css: cssDescriptors(d) });
  }
  return out;
}

async function installOne(file, opts, touched) {
  const res = { file, status: 'error' };
  try {
    const { abs } = await statFont(file);
    const ext = extOf(abs);
    if (ext === '.woff' || ext === '.woff2') throw err('Web fonts (WOFF) can be previewed, not installed', 'EUNSUPPORTED');
    if (!INSTALL_EXT.includes(ext)) throw notFont();
    const buf = await fsp.readFile(abs);
    if (buf.length > MAX_BYTES) throw err('Font file too large', 'ETOOBIG');
    const magic = buf.length >= 4 ? kindOf(buf.readUInt32BE(0)) : null;
    const wantCollection = ext === '.ttc' || ext === '.otc';
    if (!magic || magic === 'woff' || magic === 'woff2' || (magic === 'collection') !== wantCollection) throw notFont();
    const faces = await facesOf(buf);
    if (!faces.length || !faces[0].family) throw notFont();
    res.family = faces[0].family;
    res.style = faces[0].style;
    res.faces = faces.filter((f) => f.family).map((f) => ({ index: f.index, family: f.family, ...f.css }));
    if (isUserPath(abs)) {
      res.status = 'already';
      res.dest = abs;
      return res;
    }
    const dir = path.join(USER_DIR, safeDirName(res.family));
    const dest = path.join(dir, safeFileName(path.basename(abs), ext));
    res.dest = dest;
    // The same bytes already at the destination?
    if (await sameBytes(dest, buf)) {
      res.status = 'already';
      return res;
    }
    // Conflicts: a file with this name, or another user file with the same family + style.
    const conflicts = [];
    if (await fsp.lstat(dest).then(() => true, () => false)) conflicts.push(dest);
    const list = await listFonts(false).catch(() => null);
    const want = new Set(faces.map((f) => `${(f.family || '').toLowerCase()}\n${(f.style || '').toLowerCase()}`));
    for (const fam of list?.families || []) {
      if (fam.name.toLowerCase() !== res.family.toLowerCase()) continue;
      for (const s of fam.styles) {
        if (!s.user || conflicts.includes(s.file)) continue;
        if (!want.has(`${fam.name.toLowerCase()}\n${s.style.toLowerCase()}`)) continue;
        if (await sameBytes(s.file, buf)) {
          res.status = 'already';
          res.dest = s.file;
          return res;
        }
        conflicts.push(s.file);
      }
    }
    if (conflicts.length && !opts.replace) {
      res.status = 'conflict';
      res.existing = conflicts;
      return res;
    }
    for (const c of conflicts) {
      if (!isUserPath(c)) continue;
      await toTrash(c).catch((e) => {
        throw err(`Could not move the installed file to the Trash: ${e.message}`, e.code || 'EIO');
      });
    }
    await fsp.mkdir(dir, { recursive: true, mode: 0o755 });
    const tmp = path.join(dir, `.${path.basename(dest)}.${process.pid}.${Date.now()}.part`);
    await fsp.writeFile(tmp, buf, { mode: 0o644 });
    try {
      await fsp.rename(tmp, dest);
    } catch (e) {
      await fsp.rm(tmp, { force: true });
      throw e;
    }
    touched.add(dir);
    res.status = conflicts.length ? 'replaced' : 'installed';
    return res;
  } catch (e) {
    res.status = 'error';
    res.code = e.code || 'EFAIL';
    res.message = String(e.message || e);
    return res;
  }
}

/**
 * Is this font (family + style) already installed? { state: 'same' (same file, or same version) | 'other-version' |
 * null, user: the installed copy is a user font }.
 */
async function installedState(d, abs, list) {
  const none = { state: null, user: false };
  if (!d.family) return none;
  const fam = list?.families.find((f) => f.name.toLowerCase() === d.family.toLowerCase());
  if (!fam) return none;
  const style = (d.style || 'Regular').toLowerCase();
  const matches = fam.styles.filter((s) => s.style.toLowerCase() === style);
  if (!matches.length) return none;
  const same = matches.find((s) => path.resolve(s.file) === abs);
  if (same) return { state: 'same', user: same.user };
  for (const s of matches) {
    const m = await cachedMeta(s.file, s.index).catch(() => null);
    if (m && m.version === d.version) return { state: 'same', user: s.user };
  }
  return { state: 'other-version', user: matches.some((s) => s.user) };
}

module.exports = function register(api) {
  const changed = (extra) => {
    generation++;
    listCache = null;
    api.broadcast('fonts:changed', { generation, ...extra });
  };

  api.handle('fonts:list', async (opts) => {
    const force = !!(opts && opts.force);
    if (!force) return listFonts(false);
    generation++;
    listCache = null;
    const value = await listFonts(true);
    api.broadcast('fonts:changed', { generation, refreshed: true });
    return value;
  });

  api.handle('fonts:userDir', () => USER_DIR);

  api.handle('fonts:details', async (file, index = 0) => {
    const idx = Number.isInteger(index) && index >= 0 ? index : 0;
    const { abs, st } = await statFont(file);
    const d = await withFont(abs, idx, (dir) => describe(dir));
    const list = await listFonts(false).catch(() => null);
    const listed = !!list?.families.some((f) => f.styles.some((s) => path.resolve(s.file) === abs));
    const inst = await installedState(d, abs, list);
    let faces = null;
    if (d.faces > 1) {
      faces = [];
      for (let i = 0; i < Math.min(d.faces, 64); i++) {
        const m = await cachedMeta(abs, i).catch(() => null);
        faces.push({ index: i, family: m?.family || null, style: m?.style || null });
      }
    }
    return {
      ...d,
      file: abs,
      ext: extOf(abs),
      size: st.size,
      mtime: st.mtimeMs,
      user: isUserPath(abs),
      listed,
      installable: INSTALL_EXT.includes(extOf(abs)),
      installed: listed ? 'same' : inst.state,
      installedUser: listed ? isUserPath(abs) : inst.user,
      faceList: faces,
    };
  });

  api.handle('fonts:charmap', async (file, index = 0) => {
    const idx = Number.isInteger(index) && index >= 0 ? index : 0;
    return withFont(file, idx, async (dir) => parseCmap(await dir.table('cmap')));
  });

  api.handle('fonts:bytes', async (file, index = 0) => {
    const idx = Number.isInteger(index) && index >= 0 ? index : 0;
    const { abs } = await statFont(file);
    if (!FONT_EXT.includes(extOf(abs))) throw notFont();
    const buf = await fsp.readFile(abs);
    const rd = bufferReader(buf);
    const dir = await directory(rd, idx);
    if (dir.container === 'woff' || dir.container === 'woff2') return new Uint8Array(buf);
    if (dir.container === 'sfnt') return new Uint8Array(buf);
    return new Uint8Array(await standalone(dir));
  });

  api.handle('fonts:install', async (files, opts) => {
    const list = (Array.isArray(files) ? files : [files]).slice(0, MAX_INSTALL);
    const o = { replace: !!(opts && opts.replace) };
    const touched = new Set();
    const results = [];
    for (const f of list) results.push(await installOne(f, o, touched));
    for (const dir of touched) await fcCache(dir);
    if (touched.size) changed({ installed: results.filter((r) => r.status === 'installed' || r.status === 'replaced').map((r) => r.dest) });
    return { results };
  });

  api.handle('fonts:uninstall', async (files) => {
    const removed = [];
    const errors = [];
    const dirs = new Set();
    for (const f of (Array.isArray(files) ? files : [files]).slice(0, 512)) {
      try {
        const abs = validPath(f);
        const real = await fsp.realpath(abs).catch(() => null);
        if (!real) throw err('File not found', 'ENOENT');
        const realDirs = await Promise.all(userDirs().map((d) => fsp.realpath(d).catch(() => d)));
        if (!realDirs.some((d) => inside(real, d)) || !isUserPath(abs)) throw err('Only fonts installed for you can be removed here', 'EPERM');
        const st = await fsp.lstat(abs);
        if (!st.isFile() || !FONT_EXT.includes(extOf(abs))) throw err('Not a font file', 'EINVAL');
        await toTrash(abs);
        removed.push(abs);
        dirs.add(path.dirname(abs));
      } catch (e) {
        errors.push({ file: f, code: e.code || 'EFAIL', message: String(e.message || e) });
      }
    }
    // remove the family folders left empty (never a user font root itself)
    for (const d of dirs) {
      if (userDirs().some((u) => path.resolve(u) === path.resolve(d))) continue;
      const left = await fsp.readdir(d).catch(() => null);
      if (left && left.every((n) => n === '.uuid')) await fsp.rm(d, { recursive: true, force: true }).catch(() => {});
    }
    if (removed.length) {
      for (const u of userDirs()) if (fs.existsSync(u)) await fcCache(u);
      changed({ removed });
      api.broadcast('fs:trash-changed', {});
    }
    return { removed, errors };
  });
};

module.exports.generation = () => generation;
module.exports.parse = { directory, describe, parseCmap, cmapGlyphs, parseName, classify, shapeHints, licenseKind, cssWeight, parseFcList, bufferReader, standalone, validateFace, MAC_ROMAN, CATS };
