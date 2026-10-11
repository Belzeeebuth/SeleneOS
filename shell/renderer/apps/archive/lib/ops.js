// Long operations: a Windows 11-style progress dialog (or an inline task panel) fed by 'archive:progress'
// events, with Cancel; taskbar progress; and the localised error messages of the backend error codes.

let seq = 0;
export const newOpId = () => `arc-${Date.now().toString(36)}-${++seq}`;

/** Localised message for a backend error (code-based), plus the backend's own text as details. */
export function errorInfo(t, e) {
  const code = e?.code || 'EFAIL';
  const known = {
    ENOENT: 'err.notFound',
    EFORMAT: 'err.format',
    ECORRUPT: 'err.corrupt',
    ENOTSUP: 'err.notSupported',
    ENOSPC: 'err.noSpace',
    EACCES: 'err.access',
    EPERM: 'err.access',
    EROFS: 'err.access',
    ETOOL: 'err.tool',
    EBADPASSWORD: 'err.badPassword',
    EPASSWORD: 'err.needPassword',
    EUNSAFE: 'err.unsafe',
    EBOMB: 'err.bomb',
    EINVAL: 'err.invalid',
    EEXIST: 'err.exists',
    ETIMEDOUT: 'err.timeout',
    EZIPPASSWORD: 'err.zipPassword',
    ENOENTRY: 'err.entryMissing',
    ENOITEM: 'err.itemMissing',
    ENODEST: 'err.destMissing',
    ELINK: 'err.link',
  };
  // The backend's own (English) text is worth showing only when it adds something: tool output for
  // damaged archives, unsupported methods, permissions or unexpected failures.
  const withDetails = !known[code] || ['ECORRUPT', 'ENOTSUP', 'EACCES', 'EPERM', 'EROFS', 'ETOOL', 'EINVAL', 'ENOITEM', 'ELINK'].includes(code);
  return { message: t(known[code] || 'err.generic'), details: withDetails ? String(e?.message || e || '') : '', code };
}

/**
 * Progress UI. mode 'dialog': a modal dialog inside the window (shown after `delay` ms so quick operations
 * don't flash). mode 'inline': renders into `host` (the compact extract / compress windows).
 */
export class Progress {
  constructor(w, { title, line, mode = 'dialog', host = null, delay = 350, onCancel }) {
    this.w = w;
    this.mode = mode;
    this.onCancel = onCancel;
    this.closed = false;
    this.percent = null;
    const { h, t } = w;
    this.titleEl = h('div', { class: 'arc-prog-title' }, title);
    this.lineEl = h('div', { class: 'arc-prog-line ellipsis', 'data-tip': line || '' }, line || '');
    this.pctEl = h('div', { class: 'arc-prog-pct' }, '');
    this.bar = h('div', { class: 'bar' });
    this.track = h('div', { class: 'progress indeterminate arc-prog-bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100' }, this.bar);
    this.countEl = h('div', { class: 'arc-prog-count caption text-2' }, '');
    this.curEl = h('div', { class: 'arc-prog-cur caption text-2 ellipsis' }, '');
    this.cancelBtn = h('button', { class: 'btn arc-prog-cancel', onclick: () => this.cancel() }, t('common.cancel'));
    this.body = h('div', { class: 'arc-prog' }, this.titleEl, this.lineEl, h('div', { class: 'arc-prog-row' }, this.pctEl), this.track, h('div', { class: 'arc-prog-meta' }, this.countEl), this.curEl);
    if (mode === 'inline') {
      this.body.appendChild(h('div', { class: 'arc-prog-actions' }, this.cancelBtn));
      host.replaceChildren(this.body);
      requestAnimationFrame(() => w.fitTask?.()); // the compact window grows if the panel doesn't fit
    } else {
      this.timer = setTimeout(() => this.open(), delay);
    }
  }
  open() {
    if (this.closed || this.dialogDone) return;
    const { ui, t } = this.w;
    ui.dialog({
      body: this.body,
      parent: this.w.win,
      className: 'arc-prog-dialog',
      closeOnEsc: false,
      buttons: [{ label: t('common.cancel'), value: 'cancel' }],
      onOpen: (dlg, done) => {
        this.dialogDone = done;
        this.dlg = dlg;
        // Cancel keeps the dialog up ("Canceling…") until the operation has really stopped.
        dlg._validate = (v) => {
          if (v === 'cancel') {
            this.cancel();
            return false;
          }
          return true;
        };
        this.footerCancel = dlg.querySelector('.dialog-footer .btn');
        if (this.closed) done(null);
      },
    });
  }
  update(p) {
    if (this.closed) return;
    const { t, i18n } = this.w;
    if (p.percent != null) {
      const pct = Math.max(0, Math.min(1, p.percent));
      this.track.classList.remove('indeterminate');
      this.bar.style.width = `${(pct * 100).toFixed(1)}%`;
      this.track.setAttribute('aria-valuenow', String(Math.round(pct * 100)));
      this.pctEl.textContent = t('prog.percent', { pct: Math.floor(pct * 100) });
      this.w.win.setProgress?.(pct);
    }
    if (p.total > 0) this.countEl.textContent = t('prog.items', { count: p.total, done: i18n.formatNumber(Math.min(p.done, p.total)), total: i18n.formatNumber(p.total) });
    else if (p.done > 0) this.countEl.textContent = t('prog.itemsDone', { count: p.done, n: i18n.formatNumber(p.done) });
    if (p.current) {
      this.curEl.textContent = p.current;
      this.curEl.dataset.tip = p.current;
    }
    if (p.phase === 'finishing') this.titleEl.textContent = t('prog.finishing');
  }
  cancel() {
    if (this.closed || this.canceling) return;
    this.canceling = true;
    this.cancelBtn.disabled = true;
    if (this.footerCancel) this.footerCancel.disabled = true;
    this.titleEl.textContent = this.w.t('prog.canceling');
    this.onCancel?.();
  }
  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.dialogDone?.(null);
    if (!this.w.win.closed) this.w.win.setProgress?.(null);
  }
}

/**
 * Run a backend operation with progress. fn(opId) -> Promise. Returns its result, or throws (code
 * ECANCELED when the user canceled). opts: { title, line, mode, host, delay }.
 */
export async function withProgress(w, opts, fn) {
  const opId = newOpId();
  const prog = new Progress(w, { ...opts, onCancel: () => w.api.invoke('archive:cancel', opId).catch(() => {}) });
  const off = w.api.on('archive:progress', (p) => {
    if (p?.opId === opId) prog.update(p);
  });
  w.busy = (w.busy || 0) + 1;
  w.onBusy?.();
  w.activeOps?.add(opId); // canceled if the window closes
  try {
    return await fn(opId);
  } finally {
    w.activeOps?.delete(opId);
    off();
    prog.close();
    w.busy--;
    w.onBusy?.();
  }
}

/** Run fn(opId) for a background operation (no progress UI) that the window cancels when it closes. */
export async function tracked(w, fn) {
  const opId = newOpId();
  w.activeOps?.add(opId);
  try {
    return await fn(opId);
  } finally {
    w.activeOps?.delete(opId);
  }
}
