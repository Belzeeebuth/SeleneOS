// Remote Desktop, second suite: the zlib decoder, the VNC encodings (CopyRect, Hextile, ZRLE, Tight incl. JPEG,
// Cursor, LastRect, DesktopSize) checked pixel by pixel against server-side encoders (test/fixtures/remote/rfb-encode.mjs),
// the clipboard both ways (Latin-1 and the extended UTF-8 clipboard), main/lib/freerdp.js, and in the real shell: VNC
// encodings + clipboard on the canvas, and RDP through a fake xfreerdp3 (test/fixtures/remote/bin, first on PATH) whose
// window comes through the fake aurora-xwm (test/fixtures/xwm-fake). Never runs a real FreeRDP, never leaves loopback.
// Usage:  cd aurora-os/shell && xvfb-run -a -s "-screen 0 1600x900x24" node test/remote-extra.test.mjs
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { launchShell, ROOT } from './lib.mjs';
import * as E from './fixtures/remote/rfb-encode.mjs';

const require = createRequire(import.meta.url);
const LIB = path.join(ROOT, 'renderer', 'apps', 'remote', 'lib');
const { RfbClient, ENC } = await import(pathToFileURL(path.join(LIB, 'rfb.js')).href);
const { ZlibStream, zlibStore, adler32 } = await import(pathToFileURL(path.join(LIB, 'inflate.js')).href);
const rdp = require('../main/lib/freerdp.js');
const FAKE_BIN = path.join(ROOT, 'test', 'fixtures', 'remote', 'bin');
const FAKE_XWM = path.join(ROOT, 'test', 'fixtures', 'xwm-fake', 'aurora-xwm');
const DOCS = path.join(ROOT, '..', 'docs', 'screenshots');
fs.mkdirSync(DOCS, { recursive: true });
fs.chmodSync(path.join(FAKE_BIN, 'xfreerdp3'), 0o755);
const WIN = '.win.app-remote';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
const failures = [];
function check(name, actual, expected) {
  const ok = typeof expected === 'function' ? !!expected(actual) : Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++;
  else failures.push(`${name}\n      expected: ${typeof expected === 'function' ? '(predicate)' : JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)?.slice(0, 600)}`);
  return ok;
}
async function section(name, fn) {
  const t0 = Date.now();
  const before = failures.length;
  try {
    await fn();
    console.log(`  ${failures.length === before ? '✓' : '✗'} ${name} (${Date.now() - t0} ms)`);
  } catch (err) {
    failures.push(`${name}: threw ${err?.stack || err}`);
    console.log(`  ✗ ${name}: ${err?.message || err}`);
  }
}
async function until(fn, timeout = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await Promise.resolve().then(fn).catch(() => false)) return true;
    await sleep(60);
  }
  return false;
}
// seeded random
let seed = 12345;
const rnd = (n) => ((seed = (seed * 1103515245 + 12345) >>> 0) >>> 8) % n;
/** Feed bytes to the client in random-sized chunks (1..max). */
function feed(c, bytes, max = 97) {
  for (let i = 0; i < bytes.length; ) {
    const n = 1 + rnd(max);
    c.receive(new Uint8Array(bytes.subarray(i, i + n)));
    i += n;
  }
}
const serverInit = (w, h, name = 'enc') => {
  const n = Buffer.from(name);
  const si = Buffer.alloc(24);
  si.writeUInt16BE(w, 0);
  si.writeUInt16BE(h, 2);
  si.set([32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0], 4);
  si.writeUInt32BE(n.length, 20);
  return Buffer.concat([Buffer.from('RFB 003.008\n'), Buffer.from([1, 1]), E.u32(0), si, n]);
};
/** Messages the client wrote, parsed (SetPixelFormat, SetEncodings, update requests, keys, pointer, cut text). */
function parseClient(chunks) {
  let b = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  const out = [];
  // skip the 12-byte version, security choice and shared flag when present
  if (b.subarray(0, 4).toString() === 'RFB ') b = b.subarray(12 + 1 + 1);
  while (b.length) {
    const t = b[0];
    let n;
    if (t === 0) n = 20;
    else if (t === 2) n = 4 + b.readUInt16BE(2) * 4;
    else if (t === 3) n = 10;
    else if (t === 4) n = 8;
    else if (t === 5) n = 6;
    else if (t === 6) n = 8 + Math.abs(b.readInt32BE(4));
    else break;
    const m = b.subarray(0, n);
    b = b.subarray(n);
    if (t === 2) out.push({ t, encodings: Array.from({ length: m.readUInt16BE(2) }, (_, i) => m.readInt32BE(4 + i * 4)) });
    else if (t === 3) out.push({ t, incremental: m[1] });
    else if (t === 4) out.push({ t, down: m[1], keysym: m.readUInt32BE(4) });
    else if (t === 6) out.push({ t, len: m.readInt32BE(4), body: Buffer.from(m.subarray(8)) });
    else out.push({ t });
  }
  return out;
}

// ================================================================ units (Node)
await section('zlib stream decoder (lib/inflate.js)', async () => {
  const text = Buffer.from('Selene OS remote desktop — ZRLE & Tight keep one zlib stream. '.repeat(400));
  const noise = Buffer.from(Array.from({ length: 30000 }, () => rnd(256)));
  const mixed = Buffer.concat([text, noise, Buffer.alloc(5000, 7), text.subarray(0, 3000)]);
  for (const level of [0, 1, 6, 9]) {
    const z = zlib.deflateSync(mixed, { level });
    const s = new ZlibStream();
    const parts = [];
    // pieces cut anywhere (inside blocks and inside Huffman codes): the decoder keeps the unfinished block
    for (let i = 0; i < z.length; ) {
      const n = 1 + rnd(700);
      parts.push(s.push(new Uint8Array(z.subarray(i, i + n))));
      i += n;
    }
    const out = Buffer.concat(parts.map((p) => Buffer.from(p)));
    check(`level ${level}: decoded = original (${mixed.length} bytes)`, out.equals(mixed), true);
  }
  // one stream, sync-flushed pieces (what VNC servers send): history window shared across pieces
  const d = new E.Deflater(6);
  const s = new ZlibStream();
  let ok = true;
  for (let i = 0; i < 20; i++) {
    const piece = Buffer.concat([text.subarray(i * 50, i * 50 + 800), noise.subarray(i * 100, i * 100 + 300)]);
    const out = Buffer.from(s.push(new Uint8Array(await d.push(piece))));
    if (!out.equals(piece)) ok = false;
  }
  check('sync-flushed pieces decode one by one, back references across pieces', ok, true);
  const stored = zlibStore(new TextEncoder().encode('héllo'));
  check('zlibStore: valid zlib (Node inflates it)', zlib.inflateSync(Buffer.from(stored)).toString(), 'héllo');
  check('adler32 matches zlib', adler32(new TextEncoder().encode('Wikipedia')), 0x11e60398);
  let threw = null;
  try {
    new ZlibStream().push(Uint8Array.of(0x78, 0x9c, 0xff, 0xff, 0xff, 0xff));
  } catch (e) {
    threw = e.message;
  }
  check('corrupt stream throws', !!threw, true);
  threw = null;
  try {
    new ZlibStream().push(Uint8Array.of(0x12, 0x34));
  } catch (e) {
    threw = e.message;
  }
  check('bad zlib header throws', threw, 'bad zlib header');
});

const W = 150;
const H = 90; // not multiples of 16 / 64: edge tiles are checked too
const PIC = E.testPattern(W, H, 7);

await section('VNC encodings decoded pixel by pixel (Node)', async () => {
  const zr = new E.Deflater();
  const tz = [new E.Deflater(), new E.Deflater(), new E.Deflater(), new E.Deflater()];
  // the picture cut in strips, each strip in another encoding
  const strips = [];
  const strip = (x, w, enc, body) => strips.push(Buffer.concat([E.rectHeader(x, 0, w, H, enc), body]));
  const part = (x, w) => E.crop(PIC, x, 0, w, H);
  strip(0, 20, ENC.RAW, E.raw(part(0, 20)));
  strip(20, 30, ENC.HEXTILE, E.hextile(part(20, 30)));
  strip(50, 30, ENC.ZRLE, await E.zrle(part(50, 30), zr));
  strip(80, 70, ENC.ZRLE, await E.zrle(part(80, 70), zr)); // same zlib stream, second rectangle
  const upd1 = Buffer.concat([E.updateHeader(strips.length), ...strips]);
  // second update: Tight variants over the same picture (top band), fill + mono + palette + gradient + copy
  const t = [];
  const trect = async (x, y, w, h, kind, opts) => t.push(Buffer.concat([E.rectHeader(x, y, w, h, ENC.TIGHT), await E.tight(E.crop(PIC, x, y, w, h), kind, tz, opts)]));
  await trect(0, 0, W, 6, 'fill', { reset: 15 });
  await trect(30, 10, 25, 30, 'mono'); // zone 1: two colours
  await trect(60, 10, 30, 40, 'palette'); // zone 2: five colours
  await trect(0, 10, 30, 70, 'gradient');
  await trect(90, 10, 30, 30, 'copy');
  await trect(90, 40, 30, 30, 'copy'); // stream 0 again (continuous)
  await trect(120, 60, 2, 1, 'copy'); // 6 bytes: sent uncompressed
  const upd2 = Buffer.concat([E.updateHeader(t.length), ...t]);
  // third update: CopyRect + LastRect (count 0xFFFF)
  const upd3 = Buffer.concat([E.updateHeader(0xffff), E.rectHeader(100, 70, 40, 15, ENC.COPYRECT), Buffer.from([0, 5, 0, 8]), E.rectHeader(0, 0, 0, 0, ENC.LASTRECT)]);
  const expected = E.framebuffer(W, H);
  expected.raw(0, 0, W, H, PIC.px);
  expected.copy(5, 8, 100, 70, 40, 15);

  const fb = E.framebuffer(W, H);
  const writes = [];
  const ev = { errors: [], updates: 0 };
  const c = new RfbClient({ write: (b) => writes.push(b), onRaw: fb.raw, onCopy: fb.copy, onError: (e) => ev.errors.push(e), onUpdate: () => ev.updates++ });
  feed(c, serverInit(W, H));
  feed(c, upd1);
  const fb1 = E.diff(fb, PIC);
  feed(c, upd2);
  const fb2 = E.diff(fb, PIC);
  feed(c, upd3);
  check('no decoding errors', ev.errors, []);
  check('Raw + Hextile + ZRLE strips = picture', fb1, 0);
  check('after the Tight rectangles, still = picture', fb2, 0);
  check('CopyRect + LastRect: framebuffer = expected', E.diff(fb, expected), 0);
  check('three updates completed (LastRect ends the third)', ev.updates, 3);
  const msgs = parseClient(writes);
  check('SetEncodings: CopyRect, Tight, ZRLE, Hextile, Raw, then pseudo-encodings', msgs.find((m) => m.t === 2)?.encodings, [1, 7, 16, 5, 0, -254, -223, -224, -1063131698]);
  check('an update request after each update (4: first + 3)', msgs.filter((m) => m.t === 3).length, 4);

  // every ZRLE subencoding forced on its own (raw, solid, packed palette, plain RLE, palette RLE)
  for (const force of ['raw', 'rle', 'prle', 'packed']) {
    const img = force === 'packed' || force === 'prle' ? E.crop(PIC, 30, 6, 70, 70) : E.crop(PIC, 0, 0, 100, 80);
    const pal = new Set();
    for (let i = 0; i < img.w * img.h; i++) pal.add(`${img.px[i * 4]},${img.px[i * 4 + 1]},${img.px[i * 4 + 2]}`);
    if ((force === 'packed' && pal.size > 16) || (force === 'prle' && pal.size > 127)) continue;
    const f2 = E.framebuffer(img.w, img.h);
    const errs = [];
    const c2 = new RfbClient({ write: () => {}, onRaw: f2.raw, onError: (e) => errs.push(e) });
    feed(c2, serverInit(img.w, img.h));
    feed(c2, Buffer.concat([E.updateHeader(1), E.rectHeader(0, 0, img.w, img.h, ENC.ZRLE), await E.zrle(img, new E.Deflater(), { force })]));
    check(`ZRLE ${force}: pixels`, [errs.length, E.diff(f2, img)], [0, 0]);
  }
});

await section('Tight JPEG keeps the order, Cursor, DesktopSize (Node)', async () => {
  const order = [];
  let release;
  const cursors = [];
  const c = new RfbClient({
    write: () => {},
    onRaw: (x) => order.push(`raw@${x}`),
    onJpeg: (x, y, w, h, bytes) => {
      order.push(`jpeg@${x}:${bytes.length}`);
      return new Promise((r) => (release = r)).then(() => order.push('jpeg done'));
    },
    onCursor: (cur) => cursors.push(cur),
    onResize: (w, h) => order.push(`resize ${w}x${h}`),
    onError: (e) => order.push(`error ${e.message}`),
  });
  check('JPEG quality pseudo-encoding offered when JPEG can be decoded, Cursor too', c.encodings(), [1, 7, 16, 5, 0, -26, -254, -223, -224, -239, -1063131698]);
  const jpeg = Buffer.from([0xff, 0xd8, ...new Array(300).fill(1), 0xff, 0xd9]);
  const curImg = E.image(4, 3, (x, y) => [x * 60, y * 80, 200]);
  feed(
    c,
    Buffer.concat([
      serverInit(64, 32),
      E.updateHeader(4),
      E.rectHeader(0, 0, 16, 16, ENC.TIGHT),
      await E.tight(E.image(16, 16, () => [1, 2, 3]), 'jpeg', [], { jpeg }),
      E.rectHeader(20, 0, 2, 2, ENC.RAW),
      E.raw(E.image(2, 2, () => [9, 9, 9])),
      E.rectHeader(1, 2, 4, 3, ENC.CURSOR),
      E.cursor(curImg, (x, y) => x !== y),
      E.rectHeader(0, 0, 80, 40, ENC.DESKTOPSIZE),
    ]),
  );
  check('while the JPEG decodes, nothing after it is drawn', order, ['jpeg@0:304']);
  release();
  await until(() => order.length >= 3, 2000);
  check('then the next rectangles, in order', order, ['jpeg@0:304', 'jpeg done', 'raw@20', 'resize 80x40']);
  check('cursor: size + hotspot', cursors[0] && [cursors[0].w, cursors[0].h, cursors[0].hotX, cursors[0].hotY], [4, 3, 1, 2]);
  check('cursor: colour + mask as alpha', cursors[0] && [...cursors[0].rgba.subarray(4, 8), cursors[0].rgba[3]], [60, 0, 200, 255, 0]);
  check('desktop size followed', [c.width, c.height], [80, 40]);
});

await section('clipboard: Latin-1 ServerCutText / ClientCutText, extended UTF-8 clipboard (Node)', async () => {
  const writes = [];
  const got = [];
  const c = new RfbClient({ write: (b) => writes.push(b), onCutText: (s) => got.push(s), onError: (e) => got.push(`error ${e.message}`) });
  feed(c, serverInit(8, 8));
  const latin = Buffer.from('naïve café', 'latin1');
  feed(c, Buffer.concat([Buffer.from([3, 0, 0, 0]), E.u32(latin.length), latin]));
  check('ServerCutText (Latin-1) -> text', got, ['naïve café']);
  writes.length = 0;
  c.clipboard('Grüße\r\nline 2 €');
  const m = parseClient(writes)[0];
  check('ClientCutText: Latin-1, LF line ends, ? for characters outside Latin-1', m && [m.t, m.body.toString('latin1')], [6, 'Grüße\nline 2 ?']);

  // extended clipboard: server caps -> client caps; server notify -> client request; server provide -> text
  const ext = (flags, payload = Buffer.alloc(0)) => {
    const b = Buffer.alloc(8 + 4);
    b[0] = 3;
    b.writeInt32BE(-(4 + payload.length), 4);
    b.writeUInt32BE(flags >>> 0, 8);
    return Buffer.concat([b, payload]);
  };
  const CAPS = 1 << 24;
  const REQUEST = 1 << 25;
  const PEEK = 1 << 26;
  const NOTIFY = 1 << 27;
  const PROVIDE = 1 << 28;
  writes.length = 0;
  feed(c, ext(CAPS | REQUEST | PEEK | NOTIFY | PROVIDE | 1, E.u32(1 << 20)));
  let r = parseClient(writes)[0];
  check('client answers the caps (text, all actions)', r && [r.t, r.len < 0, r.body.readUInt32BE(0).toString(16)], [6, true, (CAPS | REQUEST | PEEK | NOTIFY | PROVIDE | 1).toString(16)]);
  check('extended clipboard on', c.extendedClipboard, true);
  writes.length = 0;
  feed(c, ext(NOTIFY | 1));
  r = parseClient(writes)[0];
  check('notify -> request text', r && r.body.readUInt32BE(0).toString(16), (REQUEST | 1).toString(16));
  const utf = Buffer.from('héllo € 👋\r\nline2\0', 'utf8');
  const lenb = E.u32(utf.length);
  feed(c, ext(PROVIDE | 1, zlib.deflateSync(Buffer.concat([lenb, utf]))));
  check('provide (zlib, UTF-8, CRLF) -> text', got.at(-1), 'héllo € 👋\nline2');
  writes.length = 0;
  c.clipboard('Bonjour ✓\nfin');
  r = parseClient(writes)[0];
  check('local copy -> notify (server announced notify)', r && r.body.readUInt32BE(0).toString(16), (NOTIFY | 1).toString(16));
  writes.length = 0;
  feed(c, ext(REQUEST | 1));
  r = parseClient(writes)[0];
  const flags = r?.body.readUInt32BE(0);
  const data = r ? zlib.inflateSync(r.body.subarray(4)) : Buffer.alloc(4);
  const n = data.readUInt32BE(0);
  check('request -> provide: UTF-8, CRLF, NUL-terminated', [flags?.toString(16), data.subarray(4, 4 + n).toString('utf8')], [(PROVIDE | 1).toString(16), 'Bonjour ✓\r\nfin\0']);
  check('no errors', got.filter((x) => x.startsWith?.('error')), []);
});

await section('main/lib/freerdp.js: arguments, stdin, log classification', async () => {
  const base = { host: 'pc.example', kind: 'hostname', port: 3389, user: 'anna', domain: 'OFFICE', password: 'p@ss word', title: 'Office PC', screen: { width: 1600, height: 866 } };
  const a = rdp.buildArgs({ ...base, options: {} });
  check('default arguments (fit window)', a, ['/v:pc.example:3389', '/u:anna', '/d:OFFICE', '/p:p@ss word', '/t:Office PC', '/wm-class:selene-remote', '/cert:deny', '/size:1360x736', '/dynamic-resolution', '-grab-keyboard', '+clipboard', '/sound', '+auto-reconnect']);
  const f = rdp.buildArgs({ ...base, kind: 'ipv6', host: 'fe80::1', fingerprint: 'ab'.repeat(32), options: { display: 'fullscreen', multimon: true, clipboard: false, audio: false } });
  check('IPv6 in brackets', f[0], '/v:[fe80::1]:3389');
  check('trusted certificate', f.includes(`/cert:deny,fingerprint:sha256:${'ab'.repeat(32)}`), true);
  check('full screen, all monitors, no clipboard, no sound; keyboard grabbed', ['/f', '/multimon', '-clipboard', '/audio-mode:2'].every((x) => f.includes(x)) && !f.includes('-grab-keyboard'), true);
  const x = rdp.buildArgs({ ...base, options: { display: 'fixed', size: '1280x720' } });
  check('fixed size', ['/size:1280x720', '/smart-sizing'].every((v) => x.includes(v)) && !x.includes('/dynamic-resolution'), true);
  check('unknown size falls back', rdp.cleanOptions({ display: 'fixed', size: '99x99' }).size, '1920x1080');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rdp-drive-'));
  const share = path.join(tmp, 'Mes documents');
  fs.mkdirSync(share);
  check('shared folder', rdp.buildArgs({ ...base, options: { drive: share } }).find((v) => v.startsWith('/drive:')), `/drive:Mesdocuments,${share}`);
  check('folder problems', [rdp.driveProblem(share), rdp.driveProblem(path.join(tmp, 'nope')), rdp.driveProblem('rel/path'), rdp.driveProblem(`${tmp}/a,b`)], [null, 'ENOENT', 'EINVAL', 'EDRIVECHARS']);
  fs.rmSync(tmp, { recursive: true, force: true });
  check('no line break can reach stdin', rdp.buildArgs({ ...base, user: 'a\nb', title: 't\r\n/x', options: {} }).every((l) => !/[\r\n]/.test(l)), true);
  check('validText refuses control characters', [rdp.validText('ok', 10), rdp.validText('a\nb', 10), rdp.validText('tab\t', 10), rdp.validText('x'.repeat(11), 10)], ['ok', null, null, null]);
  check('stdin: one per line, empty line at the end', rdp.stdinText(['/v:a', '/p:b']), '/v:a\n/p:b\n\n');

  const FP = 'A1:B2:C3:D4:E5:F6:07:18:29:3A:4B:5C:6D:7E:8F:90:A1:B2:C3:D4:E5:F6:07:18:29:3A:4B:5C:6D:7E:8F:90';
  const fpHex = FP.replace(/:/g, '').toLowerCase();
  // the lines FreeRDP 3 prints for a certificate it has never seen (tls.c tls_print_new_certificate_warn)
  const newLog = `[12:00:00:000] [1:2] [ERROR][com.freerdp.crypto] - [tls_print_new_certificate_warn]: The host key for pc.example:3389 has changed
[ERROR][com.freerdp.crypto] - @    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @
[ERROR][com.freerdp.crypto] - The fingerprint for the host key sent by the remote host is ${FP}
[ERROR][com.freerdp.crypto] - Host key verification failed.
[ERROR][com.freerdp.core] - freerdp_post_connect failed ERRCONNECT_TLS_CONNECT_FAILED`;
  const changedLog = `[ERROR][com.freerdp.crypto] - New host key for pc.example:3389
[ERROR][com.freerdp.crypto] - @    WARNING: NEW HOST IDENTIFICATION!     @
[ERROR][com.freerdp.crypto] - The fingerprint for the host key sent by the remote host is ${FP}`;
  check('fingerprint parsed from the log', rdp.fingerprintFromLog(newLog), fpHex);
  check('unknown certificate', rdp.classifyExit(143, null, newLog), { code: 'ECERTNEW', ended: false, fingerprint: fpHex, freerdpChanged: false });
  check('certificate changed in FreeRDP store', rdp.classifyExit(143, null, changedLog).code, 'ECERTCHANGED');
  const cls = (code, log = '') => rdp.classifyExit(code, null, log).code;
  check('log codes', [cls(131, 'freerdp_set_last_error_ex ERRCONNECT_LOGON_FAILURE [0x00020014]'), cls(131, 'ERRCONNECT_CONNECT_TRANSPORT_FAILED'), cls(140, 'ERRCONNECT_DNS_NAME_NOT_FOUND'), cls(147, 'ERRCONNECT_PASSWORD_EXPIRED'), cls(147, 'ERRCONNECT_ACCOUNT_LOCKED_OUT'), cls(131, 'HYBRID_REQUIRED_BY_SERVER'), cls(131, 'ERRCONNECT_ACCESS_DENIED')], ['EAUTH', 'EUNREACHABLE', 'ENOTFOUND', 'EPWEXPIRED', 'ELOCKED', 'ENEEDCRED', 'EDENIED']);
  check('exit codes (XF_EXIT_*)', [132, 134, 154, 131, 141, 147, 139, 140, 143, 133, 135, 148, 159, 145, 160, 18, 128, 200].map((n) => cls(n)), ['EAUTH', 'EAUTH', 'EAUTH', 'EUNREACHABLE', 'EUNREACHABLE', 'EUNREACHABLE', 'ENOTFOUND', 'ENOTFOUND', 'ETLS', 'ENEGO', 'ELOCKED', 'EPWEXPIRED', 'ENEEDCRED', 'ENEEDCRED', 'EBOOTING', 'ELICENSE', 'EARGS', 'EFAIL']);
  check('normal ends (a long session log with warnings is not an error)', [0, 1, 2, 3, 5, 11].map((n) => rdp.classifyExit(n, null, 'WARN Connection timed out ERRCONNECT_CONNECT_FAILED')), [{ code: null, ended: true }, { code: null, ended: true }, { code: 'ELOGOFF', ended: true }, { code: 'EIDLE', ended: true }, { code: 'EREPLACED', ended: true }, { code: null, ended: true }]);
  check('stopped by the person', rdp.classifyExit(null, 'SIGTERM', newLog, { stopped: true }), { code: null, ended: true });
  check('log excerpt hides the password', rdp.logExcerpt('[ERROR] failed with p@ss word\nok line\n', ['p@ss word']), '[ERROR] failed with ••••');
});

// ================================================================ the app in the shell
// ---------------------------------------------------------------- fake VNC server (None security, scripted updates)
function vncServer({ width = W, height = H, ext = false } = {}) {
  const rec = { msgs: [], cut: [], keys: [], conns: 0 };
  const sockets = new Set();
  let onInit = null;
  const srv = net.createServer((sock) => {
    rec.conns++;
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    sock.on('error', () => {});
    let buf = Buffer.alloc(0);
    let st = 'version';
    sock.write('RFB 003.008\n');
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (st === 'version') {
          if (buf.length < 12) return;
          buf = buf.subarray(12);
          sock.write(Buffer.from([1, 1]));
          st = 'sec';
        } else if (st === 'sec') {
          if (buf.length < 1) return;
          buf = buf.subarray(1);
          sock.write(E.u32(0));
          st = 'init';
        } else if (st === 'init') {
          if (buf.length < 1) return;
          buf = buf.subarray(1);
          sock.write(serverInit(width, height).subarray(12 + 2 + 4));
          st = 'normal';
          if (ext) {
            const b = Buffer.alloc(12);
            b[0] = 3;
            b.writeInt32BE(-8, 4);
            b.writeUInt32BE(((1 << 24) | (1 << 25) | (1 << 26) | (1 << 27) | (1 << 28) | 1) >>> 0, 8);
            sock.write(Buffer.concat([b, E.u32(1 << 20)]));
          }
          onInit?.(sock);
        } else {
          if (buf.length < 1) return;
          const t = buf[0];
          const need = t === 0 ? 20 : t === 2 ? (buf.length >= 4 ? 4 + buf.readUInt16BE(2) * 4 : 4) : t === 3 ? 10 : t === 4 ? 8 : t === 5 ? 6 : t === 6 ? (buf.length >= 8 ? 8 + Math.abs(buf.readInt32BE(4)) : 8) : 1;
          if (buf.length < need) return;
          const m = buf.subarray(0, need);
          buf = buf.subarray(need);
          if (t === 4) rec.keys.push({ down: m[1], keysym: m.readUInt32BE(4), at: rec.msgs.length });
          if (t === 6) rec.cut.push({ len: m.readInt32BE(4), body: Buffer.from(m.subarray(8)), at: rec.msgs.length });
          if (t === 2) rec.encodings = Array.from({ length: m.readUInt16BE(2) }, (_, i) => m.readInt32BE(4 + i * 4));
          rec.msgs.push(t);
        }
      }
    });
  });
  return new Promise((resolve) =>
    srv.listen(0, '127.0.0.1', () =>
      resolve({
        port: srv.address().port,
        rec,
        sockets,
        onInit: (fn) => (onInit = fn),
        send: (b) => {
          for (const s of sockets) s.write(b);
        },
        close: () => new Promise((r) => (srv.close(() => r()), [...sockets].forEach((s) => s.destroy()))),
      }),
    ),
  );
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-remote-extra-'));
const CTL = path.join(tmp, 'xwm-ctl');
const XLOG = path.join(tmp, 'xwm-log');
const FLOG = path.join(tmp, 'freerdp-log');
const PLAN = path.join(tmp, 'freerdp-plan.json');
for (const f of [CTL, XLOG, FLOG]) fs.writeFileSync(f, '');
const FP1 = Array.from({ length: 32 }, (_, i) => ((i * 7 + 3) & 255).toString(16).padStart(2, '0')).join('');
const FP2 = Array.from({ length: 32 }, (_, i) => ((i * 11 + 5) & 255).toString(16).padStart(2, '0')).join('');
const fpColons = (hex) => hex.toUpperCase().match(/../g).join(':');
const certLog = (fp) => `[ERROR][com.freerdp.crypto] - The host key for x:3389 has changed\n[ERROR][com.freerdp.crypto] - @    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\n[ERROR][com.freerdp.crypto] - The fingerprint for the host key sent by the remote host is ${fpColons(fp)}\n[ERROR][com.freerdp.crypto] - Host key verification failed.\n`;
fs.writeFileSync(
  PLAN,
  JSON.stringify({
    '127.0.0.1': { window: true, untilSignal: true, delay: 150 },
    '127.0.0.2': { stderr: '[ERROR][com.freerdp.core] - freerdp_set_last_error_ex ERRCONNECT_LOGON_FAILURE [0x00020014]\n', exit: 132, delay: 100 },
    '127.0.0.3': { stderr: '[ERROR][com.freerdp.core] - freerdp_set_last_error_ex ERRCONNECT_CONNECT_TRANSPORT_FAILED [0x0002000D]\n', exit: 131, delay: 100 },
    '127.0.0.4': { stderr: certLog(FP1), exit: 143, delay: 100, trusted: { window: true, untilSignal: true, delay: 100 } },
    '127.0.0.5': { stderr: certLog(FP2), exit: 143, delay: 100 },
    '127.0.0.6': { window: true, delay: 300, exit: 2 },
    '*': { exit: 0 },
  }),
);
const freerdpRuns = () =>
  fs
    .readFileSync(FLOG, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

let s = await launchShell({
  open: ['remote'],
  lang: 'en',
  theme: 'light',
  env: { PATH: `${FAKE_BIN}:${process.env.PATH}`, AURORA_XWM: '1', AURORA_XWM_HELPER: FAKE_XWM, AURORA_XWM_FAKE_LOG: XLOG, AURORA_XWM_FAKE_CTL: CTL, AURORA_FAKE_FREERDP_LOG: FLOG, AURORA_FAKE_FREERDP_PLAN: PLAN },
});
let page = s.page;
const q = (sel) => page.evaluate(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? null`);
const infoText = () => q(`${WIN} .rd-info .rd-info-text`);
const hook = (expr) => page.evaluate(`(() => { const r = document.querySelector('${WIN} .rd-root').parentElement.__remote; return ${expr}; })()`);
const canvasRGBA = () =>
  page.evaluate(`(() => { const c = document.querySelector('${WIN} .rd-canvas'); return Array.from(c.getContext('2d').getImageData(0, 0, c.width, c.height).data); })()`).then((a) => ({ w: W, h: H, px: Uint8Array.from(a) }));
const connected = () => until(() => hook('r.state').then((st) => st === 'connected'), 12000);
const homeShown = () => until(() => page.evaluate(`!document.querySelector('${WIN} .rd-home').hidden`), 12000);
const clip = {
  read: () => page.evaluate(`window.aurora.invoke('clipboard:readText')`),
  write: (t) => page.evaluate(`window.aurora.invoke('clipboard:writeText', ${JSON.stringify(t)})`),
};

await section('VNC in the shell: every encoding drawn exactly on the canvas, Tight JPEG', async () => {
  check('window opened', await until(() => page.evaluate(`!!document.querySelector('${WIN} .rd-form')`), 20000), true);
  const srv = await vncServer();
  const zr = new E.Deflater();
  const tz = [new E.Deflater(), new E.Deflater(), new E.Deflater(), new E.Deflater()];
  const part = (x, w) => E.crop(PIC, x, 0, w, H);
  const rects = [
    Buffer.concat([E.rectHeader(0, 0, 30, H, 5), E.hextile(part(0, 30))]),
    Buffer.concat([E.rectHeader(30, 0, 40, H, 16), await E.zrle(part(30, 40), zr)]),
    Buffer.concat([E.rectHeader(70, 0, 40, H, 16), await E.zrle(part(70, 40), zr)]),
    Buffer.concat([E.rectHeader(110, 0, 40, H, 7), await E.tight(part(110, 40), 'gradient', tz, { reset: 15 })]),
  ];
  srv.onInit(() => setTimeout(() => srv.send(Buffer.concat([E.updateHeader(rects.length), ...rects])), 100));
  await page.fill(`${WIN} input[name=host]`, '127.0.0.1');
  await page.fill(`${WIN} input[name=port]`, String(srv.port));
  await page.click(`${WIN} [data-act=connect]`);
  check('connected', await connected(), true);
  check('SetEncodings from the app: JPEG and Cursor too', await until(() => srv.rec.encodings?.length, 3000) && srv.rec.encodings, [1, 7, 16, 5, 0, -26, -254, -223, -224, -239, -1063131698]);
  let d = Infinity;
  await until(async () => (d = E.diff(await canvasRGBA(), PIC)) === 0, 6000);
  check('canvas = picture (Hextile, ZRLE x2, Tight gradient)', d, 0);
  // Tight JPEG: a picture encoded by Chromium itself, decoded by the app (lossy: small tolerance)
  const jpeg = await page.evaluate(`(async () => {
    const c = new OffscreenCanvas(32, 24); const g = c.getContext('2d');
    g.fillStyle = 'rgb(200, 30, 90)'; g.fillRect(0, 0, 32, 24); g.fillStyle = 'rgb(20, 160, 60)'; g.fillRect(16, 0, 16, 24);
    const b = await c.convertToBlob({ type: 'image/jpeg', quality: 1 }); return Array.from(new Uint8Array(await b.arrayBuffer()));
  })()`);
  const later = E.image(4, 4, () => [1, 2, 250]);
  srv.send(Buffer.concat([E.updateHeader(3), E.rectHeader(10, 10, 32, 24, 7), await E.tight(E.image(32, 24, () => [0, 0, 0]), 'jpeg', tz, { jpeg: Uint8Array.from(jpeg) }), E.rectHeader(100, 70, 4, 4, 0), E.raw(later), E.rectHeader(0, 0, 0, 0, -224)]));
  const expected = E.framebuffer(W, H);
  expected.raw(0, 0, W, H, PIC.px);
  expected.raw(10, 10, 32, 24, E.image(32, 24, (x) => (x < 16 ? [200, 30, 90] : [20, 160, 60])).px);
  expected.raw(100, 70, 4, 4, later.px);
  await until(async () => (d = E.diff(await canvasRGBA(), expected, 12)) === 0, 6000);
  check('JPEG rectangle drawn (±12 per channel), raw rectangle after it, LastRect', d, 0);
  check('still connected', await hook('r.state'), 'connected');
  // Cursor pseudo-encoding -> CSS cursor of the canvas
  srv.send(Buffer.concat([E.updateHeader(1), E.rectHeader(2, 3, 8, 8, -239), E.cursor(E.image(8, 8, () => [255, 255, 255]), (x, y) => x === y)]));
  check('remote cursor shape used', await until(() => page.evaluate(`document.querySelector('${WIN} .rd-canvas').style.cursor.startsWith('url("data:image/png')`), 4000), true);
  check('hotspot', await page.evaluate(`/\\) 2 3, default$/.test(document.querySelector('${WIN} .rd-canvas').style.cursor)`), true);
  await page.click(`${WIN} [data-act=disconnect]`);
  await homeShown();
  await srv.close();
});

await section('VNC clipboard: server -> Selene, paste -> ClientCutText before the keys, sharing off', async () => {
  const srv = await vncServer({ width: 40, height: 30 });
  await page.fill(`${WIN} input[name=host]`, '127.0.0.1');
  await page.fill(`${WIN} input[name=port]`, String(srv.port));
  check('clipboard sharing on by default', await page.isChecked(`${WIN} input[name=vnc-clipboard]`), true);
  await page.click(`${WIN} [data-act=connect]`);
  check('connected', await connected(), true);
  const latin = Buffer.from('Texte copié à distance', 'latin1');
  srv.send(Buffer.concat([Buffer.from([3, 0, 0, 0]), E.u32(latin.length), latin]));
  check('ServerCutText -> Selene clipboard', await until(() => clip.read().then((x) => x === 'Texte copié à distance'), 4000), true);
  srv.rec.cut.length = 0;
  await page.focus(`${WIN} .rd-canvas`);
  await sleep(200);
  check('focus does not send back what came from the server', srv.rec.cut.length, 0);
  await clip.write('Collé depuis Selene\nligne 2');
  srv.rec.keys.length = 0;
  await page.keyboard.press('Control+v');
  await until(() => srv.rec.keys.length >= 4 && srv.rec.cut.length >= 1, 4000);
  const cut = srv.rec.cut[0];
  check('paste -> ClientCutText (Latin-1)', cut && cut.body.toString('latin1'), 'Collé depuis Selene\nligne 2');
  const vDown = srv.rec.keys.find((k) => k.keysym === 0x76 && k.down);
  check('the text reaches the server before the V key', !!cut && !!vDown && cut.at < vDown.at, true);
  check('Ctrl+V keys still sent', srv.rec.keys.map((k) => `${k.down ? '+' : '-'}${k.keysym.toString(16)}`), ['+ffe3', '+76', '-76', '-ffe3']);
  await page.click(`${WIN} [data-act=disconnect]`);
  await homeShown();
  // sharing off: nothing either way
  await page.setChecked(`${WIN} input[name=vnc-clipboard]`, false);
  await page.click(`${WIN} [data-act=connect]`);
  check('connected again', await connected(), true);
  await clip.write('ne pas envoyer');
  srv.rec.cut.length = 0;
  const other = Buffer.from('ne pas recevoir', 'latin1');
  srv.send(Buffer.concat([Buffer.from([3, 0, 0, 0]), E.u32(other.length), other]));
  await page.focus(`${WIN} .rd-canvas`);
  await page.keyboard.press('Control+v');
  await sleep(500);
  check('sharing off: Selene clipboard untouched', await clip.read(), 'ne pas envoyer');
  check('sharing off: no ClientCutText', srv.rec.cut.length, 0);
  await page.click(`${WIN} [data-act=disconnect]`);
  await homeShown();
  await page.setChecked(`${WIN} input[name=vnc-clipboard]`, true);
  await srv.close();
});

await section('VNC extended clipboard (UTF-8) in the shell', async () => {
  const srv = await vncServer({ width: 40, height: 30, ext: true });
  await page.fill(`${WIN} input[name=port]`, String(srv.port));
  await page.click(`${WIN} [data-act=connect]`);
  check('connected', await connected(), true);
  check('client answered the caps', await until(() => srv.rec.cut.some((c) => c.len < 0 && c.body.readUInt32BE(0) & (1 << 24)), 4000), true);
  const utf = Buffer.from('Émoji 👋 et €uro\0', 'utf8');
  const prov = zlib.deflateSync(Buffer.concat([E.u32(utf.length), utf]));
  const b = Buffer.alloc(12);
  b[0] = 3;
  b.writeInt32BE(-(4 + prov.length), 4);
  b.writeUInt32BE(((1 << 28) | 1) >>> 0, 8);
  srv.send(Buffer.concat([b, prov]));
  check('UTF-8 text from the server', await until(() => clip.read().then((x) => x === 'Émoji 👋 et €uro'), 4000), true);
  await page.click(`${WIN} [data-act=disconnect]`);
  await homeShown();
  await srv.close();
});

// ---------------------------------------------------------------- RDP
const rdpWin = () => page.evaluate(() => [...window.__aurora.xwin.frames.values()].map((r) => ({ id: r.id, appId: r.win?.appId, title: r.win?.title, name: r.win && window.__aurora.registry.name(r.win.appId) })));
// The session frames open above the Remote Desktop window: bring it back to the front before clicking in it
// (what a click on its visible part does for a person).
const front = () => page.evaluate(() => window.__aurora.wm.byApp('remote')[0]?.focus());
const clickApp = async (sel) => {
  await front();
  await page.click(sel);
};
async function rdpForm({ host = '127.0.0.1', port = '3389', name = '', user = 'anna', domain = '', password = 'S3cret pass', remember = false } = {}) {
  await front();
  if ((await hook('r.protocol')) !== 'rdp') await page.click(`${WIN} [data-proto=rdp]`);
  await page.fill(`${WIN} input[name=host]`, host);
  await page.fill(`${WIN} input[name=port]`, port);
  await page.fill(`${WIN} input[name=name]`, name);
  await page.fill(`${WIN} input[name=user]`, user);
  await page.fill(`${WIN} input[name=domain]`, domain);
  await page.fill(`${WIN} input[name=password]`, password);
  await page.setChecked(`${WIN} input[name=remember]`, remember);
}

await section('RDP form: protocol switch, options, validation', async () => {
  await page.fill(`${WIN} input[name=port]`, '5900');
  await page.click(`${WIN} [data-proto=rdp]`);
  check('protocol RDP selected (radio)', [await hook('r.protocol'), await page.getAttribute(`${WIN} [data-proto=rdp]`, 'aria-checked')], ['rdp', 'true']);
  check('port follows the protocol', await page.inputValue(`${WIN} input[name=port]`), '3389');
  check('user + domain shown, VNC clipboard box hidden', await page.evaluate(`[!!document.querySelector('${WIN} input[name=user]').offsetParent, !!document.querySelector('${WIN} input[name=domain]').offsetParent, !!document.querySelector('${WIN} input[name=vnc-clipboard]').offsetParent]`), [true, true, false]);
  check('FreeRDP found (fake on PATH): no warning', await page.evaluate(`document.querySelector('${WIN} .rd-rdp-missing').hidden`), true);
  await page.click(`${WIN} .rd-options-summary`);
  check('options: fit window by default, clipboard + sound on, no folder', [await page.inputValue(`${WIN} select[name=display]`), await page.isChecked(`${WIN} input[name=rdp-clipboard]`), await page.isChecked(`${WIN} input[name=audio]`), await q(`${WIN} .rd-drive-path`)], ['fit', true, true, 'No folder shared']);
  check('size and all-monitors only when they apply', await page.evaluate(`[document.querySelector('${WIN} .rd-size-field').hidden, document.querySelector('${WIN} input[name=multimon]').disabled]`), [true, true]);
  await page.selectOption(`${WIN} select[name=display]`, 'fixed');
  check('fixed size shows the size list', await page.evaluate(`document.querySelector('${WIN} .rd-size-field').hidden`), false);
  await page.selectOption(`${WIN} select[name=display]`, 'fullscreen');
  check('full screen enables all monitors', await page.evaluate(`document.querySelector('${WIN} input[name=multimon]').disabled`), false);
  await page.selectOption(`${WIN} select[name=display]`, 'fit');
  await page.focus(`${WIN} [data-proto=rdp]`);
  await page.keyboard.press('ArrowLeft');
  check('arrow keys move in the protocol group', [await hook('r.protocol'), await page.evaluate(`document.activeElement?.dataset.proto`)], ['vnc', 'vnc']);
  await page.keyboard.press('ArrowRight');
  await rdpForm({ user: '' });
  await page.click(`${WIN} [data-act=connect]`);
  check('user name required', await infoText(), 'Type the user name of the account on the remote computer.');
  check('focus on user', await page.evaluate(`document.activeElement?.name`), 'user');
  await rdpForm({ password: '' });
  await page.click(`${WIN} [data-act=connect]`);
  check('password required', await infoText(), 'Type the password of the account on the remote computer.');
  check('nothing started', freerdpRuns().length, 0);
  const inv = (...a) => page.evaluate(`window.aurora.invokeRaw(...${JSON.stringify(a)}).then((r) => r.ok ? 'ok' : r.error.code)`);
  check('backend: bad host', await inv('remote:rdp-start', { host: 'a;b', port: 3389, user: 'x', password: 'y' }), 'EINVAL');
  check('backend: password with a line break', await inv('remote:rdp-start', { host: '127.0.0.1', port: 3389, user: 'x', password: 'y\n/v:evil' }), 'EINVAL');
  check('backend: user with a line break', await inv('remote:rdp-start', { host: '127.0.0.1', port: 3389, user: 'x\n/drive:all,/', password: 'y' }), 'EINVAL');
  check('backend: port', await inv('remote:rdp-start', { host: '127.0.0.1', port: 99999, user: 'x', password: 'y' }), 'EINVAL');
  check('backend: dev mode stays on this computer', await inv('remote:rdp-start', { host: 'pc.example.com', port: 3389, user: 'x', password: 'y' }), 'EOFFLINE');
  check('backend: missing shared folder', await inv('remote:rdp-start', { host: '127.0.0.1', port: 3389, user: 'x', password: 'y', options: { drive: '/nonexistent/dir' } }), 'EDRIVE');
  check('backend: folder with a comma', await inv('remote:rdp-start', { host: '127.0.0.1', port: 3389, user: 'x', password: 'y', options: { drive: '/tmp/a,b' } }), 'EINVAL');
  check('backend: bad certificate fingerprint', await inv('remote:rdp-trust', '127.0.0.1', 3389, 'zz'), 'EINVAL');
  check('backend: FreeRDP status', await page.evaluate(`window.aurora.invoke('remote:rdp-status')`), { available: true, program: 'xfreerdp3', version: 3 });
  check('still nothing started', freerdpRuns().length, 0);
});

await section('RDP session: FreeRDP gets everything on stdin, its window is a Selene window', async () => {
  await rdpForm({ name: 'Lab PC', domain: 'OFFICE' });
  await clickApp(`${WIN} [data-act=connect]`);
  check('progress shown', await until(() => infoText().then((x) => x === 'Connecting to 127.0.0.1… The session opens in its own window.'), 4000), true);
  check('session listed while connecting', await until(() => q(`${WIN} .rd-rdp-item .rd-item-addr`).then((x) => (x || '').includes('connecting')), 4000), true);
  await until(() => freerdpRuns().length === 1, 4000);
  const run = freerdpRuns()[0];
  check('argv is only /args-from:stdin', run?.argv, ['/args-from:stdin']);
  check('password nowhere in /proc/<pid>/cmdline', run && !run.cmdline.join(' ').includes('S3cret'), true);
  check('no FREERDP_ASKPASS', run?.askpass, false);
  const L = run?.lines || [];
  check('stdin arguments', ['/v:127.0.0.1:3389', '/u:anna', '/d:OFFICE', '/p:S3cret pass', '/t:Lab PC', '/wm-class:selene-remote', '/cert:deny', '/dynamic-resolution', '+clipboard', '/sound', '+auto-reconnect'].filter((x) => !L.includes(x)), []);
  check('initial size from the work area', L.some((x) => /^\/size:\d+x\d+$/.test(x)), true);
  // the window announced through the (fake) aurora-xwm becomes a frame of the Remote Desktop taskbar entry
  check('session open', await until(() => q(`${WIN} .rd-rdp-item .rd-item-addr`).then((x) => (x || '').includes('open in its own window')), 6000), true);
  const frames = await rdpWin();
  check('frame: title = connection name, app = Remote Desktop', frames.map((f) => [f.appId, f.title, f.name]), [['x11:selene-remote', 'Lab PC', 'Remote Desktop']]);
  check('taskbar entry', await until(() => page.evaluate(() => !!document.querySelector('#taskbar [data-app="x11:selene-remote"]')), 4000), true);
  check('progress message cleared', await infoText(), null);
  await front();
  await page.evaluate(`document.querySelector('${WIN} .rd-home').scrollTop = 0`);
  await sleep(300);
  fs.copyFileSync(await s.shot('remote-rdp-session-light-en'), path.join(DOCS, 'remote-rdp-session-light-en.png'));
  // Show: focuses the session frame
  await page.evaluate(() => window.__aurora.wm.byApp('remote')[0].focus());
  check('app window focused first', await page.evaluate(() => window.__aurora.wm.focused()?.appId), 'remote');
  await page.click(`${WIN} [data-act=rdp-show]`); // the app window is in front already
  check('Show focuses the session window', await until(() => page.evaluate(() => window.__aurora.wm.focused()?.appId === 'x11:selene-remote'), 3000), true);
  // Disconnect: the FreeRDP process ends (SIGTERM), the frame goes away
  await clickApp(`${WIN} [data-act=rdp-stop]`);
  check('ended message', await until(() => infoText().then((x) => x === 'The session with 127.0.0.1 has ended.'), 6000), true);
  check('session list hidden again', await page.evaluate(`document.querySelector('${WIN} .rd-rdp-sessions').hidden`), true);
  check('frame closed', await until(() => rdpWin().then((f) => f.length === 0), 4000), true);
  let alive = true;
  try {
    process.kill(run.pid, 0);
  } catch {
    alive = false;
  }
  check('FreeRDP process gone', alive, false);
});

await section('RDP errors in plain language', async () => {
  await rdpForm({ host: '127.0.0.2' });
  await clickApp(`${WIN} [data-act=connect]`);
  check('wrong password', await until(() => infoText().then((x) => x === 'Wrong user name or password: 127.0.0.2 refused them.'), 6000), true);
  check('password emptied and focused', [await page.inputValue(`${WIN} input[name=password]`), await page.evaluate(`document.activeElement?.name`)], ['', 'password']);
  check('details: FreeRDP log lines, no password', await page.evaluate(`document.querySelector('${WIN} .rd-detail-log')?.textContent || ''`), (x) => x.includes('ERRCONNECT_LOGON_FAILURE') && !x.includes('S3cret'));
  await rdpForm({ host: '127.0.0.3' });
  await clickApp(`${WIN} [data-act=connect]`);
  check('unreachable', await until(() => infoText().then((x) => x === '127.0.0.3:3389 cannot be reached. Check that Remote Desktop is turned on there and that the port is correct.'), 6000), true);
  // the server ends the session itself (sign-out, exit 2) after its window appeared
  await rdpForm({ host: '127.0.0.6' });
  await clickApp(`${WIN} [data-act=connect]`);
  check('signed out', await until(() => infoText().then((x) => x === 'You were signed out of 127.0.0.6.'), 6000), true);
});

await section('RDP certificates: unknown -> Selene dialog -> trusted fingerprint; changed -> warning', async () => {
  const before = freerdpRuns().length;
  await rdpForm({ host: '127.0.0.4' });
  await clickApp(`${WIN} [data-act=connect]`);
  check('certificate dialog', await until(() => page.evaluate(`!!document.querySelector('.rd-cert-dialog')`), 6000), true);
  check('dialog: title + fingerprint with colons', [await q('.rd-cert-dialog .dialog-title'), await q('.rd-cert-dialog .rd-fp.new .rd-fp-code')], ['Unknown certificate', fpColons(FP1)]);
  await sleep(400);
  fs.copyFileSync(await s.shot('remote-rdp-cert-light-en'), path.join(DOCS, 'remote-rdp-cert-light-en.png'));
  await page.click('.rd-cert-dialog .btn.primary');
  check('connects again with that certificate only', await until(() => freerdpRuns().length === before + 2, 6000) && freerdpRuns().at(-1).lines.includes(`/cert:deny,fingerprint:sha256:${FP1}`), true);
  check('then the session opens', await until(() => q(`${WIN} .rd-rdp-item .rd-item-addr`).then((x) => (x || '').includes('open in its own window')), 6000), true);
  const store = JSON.parse(fs.readFileSync(path.join(s.home, '.local', 'share', 'aurora', 'remote.json'), 'utf8'));
  check('trusted certificate stored per host:port', store.certs['127.0.0.4:3389']?.sha256, FP1);
  await clickApp(`${WIN} [data-act=rdp-stop]`);
  await until(() => page.evaluate(`document.querySelector('${WIN} .rd-rdp-sessions').hidden`), 6000);
  // changed: Selene trusted FP1 for .5, the server now shows FP2
  await page.evaluate(`window.aurora.invoke('remote:rdp-trust', '127.0.0.5', 3389, '${FP1}')`);
  await rdpForm({ host: '127.0.0.5' });
  await clickApp(`${WIN} [data-act=connect]`);
  check('changed-certificate warning', await until(() => q('.rd-cert-dialog .dialog-title').then((x) => x === 'The certificate has changed'), 6000), true);
  check('previous FreeRDP run had the old fingerprint', freerdpRuns().at(-1).lines.includes(`/cert:deny,fingerprint:sha256:${FP1}`), true);
  check('shows the old and the new fingerprint', [await q('.rd-cert-dialog .rd-fp.old .rd-fp-code'), await q('.rd-cert-dialog .rd-fp.new .rd-fp-code')], [fpColons(FP1), fpColons(FP2)]);
  check('the safe choice is the default (Cancel)', await page.evaluate(`document.querySelector('.rd-cert-dialog .btn.primary')?.textContent`), 'Cancel');
  await sleep(400);
  fs.copyFileSync(await s.shot('remote-rdp-cert-changed-light-en'), path.join(DOCS, 'remote-rdp-cert-changed-light-en.png'));
  await page.keyboard.press('Escape');
  check('cancelled', await until(() => infoText().then((x) => x === 'Connection cancelled: the certificate of 127.0.0.5 was not trusted.'), 4000), true);
  check('old trust kept', JSON.parse(fs.readFileSync(path.join(s.home, '.local', 'share', 'aurora', 'remote.json'), 'utf8')).certs['127.0.0.5:3389'].sha256, FP1);
});

await section('RDP saved connection: options, shared folder, remembered password', async () => {
  const share = path.join(s.home, 'Documents', 'Partage');
  fs.mkdirSync(share, { recursive: true });
  await rdpForm({ name: 'Bureau', user: 'marc', domain: 'MAISON', password: 'mot de passe', remember: true });
  if (!(await page.evaluate(`document.querySelector('${WIN} .rd-options').open`))) await clickApp(`${WIN} .rd-options-summary`);
  await page.selectOption(`${WIN} select[name=display]`, 'fixed');
  await page.selectOption(`${WIN} select[name=size]`, '1280x720');
  await page.setChecked(`${WIN} input[name=audio]`, false);
  await page.setChecked(`${WIN} input[name=rdp-clipboard]`, false);
  // folder chosen through the file picker
  await clickApp(`${WIN} [data-act=drive-choose]`);
  await until(() => page.evaluate(`!!document.querySelector('.fp-dialog .fp-row')`), 4000);
  await page.dblclick('.fp-dialog .fp-row:has-text("Documents")');
  await until(() => page.evaluate(`[...document.querySelectorAll('.fp-dialog .fp-row')].some((r) => r.textContent.includes('Partage'))`), 4000);
  await page.click('.fp-dialog .fp-row:has-text("Partage")');
  await page.click('.fp-dialog .dialog-footer .btn.primary');
  check('folder shown', await until(() => q(`${WIN} .rd-drive-path`).then((x) => x === share), 4000), true);
  await clickApp(`${WIN} [data-act=save]`);
  check('saved', await until(() => infoText().then((x) => x === '"Bureau" was saved.'), 4000), true);
  const file = path.join(s.home, '.local', 'share', 'aurora', 'remote.json');
  const e = JSON.parse(fs.readFileSync(file, 'utf8')).connections.find((c) => c.name === 'Bureau');
  check('stored: protocol, user, domain, options', e && [e.protocol, e.user, e.domain, e.options], ['rdp', 'marc', 'MAISON', { display: 'fixed', size: '1280x720', multimon: false, clipboard: false, audio: false, drive: share }]);
  check('password sealed, not in clear', !!e?.secret?.v && !fs.readFileSync(file, 'utf8').includes('mot de passe'), true);
  check('listed as RDP', await until(() => page.evaluate(`[...document.querySelectorAll('${WIN} .rd-item-addr')].some((x) => x.textContent.startsWith('RDP · MAISON\\\\marc @ 127.0.0.1:3389'))`), 4000), true);
  await page.evaluate(`document.querySelector('${WIN} .rd-home').scrollTop = 0`);
  await sleep(200);
  fs.copyFileSync(await s.shot('remote-rdp-form-light-en'), path.join(DOCS, 'remote-rdp-form-light-en.png'));
  const before = freerdpRuns().length;
  await page.evaluate(`document.querySelector('${WIN} .rd-item[data-proto=rdp] [data-act=connect-saved]').click()`);
  await until(() => freerdpRuns().length === before + 1, 4000);
  const L = freerdpRuns().at(-1)?.lines || [];
  check('remembered password sent on stdin (the app never read it)', L.includes('/p:mot de passe'), true);
  check('options -> arguments', ['/size:1280x720', '/smart-sizing', '-clipboard', '/audio-mode:2', `/drive:Partage,${share}`, '/t:Bureau', '/u:marc', '/d:MAISON'].filter((x) => !L.includes(x)), []);
  await until(() => q(`${WIN} .rd-rdp-item .rd-item-addr`).then((x) => (x || '').includes('open in its own window')), 6000);
  // close the Remote Desktop window: the session keeps running; reopened, the window lists it again
  await clickApp(`${WIN} .win-close`);
  check('app window closed', await until(() => page.evaluate(`!document.querySelector('${WIN}')`), 4000), true);
  check('session window still there', (await rdpWin()).length, 1);
  await page.evaluate(() => window.__aurora.registry.launch('remote'));
  check('reopened: the running session is listed', await until(() => q(`${WIN} .rd-rdp-item .rd-item-name`).then((x) => x === 'Bureau'), 6000), true);
  check('…and found its window', await until(() => q(`${WIN} .rd-rdp-item .rd-item-addr`).then((x) => (x || '').includes('open in its own window')), 4000), true);
  await clickApp(`${WIN} [data-act=rdp-stop]`);
  check('stopped', await until(() => rdpWin().then((f) => f.length === 0), 6000), true);
});
await s.close();

// ---------------------------------------------------------------- French + dark, FreeRDP missing
await section('French + dark: RDP form, FreeRDP missing', async () => {
  s = await launchShell({ open: ['remote'], lang: 'fr', theme: 'dark', env: { AURORA_REMOTE_FREERDP: 'none' } });
  page = s.page;
  check('window opened', await until(() => page.evaluate(`!!document.querySelector('${WIN} .rd-form')`), 20000), true);
  check('FR subtitle', (await q(`${WIN} .rd-hero p`)).includes('RDP pour les PC et serveurs Windows'), true);
  await page.click(`${WIN} [data-proto=rdp]`);
  check('FR missing FreeRDP warning', await until(() => q(`${WIN} .rd-rdp-missing`).then((x) => x === "Les connexions RDP ont besoin de FreeRDP (le programme xfreerdp3), qui n'est pas installé."), 4000), true);
  check('connect disabled without FreeRDP', await page.evaluate(`document.querySelector('${WIN} [data-act=connect]').disabled`), true);
  await page.click(`${WIN} .rd-options-summary`);
  check('FR labels', [await q(`${WIN} .rd-options-summary`), await q(`${WIN} [data-act=drive-choose]`), await q(`${WIN} [data-proto=rdp]`)], ['Options', 'Choisir…', 'RDP (Windows)']);
  check('FR user label', await page.evaluate(`document.querySelector('${WIN} input[name=user]').labels[0].textContent`), "Nom d'utilisateur");
  check('no raw i18n keys', await page.evaluate(`/\\b(app|form|opt|rdp|cert|saved|session|err)\\.[a-z]+/i.test(document.querySelector('${WIN}').textContent)`), false);
  await page.fill(`${WIN} input[name=host]`, 'serveur.local');
  await page.fill(`${WIN} input[name=user]`, 'anna');
  await page.fill(`${WIN} input[name=domain]`, 'BUREAU');
  await sleep(300);
  fs.copyFileSync(await s.shot('remote-rdp-form-dark-fr'), path.join(DOCS, 'remote-rdp-form-dark-fr.png'));
  check('FR RDP status', await page.evaluate(`window.aurora.invoke('remote:rdp-status')`), { available: false, program: null, version: null });
  await s.close();
});
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  ✗ ${f}`);
process.exit(failures.length ? 1 : 0);
