// Desktop: wallpaper, icons for ~/Desktop (+ This PC / Recycle Bin / installer), context menu,
// rubber-band selection, double-click to open.
import { h, icon, ui, clear } from './ui.js';
import { api, env } from './api.js';
import { settings } from './settings.js';
import { i18n, t } from './i18n.js';
import { shell } from './services.js';
import { registry } from './registry.js';

let root;
let iconsBox;
let desktopDir = '';
let selected = new Set();

function specialIcons() {
  const list = [
    { id: 'thispc', label: t('desktop.thisPc'), img: 'app://shell/assets/icons/this-pc.svg', open: () => shell.launch('files', { path: 'thispc' }) },
    { id: 'trash', label: t('desktop.recycleBin'), img: 'app://shell/assets/icons/recycle-bin.svg', open: () => shell.launch('files', { path: 'trash' }) },
  ];
  if (env.live && registry.get('installer')) {
    list.push({ id: 'installer', label: t('desktop.installAurora'), img: registry.iconUrl('installer'), open: () => shell.launch('installer') });
  }
  return list;
}

async function render() {
  if (!iconsBox) return;
  clear(iconsBox);
  if (settings.get('desktopIcons') === false) return;
  const items = specialIcons().map((s) => ({ ...s, special: true }));
  try {
    const entries = await api.invoke('fs:list', desktopDir);
    for (const e of entries) items.push({ id: e.path, label: e.name, entry: e, open: () => shell.openFile(e.path) });
  } catch {}
  for (const it of items) {
    const el = h(
      'div',
      {
        class: ['desk-icon', selected.has(it.id) && 'selected'],
        tabindex: '0',
        dataset: { id: it.id },
        onclick: (e) => {
          if (!e.ctrlKey) selected.clear();
          selected.add(it.id);
          paintSelection();
        },
        ondblclick: () => it.open(),
        onkeydown: (e) => e.key === 'Enter' && it.open(),
        oncontextmenu: (e) => {
          selected = new Set([it.id]);
          paintSelection();
          iconMenu(e, it);
        },
      },
      it.img ? h('img', { src: it.img, alt: '', draggable: false }) : desktopEntryIcon(it.entry),
      h('span', { class: 'desk-label' }, it.label),
    );
    iconsBox.appendChild(el);
  }
}

function desktopEntryIcon(e) {
  if (!e.dir && ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'].includes(e.ext)) {
    return h('img', { class: 'thumb', src: api.mediaUrl(e.path), alt: '', draggable: false, loading: 'lazy' });
  }
  const fileIcon = ui.fileIcon(e);
  return icon(fileIcon, { size: 40, filled: e.dir, class: e.dir ? 'folder-icon' : `file-icon fi-${fileIcon}` });
}

function paintSelection() {
  for (const el of iconsBox.children) el.classList.toggle('selected', selected.has(el.dataset.id));
}

function iconMenu(e, it) {
  if (it.special) {
    ui.menu(e, [{ label: t('desktop.open'), icon: 'open', action: it.open }]);
    return;
  }
  ui.menu(e, [
    { label: t('desktop.open'), icon: 'open', action: it.open },
    '-',
    { label: t('files.copy'), icon: 'copy', action: () => shell.clipboard.setFiles([it.entry.path], 'copy') },
    { label: t('files.cut'), icon: 'cut', action: () => shell.clipboard.setFiles([it.entry.path], 'cut') },
    {
      label: t('files.rename'),
      icon: 'rename',
      action: async () => {
        const n = await ui.prompt({ title: t('files.rename'), value: it.entry.name });
        if (n && n !== it.entry.name) api.invoke('fs:rename', it.entry.path, n).catch((err) => ui.alert(err.message));
      },
    },
    { label: t('files.delete'), icon: 'delete', danger: true, action: () => api.invoke('fs:trash', [it.entry.path]).then(render) },
  ]);
}

async function newItem(kind) {
  const base = kind === 'folder' ? t('ui.newFolder') : `${t('desktop.newTextDoc')}.txt`;
  const name = await api.invoke('fs:uniqueName', desktopDir, base);
  if (kind === 'folder') await api.invoke('fs:mkdir', `${desktopDir}/${name}`);
  else await api.invoke('fs:writeText', `${desktopDir}/${name}`, '');
  render();
}

function deskMenu(e) {
  const clip = shell.clipboard.getFiles();
  ui.menu(e, [
    {
      label: t('desktop.view'),
      icon: 'grid',
      submenu: [
        { label: t('desktop.showIcons'), checked: settings.get('desktopIcons') !== false, action: () => settings.set('desktopIcons', settings.get('desktopIcons') === false) },
      ],
    },
    { label: t('desktop.refresh'), icon: 'arrow_clockwise', action: render },
    '-',
    {
      label: t('files.paste'),
      icon: 'clipboard_paste',
      disabled: !clip,
      action: async () => {
        await api.invoke('fs:copy', clip.paths, desktopDir, { move: clip.mode === 'cut' });
        if (clip.mode === 'cut') shell.clipboard.clearFiles();
        render();
      },
    },
    {
      label: t('desktop.new'),
      icon: 'add_circle',
      submenu: [
        { label: t('ui.newFolder'), icon: 'folder', action: () => newItem('folder') },
        { label: t('desktop.newTextDoc'), icon: 'document_text', action: () => newItem('text') },
      ],
    },
    '-',
    { label: t('desktop.openTerminal'), icon: 'window_console', action: () => shell.launch('terminal', { cwd: desktopDir }) },
    { label: t('desktop.display'), icon: 'desktop', action: () => shell.launch('settings', { page: 'display' }) },
    { label: t('desktop.personalize'), icon: 'paint_brush', action: () => shell.launch('settings', { page: 'personalization' }) },
  ]);
}

function rubberBand(e) {
  if (e.button !== 0 || e.target.closest('.desk-icon')) return;
  selected.clear();
  paintSelection();
  const band = h('div', { class: 'desk-band' });
  root.appendChild(band);
  const sx = e.clientX;
  const sy = e.clientY;
  const move = (ev) => {
    const x = Math.min(sx, ev.clientX);
    const y = Math.min(sy, ev.clientY);
    const w = Math.abs(ev.clientX - sx);
    const hh = Math.abs(ev.clientY - sy);
    Object.assign(band.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${hh}px` });
    selected.clear();
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
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

export const desktop = {
  async mount(el) {
    root = el;
    iconsBox = h('div', { class: 'desk-icons' });
    root.append(h('div', { class: 'wallpaper' }), iconsBox);
    root.addEventListener('contextmenu', (e) => {
      if (!e.target.closest('.desk-icon')) deskMenu(e);
    });
    root.addEventListener('pointerdown', rubberBand);
    const xdg = await api.invoke('fs:xdg');
    desktopDir = xdg.desktop;
    await render();
    try {
      await api.invoke('fs:watch', desktopDir);
      api.on('fs:changed', (ev) => ev.dir === desktopDir && render());
    } catch {}
    settings.on('desktopIcons', render);
    i18n.on('change', render);
  },
  refresh: render,
};
