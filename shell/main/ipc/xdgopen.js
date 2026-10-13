'use strict';
// « Open this link / file » requests from Linux and Flatpak apps (xdg-open, GIO, the OpenURI portal), sent by
// /usr/bin/aurora-open (rootfs/) through the NoDisplay aurora-*.desktop handlers and /etc/xdg/mimeapps.list.
//
// Socket: $XDG_RUNTIME_DIR/aurora/open.sock (dir 0700, socket 0600; AURORA_OPEN_SOCKET overrides, tests), one JSON
// line per connection: { v: 1, app: 'browser'|'mail'|'files'|'notepad'|'photos'|'media'|'pdf'|'archive'|'',
// items: [{ kind: 'url'|'path', value }] } -> { ok: true } | { ok: false, error }.
// Everything is validated again here: only http(s) / mailto URLs and existing local paths; the request goes to the
// renderer as `xdg:open` { app, url? , path? } (core/features/xdgopen.js opens it like a click in Selene).
const fs = require('fs');
const net = require('net');
const path = require('path');

const APPS = new Set(['', 'browser', 'mail', 'files', 'notepad', 'photos', 'media', 'pdf', 'archive']);
const MAX_ITEMS = 32;
const MAX_URL = 8192;
const MAX_LINE = 300 * 1024;

/** One validated item -> { url } | { path } | null. */
function checkItem(it) {
  if (!it || typeof it !== 'object' || typeof it.value !== 'string') return null;
  const v = it.value;
  if (!v || v.length > MAX_URL || /[\u0000-\u001f\u007f]/.test(v)) return null;
  if (it.kind === 'url') {
    if (/^mailto:/i.test(v)) return { url: v };
    if (!/^https?:\/\//i.test(v)) return null;
    try {
      const u = new URL(v);
      return u.hostname ? { url: u.href } : null;
    } catch {
      return null;
    }
  }
  if (it.kind === 'path') {
    if (!path.isAbsolute(v)) return null;
    const p = path.normalize(v);
    try {
      fs.statSync(p);
    } catch {
      return null;
    }
    return { path: p };
  }
  return null;
}

/** Parsed request -> { app, items: [{url}|{path}] } or throws Error(message). */
function checkRequest(req) {
  if (!req || typeof req !== 'object' || req.v !== 1) throw new Error('bad request');
  const app = typeof req.app === 'string' ? req.app : '';
  if (!APPS.has(app)) throw new Error(`unknown app ${String(req.app).slice(0, 40)}`);
  const list = Array.isArray(req.items) ? req.items : [];
  if (list.length > MAX_ITEMS) throw new Error('too many items');
  const items = [];
  for (const it of list) {
    const ok = checkItem(it);
    if (!ok) throw new Error(`refused: ${String(it?.value || '').slice(0, 120)}`);
    items.push(ok);
  }
  if (!items.length && app !== 'browser' && app !== 'mail') throw new Error('nothing to open');
  return { app, items };
}

function socketPath() {
  if (process.env.AURORA_OPEN_SOCKET) return process.env.AURORA_OPEN_SOCKET;
  const run = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 0}`;
  return path.join(run, 'aurora', 'open.sock');
}

function register(api) {
  if (api.env.mode !== 'shell') return;
  // Dev runs (tests, a developer's own desktop) only listen when asked, so they never take over the real session's socket.
  if (api.DEV && !process.env.AURORA_OPEN_SOCKET) return;
  const sock = socketPath();
  try {
    fs.mkdirSync(path.dirname(sock), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.dirname(sock), 0o700);
    fs.rmSync(sock, { force: true });
  } catch (err) {
    console.warn(`[xdgopen] cannot prepare ${sock}:`, err.message);
    return;
  }
  const uid = process.getuid?.();
  const server = net.createServer((c) => {
    let buf = '';
    c.setTimeout(10000, () => c.destroy());
    const reply = (o) => {
      try {
        c.end(`${JSON.stringify(o)}\n`);
      } catch {}
    };
    c.on('error', () => {});
    c.on('data', (d) => {
      buf += d.toString('utf8');
      if (buf.length > MAX_LINE) return reply({ ok: false, error: 'request too large' });
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      let req;
      try {
        req = checkRequest(JSON.parse(buf.slice(0, nl)));
      } catch (err) {
        return reply({ ok: false, error: String(err.message || err) });
      }
      const win = api.getMainWindow();
      if (!win || win.isDestroyed()) return reply({ ok: false, error: 'the desktop is not ready' });
      if (!req.items.length) api.broadcast('xdg:open', { app: req.app });
      for (const it of req.items) api.broadcast('xdg:open', { app: req.app, ...it });
      reply({ ok: true });
    });
  });
  server.on('error', (err) => console.warn('[xdgopen] socket error:', err.message));
  server.listen(sock, () => {
    try {
      fs.chmodSync(sock, 0o600);
    } catch {}
    if (uid != null) console.log(`[xdgopen] listening on ${sock}`);
  });
  const { app } = require('electron');
  app.on('will-quit', () => {
    try {
      server.close();
      fs.rmSync(sock, { force: true });
    } catch {}
  });
  api.handle('xdg:socket', () => sock);
}

module.exports = register;
module.exports.register = register;
module.exports.checkRequest = checkRequest;
module.exports.checkItem = checkItem;
module.exports.socketPath = socketPath;
