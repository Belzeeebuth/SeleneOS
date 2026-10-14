// Polices: the preview window of a font file opened from Fichiers (ctx.args.file). Shows the face (sample text,
// alphabet, a few sizes, details) and « Installer pour moi », or « Déjà installée » when this font (same family,
// style and version) is already there. A collection (.ttc / .otc) has a face picker; WOFF / WOFF2 files are shown but
// cannot be installed. A file that is not a font (wrong magic bytes, broken table directory) gets an error page.
import { FontPool } from './pool.js';
import { baseName, sampleFor, glyphSample, reasonKey } from './data.js';
import { installFiles, dropTarget } from './install.js';
import { detailsCard } from './family.js';
import { managers } from './manager.js';

const SIZES = [14, 20, 28, 40];

export class Preview {
  constructor(ctx) {
    this.ctx = ctx;
    this.t = ctx.t;
    this.h = ctx.h;
    this.win = ctx.win;
    this.api = ctx.api;
    this.file = String(ctx.args.file || '');
    this.index = Number.isInteger(ctx.args.index) ? ctx.args.index : 0;
    this.pool = new FontPool(ctx.api, { idle: 4 });
    this.d = null;
    this.error = null;
    this.alias = null;
    this.sample = '';
    this.theme = 'auto';
    this.els = {};
  }

  async init() {
    const { win } = this.ctx;
    win.body.classList.add('fv-root');
    win.setSize?.(800, 660);
    win.center?.();
    const prefs = (await this.ctx.storage.get('prefs', {}).catch(() => ({}))) || {};
    if (typeof prefs.sample === 'string') this.sample = prefs.sample.slice(0, 500);
    if (['auto', 'light', 'dark'].includes(prefs.theme)) this.theme = prefs.theme;
    win.on('close', () => this.dispose());
    this.offChanged = this.api.on('fonts:changed', () => this.refreshState());
    this.ctx.onLangChange(() => this.render());
    await this.load();
  }

  dispose() {
    this.pool.dispose();
    if (typeof this.offChanged === 'function') this.offChanged();
  }

  async load() {
    this.error = null;
    try {
      this.d = await this.api.invoke('fonts:details', this.file, this.index);
    } catch (err) {
      this.d = null;
      this.error = err?.code || 'ENOTFONT';
    }
    if (this.win.closed) return;
    this.alias = null;
    if (this.d) {
      if (this._key) this.pool.release(...this._key);
      this._key = [this.file, this.index];
      this.alias = await this.pool.acquire(this.file, this.index);
      if (!this.alias && !this.error) this.error = 'ENOTFONT';
      if (!this.alias) this.d = null;
    }
    if (this.d && !this.d.langs) {
      const ranges = await this.api.invoke('fonts:charmap', this.file, this.index).catch(() => []);
      this.ranges = ranges;
    }
    if (this.win.closed) return;
    this.render();
  }

  async refreshState() {
    if (!this.d) return;
    const d = await this.api.invoke('fonts:details', this.file, this.index).catch(() => null);
    if (!d || this.win.closed) return;
    this.d.installed = d.installed;
    this.d.installedUser = d.installedUser;
    this.renderFoot();
  }

  busy(on) {
    if (this.els.install) this.els.install.disabled = !!on || this.els.install.dataset.done === '1';
  }

  toast(text, kind = 'info') {
    const el = this.els.toast;
    if (!el) return;
    el.textContent = text;
    el.dataset.kind = kind;
    el.hidden = false;
    clearTimeout(this._toastT);
    this._toastT = setTimeout(() => {
      el.hidden = true;
    }, 4200);
  }

  /** Latin pangram, or the face's own first characters for a symbol font. */
  sampleText() {
    const text = this.sample || this.t('sample');
    const cov = this.ranges;
    if (!this.sample && cov) {
      const latin = cov.some(([a, z]) => a <= 0x61 && z >= 0x7a);
      if (!latin) return glyphSample(cov, 24) || text;
    }
    return sampleFor(null, text, true);
  }

  // ------------------------------------------------------------------ DOM
  render() {
    const { h, t } = this;
    const { icon } = this.ctx;
    this.els.root?.remove();
    this.els = {};
    const toast = h('div', { class: 'fv-toast', role: 'status', 'aria-live': 'polite', hidden: true });
    const drop = h('div', { class: 'fv-drop', hidden: true }, h('div', { class: 'fv-drop-card' }, icon('download-simple'), h('span', null, t('install.dropHint'))));
    const name = baseName(this.file);
    if (!this.d) {
      this.win.setTitle(`${name} – ${t('title')}`);
      const key = this.error === 'ETOOBIG' ? 'preview.tooBig' : this.error === 'ENOENT' ? 'preview.missing' : 'preview.notFont';
      const body = h(
        'div',
        { class: 'empty fv-pv-error' },
        icon('warning-circle'),
        h('div', { class: 'fv-empty-title' }, t('preview.notFontTitle')),
        h('div', { class: 'fv-empty-hint' }, t(key, { name })),
      );
      const foot = h('footer', { class: 'fv-pv-foot' }, h('div', { class: 'fv-pv-state' }), h('button', { class: 'btn', onclick: () => this.win.close() }, t('close')));
      const root = h('div', { class: 'fv-app fv-preview error' }, body, foot, drop, toast);
      Object.assign(this.els, { root, toast, drop });
      this.win.body.appendChild(root);
      dropTarget(this, root, drop);
      return;
    }
    const d = this.d;
    this.win.setTitle(`${d.fullName || d.family || name} – ${t('title')}`);
    const fmt = t(`format.${d.format}`) || d.format;
    const fmtText = d.container === 'collection' ? t('format.collection', { format: fmt, count: d.faces }) : d.container === 'woff' || d.container === 'woff2' ? t(`format.${d.container}`, { format: fmt }) : fmt;
    const sub = [d.style, fmtText, d.version ? `${t('details.version')} ${d.version}` : null].filter(Boolean).join(' · ');
    const tools = h('div', { class: 'fv-pv-tools' });
    if (d.faceList?.length > 1) {
      const sel = this.ctx.ui.select({
        options: d.faceList.map((f) => ({ value: f.index, label: [f.family, f.style].filter(Boolean).join(' ') || `#${f.index + 1}` })),
        value: d.face,
        onchange: (v) => {
          this.index = Number(v) || 0;
          this.load();
        },
      });
      sel.setAttribute('aria-label', t('preview.face'));
      sel.classList.add('fv-face-select');
      tools.appendChild(sel);
    }
    const sampleInput = h('input', {
      class: 'input fv-sample',
      type: 'text',
      maxlength: 500,
      value: this.sample,
      placeholder: t('sample'),
      'aria-label': t('sampleLabel'),
      'data-prose': '',
      oninput: () => {
        this.sample = sampleInput.value;
        this.fillTexts();
      },
    });
    const theme = this.ctx.ui.segmented({
      options: [
        { value: 'auto', icon: 'circle-half', tip: t('themeAuto') },
        { value: 'light', icon: 'sun', tip: t('themeLight') },
        { value: 'dark', icon: 'moon', tip: t('themeDark') },
      ],
      value: this.theme,
      onchange: (v) => {
        this.theme = v;
        this.applyTheme();
      },
    });
    theme.classList.add('fv-theme');
    theme.setAttribute('role', 'group');
    theme.setAttribute('aria-label', t('previewTheme'));
    const labels = [t('themeAuto'), t('themeLight'), t('themeDark')];
    const syncTheme = () =>
      [...theme.querySelectorAll('button')].forEach((b, i) => {
        b.setAttribute('aria-label', labels[i]);
        b.setAttribute('aria-pressed', b.classList.contains('selected') ? 'true' : 'false');
      });
    syncTheme();
    new MutationObserver(syncTheme).observe(theme, { childList: true });
    tools.append(h('div', { class: 'fv-sample-box' }, sampleInput), theme);

    const big = h('div', { class: 'fv-text fv-pv-big' });
    const alpha = h(
      'div',
      { class: 'fv-pv-alpha' },
      ['ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz', '0123456789 « » – — … ’ € &', 'àâæçéèêëîïôœùûüÿ ÀÂÆÇÉÈÊËÎÏÔŒÙÛÜŸ'].map((l) => h('div', { class: 'fv-pv-line' }, l)),
    );
    const wf = h('div', { class: 'fv-waterfall fv-pv-wf' });
    for (const px of SIZES) {
      wf.appendChild(h('div', { class: 'fv-wf-row' }, h('span', { class: 'fv-wf-size' }, t('sizeValue', { size: px })), h('div', { class: 'fv-text fv-wf-sample', style: { fontSize: `${px}px` } })));
    }
    const details = detailsCard(this, d);
    const body = h('div', { class: 'fv-pv-body' }, big, alpha, wf, details);
    const head = h(
      'header',
      { class: 'fv-pv-head' },
      h('h1', { class: 'fv-pv-name' }, d.family || name),
      h('div', { class: 'fv-pv-sub' }, sub),
    );
    const foot = h('footer', { class: 'fv-pv-foot' });
    const root = h('div', { class: 'fv-app fv-preview' }, head, tools, body, foot, drop, toast);
    Object.assign(this.els, { root, body, big, alpha, wf, foot, toast, drop, sampleInput, theme });
    this.win.body.appendChild(root);
    for (const el of [big, ...alpha.children, ...wf.querySelectorAll('.fv-wf-sample')]) {
      el.style.fontFamily = `"${this.alias}"`;
      el.style.fontSynthesis = 'none';
    }
    this.fillTexts();
    this.applyTheme();
    this.renderFoot();
    dropTarget(this, root, drop);
  }

  fillTexts() {
    const text = this.sampleText();
    if (this.els.big) this.els.big.textContent = text;
    for (const el of this.els.wf?.querySelectorAll('.fv-wf-sample') || []) el.textContent = text;
  }

  applyTheme() {
    const el = this.els.body;
    if (!el) return;
    if (this.theme === 'auto') {
      el.removeAttribute('data-theme-scope');
      el.removeAttribute('data-theme');
    } else {
      el.setAttribute('data-theme-scope', '');
      el.setAttribute('data-theme', this.theme);
    }
  }

  renderFoot() {
    const { h, t, d } = this;
    const { icon } = this.ctx;
    const foot = this.els.foot;
    if (!foot || !d) return;
    foot.textContent = '';
    const state = h('div', { class: 'fv-pv-state' });
    const buttons = h('div', { class: 'fv-pv-buttons' });
    const showInApp = h('button', { class: 'btn fv-open-app', onclick: () => this.showInApp() }, t('preview.openInApp'));
    this.els.install = null;
    if (!d.installable) {
      state.append(icon('info'), h('span', null, t('preview.webOnly')));
    } else if (d.installed === 'same') {
      state.append(icon('check-circle'), h('span', null, t('preview.installedHint')));
      const b = h('button', { class: 'btn primary fv-install-one', disabled: true, dataset: { done: '1' } }, icon('check'), h('span', null, this.justInstalled ? t('preview.installedUser') : t('preview.installed')));
      this.els.install = b;
      buttons.append(showInApp, b);
    } else {
      state.append(icon('info'), h('span', null, d.installed === 'other-version' ? (d.installedUser ? t('preview.otherVersion') : t('preview.systemCopy')) : t('install.forMeHint')));
      const b = h('button', { class: 'btn primary fv-install-one', onclick: () => this.install() }, icon('download-simple'), h('span', null, t('install.forMe')));
      this.els.install = b;
      buttons.append(b);
    }
    foot.append(state, buttons);
    state.classList.toggle('ok', d.installed === 'same');
  }

  async install() {
    const res = await installFiles(this, [this.file], { confirm: false });
    if (!res || this.win.closed) return;
    const r = res[0];
    if (r && (r.status === 'installed' || r.status === 'replaced' || r.status === 'already')) {
      this.justInstalled = r.status !== 'already';
      this.d.installed = 'same';
      this.d.installedUser = true;
      this.renderFoot();
      this.els.foot.querySelector('.fv-open-app')?.focus();
    } else if (r?.status === 'error') {
      const k = reasonKey(r.code);
      this.toast(this.t('install.failed', { name: baseName(this.file), reason: k ? this.t(k) : r.message || '' }), 'error');
    }
  }

  async showInApp() {
    const fam = this.d?.family;
    const open = [...managers].find((m) => !m.win.closed);
    if (open) {
      open.win.focus();
      if (!open.families.some((f) => f.name === fam)) await open.reload();
      if (fam) open.openFamily(fam);
      return;
    }
    await this.ctx.shell.launch('fonts', fam ? { family: fam } : {});
  }
}
