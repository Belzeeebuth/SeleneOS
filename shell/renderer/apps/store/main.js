// Selene Store — one catalogue merged from three sources (docs/STORE-SOURCES.md): Selene picks (curated apt
// packages), Ubuntu (every desktop app of the archive, apt) and Flathub (flatpak --user).
// Backend: main/ipc/store.js (store:home, store:search, store:details, store:installedAll, store:sources,
// store:refresh, store:setEnabled, store:install / store:remove for Flathub, store:cancel (« Annuler » while a Flathub
// install runs), store:current (an operation started before this window opened); +store:progress, +store:changed).
// Mises à jour (view 'updates'): store:updates / store:checkUpdates (+store:updates), store:update per app,
// « Tout mettre à jour » = one store:update after the other (« Annuler » stops the current one and the rest);
// the nav entry shows the number of pending updates. store:lastCancel says whether a cancelled install was
// fully undone (otherwise the notice says so instead of « Rien n'a été modifié »).
// apt sources (selene, ubuntu) install through the elevation prompt: shell.runAdmin('store-install' |
// 'store-remove', [apt]), with APT progress lines on admin:progress. Installed graphical apps open as Linux apps
// through the registry ('linux.<desktop id>', kind 'linux').
//   shell.launch('store', { id: 'org.gimp.GIMP' })  opens a detail page (merged key, appId or curated id);
//   { view: 'installed' | 'sources' | 'categories' | 'updates' }  opens that page;  { query: 'gimp' }  searches
const SOURCES = ['selene', 'ubuntu', 'flathub'];
const ADMIN = new Set(['selene', 'ubuntu']);
const CATS = ['AudioVideo', 'Development', 'Education', 'Game', 'Graphics', 'Network', 'Office', 'Science', 'Settings', 'System', 'Utility'];
const CAT_ICON = { AudioVideo: 'video_clip', Development: 'code', Education: 'hat_graduation', Game: 'games', Graphics: 'paint_brush', Network: 'globe', Office: 'document', Science: 'beaker', Settings: 'settings', System: 'gauge', Utility: 'toolbox' };
const PAGE = 24;

/** APT status line -> { phase: 'download'|'install'|'error', percent, pkg, message } | null */
export function parseStatus(line) {
  const m = /^(dlstatus|pmstatus|pmerror):([^:]*):([0-9.]+)?:?(.*)$/.exec(String(line || ''));
  if (!m) return null;
  if (m[1] === 'pmerror') return { phase: 'error', percent: 0, pkg: m[2], message: m[4] || m[3] || '' };
  const p = Math.max(0, Math.min(100, Number(m[3]) || 0));
  return { phase: m[1] === 'dlstatus' ? 'download' : 'install', percent: p, pkg: m[1] === 'pmstatus' ? m[2] : '', message: m[4] };
}

/** Bytes -> '12.5 MB' (locale decimal separator). */
export function formatSize(bytes, lang = 'en') {
  const n = Number(bytes);
  if (!(n > 0)) return '';
  const units = lang === 'fr' ? ['o', 'Ko', 'Mo', 'Go'] : ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) (v /= 1024), i++;
  return `${v.toLocaleString(lang === 'fr' ? 'fr-FR' : 'en-US', { maximumFractionDigits: v < 10 && i ? 1 : 0 })} ${units[i]}`;
}

const linuxIdOf = (desktopId) => (desktopId ? `linux.${String(desktopId).replace(/\.desktop$/, '').replace(/[^A-Za-z0-9._-]/g, '_')}`.slice(0, 64) : '');

export default {
  async launch(ctx) {
    const { win, h, icon, t, api } = ctx;
    const lang = () => (ctx.lang === 'fr' ? 'fr' : 'en');
    let sources = [];
    let live = false;
    let home = null;
    let installedList = [];
    let loadError = '';
    let view = { kind: 'home' };
    const history = [];
    let query = '';
    let list = null; // { sig, items, total, loading, error }
    let detail = null; // { key, source, data, loading, error }
    let op = null; // { key, source, id, action, percent, step, cancelable, canceling, adopted }
    const errors = new Map(); // key -> message of the last failure
    const notices = new Map(); // key -> message of a cancelled operation (« … annulée »)
    const refreshPct = new Map(); // source -> percent while its catalogue is refreshed
    const refreshErr = new Map();
    let searchTimer = 0;
    let listSeq = 0;
    let updates = { items: [], count: 0, checkedAt: null, checking: false, error: null, errorCode: null };
    let batch = null; // { total, done, canceled } while « Tout mettre à jour » runs

    const srcLabel = (id) => t(`src.${id}`);
    const catLabel = (c) => t(`cat.${c}`);
    const isBusy = (e) => op && op.key === e.key;

    // ------------------------------------------------------------------ layout
    const navEl = h('nav', { class: 'st-nav', 'aria-label': t('navLabel') });
    const searchInput = h('input', {
      class: 'input st-search-input',
      type: 'search',
      placeholder: t('searchPlaceholder'),
      'aria-label': t('searchPlaceholder'),
      spellcheck: false,
      oninput: () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
          const q = searchInput.value.trim();
          if (q === query) return;
          query = q;
          if (q) {
            if (view.kind !== 'search') history.push(view);
            view = { kind: 'search' };
            loadList(true);
          } else if (view.kind === 'search') {
            view = history.pop() || { kind: 'home' };
            render();
          }
        }, 250);
      },
      onkeydown: (e) => {
        if (e.key === 'Escape' && searchInput.value) {
          e.stopPropagation();
          searchInput.value = '';
          clearTimeout(searchTimer);
          if (query) {
            query = '';
            if (view.kind === 'search') view = history.pop() || { kind: 'home' };
            render();
          }
        } else if (e.key === 'Enter') {
          clearTimeout(searchTimer);
          const q = searchInput.value.trim();
          if (q && q !== query) {
            query = q;
            if (view.kind !== 'search') history.push(view);
            view = { kind: 'search' };
            loadList(true).then(() => content.querySelector('.st-card')?.focus());
          } else content.querySelector('.st-card, .st-row-main')?.focus();
        }
      },
    });
    const header = h('div', { class: 'st-header' }, h('div', { class: 'search-box st-search' }, searchInput, icon('search')));
    const content = h('div', { class: 'st-content', tabindex: '-1' });
    const main = h('main', { class: 'st-main' }, header, content);
    const root = h('div', { class: 'st' }, navEl, main);
    win.body.appendChild(h('div', { class: 'st-wrap' }, root));

    // ------------------------------------------------------------------ data
    async function loadSources() {
      try {
        const r = await api.invoke('store:sources');
        sources = Array.isArray(r?.sources) ? r.sources : [];
        live = !!r?.live;
      } catch (e) {
        console.warn('store: sources failed', e);
      }
    }
    async function loadHome() {
      try {
        home = await api.invoke('store:home');
        loadError = '';
      } catch (e) {
        console.warn('store: home failed', e);
        loadError = e?.message || String(e);
      }
    }
    async function loadInstalled() {
      try {
        installedList = (await api.invoke('store:installedAll'))?.items || [];
      } catch {}
    }
    async function loadUpdates() {
      try {
        const u = await api.invoke('store:updates');
        if (u && Array.isArray(u.items)) updates = u;
      } catch {}
    }
    async function loadAll() {
      await Promise.all([loadSources(), loadHome(), loadInstalled(), loadUpdates()]);
    }
    function listParams() {
      if (view.kind === 'search') return { query };
      if (view.kind === 'category') return { category: view.category };
      if (view.kind === 'tools') return { tools: true };
      return null;
    }
    async function loadList(reset) {
      const params = listParams();
      if (!params) return;
      const sig = JSON.stringify(params);
      if (reset || !list || list.sig !== sig) list = { sig, items: [], total: 0, loading: true, error: '' };
      else list.loading = true;
      const seq = ++listSeq;
      // 'Load more' keeps its focus: it is marked busy instead of being replaced or disabled.
      const moreFocused = !reset && document.activeElement?.classList.contains('st-more');
      if (reset) render();
      else content.querySelector('.st-more')?.setAttribute('aria-busy', 'true');
      try {
        const r = await api.invoke('store:search', { ...params, offset: list.items.length, limit: PAGE });
        if (seq !== listSeq || win.closed) return;
        list.items = list.items.concat(r?.items || []);
        list.total = Number(r?.total) || 0;
        list.loading = false;
      } catch (e) {
        if (seq !== listSeq) return;
        list.loading = false;
        list.error = e?.message || String(e);
      }
      if (reset) {
        render();
      } else {
        // Append the new page without rebuilding the grid (keeps focus and scroll position).
        const gridEl = content.querySelector('.st-results');
        const have = gridEl ? gridEl.children.length : 0;
        if (gridEl) for (const e of list.items.slice(have)) gridEl.append(cell(e));
        updateMore();
        // Keyboard users continue on the first new card.
        if (moreFocused && !content.contains(document.activeElement)) gridEl?.children[have]?.querySelector('.st-card')?.focus();
      }
    }
    async function loadDetail(key, source) {
      detail = { key, source, data: detail?.key === key ? detail.data : null, loading: true, error: '' };
      render();
      try {
        const data = await api.invoke('store:details', key, source || undefined);
        if (detail?.key !== key || win.closed) return;
        detail = { key, source: data.source, data, loading: false, error: '' };
      } catch (e) {
        if (detail?.key !== key) return;
        detail = { key, source, data: null, loading: false, error: e?.message || String(e) };
      }
      render();
    }
    // After an install / remove / refresh: reload what is on screen.
    async function reloadAfterChange() {
      await loadAll();
      if (view.kind === 'detail' && detail) {
        try {
          const data = await api.invoke('store:details', detail.key, detail.source);
          detail = { ...detail, data, source: data.source, loading: false, error: '' };
        } catch {}
      } else if (listParams() && list) {
        const keep = Math.max(PAGE, list.items.length);
        try {
          const r = await api.invoke('store:search', { ...listParams(), offset: 0, limit: Math.min(60, keep) });
          list = { ...list, items: r?.items || [], total: Number(r?.total) || 0 };
        } catch {}
      }
      if (!win.closed) render();
    }

    // ------------------------------------------------------------------ navigation
    function go(next, { push = true } = {}) {
      if (push && view && JSON.stringify(view) !== JSON.stringify(next)) history.push(view);
      view = next;
      if (next.kind !== 'detail' && next.kind !== 'search' && query) {
        query = '';
        searchInput.value = '';
      }
      if (next.kind === 'detail') loadDetail(next.key, next.source);
      else if (listParams()) loadList(true);
      else render();
      content.scrollTop = 0;
      if (next.kind === 'detail') content.querySelector('.st-back')?.focus();
      else if (!root.contains(document.activeElement)) content.focus();
    }
    function back() {
      if (!history.length) return false;
      const left = view.kind === 'detail' ? view.key : null;
      view = history.pop();
      if (view.kind === 'search' && !query) view = history.pop() || { kind: 'home' };
      if (listParams() && (!list || list.sig !== JSON.stringify(listParams()))) loadList(true);
      else render();
      const prev = left && content.querySelector(`button.st-card[data-key="${CSS.escape(left)}"], [data-key="${CSS.escape(left)}"] .st-row-main`);
      if (prev) prev.focus();
      else if (!root.contains(document.activeElement)) (content.querySelector('.st-card, .st-row-main') || content).focus();
      return true;
    }
    const openDetail = (e) => go({ kind: 'detail', key: e.key });

    // ------------------------------------------------------------------ install / remove / open
    function errorText(e, action, name) {
      const code = e?.code || '';
      if (code === 'EAUTH' || code === 'ENOTADMIN' || code === 'EPERM') return t('errAdmin');
      if (code === 'ENETWORK' || code === 'ENET' || /network|resolve|unreachable|timed? ?out/i.test(e?.message || '')) return t('errNetwork');
      if (code === 'EBUSY') return t('waitOther');
      if (action === 'check') return t('errCheckUpdates', { msg: e?.message || String(e) });
      return t(action === 'install' ? 'errInstall' : action === 'refresh' ? 'errRefresh' : action === 'update' ? 'errUpdate' : 'errRemove', { name, msg: e?.message || String(e) });
    }
    const stepText = (action, name) => t(action === 'install' ? 'installingStep' : action === 'update' ? 'updatingStep' : 'removingStep', { name });
    // -> 'ok' | 'canceled' | 'failed' (opts.batch: part of « Tout mettre à jour »: no notification, no reload)
    async function runOp(entry, source, action, opts = {}) {
      if (op) return 'failed';
      const src = entry.sources.find((s) => s.source === source) || entry.sources[0];
      const id = src.source === 'selene' ? entry.selene?.apt : src.id;
      const cancelable = (action === 'install' || action === 'update') && !ADMIN.has(src.source) && !!sources.find((s) => s.id === src.source)?.cancelable;
      op = { key: entry.key, source: src.source, id, action, percent: 0, step: t(action === 'install' ? 'preparing' : action === 'update' ? 'preparingUpdate' : 'preparingRemove'), cancelable, canceling: false };
      let outcome = 'ok';
      errors.delete(entry.key);
      notices.delete(entry.key);
      render();
      let off = null;
      let result = null;
      try {
        if (ADMIN.has(src.source)) {
          const adminAction = action === 'install' ? 'store-install' : 'store-remove';
          off = api.on('admin:progress', ({ action: a, line }) => {
            if (a !== adminAction || !op) return;
            const s = parseStatus(line);
            if (!s || s.phase === 'error') return;
            // Downloads fill the first 40 %, unpacking/configuring the rest (removals are install-phase only).
            const pct = action === 'install' ? (s.phase === 'download' ? s.percent * 0.4 : 40 + s.percent * 0.6) : s.percent;
            op.percent = Math.max(op.percent, Math.round(pct));
            op.step = s.phase === 'download' ? t('downloading', { pct: Math.round(s.percent) }) : t(action === 'install' ? 'installingStep' : 'removingStep', { name: entry.name });
            updateProgress();
          });
          await ctx.shell.runAdmin(adminAction, [id], { reason: t(action === 'install' ? 'reasonInstall' : 'reasonRemove', { name: entry.name, pkg: id }), appId: 'store' });
          await api.invoke('store:invalidate').catch(() => {});
        } else {
          off = api.on('store:progress', (p) => {
            if (!op || p?.kind !== action || p.source !== op.source || p.id !== op.id) return;
            op.percent = Math.max(op.percent, Math.round(Number(p.percent) || 0));
            if (p.canceling && !op.canceling) markCanceling();
            op.step = op.canceling ? t('canceling') : stepText(action, entry.name);
            updateProgress();
          });
          result = await api.invoke(action === 'install' ? 'store:install' : action === 'update' ? 'store:update' : 'store:remove', src.source, id);
        }
        if (win.closed) return outcome;
        if (!opts.batch) {
          ctx.shell.notify({
            title: t(action === 'install' ? 'doneInstallTitle' : action === 'update' ? 'doneUpdateTitle' : 'doneRemoveTitle', { name: entry.name }),
            body: action === 'install' ? (entry.selene && !entry.selene.gui ? (entry.selene.command ? t('doneInstallBody', { cmd: entry.selene.command }) : t('doneInstallService')) : t('doneInstallGui')) : '',
            appId: 'store',
            silent: true,
          });
        }
        if (result?.desktopId) ctx.shell.registry?.load?.().catch?.(() => {});
      } catch (e) {
        outcome = e?.code === 'ECANCELED' ? 'canceled' : 'failed';
        if (e?.code === 'ECANCELED' && op?.canceling) notices.set(entry.key, await canceledText(action, src.source, id, entry.name));
        else if (e?.code !== 'ECANCELED') errors.set(entry.key, errorText(e, action, entry.name));
      } finally {
        off?.();
        op = null;
      }
      if (!win.closed && !opts.batch) await reloadAfterChange();
      return outcome;
    }
    // The notice after « Annuler »: « Rien n'a été modifié » only when the backend confirms the clean-up.
    async function canceledText(action, source, id, name) {
      if (action === 'update') return t('canceledUpdate', { name });
      if (action !== 'install') return t('canceledInstall', { name });
      const r = await api.invoke('store:lastCancel', source, id).catch(() => null);
      return t(r?.partial ? 'canceledInstallPartial' : 'canceledInstall', { name });
    }
    // « Tout mettre à jour »: one app after the other; « Annuler » stops the current one and the rest.
    const updEntry = (u) => ({ key: u.key, name: u.name, icon: u.icon, categories: u.categories || [], sources: [{ source: u.source, id: u.id, installed: true }] });
    async function updateAll() {
      if (op || batch || !updates.items.length) return;
      const queue = updates.items.slice();
      for (const u of queue) errors.delete(u.key), notices.delete(u.key);
      batch = { total: queue.length, done: 0, canceled: false };
      let ok = 0;
      for (const u of queue) {
        if (!batch || batch.canceled || win.closed) break;
        render();
        const r = await runOp(updEntry(u), u.source, 'update', { batch: true });
        if (r === 'ok') ok++;
        if (r === 'canceled') batch.canceled = true;
        batch.done++;
      }
      const b = batch;
      batch = null;
      if (win.closed) return;
      if (ok) ctx.shell.notify({ title: t('doneUpdateAllTitle', { count: ok }), body: b.canceled ? t('doneUpdateAllStopped') : '', appId: 'store', silent: true });
      await reloadAfterChange();
    }
    async function checkNow() {
      if (updates.checking) return;
      updates = { ...updates, checking: true };
      render();
      try {
        const u = await api.invoke('store:checkUpdates');
        if (u && Array.isArray(u.items)) updates = u;
      } catch (e) {
        updates = { ...updates, checking: false, error: e?.message || String(e), errorCode: e?.code || null };
      }
      if (!win.closed) render();
    }
    // « Annuler »: the backend stops flatpak and removes what it had added; store:install then rejects (ECANCELED).
    function markCanceling() {
      if (!op) return;
      op.canceling = true;
      op.step = t('canceling');
      const btn = content.querySelector('.st-cancel');
      if (btn) {
        btn.disabled = true;
        btn.setAttribute('aria-disabled', 'true');
      }
      updateProgress();
    }
    async function cancelOp() {
      if (!op || !op.cancelable || op.canceling) return;
      const mine = op;
      markCanceling();
      try {
        const r = await api.invoke('store:cancel', mine.source, mine.id);
        if (!r?.canceled && op === mine) {
          // Nothing to stop any more (it had just finished): the operation's own end reloads the view.
          op.canceling = false;
          render();
        }
      } catch (e) {
        if (op === mine) {
          op.canceling = false;
          render();
        }
        console.warn('store: cancel failed', e);
      }
    }
    // An operation started before this window opened (another window, the first sign-in gaming setup): shown with
    // its progress and « Annuler »; it ends with its store:changed broadcast.
    async function adoptCurrent() {
      try {
        const cur = (await api.invoke('store:current'))?.op;
        if (!cur || op || ADMIN.has(cur.source)) return;
        const key = (installedList.concat(home?.featured || []).find((e) => e.sources.some((s) => s.source === cur.source && s.id === cur.id))?.key) || String(cur.id).toLowerCase();
        op = { key, source: cur.source, id: cur.id, action: cur.action, percent: Math.round(Number(cur.percent) || 0), step: cur.canceling ? t('canceling') : t(cur.action === 'install' ? 'preparing' : cur.action === 'update' ? 'preparingUpdate' : 'preparingRemove'), cancelable: !!cur.cancelable, canceling: !!cur.canceling, adopted: true };
        render();
      } catch {}
    }

    // Graphical app: launch the Linux app (.desktop entry) through the registry; reload once if it is not known yet.
    async function openApp(entry, src) {
      const reg = ctx.shell.registry;
      const ids = [];
      if (src?.source === 'selene' || (!src && entry.selene?.gui)) ids.push(entry.selene?.linuxId);
      const s = src || entry.sources.find((x) => x.installed) || entry.sources[0];
      ids.push(linuxIdOf(s?.desktopId), linuxIdOf(entry.desktopId), entry.selene?.linuxId);
      const cand = [...new Set(ids.filter(Boolean))];
      let id = cand.find((i) => reg.get(i));
      if (!id) {
        await reg.load().catch(() => {});
        id = cand.find((i) => reg.get(i));
      }
      if (id) {
        errors.delete(entry.key);
        reg.launch(id);
        return;
      }
      errors.set(entry.key, t('openFailed', { name: entry.name }));
      render();
    }
    function openTerminal(entry) {
      const args = entry.selene?.interactive && entry.selene.command ? { command: entry.selene.command } : {};
      ctx.shell.launch('terminal', args);
    }
    const isCli = (e) => e.selene && !e.selene.gui && e.installedSource === 'selene';
    function openButton(entry, cls, src) {
      if (isCli(entry) && (!src || src.source === 'selene')) {
        return entry.selene.command || cls ? h('button', { class: ['btn', cls, 'st-open'], onclick: () => openTerminal(entry) }, icon('window_console'), t('openTerminal')) : null;
      }
      return h('button', { class: ['btn', cls, 'st-open'], dataset: { gui: '1' }, 'aria-label': t('openAppName', { name: entry.name }), onclick: () => openApp(entry, src) }, icon('open'), t('openApp'));
    }

    // ------------------------------------------------------------------ pieces
    function appIcon(e, size = '') {
      const cat = e.categories?.[0] || 'Utility';
      const fallback = () => h('div', { class: ['st-tile', `st-cat-${cat}`, size], 'aria-hidden': 'true' }, icon(e.fluentIcon || CAT_ICON[cat] || 'apps'));
      if (!e.icon) return fallback();
      return h('img', { class: ['st-icon', size], src: e.icon, alt: '', loading: 'lazy', draggable: false, onerror: (ev) => ev.target.replaceWith(fallback()) });
    }
    function badges(e) {
      return h('span', { class: 'st-badges' }, e.sources.map((s) => h('span', { class: ['st-badge', `src-${s.source}`], dataset: { source: s.source }, title: t('fromSource', { src: srcLabel(s.source) }) }, srcLabel(s.source))));
    }
    function statusChip(e) {
      if (isBusy(e)) return h('span', { class: 'st-chip busy' }, h('span', { class: 'spinner small' }), t(op.action === 'install' ? 'installing' : op.action === 'update' ? 'updating' : 'removing'));
      if (e.installed) return h('span', { class: 'st-chip ok' }, icon('checkmark'), t('installed'));
      return null;
    }
    function card(e) {
      return h(
        'button',
        { class: 'st-card', dataset: { key: e.key }, title: e.name, onclick: () => openDetail(e) },
        h('div', { class: 'st-card-top' }, appIcon(e), statusChip(e)),
        h('div', { class: 'st-card-text' }, h('div', { class: 'st-card-name' }, e.name), h('div', { class: 'st-card-cat caption' }, e.categories?.[0] ? catLabel(e.categories[0]) : ''), h('div', { class: 'st-card-desc' }, e.summary || '')),
        h('div', { class: 'st-card-foot' }, badges(e)),
      );
    }
    const cell = (e) => h('div', { role: 'listitem', class: 'st-grid-cell' }, card(e));
    function grid(items, row = false, cls = '') {
      return h('div', { class: ['st-grid', row && 'row', cls], role: 'list' }, items.map(cell));
    }
    function liveNote() {
      return live ? h('div', { class: 'infobar warning st-live', role: 'note' }, icon('warning'), h('div', null, h('b', null, t('liveTitle')), ' ', t('liveBody'))) : null;
    }
    function empty(iconName, title, body) {
      return h('div', { class: 'empty st-empty' }, icon(iconName), h('div', { class: 'subtitle' }, title), body ? h('div', { class: 'text-2' }, body) : null);
    }
    function refreshBanner() {
      const busy = [...refreshPct.entries()];
      if (!busy.length) return null;
      return h(
        'div',
        { class: 'infobar st-refreshing', role: 'status' },
        h('span', { class: 'spinner small' }),
        h('div', null, busy.map(([id, pct]) => h('div', null, t('refreshingSource', { src: srcLabel(id), pct: Math.round(pct) })))),
      );
    }
    function section(title, items, { onAll, category, key, total } = {}) {
      if (!items?.length) return null;
      return h(
        'section',
        { class: 'st-section', dataset: { category: category || null, row: key || null } },
        h('div', { class: 'st-section-head' }, h('h2', { class: 'subtitle' }, title), onAll ? h('button', { class: 'btn subtle st-see-all', onclick: onAll, 'aria-label': `${t('seeAll')} — ${title}` }, total ? t('seeAllCount', { count: total }) : t('seeAll'), icon('chevron_right')) : null),
        grid(items, true),
      );
    }

    // ------------------------------------------------------------------ views
    function renderNav() {
      const navBtn = (key, ic, label, selected, onclick, extra = null) =>
        h('button', { class: ['nav-item', 'st-nav-item', selected && 'selected'], dataset: { nav: key }, 'aria-current': selected ? 'page' : null, onclick }, icon(ic), h('span', { class: 'st-nav-label' }, label), extra);
      const k = view.kind === 'detail' ? history[history.length - 1] || { kind: 'home' } : view;
      const sel = k.kind === 'category' ? `cat:${k.category}` : k.kind;
      const nInst = installedList.length;
      const cats = home?.rows?.map((r) => r.category) || [];
      navEl.replaceChildren(
        h('div', { class: 'st-brand' }, h('img', { src: ctx.appUrl('icon.svg'), alt: '' }), h('span', null, t('appName'))),
        navBtn('home', 'home', t('home'), sel === 'home', () => go({ kind: 'home' })),
        navBtn('categories', 'grid', t('categories'), sel === 'categories', () => go({ kind: 'categories' })),
        navBtn('installed', 'apps_list', t('installedNav'), sel === 'installed', () => go({ kind: 'installed' }), nInst ? h('span', { class: 'st-count caption' }, String(nInst)) : null),
        navBtn('updates', 'arrow_sync', t('updatesNav'), sel === 'updates', () => go({ kind: 'updates' }), updates.count ? h('span', { class: 'st-count st-upd-count caption', title: t('updatesCount', { count: updates.count }), 'aria-label': t('updatesCount', { count: updates.count }) }, String(updates.count)) : updates.checking ? h('span', { class: 'spinner small st-nav-spin' }) : null),
        navBtn('sources', 'cloud_sync', t('sourcesNav'), sel === 'sources', () => go({ kind: 'sources' }), refreshPct.size ? h('span', { class: 'spinner small st-nav-spin' }) : null),
        cats.length ? h('div', { class: 'st-nav-sep caption' }, t('browse')) : null,
        ...cats.map((c) => navBtn(`cat:${c}`, CAT_ICON[c] || 'apps', catLabel(c), sel === `cat:${c}`, () => go({ kind: 'category', category: c }))),
      );
    }

    function renderHome() {
      if (!home) return h('div', { class: 'st-loading' }, h('div', { class: 'spinner' }));
      const nApps = Number(home.total) || 0;
      return [
        h('div', { class: 'st-hero' }, h('div', { class: 'st-hero-text' }, h('h1', { class: 'title' }, t('heroTitle')), h('div', { class: 'st-hero-sub' }, t('heroBody', { count: nApps }))), h('img', { class: 'st-hero-art', src: ctx.appUrl('icon.svg'), alt: '' })),
        liveNote(),
        refreshBanner(),
        section(t('featured'), home.featured, { key: 'featured' }),
        section(t('picks'), home.picks, { key: 'picks' }),
        (home.rows || []).map((r) => section(catLabel(r.category), r.items, { category: r.category, total: r.total, onAll: () => go({ kind: 'category', category: r.category }) })),
        section(t('tools'), home.tools, { key: 'tools', total: home.toolsTotal, onAll: () => go({ kind: 'tools' }) }),
      ];
    }

    function renderCategories() {
      const rows = home?.rows || [];
      return [
        h('h1', { class: 'title st-page-title' }, t('categories')),
        h(
          'div',
          { class: 'st-cats', role: 'list' },
          rows.map((r) =>
            h(
              'div',
              { role: 'listitem', class: 'st-grid-cell' },
              h('button', { class: ['st-cat-tile', `st-cat-${r.category}`], dataset: { category: r.category }, onclick: () => go({ kind: 'category', category: r.category }) }, h('span', { class: 'st-cat-ic' }, icon(CAT_ICON[r.category] || 'apps')), h('span', { class: 'st-cat-name' }, catLabel(r.category)), h('span', { class: 'caption st-cat-count' }, t('appsCount', { count: r.total }))),
            ),
          ),
          home?.toolsTotal
            ? h('div', { role: 'listitem', class: 'st-grid-cell' }, h('button', { class: ['st-cat-tile', 'st-cat-System'], dataset: { category: 'tools' }, onclick: () => go({ kind: 'tools' }) }, h('span', { class: 'st-cat-ic' }, icon('window_console')), h('span', { class: 'st-cat-name' }, t('tools')), h('span', { class: 'caption st-cat-count' }, t('appsCount', { count: home.toolsTotal }))))
            : null,
        ),
      ];
    }

    function moreButton() {
      if (!list || list.items.length >= list.total) return null;
      return h('button', { class: 'btn st-more', 'aria-busy': list.loading ? 'true' : null, onclick: () => !list.loading && loadList(false) }, t('loadMore', { shown: list.items.length, total: list.total }));
    }
    function updateMore() {
      const old = content.querySelector('.st-more');
      const next = moreButton();
      if (old && next) {
        old.textContent = next.textContent;
        old.removeAttribute('aria-busy');
      } else if (old) old.remove();
      const sub = content.querySelector('.st-page-sub');
      if (sub && list) sub.textContent = t('appsCount', { count: list.total });
    }
    function renderList(title) {
      if (!list || (list.loading && !list.items.length)) return [h('h1', { class: 'title st-page-title' }, title), h('div', { class: 'st-loading' }, h('div', { class: 'spinner' }))];
      if (list.error) return [h('h1', { class: 'title st-page-title' }, title), h('div', { class: 'infobar error st-error', role: 'alert' }, icon('error_circle'), h('div', null, list.error))];
      if (!list.items.length) return [h('h1', { class: 'title st-page-title' }, title), view.kind === 'search' ? empty('search', t('noResults'), t('noResultsBody')) : empty('apps', t('noApps'))];
      return [h('h1', { class: 'title st-page-title' }, title), h('div', { class: 'text-2 st-page-sub' }, t('appsCount', { count: list.total })), grid(list.items, false, 'st-results'), h('div', { class: 'st-more-wrap' }, moreButton())];
    }

    function renderInstalled() {
      const rows = installedList.map((e) => {
        const src = e.sources.find((s) => s.installed) || e.sources[0];
        const removable = !(src.source === 'selene' && e.selene?.removable === false);
        return h(
          'div',
          { class: 'st-row card', dataset: { key: e.key } },
          h('button', { class: 'st-row-main', onclick: () => go({ kind: 'detail', key: e.key, source: src.source }), 'aria-label': e.name }, appIcon(e, 'small'), h('div', { class: 'st-row-text' }, h('div', { class: 'st-row-name' }, e.name), h('div', { class: 'caption text-2' }, [src.source === 'selene' ? e.selene?.apt : src.id, src.version].filter(Boolean).join(' · ')))),
          h('span', { class: ['st-badge', `src-${src.source}`], dataset: { source: src.source } }, srcLabel(src.source)),
          isBusy(e) ? statusChip(e) : null,
          openButton(e, '', src),
          removable
            ? h('button', { class: 'btn subtle st-remove', disabled: !!op, 'aria-label': t('removeName', { name: e.name }), title: t('remove'), onclick: () => runOp(e, src.source, 'remove') }, icon('delete'))
            : h('span', { class: 'caption text-2 st-builtin' }, t('builtIn')),
        );
      });
      return [
        h('h1', { class: 'title st-page-title' }, t('installedTitle')),
        h('div', { class: 'text-2 st-page-sub' }, t('installedSub')),
        liveNote(),
        installedList.some((e) => errors.has(e.key)) ? h('div', { class: 'infobar error st-error', role: 'alert' }, icon('error_circle'), h('div', null, [...errors.values()].pop())) : null,
        installedList.length ? h('div', { class: 'st-rows' }, rows) : empty('apps_list', t('noneInstalled'), t('noneInstalledBody')),
      ];
    }

    function renderUpdates() {
      const items = updates.items;
      const busyAny = !!op || !!batch;
      const sub = updates.checking ? t('updatesChecking') : updates.checkedAt ? t('updatesChecked', { when: fmtDate(updates.checkedAt) }) : t('updatesNeverChecked');
      const head = h(
        'div',
        { class: 'st-upd-head' },
        h('div', { class: 'st-upd-head-text' }, h('h1', { class: 'title st-page-title' }, t('updatesTitle')), h('div', { class: 'text-2 st-page-sub st-upd-when', 'aria-live': 'polite' }, sub)),
        h(
          'div',
          { class: 'st-upd-actions' },
          items.length ? h('button', { class: 'btn primary st-update-all', disabled: busyAny || updates.checking, onclick: () => updateAll() }, icon('arrow_download'), t('updateAll')) : null,
          h('button', { class: ['btn', 'st-check', !items.length && 'primary'], disabled: updates.checking || busyAny, onclick: () => checkNow() }, updates.checking ? h('span', { class: 'spinner small' }) : icon('arrow_sync'), t(updates.checking ? 'checkingUpdates' : 'checkUpdates')),
        ),
      );
      const blocks = [head, liveNote()];
      if (batch) blocks.push(h('div', { class: 'infobar st-batch', role: 'status' }, h('span', { class: 'spinner small' }), h('div', null, t('updatingN', { n: Math.min(batch.done + 1, batch.total), total: batch.total }))));
      if (updates.error && !updates.checking) blocks.push(h('div', { class: 'infobar warning st-error st-upd-error', role: 'alert' }, icon('warning'), h('div', null, errorText({ message: updates.error, code: updates.errorCode }, 'check', ''))));
      if (!items.length) {
        if (updates.checking) blocks.push(h('div', { class: 'st-loading' }, h('div', { class: 'spinner' })));
        else blocks.push(h('div', { class: 'empty st-empty st-upd-empty' }, icon('checkmark_circle'), h('div', { class: 'subtitle' }, t('upToDate')), h('div', { class: 'text-2' }, t('upToDateBody'))));
        // A notice left by a cancelled update stays readable.
        const left = [...notices.entries()].pop();
        if (left) blocks.push(h('div', { class: 'infobar st-canceled', role: 'status' }, icon('info'), h('div', null, left[1])));
        return blocks;
      }
      blocks.push(h('div', { class: 'caption text-2 st-upd-note' }, t('updatesNote')));
      const rows = items.map((u) => {
        const e = updEntry(u);
        const busy = isBusy(e);
        const err = errors.get(u.key);
        const notice = !busy && !err ? notices.get(u.key) : null;
        const ver = [u.installedVersion && u.version ? t('versionFromTo', { from: u.installedVersion, to: u.version }) : u.version ? t('versionTo', { to: u.version }) : '', u.downloadSize ? formatSize(u.downloadSize, lang()) : ''].filter(Boolean).join(' · ');
        let actions;
        if (busy) {
          actions = [
            h('div', { class: 'st-progress-wrap st-upd-progress' }, h('div', { class: 'progress st-progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(op.percent), 'aria-label': op.step }, h('div', { class: 'bar', style: { width: `${op.percent}%` } })), h('div', { class: 'caption text-2 st-step', 'aria-live': 'polite' }, op.step)),
            op.cancelable ? h('button', { class: 'btn st-cancel', disabled: op.canceling, 'aria-label': t('cancelUpdateName', { name: u.name }), onclick: () => cancelOp() }, icon('dismiss'), t('cancel')) : null,
          ];
        } else {
          actions = h('button', { class: 'btn st-update', disabled: busyAny, 'aria-label': t('updateName', { name: u.name }), onclick: () => runOp(e, u.source, 'update') }, t('update'));
        }
        return h(
          'div',
          { class: 'st-row st-upd-row card', dataset: { key: u.key, id: u.id } },
          h('div', { class: 'st-upd-line' },
            h('button', { class: 'st-row-main', onclick: () => go({ kind: 'detail', key: u.key, source: u.source }), 'aria-label': u.name }, appIcon(e, 'small'), h('div', { class: 'st-row-text' }, h('div', { class: 'st-row-name' }, u.name), h('div', { class: 'caption text-2 st-upd-ver' }, ver))),
            h('span', { class: ['st-badge', `src-${u.source}`], dataset: { source: u.source } }, srcLabel(u.source)),
            actions,
          ),
          err ? h('div', { class: 'infobar error st-error', role: 'alert' }, icon('error_circle'), h('div', null, err)) : null,
          notice ? h('div', { class: 'infobar st-canceled', role: 'status' }, icon('info'), h('div', null, notice)) : null,
        );
      });
      blocks.push(h('div', { class: 'st-rows st-upd-rows' }, rows));
      return blocks;
    }

    function fmtDate(ms) {
      if (!ms) return t('never');
      try {
        return new Date(ms).toLocaleString(lang() === 'fr' ? 'fr-FR' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' });
      } catch {
        return new Date(ms).toISOString();
      }
    }
    async function refreshSource(id) {
      if (refreshPct.has(id)) return;
      refreshPct.set(id, 0);
      refreshErr.delete(id);
      render();
      try {
        await api.invoke('store:refresh', id);
      } catch (e) {
        refreshErr.set(id, errorText(e, 'refresh', srcLabel(id)));
      } finally {
        refreshPct.delete(id);
      }
      if (!win.closed) await reloadAfterChange();
    }
    function renderSources() {
      const rows = sources.map((s) => {
        const busy = refreshPct.has(s.id);
        let state;
        if (s.missing) state = t('srcMissing');
        else if (!s.enabled) state = t('srcOff');
        else if (busy) state = t('refreshingPct', { pct: Math.round(refreshPct.get(s.id)) });
        else if (!s.available) state = t('srcUnavailable');
        else if (!s.ready) state = t('srcNotReady');
        else state = t('srcReady', { count: s.count });
        const err = refreshErr.get(s.id) || (s.error && s.enabled ? errorText({ message: s.error, code: s.errorCode }, 'refresh', srcLabel(s.id)) : '');
        const toggle = s.toggleable
          ? ctx.ui.toggle({
              checked: s.enabled,
              label: t('srcEnabled'),
              onchange: async (on) => {
                try {
                  const r = await api.invoke('store:setEnabled', s.id, on);
                  sources = r?.sources || sources;
                } catch {}
                home = null;
                list = null;
                await reloadAfterChange();
                if (on && sources.find((x) => x.id === s.id && x.available && !x.ready)) refreshSource(s.id);
              },
            })
          : null;
        if (toggle) toggle.classList.add('st-src-toggle');
        return h(
          'div',
          { class: 'st-src card', dataset: { source: s.id } },
          h('div', { class: 'st-src-head' }, h('span', { class: ['st-badge', `src-${s.id}`] }, srcLabel(s.id)), h('div', { class: 'st-src-title' }, h('div', { class: 'st-row-name' }, t(`srcName.${s.id}`)), h('div', { class: 'caption text-2' }, t(`srcDesc.${s.id}`)))),
          h(
            'dl',
            { class: 'st-src-info' },
            h('dt', { class: 'text-2' }, t('srcStatus')),
            h('dd', { class: 'st-src-state' }, state),
            s.id !== 'selene' ? [h('dt', { class: 'text-2' }, t('srcUpdated')), h('dd', { class: 'st-src-updated' }, fmtDate(s.updatedAt))] : null,
            h('dt', { class: 'text-2' }, t('srcInstallAs')),
            h('dd', null, t(s.admin ? 'srcAdmin' : 'srcUser')),
          ),
          busy ? h('div', { class: 'progress st-progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(refreshPct.get(s.id))), 'aria-label': state }, h('div', { class: 'bar', style: { width: `${refreshPct.get(s.id)}%` } })) : null,
          err ? h('div', { class: 'infobar error st-error', role: 'alert' }, icon('error_circle'), h('div', null, err)) : null,
          h('div', { class: 'st-src-actions' }, toggle, s.id !== 'selene' && !s.missing ? h('button', { class: 'btn st-refresh', disabled: busy || !s.enabled, onclick: () => refreshSource(s.id) }, icon('arrow_sync'), t('refresh')) : null),
        );
      });
      return [h('h1', { class: 'title st-page-title' }, t('sourcesTitle')), h('div', { class: 'text-2 st-page-sub' }, t('sourcesSub')), liveNote(), h('div', { class: 'st-srcs' }, rows)];
    }

    function renderDetail() {
      if (!detail || (detail.loading && !detail.data)) return [backBtn(), h('div', { class: 'st-loading' }, h('div', { class: 'spinner' }))];
      if (!detail.data) return [backBtn(), empty('error_circle', t('notFound'), detail.error)];
      const { entry: e, details: d } = detail.data;
      const srcId = detail.data.source;
      const src = e.sources.find((s) => s.source === srcId) || e.sources[0];
      const inst = src.installed;
      const busy = isBusy(e);
      const actions = h('div', { class: 'st-actions' });
      if (busy) {
        actions.append(h('div', { class: 'st-progress-wrap' }, h('div', { class: 'progress st-progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(op.percent), 'aria-label': op.step }, h('div', { class: 'bar', style: { width: `${op.percent}%` } })), h('div', { class: 'caption text-2 st-step', 'aria-live': 'polite' }, op.step)));
        if (op.cancelable) actions.append(h('button', { class: 'btn st-cancel', disabled: op.canceling, 'aria-label': t('cancelName', { name: e.name }), onclick: () => cancelOp() }, icon('dismiss'), t('cancel')));
      } else if (inst) {
        const ob = openButton(e, 'primary', src);
        if (ob) actions.append(ob);
        if (src.source === 'selene' && e.selene?.removable === false) actions.append(h('span', { class: 'caption text-2 st-builtin' }, t('builtIn')));
        else actions.append(h('button', { class: 'btn st-remove', disabled: !!op, onclick: () => runOp(e, src.source, 'remove') }, t('remove')));
      } else {
        actions.append(h('button', { class: 'btn primary st-install', disabled: !!op, onclick: () => runOp(e, src.source, 'install') }, icon('arrow_download'), t('installFrom', { src: srcLabel(src.source) })));
        const hint = [d.downloadSize ? t('downloadSize', { size: formatSize(d.downloadSize, lang()) }) : '', ADMIN.has(src.source) ? t('needsAdmin') : t('noAdmin')].filter(Boolean).join(' · ');
        actions.append(h('span', { class: 'caption text-2 st-hint' }, hint));
      }
      if (op && !busy) actions.append(h('span', { class: 'caption text-2 st-wait' }, t('waitOther')));
      const picker =
        e.sources.length > 1
          ? h(
              'div',
              { class: 'st-picker', role: 'radiogroup', 'aria-label': t('chooseSource') },
              h('span', { class: 'caption text-2' }, t('chooseSource')),
              e.sources.map((s) =>
                h(
                  'button',
                  {
                    class: ['st-src-opt', s.source === src.source && 'selected'],
                    role: 'radio',
                    'aria-checked': s.source === src.source ? 'true' : 'false',
                    tabindex: s.source === src.source ? '0' : '-1',
                    dataset: { source: s.source },
                    disabled: busy,
                    onclick: () => s.source !== src.source && loadDetail(e.key, s.source),
                    onkeydown: (ev) => {
                      if (ev.key !== 'ArrowRight' && ev.key !== 'ArrowLeft') return;
                      ev.preventDefault();
                      const i = e.sources.indexOf(s) + (ev.key === 'ArrowRight' ? 1 : -1);
                      const n = e.sources[(i + e.sources.length) % e.sources.length];
                      loadDetail(e.key, n.source).then(() => content.querySelector(`.st-src-opt[data-source="${n.source}"]`)?.focus());
                    },
                  },
                  h('span', { class: ['st-dot', `src-${s.source}`] }),
                  srcLabel(s.source),
                  s.installed ? h('span', { class: 'st-src-inst caption' }, ` · ${t('installed')}`) : null,
                ),
              ),
            )
          : h('div', { class: 'caption text-2 st-single-src' }, t('fromSource', { src: srcLabel(src.source) }));
      const err = errors.get(e.key);
      const notice = !busy && !err ? notices.get(e.key) : null;
      const pkgLabel = src.source === 'flathub' ? t('appIdLabel') : t('package');
      const info = [
        [t('source'), t(`srcName.${src.source}`)],
        [pkgLabel, src.source === 'selene' ? e.selene?.apt : src.id],
        [t('version'), inst ? d.version || src.version || '—' : d.version ? `${d.version} (${t('notInstalled').toLowerCase()})` : t('notInstalled')],
        d.developer ? [t('developer'), d.developer] : null,
        d.license ? [t('license'), d.license] : null,
        d.downloadSize ? [t('size'), formatSize(d.downloadSize, lang())] : null,
        [t('category'), e.categories.map(catLabel).join(', ') || '—'],
      ].filter(Boolean);
      const paras = String(d.description || e.summary || '')
        .split(/\n{2,}/)
        .map((p) => p.trim())
        .filter(Boolean);
      return [
        backBtn(),
        h(
          'div',
          { class: 'st-detail-head card' },
          appIcon(e, 'large'),
          h(
            'div',
            { class: 'st-detail-title' },
            h('h1', { class: 'title' }, e.name),
            h('div', { class: 'text-2 st-dev' }, d.developer || (e.selene ? h('code', null, e.selene.apt) : src.id)),
            e.summary ? h('div', { class: 'st-summary' }, e.summary) : null,
            h('div', { class: 'st-head-badges' }, badges(e), inst && !busy ? h('span', { class: 'st-chip ok' }, icon('checkmark'), t('installed')) : null),
            picker,
            actions,
          ),
        ),
        err ? h('div', { class: 'infobar error st-error', role: 'alert' }, icon('error_circle'), h('div', null, h('b', null, t('failed')), ' ', err)) : null,
        notice ? h('div', { class: 'infobar st-canceled', role: 'status' }, icon('info'), h('div', null, notice)) : null,
        src.source === 'flathub' && live && !inst ? liveNote() : null,
        d.screenshots?.length
          ? h('section', { class: 'st-section' }, h('h2', { class: 'subtitle' }, t('screenshots')), h('div', { class: 'st-shots', role: 'list' }, d.screenshots.map((u, i) => h('img', { class: 'st-shot', role: 'listitem', src: u, alt: t('screenshotN', { n: i + 1, name: e.name }), loading: 'lazy', draggable: false, onerror: (ev) => ev.target.remove() }))))
          : null,
        h('section', { class: 'st-section' }, h('h2', { class: 'subtitle' }, t('about')), paras.length ? paras.map((p) => h('p', { class: 'st-desc' }, p)) : h('p', { class: 'st-desc text-2' }, t('noDescription'))),
        e.selene && !e.selene.gui && src.source === 'selene'
          ? e.selene.command
            ? h('section', { class: 'st-section' }, h('h2', { class: 'subtitle' }, t('howTo')), h('p', { class: 'text-2' }, t(e.selene.interactive ? 'howToInteractive' : 'howToCli')), h('pre', { class: 'st-cmd' }, e.selene.interactive ? e.selene.command : `${e.selene.command} --help`))
            : h('section', { class: 'st-section' }, h('h2', { class: 'subtitle' }, t('howTo')), h('p', { class: 'text-2' }, t('howToService')))
          : null,
        h(
          'section',
          { class: 'st-section' },
          h('h2', { class: 'subtitle' }, t('information')),
          h('dl', { class: 'st-info card' }, info.map(([k, v]) => [h('dt', { class: 'text-2' }, k), h('dd', null, v || '—')]), d.homepage ? [h('dt', { class: 'text-2' }, t('homepage')), h('dd', null, h('a', { href: '#', class: 'st-link', onclick: (ev) => (ev.preventDefault(), ctx.shell.openUrl(d.homepage)) }, d.homepage))] : null),
        ),
      ];
    }
    const backBtn = () => h('button', { class: 'btn subtle st-back', onclick: () => back() || go({ kind: 'home' }, { push: false }), 'aria-label': t('back') }, icon('arrow_left'), t('back'));

    function updateProgress() {
      if (!op) return;
      const scope = view.kind === 'detail' && detail?.key === op.key ? content.querySelector('.st-actions') : view.kind === 'updates' ? content.querySelector(`.st-upd-row[data-key="${CSS.escape(op.key)}"]`) : null;
      const bar = scope?.querySelector('.st-progress');
      if (bar) {
        bar.firstChild.style.width = `${op.percent}%`;
        bar.setAttribute('aria-valuenow', String(op.percent));
        bar.setAttribute('aria-label', op.step);
        const step = scope.querySelector('.st-step');
        if (step) step.textContent = op.step;
      }
    }
    function updateRefresh() {
      if (view.kind === 'sources' || view.kind === 'home') render();
    }

    function render() {
      if (win.closed) return;
      const hadFocus = content.contains(document.activeElement);
      const navFocus = navEl.contains(document.activeElement) ? document.activeElement.closest('[data-nav]')?.dataset.nav : null;
      const focusedKey = hadFocus ? document.activeElement.closest('[data-key]')?.dataset.key : null;
      const focusedSrc = hadFocus ? document.activeElement.closest('.st-src[data-source]')?.dataset.source : null;
      const scroll = content.scrollTop;
      renderNav();
      let body;
      if (loadError && !home) body = empty('error_circle', t('loadError'), loadError);
      else if (view.kind === 'search') body = renderList(t('resultsFor', { q: query }));
      else if (view.kind === 'detail') body = renderDetail();
      else if (view.kind === 'installed') body = renderInstalled();
      else if (view.kind === 'updates') body = renderUpdates();
      else if (view.kind === 'categories') body = renderCategories();
      else if (view.kind === 'sources') body = renderSources();
      else if (view.kind === 'category') body = renderList(catLabel(view.category));
      else if (view.kind === 'tools') body = renderList(t('tools'));
      else body = renderHome();
      content.replaceChildren(h('div', { class: 'st-page', dataset: { view: view.kind } }, body));
      content.scrollTop = scroll;
      const title = view.kind === 'detail' && detail?.data ? `${detail.data.entry.name} - ${t('appName')}` : t('appName');
      win.setTitle(title);
      // Keep keyboard focus on the same card / row / control after a re-render.
      if (focusedKey) content.querySelector(`button[data-key="${CSS.escape(focusedKey)}"], [data-key="${CSS.escape(focusedKey)}"] .st-row-main`)?.focus();
      else if (focusedSrc) content.querySelector(`.st-src[data-source="${CSS.escape(focusedSrc)}"] .st-refresh, .st-src[data-source="${CSS.escape(focusedSrc)}"] input`)?.focus();
      else if (view.kind === 'detail' && hadFocus && !root.contains(document.activeElement)) content.querySelector('.st-actions .btn:not([disabled]), .st-back')?.focus();
      if (navFocus) navEl.querySelector(`[data-nav="${CSS.escape(navFocus)}"]`)?.focus();
      if (hadFocus && !root.contains(document.activeElement)) content.focus();
    }

    // ------------------------------------------------------------------ keyboard + events
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
        api.invoke('store:invalidate').catch(() => {});
      }
    });
    const offLang = ctx.onLangChange?.(() => {
      searchInput.placeholder = t('searchPlaceholder');
      searchInput.setAttribute('aria-label', t('searchPlaceholder'));
      navEl.setAttribute('aria-label', t('navLabel'));
      render();
      // Summaries come localised from the sources: rebuild the merged index (store:changed reloads the view).
      api.invoke('store:invalidate').catch(() => {});
    });
    void offLang;
    let changeTimer = 0;
    const offs = [
      api.on('admin:devChanged', ({ what } = {}) => {
        if (what === 'store' && !op) api.invoke('store:invalidate').catch(() => {});
      }),
      api.on('store:changed', (p) => {
        // An adopted operation (started before this window) ends with its own store:changed.
        if (op?.adopted && p?.source === op.source && p?.id === op.id && p?.action === op.action) {
          const nm = detail?.data?.entry?.key === op.key ? detail.data.entry.name : updates.items.find((u) => u.key === op.key)?.name || op.id;
          if (p.canceled) notices.set(op.key, t(op.action === 'update' ? 'canceledUpdate' : p.partial ? 'canceledInstallPartial' : 'canceledInstall', { name: nm }));
          op = null;
        }
        // Coalesce bursts; our own operations reload when they finish.
        if (op) return;
        clearTimeout(changeTimer);
        changeTimer = setTimeout(() => !op && !win.closed && reloadAfterChange(), 150);
      }),
      api.on('store:updates', (u) => {
        if (!u || !Array.isArray(u.items)) return;
        const names = new Map(updates.items.map((x) => [`${x.source}:${x.id}`, x]));
        // Broadcasts may come before the merged index is built: keep the names and icons already known.
        updates = { ...u, items: u.items.map((x) => (x.name === x.id && names.has(`${x.source}:${x.id}`) ? { ...x, name: names.get(`${x.source}:${x.id}`).name, icon: x.icon || names.get(`${x.source}:${x.id}`).icon, key: names.get(`${x.source}:${x.id}`).key } : x)) };
        if (win.closed) return;
        if (view.kind === 'updates') render();
        else renderNav();
      }),
      api.on('store:progress', (p) => {
        // An operation started elsewhere while this window is open (first sign-in gaming setup, another window).
        if (!op && (p?.kind === 'install' || p?.kind === 'remove' || p?.kind === 'update') && typeof p.source === 'string' && typeof p.id === 'string' && !ADMIN.has(p.source)) {
          const e = installedList.concat(home?.featured || []).find((x) => x.sources.some((s) => s.source === p.source && s.id === p.id));
          const ue = updates.items.find((u) => u.source === p.source && u.id === p.id);
          op = { key: e?.key || ue?.key || p.id.toLowerCase(), source: p.source, id: p.id, action: p.kind, percent: 0, step: '', cancelable: (p.kind === 'install' || p.kind === 'update') && !!sources.find((x) => x.id === p.source)?.cancelable, canceling: !!p.canceling, adopted: true };
          render();
        }
        if (op?.adopted && p?.kind === op.action && p.source === op.source && p.id === op.id) {
          op.percent = Math.max(op.percent, Math.round(Number(p.percent) || 0));
          if (p.canceling && !op.canceling) markCanceling();
          op.step = op.canceling ? t('canceling') : stepText(op.action, detail?.data?.entry?.key === op.key ? detail.data.entry.name : updates.items.find((u) => u.key === op.key)?.name || op.id);
          updateProgress();
          return;
        }
        if (p?.kind !== 'refresh' || !p.source) return;
        refreshPct.set(p.source, Number(p.percent) || 0);
        updateRefresh();
      }),
    ];
    win.on('close', () => offs.forEach((off) => off?.()));

    content.append(h('div', { class: 'st-loading' }, h('div', { class: 'spinner' })));
    await loadAll();
    await adoptCurrent();
    const a = ctx.args && typeof ctx.args === 'object' ? ctx.args : {};
    const findKey = (id) => {
      if (typeof id !== 'string' || !id) return null;
      const lower = id.toLowerCase();
      const all = [...(home?.featured || []), ...(home?.picks || []), ...(home?.tools || []), ...(home?.rows || []).flatMap((r) => r.items), ...installedList];
      const hit = all.find((e) => e.key === lower || e.key === id || e.sources.some((s) => s.id === id));
      return hit ? hit.key : lower.includes('.') ? lower : `selene:${id}`;
    };
    function applyArgs(args, push) {
      if (typeof args?.id === 'string' && args.id) go({ kind: 'detail', key: findKey(args.id) }, { push });
      else if (['installed', 'sources', 'categories', 'updates'].includes(args?.view)) go({ kind: args.view }, { push });
      else if (typeof args?.query === 'string' && args.query.trim()) {
        searchInput.value = args.query.trim().slice(0, 200);
        query = searchInput.value;
        if (push && view.kind !== 'search') history.push(view);
        view = { kind: 'search' };
        loadList(true);
      } else render();
    }
    applyArgs(a, false);
    // First run: download the catalogues of enabled sources that have none yet.
    for (const s of sources) if (s.enabled && s.available && !s.ready && !s.missing && s.id !== 'selene') refreshSource(s.id);
    setTimeout(() => (view.kind === 'detail' ? content.querySelector('.st-actions .btn') : searchInput)?.focus(), 50);

    return {
      onRelaunch(args) {
        applyArgs(args || {}, true);
        win.focus();
      },
      get state() {
        return { view, query, op, sources, live, installed: installedList.map((e) => e.key), listCount: list?.items.length || 0, listTotal: list?.total || 0, updates: updates.items.map((u) => u.id), updatesCount: updates.count, batch };
      },
    };
  },
};
