// Notepad dialogs: save prompts, Go to line, Font, error messages. All go through nw.dialog():
// window-modal (so they follow the app theme too), or screen-level when the window is too small
// for the dialog (it then gets the app theme class).
import { FONT_SIZES } from './shared.js';

export const STYLES = [
  ['light', 300, false],
  ['lightItalic', 300, true],
  ['regular', 400, false],
  ['italic', 400, true],
  ['semibold', 600, false],
  ['semiboldItalic', 600, true],
  ['bold', 700, false],
  ['boldItalic', 700, true],
];

const PREFERRED = ['Cascadia Mono', 'Cascadia Code', 'DejaVu Sans Mono', 'Noto Sans Mono', 'Liberation Mono', 'Inter', 'DejaVu Sans', 'Noto Sans', 'Noto Serif', 'DejaVu Serif', 'Liberation Sans', 'Liberation Serif'];

export function styleKey(font) {
  const s = STYLES.find(([, w, i]) => w === Number(font.weight || 400) && i === !!font.italic);
  return s ? s[0] : 'regular';
}

export function fontCss(font) {
  return `"${String(font.family || 'Cascadia Mono').replace(/"/g, '')}", var(--font-mono)`;
}

export async function askSave(nw, doc) {
  const { t } = nw;
  const v = await nw.dialog({
    title: nw.appName,
    body: t('ask.save', { name: doc.path || doc.title }),
    className: 'np-dialog np-ask',
    buttons: [
      { label: t('common.save'), value: 'save', primary: true },
      { label: t('ask.dontSave'), value: 'discard' },
      { label: t('common.cancel'), value: null },
    ],
  }, { w: 380, h: 260 });
  return v || null;
}

/** Several unsaved tabs: list them with checkboxes. -> { action: 'save', docs } | { action: 'discard' } | null */
export async function askSaveMany(nw, docs) {
  const { t, h } = nw;
  const boxes = docs.map((d) => {
    const input = h('input', { type: 'checkbox', checked: true, 'aria-label': d.path || d.title });
    // name, and the folder underneath (the end of a long folder path is the useful part)
    const dir = d.path ? d.path.slice(0, d.path.lastIndexOf('/')) || '/' : null;
    return {
      d,
      input,
      el: h(
        'label',
        { class: 'checkbox np-ask-item', 'data-tip': d.path || null },
        input,
        h('span', { class: 'np-ask-text' }, h('span', { class: 'ellipsis np-ask-name' }, d.title), dir ? h('span', { class: 'caption text-2 np-ask-path' }, h('bdi', null, dir)) : null),
      ),
    };
  });
  const body = h('div', { class: 'np-ask-many' }, h('div', null, t('ask.saveMany')), h('div', { class: 'np-ask-list' }, boxes.map((b) => b.el)));
  const v = await nw.dialog({
    title: nw.appName,
    body,
    className: 'np-dialog np-ask',
    buttons: [
      { label: t('common.save'), value: 'save', primary: true },
      { label: t('ask.dontSave'), value: 'discard' },
      { label: t('common.cancel'), value: null },
    ],
  }, { w: 460, h: 300 + 44 * Math.min(docs.length, 4) });
  if (v === 'save') return { action: 'save', docs: boxes.filter((b) => b.input.checked).map((b) => b.d) };
  if (v === 'discard') return { action: 'discard' };
  return null;
}

export async function goToLine(nw, doc) {
  const { t, h } = nw;
  const max = doc.lineCount();
  const cur = doc.lineCol(doc.ta.selectionStart).line;
  const input = h('input', { class: 'input np-goto-input', type: 'text', inputmode: 'numeric', value: String(cur), autocomplete: 'off', spellcheck: false });
  const err = h('div', { class: 'field-hint np-goto-err', 'aria-live': 'polite' });
  const label = h('label', { class: 'np-goto-label' }, t('goto.label'));
  const body = h('div', { class: 'field np-goto' }, label, input, err);
  const parse = () => {
    const s = input.value.trim();
    const n = Number(s);
    return /^\d+$/.test(s) && n >= 1 && n <= max ? n : null;
  };
  const v = await nw.dialog({
    title: t('goto.title'),
    body,
    className: 'np-dialog np-goto-dlg',
    buttons: [
      { label: t('goto.go'), value: 'ok', primary: true },
      { label: t('common.cancel'), value: null },
    ],
    onOpen: (dlg) => {
      dlg._validate = () => {
        if (parse() != null) return true;
        err.textContent = t('goto.range', { max: nw.fmt(max) });
        input.classList.add('invalid');
        input.focus();
        input.select();
        return false;
      };
      input.addEventListener('input', () => {
        err.textContent = '';
        input.classList.remove('invalid');
      });
      setTimeout(() => {
        input.focus();
        input.select();
      }, 40);
    },
  }, { w: 380, h: 260 });
  return v === 'ok' ? parse() : null;
}

export function alert(nw, title, message, detail) {
  const { h } = nw;
  const body = h('div', { class: 'np-alert' }, h('div', { class: 'selectable' }, message), detail ? h('div', { class: 'caption text-2 selectable np-alert-detail' }, detail) : null);
  return nw.dialog({ title, body, className: 'np-dialog', buttons: [{ label: nw.t('common.ok'), value: true, primary: true }] }, { w: 380, h: detail ? 360 : 260 });
}

export async function confirm(nw, { title, message, ok, cancel, danger }) {
  const { t } = nw;
  const v = await nw.dialog({
    title,
    body: message,
    className: 'np-dialog',
    buttons: [
      { label: ok || t('common.ok'), value: true, primary: !danger, danger },
      { label: cancel || t('common.cancel'), value: false },
    ],
  }, { w: 380, h: 280 });
  return v === true;
}

/** Family / style / size pickers with a live preview. onChange(font) fires on every change. */
export function fontControls(nw, font, fonts, onChange) {
  const { h, t } = nw;
  let cur = { ...font };
  const installed = fonts?.all || [];
  const mono = new Set(fonts?.mono || []);
  let monoList;
  let otherList;
  if (installed.length) {
    monoList = installed.filter((f) => mono.has(f));
    otherList = installed.filter((f) => !mono.has(f));
  } else {
    monoList = PREFERRED.filter((f) => /mono|code/i.test(f));
    otherList = PREFERRED.filter((f) => !/mono|code/i.test(f));
  }
  if (!installed.includes(cur.family) && ![...monoList, ...otherList].includes(cur.family)) monoList.unshift(cur.family);
  const opt = (f) => h('option', { value: f, selected: f === cur.family, style: { fontFamily: `"${f}"` } }, f);
  const family = h(
    'select',
    { class: 'select np-font-family', 'aria-label': t('font.family') },
    monoList.length ? h('optgroup', { label: t('font.monoGroup') }, monoList.map(opt)) : null,
    otherList.length ? h('optgroup', { label: t('font.otherGroup') }, otherList.map(opt)) : null,
  );
  const style = h(
    'select',
    { class: 'select np-font-style', 'aria-label': t('font.style') },
    STYLES.map(([k]) => h('option', { value: k, selected: k === styleKey(cur) }, t(`font.styles.${k}`))),
  );
  const sizes = [...new Set([...FONT_SIZES, Number(cur.size) || 11])].sort((a, b) => a - b);
  const size = h(
    'select',
    { class: 'select np-font-size', 'aria-label': t('font.size') },
    sizes.map((s) => h('option', { value: String(s), selected: s === Number(cur.size) }, nw.fmt(s))),
  );
  const sample = h('div', { class: 'np-font-sample' }, h('div', null, t('font.sample')), h('div', null, '0123456789 {} [] () <> ;:,. !? @#$%&*'));
  const preview = h('div', { class: 'np-font-preview', 'aria-label': t('font.preview') }, sample);
  const paint = () => {
    sample.style.fontFamily = fontCss(cur);
    sample.style.fontWeight = String(cur.weight || 400);
    sample.style.fontStyle = cur.italic ? 'italic' : 'normal';
    sample.style.fontSize = `${((Number(cur.size) || 11) * 4) / 3}px`;
  };
  const update = () => {
    const st = STYLES.find(([k]) => k === style.value) || STYLES[2];
    cur = { family: family.value, weight: st[1], italic: st[2], size: Number(size.value) || 11 };
    paint();
    onChange?.(cur);
  };
  family.addEventListener('change', update);
  style.addEventListener('change', update);
  size.addEventListener('change', update);
  paint();
  const field = (label, control) => h('label', { class: 'np-font-field' }, h('span', { class: 'np-font-label' }, label), control);
  const el = h(
    'div',
    { class: 'np-font-controls' },
    h('div', { class: 'np-font-grid' }, field(t('font.family'), family), field(t('font.style'), style), field(t('font.size'), size)),
    h('div', { class: 'np-font-field' }, h('span', { class: 'np-font-label' }, t('font.preview')), preview),
  );
  return { el, value: () => ({ ...cur }), family, style, size };
}

export async function fontDialog(nw) {
  const { t, h } = nw;
  const fonts = await nw.shared.loadFonts();
  const ctl = fontControls(nw, nw.prefs.font, fonts);
  const v = await nw.dialog({
    title: t('font.title'),
    body: h('div', { class: 'np-font-dialog' }, ctl.el),
    className: 'np-dialog np-font-dlg',
    buttons: [
      { label: t('common.ok'), value: 'ok', primary: true },
      { label: t('common.cancel'), value: null },
    ],
    onOpen: () => setTimeout(() => ctl.family.focus(), 40),
  }, { w: 620, h: 500 });
  return v === 'ok' ? ctl.value() : null;
}
