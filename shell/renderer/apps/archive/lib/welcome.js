// Welcome page (window opened without an archive): Open / Create cards, drop hint and Recent archives.
import { shared } from './shared.js';
import { iconUrl, dirname } from './util.js';

export class Welcome {
  constructor(w) {
    this.w = w;
    const { h } = w;
    this.missing = new Set();
    this.el = h('div', { class: 'arc-welcome', hidden: true });
    this.off = shared.on('recent', () => !this.el.hidden && this.renderRecent());
    this.build();
  }

  build() {
    const { h, t, icon, ctx } = this.w;
    const card = (cls, ic, title, sub, key, onclick) =>
      h('button', { class: ['arc-wcard', cls], onclick }, h('span', { class: 'arc-wcard-ic' }, icon(ic, { size: 24 })), h('span', { class: 'arc-wcard-text' }, h('span', { class: 'body-strong' }, title), h('span', { class: 'caption text-2' }, sub)), h('span', { class: 'arc-wcard-key caption text-2' }, key));
    this.list = h('div', { class: 'arc-recent-list', role: 'list', 'aria-label': t('welcome.recent') });
    this.clearBtn = h('button', { class: 'btn subtle small', onclick: () => this.clearAll() }, t('welcome.clear'));
    this.el.replaceChildren(
      h(
        'div',
        { class: 'arc-welcome-inner' },
        h(
          'div',
          { class: 'arc-hero' },
          h('img', { src: ctx.appUrl('icon.svg'), alt: '', width: 56, height: 56 }),
          h('div', null, h('div', { class: 'title' }, this.w.appName), h('div', { class: 'text-2' }, t('welcome.subtitle'))),
        ),
        h(
          'div',
          { class: 'arc-wcards' },
          card('open', 'folder_open', t('welcome.open'), t('welcome.openSub'), 'Ctrl+O', () => this.w.openDialog()),
          card('create', 'folder_zip', t('welcome.create'), t('welcome.createSub'), 'Ctrl+N', () => this.w.newArchive()),
        ),
        h('div', { class: 'arc-wdrop caption text-2' }, icon('document_arrow_up', { size: 16 }), h('span', null, t('welcome.drop'))),
        h('section', { class: 'arc-recent' }, h('div', { class: 'arc-recent-head' }, h('div', { class: 'body-strong' }, t('welcome.recent')), this.clearBtn), this.list),
        h('div', { class: 'arc-formats caption text-2' }, t('welcome.formats')),
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

  async checkMissing() {
    const missing = new Set();
    await Promise.all(shared.recent.map(async (r) => !(await this.w.api.invoke('fs:exists', r.path).catch(() => true)) && missing.add(r.path)));
    const changed = missing.size !== this.missing.size || [...missing].some((p) => !this.missing.has(p));
    this.missing = missing;
    if (changed && !this.el.hidden) this.renderRecent();
  }

  renderRecent() {
    const { h, t, icon, i18n } = this.w;
    // a re-render (missing files found, an entry removed in another window) keeps the keyboard on its row
    const focused = this.list.contains(document.activeElement) ? document.activeElement.closest('.arc-recent-row')?.dataset.path : null;
    this.list.replaceChildren();
    this.clearBtn.hidden = !shared.recent.length;
    if (!shared.recent.length) {
      this.list.appendChild(h('div', { class: 'arc-recent-empty' }, icon('history', { size: 20 }), h('span', { class: 'text-2' }, t('welcome.noRecent'))));
      return;
    }
    for (const r of shared.recent) {
      const missing = this.missing.has(r.path);
      const row = h(
        'div',
        {
          class: ['arc-recent-row', missing && 'missing'],
          role: 'listitem',
          tabindex: '0',
          'data-tip': r.path,
          dataset: { path: r.path },
          onclick: () => this.open(r),
          onkeydown: (e) => {
            if (e.key === 'Enter') this.open(r);
            else if (e.key === 'Delete') this.remove(r, row);
            else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              (e.key === 'ArrowDown' ? row.nextElementSibling : row.previousElementSibling)?.focus();
            } else if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
              e.preventDefault();
              this.menu(row, r);
            }
          },
          oncontextmenu: (e) => {
            e.preventDefault();
            this.menu(e, r);
          },
        },
        h('img', { src: iconUrl({ name: r.name }), alt: '', class: 'arc-recent-ic' }),
        h('div', { class: 'arc-recent-text' }, h('div', { class: 'ellipsis' }, r.name), h('div', { class: 'caption text-2 ellipsis' }, missing ? t('welcome.missing') : dirname(r.path))),
        h('div', { class: 'caption text-2 arc-recent-size' }, r.size ? i18n.formatSize(r.size) : ''),
        h('div', { class: 'caption text-2 arc-recent-date' }, r.date ? i18n.formatDate(r.date, { dateStyle: 'medium' }) : ''),
        h('button', {
          class: 'btn subtle icon-btn arc-recent-x',
          'aria-label': t('welcome.remove'),
          'data-tip': t('welcome.remove'),
          onclick: (e) => {
            e.stopPropagation();
            this.remove(r, row);
          },
        }, icon('dismiss', { size: 12 })),
      );
      this.list.appendChild(row);
    }
    if (this.refocus != null) {
      const rows = this.list.querySelectorAll('.arc-recent-row');
      (rows[Math.min(this.refocus, rows.length - 1)] || this.el.querySelector('.arc-wcard'))?.focus();
      this.refocus = null;
    } else if (focused) {
      this.list.querySelector(`[data-path="${CSS.escape(focused)}"]`)?.focus();
    }
  }
  /** Remove a Recent entry; the keyboard focus moves to the next row (not lost to the page). */
  remove(r, row) {
    if (row?.contains(document.activeElement)) this.refocus = [...this.list.children].indexOf(row);
    shared.recentRemove(r.path);
  }

  menu(at, r) {
    const { t, ui } = this.w;
    ui.menu(at, [
      { label: t('welcome.openItem'), icon: 'open', action: () => this.open(r) },
      { label: t('menu.openLocation'), icon: 'folder_open', action: () => this.w.shell.launch('files', { select: r.path }) },
      { label: t('menu.copyPath'), icon: 'copy', action: () => this.w.api.invoke('clipboard:writeText', r.path) },
      '-',
      { label: t('welcome.remove'), icon: 'dismiss', action: () => this.remove(r, this.list.querySelector(`[data-path="${CSS.escape(r.path)}"]`)) },
    ]);
  }

  async open(r) {
    const { t, ui, api } = this.w;
    if (!(await api.invoke('fs:exists', r.path).catch(() => true))) {
      const rm = await ui.confirm(t('welcome.missingBody', { path: r.path }), { title: t('welcome.missingTitle'), okLabel: t('welcome.remove'), parent: this.w.win });
      if (rm) shared.recentRemove(r.path);
      return;
    }
    this.w.openPath(r.path);
  }

  async clearAll() {
    const { t, ui } = this.w;
    if (await ui.confirm(t('welcome.clearBody'), { title: t('welcome.clearTitle'), okLabel: t('welcome.clear'), parent: this.w.win })) shared.recentClear();
  }

  destroy() {
    this.off?.();
  }
}
