// pdf.js loader (pdfjs-dist, served from app://shell/node_modules/pdfjs-dist/).
//   const { lib, viewer, l10n } = await engine();   // lib = pdf.mjs, viewer = web/pdf_viewer.mjs
//   lib.getDocument({ data, ...docParams(), worker: sharedWorker() })
// Security: the PDF never runs code. Scripting needs a PDFScriptingManager, which is never created;
// XFA is off; isEvalSupported is passed for older builds (v6 has no eval path at all).
//
// pdf_viewer.css is written for a whole page (it styles :root, .dialog, .sidebar…). It is loaded once,
// rewritten into  @scope (.pdf-scroller) { … }  so it only reaches the document views, and its
// image URLs are made absolute.
//
// The annotation editor (highlight / ink / free text) listens on window and document for keys,
// clipboard and drag & drop — in this shell that is every app. patchEditor() neutralizes the drag & drop
// handlers and keeps the clipboard ones to events that belong to a PDF view (see the comments below).
import { AuroraL10n } from './l10n.js';

export const PDFJS = 'app://shell/node_modules/pdfjs-dist/';

let loading = null;
let worker = null;
let workerRefs = 0;
let workerTimer = 0;
let l10n = null;

export function engine() {
  if (!loading) {
    loading = (async () => {
      const lib = await import(`${PDFJS}build/pdf.mjs`);
      patchEditor(lib);
      if (!globalThis.pdfjsLib) globalThis.pdfjsLib = lib; // pdf_viewer.mjs reads globalThis.pdfjsLib
      lib.GlobalWorkerOptions.workerSrc = `${PDFJS}build/pdf.worker.mjs`;
      const viewer = await import(`${PDFJS}web/pdf_viewer.mjs`);
      await injectViewerCss();
      l10n ||= new AuroraL10n();
      return { lib, viewer, l10n };
    })().catch((err) => {
      loading = null;
      throw err;
    });
  }
  return loading;
}

export function docParams() {
  return {
    cMapUrl: `${PDFJS}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${PDFJS}standard_fonts/`,
    wasmUrl: `${PDFJS}wasm/`,
    iccUrl: `${PDFJS}iccs/`,
    enableXfa: false,
    isEvalSupported: false,
    stopAtErrors: false,
  };
}

/** One worker thread for every open document (ref-counted by windows). */
export function acquireWorker(lib) {
  workerRefs++;
  // A window opened while the last one is closing reuses the worker that was about to go.
  clearTimeout(workerTimer);
  workerTimer = 0;
  if (!worker || worker.destroyed) worker = new lib.PDFWorker({ name: 'aurora-pdf' });
  return worker;
}
export function releaseWorker() {
  workerRefs = Math.max(0, workerRefs - 1);
  if (workerRefs > 0 || !worker) return;
  // Let documents that are being destroyed finish first (their "Terminate" replies come from the worker).
  // The worker is destroyed even if another one was created meanwhile: an orphaned worker thread would keep
  // every document it served — and their windows' DOM — alive.
  clearTimeout(workerTimer);
  workerTimer = setTimeout(() => {
    workerTimer = 0;
    if (workerRefs > 0 || !worker) return;
    const w = worker;
    worker = null;
    try {
      w.destroy();
    } catch {}
  }, 3000);
}
/** Test / diagnostics hook. */
export function workerInfo() {
  return { refs: workerRefs, alive: !!worker && !worker.destroyed, pendingDestroy: !!workerTimer };
}

async function injectViewerCss() {
  if (document.getElementById('aurora-pdfjs-css')) return;
  let css = '';
  try {
    const res = await fetch(`${PDFJS}web/pdf_viewer.css`);
    if (res.ok) css = await res.text();
  } catch {}
  if (!css) throw new Error('pdf_viewer.css could not be loaded');
  css = css
    .replace(/:root/g, ':scope')
    .replace(/color-scheme:\s*light dark;/g, '') // follow the shell / window theme, not the OS preference
    .replace(/url\((["']?)images\//g, `url($1${PDFJS}web/images/`)
    .replace(/@media print\s*\{/, '@media (aurora-never) {'); // printing is not supported here
  const style = document.createElement('style');
  style.id = 'aurora-pdfjs-css';
  // pdf.js reads two of its variables from the document root (getComputedStyle(documentElement)): keep them
  // there too, or the free-text editor gets NaN positions.
  style.textContent = `:root { --freetext-padding: 2px; --outline-width: 2px; }\n@scope (.pdf-scroller) {\n${css}\n}`;
  // Before the apps' own stylesheets so that style.css (same specificity) wins.
  document.head.insertBefore(style, document.head.querySelector('link[href*="/apps/"]') || null);
}

// ------------------------------------------------------------------ editor patches
// pdf.js' AnnotationEditorUIManager binds these prototype methods when it adds its document-level
// listeners, so patching the prototype once (before any viewer exists) changes what every editor does,
// without touching the listeners other apps register on the document:
//  - drag & drop: the editor turns any image dropped anywhere in the shell into a stamp in the PDF.
//    PDF Reader windows handle their own drops (capture phase on the window): pdf.js never needs these.
//  - copy / cut / paste: while a tool is active the editor cancels every clipboard event of the document.
//    Only let it act when the event comes from a document view whose editor has a selection.
const editingViews = new Set(); // .pdf-scroller elements whose editor has a selection (set by doc.js)
export const guard = { editingViews };

function clipboardIsOurs(e) {
  const view = document.activeElement?.closest?.('.pdf-scroller');
  if (!view || !editingViews.has(view)) return false;
  // Selected text (not annotations) is copied by the browser as usual.
  if (e?.type === 'copy' && document.getSelection()?.toString()) return false;
  return true;
}

function patchEditor(lib) {
  const P = lib.AnnotationEditorUIManager?.prototype;
  if (!P || P.__auroraPatched) return;
  Object.defineProperty(P, '__auroraPatched', { value: true });
  P.dragOver = function () {};
  P.drop = function () {};
  for (const name of ['copy', 'cut', 'paste']) {
    const orig = P[name];
    if (typeof orig !== 'function') continue;
    P[name] = function (e) {
      if (clipboardIsOurs(e)) return orig.call(this, e);
    };
  }
}
