// Remote Desktop tests: DES / keysym / RFB units, backend helpers, and the real Electron shell driving the app against a
// tiny fake RFB 3.8 server written here (Node net): VNC auth, Raw + CopyRect + DesktopSize, pointer + keyboard events,
// Ctrl+Alt+Del, scaling, full screen, errors (refused, password, wrong password, closed), saved connections, FR + dark.
// More encodings, the clipboard and RDP (FreeRDP): test/remote-extra.test.mjs.
// Usage:  cd aurora-os/shell && xvfb-run -a -s "-screen 0 1600x900x24" node test/remote.test.mjs
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { launchShell, ROOT } from './lib.mjs';

const require = createRequire(import.meta.url);
const LIB = path.join(ROOT, 'renderer', 'apps', 'remote', 'lib');
const { desEncryptBlock, vncAuthResponse } = await import(pathToFileURL(path.join(LIB, 'des.js')).href);
const { keysymFor } = await import(pathToFileURL(path.join(LIB, 'keysym.js')).href);
const { RfbClient } = await import(pathToFileURL(path.join(LIB, 'rfb.js')).href);
const DOCS = path.join(ROOT, '..', 'docs', 'screenshots');
fs.mkdirSync(DOCS, { recursive: true });
const WIN = '.win.app-remote';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
const failures = [];
function check(name, actual, expected) {
  const ok = typeof expected === 'function' ? !!expected(actual) : Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++;
  else failures.push(`${name}\n      expected: ${typeof expected === 'function' ? '(predicate)' : JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
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
const hx = (s) => Uint8Array.from(s.match(/../g), (x) => parseInt(x, 16));
const th = (b) => Buffer.from(b).toString('hex');

// ---------------------------------------------------------------- fake RFB server
// Framebuffer: left half red, right half blue. Records every client message.
function fakeServer({ password = 'secret', width = 64, height = 48, version = '003.008', security = [2], name = 'Fake VNC', desktop = false } = {}) {
  const rec = { versions: [], pixelFormats: [], encodings: [], requests: [], keys: [], pointers: [], conns: 0, authFails: 0 };
  const sockets = new Set();
  let fb = { w: width, h: height, px: null };
  const paint = (w, h, fn) => {
    const px = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px.set([...fn(x, y), 0], (y * w + x) * 4);
    return { w, h, px };
  };
  fb = paint(width, height, (x) => (x < width / 2 ? [255, 0, 0] : [0, 0, 255]));
  // A small fake desktop for the screenshot: gradient wallpaper, a window with a title bar, a taskbar.
  if (desktop)
    fb = paint(width, height, (x, y) => {
      if (y >= height - 14) return x > width / 2 - 30 && x < width / 2 + 30 && y > height - 11 && y < height - 3 ? [90, 160, 230] : [32, 36, 44];
      const wx0 = width * 0.18, wx1 = width * 0.7, wy0 = height * 0.14, wy1 = height * 0.72;
      if (x >= wx0 && x < wx1 && y >= wy0 && y < wy1) {
        if (y < wy0 + 12) return [235, 238, 243];
        if ((y - wy0 - 22) % 12 < 4 && x > wx0 + 10 && x < wx1 - 30 - ((y * 7) % 40)) return [180, 186, 196];
        return [250, 250, 252];
      }
      return [20 + Math.round((x / width) * 40), 70 + Math.round((y / height) * 60), 150 + Math.round((x / width) * 70)];
    });
  const u32 = (n) => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n >>> 0);
    return b;
  };
  const rectHeader = (x, y, w, h, enc) => {
    const b = Buffer.alloc(12);
    b.writeUInt16BE(x, 0);
    b.writeUInt16BE(y, 2);
    b.writeUInt16BE(w, 4);
    b.writeUInt16BE(h, 6);
    b.writeInt32BE(enc, 8);
    return b;
  };
  const fullUpdate = () => Buffer.concat([Buffer.from([0, 0, 0, 1]), rectHeader(0, 0, fb.w, fb.h, 0), fb.px]);
  const srv = net.createServer((sock) => {
    rec.conns++;
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    sock.on('error', () => {});
    let buf = Buffer.alloc(0);
    let st = 'version';
    let challenge = null;
    const minor = Number(version.slice(4));
    sock.write(`RFB ${version}\n`);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (st === 'version') {
          if (buf.length < 12) return;
          rec.versions.push(buf.subarray(0, 12).toString('latin1'));
          buf = buf.subarray(12);
          if (minor === 3) {
            sock.write(u32(security[0]));
            if (security[0] === 2) {
              challenge = Buffer.from(Array.from({ length: 16 }, (_, i) => (i * 37 + 11) & 255));
              sock.write(challenge);
              st = 'auth';
            } else st = 'init';
          } else {
            sock.write(Buffer.from([security.length, ...security]));
            st = 'sec';
          }
        } else if (st === 'sec') {
          if (buf.length < 1) return;
          const type = buf[0];
          buf = buf.subarray(1);
          if (type === 2) {
            challenge = Buffer.from(Array.from({ length: 16 }, (_, i) => (i * 37 + 11) & 255));
            sock.write(challenge);
            st = 'auth';
          } else {
            if (minor >= 8) sock.write(u32(0));
            st = 'init';
          }
        } else if (st === 'auth') {
          if (buf.length < 16) return;
          const resp = buf.subarray(0, 16);
          buf = buf.subarray(16);
          if (th(resp) === th(vncAuthResponse(password, challenge))) {
            sock.write(u32(0));
            st = 'init';
          } else {
            rec.authFails++;
            const reason = Buffer.from('Authentication failed');
            sock.write(Buffer.concat([u32(1), u32(reason.length), reason]));
            sock.end();
            return;
          }
        } else if (st === 'init') {
          if (buf.length < 1) return;
          buf = buf.subarray(1);
          const n = Buffer.from(name);
          const si = Buffer.alloc(24);
          si.writeUInt16BE(fb.w, 0);
          si.writeUInt16BE(fb.h, 2);
          si.set([32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0], 4);
          si.writeUInt32BE(n.length, 20);
          sock.write(Buffer.concat([si, n]));
          st = 'normal';
        } else {
          if (buf.length < 1) return;
          const t = buf[0];
          const need = t === 0 ? 20 : t === 2 ? (buf.length >= 4 ? 4 + buf.readUInt16BE(2) * 4 : 4) : t === 3 ? 10 : t === 4 ? 8 : t === 5 ? 6 : t === 6 ? (buf.length >= 8 ? 8 + buf.readUInt32BE(4) : 8) : 1;
          if (buf.length < need) return;
          const m = buf.subarray(0, need);
          buf = buf.subarray(need);
          if (t === 0) rec.pixelFormats.push([...m.subarray(4, 17)]);
          else if (t === 2) rec.encodings.push(Array.from({ length: m.readUInt16BE(2) }, (_, i) => m.readInt32BE(4 + i * 4)));
          else if (t === 3) {
            rec.requests.push({ incremental: m[1], w: m.readUInt16BE(6), h: m.readUInt16BE(8) });
            if (!m[1]) sock.write(fullUpdate());
          } else if (t === 4) rec.keys.push({ down: m[1], keysym: m.readUInt32BE(4) });
          else if (t === 5) rec.pointers.push({ mask: m[1], x: m.readUInt16BE(2), y: m.readUInt16BE(4) });
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
        // Send a CopyRect: (sx, sy, w, h) -> (x, y)
        copyRect(sx, sy, x, y, w, h) {
          const b = Buffer.alloc(4);
          b.writeUInt16BE(sx, 0);
          b.writeUInt16BE(sy, 2);
          for (const s of sockets) s.write(Buffer.concat([Buffer.from([0, 0, 0, 1]), rectHeader(x, y, w, h, 1), b]));
        },
        // DesktopSize to w x h, filled with rgb, sent as one update (resize + raw)
        resize(w, h, rgb) {
          fb = paint(w, h, () => rgb);
          for (const s of sockets) s.write(Buffer.concat([Buffer.from([0, 0, 0, 2]), rectHeader(0, 0, w, h, -223), rectHeader(0, 0, w, h, 0), fb.px]));
        },
        bell() {
          for (const s of sockets) s.write(Buffer.from([2]));
        },
        dropAll() {
          for (const s of sockets) s.destroy();
        },
        close: () => new Promise((r) => (srv.close(() => r()), [...sockets].forEach((s) => s.destroy()))),
      }),
    ),
  );
}
async function freePort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}

// ---------------------------------------------------------------- units
await section('DES + VNC auth', async () => {
  check('DES vector 1', th(desEncryptBlock(hx('133457799BBCDFF1'), hx('0123456789ABCDEF'))), '85e813540f0ab405');
  check('DES vector 2', th(desEncryptBlock(hx('0E329232EA6D0D73'), hx('8787878787878787'))), '0000000000000000');
  check('DES vector 3 (zero key)', th(desEncryptBlock(new Uint8Array(8), new Uint8Array(8))), '8ca64de9c1b123a7');
  const ch = Uint8Array.from({ length: 16 }, (_, i) => i);
  const r1 = vncAuthResponse('password', ch);
  check('VNC response is 16 bytes', r1.length, 16);
  check('VNC response: only the first 8 chars count', th(vncAuthResponse('password-long', ch)), th(r1));
  check('VNC response differs with the password', th(vncAuthResponse('passw0rd', ch)) !== th(r1), true);
});

await section('keysym mapping', async () => {
  const k = (key, code = '') => keysymFor({ key, code });
  check('letters', [k('a', 'KeyA'), k('A', 'KeyA'), k('1', 'Digit1')], [0x61, 0x41, 0x31]);
  check('latin-1 é', k('é', 'Digit2'), 0xe9);
  check('unicode €', k('€', 'KeyE'), 0x010020ac);
  check('arrows', [k('ArrowLeft'), k('ArrowUp'), k('ArrowRight'), k('ArrowDown')], [0xff51, 0xff52, 0xff53, 0xff54]);
  check('function keys', [k('F1'), k('F5'), k('F12')], [0xffbe, 0xffc2, 0xffc9]);
  check('editing keys', [k('Enter'), k('Backspace'), k('Tab'), k('Escape'), k('Delete'), k('Home'), k('End'), k('PageUp')], [0xff0d, 0xff08, 0xff09, 0xff1b, 0xffff, 0xff50, 0xff57, 0xff55]);
  check('modifiers left/right', [k('Shift', 'ShiftLeft'), k('Shift', 'ShiftRight'), k('Control', 'ControlLeft'), k('Control', 'ControlRight'), k('Alt', 'AltLeft'), k('Meta', 'MetaLeft')], [0xffe1, 0xffe2, 0xffe3, 0xffe4, 0xffe9, 0xffeb]);
  check('AltGraph', k('AltGraph', 'AltRight'), 0xfe03);
  check('keypad digit vs navigation', [k('7', 'Numpad7'), k('Home', 'Numpad7')], [0xffb7, 0xff50]);
  check('space', k(' ', 'Space'), 0x20);
  check('dead / unidentified ignored', [k('Dead', 'Quote'), k('Unidentified')], [null, null]);
});

await section('RFB client against the fake server (Node, 3.3 + None, 3.8 + VNC auth)', async () => {
  for (const [version, security, password] of [
    ['003.003', [1], ''],
    ['003.008', [2], 'secret'],
  ]) {
    const srv = await fakeServer({ version, security, width: 8, height: 4 });
    const sock = net.connect(srv.port, '127.0.0.1');
    const ev = { init: null, raws: [], errors: [] };
    const c = new RfbClient({ password, write: (b) => sock.write(b), onInit: (i) => (ev.init = i), onRaw: (x, y, w, h, px) => ev.raws.push({ x, y, w, h, px: [...px.subarray(0, 4)], last: [...px.subarray(px.length - 4)] }), onError: (e) => ev.errors.push(e) });
    sock.on('data', (d) => c.receive(new Uint8Array(d)));
    check(`${version}: init`, await until(() => ev.raws.length > 0, 5000), true);
    check(`${version}: init size + name`, ev.init, { width: 8, height: 4, name: 'Fake VNC' });
    check(`${version}: client version echoed`, srv.rec.versions[0], `RFB ${version}\n`);
    check(`${version}: pixel format R G B X`, srv.rec.pixelFormats[0], [32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 0, 8, 16]);
    check(`${version}: encodings CopyRect, Tight, ZRLE, Hextile, Raw + pseudo-encodings`, srv.rec.encodings[0], [1, 7, 16, 5, 0, -254, -223, -224, -1063131698]);
    check(`${version}: raw pixels red .. blue (alpha 255)`, [ev.raws[0].px, ev.raws[0].last], [[255, 0, 0, 255], [0, 0, 255, 255]]);
    check(`${version}: incremental request after the update`, await until(() => srv.rec.requests.some((r) => r.incremental === 1), 3000), true);
    check(`${version}: no errors`, ev.errors, []);
    sock.destroy();
    await srv.close();
  }
  // wrong password -> EAUTH with the server's reason; no password -> ENEEDPASS
  for (const [pw, code] of [
    ['nope', 'EAUTH'],
    ['', 'ENEEDPASS'],
  ]) {
    const srv = await fakeServer();
    const sock = net.connect(srv.port, '127.0.0.1');
    const errors = [];
    const c = new RfbClient({ password: pw, write: (b) => sock.write(b), onError: (e) => errors.push(e) });
    sock.on('data', (d) => c.receive(new Uint8Array(d)));
    check(`error ${code}`, await until(() => errors.length > 0, 5000) && errors[0].code, code);
    if (code === 'EAUTH') check('EAUTH carries the reason', errors[0].message, 'Authentication failed');
    sock.destroy();
    await srv.close();
  }
  const bad = new RfbClient({ write: () => {}, onError: (e) => (bad.err = e) });
  bad.receive(new TextEncoder().encode('HTTP/1.1 400\r\n'));
  check('not a VNC server -> EPROTO', bad.err?.code, 'EPROTO');
});

await section('RFB client rejects bogus sizes early (Node)', async () => {
  const feed = (bytes) => {
    const ev = { errors: [], raws: 0 };
    const c = new RfbClient({ write: () => {}, onRaw: () => ev.raws++, onError: (e) => ev.errors.push(e) });
    c.receive(new TextEncoder().encode('RFB 003.008\n'));
    c.receive(Uint8Array.of(1, 1, 0, 0, 0, 0)); // security: None, result OK
    c.receive(bytes);
    return { c, ev };
  };
  const init = (w, h) => Uint8Array.of(w >> 8, w & 255, h >> 8, h & 255, ...new Array(16).fill(0), 0, 0, 0, 0);
  check('0x0 ServerInit -> EPROTO', feed(init(0, 0)).ev.errors[0]?.code, 'EPROTO');
  const big = feed(Uint8Array.of(...init(4, 4), 0, 0, 0, 1, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0));
  check('huge Raw rect header fails before its pixels arrive', big.ev.errors[0]?.code, 'EPROTO');
  const empty = feed(Uint8Array.of(...init(4, 4), 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0));
  check('empty Raw rect is skipped without error', [empty.ev.errors.length, empty.ev.raws, empty.c.state], [0, 0, 'connected']);
});

await section('backend helpers', async () => {
  const m = require('../main/ipc/remote.js').__test;
  check('hosts', ['example.com', '192.168.1.2', '::1', 'a b', '-oX', 'x;rm', '999.1.1.1', '', 'http://x'].map((x) => m.hostKind(x)), ['hostname', 'ipv4', 'ipv6', null, null, null, null, null, null]);
  check('ports', [m.validPort(5900), m.validPort('5901'), m.validPort(0), m.validPort(65536), m.validPort('59a'), m.validPort(1.5)], [5900, 5901, null, null, null, null]);
  check('loopback', ['localhost', '127.0.0.1', '127.1.2.3', '::1', '10.0.0.1', 'example.com'].map((x) => m.isLoopback(x)), [true, true, true, true, false, false]);
  const sealed = m.sealSecret('hunter2');
  check('sealed secret is not plain', JSON.stringify(sealed).includes('hunter2'), false);
  check('sealed secret opens', m.openSecret(sealed), 'hunter2');
  check('empty secret not sealed', m.sealSecret(''), null);
});

// ---------------------------------------------------------------- the app in the shell
const srv = await fakeServer({ password: 'secret' });
let s = await launchShell({ open: ['remote'], lang: 'en', theme: 'light', env: { AURORA_REMOTE_TIMEOUT: '4000' } });
let page = s.page;
const q = (sel) => page.evaluate(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? null`);
const infoText = () => q(`${WIN} .rd-info .infobar`);
const hook = (expr) => page.evaluate(`(() => { const r = document.querySelector('${WIN} .rd-root').parentElement.__remote; return ${expr}; })()`);
const pixel = (x, y) => page.evaluate(`[...document.querySelector('${WIN} .rd-canvas').getContext('2d').getImageData(${x}, ${y}, 1, 1).data]`);
async function fillForm({ host = '127.0.0.1', port = srv.port, name = '', password = '', remember = false } = {}) {
  await page.fill(`${WIN} input[name=host]`, String(host));
  await page.fill(`${WIN} input[name=port]`, String(port));
  await page.fill(`${WIN} input[name=name]`, name);
  await page.fill(`${WIN} input[name=password]`, password);
  await page.setChecked(`${WIN} input[name=remember]`, remember);
}
const connected = () => until(() => hook('r.state').then((st) => st === 'connected'), 12000);
const homeShown = () => until(() => page.evaluate(`!document.querySelector('${WIN} .rd-home').hidden`), 12000);

await section('home view', async () => {
  check('window opened', await until(() => page.evaluate(`!!document.querySelector('${WIN} .rd-form')`), 20000), true);
  check('title', await q(`${WIN} .rd-h1`), 'Remote Desktop');
  check('VNC protocol selected', await page.getAttribute(`${WIN} [data-proto=vnc]`, 'aria-checked'), 'true');
  check('RDP offered next to it', await q(`${WIN} [data-proto=rdp]`), 'RDP (Windows)');
  check('empty saved list', (await q(`${WIN} .rd-empty`)).includes('No saved connections'), true);
  check('default port 5900', await page.inputValue(`${WIN} input[name=port]`), '5900');
  check('host field focused', await page.evaluate(`document.activeElement?.name`), 'host');
  check('no null/undefined text', await page.evaluate(`/\\b(null|undefined)\\b/.test(document.querySelector('${WIN} .rd-root').textContent)`), false);
});

await section('form validation and backend validation', async () => {
  await fillForm({ host: 'bad host!' });
  await page.click(`${WIN} [data-act=connect]`);
  check('invalid host message', await infoText(), 'This is not a valid computer name or IP address.');
  check('host aria-invalid', await page.getAttribute(`${WIN} input[name=host]`, 'aria-invalid'), 'true');
  await fillForm({ port: '70000' });
  await page.press(`${WIN} input[name=port]`, 'Enter');
  check('invalid port message (Enter submits)', await infoText(), 'The port must be a number between 1 and 65535.');
  const inv = (...a) => page.evaluate(`window.aurora.invokeRaw(...${JSON.stringify(a)}).then((r) => r.ok ? 'ok' : r.error.code)`);
  check('backend: bad host -> EINVAL', await inv('remote:connect', 'a;b', 5900, {}), 'EINVAL');
  check('backend: port 0 -> EINVAL', await inv('remote:connect', '127.0.0.1', 0, {}), 'EINVAL');
  check('backend: no args -> EINVAL', await inv('remote:connect'), 'EINVAL');
  check('backend: dev mode blocks real network', await inv('remote:connect', 'example.com', 5900, {}), 'EOFFLINE');
  check('backend: write to unknown id is ignored', await page.evaluate(`(window.aurora.send('remote:write', 'nope', new Uint8Array([1])), 'ok')`), 'ok');
});

await section('errors: refused, password needed, wrong password', async () => {
  const closed = await freePort();
  await fillForm({ port: closed });
  await page.click(`${WIN} [data-act=connect]`);
  check('refused', await until(() => infoText().then((x) => (x || '').includes('refused the connection')), 10000), true);
  check('refused names host:port', (await infoText()).includes(`127.0.0.1:${closed}`), true);
  await fillForm({ password: '' });
  await page.click(`${WIN} [data-act=connect]`);
  check('password needed', await until(() => infoText().then((x) => x === 'This computer asks for a password. Type it and connect again.'), 10000), true);
  check('password field focused', await page.evaluate(`document.activeElement?.name`), 'password');
  await fillForm({ password: 'wrong' });
  await page.click(`${WIN} [data-act=connect]`);
  check('wrong password', await until(() => infoText().then((x) => x === 'Wrong password: the remote computer refused it.'), 10000), true);
  check('server saw the failed auth', srv.rec.authFails, 1);
});

await section('connect, draw, keyboard, pointer, Ctrl+Alt+Del', async () => {
  await fillForm({ password: 'secret' });
  await page.click(`${WIN} [data-act=connect]`);
  check('connected', await connected(), true);
  check('canvas size = framebuffer', await page.evaluate(`[document.querySelector('${WIN} .rd-canvas').width, document.querySelector('${WIN} .rd-canvas').height]`), [64, 48]);
  check('first pixels drawn', await until(async () => JSON.stringify(await pixel(5, 5)) === '[255,0,0,255]', 5000), true);
  check('right half blue', await pixel(60, 40), [0, 0, 255, 255]);
  check('status shows size and name', (await q(`${WIN} .rd-sess-status`)).includes('Fake VNC · 64 × 48'), true);
  check('window title', await page.evaluate(`document.querySelector('${WIN} .win-title, ${WIN} .title')?.textContent ?? ''`), (x) => x.includes('127.0.0.1') || x === '');
  check('canvas focused', await page.evaluate(`document.activeElement?.classList.contains('rd-canvas')`), true);

  srv.rec.keys.length = 0;
  await page.keyboard.press('a');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('F2');
  await page.keyboard.press('Shift+B');
  await page.keyboard.press('Tab');
  await until(() => srv.rec.keys.length >= 12, 4000);
  const ks = srv.rec.keys.map((k) => `${k.down ? '+' : '-'}${k.keysym.toString(16)}`);
  check('keys: a, Left, F2, Shift+B, Tab', ks, ['+61', '-61', '+ff51', '-ff51', '+ffbf', '-ffbf', '+ffe1', '+42', '-42', '-ffe1', '+ff09', '-ff09']);
  check('Tab stays in the remote screen', await page.evaluate(`document.activeElement?.classList.contains('rd-canvas')`), true);

  await page.click(`${WIN} [data-scale=actual]`);
  check('100% mode', await hook('r.scale'), 'actual');
  check('100%: CSS size = framebuffer', await page.evaluate(`[document.querySelector('${WIN} .rd-canvas').style.width, document.querySelector('${WIN} .rd-canvas').style.height]`), ['64px', '48px']);
  const box = await page.locator(`${WIN} .rd-canvas`).boundingBox();
  srv.rec.pointers.length = 0;
  await page.mouse.click(box.x + 10.5, box.y + 20.5);
  await until(() => srv.rec.pointers.some((p) => p.mask === 0), 3000);
  check('left click at (10, 20)', srv.rec.pointers.filter((p) => p.mask === 1).map((p) => [p.x, p.y]).pop(), [10, 20]);
  check('button released', srv.rec.pointers.at(-1).mask, 0);
  srv.rec.pointers.length = 0;
  await page.mouse.click(box.x + 30.5, box.y + 5.5, { button: 'right' });
  await until(() => srv.rec.pointers.some((p) => p.mask === 4), 3000);
  check('right click -> mask 4', srv.rec.pointers.find((p) => p.mask === 4) && [srv.rec.pointers.find((p) => p.mask === 4).x, srv.rec.pointers.find((p) => p.mask === 4).y], [30, 5]);
  srv.rec.pointers.length = 0;
  await page.mouse.move(box.x + 20, box.y + 20);
  await page.mouse.wheel(0, 120);
  await until(() => srv.rec.pointers.some((p) => p.mask === 16), 3000);
  check('wheel down -> mask 16 then 0', srv.rec.pointers.slice(-2).map((p) => p.mask), [16, 0]);

  await page.click(`${WIN} [data-scale=fit]`);
  check('fit mode', await hook('r.scale'), 'fit');
  const fitW = await page.evaluate(`parseFloat(document.querySelector('${WIN} .rd-canvas').style.width)`);
  check('fit scales the 64 px screen up', fitW > 300, true);
  const box2 = await page.locator(`${WIN} .rd-canvas`).boundingBox();
  srv.rec.pointers.length = 0;
  await page.mouse.click(box2.x + box2.width * 0.75, box2.y + box2.height * 0.5);
  await until(() => srv.rec.pointers.some((p) => p.mask === 1), 3000);
  const p = srv.rec.pointers.find((x) => x.mask === 1);
  check('scaled click maps to framebuffer coords', p && Math.abs(p.x - 48) <= 1 && Math.abs(p.y - 24) <= 1, true);

  srv.rec.keys.length = 0;
  await page.click(`${WIN} [data-act=cad]`);
  await until(() => srv.rec.keys.length >= 6, 3000);
  check('Ctrl+Alt+Del sequence', srv.rec.keys.map((k) => `${k.down ? '+' : '-'}${k.keysym.toString(16)}`), ['+ffe3', '+ffe9', '+ffff', '-ffff', '-ffe9', '-ffe3']);
  check('focus back on the screen', await page.evaluate(`document.activeElement?.classList.contains('rd-canvas')`), true);
});

await section('CopyRect, DesktopSize, bell', async () => {
  srv.copyRect(0, 0, 56, 40, 8, 8);
  check('CopyRect copies red into the blue half', await until(async () => JSON.stringify(await pixel(60, 44)) === '[255,0,0,255]', 5000), true);
  check('CopyRect leaves the rest', await pixel(40, 10), [0, 0, 255, 255]);
  srv.bell();
  srv.resize(80, 60, [0, 200, 0]);
  check('DesktopSize resizes the canvas', await until(() => page.evaluate(`document.querySelector('${WIN} .rd-canvas').width === 80 && document.querySelector('${WIN} .rd-canvas').height === 60`), 5000), true);
  check('new content drawn', await until(async () => JSON.stringify(await pixel(70, 50)) === '[0,200,0,255]', 5000), true);
  check('full refresh asked after resize', await until(() => srv.rec.requests.at(-1)?.incremental === 0 && srv.rec.requests.at(-1)?.w === 80, 3000) || srv.rec.requests.some((r) => r.incremental === 0 && r.w === 80), true);
  check('status shows the new size', (await q(`${WIN} .rd-sess-status`)).includes('80 × 60'), true);
  check('still connected', await hook('r.state'), 'connected');
});

await section('full screen and keyboard escape hatch', async () => {
  await page.click(`${WIN} [data-act=fullscreen]`);
  check('window full screen', await until(() => page.evaluate(`document.querySelector('${WIN}').classList.contains('fullscreen')`), 3000), true);
  check('button says exit', await page.getAttribute(`${WIN} [data-act=fullscreen]`, 'aria-label'), 'Exit full screen');
  await page.focus(`${WIN} .rd-canvas`);
  await page.keyboard.press('Control+Alt+Enter');
  check('Ctrl+Alt+Enter leaves full screen', await until(() => page.evaluate(`!document.querySelector('${WIN}').classList.contains('fullscreen')`), 3000), true);
  await page.focus(`${WIN} .rd-canvas`);
  await page.keyboard.press('Control+Alt+Home');
  check('Ctrl+Alt+Home focuses the connection bar', await page.evaluate(`!!document.activeElement?.closest('.rd-bar')`), true);
});

await section('closed by the server, disconnect', async () => {
  srv.dropAll();
  check('closed message', await until(() => infoText().then((x) => x === 'The connection was closed by the remote computer.'), 8000), true);
  check('home view back', await homeShown(), true);
  await page.click(`${WIN} [data-act=connect]`);
  check('reconnects', await connected(), true);
  const before = srv.sockets.size;
  await page.click(`${WIN} [data-act=disconnect]`);
  check('disconnected message', await until(() => infoText().then((x) => x === 'Disconnected from 127.0.0.1.'), 5000), true);
  check('server socket closed', await until(() => srv.sockets.size < before, 5000), true);
  check('state idle', await hook('r.state'), 'idle');
});

await section('saved connections', async () => {
  const file = path.join(s.home, '.local', 'share', 'aurora', 'remote.json');
  await fillForm({ name: 'Lab box', password: 'secret', remember: false });
  await page.click(`${WIN} [data-act=save]`);
  check('saved message', await until(() => infoText().then((x) => x === '"Lab box" was saved.'), 5000), true);
  check('file written', fs.existsSync(file), true);
  let j = JSON.parse(fs.readFileSync(file, 'utf8'));
  check('entry stored without password', [j.connections.length, j.connections[0].name, j.connections[0].host, j.connections[0].port, 'secret' in j.connections[0]], [1, 'Lab box', '127.0.0.1', srv.port, false]);
  check('password not in the file', fs.readFileSync(file, 'utf8').includes('secret"') || fs.readFileSync(file, 'utf8').includes(':"secret'), false);
  check('listed', await until(() => q(`${WIN} .rd-item-name`).then((x) => x === 'Lab box'), 5000), true);
  // connect from the list without a remembered password -> asks for it
  await page.click(`${WIN} [data-act=connect-saved]`);
  check('saved without password asks for one', await until(() => infoText().then((x) => (x || '').includes('asks for a password')), 8000), true);
  check('form switched to edit', await q(`${WIN} .rd-form-head .rd-h2`), 'Edit connection');
  // remember the password
  await page.fill(`${WIN} input[name=password]`, 'secret');
  await page.setChecked(`${WIN} input[name=remember]`, true);
  await page.click(`${WIN} [data-act=save]`);
  await until(() => q(`${WIN} .rd-item-addr`).then((x) => (x || '').includes('password saved')), 5000);
  j = JSON.parse(fs.readFileSync(file, 'utf8'));
  check('still one entry (updated)', j.connections.length, 1);
  check('secret stored obfuscated', [j.connections[0].secret?.m, Buffer.from(j.connections[0].secret?.v || '', 'base64').toString('latin1').includes('secret'), /:\s*"secret"/.test(fs.readFileSync(file, 'utf8'))], ['obf', false, false]);
  check('list shows password saved', (await q(`${WIN} .rd-item-addr`)).includes('password saved'), true);
  await page.click(`${WIN} [data-act=connect-saved]`);
  check('connects with the remembered password', await connected(), true);
  check('session title is the name', await q(`${WIN} .rd-sess-title`), 'Lab box');
  await page.click(`${WIN} [data-act=disconnect]`);
  await homeShown();
  // uncheck remember -> secret removed
  await page.click(`${WIN} [data-act=edit]`);
  check('edit fills the form', [await page.inputValue(`${WIN} input[name=name]`), await page.isChecked(`${WIN} input[name=remember]`)], ['Lab box', true]);
  await page.setChecked(`${WIN} input[name=remember]`, false);
  await page.click(`${WIN} [data-act=save]`);
  await until(() => q(`${WIN} .rd-item-addr`).then((x) => !(x || '').includes('password saved')), 5000);
  check('forget password removes the secret', 'secret' in JSON.parse(fs.readFileSync(file, 'utf8')).connections[0], false);
  fs.copyFileSync(await s.shot('remote-light-en'), path.join(DOCS, 'remote-light-en.png'));
  // delete with confirmation
  await page.click(`${WIN} [data-act=delete]`);
  check('confirm dialog', await until(() => page.evaluate(`!!document.querySelector('.dialog')`), 3000), true);
  await page.keyboard.press('Enter');
  check('deleted', await until(() => page.evaluate(`!document.querySelector('${WIN} .rd-item') && !!document.querySelector('${WIN} .rd-empty')`), 5000), true);
  check('file empty', JSON.parse(fs.readFileSync(file, 'utf8')).connections.length, 0);
});

await section('one connection per window, close cleans up', async () => {
  await fillForm({ password: 'secret' });
  await page.click(`${WIN} [data-act=connect]`);
  await connected();
  const n = srv.sockets.size;
  await page.evaluate(`window.aurora.invokeRaw('remote:connect', '127.0.0.1', ${srv.port}, { key: 'other' })`);
  await until(() => srv.sockets.size === n + 1, 3000);
  await page.click(`${WIN} [data-act=disconnect]`);
  await homeShown();
  await page.click(`${WIN} [data-act=connect]`);
  await connected();
  check('reconnect replaced the old one (same window key)', await until(() => srv.sockets.size === n + 1, 3000), true);
  await page.click(`${WIN} .win-close`);
  check('window closed', await until(() => page.evaluate(`!document.querySelector('${WIN}')`), 5000), true);
  check('its socket closed', await until(() => srv.sockets.size === n, 5000), true);
});
await s.close();

// ---------------------------------------------------------------- French + dark
await section('French + dark', async () => {
  const srv2 = await fakeServer({ password: 'secret', width: 320, height: 200, desktop: true, name: 'Bureau de test' });
  s = await launchShell({ open: ['remote'], lang: 'fr', theme: 'dark' });
  page = s.page;
  check('window opened', await until(() => page.evaluate(`!!document.querySelector('${WIN} .rd-form')`), 20000), true);
  check('FR title', await q(`${WIN} .rd-h1`), 'Bureau à distance');
  check('FR connect button', await q(`${WIN} [data-act=connect]`), 'Se connecter');
  check('FR protocols', [await q(`${WIN} [data-proto=vnc]`), await q(`${WIN} [data-proto=rdp]`)], ['VNC', 'RDP (Windows)']);
  await fillForm({ host: '', port: srv2.port });
  await page.click(`${WIN} [data-act=connect]`);
  check('FR empty host message', await infoText(), "Saisissez le nom ou l'adresse IP de l'ordinateur.");
  await fillForm({ port: srv2.port, password: 'mauvais' });
  await page.click(`${WIN} [data-act=connect]`);
  check('FR wrong password', await until(() => infoText().then((x) => x === "Mot de passe incorrect : l'ordinateur distant l'a refusé."), 10000), true);
  await fillForm({ port: srv2.port, name: 'Serveur de test', password: 'secret' });
  await page.click(`${WIN} [data-act=connect]`);
  check('FR connected', await connected(), true);
  check('FR toolbar', [await q(`${WIN} [data-act=cad]`), await q(`${WIN} [data-act=disconnect]`), await q(`${WIN} [data-scale=fit]`)], ['Ctrl+Alt+Suppr', 'Se déconnecter', 'Ajuster à la fenêtre']);
  check('no raw i18n keys', await page.evaluate(`/\\b(app|form|saved|session|err)\\.[a-z]+/i.test(document.querySelector('${WIN}').textContent)`), false);
  check('dark theme', await page.evaluate(`document.documentElement.dataset.theme`), 'dark');
  await sleep(300);
  fs.copyFileSync(await s.shot('remote-dark-fr'), path.join(DOCS, 'remote-dark-fr.png'));
  await s.close();
  await srv2.close();
});
await srv.close();

console.log(`\n${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  ✗ ${f}`);
process.exit(failures.length ? 1 : 0);
