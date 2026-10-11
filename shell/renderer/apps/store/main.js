// Aurora Store — curated command-line tools and services (apt packages) to use from the Terminal.
// Catalog + installed state: main/ipc/store.js (store:catalog, store:installed). Install / remove: the
// elevation prompt, shell.runAdmin('store-install' | 'store-remove', [apt]), with APT progress lines on
// admin:progress. Graphical apps will come later (the shell cannot show external X11 windows yet).
//   shell.launch('store', { id: 'htop' })  opens a detail page ;  { view: 'installed' }  the Installed page
const CATEGORIES = ['development', 'editors', 'shells', 'system', 'utilities', 'multimedia', 'network'];
const CAT_ICON = { development: 'code', editors: 'document_edit', shells: 'window_console', system: 'gauge', utilities: 'toolbox', multimedia: 'video_clip', network: 'globe' };

/** APT status line -> { phase: 'download'|'install'|'error', percent, pkg, message } | null */
export function parseStatus(line) {
  const m = /^(dlstatus|pmstatus|pmerror):([^:]*):([0-9.]+)?:?(.*)$/.exec(String(line || ''));
  if (!m) return null;
  if (m[1] === 'pmerror') return { phase: 'error', percent: 0, pkg: m[2], message: m[4] || m[3] || '' };
  const p = Math.max(0, Math.min(100, Number(m[3]) || 0));
  return { phase: m[1] === 'dlstatus' ? 'download' : 'install', percent: p, pkg: m[1] === 'pmstatus' ? m[2] : '', message: m[4] };
}

export default {
  async launch(ctx) {
    const { win, h, icon, t, api } = ctx;
    let items = [];
    let installed = {};
    let loadError = false;
    let view = { kind: 'home' };
    const history = [];
    let query = '';
    // One apt operation at a time (dpkg lock): { apt, action, percent, step }
    let op = null;
    const errors = new Map(); // apt -> message of the last failure
    const lang = () => (ctx.lang === 'fr' ? 'fr' : 'en');
    const desc = (it) => it.description?.[lang()] || it.description?.en || '';
    const byId = (id) => items.find((i) => i.id === id);
    const isInstalled = (it) => Object.prototype.hasOwnProperty.call(installed, it.apt);

    // ------------------------------------------------------------------ layout
    const navEl = h('nav', { class: 'st-nav', 'aria-label': t('navLabel') });
    const searchInput = h('input', {
      class: 'input st-search-input',
      type: 'search',
      placeholder: t('searchPlaceholder'),
      'aria-label': t('searchPlaceholder'),
      spellcheck: false,
      oninput: () => {
        query = searchInput.value.trim();
        if (query && view.kind === 'detail') view = history.pop() || { kind: 'home' };
        render();
      },
      onkeydown: (e) => {
        if (e.key === 'Escape' && searchInput.value) {
          e.stopPropagation();
          searchInput.value = '';
          query = '';
          render();
        } else if (e.key === 'Enter') {
          content.querySelector('.st-card, .st-row-main')?.focus();
        }
      },
    });
    const header = h('div', { class: 'st-header' }, h('div', { class: 'search-box st-search' }, searchInput, icon('search')));
    const content = h('div', { class: 'st-content', tabindex: '-1' });
    const main = h('main', { class: 'st-main' }, header, content);
    const root = h('div', { class: 'st' }, navEl, main);
    win.body.appendChild(h('div', { class: 'st-wrap' }, root));

    // ------------------------------------------------------------------ data
    async function load() {
      try {
        const [cat, inst] = await Promise.all([api.invoke('store:catalog'), api.invoke('store:installed')]);
        items = Array.isArray(cat?.items) ? cat.items : [];
        installed = inst?.packages || {};
        loadError = false;
      } catch (e) {
        console.warn('store: load failed', e);
        loadError = true;
      }
    }
    async function refreshInstalled() {
      try {
        installed = (await api.invoke('store:installed'))?.packages || {};
      } catch {}
    }

    // ------------------------------------------------------------------ navigation
    function go(next, { push = true } = {}) {
      if (push && view && JSON.stringify(view) !== JSON.stringify(next)) history.push(view);
      view = next;
      if (next.kind !== 'detail' && query) {
        query = '';
        searchInput.value = '';
      }
      render();
      content.scrollTop = 0;
      if (next.kind === 'detail') content.querySelector('.st-back')?.focus();
      else if (!root.contains(document.activeElement)) content.focus();
    }
    function back() {
      if (!history.length) return false;
      const left = view.kind === 'detail' ? view.id : null;
      view = history.pop();
      render();
      const prev = left && content.querySelector(`button.st-card[data-id="${CSS.escape(left)}"], [data-id="${CSS.escape(left)}"] .st-row-main`);
      if (prev) prev.focus();
      else if (!root.contains(document.activeElement)) (content.querySelector('.st-card, .st-row-main') || content).focus();
      return true;
    }

    // ------------------------------------------------------------------ install / remove
    async function runOp(it, action) {
      if (op) return;
      op = { apt: it.apt, action, percent: 0, step: t(action === 'install' ? 'preparing' : 'preparingRemove') };
      errors.delete(it.apt);
      render();
      const adminAction = action === 'install' ? 'store-install' : 'store-remove';
      const off = api.on('admin:progress', ({ action: a, line }) => {
        if (a !== adminAction || !op) return;
        const s = parseStatus(line);
        if (!s || s.phase === 'error') return;
        // Downloads fill the first 40 %, unpacking/configuring the rest (removals are install-phase only).
        const pct = action === 'install' ? (s.phase === 'download' ? s.percent * 0.4 : 40 + s.percent * 0.6) : s.percent;
        op.percent = Math.max(op.percent, Math.round(pct));
        op.step = s.phase === 'download' ? t('downloading', { pct: Math.round(s.percent) }) : t(action === 'install' ? 'installingStep' : 'removingStep', { name: it.name });
        updateProgress();
      });
      try {
        await ctx.shell.runAdmin(adminAction, [it.apt], { reason: t(action === 'install' ? 'reasonInstall' : 'reasonRemove', { name: it.name, pkg: it.apt }), appId: 'store' });
        await refreshInstalled();
        if (win.closed) return;
        ctx.shell.notify({
          title: t(action === 'install' ? 'doneInstallTitle' : 'doneRemoveTitle', { name: it.name }),
          body: action === 'install' ? (it.command ? t('doneInstallBody', { cmd: it.command }) : t('doneInstallService')) : '',
          appId: 'store',
          silent: true,
        });
      } catch (e) {
        if (e?.code !== 'ECANCELED') errors.set(it.apt, e?.message || String(e));
        await refreshInstalled();
      } finally {
        off();
        op = null;
      }
      if (!win.closed) render();
    }

    function openTerminal(it) {
      const args = it.interactive && it.command ? { command: it.command } : {};
      ctx.shell.launch('terminal', args);
    }

    // ------------------------------------------------------------------ pieces
    function tile(it, size = '') {
      return h('div', { class: ['st-tile', `st-cat-${it.category}`, size], 'aria-hidden': 'true' }, icon(it.icon));
    }
    function statusChip(it) {
      if (op?.apt === it.apt) return h('span', { class: 'st-chip busy' }, h('span', { class: 'spinner small' }), t(op.action === 'install' ? 'installing' : 'removing'));
      if (isInstalled(it)) return h('span', { class: 'st-chip ok' }, icon('checkmark'), t('installed'));
      return h('span', { class: 'st-chip' }, t('free'));
    }
    function card(it) {
      return h(
        'button',
        { class: 'st-card', dataset: { id: it.id }, title: it.name, onclick: () => go({ kind: 'detail', id: it.id }) },
        tile(it),
        h('div', { class: 'st-card-text' }, h('div', { class: 'st-card-name' }, it.name), h('div', { class: 'st-card-cat caption' }, t(`cat.${it.category}`)), h('div', { class: 'st-card-desc' }, desc(it))),
        h('div', { class: 'st-card-foot' }, statusChip(it)),
      );
    }
    function grid(list, row = false) {
      return h('div', { class: ['st-grid', row && 'row'], role: 'list' }, list.map((it) => h('div', { role: 'listitem', class: 'st-grid-cell' }, card(it))));
    }
    function notice() {
      return h('div', { class: 'infobar st-notice' }, icon('info'), h('div', null, h('b', null, t('noticeTitle')), ' ', t('noticeBody')));
    }
    function empty(iconName, title, body) {
      return h('div', { class: 'empty st-empty' }, icon(iconName), h('div', { class: 'subtitle' }, title), body ? h('div', { class: 'text-2' }, body) : null);
    }

    function matches(it, q) {
      const hay = [it.name, it.apt, it.id, it.command, it.description?.en, it.description?.fr, t(`cat.${it.category}`)].join(' ').toLowerCase();
      return q
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean)
        .every((w) => hay.includes(w));
    }

    // ------------------------------------------------------------------ views
    function renderNav() {
      const navBtn = (key, ic, label, selected, onclick) =>
        h('button', { class: ['nav-item', 'st-nav-item', selected && 'selected'], dataset: { nav: key }, 'aria-current': selected ? 'page' : null, onclick }, icon(ic), h('span', { class: 'st-nav-label' }, label));
      const k = view.kind === 'detail' ? (history[history.length - 1] || { kind: 'home' }) : view;
      const sel = query ? '' : k.kind === 'category' ? `cat:${k.category}` : k.kind;
      const nInst = items.filter(isInstalled).length;
      navEl.replaceChildren(
        h('div', { class: 'st-brand' }, h('img', { src: ctx.appUrl('icon.svg'), alt: '' }), h('span', null, t('appName'))),
        navBtn('home', 'home', t('home'), sel === 'home', () => go({ kind: 'home' })),
        h('button', { class: ['nav-item', 'st-nav-item', sel === 'installed' && 'selected'], dataset: { nav: 'installed' }, 'aria-current': sel === 'installed' ? 'page' : null, onclick: () => go({ kind: 'installed' }) }, icon('apps_list'), h('span', { class: 'st-nav-label' }, t('installedNav')), nInst ? h('span', { class: 'st-count caption' }, String(nInst)) : null),
        h('div', { class: 'st-nav-sep caption' }, t('categories')),
        ...CATEGORIES.filter((c) => items.some((i) => i.category === c)).map((c) => navBtn(`cat:${c}`, CAT_ICON[c], t(`cat.${c}`), sel === `cat:${c}`, () => go({ kind: 'category', category: c }))),
      );
    }

    function renderHome() {
      const sections = CATEGORIES.map((c) => {
        const list = items.filter((i) => i.category === c);
        if (!list.length) return null;
        return h(
          'section',
          { class: 'st-section', dataset: { category: c } },
          h('div', { class: 'st-section-head' }, h('h2', { class: 'subtitle' }, t(`cat.${c}`)), h('button', { class: 'btn subtle st-see-all', onclick: () => go({ kind: 'category', category: c }) }, t('seeAll'), icon('chevron_right'))),
          grid(list.slice(0, 4), true),
        );
      });
      return [
        h('div', { class: 'st-hero' }, h('div', { class: 'st-hero-text' }, h('h1', { class: 'title' }, t('heroTitle')), h('div', { class: 'st-hero-sub' }, t('heroBody', { count: items.length }))), h('img', { class: 'st-hero-art', src: ctx.appUrl('icon.svg'), alt: '' })),
        notice(),
        sections,
      ];
    }

    function renderCategory(c) {
      const list = items.filter((i) => i.category === c);
      return [h('h1', { class: 'title st-page-title' }, t(`cat.${c}`)), h('div', { class: 'text-2 st-page-sub' }, t('appsCount', { count: list.length })), grid(list)];
    }

    function renderSearch() {
      // Name / package / command hits first, then description-only hits.
      const q = query.toLowerCase();
      const rank = (i) => ([i.name, i.apt, i.command].some((v) => String(v || '').toLowerCase().startsWith(q)) ? 0 : [i.name, i.apt, i.command].some((v) => String(v || '').toLowerCase().includes(q)) ? 1 : 2);
      const list = items.filter((i) => matches(i, query)).sort((a, b) => rank(a) - rank(b));
      return [
        h('h1', { class: 'title st-page-title' }, t('resultsFor', { q: query })),
        list.length ? [h('div', { class: 'text-2 st-page-sub' }, t('appsCount', { count: list.length })), grid(list)] : empty('search', t('noResults'), t('noResultsBody')),
      ];
    }

    function renderInstalled() {
      const list = items.filter(isInstalled);
      const rows = list.map((it) =>
        h(
          'div',
          { class: 'st-row card', dataset: { id: it.id } },
          h('button', { class: 'st-row-main', onclick: () => go({ kind: 'detail', id: it.id }), 'aria-label': it.name }, tile(it, 'small'), h('div', { class: 'st-row-text' }, h('div', { class: 'st-row-name' }, it.name), h('div', { class: 'caption text-2' }, `${it.apt} · ${installed[it.apt] || ''}`))),
          op?.apt === it.apt ? statusChip(it) : null,
          it.command ? h('button', { class: 'btn st-open', onclick: () => openTerminal(it) }, icon('window_console'), t('openTerminal')) : null,
          h('button', { class: 'btn subtle st-remove', disabled: !!op, 'aria-label': t('removeName', { name: it.name }), title: t('remove'), onclick: () => runOp(it, 'remove') }, icon('delete')),
        ),
      );
      return [h('h1', { class: 'title st-page-title' }, t('installedTitle')), h('div', { class: 'text-2 st-page-sub' }, t('installedSub')), list.length ? h('div', { class: 'st-rows' }, rows) : empty('apps_list', t('noneInstalled'), t('noneInstalledBody'))];
    }

    function renderDetail(it) {
      if (!it) return empty('error_circle', t('notFound'));
      const inst = isInstalled(it);
      const busy = op?.apt === it.apt;
      const actions = h('div', { class: 'st-actions' });
      if (busy) {
        actions.append(h('div', { class: 'st-progress-wrap' }, h('div', { class: 'progress st-progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(op.percent), 'aria-label': op.step }, h('div', { class: 'bar', style: { width: `${op.percent}%` } })), h('div', { class: 'caption text-2 st-step', 'aria-live': 'polite' }, op.step)));
      } else if (inst) {
        if (it.command) actions.append(h('button', { class: 'btn primary st-open', onclick: () => openTerminal(it) }, icon('window_console'), t('openTerminal')));
        actions.append(h('button', { class: 'btn st-remove', disabled: !!op, onclick: () => runOp(it, 'remove') }, t('remove')));
      } else {
        actions.append(h('button', { class: 'btn primary st-install', disabled: !!op, onclick: () => runOp(it, 'install') }, icon('arrow_download'), t('install')));
      }
      if (op && !busy) actions.append(h('span', { class: 'caption text-2 st-wait' }, t('waitOther')));
      const err = errors.get(it.apt);
      const info = [
        [t('package'), it.apt],
        [t('category'), t(`cat.${it.category}`)],
        [t('version'), inst ? installed[it.apt] || '—' : t('notInstalled')],
        [t('source'), t('sourceValue')],
      ];
      return [
        h('button', { class: 'btn subtle st-back', onclick: () => back() || go({ kind: 'home' }, { push: false }), 'aria-label': t('back') }, icon('arrow_left'), t('back')),
        h(
          'div',
          { class: 'st-detail-head card' },
          tile(it, 'large'),
          h('div', { class: 'st-detail-title' }, h('h1', { class: 'title' }, it.name), h('div', { class: 'text-2' }, t(`cat.${it.category}`), ' · ', h('code', null, it.apt)), inst && !busy ? h('div', { class: 'st-chip ok' }, icon('checkmark'), t('installed')) : null, actions),
        ),
        err ? h('div', { class: 'infobar error st-error', role: 'alert' }, icon('error_circle'), h('div', null, h('b', null, t('failed')), ' ', err)) : null,
        h('section', { class: 'st-section' }, h('h2', { class: 'subtitle' }, t('about')), h('p', { class: 'st-desc' }, desc(it))),
        it.command
          ? h('section', { class: 'st-section' }, h('h2', { class: 'subtitle' }, t('howTo')), h('p', { class: 'text-2' }, t(it.interactive ? 'howToInteractive' : 'howToCli')), h('pre', { class: 'st-cmd' }, it.interactive ? it.command : `${it.command} --help`))
          : h('section', { class: 'st-section' }, h('h2', { class: 'subtitle' }, t('howTo')), h('p', { class: 'text-2' }, t('howToService'))),
        h('section', { class: 'st-section' }, h('h2', { class: 'subtitle' }, t('information')), h('dl', { class: 'st-info card' }, info.map(([k, v]) => [h('dt', { class: 'text-2' }, k), h('dd', null, v)]))),
      ];
    }

    function updateProgress() {
      if (!op) return;
      const bar = content.querySelector('.st-progress');
      if (bar && view.kind === 'detail' && byId(view.id)?.apt === op.apt) {
        bar.firstChild.style.width = `${op.percent}%`;
        bar.setAttribute('aria-valuenow', String(op.percent));
        bar.setAttribute('aria-label', op.step);
        const step = content.querySelector('.st-step');
        if (step) step.textContent = op.step;
      }
    }

    function render() {
      if (win.closed) return;
      const hadFocus = content.contains(document.activeElement);
      const navFocus = navEl.contains(document.activeElement) ? document.activeElement.closest('[data-nav]')?.dataset.nav : null;
      const focusedId = hadFocus ? document.activeElement.closest('[data-id]')?.dataset.id : null;
      renderNav();
      let body;
      if (loadError) body = empty('error_circle', t('loadError'));
      else if (query && view.kind !== 'detail') body = renderSearch();
      else if (view.kind === 'detail') body = renderDetail(byId(view.id));
      else if (view.kind === 'installed') body = renderInstalled();
      else if (view.kind === 'category') body = renderCategory(view.category);
      else body = renderHome();
      content.replaceChildren(h('div', { class: 'st-page', dataset: { view: query && view.kind !== 'detail' ? 'search' : view.kind } }, body));
      win.setTitle(view.kind === 'detail' && byId(view.id) ? `${byId(view.id).name} - ${t('appName')}` : t('appName'));
      // Keep keyboard focus on the same card / row after a re-render (install state changes).
      if (focusedId) content.querySelector(`button[data-id="${CSS.escape(focusedId)}"], [data-id="${CSS.escape(focusedId)}"] .st-row-main`)?.focus();
      else if (view.kind === 'detail' && hadFocus && !root.contains(document.activeElement)) content.querySelector('.st-actions .btn:not([disabled]), .st-back')?.focus();
      if (navFocus) navEl.querySelector(`[data-nav="${CSS.escape(navFocus)}"]`)?.focus();
      if (hadFocus && !root.contains(document.activeElement)) content.focus();
    }

    // ------------------------------------------------------------------ keyboard
    root.addEventListener('keydown', (e) => {
      const inField = e.target.closest('input, textarea');
      if ((e.ctrlKey && (e.key === 'f' || e.key === 'e')) || (e.key === '/' && !inField)) {
        e.preventDefault();
        searchInput.focus();
        searchInput.select();
      } else if ((e.altKey && e.key === 'ArrowLeft') || (e.key === 'Backspace' && !inField) || (e.key === 'Escape' && !inField && view.kind === 'detail')) {
        if (back()) e.preventDefault();
      } else if (e.key === 'F5') {
        e.preventDefault();
        load().then(render);
      }
    });
    const offLang = ctx.onLangChange?.(() => {
      searchInput.placeholder = t('searchPlaceholder');
      searchInput.setAttribute('aria-label', t('searchPlaceholder'));
      navEl.setAttribute('aria-label', t('navLabel'));
      render();
    });
    const offDev = api.on('admin:devChanged', ({ what } = {}) => {
      if (what === 'store' && !op) refreshInstalled().then(render);
    });
    win.on('close', () => offDev?.());
    void offLang;

    content.append(h('div', { class: 'st-loading' }, h('div', { class: 'spinner' })));
    await load();
    const a = ctx.args && typeof ctx.args === 'object' ? ctx.args : {};
    if (typeof a.id === 'string' && byId(a.id)) view = { kind: 'detail', id: a.id };
    else if (a.view === 'installed') view = { kind: 'installed' };
    render();
    setTimeout(() => (view.kind === 'detail' ? content.querySelector('.st-actions .btn') : searchInput)?.focus(), 50);

    return {
      onRelaunch(args) {
        if (args && typeof args.id === 'string' && byId(args.id)) go({ kind: 'detail', id: args.id });
        else if (args?.view === 'installed') go({ kind: 'installed' });
        win.focus();
      },
      get state() {
        return { view, query, op, installed, count: items.length };
      },
    };
  },
};
