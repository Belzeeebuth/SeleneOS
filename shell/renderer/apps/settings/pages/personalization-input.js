// Settings > Personalization > Keyboard shortcuts, Snap layouts (docs/PERSONALIZATION.md §12).
//   shortcuts    every shell action of core/shortcuts.js: change (records the next key combination, keys shown live
//                while they are held), reset, turn off; conflicts with other actions are resolved by turning the other
//                one off; reserved combinations are refused; shortcuts that open any app ('app:<appId>')
//   snapPresets  the snap options (hover, drag to the top, Snap Assist), the layouts shown in the snap flyouts (any of
//                the built-in ones and the user's own, in any order) and the layout editor (columns, rows, main + side,
//                grid, or split a rectangle into zones)
// Keys: shortcuts { [actionId]: combo | null }, snapPresets [{ id, name, zones: [{ x, y, w, h }], spec }],
// snapLayouts null | [id], multitasking.snapLayouts / snapBar / snapAssist.
import { SHORTCUTS, SHORTCUT_GROUPS, comboProblem, comboKeys, effectiveShortcuts, isAppAction, appActionId, appOfAction, conflictOf, MAX_APP_SHORTCUTS } from '../../../core/shortcuts.js';
import { BUILTIN_LAYOUTS, DEFAULT_LAYOUT_IDS, MAX_SHOWN_LAYOUTS, shownLayouts, zoneFractions } from '../../../core/features/snaplayouts.js';
import { setupShellPages } from './personalization-shell-kit.js';
import { bindToggle } from './personalization-designer.js';
import { PAGES } from '../lib/index.js';
import { B3_CSS } from './personalization-packs.js';
import './personalization-b3-strings.js';

function setup(pc) {
  setupShellPages(pc);
  pc.ui.loadCss('app://shell/apps/settings/pages/personalization.css');
  pc.ui.loadCss(B3_CSS);
}

// ------------------------------------------------------------------ keyboard shortcuts
function keycaps(pc, combo, { pending = false } = {}) {
  const { h, t } = pc;
  if (!combo) return h('span', { class: 'pzs-keys off caption text-2' }, t('pzs.scOff'));
  const keys = comboKeys(combo, pc.lang);
  return h('span', { class: ['pzs-keys', pending && 'pending'], 'aria-label': keys.join(' + ') }, keys.map((k) => h('kbd', null, k)), pending ? h('kbd', { class: 'pzb-more' }, '…') : null);
}
const actionName = (pc, id) => {
  const app = appOfAction(id);
  if (app) return pc.t('pzx.scOpenApp', { app: pc.shell.registry.name(app) });
  const s = SHORTCUTS.find((x) => x.id === id);
  return s ? pc.L(s.name) : id;
};

/**
 * Record a key combination for an action. Resolves to { combo } (save), { reset: true } (back to the default, or
 * removed for an app shortcut), or null (cancelled).
 */
async function recordCombo(pc, id, combos) {
  const { h, t, ui } = pc;
  const hot = pc.shell.hotkeys;
  if (!hot?.capture) {
    pc.toast(t('pzs.scUnavailable'));
    return null;
  }
  const def = SHORTCUTS.find((s) => s.id === id)?.combo ?? null;
  let combo = null;
  let held = [];
  const show = h('div', { class: 'pzs-rec-keys', 'aria-live': 'polite' });
  const msg = h('div', { class: 'pzs-rec-msg caption' });
  const body = h(
    'div',
    { class: 'pzs-rec' },
    h('div', { class: 'text-2' }, t('pzs.scRecordFor', { action: actionName(pc, id) })),
    show,
    msg,
    h('div', { class: 'caption text-2 pzb-rec-def' }, def ? t('pzs.scDefault', { combo: comboKeys(def, pc.lang).join(' + ') }) : isAppAction(id) ? '' : t('pzx.scDefaultNone')),
  );
  let saveBtn = null;
  const paint = () => {
    // modifiers held without a key yet: show them live ("Ctrl + Alt + …")
    if (held.length && (!combo || held.join('+') !== combo.split('+').slice(0, -1).join('+'))) {
      show.replaceChildren(keycaps(pc, held.join('+'), { pending: true }));
      msg.className = 'pzs-rec-msg caption';
      msg.textContent = t('pzx.scHolding');
      if (saveBtn) saveBtn.disabled = true;
      return;
    }
    const problem = combo ? comboProblem(combo) : 'empty';
    show.replaceChildren(combo ? keycaps(pc, combo) : h('span', { class: 'caption text-2' }, t('pzs.scPress')));
    const other = combo && !problem ? conflictOf(combos, combo, id) : null;
    msg.className = `pzs-rec-msg caption ${problem && problem !== 'empty' ? 'error' : other ? 'warn' : ''}`;
    const bad = problem && problem !== 'empty' ? (['modifier', 'reserved', 'fixed'].includes(problem) ? t(`pzx.scBad_${problem}`) : t(`pzs.scBad_${problem}`)) : '';
    msg.textContent = problem === 'empty' ? t('pzx.scHint') : bad || (other ? t('pzs.scConflict', { action: actionName(pc, other) }) : '');
    if (saveBtn) saveBtn.disabled = !!problem;
  };
  const stop = hot.capture(
    (c) => {
      combo = c;
      held = [];
      paint();
    },
    {
      onModifiers: (mods) => {
        held = mods;
        paint();
      },
    },
  );
  try {
    const p = ui.dialog({
      title: t('pzs.scChange'),
      body,
      parent: pc.win,
      className: 'pzs-rec-dialog',
      buttons: [
        { label: t('common.save'), value: 'ok', primary: true },
        { label: isAppAction(id) ? t('pzx.scRemove') : t('pzx.scReset'), value: 'reset' },
        { label: t('common.cancel'), value: null },
      ],
    });
    saveBtn = [...document.querySelectorAll('.dialog.pzs-rec-dialog .btn.primary')].pop() || null;
    paint();
    const r = await p;
    if (r === 'reset') return { reset: true };
    return r === 'ok' && combo && !comboProblem(combo) ? { combo } : null;
  } finally {
    stop();
  }
}

/** Dialog: pick an installed app (one without a shortcut yet). Resolves to its id or null. */
async function pickApp(pc, taken) {
  const { h, t, ui } = pc;
  const reg = pc.shell.registry;
  let chosen = null;
  let dlg = null;
  const list = h(
    'div',
    { class: 'pzb-app-list', role: 'listbox', 'aria-label': t('pzx.scPickApp') },
    reg
      .list()
      .filter((m) => !taken.has(m.id))
      .map((m) =>
        h(
          'button',
          {
            class: 'pzb-app-item',
            type: 'button',
            role: 'option',
            dataset: { app: m.id },
            onclick: () => {
              chosen = m.id;
              dlg?.querySelector('.btn.primary')?.click();
            },
          },
          h('img', { src: reg.iconUrl(m.id), alt: '', width: 24, height: 24, draggable: false }),
          h('span', { class: 'ellipsis' }, reg.name(m.id)),
        ),
      ),
  );
  const p = ui.dialog({ title: t('pzx.scPickApp'), body: list, parent: pc.win, className: 'pzb-app-dialog', buttons: [{ label: t('common.ok'), value: 'ok', primary: true }, { label: t('common.cancel'), value: null }] });
  dlg = [...document.querySelectorAll('.dialog.pzb-app-dialog')].pop();
  // the OK button picks the focused app when the keyboard was used
  const ok = dlg?.querySelector('.btn.primary');
  ok?.addEventListener('pointerdown', () => (chosen = chosen || null));
  list.addEventListener('focusin', (e) => {
    const b = e.target.closest('.pzb-app-item');
    if (b) chosen = b.dataset.app;
  });
  const r = await p;
  return r === 'ok' ? chosen : null;
}

async function shortcuts(pc) {
  setup(pc);
  const { h, t, kit, settings, ui, L, icon } = pc;
  const overrides = () => ({ ...(settings.get('shortcuts') || {}) });
  const combos = () => effectiveShortcuts(overrides());
  /** Give `id` the combo (null = off / removed), turning off any other action that had it. */
  const setOne = async (id, combo) => {
    const o = overrides();
    const cur = combos();
    if (combo) {
      for (const [other, c] of Object.entries(cur)) {
        if (other === id || c !== combo) continue;
        if (isAppAction(other)) delete o[other];
        else o[other] = null;
      }
    }
    if (isAppAction(id)) {
      if (combo) o[id] = combo;
      else delete o[id];
    } else {
      const def = SHORTCUTS.find((s) => s.id === id)?.combo ?? null;
      if (combo === def) delete o[id];
      else o[id] = combo;
    }
    await settings.set('shortcuts', o);
  };
  const resetOne = async (id) => {
    if (isAppAction(id)) return setOne(id, null);
    const def = SHORTCUTS.find((s) => s.id === id)?.combo ?? null;
    return def ? setOne(id, def) : setOne(id, null);
  };
  const change = async (id) => {
    const r = await recordCombo(pc, id, combos());
    if (r?.reset) await resetOne(id);
    else if (r?.combo) await setOne(id, r.combo);
  };
  const filter = h('input', { class: 'input pzs-filter', type: 'search', placeholder: t('pzs.scFilter'), 'aria-label': t('pzs.scFilter') });
  const groupsBox = h('div', { class: 'pzs-sc-groups' });
  const row = (id, cur, o, q) => {
    const s = SHORTCUTS.find((x) => x.id === id);
    const name = actionName(pc, id);
    if (q && !name.toLowerCase().includes(q) && !comboKeys(cur[id], pc.lang).join('+').toLowerCase().includes(q)) return null;
    const app = appOfAction(id);
    const changed = !app && Object.prototype.hasOwnProperty.call(o, id);
    const more = h(
      'button',
      {
        class: 'btn subtle icon-btn pzb-sc-more',
        type: 'button',
        'aria-label': `${t('pzs.scMore')} — ${name}`,
        'data-tip': t('pzs.scMore'),
        onclick: (e) =>
          ui.menu(
            e.currentTarget,
            app
              ? [{ label: t('pzx.scRemove'), icon: 'delete', action: () => setOne(id, null) }]
              : [
                  { label: t('pzs.scReset'), icon: 'arrow_reset', disabled: !changed, action: () => resetOne(id) },
                  { label: t('pzs.scTurnOff'), icon: 'dismiss', disabled: !cur[id], action: () => setOne(id, null) },
                ],
          ),
      },
      icon('more_horizontal', { size: 16 }),
    );
    const btn = kit.button(t('pzs.scChangeBtn'), () => change(id), { className: 'pzs-sc-change' });
    btn.setAttribute('aria-label', `${t('pzs.scChangeBtn')} — ${name}`);
    return kit.row({
      icon: app ? null : undefined,
      title: name,
      desc: changed ? t('pzs.scDefault', { combo: s?.combo ? comboKeys(s.combo, pc.lang).join(' + ') : t('pzs.none') }) : null,
      section: `sc-${id.replace(':', '-')}`,
      className: [changed ? 'pzs-sc-changed' : '', app ? 'pzb-sc-app' : ''].filter(Boolean).join(' ') || null,
      control: h('div', { class: 'pz-inline pzs-sc-ctl' }, app ? h('img', { class: 'pzb-sc-appicon', src: pc.shell.registry.iconUrl(app), alt: '', width: 20, height: 20 }) : null, keycaps(pc, cur[id]), btn, more),
    });
  };
  const paint = () => {
    const q = filter.value.trim().toLowerCase();
    const cur = combos();
    const o = overrides();
    const groups = SHORTCUT_GROUPS.map((g) => {
      const rows = SHORTCUTS.filter((s) => s.group === g.id).map((s) => row(s.id, cur, o, q)).filter(Boolean);
      return rows.length ? kit.group(L(g.name), ...rows) : null;
    }).filter(Boolean);
    // shortcuts that open apps
    const appIds = Object.keys(cur).filter((id) => isAppAction(id) && pc.shell.registry.get(appOfAction(id)));
    const appRows = appIds.map((id) => row(id, cur, o, q)).filter(Boolean);
    const full = appIds.length >= MAX_APP_SHORTCUTS;
    const add = kit.button(t('pzx.scAddApp'), async () => {
      const app = await pickApp(pc, new Set(appIds.map(appOfAction)));
      if (!app) return;
      const r = await recordCombo(pc, appActionId(app), combos());
      if (r?.combo) await setOne(appActionId(app), r.combo);
    }, { icon: 'add', className: 'pzb-sc-add', disabled: full });
    if (!q || appRows.length) {
      groups.push(
        kit.group(
          t('pzx.scApps'),
          h('p', { class: 'caption text-2 pzb-note' }, full ? t('pzx.scAppsFull') : t('pzx.scAppsDesc')),
          ...appRows,
          h('div', { class: 'pzb-sc-addrow', dataset: { section: 'scApps' } }, add),
        ),
      );
    }
    groupsBox.replaceChildren(...groups);
    if (!groupsBox.children.length) groupsBox.append(h('div', { class: 'st-empty caption text-2' }, t('pzs.scNoMatch')));
  };
  filter.addEventListener('input', paint);
  paint();
  pc.onDispose(settings.on('shortcuts', paint));
  const fixed = kit.expander({
    icon: 'lock_closed',
    title: t('pzs.scFixed'),
    desc: t('pzs.scFixedDesc'),
    section: 'fixed',
    body: () =>
      h(
        'div',
        { class: 'pzs-fixed' },
        [['Alt+Tab', 'pzs.fx_altTab'], ['Ctrl+Alt+Tab', 'pzs.fx_altTabSticky'], ['Ctrl+Alt+Delete', 'pzs.fx_security'], ['PrintScreen', 'pzs.fx_print']].map(([c, k]) =>
          kit.subRow({ title: t(k), control: keycaps(pc, c) }),
        ),
      ),
  });
  return h(
    'div',
    { class: 'pzs-page' },
    h('p', { class: 'pzs-intro text-2' }, t('pzs.scIntro')),
    h(
      'div',
      { class: 'pzs-toolbar' },
      filter,
      kit.button(t('pzs.scResetAll'), async () => {
        if (await ui.confirm(t('pzs.scResetAllConfirm'), { title: t('pzs.scResetAll'), okLabel: t('pers.reset'), parent: pc.win })) {
          await settings.reset('shortcuts');
          pc.toast(t('pers.resetDone'));
        }
      }, { icon: 'arrow_reset', className: 'pzs-sc-reset-all' }),
    ),
    groupsBox,
    kit.group(null, fixed),
    kit.related([
      { icon: 'window_multiple', title: pc.pageTitle('multitasking'), desc: pc.L(PAGES.multitasking.desc), onClick: () => pc.go('multitasking') },
      { icon: PAGES.snapPresets.icon, title: pc.pageTitle('snapPresets'), desc: pc.L(PAGES.snapPresets.desc), onClick: () => pc.go('snapPresets') },
    ]),
  );
}

// ------------------------------------------------------------------ snap layouts
const r4 = (n) => Math.round(n * 10000) / 10000;
/** Zones of a split tree (null = one zone; { s: 'v' | 'h', r, a, b }), depth first: [{ x, y, w, h, path }] */
export function treeZones(tree, x = 0, y = 0, w = 1, hh = 1, path = '') {
  if (!tree) return [{ x: r4(x), y: r4(y), w: r4(w), h: r4(hh), path }];
  const r = Math.max(0.1, Math.min(0.9, Number(tree.r) || 0.5));
  if (tree.s === 'v') return [...treeZones(tree.a, x, y, w * r, hh, `${path}a`), ...treeZones(tree.b, x + w * r, y, w * (1 - r), hh, `${path}b`)];
  return [...treeZones(tree.a, x, y, w, hh * r, `${path}a`), ...treeZones(tree.b, x, y + hh * r, w, hh * (1 - r), `${path}b`)];
}
const nodeAt = (tree, path) => [...path].reduce((n, k) => (n ? n[k] : null), tree);
/** A copy of `tree` with the node at `path` replaced. */
function withNode(tree, path, node) {
  if (!path) return node;
  const copy = JSON.parse(JSON.stringify(tree));
  const parent = nodeAt(copy, path.slice(0, -1));
  parent[path.slice(-1)] = node;
  return copy;
}
/** Zones of a layout kind: { kind, count, ratio, side, rows, tree } -> [{ x, y, w, h }] */
export function makeZones({ kind = 'columns', count = 2, ratio = 50, side = 'right', rows = 2, tree = null } = {}) {
  if (kind === 'custom') return treeZones(tree).map(({ x, y, w, h }) => ({ x, y, w: Math.min(w, r4(1 - x)), h: Math.min(h, r4(1 - y)) }));
  const f = Math.max(0.15, Math.min(0.85, ratio / 100));
  const out = [];
  if (kind === 'columns' || kind === 'rows') {
    const n = Math.max(2, Math.min(4, count));
    const rest = (1 - f) / (n - 1);
    let at = 0;
    for (let i = 0; i < n; i++) {
      const size = i === 0 ? f : i === n - 1 ? 1 - at : rest;
      out.push(kind === 'columns' ? { x: r4(at), y: 0, w: r4(size), h: 1 } : { x: 0, y: r4(at), w: 1, h: r4(size) });
      at += size;
    }
  } else if (kind === 'main') {
    const n = Math.max(2, Math.min(3, count));
    const mainX = side === 'left' ? 1 - f : 0;
    const sideX = side === 'left' ? 0 : f;
    out.push({ x: r4(mainX), y: 0, w: r4(f), h: 1 });
    for (let i = 0; i < n; i++) out.push({ x: r4(sideX), y: r4(i / n), w: r4(1 - f), h: r4(i === n - 1 ? 1 - (i * r4(1 / n)) : 1 / n) });
  } else {
    const c = Math.max(2, Math.min(3, count));
    const rr = Math.max(2, Math.min(3, rows));
    for (let j = 0; j < rr; j++) for (let i = 0; i < c; i++) out.push({ x: r4(i / c), y: r4(j / rr), w: r4(i === c - 1 ? 1 - r4(i / c) : 1 / c), h: r4(j === rr - 1 ? 1 - r4(j / rr) : 1 / rr) });
  }
  return out.map((z) => ({ x: z.x, y: z.y, w: Math.min(z.w, r4(1 - z.x)), h: Math.min(z.h, r4(1 - z.y)) }));
}

function zonesPreview(pc, zones, { large = false } = {}) {
  const { h } = pc;
  return h(
    'span',
    { class: ['pzs-layout-pv', large && 'large'], 'aria-hidden': 'true' },
    zones.map((z, i) => h('i', { style: { left: `${z.x * 100}%`, top: `${z.y * 100}%`, width: `${z.w * 100}%`, height: `${z.h * 100}%` } }, large ? h('b', null, String(i + 1)) : null)),
  );
}

async function editPreset(pc, preset) {
  const { h, t, ui } = pc;
  const sp = preset?.spec || {};
  const cfg = {
    kind: ['columns', 'rows', 'main', 'grid', 'custom'].includes(sp.kind) ? sp.kind : preset ? 'custom' : 'columns',
    count: sp.count || 2,
    ratio: sp.ratio || 60,
    side: sp.side || 'right',
    rows: sp.rows || 2,
    tree: sp.tree !== undefined ? sp.tree : { s: 'v', r: 0.5, a: null, b: null },
  };
  // an imported layout without its recipe: edit it as a split of the screen (starts from two halves)
  if (preset && !sp.kind) cfg.tree = { s: 'v', r: 0.5, a: null, b: null };
  let sel = 'a';
  const name = h('input', { class: 'input', value: preset?.name || t('pzs.snapDefaultName'), maxLength: 60, 'aria-label': t('pzs.snapName') });
  const pv = h('div', { class: 'pzs-snap-pv' });
  const controls = h('div', { class: 'pzs-snap-ctl' });
  const kindSeg = ui.segmented({ options: ['columns', 'rows', 'main', 'grid', 'custom'].map((k) => ({ value: k, label: k === 'custom' ? t('pzx.snapKind_custom') : t(`pzs.snapKind_${k}`) })), value: cfg.kind, onchange: (v) => ((cfg.kind = v), paint()) });
  kindSeg.classList.add('pzs-seg');
  const slider = (label, key, min, max, step, fmt) => {
    const val = h('span', { class: 'st-slider-val' }, fmt(cfg[key]));
    const s = ui.slider({ min, max, step, value: cfg[key], oninput: (v) => ((cfg[key] = v), (val.textContent = fmt(v)), paintPv()) });
    s.setAttribute('aria-label', label);
    return h('label', { class: 'pzs-snap-field' }, h('span', { class: 'caption text-2' }, label), h('span', { class: 'st-slider' }, s, val));
  };
  const pct = (v) => (pc.lang === 'fr' ? `${v} %` : `${v}%`);
  // ---- split editor (kind "custom"): click a zone, then split it or merge it back
  const leaves = () => treeZones(cfg.tree);
  const splitPreview = () => {
    const zs = leaves();
    if (!zs.some((z) => z.path === sel)) sel = zs[0].path;
    return h(
      'div',
      { class: 'pzs-layout-pv large pzb-split-pv', role: 'listbox', 'aria-label': t('pzx.snapSelectHint') },
      zs.map((z, i) =>
        h(
          'button',
          {
            class: ['pzb-split-zone', z.path === sel && 'selected'],
            type: 'button',
            role: 'option',
            'aria-selected': String(z.path === sel),
            'aria-label': t('pzx.snapZone', { n: i + 1 }),
            dataset: { path: z.path || 'root' },
            style: { left: `${z.x * 100}%`, top: `${z.y * 100}%`, width: `${z.w * 100}%`, height: `${z.h * 100}%` },
            onclick: () => {
              sel = z.path;
              paint();
              pv.querySelector(`[data-path="${sel || 'root'}"]`)?.focus();
            },
          },
          h('b', null, String(i + 1)),
        ),
      ),
    );
  };
  const split = (s) => {
    if (leaves().length >= 16) return pc.toast(t('pzx.snapMaxZones'));
    cfg.tree = withNode(cfg.tree, sel, { s, r: 0.5, a: null, b: null });
    sel = `${sel}a`;
    paint();
  };
  const merge = () => {
    if (!sel) return;
    sel = sel.slice(0, -1);
    cfg.tree = withNode(cfg.tree, sel, null);
    paint();
  };
  const paintPv = () => pv.replaceChildren(cfg.kind === 'custom' ? splitPreview() : zonesPreview(pc, makeZones(cfg), { large: true }));
  function paint() {
    const parts = [];
    if (cfg.kind === 'columns' || cfg.kind === 'rows') {
      cfg.count = Math.min(cfg.count, 4);
      parts.push(slider(t(cfg.kind === 'columns' ? 'pzs.snapColumns' : 'pzs.snapRows'), 'count', 2, 4, 1, String), slider(t(cfg.kind === 'columns' ? 'pzs.snapFirstWidth' : 'pzs.snapFirstHeight'), 'ratio', 15, 85, 5, pct));
    } else if (cfg.kind === 'main') {
      cfg.count = Math.min(cfg.count, 3);
      const sideSeg = ui.segmented({ options: [{ value: 'left', label: t('pzs.snapSideLeft') }, { value: 'right', label: t('pzs.snapSideRight') }], value: cfg.side, onchange: (v) => ((cfg.side = v), paintPv()) });
      sideSeg.classList.add('pzs-seg');
      parts.push(slider(t('pzs.snapMainWidth'), 'ratio', 40, 85, 5, pct), slider(t('pzs.snapSideCount'), 'count', 2, 3, 1, String), h('div', { class: 'pzs-snap-field' }, h('span', { class: 'caption text-2' }, t('pzs.snapSide')), sideSeg));
    } else if (cfg.kind === 'grid') {
      cfg.count = Math.min(cfg.count, 3);
      parts.push(slider(t('pzs.snapColumns'), 'count', 2, 3, 1, String), slider(t('pzs.snapRows'), 'rows', 2, 3, 1, String));
    } else {
      if (!leaves().some((z) => z.path === sel)) sel = leaves()[0].path;
      const parentPath = sel ? sel.slice(0, -1) : null;
      const parent = parentPath !== null ? nodeAt(cfg.tree, parentPath) : null;
      const posVal = h('span', { class: 'st-slider-val' }, parent ? pct(Math.round(parent.r * 100)) : '—');
      const pos = ui.slider({
        min: 10,
        max: 90,
        step: 5,
        value: parent ? Math.round(parent.r * 100) : 50,
        oninput: (v) => {
          if (parentPath === null) return;
          cfg.tree = withNode(cfg.tree, parentPath, { ...nodeAt(cfg.tree, parentPath), r: v / 100 });
          posVal.textContent = pct(v);
          paintPv();
        },
      });
      pos.setAttribute('aria-label', t('pzx.snapSplitPos'));
      if (!parent) pos.disabled = true;
      const full = leaves().length >= 16;
      parts.push(
        h('p', { class: 'caption text-2' }, t('pzx.snapSelectHint')),
        h(
          'div',
          { class: 'pzb-split-btns' },
          h('button', { class: 'btn pzb-split-v', type: 'button', disabled: full, onclick: () => split('v') }, pc.icon('split_vertical', { size: 16 }), t('pzx.snapSplitV')),
          h('button', { class: 'btn pzb-split-h', type: 'button', disabled: full, onclick: () => split('h') }, pc.icon('split_horizontal', { size: 16 }), t('pzx.snapSplitH')),
          h('button', { class: 'btn pzb-merge', type: 'button', disabled: !sel, onclick: merge }, pc.icon('merge', { size: 16 }), t('pzx.snapMerge')),
        ),
        h('label', { class: 'pzs-snap-field' }, h('span', { class: 'caption text-2' }, t('pzx.snapSplitPos')), h('span', { class: 'st-slider' }, pos, posVal)),
      );
    }
    controls.replaceChildren(...parts);
    paintPv();
  }
  paint();
  const body = h('div', { class: 'pzs-snap-editor' }, h('label', { class: 'field' }, h('span', { class: 'caption text-2' }, t('pzs.snapName')), name), kindSeg, h('div', { class: 'pzs-snap-grid' }, controls, pv));
  const r = await ui.dialog({ title: preset ? t('pzs.snapEdit') : t('pzs.snapNew'), body, parent: pc.win, className: 'pzs-snap-dialog', buttons: [{ label: t('common.save'), value: 'ok', primary: true }, { label: t('common.cancel'), value: null }] });
  if (r !== 'ok') return null;
  const spec = { kind: cfg.kind, count: cfg.count, ratio: cfg.ratio, side: cfg.side, rows: cfg.rows };
  if (cfg.kind === 'custom') spec.tree = cfg.tree;
  return {
    id: preset?.id || `s-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
    name: name.value.replace(/[\u0000-\u001f<>]/g, ' ').trim().slice(0, 60) || t('pzs.snapDefaultName'),
    zones: makeZones(cfg),
    spec,
  };
}

async function snapPresets(pc) {
  setup(pc);
  const { h, t, kit, settings, icon, L } = pc;
  const presets = () => (Array.isArray(settings.get('snapPresets')) ? settings.get('snapPresets') : []);
  const shownIds = () => shownLayouts().map((l) => l.id);
  const setShown = (ids) => settings.set('snapLayouts', ids.slice(0, MAX_SHOWN_LAYOUTS));
  const savePresets = (l) => settings.set('snapPresets', l.slice(0, 12));

  // ---- snap options (Windows: Settings > System > Multitasking > Snap windows)
  const opt = (k) => settings.get(`multitasking.${k}`) !== false;
  const offNote = kit.infobar({ kind: 'info', message: t('pzx.snapOffNote'), className: 'pzb-snap-off', action: kit.button(pc.pageTitle('multitasking'), () => pc.go('multitasking')) });
  const paintOff = () => (offNote.hidden = opt('snap'));
  paintOff();
  pc.onDispose(settings.on('multitasking', paintOff));
  const toggles = [
    ['snapLayouts', 'pzx.snapHover', 'snapHover'],
    ['snapBar', 'pzx.snapBar', 'snapBar'],
    ['snapAssist', 'pzx.snapSuggest', 'snapAssist'],
  ].map(([k, label, section]) => kit.row({ title: t(label), section, control: bindToggle(pc, `multitasking.${k}`, true, t(label)) }));

  // ---- the layouts shown in the flyouts: built-in and the user's own, in order
  const box = h('div', { class: 'pzb-layouts', role: 'list' });
  const toastFull = () => pc.toast(t('pzx.snapTooMany', { max: MAX_SHOWN_LAYOUTS }));
  const paint = () => {
    const shown = shownIds();
    const custom = presets();
    const all = [
      ...BUILTIN_LAYOUTS.map((l) => ({ id: l.id, name: L(l.name), zones: l.zones.map(zoneFractions).filter(Boolean), custom: null })),
      ...custom.map((p) => ({ id: p.id, name: p.name || t('pzs.snapDefaultName'), zones: Array.isArray(p.zones) ? p.zones : [], custom: p })),
    ];
    const ordered = [...shown.map((id) => all.find((l) => l.id === id)).filter(Boolean), ...all.filter((l) => !shown.includes(l.id))];
    box.replaceChildren(
      ...ordered.map((l) => {
        const on = shown.includes(l.id);
        const i = shown.indexOf(l.id);
        const move = (d) => {
          const ids = [...shown];
          const j = i + d;
          if (i < 0 || j < 0 || j >= ids.length) return;
          [ids[i], ids[j]] = [ids[j], ids[i]];
          setShown(ids);
        };
        const tg = kit.toggle({
          value: on,
          label: `${t('pzx.snapShow')} — ${l.name}`,
          onChange: (v) => {
            const ids = shownIds().filter((x) => x !== l.id);
            if (v) {
              if (ids.length >= MAX_SHOWN_LAYOUTS) {
                toastFull();
                return false;
              }
              ids.push(l.id);
            } else if (!ids.length) return false; // at least one layout stays
            return setShown(ids);
          },
        });
        return h(
          'div',
          { class: ['pzb-layout-row', on ? 'shown' : 'hidden-layout'], role: 'listitem', dataset: { id: l.id } },
          zonesPreview(pc, l.zones),
          h(
            'div',
            { class: 'pzb-layout-text' },
            h('span', { class: 'pzb-layout-name ellipsis' }, l.name),
            h('span', { class: 'caption text-2' }, `${l.custom ? t('pzx.snapYoursTag') : t('pzx.snapBuiltinTag')} · ${t('pzx.snapZones', { count: l.zones.length })}`),
          ),
          h(
            'span',
            { class: 'pzs-list-btns' },
            h('button', { class: 'btn subtle icon-btn pzb-up', type: 'button', disabled: !on || i === 0, 'aria-label': `${t('pzs.moveUp')} — ${l.name}`, 'data-tip': t('pzs.moveUp'), onclick: () => move(-1) }, icon('arrow_up', { size: 14 })),
            h('button', { class: 'btn subtle icon-btn pzb-down', type: 'button', disabled: !on || i === shown.length - 1, 'aria-label': `${t('pzs.moveDown')} — ${l.name}`, 'data-tip': t('pzs.moveDown'), onclick: () => move(1) }, icon('arrow_down', { size: 14 })),
            l.custom
              ? h('button', { class: 'btn subtle icon-btn pzb-edit', type: 'button', 'aria-label': `${t('pzs.snapEdit')} — ${l.name}`, 'data-tip': t('pzs.snapEdit'), onclick: async () => {
                  const np = await editPreset(pc, l.custom);
                  if (np) await savePresets(presets().map((x) => (x.id === l.id ? np : x)));
                } }, icon('edit', { size: 14 }))
              : null,
            l.custom
              ? h('button', { class: 'btn subtle icon-btn pzs-remove pzb-delete', type: 'button', 'aria-label': `${t('pzs.snapDelete')} — ${l.name}`, 'data-tip': t('pzs.snapDelete'), onclick: async () => {
                  const order = settings.get('snapLayouts');
                  await savePresets(presets().filter((x) => x.id !== l.id));
                  if (Array.isArray(order)) await setShown(order.filter((x) => x !== l.id));
                } }, icon('delete', { size: 14 }))
              : null,
            tg,
          ),
        );
      }),
    );
  };
  paint();
  pc.onDispose(settings.on('snapPresets', paint));
  pc.onDispose(settings.on('snapLayouts', paint));
  const newBtn = kit.button(t('pzs.snapNew'), async () => {
    if (presets().length >= 12) return;
    const np = await editPreset(pc, null);
    if (!np) return;
    await savePresets([...presets(), np]);
    const order = settings.get('snapLayouts');
    if (Array.isArray(order) && order.length < MAX_SHOWN_LAYOUTS) await setShown([...order, np.id]);
  }, { icon: 'add', className: 'pzs-snap-new-btn', primary: true });
  const resetBtn = kit.button(t('pzx.snapResetLayouts'), () => settings.reset('snapLayouts'), { icon: 'arrow_reset', className: 'pzb-snap-reset' });
  const tryBtn = kit.button(t('pzs.snapTry'), () => pc.shell.emit('snaplayouts:open', pc.win), { icon: 'layout_column_two_split_right' });
  return h(
    'div',
    { class: 'pzs-page' },
    h('p', { class: 'pzs-intro text-2' }, t('pzs.snapIntro')),
    offNote,
    kit.group(t('pzx.snapAssist'), ...toggles),
    kit.group(
      t('pzx.snapShown'),
      h('p', { class: 'caption text-2 pzb-note' }, t('pzx.snapShownDesc', { max: MAX_SHOWN_LAYOUTS })),
      h('div', { class: 'pzs-toolbar pzb-snap-toolbar', dataset: { section: 'presets' } }, newBtn, resetBtn),
      box,
    ),
    kit.group(null, kit.row({ icon: 'window_multiple', title: t('pzs.snapTryTitle'), desc: t('pzs.snapTryDesc'), control: tryBtn })),
    kit.related([{ icon: 'window_multiple', title: pc.pageTitle('multitasking'), desc: pc.L(PAGES.multitasking.desc), onClick: () => pc.go('multitasking') }]),
  );
}
void DEFAULT_LAYOUT_IDS;

export default { shortcuts, snapPresets };
