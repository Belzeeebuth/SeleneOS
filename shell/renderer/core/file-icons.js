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
import { lookKey } from './app-icon-art.js';
import { FILE_ICONS, fileLookKey, fileIconLook, fileIconSvg, fileTypeTints } from './file-icon-art.js';
import { iconInner } from './icons.js';

export const FILE_ICON_BASE = 'app://shell/apps/files/icons/';
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
function iconUrl(name, look) {
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
  const key = `${look}|${mode()}|${document.documentElement.dataset.iconPack || ''}`;
  if (key === applied) return;
  let css = '';
  try {
    css = sheet(look, mode());
  } catch (err) {
    console.warn('[file-icons] look failed', look, err);
  }
  // nothing drawn yet (Phosphor not loaded): try again on the next change
  applied = css || look === 'cold' ? key : '';
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
  url(name) {
    return iconUrl(name, currentLook());
  },
};
