// File types: localized type names, colour icons (Windows 11 style SVGs in ../icons) and formatting.
import { shared } from './shared.js';

const ICONS = 'app://shell/apps/files/icons/';
export const iconPath = (name) => `${ICONS}${name}.svg`;
export const THIS_PC_ICON = 'app://shell/assets/icons/this-pc.svg';
export const TRASH_ICON = 'app://shell/assets/icons/recycle-bin.svg';

const KINDS = {
  image: ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.avif', '.ico', '.tif', '.tiff', '.heic', '.jfif'],
  audio: ['.mp3', '.wav', '.ogg', '.oga', '.flac', '.m4a', '.aac', '.opus', '.wma', '.mid', '.midi'],
  video: ['.mp4', '.webm', '.mkv', '.mov', '.avi', '.ogv', '.m4v', '.wmv', '.mpg', '.mpeg', '.3gp'],
  text: ['.txt', '.log', '.ini', '.conf', '.cfg', '.md', '.markdown', '.rst', '.nfo', '.text', '.list'],
  code: ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.c', '.h', '.cpp', '.hpp', '.cc', '.rs', '.go', '.java', '.kt', '.rb',
    '.php', '.pl', '.lua', '.json', '.xml', '.yml', '.yaml', '.toml', '.css', '.scss', '.sass', '.less', '.vue', '.svelte', '.sql', '.cs', '.swift', '.diff', '.patch'],
  script: ['.sh', '.bash', '.zsh', '.fish', '.run', '.bin', '.appimage', '.desktop'],
  web: ['.html', '.htm', '.xhtml', '.url', '.webloc'],
  archive: ['.zip', '.tar', '.gz', '.tgz', '.xz', '.txz', '.bz2', '.tbz', '.tbz2', '.7z', '.rar', '.zst', '.tzst', '.lz', '.lzma', '.cab'],
  package: ['.deb', '.rpm', '.snap', '.flatpak'],
  pdf: ['.pdf'],
  doc: ['.doc', '.docx', '.odt', '.rtf', '.pages'],
  sheet: ['.xls', '.xlsx', '.ods', '.csv', '.tsv', '.numbers'],
  slides: ['.ppt', '.pptx', '.odp', '.key'],
  disc: ['.iso', '.img', '.dmg'],
  font: ['.ttf', '.otf', '.woff', '.woff2'],
  mail: ['.eml', '.msg', '.mbox'],
};
const KIND_OF = new Map();
for (const [k, list] of Object.entries(KINDS)) for (const e of list) KIND_OF.set(e, k);

export function kindOf(entry) {
  if (!entry) return 'file';
  if (entry.dir) return 'folder';
  return KIND_OF.get((entry.ext || '').toLowerCase()) || 'file';
}
export const isImage = (e) => !e?.dir && KINDS.image.includes((e?.ext || '').toLowerCase());
export const isVideo = (e) => !e?.dir && KINDS.video.includes((e?.ext || '').toLowerCase());
export const isAudio = (e) => !e?.dir && KINDS.audio.includes((e?.ext || '').toLowerCase());
export const isArchive = (e) => !e?.dir && /\.(zip|tar|tar\.gz|tgz|tar\.xz|txz|tar\.bz2|tbz2?|tar\.zst|tzst)$/i.test(e?.name || '');
export const isTextLike = (e) => {
  const k = kindOf(e);
  return k === 'text' || k === 'code' || k === 'web' || (k === 'script' && e.ext !== '.appimage' && e.ext !== '.bin' && e.ext !== '.run');
};

// Extensions Windows gives a descriptive type name to (others are "XYZ File").
const NAMED_TYPES = {
  '.txt': 'text', '.log': 'log', '.md': 'markdown', '.markdown': 'markdown', '.pdf': 'pdf', '.zip': 'zip', '.bmp': 'bitmap',
  '.svg': 'svg', '.mp3': 'mp3', '.html': 'html', '.htm': 'html', '.js': 'javascript', '.mjs': 'javascript', '.py': 'python',
  '.sh': 'shell', '.bash': 'shell', '.deb': 'deb', '.iso': 'iso', '.img': 'iso', '.desktop': 'desktop', '.ttf': 'ttf', '.otf': 'otf',
  '.tar': 'archive', '.gz': 'archive', '.tgz': 'archive', '.xz': 'archive', '.txz': 'archive', '.bz2': 'archive', '.7z': 'archive',
  '.rar': 'archive', '.zst': 'archive', '.css': 'css', '.json': 'json', '.csv': 'csv', '.appimage': 'app', '.eml': 'eml',
};

export function typeName(entry, t = shared.t) {
  if (!entry) return '';
  if (entry.dir) return t('types.folder');
  const ext = (entry.ext || '').toLowerCase();
  const named = NAMED_TYPES[ext];
  if (named) return t(`types.${named}`);
  if (!ext) return entry.mode & 0o111 ? t('types.executable') : t('types.file');
  return t('types.generic', { ext: ext.slice(1).toUpperCase() });
}

// Known user folders get their own folder artwork.
export function knownFolder(p) {
  const x = shared.xdg;
  if (!x || !p) return null;
  if (p === x.home) return 'home';
  for (const k of ['desktop', 'documents', 'downloads', 'pictures', 'music', 'videos']) if (x[k] === p) return k;
  return null;
}

// System locations: "/", the home folder, the user folders (Desktop, Documents…) and mount points.
// Deleting, renaming or moving them would break the session (XDG user dirs), so Explorer refuses.
export function isProtectedPath(p) {
  if (!p) return false;
  if (p === '/' || p === shared.home) return true;
  if (knownFolder(p)) return true;
  return shared.drives.some((d) => d.mountpoint === p);
}

// Regular file (not a FIFO, socket or device): only those get thumbnails / previews.
export function isRegular(e) {
  if (!e || e.dir) return false;
  return e.mode == null || (e.mode & 0o170000) === 0o100000;
}

export function iconFor(entry) {
  if (!entry) return iconPath('file');
  if (entry.dir) {
    const k = knownFolder(entry.path);
    return iconPath(k ? `folder-${k}` : 'folder');
  }
  const kind = kindOf(entry);
  if (kind === 'file' && !entry.ext && entry.mode & 0o111 && !entry.link) return iconPath('file-exec');
  return iconPath(kind === 'file' ? 'file' : `file-${kind === 'script' ? 'exec' : kind}`);
}

export function driveIcon(d) {
  if (!d) return iconPath('drive-hdd');
  if (d.kind === 'system' || d.mountpoint === '/') return iconPath('drive-system');
  if (d.kind === 'optical') return iconPath('drive-optical');
  if (d.kind === 'usb' || d.removable) return iconPath('drive-usb');
  return iconPath('drive-hdd');
}

export function driveName(d, t = shared.t) {
  if (!d) return '';
  if (d.mountpoint === '/' || d.kind === 'system') return t('drives.system');
  const dev = (d.device || '').replace(/^\/dev\//, '');
  const base = d.label || (d.kind === 'optical' ? t('drives.optical') : d.kind === 'usb' || d.removable ? t('drives.usb') : t('drives.local'));
  return dev ? `${base} (${dev})` : base;
}

// ---------------------------------------------------------------- naming helpers
export function splitExt(name, isDir) {
  if (isDir) return [name, ''];
  const m = /^(.+?)((?:\.tar)?\.[^./\s]{1,12})$/i.exec(name);
  if (!m || name.startsWith('.') && name.indexOf('.', 1) < 0) return [name, ''];
  return [m[1], m[2]];
}
export function displayName(entry, showExt = shared.prefs.extensions) {
  if (!entry) return '';
  if (showExt || entry.dir) return entry.name;
  const [stem, ext] = splitExt(entry.name, entry.dir);
  return ext && stem ? stem : entry.name;
}
export const dirname = (p) => (p === '/' ? '/' : p.replace(/\/[^/]+\/?$/, '') || '/');
export const basename = (p) => (p === '/' ? '/' : p.replace(/\/+$/, '').split('/').pop());
export const joinPath = (dir, name) => (dir.endsWith('/') ? dir + name : `${dir}/${name}`);
export function isInside(child, parent) {
  if (parent === '/') return child.startsWith('/') && child !== '/';
  return child.startsWith(`${parent}/`);
}

// ---------------------------------------------------------------- formatting (Windows Explorer conventions)
function locale() {
  return shared.ctx?.lang === 'fr' ? 'fr-FR' : 'en-US';
}
export function formatNumber(n) {
  return new Intl.NumberFormat(locale()).format(n);
}
// Details view "Size" column: always whole kilobytes, rounded up ("12,345 KB").
export function formatKB(bytes, t = shared.t) {
  if (bytes == null) return '';
  return t('size.kb', { n: formatNumber(Math.ceil(bytes / 1024)) });
}
// Three significant digits like Windows ("2.40 KB", "15.3 MB", "153 MB").
export function humanSize(bytes, t = shared.t) {
  if (bytes == null || Number.isNaN(bytes)) return '';
  if (bytes < 1024) return t('size.bytes', { n: formatNumber(bytes), count: bytes });
  const units = ['kb', 'mb', 'gb', 'tb', 'pb'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const digits = v >= 100 ? 0 : v >= 10 ? 1 : 2;
  const n = new Intl.NumberFormat(locale(), { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(Math.floor(v * 10 ** digits) / 10 ** digits);
  return t(`size.${units[i]}`, { n });
}
export function exactSize(bytes, t = shared.t) {
  return t('size.exact', { human: humanSize(bytes, t), n: formatNumber(bytes) });
}
// "10/10/2026 5:30 PM" / "10/10/2026 17:30" (Windows Explorer style: 4-digit year, no comma).
let dateFmt = null;
let timeFmt = null;
let fmtLang = '';
export function formatDate(ms) {
  if (!ms) return '';
  if (fmtLang !== locale()) {
    fmtLang = locale();
    dateFmt = new Intl.DateTimeFormat(fmtLang, { year: 'numeric', month: fmtLang === 'fr-FR' ? '2-digit' : 'numeric', day: fmtLang === 'fr-FR' ? '2-digit' : 'numeric' });
    timeFmt = new Intl.DateTimeFormat(fmtLang, { hour: 'numeric', minute: '2-digit' });
  }
  const d = new Date(ms);
  return `${dateFmt.format(d)} ${timeFmt.format(d)}`;
}
export function formatDateLong(ms) {
  if (!ms) return '';
  return new Intl.DateTimeFormat(locale(), { dateStyle: 'full', timeStyle: 'medium' }).format(new Date(ms));
}

// Group headers for "Group by Date modified" (Windows buckets).
export function dateBucket(ms) {
  const now = new Date();
  const d = new Date(ms);
  const day = 86400000;
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (ms >= startToday + day) return 'future';
  if (ms >= startToday) return 'today';
  if (ms >= startToday - day) return 'yesterday';
  const dow = (now.getDay() + 6) % 7; // Monday = 0
  const startWeek = startToday - dow * day;
  if (ms >= startWeek) return 'thisWeek';
  if (ms >= startWeek - 7 * day) return 'lastWeek';
  const startMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  if (ms >= startMonth) return 'thisMonth';
  const startLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime();
  if (ms >= startLastMonth) return 'lastMonth';
  if (d.getFullYear() === now.getFullYear()) return 'thisYear';
  return 'longAgo';
}
export const DATE_BUCKETS = ['future', 'today', 'yesterday', 'thisWeek', 'lastWeek', 'thisMonth', 'lastMonth', 'thisYear', 'longAgo'];

export function sizeBucket(e) {
  if (e.dir) return 'folders';
  const s = e.size || 0;
  if (s === 0) return 'empty';
  if (s < 16 * 1024) return 'tiny';
  if (s < 1024 * 1024) return 'small';
  if (s < 128 * 1024 * 1024) return 'medium';
  if (s < 1024 * 1024 * 1024) return 'large';
  if (s < 4 * 1024 * 1024 * 1024) return 'huge';
  return 'gigantic';
}
export const SIZE_BUCKETS = ['folders', 'empty', 'tiny', 'small', 'medium', 'large', 'huge', 'gigantic'];

export function nameBucket(name) {
  const c = (name || '').replace(/^\./, '').charAt(0).toUpperCase();
  if (/[0-9]/.test(c)) return '0 – 9';
  if (c >= 'A' && c <= 'H') return 'A – H';
  if (c >= 'I' && c <= 'P') return 'I – P';
  if (c >= 'Q' && c <= 'Z') return 'Q – Z';
  return 'other';
}

const collator = () => new Intl.Collator(locale(), { numeric: true, sensitivity: 'base' });
let coll = null;
let collLang = '';
export function compareNames(a, b) {
  if (collLang !== locale()) {
    coll = collator();
    collLang = locale();
  }
  return coll.compare(a, b);
}

// Highlight every occurrence of the query words in a name (search results).
export function highlight(h, text, query) {
  const words = String(query || '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return [text];
  const lower = text.toLowerCase();
  const marks = new Array(text.length).fill(false);
  for (const w of words) {
    let i = lower.indexOf(w);
    while (i >= 0) {
      for (let j = i; j < i + w.length; j++) marks[j] = true;
      i = lower.indexOf(w, i + w.length);
    }
  }
  const out = [];
  let i = 0;
  while (i < text.length) {
    let j = i;
    while (j < text.length && marks[j] === marks[i]) j++;
    const chunk = text.slice(i, j);
    out.push(marks[i] ? h('mark', { class: 'fx-hl' }, chunk) : chunk);
    i = j;
  }
  return out;
}
