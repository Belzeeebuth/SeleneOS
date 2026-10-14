// Podcasts & News (« Podcasts et actus », app id feeds) — main/ipc/feeds.js helpers, the renderer parsers (dates,
// durations, RSS 2.0 / Atom / RDF / JSON Feed, autodiscovery, OPML, sanitiser) and the real Electron shell against a
// local HTTP server started here (fixture feeds in test/fixtures/feeds, generated audio and pictures, a fake iTunes
// Search endpoint through AURORA_FEEDS_ITUNES_URL): subscribe by address, by website (autodiscovery, feed-looking
// links, usual addresses), by podcast search; lists and unread counts; reading pane sanitisation (nothing runs, no
// remote request before « Afficher les images »); download with progress, cancel, play, resume position, speed,
// skips, sleep timer, chapters, mark played, delete played; refresh with 304 (ETag) and new items; errors (broken feed,
// 503 + Retry-After, redirects, size cap); OPML export / import round trip; persistence; narrow layout; en / fr,
// light / dark screenshots (test/out/feeds-*.png).
// Usage:  cd aurora-os/shell && xvfb-run -a -s "-screen 0 1600x900x24" node test/feeds.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { launchShell, ROOT } from './lib.mjs';

const require = createRequire(import.meta.url);
const FIX = path.join(ROOT, 'test', 'fixtures', 'feeds');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const W = '.win.app-feeds';

let passed = 0;
let failed = 0;
const T0 = Date.now();
const VERBOSE = process.argv.includes('--verbose');
function check(ok, name, detail = '') {
  const at = VERBOSE ? `[${((Date.now() - T0) / 1000).toFixed(1)}s] ` : '';
  if (ok) {
    passed++;
    console.log(`  ok  ${at}${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${at}${name}${detail ? ` — ${detail}` : ''}`);
  }
  return ok;
}
async function waitFor(fn, ms = 10000, step = 100) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await Promise.resolve()
      .then(fn)
      .catch(() => null);
    if (v) return v;
    if (Date.now() > end) return v;
    await sleep(step);
  }
}

// ------------------------------------------------------------------ generated media
const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function png(w, h, [r, g, b]) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      const k = (x + y) % 16 < 8 ? 1 : 0.8;
      raw[o] = r * k;
      raw[o + 1] = g * k;
      raw[o + 2] = b * k;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
function wav(seconds, rate = 8000, freq = 440) {
  const n = Math.floor(seconds * rate);
  const pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 0.2 * 32767), i * 2);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(36 + pcm.length, 4);
  head.write('WAVEfmt ', 8, 'latin1');
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36, 'latin1');
  head.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([head, pcm]);
}
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-feeds-'));
let ep1 = { buf: wav(6, 8000, 440), ext: 'wav', type: 'audio/wav' };
{
  const out = path.join(TMP, 'ep1.mp3');
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-ac', '1', '-ar', '22050', '-b:a', '32k', '-y', out], { timeout: 30000 });
  if (r.status === 0 && fs.existsSync(out) && fs.statSync(out).size > 1000) ep1 = { buf: fs.readFileSync(out), ext: 'mp3', type: 'audio/mpeg' };
}
console.log(`(episode 1 fixture: ${ep1.ext}, ${ep1.buf.length} bytes${ep1.ext === 'wav' ? ', ffmpeg not available' : ', made with ffmpeg'})`);
const EP2 = wav(5, 8000, 660);
const SLOW = wav(125, 8000, 330); // 2 MB, sent slowly
const IMG = { cover: png(64, 64, [90, 120, 220]), 'news-logo': png(48, 48, [220, 120, 60]), photo1: png(40, 30, [60, 160, 90]), ep1: png(64, 64, [200, 80, 160]) };

// ------------------------------------------------------------------ the test server
const reqs = [];
let BASE = '';
let newsVersion = 1;
let flaky = false;
const fixture = (name) =>
  fs
    .readFileSync(path.join(FIX, name), 'utf8')
    .replaceAll('{{BASE}}', BASE)
    .replaceAll('{{EP1_EXT}}', ep1.ext)
    .replaceAll('{{EP1_TYPE}}', ep1.type)
    .replaceAll('{{EP1_LEN}}', String(ep1.buf.length))
    .replaceAll('{{EP2_LEN}}', String(EP2.length))
    .replaceAll('{{SLOW_LEN}}', String(SLOW.length));
const EXTRA_ITEM = `<item><title>Cinquième nouvelle</title><link>${'{{BASE}}'}/news/cinquieme</link><guid>news-5</guid><pubDate>Wed, 14 Oct 2026 07:00:00 +0200</pubDate><description>Toute fraîche.</description></item>`;
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  reqs.push({ path: p, search: u.search, headers: req.headers, at: Date.now() });
  const send = (status, type, body, headers = {}) => {
    res.writeHead(status, { 'content-type': type, ...headers });
    res.end(body);
  };
  if (p === '/news.rss') {
    const etag = `"news-v${newsVersion}"`;
    if (req.headers['if-none-match'] === etag) return send(304, 'application/rss+xml', '', { etag });
    return send(200, 'application/rss+xml; charset=utf-8', fixture('news.rss').replace('{{EXTRA}}', newsVersion > 1 ? EXTRA_ITEM.replaceAll('{{BASE}}', BASE) : ''), { etag });
  }
  if (p === '/atom.xml') {
    const lm = 'Mon, 12 Oct 2026 10:00:00 GMT';
    if (req.headers['if-modified-since'] === lm) return send(304, 'application/atom+xml', '', { 'last-modified': lm });
    const body = Buffer.from(fixture('atom.xml'));
    if (/gzip/.test(req.headers['accept-encoding'] || '')) return send(200, 'application/atom+xml', zlib.gzipSync(body), { 'content-encoding': 'gzip', 'last-modified': lm });
    return send(200, 'application/atom+xml', body, { 'last-modified': lm });
  }
  if (p === '/rdf.xml') return send(200, 'application/xml', Buffer.from(fixture('rdf.xml'), 'latin1'));
  if (p === '/podcast.xml') return send(200, 'application/rss+xml', fixture('podcast.xml'));
  if (p === '/hostile.rss') return send(200, 'application/rss+xml', fixture('hostile.rss'));
  if (p === '/broken.xml') return send(200, 'application/xml', fixture('broken.xml'));
  if (p === '/comments.rss') return send(200, 'application/rss+xml', fixture('comments.rss'));
  if (p === '/flaky.rss') return flaky ? send(503, 'text/plain', 'busy', { 'retry-after': '120' }) : send(200, 'application/rss+xml', fixture('comments.rss').replace('Commentaires du carnet', 'Flux capricieux'));
  if (p === '/site.html') return send(200, 'text/html; charset=utf-8', fixture('site.html'));
  if (p === '/blog.html') return send(200, 'text/html; charset=utf-8', fixture('blog.html'));
  if (p === '/moved.rss') return send(301, 'text/plain', '', { location: '/comments.rss' });
  if (p.startsWith('/redirect/')) {
    const n = Number(p.split('/')[2]);
    return send(302, 'text/plain', '', { location: n > 0 ? `/redirect/${n - 1}` : '/comments.rss' });
  }
  if (p.startsWith('/dlhop/')) {
    const n = Number(p.split('/')[2]);
    return send(302, 'text/plain', '', { location: n > 0 ? `/dlhop/${n - 1}` : '/audio/ep2.wav' });
  }
  if (p.startsWith('/loop/')) return send(302, 'text/plain', '', { location: `/loop/${Number(p.split('/')[2]) + 1}` });
  if (p === '/huge.xml') {
    res.writeHead(200, { 'content-type': 'application/xml' });
    const chunk = Buffer.alloc(256 * 1024, 0x20);
    let n = 0;
    const pump = () => {
      while (n < 12 && !res.destroyed) {
        n++;
        if (!res.write(chunk)) return res.once('drain', pump);
      }
      res.end();
    };
    return pump();
  }
  if (p.startsWith('/itunes/search')) return send(200, 'text/javascript; charset=utf-8', fixture('itunes.json'));
  if (p === '/chapters.json') return send(200, 'application/json+chapters', fixture('chapters.json'));
  const img = /^\/img\/([\w-]+)\.png$/.exec(p);
  if (img && IMG[img[1]]) return send(200, 'image/png', IMG[img[1]]);
  if (p === '/tracker.png' || p === '/pixel.png' || p === '/bg.png') return send(200, 'image/png', IMG.photo1);
  if (p === `/audio/ep1.${ep1.ext}`) return send(200, ep1.type, ep1.buf, { 'content-length': String(ep1.buf.length) });
  if (p === '/audio/ep2.wav') return send(200, 'audio/wav', EP2, { 'content-length': String(EP2.length) });
  if (p === '/audio/slow.wav') {
    res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': String(SLOW.length) });
    let i = 0;
    const tick = () => {
      if (res.destroyed || res.writableEnded) return;
      const c = SLOW.subarray(i, i + 32768);
      i += c.length;
      res.write(c);
      if (i >= SLOW.length) res.end();
      else setTimeout(tick, 120);
    };
    return tick();
  }
  return send(404, 'text/plain', 'not found');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
BASE = `http://127.0.0.1:${server.address().port}`;
// a second site with no feed at all (ENOFEED)
const bare = http.createServer((req, res) => {
  res.writeHead(req.url === '/' ? 200 : 404, { 'content-type': 'text/html' });
  res.end('<!doctype html><title>Rien</title><p>Pas de flux ici.</p>');
});
await new Promise((r) => bare.listen(0, '127.0.0.1', r));
const BARE = `http://127.0.0.1:${bare.address().port}`;
const hits = (p) => reqs.filter((r) => r.path === p).length;
const lastReq = (p) => [...reqs].reverse().find((r) => r.path === p);

// ------------------------------------------------------------------ unit: backend helpers
console.log('\n# Unit: main/ipc/feeds.js helpers');
{
  const fd = require(path.join(ROOT, 'main/ipc/feeds.js'));
  check(fd.safeName('  ../Le «podcast»: épisode 1/2?*  ') === 'Le «podcast» épisode 1 2' && fd.safeName('...') === 'podcast' && fd.safeName('a'.repeat(300)).length === 100 && fd.safeName('\u0000x\ny') === 'x y', `safe file names (${fd.safeName('  ../Le «podcast»: épisode 1/2?*  ')})`);
  const latin = Buffer.from('<?xml version="1.0" encoding="ISO-8859-1"?><t>été</t>', 'latin1');
  check(fd.decodeBody(latin, 'application/xml').includes('été'), 'charset from the XML declaration (ISO-8859-1)');
  check(fd.decodeBody(Buffer.from('caf\xe9', 'latin1'), 'text/xml; charset=windows-1252') === 'café', 'charset from Content-Type wins');
  check(fd.decodeBody(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('<a>ü</a>')]), '') === '<a>ü</a>', 'UTF-8 BOM removed');
  check(fd.retryAfterMs('120') === 120000 && fd.retryAfterMs('x') === null && fd.retryAfterMs(new Date(Date.now() + 60000).toUTCString()) > 50000, 'Retry-After in seconds or as an HTTP date');
  const i18n = JSON.parse(fs.readFileSync(path.join(ROOT, 'renderer/apps/feeds/i18n.json'), 'utf8'));
  const keys = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? keys(v, `${p}${k}.`) : [`${p}${k}`])).sort();
  check(JSON.stringify(keys(i18n.en)) === JSON.stringify(keys(i18n.fr)), 'every string exists in English and French');
  const man = JSON.parse(fs.readFileSync(path.join(ROOT, 'renderer/apps/feeds/manifest.json'), 'utf8'));
  check(man.id === 'feeds' && man.name.en === 'Podcasts & News' && man.name.fr === 'Podcasts et actus' && man.category === 'internet' && fs.existsSync(path.join(ROOT, 'renderer/apps/feeds/icon.svg')), 'manifest (Podcasts & News / Podcasts et actus, internet) and icon');
  const css = fs.readFileSync(path.join(ROOT, 'renderer/apps/feeds/style.css'), 'utf8');
  const bad = css.split('\n').filter((l) => /#[0-9a-f]{3,8}\b/i.test(l) || (/^[^\s@:}/*][^{]*\{/.test(l) && !/^\.app-feeds|^:root\[data-[a-z]+="[a-z]+"\] \.app-feeds|^@|^\s*(from|to)\b/.test(l)));
  check(!bad.length, 'style.css: tokens only (no hex colours), every rule scoped under .app-feeds', bad.slice(0, 3).join(' | '));
}

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-home-feeds-'));
const ENV = { AURORA_FEEDS_ITUNES_URL: `${BASE}/itunes`, AURORA_FEEDS_MAX_BYTES: String(2 * 1024 * 1024), AURORA_FEEDS_TIMEOUT: '8000' };
const MUTE = ['--mute-audio'];
let s = null;
const consoleErrors = (sh) => sh.logs.filter((l) => /^\[(error|pageerror)\]/.test(l) && !/favicon|ERR_FILE_NOT_FOUND|Autofill|net::ERR_ABORTED/.test(l));
const inv = (sh, ch, ...a) => sh.page.evaluate(([c, args]) => window.__aurora.api.invoke(c, ...args).then((v) => ({ v }), (e) => ({ err: e.code || e.message, message: e.message })), [ch, a]);
const T = (sh, sel) => sh.page.evaluate((q) => document.querySelector(q)?.textContent ?? null, sel);
const ALL = (sh, sel) => sh.page.evaluate((q) => [...document.querySelectorAll(q)].map((e) => e.textContent), sel);
const has = (sh, sel) => sh.page.evaluate((q) => !!document.querySelector(q), sel);
const st = (sh) =>
  sh.page.evaluate(() => {
    const a = document.querySelector('.win.app-feeds')?.__feeds;
    if (!a) return null;
    const c = a.store.counts();
    return {
      feeds: a.store.feeds.map((f) => ({ id: f.id, url: f.url, title: f.title, podcast: f.podcast, error: f.error, folder: f.folder, showImages: f.showImages, imagePath: f.imagePath, lastStatus: f.lastStatus, retryAt: f.retryAt, etag: f.etag })),
      counts: { unread: c.unread, starred: c.starred, podcasts: c.podcasts, downloads: c.downloads, perFeed: Object.fromEntries(c.perFeed) },
      view: a.view,
      sel: a.sel,
      rows: a.rows.map((r) => ({ key: r.key, title: r.item.title, read: r.item.read, starred: r.item.starred, played: r.item.played, pos: r.item.pos, dl: r.item.dl, duration: r.item.duration })),
      dls: [...a.dls.keys()],
      player: { key: a.player.key, paused: a.player.paused, time: a.player.currentTime, duration: a.player.duration, rate: a.player.rate, el: a.player.el.playbackRate, sleep: a.player.sleepLeft },
      refreshing: !!a.refreshing,
    };
  });
const navCount = (sh, sel) => sh.page.evaluate((q) => document.querySelector(q)?.querySelector('.fd-count')?.textContent || '0', `${W} ${sel}`);
async function idle(sh) {
  await waitFor(async () => !(await st(sh))?.refreshing, 15000);
}
async function clickMenu(sh, label) {
  await waitFor(() => sh.page.evaluate((l) => [...document.querySelectorAll('.menu .menu-item')].some((m) => m.textContent.includes(l)), label), 3000);
  return sh.page.evaluate((l) => {
    const m = [...document.querySelectorAll('.menu .menu-item')].find((x) => x.textContent.includes(l));
    m?.click();
    return !!m;
  }, label);
}
async function addDialog(sh) {
  await sh.page.click(`${W} .fd-nav .fd-add`);
  await waitFor(() => has(sh, `${W} .fd-add-dialog .fd-add-url`), 4000);
}
async function closeDialog(sh) {
  await sh.page.keyboard.press('Escape');
  await waitFor(async () => !(await has(sh, `${W} .fd-add-dialog`)), 3000);
}
async function subscribeUrl(sh, url) {
  await addDialog(sh);
  await sh.page.fill(`${W} .fd-add-url`, url);
  await sh.page.press(`${W} .fd-add-url`, 'Enter');
}
async function openRow(sh, title) {
  const ok = await sh.page.evaluate(([q, t]) => {
    const r = [...document.querySelectorAll(q)].find((x) => x.querySelector('.fd-row-title')?.textContent === t);
    r?.click();
    return !!r;
  }, [`${W} .fd-row`, title]);
  if (ok) await waitFor(async () => (await T(sh, `${W} .fd-read-title`)) === title, 4000);
  return ok;
}
async function frameDoc(sh) {
  return sh.page.evaluate((q) => {
    const f = document.querySelector(q);
    return f ? { srcdoc: f.getAttribute('srcdoc') || f.srcdoc, sandbox: f.getAttribute('sandbox') } : null;
  }, `${W} .fd-frame`);
}

try {
  // ================================================================== renderer units
  s = await launchShell({ home: HOME, open: ['feeds'], lang: 'en', theme: 'light', env: ENV, args: MUTE });
  const fixtures = Object.fromEntries(['news.rss', 'atom.xml', 'rdf.xml', 'podcast.xml', 'hostile.rss', 'broken.xml', 'site.html', 'blog.html'].map((n) => [n, fixture(n).replace('{{EXTRA}}', '')]));
  console.log('\n# Unit (renderer): dates, durations, feeds, autodiscovery, OPML, sanitiser');
  const U = await s.page.evaluate(async ([fx, base]) => {
    const P = await import('app://shell/apps/feeds/lib/parse.js');
    const S = await import('app://shell/apps/feeds/lib/sanitize.js');
    const out = {};
    const D = (x) => P.parseDate(x);
    out.dates = {
      rfc822: D('Tue, 13 Oct 2026 08:30:00 +0200') === Date.UTC(2026, 9, 13, 6, 30),
      gmt: D('Mon, 12 Oct 2026 18:00:00 GMT') === Date.UTC(2026, 9, 12, 18),
      est: D('Sun, 11 Oct 2026 09:15:00 EST') === Date.UTC(2026, 9, 11, 14, 15),
      shortYear: D('13 Oct 26 14:05 +0000') === Date.UTC(2026, 9, 13, 14, 5),
      noSeconds: D('Tue, 3 Oct 2026 9:05 PDT') === Date.UTC(2026, 9, 3, 16, 5),
      iso: D('2026-10-10T07:00:00+02:00') === Date.UTC(2026, 9, 10, 5),
      isoZ: D('2026-10-10T07:00:00.123Z') === Date.UTC(2026, 9, 10, 7),
      isoSpace: D('2026-10-10 07:00') === Date.UTC(2026, 9, 10, 7),
      dateOnly: D('2026-10-10') === Date.UTC(2026, 9, 10),
      compact: D('20261010T070000Z') === Date.UTC(2026, 9, 10, 7),
      french: D('mar., 13 oct. 2026 08:30:00 +0200') === Date.UTC(2026, 9, 13, 6, 30),
      frenchLong: D('mardi 13 octobre 2026') === Date.UTC(2026, 9, 13),
      frenchAccent: D('1er février 2026 10:00 +0100') === Date.UTC(2026, 1, 1, 9),
      english: D('Tuesday, October 13, 2026 2:05 PM EST') === Date.UTC(2026, 9, 13, 19, 5),
      zoneName: D('Tue, 13 Oct 2026 08:30:00 +0200 (CEST)') === Date.UTC(2026, 9, 13, 6, 30),
      cest: D('Tue, 13 Oct 2026 08:30:00 CEST') === Date.UTC(2026, 9, 13, 6, 30),
      unix: D('1791800000') === 1791800000000,
      bad: D('not a date') === null && D('') === null,
    };
    out.durations = [P.parseDuration('1:02:03'), P.parseDuration('62:03'), P.parseDuration('3723'), P.parseDuration('3723.4'), P.parseDuration('1h 2m 3s'), P.parseDuration('PT1H2M3S'), P.parseDuration('45 min'), P.parseDuration('00:00:05'), P.parseDuration('x'), P.parseDuration('')];
    const news = P.parseFeed(fx['news.rss'], `${base}/news.rss`);
    out.news = { format: news.format, title: news.title, site: news.siteUrl, image: news.image, ttl: news.ttl, n: news.items.length, podcast: news.podcast, titles: news.items.map((i) => i.title), link0: news.items[0].link, guid1: news.items[1].guid, desc: news.description, html0: news.items[0].html.includes('texte complet'), author0: news.items[0].author, summary1: news.items[1].summary, date3: news.items[3].date === Date.UTC(2026, 9, 10, 5) };
    const atom = P.parseFeed(fx['atom.xml'], `${base}/atom.xml`);
    out.atom = { format: atom.format, title: atom.title, site: atom.siteUrl, image: atom.image, author: atom.author, titles: atom.items.map((i) => i.title), links: atom.items.map((i) => i.link), html: atom.items.map((i) => i.html), date0: atom.items[0].date === Date.UTC(2026, 9, 12, 9), authorItem: atom.items[0].author };
    const rdf = P.parseFeed(fx['rdf.xml'], `${base}/rdf.xml`);
    out.rdf = { format: rdf.format, title: rdf.title, n: rdf.items.length, t0: rdf.items[0].title, d0: rdf.items[0].date === Date.UTC(2026, 9, 8, 6), a0: rdf.items[0].author };
    const pod = P.parseFeed(fx['podcast.xml'], `${base}/podcast.xml`);
    out.pod = { podcast: pod.podcast, image: pod.image, author: pod.author, items: pod.items.map((i) => ({ t: i.title, enc: i.enclosure, d: i.duration, ep: i.episode, se: i.season, ch: i.chapters, ic: i.inlineChapters, img: i.image })) };
    const json = P.parseFeed(JSON.stringify({ version: 'https://jsonfeed.org/version/1.1', title: 'JSON', home_page_url: 'https://j.example/', items: [{ id: '1', url: '/a', title: 'Un', content_html: '<p>x</p>', date_published: '2026-10-01T00:00:00Z', attachments: [{ url: '/e.mp3', mime_type: 'audio/mpeg', duration_in_seconds: 60 }] }] }), 'https://j.example/feed.json');
    out.json = { format: json.format, link: json.items[0].link, enc: json.items[0].enclosure?.url, dur: json.items[0].duration };
    const err = (fn) => {
      try {
        fn();
        return null;
      } catch (e) {
        return e.code;
      }
    };
    out.broken = err(() => P.parseFeed(fx['broken.xml'], base));
    out.html = err(() => P.parseFeed(fx['site.html'], base));
    out.lenient = (() => {
      try {
        const f = P.parseFeed('<rss version="2.0"><channel><title>Lâche</title><item><title>A & B <i>x</i></title><link>http://l.example/1</link><enclosure url="http://l.example/a.mp3" type="audio/mpeg" length="3"/></item><item><title>Deux</title></item></channel></rss>', 'http://l.example/');
        return { title: f.title, n: f.items.length, t0: f.items[0].title, link: f.items[0].link, enc: f.items[0].enclosure?.url };
      } catch (e) {
        return e.code;
      }
    })();
    out.discover = P.discover(fx['site.html'], `${base}/site.html`);
    out.guess = P.guessFeedLinks(fx['blog.html'], `${base}/blog.html`);
    out.common = P.commonFeedPaths(`${base}/x/page.html`);
    const opml = P.buildOpml([{ url: 'https://a.example/feed', title: 'A & co', siteUrl: 'https://a.example/', folder: '' }, { url: 'https://b.example/rss', title: 'B "quoted"', folder: 'Tech' }], 'Mes flux');
    const back = P.parseOpml(opml);
    out.opml = { text: opml, back, nested: P.parseOpml('<opml version="1.0"><body><outline text="Actus"><outline text="Monde"><outline type="rss" text="M" xmlUrl="https://m.example/rss"/></outline></outline></body></opml>'), bad: err(() => P.parseOpml('<html></html>')) };
    out.chapters = P.parseChapters(fx.chapters || '{"chapters":[{"startTime":3,"title":"B"},{"startTime":0,"title":"A"},{"startTime":1,"title":"no","toc":false}]}');
    // sanitiser
    const hostile = P.parseFeed(fx['hostile.rss'], `${base}/hostile.rss`).items[0].html;
    const blocked = S.buildArticle({ html: hostile, base: `${base}/hostile/piege`, allowImages: false, colors: {}, lang: 'fr' });
    const allowed = S.buildArticle({ html: hostile, base: `${base}/hostile/piege`, allowImages: true, colors: {}, lang: 'fr' });
    const rel = S.buildArticle({ html: news.items[0].html, base: news.items[0].link, allowImages: false });
    out.sanitize = { blocked: blocked.srcdoc, allowed: allowed.srcdoc, remote: blocked.remote, relSrcdoc: rel.srcdoc, empty: S.buildArticle({ html: '', empty: 'Rien.' }).srcdoc };
    return out;
  }, [{ ...fixtures, chapters: null }, BASE]);
  const allDates = Object.entries(U.dates).filter(([, v]) => !v).map(([k]) => k);
  check(!allDates.length, `dates in every common format (${Object.keys(U.dates).length} cases)`, `wrong: ${allDates.join(', ')}`);
  check(JSON.stringify(U.durations) === JSON.stringify([3723, 3723, 3723, 3723, 3723, 3723, 2700, 5, null, null]), `durations (${JSON.stringify(U.durations)})`);
  check(U.news.format === 'rss' && U.news.title === 'Le Quotidien du Test' && U.news.n === 4 && U.news.ttl === 30 && !U.news.podcast, 'RSS 2.0: channel title, 4 items, ttl, not a podcast');
  check(U.news.titles[1] === 'Deuxième nouvelle en été' && U.news.desc === 'Toutes les nouvelles du banc déessai', `HTML entities undefined in XML are repaired (${U.news.titles[1]})`);
  check(U.news.link0 === `${BASE}/news/premiere` && U.news.image === `${BASE}/img/news-logo.png` && U.news.site === `${BASE}/news/`, 'relative links and image resolved against the feed');
  check(U.news.html0 && U.news.author0 === 'Camille Martin' && U.news.summary1 === 'Une description en HTML échappé.' && U.news.guid1 === 'news-2' && U.news.date3, 'content:encoded, dc:creator, escaped HTML description, guid, dc:date');
  check(U.atom.format === 'atom' && U.atom.title === 'Carnet Atom' && U.atom.site === `${BASE}/blog/` && U.atom.image === `${BASE}/img/news-logo.png` && U.atom.author === 'Alix Dupont', 'Atom: title, alternate link, logo, author');
  check(JSON.stringify(U.atom.titles) === JSON.stringify(['Billet HTML', 'Billet XHTML', 'Billet texte']), `Atom titles (html type decoded) ${JSON.stringify(U.atom.titles)}`);
  check(JSON.stringify(U.atom.links) === JSON.stringify([`${BASE}/blog/billet-html`, `${BASE}/autre/billet-xhtml`, `${BASE}/blog/billet-texte`]), 'Atom links resolved with xml:base (feed and entry level)');
  check(U.atom.html[0].includes('<a href="suite">') && /<p[^>]*>Du <b[^>]*>XHTML<\/b> en ligne\.<\/p>/.test(U.atom.html[1]) && U.atom.html[2] === 'Du texte &lt;pas du HTML&gt;', 'Atom content: html, xhtml and text', JSON.stringify(U.atom.html));
  check(U.atom.date0 && U.atom.authorItem === 'Alix Dupont', 'Atom published date, feed author inherited');
  check(U.rdf.format === 'rdf' && U.rdf.title === "Gazette RDF à l'ancienne" && U.rdf.n === 2 && U.rdf.t0 === 'Été indien' && U.rdf.d0 && U.rdf.a0 === 'Rédaction', 'RSS 1.0 / RDF (items next to the channel, dc:date, dc:creator)');
  const p0 = U.pod.items[2];
  check(U.pod.podcast && U.pod.image === `${BASE}/img/cover.png` && U.pod.author === "Studio Banc d'essai", 'podcast: itunes:image, itunes:author');
  check(p0.enc?.url === `${BASE}/audio/ep1.${ep1.ext}` && p0.enc.type === ep1.type && p0.enc.length === ep1.buf.length && p0.d === 6 && p0.ep === 1 && p0.se === 1 && p0.ch === `${BASE}/chapters.json` && p0.img === `${BASE}/img/ep1.png`, 'episode: enclosure, duration, episode, season, podcast:chapters, episode image', JSON.stringify(p0));
  check(U.pod.items[1].d === 5 && JSON.stringify(U.pod.items[1].ic) === JSON.stringify([{ start: 0, title: 'Ouverture' }, { start: 3, title: 'Conclusion' }]) && U.pod.items[0].d === 125, 'Podlove simple chapters, HH:MM:SS and M:SS durations');
  check(U.json.format === 'json' && U.json.link === 'https://j.example/a' && U.json.enc === 'https://j.example/e.mp3' && U.json.dur === 60, 'JSON Feed 1.1 with an attachment');
  check(U.broken === 'EPARSE' && U.html === 'ENOTFEED', `broken feed → EPARSE, web page → ENOTFEED (${U.broken}, ${U.html})`);
  check(U.lenient?.title === 'Lâche' && U.lenient.n === 2 && U.lenient.t0 === 'A & B x' && U.lenient.link === 'http://l.example/1' && U.lenient.enc === 'http://l.example/a.mp3', 'not well-formed feed read leniently (bare &, self-closing enclosure, <link>)', JSON.stringify(U.lenient));
  check(U.discover.length === 2 && U.discover[0].url === `${BASE}/atom.xml` && U.discover[0].title === 'Carnet Atom' && U.discover[1].url === `${BASE}/comments.rss`, 'autodiscovery: <link rel="alternate">, relative href, comments feed last', JSON.stringify(U.discover));
  check(JSON.stringify(U.guess) === JSON.stringify([`${BASE}/rdf.xml`]) && U.common[0] === `${BASE}/feed` && U.common.includes(`${BASE}/atom.xml`), 'feed-looking links and the usual addresses');
  check(U.opml.back.length === 2 && U.opml.back[0].url === 'https://b.example/rss' && U.opml.back[0].folder === 'Tech' && U.opml.back[0].title === 'B "quoted"' && U.opml.back[1].title === 'A & co' && U.opml.back[1].siteUrl === 'https://a.example/' && /<outline text="Tech"/.test(U.opml.text), 'OPML build → parse round trip (folders, escaping)');
  check(U.opml.nested[0]?.folder === 'Actus / Monde' && U.opml.bad === 'EPARSE', 'OPML nested folders; not OPML → EPARSE');
  check(JSON.stringify(U.chapters.map((c) => c.title)) === '["A","B"]', 'JSON chapters sorted, toc:false hidden');
  const B = U.sanitize.blocked;
  const bodyOf = (sd) => sd.slice(sd.indexOf('<body>'));
  check(!/<script|onerror|onclick|onload|javascript:|<iframe|<form|<input|<button|<object|<svg|<base href|http-equiv="refresh"|<link /i.test(bodyOf(B)), 'sanitiser: no script, handler, javascript: URL, frame, form, object, svg, base, meta refresh, link');
  check(!B.includes('tracker.png') && !B.includes('bg.png') && !B.includes('pixel.png') && U.sanitize.remote === 2 && /Image distante/.test(B), 'remote images out of the markup until allowed (placeholder with the alt text; tracking pixel dropped)');
  check(/img-src data:;/.test(B) && /default-src 'none'/.test(B) && /<base target="_blank">/.test(B) && B.includes('href="https://example.org/ok"') && B.includes(`class="sl-embed"><a href="${BASE}/frame"`), 'own CSP (no remote images), links open in a new window, the safe link is kept, the frame becomes a link');
  check(U.sanitize.allowed.includes(`src="${BASE}/tracker.png"`) && /img-src data: https: http:/.test(U.sanitize.allowed) && !U.sanitize.allowed.includes('pixel.png'), 'with « Show images »: the remote image and a CSP that allows it');
  check(U.sanitize.relSrcdoc.includes(`href="${BASE}/news/lien-relatif"`) && !U.sanitize.relSrcdoc.includes('photo1.png'), 'relative links resolved against the article');
  check(U.sanitize.empty.includes('Rien.'), 'empty content: a message instead of a blank page');

  // ================================================================== backend over HTTP
  console.log('\n# Backend: fetch (redirects, 304, gzip, charsets, caps), search, images');
  {
    const r = await inv(s, 'feeds:fetch', `${BASE}/news.rss`);
    check(r.v?.status === 200 && r.v.etag === '"news-v1"' && r.v.text.includes('Le Quotidien du Test') && /application\/rss\+xml/.test(r.v.contentType), 'feeds:fetch → 200 with text, ETag, Content-Type');
    const ua = lastReq('/news.rss').headers['user-agent'];
    check(/^SeleneOS-Feeds\/[\d.]+ \(Podcasts & News; Linux\)$/.test(ua), `User-Agent "${ua}"`);
    const c = await inv(s, 'feeds:fetch', `${BASE}/news.rss`, { etag: '"news-v1"' });
    check(c.v?.status === 304 && lastReq('/news.rss').headers['if-none-match'] === '"news-v1"' && c.v.etag === '"news-v1"', 'If-None-Match → 304');
    const a = await inv(s, 'feeds:fetch', `${BASE}/atom.xml`, { lastModified: 'Mon, 12 Oct 2026 10:00:00 GMT' });
    check(a.v?.status === 304 && lastReq('/atom.xml').headers['if-modified-since'] === 'Mon, 12 Oct 2026 10:00:00 GMT', 'If-Modified-Since → 304');
    const g = await inv(s, 'feeds:fetch', `${BASE}/atom.xml`);
    check(g.v?.status === 200 && g.v.text.includes('Carnet Atom') && /gzip/.test(lastReq('/atom.xml').headers['accept-encoding']), 'gzip answer decompressed');
    const l = await inv(s, 'feeds:fetch', `${BASE}/rdf.xml`);
    check(l.v?.text.includes('Été indien') && l.v.text.includes("Gazette RDF à l'ancienne"), 'ISO-8859-1 feed decoded');
    const red = await inv(s, 'feeds:fetch', `${BASE}/redirect/4`);
    check(red.v?.status === 200 && red.v.url === `${BASE}/comments.rss` && red.v.permanent === false, `5 redirects followed (${red.v?.url})`);
    const mv = await inv(s, 'feeds:fetch', `${BASE}/moved.rss`);
    check(mv.v?.url === `${BASE}/comments.rss` && mv.v.permanent === true, '301 → permanent: true');
    const loop = await inv(s, 'feeds:fetch', `${BASE}/loop/0`);
    check(loop.err === 'ETOOMANYREDIRECTS' && hits('/loop/5') === 1 && hits('/loop/6') === 0, `more than 5 redirects → ETOOMANYREDIRECTS (${loop.err})`);
    const big = await inv(s, 'feeds:fetch', `${BASE}/huge.xml`);
    check(big.err === 'ETOOBIG', `size cap (${big.err})`);
    const nf = await inv(s, 'feeds:fetch', `${BASE}/nothing.xml`);
    check(nf.v?.status === 404 && nf.v.error === 'EHTTP' && nf.v.retryAfter === null, '404 → { status: 404, error: EHTTP }');
    flaky = true;
    const busy = await inv(s, 'feeds:fetch', `${BASE}/flaky.rss`);
    flaky = false;
    check(busy.v?.status === 503 && busy.v.retryAfter === 120000, '503 + Retry-After: 120 → retryAfter 120000 ms');
    const bad = await Promise.all(['ftp://x/feed', 'file:///etc/passwd', 'javascript:alert(1)', '', 'http://'].map((u) => inv(s, 'feeds:fetch', u)));
    check(bad.every((x) => x.err === 'EINVAL'), `only http(s) addresses (${bad.map((x) => x.err).join(',')})`);
    const off = await inv(s, 'feeds:fetch', 'http://127.0.0.1:9/feed.xml');
    check(off.err === 'EOFFLINE', `connection refused → EOFFLINE (${off.err})`);
    const sr = await inv(s, 'feeds:search', 'test', { country: 'fr' });
    const q = lastReq('/itunes/search');
    const qs = new URLSearchParams(q?.search || '');
    check(qs.get('media') === 'podcast' && qs.get('term') === 'test' && qs.get('country') === 'fr' && qs.get('entity') === 'podcast', `iTunes Search query (${q?.search})`);
    check(sr.v?.length === 2 && sr.v[0].title === 'Podcast de Test' && sr.v[0].feedUrl === `${BASE}/podcast.xml` && sr.v[0].artwork === `${BASE}/img/cover.png` && sr.v[0].episodes === 3 && sr.v[0].genre === 'Technologie', 'search results (the one without a feed is left out)');
    const im = await inv(s, 'feeds:image', `${BASE}/img/cover.png`);
    const im2 = await inv(s, 'feeds:image', `${BASE}/img/cover.png`);
    check(im.v?.path?.startsWith(path.join(HOME, '.cache', 'aurora', 'feeds', 'images')) && im.v.path.endsWith('.png') && fs.existsSync(im.v.path) && im2.v.cached === true && hits('/img/cover.png') === 1, 'cover art cached on disk once (media:// for the renderer)');
    const notImg = await inv(s, 'feeds:image', `${BASE}/news.rss`);
    check(notImg.err === 'EBADDATA', 'a non-image is refused as cover art');
    const del = await Promise.all(['/etc/passwd', path.join(HOME, '.bashrc'), path.join(HOME, 'Music', 'x.mp3'), 'relative.mp3'].map((p) => inv(s, 'feeds:deleteFile', p)));
    check(del.every((x) => x.err === 'EINVAL'), 'feeds:deleteFile refuses anything outside Music/Podcasts');
    const hop = await inv(s, 'feeds:download', 'hoptest', `${BASE}/dlhop/7`, { podcast: '../Évasion/..', title: 'Test: un/deux?', type: 'audio/wav' });
    const hopFile = path.join(HOME, 'Music', 'Podcasts', 'Évasion', 'Test un deux.wav');
    check(hop.v?.path === hopFile && fs.statSync(hopFile).size === EP2.length && hop.v.size === EP2.length, `download: 7 redirects (statistics prefixes) followed, safe folder and file names (${hop.v?.path || hop.err})`);
    const delOk = await inv(s, 'feeds:deleteFile', hopFile);
    check(delOk.v === true && !fs.existsSync(hopFile) && !fs.existsSync(path.dirname(hopFile)), 'feeds:deleteFile removes the episode and its now empty podcast folder');
    const tooMany = await inv(s, 'feeds:download', 'hoptest2', `${BASE}/dlhop/11`, { podcast: 'X', title: 'Y' });
    check(tooMany.err === 'ETOOMANYREDIRECTS' && !fs.existsSync(path.join(HOME, 'Music', 'Podcasts', 'X')), `more than 10 redirects refused (${tooMany.err})`);
    const dirs = await inv(s, 'feeds:dirs');
    check(dirs.v?.podcasts === path.join(HOME, 'Music', 'Podcasts'), `podcasts folder ${dirs.v?.podcasts}`);
  }

  // ================================================================== UI: subscribe
  console.log('\n# Shell (English, light): subscribe by address, website, search');
  check(await waitFor(() => has(s, `${W} .fd-list-empty .fd-empty-title`)), 'welcome state');
  check((await T(s, `${W} .fd-list-empty .fd-empty-title`)) === 'Welcome to Podcasts & News', 'welcome title');
  await subscribeUrl(s, `${BASE}/news.rss`);
  check(!!(await waitFor(async () => !(await has(s, `${W} .fd-add-dialog`)) && (await st(s))?.feeds.length === 1, 8000)), 'subscribed by address: the dialog closes');
  let S0 = await st(s);
  check(S0.feeds[0].title === 'Le Quotidien du Test' && S0.view.type === 'feed' && S0.rows.length === 4 && S0.counts.unread === 4, `news feed: 4 unread items, its view selected (${S0.rows.length}, ${S0.counts.unread})`);
  check(JSON.stringify(S0.rows.map((r) => r.title)) === JSON.stringify(['Première nouvelle', 'Deuxième nouvelle en été', 'Troisième nouvelle', 'Quatrième nouvelle']), 'newest first');
  check((await navCount(s, '.fd-view[data-view="all"]')) === '4' && (await navCount(s, `.fd-sub[data-feed="${S0.feeds[0].id}"]`)) === '4', 'unread counts in the subscriptions pane');
  check(!!(await waitFor(async () => (await st(s)).feeds[0].imagePath && has(s, `${W} .fd-sub img.fd-art`))), 'feed logo downloaded and shown through media://');
  // already subscribed
  await subscribeUrl(s, `${BASE}/news.rss`);
  check(!!(await waitFor(async () => /already subscribed/.test((await T(s, `${W} .fd-add-status`)) || ''))), 'same address again: "already subscribed"');
  // website with two feeds: choose
  await s.page.fill(`${W} .fd-add-url`, `${BASE}/site.html`);
  await s.page.press(`${W} .fd-add-url`, 'Enter');
  check(!!(await waitFor(() => has(s, `${W} .fd-choice`))), 'website with two feeds: a choice');
  const choices = await ALL(s, `${W} .fd-choice-title`);
  check(JSON.stringify(choices) === JSON.stringify(['Carnet Atom', 'Commentaires du carnet']) && (await s.page.evaluate((q) => document.querySelector(q).checked, `${W} .fd-choice input`)), `main feed first and preselected (${choices})`);
  await s.page.click(`${W} .fd-choice-go`);
  check(!!(await waitFor(async () => (await st(s)).feeds.some((f) => f.title === 'Carnet Atom') && !(await has(s, `${W} .fd-add-dialog`)), 8000)), 'subscribed to the chosen feed (Atom)');
  // a page whose only feed is a link
  await subscribeUrl(s, `${BASE.replace('http://', 'http://')}/blog.html`);
  check(!!(await waitFor(async () => (await st(s)).feeds.some((f) => f.title === "Gazette RDF à l'ancienne"), 8000)), 'page without <link rel="alternate">: the feed-looking link is used (RDF)');
  await idle(s);
  // a site with no feed at all
  await subscribeUrl(s, BARE);
  check(!!(await waitFor(async () => /No feed was found/i.test((await T(s, `${W} .fd-add-status`)) || ''), 10000)), 'a site with no feed: "No feed was found at this address."');
  // broken feed
  await s.page.fill(`${W} .fd-add-url`, `${BASE}/broken.xml`);
  await s.page.press(`${W} .fd-add-url`, 'Enter');
  check(!!(await waitFor(async () => (await T(s, `${W} .fd-add-status`)) === 'This feed cannot be read.')), 'broken feed: "This feed cannot be read."');
  await s.page.fill(`${W} .fd-add-url`, 'not an address at all');
  await s.page.press(`${W} .fd-add-url`, 'Enter');
  check(!!(await waitFor(async () => (await T(s, `${W} .fd-add-status`)) === 'This address is not valid.')), 'invalid address refused');
  // podcast search
  await s.page.click(`${W} .fd-add-tab[data-tab="search"]`);
  check(await waitFor(() => s.page.evaluate((q) => document.activeElement === document.querySelector(q), `${W} .fd-search-input`), 2000), 'search tab focuses the search box');
  await s.page.fill(`${W} .fd-search-input`, 'test');
  await s.page.press(`${W} .fd-search-input`, 'Enter');
  check(!!(await waitFor(async () => (await ALL(s, `${W} .fd-result-title`)).length === 2)), 'search results listed');
  check((await waitFor(() => s.page.evaluate((q) => document.querySelectorAll(q).length === 2, `${W} .fd-result img.fd-art`), 6000)) && new URLSearchParams(lastReq('/itunes/search').search).get('country') === 'us', 'covers shown; English asks the US directory');
  await s.page.click(`${W} .fd-result[data-feed="${BASE}/podcast.xml"] .fd-result-sub`);
  check(!!(await waitFor(async () => (await T(s, `${W} .fd-result[data-feed="${BASE}/podcast.xml"] .fd-result-sub`)) === 'Subscribed', 8000)), 'search: Subscribe → Subscribed');
  await s.shot('feeds-search-en-light');
  await closeDialog(s);
  S0 = await st(s);
  const POD = S0.feeds.find((f) => f.title === 'Podcast de Test');
  const NEWS = S0.feeds.find((f) => f.title === 'Le Quotidien du Test');
  const ATOM = S0.feeds.find((f) => f.title === 'Carnet Atom');
  const RDF = S0.feeds.find((f) => f.title === "Gazette RDF à l'ancienne");
  check(POD?.podcast && S0.view.type === 'feed' && S0.view.id === POD.id && S0.rows.length === 3, 'podcast subscribed and shown');
  check(S0.counts.perFeed[POD.id] === 3 && S0.counts.podcasts === 3, `a new podcast: its newest 3 episodes are new (${S0.counts.perFeed[POD.id]})`);
  check(S0.counts.unread === 4 + 3 + 2 + 3 && (await navCount(s, '.fd-view[data-view="unread"]')) === String(4 + 3 + 2 + 3), `total unread ${S0.counts.unread}`);

  // ================================================================== UI: lists, read state, star
  console.log('\n# Lists, unread counts, star, keyboard');
  await s.page.click(`${W} .fd-view[data-view="all"]`);
  S0 = await st(s);
  check(S0.rows.length === 12 && S0.rows[0].title === 'Épisode 3 : le long', `"All": every item, newest first (${S0.rows.length})`);
  await s.page.click(`${W} .fd-sub[data-feed="${NEWS.id}"]`);
  await openRow(s, 'Première nouvelle');
  S0 = await st(s);
  check(S0.rows.find((r) => r.title === 'Première nouvelle').read && S0.counts.perFeed[NEWS.id] === 3 && (await navCount(s, `.fd-sub[data-feed="${NEWS.id}"]`)) === '3', 'opening an article marks it read (count 4 → 3)');
  check((await T(s, `${W} .fd-read-meta`)).startsWith('by Camille Martin · Tuesday, October 13, 2026') && (await T(s, `${W} .fd-read-source .ellipsis`)) === 'Le Quotidien du Test', `reader: source, author and date (${await T(s, `${W} .fd-read-meta`)})`);
  await s.page.keyboard.press('m');
  check(!!(await waitFor(async () => !(await st(s)).rows.find((r) => r.title === 'Première nouvelle').read)), 'M marks it unread again');
  await s.page.keyboard.press('s');
  check(!!(await waitFor(async () => (await st(s)).counts.starred === 1)) && (await navCount(s, '.fd-view[data-view="starred"]')) === '1', 'S stars it (Starred: 1)');
  await s.page.keyboard.press('j');
  check(!!(await waitFor(async () => (await T(s, `${W} .fd-read-title`)) === 'Deuxième nouvelle en été')), 'J opens the next item');
  await s.page.keyboard.press('k');
  check(!!(await waitFor(async () => (await T(s, `${W} .fd-read-title`)) === 'Première nouvelle')), 'K goes back');
  await s.page.focus(`${W} .fd-row.selected`);
  await s.page.keyboard.press('ArrowDown');
  check(!!(await waitFor(async () => (await T(s, `${W} .fd-read-title`)) === 'Deuxième nouvelle en été' && s.page.evaluate((q) => document.activeElement?.matches(q), `${W} .fd-row.selected`))), 'arrow keys move through the list (focus follows)');
  await s.page.click(`${W} .fd-view[data-view="unread"]`);
  S0 = await st(s);
  check(S0.rows.every((r) => !r.read) && S0.rows.length === S0.counts.unread, `"Unread" lists only unread items (${S0.rows.length})`);
  const firstUnread = S0.rows[0].title;
  await openRow(s, firstUnread);
  check((await st(s)).rows.some((r) => r.title === firstUnread), 'an item read from "Unread" stays in the list until the view changes');
  await s.page.click(`${W} .fd-view[data-view="starred"]`);
  check(JSON.stringify((await st(s)).rows.map((r) => r.title)) === '["Première nouvelle"]', '"Starred" view');
  await s.page.click(`${W} .fd-sub[data-feed="${ATOM.id}"]`);
  await s.page.click(`${W} .fd-markall`);
  check(!!(await waitFor(async () => (await st(s)).counts.perFeed[ATOM.id] === 0)) && !(await has(s, `${W} .fd-sub[data-feed="${ATOM.id}"] .fd-count`)), 'Mark all as read (count badge gone)');
  // rename from the context menu
  await s.page.click(`${W} .fd-sub[data-feed="${RDF.id}"]`, { button: 'right' });
  await clickMenu(s, 'Rename…');
  await waitFor(() => has(s, `${W} .dialog input.input`), 3000);
  await s.page.fill(`${W} .dialog input.input`, 'Ma gazette');
  await s.page.keyboard.press('Enter');
  check(!!(await waitFor(async () => (await T(s, `${W} .fd-sub[data-feed="${RDF.id}"] .fd-nav-label`)) === 'Ma gazette')), 'Rename… from the context menu');
  // open in Browser (stubbed)
  await s.page.evaluate(() => {
    window.__opened = [];
    window.__aurora.shell.openUrl = (u) => window.__opened.push(u);
  });
  await openRow(s, 'Billet XHTML');
  await s.page.click(`${W} .fd-read-bar [name="browser"]`);
  check(JSON.stringify(await s.page.evaluate(() => window.__opened)) === JSON.stringify([`${BASE}/autre/billet-xhtml`]), '« Open in Browser » opens the article address');

  // ================================================================== UI: sanitisation
  console.log('\n# Reading pane: hostile content, images after « Show images »');
  await subscribeUrl(s, `${BASE}/hostile.rss`);
  await waitFor(async () => (await st(s)).feeds.some((f) => f.title === 'Flux hostile'), 8000);
  const before = reqs.length;
  await openRow(s, 'Article piégé');
  await sleep(1500);
  const fd = await frameDoc(s);
  check(fd?.sandbox === 'allow-popups allow-popups-to-escape-sandbox' && !/allow-scripts|allow-same-origin/.test(fd.sandbox), `iframe sandbox without allow-scripts (${fd?.sandbox})`);
  check(!/<script|onerror|onclick|javascript:/i.test(fd.srcdoc.slice(fd.srcdoc.indexOf('<body>'))) && fd.srcdoc.includes('Bonjour'), 'no script, handler or javascript: link in the document');
  const evil = ['/script-ran', '/onerror-ran', '/onclick-ran', '/js-link', '/svg-ran', '/frame', '/form', '/bg.png', '/style.css', '/meta-refresh', '/object', '/tracker.png', '/pixel.png'];
  const early = reqs.slice(before).filter((r) => evil.includes(r.path) || r.path.startsWith('/evil'));
  check(!early.length, 'nothing ran and nothing remote was requested before « Show images »', early.map((r) => r.path).join(', '));
  check((await s.page.title()) !== 'pwned' && (await has(s, `${W} .fd-images-bar`)) && (await T(s, `${W} .fd-images-bar .grow`)) === 'Images from this feed are not loaded, to protect your privacy.', 'privacy bar shown');
  await s.page.click(`${W} .fd-images-bar [name="show-images"]`);
  check(!!(await waitFor(() => hits('/tracker.png') > 0, 6000)), 'the remote image loads after « Show images »');
  const later = reqs.slice(before).filter((r) => evil.includes(r.path) && r.path !== '/tracker.png');
  check(!later.length && !(await has(s, `${W} .fd-images-bar`)), 'still only the image (no pixel, background or script)', later.map((r) => r.path).join(', '));
  await s.page.frameLocator(`${W} .fd-frame`).locator('a[href="https://example.org/ok"]').click();
  check(!!(await waitFor(() => s.page.evaluate(() => window.__opened.includes('https://example.org/ok')), 4000)), 'a link in the article opens in the Navigateur (pop-up routed by the shell)');
  const HOST = (await st(s)).feeds.find((f) => f.title === 'Flux hostile');
  check(HOST.showImages === true, 'the choice is remembered for this feed');

  // ================================================================== UI: podcast
  console.log('\n# Podcast: download, cancel, play, resume, speed, chapters, played');
  await s.page.click(`${W} .fd-view[data-view="podcasts"]`);
  S0 = await st(s);
  check(S0.rows.length === 3 && S0.rows.every((r) => r.duration), 'Podcasts view: the episodes with durations');
  check(JSON.stringify(await ALL(s, `${W} .fd-row.episode .fd-row-sub`)) === JSON.stringify(['2 min', '5 s', '6 s']), `durations shown in the list (${await ALL(s, `${W} .fd-row.episode .fd-row-sub`)})`);
  await openRow(s, 'Épisode 1 : le début');
  const epMeta = (await T(s, `${W} .fd-read-meta`)) || '';
  check(epMeta.startsWith('Season 1, episode 1 · Monday, October 12, 2026') && epMeta.endsWith(' · 6 s'), `episode meta (${epMeta})`);
  check(!!(await waitFor(async () => (await ALL(s, `${W} .fd-chapter-title`)).join('|') === 'Générique|Le sujet du jour', 6000)), 'chapters loaded from podcast:chapters');
  check(!!(await waitFor(() => has(s, `${W} .fd-ep-cover img.fd-art-lg`), 6000)) && hits('/img/ep1.png') === 1, 'episode artwork');
  const KEY1 = (await st(s)).sel;
  await s.page.click(`${W} .fd-ep-actions [name="download"]`);
  check(!!(await waitFor(async () => (await st(s)).rows.find((r) => r.key === KEY1)?.dl, 10000)), 'episode 1 downloaded');
  let S1 = (await st(s)).rows.find((r) => r.key === KEY1);
  check(S1.dl.path === path.join(HOME, 'Music', 'Podcasts', 'Podcast de Test', `Épisode 1 le début.${ep1.ext}`) && fs.statSync(S1.dl.path).size === ep1.buf.length && S1.dl.size === ep1.buf.length, `saved to Music/Podcasts/<podcast>/ (${S1.dl.path})`);
  check(!!(await waitFor(async () => (await navCount(s, '.fd-view[data-view="downloads"]')) === '1' && has(s, `${W} .fd-ep-actions [name="delete-dl"]`), 3000)), '"Downloaded: 1", the button becomes « Delete download »', `count ${await navCount(s, '.fd-view[data-view="downloads"]')}, actions ${await T(s, `${W} .fd-ep-actions`)}, dls ${(await st(s)).dls}`);
  // cancel
  await openRow(s, 'Épisode 3 : le long');
  const KEY3 = (await st(s)).sel;
  const progress = [];
  await s.page.evaluate(() => {
    window.__prog = [];
    window.__aurora.api.on('feeds:progress', (p) => window.__prog.push(p));
  });
  await s.page.click(`${W} .fd-ep-actions [name="download"]`);
  check(!!(await waitFor(() => s.page.evaluate(() => window.__prog.some((p) => p.state === 'progress' && p.received > 64 * 1024)), 8000)), 'progress events while downloading');
  check(!!(await waitFor(() => has(s, `${W} .fd-ep-dl .progress .bar`), 2000)) && /Downloading… \d+ % of [\d.]+ MB/.test((await T(s, `${W} .fd-ep-dl-text`)) || ''), `progress bar in the episode (${await T(s, `${W} .fd-ep-dl-text`)})`);
  check(/Downloading \d+ %/.test((await T(s, `${W} .fd-row.selected .fd-row-dl`)) || '') && (await navCount(s, '.fd-view[data-view="downloads"]')) === '2', 'progress in the list row and the Downloaded count');
  await s.page.click(`${W} .fd-ep-actions [name="cancel"]`);
  check(!!(await waitFor(async () => !(await st(s)).dls.length && (await has(s, `${W} .fd-ep-actions [name="download"]`)), 6000)), 'Cancel stops the download', `dls ${(await st(s)).dls}, actions ${await T(s, `${W} .fd-ep-actions`)}`);
  progress.push(...(await s.page.evaluate(() => window.__prog)));
  const podDir = path.join(HOME, 'Music', 'Podcasts', 'Podcast de Test');
  check(progress.some((p) => p.state === 'canceled') && !fs.readdirSync(podDir).some((n) => /long/.test(n)), `no partial file left (${fs.readdirSync(podDir).join(', ')})`);
  check(!(await st(s)).rows.find((r) => r.key === KEY3).dl, 'the canceled episode is not marked downloaded');
  // play
  await openRow(s, 'Épisode 1 : le début');
  await s.page.click(`${W} .fd-ep-actions [name="play"]`);
  check(!!(await waitFor(async () => {
    const p = (await st(s)).player;
    return p.key === KEY1 && !p.paused && p.time > 0.3;
  }, 8000)), 'Play: the downloaded episode plays (time advances)');
  check(!(await s.page.evaluate((q) => document.querySelector(q).hidden, `${W} .fd-player`)) && (await T(s, `${W} .fd-pl-title`)) === 'Épisode 1 : le début' && (await T(s, `${W} .fd-pl-sub`)) === 'Podcast de Test', 'mini-player shows the episode');
  const src = await s.page.evaluate((q) => document.querySelector(q).currentSrc, `${W} .fd-audio`);
  check(src.startsWith('media://local/') && src.includes('Podcasts'), `played from the downloaded file (${src.slice(0, 60)}…)`);
  await s.page.click(`${W} .fd-pl-speed`);
  await clickMenu(s, '1.5×');
  check(!!(await waitFor(async () => {
    const p = (await st(s)).player;
    return p.rate === 1.5 && p.el === 1.5;
  })) && (await T(s, `${W} .fd-pl-speed`)) === '1.5×', 'speed 1.5× (menu, audio element, button)');
  check((await s.page.evaluate(() => [...document.querySelectorAll('.menu .menu-item')].length)) === 0, 'menu closed');
  await s.page.evaluate(() => document.querySelector('.win.app-feeds').__feeds.player.pause());
  const t0 = (await st(s)).player.time;
  await s.page.click(`${W} .fd-pl-fwd`);
  const t1 = (await st(s)).player.time;
  await s.page.click(`${W} .fd-pl-back`);
  const t2 = (await st(s)).player.time;
  check(t1 > t0 && t1 >= Math.min(5.7, t0 + 29) && t2 >= 0 && t2 < t1, `+30 s / −15 s (clamped to the episode: ${t0.toFixed(1)} → ${t1.toFixed(1)} → ${t2.toFixed(1)})`);
  await s.page.evaluate(() => document.querySelector('.win.app-feeds').__feeds.player.seek(3.2));
  await s.page.evaluate(() => document.querySelector('.win.app-feeds').__feeds.savePosition(true));
  check(!!(await waitFor(async () => Math.abs(((await st(s)).rows.find((r) => r.key === KEY1)?.pos ?? 0) - 3) <= 1)), 'position saved');
  await s.page.click(`${W} .fd-pl-close`);
  check(!!(await waitFor(() => s.page.evaluate((q) => document.querySelector(q).hidden, `${W} .fd-player`))), 'player closed');
  check(/^Resume at 0:0[2-4]$/.test((await s.page.evaluate((q) => document.querySelector(q)?.textContent, `${W} .fd-ep-actions [name="play"]`)) || ''), `« Resume at … » (${await s.page.evaluate((q) => document.querySelector(q)?.textContent, `${W} .fd-ep-actions [name="play"]`)})`);
  await s.page.click(`${W} .fd-ep-actions [name="play"]`);
  check(!!(await waitFor(async () => {
    const p = (await st(s)).player;
    return p.key === KEY1 && p.time >= 2.5 && !p.paused;
  }, 8000)), `resumes at the saved position (${(await st(s)).player.time.toFixed(1)} s) and keeps the speed (${(await st(s)).player.rate}×)`);
  // chapters seek
  await s.page.evaluate(() => document.querySelector('.win.app-feeds').__feeds.player.pause());
  await s.page.click(`${W} .fd-chapter[data-start="0"]`);
  check(!!(await waitFor(async () => (await st(s)).player.time < 1.5 && !(await st(s)).player.paused, 4000)), 'a chapter seeks there and plays');
  // sleep timer
  await s.page.click(`${W} .fd-pl-sleep`);
  await clickMenu(s, 'In 15 minutes');
  check(!!(await waitFor(async () => /^1[45]:\d\d$/.test((await T(s, `${W} .fd-pl-sleep-left`)) || ''))) && (await st(s)).player.sleep > 890, `sleep timer counts down (${await T(s, `${W} .fd-pl-sleep-left`)})`);
  await s.page.click(`${W} .fd-pl-sleep`);
  await clickMenu(s, 'Turn off the sleep timer');
  check(!!(await waitFor(async () => (await st(s)).player.sleep === null && (await T(s, `${W} .fd-pl-sleep-left`)) === '')), 'sleep timer turned off');
  // ended → played
  await s.page.evaluate(() => {
    const a = document.querySelector('.win.app-feeds').__feeds;
    a.player.seek(a.player.duration - 0.6);
    a.player.play();
  });
  check(!!(await waitFor(async () => (await st(s)).rows.find((r) => r.key === KEY1)?.played, 8000)), 'the end of the episode marks it played');
  check(!!(await waitFor(async () => (await T(s, `${W} .fd-row[data-key="${KEY1}"] .fd-row-played`)) === 'Played')) && (await st(s)).rows.find((r) => r.key === KEY1).pos === 0, 'row says Played, position reset');
  await s.page.click(`${W} .fd-ep-actions [name="played"]`);
  check(!!(await waitFor(async () => !(await st(s)).rows.find((r) => r.key === KEY1)?.played)), '« Mark as not played »');
  await s.page.click(`${W} .fd-ep-actions [name="played"]`);
  check(!!(await waitFor(async () => (await st(s)).rows.find((r) => r.key === KEY1)?.played)), '« Mark as played »');
  // play a non-downloaded episode: downloaded first
  await openRow(s, 'Épisode 2 : le court');
  const KEY2 = (await st(s)).sel;
  await s.page.click(`${W} .fd-row.selected .fd-row-play`);
  check(!!(await waitFor(async () => {
    const x = await st(s);
    return x.player.key === KEY2 && !x.player.paused && x.rows.find((r) => r.key === KEY2)?.dl;
  }, 10000)), 'Play on an episode not downloaded: downloaded first, then played');
  check((await ALL(s, `${W} .fd-chapter-title`)).join('|') === 'Ouverture|Conclusion', 'inline (Podlove) chapters');
  await s.shot('feeds-podcast-en-light');
  await s.page.evaluate(() => document.querySelector('.win.app-feeds').__feeds.player.pause());
  // delete played episodes
  await s.page.click(`${W} .fd-nav .fd-more`);
  await clickMenu(s, 'Delete played episodes');
  check(!!(await waitFor(async () => /1 downloaded episode you have played/.test((await T(s, `${W} .dialog .dialog-body`)) || ''))), 'confirmation names the count and size');
  await s.page.click(`${W} .dialog .dialog-footer .btn`);
  check(!!(await waitFor(async () => !(await st(s)).rows.find((r) => r.key === KEY1)?.dl && !fs.existsSync(S1.dl.path))), '« Delete played episodes » removes the played download only');
  check(!!(await st(s)).rows.find((r) => r.key === KEY2)?.dl, 'the unplayed download stays');

  // ================================================================== refresh
  console.log('\n# Refresh: 304, new items, errors');
  const r0 = reqs.length;
  await s.page.evaluate(() => document.querySelector('.win.app-feeds').__feeds.refreshAll({ manual: true }));
  await idle(s);
  const newsReq = reqs.slice(r0).find((r) => r.path === '/news.rss');
  const atomReq = reqs.slice(r0).find((r) => r.path === '/atom.xml');
  check(newsReq?.headers['if-none-match'] === '"news-v1"' && atomReq?.headers['if-modified-since'] === 'Mon, 12 Oct 2026 10:00:00 GMT', 'refresh sends If-None-Match / If-Modified-Since');
  S0 = await st(s);
  check(S0.feeds.find((f) => f.id === NEWS.id).lastStatus === 304 && S0.feeds.find((f) => f.id === ATOM.id).lastStatus === 304, '304: nothing re-downloaded');
  const unreadBefore = S0.counts.perFeed[NEWS.id];
  newsVersion = 2;
  await s.page.click(`${W} .fd-nav .fd-refresh`);
  await waitFor(async () => (await st(s)).refreshing, 2000);
  await idle(s);
  S0 = await st(s);
  check(S0.counts.perFeed[NEWS.id] === unreadBefore + 1 && S0.feeds.find((f) => f.id === NEWS.id).etag === '"news-v2"', `new item after a change (unread ${unreadBefore} → ${S0.counts.perFeed[NEWS.id]})`, JSON.stringify({ feed: S0.feeds.find((f) => f.id === NEWS.id), reqs: reqs.slice(r0).filter((r) => r.path === '/news.rss').map((r) => r.headers['if-none-match']) }));
  await s.page.click(`${W} .fd-sub[data-feed="${NEWS.id}"]`);
  check((await st(s)).rows[0].title === 'Cinquième nouvelle' && (await st(s)).rows.find((r) => r.title === 'Première nouvelle').starred, 'the new item on top, earlier state kept (star)');
  check(/^Updated at /.test((await T(s, `${W} .fd-status`)) || ''), `status line (${await T(s, `${W} .fd-status`)})`);
  // a feed that starts failing
  await subscribeUrl(s, `${BASE}/flaky.rss`);
  await waitFor(async () => (await st(s)).feeds.some((f) => f.title === 'Flux capricieux'), 8000);
  const FLAKY = (await st(s)).feeds.find((f) => f.title === 'Flux capricieux');
  flaky = true;
  await s.page.evaluate(() => document.querySelector('.win.app-feeds').__feeds.refreshAll({ manual: true }));
  await idle(s);
  const fl = (await st(s)).feeds.find((f) => f.id === FLAKY.id);
  check(fl.error === 'EHTTP' && fl.lastStatus === 503 && fl.retryAt > Date.now() + 100000, 'HTTP 503 + Retry-After: error kept, next automatic try postponed', JSON.stringify(fl));
  check(!!(await waitFor(() => has(s, `${W} .fd-sub[data-feed="${FLAKY.id}"] .fd-nav-error`))) && /server asks to wait until \d/.test((await T(s, `${W} .fd-feed-error`)) || ''), 'warning in the pane and an error bar with Retry in the list');
  const fr0 = hits('/flaky.rss');
  const all0 = reqs.length;
  await s.page.evaluate(() => document.querySelector('.win.app-feeds').__feeds.refreshAll({ reason: 'auto' }));
  await idle(s);
  check(hits('/flaky.rss') === fr0, 'automatic refresh respects Retry-After (no request)');
  check(reqs.length === all0, 'automatic refresh skips feeds fetched less than 25 minutes ago (no request at all)');
  flaky = false;
  await s.page.click(`${W} .fd-feed-error [name="retry"]`);
  check(!!(await waitFor(async () => !(await st(s)).feeds.find((f) => f.id === FLAKY.id).error, 6000)) && !(await has(s, `${W} .fd-feed-error`)), 'Retry clears the error');

  // ================================================================== OPML
  console.log('\n# OPML export / import');
  await s.page.evaluate((id) => document.querySelector('.win.app-feeds').__feeds.store.patchFeed(id, { folder: 'Tech' }), ATOM.id);
  check(!!(await waitFor(() => has(s, `${W} .fd-folder[data-folder="Tech"]`))) && (await has(s, `${W} .fd-sub.nested[data-feed="${ATOM.id}"]`)), 'folders in the subscriptions pane');
  const opmlPath = path.join(HOME, 'Documents', 'feeds.opml');
  await s.page.evaluate((p) => document.querySelector('.win.app-feeds').__feeds.exportOpml(p), opmlPath);
  const opml = fs.readFileSync(opmlPath, 'utf8');
  const outlines = (opml.match(/xmlUrl=/g) || []).length;
  check(opml.includes('text="Ma gazette"'), 'export uses the name chosen by the person');
  check(outlines === (await st(s)).feeds.length && opml.includes(`xmlUrl="${BASE}/podcast.xml"`) && /<outline text="Tech" title="Tech">\s*<outline type="rss" text="Carnet Atom"/.test(opml), `export: ${outlines} subscriptions, folder kept`);
  const nBefore = (await st(s)).feeds.length;
  await s.page.evaluate((id) => {
    const a = document.querySelector('.win.app-feeds').__feeds;
    a.unsubscribe(a.store.feed(id)); // not awaited: it waits for the confirmation
  }, ATOM.id);
  await waitFor(() => has(s, `${W} .dialog .dialog-footer .btn`), 3000);
  check(/will be removed/.test((await T(s, `${W} .dialog .dialog-body`)) || ''), 'unsubscribe asks first');
  await s.page.click(`${W} .dialog .dialog-footer .btn`);
  check(!!(await waitFor(async () => (await st(s)).feeds.length === nBefore - 1)), 'unsubscribed');
  const imported = await s.page.evaluate((p) => document.querySelector('.win.app-feeds').__feeds.importOpml(p), opmlPath);
  await idle(s);
  S0 = await st(s);
  const atomBack = S0.feeds.find((f) => f.url === `${BASE}/atom.xml`);
  check(imported === 1 && S0.feeds.length === nBefore && atomBack?.folder === 'Tech' && atomBack.title === 'Carnet Atom' && S0.counts.perFeed[atomBack.id] === 3, `import: only the missing subscription comes back, in its folder, refreshed (${imported})`);

  // ================================================================== persistence
  console.log('\n# Persistence across a relaunch');
  const keep = await st(s);
  await s.page.evaluate(() => document.querySelector('.win.app-feeds').__feeds.store.flush());
  await s.close();
  s = await launchShell({ home: HOME, open: ['feeds'], lang: 'fr', theme: 'dark', env: ENV, args: MUTE });
  await waitFor(async () => (await st(s))?.feeds.length === keep.feeds.length, 15000);
  await idle(s);
  S0 = await st(s);
  check(S0.feeds.length === keep.feeds.length && S0.counts.starred === 1 && S0.counts.downloads === 1, `subscriptions, star and download kept (${S0.feeds.length}, ${S0.counts.starred}, ${S0.counts.downloads})`);
  check(S0.feeds.find((f) => f.id === HOST.id)?.showImages === true && S0.view.type === keep.view.type, 'per-feed image choice and the last view kept');
  check(!!(await st(s)).feeds.find((f) => f.id === POD.id) && S0.player.rate === 1.5, 'speed kept');

  // ================================================================== French, dark: screenshots and layout
  console.log('\n# Français, sombre : textes, captures, fenêtre étroite');
  await s.page.click(`${W} .fd-view[data-view="all"]`);
  check((await T(s, `${W} .fd-view[data-view="unread"] .fd-nav-label`)) === 'Non lus' && (await T(s, `${W} .fd-view[data-view="downloads"] .fd-nav-label`)) === 'Téléchargés' && (await T(s, `${W} .fd-subs-title`)) === 'Abonnements', 'French labels');
  await s.page.click(`${W} .fd-sub[data-feed="${NEWS.id}"]`);
  await openRow(s, 'Première nouvelle');
  check((await T(s, `${W} .fd-read-meta`)).startsWith('par Camille Martin · Mardi 13 octobre 2026'), `French date (${await T(s, `${W} .fd-read-meta`)})`);
  check(/Afficher les images/.test((await T(s, `${W} .fd-images-bar`)) || ''), '« Afficher les images » (news feed still blocked)');
  await s.shot('feeds-article-fr-dark');
  await s.page.click(`${W} .fd-sub[data-feed="${POD.id}"]`);
  await openRow(s, 'Épisode 2 : le court');
  await s.page.click(`${W} .fd-ep-actions [name="play"]`);
  await waitFor(async () => !(await st(s)).player.paused, 6000);
  check((await T(s, `${W} .fd-pl-speed`)) === '1,5×' && (await s.page.evaluate((q) => document.querySelector(q).getAttribute('aria-label'), `${W} .fd-pl-back`)) === 'Reculer de 15 secondes', 'French player (1,5×, labels)');
  await s.page.evaluate(() => document.querySelector('.win.app-feeds').__feeds.player.pause());
  await s.shot('feeds-podcast-fr-dark');
  await addDialog(s);
  await s.page.click(`${W} .fd-add-tab[data-tab="search"]`);
  await s.page.fill(`${W} .fd-search-input`, 'test');
  await s.page.press(`${W} .fd-search-input`, 'Enter');
  await waitFor(async () => (await ALL(s, `${W} .fd-result-sub`)).join('|') === "Abonné|S'abonner", 6000);
  check((await ALL(s, `${W} .fd-result-sub`)).join('|') === "Abonné|S'abonner" && new URLSearchParams(lastReq('/itunes/search').search).get('country') === 'fr', 'French search: annuaire français, « Abonné » for an existing subscription');
  await s.shot('feeds-search-fr-dark');
  await closeDialog(s);
  // medium window: subscriptions + the reader (Back to the list)
  await s.page.evaluate(() => window.__aurora.wm.byApp('feeds')[0].setSize(900, 640));
  check(!!(await waitFor(async () => (await s.page.evaluate((q) => document.querySelector(q)?.dataset.layout + '/' + document.querySelector(q)?.dataset.pane, `${W} .fd`)) === 'medium/reader', 4000)), 'medium window: subscriptions and the open episode');
  await sleep(300);
  await s.shot('feeds-medium-fr-dark');
  // narrow window
  await s.page.evaluate(() => {
    window.__aurora.wm.byApp('feeds')[0].setSize(600, 640);
  });
  await waitFor(async () => (await s.page.evaluate((q) => document.querySelector(q)?.dataset.layout, `${W} .fd`)) === 'narrow', 4000);
  check((await s.page.evaluate((q) => document.querySelector(q).dataset.layout, `${W} .fd`)) === 'narrow', 'narrow window: one pane at a time');
  await s.page.click(`${W} .fd-back`);
  check(!!(await waitFor(() => s.page.evaluate((q) => getComputedStyle(document.querySelector(q)).display !== 'none' && getComputedStyle(document.querySelector(q.replace('fd-list', 'fd-reader'))).display === 'none', `${W} .fd-list`))), 'Back shows the list');
  await s.page.click(`${W} .fd-nav-toggle`);
  check(!!(await waitFor(() => s.page.evaluate((q) => document.querySelector(q).dataset.nav === 'open' && document.activeElement?.closest('.fd-nav'), `${W} .fd`))), 'the subscriptions slide in (focus inside)');
  await sleep(400); // the slide-in
  await s.shot('feeds-narrow-fr-dark');
  await s.page.keyboard.press('Escape');
  check(!!(await waitFor(() => s.page.evaluate((q) => document.querySelector(q).dataset.nav === 'closed', `${W} .fd`))), 'Escape closes them');
  const errs = consoleErrors(s);
  check(errs.length === 0, `no console errors${errs.length ? `: ${errs.slice(0, 3).join(' | ')}` : ''}`);
  await s.close();
  s = null;

  // ================================================================== English light screenshot of an article with images shown
  s = await launchShell({ home: HOME, open: ['feeds'], lang: 'en', theme: 'light', env: ENV, args: MUTE });
  await waitFor(async () => (await st(s))?.feeds.length > 0, 15000);
  await idle(s);
  await s.page.click(`${W} .fd-sub[data-feed="${NEWS.id}"]`);
  await openRow(s, 'Première nouvelle');
  await s.page.click(`${W} .fd-images-bar [name="show-images"]`);
  check(!!(await waitFor(() => hits('/img/photo1.png') > 0, 6000)), 'article picture after « Show images »');
  await sleep(400);
  await s.shot('feeds-article-en-light');
  const errs2 = consoleErrors(s);
  check(errs2.length === 0, `no console errors (English)${errs2.length ? `: ${errs2.slice(0, 3).join(' | ')}` : ''}`);
} catch (e) {
  check(false, 'test run', e.stack || String(e));
} finally {
  await s?.close();
  server.close();
  bare.close();
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
