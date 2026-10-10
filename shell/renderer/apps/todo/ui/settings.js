// Settings page (replaces the main pane): general options, smart lists, example tasks, shortcuts.
import { seed } from '../lib/seed.js';
import { shortcutsHelp } from './pickers.js';
import { fadeIn } from './anim.js';

export class SettingsView {
  constructor(app) {
    this.app = app;
    this.body = app.h('div', { class: 'td-set-body' });
    this.el = app.h('main', { class: 'td-main td-settings', hidden: true, 'aria-label': app.t('settings.title') }, app.h('div', { class: 'td-scroll' }, this.body));
  }

  render() {
    const { app } = this;
    const { h, t, ui, icon } = app;
    const show = app.view === 'settings';
    const was = !this.el.hidden;
    this.el.hidden = !show;
    app.list.el.hidden = show;
    if (!show) return;
    const prefs = app.store.data.prefs;
    const focusKey = this.body.contains(document.activeElement) ? document.activeElement.closest('[data-key]')?.dataset.key : null;
    ui.clear(this.body);
    const toggleRow = (key, label, desc) => {
      const val = key.startsWith('smart.') ? prefs.smart[key.slice(6)] !== false : !!prefs[key];
      const tg = ui.toggle({ checked: val, onchange: (v) => app.store.setPref(key, v) });
      tg.input.setAttribute('aria-label', label);
      tg.dataset.key = key;
      return h(
        'div',
        { class: 'card-row td-set-row clickable', dataset: { key }, onclick: (e) => !e.target.closest('.toggle') && tg.input.click() },
        h('div', { class: 'grow' }, h('div', null, label), desc ? h('div', { class: 'caption text-2' }, desc) : null),
        h('span', { class: 'td-set-state caption text-2' }, t(val ? 'common.on' : 'common.off')),
        tg,
      );
    };
    this.body.append(
      h('div', { class: 'td-set-head' }, h('button', { type: 'button', class: 'btn subtle icon-btn td-burger', 'aria-label': t('nav.toggle'), onclick: () => app.toggleNav() }, icon('line_horizontal_3')), h('h1', { class: 'td-title' }, t('settings.title'))),
      h('div', { class: 'td-set-sec body-strong' }, t('settings.general')),
      toggleRow('confirmDelete', t('settings.confirmDelete')),
      toggleRow('addOnTop', t('settings.addOnTop')),
      toggleRow('starToTop', t('settings.starToTop')),
      toggleRow('sound', t('settings.sound'), t('settings.soundDesc')),
      toggleRow('dueTodayInMyDay', t('settings.dueToday'), t('settings.dueTodayDesc')),
      h('div', { class: 'td-set-sec body-strong' }, t('settings.smartLists')),
      toggleRow('smart.important', t('nav.important')),
      toggleRow('smart.planned', t('nav.planned')),
      toggleRow('smart.assigned', t('nav.assigned'), t('settings.assignedDesc')),
      toggleRow('smart.all', t('nav.all')),
      toggleRow('smart.completed', t('nav.completed')),
      toggleRow('autoHideEmpty', t('settings.autoHide'), t('settings.autoHideDesc')),
      h('div', { class: 'td-set-sec body-strong' }, t('settings.examples')),
      h(
        'div',
        { class: 'card-row td-set-row' },
        h('div', { class: 'grow' }, h('div', null, t('settings.examplesLabel')), h('div', { class: 'caption text-2' }, t('settings.examplesDesc'))),
        app.store.hasSeed()
          ? h('button', { type: 'button', class: 'btn', dataset: { key: 'seed' }, onclick: () => app.list.removeExamples() }, t('seed.remove'))
          : h('button', { type: 'button', class: 'btn', dataset: { key: 'seed' }, onclick: () => this.addExamples() }, t('settings.addExamples')),
      ),
      h('div', { class: 'td-set-sec body-strong' }, t('settings.help')),
      h('button', { type: 'button', class: 'card-row td-set-row td-set-link', dataset: { key: 'keys' }, onclick: () => shortcutsHelp(app) }, icon('keyboard'), h('div', { class: 'grow' }, t('keys.title')), h('span', { class: 'caption text-2' }, app.fmt.keys('Ctrl+Shift+?')), icon('chevron_right', { size: 12 })),
      h('div', { class: 'td-set-about caption text-2' }, t('settings.about')),
    );
    if (!was) fadeIn(this.body, { y: 16 });
    if (focusKey) this.body.querySelector(`[data-key="${focusKey}"] input, button[data-key="${focusKey}"]`)?.focus({ preventScroll: true });
  }

  addExamples() {
    const { app } = this;
    seed(app.store, app.i18n.lang);
    app.store.data.prefs.seedBanner = true;
    app.store.commit('prefs', { key: 'seedBanner' });
  }
}
