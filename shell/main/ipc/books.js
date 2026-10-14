'use strict';
// Livres (EPUB reader) backend: reads EPUB books in place, nothing is ever extracted to disk.
//
// An EPUB is a ZIP container. This module has its own small ZIP reader (end of central directory, ZIP64
// records, central directory, local headers; stored and deflated entries inflated with Node's built-in zlib —
// the async inflateRaw, so a big entry never blocks the main process), a tolerant XML parser, and the EPUB
// logic: META-INF/container.xml -> package document (OPF) -> metadata, manifest, spine, cover, table of
// contents (EPUB 3 nav document, else the EPUB 2 NCX), META-INF/encryption.xml (DRM detection, font
// de-obfuscation). Book content is untrusted: the renderer (apps/books/lib/content.js) cleans every chapter and
// shows it in a sandboxed frame without scripts.
//
//   books:open (path) -> Book
//     Book = { path, size, mtime, version, title, authors: [string], authorSort, language, identifier,
//              publisher, date, description, series, seriesIndex, direction: 'ltr'|'rtl'|'',
//              layout: 'reflowable'|'pre-paginated', cover: href|null, opf: href,
//              spine: [{ href, id, mediaType, linear, size }], toc: [TocItem], hasToc }
//     TocItem = { label, href, frag, spine (index in Book.spine, -1 if none), children: [TocItem] }
//     Every href is a full path inside the container, percent-decoded, without fragment.
//   books:resource (path, href) -> { data: Uint8Array, mime }
//     One file of the book (chapter, style sheet, image, font, audio / video). Obfuscated fonts (IDPF and
//     Adobe algorithms) are restored; encrypted files -> EDRM.
//   books:meta (path) -> { path, size, mtime, title, authors, authorSort, language, identifier, series,
//                         seriesIndex, spineCount, cover: { data, mime } | null }   (library cards)
//   books:scan (dirs, { depth = 1 }) -> [{ path, name, size, mtime }]
//     .epub files in these folders and their subfolders down to `depth` (0..2). Each folder must be inside
//     the home folder (a user folder that is a symbolic link to another disk counts as inside); hidden entries
//     are skipped; at most 500 results and 5000 directory entries per call.
//
// Errors (err.code): EINVAL (bad argument), ENOENT (no such book or file in the book), ETOOBIG (book over
//   500 MB, or an entry over 64 MB once inflated), EBADZIP (not a ZIP file, damaged, unsupported compression,
//   checksum mismatch), ENOTEPUB (no package document or reading order), EDRM (content documents encrypted:
//   Adobe ADEPT, Apple FairPlay, Readium LCP… listed in META-INF/encryption.xml).
// Limits: entry names that are absolute or contain '..' segments, backslashes or NUL are ignored (never
//   addressable); at most 20 000 entries; XML documents up to 8 MB; inflated sizes are capped with zlib's
//   maxOutputLength, so a ZIP bomb stops at the cap.
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const crypto = require('crypto');
const { promisify } = require('util');

const inflateRaw = promisify(zlib.inflateRaw);

const MAX_BOOK = 500 * 1024 * 1024;
const MAX_ENTRY = 64 * 1024 * 1024;
const MAX_XML = 8 * 1024 * 1024;
const MAX_ENTRIES = 20000;
const MAX_CD = 32 * 1024 * 1024;
const MAX_TOC = 5000;
const CACHE_MAX = 8;
const SCAN_MAX_RESULTS = 500;
const SCAN_MAX_ENTRIES = 5000;

const OBF_IDPF = 'http://www.idpf.org/2008/embedding';
const OBF_ADOBE = 'http://ns.adobe.com/pdf/enc#RC';

const MIME = {
  xhtml: 'application/xhtml+xml', xht: 'application/xhtml+xml', html: 'text/html', htm: 'text/html', xml: 'application/xml',
  css: 'text/css', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff',
  woff2: 'font/woff2', mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', oga: 'audio/ogg',
  opus: 'audio/ogg', wav: 'audio/wav', mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg',
  ncx: 'application/x-dtbncx+xml', opf: 'application/oebps-package+xml', smil: 'application/smil+xml',
  js: 'text/javascript', txt: 'text/plain', vtt: 'text/vtt',
};

function fail(message, code) {
  const e = new Error(message);
  e.code = code;
  e.quiet = true; // expected outcomes (damaged or protected books): not logged as IPC failures
  return e;
}

// ---------------------------------------------------------------- CRC-32 (zlib.crc32 when Node has it)
let crcTable = null;
function jsCrc32(buf) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
const crc32 = typeof zlib.crc32 === 'function' ? (b) => zlib.crc32(b) >>> 0 : jsCrc32;

// ---------------------------------------------------------------- ZIP reader
async function readAt(fh, pos, len) {
  const buf = Buffer.alloc(len); // zero-filled: a pooled buffer would leak memory to the renderer
  let off = 0;
  while (off < len) {
    const { bytesRead } = await fh.read(buf, off, len - off, pos + off);
    if (!bytesRead) break;
    off += bytesRead;
  }
  if (off < len) throw fail('Unexpected end of file', 'EBADZIP');
  return buf;
}

const utf8Strict = new TextDecoder('utf-8', { fatal: true });
function decodeName(raw, flags) {
  if (flags & 0x800) return raw.toString('utf8');
  try {
    return utf8Strict.decode(raw); // most EPUB tools write UTF-8 names without the flag
  } catch {
    return raw.toString('latin1');
  }
}

/** An entry name we accept: relative, no '..' segment, no backslash or NUL. */
function safeName(n) {
  if (!n || n.length > 1024 || n.includes('\0') || n.includes('\\') || n.startsWith('/')) return false;
  return !n.split('/').some((s) => s === '..');
}

async function readDirectory(fh, size) {
  if (size < 22) throw fail('Not a ZIP file', 'EBADZIP');
  const tailLen = Math.min(size, 22 + 0xffff + 20);
  const tailPos = size - tailLen;
  const tail = await readAt(fh, tailPos, tailLen);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail[i] === 0x50 && tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) <= tail.length) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw fail('Not a ZIP file (no end of central directory)', 'EBADZIP');
  let count = tail.readUInt16LE(eocd + 10);
  let cdSize = tail.readUInt32LE(eocd + 12);
  let cdOffset = tail.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    const loc = eocd - 20;
    if (loc < 0 || tail.readUInt32LE(loc) !== 0x07064b50) throw fail('Damaged ZIP64 archive', 'EBADZIP');
    const recPos = Number(tail.readBigUInt64LE(loc + 8));
    if (!(recPos >= 0 && recPos + 56 <= size)) throw fail('Damaged ZIP64 archive', 'EBADZIP');
    const rec = await readAt(fh, recPos, 56);
    if (rec.readUInt32LE(0) !== 0x06064b50) throw fail('Damaged ZIP64 archive', 'EBADZIP');
    count = Number(rec.readBigUInt64LE(32));
    cdSize = Number(rec.readBigUInt64LE(40));
    cdOffset = Number(rec.readBigUInt64LE(48));
  } else if (tail.readUInt16LE(eocd + 4) !== 0 || tail.readUInt16LE(eocd + 6) !== 0) {
    throw fail('Multi-part archives are not supported', 'EBADZIP');
  }
  if (count > MAX_ENTRIES) throw fail('Too many files in the archive', 'EBADZIP');
  if (cdSize > MAX_CD || cdOffset + cdSize > size || cdSize < count * 46) throw fail('Damaged central directory', 'EBADZIP');
  const cd = await readAt(fh, cdOffset, cdSize);
  const entries = new Map();
  const lower = new Map();
  let ignored = 0;
  let p = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) throw fail('Damaged central directory', 'EBADZIP');
    const flags = cd.readUInt16LE(p + 8);
    const method = cd.readUInt16LE(p + 10);
    const crc = cd.readUInt32LE(p + 16);
    let csize = cd.readUInt32LE(p + 20);
    let usize = cd.readUInt32LE(p + 24);
    const nlen = cd.readUInt16LE(p + 28);
    const xlen = cd.readUInt16LE(p + 30);
    const clen = cd.readUInt16LE(p + 32);
    let offset = cd.readUInt32LE(p + 42);
    const end = p + 46 + nlen + xlen + clen;
    if (end > cd.length) throw fail('Damaged central directory', 'EBADZIP');
    const name = decodeName(cd.subarray(p + 46, p + 46 + nlen), flags);
    // ZIP64 extended information (sizes / offset that do not fit in 32 bits)
    let x = p + 46 + nlen;
    const xend = x + xlen;
    while (x + 4 <= xend) {
      const id = cd.readUInt16LE(x);
      const len = cd.readUInt16LE(x + 2);
      if (id === 0x0001) {
        let q = x + 4;
        const lim = Math.min(xend, q + len);
        if (usize === 0xffffffff && q + 8 <= lim) {
          usize = Number(cd.readBigUInt64LE(q));
          q += 8;
        }
        if (csize === 0xffffffff && q + 8 <= lim) {
          csize = Number(cd.readBigUInt64LE(q));
          q += 8;
        }
        if (offset === 0xffffffff && q + 8 <= lim) offset = Number(cd.readBigUInt64LE(q));
      }
      x += 4 + len;
    }
    p = end;
    if (name.endsWith('/')) continue; // folder
    if (!safeName(name)) {
      ignored++;
      continue;
    }
    const e = { name, flags, method, crc, csize, usize, offset };
    if (!entries.has(name)) entries.set(name, e);
    const lc = name.toLowerCase();
    if (!lower.has(lc)) lower.set(lc, e);
  }
  return { entries, lower, ignored };
}

async function readEntry(fh, size, e, cap = MAX_ENTRY) {
  if (e.flags & 1) throw fail('This file of the book is encrypted', 'EDRM');
  if (e.usize > cap) throw fail('A file of the book is too large', 'ETOOBIG');
  if (e.offset + 30 > size) throw fail('Damaged ZIP entry', 'EBADZIP');
  const lh = await readAt(fh, e.offset, 30);
  if (lh.readUInt32LE(0) !== 0x04034b50) throw fail('Damaged ZIP entry', 'EBADZIP');
  const start = e.offset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
  if (start + e.csize > size) throw fail('Damaged ZIP entry', 'EBADZIP');
  const raw = e.csize ? await readAt(fh, start, e.csize) : Buffer.alloc(0);
  let data;
  if (e.method === 0) data = raw;
  else if (e.method === 8) {
    try {
      data = await inflateRaw(raw, { maxOutputLength: Math.max(1, Math.min(cap, e.usize)) });
    } catch (err) {
      if (err?.code === 'ERR_BUFFER_TOO_LARGE') throw fail('A file of the book is larger than declared', 'EBADZIP');
      throw fail('Damaged compressed data', 'EBADZIP');
    }
  } else throw fail(`Unsupported compression method ${e.method}`, 'EBADZIP');
  if (data.length !== e.usize) throw fail('Damaged ZIP entry (size)', 'EBADZIP');
  if (crc32(data) !== e.crc) throw fail('Damaged ZIP entry (checksum)', 'EBADZIP');
  return data;
}

// ---------------------------------------------------------------- tolerant XML parser
// Elements: { name, local (lower-case, no prefix), attrs: { qualifiedName: value }, children: [node|string], parent }.
// Handles comments, CDATA, processing instructions, DOCTYPE (with internal subset), unbalanced end tags.
const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', shy: '­', ensp: ' ', emsp: ' ',
  thinsp: ' ', zwnj: '‌', zwj: '‍', ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’',
  sbquo: '‚', ldquo: '“', rdquo: '”', bdquo: '„', laquo: '«', raquo: '»', hellip: '…',
  bull: '•', middot: '·', copy: '©', reg: '®', trade: '™', deg: '°', times: '×',
  eacute: 'é', egrave: 'è', ecirc: 'ê', euml: 'ë', agrave: 'à', acirc: 'â', auml: 'ä', ccedil: 'ç', icirc: 'î',
  iuml: 'ï', ocirc: 'ô', ouml: 'ö', ugrave: 'ù', ucirc: 'û', uuml: 'ü', oelig: 'œ', aelig: 'æ', Eacute: 'É',
  Egrave: 'È', Ecirc: 'Ê', Agrave: 'À', Ccedil: 'Ç', OElig: 'Œ', szlig: 'ß', ntilde: 'ñ', aacute: 'á', iacute: 'í',
  oacute: 'ó', uacute: 'ú', euro: '€', pound: '£', sect: '§', para: '¶', dagger: '†', Dagger: '‡',
};
function decodeEntities(s) {
  if (!s.includes('&')) return s;
  return s.replace(/&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : '�';
    }
    return NAMED[e] ?? m;
  });
}
const localOf = (n) => {
  const i = n.indexOf(':');
  return (i < 0 ? n : n.slice(i + 1)).toLowerCase();
};

function parseXml(src) {
  const root = { name: '#document', local: '#document', attrs: {}, children: [], parent: null };
  let cur = root;
  let i = 0;
  let count = 0;
  const n = src.length;
  const text = (s) => {
    if (s) cur.children.push(decodeEntities(s));
  };
  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt < 0) {
      text(src.slice(i));
      break;
    }
    if (lt > i) text(src.slice(i, lt));
    if (src.startsWith('<!--', lt)) {
      const e = src.indexOf('-->', lt + 4);
      i = e < 0 ? n : e + 3;
      continue;
    }
    if (src.startsWith('<![CDATA[', lt)) {
      const e = src.indexOf(']]>', lt + 9);
      cur.children.push(src.slice(lt + 9, e < 0 ? n : e));
      i = e < 0 ? n : e + 3;
      continue;
    }
    if (src.startsWith('<?', lt)) {
      const e = src.indexOf('?>', lt + 2);
      i = e < 0 ? n : e + 2;
      continue;
    }
    if (src.startsWith('<!', lt)) {
      let j = lt + 2;
      let depth = 0;
      for (; j < n; j++) {
        const c = src.charCodeAt(j);
        if (c === 91) depth++;
        else if (c === 93) depth--;
        else if (c === 62 && depth <= 0) break;
      }
      i = j + 1;
      continue;
    }
    if (src.charCodeAt(lt + 1) === 47) {
      const e = src.indexOf('>', lt + 2);
      const name = src.slice(lt + 2, e < 0 ? n : e).trim();
      for (let x = cur; x && x !== root; x = x.parent) {
        if (x.name === name) {
          cur = x.parent;
          break;
        }
      }
      i = e < 0 ? n : e + 1;
      continue;
    }
    let j = lt + 1;
    let q = 0;
    for (; j < n; j++) {
      const c = src.charCodeAt(j);
      if (q) {
        if (c === q) q = 0;
      } else if (c === 34 || c === 39) q = c;
      else if (c === 62) break;
    }
    let inner = src.slice(lt + 1, j);
    const m = /^[^\s/>]+/.exec(inner);
    if (!m) {
      text('<');
      i = lt + 1;
      continue;
    }
    i = j + 1;
    const self = /\/\s*$/.test(inner);
    if (self) inner = inner.replace(/\/\s*$/, '');
    const name = m[0];
    const attrs = {};
    const re = /([^\s=/]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
    re.lastIndex = name.length;
    let a;
    while ((a = re.exec(inner))) attrs[a[1]] = decodeEntities(a[2] ?? a[3] ?? a[4] ?? '');
    const node = { name, local: localOf(name), attrs, children: [], parent: cur };
    cur.children.push(node);
    if (++count > 200000) throw fail('XML document too large', 'ENOTEPUB');
    if (!self) cur = node;
  }
  return root;
}

/** Attribute by qualified name, else by local name (any prefix), case-insensitive. */
function attr(node, name) {
  if (!node?.attrs) return null;
  if (Object.prototype.hasOwnProperty.call(node.attrs, name)) return node.attrs[name];
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(node.attrs)) if (localOf(k) === want && !k.startsWith('xmlns')) return v;
  return null;
}
const isEl = (c) => c && typeof c === 'object';
function kids(node, local) {
  return node ? node.children.filter((c) => isEl(c) && (!local || c.local === local)) : [];
}
function findAll(node, local, first = false) {
  const out = [];
  if (!node) return out;
  const stack = node.children.slice().reverse();
  while (stack.length) {
    const c = stack.pop();
    if (!isEl(c)) continue;
    if (c.local === local) {
      out.push(c);
      if (first) return out;
    }
    for (let k = c.children.length - 1; k >= 0; k--) stack.push(c.children[k]);
  }
  return out;
}
const find = (node, local) => findAll(node, local, true)[0] || null;
function textOf(node, max = 100000) {
  if (!node) return '';
  let s = '';
  const stack = [node];
  while (stack.length && s.length < max) {
    const c = stack.pop();
    if (typeof c === 'string') s += c;
    else for (let k = c.children.length - 1; k >= 0; k--) stack.push(c.children[k]);
  }
  return s.replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------- paths inside the container
/** Resolve a URL reference found in `baseFile` -> { path, frag } (full, decoded path in the ZIP), or null. */
function resolveRef(baseFile, ref) {
  if (typeof ref !== 'string') return null;
  ref = ref.trim();
  if (!ref || /^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith('//')) return null;
  let frag = '';
  const hash = ref.indexOf('#');
  if (hash >= 0) {
    frag = ref.slice(hash + 1);
    ref = ref.slice(0, hash);
    try {
      frag = decodeURIComponent(frag);
    } catch {}
  }
  const qm = ref.indexOf('?');
  if (qm >= 0) ref = ref.slice(0, qm);
  if (!ref) return baseFile ? { path: baseFile, frag } : null;
  let p = ref;
  try {
    p = decodeURIComponent(ref);
  } catch {}
  let full = p.startsWith('/') ? p.slice(1) : path.posix.join(path.posix.dirname(baseFile || ''), p);
  full = path.posix.normalize(full).replace(/^(\.\/)+/, '');
  if (full === '.' || full === '..' || full.startsWith('../') || full.startsWith('/') || full.includes('\0')) return null;
  return { path: full, frag };
}
/** A path inside the container given by the renderer (already decoded, no fragment). */
function cleanHref(href) {
  if (typeof href !== 'string' || !href || href.length > 2048 || href.includes('\0')) return null;
  let p = href.replace(/^\/+/, '');
  p = path.posix.normalize(p).replace(/^(\.\/)+/, '');
  if (!p || p === '.' || p === '..' || p.startsWith('../') || p.startsWith('/')) return null;
  return p;
}
function lookup(dir, name) {
  if (!name) return null;
  return dir.entries.get(name) || dir.lower.get(name.toLowerCase()) || null;
}
function mimeOf(name) {
  const ext = (/\.([a-z0-9]+)$/i.exec(name)?.[1] || '').toLowerCase();
  return MIME[ext] || 'application/octet-stream';
}

function decodeText(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2));
  const head = buf.subarray(0, 200).toString('latin1');
  const enc = /^\s*<\?xml[^>]*encoding\s*=\s*["']([A-Za-z0-9._-]+)["']/.exec(head)?.[1];
  if (enc && !/^utf-?8$/i.test(enc)) {
    try {
      return new TextDecoder(enc).decode(buf);
    } catch {}
  }
  return new TextDecoder('utf-8').decode(buf);
}

// ---------------------------------------------------------------- books
const cache = new Map(); // path -> Promise<Loaded>

async function withFile(file, fn) {
  const fh = await fsp.open(file, 'r');
  try {
    return await fn(fh);
  } finally {
    await fh.close().catch(() => {});
  }
}

function checkPath(file) {
  if (typeof file !== 'string' || !file || file.length > 4096 || file.includes('\0') || !path.isAbsolute(file)) throw fail('Invalid book path', 'EINVAL');
  return path.normalize(file);
}

async function load(fileArg) {
  const file = checkPath(fileArg);
  let st;
  try {
    st = await fsp.stat(file);
  } catch (err) {
    throw fail('The book file was not found', err.code === 'ENOENT' ? 'ENOENT' : 'EINVAL');
  }
  if (!st.isFile()) throw fail('Not a file', 'EINVAL');
  if (st.size > MAX_BOOK) throw fail('The book is larger than 500 MB', 'ETOOBIG');
  const hit = cache.get(file);
  if (hit) {
    const v = await hit.catch(() => null);
    if (v && v.size === st.size && v.mtimeMs === st.mtimeMs) {
      cache.delete(file);
      cache.set(file, hit); // most recently used last
      return v;
    }
    if (cache.get(file) === hit) cache.delete(file);
  }
  const p = withFile(file, async (fh) => {
    const dir = await readDirectory(fh, st.size);
    const L = { file, size: st.size, mtimeMs: st.mtimeMs, dir };
    L.read = (name, cap) => readEntry(fh, st.size, lookup(dir, name) || (() => { throw fail(`Missing file ${name}`, 'ENOENT'); })(), cap);
    await parseBook(L);
    delete L.read; // the file handle closes when we return
    return L;
  });
  cache.set(file, p);
  p.catch(() => cache.get(file) === p && cache.delete(file));
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return p;
}

async function readXml(L, name) {
  const e = lookup(L.dir, name);
  if (!e) return null;
  if (e.usize > MAX_XML) throw fail(`${name} is too large`, 'ENOTEPUB');
  return parseXml(decodeText(await L.read(e.name, MAX_XML)));
}

async function parseBook(L) {
  const { dir } = L;
  // ---- container.xml -> package document
  let opfPath = null;
  const container = await readXml(L, 'META-INF/container.xml').catch((err) => {
    if (err.code === 'EBADZIP' || err.code === 'EDRM') throw err;
    return null;
  });
  if (container) {
    const roots = findAll(container, 'rootfile');
    const r = roots.find((x) => (attr(x, 'media-type') || '').toLowerCase() === 'application/oebps-package+xml') || roots[0];
    const fp = r && attr(r, 'full-path');
    if (fp) opfPath = cleanHref(fp);
  }
  if (!opfPath || !lookup(dir, opfPath)) opfPath = [...dir.entries.keys()].find((k) => /\.opf$/i.test(k)) || null;
  if (!opfPath) throw fail(container ? 'The package document is missing' : 'Not an EPUB book (no META-INF/container.xml)', 'ENOTEPUB');
  opfPath = lookup(dir, opfPath).name;
  const opf = await readXml(L, opfPath);
  const pkg = find(opf, 'package');
  if (!pkg) throw fail('Damaged package document', 'ENOTEPUB');
  const version = attr(pkg, 'version') || '2.0';
  const metadata = find(pkg, 'metadata') || pkg;
  const manifestEl = find(pkg, 'manifest');
  const spineEl = find(pkg, 'spine');

  // ---- metadata
  const metas = findAll(metadata, 'meta');
  const refines = new Map(); // id -> [{ property, value }]
  for (const m of metas) {
    const ref = attr(m, 'refines');
    if (ref && ref.startsWith('#')) {
      const id = ref.slice(1);
      if (!refines.has(id)) refines.set(id, []);
      refines.get(id).push({ property: (attr(m, 'property') || '').toLowerCase(), value: textOf(m) });
    }
  }
  const refined = (el, prop) => {
    const id = attr(el, 'id');
    return id ? refines.get(id)?.find((r) => r.property === prop)?.value || null : null;
  };
  const metaName = (name) => metas.find((m) => (attr(m, 'name') || '').toLowerCase() === name);
  const metaProp = (prop) => metas.find((m) => (attr(m, 'property') || '').toLowerCase() === prop && !attr(m, 'refines'));

  const titles = findAll(metadata, 'title');
  const mainTitle = titles.find((t) => refined(t, 'title-type') === 'main') || titles[0];
  const creators = findAll(metadata, 'creator');
  const roleOf = (c) => (attr(c, 'role') || refined(c, 'role') || '').toLowerCase();
  let authors = creators.filter((c) => !roleOf(c) || roleOf(c) === 'aut');
  if (!authors.length) authors = creators;
  const authorNames = authors.map((c) => textOf(c, 400)).filter(Boolean).slice(0, 20);
  const fileAs = authors.length ? attr(authors[0], 'file-as') || refined(authors[0], 'file-as') : null;
  const uidId = attr(pkg, 'unique-identifier');
  const identifiers = findAll(metadata, 'identifier');
  const uidEl = identifiers.find((x) => uidId && attr(x, 'id') === uidId) || identifiers[0];
  const identifier = uidEl ? textOf(uidEl, 1000) : '';
  const first = (local, max = 2000) => textOf(find(metadata, local), max);
  let series = '';
  let seriesIndex = null;
  const coll = metas.find((m) => (attr(m, 'property') || '').toLowerCase() === 'belongs-to-collection');
  if (coll) {
    series = textOf(coll, 400);
    const pos = Number(refined(coll, 'group-position'));
    if (Number.isFinite(pos)) seriesIndex = pos;
  } else if (metaName('calibre:series')) {
    series = attr(metaName('calibre:series'), 'content') || '';
    const pos = Number(attr(metaName('calibre:series_index'), 'content'));
    if (Number.isFinite(pos)) seriesIndex = pos;
  }

  // ---- manifest
  const items = new Map(); // id -> item
  const byPath = new Map(); // path -> item
  for (const it of kids(manifestEl, 'item')) {
    const r = resolveRef(opfPath, attr(it, 'href') || '');
    if (!r) continue;
    const e = lookup(dir, r.path);
    const item = {
      id: attr(it, 'id') || '',
      href: e ? e.name : r.path,
      mediaType: (attr(it, 'media-type') || mimeOf(r.path)).toLowerCase().trim(),
      properties: (attr(it, 'properties') || '').toLowerCase().split(/\s+/).filter(Boolean),
      size: e ? e.usize : 0,
    };
    if (item.id && !items.has(item.id)) items.set(item.id, item);
    if (!byPath.has(item.href)) byPath.set(item.href, item);
  }
  L.mimes = new Map([...byPath.values()].map((it) => [it.href, it.mediaType]));

  // ---- spine
  const spine = [];
  for (const ref of kids(spineEl, 'itemref')) {
    const it = items.get(attr(ref, 'idref') || '');
    if (!it) continue;
    spine.push({ href: it.href, id: it.id, mediaType: it.mediaType, linear: (attr(ref, 'linear') || 'yes').toLowerCase() !== 'no', size: Math.max(1, it.size) });
  }
  if (!spine.length) throw fail('The book has no reading order', 'ENOTEPUB');
  const spineIndex = new Map();
  spine.forEach((s, i) => {
    if (!spineIndex.has(s.href)) spineIndex.set(s.href, i);
    if (!spineIndex.has(s.href.toLowerCase())) spineIndex.set(s.href.toLowerCase(), i);
  });
  const spineOf = (p) => (p ? (spineIndex.get(p) ?? spineIndex.get(p.toLowerCase()) ?? -1) : -1);

  // ---- encryption: DRM and font obfuscation
  L.encrypted = new Set();
  L.obfuscated = new Map(); // path -> algorithm
  const enc = await readXml(L, 'META-INF/encryption.xml').catch(() => null);
  if (enc) {
    for (const ed of findAll(enc, 'encrypteddata')) {
      const alg = attr(find(ed, 'encryptionmethod'), 'Algorithm') || '';
      const uri = attr(find(ed, 'cipherreference'), 'URI');
      const r = uri && resolveRef('', uri);
      if (!r) continue;
      const name = lookup(dir, r.path)?.name || r.path;
      if (alg === OBF_IDPF || alg === OBF_ADOBE) L.obfuscated.set(name, alg);
      else L.encrypted.add(name);
    }
  }
  if (spine.some((s) => L.encrypted.has(s.href))) throw fail('This book is protected by DRM', 'EDRM');
  // keys for the obfuscated fonts
  if (L.obfuscated.size) {
    L.idpfKey = crypto.createHash('sha1').update(identifier.replace(/[ \u0009\u000d\u000a]/g, ''), 'utf8').digest();
    const uuid = identifiers.map((x) => textOf(x)).map((v) => /urn:uuid:([0-9a-f-]{32,40})/i.exec(v)?.[1]).find(Boolean);
    if (uuid) L.adobeKey = Buffer.from(uuid.replace(/-/g, ''), 'hex');
  }

  // ---- cover
  let cover = null;
  const isImage = (it) => it && /^image\//.test(it.mediaType);
  const ci = [...items.values()].find((it) => it.properties.includes('cover-image'));
  if (isImage(ci)) cover = ci.href;
  if (!cover) {
    const m = metaName('cover');
    const v = m && attr(m, 'content');
    const it = v ? items.get(v) || byPath.get(resolveRef(opfPath, v)?.path || '') : null;
    if (isImage(it)) cover = it.href;
  }
  if (!cover) {
    const it = [...items.values()].find((x) => isImage(x) && /cover/i.test(`${x.id} ${x.href}`));
    if (it) cover = it.href;
  }
  if (!cover) {
    // EPUB 2 guide reference (an XHTML page holding the picture)
    const ref = kids(find(pkg, 'guide'), 'reference').find((r) => (attr(r, 'type') || '').toLowerCase() === 'cover');
    const r = ref && resolveRef(opfPath, attr(ref, 'href') || '');
    const page = r && lookup(dir, r.path);
    if (page && !L.encrypted.has(page.name)) {
      const x = await readXml(L, page.name).catch(() => null);
      const img = x && (find(x, 'img') || find(x, 'image'));
      const src = img && (attr(img, 'src') || attr(img, 'href'));
      const rr = src && resolveRef(page.name, src);
      if (rr && lookup(dir, rr.path)) cover = lookup(dir, rr.path).name;
    }
  }
  if (cover && (!lookup(dir, cover) || L.encrypted.has(cover))) cover = null;

  // ---- table of contents
  const budget = { n: 0 };
  let toc = [];
  const navItem = [...items.values()].find((it) => it.properties.includes('nav'));
  if (navItem && lookup(dir, navItem.href) && !L.encrypted.has(navItem.href)) {
    const nav = await readXml(L, navItem.href).catch(() => null);
    if (nav) {
      const navs = findAll(nav, 'nav');
      const tocNav = navs.find((x) => /\btoc\b/i.test(attr(x, 'epub:type') || attr(x, 'type') || '')) || navs.find((x) => attr(x, 'role') === 'doc-toc') || navs[0];
      const ol = tocNav && find(tocNav, 'ol');
      if (ol) toc = navList(ol, navItem.href, spineOf, budget, 0);
    }
  }
  if (!toc.length) {
    const ncxId = attr(spineEl, 'toc');
    const ncxItem = (ncxId && items.get(ncxId)) || [...items.values()].find((it) => it.mediaType === 'application/x-dtbncx+xml');
    if (ncxItem && lookup(dir, ncxItem.href) && !L.encrypted.has(ncxItem.href)) {
      const ncx = await readXml(L, ncxItem.href).catch(() => null);
      const map = ncx && find(ncx, 'navmap');
      if (map) toc = ncxList(map, ncxItem.href, spineOf, budget, 0);
    }
  }

  const direction = (attr(spineEl, 'page-progression-direction') || '').toLowerCase();
  L.book = {
    path: L.file,
    size: L.size,
    mtime: L.mtimeMs,
    version,
    title: textOf(mainTitle, 500) || path.basename(L.file).replace(/\.epub$/i, ''),
    authors: authorNames,
    authorSort: fileAs || sortName(authorNames[0] || ''),
    language: first('language', 40),
    identifier: identifier.slice(0, 500),
    publisher: first('publisher', 400),
    date: first('date', 60),
    description: first('description', 4000).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(),
    series: series.slice(0, 400),
    seriesIndex,
    direction: direction === 'rtl' || direction === 'ltr' ? direction : '',
    layout: textOf(metaProp('rendition:layout')) === 'pre-paginated' ? 'pre-paginated' : 'reflowable',
    cover,
    opf: opfPath,
    spine,
    toc,
    hasToc: toc.length > 0,
  };
}

function sortName(name) {
  const parts = name.trim().split(/\s+/);
  return parts.length > 1 ? `${parts[parts.length - 1]}, ${parts.slice(0, -1).join(' ')}` : name;
}

function tocEntry(label, base, href, spineOf) {
  const r = href ? resolveRef(base, href) : null;
  return { label: label.slice(0, 300), href: r ? r.path : '', frag: r ? r.frag.slice(0, 300) : '', spine: r ? spineOf(r.path) : -1, children: [] };
}
function navList(ol, base, spineOf, budget, depth) {
  const out = [];
  for (const li of kids(ol, 'li')) {
    if (++budget.n > MAX_TOC) break;
    const head = kids(li).find((c) => c.local === 'a' || c.local === 'span') || find(li, 'a');
    const label = head ? textOf(head, 600) : '';
    const it = tocEntry(label, base, head && head.local === 'a' ? attr(head, 'href') : null, spineOf);
    const sub = kids(li, 'ol')[0];
    if (sub && depth < 8) it.children = navList(sub, base, spineOf, budget, depth + 1);
    if (it.label || it.children.length) out.push(it);
  }
  return out;
}
function ncxList(parent, base, spineOf, budget, depth) {
  const out = [];
  for (const np of kids(parent, 'navpoint')) {
    if (++budget.n > MAX_TOC) break;
    const label = textOf(kids(np, 'navlabel')[0], 600);
    const it = tocEntry(label, base, attr(kids(np, 'content')[0], 'src'), spineOf);
    if (depth < 8) it.children = ncxList(np, base, spineOf, budget, depth + 1);
    if (it.label || it.children.length) out.push(it);
  }
  return out;
}

function deobfuscate(L, name, data) {
  const alg = L.obfuscated.get(name);
  const key = alg === OBF_IDPF ? L.idpfKey : L.adobeKey;
  if (!key || !key.length) return data;
  const n = Math.min(data.length, alg === OBF_IDPF ? 1040 : 1024);
  const out = Buffer.from(data);
  for (let i = 0; i < n; i++) out[i] ^= key[i % key.length];
  return out;
}

async function resource(file, href) {
  const name = cleanHref(href);
  if (!name) throw fail('Invalid file name', 'EINVAL');
  const L = await load(file);
  const e = lookup(L.dir, name);
  if (!e) throw fail(`No file ${name} in the book`, 'ENOENT');
  if (L.encrypted.has(e.name)) throw fail('This file of the book is protected by DRM', 'EDRM');
  let data = await withFile(L.file, (fh) => readEntry(fh, L.size, e));
  if (L.obfuscated.has(e.name)) data = deobfuscate(L, e.name, data);
  const declared = L.mimes.get(e.name);
  return { data: new Uint8Array(data), mime: declared || mimeOf(e.name) };
}

async function scan(dirs, opts = {}) {
  const homeRaw = path.normalize(os.homedir());
  let home = homeRaw;
  try {
    home = await fsp.realpath(homeRaw);
  } catch {}
  const depthMax = Math.max(0, Math.min(2, Number.isInteger(opts?.depth) ? opts.depth : 1));
  const out = [];
  const seen = new Set();
  let visited = 0;
  for (const d of Array.isArray(dirs) ? dirs.slice(0, 8) : []) {
    if (typeof d !== 'string' || !path.isAbsolute(d) || d.includes('\0')) continue;
    let real;
    try {
      real = await fsp.realpath(d);
    } catch {
      continue;
    }
    const given = path.normalize(d);
    const inside = (p) => p === home || p.startsWith(`${home}/`) || p === homeRaw || p.startsWith(`${homeRaw}/`);
    if (!inside(real) && !inside(given)) continue;
    const queue = [[path.normalize(d), 0]];
    while (queue.length && out.length < SCAN_MAX_RESULTS && visited < SCAN_MAX_ENTRIES) {
      const [dir, depth] = queue.shift();
      let list;
      try {
        list = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const ent of list) {
        if (++visited > SCAN_MAX_ENTRIES || out.length >= SCAN_MAX_RESULTS) break;
        if (ent.name.startsWith('.')) continue;
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          if (depth < depthMax) queue.push([p, depth + 1]);
          continue;
        }
        if (!/\.epub$/i.test(ent.name) || seen.has(p)) continue;
        try {
          const st = await fsp.stat(p);
          if (!st.isFile()) continue;
          seen.add(p);
          out.push({ path: p, name: ent.name, size: st.size, mtime: st.mtimeMs });
        } catch {}
      }
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

function register(api) {
  api.handle('books:open', async (file) => (await load(file)).book);
  api.handle('books:resource', (file, href) => resource(file, href));
  api.handle('books:meta', async (file) => {
    const L = await load(file);
    const b = L.book;
    let cover = null;
    if (b.cover) cover = await resource(file, b.cover).catch(() => null);
    if (cover && cover.data.length > 16 * 1024 * 1024) cover = null;
    return {
      path: b.path, size: b.size, mtime: b.mtime, title: b.title, authors: b.authors, authorSort: b.authorSort, language: b.language,
      identifier: b.identifier, series: b.series, seriesIndex: b.seriesIndex, spineCount: b.spine.length, cover,
    };
  });
  api.handle('books:scan', (dirs, opts) => scan(dirs, opts));
}

module.exports = register;
// For the tests (test/books.test.mjs drives the parser and the ZIP reader directly).
module.exports._internals = { parseXml, resolveRef, cleanHref, load, resource, scan, LIMITS: { MAX_BOOK, MAX_ENTRY } };
