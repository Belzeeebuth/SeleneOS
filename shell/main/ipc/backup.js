'use strict';
// Backup backend (renderer/apps/backup): incremental snapshots of home folders with rsync (no root).
//
// Each run copies the chosen sources (folders inside the home folder) into
//   <dest>/SeleneBackup/<YYYY-MM-DD_HHMMSS>/<path relative to home>/…
// with `rsync -a --relative --link-dest=<previous snapshot>`: unchanged files are hard links to the previous
// snapshot, so every snapshot is a complete tree but only new data takes space. A run writes to "<stamp>.partial"
// and renames it when rsync succeeds; a canceled or failed run removes it. Caches are excluded (.cache, Trash,
// .local/share/Trash, .Trash-*, node_modules). Each snapshot holds ".aurora-snapshot.json" (date, sources, files,
// bytes, newBytes, durationMs, warnings). AURORA_BACKUP_BWLIMIT (KB/s, tests only) slows rsync down.
//
// Settings: ~/.config/aurora/backup.json  { sources: [abs paths], dest: abs path | null, keep: N (0 = all),
//   reminder: 'off' | 'daily' | 'weekly', lastRun: ms | null }
//
//   backup:config ()                        -> { config, home, defaults: [abs paths], rsync: bool, running }
//   backup:setConfig (patch)                -> config   (sources / dest validated; EINVAL, ESOURCE, EDEST…)
//   backup:validate ({ sources, dest })     -> { ok, errors: [{ code, path }] }
//   backup:start ({ opId })                 -> { id, path, files, bytes, newBytes, durationMs, warnings, pruned }
//   backup:cancel (opId)                    -> true
//   backup:list ()                          -> { dest, root, snapshots: [{ id, date, files, bytes, newBytes, sources }] }
//   backup:browse (id, rel)                 -> [{ name, rel, dir, size, mtime }]   (rel: '' = snapshot root)
//   backup:restore (id, rels, { to: 'original' | 'folder', folder, overwrite })
//                                           -> { restored: n, conflicts: [rel] }   (conflicts and !overwrite: nothing done)
//   backup:delete (ids)                     -> { deleted: [id] }
//   backup:prune (keep)                     -> { deleted: [id] }
//   event 'backup:progress' { opId, phase: 'scan'|'copy'|'finish'|'done', percent (0..1), bytes, speed, eta }
// Error codes: EINVAL ESOURCE (source missing / outside home) EDEST (destination missing / not writable / inside a
// source) ENODEST (no destination set) EBUSY (a backup is running) ENORSYNC ECANCELED ERSYNC ENOENT.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT_NAME = 'SeleneBackup';
const MANIFEST = '.aurora-snapshot.json';
const STAMP_RE = /^\d{4}-\d{2}-\d{2}_\d{6}(-\d+)?$/;
const EXCLUDES = ['.cache', 'Trash', '.local/share/Trash', '.Trash-*', 'node_modules'];
const DEFAULT_DIRS = ['Documents', 'Pictures', 'Music', 'Videos', 'Desktop'];
const ENV = { ...process.env, LC_ALL: 'C.UTF-8', LANG: 'C.UTF-8', LANGUAGE: '' };

const home = () => os.homedir();
const configFile = () => path.join(home(), '.config', 'aurora', 'backup.json');
const pad = (n, w = 2) => String(n).padStart(w, '0');
function stampOf(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
function err(message, code) {
  const e = new Error(message);
  e.code = code;
  return e;
}
/** true when `child` is `parent` or inside it (both absolute, normalised). */
function inside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}
const realOr = async (p) => fsp.realpath(p).catch(() => path.resolve(p));
const isAbs = (p) => typeof p === 'string' && p.length < 4096 && !p.includes('\0') && path.isAbsolute(p);
/** Real path of `p`, or of its deepest existing ancestor joined with the rest (symlinks resolved). */
async function realDeep(p) {
  let cur = path.resolve(p);
  const rest = [];
  for (;;) {
    try {
      return path.join(await fsp.realpath(cur), ...rest);
    } catch {
      const up = path.dirname(cur);
      if (up === cur) return path.resolve(p);
      rest.unshift(path.basename(cur));
      cur = up;
    }
  }
}
/** Throws EINVAL when `p` (after resolving symlinks) leaves `root` — e.g. a symlink stored in a snapshot. */
async function assertInside(p, root) {
  if (!inside(await realDeep(p), await realOr(root))) throw err('Invalid path', 'EINVAL');
}

/** A relative path inside a snapshot: no '..', not absolute. Returns the normalised form or null. */
function safeRel(rel) {
  if (rel == null || rel === '') return '';
  if (typeof rel !== 'string' || rel.includes('\0') || path.isAbsolute(rel)) return null;
  const n = path.normalize(rel).replace(/\/+$/, '');
  if (n === '.' ) return '';
  if (n.split('/').includes('..')) return null;
  return n;
}

async function readConfig() {
  let c = {};
  try {
    c = JSON.parse(await fsp.readFile(configFile(), 'utf8')) || {};
  } catch {}
  const h = home();
  const sources = Array.isArray(c.sources) ? c.sources.filter(isAbs) : DEFAULT_DIRS.map((d) => path.join(h, d));
  return {
    sources,
    dest: isAbs(c.dest) ? c.dest : null,
    keep: Number.isInteger(c.keep) && c.keep >= 0 && c.keep <= 1000 ? c.keep : 0,
    reminder: ['off', 'daily', 'weekly'].includes(c.reminder) ? c.reminder : 'off',
    lastRun: Number.isFinite(c.lastRun) ? c.lastRun : null,
  };
}
async function writeConfig(c) {
  const f = configFile();
  await fsp.mkdir(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(c, null, 2));
  await fsp.rename(tmp, f);
}

/** Checks sources and destination. Returns [{ code, path }]; missing sources are only an error when strict. */
async function validate({ sources, dest }, { needDest = false, strictSources = true } = {}) {
  const errors = [];
  const h = await realOr(home());
  const realSources = [];
  for (const s of sources || []) {
    if (!isAbs(s)) {
      errors.push({ code: 'ESOURCE', path: String(s) });
      continue;
    }
    const r = await realOr(s);
    if (!inside(r, h) || r === h) {
      errors.push({ code: 'EOUTSIDE', path: s });
      continue;
    }
    let st = null;
    try {
      st = await fsp.stat(r);
    } catch {}
    if (!st || !st.isDirectory()) {
      if (strictSources) errors.push({ code: 'ESOURCE', path: s });
      continue;
    }
    realSources.push(r);
  }
  if (dest == null) {
    if (needDest) errors.push({ code: 'ENODEST', path: '' });
  } else if (!isAbs(dest)) {
    errors.push({ code: 'EDEST', path: String(dest) });
  } else {
    let st = null;
    try {
      st = await fsp.stat(dest);
    } catch {}
    if (!st || !st.isDirectory()) errors.push({ code: 'EDEST', path: dest });
    else {
      const rd = await realOr(dest);
      try {
        await fsp.access(rd, fs.constants.W_OK);
      } catch {
        errors.push({ code: 'EDESTRO', path: dest });
      }
      const all = [...realSources];
      for (const s of sources || []) if (isAbs(s)) all.push(await realOr(s));
      if (all.some((s) => inside(rd, s))) errors.push({ code: 'EINSIDE', path: dest });
    }
  }
  return errors;
}

async function snapshotsRoot(dest) {
  return path.join(dest, ROOT_NAME);
}
async function readManifest(dir) {
  try {
    return JSON.parse(await fsp.readFile(path.join(dir, MANIFEST), 'utf8'));
  } catch {
    return null;
  }
}
function dateFromStamp(id) {
  const m = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})(\d{2})/.exec(id);
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : 0;
}
async function listSnapshots(dest) {
  if (!dest) return [];
  const root = await snapshotsRoot(dest);
  let names = [];
  try {
    names = await fsp.readdir(root);
  } catch {
    return [];
  }
  const out = [];
  for (const id of names) {
    if (!STAMP_RE.test(id)) continue;
    const dir = path.join(root, id);
    const st = await fsp.stat(dir).catch(() => null);
    if (!st || !st.isDirectory()) continue;
    const m = (await readManifest(dir)) || {};
    out.push({
      id,
      date: Number.isFinite(m.date) ? m.date : dateFromStamp(id),
      files: Number(m.files) || 0,
      bytes: Number(m.bytes) || 0,
      newBytes: Number(m.newBytes) || 0,
      sources: Array.isArray(m.sources) ? m.sources : [],
      warnings: Number(m.warnings) || 0,
    });
  }
  out.sort((a, b) => b.date - a.date || (b.id > a.id ? 1 : -1));
  return out;
}

/** Parses one --info=progress2 line: "  1,234,567  45%  12.34MB/s    0:00:12 (xfr#3, to-chk=1/9)". */
function parseProgress(line) {
  const m = /^\s*([\d,.]+)\s+(\d+)%\s+(\S+)\s+(\d+:\d{2}:\d{2})/.exec(line);
  if (!m) return null;
  return { bytes: Number(m[1].replace(/[,.]/g, '')), percent: Math.min(1, Number(m[2]) / 100), speed: m[3], eta: m[4] };
}
/** Parses rsync --stats output. */
function parseStats(text) {
  const num = (re) => {
    const m = re.exec(text);
    return m ? Number(m[1].replace(/[,.]/g, '')) : 0;
  };
  return {
    files: num(/Number of files:\s*[\d,.]+\s*\(reg:\s*([\d,.]+)/) || num(/Number of files:\s*([\d,.]+)/),
    bytes: num(/Total file size:\s*([\d,.]+)/),
    newBytes: num(/Total transferred file size:\s*([\d,.]+)/),
  };
}

function runRsync(args, { onLine, op } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn('rsync', args, { env: ENV, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    } catch (e) {
      return reject(err('rsync is not installed', 'ENORSYNC'));
    }
    if (op) op.child = child;
    let out = '';
    let errText = '';
    let buf = '';
    child.stdout.on('data', (d) => {
      const s = d.toString();
      out += s;
      if (out.length > 4e6) out = out.slice(-2e6);
      buf += s;
      const parts = buf.split(/[\r\n]/);
      buf = parts.pop();
      for (const p of parts) if (p.trim()) onLine?.(p);
    });
    child.stderr.on('data', (d) => {
      errText += d.toString();
      if (errText.length > 1e5) errText = errText.slice(-5e4);
    });
    child.on('error', (e) => reject(e.code === 'ENOENT' ? err('rsync is not installed', 'ENORSYNC') : e));
    child.on('close', (code, signal) => {
      if (op) op.child = null;
      resolve({ code, signal, out, err: errText });
    });
  });
}
function killOp(op) {
  if (!op?.child) return;
  try {
    process.kill(-op.child.pid, 'SIGTERM');
  } catch {
    try {
      op.child.kill('SIGTERM');
    } catch {}
  }
}

module.exports = function register(api) {
  let running = null; // { opId, canceled, child, sender }

  async function prune(dest, keep) {
    if (!dest || !(keep > 0)) return [];
    const snaps = await listSnapshots(dest);
    const root = await snapshotsRoot(dest);
    const deleted = [];
    for (const s of snaps.slice(keep)) {
      await fsp.rm(path.join(root, s.id), { recursive: true, force: true }).catch(() => {});
      deleted.push(s.id);
    }
    return deleted;
  }

  async function start({ opId } = {}, sender) {
    if (running) throw err('A backup is already running', 'EBUSY');
    const op = { opId: String(opId || `bk-${Date.now()}`), canceled: false, child: null };
    running = op;
    const emit = (p) => api.sendTo(sender, 'backup:progress', { opId: op.opId, ...p });
    const t0 = Date.now();
    let partial = null;
    try {
      const cfg = await readConfig();
      const errors = await validate(cfg, { needDest: true, strictSources: false });
      // keep the precise code (the app has a message for each one); "<code>: <path>" so the UI can show the path
      if (errors.length) throw err(`${errors[0].code}: ${errors[0].path}`, errors[0].code);
      const h = await realOr(home());
      const backupRoot = path.join(await realOr(cfg.dest), ROOT_NAME);
      const srcs = [];
      for (const s of cfg.sources) {
        const r = await realOr(s);
        const st = await fsp.stat(r).catch(() => null);
        // a source inside <dest>/SeleneBackup would back the backups up again on every run
        if (st?.isDirectory() && inside(r, h) && r !== h && !inside(r, backupRoot)) srcs.push(path.relative(h, r));
      }
      if (!srcs.length) throw err('None of the folders to back up exist', 'ESOURCE');
      const root = await snapshotsRoot(await realOr(cfg.dest));
      await fsp.mkdir(root, { recursive: true });
      // leftovers of an interrupted run
      for (const n of await fsp.readdir(root).catch(() => [])) if (n.endsWith('.partial')) await fsp.rm(path.join(root, n), { recursive: true, force: true }).catch(() => {});
      const prev = (await listSnapshots(cfg.dest))[0];
      let id = stampOf();
      for (let i = 2; fs.existsSync(path.join(root, id)); i++) id = `${stampOf()}-${i}`;
      partial = path.join(root, `${id}.partial`);
      await fsp.mkdir(partial, { recursive: true });
      emit({ phase: 'scan', percent: 0, bytes: 0 });
      const args = ['-a', '--relative', '--no-inc-recursive', '--info=progress2', '--stats', '--no-human-readable'];
      for (const x of EXCLUDES) args.push(`--exclude=${x}`);
      // tests only: slow the copy down so progress and cancel can be observed
      const bw = Number(process.env.AURORA_BACKUP_BWLIMIT);
      if (bw > 0) args.push(`--bwlimit=${Math.round(bw)}`);
      if (prev) args.push(`--link-dest=${path.join(root, prev.id)}`);
      args.push('--', ...srcs.map((r) => `${h}/./${r}`), `${partial}/`);
      let last = 0;
      const res = await runRsync(args, {
        op,
        onLine: (line) => {
          const p = parseProgress(line);
          if (!p) return;
          const now = Date.now();
          if (now - last < 100 && p.percent < 1) return;
          last = now;
          emit({ phase: 'copy', ...p });
        },
      });
      if (op.canceled) throw err('The backup was canceled', 'ECANCELED');
      // 23/24: some files could not be read / vanished during the run — the snapshot is still useful
      if (res.code !== 0 && res.code !== 23 && res.code !== 24) {
        throw err(`rsync failed (${res.code ?? res.signal}): ${res.err.trim().split('\n').slice(-3).join(' ')}`, 'ERSYNC');
      }
      emit({ phase: 'finish', percent: 1 });
      const stats = parseStats(res.out);
      const warnings = res.code === 0 ? 0 : res.err.split('\n').filter((l) => l.trim()).length;
      const manifest = { version: 1, id, date: t0, sources: srcs, home: h, ...stats, durationMs: Date.now() - t0, warnings, linkDest: prev?.id || null };
      await fsp.writeFile(path.join(partial, MANIFEST), JSON.stringify(manifest, null, 2));
      const final = path.join(root, id);
      await fsp.rename(partial, final);
      partial = null;
      cfg.lastRun = t0;
      await writeConfig({ ...(await readConfig()), lastRun: t0 });
      const pruned = await prune(cfg.dest, cfg.keep);
      emit({ phase: 'done', percent: 1 });
      return { id, path: final, ...stats, durationMs: manifest.durationMs, warnings, pruned };
    } finally {
      if (partial) await fsp.rm(partial, { recursive: true, force: true }).catch(() => {});
      running = null;
    }
  }

  async function snapDir(id) {
    if (typeof id !== 'string' || !STAMP_RE.test(id)) throw err('Invalid snapshot', 'EINVAL');
    const cfg = await readConfig();
    if (!cfg.dest) throw err('No destination', 'ENODEST');
    const dir = path.join(await snapshotsRoot(cfg.dest), id);
    const st = await fsp.stat(dir).catch(() => null);
    if (!st?.isDirectory()) throw err('Snapshot not found', 'ENOENT');
    return { dir, cfg };
  }

  api.handle('backup:config', async () => {
    const h = home();
    let rsync = true;
    try {
      const r = await runRsync(['--version']);
      rsync = r.code === 0;
    } catch {
      rsync = false;
    }
    return { config: await readConfig(), home: h, defaults: DEFAULT_DIRS.map((d) => path.join(h, d)), excludes: EXCLUDES.slice(), rsync, running: running?.opId || null };
  });

  api.handle('backup:validate', async (v) => {
    const errors = await validate(v || {}, { strictSources: true });
    return { ok: !errors.length, errors };
  });

  api.handle('backup:setConfig', async (patch) => {
    if (!patch || typeof patch !== 'object') throw err('Invalid settings', 'EINVAL');
    const cfg = await readConfig();
    const next = { ...cfg };
    if ('sources' in patch) {
      if (!Array.isArray(patch.sources) || patch.sources.length > 200) throw err('Invalid folder list', 'EINVAL');
      next.sources = [...new Set(patch.sources.map((s) => (isAbs(s) ? path.normalize(s).replace(/(.)\/+$/, '$1') : s)))];
    }
    if ('dest' in patch) next.dest = patch.dest == null ? null : patch.dest;
    if ('keep' in patch) {
      if (!Number.isInteger(patch.keep) || patch.keep < 0 || patch.keep > 1000) throw err('Invalid number', 'EINVAL');
      next.keep = patch.keep;
    }
    if ('reminder' in patch) {
      if (!['off', 'daily', 'weekly'].includes(patch.reminder)) throw err('Invalid reminder', 'EINVAL');
      next.reminder = patch.reminder;
    }
    if ('sources' in patch || 'dest' in patch) {
      const errors = (await validate({ sources: 'sources' in patch ? next.sources : [], dest: 'dest' in patch ? next.dest : null }, { strictSources: 'sources' in patch }))
        // a folder that was already in the list may be missing for now (unplugged drive, deleted): keep it; only new ones must exist
        .filter((e) => !(e.code === 'ESOURCE' && cfg.sources.includes(e.path)));
      // the destination must also stay outside every (old or new) source
      if ('dest' in patch && !('sources' in patch) && next.dest) errors.push(...(await validate({ sources: next.sources, dest: next.dest }, { strictSources: false })).filter((e) => e.code === 'EINSIDE'));
      if (errors.length) {
        const e = errors[0];
        throw err(`${e.code}: ${e.path}`, e.code);
      }
    }
    await writeConfig(next);
    return next;
  });

  api.handle('backup:start', (opts, event) => start(opts || {}, event?.sender));
  api.handle('backup:cancel', (opId) => {
    if (running && (!opId || running.opId === opId)) {
      running.canceled = true;
      killOp(running);
    }
    return true;
  });

  api.handle('backup:list', async () => {
    const cfg = await readConfig();
    return { dest: cfg.dest, root: cfg.dest ? await snapshotsRoot(cfg.dest) : null, snapshots: await listSnapshots(cfg.dest), running: running?.opId || null };
  });

  api.handle('backup:browse', async (id, rel) => {
    const { dir } = await snapDir(id);
    const r = safeRel(rel);
    if (r === null) throw err('Invalid path', 'EINVAL');
    const base = path.join(dir, r);
    await assertInside(base, dir); // a symlink kept in the snapshot must not list folders outside it
    const ents = await fsp.readdir(base, { withFileTypes: true }).catch(() => {
      throw err('Folder not found', 'ENOENT');
    });
    const out = [];
    for (const e of ents) {
      if (!r && e.name === MANIFEST) continue;
      const p = path.join(base, e.name);
      const st = await fsp.lstat(p).catch(() => null);
      if (!st) continue;
      out.push({ name: e.name, rel: r ? `${r}/${e.name}` : e.name, dir: st.isDirectory(), link: st.isSymbolicLink(), size: st.isDirectory() ? 0 : st.size, mtime: st.mtimeMs });
    }
    out.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
    return out;
  });

  api.handle('backup:restore', async (id, rels, opts = {}) => {
    const { dir } = await snapDir(id);
    if (!Array.isArray(rels) || !rels.length || rels.length > 1000) throw err('Nothing to restore', 'EINVAL');
    const items = rels.map(safeRel);
    if (items.some((r) => !r)) throw err('Invalid path', 'EINVAL');
    const to = opts.to === 'folder' ? 'folder' : 'original';
    let folder = null;
    const h = await realOr(home());
    if (to === 'folder') {
      if (!isAbs(opts.folder)) throw err('Invalid folder', 'EINVAL');
      folder = await realOr(opts.folder);
      const st = await fsp.stat(folder).catch(() => null);
      if (!st?.isDirectory()) throw err('Folder not found', 'EDEST');
    }
    const plan = [];
    for (const r of items) {
      const src = path.join(dir, r);
      // the item itself may be a symlink (copied as a link), but the folders leading to it must stay in the snapshot
      await assertInside(path.dirname(src), dir);
      const st = await fsp.lstat(src).catch(() => null);
      if (!st) throw err(`Not in the snapshot: ${r}`, 'ENOENT');
      const target = to === 'folder' ? path.join(folder, path.basename(r)) : path.join(h, r);
      if (to === 'original' && !inside(path.resolve(target), h)) throw err('Invalid path', 'EINVAL');
      if (to === 'original') await assertInside(path.dirname(target), h); // no writing through a symlink out of home
      plan.push({ rel: r, src, target, dir: st.isDirectory() });
    }
    const conflicts = [];
    for (const p of plan) if (await fsp.lstat(p.target).catch(() => null)) conflicts.push(p.rel);
    if (conflicts.length && !opts.overwrite) return { restored: 0, conflicts };
    for (const p of plan) {
      await fsp.mkdir(path.dirname(p.target), { recursive: true });
      // rsync keeps times and permissions; a trailing slash copies a folder's contents into the target folder
      const res = await runRsync(['-a', '--', p.dir ? `${p.src}/` : p.src, p.dir ? `${p.target}/` : p.target]);
      if (res.code !== 0) throw err(`rsync failed (${res.code}): ${res.err.trim().split('\n').pop()}`, 'ERSYNC');
    }
    return { restored: plan.length, conflicts };
  });

  api.handle('backup:delete', async (ids) => {
    if (!Array.isArray(ids)) throw err('Invalid snapshot list', 'EINVAL');
    const deleted = [];
    for (const id of ids) {
      const { dir } = await snapDir(id);
      if (running) throw err('A backup is running', 'EBUSY');
      await fsp.rm(dir, { recursive: true, force: true });
      deleted.push(id);
    }
    return { deleted };
  });

  api.handle('backup:prune', async (keep) => {
    if (!Number.isInteger(keep) || keep < 1) throw err('Invalid number', 'EINVAL');
    if (running) throw err('A backup is running', 'EBUSY');
    const cfg = await readConfig();
    return { deleted: await prune(cfg.dest, keep) };
  });
};
module.exports.parseProgress = parseProgress;
module.exports.parseStats = parseStats;
module.exports.safeRel = safeRel;
module.exports.inside = inside;
