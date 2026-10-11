// Notes data model + persistence (backend: main/ipc/notes.js).
//
// In memory:  notebooks: [{ id, name, color, emoji, created }]
//             notes: Map id -> { id, title, notebookId, created, modified, pinned, pinnedAt, deletedAt,
//                                preview, thumb, tags, words, chars, html, text, foldedText }
// On disk:    notes.json (index: notebooks + notes' metadata) and <id>/note.html (body + a copy of the
//             metadata). At load the two are reconciled: a note file newer than the index wins, notes whose
//             folder disappeared are dropped, folders missing from the index are adopted, notebooks only
//             known from a note's metadata are recreated. Notes deleted more than 30 days ago are purged.
import { sanitizeFragment, sanitizeHtml, inertDocument } from './sanitize.js';
import { plainText, extractTags, countWords, countChars, foldText, newId, matches } from './text.js';

export const PURGE_DAYS = 30;
export const NOTEBOOK_COLORS = ['blue', 'teal', 'green', 'yellow', 'orange', 'red', 'pink', 'purple', 'gray'];
const META_KEYS = ['id', 'title', 'notebookId', 'created', 'modified', 'pinned', 'pinnedAt', 'deletedAt', 'preview', 'thumb', 'tags', 'words', 'chars'];

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const str = (v, max = 500) => (typeof v === 'string' ? v.slice(0, max) : '');

function cleanNotebook(nb) {
  if (!nb || typeof nb !== 'object' || typeof nb.id !== 'string' || !/^[A-Za-z0-9_-]{4,64}$/.test(nb.id)) return null;
  return {
    id: nb.id,
    name: str(nb.name, 120).trim() || 'Notebook',
    color: NOTEBOOK_COLORS.includes(nb.color) ? nb.color : 'blue',
    emoji: typeof nb.emoji === 'string' && [...nb.emoji].length <= 4 ? nb.emoji : '',
    created: num(nb.created, Date.now()),
  };
}

function cleanMeta(m, id) {
  if (!m || typeof m !== 'object') m = {};
  return {
    id,
    title: str(m.title, 500),
    notebookId: typeof m.notebookId === 'string' ? m.notebookId : null,
    created: num(m.created, num(m.modified, Date.now())),
    modified: num(m.modified, num(m.created, Date.now())),
    pinned: !!m.pinned,
    pinnedAt: num(m.pinnedAt, 0),
    deletedAt: m.deletedAt ? num(m.deletedAt, 0) || null : null,
    preview: str(m.preview, 300),
    thumb: typeof m.thumb === 'string' ? m.thumb : null,
    tags: Array.isArray(m.tags) ? m.tags.filter((t) => typeof t === 'string').slice(0, 200) : [],
    words: num(m.words),
    chars: num(m.chars),
  };
}

/** Derived fields of a body (sanitized HTML string): plain text, preview, tags, counts, first picture. */
export function analyze(html, title, locale = 'en') {
  const doc = inertDocument(); // attachment names are relative URLs: never fetch them
  const box = doc.createElement('div');
  box.appendChild(sanitizeFragment(html, { attachments: true, allowMedia: true, allowRemote: true, doc }));
  const text = plainText(box);
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  // preview: the first lines that aren't the title
  const t = (title || '').trim();
  const body = t ? lines : lines.slice(1);
  const preview = body.join(' ').slice(0, 300);
  const img = box.querySelector('img');
  return {
    text,
    preview,
    firstLine: lines[0] || '',
    tags: extractTags(`${t}\n${text}`),
    words: countWords(`${t ? `${t}\n` : ''}${text}`, locale),
    chars: countChars(`${t}${text}`),
    thumb: img ? img.getAttribute('data-att') || img.getAttribute('src') : null,
  };
}

export class NotesStore {
  constructor(api, { locale = 'en' } = {}) {
    this.api = api;
    this.locale = locale;
    this.root = '';
    this.notebooks = [];
    this.notes = new Map();
    this.indexTimer = null;
    this.indexChain = Promise.resolve();
    this.noteChains = new Map();
    this.listeners = new Set();
    this.lastError = null;
    // writes that failed (disk full, folder replaced...): retried in the background with a growing delay;
    // 'saved' is emitted when a note reaches the disk again, 'error' on each failure
    this.failed = new Set();
    this.indexFailed = false;
    this.retryTimer = null;
    this.retryCount = 0;
  }

  /** True while something is only in memory (a failed note or index write). */
  get pending() {
    return this.failed.size > 0 || this.indexFailed;
  }

  scheduleRetry() {
    if (this.retryTimer || this.disposed) return;
    const delay = Math.min(60000, 3000 * 2 ** Math.min(this.retryCount++, 5));
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.retryNow().catch(() => {});
    }, delay);
  }

  /** Nothing is pending any more: stop the background retries (a stale timer would fire later, fail if the
   * disk broke again meanwhile and emit errors while the user is already retrying by hand). */
  clearRetry() {
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.retryCount = 0;
  }

  /** Write again everything that failed. Resolves true when it all reached the disk. */
  async retryNow() {
    // a manual retry replaces the scheduled one (a failure below schedules the next attempt)
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    let ok = true;
    for (const id of [...this.failed]) {
      if (!this.notes.has(id)) {
        this.failed.delete(id);
        continue;
      }
      try {
        await this.writeNote(id);
      } catch {
        ok = false;
      }
    }
    if (this.indexFailed) {
      try {
        await this.saveIndex(true);
      } catch {
        ok = false;
      }
    }
    if (ok && !this.pending) this.clearRetry();
    else if (this.pending) this.scheduleRetry();
    return ok && !this.pending;
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.retryTimer);
    clearTimeout(this.indexTimer);
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  emit(what, data) {
    for (const fn of this.listeners) {
      try {
        fn(what, data);
      } catch (err) {
        console.error('[notes] listener failed', err);
      }
    }
  }

  // ------------------------------------------------------------------ load
  async load({ seed } = {}) {
    const res = await this.api.invoke('notes:open');
    this.root = res.root;
    const index = res.index && typeof res.index === 'object' ? res.index : {};
    this.notebooks = (Array.isArray(index.notebooks) ? index.notebooks : []).map(cleanNotebook).filter(Boolean);
    const idxNotes = index.notes && typeof index.notes === 'object' ? index.notes : {};
    let dirty = !res.index && res.notes.length > 0;
    for (const f of res.notes) {
      const fromIndex = idxNotes[f.id] ? cleanMeta(idxNotes[f.id], f.id) : null;
      const fromFile = f.meta ? cleanMeta(f.meta, f.id) : null;
      let meta = fromIndex;
      if (!meta || (fromFile && fromFile.modified > meta.modified)) {
        meta = fromFile || cleanMeta({ modified: f.mtime, created: f.mtime }, f.id);
        dirty = true;
      }
      // a notebook only known from the note file (index lost): recreate it
      if (meta.notebookId && !this.notebooks.some((n) => n.id === meta.notebookId)) {
        const nb = cleanNotebook(f.meta?.notebook) || cleanNotebook({ id: meta.notebookId, name: 'Notebook' });
        if (nb && nb.id === meta.notebookId) {
          this.notebooks.push(nb);
          dirty = true;
        }
      }
      const html = sanitizeHtml(f.html || '', { attachments: true, allowMedia: true, allowRemote: true });
      const note = this.withBody(meta, html);
      // a note file too large to be read (edited outside the app) is listed but never rewritten from the
      // empty body we have in memory: that would destroy its content
      if (f.tooBig) note.tooBig = true;
      this.notes.set(f.id, note);
    }
    if (Object.keys(idxNotes).some((id) => !this.notes.has(id))) dirty = true; // folders deleted outside the app
    if (!this.notebooks.length) {
      this.notebooks.push(cleanNotebook({ id: newId('b'), name: seed?.notebookName || 'Notes', color: 'blue', emoji: '' }));
      dirty = true;
    }
    // notes pointing at a notebook that no longer exists go to the first notebook
    for (const n of this.notes.values()) {
      if (!this.notebooks.some((b) => b.id === n.notebookId)) {
        n.notebookId = this.notebooks[0].id;
        dirty = true;
      }
    }
    if (res.firstRun && seed) {
      await this.create({ title: seed.title, html: seed.html, notebookId: this.notebooks[0].id, pinned: true });
      dirty = true;
    }
    const purged = await this.purgeExpired();
    if (dirty || purged) await this.saveIndex(true);
    return { firstRun: res.firstRun, indexSource: res.indexSource, purged };
  }

  withBody(meta, html) {
    const a = analyze(html, meta.title, this.locale);
    return { ...meta, html, text: a.text, foldedText: foldText(a.text), preview: a.preview, firstLine: a.firstLine, tags: a.tags, words: a.words, chars: a.chars, thumb: a.thumb };
  }

  // ------------------------------------------------------------------ persistence
  indexData() {
    const notes = {};
    for (const n of this.notes.values()) notes[n.id] = Object.fromEntries(META_KEYS.map((k) => [k, n[k]]));
    return { version: 1, app: 'aurora-notes', notebooks: this.notebooks, notes };
  }

  /** Index writes are debounced (the note files carry their own metadata, so nothing is lost meanwhile). */
  saveIndex(now = false) {
    clearTimeout(this.indexTimer);
    if (!now) {
      this.indexTimer = setTimeout(() => this.saveIndex(true), 700);
      return this.indexChain;
    }
    this.indexTimer = null;
    const data = this.indexData();
    this.indexChain = this.indexChain
      .catch(() => {})
      .then(() => this.api.invoke('notes:writeIndex', data))
      .then(
        (v) => {
          if (this.indexFailed) {
            this.indexFailed = false;
            if (!this.pending) this.clearRetry();
            this.emit('saved', { index: true });
          }
          return v;
        },
        (err) => {
          this.lastError = err;
          this.indexFailed = true;
          this.emit('error', err);
          this.scheduleRetry();
          throw err;
        },
      );
    return this.indexChain;
  }

  async flush() {
    if (this.indexTimer) await this.saveIndex(true).catch(() => {});
    await Promise.all([...this.noteChains.values()].map((p) => p.catch(() => {})));
    await this.indexChain.catch(() => {});
  }

  metaForFile(n) {
    const nb = this.notebooks.find((b) => b.id === n.notebookId);
    return { ...Object.fromEntries(META_KEYS.map((k) => [k, n[k]])), notebook: nb || null, app: 'aurora-notes', version: 1 };
  }

  /** Write a note file (serialized per note). Resolves when the bytes are on disk. */
  writeNote(id) {
    const n = this.notes.get(id);
    if (!n || n.tooBig) return Promise.resolve();
    const payload = { html: n.html, meta: this.metaForFile(n), title: n.title || n.firstLine || '', lang: this.locale.slice(0, 2) };
    const prev = this.noteChains.get(id) || Promise.resolve();
    const next = prev
      .catch(() => {})
      .then(() => this.api.invoke('notes:writeNote', id, payload))
      .then(
        (v) => {
          if (this.failed.delete(id)) {
            if (!this.pending) this.clearRetry();
            this.emit('saved', { id });
          }
          return v;
        },
        (err) => {
          this.lastError = err;
          // a note deleted for good meanwhile has nothing left to save
          if (this.notes.has(id)) {
            this.failed.add(id);
            this.scheduleRetry();
          }
          this.emit('error', err);
          throw err;
        },
      );
    this.noteChains.set(id, next);
    next.finally(() => {
      if (this.noteChains.get(id) === next) this.noteChains.delete(id);
    }).catch(() => {});
    return next;
  }

  // ------------------------------------------------------------------ notes
  get(id) {
    return this.notes.get(id) || null;
  }

  async create({ title = '', html = '', notebookId, pinned = false, created, modified } = {}) {
    const id = newId('n');
    const now = Date.now();
    const nbId = this.notebooks.some((b) => b.id === notebookId) ? notebookId : this.notebooks[0]?.id;
    const meta = cleanMeta({ title, notebookId: nbId, created: created || now, modified: modified || now, pinned, pinnedAt: pinned ? now : 0 }, id);
    const clean = sanitizeHtml(html, { attachments: true, allowMedia: true, allowRemote: true });
    const note = this.withBody(meta, clean);
    this.notes.set(id, note);
    await this.writeNote(id);
    this.saveIndex();
    this.emit('change', { id, kind: 'create' });
    return note;
  }

  /** Update the body / title of a note (html already sanitized by the editor). */
  async update(id, { html, title } = {}, { touch = true } = {}) {
    const n = this.notes.get(id);
    if (!n) return null;
    const next = this.withBody({ ...n, title: title !== undefined ? String(title).slice(0, 500) : n.title, modified: touch ? Date.now() : n.modified }, html !== undefined ? html : n.html);
    if (n.tooBig) next.tooBig = true;
    this.notes.set(id, next);
    const p = this.writeNote(id);
    this.saveIndex();
    this.emit('change', { id, kind: 'edit' });
    await p;
    return next;
  }

  async setMeta(ids, patch, { touch = false } = {}) {
    const list = (Array.isArray(ids) ? ids : [ids]).map((id) => this.notes.get(id)).filter(Boolean);
    for (const n of list) {
      Object.assign(n, patch);
      if (touch) n.modified = Date.now();
    }
    await Promise.all(list.map((n) => this.writeNote(n.id)));
    this.saveIndex();
    this.emit('change', { ids: list.map((n) => n.id), kind: 'meta' });
  }

  pin(id, on) {
    return this.setMeta(id, { pinned: !!on, pinnedAt: on ? Date.now() : 0 });
  }
  move(ids, notebookId) {
    if (!this.notebooks.some((b) => b.id === notebookId)) throw new Error('Unknown notebook');
    return this.setMeta(ids, { notebookId });
  }
  trash(ids) {
    return this.setMeta(ids, { deletedAt: Date.now(), pinned: false, pinnedAt: 0 });
  }
  restore(ids) {
    const list = Array.isArray(ids) ? ids : [ids];
    // the notebook may be gone meanwhile
    for (const id of list) {
      const n = this.notes.get(id);
      if (n && !this.notebooks.some((b) => b.id === n.notebookId)) n.notebookId = this.notebooks[0]?.id;
    }
    return this.setMeta(list, { deletedAt: null });
  }

  async purge(ids) {
    const list = (Array.isArray(ids) ? ids : [ids]).filter((id) => this.notes.has(id));
    if (!list.length) return 0;
    for (const id of list) await (this.noteChains.get(id) || Promise.resolve()).catch(() => {});
    await this.api.invoke('notes:remove', list);
    for (const id of list) {
      this.notes.delete(id);
      this.failed.delete(id);
    }
    await this.saveIndex(true);
    this.emit('change', { ids: list, kind: 'purge' });
    return list.length;
  }

  async purgeExpired(now = Date.now()) {
    const limit = now - PURGE_DAYS * 86400000;
    const expired = [...this.notes.values()].filter((n) => n.deletedAt && n.deletedAt < limit).map((n) => n.id);
    if (!expired.length) return 0;
    try {
      await this.api.invoke('notes:remove', expired);
      for (const id of expired) {
        this.notes.delete(id);
        this.failed.delete(id);
      }
      return expired.length;
    } catch (err) {
      console.warn('[notes] purge failed', err?.message || err);
      return 0;
    }
  }

  async duplicate(id, suffix) {
    const src = this.notes.get(id);
    if (!src) return null;
    await (this.noteChains.get(id) || Promise.resolve()).catch(() => {});
    const nid = newId('n');
    await this.api.invoke('notes:duplicate', id, nid);
    const now = Date.now();
    const title = src.title ? `${src.title} ${suffix}` : '';
    const meta = cleanMeta({ ...src, id: nid, title, created: now, modified: now, pinned: false, pinnedAt: 0, deletedAt: null }, nid);
    const note = this.withBody(meta, src.html);
    this.notes.set(nid, note);
    await this.writeNote(nid);
    this.saveIndex();
    this.emit('change', { id: nid, kind: 'create' });
    return note;
  }

  // ------------------------------------------------------------------ notebooks
  notebook(id) {
    return this.notebooks.find((b) => b.id === id) || null;
  }
  async addNotebook({ name, color = 'blue', emoji = '' }) {
    const nb = cleanNotebook({ id: newId('b'), name, color, emoji, created: Date.now() });
    this.notebooks.push(nb);
    await this.saveIndex(true);
    this.emit('change', { kind: 'notebooks' });
    return nb;
  }
  async updateNotebook(id, patch) {
    const nb = this.notebook(id);
    if (!nb) return null;
    Object.assign(nb, cleanNotebook({ ...nb, ...patch, id }));
    // the note files carry a copy of their notebook (index recovery): refresh them in the background
    for (const n of this.notes.values()) if (n.notebookId === id) this.writeNote(n.id).catch(() => {});
    await this.saveIndex(true);
    this.emit('change', { kind: 'notebooks' });
    return nb;
  }
  /** Delete a notebook: its notes go to Recently deleted. */
  async removeNotebook(id) {
    if (this.notebooks.length <= 1) throw new Error('last notebook');
    const ids = [...this.notes.values()].filter((n) => n.notebookId === id && !n.deletedAt).map((n) => n.id);
    this.notebooks = this.notebooks.filter((b) => b.id !== id);
    const fallback = this.notebooks[0].id;
    for (const n of this.notes.values()) if (n.notebookId === id) n.notebookId = fallback;
    if (ids.length) await this.trash(ids);
    // notes that were already in Recently deleted now belong to the fallback notebook too
    for (const n of this.notes.values()) if (n.notebookId === fallback) this.writeNote(n.id).catch(() => {});
    await this.saveIndex(true);
    this.emit('change', { kind: 'notebooks' });
    return ids.length;
  }
  reorderNotebooks(ids) {
    const map = new Map(this.notebooks.map((b) => [b.id, b]));
    const next = ids.map((id) => map.get(id)).filter(Boolean);
    for (const b of this.notebooks) if (!next.includes(b)) next.push(b);
    this.notebooks = next;
    this.saveIndex();
    this.emit('change', { kind: 'notebooks' });
  }

  // ------------------------------------------------------------------ queries
  all() {
    return [...this.notes.values()];
  }
  live() {
    return this.all().filter((n) => !n.deletedAt);
  }

  /** Notes of a view: { kind: 'all'|'pinned'|'deleted'|'notebook'|'tag', id }, filtered by a parsed query. */
  query(view, query, sort = 'modified') {
    let list;
    switch (view?.kind) {
      case 'deleted':
        list = this.all().filter((n) => n.deletedAt);
        break;
      case 'pinned':
        list = this.live().filter((n) => n.pinned);
        break;
      case 'notebook':
        list = this.live().filter((n) => n.notebookId === view.id);
        break;
      case 'tag':
        list = this.live().filter((n) => n.tags.includes(view.id));
        break;
      default:
        list = this.live();
    }
    if (query && !query.empty) list = list.filter((n) => matches(n, query));
    return sortNotes(list, view?.kind === 'deleted' ? 'deleted' : sort, this.locale);
  }

  counts() {
    const c = { all: 0, pinned: 0, deleted: 0, notebooks: {}, tags: {} };
    for (const n of this.notes.values()) {
      if (n.deletedAt) {
        c.deleted++;
        continue;
      }
      c.all++;
      if (n.pinned) c.pinned++;
      c.notebooks[n.notebookId] = (c.notebooks[n.notebookId] || 0) + 1;
      for (const t of n.tags) c.tags[t] = (c.tags[t] || 0) + 1;
    }
    return c;
  }

  tags() {
    const c = this.counts().tags;
    return Object.keys(c)
      .sort((a, b) => a.localeCompare(b, this.locale))
      .map((tag) => ({ tag, count: c[tag] }));
  }
}

export function displayTitle(n) {
  return (n?.title || '').trim() || (n?.firstLine || '').trim();
}

export function sortNotes(list, sort, locale = 'en') {
  const coll = new Intl.Collator(locale, { sensitivity: 'base', numeric: true });
  const by = {
    modified: (a, b) => b.modified - a.modified,
    created: (a, b) => b.created - a.created,
    title: (a, b) => coll.compare(displayTitle(a) || '\uffff', displayTitle(b) || '\uffff') || b.modified - a.modified,
    deleted: (a, b) => (b.deletedAt || 0) - (a.deletedAt || 0),
  }[sort] || ((a, b) => b.modified - a.modified);
  return [...list].sort(by);
}
