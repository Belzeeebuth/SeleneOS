// Notes dialogs and file flows: notebook (name / colour / emoji), export (Markdown, text, HTML), import
// (.md / .txt), keyboard shortcuts.
import { NOTEBOOK_COLORS, displayTitle } from '../lib/store.js';
import { htmlToMarkdown, markdownToHtml, markdownTitle } from '../lib/markdown.js';
import { sanitizeFragment, sanitizeHtml, escapeHtml, ATTACHMENT_RE, inertDocument } from '../lib/sanitize.js';
import { plainText, fileNameOf } from '../lib/text.js';
import { arrowNav } from './popover.js';

export const EMOJIS = ['📒', '📓', '📔', '📕', '📗', '📘', '📙', '📚', '✏️', '💡', '⭐', '❤️', '🏠', '💼', '🎓', '✈️', '🍳', '🎵', '🎮', '🛒', '💰', '🧪', '🌱', '🐾'];

/** Create / edit a notebook. Resolves { name, color, emoji } or null. */
export async function notebookDialog(app, nb = null) {
  const { h, ui, icon } = app.ctx;
  const t = app.t;
  let color = nb?.color || NOTEBOOK_COLORS[app.store.notebooks.length % NOTEBOOK_COLORS.length];
  let emoji = nb?.emoji || '';
  const err = h('div', { class: 'field-hint nt-field-error', role: 'alert' });
  const name = h('input', {
    class: 'input',
    value: nb?.name || '',
    placeholder: t('nb.namePlaceholder'),
    maxlength: 120,
    'aria-label': t('nb.name'),
    oninput: () => {
      err.textContent = '';
      name.classList.remove('invalid');
    },
  });
  const preview = h('span', { class: 'nt-nb-preview' });
  const paintPreview = () => {
    preview.dataset.color = color;
    preview.replaceChildren(emoji ? h('span', { class: 'nt-nb-emoji' }, emoji) : icon('notebook', { size: 20, filled: true }));
  };
  const colors = h(
    'div',
    { class: 'nt-color-grid', role: 'radiogroup', 'aria-label': t('nb.color') },
    NOTEBOOK_COLORS.map((c) =>
      h('button', {
        type: 'button',
        class: 'nt-color-dot',
        role: 'radio',
        dataset: { color: c },
        'aria-checked': String(c === color),
        'aria-label': t(`nbColor.${c}`),
        'data-tip': t(`nbColor.${c}`),
        onclick: (e) => {
          color = c;
          for (const b of colors.children) b.setAttribute('aria-checked', String(b === e.currentTarget));
          paintPreview();
        },
      }),
    ),
  );
  arrowNav(colors, 'button');
  const emojis = h(
    'div',
    { class: 'nt-emoji-grid', role: 'radiogroup', 'aria-label': t('nb.icon') },
    h('button', { type: 'button', class: 'nt-emoji-btn nt-emoji-none', role: 'radio', 'aria-checked': String(!emoji), 'aria-label': t('nb.noIcon'), 'data-tip': t('nb.noIcon'), dataset: { emoji: '' } }, icon('notebook', { size: 18, filled: true })),
    EMOJIS.map((e) => h('button', { type: 'button', class: 'nt-emoji-btn', role: 'radio', 'aria-checked': String(e === emoji), 'aria-label': e, dataset: { emoji: e } }, e)),
  );
  emojis.addEventListener('click', (e) => {
    const b = e.target.closest('.nt-emoji-btn');
    if (!b) return;
    emoji = b.dataset.emoji;
    for (const x of emojis.children) x.setAttribute('aria-checked', String(x === b));
    paintPreview();
  });
  arrowNav(emojis, 'button', { columns: 9 });
  paintPreview();
  const body = h(
    'div',
    { class: 'nt-nb-dialog' },
    h('div', { class: 'field' }, h('label', null, t('nb.name')), h('div', { class: 'nt-nb-name-row' }, preview, name), err),
    h('div', { class: 'field' }, h('label', null, t('nb.color')), colors),
    h('div', { class: 'field' }, h('label', null, t('nb.icon')), emojis),
  );
  const res = await ui.dialog({
    title: nb ? t('nb.editTitle') : t('nb.newTitle'),
    body,
    parent: app.ctx.win,
    className: 'nt-dialog',
    buttons: [
      { label: nb ? t('save') : t('nb.create'), value: 'ok', primary: true },
      { label: t('common.cancel'), value: null },
    ],
    onOpen: (dlg) => {
      dlg._validate = (v) => {
        if (v !== 'ok') return true;
        const n = name.value.trim();
        const clash = app.store.notebooks.find((b) => b.id !== nb?.id && b.name.toLocaleLowerCase() === n.toLocaleLowerCase());
        if (!n) err.textContent = t('nb.nameRequired');
        else if (clash) err.textContent = t('nb.nameTaken', { name: n });
        else return true;
        name.classList.add('invalid');
        name.focus();
        return false;
      };
      setTimeout(() => {
        name.focus();
        name.select();
      }, 40);
    },
  });
  return res === 'ok' ? { name: name.value.trim(), color, emoji } : null;
}

// ---------------------------------------------------------------- export
const EXPORT_CSS = `body{font:16px/1.55 "Segoe UI","Inter","Noto Sans",system-ui,sans-serif;color:#1b1b1b;background:#fff;max-width:820px;margin:40px auto;padding:0 24px}
h1.title{font-size:30px;line-height:1.25;margin:0 0 4px}.meta{color:#666;font-size:13px;margin:0 0 24px}
img{max-width:100%;height:auto;border-radius:6px}pre{font:14px/1.5 "Cascadia Code","DejaVu Sans Mono",monospace;background:#f3f3f3;border-radius:6px;padding:12px 14px;white-space:pre-wrap}
code{font-family:"Cascadia Code","DejaVu Sans Mono",monospace;background:#f0f0f0;border-radius:4px;padding:1px 4px}pre code{background:none;padding:0}
blockquote{margin:8px 0;padding:2px 14px;border-left:3px solid #0067c0;color:#444}table{border-collapse:collapse;margin:8px 0}td,th{border:1px solid #ccc;padding:6px 10px;vertical-align:top}th{background:#f6f6f6;text-align:left}
ul[data-type=checklist]{list-style:none;padding-left:4px}ul[data-type=checklist]>li::before{content:"\\2610";margin-right:8px}ul[data-type=checklist]>li[data-checked=true]::before{content:"\\2611"}
ul[data-type=checklist]>li[data-checked=true]{color:#777;text-decoration:line-through}mark{background:#fff3a3;color:inherit}mark[data-hl=green]{background:#c9f2c4}mark[data-hl=blue]{background:#c7e0ff}mark[data-hl=pink]{background:#ffd0e6}mark[data-hl=orange]{background:#ffdcb8}mark[data-hl=purple]{background:#e2d4ff}
[data-color=red]{color:#c42b1c}[data-color=orange]{color:#ca5010}[data-color=green]{color:#0f7b0f}[data-color=blue]{color:#0063b1}[data-color=purple]{color:#8764b8}[data-color=gray]{color:#69797e}`;

function stored(note) {
  // the note body as a detached element (attachments referenced by file name), in an inert document so
  // that nothing is fetched while it is converted
  const doc = inertDocument();
  const box = doc.createElement('div');
  box.appendChild(sanitizeFragment(note.html || '', { attachments: true, allowMedia: true, allowRemote: true, doc }));
  return box;
}
function attName(img) {
  const src = img.getAttribute('src') || '';
  return img.dataset.att || (ATTACHMENT_RE.test(src) ? src : null);
}

export async function exportNote(app, note, format) {
  const { ui, api } = app.ctx;
  const t = app.t;
  await app.saveCurrent();
  note = app.store.get(note.id) || note;
  const title = displayTitle(note) || t('untitled');
  const ext = { md: '.md', txt: '.txt', html: '.html' }[format];
  const filters = { md: [{ name: t('fmt.md'), ext: ['.md'] }], txt: [{ name: t('fmt.txt'), ext: ['.txt'] }], html: [{ name: t('fmt.html'), ext: ['.html'] }] }[format];
  const dest = await ui.filePicker({ mode: 'save', title: t('export.title'), name: `${fileNameOf(title, t('untitled'))}${ext}`, filters, parent: app.ctx.win });
  if (!dest) return null;
  try {
    const box = stored(note);
    const dir = dest.replace(/\/[^/]+$/, '');
    const base = dest.split('/').pop().replace(/\.[^.]+$/, '');
    let text;
    if (format === 'md') {
      const assets = `${base}_files`;
      const names = [];
      const md = htmlToMarkdown(box, {
        image: (img) => {
          const n = attName(img);
          if (n) {
            names.push(n);
            return `${encodeURI(assets)}/${n}`;
          }
          const src = img.getAttribute('src') || '';
          return /^https?:/i.test(src) ? src : '';
        },
      });
      text = `# ${title.replace(/([\\`*_[\]<])/g, '\\$1')}\n\n${md}`;
      if (names.length) await api.invoke('notes:exportAssets', note.id, names, `${dir}/${assets}`);
    } else if (format === 'txt') {
      text = `${title}\n\n${plainText(box, { bullets: true, checklistMarks: true })}\n`;
    } else {
      for (const img of box.querySelectorAll('img')) {
        const n = attName(img);
        if (!n) continue;
        try {
          img.setAttribute('src', await api.invoke('notes:dataUrl', `${app.store.root}/${note.id}/${n}`));
        } catch {
          img.remove();
        }
        img.removeAttribute('data-att');
      }
      text = `<!doctype html>\n<html lang="${app.ctx.lang}">\n<head>\n<meta charset="utf-8">\n<meta name="generator" content="Aurora Notes">\n<title>${escapeHtml(title)}</title>\n<style>${EXPORT_CSS}</style>\n</head>\n<body>\n<h1 class="title">${escapeHtml(title)}</h1>\n<p class="meta">${escapeHtml(app.fmtDate(note.modified, true))}</p>\n${box.innerHTML}\n</body>\n</html>\n`;
    }
    await api.invoke('fs:writeText', dest, text);
    app.toast(t('export.done', { name: dest.split('/').pop() }));
    return dest;
  } catch (err) {
    app.error(t('errors.export', { message: err.message }));
    return null;
  }
}

// ---------------------------------------------------------------- import
export async function importFiles(app, paths) {
  const { ui, api } = app.ctx;
  const t = app.t;
  if (!paths) {
    paths = await ui.filePicker({ mode: 'open', multiple: true, title: t('import.title'), filters: [{ name: t('fmt.importable'), ext: ['.md', '.markdown', '.txt'] }], parent: app.ctx.win });
    if (!paths) return [];
  }
  const list = Array.isArray(paths) ? paths : [paths];
  const created = [];
  const failed = [];
  const notebookId = app.view.kind === 'notebook' ? app.view.id : app.store.notebooks[0]?.id;
  for (const p of list) {
    try {
      const st = await api.invoke('fs:stat', p);
      if (!st || st.dir) throw new Error(t('errors.notAFile'));
      if (st.size > 8 * 1024 * 1024) throw new Error(t('errors.tooBig'));
      const raw = await api.invoke('fs:readText', p);
      const fileTitle = p.split('/').pop().replace(/\.(md|markdown|txt)$/i, '');
      const isMd = /\.(md|markdown)$/i.test(p);
      let title = fileTitle;
      let html;
      if (isMd) {
        const mt = markdownTitle(raw);
        if (mt.title) title = mt.title;
        html = markdownToHtml(mt.title ? mt.body : raw);
      } else {
        html = raw
          .replace(/\r\n?/g, '\n')
          .split('\n')
          .map((l) => (l ? `<div>${escapeHtml(l)}</div>` : '<div><br></div>'))
          .join('');
      }
      const note = await app.store.create({ title, html: '', notebookId });
      // pictures referenced by the Markdown file are copied into the note
      const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
      const dir = p.replace(/\/[^/]+$/, '');
      for (const img of doc.querySelectorAll('img')) {
        const src = img.getAttribute('src') || '';
        let payload = null;
        if (/^https?:/i.test(src)) payload = { url: src };
        else if (/^data:image\//i.test(src)) payload = { dataUrl: src };
        else if (src && !/^[a-z][a-z0-9+.-]*:/i.test(src)) payload = { path: resolvePath(dir, safeDecode(src)) };
        else if (/^file:\/\//i.test(src)) payload = { path: safeDecode(src.slice(7)) };
        if (!payload) {
          img.remove();
          continue;
        }
        try {
          const res = await api.invoke('notes:attach', note.id, payload);
          img.setAttribute('src', res.name);
          img.setAttribute('data-att', res.name);
        } catch {
          if (!payload.url) img.remove();
        }
      }
      const clean = sanitizeHtml(doc.body.innerHTML, { attachments: true, allowRemote: true });
      await app.store.update(note.id, { html: clean, title }, { touch: true });
      created.push(note.id);
    } catch (err) {
      failed.push(`${p.split('/').pop()}: ${err.message}`);
    }
  }
  if (failed.length) app.error(`${t('errors.import')}\n\n${failed.join('\n')}`);
  if (created.length) app.toast(t('import.done', { count: created.length }));
  return created;
}

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
function resolvePath(dir, rel) {
  if (rel.startsWith('/')) return rel;
  const parts = `${dir}/${rel}`.split('/');
  const out = [];
  for (const p of parts) {
    if (!p || p === '.') continue;
    if (p === '..') out.pop();
    else out.push(p);
  }
  return `/${out.join('/')}`;
}

// ---------------------------------------------------------------- shortcuts
export function shortcutsDialog(app) {
  const { h, ui } = app.ctx;
  const t = app.t;
  const rows = [
    ['Ctrl+N', t('keys.newNote')],
    ['Ctrl+Shift+N', t('keys.newNotebook')],
    ['Ctrl+E', t('keys.search')],
    ['Ctrl+F', t('keys.find')],
    ['Ctrl+P', t('keys.pin')],
    ['Delete', t('keys.delete')],
    ['Ctrl+B / I / U', t('keys.biu')],
    ['Ctrl+Shift+X', t('ed.strike')],
    ['Ctrl+Shift+K', t('ed.inlineCode')],
    ['Ctrl+K', t('ed.link')],
    ['Ctrl+Shift+8', t('ed.bullets')],
    ['Ctrl+Shift+7', t('ed.numbers')],
    ['Ctrl+Shift+C', t('ed.checklist')],
    ['Ctrl+Enter', t('keys.toggleCheck')],
    ['Ctrl+Alt+0…3', t('keys.headings')],
    ['Ctrl+Alt+C', t('ed.codeBlock')],
    ['Ctrl+Shift+.', t('ed.quote')],
    ['Ctrl+Space', t('ed.clear')],
    ['Ctrl+Shift+V', t('ed.pastePlain')],
    ['Ctrl+Z / Ctrl+Y', `${t('ed.undo')} / ${t('ed.redo')}`],
  ];
  return ui.dialog({
    title: t('keys.title'),
    parent: app.ctx.win,
    className: 'nt-dialog',
    body: h('div', { class: 'nt-keys' }, rows.map(([k, label]) => h('div', { class: 'nt-key-row' }, h('span', null, label), h('kbd', null, app.kl(k))))),
    buttons: [{ label: t('common.close'), value: true, primary: true }],
  });
}
