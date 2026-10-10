// Aurora Browser — find bar, context menus, the "…" menu, flyouts (favorite editor, downloads,
// site information, zoom, permission requests), dialogs (sign-in, clear browsing data, favorite
// editing) and the network error page.
import { h, icon, ui, clear } from './dom.js';
import { shared } from './shared.js';
import { showMenu, flyout, closeMenus } from './menu.js';
import { displayUrl, hostOf, originOf, isWebUrl, isInternal, searchUrl, engineOf, bareHost } from './util.js';

const APP_ICON = 'app://shell/apps/browser/icon.svg';

function fmtSize(n) {
  return shared.ctx.i18n.formatSize(n || 0);
}

// ================================================================== find bar
export function buildFindBar(bw) {
  const t = bw.t;
  const input = h('input', { class: 'bw-find-input', type: 'text', spellcheck: false });
  const count = h('span', { class: 'bw-find-count caption' });
  const btn = (ic, fn) => h('button', { class: 'bw-tbtn small', onclick: fn }, icon(ic, { size: 16 }));
  const prev = btn('chevron_up', () => step(false));
  const next = btn('chevron_down', () => step(true));
  const close = btn('dismiss', () => api.close());
  const el = h('div', { class: 'bw-find', hidden: true, role: 'search' }, icon('search', { size: 16, class: 'bw-find-icon' }), input, count, h('div', { class: 'bw-find-sep' }), prev, next, close);
  let lastText = '';

  function relocalize() {
    input.placeholder = t('find.placeholder');
    input.setAttribute('aria-label', t('find.placeholder'));
    prev.dataset.tip = `${t('find.prev')} (Shift+Enter)`;
    next.dataset.tip = `${t('find.next')} (Enter)`;
    close.dataset.tip = `${t('find.close')} (Esc)`;
    prev.setAttribute('aria-label', t('find.prev'));
    next.setAttribute('aria-label', t('find.next'));
    close.setAttribute('aria-label', t('find.close'));
    for (const b of [prev, next, close]) b.dataset.tipPos = 'below';
  }
  relocalize();

  function webTab() {
    const tab = bw.active;
    return tab && bw.isWeb(tab) && tab.wv && tab.ready && !tab.web.error ? tab : null;
  }

  function search(newSession) {
    const tab = webTab();
    const text = input.value;
    if (!tab) return;
    tab.find.text = text;
    if (!text) {
      tab.wv.stopFindInPage('clearSelection');
      setCount(null);
      return;
    }
    tab.wv.findInPage(text, { findNext: newSession, forward: true, matchCase: false });
  }

  function step(forward) {
    const tab = webTab();
    if (!tab || !input.value) return;
    if (input.value !== lastText) {
      lastText = input.value;
      tab.wv.findInPage(input.value, { findNext: true, forward });
    } else tab.wv.findInPage(input.value, { findNext: false, forward });
  }

  function setCount(r) {
    if (!r) {
      count.textContent = '';
      el.classList.remove('nomatch');
      return;
    }
    count.textContent = t('find.count', { current: r.matches ? r.activeMatchOrdinal : 0, total: r.matches });
    el.classList.toggle('nomatch', !r.matches && !!input.value);
  }

  input.addEventListener('input', () => {
    lastText = input.value;
    search(true);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      step(!e.shiftKey);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      api.close();
    }
  });

  const api = {
    el,
    relocalize,
    step,
    isOpen: () => !el.hidden,
    open() {
      const tab = webTab();
      if (!tab) return;
      tab.find.open = true;
      el.hidden = false;
      el.classList.remove('leaving');
      input.value = tab.find.text || lastText || '';
      input.focus();
      input.select();
      if (input.value) search(true);
    },
    close(tab = bw.active) {
      if (!tab) return;
      tab.find.open = false;
      try {
        if (tab.wv && tab.ready) tab.wv.stopFindInPage('keepSelection');
      } catch {}
      if (tab === bw.active) {
        el.hidden = true;
        setCount(null);
        bw.focusPage(tab);
      }
    },
    stop(tab) {
      tab.find.open = false;
      try {
        if (tab.wv && tab.ready) tab.wv.stopFindInPage('clearSelection');
      } catch {}
    },
    refresh(tab) {
      if (tab === bw.active && !el.hidden && input.value) setTimeout(() => search(true), 300);
    },
    sync() {
      const tab = bw.active;
      const open = !!tab?.find.open && bw.isWeb(tab);
      el.hidden = !open;
      if (open) {
        input.value = tab.find.text || '';
        count.textContent = '';
      }
    },
    onResult(tab, r) {
      if (tab !== bw.active || el.hidden) return;
      if (r.finalUpdate || r.matches != null) setCount(r);
    },
  };
  return api;
}

// ================================================================== error page
export function errorPage(bw, tab) {
  const t = bw.t;
  const err = tab.web.error || { kind: 'crash' };
  const host = hostOf(err.url) || displayUrl(err.url);
  let title = t('err.title');
  let lines = [];
  let ic = 'plug_disconnected';
  const buttons = [];
  if (err.kind === 'crash') {
    title = t('err.crashTitle');
    lines = [t('err.crashBody')];
    ic = 'document_error';
  } else if (err.cert) {
    title = t('err.certTitle');
    lines = [t('err.certBody', { host }), t('err.certHint')];
    ic = 'shield_error';
  } else if (err.kind === 'dns') {
    lines = [t('err.dnsBody', { host }), t('err.tryList'), `• ${t('err.tryTypo')}`, `• ${t('err.tryConnection')}`];
  } else if (err.kind === 'refused') {
    lines = [t('err.refusedBody', { host }), t('err.tryList'), `• ${t('err.tryLater')}`, `• ${t('err.tryConnection')}`];
  } else if (err.kind === 'offline') {
    title = t('err.offlineTitle');
    lines = [t('err.offlineBody')];
    ic = 'wifi_off';
  } else if (err.kind === 'timeout') {
    lines = [t('err.timeoutBody', { host }), t('err.tryList'), `• ${t('err.tryLater')}`, `• ${t('err.tryConnection')}`];
  } else if (err.kind === 'proxy') {
    lines = [t('err.proxyBody', { host })];
  } else if (err.kind === 'redirects') {
    title = t('err.redirectsTitle');
    lines = [t('err.redirectsBody', { host })];
  } else if (err.kind === 'blocked') {
    title = t('err.blockedTitle');
    lines = [t('err.blockedBody', { host })];
    ic = 'prohibited';
  } else {
    lines = [t('err.genericBody', { host })];
  }
  if (err.cert) {
    buttons.push(
      h(
        'button',
        {
          class: 'btn primary',
          onclick: () => {
            if (bw.canGoBack(tab)) bw.goBack(tab);
            else bw.navigate(tab, 'aurora://newtab');
          },
        },
        t('err.goBack'),
      ),
    );
  } else {
    buttons.push(h('button', { class: 'btn primary', onclick: () => bw.reload(false, tab) }, err.kind === 'crash' ? t('nav.reload') : t('err.retry')));
  }
  const details = h('div', { class: 'bp-err-code caption' }, err.name || '');
  const el = h(
    'div',
    { class: ['bp-error', err.cert && 'cert'], tabindex: '-1' },
    h(
      'div',
      { class: 'bp-err-inner' },
      h('div', { class: 'bp-err-art' }, icon(ic, { size: 64 })),
      h('h1', { class: 'bp-err-title' }, title),
      ...lines.map((l) => h('p', { class: l.startsWith('•') ? 'bp-err-li' : '' }, l)),
      details,
      h('div', { class: 'bp-err-actions' }, buttons),
    ),
  );
  return el;
}

// ================================================================== menus
function menuOpts(bw) {
  return { class: bw.menuClass() };
}

export function tabMenu(bw, tab, at) {
  const t = bw.t;
  const i = bw.tabs.indexOf(tab);
  const audible = tab.web.audible || tab.muted;
  ui.menu(
    at,
    [
      { label: t('tab.newRight'), icon: 'tab_add', action: () => bw.createTab({ url: 'aurora://newtab', index: i + 1, active: true, focusOmni: true }) },
      '-',
      { label: t('nav.reload'), icon: 'arrow_clockwise', shortcut: 'Ctrl+R', action: () => bw.reload(false, tab) },
      { label: t('tab.duplicate'), icon: 'tab_desktop_copy', action: () => bw.duplicateTab(tab) },
      { label: tab.muted ? t('tab.unmute') : t('tab.mute'), icon: tab.muted ? 'speaker_2' : 'speaker_mute', action: () => bw.setMuted(tab, !tab.muted), disabled: !audible && !tab.wv },
      { label: t('tab.moveToWindow'), icon: 'window_new', action: () => bw.moveTabToNewWindow(tab), disabled: bw.tabs.length < 2 },
      '-',
      { label: t('tab.close'), icon: 'dismiss', shortcut: 'Ctrl+W', action: () => bw.closeTab(tab) },
      { label: t('tab.closeOthers'), action: () => bw.closeOtherTabs(tab), disabled: bw.tabs.length < 2 },
      { label: t('tab.closeRight'), action: () => bw.closeTabsToRight(tab), disabled: i >= bw.tabs.length - 1 },
      '-',
      { label: t('tab.reopen'), icon: 'arrow_undo', shortcut: 'Ctrl+Shift+T', action: () => bw.reopenClosed(), disabled: !bw.closedTabs.length },
    ],
    menuOpts(bw),
  );
}

export function pageMenu(bw, tab, p) {
  const t = bw.t;
  const r = tab.wv?.getBoundingClientRect() || { left: 0, top: 0 };
  const at = { x: r.left + (p.x || 0), y: r.top + (p.y || 0) };
  const items = [];
  const copyText = (s) => shared.api.invoke('clipboard:writeText', s).catch(() => {});
  const engine = engineOf(bw.prefs.engine).name;
  const link = p.linkURL && !/^javascript:/i.test(p.linkURL) ? p.linkURL : '';
  if (link) {
    const web = isWebUrl(link);
    items.push(
      { label: t('ctx.openLinkTab'), icon: 'tab_add', action: () => bw.openUrl(link, { active: false, opener: tab }), disabled: !web && !/^(mailto|tel):/i.test(link) },
      { label: t('ctx.openLinkWindow'), icon: 'window_new', action: () => shared.shell.launch('browser', { newWindow: true, url: link, private: bw.private || undefined }), disabled: !web },
      { label: t('ctx.openLinkPrivate'), icon: 'window_inprivate', action: () => shared.shell.launch('browser', { newWindow: true, private: true, url: link }), disabled: !web },
      '-',
      { label: t('ctx.saveLinkAs'), icon: 'arrow_download', action: () => saveUrlAs(bw, tab, link, suggestName(link)), disabled: !web },
      { label: t('ctx.copyLink'), icon: 'link', action: () => copyText(link) },
      '-',
    );
  }
  if (p.mediaType === 'image' && p.srcURL) {
    items.push(
      { label: t('ctx.openImageTab'), icon: 'image', action: () => bw.openUrl(p.srcURL, { active: false, opener: tab }) },
      { label: t('ctx.saveImageAs'), icon: 'save', action: () => saveUrlAs(bw, tab, p.srcURL, suggestName(p.srcURL, 'image')) },
      { label: t('ctx.copyImage'), icon: 'copy', action: () => shared.api.invoke('browser:copyImageAt', tab.wcId, p.x, p.y).catch((e) => ui.alert(shared.errorText(e), { title: t('ctx.copyImage'), parent: bw.win })) },
      { label: t('ctx.copyImageLink'), icon: 'link', action: () => copyText(p.srcURL) },
      '-',
    );
  } else if ((p.mediaType === 'video' || p.mediaType === 'audio') && p.srcURL && isWebUrl(p.srcURL)) {
    const v = p.mediaType === 'video';
    items.push(
      { label: v ? t('ctx.openVideoTab') : t('ctx.openAudioTab'), icon: v ? 'video' : 'music_note_2', action: () => bw.openUrl(p.srcURL, { active: false, opener: tab }) },
      { label: v ? t('ctx.saveVideoAs') : t('ctx.saveAudioAs'), icon: 'save', action: () => saveUrlAs(bw, tab, p.srcURL, suggestName(p.srcURL, v ? 'video' : 'audio')) },
      { label: v ? t('ctx.copyVideoLink') : t('ctx.copyAudioLink'), icon: 'link', action: () => copyText(p.srcURL) },
      '-',
    );
  }
  const ef = p.editFlags || {};
  const sel = (p.selectionText || '').trim();
  if (p.isEditable) {
    if (p.misspelledWord && p.dictionarySuggestions?.length) {
      for (const s of p.dictionarySuggestions.slice(0, 4)) items.push({ label: s, action: () => tab.wv.replaceMisspelling(s) });
      items.push('-');
    }
    items.push(
      { label: t('ctx.undo'), icon: 'arrow_undo', shortcut: 'Ctrl+Z', disabled: !ef.canUndo, action: () => tab.wv.undo() },
      { label: t('ctx.redo'), icon: 'arrow_redo', shortcut: 'Ctrl+Y', disabled: !ef.canRedo, action: () => tab.wv.redo() },
      '-',
      { label: t('ctx.cut'), icon: 'cut', shortcut: 'Ctrl+X', disabled: !ef.canCut, action: () => tab.wv.cut() },
      { label: t('ctx.copy'), icon: 'copy', shortcut: 'Ctrl+C', disabled: !ef.canCopy, action: () => tab.wv.copy() },
      { label: t('ctx.paste'), icon: 'clipboard_paste', shortcut: 'Ctrl+V', disabled: !ef.canPaste, action: () => tab.wv.paste() },
      { label: t('ctx.pastePlain'), shortcut: 'Ctrl+Shift+V', disabled: !ef.canPaste, action: () => tab.wv.pasteAndMatchStyle() },
      { label: t('ctx.selectAll'), icon: 'select_all_on', shortcut: 'Ctrl+A', disabled: !ef.canSelectAll, action: () => tab.wv.selectAll() },
    );
  } else if (sel) {
    const short = sel.length > 32 ? `${sel.slice(0, 30)}…` : sel;
    items.push(
      { label: t('ctx.copy'), icon: 'copy', shortcut: 'Ctrl+C', action: () => tab.wv.copy() },
      { label: t('ctx.searchFor', { engine, text: short }), icon: 'search', action: () => bw.openUrl(searchUrl(bw.prefs.engine, sel), { active: true, opener: tab }) },
    );
  }
  if (!link && !p.isEditable && !sel && p.mediaType === 'none') {
    items.push(
      { label: t('nav.back'), icon: 'arrow_left', shortcut: 'Alt+←', disabled: !bw.canGoBack(tab), action: () => bw.goBack(tab) },
      { label: t('nav.forward'), icon: 'arrow_right', shortcut: 'Alt+→', disabled: !bw.canGoForward(tab), action: () => bw.goForward(tab) },
      { label: t('nav.reload'), icon: 'arrow_clockwise', shortcut: 'Ctrl+R', action: () => bw.reload(false, tab) },
      '-',
      { label: t('menu.savePage'), icon: 'save', shortcut: 'Ctrl+S', action: () => savePage(bw) },
      { label: t('menu.savePdf'), icon: 'document_pdf', shortcut: 'Ctrl+P', action: () => savePdf(bw) },
      { label: t('ctx.selectAll'), icon: 'select_all_on', shortcut: 'Ctrl+A', action: () => tab.wv.selectAll() },
    );
  }
  while (items[items.length - 1] === '-') items.pop();
  const pageUrl = tab.web.url;
  if (isWebUrl(pageUrl)) items.push('-', { label: t('ctx.viewSource'), icon: 'code', shortcut: 'Ctrl+U', action: () => bw.openUrl(`view-source:${pageUrl}`, { active: true, opener: tab }) });
  if (shared.dev) items.push({ label: t('ctx.inspect'), icon: 'window_dev_tools', action: () => shared.api.invoke('browser:inspect', tab.wcId, p.x, p.y).catch(() => {}) });
  // Commands act on the page: give it the keyboard focus back first (edit commands need it).
  for (const it of items) {
    if (!it || typeof it.action !== 'function') continue;
    const run = it.action;
    it.action = () => {
      if (tab.wv && bw.active === tab && !bw.dialogOpen()) tab.wv.focus();
      run();
    };
  }
  const done = ui.menu(at, items, menuOpts(bw));
  // The right-click happened inside the page, which keeps the keyboard focus: move it to the menu
  // so Esc / arrows / Enter work, and return it to the page when the menu closes.
  const el = [...document.querySelectorAll('body > .menu')].pop();
  el?.focus({ preventScroll: true });
  done.then(() => {
    const ae = document.activeElement;
    if (!bw.closing && bw.active === tab && tab.wv && !bw.dialogOpen() && (!ae || ae === document.body)) tab.wv.focus();
  });
}

function suggestName(url, fallback = 'download') {
  try {
    const u = new URL(url);
    const last = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '');
    if (last && last.length < 120) return last.replace(/[/\\]/g, '_');
  } catch {}
  if (/^data:image\/(\w+)/i.test(url)) return `${fallback}.${/^data:image\/(\w+)/i.exec(url)[1].replace('jpeg', 'jpg').replace('svg+xml', 'svg')}`;
  return fallback;
}

async function saveUrlAs(bw, tab, url, name) {
  const xdg = shared.shell.xdg || (await shared.api.invoke('fs:xdg').catch(() => ({})));
  const ext = (/\.[a-z0-9]{1,5}$/i.exec(name)?.[0] || '').toLowerCase();
  const path = await ui.filePicker({ mode: 'save', path: xdg.downloads, name, title: bw.t('ctx.saveAs'), filters: ext ? [{ name: ext.slice(1).toUpperCase(), ext: [ext] }, { name: bw.t('dl.allFiles'), ext: ['*'] }] : [], parent: bw.win });
  if (!path) return;
  try {
    await shared.api.invoke('browser:downloadUrl', { sourceId: tab?.wcId, partition: bw.partition, url, savePath: path });
  } catch (err) {
    ui.alert(shared.errorText(err), { title: bw.t('dl.title'), parent: bw.win });
  }
}

export async function savePage(bw) {
  const tab = bw.active;
  if (!tab || !bw.isWeb(tab) || !isWebUrl(tab.web.url)) return;
  const base = (tab.web.title || bareHost(tab.web.url) || 'page').replace(/[/\\:*?"<>|]+/g, ' ').trim().slice(0, 80) || 'page';
  await saveUrlAs(bw, tab, tab.web.url, `${base}.html`);
}

export async function savePdf(bw) {
  const tab = bw.active;
  if (!tab || !bw.isWeb(tab) || !tab.wv || !tab.ready || tab.web.error) return;
  const xdg = shared.shell.xdg || (await shared.api.invoke('fs:xdg').catch(() => ({})));
  const base = (tab.web.title || bareHost(tab.web.url) || 'page').replace(/[/\\:*?"<>|]+/g, ' ').trim().slice(0, 80) || 'page';
  const path = await ui.filePicker({ mode: 'save', path: xdg.documents, name: `${base}.pdf`, title: bw.t('menu.savePdf'), filters: [{ name: 'PDF', ext: ['.pdf'] }], parent: bw.win });
  if (!path) return;
  try {
    const data = await tab.wv.printToPDF({ printBackground: true, pageSize: bw.ctx.lang === 'fr' ? 'A4' : 'Letter' });
    await shared.api.invoke('fs:writeBytes', path, data);
    shared.shell.notify({ title: bw.t('menu.pdfSaved'), body: path.split('/').pop(), appId: 'browser', onClick: () => shared.shell.openFile(path) });
  } catch (err) {
    ui.alert(shared.errorText(err), { title: bw.t('menu.savePdf'), parent: bw.win });
  }
}

// ---- "Settings and more" (…) menu
export function moreMenu(bw, anchor) {
  const t = bw.t;
  const tab = bw.active;
  const web = !!tab && bw.isWeb(tab) && !!tab.wv && !tab.web.error;
  const zoomPct = h('span', { class: 'bw-zoom-pct' });
  const updateZoom = () => {
    zoomPct.textContent = `${Math.round((bw.active?.zoom || 1) * 100)} %`;
  };
  updateZoom();
  bw.menuZoomUpdate = updateZoom;
  const zb = (ic, label, fn) =>
    h(
      'button',
      {
        class: 'bw-tbtn small',
        'aria-label': label,
        'data-tip': label,
        onclick: (e) => {
          e.stopPropagation();
          fn();
          updateZoom();
        },
      },
      icon(ic, { size: 16 }),
    );
  const zoomRow = h(
    'div',
    { class: 'bw-menu-zoom' },
    icon('zoom_in', { size: 16, class: 'bw-menu-zoom-ic' }),
    h('span', { class: 'label' }, t('zoom.label')),
    zb('subtract', `${t('zoom.out')} (Ctrl+-)`, () => bw.zoom(-1)),
    zoomPct,
    zb('add', `${t('zoom.in')} (Ctrl++)`, () => bw.zoom(1)),
    zb('full_screen_maximize', `${t('fs.enter')} (F11)`, () => {
      closeMenus();
      bw.toggleFullscreen();
    }),
  );
  anchor.classList.add('open');
  showMenu(
    anchor,
    [
      { label: t('tab.new'), icon: 'tab_add', shortcut: 'Ctrl+T', action: () => bw.newTab() },
      { label: t('window.new'), icon: 'window_new', shortcut: 'Ctrl+N', action: () => shared.shell.launch('browser', { newWindow: true }) },
      { label: t('window.newPrivate'), icon: 'window_inprivate', shortcut: 'Ctrl+Shift+N', action: () => shared.shell.launch('browser', { newWindow: true, private: true }) },
      '-',
      { custom: zoomRow },
      '-',
      { label: t('fav.title'), icon: 'star_line_horizontal_3', shortcut: 'Ctrl+Shift+O', action: () => bw.openInternal('favorites') },
      { label: t('history.title'), icon: 'history', shortcut: 'Ctrl+H', action: () => bw.openInternal('history') },
      { label: t('dl.title'), icon: 'arrow_download', shortcut: 'Ctrl+J', action: () => bw.openInternal('downloads') },
      '-',
      { label: t('find.title'), icon: 'search', shortcut: 'Ctrl+F', action: () => bw.findBar.open(), disabled: !web },
      { label: t('menu.savePdf'), icon: 'document_pdf', shortcut: 'Ctrl+P', action: () => savePdf(bw), disabled: !web },
      {
        label: t('menu.moreTools'),
        icon: 'toolbox',
        submenu: [
          { label: t('menu.savePage'), icon: 'save', shortcut: 'Ctrl+S', action: () => savePage(bw), disabled: !web || !isWebUrl(tab?.web.url) },
          { label: t('ctx.viewSource'), icon: 'code', shortcut: 'Ctrl+U', action: () => bw.handleCombo('Ctrl+U'), disabled: !web || !isWebUrl(tab?.web.url) },
          { label: t('settings.clearData'), icon: 'delete', shortcut: 'Ctrl+Shift+Del', action: () => clearDataDialog(bw) },
          shared.dev ? { label: t('menu.devtools'), icon: 'window_dev_tools', shortcut: 'F12', action: () => tab?.wcId != null && shared.api.invoke('browser:inspect', tab.wcId).catch(() => {}), disabled: !web } : null,
        ].filter(Boolean),
      },
      '-',
      { label: t('settings.title'), icon: 'settings', action: () => bw.openInternal('settings') },
      { label: t('about.menu'), icon: 'info', action: () => bw.openInternal('about') },
      '-',
      { label: bw.private ? t('window.closePrivate') : t('window.close'), icon: 'dismiss', shortcut: 'Ctrl+Shift+W', action: () => bw.win.close() },
    ],
    {
      align: 'right',
      className: ['bw-more-menu', bw.private && 'bw-private'].filter(Boolean).join(' '),
      onClose: () => {
        anchor.classList.remove('open');
        bw.menuZoomUpdate = null;
      },
    },
  );
}

// ---- toolbar favorites button
export function favoritesMenu(bw, anchor) {
  const t = bw.t;
  const bar = bw.favbar;
  const url = bw.tabUrl(bw.active);
  const canAdd = !!url && url !== 'aurora://newtab';
  const exists = !!shared.store.findBookmark(url);
  anchor.classList.add('open');
  showMenu(
    anchor,
    [
      { label: exists ? t('fav.edit') : t('fav.addPage'), icon: exists ? 'star_edit' : 'star_add', shortcut: 'Ctrl+D', action: () => favoriteFlyout(bw), disabled: !canAdd },
      { label: t('fav.manage'), icon: 'settings', shortcut: 'Ctrl+Shift+O', action: () => bw.openInternal('favorites') },
      '-',
      { label: t('fav.bar'), icon: 'folder', submenu: () => bar.menuItems(shared.store.bookmarks.bar.children) },
      { label: t('fav.other'), icon: 'folder', submenu: () => bar.menuItems(shared.store.bookmarks.other.children) },
    ],
    { align: 'right', className: bw.private ? 'bw-private' : '', onClose: () => anchor.classList.remove('open') },
  );
}

export function favoriteItemMenu(bw, node, e) {
  const t = bw.t;
  const isUrl = node.type === 'url';
  const items = isUrl
    ? [
        { label: t('ctx.openLinkTab'), icon: 'tab_add', action: () => bw.openUrl(node.url, { active: false, opener: bw.active }) },
        { label: t('ctx.openLinkWindow'), icon: 'window_new', action: () => shared.shell.launch('browser', { newWindow: true, url: node.url }) },
        { label: t('ctx.openLinkPrivate'), icon: 'window_inprivate', action: () => shared.shell.launch('browser', { newWindow: true, private: true, url: node.url }) },
        '-',
        { label: t('fav.editItem'), icon: 'edit', action: () => editFavoriteDialog(bw, node) },
        { label: t('ctx.copyLink'), icon: 'link', action: () => shared.api.invoke('clipboard:writeText', node.url).catch(() => {}) },
        { label: t('common.delete'), icon: 'delete', action: () => deleteFavorite(bw, node) },
      ]
    : [
        { label: t('fav.openAll', { count: node.children.filter((c) => c.type === 'url').length }), icon: 'tab_desktop_multiple', disabled: !node.children.some((c) => c.type === 'url'), action: () => bw.favbar.openAll(node) },
        '-',
        { label: t('fav.rename'), icon: 'rename', action: () => editFavoriteDialog(bw, node) },
        { label: t('fav.addFolder'), icon: 'folder_add', action: () => newFolderDialog(bw, node.id) },
        { label: t('common.delete'), icon: 'delete', action: () => deleteFavorite(bw, node) },
      ];
  items.push('-', { label: t('fav.manage'), icon: 'settings', action: () => bw.openInternal('favorites') });
  ui.menu(e, items, menuOpts(bw));
}

export async function deleteFavorite(bw, node) {
  if (node.type === 'folder' && node.children.length) {
    const ok = await ui.confirm(bw.t('fav.deleteFolderConfirm', { name: node.title, count: node.children.length }), { title: bw.t('fav.deleteFolder'), okLabel: bw.t('common.delete'), parent: bw.win });
    if (!ok) return;
  }
  shared.store.removeNode(node.id);
}

function folderSelect(bw, value) {
  const t = bw.t;
  const sel = h('select', { class: 'select bw-folder-select' });
  for (const f of shared.store.folders()) {
    const name = f.id === 'bar' ? t('fav.bar') : f.id === 'other' ? t('fav.other') : f.title || t('fav.untitledFolder');
    sel.appendChild(h('option', { value: f.id, selected: f.id === value }, `${' '.repeat(f.depth)}${name}`));
  }
  return sel;
}

export async function editFavoriteDialog(bw, node) {
  const t = bw.t;
  const isUrl = node.type === 'url';
  const name = h('input', { class: 'input', value: node.title || '' });
  const url = isUrl ? h('input', { class: 'input', value: node.url, spellcheck: false }) : null;
  const parentId = shared.store.parentOf(node.id)?.id || 'bar';
  const folder = folderSelect(bw, parentId);
  if (!isUrl) {
    // A folder cannot move into itself or its descendants.
    for (const o of [...folder.options]) if (o.value === node.id || shared.store.isAncestor(node.id, o.value)) o.disabled = true;
  }
  const err = h('div', { class: 'field-hint bw-field-error' });
  const body = h(
    'div',
    { class: 'bw-dialog-form' },
    h('div', { class: 'field' }, h('label', null, t('fav.name')), name),
    isUrl ? h('div', { class: 'field' }, h('label', null, t('fav.url')), url) : null,
    h('div', { class: 'field' }, h('label', null, t('fav.folder')), folder),
    err,
  );
  const v = await ui.dialog({
    title: isUrl ? t('fav.editItem') : t('fav.rename'),
    body,
    parent: bw.win,
    width: 440,
    buttons: [
      { label: t('common.save'), value: 'save', primary: true },
      { label: t('common.cancel'), value: null },
    ],
    onOpen: (dlg) => {
      dlg._validate = (val) => {
        if (val !== 'save') return true;
        if (!name.value.trim() && !isUrl) {
          err.textContent = t('fav.nameRequired');
          return false;
        }
        if (isUrl && !/^(https?|ftp|aurora|data|about):/i.test(url.value.trim())) {
          err.textContent = t('fav.urlInvalid');
          return false;
        }
        return true;
      };
      setTimeout(() => name.select(), 40);
    },
  });
  if (v !== 'save') return;
  shared.store.updateNode(node.id, { title: name.value.trim() || url?.value.trim(), url: url?.value.trim(), parentId: folder.value });
}

export async function newFolderDialog(bw, parentId = 'bar') {
  const n = await ui.prompt({ title: bw.t('fav.addFolder'), label: bw.t('fav.name'), value: bw.t('fav.newFolder'), parent: bw.win, validate: (v) => (v.trim() ? null : bw.t('fav.nameRequired')) });
  if (n) shared.store.addFolder({ title: n.trim(), parentId });
}

export async function addFavoriteDialog(bw, parentId = 'bar') {
  const t = bw.t;
  const name = h('input', { class: 'input', placeholder: t('fav.name') });
  const url = h('input', { class: 'input', placeholder: 'https://', spellcheck: false });
  const folder = folderSelect(bw, parentId);
  const err = h('div', { class: 'field-hint bw-field-error' });
  const body = h(
    'div',
    { class: 'bw-dialog-form' },
    h('div', { class: 'field' }, h('label', null, t('fav.name')), name),
    h('div', { class: 'field' }, h('label', null, t('fav.url')), url),
    h('div', { class: 'field' }, h('label', null, t('fav.folder')), folder),
    err,
  );
  const v = await ui.dialog({
    title: t('fav.addPage'),
    body,
    parent: bw.win,
    width: 440,
    buttons: [
      { label: t('common.save'), value: 'save', primary: true },
      { label: t('common.cancel'), value: null },
    ],
    onOpen: (dlg) => {
      dlg._validate = (val) => {
        if (val !== 'save') return true;
        let u = url.value.trim();
        if (u && !/^[a-z][a-z0-9+.-]*:/i.test(u)) u = `https://${u}`;
        try {
          if (!/^(https?|ftp|aurora):/i.test(u)) throw new Error();
          new URL(u);
        } catch {
          err.textContent = t('fav.urlInvalid');
          return false;
        }
        url.value = u;
        return true;
      };
    },
  });
  if (v !== 'save') return;
  shared.store.addBookmark({ title: name.value.trim() || url.value.trim(), url: url.value.trim(), parentId: folder.value });
}

// ================================================================== flyouts
export function favoriteFlyout(bw) {
  const t = bw.t;
  const tab = bw.active;
  const url = bw.tabUrl(tab);
  if (!url || url === 'aurora://newtab' || tab?.lazy) return;
  if (bw.flyout?.kind === 'favorite') return bw.closeFlyout();
  const store = shared.store;
  let node = store.findBookmark(url);
  const added = !node;
  if (!node) {
    const parent = store.node(bw.prefs.lastFolder) ? bw.prefs.lastFolder : 'bar';
    node = store.addBookmark({ title: bw.tabTitle(tab), url, parentId: parent });
  }
  const name = h('input', { class: 'input', value: node.title });
  const folder = folderSelect(bw, store.parentOf(node.id)?.id || 'bar');
  const commit = () => {
    if (!store.node(node.id)) return;
    store.updateNode(node.id, { title: name.value.trim() || url, parentId: folder.value });
    store.setPref('lastFolder', folder.value);
  };
  const content = h(
    'div',
    { class: 'bw-fav-pop' },
    h('div', { class: 'bw-pop-title' }, added ? t('fav.added') : t('fav.edit')),
    h('div', { class: 'bw-pop-row' }, h('label', null, t('fav.name')), name),
    h('div', { class: 'bw-pop-row' }, h('label', null, t('fav.folder')), folder),
    h(
      'div',
      { class: 'bw-pop-actions' },
      h(
        'button',
        {
          class: 'btn',
          onclick: () => {
            commit();
            bw.closeFlyout();
            bw.openInternal('favorites', { folder: folder.value });
          },
        },
        t('fav.more'),
      ),
      h('div', { class: 'grow' }),
      h(
        'button',
        {
          class: 'btn primary',
          onclick: () => {
            commit();
            bw.closeFlyout();
          },
        },
        t('common.done'),
      ),
      h(
        'button',
        {
          class: 'btn',
          onclick: () => {
            store.removeNode(node.id);
            node = null;
            bw.closeFlyout();
          },
        },
        t('common.remove'),
      ),
    ),
  );
  name.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
      bw.closeFlyout();
    }
  });
  folder.addEventListener('change', commit);
  const f = flyout({ host: bw.root, anchor: bw.omni.starBtn.hidden ? bw.omni.el : bw.omni.starBtn, content, align: 'right', className: 'bw-pop', width: 340, onClose: () => node && store.node(node.id) && commit() });
  bw.setFlyout(f, 'favorite');
  setTimeout(() => {
    name.focus();
    name.select();
  }, 30);
}

export function downloadsFlyout(bw, anchor) {
  const t = bw.t;
  const list = h('div', { class: 'bw-dl-list' });
  const render = () => {
    clear(list);
    const items = shared.downloadList(bw).slice(0, 6);
    if (!items.length) list.appendChild(h('div', { class: 'bw-dl-empty' }, icon('arrow_download', { size: 32 }), h('div', null, t('dl.empty'))));
    for (const d of items) list.appendChild(downloadRow(bw, d, { compact: true }));
  };
  render();
  const off = shared.on('downloads', () => (f.closed ? off() : render()));
  const content = h(
    'div',
    { class: 'bw-dl-pop' },
    h(
      'div',
      { class: 'bw-pop-head' },
      h('div', { class: 'bw-pop-title' }, t('dl.title')),
      h('div', { class: 'grow' }),
      h('button', { class: 'bw-tbtn small', 'aria-label': t('dl.openFolder'), 'data-tip': t('dl.openFolder'), onclick: () => openDownloadsFolder() }, icon('folder_open', { size: 16 })),
      h(
        'button',
        {
          class: 'bw-tbtn small',
          'aria-label': t('dl.openPage'),
          'data-tip': t('dl.openPage'),
          onclick: () => {
            bw.closeFlyout();
            bw.openInternal('downloads');
          },
        },
        icon('open', { size: 16 }),
      ),
    ),
    list,
  );
  const f = flyout({ host: bw.root, anchor, content, align: 'right', className: 'bw-pop bw-dl-flyout', width: 380, onClose: () => off() });
  bw.setFlyout(f, 'downloads');
}

export function openDownloadsFolder() {
  const dir = shared.shell.xdg?.downloads;
  if (dir) shared.shell.launch('files', { path: dir });
  else shared.api.invoke('fs:xdg').then((x) => shared.shell.launch('files', { path: x.downloads }));
}

export function downloadStatus(bw, d) {
  const t = bw.t;
  if (d.state === 'progressing') {
    if (d.paused) return t('dl.paused', { received: fmtSize(d.received), total: d.total ? fmtSize(d.total) : '?' });
    const left = d.total && d.speed > 1 ? Math.max(1, Math.round((d.total - d.received) / d.speed)) : null;
    const of = d.total ? t('dl.of', { received: fmtSize(d.received), total: fmtSize(d.total) }) : fmtSize(d.received);
    if (left == null) return of;
    const time = left >= 3600 ? t('dl.hoursLeft', { count: Math.round(left / 3600) }) : left >= 60 ? t('dl.minutesLeft', { count: Math.round(left / 60) }) : t('dl.secondsLeft', { count: left });
    return `${of} · ${time}`;
  }
  if (d.state === 'completed') return d.total ? fmtSize(d.total) : t('dl.completed');
  if (d.state === 'cancelled') return t('dl.cancelled');
  return t('dl.failed');
}

export function downloadRow(bw, d, { compact = false } = {}) {
  const t = bw.t;
  const ext = (/\.[^./]+$/.exec(d.filename || '')?.[0] || '').toLowerCase();
  const ic = ui.fileIcon({ ext, dir: false });
  const act = (ic2, label, fn, cls) =>
    h(
      'button',
      {
        class: ['bw-tbtn small', cls],
        'aria-label': label,
        'data-tip': label,
        onclick: (e) => {
          e.stopPropagation();
          fn();
        },
      },
      icon(ic2, { size: 16 }),
    );
  const actions = h('div', { class: 'bw-dl-actions' });
  const api = shared.api;
  const fail = (err) => ui.alert(shared.errorText(err), { title: t('dl.title'), parent: bw.win });
  if (d.state === 'progressing') {
    if (d.paused) actions.appendChild(act('play', t('dl.resume'), () => api.invoke('browser:downloadResume', d.id).catch(fail)));
    else actions.appendChild(act('pause', t('dl.pause'), () => api.invoke('browser:downloadPause', d.id).catch(fail)));
    actions.appendChild(act('dismiss', t('dl.cancel'), () => api.invoke('browser:downloadCancel', d.id).catch(fail)));
  } else if (d.state === 'completed') {
    actions.appendChild(act('folder_open', t('dl.showInFolder'), () => shared.showInFolder(d.path)));
    if (!compact) actions.appendChild(act('delete', t('dl.removeFromList'), () => shared.removeDownload(d.id)));
  } else {
    actions.appendChild(act('arrow_clockwise', t('dl.retry'), () => api.invoke('browser:downloadUrl', { partition: d.partition || bw.partition, url: d.url }).catch(fail)));
    actions.appendChild(act('delete', t('dl.removeFromList'), () => shared.removeDownload(d.id)));
  }
  const pct = d.total ? Math.min(100, (d.received / d.total) * 100) : 0;
  const progress =
    d.state === 'progressing'
      ? h('div', { class: ['progress', 'bw-dl-progress', !d.total && 'indeterminate', d.paused && 'paused'] }, h('div', { class: 'bar', style: { width: d.total ? `${pct}%` : '' } }))
      : null;
  const row = h(
    'div',
    {
      class: ['bw-dl-row', `state-${d.state}`, compact && 'compact'],
      dataset: { id: d.id },
      tabindex: '0',
      role: 'button',
      onclick: () => d.state === 'completed' && shared.openDownload(d, bw.win),
      onkeydown: (e) => e.key === 'Enter' && d.state === 'completed' && shared.openDownload(d, bw.win),
    },
    h('div', { class: 'bw-dl-icon' }, icon(ic, { size: 24 })),
    h(
      'div',
      { class: 'bw-dl-info' },
      h('div', { class: ['bw-dl-name ellipsis', d.state !== 'completed' && d.state !== 'progressing' && 'struck'] }, d.filename || displayUrl(d.url)),
      progress,
      h('div', { class: 'bw-dl-status caption ellipsis' }, downloadStatus(bw, d), !compact && d.url ? h('span', { class: 'bw-dl-src' }, ` · ${bareHost(d.url) || ''}`) : null),
    ),
    actions,
  );
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    ui.menu(
      e,
      [
        { label: t('dl.open'), icon: 'open', disabled: d.state !== 'completed', action: () => shared.openDownload(d, bw.win) },
        { label: t('dl.showInFolder'), icon: 'folder_open', disabled: d.state !== 'completed', action: () => shared.showInFolder(d.path) },
        '-',
        { label: t('ctx.copyLink'), icon: 'link', disabled: !d.url, action: () => api.invoke('clipboard:writeText', d.url).catch(() => {}) },
        { label: t('dl.retry'), icon: 'arrow_clockwise', disabled: d.state === 'progressing' || !d.url, action: () => api.invoke('browser:downloadUrl', { partition: d.partition || bw.partition, url: d.url }).catch(fail) },
        { label: t('dl.removeFromList'), icon: 'delete', disabled: d.state === 'progressing', action: () => shared.removeDownload(d.id) },
      ],
      menuOpts(bw),
    );
  });
  return row;
}

export async function siteInfo(bw, anchor) {
  const t = bw.t;
  const tab = bw.active;
  if (!tab) return;
  if (bw.flyout?.kind === 'site') return bw.closeFlyout();
  const url = bw.tabUrl(tab);
  const state = bw.omni.security(tab);
  const origin = originOf(url);
  const host = hostOf(url);
  const head = {
    secure: ['lock_closed', t('site.secure'), t('site.secureBody')],
    insecure: ['warning', t('site.insecure'), t('site.insecureBody')],
    local: ['info', t('site.local'), t('site.localBody')],
    danger: ['shield_error', t('site.danger'), t('site.dangerBody')],
    internal: ['shield_checkmark', t('site.internalTitle'), t('site.internalBody')],
    info: ['info', t('site.infoTitle'), t('site.infoBody')],
  }[state] || ['info', t('site.infoTitle'), ''];
  const perms = h('div', { class: 'bw-site-perms' });
  const content = h(
    'div',
    { class: 'bw-site-pop' },
    h('div', { class: 'bw-pop-title ellipsis' }, host || displayUrl(url)),
    h('div', { class: ['bw-site-state', state] }, icon(head[0], { size: 20 }), h('div', null, h('div', { class: 'body-strong' }, head[1]), h('div', { class: 'caption text-2' }, head[2]))),
    perms,
  );
  if (origin && isWebUrl(url)) {
    const saved = (await shared.api.invoke('browser:sitePermissions', bw.private ? bw.partition : undefined).catch(() => ({})))[origin] || {};
    const kinds = Object.keys(saved);
    if (kinds.length) {
      perms.appendChild(h('div', { class: 'bw-site-sub caption' }, t('site.permissions')));
      for (const k of kinds) {
        perms.appendChild(h('div', { class: 'bw-site-perm' }, icon(permIcon(k), { size: 16 }), h('span', { class: 'grow' }, t(`perm.kind.${k}`)), h('span', { class: ['caption', saved[k] === 'allow' ? 'ok' : 'no'] }, saved[k] === 'allow' ? t('perm.allowed') : t('perm.blocked'))));
      }
      perms.appendChild(
        h(
          'button',
          {
            class: 'btn small',
            onclick: async () => {
              await shared.api.invoke('browser:resetSitePermissions', origin, bw.private ? bw.partition : undefined).catch(() => {});
              bw.closeFlyout();
            },
          },
          t('site.resetPermissions'),
        ),
      );
    }
    content.appendChild(
      h(
        'button',
        {
          class: 'bw-site-link',
          onclick: async () => {
            const ok = await ui.confirm(t('site.clearConfirm', { host }), { title: t('site.clearData'), okLabel: t('settings.clearNow'), parent: bw.win });
            if (!ok) return;
            await shared.api.invoke('browser:clearData', { partition: bw.partition, cookies: true, origin }).catch((e) => ui.alert(shared.errorText(e), { title: t('site.clearData'), parent: bw.win }));
            bw.closeFlyout();
            bw.reload();
          },
        },
        icon('cookies', { size: 16 }),
        h('span', null, t('site.clearData')),
      ),
    );
  }
  const f = flyout({ host: bw.root, anchor, content, align: 'left', className: 'bw-pop', width: 340 });
  bw.setFlyout(f, 'site');
}

function permIcon(k) {
  return { camera: 'camera', microphone: 'mic', geolocation: 'location', notifications: 'alert', midi: 'music_note_2' }[k] || 'shield';
}

export function zoomFlyout(bw, anchor) {
  const t = bw.t;
  if (bw.flyout?.kind === 'zoom') return bw.closeFlyout();
  const pct = h('span', { class: 'bw-zoom-pct' });
  const upd = () => (pct.textContent = `${Math.round((bw.active?.zoom || 1) * 100)} %`);
  upd();
  const btn = (ic, label, fn) =>
    h(
      'button',
      {
        class: 'bw-tbtn small',
        'aria-label': label,
        'data-tip': label,
        onclick: () => {
          fn();
          upd();
          if (Math.abs((bw.active?.zoom || 1) - 1) < 0.001) bw.closeFlyout();
        },
      },
      icon(ic, { size: 16 }),
    );
  const content = h(
    'div',
    { class: 'bw-zoom-pop' },
    h('span', { class: 'label' }, t('zoom.label')),
    btn('subtract', t('zoom.out'), () => bw.zoom(-1)),
    pct,
    btn('add', t('zoom.in'), () => bw.zoom(1)),
    h(
      'button',
      {
        class: 'btn small',
        onclick: () => {
          bw.zoom(0);
          bw.closeFlyout();
        },
      },
      t('zoom.reset'),
    ),
  );
  const f = flyout({ host: bw.root, anchor, content, align: 'right', className: 'bw-pop' });
  bw.setFlyout(f, 'zoom');
}

export function permissionBubble(bw, tab, p) {
  const t = bw.t;
  const host = hostOf(p.origin) || p.origin;
  const reply = (allow, remember) => {
    tab.perms = tab.perms.filter((x) => x.id !== p.id);
    shared.api.invoke('browser:permissionReply', p.id, { allow, remember }).catch(() => {});
    f.permId = null;
    bw.closeFlyout();
    setTimeout(() => bw.showNextPermission(tab), 200);
  };
  const content = h(
    'div',
    { class: 'bw-perm-pop' },
    h(
      'div',
      { class: 'bw-pop-head' },
      h('div', { class: 'bw-pop-title' }, t('perm.wants', { host })),
      h('div', { class: 'grow' }),
      h('button', { class: 'bw-tbtn small', 'aria-label': t('common.close'), onclick: () => reply(false, false) }, icon('dismiss', { size: 14 })),
    ),
    ...(p.kinds || []).map((k) => h('div', { class: 'bw-perm-kind' }, icon(permIcon(k), { size: 18 }), h('span', null, t(`perm.ask.${k}`)))),
    h(
      'div',
      { class: 'bw-pop-actions' },
      h('button', { class: 'btn primary', onclick: () => reply(true, true) }, t('perm.allow')),
      h('button', { class: 'btn', onclick: () => reply(false, true) }, t('perm.block')),
    ),
  );
  const f = flyout({
    host: bw.root,
    anchor: bw.omni.siteBtn,
    content,
    align: 'left',
    className: 'bw-pop bw-perm',
    width: 340,
    onClose: () => {
      // Dismissed without a choice: deny for now, ask again next time.
      if (f.permId) {
        tab.perms = tab.perms.filter((x) => x.id !== p.id);
        shared.api.invoke('browser:permissionReply', p.id, { allow: false, remember: false }).catch(() => {});
      }
    },
  });
  f.permId = p.id;
  f.sticky = true;
  bw.setFlyout(f, 'permission');
  bw.flyout.permId = p.id;
}

// ================================================================== dialogs
export async function authDialog(bw, p, onHandle) {
  const t = bw.t;
  const user = h('input', { class: 'input', autocomplete: 'username', spellcheck: false });
  const pass = h('input', { class: 'input', type: 'password', autocomplete: 'current-password' });
  const body = h(
    'div',
    { class: 'bw-dialog-form' },
    h('p', { class: 'text-2 bw-wrap', style: { margin: '0 0 12px' } }, p.isProxy ? t('auth.proxyBody', { host: String(p.host || '').slice(0, 253) }) : t('auth.body', { host: String(p.host || '').slice(0, 253) })),
    // The realm is chosen by the server: shown as plain text, shortened.
    p.realm ? h('p', { class: 'caption text-2 bw-wrap', style: { margin: '0 0 12px' } }, t('auth.realm', { realm: String(p.realm).slice(0, 120) })) : null,
    h('div', { class: 'field' }, h('label', null, t('auth.user')), user),
    h('div', { class: 'field' }, h('label', null, t('auth.password')), pass),
  );
  const v = await ui.dialog({
    title: t('auth.title'),
    body,
    parent: bw.win,
    width: 420,
    buttons: [
      { label: t('auth.signIn'), value: 'ok', primary: true },
      { label: t('common.cancel'), value: null },
    ],
    onOpen: (_dlg, done) => {
      onHandle?.(done);
      setTimeout(() => user.focus(), 60);
    },
  });
  if (v !== 'ok') return null;
  return { username: user.value, password: pass.value };
}

/** alert / confirm / prompt from a web page, Edge style ("example.com says"). -> { ok, value, suppress } | null */
export async function jsDialog(bw, p, onHandle) {
  const t = bw.t;
  const host = (hostOf(p.origin) || p.origin || '').slice(0, 253);
  const text = String(p.message || '');
  const message = h('div', { class: 'bw-jsdlg-msg bw-wrap selectable' }, text.length > 2000 ? `${text.slice(0, 2000)}…` : text);
  const input = p.kind === 'prompt' ? h('input', { class: 'input', value: p.def || '', spellcheck: false, 'aria-label': text.slice(0, 200) || t('jsdlg.prompt') }) : null;
  const suppress = p.offerSuppress ? h('input', { type: 'checkbox' }) : null;
  const body = h(
    'div',
    { class: 'bw-dialog-form bw-jsdlg' },
    message,
    input ? h('div', { class: 'field', style: { marginTop: '12px' } }, input) : null,
    suppress ? h('label', { class: 'checkbox bw-check' }, suppress, h('span', null, t('jsdlg.suppress'))) : null,
  );
  const buttons = [{ label: t('common.ok'), value: 'ok', primary: true }];
  if (p.kind !== 'alert') buttons.push({ label: t('common.cancel'), value: null });
  const v = await ui.dialog({
    title: host ? t('jsdlg.says', { host }) : t('jsdlg.pageSays'),
    body,
    parent: bw.win,
    width: 440,
    buttons,
    onOpen: (dlg, done) => {
      onHandle?.(done);
      setTimeout(() => {
        if (input) {
          input.focus();
          input.select();
        } else dlg.querySelector('.dialog-footer .btn.primary')?.focus(); // OK, not the checkbox
      }, 40);
    },
  });
  return { ok: v === 'ok', value: input ? input.value : null, suppress: !!suppress?.checked };
}

export async function clearDataDialog(bw) {
  const t = bw.t;
  const check = (label, sub, checked) => {
    const input = h('input', { type: 'checkbox', checked });
    return { el: h('label', { class: 'checkbox bw-check' }, input, h('span', null, h('div', null, label), sub ? h('div', { class: 'caption text-2' }, sub) : null)), input };
  };
  const histCount = shared.store.history.size;
  const range = h(
    'select',
    { class: 'select' },
    [
      ['hour', t('clear.hour')],
      ['day', t('clear.day')],
      ['week', t('clear.week')],
      ['month', t('clear.month')],
      ['all', t('clear.all')],
    ].map(([v, l]) => h('option', { value: v, selected: v === 'all' }, l)),
  );
  const hist = check(t('clear.history'), t('clear.historySub', { count: histCount }), true);
  const dls = check(t('clear.downloads'), null, false);
  const cookies = check(t('clear.cookies'), t('clear.cookiesSub'), true);
  const cache = check(t('clear.cache'), t('clear.cacheSub'), true);
  const body = h(
    'div',
    { class: 'bw-dialog-form bw-clear' },
    h('div', { class: 'field' }, h('label', null, t('clear.range')), range),
    hist.el,
    dls.el,
    cookies.el,
    cache.el,
    bw.private ? h('p', { class: 'caption text-2' }, t('clear.privateNote')) : null,
  );
  const v = await ui.dialog({
    title: t('settings.clearData'),
    body,
    parent: bw.win,
    width: 440,
    buttons: [
      { label: t('settings.clearNow'), value: 'ok', primary: true },
      { label: t('common.cancel'), value: null },
    ],
  });
  if (v !== 'ok') return false;
  const since = { hour: 3600e3, day: 86400e3, week: 7 * 86400e3, month: 28 * 86400e3, all: 0 }[range.value];
  const cutoff = since ? Date.now() - since : 0;
  try {
    if (hist.input.checked) shared.store.clearHistory(cutoff);
    if (dls.input.checked) {
      for (const d of shared.downloadList()) if (d.state !== 'progressing' && (!cutoff || (d.startTime || 0) >= cutoff)) shared.downloads.delete(d.id);
      shared.store.downloads = shared.store.downloads.filter((d) => d.state === 'progressing' || (cutoff && (d.startTime || 0) < cutoff));
      shared.store.save('downloads', 100);
      shared.emit('downloads');
    }
    if (cookies.input.checked || cache.input.checked) {
      await shared.api.invoke('browser:clearData', { partition: bw.partition, cookies: cookies.input.checked, cache: cache.input.checked });
      if (bw.partition !== 'persist:browser' && !bw.private) await shared.api.invoke('browser:clearData', { partition: 'persist:browser', cookies: cookies.input.checked, cache: cache.input.checked });
    }
    if (!cutoff && cookies.input.checked && !bw.private) {
      shared.store.favicons.clear();
      shared.store.save('favicons', 100);
    }
    shared.shell.notify({ title: t('clear.doneTitle'), body: t('clear.doneBody'), appId: 'browser', icon: 'checkmark_circle', timeout: 4000 });
    return true;
  } catch (err) {
    ui.alert(shared.errorText(err), { title: t('settings.clearData'), parent: bw.win });
    return false;
  }
}

export { APP_ICON, isInternal };
