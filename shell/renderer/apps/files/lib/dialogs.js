// Dialogs of File Explorer: Properties (separate window, like Windows), "Choose an app",
// Folder Options and the "Extract Compressed Folder" dialog.
import { shared, setPref, PREF_DEFAULTS, clearHistory, resetViews } from './shared.js';
import * as T from './types.js';
import * as ops from './ops.js';

// ---------------------------------------------------------------- Properties
const openProps = new Map(); // key -> Win (one properties window per item, like Windows)

export async function showProperties(ex, target) {
  const key = target.drive ? `drive:${target.drive.id}` : target.trash ? `trash:${target.trash.path}` : target.entries.map((e) => e.path).join('\n');
  const existing = openProps.get(key);
  if (existing && !existing._closing) {
    existing.focus();
    return;
  }
  const p = new PropsWindow(ex, target);
  openProps.set(key, p.win);
  p.win.on('close', () => openProps.delete(key));
  await p.init();
}

class PropsWindow {
  constructor(ex, target) {
    this.ex = ex;
    this.target = target;
    const { t } = ex;
    let title;
    if (target.drive) title = t('props.title', { name: T.driveName(target.drive, t) });
    else if (target.trash) title = t('props.title', { name: target.trash.name });
    else if (target.entries.length === 1) title = t('props.title', { name: target.entries[0].name === '/' ? T.driveName({ mountpoint: '/' }, t) : target.entries[0].name });
    else title = t('props.titleMany', { count: target.entries.length });
    this.win = ex.ctx.shell.wm.create({
      appId: 'files',
      title,
      icon: ex.ctx.appUrl('icon.svg'),
      width: 420,
      height: 580,
      minWidth: 380,
      minHeight: 420,
      maximizable: false,
      background: 'mica',
      className: 'app-files fx-props-win',
    });
    this.changes = {};
    this.offs = [];
    this.win.on('close', () => {
      this.offs.forEach((f) => f?.());
      if (this.statsOp) ex.api.invoke('files:cancel', this.statsOp).catch(() => {});
    });
  }

  async init() {
    const { h, t } = this.ex;
    const tg = this.target;
    this.pages = [];
    this.tabsEl = h('div', { class: 'fx-props-tabs', role: 'tablist' });
    this.pageHost = h('div', { class: 'fx-props-page' });
    this.applyBtn = h('button', { class: 'btn', disabled: true, onclick: () => this.apply() }, t('common.apply'));
    const foot = h('div', { class: 'fx-props-foot' },
      h('button', { class: 'btn primary', onclick: async () => {
        if (await this.apply()) this.win.close(true);
      } }, t('common.ok')),
      h('button', { class: 'btn', onclick: () => this.win.close(true) }, t('common.cancel')),
      this.applyBtn);
    this.win.body.append(h('div', { class: 'fx-props' }, this.tabsEl, this.pageHost, foot));
    this.win.body.addEventListener('keydown', (e) => {
      if (e.target.closest('.dialog-layer')) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        this.win.close(true);
      } else if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') {
        e.preventDefault();
        this.apply().then((ok) => ok && this.win.close(true));
      }
    });
    try {
      if (tg.drive) this.addPage(t('props.general'), await this.drivePage(tg.drive));
      else if (tg.trash) this.addPage(t('props.general'), this.trashPage(tg.trash));
      else if (tg.entries.length === 1) {
        const info = await this.ex.api.invoke('files:props', tg.entries[0].path);
        this.info = info;
        this.addPage(t('props.general'), this.generalPage(info));
        this.addPage(t('props.permissions'), this.permsPage(info));
      } else {
        this.addPage(t('props.general'), this.multiPage(tg.entries));
      }
    } catch (err) {
      this.pageHost.append(h('div', { class: 'infobar error' }, this.ex.icon('error_circle'), h('div', null, ops.errText(this.ex, err))));
    }
    this.select(0);
  }

  addPage(label, el) {
    const { h } = this.ex;
    const i = this.pages.length;
    const tab = h('button', { class: 'fx-props-tab', role: 'tab', onclick: () => this.select(i) }, label);
    this.tabsEl.append(tab);
    this.pages.push({ tab, el });
  }

  select(i) {
    this.pages.forEach((p, j) => {
      p.tab.classList.toggle('selected', i === j);
      p.tab.setAttribute('aria-selected', String(i === j));
    });
    this.pageHost.replaceChildren(this.pages[i]?.el || '');
  }

  dirty() {
    this.applyBtn.disabled = !Object.keys(this.changes).length;
  }

  row(label, value, cls) {
    const { h } = this.ex;
    return [h('div', { class: 'k' }, label), h('div', { class: ['v', 'selectable', cls] }, value)];
  }

  head(iconUrl, nameEl) {
    const { h } = this.ex;
    return h('div', { class: 'fx-props-head' }, h('img', { src: iconUrl, alt: '' }), nameEl);
  }

  generalPage(info) {
    const { h, t } = this.ex;
    const ex = this.ex;
    const isRoot = info.path === '/';
    const editable = !isRoot && info.path !== shared.home;
    const nameInput = h('input', { class: 'input grow', value: info.name, disabled: !editable, 'aria-label': t('cols.name'),
      oninput: () => {
        if (nameInput.value !== info.name) this.changes.name = nameInput.value;
        else delete this.changes.name;
        this.dirty();
      } });
    this.nameInput = nameInput;
    const ext = info.dir ? '' : info.ext;
    const grid = h('div', { class: 'fx-props-grid' });
    grid.append(...this.row(info.dir ? t('props.type') : t('props.typeOfFile'), ext ? `${T.typeName(info)} (${ext})` : T.typeName(info)));
    if (!info.dir) {
      const handler = ex.ctx.shell.registry.handlerFor(info.path);
      const opensWith = h('div', { class: 'fx-props-app' },
        handler ? h('img', { src: ex.ctx.shell.registry.iconUrl(handler), alt: '' }) : null,
        h('span', { class: 'grow ellipsis' }, handler ? ex.ctx.shell.registry.name(handler) : t('props.noApp')),
        h('button', { class: 'btn small', onclick: async () => {
          const res = await chooseApp(ex, info, this.win);
          if (res) this.win.close(true);
        } }, t('props.change')));
      grid.append(h('div', { class: 'k' }, t('props.opensWith')), opensWith);
    }
    if (info.link) grid.append(...this.row(t('props.target'), info.target || ''));
    grid.append(h('hr', { class: 'hsep span' }));
    grid.append(...this.row(t('props.location'), T.dirname(info.path)));
    const sizeV = h('span', null, info.dir ? '' : T.exactSize(info.size, t));
    const diskV = h('span', null, info.dir ? '' : T.exactSize(info.sizeOnDisk, t));
    const containsV = h('span');
    const spin = () => h('span', { class: 'spinner small fx-inline-spin' });
    grid.append(...this.row(t('props.size'), info.dir ? [spin(), sizeV] : sizeV));
    grid.append(...this.row(t('props.sizeOnDisk'), info.dir ? [spin(), diskV] : diskV));
    if (info.dir) grid.append(...this.row(t('props.contains'), [spin(), containsV]));
    grid.append(h('hr', { class: 'hsep span' }));
    grid.append(...this.row(t('props.created'), T.formatDateLong(info.birthtime)));
    grid.append(...this.row(t('props.modified'), T.formatDateLong(info.mtime)));
    grid.append(...this.row(t('props.accessed'), T.formatDateLong(info.atime)));
    grid.append(h('hr', { class: 'hsep span' }));
    const ro = h('input', { type: 'checkbox', checked: info.readonly, disabled: !info.writable && !info.readonly || isRoot,
      onchange: () => {
        if (ro.checked !== info.readonly) this.changes.readonly = ro.checked;
        else delete this.changes.readonly;
        this.dirty();
      } });
    const hid = h('input', { type: 'checkbox', checked: info.hidden, disabled: !editable,
      onchange: () => {
        if (hid.checked !== info.hidden) this.changes.hidden = hid.checked;
        else delete this.changes.hidden;
        this.dirty();
      } });
    grid.append(h('div', { class: 'k' }, t('props.attributes')),
      h('div', { class: 'v fx-props-attrs' },
        h('label', { class: 'checkbox' }, ro, h('span', null, t('props.readOnly'))),
        h('label', { class: 'checkbox' }, hid, h('span', null, t('props.hidden')))));
    if (info.dir) this.computeStats([info.path], sizeV, diskV, containsV, grid);
    return h('div', { class: 'fx-props-body' }, this.head(this.ex.iconForEntry(info), nameInput), grid);
  }

  computeStats(paths, sizeV, diskV, containsV, root) {
    const { t } = this.ex;
    const opId = `ps${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    this.statsOp = opId;
    const paint = (s) => {
      sizeV.textContent = T.exactSize(s.bytes, t);
      diskV.textContent = T.exactSize(s.disk, t);
      if (containsV) containsV.textContent = t('props.containsValue', { files: T.formatNumber(s.files), dirs: T.formatNumber(s.dirs) });
    };
    this.offs.push(this.ex.api.on('files:dirStats', (s) => s.opId === opId && paint(s)));
    this.ex.api
      .invoke('files:dirStats', paths, { opId })
      .then((s) => {
        paint(s);
        this.statsOp = null;
      })
      .catch(() => {})
      .finally(() => root.querySelectorAll('.fx-inline-spin').forEach((x) => x.remove()));
  }

  permsPage(info) {
    const { h, t } = this.ex;
    const env = this.ex.ctx.env || {};
    const canChange = env.uid === 0 || env.uid === info.uid;
    const bits = [
      ['owner', 0o400, 0o200, 0o100],
      ['group', 0o040, 0o020, 0o010],
      ['others', 0o004, 0o002, 0o001],
    ];
    let mode = info.mode & 0o7777;
    const table = h('div', { class: 'fx-perm-grid', role: 'grid' },
      h('div'), h('div', { class: 'k c' }, t('perm.read')), h('div', { class: 'k c' }, t('perm.write')), h('div', { class: 'k c' }, t(info.dir ? 'perm.list' : 'perm.execute')));
    const boxes = [];
    for (const [who, r, w, x] of bits) {
      table.append(h('div', { class: 'k' }, t(`perm.${who}`)));
      for (const bit of [r, w, x]) {
        const cb = h('input', { type: 'checkbox', checked: !!(mode & bit), disabled: !canChange, 'aria-label': `${t(`perm.${who}`)} ${bit}`,
          onchange: () => {
            mode = cb.checked ? mode | bit : mode & ~bit;
            if (mode !== (info.mode & 0o7777)) this.changes.mode = mode;
            else delete this.changes.mode;
            octal.textContent = mode.toString(8).padStart(3, '0');
            this.dirty();
          } });
        boxes.push(cb);
        table.append(h('label', { class: 'checkbox c' }, cb));
      }
    }
    const octal = h('span', { class: 'mono' }, mode.toString(8).padStart(3, '0'));
    const grid = h('div', { class: 'fx-props-grid' },
      ...this.row(t('perm.ownerName'), info.owner),
      ...this.row(t('perm.groupName'), info.group),
      ...this.row(t('perm.mode'), octal));
    return h('div', { class: 'fx-props-body' },
      grid,
      h('hr', { class: 'hsep' }),
      table,
      canChange ? null : h('div', { class: 'infobar', style: { marginTop: '12px' } }, this.ex.icon('info'), h('div', { class: 'caption' }, t('perm.notOwner'))));
  }

  multiPage(entries) {
    const { h, t } = this.ex;
    const files = entries.filter((e) => !e.dir).length;
    const dirs = entries.length - files;
    const types = new Set(entries.map((e) => T.typeName(e)));
    const parents = new Set(entries.map((e) => T.dirname(e.path)));
    const grid = h('div', { class: 'fx-props-grid' });
    grid.append(...this.row(t('props.type'), types.size === 1 ? t('props.allOfType', { type: [...types][0] }) : t('props.multipleTypes')));
    grid.append(...this.row(t('props.location'), parents.size === 1 ? t('props.allIn', { path: [...parents][0] }) : t('props.various')));
    const sizeV = h('span');
    const diskV = h('span');
    const spin = () => h('span', { class: 'spinner small fx-inline-spin' });
    grid.append(...this.row(t('props.size'), [spin(), sizeV]));
    grid.append(...this.row(t('props.sizeOnDisk'), [spin(), diskV]));
    this.computeStats(entries.map((e) => e.path), sizeV, diskV, null, grid);
    const label = h('div', { class: 'body-strong' }, t('props.filesFolders', { files: T.formatNumber(files), dirs: T.formatNumber(dirs) }));
    return h('div', { class: 'fx-props-body' }, this.head(T.iconPath('file'), label), grid);
  }

  trashPage(e) {
    const { h, t } = this.ex;
    const grid = h('div', { class: 'fx-props-grid' },
      ...this.row(t('props.origin'), T.dirname(e.originalPath || '')),
      ...this.row(t('cols.deleted'), T.formatDateLong(e.deletedAt)),
      ...this.row(t('props.type'), T.typeName(e)),
      ...this.row(t('props.size'), e.dir ? '—' : T.exactSize(e.size, t)),
      ...this.row(t('props.modified'), T.formatDateLong(e.mtime)));
    const restoreBtn = h('button', { class: 'btn', onclick: async () => {
      await ops.restore(this.ex, [e]);
      this.win.close(true);
    } }, this.ex.icon('arrow_undo'), t('trash.restore'));
    return h('div', { class: 'fx-props-body' },
      this.head(this.ex.iconForEntry(e), h('div', { class: 'body-strong ellipsis' }, e.name)),
      grid,
      h('div', { style: { marginTop: '16px' } }, restoreBtn));
  }

  async drivePage(d) {
    const { h, t } = this.ex;
    let usage = null;
    if (d.mountpoint) usage = await this.ex.api.invoke('fs:usage', d.mountpoint).catch(() => null);
    const size = usage?.size ?? d.size ?? 0;
    const free = usage?.free ?? d.free ?? 0;
    const used = Math.max(0, size - free);
    const pct = size ? used / size : 0;
    const kind = d.mountpoint === '/' || d.kind === 'system' ? t('drives.kindLocal') : d.kind === 'optical' ? t('drives.kindOptical') : d.removable || d.kind === 'usb' ? t('drives.kindUsb') : t('drives.kindLocal');
    const grid = h('div', { class: 'fx-props-grid' },
      ...this.row(t('props.type'), kind),
      ...this.row(t('drives.fileSystem'), d.fstype || '—'),
      ...(d.device ? this.row(t('drives.device'), d.device) : []),
      ...this.row(t('drives.mountpoint'), d.mountpoint || t('drives.notMounted')),
      h('hr', { class: 'hsep span' }),
      h('div', { class: 'k' }, h('span', { class: 'fx-swatch used' }), t('drives.used')), h('div', { class: 'v' }, T.exactSize(used, t)),
      h('div', { class: 'k' }, h('span', { class: 'fx-swatch free' }), t('drives.freeSpace')), h('div', { class: 'v' }, T.exactSize(free, t)),
      h('hr', { class: 'hsep span' }),
      ...this.row(t('drives.capacity'), T.exactSize(size, t)));
    // Donut chart
    const r = 42;
    const c = 2 * Math.PI * r;
    const donut = h('div', { class: 'fx-donut', html: `<svg viewBox="0 0 100 100" width="120" height="120" aria-hidden="true"><circle cx="50" cy="50" r="${r}" class="free" stroke-width="16" fill="none"/><circle cx="50" cy="50" r="${r}" class="used ${pct > 0.9 ? 'full' : ''}" stroke-width="16" fill="none" stroke-dasharray="${(pct * c).toFixed(2)} ${c.toFixed(2)}" transform="rotate(-90 50 50)"/></svg>` },
      h('div', { class: 'caption text-2' }, t('drives.driveLabel', { name: T.driveName(d, t) })));
    return h('div', { class: 'fx-props-body' },
      this.head(T.driveIcon(d), h('div', { class: 'body-strong ellipsis' }, T.driveName(d, t))),
      grid,
      donut);
  }

  async apply() {
    const ex = this.ex;
    const ch = this.changes;
    if (!Object.keys(ch).length) return true;
    let info = this.info;
    try {
      if (this.target.entries && this.target.entries.length === 1 && info) {
        if (ch.mode !== undefined) {
          await ex.api.invoke('files:chmod', info.path, ch.mode);
          info.mode = (info.mode & ~0o7777) | ch.mode;
        }
        if (ch.readonly !== undefined) {
          const cur = (await ex.api.invoke('files:props', info.path)).mode & 0o7777;
          await ex.api.invoke('files:chmod', info.path, ch.readonly ? cur & ~0o222 : cur | 0o200);
          info.readonly = ch.readonly;
        }
        let name = ch.name !== undefined ? ch.name.trim() : info.name;
        if (ch.hidden !== undefined) name = ch.hidden ? (name.startsWith('.') ? name : `.${name}`) : name.replace(/^\.+/, '');
        if (name !== info.name) {
          const err = ops.validateName(ex, name);
          if (err) {
            await ex.ui.alert(err, { title: ex.t('rename.title'), parent: this.win });
            return false;
          }
          const res = await ops.rename(ex, info, name);
          this.info = info = { ...info, ...res };
          this.win.setTitle(ex.t('props.title', { name: res.name }));
          if (this.nameInput) this.nameInput.value = res.name;
        }
      }
      this.changes = {};
      this.dirty();
      ex.refreshAll();
      return true;
    } catch (err) {
      await ex.ui.alert(ops.errText(ex, err), { title: ex.t('props.applyError'), parent: this.win });
      return false;
    }
  }
}

// ---------------------------------------------------------------- Open with -> Choose another app
export async function chooseApp(ex, entry, parentWin = ex.win) {
  const { h, t } = ex;
  const reg = ex.ctx.shell.registry;
  const ext = (entry.ext || '').toLowerCase();
  const apps = reg.list().filter((m) => m.id !== 'files');
  const suggested = apps.filter((m) => (m.fileTypes || []).includes(ext));
  const others = apps.filter((m) => !suggested.includes(m));
  let selected = reg.handlerFor(entry.path) || suggested[0]?.id || others[0]?.id || null;
  const list = h('div', { class: 'fx-apps', role: 'listbox' });
  const rows = [];
  const mkRow = (m) => {
    const row = h('div', {
      class: ['fx-app-row', m.id === selected && 'selected'],
      role: 'option',
      tabindex: '-1',
      onclick: () => pick(m.id),
      ondblclick: () => {
        pick(m.id);
        doneRef?.('once');
      },
    }, h('img', { src: reg.iconUrl(m.id), alt: '' }), h('span', { class: 'ellipsis' }, reg.name(m.id)));
    row.dataset.id = m.id;
    rows.push(row);
    return row;
  };
  const pick = (id) => {
    selected = id;
    rows.forEach((r) => {
      r.classList.toggle('selected', r.dataset.id === id);
      r.setAttribute('aria-selected', String(r.dataset.id === id));
    });
  };
  if (suggested.length) list.append(h('div', { class: 'fx-apps-head caption' }, t('openWith.suggested')), ...suggested.map(mkRow));
  if (others.length) list.append(h('div', { class: 'fx-apps-head caption' }, t('openWith.others')), ...others.map(mkRow));
  list.addEventListener('keydown', (e) => {
    const i = rows.findIndex((r) => r.dataset.id === selected);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (n) {
        pick(n.dataset.id);
        n.scrollIntoView({ block: 'nearest' });
      }
    }
  });
  let doneRef = null;
  const body = h('div', { class: 'fx-openwith' },
    h('div', { class: 'fx-openwith-file' }, h('img', { src: T.iconFor(entry), alt: '' }), h('span', { class: 'ellipsis' }, entry.name)),
    list);
  const v = await ex.ui.dialog({
    title: ext ? t('openWith.title', { ext }) : t('openWith.titleNoExt'),
    body,
    parent: parentWin,
    className: 'app-files fx-openwith-dlg',
    buttons: [
      { label: t('openWith.always'), value: 'always', primary: false },
      { label: t('openWith.once'), value: 'once', primary: true },
    ],
    onOpen: (dlg, done) => {
      doneRef = done;
      setTimeout(() => {
        list.tabIndex = 0;
        list.focus();
        rows.find((r) => r.dataset.id === selected)?.scrollIntoView({ block: 'nearest' });
      }, 40);
    },
  });
  if (!v || !selected) return null;
  if (v === 'always' && ext) {
    const cur = { ...(ex.ctx.settings.get('defaultApps') || {}) };
    cur[ext] = selected;
    await ex.ctx.settings.set('defaultApps', cur);
  }
  ex.openWith(entry, selected);
  return selected;
}

// ---------------------------------------------------------------- Folder Options
export async function optionsDialog(ex) {
  const { h, t, ui } = ex;
  const p = { ...shared.prefs };
  const cb = (key, label, invert = false) =>
    h('label', { class: 'checkbox' },
      h('input', { type: 'checkbox', checked: invert ? !p[key] : !!p[key], onchange: (e) => (p[key] = invert ? !e.target.checked : e.target.checked) }),
      h('span', null, label));
  const radio = (name, key, value, label) =>
    h('label', { class: 'radio' },
      h('input', { type: 'radio', name, checked: p[key] === value, onchange: () => (p[key] = value) }),
      h('span', null, label));
  const startSel = ui.select({
    options: [
      { value: 'home', label: t('places.home') },
      { value: 'thispc', label: t('places.thisPc') },
    ],
    value: p.startAt,
    onchange: (v) => (p.startAt = v),
  });
  const general = h('div', { class: 'fx-opts-page' },
    h('div', { class: 'fx-opts-row' }, h('span', null, t('options.openTo')), startSel),
    h('div', { class: 'fx-opts-group' }, h('div', { class: 'body-strong' }, t('options.click')),
      radio('fxclick', 'singleClick', true, t('options.singleClick')),
      radio('fxclick', 'singleClick', false, t('options.doubleClick'))),
    h('div', { class: 'fx-opts-group' }, h('div', { class: 'body-strong' }, t('options.privacy')),
      cb('showRecent', t('options.showRecent')),
      cb('showFavorites', t('options.showFavorites')),
      h('div', { class: 'fx-opts-row' }, h('span', { class: 'text-2' }, t('options.clearHistoryLabel')),
        h('button', { class: 'btn', onclick: (e) => {
          clearHistory();
          e.currentTarget.disabled = true;
        } }, t('options.clear')))));
  const view = h('div', { class: 'fx-opts-page', hidden: true },
    cb('hidden', t('options.showHidden')),
    cb('extensions', t('options.hideExtensions'), true),
    cb('fullPathTitle', t('options.fullPath')),
    cb('checkboxes', t('options.checkboxes')),
    cb('compact', t('options.compact')),
    cb('foldersFirst', t('options.foldersFirst')),
    cb('confirmTrash', t('options.confirmTrash')),
    h('div', { class: 'fx-opts-row' }, h('span', { class: 'text-2' }, t('options.resetFoldersLabel')),
      h('button', { class: 'btn', onclick: (e) => {
        resetViews();
        e.currentTarget.disabled = true;
      } }, t('options.resetFolders'))),
    h('div', { class: 'fx-opts-row' }, h('span', { class: 'text-2' }, t('options.restoreDefaultsLabel')),
      h('button', { class: 'btn', onclick: () => {
        for (const k of ['hidden', 'extensions', 'fullPathTitle', 'checkboxes', 'compact', 'foldersFirst', 'confirmTrash']) p[k] = PREF_DEFAULTS[k];
        view.querySelectorAll('input[type=checkbox]').forEach((i, idx) => {
          const keys = ['hidden', 'extensions', 'fullPathTitle', 'checkboxes', 'compact', 'foldersFirst', 'confirmTrash'];
          const k = keys[idx];
          i.checked = k === 'extensions' ? !p[k] : !!p[k];
        });
      } }, t('options.restoreDefaults'))));
  const tabs = h('div', { class: 'tabs fx-opts-tabs' });
  const pages = [general, view];
  [t('options.general'), t('options.view')].forEach((label, i) => {
    tabs.append(h('button', { class: ['tab', i === 0 && 'selected'], onclick: (e) => {
      tabs.querySelectorAll('.tab').forEach((x) => x.classList.remove('selected'));
      e.currentTarget.classList.add('selected');
      pages.forEach((pg, j) => (pg.hidden = j !== i));
    } }, label));
  });
  const applyAll = () => {
    for (const [k, v] of Object.entries(p)) if (shared.prefs[k] !== v) setPref(k, v);
  };
  const v = await ui.dialog({
    title: t('options.title'),
    body: h('div', { class: 'fx-opts' }, tabs, general, view),
    parent: ex.win,
    className: 'app-files fx-opts-dlg',
    width: 520,
    buttons: [
      { label: t('common.ok'), value: 'ok', primary: true },
      { label: t('common.cancel'), value: null },
      { label: t('common.apply'), value: 'apply' },
    ],
    onOpen: (dlg) => {
      dlg._validate = (val) => {
        if (val === 'apply') {
          applyAll();
          return false;
        }
        return true;
      };
    },
  });
  if (v === 'ok') applyAll();
}

// ---------------------------------------------------------------- Extract all
export async function extractDialog(ex, entry) {
  const { h, t, ui } = ex;
  const dir = T.dirname(entry.path);
  const stem = entry.name.replace(/\.(tar\.gz|tar\.xz|tar\.bz2|tar\.zst|tgz|txz|tbz2?|tzst|tar|zip)$/i, '');
  const def = T.joinPath(dir, stem);
  const input = h('input', { class: 'input grow', value: def, spellcheck: false, 'aria-label': t('archive.destination') });
  const show = h('input', { type: 'checkbox', checked: true });
  const browse = h('button', { class: 'btn', onclick: async () => {
    const p = await ui.filePicker({ mode: 'folder', path: dir, parent: ex.win });
    if (p) input.value = T.joinPath(p, stem);
  } }, t('archive.browse'));
  const body = h('div', { class: 'fx-extract' },
    h('div', { class: 'body-strong' }, t('archive.selectDest')),
    h('div', { class: 'caption text-2' }, t('archive.extractTo')),
    h('div', { class: 'row' }, input, browse),
    h('label', { class: 'checkbox' }, show, h('span', null, t('archive.showWhenDone'))));
  const v = await ui.dialog({
    title: t('archive.extractTitle'),
    body,
    parent: ex.win,
    width: 520,
    buttons: [
      { label: t('archive.extract'), value: 'go', primary: true },
      { label: t('common.cancel'), value: null },
    ],
  });
  if (v !== 'go') return null;
  const target = input.value.trim();
  if (!target) return null;
  if (target === def) return ops.extract(ex, entry, { open: show.checked });
  return ops.extract(ex, entry, { dest: target.startsWith('/') ? target : T.joinPath(dir, target), exact: true, open: show.checked });
}
