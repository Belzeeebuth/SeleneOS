// Numérisation (Scan): documents and photos from a scanner, through SANE (main/ipc/scan.js: scanimage as the user).
//   Left panel: the scanner (+ « Rechercher à nouveau »), source (Vitre / Chargeur / Chargeur recto verso), mode
//   (Couleur / Niveaux de gris / Noir et blanc), resolution presets 150 / 300 / 600 (the scanner's nearest value),
//   paper size for the feeder, « Détecter le document » after the preview, Aperçu and Numériser (progress, Annuler);
//   then the saving part: format (PDF / JPEG / PNG), Enregistrer, Enregistrer sous…, Envoyer par courriel, Nouveau
//   document.
//   Main area: the glass preview (a fast low-resolution scan) with a selection the user drags, resizes (8 handles)
//   or moves with the keyboard, or a scanned page (rotate, move, brightness / contrast, delete).
//   Bottom strip: Aperçu, the pages (click, drag to reorder, arrow keys, Ctrl+arrows to move, Delete), « Ajouter une
//   page ». The feeder scans every sheet (batch), pages appear as they come.
//   Saving: PDF written here (lib/pdf.js: one JPEG per page at its physical size), or one JPEG / PNG per page (dpi
//   written in JFIF / pHYs) to <Documents>/Numérisations (« Scans » in English; an existing folder in the other
//   language is kept), then « Ouvrir » / « Afficher dans Fichiers ». « Envoyer par courriel » saves first, then opens a
//   Courrier message with the files attached ({ compose: { attachments } }).
// Keys: Ctrl+S save, Ctrl+Shift+S save as; in the strip ←/→ pick a page, Ctrl+←/→ move it, Suppr deletes it.
// Prefs (ctx.storage 'prefs'): device, source, mode, res, paper, format, autoCrop.
// win.el.__scan exposes the state for tests.
import { buildPdf, setJpegDpi, setPngDpi } from './lib/pdf.js';
import { detectDocument, presetResolutions, clampArea, PAPER, paperArea, filterOf } from './lib/image.js';

const FOLDER_NAMES = ['Numérisations', 'Scans'];
const MIN_MM = 5;
const pad = (n) => String(n).padStart(2, '0');
const stamp = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}`;
const errText = (e) => String(e?.message || e || '').replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const EXT = { pdf: '.pdf', jpeg: '.jpg', png: '.png' };

export default {
  async launch(ctx) {
    const { win, h, icon, ui, t, api, shell } = ctx;
    const P = { device: '', source: '', mode: 'color', res: 300, paper: 'a4', format: 'pdf', autoCrop: false };
    Object.assign(P, (await ctx.storage.get('prefs', {}).catch(() => ({}))) || {});
    const savePrefs = () => ctx.storage.set('prefs', { ...P }).catch(() => {});

    // ---------------------------------------------------------------- state
    let status = 'searching'; // searching | ready | none | missing
    let devices = [];
    let simulated = false;
    let opts = null; // scan:options of the device + source
    let optsLoading = false;
    let optsSeq = 0;
    let preview = null; // { path, url, width, height, pixels: ImageData | null }
    let sel = null; // { left, top, width, height } in mm
    let pages = []; // { id, path, width, height, dpi, mode, rotation, brightness, contrast, thumb, display }
    let current = 'preview'; // 'preview' | page id
    let job = null; // { id, kind, percent, page, cancelling, added: [] }
    let jobDone = null; // the scan:scan promise while a job runs
    let saving = null; // { n, count }
    let note = null; // { kind, title, message, actions, key }
    let noteTimer = 0;
    let dirty = false;
    let lastSaved = null; // { files, dir, format }
    let undo = null; // { page, index }
    let adjustOpen = false;
    let closed = false;
    let pageSeq = 0;

    // ---------------------------------------------------------------- DOM skeleton
    const side = h('aside', { class: 'scan-side', 'aria-label': t('scanSection') });
    const toolbar = h('div', { class: 'scan-toolbar', role: 'toolbar' });
    const noteEl = h('div', { class: 'scan-note-wrap', 'aria-live': 'polite' });
    const previewImg = h('img', { class: 'scan-preview-img', alt: '', draggable: false });
    const selEl = h(
      'div',
      { class: 'scan-sel', tabIndex: 0, role: 'group' },
      ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map((d) => h('span', { class: `scan-handle h-${d}`, dataset: { h: d }, 'aria-hidden': 'true' })),
    );
    const glassHint = h('div', { class: 'scan-glass-hint' });
    const glass = h('div', { class: 'scan-glass' }, previewImg, selEl, glassHint);
    const pageCanvas = h('canvas', { class: 'scan-page-canvas', role: 'img' });
    const pageWrap = h('div', { class: 'scan-page' }, pageCanvas);
    const emptyEl = h('div', { class: 'scan-empty' });
    const adjustEl = h('div', { class: 'scan-adjust', role: 'dialog', hidden: true });
    const stage = h('div', { class: 'scan-stage' }, glass, pageWrap, emptyEl, adjustEl, noteEl);
    const strip = h('div', { class: 'scan-strip' });
    const main = h('div', { class: 'scan-main' }, toolbar, stage, strip);
    const root = h('div', { class: 'scan-root', tabIndex: -1 }, side, main);
    win.body.appendChild(root);

    // ---------------------------------------------------------------- small builders
    const device = () => devices.find((d) => d.name === P.device) || null;
    const curPage = () => (current === 'preview' ? null : pages.find((p) => p.id === current) || null);
    const source = () => (opts?.sources || []).find((s) => s.id === P.source) || (opts?.sources || []).find((s) => s.id === opts?.source) || (opts?.sources || [])[0] || null;
    const feeder = () => /^adf/.test(source()?.kind || '') || (!!opts && !(opts.sources || []).length && device()?.kind === 'sheetfed');
    const modeKind = () => (opts?.modes || []).find((m) => m.kind === P.mode)?.kind || (opts?.modes || []).find((m) => m.kind === 'color')?.kind || opts?.modes?.[0]?.kind || null;
    const presets = () => (opts?.resolutions && (opts.resolutions.list || opts.resolutions.range) ? presetResolutions(opts.resolutions) : []);
    const dpi = () => {
      const ps = presets();
      if (!ps.length) return null;
      return (ps.find((p) => p.preset === Number(P.res)) || ps.find((p) => p.preset === 300) || ps[0]).dpi;
    };
    const fullArea = () => (opts?.area ? { left: 0, top: 0, width: opts.area.width, height: opts.area.height } : null);
    const areaMm = () => (opts?.area?.unit === 'mm' ? opts.area : null);
    const ready = () => status === 'ready' && !!opts && !optsLoading;
    const deviceDesc = (d) => (d ? [t(`conn.${d.connection}`), d.protocol].filter(Boolean).join(' · ') : '');

    function iconBtn(name, label, onclick, { cls = '', disabled = false, k = '', pressed = null } = {}) {
      return h('button', { class: ['btn', 'subtle', 'scan-ib', cls], type: 'button', 'aria-label': label, 'data-tip': label, dataset: k ? { k } : null, disabled, 'aria-pressed': pressed == null ? null : String(pressed), onclick }, icon(name, { size: 18 }));
    }
    function field(label, control, { hint = null, id = '' } = {}) {
      const lid = `scan-l-${id || Math.random().toString(36).slice(2, 8)}`;
      if (control instanceof HTMLElement && control.matches('select, input, [role="radiogroup"]') && !control.getAttribute('aria-labelledby') && !control.getAttribute('aria-label')) control.setAttribute('aria-labelledby', lid);
      return h('div', { class: 'scan-field', dataset: id ? { field: id } : null }, h('div', { class: 'scan-label', id: lid }, label), control, hint ? h('div', { class: 'scan-hint' }, hint) : null);
    }
    function select(k, items, value, onchange, disabled) {
      return h(
        'select',
        { class: 'select scan-select', dataset: { k }, disabled, onchange: (e) => onchange(e.target.value) },
        items.map((o) => h('option', { value: o.value, selected: o.value === value }, o.label)),
      );
    }
    /** Radio buttons drawn as a segmented control: one Tab stop, arrows move (roving tabindex). */
    function radios(k, label, items, value, onchange, disabled) {
      const el = h('div', { class: 'segmented scan-seg', role: 'radiogroup', 'aria-label': label, dataset: { k } });
      const btns = items.map((o) =>
        h(
          'button',
          {
            type: 'button',
            role: 'radio',
            class: o.value === value ? 'selected' : '',
            'aria-checked': String(o.value === value),
            tabIndex: o.value === value ? 0 : -1,
            dataset: { v: String(o.value), k: `${k}:${o.value}` },
            disabled,
            onclick: () => onchange(o.value),
          },
          o.label,
        ),
      );
      if (!btns.some((b) => b.tabIndex === 0) && btns[0]) btns[0].tabIndex = 0;
      el.addEventListener('keydown', (e) => {
        const i = btns.indexOf(document.activeElement);
        if (i < 0) return;
        const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
        if (!d) return;
        e.preventDefault();
        const nb = btns[(i + d + btns.length) % btns.length];
        onchange(items[btns.indexOf(nb)].value);
        requestAnimationFrame(() => root.querySelector(`[data-k="${k}:${items[btns.indexOf(nb)].value}"]`)?.focus());
      });
      el.append(...btns);
      return el;
    }

    // ---------------------------------------------------------------- notes (errors, saved, undo)
    function setNote(n, ms = 0) {
      clearTimeout(noteTimer);
      if (undo && n?.key !== 'undo') dropUndo();
      note = n;
      if (ms) noteTimer = setTimeout(() => setNote(null), ms);
      paintNote();
    }
    function errorNote(e, { kept = 0 } = {}) {
      const code = e?.code || 'other';
      const known = ['EBUSY', 'ECOVER', 'ENODOCS', 'EJAM', 'EGONE', 'EACCES', 'ETIMEDOUT', 'ENOMEM', 'ENOTSUP'].includes(code);
      const k = known ? code : 'other';
      const msg = [t(`err.${k}.help`, { message: errText(e) || code })];
      if (kept) msg.push(t('keptPages', { count: kept }));
      const actions = code === 'EGONE' || code === 'EACCES' ? [{ label: t('searchAgain'), onClick: () => refresh(true) }] : [];
      setNote({ kind: 'error', title: t(`err.${k}.title`), message: msg.join(' '), actions, key: `err-${code}` });
    }
    function paintNote() {
      noteEl.replaceChildren();
      if (!note) return;
      const close = h('button', { class: 'btn subtle scan-ib small scan-note-close', type: 'button', 'aria-label': t('common.close'), 'data-tip': t('common.close'), onclick: () => setNote(null) }, icon('x', { size: 14 }));
      noteEl.append(
        h(
          'div',
          { class: ['infobar', 'scan-note', note.kind], role: note.kind === 'error' ? 'alert' : 'status', dataset: { key: note.key || '' } },
          icon(note.kind === 'error' ? 'warning-circle' : note.kind === 'success' ? 'check-circle' : 'info', { size: 16 }),
          h(
            'div',
            { class: 'scan-note-body' },
            note.title ? h('div', { class: 'scan-note-title' }, note.title) : null,
            note.message ? h('div', { class: 'scan-note-msg' }, note.message) : null,
            note.actions?.length ? h('div', { class: 'scan-note-actions' }, note.actions.map((a) => h('button', { class: ['btn', 'small', a.cls], type: 'button', onclick: a.onClick }, a.label))) : null,
          ),
          close,
        ),
      );
    }

    // ---------------------------------------------------------------- side panel
    function paintSide() {
      const focusK = side.contains(document.activeElement) ? document.activeElement.dataset?.k : null;
      const busy = !!job || !!saving;
      const nodes = [];
      // scanner
      const devSel =
        devices.length > 0
          ? select('device', devices.map((d) => ({ value: d.name, label: d.label })), P.device, (v) => chooseDevice(v), busy)
          : h('select', { class: 'select scan-select', dataset: { k: 'device' }, disabled: true }, h('option', null, status === 'searching' ? t('searching') : t('noScanner')));
      devSel.setAttribute('aria-label', t('scanner'));
      if (device()) devSel.title = device().label;
      const refreshBtn = iconBtn('arrows-clockwise', t('searchAgain'), () => refresh(true), { cls: 'scan-refresh', disabled: busy || status === 'searching', k: 'refresh' });
      nodes.push(field(t('scanner'), h('div', { class: 'scan-dev-row' }, devSel, refreshBtn), { hint: deviceDesc(device()) || null, id: 'device' }));

      if (status === 'ready' && optsLoading) nodes.push(h('div', { class: 'scan-loading' }, h('span', { class: 'spinner small' }), h('span', null, t('loadingOptions'))));
      if (ready()) {
        const srcs = opts.sources || [];
        if (srcs.length > 1) {
          nodes.push(field(t('source'), select('source', srcs.map((s) => ({ value: s.id, label: s.kind === 'other' ? s.value : t(`src.${s.kind}`) })), source()?.id, (v) => chooseSource(v), busy), { id: 'source' }));
        }
        if ((opts.modes || []).length > 1) {
          nodes.push(field(t('mode'), select('mode', opts.modes.map((m) => ({ value: m.kind, label: t(`modes.${m.kind}`) })), modeKind(), (v) => setPref('mode', v), busy), { id: 'mode' }));
        }
        const ps = presets();
        if (ps.length) {
          const cur = ps.find((p) => p.dpi === dpi()) || ps[0];
          nodes.push(
            field(
              t('resolution'),
              radios('res', t('resolution'), ps.map((p) => ({ value: p.preset, label: t('dpi', { n: p.dpi }) })), cur.preset, (v) => setPref('res', v), busy),
              { hint: t(`resHint.${cur.preset}`), id: 'res' },
            ),
          );
        }
        if (feeder() && areaMm()) {
          const fits = Object.entries(PAPER).filter(([, [w, hh]]) => w <= opts.area.width + 1 && hh <= opts.area.height + 1).map(([id]) => id);
          const items = [...fits, 'max'].map((id) => ({ value: id, label: t(`papers.${id}`) }));
          const value = items.some((i) => i.value === P.paper) ? P.paper : items[0].value;
          nodes.push(field(t('paper'), select('paper', items, value, (v) => setPref('paper', v), busy), { id: 'paper' }));
        }
        if (!feeder() && areaMm()) {
          const tg = ui.toggle({ checked: !!P.autoCrop, label: t('autoCrop'), onchange: (v) => setPref('autoCrop', v) });
          tg.classList.add('scan-autocrop');
          tg.input.dataset.k = 'autocrop';
          if (busy) tg.input.disabled = true;
          nodes.push(h('div', { class: 'scan-field' }, tg));
        }
      }
      // actions + progress
      const canScan = ready() && !busy;
      const previewBtn = h('button', { class: 'btn scan-preview-btn', type: 'button', dataset: { k: 'preview' }, disabled: !canScan || feeder(), onclick: () => runJob('preview') }, icon('eye', { size: 16 }), t('preview'));
      const scanBtn = h('button', { class: 'btn primary scan-scan-btn', type: 'button', dataset: { k: 'scan' }, disabled: !canScan, onclick: () => runJob('scan') }, icon('scan', { size: 16 }), t('scan'));
      nodes.push(h('div', { class: 'scan-actions' }, previewBtn, scanBtn));
      nodes.push(progressEl);
      paintProgress();
      side.replaceChildren(...nodes);
      if (focusK) side.querySelector(`[data-k="${CSS.escape(focusK)}"]`)?.focus({ preventScroll: true });
    }

    const progressBar = h('div', { class: 'bar' });
    const progressText = h('span', { class: 'scan-progress-text' });
    const cancelBtn = h('button', { class: 'btn small scan-cancel', type: 'button', onclick: () => cancelJob() }, t('common.cancel'));
    const progressEl = h('div', { class: 'scan-progress', role: 'status' }, h('div', { class: 'scan-progress-row' }, progressText, cancelBtn), h('div', { class: 'progress' }, progressBar));
    function paintProgress() {
      progressEl.hidden = !job;
      if (!job) return win.setProgress?.(null);
      const pct = clamp(Math.round(job.percent || 0), 0, 100);
      progressText.textContent = job.cancelling ? t('cancelling') : job.kind === 'preview' ? `${t('previewing')} ${pct} %` : job.batch ? t('scanningPage', { page: job.page || 1, percent: pct }) : job.percent == null ? t('warming') : t('scanning', { percent: pct });
      progressBar.style.width = `${job.percent == null ? 0 : pct}%`;
      progressEl.querySelector('.progress').classList.toggle('indeterminate', job.percent == null || job.cancelling);
      cancelBtn.textContent = t('common.cancel');
      cancelBtn.setAttribute('aria-label', t('cancelScan'));
      cancelBtn.disabled = !!job.cancelling;
      win.setProgress?.(job.percent == null ? null : pct / 100);
    }
    const savingText = h('span', { class: 'scan-progress-text' });
    const savingBar = h('div', { class: 'bar' });
    const savingEl = h('div', { class: 'scan-progress scan-saving', role: 'status' }, savingText, h('div', { class: 'progress' }, savingBar));
    function paintSaving() {
      savingEl.hidden = !saving;
      if (!saving) return;
      savingText.textContent = t('saving', { n: Math.min(saving.n, saving.count), count: saving.count });
      savingBar.style.width = `${Math.round((saving.n / Math.max(1, saving.count)) * 100)}%`;
    }

    // ---------------------------------------------------------------- toolbar
    function paintToolbar() {
      const focusK = toolbar.contains(document.activeElement) ? document.activeElement.dataset?.k : null;
      const p = curPage();
      const busy = !!job || !!saving;
      if (p) {
        const i = pages.indexOf(p);
        toolbar.replaceChildren(
          h('div', { class: 'scan-tb-title' }, t('pageOf', { n: i + 1, count: pages.length })),
          h('div', { class: 'scan-tb-sp' }),
          iconBtn('arrow-counter-clockwise', t('rotateLeft'), () => rotate(p, -90), { k: 'rotl', cls: 'scan-rotl', disabled: !!saving }),
          iconBtn('arrow-clockwise', t('rotateRight'), () => rotate(p, 90), { k: 'rotr', cls: 'scan-rotr', disabled: !!saving }),
          h('span', { class: 'scan-sep' }),
          iconBtn('caret-left', t('moveLeft'), () => movePage(p, -1), { k: 'movel', cls: 'scan-movel', disabled: i === 0 || !!saving }),
          iconBtn('caret-right', t('moveRight'), () => movePage(p, 1), { k: 'mover', cls: 'scan-mover', disabled: i === pages.length - 1 || !!saving }),
          h('span', { class: 'scan-sep' }),
          h('button', { class: ['btn', 'subtle', 'scan-adjust-btn', adjustOpen && 'on'], type: 'button', dataset: { k: 'adjust' }, 'aria-expanded': String(adjustOpen), 'aria-haspopup': 'dialog', disabled: !!saving, onclick: () => toggleAdjust() }, icon('sliders-horizontal', { size: 18 }), h('span', null, t('adjust'))),
          iconBtn('trash', t('deletePage'), () => deletePage(p), { k: 'delete', cls: 'scan-delete', disabled: !!saving }),
        );
      } else {
        const a = sel || fullArea();
        const showArea = ready() && !feeder() && areaMm() && preview;
        toolbar.replaceChildren(
          ...[
          h('div', { class: 'scan-tb-title' }, ready() ? (feeder() ? t(`src.${source()?.kind}`) || '' : showArea && a ? t('areaSize', { w: Math.round(a.width), h: Math.round(a.height) }) : t('area')) : t('appName')),
          h('div', { class: 'scan-tb-sp' }),
          showArea ? h('button', { class: 'btn subtle scan-whole', type: 'button', dataset: { k: 'whole' }, disabled: busy, onclick: () => setSel(fullArea(), true) }, icon('corners-out', { size: 16 }), h('span', null, t('wholeGlass'))) : null,
          showArea ? h('button', { class: 'btn subtle scan-detect', type: 'button', dataset: { k: 'detect' }, disabled: busy, onclick: () => detect(true) }, icon('magic-wand', { size: 16 }), h('span', null, t('detect'))) : null,
          ].filter(Boolean),
        );
      }
      if (focusK) toolbar.querySelector(`[data-k="${CSS.escape(focusK)}"]`)?.focus({ preventScroll: true });
    }

    // ---------------------------------------------------------------- stage
    function paintStage() {
      const p = curPage();
      root.dataset.view = p ? 'page' : 'preview';
      root.dataset.status = status;
      root.classList.toggle('is-busy', !!job);
      // empty states
      let empty = null;
      if (status === 'searching') empty = h('div', { class: 'scan-empty-body' }, h('div', { class: 'spinner' }), h('div', { class: 'text-2' }, t('searching')));
      else if (status === 'missing') empty = h('div', { class: 'scan-empty-body', role: 'status' }, h('div', { class: 'scan-empty-icon' }, icon('scan', { size: 40 })), h('div', { class: 'subtitle' }, t('notInstalled')), h('div', { class: 'text-2' }, t('notInstalledHelp')));
      else if (status === 'none')
        empty = h(
          'div',
          { class: 'scan-empty-body scan-none', role: 'status' },
          h('div', { class: 'scan-empty-icon' }, icon('scan', { size: 40 })),
          h('div', { class: 'subtitle' }, t('noScanner')),
          h('div', { class: 'text-2 scan-empty-help' }, t('noScannerHelp')),
          h('button', { class: 'btn scan-retry', type: 'button', onclick: () => refresh(true) }, icon('arrows-clockwise', { size: 16 }), t('searchAgain')),
        );
      emptyEl.replaceChildren(...(empty ? [empty] : []));
      emptyEl.hidden = !empty;
      glass.hidden = !!empty || !!p;
      pageWrap.hidden = !!empty || !p;
      adjustEl.hidden = !p || !adjustOpen;
      if (!empty && !p) paintGlass();
      if (p && adjustOpen) paintAdjust(p);
      layout();
    }

    function paintGlass() {
      const f = feeder();
      const hasPreview = !!preview && !f;
      glass.classList.toggle('has-preview', hasPreview);
      glass.classList.toggle('feeder', f);
      previewImg.hidden = !hasPreview;
      if (hasPreview && previewImg.dataset.src !== preview.url) {
        previewImg.src = preview.url;
        previewImg.dataset.src = preview.url;
      }
      glassHint.hidden = hasPreview;
      glassHint.replaceChildren(ready() || optsLoading ? h('div', { class: 'scan-glass-hint-body' }, icon(f ? 'files' : 'scan', { size: 32 }), h('div', null, f ? t('feederHint') : t('glassHint'))) : '');
      selEl.hidden = !hasPreview || !areaMm() || !sel;
      paintSel();
    }

    function paintSel() {
      const A = areaMm();
      if (!A || !sel || selEl.hidden) return;
      Object.assign(selEl.style, { left: `${(sel.left / A.width) * 100}%`, top: `${(sel.top / A.height) * 100}%`, width: `${(sel.width / A.width) * 100}%`, height: `${(sel.height / A.height) * 100}%` });
      selEl.setAttribute('aria-label', t('areaLabel', { w: Math.round(sel.width), h: Math.round(sel.height) }));
      const title = toolbar.querySelector('.scan-tb-title');
      if (title && current === 'preview') title.textContent = t('areaSize', { w: Math.round(sel.width), h: Math.round(sel.height) });
    }

    // the glass keeps the scanner's proportions; a page keeps its own
    function layout() {
      const sw = stage.clientWidth;
      const sh = stage.clientHeight;
      if (!sw || !sh) return;
      const padding = 24;
      if (!glass.hidden) {
        const A = opts?.area || { width: 216, height: 297 };
        const k = Math.min((sw - padding * 2) / A.width, (sh - padding * 2) / A.height);
        const w = Math.max(40, Math.round(A.width * k));
        const hh = Math.max(40, Math.round(A.height * k));
        Object.assign(glass.style, { width: `${w}px`, height: `${hh}px`, left: `${Math.round((sw - w) / 2)}px`, top: `${Math.round((sh - hh) / 2)}px` });
      }
      if (!pageWrap.hidden) paintPage();
    }
    const ro = new ResizeObserver(() => layout());
    ro.observe(stage);

    function paintPage() {
      const p = curPage();
      if (!p) return;
      const sw = stage.clientWidth - 48;
      const sh = stage.clientHeight - 48;
      const bmp = p.display || p.thumb;
      if (!bmp || sw <= 0 || sh <= 0) {
        if (!p.display) ensureDisplay(p);
        return;
      }
      const rot = p.rotation % 180 !== 0;
      const iw = rot ? p.height || bmp.height : p.width || bmp.width;
      const ih = rot ? p.width || bmp.width : p.height || bmp.height;
      const k = Math.min(sw / iw, sh / ih);
      const cw = Math.max(1, Math.round(iw * k));
      const ch = Math.max(1, Math.round(ih * k));
      const dpr = window.devicePixelRatio || 1;
      drawRotated(pageCanvas, bmp, p, Math.round(cw * dpr), Math.round(ch * dpr));
      Object.assign(pageCanvas.style, { width: `${cw}px`, height: `${ch}px` });
      pageCanvas.setAttribute('aria-label', t('pageN', { n: pages.indexOf(p) + 1 }));
      if (!p.display) ensureDisplay(p);
    }

    /** Draws bmp into canvas (resized to w × h), rotated by p.rotation, with p's brightness / contrast. */
    function drawRotated(canvas, bmp, p, w, hh) {
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== hh) canvas.height = hh;
      const g = canvas.getContext('2d');
      g.save();
      g.clearRect(0, 0, w, hh);
      g.filter = filterOf(p);
      g.imageSmoothingQuality = 'high';
      g.translate(w / 2, hh / 2);
      g.rotate((p.rotation * Math.PI) / 180);
      const rot = p.rotation % 180 !== 0;
      const dw = rot ? hh : w;
      const dh = rot ? w : hh;
      g.drawImage(bmp, -dw / 2, -dh / 2, dw, dh);
      g.restore();
    }

    // ---------------------------------------------------------------- adjust popover
    function toggleAdjust(force) {
      adjustOpen = force ?? !adjustOpen;
      paintToolbar();
      paintStage();
      if (adjustOpen) requestAnimationFrame(() => adjustEl.querySelector('input')?.focus());
    }
    function paintAdjust(p) {
      const row = (key, label) => {
        const s = ui.slider({ min: -100, max: 100, step: 1, value: p[key] || 0, oninput: (v) => setAdjust(p, key, v), onchange: () => makeThumb(p) });
        s.setAttribute('aria-label', label);
        s.dataset.k = `adj-${key}`;
        s.classList.add(`scan-adj-${key}`);
        return h('div', { class: 'scan-adj-row' }, h('div', { class: 'scan-adj-head' }, h('span', null, label), h('span', { class: 'scan-adj-val' }, `${p[key] > 0 ? '+' : ''}${p[key] || 0}`)), s);
      };
      if (adjustEl.dataset.page === String(p.id) && adjustEl.childElementCount) {
        for (const key of ['brightness', 'contrast']) {
          const s = adjustEl.querySelector(`.scan-adj-${key}`);
          if (s && document.activeElement !== s) s.setValue(p[key] || 0);
          const v = s?.closest('.scan-adj-row')?.querySelector('.scan-adj-val');
          if (v) v.textContent = `${p[key] > 0 ? '+' : ''}${p[key] || 0}`;
        }
        return;
      }
      adjustEl.dataset.page = String(p.id);
      adjustEl.setAttribute('aria-label', t('adjust'));
      adjustEl.replaceChildren(
        row('brightness', t('brightness')),
        row('contrast', t('contrast')),
        h('div', { class: 'scan-adj-foot' }, h('button', { class: 'btn small scan-adj-reset', type: 'button', onclick: () => (setAdjust(p, 'brightness', 0), setAdjust(p, 'contrast', 0), makeThumb(p), (adjustEl.dataset.page = ''), paintStage()) }, t('reset'))),
      );
    }
    function setAdjust(p, key, v) {
      p[key] = clamp(Math.round(Number(v) || 0), -100, 100);
      dirty = true;
      paintPage();
      const val = adjustEl.querySelector(`.scan-adj-${key}`)?.closest('.scan-adj-row')?.querySelector('.scan-adj-val');
      if (val) val.textContent = `${p[key] > 0 ? '+' : ''}${p[key]}`;
    }
    adjustEl.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        toggleAdjust(false);
        toolbar.querySelector('[data-k="adjust"]')?.focus();
      }
    });
    const onOutsideDown = (e) => {
      if (!adjustOpen || closed) return;
      if (adjustEl.contains(e.target) || e.target.closest?.('.scan-adjust-btn')) return;
      toggleAdjust(false);
    };
    document.addEventListener('pointerdown', onOutsideDown, true);

    // ---------------------------------------------------------------- strip
    let drag = null;
    function paintStrip() {
      const focusK = strip.contains(document.activeElement) ? document.activeElement.dataset?.k : null;
      const tiles = [];
      const pv = h(
        'button',
        { class: ['scan-tile', 'scan-tile-preview', current === 'preview' && 'selected'], type: 'button', role: 'option', 'aria-selected': String(current === 'preview'), tabIndex: current === 'preview' ? 0 : -1, dataset: { k: 'tile:preview', id: 'preview' }, onclick: () => show('preview') },
        h('span', { class: 'scan-tile-img scan-tile-glass' }, preview && !feeder() ? h('img', { src: preview.url, alt: '', draggable: false }) : icon('scan', { size: 24 })),
        h('span', { class: 'scan-tile-label' }, t('previewTile')),
      );
      tiles.push(pv);
      pages.forEach((p, i) => {
        const c = h('canvas', { class: 'scan-tile-canvas' });
        if (p.thumb) {
          const rot = p.rotation % 180 !== 0;
          const tw = rot ? p.thumb.height : p.thumb.width;
          const th = rot ? p.thumb.width : p.thumb.height;
          drawRotated(c, p.thumb, p, tw, th);
        }
        const tile = h(
          'button',
          { class: ['scan-tile', 'scan-tile-page', current === p.id && 'selected'], type: 'button', role: 'option', 'aria-selected': String(current === p.id), 'aria-label': t('pageN', { n: i + 1 }), tabIndex: current === p.id ? 0 : -1, dataset: { k: `tile:${p.id}`, id: String(p.id) }, onclick: () => !drag?.moved && show(p.id) },
          h('span', { class: 'scan-tile-img' }, p.thumb ? c : h('span', { class: 'spinner small' })),
          h('span', { class: 'scan-tile-label' }, String(i + 1)),
        );
        tile.addEventListener('pointerdown', (e) => startDrag(e, p, tile));
        tiles.push(tile);
      });
      const add = h('button', { class: 'scan-tile scan-tile-add', type: 'button', dataset: { k: 'tile:add' }, disabled: !ready() || !!job || !!saving, 'aria-label': t('addPage'), 'data-tip': t('addPage'), onclick: () => addPageClick() }, h('span', { class: 'scan-tile-img' }, icon('plus', { size: 24 })), h('span', { class: 'scan-tile-label' }, t('addPage')));
      const list = h('div', { class: 'scan-tiles', role: 'listbox', 'aria-label': t('pages'), 'aria-orientation': 'horizontal' }, tiles);
      list.addEventListener('keydown', onStripKey);
      strip.replaceChildren(...[list, add, pages.length ? null : h('div', { class: 'scan-strip-empty text-2' }, t('emptyStrip')), h('div', { class: 'scan-strip-sp' }), saveBox()].filter(Boolean));
      if (focusK) strip.querySelector(`[data-k="${CSS.escape(focusK)}"]`)?.focus({ preventScroll: true });
      strip.querySelector('.scan-tile.selected')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    }
    /** Format and the save actions, at the right of the strip (the progress replaces the buttons while saving). */
    function saveBox() {
      const has = pages.length > 0;
      const busy = !!job || !!saving;
      const fmt = radios('format', t('format'), ['pdf', 'jpeg', 'png'].map((f) => ({ value: f, label: t(`formats.${f}`) })), P.format, (v) => setPref('format', v), !!saving);
      fmt.querySelectorAll('button').forEach((b) => b.setAttribute('data-tip', t(`formatHint.${b.dataset.v}`)));
      const saveBtn = h('button', { class: 'btn scan-save', type: 'button', dataset: { k: 'save' }, disabled: !has || busy, onclick: () => save() }, icon('floppy-disk', { size: 16 }), t('common.save'));
      const saveAsBtn = h('button', { class: 'btn scan-saveas', type: 'button', dataset: { k: 'saveas' }, disabled: !has || busy, onclick: () => save({ ask: true }) }, t('saveAs'));
      const mailBtn = iconBtn('envelope-simple', t('email'), () => sendMail(), { cls: 'scan-mail', disabled: !has || busy, k: 'mail' });
      const newBtn = iconBtn('note-blank', t('newDoc'), () => newDocument(), { cls: 'scan-new', disabled: !has || busy, k: 'new' });
      paintSaving();
      return h(
        'div',
        { class: 'scan-savebox', role: 'group', 'aria-label': t('saveSection') },
        h('div', { class: 'scan-savebox-row' }, h('span', { class: 'scan-label', id: 'scan-fmt-label' }, t('format')), fmt),
        saving ? savingEl : h('div', { class: 'scan-savebox-row' }, saveBtn, saveAsBtn, mailBtn, newBtn),
      );
    }
    function onStripKey(e) {
      const ids = ['preview', ...pages.map((p) => p.id)];
      const i = ids.indexOf(current);
      const p = curPage();
      if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && (e.ctrlKey || e.altKey) && p) {
        e.preventDefault();
        movePage(p, e.key === 'ArrowRight' ? 1 : -1, true);
        return;
      }
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft' || e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        const n = e.key === 'Home' ? 0 : e.key === 'End' ? ids.length - 1 : clamp(i + (e.key === 'ArrowRight' ? 1 : -1), 0, ids.length - 1);
        show(ids[n], true);
        return;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && p && !saving) {
        e.preventDefault();
        deletePage(p, true);
      }
    }
    function startDrag(e, p, tile) {
      if (e.button !== 0 || saving) return;
      const x0 = e.clientX;
      drag = { p, moved: false, target: pages.indexOf(p) };
      const list = tile.parentElement;
      const move = (ev) => {
        if (!drag) return;
        const dx = ev.clientX - x0;
        if (!drag.moved && Math.abs(dx) < 6) return;
        if (!drag.moved) {
          drag.moved = true;
          tile.classList.add('dragging');
          tile.setPointerCapture?.(ev.pointerId);
        }
        tile.style.transform = `translateX(${dx}px)`;
        // insertion point: the page tiles whose centre is left of the pointer
        const others = [...list.querySelectorAll('.scan-tile-page')].filter((x) => x !== tile);
        let idx = 0;
        for (const o of others) {
          const r = o.getBoundingClientRect();
          if (ev.clientX > r.left + r.width / 2) idx++;
        }
        drag.target = idx;
        list.querySelectorAll('.scan-tile-page').forEach((x) => x.classList.remove('drop-before', 'drop-after'));
        if (others[idx]) others[idx].classList.add('drop-before');
        else others[others.length - 1]?.classList.add('drop-after');
      };
      const up = () => {
        window.removeEventListener('pointermove', move, true);
        window.removeEventListener('pointerup', up, true);
        window.removeEventListener('pointercancel', up, true);
        const d = drag;
        setTimeout(() => (drag = null));
        if (!d?.moved) return;
        const from = pages.indexOf(d.p);
        if (from >= 0 && d.target !== from) {
          pages.splice(from, 1);
          pages.splice(clamp(d.target, 0, pages.length), 0, d.p);
          dirty = true;
        }
        current = d.p.id;
        paintAll();
      };
      window.addEventListener('pointermove', move, true);
      window.addEventListener('pointerup', up, true);
      window.addEventListener('pointercancel', up, true);
    }

    function paintAll() {
      paintSide();
      paintToolbar();
      paintStage();
      paintStrip();
      paintNote();
    }

    // ---------------------------------------------------------------- pages
    async function loadBitmap(path, maxSide = 0, known = null) {
      let blob;
      try {
        const r = await fetch(api.mediaUrl(path));
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        blob = await r.blob();
      } catch {
        blob = new Blob([await api.invoke('fs:readBytes', path)]);
      }
      if (!maxSide) return createImageBitmap(blob);
      let w = known?.width;
      let hh = known?.height;
      if (!w || !hh) {
        const full = await createImageBitmap(blob);
        w = full.width;
        hh = full.height;
        if (Math.max(w, hh) <= maxSide) return full;
        const k = maxSide / Math.max(w, hh);
        const out = await createImageBitmap(full, { resizeWidth: Math.max(1, Math.round(w * k)), resizeHeight: Math.max(1, Math.round(hh * k)), resizeQuality: 'medium' });
        full.close();
        return out;
      }
      if (Math.max(w, hh) <= maxSide) return createImageBitmap(blob);
      const k = maxSide / Math.max(w, hh);
      return createImageBitmap(blob, { resizeWidth: Math.max(1, Math.round(w * k)), resizeHeight: Math.max(1, Math.round(hh * k)), resizeQuality: 'medium' });
    }
    async function makeThumb(p) {
      try {
        if (!p.thumb) p.thumb = await loadBitmap(p.path, 240, p);
        if (!p.width) {
          p.width = p.thumb.width;
          p.height = p.thumb.height;
        }
      } catch (e) {
        console.warn('[scan] thumbnail', e?.message || e);
      }
      if (!closed) {
        paintStrip();
        if (current === p.id) paintPage();
      }
    }
    async function ensureDisplay(p) {
      if (p.display || p.loadingDisplay) return;
      p.loadingDisplay = true;
      try {
        // only the page on screen keeps a large bitmap
        for (const o of pages) if (o !== p && o.display) (o.display.close(), (o.display = null));
        p.display = await loadBitmap(p.path, 1800, p);
      } catch (e) {
        console.warn('[scan] page', e?.message || e);
      }
      p.loadingDisplay = false;
      if (!closed && current === p.id) paintPage();
    }
    function addPage(pg) {
      if (!pg?.path || pages.some((p) => p.path === pg.path) || (job && job.added.includes(pg.path))) return null;
      if (job) job.added.push(pg.path);
      const p = { id: ++pageSeq, path: pg.path, width: pg.width || 0, height: pg.height || 0, dpi: pg.dpi || dpi() || 300, mode: modeKind(), rotation: 0, brightness: 0, contrast: 0, thumb: null, display: null };
      pages.push(p);
      dirty = true;
      lastSaved = null;
      makeThumb(p);
      return p;
    }
    function show(id, focus = false) {
      current = id;
      if (id === 'preview') adjustOpen = false;
      paintAll();
      if (focus) strip.querySelector(`[data-k="tile:${id}"]`)?.focus({ preventScroll: true });
    }
    function rotate(p, deg) {
      p.rotation = (((p.rotation + deg) % 360) + 360) % 360;
      dirty = true;
      paintStrip();
      paintPage();
    }
    function movePage(p, d, focus = false) {
      const i = pages.indexOf(p);
      const j = clamp(i + d, 0, pages.length - 1);
      if (i === j) return;
      pages.splice(i, 1);
      pages.splice(j, 0, p);
      dirty = true;
      current = p.id;
      paintAll();
      if (focus) strip.querySelector(`[data-k="tile:${p.id}"]`)?.focus({ preventScroll: true });
    }
    function dropUndo() {
      if (!undo) return;
      const u = undo;
      undo = null;
      u.page.thumb?.close?.();
      u.page.display?.close?.();
      api.invoke('scan:discard', [u.page.path]).catch(() => {});
    }
    function deletePage(p, focus = false) {
      const i = pages.indexOf(p);
      if (i < 0) return;
      dropUndo();
      pages.splice(i, 1);
      p.display?.close?.();
      p.display = null;
      undo = { page: p, index: i };
      dirty = pages.length > 0;
      if (!pages.length) lastSaved = null;
      current = pages[Math.min(i, pages.length - 1)]?.id ?? 'preview';
      adjustOpen = false;
      setNote({
        kind: 'info',
        title: null,
        message: t('pageDeleted', { n: i + 1 }),
        key: 'undo',
        actions: [
          {
            label: t('common.undo'),
            cls: 'scan-undo',
            onClick: () => {
              if (!undo) return;
              const u = undo;
              undo = null;
              pages.splice(Math.min(u.index, pages.length), 0, u.page);
              current = u.page.id;
              dirty = true;
              setNote(null);
              paintAll();
            },
          },
        ],
      });
      paintAll();
      if (focus) strip.querySelector('.scan-tile.selected')?.focus({ preventScroll: true });
    }
    async function newDocument() {
      if (!pages.length || job || saving) return;
      if (dirty) {
        const ok = await ui.confirm(t('newDocConfirm', { count: pages.length }), { title: t('newDocTitle'), okLabel: t('remove'), danger: true, parent: win });
        if (!ok || closed) return;
      }
      const paths = pages.map((p) => p.path);
      for (const p of pages) (p.thumb?.close?.(), p.display?.close?.());
      pages = [];
      dropUndo();
      api.invoke('scan:discard', paths).catch(() => {});
      current = 'preview';
      dirty = false;
      lastSaved = null;
      setNote(null);
      paintAll();
    }

    // ---------------------------------------------------------------- devices and options
    async function refresh(force) {
      if (job || closed) return;
      status = 'searching';
      if (force) setNote(null);
      paintAll();
      let res;
      try {
        res = await api.invoke('scan:devices', { refresh: !!force });
      } catch (e) {
        res = { available: true, devices: [], error: e };
      }
      if (closed) return;
      simulated = !!res.simulated;
      devices = res.devices || [];
      if (!res.available) status = 'missing';
      else if (!devices.length) status = 'none';
      else status = 'ready';
      if (status === 'ready') {
        const want = pendingDevice && devices.some((d) => d.name === pendingDevice) ? pendingDevice : devices.some((d) => d.name === P.device) ? P.device : devices[0].name;
        pendingDevice = null;
        if (want !== P.device || !opts || opts.device !== want) {
          P.device = want;
          savePrefs();
          await loadOptions(true);
          return;
        }
      } else opts = null;
      paintAll();
    }
    let pendingDevice = ctx.args?.device || null;

    async function loadOptions(resetPreview) {
      const my = ++optsSeq;
      optsLoading = true;
      if (resetPreview) clearPreview();
      paintAll();
      try {
        let o = await api.invoke('scan:options', P.device, {});
        // the source the user chose last time, when this scanner has it
        if (P.source && o.sources.some((s) => s.id === P.source) && P.source !== o.source) o = await api.invoke('scan:options', P.device, { source: P.source });
        if (my !== optsSeq || closed) return;
        opts = o;
        if (!o.sources.some((s) => s.id === P.source)) P.source = o.source || o.sources[0]?.id || '';
        if (!sel || resetPreview) sel = fullArea();
      } catch (e) {
        if (my !== optsSeq || closed) return;
        opts = null;
        errorNote(e);
      }
      optsLoading = false;
      paintAll();
    }
    function clearPreview() {
      if (preview) api.invoke('scan:discard', [preview.path]).catch(() => {});
      preview = null;
      sel = null;
      previewImg.removeAttribute('src');
      delete previewImg.dataset.src;
    }
    function chooseDevice(name) {
      if (job || name === P.device) return;
      P.device = name;
      savePrefs();
      setNote(null);
      current = 'preview';
      loadOptions(true);
    }
    async function chooseSource(id) {
      if (job) return;
      const wasFeeder = feeder();
      P.source = id;
      savePrefs();
      const my = ++optsSeq;
      optsLoading = true;
      paintAll();
      try {
        const o = await api.invoke('scan:options', P.device, { source: id });
        if (my !== optsSeq || closed) return;
        opts = o;
      } catch (e) {
        if (my !== optsSeq || closed) return;
        errorNote(e);
      }
      optsLoading = false;
      if (wasFeeder !== feeder()) current = 'preview';
      if (sel && opts?.area) sel = clampArea(sel, opts.area.width, opts.area.height, MIN_MM);
      paintAll();
    }
    function setPref(k, v) {
      P[k] = v;
      savePrefs();
      paintAll();
    }

    // ---------------------------------------------------------------- scanning
    function addPageClick() {
      if (!ready() || job) return;
      current = 'preview';
      runJob('scan');
    }
    async function runJob(kind) {
      if (job || !ready() || saving) return;
      const f = feeder();
      if (kind === 'preview' && f) return;
      const id = `j${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
      const o = { kind, format: 'png' };
      const src = source();
      if (src && (opts.sources || []).length > 1) o.source = src.id;
      if (kind === 'scan') {
        const m = modeKind();
        if (m) o.mode = m;
        const r = dpi();
        if (r) o.resolution = r;
        if (opts.area) o.area = f ? paperArea(P.paper, opts.area) : sel && areaMm() ? sel : fullArea();
        o.batch = f;
      }
      job = { id, kind, percent: null, page: 1, cancelling: false, added: [], batch: kind === 'scan' && f };
      setNote(null);
      if (kind === 'scan' && current !== 'preview' && f) current = 'preview';
      paintAll();
      let res = null;
      try {
        jobDone = api.invoke('scan:scan', id, P.device, o);
        res = await jobDone;
      } catch (e) {
        if (!closed) errorNote(e);
      }
      jobDone = null;
      const j = job;
      job = null;
      if (closed) return;
      if (res) {
        if (kind === 'preview') {
          if (!res.cancelled && res.pages[0]) await setPreview(res.pages[0]);
        } else {
          for (const pg of res.pages || []) addPage(pg);
          const mine = pages.filter((p) => j.added.includes(p.path));
          if (mine.length && !res.cancelled) current = mine[0].id;
          if (res.error) errorNote(res.error, { kept: mine.length });
          else if (res.cancelled) setNote({ kind: 'info', message: mine.length ? `${t('cancelled')} ${t('keptPages', { count: mine.length })}` : t('cancelled'), key: 'cancelled' }, 5000);
        }
      }
      paintAll();
    }
    async function cancelJob() {
      if (!job || job.cancelling) return;
      job.cancelling = true;
      paintProgress();
      await api.invoke('scan:cancel', job.id).catch(() => {});
    }
    const offProgress = api.on('scan:progress', (e) => {
      if (!job || e?.jobId !== job.id) return;
      job.percent = e.percent;
      job.page = e.page;
      paintProgress();
    });
    const offPage = api.on('scan:page', (e) => {
      if (!job || e?.jobId !== job.id || job.kind !== 'scan') return;
      const p = addPage(e.page);
      if (p && job.batch) paintStrip();
      paintSide();
    });

    async function setPreview(pg) {
      if (preview && preview.path !== pg.path) api.invoke('scan:discard', [preview.path]).catch(() => {});
      preview = { path: pg.path, url: `${api.mediaUrl(pg.path)}?v=${Date.now()}`, width: pg.width, height: pg.height, pixels: null };
      current = 'preview';
      if (!sel) sel = fullArea();
      if (P.autoCrop) await detect(false);
    }
    async function previewPixels() {
      if (!preview) return null;
      if (preview.pixels) return preview.pixels;
      const bmp = await loadBitmap(preview.path, 900, preview);
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(bmp, 0, 0);
      bmp.close();
      preview.pixels = g.getImageData(0, 0, c.width, c.height);
      return preview.pixels;
    }
    async function detect(manual) {
      const A = areaMm();
      if (!A || !preview) return;
      let box = null;
      try {
        const img = await previewPixels();
        box = img ? detectDocument(img) : null;
        if (box) {
          const kx = A.width / img.width;
          const ky = A.height / img.height;
          const margin = 1;
          const l = Math.max(0, box.x * kx - margin);
          const tp = Math.max(0, box.y * ky - margin);
          setSel({ left: l, top: tp, width: Math.min(A.width - l, box.w * kx + margin * 2), height: Math.min(A.height - tp, box.h * ky + margin * 2) }, true);
          return;
        }
      } catch (e) {
        console.warn('[scan] detect', e?.message || e);
      }
      setSel(fullArea(), true);
      if (manual || P.autoCrop) setNote({ kind: 'info', message: t('detectNone'), key: 'detect-none' }, 6000);
    }
    function setSel(a, repaint) {
      const A = areaMm();
      if (!A || !a) return;
      sel = clampArea(a, A.width, A.height, MIN_MM);
      if (repaint) paintAll();
      else paintSel();
    }

    // selection: drag inside to move, a handle to resize, elsewhere on the glass to draw a new one
    glass.addEventListener('pointerdown', (e) => {
      const A = areaMm();
      if (e.button !== 0 || !A || !preview || job || feeder() || glass.hidden) return;
      const r = glass.getBoundingClientRect();
      const kx = A.width / r.width;
      const ky = A.height / r.height;
      const pt = (ev) => ({ x: clamp((ev.clientX - r.left) * kx, 0, A.width), y: clamp((ev.clientY - r.top) * ky, 0, A.height) });
      const handle = e.target.closest('.scan-handle')?.dataset.h || null;
      const inside = !!e.target.closest('.scan-sel');
      const mode = handle ? 'resize' : inside ? 'move' : 'draw';
      const s0 = { ...(sel || fullArea()) };
      const p0 = pt(e);
      let moved = false;
      e.preventDefault();
      glass.setPointerCapture(e.pointerId);
      selEl.focus({ preventScroll: true });
      glass.classList.add('dragging');
      const move = (ev) => {
        const p = pt(ev);
        if (!moved && Math.hypot(p.x - p0.x, p.y - p0.y) < 0.8) return;
        moved = true;
        let { left: l, top: tp } = s0;
        let rr = s0.left + s0.width;
        let b = s0.top + s0.height;
        if (mode === 'move') {
          l = clamp(s0.left + p.x - p0.x, 0, A.width - s0.width);
          tp = clamp(s0.top + p.y - p0.y, 0, A.height - s0.height);
          rr = l + s0.width;
          b = tp + s0.height;
        } else if (mode === 'resize') {
          // the edges follow the pointer's movement (no jump to where the handle was grabbed)
          const dx = p.x - p0.x;
          const dy = p.y - p0.y;
          if (handle.includes('w')) l = clamp(s0.left + dx, 0, rr - MIN_MM);
          if (handle.includes('e')) rr = clamp(s0.left + s0.width + dx, l + MIN_MM, A.width);
          if (handle.includes('n')) tp = clamp(s0.top + dy, 0, b - MIN_MM);
          if (handle.includes('s')) b = clamp(s0.top + s0.height + dy, tp + MIN_MM, A.height);
        } else {
          l = Math.min(p0.x, p.x);
          rr = Math.max(p0.x, p.x);
          tp = Math.min(p0.y, p.y);
          b = Math.max(p0.y, p.y);
          if (rr - l < MIN_MM) rr = Math.min(A.width, l + MIN_MM);
          if (b - tp < MIN_MM) b = Math.min(A.height, tp + MIN_MM);
        }
        sel = clampArea({ left: l, top: tp, width: rr - l, height: b - tp }, A.width, A.height, MIN_MM);
        paintSel();
      };
      const up = () => {
        glass.removeEventListener('pointermove', move);
        glass.removeEventListener('pointerup', up);
        glass.removeEventListener('pointercancel', up);
        glass.classList.remove('dragging');
        if (moved) paintToolbar();
      };
      glass.addEventListener('pointermove', move);
      glass.addEventListener('pointerup', up);
      glass.addEventListener('pointercancel', up);
    });
    selEl.addEventListener('keydown', (e) => {
      const A = areaMm();
      if (!A || !sel) return;
      const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
      if (!d) return;
      e.preventDefault();
      e.stopPropagation();
      const step = e.ctrlKey ? 10 : 1;
      if (e.shiftKey) setSel({ ...sel, width: sel.width + d[0] * step, height: sel.height + d[1] * step });
      else setSel({ ...sel, left: sel.left + d[0] * step, top: sel.top + d[1] * step });
      paintToolbar();
    });

    // ---------------------------------------------------------------- saving
    async function scansDir() {
      const x = shell.xdg || (await api.invoke('fs:xdg').catch(() => null));
      const docs = String(x?.documents || `${ctx.env?.home || ''}/Documents`).replace(/\/$/, '');
      const mine = t('folderName');
      if (!(await api.invoke('fs:exists', `${docs}/${mine}`).catch(() => false))) {
        for (const other of FOLDER_NAMES.filter((n) => n !== mine)) if (await api.invoke('fs:exists', `${docs}/${other}`).catch(() => false)) return `${docs}/${other}`;
      }
      return `${docs}/${mine}`;
    }
    /** One page, rotated and adjusted, encoded as JPEG or PNG (with its dpi). */
    async function encodePage(p, type) {
      const untouched = !p.rotation && !p.brightness && !p.contrast;
      if (type === 'png' && untouched) {
        // the scanner's own PNG (1-bit for black and white, pHYs already there)
        try {
          const r = await fetch(api.mediaUrl(p.path));
          if (r.ok) return setPngDpi(new Uint8Array(await r.arrayBuffer()), p.dpi);
        } catch {}
        return setPngDpi(new Uint8Array(await api.invoke('fs:readBytes', p.path)), p.dpi);
      }
      const bmp = await loadBitmap(p.path);
      const rot = p.rotation % 180 !== 0;
      const w = rot ? bmp.height : bmp.width;
      const hh = rot ? bmp.width : bmp.height;
      const c = new OffscreenCanvas(w, hh);
      drawRotated(c, bmp, p, w, hh);
      bmp.close();
      const blob = await c.convertToBlob(type === 'png' ? { type: 'image/png' } : { type: 'image/jpeg', quality: p.mode === 'lineart' ? 0.92 : 0.88 });
      c.width = 1;
      c.height = 1;
      const bytes = new Uint8Array(await blob.arrayBuffer());
      return type === 'png' ? setPngDpi(bytes, p.dpi) : setJpegDpi(bytes, p.dpi);
    }
    async function save({ ask = false, quiet = false } = {}) {
      if (!pages.length || job || saving) return null;
      const format = P.format;
      const ext = EXT[format];
      let dir = await scansDir();
      let base = `${t('fileBase')} ${stamp()}`;
      let exact = null;
      if (ask) {
        await api.invoke('fs:mkdir', dir).catch(() => {});
        const res = await ui.filePicker({ mode: 'save', name: `${base}${ext}`, path: dir, filters: [{ name: t(`${format}Files`), ext: [ext] }], parent: win });
        if (!res || closed) return null;
        exact = /\.[a-z0-9]{2,4}$/i.test(res) ? res : `${res}${ext}`;
        dir = exact.replace(/\/[^/]*$/, '') || '/';
        base = exact.slice(dir.length + 1).replace(/\.[a-z0-9]{2,4}$/i, '');
      }
      saving = { n: 0, count: pages.length };
      setNote(null);
      paintAll();
      const files = [];
      try {
        await api.invoke('fs:mkdir', dir);
        const list = [...pages];
        if (format === 'pdf') {
          const out = [];
          for (const p of list) {
            saving.n++;
            paintSaving();
            const jpeg = await encodePage(p, 'jpeg');
            const rot = p.rotation % 180 !== 0;
            out.push({ jpeg, dpi: p.dpi, dpiY: p.dpi, rot });
          }
          const pdf = buildPdf(out, { title: base });
          const path = exact || `${dir}/${await api.invoke('fs:uniqueName', dir, `${base}${ext}`)}`;
          await api.invoke('fs:writeBytes', path, pdf);
          files.push(path);
        } else {
          for (const [i, p] of list.entries()) {
            saving.n++;
            paintSaving();
            const bytes = await encodePage(p, format);
            const name = list.length === 1 ? `${base}${ext}` : `${base} - ${t('pageFile', { n: i + 1 })}${ext}`;
            const path = exact && list.length === 1 ? exact : `${dir}/${await api.invoke('fs:uniqueName', dir, name)}`;
            await api.invoke('fs:writeBytes', path, bytes);
            files.push(path);
          }
        }
      } catch (e) {
        saving = null;
        if (!closed) {
          setNote({ kind: 'error', title: null, message: t('saveFailed', { error: errText(e) }), key: 'save-failed' });
          paintAll();
        }
        return null;
      }
      saving = null;
      dirty = false;
      lastSaved = { files, dir, format };
      if (closed) return lastSaved;
      const folder = dir.split('/').pop();
      if (!quiet) {
        setNote({
          kind: 'success',
          title: null,
          message: files.length === 1 ? t('saved', { folder, name: files[0].split('/').pop() }) : t('savedMany', { count: files.length, folder }),
          key: 'saved',
          actions: [
            { label: t('common.open'), cls: 'scan-open', onClick: () => shell.openFile(files[0]) },
            { label: t('showInFiles'), cls: 'scan-reveal', onClick: () => shell.launch('files', { path: dir, select: files[0] }) },
          ],
        });
      }
      paintAll();
      return lastSaved;
    }
    async function sendMail() {
      if (!pages.length || job || saving) return;
      let s = !dirty && lastSaved?.format === P.format ? lastSaved : null;
      if (!s) s = await save({ quiet: false });
      if (!s || closed) return;
      const attachments = [];
      for (const f of s.files) {
        const st = await api.invoke('fs:stat', f).catch(() => null);
        attachments.push({ path: f, filename: f.split('/').pop(), size: st?.size || 0 });
      }
      const subject = s.files.length === 1 ? s.files[0].split('/').pop().replace(/\.[a-z0-9]+$/i, '') : t('fileBase');
      shell.launch('mail', { compose: { mode: 'new', subject, attachments }, newWindow: true });
    }

    // ---------------------------------------------------------------- keys, lifecycle
    root.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        save({ ask: e.shiftKey });
      }
    });
    win.onBeforeClose(async () => {
      if (job) {
        await cancelJob();
        // let scanimage stop the scanner (it parks the head) before the window goes
        await Promise.race([jobDone?.catch(() => {}), new Promise((r) => setTimeout(r, 10000))]);
      }
      if (!dirty || !pages.length || saving) return !saving;
      const v = await ui.dialog({
        title: t('closeTitle'),
        body: h('div', null, t('closeConfirm', { count: pages.length })),
        parent: win,
        buttons: [
          { label: t('common.save'), value: 'save', primary: true },
          { label: t('common.dontSave'), value: 'discard' },
          { label: t('common.cancel'), value: null },
        ],
      });
      if (v === 'discard') return true;
      if (v === 'save') return !!(await save());
      return false;
    });
    ctx.onClose(() => {
      closed = true;
      clearTimeout(noteTimer);
      offProgress?.();
      offPage?.();
      ro.disconnect();
      document.removeEventListener('pointerdown', onOutsideDown, true);
      if (job) api.invoke('scan:cancel', job.id).catch(() => {});
      for (const p of pages) (p.thumb?.close?.(), p.display?.close?.());
      api.invoke('scan:cleanup').catch(() => {});
    });
    ctx.onLangChange(() => paintAll());

    if (win.el)
      win.el.__scan = {
        P,
        get status() {
          return status;
        },
        get devices() {
          return devices;
        },
        get opts() {
          return opts;
        },
        get preview() {
          return preview;
        },
        get sel() {
          return sel;
        },
        get pages() {
          return pages.map((p) => ({ id: p.id, path: p.path, width: p.width, height: p.height, dpi: p.dpi, mode: p.mode, rotation: p.rotation, brightness: p.brightness, contrast: p.contrast, thumb: !!p.thumb }));
        },
        get current() {
          return current;
        },
        get job() {
          return job ? { ...job } : null;
        },
        get saving() {
          return !!saving;
        },
        get dirty() {
          return dirty;
        },
        get lastSaved() {
          return lastSaved;
        },
        get note() {
          return note ? { kind: note.kind, title: note.title, message: note.message, key: note.key } : null;
        },
        get simulated() {
          return simulated;
        },
        setSel: (a) => setSel(a, true),
        show,
      };

    paintAll();
    refresh(false);
    requestAnimationFrame(() => root.focus({ preventScroll: true }));
    return {
      onRelaunch(args = {}) {
        win.focus();
        if (args.device && args.device !== P.device) {
          if (devices.some((d) => d.name === args.device)) chooseDevice(args.device);
          else {
            pendingDevice = args.device;
            refresh(true);
          }
        }
      },
    };
  },
};
