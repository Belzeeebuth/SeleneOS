// Notepad Settings page (gear button): app theme, font, word wrap, status bar, default line ending,
// where files open, session restore, and About. Shown in place of the editor, like Windows 11.
import { fontControls, styleKey } from './dialogs.js';

export class SettingsPage {
  constructor(nw) {
    this.nw = nw;
    this.isOpen = false;
    this.expanded = new Set();
    this.el = nw.h('div', { class: 'np-settings', hidden: true, role: 'region', tabindex: '-1' });
    this.el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !e.defaultPrevented) {
        e.preventDefault();
        e.stopPropagation();
        this.close();
      }
    });
  }

  async open() {
    if (this.isOpen) return;
    this.isOpen = true;
    this.nw.root.classList.add('settings-open');
    await this.nw.shared.loadFonts();
    this.render();
    this.el.hidden = false;
    if (document.documentElement.dataset.animations !== 'off') {
      this.el.animate([{ opacity: 0, transform: 'translateX(24px)' }, { opacity: 1, transform: 'none' }], { duration: 250, easing: 'cubic-bezier(0.1, 0.9, 0.2, 1)' });
    }
    this.el.querySelector('.np-set-back')?.focus();
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.el.hidden = true;
    this.nw.root.classList.remove('settings-open');
    this.nw.active?.focus();
  }

  refresh() {
    if (!this.isOpen) return;
    const scroll = this.el.querySelector('.np-set-scroll')?.scrollTop || 0;
    const focusKey = document.activeElement?.closest?.('[data-key]')?.dataset.key;
    this.render();
    const sc = this.el.querySelector('.np-set-scroll');
    if (sc) sc.scrollTop = scroll;
    if (focusKey) this.el.querySelector(`[data-key="${focusKey}"] .np-set-head, [data-key="${focusKey}"] input, [data-key="${focusKey}"] select`)?.focus();
  }

  render() {
    const { h, icon, t, ui, shared } = this.nw;
    const p = shared.prefs;
    const set = (k, v) => shared.setPref(k, v);

    const card = (key, ic, title, desc, control) =>
      h('div', { class: 'np-set-card', dataset: { key } }, h('div', { class: 'np-set-row' }, icon(ic, { size: 20 }), h('div', { class: 'np-set-text' }, h('div', null, title), desc ? h('div', { class: 'caption text-2' }, desc) : null), control));

    const expander = (key, ic, title, desc, summary, content) => {
      const open = this.expanded.has(key);
      const body = h('div', { class: 'np-set-body', hidden: !open }, content);
      const chev = icon('chevron_down', { size: 12, class: 'np-set-chev' });
      const head = h(
        'button',
        {
          type: 'button',
          class: 'np-set-row np-set-head',
          'aria-expanded': String(open),
          onclick: () => {
            const now = !this.expanded.has(key);
            if (now) this.expanded.add(key);
            else this.expanded.delete(key);
            body.hidden = !now;
            head.setAttribute('aria-expanded', String(now));
            wrap.classList.toggle('open', now);
            if (now && document.documentElement.dataset.animations !== 'off') {
              body.animate([{ opacity: 0, transform: 'translateY(-6px)' }, { opacity: 1, transform: 'none' }], { duration: 200, easing: 'cubic-bezier(0.1, 0.9, 0.2, 1)' });
            }
          },
        },
        icon(ic, { size: 20 }),
        h('div', { class: 'np-set-text' }, h('div', null, title), desc ? h('div', { class: 'caption text-2' }, desc) : null),
        summary ? h('span', { class: 'np-set-summary text-2' }, summary) : null,
        chev,
      );
      const wrap = h('div', { class: ['np-set-card', 'np-set-exp', open && 'open'], dataset: { key } }, head, body);
      return wrap;
    };

    const radios = (name, value, options, onchange) =>
      h(
        'div',
        { class: 'np-set-radios', role: 'radiogroup' },
        options.map(([v, label, desc]) =>
          h(
            'label',
            { class: 'radio np-set-radio' },
            h('input', { type: 'radio', name: `${name}-${this.nw.win.id}`, value: v, checked: v === value, onchange: () => onchange(v) }),
            h('span', null, h('div', null, label), desc ? h('div', { class: 'caption text-2' }, desc) : null),
          ),
        ),
      );

    const themeLabel = { light: t('settings.themeLight'), dark: t('settings.themeDark'), system: t('settings.themeSystem') };
    const font = p.font;
    const fontSummary = `${font.family}, ${t(`font.styles.${styleKey(font)}`)}, ${this.nw.fmt(font.size)} pt`;
    const fontCtl = fontControls(this.nw, font, shared.fonts, (f) => set('font', f));

    const sel = (key, value, options, onchange) => {
      const s = ui.select({ options: options.map(([v, l]) => ({ value: v, label: l })), value, onchange });
      s.classList.add('np-set-select');
      s.dataset.key = key;
      return s;
    };
    const toggle = (key, checked, onchange) => {
      const tg = ui.toggle({ checked, onchange });
      tg.classList.add('np-set-toggle');
      tg.input.setAttribute('aria-label', key);
      return tg;
    };

    const env = this.nw.ctx.env || {};
    const content = h(
      'div',
      { class: 'np-set-content' },
      h('div', { class: 'np-set-section' }, t('settings.appearance')),
      expander(
        'theme',
        'dark_theme',
        t('settings.theme'),
        t('settings.themeDesc'),
        themeLabel[p.theme] || themeLabel.system,
        radios('np-theme', p.theme, [
          ['light', themeLabel.light],
          ['dark', themeLabel.dark],
          ['system', themeLabel.system],
        ], (v) => set('theme', v)),
      ),
      h('div', { class: 'np-set-section' }, t('settings.textFormatting')),
      expander('font', 'text_font', t('settings.font'), null, fontSummary, fontCtl.el),
      card('wrap', 'text_wrap', t('view.wordWrap'), t('settings.wrapDesc'), toggle(t('view.wordWrap'), !!p.wordWrap, (v) => set('wordWrap', v))),
      card('status', 'panel_bottom', t('view.statusBar'), t('settings.statusDesc'), toggle(t('view.statusBar'), !!p.statusBar, (v) => set('statusBar', v))),
      card('eol', 'arrow_enter_left', t('settings.eol'), t('settings.eolDesc'), sel('eol', p.defaultEol, [
        ['lf', t('eol.lf')],
        ['crlf', t('eol.crlf')],
        ['cr', t('eol.cr')],
      ], (v) => set('defaultEol', v))),
      h('div', { class: 'np-set-section' }, t('settings.opening')),
      card('openFiles', 'tab_desktop_multiple', t('settings.openFiles'), t('settings.openFilesDesc'), sel('openFiles', p.openFiles, [
        ['tab', t('settings.openTab')],
        ['window', t('settings.openWindow')],
      ], (v) => set('openFiles', v))),
      expander(
        'startup',
        'window_arrow_up',
        t('settings.startup'),
        null,
        p.startup === 'restore' ? t('settings.startupRestore') : t('settings.startupNew'),
        radios('np-startup', p.startup, [
          ['restore', t('settings.startupRestore'), t('settings.startupRestoreDesc')],
          ['new', t('settings.startupNew'), t('settings.startupNewDesc')],
        ], (v) => set('startup', v)),
      ),
      h('div', { class: 'np-set-section' }, t('settings.about')),
      h(
        'div',
        { class: 'np-set-card np-set-about', dataset: { key: 'about' } },
        h('div', { class: 'np-set-row' }, h('img', { src: this.nw.ctx.appUrl('icon.svg'), alt: '', width: 32, height: 32 }), h('div', { class: 'np-set-text' }, h('div', null, this.nw.appName), h('div', { class: 'caption text-2' }, t('settings.version', { v: env.version || '1.0' })))),
        h('div', { class: 'caption text-2 np-set-legal' }, t('settings.legal')),
      ),
    );

    const back = h('button', { type: 'button', class: 'btn subtle icon-btn np-set-back', 'aria-label': t('settings.back'), 'data-tip': t('settings.back'), onclick: () => this.close() }, icon('arrow_left', { size: 16 }));
    this.el.replaceChildren(h('div', { class: 'np-set-header' }, back, h('div', { class: 'np-set-title' }, t('settings.title'))), h('div', { class: 'np-set-scroll' }, content));
  }
}
