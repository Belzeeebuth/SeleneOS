// Drawing app chrome: the title bar ("…" menu with the file, edit and view commands, quick undo /
// redo / save, the document title), one floating tool island inside the canvas area (selection,
// tools, brushes, a shapes popover), a compact options bar along the top (clipboard, image, shape
// outline and fill, size, and the current colours with the Selene palette in a popover), the
// contextual text/fill bar, flyouts and the status bar.
// The controller (app.js) owns all state; chrome reads it through `app` and calls app.cmd()/setters.
import { BRUSHES, createEngine } from './lib/brushes.js';
import { SHAPES, OUTLINES, FILLS, shapeIcon } from './lib/shapes.js';
import { previewStroke } from './art.js';

// The Selene palette: twelve colours from the lunar and ambiance hues, plus black and white.
// (Picture colours, not interface colours: they stay plain hex values.)
export const PALETTE = [
  ['#1b2440', 'deepNight'], ['#3d5bc4', 'nightBlue'], ['#7f95e8', 'moonBlue'], ['#c9d3e6', 'moonSilver'],
  ['#7a5fd0', 'violet'], ['#c45a8a', 'duskRose'], ['#d64545', 'ember'], ['#e9a23b', 'amber'],
  ['#3f9a78', 'sage'], ['#3aa3b8', 'lagoon'], ['#000000', 'black'], ['#ffffff', 'white'],
];

export const TOOLS = [
  ['pencil', 'edit', 'P'],
  ['fill', 'paint_bucket', 'F'],
  ['text', 'text_t', 'T'],
  ['eraser', 'eraser', 'E'],
  ['picker', 'eyedropper', 'I'],
  ['zoom', 'zoom_in', 'Z'],
];

const SIZES = [1, 2, 3, 5, 8, 12, 16, 24, 32, 50];
const COLLAPSE_ORDER = ['shapeopts', 'colors'];
const SVGNS = 'http://www.w3.org/2000/svg';

export function createChrome(app) {
  const { h, icon, ui } = app.ctx;
  const t = (k, v) => app.ctx.t(k, v);
  // Locale-aware zoom percentage ("70.8%" in English, "70,8 %" in French).
  const pct = (z) => {
    const r = Math.round(z * 1000) / 1000;
    try { return app.ctx.i18n.formatNumber(r, { style: 'percent', maximumFractionDigits: 1 }); } catch { return `${r * 100}%`; }
  };
  const S = app.S;
  const refs = {};
  let flyoutState = null;

  // ------------------------------------------------------------ helpers
  const tip = (label, key) => (key ? `${label} (${key})` : label);
  // ui.menu wrapper: keyboard focus returns to the canvas once the menu is gone.
  const menuAt = (anchor, items) => ui.menu(anchor, items).finally(() => app.restoreFocus?.());

  function btn({ ic, label, key, cls, onclick, chevron, size = 20, filled, aria, attrs }) {
    const b = h(
      'button',
      {
        type: 'button',
        class: ['pt-b', cls],
        'data-tip': tip(label, key),
        'aria-label': aria || label,
        onclick,
        ...(attrs || {}),
      },
      typeof ic === 'string' ? icon(ic, { size, filled }) : ic,
      chevron ? icon('chevron_down', { size: 10, class: 'pt-chev' }) : null,
    );
    if (chevron) b.setAttribute('aria-haspopup', 'true');
    return b;
  }

  function svgIcon(d, { size = 20, fill = false } = {}) {
    const s = document.createElementNS(SVGNS, 'svg');
    s.setAttribute('viewBox', '0 0 20 20');
    s.setAttribute('width', size);
    s.setAttribute('height', size);
    s.setAttribute('aria-hidden', 'true');
    s.classList.add('pt-svg');
    const p = document.createElementNS(SVGNS, 'path');
    p.setAttribute('d', d);
    p.setAttribute('fill', fill ? 'currentColor' : 'none');
    p.setAttribute('stroke', 'currentColor');
    p.setAttribute('stroke-width', '1.25');
    p.setAttribute('stroke-linejoin', 'round');
    p.setAttribute('stroke-linecap', 'round');
    p.setAttribute('vector-effect', 'non-scaling-stroke');
    s.appendChild(p);
    return s;
  }

  // ------------------------------------------------------------ flyouts (rendered inside the window)
  function closeFlyout() {
    const f = flyoutState;
    if (!f) return;
    flyoutState = null;
    f.closed = true;
    clearTimeout(f.armTimer);
    document.removeEventListener('pointerdown', f.outside, true);
    window.removeEventListener('blur', f.blur);
    f.anchor?.classList.remove('open');
    f.anchor?.setAttribute('aria-expanded', 'false');
    if (f.el.contains(document.activeElement)) {
      if (f.anchor?.isConnected && f.anchor.offsetParent) f.anchor.focus({ preventScroll: true });
      else app.restoreFocus?.();
    }
    f.el.classList.add('closing');
    setTimeout(() => f.el.remove(), 140);
    f.onClose?.();
  }

  function flyout(anchor, content, { className, onClose, focus = true, side = 'below' } = {}) {
    if (flyoutState?.anchor === anchor) {
      closeFlyout();
      return null;
    }
    closeFlyout();
    ui.closeMenus?.();
    const host = app.win.el;
    const el = h('div', { class: ['pt-flyout', className], role: 'dialog' }, content);
    host.appendChild(el);
    const hr = host.getBoundingClientRect();
    const ar = anchor.getBoundingClientRect();
    const fr = el.getBoundingClientRect();
    const ox = hr.left + host.clientLeft;
    const oy = hr.top + host.clientTop;
    let x = side === 'right' ? ar.right - ox + 8 : ar.left - ox;
    let y = side === 'right' ? ar.top - oy : ar.bottom - oy + 4;
    if (x + fr.width > host.clientWidth - 8) x = host.clientWidth - fr.width - 8;
    if (y + fr.height > host.clientHeight - 8) {
      const above = ar.top - oy - fr.height - 4;
      if (above >= 8) {
        y = above;
        el.classList.add('up');
      } else y = Math.max(8, host.clientHeight - fr.height - 8);
    }
    el.style.left = `${Math.max(8, x)}px`;
    el.style.top = `${Math.max(8, y)}px`;
    const outside = (e) => {
      if (!el.contains(e.target) && !anchor.contains(e.target)) closeFlyout();
    };
    const blur = () => closeFlyout();
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeFlyout();
        anchor.focus();
      }
    });
    window.addEventListener('blur', blur);
    anchor.classList.add('open');
    anchor.setAttribute('aria-expanded', 'true');
    const state = { el, anchor, outside, blur, onClose, closed: false, armTimer: 0 };
    flyoutState = state;
    // Armed one task later so the click that opened the flyout doesn't close it; never armed if
    // the flyout was closed meanwhile (that listener would otherwise stay on the document).
    state.armTimer = setTimeout(() => {
      if (!state.closed) document.addEventListener('pointerdown', outside, true);
    });
    if (focus) setTimeout(() => (el.querySelector('.pt-sel-item, .selected, button, input, [tabindex]') || el).focus?.(), 30);
    return el;
  }

  // Arrow-key navigation inside a grid of buttons, with a roving tab stop: the grid is a single
  // Tab stop (its selected item, else the last focused one) instead of one stop per button.
  function gridNav(container, cols) {
    const items = () => [...container.querySelectorAll('button:not([disabled])')];
    const setStop = (b) => {
      for (const x of container.querySelectorAll('button')) x.tabIndex = x === b ? 0 : -1;
    };
    container.addEventListener('keydown', (e) => {
      const list = items();
      const i = list.indexOf(document.activeElement);
      if (i < 0) return;
      const d = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols }[e.key];
      let next = null;
      if (d) next = list[Math.max(0, Math.min(list.length - 1, i + d))];
      else if (e.key === 'Home') next = list[0];
      else if (e.key === 'End') next = list[list.length - 1];
      if (!next) return;
      e.preventDefault();
      setStop(next);
      next.focus();
    });
    container.addEventListener('focusin', (e) => {
      const b = e.target.closest?.('button');
      if (b && container.contains(b)) setStop(b);
    });
    container._sync = () => {
      if (container.contains(document.activeElement)) return;
      const list = items();
      const cur = list.find((b) => b.classList.contains('on') || b.classList.contains('selected') || b.classList.contains('active')) || list.find((b) => b.tabIndex === 0) || list[0];
      if (cur) setStop(cur);
    };
    container._sync();
  }

  // ------------------------------------------------------------ title bar (menus + quick access + title)
  function buildTitlebar() {
    refs.more = btn({ ic: 'dots-three', label: t('menu.more'), key: 'Alt+F', cls: 'pt-qa pt-more', size: 18, attrs: { 'aria-haspopup': 'menu' }, onclick: (e) => openMenu('more', e.currentTarget) });
    refs.qaSave = btn({ ic: 'save', label: t('file.save'), key: 'Ctrl+S', cls: 'pt-qa', size: 16, onclick: () => app.cmd('save') });
    refs.qaUndo = btn({ ic: 'arrow_undo', label: t('edit.undo'), key: 'Ctrl+Z', cls: 'pt-qa', size: 16, onclick: () => app.cmd('undo') });
    refs.qaRedo = btn({ ic: 'arrow_redo', label: t('edit.redo'), key: 'Ctrl+Y', cls: 'pt-qa', size: 16, onclick: () => app.cmd('redo') });
    refs.title = h('div', { class: 'pt-doctitle ellipsis' });
    return h(
      'div',
      { class: 'pt-tb' },
      refs.more,
      h('div', { class: 'pt-tb-sep' }),
      refs.qaSave,
      refs.qaUndo,
      refs.qaRedo,
      refs.title,
    );
  }

  const fmtItems = () =>
    ['png', 'jpeg', 'bmp', 'gif', 'webp'].map((f) => ({ label: t(`file.${f}`), icon: 'image', action: () => app.cmd('saveAs', f) }));

  // "…": the file commands, the clipboard actions, then the edit and view commands in two submenus.
  const clipItems = () => [
    { label: t('edit.cut'), icon: 'cut', shortcut: 'Ctrl+X', disabled: !app.can('cut'), action: () => app.cmd('cut') },
    { label: t('edit.copy'), icon: 'copy', shortcut: 'Ctrl+C', disabled: !app.can('copy'), action: () => app.cmd('copy') },
    { label: t('edit.paste'), icon: 'clipboard_paste', shortcut: 'Ctrl+V', action: () => app.cmd('paste') },
    { label: t('edit.pasteFrom'), icon: 'image_add', action: () => app.cmd('pasteFrom') },
  ];
  async function openMenu(id, anchor = refs.more) {
    closeFlyout();
    const items =
      id === 'more'
        ? [...menuItems('file'), '-', ...clipItems(), '-', { label: t('menu.edit'), icon: 'pencil-simple', submenu: menuItems('edit') }, { label: t('menu.view'), icon: 'eye', submenu: menuItems('view') }]
        : menuItems(id);
    anchor.classList.add('open');
    await menuAt(anchor, items);
    anchor.classList.remove('open');
  }

  function menuItems(id) {
    const c = (k) => app.can(k);
    let items = [];
    if (id === 'file') {
      const recent = app.recent();
      items = [
        { label: t('file.new'), icon: 'document_add', shortcut: 'Ctrl+N', action: () => app.cmd('new') },
        { label: t('file.open'), icon: 'folder_open', shortcut: 'Ctrl+O', action: () => app.cmd('open') },
        { label: t('file.import'), icon: 'image_add', submenu: [{ label: t('file.fromFile'), icon: 'folder_open', action: () => app.cmd('pasteFrom') }] },
        {
          label: t('file.recent'),
          icon: 'history',
          submenu: recent.length
            ? [...recent.map((p) => ({ label: p.split('/').pop(), icon: 'image', action: () => app.cmd('openRecent', p) })), '-', { label: t('file.clearRecent'), action: () => app.cmd('clearRecent') }]
            : [{ label: t('file.noRecent'), disabled: true }],
        },
        '-',
        { label: t('file.save'), icon: 'save', shortcut: 'Ctrl+S', action: () => app.cmd('save') },
        { label: t('file.saveAs'), icon: 'save_copy', submenu: [...fmtItems(), '-', { label: t('file.otherFormats'), shortcut: 'F12', action: () => app.cmd('saveAs') }] },
        '-',
        {
          label: t('file.wallpaper'),
          icon: 'desktop',
          submenu: ['fill', 'tile', 'center'].map((f) => ({ label: t(`file.wp_${f}`), action: () => app.cmd('wallpaper', f) })),
        },
        { label: t('file.props'), icon: 'image_edit', shortcut: 'Ctrl+E', action: () => app.cmd('props') },
        '-',
        { label: t('file.about'), icon: 'info', action: () => app.cmd('about') },
        { label: t('file.exit'), icon: 'dismiss', shortcut: 'Alt+F4', action: () => app.cmd('exit') },
      ];
    } else if (id === 'edit') {
      items = [
        { label: t('edit.undo'), icon: 'arrow_undo', shortcut: 'Ctrl+Z', disabled: !c('undo'), action: () => app.cmd('undo') },
        { label: t('edit.redo'), icon: 'arrow_redo', shortcut: 'Ctrl+Y', disabled: !c('redo'), action: () => app.cmd('redo') },
        '-',
        { label: t('edit.cut'), icon: 'cut', shortcut: 'Ctrl+X', disabled: !c('cut'), action: () => app.cmd('cut') },
        { label: t('edit.copy'), icon: 'copy', shortcut: 'Ctrl+C', disabled: !c('copy'), action: () => app.cmd('copy') },
        { label: t('edit.paste'), icon: 'clipboard_paste', shortcut: 'Ctrl+V', action: () => app.cmd('paste') },
        { label: t('edit.pasteFrom'), icon: 'image_add', action: () => app.cmd('pasteFrom') },
        '-',
        { label: t('edit.selectAll'), icon: 'select_all_on', shortcut: 'Ctrl+A', action: () => app.cmd('selectAll') },
        { label: t('edit.invert'), icon: 'select_all_off', disabled: !c('invertSel'), action: () => app.cmd('invertSel') },
        { label: t('edit.delete'), icon: 'delete', shortcut: 'Del', disabled: !c('deleteSel'), action: () => app.cmd('deleteSel') },
        { label: t('edit.crop'), icon: 'crop', shortcut: 'Ctrl+Shift+X', disabled: !c('crop'), action: () => app.cmd('crop') },
        '-',
        { label: t('image.resize'), icon: 'resize_image', shortcut: 'Ctrl+W', action: () => app.cmd('resize') },
      ];
    } else {
      items = [
        { label: t('view.zoomIn'), icon: 'zoom_in', shortcut: 'Ctrl++', action: () => app.cmd('zoomIn') },
        { label: t('view.zoomOut'), icon: 'zoom_out', shortcut: 'Ctrl+-', action: () => app.cmd('zoomOut') },
        { label: t('view.actual'), icon: 'ratio_one_to_one', shortcut: 'Ctrl+1', action: () => app.cmd('zoom100') },
        { label: t('view.fit'), icon: 'zoom_fit', shortcut: 'Ctrl+0', action: () => app.cmd('zoomFit') },
        '-',
        { label: t('view.rulers'), checked: !!S.rulers, shortcut: 'Ctrl+R', action: () => app.cmd('rulers') },
        { label: t('view.grid'), checked: !!S.grid, shortcut: 'Ctrl+G', action: () => app.cmd('grid') },
        { label: t('view.status'), checked: S.statusbar !== false, action: () => app.cmd('statusbar') },
        '-',
        { label: t('view.fullscreen'), icon: 'full_screen_maximize', shortcut: 'F11', action: () => app.cmd('fullscreen') },
      ];
    }
    return items;
  }

  // ------------------------------------------------------------ command bar
  const groups = {};

  // A group has no visible caption (its name is the aria-label and the compact button's tooltip).
  function group(id, body, compactIcon) {
    const compact = btn({
      ic: compactIcon,
      label: t(`groups.${id}`),
      cls: 'big pt-g-compact',
      chevron: true,
      size: 24,
      onclick: (e) => openCompact(id, e.currentTarget),
    });
    const el = h('div', { class: 'pt-g', role: 'group', 'aria-label': t(`groups.${id}`), dataset: { g: id } }, h('div', { class: 'pt-g-main' }, body, compact));
    groups[id] = { el, body, compact };
    return el;
  }

  function openCompact(id, anchor) {
    const g = groups[id];
    const home = g.body.parentNode;
    const marker = document.createComment('pt');
    home.insertBefore(marker, g.body);
    flyout(anchor, h('div', { class: 'pt-g-fly' }, g.body), {
      className: `pt-fly-group pt-fly-${id}`,
      onClose: () => {
        marker.parentNode?.insertBefore(g.body, marker);
        marker.remove();
      },
    });
  }

  function buildClipboard() {
    refs.paste = h(
      'div',
      { class: 'pt-split big' },
      btn({ ic: 'clipboard_paste', label: t('edit.paste'), key: 'Ctrl+V', cls: 'pt-split-main', size: 24, onclick: () => app.cmd('paste') }),
      btn({
        ic: icon('chevron_down', { size: 10 }),
        label: t('clip.pasteOptions'),
        cls: 'pt-split-arrow',
        onclick: (e) =>
          menuAt(e.currentTarget, [
            { label: t('edit.paste'), icon: 'clipboard_paste', shortcut: 'Ctrl+V', action: () => app.cmd('paste') },
            { label: t('edit.pasteFrom'), icon: 'image_add', action: () => app.cmd('pasteFrom') },
          ]),
      }),
    );
    refs.cut = btn({ ic: 'cut', label: t('edit.cut'), key: 'Ctrl+X', cls: 'sm', onclick: () => app.cmd('cut') });
    refs.copy = btn({ ic: 'copy', label: t('edit.copy'), key: 'Ctrl+C', cls: 'sm', onclick: () => app.cmd('copy') });
    return group('clipboard', h('div', { class: 'pt-g-body' }, refs.paste, h('div', { class: 'pt-col' }, refs.cut, refs.copy)), 'clipboard_paste');
  }

  function selectMenu(anchor) {
    const c = (k) => app.can(k);
    menuAt(anchor, [
      { header: t('image.selectShapes') },
      { label: t('image.rectSel'), icon: 'select_object', checked: S.selMode === 'rect', action: () => app.setSelMode('rect') },
      { label: t('image.freeSel'), icon: 'lasso', checked: S.selMode === 'free', action: () => app.setSelMode('free') },
      '-',
      { header: t('image.selectOptions') },
      { label: t('edit.selectAll'), icon: 'select_all_on', shortcut: 'Ctrl+A', action: () => app.cmd('selectAll') },
      { label: t('edit.invert'), icon: 'select_all_off', disabled: !c('invertSel'), action: () => app.cmd('invertSel') },
      { label: t('edit.delete'), icon: 'delete', shortcut: 'Del', disabled: !c('deleteSel'), action: () => app.cmd('deleteSel') },
      { label: t('image.transparent'), icon: 'transparency_square', checked: !!S.transparentSel, action: () => app.cmd('transparentSel') },
    ]);
  }

  function rotateMenu(anchor) {
    menuAt(anchor, [
      { label: t('image.rotR'), icon: 'rotate_right', action: () => app.cmd('rotR') },
      { label: t('image.rotL'), icon: 'rotate_left', action: () => app.cmd('rotL') },
      { label: t('image.rot180'), icon: 'arrow_rotate_clockwise', action: () => app.cmd('rot180') },
    ]);
  }

  function flipMenu(anchor) {
    menuAt(anchor, [
      { label: t('image.flipV'), icon: 'flip_vertical', action: () => app.cmd('flipV') },
      { label: t('image.flipH'), icon: 'flip_horizontal', action: () => app.cmd('flipH') },
    ]);
  }

  function buildImage() {
    refs.select = h(
      'div',
      { class: 'pt-split big' },
      (refs.selectMain = btn({ ic: 'select_object', label: t('image.select'), key: 'S', cls: 'pt-split-main', size: 20, onclick: () => app.setTool('select') })),
      btn({ ic: icon('chevron_down', { size: 10 }), label: t('image.selectOptions'), cls: 'pt-split-arrow', onclick: (e) => selectMenu(e.currentTarget) }),
    );
    // One compact "Image" menu: crop, resize, rotate, flip (the shortcuts are unchanged).
    refs.imageBtn = h(
      'button',
      {
        type: 'button',
        class: 'pt-b pt-image-btn',
        'aria-haspopup': 'menu',
        'data-tip': t('groups.image'),
        onclick: (e) =>
          menuAt(e.currentTarget, [
            { label: t('edit.crop'), icon: 'crop', shortcut: 'Ctrl+Shift+X', disabled: !app.can('crop'), action: () => app.cmd('crop') },
            { label: t('image.resize'), icon: 'resize_image', shortcut: 'Ctrl+W', action: () => app.cmd('resize') },
            '-',
            { label: t('image.rotR'), icon: 'rotate_right', action: () => app.cmd('rotR') },
            { label: t('image.rotL'), icon: 'rotate_left', action: () => app.cmd('rotL') },
            { label: t('image.rot180'), icon: 'arrow_rotate_clockwise', action: () => app.cmd('rot180') },
            '-',
            { label: t('image.flipV'), icon: 'flip_vertical', action: () => app.cmd('flipV') },
            { label: t('image.flipH'), icon: 'flip_horizontal', action: () => app.cmd('flipH') },
          ]),
      },
      icon('image', { size: 18 }),
      h('span', { class: 'pt-image-lbl' }, t('groups.image')),
      icon('caret-down', { size: 10, class: 'pt-chev' }),
    );
    return group('image', h('div', { class: 'pt-g-body' }, refs.imageBtn), 'image');
  }

  function buildTools() {
    refs.tools = {};
    const grid = h('div', { class: 'pt-tools', role: 'radiogroup', 'aria-label': t('groups.tools') });
    refs.toolsGrid = grid;
    for (const [id, ic, key] of TOOLS) {
      const b = btn({ ic, label: t(`tools.${id}`), key, cls: 'sm tool', onclick: () => app.setTool(id), attrs: { role: 'radio', dataset: { tool: id } } });
      refs.tools[id] = b;
      grid.appendChild(b);
    }
    gridNav(grid, 1);
    return group('tools', h('div', { class: 'pt-g-body' }, grid), 'edit');
  }

  function brushFlyout(anchor) {
    const list = h('div', { class: 'pt-brush-list', role: 'listbox', 'aria-label': t('groups.brushes') });
    const color = getComputedStyle(app.win.el).getPropertyValue('--text').trim() || '#000';
    for (const id of BRUSHES) {
      const cv = h('canvas', { class: 'pt-brush-prev', width: 192, height: 48 });
      const item = h(
        'button',
        {
          type: 'button',
          class: ['pt-brush-item', S.tool === 'brush' && S.brush === id && 'selected'],
          role: 'option',
          'aria-selected': String(S.tool === 'brush' && S.brush === id),
          onclick: () => {
            app.setBrush(id);
            closeFlyout();
          },
        },
        cv,
        h('span', { class: 'pt-brush-name' }, t(`brushes.${id}`)),
      );
      list.appendChild(item);
      requestAnimationFrame(() => previewStroke(cv, id, color, createEngine));
    }
    gridNav(list, 1);
    flyout(anchor, list, { className: 'pt-fly-brushes', side: 'right' });
  }

  function buildBrushes() {
    refs.brushes = btn({
      ic: 'paint_brush',
      label: t('groups.brushes'),
      key: 'B',
      cls: 'sm tool pt-brushes',
      chevron: true,
      size: 20,
      onclick: (e) => {
        app.setTool('brush');
        brushFlyout(e.currentTarget);
      },
    });
    return group('brushes', h('div', { class: 'pt-g-body' }, refs.brushes), 'paint_brush');
  }

  function buildShapes() {
    refs.shapes = {};
    const gal = h('div', { class: 'pt-gallery', role: 'radiogroup', 'aria-label': t('groups.shapes') });
    refs.gallery = gal;
    for (const id of SHAPES) {
      const b = btn({
        ic: svgIcon(shapeIcon(id), { size: 18 }),
        label: t(`shapes.${id}`),
        cls: 'shape',
        onclick: (e) => {
          app.setShape(id);
          // Picked with the mouse: the popover closes; with the keyboard it stays for arrows.
          if (e.detail > 0 && flyoutState?.anchor === refs.shapesBtn) closeFlyout();
        },
        attrs: { role: 'radio', dataset: { shape: id } },
      });
      refs.shapes[id] = b;
      gal.appendChild(b);
    }
    gridNav(gal, 6);
    refs.outline = btn({
      ic: 'color_line',
      label: t('shapeopts.outline'),
      cls: 'sm wide',
      chevron: true,
      onclick: (e) =>
        menuAt(
          e.currentTarget,
          OUTLINES.map((o) => ({ label: t(`outline.${o}`), checked: S.outline === o, action: () => app.setOutline(o) })),
        ),
    });
    refs.fillStyle = btn({
      ic: 'color_fill',
      label: t('shapeopts.fill'),
      cls: 'sm wide',
      chevron: true,
      onclick: (e) =>
        menuAt(
          e.currentTarget,
          FILLS.map((o) => ({ label: t(`fillstyle.${o}`), checked: S.fill === o, action: () => app.setFillStyle(o) })),
        ),
    });
    refs.shapeOpts = group('shapeopts', h('div', { class: 'pt-g-body' }, h('div', { class: 'pt-col' }, refs.outline, refs.fillStyle)), 'shapes');
    refs.shapesBtn = btn({
      ic: svgIcon(shapeIcon(S.shape || 'rect'), { size: 20 }),
      label: t('groups.shapes'),
      cls: 'sm tool pt-shapes-btn',
      chevron: true,
      onclick: (e) => popover(e.currentTarget, gal, 'pt-fly-shapes'),
    });
    // The gallery lives in a hidden store when its popover is closed (keeps its state and hooks).
    refs.galStore = h('div', { class: 'pt-store', hidden: true }, gal);
    return group('shapes', h('div', { class: 'pt-g-body' }, refs.shapesBtn, refs.galStore), 'shapes');
  }

  // Opens `content` (kept in a hidden store) as a popover next to `anchor`; puts it back on close.
  function popover(anchor, content, className, side = 'right') {
    const home = content.parentNode;
    const f = flyout(anchor, h('div', { class: 'pt-pop' }, content), {
      className,
      side,
      onClose: () => home.appendChild(content),
    });
    if (!f) home.appendChild(content);
    return f;
  }

  function sizeFlyout(anchor) {
    const cur = app.getSize();
    const list = h('div', { class: 'pt-size-list', role: 'listbox', 'aria-label': t('groups.size') });
    for (const s of SIZES) {
      list.appendChild(
        h(
          'button',
          {
            type: 'button',
            class: ['pt-size-item', cur === s && 'selected'],
            role: 'option',
            'aria-selected': String(cur === s),
            onclick: () => {
              app.setSize(s);
              closeFlyout();
            },
          },
          h('span', { class: 'pt-size-num' }, `${s}px`),
          h('span', { class: 'pt-size-line' }, h('i', { style: { height: `${Math.min(22, Math.max(1, s * 0.7))}px` } })),
        ),
      );
    }
    gridNav(list, 1);
    const val = h('input', { class: 'input pt-size-input', type: 'number', min: 1, max: 50, value: cur, 'aria-label': t('groups.size') });
    const slider = ui.slider({
      min: 1,
      max: 50,
      value: cur,
      oninput: (v) => {
        val.value = v;
        app.setSize(v);
      },
    });
    val.addEventListener('change', () => {
      const v = Math.max(1, Math.min(50, Math.round(Number(val.value) || 1)));
      val.value = v;
      slider.setValue(v);
      app.setSize(v);
    });
    flyout(anchor, h('div', { class: 'pt-size-fly' }, list, h('div', { class: 'pt-size-row' }, slider, val)), { className: 'pt-fly-size' });
  }

  function buildSize() {
    refs.size = btn({ ic: 'line_thickness', label: t('groups.size'), cls: 'sm wide', chevron: true, size: 20, onclick: (e) => sizeFlyout(e.currentTarget) });
    return group('size', h('div', { class: 'pt-g-body' }, refs.size), 'line_thickness');
  }

  function swatch(color, name, { custom = false, index } = {}) {
    const b = h('button', {
      type: 'button',
      class: ['pt-sw', !color && 'pt-empty'],
      'data-tip': color ? `${name} (${color.toUpperCase()})` : t('colors.emptySlot'),
      'aria-label': color ? `${name} ${color}` : t('colors.emptySlot'),
      dataset: { color: color || '', custom: custom ? String(index) : '' },
    });
    if (color) b.style.setProperty('--c', color);
    b.addEventListener('click', (e) => {
      if (color) {
        app.setColor(S.slot, color);
        // Picked with the mouse: the popover closes, and a colour picked while typing text keeps
        // the text box active. With the keyboard the popover stays open for the arrow keys.
        if (e.detail > 0) {
          if (flyoutState?.anchor === refs.palBtn) closeFlyout();
          app.focusEditor?.();
        }
      } else {
        closeFlyout();
        app.cmd('editColors');
      }
    });
    b.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (color) {
        app.setColor('secondary', color);
        app.focusEditor?.();
      }
    });
    return b;
  }

  function buildColors() {
    refs.c1 = h(
      'button',
      { type: 'button', class: 'pt-cur', 'data-tip': t('colors.c1tip'), 'aria-label': t('colors.c1'), onclick: () => app.setSlot('primary') },
      h('span', { class: 'pt-cur-dot' }),
    );
    refs.c2 = h(
      'button',
      { type: 'button', class: 'pt-cur c2', 'data-tip': t('colors.c2tip'), 'aria-label': t('colors.c2'), onclick: () => app.setSlot('secondary') },
      h('span', { class: 'pt-cur-dot' }),
    );
    refs.palette = h('div', { class: 'pt-palette', role: 'group', 'aria-label': t('groups.colors') });
    refs.custom = h('div', { class: 'pt-palette custom' });
    for (const [c, n] of PALETTE) refs.palette.appendChild(swatch(c, t(`colors.${n}`)));
    renderCustom();
    // Custom colour picker, at the bottom of the popover.
    refs.edit = h(
      'button',
      { type: 'button', class: 'btn subtle small pt-edit-colors', onclick: () => (closeFlyout(), app.cmd('editColors')) },
      icon('eyedropper', { size: 16 }),
      h('span', {}, t('colors.edit')),
    );
    refs.palWrap = h('div', { class: 'pt-pal-wrap' }, h('div', { class: 'pt-pal-cap' }, t('colors.palette')), refs.palette, h('div', { class: 'pt-pal-cap' }, t('colors.customs')), refs.custom, refs.edit);
    gridNav(refs.palWrap, 6);
    refs.palStore = h('div', { class: 'pt-store', hidden: true }, refs.palWrap);
    refs.palBtn = btn({
      ic: 'palette',
      label: t('colors.choose'),
      cls: 'sm wide pt-pal-btn',
      chevron: true,
      size: 18,
      onclick: (e) => popover(e.currentTarget, refs.palWrap, 'pt-fly-palette', 'below'),
    });
    refs.miniCur = h('span', { class: 'pt-mini-cur', 'aria-hidden': 'true' }, h('i', { class: 'b' }), h('i', { class: 'a' }));
    return group('colors', h('div', { class: 'pt-g-body' }, h('div', { class: 'pt-cur-stack' }, refs.c1, refs.c2), refs.palBtn, refs.palStore), refs.miniCur);
  }

  function renderCustom() {
    if (!refs.custom) return;
    refs.custom.replaceChildren(...S.custom.map((c, i) => swatch(c, t('colors.custom'), { custom: true, index: i })));
    refs.palWrap?._sync?.();
  }

  function buildCmdbar() {
    // Clipboard actions are in the "…" menu (and on Ctrl+X / C / V).
    const image = buildImage();
    // The tool island: selection, the tools, brushes, then the shapes popover.
    const tools = buildTools();
    const brushes = buildBrushes();
    const shapes = buildShapes();
    refs.toolbox = h(
      'div',
      { class: 'pt-toolbox pt-island', role: 'toolbar', 'aria-orientation': 'vertical', 'aria-label': t('groups.tools') },
      h('div', { class: 'pt-tb-select' }, refs.select),
      tools,
      brushes,
      h('div', { class: 'pt-box-sep', 'aria-hidden': 'true' }),
      shapes,
    );
    // Options bar along the top.
    // Options bar along the top: the active tool's options, then the Image menu at the end.
    const bar = h('div', { class: 'pt-cmdbar', role: 'toolbar', 'aria-label': t('cmdbar') }, refs.shapeOpts, buildSize(), buildColors(), h('div', { class: 'pt-bar-grow' }), image);
    refs.bar = bar;
    return bar;
  }

  function fitBar() {
    const bar = refs.bar;
    if (!bar || !bar.isConnected) return;
    if (flyoutState?.el.classList.contains('pt-fly-group')) closeFlyout();
    for (const id of COLLAPSE_ORDER) groups[id].el.classList.remove('compact');
    for (const id of COLLAPSE_ORDER) {
      if (bar.scrollWidth <= bar.clientWidth + 1) break;
      groups[id].el.classList.add('compact');
    }
  }

  // ------------------------------------------------------------ context bar (text / fill options)
  function buildCtxbar() {
    const fonts = app.fonts();
    refs.fontSel = h(
      'select',
      { class: 'select pt-font', 'aria-label': t('text.font'), onchange: (e) => app.setTextOpt('family', e.target.value) },
      fonts.map((f) => h('option', { value: f, style: { fontFamily: `"${f}"` } }, f)),
    );
    const sizes = [8, 9, 10, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 36, 48, 72];
    refs.fontSize = h('input', {
      class: 'input pt-fsize',
      type: 'number',
      min: 1,
      max: 400,
      list: `pt-sizes-${app.win.id}`,
      'aria-label': t('text.size'),
      'data-tip': t('text.size'),
      onchange: (e) => app.setTextOpt('sizePt', Math.max(1, Math.min(400, Number(e.target.value) || 12))),
    });
    const dl = h('datalist', { id: `pt-sizes-${app.win.id}` }, sizes.map((s) => h('option', { value: s })));
    const tog = (key, ic, label, k) => {
      const b = btn({ ic, label, key: k, cls: 'sm pt-toggle', onclick: () => app.setTextOpt(key, !S.text[key]), attrs: { 'aria-pressed': 'false', dataset: { opt: key } } });
      refs[`t_${key}`] = b;
      return b;
    };
    refs.bgSeg = ui.segmented({
      options: [
        { value: 'transparent', label: t('text.transparent') },
        { value: 'opaque', label: t('text.opaque') },
      ],
      value: S.text.opaque ? 'opaque' : 'transparent',
      onchange: (v) => app.setTextOpt('opaque', v === 'opaque'),
    });
    refs.textOpts = h(
      'div',
      { class: 'pt-ctx-row', dataset: { for: 'text' } },
      icon('text_font', { size: 16 }),
      refs.fontSel,
      refs.fontSize,
      dl,
      h('div', { class: 'vsep' }),
      tog('bold', 'text_bold', t('text.bold'), 'Ctrl+B'),
      tog('italic', 'text_italic', t('text.italic'), 'Ctrl+I'),
      tog('underline', 'text_underline', t('text.underline'), 'Ctrl+U'),
      tog('strike', 'text_strikethrough', t('text.strike')),
      h('div', { class: 'vsep' }),
      h('span', { class: 'caption text-2 pt-ctx-cap' }, t('text.background')),
      refs.bgSeg,
    );
    refs.tolVal = h('span', { class: 'pt-tol-val' });
    refs.tol = ui.slider({
      min: 0,
      max: 100,
      value: S.tolerance,
      oninput: (v) => {
        refs.tolVal.textContent = `${v}%`;
        app.setTolerance(v);
      },
    });
    refs.tol.classList.add('pt-tol');
    refs.tol.setAttribute('aria-label', t('fillopts.tolerance'));
    refs.fillOpts = h(
      'div',
      { class: 'pt-ctx-row', dataset: { for: 'fill' } },
      icon('paint_bucket', { size: 16 }),
      h('span', null, t('fillopts.tolerance')),
      refs.tol,
      refs.tolVal,
      h('span', { class: 'caption text-2 pt-ctx-hint' }, t('fillopts.hint')),
    );
    refs.ctx = h('div', { class: 'pt-ctxbar', hidden: true }, refs.textOpts, refs.fillOpts);
    return refs.ctx;
  }

  function refreshFonts() {
    if (!refs.fontSel) return;
    const fonts = app.fonts();
    refs.fontSel.replaceChildren(...fonts.map((f) => h('option', { value: f, style: { fontFamily: `"${f}"` } }, f)));
    refs.fontSel.value = S.text.family;
  }

  // ------------------------------------------------------------ zoom pill
  // A small floating pill at the bottom right of the canvas area: − , the zoom level (opens the
  // presets and the slider), +, fit. The canvas size, pointer position and selection size show
  // as a discreet caption above it while the pointer is over the canvas area.
  function zoomFlyout(anchor) {
    const presets = h(
      'div',
      { class: 'pt-zoom-presets', role: 'group', 'aria-label': t('view.zoomLevel') },
      [8, 6, 4, 3, 2, 1, 0.5, 0.25, 0.125].map((z) => {
        const on = Math.abs(app.zoom() - z) < 1e-6;
        return h('button', { type: 'button', class: ['pt-zoom-preset', on && 'on'], 'aria-pressed': String(on), onclick: () => (app.setZoom(z), closeFlyout()) }, pct(z));
      }),
    );
    const fit = h('button', { type: 'button', class: 'pt-zoom-preset pt-zoom-fitp', onclick: () => (app.cmd('zoomFit'), closeFlyout()) }, icon('zoom_fit', { size: 16 }), h('span', null, t('view.fit')));
    refs.zoomSlider.setValue(zoomToSlider(app.zoom()));
    flyout(anchor, h('div', { class: 'pt-zoom-fly' }, refs.zoomSlider, presets, fit), { className: 'pt-fly-zoom' });
  }
  function buildStatus() {
    const item = (ic, cls) => {
      const txt = h('span', { class: 'pt-st-txt' });
      const el = h('div', { class: ['pt-st-item', cls] }, icon(ic, { size: 14 }), txt);
      el.txt = txt;
      return el;
    };
    refs.stPos = item('cursor', 'pos');
    refs.stSel = item('select_object', 'sel');
    refs.stSize = item('resize_image', 'size');
    refs.zoomBtn = h(
      'button',
      {
        type: 'button',
        class: 'pt-zoom-pct',
        'data-tip': t('view.zoomLevel'),
        'aria-haspopup': 'dialog',
        onclick: (e) => zoomFlyout(e.currentTarget),
      },
      h('span', { class: 'pt-zoom-txt' }),
    );
    refs.zoomSlider = ui.slider({
      min: 0,
      max: 1000,
      value: 500,
      oninput: (v) => app.setZoom(sliderToZoom(v)),
    });
    refs.zoomSlider.classList.add('pt-zoom-slider');
    refs.zoomSlider.setAttribute('aria-label', t('view.zoomLevel'));
    const zo = btn({ ic: 'minus', label: t('view.zoomOut'), key: 'Ctrl+-', cls: 'xs', size: 14, onclick: () => app.cmd('zoomOut') });
    const zi = btn({ ic: 'plus', label: t('view.zoomIn'), key: 'Ctrl++', cls: 'xs', size: 14, onclick: () => app.cmd('zoomIn') });
    const fit = btn({ ic: 'corners-out', label: t('view.fit'), key: 'Ctrl+0', cls: 'xs', size: 14, onclick: () => app.cmd('zoomFit') });
    refs.stCap = h('div', { class: 'pt-st-cap', 'aria-live': 'off' }, refs.stSize, refs.stPos, refs.stSel);
    refs.status = h('div', { class: 'pt-status pt-zoompill-wrap' }, refs.stCap, h('div', { class: 'pt-zoom', role: 'group', 'aria-label': t('view.zoomLevel') }, zo, refs.zoomBtn, zi, fit));
    return refs.status;
  }

  const LMIN = Math.log(0.125);
  const LMAX = Math.log(8);
  function sliderToZoom(v) {
    let z = Math.exp(LMIN + (v / 1000) * (LMAX - LMIN));
    if (Math.abs(z - 1) < 0.04) z = 1;
    return Math.round(z * 1000) / 1000;
  }
  const zoomToSlider = (z) => Math.round(((Math.log(Math.max(0.125, Math.min(8, z))) - LMIN) / (LMAX - LMIN)) * 1000);

  // Drop the least useful status items until everything fits (French labels are longer).
  const STATUS_STEPS = ['narrow', 'xnarrow', 'xxnarrow'];
  function fitStatus() {
    const st = refs.status;
    if (!st?.isConnected || st.hidden) return;
    st.classList.remove(...STATUS_STEPS);
    for (const c of STATUS_STEPS) {
      if (st.scrollWidth <= st.clientWidth + 1) break;
      st.classList.add(c);
    }
  }

  // Context bar (text / fill options): tighten, then hide captions, when the window is narrow.
  const CTX_STEPS = ['narrow', 'xnarrow'];
  function fitCtx() {
    const bar = refs.ctx;
    if (!bar?.isConnected || bar.hidden) return;
    bar.classList.remove(...CTX_STEPS);
    for (const c of CTX_STEPS) {
      if (bar.scrollWidth <= bar.clientWidth + 1) break;
      bar.classList.add(c);
    }
  }

  // The centred document title is hidden rather than cut down to a couple of letters.
  function fitTitle() {
    const el = refs.title;
    if (!el?.isConnected) return;
    el.classList.remove('tiny');
    if (el.clientWidth < 72) el.classList.add('tiny');
  }

  // ------------------------------------------------------------ public API
  const api = {
    titlebar: null,
    toolbox: null,
    cmdbar: null,
    ctxbar: null,
    status: null,
    build() {
      api.titlebar = buildTitlebar();
      api.cmdbar = buildCmdbar();
      api.toolbox = refs.toolbox;
      api.ctxbar = buildCtxbar();
      api.status = buildStatus();
      return api;
    },
    closeFlyout,
    flyout,
    openMenu: (id) => openMenu(id),
    fit() {
      fitBar();
      fitStatus();
      fitCtx();
      fitTitle();
    },
    setTitle(text) {
      if (refs.title) refs.title.textContent = text;
    },
    refreshFonts,
    renderCustom,
    setStatus({ pos, sel, size, file } = {}) {
      if (pos !== undefined) {
        refs.stPos.txt.textContent = pos ?? '';
        refs.stPos.classList.toggle('pt-empty', !pos);
      }
      if (sel !== undefined) {
        refs.stSel.txt.textContent = sel ?? '';
        refs.stSel.classList.toggle('pt-empty', !sel);
      }
      if (size !== undefined) refs.stSize.txt.textContent = size;
      // The file size is no longer shown in the window; it stays in the title's tooltip.
      if (file !== undefined) {
        refs.fileSize = file ?? '';
        if (refs.title) {
          if (file) refs.title.dataset.tip = file;
          else delete refs.title.dataset.tip;
        }
      }
    },
    setZoom(z) {
      refs.zoomBtn.querySelector('.pt-zoom-txt').textContent = pct(z);
      refs.zoomSlider.setValue(zoomToSlider(z));
      refs.zoomBtn.setAttribute('aria-label', `${t('view.zoomLevel')} ${pct(z)}`);
    },
    fileSize: () => refs.fileSize || '',
    update() {
      const c = (k) => app.can(k);
      for (const [id, b] of Object.entries(refs.tools || {})) {
        const on = S.tool === id;
        b.classList.toggle('on', on);
        b.setAttribute('aria-checked', String(on));
      }
      refs.selectMain.classList.toggle('on', S.tool === 'select');
      if (refs.selectMain.dataset.mode !== S.selMode) {
        refs.selectMain.dataset.mode = S.selMode;
        refs.selectMain.replaceChildren(icon(S.selMode === 'free' ? 'lasso' : 'select_object', { size: 20 }));
      }
      refs.brushes.classList.toggle('on', S.tool === 'brush');
      refs.shapesBtn.classList.toggle('on', S.tool === 'shape');
      // The options bar shows the active tool's options: outline and fill only for shapes.
      const noShapeOpts = S.tool !== 'shape';
      if ((refs.shapeOpts.style.display === 'none') !== noShapeOpts) {
        refs.shapeOpts.style.display = noShapeOpts ? 'none' : '';
        if (refs.bar?.isConnected) requestAnimationFrame(fitBar);
      }
      if (refs.shapesBtn.dataset.shape !== S.shape) {
        refs.shapesBtn.dataset.shape = S.shape;
        refs.shapesBtn.firstChild.replaceWith(svgIcon(shapeIcon(S.shape || 'rect'), { size: 20 }));
      }
      for (const [id, b] of Object.entries(refs.shapes || {})) {
        const on = S.tool === 'shape' && S.shape === id;
        b.classList.toggle('on', on);
        b.setAttribute('aria-checked', String(on));
      }
      refs.toolsGrid?._sync?.();
      refs.gallery?._sync?.();
      if (refs.cut) refs.cut.disabled = !c('cut');
      if (refs.copy) refs.copy.disabled = !c('copy');
      refs.qaUndo.disabled = !c('undo');
      refs.qaRedo.disabled = !c('redo');
      refs.size.disabled = !app.sizeKey();
      // Size is an option of the tools that have one only.
      const noSize = !app.sizeKey();
      if ((groups.size.el.style.display === 'none') !== noSize) {
        groups.size.el.style.display = noSize ? 'none' : '';
        if (refs.bar?.isConnected) requestAnimationFrame(fitBar);
      }
      // current colours
      refs.c1.style.setProperty('--c', S.primary);
      refs.c2.style.setProperty('--c', S.secondary);
      refs.miniCur.style.setProperty('--c1', S.primary);
      refs.miniCur.style.setProperty('--c2', S.secondary);
      refs.c1.classList.toggle('active', S.slot === 'primary');
      refs.c2.classList.toggle('active', S.slot === 'secondary');
      refs.c1.dataset.tip = `${t('colors.c1tip')} — ${S.primary.toUpperCase()}`;
      refs.c2.dataset.tip = `${t('colors.c2tip')} — ${S.secondary.toUpperCase()}`;
      // context bar
      const ctxFor = S.tool === 'text' ? 'text' : S.tool === 'fill' ? 'fill' : null;
      const wasHidden = refs.ctx.hidden;
      refs.ctx.hidden = !ctxFor;
      refs.textOpts.hidden = ctxFor !== 'text';
      refs.fillOpts.hidden = ctxFor !== 'fill';
      if (ctxFor && wasHidden) {
        refs.ctx.classList.remove('enter');
        void refs.ctx.offsetWidth;
        refs.ctx.classList.add('enter');
      }
      if (ctxFor && (wasHidden || refs.ctx.dataset.for !== ctxFor)) {
        refs.ctx.dataset.for = ctxFor;
        fitCtx();
      }
      if (ctxFor === 'text') {
        if (refs.fontSel.value !== S.text.family) refs.fontSel.value = S.text.family;
        if (document.activeElement !== refs.fontSize) refs.fontSize.value = S.text.sizePt;
        for (const k of ['bold', 'italic', 'underline', 'strike']) {
          refs[`t_${k}`].classList.toggle('on', !!S.text[k]);
          refs[`t_${k}`].setAttribute('aria-pressed', String(!!S.text[k]));
        }
        refs.bgSeg.setValue(S.text.opaque ? 'opaque' : 'transparent');
      }
      if (ctxFor === 'fill') {
        refs.tol.setValue(S.tolerance);
        refs.tolVal.textContent = `${S.tolerance}%`;
      }
      const stWasHidden = refs.status.hidden;
      refs.status.hidden = S.statusbar === false;
      if (stWasHidden && !refs.status.hidden) fitStatus();
    },
  };
  return api;
}
