// Aurora Browser — internal pages (aurora://…), drawn by the app with the shell UI kit:
// New tab, History, Favorites, Downloads, Settings, About, and the "can't open this address" page.
// renderPage(bw, tab, entry) -> { el, destroy(), update(key) }
import { h, icon, ui, clear } from './dom.js';
import { shared } from './shared.js';
import { SEED_SITES } from './store.js';
import { ENGINES, engineOf, displayUrl, bareHost, hostOf, siteLabel, colorFor, monogram, classify, isWebUrl, uid } from './util.js';
import * as panels from './panels.js';
import { barMode } from './favbar.js';

const APP_ICON = 'app://shell/apps/browser/icon.svg';

export function pageTitle(bw, e) {
  const t = bw.t;
  switch (e.route) {
    case 'newtab':
      return t('tab.newTitle');
    case 'history':
      return t('history.title');
    case 'favorites':
      return t('fav.title');
    case 'downloads':
      return t('dl.title');
    case 'settings':
      return t('settings.title');
    case 'about':
      return t('about.title');
    default:
      return displayUrl(e.url);
  }
}

export function pageIcon(e) {
  switch (e.route) {
    case 'history':
      return { icon: 'history' };
    case 'favorites':
      return { icon: 'star' };
    case 'downloads':
      return { icon: 'arrow_download' };
    case 'settings':
      return { icon: 'settings' };
    case 'blocked':
    case 'notfound':
      return { icon: 'prohibited' };
    default:
      return { img: APP_ICON };
  }
}

export function renderPage(bw, tab, entry) {
  const fn = { newtab: newTabPage, history: historyPage, favorites: favoritesPage, downloads: downloadsPage, settings: settingsPage, about: aboutPage }[entry.route] || blockedPage;
  const page = fn(bw, tab, entry) || {};
  page.el.classList.add('bp-page');
  page.el.tabIndex = -1;
  return page;
}

function favImg(url, size = 16) {
  if (/^aurora:/i.test(url)) return h('img', { src: APP_ICON, alt: '', width: size, height: size, draggable: false });
  const f = shared.store.favicon(url);
  return f ? h('img', { src: f, alt: '', width: size, height: size, draggable: false }) : icon('globe', { size });
}

function searchBox(placeholder, oninput, value = '') {
  const input = h('input', { class: 'input', type: 'search', placeholder, value, 'aria-label': placeholder, spellcheck: false });
  input.addEventListener('input', () => oninput(input.value));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && input.value) {
      e.preventDefault();
      e.stopPropagation();
      input.value = '';
      oninput('');
    }
  });
  return h('div', { class: 'search-box bp-search' }, input, icon('search', { size: 16 }));
}

function header(title, ...right) {
  return h('div', { class: 'bp-head' }, h('h1', { class: 'bp-title' }, title), h('div', { class: 'grow' }), ...right);
}

function empty(ic, title, sub) {
  return h('div', { class: 'bp-empty' }, icon(ic, { size: 48 }), h('div', { class: 'subtitle' }, title), sub ? h('div', { class: 'text-2' }, sub) : null);
}

function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function dayLabel(bw, ms) {
  const t = bw.t;
  const i18n = shared.ctx.i18n;
  const full = i18n.formatDate(ms, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const today = dayKey(Date.now());
  const yest = dayKey(Date.now() - 86400000);
  const k = dayKey(ms);
  if (k === today) return `${t('history.today')} – ${full}`;
  if (k === yest) return `${t('history.yesterday')} – ${full}`;
  return full.charAt(0).toUpperCase() + full.slice(1);
}

// ================================================================== New tab
function newTabPage(bw, tab) {
  const t = bw.t;
  const store = shared.store;
  const el = h('div', { class: ['bp-ntp', store.prefs.ntpBackground && 'with-bg'] });
  const input = h('input', { class: 'bp-ntp-input', type: 'text', spellcheck: false, autocomplete: 'off' });
  const tiles = h('div', { class: 'bp-tiles', role: 'list' });
  const tools = h('div', { class: 'bp-ntp-tools' });
  const go = (e) => {
    const c = classify(input.value, bw.prefs.engine);
    if (!c) return;
    if (e?.altKey) bw.openUrl(c.url, { active: true });
    else bw.navigate(tab, c);
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      go(e);
    }
  });
  const searchBtn = h('button', { class: 'bp-ntp-go', onclick: () => go() }, icon('arrow_right', { size: 18 }));
  const box = h('div', { class: 'bp-ntp-search' }, icon('search', { size: 20, class: 'bp-ntp-sicon' }), input, searchBtn);
  const customize = h('button', { class: 'bp-ntp-tool', onclick: (e) => customizeMenu(e) }, icon('settings', { size: 18 }));
  tools.appendChild(customize);
  const brand = h('div', { class: 'bp-ntp-brand' }, h('img', { src: APP_ICON, alt: '', draggable: false }), h('span', { class: 'bp-ntp-name' }, 'Aurora'));
  if (bw.private) {
    // Private windows: an explainer instead of shortcuts and background (like InPrivate).
    el.classList.remove('with-bg');
    el.classList.add('private');
    const info = h(
      'div',
      { class: 'bp-private-card' },
      h('div', { class: 'bp-private-head' }, icon('window_inprivate', { size: 28 }), h('div', { class: 'subtitle' }, t('ntp.privateTitle'))),
      h('p', null, t('ntp.privateBody1')),
      h('p', null, t('ntp.privateBody2')),
      h('p', { class: 'caption' }, t('ntp.privateBody3')),
    );
    el.append(h('div', { class: 'bp-ntp-center' }, brand, box, info));
    relabel();
    return { el, update: (key) => key === 'engine' && relabel() };
  }
  el.append(tools, h('div', { class: 'bp-ntp-center' }, brand, box, tiles));

  function relabel() {
    const engine = engineOf(bw.prefs.engine).name;
    input.placeholder = t('ntp.placeholder', { engine });
    input.setAttribute('aria-label', t('ntp.placeholder', { engine }));
    searchBtn.setAttribute('aria-label', t('common.search'));
    customize.dataset.tip = t('ntp.customize');
    customize.setAttribute('aria-label', t('ntp.customize'));
  }

  function customizeMenu(e) {
    ui.menu(
      e,
      [
        { label: t('ntp.showShortcuts'), checked: !!store.prefs.ntpShortcuts, action: () => store.setPref('ntpShortcuts', !store.prefs.ntpShortcuts) },
        { label: t('ntp.showBackground'), checked: !!store.prefs.ntpBackground, action: () => store.setPref('ntpBackground', !store.prefs.ntpBackground) },
        '-',
        { label: t('ntp.restoreShortcuts'), icon: 'arrow_reset', disabled: !store.ntp.hidden.length, action: () => ((store.ntp.hidden = []), store.save('ntp', 100), renderTiles()) },
        { label: t('settings.title'), icon: 'settings', action: () => bw.openInternal('settings') },
      ],
      { class: bw.menuClass() },
    );
  }

  function tileList() {
    const custom = store.ntp.shortcuts.map((s) => ({ ...s, custom: true }));
    const have = new Set(custom.map((s) => bareHost(s.url)));
    const out = [...custom];
    let top = store.topSites(10);
    if (!top.length && !store.ntp.hidden.length) top = SEED_SITES.map((s) => ({ ...s, host: bareHost(s.url) }));
    for (const s of top) {
      if (out.length >= 8) break;
      if (have.has(s.host) || store.ntp.hidden.includes(s.host)) continue;
      have.add(s.host);
      out.push({ title: siteLabel(s.title, s.url), url: s.url, host: s.host });
    }
    return out;
  }

  function tileEl(s) {
    const fav = store.favicon(s.url);
    const art = fav ? h('img', { src: fav, alt: '', draggable: false }) : h('span', { class: 'bp-mono', style: { background: colorFor(bareHost(s.url)) } }, monogram(s.title, s.url));
    const more = h('button', {
      class: 'bp-tile-more',
      'aria-label': t('ntp.tileOptions'),
      tabindex: '-1',
      onclick: (e) => {
        e.preventDefault();
        e.stopPropagation();
        tileMenu(e, s);
      },
    }, icon('more_horizontal', { size: 14 }));
    const a = h(
      'a',
      { class: 'bp-tile', href: s.url, role: 'listitem', 'data-tip': displayUrl(s.url), draggable: 'false' },
      h('span', { class: 'bp-tile-art' }, art),
      h('span', { class: 'bp-tile-label' }, s.title || bareHost(s.url)),
      more,
    );
    a.addEventListener('click', (e) => {
      e.preventDefault();
      bw.openFromLink(s.url, e, tab);
    });
    a.addEventListener('auxclick', (e) => {
      if (e.button !== 1) return;
      e.preventDefault();
      bw.openUrl(s.url, { active: false, opener: tab });
    });
    a.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      tileMenu(e, s);
    });
    return a;
  }

  function tileMenu(e, s) {
    ui.menu(
      e,
      [
        { label: t('ctx.openLinkTab'), icon: 'tab_add', action: () => bw.openUrl(s.url, { active: false, opener: tab }) },
        { label: t('ctx.openLinkPrivate'), icon: 'window_inprivate', action: () => shared.shell.launch('browser', { newWindow: true, private: true, url: s.url }) },
        '-',
        { label: t('ntp.editShortcut'), icon: 'edit', action: () => editShortcut(s) },
        { label: t('ntp.removeShortcut'), icon: 'delete', action: () => removeShortcut(s) },
      ],
      { class: bw.menuClass() },
    );
  }

  function removeShortcut(s) {
    if (s.custom) store.ntp.shortcuts = store.ntp.shortcuts.filter((x) => x.id !== s.id);
    else store.ntp.hidden.push(s.host || bareHost(s.url));
    store.save('ntp', 100);
    renderTiles();
  }

  async function editShortcut(s) {
    const name = h('input', { class: 'input', value: s?.title || '' });
    const url = h('input', { class: 'input', value: s?.url || '', placeholder: 'https://', spellcheck: false });
    const err = h('div', { class: 'field-hint bw-field-error' });
    const v = await ui.dialog({
      title: s ? t('ntp.editShortcut') : t('ntp.addShortcut'),
      body: h('div', { class: 'bw-dialog-form' }, h('div', { class: 'field' }, h('label', null, t('fav.name')), name), h('div', { class: 'field' }, h('label', null, t('fav.url')), url), err),
      parent: bw.win,
      width: 420,
      buttons: [
        { label: t('common.save'), value: 'save', primary: true },
        { label: t('common.cancel'), value: null },
      ],
      onOpen: (dlg) => {
        dlg._validate = (val) => {
          if (val !== 'save') return true;
          const c = classify(url.value, bw.prefs.engine);
          if (!c || c.type !== 'url' || !isWebUrl(c.url)) {
            err.textContent = t('fav.urlInvalid');
            return false;
          }
          url.value = c.url;
          return true;
        };
        setTimeout(() => (s ? name : url).focus(), 40);
      },
    });
    if (v !== 'save') return;
    const rec = { id: s?.custom ? s.id : uid('s'), title: name.value.trim() || siteLabel('', url.value), url: url.value };
    if (s?.custom) store.ntp.shortcuts = store.ntp.shortcuts.map((x) => (x.id === s.id ? rec : x));
    else {
      if (s) store.ntp.hidden.push(s.host || bareHost(s.url));
      store.ntp.shortcuts.push(rec);
    }
    store.save('ntp', 100);
    renderTiles();
  }

  function renderTiles() {
    clear(tiles);
    tiles.hidden = !store.prefs.ntpShortcuts;
    if (tiles.hidden) return;
    const list = tileList();
    for (const s of list) tiles.appendChild(tileEl(s));
    if (list.length < 8) {
      tiles.appendChild(
        h(
          'button',
          { class: 'bp-tile add', onclick: () => editShortcut(null), 'aria-label': t('ntp.addShortcut') },
          h('span', { class: 'bp-tile-art' }, icon('add', { size: 20 })),
          h('span', { class: 'bp-tile-label' }, t('ntp.addShortcut')),
        ),
      );
    }
  }

  relabel();
  renderTiles();
  const offs = [store.on('history', () => !tab.view.classList.contains('active') && renderTiles()), store.on('favicons', () => renderTiles())];
  return {
    el,
    destroy: () => offs.forEach((o) => o()),
    update(key) {
      if (key === 'ntpBackground') el.classList.toggle('with-bg', !!store.prefs.ntpBackground);
      if (key === 'ntpShortcuts') renderTiles();
      if (key === 'engine') relabel();
    },
  };
}

// ================================================================== History
function historyPage(bw, tab, entry) {
  const t = bw.t;
  const store = shared.store;
  let query = entry.query?.q || '';
  let limit = 300;
  const list = h('div', { class: 'bp-col' });
  const body = h('div', { class: 'bp-body' }, list);
  const el = h(
    'div',
    { class: 'bp-history' },
    header(
      t('history.title'),
      searchBox(t('history.search'), (v) => {
        query = v;
        limit = 300;
        render();
      }, query),
      h('button', { class: 'btn', onclick: () => panels.clearDataDialog(bw) }, icon('delete', { size: 16 }), t('settings.clearData')),
    ),
    body,
  );

  function render() {
    const scroll = body.scrollTop;
    clear(list);
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    let items = store.historyList();
    if (terms.length) items = items.filter((e) => terms.every((x) => (e.title || '').toLowerCase().includes(x) || e.url.toLowerCase().includes(x)));
    if (!items.length) {
      list.appendChild(query ? empty('search', t('history.noResults'), t('history.noResultsSub')) : empty('history', t('history.empty'), t('history.emptySub')));
      return;
    }
    let group = null;
    let key = null;
    for (const e of items.slice(0, limit)) {
      const k = dayKey(e.last);
      if (k !== key) {
        key = k;
        list.appendChild(h('div', { class: 'bp-day' }, dayLabel(bw, e.last)));
        group = h('div', { class: 'bp-card bp-list' });
        list.appendChild(group);
      }
      group.appendChild(row(e));
    }
    if (items.length > limit)
      list.appendChild(
        h(
          'div',
          { class: 'bp-more' },
          h(
            'button',
            {
              class: 'btn',
              onclick: () => {
                limit += 500;
                render();
              },
            },
            t('history.showMore', { count: items.length - limit }),
          ),
        ),
      );
    body.scrollTop = scroll;
  }

  function row(e) {
    const time = shared.ctx.i18n.formatTime(e.last);
    const del = h(
      'button',
      {
        class: 'bw-tbtn small bp-row-del',
        'aria-label': t('history.remove'),
        'data-tip': t('history.remove'),
        onclick: (ev) => {
          ev.stopPropagation();
          store.removeHistory(e.url);
        },
      },
      icon('dismiss', { size: 14 }),
    );
    const r = h(
      'a',
      { class: 'bp-row', href: e.url, draggable: 'false' },
      h('span', { class: 'bp-row-time caption text-2' }, time),
      h('span', { class: 'bp-row-icon' }, favImg(e.url)),
      h('span', { class: 'bp-row-title ellipsis' }, e.title || displayUrl(e.url)),
      h('span', { class: 'bp-row-host caption text-2 ellipsis' }, bareHost(e.url)),
      del,
    );
    r.addEventListener('click', (ev) => {
      ev.preventDefault();
      bw.openFromLink(e.url, ev, tab);
    });
    r.addEventListener('auxclick', (ev) => {
      if (ev.button !== 1) return;
      ev.preventDefault();
      bw.openUrl(e.url, { active: false, opener: tab });
    });
    r.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      ui.menu(
        ev,
        [
          { label: t('ctx.openLinkTab'), icon: 'tab_add', action: () => bw.openUrl(e.url, { active: false, opener: tab }) },
          { label: t('ctx.openLinkWindow'), icon: 'window_new', action: () => shared.shell.launch('browser', { newWindow: true, url: e.url }) },
          { label: t('ctx.openLinkPrivate'), icon: 'window_inprivate', action: () => shared.shell.launch('browser', { newWindow: true, private: true, url: e.url }) },
          '-',
          { label: t('ctx.copyLink'), icon: 'link', action: () => shared.api.invoke('clipboard:writeText', e.url).catch(() => {}) },
          {
            label: t('history.moreFromSite'),
            icon: 'search',
            action: () => {
              query = bareHost(e.url);
              el.querySelector('.bp-search input').value = query;
              render();
            },
          },
          { label: t('history.remove'), icon: 'delete', action: () => store.removeHistory(e.url) },
        ],
        { class: bw.menuClass() },
      );
    });
    return r;
  }

  render();
  let timer = null;
  const off = store.on('history', () => {
    clearTimeout(timer);
    timer = setTimeout(render, 150);
  });
  return { el, destroy: () => (off(), clearTimeout(timer)) };
}

// ================================================================== Favorites
function favoritesPage(bw, tab, entry) {
  const t = bw.t;
  const store = shared.store;
  let folderId = entry.query?.folder && store.node(entry.query.folder)?.type === 'folder' ? entry.query.folder : 'bar';
  let query = '';
  const tree = h('div', { class: 'bp-tree nav', role: 'tree' });
  const list = h('div', { class: 'bp-card bp-list bp-fav-list' });
  const crumb = h('div', { class: 'bp-crumb subtitle' });
  const el = h(
    'div',
    { class: 'bp-favs' },
    header(
      t('fav.title'),
      searchBox(t('fav.search'), (v) => {
        query = v;
        renderList();
      }),
      h('button', { class: 'btn', onclick: () => panels.addFavoriteDialog(bw, folderId) }, icon('star_add', { size: 16 }), t('fav.addFavorite')),
      h('button', { class: 'btn', onclick: () => panels.newFolderDialog(bw, folderId) }, icon('folder_add', { size: 16 }), t('fav.addFolder')),
    ),
    h('div', { class: 'bp-split' }, h('div', { class: 'bp-tree-wrap' }, tree), h('div', { class: 'bp-body' }, h('div', { class: 'bp-col wide' }, crumb, list))),
  );
  const folderName = (n) => (n.id === 'bar' ? t('fav.bar') : n.id === 'other' ? t('fav.other') : n.title || t('fav.untitledFolder'));

  function renderTree() {
    clear(tree);
    const rec = (n, depth) => {
      const item = h(
        'div',
        {
          class: ['nav-item', 'bp-tree-item', n.id === folderId && !query && 'selected'],
          role: 'treeitem',
          tabindex: '0',
          style: { paddingLeft: `${12 + depth * 16}px` },
          dataset: { id: n.id },
          onclick: () => select(n.id),
          onkeydown: (e) => e.key === 'Enter' && select(n.id),
        },
        icon(n.id === 'bar' ? 'star_line_horizontal_3' : 'folder', { size: 18 }),
        h('span', { class: 'ellipsis' }, folderName(n)),
      );
      item.addEventListener('dragover', (e) => {
        if (![...e.dataTransfer.types].includes('application/x-aurora-fav')) return;
        e.preventDefault();
        item.classList.add('drop-into');
      });
      item.addEventListener('dragleave', () => item.classList.remove('drop-into'));
      item.addEventListener('drop', (e) => {
        e.preventDefault();
        item.classList.remove('drop-into');
        const id = e.dataTransfer.getData('application/x-aurora-fav');
        if (id) store.moveNode(id, n.id, -1);
      });
      if (n.id !== 'bar' && n.id !== 'other') item.addEventListener('contextmenu', (e) => (e.preventDefault(), panels.favoriteItemMenu(bw, n, e)));
      tree.appendChild(item);
      for (const c of n.children) if (c.type === 'folder') rec(c, depth + 1);
    };
    for (const r of store.roots()) rec(r, 0);
  }

  function select(id) {
    folderId = id;
    query = '';
    const s = el.querySelector('.bp-search input');
    if (s) s.value = '';
    renderTree();
    renderList();
  }

  function renderList() {
    clear(list);
    let nodes;
    if (query) {
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
      nodes = [];
      for (const [n] of store.walk()) if (n.type === 'url' && terms.every((x) => (n.title || '').toLowerCase().includes(x) || n.url.toLowerCase().includes(x))) nodes.push(n);
      crumb.textContent = t('fav.results', { count: nodes.length });
    } else {
      const folder = store.node(folderId) || store.bookmarks.bar;
      nodes = folder.children;
      crumb.textContent = folderName(folder);
    }
    list.hidden = !nodes.length;
    const host = list.parentElement;
    host.querySelector('.bp-empty')?.remove();
    if (!nodes.length) {
      host.appendChild(query ? empty('search', t('fav.noResults')) : empty('star', t('fav.emptyFolderTitle'), t('fav.emptyFolderSub')));
      return;
    }
    nodes.forEach((n, i) => list.appendChild(favRow(n, i)));
  }

  function favRow(n, index) {
    const isUrl = n.type === 'url';
    const more = h(
      'button',
      {
        class: 'bw-tbtn small bp-row-more',
        'aria-label': t('common.more'),
        onclick: (e) => {
          e.stopPropagation();
          panels.favoriteItemMenu(bw, n, e);
        },
      },
      icon('more_horizontal', { size: 16 }),
    );
    const r = h(
      'div',
      { class: ['bp-row', 'bp-fav-row', !isUrl && 'folder'], tabindex: '0', role: 'link', draggable: query ? 'false' : 'true', dataset: { id: n.id } },
      h('span', { class: 'bp-row-icon' }, isUrl ? favImg(n.url) : icon('folder', { size: 16, class: 'bw-fav-folder' })),
      h('span', { class: 'bp-row-title ellipsis' }, n.title || (isUrl ? displayUrl(n.url) : t('fav.untitledFolder'))),
      h('span', { class: 'bp-row-host caption text-2 ellipsis' }, isUrl ? displayUrl(n.url) : t('fav.itemCount', { count: n.children.length })),
      more,
    );
    const open = (e) => (isUrl ? bw.openFromLink(n.url, e, tab) : select(n.id));
    r.addEventListener('click', (e) => open(e));
    r.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') open(e);
      else if (e.key === 'Delete') panels.deleteFavorite(bw, n);
      else if (e.key === 'F2') panels.editFavoriteDialog(bw, n);
    });
    r.addEventListener('auxclick', (e) => {
      if (e.button === 1 && isUrl) {
        e.preventDefault();
        bw.openUrl(n.url, { active: false, opener: tab });
      }
    });
    r.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      panels.favoriteItemMenu(bw, n, e);
    });
    r.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('application/x-aurora-fav', n.id);
      e.dataTransfer.effectAllowed = 'move';
      r.classList.add('dragging');
    });
    r.addEventListener('dragend', () => r.classList.remove('dragging'));
    r.addEventListener('dragover', (e) => {
      if (query || ![...e.dataTransfer.types].includes('application/x-aurora-fav')) return;
      e.preventDefault();
      const rr = r.getBoundingClientRect();
      const into = !isUrl && e.clientY > rr.top + rr.height * 0.25 && e.clientY < rr.bottom - rr.height * 0.25;
      r.classList.toggle('drop-into', into);
      r.classList.toggle('drop-before', !into && e.clientY < rr.top + rr.height / 2);
      r.classList.toggle('drop-after', !into && e.clientY >= rr.top + rr.height / 2);
    });
    r.addEventListener('dragleave', () => r.classList.remove('drop-into', 'drop-before', 'drop-after'));
    r.addEventListener('drop', (e) => {
      e.preventDefault();
      const into = r.classList.contains('drop-into');
      const after = r.classList.contains('drop-after');
      r.classList.remove('drop-into', 'drop-before', 'drop-after');
      const id = e.dataTransfer.getData('application/x-aurora-fav');
      if (!id || id === n.id) return;
      if (into) store.moveNode(id, n.id, -1);
      else store.moveNode(id, folderId, index + (after ? 1 : 0));
    });
    return r;
  }

  renderTree();
  renderList();
  const offs = [
    store.on('bookmarks', () => {
      if (!store.node(folderId)) folderId = 'bar';
      renderTree();
      renderList();
    }),
    store.on('favicons', () => renderList()),
  ];
  return { el, destroy: () => offs.forEach((o) => o()) };
}

// ================================================================== Downloads
function downloadsPage(bw) {
  const t = bw.t;
  let query = '';
  const list = h('div', { class: 'bp-col' });
  const body = h('div', { class: 'bp-body' }, list);
  const el = h(
    'div',
    { class: 'bp-downloads' },
    header(
      t('dl.title'),
      searchBox(t('dl.search'), (v) => {
        query = v;
        render();
      }),
      h('button', { class: 'btn', onclick: () => panels.openDownloadsFolder() }, icon('folder_open', { size: 16 }), t('dl.openFolder')),
      h('button', { class: 'btn', onclick: () => shared.clearDownloads() }, icon('delete', { size: 16 }), t('dl.clearAll')),
    ),
    body,
  );
  function render() {
    const scroll = body.scrollTop;
    clear(list);
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    let items = shared.downloadList();
    if (terms.length) items = items.filter((d) => terms.every((x) => (d.filename || '').toLowerCase().includes(x) || (d.url || '').toLowerCase().includes(x)));
    if (!items.length) {
      list.appendChild(query ? empty('search', t('dl.noResults')) : empty('arrow_download', t('dl.empty'), t('dl.emptySub')));
      return;
    }
    let key = null;
    let group = null;
    for (const d of items) {
      const k = dayKey(d.startTime || Date.now());
      if (k !== key) {
        key = k;
        list.appendChild(h('div', { class: 'bp-day' }, dayLabel(bw, d.startTime || Date.now())));
        group = h('div', { class: 'bp-card bp-list bp-dl-group' });
        list.appendChild(group);
      }
      group.appendChild(panels.downloadRow(bw, d));
    }
    body.scrollTop = scroll;
  }
  render();
  let pending = false;
  const off = shared.on('downloads', () => {
    if (pending) return;
    pending = true;
    setTimeout(() => {
      pending = false;
      render();
    }, 200);
  });
  return { el, destroy: off };
}

// ================================================================== Settings
function settingsPage(bw, tab, entry) {
  const t = bw.t;
  const store = shared.store;
  const sections = [
    ['start', 'home', t('settings.secStart')],
    ['appearance', 'paint_brush', t('settings.secAppearance')],
    ['privacy', 'shield_lock', t('settings.secPrivacy')],
    ['downloads', 'arrow_download', t('settings.secDownloads')],
    ['about', 'info', t('about.title')],
  ];
  const nav = h('div', { class: 'bp-set-nav nav' });
  const body = h('div', { class: 'bp-body' });
  const el = h('div', { class: 'bp-settings' }, h('div', { class: 'bp-set-side' }, h('h1', { class: 'bp-title' }, t('settings.title')), nav), body);
  for (const [id, ic, label] of sections) {
    nav.appendChild(
      h(
        'div',
        {
          class: ['nav-item', id === 'start' && 'selected'],
          tabindex: '0',
          dataset: { sec: id },
          onclick: () => jump(id),
          onkeydown: (e) => e.key === 'Enter' && jump(id),
        },
        icon(ic, { size: 18 }),
        h('span', { class: 'ellipsis' }, label),
      ),
    );
  }
  function jump(id) {
    if (id === 'about') return bw.navigate(tab, 'aurora://about');
    const target = body.querySelector(`[data-sec="${id}"]`);
    if (target) body.scrollTo({ top: target.offsetTop - 16, behavior: document.documentElement.dataset.animations === 'off' ? 'auto' : 'smooth' });
    for (const n of nav.children) n.classList.toggle('selected', n.dataset.sec === id);
  }
  const row = (title, desc, control, opts = {}) =>
    h('div', { class: ['bp-set-row', opts.class] }, opts.icon ? icon(opts.icon, { size: 20, class: 'bp-set-icon' }) : null, h('div', { class: 'grow' }, h('div', null, title), desc ? h('div', { class: 'caption text-2' }, desc) : null), control);
  const toggle = (key, label) =>
    ui.toggle({
      checked: !!store.prefs[key],
      label: store.prefs[key] ? t('common.on') : t('common.off'),
      onchange: (v, e) => {
        store.setPref(key, v);
        const lab = e.target.parentElement.querySelector('.toggle-label');
        if (lab) lab.textContent = v ? t('common.on') : t('common.off');
      },
    });
  const radio = (name, value, label, current, onpick) =>
    h(
      'label',
      { class: 'radio' },
      h('input', { type: 'radio', name, value, checked: value === current, onchange: () => onpick(value) }),
      h('span', null, label),
    );
  const rname = uid('r');

  function render() {
    const scroll = body.scrollTop;
    clear(body);
    const col = h('div', { class: 'bp-col' });
    body.appendChild(col);
    // ---- start, home, new tabs
    col.appendChild(h('h2', { class: 'bp-sec', dataset: { sec: 'start' } }, t('settings.secStart')));
    col.appendChild(
      h(
        'div',
        { class: 'bp-card bp-set-group' },
        row(
          t('settings.startup'),
          null,
          h(
            'div',
            { class: 'bp-radios' },
            radio(rname, 'newtab', t('settings.startupNewTab'), store.prefs.startup, (v) => store.setPref('startup', v)),
            radio(rname, 'continue', t('settings.startupContinue'), store.prefs.startup, (v) => store.setPref('startup', v)),
          ),
          { icon: 'window', class: 'stack' },
        ),
        row(t('settings.homeButton'), t('settings.homeButtonDesc'), toggle('homeButton'), { icon: 'home' }),
        (() => {
          const input = h('input', { class: 'input', value: store.prefs.homeUrl || '', placeholder: t('settings.homeNewTab'), spellcheck: false, style: { width: '260px' } });
          const err = h('div', { class: 'caption bw-field-error' });
          input.addEventListener('change', () => {
            const v = input.value.trim();
            if (!v) {
              err.textContent = '';
              return store.setPref('homeUrl', '');
            }
            const c = classify(v, store.prefs.engine);
            if (!c || (c.type !== 'url' && c.type !== 'internal')) {
              err.textContent = t('fav.urlInvalid');
              return;
            }
            err.textContent = '';
            input.value = c.url;
            store.setPref('homeUrl', c.url);
          });
          return row(t('settings.homePage'), t('settings.homePageDesc'), h('div', { class: 'col' }, input, err), { icon: 'link' });
        })(),
        row(t('ntp.showShortcuts'), null, toggle('ntpShortcuts'), { icon: 'apps' }),
        row(t('ntp.showBackground'), null, toggle('ntpBackground'), { icon: 'image' }),
      ),
    );
    // ---- appearance
    col.appendChild(h('h2', { class: 'bp-sec', dataset: { sec: 'appearance' } }, t('settings.secAppearance')));
    col.appendChild(
      h(
        'div',
        { class: 'bp-card bp-set-group' },
        row(
          t('fav.showBar'),
          'Ctrl+Shift+B',
          ui.select({
            options: [
              { value: 'always', label: t('fav.barAlways') },
              { value: 'never', label: t('fav.barNever') },
              { value: 'newtab', label: t('fav.barNewTab') },
            ],
            value: barMode(store.prefs),
            onchange: (v) => store.setPref('showBar', v),
          }),
          { icon: 'star_line_horizontal_3' },
        ),
        row(t('settings.theme'), t('settings.themeDesc'), h('button', { class: 'btn', onclick: () => shared.shell.launch('settings', { page: 'personalization' }) }, t('settings.openPersonalization')), { icon: 'dark_theme' }),
      ),
    );
    // ---- privacy
    col.appendChild(h('h2', { class: 'bp-sec', dataset: { sec: 'privacy' } }, t('settings.secPrivacy')));
    const engines = ui.select({ options: Object.entries(ENGINES).map(([id, e]) => ({ value: id, label: e.name })), value: store.prefs.engine, onchange: (v) => store.setPref('engine', v) });
    engines.classList.add('bp-engine-select');
    const perms = h('div', { class: 'bp-perm-list' });
    col.appendChild(
      h(
        'div',
        { class: 'bp-card bp-set-group' },
        row(t('settings.engine'), t('settings.engineDesc'), engines, { icon: 'search' }),
        row(t('settings.dnt'), t('settings.dntDesc'), toggle('dnt'), { icon: 'eye_off' }),
        row(t('settings.block3p'), t('settings.block3pDesc'), toggle('block3p'), { icon: 'cookies' }),
        row(t('settings.clearData'), t('settings.clearDataDesc'), h('button', { class: 'btn', onclick: () => panels.clearDataDialog(bw) }, t('settings.chooseClear')), { icon: 'delete' }),
        row(t('settings.sitePermissions'), t('settings.sitePermissionsDesc'), h('span'), { icon: 'shield_keyhole', class: 'stack' }),
        perms,
      ),
    );
    renderPerms(perms);
    // ---- downloads
    col.appendChild(h('h2', { class: 'bp-sec', dataset: { sec: 'downloads' } }, t('settings.secDownloads')));
    col.appendChild(
      h(
        'div',
        { class: 'bp-card bp-set-group' },
        row(t('settings.dlLocation'), shared.shell.xdg?.downloads || '~/Downloads', h('button', { class: 'btn', onclick: () => panels.openDownloadsFolder() }, t('dl.openFolder')), { icon: 'folder' }),
      ),
    );
    col.appendChild(
      h(
        'div',
        { class: 'bp-set-foot caption text-2' },
        h('a', { href: '#', onclick: (e) => (e.preventDefault(), bw.navigate(tab, 'aurora://about')) }, t('about.title')),
      ),
    );
    body.scrollTop = scroll;
  }

  async function renderPerms(box) {
    const all = await shared.api.invoke('browser:sitePermissions', bw.private ? bw.partition : undefined).catch(() => ({}));
    clear(box);
    const origins = Object.keys(all).filter((o) => Object.keys(all[o] || {}).length);
    if (!origins.length) {
      box.appendChild(h('div', { class: 'bp-perm-empty caption text-2' }, t('settings.noSitePermissions')));
      return;
    }
    for (const o of origins.sort()) {
      const kinds = Object.entries(all[o]);
      box.appendChild(
        h(
          'div',
          { class: 'bp-perm-row' },
          favImg(o),
          h('div', { class: 'grow' }, h('div', { class: 'ellipsis' }, hostOf(o) || o), h('div', { class: 'caption text-2' }, kinds.map(([k, v]) => `${t(`perm.kind.${k}`)}: ${v === 'allow' ? t('perm.allowed') : t('perm.blocked')}`).join(' · '))),
          h(
            'button',
            {
              class: 'btn small',
              onclick: async () => {
                await shared.api.invoke('browser:resetSitePermissions', o, bw.private ? bw.partition : undefined).catch(() => {});
                renderPerms(box);
              },
            },
            t('site.resetPermissions'),
          ),
        ),
      );
    }
  }

  body.addEventListener('scroll', () => {
    const secs = [...body.querySelectorAll('.bp-sec')];
    let cur = secs[0]?.dataset.sec;
    for (const s of secs) if (s.offsetTop - body.scrollTop < 80) cur = s.dataset.sec;
    for (const n of nav.children) n.classList.toggle('selected', n.dataset.sec === cur);
  });
  render();
  return { el, update: () => render() };
}

// ================================================================== About
function aboutPage(bw) {
  const t = bw.t;
  const info = shared.info || {};
  const version = shared.ctx.env?.version || '1.0.0';
  const el = h('div', { class: 'bp-about' });
  const shortcuts = [
    ['Ctrl+T', t('tab.new')],
    ['Ctrl+W', t('tab.close')],
    ['Ctrl+Shift+T', t('tab.reopen')],
    ['Ctrl+Tab', t('about.scNextTab')],
    ['Ctrl+1 … 8, Ctrl+9', t('about.scTabN')],
    ['Ctrl+N', t('window.new')],
    ['Ctrl+Shift+N', t('window.newPrivate')],
    ['Ctrl+L, Alt+D, F6', t('about.scAddress')],
    ['Ctrl+F', t('find.title')],
    ['Ctrl+D', t('fav.addPage')],
    ['Ctrl+Shift+B', t('fav.showBar')],
    ['Ctrl+H', t('history.title')],
    ['Ctrl+J', t('dl.title')],
    ['Ctrl+Shift+O', t('fav.title')],
    ['Ctrl+R, F5', t('nav.reload')],
    ['Alt+←, Alt+→', `${t('nav.back')} / ${t('nav.forward')}`],
    ['Ctrl++, Ctrl+-, Ctrl+0', t('zoom.label')],
    ['F11', t('fs.enter')],
    ['Ctrl+P', t('menu.savePdf')],
  ];
  el.appendChild(
    h(
      'div',
      { class: 'bp-body' },
      h(
        'div',
        { class: 'bp-col' },
        h('h1', { class: 'bp-title' }, t('about.title')),
        h(
          'div',
          { class: 'bp-card bp-about-card' },
          h('img', { src: APP_ICON, alt: '', class: 'bp-about-logo' }),
          h(
            'div',
            { class: 'grow' },
            h('div', { class: 'subtitle' }, t('app.name')),
            h('div', { class: 'text-2' }, t('about.version', { v: version, chrome: info.chrome || '—' })),
            h('div', { class: 'bp-about-ok caption' }, icon('checkmark_circle', { size: 16, filled: true }), h('span', null, t('about.updates'))),
          ),
        ),
        h('div', { class: 'bp-card bp-about-text' }, h('p', null, t('about.blurb')), h('p', { class: 'caption text-2' }, t('about.license', { electron: info.electron || '—' }))),
        h('h2', { class: 'bp-sec' }, t('about.shortcuts')),
        h('div', { class: 'bp-card bp-shortcuts' }, shortcuts.map(([k, d]) => h('div', { class: 'bp-sc' }, h('span', null, d), h('kbd', null, k)))),
      ),
    ),
  );
  return { el };
}

// ================================================================== blocked / unknown address
function blockedPage(bw, tab, entry) {
  const t = bw.t;
  const url = entry.query?.url || entry.url;
  const notFound = entry.route === 'notfound';
  const el = h(
    'div',
    { class: 'bp-error' },
    h(
      'div',
      { class: 'bp-err-inner' },
      h('div', { class: 'bp-err-art' }, icon('prohibited', { size: 64 })),
      h('h1', { class: 'bp-err-title' }, notFound ? t('err.notFoundTitle') : t('err.blockedTitle')),
      h('p', null, notFound ? t('err.notFoundBody', { url: displayUrl(url) }) : t('err.schemeBody', { url: displayUrl(url) })),
      h('div', { class: 'bp-err-actions' }, h('button', { class: 'btn primary', onclick: () => bw.navigate(tab, 'aurora://newtab') }, t('err.goNewTab'))),
    ),
  );
  return { el };
}
