// Dialogs of the PDF Reader: password, document properties, external links, unsaved changes,
// "Open with" app chooser and "Go to page".

/** Ask for the password of an encrypted document. Resolves to the password or null (canceled). */
export async function askPassword(doc, incorrect) {
  const { h, t, w } = doc;
  const { ui, icon } = doc.ctx;
  w.activateDoc(doc);
  const input = h('input', { class: 'input', type: 'password', autocomplete: 'off', spellcheck: false, 'aria-label': t('password.label'), style: { width: '100%' } });
  const err = h('div', { class: 'pdf-pw-error caption', role: 'alert' }, incorrect ? t('password.wrong') : '');
  const body = h(
    'div',
    { class: 'pdf-pw' },
    h('div', { class: 'pdf-pw-head' }, h('div', { class: 'pdf-pw-icon' }, icon('lock_closed', { size: 24, filled: true })), h('div', { class: 'pdf-pw-text' }, t('password.body', { name: doc.name }))),
    h('label', { class: 'field', style: { margin: '0' } }, h('span', { class: 'caption text-2' }, t('password.label')), input),
    err,
  );
  if (incorrect) input.classList.add('invalid');
  const v = await ui.dialog({
    title: t('password.title'),
    body,
    parent: w.win,
    className: 'pdf-dialog',
    width: 420,
    buttons: [
      { label: t('password.open'), value: 'ok', primary: true },
      { label: t('common.cancel'), value: null },
    ],
    onOpen: (dlg, done) => {
      // The tab can go away while the question is open (window closed from the taskbar…): close it too.
      doc.closePasswordDialog = () => done(null);
      dlg._validate = (val) => {
        if (val === 'ok' && !input.value) {
          err.textContent = t('password.empty');
          input.classList.add('invalid');
          input.focus({ preventScroll: true });
          return false;
        }
        return true;
      };
      setTimeout(() => input.focus({ preventScroll: true }), 50);
    },
  });
  doc.closePasswordDialog = null;
  return v === 'ok' ? input.value : null;
}

// ---------------------------------------------------------------- properties
const PAPER = [
  ['A3', 297, 420],
  ['A4', 210, 297],
  ['A5', 148, 210],
  ['B5', 176, 250],
  ['Letter', 215.9, 279.4],
  ['Legal', 215.9, 355.6],
  ['Tabloid', 279.4, 431.8],
];

export function paperName(wmm, hmm) {
  const [a, b] = [Math.min(wmm, hmm), Math.max(wmm, hmm)];
  for (const [n, pw, ph] of PAPER) if (Math.abs(a - pw) < 1.5 && Math.abs(b - ph) < 1.5) return n;
  return null;
}

export async function properties(doc) {
  const { h, t, w } = doc;
  const { ui, i18n, api } = doc.ctx;
  const { lib } = doc.E;
  let meta = {};
  try {
    meta = await doc.pdf.getMetadata();
  } catch {}
  const info = meta.info || {};
  const md = meta.metadata;
  const st = await api.invoke('fs:stat', doc.path).catch(() => null);
  const pick = (mdKey, infoKey) => {
    const a = md?.get?.(mdKey);
    const v = (typeof a === 'string' && a.trim()) || (typeof info[infoKey] === 'string' && info[infoKey].trim()) || '';
    return v;
  };
  const date = (raw) => {
    if (!raw) return '';
    const d = lib.PDFDateString.toDateObject(raw);
    return d ? i18n.formatDate(d, { dateStyle: 'long', timeStyle: 'short' }) : String(raw);
  };
  let pageSize = '';
  try {
    const page = await doc.pdf.getPage(doc.pageNum || 1);
    const [x0, y0, x1, y1] = page.view;
    let wpt = Math.abs(x1 - x0) * (page.userUnit || 1);
    let hpt = Math.abs(y1 - y0) * (page.userUnit || 1);
    if (((page.rotate + (doc.rotation || 0)) % 180 + 180) % 180 === 90) [wpt, hpt] = [hpt, wpt];
    const mm = (v) => (v * 25.4) / 72;
    const fmt = (v, d) => i18n.formatNumber(v, { maximumFractionDigits: d });
    const name = paperName(mm(wpt), mm(hpt));
    const orient = t(wpt > hpt ? 'props.landscape' : 'props.portrait');
    const dims = doc.ctx.lang === 'fr' ? `${fmt(mm(wpt), 0)} × ${fmt(mm(hpt), 0)} mm` : `${fmt(wpt / 72, 2)} × ${fmt(hpt / 72, 2)} in`;
    pageSize = name ? `${dims} (${name}, ${orient})` : `${dims} (${orient})`;
  } catch {}
  const size = st?.size ?? doc.fileSize;
  const sizeText = size != null ? `${ui.formatSize(size)} (${t('props.bytes', { n: i18n.formatNumber(size) })})` : '';
  const sections = [
    [
      t('props.file'),
      [
        ['name', t('props.name'), doc.name],
        ['location', t('props.location'), doc.path.replace(/\/[^/]*$/, '') || '/'],
        ['size', t('props.size'), sizeText],
      ],
    ],
    [
      t('props.description'),
      [
        ['title', t('props.title'), pick('dc:title', 'Title')],
        ['author', t('props.author'), pick('dc:creator', 'Author')],
        ['subject', t('props.subject'), pick('dc:description', 'Subject')],
        ['keywords', t('props.keywords'), pick('pdf:keywords', 'Keywords')],
        ['created', t('props.created'), date(info.CreationDate)],
        ['modified', t('props.modified'), date(info.ModDate)],
        ['creator', t('props.creator'), pick('xmp:creatortool', 'Creator')],
      ],
    ],
    [
      t('props.advanced'),
      [
        ['producer', t('props.producer'), pick('pdf:producer', 'Producer')],
        ['version', t('props.version'), info.PDFFormatVersion || ''],
        ['pages', t('props.pages'), i18n.formatNumber(doc.pages)],
        ['pageSize', t('props.pageSize'), pageSize],
        ['encrypted', t('props.encrypted'), t(info.EncryptFilterName ? 'common.yes' : 'common.no')],
      ],
    ],
  ];
  const body = h(
    'div',
    { class: 'pdf-props' },
    h('div', { class: 'pdf-props-head' }, h('img', { src: doc.ctx.appUrl('icon.svg'), alt: '', width: 32, height: 32 }), h('div', { class: 'pdf-props-name body-strong ellipsis' }, doc.name)),
    sections.map(([title, rows]) =>
      h(
        'section',
        { class: 'pdf-props-sec' },
        h('div', { class: 'pdf-props-sec-title caption' }, title),
        h(
          'dl',
          { class: 'pdf-props-grid' },
          rows.map(([key, label, value]) => [h('dt', { class: 'text-2' }, label), h('dd', { class: ['selectable', !value && 'text-3'], dataset: { key } }, value || '—')]),
        ),
      ),
    ),
  );
  await ui.dialog({ title: t('props.dialogTitle'), body, parent: w.win, className: 'pdf-dialog pdf-props-dialog', width: 520, buttons: [{ label: t('common.close'), value: true, primary: true }] });
}

// ---------------------------------------------------------------- external links
/** Confirm before leaving the document for a web page. Resolves 'open' | 'copy' | null. */
export async function confirmLink(w, url) {
  const { h, t } = w;
  const { ui } = w.ctx;
  const ok = /^(https?|mailto):/i.test(url);
  if (!ok) {
    await ui.dialog({
      title: t('link.blockedTitle'),
      body: h('div', { class: 'pdf-link' }, h('div', null, t('link.blockedBody')), h('div', { class: 'pdf-link-url selectable' }, url)),
      parent: w.win,
      className: 'pdf-dialog',
      width: 460,
      buttons: [{ label: t('common.ok'), value: true, primary: true }],
    });
    return null;
  }
  const isMail = /^mailto:/i.test(url);
  return ui.dialog({
    title: t(isMail ? 'link.mailTitle' : 'link.title'),
    body: h('div', { class: 'pdf-link' }, h('div', null, t(isMail ? 'link.mailBody' : 'link.body')), h('div', { class: 'pdf-link-url selectable' }, url)),
    parent: w.win,
    className: 'pdf-dialog',
    width: 460,
    buttons: [
      { label: t('link.open'), value: 'open', primary: true },
      { label: t('link.copy'), value: 'copy' },
      { label: t('common.cancel'), value: null },
    ],
  });
}

// ---------------------------------------------------------------- unsaved changes
/** 'save' | 'discard' | null (cancel) */
export function askSave(doc) {
  const { t, w } = doc;
  return doc.ctx.ui.dialog({
    title: w.appName,
    body: t('save.ask', { name: doc.name }),
    parent: w.win,
    className: 'pdf-dialog',
    buttons: [
      { label: t('save.save'), value: 'save', primary: true },
      { label: t('save.dontSave'), value: 'discard' },
      { label: t('common.cancel'), value: null },
    ],
  });
}

// ---------------------------------------------------------------- open with
export async function chooseApp(w, path) {
  const { h, t } = w;
  const { ui } = w.ctx;
  const reg = w.ctx.shell.registry;
  const { suggested, others } = openWithApps(reg);
  let selected = suggested[0]?.id || others[0]?.id || null;
  const rows = [];
  const pick = (id) => {
    selected = id;
    for (const r of rows) {
      r.classList.toggle('selected', r.dataset.id === id);
      r.setAttribute('aria-selected', String(r.dataset.id === id));
    }
  };
  let doneRef = null;
  const mkRow = (m) => {
    const r = h(
      'div',
      {
        class: ['pdf-app-row', m.id === selected && 'selected'],
        role: 'option',
        'aria-selected': String(m.id === selected),
        dataset: { id: m.id },
        onclick: () => pick(m.id),
        ondblclick: () => {
          pick(m.id);
          doneRef?.('open');
        },
      },
      h('img', { src: reg.iconUrl(m.id), alt: '', width: 24, height: 24 }),
      h('span', { class: 'ellipsis' }, reg.name(m.id)),
    );
    rows.push(r);
    return r;
  };
  const list = h('div', { class: 'pdf-apps', role: 'listbox', tabindex: '0', 'aria-label': t('openWith.title') });
  if (suggested.length) list.append(h('div', { class: 'pdf-apps-head caption' }, t('openWith.suggested')), ...suggested.map(mkRow));
  if (others.length) list.append(h('div', { class: 'pdf-apps-head caption' }, t('openWith.others')), ...others.map(mkRow));
  list.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const i = rows.findIndex((r) => r.dataset.id === selected);
    const n = rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
    if (n) {
      pick(n.dataset.id);
      n.scrollIntoView({ block: 'nearest' });
    }
  });
  const v = await ui.dialog({
    title: t('openWith.title'),
    body: h('div', { class: 'pdf-openwith' }, h('div', { class: 'text-2 ellipsis' }, path.split('/').pop()), list),
    parent: w.win,
    className: 'pdf-dialog',
    width: 420,
    buttons: [
      { label: t('openWith.open'), value: 'open', primary: true },
      { label: t('common.cancel'), value: null },
    ],
    onOpen: (dlg, done) => {
      doneRef = done;
      setTimeout(() => list.focus({ preventScroll: true }), 40);
    },
  });
  return v === 'open' ? selected : null;
}

/** Apps that can be offered for a PDF: the ones registered for .pdf, then the ones that open files at all
 *  (games, system tools and the like are left out, as Windows does). */
export function openWithApps(reg) {
  const apps = reg.list().filter((m) => m.id !== 'pdf' && !m.hidden);
  const handles = (m, ext) => (m.fileTypes || []).includes(ext) || (m.defaultFor || []).includes(ext);
  const suggested = apps.filter((m) => handles(m, '.pdf'));
  const others = apps.filter((m) => !suggested.includes(m) && m.category !== 'games' && ((m.fileTypes || []).length || (m.defaultFor || []).length));
  return { suggested, others };
}

// ---------------------------------------------------------------- go to page
export async function goToPage(doc) {
  const { t, w } = doc;
  const v = await doc.ctx.ui.prompt({
    title: t('goto.title'),
    label: t('goto.label', { n: doc.pages }),
    value: String(doc.pageNum),
    parent: w.win,
    okLabel: t('goto.go'),
    validate: (s) => {
      const n = Number(s.trim());
      return Number.isInteger(n) && n >= 1 && n <= doc.pages ? null : t('goto.invalid', { n: doc.pages });
    },
  });
  if (v != null) doc.goToPage(Number(v.trim()));
}
