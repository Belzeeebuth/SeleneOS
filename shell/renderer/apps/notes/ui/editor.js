// Notes editor pane: command bar, title, contenteditable body, find bar, status bar.
//   Rich text: paragraph / heading 1-3 / quote / code block, bold, italic, underline, strikethrough, inline
//   code, highlight + text colour (theme-aware palette stored as data-hl / data-color), bullet / numbered /
//   check lists (clickable boxes), divider, links (Ctrl+click opens Aurora Browser), tables, pictures
//   (insert / paste / drop -> attachments next to the note), clear formatting, snapshot undo / redo.
//   Markdown while typing: "# " "## " "### " "- " "* " "1. " "[] " "[x] " "> " "```" "---" **b** *i* ~~s~~ `c` ==h==
//   Paste / drop are sanitized (lib/sanitize.js); pictures in pasted HTML are copied into the note.
import { sanitizeFragment, sanitizeHtml, TEXT_COLORS, HIGHLIGHTS, ATTACHMENT_RE, safeLinkUrl } from '../lib/sanitize.js';
import { plainText, countWords, countChars, findRanges, foldText } from '../lib/text.js';
import { History } from './history.js';
import { popover, closePopover, arrowNav } from './popover.js';
import {
  closestBlock, topBlock, closest, editorRange, normalizeRoot, emptyLine, isEmptyBlock, blocksInRange, retag, unwrap,
  applyInline, allInside, wordRange, insertFragment, insertInline, setCaret, caretAtEnd, caretAtStart, saveRefs, restoreRefs,
  mergeSiblings, ZWSP,
} from './dom.js';

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg|avif|ico)$/i;
const BLOCK_STYLES = [
  { tag: 'div', key: 'normal', keys: 'Ctrl+Alt+0' },
  { tag: 'h1', key: 'h1', keys: 'Ctrl+Alt+1' },
  { tag: 'h2', key: 'h2', keys: 'Ctrl+Alt+2' },
  { tag: 'h3', key: 'h3', keys: 'Ctrl+Alt+3' },
  { tag: 'blockquote', key: 'quote', keys: 'Ctrl+Shift+.' },
  { tag: 'pre', key: 'codeBlock', keys: 'Ctrl+Alt+C' },
];
const hasHighlights = typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight !== 'undefined';

export class Editor {
  constructor(app) {
    this.app = app;
    this.ctx = app.ctx;
    this.t = app.t;
    this.note = null;
    this.readOnly = false;
    this.lastHl = 'yellow';
    this.lastColor = 'red';
    this.find = { open: false, ranges: [], index: -1 };
    this.searchTerms = [];
    this.internalDrag = false;
    this.build();
  }

  // ------------------------------------------------------------------ DOM
  build() {
    const { h, icon } = this.ctx;
    const t = this.t;
    const btn = (cmd, ic, label, keys, extra = {}) =>
      h(
        'button',
        {
          type: 'button',
          class: ['btn subtle icon-btn nt-cmd', extra.class],
          dataset: { cmd },
          tabindex: '-1',
          'aria-label': label,
          'data-tip': keys ? `${label} (${keys})` : label,
          'data-tip-pos': 'below',
          'aria-pressed': extra.toggle ? 'false' : null,
          onmousedown: (e) => e.preventDefault(), // keep the editor selection
          onclick: (e) => this.command(cmd, e),
        },
        icon(ic, { size: 16 }),
      );
    const group = (name, ...kids) => h('div', { class: 'nt-group', dataset: { g: name } }, ...kids, h('div', { class: 'nt-group-sep', 'aria-hidden': 'true' }));

    this.styleLabel = h('span', { class: 'nt-style-label ellipsis' }, t('ed.style.normal'));
    this.styleBtn = h(
      'button',
      {
        type: 'button',
        class: 'btn subtle nt-cmd nt-style-btn',
        dataset: { cmd: 'style' },
        tabindex: '-1',
        'aria-haspopup': 'menu',
        'aria-label': t('ed.textStyle'),
        'data-tip': t('ed.textStyle'),
        'data-tip-pos': 'below',
        onmousedown: (e) => e.preventDefault(),
        onclick: (e) => this.command('style', e),
      },
      this.styleLabel,
      icon('chevron_down', { size: 12 }),
    );
    const split = (cmd, ic, label, kind) => {
      const bar = h('span', { class: 'nt-colorbar', dataset: { kind } });
      return h(
        'div',
        { class: 'nt-split', dataset: { cmd } },
        h(
          'button',
          {
            type: 'button',
            class: 'btn subtle nt-cmd nt-split-main',
            dataset: { cmd: `${cmd}Apply` },
            tabindex: '-1',
            'aria-label': label,
            'data-tip': label,
            'data-tip-pos': 'below',
            onmousedown: (e) => e.preventDefault(),
            onclick: (e) => this.command(`${cmd}Apply`, e),
          },
          h('span', { class: 'nt-split-icon' }, icon(ic, { size: 16 }), bar),
        ),
        h(
          'button',
          {
            type: 'button',
            class: 'btn subtle nt-cmd nt-split-arrow',
            dataset: { cmd: `${cmd}Menu` },
            tabindex: '-1',
            'aria-haspopup': 'dialog',
            'aria-label': t('ed.moreColors', { what: label }),
            'data-tip': t('ed.moreColors', { what: label }),
            'data-tip-pos': 'below',
            onmousedown: (e) => e.preventDefault(),
            onclick: (e) => this.command(`${cmd}Menu`, e),
          },
          icon('chevron_down', { size: 12 }),
        ),
      );
    };
    this.groups = [
      group('history', btn('undo', 'arrow_undo', t('ed.undo'), 'Ctrl+Z'), btn('redo', 'arrow_redo', t('ed.redo'), 'Ctrl+Y')),
      group('style', this.styleBtn),
      group(
        'format',
        btn('bold', 'text_bold', t('ed.bold'), 'Ctrl+B', { toggle: true }),
        btn('italic', 'text_italic', t('ed.italic'), 'Ctrl+I', { toggle: true }),
        btn('underline', 'text_underline', t('ed.underline'), 'Ctrl+U', { toggle: true }),
        btn('strike', 'text_strikethrough', t('ed.strike'), 'Ctrl+Shift+X', { toggle: true }),
        btn('code', 'code', t('ed.inlineCode'), 'Ctrl+Shift+K', { toggle: true }),
      ),
      group('color', split('hl', 'highlight', t('ed.highlight'), 'hl'), split('color', 'text_color', t('ed.textColor'), 'color')),
      group(
        'lists',
        btn('ul', 'text_bullet_list_ltr', t('ed.bullets'), 'Ctrl+Shift+8', { toggle: true }),
        btn('ol', 'text_number_list_ltr', t('ed.numbers'), 'Ctrl+Shift+7', { toggle: true }),
        btn('check', 'task_list_ltr', t('ed.checklist'), 'Ctrl+Shift+C', { toggle: true }),
      ),
      group(
        'blocks',
        btn('quote', 'text_quote', t('ed.quote'), 'Ctrl+Shift+.', { toggle: true }),
        btn('pre', 'code_block', t('ed.codeBlock'), 'Ctrl+Alt+C', { toggle: true }),
        btn('hr', 'line_horizontal_1', t('ed.divider')),
      ),
      group('insert', btn('link', 'link', t('ed.link'), 'Ctrl+K', { toggle: true }), btn('table', 'table', t('ed.table')), btn('image', 'image_add', t('ed.image'))),
      group('clear', btn('clear', 'text_clear_formatting', t('ed.clear'), 'Ctrl+Space')),
    ];
    this.groupsEl = h('div', { class: 'nt-groups' }, this.groups);
    this.overflowBtn = h(
      'button',
      {
        type: 'button',
        class: 'btn subtle icon-btn nt-cmd nt-overflow',
        tabindex: '-1',
        hidden: true,
        'aria-label': t('ed.moreFormatting'),
        'data-tip': t('ed.moreFormatting'),
        'data-tip-pos': 'below',
        onmousedown: (e) => e.preventDefault(),
        onclick: (e) => this.overflowMenu(e),
      },
      icon('more_horizontal', { size: 16 }),
    );
    // note actions (always visible)
    this.backBtn = h('button', { type: 'button', class: 'btn subtle icon-btn nt-cmd nt-back', tabindex: '-1', 'aria-label': t('back'), 'data-tip': t('back'), 'data-tip-pos': 'below', onclick: () => this.app.showList() }, icon('arrow_left', { size: 16 }));
    this.findBtn = btn('find', 'search', t('ed.find'), 'Ctrl+F');
    this.pinBtn = btn('pin', 'pin', t('pin'), 'Ctrl+P', { toggle: true });
    this.moreBtn = h(
      'button',
      {
        type: 'button',
        class: 'btn subtle icon-btn nt-cmd',
        tabindex: '-1',
        'aria-haspopup': 'menu',
        'aria-label': t('noteActions'),
        'data-tip': t('noteActions'),
        'data-tip-pos': 'below',
        onclick: (e) => this.app.noteMenu(this.note, e.currentTarget),
      },
      icon('more_horizontal', { size: 16 }),
    );
    this.cmdbar = h(
      'div',
      { class: 'nt-cmdbar', role: 'toolbar', 'aria-label': t('ed.toolbar') },
      this.backBtn,
      this.groupsEl,
      this.overflowBtn,
      h('div', { class: 'nt-cmd-right' }, this.findBtn, this.pinBtn, this.moreBtn),
    );
    this.cmdbar.addEventListener('keydown', (e) => this.toolbarKeys(e));

    // find bar
    this.findInput = h('input', {
      class: 'nt-find-input',
      type: 'search',
      spellcheck: false,
      placeholder: t('ed.findPlaceholder'),
      'aria-label': t('ed.find'),
      oninput: () => this.runFind(),
      onkeydown: (e) => {
        if (e.key === 'Enter' || e.key === 'F3') {
          e.preventDefault();
          this.findStep(e.shiftKey ? -1 : 1);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          this.closeFind();
        }
      },
    });
    this.findCount = h('span', { class: 'nt-find-count caption', 'aria-live': 'polite' });
    this.findBar = h(
      'div',
      { class: 'nt-find', hidden: true, role: 'search' },
      icon('search', { size: 16 }),
      this.findInput,
      this.findCount,
      h('button', { type: 'button', class: 'btn subtle icon-btn', 'aria-label': t('ed.findPrev'), 'data-tip': `${t('ed.findPrev')} (Shift+Enter)`, onclick: () => this.findStep(-1) }, icon('chevron_up', { size: 16 })),
      h('button', { type: 'button', class: 'btn subtle icon-btn', 'aria-label': t('ed.findNext'), 'data-tip': `${t('ed.findNext')} (Enter)`, onclick: () => this.findStep(1) }, icon('chevron_down', { size: 16 })),
      h('button', { type: 'button', class: 'btn subtle icon-btn', 'aria-label': t('ed.findClose'), 'data-tip': `${t('ed.findClose')} (Esc)`, onclick: () => this.closeFind() }, icon('dismiss', { size: 16 })),
    );

    this.infobar = h('div', { class: 'nt-deleted-bar infobar warning', hidden: true });
    this.metaEl = h('div', { class: 'nt-meta caption' });
    this.title = h('textarea', {
      class: 'nt-title',
      rows: 1,
      maxlength: 500,
      spellcheck: true,
      placeholder: t('ed.titlePlaceholder'),
      'aria-label': t('ed.title'),
      oninput: () => this.onTitleInput(),
      onkeydown: (e) => this.titleKeys(e),
    });
    this.body = h('div', {
      class: 'nt-body selectable',
      contenteditable: 'true',
      role: 'textbox',
      'aria-multiline': 'true',
      'aria-label': t('ed.body'),
      spellcheck: true,
      'data-placeholder': t('ed.bodyPlaceholder'),
    });
    this.page = h('div', { class: 'nt-page' }, this.metaEl, this.title, this.body);
    this.scroller = h('div', { class: 'nt-scroll' }, this.page);
    this.scroller.addEventListener('mousedown', (e) => {
      // clicking the empty area below the text puts the caret at the end
      if (e.target === this.scroller || e.target === this.page) {
        if (this.readOnly || !this.note) return;
        e.preventDefault();
        this.body.focus({ preventScroll: true });
        caretAtEnd(this.body.lastElementChild || this.body);
      }
    });

    this.countEl = h('span', { class: 'nt-count' });
    this.editedEl = h('span', { class: 'nt-edited ellipsis' });
    this.savedEl = h('span', { class: 'nt-saved', role: 'status', 'aria-live': 'polite' });
    this.status = h('div', { class: 'nt-status caption' }, this.countEl, h('span', { class: 'grow' }), this.editedEl, this.savedEl);

    this.emptyEl = h(
      'div',
      { class: 'nt-editor-empty empty' },
      h('img', { src: this.ctx.appUrl('icon.svg'), alt: '', class: 'nt-empty-art' }),
      h('div', { class: 'subtitle' }, t('empty.noNoteTitle')),
      h('div', { class: 'text-2' }, t('empty.noNoteBody')),
      h('button', { type: 'button', class: 'btn primary', onclick: () => this.app.newNote() }, icon('note_add', { size: 16 }), t('newNote')),
    );
    this.el = h('section', { class: 'nt-editor', 'aria-label': t('ed.region') }, this.cmdbar, this.findBar, this.infobar, this.scroller, this.status, this.emptyEl);
    this.el.classList.add('no-note');

    this.hist = new History(this.body, {
      onRestore: () => {
        for (const s of this.body.querySelectorAll('.nt-sel')) s.classList.remove('nt-sel');
        this.ensureStructure();
        this.changed({ record: false });
        this.updateState();
      },
    });
    this.bindBody();
    this.ro = new ResizeObserver(() => this.layoutToolbar());
    this.ro.observe(this.cmdbar);
  }

  destroy() {
    this.ro?.disconnect();
    clearInterval(this.editedTimer);
    clearTimeout(this.countTimer);
    this.clearHighlights();
    closePopover();
  }

  // ------------------------------------------------------------------ toolbar
  toolbarKeys(e) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    const items = [...this.cmdbar.querySelectorAll('button.nt-cmd')].filter((b) => b.offsetParent !== null && !b.disabled);
    const i = items.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    const j = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length;
    items[i].tabIndex = -1;
    items[j].tabIndex = 0;
    items[j].focus();
  }

  /** Hide the lowest-priority groups when the command bar is too narrow; they move to the "…" menu. */
  layoutToolbar() {
    const order = ['clear', 'insert', 'blocks', 'color', 'lists', 'style', 'format', 'history'];
    for (const g of this.groups) g.hidden = false;
    this.overflowBtn.hidden = true;
    const fits = () => this.groupsEl.scrollWidth <= this.groupsEl.clientWidth + 1;
    if (fits()) return this.fixTabStop();
    this.overflowBtn.hidden = false;
    for (const name of order) {
      if (fits()) break;
      const g = this.groups.find((x) => x.dataset.g === name);
      if (name === 'history' || name === 'format') {
        // keep the essentials visible as long as anything fits
        if (this.groups.filter((x) => !x.hidden).length <= 1) break;
      }
      g.hidden = true;
    }
    this.fixTabStop();
  }

  fixTabStop() {
    const items = [...this.cmdbar.querySelectorAll('button.nt-cmd')].filter((b) => b.offsetParent !== null);
    if (!items.some((b) => b.tabIndex === 0)) {
      const first = items.find((b) => !b.disabled) || items[0];
      if (first) first.tabIndex = 0;
    }
    for (const b of items) if (b.tabIndex === 0 && b.disabled) {
      b.tabIndex = -1;
      const f = items.find((x) => !x.disabled);
      if (f) f.tabIndex = 0;
    }
  }

  overflowMenu(e) {
    const t = this.t;
    const hidden = new Set(this.groups.filter((g) => g.hidden).map((g) => g.dataset.g));
    const st = this.state || {};
    const item = (cmd, ic, label, keys, checked) => ({ label, icon: ic, shortcut: keys, checked: checked === undefined ? undefined : !!checked, disabled: this.readOnly, action: () => this.command(cmd) });
    const items = [];
    if (hidden.has('history')) items.push(item('undo', 'arrow_undo', t('ed.undo'), 'Ctrl+Z'), item('redo', 'arrow_redo', t('ed.redo'), 'Ctrl+Y'), '-');
    if (hidden.has('style')) items.push({ label: t('ed.textStyle'), icon: 'text_paragraph', submenu: this.styleItems() }, '-');
    if (hidden.has('format'))
      items.push(
        item('bold', 'text_bold', t('ed.bold'), 'Ctrl+B', st.bold),
        item('italic', 'text_italic', t('ed.italic'), 'Ctrl+I', st.italic),
        item('underline', 'text_underline', t('ed.underline'), 'Ctrl+U', st.underline),
        item('strike', 'text_strikethrough', t('ed.strike'), 'Ctrl+Shift+X', st.strike),
        item('code', 'code', t('ed.inlineCode'), 'Ctrl+Shift+K', st.code),
        '-',
      );
    if (hidden.has('color'))
      items.push(
        { label: t('ed.highlight'), icon: 'highlight', submenu: this.colorItems('hl') },
        { label: t('ed.textColor'), icon: 'text_color', submenu: this.colorItems('color') },
        '-',
      );
    if (hidden.has('lists'))
      items.push(item('ul', 'text_bullet_list_ltr', t('ed.bullets'), 'Ctrl+Shift+8', st.ul), item('ol', 'text_number_list_ltr', t('ed.numbers'), 'Ctrl+Shift+7', st.ol), item('check', 'task_list_ltr', t('ed.checklist'), 'Ctrl+Shift+C', st.check), '-');
    if (hidden.has('blocks')) items.push(item('quote', 'text_quote', t('ed.quote'), 'Ctrl+Shift+.', st.quote), item('pre', 'code_block', t('ed.codeBlock'), 'Ctrl+Alt+C', st.pre), item('hr', 'line_horizontal_1', t('ed.divider')), '-');
    if (hidden.has('insert')) items.push(item('link', 'link', t('ed.link'), 'Ctrl+K'), { label: t('ed.table'), icon: 'table', disabled: this.readOnly, submenu: this.tableItems() }, item('image', 'image_add', t('ed.image')), '-');
    if (hidden.has('clear')) items.push(item('clear', 'text_clear_formatting', t('ed.clear'), 'Ctrl+Space'));
    while (items[items.length - 1] === '-') items.pop();
    this.ctx.ui.menu(e.currentTarget, items);
  }

  styleItems() {
    const cur = this.state?.block || 'div';
    return BLOCK_STYLES.map((s) => ({
      label: this.t(`ed.style.${s.key}`),
      shortcut: s.keys,
      checked: cur === s.tag,
      disabled: this.readOnly,
      action: () => this.run(() => this.setBlock(s.tag)),
    }));
  }

  colorItems(kind) {
    const t = this.t;
    const list = kind === 'hl' ? HIGHLIGHTS : TEXT_COLORS;
    return [
      { label: kind === 'hl' ? t('ed.noHighlight') : t('ed.autoColor'), disabled: this.readOnly, action: () => this.run(() => this.applyColor(kind, null)) },
      ...list.map((c) => ({ label: t(`color.${c}`), disabled: this.readOnly, action: () => this.run(() => this.applyColor(kind, c)) })),
    ];
  }

  tableItems() {
    const t = this.t;
    const inTable = !!this.currentCell();
    const it = (label, ic, fn, needTable = true) => ({ label, icon: ic, disabled: this.readOnly || (needTable && !inTable), action: () => this.run(fn) });
    return [
      it(t('ed.tbl.insert'), 'table_add', () => this.insertTable(), false),
      '-',
      it(t('ed.tbl.rowAbove'), 'table_insert_row', () => this.tableRow(-1)),
      it(t('ed.tbl.rowBelow'), 'table_insert_row', () => this.tableRow(1)),
      it(t('ed.tbl.colLeft'), 'table_insert_column', () => this.tableCol(-1)),
      it(t('ed.tbl.colRight'), 'table_insert_column', () => this.tableCol(1)),
      '-',
      it(t('ed.tbl.deleteRow'), 'table_delete_row', () => this.tableDeleteRow()),
      it(t('ed.tbl.deleteCol'), 'table_delete_column', () => this.tableDeleteCol()),
      it(t('ed.tbl.delete'), 'table_dismiss', () => this.tableDelete()),
    ];
  }

  // ------------------------------------------------------------------ commands
  focusBody() {
    if (document.activeElement !== this.body) {
      this.body.focus({ preventScroll: true });
      if (this.savedRange && this.body.contains(this.savedRange.startContainer)) {
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(this.savedRange);
      } else if (!editorRange(this.body)) caretAtEnd(this.body.lastElementChild || this.body);
    }
  }

  /** Run an edit: snapshot before and after, then save. */
  run(fn) {
    if (this.readOnly || !this.note) return;
    this.focusBody();
    this.hist.record();
    this._formatting = true;
    try {
      fn();
    } catch (err) {
      console.error('[notes] command failed', err);
    } finally {
      this._formatting = false;
    }
    this.ensureStructure();
    this.hist.record();
    this.changed({ record: false });
    this.updateState();
  }

  command(cmd, e) {
    if (!this.note) return;
    const always = { find: () => this.openFind(), pin: () => this.app.togglePin(this.note.id), undo: () => this.undo(), redo: () => this.redo() };
    if (always[cmd]) return always[cmd]();
    if (this.readOnly) return;
    const ex = (name, arg) => () => document.execCommand(name, false, arg);
    switch (cmd) {
      case 'bold':
        return this.run(ex('bold'));
      case 'italic':
        return this.run(ex('italic'));
      case 'underline':
        return this.run(ex('underline'));
      case 'strike':
        return this.run(ex('strikeThrough'));
      case 'code':
        return this.run(() => this.toggleInlineCode());
      case 'style':
        this.focusBody();
        return this.ctx.ui.menu(e?.currentTarget || this.styleBtn, this.styleItems());
      case 'hlApply':
        return this.run(() => this.applyColor('hl', this.lastHl));
      case 'colorApply':
        return this.run(() => this.applyColor('color', this.lastColor));
      case 'hlMenu':
        return this.colorPopover('hl', e?.currentTarget);
      case 'colorMenu':
        return this.colorPopover('color', e?.currentTarget);
      case 'ul':
        return this.run(() => this.toggleList('ul'));
      case 'ol':
        return this.run(() => this.toggleList('ol'));
      case 'check':
        return this.run(() => this.toggleList('check'));
      case 'quote':
        return this.run(() => this.setBlock('blockquote', { toggle: true }));
      case 'pre':
        return this.run(() => this.setBlock('pre', { toggle: true }));
      case 'hr':
        return this.run(() => this.insertRule());
      case 'link':
        return this.editLink();
      case 'table':
        this.focusBody();
        return this.ctx.ui.menu(e?.currentTarget || this.cmdbar, this.tableItems());
      case 'image':
        return this.pickImages();
      case 'clear':
        return this.run(() => this.clearFormatting());
      default:
        return undefined;
    }
  }

  undo() {
    if (this.readOnly || !this.note) return;
    if (this.hist.undo()) this.app.toastClear?.();
  }
  redo() {
    if (this.readOnly || !this.note) return;
    this.hist.redo();
  }

  // ---- blocks
  setBlock(tag, { toggle = false } = {}) {
    let range = editorRange(this.body);
    if (!range) return;
    let blocks = blocksInRange(this.body, range);
    if (toggle && blocks.length && blocks.every((b) => b.tagName === tag.toUpperCase())) tag = 'div';
    // list items leave their list first
    const li = blocks.find((b) => b.tagName === 'LI');
    if (li) {
      document.execCommand(li.parentElement?.tagName === 'OL' ? 'insertOrderedList' : 'insertUnorderedList');
      normalizeRoot(this.body);
      range = editorRange(this.body);
      if (!range) return;
      blocks = blocksInRange(this.body, range);
    }
    blocks = blocks.filter((b) => !['LI', 'TD', 'TH'].includes(b.tagName));
    if (!blocks.length) return;
    const T = tag.toUpperCase();
    if (T === 'PRE') {
      // all selected lines become one code block (plain text)
      const lines = [];
      for (const b of blocks) {
        if (b.tagName === 'PRE') lines.push(b.textContent.replace(/\n$/, ''));
        else lines.push(blockLines(b).join('\n'));
      }
      const pre = document.createElement('pre');
      pre.textContent = lines.join('\n');
      if (!pre.textContent) pre.appendChild(document.createElement('br'));
      blocks[0].replaceWith(pre);
      for (const b of blocks.slice(1)) b.remove();
      if (!pre.nextSibling) pre.after(emptyLine());
      const r = document.createRange();
      r.selectNodeContents(pre);
      r.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
      return;
    }
    const refs = saveRefs(this.body);
    let last = null;
    for (const b of blocks) {
      if (b.tagName === 'PRE') {
        // leaving a code block: one line per line
        const lines = b.textContent.replace(/\n$/, '').split('\n');
        const made = lines.map((l) => {
          const d = document.createElement(tag);
          if (l) d.textContent = l;
          else d.appendChild(document.createElement('br'));
          return d;
        });
        b.replaceWith(...made);
        last = made[made.length - 1];
        continue;
      }
      last = retag(b, tag);
    }
    if (blocks.some((b) => b.tagName === 'PRE')) {
      if (last) caretAtEnd(last);
    } else restoreRefs(this.body, refs);
  }

  toggleList(kind) {
    const range = editorRange(this.body);
    if (!range) return;
    const li = closest(range.startContainer, 'li', this.body);
    const list = li?.parentElement;
    const isCheck = list?.tagName === 'UL' && list.dataset.type === 'checklist';
    if (kind === 'check') {
      if (isCheck) document.execCommand('insertUnorderedList');
      else if (list?.tagName === 'UL') setChecklist(list, true);
      else {
        document.execCommand('insertUnorderedList');
        const r = editorRange(this.body);
        const ul = r && closest(r.startContainer, 'ul', this.body);
        if (ul) setChecklist(ul, true);
      }
    } else if (kind === 'ul') {
      if (isCheck) setChecklist(list, false);
      else document.execCommand('insertUnorderedList');
    } else {
      document.execCommand('insertOrderedList');
    }
    normalizeRoot(this.body);
    // Chromium can leave a stray data-checked on items moved out of a checklist
    for (const x of this.body.querySelectorAll('li[data-checked]')) if (x.parentElement?.dataset.type !== 'checklist') x.removeAttribute('data-checked');
  }

  insertRule() {
    const range = editorRange(this.body);
    if (!range) return;
    const top = topBlock(range.startContainer, this.body) || this.body.lastElementChild;
    const hr = document.createElement('hr');
    const line = emptyLine();
    if (top && isEmptyBlock(top) && top.tagName !== 'UL' && top.tagName !== 'OL' && top.tagName !== 'TABLE') {
      top.replaceWith(hr);
    } else if (top) top.after(hr);
    else this.body.appendChild(hr);
    if (hr.nextElementSibling && isEmptyBlock(hr.nextElementSibling)) caretAtStart(hr.nextElementSibling);
    else {
      hr.after(line);
      caretAtStart(line);
    }
  }

  clearFormatting() {
    let range = editorRange(this.body);
    if (!range) return;
    if (range.collapsed) {
      // no selection: the whole current line
      const b = closestBlock(range.startContainer, this.body);
      if (!b) return;
      range = document.createRange();
      range.selectNodeContents(b);
    }
    const blocks = blocksInRange(this.body, range);
    applyInline(this.body, range, { match: (el) => ['B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'DEL', 'MARK', 'CODE', 'SPAN', 'FONT', 'SUB', 'SUP'].includes(el.tagName), make: () => null });
    for (const b of blocks) if (['H1', 'H2', 'H3', 'BLOCKQUOTE'].includes(b.tagName)) retag(b, 'div');
  }

  toggleInlineCode() {
    let range = editorRange(this.body);
    if (!range) return;
    const isCode = (el) => el.tagName === 'CODE';
    if (range.collapsed) {
      const c = closest(range.startContainer, 'code', this.body);
      if (c) {
        unwrap(c);
        return;
      }
      const w = wordRange(range);
      if (!w) {
        const code = document.createElement('code');
        code.textContent = ZWSP;
        insertInline(this.body, range, [code]);
        setCaret(code.firstChild, 1);
        return;
      }
      range = w;
    }
    const inside = allInside(this.body, range, isCode);
    applyInline(this.body, range, { match: isCode, make: () => (inside ? null : document.createElement('code')) });
  }

  applyColor(kind, value) {
    let range = editorRange(this.body);
    if (!range) return;
    if (kind === 'hl' && value) this.lastHl = value;
    if (kind === 'color' && value) this.lastColor = value;
    this.paintColorBars();
    const match = kind === 'hl' ? (el) => el.tagName === 'MARK' : (el) => el.tagName === 'SPAN' && el.hasAttribute('data-color');
    const make = () => {
      if (!value) return null;
      const el = document.createElement(kind === 'hl' ? 'mark' : 'span');
      el.setAttribute(kind === 'hl' ? 'data-hl' : 'data-color', value);
      return el;
    };
    const update = (el) => el.setAttribute(kind === 'hl' ? 'data-hl' : 'data-color', value);
    if (range.collapsed) {
      const w = wordRange(range);
      if (w) range = w;
      else {
        if (!value) return;
        const el = make();
        el.textContent = ZWSP;
        insertInline(this.body, range, [el]);
        setCaret(el.firstChild, 1);
        return;
      }
    }
    applyInline(this.body, range, { match, make, update });
  }

  paintColorBars() {
    for (const bar of this.cmdbar.querySelectorAll('.nt-colorbar')) bar.dataset.value = bar.dataset.kind === 'hl' ? this.lastHl : this.lastColor;
  }

  colorPopover(kind, anchor) {
    if (this.readOnly) return;
    const { h } = this.ctx;
    const t = this.t;
    const list = kind === 'hl' ? HIGHLIGHTS : TEXT_COLORS;
    const cur = kind === 'hl' ? this.lastHl : this.lastColor;
    const pick = (v) => {
      pop.close();
      this.run(() => this.applyColor(kind, v));
    };
    const grid = h(
      'div',
      { class: 'nt-swatches', role: 'group', 'aria-label': kind === 'hl' ? t('ed.highlight') : t('ed.textColor') },
      list.map((c) =>
        h(
          'button',
          {
            type: 'button',
            class: ['nt-swatch', c === cur && 'current'],
            dataset: { [kind === 'hl' ? 'hl' : 'color']: c },
            'aria-label': t(`color.${c}`),
            'data-tip': t(`color.${c}`),
            onmousedown: (e) => e.preventDefault(),
            onclick: () => pick(c),
          },
          h('span', { class: 'nt-swatch-chip' }, kind === 'color' ? 'A' : ''),
        ),
      ),
    );
    arrowNav(grid, 'button', { columns: 3 });
    const none = h(
      'button',
      { type: 'button', class: 'btn subtle nt-swatch-none', onmousedown: (e) => e.preventDefault(), onclick: () => pick(null) },
      this.ctx.icon(kind === 'hl' ? 'highlight' : 'text_color', { size: 16 }),
      kind === 'hl' ? t('ed.noHighlight') : t('ed.autoColor'),
    );
    const pop = popover(this.ctx.win, anchor?.closest('.nt-split') || anchor, h('div', { class: 'nt-color-pop' }, grid, none), {
      label: kind === 'hl' ? t('ed.highlight') : t('ed.textColor'),
      onClose: () => {},
    });
    grid.querySelector('.current')?.focus();
  }

  // ---- links
  currentLink() {
    const r = editorRange(this.body);
    return r ? closest(r.startContainer, 'a', this.body) || (r.collapsed ? null : closest(r.endContainer, 'a', this.body)) : null;
  }

  async editLink(existing) {
    if (this.readOnly || !this.note) return;
    this.focusBody();
    const { h, ui } = this.ctx;
    const t = this.t;
    const range = editorRange(this.body)?.cloneRange();
    const a = existing || this.currentLink();
    const selText = a ? a.textContent : range && !range.collapsed ? range.toString() : '';
    const textIn = h('input', { class: 'input', value: selText.replace(new RegExp(ZWSP, 'g'), ''), placeholder: t('ed.linkTextPlaceholder') });
    const urlIn = h('input', { class: 'input', value: a?.getAttribute('href') || '', placeholder: 'https://', spellcheck: false, type: 'url' });
    const err = h('div', { class: 'field-hint nt-field-error', role: 'alert' });
    const body = h(
      'div',
      { class: 'nt-link-dialog' },
      h('div', { class: 'field' }, h('label', null, t('ed.linkText')), textIn),
      h('div', { class: 'field' }, h('label', null, t('ed.linkUrl')), urlIn, err),
    );
    const buttons = [{ label: t('common.ok'), value: 'ok', primary: true }];
    if (a) buttons.push({ label: t('ed.removeLink'), value: 'remove' });
    buttons.push({ label: t('common.cancel'), value: null });
    const res = await ui.dialog({
      title: a ? t('ed.editLink') : t('ed.insertLink'),
      body,
      parent: this.ctx.win,
      buttons,
      onOpen: (dlg) => {
        dlg._validate = (v) => {
          if (v !== 'ok') return true;
          if (!safeLinkUrl(urlIn.value)) {
            err.textContent = t('ed.badUrl');
            urlIn.classList.add('invalid');
            urlIn.focus();
            return false;
          }
          return true;
        };
        setTimeout(() => (a || selText ? urlIn : urlIn).focus(), 40);
      },
    });
    if (!res) {
      this.restoreRange(range);
      return;
    }
    this.restoreRange(range);
    if (res === 'remove') return this.run(() => a && unwrap(a));
    const href = safeLinkUrl(urlIn.value);
    const text = textIn.value.trim() || href;
    this.run(() => {
      if (a) {
        a.setAttribute('href', href);
        if (text !== a.textContent) a.textContent = text;
        const r = document.createRange();
        r.setStartAfter(a);
        r.collapse(true);
        window.getSelection().removeAllRanges();
        window.getSelection().addRange(r);
        return;
      }
      const r = editorRange(this.body);
      if (!r) return;
      if (!r.collapsed && text === selText) {
        document.execCommand('createLink', false, href);
        return;
      }
      const link = document.createElement('a');
      link.setAttribute('href', href);
      link.textContent = text;
      insertInline(this.body, r, [link, document.createTextNode(' ')]);
    });
  }

  restoreRange(range) {
    if (!range || !this.body.contains(range.startContainer)) return;
    this.body.focus({ preventScroll: true });
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  openLink(a) {
    const href = safeLinkUrl(a?.getAttribute('href'));
    if (!href) return;
    if (/^mailto:/i.test(href)) this.ctx.shell.launch('mail', { mailto: href });
    else if (/^https?:/i.test(href)) this.ctx.shell.openUrl(href);
  }

  linkCard(a) {
    const { h, icon } = this.ctx;
    const t = this.t;
    if (this.linkPop && !this.linkPop.closed && this.linkPop.el._a === a) return;
    const href = a.getAttribute('href') || '';
    const content = h(
      'div',
      { class: 'nt-linkcard' },
      icon('globe', { size: 16 }),
      h('a', { class: 'nt-linkcard-url ellipsis', href: '#', title: href, onclick: (e) => (e.preventDefault(), this.openLink(a)) }, href),
      h('button', { type: 'button', class: 'btn subtle icon-btn', 'aria-label': t('ed.openLink'), 'data-tip': `${t('ed.openLink')} (Ctrl+${t('click')})`, onmousedown: (e) => e.preventDefault(), onclick: () => this.openLink(a) }, icon('open', { size: 16 })),
      h('button', { type: 'button', class: 'btn subtle icon-btn', 'aria-label': t('ed.copyLink'), 'data-tip': t('ed.copyLink'), onmousedown: (e) => e.preventDefault(), onclick: () => this.copyText(href) }, icon('copy', { size: 16 })),
      h('button', { type: 'button', class: 'btn subtle icon-btn', 'aria-label': t('ed.editLink'), 'data-tip': `${t('ed.editLink')} (Ctrl+K)`, onmousedown: (e) => e.preventDefault(), onclick: () => (this.linkPop?.close(), this.editLink(a)) }, icon('edit', { size: 16 })),
      h('button', { type: 'button', class: 'btn subtle icon-btn', 'aria-label': t('ed.removeLink'), 'data-tip': t('ed.removeLink'), onmousedown: (e) => e.preventDefault(), onclick: () => (this.linkPop?.close(), this.run(() => unwrap(a))) }, icon('link_dismiss', { size: 16 })),
    );
    this.linkPop = popover(this.ctx.win, a, content, { className: 'nt-linkpop', focus: false, role: 'toolbar', label: t('ed.link') });
    this.linkPop.el._a = a;
  }

  copyText(text) {
    this.ctx.api.invoke('clipboard:writeText', text).then(
      () => this.app.toast(this.t('copied')),
      () => {},
    );
  }

  // ---- tables
  insertTable(rows = 3, cols = 3) {
    const range = editorRange(this.body);
    if (!range) return;
    const table = document.createElement('table');
    const tbody = document.createElement('tbody');
    for (let r = 0; r < rows; r++) {
      const tr = document.createElement('tr');
      for (let c = 0; c < cols; c++) {
        const cell = document.createElement(r === 0 ? 'th' : 'td');
        cell.appendChild(document.createElement('br'));
        tr.appendChild(cell);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    const top = topBlock(range.startContainer, this.body);
    if (top && isEmptyBlock(top) && !['UL', 'OL', 'TABLE'].includes(top.tagName)) top.replaceWith(table);
    else if (top) top.after(table);
    else this.body.appendChild(table);
    if (!table.nextElementSibling) table.after(emptyLine());
    caretAtStart(table.querySelector('th, td'));
  }

  currentCell() {
    const r = editorRange(this.body);
    return r ? closest(r.startContainer, 'td, th', this.body) : null;
  }

  tableRow(dir) {
    const cell = this.currentCell();
    if (!cell) return;
    const tr = cell.parentElement;
    const n = Math.max(...[...tr.closest('table').rows].map((r) => r.cells.length));
    const row = document.createElement('tr');
    for (let i = 0; i < n; i++) {
      const c = document.createElement('td');
      c.appendChild(document.createElement('br'));
      row.appendChild(c);
    }
    if (dir < 0) tr.before(row);
    else tr.after(row);
    caretAtStart(row.cells[Math.min(cell.cellIndex, row.cells.length - 1)]);
  }

  tableCol(dir) {
    const cell = this.currentCell();
    if (!cell) return;
    const idx = cell.cellIndex;
    for (const tr of cell.closest('table').rows) {
      const ref = tr.cells[Math.min(idx, tr.cells.length - 1)];
      const c = document.createElement(ref?.tagName === 'TH' ? 'th' : 'td');
      c.appendChild(document.createElement('br'));
      if (!ref) tr.appendChild(c);
      else if (dir < 0) ref.before(c);
      else ref.after(c);
    }
    const target = cell.parentElement.cells[dir < 0 ? idx : idx + 1];
    if (target) caretAtStart(target);
  }

  tableDeleteRow() {
    const cell = this.currentCell();
    if (!cell) return;
    const tr = cell.parentElement;
    const table = tr.closest('table');
    if (table.rows.length <= 1) return this.tableDelete();
    const next = tr.nextElementSibling || tr.previousElementSibling;
    tr.remove();
    if (next?.cells?.[0]) caretAtStart(next.cells[Math.min(cell.cellIndex, next.cells.length - 1)]);
  }

  tableDeleteCol() {
    const cell = this.currentCell();
    if (!cell) return;
    const idx = cell.cellIndex;
    const table = cell.closest('table');
    const max = Math.max(...[...table.rows].map((r) => r.cells.length));
    if (max <= 1) return this.tableDelete();
    const row = cell.parentElement;
    for (const tr of [...table.rows]) tr.cells[idx]?.remove();
    const target = row.cells[Math.min(idx, row.cells.length - 1)];
    if (target) caretAtStart(target);
  }

  tableDelete() {
    const cell = this.currentCell();
    const table = cell?.closest('table');
    if (!table) return;
    const line = emptyLine();
    table.replaceWith(line);
    caretAtStart(line);
  }

  // ---- pictures
  async pickImages() {
    if (this.readOnly || !this.note) return;
    const range = editorRange(this.body)?.cloneRange() || this.savedRange;
    const paths = await this.ctx.ui.filePicker({
      mode: 'open',
      multiple: true,
      title: this.t('ed.insertImage'),
      filters: [{ name: this.t('ed.pictures'), ext: ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.avif'] }],
      path: this.ctx.shell.xdg?.pictures,
      parent: this.ctx.win,
    });
    if (!paths) return;
    this.restoreRange(range);
    await this.insertImages((Array.isArray(paths) ? paths : [paths]).map((p) => ({ path: p })));
  }

  /** Insert pictures at the caret: sources are { path } | { bytes, name } | { file }. */
  async insertImages(sources) {
    if (!sources.length || this.readOnly || !this.note) return;
    const noteId = this.note.id;
    this.focusBody();
    const range = editorRange(this.body);
    if (!range) caretAtEnd(this.body.lastElementChild || this.body);
    this.hist.record();
    const imgs = [];
    for (const src of sources) {
      const img = document.createElement('img');
      img.alt = '';
      img.className = 'nt-pending';
      if (src.file) img.src = URL.createObjectURL(src.file);
      else if (src.path) img.src = this.ctx.api.mediaUrl(src.path);
      else if (src.bytes) img.src = URL.createObjectURL(new Blob([src.bytes]));
      imgs.push({ img, src });
    }
    const r = editorRange(this.body);
    if (r) {
      const nodes = [];
      for (const { img } of imgs) nodes.push(img);
      insertInline(this.body, r, nodes);
    }
    this.ensureStructure();
    let failed = 0;
    for (const { img, src } of imgs) {
      try {
        let payload = src.path ? { path: src.path } : null;
        if (src.file) {
          const p = this.ctx.api.pathForFile?.(src.file);
          payload = p ? { path: p } : { bytes: new Uint8Array(await src.file.arrayBuffer()), name: src.file.name };
        } else if (src.bytes) payload = { bytes: src.bytes, name: src.name || 'image' };
        const res = await this.ctx.api.invoke('notes:attach', noteId, payload);
        if (img.src.startsWith('blob:')) URL.revokeObjectURL(img.src);
        if (this.note?.id === noteId && img.isConnected) {
          img.dataset.att = res.name;
          img.src = this.ctx.api.mediaUrl(res.path);
          img.classList.remove('nt-pending');
          if (!img.className) img.removeAttribute('class');
        }
      } catch (err) {
        failed++;
        console.warn('[notes] attach failed', err?.message || err);
        if (img.src.startsWith('blob:')) URL.revokeObjectURL(img.src);
        img.remove();
      }
    }
    this.ensureStructure();
    this.hist.record();
    this.changed({ record: false });
    if (failed) this.app.error(this.t('ed.imageFailed', { count: failed }));
  }

  /** Copy pictures referenced by pasted / imported HTML into the note (data:, media:, http(s):). */
  async localizeImages(imgs) {
    const noteId = this.note?.id;
    if (!noteId) return;
    let changed = false;
    for (const img of imgs) {
      if (img.dataset.att) continue;
      const src = img.getAttribute('src') || '';
      let payload = null;
      if (src.startsWith('data:')) payload = { dataUrl: src };
      else if (src.startsWith('media:')) {
        try {
          payload = { path: decodeURIComponent(new URL(src).pathname) };
        } catch {}
      } else if (/^https?:/i.test(src)) payload = { url: src };
      if (!payload) continue;
      try {
        const res = await this.ctx.api.invoke('notes:attach', noteId, payload);
        if (this.note?.id === noteId && img.isConnected) {
          img.dataset.att = res.name;
          img.src = this.ctx.api.mediaUrl(res.path);
          changed = true;
        }
      } catch (err) {
        // remote pictures that can't be downloaded stay linked; broken local ones are dropped
        if (src.startsWith('media:') && img.isConnected) {
          img.remove();
          changed = true;
        }
        console.warn('[notes] picture not copied', err?.message || err);
      }
    }
    if (changed && this.note?.id === noteId) this.changed({ record: false });
  }

  imageMenu(img, e) {
    const t = this.t;
    const path = this.imagePath(img);
    const size = (w) => () =>
      this.run(() => {
        if (w) img.setAttribute('width', String(w));
        else img.removeAttribute('width');
      });
    const cur = Number(img.getAttribute('width') || 0);
    this.ctx.ui.menu(e, [
      { label: t('ed.img.open'), icon: 'open', disabled: !path, action: () => this.ctx.shell.openFile(path) },
      { label: t('ed.img.saveAs'), icon: 'save', disabled: !path, action: () => this.saveImageAs(img) },
      { label: t('ed.img.copy'), icon: 'copy', disabled: !path, action: () => this.copyImage(img) },
      '-',
      {
        label: t('ed.img.size'),
        icon: 'resize_image',
        disabled: this.readOnly,
        submenu: [
          { label: t('ed.img.small'), checked: cur === 240, action: size(240) },
          { label: t('ed.img.medium'), checked: cur === 480, action: size(480) },
          { label: t('ed.img.large'), checked: cur === 720, action: size(720) },
          { label: t('ed.img.original'), checked: !cur, action: size(0) },
        ],
      },
      { label: t('ed.img.delete'), icon: 'delete', danger: true, disabled: this.readOnly, action: () => this.run(() => img.remove()) },
    ]);
  }

  imagePath(img) {
    if (img.dataset.att && this.note) return `${this.app.store.root}/${this.note.id}/${img.dataset.att}`;
    const src = img.getAttribute('src') || '';
    if (src.startsWith('media:')) {
      try {
        return decodeURIComponent(new URL(src).pathname);
      } catch {}
    }
    return null;
  }

  async saveImageAs(img) {
    const path = this.imagePath(img);
    if (!path) return;
    const ext = (/\.[a-z0-9]+$/i.exec(path) || ['.png'])[0];
    const dest = await this.ctx.ui.filePicker({ mode: 'save', name: `${this.t('ed.img.defaultName')}${ext}`, filters: [{ name: this.t('ed.pictures'), ext: [ext] }], path: this.ctx.shell.xdg?.pictures, parent: this.ctx.win });
    if (!dest) return;
    try {
      await this.ctx.api.invoke('fs:writeBytes', dest, await this.ctx.api.invoke('fs:readBytes', path));
      this.app.toast(this.t('ed.img.saved', { name: dest.split('/').pop() }));
    } catch (err) {
      this.app.error(this.t('errors.saveImage', { message: err.message }));
    }
  }

  async copyImage(img) {
    const path = this.imagePath(img);
    if (!path) return;
    try {
      const bytes = await this.ctx.api.invoke('fs:readBytes', path);
      await this.ctx.api.invoke('notes:clipboardWriteImage', bytes);
      this.app.toast(this.t('copied'));
    } catch (err) {
      this.app.error(err.message);
    }
  }

  // ------------------------------------------------------------------ body events
  bindBody() {
    const b = this.body;
    b.addEventListener('keydown', (e) => this.onKeyDown(e));
    b.addEventListener('beforeinput', (e) => {
      if (e.inputType === 'historyUndo' || e.inputType === 'historyRedo') {
        e.preventDefault();
        if (e.inputType === 'historyUndo') this.undo();
        else this.redo();
      } else if (/^format/.test(e.inputType) && !this._formatting) {
        // native formatting shortcuts go through our commands (history + state)
        e.preventDefault();
      }
    });
    b.addEventListener('input', (e) => this.onInput(e));
    b.addEventListener('paste', (e) => this.onPaste(e));
    b.addEventListener('copy', (e) => this.onCopy(e, false));
    b.addEventListener('cut', (e) => this.onCopy(e, true));
    b.addEventListener('dragstart', () => (this.internalDrag = true));
    b.addEventListener('dragend', () => (this.internalDrag = false));
    b.addEventListener('dragover', (e) => this.onDragOver(e));
    b.addEventListener('drop', (e) => this.onDrop(e));
    b.addEventListener('mousedown', (e) => this.onMouseDown(e));
    b.addEventListener('click', (e) => this.onClick(e));
    b.addEventListener('dblclick', (e) => {
      if (e.target.tagName === 'IMG') {
        const p = this.imagePath(e.target);
        if (p) this.ctx.shell.openFile(p);
      }
    });
    b.addEventListener('contextmenu', (e) => this.onContextMenu(e));
    b.addEventListener('focus', () => this.updateState());
    b.addEventListener('blur', () => {
      const r = editorRange(this.body);
      if (r) this.savedRange = r.cloneRange();
      this.hist.record();
    });
    this.selHandler = () => {
      if (!this.note) return;
      const r = editorRange(this.body);
      if (!r) return;
      this.savedRange = r.cloneRange();
      cancelAnimationFrame(this._stateRaf);
      this._stateRaf = requestAnimationFrame(() => this.updateState());
    };
    document.addEventListener('selectionchange', this.selHandler);
    this.ctx.onClose(() => document.removeEventListener('selectionchange', this.selHandler));
  }

  onKeyDown(e) {
    if (e.isComposing) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const code = e.code;
    if (this.readOnly) {
      if (ctrl && (k === 'z' || k === 'y')) e.preventDefault();
      return;
    }
    const go = (fn) => {
      e.preventDefault();
      e.stopPropagation();
      fn();
    };
    if (ctrl && !e.altKey) {
      if (k === 'z' && !e.shiftKey) return go(() => this.undo());
      if (k === 'y' || (k === 'z' && e.shiftKey)) return go(() => this.redo());
      if (k === 'b' && !e.shiftKey) return go(() => this.command('bold'));
      if (k === 'i' && !e.shiftKey) return go(() => this.command('italic'));
      if (k === 'u' && !e.shiftKey) return go(() => this.command('underline'));
      if (k === 'x' && e.shiftKey) return go(() => this.command('strike'));
      if (k === 'k' && e.shiftKey) return go(() => this.command('code'));
      if (k === 'k' && !e.shiftKey) return go(() => this.command('link'));
      if (e.shiftKey && code === 'Digit7') return go(() => this.command('ol'));
      if (e.shiftKey && code === 'Digit8') return go(() => this.command('ul'));
      if (e.shiftKey && k === 'c') return go(() => this.command('check'));
      if (e.shiftKey && (code === 'Period' || k === '>')) return go(() => this.command('quote'));
      if (e.shiftKey && k === 'h') return go(() => this.command('hlApply'));
      if (e.key === ' ' || code === 'Space') return go(() => this.command('clear'));
      if (e.shiftKey && k === 'v') return go(() => this.pasteFromClipboard({ plain: true }));
      if (k === 'enter' || e.key === 'Enter') {
        const li = this.checklistItem();
        if (li) return go(() => this.toggleCheck(li));
      }
    }
    if (ctrl && e.altKey && !e.shiftKey) {
      const map = { Digit0: 'div', Digit1: 'h1', Digit2: 'h2', Digit3: 'h3', Numpad0: 'div', Numpad1: 'h1', Numpad2: 'h2', Numpad3: 'h3' };
      if (map[code]) return go(() => this.run(() => this.setBlock(map[code])));
      if (k === 'c') return go(() => this.command('pre'));
    }
    if (e.key === 'Tab' && !ctrl && !e.altKey) return go(() => this.onTab(e.shiftKey));
    if (e.key === 'Enter' && !ctrl && !e.altKey && !e.shiftKey) {
      if (this.onEnter()) e.preventDefault();
      return;
    }
    if (e.key === 'Backspace' && !ctrl && !e.altKey) {
      if (this.onBackspace()) e.preventDefault();
      return;
    }
    if (e.key === 'ArrowUp' && !ctrl && !e.shiftKey && !e.altKey) {
      // from the first line up into the title
      const r = editorRange(this.body);
      if (r?.collapsed) {
        const rect = caretRect(r);
        const first = this.body.firstElementChild;
        if (first && rect && rect.top - first.getBoundingClientRect().top < 6) {
          e.preventDefault();
          this.title.focus();
          this.title.setSelectionRange(this.title.value.length, this.title.value.length);
        }
      }
    }
    if (e.key === 'Escape' && this.find.open) {
      e.preventDefault();
      this.closeFind();
    }
  }

  checklistItem() {
    const r = editorRange(this.body);
    const li = r && closest(r.startContainer, 'li', this.body);
    return li?.parentElement?.dataset.type === 'checklist' ? li : null;
  }

  toggleCheck(li) {
    if (this.readOnly) return;
    this.hist.record();
    li.dataset.checked = li.dataset.checked === 'true' ? 'false' : 'true';
    this.hist.record();
    this.changed({ record: false });
    this.updateState();
  }

  onTab(back) {
    const r = editorRange(this.body);
    if (!r) return;
    const cell = closest(r.startContainer, 'td, th', this.body);
    if (cell) {
      const cells = [...cell.closest('table').querySelectorAll('td, th')];
      const i = cells.indexOf(cell);
      let next = cells[i + (back ? -1 : 1)];
      if (!next && !back) {
        this.run(() => this.tableRow(1));
        return;
      }
      if (next) {
        const rr = document.createRange();
        rr.selectNodeContents(next);
        window.getSelection().removeAllRanges();
        window.getSelection().addRange(rr);
      }
      return;
    }
    if (closest(r.startContainer, 'li', this.body)) {
      this.run(() => {
        this._formatting = true;
        document.execCommand(back ? 'outdent' : 'indent');
        this._formatting = false;
        // nested lists inside a checklist are checklists too
        for (const ul of this.body.querySelectorAll('ul[data-type="checklist"] ul:not([data-type])')) setChecklist(ul, true);
      });
      return;
    }
    if (!back) this.run(() => document.execCommand('insertText', false, '\t'));
  }

  onEnter() {
    const r = editorRange(this.body);
    if (!r) return false;
    const block = closestBlock(r.startContainer, this.body);
    if (!block) return false;
    // code block: newline inside, Enter on an empty last line leaves the block
    if (block.tagName === 'PRE') {
      this.hist.record();
      r.deleteContents();
      const before = document.createRange();
      before.setStart(block, 0);
      before.setEnd(r.startContainer, r.startOffset);
      const textBefore = before.toString();
      const after = document.createRange();
      after.setStart(r.startContainer, r.startOffset);
      after.setEnd(block, block.childNodes.length);
      const atEnd = !after.toString().replace(/\n$/, '');
      if (atEnd && textBefore.endsWith('\n')) {
        // leave: drop the empty last line
        block.textContent = block.textContent.replace(/\n+$/, '');
        if (!block.textContent) block.appendChild(document.createElement('br'));
        const line = emptyLine();
        block.after(line);
        caretAtStart(line);
      } else {
        const nl = document.createTextNode('\n');
        r.insertNode(nl);
        if (atEnd && block.lastChild?.nodeName !== 'BR') block.appendChild(document.createElement('br'));
        setCaretAfter(nl);
        block.normalize();
      }
      this.hist.record();
      this.changed({ record: false });
      return true;
    }
    // Markdown on Enter: ``` (code block) and --- (divider)
    const lineText = block.textContent.replace(new RegExp(ZWSP, 'g'), '');
    if (['DIV', 'P'].includes(block.tagName) && block.parentNode === this.body && (lineText === '```' || /^```[\w+-]+$/.test(lineText))) {
      this.hist.record();
      const pre = document.createElement('pre');
      pre.appendChild(document.createElement('br'));
      block.replaceWith(pre);
      if (!pre.nextSibling) pre.after(emptyLine());
      caretAtStart(pre);
      this.hist.record();
      this.changed({ record: false });
      return true;
    }
    if (['DIV', 'P'].includes(block.tagName) && block.parentNode === this.body && /^(-{3,}|\*{3,}|_{3,})$/.test(lineText)) {
      this.hist.record();
      const hr = document.createElement('hr');
      const line = emptyLine();
      block.replaceWith(hr);
      hr.after(line);
      caretAtStart(line);
      this.hist.record();
      this.changed({ record: false });
      return true;
    }
    // empty quote / heading line: back to a normal line
    if (['BLOCKQUOTE'].includes(block.tagName) && isEmptyBlock(block)) {
      this.hist.record();
      const d = retag(block, 'div');
      caretAtStart(d);
      this.hist.record();
      this.changed({ record: false });
      return true;
    }
    this.hist.record();
    return false;
  }

  onBackspace() {
    const r = editorRange(this.body);
    if (!r || !r.collapsed) return false;
    const block = closestBlock(r.startContainer, this.body);
    if (!block || !['H1', 'H2', 'H3', 'BLOCKQUOTE', 'PRE'].includes(block.tagName)) return false;
    const before = document.createRange();
    before.setStart(block, 0);
    before.setEnd(r.startContainer, r.startOffset);
    if (before.toString().replace(new RegExp(ZWSP, 'g'), '') !== '') return false;
    // at the start of a heading / quote / code block: turn it into a normal line
    this.run(() => {
      if (block.tagName === 'PRE') {
        const lines = block.textContent.replace(/\n$/, '').split('\n');
        const made = lines.map((l) => {
          const d = document.createElement('div');
          if (l) d.textContent = l;
          else d.appendChild(document.createElement('br'));
          return d;
        });
        block.replaceWith(...made);
        caretAtStart(made[0]);
      } else {
        const d = retag(block, 'div');
        caretAtStart(d);
      }
    });
    return true;
  }

  onInput(e) {
    if (this.readOnly || this._formatting) return; // our own commands record / save themselves
    if (e.inputType === 'insertText' && e.data) {
      if (this.markdownBlock(e.data) || this.markdownInline(e.data)) {
        this.changed({ record: false });
        return;
      }
    }
    if (e.inputType === 'insertParagraph') {
      // a new checklist item starts unchecked
      const li = this.checklistItem();
      if (li && isEmptyBlock(li)) li.dataset.checked = 'false';
    }
    this.ensureStructure();
    const boundary = e.inputType === 'insertParagraph' || e.inputType === 'insertLineBreak' || (e.inputType === 'insertText' && /\s/.test(e.data || '')) || /^delete/.test(e.inputType) !== /^delete/.test(this._lastInputType || '');
    this._lastInputType = e.inputType;
    this.hist.typed(boundary);
    this.changed({ record: false });
    if (this.linkPop && !this.linkPop.closed) this.linkPop.close();
  }

  /** "# " "## " "### " "- " "* " "+ " "1. " "[] " "[x] " "> " at the start of a line; "```" anywhere at the start. */
  markdownBlock(data) {
    const r = editorRange(this.body);
    if (!r || !r.collapsed || r.startContainer.nodeType !== 3) return false;
    const block = closestBlock(r.startContainer, this.body);
    const host = block || this.body;
    if (block && !['DIV', 'P', 'LI'].includes(block.tagName)) return false;
    const pre = document.createRange();
    pre.setStart(host, 0);
    pre.setEnd(r.startContainer, r.startOffset);
    const before = pre.toString().replace(new RegExp(ZWSP, 'g'), '');
    let m;
    if (data === '`' && before === '```' && block?.tagName !== 'LI') {
      this.hist.record();
      pre.deleteContents();
      this.convertLine(block, 'pre');
      this.hist.record();
      return true;
    }
    if (data !== ' ' && data !== '\u00a0') return false;
    m = /^(#{1,3}|[-*+]|\d{1,3}[.)]|\[[ xX]?\]|>)[ \u00a0]$/.exec(before);
    if (!m) return false;
    const mk = m[1];
    if (block?.tagName === 'LI') {
      // "[ ] " inside a bullet item turns the list into a checklist
      if (!/^\[[ xX]?\]$/.test(mk) || block.parentElement?.tagName !== 'UL') return false;
      this.hist.record();
      pre.deleteContents();
      setChecklist(block.parentElement, true);
      block.dataset.checked = /x/i.test(mk) ? 'true' : 'false';
      this.fillEmpty(block);
      this.hist.record();
      return true;
    }
    this.hist.record(); // undo restores the literal characters
    pre.deleteContents();
    if (/^#/.test(mk)) this.convertLine(block, `h${mk.length}`);
    else if (mk === '>') this.convertLine(block, 'blockquote');
    else if (/^[-*+]$/.test(mk)) this.listFromLine('insertUnorderedList');
    else if (/^\d/.test(mk)) {
      this.listFromLine('insertOrderedList');
      const n = parseInt(mk, 10);
      const ol = closest(editorRange(this.body)?.startContainer, 'ol', this.body);
      if (ol && n > 1) ol.setAttribute('start', String(n));
    } else {
      this.listFromLine('insertUnorderedList');
      const r2 = editorRange(this.body);
      const li = r2 && closest(r2.startContainer, 'li', this.body);
      if (li?.parentElement?.tagName === 'UL') {
        setChecklist(li.parentElement, true);
        li.dataset.checked = /x/i.test(mk) ? 'true' : 'false';
      }
    }
    this.ensureStructure();
    this.hist.record();
    return true;
  }

  convertLine(block, tag) {
    let b = block;
    if (!b) {
      normalizeRoot(this.body);
      const r = editorRange(this.body);
      b = r && closestBlock(r.startContainer, this.body);
      if (!b) return;
    }
    const n = retag(b, tag);
    this.fillEmpty(n);
    if (tag === 'pre' && !n.nextSibling) n.after(emptyLine());
    caretAtStart(n);
  }

  listFromLine(cmd) {
    const r = editorRange(this.body);
    const block = r && closestBlock(r.startContainer, this.body);
    if (block) this.fillEmpty(block);
    this._formatting = true;
    document.execCommand(cmd);
    this._formatting = false;
    normalizeRoot(this.body);
  }

  fillEmpty(el) {
    if (!el.textContent.replace(new RegExp(ZWSP, 'g'), '') && !el.querySelector('br, img')) {
      el.textContent = '';
      el.appendChild(document.createElement('br'));
      caretAtStart(el);
    }
  }

  /** **bold** *italic* ~~strike~~ `code` ==highlight== when the closing marker is typed. */
  markdownInline(data) {
    if (!'*~`='.includes(data)) return false;
    const r = editorRange(this.body);
    if (!r || !r.collapsed || r.startContainer.nodeType !== 3) return false;
    const node = r.startContainer;
    if (closest(node, 'pre, code', this.body)) return false;
    const text = node.data.slice(0, r.startOffset);
    const rules = [
      { re: /(^|[^*\\])\*\*([^*\s](?:[^*]*[^*\s])?)\*\*$/, tag: 'b' },
      { re: /(^|[^~\\])~~([^~\s](?:[^~]*[^~\s])?)~~$/, tag: 's' },
      { re: /(^|[^=\\])==([^=\s](?:[^=]*[^=\s])?)==$/, tag: 'mark' },
      { re: /(^|[^*\\\w])\*([^*\s](?:[^*]*[^*\s])?)\*$/, tag: 'i' },
      { re: /(^|[^`\\])`([^`]+)`$/, tag: 'code' },
    ];
    for (const rule of rules) {
      const m = rule.re.exec(text);
      if (!m) continue;
      const start = m.index + m[1].length;
      const end = r.startOffset;
      this.hist.record();
      // [start, end) holds marker + content + marker
      node.splitText(end);
      const mid = node.splitText(start);
      mid.data = m[2];
      const el = document.createElement(rule.tag);
      if (rule.tag === 'mark') el.setAttribute('data-hl', this.lastHl);
      mid.replaceWith(el);
      el.appendChild(mid);
      // continue typing outside the new format
      const after = document.createTextNode(ZWSP);
      el.after(after);
      setCaret(after, 1);
      this.hist.record();
      return true;
    }
    return false;
  }

  onMouseDown(e) {
    // checklist boxes: the ::before area left of the item text
    const li = e.target.closest?.('li');
    if (li && li.parentElement?.dataset.type === 'checklist' && this.body.contains(li) && e.button === 0) {
      const rect = li.getBoundingClientRect();
      // the box is drawn in the item's left padding (see style.css)
      if (e.clientX >= rect.left - 4 && e.clientX <= rect.left + 26 && e.clientY <= rect.top + 26) {
        e.preventDefault();
        if (!this.readOnly) this.toggleCheck(li);
        return;
      }
    }
    for (const s of this.body.querySelectorAll('img.nt-sel')) if (s !== e.target) s.classList.remove('nt-sel');
    const a = e.target.closest?.('a');
    if (a && (e.ctrlKey || e.metaKey) && e.button === 0) {
      e.preventDefault();
      this.openLink(a);
    }
  }

  onClick(e) {
    if (e.target.tagName === 'IMG' && this.body.contains(e.target)) {
      e.target.classList.add('nt-sel');
      const r = document.createRange();
      r.selectNode(e.target);
      window.getSelection().removeAllRanges();
      window.getSelection().addRange(r);
    }
  }

  onContextMenu(e) {
    e.preventDefault();
    const t = this.t;
    const img = e.target.closest?.('img');
    if (img && this.body.contains(img)) return this.imageMenu(img, e);
    const r = editorRange(this.body);
    const hasSel = r && !r.collapsed;
    const a = e.target.closest?.('a') || this.currentLink();
    const ro = this.readOnly;
    const items = [
      { label: t('ed.cut'), icon: 'cut', shortcut: 'Ctrl+X', disabled: !hasSel || ro, action: () => this.clipboardCmd('cut') },
      { label: t('ed.copy'), icon: 'copy', shortcut: 'Ctrl+C', disabled: !hasSel, action: () => this.clipboardCmd('copy') },
      { label: t('ed.paste'), icon: 'clipboard_paste', shortcut: 'Ctrl+V', disabled: ro, action: () => this.pasteFromClipboard() },
      { label: t('ed.pastePlain'), icon: 'clipboard_text_ltr', shortcut: 'Ctrl+Shift+V', disabled: ro, action: () => this.pasteFromClipboard({ plain: true }) },
      '-',
      { label: t('ed.selectAll'), icon: 'select_all_on', shortcut: 'Ctrl+A', action: () => this.selectAll() },
    ];
    if (a && this.body.contains(a)) {
      items.push(
        '-',
        { label: t('ed.openLink'), icon: 'open', shortcut: `Ctrl+${t('click')}`, action: () => this.openLink(a) },
        { label: t('ed.editLink'), icon: 'edit', disabled: ro, action: () => this.editLink(a) },
        { label: t('ed.copyLink'), icon: 'copy', action: () => this.copyText(a.getAttribute('href') || '') },
        { label: t('ed.removeLink'), icon: 'link_dismiss', disabled: ro, action: () => this.run(() => unwrap(a)) },
      );
    } else if (!ro) {
      items.push('-', { label: t('ed.link'), icon: 'link', shortcut: 'Ctrl+K', action: () => this.editLink() });
    }
    if (this.currentCell() && !ro) items.push({ label: t('ed.table'), icon: 'table', submenu: this.tableItems() });
    items.push('-', { label: t('ed.find'), icon: 'search', shortcut: 'Ctrl+F', action: () => this.openFind() });
    this.ctx.ui.menu(e, items);
  }

  selectAll() {
    this.body.focus();
    const r = document.createRange();
    r.selectNodeContents(this.body);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(r);
  }

  clipboardCmd(cmd) {
    this.focusBody();
    if (cmd === 'cut') this.hist.record();
    const ok = document.execCommand(cmd);
    if (!ok && cmd === 'copy') {
      const r = editorRange(this.body);
      if (r) this.ctx.api.invoke('clipboard:writeText', r.toString()).catch(() => {});
    }
    if (cmd === 'cut') {
      this.ensureStructure();
      this.hist.record();
      this.changed({ record: false });
    }
  }

  onCopy(e, cut) {
    const r = editorRange(this.body);
    if (!r || r.collapsed) return;
    // plain text without zero-width spaces; HTML as rendered (pictures keep their media URLs)
    const box = document.createElement('div');
    box.appendChild(r.cloneContents());
    for (const img of box.querySelectorAll('img')) img.removeAttribute('class');
    e.clipboardData.setData('text/html', box.innerHTML);
    e.clipboardData.setData('text/plain', plainText(box, { bullets: true, checklistMarks: true }) || r.toString().replace(new RegExp(ZWSP, 'g'), ''));
    e.preventDefault();
    if (cut && !this.readOnly) {
      this.hist.record();
      r.deleteContents();
      this.ensureStructure();
      this.hist.record();
      this.changed({ record: false });
    }
  }

  async pasteFromClipboard({ plain = false } = {}) {
    if (this.readOnly || !this.note) return;
    try {
      const clip = await this.ctx.api.invoke('notes:clipboard');
      this.focusBody();
      if (!plain && clip.image && !clip.html) return this.insertImages([{ bytes: clip.image, name: 'pasted.png' }]);
      this.insertClipboard({ html: plain ? '' : clip.html, text: clip.text });
    } catch (err) {
      this.app.error(this.t('errors.paste', { message: err.message }));
    }
  }

  onPaste(e) {
    e.preventDefault();
    if (this.readOnly) return;
    const dt = e.clipboardData;
    if (!dt) return;
    const files = imageFiles(dt);
    const html = dt.getData('text/html');
    const text = dt.getData('text/plain');
    // a picture copied from a page comes as a file + an <img> tag: prefer the file
    if (files.length && (!html || /^\s*(<meta[^>]*>\s*)?(<html>|<body>|<!--StartFragment-->|\s)*<img[^>]*>(\s|<\/body>|<\/html>|<!--EndFragment-->)*$/i.test(html))) {
      this.insertImages(files.map((file) => ({ file })));
      return;
    }
    this.insertClipboard({ html, text });
  }

  insertClipboard({ html, text }) {
    const r = editorRange(this.body);
    if (!r) return;
    const inCode = closest(r.startContainer, 'pre, code', this.body);
    this.hist.record();
    if (html && !inCode) {
      const frag = sanitizeFragment(html, { collapseWhitespace: true, allowMedia: true, allowRemote: true });
      const imgs = [...frag.querySelectorAll('img')];
      if (frag.childNodes.length) insertFragment(this.body, r, frag);
      this.localizeImages(imgs);
    } else if (text) {
      const clean = text.replace(/\r\n?/g, '\n');
      if (inCode) {
        r.deleteContents();
        const node = document.createTextNode(clean);
        r.insertNode(node);
        setCaretAfter(node);
      } else {
        const lines = clean.split('\n');
        if (lines.length === 1) insertInline(this.body, r, [document.createTextNode(clean)]);
        else {
          const frag = document.createDocumentFragment();
          for (const l of lines) {
            const d = document.createElement('div');
            if (l) d.textContent = l;
            else d.appendChild(document.createElement('br'));
            frag.appendChild(d);
          }
          insertFragment(this.body, r, frag);
        }
      }
    }
    this.ensureStructure();
    this.hist.record();
    this.changed({ record: false });
    this.scrollCaretIntoView();
  }

  onDragOver(e) {
    if (this.readOnly) return;
    const types = [...(e.dataTransfer?.types || [])];
    if (types.includes('application/x-aurora-note')) return; // notes list drag: not a drop target
    if (this.internalDrag || types.includes('Files') || types.includes('application/x-aurora-paths') || types.includes('text/html') || types.includes('text/plain') || types.includes('text/uri-list')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = this.internalDrag ? 'move' : 'copy';
    }
  }

  onDrop(e) {
    if (this.readOnly) {
      e.preventDefault();
      return;
    }
    const dt = e.dataTransfer;
    if (this.internalDrag) {
      // moving a selection inside the note: the browser does it (content is already clean)
      this.hist.record();
      setTimeout(() => {
        this.ensureStructure();
        this.hist.record();
        this.changed({ record: false });
      });
      return;
    }
    e.preventDefault();
    if ([...(dt?.types || [])].includes('application/x-aurora-note')) return;
    const pos = document.caretRangeFromPoint?.(e.clientX, e.clientY);
    if (pos && this.body.contains(pos.startContainer)) {
      this.body.focus({ preventScroll: true });
      window.getSelection().removeAllRanges();
      window.getSelection().addRange(pos);
    } else this.focusBody();
    // files from File Explorer / the desktop
    let paths = [];
    try {
      paths = JSON.parse(dt.getData('application/x-aurora-paths') || '[]');
    } catch {}
    if (!paths.length) {
      paths = (dt.getData('text/uri-list') || '')
        .split(/\r?\n/)
        .filter((l) => l.startsWith('file://'))
        .map((l) => decodeURIComponent(l.slice(7)));
    }
    const files = imageFiles(dt);
    if (paths.length) {
      const imgs = paths.filter((p) => IMAGE_EXT.test(p));
      if (imgs.length) this.insertImages(imgs.map((p) => ({ path: p })));
      if (imgs.length < paths.length) this.app.toast(this.t('ed.onlyPictures'));
      return;
    }
    if (files.length) {
      this.insertImages(files.map((file) => ({ file })));
      return;
    }
    if (dt.files?.length) {
      this.app.toast(this.t('ed.onlyPictures'));
      return;
    }
    this.insertClipboard({ html: dt.getData('text/html'), text: dt.getData('text/plain') });
  }

  // ------------------------------------------------------------------ title
  onTitleInput() {
    if (this.title.value.includes('\n')) this.title.value = this.title.value.replace(/\s*\n\s*/g, ' ');
    this.autosizeTitle();
    this.changed({ record: false });
  }

  autosizeTitle() {
    this.title.style.height = 'auto';
    this.title.style.height = `${this.title.scrollHeight}px`;
  }

  titleKeys(e) {
    if (e.key === 'Enter' || (e.key === 'ArrowDown' && this.title.selectionStart === this.title.value.length)) {
      e.preventDefault();
      if (this.readOnly) return;
      this.body.focus({ preventScroll: true });
      caretAtStart(this.body.firstElementChild || this.body);
    }
  }

  // ------------------------------------------------------------------ structure / state
  ensureStructure() {
    const b = this.body;
    let bare = false;
    for (const n of b.childNodes) {
      if (n.nodeType === 3 ? n.data.length : n.nodeType === 1 && !['DIV', 'P', 'H1', 'H2', 'H3', 'BLOCKQUOTE', 'PRE', 'UL', 'OL', 'TABLE', 'HR'].includes(n.tagName)) {
        bare = true;
        break;
      }
    }
    if (bare) {
      const refs = saveRefs(b);
      normalizeRoot(b);
      restoreRefs(b, refs);
    }
    if (!b.firstChild) b.appendChild(emptyLine());
    // a divider or table must never be the last block (nowhere to type after it)
    const last = b.lastElementChild;
    if (last && ['HR', 'TABLE', 'PRE'].includes(last.tagName)) last.after(emptyLine());
    // <font> from execCommand fallbacks -> nothing (colours use data attributes)
    for (const f of b.querySelectorAll('font')) unwrap(f);
    const empty = b.childNodes.length === 1 && b.firstElementChild && ['DIV', 'P'].includes(b.firstElementChild.tagName) && isEmptyBlock(b.firstElementChild);
    b.classList.toggle('is-empty', !!empty);
  }

  updateState() {
    if (!this.note) return;
    const r = editorRange(this.body);
    const q = (c) => {
      try {
        return document.queryCommandState(c);
      } catch {
        return false;
      }
    };
    const block = r ? closestBlock(r.startContainer, this.body) : null;
    const li = r ? closest(r.startContainer, 'li', this.body) : null;
    const list = li?.parentElement;
    const st = {
      bold: r && q('bold'),
      italic: r && q('italic'),
      underline: r && q('underline'),
      strike: r && q('strikeThrough'),
      code: r && allInside(this.body, r, (el) => el.tagName === 'CODE'),
      ul: list?.tagName === 'UL' && list.dataset.type !== 'checklist',
      ol: list?.tagName === 'OL',
      check: list?.tagName === 'UL' && list.dataset.type === 'checklist',
      quote: block?.tagName === 'BLOCKQUOTE',
      pre: block?.tagName === 'PRE',
      link: !!(r && closest(r.startContainer, 'a', this.body)),
      block: block && ['H1', 'H2', 'H3', 'BLOCKQUOTE', 'PRE'].includes(block.tagName) ? block.tagName.toLowerCase() : 'div',
    };
    this.state = st;
    for (const b of this.cmdbar.querySelectorAll('[aria-pressed]')) {
      const on = !!st[b.dataset.cmd];
      b.setAttribute('aria-pressed', String(on));
      b.classList.toggle('on', on);
    }
    const style = BLOCK_STYLES.find((s) => s.tag === st.block) || BLOCK_STYLES[0];
    this.styleLabel.textContent = this.t(`ed.style.${style.key}`);
    this.cmdbar.querySelector('[data-cmd="undo"]').disabled = this.readOnly || !this.hist.canUndo;
    this.cmdbar.querySelector('[data-cmd="redo"]').disabled = this.readOnly || !this.hist.canRedo;
    for (const b of this.groupsEl.querySelectorAll('button')) if (!['undo', 'redo'].includes(b.dataset.cmd)) b.disabled = this.readOnly;
    this.overflowBtn.disabled = this.readOnly;
    this.pinBtn.setAttribute('aria-pressed', String(!!this.note.pinned));
    this.pinBtn.classList.toggle('on', !!this.note.pinned);
    this.pinBtn.disabled = !!this.note.deletedAt;
    this.pinBtn.dataset.tip = `${this.note.pinned ? this.t('unpin') : this.t('pin')} (Ctrl+P)`;
    this.pinBtn.setAttribute('aria-label', this.note.pinned ? this.t('unpin') : this.t('pin'));
    this.fixTabStop();
    // link card when the caret sits in a link
    const a = r?.collapsed && document.activeElement === this.body ? closest(r.startContainer, 'a', this.body) : null;
    if (a) this.linkCard(a);
    else if (this.linkPop && !this.linkPop.closed) this.linkPop.close();
  }

  // ------------------------------------------------------------------ load / save
  /** Show a note (or nothing). */
  load(note, { focus = false, terms = [] } = {}) {
    closePopover();
    this.closeFind({ keepFocus: true });
    this.note = note;
    this.el.classList.toggle('no-note', !note);
    if (!note) {
      this.body.replaceChildren();
      this.title.value = '';
      this.clearHighlights();
      clearInterval(this.editedTimer);
      return;
    }
    this.readOnly = !!note.deletedAt;
    this.el.classList.toggle('read-only', this.readOnly);
    this.title.value = note.title || '';
    this.title.readOnly = this.readOnly;
    this.body.replaceChildren(this.renderHtml(note));
    this.body.contentEditable = this.readOnly ? 'false' : 'true';
    this.ensureStructure();
    this.hist.reset();
    this.autosizeTitle();
    requestAnimationFrame(() => this.autosizeTitle());
    this.renderMeta();
    this.renderInfobar();
    this.updateCounts();
    this.setSaved('idle');
    this.scroller.scrollTop = 0;
    this.searchTerms = terms;
    this.paintHighlights();
    clearInterval(this.editedTimer);
    this.editedTimer = setInterval(() => this.renderEdited(), 30000);
    this.paintColorBars();
    this.updateState();
    this.layoutToolbar();
    if (focus && !this.readOnly) {
      if (!note.title && isEmptyBlock(this.body)) this.title.focus();
      else {
        this.body.focus({ preventScroll: true });
        caretAtEnd(this.body.lastElementChild || this.body);
      }
    }
  }

  renderHtml(note) {
    const frag = sanitizeFragment(note.html || '', { attachments: true, allowMedia: true, allowRemote: true });
    for (const img of frag.querySelectorAll('img')) {
      const src = img.getAttribute('src') || '';
      const name = img.dataset.att || (ATTACHMENT_RE.test(src) ? src : null);
      if (name && ATTACHMENT_RE.test(name)) {
        img.dataset.att = name;
        img.src = this.ctx.api.mediaUrl(`${this.app.store.root}/${note.id}/${name}`);
      }
      img.decoding = 'async';
    }
    return frag;
  }

  /** Clean HTML of the body as stored in the note file (attachments by name). */
  serialize() {
    const clone = this.body.cloneNode(true);
    for (const img of clone.querySelectorAll('img')) {
      img.removeAttribute('class');
      img.removeAttribute('decoding');
      if (img.dataset.att) img.setAttribute('src', img.dataset.att);
      else if ((img.getAttribute('src') || '').startsWith('blob:')) img.remove();
    }
    for (const el of clone.querySelectorAll('[class]')) el.removeAttribute('class');
    // zero-width spaces used as caret anchors
    const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
    const empty = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.data.includes(ZWSP)) n.data = n.data.replace(new RegExp(ZWSP, 'g'), '');
      if (!n.data) empty.push(n);
    }
    for (const n of empty) n.remove();
    for (const pre of clone.querySelectorAll('pre')) if (pre.lastChild?.nodeName === 'BR' && pre.childNodes.length > 1) pre.lastChild.remove();
    mergeSiblings(clone);
    // a note that is just an empty line is empty
    if (clone.childNodes.length === 1 && isEmptyBlock(clone.firstChild) && clone.firstChild.nodeType === 1 && ['DIV', 'P'].includes(clone.firstChild.tagName)) return '';
    return sanitizeHtml(clone.innerHTML, { attachments: true, allowMedia: true, allowRemote: true });
  }

  attachmentNames() {
    return [...this.body.querySelectorAll('img[data-att]')].map((i) => i.dataset.att);
  }

  changed({ record = true } = {}) {
    if (!this.note || this.readOnly) return;
    if (record) this.hist.typed();
    this.app.scheduleSave();
    this.setSaved('pending');
    clearTimeout(this.countTimer);
    this.countTimer = setTimeout(() => {
      this.updateCounts();
      if (this.find.open) this.runFind({ keepIndex: true });
      else this.paintHighlights();
    }, 250);
  }

  updateCounts() {
    if (!this.note) return;
    const text = `${this.title.value ? `${this.title.value}\n` : ''}${plainText(this.body)}`;
    const words = countWords(text, this.app.locale);
    const chars = countChars(text);
    this.countEl.textContent = `${this.t('status.words', { count: words })} · ${this.t('status.chars', { count: chars })}`;
  }

  setSaved(state, err) {
    const { icon } = this.ctx;
    const t = this.t;
    this.savedState = state;
    this.savedEl.dataset.state = state;
    this.savedEl.replaceChildren();
    if (state === 'saving' || state === 'pending') this.savedEl.append(h2(this.ctx, 'span', { class: 'nt-saving-dot' }), t('status.saving'));
    else if (state === 'saved') this.savedEl.append(icon('checkmark', { size: 12 }), t('status.saved'));
    else if (state === 'error') {
      this.savedEl.append(
        icon('warning', { size: 12, filled: true }),
        h2(this.ctx, 'button', { type: 'button', class: 'nt-retry', title: err?.message || '', onclick: () => this.app.saveCurrent() }, t('status.saveFailed')),
      );
    }
    this.renderEdited();
  }

  renderEdited() {
    if (!this.note) return;
    const n = this.app.store.get(this.note.id) || this.note;
    this.editedEl.textContent = this.readOnly
      ? this.t('status.deletedOn', { date: this.app.fmtDate(n.deletedAt, true) })
      : this.t('status.edited', { when: this.app.fmtRelative(n.modified) });
    this.editedEl.title = this.app.fmtDate(n.modified, true);
  }

  renderMeta() {
    const { h, icon } = this.ctx;
    const n = this.note;
    if (!n) return;
    const nb = this.app.store.notebook(n.notebookId);
    this.metaEl.replaceChildren(
      h('span', { class: 'nt-meta-date' }, this.app.fmtDate(n.created, true)),
      nb
        ? h(
            'button',
            {
              type: 'button',
              class: 'nt-nb-chip',
              dataset: { color: nb.color },
              disabled: this.readOnly,
              'aria-label': this.t('moveTo'),
              'data-tip': this.t('moveTo'),
              onclick: (e) => this.app.moveMenu([n.id], e.currentTarget),
            },
            nb.emoji ? h('span', { class: 'nt-nb-emoji' }, nb.emoji) : h('span', { class: 'nt-nb-dot' }),
            h('span', { class: 'ellipsis' }, nb.name),
            this.readOnly ? null : icon('chevron_down', { size: 12 }),
          )
        : null,
    );
  }

  renderInfobar() {
    const { h, icon } = this.ctx;
    const t = this.t;
    const n = this.note;
    this.infobar.hidden = !n?.deletedAt;
    if (!n?.deletedAt) return;
    const days = Math.max(0, Math.ceil((n.deletedAt + 30 * 86400000 - Date.now()) / 86400000));
    this.infobar.replaceChildren(
      icon('delete', { size: 16 }),
      h('div', { class: 'grow' }, h('div', { class: 'body-strong' }, t('deleted.bannerTitle')), h('div', { class: 'caption' }, t('deleted.bannerBody', { count: days }))),
      h('button', { type: 'button', class: 'btn', onclick: () => this.app.restoreNotes([n.id]) }, icon('arrow_undo', { size: 16 }), t('restore')),
      h('button', { type: 'button', class: 'btn subtle nt-danger-text', onclick: () => this.app.purgeNotes([n.id]) }, t('deletePermanently')),
    );
  }

  // ------------------------------------------------------------------ find in note + search highlights
  openFind() {
    if (!this.note) return;
    this.find.open = true;
    this.findBar.hidden = false;
    const r = editorRange(this.body);
    const sel = r && !r.collapsed ? r.toString() : '';
    if (sel && sel.length < 80 && !sel.includes('\n')) this.findInput.value = sel;
    this.findInput.focus();
    this.findInput.select();
    this.runFind();
  }

  closeFind({ keepFocus = false } = {}) {
    if (!this.find.open) return;
    this.find = { open: false, ranges: [], index: -1 };
    this.findBar.hidden = true;
    this.paintHighlights();
    if (!keepFocus && this.note && !this.readOnly) this.focusBody();
  }

  textMap() {
    // all text nodes of the body with their offsets in a single string (blocks separated by \n)
    const nodes = [];
    let text = '';
    const walker = document.createTreeWalker(this.body, NodeFilter.SHOW_TEXT);
    let lastBlock = null;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const b = closestBlock(n, this.body);
      if (lastBlock && b !== lastBlock) text += '\n';
      lastBlock = b;
      nodes.push({ node: n, start: text.length });
      text += n.data;
    }
    return { text, nodes };
  }

  rangesFor(terms) {
    if (!terms.length) return [];
    const { text, nodes } = this.textMap();
    const out = [];
    const locate = (pos, end) => {
      // the text node containing pos (end=true: a position at the end of a node belongs to it)
      let lo = 0;
      let hi = nodes.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (nodes[mid].start < pos || (!end && nodes[mid].start === pos)) lo = mid;
        else hi = mid - 1;
      }
      const n = nodes[lo];
      return n ? { node: n.node, offset: Math.max(0, Math.min(n.node.length, pos - n.start)) } : null;
    };
    for (const [a, b] of findRanges(text, terms, 1000)) {
      const s = locate(a, false);
      const e = locate(b, true);
      if (!s || !e) continue;
      const r = new Range();
      try {
        r.setStart(s.node, s.offset);
        r.setEnd(e.node, e.offset);
        out.push(r);
      } catch {}
    }
    return out;
  }

  runFind({ keepIndex = false } = {}) {
    const q = this.findInput.value.trim();
    const ranges = q ? this.rangesFor([foldText(q)]) : [];
    const prev = this.find.index;
    this.find.ranges = ranges;
    this.find.index = ranges.length ? (keepIndex && prev >= 0 ? Math.min(prev, ranges.length - 1) : 0) : -1;
    this.findBar.classList.toggle('no-results', !!q && !ranges.length);
    this.paintHighlights();
    this.renderFindCount();
    if (!keepIndex) this.revealMatch();
  }

  findStep(dir) {
    if (!this.find.ranges.length) {
      this.runFind();
      return;
    }
    this.find.index = (this.find.index + dir + this.find.ranges.length) % this.find.ranges.length;
    this.paintHighlights();
    this.renderFindCount();
    this.revealMatch();
  }

  renderFindCount() {
    const n = this.find.ranges.length;
    this.findCount.textContent = this.findInput.value.trim() ? (n ? this.t('ed.findCount', { i: this.find.index + 1, n }) : this.t('ed.noMatches')) : '';
  }

  revealMatch() {
    const r = this.find.ranges[this.find.index];
    if (!r) return;
    const rect = r.getBoundingClientRect();
    const sr = this.scroller.getBoundingClientRect();
    if (rect.top < sr.top + 40 || rect.bottom > sr.bottom - 40) {
      this.scroller.scrollTo({ top: this.scroller.scrollTop + rect.top - sr.top - sr.height / 3, behavior: document.documentElement.dataset.animations === 'off' ? 'auto' : 'smooth' });
    }
  }

  paintHighlights() {
    if (!hasHighlights) return;
    const all = this.find.open ? this.find.ranges : this.rangesFor(this.searchTerms);
    const cur = this.find.open ? this.find.ranges[this.find.index] : null;
    CSS.highlights.set('nt-match', new Highlight(...all.filter((r) => r !== cur)));
    if (cur) CSS.highlights.set('nt-match-current', new Highlight(cur));
    else CSS.highlights.delete('nt-match-current');
  }

  setSearchTerms(terms) {
    this.searchTerms = terms || [];
    if (!this.find.open) this.paintHighlights();
  }

  clearHighlights() {
    if (!hasHighlights) return;
    CSS.highlights.delete('nt-match');
    CSS.highlights.delete('nt-match-current');
  }

  scrollCaretIntoView() {
    const r = editorRange(this.body);
    const rect = r && caretRect(r);
    if (!rect) return;
    const sr = this.scroller.getBoundingClientRect();
    if (rect.bottom > sr.bottom - 24) this.scroller.scrollTop += rect.bottom - sr.bottom + 48;
    else if (rect.top < sr.top + 8) this.scroller.scrollTop -= sr.top - rect.top + 48;
  }

}

// ---------------------------------------------------------------- helpers
function h2(ctx, tag, props, ...kids) {
  return ctx.h(tag, props, ...kids);
}

function setChecklist(ul, on) {
  if (on) {
    ul.setAttribute('data-type', 'checklist');
    for (const li of ul.children) if (li.tagName === 'LI' && li.dataset.checked !== 'true') li.dataset.checked = 'false';
  } else {
    ul.removeAttribute('data-type');
    for (const li of ul.children) li.removeAttribute('data-checked');
  }
}

function setCaretAfter(node) {
  const r = document.createRange();
  r.setStartAfter(node);
  r.collapse(true);
  window.getSelection().removeAllRanges();
  window.getSelection().addRange(r);
}

function caretRect(range) {
  const rects = range.getClientRects();
  if (rects.length) return rects[0];
  const n = range.startContainer;
  const el = n.nodeType === 1 ? n.childNodes[range.startOffset] || n : n.parentElement;
  return el?.getBoundingClientRect?.() || null;
}

function blockLines(b) {
  // text of a block, <br> as line breaks
  const lines = [''];
  const walk = (n) => {
    for (const c of n.childNodes) {
      if (c.nodeType === 3) lines[lines.length - 1] += c.data.replace(new RegExp(ZWSP, 'g'), '');
      else if (c.nodeName === 'BR') lines.push('');
      else walk(c);
    }
  };
  walk(b);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function imageFiles(dt) {
  const out = [];
  for (const f of dt?.files || []) if (/^image\//.test(f.type) || IMAGE_EXT.test(f.name)) out.push(f);
  if (!out.length) {
    for (const it of dt?.items || []) {
      if (it.kind === 'file' && /^image\//.test(it.type)) {
        const f = it.getAsFile();
        if (f) out.push(f);
      }
    }
  }
  return out;
}
