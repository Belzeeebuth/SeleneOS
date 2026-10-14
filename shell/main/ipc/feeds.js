'use strict';
// Podcasts & News (renderer/apps/feeds): network access for the RSS / Atom reader and podcast player.
// The renderer CSP has no http(s) connect-src or media-src, so feeds, pages, cover art and episodes are fetched here
// (Node http/https: redirects followed by hand, at most 5; http and https only; a timeout; a size cap; gzip / deflate /
// brotli; the charset of the answer decoded to text). Parsing happens in the renderer (DOMParser).
//
// Channels:
//   feeds:fetch (url, { etag, lastModified, accept }) -> a feed, a web page (autodiscovery) or a chapters file:
//        { status: 200, url (after redirects), permanent (every redirect was 301 / 308), contentType, text, etag,
//          lastModified, size } or { status: 304, url, permanent, etag, lastModified } when the conditional request
//        (If-None-Match / If-Modified-Since) says nothing changed.
//        Rejects: EINVAL (not an http(s) URL), ETOOMANYREDIRECTS (> 5), ETIMEDOUT, EOFFLINE (DNS, refused, reset),
//        EHTTP (status >= 400; err.status, err.retryAfter in ms when the server sent Retry-After), ETOOBIG (> 10 MB).
//   feeds:download (id, url, { podcast, title, type }) -> { path, size, type } once the episode is on disk.
//        The file goes to <XDG music>/Podcasts/<podcast>/<title>.<ext> (safe names, never overwrites: "name (2).mp3"),
//        written as "<name>.part" and renamed at the end. id = the renderer's key ([A-Za-z0-9_-]{1,80}); at most 3
//        downloads run at once (others wait). Up to 10 redirects here (statistics prefixes such as podtrac chain several). Rejects ECANCELED (feeds:cancel), EHTTP, ETOOBIG (> 4 GB), EOFFLINE…
//   (+feeds:progress) { id, received, total (0 = unknown), state: 'queued'|'progress'|'done'|'error'|'canceled', path?, error? }
//        sent to the window that started the download (at most every 250 ms while it runs).
//   feeds:cancel (id) -> true   (the partial file is removed)
//   feeds:downloads () -> [{ id, url, received, total, state }]   (running and queued)
//   feeds:deleteFile (path) -> true   only a regular audio / video file inside the Podcasts folder; empty podcast
//        folders are removed with their last episode. Rejects EINVAL otherwise.
//   feeds:files (paths) -> { [path]: size | null }   which downloaded episodes still exist (null: gone)
//   feeds:search (term, { country: 'fr'|'us'|… , limit }) -> [{ id, title, author, feedUrl, artwork, genre, episodes }]
//        iTunes Search API (https://itunes.apple.com/search?media=podcast&entity=podcast&term=…&country=…, no key),
//        cached 1 h. Base URL: AURORA_FEEDS_ITUNES_URL (tests).
//   feeds:image (url) -> { path } cover art downloaded once to ~/.cache/aurora/feeds/images (image/* only, ≤ 8 MB, made
//        at most 600 px wide when Electron can decode it), shown by the renderer through media://. Cached 30 days.
//   feeds:dirs () -> { podcasts, cache }
//   feeds:stats () -> { requests: [{ url, status, ifNoneMatch, ifModifiedSince, userAgent, at }], userAgent, active }
//        (diagnostics, tests; the last 100 requests)
// Env (tests): AURORA_FEEDS_ITUNES_URL (search base URL), AURORA_FEEDS_TIMEOUT (ms, default 30000),
//   AURORA_FEEDS_MAX_BYTES (feed size cap, default 10 MB).
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const zlib = require('zlib');
const crypto = require('crypto');
const { inside } = require('../lib/homepath');

const HOME = os.homedir();
const MAX_REDIRECTS = 5;
// Episode addresses often go through several listening-statistics services (podtrac, pdst.fm, chartable…) before the file
const MAX_REDIRECTS_DOWNLOAD = 10;
const FEED_MAX = Math.max(1024, Number(process.env.AURORA_FEEDS_MAX_BYTES) || 10 * 1024 * 1024);
const DOWNLOAD_MAX = 4 * 1024 * 1024 * 1024;
const IMAGE_MAX = 8 * 1024 * 1024;
const TIMEOUT = Math.max(200, Number(process.env.AURORA_FEEDS_TIMEOUT) || 30000);
const IDLE_TIMEOUT = 60000;
const IMAGE_TTL = 30 * 24 * 3600000;
const SEARCH_TTL = 3600000;
const MAX_DOWNLOADS = 3;
const MEDIA_EXT = new Set(['.mp3', '.m4a', '.m4b', '.aac', '.ogg', '.oga', '.opus', '.flac', '.wav', '.mp4', '.m4v', '.webm', '.mov', '.mkv']);
const TYPE_EXT = {
  'audio/mpeg': '.mp3', 'audio/mp3': '.mp3', 'audio/x-mp3': '.mp3', 'audio/mpeg3': '.mp3', 'audio/x-mpeg': '.mp3',
  'audio/mp4': '.m4a', 'audio/x-m4a': '.m4a', 'audio/m4a': '.m4a', 'audio/aac': '.aac', 'audio/x-aac': '.aac',
  'audio/ogg': '.ogg', 'audio/vorbis': '.ogg', 'audio/opus': '.opus', 'audio/flac': '.flac', 'audio/x-flac': '.flac',
  'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/wave': '.wav', 'video/mp4': '.mp4', 'video/x-m4v': '.m4v',
  'video/webm': '.webm', 'video/quicktime': '.mov', 'audio/webm': '.webm',
};

function err(message, code, extra) {
  const e = new Error(message);
  e.code = code;
  e.quiet = true;
  if (extra) Object.assign(e, extra);
  return e;
}

function cacheDir() {
  return path.join(process.env.XDG_CACHE_HOME || path.join(HOME, '.cache'), 'aurora', 'feeds');
}

function musicDir() {
  let dir = path.join(HOME, 'Music');
  try {
    const txt = fs.readFileSync(path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'), 'user-dirs.dirs'), 'utf8');
    const m = /^XDG_MUSIC_DIR="([^"]+)"/m.exec(txt);
    if (m) {
      const d = m[1].replace(/^\$HOME/, HOME);
      if (path.isAbsolute(d) && path.resolve(d) !== path.resolve(HOME)) dir = d;
    }
  } catch {}
  return dir;
}
const podcastsDir = () => path.join(musicDir(), 'Podcasts');

/** A safe file or folder name: no slashes, control characters or leading dots; at most `max` characters. */
function safeName(s, fallback = 'podcast', max = 100) {
  let n = String(s ?? '')
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s-]+/, '')
    .replace(/[.\s]+$/, '');
  if ([...n].length > max) n = [...n].slice(0, max).join('').trim();
  return n || fallback;
}

/** http(s) URL → URL object, or throws EINVAL. */
function checkUrl(u) {
  let url;
  try {
    url = new URL(String(u || '').trim());
  } catch {
    throw err('Invalid address', 'EINVAL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw err('Only http and https addresses are supported', 'EINVAL');
  if (url.username || url.password) {
    // credentials in the URL are kept for the request but never logged
  }
  return url;
}

function retryAfterMs(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (/^\d+$/.test(s)) return Math.min(7 * 86400000, Number(s) * 1000);
  const t = Date.parse(s);
  return Number.isFinite(t) ? Math.max(0, Math.min(7 * 86400000, t - Date.now())) : null;
}

/** Decode a body: charset from Content-Type, then a BOM, then the XML declaration or an HTML <meta charset>. */
function decodeBody(buf, contentType) {
  let cs = /charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType || '')?.[1];
  let start = 0;
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    cs = 'utf-8';
    start = 3;
  } else if (buf[0] === 0xff && buf[1] === 0xfe) cs = 'utf-16le';
  else if (buf[0] === 0xfe && buf[1] === 0xff) cs = 'utf-16be';
  if (!cs) {
    const head = buf.subarray(0, 4096).toString('latin1');
    cs = /<\?xml[^>]*\bencoding\s*=\s*["']([\w.:-]+)["']/i.exec(head)?.[1] || /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(head)?.[1] || 'utf-8';
  }
  let text;
  try {
    text = new TextDecoder(cs.toLowerCase()).decode(buf.subarray(start));
  } catch {
    text = new TextDecoder('utf-8').decode(buf.subarray(start));
  }
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function netError(e, signal) {
  if (e?.code === 'ECANCELED' || signal?.aborted) return e?.code === 'ETIMEDOUT' ? e : err('Canceled', 'ECANCELED');
  if (['ETIMEDOUT', 'EINVAL', 'ETOOMANYREDIRECTS', 'EHTTP', 'ETOOBIG', 'EBADDATA', 'ENOSPC', 'EIO', 'EEXIST', 'EBUSY'].includes(e?.code)) return e;
  if (e?.code === 'ERR_TLS_CERT_ALTNAME_INVALID' || /certificate|SSL|TLS/i.test(e?.message || '')) return err(`Secure connection failed (${e.message})`, 'ETLS');
  return err(`Network unreachable (${e?.message || e})`, 'EOFFLINE');
}

// ---------------------------------------------------------------- module
function register(api) {
  const USER_AGENT = `SeleneOS-Feeds/${api.env?.version || '1.0'} (Podcasts & News; Linux)`;
  const ITUNES = String(process.env.AURORA_FEEDS_ITUNES_URL || 'https://itunes.apple.com').replace(/\/+$/, '');
  const stats = { requests: [] };
  const logRequest = (url, headers, status) => {
    let shown = url;
    try {
      const u = new URL(url);
      u.username = '';
      u.password = '';
      shown = u.href;
    } catch {}
    stats.requests.push({ url: shown, status, ifNoneMatch: headers['If-None-Match'] || null, ifModifiedSince: headers['If-Modified-Since'] || null, userAgent: headers['User-Agent'], at: Date.now() });
    if (stats.requests.length > 100) stats.requests.shift();
  };

  /**
   * GET `url`, following at most 5 redirects. Resolves { res, url, permanent } with the final response (a non-redirect
   * status, body not read yet). `signal` aborts; `timeoutMs` covers the whole exchange up to the response headers.
   */
  function open(url, { headers = {}, signal, timeoutMs = TIMEOUT, maxRedirects = MAX_REDIRECTS } = {}) {
    return new Promise((resolve, reject) => {
      let current = checkUrl(url);
      let hops = 0;
      let permanent = true;
      let settled = false;
      let req = null;
      const fail = (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          req?.destroy();
        } catch {}
        reject(e);
      };
      const timer = setTimeout(() => fail(err('The server took too long to answer', 'ETIMEDOUT')), timeoutMs);
      const onAbort = () => fail(err('Canceled', 'ECANCELED'));
      if (signal) {
        if (signal.aborted) return onAbort();
        signal.addEventListener('abort', onAbort, { once: true });
      }
      const go = () => {
        const mod = current.protocol === 'https:' ? https : http;
        const h = { 'User-Agent': USER_AGENT, 'Accept-Language': api.env?.lang === 'fr' ? 'fr, en;q=0.7' : 'en, fr;q=0.5', ...headers };
        try {
          req = mod.request(current, { method: 'GET', headers: h, agent: false });
        } catch (e) {
          fail(netError(e));
          return;
        }
        req.setTimeout(Math.min(timeoutMs, IDLE_TIMEOUT), () => fail(err('The server took too long to answer', 'ETIMEDOUT')));
        req.on('error', (e) => fail(netError(e, signal)));
        req.on('response', (res) => {
          if (settled) {
            res.resume();
            return;
          }
          logRequest(current.href, h, res.statusCode);
          const loc = res.headers.location;
          if ([301, 302, 303, 307, 308].includes(res.statusCode) && loc) {
            res.resume();
            hops++;
            if (hops > maxRedirects) return fail(err('Too many redirects', 'ETOOMANYREDIRECTS'));
            if (res.statusCode !== 301 && res.statusCode !== 308) permanent = false;
            try {
              current = checkUrl(new URL(loc, current).href);
            } catch (e) {
              return fail(e);
            }
            go();
            return;
          }
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          resolve({ res, url: current.href, permanent: hops > 0 && permanent, req });
        });
        req.end();
      };
      go();
    });
  }

  /** Read a response body (decompressed) up to `max` bytes; rejects ETOOBIG beyond. */
  function readBody(res, max, signal) {
    return new Promise((resolve, reject) => {
      const enc = String(res.headers['content-encoding'] || '').toLowerCase().trim();
      let stream = res;
      if (enc === 'gzip' || enc === 'x-gzip') stream = res.pipe(zlib.createGunzip());
      else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
      else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
      const len = Number(res.headers['content-length']);
      if (!enc && Number.isFinite(len) && len > max) {
        res.destroy();
        reject(err('The document is too large', 'ETOOBIG'));
        return;
      }
      const chunks = [];
      let size = 0;
      let done = false;
      const finish = (e, v) => {
        if (done) return;
        done = true;
        clearTimeout(idle);
        signal?.removeEventListener('abort', onAbort);
        if (e) {
          try {
            res.destroy();
          } catch {}
          reject(e);
        } else resolve(v);
      };
      let idle = null;
      const kick = () => {
        clearTimeout(idle);
        idle = setTimeout(() => finish(err('The server stopped answering', 'ETIMEDOUT')), Math.min(TIMEOUT, IDLE_TIMEOUT));
      };
      const onAbort = () => finish(err('Canceled', 'ECANCELED'));
      signal?.addEventListener('abort', onAbort, { once: true });
      kick();
      stream.on('data', (c) => {
        size += c.length;
        if (size > max) return finish(err('The document is too large', 'ETOOBIG'));
        chunks.push(c);
        kick();
      });
      stream.on('end', () => finish(null, Buffer.concat(chunks)));
      stream.on('error', (e) => finish(err(`Could not read the answer (${e.message})`, enc ? 'EBADDATA' : 'EOFFLINE')));
      res.on('aborted', () => finish(err('The connection was interrupted', 'EOFFLINE')));
    });
  }

  function httpError(res) {
    const status = res.statusCode;
    return err(`The server answered ${status}`, 'EHTTP', { status, retryAfter: retryAfterMs(res.headers['retry-after']) });
  }

  // ---------------------------------------------------------------- feeds:fetch
  async function fetchDoc(url, opts = {}) {
    const headers = {
      Accept: typeof opts.accept === 'string' && opts.accept.length < 300 ? opts.accept : 'application/rss+xml, application/atom+xml, application/rdf+xml, application/feed+json, application/xml;q=0.9, text/xml;q=0.9, text/html;q=0.8, */*;q=0.5',
      'Accept-Encoding': 'gzip, deflate, br',
    };
    if (typeof opts.etag === 'string' && opts.etag && opts.etag.length < 300 && !/[\r\n]/.test(opts.etag)) headers['If-None-Match'] = opts.etag;
    if (typeof opts.lastModified === 'string' && opts.lastModified && opts.lastModified.length < 100 && !/[\r\n]/.test(opts.lastModified)) headers['If-Modified-Since'] = opts.lastModified;
    const ctrl = new AbortController();
    const total = setTimeout(() => ctrl.abort(), TIMEOUT + 5000);
    try {
      const { res, url: finalUrl, permanent } = await open(url, { headers, signal: ctrl.signal });
      const etag = typeof res.headers.etag === 'string' ? res.headers.etag.slice(0, 300) : null;
      const lastModified = typeof res.headers['last-modified'] === 'string' ? res.headers['last-modified'].slice(0, 100) : null;
      if (res.statusCode === 304) {
        res.resume();
        return { status: 304, url: finalUrl, permanent, etag: etag || opts.etag || null, lastModified: lastModified || opts.lastModified || null };
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        // returned, not thrown: an error object would lose its status crossing the IPC bridge
        res.resume();
        return { status: res.statusCode, url: finalUrl, permanent, error: 'EHTTP', retryAfter: retryAfterMs(res.headers['retry-after']) };
      }
      const contentType = String(res.headers['content-type'] || '').slice(0, 200);
      const buf = await readBody(res, FEED_MAX, ctrl.signal);
      return { status: 200, url: finalUrl, permanent, contentType, text: decodeBody(buf, contentType), etag, lastModified, size: buf.length };
    } catch (e) {
      if (e.code === 'ECANCELED' && !opts.signal) throw err('The server took too long to answer', 'ETIMEDOUT');
      throw netError(e);
    } finally {
      clearTimeout(total);
    }
  }

  // ---------------------------------------------------------------- downloads
  const downloads = new Map(); // id -> { id, url, ctrl, received, total, state, sender }
  const queue = [];
  let running = 0;
  const pump = () => {
    while (running < MAX_DOWNLOADS && queue.length) {
      const job = queue.shift();
      if (job.ctrl.signal.aborted) continue;
      running++;
      job
        .run()
        .catch(() => {})
        .finally(() => {
          running--;
          pump();
        });
    }
  };

  async function uniqueFile(dir, base, ext) {
    for (let i = 1; i < 1000; i++) {
      const name = `${base}${i > 1 ? ` (${i})` : ''}${ext}`;
      const p = path.join(dir, name);
      const taken = await fsp.lstat(p).then(() => true, () => false);
      const partTaken = await fsp.lstat(`${p}.part`).then(() => true, () => false);
      if (!taken && !partTaken) return p;
    }
    throw err('Could not find a free file name', 'EEXIST');
  }

  function extFor(type, url) {
    const t = String(type || '').toLowerCase().split(';')[0].trim();
    if (TYPE_EXT[t]) return TYPE_EXT[t];
    try {
      const e = path.extname(new URL(url).pathname).toLowerCase();
      if (MEDIA_EXT.has(e)) return e;
    } catch {}
    if (t.startsWith('video/')) return '.mp4';
    return '.mp3';
  }

  function download(id, url, opts = {}, event) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw err('Invalid download id', 'EINVAL');
    checkUrl(url);
    if (downloads.has(id)) throw err('Already downloading', 'EBUSY');
    const sender = event?.sender || null;
    const ctrl = new AbortController();
    const d = { id, url: String(url), ctrl, received: 0, total: 0, state: 'queued', sender };
    downloads.set(id, d);
    let last = 0;
    const emit = (extra = {}, force = false) => {
      const now = Date.now();
      if (!force && now - last < 250) return;
      last = now;
      const payload = { id, received: d.received, total: d.total, state: d.state, ...extra };
      if (sender) api.sendTo(sender, 'feeds:progress', payload);
      else api.broadcast('feeds:progress', payload);
    };
    emit({}, true);
    return new Promise((resolve, reject) => {
      const job = {
        ctrl,
        run: async () => {
          let part = null;
          let file = null;
          let out = null;
          try {
            d.state = 'progress';
            emit({}, true);
            const { res } = await open(url, { headers: { Accept: 'audio/*, video/*, */*;q=0.5', 'Accept-Encoding': 'identity' }, signal: ctrl.signal, maxRedirects: MAX_REDIRECTS_DOWNLOAD });
            if (res.statusCode < 200 || res.statusCode >= 300) {
              res.resume();
              throw httpError(res);
            }
            const len = Number(res.headers['content-length']);
            if (Number.isFinite(len) && len > DOWNLOAD_MAX) {
              res.destroy();
              throw err('The episode is too large', 'ETOOBIG');
            }
            d.total = Number.isFinite(len) && len > 0 ? len : 0;
            const ctype = String(res.headers['content-type'] || '').toLowerCase().split(';')[0].trim();
            const type = opts.type && TYPE_EXT[String(opts.type).toLowerCase()] ? String(opts.type).toLowerCase() : ctype;
            const dir = path.join(podcastsDir(), safeName(opts.podcast, 'Podcast', 80));
            await fsp.mkdir(dir, { recursive: true });
            file = await uniqueFile(dir, safeName(opts.title, 'Episode', 120), extFor(type, url));
            part = `${file}.part`;
            out = fs.createWriteStream(part, { flags: 'wx' });
            await new Promise((ok, ko) => {
              let idle = null;
              const kick = () => {
                clearTimeout(idle);
                idle = setTimeout(() => ko(err('The server stopped sending the episode', 'ETIMEDOUT')), IDLE_TIMEOUT);
              };
              const stop = (e) => {
                clearTimeout(idle);
                try {
                  res.destroy();
                } catch {}
                ko(e);
              };
              kick();
              ctrl.signal.addEventListener('abort', () => stop(err('Canceled', 'ECANCELED')), { once: true });
              res.on('data', (c) => {
                d.received += c.length;
                if (d.received > DOWNLOAD_MAX) return stop(err('The episode is too large', 'ETOOBIG'));
                kick();
                if (!out.write(c)) {
                  res.pause();
                  out.once('drain', () => res.resume());
                }
                emit();
              });
              res.on('end', () => {
                clearTimeout(idle);
                if (ctrl.signal.aborted) return;
                if (d.total && d.received < d.total) return ko(err('The download was interrupted', 'EOFFLINE'));
                out.end(ok);
              });
              res.on('aborted', () => stop(err('The download was interrupted', 'EOFFLINE')));
              res.on('error', (e) => stop(netError(e, ctrl.signal)));
              out.on('error', (e) => stop(err(`Could not write the episode (${e.message})`, e.code === 'ENOSPC' ? 'ENOSPC' : 'EIO')));
            });
            await fsp.rename(part, file);
            part = null;
            d.state = 'done';
            emit({ path: file }, true);
            downloads.delete(id);
            resolve({ path: file, size: d.received, type: type || null });
          } catch (e0) {
            const e = netError(e0, ctrl.signal);
            if (out && !out.closed) {
              await new Promise((r) => {
                out.once('close', r);
                out.destroy();
              });
            }
            if (part) {
              await fsp.unlink(part).catch(() => {});
              // a podcast folder created for this download only: removed again
              const dir = path.dirname(part);
              if (!(await fsp.readdir(dir).catch(() => ['?'])).length) await fsp.rmdir(dir).catch(() => {});
            }
            d.state = e.code === 'ECANCELED' ? 'canceled' : 'error';
            emit({ error: e.code }, true);
            downloads.delete(id);
            reject(e);
          }
        },
      };
      ctrl.signal.addEventListener(
        'abort',
        () => {
          // still queued: settle at once
          if (d.state === 'queued') {
            const i = queue.indexOf(job);
            if (i >= 0) queue.splice(i, 1);
            d.state = 'canceled';
            emit({ error: 'ECANCELED' }, true);
            downloads.delete(id);
            reject(err('Canceled', 'ECANCELED'));
          }
        },
        { once: true },
      );
      queue.push(job);
      pump();
    });
  }

  /** Real path inside the Podcasts folder (symlinks resolved), or null. */
  async function insidePodcasts(p) {
    if (typeof p !== 'string' || !p || p.includes('\0') || !path.isAbsolute(p)) return null;
    const root = await fsp.realpath(podcastsDir()).catch(() => null);
    if (!root) return null;
    const real = await fsp.realpath(p).catch(() => null);
    if (!real || real === root || !inside(real, root)) return null;
    return { real, root };
  }

  // ---------------------------------------------------------------- images
  const imgInflight = new Map();
  let imgActive = 0;
  const imgWaiters = [];
  const imgSlot = () => (imgActive < 4 ? (imgActive++, Promise.resolve()) : new Promise((r) => imgWaiters.push(r)).then(() => imgActive++));
  const imgRelease = () => {
    imgActive--;
    imgWaiters.shift()?.();
  };
  function sniffImage(buf) {
    if (buf.length > 8 && buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return '.png';
    if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg';
    if (buf.length > 6 && /^GIF8[79]a/.test(buf.toString('latin1', 0, 6))) return '.gif';
    if (buf.length > 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return '.webp';
    if (buf.length > 12 && buf.toString('latin1', 4, 8) === 'ftyp' && /avif|avis/.test(buf.toString('latin1', 8, 12))) return '.avif';
    const head = buf.subarray(0, 512).toString('utf8').trimStart();
    if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(head)) return '.svg';
    return null;
  }
  async function image(url) {
    const u = checkUrl(url).href;
    const key = crypto.createHash('sha256').update(u).digest('hex').slice(0, 32);
    const dir = path.join(cacheDir(), 'images');
    for (const ext of ['.jpg', '.png', '.gif', '.webp', '.avif', '.svg']) {
      const p = path.join(dir, key + ext);
      const st = await fsp.stat(p).catch(() => null);
      if (st && Date.now() - st.mtimeMs < IMAGE_TTL) return { path: p, cached: true };
    }
    if (imgInflight.has(key)) return imgInflight.get(key);
    const job = (async () => {
      await imgSlot();
      try {
        const { res } = await open(u, { headers: { Accept: 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8', 'Accept-Encoding': 'identity' }, timeoutMs: Math.min(TIMEOUT, 20000) });
        if (res.statusCode !== 200) {
          res.resume();
          throw httpError(res);
        }
        let buf = await readBody(res, IMAGE_MAX);
        let ext = sniffImage(buf);
        if (!ext) throw err('Not an image', 'EBADDATA');
        if (ext === '.jpg' || ext === '.png') {
          try {
            const { nativeImage } = require('electron');
            const img = nativeImage.createFromBuffer(buf);
            const { width } = img.getSize();
            if (!img.isEmpty() && width > 600) {
              const small = img.resize({ width: 600, quality: 'good' });
              buf = ext === '.png' ? small.toPNG() : small.toJPEG(88);
            }
          } catch {}
        }
        await fsp.mkdir(dir, { recursive: true });
        const p = path.join(dir, key + ext);
        const tmp = `${p}.${process.pid}.tmp`;
        await fsp.writeFile(tmp, buf);
        await fsp.rename(tmp, p);
        return { path: p, cached: false };
      } catch (e) {
        throw netError(e);
      } finally {
        imgRelease();
        imgInflight.delete(key);
      }
    })();
    imgInflight.set(key, job);
    return job;
  }

  // ---------------------------------------------------------------- iTunes search
  const searches = new Map();
  const txt = (v, n = 300) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n) : '');
  async function search(term, opts = {}) {
    const q = txt(String(term ?? ''), 120);
    if (q.length < 2) return [];
    const country = /^[a-z]{2}$/i.test(String(opts.country || '')) ? String(opts.country).toLowerCase() : 'us';
    const limit = Math.max(1, Math.min(50, Math.round(Number(opts.limit)) || 25));
    const key = `${country}|${limit}|${q.toLowerCase()}`;
    const hit = searches.get(key);
    if (hit && Date.now() - hit.at < SEARCH_TTL) return hit.results;
    const url = `${ITUNES}/search?media=podcast&entity=podcast&term=${encodeURIComponent(q)}&country=${country}&limit=${limit}`;
    const res = await fetchDoc(url, { accept: 'application/json, text/javascript;q=0.9, */*;q=0.5' });
    if (res.error) throw err(`The podcast directory answered ${res.status}`, 'EHTTP', { status: res.status });
    let json;
    try {
      json = JSON.parse(res.text);
    } catch {
      throw err('Unexpected answer from the podcast directory', 'EBADDATA');
    }
    const results = (Array.isArray(json?.results) ? json.results : [])
      .map((r) => {
        let feedUrl = '';
        try {
          feedUrl = checkUrl(r?.feedUrl).href;
        } catch {}
        let artwork = '';
        for (const a of [r?.artworkUrl600, r?.artworkUrl100, r?.artworkUrl60]) {
          try {
            if (!artwork && a) artwork = checkUrl(a).href;
          } catch {}
        }
        return { id: Number(r?.collectionId) || null, title: txt(r?.collectionName || r?.trackName, 200), author: txt(r?.artistName, 200), feedUrl, artwork, genre: txt(r?.primaryGenreName, 60), episodes: Number(r?.trackCount) || null };
      })
      .filter((r) => r.feedUrl && r.title)
      .slice(0, limit);
    searches.set(key, { at: Date.now(), results });
    if (searches.size > 50) searches.delete(searches.keys().next().value);
    return results;
  }

  // ---------------------------------------------------------------- handlers
  api.handle('feeds:fetch', (url, opts) => fetchDoc(url, opts && typeof opts === 'object' ? opts : {}));
  api.handle('feeds:download', (id, url, opts, event) => {
    // invoke() passes the event last: (id, url, event) when opts is omitted
    if (opts && typeof opts === 'object' && opts.sender && typeof opts.sender.send === 'function') {
      event = opts;
      opts = {};
    }
    return download(id, url, opts && typeof opts === 'object' ? opts : {}, event);
  });
  api.handle('feeds:cancel', (id) => {
    const d = downloads.get(String(id));
    if (d) d.ctrl.abort();
    return !!d;
  });
  api.handle('feeds:downloads', () => [...downloads.values()].map((d) => ({ id: d.id, url: d.url, received: d.received, total: d.total, state: d.state })));
  api.handle('feeds:deleteFile', async (p) => {
    const ok = await insidePodcasts(p);
    if (!ok) throw err('Not a downloaded episode', 'EINVAL');
    const st = await fsp.lstat(ok.real);
    if (!st.isFile() || !MEDIA_EXT.has(path.extname(ok.real).toLowerCase())) throw err('Not a downloaded episode', 'EINVAL');
    await fsp.unlink(ok.real);
    // remove the podcast folder when it is now empty
    const dir = path.dirname(ok.real);
    if (dir !== ok.root && inside(dir, ok.root)) {
      const left = await fsp.readdir(dir).catch(() => ['?']);
      if (!left.length) await fsp.rmdir(dir).catch(() => {});
    }
    return true;
  });
  api.handle('feeds:files', async (paths) => {
    const out = {};
    for (const p of (Array.isArray(paths) ? paths : []).slice(0, 5000)) {
      if (typeof p !== 'string' || !path.isAbsolute(p)) continue;
      const st = await fsp.stat(p).catch(() => null);
      out[p] = st && st.isFile() ? st.size : null;
    }
    return out;
  });
  api.handle('feeds:search', (term, opts) => search(term, opts && typeof opts === 'object' ? opts : {}));
  api.handle('feeds:image', (url) => image(url));
  api.handle('feeds:dirs', () => ({ podcasts: podcastsDir(), cache: cacheDir() }));
  api.handle('feeds:stats', () => ({ requests: stats.requests.slice(), userAgent: USER_AGENT, active: downloads.size, itunes: ITUNES }));
}

module.exports = register;
module.exports.safeName = safeName;
module.exports.decodeBody = decodeBody;
module.exports.retryAfterMs = retryAfterMs;
module.exports.podcastsDir = podcastsDir;
