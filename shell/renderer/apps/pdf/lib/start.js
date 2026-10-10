// Start page (a tab without a document): "Open a file", a drop zone and the Recent documents list.
import { shared } from './shared.js';

export class StartPage {
  constructor(w) {
    this.w = w;
    const { h } = w;
    this.el = h('div', { class: 'pdf-start', tabindex: '-1', hidden: true });
    this.missing = new Set();
    this.off = shared.on('recent', () => this.isShown() && this.renderRecent());
    this.build();
  }

  isShown() {
    return !this.el.hidden;
  }

  build() {
    const { h, t, ctx } = this.w;
    const { icon, ui } = ctx;
    ui.clear(this.el);
    this.openBtn = h('button', { class: 'btn primary large pdf-start-open', onclick: () => this.w.openDialog() }, icon('folder_open'), h('span', null, t('start.open')));
    this.drop = h(
      'div',
      { class: 'pdf-start-drop' },
      h('div', { class: 'pdf-start-drop-icon' }, icon('document_arrow_up', { size: 28 })),
      h('div', { class: 'body-strong' }, t('start.dropTitle')),
      h('div', { class: 'caption text-2' }, t('start.dropHint')),
      this.openBtn,
      h('div', { class: 'caption text-3 pdf-start-key' }, t('start.shortcut')),
    );
    this.list = h('div', { class: 'pdf-recent-list', role: 'list', 'aria-label': t('start.recent') });
    this.clearBtn = h('button', { class: 'btn subtle small pdf-recent-clear', onclick: () => this.clearAll() }, t('start.clear'));
    this.recentHead = h('div', { class: 'pdf-recent-head' }, h('div', { class: 'body-strong' }, t('start.recent')), this.clearBtn);
    this.el.appendChild(
      h(
        'div',
        { class: 'pdf-start-inner' },
        h(
          'div',
          { class: 'pdf-start-hero' },
          h('img', { src: ctx.appUrl('icon.svg'), alt: '', width: 48, height: 48 }),
          h('div', null, h('div', { class: 'title' }, this.w.appName), h('div', { class: 'text-2' }, t('start.subtitle'))),
        ),
        this.drop,
        h('section', { class: 'pdf-recent' }, this.recentHead, this.list),
      ),
    );
    this.renderRecent();
  }

  show() {
    this.el.hidden = false;
    this.renderRecent();
    this.checkMissing();
  }
  hide() {
    this.el.hidden = true;
  }
  focus() {
    this.el.focus({ preventScroll: true });
  }

  async checkMissing() {
    const { api } = this.w.ctx;
    const missing = new Set();
    await Promise.all(
      shared.recent.map(async (r) => {
        const ok = await api.invoke('fs:exists', r.path).catch(() => true);
        if (!ok) missing.add(r.path);
      }),
    );
    const changed = missing.size !== this.missing.size || [...missing].some((p) => !this.missing.has(p));
    this.missing = missing;
    if (changed && this.isShown()) this.renderRecent();
  }

  renderRecent() {
    const { h, t, ctx } = this.w;
    const { icon, ui, i18n } = ctx;
    ui.clear(this.list);
    const items = shared.recent;
    this.clearBtn.hidden = !items.length;
    if (!items.length) {
      this.list.appendChild(h('div', { class: 'pdf-recent-empty' }, icon('history', { size: 24 }), h('div', { class: 'text-2' }, t('start.noRecent'))));
      return;
    }
    for (const r of items) {
      const missing = this.missing.has(r.path);
      const thumb = h('div', { class: 'pdf-recent-thumb' }, r.thumb ? h('img', { src: r.thumb, alt: '', draggable: false }) : icon('document_pdf', { size: 20 }));
      const dir = r.path.replace(/\/[^/]*$/, '') || '/';
      const meta = [];
      if (missing) meta.push(t('start.missing'));
      else if (r.pages) meta.push(t('start.pageOf', { page: i18n.formatNumber(r.page || 1), pages: i18n.formatNumber(r.pages) }));
      const remove = h(
        'button',
        {
          class: 'btn subtle icon-btn pdf-recent-remove',
          'aria-label': t('start.remove'),
          'data-tip': t('start.remove'),
          onclick: (e) => {
            e.stopPropagation();
            this.remove(r.path, row);
          },
        },
        icon('dismiss', { size: 14 }),
      );
      const row = h(
        'div',
        {
          class: ['pdf-recent-row', missing && 'missing'],
          role: 'listitem',
          tabindex: '0',
          'data-tip': r.path,
          dataset: { path: r.path },
          onclick: () => this.openEntry(r),
          onkeydown: (e) => {
            if (e.key === 'Enter') this.openEntry(r);
            else if (e.key === 'Delete') this.remove(r.path, row);
            else if ((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') {
              e.preventDefault();
              this.menu(row, r);
            } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              const sib = e.key === 'ArrowDown' ? row.nextElementSibling : row.previousElementSibling;
              sib?.focus({ preventScroll: true });
            }
          },
          oncontextmenu: (e) => {
            e.preventDefault();
            this.menu(e, r);
          },
        },
        thumb,
        h('div', { class: 'pdf-recent-text' }, h('div', { class: 'pdf-recent-name ellipsis' }, r.name || r.path.split('/').pop()), h('div', { class: 'caption text-2 ellipsis' }, dir)),
        h('div', { class: 'caption text-2 pdf-recent-meta' }, meta.join(' · ')),
        h('div', { class: 'caption text-2 pdf-recent-date' }, r.date ? relDate(i18n, r.date) : ''),
        remove,
      );
      this.list.appendChild(row);
    }
  }

  menu(at, r) {
    const { t } = this.w;
    this.w.ctx.ui.menu(at, [
      { label: t('start.openItem'), icon: 'open', action: () => this.openEntry(r) },
      { label: t('start.openNewTab'), icon: 'tab_add', action: () => this.w.openPath(r.path, { newTab: true }) },
      { label: t('menu.openLocation'), icon: 'folder_open', action: () => this.w.openLocation(r.path) },
      { label: t('start.copyPath'), icon: 'copy', action: () => this.w.copyText(r.path) },
      '-',
      { label: t('start.remove'), icon: 'dismiss', action: () => this.remove(r.path) },
    ]);
  }

  async openEntry(r) {
    const { t, ctx } = this.w;
    const ok = await ctx.api.invoke('fs:exists', r.path).catch(() => true);
    if (!ok) {
      const remove = await ctx.ui.confirm(t('start.missingBody', { path: r.path }), { title: t('start.missingTitle'), okLabel: t('start.remove'), parent: this.w.win });
      if (remove) shared.recentRemove(r.path);
      return;
    }
    this.w.openPath(r.path);
  }

  remove(path, row) {
    const next = row?.nextElementSibling || row?.previousElementSibling;
    shared.recentRemove(path);
    if (next?.dataset?.path) this.list.querySelector(`[data-path="${CSS.escape(next.dataset.path)}"]`)?.focus({ preventScroll: true });
  }

  async clearAll() {
    const { t, ctx } = this.w;
    const ok = await ctx.ui.confirm(t('start.clearBody'), { title: t('start.clearTitle'), okLabel: t('start.clear'), parent: this.w.win });
    if (ok) shared.recentClear();
  }

  relabel() {
    this.build();
  }

  destroy() {
    this.off?.();
    this.el.remove();
  }
}

function relDate(i18n, ms) {
  const d = new Date(ms);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return i18n.formatTime(d, { hour: 'numeric', minute: '2-digit' });
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return capitalize(new Intl.RelativeTimeFormat(i18n.locale, { numeric: 'auto' }).format(-1, 'day'));
  if (now - d < 6 * 86400000) return i18n.formatDate(d, { weekday: 'long' });
  return i18n.formatDate(d, { dateStyle: 'medium' });
}

function capitalize(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}
