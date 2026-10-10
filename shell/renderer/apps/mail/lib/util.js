// Small helpers shared by the Mail modules (no DOM state).

export const EMAIL_RE = /^[^\s@<>(),;:"\[\]]+@[^\s@<>(),;:"\[\]]+\.[^\s@<>(),;:"\[\]]{2,}$/;
export const isEmail = (s) => EMAIL_RE.test(String(s || '').trim()) || /^[^\s@<>]+@(localhost|[^\s@<>.]+)$/.test(String(s || '').trim());

export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Escape plain text and turn URLs / e-mail addresses into links. Everything else stays escaped.
const LINK_RE = /\b((?:https?:\/\/|www\.)[^\s<>"'`]+|mailto:[^\s<>"'`]+|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
export function linkify(text) {
  const src = String(text ?? '');
  let out = '';
  let last = 0;
  for (const m of src.matchAll(LINK_RE)) {
    let url = m[0];
    // Trailing punctuation is not part of the link.
    const trail = /[.,;:!?)\]}>'"»]+$/.exec(url);
    if (trail && !(trail[0].startsWith(')') && url.includes('('))) url = url.slice(0, url.length - trail[0].length);
    out += escapeHtml(src.slice(last, m.index));
    let href = url;
    if (/^www\./i.test(url)) href = `https://${url}`;
    else if (!/^(https?:|mailto:)/i.test(url)) href = `mailto:${url}`;
    out += `<a href="${escapeHtml(href)}">${escapeHtml(url)}</a>`;
    last = m.index + url.length;
  }
  return out + escapeHtml(src.slice(last));
}

// Plain text mail -> HTML: escaped, linkified, quoted lines (> …) as nested blockquotes.
export function textToHtml(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  let html = '';
  let depth = 0;
  for (const raw of lines) {
    const m = /^((?:>\s?)+)/.exec(raw);
    const d = m ? (m[1].match(/>/g) || []).length : 0;
    const line = m ? raw.slice(m[1].length) : raw;
    while (depth < d) {
      html += '<blockquote class="q">';
      depth++;
    }
    while (depth > d) {
      html += '</blockquote>';
      depth--;
    }
    html += `${linkify(line)}\n`;
  }
  while (depth-- > 0) html += '</blockquote>';
  return html;
}

export function htmlToText(html) {
  const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
  for (const el of doc.querySelectorAll('script,style,head,title')) el.remove();
  for (const br of doc.querySelectorAll('br')) br.replaceWith('\n');
  for (const el of doc.querySelectorAll('p,div,li,tr,h1,h2,h3,h4,h5,h6,blockquote,pre,table')) el.append('\n');
  for (const li of doc.querySelectorAll('li')) li.prepend('• ');
  for (const a of doc.querySelectorAll('a[href^="http"]')) if (a.textContent.trim() && a.textContent.trim() !== a.getAttribute('href')) a.append(` <${a.getAttribute('href')}>`);
  return (doc.body?.textContent || '')
    .replace(/ /g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------------------------------------------------------------- people
const PERSONA = ['#c43501', '#a4262c', '#d13438', '#ca5010', '#8e562e', '#498205', '#0b6a0b', '#038387', '#005b70', '#0078d4', '#004e8c', '#4f6bed', '#5c2e91', '#8764b8', '#881798', '#c239b3', '#e3008c', '#7a7574', '#69797e', '#986f0b'];
export function hashCode(s) {
  let h = 2166136261;
  for (const ch of String(s || '').toLowerCase()) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
export const avatarColor = (key) => PERSONA[hashCode(key) % PERSONA.length];

export function initials(name, address) {
  const src = String(name || '').replace(/["'(].*?["')]/g, ' ').replace(/[^\p{L}\p{N}\s.-]/gu, ' ').trim();
  if (src) {
    const parts = src.split(/[\s.]+/).filter((p) => /\p{L}|\p{N}/u.test(p));
    if (parts.length >= 2) return (firstChar(parts[0]) + firstChar(parts[parts.length - 1])).toUpperCase();
    if (parts.length === 1) return firstChar(parts[0]).toUpperCase();
  }
  const local = String(address || '?').split('@')[0].replace(/[^\p{L}\p{N}]/gu, ' ').trim();
  const p2 = local.split(/\s+/).filter(Boolean);
  if (p2.length >= 2) return (firstChar(p2[0]) + firstChar(p2[1])).toUpperCase();
  return firstChar(local || '?').toUpperCase();
}
function firstChar(s) {
  return [...String(s)][0] || '';
}

export const displayName = (a) => (a ? a.name || a.address || '' : '');
export function addressText(a) {
  if (!a) return '';
  if (a.name && a.address) return `${a.name} <${a.address}>`;
  return a.address || a.name || '';
}

// "Ann <a@x>, b@y; c@z" -> [{name, address}]
export function parseAddresses(s) {
  const out = [];
  let buf = '';
  let quote = false;
  let angle = false;
  for (const ch of String(s || '')) {
    if (ch === '"') quote = !quote;
    if (ch === '<') angle = true;
    if (ch === '>') angle = false;
    if ((ch === ',' || ch === ';' || ch === '\n') && !quote && !angle) {
      out.push(buf);
      buf = '';
    } else buf += ch;
  }
  out.push(buf);
  return out
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => {
      const m = /^(.*?)<([^>]+)>\s*$/.exec(x);
      if (m) return { name: m[1].trim().replace(/^"|"$/g, '').trim(), address: m[2].trim() };
      return { name: '', address: x.replace(/^mailto:/i, '') };
    });
}

export function sameAddress(a, b) {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
}

// mailto:a@b?subject=..&cc=..&body=..
export function parseMailto(url) {
  try {
    const s = String(url || '');
    if (!/^mailto:/i.test(s)) return null;
    const rest = s.slice(7);
    const q = rest.indexOf('?');
    const to = decodeURIComponent(q >= 0 ? rest.slice(0, q) : rest);
    const params = new URLSearchParams(q >= 0 ? rest.slice(q + 1) : '');
    const get = (k) => {
      for (const [key, v] of params) if (key.toLowerCase() === k) return v;
      return '';
    };
    return { to, cc: get('cc'), bcc: get('bcc'), subject: get('subject'), body: get('body') };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- dates
export function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

// List dates: today -> time, this week -> weekday + time, older -> short date (Outlook style).
export function listDate(iso, i18n) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const today = startOfDay(now);
  if (d >= today) return i18n.formatTime(d, { hour: 'numeric', minute: '2-digit' });
  const days = Math.round((today - startOfDay(d)) / 86400000);
  if (days < 7) return i18n.formatDate(d, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  if (d.getFullYear() === now.getFullYear()) return i18n.formatDate(d, { day: 'numeric', month: 'numeric' }).replace(/\s/g, ' ');
  return i18n.formatDate(d, { dateStyle: 'short' });
}

export function fullDate(iso, i18n) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return i18n.formatDate(d, { weekday: 'short', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// Group key for the message list headers.
export function dateGroup(iso) {
  const d = new Date(iso);
  const now = new Date();
  const today = startOfDay(now);
  if (d >= today) return 'today';
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (d >= yesterday) return 'yesterday';
  const weekStart = new Date(today);
  const dow = (today.getDay() + 6) % 7; // Monday first
  weekStart.setDate(today.getDate() - dow);
  if (d >= weekStart) return 'thisWeek';
  const lastWeek = new Date(weekStart);
  lastWeek.setDate(weekStart.getDate() - 7);
  if (d >= lastWeek) return 'lastWeek';
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  if (d >= monthStart) return 'thisMonth';
  const lastMonth = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  if (d >= lastMonth) return 'lastMonth';
  return 'older';
}

// ---------------------------------------------------------------- files
export function fileKind(name, type = '') {
  const ext = (/\.([^.]+)$/.exec(String(name || '')) || [])[1]?.toLowerCase() || '';
  const t = String(type || '').toLowerCase();
  if (t.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'heic', 'avif'].includes(ext)) return { icon: 'image', color: '#0f7b0f' };
  if (t === 'application/pdf' || ext === 'pdf') return { icon: 'document_pdf', color: '#c4314b' };
  if (['doc', 'docx', 'odt', 'rtf'].includes(ext)) return { icon: 'document', color: '#185abd' };
  if (['xls', 'xlsx', 'ods', 'csv'].includes(ext)) return { icon: 'document_table', color: '#107c41' };
  if (['ppt', 'pptx', 'odp'].includes(ext)) return { icon: 'slide_text', color: '#c43e1c' };
  if (['zip', 'tar', 'gz', '7z', 'rar', 'xz', 'bz2'].includes(ext)) return { icon: 'folder_zip', color: '#b4880b' };
  if (t.startsWith('audio/') || ['mp3', 'wav', 'ogg', 'flac', 'm4a'].includes(ext)) return { icon: 'music_note_2', color: '#8764b8' };
  if (t.startsWith('video/') || ['mp4', 'webm', 'mkv', 'mov', 'avi'].includes(ext)) return { icon: 'video', color: '#8764b8' };
  if (t === 'message/rfc822' || ext === 'eml') return { icon: 'mail', color: '#0f6cbd' };
  if (t === 'text/calendar' || ext === 'ics') return { icon: 'calendar', color: '#0f6cbd' };
  if (t.startsWith('text/') || ['txt', 'md', 'log'].includes(ext)) return { icon: 'document_text', color: '#616161' };
  return { icon: 'document', color: '#616161' };
}

export function debounce(fn, ms) {
  let t = null;
  const d = (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
  d.cancel = () => clearTimeout(t);
  return d;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function prefixSubject(subject, prefix) {
  const s = String(subject || '').trim();
  const base = prefix.trim().replace(/\s*:$/, '').toLowerCase();
  const re = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`, 'i');
  if (re.test(s)) return s;
  if (base === 're' && /^(re|aw|réf)\s*:/i.test(s)) return s;
  if ((base === 'fwd' || base === 'tr') && /^(fwd?|tr|wg)\s*:/i.test(s)) return s;
  return `${prefix}${s}`;
}
