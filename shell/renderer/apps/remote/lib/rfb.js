// RFB 3.8 (VNC) client protocol, DOM-free: the app feeds it the bytes from main/ipc/remote.js and draws what it reports.
// Also speaks 3.7 and 3.3 servers. Security: None (1) and VNC Authentication (2). Pixel format asked from the server:
// 32 bpp true colour, little-endian, bytes R G B X.
// Encodings, in the order offered to the server (SetEncodings): CopyRect, Tight (zlib, palette, gradient, fill, and JPEG
// when the app can decode it), ZRLE, Hextile, Raw; pseudo-encodings: JPEG quality 6 and compression level 2 (Tight),
// DesktopSize, LastRect, Cursor (the remote pointer shape, drawn locally) and the extended clipboard (UTF-8 text).
// ZRLE and Tight decompress with lib/inflate.js (one zlib stream for the whole connection; Tight: four).
//
//   const c = new RfbClient({ write(bytes), password, onInit({ width, height, name }), onRaw(x, y, w, h, rgba),
//     onCopy(sx, sy, x, y, w, h), onJpeg(x, y, w, h, jpegBytes) -> Promise, onCursor({ hotX, hotY, w, h, rgba }),
//     onResize(w, h), onBell(), onCutText(text), onUpdate(), onState(state), onError({ code, message }),
//     encodings: [..] (optional override, for tests) });
//   c.receive(uint8array)   c.pointer(x, y, mask)   c.key(keysym, down)   c.ctrlAltDel()   c.clipboard(text)
//   c.extendedClipboard -> true once the server announced the extended clipboard (UTF-8)
// States: version, security, auth, result, init, connected, failed. Error codes: EPROTO (not a VNC server or broken
// stream), ENEEDPASS (the server wants a password and none was given), EAUTH (wrong password), ENOSEC (no supported
// security type), EREFUSED (the server refused us, message = its reason).
// onJpeg may return a promise (the picture is decoded asynchronously): later messages wait until it settled, so the
// screen is always drawn in order.
import { vncAuthResponse } from './des.js';
import { KEYSYM } from './keysym.js';
import { ZlibStream, zlibStore } from './inflate.js';

export const ENC = {
  RAW: 0,
  COPYRECT: 1,
  HEXTILE: 5,
  TIGHT: 7,
  ZRLE: 16,
  JPEG_QUALITY_6: -26, // -32 + level
  COMPRESS_2: -254, // -256 + level
  DESKTOPSIZE: -223,
  LASTRECT: -224,
  CURSOR: -239,
  EXT_CLIPBOARD: -1063131698, // 0xC0A1E5CE
};
// extended clipboard flags
const CB = { TEXT: 1, CAPS: 1 << 24, REQUEST: 1 << 25, PEEK: 1 << 26, NOTIFY: 1 << 27, PROVIDE: 1 << 28 };
const MAX_STRING = 1 << 20;
const MAX_FB = 16384;
const MAX_CLIP = 8 << 20;
const MAX_CURSOR = 512;

class ByteQueue {
  constructor() {
    this.chunks = [];
    this.length = 0;
  }
  push(c) {
    if (c.length) {
      this.chunks.push(c);
      this.length += c.length;
    }
  }
  /** Copy of the first n bytes (n <= length), consuming them when take is true. */
  read(n, take = true) {
    const out = new Uint8Array(n);
    let got = 0;
    let i = 0;
    while (got < n) {
      const c = this.chunks[i];
      const k = Math.min(c.length, n - got);
      out.set(c.subarray(0, k), got);
      got += k;
      if (take) {
        if (k === c.length) this.chunks.shift();
        else {
          this.chunks[0] = c.subarray(k);
          i = 0;
        }
      } else i++;
    }
    if (take) this.length -= n;
    return out;
  }
  peek(n) {
    return this.read(n, false);
  }
  /** Byte at offset i (i < length) without copying. */
  at(i) {
    for (const c of this.chunks) {
      if (i < c.length) return c[i];
      i -= c.length;
    }
    return undefined;
  }
}

const u16 = (b, o) => (b[o] << 8) | b[o + 1];
const u32 = (b, o) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
const s32 = (b, o) => u32(b, o) | 0;
const latin1 = (b) => {
  let s = '';
  for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode.apply(null, b.subarray(i, i + 8192));
  return s;
};

/** Tight "compact length": 1-3 bytes, 7 bits each (low first). Returns [length, bytes used] or null when incomplete. */
function compactLength(q, off) {
  if (q.length < off + 1) return null;
  let b = q.at(off);
  let n = b & 0x7f;
  if (!(b & 0x80)) return [n, 1];
  if (q.length < off + 2) return null;
  b = q.at(off + 1);
  n |= (b & 0x7f) << 7;
  if (!(b & 0x80)) return [n, 2];
  if (q.length < off + 3) return null;
  n |= q.at(off + 2) << 14;
  return [n, 3];
}

export class RfbClient {
  constructor(opts = {}) {
    this.o = opts;
    this.q = new ByteQueue();
    this.state = 'version';
    this.minor = 8;
    this.width = 0;
    this.height = 0;
    this.name = '';
    this.rectsLeft = 0;
    this.rect = null;
    this.resized = false;
    this.securityType = 0;
    this.busy = null; // promise of an asynchronous step (JPEG decoding)
    this.zrle = null;
    this.tightZ = [null, null, null, null];
    this.extendedClipboard = false;
    this.clipServer = { actions: 0, formats: 0 };
    this.clipText = null; // local text waiting for the server's request (extended clipboard)
  }
  setState(s) {
    this.state = s;
    this.o.onState?.(s);
  }
  fail(code, message) {
    if (this.state === 'failed') return;
    this.setState('failed');
    this.o.onError?.({ code, message: String(message || '') });
  }
  send(bytes) {
    if (this.state !== 'failed') this.o.write?.(bytes);
  }
  receive(chunk) {
    if (this.state === 'failed' || !chunk?.length) return;
    this.q.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
    this.pump();
  }
  pump() {
    if (this.busy) return;
    try {
      while (this.state !== 'failed') {
        const r = this.step();
        if (r && typeof r.then === 'function') {
          this.busy = r.then(
            () => {
              this.busy = null;
              this.pump();
            },
            (e) => {
              this.busy = null;
              this.fail('EPROTO', e?.message || e);
            },
          );
          return;
        }
        if (!r) break;
      }
    } catch (e) {
      this.fail('EPROTO', e?.message || e);
    }
  }
  /** One parsing step; false when more bytes are needed, a promise when an asynchronous decode must finish first. */
  step() {
    const q = this.q;
    switch (this.state) {
      case 'version': {
        if (q.length < 12) return false;
        const v = new TextDecoder('latin1').decode(q.read(12));
        const m = /^RFB (\d{3})\.(\d{3})\n$/.exec(v);
        if (!m || Number(m[1]) !== 3) {
          this.fail('EPROTO', 'not a VNC server');
          return false;
        }
        const minor = Number(m[2]);
        this.minor = minor >= 8 ? 8 : minor === 7 ? 7 : 3;
        this.send(new TextEncoder().encode(`RFB 003.00${this.minor}\n`));
        this.setState('security');
        return true;
      }
      case 'security': {
        if (this.minor === 3) {
          if (q.length < 4) return false;
          const type = u32(q.peek(4), 0);
          if (type === 0) return this.readReason('EREFUSED', 4);
          q.read(4);
          return this.chooseSecurity([type], false);
        }
        if (q.length < 1) return false;
        const n = q.at(0);
        if (n === 0) return this.readReason('EREFUSED', 1);
        if (q.length < 1 + n) return false;
        const types = [...q.read(1 + n).subarray(1)];
        return this.chooseSecurity(types, true);
      }
      case 'auth': {
        if (q.length < 16) return false;
        this.send(vncAuthResponse(this.o.password ?? '', q.read(16)));
        this.setState('result');
        return true;
      }
      case 'result': {
        if (q.length < 4) return false;
        const r = u32(q.peek(4), 0);
        if (r === 0) {
          q.read(4);
          this.clientInit();
          return true;
        }
        if (this.minor === 8) return this.readReason('EAUTH', 4);
        q.read(4);
        this.fail('EAUTH', '');
        return false;
      }
      case 'init': {
        if (q.length < 24) return false;
        const head = q.peek(24);
        const len = u32(head, 20);
        if (len > MAX_STRING) throw new Error('server name too long');
        if (q.length < 24 + len) return false;
        const b = q.read(24 + len);
        this.width = u16(b, 0);
        this.height = u16(b, 2);
        if (!this.width || !this.height || this.width > MAX_FB || this.height > MAX_FB) throw new Error('bad desktop size');
        this.name = new TextDecoder('utf-8').decode(b.subarray(24));
        this.sendPixelFormat();
        this.sendEncodings();
        this.setState('connected');
        this.o.onInit?.({ width: this.width, height: this.height, name: this.name });
        this.requestUpdate(false);
        return true;
      }
      case 'connected':
        return this.rectsLeft > 0 ? this.readRect() : this.readMessage();
      default:
        return false;
    }
  }
  readReason(code, skip) {
    const q = this.q;
    if (q.length < skip + 4) return false;
    const len = u32(q.peek(skip + 4), skip);
    if (len > MAX_STRING) throw new Error('reason too long');
    if (q.length < skip + 4 + len) return false;
    const b = q.read(skip + 4 + len);
    this.fail(code, new TextDecoder('utf-8').decode(b.subarray(skip + 4)));
    return false;
  }
  chooseSecurity(types, reply) {
    const hasPass = this.o.password != null && this.o.password !== '';
    let type = 0;
    if (types.includes(1)) type = 1;
    else if (types.includes(2)) {
      if (!hasPass) {
        this.fail('ENEEDPASS', '');
        return false;
      }
      type = 2;
    }
    if (!type) {
      this.fail('ENOSEC', types.join(', '));
      return false;
    }
    this.securityType = type;
    if (reply) this.send(Uint8Array.of(type));
    if (type === 2) this.setState('auth');
    else if (this.minor === 8) this.setState('result');
    else this.clientInit();
    return true;
  }
  clientInit() {
    this.send(Uint8Array.of(1)); // shared session: do not disconnect other viewers
    this.setState('init');
  }
  sendPixelFormat() {
    const b = new Uint8Array(20);
    b[0] = 0; // SetPixelFormat
    b.set([32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 0, 8, 16], 4); // bpp, depth, big-endian, true colour, max r/g/b, shifts r/g/b
    this.send(b);
  }
  encodings() {
    if (Array.isArray(this.o.encodings)) return this.o.encodings;
    const jpeg = typeof this.o.onJpeg === 'function';
    return [
      ENC.COPYRECT,
      ENC.TIGHT,
      ENC.ZRLE,
      ENC.HEXTILE,
      ENC.RAW,
      ...(jpeg ? [ENC.JPEG_QUALITY_6] : []),
      ENC.COMPRESS_2,
      ENC.DESKTOPSIZE,
      ENC.LASTRECT,
      ...(this.o.onCursor ? [ENC.CURSOR] : []),
      ENC.EXT_CLIPBOARD,
    ];
  }
  sendEncodings() {
    const encs = this.encodings();
    const b = new Uint8Array(4 + encs.length * 4);
    const dv = new DataView(b.buffer);
    b[0] = 2;
    dv.setUint16(2, encs.length);
    encs.forEach((e, i) => dv.setInt32(4 + i * 4, e));
    this.send(b);
  }
  requestUpdate(incremental = true) {
    if (this.state !== 'connected') return;
    const b = new Uint8Array(10);
    const dv = new DataView(b.buffer);
    b[0] = 3;
    b[1] = incremental ? 1 : 0;
    dv.setUint16(6, this.width);
    dv.setUint16(8, this.height);
    this.send(b);
  }
  readMessage() {
    const q = this.q;
    if (q.length < 1) return false;
    const type = q.at(0);
    if (type === 0) {
      if (q.length < 4) return false;
      const b = q.read(4);
      this.rectsLeft = u16(b, 2);
      if (!this.rectsLeft) this.updateDone();
      return true;
    }
    if (type === 1) {
      if (q.length < 6) return false;
      const n = u16(q.peek(6), 4);
      if (q.length < 6 + n * 6) return false;
      q.read(6 + n * 6); // colour map: unused with true colour
      return true;
    }
    if (type === 2) {
      q.read(1);
      this.o.onBell?.();
      return true;
    }
    if (type === 3) {
      if (q.length < 8) return false;
      const len = s32(q.peek(8), 4);
      const n = Math.abs(len);
      if (n > MAX_CLIP) throw new Error('clipboard text too long');
      if (q.length < 8 + n) return false;
      const b = q.read(8 + n).subarray(8);
      if (len >= 0) this.o.onCutText?.(latin1(b));
      else this.extendedClipboardMessage(b);
      return true;
    }
    throw new Error(`unknown server message ${type}`);
  }
  inScreen(r) {
    if (r.x + r.w > this.width || r.y + r.h > this.height) throw new Error('rectangle outside the screen');
  }
  readRect() {
    const q = this.q;
    if (!this.rect) {
      if (q.length < 12) return false;
      const b = q.read(12);
      this.rect = { x: u16(b, 0), y: u16(b, 2), w: u16(b, 4), h: u16(b, 6), enc: s32(b, 8) };
      const r = this.rect;
      // Checked before waiting for the data, so a bogus header cannot make us buffer gigabytes.
      if (r.enc >= 0) this.inScreen(r);
    }
    const r = this.rect;
    switch (r.enc) {
      case ENC.RAW: {
        const n = r.w * r.h * 4;
        if (q.length < n) return false;
        if (n) {
          const px = q.read(n);
          for (let i = 3; i < n; i += 4) px[i] = 255;
          this.o.onRaw?.(r.x, r.y, r.w, r.h, px);
        }
        break;
      }
      case ENC.COPYRECT: {
        if (q.length < 4) return false;
        const b = q.read(4);
        const sx = u16(b, 0);
        const sy = u16(b, 2);
        if (sx + r.w > this.width || sy + r.h > this.height) throw new Error('CopyRect source outside the screen');
        if (r.w && r.h) this.o.onCopy?.(sx, sy, r.x, r.y, r.w, r.h);
        break;
      }
      case ENC.HEXTILE:
        if (!this.hextile(r)) return false;
        break;
      case ENC.ZRLE:
        if (!this.zrleRect(r)) return false;
        break;
      case ENC.TIGHT: {
        const res = this.tight(r);
        if (!res) return false;
        if (typeof res.then === 'function') return res.then(() => this.rectDone());
        break;
      }
      case ENC.DESKTOPSIZE:
        if (!r.w || !r.h || r.w > MAX_FB || r.h > MAX_FB) throw new Error('bad desktop size');
        this.width = r.w;
        this.height = r.h;
        this.resized = true;
        this.o.onResize?.(r.w, r.h);
        break;
      case ENC.LASTRECT:
        this.rect = null;
        this.rectsLeft = 0;
        this.updateDone();
        return true;
      case ENC.CURSOR: {
        if (r.w > MAX_CURSOR || r.h > MAX_CURSOR) throw new Error('cursor too large');
        const mask = ((r.w + 7) >> 3) * r.h;
        const n = r.w * r.h * 4 + mask;
        if (q.length < n) return false;
        const b = q.read(n);
        const px = b.subarray(0, r.w * r.h * 4);
        const m = b.subarray(r.w * r.h * 4);
        const stride = (r.w + 7) >> 3;
        for (let y = 0; y < r.h; y++)
          for (let x = 0; x < r.w; x++) px[(y * r.w + x) * 4 + 3] = m[y * stride + (x >> 3)] & (0x80 >> (x & 7)) ? 255 : 0;
        this.o.onCursor?.({ hotX: r.x, hotY: r.y, w: r.w, h: r.h, rgba: px });
        break;
      }
      default:
        throw new Error(`unsupported encoding ${r.enc}`);
    }
    return this.rectDone();
  }
  rectDone() {
    this.rect = null;
    if (--this.rectsLeft === 0) this.updateDone();
    return true;
  }
  updateDone() {
    const full = this.resized;
    this.resized = false;
    this.o.onUpdate?.();
    this.requestUpdate(!full);
  }

  // ---------------------------------------------------------------- Hextile (RFC 6143 §7.7.4)
  hextile(r) {
    const q = this.q;
    if (!r.buf) {
      r.buf = new Uint8Array(r.w * r.h * 4);
      r.tx = 0;
      r.ty = 0;
      r.bg = [0, 0, 0];
      r.fg = [0, 0, 0];
    }
    const buf = r.buf;
    const fill = (x0, y0, w, h, c) => {
      for (let y = y0; y < y0 + h; y++) {
        let o = (y * r.w + x0) * 4;
        for (let x = 0; x < w; x++, o += 4) {
          buf[o] = c[0];
          buf[o + 1] = c[1];
          buf[o + 2] = c[2];
          buf[o + 3] = 255;
        }
      }
    };
    while (r.ty < r.h) {
      const tw = Math.min(16, r.w - r.tx);
      const th = Math.min(16, r.h - r.ty);
      if (q.length < 1) return false;
      const sub = q.at(0);
      let need = 1;
      if (sub & 1) need += tw * th * 4;
      else {
        if (sub & 2) need += 4;
        if (sub & 4) need += 4;
        if (sub & 8) {
          if (q.length < need + 1) return false;
          need += 1 + q.at(need) * (sub & 16 ? 6 : 2);
        }
      }
      if (q.length < need) return false;
      const b = q.read(need);
      if (sub & 1) {
        for (let y = 0; y < th; y++)
          for (let x = 0; x < tw; x++) {
            const i = (y * tw + x) * 4;
            const o = ((r.ty + y) * r.w + r.tx + x) * 4;
            buf[o] = b[i + 1];
            buf[o + 1] = b[i + 2];
            buf[o + 2] = b[i + 3];
            buf[o + 3] = 255;
          }
      } else {
        let p = 1;
        if (sub & 2) {
          r.bg = [b[p], b[p + 1], b[p + 2]];
          p += 4;
        }
        if (sub & 4) {
          r.fg = [b[p], b[p + 1], b[p + 2]];
          p += 4;
        }
        fill(r.tx, r.ty, tw, th, r.bg);
        if (sub & 8) {
          const n = b[p++];
          for (let i = 0; i < n; i++) {
            let c = r.fg;
            if (sub & 16) {
              c = [b[p], b[p + 1], b[p + 2]];
              p += 4;
            }
            const xy = b[p++];
            const wh = b[p++];
            const sx = xy >> 4;
            const sy = xy & 15;
            const sw = (wh >> 4) + 1;
            const sh = (wh & 15) + 1;
            if (sx + sw > tw || sy + sh > th) throw new Error('hextile subrectangle outside its tile');
            fill(r.tx + sx, r.ty + sy, sw, sh, c);
          }
        }
      }
      r.tx += 16;
      if (r.tx >= r.w) {
        r.tx = 0;
        r.ty += 16;
      }
    }
    if (r.w && r.h) this.o.onRaw?.(r.x, r.y, r.w, r.h, buf);
    return true;
  }

  // ---------------------------------------------------------------- ZRLE (RFC 6143 §7.7.6)
  zrleRect(r) {
    const q = this.q;
    if (q.length < 4) return false;
    const len = u32(q.peek(4), 0);
    if (len > 64 << 20) throw new Error('ZRLE data too large');
    if (q.length < 4 + len) return false;
    const data = (this.zrle ||= new ZlibStream()).push(q.read(4 + len).subarray(4));
    const buf = new Uint8Array(r.w * r.h * 4);
    let p = 0;
    const need = (n) => {
      if (p + n > data.length) throw new Error('ZRLE data ended early');
    };
    const cpixel = () => {
      need(3);
      const c = [data[p], data[p + 1], data[p + 2]];
      p += 3;
      return c;
    };
    const put = (o, c) => {
      buf[o] = c[0];
      buf[o + 1] = c[1];
      buf[o + 2] = c[2];
      buf[o + 3] = 255;
    };
    for (let ty = 0; ty < r.h; ty += 64)
      for (let tx = 0; tx < r.w; tx += 64) {
        const tw = Math.min(64, r.w - tx);
        const th = Math.min(64, r.h - ty);
        const at = (i) => ((ty + Math.floor(i / tw)) * r.w + tx + (i % tw)) * 4;
        need(1);
        const sub = data[p++];
        if (sub === 0) {
          for (let i = 0; i < tw * th; i++) put(at(i), cpixel());
        } else if (sub === 1) {
          const c = cpixel();
          for (let i = 0; i < tw * th; i++) put(at(i), c);
        } else if (sub <= 16) {
          const pal = [];
          for (let i = 0; i < sub; i++) pal.push(cpixel());
          const bpp = sub === 2 ? 1 : sub <= 4 ? 2 : 4;
          const stride = Math.ceil((tw * bpp) / 8);
          need(stride * th);
          for (let y = 0; y < th; y++)
            for (let x = 0; x < tw; x++) {
              const bit = x * bpp;
              const v = (data[p + y * stride + (bit >> 3)] >> (8 - bpp - (bit & 7))) & ((1 << bpp) - 1);
              if (v >= sub) throw new Error('ZRLE palette index out of range');
              put(at(y * tw + x), pal[v]);
            }
          p += stride * th;
        } else if (sub === 128 || sub >= 130) {
          const pal = [];
          if (sub >= 130) for (let i = 0; i < sub - 128; i++) pal.push(cpixel());
          for (let i = 0; i < tw * th; ) {
            let c;
            let run = 1;
            if (sub === 128) {
              c = cpixel();
              run = 0;
            } else {
              need(1);
              const v = data[p++];
              if ((v & 127) >= pal.length) throw new Error('ZRLE palette index out of range');
              c = pal[v & 127];
              if (v & 128) run = 0;
            }
            if (!run) {
              run = 1;
              for (;;) {
                need(1);
                const b = data[p++];
                run += b;
                if (b !== 255) break;
              }
            }
            if (i + run > tw * th) throw new Error('ZRLE run too long');
            for (let k = 0; k < run; k++) put(at(i++), c);
          }
        } else throw new Error(`bad ZRLE subencoding ${sub}`);
      }
    if (r.w && r.h) this.o.onRaw?.(r.x, r.y, r.w, r.h, buf);
    return true;
  }

  // ---------------------------------------------------------------- Tight (TightVNC / TigerVNC)
  // Returns false (more bytes needed), true (rectangle drawn) or a promise (JPEG being decoded).
  tight(r) {
    const q = this.q;
    if (q.length < 1) return false;
    const cc = q.at(0);
    const kind = cc >> 4;
    if (kind === 8) {
      if (q.length < 4) return false;
      const b = q.read(4);
      this.resetTight(cc);
      const buf = new Uint8Array(r.w * r.h * 4);
      for (let o = 0; o < buf.length; o += 4) {
        buf[o] = b[1];
        buf[o + 1] = b[2];
        buf[o + 2] = b[3];
        buf[o + 3] = 255;
      }
      if (r.w && r.h) this.o.onRaw?.(r.x, r.y, r.w, r.h, buf);
      return true;
    }
    if (kind === 9) {
      const cl = compactLength(q, 1);
      if (!cl) return false;
      if (cl[0] > 64 << 20) throw new Error('JPEG too large');
      if (q.length < 1 + cl[1] + cl[0]) return false;
      const jpeg = q.read(1 + cl[1] + cl[0]).subarray(1 + cl[1]);
      this.resetTight(cc);
      if (typeof this.o.onJpeg !== 'function') throw new Error('unexpected JPEG rectangle');
      return Promise.resolve(this.o.onJpeg(r.x, r.y, r.w, r.h, jpeg)).then(() => true);
    }
    if (kind > 9 || (kind & 8)) throw new Error(`unsupported Tight compression ${kind}`);
    // basic compression: [filter id] [palette] data
    const stream = (cc >> 4) & 3;
    let off = 1;
    let filter = 0;
    if (cc & 0x40) {
      if (q.length < off + 1) return false;
      filter = q.at(off++);
    }
    let pal = null;
    let size = r.w * r.h * 3;
    if (filter === 1) {
      if (q.length < off + 1) return false;
      const n = q.at(off) + 1;
      if (q.length < off + 1 + n * 3) return false;
      pal = [];
      for (let i = 0; i < n; i++) pal.push([q.at(off + 1 + i * 3), q.at(off + 2 + i * 3), q.at(off + 3 + i * 3)]);
      off += 1 + n * 3;
      size = n === 2 ? ((r.w + 7) >> 3) * r.h : r.w * r.h;
    } else if (filter !== 0 && filter !== 2) throw new Error(`bad Tight filter ${filter}`);
    let data;
    if (size < 12) {
      if (q.length < off + size) return false;
      data = q.read(off + size).subarray(off);
      this.resetTight(cc);
    } else {
      const cl = compactLength(q, off);
      if (!cl) return false;
      if (cl[0] > 64 << 20) throw new Error('Tight data too large');
      if (q.length < off + cl[1] + cl[0]) return false;
      const z = q.read(off + cl[1] + cl[0]).subarray(off + cl[1]);
      this.resetTight(cc);
      data = (this.tightZ[stream] ||= new ZlibStream()).push(z);
    }
    if (data.length < size) throw new Error('Tight data ended early');
    const buf = new Uint8Array(r.w * r.h * 4);
    if (filter === 1) {
      const two = pal.length === 2;
      const stride = (r.w + 7) >> 3;
      for (let y = 0; y < r.h; y++)
        for (let x = 0; x < r.w; x++) {
          const v = two ? (data[y * stride + (x >> 3)] >> (7 - (x & 7))) & 1 : data[y * r.w + x];
          const c = pal[v];
          if (!c) throw new Error('Tight palette index out of range');
          const o = (y * r.w + x) * 4;
          buf[o] = c[0];
          buf[o + 1] = c[1];
          buf[o + 2] = c[2];
          buf[o + 3] = 255;
        }
    } else if (filter === 2) {
      // gradient: each component = prediction (left + above - above-left, clamped) + data
      for (let y = 0; y < r.h; y++)
        for (let x = 0; x < r.w; x++) {
          const o = (y * r.w + x) * 4;
          const i = (y * r.w + x) * 3;
          for (let c = 0; c < 3; c++) {
            const left = x ? buf[o - 4 + c] : 0;
            const up = y ? buf[o - r.w * 4 + c] : 0;
            const ul = x && y ? buf[o - r.w * 4 - 4 + c] : 0;
            const pred = Math.max(0, Math.min(255, left + up - ul));
            buf[o + c] = (pred + data[i + c]) & 255;
          }
          buf[o + 3] = 255;
        }
    } else {
      for (let i = 0, o = 0; o < buf.length; i += 3, o += 4) {
        buf[o] = data[i];
        buf[o + 1] = data[i + 1];
        buf[o + 2] = data[i + 2];
        buf[o + 3] = 255;
      }
    }
    if (r.w && r.h) this.o.onRaw?.(r.x, r.y, r.w, r.h, buf);
    return true;
  }
  resetTight(cc) {
    for (let i = 0; i < 4; i++) if (cc & (1 << i)) this.tightZ[i] = null;
  }

  // ---------------------------------------------------------------- clipboard
  extendedClipboardMessage(b) {
    if (b.length < 4) throw new Error('bad extended clipboard message');
    const flags = u32(b, 0);
    if (flags & CB.CAPS) {
      this.extendedClipboard = true;
      this.clipServer = { actions: flags & 0xff000000, formats: flags & 0xffff };
      // our capabilities: text only; accept up to 8 MiB unsolicited
      this.sendExtendedClipboard(CB.CAPS | CB.REQUEST | CB.PEEK | CB.NOTIFY | CB.PROVIDE | CB.TEXT, Uint8Array.of(0, 0x80, 0, 0));
      return;
    }
    if (flags & CB.REQUEST) {
      if (flags & CB.TEXT && this.clipText != null) this.provideText(this.clipText);
      return;
    }
    if (flags & CB.PEEK) {
      this.sendExtendedClipboard(CB.NOTIFY | (this.clipText != null ? CB.TEXT : 0));
      return;
    }
    if (flags & CB.NOTIFY) {
      if (flags & CB.TEXT) this.sendExtendedClipboard(CB.REQUEST | CB.TEXT);
      return;
    }
    if (flags & CB.PROVIDE) {
      if (!(flags & CB.TEXT)) return;
      const data = new ZlibStream().push(b.subarray(4));
      if (data.length < 4) return;
      const n = u32(data, 0); // text is the first (lowest) format
      let text = new TextDecoder('utf-8').decode(data.subarray(4, 4 + Math.min(n, data.length - 4)));
      text = text.replace(/\0+$/, '').replace(/\r\n/g, '\n');
      this.o.onCutText?.(text);
    }
  }
  sendExtendedClipboard(flags, payload = new Uint8Array(0)) {
    if (this.state !== 'connected') return;
    const b = new Uint8Array(8 + 4 + payload.length);
    const dv = new DataView(b.buffer);
    b[0] = 6;
    dv.setInt32(4, -(4 + payload.length));
    dv.setUint32(8, flags >>> 0);
    b.set(payload, 12);
    this.send(b);
  }
  provideText(text) {
    const utf8 = new TextEncoder().encode(`${text.replace(/\r?\n/g, '\r\n')}\0`);
    const raw = new Uint8Array(4 + utf8.length);
    new DataView(raw.buffer).setUint32(0, utf8.length);
    raw.set(utf8, 4);
    this.sendExtendedClipboard(CB.PROVIDE | CB.TEXT, zlibStore(raw));
  }
  /** The local clipboard changed: offer it to the server (UTF-8 with the extended clipboard, else Latin-1). */
  clipboard(text) {
    if (this.state !== 'connected' || typeof text !== 'string') return;
    text = text.slice(0, MAX_CLIP / 4);
    if (this.extendedClipboard && this.clipServer.formats & CB.TEXT) {
      this.clipText = text;
      if (this.clipServer.actions & CB.NOTIFY) this.sendExtendedClipboard(CB.NOTIFY | CB.TEXT);
      else this.provideText(text);
      return;
    }
    // RFB ClientCutText: ISO 8859-1, lines end with a single LF
    const s = text.replace(/\r\n?/g, '\n');
    const b = new Uint8Array(8 + s.length);
    const dv = new DataView(b.buffer);
    b[0] = 6;
    dv.setUint32(4, s.length);
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      b[8 + i] = c < 256 ? c : 0x3f; // '?'
    }
    this.send(b);
  }

  // ---------------------------------------------------------------- input
  pointer(x, y, mask) {
    if (this.state !== 'connected') return;
    const b = new Uint8Array(6);
    const dv = new DataView(b.buffer);
    b[0] = 5;
    b[1] = mask & 0xff;
    dv.setUint16(2, Math.max(0, Math.min(this.width - 1, Math.floor(x))));
    dv.setUint16(4, Math.max(0, Math.min(this.height - 1, Math.floor(y))));
    this.send(b);
  }
  key(keysym, down) {
    if (this.state !== 'connected' || !keysym) return;
    const b = new Uint8Array(8);
    const dv = new DataView(b.buffer);
    b[0] = 4;
    b[1] = down ? 1 : 0;
    dv.setUint32(4, keysym >>> 0);
    this.send(b);
  }
  ctrlAltDel() {
    this.key(KEYSYM.Control_L, true);
    this.key(KEYSYM.Alt_L, true);
    this.key(KEYSYM.Delete, true);
    this.key(KEYSYM.Delete, false);
    this.key(KEYSYM.Alt_L, false);
    this.key(KEYSYM.Control_L, false);
  }
}
