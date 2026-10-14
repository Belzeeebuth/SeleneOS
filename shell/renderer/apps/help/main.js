// Aide (Help): offline help for Selene OS — home (search, « Bien démarrer », topics), topic lists, articles with
// back / forward history and « Articles liés », search that ignores accents and case, the « Bien démarrer » tour.
//   shell.launch('help', { article: 'wifi' } | { topic: 'network' } | { tour: true, step } | { search: 'imprimante' })
// Content: content/*.js (en + fr, inline markup described in lib.js). Article actions open the right place
// (Paramètres pages from apps/settings/lib/index.js, other apps by id) and hide themselves when the target is
// missing; articles about optional apps / features (`requires`) are hidden when these are absent.
// The shortcut article is built live from core/shortcuts.js and the user's settings.shortcuts.
// Keys: F1 = search box (while the Help window is active), Alt+Left / Alt+Right = back / forward,
// mouse back / forward buttons too; in the tour, Left / Right = previous / next step.
import { TOPICS, ARTICLES, TOUR } from './content/index.js';
import { parseInline, buildIndex, search, isVisible, resolveFind } from './lib.js';
import { SHORTCUTS, SHORTCUT_GROUPS, FIXED_COMBOS, effectiveShortcuts, comboKeys, appOfAction } from '../../core/shortcuts.js';

// Fixed combos the shortcut article explains (core/shortcuts.js FIXED_COMBOS; only those still in that set are shown).
const FIXED_INFO = [
  ['Alt+Tab', 'altTab'],
  ['Alt+Shift+Tab', 'altShiftTab'],
  ['Ctrl+Alt+Tab', 'ctrlAltTab'],
  ['Ctrl+Alt+Delete', 'ctrlAltDelete'],
  ['PrintScreen', 'printScreen'],
];

export default {
  async launch(ctx) {
    const { win, h, icon, t, shell, settings } = ctx;
    const registry = shell.registry;
    const L = (o) => (o && typeof o === 'object' ? (o[ctx.lang] ?? o.en ?? '') : (o ?? ''));
    const byId = new Map(ARTICLES.map((a) => [a.id, a]));
    const topicById = new Map(TOPICS.map((tp) => [tp.id, tp]));

    // Settings page registry (titles, breadcrumbs, search entries): the source of truth for « Paramètres » actions.
    const st = await import('../settings/lib/index.js').catch(() => null);

    // ------------------------------------------------------------------ what exists on this computer
    const hasApp = (id) => {
      const m = registry.get(id);
      return !!m && m.kind !== 'linux';
    };
    function findEnv() {
      return {
        hasApp,
        shortcuts: SHORTCUTS,
        bindings: shell.hotkeys?.effective || {},
        settingsEntries: st?.INDEX || [],
      };
    }
    const visible = (a) => !!a && isVisible(a, findEnv());
    const visibleArticles = () => ARTICLES.filter(visible);
    const topicArticles = (id) => visibleArticles().filter((a) => a.topic === id);

    /** Action spec -> { label, run, kind, data } or null when its target is missing. */
    function resolveAction(spec) {
      if (!spec) return null;
      if (spec.tour) return { kind: 'tour', label: L(spec.label) || t('tourStart'), icon: 'rocket-launch', run: () => navigate({ view: 'tour', step: 0 }), data: { tour: '1' } };
      if (spec.article) {
        const a = byId.get(spec.article);
        return visible(a) ? { kind: 'article', label: L(spec.label) || L(a.title), icon: 'book-open', run: () => openArticle(a.id), data: { article: a.id } } : null;
      }
      const app = spec.app;
      if (!app || !hasApp(app)) return null;
      if (app === 'settings') {
        const page = spec.args?.page;
        if (page && !st?.PAGES?.[page]) return null;
        const path = page ? st.crumbs(page).map((p) => L(st.PAGES[p].title)).join(' › ') : '';
        return {
          kind: 'settings',
          label: L(spec.label) || (path ? t('openSettings', { path }) : t('openApp', { app: registry.name('settings') })),
          img: registry.iconUrl('settings'),
          run: () => shell.launch('settings', { ...(spec.args || {}) }),
          data: { app: 'settings', page: page || '', section: spec.args?.section || '' },
        };
      }
      return {
        kind: 'app',
        label: L(spec.label) || t('openApp', { app: registry.name(app) }),
        img: registry.iconUrl(app),
        run: () => shell.launch(app, spec.args ? { ...spec.args } : undefined),
        data: { app },
      };
    }

    // ------------------------------------------------------------------ layout
    const btnBack = h('button', { class: 'btn subtle hp-iconbtn', type: 'button', 'aria-label': t('back'), title: t('back'), onclick: () => go(-1) }, icon('arrow-left', { size: 16 }));
    const btnFwd = h('button', { class: 'btn subtle hp-iconbtn', type: 'button', 'aria-label': t('forward'), title: t('forward'), onclick: () => go(1) }, icon('arrow-right', { size: 16 }));
    const btnHome = h('button', { class: 'btn subtle hp-iconbtn', type: 'button', 'aria-label': t('home'), title: t('home'), onclick: () => navigate({ view: 'home' }) }, icon('house-simple', { size: 16 }));
    const searchInput = h('input', {
      class: 'input hp-search-input',
      type: 'search',
      spellcheck: false,
      autocomplete: 'off',
      placeholder: t('searchHint'),
      'aria-label': t('search'),
    });
    const clearBtn = h('button', { class: 'btn subtle hp-iconbtn hp-search-clear', type: 'button', 'aria-label': t('clearSearch'), title: t('clearSearch'), hidden: true, onclick: () => clearSearch(true) }, icon('x', { size: 14 }));
    const searchBox = h('div', { class: 'hp-search', role: 'search' }, h('span', { class: 'hp-search-icon', 'aria-hidden': 'true' }, icon('magnifying-glass', { size: 16 })), searchInput, clearBtn);
    const bar = h('div', { class: 'hp-bar' }, h('div', { class: 'hp-nav' }, btnBack, btnFwd, btnHome), searchBox);
    const main = h('div', { class: 'hp-main', tabindex: '-1' });
    const live = h('div', { class: 'hp-sr', 'aria-live': 'polite', role: 'status' });
    const root = h('div', { class: 'hp' }, bar, main, live);
    win.body.appendChild(root);

    // ------------------------------------------------------------------ history
    let hist = [];
    let pos = -1;
    let current = null;
    const same = (a, b) => a && b && a.view === b.view && a.id === b.id && a.q === b.q;
    function navigate(state, { push = true, focus = true } = {}) {
      if (push && !(current && same(current, state) && state.view !== 'tour')) {
        hist = hist.slice(0, pos + 1);
        hist.push(state);
        pos = hist.length - 1;
      } else if (pos >= 0) hist[pos] = state;
      else {
        hist = [state];
        pos = 0;
      }
      render(state, { focus });
    }
    function go(delta) {
      const p = pos + delta;
      if (p < 0 || p >= hist.length) return;
      pos = p;
      render(hist[pos], { focus: true });
    }
    function updateNav() {
      btnBack.disabled = pos <= 0;
      btnFwd.disabled = pos >= hist.length - 1;
    }
    const openArticle = (id) => navigate({ view: 'article', id });
    const openTopic = (id) => navigate({ view: 'topic', id });

    // ------------------------------------------------------------------ rendering helpers
    function keyCaps(combo) {
      const keys = comboKeys(combo, ctx.lang);
      const el = h('kbd', { class: 'hp-combo', 'aria-label': keys.join(' + ') });
      keys.forEach((k, i) => {
        if (i) el.appendChild(h('span', { class: 'hp-plus', 'aria-hidden': 'true' }, '+'));
        el.appendChild(h('kbd', { 'aria-hidden': 'true' }, k));
      });
      return el;
    }
    function effective() {
      return effectiveShortcuts(settings.get('shortcuts') || {});
    }
    function scCaps(id) {
      const combo = effective()[id];
      if (combo) return keyCaps(combo);
      return h('em', { class: 'hp-off' }, SHORTCUTS.some((s) => s.id === id) ? t('shortcutOff') : t('noShortcut'));
    }
    function inline(str) {
      const frag = document.createDocumentFragment();
      for (const tk of parseInline(str)) {
        if (tk.t === 'text') frag.appendChild(document.createTextNode(tk.v));
        else if (tk.t === 'b') frag.appendChild(h('strong', null, tk.v));
        else if (tk.t === 'keys') frag.appendChild(keyCaps(tk.v));
        else if (tk.t === 'sc') frag.appendChild(scCaps(tk.v));
        else if (tk.t === 'link') {
          const a = byId.get(tk.v);
          const label = tk.label || (a ? L(a.title) : tk.v);
          if (visible(a))
            frag.appendChild(
              h('a', { class: 'hp-link', href: '#', dataset: { article: a.id }, onclick: (e) => (e.preventDefault(), openArticle(a.id)) }, label),
            );
          else frag.appendChild(document.createTextNode(label));
        }
      }
      return frag;
    }
    function actionButtons(ids, actions) {
      const btns = [];
      for (const id of ids) {
        const r = resolveAction(actions?.[id]);
        if (!r) continue;
        btns.push(
          h(
            'button',
            { class: 'btn hp-action', type: 'button', dataset: { action: id, kind: r.kind, ...r.data }, onclick: r.run },
            r.img ? h('img', { class: 'hp-action-img', src: r.img, alt: '' }) : icon(r.icon || 'arrow-square-out', { size: 16 }),
            h('span', null, r.label),
          ),
        );
      }
      return btns.length ? h('div', { class: 'hp-actions' }, btns) : null;
    }
    function renderBlocks(blocks, owner) {
      const out = [];
      for (const b of blocks || []) {
        if (typeof b === 'string') out.push(h('p', null, inline(b)));
        else if (!b || typeof b !== 'object') continue;
        else if (b.h) out.push(h('h2', { class: 'hp-h2' }, inline(b.h)));
        else if (b.steps) out.push(h('ol', { class: 'hp-steps' }, b.steps.map((s) => h('li', null, inline(s)))));
        else if (b.list) out.push(h('ul', { class: 'hp-list' }, b.list.map((s) => h('li', null, inline(s)))));
        else if (b.tip) out.push(h('div', { class: 'hp-callout tip' }, h('span', { class: 'hp-callout-icon', 'aria-hidden': 'true' }, icon('lightbulb', { size: 18 })), h('div', null, inline(b.tip))));
        else if (b.note) out.push(h('div', { class: 'hp-callout note' }, h('span', { class: 'hp-callout-icon', 'aria-hidden': 'true' }, icon('info', { size: 18 })), h('div', null, inline(b.note))));
        else if (b.action || b.actions) {
          const el = actionButtons(b.actions || [b.action], owner?.actions);
          if (el) out.push(el);
        } else if (b.shortcuts) out.push(shortcutTables());
        else if (b.howto) {
          const el = howto(owner);
          if (el) out.push(el);
        }
      }
      return out;
    }

    // How to open a feature built by another part of Selene (found at run time: app, shortcut, Settings entry).
    function howto(article) {
      const found = resolveFind(article?.find, findEnv());
      if (!found) return null;
      const rows = [];
      if (found.shortcut || found.combo) {
        rows.push(h('p', { class: 'hp-howto-keys' }, h('span', null, t('howtoKeys'), ' '), found.shortcut ? scCaps(found.shortcut.id) : keyCaps(found.combo)));
      }
      const actions = {};
      const ids = [];
      if (found.app) {
        actions.app = { app: found.app };
        ids.push('app');
      }
      if (found.settings) {
        actions.settings = { app: 'settings', args: { page: found.settings.page, ...(found.settings.section ? { section: found.settings.section } : {}) } };
        ids.push('settings');
      }
      const btns = actionButtons(ids, actions);
      if (btns) rows.push(btns);
      return rows.length ? h('div', { class: 'hp-howto' }, rows) : null;
    }

    // The live shortcut list: the catalog groups with the combos in effect (the user's changes marked), the user's
    // « open this app » shortcuts, the fixed combos, and the Help window's own keys.
    function shortcutTables() {
      const own = settings.get('shortcuts') || {};
      const eff = effective();
      const box = h('div', { class: 'hp-sc' });
      const table = (caption, rows) =>
        h(
          'table',
          { class: 'hp-sc-table' },
          h('caption', null, caption),
          h('thead', { class: 'hp-sr-only' }, h('tr', null, h('th', { scope: 'col' }, t('scColumnAction')), h('th', { scope: 'col' }, t('scColumnKeys')))),
          h('tbody', null, rows),
        );
      for (const g of SHORTCUT_GROUPS) {
        const rows = SHORTCUTS.filter((s) => s.group === g.id).map((s) => {
          const changed = Object.prototype.hasOwnProperty.call(own, s.id) && own[s.id] !== s.combo;
          return h(
            'tr',
            { dataset: { sc: s.id, combo: eff[s.id] || '' } },
            h('th', { scope: 'row' }, L(s.name), changed ? h('span', { class: 'hp-badge', title: t('changedTip') }, t('changed')) : null),
            h('td', null, eff[s.id] ? keyCaps(eff[s.id]) : h('em', { class: 'hp-off' }, s.combo ? t('shortcutOff') : t('noShortcut'))),
          );
        });
        if (rows.length) box.appendChild(table(L(g.name), rows));
      }
      const appRows = Object.entries(eff)
        .filter(([id]) => appOfAction(id) && registry.get(appOfAction(id)))
        .map(([id, combo]) => h('tr', { dataset: { sc: id, combo } }, h('th', { scope: 'row' }, t('openAppShortcut', { app: registry.name(appOfAction(id)) })), h('td', null, keyCaps(combo))));
      if (appRows.length) box.appendChild(table(t('scApps'), appRows));
      const fixed = FIXED_INFO.filter(([c]) => FIXED_COMBOS.has(c)).map(([c, k]) => h('tr', { dataset: { combo: c } }, h('th', { scope: 'row' }, t(`fixed.${k}`)), h('td', null, keyCaps(c))));
      if (fixed.length) {
        box.appendChild(h('p', { class: 'hp-sc-intro' }, t('scFixedIntro')));
        box.appendChild(table(t('scFixed'), fixed));
      }
      box.appendChild(
        table(t('scInHelp'), [
          h('tr', null, h('th', { scope: 'row' }, t('inHelp.f1')), h('td', null, keyCaps('F1'))),
          h('tr', null, h('th', { scope: 'row' }, t('inHelp.back')), h('td', null, keyCaps('Alt+ArrowLeft'))),
          h('tr', null, h('th', { scope: 'row' }, t('inHelp.forward')), h('td', null, keyCaps('Alt+ArrowRight'))),
        ]),
      );
      return box;
    }

    const crumbBar = (items) =>
      h(
        'nav',
        { class: 'hp-crumbs', 'aria-label': t('appName') },
        items.map((it, i) => [
          i ? h('span', { class: 'hp-crumb-sep', 'aria-hidden': 'true' }, icon('caret-right', { size: 12 })) : null,
          it.onClick ? h('a', { class: 'hp-crumb', href: '#', onclick: (e) => (e.preventDefault(), it.onClick()) }, it.label) : h('span', { class: 'hp-crumb current', 'aria-current': 'page' }, it.label),
        ]),
      );
    const articleRow = (a, extra) =>
      h(
        'button',
        { class: 'hp-row', type: 'button', dataset: { article: a.id }, onclick: () => openArticle(a.id) },
        h('span', { class: 'hp-row-icon', 'aria-hidden': 'true' }, icon(topicById.get(a.topic)?.icon || 'book-open', { size: 18 })),
        h('span', { class: 'hp-row-text' }, h('span', { class: 'hp-row-title' }, L(a.title)), h('span', { class: 'hp-row-sub' }, extra ? [h('span', { class: 'hp-row-topic' }, extra), ' · '] : null, L(a.summary))),
        h('span', { class: 'hp-row-caret', 'aria-hidden': 'true' }, icon('caret-right', { size: 14 })),
      );

    // ------------------------------------------------------------------ views
    function viewHome() {
      const tiles = TOPICS.map((tp) => ({ tp, n: topicArticles(tp.id).length }))
        .filter((x) => x.n > 0)
        .map(({ tp, n }) =>
          h(
            'button',
            { class: 'hp-tile', type: 'button', dataset: { topic: tp.id }, onclick: () => openTopic(tp.id) },
            h('span', { class: 'hp-tile-icon', 'aria-hidden': 'true' }, icon(tp.icon, { size: 22 })),
            h('span', { class: 'hp-tile-title' }, L(tp.title)),
            h('span', { class: 'hp-tile-sub' }, L(tp.desc)),
            h('span', { class: 'hp-tile-count' }, t('articles', { count: n })),
          ),
        );
      return h(
        'div',
        { class: 'hp-page hp-home' },
        h('header', { class: 'hp-hero' }, h('h1', { class: 'hp-title' }, t('homeTitle')), h('p', { class: 'hp-lead' }, t('homeIntro'))),
        h(
          'section',
          { class: 'hp-tourcard', 'aria-labelledby': 'hp-tourcard-title' },
          illustration('bar', { mini: true }),
          h(
            'div',
            { class: 'hp-tourcard-text' },
            h('h2', { class: 'hp-tourcard-title', id: 'hp-tourcard-title' }, t('tourTitle')),
            h('p', null, t('tourIntro', { count: TOUR.length })),
            h('button', { class: 'btn primary hp-tour-start', type: 'button', onclick: () => navigate({ view: 'tour', step: 0 }) }, icon('rocket-launch', { size: 16 }), h('span', null, t('tourStart'))),
          ),
        ),
        h('h2', { class: 'hp-section-title' }, t('topics')),
        h('div', { class: 'hp-tiles' }, tiles),
      );
    }

    function viewTopic(id) {
      const tp = topicById.get(id);
      if (!tp) return viewMissing();
      win.setTitle(`${t('appName')} – ${L(tp.title)}`);
      return h(
        'div',
        { class: 'hp-page hp-topic', dataset: { topic: id } },
        crumbBar([{ label: t('appName'), onClick: () => navigate({ view: 'home' }) }, { label: L(tp.title) }]),
        h('h1', { class: 'hp-title' }, L(tp.title)),
        h('p', { class: 'hp-lead' }, L(tp.desc)),
        h('div', { class: 'hp-rows' }, topicArticles(id).map((a) => articleRow(a))),
      );
    }

    function viewArticle(id) {
      const a = byId.get(id);
      if (!visible(a)) return viewMissing();
      const tp = topicById.get(a.topic);
      win.setTitle(`${t('appName')} – ${L(a.title)}`);
      const related = (a.related || []).map((r) => byId.get(r)).filter(visible);
      return h(
        'article',
        { class: 'hp-page hp-article', dataset: { article: a.id } },
        // (an article named like its topic — « Raccourcis clavier » — does not repeat the name)
        crumbBar([{ label: t('appName'), onClick: () => navigate({ view: 'home' }) }, ...(L(tp?.title) === L(a.title) ? [{ label: L(a.title) }] : [{ label: L(tp?.title), onClick: () => openTopic(a.topic) }, { label: L(a.title) }])]),
        h('h1', { class: 'hp-title' }, L(a.title)),
        h('p', { class: 'hp-lead' }, inline(L(a.summary))),
        h('div', { class: 'hp-body' }, renderBlocks(a.body?.[ctx.lang] || a.body?.en, a)),
        related.length
          ? h('section', { class: 'hp-related', 'aria-labelledby': 'hp-related-title' }, h('h2', { class: 'hp-section-title', id: 'hp-related-title' }, t('related')), h('div', { class: 'hp-rows' }, related.map((r) => articleRow(r, L(topicById.get(r.topic)?.title)))))
          : null,
      );
    }

    function viewMissing() {
      return h('div', { class: 'hp-page' }, h('div', { class: 'empty hp-empty' }, icon('question', { size: 40 }), h('p', null, t('notFound')), h('button', { class: 'btn', type: 'button', onclick: () => navigate({ view: 'home' }) }, t('home'))));
    }

    // Search index for the current language (visible articles only; rebuilt when the language, the apps or the
    // shortcuts change). The shortcut article also matches the names of every catalog action.
    let index = null;
    function getIndex() {
      if (index && index.lang === ctx.lang) return index.entries;
      const entries = buildIndex(visibleArticles(), ctx.lang, {
        topicTitle: (id, lang) => topicById.get(id)?.title?.[lang] || '',
        titleOf: (id, lang) => byId.get(id)?.title?.[lang] || '',
        extra: (a, lang) =>
          (a.body?.[lang] || []).some((b) => b && b.shortcuts)
            ? [...SHORTCUTS.map((s) => s.name[lang] || s.name.en), ...FIXED_INFO.map(([, k]) => t(`fixed.${k}`))].join(' ')
            : '',
      });
      index = { lang: ctx.lang, entries };
      return entries;
    }
    const resetIndex = () => (index = null);

    function viewSearch(q) {
      win.setTitle(`${t('appName')} – ${q}`);
      const res = search(getIndex(), q);
      const rows = res.map((r) => byId.get(r.id)).filter(Boolean);
      live.textContent = rows.length ? t('resultsCount', { count: rows.length }) : t('noResults', { query: q });
      const page = h('div', { class: 'hp-page hp-results', dataset: { query: q } }, h('h1', { class: 'hp-title' }, t('results', { query: q })));
      if (!rows.length) {
        page.appendChild(
          h(
            'div',
            { class: 'hp-noresults' },
            h('p', null, t('noResults', { query: q })),
            h('p', { class: 'text-2' }, t('noResultsHint')),
            h('button', { class: 'btn', type: 'button', onclick: () => clearSearch(true) }, t('browseTopics')),
          ),
        );
        return page;
      }
      page.appendChild(h('p', { class: 'hp-lead' }, res.partial ? t('partial') : t('resultsCount', { count: rows.length })));
      page.appendChild(h('div', { class: 'hp-rows', dataset: { partial: res.partial ? '1' : '0' } }, rows.map((a) => articleRow(a, L(topicById.get(a.topic)?.title)))));
      return page;
    }

    // ------------------------------------------------------------------ tour « Bien démarrer »
    function illustration(focus, { mini = false } = {}) {
      const win1 = h(
        'div',
        { class: 'hp-ill-win w1' },
        h('div', { class: 'hp-ill-tb' }, h('i'), h('i'), h('i')),
        h('div', { class: 'hp-ill-lines' }, h('i'), h('i'), h('i')),
        h('div', { class: 'hp-ill-grid' }, Array.from({ length: 12 }, () => h('i'))),
      );
      const win2 = h('div', { class: 'hp-ill-win w2' }, h('div', { class: 'hp-ill-tb' }, h('i'), h('i'), h('i')), h('div', { class: 'hp-ill-grid' }, h('i'), h('i'), h('i'), h('i'), h('i'), h('i')));
      const launcher = h('div', { class: 'hp-ill-launcher' }, h('div', { class: 'hp-ill-search' }), h('div', { class: 'hp-ill-grid' }, Array.from({ length: 8 }, () => h('i'))));
      const panel = h(
        'div',
        { class: 'hp-ill-panel' },
        h('div', { class: 'hp-ill-tiles' }, ['wifi-high', 'bluetooth', 'moon', 'bell-slash'].map((n) => h('span', null, icon(n, { size: 12 })))),
        h('div', { class: 'hp-ill-slider' }, h('i')),
        h('div', { class: 'hp-ill-slider' }, h('i')),
      );
      const bar = h(
        'div',
        { class: 'hp-ill-bar' },
        h('div', { class: 'hp-ill-left' }, h('span', { class: 'hp-ill-moon' }, icon('moon-stars', { size: 12 })), h('span', { class: 'hp-ill-field' })),
        h('div', { class: 'hp-ill-apps' }, ['folder-simple', 'globe-simple', 'storefront', 'gear-six'].map((n) => h('span', { dataset: { app: n } }, icon(n, { size: 12 })))),
        h('div', { class: 'hp-ill-right' }, icon('wifi-high', { size: 11 }), icon('speaker-high', { size: 11 }), h('span', { class: 'hp-ill-clock' })),
      );
      return h('div', { class: ['hp-ill', mini ? 'mini' : ''], dataset: { focus }, 'aria-hidden': 'true' }, h('div', { class: 'hp-ill-screen' }, win1, win2, launcher, panel, bar));
    }

    function viewTour(step) {
      const n = Math.max(0, Math.min(TOUR.length - 1, Number(step) || 0));
      const s = TOUR[n];
      win.setTitle(`${t('appName')} – ${t('tourTitle')}`);
      const last = n === TOUR.length - 1;
      const toStep = (k) => navigate({ view: 'tour', step: k }, { push: false });
      const dots = h(
        'div',
        { class: 'hp-dots', role: 'group', 'aria-label': t('tourNav') },
        TOUR.map((x, i) =>
          h('button', { class: ['hp-dot', i === n ? 'on' : ''], type: 'button', 'aria-label': t('goToStep', { n: i + 1, title: L(x.title) }), 'aria-current': i === n ? 'step' : null, onclick: () => toStep(i) }),
        ),
      );
      const prev = h('button', { class: 'btn hp-tour-prev', type: 'button', disabled: n === 0, onclick: () => toStep(n - 1) }, icon('arrow-left', { size: 16 }), h('span', null, t('prev')));
      const next = h(
        'button',
        { class: 'btn primary hp-tour-next', type: 'button', onclick: () => (last ? navigate({ view: 'home' }) : toStep(n + 1)) },
        h('span', null, last ? t('finish') : t('next')),
        last ? icon('check', { size: 16 }) : icon('arrow-right', { size: 16 }),
      );
      return h(
        'div',
        { class: 'hp-page hp-tour', dataset: { step: String(n), stepId: s.id } },
        h(
          'div',
          { class: 'hp-tour-head' },
          h('div', null, h('div', { class: 'hp-tour-kicker' }, t('tourTitle')), h('div', { class: 'hp-tour-count' }, t('step', { n: n + 1, total: TOUR.length }))),
          h('button', { class: 'btn subtle hp-tour-leave', type: 'button', onclick: () => navigate({ view: 'home' }) }, icon('x', { size: 14 }), h('span', null, t('leaveTour'))),
        ),
        h(
          'div',
          { class: 'hp-tour-card' },
          illustration(s.focus),
          h(
            'div',
            { class: 'hp-tour-text' },
            h('span', { class: 'hp-tour-badge', 'aria-hidden': 'true' }, icon(s.icon, { size: 22 })),
            h('h1', { class: 'hp-title', tabindex: '-1' }, L(s.title)),
            renderBlocks(s.body?.[ctx.lang] || s.body?.en, s),
          ),
        ),
        h('div', { class: 'hp-tour-nav' }, prev, dots, next),
      );
    }

    function render(state, { focus = true, keepScroll = false } = {}) {
      current = state;
      const top = main.scrollTop;
      let node;
      win.setTitle(t('appName'));
      if (state.view === 'article') node = viewArticle(state.id);
      else if (state.view === 'topic') node = viewTopic(state.id);
      else if (state.view === 'search') node = viewSearch(state.q);
      else if (state.view === 'tour') node = viewTour(state.step);
      else node = viewHome();
      main.replaceChildren(node);
      main.dataset.view = state.view;
      if (state.view !== 'search' && document.activeElement !== searchInput) {
        searchInput.value = '';
        clearBtn.hidden = true;
      }
      main.scrollTop = keepScroll ? top : 0;
      updateNav();
      if (focus && document.activeElement !== searchInput) {
        const target = state.view === 'tour' ? node.querySelector('.hp-tour-next') : main;
        target?.focus({ preventScroll: true });
      }
    }

    // ------------------------------------------------------------------ search box
    let timer = null;
    function runSearch() {
      clearTimeout(timer);
      const q = searchInput.value.trim();
      clearBtn.hidden = !searchInput.value;
      if (!q) {
        if (current?.view === 'search') go(-1);
        return;
      }
      // typing refines the current results page instead of piling up history
      navigate({ view: 'search', q }, { push: current?.view !== 'search', focus: false });
    }
    function clearSearch(focusInput) {
      searchInput.value = '';
      clearBtn.hidden = true;
      if (current?.view === 'search') {
        // back to where the search started from
        let p = pos;
        while (p > 0 && hist[p].view === 'search') p--;
        pos = p;
        if (hist[pos].view === 'search') navigate({ view: 'home' }, { push: false });
        else render(hist[pos], { focus: false });
      }
      if (focusInput) searchInput.focus();
    }
    searchInput.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(runSearch, 160);
    });
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        runSearch();
        main.querySelector('.hp-rows .hp-row')?.focus();
      } else if (e.key === 'Escape' && searchInput.value) {
        e.preventDefault();
        e.stopPropagation();
        clearSearch(true);
      } else if (e.key === 'ArrowDown') {
        const first = main.querySelector('.hp-results .hp-row');
        if (first) {
          e.preventDefault();
          first.focus();
        }
      }
    });
    const focusSearch = () => {
      searchInput.focus();
      searchInput.select();
    };

    // ------------------------------------------------------------------ keyboard / mouse
    const typing = (el) => el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
    function onKey(e) {
      if (shell.wm?.focused?.() !== win) return;
      if (e.key === 'F1' && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        e.stopPropagation();
        focusSearch();
      }
    }
    window.addEventListener('keydown', onKey, true);
    root.addEventListener('keydown', (e) => {
      if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault();
        go(e.key === 'ArrowLeft' ? -1 : 1);
        return;
      }
      if (current?.view === 'tour' && !typing(e.target) && !e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        const n = Number(current.step) || 0;
        const k = e.key === 'ArrowLeft' ? n - 1 : n + 1;
        if (k >= 0 && k < TOUR.length) {
          e.preventDefault();
          navigate({ view: 'tour', step: k }, { push: false });
        }
      }
      // arrows move between result / article rows
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && e.target.classList?.contains('hp-row')) {
        const rows = [...main.querySelectorAll('.hp-row')];
        const i = rows.indexOf(e.target);
        const nx = rows[i + (e.key === 'ArrowDown' ? 1 : -1)];
        if (nx) {
          e.preventDefault();
          nx.focus();
        } else if (e.key === 'ArrowUp' && current?.view === 'search') {
          e.preventDefault();
          searchInput.focus();
        }
      }
    });
    root.addEventListener('mouseup', (e) => {
      if (e.button === 3 || e.button === 4) {
        e.preventDefault();
        go(e.button === 3 ? -1 : 1);
      }
    });

    // ------------------------------------------------------------------ live updates
    const rerender = () => {
      resetIndex();
      if (current) render(current, { focus: false, keepScroll: true });
    };
    const offShortcuts = settings.on?.('shortcuts', rerender);
    const onApps = () => rerender();
    window.addEventListener('aurora:apps-changed', onApps);
    ctx.onLangChange(() => {
      searchInput.placeholder = t('searchHint');
      searchInput.setAttribute('aria-label', t('search'));
      for (const [b, k] of [[btnBack, 'back'], [btnFwd, 'forward'], [btnHome, 'home'], [clearBtn, 'clearSearch']]) {
        b.setAttribute('aria-label', t(k));
        b.title = t(k);
      }
      rerender();
    });
    ctx.onClose(() => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('aurora:apps-changed', onApps);
      if (typeof offShortcuts === 'function') offShortcuts();
      clearTimeout(timer);
    });

    // ------------------------------------------------------------------ start
    function openFromArgs(args, { push }) {
      const a = args || {};
      if (a.tour) return navigate({ view: 'tour', step: Number(a.step) || 0 }, { push });
      if (typeof a.article === 'string' && byId.has(a.article)) return navigate({ view: 'article', id: a.article }, { push });
      if (typeof a.topic === 'string' && topicById.has(a.topic)) return navigate({ view: 'topic', id: a.topic }, { push });
      if (typeof a.search === 'string' && a.search.trim()) {
        searchInput.value = a.search;
        clearBtn.hidden = false;
        return navigate({ view: 'search', q: a.search.trim() }, { push });
      }
      if (!push) navigate({ view: 'home' }, { push: false });
    }
    navigate({ view: 'home' }, { push: true, focus: false });
    openFromArgs(ctx.args, { push: true });

    // tests / debugging
    const api = {
      navigate,
      back: () => go(-1),
      forward: () => go(1),
      get state() {
        return current;
      },
      get history() {
        return { entries: hist.map((x) => ({ ...x })), pos };
      },
      search: (q) => search(getIndex(), q).map((r) => r.id),
      visibleIds: () => visibleArticles().map((a) => a.id),
      focusSearch,
    };
    win.body.__help = api;
    return {
      onRelaunch(args) {
        openFromArgs(args, { push: true });
      },
    };
  },
};
