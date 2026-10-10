// Paint dialogs: Edit colours (HSV picker), Resize and skew, Image properties, About.
import { hexToRgb, hsvToRgb, rgbToHex, rgbToHsv, parseColor, clamp } from './lib/color.js';

export const MAX_DIM = 16000;
export const MAX_AREA = 50_000_000;

const num = (v) => {
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : NaN;
};

// ---------------------------------------------------------------- Edit colors
export function editColorsDialog(app, initial) {
  const { h, ui } = app.ctx;
  const t = app.ctx.t;
  const rgb0 = hexToRgb(initial) || [0, 0, 0];
  let [H, S, V] = rgbToHsv(...rgb0);
  let current = rgbToHex(...rgb0);

  const svThumb = h('div', { class: 'pt-sv-thumb' });
  const sv = h('div', { class: 'pt-sv', tabindex: '0', role: 'slider', 'aria-label': t('colors.satval') }, svThumb);
  const hueThumb = h('div', { class: 'pt-hue-thumb' });
  const hue = h('div', { class: 'pt-hue', tabindex: '0', role: 'slider', 'aria-label': t('colors.hue'), 'aria-valuemin': '0', 'aria-valuemax': '360' }, hueThumb);
  const prevNew = h('div', { class: 'pt-prev-new' });
  const prevOld = h('div', { class: 'pt-prev-old', style: { background: initial }, 'data-tip': t('colors.current') });
  const hex = h('input', { class: 'input pt-hex', value: current.toUpperCase(), maxlength: 7, 'aria-label': t('colors.hex'), spellcheck: false });
  const mk = (label, max) => h('input', { class: 'input pt-num', type: 'number', min: 0, max, 'aria-label': label });
  const rI = mk(t('colors.red'), 255);
  const gI = mk(t('colors.green'), 255);
  const bI = mk(t('colors.blue'), 255);
  const hI = mk(t('colors.hue'), 359);
  const sI = mk(t('colors.sat'), 100);
  const vI = mk(t('colors.val'), 100);

  function render(from) {
    const rgb = hsvToRgb(H, S, V);
    current = rgbToHex(...rgb);
    sv.style.setProperty('--hue', `hsl(${H.toFixed(1)} 100% 50%)`);
    svThumb.style.left = `${S * 100}%`;
    svThumb.style.top = `${(1 - V) * 100}%`;
    svThumb.style.background = current;
    hueThumb.style.left = `${(H / 360) * 100}%`;
    hueThumb.style.background = `hsl(${H.toFixed(1)} 100% 50%)`;
    prevNew.style.background = current;
    sv.setAttribute('aria-valuetext', `${Math.round(S * 100)}%, ${Math.round(V * 100)}%`);
    hue.setAttribute('aria-valuenow', String(Math.round(H)));
    if (from !== 'hex') hex.value = current.toUpperCase();
    if (from !== 'rgb') [rI.value, gI.value, bI.value] = rgb;
    if (from !== 'hsv') [hI.value, sI.value, vI.value] = [Math.round(H) % 360, Math.round(S * 100), Math.round(V * 100)];
  }

  const drag = (el, fn) => {
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      el.setPointerCapture(e.pointerId);
      el.focus();
      const move = (ev) => {
        const r = el.getBoundingClientRect();
        fn(clamp((ev.clientX - r.left) / r.width, 0, 1), clamp((ev.clientY - r.top) / r.height, 0, 1));
        render();
      };
      move(e);
      const up = () => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    });
  };
  drag(sv, (x, y) => {
    S = x;
    V = 1 - y;
  });
  drag(hue, (x) => {
    H = Math.min(359.9, x * 360);
  });
  sv.addEventListener('keydown', (e) => {
    const d = e.shiftKey ? 0.1 : 0.01;
    const m = { ArrowLeft: [-d, 0], ArrowRight: [d, 0], ArrowUp: [0, d], ArrowDown: [0, -d] }[e.key];
    if (!m) return;
    e.preventDefault();
    S = clamp(S + m[0], 0, 1);
    V = clamp(V + m[1], 0, 1);
    render();
  });
  hue.addEventListener('keydown', (e) => {
    const d = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 }[e.key];
    if (!d) return;
    e.preventDefault();
    H = (H + d * (e.shiftKey ? 10 : 1) + 360) % 360;
    render();
  });
  hex.addEventListener('input', () => {
    const c = parseColor(hex.value.startsWith('#') ? hex.value : `#${hex.value}`);
    if (!c || hex.value.replace('#', '').length < 6) return;
    const [r, g, b] = hexToRgb(c);
    const [hh, ss, vv] = rgbToHsv(r, g, b);
    if (ss > 0) H = hh;
    S = ss;
    V = vv;
    render('hex');
  });
  const onRgb = () => {
    const v = [rI, gI, bI].map((i) => clamp(Math.round(num(i.value) || 0), 0, 255));
    const [hh, ss, vv] = rgbToHsv(...v);
    if (ss > 0) H = hh;
    S = ss;
    V = vv;
    render('rgb');
  };
  const onHsv = () => {
    H = clamp(num(hI.value) || 0, 0, 359.9);
    S = clamp((num(sI.value) || 0) / 100, 0, 1);
    V = clamp((num(vI.value) || 0) / 100, 0, 1);
    render('hsv');
  };
  for (const i of [rI, gI, bI]) i.addEventListener('input', onRgb);
  for (const i of [hI, sI, vI]) i.addEventListener('input', onHsv);
  const field = (label, input) => h('label', { class: 'pt-cfield' }, h('span', { class: 'caption text-2' }, label), input);
  const body = h(
    'div',
    { class: 'pt-colors-dlg' },
    h('div', { class: 'pt-colors-main' }, sv, hue),
    h(
      'div',
      { class: 'pt-colors-side' },
      h('div', { class: 'pt-prev' }, prevNew, prevOld),
      field(t('colors.hex'), hex),
      h('div', { class: 'pt-cfields' }, field(t('colors.red'), rI), field(t('colors.green'), gI), field(t('colors.blue'), bI)),
      h('div', { class: 'pt-cfields' }, field(t('colors.hueShort'), hI), field(t('colors.satShort'), sI), field(t('colors.valShort'), vI)),
    ),
  );
  render();
  return ui
    .dialog({
      title: t('colors.editTitle'),
      body,
      parent: app.win,
      className: 'pt-dlg',
      buttons: [
        { label: t('common.ok'), value: 'ok', primary: true },
        { label: t('common.cancel'), value: null },
      ],
    })
    .then((v) => (v === 'ok' ? current : null));
}

// ---------------------------------------------------------------- Resize and skew
export function resizeDialog(app, { w, h: hgt, selection }) {
  const { h, ui } = app.ctx;
  const t = app.ctx.t;
  let mode = 'percent';
  let keep = true;
  const hz = h('input', { class: 'input pt-num wide', type: 'number', min: 1, value: 100, 'aria-label': t('resize.horizontal') });
  const vt = h('input', { class: 'input pt-num wide', type: 'number', min: 1, value: 100, 'aria-label': t('resize.vertical') });
  const skH = h('input', { class: 'input pt-num wide', type: 'number', min: -89, max: 89, value: 0, 'aria-label': t('resize.skewH') });
  const skV = h('input', { class: 'input pt-num wide', type: 'number', min: -89, max: 89, value: 0, 'aria-label': t('resize.skewV') });
  const err = h('div', { class: 'pt-err', role: 'alert' });
  const out = h('div', { class: 'caption text-2 pt-result' });
  const keepBox = h('input', { type: 'checkbox', checked: true, onchange: (e) => (keep = e.target.checked) });
  const seg = ui.segmented({
    options: [
      { value: 'percent', label: t('resize.percent') },
      { value: 'pixels', label: t('resize.pixels') },
    ],
    value: mode,
    onchange: (m) => {
      const [nw, nh] = result();
      mode = m;
      if (m === 'pixels') {
        hz.value = Number.isFinite(nw) ? nw : w;
        vt.value = Number.isFinite(nh) ? nh : hgt;
      } else {
        hz.value = Number.isFinite(nw) ? Math.round((nw / w) * 1000) / 10 : 100;
        vt.value = Number.isFinite(nh) ? Math.round((nh / hgt) * 1000) / 10 : 100;
      }
      update();
    },
  });
  function result() {
    const a = num(hz.value);
    const b = num(vt.value);
    if (mode === 'percent') return [Math.round((w * a) / 100), Math.round((hgt * b) / 100)];
    return [Math.round(a), Math.round(b)];
  }
  function update() {
    const [nw, nh] = result();
    out.textContent = Number.isFinite(nw) && Number.isFinite(nh) ? t('resize.result', { w: nw, h: nh }) : '';
    err.textContent = '';
  }
  hz.addEventListener('input', () => {
    if (keep) vt.value = mode === 'percent' ? hz.value : Math.max(1, Math.round((num(hz.value) * hgt) / w));
    update();
  });
  vt.addEventListener('input', () => {
    if (keep) hz.value = mode === 'percent' ? vt.value : Math.max(1, Math.round((num(vt.value) * w) / hgt));
    update();
  });
  for (const i of [skH, skV]) i.addEventListener('input', () => (err.textContent = ''));
  const row = (ic, label, input, unit) =>
    h('label', { class: 'pt-frow' }, app.ctx.icon(ic, { size: 20 }), h('span', { class: 'pt-flabel' }, label), input, h('span', { class: 'caption text-2 pt-unit' }, unit || ''));
  const body = h(
    'div',
    { class: 'pt-resize-dlg' },
    selection ? h('div', { class: 'caption text-2' }, t('resize.selectionNote')) : null,
    h('div', { class: 'pt-sect' }, t('resize.resize')),
    seg,
    row('arrow_autofit_width', t('resize.horizontal'), hz),
    row('arrow_autofit_height', t('resize.vertical'), vt),
    h('label', { class: 'checkbox' }, keepBox, t('resize.keep')),
    out,
    h('div', { class: 'pt-sect' }, t('resize.skew')),
    row('select_object_skew', t('resize.skewH'), skH, '°'),
    row('select_object_skew', t('resize.skewV'), skV, '°'),
    err,
  );
  update();
  let value = null;
  return ui
    .dialog({
      title: t('resize.title'),
      body,
      parent: app.win,
      className: 'pt-dlg',
      buttons: [
        { label: t('common.ok'), value: 'ok', primary: true },
        { label: t('common.cancel'), value: null },
      ],
      onOpen: (dlg) => {
        dlg._validate = () => {
          const [nw, nh] = result();
          const sh = num(skH.value);
          const sv2 = num(skV.value);
          if (!(nw >= 1 && nh >= 1)) err.textContent = t('resize.errPositive');
          else if (nw > MAX_DIM || nh > MAX_DIM || nw * nh > MAX_AREA) err.textContent = t('resize.errTooBig', { max: MAX_DIM });
          else if (!(Math.abs(sh) <= 89 && Math.abs(sv2) <= 89)) err.textContent = t('resize.errSkew');
          else {
            value = { w: nw, h: nh, skewH: sh || 0, skewV: sv2 || 0 };
            return true;
          }
          return false;
        };
        setTimeout(() => hz.select(), 60);
      },
    })
    .then((v) => (v === 'ok' ? value : null));
}

// ---------------------------------------------------------------- Image properties
const UNIT = { px: 1, in: 96, cm: 96 / 2.54 };

export function propertiesDialog(app, { w, h: hgt, file, defaults }) {
  const { h, ui, i18n } = app.ctx;
  const t = app.ctx.t;
  let unit = 'px';
  let anchor = 'tl';
  let pxW = w;
  let pxH = hgt;
  const wI = h('input', { class: 'input pt-num wide', type: 'number', min: 0.01, step: 'any', 'aria-label': t('props.width') });
  const hI = h('input', { class: 'input pt-num wide', type: 'number', min: 0.01, step: 'any', 'aria-label': t('props.height') });
  const err = h('div', { class: 'pt-err', role: 'alert' });
  const fmt = (px) => (unit === 'px' ? String(Math.round(px)) : String(Math.round((px / UNIT[unit]) * 100) / 100));
  const show = () => {
    wI.value = fmt(pxW);
    hI.value = fmt(pxH);
    wI.step = unit === 'px' ? '1' : '0.01';
    hI.step = wI.step;
  };
  const read = () => {
    pxW = Math.round(num(wI.value) * UNIT[unit]);
    pxH = Math.round(num(hI.value) * UNIT[unit]);
  };
  wI.addEventListener('input', () => ((err.textContent = ''), read()));
  hI.addEventListener('input', () => ((err.textContent = ''), read()));
  const seg = ui.segmented({
    options: [
      { value: 'in', label: t('props.inches') },
      { value: 'cm', label: t('props.cm') },
      { value: 'px', label: t('props.pixels') },
    ],
    value: unit,
    onchange: (u) => {
      read();
      unit = u;
      show();
    },
  });
  const anchors = ['tl', 't', 'tr', 'l', 'c', 'r', 'bl', 'b', 'br'];
  const grid = h('div', { class: 'pt-anchor', role: 'radiogroup', 'aria-label': t('props.anchor') });
  const drawAnchor = () => {
    for (const b of grid.children) {
      const on = b.dataset.a === anchor;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
    }
  };
  for (const a of anchors) {
    grid.appendChild(
      h('button', {
        type: 'button',
        role: 'radio',
        'data-tip': t(`props.anchor_${a}`),
        'aria-label': t(`props.anchor_${a}`),
        dataset: { a },
        onclick: () => {
          anchor = a;
          drawAnchor();
        },
      }),
    );
  }
  drawAnchor();
  const info = (label, value) => h('div', { class: 'pt-info' }, h('span', { class: 'text-2' }, label), h('span', { class: 'selectable' }, value));
  const body = h(
    'div',
    { class: 'pt-props-dlg' },
    h('div', { class: 'pt-sect' }, t('props.attributes')),
    info(t('props.lastSaved'), file?.mtime ? i18n.formatDate(file.mtime, { dateStyle: 'medium', timeStyle: 'short' }) : t('props.na')),
    info(t('props.sizeOnDisk'), file?.size != null ? i18n.formatSize(file.size) : t('props.na')),
    info(t('props.resolution'), t('props.dpi', { dpi: 96 })),
    h('div', { class: 'pt-sect' }, t('props.units')),
    seg,
    h(
      'div',
      { class: 'pt-props-grid' },
      h(
        'div',
        { class: 'pt-props-fields' },
        h('label', { class: 'pt-frow' }, h('span', { class: 'pt-flabel' }, t('props.width')), wI),
        h('label', { class: 'pt-frow' }, h('span', { class: 'pt-flabel' }, t('props.height')), hI),
        h(
          'button',
          {
            type: 'button',
            class: 'btn',
            onclick: () => {
              pxW = defaults.w;
              pxH = defaults.h;
              show();
            },
          },
          t('props.defaults'),
        ),
      ),
      h('div', { class: 'pt-anchor-wrap' }, h('div', { class: 'caption text-2' }, t('props.anchor')), grid),
    ),
    err,
  );
  show();
  let value = null;
  return ui
    .dialog({
      title: t('props.title'),
      body,
      parent: app.win,
      className: 'pt-dlg',
      buttons: [
        { label: t('common.ok'), value: 'ok', primary: true },
        { label: t('common.cancel'), value: null },
      ],
      onOpen: (dlg) => {
        dlg._validate = () => {
          read();
          if (!(pxW >= 1 && pxH >= 1)) err.textContent = t('resize.errPositive');
          else if (pxW > MAX_DIM || pxH > MAX_DIM || pxW * pxH > MAX_AREA) err.textContent = t('resize.errTooBig', { max: MAX_DIM });
          else {
            value = { w: pxW, h: pxH, anchor };
            return true;
          }
          return false;
        };
        setTimeout(() => wI.select(), 60);
      },
    })
    .then((v) => (v === 'ok' ? value : null));
}

// ---------------------------------------------------------------- About
export function aboutDialog(app) {
  const { h, ui } = app.ctx;
  const t = app.ctx.t;
  return ui.dialog({
    parent: app.win,
    className: 'pt-dlg',
    body: h(
      'div',
      { class: 'pt-about' },
      h('img', { src: app.ctx.appUrl('icon.svg'), width: 64, height: 64, alt: '' }),
      h('div', null, h('div', { class: 'subtitle' }, 'Paint'), h('div', { class: 'text-2' }, t('about.version', { v: app.ctx.env?.version || '1.0' })), h('div', { class: 'caption text-2 pt-about-desc' }, t('about.desc'))),
    ),
    buttons: [{ label: t('common.ok'), value: true, primary: true }],
  });
}
