// Musique: the Lecteur's music side (renderer/apps/media) and the « Musique » launcher alias (renderer/apps/music).
// Run: cd aurora-os/shell && xvfb-run -a -s "-screen 0 1600x900x24" node test/music.test.mjs
// 1. Unit: LRC parser (lib/lyrics.js), embedded lyrics (ID3 USLT).
// 2. Shell (FR, Halo, 1280x720): the alias opens the Lecteur on its albums; folder.jpg becomes the album cover;
//    a .lrc next to a track shows synced lyrics in the now playing view, the current line follows the playback.
// Screenshots: test/out/music-*.png (Halo dark + light).
import { launchShell } from './lib.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(here, '..', 'renderer', 'apps', 'media');
const results = [];
async function test(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name} (${Date.now() - t0} ms)`);
  } catch (err) {
    results.push({ name, ok: false });
    console.log(`FAIL  ${name}\n      ${String(err?.stack || err).split('\n').slice(0, 6).join('\n      ')}`);
  }
}
async function load(rel) {
  const src = fs.readFileSync(path.join(APP, rel), 'utf8');
  return import(`data:text/javascript;base64,${Buffer.from(src).toString('base64')}`);
}

// ------------------------------------------------------------------ unit
const L = await load('lib/lyrics.js');
await test('unit: LRC parser (stamps, several stamps per line, offset, header tags, plain text)', () => {
  const r = L.parseLrc('﻿[ar:Someone]\n[ti:Song]\n[offset:+500]\n[00:01.00]One\n[00:03.50][00:07.25]Two\n[00:05]Three\n\n[01:02.123]Last');
  assert.equal(r.synced, true);
  assert.deepEqual(r.lines.map((l) => l.text), ['One', 'Two', 'Three', 'Two', 'Last']);
  assert.deepEqual(r.lines.map((l) => +l.t.toFixed(3)), [0.5, 3, 4.5, 6.75, 61.623]);
  assert.equal(L.lineAt(r.lines, 0.2), -1);
  assert.equal(L.lineAt(r.lines, 0.5), 0);
  assert.equal(L.lineAt(r.lines, 4.6), 2);
  assert.equal(L.lineAt(r.lines, 99), 4);
  const p = L.parseLrc('\n\nFirst verse\r\nsecond line\n\n');
  assert.equal(p.synced, false);
  assert.deepEqual(p.lines.map((l) => l.text), ['First verse', 'second line']);
  assert.equal(L.lrcPathOf('/m/a/01 Song.mp3'), '/m/a/01 Song.lrc');
  assert.equal(L.lrcPathOf('/m/a.b/song'), '/m/a.b/song.lrc');
});

await test('unit: embedded lyrics (ID3v2.3 USLT)', async () => {
  const T = await load('lib/tags.js');
  const frame = (id, body) => {
    const h = Buffer.alloc(10);
    h.write(id, 0, 'latin1');
    h.writeUInt32BE(body.length, 4);
    return Buffer.concat([h, body]);
  };
  const frames = Buffer.concat([
    frame('TIT2', Buffer.from('\x00Lune', 'latin1')),
    frame('USLT', Buffer.concat([Buffer.from([3]), Buffer.from('fra'), Buffer.from('desc\0'), Buffer.from('Au clair de la lune\nmon ami Pierrot', 'utf8')])),
  ]);
  const head = Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0]);
  const n = frames.length;
  head[6] = (n >> 21) & 0x7f;
  head[7] = (n >> 14) & 0x7f;
  head[8] = (n >> 7) & 0x7f;
  head[9] = n & 0x7f;
  const out = T.parseId3v2(new Uint8Array(Buffer.concat([head, frames])));
  assert.equal(out.title, 'Lune');
  assert.equal(out.lyrics, 'Au clair de la lune\nmon ami Pierrot');
});

// ------------------------------------------------------------------ fixtures
function wavFile({ seconds = 2, rate = 22050, freq = 440, title, artist } = {}) {
  const n = Math.floor(seconds * rate);
  const pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 0.2 * 32767), i * 2);
  const chunk = (id, body) => {
    const h = Buffer.alloc(8);
    h.write(id, 0, 'latin1');
    h.writeUInt32LE(body.length, 4);
    return Buffer.concat([h, body, body.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
  };
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(1, 0);
  fmt.writeUInt16LE(1, 2);
  fmt.writeUInt32LE(rate, 4);
  fmt.writeUInt32LE(rate * 2, 8);
  fmt.writeUInt16LE(2, 12);
  fmt.writeUInt16LE(16, 14);
  const info = [];
  if (title) info.push(chunk('INAM', Buffer.from(`${title}\0`)));
  if (artist) info.push(chunk('IART', Buffer.from(`${artist}\0`)));
  const list = info.length ? chunk('LIST', Buffer.concat([Buffer.from('INFO'), ...info])) : Buffer.alloc(0);
  const body = Buffer.concat([Buffer.from('WAVE'), chunk('fmt ', fmt), list, chunk('data', pcm)]);
  const riff = Buffer.alloc(8);
  riff.write('RIFF', 0, 'latin1');
  riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-music-'));
const ALBUM = path.join(home, 'Music', 'Nuits claires');
fs.mkdirSync(ALBUM, { recursive: true });
const TRACK = path.join(ALBUM, '01 - Lune Rousse - Marée haute.wav');
fs.writeFileSync(TRACK, wavFile({ seconds: 12, freq: 392, title: 'Marée haute', artist: 'Lune Rousse' }));
fs.writeFileSync(path.join(ALBUM, '02 - Lune Rousse - Phare.wav'), wavFile({ seconds: 6, freq: 494, title: 'Phare', artist: 'Lune Rousse' }));
fs.writeFileSync(
  TRACK.replace(/\.wav$/, '.lrc'),
  '[ar:Lune Rousse]\n[ti:Marée haute]\n[00:00.00]La mer monte sans bruit\n[00:01.20]Sous la lune rousse\n[00:02.40]Les bateaux rentrent au port\n[00:03.60]Et le phare s’allume\n[00:05.00]On attend la marée haute\n[00:06.50]Jusqu’au matin\n[00:08.00]La mer monte sans bruit\n[00:10.00]…\n',
);
// folder.jpg: a small PNG picture (Chromium sniffs the type), the album cover of the folder: a dusk gradient
function gradientPng(W = 96, H = 96) {
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) {
    raw[y * (W * 3 + 1)] = 0;
    for (let x = 0; x < W; x++) {
      const t = (x + y) / (W + H);
      const o = y * (W * 3 + 1) + 1 + x * 3;
      raw[o] = Math.round(255 - 120 * t);
      raw[o + 1] = Math.round(150 - 90 * t);
      raw[o + 2] = Math.round(110 + 110 * t);
    }
  }
  const crcT = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b) => {
    let c = 0xffffffff;
    for (const v of b) c = crcT[(c ^ v) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const PNG = gradientPng();
fs.writeFileSync(path.join(ALBUM, 'folder.jpg'), PNG);

// ------------------------------------------------------------------ shell
const s = await launchShell({ home, lang: 'fr', theme: 'dark', size: '1280x720', keepHome: true });
const WIN = '.win.app-media';
const M = (fn, arg) => s.page.evaluate(`(${fn.toString()})([...document.querySelectorAll(${JSON.stringify(WIN)})].pop()?.__media, ${JSON.stringify(arg ?? null)})`);
async function waitFor(fn, arg, { timeout = 10000, what } = {}) {
  const t0 = Date.now();
  let last;
  for (;;) {
    last = await M(fn, arg).catch((e) => `ERR ${e.message}`);
    if (last && !(typeof last === 'string' && last.startsWith('ERR '))) return last;
    if (Date.now() - t0 > timeout) throw new Error(`timeout waiting for ${what} (last: ${JSON.stringify(last)})`);
    await s.page.waitForTimeout(100);
  }
}

await test('« Musique » is a Lanceur entry with its own icon that opens the Lecteur on its albums', async () => {
  const info = await s.aurora(() => {
    const r = window.__aurora.registry;
    return { name: r.name('music'), listed: r.list().some((m) => m.id === 'music'), icon: r.iconUrl('music'), media: r.iconUrl('media'), alias: r.get('music')?.alias };
  });
  assert.equal(info.name, 'Musique');
  assert.ok(info.listed, 'listed in the Lanceur');
  assert.notEqual(info.icon, info.media, 'its own icon');
  assert.match(info.icon, /music/);
  assert.equal(info.alias.app, 'media');
  await s.aurora(() => window.__aurora.registry.launch('music'));
  await s.page.waitForSelector(WIN, { timeout: 10000 });
  await waitFor((a) => a && a.route.name === 'music' && a.route.arg === 'albums', null, { what: 'music albums route' });
  assert.equal(await s.aurora(() => window.__aurora.wm.byApp('music').length), 0, 'no second app window');
  // search finds it
  const found = await s.aurora(() => window.__aurora.registry.list().filter((m) => (m.keywords?.fr || []).includes('paroles')).map((m) => m.id));
  assert.deepEqual(found, ['music']);
  // launching it again while the Lecteur is elsewhere comes back to the music library
  await M((a) => a.go({ name: 'videos' }));
  await s.aurora(() => window.__aurora.registry.launch('music'));
  await waitFor((a) => a.route.name === 'music', null, { what: 'back to music' });
  assert.equal(await s.aurora(() => window.__aurora.wm.byApp('media').length), 1);
});

await test('albums: folder.jpg is the album cover', async () => {
  await waitFor((a, p) => a.lib.get(p)?.art, TRACK, { what: 'cover from folder.jpg' });
  const art = await M((a, p) => a.lib.get(p).art, TRACK);
  assert.ok(art.includes('/.cache/aurora/media/art/'), art);
  await M((a) => a.render());
  await s.page.waitForSelector(`${WIN} .mp-music .mp-tile img`, { timeout: 5000 });
  await s.page.waitForTimeout(500);
  await s.shot('music-albums-fr-dark');
});

await test('lyrics: the .lrc next to the track is shown synced in the now playing view', async () => {
  await M((a, p) => a.playEntries([p], 0), TRACK);
  await M((a) => a.openStage());
  await s.page.waitForSelector(`${WIN} .mp-lyrics.synced:not([hidden]) .mp-lyr-line`, { timeout: 8000 });
  assert.equal(await s.page.locator(`${WIN} .mp-lyr-line`).count(), 8);
  assert.match(await s.page.textContent(`${WIN} .mp-lyrics .mp-np-kicker`), /Paroles/);
  await waitFor((a) => a.player.currentTime > 2.6, null, { what: 'playback reaches the third line' });
  await s.page.waitForTimeout(250);
  const cur = await s.page.textContent(`${WIN} .mp-lyr-line.current`);
  assert.match(cur, /bateaux|phare/);
  // clicking a line seeks to it
  await s.page.click(`${WIN} .mp-lyr-line[data-i="5"]`);
  await waitFor((a) => a.player.currentTime >= 6.4 && a.player.currentTime < 8, null, { what: 'seek to the clicked line' });
  await s.page.waitForSelector(`${WIN} .mp-lyr-line.current[data-i="5"]`, { timeout: 3000 });
  await M((a) => a.player.pause());
  await s.page.waitForTimeout(600);
  await s.shot('music-lyrics-fr-dark');
  await s.aurora(() => window.__aurora.settings.set('theme', 'light'));
  await s.page.waitForTimeout(700);
  await s.shot('music-lyrics-fr-light');
  await M((a) => a.closeStage());
  await s.page.waitForTimeout(500);
  await s.shot('music-albums-fr-light');
});

await test('lyrics: a track without lyrics shows none', async () => {
  await M((a, p) => a.playEntries([p], 0), path.join(ALBUM, '02 - Lune Rousse - Phare.wav'));
  await M((a) => a.openStage());
  await s.page.waitForTimeout(800);
  assert.equal(await s.page.locator(`${WIN} .mp-lyrics:not([hidden])`).count(), 0);
  await M((a) => (a.player.pause(), a.closeStage()));
});

await test('no console errors', async () => {
  const errs = s.logs.filter((l) => (l.startsWith('[pageerror]') || (l.startsWith('[error]') && !/Failed to load resource/.test(l))) && !/aurora-pty|terminal/i.test(l));
  assert.deepEqual(errs, []);
});

await s.close();
fs.rmSync(home, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} tests passed`);
process.exit(failed.length ? 1 : 0);
