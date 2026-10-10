// Start menu: search box, pinned grid, all-apps list, recommended files, user + power.
import { h, icon, ui, clear } from './ui.js';
import { registry } from './registry.js';
import { settings } from './settings.js';
import { i18n, t } from './i18n.js';
import { shell } from './services.js';
import { api, env } from './api.js';

let root;
let open = false;
let view = 'pinned';
let searchInput;
let recent = [];

function close() {
  if (!open) return;
  open = false;
  root.classList.remove('open');
  document.querySelector('.tb-start')?.classList.remove('active');
}

function show() {
  open = true;
  view = 'pinned';
  render();
  root.classList.add('open');
  document.querySelector('.tb-start')?.classList.add('active');
  setTimeout(() => searchInput?.focus(), 50);
  loadRecent();
}

async function loadRecent() {
  try {
    const xdg = await api.invoke('fs:xdg');
    const lists = await Promise.all([xdg.documents, xdg.desktop, xdg.pictures, xdg.downloads].map((d) => api.invoke('fs:list', d).catch(() => [])));
    recent = lists
      .flat()
      .filter((e) => !e.dir)
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 6);
    if (open && view === 'pinned') renderRecommended();
  } catch {}
}

function launch(id, args) {
  close();
  registry.launch(id, args);
}

function appTile(m) {
  return h(
    'button',
    {
      class: 'start-tile',
      onclick: () => launch(m.id),
      oncontextmenu: (e) =>
        ui.menu(e, [
          { label: t('start.open'), icon: 'open', action: () => launch(m.id) },
          {
            label: t('start.unpinStart'),
            icon: 'pin_off',
            action: () => settings.set('startPinned', (settings.get('startPinned') || []).filter((x) => x !== m.id)),
          },
          {
            label: (settings.get('pinned') || []).includes(m.id) ? t('taskbar.unpin') : t('taskbar.pin'),
            icon: 'pin',
            action: () => {
              const p = (settings.get('pinned') || []).filter((x) => x !== m.id);
              if (!(settings.get('pinned') || []).includes(m.id)) p.push(m.id);
              settings.set('pinned', p);
            },
          },
        ]),
    },
    h('img', { src: registry.iconUrl(m.id), alt: '', draggable: false }),
    h('span', { class: 'ellipsis' }, i18n.name(m.name)),
  );
}

let recBox;
function renderRecommended() {
  if (!recBox) return;
  clear(recBox);
  if (!recent.length) {
    recBox.appendChild(h('div', { class: 'caption text-2 start-rec-empty' }, t('start.noRecent')));
    return;
  }
  for (const e of recent) {
    recBox.appendChild(
      h(
        'button',
        { class: 'start-rec', onclick: () => (close(), shell.openFile(e.path)) },
        icon(ui.fileIcon(e), { size: 28 }),
        h('div', { class: 'grow' }, h('div', { class: 'ellipsis' }, e.name), h('div', { class: 'caption text-2' }, i18n.relativeTime(e.mtime))),
      ),
    );
  }
}

function renderBody(body) {
  clear(body);
  const q = searchInput.value.trim().toLowerCase();
  if (q) {
    const res = registry.list().filter((m) => {
      const kw = [i18n.name(m.name), m.id, ...(m.keywords?.[i18n.lang] || []), ...(m.keywords?.en || [])].join(' ').toLowerCase();
      return kw.includes(q);
    });
    body.appendChild(h('div', { class: 'start-section-title' }, t('start.bestMatch')));
    const list = h('div', { class: 'start-list' });
    for (const m of res) {
      list.appendChild(
        h('button', { class: 'start-row', onclick: () => launch(m.id) }, h('img', { src: registry.iconUrl(m.id), alt: '' }), h('span', null, i18n.name(m.name)), h('span', { class: 'caption text-2' }, t('start.app'))),
      );
    }
    list.appendChild(
      h(
        'button',
        { class: 'start-row', onclick: () => launch('browser', { url: `https://duckduckgo.com/?q=${encodeURIComponent(searchInput.value)}` }) },
        icon('globe_search', { size: 24 }),
        h('span', null, t('start.searchWeb', { q: searchInput.value })),
      ),
    );
    body.appendChild(list);
    return;
  }
  if (view === 'all') {
    body.appendChild(
      h(
        'div',
        { class: 'start-section-head' },
        h('span', { class: 'body-strong' }, t('start.allApps')),
        h('button', { class: 'btn small', onclick: () => ((view = 'pinned'), renderBody(body)) }, icon('chevron_left', { size: 12 }), t('start.back')),
      ),
    );
    const list = h('div', { class: 'start-list start-all' });
    let letter = '';
    for (const m of registry.list()) {
      const L = i18n.name(m.name)[0].toUpperCase();
      if (L !== letter) {
        letter = L;
        list.appendChild(h('div', { class: 'start-letter' }, L));
      }
      list.appendChild(h('button', { class: 'start-row', onclick: () => launch(m.id) }, h('img', { src: registry.iconUrl(m.id), alt: '' }), h('span', null, i18n.name(m.name))));
    }
    body.appendChild(list);
    return;
  }
  body.appendChild(
    h(
      'div',
      { class: 'start-section-head' },
      h('span', { class: 'body-strong' }, t('start.pinned')),
      h('button', { class: 'btn small', onclick: () => ((view = 'all'), renderBody(body)) }, t('start.allApps'), icon('chevron_right', { size: 12 })),
    ),
  );
  const grid = h('div', { class: 'start-grid' });
  for (const id of settings.get('startPinned') || []) {
    const m = registry.get(id);
    if (m) grid.appendChild(appTile(m));
  }
  body.appendChild(grid);
  body.appendChild(h('div', { class: 'start-section-head' }, h('span', { class: 'body-strong' }, t('start.recommended'))));
  recBox = h('div', { class: 'start-recs' });
  body.appendChild(recBox);
  renderRecommended();
}

function render() {
  clear(root);
  const body = h('div', { class: 'start-body' });
  searchInput = h('input', { class: 'input start-search', placeholder: t('start.searchPlaceholder'), oninput: () => renderBody(body) });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') body.querySelector('.start-row')?.click();
    if (e.key === 'Escape') close();
  });
  const user = h(
    'div',
    { class: 'start-footer' },
    h(
      'button',
      {
        class: 'start-user',
        onclick: (e) =>
          ui.menu(e, [
            { label: t('start.accountSettings'), icon: 'person', action: () => launch('settings', { page: 'accounts' }) },
            { label: t('power.lock'), icon: 'lock_closed', action: () => (close(), shell.lock()) },
            { label: t('power.signOut'), icon: 'sign_out', action: () => (close(), shell.logout()) },
          ]),
      },
      h('span', { class: 'avatar' }, icon('person', { size: 18, filled: true })),
      h('span', null, env.user),
    ),
    h(
      'button',
      {
        class: 'btn subtle icon-btn start-power',
        'data-tip': t('power.power'),
        onclick: (e) =>
          ui.menu(
            e,
            [
              { label: t('power.lock'), icon: 'lock_closed', action: () => (close(), shell.lock()) },
              { label: t('power.sleep'), icon: 'weather_moon', action: () => (close(), shell.suspend()) },
              { label: t('power.shutdown'), icon: 'power', action: () => (close(), shell.shutdown()) },
              { label: t('power.restart'), icon: 'arrow_clockwise', action: () => (close(), shell.reboot()) },
            ],
            { above: true },
          ),
      },
      icon('power', { size: 18 }),
    ),
  );
  root.append(h('div', { class: 'start-top' }, h('div', { class: 'search-box' }, searchInput, icon('search'))), body, user);
  renderBody(body);
}

export const start = {
  mount(el) {
    root = el;
    shell.on('start:toggle', () => (open ? close() : show()));
    shell.on('start:close', close);
    document.addEventListener('pointerdown', (e) => {
      if (open && !root.contains(e.target) && !e.target.closest('.tb-start') && !e.target.closest('.menu')) close();
    });
    i18n.on('change', () => open && render());
  },
  close,
  get isOpen() {
    return open;
  },
};
