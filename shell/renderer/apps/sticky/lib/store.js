// Sticky Notes data model, shared by every window of the app (ES modules are evaluated once per shell, so the
// hub and each note window see the same store). Persistence: main/ipc/sticky.js (sticky:load / sticky:save).
//   note = { id, html, color, created, modified, open, onTop, x, y, w, h }
// The body HTML is always cleaned by clean(): the Notes sanitizer first (allow-list rebuild in an inert
// document), then a stricter pass keeping only b / i / u / s / ul / li / div / br.
import { sanitizeHtml, inertDocument } from '../../notes/lib/sanitize.js';

export const COLORS = ['yellow', 'green', 'pink', 'purple', 'blue', 'gray'];
const KEEP = new Set(['b', 'i', 'u', 's', 'ul', 'li', 'div', 'br']);
const AS_DIV = new Set(['p', 'h1', 'h2', 'h3', 'blockquote', 'pre', 'tr']);
const DROP = new Set(['img', 'hr']);

/** Strict sanitizer for note bodies -> HTML string. */
export function clean(html) {
  const doc = inertDocument();
  const src = doc.createElement('div');
  src.innerHTML = sanitizeHtml(String(html ?? ''), { collapseWhitespace: false });
  const out = doc.createElement('div');
  const build = (from, to, depth) => {
    for (let n = from.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3) {
        to.appendChild(doc.createTextNode(n.nodeValue));
        continue;
      }
      if (n.nodeType !== 1 || depth > 24) continue;
      let tag = n.tagName.toLowerCase();
      if (tag === 'ol') tag = 'ul';
      if (AS_DIV.has(tag)) tag = 'div';
      if (DROP.has(tag)) continue;
      if (!KEEP.has(tag)) {
        build(n, to, depth + 1); // unwrap (a, span, mark, code, td...)
        continue;
      }
      const el = doc.createElement(tag);
      if (tag !== 'br') build(n, el, depth + 1);
      to.appendChild(el);
    }
  };
  build(src, out, 0);
  // a list item only lives in a list
  for (const li of [...out.querySelectorAll('li')]) {
    if (li.parentElement?.tagName !== 'UL') {
      const d = doc.createElement('div');
      d.append(...li.childNodes);
      li.replaceWith(d);
    }
  }
  return out.innerHTML;
}

/** Plain text of a body (one line per block / line break). */
export function plainText(html) {
  const doc = inertDocument();
  const box = doc.createElement('div');
  box.innerHTML = clean(html);
  let text = '';
  const walk = (node) => {
    for (let n = node.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3) text += n.nodeValue;
      else if (n.nodeName === 'BR') text += '\n';
      else if (n.nodeType === 1) {
        const block = n.nodeName === 'DIV' || n.nodeName === 'LI' || n.nodeName === 'UL';
        if (block && text && !text.endsWith('\n')) text += '\n';
        if (n.nodeName === 'LI') text += '• ';
        walk(n);
        if (block && !text.endsWith('\n')) text += '\n';
      }
    }
  };
  walk(box);
  return text.replace(/​/g, '').replace(/[ \t]+\n/g, '\n').trim();
}

export function lines(html) {
  return plainText(html)
    .split('\n')
    .map((l) => l.replace(/^•\s*/, '').trim())
    .filter(Boolean);
}

export function firstLine(html) {
  return lines(html)[0] || '';
}

function fold(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

export function newId() {
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => (b % 36).toString(36)).join('');
  return `s${Date.now().toString(36)}${rand}`;
}

const num = (v, d = null) => (Number.isFinite(v) ? v : d);

function cleanNote(n) {
  if (!n || typeof n !== 'object' || typeof n.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(n.id)) return null;
  const now = Date.now();
  return {
    id: n.id,
    html: clean(typeof n.html === 'string' ? n.html : ''),
    color: COLORS.includes(n.color) ? n.color : 'yellow',
    created: num(n.created, now),
    modified: num(n.modified, num(n.created, now)),
    open: !!n.open,
    onTop: !!n.onTop,
    x: num(n.x),
    y: num(n.y),
    w: num(n.w),
    h: num(n.h),
  };
}

class StickyStore {
  constructor() {
    this.notes = [];
    this.api = null;
    this.loading = null;
    this.loaded = false;
    this.listeners = new Set();
    this.saveTimer = null;
    this.saving = Promise.resolve();
    this.deleted = []; // undo stack: [{ note, index }]
    this.error = null;
    this.restored = false; // open notes reopened once per shell session
  }

  load(api) {
    this.api ||= api;
    this.loading ||= api
      .invoke('sticky:load')
      .then((res) => {
        const list = Array.isArray(res?.data?.notes) ? res.data.notes : [];
        const seen = new Set();
        this.notes = list.map(cleanNote).filter((n) => n && !seen.has(n.id) && seen.add(n.id));
        this.loaded = true;
      })
      .catch((err) => {
        console.error('[sticky] load failed', err);
        this.loaded = true;
        this.readOnly = true; // never overwrite a file we could not read
        this.error = err;
      });
    return this.loading;
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  emit(kind, data) {
    for (const fn of [...this.listeners]) {
      try {
        fn(kind, data);
      } catch (err) {
        console.error('[sticky] listener failed', err);
      }
    }
  }

  get(id) {
    return this.notes.find((n) => n.id === id) || null;
  }

  /** Notes, most recently modified first, filtered by a search query (accents and case ignored). */
  list(query = '') {
    const q = fold(query).trim();
    const all = [...this.notes].sort((a, b) => b.modified - a.modified);
    if (!q) return all;
    const terms = q.split(/\s+/);
    return all.filter((n) => {
      const text = fold(plainText(n.html));
      return terms.every((t) => text.includes(t));
    });
  }

  create(patch = {}) {
    const now = Date.now();
    const n = cleanNote({ id: newId(), html: '', color: 'yellow', created: now, modified: now, ...patch });
    this.notes.push(n);
    this.changed('create', n);
    return n;
  }

  update(id, patch) {
    const n = this.get(id);
    if (!n) return null;
    let touched = false;
    if ('html' in patch) {
      const html = clean(patch.html);
      if (html !== n.html) {
        n.html = html;
        touched = true;
      }
    }
    if ('color' in patch && COLORS.includes(patch.color) && patch.color !== n.color) {
      n.color = patch.color;
      touched = true;
    }
    for (const k of ['open', 'onTop']) if (k in patch) n[k] = !!patch[k];
    for (const k of ['x', 'y', 'w', 'h']) if (k in patch && Number.isFinite(patch[k])) n[k] = Math.round(patch[k]);
    if (touched) n.modified = Date.now();
    this.changed('update', n, { touched });
    return n;
  }

  remove(id) {
    const index = this.notes.findIndex((n) => n.id === id);
    if (index < 0) return null;
    const [note] = this.notes.splice(index, 1);
    this.deleted.push({ note, index });
    if (this.deleted.length > 20) this.deleted.shift();
    this.changed('remove', note);
    return note;
  }

  /** Restores the last deleted note (or the one with this id). */
  undo(id) {
    const i = id ? this.deleted.findIndex((d) => d.note.id === id) : this.deleted.length - 1;
    if (i < 0) return null;
    const [{ note, index }] = this.deleted.splice(i, 1);
    if (this.get(note.id)) return null;
    this.notes.splice(Math.min(index, this.notes.length), 0, note);
    this.changed('restore', note);
    return note;
  }

  changed(kind, note, extra = {}) {
    this.emit(kind, { note, ...extra });
    this.scheduleSave();
  }

  scheduleSave(delay = 400) {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), delay);
  }

  /** Writes now (chained: saves never overlap). */
  flush() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (!this.api || !this.loaded || this.readOnly) return this.saving;
    const data = { version: 1, notes: this.notes.map((n) => ({ ...n })) };
    this.saving = this.saving.then(() =>
      this.api.invoke('sticky:save', data).then(
        () => {
          if (this.error) {
            this.error = null;
            this.emit('saved');
          }
        },
        (err) => {
          console.error('[sticky] save failed', err);
          this.error = err;
          this.emit('error', err);
        },
      ),
    );
    return this.saving;
  }
}

export const store = new StickyStore();
