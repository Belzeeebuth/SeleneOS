'use strict';
// File-system API for the shell and apps.
//
//   fs:home                       -> '/home/user'
//   fs:xdg                        -> { home, desktop, documents, downloads, pictures, music, videos, trash }
//   fs:list (dir, {hidden})       -> [Entry]   Entry = {name, path, dir, size, mtime, ctime, mode, link, hidden, ext}
//   fs:stat (path)                -> Entry | null
//   fs:exists (path)              -> boolean
//   fs:readText (path, {maxBytes}) -> string
//   fs:writeText (path, text)     -> Entry
//   fs:readBytes (path)           -> Uint8Array
//   fs:writeBytes (path, bytes|dataURL) -> Entry
//   fs:mkdir (path)               -> Entry
//   fs:uniqueName (dir, name)     -> 'name (2).txt' style free name
//   fs:rename (from, newName|newPath) -> Entry
//   fs:copy (srcs, destDir, {move, opId}) -> [newPaths]   progress events 'fs:progress' {opId, done, total, name}
//   fs:trash (paths)              -> count     (XDG trash in ~/.local/share/Trash)
//   fs:trashList                  -> [{name, path, originalPath, deletedAt, dir, size}]
//   fs:trashRestore (names)       -> count
//   fs:trashEmpty                 -> count
//   fs:delete (paths)             -> count     (permanent)
//   fs:search (root, query, {limit, hidden, timeoutMs}) -> [Entry]
//   fs:watch (dir) -> watchId ; events 'fs:changed' {watchId, dir} ; fs:unwatch (watchId)
//   fs:drives                     -> [Drive]   Drive = {id, label, device, mountpoint, size, free, fstype, removable, kind, mounted}
//   fs:mount (device) / fs:unmount (device) / fs:eject (device)
//   fs:usage (path)               -> {size, free, used}
//   fs:dirSize (path)             -> {bytes, files, dirs}
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { run } = require('../lib/exec');

const HOME = os.homedir();

function entryOf(p, st, lst) {
  const name = path.basename(p) || p;
  return {
    name,
    path: p,
    dir: st.isDirectory(),
    size: st.isDirectory() ? 0 : st.size,
    mtime: st.mtimeMs,
    ctime: st.ctimeMs,
    mode: st.mode,
    link: !!lst?.isSymbolicLink(),
    hidden: name.startsWith('.'),
    ext: st.isDirectory() ? '' : path.extname(name).toLowerCase(),
  };
}

async function statEntry(p) {
  const lst = await fsp.lstat(p);
  let st = lst;
  if (lst.isSymbolicLink()) {
    try {
      st = await fsp.stat(p);
    } catch {
      st = lst;
    }
  }
  return entryOf(p, st, lst);
}

function readUserDirs() {
  const dirs = {
    desktop: path.join(HOME, 'Desktop'),
    documents: path.join(HOME, 'Documents'),
    downloads: path.join(HOME, 'Downloads'),
    pictures: path.join(HOME, 'Pictures'),
    music: path.join(HOME, 'Music'),
    videos: path.join(HOME, 'Videos'),
  };
  try {
    const txt = fs.readFileSync(path.join(HOME, '.config', 'user-dirs.dirs'), 'utf8');
    const map = { DESKTOP: 'desktop', DOCUMENTS: 'documents', DOWNLOAD: 'downloads', PICTURES: 'pictures', MUSIC: 'music', VIDEOS: 'videos' };
    for (const line of txt.split('\n')) {
      const m = /^XDG_(\w+)_DIR="(.*)"/.exec(line.trim());
      if (m && map[m[1]]) dirs[map[m[1]]] = m[2].replace('$HOME', HOME);
    }
  } catch {}
  return dirs;
}

const TRASH = path.join(HOME, '.local', 'share', 'Trash');
const TRASH_FILES = path.join(TRASH, 'files');
const TRASH_INFO = path.join(TRASH, 'info');

async function uniqueName(dir, name, style = 'paren') {
  const ext = path.extname(name);
  const stem = ext && ext !== name ? name.slice(0, -ext.length) : name;
  let candidate = name;
  for (let i = 2; i < 10000; i++) {
    try {
      await fsp.lstat(path.join(dir, candidate));
    } catch {
      return candidate;
    }
    candidate = style === 'copy' ? `${stem} - Copy${i > 2 ? ` (${i - 1})` : ''}${ext}` : `${stem} (${i})${ext}`;
  }
  throw new Error('Could not find a free name');
}

async function countItems(p) {
  const st = await fsp.lstat(p);
  if (!st.isDirectory()) return 1;
  let n = 1;
  for (const e of await fsp.readdir(p)) n += await countItems(path.join(p, e));
  return n;
}

async function copyRecursive(src, dest, tick) {
  const st = await fsp.lstat(src);
  if (st.isSymbolicLink()) {
    await fsp.symlink(await fsp.readlink(src), dest);
  } else if (st.isDirectory()) {
    await fsp.mkdir(dest, { recursive: true });
    for (const e of await fsp.readdir(src)) await copyRecursive(path.join(src, e), path.join(dest, e), tick);
  } else {
    await fsp.copyFile(src, dest);
    try {
      await fsp.utimes(dest, st.atime, st.mtime);
    } catch {}
  }
  tick(path.basename(src));
}

function trashDate(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

async function moveAcross(src, dest) {
  try {
    await fsp.rename(src, dest);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    await copyRecursive(src, dest, () => {});
    await fsp.rm(src, { recursive: true, force: true });
  }
}

module.exports = function register(api) {
  api.handle('fs:home', () => HOME);
  api.handle('fs:xdg', async () => {
    const d = readUserDirs();
    for (const p of Object.values(d)) {
      try {
        await fsp.mkdir(p, { recursive: true });
      } catch {}
    }
    return { home: HOME, ...d, trash: TRASH_FILES };
  });

  api.handle('fs:list', async (dir, opts = {}) => {
    const names = await fsp.readdir(dir);
    const out = [];
    await Promise.all(
      names.map(async (n) => {
        if (!opts.hidden && n.startsWith('.')) return;
        try {
          out.push(await statEntry(path.join(dir, n)));
        } catch {}
      }),
    );
    out.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) : a.dir ? -1 : 1));
    return out;
  });

  api.handle('fs:stat', async (p) => {
    try {
      return await statEntry(p);
    } catch {
      return null;
    }
  });
  api.handle('fs:exists', async (p) => {
    try {
      await fsp.lstat(p);
      return true;
    } catch {
      return false;
    }
  });

  api.handle('fs:readText', async (p, opts = {}) => {
    const max = opts.maxBytes ?? 32 * 1024 * 1024;
    const st = await fsp.stat(p);
    if (st.size > max) throw api.error(`File is too large (${st.size} bytes)`, 'ETOOBIG');
    return fsp.readFile(p, 'utf8');
  });
  api.handle('fs:writeText', async (p, text) => {
    await fsp.mkdir(path.dirname(p), { recursive: true });
    await fsp.writeFile(p, String(text ?? ''), 'utf8');
    return statEntry(p);
  });
  api.handle('fs:readBytes', async (p) => new Uint8Array(await fsp.readFile(p)));
  api.handle('fs:writeBytes', async (p, data) => {
    let buf;
    if (typeof data === 'string') {
      const m = /^data:[^;,]*(;base64)?,(.*)$/s.exec(data);
      buf = m ? Buffer.from(m[2], m[1] ? 'base64' : 'utf8') : Buffer.from(data, 'utf8');
    } else if (data instanceof ArrayBuffer) buf = Buffer.from(new Uint8Array(data));
    else buf = Buffer.from(data);
    await fsp.mkdir(path.dirname(p), { recursive: true });
    await fsp.writeFile(p, buf);
    return statEntry(p);
  });
  api.handle('fs:mkdir', async (p) => {
    await fsp.mkdir(p, { recursive: true });
    return statEntry(p);
  });
  api.handle('fs:uniqueName', (dir, name, style) => uniqueName(dir, name, style));

  api.handle('fs:rename', async (from, to) => {
    const dest = to.includes('/') ? to : path.join(path.dirname(from), to);
    if (dest === from) return statEntry(from);
    if (/[\0]/.test(dest) || !path.basename(dest) || path.basename(dest) === '.' || path.basename(dest) === '..') {
      throw api.error('Invalid file name', 'EINVAL');
    }
    try {
      await fsp.lstat(dest);
      if (dest.toLowerCase() !== from.toLowerCase()) throw api.error('A file with that name already exists', 'EEXIST');
    } catch (err) {
      if (err.code === 'EEXIST') throw err;
    }
    await fsp.rename(from, dest);
    return statEntry(dest);
  });

  api.handle('fs:copy', async (srcs, destDir, opts = {}, event) => {
    const list = Array.isArray(srcs) ? srcs : [srcs];
    const opId = opts.opId || `op${Date.now()}`;
    let total = 0;
    for (const s of list) total += await countItems(s).catch(() => 1);
    let done = 0;
    let last = 0;
    const tick = (name) => {
      done++;
      const now = Date.now();
      if (now - last > 120 || done === total) {
        last = now;
        api.sendTo(event?.sender, 'fs:progress', { opId, done, total, name });
      }
    };
    const results = [];
    for (const src of list) {
      const resolvedDest = path.resolve(destDir);
      if (opts.move && path.dirname(path.resolve(src)) === resolvedDest) {
        results.push(src);
        continue;
      }
      if (resolvedDest === path.resolve(src) || resolvedDest.startsWith(path.resolve(src) + path.sep)) {
        throw api.error('Cannot copy a folder into itself', 'EINVAL');
      }
      const sameDir = path.dirname(path.resolve(src)) === resolvedDest;
      const name = await uniqueName(destDir, path.basename(src), sameDir ? 'copy' : 'paren');
      const dest = path.join(destDir, name);
      if (opts.move) {
        await moveAcross(src, dest);
        tick(name);
      } else {
        await copyRecursive(src, dest, tick);
      }
      results.push(dest);
    }
    api.sendTo(event?.sender, 'fs:progress', { opId, done: total, total, finished: true });
    return results;
  });

  api.handle('fs:trash', async (paths) => {
    await fsp.mkdir(TRASH_FILES, { recursive: true });
    await fsp.mkdir(TRASH_INFO, { recursive: true });
    let n = 0;
    for (const p of Array.isArray(paths) ? paths : [paths]) {
      const abs = path.resolve(p);
      if (abs.startsWith(TRASH)) {
        await fsp.rm(abs, { recursive: true, force: true });
        n++;
        continue;
      }
      const name = await uniqueName(TRASH_FILES, path.basename(abs));
      const info = `[Trash Info]\nPath=${encodeURI(abs)}\nDeletionDate=${trashDate()}\n`;
      await fsp.writeFile(path.join(TRASH_INFO, `${name}.trashinfo`), info);
      try {
        await moveAcross(abs, path.join(TRASH_FILES, name));
        n++;
      } catch (err) {
        await fsp.rm(path.join(TRASH_INFO, `${name}.trashinfo`), { force: true });
        throw err;
      }
    }
    api.broadcast('fs:trash-changed', {});
    return n;
  });

  api.handle('fs:trashList', async () => {
    let names = [];
    try {
      names = await fsp.readdir(TRASH_FILES);
    } catch {
      return [];
    }
    const out = [];
    for (const name of names) {
      const p = path.join(TRASH_FILES, name);
      let originalPath = '';
      let deletedAt = 0;
      try {
        const info = await fsp.readFile(path.join(TRASH_INFO, `${name}.trashinfo`), 'utf8');
        originalPath = decodeURI((/^Path=(.*)$/m.exec(info) || [])[1] || '');
        deletedAt = Date.parse((/^DeletionDate=(.*)$/m.exec(info) || [])[1] || '') || 0;
      } catch {}
      try {
        const e = await statEntry(p);
        out.push({ ...e, originalPath, deletedAt });
      } catch {}
    }
    return out.sort((a, b) => b.deletedAt - a.deletedAt);
  });

  api.handle('fs:trashRestore', async (names) => {
    let n = 0;
    for (const name of Array.isArray(names) ? names : [names]) {
      const infoFile = path.join(TRASH_INFO, `${name}.trashinfo`);
      let orig;
      try {
        orig = decodeURI((/^Path=(.*)$/m.exec(await fsp.readFile(infoFile, 'utf8')) || [])[1] || '');
      } catch {}
      if (!orig) orig = path.join(HOME, name);
      await fsp.mkdir(path.dirname(orig), { recursive: true });
      const dest = path.join(path.dirname(orig), await uniqueName(path.dirname(orig), path.basename(orig)));
      await moveAcross(path.join(TRASH_FILES, name), dest);
      await fsp.rm(infoFile, { force: true });
      n++;
    }
    api.broadcast('fs:trash-changed', {});
    return n;
  });

  api.handle('fs:trashEmpty', async () => {
    let n = 0;
    try {
      n = (await fsp.readdir(TRASH_FILES)).length;
    } catch {}
    await fsp.rm(TRASH_FILES, { recursive: true, force: true });
    await fsp.rm(TRASH_INFO, { recursive: true, force: true });
    await fsp.mkdir(TRASH_FILES, { recursive: true });
    await fsp.mkdir(TRASH_INFO, { recursive: true });
    api.broadcast('fs:trash-changed', {});
    return n;
  });

  api.handle('fs:delete', async (paths) => {
    let n = 0;
    for (const p of Array.isArray(paths) ? paths : [paths]) {
      if (path.resolve(p) === '/' || path.resolve(p) === HOME) throw api.error('Refusing to delete this folder', 'EPERM');
      await fsp.rm(p, { recursive: true, force: true });
      n++;
    }
    return n;
  });

  api.handle('fs:search', async (root, query, opts = {}) => {
    const limit = opts.limit ?? 300;
    const deadline = Date.now() + (opts.timeoutMs ?? 8000);
    const q = String(query || '').toLowerCase().trim();
    if (!q) return [];
    const words = q.split(/\s+/);
    const results = [];
    const queue = [root];
    const SKIP = new Set(['node_modules', 'proc', 'sys', 'dev', '.cache', '.git', 'Trash']);
    while (queue.length && results.length < limit && Date.now() < deadline) {
      const dir = queue.shift();
      let dh;
      try {
        dh = await fsp.opendir(dir);
      } catch {
        continue;
      }
      for await (const d of dh) {
        if (!opts.hidden && d.name.startsWith('.')) continue;
        const p = path.join(dir, d.name);
        const lname = d.name.toLowerCase();
        if (words.every((w) => lname.includes(w))) {
          try {
            results.push(await statEntry(p));
          } catch {}
          if (results.length >= limit) break;
        }
        if (d.isDirectory() && !SKIP.has(d.name)) queue.push(p);
      }
    }
    return results;
  });

  const watchers = new Map();
  let watchSeq = 0;
  api.handle('fs:watch', (dir, event) => {
    const id = `w${++watchSeq}`;
    let timer = null;
    try {
      const w = fs.watch(dir, { persistent: false }, () => {
        clearTimeout(timer);
        timer = setTimeout(() => api.sendTo(event?.sender, 'fs:changed', { watchId: id, dir }), 120);
      });
      w.on('error', () => {});
      watchers.set(id, w);
    } catch (err) {
      throw api.error(`Cannot watch ${dir}: ${err.message}`, err.code);
    }
    return id;
  });
  api.handle('fs:unwatch', (id) => {
    watchers.get(id)?.close();
    watchers.delete(id);
    return true;
  });

  api.handle('fs:usage', async (p = '/') => {
    const s = await fsp.statfs(p);
    const size = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    return { size, free, used: size - s.bfree * s.bsize };
  });

  api.handle('fs:dirSize', async (p) => {
    let bytes = 0;
    let files = 0;
    let dirs = 0;
    const deadline = Date.now() + 10000;
    const walk = async (d) => {
      if (Date.now() > deadline) return;
      let list;
      try {
        list = await fsp.readdir(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of list) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) {
          dirs++;
          await walk(full);
        } else {
          files++;
          try {
            bytes += (await fsp.lstat(full)).size;
          } catch {}
        }
      }
    };
    const st = await fsp.lstat(p);
    if (st.isDirectory()) await walk(p);
    else {
      bytes = st.size;
      files = 1;
    }
    return { bytes, files, dirs };
  });

  api.handle('fs:drives', async () => {
    const drives = [];
    try {
      const rootStat = await fsp.statfs('/');
      drives.push({
        id: 'root',
        label: null,
        device: '',
        mountpoint: '/',
        size: rootStat.blocks * rootStat.bsize,
        free: rootStat.bavail * rootStat.bsize,
        fstype: '',
        removable: false,
        kind: 'system',
        mounted: true,
      });
    } catch {}
    try {
      const { stdout } = await run('lsblk', ['-J', '-b', '-o', 'NAME,PATH,SIZE,TYPE,FSTYPE,LABEL,MOUNTPOINT,RM,HOTPLUG,MODEL,TRAN,FSAVAIL,RO']);
      const data = JSON.parse(stdout);
      const walk = (node, parent) => {
        const isPart = node.type === 'part' || (node.type === 'disk' && node.fstype) || node.type === 'rom' || node.type === 'crypt' || node.type === 'lvm';
        if (isPart && node.fstype && !['swap', 'squashfs', 'LVM2_member', 'crypto_LUKS'].includes(node.fstype)) {
          const mp = node.mountpoint || null;
          if (mp === '/' || (mp && /^\/(boot|run\/live|cdrom|rofs|media\/root-ro|snap)/.test(mp) && mp !== '/cdrom')) {
            if (mp === '/' && drives[0]) {
              drives[0].device = node.path;
              drives[0].fstype = node.fstype;
              drives[0].label = node.label || null;
            }
          } else if (!(mp && mp.startsWith('/boot'))) {
            const removable = !!(node.rm || node.hotplug || parent?.rm || parent?.hotplug || node.tran === 'usb' || parent?.tran === 'usb');
            drives.push({
              id: node.path,
              label: node.label || null,
              device: node.path,
              mountpoint: mp,
              size: Number(node.size) || 0,
              free: node.fsavail != null ? Number(node.fsavail) : null,
              fstype: node.fstype,
              removable,
              kind: node.type === 'rom' ? 'optical' : removable ? 'usb' : 'disk',
              model: parent?.model || node.model || '',
              mounted: !!mp,
              readonly: !!node.ro,
            });
          }
        }
        for (const c of node.children || []) walk(c, node);
      };
      for (const d of data.blockdevices || []) walk(d, null);
    } catch {}
    return drives;
  });

  api.handle('fs:mount', async (device) => {
    const r = await run('udisksctl', ['mount', '-b', device, '--no-user-interaction'], { timeout: 30000 });
    if (r.code !== 0) throw api.error(r.stderr.trim() || 'Mount failed', 'EMOUNT');
    const m = /at (.+?)\.?\s*$/.exec(r.stdout.trim());
    return m ? m[1] : null;
  });
  api.handle('fs:unmount', async (device) => {
    const r = await run('udisksctl', ['unmount', '-b', device, '--no-user-interaction'], { timeout: 30000 });
    if (r.code !== 0) throw api.error(r.stderr.trim() || 'Unmount failed', 'EMOUNT');
    return true;
  });
  api.handle('fs:eject', async (device) => {
    await run('udisksctl', ['unmount', '-b', device, '--no-user-interaction'], { timeout: 30000 }).catch(() => {});
    const r = await run('udisksctl', ['power-off', '-b', device.replace(/\d+$/, ''), '--no-user-interaction'], { timeout: 30000 });
    if (r.code !== 0) throw api.error(r.stderr.trim() || 'Eject failed', 'EMOUNT');
    return true;
  });
};
