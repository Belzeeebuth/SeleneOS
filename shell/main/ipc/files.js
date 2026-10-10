'use strict';
// File Explorer helpers (complements fs.js, which stays the generic file API).
//
//   files:recent ({limit})                -> [Entry]  recently modified files under the user's folders
//   files:props (path)                    -> Entry + {atime, birthtime, sizeOnDisk, owner, group, uid, gid,
//                                             nlink, readonly, target, writable, dev}
//   files:dirStats (paths, {opId})        -> {bytes, disk, files, dirs}; live 'files:dirStats' {opId, ...partial}
//   files:transfer (srcs, destDir, {move, opId}) -> [newPaths]
//                                            progress 'files:progress' {opId, phase, done, total, bytes, totalBytes, name}
//                                            same conflict naming as fs:copy ("name (2)" / "name - Copy")
//   files:cancel (opId)                   -> true   (transfer, dirStats, extract, compress)
//   files:chmod (path, mode)              -> Entry
//   files:head (path, maxBytes)           -> {text, binary, truncated, size}  first bytes for the preview pane
//   files:thumb (path, size)              -> path of a cached video thumbnail (ffmpegthumbnailer/ffmpeg) or null
//   files:extract (archive, destDir, {opId}) -> folder path   (.zip via unzip/python3, .tar.* via tar)
//   files:compress (paths, zipPath, {opId})  -> zip path      (zip or python3 zipfile)
//   files:drivesWatch ()                  -> true ; broadcasts 'files:drives-changed' when mounts/disks change
//   files:mounts (paths)                  -> {path: mountpoint}  (longest mount prefix, to tell move from copy)
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { which } = require('../lib/exec');

const HOME = os.homedir();
const THUMBS = path.join(HOME, '.cache', 'aurora', 'thumbnails');
const ops = new Map(); // opId -> { canceled, child }

function canceledError() {
  const e = new Error('The operation was canceled');
  e.code = 'ECANCELED';
  e.quiet = true;
  return e;
}

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
  return { entry: entryOf(p, st, lst), st, lst };
}

function userDirs() {
  const dirs = ['Desktop', 'Documents', 'Downloads', 'Pictures', 'Music', 'Videos'].map((d) => path.join(HOME, d));
  try {
    const txt = fs.readFileSync(path.join(HOME, '.config', 'user-dirs.dirs'), 'utf8');
    for (const line of txt.split('\n')) {
      const m = /^XDG_(\w+)_DIR="(.*)"/.exec(line.trim());
      if (m && ['DESKTOP', 'DOCUMENTS', 'DOWNLOAD', 'PICTURES', 'MUSIC', 'VIDEOS'].includes(m[1])) {
        const p = m[2].replace('$HOME', HOME);
        if (!dirs.includes(p) && p !== HOME) dirs.push(p);
      }
    }
  } catch {}
  return dirs;
}

// ---------------------------------------------------------------- users / groups (for Properties)
let idCache = null;
function idNames() {
  if (idCache && Date.now() - idCache.at < 60000) return idCache;
  const parse = (file) => {
    const map = new Map();
    try {
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        const f = line.split(':');
        if (f.length > 2) map.set(Number(f[2]), f[0]);
      }
    } catch {}
    return map;
  };
  idCache = { users: parse('/etc/passwd'), groups: parse('/etc/group'), at: Date.now() };
  return idCache;
}

// ---------------------------------------------------------------- naming (mirrors fs.js)
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

// ---------------------------------------------------------------- transfer (copy / move with progress + cancel)
async function scan(p, acc, op) {
  if (op.canceled) throw canceledError();
  const st = await fsp.lstat(p);
  acc.items++;
  if (st.isDirectory()) {
    for (const e of await fsp.readdir(p)) await scan(path.join(p, e), acc, op);
  } else if (st.isFile()) acc.bytes += st.size;
}

const BIG = 4 * 1024 * 1024;
const CHUNK = 1024 * 1024;

async function copyFileChunked(src, dest, st, op) {
  const fin = await fsp.open(src, 'r');
  let fout = null;
  try {
    fout = await fsp.open(dest, 'wx', st.mode & 0o7777);
    const buf = Buffer.allocUnsafe(CHUNK);
    let pos = 0;
    for (;;) {
      if (op.canceled) throw canceledError();
      const { bytesRead } = await fin.read(buf, 0, CHUNK, pos);
      if (!bytesRead) break;
      let off = 0;
      while (off < bytesRead) {
        const { bytesWritten } = await fout.write(buf, off, bytesRead - off);
        off += bytesWritten;
      }
      pos += bytesRead;
      op.bytes += bytesRead;
      op.report(path.basename(src));
    }
  } catch (err) {
    await fout?.close().catch(() => {});
    fout = null;
    await fsp.rm(dest, { force: true }).catch(() => {});
    throw err;
  } finally {
    await fin.close().catch(() => {});
    await fout?.close().catch(() => {});
  }
}

async function copyRecursive(src, dest, op) {
  if (op.canceled) throw canceledError();
  const st = await fsp.lstat(src);
  if (st.isSymbolicLink()) {
    await fsp.symlink(await fsp.readlink(src), dest);
  } else if (st.isDirectory()) {
    await fsp.mkdir(dest, { recursive: true });
    for (const e of await fsp.readdir(src)) await copyRecursive(path.join(src, e), path.join(dest, e), op);
    try {
      await fsp.chmod(dest, st.mode & 0o7777);
    } catch {}
  } else if (st.isFile()) {
    if (st.size >= BIG) await copyFileChunked(src, dest, st, op);
    else {
      await fsp.copyFile(src, dest, fs.constants.COPYFILE_EXCL);
      op.bytes += st.size;
    }
    try {
      await fsp.utimes(dest, st.atime, st.mtime);
    } catch {}
  }
  op.done++;
  op.report(path.basename(src));
}

module.exports = function register(api) {
  function makeOp(opId, sender, channel = 'files:progress') {
    const op = {
      id: opId,
      canceled: false,
      child: null,
      done: 0,
      total: 0,
      bytes: 0,
      totalBytes: 0,
      phase: 'scan',
      last: 0,
      report(name, force) {
        const now = Date.now();
        if (!force && now - op.last < 100) return;
        op.last = now;
        api.sendTo(sender, channel, { opId, phase: op.phase, done: op.done, total: op.total, bytes: op.bytes, totalBytes: op.totalBytes, name });
      },
    };
    ops.set(opId, op);
    return op;
  }

  api.handle('files:cancel', (opId) => {
    const op = ops.get(opId);
    if (op) {
      op.canceled = true;
      try {
        op.child?.kill('SIGTERM');
      } catch {}
    }
    return true;
  });

  api.handle('files:transfer', async (srcs, destDir, opts = {}, event) => {
    const list = (Array.isArray(srcs) ? srcs : [srcs]).map((s) => path.resolve(s));
    const dest = path.resolve(destDir);
    const op = makeOp(opts.opId || `op${Date.now()}`, event?.sender);
    try {
      const st = await fsp.stat(dest);
      if (!st.isDirectory()) throw api.error('The destination is not a folder', 'ENOTDIR');
      for (const src of list) {
        if (dest === src || dest.startsWith(src + path.sep)) {
          throw api.error('The destination folder is a subfolder of the source folder.', 'ESUBFOLDER');
        }
      }
      // Moves within one file system are instant renames: no need to scan.
      const acc = { items: 0, bytes: 0 };
      if (!opts.move) for (const s of list) await scan(s, acc, op);
      else acc.items = list.length;
      op.total = acc.items;
      op.totalBytes = acc.bytes;
      op.phase = 'copy';
      op.report('', true);
      const results = [];
      for (const src of list) {
        if (op.canceled) throw canceledError();
        const sameDir = path.dirname(src) === dest;
        if (opts.move && sameDir) {
          results.push(src);
          continue;
        }
        const name = await uniqueName(dest, path.basename(src), sameDir ? 'copy' : 'paren');
        const target = path.join(dest, name);
        if (opts.move) {
          try {
            await fsp.rename(src, target);
            op.done++;
          } catch (err) {
            if (err.code !== 'EXDEV') throw err;
            // Different file system: copy then delete, with real progress.
            const sub = { items: 0, bytes: 0 };
            await scan(src, sub, op);
            op.total += sub.items - 1;
            op.totalBytes += sub.bytes;
            try {
              await copyRecursive(src, target, op);
            } catch (e) {
              await fsp.rm(target, { recursive: true, force: true }).catch(() => {});
              throw e;
            }
            await fsp.rm(src, { recursive: true, force: true });
          }
        } else {
          await copyRecursive(src, target, op);
        }
        results.push(target);
        op.report(name);
      }
      op.phase = 'done';
      op.report('', true);
      return results;
    } finally {
      ops.delete(op.id);
    }
  });

  api.handle('files:recent', async (opts = {}) => {
    const limit = opts.limit ?? 20;
    const deadline = Date.now() + (opts.timeoutMs ?? 2500);
    const found = [];
    const SKIP = new Set(['node_modules', '.git', '__pycache__', 'Trash']);
    const walk = async (dir, depth) => {
      if (Date.now() > deadline || found.length > 4000) return;
      let list;
      try {
        list = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const d of list) {
        if (d.name.startsWith('.') || SKIP.has(d.name)) continue;
        const p = path.join(dir, d.name);
        if (d.isDirectory()) {
          if (depth < 4) await walk(p, depth + 1);
        } else if (d.isFile()) {
          try {
            const { entry } = await statEntry(p);
            found.push(entry);
          } catch {}
        }
      }
    };
    for (const d of userDirs()) await walk(d, 0);
    // Loose files directly in the home folder count too.
    try {
      for (const d of await fsp.readdir(HOME, { withFileTypes: true })) {
        if (d.isFile() && !d.name.startsWith('.')) {
          try {
            found.push((await statEntry(path.join(HOME, d.name))).entry);
          } catch {}
        }
      }
    } catch {}
    found.sort((a, b) => b.mtime - a.mtime);
    return found.slice(0, limit);
  });

  api.handle('files:props', async (p) => {
    const { entry, st, lst } = await statEntry(p);
    const ids = idNames();
    let target = null;
    if (lst.isSymbolicLink()) {
      try {
        target = await fsp.readlink(p);
      } catch {}
    }
    let writable = true;
    try {
      await fsp.access(p, fs.constants.W_OK);
    } catch {
      writable = false;
    }
    return {
      ...entry,
      atime: st.atimeMs,
      birthtime: st.birthtimeMs || st.ctimeMs,
      sizeOnDisk: st.isDirectory() ? 0 : (st.blocks ?? Math.ceil(st.size / 4096) * 8) * 512,
      uid: st.uid,
      gid: st.gid,
      owner: ids.users.get(st.uid) ?? String(st.uid),
      group: ids.groups.get(st.gid) ?? String(st.gid),
      nlink: st.nlink,
      readonly: (st.mode & 0o200) === 0,
      writable,
      target,
      dev: st.dev,
    };
  });

  api.handle('files:dirStats', async (paths, opts = {}, event) => {
    const op = makeOp(opts.opId || `ds${Date.now()}`, event?.sender, 'files:dirStats');
    const acc = { bytes: 0, disk: 0, files: 0, dirs: 0 };
    let last = 0;
    const tick = () => {
      const now = Date.now();
      if (now - last > 150) {
        last = now;
        api.sendTo(event?.sender, 'files:dirStats', { opId: op.id, ...acc, partial: true });
      }
    };
    const walk = async (d) => {
      if (op.canceled) throw canceledError();
      let list;
      try {
        list = await fsp.readdir(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of list) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) {
          acc.dirs++;
          await walk(full);
        } else {
          acc.files++;
          try {
            const s = await fsp.lstat(full);
            acc.bytes += s.size;
            acc.disk += (s.blocks ?? 0) * 512;
          } catch {}
          tick();
        }
      }
    };
    try {
      for (const p of Array.isArray(paths) ? paths : [paths]) {
        const st = await fsp.lstat(p);
        if (st.isDirectory()) {
          if ((Array.isArray(paths) ? paths : [paths]).length > 1) acc.dirs++;
          await walk(p);
        } else {
          acc.files++;
          acc.bytes += st.size;
          acc.disk += (st.blocks ?? 0) * 512;
        }
      }
      return acc;
    } finally {
      ops.delete(op.id);
    }
  });

  // First bytes of a file for the preview pane (fs:readText refuses files above maxBytes).
  api.handle('files:head', async (p, max = 65536) => {
    const fh = await fsp.open(p, 'r');
    try {
      const size = (await fh.stat()).size;
      const buf = Buffer.alloc(Math.min(Math.max(1024, Number(max) || 65536), 1024 * 1024));
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      const slice = buf.subarray(0, bytesRead);
      const binary = slice.includes(0);
      return { text: binary ? '' : slice.toString('utf8'), binary, truncated: size > bytesRead, size };
    } finally {
      await fh.close();
    }
  });

  api.handle('files:chmod', async (p, mode) => {
    await fsp.chmod(p, Number(mode) & 0o7777);
    return (await statEntry(p)).entry;
  });

  api.handle('files:mounts', async (paths) => {
    let mounts = ['/'];
    try {
      mounts = fs
        .readFileSync('/proc/self/mounts', 'utf8')
        .split('\n')
        .map((l) => l.split(' ')[1])
        .filter(Boolean)
        .map((m) => m.replace(/\\040/g, ' '));
    } catch {}
    const out = {};
    for (const p of paths || []) {
      let best = '/';
      for (const m of mounts) if ((p === m || p.startsWith(m.endsWith('/') ? m : `${m}/`)) && m.length > best.length) best = m;
      out[p] = best;
    }
    return out;
  });

  // Video thumbnails (images are displayed directly by the renderer).
  api.handle('files:thumb', async (p, size = 256) => {
    let st;
    try {
      st = await fsp.stat(p);
    } catch {
      return null;
    }
    const key = crypto.createHash('sha1').update(`${p}|${st.mtimeMs}|${st.size}|${size}`).digest('hex');
    const out = path.join(THUMBS, `${key}.png`);
    try {
      await fsp.access(out);
      return out;
    } catch {}
    await fsp.mkdir(THUMBS, { recursive: true });
    const tool = which('ffmpegthumbnailer');
    const ff = which('ffmpeg');
    let args;
    let bin;
    if (tool) {
      bin = tool;
      args = ['-i', p, '-o', out, '-s', String(size), '-t', '10%', '-c', 'png'];
    } else if (ff) {
      bin = ff;
      args = ['-v', 'error', '-ss', '1', '-i', p, '-frames:v', '1', '-vf', `scale=${size}:-2`, '-y', out];
    } else return null;
    const ok = await new Promise((resolve) => {
      const child = spawn(bin, args, { stdio: 'ignore' });
      const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
      child.on('error', () => resolve(false));
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve(code === 0);
      });
    });
    if (!ok) {
      // ffmpeg -ss past the end of very short clips produces nothing: retry from the start.
      if (bin === ff) {
        const ok2 = await new Promise((resolve) => {
          const child = spawn(ff, ['-v', 'error', '-i', p, '-frames:v', '1', '-vf', `scale=${size}:-2`, '-y', out], { stdio: 'ignore' });
          child.on('error', () => resolve(false));
          child.on('close', (code) => resolve(code === 0));
        });
        if (ok2) return out;
      }
      return null;
    }
    try {
      await fsp.access(out);
      return out;
    } catch {
      return null;
    }
  });

  function runOp(op, bin, args, cwd) {
    return new Promise((resolve, reject) => {
      const child = spawn(bin, args, { cwd, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, LC_ALL: 'C' } });
      op.child = child;
      let err = '';
      child.stderr.on('data', (d) => (err += d));
      child.on('error', (e) => reject(e));
      child.on('close', (code) => {
        if (op.canceled) return reject(canceledError());
        if (code === 0) resolve();
        else reject(api.error((err || `${path.basename(bin)} failed`).trim().split('\n').slice(-3).join('\n'), 'EARCHIVE'));
      });
    });
  }

  const TAR_EXT = /\.(tar|tar\.gz|tgz|tar\.xz|txz|tar\.bz2|tbz2?|tar\.zst|tzst)$/i;

  api.handle('files:extract', async (archive, destDir, opts = {}, event) => {
    const op = makeOp(opts.opId || `ex${Date.now()}`, event?.sender);
    try {
      const base = path.basename(archive).replace(TAR_EXT, '').replace(/\.zip$/i, '');
      const parent = destDir || path.dirname(archive);
      const dest = opts.exact ? parent : path.join(parent, await uniqueName(parent, base || 'Extracted'));
      await fsp.mkdir(dest, { recursive: true });
      try {
        if (/\.zip$/i.test(archive)) {
          const unzip = which('unzip');
          if (unzip) await runOp(op, unzip, ['-q', '-n', archive, '-d', dest]);
          else await runOp(op, which('python3') || 'python3', ['-m', 'zipfile', '-e', archive, dest]);
        } else if (TAR_EXT.test(archive)) {
          await runOp(op, which('tar') || 'tar', ['-xf', archive, '-C', dest]);
        } else {
          throw api.error('This archive format is not supported', 'EFORMAT');
        }
      } catch (err) {
        if (!opts.exact) await fsp.rm(dest, { recursive: true, force: true }).catch(() => {});
        throw err;
      }
      return dest;
    } finally {
      ops.delete(op.id);
    }
  });

  api.handle('files:compress', async (paths, zipPath, opts = {}, event) => {
    const op = makeOp(opts.opId || `zp${Date.now()}`, event?.sender);
    try {
      const list = Array.isArray(paths) ? paths : [paths];
      const cwd = path.dirname(list[0]);
      if (list.some((p) => path.dirname(p) !== cwd)) throw api.error('All items must be in the same folder', 'EINVAL');
      const zip = which('zip');
      try {
        if (zip) await runOp(op, zip, ['-q', '-r', '-y', zipPath, ...list.map((p) => path.basename(p))], cwd);
        else await runOp(op, which('python3') || 'python3', ['-m', 'zipfile', '-c', zipPath, ...list.map((p) => path.basename(p))], cwd);
      } catch (err) {
        await fsp.rm(zipPath, { force: true }).catch(() => {});
        throw err;
      }
      return zipPath;
    } finally {
      ops.delete(op.id);
    }
  });

  // Mount / disk changes: cheap polling of /proc/self/mounts and /sys/block, started on demand.
  let drivesTimer = null;
  let drivesSig = '';
  const signature = () => {
    let s = '';
    try {
      s += fs.readFileSync('/proc/self/mounts', 'utf8');
    } catch {}
    try {
      s += fs.readdirSync('/sys/block').join(',');
    } catch {}
    return s;
  };
  api.handle('files:drivesWatch', () => {
    if (drivesTimer) return true;
    drivesSig = signature();
    drivesTimer = setInterval(() => {
      const s = signature();
      if (s !== drivesSig) {
        drivesSig = s;
        api.broadcast('files:drives-changed', {});
      }
    }, 2000);
    drivesTimer.unref?.();
    return true;
  });
};
