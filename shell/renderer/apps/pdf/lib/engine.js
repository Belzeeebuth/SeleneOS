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
// clipboard and drag & drop — in this shell that is every app. guards() keeps those listeners from
// acting on events that belong to other apps (see the comments below).
import { AuroraL10n } from './l10n.js';

export const PDFJS = 'app://shell/node_modules/pdfjs-dist/';

let loading = null;
let worker = null;
let workerRefs = 0;
let l10n = null;

export function engine() {
  if (!loading) {
    loading = (async () => {
      installGuards();
      const lib = await import(`${PDFJS}build/pdf.mjs`);
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
  if (!worker || worker.destroyed) worker = new lib.PDFWorker({ name: 'aurora-pdf' });
  return worker;
}
export function releaseWorker() {
  workerRefs = Math.max(0, workerRefs - 1);
  if (workerRefs === 0 && worker) {
    const w = worker;
    worker = null;
    // Let documents that are being destroyed finish first.
    setTimeout(() => {
      try {
        if (!worker) w.destroy();
      } catch {}
    }, 3000);
  }
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
  style.textContent = `@scope (.pdf-scroller) {\n${css}\n}`;
  // Before the apps' own stylesheets so that style.css (same specificity) wins.
  document.head.insertBefore(style, document.head.querySelector('link[href*="/apps/"]') || null);
}

// ------------------------------------------------------------------ guards
// Registered before any pdf.js editor exists, so these document-level listeners run before the
// editor's own document listeners and can stop them with stopImmediatePropagation:
//  - drag & drop: the editor turns any image dropped anywhere in the shell into a stamp in the PDF.
//    PDF Reader windows handle their own drops (capture phase on the window), so pdf.js never needs these.
//  - copy / cut / paste: while a tool is active the editor cancels every copy in the document. Only let
//    it act when the clipboard event comes from a document view and annotations are selected.
let guardsInstalled = false;
const editingViews = new Set(); // .pdf-scroller elements whose editor has a selection (set by doc.js)
export const guard = { editingViews };

function installGuards() {
  if (guardsInstalled) return;
  guardsInstalled = true;
  const stopDnD = (e) => {
    if (document.querySelector('.app-pdf .pdf-scroller')) e.stopImmediatePropagation();
  };
  document.addEventListener('dragover', stopDnD);
  document.addEventListener('drop', stopDnD);
  const clip = (e) => {
    // pdf.js only listens to the clipboard while one of our documents has a tool on (focused window).
    if (!document.querySelector('.app-pdf .pdf-root.tool-active')) return;
    const target = document.activeElement;
    const view = target?.closest?.('.pdf-scroller');
    const textSelected = !!document.getSelection()?.toString();
    if (!view || !editingViews.has(view) || (textSelected && e.type === 'copy')) e.stopImmediatePropagation();
  };
  for (const ev of ['copy', 'cut', 'paste']) document.addEventListener(ev, clip);
}
