// Pure helpers of the Archive Manager (no DOM): paths, the folder tree built from a listing, sorting,
// search, file kinds / icons / type names, creation formats.

export const ARCHIVE_RE = /\.(zip|jar|7z|rar|cab|tar|gz|tgz|xz|txz|bz2|tbz2?|zst|tzst)$/i;
export const isArchiveName = (name) => ARCHIVE_RE.test(name || '');

export const basename = (p) => String(p || '').replace(/\/+$/, '').split('/').pop() || '/';
export const dirname = (p) => {
  const s = String(p || '').replace(/\/+$/, '');
  const i = s.lastIndexOf('/');
  return i <= 0 ? (s.startsWith('/') ? '/' : '') : s.slice(0, i);
};
export const joinPath = (a, b) => (a ? `${a.replace(/\/+$/, '')}/${b}` : b);

/** "photos.tar.gz" -> ["photos", ".tar.gz"] */
export function splitExt(name) {
  const m = /(\.tar\.(gz|xz|bz2|zst|lz|lzma)|\.[^./]{1,8})$/i.exec(name || '');
  return m && m.index > 0 ? [name.slice(0, m.index), m[0]] : [name || '', ''];
}
export const stemOf = (name) => splitExt(name)[0];
export const extOf = (name) => {
  const m = /\.[^./]+$/.exec(name || '');
  return m ? m[0].toLowerCase() : '';
};

// ------------------------------------------------------------------ creation formats
export const FORMATS = [
  { id: 'zip', ext: '.zip', label: 'ZIP', encrypt: true },
  { id: '7z', ext: '.7z', label: '7z', encrypt: true, names: true },
  { id: 'tar.gz', ext: '.tar.gz', label: 'TAR.GZ' },
  { id: 'tar.xz', ext: '.tar.xz', label: 'TAR.XZ' },
  { id: 'tar.zst', ext: '.tar.zst', label: 'TAR.ZST' },
  { id: 'tar.bz2', ext: '.tar.bz2', label: 'TAR.BZ2' },
  { id: 'tar', ext: '.tar', label: 'TAR' },
];
export const LEVELS = [0, 1, 3, 5, 7, 9]; // store, fastest, fast, normal, maximum, ultra
export function formatOfName(name) {
  const n = String(name || '').toLowerCase();
  if (/\.(tar\.gz|tgz)$/.test(n)) return 'tar.gz';
  if (/\.(tar\.xz|txz)$/.test(n)) return 'tar.xz';
  if (/\.(tar\.zst|tzst)$/.test(n)) return 'tar.zst';
  if (/\.(tar\.bz2|tbz2?)$/.test(n)) return 'tar.bz2';
  if (n.endsWith('.tar')) return 'tar';
  if (n.endsWith('.7z')) return '7z';
  if (n.endsWith('.zip')) return 'zip';
  return null;
}
/** Replace (or add) the archive extension of `name` for `format`. */
export function withFormatExt(name, format) {
  const f = FORMATS.find((x) => x.id === format) || FORMATS[0];
  const base = String(name || '').replace(/\.(tar\.(gz|xz|zst|bz2)|tgz|txz|tzst|tbz2?|tar|7z|zip)$/i, '');
  return `${base}${f.ext}`;
}

// ------------------------------------------------------------------ file kinds
const KINDS = {
  image: ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.avif', '.ico', '.tif', '.tiff', '.heic', '.jfif'],
  audio: ['.mp3', '.wav', '.ogg', '.oga', '.flac', '.m4a', '.aac', '.opus', '.wma', '.mid', '.midi'],
  video: ['.mp4', '.webm', '.mkv', '.mov', '.avi', '.ogv', '.m4v', '.wmv', '.mpg', '.mpeg', '.3gp'],
  text: ['.txt', '.log', '.ini', '.conf', '.cfg', '.md', '.markdown', '.rst', '.nfo', '.text', '.list', '.csv', '.tsv', '.srt', '.vtt'],
  code: ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.c', '.h', '.cpp', '.hpp', '.cc', '.rs', '.go', '.java', '.kt', '.rb', '.php', '.pl',
    '.lua', '.json', '.xml', '.yml', '.yaml', '.toml', '.css', '.scss', '.less', '.vue', '.svelte', '.sql', '.cs', '.swift', '.diff', '.patch',
    '.sh', '.bash', '.zsh', '.fish', '.mk', '.cmake', '.gradle', '.properties', '.env', '.gitignore', '.dockerfile'],
  web: ['.html', '.htm', '.xhtml', '.url'],
  archive: ['.zip', '.jar', '.tar', '.gz', '.tgz', '.xz', '.txz', '.bz2', '.tbz', '.tbz2', '.7z', '.rar', '.zst', '.tzst', '.lz', '.lzma', '.cab'],
  package: ['.deb', '.rpm', '.snap', '.flatpak', '.apk', '.msi'],
  exec: ['.exe', '.bin', '.run', '.appimage', '.dll', '.so'],
  pdf: ['.pdf'],
  doc: ['.doc', '.docx', '.odt', '.rtf', '.pages'],
  sheet: ['.xls', '.xlsx', '.ods', '.numbers'],
  slides: ['.ppt', '.pptx', '.odp', '.key'],
  disc: ['.iso', '.img', '.dmg'],
  font: ['.ttf', '.otf', '.woff', '.woff2'],
  mail: ['.eml', '.msg', '.mbox'],
};
const KIND_OF = new Map();
for (const [k, list] of Object.entries(KINDS)) for (const e of list) KIND_OF.set(e, k);
const NAMELESS_TEXT = new Set(['readme', 'license', 'licence', 'copying', 'authors', 'changelog', 'makefile', 'dockerfile', 'news', 'todo', 'install', 'notice']);

export function kindOf(node) {
  if (!node) return 'file';
  if (node.dir) return 'folder';
  const ext = extOf(node.name);
  if (!ext && NAMELESS_TEXT.has(String(node.name).toLowerCase())) return 'text';
  return KIND_OF.get(ext) || 'file';
}
const ICON = {
  folder: 'folder', image: 'file-image', audio: 'file-audio', video: 'file-video', text: 'file-text', code: 'file-code', web: 'file-web',
  archive: 'file-archive', package: 'file-package', exec: 'file-exec', pdf: 'file-pdf', doc: 'file-doc', sheet: 'file-sheet',
  slides: 'file-slides', disc: 'file-disc', font: 'file-font', mail: 'file-mail', file: 'file',
};
export const iconUrl = (node) => `app://shell/apps/archive/icons/${ICON[kindOf(node)] || 'file'}.svg`;
export const IMAGE_PREVIEW = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.avif', '.ico', '.jfif']);
export function previewKind(node) {
  if (!node || node.dir) return null;
  const k = kindOf(node);
  if (IMAGE_PREVIEW.has(extOf(node.name))) return 'image';
  if (k === 'text' || k === 'code' || k === 'web') return 'text';
  return null;
}

/** Localised type name ("Text Document", "PNG File"…) — t() keys under "types.*". */
export function typeName(node, t) {
  if (!node) return '';
  if (node.dir) return t('types.folder');
  const ext = extOf(node.name);
  if (node.link != null) return t('types.link');
  const named = {
    '.txt': 'text', '.md': 'markdown', '.pdf': 'pdf', '.zip': 'zip', '.jar': 'jar', '.7z': 'sevenz', '.rar': 'rar', '.png': 'png', '.jpg': 'jpeg',
    '.jpeg': 'jpeg', '.gif': 'gif', '.svg': 'svg', '.mp3': 'mp3', '.mp4': 'mp4', '.html': 'html', '.htm': 'html', '.js': 'javascript',
    '.json': 'json', '.css': 'css', '.py': 'python', '.sh': 'shell', '.log': 'log', '.csv': 'csv', '.xml': 'xml', '.exe': 'exe', '.iso': 'iso',
    '.gz': 'gzip', '.tgz': 'gzip', '.xz': 'xz', '.bz2': 'bzip2', '.zst': 'zstd', '.tar': 'tar', '.deb': 'deb', '.ttf': 'font', '.otf': 'font',
  }[ext];
  if (named) return t(`types.${named}`);
  if (!ext) return t('types.file');
  return t('types.generic', { ext: ext.slice(1).toUpperCase() });
}

// ------------------------------------------------------------------ the folder tree
/**
 * Build the folder tree of a listing. Node = { name, path, dir, entry, parent, children: Map, size, packed,
 * mtime, encrypted, link, files, dirs, implicit }. Folders that only appear as a prefix ("a/b/c.txt" without
 * an "a/" entry) are created as implicit nodes. A file used as a folder ("a" and "a/b") becomes a folder.
 */
export function buildTree(entries, rootName = '') {
  const root = mkNode(rootName, '', null);
  const all = new Map([['', root]]);
  for (const e of entries) {
    const parts = e.path.split('/');
    let cur = root;
    for (let i = 0; i < parts.length; i++) {
      const p = parts.slice(0, i + 1).join('/');
      let n = cur.children.get(parts[i]);
      if (!n) {
        n = mkNode(parts[i], p, cur);
        cur.children.set(parts[i], n);
        all.set(p, n);
      }
      if (i === parts.length - 1) {
        n.entry = e;
        n.implicit = false;
        if (!e.dir && !n.children.size) n.dir = false;
        n.size = e.dir ? 0 : e.size || 0;
        n.packed = e.packed;
        n.mtime = e.mtime;
        n.encrypted = !!e.encrypted;
        n.link = e.link ?? null;
        n.mode = e.mode;
        n.method = e.method || '';
      } else if (!n.dir) {
        n.dir = true; // a "file" that also has children
      }
      cur = n;
    }
  }
  // totals (post-order, iterative)
  const order = [];
  const stack = [root];
  while (stack.length) {
    const n = stack.pop();
    order.push(n);
    if (n.dir) for (const c of n.children.values()) stack.push(c);
  }
  for (let i = order.length - 1; i >= 0; i--) {
    const n = order[i];
    if (!n.dir) continue;
    let size = 0;
    let packed = 0;
    let files = 0;
    let dirs = 0;
    let mtime = n.entry?.mtime ?? null;
    let enc = false;
    for (const c of n.children.values()) {
      if (c.dir) {
        dirs += 1 + c.dirs;
        files += c.files;
      } else files++;
      size += c.dir ? c.tsize : c.size;
      packed += c.dir ? c.tpacked : c.packed || 0;
      if (c.mtime != null && (n.implicit || mtime == null) && (mtime == null || c.mtime > mtime)) mtime = c.mtime;
      if (c.encrypted) enc = true;
    }
    n.tsize = size;
    n.tpacked = packed;
    n.files = files;
    n.dirs = dirs;
    if (n.implicit || n.mtime == null) n.mtime = mtime;
    n.anyEncrypted = enc;
  }
  return { root, all };
}
function mkNode(name, path, parent) {
  return { name, path, dir: true, entry: null, parent, children: new Map(), size: 0, packed: null, mtime: null, encrypted: false, link: null, files: 0, dirs: 0, tsize: 0, tpacked: 0, implicit: true };
}
export function ancestors(node) {
  const out = [];
  for (let n = node; n; n = n.parent) out.unshift(n);
  return out;
}

const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
/** Every node below `root` whose name contains `query` (accent and case insensitive), files and folders. */
export function search(root, query, limit = 5000) {
  const q = fold(query).trim();
  if (!q) return [];
  const out = [];
  const stack = [...root.children.values()];
  while (stack.length && out.length < limit) {
    const n = stack.pop();
    if (fold(n.name).includes(q)) out.push(n);
    if (n.dir) for (const c of n.children.values()) stack.push(c);
  }
  return out;
}

export function makeSorter(key, dir, locale) {
  const coll = new Intl.Collator(locale, { numeric: true, sensitivity: 'base' });
  const sgn = dir === 'desc' ? -1 : 1;
  const val = {
    size: (n) => (n.dir ? n.tsize : n.size),
    packed: (n) => (n.dir ? n.tpacked : n.packed ?? -1),
    ratio: (n) => ratioOf(n.dir ? n.tsize : n.size, n.dir ? n.tpacked : n.packed) ?? -1,
    mtime: (n) => n.mtime ?? 0,
  };
  return (a, b) => {
    if (a.dir !== b.dir) return a.dir ? -1 : 1; // folders first, like Explorer
    let r = 0;
    if (key === 'type') r = coll.compare(extOf(a.name), extOf(b.name));
    else if (key === 'location') r = coll.compare(a.parent?.path || '', b.parent?.path || '');
    else if (val[key]) r = val[key](a) - val[key](b);
    if (!r) r = coll.compare(a.name, b.name);
    return r * sgn;
  };
}

/** Space saved by compression, 0..1 (Windows' "Ratio" column), or null when unknown. */
export function ratioOf(size, packed) {
  if (packed == null || !size) return null;
  return Math.max(0, 1 - packed / size);
}

/** Unix permission string of a mode ("-rw-r--r--"). */
export function modeString(mode, dir) {
  if (mode == null) return '';
  const t = dir ? 'd' : (mode & 0o170000) === 0o120000 ? 'l' : '-';
  const r = (b, c) => (mode & b ? c : '-');
  return t + r(0o400, 'r') + r(0o200, 'w') + r(0o100, 'x') + r(0o40, 'r') + r(0o20, 'w') + r(0o10, 'x') + r(4, 'r') + r(2, 'w') + r(1, 'x');
}

/** A shortcut in the UI language: key names come from t('keys.*') ("Shift" -> "Maj", "Del" -> "Suppr"). */
export function keyLabel(combo, t) {
  const names = { Ctrl: 'ctrl', Shift: 'shift', Alt: 'alt', Del: 'del', Enter: 'enter', Backspace: 'backspace' };
  return String(combo)
    .split('+')
    .map((k) => (names[k] ? t(`keys.${names[k]}`) : k))
    .join('+');
}

/** Compression method as 7-Zip names it, with "Store" / "Copy" (no compression) in the UI language. */
export function methodName(m, t) {
  return String(m || '').replace(/\b(Store|Copy)\b/g, () => t('props.stored'));
}

/** "3 files, 1 folder" with the right plurals. */
export function containsText(files, dirs, t, i18n) {
  return `${t('props.nFiles', { count: files, n: i18n.formatNumber(files) })}, ${t('props.nDirs', { count: dirs, n: i18n.formatNumber(dirs) })}`;
}
