// CSV import / export (RFC 4180). Columns: title,username,password,url,notes,favorite. On import the header is
// matched loosely so exports from common browsers and password managers work (name, login_uri, login_username, …).
export const COLUMNS = ['title', 'username', 'password', 'url', 'notes', 'favorite'];

const ALIASES = {
  title: ['title', 'name', 'account', 'site', 'titre', 'nom'],
  username: ['username', 'login_username', 'user', 'login', 'email', 'identifiant', "nom d'utilisateur", 'utilisateur'],
  password: ['password', 'login_password', 'pass', 'mot de passe', 'motdepasse'],
  url: ['url', 'login_uri', 'uri', 'website', 'web site', 'site web', 'adresse'],
  notes: ['notes', 'note', 'extra', 'comments', 'comment', 'remarques'],
  favorite: ['favorite', 'favourite', 'fav', 'favori', 'starred'],
};

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let q = false;
  const s = String(text || '').replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else q = false;
      } else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

/** CSV text -> [{ title, username, password, url, notes, favorite }]; throws ECSV when no usable header is found. */
export function importCsv(text) {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const idx = {};
  for (const col of COLUMNS) idx[col] = head.findIndex((h) => ALIASES[col].includes(h));
  if (idx.password < 0 && idx.username < 0) throw Object.assign(new Error('No username or password column'), { code: 'ECSV' });
  const out = [];
  for (const r of rows.slice(1)) {
    const get = (col) => (idx[col] >= 0 ? r[idx[col]] ?? '' : '');
    const e = {
      title: get('title').trim(),
      username: get('username'),
      password: get('password'),
      url: get('url').trim(),
      notes: get('notes'),
      favorite: /^(1|true|yes|oui|x)$/i.test(get('favorite').trim()),
    };
    if (!e.title) e.title = hostOf(e.url) || e.username;
    if (e.title || e.password || e.username) out.push(e);
  }
  return out;
}

const cell = (v) => {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export function exportCsv(entries) {
  const lines = [COLUMNS.join(',')];
  for (const e of entries) lines.push([e.title, e.username, e.password, e.url, e.notes, e.favorite ? 'true' : 'false'].map(cell).join(','));
  return lines.join('\r\n') + '\r\n';
}

export function hostOf(url) {
  const s = String(url || '').trim();
  if (!s) return '';
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}
