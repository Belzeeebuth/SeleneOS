// Settings > Personalization > Taskbar, Start (docs/PERSONALIZATION.md §10). Every control applies live.
//   taskbar  preview; items (search, task view, widgets); pinned apps; mini widgets; position, size, alignment,
//            app names, combine buttons, auto-hide; colour + transparency (shared with the Theme designer)
//   start    preview; layout; pinned apps; app folders; folders next to the power button; recommended files;
//            background style
// Keys: taskbar.{search, showSearch, showTaskView, showWidgets, position, size, align, showLabels, combine, autohide,
// widgets, color, opacity}, pinned; start.{layout, background, folders, groups}, startPinned, startShowRecent.
import { taskbarColorControls } from './personalization-designer.js';
import { setupShellPages, boundCombo, boundSeg, boundToggle, appIcon, orderedList, moved } from './personalization-shell-kit.js';
import { PAGES } from '../lib/index.js';
import { recent } from '../../../core/start.js';

const MINI = ['weather', 'cpu', 'memory', 'network'];
const MINI_ICON = { weather: 'weather_partly_cloudy_day', cpu: 'developer_board', memory: 'ram', network: 'arrow_swap' };
const FOLDERS = ['documents', 'downloads', 'music', 'pictures', 'videos', 'files', 'settings', 'home', 'network'];
const FOLDER_ICON = { documents: 'document', downloads: 'arrow_download', music: 'music_note_2', pictures: 'image', videos: 'video', files: 'folder', settings: 'settings', home: 'person', network: 'globe' };

// ------------------------------------------------------------------ pinned apps editor (taskbar `pinned` / Start `startPinned`)
function pinnedEditor(pc, { key, section, addLabel, empty, exclude = () => new Set() }) {
  const { h, t, settings, ui, kit } = pc;
  const reg = pc.shell.registry;
  const box = h('div', { class: 'pzs-pinned' });
  const ids = () => (settings.get(key) || []).filter((id) => reg.get(id) && !exclude().has(id));
  const paint = () => {
    const list = ids();
    const add = kit.button(addLabel, (e) => {
      const free = reg.list().filter((m) => !list.includes(m.id) && !exclude().has(m.id));
      if (!free.length) return;
      ui.menu(
        e.currentTarget,
        free.map((m) => ({ label: reg.name(m.id), action: () => settings.set(key, [...(settings.get(key) || []).filter((x) => x !== m.id), m.id]) })),
        { class: 'pzs-app-menu' },
      );
    }, { icon: 'add', className: 'pzs-pin-add' });
    box.replaceChildren(
      orderedList(pc, {
        items: list.map((id) => ({ id, label: reg.name(id), icon: appIcon(pc, id, 20) })),
        empty,
        removeLabel: t('pzs.unpin'),
        onMove: (id, d) => {
          const all = settings.get(key) || [];
          const order = moved(list, id, d);
          return settings.set(key, [...order, ...all.filter((x) => !order.includes(x))]);
        },
        onRemove: (id) => settings.set(key, (settings.get(key) || []).filter((x) => x !== id)),
      }),
      h('div', { class: 'pzs-row-actions' }, add),
    );
  };
  paint();
  pc.onDispose(settings.on(key, paint));
  return kit.expander({ icon: 'pin', title: t('pzs.pinnedApps'), desc: t(key === 'pinned' ? 'pzs.pinnedTbDesc' : 'pzs.pinnedStartDesc'), section, open: true, body: () => box });
}

// ------------------------------------------------------------------ live preview: a mini screen with the taskbar on its edge
function taskbarPreview(pc) {
  const { h, settings } = pc;
  const bar = h('div', { class: 'pzs-tb' });
  const scr = h('div', { class: 'pzs-screen st-preview', 'aria-hidden': 'true' }, h('div', { class: 'pzs-win' }), bar);
  const paint = () => {
    const tb = settings.get('taskbar') || {};
    const all = settings.all();
    scr.dataset.pos = ['top', 'left', 'right'].includes(tb.position) ? tb.position : 'bottom';
    scr.dataset.size = ['small', 'large'].includes(tb.size) ? tb.size : 'medium';
    scr.dataset.align = tb.align === 'left' ? 'left' : 'center';
    scr.dataset.labels = tb.showLabels ? 'on' : 'off';
    scr.dataset.mode = all.theme === 'dark' ? 'dark' : 'light';
    scr.style.setProperty('--pv-accent', all.accent || '#0078d4');
    scr.style.backgroundImage = `url("${pc.shell.theme?.wallpaperUrl || ''}")`;
    const apps = (settings.get('pinned') || []).filter((id) => pc.shell.registry.get(id)).slice(0, 5);
    bar.replaceChildren(
      h('span', { class: 'pzs-tb-start' }),
      ...apps.map((id, i) => h('span', { class: ['pzs-tb-app', i === 1 && 'running'] }, appIcon(pc, id, 12), tb.showLabels && i === 1 ? h('i', { class: 'pzs-tb-label' }) : null)),
      h('span', { class: 'pzs-tb-tray' }, ...(tb.widgets || []).slice(0, 3).map(() => h('i', { class: 'pzs-tb-mini' })), h('i', { class: 'pzs-tb-clock' })),
    );
  };
  paint();
  pc.onDispose(settings.on('*', paint));
  return h('div', { class: 'st-pers-hero pzs-hero' }, scr, h('div', { class: 'pzs-hero-side' }, h('div', { class: 'caption text-2' }, pc.t('pzs.preview')), h('div', { class: 'body-strong pzs-hero-status' })));
}

async function taskbar(pc) {
  setupShellPages(pc);
  const { h, t, kit, settings, ui } = pc;
  const hero = taskbarPreview(pc);
  const status = hero.querySelector('.pzs-hero-status');
  const paintStatus = () => {
    const tb = settings.get('taskbar') || {};
    status.textContent = t('pzs.tbStatus', { pos: t(`pzs.pos_${['top', 'left', 'right'].includes(tb.position) ? tb.position : 'bottom'}`), size: t(`pzs.size_${['small', 'large'].includes(tb.size) ? tb.size : 'medium'}`) });
  };
  paintStatus();
  pc.onDispose(settings.on('taskbar', paintStatus));

  // search: hidden / icon / box (taskbar.search; falls back to showSearch)
  const searchMode = () => {
    const tb = settings.get('taskbar') || {};
    return ['hidden', 'icon', 'box'].includes(tb.search) ? tb.search : tb.showSearch === false ? 'hidden' : 'icon';
  };
  const search = kit.combo({
    label: t('pers.tbSearch'),
    value: searchMode(),
    options: [
      { value: 'hidden', label: t('pzs.searchHidden') },
      { value: 'icon', label: t('pzs.searchIcon') },
      { value: 'box', label: t('pzs.searchBox') },
    ],
    onChange: (v) => pc.api.invoke('settings:setMany', { 'taskbar.search': v, 'taskbar.showSearch': v !== 'hidden' }),
  });
  search.dataset.key = 'taskbar.search';
  pc.onDispose(settings.on('taskbar', () => search.setValue(searchMode())));

  const vertical = () => ['left', 'right'].includes(settings.get('taskbar.position'));
  const alignRow = kit.row({
    icon: 'align_center_horizontal',
    title: t('pers.alignment'),
    desc: t('pers.alignmentDesc'),
    section: 'align',
    control: boundCombo(pc, { key: 'taskbar.align', def: 'center', label: t('pers.alignment'), options: [{ value: 'left', label: t('pers.alignLeft') }, { value: 'center', label: t('pers.alignCenter') }] }),
  });
  const labelsRow = kit.row({ icon: 'text_case_title', title: t('pzs.labels'), desc: t('pzs.labelsDesc'), section: 'labels', control: boundToggle(pc, 'taskbar.showLabels', false, t('pzs.labels')) });
  const paintVertical = () => {
    const v = vertical();
    for (const r of [alignRow, labelsRow]) {
      r.classList.toggle('disabled', v);
      for (const c of r.querySelectorAll('button, input')) c.disabled = v;
    }
    alignRow.querySelector('.st-row-desc').textContent = v ? t('pzs.alignVertical') : t('pers.alignmentDesc');
    labelsRow.querySelector('.st-row-desc').textContent = v ? t('pzs.labelsVertical') : t('pzs.labelsDesc');
  };
  paintVertical();
  pc.onDispose(settings.on('taskbar', paintVertical));

  const widgetRows = MINI.map((id) => {
    const tg = kit.toggle({
      value: (settings.get('taskbar.widgets') || []).includes(id),
      label: t(`pzs.mini_${id}`),
      onChange: (v) => {
        const cur = (settings.get('taskbar.widgets') || []).filter((x) => MINI.includes(x) && x !== id);
        const next = v ? MINI.filter((x) => x === id || cur.includes(x)) : cur;
        return settings.set('taskbar.widgets', next).then(() => true);
      },
    });
    tg.dataset.key = `taskbar.widgets.${id}`;
    pc.onDispose(settings.on('taskbar', () => tg.set((settings.get('taskbar.widgets') || []).includes(id))));
    return kit.subRow({ icon: MINI_ICON[id], title: t(`pzs.mini_${id}`), desc: t(`pzs.mini_${id}Desc`), control: tg });
  });

  const tbc = taskbarColorControls(pc);
  return h(
    'div',
    { class: 'pzs-page' },
    hero,
    kit.group(
      t('pers.taskbarItems'),
      kit.row({ icon: 'search', title: t('pers.tbSearch'), desc: t('pzs.searchDesc'), section: 'items', control: search }),
      kit.settingToggleRow({ icon: 'window_multiple', title: t('pers.tbTaskView'), key: 'taskbar.showTaskView', def: true, section: 'taskView' }),
      kit.settingToggleRow({ icon: 'board', title: t('pers.tbWidgets'), key: 'taskbar.showWidgets', def: false, section: 'widgetsButton' }),
      pinnedEditor(pc, { key: 'pinned', section: 'pinned', addLabel: t('pzs.pinApp'), empty: t('pzs.noPinnedTb') }),
    ),
    kit.group(t('pzs.miniWidgets'), kit.expander({ icon: 'data_usage', title: t('pzs.miniWidgets'), desc: t('pzs.miniWidgetsDesc'), section: 'widgets', open: true, body: () => h('div', null, widgetRows) })),
    kit.group(
      t('pers.taskbarBehaviors'),
      kit.row({
        icon: 'panel_bottom',
        title: t('pzs.position'),
        desc: t('pzs.positionDesc'),
        section: 'position',
        control: boundCombo(pc, {
          key: 'taskbar.position',
          def: 'bottom',
          label: t('pzs.position'),
          options: ['bottom', 'top', 'left', 'right'].map((v) => ({ value: v, label: t(`pzs.pos_${v}`) })),
        }),
      }),
      kit.row({
        icon: 'resize',
        title: t('pzs.size'),
        desc: t('pzs.sizeDesc'),
        section: 'size',
        control: boundSeg(pc, { key: 'taskbar.size', def: 'medium', label: t('pzs.size'), options: ['small', 'medium', 'large'].map((v) => ({ value: v, label: t(`pzs.size_${v}`) })) }),
      }),
      alignRow,
      labelsRow,
      kit.row({
        icon: 'stack',
        title: t('pzs.combine'),
        desc: t('pzs.combineDesc'),
        section: 'combine',
        control: boundCombo(pc, { key: 'taskbar.combine', def: 'always', label: t('pzs.combine'), options: ['always', 'whenFull', 'never'].map((v) => ({ value: v, label: t(`pzs.combine_${v}`) })) }),
      }),
      kit.settingToggleRow({ icon: 'panel_bottom_contract', title: t('pers.autohide'), desc: t('pzs.autohideDesc'), key: 'taskbar.autohide', def: false, section: 'autohide' }),
    ),
    kit.group(t('pzs.appearance'), tbc.colorRow, tbc.opacityRow),
    kit.group(
      null,
      kit.row({
        icon: 'arrow_reset',
        title: t('pers.resetTbPins'),
        desc: t('pers.resetTbPinsDesc'),
        control: kit.button(t('pers.reset'), async () => {
          if (await ui.confirm(t('pers.resetTbConfirm'), { title: t('pers.resetTbPins'), okLabel: t('pers.reset'), parent: pc.win })) {
            await settings.reset('pinned');
            pc.toast(t('pers.resetDone'));
          }
        }),
      }),
    ),
    kit.related([
      { icon: 'apps', title: pc.pageTitle('start'), desc: pc.L(PAGES.start.desc), onClick: () => pc.go('start') },
      { icon: 'target', title: pc.pageTitle('focus'), desc: pc.L(PAGES.focus.desc), onClick: () => pc.go('focus') },
      { icon: 'window_brush', title: pc.pageTitle('themeDesigner'), desc: pc.L(PAGES.themeDesigner.desc), onClick: () => pc.go('themeDesigner') },
    ]),
  );
}

// ------------------------------------------------------------------ Start
function startPreview(pc) {
  const { h, settings } = pc;
  const menu = h('div', { class: 'pzs-sm' });
  const scr = h('div', { class: 'pzs-screen st-preview pzs-start-pv', 'aria-hidden': 'true' }, menu, h('div', { class: 'pzs-tb' }, h('span', { class: 'pzs-tb-start' })));
  const paint = () => {
    const st = settings.get('start') || {};
    const all = settings.all();
    const layout = ['morePins', 'moreRecommended', 'list'].includes(st.layout) ? st.layout : 'default';
    const recOn = settings.get('startShowRecent') !== false && layout !== 'list';
    scr.dataset.mode = all.theme === 'dark' ? 'dark' : 'light';
    scr.dataset.bg = ['solid', 'accent', 'wallpaper'].includes(st.background) ? st.background : 'acrylic';
    scr.style.setProperty('--pv-accent', all.accent || '#0078d4');
    scr.style.backgroundImage = `url("${pc.shell.theme?.wallpaperUrl || ''}")`;
    const rows = layout === 'list' ? 1 : !recOn ? 5 : { default: 3, morePins: 4, moreRecommended: 2 }[layout];
    const recs = recOn ? { default: 3, morePins: 1, moreRecommended: 4 }[layout] : 0;
    const groups = (st.groups || []).length;
    menu.replaceChildren(
      ...[
      h('i', { class: 'pzs-sm-search' }),
      h('div', { class: 'pzs-sm-grid' }, Array.from({ length: rows * 6 }, (_, i) => h('i', { class: i < groups ? 'grp' : '' }))),
      layout === 'list' ? h('div', { class: 'pzs-sm-list' }, Array.from({ length: 6 }, () => h('i'))) : null,
      recs ? h('div', { class: 'pzs-sm-recs' }, Array.from({ length: recs * 2 }, () => h('i'))) : null,
      h('div', { class: 'pzs-sm-foot' }, h('i', { class: 'av' }), h('span', { class: 'grow' }), ...(st.folders || []).slice(0, 6).map(() => h('i', { class: 'fd' })), h('i', { class: 'pw' })),
      ].filter(Boolean),
    );
  };
  paint();
  pc.onDispose(settings.on('*', paint));
  const open = pc.kit.button(pc.t('pers.openStart'), () => pc.shell.emit('start:toggle'), { icon: 'apps' });
  return h('div', { class: 'st-pers-hero pzs-hero' }, scr, h('div', { class: 'pzs-hero-side' }, h('div', { class: 'caption text-2' }, pc.t('pzs.preview')), open));
}

function groupsEditor(pc) {
  const { h, t, settings, ui, kit: k } = pc;
  const reg = pc.shell.registry;
  const box = h('div', { class: 'pzs-groups' });
  const groups = () => (Array.isArray(settings.get('start.groups')) ? settings.get('start.groups') : []);
  const save = (list) => settings.set('start.groups', list);
  async function editGroup(g) {
    const name = h('input', { class: 'input', value: g?.name || t('pzs.folderDefault'), maxLength: 60, 'aria-label': t('pzs.folderName') });
    const chosen = new Set(g?.apps || []);
    const list = h(
      'div',
      { class: 'pzs-check-list' },
      reg.list().map((m) =>
        h(
          'label',
          { class: 'pzs-check' },
          h('input', { type: 'checkbox', checked: chosen.has(m.id), onchange: (e) => (e.target.checked ? chosen.add(m.id) : chosen.delete(m.id)) }),
          appIcon(pc, m.id, 20),
          h('span', null, reg.name(m.id)),
        ),
      ),
    );
    const body = h('div', { class: 'pzs-group-dialog' }, h('label', { class: 'field' }, h('span', { class: 'caption text-2' }, t('pzs.folderName')), name), h('div', { class: 'caption text-2' }, t('pzs.folderApps')), list);
    const r = await ui.dialog({ title: g ? t('pzs.editFolder') : t('pzs.newFolder'), body, parent: pc.win, buttons: [{ label: t('common.save'), value: 'ok', primary: true }, { label: t('common.cancel'), value: null }] });
    if (r !== 'ok') return;
    const apps = [...chosen].filter((id) => reg.get(id));
    if (!apps.length) return pc.toast(t('pzs.folderNeedsApps'));
    const entry = { id: g?.id || `g-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, name: name.value.replace(/[\u0000-\u001f<>]/g, ' ').trim().slice(0, 60) || t('pzs.folderDefault'), apps };
    // an app lives in one folder at a time
    const others = groups().filter((x) => x.id !== entry.id).map((x) => ({ ...x, apps: x.apps.filter((a) => !apps.includes(a)) })).filter((x) => x.apps.length);
    await save(g ? groups().map((x) => (x.id === entry.id ? entry : others.find((o) => o.id === x.id))).filter(Boolean) : [entry, ...others]);
  }
  const paint = () => {
    const list = groups();
    box.replaceChildren(
      list.length
        ? h(
            'div',
            { class: 'pzs-list', role: 'list' },
            list.map((g) =>
              h(
                'div',
                { class: 'pzs-list-row', role: 'listitem', dataset: { id: g.id } },
                h('span', { class: 'pzs-group-icons' }, g.apps.slice(0, 4).map((id) => appIcon(pc, id, 12))),
                h('span', { class: 'pzs-list-label' }, h('span', { class: 'ellipsis' }, g.name), h('span', { class: 'caption text-2' }, ` · ${t('pzs.appCount', { count: g.apps.length })}`)),
                h(
                  'span',
                  { class: 'pzs-list-btns' },
                  h('button', { class: 'btn subtle icon-btn', type: 'button', 'aria-label': `${t('pzs.editFolder')} — ${g.name}`, 'data-tip': t('pzs.editFolder'), onclick: () => editGroup(g) }, pc.icon('edit', { size: 14 })),
                  h('button', { class: 'btn subtle icon-btn pzs-remove', type: 'button', 'aria-label': `${t('pzs.deleteFolder')} — ${g.name}`, 'data-tip': t('pzs.deleteFolder'), onclick: () => save(groups().filter((x) => x.id !== g.id)) }, pc.icon('delete', { size: 14 })),
                ),
              ),
            ),
          )
        : h('div', { class: 'pzs-list-empty caption text-2' }, t('pzs.noFolders')),
      h('div', { class: 'pzs-row-actions' }, k.button(t('pzs.newFolder'), () => editGroup(null), { icon: 'folder_add', className: 'pzs-new-folder' })),
    );
  };
  paint();
  pc.onDispose(settings.on('start', paint));
  return k.expander({ icon: 'folder', title: t('pzs.appFolders'), desc: t('pzs.appFoldersDesc'), section: 'groups', open: true, body: () => box });
}

async function start(pc) {
  setupShellPages(pc);
  const { h, t, kit: k, settings, ui } = pc;
  const folderRows = FOLDERS.map((id) => {
    const tg = k.toggle({
      value: (settings.get('start.folders') || []).includes(id),
      label: t(`pzs.folder_${id}`),
      onChange: (v) => {
        const cur = (settings.get('start.folders') || []).filter((x) => FOLDERS.includes(x) && x !== id);
        const next = v ? FOLDERS.filter((x) => x === id || cur.includes(x)) : cur;
        return settings.set('start.folders', next).then(() => true);
      },
    });
    tg.dataset.key = `start.folders.${id}`;
    pc.onDispose(settings.on('start', () => tg.set((settings.get('start.folders') || []).includes(id))));
    return k.subRow({ icon: FOLDER_ICON[id], title: t(`pzs.folder_${id}`), control: tg });
  });
  const inGroups = () => new Set((settings.get('start.groups') || []).flatMap((g) => g.apps || []));
  return h(
    'div',
    { class: 'pzs-page' },
    startPreview(pc),
    k.group(
      t('pzs.layout'),
      k.row({
        icon: 'layout_row_two',
        title: t('pzs.layout'),
        desc: t('pzs.layoutDesc'),
        section: 'layout',
        control: boundCombo(pc, { key: 'start.layout', def: 'default', label: t('pzs.layout'), options: ['default', 'morePins', 'moreRecommended', 'list'].map((v) => ({ value: v, label: t(`pzs.layout_${v}`) })) }),
      }),
      k.row({
        icon: 'paint_brush',
        title: t('pzs.startBg'),
        desc: t('pzs.startBgDesc'),
        section: 'background',
        control: boundCombo(pc, { key: 'start.background', def: 'acrylic', label: t('pzs.startBg'), options: ['acrylic', 'solid', 'accent', 'wallpaper'].map((v) => ({ value: v, label: t(`pzs.bg_${v}`) })) }),
      }),
    ),
    k.group(t('pzs.pinnedApps'), pinnedEditor(pc, { key: 'startPinned', section: 'pinned', addLabel: t('pzs.pinApp'), empty: t('pzs.noPinnedStart'), exclude: inGroups }), groupsEditor(pc)),
    k.group(
      t('pzs.recommended'),
      k.settingToggleRow({ icon: 'history', title: t('pers.startRecent'), desc: t('pers.startRecentDesc'), key: 'startShowRecent', def: true, section: 'recent' }),
      k.row({
        icon: 'delete',
        title: t('pzs.clearRecent'),
        desc: t('pzs.clearRecentDesc'),
        section: 'clearRecent',
        control: k.button(t('pzs.clear'), async () => {
          await recent.clearFiles();
          pc.toast(t('pzs.clearedRecent'));
        }),
      }),
    ),
    k.group(t('pzs.folders'), k.expander({ icon: 'folder', title: t('pzs.folders'), desc: t('pzs.foldersDesc'), section: 'folders', open: true, body: () => h('div', null, folderRows) })),
    k.group(
      null,
      k.row({
        icon: 'arrow_reset',
        title: t('pers.resetStartPins'),
        desc: t('pers.resetStartPinsDesc'),
        control: k.button(t('pers.reset'), async () => {
          if (await ui.confirm(t('pers.resetStartConfirm'), { title: t('pers.resetStartPins'), okLabel: t('pers.reset'), parent: pc.win })) {
            await settings.reset('startPinned');
            pc.toast(t('pers.resetDone'));
          }
        }),
      }),
    ),
    k.related([
      { icon: 'panel_bottom', title: pc.pageTitle('taskbar'), desc: pc.L(PAGES.taskbar.desc), onClick: () => pc.go('taskbar') },
      { icon: 'window_brush', title: pc.pageTitle('themeDesigner'), desc: pc.L(PAGES.themeDesigner.desc), onClick: () => pc.go('themeDesigner') },
    ]),
  );
}

export default { start, taskbar };
