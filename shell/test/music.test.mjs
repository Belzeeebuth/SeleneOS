// Musique: the Lecteur's music side (renderer/apps/media) and the « Musique » launcher alias (renderer/apps/music).
// Run: cd aurora-os/shell && xvfb-run -a -s "-screen 0 1600x900x24" node test/music.test.mjs
// 1. Unit: LRC parser (lib/lyrics.js), embedded lyrics (ID3 USLT).
// 2. Shell (FR, Halo, 1280x720): the alias opens the Lecteur on its albums; folder.jpg becomes the album cover;
//    the Genres tab groups the songs by their genre tag (a genre page: its albums, its songs, « Lecture aléatoire »);
//    a .lrc next to a track shows synced lyrics in the now playing view, the current line follows the playback.
// 3. Media session (MPRIS, core/features/mediactl.js, apps/media/lib/session.js): <Music>/Podcasts left out of the
//    library (setting); the media card in Réglages rapides (track, cover, play / pause, next, seek; EN + FR, dark +
//    light); media keys through the real hotkeys path (main/lib/hotkeys.js -> shell:hotkey) and the media OSD;
//    with python3-dbus (AURORA_SESSIONBUS_PYTHON, default python3.12) the shell runs on a PRIVATE dbus-daemon: the
//    Lecteur as org.mpris.MediaPlayer2.selene (read and driven by a probe client), a fake external player
//    (test/fixtures/sessionbus/fake-player.py) shown in the card, followed by the media keys, the player menu.
// Screenshots: test/out/music-*.png (Halo dark + light), test/out/mediactl-*.png (media card, OSD).
import { launchShell } from './lib.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { spawn, spawnSync } from 'node:child_process';

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
function wavFile({ seconds = 2, rate = 22050, freq = 440, title, artist, album, genre } = {}) {
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
  if (album) info.push(chunk('IPRD', Buffer.from(`${album}\0`)));
  if (genre) info.push(chunk('IGNR', Buffer.from(`${genre}\0`)));
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
fs.writeFileSync(TRACK, wavFile({ seconds: 12, freq: 392, title: 'Marée haute', artist: 'Lune Rousse', album: 'Nuits claires', genre: 'Chanson' }));
fs.writeFileSync(path.join(ALBUM, '02 - Lune Rousse - Phare.wav'), wavFile({ seconds: 6, freq: 494, title: 'Phare', artist: 'Lune Rousse', album: 'Nuits claires', genre: 'Chanson' }));
// more genres: « chanson » in another album (one genre with « Chanson »), Jazz, and a song without a genre
const more = (dir, file, o) => {
  fs.mkdirSync(path.join(home, 'Music', dir), { recursive: true });
  fs.writeFileSync(path.join(home, 'Music', dir, file), wavFile({ seconds: 2, ...o }));
};
more('Divers', 'Escale.wav', { freq: 523, title: 'Escale', artist: 'Lune Rousse', album: 'Divers', genre: 'chanson' });
more('Matins', '01 Aube.wav', { freq: 330, title: 'Aube', artist: 'Trio Aube', album: 'Matins', genre: 'Jazz' });
more('Matins', '02 Rosée.wav', { freq: 349, title: 'Rosée', artist: 'Trio Aube', album: 'Matins', genre: 'Jazz' });
more('Matins', '03 Brume.wav', { freq: 370, title: 'Brume', artist: 'Trio Aube', album: 'Matins' });
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
// « Podcasts et actus » downloads episodes to <Music>/Podcasts: not music, left out of the library by default
const PODCAST = path.join(home, 'Music', 'Podcasts', 'Radio Lune', 'Épisode 1.wav');
fs.mkdirSync(path.dirname(PODCAST), { recursive: true });
fs.writeFileSync(PODCAST, wavFile({ seconds: 2, freq: 600, title: 'Épisode 1', artist: 'Radio Lune', album: 'Radio Lune', genre: 'Podcast' }));

// private session bus (never the machine's): the sessionbus helper exports the Lecteur, a fake player joins it
const PY = process.env.AURORA_SESSIONBUS_PYTHON || 'python3.12';
const pyPath = spawnSync('sh', ['-c', `command -v ${PY}`], { encoding: 'utf8' }).stdout.trim();
const HAVE_BUS = !!pyPath && spawnSync(pyPath, ['-c', 'import dbus, gi; from gi.repository import GLib'], { stdio: 'ignore' }).status === 0 && spawnSync('sh', ['-c', 'command -v dbus-daemon'], { stdio: 'ignore' }).status === 0;
const ROOT = path.join(here, '..');
let bus = null;
if (HAVE_BUS) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-music-bus-'));
  const r = spawnSync('dbus-daemon', ['--session', '--fork', '--print-address=1', '--print-pid=1', `--address=unix:path=${tmp}/bus`], { encoding: 'utf8' });
  const [address, pid] = r.stdout.trim().split('\n');
  bus = { tmp, address, pid: Number(pid), stop: () => (process.kill(Number(pid), 'SIGTERM'), fs.rmSync(tmp, { recursive: true, force: true })) };
} else console.log(`(no python3-dbus for ${PY}: the session bus checks are skipped)`);
function fakePlayer() {
  const p = spawn(pyPath, ['-I', path.join(here, 'fixtures', 'sessionbus', 'fake-player.py')], { env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: bus.address }, stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = [];
  let buf = '';
  let mark = 0;
  p.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      try {
        lines.push(JSON.parse(buf.slice(0, i)));
      } catch {}
      buf = buf.slice(i + 1);
    }
  });
  const until = async (fn, ms = 5000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const v = fn();
      if (v) return v;
      await new Promise((r) => setTimeout(r, 50));
    }
    return null;
  };
  return {
    lines,
    since: () => (mark = lines.length),
    wait: (pred, ms) => until(() => lines.slice(mark).find(pred), ms),
    ask(o, pred, ms) {
      mark = lines.length;
      p.stdin.write(`${JSON.stringify(o)}\n`);
      return until(() => lines.slice(mark).find(pred), ms);
    },
    quit() {
      try {
        p.stdin.write('{"cmd":"quit"}\n');
      } catch {}
      setTimeout(() => p.kill(), 1000);
    },
  };
}

// ------------------------------------------------------------------ shell
const s = await launchShell({
  home,
  lang: 'fr',
  theme: 'dark',
  size: '1280x720',
  keepHome: true,
  env: bus ? { DBUS_SESSION_BUS_ADDRESS: bus.address, AURORA_SESSIONBUS: '1', AURORA_SESSIONBUS_HELPER: path.join(ROOT, '..', 'rootfs', 'usr', 'lib', 'aurora', 'helpers', 'aurora-sessionbus'), AURORA_SESSIONBUS_PYTHON: pyPath } : {},
});
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

await test('genres: a Genres tab next to Titres / Albums / Artistes, a genre page with its albums, songs and « Lecture aléatoire »', async () => {
  await waitFor((a) => a.lib.songs().length === 6 && a.lib.songs().every((e) => e.tagged), null, { what: 'six songs tagged' });
  const lib = await M((a) => a.genres().map((g) => [g.name, g.songs.length, g.unknown]));
  assert.deepEqual(lib, [['Chanson', 3, false], ['Jazz', 2, false], ['Genre inconnu', 1, true]]);
  await M((a) => a.go({ name: 'music', arg: 'albums' }));
  const tabs = await s.page.$$eval(`${WIN} .mp-tabs .tab`, (els) => els.map((e) => [e.dataset.tab, e.textContent]));
  assert.deepEqual(tabs, [['songs', 'Titres'], ['albums', 'Albums'], ['artists', 'Artistes'], ['genres', 'Genres']]);
  await s.page.click(`${WIN} .mp-tabs [data-tab="genres"]`);
  await s.page.waitForSelector(`${WIN} .mp-genres .mp-tile`, { timeout: 5000 });
  assert.equal(await M((a) => a.route.arg), 'genres');
  assert.equal(await s.page.textContent(`${WIN} .mp-music .mp-count`), '3 genres');
  assert.match(await s.page.textContent(`${WIN} .mp-music .mp-toolbar .mp-shuffle-play`), /Lecture aléatoire/);
  const tiles = await s.page.$$eval(`${WIN} .mp-genres .mp-tile`, (els) => els.map((e) => [e.querySelector('.mp-tile-title').textContent, e.querySelector('.mp-tile-sub').textContent]));
  assert.deepEqual(tiles, [['Chanson', '2 albums · 3 titres'], ['Jazz', '1 album · 2 titres'], ['Genre inconnu', '1 album · 1 titre']]);
  await s.page.waitForTimeout(400);
  await s.shot('music-genres-fr-dark');
  // a genre page
  await s.page.click(`${WIN} .mp-genres .mp-tile >> nth=0`);
  await s.page.waitForSelector(`${WIN} .mp-genre .mp-row`, { timeout: 5000 });
  assert.deepEqual(await M((a) => a.route), { name: 'genre', arg: 'chanson' });
  assert.equal(await s.page.textContent(`${WIN} .mp-genre .mp-hero-title`), 'Chanson');
  assert.equal(await s.page.textContent(`${WIN} .mp-genre .mp-kicker`), 'Genre');
  assert.match(await s.page.textContent(`${WIN} .mp-genre .mp-hero-line`), /^2 albums · 3 titres/);
  assert.deepEqual(await s.page.$$eval(`${WIN} .mp-genre-albums .mp-tile-title`, (els) => els.map((e) => e.textContent)), ['Divers', 'Nuits claires']);
  assert.deepEqual((await s.page.$$eval(`${WIN} .mp-genre .mp-row .mp-row-title`, (els) => els.map((e) => e.textContent))).sort(), ['Escale', 'Marée haute', 'Phare']);
  assert.equal(await s.page.getAttribute(`${WIN} [data-nav="music"]`, 'aria-current'), 'page');
  const shuffle = `${WIN} .mp-genre .mp-hero .mp-shuffle-play`;
  assert.match(await s.page.textContent(shuffle), /Lecture aléatoire/);
  assert.ok(await s.page.$eval(shuffle, (b) => b.classList.contains('primary')), '« Lecture aléatoire » is the main action');
  await s.page.waitForTimeout(400);
  await s.shot('music-genre-fr-dark');
  await s.page.click(shuffle);
  await waitFor((a) => a.queue.length === 3 && a.queue.shuffle && !a.player.paused, null, { what: 'genre shuffled into the queue' });
  const q = await M((a) => a.queue.items.map((i) => i.path.split('/').pop()).sort());
  assert.deepEqual(q, ['01 - Lune Rousse - Marée haute.wav', '02 - Lune Rousse - Phare.wav', 'Escale.wav']);
  await M((a) => a.player.pause());
  await s.aurora(() => window.__aurora.settings.set('theme', 'light'));
  await s.page.waitForTimeout(700);
  await s.shot('music-genre-fr-light');
  await s.aurora(() => window.__aurora.settings.set('theme', 'dark'));
  await M((a) => a.queue.shuffle && a.toggleShuffle());
  await s.page.waitForTimeout(500);
  // another genre by its route; a genre that is no longer in the library shows « gone »
  await M((a) => a.go({ name: 'genre', arg: 'jazz' }));
  await s.page.waitForSelector(`${WIN} .mp-genre .mp-row`, { timeout: 5000 });
  assert.equal(await s.page.textContent(`${WIN} .mp-genre .mp-hero-title`), 'Jazz');
  await M((a) => a.go({ name: 'genre', arg: 'polka' }));
  await s.page.waitForSelector(`${WIN} .mp-genre .mp-empty, ${WIN} .mp-genre .empty`, { timeout: 5000 });
  await M((a) => a.go({ name: 'music', arg: 'albums' }));
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

// ------------------------------------------------------------------ media session
const A = (fn, arg) => s.aurora(fn, arg);
const PHARE = path.join(ALBUM, '02 - Lune Rousse - Phare.wav');
const fromMain = (combo) =>
  s.app.evaluate(({ BrowserWindow }, c) => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('aurora:event', 'shell:hotkey', { combo: c, repeat: false });
  }, combo);
// a real key press through Chromium's input path (main's before-input-event sees it, like a keyboard's media key; the
// CDP keys of page.keyboard skip that path); Electron names: MediaPlayPause, MediaNextTrack, MediaPreviousTrack, MediaStop
const pressKey = (code) =>
  s.app.evaluate(({ BrowserWindow }, k) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.webContents.sendInputEvent({ type: 'keyDown', keyCode: k });
    w.webContents.sendInputEvent({ type: 'keyUp', keyCode: k });
  }, code);
async function until(fn, { timeout = 6000, what } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`timeout waiting for ${what}`);
    await s.page.waitForTimeout(80);
  }
}
const card = () =>
  s.page.evaluate(() => {
    const c = document.querySelector('#quick-settings .mc-card');
    if (!c || c.hidden || !document.querySelector('#quick-settings.open')) return null;
    return {
      player: c.dataset.player,
      status: c.dataset.status,
      title: c.querySelector('.mc-title').textContent,
      artist: c.querySelector('.mc-artist').textContent,
      art: c.querySelector('.mc-art img')?.getAttribute('src') || null,
      name: c.querySelector('.mc-player-name')?.textContent,
      menu: !c.querySelector('.mc-player').disabled,
      play: c.querySelector('.mc-play').getAttribute('aria-label'),
      next: !c.querySelector('.mc-next').disabled,
      at: c.querySelector('.mc-at').textContent,
      len: c.querySelector('.mc-len').textContent,
      label: c.getAttribute('aria-label'),
    };
  });
const openQuick = async () => {
  await A(() => window.__aurora.quick.open());
  await s.page.waitForSelector('#quick-settings.open .mc-card:not([hidden])', { timeout: 5000 });
  await s.page.waitForTimeout(350);
};
const closeQuick = () => A(() => window.__aurora.quick.close());

await test('Podcasts: <Musique>/Podcasts stays out of the music library (setting « Ignorer le dossier Podcasts », on by default)', async () => {
  await waitFor((a) => !a.lib.scanning && a.lib.songs().length === 6, null, { what: 'six songs' });
  assert.equal(await M((a, p) => a.lib.songs().some((e) => e.path === p) || a.lib.inLibrary.has(p), PODCAST), false, 'the episode is not in the library');
  assert.equal(await M((a) => a.prefs.skipPodcasts), true);
  await M((a) => a.go({ name: 'settings' }));
  await s.page.waitForSelector(`${WIN} .mp-skip-podcasts`, { timeout: 5000 });
  assert.equal(await s.page.$eval(`${WIN} .mp-skip-podcasts input`, (i) => [i.checked, i.getAttribute('aria-label')].join('|')), 'true|Ignorer le dossier Podcasts');
  const hint = await s.page.$eval(`${WIN} .mp-skip-podcasts`, (t) => t.closest('.mp-set-row').textContent);
  assert.match(hint, /Podcasts et actus \(~\/Music\/Podcasts\)/);
  await s.page.waitForTimeout(300);
  await s.shot('music-settings-podcasts-fr-light');
  await s.page.click(`${WIN} .mp-skip-podcasts`);
  await waitFor((a, p) => a.prefs.skipPodcasts === false && a.lib.songs().some((e) => e.path === p), PODCAST, { what: 'the episode joins the library when the setting is off' });
  await s.page.click(`${WIN} .mp-skip-podcasts`);
  await waitFor((a, p) => a.prefs.skipPodcasts === true && !a.lib.scanning && !a.lib.songs().some((e) => e.path === p) && a.lib.songs().length === 6, PODCAST, { what: 'and leaves it again' });
  await M((a) => a.go({ name: 'music', arg: 'albums' }));
});

await test('media card in Réglages rapides: the Lecteur, cover, title, artist; pause / play, next, seek; EN + FR, dark + light', async () => {
  await A(() => window.__aurora.settings.set('theme', 'dark'));
  await M((a, list) => a.playEntries(list, 0), [TRACK, PHARE]);
  await waitFor((a) => !a.player.paused && a.player.currentTime > 0.3, null, { what: 'playing' });
  assert.equal(await A(() => window.__aurora.mediactl.active()?.id), 'selene');
  await openQuick();
  let c = await until(card, { what: 'card' });
  assert.deepEqual([c.player, c.status, c.title, c.artist, c.name, c.menu, c.play, c.next, c.len, c.label], ['selene', 'Playing', 'Marée haute', 'Lune Rousse · Nuits claires', 'Lecteur', false, 'Pause', true, '0:12', 'Lecture en cours']);
  assert.match(c.art || '', /^media:\/\/.*\.cache\/aurora\/media\/art\//, 'the album cover');
  assert.equal(await s.page.$eval('#quick-settings .qs-body > :first-child', (e) => e.className), 'mc-card', 'above the tiles');
  // pause from the card
  await s.page.click('#quick-settings .mc-play');
  await waitFor((a) => a.player.paused, null, { what: 'paused from the card' });
  c = await until(async () => (await card())?.status === 'Paused' && card(), { what: 'card paused' });
  assert.equal(c.play, 'Lecture');
  // seek: the middle of the 12 s track
  await s.page.$eval('#quick-settings .mc-seek', (el) => {
    el.value = 500;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await waitFor((a) => a.player.currentTime > 5.5 && a.player.currentTime < 6.5, null, { what: 'seek to 6 s' });
  await until(async () => (await card())?.at === '0:06', { what: 'card at 0:06' });
  await s.page.waitForTimeout(300);
  await s.shot('mediactl-card-fr-dark');
  await A(() => window.__aurora.settings.set('theme', 'light'));
  await s.page.waitForTimeout(700);
  await s.shot('mediactl-card-fr-light');
  // next from the card: the second track, playing
  await s.page.click('#quick-settings .mc-next');
  await waitFor((a) => a.queue.index === 1 && !a.player.paused, null, { what: 'next track playing' });
  c = await until(async () => (await card())?.title === 'Phare' && card(), { what: 'card shows Phare' });
  assert.deepEqual([c.status, c.next, c.play], ['Playing', false, 'Pause']);
  // English
  await M((a) => a.player.pause());
  await A(() => window.__aurora.settings.set('lang', 'en'));
  c = await until(async () => (await card())?.name === 'Player' && card(), { what: 'card in English' });
  assert.deepEqual([c.play, c.label], ['Play', 'Now playing']);
  await s.page.waitForTimeout(500);
  await s.shot('mediactl-card-en-light');
  await A(() => window.__aurora.settings.set('theme', 'dark'));
  await s.page.waitForTimeout(700);
  await s.shot('mediactl-card-en-dark');
  await A(() => window.__aurora.settings.set('lang', 'fr'));
  await until(async () => (await card())?.name === 'Lecteur', { what: 'back in French' });
  // the cover opens the Lecteur (Raise) and closes the flyout
  await A(() => window.__aurora.wm.byApp('media')[0].minimize());
  await s.page.waitForTimeout(400);
  await s.page.click('#quick-settings .mc-art');
  await until(() => A(() => !window.__aurora.quick.isOpen && !window.__aurora.wm.byApp('media')[0].minimized && window.__aurora.wm.focused()?.appId === 'media'), { what: 'Lecteur raised' });
});

await test('media keys (real key press and shell:hotkey from main): play / pause, next, previous on the Lecteur; the OSD shows the track', async () => {
  await M((a) => a.playQueueIndex(0));
  await waitFor((a) => !a.player.paused && a.queue.index === 0, null, { what: 'track 1 playing' });
  // a real key press in the shell page: main/lib/hotkeys.js forwards it as shell:hotkey
  await pressKey('MediaPlayPause');
  await waitFor((a) => a.player.paused, null, { what: 'paused by MediaPlayPause' });
  await s.page.waitForSelector('#osd-media.show', { timeout: 3000 });
  const osd = await s.page.$eval('#osd-media', (e) => ({ title: e.querySelector('.osd-media-title').textContent, sub: e.querySelector('.osd-media-sub')?.textContent, status: e.dataset.status, label: e.getAttribute('aria-label'), art: !!e.querySelector('img.osd-media-art') }));
  assert.deepEqual(osd, { title: 'Marée haute', sub: 'Lune Rousse · Lecteur', status: 'Paused', label: 'En pause : Marée haute — Lune Rousse · Lecteur', art: true });
  await s.page.waitForTimeout(250);
  await s.shot('mediactl-osd-fr-dark');
  await pressKey('MediaPlayPause');
  await waitFor((a) => !a.player.paused, null, { what: 'playing again' });
  await s.page.waitForTimeout(400);
  assert.equal(await M((a) => a.player.paused), false, 'one key press toggles once (the Lecteur did not also get the DOM key)');
  // from main (what aurora-xwm sends while an X11 app has the focus: XF86AudioNext -> MediaTrackNext)
  await fromMain('MediaTrackNext');
  await waitFor((a) => a.queue.index === 1, null, { what: 'next' });
  await until(() => s.page.$eval('#osd-media', (e) => !e.hidden && e.querySelector('.osd-media-title').textContent === 'Phare'), { what: 'OSD shows the next track' });
  await pressKey('MediaPreviousTrack');
  await waitFor((a) => a.queue.index === 0 || a.player.currentTime < 1, null, { what: 'previous (or back to the start)' });
  await fromMain('MediaPause');
  await waitFor((a) => a.player.paused, null, { what: 'MediaPause pauses' });
  await fromMain('MediaPause');
  await s.page.waitForTimeout(300);
  assert.equal(await M((a) => a.player.paused), true, 'MediaPause does not toggle');
  await fromMain('MediaPlay'); // XF86AudioPlay: a toggle, as in GNOME
  await waitFor((a) => !a.player.paused, null, { what: 'MediaPlay plays' });
  await fromMain('MediaStop');
  await waitFor((a) => a.player.paused && a.player.currentTime < 0.5, null, { what: 'MediaStop: paused at the start' });
  // the volume keys still work and still show their own OSD
  await fromMain('AudioVolumeUp');
  await s.page.waitForSelector('#osd.show', { timeout: 3000 });
  assert.equal(await s.page.$eval('#osd-media', (e) => e.hidden), true, 'one OSD at a time');
});

if (bus) {
  await test('MPRIS: the Lecteur is org.mpris.MediaPlayer2.selene on the session bus (read and driven by a client)', async () => {
    const probe = fakePlayer();
    try {
      await probe.wait((l) => l === 'READY', 8000);
      const SEL = 'org.mpris.MediaPlayer2.selene';
      await until(async () => (await probe.ask({ cmd: 'names' }, (l) => l.names))?.names.includes(SEL), { what: 'org.mpris.MediaPlayer2.selene on the bus' });
      await M((a) => a.playQueueIndex(1));
      await waitFor((a) => !a.player.paused && a.queue.index === 1, null, { what: 'Phare playing' });
      const all = await until(async () => {
        const r = (await probe.ask({ cmd: 'getall', name: SEL, iface: 'org.mpris.MediaPlayer2.Player' }, (l) => l.all || l.error))?.value;
        return r?.PlaybackStatus === 'Playing' && r.Metadata?.['xesam:title'] === 'Phare' && r;
      }, { what: 'Playing Phare on the bus' });
      assert.deepEqual([all.Metadata['xesam:artist'], all.Metadata['xesam:album'], Math.round(all.Metadata['mpris:length'] / 1e6), all.CanGoNext, all.CanGoPrevious, all.CanSeek], [['Lune Rousse'], 'Nuits claires', 6, false, true, true]);
      assert.match(all.Metadata['mpris:artUrl'], /^file:\/\/.*\/\.cache\/aurora\/media\/art\//);
      const root = (await probe.ask({ cmd: 'getall', name: SEL, iface: 'org.mpris.MediaPlayer2' }, (l) => l.all || l.error))?.value;
      assert.equal(root.Identity, 'Lecteur');
      // a client (KDE Connect, playerctl…) pauses it, seeks, raises it
      await probe.ask({ cmd: 'call', name: SEL, method: 'PlayPause' }, (l) => l.called || l.error);
      await waitFor((a) => a.player.paused, null, { what: 'paused over D-Bus' });
      await probe.ask({ cmd: 'watch', name: SEL }, (l) => l.watching);
      probe.since();
      await probe.ask({ cmd: 'call', name: SEL, method: 'SetPosition', args: [all.Metadata['mpris:trackid'], 3000000], sig: 'ox' }, (l) => l.called || l.error);
      await waitFor((a) => Math.abs(a.player.currentTime - 3) < 0.3, null, { what: 'SetPosition over D-Bus' });
      const seeked = await probe.wait((l) => l.signal === 'Seeked', 4000);
      assert.ok(seeked && Math.abs(seeked.position - 3e6) < 3e5, `Seeked after the jump (${JSON.stringify(seeked)})`);
      await probe.ask({ cmd: 'setprop', name: SEL, prop: 'Volume', value: 0.5, sig: 'd' }, (l) => l.setprop || l.error);
      await waitFor((a) => Math.abs(a.player.volume - 0.5) < 0.01, null, { what: 'Volume over D-Bus' });
      await probe.ask({ cmd: 'call', name: SEL, method: 'Play' }, (l) => l.called || l.error);
      await waitFor((a) => !a.player.paused, null, { what: 'Play over D-Bus' });
      const pc = await probe.wait((l) => l.signal === 'PropertiesChanged' && l.changed.PlaybackStatus === 'Playing', 4000);
      assert.ok(pc, 'PropertiesChanged PlaybackStatus Playing');
    } finally {
      probe.quit();
    }
  });

  await test('another player (fake, on the bus) in the card: followed when it starts, media keys go to it, the menu switches players', async () => {
    const other = fakePlayer();
    try {
      await other.wait((l) => l === 'READY', 8000);
      await M((a) => a.player.pause());
      const cover = path.join(home, 'cover-test.png');
      fs.writeFileSync(cover, PNG);
      await other.ask({ cmd: 'own', name: 'org.mpris.MediaPlayer2.fakeplayer', identity: 'Radio Test', state: { PlaybackStatus: 'Playing', Metadata: { trackid: '/fake/track/7', title: 'Ondes courtes', artist: 'Radio Test', album: 'Direct', length: 300, art: `file://${cover}` } } }, (l) => l.owned);
      await other.ask({ cmd: 'position', value: 75 }, (l) => l.position);
      await until(() => A(() => window.__aurora.mediactl.active()?.id === 'org.mpris.MediaPlayer2.fakeplayer'), { what: 'the started player becomes the active one' });
      await openQuick();
      let c = await until(async () => (await card())?.title === 'Ondes courtes' && card(), { what: 'card shows the other player' });
      assert.deepEqual([c.name, c.menu, c.status, c.artist, c.len], ['Radio Test', true, 'Playing', 'Radio Test · Direct', '5:00']);
      assert.match(c.art || '', /^media:\/\/local\/.*cover-test\.png$/);
      await s.page.waitForTimeout(300);
      await s.shot('mediactl-card-other-fr-dark');
      // media key: the other player, not the Lecteur
      other.since();
      await fromMain('MediaPlayPause');
      assert.ok(await other.wait((l) => l.call === 'PlayPause', 4000), 'PlayPause reached the other player');
      c = await until(async () => (await card())?.status === 'Paused' && card(), { what: 'card follows its state' });
      assert.equal(await M((a) => a.player.paused), true, 'the Lecteur did not start');
      await until(() => s.page.$eval('#osd-media', (e) => !e.hidden && e.querySelector('.osd-media-title').textContent === 'Ondes courtes'), { what: 'OSD shows the other player' });
      // seek from the card -> SetPosition with its track id
      other.since();
      await s.page.$eval('#quick-settings .mc-seek', (el) => {
        el.value = 500;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      });
      const sp = await other.wait((l) => l.call === 'SetPosition', 4000);
      assert.deepEqual(sp && [sp.track, sp.position], ['/fake/track/7', 150000000]);
      // the menu: switch to the Lecteur
      await s.page.click('#quick-settings .mc-player');
      await s.page.waitForSelector('.menu .menu-item', { timeout: 3000 });
      const items = await s.page.$$eval('.menu .menu-item .label', (els) => els.map((e) => e.textContent));
      assert.deepEqual(items.sort(), ['Lecteur — Phare', 'Radio Test — Ondes courtes']);
      await s.page.waitForTimeout(200);
      await s.shot('mediactl-menu-fr-dark');
      await s.page.click('.menu .menu-item:has-text("Lecteur")');
      c = await until(async () => (await card())?.player === 'selene' && card(), { what: 'card switched to the Lecteur' });
      assert.equal(c.title, 'Phare');
      await fromMain('MediaPlayPause');
      await waitFor((a) => !a.player.paused, null, { what: 'the key now plays the Lecteur' });
      // the other one starts again: followed again
      await other.ask({ cmd: 'set', state: { PlaybackStatus: 'Playing' } }, (l) => l.set);
      await until(async () => (await card())?.player === 'org.mpris.MediaPlayer2.fakeplayer', { what: 'followed again when it starts' });
      await M((a) => a.player.pause());
      // it leaves the bus: back to the Lecteur
      await other.ask({ cmd: 'release' }, (l) => l.released);
      c = await until(async () => (await card())?.player === 'selene' && card(), { what: 'back to the Lecteur' });
      assert.equal(c.menu, false);
      await closeQuick();
    } finally {
      other.quit();
    }
  });
}

await test('the Lecteur closes: no player left, the card goes, org.mpris.MediaPlayer2.selene leaves the bus', async () => {
  await M((a) => a.player.pause());
  await A(() => window.__aurora.wm.byApp('media')[0].close());
  await until(() => A(() => window.__aurora.mediactl.players().length === 0), { what: 'no player' });
  await A(() => window.__aurora.quick.open());
  await s.page.waitForTimeout(300);
  assert.equal(await s.page.$eval('#quick-settings .mc-card', (e) => e.hidden), true);
  await closeQuick();
  if (bus) {
    const probe = fakePlayer();
    try {
      await probe.wait((l) => l === 'READY', 8000);
      await until(async () => !(await probe.ask({ cmd: 'names' }, (l) => l.names))?.names.includes('org.mpris.MediaPlayer2.selene'), { what: 'name released' });
    } finally {
      probe.quit();
    }
  }
  // a media key with no player does nothing (and throws nothing)
  await fromMain('MediaPlayPause');
  await s.page.waitForTimeout(300);
  assert.equal(await s.page.$eval('#osd-media', (e) => e.hidden), true);
});

await test('no console errors', async () => {
  const errs = s.logs.filter((l) => (l.startsWith('[pageerror]') || (l.startsWith('[error]') && !/Failed to load resource/.test(l))) && !/aurora-pty|terminal/i.test(l));
  assert.deepEqual(errs, []);
});

await s.close();
bus?.stop();
fs.rmSync(home, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} tests passed`);
process.exit(failed.length ? 1 : 0);
