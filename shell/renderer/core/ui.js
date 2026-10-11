// Aurora UI kit (JS side). Import in apps:
//   import { h, icon, ui } from '../../core/ui.js';
//
//   h('div', { class: 'row', style: { gap: '4px' }, onclick: fn, dataset: { id: 1 } }, 'text', childNode, [more])
//   icon('folder', { size: 20, filled: true })
//   await ui.menu(eventOrPoint, [{ label, icon, shortcut, action, disabled, checked, danger, submenu: [...] }, '-', ...])
//   await ui.dialog({ title, body, buttons: [{ label, value, primary }], parent: win })   -> value | null (Esc)
//   await ui.alert(message, { title, parent })
//   await ui.confirm(message, { title, okLabel, cancelLabel, danger, parent })          -> boolean
//   await ui.prompt({ title, label, value, placeholder, okLabel, parent, validate })    -> string | null
//   await ui.filePicker({ mode: 'open'|'save'|'folder', title, filters: [{ name, ext: ['.png'] }],
//                         path, name, multiple, parent })                                -> path | [paths] | null
//   ui.toggle({ checked, label, onchange })  ui.slider({ min, max, value, step, oninput })  ui.select({ options:[{value,label}], value, onchange })
//   ui.segmented({ options: [{ value, label, icon }], value, onchange })
//   ui.fileIcon(entry) -> icon name for a file/folder entry ;  ui.tooltips(rootEl) is installed globally
// `parent` (a Win from wm.js) scopes a dialog to that window; omit it for a global modal.
import { icon, iconSvg } from './icons.js';
import { i18n, t } from './i18n.js';
import { api } from './api.js';

export { icon, iconSvg };

export function h(tag, props, ...children) {
  const el = typeof tag === 'string' ? document.createElement(tag) : tag;
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class' || k === 'className') el.className = Array.isArray(v) ? v.filter(Boolean).join(' ') : v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'ref' && typeof v === 'function') v(el);
      else if (k in el && typeof v !== 'string') el[k] = v;
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
  }
  appendChildren(el, children);
  return el;
}

function appendChildren(el, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) appendChildren(el, c);
    else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

// ---------------------------------------------------------------- menus
let openMenus = [];
function closeMenus(from = 0) {
  for (const m of openMenus.splice(from)) m.close(null);
}

function menuPoint(at) {
  if (!at) return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  if (at instanceof Event) {
    if (typeof at.clientX === 'number' && (at.clientX || at.clientY)) return { x: at.clientX, y: at.clientY };
    const r = at.currentTarget?.getBoundingClientRect?.() || at.target?.getBoundingClientRect?.();
    return r ? { x: r.left, y: r.bottom + 4, anchor: r } : { x: 0, y: 0 };
  }
  if (at instanceof Element) {
    const r = at.getBoundingClientRect();
    return { x: r.left, y: r.bottom + 4, anchor: r };
  }
  return at;
}

function buildMenu(items, pt, level, resolve, opts = {}) {
  const el = h('div', { class: ['menu', opts.class], role: 'menu', tabindex: '-1' });
  const entries = [];
  if (opts.iconBar?.length) {
    const bar = h('div', { class: 'menu-iconbar' });
    for (const it of opts.iconBar) {
      bar.appendChild(
        h(
          'button',
          {
            class: 'btn subtle icon-btn',
            'data-tip': it.label,
            disabled: !!it.disabled,
            onclick: (e) => {
              e.stopPropagation();
              closeMenus();
              resolve(it);
              it.action?.();
            },
          },
          icon(it.icon),
        ),
      );
    }
    el.appendChild(bar);
  }
  for (const it of items) {
    if (it === '-' || it?.separator) {
      el.appendChild(h('div', { class: 'menu-sep' }));
      continue;
    }
    if (!it || it.hidden) continue;
    if (it.header) {
      el.appendChild(h('div', { class: 'menu-header' }, it.header));
      continue;
    }
    const row = h(
      'div',
      { class: ['menu-item', it.disabled && 'disabled', it.danger && 'danger'], role: 'menuitem' },
      it.checked !== undefined ? h('span', { class: 'check' }, it.checked ? icon('checkmark', { size: 16 }) : null) : null,
      it.icon ? icon(it.icon, { filled: it.iconFilled }) : opts.hasIcons ? h('span', { class: 'icon' }) : null,
      h('span', { class: 'label' }, it.label),
      it.shortcut ? h('span', { class: 'shortcut' }, it.shortcut) : null,
      it.submenu ? icon('chevron_right', { size: 12 }) : null,
    );
    const activate = (e) => {
      e?.stopPropagation();
      if (it.disabled) return;
      if (it.submenu) {
        openSub();
        return;
      }
      closeMenus();
      resolve(it);
      try {
        it.action?.();
      } catch (err) {
        console.error(err);
      }
    };
    const openSub = () => {
      closeMenus(level + 1);
      const r = row.getBoundingClientRect();
      const sub = showMenu(it.submenu, { x: r.right - 4, y: r.top - 4, sub: r }, level + 1, resolve);
      openMenus.push(sub);
    };
    row.addEventListener('click', activate);
    row.addEventListener('mouseenter', () => {
      entries.forEach((x) => x.row.classList.remove('active'));
      row.classList.add('active');
      if (it.submenu) {
        clearTimeout(row._t);
        row._t = setTimeout(openSub, 200);
      } else if (openMenus.length > level + 1) closeMenus(level + 1);
    });
    entries.push({ row, it, activate });
    el.appendChild(row);
  }
  el._entries = entries;
  return el;
}

function showMenu(items, pt, level, resolve, opts = {}) {
  const hasIcons = items.some((i) => i && i !== '-' && i.icon);
  const el = buildMenu(items, pt, level, resolve, { ...opts, hasIcons });
  el.style.visibility = 'hidden';
  document.body.appendChild(el);
  const r = el.getBoundingClientRect();
  let x = pt.x;
  let y = pt.y;
  if (x + r.width > window.innerWidth - 4) x = pt.sub ? pt.sub.left - r.width + 4 : window.innerWidth - r.width - 4;
  if (y + r.height > window.innerHeight - 4) {
    if (pt.anchor) {
      y = pt.anchor.top - r.height - 4;
      el.classList.add('up');
    } else y = Math.max(4, window.innerHeight - r.height - 4);
  }
  if (opts.above && pt.anchor) {
    y = pt.anchor.top - r.height - 4;
    el.classList.add('up');
  }
  el.style.left = `${Math.max(4, x)}px`;
  el.style.top = `${Math.max(4, y)}px`;
  el.style.visibility = '';
  let active = -1;
  const handle = {
    el,
    close(v) {
      handle.closed = true;
      el.remove();
      if (level === 0) {
        document.removeEventListener('pointerdown', outside, true);
        document.removeEventListener('keydown', keys, true);
        window.removeEventListener('blur', blurClose);
        resolve(v);
      }
    },
  };
  const outside = (e) => {
    if (!openMenus.some((m) => m.el.contains(e.target))) closeMenus();
  };
  const blurClose = () => closeMenus();
  const keys = (e) => {
    const top = openMenus[openMenus.length - 1];
    const ents = top?.el._entries || [];
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (openMenus.length > 1) closeMenus(openMenus.length - 1);
      else closeMenus();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!ents.length) return;
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + ents.length) % ents.length;
      ents.forEach((x, i) => x.row.classList.toggle('active', i === active));
    } else if (e.key === 'Enter' && active >= 0) {
      e.preventDefault();
      ents[active]?.activate();
    }
  };
  if (level === 0) {
    // Keys are captured at once (a key pressed right after opening must reach the menu);
    // pointer/blur listeners wait a task so the click that opened the menu doesn't close it.
    document.addEventListener('keydown', keys, true);
    setTimeout(() => {
      if (handle.closed) return; // closed in the same tick it opened: never attach (would leak)
      document.addEventListener('pointerdown', outside, true);
      window.addEventListener('blur', blurClose);
    });
  }
  return handle;
}

// ---------------------------------------------------------------- dialogs
function dialogHost(parent) {
  if (parent?.el) return { host: parent.el, global: false };
  return { host: document.getElementById('overlays') || document.body, global: true };
}

let dialogSeq = 0;
const openDialogs = []; // stack of open .dialog elements (topmost last)

export const ui = {
  h,
  icon,
  clear,

  menu(at, items, opts = {}) {
    if (at instanceof Event) {
      at.preventDefault?.();
      at.stopPropagation?.();
    }
    closeMenus();
    return new Promise((resolve) => {
      const m = showMenu(items, menuPoint(at), 0, resolve, opts);
      openMenus.push(m);
    });
  },
  closeMenus,

  dialog({ title, body, buttons, parent, width, className, onOpen, closeOnEsc = true } = {}) {
    return new Promise((resolve) => {
      const { host, global } = dialogHost(parent);
      const id = `dlg${++dialogSeq}`;
      const content = typeof body === 'string' ? h('div', { class: 'selectable', style: { whiteSpace: 'pre-wrap' } }, body) : body;
      const btns = (buttons || [{ label: t('common.ok'), value: true, primary: true }]).map((b) =>
        h('button', { class: ['btn', b.primary && 'primary', b.danger && 'danger'], onclick: () => done(b.value) }, b.label),
      );
      const dlg = h(
        'div',
        { class: ['dialog', className], role: 'dialog', 'aria-labelledby': id, style: width ? { width: `${width}px` } : null },
        h('div', { class: 'dialog-body' }, title ? h('div', { class: 'dialog-title', id }, title) : null, content),
        btns.length ? h('div', { class: 'dialog-footer' }, btns) : null,
      );
      const layer = h('div', { class: ['dialog-layer', global && 'global'] }, dlg);
      const keys = (e) => {
        if (e.key === 'Escape' && closeOnEsc) {
          e.stopPropagation();
          done(null);
        } else if (e.key === 'Enter' && !e.shiftKey && !e.defaultPrevented && e.target.tagName !== 'TEXTAREA') {
          // Enter on a focused button activates that button (native click), not the primary one.
          if (e.target.closest?.('button, a, select, [role="button"], [contenteditable="true"]')) return;
          const b = (buttons || []).find((x) => x.primary);
          if (b && !b.disabled) {
            e.preventDefault();
            done(b.value);
          }
        }
      };
      layer.addEventListener('keydown', keys);
      // Tab stays inside the dialog (focus trap).
      layer.addEventListener('keydown', (e) => {
        if (e.key !== 'Tab') return;
        const f = [...dlg.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter(
          (x) => !x.disabled && x.offsetParent !== null,
        );
        if (!f.length) return;
        const i = f.indexOf(document.activeElement);
        const next = e.shiftKey ? (i <= 0 ? f[f.length - 1] : f[i - 1]) : i === -1 || i === f.length - 1 ? f[0] : f[i + 1];
        e.preventDefault();
        next.focus();
      });
      // Esc while focus is outside the topmost dialog (e.g. right after it opened) still closes it,
      // and keys never reach the app behind a modal dialog.
      const outsideKeys = (e) => {
        if (closed) return;
        // The window holding the dialog is gone (closed or removed without its 'close' event): cancel it
        // so its promise settles and these document handlers don't keep eating Tab / Esc for every app.
        if (mounted && !layer.isConnected) return done(null);
        if (openDialogs[openDialogs.length - 1] !== dlg || layer.contains(e.target)) return;
        if (e.key === 'Escape' && closeOnEsc) {
          e.preventDefault();
          e.stopPropagation();
          done(null);
        } else if (e.key === 'Tab') {
          e.preventDefault();
          e.stopPropagation();
          (dlg.querySelector('input, textarea, select, button') || dlg).focus?.();
        }
      };
      document.addEventListener('keydown', outsideKeys, true);
      // Closing the parent window cancels its dialogs (the awaiting code gets null, like Esc).
      const offParentClose = typeof parent?.on === 'function' ? parent.on('close', () => done(null)) : null;
      let mounted = false;
      const opener = document.activeElement;
      openDialogs.push(dlg);
      layer.addEventListener('pointerdown', (e) => {
        if (e.target === layer) {
          dlg.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.015)' }, { transform: 'scale(1)' }], { duration: 200 });
        }
      });
      let closed = false;
      function done(v) {
        if (closed) return;
        if (v !== null && dlg._validate && dlg._validate(v) === false) return;
        closed = true;
        document.removeEventListener('keydown', outsideKeys, true);
        offParentClose?.();
        const idx = openDialogs.indexOf(dlg);
        if (idx >= 0) openDialogs.splice(idx, 1);
        layer.classList.add('closing');
        setTimeout(() => layer.remove(), 170);
        // Give focus back to whatever opened the dialog (if it is still there and focusable).
        if (opener && opener !== document.body && opener.isConnected && typeof opener.focus === 'function') {
          try {
            opener.focus({ preventScroll: true });
          } catch {}
        }
        resolve(v);
      }
      dlg._done = done;
      host.appendChild(layer);
      mounted = true;
      const focusTarget = dlg.querySelector('input, textarea, select, [autofocus]') || btns.find((b) => b.classList.contains('primary')) || btns[0];
      focusTarget?.focus({ preventScroll: true }); // synchronously: an early key press must land in the dialog
      setTimeout(() => {
        if (!closed && !layer.contains(document.activeElement)) focusTarget?.focus({ preventScroll: true });
      }, 30);
      onOpen?.(dlg, done);
    });
  },

  alert(message, { title, parent } = {}) {
    return ui.dialog({ title, body: message, parent, buttons: [{ label: t('common.ok'), value: true, primary: true }] });
  },

  async confirm(message, { title, okLabel, cancelLabel, danger, parent } = {}) {
    const v = await ui.dialog({
      title,
      body: message,
      parent,
      buttons: [
        { label: okLabel || t('common.ok'), value: true, primary: !danger, danger },
        { label: cancelLabel || t('common.cancel'), value: false },
      ],
    });
    return v === true;
  },

  async prompt({ title, label, value = '', placeholder = '', okLabel, parent, validate, select = true, type = 'text' } = {}) {
    const input = h('input', { class: 'input', type, value, placeholder, style: { width: '100%' } });
    const err = h('div', { class: 'field-hint', style: { color: 'var(--danger)', minHeight: '16px' } });
    const body = h('div', { class: 'field', style: { minWidth: '340px', margin: 0 } }, label ? h('label', null, label) : null, input, err);
    let ok = false;
    const v = await ui.dialog({
      title,
      body,
      parent,
      buttons: [
        { label: okLabel || t('common.ok'), value: 'ok', primary: true },
        { label: t('common.cancel'), value: null },
      ],
      onOpen: (dlg) => {
        dlg._validate = () => {
          const msg = validate?.(input.value);
          if (msg) {
            err.textContent = msg;
            input.classList.add('invalid');
            return false;
          }
          ok = true;
          return true;
        };
        setTimeout(() => {
          input.focus();
          if (select) {
            const dot = input.value.lastIndexOf('.');
            input.setSelectionRange(0, dot > 0 ? dot : input.value.length);
          }
        }, 40);
      },
    });
    return v === 'ok' && ok ? input.value : null;
  },

  async filePicker(opts = {}) {
    const { mode = 'open', title, filters = [], multiple = false, parent } = opts;
    const xdg = await api.invoke('fs:xdg');
    let cwd = opts.path || (mode === 'save' ? xdg.documents : xdg.home);
    if (!(await api.invoke('fs:exists', cwd))) cwd = xdg.home;
    let filterIdx = 0;
    let selected = new Set();
    let entries = [];
    const allExts = filters.flatMap((f) => f.ext || []);
    const nameInput = h('input', { class: 'input grow', value: opts.name || '', placeholder: t('ui.fileName') });
    const pathInput = h('input', { class: 'input fp-path', value: cwd });
    const list = h('div', { class: 'fp-list' });
    const filterSel =
      filters.length > 0
        ? h(
            'select',
            { class: 'select', onchange: (e) => ((filterIdx = Number(e.target.value)), render()) },
            filters.map((f, i) => h('option', { value: String(i) }, `${f.name} (${(f.ext || ['*']).map((e) => `*${e}`).join(', ')})`)),
          )
        : null;
    const places = [
      ['home', t('places.home'), xdg.home],
      ['desktop', t('places.desktop'), xdg.desktop],
      ['document', t('places.documents'), xdg.documents],
      ['arrow_download', t('places.downloads'), xdg.downloads],
      ['image', t('places.pictures'), xdg.pictures],
      ['music_note_2', t('places.music'), xdg.music],
      ['video', t('places.videos'), xdg.videos],
    ];
    const side = h(
      'div',
      { class: 'fp-side nav' },
      places.map(([ic, label, p]) => h('div', { class: 'nav-item', onclick: () => go(p) }, icon(ic), h('span', { class: 'ellipsis' }, label))),
    );
    let doneFn = null;
    const accept = () => {
      if (mode === 'folder') {
        const sel = [...selected].map((i) => entries[i]).find((e) => e?.dir);
        return doneFn?.(sel ? sel.path : cwd);
      }
      if (mode === 'save') {
        let n = nameInput.value.trim();
        if (!n) return;
        // Append the selected type's extension only when the name has no extension of ANY offered
        // type ('photo.jpg' stays .jpg even if PNG is selected); '*' (All files) never appends.
        const exts = (filters[filterIdx]?.ext || []).filter((e) => e && e !== '*');
        const known = filters.flatMap((f) => f.ext || []).filter((e) => e && e !== '*');
        const lower = n.toLowerCase();
        if (exts.length && !known.some((e) => lower.endsWith(e.toLowerCase()))) n += exts[0];
        return doneFn?.(n.startsWith('/') ? n : `${cwd.replace(/\/$/, '')}/${n}`);
      }
      const files = [...selected].map((i) => entries[i]).filter((e) => e && !e.dir);
      if (!files.length) {
        const typed = nameInput.value.trim();
        if (typed) return doneFn?.(typed.startsWith('/') ? typed : `${cwd.replace(/\/$/, '')}/${typed}`);
        return;
      }
      return doneFn?.(multiple ? files.map((f) => f.path) : files[0].path);
    };
    async function go(dir) {
      try {
        entries = await api.invoke('fs:list', dir);
        cwd = dir;
        pathInput.value = dir;
        selected = new Set();
        render();
      } catch (err) {
        ui.alert(err.message, { parent });
      }
    }
    function render() {
      clear(list);
      const exts = filters[filterIdx]?.ext || (allExts.length ? allExts : null);
      const shown = entries
        .map((e, i) => [e, i])
        .filter(([e]) => e.dir || mode === 'folder' ? e.dir || false : !exts || exts.includes('*') || exts.includes(e.ext));
      if (!shown.length) list.appendChild(h('div', { class: 'empty' }, t('ui.emptyFolder')));
      for (const [e, i] of shown) {
        const row = h(
          'div',
          {
            class: ['fp-row', selected.has(i) && 'selected'],
            onclick: (ev) => {
              if (!multiple || !ev.ctrlKey) selected = new Set();
              selected.add(i);
              if (!e.dir && mode !== 'folder') nameInput.value = e.name;
              render();
            },
            ondblclick: () => (e.dir ? go(e.path) : accept()),
          },
          icon(ui.fileIcon(e), { filled: e.dir, class: e.dir ? 'folder-icon' : '' }),
          h('span', { class: 'ellipsis' }, e.name),
          h('span', { class: 'caption text-2' }, i18n.formatDate(e.mtime, { dateStyle: 'short', timeStyle: 'short' })),
          h('span', { class: 'caption text-2', style: { textAlign: 'right' } }, e.dir ? '' : i18n.formatSize(e.size)),
        );
        list.appendChild(row);
      }
    }
    const up = h('button', { class: 'btn subtle icon-btn', 'data-tip': t('ui.up'), onclick: () => go(cwd.replace(/\/[^/]+\/?$/, '') || '/') }, icon('arrow_up'));
    const newFolder = h(
      'button',
      {
        class: 'btn subtle',
        onclick: async () => {
          const n = await ui.prompt({ title: t('ui.newFolder'), value: t('ui.newFolder'), parent });
          if (n) {
            await api.invoke('fs:mkdir', `${cwd}/${n}`).catch((e) => ui.alert(e.message, { parent }));
            go(cwd);
          }
        },
      },
      icon('folder_add'),
      t('ui.newFolder'),
    );
    pathInput.addEventListener('keydown', (e) => e.key === 'Enter' && go(pathInput.value));
    const body = h(
      'div',
      { class: 'fp' },
      h('div', { class: 'fp-top' }, up, pathInput, newFolder),
      h('div', { class: 'fp-main' }, side, list),
      h(
        'div',
        { class: 'fp-bottom' },
        mode !== 'folder' ? h('span', null, `${t('ui.fileName')}:`) : null,
        mode !== 'folder' ? nameInput : h('div', { class: 'grow' }),
        filterSel,
      ),
    );
    await go(cwd);
    const res = await new Promise((resolve) => {
      ui.dialog({
        title: title || (mode === 'save' ? t('ui.saveAs') : mode === 'folder' ? t('ui.selectFolder') : t('ui.open')),
        body,
        parent,
        className: 'fp-dialog',
        width: 820,
        buttons: [
          { label: mode === 'save' ? t('common.save') : mode === 'folder' ? t('ui.selectFolder') : t('ui.open'), value: '__accept', primary: true },
          { label: t('common.cancel'), value: null },
        ],
        onOpen: (dlg, done) => {
          dlg.style.maxWidth = 'min(900px, calc(100% - 32px))';
          dlg._validate = (v) => {
            if (v === '__accept') {
              accept();
              return false;
            }
            return true;
          };
          doneFn = (value) => {
            dlg._validate = null;
            resolve(value);
            done(value);
          };
          if (mode === 'save') setTimeout(() => nameInput.focus(), 50);
        },
      }).then((v) => {
        if (v == null) resolve(null);
      });
    });
    if (res && mode === 'save' && !Array.isArray(res) && (await api.invoke('fs:exists', res))) {
      const ok = await ui.confirm(t('ui.replaceConfirm', { name: res.split('/').pop() }), { title: t('ui.saveAs'), okLabel: t('ui.replace'), parent });
      if (!ok) return ui.filePicker(opts);
    }
    return res;
  },

  toggle({ checked = false, label, onchange, disabled } = {}) {
    const input = h('input', { type: 'checkbox', checked, disabled, onchange: (e) => onchange?.(e.target.checked, e) });
    const el = h('label', { class: 'toggle' }, input, label ? h('span', { class: 'toggle-label' }, label) : null);
    el.input = input;
    return el;
  },

  slider({ min = 0, max = 100, step = 1, value = 0, oninput, onchange, style } = {}) {
    const el = h('input', { type: 'range', class: 'slider', min, max, step, value, style });
    const paint = () => el.style.setProperty('--val', `${((el.value - min) / (max - min)) * 100}%`);
    el.addEventListener('input', (e) => {
      paint();
      oninput?.(Number(el.value), e);
    });
    el.addEventListener('change', (e) => onchange?.(Number(el.value), e));
    el.setValue = (v) => {
      el.value = v;
      paint();
    };
    paint();
    return el;
  },

  select({ options = [], value, onchange, style } = {}) {
    const el = h(
      'select',
      { class: 'select', style, onchange: (e) => onchange?.(e.target.value, e) },
      options.map((o) => h('option', { value: String(o.value), selected: String(o.value) === String(value) }, o.label)),
    );
    return el;
  },

  segmented({ options = [], value, onchange } = {}) {
    const el = h('div', { class: 'segmented' });
    const render = (v) => {
      clear(el);
      for (const o of options) {
        el.appendChild(
          h(
            'button',
            {
              class: String(o.value) === String(v) ? 'selected' : '',
              'data-tip': o.tip,
              onclick: () => {
                render(o.value);
                onchange?.(o.value);
              },
            },
            o.icon ? icon(o.icon) : null,
            o.label || null,
          ),
        );
      }
    };
    render(value);
    el.setValue = render;
    return el;
  },

  fileIcon(e) {
    if (!e) return 'document';
    if (e.dir) return 'folder';
    const x = (e.ext || '').toLowerCase();
    if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.avif', '.ico'].includes(x)) return 'image';
    if (['.mp3', '.wav', '.ogg', '.oga', '.flac', '.m4a', '.aac', '.opus'].includes(x)) return 'music_note_2';
    if (['.mp4', '.webm', '.mkv', '.mov', '.avi', '.ogv', '.m4v'].includes(x)) return 'video';
    if (['.zip', '.tar', '.gz', '.xz', '.bz2', '.7z', '.rar', '.zst', '.deb'].includes(x)) return 'folder_zip';
    if (['.pdf'].includes(x)) return 'document_pdf';
    if (['.js', '.ts', '.py', '.c', '.h', '.cpp', '.rs', '.go', '.java', '.sh', '.json', '.html', '.css', '.xml', '.yml', '.yaml', '.toml'].includes(x)) return 'code';
    if (['.txt', '.md', '.log', '.ini', '.conf', '.cfg', '.csv'].includes(x)) return 'document_text';
    if (['.eml'].includes(x)) return 'mail';
    if (['.iso', '.img'].includes(x)) return 'cd';
    return 'document';
  },

  /** Inject a stylesheet once: ui.loadCss('app://shell/core/features/quick.css') */
  loadCss(href) {
    if (document.querySelector(`link[data-href="${href}"]`)) return;
    document.head.appendChild(h('link', { rel: 'stylesheet', href, 'data-href': href }));
  },

  formatSize: (b) => i18n.formatSize(b),
  formatDate: (d, o) => i18n.formatDate(d, o),
};

// ---------------------------------------------------------------- tooltips
// Any element with data-tip="text" gets a Fluent tooltip after a short hover.
(function installTooltips() {
  let timer = null;
  let tip = null;
  let target = null;
  const hide = () => {
    clearTimeout(timer);
    tip?.remove();
    tip = null;
    target = null;
  };
  document.addEventListener(
    'pointerover',
    (e) => {
      const el = e.target.closest?.('[data-tip]');
      if (el === target) return;
      hide();
      if (!el || !el.dataset.tip) return;
      target = el;
      timer = setTimeout(() => {
        if (!target?.isConnected) return;
        tip = h('div', { class: 'tooltip' }, target.dataset.tip);
        document.body.appendChild(tip);
        const r = target.getBoundingClientRect();
        const tr = tip.getBoundingClientRect();
        let x = r.left + r.width / 2 - tr.width / 2;
        let y = target.dataset.tipPos === 'below' ? r.bottom + 8 : r.top - tr.height - 8;
        if (y < 4) y = r.bottom + 8;
        x = Math.max(4, Math.min(window.innerWidth - tr.width - 4, x));
        tip.style.left = `${x}px`;
        tip.style.top = `${y}px`;
      }, 600);
    },
    true,
  );
  document.addEventListener('pointerdown', hide, true);
  document.addEventListener('wheel', hide, true);
  document.addEventListener('keydown', hide, true);
})();
