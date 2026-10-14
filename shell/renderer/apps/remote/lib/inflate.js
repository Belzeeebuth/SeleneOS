// Synchronous zlib (RFC 1950) / DEFLATE (RFC 1951) stream decoder for the VNC ZRLE and Tight encodings, and the
// extended clipboard. Self-written for Selene (no dependency), DOM-free (also runs under Node in the tests).
//
// ZRLE and Tight keep ONE zlib stream for the whole connection (Tight: four of them): every rectangle carries the next
// piece of the stream. Servers end each piece with a sync flush, so a piece holds whole deflate blocks; the decoder
// keeps the 32 KiB history window and the bit position between pieces. If a piece ever ends inside a block, the
// unfinished block is kept and decoded when the next piece arrives (nothing is lost, nothing is decoded twice).
//
//   const z = new ZlibStream();   const out = z.push(bytes);   // Uint8Array of what these bytes decode to
//   zlibStore(bytes) -> Uint8Array   a complete zlib stream with stored (uncompressed) blocks (clipboard "provide")
//   adler32(bytes) -> number

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
const WINDOW = 32768;
const MAX_OUT = 256 << 20; // one piece never decodes to more than 256 MiB (a 16384² screen is 1 GiB raw: refused)

class NeedMore extends Error {}
const NEED_MORE = new NeedMore('need more input');

/** Huffman table: lookup[reversed code of `bits` bits] = (symbol << 4) | length; 0 = invalid. */
function buildTable(lengths, n) {
  let max = 0;
  for (let i = 0; i < n; i++) if (lengths[i] > max) max = lengths[i];
  if (!max) return { bits: 1, lookup: new Int32Array(2) };
  const count = new Uint16Array(16);
  for (let i = 0; i < n; i++) count[lengths[i]]++;
  count[0] = 0;
  const next = new Uint16Array(16);
  let code = 0;
  let left = 1;
  for (let b = 1; b <= 15; b++) {
    left <<= 1;
    left -= count[b];
    if (left < 0) throw new Error('bad huffman table (oversubscribed)');
    code = (code + count[b - 1]) << 1;
    next[b] = code;
  }
  const lookup = new Int32Array(1 << max);
  for (let sym = 0; sym < n; sym++) {
    const len = lengths[sym];
    if (!len) continue;
    let c = next[len]++;
    let rev = 0;
    for (let i = 0; i < len; i++) {
      rev = (rev << 1) | (c & 1);
      c >>= 1;
    }
    for (let i = rev; i < 1 << max; i += 1 << len) lookup[i] = (sym << 4) | len;
  }
  return { bits: max, lookup };
}

let FIXED = null;
function fixedTables() {
  if (FIXED) return FIXED;
  const l = new Uint8Array(288);
  l.fill(8, 0, 144);
  l.fill(9, 144, 256);
  l.fill(7, 256, 280);
  l.fill(8, 280, 288);
  const d = new Uint8Array(30).fill(5);
  FIXED = { lit: buildTable(l, 288), dist: buildTable(d, 30) };
  return FIXED;
}

export function adler32(b, a = 1) {
  let s1 = a & 0xffff;
  let s2 = a >>> 16;
  for (let i = 0; i < b.length; ) {
    const end = Math.min(b.length, i + 3800);
    for (; i < end; i++) {
      s1 += b[i];
      s2 += s1;
    }
    s1 %= 65521;
    s2 %= 65521;
  }
  return ((s2 << 16) | s1) >>> 0;
}

/** A complete zlib stream holding `data` in stored blocks (valid zlib, no compression; used for small clipboard texts). */
export function zlibStore(data) {
  const blocks = Math.max(1, Math.ceil(data.length / 65535));
  const out = new Uint8Array(2 + data.length + blocks * 5 + 4);
  out[0] = 0x78;
  out[1] = 0x01;
  let o = 2;
  for (let i = 0; i < blocks; i++) {
    const chunk = data.subarray(i * 65535, Math.min(data.length, (i + 1) * 65535));
    out[o++] = i === blocks - 1 ? 1 : 0;
    out[o++] = chunk.length & 0xff;
    out[o++] = chunk.length >> 8;
    out[o++] = ~chunk.length & 0xff;
    out[o++] = (~chunk.length >> 8) & 0xff;
    out.set(chunk, o);
    o += chunk.length;
  }
  const a = adler32(data);
  out[o++] = a >>> 24;
  out[o++] = (a >>> 16) & 0xff;
  out[o++] = (a >>> 8) & 0xff;
  out[o++] = a & 0xff;
  return out;
}

export class ZlibStream {
  constructor() {
    this.history = new Uint8Array(0); // last <= 32 KiB of output
    this.header = false; // zlib header read
    this.ended = false; // final block seen: later bytes are ignored
    this.pending = new Uint8Array(0); // input not decoded yet (an unfinished block)
    this.bitbuf = 0;
    this.bitcnt = 0;
  }

  /** Decode the next piece of the stream; returns the bytes it produced. Throws on corrupt data. */
  push(input) {
    if (this.ended) return new Uint8Array(0);
    let data = input;
    if (this.pending.length) {
      data = new Uint8Array(this.pending.length + input.length);
      data.set(this.pending);
      data.set(input, this.pending.length);
    }
    const hist = this.history.length;
    let cap = hist + Math.max(1024, data.length * 4);
    let out = new Uint8Array(cap);
    out.set(this.history);
    let op = hist;
    let pos = 0;
    let bitbuf = this.bitbuf;
    let bitcnt = this.bitcnt;
    const len = data.length;

    const need = (n) => {
      while (bitcnt < n) {
        if (pos >= len) throw NEED_MORE;
        bitbuf |= data[pos++] << bitcnt;
        bitcnt += 8;
      }
    };
    const bits = (n) => {
      need(n);
      const v = bitbuf & ((1 << n) - 1);
      bitbuf >>>= n;
      bitcnt -= n;
      return v;
    };
    const sym = (t) => {
      while (bitcnt < t.bits && pos < len) {
        bitbuf |= data[pos++] << bitcnt;
        bitcnt += 8;
      }
      const e = t.lookup[bitbuf & ((1 << t.bits) - 1)];
      const l = e & 15;
      if (!l) {
        if (bitcnt < t.bits) throw NEED_MORE;
        throw new Error('bad huffman code');
      }
      if (l > bitcnt) throw NEED_MORE;
      bitbuf >>>= l;
      bitcnt -= l;
      return e >> 4;
    };
    const grow = (extra) => {
      if (op + extra <= cap) return;
      while (cap < op + extra) cap *= 2;
      if (cap - hist > MAX_OUT * 2) throw new Error('decompressed data too large');
      const o = new Uint8Array(cap);
      o.set(out.subarray(0, op));
      out = o;
    };

    // checkpoint = start of the block being decoded (rolled back to when the input ends inside it)
    let cpPos = 0;
    let cpBuf = bitbuf;
    let cpCnt = bitcnt;
    let cpOp = op;
    try {
      if (!this.header) {
        const cmf = bits(8);
        const flg = bits(8);
        if ((cmf & 15) !== 8 || ((cmf << 8) | flg) % 31 || flg & 32) throw new Error('bad zlib header');
        this.header = true;
      }
      for (;;) {
        cpPos = pos;
        cpBuf = bitbuf;
        cpCnt = bitcnt;
        cpOp = op;
        if (pos >= len && bitcnt < 3) break; // clean end of this piece
        const final = bits(1);
        const type = bits(2);
        if (type === 0) {
          bitbuf >>>= bitcnt & 7;
          bitcnt -= bitcnt & 7;
          const n = bits(16);
          const nn = bits(16);
          if ((n ^ 0xffff) !== nn) throw new Error('bad stored block length');
          grow(n);
          let k = n;
          while (k && bitcnt) {
            out[op++] = bits(8);
            k--;
          }
          if (pos + k > len) throw NEED_MORE;
          out.set(data.subarray(pos, pos + k), op);
          op += k;
          pos += k;
        } else if (type === 1 || type === 2) {
          let lit;
          let dist;
          if (type === 1) ({ lit, dist } = fixedTables());
          else {
            const hlit = bits(5) + 257;
            const hdist = bits(5) + 1;
            const hclen = bits(4) + 4;
            const cl = new Uint8Array(19);
            for (let i = 0; i < hclen; i++) cl[CL_ORDER[i]] = bits(3);
            const clt = buildTable(cl, 19);
            const lens = new Uint8Array(hlit + hdist);
            for (let i = 0; i < hlit + hdist; ) {
              const s = sym(clt);
              if (s < 16) lens[i++] = s;
              else {
                let rep = 0;
                let val = 0;
                if (s === 16) {
                  if (!i) throw new Error('bad code lengths');
                  val = lens[i - 1];
                  rep = 3 + bits(2);
                } else if (s === 17) rep = 3 + bits(3);
                else rep = 11 + bits(7);
                if (i + rep > hlit + hdist) throw new Error('bad code lengths');
                lens.fill(val, i, i + rep);
                i += rep;
              }
            }
            if (!lens[256]) throw new Error('no end-of-block code');
            lit = buildTable(lens.subarray(0, hlit), hlit);
            dist = buildTable(lens.subarray(hlit), hdist);
          }
          for (;;) {
            const s = sym(lit);
            if (s < 256) {
              if (op >= cap) grow(1);
              out[op++] = s;
            } else if (s === 256) break;
            else {
              const li = s - 257;
              if (li >= 29) throw new Error('bad length code');
              const length = LEN_BASE[li] + (LEN_EXTRA[li] ? bits(LEN_EXTRA[li]) : 0);
              const di = sym(dist);
              if (di >= 30) throw new Error('bad distance code');
              const d = DIST_BASE[di] + (DIST_EXTRA[di] ? bits(DIST_EXTRA[di]) : 0);
              if (d > op) throw new Error('distance too far back');
              grow(length);
              let from = op - d;
              for (let i = 0; i < length; i++) out[op++] = out[from++];
            }
          }
        } else throw new Error('bad block type');
        if (op - hist > MAX_OUT) throw new Error('decompressed data too large');
        if (final) {
          this.ended = true;
          break;
        }
      }
      this.pending = new Uint8Array(0);
    } catch (e) {
      if (e !== NEED_MORE) throw e;
      // the piece ended inside a block: decode that block again once the rest arrives
      this.pending = data.slice(cpPos);
      bitbuf = cpBuf;
      bitcnt = cpCnt;
      op = cpOp;
    }
    this.bitbuf = bitbuf;
    this.bitcnt = bitcnt;
    this.history = out.slice(Math.max(0, op - WINDOW), op);
    return out.slice(hist, op);
  }
}
