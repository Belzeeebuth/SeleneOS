// Message list: date groups, avatars, unread accent bar, flag/attachment icons, hover quick
// actions, multi-select (checkboxes, Ctrl/Shift+click, keyboard), drag to folders, infinite scroll.
import { store } from './store.js';
import { errorText } from './setup.js';
import { avatarColor, initials, displayName, listDate, dateGroup } from './util.js';

export const DRAG_MIME = 'application/x-aurora-mail';

export class MessageList {
  constructor(ctx, app) {
    this.ctx = ctx;
    this.app = app;
    this.messages = [];
    this.total = 0;
    this.page = 0;
    this.hasMore = false;
    this.loading = false;
    this.error = null;
    this.selected = new Set();
    this.anchor = null;
    this.focusUid = null;
    this.selectMode = false;
    this.seq = 0;
    const { h, icon } = ctx;
    const t = (k, v) => this.t(k, v);
    this.titleEl = h('div', { class: 'ml-list-title ellipsis' });
    this.countEl = h('div', { class: 'ml-list-count caption text-2' });
    this.filterBtn = h('button', { class: 'btn subtle icon-btn', name: 'filter', 'aria-label': t('list.filter'), 'data-tip': t('list.filter'), onclick: (e) => this.filterMenu(e) }, icon('filter'));
    this.selectBtn = h('button', { class: 'btn subtle icon-btn', name: 'select-mode', 'aria-label': t('list.selectMode'), 'data-tip': t('list.selectMode'), 'aria-pressed': 'false', onclick: () => this.toggleSelectMode() }, icon('multiselect_ltr'));
    this.refreshBtn = h('button', { class: 'btn subtle icon-btn', name: 'refresh', 'aria-label': t('list.refresh'), 'data-tip': `${t('list.refresh')} (F5)`, onclick: () => this.app.refresh() }, icon('arrow_sync'));
    this.navBtn = h('button', { class: 'btn subtle icon-btn ml-nav-toggle', name: 'nav', 'aria-label': t('nav.toggle'), 'data-tip': t('nav.toggle'), onclick: () => this.app.toggleNav() }, icon('navigation'));
    this.head = h(
      'div',
      { class: 'ml-list-head' },
      this.navBtn,
      h('div', { class: 'ml-list-titles' }, this.titleEl, this.countEl),
      h('div', { class: 'ml-list-actions' }, this.filterBtn, this.selectBtn, this.refreshBtn),
    );
    this.searchBanner = h('div', { class: 'ml-search-banner', hidden: true });
    this.banner = h('div', { class: 'ml-list-banner' });
    this.scroller = h('div', { class: 'ml-list', role: 'listbox', tabindex: '0', 'aria-multiselectable': 'true', 'aria-label': t('list.label') });
    this.progress = h('div', { class: 'progress indeterminate ml-list-progress', hidden: true }, h('div', { class: 'bar' }));
    this.el = h('section', { class: 'ml-listpane' }, this.head, this.progress, this.searchBanner, this.banner, this.scroller);
    this.scroller.addEventListener('keydown', (e) => this.onKey(e));
    this.scroller.addEventListener('scroll', () => this.maybeLoadMore());
    this.scroller.addEventListener('focus', () => {
      if (this.focusUid == null && this.messages.length) this.setFocus(this.messages[0].uid);
    });
  }

  t(k, v) {
    return this.ctx.t(k, v);
  }

  // ------------------------------------------------------------ data
  get query() {
    return { search: this.app.searchText || '', filter: this.app.filter || '' };
  }

  async load({ reset = true, soft = false } = {}) {
    const app = this.app;
    if (!app.account || !app.folder) return;
    if (soft && this.loading) {
      this.queuedSoft = true; // refresh again once the current load is done
      return;
    }
    if (!soft) this.queuedSoft = false;
    const seq = ++this.seq;
    const accountId = app.account.id;
    const folder = app.folder;
    if (reset && !soft) {
      this.messages = [];
      this.page = 0;
      this.hasMore = false;
      this.error = null;
      this.selected.clear();
      this.focusUid = null;
      this.anchor = null;
      this.scroller.scrollTop = 0;
      this.renderSkeleton();
    }
    this.loading = true;
    this.progress.hidden = false;
    this.refreshBtn.classList.add('spinning');
    try {
      const keep = soft ? Math.min(500, Math.max(50, this.messages.length)) : 50;
      const res = await this.ctx.api.invoke('mail:list', accountId, folder, { page: 0, pageSize: keep, ...this.query });
      if (seq !== this.seq) return;
      this.messages = res.messages;
      this.total = res.total;
      this.page = soft ? Math.ceil(keep / 50) - 1 : 0;
      this.pageSize = keep;
      this.hasMore = res.hasMore;
      this.error = null;
      this.learnContacts(res.messages);
      // Drop selections that disappeared.
      const uids = new Set(this.messages.map((m) => m.uid));
      for (const u of [...this.selected]) if (!uids.has(u)) this.selected.delete(u);
      if (soft && this.sameAsRendered(this.messages)) {
        this.updateCount();
        this.renderFooter();
      } else this.render();
      this.app.onListLoaded?.(soft);
    } catch (e) {
      if (seq !== this.seq) return;
      this.error = e;
      if (!soft || !this.messages.length) this.render();
      else this.showBanner(e);
    } finally {
      if (seq === this.seq) {
        this.loading = false;
        this.progress.hidden = true;
        this.refreshBtn.classList.remove('spinning');
        if (this.queuedSoft) {
          this.queuedSoft = false;
          setTimeout(() => this.load({ soft: true }), 30);
        }
      }
    }
  }

  async loadMore() {
    if (this.loading || !this.hasMore) return;
    const app = this.app;
    const seq = this.seq;
    this.loading = true;
    this.renderFooter();
    try {
      const pageSize = 50;
      const offset = this.messages.length;
      // Pages are counted in steps of 50 from the newest message.
      const page = Math.floor(offset / pageSize);
      const res = await this.ctx.api.invoke('mail:list', app.account.id, app.folder, { page, pageSize, ...this.query });
      if (seq !== this.seq) return;
      const have = new Set(this.messages.map((m) => m.uid));
      this.messages.push(...res.messages.filter((m) => !have.has(m.uid)));
      this.hasMore = res.hasMore;
      this.total = res.total;
      this.learnContacts(res.messages);
      this.render();
    } catch (e) {
      if (seq === this.seq) this.showBanner(e);
    } finally {
      if (seq === this.seq) {
        this.loading = false;
        this.renderFooter();
        if (this.queuedSoft) {
          this.queuedSoft = false;
          setTimeout(() => this.load({ soft: true }), 30);
        }
      }
    }
  }

  maybeLoadMore() {
    const s = this.scroller;
    if (this.hasMore && !this.loading && s.scrollTop + s.clientHeight > s.scrollHeight - 300) this.loadMore();
  }

  learnContacts(list) {
    const sent = ['sent', 'drafts'].includes(this.app.folderSpecial());
    const people = [];
    for (const m of list) people.push(...(sent ? [...(m.to || []), ...(m.cc || [])] : m.from || []));
    store.addContacts(people, sent ? 2 : 1);
  }

  byUid(uid) {
    return this.messages.find((m) => m.uid === uid) || null;
  }

  update(uids, patch) {
    for (const uid of [].concat(uids)) {
      const m = this.byUid(uid);
      if (m) Object.assign(m, patch);
    }
    this.render();
  }

  remove(uids) {
    const set = new Set([].concat(uids));
    const idx = this.messages.findIndex((m) => set.has(m.uid));
    this.messages = this.messages.filter((m) => !set.has(m.uid));
    this.total = Math.max(0, this.total - set.size);
    for (const u of set) this.selected.delete(u);
    this.render();
    return idx;
  }

  restore(snapshot) {
    this.messages = snapshot.messages;
    this.total = snapshot.total;
    this.render();
  }

  snapshot() {
    return { messages: [...this.messages], total: this.total };
  }

  // ------------------------------------------------------------ selection
  get selectedUids() {
    return this.messages.filter((m) => this.selected.has(m.uid)).map((m) => m.uid);
  }

  select(uid, { additive = false, range = false, open = true, focus = true } = {}) {
    if (range && this.anchor != null) {
      const a = this.messages.findIndex((m) => m.uid === this.anchor);
      const b = this.messages.findIndex((m) => m.uid === uid);
      if (a >= 0 && b >= 0) {
        if (!additive) this.selected.clear();
        for (let i = Math.min(a, b); i <= Math.max(a, b); i++) this.selected.add(this.messages[i].uid);
      }
    } else if (additive) {
      if (this.selected.has(uid)) this.selected.delete(uid);
      else this.selected.add(uid);
      this.anchor = uid;
    } else {
      this.selected = new Set([uid]);
      this.anchor = uid;
    }
    if (focus) this.focusUid = uid;
    this.paintSelection();
    this.app.onSelection(open);
  }

  selectAll() {
    this.selected = new Set(this.messages.map((m) => m.uid));
    this.paintSelection();
    this.app.onSelection(false);
  }

  clearSelection() {
    this.selected.clear();
    this.paintSelection();
  }

  toggleSelectMode(on = !this.selectMode) {
    this.selectMode = on;
    this.el.classList.toggle('select-mode', on);
    this.selectBtn.classList.toggle('on', on);
    this.selectBtn.setAttribute('aria-pressed', String(on));
    if (!on && this.selected.size > 1) {
      const keep = this.focusUid ?? this.selectedUids[0];
      this.selected = new Set(keep != null ? [keep] : []);
      this.paintSelection();
      this.app.onSelection(true);
    }
  }

  setFocus(uid) {
    this.focusUid = uid;
    for (const el of this.scroller.querySelectorAll('.ml-item')) el.classList.toggle('focused', Number(el.dataset.uid) === uid);
    this.rowEl(uid)?.scrollIntoView({ block: 'nearest' });
  }

  rowEl(uid) {
    return this.scroller.querySelector(`.ml-item[data-uid="${uid}"]`);
  }

  paintSelection() {
    for (const el of this.scroller.querySelectorAll('.ml-item')) {
      const uid = Number(el.dataset.uid);
      const on = this.selected.has(uid);
      el.classList.toggle('selected', on);
      el.setAttribute('aria-selected', String(on));
      el.classList.toggle('focused', uid === this.focusUid);
      const cb = el.querySelector('.ml-check input');
      if (cb) cb.checked = on;
    }
    this.el.classList.toggle('multi', this.selected.size > 1 || this.selectMode);
  }

  // Language switched: header buttons, then the rows (their signature includes the language).
  relocalize() {
    const t = (k, v) => this.t(k, v);
    const label = (el, key, tip = t(key)) => {
      el.setAttribute('aria-label', t(key));
      el.dataset.tip = tip;
    };
    label(this.filterBtn, 'list.filter');
    label(this.selectBtn, 'list.selectMode');
    label(this.refreshBtn, 'list.refresh', `${t('list.refresh')} (F5)`);
    label(this.navBtn, 'nav.toggle');
    this.scroller.setAttribute('aria-label', t('list.label'));
    if (this.loading && !this.messages.length && !this.error) return; // skeleton: nothing to translate
    this.render();
  }

  // ------------------------------------------------------------ rendering
  setHeader(title, special) {
    this.titleEl.textContent = title;
    this.el.dataset.special = special || '';
  }

  updateCount() {
    const t = (k, v) => this.t(k, v);
    // The Filter button shows whether a filter is active (cleared by "Clear", account switches…).
    this.filterBtn.classList.toggle('on', !!this.app.filter);
    this.filterBtn.setAttribute('aria-pressed', String(!!this.app.filter));
    const unread = this.messages.filter((m) => !m.seen).length;
    const q = this.query;
    if (q.search) this.countEl.textContent = t('list.results', { count: this.total });
    else this.countEl.textContent = this.total ? t('list.count', { count: this.total }) + (unread ? ` · ${t('list.unreadCount', { count: unread })}` : '') : '';
  }

  renderSkeleton() {
    const { h, ui } = this.ctx;
    this.rowCache = null;
    ui.clear(this.scroller);
    ui.clear(this.banner);
    for (let i = 0; i < 8; i++) {
      this.scroller.appendChild(h('div', { class: 'ml-item skeleton', 'aria-hidden': 'true' }, h('span', { class: 'sk sk-avatar' }), h('div', { class: 'ml-item-main' }, h('span', { class: 'sk sk-line w60' }), h('span', { class: 'sk sk-line w80' }), h('span', { class: 'sk sk-line w40' }))));
    }
  }

  showBanner(e) {
    const { h, icon, ui } = this.ctx;
    ui.clear(this.banner);
    if (!e) return;
    // The "offline" bar above already explains connection problems.
    if (['ECONN', 'ETIMEOUT'].includes(e.code) && this.app.offline && !this.app.offline.hidden) return;
    const info = errorText(this.ctx.t, e, this.app.account?.imap?.host);
    this.banner.appendChild(
      h(
        'div',
        { class: 'infobar error ml-banner' },
        icon('error_circle', { filled: true }),
        h('div', { class: 'grow' }, h('div', null, info.text), info.detail ? h('div', { class: 'caption text-2 ellipsis' }, info.detail) : null),
        h('button', { class: 'btn small', onclick: () => this.app.refresh() }, this.t('list.retry')),
        h('button', { class: 'btn subtle icon-btn small', 'aria-label': this.t('common.close'), onclick: () => ui.clear(this.banner) }, icon('dismiss', { size: 12 })),
      ),
    );
  }

  render() {
    const { h, icon, ui } = this.ctx;
    const t = (k, v) => this.t(k, v);
    const top = this.scroller.scrollTop;
    ui.clear(this.banner);
    this.updateCount();
    const q = this.query;
    // Search banner
    ui.clear(this.searchBanner);
    this.searchBanner.hidden = !q.search && !q.filter;
    if (!this.searchBanner.hidden) {
      const label = q.search ? t('list.searchFor', { q: q.search }) : t(`list.filter.${q.filter}`);
      this.searchBanner.append(icon(q.search ? 'search' : 'filter', { size: 14 }), h('span', { class: 'grow ellipsis' }, label), h('button', { class: 'btn subtle small', name: 'clear-search', onclick: () => this.app.clearSearch() }, t('list.clearSearch')));
    }
    if (this.error && !this.messages.length) {
      const info = errorText(this.ctx.t, this.error, this.app.account?.imap?.host);
      this.rowCache = null;
      ui.clear(this.scroller);
      this.scroller.appendChild(
        h(
          'div',
          { class: 'empty ml-list-empty' },
          icon('cloud_dismiss', { size: 40 }),
          h('div', { class: 'body-strong' }, t('list.loadFailed')),
          h('div', { class: 'caption' }, info.text),
          info.detail ? h('div', { class: 'caption text-3 selectable' }, info.detail) : null,
          h('button', { class: 'btn', onclick: () => this.app.refresh() }, t('list.retry')),
          this.error.code === 'EAUTH' ? h('button', { class: 'btn subtle', onclick: () => this.app.editAccount(this.app.account) }, t('list.fixAccount')) : null,
        ),
      );
      return;
    }
    if (!this.messages.length) {
      const special = this.app.folderSpecial();
      this.rowCache = null;
      ui.clear(this.scroller);
      this.scroller.appendChild(
        h(
          'div',
          { class: 'empty ml-list-empty' },
          icon(q.search ? 'search' : special === 'inbox' ? 'mail_inbox_checkmark' : 'mail_read', { size: 44 }),
          h('div', { class: 'body-strong' }, q.search ? t('list.noResults') : q.filter ? t('list.noFiltered') : special === 'inbox' ? t('list.inboxZero') : t('list.emptyFolder')),
          h('div', { class: 'caption' }, q.search ? t('list.noResultsHint') : special === 'inbox' && !q.filter ? t('list.inboxZeroHint') : ''),
        ),
      );
      return;
    }
    // Keyed rendering: rows whose data did not change are reused as-is, so a refresh never
    // swallows a click in progress or flickers.
    const special = this.app.folderSpecial();
    const showTo = special === 'sent' || special === 'drafts';
    const cache = this.rowCache || new Map();
    const next = new Map();
    const nodes = [];
    let group = null;
    for (const m of this.messages) {
      const g = dateGroup(m.received || m.date); // grouped and sorted by received time, like Outlook
      if (g !== group) {
        group = g;
        nodes.push(h('div', { class: 'ml-group', role: 'presentation' }, t(`group.${g}`)));
      }
      const sig = this.rowSig(m, showTo);
      let el = cache.get(m.uid);
      if (!el || el._sig !== sig) {
        el = this.row(m, showTo);
        el._sig = sig;
      }
      next.set(m.uid, el);
      nodes.push(el);
    }
    this.rowCache = next;
    nodes.push(this.footer());
    this.scroller.replaceChildren(...nodes);
    this.scroller.scrollTop = top;
    this.paintSelection();
  }

  rowSig(m, showTo) {
    return JSON.stringify([m.uid, m.seen, m.flagged, m.answered, m.forwarded, m.draft, m.hasAttachments, m.subject, m.preview, m.date, m.received, showTo ? m.to : m.from, this.ctx.lang]);
  }

  // Same rows as on screen? (soft refreshes that bring nothing new skip the DOM entirely)
  sameAsRendered(list) {
    const special = this.app.folderSpecial();
    const showTo = special === 'sent' || special === 'drafts';
    if (!this.rowCache || this.rowCache.size !== list.length) return false;
    const keys = [...this.rowCache.keys()];
    return list.every((m, i) => keys[i] === m.uid && this.rowCache.get(m.uid)._sig === this.rowSig(m, showTo));
  }

  row(m, showTo) {
    const { h, icon } = this.ctx;
    const t = (k, v) => this.t(k, v);
    const people = showTo ? m.to || [] : m.from || [];
    const p = people[0] || { name: '', address: '' };
    const who = showTo ? (people.length ? people.map(displayName).join('; ') : t('list.noRecipients')) : displayName(p) || t('reader.unknownSender');
    const quick = (name, ic, label, fn, filled) =>
      h(
        'button',
        {
          class: 'btn subtle icon-btn ml-qa',
          name,
          tabindex: '-1',
          'aria-label': label,
          'data-tip': label,
          onclick: (e) => {
            e.stopPropagation();
            fn();
          },
        },
        icon(ic, { size: 16, filled }),
      );
    const check = h('input', { type: 'checkbox', tabindex: '-1', 'aria-label': t('list.selectItem') });
    const el = h(
      'div',
      {
        class: ['ml-item', !m.seen && 'unread', m.flagged && 'flagged'],
        role: 'option',
        'aria-selected': 'false',
        draggable: 'true',
        dataset: { uid: String(m.uid) },
      },
      h(
        'div',
        { class: 'ml-item-left' },
        h('span', { class: 'ml-avatar', style: { background: avatarColor(p.address || p.name || who) } }, initials(p.name, p.address)),
        h(
          'label',
          {
            class: 'ml-check checkbox',
            onclick: (e) => {
              e.stopPropagation();
              e.preventDefault();
              this.select(m.uid, { additive: true, open: false });
            },
          },
          check,
        ),
      ),
      h(
        'div',
        { class: 'ml-item-main' },
        h('div', { class: 'ml-row1' }, h('span', { class: 'ml-from ellipsis' }, m.draft ? h('span', { class: 'ml-draft-tag' }, `[${t('list.draft')}] `) : null, who), h('span', { class: 'ml-date' }, listDate(m.received || m.date, this.ctx.i18n))),
        h(
          'div',
          { class: 'ml-row2' },
          h('span', { class: 'ml-subj ellipsis' }, m.subject || t('list.noSubject')),
          h(
            'span',
            { class: 'ml-icons' },
            m.answered ? icon('arrow_reply', { size: 14, class: 'ml-ic-replied' }) : null,
            m.forwarded ? icon('arrow_forward', { size: 14, class: 'ml-ic-replied' }) : null,
            m.hasAttachments ? icon('attach', { size: 14, class: 'ml-ic-attach' }) : null,
            m.flagged ? icon('flag', { size: 14, filled: true, class: 'ml-ic-flag' }) : null,
          ),
        ),
        h('div', { class: 'ml-row3 ellipsis' }, m.preview || ''),
      ),
      h(
        'div',
        { class: 'ml-quick' },
        quick('qa-read', m.seen ? 'mail_unread' : 'mail_read', m.seen ? t('act.markUnread') : t('act.markRead'), () => this.app.setFlags([m.uid], { seen: !m.seen })),
        quick('qa-flag', m.flagged ? 'flag_off' : 'flag', m.flagged ? t('act.unflag') : t('act.flag'), () => this.app.setFlags([m.uid], { flagged: !m.flagged })),
        quick('qa-delete', 'delete', t('act.delete'), () => this.app.deleteMessages([m.uid])),
      ),
    );
    el.addEventListener('click', (e) => {
      if (e.shiftKey) this.select(m.uid, { range: true, additive: e.ctrlKey, open: false });
      else if (e.ctrlKey || e.metaKey || this.selectMode) this.select(m.uid, { additive: true, open: false });
      else this.select(m.uid, { open: true });
      this.scroller.focus({ preventScroll: true });
    });
    el.addEventListener('dblclick', () => this.app.openStandalone?.(m));
    el.addEventListener('contextmenu', (e) => {
      if (!this.selected.has(m.uid)) this.select(m.uid, { open: true });
      this.app.contextMenu(e);
    });
    el.addEventListener('dragstart', (e) => {
      if (!this.selected.has(m.uid)) this.select(m.uid, { open: false });
      const uids = this.selectedUids;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData(DRAG_MIME, JSON.stringify({ accountId: this.app.account.id, folder: this.app.folder, uids }));
      e.dataTransfer.setData('text/plain', uids.length > 1 ? t('list.dragMany', { count: uids.length }) : m.subject || '');
      const ghost = h('div', { class: 'app-mail ml-drag-ghost' }, icon('mail', { size: 16 }), h('span', null, uids.length > 1 ? t('list.dragMany', { count: uids.length }) : m.subject || t('list.noSubject')));
      document.body.appendChild(ghost);
      try {
        e.dataTransfer.setDragImage(ghost, 12, 12);
      } catch {}
      setTimeout(() => ghost.remove(), 0);
      this.app.dragging = true;
    });
    el.addEventListener('dragend', () => (this.app.dragging = false));
    return el;
  }

  footer() {
    const { h } = this.ctx;
    this.footerEl = h('div', { class: 'ml-list-foot' });
    this.renderFooter();
    return this.footerEl;
  }

  renderFooter() {
    const f = this.footerEl;
    if (!f) return;
    const { h, ui } = this.ctx;
    const t = (k, v) => this.t(k, v);
    ui.clear(f);
    if (this.loading && this.messages.length) f.appendChild(h('div', { class: 'spinner small' }));
    else if (this.hasMore) f.appendChild(h('button', { class: 'btn', name: 'load-more', onclick: () => this.loadMore() }, t('list.loadMore')));
    else if (this.messages.length > 8) f.appendChild(h('span', { class: 'caption text-3' }, t('list.end')));
  }

  // ------------------------------------------------------------ keyboard
  onKey(e) {
    const list = this.messages;
    if (!list.length) return;
    const idx = Math.max(0, list.findIndex((m) => m.uid === this.focusUid));
    const go = (i) => {
      const m = list[Math.max(0, Math.min(list.length - 1, i))];
      if (!m) return;
      if (e.shiftKey) this.select(m.uid, { range: true, open: false });
      else if (e.ctrlKey) this.setFocus(m.uid);
      else this.select(m.uid, { open: true });
      this.setFocus(m.uid);
    };
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        go(this.focusUid == null ? 0 : idx + 1);
        if (idx >= list.length - 3) this.loadMore();
        break;
      case 'ArrowUp':
        e.preventDefault();
        go(idx - 1);
        break;
      case 'Home':
        e.preventDefault();
        go(0);
        break;
      case 'End':
        e.preventDefault();
        go(list.length - 1);
        break;
      case 'PageDown':
        e.preventDefault();
        go(idx + 8);
        break;
      case 'PageUp':
        e.preventDefault();
        go(idx - 8);
        break;
      case ' ':
        if (this.focusUid != null) {
          e.preventDefault();
          this.select(this.focusUid, { additive: true, open: false });
        }
        break;
      case 'Enter':
        if (this.focusUid != null) {
          e.preventDefault();
          this.select(this.focusUid, { open: true });
          this.app.focusReader?.();
        }
        break;
      case 'a':
      case 'A':
        if (e.ctrlKey) {
          e.preventDefault();
          this.selectAll();
        }
        break;
      case 'ContextMenu':
        e.preventDefault();
        if (this.focusUid != null) {
          const r = this.rowEl(this.focusUid)?.getBoundingClientRect();
          this.app.contextMenu(r ? { x: r.left + 40, y: r.bottom - 8 } : null);
        }
        break;
      default:
    }
  }

  async filterMenu(e) {
    const { ui } = this.ctx;
    const t = (k, v) => this.t(k, v);
    const cur = this.app.filter || '';
    await ui.menu(e, [
      { label: t('list.filter.all'), checked: cur === '', action: () => this.app.setFilter('') },
      { label: t('list.filter.unread'), checked: cur === 'unread', action: () => this.app.setFilter('unread') },
      { label: t('list.filter.flagged'), checked: cur === 'flagged', action: () => this.app.setFilter('flagged') },
    ]);
  }
}
