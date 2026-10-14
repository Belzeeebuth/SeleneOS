// Details pane of the « Journaux système » app: the selected entry in full (level, time, source, whole message,
// notes on binary / cut / missing messages), its actions (copy, context, only this source) and every field of
// the entry (journal:entry), loaded when an entry is shown.
import { PRIO_ICONS, prioTone } from './format.js';

export class DetailPane {
  constructor(app) {
    this.app = app;
    const { h } = app.ctx;
    this.entry = null;
    this.seq = 0;
    this.el = h('aside', { class: 'lg-detail', 'aria-labelledby': 'lg-detail-title' });
    this.render();
  }

  show(entry) {
    if (entry && entry.cursor === this.entry?.cursor && (this.fields || this.fieldsError)) return; // already shown
    this.entry = entry;
    this.full = null;
    this.fields = null;
    this.fieldsError = null;
    this.render();
    if (!entry) return;
    const n = ++this.seq;
    this.app.ctx.api
      .invoke('journal:entry', entry.cursor)
      .then((r) => {
        if (n !== this.seq || this.app.closed) return;
        this.fields = r.fields;
        // The full message (64 KiB instead of the list's 4 KiB).
        if (r.entry?.cursor === entry.cursor) this.full = r.entry;
        this.render();
      })
      .catch((err) => {
        if (n !== this.seq || this.app.closed) return;
        this.fieldsError = err;
        this.render();
      });
  }

  /** The entry with its full message once journal:entry answered. */
  current() {
    return this.full && this.full.cursor === this.entry?.cursor ? this.full : this.entry;
  }

  render() {
    const { h, icon, t, i18n } = this.app.ctx;
    const el = this.el;
    // Re-rendered when the fields arrive: keep the keyboard focus and the scroll positions.
    const a = document.activeElement;
    const focus = el.contains(a) ? a.dataset?.act || (a.classList.contains('lg-detail-msg') ? 'msg' : null) : null;
    const scroll = el.scrollTop;
    const msgScroll = el.querySelector('.lg-detail-msg')?.scrollTop || 0;
    const sameEntry = this._rendered === this.entry?.cursor;
    this._rendered = this.entry?.cursor;
    el.textContent = '';
    this._restore = () => {
      if (!sameEntry) return;
      el.scrollTop = scroll;
      const m = el.querySelector('.lg-detail-msg');
      if (m) m.scrollTop = msgScroll;
      if (focus) el.querySelector(focus === 'msg' ? '.lg-detail-msg' : `[data-act="${focus}"]`)?.focus({ preventScroll: true });
    };
    const e = this.current();
    if (!e) {
      el.append(h('div', { class: 'lg-detail-empty empty' }, icon('text-align-left', { size: 40 }), h('div', { class: 'caption' }, t('empty.select'))));
      this._rendered = null;
      return;
    }
    const tone = prioTone(e.prio);
    const levelName = this.app.prioName(e.prio);
    const when = i18n.formatDate(e.ts, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 });
    const src = [e.source ? `${e.source}${e.pid ? `[${e.pid}]` : ''}` : null, e.unit && e.unit !== e.source ? e.unit : null].filter(Boolean).join(' · ');
    const notes = [];
    if (e.binary) notes.push(t('detail.binary'));
    if (e.truncated) notes.push(t('detail.truncated', { size: i18n.formatSize(e.size) }));
    if (e.missing) notes.push(t('detail.missing'));
    const actions = h(
      'div',
      { class: 'lg-detail-actions' },
      h('button', { class: 'btn small', dataset: { act: 'copy' }, onclick: () => this.app.copyEntry(this.current()) }, icon('copy', { size: 14 }), t('detail.copy')),
      h('button', { class: 'btn small', dataset: { act: 'context' }, disabled: !!this.app.context, onclick: () => this.app.showContext(e) }, icon('rows', { size: 14 }), t('detail.context')),
      h('button', { class: 'btn small', dataset: { act: 'only' }, disabled: !this.app.sourceOf(e), onclick: () => this.app.filterSource(e) }, icon('funnel-simple', { size: 14 }), t('detail.filterSource')),
    );
    // (Element.append would write « null » for a missing part: filter them out.)
    const parts = [
      h(
        'div',
        { class: 'lg-detail-head' },
        h('div', { class: ['lg-level-chip', `tone-${tone}`] }, icon(e.prio == null ? 'circle' : PRIO_ICONS[e.prio], { size: 14, filled: e.prio != null && e.prio <= 5 }), h('span', null, levelName)),
        h('h2', { class: 'lg-detail-title', id: 'lg-detail-title' }, src || t('detail.noSource')),
        h('div', { class: 'lg-detail-time caption text-2' }, when),
      ),
      actions,
      notes.length ? h('div', { class: 'lg-detail-notes' }, notes.map((n) => h('div', { class: 'caption' }, icon('info', { size: 14 }), h('span', null, n)))) : null,
      h('div', { class: 'lg-detail-label caption text-2' }, t('detail.message')),
      h('pre', { class: 'lg-detail-msg selectable', tabindex: '0', 'aria-label': t('detail.message') }, e.missing ? '' : e.msg),
      h('div', { class: 'lg-detail-label caption text-2' }, t('detail.fields')),
      this.renderFields(),
    ];
    el.append(...parts.filter(Boolean));
    this._restore();
  }

  renderFields() {
    const { h, t } = this.app.ctx;
    if (this.fieldsError) return h('div', { class: 'caption text-2 lg-detail-fields-msg' }, t('detail.failed', { msg: this.app.errText(this.fieldsError) }));
    if (!this.fields) return h('div', { class: 'caption text-2 lg-detail-fields-msg' }, t('detail.loading'));
    return h(
      'dl',
      { class: 'lg-fields selectable' },
      // MESSAGE is the box above.
      this.fields.filter((f) => f.name !== 'MESSAGE').map((f) => [
        h('dt', { class: 'mono' }, f.name),
        h(
          'dd',
          { class: 'mono' },
          f.missing ? h('span', { class: 'text-2' }, t('detail.missingValue')) : f.value,
          f.binary ? h('span', { class: 'lg-tag' }, t('detail.binaryTag')) : null,
          f.truncated ? h('span', { class: 'lg-tag' }, t('detail.truncatedTag')) : null,
        ),
      ]),
    );
  }
}
