// Passwords: an encrypted vault of logins.
//   lib/vault.js  WebCrypto (PBKDF2-SHA256 600000 iterations -> AES-GCM 256, random salt, random IV per save)
//   lib/gen.js    password / passphrase generator and strength estimate     lib/csv.js  CSV import / export
// The backend (main/ipc/passwords.js) only stores the encrypted blob. Secrets live in memory while the vault is
// unlocked and are dropped on lock (button, Ctrl+L, auto-lock after N idle minutes, session lock, window close).
// Nothing secret is logged or written to settings: ctx.storage only keeps { autoLockMinutes } and generator options.
// Test hook (dev mode only): the window element exposes this object as `el.__passwords`.
import { createSession, seal, openVault, normalizeEntry, newId } from './lib/vault.js';
import { generatePassword, generatePassphrase, strength } from './lib/gen.js';
import { importCsv, exportCsv, hostOf } from './lib/csv.js';

const MIN_MASTER = 8;
const AUTOLOCK_CHOICES = [1, 5, 15, 30, 60, 0];

// Clipboard clearing outlives the window: a copied secret is wiped 30 s later if the clipboard still holds it.
const clip = { value: null, timer: 0, delay: 30000, api: null };
async function clearClipboard() {
  const v = clip.value;
  clearTimeout(clip.timer);
  clip.value = null;
  clip.timer = 0;
  if (v == null || !clip.api) return false;
  try {
    const cur = await clip.api.invoke('clipboard:readText');
    if (cur === v) {
      await clip.api.invoke('clipboard:writeText', '');
      return true;
    }
  } catch {}
  return false;
}

const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

class PasswordsApp {
  constructor(ctx) {
    this.ctx = ctx;
    this.win = ctx.win;
    this.t = ctx.t;
    this.h = ctx.h;
    this.api = ctx.api;
    clip.api = ctx.api;
    this.state = 'loading'; // setup | locked | open
    this.session = null;
    this.model = null;
    this.selectedId = null;
    this.editing = null; // draft entry while editing
    this.revealed = false;
    this.query = '';
    this.filter = 'all';
    this.prefs = { autoLockMinutes: 5 };
    this.lastActivity = Date.now();
    this.lockReason = '';
    this.saveError = null;
    this.saving = Promise.resolve();
    this.offs = [];
  }

  async init() {
    const { win, ctx } = this;
    this.root = this.h('div', { class: 'pw', tabindex: '-1' });
    win.body.appendChild(this.root);
    if (ctx.env?.dev) win.el.__passwords = this;
    const p = await ctx.storage.get('prefs', {}).catch(() => ({}));
    if (AUTOLOCK_CHOICES.includes(p?.autoLockMinutes)) this.prefs.autoLockMinutes = p.autoLockMinutes;
    this.genOpts = { mode: 'password', length: 20, upper: true, lower: true, digits: true, symbols: true, words: 5, capitalize: false, number: false, ...(await ctx.storage.get('generator', {}).catch(() => ({}))) };

    const activity = () => (this.lastActivity = Date.now());
    for (const ev of ['pointerdown', 'keydown', 'wheel']) {
      document.addEventListener(ev, activity, true);
      this.offs.push(() => document.removeEventListener(ev, activity, true));
    }
    this.offs.push(ctx.shell.on('lock', () => this.lock('session')));
    const iv = setInterval(() => this.checkIdle(), 15000);
    this.offs.push(() => clearInterval(iv));
    this.root.addEventListener('keydown', (e) => this.onKey(e));
    ctx.onClose(() => {
      for (const off of this.offs.splice(0)) off();
      this.drop();
    });
    ctx.onLangChange?.(() => this.render());

    const st = await this.api.invoke('passwords:status').catch(() => ({ exists: false }));
    this.state = st.exists ? 'locked' : 'setup';
    this.render();
  }

  // ------------------------------------------------------------ lock / unlock
  drop() {
    if (this.model) for (const e of this.model.entries) e.password = '';
    this.session = null;
    this.model = null;
    this.editing = null;
    this.selectedId = null;
    this.revealed = false;
    this.query = '';
  }

  lock(reason = 'manual') {
    if (this.state !== 'open') return false;
    this.drop();
    this.state = 'locked';
    this.lockReason = reason;
    clearClipboard();
    if (!this.win.closed) this.render();
    return true;
  }

  checkIdle(now = Date.now()) {
    const min = this.prefs.autoLockMinutes;
    if (this.state === 'open' && min > 0 && now - this.lastActivity >= min * 60000) return this.lock('idle');
    return false;
  }

  async createVault(password, confirm) {
    if (password.length < MIN_MASTER) throw Object.assign(new Error('short'), { code: 'ESHORT' });
    if (password !== confirm) throw Object.assign(new Error('mismatch'), { code: 'EMISMATCH' });
    const session = await createSession(password);
    const model = { entries: [] };
    await this.api.invoke('passwords:write', await seal(session, model));
    this.session = session;
    this.model = model;
    this.open();
  }

  async unlock(password) {
    const blob = await this.api.invoke('passwords:read');
    if (blob == null) {
      this.state = 'setup';
      this.render();
      return false;
    }
    const { session, model } = await openVault(blob, password);
    this.session = session;
    this.model = model;
    this.open();
    return true;
  }

  open() {
    this.state = 'open';
    this.lockReason = '';
    this.lastActivity = Date.now();
    this.saveError = null;
    const first = this.visible()[0];
    this.selectedId = first ? first.id : null;
    this.render();
  }

  persist() {
    const session = this.session;
    const snapshot = JSON.parse(JSON.stringify(this.model));
    this.saving = this.saving
      .catch(() => {})
      .then(async () => {
        await this.api.invoke('passwords:write', await seal(session, snapshot));
        if (this.saveError) {
          this.saveError = null;
          this.renderStatus();
        }
      })
      .catch((err) => {
        this.saveError = err?.message || String(err);
        this.renderStatus();
      });
    return this.saving;
  }

  // ------------------------------------------------------------ entries
  visible() {
    if (!this.model) return [];
    const q = fold(this.query.trim());
    return this.model.entries
      .filter((e) => (this.filter === 'fav' ? e.favorite : true))
      .filter((e) => !q || [e.title, e.username, e.url, e.notes].some((f) => fold(f).includes(q)))
      .sort((a, b) => (b.favorite - a.favorite) || a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
  }
  entry(id) {
    return this.model?.entries.find((e) => e.id === id) || null;
  }

  async saveEntry(draft) {
    const now = Date.now();
    const clean = normalizeEntry({ ...draft, title: draft.title.trim() || hostOf(draft.url) || draft.username.trim() || this.t('untitled'), modified: now });
    const i = this.model.entries.findIndex((e) => e.id === clean.id);
    if (i >= 0) this.model.entries[i] = { ...clean, created: this.model.entries[i].created };
    else this.model.entries.push({ ...clean, created: now });
    this.editing = null;
    this.selectedId = clean.id;
    this.revealed = false;
    this.render();
    await this.persist();
    return clean.id;
  }

  async deleteEntry(id, { ask = true } = {}) {
    const e = this.entry(id);
    if (!e) return false;
    if (ask && !(await this.ctx.ui.confirm(this.t('deleteConfirm', { name: e.title }), { title: this.t('deleteTitle'), okLabel: this.t('delete'), danger: true, parent: this.win }))) return false;
    if (this.state !== 'open') return false;
    const list = this.visible();
    const idx = list.findIndex((x) => x.id === id);
    this.model.entries = this.model.entries.filter((x) => x.id !== id);
    const next = this.visible();
    this.selectedId = next[Math.min(idx, next.length - 1)]?.id || null;
    this.editing = null;
    this.render();
    await this.persist();
    return true;
  }

  async toggleFavorite(id) {
    const e = this.entry(id);
    if (!e) return;
    e.favorite = !e.favorite;
    e.modified = Date.now();
    this.render();
    await this.persist();
  }

  async copy(id, field) {
    const e = this.entry(id);
    const value = e?.[field];
    if (!value) return false;
    await this.api.invoke('clipboard:writeText', value);
    clearTimeout(clip.timer);
    clip.value = value;
    clip.timer = setTimeout(clearClipboard, clip.delay);
    this.toast(this.t(field === 'password' ? 'copiedPassword' : 'copiedUsername', { count: Math.round(clip.delay / 1000) }));
    return true;
  }
  setClipboardDelay(ms) {
    clip.delay = ms;
  }

  // ------------------------------------------------------------ CSV
  importCsvText(text) {
    const rows = importCsv(text);
    const key = (e) => `${e.title}\u0000${e.username}\u0000${e.password}\u0000${e.url}`;
    const have = new Set(this.model.entries.map(key));
    let added = 0;
    const now = Date.now();
    for (const r of rows) {
      const e = normalizeEntry({ ...r, id: newId(), created: now, modified: now });
      if (have.has(key(e))) continue;
      have.add(key(e));
      this.model.entries.push(e);
      added++;
    }
    return { added, skipped: rows.length - added };
  }

  async importCsv(path) {
    const { ui, t } = { ui: this.ctx.ui, t: this.t };
    if (!path) path = await ui.filePicker({ mode: 'open', title: t('importTitle'), filters: [{ name: t('csvFiles'), ext: ['.csv'] }], parent: this.win });
    if (!path || this.state !== 'open') return null;
    let res;
    try {
      res = this.importCsvText(await this.api.invoke('fs:readText', path, { maxBytes: 16 * 1024 * 1024 }));
    } catch (err) {
      await ui.alert(err?.code === 'ECSV' ? t('importNoColumns') : t('importFailed'), { title: t('importTitle'), parent: this.win });
      return null;
    }
    if (!this.selectedId) this.selectedId = this.visible()[0]?.id || null;
    this.render();
    await this.persist();
    this.toast(t('imported', { count: res.added }));
    return res;
  }

  async exportCsv(path) {
    const { ui, t } = { ui: this.ctx.ui, t: this.t };
    const ok = await ui.confirm(t('exportWarning'), { title: t('exportTitle'), okLabel: t('exportAnyway'), danger: true, parent: this.win });
    if (!ok || this.state !== 'open') return false;
    if (!path) path = await ui.filePicker({ mode: 'save', title: t('exportTitle'), name: 'passwords.csv', filters: [{ name: t('csvFiles'), ext: ['.csv'] }], parent: this.win });
    if (!path || this.state !== 'open') return false;
    try {
      await this.api.invoke('fs:writeText', path, exportCsv(this.visibleAll()));
    } catch {
      await ui.alert(t('exportFailed'), { title: t('exportTitle'), parent: this.win });
      return false;
    }
    this.toast(t('exported', { count: this.model.entries.length }));
    return true;
  }
  visibleAll() {
    return [...this.model.entries].sort((a, b) => a.title.localeCompare(b.title));
  }

  // ------------------------------------------------------------ rendering
  render() {
    if (this.win.closed) return;
    const { h, t } = this;
    this.win.setTitle(t('app'));
    this.root.className = `pw pw-${this.state}`;
    if (this.state === 'loading') return this.root.replaceChildren();
    if (this.state === 'setup' || this.state === 'locked') return this.renderGate();
    this.root.replaceChildren(
      this.renderToolbar(),
      h('div', { class: 'pw-body' }, this.renderList(), h('div', { class: 'pw-detail', role: 'region', 'aria-label': t('details') }, this.editing ? this.renderEditor() : this.renderDetail())),
      (this.statusEl = h('div', { class: 'pw-status', role: 'status', 'aria-live': 'polite' })),
    );
    this.renderStatus();
  }

  renderStatus() {
    if (!this.statusEl) return;
    const { h, t } = this;
    if (this.saveError) {
      this.statusEl.replaceChildren(
        h('div', { class: 'infobar error pw-save-error' }, this.ctx.icon('warning'), h('div', { class: 'grow' }, t('saveFailed')), h('button', { class: 'btn', onclick: () => this.persist() }, t('retry'))),
      );
    } else this.statusEl.replaceChildren();
  }

  toast(text) {
    if (this.win.closed) return;
    clearTimeout(this.toastTimer);
    this.toastEl?.remove();
    this.toastEl = this.h('div', { class: 'pw-toast', role: 'status' }, this.ctx.icon('checkmark'), text);
    this.root.appendChild(this.toastEl);
    this.toastTimer = setTimeout(() => this.toastEl?.remove(), 2600);
  }

  meter(pw) {
    const { h, t } = this;
    const el = h('div', { class: 'pw-meter', role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': '4' }, h('div', { class: 'pw-meter-bars' }, [0, 1, 2, 3].map(() => h('span'))), h('span', { class: 'pw-meter-label caption' }));
    el.update = (v) => {
      const { score, bits } = strength(v);
      el.dataset.score = v ? String(score) : '';
      el.setAttribute('aria-valuenow', String(v ? score : 0));
      el.lastChild.textContent = v ? `${t(`strength.${score}`)} · ${t('bits', { count: bits })}` : t('strength.empty');
    };
    el.update(pw);
    return el;
  }

  pwInput(props) {
    const { h, t, ctx } = this;
    const input = h('input', { class: 'input', type: 'password', autocomplete: 'off', spellcheck: false, ...props });
    const eye = h('button', { class: 'btn subtle pw-eye', type: 'button', 'aria-label': t('show'), 'data-tip': t('show'), 'aria-pressed': 'false' }, ctx.icon('eye'));
    eye.onclick = () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      eye.setAttribute('aria-pressed', String(show));
      eye.replaceChildren(ctx.icon(show ? 'eye_off' : 'eye'));
      eye.setAttribute('aria-label', show ? t('hide') : t('show'));
      eye.dataset.tip = show ? t('hide') : t('show');
    };
    return { input, wrap: h('div', { class: 'pw-pwfield' }, input, eye) };
  }

  renderGate() {
    const { h, t, ctx } = this;
    const setup = this.state === 'setup';
    const err = h('div', { class: 'pw-error', role: 'alert' });
    const pw = this.pwInput({ id: 'pw-master', 'aria-label': t('master') });
    const conf = setup ? this.pwInput({ id: 'pw-confirm', 'aria-label': t('confirm') }) : null;
    const meter = setup ? this.meter('') : null;
    if (meter) pw.input.addEventListener('input', () => meter.update(pw.input.value));
    const btn = h('button', { class: 'btn primary pw-go', type: 'submit' }, setup ? t('createVault') : t('unlock'));
    const form = h(
      'form',
      { class: 'pw-gate-card card', autocomplete: 'off' },
      h('img', { class: 'pw-gate-icon', src: ctx.appUrl('icon.svg'), alt: '' }),
      h('h1', { class: 'subtitle' }, setup ? t('setupTitle') : t('lockedTitle')),
      h('p', { class: 'text-2 pw-gate-sub' }, setup ? t('setupHint') : this.lockReason === 'idle' ? t('lockedIdle') : this.lockReason === 'session' ? t('lockedSession') : t('lockedHint')),
      h('div', { class: 'field' }, h('label', { for: 'pw-master' }, t('master')), pw.wrap),
      meter,
      setup ? h('div', { class: 'field' }, h('label', { for: 'pw-confirm' }, t('confirm')), conf.wrap) : null,
      setup ? h('div', { class: 'infobar warning pw-forget' }, ctx.icon('warning'), h('div', null, t('noRecovery'))) : null,
      err,
      btn,
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (btn.disabled) return;
      err.textContent = '';
      btn.disabled = true;
      btn.replaceChildren(h('span', { class: 'spinner pw-spin' }), setup ? t('creating') : t('unlocking'));
      try {
        if (setup) await this.createVault(pw.input.value, conf.input.value);
        else await this.unlock(pw.input.value);
      } catch (ex) {
        if (this.win.closed || this.state === 'open') return;
        const map = { ESHORT: t('tooShort', { count: MIN_MASTER }), EMISMATCH: t('mismatch'), EBADPASS: t('wrongPassword'), ENEWER: t('newerVault'), EFORMAT: t('damagedVault') };
        err.textContent = map[ex?.code] || t('genericError');
        btn.disabled = false;
        btn.replaceChildren(setup ? t('createVault') : t('unlock'));
        pw.input.select();
        pw.input.focus();
      }
    });
    this.root.replaceChildren(h('div', { class: 'pw-gate' }, form));
    setTimeout(() => !this.win.closed && pw.input.focus(), 30);
  }

  renderToolbar() {
    const { h, t, ctx } = this;
    const search = h('input', { class: 'input pw-search', type: 'search', placeholder: t('search'), 'aria-label': t('search'), value: this.query, spellcheck: false });
    search.addEventListener('input', () => {
      this.query = search.value;
      this.refreshList();
    });
    search.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        this.root.querySelector('.pw-item')?.focus();
      } else if (e.key === 'Escape' && search.value) {
        e.stopPropagation();
        search.value = '';
        this.query = '';
        this.refreshList();
      }
    });
    const filter = ctx.ui.segmented({
      options: [{ value: 'all', label: t('all') }, { value: 'fav', label: t('favorites') }],
      value: this.filter,
      onchange: (v) => {
        this.filter = v;
        this.refreshList();
      },
    });
    filter.classList.add('pw-filter');
    const more = h('button', { class: 'btn subtle pw-more', 'aria-label': t('more'), 'data-tip': t('more'), 'aria-haspopup': 'menu' }, ctx.icon('more_horizontal'));
    more.onclick = (e) => this.moreMenu(e);
    return h(
      'div',
      { class: 'toolbar pw-toolbar' },
      h('div', { class: 'search-box pw-searchbox' }, search, ctx.icon('search')),
      filter,
      h('div', { class: 'grow' }),
      h('button', { class: 'btn primary pw-new', onclick: () => this.startEdit(null) }, ctx.icon('add'), t('newEntry')),
      h('button', { class: 'btn subtle pw-gen', 'aria-label': t('generator'), 'data-tip': t('generator'), onclick: () => this.openGenerator() }, ctx.icon('key_multiple')),
      more,
      h('button', { class: 'btn subtle pw-lock', 'aria-label': t('lock'), 'data-tip': `${t('lock')} (Ctrl+L)`, onclick: () => this.lock('manual') }, ctx.icon('lock_closed')),
    );
  }

  async moreMenu(e) {
    const { t, ctx } = this;
    await ctx.ui.menu(e, [
      { label: t('importCsv'), icon: 'arrow_download', action: () => this.importCsv() },
      { label: t('exportCsv'), icon: 'arrow_upload', action: () => this.exportCsv() },
      '-',
      {
        label: t('autoLock'),
        icon: 'lock_closed',
        submenu: AUTOLOCK_CHOICES.map((m) => ({ label: m ? t('minutes', { count: m }) : t('never'), checked: this.prefs.autoLockMinutes === m, action: () => this.setAutoLock(m) })),
      },
      '-',
      { label: t('lock'), icon: 'lock_closed', shortcut: 'Ctrl+L', action: () => this.lock('manual') },
    ]);
  }

  async setAutoLock(min) {
    if (!AUTOLOCK_CHOICES.includes(min)) return;
    this.prefs.autoLockMinutes = min;
    await this.ctx.storage.set('prefs', { autoLockMinutes: min });
  }

  renderList() {
    this.listEl = this.h('div', { class: 'pw-list', role: 'listbox', 'aria-label': this.t('entries') });
    this.listEl.addEventListener('keydown', (e) => {
      const items = [...this.listEl.querySelectorAll('.pw-item')];
      const i = items.indexOf(document.activeElement);
      if (i < 0) return;
      let j = -1;
      if (e.key === 'ArrowDown') j = Math.min(items.length - 1, i + 1);
      else if (e.key === 'ArrowUp') j = Math.max(0, i - 1);
      else if (e.key === 'Home') j = 0;
      else if (e.key === 'End') j = items.length - 1;
      else if (e.key === 'Delete') {
        e.preventDefault();
        this.deleteEntry(items[i].dataset.id);
        return;
      }
      if (j < 0) return;
      e.preventDefault();
      this.select(items[j].dataset.id, { focus: true });
    });
    this.fillList();
    return this.listEl;
  }

  fillList() {
    const { h, t, ctx } = this;
    const list = this.visible();
    if (!list.length) {
      this.listEl.replaceChildren(h('div', { class: 'empty pw-empty' }, ctx.icon(this.query ? 'search' : 'password', { size: 32 }), h('div', null, this.query ? t('noMatch') : this.filter === 'fav' ? t('noFavorites') : t('emptyVault'))));
      return;
    }
    this.listEl.replaceChildren(
      ...list.map((e) =>
        h(
          'div',
          {
            class: ['list-item', 'pw-item', e.id === this.selectedId && 'selected'],
            role: 'option',
            tabindex: e.id === this.selectedId || (!list.some((x) => x.id === this.selectedId) && e === list[0]) ? '0' : '-1',
            'aria-selected': String(e.id === this.selectedId),
            dataset: { id: e.id },
            onclick: () => this.select(e.id),
          },
          this.avatar(e),
          h('div', { class: 'pw-item-text' }, h('div', { class: 'ellipsis pw-item-title' }, e.title || t('untitled')), h('div', { class: 'ellipsis caption text-2' }, e.username || hostOf(e.url) || '')),
          e.favorite ? h('span', { class: 'pw-fav-mark', 'aria-label': t('favorite') }, ctx.icon('star', { filled: true, size: 14 })) : null,
        ),
      ),
    );
  }

  refreshList() {
    if (this.state !== 'open' || !this.listEl) return;
    this.fillList();
  }

  avatar(e, big = false) {
    const letter = (e.title || hostOf(e.url) || '?').trim().charAt(0).toUpperCase() || '?';
    let hash = 0;
    for (const c of e.title || '') hash = (hash * 31 + c.charCodeAt(0)) | 0;
    return this.h('div', { class: ['pw-avatar', big && 'big'], dataset: { hue: String(Math.abs(hash) % 6) }, 'aria-hidden': 'true' }, letter);
  }

  select(id, { focus = false } = {}) {
    if (this.editing) return;
    this.selectedId = id;
    this.revealed = false;
    this.render();
    if (focus) this.root.querySelector(`.pw-item[data-id="${CSS.escape(id)}"]`)?.focus();
  }

  renderDetail() {
    const { h, t, ctx } = this;
    const e = this.entry(this.selectedId);
    if (!e) return h('div', { class: 'empty pw-detail-empty' }, ctx.icon('shield_lock', { size: 40 }), h('div', null, t('selectHint')));
    const copyBtn = (field, label) => h('button', { class: `btn subtle pw-copy-${field}`, 'aria-label': label, 'data-tip': label, disabled: !e[field], onclick: () => this.copy(e.id, field) }, ctx.icon('copy'));
    const row = (label, value, ...actions) => h('div', { class: 'pw-row' }, h('div', { class: 'pw-row-label caption text-2' }, label), h('div', { class: 'pw-row-main' }, value, h('div', { class: 'pw-row-actions' }, actions)));
    const pwText = h('span', { class: ['pw-secret', 'mono', this.revealed && 'shown'] }, e.password ? (this.revealed ? e.password : '•'.repeat(Math.min(16, Math.max(8, e.password.length)))) : '');
    const reveal = h('button', { class: 'btn subtle pw-reveal', 'aria-pressed': String(this.revealed), 'aria-label': this.revealed ? t('hide') : t('show'), 'data-tip': this.revealed ? t('hide') : t('show'), disabled: !e.password }, ctx.icon(this.revealed ? 'eye_off' : 'eye'));
    reveal.onclick = () => {
      this.revealed = !this.revealed;
      this.render();
      this.root.querySelector('.pw-reveal')?.focus();
    };
    const url = e.url ? (/^[a-z][a-z0-9+.-]*:/i.test(e.url) ? e.url : `https://${e.url}`) : '';
    const { score } = strength(e.password);
    return h(
      'div',
      { class: 'pw-view' },
      h(
        'div',
        { class: 'pw-view-head' },
        this.avatar(e, true),
        h('div', { class: 'pw-view-title' }, h('div', { class: 'subtitle ellipsis' }, e.title || t('untitled')), h('div', { class: 'caption text-2 ellipsis' }, hostOf(e.url) || '')),
        h('button', { class: ['btn subtle pw-star', e.favorite && 'on'], 'aria-pressed': String(e.favorite), 'aria-label': t('favorite'), 'data-tip': t('favorite'), onclick: () => this.toggleFavorite(e.id) }, ctx.icon('star', { filled: e.favorite })),
        h('button', { class: 'btn pw-edit', onclick: () => this.startEdit(e.id) }, ctx.icon('edit'), t('edit')),
        h('button', { class: 'btn subtle pw-delete', 'aria-label': t('delete'), 'data-tip': t('delete'), onclick: () => this.deleteEntry(e.id) }, ctx.icon('delete')),
      ),
      h(
        'div',
        { class: 'card pw-card' },
        row(t('username'), h('span', { class: 'pw-user selectable ellipsis' }, e.username || '—'), copyBtn('username', t('copyUsername'))),
        row(t('password'), h('div', { class: 'pw-pwline' }, pwText, e.password ? h('span', { class: 'pw-chip', dataset: { score: String(score) } }, t(`strength.${score}`)) : null), reveal, copyBtn('password', t('copyPassword'))),
        row(
          t('website'),
          url ? h('a', { class: 'pw-link ellipsis', href: '#', onclick: (ev) => (ev.preventDefault(), ctx.shell.openUrl(url)) }, e.url) : h('span', { class: 'text-2' }, '—'),
        ),
        e.notes ? row(t('notes'), h('div', { class: 'pw-notes selectable' }, e.notes)) : null,
      ),
      h('div', { class: 'caption text-2 pw-dates' }, t('modified', { date: new Date(e.modified).toLocaleString(this.ctx.lang) })),
    );
  }

  startEdit(id) {
    if (this.state !== 'open') return;
    const e = id ? this.entry(id) : null;
    this.editing = e ? { ...e } : { id: newId(), title: '', username: '', password: '', url: '', notes: '', favorite: false, isNew: true };
    this.render();
    setTimeout(() => this.root.querySelector('#pw-f-title')?.focus(), 20);
  }

  cancelEdit() {
    if (!this.editing) return;
    this.editing = null;
    this.render();
    this.root.querySelector('.pw-item.selected')?.focus();
  }

  renderEditor() {
    const { h, t, ctx } = this;
    const d = this.editing;
    const input = (key, label, props = {}) => {
      const el = h(props.multiline ? 'textarea' : 'input', { class: props.multiline ? 'textarea' : 'input', id: `pw-f-${key}`, value: d[key], spellcheck: false, autocomplete: 'off', ...(props.attrs || {}) });
      if (props.multiline) el.value = d[key];
      el.addEventListener('input', () => (d[key] = el.value));
      return h('div', { class: 'field' }, h('label', { for: `pw-f-${key}` }, label), el);
    };
    const pw = this.pwInput({ id: 'pw-f-password', value: d.password });
    const meter = this.meter(d.password);
    pw.input.addEventListener('input', () => {
      d.password = pw.input.value;
      meter.update(d.password);
    });
    const genBtn = h('button', { class: 'btn pw-f-gen', type: 'button', 'data-tip': t('generate') }, ctx.icon('key_multiple'), t('generate'));
    genBtn.onclick = async () => {
      const v = await this.openGenerator({ use: true });
      if (v == null || this.editing !== d) return;
      d.password = v;
      pw.input.value = v;
      meter.update(v);
    };
    pw.wrap.appendChild(genBtn);
    const fav = ctx.ui.toggle({ checked: d.favorite, label: t('favorite'), onchange: (v) => (d.favorite = v) });
    fav.classList.add('pw-f-fav');
    const form = h(
      'form',
      { class: 'pw-editor', autocomplete: 'off' },
      h('div', { class: 'subtitle' }, d.isNew ? t('newEntry') : t('editEntry')),
      input('title', t('title'), { attrs: { maxlength: 500 } }),
      input('username', t('username')),
      h('div', { class: 'field' }, h('label', { for: 'pw-f-password' }, t('password')), pw.wrap, meter),
      input('url', t('website'), { attrs: { placeholder: 'https://', type: 'url' } }),
      input('notes', t('notes'), { multiline: true }),
      fav,
      h('div', { class: 'pw-editor-actions' }, h('button', { class: 'btn primary pw-save', type: 'submit' }, t('save')), h('button', { class: 'btn pw-cancel', type: 'button', onclick: () => this.cancelEdit() }, t('cancel'))),
    );
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const { isNew, ...draft } = d;
      this.saveEntry(draft);
    });
    form.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.cancelEdit();
      }
    });
    return form;
  }

  onKey(e) {
    if (this.state !== 'open') return;
    const k = e.key.toLowerCase();
    if (e.ctrlKey && !e.altKey && !e.shiftKey) {
      if (k === 'l') {
        e.preventDefault();
        this.lock('manual');
      } else if (k === 'f') {
        e.preventDefault();
        this.root.querySelector('.pw-search')?.focus();
      } else if (k === 'n' && !this.editing) {
        e.preventDefault();
        this.startEdit(null);
      } else if (k === 'g') {
        e.preventDefault();
        this.openGenerator();
      }
    }
  }

  // ------------------------------------------------------------ generator
  async openGenerator({ use = false } = {}) {
    const { h, t, ctx } = this;
    const o = this.genOpts;
    const out = h('input', { class: 'input mono pw-gen-out', readonly: true, 'aria-label': t('generated') });
    const meter = this.meter('');
    const regen = () => {
      out.value = o.mode === 'passphrase' ? generatePassphrase(o) : generatePassword(o);
      meter.update(out.value);
    };
    const opts = h('div', { class: 'pw-gen-opts' });
    const check = (key, label) => {
      const cb = h('input', { type: 'checkbox', checked: o[key] !== false, class: `pw-gen-${key}` });
      cb.onchange = () => {
        o[key] = cb.checked;
        if (!['upper', 'lower', 'digits', 'symbols'].some((k) => o[k]) && o.mode === 'password') {
          o[key] = true;
          cb.checked = true;
        }
        regen();
      };
      return h('label', { class: 'checkbox' }, cb, h('span', null, label));
    };
    const sliderRow = (key, min, max, label) => {
      const val = h('span', { class: 'pw-gen-val mono' }, String(o[key]));
      const s = ctx.ui.slider({ min, max, value: o[key], oninput: (v) => ((o[key] = v), (val.textContent = String(v)), regen()) });
      s.classList.add(`pw-gen-${key}`);
      s.setAttribute('aria-label', label);
      return h('div', { class: 'pw-gen-slider' }, h('span', null, label), s, val);
    };
    const fillOpts = () => {
      if (o.mode === 'passphrase') opts.replaceChildren(sliderRow('words', 3, 10, t('words')), check('capitalize', t('capitalize')), check('number', t('addNumber')));
      else opts.replaceChildren(sliderRow('length', 8, 64, t('length')), h('div', { class: 'pw-gen-checks' }, check('upper', 'A-Z'), check('lower', 'a-z'), check('digits', '0-9'), check('symbols', '!@#$')));
    };
    const mode = ctx.ui.segmented({
      options: [{ value: 'password', label: t('passwordMode') }, { value: 'passphrase', label: t('passphraseMode') }],
      value: o.mode,
      onchange: (v) => {
        o.mode = v;
        fillOpts();
        regen();
      },
    });
    mode.classList.add('pw-gen-mode');
    const again = h('button', { class: 'btn subtle pw-gen-again', type: 'button', 'aria-label': t('regenerate'), 'data-tip': t('regenerate'), onclick: regen }, ctx.icon('arrow_clockwise'));
    fillOpts();
    regen();
    const body = h('div', { class: 'pw-gen' }, mode, h('div', { class: 'pw-gen-row' }, out, again), meter, opts);
    const res = await ctx.ui.dialog({
      title: t('generator'),
      body,
      className: 'pw-gen-dialog',
      parent: this.win,
      width: 440,
      buttons: [{ label: use ? t('usePassword') : t('copy'), value: 'ok', primary: true }, { label: use ? t('cancel') : t('close'), value: null }],
    });
    const { mode: m, length, upper, lower, digits, symbols, words, capitalize, number } = o;
    this.ctx.storage.set('generator', { mode: m, length, upper, lower, digits, symbols, words, capitalize, number }).catch(() => {});
    if (res !== 'ok') return null;
    if (use) return out.value;
    await this.api.invoke('clipboard:writeText', out.value);
    clearTimeout(clip.timer);
    clip.value = out.value;
    clip.timer = setTimeout(clearClipboard, clip.delay);
    this.toast(t('copiedPassword', { count: Math.round(clip.delay / 1000) }));
    return out.value;
  }
}

export default {
  async launch(ctx) {
    const app = new PasswordsApp(ctx);
    await app.init();
    return {
      onRelaunch: () => ctx.win.focus(),
    };
  },
};
