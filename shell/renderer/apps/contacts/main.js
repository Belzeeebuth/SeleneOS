// Contacts — Windows 11 People-style address book.
//   Left: search, A–Z grouped list with a Favourites group. Right: details (Send e-mail, favourite, edit, export,
//   delete with confirmation) or the edit form (name, e-mails, phones, address, birthday, company, notes, photo).
//   vCard 3.0 / 4.0 import and export (several contacts per .vcf). Backend: main/ipc/contacts.js.
//   Launch arguments: { file: '/a.vcf' } imports a file; { contactId } selects a contact.
//   Keyboard: Ctrl+N new, Ctrl+F search, Ctrl+E edit, Ctrl+S save, Esc cancel, arrows / Home / End in the list,
//   Delete deletes the selected contact.

const TYPES = ['home', 'work', 'mobile', 'other'];
const IMG_EXT = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'];
const COLORS = ['#0f6cbd', '#c239b3', '#038387', '#8764b8', '#ca5010', '#498205', '#d13438', '#4f6bed', '#986f0b', '#00727c'];

const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const text = (v) => (v == null ? '' : String(v));

export function groupLetter(name) {
  const c = fold(name).trim().charAt(0).toUpperCase();
  return /[A-Z]/.test(c) ? c : '#';
}
export function initialsOf(name) {
  const p = text(name).trim().split(/\s+/).filter(Boolean);
  if (!p.length) return '?';
  return ((p[0][0] || '') + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase();
}
function colorOf(s) {
  let h = 0;
  for (const ch of text(s)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}
function matches(c, q) {
  if (!q) return true;
  const hay = fold([c.name, c.company, c.notes, ...c.emails.map((e) => e.value), ...c.phones.map((p) => p.value)].join(' '));
  return q.split(/\s+/).every((w) => hay.includes(w) || hay.replace(/[\s.()-]/g, '').includes(w));
}

class ContactsApp {
  constructor(ctx) {
    this.ctx = ctx;
    this.contacts = [];
    this.query = '';
    this.selectedId = null;
    this.mode = 'view'; // 'view' | 'edit' | 'new'
    this.draft = null;
    this.draftOrig = '';
    this.statusTimer = 0;
    const { h, win } = ctx;
    this.root = h('div', { class: 'ct' });
    win.body.appendChild(this.root);
    this.build();
  }

  t(k, v) {
    return this.ctx.t(k, v);
  }

  // ------------------------------------------------------------ layout
  build() {
    const { h, icon } = this.ctx;
    const ui = this.ctx.ui;
    ui.clear(this.root);
    this.search = h('input', {
      class: 'input ct-search',
      type: 'search',
      placeholder: this.t('search'),
      'aria-label': this.t('search'),
      value: this.query,
      oninput: () => {
        this.query = this.search.value;
        this.renderList();
      },
      onkeydown: (e) => {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          this.moveSel(0, true);
        } else if (e.key === 'Escape' && this.search.value) {
          e.preventDefault();
          e.stopPropagation();
          this.search.value = '';
          this.query = '';
          this.renderList();
        }
      },
    });
    this.newBtn = h('button', { class: 'btn primary ct-new', type: 'button', title: this.t('new'), 'aria-label': this.t('new'), onclick: () => this.startNew() }, icon('person_add'));
    this.moreBtn = h('button', { class: 'btn subtle ct-more', type: 'button', title: this.t('more'), 'aria-label': this.t('more'), 'aria-haspopup': 'menu', onclick: (e) => this.moreMenu(e) }, icon('more_horizontal'));
    this.list = h('div', { class: 'ct-list', role: 'listbox', tabindex: '-1', 'aria-label': this.t('list'), onkeydown: (e) => this.listKey(e) });
    this.count = h('div', { class: 'ct-count caption text-2', 'aria-live': 'polite' });
    this.side = h('div', { class: 'ct-side' }, h('div', { class: 'ct-bar' }, this.search, this.newBtn, this.moreBtn), this.list, this.count);
    this.main = h('div', { class: 'ct-main' });
    this.status = h('div', { class: 'ct-status', role: 'status', 'aria-live': 'polite', hidden: true });
    this.root.append(this.side, this.main, this.status);
    this.renderList();
    this.renderMain();
  }

  async init() {
    const { api, win } = this.ctx;
    await this.reload();
    this.unsub = api.on('contacts:changed', () => this.reload());
    this.ctx.onClose?.(() => this.unsub?.());
    this.ctx.onLangChange?.(() => this.build());
    win.body.addEventListener('keydown', (e) => this.globalKey(e));
    this.ro = new ResizeObserver(() => this.root.classList.toggle('narrow', this.root.clientWidth < 640));
    this.ro.observe(this.root);
    this.ctx.onClose?.(() => this.ro.disconnect());
    win.onBeforeClose(() => this.confirmDiscard());
  }

  async reload() {
    try {
      this.contacts = await this.ctx.api.invoke('contacts:list');
    } catch {
      this.contacts = [];
    }
    if (this.selectedId && !this.byId(this.selectedId) && this.mode !== 'new') {
      this.selectedId = null;
      this.mode = 'view';
    }
    this.renderList();
    if (this.mode === 'view') this.renderMain();
  }

  byId(id) {
    return this.contacts.find((c) => c.id === id) || null;
  }

  visible() {
    const q = fold(this.query).trim();
    return this.contacts.filter((c) => matches(c, q));
  }

  // Rows in display order: favourites first (no search), then A–Z.
  ordered() {
    const vis = this.visible();
    const groups = [];
    if (!this.query.trim()) {
      const fav = vis.filter((c) => c.favorite);
      if (fav.length) groups.push({ key: 'fav', label: this.t('favorites'), items: fav });
    }
    const letters = new Map();
    for (const c of vis) {
      const L = groupLetter(c.name);
      if (!letters.has(L)) letters.set(L, []);
      letters.get(L).push(c);
    }
    const keys = [...letters.keys()].sort((a, b) => (a === '#' ? 1 : b === '#' ? -1 : a.localeCompare(b)));
    for (const k of keys) groups.push({ key: k, label: k, items: letters.get(k) });
    return groups;
  }

  avatar(c, size = 32) {
    const { h } = this.ctx;
    const el = h('span', { class: 'ct-avatar', 'aria-hidden': 'true', style: { width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.4)}px` } });
    if (c.photo) el.append(h('img', { src: c.photo, alt: '', draggable: false }));
    else {
      el.style.background = colorOf(c.name || c.id);
      el.textContent = initialsOf(c.name);
    }
    return el;
  }

  renderList() {
    const { h, icon, ui } = this.ctx;
    ui.clear(this.list);
    const groups = this.ordered();
    const total = this.visible().length;
    for (const g of groups) {
      this.list.append(h('div', { class: 'ct-group', role: 'presentation', dataset: { group: g.key } }, g.key === 'fav' ? icon('star', { filled: true, size: 14 }) : '', g.label));
      for (const c of g.items) {
        const sel = c.id === this.selectedId;
        const sub = c.company || c.emails[0]?.value || c.phones[0]?.value || '';
        const row = h(
          'div',
          {
            class: ['ct-row', sel && 'selected'],
            role: 'option',
            tabindex: '-1',
            'aria-selected': String(sel),
            dataset: { id: c.id, group: g.key },
            onclick: () => this.select(c.id, { focusRow: true }),
            oncontextmenu: (e) => this.rowMenu(e, c),
          },
          this.avatar(c, 32),
          h('span', { class: 'ct-row-text' }, h('span', { class: 'ct-row-name ellipsis' }, c.name || this.t('unnamed')), sub ? h('span', { class: 'ct-row-sub caption text-2 ellipsis' }, sub) : ''),
          c.favorite && g.key !== 'fav' ? h('span', { class: 'ct-row-star', title: this.t('favorites') }, icon('star', { filled: true, size: 12 })) : '',
        );
        this.list.append(row);
      }
    }
    // Exactly one tab stop in the list.
    const rows = [...this.list.querySelectorAll('.ct-row')];
    const tab = rows.find((r) => r.classList.contains('selected')) || rows[0];
    if (tab) tab.tabIndex = 0;
    if (!total) {
      this.list.append(
        h('div', { class: 'empty ct-list-empty' }, this.query.trim() ? this.t('noResults', { q: this.query.trim() }) : this.t('emptyTitle')),
      );
    }
    this.count.textContent = this.t('count', { count: this.contacts.length });
  }

  rowsEls() {
    return [...this.list.querySelectorAll('.ct-row')];
  }

  moveSel(delta, fromSearch) {
    const rows = this.rowsEls();
    if (!rows.length) return;
    const cur = rows.findIndex((r) => r === document.activeElement);
    let i;
    if (fromSearch || cur < 0) i = Math.max(0, rows.findIndex((r) => r.classList.contains('selected')));
    else if (delta === 'home') i = 0;
    else if (delta === 'end') i = rows.length - 1;
    else i = Math.min(rows.length - 1, Math.max(0, cur + delta));
    this.select(rows[i].dataset.id, { focusRow: true, index: i });
  }

  listKey(e) {
    if (e.target.closest?.('.ct-row') == null) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      this.moveSel(e.key === 'ArrowDown' ? 1 : -1);
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      this.moveSel(e.key === 'Home' ? 'home' : 'end');
    } else if (e.key === 'Enter') {
      e.preventDefault();
      this.startEdit();
    } else if (e.key === 'Delete') {
      e.preventDefault();
      this.remove();
    } else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      e.preventDefault();
      const c = this.byId(e.target.dataset.id);
      if (c) this.rowMenu(e.target, c);
    }
  }

  globalKey(e) {
    if (e.defaultPrevented || e.target.closest?.('.dialog-layer, .menu')) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && k === 'n') {
      e.preventDefault();
      this.startNew();
    } else if (mod && k === 'f') {
      e.preventDefault();
      this.search.focus();
      this.search.select();
    } else if (mod && k === 'e' && this.mode === 'view' && this.selectedId) {
      e.preventDefault();
      this.startEdit();
    } else if (mod && k === 's' && this.mode !== 'view') {
      e.preventDefault();
      this.save();
    } else if (e.key === 'Escape' && this.mode !== 'view' && !document.querySelector('.menu, .dialog-layer:not(.closing)')) {
      e.preventDefault();
      this.cancelEdit();
    }
  }

  async select(id, { focusRow, index } = {}) {
    if (id === this.selectedId && this.mode === 'view') {
      if (focusRow) this.focusRow(id, index);
      return;
    }
    if (!(await this.confirmDiscard())) return;
    this.selectedId = id;
    this.mode = 'view';
    this.draft = null;
    for (const r of this.rowsEls()) {
      const on = r.dataset.id === id;
      r.classList.toggle('selected', on);
      r.setAttribute('aria-selected', String(on));
      r.tabIndex = on ? 0 : -1;
    }
    this.root.classList.add('show-detail');
    this.renderMain();
    if (focusRow) this.focusRow(id, index);
  }

  focusRow(id, index) {
    const rows = this.rowsEls();
    const row = (index != null && rows[index]?.dataset.id === id ? rows[index] : null) || rows.find((r) => r.dataset.id === id);
    if (!row) return;
    for (const r of rows) r.tabIndex = r === row ? 0 : -1;
    row.focus();
    row.scrollIntoView({ block: 'nearest' });
  }

  // ------------------------------------------------------------ detail
  renderMain() {
    const { h, icon, ui } = this.ctx;
    ui.clear(this.main);
    if (this.mode !== 'view') return this.renderForm();
    const c = this.byId(this.selectedId);
    if (!c) {
      const none = !this.contacts.length;
      this.main.append(
        h(
          'div',
          { class: 'empty ct-empty' },
          icon('book_contacts'),
          h('div', { class: 'subtitle' }, none ? this.t('emptyTitle') : this.t('selectTitle')),
          h('div', { class: 'text-2' }, none ? this.t('emptyBody') : this.t('selectBody')),
          none
            ? h(
                'div',
                { class: 'ct-empty-actions' },
                h('button', { class: 'btn primary', type: 'button', onclick: () => this.startNew() }, icon('person_add'), this.t('new')),
                h('button', { class: 'btn', type: 'button', onclick: () => this.importPick() }, icon('arrow_import'), this.t('import')),
              )
            : '',
        ),
      );
      return;
    }
    const firstMail = c.emails[0]?.value;
    const back = h('button', { class: 'btn subtle ct-back', type: 'button', 'aria-label': this.t('list'), title: this.t('list'), onclick: () => this.back() }, icon('arrow_left'));
    const head = h(
      'div',
      { class: 'ct-head' },
      back,
      this.avatar(c, 72),
      h('div', { class: 'ct-head-text' }, h('h1', { class: 'ct-name' }, c.name || this.t('unnamed')), c.company ? h('div', { class: 'text-2 ct-company' }, c.company) : ''),
    );
    const favLabel = c.favorite ? this.t('unfavorite') : this.t('favorite');
    const actions = h(
      'div',
      { class: 'ct-actions' },
      h('button', { class: 'btn primary ct-mail', type: 'button', disabled: !firstMail, onclick: () => this.sendMail(c, firstMail) }, icon('mail'), this.t('sendMail')),
      h('button', { class: ['btn', 'ct-fav', c.favorite && 'on'], type: 'button', 'aria-pressed': String(!!c.favorite), title: favLabel, 'aria-label': favLabel, onclick: () => this.toggleFav(c) }, icon('star', { filled: !!c.favorite })),
      h('button', { class: 'btn ct-edit', type: 'button', onclick: () => this.startEdit() }, icon('edit'), this.t('edit')),
      h('button', { class: 'btn ct-export', type: 'button', title: this.t('exportOne'), 'aria-label': this.t('exportOne'), onclick: () => this.exportPick([c.id], '3.0', c.name) }, icon('arrow_export')),
      h('button', { class: 'btn ct-delete', type: 'button', title: this.t('delete'), 'aria-label': this.t('delete'), onclick: () => this.remove() }, icon('delete')),
    );
    const rows = [];
    const field = (ic, label, value, extra) => h('div', { class: 'ct-field' }, icon(ic), h('div', { class: 'ct-field-body' }, h('div', { class: 'caption text-2' }, label), value), extra || '');
    for (const e of c.emails) {
      rows.push(field('mail', `${this.t('emails')} · ${this.t(`type.${e.type}`)}`, h('button', { class: 'ct-link', type: 'button', onclick: () => this.sendMail(c, e.value) }, e.value)));
    }
    for (const p of c.phones) rows.push(field('call', `${this.t('phones')} · ${this.t(`type.${p.type}`)}`, h('span', { class: 'ct-value', 'data-copy': p.value }, p.value)));
    if (c.address) rows.push(field('location', this.t('address'), h('span', { class: 'ct-value ct-pre' }, c.address)));
    if (c.birthday) rows.push(field('gift', this.t('birthday'), h('span', { class: 'ct-value' }, this.fmtBirthday(c.birthday))));
    if (c.notes) rows.push(field('note', this.t('notes'), h('span', { class: 'ct-value ct-pre' }, c.notes)));
    this.main.append(h('div', { class: 'ct-detail', dataset: { id: c.id } }, head, actions, h('div', { class: 'card ct-card' }, ...rows)));
  }

  fmtBirthday(b) {
    const m = /^(\d{4}|-)-?(\d{2})-(\d{2})$/.exec(b);
    if (!m) return b;
    const year = m[1] === '-' ? 2000 : Number(m[1]);
    const d = new Date(year, Number(m[2]) - 1, Number(m[3]));
    const opts = m[1] === '-' ? { day: 'numeric', month: 'long' } : { day: 'numeric', month: 'long', year: 'numeric' };
    try {
      return d.toLocaleDateString(this.ctx.lang === 'fr' ? 'fr-FR' : 'en-US', opts);
    } catch {
      return b;
    }
  }

  back() {
    this.root.classList.remove('show-detail');
    if (this.selectedId) this.focusRow(this.selectedId);
  }

  sendMail(c, address) {
    if (!address) return;
    const name = text(c.name).replace(/["<>]/g, '');
    this.ctx.shell.launch('mail', { to: name ? `"${name}" <${address}>` : address });
  }

  async toggleFav(c) {
    try {
      await this.ctx.api.invoke('contacts:setFavorite', c.id, !c.favorite);
      await this.reload();
      this.main.querySelector('.ct-fav')?.focus();
    } catch (err) {
      this.flash(this.t('saveFailed', { msg: err.message }), true);
    }
  }

  async rowMenu(e, c) {
    await this.select(c.id);
    const items = [
      { label: this.t('sendMail'), icon: 'mail', disabled: !c.emails.length, action: () => this.sendMail(c, c.emails[0]?.value) },
      { label: c.favorite ? this.t('unfavorite') : this.t('favorite'), icon: 'star', action: () => this.toggleFav(c) },
      { label: this.t('edit'), icon: 'edit', action: () => this.startEdit() },
      { label: this.t('exportOne'), icon: 'arrow_export', action: () => this.exportPick([c.id], '3.0', c.name) },
      '-',
      { label: this.t('delete'), icon: 'delete', action: () => this.remove() },
    ];
    await this.ctx.ui.menu(e, items);
  }

  async moreMenu(e) {
    await this.ctx.ui.menu(e.currentTarget || e, [
      { label: this.t('import'), icon: 'arrow_import', action: () => this.importPick() },
      { label: this.t('exportAll'), icon: 'arrow_export', disabled: !this.contacts.length, action: () => this.exportPick(null, '3.0') },
      { label: this.t('exportAll4'), icon: 'arrow_export', disabled: !this.contacts.length, action: () => this.exportPick(null, '4.0') },
    ]);
  }

  // ------------------------------------------------------------ edit form
  async startNew() {
    if (!(await this.confirmDiscard())) return;
    this.mode = 'new';
    this.draft = { first: '', last: '', company: '', emails: [{ type: 'home', value: '' }], phones: [{ type: 'mobile', value: '' }], address: '', birthday: '', notes: '', photo: '', favorite: false };
    this.draftOrig = JSON.stringify(this.draft);
    this.root.classList.add('show-detail');
    this.renderMain();
    this.main.querySelector('input[name="first"]')?.focus();
  }

  startEdit() {
    const c = this.byId(this.selectedId);
    if (!c) return;
    this.mode = 'edit';
    let { first, last } = c;
    // A display name that is really an e-mail, a phone number or the company is not split into first/last names.
    const derived = c.name === c.company || c.emails.some((e) => e.value === c.name) || c.phones.some((p) => p.value === c.name);
    if (!first && !last && c.name && !derived) {
      const p = c.name.split(/\s+/);
      last = p.length > 1 ? p.pop() : '';
      first = p.join(' ');
    }
    this.draftNames = { first: (first || '').trim(), last: (last || '').trim() };
    this.draft = JSON.parse(JSON.stringify({ ...c, first, last }));
    if (!this.draft.emails.length) this.draft.emails.push({ type: 'home', value: '' });
    if (!this.draft.phones.length) this.draft.phones.push({ type: 'mobile', value: '' });
    this.draftOrig = JSON.stringify(this.draft);
    this.root.classList.add('show-detail');
    this.renderMain();
    this.main.querySelector('input[name="first"]')?.focus();
  }

  dirty() {
    return this.mode !== 'view' && this.draft && JSON.stringify(this.draft) !== this.draftOrig;
  }

  async confirmDiscard() {
    if (!this.dirty()) return true;
    const ok = await this.ctx.ui.confirm(this.t('discardBody'), { title: this.t('discardTitle'), okLabel: this.t('discard'), danger: true, parent: this.ctx.win });
    if (ok) {
      this.mode = 'view';
      this.draft = null;
    }
    return ok;
  }

  async cancelEdit() {
    if (!(await this.confirmDiscard())) return;
    const wasNew = this.mode === 'new';
    this.mode = 'view';
    this.draft = null;
    if (wasNew && !this.selectedId) this.root.classList.remove('show-detail');
    this.renderMain();
    if (this.selectedId) this.focusRow(this.selectedId);
    else this.newBtn.focus();
  }

  renderForm() {
    const { h, icon } = this.ctx;
    const d = this.draft;
    const input = (name, label, attrs = {}) =>
      h('label', { class: 'ct-input' }, h('span', { class: 'caption text-2' }, label), h('input', { class: 'input', name, value: text(d[name]), oninput: (e) => (d[name] = e.target.value), ...attrs }));
    const area = (name, label) =>
      h('label', { class: 'ct-input ct-wide' }, h('span', { class: 'caption text-2' }, label), h('textarea', { class: 'input', name, rows: 3, oninput: (e) => (d[name] = e.target.value) }, text(d[name])));
    const multi = (key, label, addLabel, inputType) => {
      const box = h('div', { class: 'ct-multi ct-wide', dataset: { key } });
      const draw = () => {
        this.ctx.ui.clear(box);
        box.append(h('div', { class: 'caption text-2' }, label));
        d[key].forEach((it, i) => {
          const sel = h(
            'select',
            { class: 'select ct-type', 'aria-label': `${label} ${i + 1}`, onchange: (e) => (it.type = e.target.value) },
            ...TYPES.filter((ty) => key === 'phones' || ty !== 'mobile').map((ty) => h('option', { value: ty, selected: it.type === ty }, this.t(`type.${ty}`))),
          );
          box.append(
            h(
              'div',
              { class: 'ct-multi-row' },
              sel,
              h('input', { class: 'input grow', type: inputType, name: `${key}-${i}`, 'aria-label': `${label} ${i + 1}`, value: it.value, oninput: (e) => (it.value = e.target.value) }),
              h('button', { class: 'btn subtle ct-remove', type: 'button', title: this.t('remove'), 'aria-label': this.t('remove'), onclick: () => (d[key].splice(i, 1), draw(), box.querySelector('.ct-add')?.focus()) }, icon('dismiss')),
            ),
          );
        });
        box.append(
          h(
            'button',
            {
              class: 'btn subtle ct-add',
              type: 'button',
              onclick: () => {
                d[key].push({ type: key === 'phones' ? 'mobile' : 'home', value: '' });
                draw();
                box.querySelector(`input[name="${key}-${d[key].length - 1}"]`)?.focus();
              },
            },
            icon('add'),
            addLabel,
          ),
        );
      };
      draw();
      return box;
    };
    const photoBox = h('div', { class: 'ct-photo' });
    const drawPhoto = () => {
      this.ctx.ui.clear(photoBox);
      photoBox.append(
        this.avatar({ ...d, name: [d.first, d.last].filter(Boolean).join(' ') || d.company || '' }, 72),
        h(
          'div',
          { class: 'ct-photo-btns' },
          h('button', { class: 'btn ct-photo-pick', type: 'button', onclick: () => this.pickPhoto(drawPhoto) }, icon('image'), d.photo ? this.t('changePhoto') : this.t('addPhoto')),
          d.photo ? h('button', { class: 'btn subtle ct-photo-remove', type: 'button', onclick: () => ((d.photo = ''), drawPhoto()) }, this.t('removePhoto')) : '',
        ),
      );
    };
    drawPhoto();
    const form = h(
      'form',
      {
        class: 'ct-form',
        onsubmit: (e) => {
          e.preventDefault();
          this.save();
        },
      },
      h('h1', { class: 'ct-form-title' }, this.mode === 'new' ? this.t('newTitle') : this.t('editTitle')),
      photoBox,
      h('div', { class: 'ct-grid' }, input('first', this.t('first'), { autocomplete: 'off' }), input('last', this.t('last'), { autocomplete: 'off' }), input('company', this.t('company')), input('birthday', this.t('birthday'), { type: 'date', value: /^\d{4}-/.test(d.birthday) ? d.birthday : '' }), multi('emails', this.t('emails'), this.t('addEmail'), 'email'), multi('phones', this.t('phones'), this.t('addPhone'), 'tel'), area('address', this.t('address')), area('notes', this.t('notes'))),
      h('div', { class: 'ct-form-error', role: 'alert', hidden: true }),
      h('div', { class: 'ct-form-foot' }, h('button', { class: 'btn primary ct-save', type: 'submit' }, this.ctx.t('common.save')), h('button', { class: 'btn ct-cancel', type: 'button', onclick: () => this.cancelEdit() }, this.ctx.t('common.cancel'))),
    );
    this.main.append(form);
  }

  async pickPhoto(redraw) {
    const { ui, api, win } = this.ctx;
    const file = await ui.filePicker({ mode: 'open', title: this.t('photo'), filters: [{ name: this.t('pictures'), ext: IMG_EXT }], parent: win });
    if (!file || win.closed) return;
    try {
      this.draft.photo = await api.invoke('contacts:photo', file);
      redraw();
      this.main.querySelector('.ct-photo-pick')?.focus();
    } catch (err) {
      this.flash(this.t('photoFailed', { msg: err.message }), true);
    }
  }

  async save() {
    if (this.saving || !this.draft) return;
    const d = this.draft;
    const emails = d.emails.map((e) => ({ type: e.type, value: e.value.trim() })).filter((e) => e.value);
    const phones = d.phones.map((p) => ({ type: p.type, value: p.value.trim() })).filter((p) => p.value);
    const first = text(d.first).trim();
    const last = text(d.last).trim();
    const name = [first, last].filter(Boolean).join(' ');
    const err = this.main.querySelector('.ct-form-error');
    if (!name && !text(d.company).trim() && !emails.length && !phones.length) {
      err.textContent = this.t('nameRequired');
      err.hidden = false;
      this.main.querySelector('input[name="first"]')?.focus();
      return;
    }
    this.saving = true;
    try {
      const prev = this.mode === 'edit' ? this.byId(this.selectedId) : null;
      // Keep the display name (vCard FN, e.g. "Dr. John Smith") unless the first or last name was edited.
      const keepName = !!(prev?.name && this.draftNames && first === this.draftNames.first && last === this.draftNames.last);
      const saved = await this.ctx.api.invoke('contacts:save', { ...(prev || {}), id: prev?.id, name: keepName ? prev.name : name, first, last, company: d.company, emails, phones, address: d.address, birthday: d.birthday, notes: d.notes, photo: d.photo, favorite: !!d.favorite });
      this.mode = 'view';
      this.draft = null;
      this.selectedId = saved.id;
      await this.reload();
      this.renderMain();
      this.flash(this.t('saved'));
      this.focusRow(saved.id);
    } catch (e) {
      err.textContent = this.t('saveFailed', { msg: e.message });
      err.hidden = false;
    } finally {
      this.saving = false;
    }
  }

  async remove() {
    const c = this.byId(this.selectedId);
    if (!c || this.mode !== 'view') return;
    const ok = await this.ctx.ui.confirm(this.t('deleteConfirm', { name: c.name || this.t('unnamed') }), { title: this.t('deleteTitle'), okLabel: this.t('delete'), danger: true, parent: this.ctx.win });
    if (!ok) return;
    const order = this.rowsEls().map((r) => r.dataset.id).filter((id, i, a) => a.indexOf(id) === i);
    const i = order.indexOf(c.id);
    const next = order[i + 1] || order[i - 1] || null;
    try {
      await this.ctx.api.invoke('contacts:delete', [c.id]);
    } catch (err) {
      this.flash(this.t('saveFailed', { msg: err.message }), true);
      return;
    }
    this.selectedId = next;
    await this.reload();
    this.renderMain();
    this.flash(this.t('deleted'));
    if (next) this.focusRow(next);
    else this.newBtn.focus();
  }

  // ------------------------------------------------------------ vCard
  async importPick() {
    const { ui, win } = this.ctx;
    const file = await ui.filePicker({ mode: 'open', title: this.t('import'), filters: [{ name: this.t('vcards'), ext: ['.vcf', '.vcard'] }], parent: win });
    if (file && !win.closed) await this.importFile(file);
  }

  async importFile(file) {
    try {
      const res = await this.ctx.api.invoke('contacts:importVcf', file);
      await this.reload();
      if (res.ids?.[0]) await this.select(res.ids[0]);
      this.flash(this.t('imported', res));
      return res;
    } catch (err) {
      this.flash(this.t('importFailed', { msg: err.message }), true);
      return null;
    }
  }

  async exportPick(ids, version, name) {
    const { ui, win, api } = this.ctx;
    const safe = text(name || this.t('appName')).replace(/[\\/:*?"<>|]+/g, '_').trim() || 'contacts';
    const dest = await ui.filePicker({ mode: 'save', title: ids ? this.t('exportOne') : this.t('exportAll'), name: `${safe}.vcf`, filters: [{ name: this.t('vcards'), ext: ['.vcf'] }], parent: win });
    if (!dest || win.closed) return;
    try {
      const res = await api.invoke('contacts:exportVcf', ids, dest, { version });
      this.flash(this.t('exported', { count: res.count }));
    } catch (err) {
      this.flash(this.t('exportFailed', { msg: err.message }), true);
    }
  }

  flash(msg, error = false) {
    clearTimeout(this.statusTimer);
    this.status.textContent = msg;
    this.status.classList.toggle('error', !!error);
    this.status.hidden = false;
    this.statusTimer = setTimeout(() => (this.status.hidden = true), error ? 7000 : 3500);
  }

  async handleArgs(args = {}) {
    if (!args) return;
    if (args.file && /\.(vcf|vcard)$/i.test(args.file)) await this.importFile(args.file);
    else if (args.contactId && this.byId(args.contactId)) await this.select(args.contactId);
  }
}

export default {
  async launch(ctx) {
    const app = new ContactsApp(ctx);
    ctx.win.el.__contacts = app; // test / debugging hook
    await app.init();
    await app.handleArgs(ctx.args || {});
    return {
      contacts: app,
      onRelaunch(args = {}) {
        ctx.win.focus?.();
        app.handleArgs(args || {});
      },
    };
  },
};
