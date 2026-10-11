// Dialogs of the Archive Manager: extract, new archive, password, unsafe items, zip bomb, properties,
// test results and errors. Every dialog is scoped to its window (parent: win) and keyboard accessible.
import { FORMATS, LEVELS, basename, dirname, joinPath, withFormatExt, formatOfName, typeName, ratioOf, modeString, iconUrl, methodName, containsText } from './util.js';
import { shared } from './shared.js';
import { errorInfo } from './ops.js';

function field(h, label, control, hint) {
  return h('div', { class: 'field' }, h('label', null, label), control, hint || null);
}
function checkbox(h, label, checked) {
  const input = h('input', { type: 'checkbox', checked: !!checked });
  const el = h('label', { class: 'checkbox' }, input, h('span', null, label));
  el.input = input;
  return el;
}
function errLine(h) {
  return h('div', { class: 'field-hint arc-err', role: 'alert' });
}

// ------------------------------------------------------------------ extract
/** -> { dest, overwrite, show } | null */
export async function extractDialog(w, { count = 0, defaultDest }) {
  const { h, t, ui } = w;
  const input = h('input', { class: 'input grow', value: defaultDest, spellcheck: false, 'aria-label': t('extract.destLabel') });
  const err = errLine(h);
  const browse = h('button', {
    class: 'btn',
    onclick: async () => {
      const dir = await ui.filePicker({ mode: 'folder', title: t('extract.chooseFolder'), path: existingParent(input.value) || dirname(w.listing?.path || ''), parent: w.win });
      if (dir) {
        input.value = dir;
        input.focus();
      }
    },
  }, t('extract.browse'));
  const policy = ui.select({
    options: [
      { value: 'rename', label: t('extract.keepBoth') },
      { value: 'replace', label: t('extract.replace') },
      { value: 'skip', label: t('extract.skip') },
    ],
    value: shared.prefs.overwrite,
  });
  policy.setAttribute('aria-label', t('extract.ifExists'));
  const show = checkbox(h, t('extract.showWhenDone'), shared.prefs.showWhenDone);
  const body = h(
    'div',
    { class: 'arc-dlg arc-dlg-extract' },
    h('div', { class: 'text-2 arc-dlg-intro' }, count ? t('extract.introSelected', { count, n: w.i18n.formatNumber(count) }) : t('extract.introAll', { name: w.listing?.name || '' })),
    field(h, t('extract.destLabel'), h('div', { class: 'row' }, input, browse), err),
    field(h, t('extract.ifExists'), policy),
    show,
  );
  let result = null;
  const v = await ui.dialog({
    title: t('extract.title'),
    body,
    parent: w.win,
    width: 560,
    buttons: [
      { label: t('extract.extract'), value: 'go', primary: true },
      { label: t('common.cancel'), value: null },
    ],
    onOpen: (dlg) => {
      setTimeout(() => {
        input.focus();
        input.select();
      }, 40);
      dlg._validate = () => {
        const dest = input.value.trim().replace(/\/+$/, '') || '/';
        if (!dest.startsWith('/')) {
          err.textContent = t('extract.absolute');
          input.classList.add('invalid');
          input.focus();
          return false;
        }
        result = { dest, overwrite: policy.value, show: show.input.checked };
        return true;
      };
    },
  });
  if (v !== 'go' || !result) return null;
  shared.setPref('overwrite', result.overwrite);
  shared.setPref('showWhenDone', result.show);
  return result;
}
function existingParent(p) {
  const s = String(p || '').trim();
  return s.startsWith('/') ? dirname(s) : null;
}

// ------------------------------------------------------------------ new archive
/** -> { sources, dest, format, level, password, encryptNames } | null */
export async function newArchiveDialog(w, { sources = [], dir = null, name = null } = {}) {
  const { h, t, ui, icon, api } = w;
  const xdg = await api.invoke('fs:xdg').catch(() => ({ documents: '/' }));
  let srcs = [...sources];
  let location = dir || (srcs[0] ? dirname(srcs[0]) : xdg.documents);
  const formats = FORMATS.filter((f) => shared.tools.create.includes(f.id));
  let format = formats.some((f) => f.id === shared.prefs.format) ? shared.prefs.format : formats[0]?.id || 'zip';
  const suggested = name || (srcs.length === 1 ? await w.stemFor(srcs[0]) : srcs.length ? basename(dirname(srcs[0])) || t('newArc.defaultName') : t('newArc.defaultName'));
  const nameInput = h('input', { class: 'input grow', value: suggested, spellcheck: false, 'aria-label': t('newArc.name') });
  const fmtSel = ui.select({ options: formats.map((f) => ({ value: f.id, label: f.ext })), value: format, onchange: (v) => ((format = v), refresh()) });
  fmtSel.classList.add('arc-fmt');
  fmtSel.setAttribute('aria-label', t('newArc.format'));
  const locInput = h('input', { class: 'input grow', value: location, spellcheck: false, 'aria-label': t('newArc.location') });
  const browse = h('button', {
    class: 'btn',
    onclick: async () => {
      const d = await ui.filePicker({ mode: 'folder', title: t('newArc.chooseLocation'), path: locInput.value, parent: w.win });
      if (d) locInput.value = d;
    },
  }, t('extract.browse'));
  const levelSel = ui.select({
    options: LEVELS.map((l) => ({ value: l, label: t(`newArc.level${l}`) })),
    value: shared.prefs.level,
  });
  levelSel.setAttribute('aria-label', t('newArc.level'));
  const pw1 = h('input', { class: 'input grow', type: 'password', autocomplete: 'new-password', placeholder: t('newArc.passwordOptional'), 'aria-label': t('newArc.password') });
  const pw2 = h('input', { class: 'input grow', type: 'password', autocomplete: 'new-password', 'aria-label': t('newArc.confirm') });
  const eye = h('button', {
    class: 'btn subtle icon-btn',
    'data-tip': t('pw.show'),
    'aria-label': t('pw.show'),
    onclick: () => {
      const on = pw1.type === 'password';
      pw1.type = pw2.type = on ? 'text' : 'password';
      eye.replaceChildren(icon(on ? 'eye_off' : 'eye'));
    },
  }, icon('eye'));
  const encNames = checkbox(h, t('newArc.encryptNames'), true);
  const encHint = h('div', { class: 'field-hint' });
  const encBox = h('div', { class: 'arc-enc' }, field(h, t('newArc.password'), h('div', { class: 'row' }, pw1, eye)), field(h, t('newArc.confirm'), pw2), encNames, encHint);
  const srcList = h('div', { class: 'arc-src-list', role: 'list', 'aria-label': t('newArc.items') });
  const err = errLine(h);
  const addFiles = h('button', {
    class: 'btn',
    onclick: async () => {
      const r = await ui.filePicker({ mode: 'open', multiple: true, title: t('newArc.addFiles'), path: srcs[0] ? dirname(srcs[0]) : xdg.documents, parent: w.win });
      const list = Array.isArray(r) ? r : r ? [r] : [];
      addSources(list);
    },
  }, icon('document_add'), t('newArc.addFiles'));
  const addFolder = h('button', {
    class: 'btn',
    onclick: async () => {
      const d = await ui.filePicker({ mode: 'folder', title: t('newArc.addFolder'), path: srcs[0] ? dirname(srcs[0]) : xdg.documents, parent: w.win });
      if (d) addSources([d]);
    },
  }, icon('folder_add'), t('newArc.addFolder'));
  async function addSources(list) {
    for (const p of list) if (p && !srcs.includes(p)) srcs.push(p);
    renderSources();
    if (srcs.length && !nameInput.dataset.touched && !name) {
      const n = srcs.length === 1 ? await w.stemFor(srcs[0]) : basename(dirname(srcs[0])) || t('newArc.defaultName');
      if (!nameInput.dataset.touched) nameInput.value = n;
      if (!dir) locInput.value = dirname(srcs[0]);
    }
  }
  nameInput.addEventListener('input', () => (nameInput.dataset.touched = '1'));
  function renderSources() {
    srcList.replaceChildren();
    if (!srcs.length) srcList.appendChild(h('div', { class: 'arc-src-empty caption text-2' }, t('newArc.noItems')));
    for (const p of srcs) {
      srcList.appendChild(
        h(
          'div',
          { class: 'arc-src', role: 'listitem', 'data-tip': p },
          h('img', { src: iconUrl({ name: basename(p), dir: false }), alt: '', class: 'arc-src-ic', dataset: { path: p } }),
          h('span', { class: 'ellipsis grow' }, basename(p)),
          h('button', { class: 'btn subtle icon-btn small', 'aria-label': t('newArc.removeItem', { name: basename(p) }), 'data-tip': t('newArc.removeItem', { name: basename(p) }), onclick: () => ((srcs = srcs.filter((x) => x !== p)), renderSources()) }, icon('dismiss', { size: 12 })),
        ),
      );
    }
    // folder icons for directories (async stat)
    for (const img of srcList.querySelectorAll('img[data-path]')) {
      api.invoke('fs:stat', img.dataset.path).then((st) => {
        if (st?.dir) img.src = iconUrl({ dir: true, name: '' });
      }).catch(() => {});
    }
  }
  function refresh() {
    const f = FORMATS.find((x) => x.id === format);
    const canEnc = !!f?.encrypt && shared.tools.encrypt;
    encBox.hidden = false;
    for (const el of [pw1, pw2, eye]) el.disabled = !canEnc;
    encNames.hidden = !f?.names;
    encHint.textContent = !canEnc ? t('newArc.noEncryption', { ext: f?.ext || '' }) : format === 'zip' ? t('newArc.zipAes') : '';
    levelSel.disabled = false;
  }
  renderSources();
  refresh();
  const body = h(
    'div',
    { class: 'arc-dlg arc-dlg-new' },
    h('div', { class: 'arc-src-head' }, h('div', { class: 'body-strong' }, t('newArc.items')), h('div', { class: 'row' }, addFiles, addFolder)),
    srcList,
    h(
      'div',
      { class: 'arc-grid' },
      field(h, t('newArc.name'), h('div', { class: 'row' }, nameInput, fmtSel)),
      field(h, t('newArc.location'), h('div', { class: 'row' }, locInput, browse)),
      field(h, t('newArc.level'), levelSel),
    ),
    h('div', { class: 'arc-sep' }),
    encBox,
    err,
  );
  let result = null;
  const v = await ui.dialog({
    title: t('newArc.title'),
    body,
    parent: w.win,
    width: 600,
    buttons: [
      { label: t('newArc.create'), value: 'go', primary: true },
      { label: t('common.cancel'), value: null },
    ],
    onOpen: (dlg) => {
      setTimeout(() => {
        nameInput.focus();
        nameInput.select();
      }, 40);
      dlg._validate = () => {
        const fail = (msg, el) => {
          err.textContent = msg;
          el?.classList.add('invalid');
          el?.focus();
          return false;
        };
        for (const el of [nameInput, locInput, pw1, pw2]) el.classList.remove('invalid');
        if (!srcs.length) return fail(t('newArc.needItems'), null);
        const n = nameInput.value.trim();
        if (!n || n.includes('/') || n === '.' || n === '..') return fail(t('newArc.badName'), nameInput);
        const loc = locInput.value.trim().replace(/\/+$/, '') || '/';
        if (!loc.startsWith('/')) return fail(t('extract.absolute'), locInput);
        const f = FORMATS.find((x) => x.id === format);
        let password = null;
        if (f?.encrypt && pw1.value) {
          if (/[\r\n]/.test(pw1.value)) return fail(t('newArc.badPassword'), pw1);
          if (format === 'zip' && !/^[\x20-\x7e]+$/.test(pw1.value)) return fail(t('newArc.asciiOnly'), pw1);
          if (pw1.value !== pw2.value) return fail(t('newArc.mismatch'), pw2);
          password = pw1.value;
        }
        const fileName = formatOfName(n) === format ? n : withFormatExt(n, format);
        result = { sources: [...srcs], dest: joinPath(loc === '/' ? '' : loc, fileName) || `/${fileName}`, format, level: Number(levelSel.value), password, encryptNames: !!f?.names && encNames.input.checked && !!password };
        return true;
      };
    },
  });
  if (v !== 'go' || !result) return null;
  shared.setPref('format', result.format);
  shared.setPref('level', result.level);
  if (await api.invoke('fs:exists', result.dest).catch(() => false)) {
    const ok = await ui.confirm(t('newArc.replaceBody', { name: basename(result.dest) }), { title: t('newArc.replaceTitle'), okLabel: t('newArc.replaceOk'), parent: w.win });
    if (!ok) return newArchiveDialog(w, { sources: result.sources, dir: dirname(result.dest), name: basename(result.dest) });
  }
  return result;
}

// ------------------------------------------------------------------ password
/** -> password | null */
export async function passwordDialog(w, { name, error = false }) {
  const { h, t, ui, icon } = w;
  const input = h('input', { class: 'input grow', type: 'password', autocomplete: 'off', spellcheck: false, 'aria-label': t('pw.label') });
  const eye = h('button', {
    class: 'btn subtle icon-btn',
    'data-tip': t('pw.show'),
    'aria-label': t('pw.show'),
    onclick: () => {
      const on = input.type === 'password';
      input.type = on ? 'text' : 'password';
      eye.replaceChildren(icon(on ? 'eye_off' : 'eye'));
      input.focus();
    },
  }, icon('eye'));
  const err = h('div', { class: 'field-hint arc-err', role: 'alert' }, error ? t('pw.wrong') : '');
  const body = h(
    'div',
    { class: 'arc-dlg arc-dlg-pw' },
    h('div', { class: 'arc-pw-head' }, h('div', { class: 'arc-pw-ic' }, icon('lock_closed', { size: 24, filled: true })), h('div', { class: 'text-2' }, t('pw.intro', { name }))),
    field(h, t('pw.label'), h('div', { class: 'row' }, input, eye), err),
  );
  if (error) input.classList.add('invalid');
  let value = null;
  const v = await ui.dialog({
    title: t('pw.title'),
    body,
    parent: w.win,
    width: 440,
    buttons: [
      { label: t('common.ok'), value: 'ok', primary: true },
      { label: t('common.cancel'), value: null },
    ],
    onOpen: (dlg) => {
      setTimeout(() => input.focus(), 40);
      dlg._validate = () => {
        if (!input.value) {
          err.textContent = t('pw.empty');
          input.classList.add('invalid');
          input.focus();
          return false;
        }
        if (/[\r\n]/.test(input.value)) {
          err.textContent = t('newArc.badPassword');
          return false;
        }
        value = input.value;
        return true;
      };
    },
  });
  return v === 'ok' ? value : null;
}

// ------------------------------------------------------------------ safety
export async function unsafeDialog(w, unsafe) {
  const { h, t, ui, icon, i18n } = w;
  const shown = unsafe.slice(0, 8);
  const body = h(
    'div',
    { class: 'arc-dlg arc-dlg-warn' },
    h('div', { class: 'arc-warn-head' }, h('div', { class: 'arc-warn-ic' }, icon('shield_error', { size: 28, filled: true })), h('div', null, t('unsafe.body', { count: unsafe.length, n: i18n.formatNumber(unsafe.length), name: w.listing?.name || '' }))),
    h(
      'ul',
      { class: 'arc-unsafe-list' },
      shown.map((u) => h('li', null, h('span', { class: 'mono ellipsis selectable', 'data-tip': u.link ? `${u.path} → ${u.link}` : u.path }, u.link ? `${u.path} → ${u.link}` : u.path), h('span', { class: 'caption text-2' }, t(`unsafe.${u.reason}`)))),
      unsafe.length > shown.length ? h('li', { class: 'caption text-2' }, t('unsafe.more', { n: i18n.formatNumber(unsafe.length - shown.length) })) : null,
    ),
  );
  const v = await ui.dialog({
    title: t('unsafe.title'),
    body,
    parent: w.win,
    width: 560,
    buttons: [
      { label: t('unsafe.skip'), value: 'skip', primary: true },
      { label: t('common.cancel'), value: null },
    ],
  });
  return v === 'skip';
}

export async function bombDialog(w, { total, ratio }) {
  const { h, t, ui, icon, i18n } = w;
  const body = h(
    'div',
    { class: 'arc-dlg arc-dlg-warn' },
    h(
      'div',
      { class: 'arc-warn-head' },
      h('div', { class: 'arc-warn-ic' }, icon('warning', { size: 28, filled: true })),
      h('div', null, t('bomb.body', { size: i18n.formatSize(total), ratio: i18n.formatNumber(Math.round(ratio)) })),
    ),
  );
  const v = await ui.dialog({
    title: t('bomb.title'),
    body,
    parent: w.win,
    width: 520,
    buttons: [
      { label: t('bomb.extract'), value: 'go' },
      { label: t('common.cancel'), value: null, primary: true },
    ],
  });
  return v === 'go';
}

// ------------------------------------------------------------------ errors / results
export async function errorDialog(w, title, e, extra = null) {
  const { h, t, ui } = w;
  const info = errorInfo(t, e);
  const details = info.details && info.details !== info.message ? h('div', { class: 'arc-details mono selectable', hidden: true }, info.details) : null;
  const toggle = details
    ? h('button', {
        class: 'btn subtle small arc-details-toggle',
        'aria-expanded': 'false',
        onclick: () => {
          details.hidden = !details.hidden;
          toggle.setAttribute('aria-expanded', String(!details.hidden));
          toggle.textContent = details.hidden ? t('err.showDetails') : t('err.hideDetails');
        },
      }, t('err.showDetails'))
    : null;
  const body = h('div', { class: 'arc-dlg arc-dlg-error' }, h('div', { class: 'selectable' }, info.message), extra ? h('div', { class: 'text-2' }, extra) : null, toggle, details);
  await ui.dialog({ title, body, parent: w.win, width: 520 });
}

export async function testResultDialog(w, res) {
  const { h, t, ui, icon, i18n } = w;
  const ok = res.ok;
  const body = h(
    'div',
    { class: 'arc-dlg arc-dlg-test' },
    h(
      'div',
      { class: ['arc-test-head', ok ? 'ok' : 'bad'] },
      h('div', { class: 'arc-test-ic' }, icon(ok ? 'checkmark_circle' : 'error_circle', { size: 28, filled: true })),
      h('div', null, h('div', { class: 'body-strong' }, ok ? t('test.ok') : t('test.bad')), h('div', { class: 'text-2' }, t('test.count', { count: res.files, n: i18n.formatNumber(res.files), name: w.listing?.name || '' }))),
    ),
    !ok ? h('div', { class: 'arc-details mono selectable' }, res.errors.join('\n')) : null,
  );
  await ui.dialog({ title: t('test.title'), body, parent: w.win, width: 520 });
}

export async function confirmDelete(w, nodes) {
  const { t, ui, i18n } = w;
  const msg = nodes.length === 1 ? t('del.one', { name: nodes[0].name }) : t('del.many', { count: nodes.length, n: i18n.formatNumber(nodes.length) });
  return ui.confirm(`${msg}\n\n${t('del.permanent')}`, { title: t('del.title'), okLabel: t('del.ok'), parent: w.win });
}

// ------------------------------------------------------------------ properties
export async function propertiesDialog(w, nodes) {
  const { h, t, ui, i18n } = w;
  const L = w.listing;
  const rows = [];
  const row = (k, v) => v !== '' && v != null && rows.push(h('div', { class: 'arc-prop' }, h('div', { class: 'arc-prop-k text-2' }, k), h('div', { class: 'arc-prop-v selectable' }, v)));
  const fmtDate = (ms) => (ms ? i18n.formatDate(ms, { dateStyle: 'long', timeStyle: 'short' }) : '');
  const pct = (r) => (r == null ? '' : t('fmt.pct', { n: i18n.formatNumber(Math.round(r * 100)) }));
  let head;
  if (!nodes.length) {
    head = { icon: iconUrl({ name: L.name }), name: L.name, sub: t('props.archiveType', { fmt: (L.format || '').toUpperCase() }) };
    row(t('props.location'), dirname(L.path));
    row(t('props.sizeOnDisk'), `${i18n.formatSize(L.size)} (${t('props.bytes', { n: i18n.formatNumber(L.size) })})`);
    row(t('props.contains'), containsText(L.files, L.dirs, t, i18n));
    row(t('props.uncompressed'), `${i18n.formatSize(L.totalSize)} (${t('props.bytes', { n: i18n.formatNumber(L.totalSize) })})`);
    row(t('props.ratio'), L.totalSize ? pct(ratioOf(L.totalSize, L.size)) : '');
    row(t('props.method'), methodName(L.method, t));
    if (L.kind === '7z') row(t('props.solid'), L.solid ? t('common.yes') : t('common.no'));
    row(t('props.encrypted'), L.headersEncrypted ? t('props.encHeaders') : L.encrypted ? t('props.encData') : t('common.no'));
    row(t('props.modified'), fmtDate(L.mtime));
    row(t('props.writable'), L.canAdd ? t('common.yes') : t('props.readOnly'));
    if (L.comment) row(t('props.comment'), L.comment);
  } else if (nodes.length === 1) {
    const n = nodes[0];
    head = { icon: iconUrl(n), name: n.name, sub: typeName(n, t) };
    row(t('props.locationIn'), `${L.name}/${n.parent?.path ? `${n.parent.path}/` : ''}`);
    if (n.dir) {
      row(t('props.contains'), containsText(n.files, n.dirs, t, i18n));
      row(t('props.size'), i18n.formatSize(n.tsize));
      if (L.perEntryPacked) row(t('props.packed'), i18n.formatSize(n.tpacked));
    } else {
      row(t('props.size'), `${i18n.formatSize(n.size)} (${t('props.bytes', { n: i18n.formatNumber(n.size) })})`);
      if (L.perEntryPacked && n.packed != null) {
        row(t('props.packed'), i18n.formatSize(n.packed));
        row(t('props.ratio'), pct(ratioOf(n.size, n.packed)));
      }
      if (n.method) row(t('props.method'), methodName(n.method, t));
      if (n.link) row(t('props.linkTarget'), n.link);
    }
    row(t('props.modified'), fmtDate(n.mtime));
    if (n.mode != null && L.kind !== 'rar') row(t('props.perms'), h('span', { class: 'mono' }, modeString(n.mode, n.dir)));
    row(t('props.encrypted'), n.encrypted || n.anyEncrypted ? t('common.yes') : t('common.no'));
  } else {
    const files = nodes.reduce((s, n) => s + (n.dir ? n.files : 1), 0);
    const size = nodes.reduce((s, n) => s + (n.dir ? n.tsize : n.size), 0);
    head = { icon: iconUrl({ dir: false, name: '' }), name: t('props.multi', { count: nodes.length, n: i18n.formatNumber(nodes.length) }), sub: '' };
    const parents = new Set(nodes.map((n) => n.parent?.path ?? ''));
    if (parents.size === 1) row(t('props.locationIn'), `${L.name}/${[...parents][0] ? `${[...parents][0]}/` : ''}`);
    row(t('props.contains'), t('props.filesVal', { count: files, n: i18n.formatNumber(files) }));
    row(t('props.size'), i18n.formatSize(size));
  }
  const body = h(
    'div',
    { class: 'arc-dlg arc-dlg-props' },
    h('div', { class: 'arc-props-head' }, h('img', { src: head.icon, alt: '', width: 40, height: 40 }), h('div', { class: 'grow' }, h('div', { class: 'subtitle ellipsis' }, head.name), head.sub ? h('div', { class: 'text-2' }, head.sub) : null)),
    h('div', { class: 'arc-props' }, rows),
  );
  await ui.dialog({ title: t('props.title'), body, parent: w.win, width: 520 });
}
