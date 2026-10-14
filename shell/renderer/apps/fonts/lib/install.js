// Polices: install flow shared by the main window (button, drag and drop) and the preview window.
//   installFiles(app, paths, { confirm }) -> results | null (cancelled / nothing to install)
// app = { ctx, t, win, toast(text, kind) }. Conflicts (another file with the same name, or the same family and style,
// already installed for the user) are only replaced after a second confirmation; the old files go to the Trash.
import { baseName, isFontPath, reasonKey, DND_MIME } from './data.js';
import { trustedDragPaths } from '../../../core/desktop.js';
import { registerInstalled } from './session.js';

export async function installFiles(app, paths, { confirm = true } = {}) {
  const { ctx, t, win } = app;
  const { ui, h, api } = ctx;
  const fonts = [...new Set((paths || []).filter(isFontPath))];
  if (!fonts.length) {
    if (paths?.length) app.toast(t('install.dropNone'), 'warning');
    return null;
  }
  if (confirm) {
    const body = h(
      'div',
      { class: 'fv-confirm' },
      h('p', null, t('install.confirmBody')),
      h('ul', { class: 'fv-confirm-list' }, fonts.slice(0, 8).map((p) => h('li', null, baseName(p)))),
      fonts.length > 8 ? h('p', { class: 'fv-confirm-more' }, '…') : null,
      h('p', { class: 'fv-confirm-note' }, t('install.forMeHint')),
    );
    const ok = await ui.confirm(body, { title: t('install.confirmTitle', { count: fonts.length }), okLabel: t('install.forMe'), parent: win });
    if (!ok || win.closed) return null;
  }
  app.busy?.(true);
  let results;
  try {
    ({ results } = await api.invoke('fonts:install', fonts, {}));
    const conflicts = results.filter((r) => r.status === 'conflict');
    if (conflicts.length && !win.closed) {
      const ok = await ui.confirm(t('install.conflictBody', { count: conflicts.length, name: conflicts[0].family || baseName(conflicts[0].file) }), {
        title: t('install.conflictTitle'),
        okLabel: t('install.replace'),
        cancelLabel: t('install.keep'),
        parent: win,
      });
      if (ok && !win.closed) {
        const again = await api.invoke('fonts:install', conflicts.map((r) => r.file), { replace: true });
        results = results.map((r) => (r.status === 'conflict' ? again.results.find((x) => x.file === r.file) || r : r));
      }
    }
  } catch (err) {
    results = fonts.map((file) => ({ file, status: 'error', code: err?.code, message: err?.message }));
  } finally {
    app.busy?.(false);
  }
  await registerInstalled(api, results);
  report(app, results);
  return results;
}

/** One toast (or one per failure) summing up an install. */
export function report(app, results) {
  const { t } = app;
  const nameOf = (r) => [r.family, r.style && r.style !== 'Regular' ? r.style : null].filter(Boolean).join(' ') || baseName(r.file);
  const ok = results.filter((r) => r.status === 'installed' || r.status === 'replaced');
  const already = results.filter((r) => r.status === 'already');
  const failed = results.filter((r) => r.status === 'error');
  const parts = [];
  if (ok.length) parts.push(t('install.done', { count: ok.length, name: nameOf(ok[0]) }));
  if (already.length) parts.push(t('install.already', { count: already.length, name: nameOf(already[0]) }));
  for (const r of failed.slice(0, 3)) {
    const k = reasonKey(r.code);
    parts.push(t('install.failed', { name: baseName(r.file), reason: k ? t(k) : r.message || '' }));
  }
  if (parts.length) app.toast(parts.join(' · '), failed.length ? 'error' : 'success');
}

/**
 * Drop target for font files on el: a hint while dragging, then installFiles() after a confirmation.
 * Paths come from the shell's own drags (trustedDragPaths) or real files (dt.files).
 */
export function dropTarget(app, el, hint) {
  const accepts = (e) => {
    const types = [...(e.dataTransfer?.types || [])];
    return types.includes('Files') || types.includes(DND_MIME);
  };
  let depth = 0;
  el.addEventListener('dragenter', (e) => {
    if (!accepts(e)) return;
    depth++;
    hint.hidden = false;
  });
  el.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) hint.hidden = true;
  });
  el.addEventListener('dragover', (e) => {
    if (!accepts(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  el.addEventListener('drop', async (e) => {
    depth = 0;
    hint.hidden = true;
    if (!accepts(e)) return;
    e.preventDefault();
    let paths = trustedDragPaths(e.dataTransfer);
    if (!paths.length) paths = [...(e.dataTransfer.files || [])].map((f) => app.ctx.api.pathForFile?.(f)).filter(Boolean);
    await installFiles(app, paths, { confirm: true });
  });
}
