// RFB 3.8 (VNC) client protocol, DOM-free: the app feeds it the bytes from main/ipc/remote.js and draws what it reports.
// Also speaks 3.7 and 3.3 servers. Security: None (1) and VNC Authentication (2). Encodings: Raw, CopyRect and the
// DesktopSize pseudo-encoding. Pixel format asked from the server: 32 bpp true colour, bytes R G B X.
//
//   const c = new RfbClient({ write(bytes), password, onInit({ width, height, name }), onRaw(x, y, w, h, rgba),
//     onCopy(sx, sy, x, y, w, h), onResize(w, h), onBell(), onCutText(text), onState(state), onError({ code, message }) });
//   c.receive(uint8array)   c.pointer(x, y, mask)   c.key(keysym, down)   c.ctrlAltDel()
// States: version, security, auth, result, init, connected, failed. Error codes: EPROTO (not a VNC server or broken
// stream), ENEEDPASS (the server wants a password and none was given), EAUTH (wrong password), ENOSEC (no supported
// security type), EREFUSED (the server refused us, message = its reason).
import { vncAuthResponse } from './des.js';
import { KEYSYM } from './keysym.js';

export const ENC = { RAW: 0, COPYRECT: 1, DESKTOPSIZE: -223 };
const MAX_STRING = 1 << 20;
const MAX_FB = 16384;

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
}

const u16 = (b, o) => (b[o] << 8) | b[o + 1];
const u32 = (b, o) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
const s32 = (b, o) => u32(b, o) | 0;

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
    try {
      while (this.state !== 'failed' && this.step());
    } catch (e) {
      this.fail('EPROTO', e?.message || e);
    }
  }
  /** One parsing step; false when more bytes are needed. */
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
        const n = q.peek(1)[0];
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
  sendEncodings() {
    const encs = [ENC.COPYRECT, ENC.RAW, ENC.DESKTOPSIZE];
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
    const type = q.peek(1)[0];
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
      const len = u32(q.peek(8), 4);
      if (len > MAX_STRING * 8) throw new Error('clipboard text too long');
      if (q.length < 8 + len) return false;
      const b = q.read(8 + len);
      this.o.onCutText?.(new TextDecoder('latin1').decode(b.subarray(8)));
      return true;
    }
    throw new Error(`unknown server message ${type}`);
  }
  readRect() {
    const q = this.q;
    if (!this.rect) {
      if (q.length < 12) return false;
      const b = q.read(12);
      this.rect = { x: u16(b, 0), y: u16(b, 2), w: u16(b, 4), h: u16(b, 6), enc: s32(b, 8) };
    }
    const r = this.rect;
    if (r.enc === ENC.RAW) {
      const n = r.w * r.h * 4;
      if (q.length < n) return false;
      const px = q.read(n);
      for (let i = 3; i < n; i += 4) px[i] = 255;
      if (r.x + r.w > this.width || r.y + r.h > this.height) throw new Error('rectangle outside the screen');
      this.o.onRaw?.(r.x, r.y, r.w, r.h, px);
    } else if (r.enc === ENC.COPYRECT) {
      if (q.length < 4) return false;
      const b = q.read(4);
      this.o.onCopy?.(u16(b, 0), u16(b, 2), r.x, r.y, r.w, r.h);
    } else if (r.enc === ENC.DESKTOPSIZE) {
      if (!r.w || !r.h || r.w > MAX_FB || r.h > MAX_FB) throw new Error('bad desktop size');
      this.width = r.w;
      this.height = r.h;
      this.resized = true;
      this.o.onResize?.(r.w, r.h);
    } else throw new Error(`unsupported encoding ${r.enc}`);
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
  pointer(x, y, mask) {
    if (this.state !== 'connected') return;
    const b = new Uint8Array(6);
    const dv = new DataView(b.buffer);
    b[0] = 5;
    b[1] = mask & 0xff;
    dv.setUint16(2, Math.max(0, Math.min(this.width - 1, Math.round(x))));
    dv.setUint16(4, Math.max(0, Math.min(this.height - 1, Math.round(y))));
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
