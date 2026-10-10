// File operations shared by every File Explorer window: copy/move with a Windows-style progress
// window (cancellable), Recycle Bin, permanent delete, restore, new items, archives and undo.
import { shared, pushUndo, popUndo, peekUndo, takeUndo, renamePaths } from './shared.js';
import * as T from './types.js';

let opSeq = 0;
const newOpId = () => `fx${Date.now().toString(36)}${++opSeq}`;

// Error codes do not survive Electron's contextBridge (only the message does), so derive them:
// Node fs errors start with the code ("EACCES: permission denied, …"); known backend messages map.
export function codeOf(err) {
  if (!err) return '';
  if (err.code) return err.code;
  const msg = String(err.message || err);
  const m = /^(E[A-Z0-9]{2,})\b/.exec(msg);
  if (m) return m[1];
  if (/already exists/i.test(msg)) return 'EEXIST';
  if (/subfolder of the source|into itself/i.test(msg)) return 'ESUBFOLDER';
  if (/operation was cancel/i.test(msg)) return 'ECANCELED';
  if (/permission denied|not permitted/i.test(msg)) return 'EACCES';
  if (/no such file or directory/i.test(msg)) return 'ENOENT';
  if (/not a (directory|folder)/i.test(msg)) return 'ENOTDIR';
  if (/no space left/i.test(msg)) return 'ENOSPC';
  if (/read-only file system/i.test(msg)) return 'EROFS';
  return '';
}

function errText(ex, err) {
  const t = ex.t;
  const code = codeOf(err);
  if (code === 'EACCES' || code === 'EPERM') return t('errors.permission');
  if (code === 'ENOSPC') return t('errors.noSpace');
  if (code === 'ESUBFOLDER') return t('errors.subfolder');
  if (code === 'EEXIST') return t('errors.exists');
  if (code === 'ENOENT') return t('errors.gone');
  if (code === 'EROFS') return t('errors.readOnly');
  return err?.message || String(err);
}
export { errText };

// One run at a time per window and per kind of operation: a double click on "Empty Recycle Bin",
// a key pressed twice (Delete, Ctrl+Shift+N) or "Restore" clicked twice must not start a second
// operation on items the first one already moved (that showed "item could not be found" errors).
export function exclusive(ex, key, fn) {
  const running = (ex._running ??= new Set());
  if (running.has(key)) return Promise.resolve(undefined);
  running.add(key);
  return Promise.resolve()
    .then(fn)
    .finally(() => running.delete(key));
}

export function alertError(ex, err, title) {
  if (codeOf(err) === 'ECANCELED') return Promise.resolve();
  return ex.ui.alert(errText(ex, err), { title: title || ex.t('appName'), parent: ex.win });
}

// ---------------------------------------------------------------- progress window
class ProgressWindow {
  constructor(ex, { title, verb, count, from, to, cancel, indeterminate }) {
    this.ex = ex;
    const { h, t, icon } = ex;
    this.start = Date.now();
    this.samples = [];
    this.pct = h('div', { class: 'fx-pg-pct' }, indeterminate ? t('progress.working') : t('progress.percent', { n: 0 }));
    this.bar = h('div', { class: 'bar' });
    this.barWrap = h('div', { class: ['fx-pg-bar', indeterminate && 'indeterminate'] }, this.bar);
    this.line = h('div', { class: 'fx-pg-line caption' }, verb);
    this.name = h('span', { class: 'ellipsis' });
    this.remain = h('span');
    this.items = h('span');
    this.speed = h('span');
    this.details = h('div', { class: 'fx-pg-details caption' },
      h('span', { class: 'k' }, t('progress.name')), this.name,
      h('span', { class: 'k' }, t('progress.timeRemaining')), this.remain,
      h('span', { class: 'k' }, t('progress.itemsRemaining')), this.items,
      h('span', { class: 'k' }, t('progress.speed')), this.speed);
    if (indeterminate) this.details.hidden = true;
    this.cancelBtn = h('button', { class: 'btn', onclick: () => cancel?.() }, t('common.cancel'));
    const body = h('div', { class: 'fx-pg' },
      h('div', { class: 'fx-pg-head' }, icon(verb && title ? 'copy' : 'copy', { size: 20 }), this.pct),
      this.line,
      this.barWrap,
      this.details,
      h('div', { class: 'fx-pg-foot' }, this.cancelBtn));
    this.win = ex.ctx.shell.wm.create({
      appId: 'files',
      title,
      icon: ex.ctx.appUrl('icon.svg'),
      width: 460,
      height: indeterminate ? 190 : 270,
      resizable: false,
      maximizable: false,
      background: 'mica',
      className: 'app-files fx-progress-win',
    });
    this.win.body.appendChild(body);
    this.win.onBeforeClose(async () => {
      if (this.finished) return true;
      cancel?.();
      return false;
    });
  }

  update(p) {
    const t = this.ex.t;
    if (p.phase === 'scan') {
      this.pct.textContent = t('progress.calculating');
      return;
    }
    const frac = p.totalBytes > 0 ? p.bytes / p.totalBytes : p.total > 0 ? p.done / p.total : 0;
    const pct = Math.max(0, Math.min(100, Math.floor(frac * 100)));
    this.pct.textContent = t('progress.percent', { n: pct });
    this.bar.style.width = `${pct}%`;
    this.win.setProgress(frac);
    if (p.name) this.name.textContent = p.name;
    const now = Date.now();
    this.samples.push([now, p.bytes]);
    while (this.samples.length > 2 && now - this.samples[0][0] > 3000) this.samples.shift();
    const [t0, b0] = this.samples[0];
    const rate = now > t0 ? ((p.bytes - b0) / (now - t0)) * 1000 : 0;
    this.speed.textContent = rate > 0 ? t('progress.rate', { size: T.humanSize(rate, t) }) : '—';
    const left = p.totalBytes - p.bytes;
    if (rate > 0 && left > 0) {
      const secs = Math.ceil(left / rate);
      this.remain.textContent = secs < 60 ? t('progress.seconds', { count: secs }) : t('progress.minutes', { count: Math.ceil(secs / 60) });
    } else this.remain.textContent = t('progress.calculatingShort');
    this.items.textContent = t('progress.itemsLeft', { count: Math.max(0, p.total - p.done), size: T.humanSize(Math.max(0, left), t) });
  }

  close() {
    this.finished = true;
    this.win.close(true);
  }
}

// Shows a progress window if the operation runs longer than `delay` ms.
function withProgress(ex, opts, run) {
  let pw = null;
  let last = null;
  let done = false;
  const opId = newOpId();
  const cancel = () => ex.api.invoke('files:cancel', opId).catch(() => {});
  const off = ex.api.on('files:progress', (p) => {
    if (p.opId !== opId) return;
    last = p;
    pw?.update(p);
  });
  const timer = setTimeout(() => {
    if (done) return;
    pw = new ProgressWindow(ex, { ...opts, cancel });
    if (last) pw.update(last);
  }, opts.delay ?? 450);
  return run(opId).finally(() => {
    done = true;
    clearTimeout(timer);
    off?.();
    pw?.close();
  });
}

// ---------------------------------------------------------------- copy / move
export async function transfer(ex, paths, destDir, { move = false, select = true, undo = true } = {}) {
  const t = ex.t;
  paths = [...new Set(paths)].filter(Boolean);
  if (!paths.length || !destDir) return [];
  const prot = move && paths.find((p) => T.isProtectedPath(p));
  if (prot) {
    await ex.ui.alert(t('errors.protectedChange', { name: ex.locName({ type: 'dir', path: prot }) }), { title: t('progress.moveError'), parent: ex.win });
    return [];
  }
  const count = paths.length;
  const fromName = ex.locName({ type: 'dir', path: T.dirname(paths[0]) });
  const toName = ex.locName({ type: 'dir', path: destDir });
  const verb = t(move ? 'progress.movingFrom' : 'progress.copyingFrom', { count, from: fromName, to: toName });
  let results;
  try {
    results = await withProgress(ex, { title: t(move ? 'progress.moving' : 'progress.copying', { count }), verb }, (opId) =>
      ex.api.invoke('files:transfer', paths, destDir, { move, opId }),
    );
  } catch (err) {
    if (codeOf(err) !== 'ECANCELED') await alertError(ex, err, t(move ? 'progress.moveError' : 'progress.copyError'));
    ex.refreshAll();
    return [];
  }
  if (move) paths.forEach((p, i) => results[i] && results[i] !== p && renamePaths(p, results[i]));
  const changed = results.filter((r, i) => r !== paths[i]);
  if (undo && changed.length) {
    if (move) pushUndo({ type: 'move', items: paths.map((from, i) => ({ from, to: results[i] })).filter((x) => x.to && x.to !== x.from) });
    else pushUndo({ type: 'copy', paths: changed });
  }
  ex.refreshAll(select && T.dirname(results[0] || '') === destDir ? { dir: destDir, select: results } : undefined);
  return results;
}

export async function paste(ex, destDir) {
  const clip = ex.ctx.shell.clipboard.getFiles();
  if (!clip?.paths?.length || !destDir) return [];
  const move = clip.mode === 'cut';
  const res = await transfer(ex, clip.paths, destDir, { move });
  if (move && res.length) ex.ctx.shell.clipboard.clearFiles?.();
  return res;
}

// ---------------------------------------------------------------- Recycle Bin
export function trash(ex, paths) {
  return exclusive(ex, 'delete', () => trashNow(ex, paths));
}
async function trashNow(ex, paths) {
  const t = ex.t;
  paths = [...new Set(paths)];
  if (!paths.length) return 0;
  if (shared.prefs.confirmTrash) {
    const ok = await ex.ui.confirm(
      paths.length === 1 ? t('confirm.trashOne', { name: T.basename(paths[0]) }) : t('confirm.trashMany', { count: paths.length }),
      { title: t('confirm.trashTitle'), okLabel: t('common.yes'), cancelLabel: t('common.no'), parent: ex.win },
    );
    if (!ok) return 0;
  }
  const time = Date.now();
  let n = 0;
  try {
    ex.setBusy(true);
    n = await ex.api.invoke('fs:trash', paths);
  } catch (err) {
    await alertError(ex, err, t('confirm.trashTitle'));
  } finally {
    ex.setBusy(false);
  }
  if (n) {
    const op = pushUndo({ type: 'trash', paths, time });
    ex.toast(t('toast.trashed', { count: n }), { label: t('common.undo'), action: () => undo(ex, op) });
  }
  await ex.refreshAll();
  return n;
}

export function deleteForever(ex, entries) {
  return exclusive(ex, 'delete', () => deleteForeverNow(ex, entries));
}
async function deleteForeverNow(ex, entries) {
  const t = ex.t;
  if (!entries.length) return 0;
  const { h } = ex;
  let body;
  if (entries.length === 1) {
    const e = entries[0];
    body = h('div', { class: 'fx-del' },
      h('div', null, t(e.dir ? 'confirm.deleteFolder' : 'confirm.deleteFile')),
      h('div', { class: 'fx-del-item' },
        h('img', { src: T.iconFor(e), alt: '' }),
        h('div', { class: 'col' },
          h('div', { class: 'body-strong ellipsis' }, e.name),
          h('div', { class: 'caption text-2' }, t('props.type'), ': ', T.typeName(e)),
          e.dir ? null : h('div', { class: 'caption text-2' }, t('props.size'), ': ', T.humanSize(e.size)),
          e.mtime ? h('div', { class: 'caption text-2' }, t('cols.mtime'), ': ', T.formatDate(e.mtime)) : null)));
  } else {
    body = t('confirm.deleteMany', { count: entries.length });
  }
  const ok = await ex.ui.dialog({
    title: t(entries.length === 1 ? (entries[0].dir ? 'confirm.deleteFolderTitle' : 'confirm.deleteFileTitle') : 'confirm.deleteMultipleTitle'),
    body,
    parent: ex.win,
    buttons: [
      { label: t('common.yes'), value: true, primary: true },
      { label: t('common.no'), value: false },
    ],
  });
  if (ok !== true) return 0;
  let n = 0;
  try {
    ex.setBusy(true);
    n = await ex.api.invoke('fs:delete', entries.map((e) => e.path));
  } catch (err) {
    await alertError(ex, err);
  } finally {
    ex.setBusy(false);
  }
  await ex.refreshAll();
  return n;
}

export function restore(ex, trashEntries) {
  if (!trashEntries.length) return Promise.resolve(0);
  return exclusive(ex, 'restore', async () => {
    try {
      return await ex.api.invoke('fs:trashRestore', trashEntries.map((e) => T.basename(e.path)));
    } catch (err) {
      await alertError(ex, err);
      return 0;
    } finally {
      await ex.refreshAll();
    }
  });
}

export function emptyTrash(ex) {
  return exclusive(ex, 'empty', () => emptyTrashNow(ex));
}
async function emptyTrashNow(ex) {
  const t = ex.t;
  let list = [];
  try {
    list = await ex.api.invoke('fs:trashList');
  } catch {}
  if (!list.length) return 0;
  const ok = await ex.ui.dialog({
    title: t('trash.emptyTitle'),
    body: list.length === 1 ? t('trash.emptyConfirmOne', { name: list[0].name }) : t('trash.emptyConfirm', { count: list.length }),
    parent: ex.win,
    buttons: [
      { label: t('common.yes'), value: true, primary: true },
      { label: t('common.no'), value: false },
    ],
  });
  if (ok !== true) return 0;
  try {
    ex.setBusy(true);
    return await ex.api.invoke('fs:trashEmpty');
  } catch (err) {
    await alertError(ex, err);
    return 0;
  } finally {
    ex.setBusy(false);
    await ex.refreshAll();
  }
}

// ---------------------------------------------------------------- new items
export async function createFolder(ex, dir) {
  try {
    const name = await ex.api.invoke('fs:uniqueName', dir, ex.t('new.folderName'));
    const e = await ex.api.invoke('fs:mkdir', T.joinPath(dir, name));
    pushUndo({ type: 'new', path: e.path });
    return e;
  } catch (err) {
    await alertError(ex, err);
    return null;
  }
}

export async function createFile(ex, dir, kind = 'text') {
  const t = ex.t;
  const base = kind === 'text' ? `${t('new.textName')}.txt` : kind === 'markdown' ? `${t('new.markdownName')}.md` : t('new.emptyName');
  try {
    const name = await ex.api.invoke('fs:uniqueName', dir, base);
    const e = await ex.api.invoke('fs:writeText', T.joinPath(dir, name), '');
    pushUndo({ type: 'new', path: e.path });
    return e;
  } catch (err) {
    await alertError(ex, err);
    return null;
  }
}

// ---------------------------------------------------------------- rename (validation shared by inline + dialogs)
export function validateName(ex, name) {
  if (!name.trim()) return ex.t('rename.empty');
  if (name.includes('/') || name.includes('\0')) return ex.t('rename.invalidChars');
  if (name === '.' || name === '..') return ex.t('rename.reserved');
  if (new TextEncoder().encode(name).length > 255) return ex.t('rename.tooLong');
  return null;
}

export async function rename(ex, entry, newName, { undo = true } = {}) {
  const res = await ex.api.invoke('fs:rename', entry.path, newName);
  if (undo) pushUndo({ type: 'rename', from: entry.path, to: res.path });
  renamePaths(entry.path, res.path);
  return res;
}

// ---------------------------------------------------------------- archives
export async function extract(ex, entry, { dest: destDir, exact = false, open = true } = {}) {
  const t = ex.t;
  let dest = null;
  try {
    dest = await withProgress(ex, { title: t('archive.extracting'), verb: t('archive.extractingFrom', { name: entry.name }), indeterminate: true, delay: 300 }, (opId) =>
      ex.api.invoke('files:extract', entry.path, destDir || T.dirname(entry.path), { opId, exact }),
    );
  } catch (err) {
    if (codeOf(err) !== 'ECANCELED') await alertError(ex, err, t('archive.extractError'));
    return null;
  }
  if (!exact) pushUndo({ type: 'new', path: dest });
  if (open) ex.navigate({ type: 'dir', path: dest });
  else ex.refreshAll({ dir: T.dirname(dest), select: [dest] });
  return dest;
}

export async function compress(ex, entries) {
  const t = ex.t;
  if (!entries.length) return null;
  const dir = T.dirname(entries[0].path);
  const stem = entries.length === 1 ? T.splitExt(entries[0].name, entries[0].dir)[0] || entries[0].name : T.basename(dir) === '/' ? 'Archive' : T.basename(dir);
  let zip;
  try {
    const name = await ex.api.invoke('fs:uniqueName', dir, `${stem}.zip`);
    zip = await withProgress(ex, { title: t('archive.compressing'), verb: t('archive.compressingCount', { count: entries.length }), indeterminate: true, delay: 300 }, (opId) =>
      ex.api.invoke('files:compress', entries.map((e) => e.path), T.joinPath(dir, name), { opId }),
    );
  } catch (err) {
    if (codeOf(err) !== 'ECANCELED') await alertError(ex, err, t('archive.compressError'));
    return null;
  }
  pushUndo({ type: 'new', path: zip });
  return zip;
}

// ---------------------------------------------------------------- undo
export function undoLabel(ex) {
  const op = peekUndo();
  if (!op) return ex.t('undo.nothing');
  return ex.t(`undo.${op.type}`);
}

// undo(ex) undoes the last operation; undo(ex, op) undoes that one operation (if still undoable).
export async function undo(ex, target = null) {
  const op = target ? takeUndo(target) : popUndo();
  if (!op) return false;
  const api = ex.api;
  try {
    if (op.type === 'rename') {
      await api.invoke('fs:rename', op.to, T.basename(op.from));
      renamePaths(op.to, op.from);
      ex.refreshAll({ dir: T.dirname(op.from), select: [op.from] });
    } else if (op.type === 'renameMany') {
      for (const { from, to } of [...op.items].reverse()) {
        await api.invoke('fs:rename', to, T.basename(from));
        renamePaths(to, from);
      }
      ex.refreshAll({ dir: T.dirname(op.items[0].from), select: op.items.map((x) => x.from) });
    } else if (op.type === 'move') {
      for (const { from, to } of op.items) {
        const [back] = await api.invoke('files:transfer', [to], T.dirname(from), { move: true });
        if (back && back !== from && T.basename(back) !== T.basename(from)) {
          const free = !(await api.invoke('fs:exists', from));
          if (free) await api.invoke('fs:rename', back, T.basename(from));
        }
        renamePaths(to, from);
      }
      ex.refreshAll({ dir: T.dirname(op.items[0].from), select: op.items.map((x) => x.from) });
    } else if (op.type === 'copy' || op.type === 'new') {
      const paths = op.type === 'copy' ? op.paths : [op.path];
      const existing = [];
      for (const p of paths) if (await api.invoke('fs:exists', p)) existing.push(p);
      if (existing.length) await api.invoke('fs:trash', existing);
      ex.refreshAll();
    } else if (op.type === 'trash') {
      const list = await api.invoke('fs:trashList');
      const names = [];
      for (const p of op.paths) {
        const hit = list.filter((x) => x.originalPath === p && x.deletedAt >= op.time - 2000).sort((a, b) => b.deletedAt - a.deletedAt)[0];
        if (hit) names.push(T.basename(hit.path));
      }
      if (names.length) await api.invoke('fs:trashRestore', names);
      ex.refreshAll({ dir: T.dirname(op.paths[0]), select: op.paths });
    }
    return true;
  } catch (err) {
    await alertError(ex, err, ex.t('undo.failed'));
    ex.refreshAll();
    return false;
  }
}

// ---------------------------------------------------------------- misc
export async function copyAsPath(ex, paths) {
  const text = paths.map((p) => (/[\s'"$`\\]/.test(p) ? `"${p.replace(/(["$`\\])/g, '\\$1')}"` : p)).join('\n');
  try {
    await ex.api.invoke('clipboard:writeText', text);
    ex.toast(ex.t(paths.length === 1 ? 'toast.pathCopied' : 'toast.pathsCopied', { count: paths.length }));
  } catch (err) {
    alertError(ex, err);
  }
}

export async function setWallpaper(ex, entry) {
  try {
    await ex.ctx.settings.set('wallpaper', entry.path);
    ex.toast(ex.t('toast.wallpaper'));
  } catch (err) {
    alertError(ex, err);
  }
}
