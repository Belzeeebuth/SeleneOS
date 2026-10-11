// Settings > Personalization > Keyboard shortcuts, Snap layouts (docs/PERSONALIZATION.md §12).
//   shortcuts    every shell action of core/shortcuts.js: change (records the next key combination), turn off,
//                back to default; conflicts are resolved by asking; the fixed combos are listed read-only
//   snapPresets  the user's own snap layouts (columns, rows, main + side, grid) shown next to the built-in ones in
//                the snap layouts flyout (maximize button hover, Win+Z) and the bar at the top of the screen
// Keys: shortcuts { [actionId]: combo | null }, snapPresets [{ id, name, zones: [{ x, y, w, h }] }].
import { SHORTCUTS, SHORTCUT_GROUPS, FIXED_COMBOS, comboProblem, comboKeys, effectiveShortcuts } from '../../../core/shortcuts.js';
import { setupShellPages } from './personalization-shell-kit.js';
import { PAGES } from '../lib/index.js';

// ------------------------------------------------------------------ keyboard shortcuts
function keycaps(pc, combo) {
  const { h, t } = pc;
  if (!combo) return h('span', { class: 'pzs-keys off caption text-2' }, t('pzs.scOff'));
  return h('span', { class: 'pzs-keys', 'aria-label': comboKeys(combo, pc.lang).join(' + ') }, comboKeys(combo, pc.lang).map((k) => h('kbd', null, k)));
}

/** Record a key combination: resolves to a combo, or null when cancelled. */
async function recordCombo(pc, action, combos) {
  const { h, t, ui, L } = pc;
  const hot = pc.shell.hotkeys;
  if (!hot?.capture) {
    pc.toast(t('pzs.scUnavailable'));
    return null;
  }
  let combo = null;
  const show = h('div', { class: 'pzs-rec-keys', 'aria-live': 'polite' }, h('span', { class: 'caption text-2' }, t('pzs.scPress')));
  const msg = h('div', { class: 'pzs-rec-msg caption' });
  const body = h('div', { class: 'pzs-rec' }, h('div', { class: 'text-2' }, t('pzs.scRecordFor', { action: L(action.name) })), show, msg);
  let saveBtn = null;
  const paint = () => {
    const problem = combo ? comboProblem(combo) : 'empty';
    show.replaceChildren(combo ? keycaps(pc, combo) : h('span', { class: 'caption text-2' }, t('pzs.scPress')));
    const other = combo && !problem ? SHORTCUTS.find((s) => s.id !== action.id && combos[s.id] === combo) : null;
    msg.className = `pzs-rec-msg caption ${problem && problem !== 'empty' ? 'error' : other ? 'warn' : ''}`;
    msg.textContent = problem === 'empty' ? t('pzs.scHint') : problem ? t(`pzs.scBad_${problem}`) : other ? t('pzs.scConflict', { action: L(other.name) }) : '';
    if (saveBtn) saveBtn.disabled = !!problem;
  };
  const stop = hot.capture((c) => {
    combo = c;
    paint();
  });
  try {
    const p = ui.dialog({
      title: t('pzs.scChange'),
      body,
      parent: pc.win,
      className: 'pzs-rec-dialog',
      buttons: [{ label: t('common.save'), value: 'ok', primary: true }, { label: t('common.cancel'), value: null }],
    });
    saveBtn = [...document.querySelectorAll('.dialog.pzs-rec-dialog .btn.primary')].pop() || null;
    paint();
    const r = await p;
    return r === 'ok' && combo && !comboProblem(combo) ? combo : null;
  } finally {
    stop();
  }
}

async function shortcuts(pc) {
  setupShellPages(pc);
  const { h, t, kit, settings, ui, L, icon } = pc;
  const overrides = () => ({ ...(settings.get('shortcuts') || {}) });
  const combos = () => effectiveShortcuts(overrides());
  const setOne = async (id, combo) => {
    const o = overrides();
    const def = SHORTCUTS.find((s) => s.id === id)?.combo ?? null;
    // a combo taken from another action turns that one off
    if (combo) for (const s of SHORTCUTS) if (s.id !== id && combos()[s.id] === combo) o[s.id] = null;
    if (combo === def) delete o[id];
    else o[id] = combo;
    await settings.set('shortcuts', o);
  };
  const filter = h('input', { class: 'input pzs-filter', type: 'search', placeholder: t('pzs.scFilter'), 'aria-label': t('pzs.scFilter') });
  const groupsBox = h('div', { class: 'pzs-sc-groups' });
  const paint = () => {
    const q = filter.value.trim().toLowerCase();
    const cur = combos();
    const o = overrides();
    groupsBox.replaceChildren(
      ...SHORTCUT_GROUPS.map((g) => {
        const rows = SHORTCUTS.filter((s) => s.group === g.id)
          .filter((s) => !q || L(s.name).toLowerCase().includes(q) || comboKeys(cur[s.id], pc.lang).join('+').toLowerCase().includes(q))
          .map((s) => {
            const changed = Object.prototype.hasOwnProperty.call(o, s.id);
            const more = h(
              'button',
              {
                class: 'btn subtle icon-btn',
                type: 'button',
                'aria-label': `${t('pzs.scMore')} — ${L(s.name)}`,
                'data-tip': t('pzs.scMore'),
                onclick: (e) =>
                  ui.menu(e.currentTarget, [
                    { label: t('pzs.scReset'), icon: 'arrow_reset', disabled: !changed, action: () => setOne(s.id, s.combo) },
                    { label: t('pzs.scTurnOff'), icon: 'dismiss', disabled: !cur[s.id], action: () => setOne(s.id, null) },
                  ]),
              },
              icon('more_horizontal', { size: 16 }),
            );
            const change = kit.button(t('pzs.scChangeBtn'), async () => {
              const c = await recordCombo(pc, s, combos());
              if (c) await setOne(s.id, c);
            }, { className: 'pzs-sc-change' });
            return kit.row({
              title: L(s.name),
              desc: changed ? t('pzs.scDefault', { combo: s.combo ? comboKeys(s.combo, pc.lang).join(' + ') : t('pzs.none') }) : null,
              section: `sc-${s.id}`,
              className: changed ? 'pzs-sc-changed' : null,
              control: h('div', { class: 'pz-inline pzs-sc-ctl' }, keycaps(pc, cur[s.id]), change, more),
            });
          });
        return rows.length ? kit.group(L(g.name), ...rows) : null;
      }).filter(Boolean),
    );
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
        [['Alt+Tab', 'pzs.fx_altTab'], ['Ctrl+Alt+Tab', 'pzs.fx_altTabSticky'], ['Ctrl+Alt+Delete', 'pzs.fx_security'], ['PrintScreen', 'pzs.fx_print'], ['Super+1', 'pzs.fx_nth']].map(([c, k]) =>
          kit.subRow({ title: t(k), control: keycaps(pc, c) }),
        ),
      ),
  });
  void FIXED_COMBOS;
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
const BUILTIN = [
  [[0, 0, 0.5, 1], [0.5, 0, 0.5, 1]],
  [[0, 0, 0.667, 1], [0.667, 0, 0.333, 1]],
  [[0, 0, 0.333, 1], [0.333, 0, 0.334, 1], [0.667, 0, 0.333, 1]],
  [[0, 0, 0.5, 1], [0.5, 0, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5]],
  [[0, 0, 0.5, 0.5], [0.5, 0, 0.5, 0.5], [0, 0.5, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5]],
  [[0, 0, 0.25, 1], [0.25, 0, 0.5, 1], [0.75, 0, 0.25, 1]],
];
const r4 = (n) => Math.round(n * 10000) / 10000;
/** Zones of a layout kind: { kind, count, ratio, side, rows } -> [{ x, y, w, h }] */
export function makeZones({ kind = 'columns', count = 2, ratio = 50, side = 'right', rows = 2 } = {}) {
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
  const cfg = { kind: preset?.spec?.kind || 'columns', count: preset?.spec?.count || 2, ratio: preset?.spec?.ratio || 60, side: preset?.spec?.side || 'right', rows: preset?.spec?.rows || 2 };
  const name = h('input', { class: 'input', value: preset?.name || t('pzs.snapDefaultName'), maxLength: 60, 'aria-label': t('pzs.snapName') });
  const pv = h('div', { class: 'pzs-snap-pv' });
  const controls = h('div', { class: 'pzs-snap-ctl' });
  const kindSeg = ui.segmented({ options: ['columns', 'rows', 'main', 'grid'].map((k) => ({ value: k, label: t(`pzs.snapKind_${k}`) })), value: cfg.kind, onchange: (v) => ((cfg.kind = v), paint()) });
  kindSeg.classList.add('pzs-seg');
  const slider = (label, key, min, max, step, fmt) => {
    const val = h('span', { class: 'st-slider-val' }, fmt(cfg[key]));
    const s = ui.slider({ min, max, step, value: cfg[key], oninput: (v) => ((cfg[key] = v), (val.textContent = fmt(v)), paintPv()) });
    s.setAttribute('aria-label', label);
    return h('label', { class: 'pzs-snap-field' }, h('span', { class: 'caption text-2' }, label), h('span', { class: 'st-slider' }, s, val));
  };
  const pct = (v) => (pc.lang === 'fr' ? `${v} %` : `${v}%`);
  const paintPv = () => pv.replaceChildren(zonesPreview(pc, makeZones(cfg), { large: true }));
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
    } else {
      cfg.count = Math.min(cfg.count, 3);
      parts.push(slider(t('pzs.snapColumns'), 'count', 2, 3, 1, String), slider(t('pzs.snapRows'), 'rows', 2, 3, 1, String));
    }
    controls.replaceChildren(...parts);
    paintPv();
  }
  paint();
  const body = h('div', { class: 'pzs-snap-editor' }, h('label', { class: 'field' }, h('span', { class: 'caption text-2' }, t('pzs.snapName')), name), kindSeg, h('div', { class: 'pzs-snap-grid' }, controls, pv));
  const r = await ui.dialog({ title: preset ? t('pzs.snapEdit') : t('pzs.snapNew'), body, parent: pc.win, className: 'pzs-snap-dialog', buttons: [{ label: t('common.save'), value: 'ok', primary: true }, { label: t('common.cancel'), value: null }] });
  if (r !== 'ok') return null;
  return {
    id: preset?.id || `s-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
    name: name.value.replace(/[\u0000-\u001f<>]/g, ' ').trim().slice(0, 60) || t('pzs.snapDefaultName'),
    zones: makeZones(cfg),
    spec: { ...cfg },
  };
}

async function snapPresets(pc) {
  setupShellPages(pc);
  const { h, t, kit, settings, icon } = pc;
  const list = () => (Array.isArray(settings.get('snapPresets')) ? settings.get('snapPresets') : []);
  const save = (l) => settings.set('snapPresets', l.slice(0, 12));
  const box = h('div', { class: 'pzs-snap-list' });
  const paint = () => {
    const items = list();
    box.replaceChildren(
      ...items.map((p) =>
        h(
          'div',
          { class: 'pzs-snap-card', dataset: { id: p.id } },
          zonesPreview(pc, p.zones || []),
          h('span', { class: 'pzs-snap-name ellipsis' }, p.name || t('pzs.snapDefaultName')),
          h(
            'span',
            { class: 'pzs-list-btns' },
            h('button', { class: 'btn subtle icon-btn', type: 'button', 'aria-label': `${t('pzs.snapEdit')} — ${p.name}`, 'data-tip': t('pzs.snapEdit'), onclick: async () => {
              const np = await editPreset(pc, p);
              if (np) await save(list().map((x) => (x.id === p.id ? np : x)));
            } }, icon('edit', { size: 14 })),
            h('button', { class: 'btn subtle icon-btn pzs-remove', type: 'button', 'aria-label': `${t('pzs.snapDelete')} — ${p.name}`, 'data-tip': t('pzs.snapDelete'), onclick: () => save(list().filter((x) => x.id !== p.id)) }, icon('delete', { size: 14 })),
          ),
        ),
      ),
      ...(items.length < 12
        ? [
            h('button', { class: 'pzs-snap-card pzs-snap-new', type: 'button', onclick: async () => {
              const np = await editPreset(pc, null);
              if (np) await save([...list(), np]);
            } }, icon('add', { size: 20 }), h('span', null, t('pzs.snapNew'))),
          ]
        : []),
    );
  };
  paint();
  pc.onDispose(settings.on('snapPresets', paint));
  const tryBtn = kit.button(t('pzs.snapTry'), () => pc.shell.emit('snaplayouts:open', pc.win), { icon: 'layout_column_two_split_right' });
  return h(
    'div',
    { class: 'pzs-page' },
    h('p', { class: 'pzs-intro text-2' }, t('pzs.snapIntro')),
    kit.group(t('pzs.snapYours'), h('div', { dataset: { section: 'presets' } }, box)),
    kit.group(t('pzs.snapBuiltin'), h('div', { class: 'pzs-snap-list builtin' }, BUILTIN.map((zs) => h('div', { class: 'pzs-snap-card' }, zonesPreview(pc, zs.map(([x, y, w, hh]) => ({ x, y, w, h: hh }))))))),
    kit.group(null, kit.row({ icon: 'window_multiple', title: t('pzs.snapTryTitle'), desc: t('pzs.snapTryDesc'), control: tryBtn })),
    kit.related([{ icon: 'window_multiple', title: pc.pageTitle('multitasking'), desc: pc.L(PAGES.multitasking.desc), onClick: () => pc.go('multitasking') }]),
  );
}

export default { shortcuts, snapPresets };
