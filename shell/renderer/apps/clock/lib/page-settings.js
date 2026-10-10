// Clock — Settings page: alarm / timer tones (synthesised, with preview), default snooze, focus
// session options, app theme (per-app theme when the shell supports it, otherwise the system theme),
// time format and notification status with links to the system Settings, and About.
import { TONES, toneById } from './tones.js';
import { SNOOZE_CHOICES } from './store.js';
import { minutesText, uses12h } from './time.js';

const GOALS = [15, 30, 45, 60, 90, 120, 180, 240, 300, 360, 480];

export class SettingsPage {
  constructor(app) {
    this.app = app;
    this.perAppThemes = null;
  }

  get store() {
    return this.app.store;
  }

  build() {
    this.el = this.app.h('section', { class: 'ck-settings' });
    this.detectThemes().then(() => this.render());
    this.render();
    return this.el;
  }

  async detectThemes() {
    try {
      const m = await import('../../../core/theme.js');
      this.perAppThemes = typeof m.effectiveTheme === 'function';
    } catch {
      this.perAppThemes = false;
    }
  }

  show() {
    this.render();
  }

  row({ icon: ic, title, desc, control, key }) {
    const { h, icon } = this.app;
    return h(
      'div',
      { class: 'ck-set-row', dataset: key ? { key } : null },
      icon(ic, { size: 20 }),
      h('div', { class: 'ck-set-text' }, h('div', null, title), desc ? h('div', { class: 'caption text-2' }, desc) : null),
      h('div', { class: 'ck-set-control' }, control),
    );
  }

  toneSelect(value, onchange, label) {
    const { h, ui, icon, lang, t } = this.app;
    const sel = ui.select({ options: TONES.map((x) => ({ value: x.id, label: x.name[lang] || x.name.en })), value, onchange });
    sel.setAttribute('aria-label', label);
    const play = h('button', { type: 'button', class: 'btn icon-btn', 'aria-label': t('settings.preview'), 'data-tip': t('settings.preview'), onclick: () => this.app.shell.sounds?.play?.(toneById(sel.value).pattern || 'alarm') }, icon('play'));
    return h('div', { class: 'row' }, sel, play);
  }

  render() {
    if (!this.el) return;
    const { h, t, ui, icon, shell, ctx } = this.app;
    const p = this.store.prefs;
    const f = p.focus;
    const scroll = this.el.closest('.ck-scroll')?.scrollTop;
    const sel = (key, options, value, label) => {
      const s = ui.select({ options, value, onchange: (v) => this.store.setPref(key, isNaN(Number(v)) ? v : Number(v)) });
      s.setAttribute('aria-label', label);
      return s;
    };
    // ---- general: theme / time format / notifications
    const sysTheme = document.documentElement.dataset.theme === 'dark' ? t('settings.dark') : t('settings.light');
    let themeControl;
    if (this.perAppThemes) {
      const cur = ctx.settings.get('appThemes')?.clock?.theme || 'system';
      const radios = h('div', { class: 'ck-radios', role: 'radiogroup', 'aria-label': t('settings.theme') });
      for (const [v, label] of [
        ['light', t('settings.light')],
        ['dark', t('settings.dark')],
        ['system', t('settings.system')],
      ]) {
        radios.appendChild(
          h(
            'label',
            { class: 'radio' },
            h('input', {
              type: 'radio',
              name: 'ck-theme',
              value: v,
              checked: cur === v,
              onchange: () => {
                const all = { ...(ctx.settings.get('appThemes') || {}) };
                all.clock = { ...(all.clock || {}), theme: v };
                ctx.settings.set('appThemes', all).catch((err) => ui.alert(err.message, { parent: this.app.win }));
              },
            }),
            h('span', null, label),
          ),
        );
      }
      themeControl = radios;
    } else {
      themeControl = h('button', { type: 'button', class: 'btn', onclick: () => shell.launch('settings', { page: 'colors' }) }, t('settings.colors'));
    }
    const h12 = uses12h(this.app.locale, ctx.settings.get('clock24h') ?? null);
    const n = ctx.settings.get('notifications') || {};
    const notifState = n.enabled === false ? t('settings.notifOff') : n.dnd ? t('settings.notifDnd') : t('settings.notifOn');
    const sections = [
      h('h1', { class: 'title ck-set-title' }, t('nav.settings')),
      h('div', { class: 'ck-set-section body-strong' }, t('settings.alarmsTimers')),
      this.row({ key: 'sound', icon: 'clock_alarm', title: t('settings.alarmSound'), desc: t('settings.alarmSoundDesc'), control: this.toneSelect(p.sound, (v) => this.store.setPref('sound', v), t('settings.alarmSound')) }),
      this.row({ key: 'timerSound', icon: 'hourglass_half', title: t('settings.timerSound'), desc: t('settings.timerSoundDesc'), control: this.toneSelect(p.timerSound, (v) => this.store.setPref('timerSound', v), t('settings.timerSound')) }),
      this.row({
        key: 'snooze',
        icon: 'alert_snooze',
        title: t('settings.snooze'),
        desc: t('settings.snoozeDesc'),
        control: sel('snooze', SNOOZE_CHOICES.map((m) => ({ value: m, label: m ? t('alarm.snoozeMin', { n: m }) : t('alarm.snoozeOff') })), p.snooze, t('settings.snooze')),
      }),
      h('div', { class: 'ck-set-section body-strong' }, t('nav.focus')),
      this.row({ key: 'chunk', icon: 'target', title: t('settings.focusPeriod'), desc: t('settings.focusPeriodDesc'), control: sel('focus.chunk', [25, 30, 45, 60].map((m) => ({ value: m, label: minutesText(t, m) })), f.chunk, t('settings.focusPeriod')) }),
      this.row({ key: 'brk', icon: 'drink_coffee', title: t('settings.breakLength'), control: sel('focus.brk', [5, 10, 15].map((m) => ({ value: m, label: minutesText(t, m) })), f.brk, t('settings.breakLength')) }),
      this.row({ key: 'goal', icon: 'trophy', title: t('settings.goal'), control: sel('focus.goal', GOALS.map((m) => ({ value: m, label: minutesText(t, m) })), GOALS.includes(f.goal) ? f.goal : 60, t('settings.goal')) }),
      this.row({
        key: 'dnd',
        icon: 'alert_off',
        title: t('settings.dnd'),
        desc: t('settings.dndDesc'),
        control: sel(
          'focus.dnd',
          [
            { value: 'ask', label: t('settings.dndAsk') },
            { value: 'always', label: t('settings.dndAlways') },
            { value: 'never', label: t('settings.dndNever') },
          ],
          f.dnd,
          t('settings.dnd'),
        ),
      }),
      this.row({
        key: 'focusSound',
        icon: 'music_note_2',
        title: t('settings.focusSound'),
        desc: t('settings.focusSoundDesc'),
        control: (() => {
          const tg = ui.toggle({
            checked: f.sound,
            label: f.sound ? t('common.on') : t('common.off'),
            onchange: (v) => {
              this.store.setPref('focus.sound', v);
              tg.querySelector('.toggle-label').textContent = v ? t('common.on') : t('common.off');
            },
          });
          tg.input.setAttribute('aria-label', t('settings.focusSound'));
          return tg;
        })(),
      }),
      h('div', { class: 'ck-set-section body-strong' }, t('settings.general')),
      this.row({
        key: 'theme',
        icon: 'paint_brush',
        title: t('settings.theme'),
        desc: this.perAppThemes ? t('settings.themeDesc') : t('settings.themeSystemDesc', { mode: sysTheme }),
        control: themeControl,
      }),
      this.row({
        key: 'format',
        icon: 'clock',
        title: t('settings.timeFormat'),
        desc: h12 ? t('settings.format12') : t('settings.format24'),
        control: h('button', { type: 'button', class: 'btn', onclick: () => shell.launch('settings', { page: 'time', section: 'clock24h' }) }, t('settings.dateTime')),
      }),
      this.row({
        key: 'notifications',
        icon: 'alert',
        title: t('settings.notifications'),
        desc: notifState,
        control: h('button', { type: 'button', class: 'btn', onclick: () => shell.launch('settings', { page: 'notifications' }) }, t('settings.notifSettings')),
      }),
      h('div', { class: 'infobar ck-set-info' }, icon('info', { filled: true }), h('div', { class: 'caption' }, t('settings.background'))),
      h('div', { class: 'ck-set-section body-strong' }, t('settings.about')),
      h(
        'div',
        { class: 'ck-set-row ck-about' },
        h('img', { src: this.app.ctx.appUrl('icon.svg'), alt: '', width: 32, height: 32 }),
        h('div', { class: 'ck-set-text' }, h('div', null, t('settings.appName')), h('div', { class: 'caption text-2' }, t('settings.version', { v: '1.0' })), h('div', { class: 'caption text-2' }, t('settings.credits'))),
      ),
    ];
    this.el.replaceChildren(...sections);
    if (scroll) this.el.closest('.ck-scroll').scrollTop = scroll;
  }

  onStore(kind) {
    if (kind === 'notifications' || kind === 'all') this.render();
  }

  tick() {}
  destroy() {}
}
