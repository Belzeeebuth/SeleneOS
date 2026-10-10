// Settings > Apps: Installed apps, Default apps.
import { PAGES } from '../lib/index.js';

const CATS = ['system', 'utilities', 'productivity', 'internet', 'media', 'games'];

async function apps(pc) {
  const { h, kit, L } = pc;
  return h('div', null, kit.group(null, ...['installedApps', 'defaultApps'].map((id) => kit.row({ icon: PAGES[id].icon, title: L(PAGES[id].title), desc: L(PAGES[id].desc), onClick: () => pc.go(id) }))));
}

function catLabel(pc, c) {
  return CATS.includes(c) ? pc.t(`apps.cat_${c}`) : pc.t('apps.cat_other');
}

// ------------------------------------------------------------------ Installed apps
async function installedApps(pc) {
  const { h, t, kit, ui, icon, settings, L } = pc;
  const registry = pc.shell.registry;
  const all = registry.list({ includeHidden: false });
  let query = '';
  let sort = 'az';
  let cat = 'all';
  const input = h('input', { class: 'input', type: 'search', placeholder: t('apps.search'), 'aria-label': t('apps.search') });
  const count = h('div', { class: 'caption text-2' });
  const list = h('div', { class: 'st-group-rows' });
  const norm = (s) =>
    String(s || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '');

  const pinned = (key, id) => (settings.get(key) || []).includes(id);
  const togglePin = (key, id) => {
    const cur = settings.get(key) || [];
    return settings.set(key, cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]);
  };

  function paint() {
    const q = norm(query);
    let items = all.filter((m) => {
      if (cat !== 'all' && (CATS.includes(m.category) ? m.category : 'other') !== cat) return false;
      if (!q) return true;
      return norm(L(m.name)).includes(q) || norm(L(m.description)).includes(q) || [...(m.keywords?.[pc.lang] || []), ...(m.keywords?.en || [])].some((k) => norm(k).includes(q));
    });
    items = items.sort((a, b) => {
      if (sort === 'cat') return catLabel(pc, a.category).localeCompare(catLabel(pc, b.category), pc.i18n.locale) || L(a.name).localeCompare(L(b.name), pc.i18n.locale);
      const r = L(a.name).localeCompare(L(b.name), pc.i18n.locale);
      return sort === 'za' ? -r : r;
    });
    count.textContent = t('apps.found', { count: items.length });
    ui.clear(list);
    if (!items.length) list.append(h('div', { class: 'st-empty' }, icon('apps_list', { size: 36 }), h('div', null, t('apps.none'))));
    for (const m of items) {
      const more = h('button', {
        class: 'btn subtle icon-btn',
        type: 'button',
        'aria-label': t('apps.moreFor', { name: L(m.name) }),
        'data-tip': t('common.more'),
        onclick: (e) =>
          ui.menu(e, [
            { label: t('common.open'), icon: 'open', action: () => pc.shell.launch(m.id) },
            '-',
            { label: pinned('startPinned', m.id) ? t('apps.unpinStart') : t('apps.pinStart'), icon: 'pin', action: () => togglePin('startPinned', m.id) },
            { label: pinned('pinned', m.id) ? t('apps.unpinTaskbar') : t('apps.pinTaskbar'), icon: 'pin', action: () => togglePin('pinned', m.id) },
            ...(m.fileTypes?.length ? ['-', { label: t('apps.setDefaults'), icon: 'apps_settings', action: () => pc.go('defaultApps') }] : []),
          ]),
      });
      more.appendChild(icon('more_horizontal', { size: 16 }));
      list.appendChild(
        kit.row({
          icon: h('img', { class: 'st-app-icon', src: registry.iconUrl(m.id), alt: '', draggable: false }),
          title: L(m.name),
          desc: [catLabel(pc, m.category), L(m.description)].filter(Boolean).join(' · '),
          control: h('div', { class: 'row', style: { gap: '8px' } }, h('span', { class: 'st-pill' }, t('apps.builtIn')), more),
        }),
      );
    }
  }
  input.addEventListener('input', () => {
    query = input.value;
    paint();
  });
  const sortCombo = kit.combo({
    options: [
      { value: 'az', label: t('apps.sortAz') },
      { value: 'za', label: t('apps.sortZa') },
      { value: 'cat', label: t('apps.sortCat') },
    ],
    value: sort,
    label: t('apps.sortBy'),
    onChange: (v) => {
      sort = v;
      paint();
    },
  });
  const usedCats = [...new Set(all.map((m) => (CATS.includes(m.category) ? m.category : 'other')))];
  const catCombo = kit.combo({
    options: [{ value: 'all', label: t('apps.allCats') }, ...usedCats.map((c) => ({ value: c, label: catLabel(pc, c) }))],
    value: cat,
    label: t('apps.filterBy'),
    onChange: (v) => {
      cat = v;
      paint();
    },
  });
  paint();
  return h(
    'div',
    null,
    h('div', { class: 'st-apps-tools' }, h('div', { class: 'search-box' }, input, icon('search', { size: 16 })), h('span', { class: 'text-2' }, t('apps.sortBy')), sortCombo, h('span', { class: 'text-2' }, t('apps.filterBy')), catCombo),
    h('div', { class: 'col', style: { gap: '8px' } }, count, list),
  );
}

// ------------------------------------------------------------------ Default apps
async function defaultApps(pc) {
  const { h, t, kit, ui, icon, settings, L } = pc;
  const registry = pc.shell.registry;
  const apps = registry.list({ includeHidden: true });
  const byExt = new Map();
  for (const m of apps) for (const e of m.fileTypes || []) if (/^\.[\w+-]+$/.test(e)) byExt.set(e.toLowerCase(), [...(byExt.get(e.toLowerCase()) || []), m]);
  const exts = [...byExt.keys()].sort();
  let query = '';
  const input = h('input', { class: 'input', type: 'search', placeholder: t('apps.typeSearch'), 'aria-label': t('apps.typeSearch') });
  const list = h('div', { class: 'st-group-rows' });
  function paint() {
    const q = query.trim().toLowerCase().replace(/^\*?\.?/, '');
    ui.clear(list);
    const shown = exts.filter((e) => !q || e.slice(1).startsWith(q) || byExt.get(e).some((m) => L(m.name).toLowerCase().includes(q)));
    if (!shown.length) list.append(h('div', { class: 'st-empty' }, icon('document_search', { size: 36 }), h('div', null, exts.length ? t('apps.noType') : t('apps.noTypes'))));
    const defs = settings.get('defaultApps') || {};
    for (const e of shown) {
      const cands = byExt.get(e);
      const cur = defs[e] && registry.get(defs[e]) ? defs[e] : registry.handlerFor(`file${e}`) || cands[0].id;
      list.appendChild(
        kit.row({
          icon: h('img', { class: 'st-app-icon', src: registry.iconUrl(cur), alt: '', draggable: false }),
          title: e,
          desc: defs[e] ? t('apps.chosenDefault') : t('apps.automatic'),
          control: kit.combo({
            options: cands.map((m) => ({ value: m.id, label: L(m.name) })),
            value: cur,
            width: 220,
            label: t('apps.defaultFor', { ext: e }),
            onChange: async (v) => {
              await settings.set('defaultApps', { ...(settings.get('defaultApps') || {}), [e]: v });
              paint();
            },
          }),
        }),
      );
    }
  }
  input.addEventListener('input', () => {
    query = input.value;
    paint();
  });
  paint();
  return h(
    'div',
    null,
    kit.group(t('apps.byType'), h('div', { class: 'st-apps-tools', style: { marginBottom: '8px' } }, h('div', { class: 'search-box' }, input, icon('search', { size: 16 })))),
    list,
    kit.group(
      null,
      kit.row({
        icon: 'arrow_reset',
        title: t('apps.reset'),
        desc: t('apps.resetDesc'),
        control: kit.button(t('pers.reset'), async () => {
          if (!(await ui.confirm(t('apps.resetConfirm'), { title: t('apps.reset'), okLabel: t('pers.reset'), parent: pc.win }))) return;
          await settings.set('defaultApps', {});
          paint();
          pc.toast(t('apps.resetDone'));
        }),
      }),
    ),
  );
}

export default { apps, installedApps, defaultApps };
