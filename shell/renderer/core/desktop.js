// Desktop: wallpaper (cross-fades on change) and the icon grid for ~/Desktop (+ This PC, Recycle Bin,
// installer in the live session).
//   - icon sizes: settings.desktopIconSize = 'small' | 'medium' | 'large'; settings.desktopIcons = false hides them
//   - free placement on a grid (positions persist), Auto arrange, Sort by name/size/type/date
//   - drag icons to move them, onto a folder to move into it, onto the Recycle Bin to delete;
//     drag files into app windows (HTML5 DnD: 'application/x-aurora-paths' JSON, text/uri-list,
//     text/plain), and drop files from apps onto the desktop
//   - keyboard: arrows, Home/End, Enter, F2 rename (inline), Delete (Shift+Delete = permanent),
//     Ctrl+A / C / X / V, Ctrl+Shift+N new folder, F5 refresh, Shift+F10 / ContextMenu key
//   - Windows 11 context menus (View ▸, Sort by ▸, Refresh, Paste, New ▸, Display, Personalize, Terminal)
//   desktop.mount(el)  desktop.refresh()  desktop.select(ids)  desktop.items()
import { h, icon, ui, clear } from './ui.js';
import { api, env } from './api.js';
import { settings } from './settings.js';
import { i18n, t } from './i18n.js';
import { shell } from './services.js';
import { registry } from './registry.js';
import { theme } from './theme.js';

const DND_MIME = 'application/x-aurora-paths';

// Security: the internal paths format is only trusted when the drag started in the shell's own
// document (desktop, Files, …). A drag coming from web content (<webview> tab, sandboxed mail iframe)
// never fires 'dragstart' here, so a forged payload can't make us move or trash arbitrary files.
let shellDrag = false;
document.addEventListener('dragstart', () => (shellDrag = true), true);
document.addEventListener('dragend', () => (shellDrag = false), true);
window.addEventListener('pointerdown', () => (shellDrag = false), true);
/** Paths of an 'application/x-aurora-paths' drag, or [] when the drag did not start in the shell
 *  (exported so apps that accept that format — Files, Notepad, Mail — can apply the same rule). */
export function trustedDragPaths(dt) {
  return trustedPaths(dt);
}
function trustedPaths(dt) {
  if (!shellDrag || !dt) return [];
  try {
    const v = JSON.parse(dt.getData(DND_MIME) || '[]');
    return Array.isArray(v) ? v.filter((p) => typeof p === 'string' && p.startsWith('/') && !p.includes('\0')) : [];
  } catch {
    return [];
  }
}
const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.avif', '.ico'];
const SIZES = {
  small: { w: 76, h: 70, icon: 32 },
  medium: { w: 84, h: 100, icon: 48 },
  large: { w: 120, h: 136, icon: 96 },
};
const PAD = 4;

const STRINGS = {
  en: {
    desktop: {
      large: 'Large icons',
      medium: 'Medium icons',
      small: 'Small icons',
      autoArrange: 'Auto arrange icons',
      sortBy: 'Sort by',
      sortName: 'Name',
      sortSize: 'Size',
      sortType: 'Item type',
      sortDate: 'Date modified',
      folder: 'Folder',
      textDocument: 'Text Document',
      copyPath: 'Copy as path',
      openWith: 'Open with',
      emptyBin: 'Empty Recycle Bin',
      emptyBinConfirm: 'Are you sure you want to permanently delete all items in the Recycle Bin?',
      deleteForever: 'Permanently delete',
      deleteConfirm_one: 'Are you sure you want to permanently delete this item?',
      deleteConfirm_other: 'Are you sure you want to permanently delete these {count} items?',
      renameError: 'Couldn’t rename the item',
      invalidName: 'A file name can’t contain “/” and can’t be “.” or “..”.',
      noPermission: 'You don’t have permission to do this.',
      noSpace: 'There isn’t enough space on the disk.',
      notFound: 'The item no longer exists. It may have been moved or deleted.',
      nameTooLong: 'The file name is too long.',
      exists: 'There is already a file with the same name in this location.',
      opError: 'The operation couldn’t be completed',
      openTerminalHere: 'Open in Terminal',
      selected_one: '{count} item selected',
      selected_other: '{count} items selected',
      newFolderShort: 'New folder',
    },
  },
  fr: {
    desktop: {
      large: 'Grandes icônes',
      medium: 'Icônes moyennes',
      small: 'Petites icônes',
      autoArrange: 'Organisation automatique des icônes',
      sortBy: 'Trier par',
      sortName: 'Nom',
      sortSize: 'Taille',
      sortType: 'Type d’élément',
      sortDate: 'Date de modification',
      folder: 'Dossier',
      textDocument: 'Document texte',
      copyPath: 'Copier en tant que chemin d’accès',
      openWith: 'Ouvrir avec',
      emptyBin: 'Vider la Corbeille',
      emptyBinConfirm: 'Voulez-vous vraiment supprimer définitivement tous les éléments de la Corbeille ?',
      deleteForever: 'Supprimer définitivement',
      deleteConfirm_one: 'Voulez-vous vraiment supprimer définitivement cet élément ?',
      deleteConfirm_other: 'Voulez-vous vraiment supprimer définitivement ces {count} éléments ?',
      renameError: 'Impossible de renommer l’élément',
      invalidName: 'Un nom de fichier ne peut pas contenir « / » ni être « . » ou « .. ».',
      noPermission: 'Vous n’avez pas l’autorisation d’effectuer cette opération.',
      noSpace: 'L’espace disque est insuffisant.',
      notFound: 'L’élément n’existe plus. Il a peut-être été déplacé ou supprimé.',
      nameTooLong: 'Le nom du fichier est trop long.',
      exists: 'Un fichier portant le même nom existe déjà à cet emplacement.',
      opError: 'L’opération n’a pas pu être effectuée',
      openTerminalHere: 'Ouvrir dans le Terminal',
      selected_one: '{count} élément sélectionné',
      selected_other: '{count} éléments sélectionnés',
      newFolderShort: 'Nouveau dossier',
    },
  },
};

const reduceMotion = () => document.documentElement.dataset.animations === 'off';

let root;
let wallEl;
let iconsBox;
let desktopDir = '';
let items = []; // { id, label, special, entry, img, open }
let layout = { pos: {}, auto: false, sort: null };
let selected = new Set();
let focusId = null;
let anchorId = null;
let renaming = null;
let dragState = null;
let cutPaths = new Set();
let renderSeq = 0;
let pendingUp = null;

// ---------------------------------------------------------------- persistence
let saveTimer = null;
async function loadLayout() {
  try {
    const v = await api.invoke('storage:get', 'shell', 'desktop-layout', null);
    if (v && typeof v === 'object') layout = { pos: v.pos || {}, auto: !!v.auto, sort: v.sort || null };
  } catch {}
}
function saveLayout() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => api.invoke('storage:set', 'shell', 'desktop-layout', layout).catch(() => {}), 300);
}

// ---------------------------------------------------------------- geometry
function size() {
  return SIZES[settings.get('desktopIconSize')] || SIZES.medium;
}
function gridDims() {
  const s = size();
  const r = iconsBox.getBoundingClientRect();
  const rows = Math.max(1, Math.floor((r.height - PAD * 2) / s.h));
  const cols = Math.max(1, Math.floor((r.width - PAD * 2) / s.w));
  return { rows, cols, s };
}
function cellAt(x, y) {
  const { rows, cols, s } = gridDims();
  const r = iconsBox.getBoundingClientRect();
  const col = Math.max(0, Math.min(cols - 1, Math.floor((x - r.left - PAD) / s.w)));
  const row = Math.max(0, Math.min(rows - 1, Math.floor((y - r.top - PAD) / s.h)));
  return [col, row];
}
// Assign every item a cell: stored positions first (if they fit), then the first free cells.
function assignCells(list) {
  const { rows, cols } = gridDims();
  const used = new Map();
  const out = new Map();
  const key = (c, r) => `${c},${r}`;
  if (!layout.auto) {
    for (const it of list) {
      const p = layout.pos[it.id];
      if (p && p[0] < cols && p[1] < rows && !used.has(key(p[0], p[1]))) {
        used.set(key(p[0], p[1]), it.id);
        out.set(it.id, p);
      }
    }
  }
  let i = 0;
  for (const it of list) {
    if (out.has(it.id)) continue;
    while (used.has(key(Math.floor(i / rows), i % rows))) i++;
    const cell = [Math.floor(i / rows), i % rows];
    used.set(key(...cell), it.id);
    out.set(it.id, cell);
  }
  return out;
}
function firstFreeCell(occupied, rows, from = 0) {
  let i = from;
  while (occupied.has(`${Math.floor(i / rows)},${i % rows}`)) i++;
  return [Math.floor(i / rows), i % rows];
}

// ---------------------------------------------------------------- items
function specialItems() {
  const list = [
    { id: 'special:thispc', label: t('desktop.thisPc'), img: 'app://shell/assets/icons/this-pc.svg', special: 'thispc', open: () => shell.launch('files', { path: 'thispc' }) },
    { id: 'special:trash', label: t('desktop.recycleBin'), img: 'app://shell/assets/icons/recycle-bin.svg', special: 'trash', open: () => shell.launch('files', { path: 'trash' }) },
  ];
  if (env.live && registry.get('installer')) {
    list.push({ id: 'special:installer', label: t('desktop.installAurora'), img: registry.iconUrl('installer'), special: 'installer', open: () => shell.launch('installer') });
  }
  return list;
}

function sortEntries(entries, by) {
  const cmpName = (a, b) => a.name.localeCompare(b.name, i18n.locale, { numeric: true, sensitivity: 'base' });
  const dirsFirst = (a, b) => (a.dir === b.dir ? 0 : a.dir ? -1 : 1);
  const cmp = {
    name: (a, b) => dirsFirst(a, b) || cmpName(a, b),
    size: (a, b) => dirsFirst(a, b) || b.size - a.size || cmpName(a, b),
    type: (a, b) => dirsFirst(a, b) || (a.ext || '').localeCompare(b.ext || '') || cmpName(a, b),
    date: (a, b) => b.mtime - a.mtime || cmpName(a, b),
  }[by || 'name'];
  return [...entries].sort(cmp);
}

async function loadItems() {
  let entries = [];
  try {
    entries = await api.invoke('fs:list', desktopDir);
  } catch {}
  const files = sortEntries(entries, layout.sort || 'name').map((e) => ({ id: e.path, label: e.name, entry: e, open: () => shell.openFile(e.path) }));
  return [...specialItems(), ...files];
}

function entryIcon(it) {
  const s = size();
  if (it.img) return h('img', { class: 'desk-img', src: it.img, alt: '', draggable: false, style: { width: `${s.icon}px`, height: `${s.icon}px` } });
  const e = it.entry;
  if (!e.dir && IMAGE_EXT.includes(e.ext)) {
    return h(
      'span',
      { class: 'desk-thumb', style: { width: `${s.icon}px`, height: `${s.icon}px` } },
      h('img', { src: `${api.mediaUrl(e.path)}?v=${Math.round(e.mtime)}`, alt: '', draggable: false, loading: 'lazy', onerror: (ev) => ev.target.replaceWith(icon('image', { size: s.icon })) }),
    );
  }
  const name = ui.fileIcon(e);
  // Page-shaped document icons get a white sheet under the coloured outline (like Windows), so they
  // stay readable on both very light and very dark wallpapers.
  if (!e.dir && PAGE_ICONS.has(name)) {
    return h(
      'span',
      { class: `desk-fi desk-page ft-${tint(e)}`, style: { width: `${s.icon}px`, height: `${s.icon}px` } },
      icon(name, { size: s.icon, filled: true, class: 'pg-fill' }),
      icon(name, { size: s.icon, class: 'pg-line' }),
    );
  }
  return icon(name, { size: s.icon, filled: e.dir, class: e.dir ? 'desk-fi folder-icon' : `desk-fi ft-${tint(e)}` });
}
const PAGE_ICONS = new Set(['document', 'document_text', 'document_pdf']);
function tint(e) {
  const x = (e.ext || '').toLowerCase();
  if (['.doc', '.docx', '.odt', '.rtf'].includes(x)) return 'doc';
  if (['.xls', '.xlsx', '.ods', '.csv'].includes(x)) return 'xls';
  if (x === '.pdf') return 'pdf';
  if (IMAGE_EXT.includes(x)) return 'img';
  if (['.mp3', '.wav', '.ogg', '.flac', '.m4a', '.opus'].includes(x)) return 'audio';
  if (['.mp4', '.webm', '.mkv', '.mov', '.avi'].includes(x)) return 'video';
  if (['.zip', '.tar', '.gz', '.xz', '.7z', '.deb', '.iso'].includes(x)) return 'zip';
  return 'file';
}

async function render() {
  if (!iconsBox) return;
  const my = ++renderSeq;
  const list = await loadItems();
  if (my !== renderSeq) return;
  items = list;
  const show = settings.get('desktopIcons') !== false;
  iconsBox.hidden = !show;
  root.dataset.iconSize = settings.get('desktopIconSize') || 'medium';
  const s = size();
  // Drop selection entries for items that vanished.
  const ids = new Set(items.map((x) => x.id));
  selected = new Set([...selected].filter((id) => ids.has(id)));
  if (focusId && !ids.has(focusId)) focusId = null;
  const cells = assignCells(items);
  const existing = new Map([...iconsBox.querySelectorAll('.desk-icon')].map((el) => [el.dataset.id, el]));
  const frag = [];
  for (const it of items) {
    const [c, r] = cells.get(it.id);
    let el = existing.get(it.id);
    const sig = `${it.label}|${it.entry?.mtime || ''}|${s.icon}`;
    if (!el || el.dataset.sig !== sig) {
      const fresh = buildIcon(it);
      fresh.dataset.sig = sig;
      if (el) el.replaceWith(fresh);
      el = fresh;
    }
    existing.delete(it.id);
    const x = PAD + c * s.w;
    const y = PAD + r * s.h;
    const moved = el.isConnected && (el._x !== x || el._y !== y);
    const px = el._x;
    const py = el._y;
    el._x = x;
    el._y = y;
    el._cell = [c, r];
    Object.assign(el.style, { left: `${x}px`, top: `${y}px`, width: `${s.w - 2}px` });
    if (moved && !reduceMotion() && px != null) {
      el.animate([{ transform: `translate(${px - x}px, ${py - y}px)` }, { transform: 'none' }], { duration: 260, easing: 'cubic-bezier(0.1,0.9,0.2,1)' });
    }
    el.classList.toggle('selected', selected.has(it.id));
    el.classList.toggle('cut', !!it.entry && cutPaths.has(it.entry.path));
    el.tabIndex = it.id === (focusId || items[0]?.id) ? 0 : -1;
    frag.push(el);
  }
  for (const el of existing.values()) el.remove();
  for (const el of frag) if (!el.isConnected) iconsBox.appendChild(el);
}

function buildIcon(it) {
  const el = h(
    'div',
    {
      class: 'desk-icon',
      role: 'option',
      tabindex: '-1',
      draggable: 'true',
      dataset: { id: it.id, special: it.special || '' },
      'aria-label': it.label,
      ondblclick: () => !renaming && it.open(),
    },
    h('span', { class: 'desk-ico' }, entryIcon(it)),
    h('span', { class: 'desk-label' }, it.label),
  );
  if (it.entry?.link) el.querySelector('.desk-ico').appendChild(h('span', { class: 'desk-link' }, icon('arrow_up_right', { size: 10 })));
  return el;
}

function itemById(id) {
  return items.find((x) => x.id === id);
}
function elById(id) {
  return iconsBox.querySelector(`.desk-icon[data-id="${CSS.escape(id)}"]`);
}
function selectedItems() {
  return items.filter((x) => selected.has(x.id));
}
function selectedPaths() {
  return selectedItems()
    .filter((x) => x.entry)
    .map((x) => x.entry.path);
}

function paintSelection() {
  for (const el of iconsBox.children) {
    el.classList.toggle('selected', selected.has(el.dataset.id));
    el.tabIndex = el.dataset.id === focusId ? 0 : -1;
  }
}
function setFocus(id, { select = true, extend = false, toggle = false } = {}) {
  if (!id) return;
  if (extend && anchorId) {
    // Shift: select the range in grid order between the anchor and this item.
    const order = items.map((x) => x.id);
    const a = order.indexOf(anchorId);
    const b = order.indexOf(id);
    selected = new Set(order.slice(Math.min(a, b), Math.max(a, b) + 1));
  } else if (toggle) {
    if (selected.has(id)) selected.delete(id);
    else selected.add(id);
    anchorId = id;
  } else if (select) {
    selected = new Set([id]);
    anchorId = id;
  }
  focusId = id;
  paintSelection();
  elById(id)?.focus({ preventScroll: true });
}

// ---------------------------------------------------------------- operations
// Backend errors carry English messages: show a localized one for the common error codes.
function errText(err) {
  const map = { EACCES: 'desktop.noPermission', EPERM: 'desktop.noPermission', EROFS: 'desktop.noPermission', ENOSPC: 'desktop.noSpace', ENOENT: 'desktop.notFound', EEXIST: 'desktop.exists', EINVAL: 'desktop.invalidName', ENAMETOOLONG: 'desktop.nameTooLong' };
  return map[err?.code] ? t(map[err.code]) : err?.message || String(err);
}
function validName(name) {
  return !!name && name !== '.' && name !== '..' && !/[\/\0]/.test(name) && new TextEncoder().encode(name).length <= 255;
}
async function op(fn) {
  try {
    return await fn();
  } catch (err) {
    ui.alert(errText(err), { title: t('desktop.opError') });
    return null;
  }
}
async function trashSelected() {
  const paths = selectedPaths();
  if (!paths.length) return;
  for (const p of paths) {
    const el = elById(p);
    if (el && !reduceMotion()) el.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.7)' }], { duration: 180, easing: 'cubic-bezier(0.7,0,1,0.5)', fill: 'forwards' });
  }
  await op(() => api.invoke('fs:trash', paths));
  selected.clear();
  render();
}
async function deleteSelected() {
  const paths = selectedPaths();
  if (!paths.length) return;
  const ok = await ui.confirm(t('desktop.deleteConfirm', { count: paths.length }), { title: t('desktop.deleteForever'), okLabel: t('common.delete'), danger: true });
  if (!ok) return;
  await op(() => api.invoke('fs:delete', paths));
  selected.clear();
  render();
}
function copySelected(mode) {
  const paths = selectedPaths();
  if (paths.length) shell.clipboard.setFiles(paths, mode);
}
async function paste() {
  const clip = shell.clipboard.getFiles();
  if (!clip?.paths?.length) return;
  const res = await op(() => api.invoke('fs:copy', clip.paths, desktopDir, { move: clip.mode === 'cut' }));
  if (clip.mode === 'cut') shell.clipboard.clearFiles();
  await render();
  if (Array.isArray(res) && res.length) {
    selected = new Set(res);
    focusId = res[0];
    paintSelection();
  }
}
async function newItem(kind) {
  const base = kind === 'folder' ? t('desktop.newFolderShort') : `${t('desktop.newTextDoc')}.txt`;
  const name = await api.invoke('fs:uniqueName', desktopDir, base).catch(() => base);
  const path = `${desktopDir}/${name}`;
  const ok = await op(() => (kind === 'folder' ? api.invoke('fs:mkdir', path) : api.invoke('fs:writeText', path, '')));
  if (!ok) return;
  // Place it where the context menu was opened, if that cell is free.
  if (lastMenuPoint && !layout.auto) {
    const cell = cellAt(lastMenuPoint.x, lastMenuPoint.y);
    const taken = Object.entries(layout.pos).some(([, p]) => p[0] === cell[0] && p[1] === cell[1]);
    if (!taken) {
      layout.pos[path] = cell;
      saveLayout();
    }
  }
  await render();
  selected = new Set([path]);
  focusId = path;
  paintSelection();
  startRename(path);
}

// Inline rename (F2) — Windows-style edit box under the icon.
function startRename(id) {
  const it = itemById(id);
  const el = elById(id);
  if (!it?.entry || !el || renaming) return;
  renaming = id;
  const label = el.querySelector('.desk-label');
  const box = h('textarea', { class: 'desk-rename', spellcheck: false, rows: 1, 'aria-label': t('files.rename') });
  box.value = it.entry.name;
  label.hidden = true;
  el.classList.add('renaming');
  el.draggable = false;
  el.appendChild(box);
  const fit = () => {
    box.style.height = 'auto';
    box.style.height = `${Math.min(120, box.scrollHeight)}px`;
  };
  fit();
  box.focus();
  const dot = it.entry.dir ? -1 : it.entry.name.lastIndexOf('.');
  box.setSelectionRange(0, dot > 0 ? dot : it.entry.name.length);
  let done = false;
  const finish = async (commit) => {
    if (done) return;
    done = true;
    const value = box.value.trim().replace(/\n/g, '');
    box.remove();
    label.hidden = false;
    el.classList.remove('renaming');
    el.draggable = true;
    renaming = null;
    if (!commit || !value || value === it.entry.name) {
      el.focus({ preventScroll: true });
      return;
    }
    if (!validName(value)) {
      ui.alert(t(new TextEncoder().encode(value).length > 255 ? 'desktop.nameTooLong' : 'desktop.invalidName'), { title: t('desktop.renameError') });
      return;
    }
    try {
      const res = await api.invoke('fs:rename', it.entry.path, value);
      const newPath = res?.path || `${desktopDir}/${value}`;
      if (layout.pos[it.id]) {
        layout.pos[newPath] = layout.pos[it.id];
        delete layout.pos[it.id];
        saveLayout();
      }
      selected = new Set([newPath]);
      focusId = newPath;
      await render();
      elById(newPath)?.focus({ preventScroll: true });
    } catch (err) {
      ui.alert(errText(err), { title: t('desktop.renameError') });
    }
  };
  box.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      finish(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finish(false);
    }
  });
  box.addEventListener('input', fit);
  box.addEventListener('blur', () => finish(true));
  box.addEventListener('pointerdown', (e) => e.stopPropagation());
  box.addEventListener('dblclick', (e) => e.stopPropagation());
}

// ---------------------------------------------------------------- context menus
let lastMenuPoint = null;

function openWithItems(it) {
  const ext = (it.entry.ext || '').toLowerCase();
  const apps = registry.list().filter((m) => (m.fileTypes || []).includes(ext));
  return apps.map((m) => ({ label: i18n.name(m.name), icon: 'app_generic', action: () => registry.launch(m.id, { file: it.entry.path }) }));
}

function iconMenu(e, it) {
  if (!selected.has(it.id)) setFocus(it.id);
  const sel = selectedItems();
  if (it.special) {
    const extra =
      it.special === 'trash'
        ? [
            '-',
            {
              label: t('desktop.emptyBin'),
              icon: 'delete',
              action: async () => {
                if (await ui.confirm(t('desktop.emptyBinConfirm'), { title: t('desktop.emptyBin'), okLabel: t('common.delete'), danger: true })) op(() => api.invoke('fs:trashEmpty'));
              },
            },
          ]
        : [];
    ui.menu(e, [{ label: t('desktop.open'), icon: 'open', action: it.open }, ...extra]);
    return;
  }
  const files = sel.filter((x) => x.entry);
  const single = files.length === 1 ? files[0] : null;
  const ow = single && !single.entry.dir ? openWithItems(single) : [];
  ui.menu(
    e,
    [
      { label: t('desktop.open'), icon: 'open', action: () => files.forEach((x) => x.open()) },
      ow.length > 1 ? { label: t('desktop.openWith'), icon: 'apps', submenu: ow } : null,
      single?.entry.dir ? { label: t('desktop.openTerminalHere'), icon: 'window_console', hidden: !registry.get('terminal'), action: () => shell.launch('terminal', { cwd: single.entry.path }) } : null,
      '-',
      { label: t('desktop.copyPath'), icon: 'link', action: () => api.invoke('clipboard:writeText', files.map((x) => x.entry.path).join('\n')).catch(() => {}) },
    ].filter(Boolean),
    {
      iconBar: [
        { label: t('files.cut'), icon: 'cut', action: () => copySelected('cut') },
        { label: t('files.copy'), icon: 'copy', action: () => copySelected('copy') },
        { label: t('files.rename'), icon: 'rename', disabled: !single, action: () => single && startRename(single.id) },
        { label: t('files.delete'), icon: 'delete', action: trashSelected },
      ],
    },
  );
}

function deskMenu(e) {
  lastMenuPoint = { x: e.clientX, y: e.clientY };
  const clip = shell.clipboard.getFiles();
  const sz = settings.get('desktopIconSize') || 'medium';
  const sortBy = layout.sort || 'name';
  const sort = (by) => {
    layout.sort = by;
    layout.pos = {};
    saveLayout();
    render();
  };
  ui.menu(e, [
    {
      label: t('desktop.view'),
      icon: 'grid',
      submenu: [
        { label: t('desktop.large'), icon: 'grid', checked: sz === 'large', action: () => settings.set('desktopIconSize', 'large') },
        { label: t('desktop.medium'), icon: 'grid', checked: sz === 'medium', action: () => settings.set('desktopIconSize', 'medium') },
        { label: t('desktop.small'), icon: 'grid', checked: sz === 'small', action: () => settings.set('desktopIconSize', 'small') },
        '-',
        {
          label: t('desktop.autoArrange'),
          checked: layout.auto,
          action: () => {
            layout.auto = !layout.auto;
            if (layout.auto) layout.pos = {};
            saveLayout();
            render();
          },
        },
        { label: t('desktop.showIcons'), checked: settings.get('desktopIcons') !== false, action: () => settings.set('desktopIcons', settings.get('desktopIcons') === false) },
      ],
    },
    {
      label: t('desktop.sortBy'),
      icon: 'arrow_sort',
      submenu: [
        { label: t('desktop.sortName'), checked: sortBy === 'name', action: () => sort('name') },
        { label: t('desktop.sortSize'), checked: sortBy === 'size', action: () => sort('size') },
        { label: t('desktop.sortType'), checked: sortBy === 'type', action: () => sort('type') },
        { label: t('desktop.sortDate'), checked: sortBy === 'date', action: () => sort('date') },
      ],
    },
    { label: t('desktop.refresh'), icon: 'arrow_clockwise', shortcut: 'F5', action: refresh },
    '-',
    { label: t('files.paste'), icon: 'clipboard_paste', shortcut: 'Ctrl+V', disabled: !clip?.paths?.length, action: paste },
    '-',
    {
      label: t('desktop.new'),
      icon: 'add_circle',
      submenu: [
        { label: t('desktop.folder'), icon: 'folder', action: () => newItem('folder') },
        { label: t('desktop.textDocument'), icon: 'document_text', action: () => newItem('text') },
      ],
    },
    '-',
    { label: t('desktop.display'), icon: 'desktop', action: () => shell.launch('settings', { page: 'display' }) },
    { label: t('desktop.personalize'), icon: 'paint_brush', action: () => shell.launch('settings', { page: 'personalization' }) },
    registry.get('terminal') ? '-' : null,
    registry.get('terminal') ? { label: t('desktop.openTerminal'), icon: 'window_console', action: () => shell.launch('terminal', { cwd: desktopDir }) } : null,
  ].filter(Boolean));
}

async function refresh() {
  if (!reduceMotion()) {
    iconsBox.animate([{ opacity: 1 }, { opacity: 0.35 }, { opacity: 1 }], { duration: 260, easing: 'linear' });
  }
  await render();
}

// ---------------------------------------------------------------- pointer: selection + rubber band
function onPointerDown(e) {
  if (e.button !== 0 && e.button !== 2) return;
  const iconEl = e.target.closest('.desk-icon');
  if (iconEl) {
    const id = iconEl.dataset.id;
    if (e.button === 2 && selected.has(id)) return;
    if (e.ctrlKey) setFocus(id, { toggle: true });
    else if (e.shiftKey) setFocus(id, { extend: true });
    else if (!selected.has(id) || e.button === 2) setFocus(id);
    else {
      focusId = id;
      iconEl.focus({ preventScroll: true });
      // Click on an already-selected icon: collapse the selection on pointerup unless dragging.
      if (pendingUp) window.removeEventListener('pointerup', pendingUp);
      pendingUp = () => {
        window.removeEventListener('pointerup', pendingUp);
        pendingUp = null;
        if (!dragState) setFocus(id);
      };
      window.addEventListener('pointerup', pendingUp);
    }
    return;
  }
  if (e.button !== 0 || e.target.closest('.desk-rename')) return;
  rubberBand(e);
}

function rubberBand(e) {
  if (!e.ctrlKey) selected.clear();
  const base = new Set(selected);
  paintSelection();
  root.focus({ preventScroll: true });
  const band = h('div', { class: 'desk-band' });
  root.appendChild(band);
  const sx = e.clientX;
  const sy = e.clientY;
  let moved = false;
  const move = (ev) => {
    if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 3) return;
    moved = true;
    const x = Math.min(sx, ev.clientX);
    const y = Math.min(sy, ev.clientY);
    const w = Math.abs(ev.clientX - sx);
    const hh = Math.abs(ev.clientY - sy);
    Object.assign(band.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${hh}px`, display: 'block' });
    selected = new Set(base);
    for (const el of iconsBox.children) {
      const r = el.getBoundingClientRect();
      if (r.right > x && r.left < x + w && r.bottom > y && r.top < y + hh) selected.add(el.dataset.id);
    }
    paintSelection();
  };
  const up = () => {
    band.remove();
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    const first = items.find((x) => selected.has(x.id));
    if (first) focusId = first.id;
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

// ---------------------------------------------------------------- drag and drop
function onDragStart(e) {
  const el = e.target.closest?.('.desk-icon');
  if (!el || renaming) return e.preventDefault();
  if (pendingUp) {
    window.removeEventListener('pointerup', pendingUp);
    pendingUp = null;
  }
  const id = el.dataset.id;
  if (!selected.has(id)) setFocus(id);
  const sel = selectedItems();
  const paths = sel.filter((x) => x.entry).map((x) => x.entry.path);
  const dt = e.dataTransfer;
  dt.effectAllowed = 'copyMove';
  if (paths.length) {
    dt.setData(DND_MIME, JSON.stringify(paths));
    dt.setData('text/uri-list', paths.map((p) => `file://${p.split('/').map(encodeURIComponent).join('/')}`).join('\r\n'));
    dt.setData('text/plain', paths.join('\n'));
  } else {
    dt.setData('application/x-aurora-desktop', id);
  }
  const r = el.getBoundingClientRect();
  dragState = { ids: sel.map((x) => x.id), paths, grab: [e.clientX - r.left, e.clientY - r.top], origin: el._cell };
  // Drag image: the icon (with a count badge for several items).
  const ghost = h('div', { class: 'desk-ghost', style: { width: `${r.width}px` } }, el.querySelector('.desk-ico').cloneNode(true), sel.length > 1 ? h('span', { class: 'desk-ghost-count' }, String(sel.length)) : null);
  document.body.appendChild(ghost);
  try {
    dt.setDragImage(ghost, dragState.grab[0], dragState.grab[1]);
  } catch {}
  setTimeout(() => ghost.remove(), 0);
  setTimeout(() => sel.forEach((x) => elById(x.id)?.classList.add('dragging')), 0);
}

function onDragEnd() {
  for (const el of iconsBox.querySelectorAll('.dragging')) el.classList.remove('dragging');
  markDrop(null);
  dragState = null;
}

function dropTargetFor(e) {
  const el = e.target.closest?.('.desk-icon');
  if (!el) return null;
  const it = itemById(el.dataset.id);
  if (!it) return null;
  if (dragState?.ids.includes(it.id)) return null;
  if (it.special === 'trash') return { el, kind: 'trash' };
  if (it.entry?.dir) return { el, kind: 'folder', path: it.entry.path };
  return null;
}
let markedEl = null;
function markDrop(el) {
  if (markedEl === el) return;
  markedEl?.classList.remove('drop-target');
  markedEl = el;
  el?.classList.add('drop-target');
}

function onDragOver(e) {
  const types = [...(e.dataTransfer?.types || [])];
  const internal = !!dragState;
  if (!internal && !(shellDrag && types.includes(DND_MIME)) && !types.includes('Files')) return;
  e.preventDefault();
  const target = dropTargetFor(e);
  markDrop(target?.el || null);
  if (target?.kind === 'trash') e.dataTransfer.dropEffect = internal && dragState.paths.length ? 'move' : 'none';
  else if (target) e.dataTransfer.dropEffect = e.ctrlKey ? 'copy' : 'move';
  else if (internal) e.dataTransfer.dropEffect = 'move';
  else e.dataTransfer.dropEffect = e.ctrlKey || types.includes('Files') ? 'copy' : 'move';
}

async function onDrop(e) {
  e.preventDefault();
  markDrop(null);
  const target = dropTargetFor(e);
  const dt = e.dataTransfer;
  let paths = trustedPaths(dt);
  const fromShell = paths.length > 0;
  if (!paths.length && dt.files?.length) paths = [...dt.files].map((f) => api.pathForFile(f)).filter(Boolean);
  const internal = dragState;
  if (target?.kind === 'trash') {
    if (paths.length) await op(() => api.invoke('fs:trash', paths));
    selected.clear();
    return render();
  }
  if (target?.kind === 'folder') {
    if (paths.length) await op(() => api.invoke('fs:copy', paths, target.path, { move: !e.ctrlKey }));
    return render();
  }
  if (internal) {
    // Move the dragged icons to the drop cell, keeping their relative arrangement.
    const cell = cellAt(e.clientX - internal.grab[0] + size().w / 2, e.clientY - internal.grab[1] + size().h / 2);
    const { rows, cols } = gridDims();
    const origin = internal.origin || cell;
    const dc = cell[0] - origin[0];
    const dr = cell[1] - origin[1];
    if (!dc && !dr) return;
    const cells = assignCells(items);
    const moving = new Set(internal.ids);
    const occupied = new Set();
    for (const it of items) if (!moving.has(it.id)) occupied.add(cells.get(it.id).join(','));
    layout.auto = false;
    for (const it of items) if (!moving.has(it.id)) layout.pos[it.id] = cells.get(it.id);
    for (const id of internal.ids) {
      const [c0, r0] = cells.get(id);
      let c = Math.max(0, Math.min(cols - 1, c0 + dc));
      let r = Math.max(0, Math.min(rows - 1, r0 + dr));
      if (occupied.has(`${c},${r}`)) [c, r] = firstFreeCell(occupied, rows, c * rows + r);
      occupied.add(`${c},${r}`);
      layout.pos[id] = [c, r];
    }
    saveLayout();
    return render();
  }
  // Files dropped from an app window or another program: move (same session) / copy (Ctrl, external).
  if (paths.length) {
    const res = await op(() => api.invoke('fs:copy', paths, desktopDir, { move: !e.ctrlKey && fromShell }));
    if (Array.isArray(res)) {
      const cell = cellAt(e.clientX, e.clientY);
      if (!layout.auto && res[0]) layout.pos[res[0]] = cell;
      saveLayout();
      await render();
      selected = new Set(res);
      paintSelection();
    }
  }
}

// ---------------------------------------------------------------- keyboard
function onKey(e) {
  if (renaming || e.target.closest?.('.desk-rename')) return;
  const ctrl = e.ctrlKey || e.metaKey;
  const k = e.key;
  if (ctrl && k.toLowerCase() === 'a') {
    e.preventDefault();
    selected = new Set(items.map((x) => x.id));
    paintSelection();
    return;
  }
  if (ctrl && k.toLowerCase() === 'c') return (e.preventDefault(), copySelected('copy'));
  if (ctrl && k.toLowerCase() === 'x') return (e.preventDefault(), copySelected('cut'));
  if (ctrl && k.toLowerCase() === 'v') return (e.preventDefault(), paste());
  if (ctrl && e.shiftKey && k.toLowerCase() === 'n') return (e.preventDefault(), newItem('folder'));
  if (k === 'F5') return (e.preventDefault(), refresh());
  if (k === 'F2' && focusId) return (e.preventDefault(), startRename(focusId));
  if (k === 'Delete') return (e.preventDefault(), e.shiftKey ? deleteSelected() : trashSelected());
  if (k === 'Enter' && selected.size) {
    e.preventDefault();
    selectedItems().forEach((x) => x.open());
    return;
  }
  if (k === 'ContextMenu' || (k === 'F10' && e.shiftKey)) {
    e.preventDefault();
    const el = focusId && elById(focusId);
    if (el && selected.has(focusId)) {
      const r = el.getBoundingClientRect();
      iconMenu(new MouseEvent('contextmenu', { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }), itemById(focusId));
    } else deskMenu(new MouseEvent('contextmenu', { clientX: 200, clientY: 200 }));
    return;
  }
  const dirs = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
  if (dirs[k] || k === 'Home' || k === 'End') {
    e.preventDefault();
    if (!items.length) return;
    const cells = assignCells(items);
    let next;
    if (!focusId) next = items[0].id;
    else if (k === 'Home') next = items[0].id;
    else if (k === 'End') next = items[items.length - 1].id;
    else {
      const [c, r] = cells.get(focusId);
      const [dc, dr] = dirs[k];
      // Nearest icon in the pressed direction.
      let best = null;
      let bestD = Infinity;
      for (const it of items) {
        if (it.id === focusId) continue;
        const [c2, r2] = cells.get(it.id);
        const along = dc ? (c2 - c) * dc : (r2 - r) * dr;
        if (along <= 0) continue;
        const across = dc ? Math.abs(r2 - r) : Math.abs(c2 - c);
        const d = along + across * 4;
        if (d < bestD) {
          bestD = d;
          best = it.id;
        }
      }
      next = best || focusId;
    }
    setFocus(next, { extend: e.shiftKey, select: !ctrl });
    return;
  }
  // Type-ahead: jump to the next icon starting with the typed letter.
  if (k.length === 1 && !ctrl && !e.altKey && /\S/.test(k)) {
    const lower = k.toLowerCase();
    const start = items.findIndex((x) => x.id === focusId);
    for (let i = 1; i <= items.length; i++) {
      const it = items[(start + i) % items.length];
      if (it.label.toLowerCase().startsWith(lower)) {
        setFocus(it.id);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- wallpaper
let wallUrl = '';
async function setWallpaper(url, animate = true) {
  if (!url || url === wallUrl) return;
  wallUrl = url;
  const layer = h('div', { class: 'wallpaper-layer' });
  layer.style.backgroundImage = `url("${url}")`;
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
  } catch {}
  if (url !== wallUrl) return; // superseded meanwhile
  const old = [...wallEl.children];
  wallEl.appendChild(layer);
  if (!animate || reduceMotion() || !old.length) {
    old.forEach((o) => o.remove());
    return;
  }
  layer.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 700, easing: 'cubic-bezier(0.33,0,0.67,1)' }).finished.then(
    () => old.forEach((o) => o.remove()),
    () => old.forEach((o) => o.remove()),
  );
}
function applyFit() {
  wallEl.dataset.fit = settings.get('wallpaperFit') || 'fill';
}

export const desktop = {
  async mount(el) {
    root = el;
    i18n.extend(STRINGS);
    root.setAttribute('role', 'listbox');
    root.setAttribute('aria-multiselectable', 'true');
    root.setAttribute('aria-label', t('places.desktop'));
    root.tabIndex = -1;
    wallEl = h('div', { class: 'wallpaper' });
    iconsBox = h('div', { class: 'desk-icons' });
    root.append(wallEl, iconsBox);
    applyFit();
    setWallpaper(theme.wallpaperUrl, false);
    theme.on('wallpaper', (url) => setWallpaper(url, true));
    settings.on('wallpaperFit', applyFit);

    root.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const iconEl = e.target.closest('.desk-icon');
      if (iconEl) iconMenu(e, itemById(iconEl.dataset.id));
      else {
        selected.clear();
        paintSelection();
        deskMenu(e);
      }
    });
    root.addEventListener('pointerdown', onPointerDown);
    root.addEventListener('keydown', onKey);
    root.addEventListener('dragstart', onDragStart);
    root.addEventListener('dragend', onDragEnd);
    root.addEventListener('dragover', onDragOver);
    root.addEventListener('dragleave', (e) => !root.contains(e.relatedTarget) && markDrop(null));
    root.addEventListener('drop', onDrop);
    root.addEventListener('focusin', (e) => {
      const iconEl = e.target.closest?.('.desk-icon');
      if (iconEl) focusId = iconEl.dataset.id;
    });

    const xdg = shell.xdg || (await api.invoke('fs:xdg').catch(() => null));
    desktopDir = xdg?.desktop || `${env.home}/Desktop`;
    await loadLayout();
    await render();
    try {
      const watchId = await api.invoke('fs:watch', desktopDir);
      api.on('fs:changed', (ev) => (ev.watchId === watchId || ev.dir === desktopDir) && render());
    } catch {}
    shell.on('files-clipboard', (clip) => {
      cutPaths = new Set(clip?.mode === 'cut' ? clip.paths : []);
      for (const el of iconsBox.children) el.classList.toggle('cut', cutPaths.has(el.dataset.id));
    });
    settings.on('desktopIcons', render);
    settings.on('desktopIconSize', () => render());
    i18n.on('change', render);
    let rt = null;
    window.addEventListener('resize', () => {
      clearTimeout(rt);
      rt = setTimeout(render, 150);
    });
    // The taskbar moved to another edge or changed size (personalization): the icon area changed too.
    shell.on('taskbar:layout', () => {
      clearTimeout(rt);
      rt = setTimeout(render, 60);
    });
  },
  refresh: render,
  select(ids) {
    selected = new Set(ids);
    paintSelection();
  },
  items: () => items.map(({ id, label, special, entry }) => ({ id, label, special: special || null, path: entry?.path || null })),
  get selection() {
    return [...selected];
  },
  rename: (id) => startRename(id),
};
