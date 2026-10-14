// Comparisons of the Code Editor (a tab of kind 'diff'): a document against an original text that cannot be edited.
//   source 'head'  : the file as recorded in git HEAD (main/ipc/code.js code:gitShow) vs the working copy
//   source 'saved' : the file as saved on disk vs the unsaved changes of the editor
//   source 'file'  : another file vs this one (« Comparer deux fichiers »)
// The right side is the document itself: editable, saved with Ctrl+S, kept in sync with its other tabs by main.js
// (its view carries `codeTab`, so main.js onUpdate propagates its changes and sends it the others').
// Two modes: side by side (@codemirror/merge MergeView, with a revert arrow next to each change) and inline
// (unifiedMergeView: the original lines shown as deleted blocks above the new ones, with a revert button).
// Next / previous change: F7 / Shift+F7 or the bar; « Annuler cette modification » reverts the change at the cursor.
import { CM, originalExtensions } from './cm.js';

const { MergeView, unifiedMergeView, goToNextChunk, goToPreviousChunk, getChunks, rejectChunk, EditorView, EditorState, ChangeSet, originalDocChangeEffect, getOriginalDoc } = CM;
const DIFF_CONFIG = { scanLimit: 5000, timeout: 2000 };

export class DiffView {
  /**
   * opts: { source, original (text), text (the document's current text), origLabel, modLabel, otherPath, mode }
   */
  constructor(app, tab, opts) {
    this.app = app;
    this.tab = tab;
    this.source = opts.source;
    this.otherPath = opts.otherPath || null;
    this.original = String(opts.original ?? '');
    this.origLabel = opts.origLabel;
    this.modLabel = opts.modLabel;
    this.mode = opts.mode === 'inline' ? 'inline' : 'split';
    this.mv = null;
    this.uv = null;
    const { h, t } = app;
    const btn = (ic, tip, onclick, act) => h('button', { class: 'btn subtle code-tbtn', 'data-tip': tip, 'aria-label': tip, 'data-act': act, onclick }, app.icon(ic, { size: 16 }));
    this.countEl = h('span', { class: 'code-diff-count', 'aria-live': 'polite' });
    this.prevBtn = btn('arrow-up', t('diffPrev'), () => this.prev(), 'diff-prev');
    this.nextBtn = btn('arrow-down', t('diffNext'), () => this.next(), 'diff-next');
    this.revertBtn = btn('arrow-counter-clockwise', t('diffRevert'), () => this.revert(), 'diff-revert');
    this.modeSeg = app.ui.segmented({
      options: [
        { value: 'split', icon: 'columns', tip: t('diffSideBySide') },
        { value: 'inline', icon: 'rows', tip: t('diffInline') },
      ],
      value: this.mode,
      onchange: (v) => this.setMode(v),
    });
    this.modeSeg.classList.add('code-diff-mode');
    this.labelA = h('span', { class: 'code-diff-side' });
    this.labelB = h('span', { class: 'code-diff-side' });
    this.heads = h('div', { class: 'code-diff-heads' }, this.labelA, h('span', { class: 'code-diff-gap' }), this.labelB);
    this.titleEl = h('span', { class: 'code-diff-what' });
    this.bar = h(
      'div',
      { class: 'code-diff-bar', role: 'toolbar', 'aria-label': t('diffToolbar') },
      app.icon('arrows-left-right', { size: 16, class: 'code-diff-icon' }),
      this.titleEl,
      this.countEl,
      h('span', { class: 'code-grow' }),
      this.prevBtn,
      this.nextBtn,
      this.revertBtn,
      h('span', { class: 'code-sep' }),
      this.modeSeg,
    );
    this.body = h('div', { class: 'code-diff-body' });
    this.el = h('div', { class: 'code-diff', 'data-tab': tab.id }, this.bar, this.heads, this.body);
    this.renderLabels();
    this.build(opts.text ?? '');
    this.refresh();
  }

  /** The tab title. */
  get title() {
    const { t } = this.app;
    const name = this.tab.doc?.name || '';
    if (this.source === 'head') return t('diffTitleHead', { name });
    if (this.source === 'saved') return t('diffTitleSaved', { name });
    return t('diffTitleFiles', { a: baseName(this.otherPath || this.origLabel), b: name });
  }

  /** The tab tooltip. */
  get tip() {
    const { t } = this.app;
    const p = this.tab.doc?.path || this.tab.doc?.name || '';
    if (this.source === 'head') return t('diffTipHead', { path: p });
    if (this.source === 'saved') return t('diffTipSaved', { path: p });
    return t('diffTipFiles', { a: this.otherPath || this.origLabel, b: p });
  }

  /** The editable view (the document). */
  get editView() {
    return this.mv ? this.mv.b : this.uv;
  }

  /** The read-only view of the original (side by side only). */
  get origView() {
    return this.mv ? this.mv.a : null;
  }

  chunks() {
    const v = this.editView;
    return (v && getChunks(v.state)?.chunks) || [];
  }

  renderLabels() {
    const { t } = this.app;
    this.labelA.textContent = this.origLabel;
    this.labelB.textContent = this.modLabel;
    // side by side: a label over each editor; inline: « original ↔ document » in the bar
    this.titleEl.textContent = t('diffSides', { a: this.origLabel, b: this.modLabel });
    this.titleEl.hidden = this.mode === 'split';
    this.heads.hidden = this.mode !== 'split';
    for (const b of this.modeSeg.querySelectorAll('button')) {
      b.setAttribute('aria-label', b.dataset.tip || '');
      b.setAttribute('aria-pressed', String(b.classList.contains('selected')));
    }
  }

  build(text, selection) {
    const { app } = this;
    const doc = this.tab.doc;
    const keys = [
      { key: 'F7', run: () => (this.next(), true) },
      { key: 'Shift-F7', run: () => (this.prev(), true) },
    ];
    const sel = selection && selection.ranges.every((r) => r.to <= text.length) ? selection : undefined;
    const modExt = app.docExtensions(doc, keys);
    if (this.mode === 'split') {
      this.mv = new MergeView({
        a: { doc: this.original, extensions: originalExtensions({ lang: doc.lang, uiLang: app.uiLang(), wrap: !!app.prefs.wrap, keys }) },
        b: { doc: text, selection: sel, extensions: modExt },
        parent: this.body,
        revertControls: 'a-to-b',
        renderRevertControl: () =>
          app.h('button', { class: 'code-diff-arrow', title: app.t('diffRevert'), 'aria-label': app.t('diffRevert'), tabindex: -1 }, app.icon('arrow-right', { size: 14 })),
        highlightChanges: true,
        gutter: true,
        diffConfig: DIFF_CONFIG,
      });
      this.mv.b.codeTab = this.tab;
      this.mv.a.dom.setAttribute('aria-label', this.origLabel);
      this.mv.b.dom.setAttribute('aria-label', this.modLabel);
    } else {
      this.uv = new EditorView({
        parent: this.body,
        state: EditorState.create({
          doc: text,
          selection: sel,
          extensions: [
            modExt,
            unifiedMergeView({
              original: this.original,
              highlightChanges: true,
              gutter: true,
              syntaxHighlightDeletions: true,
              mergeControls: (type, action) => this.chunkButton(type, action),
              diffConfig: DIFF_CONFIG,
            }),
          ],
        }),
      });
      this.uv.codeTab = this.tab;
      this.uv.dom.setAttribute('aria-label', this.modLabel);
    }
  }

  /** The revert button of a deleted block (inline mode); « accept » makes no sense against a fixed original. */
  chunkButton(type, action) {
    const { app } = this;
    if (type !== 'reject') return app.h('span', { class: 'code-diff-none', hidden: true });
    return app.h(
      'button',
      {
        class: 'btn small code-diff-chunk-revert',
        name: 'reject',
        title: app.t('diffRevert'),
        onmousedown: (e) => action(e),
        onkeydown: (e) => (e.key === 'Enter' || e.key === ' ') && action(e),
      },
      app.icon('arrow-counter-clockwise', { size: 14 }),
      app.h('span', null, app.t('diffRevertShort')),
    );
  }

  teardown() {
    this.mv?.destroy();
    this.uv?.destroy();
    this.mv = null;
    this.uv = null;
    this.body.replaceChildren();
  }

  setMode(mode) {
    if (mode === this.mode || !this.editView) return;
    const v = this.editView;
    const text = v.state.doc.toString();
    const sel = v.state.selection;
    this.teardown();
    this.mode = mode === 'inline' ? 'inline' : 'split';
    this.build(text, sel);
    this.modeSeg.setValue(this.mode);
    this.renderLabels();
    this.app.prefs.diffMode = this.mode;
    this.app.savePrefs();
    this.refresh();
    this.editView.focus();
  }

  /** The original changed (the file was saved, for a comparison with the saved file). */
  setOriginal(text) {
    this.original = String(text ?? '');
    if (this.mv) {
      const a = this.mv.a;
      a.dispatch({ changes: { from: 0, to: a.state.doc.length, insert: this.original } });
    } else if (this.uv) {
      const st = this.uv.state;
      const orig = getOriginalDoc(st);
      this.uv.dispatch({ effects: originalDocChangeEffect(st, ChangeSet.of({ from: 0, to: orig.length, insert: this.original }, orig.length)) });
    }
    this.refresh();
  }

  /** The index of the change under the cursor, or -1. */
  current() {
    const v = this.editView;
    if (!v) return -1;
    const head = v.state.selection.main.head;
    return this.chunks().findIndex((c) => c.fromB <= head && head <= Math.max(c.fromB, c.endB));
  }

  refresh() {
    const { t } = this.app;
    const chunks = this.chunks();
    const i = this.current();
    this.countEl.textContent = !chunks.length ? t('diffNone') : i >= 0 ? t('diffPos', { n: i + 1, count: chunks.length }) : t('diffCount', { count: chunks.length });
    this.prevBtn.disabled = this.nextBtn.disabled = !chunks.length;
    this.revertBtn.disabled = i < 0;
  }

  move(cmd) {
    const v = this.editView;
    if (!v) return false;
    const chunks = this.chunks();
    if (!chunks.length) return false;
    let ok = cmd(v);
    if (!ok && chunks.length === 1) {
      // the only change: go to it (the command only moves between changes)
      const c = chunks[0];
      v.dispatch({ selection: { anchor: c.fromB }, effects: EditorView.scrollIntoView(c.fromB, { y: 'center' }), userEvent: 'select.byChunk' });
      ok = true;
    }
    v.focus();
    this.refresh();
    return ok;
  }

  next() {
    return this.move(goToNextChunk);
  }

  prev() {
    return this.move(goToPreviousChunk);
  }

  /** Puts the change under the cursor back to the original text. */
  revert() {
    const v = this.editView;
    if (!v) return false;
    let ok = false;
    if (this.uv) ok = rejectChunk(v);
    else {
      const b = v.state;
      const head = b.selection.main.head;
      const chunk = this.mv.chunks.find((c) => c.fromB <= head && head <= Math.max(c.fromB, c.endB));
      if (chunk) {
        const a = this.mv.a.state;
        let insert = a.sliceDoc(chunk.fromA, Math.max(chunk.fromA, chunk.toA - 1));
        if (chunk.fromA !== chunk.toA && chunk.toB <= b.doc.length) insert += b.lineBreak;
        v.dispatch({ changes: { from: chunk.fromB, to: Math.min(b.doc.length, chunk.toB), insert }, userEvent: 'revert' });
        ok = true;
      }
    }
    v.focus();
    this.refresh();
    return ok;
  }

  /** Shown again (tab switch, moved to another pane): the side by side view realigns its two editors. */
  shown() {
    this.mv?.scheduleMeasure?.();
    this.editView?.requestMeasure();
    this.origView?.requestMeasure();
  }

  focus() {
    this.editView?.focus();
  }

  destroy() {
    this.teardown();
    this.el.remove();
  }
}

function baseName(p) {
  return String(p || '').replace(/\/+$/, '').split('/').pop() || String(p || '');
}
