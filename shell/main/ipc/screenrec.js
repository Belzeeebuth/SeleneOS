'use strict';
// Screen recorder backend (apps/screenrec): the screen to capture, and the WebM file written while recording.
//   screenrec:source()                 -> { id, name, display, content, zoom } | null   the primary screen (display:
//                                         its bounds in DIP; content: the shell page's bounds; zoom: the page zoom), for
//                                         getUserMedia({ video: { mandatory:
//                                         { chromeMediaSource: 'desktop', chromeMediaSourceId: id } } }).
//                                         desktopCapturer is asked for screens ALONE (a window lookup at the same time
//                                         makes X11 return no screen, see main/ipc/browser.js), retried once.
//   screenrec:tools()                  -> { ffmpeg: boolean }
//   screenrec:open(dir, base)          -> { id, path }   creates <dir>/<base>.webm (unique name; dir under $HOME)
//   screenrec:append(id, bytes)        -> bytes written so far (MediaRecorder chunks, in order)
//   screenrec:finish(id, { mp4 })      -> { path, size, format: 'webm'|'mp4', warning: null|'ENOFFMPEG'|'EMP4' }
//                                         closes the file; with ffmpeg the WebM is remuxed (duration and seeking), and
//                                         with mp4 it is converted (H.264 + AAC) and the WebM removed. A failed
//                                         conversion keeps the WebM (warning 'EMP4').
//   screenrec:abort(id)                -> true   closes and deletes the file (recording cancelled or failed)
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { run, which } = require('../lib/exec');

const files = new Map(); // id -> { path, fd, size, queue }
let seq = 0;

function insideHome(p) {
  const home = path.resolve(os.homedir());
  const abs = path.resolve(String(p || ''));
  return abs === home || abs.startsWith(home + path.sep) ? abs : null;
}
const safeBase = (s) =>
  String(s || 'Recording')
    .replace(/[/\\\0]/g, '-')
    .replace(/^\.+/, '')
    .slice(0, 120) || 'Recording';

async function uniquePath(dir, base, ext) {
  for (let i = 1; i < 1000; i++) {
    const p = path.join(dir, `${base}${i > 1 ? ` (${i})` : ''}.${ext}`);
    try {
      await fsp.access(p);
    } catch {
      return p;
    }
  }
  return path.join(dir, `${base} ${Date.now()}.${ext}`);
}

module.exports = function register(api) {
  let capturerQueue = Promise.resolve();
  const screens = () => {
    const job = capturerQueue.then(() => require('electron').desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false }));
    capturerQueue = job.catch(() => []);
    return job.catch((err) => {
      console.warn('[screenrec] desktopCapturer failed', err?.message || err);
      return [];
    });
  };
  api.handle('screenrec:source', async () => {
    let list = await screens();
    if (!list.length) list = await new Promise((r) => setTimeout(r, 200)).then(screens);
    if (!list.length) return null;
    let primary = null;
    try {
      primary = String(require('electron').screen.getPrimaryDisplay().id);
    } catch {}
    const src = list.find((s) => s.display_id && s.display_id === primary) || list[0];
    // where the shell page sits on that screen (DIP), to map CSS px to pixels of the capture
    const geo = { display: null, content: null, zoom: 1 };
    try {
      const { screen } = require('electron');
      const d = screen.getAllDisplays().find((x) => String(x.id) === String(src.display_id)) || screen.getPrimaryDisplay();
      geo.display = { ...d.bounds };
      const w = api.getMainWindow();
      if (w && !w.isDestroyed()) {
        geo.content = w.getContentBounds();
        geo.zoom = w.webContents.getZoomFactor() || 1;
      }
    } catch {}
    return { id: src.id, name: String(src.name || ''), ...geo };
  });

  api.handle('screenrec:tools', () => ({ ffmpeg: !!which('ffmpeg') }));

  api.handle('screenrec:open', async (dir, base) => {
    const d = insideHome(dir);
    if (!d) throw api.error('The folder must be in your home folder', 'EPERM');
    await fsp.mkdir(d, { recursive: true });
    const p = await uniquePath(d, safeBase(base), 'webm');
    const fd = await fsp.open(p, 'wx');
    const id = `r${++seq}`;
    files.set(id, { path: p, fd, size: 0, queue: Promise.resolve() });
    return { id, path: p };
  });

  api.handle('screenrec:append', (id, bytes) => {
    const f = files.get(String(id));
    if (!f) throw api.error('No such recording', 'ENOENT');
    const buf = Buffer.from(bytes || []);
    f.queue = f.queue.then(async () => {
      if (buf.length) await f.fd.write(buf);
      f.size += buf.length;
    });
    return f.queue.then(() => f.size);
  });

  async function close(f) {
    await f.queue.catch(() => {});
    await f.fd.close().catch(() => {});
  }

  api.handle('screenrec:abort', async (id) => {
    const f = files.get(String(id));
    if (!f) return true;
    files.delete(String(id));
    await close(f);
    await fsp.rm(f.path, { force: true }).catch(() => {});
    return true;
  });

  api.handle('screenrec:finish', async (id, opts = {}) => {
    const f = files.get(String(id));
    if (!f) throw api.error('No such recording', 'ENOENT');
    files.delete(String(id));
    await close(f);
    if (f.size < 64) {
      await fsp.rm(f.path, { force: true }).catch(() => {});
      throw api.error('The recording is empty', 'ENODATA');
    }
    const out = { path: f.path, size: f.size, format: 'webm', warning: null };
    if (!which('ffmpeg')) {
      if (opts && opts.mp4) out.warning = 'ENOFFMPEG';
      return out;
    }
    // MediaRecorder WebM has no duration and no cues: a copy through ffmpeg adds both (seeking works in players)
    const tmp = `${f.path}.part.webm`;
    const remux = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', f.path, '-c', 'copy', tmp], { timeout: 120000 }).catch((e) => ({ code: 1, stderr: e.message }));
    if (remux.code === 0 && fs.existsSync(tmp)) await fsp.rename(tmp, f.path).catch(() => {});
    else await fsp.rm(tmp, { force: true }).catch(() => {});
    if (opts && opts.mp4) {
      const mp4 = await uniquePath(path.dirname(f.path), path.basename(f.path, '.webm'), 'mp4');
      const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', f.path, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
        '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', mp4];
      const conv = await run('ffmpeg', args, { timeout: 30 * 60000 }).catch((e) => ({ code: 1, stderr: e.message }));
      if (conv.code === 0 && fs.existsSync(mp4)) {
        await fsp.rm(f.path, { force: true }).catch(() => {});
        out.path = mp4;
        out.format = 'mp4';
      } else {
        console.warn('[screenrec] MP4 conversion failed', String(conv.stderr || '').slice(0, 400));
        await fsp.rm(mp4, { force: true }).catch(() => {});
        out.warning = 'EMP4';
        out.detail = String(conv.stderr || '').trim().split('\n').slice(-3).join(' ').slice(0, 300);
      }
    }
    try {
      out.size = (await fsp.stat(out.path)).size;
    } catch {}
    return out;
  });
};
