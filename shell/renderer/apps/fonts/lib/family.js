// Polices: the page of one family, inside the main window. Tabs:
//   Styles      every style drawn in its own face with the sample text, at the toolbar size
//   Sizes       a waterfall of the chosen style (10 … 96 px)
//   Characters  the common groups the face covers (Latin, accents for French, punctuation « » – — …, figures,
//               symbols, Greek, Cyrillic, others); clicking a character copies it (roving focus, arrows, Enter)
//   Details     files, format, version, designer, foundry, licence (with its text), scripts, axes…
// « Désinstaller » for families with fonts installed by the user (their files only; system fonts stay).
import { WATERFALL, sampleFor, charGroups, codeOf, glyphSample, regularStyle, dirName } from './data.js';

const TABS = ['styles', 'sizes', 'chars', 'details'];
let seq = 0;

export class FamilyView {
  constructor(m, fam, { tab } = {}) {
    this.m = m;
    this.ctx = m.ctx;
    this.t = m.t;
    this.h = m.h;
    this.fam = fam;
    this.tab = TABS.includes(tab) ? tab : 'styles';
    this.aliases = new Map(); // pool key -> Promise<alias | null>
    this.held = new Map(); // pool key -> style (released on dispose)
    this.style = regularStyle(fam);
    this.id = `fvf${++seq}`;
    this.disposed = false;
    this.els = {};
  }

  // ------------------------------------------------------------------ faces
  face(s) {
    const pool = this.m.pool;
    const k = pool.key(s.file, s.index);
    if (!this.aliases.has(k)) {
      this.held.set(k, s);
      this.aliases.set(k, pool.acquire(s.file, s.index));
    }
    return this.aliases.get(k);
  }
  async useFace(el, s, fallbackText) {
    const alias = await this.face(s);
    if (this.disposed || !el.isConnected) return;
    if (!alias) {
      el.classList.add('failed');
      el.textContent = fallbackText ?? this.t('unavailable');
      return;
    }
    el.style.fontFamily = `"${alias}"`;
    el.style.fontVariationSettings = s.variation || 'normal';
    el.classList.add('ready');
  }

  dispose() {
    this.disposed = true;
    for (const s of this.held.values()) this.m.pool.release(s.file, s.index);
    this.held.clear();
    this.aliases.clear();
  }

  // ------------------------------------------------------------------ frame
  render() {
    const { h, t, fam } = this;
    const { icon } = this.ctx;
    const actions = h('div', { class: 'fv-fam-actions' });
    if (fam.user) {
      actions.appendChild(
        h('button', { class: 'btn fv-uninstall', onclick: () => this.uninstall() }, icon('trash-simple'), h('span', null, t('uninstall.button'))),
      );
    }
    const sub = h('div', { class: 'fv-fam-sub' });
    const note = h('div', { class: 'fv-fam-note' });
    const head = h(
      'header',
      { class: 'fv-fam-head' },
      h('div', { class: 'fv-fam-titles' }, h('h2', { class: 'fv-fam-name', id: `${this.id}-name` }, fam.name), sub, note),
      actions,
    );
    const tabs = h('div', { class: 'tabs fv-tabs', role: 'tablist', 'aria-label': t('tabs.label'), onkeydown: (e) => this.tabKeys(e) });
    for (const id of TABS) {
      tabs.appendChild(
        h(
          'button',
          {
            class: ['tab', 'fv-tab', id === this.tab && 'selected'],
            role: 'tab',
            id: `${this.id}-tab-${id}`,
            'aria-selected': id === this.tab ? 'true' : 'false',
            'aria-controls': `${this.id}-panel`,
            tabindex: id === this.tab ? '0' : '-1',
            dataset: { tab: id },
            onclick: () => this.setTab(id),
          },
          t(`tabs.${id}`),
        ),
      );
    }
    const panel = h('div', { class: 'fv-panel', role: 'tabpanel', id: `${this.id}-panel`, 'aria-labelledby': `${this.id}-tab-${this.tab}`, tabindex: '-1' });
    const root = h('section', { class: 'fv-family', 'aria-labelledby': `${this.id}-name` }, head, tabs, panel);
    Object.assign(this.els, { root, head, sub, note, actions, tabs, panel });
    this.renderHead();
    this.renderPanel();
    return root;
  }

  renderHead() {
    const { t, fam, h } = this;
    const sub = this.els.sub;
    sub.textContent = '';
    const parts = [t(`category.${fam.category}`) || fam.category, t('styles', { count: fam.styles.length })];
    sub.append(parts.join(' · '));
    if (fam.user) sub.append(' ', h('span', { class: 'fv-badge user' }, t('userBadge')));
    if (fam.system) sub.append(' ', h('span', { class: 'fv-badge' }, t('systemBadge')));
    if (fam.variable) sub.append(' ', h('span', { class: 'fv-badge' }, t('variableBadge')));
    this.els.note.textContent = fam.user ? (fam.system ? t('uninstall.partial') : '') : t('uninstall.systemNote');
    this.els.note.hidden = !this.els.note.textContent;
  }

  focus() {
    this.els.tabs?.querySelector('.tab.selected')?.focus({ preventScroll: true });
  }

  setFamily(fam) {
    this.fam = fam;
    if (!fam.styles.some((s) => s.file === this.style?.file && s.index === this.style?.index)) this.style = regularStyle(fam);
    this.details = null;
    const actions = this.els.actions;
    if (actions && !fam.user) actions.textContent = '';
    this.renderHead();
    this.renderPanel();
  }

  setTab(id, { focus = false } = {}) {
    if (!TABS.includes(id)) return;
    this.tab = id;
    for (const b of this.els.tabs.querySelectorAll('.tab')) {
      const on = b.dataset.tab === id;
      b.classList.toggle('selected', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
      if (on && focus) b.focus();
    }
    this.els.panel.setAttribute('aria-labelledby', `${this.id}-tab-${id}`);
    this.renderPanel();
  }

  tabKeys(e) {
    const i = TABS.indexOf(this.tab);
    let n = null;
    if (e.key === 'ArrowRight') n = (i + 1) % TABS.length;
    else if (e.key === 'ArrowLeft') n = (i + TABS.length - 1) % TABS.length;
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = TABS.length - 1;
    if (n == null) return;
    e.preventDefault();
    this.setTab(TABS[n], { focus: true });
  }

  /** Sample text or size changed in the toolbar. */
  update() {
    if (this.tab === 'styles' || this.tab === 'sizes') {
      for (const el of this.els.panel.querySelectorAll('.fv-text:not(.failed)')) el.textContent = this.sampleOf(el._style);
    }
  }

  sampleOf(s) {
    const text = sampleFor(this.fam, this.m.sampleText, this.m.customSample);
    if (text != null) return text;
    return this._glyphs || '';
  }

  /** Symbol fonts show their own first characters: fetched once, then the texts are refilled. */
  async ensureGlyphs() {
    if (sampleFor(this.fam, this.m.sampleText, this.m.customSample) != null || this._glyphs != null) return;
    const st = regularStyle(this.fam);
    const ranges = await this.m.charmap(st.file, st.index).catch(() => []);
    this._glyphs = glyphSample(ranges, 32);
    if (!this.disposed) this.update();
  }

  styleSelect(onchange) {
    const { t, fam } = this;
    const sel = this.ctx.ui.select({
      options: fam.styles.map((s, i) => ({ value: i, label: s.style + (fam.styles.filter((x) => x.style === s.style).length > 1 ? ` (${s.file.split('/').pop()})` : '') })),
      value: Math.max(0, fam.styles.indexOf(this.style)),
      onchange: (v) => {
        this.style = fam.styles[Number(v)] || this.style;
        onchange();
      },
    });
    sel.classList.add('fv-style-select');
    sel.setAttribute('aria-label', t('styleLabel'));
    return this.h('label', { class: 'fv-style-pick' }, this.h('span', null, t('styleLabel')), sel);
  }

  renderPanel() {
    const panel = this.els.panel;
    panel.textContent = '';
    panel.scrollTop = 0;
    if (this.tab === 'styles') this.panelStyles(panel);
    else if (this.tab === 'sizes') this.panelSizes(panel);
    else if (this.tab === 'chars') this.panelChars(panel);
    else this.panelDetails(panel);
  }

  // ------------------------------------------------------------------ styles
  panelStyles(panel) {
    const { h, t, fam } = this;
    const list = h('div', { class: 'fv-styles' });
    for (const s of fam.styles) {
      const text = h('div', { class: 'fv-text fv-style-sample' }, this.sampleOf(s));
      text._style = s;
      list.appendChild(
        h(
          'div',
          { class: 'fv-style' },
          h(
            'div',
            { class: 'fv-style-head' },
            h('span', { class: 'fv-style-name' }, s.style),
            s.variable ? h('span', { class: 'fv-badge' }, t('variableBadge')) : null,
            s.user && fam.system ? h('span', { class: 'fv-badge user' }, t('userBadge')) : null,
          ),
          text,
        ),
      );
      this.useFace(text, s);
    }
    panel.appendChild(list);
    this.ensureGlyphs();
  }

  // ------------------------------------------------------------------ sizes (waterfall)
  panelSizes(panel) {
    const { h, t } = this;
    const rows = h('div', { class: 'fv-waterfall' });
    const fill = () => {
      rows.textContent = '';
      const s = this.style;
      for (const px of WATERFALL) {
        const text = h('div', { class: 'fv-text fv-wf-sample', style: { fontSize: `${px}px` } }, this.sampleOf(s));
        text._style = s;
        rows.appendChild(h('div', { class: 'fv-wf-row' }, h('span', { class: 'fv-wf-size' }, t('sizeValue', { size: px })), text));
        this.useFace(text, s);
      }
    };
    panel.append(h('div', { class: 'fv-panel-bar' }, this.styleSelect(fill)), rows);
    fill();
    this.ensureGlyphs();
  }

  // ------------------------------------------------------------------ characters
  panelChars(panel) {
    const { h, t } = this;
    const body = h('div', { class: 'fv-chars' });
    const status = h('div', { class: 'fv-chars-status', role: 'status', 'aria-live': 'polite' }, t('chars.hint'));
    this.els.charStatus = status;
    const fill = async () => {
      const s = this.style;
      body.textContent = '';
      body.setAttribute('aria-busy', 'true');
      const ranges = await this.m.charmap(s.file, s.index).catch(() => []);
      if (this.disposed || this.style !== s || !body.isConnected) return;
      body.removeAttribute('aria-busy');
      const groups = charGroups(ranges);
      if (!groups.length) {
        body.appendChild(h('div', { class: 'fv-chars-none' }, t('chars.none')));
        return;
      }
      let first = true;
      for (const g of groups) {
        const grid = h('div', { class: 'fv-glyphs', role: 'group', 'aria-label': t(`chars.block.${g.id}`) });
        for (const c of g.chars) {
          const ch = String.fromCodePoint(c);
          const cell = h('button', {
            class: 'fv-glyph fv-face',
            tabindex: first ? '0' : '-1',
            'aria-label': `${ch} ${codeOf(c)}`,
            'data-tip': codeOf(c),
            dataset: { cp: String(c) },
            onclick: () => this.copyChar(c, cell),
            onfocus: () => this.roveGlyph(cell),
          }, ch);
          first = false;
          grid.appendChild(cell);
        }
        body.appendChild(
          h(
            'section',
            { class: 'fv-block', dataset: { block: g.id } },
            h('h3', { class: 'fv-block-title' }, t(`chars.block.${g.id}`), h('span', { class: 'fv-block-count' }, g.id === 'other' ? String(g.chars.length) : t('chars.count', { shown: g.chars.length, total: g.total }))),
            grid,
          ),
        );
      }
      const alias = await this.face(s);
      if (this.disposed || !body.isConnected) return;
      for (const el of body.querySelectorAll('.fv-face')) {
        if (alias) {
          el.style.fontFamily = `"${alias}"`;
          el.style.fontVariationSettings = s.variation || 'normal';
        }
      }
      body.classList.toggle('failed', !alias);
    };
    body.addEventListener('keydown', (e) => this.glyphKeys(e));
    panel.append(h('div', { class: 'fv-panel-bar' }, this.styleSelect(fill), status), body);
    fill();
  }

  roveGlyph(cell) {
    const body = cell.closest('.fv-chars');
    for (const c of body.querySelectorAll('.fv-glyph[tabindex="0"]')) if (c !== cell) c.tabIndex = -1;
    cell.tabIndex = 0;
  }

  glyphKeys(e) {
    const cell = e.target.closest?.('.fv-glyph');
    if (!cell) return;
    const all = [...cell.closest('.fv-chars').querySelectorAll('.fv-glyph')];
    const i = all.indexOf(cell);
    const grid = cell.parentElement;
    const inRow = [...grid.children].filter((c) => c.offsetTop === grid.firstElementChild.offsetTop).length || 1;
    let n = null;
    if (e.key === 'ArrowRight') n = i + 1;
    else if (e.key === 'ArrowLeft') n = i - 1;
    else if (e.key === 'ArrowDown') n = i + inRow;
    else if (e.key === 'ArrowUp') n = i - inRow;
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = all.length - 1;
    if (n == null) return;
    e.preventDefault();
    const next = all[Math.max(0, Math.min(all.length - 1, n))];
    this.roveGlyph(next);
    next.focus();
  }

  async copyChar(c, cell) {
    const ch = String.fromCodePoint(c);
    try {
      await this.ctx.api.invoke('clipboard:writeText', ch);
    } catch {
      await navigator.clipboard?.writeText?.(ch).catch(() => {});
    }
    for (const x of this.els.panel.querySelectorAll('.fv-glyph.copied')) x.classList.remove('copied');
    cell.classList.add('copied');
    const msg = this.t('chars.copied', { char: ch, code: codeOf(c) });
    if (this.els.charStatus) this.els.charStatus.textContent = msg;
    this.m.toast(msg, 'success');
  }

  // ------------------------------------------------------------------ details
  async panelDetails(panel) {
    const { h, t, fam } = this;
    const s = regularStyle(fam);
    const wrap = h('div', { class: 'fv-details', 'aria-busy': 'true' });
    panel.appendChild(wrap);
    let d = this.details;
    if (!d) {
      d = await this.ctx.api.invoke('fonts:details', s.file, s.index & 0xffff).catch(() => null);
      this.details = d;
    }
    if (this.disposed || !wrap.isConnected) return;
    wrap.removeAttribute('aria-busy');
    if (!d) {
      wrap.appendChild(h('div', { class: 'fv-chars-none' }, t('unavailable')));
      return;
    }
    wrap.appendChild(detailsCard(this, d, { family: fam }));
  }

  async uninstall() {
    const done = await this.m.uninstall(this.fam);
    if (done && !this.m.families.some((f) => f.name === this.fam.name)) this.m.closeFamily();
  }
}

/** The details card (also used by the preview window). ctx-like owner: { ctx, t, h }. */
export function detailsCard(owner, d, { family = null } = {}) {
  const { h, t } = owner;
  const { icon, shell } = owner.ctx;
  const rows = [];
  const row = (label, value) => {
    if (value == null || value === '') return;
    rows.push(h('div', { class: 'card-row fv-drow' }, h('div', { class: 'fv-dlabel' }, label), h('div', { class: 'fv-dvalue selectable' }, value)));
  };
  const link = (url) => {
    if (!/^https?:\/\//i.test(url || '')) return url || null;
    return h('a', { href: '#', class: 'fv-link', onclick: (e) => (e.preventDefault(), shell.openUrl(url)) }, url);
  };
  const fmt = t(`format.${d.format}`) || d.format;
  let format = fmt;
  if (d.container === 'collection') format = t('format.collection', { format: fmt, count: d.faces });
  else if (d.container === 'woff' || d.container === 'woff2') format = t(`format.${d.container}`, { format: fmt });
  row(t('details.family'), d.family);
  row(t('details.style'), d.style);
  row(t('details.fullName'), d.fullName);
  row(t('details.version'), d.version);
  row(t('details.format'), format);
  if (family) row(t('details.category'), t(`category.${family.category}`));
  row(t('details.designer'), d.designerUrl ? h('span', null, d.designer || '', d.designer ? ' — ' : '', link(d.designerUrl)) : d.designer);
  row(t('details.manufacturer'), d.vendorUrl ? h('span', null, d.manufacturer || '', d.manufacturer ? ' — ' : '', link(d.vendorUrl)) : d.manufacturer);
  row(t('details.vendor'), d.vendorId);
  // licence: short name, link, the full text behind a toggle
  if (d.license || d.licenseUrl || d.licenseKind) {
    const name = d.licenseKind ? t(`license.${d.licenseKind.replace(/[^A-Za-z0-9]/g, '')}`) : t('license.other');
    const text = d.license ? h('pre', { class: 'fv-license-text selectable', hidden: true }, d.license) : null;
    const toggle = text
      ? h('button', {
          class: 'btn subtle fv-license-toggle',
          'aria-expanded': 'false',
          onclick: () => {
            text.hidden = !text.hidden;
            toggle.textContent = text.hidden ? t('details.licenseShow') : t('details.licenseHide');
            toggle.setAttribute('aria-expanded', text.hidden ? 'false' : 'true');
          },
        }, t('details.licenseShow'))
      : null;
    row(t('details.license'), h('div', { class: 'fv-license' }, h('div', null, name, d.licenseUrl ? ' — ' : '', d.licenseUrl ? link(d.licenseUrl) : null), toggle, text));
  }
  row(t('details.copyright'), d.copyright);
  row(t('details.trademark'), d.trademark);
  row(t('details.description'), d.description);
  if (family?.langs?.length) row(t('details.scripts'), family.langs.map((l) => t(`lang.${l}`)).join(', '));
  if (d.axes?.length) row(t('details.axes'), d.axes.filter((a) => !a.hidden).map((a) => `${a.name || a.tag} (${a.tag}) ${a.min}–${a.max}`).join(' · '));
  row(t('details.glyphs'), d.glyphs ? d.glyphs.toLocaleString(owner.ctx.lang === 'fr' ? 'fr-FR' : 'en-US') : null);
  if (d.embedding) row(t('details.embedding'), t(`embedding.${d.embedding}`));
  // files
  const files = family ? [...new Map(family.styles.map((s) => [s.file, s])).values()] : [{ file: d.file, user: d.user, style: d.style }];
  const fileList = h(
    'div',
    { class: 'fv-files' },
    files.map((s) =>
      h(
        'div',
        { class: 'fv-file' },
        h('span', { class: 'fv-file-path selectable', title: s.file }, s.file),
        h(
          'button',
          {
            class: 'btn subtle fv-file-show',
            'aria-label': `${t('details.showInFiles')}: ${s.file.split('/').pop()}`,
            'data-tip': t('details.showInFiles'),
            onclick: () => shell.launch('files', { path: dirName(s.file), select: s.file }),
          },
          icon('folder-open'),
        ),
      ),
    ),
  );
  row(files.length > 1 ? t('details.files') : t('details.file'), fileList);
  row(t('details.size'), Number.isFinite(d.size) ? owner.ctx.ui.formatSize(d.size) : null);
  if (family) row(t('details.location'), [family.user ? t('details.locationUser') : null, family.system ? t('details.locationSystem') : null].filter(Boolean).join(' · '));
  return h('div', { class: 'card fv-dcard' }, rows);
}
