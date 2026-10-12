// Paramètres (Settings).
//   shell.launch('settings', { page, section })   deep link (see lib/index.js for page ids and aliases)
// Layout: two panes. Left: "Find a setting", then the categories grouped under small headings, and the
// account as a small row at the bottom. Right: the parent pages as a small line above the page title, then
// the scrolling content. Pages live in pages/<module>.js: `export default { pageId: async (pc) => Node }`.
import { NAV_GROUPS, NAV_ACCOUNT, PAGES, resolvePage, crumbs, categoryOf, searchIndex } from './lib/index.js';
import { createKit } from './lib/kit.js';

const MODULES = {
  system: () => import('./pages/system.js'),
  devices: () => import('./pages/devices.js'),
  network: () => import('./pages/network.js'),
  personalization: () => import('./pages/personalization.js'),
  // personalization areas (docs/PERSONALIZATION.md): A = designer; B1 = wallpaper; B2 = taskbar + focus; B3 = packs + input
  'personalization-designer': () => import('./pages/personalization-designer.js'),
  'personalization-taskbar': () => import('./pages/personalization-taskbar.js'),
  'personalization-wallpaper': () => import('./pages/personalization-wallpaper.js'),
  'personalization-focus': () => import('./pages/personalization-focus.js'),
  'personalization-packs': () => import('./pages/personalization-packs.js'),
  'personalization-input': () => import('./pages/personalization-input.js'),
  apps: () => import('./pages/apps.js'),
  accounts: () => import('./pages/accounts.js'),
  time: () => import('./pages/time.js'),
  accessibility: () => import('./pages/accessibility.js'),
  privacy: () => import('./pages/privacy.js'),
  update: () => import('./pages/update.js'),
};

const NAV_ICONS = {
  system: 'desktop_tower',
  personalization: 'paint_brush',
  display: 'desktop',
  network: 'globe',
  bluetooth: 'bluetooth',
  sound: 'speaker_2',
  apps: 'apps_list',
  timeLanguage: 'local_language',
  accessibility: 'accessibility',
  privacy: 'shield',
  update: 'arrow_sync',
  about: 'info',
};

export default {
  async launch(ctx) {
    const { win, h, icon, ui, t, api, shell, settings, i18n } = ctx;
    const lang = () => i18n.lang;
    const L = (obj) => i18n.name(obj);

    // ---------------------------------------------------------------- page context
    let disposers = [];
    const globalDisposers = [];
    const pc = {
      ctx,
      h,
      icon,
      ui,
      t,
      api,
      shell,
      settings,
      i18n,
      env: ctx.env,
      win,
      storage: ctx.storage,
      section: null,
      get lang() {
        return i18n.lang;
      },
      L,
      go: (page, section) => navigate(page, { section }),
      back: () => goBack(),
      refresh: () => navigate(current.page, { section: null, push: false, animate: false, keepScroll: true }),
      onDispose: (fn) => typeof fn === 'function' && disposers.push(fn),
      on: (channel, fn) => disposers.push(api.on(channel, fn)),
      every: (ms, fn) => {
        const id = setInterval(fn, ms);
        disposers.push(() => clearInterval(id));
        return id;
      },
      toastError,
      toast,
      fmtSize: (b) => i18n.formatSize(b),
      // Largest display scale (%) that still leaves a usable desktop: at least 800 × 500 effective pixels.
      maxScale: () => {
        const z = (Number(settings.get('scale')) || 100) / 100;
        const w = window.innerWidth * z;
        const hh = window.innerHeight * z;
        return Math.max(100, Math.floor((Math.min(w / 800, hh / 500) * 100) / 5) * 5);
      },
      fmtNum: (n, o) => i18n.formatNumber(n, o),
      pageTitle: (id) => L(PAGES[id]?.title) || id,
      async adminStatus(force) {
        if (!adminCache || force) adminCache = api.invoke('admin:status').catch(() => ({ isAdmin: false, needsPassword: true, live: !!ctx.env.live }));
        return adminCache;
      },
      // Elevated action with the UAC prompt; resolves to stdout, rejects (code ECANCELED when dismissed).
      runAdmin: (action, args = [], reasonKey, vars) => shell.runAdmin(action, args, { reason: reasonKey ? t(reasonKey, vars) : undefined, appId: 'settings' }),
      // invoke() that resolves to null when the backend channel does not exist (ENOHANDLER) or fails.
      tryInvoke: async (channel, ...args) => {
        try {
          return await api.invoke(channel, ...args);
        } catch (err) {
          // missing backend / tool (a page shows its own "not available" state): not worth a warning
          if (!['ENOHANDLER', 'ENOENT', 'ENOTSUP'].includes(err.code) && !/ENOENT/.test(err.message)) console.warn(`[settings] ${channel}:`, err.message);
          return null;
        }
      },
    };
    let adminCache = null;
    const kit = createKit(pc);
    pc.kit = kit;

    // ---------------------------------------------------------------- layout
    const avatar = h('div', { class: 'st-avatar', 'aria-hidden': 'true' });
    const userName = h('div', { class: 'st-user-name ellipsis' });
    const userKind = h('div', { class: 'st-user-kind caption ellipsis' });
    // The account: a small row at the bottom of the pane. It is the "accounts" category of the navigation
    // (same keyboard list, selected on the account pages).
    const userCard = h(
      'button',
      {
        class: 'st-user nav-item st-nav-item',
        type: 'button',
        dataset: { page: NAV_ACCOUNT, cat: NAV_ACCOUNT },
        onclick: () => {
          setPaneOpen(false);
          navigate(NAV_ACCOUNT);
        },
      },
      avatar,
      h('div', { class: 'st-user-text' }, userName, userKind),
    );
    const searchInput = h('input', { class: 'input', type: 'search', autocomplete: 'off', spellcheck: false, 'aria-label': t('settings.findSetting'), placeholder: t('settings.findSetting') });
    const suggest = h('div', { class: 'st-suggest menu', role: 'listbox', hidden: true });
    const searchBox = h('div', { class: 'st-search search-box' }, searchInput, icon('search', { size: 16 }), suggest);
    const nav = h('nav', { class: 'st-nav nav', 'aria-label': t('settings.navigation') });
    const pane = h('aside', { class: 'st-pane' }, searchBox, nav, h('div', { class: 'st-pane-foot' }, userCard));
    const titleEl = h('h1', { class: 'st-title' });
    const crumbsEl = h('nav', { class: 'st-crumbs', 'aria-label': t('settings.navigation'), hidden: true });
    const header = h('header', { class: 'st-header' }, crumbsEl, titleEl);
    const errorHost = h('div', { class: 'st-errors' });
    const content = h('div', { class: 'st-content' });
    const scroller = h('div', { class: 'st-scroll', tabindex: '-1' }, h('div', { class: 'st-content-wrap' }, errorHost, content));
    const main = h('main', { class: 'st-main' }, header, scroller);
    const scrim = h('div', { class: 'st-scrim', onclick: () => setPaneOpen(false) });
    const root = h('div', { class: 'st-root' }, pane, main, scrim);
    win.body.appendChild(root);

    // Title bar: back arrow (and the nav button when the window is narrow).
    const backBtn = h('button', { class: 'st-tb-btn st-tb-back', type: 'button', 'aria-label': t('common.back'), 'data-tip': t('common.back'), disabled: true, onclick: () => goBack() }, icon('arrow_left', { size: 16 }));
    const menuBtn = h('button', { class: 'st-tb-btn st-tb-menu', type: 'button', 'aria-label': t('settings.navigation'), onclick: () => setPaneOpen(!root.classList.contains('pane-open')) }, icon('line_horizontal_3', { size: 16 }));
    const tbHost = win.titlebar || win.el?.querySelector('.win-titlebar');
    if (tbHost && win.iconEl) {
      tbHost.insertBefore(backBtn, win.iconEl);
      tbHost.insertBefore(menuBtn, win.iconEl);
    } else win.titlebarSlot?.append(backBtn, menuBtn);

    function setPaneOpen(open) {
      root.classList.toggle('pane-open', !!open);
      if (open) setTimeout(() => pane.querySelector('.st-nav-item.selected')?.focus(), 50);
    }
    const ro = new ResizeObserver(() => {
      const compact = win.body.clientWidth < 860;
      root.classList.toggle('compact', compact);
      if (!compact) root.classList.remove('pane-open');
    });
    ro.observe(win.body);
    globalDisposers.push(() => ro.disconnect());

    // ---------------------------------------------------------------- nav
    function navButton(id) {
      return h(
        'button',
        {
          class: 'nav-item st-nav-item',
          type: 'button',
          dataset: { page: id, cat: id },
          onclick: () => {
            setPaneOpen(false);
            navigate(id);
          },
        },
        h('span', { class: 'st-nav-icon' }, icon(NAV_ICONS[id] || PAGES[id].icon, { size: 18 })),
        h('span', { class: 'ellipsis' }, L(PAGES[id].title)),
      );
    }
    const navItems = () => [...pane.querySelectorAll('.st-nav-item')];
    function buildNav() {
      ui.clear(nav);
      for (const g of NAV_GROUPS) {
        const headId = `st-nav-h-${g.id}`;
        nav.appendChild(
          h(
            'div',
            { class: 'st-nav-group', role: 'group', 'aria-labelledby': g.title ? headId : null },
            g.title ? h('h2', { class: 'st-nav-heading', id: headId }, L(g.title)) : null,
            g.items.map(navButton),
          ),
        );
      }
      // One tab stop for the whole list (the selected category, the account row included); arrow keys,
      // Home and End move between categories, Enter / Space opens one.
      pane.onkeydown = (e) => {
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
        const items = navItems();
        const i = items.indexOf(document.activeElement);
        if (i < 0) return;
        const n = e.key === 'Home' ? items[0] : e.key === 'End' ? items[items.length - 1] : items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length];
        e.preventDefault();
        if (!n) return;
        for (const el of items) el.tabIndex = el === n ? 0 : -1;
        n.focus();
        n.scrollIntoView({ block: 'nearest' });
      };
      pane.onfocusout = (e) => {
        if (!navItems().includes(e.relatedTarget)) rovingReset();
      };
      rovingReset();
    }
    function rovingReset() {
      const items = navItems();
      const sel = items.find((el) => el.classList.contains('selected')) || items[0];
      for (const el of items) el.tabIndex = el === sel ? 0 : -1;
    }
    function markNav(page) {
      const cat = page === 'search' ? null : categoryOf(page);
      for (const el of navItems()) {
        const on = el.dataset.cat === cat;
        el.classList.toggle('selected', on);
        if (on) {
          el.setAttribute('aria-current', 'page');
          // keep the current category visible in a short window (À propos sits under the fold at 720 px)
          // (scrolls only the nav list, never an overflow:hidden ancestor of the window)
          const box = el.closest('.st-nav');
          if (box) {
            const r = el.getBoundingClientRect();
            const b = box.getBoundingClientRect();
            if (r.bottom > b.bottom) box.scrollTop += r.bottom - b.bottom + 4;
            else if (r.top < b.top) box.scrollTop -= b.top - r.top + 4;
          }
        } else el.removeAttribute('aria-current');
      }
      if (!navItems().includes(document.activeElement)) rovingReset();
    }

    // ---------------------------------------------------------------- account card
    async function loadUser() {
      const u = await pc.tryInvoke('users:current');
      const st = await pc.adminStatus();
      const name = u?.fullName || u?.name || ctx.env.user;
      userName.textContent = name;
      userKind.textContent = `${t('settings.localAccount')}${st?.isAdmin ? ` · ${t('settings.administrator')}` : ''}`;
      paintAvatar(avatar, u, 32);
    }
    function paintAvatar(el, u, size) {
      ui.clear(el);
      el.style.setProperty('--size', `${size}px`);
      if (u?.picture) {
        el.appendChild(h('img', { src: `${api.mediaUrl(u.picture)}?v=${Date.now()}`, alt: '', draggable: false, onerror: (e) => e.target.replaceWith(initialsOf(u)) }));
      } else el.appendChild(initialsOf(u));
    }
    pc.paintAvatar = paintAvatar;
    function initialsOf(u) {
      // first letter of the first and last words, ignoring punctuation and symbols ("<b>Ann</b>" -> "A")
      const parts = String(u?.fullName || u?.name || '')
        .split(/\s+/)
        .map((w) => w.match(/[\p{L}\p{N}]/u)?.[0])
        .filter(Boolean);
      if (!parts.length) return icon('person', { size: 28, filled: true });
      return h('span', { class: 'st-initials' }, (parts[0] + (parts.length > 1 ? parts[parts.length - 1] : '')).toUpperCase());
    }
    globalDisposers.push(
      api.on('users:changed', () => {
        adminCache = null;
        loadUser();
      }),
    );

    // ---------------------------------------------------------------- errors / toasts
    function toast(message, kind = 'success') {
      const bar = kit.infobar({ kind, message, action: h('button', { class: 'btn subtle icon-btn small', 'aria-label': t('common.close'), onclick: () => bar.remove() }, icon('dismiss', { size: 12 })) });
      errorHost.appendChild(bar);
      scroller.scrollTo({ top: 0, behavior: 'smooth' });
      setTimeout(() => bar.isConnected && bar.remove(), kind === 'error' ? 12000 : 5000);
      return bar;
    }
    function toastError(err) {
      if (!err || err.code === 'ECANCELED') return;
      console.warn('[settings]', err);
      // sudo refused the account (not an administrator): say so instead of the raw backend message
      if (err.code === 'ENOTADMIN') return toast(t('settings.notAdminError'), 'error');
      return toast(t('settings.errorGeneric', { msg: err.message || String(err) }), 'error');
    }

    // ---------------------------------------------------------------- router
    let current = null;
    const history = [];
    let navSeq = 0;

    // Page title (Manrope) with its parent pages as a small line of links above it.
    function renderTitle(page) {
      ui.clear(titleEl);
      ui.clear(crumbsEl);
      if (page === 'search') {
        crumbsEl.hidden = true;
        titleEl.appendChild(h('span', { class: 'st-crumb current' }, t('settings.searchResultsFor', { q: lastQuery })));
        return;
      }
      const chain = crumbs(page);
      const parents = chain.slice(0, -1);
      crumbsEl.hidden = !parents.length;
      parents.forEach((id, i) => {
        if (i > 0) crumbsEl.appendChild(h('span', { class: 'st-crumb-sep', 'aria-hidden': 'true' }, '/'));
        crumbsEl.appendChild(h('button', { class: 'st-crumb', type: 'button', onclick: () => navigate(id) }, L(PAGES[id].title)));
      });
      titleEl.appendChild(h('span', { class: 'st-crumb current', 'aria-current': 'page' }, L(PAGES[page].title)));
    }

    async function navigate(page, { section = null, push = true, animate = true, keepScroll = false } = {}) {
      const r = page === 'search' ? { page: 'search', section: null } : resolvePage(page, section);
      if (push && current && (current.page !== r.page || r.page === 'search')) {
        history.push(current);
        if (history.length > 50) history.shift();
      }
      backBtn.disabled = history.length === 0;
      const prevScroll = scroller.scrollTop;
      current = r;
      for (const fn of disposers.splice(0)) {
        try {
          fn();
        } catch {}
      }
      ui.closeMenus?.();
      pc.section = r.section;
      markNav(r.page);
      renderTitle(r.page);
      win.setTitle?.(r.page === 'system' || r.page === 'search' ? t('settings.appName') : `${t('settings.appName')} – ${L(PAGES[r.page]?.title)}`);
      const token = ++navSeq;
      const pageEl = h('div', { class: 'st-page', dataset: { page: r.page } });
      const spinTimer = setTimeout(() => token === navSeq && content.replaceChildren(kit.spinnerRow()), 180);
      try {
        let node;
        if (r.page === 'search') node = renderSearchPage();
        else {
          const mod = await MODULES[PAGES[r.page].module]();
          const fn = mod.default[r.page];
          if (typeof fn !== 'function') throw new Error(`Page ${r.page} is missing`);
          node = await fn(pc);
        }
        if (token !== navSeq) return;
        pageEl.append(node);
      } catch (err) {
        console.error('[settings] page failed', err);
        if (token !== navSeq) return;
        pageEl.append(kit.infobar({ kind: 'error', title: t('settings.pageError'), message: err.message }));
      } finally {
        clearTimeout(spinTimer);
      }
      errorHost.replaceChildren();
      const focusWasInPage = content.contains(document.activeElement) || errorHost.contains(document.activeElement);
      content.replaceChildren(pageEl);
      // The control that had the focus is gone (or nothing in the window had it, e.g. a deep link):
      // put the keyboard on the page, so Tab goes to its first control and Alt+Left / Ctrl+F work.
      const outside = !(win.el || root).contains(document.activeElement);
      if (focusWasInPage || (outside && shell.wm?.focused?.() === win && !document.querySelector('.dialog-layer:not(.closing)'))) scroller.focus({ preventScroll: true });
      if (keepScroll) scroller.scrollTop = prevScroll;
      else scroller.scrollTop = 0;
      if (animate && !kit.reduceMotion()) {
        pageEl.animate([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 180, easing: 'ease-out' });
        titleEl.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 150, easing: 'ease-out' });
      }
      if (r.section) revealSection(r.section);
    }

    function revealSection(section) {
      requestAnimationFrame(() => {
        const el = content.querySelector(`[data-section="${CSS.escape(section)}"]`);
        if (!el) return;
        el.scrollIntoView({ block: 'center', behavior: kit.reduceMotion() ? 'auto' : 'smooth' });
        if (el.classList.contains('st-expander') && el.toggle) el.toggle(true);
        el.classList.remove('st-flash');
        void el.offsetWidth;
        el.classList.add('st-flash');
        setTimeout(() => el.classList.remove('st-flash'), 2200);
      });
    }

    function goBack() {
      const prev = history.pop();
      backBtn.disabled = history.length === 0;
      if (prev) navigate(prev.page === 'search' ? 'search' : prev.page, { section: null, push: false });
    }
    win.el?.addEventListener('keydown', (e) => {
      if ((e.altKey && e.key === 'ArrowLeft') || (e.key === 'BrowserBack')) {
        e.preventDefault();
        goBack();
      } else if (e.key === 'Escape' && root.classList.contains('pane-open')) {
        setPaneOpen(false);
      } else if ((e.ctrlKey && e.key.toLowerCase() === 'f') || (e.ctrlKey && e.key.toLowerCase() === 'e')) {
        e.preventDefault();
        if (root.classList.contains('compact')) setPaneOpen(true);
        searchInput.focus();
        searchInput.select();
      }
    });

    // ---------------------------------------------------------------- search
    let lastQuery = '';
    let results = [];
    let active = -1;
    function parentLabel(e) {
      const chain = crumbs(e.page);
      const labels = chain.map((id) => L(PAGES[id].title));
      if (e.section && labels[labels.length - 1] === L(e.name)) labels.pop();
      return labels.join(' › ');
    }
    function renderSuggest() {
      ui.clear(suggest);
      const q = searchInput.value.trim();
      if (!q) {
        suggest.hidden = true;
        return;
      }
      results = searchIndex(q, lang(), 8);
      if (!results.length) suggest.appendChild(h('div', { class: 'st-suggest-empty caption text-2' }, t('settings.noResults')));
      results.forEach((e, i) => {
        suggest.appendChild(
          h(
            'div',
            {
              class: ['menu-item', 'st-suggest-item', i === active && 'active'],
              role: 'option',
              'aria-selected': String(i === active),
              onpointerdown: (ev) => ev.preventDefault(),
              onclick: () => openResult(e),
            },
            icon(e.icon, { size: 16 }),
            h('span', { class: 'st-suggest-text' }, h('span', { class: 'ellipsis' }, L(e.name)), h('span', { class: 'caption text-2 ellipsis' }, parentLabel(e))),
          ),
        );
      });
      suggest.hidden = false;
    }
    function openResult(e) {
      suggest.hidden = true;
      searchInput.blur();
      setPaneOpen(false);
      navigate(e.page, { section: e.section });
    }
    searchInput.addEventListener('input', () => {
      active = -1;
      renderSuggest();
    });
    searchInput.addEventListener('focus', () => searchInput.value.trim() && renderSuggest());
    searchInput.addEventListener('blur', () => setTimeout(() => (suggest.hidden = true), 120));
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!results.length) return;
        e.preventDefault();
        active = (active + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
        renderSuggest();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const q = searchInput.value.trim();
        if (!q) return;
        if (active >= 0 && results[active]) openResult(results[active]);
        else {
          lastQuery = q;
          suggest.hidden = true;
          setPaneOpen(false);
          navigate('search');
        }
      } else if (e.key === 'Escape') {
        if (searchInput.value) {
          e.stopPropagation();
          searchInput.value = '';
          renderSuggest();
        }
      }
    });
    function renderSearchPage() {
      const list = searchIndex(lastQuery, lang(), 40);
      if (!list.length) {
        return h('div', { class: 'st-empty' }, icon('search', { size: 40 }), h('div', { class: 'body-large' }, t('settings.noResultsFor', { q: lastQuery })), h('div', { class: 'text-2' }, t('settings.noResultsHint')));
      }
      return kit.group(null, ...list.map((e) => kit.row({ icon: e.icon, title: L(e.name), desc: parentLabel(e), onClick: () => navigate(e.page, { section: e.section }) })));
    }

    // ---------------------------------------------------------------- language switch
    ctx.onLangChange(() => {
      searchInput.placeholder = t('settings.findSetting');
      searchInput.setAttribute('aria-label', t('settings.findSetting'));
      crumbsEl.setAttribute('aria-label', t('settings.navigation'));
      backBtn.setAttribute('aria-label', t('common.back'));
      backBtn.dataset.tip = t('common.back');
      buildNav();
      loadUser();
      if (current) navigate(current.page, { section: null, push: false, animate: false, keepScroll: true });
    });

    win.on('close', () => {
      for (const fn of [...disposers.splice(0), ...globalDisposers.splice(0)]) {
        try {
          fn();
        } catch {}
      }
      backBtn.remove();
      menuBtn.remove();
    });

    // Dev builds simulate the system (admin actions, users…): refresh the visible page when it changes.
    globalDisposers.push(
      api.on('admin:devChanged', () => {
        adminCache = null;
      }),
    );

    buildNav();
    loadUser();
    await navigate(ctx.args?.page || 'system', { section: ctx.args?.section, push: false });

    return {
      onRelaunch(args) {
        if (args?.page) navigate(args.page, { section: args.section });
      },
      navigate: (page, section) => navigate(page, { section }),
    };
  },
};
