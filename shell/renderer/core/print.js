// Selene print dialog (shared by the apps).
//   import { printDialog } from '../../core/print.js';
//   const res = await printDialog({
//     title: 'Rapport.txt',          // document name: job title and default PDF file name
//     parent: ctx.win,               // the app window (the dialog is scoped to it)
//     render: 'webcontents',         // 'webcontents': html (string | async ({ pageSize, landscape }) => string)
//     html,                          //                 or webview (an element with printToPDF, e.g. the browser tab)
//                                    // 'pdf': file (absolute path of the PDF) and/or data (its bytes)
//   });
//   -> { action: 'print', printer, job: { jobId } } | { action: 'save', path } | null (cancelled)
//
// Printers come from 'printers:list'; « Enregistrer en PDF » is always offered and is the default when there is
// no printer. Options: copies, pages (all / a range « 1-3, 5 »), orientation, two-sided, paper (A4 in French,
// Letter in English). A live thumbnail shows the first page that will print.
// Rendering: main/ipc/print.js (print:render = hidden window + printToPDF, print:extract = chosen pages of a
// PDF). Sending: main/ipc/printers.js 'printers:print' (file, { printer, title, copies, sides, orientation, media,
// fitToPage }) -> { jobId, printer }.
import { h, icon, ui, clear } from './ui.js';
import { api } from './api.js';
import { i18n } from './i18n.js';
import { notify } from './notify.js';
import { parseRanges, defaultPaper, normalizePrinters, sidesFor } from './print-ranges.js';

export { parseRanges, defaultPaper, normalizePrinters };

const PDF_TARGET = '__pdf__';
const PDFJS = 'app://shell/node_modules/pdfjs-dist/';

const STR = {
  fr: {
    title: 'Imprimer',
    printer: 'Imprimante',
    savePdf: 'Enregistrer en PDF',
    offline: 'hors ligne',
    copies: 'Copies',
    fewer: 'Une copie de moins',
    more: 'Une copie de plus',
    pages: 'Pages',
    all: 'Toutes',
    range: 'Plage',
    rangeHint: 'Par exemple « 1-3, 5 »',
    errEmpty: 'Indiquez les pages à imprimer.',
    errSyntax: 'Écrivez les pages comme « 1-3, 5 ».',
    errOrder: 'Une plage va de la plus petite page à la plus grande.',
    errZero: 'Les pages commencent à 1.',
    errPast_one: 'Le document n’a qu’une page.',
    errPast_other: 'Le document a {count} pages.',
    orientation: 'Orientation',
    portrait: 'Portrait',
    landscape: 'Paysage',
    duplex: 'Recto verso',
    paper: 'Format du papier',
    preview: 'Aperçu de la première page',
    previewing: 'Préparation de l’aperçu…',
    previewFailed: 'L’aperçu n’est pas disponible.',
    pageCount_one: '{count} page',
    pageCount_other: '{count} pages',
    sheets_one: '{count} page à imprimer',
    sheets_other: '{count} pages à imprimer',
    print: 'Imprimer',
    save: 'Enregistrer',
    cancel: 'Annuler',
    printing: 'Envoi à l’imprimante…',
    saving: 'Enregistrement…',
    sent: 'Document envoyé à l’imprimante',
    sentBody: '« {doc} » sur {printer}',
    saved: 'PDF enregistré',
    failed: 'L’impression n’a pas abouti',
    unavailable: 'L’impression n’est pas encore disponible sur ce système. Vous pouvez enregistrer le document en PDF.',
    noPrinter: 'Aucune imprimante. Vous pouvez ajouter une imprimante dans Paramètres.',
    defaultName: 'Document',
  },
  en: {
    title: 'Print',
    printer: 'Printer',
    savePdf: 'Save as PDF',
    offline: 'offline',
    copies: 'Copies',
    fewer: 'One copy fewer',
    more: 'One more copy',
    pages: 'Pages',
    all: 'All',
    range: 'Range',
    rangeHint: 'For example “1-3, 5”',
    errEmpty: 'Enter the pages to print.',
    errSyntax: 'Write the pages like “1-3, 5”.',
    errOrder: 'A range goes from the lower page to the higher one.',
    errZero: 'Pages start at 1.',
    errPast_one: 'The document has only one page.',
    errPast_other: 'The document has {count} pages.',
    orientation: 'Orientation',
    portrait: 'Portrait',
    landscape: 'Landscape',
    duplex: 'Print on both sides',
    paper: 'Paper size',
    preview: 'Preview of the first page',
    previewing: 'Preparing the preview…',
    previewFailed: 'The preview is not available.',
    pageCount_one: '{count} page',
    pageCount_other: '{count} pages',
    sheets_one: '{count} page to print',
    sheets_other: '{count} pages to print',
    print: 'Print',
    save: 'Save',
    cancel: 'Cancel',
    printing: 'Sending to the printer…',
    saving: 'Saving…',
    sent: 'Document sent to the printer',
    sentBody: '“{doc}” on {printer}',
    saved: 'PDF saved',
    failed: 'Printing failed',
    unavailable: 'Printing is not available on this system yet. You can save the document as a PDF.',
    noPrinter: 'No printer. You can add a printer in Settings.',
    defaultName: 'Document',
  },
};

function tr(key, vars) {
  const d = STR[i18n.lang] || STR.en;
  let k = key;
  if (vars?.count !== undefined) {
    const cat = new Intl.PluralRules(i18n.lang === 'fr' ? 'fr-FR' : 'en-US').select(vars.count);
    if (d[`${key}_${cat}`] !== undefined) k = `${key}_${cat}`;
    else if (d[`${key}_other`] !== undefined) k = `${key}_other`;
  }
  const s = d[k] ?? STR.en[k] ?? key;
  return s.replace(/\{(\w+)\}/g, (m, n) => (vars?.[n] !== undefined ? String(vars[n]) : m));
}
export { tr as printText };

const PAPERS = [
  { value: 'A4', fr: 'A4 (21 × 29,7 cm)', en: 'A4 (210 × 297 mm)' },
  { value: 'Letter', fr: 'Lettre US (21,6 × 27,9 cm)', en: 'Letter (8.5 × 11 in)' },
  { value: 'Legal', fr: 'Légal US (21,6 × 35,6 cm)', en: 'Legal (8.5 × 14 in)' },
  { value: 'A5', fr: 'A5 (14,8 × 21 cm)', en: 'A5 (148 × 210 mm)' },
  { value: 'A3', fr: 'A3 (29,7 × 42 cm)', en: 'A3 (297 × 420 mm)' },
];

let pdfjs = null;
async function pdfLib() {
  if (!pdfjs) {
    pdfjs = import(`${PDFJS}build/pdf.mjs`).then((lib) => {
      if (!lib.GlobalWorkerOptions.workerSrc) lib.GlobalWorkerOptions.workerSrc = `${PDFJS}build/pdf.worker.mjs`;
      return lib;
    });
    pdfjs.catch(() => (pdfjs = null));
  }
  return pdfjs;
}

/** Draws page `pageNo` of the PDF bytes into a canvas `width` CSS px wide. -> { canvas, pages } */
export async function renderThumb(bytes, pageNo = 1, width = 220) {
  const lib = await pdfLib();
  const task = lib.getDocument({
    data: bytes,
    isEvalSupported: false,
    enableXfa: false,
    cMapUrl: `${PDFJS}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${PDFJS}standard_fonts/`,
    wasmUrl: `${PDFJS}wasm/`,
  });
  try {
    const doc = await task.promise;
    const pages = doc.numPages;
    const page = await doc.getPage(Math.min(Math.max(1, pageNo), pages));
    const vp1 = page.getViewport({ scale: 1 });
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const vp = page.getViewport({ scale: (width / vp1.width) * dpr });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(vp.width);
    canvas.height = Math.round(vp.height);
    canvas.style.width = `${Math.round(vp.width / dpr)}px`;
    canvas.style.height = `${Math.round(vp.height / dpr)}px`;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp, canvas }).promise;
    return { canvas, pages };
  } finally {
    task.destroy();
  }
}

/** Escape text for the HTML documents the apps hand to print:render. */
export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** A whole document for print:render: Inter / Manrope from the shell, white paper, black text. */
export function printDocument({ title = '', css = '', body = '', lang = i18n.lang } = {}) {
  const font = (fam, file, w) =>
    `@font-face{font-family:"${fam}";font-weight:${w};src:url("app://shell/assets/fonts/${file}") format("woff2")}`;
  return `<!doctype html><html lang="${escapeHtml(lang)}"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>
${font('Inter', 'inter-latin-wght-normal.woff2', '100 900')}
${font('Inter', 'inter-latin-ext-wght-normal.woff2', '100 900')}
${font('Manrope', 'manrope-latin-wght-normal.woff2', '200 800')}
${font('Manrope', 'manrope-latin-ext-wght-normal.woff2', '200 800')}
html,body{margin:0;padding:0;background:#fff;color:#111;font-family:Inter,"Noto Sans","DejaVu Sans",sans-serif;font-size:11pt;line-height:1.45;-webkit-print-color-adjust:exact;print-color-adjust:exact}
${css}
</style></head><body>${body}</body></html>`;
}

function errorText(err) {
  return String(err?.message || err || '').replace(/^Error invoking remote method[^:]*:\s*/, '');
}

export async function printDialog(opts = {}) {
  ui.loadCss('app://shell/core/print.css');
  const { parent, render = 'webcontents' } = opts;
  const lang = i18n.lang;
  const docName = (opts.title || tr('defaultName')).trim() || tr('defaultName');
  const baseName =
    docName
      .replace(/\.[a-z0-9]{1,5}$/i, '')
      .replace(/[/\\:*?"<>|]+/g, ' ')
      .trim()
      .slice(0, 80) || tr('defaultName');

  // ---------------------------------------------------------------- state
  let printers = [];
  try {
    printers = normalizePrinters(await api.invoke('printers:list'));
  } catch {
    printers = []; // no backend yet (ENOHANDLER) or CUPS down: « Enregistrer en PDF » still works
  }
  const def = printers.find((p) => p.isDefault) || printers[0];
  const st = {
    target: def ? def.name : PDF_TARGET,
    copies: 1,
    allPages: true,
    range: '',
    landscape: !!opts.landscape,
    duplex: false,
    paper: opts.paper || defaultPaper(lang),
    pages: 0, // page count of the full document (from the preview)
    busy: false,
  };
  const spooled = new Set();
  let cancelled = false; // « Annuler » / Échap while a job is being prepared: nothing is sent or saved
  let inflight = null;
  let preview = null; // { path, bytes, paper, landscape }
  let previewSeq = 0;

  // ---------------------------------------------------------------- PDF production
  async function produce({ paper, landscape, pageRanges = '' }) {
    if (render === 'pdf') {
      let src = opts.file;
      if (!src && opts.data) {
        const r = await api.invoke('print:store', opts.data);
        spooled.add(r.path);
        src = r.path;
      }
      if (!pageRanges) return { path: src, own: !opts.file ? true : false };
      const r = await api.invoke('print:extract', src, pageRanges, st.pages || 0);
      spooled.add(r.path);
      return { path: r.path, own: true };
    }
    let r;
    if (opts.webview?.printToPDF) {
      const data = await opts.webview.printToPDF({ pageSize: paper, landscape, pageRanges, printBackground: true });
      r = await api.invoke('print:store', data);
    } else {
      const html = typeof opts.html === 'function' ? await opts.html({ pageSize: paper, landscape }) : opts.html;
      r = await api.invoke('print:render', { html, pageSize: paper, landscape, pageRanges, margin: opts.margin });
    }
    spooled.add(r.path);
    return { path: r.path, own: true };
  }

  async function previewBytes() {
    if (render === 'pdf') {
      if (opts.data) return opts.data instanceof Uint8Array ? opts.data : new Uint8Array(opts.data);
      return api.invoke('fs:readBytes', opts.file);
    }
    const r = await produce({ paper: st.paper, landscape: st.landscape });
    const bytes = await api.invoke('print:read', r.path);
    return { bytes, path: r.path };
  }

  // ---------------------------------------------------------------- UI
  const thumbBox = h('div', { class: 'pd-thumb', 'aria-label': tr('preview'), role: 'img' });
  const pageInfo = h('div', { class: 'pd-pageinfo caption text-2' });
  const previewCol = h('div', { class: 'pd-preview' }, thumbBox, pageInfo);

  const printerSel = h(
    'select',
    { class: 'select pd-printer', 'aria-label': tr('printer'), onchange: (e) => ((st.target = e.target.value), sync()) },
    printers.map((p) =>
      h('option', { value: p.name, selected: p.name === st.target }, `${p.label}${/stopped|offline|unavailable|error/i.test(p.state) ? ` (${tr('offline')})` : ''}`),
    ),
    h('option', { value: PDF_TARGET, selected: st.target === PDF_TARGET }, tr('savePdf')),
  );
  const printerIcon = h('span', { class: 'pd-printer-icon' });
  const noPrinterNote = printers.length ? null : h('div', { class: 'pd-note caption text-2' }, tr('noPrinter'));

  const copiesInput = h('input', {
    class: 'input pd-copies',
    type: 'number',
    min: '1',
    max: '999',
    value: '1',
    'aria-label': tr('copies'),
    oninput: (e) => {
      const n = Math.round(Number(e.target.value));
      if (Number.isFinite(n) && n >= 1) st.copies = Math.min(999, n);
    },
    onblur: (e) => (e.target.value = String(st.copies)),
  });
  const step = (d) => {
    st.copies = Math.min(999, Math.max(1, st.copies + d));
    copiesInput.value = String(st.copies);
    sync();
  };
  const copiesRow = row(
    tr('copies'),
    h(
      'div',
      { class: 'pd-stepper' },
      h('button', { class: 'btn subtle icon-btn pd-minus', 'data-tip': tr('fewer'), 'aria-label': tr('fewer'), onclick: () => step(-1) }, icon('minus')),
      copiesInput,
      h('button', { class: 'btn subtle icon-btn pd-plus', 'data-tip': tr('more'), 'aria-label': tr('more'), onclick: () => step(1) }, icon('plus')),
    ),
  );

  const rangeInput = h('input', {
    class: 'input pd-range',
    placeholder: '1-3, 5',
    'aria-label': tr('range'),
    oninput: (e) => {
      st.range = e.target.value;
      sync(true);
    },
  });
  const rangeErr = h('div', { class: 'pd-hint caption' });
  const pagesSeg = ui.segmented({
    options: [
      { value: 'all', label: tr('all') },
      { value: 'range', label: tr('range') },
    ],
    value: 'all',
    onchange: (v) => {
      st.allPages = v === 'all';
      sync(true);
      if (!st.allPages) setTimeout(() => rangeInput.focus(), 0);
    },
  });
  pagesSeg.classList.add('pd-pages');
  const rangeWrap = h('div', { class: 'pd-rangewrap' }, rangeInput, rangeErr);
  const pagesRow = row(tr('pages'), h('div', { class: 'pd-col' }, pagesSeg, rangeWrap));

  const orientSeg = ui.segmented({
    options: [
      { value: 'portrait', label: tr('portrait'), icon: 'file' },
      { value: 'landscape', label: tr('landscape'), icon: 'rectangle' },
    ],
    value: st.landscape ? 'landscape' : 'portrait',
    onchange: (v) => {
      st.landscape = v === 'landscape';
      sync();
      refreshPreview();
    },
  });
  orientSeg.classList.add('pd-orient');
  const orientRow = row(tr('orientation'), orientSeg);

  const duplexToggle = ui.toggle({ checked: false, label: tr('duplex'), onchange: (v) => (st.duplex = v) });
  duplexToggle.classList.add('pd-duplex');
  const duplexRow = h('div', { class: 'pd-row pd-row-toggle' }, duplexToggle);

  const paperSel = ui.select({
    options: PAPERS.map((p) => ({ value: p.value, label: p[lang] || p.en })),
    value: st.paper,
    onchange: (v) => {
      st.paper = v;
      refreshPreview();
    },
  });
  paperSel.classList.add('pd-paper');
  paperSel.setAttribute('aria-label', tr('paper'));
  const paperRow = row(tr('paper'), paperSel);

  const errBox = h('div', { class: 'pd-error', role: 'alert', hidden: true });
  const form = h(
    'div',
    { class: 'pd-form' },
    h('div', { class: 'pd-row pd-row-printer' }, h('label', { class: 'pd-label' }, tr('printer')), h('div', { class: 'pd-printer-line' }, printerIcon, printerSel)),
    noPrinterNote,
    copiesRow,
    pagesRow,
    orientRow,
    paperRow,
    duplexRow,
    errBox,
  );
  const body = h('div', { class: 'pd-body' }, previewCol, form);

  function row(label, control) {
    return h('div', { class: 'pd-row' }, h('label', { class: 'pd-label' }, label), control);
  }

  let primaryBtn = null;
  function rangeState() {
    if (st.allPages) return { ok: true, text: '', count: st.pages, first: 1 };
    return parseRanges(st.range, st.pages || 0);
  }
  function sync(rangeChanged = false) {
    const toPdf = st.target === PDF_TARGET;
    clear(printerIcon).appendChild(icon(toPdf ? 'file-pdf' : 'printer', { size: 20 }));
    copiesRow.hidden = toPdf;
    duplexRow.hidden = toPdf;
    // A PDF as it is (PDF reader) keeps its own page size: orientation and paper only matter for a printer.
    orientRow.hidden = render === 'pdf' && toPdf;
    paperRow.hidden = render === 'pdf' && toPdf;
    rangeWrap.hidden = st.allPages;
    const r = rangeState();
    let msg = '';
    if (!st.allPages && !r.ok && (st.range.trim() || rangeChanged === 'submit')) {
      msg = { empty: tr('errEmpty'), syntax: tr('errSyntax'), order: tr('errOrder'), zero: tr('errZero'), past: tr('errPast', { count: st.pages }) }[r.error] || tr('errSyntax');
    }
    rangeErr.textContent = msg || (st.allPages ? '' : tr('rangeHint'));
    rangeErr.classList.toggle('bad', !!msg);
    rangeInput.classList.toggle('invalid', !!msg);
    rangeInput.setAttribute('aria-invalid', msg ? 'true' : 'false');
    if (st.pages) {
      const n = r.ok ? r.count : st.pages;
      pageInfo.textContent = st.allPages || !r.ok ? tr('pageCount', { count: st.pages }) : tr('sheets', { count: n });
    }
    if (primaryBtn) {
      primaryBtn.textContent = st.busy ? (toPdf ? tr('saving') : tr('printing')) : toPdf ? tr('save') : tr('print');
      primaryBtn.disabled = st.busy || (!st.allPages && !r.ok);
    }
    if (rangeChanged && r.ok && preview) drawThumb(); // the thumbnail shows the first page that will print
  }

  async function drawThumb() {
    if (!preview?.bytes) return;
    const seq = previewSeq;
    const r = rangeState();
    try {
      // pdf.js transfers (detaches) the buffer it is given: hand it a copy.
      const { canvas, pages } = await renderThumb(preview.bytes.slice(), r.ok ? r.first : 1, 196);
      if (seq !== previewSeq) return;
      st.pages = pages;
      clear(thumbBox).appendChild(canvas);
      thumbBox.classList.remove('loading', 'failed');
      thumbBox.classList.toggle('landscape', canvas.width > canvas.height);
      sync();
    } catch (err) {
      if (seq !== previewSeq) return;
      console.warn('[print] preview failed', err);
      thumbBox.classList.remove('loading');
      thumbBox.classList.add('failed');
      clear(thumbBox).append(icon('warning-circle', { size: 24 }), h('span', { class: 'caption' }, tr('previewFailed')));
    }
  }

  let refreshTimer = 0;
  function refreshPreview(immediate = false) {
    clearTimeout(refreshTimer);
    if (render === 'pdf' && preview) return; // the PDF itself: nothing to re-render
    const seq = ++previewSeq;
    thumbBox.classList.add('loading');
    if (!thumbBox.querySelector('canvas')) clear(thumbBox).append(h('div', { class: 'pd-spinner' }), h('span', { class: 'caption text-2' }, tr('previewing')));
    refreshTimer = setTimeout(
      async () => {
        try {
          const res = await previewBytes();
          if (seq !== previewSeq) return;
          const bytes = res?.bytes || res;
          preview = { bytes: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), path: res?.path || null, paper: st.paper, landscape: st.landscape };
          await drawThumb();
        } catch (err) {
          if (seq !== previewSeq) return;
          console.warn('[print] preview failed', err);
          thumbBox.classList.remove('loading');
          thumbBox.classList.add('failed');
          clear(thumbBox).append(icon('warning-circle', { size: 24 }), h('span', { class: 'caption' }, tr('previewFailed')));
        }
      },
      immediate ? 0 : 250,
    );
  }

  function showError(msg) {
    errBox.hidden = !msg;
    errBox.textContent = msg || '';
  }

  // ---------------------------------------------------------------- run
  async function go() {
    const r = rangeState();
    if (!r.ok) {
      sync('submit');
      rangeInput.focus();
      return null;
    }
    const toPdf = st.target === PDF_TARGET;
    let dest = null;
    if (toPdf) {
      const xdg = await api.invoke('fs:xdg').catch(() => ({}));
      dest = await ui.filePicker({ mode: 'save', path: xdg.documents, name: `${baseName}.pdf`, title: tr('savePdf'), filters: [{ name: 'PDF', ext: ['.pdf'] }], parent });
      if (!dest) return null;
    }
    st.busy = true;
    showError('');
    sync();
    try {
      // Same page size and orientation as the preview, all pages: reuse the preview's file.
      const reuse = preview?.path && !r.text && preview.paper === st.paper && preview.landscape === st.landscape;
      const out = reuse ? { path: preview.path } : await produce({ paper: st.paper, landscape: st.landscape, pageRanges: r.text });
      if (cancelled) return null;
      if (toPdf) {
        let saved;
        if (out.path && (out.own || reuse || spooled.has(out.path))) saved = await api.invoke('print:saveAs', out.path, dest);
        else saved = await api.invoke('fs:writeBytes', dest, await api.invoke('fs:readBytes', out.path)).then(() => ({ path: dest }));
        notify({ title: tr('saved'), body: dest.split('/').pop(), icon: 'file-pdf', appId: opts.appId, onClick: () => (opts.shell || window.__aurora?.shell)?.openFile?.(dest) });
        return { action: 'save', path: saved?.path || dest };
      }
      const printer = printers.find((p) => p.name === st.target);
      // main/ipc/printers.js: lp [options] -- FILE (the pages are already cut out of the PDF here).
      const job = await api.invoke('printers:print', out.path, {
        printer: st.target,
        // lp -t: printers.js refuses control characters and titles over 255 characters (a note's long first line).
        title: Array.from(docName.replace(/[\x00-\x1f\x7f]+/g, ' ')).slice(0, 200).join('').trim() || tr('defaultName'),
        copies: st.copies,
        sides: sidesFor(st.duplex, st.landscape),
        orientation: st.landscape ? 'landscape' : 'portrait',
        media: st.paper,
        fitToPage: render === 'pdf',
      });
      notify({ title: tr('sent'), body: tr('sentBody', { doc: docName, printer: printer?.label || st.target }), icon: 'printer', appId: opts.appId });
      return { action: 'print', printer: st.target, job };
    } catch (err) {
      st.busy = false;
      sync();
      showError(err?.code === 'ENOHANDLER' || err?.code === 'ENOTSUP' ? tr('unavailable') : `${tr('failed')}${lang === 'fr' ? ' : ' : ': '}${errorText(err)}`);
      return undefined; // stay open
    } finally {
      st.busy = false;
    }
  }

  const result = await new Promise((resolve) => {
    ui.dialog({
      title: tr('title'),
      body,
      parent,
      className: 'pd-dialog',
      width: 760,
      buttons: [
        { label: st.target === PDF_TARGET ? tr('save') : tr('print'), value: '__go', primary: true },
        { label: tr('cancel'), value: null },
      ],
      onOpen: (dlg, done) => {
        dlg.__print = { st, sync, refresh: refreshPreview };
        primaryBtn = dlg.querySelector('.dialog-footer .btn.primary');
        primaryBtn?.classList.add('pd-go');
        dlg._validate = (v) => {
          if (v !== '__go') return true;
          if (st.busy) return false;
          inflight = go().then((res) => {
            if (res === undefined) return; // error shown in the dialog
            if (res === null) {
              sync();
              return; // save picker cancelled or invalid range: stay
            }
            dlg._validate = null;
            resolve(res);
            done(res);
          });
          return false;
        };
        sync();
        refreshPreview(true);
        setTimeout(() => printerSel.focus({ preventScroll: true }), 0);
      },
    }).then((v) => {
      if (v == null) {
        cancelled = true;
        resolve(null);
      }
    });
  });

  // Temporary PDFs: kept a minute for a printer backend that reads them asynchronously, then removed.
  const keep = result?.action === 'print' ? new Set() : null;
  // A job still being prepared when the dialog was cancelled: remove its files once it has stopped.
  Promise.resolve(inflight)
    .catch(() => {})
    .then(() =>
      setTimeout(
        () => {
          for (const p of spooled) if (!keep?.has(p)) api.invoke('print:discard', p).catch(() => {});
        },
        result?.action === 'print' ? 60000 : 0,
      ),
    );
  return result;
}

export default printDialog;
