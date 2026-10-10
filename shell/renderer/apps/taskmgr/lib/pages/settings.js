// Settings page: default start page, real-time update speed, window management and other options.
import { PAGE_ORDER } from '../app.js';

export class SettingsPage {
  constructor(app) {
    this.app = app;
    this.id = 'settings';
    this.icon = 'settings';
    this.needs = { procs: false, shell: false };
  }

  title() {
    return this.app.t('nav.settings');
  }

  mount(el) {
    this.host = el;
    this.build();
  }

  build() {
    const { h, ui } = this.app.ctx;
    const { t, prefs } = this.app;
    const row = (label, desc, control) =>
      h('div', { class: 'tm-set-row' }, h('div', { class: 'tm-set-text' }, h('div', { class: 'tm-set-label' }, label), desc ? h('div', { class: 'caption text-2' }, desc) : null), control);
    const toggle = (key) => {
      const tg = ui.toggle({ checked: !!prefs[key], onchange: (v) => this.app.setPref(key, v) });
      tg.input.setAttribute('aria-label', t(`set.${key}`));
      return tg;
    };
    const select = (key, options) => {
      const s = ui.select({ options, value: prefs[key], onchange: (v) => this.app.setPref(key, v) });
      s.setAttribute('aria-label', t(`set.${key}`));
      s.classList.add('tm-set-select');
      return s;
    };
    this.host.textContent = '';
    this.host.appendChild(
      h(
        'div',
        { class: 'tm-settings' },
        h('div', { class: 'tm-set-group' }, t('set.general')),
        h(
          'div',
          { class: 'tm-set-card' },
          row(t('set.startPage'), null, select('startPage', PAGE_ORDER.map((id) => ({ value: id, label: this.app.t(`nav.${id}`) })))),
          row(t('set.speed'), t('set.speedDesc'), select('speed', ['high', 'normal', 'low', 'paused'].map((s) => ({ value: s, label: t(`speed.${s}`) })))),
        ),
        h('div', { class: 'tm-set-group' }, t('set.window')),
        h('div', { class: 'tm-set-card' }, row(t('set.alwaysOnTop'), null, toggle('alwaysOnTop')), row(t('set.minimizeOnUse'), t('set.minimizeOnUseDesc'), toggle('minimizeOnUse'))),
        h('div', { class: 'tm-set-group' }, t('set.other')),
        h(
          'div',
          { class: 'tm-set-card' },
          row(t('set.groupByType'), null, toggle('groupByType')),
          row(t('set.showFullName'), null, toggle('showFullName')),
          row(t('set.historyAll'), null, toggle('historyAll')),
          row(t('set.kernelThreads'), null, toggle('kernelThreads')),
          row(t('set.effConfirm'), null, toggle('effConfirm')),
        ),
        h('div', { class: 'tm-set-group' }, t('set.about')),
        h(
          'div',
          { class: 'tm-set-card' },
          h('div', { class: 'tm-set-row about' }, h('img', { src: this.app.ctx.appUrl('icon.svg'), width: 32, height: 32, alt: '' }), h('div', { class: 'tm-set-text' }, h('div', { class: 'tm-set-label' }, t('app.name')), h('div', { class: 'caption text-2' }, t('set.aboutDesc')))),
        ),
      ),
    );
  }

  onPref(key, value, { hidden } = {}) {
    if (!hidden && ['speed', 'groupByType', 'kernelThreads', 'effConfirm'].includes(key)) this.build();
    else if (hidden) this._dirty = true;
  }
  show() {
    if (this._dirty) {
      this._dirty = false;
      this.build();
    }
  }
  relabel() {
    this.build();
  }
  focus() {
    this.host.querySelector('select, input')?.focus();
  }
  commands() {
    return [{ id: 'run', icon: 'window_new', label: this.app.t('cmd.run'), action: () => this.app.actions.runNewTask() }];
  }
}
