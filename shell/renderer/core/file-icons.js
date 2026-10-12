// The Fichiers icons (folders, file types, drives) follow the look, like the Selene app icons (core/packs.js).
//
//   import { fileIcons } from './file-icons.js';
//   fileIcons.init()        boot (called by packs.init): draws the current look and follows <html> changes
//   fileIcons.look          'cold' | 'neutral' | 'warm' | 'contrast-dark' | 'contrast-light'
//   fileIcons.url(name)     data: URL of one icon (FILE_ICONS key) in the current look (the static file in cold)
//
// Fichiers, its dialogs and its drag pictures use <img src="app://shell/apps/files/icons/<name>.svg"> (apps/files/
// lib/types.js). Those static files are the cold look (Nocturne). For the other looks a style sheet maps each file to
// the same icon drawn in the look's colours (core/file-icon-art.js), with `content: url()` as packs.js does for the app
// icons, so every picture on screen follows at once and the src attributes never change. The Phosphor file-type
// glyphs of the desktop and the Lanceur (.ft-* classes, core/shell.css) get the same palette. Each look's sheet is built
// once and cached; a change of <html data-ambiance / data-theme / data-style / data-icon-pack> (theme.js, inside its
// cross-fade) swaps it in the same frame. Cold adds no rule at all: Nocturne looks exactly as before.
// The colourful packs of the finishes (<html data-icon-pack="halo|prisme">, core/packs.js) have their own Fichiers
// pictures (assets/icons/packs/<pack>/<name>.svg, tools/gen-finish-icons.mjs): every Fichiers picture is mapped to
// them, and so are the Phosphor file-type glyphs of the desktop, the Lanceur and the file pickers (the picture as the
// glyph's background, the glyph hidden; picked by its .ft-* class or its icon name). Contraste élevé never gets them
// (packs.js draws selene there).
import { lookKey } from './app-icon-art.js';
import { FILE_ICONS, fileLookKey, fileIconLook, fileIconSvg, fileTypeTints } from './file-icon-art.js';
import { iconInner } from './icons.js';

export const FILE_ICON_BASE = 'app://shell/apps/files/icons/';
// the colourful packs of the finishes: one static SVG per FILE_ICONS name
export const STATIC_ICON_PACKS = ['halo', 'prisme'];
export const PACK_ICON_BASE = 'app://shell/assets/icons/packs/';
// file-type classes (.ft-*: desktop, Lanceur) and file icon names (ui.fileIcon: desktop, file pickers) -> FILE_ICONS
const FT_FILE = { dir: 'folder', txt: 'file-text', doc: 'file-doc', xls: 'file-sheet', ppt: 'file-slides', pdf: 'file-pdf', img: 'file-image', audio: 'file-audio', video: 'file-video', zip: 'file-archive', code: 'file-code' };
const NAME_FILE = { folder: 'folder', document: 'file', document_text: 'file-text', document_pdf: 'file-pdf', image: 'file-image', music_note_2: 'file-audio', video: 'file-video', folder_zip: 'file-archive', code: 'file-code', mail: 'file-mail', cd: 'file-disc' };
const staticPack = () => {
  const p = document.documentElement.dataset.iconPack;
  return STATIC_ICON_PACKS.includes(p) && document.documentElement.dataset.style !== 'contrast' ? p : null;
};
/** The CSS of a colourful pack: the Fichiers pictures and the file-type glyphs drawn with its icons. */
function packSheet(pack) {
  const u = (name) => cssUrl(`${PACK_ICON_BASE}${pack}/${name}.svg`);
  const rules = Object.keys(FILE_ICONS).map((name) => `img[src="${FILE_ICON_BASE}${name}.svg"]:not([data-icon-fixed]) { content: ${u(name)}; }`);
  // The Phosphor glyphs (<span class="icon"><svg>) get the picture as a background, their own glyph hidden: a
  // `content: url()` there would make them images the desktop's pointer drag cannot hold (Chromium drags the picture).
  const glyph = (sel, name) =>
    `${sel} { background: ${u(name)} center / contain no-repeat; }\n:is(${sel}) > :is(svg, .icon) { visibility: hidden; }`;
  // by icon name: file pickers, the desktop (its folders and plain pages, and the glyph of an image it cannot preview)
  for (const [n, f] of Object.entries(NAME_FILE)) {
    rules.push(glyph(`:is(.fp-row, .desk-fi, .desk-thumb) > .icon[data-icon="${n}"], .desk-fi.icon[data-icon="${n}"], .desk-page:has(> .icon[data-icon="${n}"])`, f));
  }
  // by file-type class (more precise: documents, sheets, slides): the desktop and the Lanceur's results / recent files
  for (const [ft, f] of Object.entries(FT_FILE)) rules.push(glyph(`:root .desk-fi.ft-${ft}, :root .desk-page.ft-${ft}, .ft-${ft} > .icon`, f));
  return rules.join('\n');
}
const CSS_ID = 'aurora-fileicons-css';
const WEIGHT = { r: 'regular', b: 'bold' };
const glyphOf = (name, w) => iconInner(name, { weight: WEIGHT[w] || 'regular' }).inner;
const svgUrl = (svg) => `data:image/svg+xml,${encodeURIComponent(svg)}`;
const cssUrl = (u) => `url("${String(u).replace(/["\\\n]/g, (c) => `\\${c.charCodeAt(0).toString(16)} `)}")`;

const mode = () => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
const currentLook = () => {
  const d = document.documentElement.dataset;
  return fileLookKey(lookKey({ style: d.style, ambiance: d.ambiance, theme: d.theme }));
};

const urls = new Map(); // `${look}|${name}` -> data: URL
function iconUrl(name, look, pack = null) {
  if (pack && FILE_ICONS[name]) return `${PACK_ICON_BASE}${pack}/${name}.svg`;
  if (look === 'cold' || !FILE_ICONS[name]) return `${FILE_ICON_BASE}${name}.svg`;
  const key = `${look}|${name}`;
  if (!urls.has(key)) urls.set(key, svgUrl(fileIconSvg(name, fileIconLook(look), glyphOf)));
  return urls.get(key);
}

const sheets = new Map(); // `${look}|${mode}` -> CSS text
function sheet(look, m) {
  const key = `${look}|${m}`;
  if (sheets.has(key)) return sheets.get(key);
  const rules = [];
  if (look !== 'cold') {
    for (const name of Object.keys(FILE_ICONS)) rules.push(`img[src="${FILE_ICON_BASE}${name}.svg"]:not([data-icon-fixed]) { content: ${cssUrl(iconUrl(name, look))}; }`);
  }
  // Phosphor file-type glyphs (desktop, Lanceur): only in the default icon pack; the other packs tint them their own way
  const tints = fileTypeTints(look, m);
  if (tints) {
    const P = ':root[data-icon-pack="selene"]';
    for (const ft of ['doc', 'xls', 'ppt', 'pdf', 'img', 'audio', 'video', 'zip', 'code', 'dir']) rules.push(`${P} .ft-${ft} { color: ${tints[ft]}; }`);
    rules.push(`${P} .desk-fi.folder-icon { color: ${tints.folder}; }`);
    rules.push(`${P} .desk-fi.desk-page.ft-file { color: ${tints.page}; }`);
    rules.push(`${P} .desk-link { color: ${tints.link}; }`);
  }
  const css = rules.join('\n');
  // the data: URLs are only needed inside the sheet: keep the cache small
  if (sheets.size > 12) sheets.clear();
  sheets.set(key, css);
  return css;
}

let applied = '';
function apply() {
  const look = currentLook();
  const pack = staticPack();
  const key = `${look}|${mode()}|${document.documentElement.dataset.iconPack || ''}`;
  if (key === applied) return;
  let css = '';
  try {
    css = pack ? packSheet(pack) : sheet(look, mode());
  } catch (err) {
    console.warn('[file-icons] look failed', look, err);
  }
  // nothing drawn yet (Phosphor not loaded): try again on the next change
  applied = css || look === 'cold' || pack ? key : '';
  let el = document.getElementById(CSS_ID);
  if (!css) {
    el?.remove();
    return;
  }
  if (!el) {
    el = document.createElement('style');
    el.id = CSS_ID;
    document.head.appendChild(el);
  }
  if (el.textContent !== css) el.textContent = css;
}

let inited = false;
export const fileIcons = {
  init() {
    if (inited) return;
    inited = true;
    apply();
    new MutationObserver(apply).observe(document.documentElement, { attributes: true, attributeFilter: ['data-ambiance', 'data-theme', 'data-style', 'data-icon-pack'] });
  },
  /** Re-apply (e.g. once the Phosphor glyphs are loaded). */
  refresh() {
    applied = '';
    apply();
  },
  get look() {
    return currentLook();
  },
  /** The colourful pack drawing the Fichiers icons ('halo' | 'prisme'), or null (the Selene looks). */
  get pack() {
    return staticPack();
  },
  url(name) {
    return iconUrl(name, currentLook(), staticPack());
  },
};
