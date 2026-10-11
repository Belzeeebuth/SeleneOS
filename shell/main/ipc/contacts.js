'use strict';
// Contacts backend (renderer/apps/contacts). Local only: no network, so dev and real mode behave the same.
//
// Storage: ~/.local/share/aurora/contacts.json ($XDG_DATA_HOME respected) = { version: 1, contacts: [Contact] }.
// Every write goes to a temporary file that is fsync'ed then renamed over the target (atomic on POSIX), and writes
// are serialized. A damaged file is moved aside to contacts.json.bad-<ms> and the list starts empty.
//
// Contact: { id, name, first, last, company, emails: [{ type, value }], phones: [{ type, value }], address,
//   birthday ('YYYY-MM-DD' | '--MM-DD' | ''), notes, photo ('data:image/…;base64,…' | ''), favorite, created, updated }
//   type: 'home' | 'work' | 'mobile' | 'other'
//
// Channels:
//   contacts:list()                     -> [Contact] sorted by name
//   contacts:get(id)                    -> Contact | null
//   contacts:save(contact)              -> Contact   (creates when id is missing / unknown, else updates)
//   contacts:setFavorite(id, bool)      -> Contact
//   contacts:delete(ids)                -> number deleted
//   contacts:search(query, { limit })   -> [{ id, name, address, favorite }]  one row per e-mail address
//        (used by Mail's recipient autocomplete; matches name, company and address; favourites first)
//   contacts:photo(path)                -> data URL of a picked picture (≤ 8 MB, png/jpg/gif/webp/bmp/svg)
//   contacts:importVcf(path | { text }) -> { added, updated, ids }   vCard 2.1 / 3.0 / 4.0, several cards per file
//        (a card whose name + first e-mail matches an existing contact updates it instead of duplicating it)
//   contacts:exportVcf(ids|null, path, { version: '3.0'|'4.0' }) -> { count, path }  (null = every contact)
//   contacts:toVcf(ids|null, { version }) -> text
// Event: contacts:changed  { ids }   after every change
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const MAX_PHOTO = 8 * 1024 * 1024;
const MAX_VCF = 32 * 1024 * 1024;
const TYPES = ['home', 'work', 'mobile', 'other'];
const IMG = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml' };

function dataFile() {
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'aurora', 'contacts.json');
}

// ---------------------------------------------------------------- pure helpers
const str = (v, max = 4000) => (typeof v === 'string' ? v : v == null ? '' : String(v)).slice(0, max);
const newId = () => crypto.randomBytes(9).toString('base64url');

function normList(list, phone) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const it of list.slice(0, 50)) {
    const value = str(typeof it === 'string' ? it : it?.value, 320).trim();
    if (!value) continue;
    const type = TYPES.includes(it?.type) ? it.type : phone ? 'mobile' : 'home';
    out.push({ type, value });
  }
  return out;
}

function displayName(c) {
  const n = str(c.name).trim() || [c.first, c.last].map((x) => str(x).trim()).filter(Boolean).join(' ');
  return n || str(c.company).trim() || c.emails?.[0]?.value || c.phones?.[0]?.value || '';
}

function normalize(c, prev) {
  const now = Date.now();
  const photo = str(c.photo, MAX_PHOTO * 1.4);
  const out = {
    id: prev?.id || (typeof c.id === 'string' && /^[A-Za-z0-9_-]{4,64}$/.test(c.id) ? c.id : newId()),
    name: '',
    first: str(c.first, 200).trim(),
    last: str(c.last, 200).trim(),
    company: str(c.company, 300).trim(),
    emails: normList(c.emails, false),
    phones: normList(c.phones, true),
    address: str(c.address, 1000).trim(),
    birthday: /^(\d{4}|--)-?\d{2}-\d{2}$/.test(str(c.birthday)) ? str(c.birthday) : '',
    notes: str(c.notes, 20000),
    photo: /^data:image\/[a-z0-9.+-]+;base64,/i.test(photo) ? photo : '',
    favorite: !!c.favorite,
    created: prev?.created || Number(c.created) || now,
    updated: now,
  };
  out.name = str(c.name, 300).trim() || displayName(out);
  return out;
}

const sortKey = (c) => (c.name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const byName = (a, b) => sortKey(a).localeCompare(sortKey(b)) || a.id.localeCompare(b.id);
const fold = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

function search(list, query, limit = 8) {
  const q = fold(query).trim();
  if (!q) return [];
  const rows = [];
  for (const c of list) {
    const name = fold(c.name);
    const company = fold(c.company);
    for (const e of c.emails) {
      const addr = e.value.toLowerCase();
      let score = 0;
      if (name.startsWith(q) || name.split(/\s+/).some((w) => w.startsWith(q)) || addr.startsWith(q)) score = 3;
      else if (name.includes(q) || addr.includes(q) || company.includes(q)) score = 1;
      if (score) rows.push({ id: c.id, name: c.name, address: e.value, favorite: c.favorite, score: score + (c.favorite ? 1 : 0) });
    }
  }
  rows.sort((a, b) => b.score - a.score || sortKey(a).localeCompare(sortKey(b)));
  return rows.slice(0, Math.max(1, Math.min(50, Number(limit) || 8))).map(({ score, ...r }) => r);
}

// ---------------------------------------------------------------- vCard
function unescapeV(s) {
  return s.replace(/\\([nN,;\\:])/g, (_, c) => (c === 'n' || c === 'N' ? '\n' : c));
}
function escapeV(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1');
}
// Split on unescaped separators.
function splitV(s, sep) {
  const out = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length) {
      cur += s[i] + s[i + 1];
      i++;
    } else if (s[i] === sep) {
      out.push(cur);
      cur = '';
    } else cur += s[i];
  }
  out.push(cur);
  return out;
}
function decodeQP(s, charset) {
  const bytes = [];
  const t = s.replace(/=\r?\n/g, '');
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(t.slice(i + 1, i + 3))) {
      bytes.push(parseInt(t.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(...Buffer.from(t[i], 'utf8'));
  }
  return Buffer.from(bytes).toString(/latin|8859/i.test(charset || '') ? 'latin1' : 'utf8');
}

function vType(params) {
  const t = (params.TYPE || []).join(',').toLowerCase();
  if (/cell|mobile/.test(t)) return 'mobile';
  if (/work/.test(t)) return 'work';
  if (/home/.test(t)) return 'home';
  return 'other';
}

/** Parses a .vcf text (2.1 / 3.0 / 4.0, several cards) → [partial contacts]. */
function parseVCards(text) {
  const raw = String(text || '').replace(/^\uFEFF/, '');
  // Unfold: CRLF followed by a space or tab continues the previous line (QP soft breaks handled below).
  const lines = raw.split(/\r\n|\r|\n/);
  const unfolded = [];
  for (const l of lines) {
    if (/^[ \t]/.test(l) && unfolded.length) unfolded[unfolded.length - 1] += l.slice(1);
    else if (unfolded.length && /=$/.test(unfolded[unfolded.length - 1]) && /QUOTED-PRINTABLE/i.test(unfolded[unfolded.length - 1])) unfolded[unfolded.length - 1] = unfolded[unfolded.length - 1].slice(0, -1) + l;
    else unfolded.push(l);
  }
  const cards = [];
  let cur = null;
  for (const line of unfolded) {
    if (!line.trim()) continue;
    const colon = (() => {
      let q = false;
      for (let i = 0; i < line.length; i++) {
        if (line[i] === '"') q = !q;
        else if (line[i] === ':' && !q) return i;
      }
      return -1;
    })();
    if (colon < 0) continue;
    const head = line.slice(0, colon);
    let value = line.slice(colon + 1);
    const parts = head.split(';');
    const prop = parts[0].replace(/^[^.]*\./, '').toUpperCase();
    const params = {};
    for (const p of parts.slice(1)) {
      const eq = p.indexOf('=');
      const k = (eq < 0 ? 'TYPE' : p.slice(0, eq)).toUpperCase();
      const v = (eq < 0 ? p : p.slice(eq + 1)).replace(/^"|"$/g, '');
      (params[k] = params[k] || []).push(...v.split(','));
    }
    if (prop === 'BEGIN' && /^vcard$/i.test(value.trim())) {
      cur = { emails: [], phones: [] };
      continue;
    }
    if (!cur) continue;
    if (prop === 'END' && /^vcard$/i.test(value.trim())) {
      cards.push(cur);
      cur = null;
      continue;
    }
    const enc = (params.ENCODING || [])[0] || '';
    if (/^quoted-printable$/i.test(enc)) value = decodeQP(value, (params.CHARSET || [])[0]);
    switch (prop) {
      case 'FN':
        cur.name = unescapeV(value).trim();
        break;
      case 'N': {
        const [last = '', first = ''] = splitV(value, ';').map((x) => unescapeV(x).trim());
        cur.first = first;
        cur.last = last;
        break;
      }
      case 'EMAIL':
        cur.emails.push({ type: vType(params) === 'mobile' ? 'other' : vType(params), value: unescapeV(value).trim() });
        break;
      case 'TEL':
        cur.phones.push({ type: vType(params), value: unescapeV(value.replace(/^tel:/i, '')).trim() });
        break;
      case 'ORG':
        cur.company = splitV(value, ';').map((x) => unescapeV(x).trim()).filter(Boolean).join(', ');
        break;
      case 'ADR': {
        const f = splitV(value, ';').map((x) => unescapeV(x).trim());
        // PO box; extended; street; locality; region; postal code; country
        const line2 = [f[5], f[3]].filter(Boolean).join(' ');
        cur.address = [f[0], f[1], f[2], [line2, f[4]].filter(Boolean).join(', '), f[6]].filter(Boolean).join('\n');
        break;
      }
      case 'BDAY': {
        const v = value.trim();
        let m = /^(\d{4})-?(\d{2})-?(\d{2})/.exec(v);
        if (m) cur.birthday = `${m[1]}-${m[2]}-${m[3]}`;
        else if ((m = /^--(\d{2})-?(\d{2})/.exec(v))) cur.birthday = `--${m[1]}-${m[2]}`;
        break;
      }
      case 'NOTE':
        cur.notes = unescapeV(value);
        break;
      case 'PHOTO': {
        const v = value.trim();
        if (/^data:image\//i.test(v)) cur.photo = v;
        else if (/^b$|^base64$/i.test(enc)) {
          const type = ((params.TYPE || [])[0] || 'jpeg').toLowerCase();
          cur.photo = `data:${IMG[type] || 'image/' + type};base64,${v.replace(/\s+/g, '')}`;
        }
        break;
      }
      case 'X-AURORA-FAVORITE':
        cur.favorite = /^(1|true|yes)$/i.test(value.trim());
        break;
      default:
        break;
    }
  }
  return cards.filter((c) => c.name || c.first || c.last || c.emails.length || c.phones.length || c.company);
}

function fold75(line) {
  const out = [];
  let s = line;
  // Fold by characters (not bytes) to keep multi-byte characters intact; 74 leaves room for the leading space.
  while (s.length > 75) {
    out.push(s.slice(0, 75));
    s = ' ' + s.slice(75);
  }
  out.push(s);
  return out.join('\r\n');
}

/** Contacts → .vcf text (3.0 or 4.0). */
function toVCards(list, version = '3.0') {
  const v4 = String(version) === '4.0';
  const typ = (t) => (v4 ? `;TYPE=${t === 'mobile' ? 'cell' : t}` : `;TYPE=${t === 'mobile' ? 'CELL' : t.toUpperCase()}`);
  const cards = [];
  for (const c of list) {
    const L = ['BEGIN:VCARD', `VERSION:${v4 ? '4.0' : '3.0'}`];
    L.push(`FN:${escapeV(c.name || '')}`);
    let first = c.first;
    let last = c.last;
    if (!first && !last && c.name) {
      const p = c.name.split(/\s+/);
      last = p.length > 1 ? p.pop() : '';
      first = p.join(' ');
    }
    L.push(`N:${escapeV(last || '')};${escapeV(first || '')};;;`);
    if (c.company) L.push(`ORG:${escapeV(c.company)}`);
    for (const e of c.emails || []) L.push(`EMAIL${typ(e.type === 'mobile' ? 'other' : e.type)}:${escapeV(e.value)}`);
    for (const p of c.phones || []) L.push(`TEL${typ(p.type)}${v4 ? ';VALUE=text' : ''}:${escapeV(p.value)}`);
    if (c.address) L.push(`ADR;TYPE=${v4 ? 'home' : 'HOME'}:;;${escapeV(c.address)};;;;`);
    if (c.birthday) L.push(`BDAY:${v4 ? c.birthday.replace(/^(\d{4})-(\d{2})-(\d{2})$/, '$1$2$3').replace(/^--(\d{2})-(\d{2})$/, '--$1$2') : c.birthday}`);
    if (c.notes) L.push(`NOTE:${escapeV(c.notes)}`);
    if (c.photo) {
      const m = /^data:image\/([a-z0-9.+-]+);base64,(.*)$/i.exec(c.photo);
      if (m) L.push(v4 ? `PHOTO:${c.photo}` : `PHOTO;ENCODING=b;TYPE=${m[1].replace('jpeg', 'JPEG').toUpperCase()}:${m[2]}`);
    }
    if (c.favorite) L.push('X-AURORA-FAVORITE:1');
    L.push(`UID:${v4 ? 'urn:uuid:' : ''}${c.id}`);
    L.push('END:VCARD');
    cards.push(L.map(fold75).join('\r\n'));
  }
  return cards.length ? cards.join('\r\n') + '\r\n' : '';
}

// ---------------------------------------------------------------- store
async function atomicWrite(file, text) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  const fh = await fsp.open(tmp, 'w', 0o600);
  try {
    await fh.writeFile(text);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fsp.rename(tmp, file);
}

function register(api) {
  let cache = null;
  let chain = Promise.resolve();
  const serial = (fn) => {
    const p = chain.then(fn, fn);
    chain = p.catch(() => {});
    return p;
  };

  async function load() {
    if (cache) return cache;
    const file = dataFile();
    let list = [];
    try {
      const txt = await fsp.readFile(file, 'utf8');
      const data = JSON.parse(txt);
      const arr = Array.isArray(data) ? data : data?.contacts;
      if (!Array.isArray(arr)) throw new Error('bad format');
      list = arr.filter((c) => c && typeof c === 'object').map((c) => ({ ...normalize(c, null), id: typeof c.id === 'string' && c.id ? c.id : newId(), created: Number(c.created) || Date.now(), updated: Number(c.updated) || Date.now() }));
    } catch (e) {
      if (e.code !== 'ENOENT') {
        try {
          fs.renameSync(file, `${file}.bad-${Date.now()}`);
        } catch {}
      }
    }
    cache = list.sort(byName);
    return cache;
  }
  async function persist(ids) {
    cache.sort(byName);
    await atomicWrite(dataFile(), JSON.stringify({ version: 1, contacts: cache }, null, 1));
    api.broadcast('contacts:changed', { ids });
  }
  const find = (id) => cache.find((c) => c.id === id) || null;

  api.handle('contacts:list', async () => (await load()).slice());
  api.handle('contacts:get', async (id) => (await load(), find(id)));

  api.handle('contacts:save', (contact) =>
    serial(async () => {
      if (!contact || typeof contact !== 'object') throw api.error('Invalid contact', 'EINVAL');
      await load();
      const prev = contact.id ? find(contact.id) : null;
      const c = normalize(contact, prev);
      if (prev) cache[cache.indexOf(prev)] = c;
      else cache.push(c);
      await persist([c.id]);
      return c;
    }),
  );

  api.handle('contacts:setFavorite', (id, on) =>
    serial(async () => {
      await load();
      const c = find(id);
      if (!c) throw api.error('No such contact', 'ENOENT');
      c.favorite = !!on;
      c.updated = Date.now();
      await persist([id]);
      return c;
    }),
  );

  api.handle('contacts:delete', (ids) =>
    serial(async () => {
      await load();
      const set = new Set(Array.isArray(ids) ? ids : [ids]);
      const before = cache.length;
      cache = cache.filter((c) => !set.has(c.id));
      const n = before - cache.length;
      if (n) await persist([...set]);
      return n;
    }),
  );

  api.handle('contacts:search', async (query, opts = {}) => search(await load(), query, opts?.limit));

  api.handle('contacts:photo', async (p) => {
    const file = str(p);
    const ext = path.extname(file).slice(1).toLowerCase();
    if (!IMG[ext]) throw api.error('Not a picture', 'EINVAL');
    const st = await fsp.stat(file);
    if (!st.isFile() || st.size > MAX_PHOTO) throw api.error('Picture too large', 'EFBIG');
    return `data:${IMG[ext]};base64,${(await fsp.readFile(file)).toString('base64')}`;
  });

  api.handle('contacts:importVcf', (src) =>
    serial(async () => {
      let text;
      if (src && typeof src === 'object' && typeof src.text === 'string') text = src.text;
      else {
        const st = await fsp.stat(str(src));
        if (st.size > MAX_VCF) throw api.error('File too large', 'EFBIG');
        text = await fsp.readFile(str(src), 'utf8');
      }
      const cards = parseVCards(text);
      if (!cards.length) throw api.error('No contacts found in this file', 'ENOCARDS');
      await load();
      let added = 0;
      let updated = 0;
      const ids = [];
      for (const card of cards) {
        const nc = normalize(card, null);
        const key = (x) => `${sortKey(x)}|${(x.emails[0]?.value || '').toLowerCase()}`;
        const prev = cache.find((c) => key(c) === key(nc));
        if (prev) {
          const merged = normalize({ ...prev, ...card, favorite: prev.favorite || card.favorite, photo: card.photo || prev.photo }, prev);
          cache[cache.indexOf(prev)] = merged;
          ids.push(merged.id);
          updated++;
        } else {
          cache.push(nc);
          ids.push(nc.id);
          added++;
        }
      }
      await persist(ids);
      return { added, updated, ids };
    }),
  );

  const pick = async (ids) => {
    const list = await load();
    return Array.isArray(ids) ? list.filter((c) => ids.includes(c.id)) : list.slice();
  };
  api.handle('contacts:toVcf', async (ids, opts = {}) => toVCards(await pick(ids), opts?.version));
  api.handle('contacts:exportVcf', async (ids, dest, opts = {}) => {
    const list = await pick(ids);
    const file = str(dest);
    if (!path.isAbsolute(file)) throw api.error('Invalid path', 'EINVAL');
    await atomicWrite(file, toVCards(list, opts?.version));
    return { count: list.length, path: file };
  });
}

module.exports = register;
module.exports.parseVCards = parseVCards;
module.exports.toVCards = toVCards;
module.exports.search = search;
module.exports.normalize = normalize;
