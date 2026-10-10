// The Settings tab (Windows Terminal style): left navigation, Fluent setting rows on the right.
// Changes apply at once to every Terminal window and are saved (lib/prefs.js).
import { prefs, FONTS, CURSORS, BELLS, CLOSE_ON_EXIT } from './prefs.js';
import { SCHEMES, SYSTEM_SCHEME, schemeById, resolveScheme, rgba, PALETTE_KEYS } from './schemes.js';
import { profileIcon } from './icons.js';

const SECTIONS = [
  { id: 'startup', icon: 'rocket' },
  { id: 'interaction', icon: 'cursor' },
  { id: 'appearance', icon: 'paint_brush' },
  { id: 'schemes', icon: 'color' },
  { id: 'advanced', icon: 'options' },
];

export class SettingsPage {
  constructor(app) {
    this.app = app;
    this.ctx = app.ctx;
    this.section = 'startup';
    this.syncers = [];
    const { h } = this.ctx;
    this.nav = h('nav', { class: 'tm-set-nav', role: 'tablist', 'aria-orientation': 'vertical' });
    this.main = h('div', { class: 'tm-set-main', tabindex: '-1' });
    this.el = h('div', { class: 'tm-settings' }, this.nav, this.main);
    this.offs = [
      prefs.on('change', () => this.sync()),
      this.ctx.shell.theme.on('change', () => this.sync()),
    ];
    this.render();
    // Narrow window: the navigation shows icons only, so give them tooltips.
    this.ro = new ResizeObserver(() => this.updateNavTips());
    this.ro.observe(this.el);
  }

  updateNavTips() {
    const narrow = this.el.clientWidth > 0 && this.el.clientWidth <= 680;
    for (const item of this.nav.querySelectorAll('.nav-item')) {
      if (narrow) item.dataset.tip = item.getAttribute('aria-label');
      else delete item.dataset.tip;
    }
  }

  get t() {
    return this.ctx.t;
  }

  focus() {
    this.main.focus({ preventScroll: true });
  }

  show(section) {
    if (!SECTIONS.some((s) => s.id === section)) return;
    const changed = section !== this.section;
    this.section = section;
    for (const item of this.nav.querySelectorAll('.nav-item')) {
      const on = item.dataset.section === section;
      item.classList.toggle('selected', on);
      item.setAttribute('aria-selected', String(on));
      item.tabIndex = on ? 0 : -1;
    }
    if (changed) this.renderMain();
  }

  relabel() {
    this.render();
  }

  // The list of installed fonts arrived (lib/window.js): refresh the font face list if it is shown.
  fontsChanged() {
    const sel = this.main.querySelector('select[data-key="fontFace"]');
    if (!sel || sel.matches(':focus')) return;
    const row = sel.closest('.tm-set-row');
    const fresh = this.fontRow();
    row.replaceWith(fresh);
  }

  dispose() {
    for (const off of this.offs) off?.();
    this.ro?.disconnect();
  }

  sync() {
    for (const fn of this.syncers) fn();
  }

  // ------------------------------------------------------------------ building blocks
  row({ icon: ic, label, desc, control, id }) {
    const { h, icon } = this.ctx;
    const labelId = id ? `tm-set-${id}-${Math.random().toString(36).slice(2, 7)}` : undefined;
    if (control && labelId) control.setAttribute?.('aria-labelledby', labelId);
    return h(
      'div',
      { class: 'tm-set-row', dataset: id ? { setting: id } : undefined },
      ic ? icon(ic, { size: 20 }) : null,
      h('div', { class: 'tm-set-text' }, h('div', { class: 'tm-set-label', id: labelId }, label), desc ? h('div', { class: 'tm-set-desc' }, desc) : null),
      h('div', { class: 'tm-set-control' }, control),
    );
  }

  toggle(key) {
    const { ui, t } = this.ctx;
    const label = this.ctx.h('span', { class: 'tm-toggle-state' });
    const tg = ui.toggle({ checked: !!prefs.get(key), onchange: (v) => prefs.set(key, v) });
    tg.appendChild(label);
    const sync = () => {
      tg.input.checked = !!prefs.get(key);
      label.textContent = tg.input.checked ? t('common.on') : t('common.off');
    };
    this.syncers.push(sync);
    sync();
    return tg;
  }

  select(key, options, { onchange } = {}) {
    const { ui } = this.ctx;
    const sel = ui.select({ options, value: prefs.get(key), onchange: (v) => (onchange ? onchange(v) : prefs.set(key, v)) });
    sel.dataset.key = key;
    this.syncers.push(() => {
      sel.value = String(prefs.get(key));
    });
    return sel;
  }

  number(key, { min, max, step = 1 }) {
    const { h, icon, t } = this.ctx;
    const input = h('input', { class: 'input tm-num', type: 'number', min, max, step, value: prefs.get(key), dataset: { key } });
    const commit = () => {
      const n = Number(input.value);
      if (input.value === '' || !Number.isFinite(n)) input.value = prefs.get(key);
      else prefs.set(key, Math.max(min, Math.min(max, n)));
      input.value = prefs.get(key);
    };
    input.addEventListener('change', commit);
    input.addEventListener('keydown', (e) => e.key === 'Enter' && commit());
    const bump = (d) => {
      prefs.set(key, Math.max(min, Math.min(max, Number(prefs.get(key)) + d * step)));
    };
    this.syncers.push(() => {
      if (document.activeElement !== input) input.value = prefs.get(key);
    });
    return h(
      'div',
      { class: 'tm-spin' },
      input,
      h('button', { type: 'button', class: 'btn subtle icon-btn', 'aria-label': t('settings.decrease'), onclick: () => bump(-1) }, icon('subtract', { size: 14 })),
      h('button', { type: 'button', class: 'btn subtle icon-btn', 'aria-label': t('settings.increase'), onclick: () => bump(1) }, icon('add', { size: 14 })),
    );
  }

  // ------------------------------------------------------------------ render
  render() {
    this.renderNav();
    this.renderMain();
  }

  renderNav() {
    const { h, icon, ui } = this.ctx;
    const t = this.t;
    ui.clear(this.nav);
    this.nav.appendChild(h('div', { class: 'tm-set-navtitle' }, t('settings.title')));
    for (const s of SECTIONS) {
      const item = h(
        'div',
        {
          class: ['nav-item', s.id === this.section && 'selected'],
          role: 'tab',
          tabindex: s.id === this.section ? '0' : '-1',
          'aria-selected': String(s.id === this.section),
          dataset: { section: s.id },
          'aria-label': t(`settings.${s.id}`),
          onclick: () => this.show(s.id),
          onkeydown: (e) => {
            const i = SECTIONS.findIndex((x) => x.id === s.id);
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              const n = SECTIONS[(i + (e.key === 'ArrowDown' ? 1 : -1) + SECTIONS.length) % SECTIONS.length];
              this.show(n.id);
              this.nav.querySelector(`[data-section="${n.id}"]`)?.focus();
            } else if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              this.show(s.id);
            }
          },
        },
        icon(s.icon),
        h('span', { class: 'ellipsis' }, t(`settings.${s.id}`)),
      );
      this.nav.appendChild(item);
    }
    this.updateNavTips?.();
  }

  renderMain() {
    const { h, ui } = this.ctx;
    const t = this.t;
    this.syncers = [];
    ui.clear(this.main);
    const body = h('div', { class: 'tm-set-body' }, h('h1', { class: 'tm-set-h1' }, t(`settings.${this.section}`)));
    this[`render_${this.section}`](body);
    this.main.appendChild(body);
    this.main.scrollTop = 0;
    if (document.documentElement.dataset.animations !== 'off') {
      body.animate([{ opacity: 0, transform: 'translateY(12px)' }, { opacity: 1, transform: 'none' }], { duration: 250, easing: 'cubic-bezier(0.1, 0.9, 0.2, 1)' });
    }
    this.sync();
  }

  render_startup(body) {
    const { h, icon, ui } = this.ctx;
    const t = this.t;
    const profiles = this.app.profiles();
    body.appendChild(
      this.row({
        id: 'defaultProfile',
        icon: 'window_console',
        label: t('settings.defaultProfile'),
        desc: t('settings.defaultProfileDesc'),
        control: this.select(
          'defaultProfile',
          profiles.map((p) => ({ value: p.id, label: p.name })),
        ),
      }),
    );
    // Starting directory: the home folder, or a folder picked here.
    const dirInput = h('input', { class: 'input tm-dir', type: 'text', spellcheck: false, placeholder: t('settings.homeFolder'), value: prefs.get('startDir') });
    dirInput.addEventListener('change', async () => {
      const v = dirInput.value.trim();
      if (v) {
        // '~' and '~/…' are the home folder (main/ipc/pty.js expands them the same way).
        const home = this.app.env?.home || '';
        const abs = v === '~' ? home : v.startsWith('~/') ? `${home}/${v.slice(2)}` : v;
        const st = abs.startsWith('/') ? await this.ctx.api.invoke('fs:stat', abs).catch(() => null) : null;
        if (!st?.dir) {
          ui.alert(t('settings.noSuchFolder', { path: v }), { title: t('settings.startDir'), parent: this.app.win });
          dirInput.value = prefs.get('startDir');
          return;
        }
      }
      prefs.set('startDir', v);
    });
    dirInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && dirInput.value !== prefs.get('startDir')) {
        e.stopPropagation();
        dirInput.value = prefs.get('startDir');
      }
    });
    const browse = h(
      'button',
      {
        type: 'button',
        class: 'btn',
        onclick: async () => {
          const p = await ui.filePicker({ mode: 'folder', path: prefs.get('startDir') || undefined, parent: this.app.win }).catch((e) => (this.app.error(e), null));
          if (p) prefs.set('startDir', p);
        },
      },
      t('settings.browse'),
    );
    const reset = h('button', { type: 'button', class: 'btn subtle icon-btn', 'aria-label': t('settings.useHome'), 'data-tip': t('settings.useHome'), onclick: () => prefs.set('startDir', '') }, icon('home', { size: 16 }));
    this.syncers.push(() => {
      if (document.activeElement !== dirInput) dirInput.value = prefs.get('startDir');
      reset.disabled = !prefs.get('startDir');
    });
    body.appendChild(this.row({ id: 'startDir', icon: 'folder_open', label: t('settings.startDir'), desc: t('settings.startDirDesc'), control: h('div', { class: 'tm-dirpick' }, dirInput, browse, reset) }));

    body.appendChild(h('h2', { class: 'tm-set-h2' }, t('settings.profiles')));
    for (const p of profiles) {
      const cmd = p.command ? p.command.join(' ') : this.app.env?.shell || '/bin/bash';
      body.appendChild(
        h(
          'div',
          { class: 'tm-set-row tm-profile-row' },
          profileIcon(h, p.icon, 20),
          h('div', { class: 'tm-set-text' }, h('div', { class: 'tm-set-label' }, p.name), h('div', { class: 'tm-set-desc mono' }, cmd)),
          h('div', { class: 'tm-set-control' }, h('button', { type: 'button', class: 'btn', onclick: () => this.app.newTab(p) }, icon('add', { size: 16 }), t('settings.openTab'))),
        ),
      );
    }
  }

  render_interaction(body) {
    const t = this.t;
    body.appendChild(this.row({ id: 'copyOnSelect', icon: 'copy', label: t('settings.copyOnSelect'), desc: t('settings.copyOnSelectDesc'), control: this.toggle('copyOnSelect') }));
    body.appendChild(this.row({ id: 'confirmClose', icon: 'dismiss_square_multiple', label: t('settings.confirmClose'), desc: t('settings.confirmCloseDesc'), control: this.toggle('confirmClose') }));
    body.appendChild(this.row({ id: 'warnPaste', icon: 'clipboard_paste', label: t('settings.warnPaste'), desc: t('settings.warnPasteDesc'), control: this.toggle('warnPaste') }));
    body.appendChild(this.row({ id: 'warnLargePaste', icon: 'clipboard_text_ltr', label: t('settings.warnLargePaste'), desc: t('settings.warnLargePasteDesc'), control: this.toggle('warnLargePaste') }));
    body.appendChild(
      this.row({
        id: 'bell',
        icon: 'alert',
        label: t('settings.bell'),
        desc: t('settings.bellDesc'),
        control: this.select(
          'bell',
          BELLS.map((b) => ({ value: b, label: t(`settings.bell_${b}`) })),
        ),
      }),
    );
    body.appendChild(
      this.row({
        id: 'closeOnExit',
        icon: 'tab_desktop_arrow_clockwise',
        label: t('settings.closeOnExit'),
        desc: t('settings.closeOnExitDesc'),
        control: this.select(
          'closeOnExit',
          CLOSE_ON_EXIT.map((b) => ({ value: b, label: t(`settings.close_${b}`) })),
        ),
      }),
    );
  }

  schemeOptions() {
    const t = this.t;
    return [{ value: 'system', label: t('settings.schemeSystem') }, ...SCHEMES.map((s) => ({ value: s.id, label: s.name }))];
  }

  preview() {
    const { h } = this.ctx;
    const el = h('div', { class: 'tm-preview', 'aria-hidden': 'true' });
    const draw = () => {
      const transparent = document.documentElement.dataset.transparency !== 'off';
      const scheme = resolveScheme(prefs.get('scheme'), this.ctx.shell.theme.mode);
      const c = scheme.colors;
      const op = transparent ? prefs.get('opacity') / 100 : 1;
      el.style.background = op >= 1 ? c.background : rgba(c.background, op);
      el.style.color = c.foreground;
      el.style.fontFamily = `"${prefs.get('fontFace')}", "Cascadia Mono", "DejaVu Sans Mono", monospace`;
      el.style.fontSize = `${prefs.get('fontSize')}px`;
      el.style.lineHeight = String(prefs.get('lineHeight'));
      const sp = (color, text, bold) => h('span', { style: { color, fontWeight: bold ? '700' : null } }, text);
      const user = this.app.env?.user || 'user';
      const host = this.app.env?.hostname || 'aurora';
      const root = user === 'root';
      const shape = prefs.get('cursorShape');
      // The Aurora prompt: green user@host (red for root), blue folder.
      const prompt = () => [sp(root ? c.brightRed : c.brightGreen, `${user}@${host}`, true), ':', sp(c.brightBlue, '~', true), root ? '# ' : '$ '];
      this.ctx.ui.clear(el);
      el.append(
        h('div', null, ...prompt(), 'ls --color'),
        h('div', null, sp(c.brightBlue, 'Documents', true), '  ', sp(c.brightBlue, 'Music', true), '  ', sp(c.brightGreen, 'run.sh', true), '  notes.txt  ', sp(c.brightRed, 'photo.zip', true)),
        h('div', null, ...prompt(), h('span', { class: ['tm-preview-cursor', shape, prefs.get('cursorBlink') && 'blink'], style: { '--c': c.cursor } })),
      );
    };
    this.syncers.push(draw);
    return el;
  }

  fontRow() {
    // Curated faces that are installed, then every other installed monospace family (fontconfig).
    const installed = Array.isArray(this.app.fonts) ? this.app.fonts : [];
    const curated = installed.length ? FONTS.filter((f) => installed.includes(f)) : FONTS;
    const fonts = [...new Set([...curated, ...installed, prefs.get('fontFace')])];
    return this.row({
      id: 'fontFace',
      icon: 'text_font',
      label: this.t('settings.fontFace'),
      control: this.select(
        'fontFace',
        fonts.map((f) => ({ value: f, label: f })),
      ),
    });
  }

  render_appearance(body) {
    const { h, ui } = this.ctx;
    const t = this.t;
    body.appendChild(this.preview());
    body.appendChild(this.row({ id: 'scheme', icon: 'color', label: t('settings.scheme'), desc: t('settings.schemeDesc'), control: this.select('scheme', this.schemeOptions()) }));
    body.appendChild(this.fontRow());
    body.appendChild(this.row({ id: 'fontSize', icon: 'text_font_size', label: t('settings.fontSize'), desc: t('settings.fontSizeDesc'), control: this.number('fontSize', { min: 6, max: 48 }) }));
    body.appendChild(
      this.row({
        id: 'lineHeight',
        icon: 'text_line_spacing',
        label: t('settings.lineHeight'),
        control: this.select(
          'lineHeight',
          [1, 1.1, 1.2, 1.3, 1.4, 1.5].map((v) => ({ value: v, label: this.ctx.i18n.formatNumber ? this.ctx.i18n.formatNumber(v, { minimumFractionDigits: 1 }) : String(v) })),
          { onchange: (v) => prefs.set('lineHeight', Number(v)) },
        ),
      }),
    );
    // Cursor shape: Windows Terminal shows the glyphs.
    const shapes = h('div', { class: 'tm-cursor-shapes', role: 'radiogroup', 'aria-label': t('settings.cursorShape') });
    const syncShapes = () => {
      for (const b of shapes.children) {
        const on = b.dataset.value === prefs.get('cursorShape');
        b.classList.toggle('selected', on);
        b.setAttribute('aria-checked', String(on));
      }
    };
    for (const c of CURSORS) {
      shapes.appendChild(
        h(
          'button',
          { type: 'button', role: 'radio', class: 'tm-cursor-opt', dataset: { value: c }, onclick: () => prefs.set('cursorShape', c) },
          h('span', { class: ['tm-cursor-glyph', c] }),
          h('span', null, t(`settings.cursor_${c}`)),
        ),
      );
    }
    this.syncers.push(syncShapes);
    body.appendChild(this.row({ id: 'cursorShape', icon: 'cursor', label: t('settings.cursorShape'), control: shapes }));
    body.appendChild(this.row({ id: 'cursorBlink', icon: 'eye', label: t('settings.cursorBlink'), control: this.toggle('cursorBlink') }));

    body.appendChild(h('h2', { class: 'tm-set-h2' }, t('settings.background')));
    const val = h('span', { class: 'tm-slider-val' });
    const pct = (v) => (this.ctx.i18n.formatNumber ? this.ctx.i18n.formatNumber(v / 100, { style: 'percent' }) : `${v}%`);
    const slider = ui.slider({ min: 20, max: 100, step: 1, value: prefs.get('opacity'), oninput: (v) => ((val.textContent = pct(v)), prefs.set('opacity', v)) });
    slider.setAttribute('aria-label', t('settings.opacity'));
    this.syncers.push(() => {
      if (Number(slider.value) !== prefs.get('opacity')) slider.setValue(prefs.get('opacity'));
      val.textContent = pct(prefs.get('opacity'));
    });
    const noTransparency = h('div', { class: 'tm-set-note', hidden: true }, t('settings.transparencyOff'));
    this.syncers.push(() => (noTransparency.hidden = document.documentElement.dataset.transparency !== 'off'));
    body.appendChild(this.row({ id: 'opacity', icon: 'color_background', label: t('settings.opacity'), desc: t('settings.opacityDesc'), control: h('div', { class: 'tm-slider' }, slider, val) }));
    body.appendChild(this.row({ id: 'acrylic', icon: 'blur', label: t('settings.acrylic'), desc: t('settings.acrylicDesc'), control: this.toggle('acrylic') }));
    body.appendChild(noTransparency);
  }

  schemeCard(s, { system = false } = {}) {
    const { h, icon } = this.ctx;
    const t = this.t;
    const value = system ? 'system' : s.id;
    const swatches = (sc) => h('div', { class: 'tm-swatches' }, PALETTE_KEYS.map((k) => h('span', { style: { background: sc.colors[k] } })));
    const sample = (sc) => {
      const c = sc.colors;
      return h(
        'div',
        { class: 'tm-scheme-sample', style: { background: c.background, color: c.foreground } },
        h('div', null, h('span', { style: { color: c.green } }, 'user@aurora'), ':', h('span', { style: { color: c.blue } }, '~'), '$ ls'),
        h('div', null, h('span', { style: { color: c.blue } }, 'docs'), ' ', h('span', { style: { color: c.red } }, 'a.zip'), ' ', h('span', { style: { color: c.yellow } }, 'b.c')),
        swatches(sc),
      );
    };
    const preview = system
      ? h('div', { class: 'tm-scheme-split' }, sample(schemeById(SYSTEM_SCHEME.light)), sample(schemeById(SYSTEM_SCHEME.dark)))
      : sample(s);
    const card = h(
      'button',
      { type: 'button', class: 'tm-scheme-card', role: 'radio', dataset: { scheme: value }, onclick: () => prefs.set('scheme', value) },
      preview,
      h('div', { class: 'tm-scheme-name' }, h('span', { class: 'ellipsis' }, system ? t('settings.schemeSystem') : s.name), h('span', { class: 'tm-scheme-check' }, icon('checkmark_circle', { size: 16, filled: true }))),
    );
    this.syncers.push(() => {
      const on = prefs.get('scheme') === value;
      card.classList.toggle('selected', on);
      card.setAttribute('aria-checked', String(on));
    });
    return card;
  }

  render_schemes(body) {
    const { h } = this.ctx;
    body.appendChild(h('div', { class: 'tm-set-intro text-2' }, this.t('settings.schemesIntro')));
    const grid = h('div', { class: 'tm-scheme-grid', role: 'radiogroup', 'aria-label': this.t('settings.scheme') });
    grid.appendChild(this.schemeCard(null, { system: true }));
    for (const s of SCHEMES) grid.appendChild(this.schemeCard(s));
    body.appendChild(grid);
  }

  render_advanced(body) {
    const { h, icon, ui } = this.ctx;
    const t = this.t;
    body.appendChild(this.row({ id: 'scrollback', icon: 'text_bullet_list', label: t('settings.scrollback'), desc: t('settings.scrollbackDesc'), control: this.number('scrollback', { min: 0, max: 100000, step: 1000 }) }));
    body.appendChild(
      this.row({
        id: 'reset',
        icon: 'arrow_reset',
        label: t('settings.reset'),
        desc: t('settings.resetDesc'),
        control: h(
          'button',
          {
            type: 'button',
            class: 'btn',
            onclick: async () => {
              const ok = await ui.confirm(t('settings.resetConfirm'), { title: t('settings.reset'), okLabel: t('settings.resetOk'), parent: this.app.win });
              if (ok) prefs.reset();
            },
          },
          t('settings.resetOk'),
        ),
      }),
    );
    body.appendChild(h('h2', { class: 'tm-set-h2' }, t('settings.about')));
    body.appendChild(
      h(
        'div',
        { class: 'tm-set-row' },
        h('img', { src: this.ctx.appUrl('icon.svg'), alt: '', width: 32, height: 32 }),
        h(
          'div',
          { class: 'tm-set-text' },
          h('div', { class: 'tm-set-label' }, this.ctx.i18n.name(this.ctx.manifest.name)),
          h('div', { class: 'tm-set-desc' }, t('about.version', { v: this.app.env?.version || '1.0' }), ' · ', t('about.credits')),
        ),
        h('div', { class: 'tm-set-control' }, icon('info', { size: 16 })),
      ),
    );
  }
}
