// Shared builders of the shell personalization pages (Taskbar, Start, Focus mode, packs, shortcuts, snap layouts):
// controls bound to a settings key that follow outside changes (profiles, quick settings, another window).
//   setupShellPages(pc)                       loads pages/personalization-shell.css
//   boundCombo(pc, { key, options, def, label, width, onChange })   combo box <-> settings key
//   boundSeg(pc, { key, options, def, label })                     segmented control <-> settings key
//   boundToggle(pc, key, def, label)                               switch <-> settings key (designer's bindToggle)
//   appIcon(pc, appId, size)                                       <img> of an app icon
//   orderedList(pc, { items, render, onMove, onRemove, empty })    rows with move up / down / remove buttons
import { bindToggle } from './personalization-designer.js';

export const SHELL_CSS = 'app://shell/apps/settings/pages/personalization-shell.css';
export function setupShellPages(pc) {
  pc.ui.loadCss(SHELL_CSS);
}

const read = (pc, key, def) => {
  const v = pc.settings.get(key);
  return v === undefined || v === null ? def : v;
};

export function boundCombo(pc, { key, options, def, label, width, onChange }) {
  const combo = pc.kit.combo({
    options,
    value: read(pc, key, def),
    label,
    width,
    onChange: async (v) => {
      if (onChange) return onChange(v);
      await pc.settings.set(key, v);
    },
  });
  combo.dataset.key = key;
  pc.onDispose(pc.settings.on(key, () => combo.setValue(read(pc, key, def))));
  return combo;
}

export function boundSeg(pc, { key, options, def, label }) {
  const seg = pc.ui.segmented({ options, value: read(pc, key, def), onchange: (v) => pc.settings.set(key, v) });
  seg.classList.add('pzs-seg');
  seg.setAttribute('role', 'radiogroup');
  seg.setAttribute('aria-label', label);
  seg.dataset.key = key;
  const mark = () => {
    const cur = String(read(pc, key, def));
    [...seg.children].forEach((b, i) => {
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(String(options[i]?.value) === cur));
      b.dataset.value = String(options[i]?.value);
    });
  };
  mark();
  pc.onDispose(
    pc.settings.on(key, () => {
      seg.setValue(read(pc, key, def));
      mark();
    }),
  );
  const obs = new MutationObserver(mark);
  obs.observe(seg, { childList: true });
  pc.onDispose(() => obs.disconnect());
  return seg;
}

export function boundToggle(pc, key, def, label) {
  return bindToggle(pc, key, def, label);
}

export function appIcon(pc, appId, size = 24) {
  const src = pc.shell.registry?.iconUrl?.(appId) || 'app://shell/assets/app-default.svg';
  return pc.h('img', { class: 'pzs-app-icon', src, alt: '', width: size, height: size, draggable: false });
}

/** A list of rows with ↑ ↓ ✕ buttons (pinned apps, folders…). items: [{ id, label, icon }] */
export function orderedList(pc, { items, onMove, onRemove, empty, removeLabel, className }) {
  const { h, icon, t } = pc;
  if (!items.length) return h('div', { class: ['pzs-list-empty caption text-2', className] }, empty || '');
  return h(
    'div',
    { class: ['pzs-list', className], role: 'list' },
    items.map((it, i) =>
      h(
        'div',
        { class: 'pzs-list-row', role: 'listitem', dataset: { id: it.id } },
        it.icon || null,
        h('span', { class: 'pzs-list-label ellipsis' }, it.label),
        h(
          'span',
          { class: 'pzs-list-btns' },
          h('button', { class: 'btn subtle icon-btn', type: 'button', disabled: i === 0, 'aria-label': `${t('pzs.moveUp')} — ${it.label}`, 'data-tip': t('pzs.moveUp'), onclick: () => onMove(it.id, -1) }, icon('arrow_up', { size: 14 })),
          h('button', { class: 'btn subtle icon-btn', type: 'button', disabled: i === items.length - 1, 'aria-label': `${t('pzs.moveDown')} — ${it.label}`, 'data-tip': t('pzs.moveDown'), onclick: () => onMove(it.id, 1) }, icon('arrow_down', { size: 14 })),
          onRemove ? h('button', { class: 'btn subtle icon-btn pzs-remove', type: 'button', 'aria-label': `${removeLabel || t('pzs.remove')} — ${it.label}`, 'data-tip': removeLabel || t('pzs.remove'), onclick: () => onRemove(it.id) }, icon('dismiss', { size: 14 })) : null,
        ),
      ),
    ),
  );
}

/** Move an id by ±1 in a list (returns a new array). */
export function moved(list, id, d) {
  const out = [...list];
  const i = out.indexOf(id);
  const j = i + d;
  if (i < 0 || j < 0 || j >= out.length) return out;
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}
