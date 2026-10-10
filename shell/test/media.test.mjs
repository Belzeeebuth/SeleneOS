// Functional tests for the Media Player app (renderer/apps/media).
// Run: cd aurora-os/shell && xvfb-run -a -s "-screen 0 1600x900x24" node test/media.test.mjs [--only=<name part>]
//
// 1. Unit tests (plain Node): play queue logic, helpers, tag parsers, playlist store.
// 2. Shell tests: the real Electron shell with the shipped sample media (rootfs/etc/skel) copied into
//    the throwaway $HOME — library scan, playback, transport, keyboard, queue, playlists, video,
//    full screen, mini player, drag & drop, errors, persistence, EN/FR, light/dark, sizes.
// Screenshots: test/out/media-*.png and docs/screenshots/media-*.png.
import { launchShell, OUT } from './lib.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(here, '..', 'renderer', 'apps', 'media');
const SKEL = path.join(here, '..', '..', 'rootfs', 'etc', 'skel');
const DOCS = path.join(here, '..', '..', 'docs', 'screenshots');
fs.mkdirSync(DOCS, { recursive: true });
const ONLY = process.argv.find((a) => a.startsWith('--only='))?.slice(7);

const results = [];
let current = null;
async function test(name, fn) {
  if (ONLY && !name.includes(ONLY)) return;
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name} (${Date.now() - t0} ms)`);
  } catch (err) {
    results.push({ name, ok: false, err });
    const where =
      String(err?.stack || '')
        .split('\n')
        .find((l) => l.includes('media.test.mjs')) || '';
    console.log(
      `FAIL  ${name}\n      ${String(err?.message || err)
        .split('\n')
        .slice(0, 20)
        .join('\n      ')}\n      ${where.trim()}`,
    );
    if (current) {
      await current.page.keyboard.press('Escape').catch(() => {});
      await current.page.evaluate(() => document.querySelectorAll('.menu, .dialog-layer').forEach((e) => e.remove())).catch(() => {});
    }
  }
}

// Load an app module (no imports) as an ES module without Node's package-type warning.
async function load(rel) {
  const src = fs.readFileSync(path.join(APP, rel), 'utf8');
  return import(`data:text/javascript;base64,${Buffer.from(src).toString('base64')}`);
}

// ------------------------------------------------------------------ fixtures
function wavFile({ seconds = 2, rate = 22050, freq = 440, title, artist } = {}) {
  const n = Math.floor(seconds * rate);
  const pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 0.3 * 32767 * Math.min(1, i / 400, (n - i) / 400)), i * 2);
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

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-media-'));
  for (const d of ['Music', 'Videos', 'Documents']) {
    fs.mkdirSync(path.join(home, d), { recursive: true });
    const src = path.join(SKEL, d);
    if (fs.existsSync(src)) for (const f of fs.readdirSync(src)) fs.copyFileSync(path.join(src, f), path.join(home, d, f));
  }
  fs.mkdirSync(path.join(home, 'Music', 'Tests', 'Deeper'), { recursive: true });
  fs.writeFileSync(path.join(home, 'Music', 'Tests', 'Deeper', 'tone.wav'), wavFile({ seconds: 3, title: 'Test Tone', artist: 'Aurora QA' }));
  fs.writeFileSync(path.join(home, 'Documents', 'hello.wav'), wavFile({ seconds: 2, freq: 660, title: 'Hello Tone', artist: 'Aurora QA' }));
  fs.writeFileSync(path.join(home, 'Documents', 'second.wav'), wavFile({ seconds: 2, freq: 550 }));
  fs.writeFileSync(path.join(home, 'Documents', 'broken.mp3'), Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 7919) & 0xff)));
  fs.writeFileSync(path.join(home, 'Documents', 'notes.txt'), 'not media');
  return home;
}

// ------------------------------------------------------------------ shell helpers
const WIN = '.win.app-media';
function M(s, fn, arg) {
  return s.page.evaluate(`(${fn.toString()})([...document.querySelectorAll(${JSON.stringify(WIN)})].pop()?.__media, ${JSON.stringify(arg ?? null)})`);
}
const wait = (s, ms = 150) => s.page.waitForTimeout(ms);
async function waitFor(s, fn, arg, { timeout = 8000, what } = {}) {
  const t0 = Date.now();
  let last;
  for (;;) {
    last = await M(s, fn, arg).catch((e) => `ERR ${e.message}`);
    if (last && !(typeof last === 'string' && last.startsWith('ERR '))) return last;
    if (Date.now() - t0 > timeout) throw new Error(`timeout waiting for ${what || fn.toString().slice(0, 120)} (last: ${JSON.stringify(last)})`);
    await wait(s, 80);
  }
}
const state = (s) =>
  M(s, (a) => ({
    path: a.player.path,
    t: a.player.currentTime,
    d: a.player.duration,
    paused: a.player.paused,
    index: a.queue.index,
    len: a.queue.length,
    shuffle: a.queue.shuffle,
    repeat: a.queue.repeat,
    volume: a.player.volume,
    muted: a.player.muted,
    rate: a.player.rate,
    title: a.transport.titleEl.textContent,
    stage: a.stageOpen,
    mini: a.mini,
    fs: !!a.win.fullscreen,
  }));
const base = (p) => (p ? p.split('/').pop() : p);
async function press(s, key, n = 1) {
  for (let i = 0; i < n; i++) await s.page.keyboard.press(key);
  await wait(s, 80);
}
async function focusList(s) {
  await M(s, (a) => a.focusContent());
}
async function focusPage(s) {
  await M(s, (a) => a.scroller.focus());
}
async function menuPick(s, ...labels) {
  for (const l of labels) {
    const item = s.page.locator('.menu .menu-item', { hasText: l }).last();
    await item.waitFor({ timeout: 3000 });
    await item.hover();
    await wait(s, 280);
    await item.click();
  }
  await wait(s, 150);
}
function appErrors(s) {
  return s.logs.filter((l) => (l.startsWith('[pageerror]') || (l.startsWith('[error]') && !/Failed to load resource/.test(l)) || /\[icons\]/.test(l)) && !/aurora-pty|terminal/i.test(l));
}
async function shot(s, name, docs = false) {
  await wait(s, 350);
  const file = await s.shot(`media-${name}`);
  if (docs) fs.copyFileSync(file, path.join(DOCS, `media-${name}.png`));
  return file;
}

// ================================================================== unit tests
const { PlayQueue } = await load('lib/queue.js');
const U = await load('lib/util.js');
const T = await load('lib/tags.js');
const { Playlists } = await load('lib/playlists.js');

function seededRng(seed = 7) {
  let a = seed;
  return () => {
    a = (a * 1103515245 + 12345) & 0x7fffffff;
    return a / 0x80000000;
  };
}
const P5 = ['/m/a.mp3', '/m/b.mp3', '/m/c.mp3', '/m/d.mp3', '/m/e.mp3'];
const paths = (q) => q.items.map((i) => i.path);

await test('unit: queue set/add/playNext/remove/move keep the current item', () => {
  const q = new PlayQueue();
  const events = [];
  q.on((w) => events.push(w));
  q.set(P5.slice(0, 3), 1);
  assert.equal(q.current.path, '/m/b.mp3');
  q.add(['/m/d.mp3']);
  assert.deepEqual(paths(q), ['/m/a.mp3', '/m/b.mp3', '/m/c.mp3', '/m/d.mp3']);
  q.playNext(['/m/e.mp3']);
  assert.deepEqual(paths(q), ['/m/a.mp3', '/m/b.mp3', '/m/e.mp3', '/m/c.mp3', '/m/d.mp3']);
  assert.equal(q.index, 1);
  assert.equal(q.removeAt(0).wasCurrent, false);
  assert.equal(q.current.path, '/m/b.mp3');
  assert.equal(q.index, 0);
  const r = q.removeAt(0);
  assert.equal(r.wasCurrent, true);
  assert.equal(q.current.path, '/m/e.mp3', 'next item becomes current');
  q.move(0, 2);
  assert.deepEqual(paths(q), ['/m/c.mp3', '/m/d.mp3', '/m/e.mp3']);
  assert.equal(q.current.path, '/m/e.mp3');
  q.move(2, 0);
  assert.equal(q.index, 0);
  q.move(1, 2);
  assert.equal(q.index, 0);
  q.removeAt(2);
  q.removeAt(1);
  q.removeAt(0);
  assert.equal(q.index, -1);
  assert.equal(q.current, null);
  assert.ok(events.includes('set') && events.includes('add') && events.includes('remove') && events.includes('move'));
  // the same file can be queued twice with distinct uids
  q.set(['/m/a.mp3', '/m/a.mp3']);
  assert.notEqual(q.items[0].uid, q.items[1].uid);
  q.remove(q.items[1].uid);
  assert.equal(q.length, 1);
  q.clear();
  assert.equal(q.length, 0);
});

await test('unit: queue next/prev with repeat off/all/one', () => {
  const q = new PlayQueue();
  q.set(P5.slice(0, 3), 0);
  assert.equal(q.next(), 1);
  assert.equal(q.next(), 2);
  assert.equal(q.next(), -1, 'end of queue with repeat off');
  assert.equal(q.index, 2);
  assert.equal(q.next({ auto: true }), -1);
  q.setRepeat('all');
  assert.equal(q.next({ auto: true }), 0, 'repeat all wraps');
  assert.equal(q.prev(), 2, 'repeat all wraps backwards');
  q.setRepeat('one');
  assert.equal(q.next({ auto: true }), 2, 'repeat one replays on auto-advance');
  assert.equal(q.next(), 0, 'manual next still advances (and wraps)');
  q.setRepeat('off');
  assert.equal(q.prev(), 0, 'prev at the start stays on the first item');
  assert.equal(q.cycleRepeat(), 'all');
  assert.equal(q.cycleRepeat(), 'one');
  assert.equal(q.cycleRepeat(), 'off');
  q.setRepeat('bogus');
  assert.equal(q.repeat, 'off');
  assert.equal(q.jump(9), -1);
  assert.equal(q.jump(2), 2);
  const empty = new PlayQueue();
  assert.equal(empty.next(), -1);
  assert.equal(empty.prev(), -1);
});

await test('unit: shuffle keeps the current item first and restores the original order', () => {
  const q = new PlayQueue({ rng: seededRng(3) });
  q.set(P5, 2);
  q.setShuffle(true);
  assert.equal(q.index, 0);
  assert.equal(q.current.path, '/m/c.mp3');
  assert.deepEqual([...paths(q)].sort(), [...P5].sort(), 'same items');
  assert.notDeepEqual(paths(q), P5, 'order changed');
  q.next();
  const playing = q.current.path;
  q.add(['/m/f.mp3']);
  assert.equal(q.length, 6);
  assert.ok(q.items.findIndex((i) => i.path === '/m/f.mp3') > q.index, 'added items land after the current one');
  q.setShuffle(false);
  assert.deepEqual(paths(q), [...P5, '/m/f.mp3'], 'original order restored (+ added item)');
  assert.equal(q.current.path, playing, 'still on the same item');
  // set() while shuffle is on shuffles around the start item
  q.setShuffle(true);
  q.set(P5, 4);
  assert.equal(q.current.path, '/m/e.mp3');
  assert.equal(q.index, 0);
  q.setShuffle(false);
  assert.deepEqual(paths(q), P5);
  assert.equal(q.index, 4);
});

await test('unit: queue JSON round trip and sanitising', () => {
  const q = new PlayQueue({ rng: seededRng(5) });
  q.set(P5, 1);
  q.setShuffle(true);
  q.setRepeat('all');
  const j = JSON.parse(JSON.stringify(q.toJSON()));
  const r = PlayQueue.from(j);
  assert.deepEqual(paths(r), paths(q));
  assert.equal(r.index, q.index);
  assert.equal(r.shuffle, true);
  assert.equal(r.repeat, 'all');
  r.setShuffle(false);
  assert.deepEqual(paths(r), P5);
  const bad = PlayQueue.from({ items: [{ path: '/x' }, null, { path: 3 }, { uid: 'u', path: '/y' }, { uid: 'u', path: '/z' }], index: 99, repeat: 'x' });
  assert.equal(bad.length, 3);
  assert.equal(bad.index, 0);
  assert.equal(bad.repeat, 'off');
  assert.equal(new Set(bad.items.map((i) => i.uid)).size, 3, 'duplicate uids re-keyed');
  assert.equal(PlayQueue.from(null).length, 0);
});

await test('unit: helpers (time format, names, kinds, hash)', () => {
  assert.equal(U.formatTime(0), '0:00');
  assert.equal(U.formatTime(75.4), '1:15');
  assert.equal(U.formatTime(3725), '1:02:05');
  assert.equal(U.formatTime(NaN), '0:00');
  assert.equal(U.formatTime(Infinity), '0:00');
  assert.deepEqual(U.guessFromName('/x/01 - Artist Name - Song Title.mp3'), { artist: 'Artist Name', title: 'Song Title', track: 1 });
  assert.deepEqual(U.guessFromName('/x/Aurora - Night Drive.ogg'), { artist: 'Aurora', title: 'Night Drive', track: null });
  assert.deepEqual(U.guessFromName('/x/my_song.flac'), { artist: null, title: 'my song', track: null });
  assert.equal(U.kindOf('/a/B.MP3'), 'audio');
  assert.equal(U.kindOf('/a/b.webm'), 'video');
  assert.equal(U.kindOf('/a/b.txt'), null);
  assert.equal(U.dirName('/a/b/c.mp3'), '/a/b');
  assert.equal(U.baseName('/a/b/c.mp3'), 'c.mp3');
  assert.match(U.hash('abc'), /^[0-9a-f]{8}$/);
  assert.notEqual(U.hash('abc'), U.hash('abd'));
  for (const ext of ['.mp3', '.wav', '.ogg', '.oga', '.opus', '.flac', '.m4a', '.aac', '.mp4', '.m4v', '.webm', '.ogv', '.mkv', '.mov']) assert.ok(U.MEDIA_EXT.includes(ext), ext);
  const manifest = JSON.parse(fs.readFileSync(path.join(APP, 'manifest.json'), 'utf8'));
  assert.deepEqual([...manifest.fileTypes].sort(), [...U.MEDIA_EXT].sort(), 'manifest fileTypes match the player');
  assert.equal(manifest.singleInstance, true);
  assert.equal(manifest.category, 'media');
});

const memReader = (buf) => {
  const b = new Uint8Array(buf);
  return { size: b.length, read: async (o, n) => b.subarray(o, o + n) };
};
function id3v23(frames) {
  const body = Buffer.concat(
    frames.map(([id, data]) => {
      const h = Buffer.alloc(10);
      h.write(id, 0, 'latin1');
      h.writeUInt32BE(data.length, 4);
      return Buffer.concat([h, data]);
    }),
  );
  const head = Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0]);
  const n = body.length;
  head[6] = (n >> 21) & 0x7f;
  head[7] = (n >> 14) & 0x7f;
  head[8] = (n >> 7) & 0x7f;
  head[9] = n & 0x7f;
  return Buffer.concat([head, body]);
}
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 7)]);

await test('unit: tag readers (ID3v2/ID3v1, FLAC, MP4, WAV, Ogg Opus)', async () => {
  const utf16 = (s) => Buffer.concat([Buffer.from([1, 0xff, 0xfe]), Buffer.from(s, 'utf16le')]);
  const mp3 = Buffer.concat([
    id3v23([
      ['TIT2', Buffer.concat([Buffer.from([3]), Buffer.from('Été indien', 'utf8')])],
      ['TPE1', utf16('Artiste')],
      ['TALB', Buffer.concat([Buffer.from([0]), Buffer.from('Album Latin', 'latin1')])],
      ['TRCK', Buffer.from('\u00007/12', 'latin1')],
      ['TYER', Buffer.from('\u00001999', 'latin1')],
      ['TCON', Buffer.from('\u0000(17)', 'latin1')],
      ['APIC', Buffer.concat([Buffer.from([0]), Buffer.from('image/png\0', 'latin1'), Buffer.from([3]), Buffer.from('\0'), PNG])],
    ]),
    Buffer.alloc(200, 0xff),
  ]);
  let t = await T.readTags(memReader(mp3), '.mp3');
  assert.equal(t.title, 'Été indien');
  assert.equal(t.artist, 'Artiste');
  assert.equal(t.album, 'Album Latin');
  assert.equal(t.track, 7);
  assert.equal(t.year, 1999);
  assert.equal(t.genre, 'Rock');
  assert.equal(t.picture.mime, 'image/png');
  assert.equal(t.picture.data.length, PNG.length);
  // ID3v1 only
  const v1 = Buffer.alloc(128);
  v1.write('TAG', 0, 'latin1');
  v1.write('Old Title', 3, 'latin1');
  v1.write('Old Artist', 33, 'latin1');
  v1[126] = 4;
  v1[127] = 13;
  t = await T.readTags(memReader(Buffer.concat([Buffer.alloc(500, 0xff), v1])), '.mp3');
  assert.deepEqual([t.title, t.artist, t.track, t.genre], ['Old Title', 'Old Artist', 4, 'Pop']);
  // FLAC: STREAMINFO (44.1 kHz, 441000 samples = 10 s) + VORBIS_COMMENT
  const si = Buffer.alloc(34);
  const rate = 44100;
  si[10] = (rate >> 12) & 0xff;
  si[11] = (rate >> 4) & 0xff;
  si[12] = ((rate & 0x0f) << 4) | (1 << 1);
  si.writeUInt32BE(441000, 14);
  const vc = (() => {
    const parts = [];
    const u32 = (n) => {
      const b = Buffer.alloc(4);
      b.writeUInt32LE(n);
      return b;
    };
    const vendor = Buffer.from('test');
    const cs = ['TITLE=Flac Title', 'ARTIST=Flac Artist', 'TRACKNUMBER=3', 'DATE=2020-05-01'].map((c) => Buffer.from(c));
    parts.push(u32(vendor.length), vendor, u32(cs.length));
    for (const c of cs) parts.push(u32(c.length), c);
    return Buffer.concat(parts);
  })();
  const blk = (type, last, data) => Buffer.concat([Buffer.from([(last ? 0x80 : 0) | type, (data.length >> 16) & 0xff, (data.length >> 8) & 0xff, data.length & 0xff]), data]);
  t = await T.readTags(memReader(Buffer.concat([Buffer.from('fLaC'), blk(0, false, si), blk(4, true, vc), Buffer.alloc(64)])), '.flac');
  assert.deepEqual([t.title, t.artist, t.track, t.year], ['Flac Title', 'Flac Artist', 3, 2020]);
  assert.ok(Math.abs(t.duration - 10) < 0.01, `flac duration ${t.duration}`);
  // MP4 / M4A atoms
  const atom = (type, ...kids) => {
    const body = Buffer.concat(kids);
    const h = Buffer.alloc(8);
    h.writeUInt32BE(body.length + 8);
    h.write(type, 4, 'latin1');
    return Buffer.concat([h, body]);
  };
  const data = (kind, payload) => atom('data', Buffer.from([0, 0, 0, kind, 0, 0, 0, 0]), payload);
  const mvhd = Buffer.alloc(100);
  mvhd.writeUInt32BE(1000, 12);
  mvhd.writeUInt32BE(5000, 16);
  const mp4 = Buffer.concat([
    atom('ftyp', Buffer.from('M4A \0\0\0\0')),
    atom(
      'moov',
      atom('mvhd', mvhd),
      atom(
        'udta',
        atom(
          'meta',
          Buffer.alloc(4),
          atom('hdlr', Buffer.alloc(25)),
          atom(
            'ilst',
            atom('©nam', data(1, Buffer.from('Mp4 Title'))),
            atom('©ART', data(1, Buffer.from('Mp4 Artist'))),
            atom('trkn', data(0, Buffer.from([0, 0, 0, 9, 0, 12, 0, 0]))),
            atom('covr', data(14, PNG)),
          ),
        ),
      ),
    ),
  ]);
  t = await T.readTags(memReader(mp4), '.m4a');
  assert.deepEqual([t.title, t.artist, t.track, t.duration], ['Mp4 Title', 'Mp4 Artist', 9, 5]);
  assert.equal(t.picture.mime, 'image/png');
  // WAV LIST/INFO + duration
  t = await T.readTags(memReader(wavFile({ seconds: 2, title: 'Wav Title', artist: 'Wav Artist' })), '.wav');
  assert.deepEqual([t.title, t.artist], ['Wav Title', 'Wav Artist']);
  assert.ok(Math.abs(t.duration - 2) < 0.01);
  // Ogg Opus sample shipped in /etc/skel (Vorbis comments + METADATA_BLOCK_PICTURE)
  const ogg = fs.readFileSync(path.join(SKEL, 'Music', 'Aurora - Night Drive.ogg'));
  t = await T.readTags(memReader(ogg), '.ogg');
  assert.deepEqual([t.title, t.artist, t.album, t.track, t.genre, t.year], ['Night Drive', 'Aurora', 'Aurora Sessions', 2, 'Synthwave', 2026]);
  assert.equal(t.picture.mime, 'image/jpeg');
  assert.ok(t.picture.data.length > 4000);
  // garbage never throws
  t = await T.readTags(memReader(Buffer.alloc(300, 0x41)), '.mp3');
  assert.equal(t.title, undefined);
  t = await T.readTags(memReader(Buffer.from('ID3\u0004\u0000\u0000\u007f\u007f\u007f\u007fxx', 'latin1')), '.mp3');
  assert.equal(typeof t, 'object');
});

await test('unit: sample media are original, small and well formed', () => {
  const music = fs.readdirSync(path.join(SKEL, 'Music')).filter((f) => f.endsWith('.ogg'));
  const vids = fs.readdirSync(path.join(SKEL, 'Videos')).filter((f) => f.endsWith('.webm'));
  assert.ok(music.length >= 2 && music.length <= 3, `music: ${music}`);
  assert.deepEqual(vids, ['Aurora Intro.webm']);
  let total = 0;
  for (const f of music) {
    const b = fs.readFileSync(path.join(SKEL, 'Music', f));
    assert.equal(b.toString('latin1', 0, 4), 'OggS');
    assert.ok(b.includes(Buffer.from('OpusHead')));
    total += b.length;
  }
  const v = fs.readFileSync(path.join(SKEL, 'Videos', vids[0]));
  assert.equal(v.readUInt32BE(0), 0x1a45dfa3, 'EBML header');
  assert.ok(v.includes(Buffer.from('V_VP9')) && v.includes(Buffer.from('A_OPUS')));
  total += v.length;
  assert.ok(total < 3.2 * 1024 * 1024, `total ${total} bytes`);
});

await test('unit: playlist store CRUD with persistence', async () => {
  const saved = {};
  const storage = { get: async (k, d) => (k in saved ? JSON.parse(JSON.stringify(saved[k])) : d), set: async (k, v) => (saved[k] = JSON.parse(JSON.stringify(v))) };
  const pls = new Playlists(storage);
  await pls.load();
  const a = pls.create('Road Trip', ['/a.mp3']);
  pls.add(a.id, ['/b.mp3', '/c.mp3']);
  pls.move(a.id, 0, 2);
  assert.deepEqual(pls.get(a.id).items, ['/b.mp3', '/c.mp3', '/a.mp3']);
  pls.removeAt(a.id, [0, 2]);
  assert.deepEqual(pls.get(a.id).items, ['/c.mp3']);
  assert.ok(pls.nameTaken('road trip'));
  assert.equal(pls.uniqueName('Road Trip'), 'Road Trip (2)');
  pls.rename(a.id, 'Night Ride');
  await new Promise((r) => setTimeout(r, 10));
  const again = new Playlists(storage);
  await again.load();
  assert.equal(again.list()[0].name, 'Night Ride');
  assert.deepEqual(again.list()[0].items, ['/c.mp3']);
  again.remove(a.id);
  assert.equal(again.list().length, 0);
  saved.playlists = [{ id: 1 }, { id: 'x', name: 'ok', items: ['/a', 5] }, null];
  const sane = new Playlists(storage);
  await sane.load();
  assert.equal(sane.list().length, 1);
  assert.deepEqual(sane.list()[0].items, ['/a']);
});

await test('unit: i18n has every key in English and French', () => {
  const dict = JSON.parse(fs.readFileSync(path.join(APP, 'i18n.json'), 'utf8'));
  const flat = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? flat(v, `${p}${k}.`) : [`${p}${k}`]));
  const en = new Set(flat(dict.en));
  const fr = new Set(flat(dict.fr));
  assert.deepEqual(
    [...en].filter((k) => !fr.has(k)),
    [],
    'missing in fr',
  );
  assert.deepEqual(
    [...fr].filter((k) => !en.has(k)),
    [],
    'missing in en',
  );
  // Every literal t('…') key used by the code exists.
  const src = fs
    .readdirSync(path.join(APP, 'lib'))
    .map((f) => fs.readFileSync(path.join(APP, 'lib', f), 'utf8'))
    .join('\n');
  const core = new Set(['common.close', 'registry.crashed']);
  const used = new Set([...src.matchAll(/\bt\(\s*'([a-zA-Z0-9_.]+)'/g)].map((m) => m[1]));
  const has = (k) => en.has(k) || en.has(`${k}_one`) || core.has(k);
  assert.deepEqual(
    [...used].filter((k) => !has(k)),
    [],
    'keys used but not defined',
  );
});

// ================================================================== shell session (en, light)
const home = makeHome();
const s = await launchShell({ open: ['media'], home, lang: 'en', theme: 'light', keepHome: true });
current = s;
await s.page.waitForSelector(`${WIN} .mp`, { timeout: 30000 });
await waitFor(s, (a) => !!a, null, { what: 'app hook' });
await M(s, (a) => a.win.maximize());
const D = path.join(home, 'Documents');
const MUSIC = path.join(home, 'Music');

await test('library scan: tags, durations, artwork and video thumbnail', async () => {
  await waitFor(s, (a) => a.lib.songs().length === 4 && a.lib.videos().length === 1 && a.lib.songs().every((e) => e.tagged && e.duration > 0) && a.lib.videos().every((e) => e.tagged), null, {
    timeout: 30000,
    what: 'library enriched',
  });
  const lib = await M(s, (a) => ({
    songs: a.lib.songs().map((e) => ({ title: e.title, artist: e.artist, album: e.album, track: e.track, duration: e.duration, art: e.art, path: e.path })),
    video: a.lib.videos().map((e) => ({ title: a.titleOf(e), duration: e.duration, thumb: e.thumb, w: e.width, h: e.height }))[0],
    albums: a.albums().map((x) => [x.title, x.songs.length]),
    artists: a.artists().map((x) => x.name),
  }));
  const titles = lib.songs.map((x) => x.title).sort();
  assert.deepEqual(titles, ['Morning Light', 'Night Drive', 'Northern Lights', 'Test Tone']);
  const nd = lib.songs.find((x) => x.title === 'Night Drive');
  assert.deepEqual([nd.artist, nd.album, nd.track], ['Aurora', 'Aurora Sessions', 2]);
  assert.ok(nd.duration > 30 && nd.duration < 36, `duration ${nd.duration}`);
  assert.ok(nd.art && fs.existsSync(nd.art), 'cover art cached on disk');
  assert.ok(lib.songs.find((x) => x.title === 'Test Tone').path.includes('/Tests/Deeper/'), 'recursive scan');
  assert.ok(Math.abs(lib.video.duration - 12) < 0.2, `video duration ${lib.video.duration}`);
  assert.deepEqual([lib.video.w, lib.video.h], [1280, 720]);
  assert.ok(lib.video.thumb && fs.existsSync(lib.video.thumb), 'thumbnail written');
  assert.equal(lib.video.title, 'Aurora Intro');
  assert.deepEqual(lib.albums, [
    ['Aurora Sessions', 3],
    ['Unknown album', 1],
  ]);
  assert.deepEqual(lib.artists, ['Aurora', 'Aurora QA']);
  const metaFile = path.join(home, '.config', 'aurora', 'apps', 'media', 'meta.json');
  for (let i = 0; i < 40 && !fs.existsSync(metaFile); i++) await wait(s, 100);
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  assert.ok(Object.keys(meta.items || meta.value?.items || {}).length >= 5 || JSON.stringify(meta).includes('Night Drive'), 'metadata cached in storage');
});

await test('music library page: songs list, sorting, albums and artists tabs', async () => {
  await s.page.click(`${WIN} [data-nav="music"]`);
  await s.page.waitForSelector(`${WIN} .mp-music .mp-row`);
  const titles = await s.page.$$eval(`${WIN} .mp-music .mp-row .mp-row-title`, (els) => els.map((e) => e.textContent));
  assert.deepEqual(titles, ['Morning Light', 'Night Drive', 'Northern Lights', 'Test Tone']);
  assert.equal(await s.page.textContent(`${WIN} .mp-count`), '4 songs');
  await s.page.selectOption(`${WIN} .mp-sort`, 'artist');
  await wait(s, 200);
  const byArtist = await s.page.$$eval(`${WIN} .mp-music .mp-row .c-artist`, (els) => els.map((e) => e.textContent));
  assert.deepEqual(byArtist, ['Aurora', 'Aurora', 'Aurora', 'Aurora QA']);
  await s.page.selectOption(`${WIN} .mp-sort`, 'az');
  await s.page.click(`${WIN} .mp-tabs [data-tab="albums"]`);
  await wait(s, 200);
  assert.deepEqual(await s.page.$$eval(`${WIN} .mp-grid .mp-tile-title`, (els) => els.map((e) => e.textContent)), ['Aurora Sessions', 'Unknown album']);
  await s.page.click(`${WIN} .mp-grid .mp-tile >> nth=0`);
  await s.page.waitForSelector(`${WIN} .mp-album .mp-row`);
  assert.equal(await s.page.textContent(`${WIN} .mp-hero-title`), 'Aurora Sessions');
  assert.deepEqual(await s.page.$$eval(`${WIN} .mp-album .mp-trackno`, (els) => els.map((e) => e.textContent)), ['1', '2', '3']);
  await s.page.click(`${WIN} .mp-back >> nth=0`);
  await wait(s, 200);
  await s.page.click(`${WIN} .mp-tabs [data-tab="artists"]`);
  await wait(s, 200);
  assert.deepEqual(await s.page.$$eval(`${WIN} .mp-grid .mp-tile-title`, (els) => els.map((e) => e.textContent)), ['Aurora', 'Aurora QA']);
  await s.page.click(`${WIN} .mp-tabs [data-tab="songs"]`);
  await wait(s, 200);
});

await test('play / pause / seek with the mouse and the keyboard', async () => {
  await s.page.dblclick(`${WIN} .mp-music .mp-row >> nth=1`);
  await waitFor(s, (a) => !a.player.paused && a.player.currentTime > 0.4, null, { what: 'playback started' });
  let st = await state(s);
  assert.equal(base(st.path), 'Aurora - Night Drive.ogg');
  assert.equal(st.title, 'Night Drive');
  assert.equal(st.len, 4);
  assert.equal(st.index, 1);
  assert.ok(await s.page.$(`${WIN} .mp-row.playing .mp-eq`), 'playing row shows the equalizer');
  await s.page.click(`${WIN} .mp-bar .mp-play`);
  await wait(s, 200);
  st = await state(s);
  assert.equal(st.paused, true);
  assert.equal(await s.page.getAttribute(`${WIN} .mp-bar .mp-play .icon`, 'data-icon'), 'play');
  await focusList(s);
  await press(s, 'Space');
  await waitFor(s, (a) => !a.player.paused, null, { what: 'space resumes' });
  await press(s, 'k');
  assert.equal((await state(s)).paused, true, 'K pauses');
  const t0 = (await state(s)).t;
  await press(s, 'ArrowRight');
  assert.ok(Math.abs((await state(s)).t - (t0 + 5)) < 0.3, '→ seeks +5 s');
  await press(s, 'l');
  assert.ok(Math.abs((await state(s)).t - (t0 + 15)) < 0.3, 'L seeks +10 s');
  await press(s, 'j');
  await press(s, 'ArrowLeft');
  assert.ok(Math.abs((await state(s)).t - t0) < 0.3, 'J and ← seek back');
  // The seek bar
  await M(s, (a) => {
    const r = a.transport.seek;
    r.value = '20';
    r.dispatchEvent(new Event('input'));
    r.dispatchEvent(new Event('change'));
  });
  await wait(s, 100);
  assert.ok(Math.abs((await state(s)).t - 20) < 0.3, 'seek bar sets the position');
  assert.equal(await s.page.textContent(`${WIN} .mp-elapsed`), '0:20');
  await s.page.click(`${WIN} .mp-remaining`);
  assert.match(await s.page.textContent(`${WIN} .mp-remaining`), /^-0:1\d$/, 'remaining time');
  await s.page.click(`${WIN} .mp-remaining`);
  assert.equal(await s.page.textContent(`${WIN} .mp-remaining`), '0:33');
  await press(s, 'Space');
  await waitFor(s, (a) => !a.player.paused);
});

await test('next / previous / repeat / shuffle and automatic advance', async () => {
  await press(s, 'n');
  await waitFor(s, (a) => a.queue.index === 2 && a.player.path?.endsWith('Northern Lights.ogg'), null, { what: 'N → next' });
  await s.page.click(`${WIN} .mp-bar .mp-prev`);
  await waitFor(s, (a) => a.queue.index === 1, null, { what: 'previous' });
  await M(s, (a) => a.player.seek(10));
  await s.page.click(`${WIN} .mp-bar .mp-prev`);
  await wait(s, 150);
  let st = await state(s);
  assert.equal(st.index, 1, 'previous after 3 s restarts the item');
  assert.ok(st.t < 1.5);
  await s.page.keyboard.press('Control+f');
  await waitFor(s, (a) => a.queue.index === 2, null, { what: 'Ctrl+F next' });
  await s.page.keyboard.press('Control+b');
  await waitFor(s, (a) => a.queue.index === 1, null, { what: 'Ctrl+B previous' });
  // Repeat cycles off -> all -> one -> off
  await s.page.click(`${WIN} .mp-bar .mp-repeat`);
  assert.equal((await state(s)).repeat, 'all');
  assert.equal(await s.page.getAttribute(`${WIN} .mp-bar .mp-repeat .icon`, 'data-icon'), 'arrow_repeat_all');
  await s.page.click(`${WIN} .mp-bar .mp-repeat`);
  assert.equal((await state(s)).repeat, 'one');
  assert.equal(await s.page.getAttribute(`${WIN} .mp-bar .mp-repeat .icon`, 'data-icon'), 'arrow_repeat_1');
  // Repeat one: the track restarts when it ends
  await M(s, (a) => a.player.seek(a.player.duration - 0.6));
  await waitFor(s, (a) => a.player.currentTime < 3 && a.player.currentTime > 0.05 && !a.player.paused, null, { timeout: 6000, what: 'repeat one restart' });
  assert.equal((await state(s)).index, 1);
  await s.page.keyboard.press('Control+t');
  assert.equal((await state(s)).repeat, 'off');
  // Automatic advance to the next item
  await M(s, (a) => a.player.seek(a.player.duration - 0.6));
  await waitFor(s, (a) => a.queue.index === 2 && !a.player.paused, null, { timeout: 6000, what: 'auto advance' });
  // End of the queue: stops and rewinds
  await M(s, (a) => a.playQueueIndex(3));
  await waitFor(s, (a) => !a.player.paused && a.player.path?.endsWith('tone.wav'));
  await M(s, (a) => a.player.seek(a.player.duration - 0.4));
  await waitFor(s, (a) => a.player.paused && a.player.currentTime < 0.5, null, { timeout: 6000, what: 'stopped at the end' });
  st = await state(s);
  assert.equal(st.index, 3);
  assert.equal(await s.page.$eval(`${WIN} .mp-bar .mp-next`, (b) => b.disabled), true, 'next disabled at the end with repeat off');
  // Repeat all wraps
  await s.page.click(`${WIN} .mp-bar .mp-repeat`);
  await M(s, (a) => a.togglePlay());
  await M(s, (a) => a.player.seek(a.player.duration - 0.4));
  await waitFor(s, (a) => a.queue.index === 0 && !a.player.paused, null, { timeout: 6000, what: 'repeat all wraps' });
  await s.page.click(`${WIN} .mp-bar .mp-repeat`);
  await s.page.click(`${WIN} .mp-bar .mp-repeat`);
  assert.equal((await state(s)).repeat, 'off');
  // Shuffle keeps the current item and restores order when turned off
  const before = await M(s, (a) => a.queue.items.map((i) => i.path));
  await s.page.click(`${WIN} .mp-bar .mp-shuffle`);
  st = await state(s);
  assert.equal(st.shuffle, true);
  assert.equal(st.index, 0);
  assert.equal(await s.page.getAttribute(`${WIN} .mp-bar .mp-shuffle`, 'aria-pressed'), 'true');
  const shuffled = await M(s, (a) => a.queue.items.map((i) => i.path));
  assert.deepEqual([...shuffled].sort(), [...before].sort());
  await s.page.keyboard.press('Control+h');
  assert.equal((await state(s)).shuffle, false);
  assert.deepEqual(await M(s, (a) => a.queue.items.map((i) => i.path)), before);
});

await test('volume: keyboard, mute, flyout slider', async () => {
  await focusPage(s);
  const v0 = (await state(s)).volume;
  await press(s, 'ArrowDown', 2);
  assert.ok(Math.abs((await state(s)).volume - (v0 - 0.1)) < 0.001, '↓ lowers volume by 5 %');
  await press(s, 'ArrowUp');
  assert.ok(Math.abs((await state(s)).volume - (v0 - 0.05)) < 0.001);
  await press(s, 'm');
  assert.equal((await state(s)).muted, true);
  assert.equal(await s.page.getAttribute(`${WIN} .mp-bar .mp-vol .icon`, 'data-icon'), 'speaker_mute');
  const gain = await M(s, (a) => (a.player.gain ? a.player.gain.gain.value : a.player.el.volume));
  await wait(s, 200);
  assert.ok((await M(s, (a) => (a.player.gain ? a.player.gain.gain.value : a.player.el.volume))) < 0.05 || gain < 0.05, 'muted output');
  await press(s, 'm');
  assert.equal((await state(s)).muted, false);
  await s.page.click(`${WIN} .mp-bar .mp-vol`);
  await s.page.waitForSelector(`${WIN} .mp-vol-fly`);
  await M(s, (a) => {
    const sl = a.transport.flySlider;
    sl.value = '30';
    sl.dispatchEvent(new Event('input'));
  });
  assert.ok(Math.abs((await state(s)).volume - 0.3) < 0.001);
  assert.equal(await s.page.textContent(`${WIN} .mp-fly-value`), '30');
  await s.page.click(`${WIN} .mp-fly-mute`);
  assert.equal((await state(s)).muted, true);
  await s.page.click(`${WIN} .mp-fly-mute`);
  await press(s, 'Escape');
  await s.page.waitForSelector(`${WIN} .mp-vol-fly`, { state: 'detached' });
  await M(s, (a) => a.setVolume(0.8));
});

await test('playback speed from the "…" menu', async () => {
  await s.page.click(`${WIN} .mp-bar .mp-more`);
  await menuPick(s, 'Playback speed', '1.5×');
  let st = await state(s);
  assert.equal(st.rate, 1.5);
  assert.equal(await M(s, (a) => a.player.el.playbackRate), 1.5);
  await press(s, '>');
  assert.equal((await state(s)).rate, 1.75);
  await s.page.click(`${WIN} .mp-bar .mp-more`);
  await menuPick(s, 'Playback speed', 'Normal');
  st = await state(s);
  assert.equal(st.rate, 1);
});

await test('play queue page: reorder, remove, play next, save, clear', async () => {
  await s.page.click(`${WIN} [data-nav="queue"]`);
  await s.page.waitForSelector(`${WIN} .mp-queue .mp-row`);
  const titlesOf = () => s.page.$$eval(`${WIN} .mp-queue .mp-row .mp-row-title`, (els) => els.map((e) => e.textContent));
  assert.deepEqual(await titlesOf(), ['Morning Light', 'Night Drive', 'Northern Lights', 'Test Tone']);
  assert.ok(await s.page.$(`${WIN} .mp-queue .mp-row.playing`), 'current item highlighted');
  // Alt+↓ moves the focused row
  await s.page.click(`${WIN} .mp-queue .mp-row >> nth=3`);
  await s.page.keyboard.press('Alt+ArrowUp');
  await wait(s, 450);
  assert.deepEqual(await titlesOf(), ['Morning Light', 'Night Drive', 'Test Tone', 'Northern Lights']);
  // Context menu: remove
  await s.page.click(`${WIN} .mp-queue .mp-row >> nth=3`, { button: 'right' });
  await menuPick(s, 'Remove from play queue');
  await wait(s, 400);
  assert.deepEqual(await titlesOf(), ['Morning Light', 'Night Drive', 'Test Tone']);
  // Delete key on a selected row
  await s.page.click(`${WIN} .mp-queue .mp-row >> nth=2`);
  await press(s, 'Delete');
  await wait(s, 400);
  assert.deepEqual(await titlesOf(), ['Morning Light', 'Night Drive']);
  // Drag-reorder with the mouse (drop on the top half of the first row)
  await s.page
    .locator(`${WIN} .mp-queue .mp-row`)
    .nth(1)
    .dragTo(s.page.locator(`${WIN} .mp-queue .mp-row`).nth(0), { targetPosition: { x: 200, y: 8 } });
  await wait(s, 450);
  assert.deepEqual(await titlesOf(), ['Night Drive', 'Morning Light']);
  assert.equal((await state(s)).index, 1, 'current item followed the move');
  // Play next from the library
  await M(s, (a) => a.playNext([a.lib.songs().find((e) => e.title === 'Northern Lights').path]));
  await wait(s, 400);
  assert.deepEqual(await titlesOf(), ['Night Drive', 'Morning Light', 'Northern Lights']);
  // Drag a song from the library onto "Play queue" in the navigation pane
  await s.page.click(`${WIN} [data-nav="music"]`);
  await s.page.waitForSelector(`${WIN} .mp-music .mp-row`);
  await s.page
    .locator(`${WIN} .mp-music .mp-row`)
    .nth(3)
    .dragTo(s.page.locator(`${WIN} [data-nav="queue"]`));
  await waitFor(s, (a) => a.queue.length === 4, null, { what: 'dragged onto Play queue' });
  await s.page.click(`${WIN} [data-nav="queue"]`);
  await wait(s, 400);
  assert.deepEqual(await titlesOf(), ['Night Drive', 'Morning Light', 'Northern Lights', 'Test Tone']);
  await s.page.click(`${WIN} .mp-queue .mp-row >> nth=3`);
  await press(s, 'Delete');
  await wait(s, 400);
  // Save as playlist
  await s.page.click(`${WIN} .mp-queue-save`);
  await s.page.waitForSelector(`${WIN} .dialog input`);
  await s.page.fill(`${WIN} .dialog input`, 'From queue');
  await press(s, 'Enter');
  await wait(s, 300);
  assert.deepEqual(await M(s, (a) => a.playlists.list().map((p) => [p.name, p.items.length])), [['From queue', 3]]);
  // Clear
  await s.page.click(`${WIN} .mp-queue-clear`);
  await wait(s, 400);
  const st = await state(s);
  assert.equal(st.len, 0);
  assert.equal(st.path, null);
  assert.ok(await s.page.$(`${WIN} .mp-queue .mp-empty`), 'empty state');
  assert.equal(await s.page.$eval(`${WIN} .mp-bar .mp-next`, (b) => b.disabled), true);
});

await test('playlists: create, add via context menu, remove, rename, delete', async () => {
  await s.page.click(`${WIN} .mp-nav-new`);
  await s.page.waitForSelector(`${WIN} .dialog input`);
  await s.page.fill(`${WIN} .dialog input`, 'From queue');
  await press(s, 'Enter');
  assert.ok(await s.page.$(`${WIN} .dialog .invalid`), 'duplicate names are refused');
  await s.page.fill(`${WIN} .dialog input`, 'Road Trip');
  await press(s, 'Enter');
  await s.page.waitForSelector(`${WIN} .mp-playlist .mp-empty`);
  assert.equal(await s.page.textContent(`${WIN} .mp-hero-title`), 'Road Trip');
  assert.ok(await s.page.$(`${WIN} .mp-nav-child.selected`), 'nav shows the playlist as selected');
  await s.page.click(`${WIN} [data-nav="music"]`);
  await s.page.waitForSelector(`${WIN} .mp-music .mp-row`);
  await s.page.click(`${WIN} .mp-music .mp-row >> nth=0`, { button: 'right' });
  await menuPick(s, 'Add to', 'Road Trip');
  await waitFor(s, (a) => a.playlists.list().find((p) => p.name === 'Road Trip')?.items.length === 1, null, { what: 'added to playlist' });
  // multi-select: Ctrl+A then "…" → Add to
  await s.page.click(`${WIN} .mp-music .mp-row >> nth=0`);
  await s.page.keyboard.press('Control+a');
  await s.page.click(`${WIN} .mp-music .mp-row >> nth=2`, { button: 'right' });
  await menuPick(s, 'Add to', 'Road Trip');
  await waitFor(s, (a) => a.playlists.list().find((p) => p.name === 'Road Trip')?.items.length === 5, null, { what: 'added 4 more' });
  await s.page.click(`${WIN} .mp-nav-child >> text=Road Trip`);
  await s.page.waitForSelector(`${WIN} .mp-playlist .mp-row`);
  assert.equal(await s.page.$$eval(`${WIN} .mp-playlist .mp-row`, (r) => r.length), 5);
  await s.page.click(`${WIN} .mp-playlist .mp-row >> nth=0`);
  await press(s, 'Delete');
  await wait(s, 300);
  assert.equal(await s.page.$$eval(`${WIN} .mp-playlist .mp-row`, (r) => r.length), 4);
  // Play the playlist
  await s.page.click(`${WIN} .mp-play-all`);
  await waitFor(s, (a) => !a.player.paused && a.queue.length === 4, null, { what: 'playlist plays' });
  // Rename via the "…" button
  await s.page.click(`${WIN} .mp-pl-more`);
  await menuPick(s, 'Rename');
  await s.page.waitForSelector(`${WIN} .dialog input`);
  await s.page.fill(`${WIN} .dialog input`, 'Weekend');
  await press(s, 'Enter');
  await wait(s, 300);
  assert.equal(await s.page.textContent(`${WIN} .mp-hero-title`), 'Weekend');
  const file = path.join(home, '.config', 'aurora', 'apps', 'media', 'playlists.json');
  await waitFor(s, () => true);
  assert.ok(fs.readFileSync(file, 'utf8').includes('Weekend'), 'playlists persisted');
  await shot(s, 'playlist', true);
  // Delete
  await s.page.click(`${WIN} .mp-pl-more`);
  await menuPick(s, 'Delete');
  await s.page.waitForSelector(`${WIN} .dialog`);
  await s.page.click(`${WIN} .dialog .btn.danger`);
  await wait(s, 400);
  assert.deepEqual(await M(s, (a) => a.playlists.list().map((p) => p.name)), ['From queue']);
  assert.equal(await M(s, (a) => a.route.name), 'playlists');
});

await test('search finds songs, albums and playlists', async () => {
  await s.page.keyboard.press('Control+e');
  await wait(s, 150);
  assert.equal(await s.page.evaluate(() => document.activeElement?.classList.contains('mp-search-input')), true, 'Ctrl+E focuses search');
  await s.page.keyboard.type('night');
  await press(s, 'Enter');
  await s.page.waitForSelector(`${WIN} .mp-search .mp-row`);
  assert.deepEqual(await s.page.$$eval(`${WIN} .mp-search .mp-row .mp-row-title`, (els) => els.map((e) => e.textContent)), ['Night Drive']);
  await s.page.fill(`${WIN} .mp-search-input`, 'zzzz');
  await press(s, 'Enter');
  await s.page.waitForSelector(`${WIN} .mp-search .mp-empty`);
});

await test('now playing view with a running visualizer', async () => {
  await M(s, (a) =>
    a.playEntries(
      a.lib
        .songs()
        .filter((e) => e.album)
        .sort((x, y) => x.track - y.track),
      1,
    ),
  );
  await waitFor(s, (a) => !a.player.paused && a.player.currentTime > 1.2, null, { what: 'song playing' });
  await s.page.click(`${WIN} .mp-bar-art`);
  await s.page.waitForSelector(`${WIN} .mp.stage-open`);
  const info = await M(s, (a) => ({ viz: a.stage.viz.running, video: a.isVideo(), title: a.stage.npTitle.textContent, next: a.stage.npNext.textContent, hidden: a.stage.canvas.hidden }));
  assert.deepEqual(info, { viz: true, video: false, title: 'Night Drive', next: 'Up next: Northern Lights', hidden: false });
  await wait(s, 900);
  const lit = await M(s, (a) => {
    const c = a.stage.canvas;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 40) n++;
    return n;
  });
  assert.ok(lit > 500, `visualizer draws (${lit} px)`);
  const analyser = await M(s, (a) => {
    const arr = new Uint8Array(a.player.analyser.frequencyBinCount);
    a.player.analyser.getByteFrequencyData(arr);
    return Math.max(...arr);
  });
  assert.ok(analyser > 50, 'WebAudio analyser receives the music');
  await shot(s, 'now-playing', true);
  // Visualizer style: wave, then off
  await M(s, (a) => a.setPref('visualizer', 'wave'));
  await wait(s, 300);
  assert.equal(await M(s, (a) => a.stage.viz.style), 'wave');
  await M(s, (a) => a.setPref('visualizer', 'off'));
  assert.equal(await M(s, (a) => a.stage.canvas.hidden), true);
  await M(s, (a) => a.setPref('visualizer', 'bars'));
  await press(s, 'Escape');
  assert.equal((await state(s)).stage, false, 'Esc leaves the now playing view');
});

await test('video playback, full screen (double-click, F, Esc) and auto-hiding controls', async () => {
  await s.page.click(`${WIN} [data-nav="videos"]`);
  await s.page.waitForSelector(`${WIN} .mp-video-grid .mp-tile`);
  assert.equal(await s.page.textContent(`${WIN} .mp-video-grid .mp-badge`), '0:12');
  assert.ok(await s.page.$(`${WIN} .mp-video-grid .mp-tile img`), 'thumbnail shown');
  await s.page.click(`${WIN} .mp-video-grid .mp-tile`);
  await waitFor(s, (a) => a.stageOpen && a.isVideo() && !a.player.paused && a.player.currentTime > 1.5, null, { what: 'video plays in the stage' });
  const vid = await M(s, (a) => ({ w: a.player.el.videoWidth, h: a.player.el.videoHeight, cls: a.root.className }));
  assert.deepEqual([vid.w, vid.h], [1280, 720]);
  assert.match(vid.cls, /stage-open/);
  assert.match(vid.cls, /is-video/);
  const t1 = (await state(s)).t;
  await wait(s, 600);
  assert.ok((await state(s)).t > t1 + 0.3, 'currentTime advances');
  await s.page.mouse.move(700, 400);
  await shot(s, 'video', true);
  // double-click → full screen
  await s.page.dblclick(`${WIN} .mp-video-host`);
  await waitFor(s, (a) => a.win.fullscreen, null, { what: 'full screen' });
  assert.equal(await s.page.$eval(`${WIN}`, (el) => el.classList.contains('fullscreen')), true);
  assert.equal((await state(s)).paused, false, 'double-click does not pause');
  // controls hide after 3 s idle and come back on movement
  await s.page.mouse.move(705, 410);
  await waitFor(s, (a) => a.root.classList.contains('idle'), null, { timeout: 5000, what: 'controls auto-hide' });
  await s.page.mouse.move(600, 300);
  await wait(s, 100);
  assert.equal(await M(s, (a) => a.root.classList.contains('idle')), false);
  await press(s, 'Escape');
  await waitFor(s, (a) => !a.win.fullscreen, null, { what: 'Esc exits full screen' });
  assert.equal((await state(s)).stage, true, 'video view stays open');
  await press(s, 'f');
  await waitFor(s, (a) => a.win.fullscreen, null, { what: 'F enters full screen' });
  await press(s, 'f');
  await waitFor(s, (a) => !a.win.fullscreen, null, { what: 'F leaves full screen' });
  await s.page.click(`${WIN} .mp-full`);
  await waitFor(s, (a) => a.win.fullscreen, null, { what: 'button enters full screen' });
  await s.page.mouse.move(650, 300);
  await s.page.click(`${WIN} .mp-full`);
  await waitFor(s, (a) => !a.win.fullscreen);
  // single click toggles playback
  await s.page.click(`${WIN} .mp-video-host`);
  await waitFor(s, (a) => a.player.paused, null, { what: 'click pauses' });
  await s.page.click(`${WIN} .mp-video-host`);
  await waitFor(s, (a) => !a.player.paused, null, { what: 'click resumes' });
  await s.page.click(`${WIN} .mp-stage-back`);
  assert.equal((await state(s)).stage, false);
});

await test('mini player shrinks the window and restores it', async () => {
  const before = await M(s, (a) => ({ ...a.win.rect(), state: a.win.state }));
  await s.page.click(`${WIN} .mp-bar .mp-mini`);
  await wait(s, 400);
  const mini = await M(s, (a) => ({ ...a.win.rect(), mini: a.mini, top: a.win.alwaysOnTop, cls: a.root.classList.contains('mini'), video: a.isVideo() }));
  assert.equal(mini.mini, true);
  assert.equal(mini.cls, true);
  assert.equal(mini.video, true, 'the intro video is still playing');
  assert.deepEqual([mini.width, mini.height], [400, 225 + 32], '16:9 mini player for video');
  assert.equal(mini.top, true, 'mini player stays on top');
  await shot(s, 'mini-player', true);
  await s.page.hover(`${WIN} .mp-stage`);
  await wait(s, 300);
  await s.page.click(`${WIN} .mp-mini-play`);
  await waitFor(s, (a) => a.player.paused, null, { what: 'mini play/pause' });
  await s.page.click(`${WIN} .mp-mini-play`);
  await s.page.click(`${WIN} .mp-mini-exit`);
  await wait(s, 400);
  const after = await M(s, (a) => ({ ...a.win.rect(), state: a.win.state, mini: a.mini, top: a.win.alwaysOnTop }));
  assert.equal(after.mini, false);
  assert.equal(after.state, before.state);
  assert.equal(after.width, before.width);
  assert.equal(after.top, false);
});

await test('opening files: shell.openFile / relaunch with {file} and {files}', async () => {
  const hello = path.join(D, 'hello.wav');
  await s.aurora((p) => window.__aurora.shell.openFile(p), hello);
  await waitFor(s, (a, p) => a.player.path === p && !a.player.paused, hello, { what: 'openFile plays the file' });
  assert.equal(await s.aurora(() => window.__aurora.wm.byApp('media').length), 1, 'single instance');
  let st = await state(s);
  assert.equal(st.len, 1);
  await waitFor(s, (a) => a.transport.titleEl.textContent === 'Hello Tone', null, { what: 'tags of opened file' });
  await s.aurora((files) => window.__aurora.shell.launch('media', { files }), [path.join(D, 'second.wav'), hello]);
  await waitFor(s, (a, p) => a.player.path === p && a.queue.length === 2, path.join(D, 'second.wav'), { what: 'relaunch with files' });
  st = await state(s);
  assert.equal(st.title, 'second', 'falls back to the file name');
  await waitFor(s, (a) => a.recent[0] === a.player.path, null, { what: 'recent media updated' });
});

await test('drag and drop: files are queued, unsupported items are reported', async () => {
  const drop = (paths) =>
    M(
      s,
      (a, p) => {
        const dt = new DataTransfer();
        dt.setData('application/x-aurora-paths', JSON.stringify(p));
        const target = a.root;
        for (const type of ['dragenter', 'dragover', 'drop']) target.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
        return true;
      },
      paths,
    );
  const len = (await state(s)).len;
  await drop([path.join(home, 'Videos', 'Aurora Intro.webm'), path.join(MUSIC, 'Tests')]);
  await waitFor(s, (a, n) => a.queue.length === n + 2, len, { what: 'dropped items queued (file + folder)' });
  await s.page.waitForSelector(`${WIN} .mp-toast.success`);
  assert.match(await s.page.textContent(`${WIN} .mp-toast.success`), /Added 2 items to the play queue/);
  await drop([path.join(D, 'notes.txt')]);
  await s.page.waitForSelector(`${WIN} .mp-toast.warning`);
  assert.match(await s.page.textContent(`${WIN} .mp-toast.warning`), /Nothing to play/);
  // dropping onto the "Play queue" navigation item
  await M(
    s,
    (a, p) => {
      const dt = new DataTransfer();
      dt.setData('application/x-aurora-paths', JSON.stringify(p));
      const el = a.navItems.queue;
      for (const type of ['dragenter', 'dragover', 'drop']) el.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
    },
    [path.join(D, 'hello.wav')],
  );
  await waitFor(s, (a, n) => a.queue.length === n + 3, len, { what: 'drop on the nav item' });
});

await test('errors: unsupported and missing files show an error and skip ahead', async () => {
  await s.aurora((p) => window.__aurora.shell.openFile(p), path.join(D, 'broken.mp3'));
  await s.page.waitForSelector(`${WIN} .mp-toast.error`, { timeout: 8000 });
  const msg = await s.page.textContent(`${WIN} .mp-toast.error`);
  assert.match(msg, /Can't play this item/);
  assert.match(msg, /broken\.mp3/);
  await M(s, (a) => a.toasts.replaceChildren());
  // a missing file in the middle of a queue is skipped
  const gone = path.join(D, 'gone.wav');
  await M(s, (a, p) => a.playEntries([p[0], p[1]], 0), [gone, path.join(D, 'hello.wav')]);
  await s.page.waitForSelector(`${WIN} .mp-toast.error`, { timeout: 8000 });
  assert.match(await s.page.textContent(`${WIN} .mp-toast.error`), /can't be found/);
  await waitFor(s, (a) => a.player.path?.endsWith('hello.wav') && !a.player.paused, null, { timeout: 6000, what: 'skips to the next item' });
});

await test('keyboard: Ctrl+O opens the file picker, Esc cancels; Ctrl+Shift+O picks a folder', async () => {
  await M(s, (a) => a.go({ name: 'home' }));
  await focusList(s);
  await s.page.keyboard.press('Control+o');
  await s.page.waitForSelector(`${WIN} .fp-dialog`);
  assert.match(await s.page.textContent(`${WIN} .fp-dialog .dialog-title`), /Open file/);
  await s.page.waitForFunction(() => !!document.activeElement?.closest('.fp-dialog'));
  const pausedBefore = (await state(s)).paused;
  await press(s, 'k');
  assert.equal((await state(s)).paused, pausedBefore, 'shortcuts are inactive while a dialog is open');
  await press(s, 'Escape');
  await s.page.waitForSelector(`${WIN} .fp-dialog`, { state: 'detached' });
  await focusList(s);
  await M(s, (a, p) => (a.lastDir = p), path.join(MUSIC, 'Tests'));
  await s.page.keyboard.press('Control+Shift+O');
  await s.page.waitForSelector(`${WIN} .fp-dialog`);
  assert.equal(await s.page.inputValue(`${WIN} .fp-dialog .fp-path`), path.join(MUSIC, 'Tests'));
  await s.page.click(`${WIN} .fp-dialog .dialog-footer .btn.primary`);
  await waitFor(s, (a) => a.player.path?.endsWith('tone.wav') && a.queue.length === 1, null, { what: 'open folder plays its media' });
});

await test('settings: library folders, visualizer and resume preferences persist', async () => {
  await s.page.click(`${WIN} [data-nav="settings"]`);
  await s.page.waitForSelector(`${WIN} .mp-settings`);
  const folders = await s.page.$$eval(`${WIN} .mp-set-folder .ellipsis`, (els) => els.map((e) => e.textContent));
  assert.deepEqual(folders, [MUSIC, path.join(home, 'Videos')]);
  await s.page.selectOption(`${WIN} .mp-viz-select`, 'wave');
  await s.page.click(`${WIN} .mp-resume-toggle`);
  await wait(s, 300);
  const prefs = JSON.parse(fs.readFileSync(path.join(home, '.config', 'aurora', 'apps', 'media', 'prefs.json'), 'utf8'));
  const p = prefs.value || prefs;
  assert.equal(p.visualizer, 'wave');
  assert.equal(p.resume, false);
  await s.page.click(`${WIN} .mp-resume-toggle`);
  await s.page.selectOption(`${WIN} .mp-viz-select`, 'bars');
  // removing a library folder asks first and rescans
  await s.page.click(`${WIN} .mp-set-card[data-kind="video"] .mp-remove-folder`);
  await s.page.waitForSelector(`${WIN} .dialog`);
  await s.page.click(`${WIN} .dialog .btn.primary`);
  await waitFor(s, (a) => a.lib.videos().length === 0 && !a.lib.scanning, null, { what: 'video folder removed' });
  await M(s, (a) => a.lib.addFolder('video', `${a.home}/Videos`).then(() => a.refreshLibrary()));
  await waitFor(s, (a) => a.lib.videos().length === 1, null, { what: 'video folder restored' });
});

await test('library follows files added to or removed from ~/Music', async () => {
  const added = path.join(MUSIC, 'Fresh Song.wav');
  fs.writeFileSync(added, wavFile({ seconds: 1, title: 'Fresh Song', artist: 'Aurora QA' }));
  await waitFor(s, (a, p) => a.lib.songs().some((e) => e.path === p && e.title === 'Fresh Song'), added, { timeout: 10000, what: 'new file picked up' });
  await M(s, (a) => a.go({ name: 'music' }));
  await s.page.waitForSelector(`${WIN} .mp-music .mp-row[data-path$="Fresh Song.wav"]`);
  fs.rmSync(added);
  await waitFor(s, (a, p) => !a.lib.songs().some((e) => e.path === p), added, { timeout: 10000, what: 'removed file dropped' });
  await s.page.waitForSelector(`${WIN} .mp-music .mp-row[data-path$="Fresh Song.wav"]`, { state: 'detached' });
});

await test('screenshots: music library (light) and home', async () => {
  await M(s, (a) => {
    a.toasts.replaceChildren();
    a.searchInput.value = '';
  });
  await M(s, (a) =>
    a.playEntries(
      a.lib
        .songs()
        .filter((e) => e.album)
        .sort((x, y) => x.track - y.track),
      0,
    ),
  );
  await M(s, (a) => a.go({ name: 'music' }));
  await waitFor(s, (a) => a.player.currentTime > 1);
  await s.page.hover(`${WIN} .mp-bar .mp-mini`);
  await s.page.hover(`${WIN} .mp-title`);
  await s.page.mouse.move(900, 620, { steps: 4 });
  await shot(s, 'music-library', true);
  await M(s, (a) => a.go({ name: 'home' }));
  await shot(s, 'home', true);
});

await test('resume: the queue and position come back after closing', async () => {
  await M(s, (a) => a.player.seek(12.5));
  await M(s, (a) => a.player.pause());
  await wait(s, 300);
  const before = await state(s);
  await M(s, (a) => a.win.close());
  await s.page.waitForFunction(() => !document.querySelector('.win.app-media'), null, { timeout: 5000 });
  await s.aurora(() => window.__aurora.shell.launch('media'));
  await s.page.waitForSelector(`${WIN} .mp`);
  await waitFor(s, (a) => a && a.player.path && a.player.duration > 0, null, { what: 'state restored' });
  const after = await state(s);
  assert.equal(after.path, before.path);
  assert.equal(after.len, before.len);
  assert.equal(after.index, before.index);
  assert.equal(after.paused, true, 'restored paused');
  assert.ok(Math.abs(after.t - 12.5) < 1, `position ${after.t}`);
  assert.equal(after.title, 'Morning Light');
});

await test('codec matrix: every supported extension plays (needs ffmpeg to build fixtures)', async () => {
  if (spawnSync('ffmpeg', ['-version']).status !== 0) {
    console.log('      (skipped: ffmpeg not installed)');
    return;
  }
  const dir = path.join(home, 'Documents', 'formats');
  fs.mkdirSync(dir, { recursive: true });
  const tone = ['-f', 'lavfi', '-i', 'sine=f=440:d=2'];
  const pic = ['-f', 'lavfi', '-i', 'testsrc=d=2:s=320x240:r=25'];
  const jobs = {
    'a.mp3': [...tone],
    'a.m4a': [...tone, '-c:a', 'aac'],
    'a.aac': [...tone, '-c:a', 'aac'],
    'a.flac': [...tone, '-c:a', 'flac'],
    'a.opus': [...tone, '-c:a', 'libopus'],
    'a.oga': [...tone, '-c:a', 'libvorbis'],
    'v.mp4': [...pic, '-c:v', 'libx264', '-pix_fmt', 'yuv420p'],
    'v.m4v': [...pic, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-f', 'mp4'],
    'v.mov': [...pic, '-c:v', 'libx264', '-pix_fmt', 'yuv420p'],
    'v.mkv': [...pic, '-c:v', 'libvpx-vp9'],
  };
  const made = [];
  for (const [name, args] of Object.entries(jobs)) {
    const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args, path.join(dir, name)]);
    if (r.status === 0) made.push(name);
  }
  assert.ok(made.length >= 8, `fixtures: ${made}`);
  for (const name of made) {
    const p = path.join(dir, name);
    await s.aurora((f) => window.__aurora.shell.openFile(f), p);
    await waitFor(s, (a, f) => a.player.path === f && !a.player.paused && a.player.currentTime > 0.15, p, { timeout: 8000, what: `${name} plays` });
    if (name.startsWith('v.')) assert.equal(await M(s, (a) => a.player.hasVideo), true, `${name} has video`);
  }
  await M(s, (a) => a.closeStage());
  await M(s, (a) => a.toasts.replaceChildren());
  // Theora (.ogv) is no longer decoded by Chromium: it must fail gracefully.
  const ogv = path.join(dir, 'v.ogv');
  if (spawnSync('ffmpeg', ['-v', 'error', '-y', ...pic, '-c:v', 'libtheora', ogv]).status === 0) {
    await s.aurora((f) => window.__aurora.shell.openFile(f), ogv);
    await s.page.waitForSelector(`${WIN} .mp-toast.error`, { timeout: 8000 });
    assert.match(await s.page.textContent(`${WIN} .mp-toast.error`), /v\.ogv/);
    await M(s, (a) => a.toasts.replaceChildren());
  }
});

await test('no console errors from the app (en/light session)', async () => {
  assert.deepEqual(appErrors(s), []);
});
await s.close();

// ================================================================== French + dark, sizes
const home2 = makeHome();
const f = await launchShell({ open: ['media'], home: home2, lang: 'fr', theme: 'dark', keepHome: true });
current = f;
await f.page.waitForSelector(`${WIN} .mp`, { timeout: 30000 });
await waitFor(f, (a) => a && a.lib.songs().length === 4 && a.lib.songs().every((e) => e.duration > 0) && a.lib.videos().every((e) => e.thumb), null, { timeout: 30000, what: 'fr library' });

function overflowCheck(sess) {
  return M(sess, (a) => {
    const bad = [];
    for (const el of a.root.querySelectorAll('.btn, .tab, .mp-tb, .nav-item:not(.mp-nav-child)')) {
      const r = el.getBoundingClientRect();
      if (!r.width || el.closest('[hidden]') || getComputedStyle(el).visibility === 'hidden') continue;
      const label = el.querySelector('.ellipsis, .mp-nav-label');
      if (!label && el.scrollWidth > el.clientWidth + 1) bad.push(`${el.className}: ${el.textContent.trim()}`);
    }
    const w = a.win.el.getBoundingClientRect();
    for (const el of a.root.querySelectorAll('.mp-bar .btn')) {
      const r = el.getBoundingClientRect();
      if (r.width && (r.right > w.right + 1 || r.left < w.left - 1)) bad.push(`outside window: ${el.className}`);
    }
    return bad;
  });
}

await test('French UI strings and dark theme', async () => {
  await M(f, (a) => a.win.maximize());
  await f.page.click(`${WIN} [data-nav="music"]`);
  await f.page.waitForSelector(`${WIN} .mp-music .mp-row`);
  assert.equal(await f.page.textContent(`${WIN} .mp-title`), 'Bibliothèque musicale');
  assert.equal(await f.page.textContent(`${WIN} .mp-count`), '4 titres');
  assert.equal(await f.page.textContent(`${WIN} [data-nav="queue"] .mp-nav-label`), "File d'attente");
  assert.equal(await f.page.getAttribute(`${WIN} .mp-bar .mp-play`, 'aria-label'), 'Lire (Ctrl+P)');
  assert.equal(await f.page.evaluate(() => document.documentElement.dataset.theme), 'dark');
  await M(f, (a) =>
    a.playEntries(
      a.lib
        .songs()
        .filter((e) => e.album)
        .sort((x, y) => x.track - y.track),
      2,
    ),
  );
  await waitFor(f, (a) => a.player.currentTime > 1);
  await f.page.mouse.move(900, 600);
  assert.deepEqual(await overflowCheck(f), []);
  await shot(f, 'fr-dark-music', true);
  await f.page.click(`${WIN} .mp-bar-art`);
  await wait(f, 1200);
  assert.equal(await f.page.textContent(`${WIN} .mp-np-kicker`), 'En cours de lecture');
  await shot(f, 'fr-dark-now-playing', true);
  await press(f, 'Escape');
  await M(f, (a) => a.go({ name: 'settings' }));
  assert.deepEqual(await overflowCheck(f), []);
  await shot(f, 'fr-dark-settings');
});

await test('minimum window size (500×460): compact layout still works', async () => {
  await M(f, (a) => a.win.restore());
  await M(f, (a) => a.win.setSize(400, 300));
  const r = await M(f, (a) => a.win.rect());
  assert.deepEqual([r.width, r.height], [500, 460], 'manifest minimum size');
  await M(f, (a) => a.go({ name: 'music' }));
  await wait(f, 700);
  const info = await M(f, (a) => ({ minimal: a.root.classList.contains('nav-minimal'), tiny: a.root.classList.contains('w-tiny'), navVisible: getComputedStyle(a.navEl).visibility }));
  assert.equal(info.minimal, true);
  assert.equal(info.tiny, true);
  assert.equal(info.navVisible, 'hidden');
  assert.deepEqual(await overflowCheck(f), []);
  await shot(f, 'min-size', true);
  await f.page.click(`${WIN} .mp-float-menu`);
  await wait(f, 300);
  assert.equal(await M(f, (a) => getComputedStyle(a.navEl).visibility), 'visible');
  await shot(f, 'min-size-nav');
  await f.page.click(`${WIN} [data-nav="videos"]`);
  await wait(f, 300);
  assert.equal(await M(f, (a) => [a.route.name, a.navOverlay].join()), 'videos,false');
  await M(f, (a) => a.openStage());
  await wait(f, 500);
  assert.deepEqual(await overflowCheck(f), []);
  await shot(f, 'min-size-now-playing');
  await M(f, (a) => a.closeStage());
  // mid size: compact navigation rail
  await M(f, (a) => a.win.setSize(860, 620));
  await wait(f, 300);
  assert.equal(await M(f, (a) => a.root.classList.contains('nav-compact')), true);
  assert.equal(await M(f, (a) => a.navEl.getBoundingClientRect().width), 48);
});

await test('switching the language live rebuilds the UI without stopping playback', async () => {
  await M(f, (a) => a.win.maximize());
  await M(f, (a) => a.playEntries(a.lib.songs(), 0));
  await waitFor(f, (a) => !a.player.paused && a.player.currentTime > 0.5);
  await M(f, (a) => a.openStage());
  await f.aurora(() => window.__aurora.i18n.setLang('en'));
  await wait(f, 300);
  assert.equal(await f.page.textContent(`${WIN} [data-nav="queue"] .mp-nav-label`), 'Play queue');
  assert.equal(await f.page.textContent(`${WIN} .mp-np-kicker`), 'Now playing');
  const st = await state(f);
  assert.equal(st.paused, false, 'still playing');
  assert.equal(st.stage, true, 'still in the now playing view');
  assert.ok(await M(f, (a) => a.stage.videoHost.contains(a.player.el)), 'media element moved into the new stage');
  await f.aurora(() => window.__aurora.i18n.setLang('fr'));
  await wait(f, 300);
  assert.equal(await f.page.textContent(`${WIN} [data-nav="queue"] .mp-nav-label`), "File d'attente");
  await M(f, (a) => a.closeStage());
});

await test('animations off: the visualizer stops and is hidden', async () => {
  await M(f, (a) => a.openStage());
  await waitFor(f, (a) => a.stage.viz.running, null, { what: 'visualizer running' });
  await f.aurora(() => window.__aurora.settings.set('animations', false));
  await waitFor(f, (a) => document.documentElement.dataset.animations === 'off' && !a.stage.viz.running && a.stage.canvas.hidden, null, { what: 'visualizer stopped' });
  await f.aurora(() => window.__aurora.settings.set('animations', true));
  await waitFor(f, (a) => a.stage.viz.running && !a.stage.canvas.hidden, null, { what: 'visualizer back' });
  await M(f, (a) => a.closeStage());
});

await test('no console errors from the app (fr/dark session)', async () => {
  assert.deepEqual(appErrors(f), []);
});
await f.close();
fs.rmSync(home, { recursive: true, force: true });
fs.rmSync(home2, { recursive: true, force: true });

// ------------------------------------------------------------------ summary
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} tests passed`);
console.log(`screenshots: ${OUT}/media-*.png, ${DOCS}/media-*.png`);
if (failed.length) {
  for (const r of failed) console.log(`  failed: ${r.name}`);
  process.exit(1);
}
