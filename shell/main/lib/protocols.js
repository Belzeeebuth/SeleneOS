'use strict';
// app://shell/<path>      -> files under renderer/ (and node_modules for vendored libs)
// media://local/<abs path> -> any local file, with HTTP Range support (video seeking)
//   Build media URLs in the renderer with  aurora.mediaUrl('/home/me/Videos/a.mp4')
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
  '.wasm': 'application/wasm',
};

function mimeOf(p) {
  return MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';
}

function registerSchemes(protocol) {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true } },
    { scheme: 'media', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, bypassCSP: true } },
  ]);
}

function notFound() {
  return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
}

function serveFile(file, request) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return notFound();
  }
  if (!st.isFile()) return notFound();
  const type = mimeOf(file);
  const range = request.headers.get('range');
  const base = { 'content-type': type, 'accept-ranges': 'bytes', 'cache-control': 'no-cache' };
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m) {
      let start = m[1] === '' ? undefined : Number(m[1]);
      let end = m[2] === '' ? undefined : Number(m[2]);
      if (start === undefined) {
        start = Math.max(0, st.size - (end || 0));
        end = st.size - 1;
      }
      if (end === undefined || end >= st.size) end = st.size - 1;
      if (start > end || start >= st.size) {
        return new Response(null, { status: 416, headers: { 'content-range': `bytes */${st.size}` } });
      }
      const stream = fs.createReadStream(file, { start, end });
      return new Response(Readable.toWeb(stream), {
        status: 206,
        headers: { ...base, 'content-length': String(end - start + 1), 'content-range': `bytes ${start}-${end}/${st.size}` },
      });
    }
  }
  return new Response(Readable.toWeb(fs.createReadStream(file)), {
    status: 200,
    headers: { ...base, 'content-length': String(st.size) },
  });
}

function registerProtocols(protocol, _session, { RENDERER, ROOT }) {
  const NODE_MODULES = path.join(ROOT, 'node_modules');
  protocol.handle('app', (request) => {
    const url = new URL(request.url);
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || rel === '') rel = '/shell.html';
    // /node_modules/... serves vendored browser libraries (xterm etc.)
    const isNM = rel.startsWith('/node_modules/');
    const base = isNM ? NODE_MODULES : RENDERER;
    const file = path.normalize(path.join(base, isNM ? rel.slice('/node_modules'.length) : rel));
    if (!file.startsWith(base)) return notFound();
    return serveFile(file, request);
  });
  protocol.handle('media', (request) => {
    const url = new URL(request.url);
    const file = path.normalize(decodeURIComponent(url.pathname));
    if (!path.isAbsolute(file)) return notFound();
    return serveFile(file, request);
  });
}

module.exports = { registerSchemes, registerProtocols, mimeOf };
