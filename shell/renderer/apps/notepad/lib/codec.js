// Notepad text codec: byte <-> string conversion with encoding and line-ending detection.
//
//   decode(bytes)            -> { text (LF only), encoding, eol, mixedEol }
//   encode(text, enc, eol)   -> { bytes, lossy }      text uses LF internally; eol is applied here
//   unencodable(text, enc)   -> first character that cannot be stored in enc (or null)
//
// Encodings: 'utf-8' | 'utf-8-bom' | 'utf-16le' | 'utf-16be' | 'ansi' (Windows-1252, like Windows' "ANSI").
// Line endings: 'crlf' | 'lf' | 'cr'.

export const ENCODINGS = ['utf-8', 'utf-8-bom', 'utf-16le', 'utf-16be', 'ansi'];
export const EOLS = ['crlf', 'lf', 'cr'];
export const EOL_CHARS = { crlf: '\r\n', lf: '\n', cr: '\r' };

// Windows-1252 reverse map built from the platform decoder (exact WHATWG table, C1 holes included).
let cp1252 = null;
function cp1252Map() {
  if (cp1252) return cp1252;
  cp1252 = new Map();
  const dec = new TextDecoder('windows-1252');
  for (let b = 0; b < 256; b++) {
    const ch = dec.decode(new Uint8Array([b]));
    if (ch.length === 1 && !cp1252.has(ch.charCodeAt(0))) cp1252.set(ch.charCodeAt(0), b);
  }
  return cp1252;
}

function countEols(text) {
  let crlf = 0;
  let cr = 0;
  let lf = 0;
  let i = text.indexOf('\r');
  while (i !== -1) {
    if (text.charCodeAt(i + 1) === 10) crlf++;
    else cr++;
    i = text.indexOf('\r', i + 1);
  }
  i = text.indexOf('\n');
  while (i !== -1) {
    lf++;
    i = text.indexOf('\n', i + 1);
  }
  lf -= crlf;
  return { crlf, cr, lf };
}

/** Dominant line ending of a raw (un-normalised) string, or null when it has a single line. */
export function detectEol(text) {
  const c = countEols(text);
  const total = c.crlf + c.cr + c.lf;
  if (!total) return { eol: null, mixed: false };
  let eol = 'crlf';
  if (c.lf > c.crlf && c.lf >= c.cr) eol = 'lf';
  else if (c.cr > c.crlf && c.cr > c.lf) eol = 'cr';
  const kinds = (c.crlf > 0) + (c.cr > 0) + (c.lf > 0);
  return { eol, mixed: kinds > 1 };
}

export function normalizeEol(text) {
  return text.indexOf('\r') === -1 ? text : text.replace(/\r\n?/g, '\n');
}

export function applyEol(text, eol) {
  if (eol === 'crlf') return text.replace(/\n/g, '\r\n');
  if (eol === 'cr') return text.replace(/\n/g, '\r');
  return text;
}

function looksLikeUtf16(bytes) {
  // No BOM, but text-like UTF-16: every other byte is zero for ASCII content.
  const n = Math.min(bytes.length, 4096) & ~1;
  if (n < 4) return null;
  let evenZero = 0;
  let oddZero = 0;
  for (let i = 0; i < n; i += 2) {
    if (bytes[i] === 0) evenZero++;
    if (bytes[i + 1] === 0) oddZero++;
  }
  const pairs = n / 2;
  if (oddZero > pairs * 0.4 && evenZero < pairs * 0.05) return 'utf-16le';
  if (evenZero > pairs * 0.4 && oddZero < pairs * 0.05) return 'utf-16be';
  return null;
}

export function decode(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input || []);
  let encoding = 'utf-8';
  let raw;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    encoding = 'utf-8-bom';
    raw = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes.subarray(3));
  } else if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    encoding = 'utf-16le';
    raw = new TextDecoder('utf-16le', { ignoreBOM: true }).decode(bytes.subarray(2));
  } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    encoding = 'utf-16be';
    raw = new TextDecoder('utf-16be', { ignoreBOM: true }).decode(bytes.subarray(2));
  } else {
    try {
      raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      const u16 = raw.indexOf('\0') !== -1 ? looksLikeUtf16(bytes) : null;
      if (u16) {
        encoding = u16;
        raw = new TextDecoder(u16, { ignoreBOM: true }).decode(bytes);
      }
    } catch {
      const u16 = looksLikeUtf16(bytes);
      if (u16) {
        encoding = u16;
        raw = new TextDecoder(u16, { ignoreBOM: true }).decode(bytes);
      } else {
        // Not valid UTF-8: fall back to the Western Windows code page (a superset of Latin-1).
        encoding = 'ansi';
        raw = new TextDecoder('windows-1252').decode(bytes);
      }
    }
  }
  const { eol, mixed } = detectEol(raw);
  return { text: normalizeEol(raw), encoding, eol, mixedEol: mixed };
}

export function unencodable(text, encoding) {
  if (encoding !== 'ansi') return null;
  const map = cp1252Map();
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80 || c === 10 || c === 13) continue;
    if (!map.has(c)) return String.fromCodePoint(text.codePointAt(i));
  }
  return null;
}

export function encode(text, encoding = 'utf-8', eol = 'lf') {
  const s = applyEol(text, eol);
  let lossy = false;
  let bytes;
  switch (encoding) {
    case 'utf-8-bom': {
      const body = new TextEncoder().encode(s);
      bytes = new Uint8Array(body.length + 3);
      bytes.set([0xef, 0xbb, 0xbf], 0);
      bytes.set(body, 3);
      break;
    }
    case 'utf-16le':
    case 'utf-16be': {
      const le = encoding === 'utf-16le';
      bytes = new Uint8Array(2 + s.length * 2);
      bytes[0] = le ? 0xff : 0xfe;
      bytes[1] = le ? 0xfe : 0xff;
      for (let i = 0, o = 2; i < s.length; i++, o += 2) {
        const c = s.charCodeAt(i);
        bytes[o + (le ? 0 : 1)] = c & 0xff;
        bytes[o + (le ? 1 : 0)] = c >> 8;
      }
      break;
    }
    case 'ansi': {
      const map = cp1252Map();
      bytes = new Uint8Array(s.length);
      let o = 0;
      for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c < 0x80) bytes[o++] = c;
        else {
          const b = map.get(c);
          if (b === undefined) {
            lossy = true;
            bytes[o++] = 0x3f; // '?'
            if (c >= 0xd800 && c <= 0xdbff) i++; // one '?' per astral character
          } else bytes[o++] = b;
        }
      }
      bytes = bytes.subarray(0, o);
      break;
    }
    default:
      bytes = new TextEncoder().encode(s);
  }
  return { bytes, lossy };
}
