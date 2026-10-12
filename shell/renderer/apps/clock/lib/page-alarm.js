// Clock — Alarm page: alarm cards (time, "Rings in…", name, repeat days, sound, snooze, on/off),
// add / edit dialog with a spin-wheel time picker, edit mode (delete), context menus.
import { ringsIn, weekdayNames, weekOrder, wallTime, nextAlarmOccurrence } from './time.js';
import { TONES, toneById } from './tones.js';
import { SNOOZE_CHOICES, MAX_ALARMS } from './store.js';
import { timePicker, dayToggles, commandBar, enter } from './widgets.js';

export class AlarmPage {
  constructor(app) {
    this.app = app;
    this.editing = false;
    this.cards = new Map();
  }

  get store() {
    return this.app.store;
  }

  build() {
    const { h, t, icon } = this.app;
    this.grid = h('div', { class: 'ck-grid ck-alarm-grid', role: 'list' });
    this.empty = h(
      'div',
      { class: 'empty ck-empty', hidden: true },
      icon('clock_alarm', { size: 48 }),
      h('div', { class: 'subtitle' }, t('alarm.emptyTitle')),
      h('div', { class: 'text-2' }, t('alarm.emptyBody')),
      h('button', { type: 'button', class: 'btn primary', onclick: () => this.openEditor() }, icon('add'), t('alarm.add')),
    );
    this.note = h('div', { class: 'ck-note' });
    this.cmd = commandBar(h, [
      { icon: icon('edit'), label: t('alarm.edit'), className: 'ck-cmd-edit', ref: (el) => (this.editBtn = el), onclick: () => this.setEditing(!this.editing) },
      { icon: icon('add'), label: t('alarm.add'), text: t('timer.addShort'), className: 'ck-cmd-add', onclick: () => this.openEditor() },
    ], { title: t('nav.alarm') });
    this.el = h('section', { class: 'ck-alarms' }, this.cmd, this.note, this.grid, this.empty);
    this.render();
    return this.el;
  }

  show() {
    this.render();
  }

  setEditing(on) {
    this.editing = !!on && this.store.alarms.length > 0;
    this.el.classList.toggle('editing', this.editing);
    const { t, icon } = this.app;
    this.editBtn.replaceChildren(icon(this.editing ? 'checkmark' : 'edit'));
    this.editBtn.dataset.tip = this.editing ? t('common.done') : t('alarm.edit');
    this.editBtn.setAttribute('aria-label', this.editBtn.dataset.tip);
    this.editBtn.classList.toggle('primary', this.editing);
    this.editBtn.classList.toggle('subtle', !this.editing);
  }

  renderNote() {
    const { h, t, icon, shell } = this.app;
    const n = this.app.ctx.settings.get('notifications') || {};
    let text = t('alarm.noteAwake');
    let cls = '';
    if (n.enabled === false) {
      text = t('alarm.noteNotifOff');
      cls = 'warn';
    } else if (n.dnd) {
      // alarms and timers ring through Do not disturb (urgent notifications): just say so
      text = t('alarm.noteDnd');
    }
    this.note.className = `ck-note ${cls}`;
    this.note.replaceChildren(
      icon(cls ? 'warning' : 'info', { size: 16 }),
      h('span', { class: 'grow' }, text),
      h('button', { type: 'button', class: 'btn subtle small', onclick: () => shell.launch('settings', { page: 'notifications' }) }, t('alarm.notifSettings')),
    );
  }

  render() {
    if (!this.el) return;
    this.renderNote();
    const alarms = this.store.alarms;
    const ids = new Set(alarms.map((a) => a.id));
    for (const [id, c] of this.cards) {
      if (!ids.has(id)) {
        c.el.remove();
        this.cards.delete(id);
      }
    }
    alarms.forEach((a, i) => {
      let c = this.cards.get(a.id);
      if (!c) {
        c = this.makeCard(a);
        this.cards.set(a.id, c);
      }
      this.fillCard(c, a);
      if (this.grid.children[i] !== c.el) this.grid.insertBefore(c.el, this.grid.children[i] || null);
    });
    this.empty.hidden = alarms.length > 0;
    this.grid.hidden = alarms.length === 0;
    if (!alarms.length && this.editing) this.setEditing(false);
    this.tick(Date.now());
  }

  makeCard(a) {
    const { h, icon, ui, t } = this.app;
    const c = {};
    c.time = h('span', { class: 'ck-alarm-clock' });
    c.period = h('span', { class: 'ck-alarm-period' });
    c.toggle = ui.toggle({ checked: a.enabled, onchange: (on) => this.store.setAlarmEnabled(a.id, on) });
    c.toggle.classList.add('ck-alarm-toggle');
    c.toggle.input.setAttribute('aria-label', t('alarm.toggle'));
    c.toggle.addEventListener('click', (e) => e.stopPropagation());
    c.del = h(
      'button',
      { type: 'button', class: 'btn subtle icon-btn ck-card-del', 'aria-label': t('alarm.delete'), 'data-tip': t('alarm.delete'), onclick: (e) => (e.stopPropagation(), this.store.deleteAlarm(a.id)) },
      icon('delete'),
    );
    c.when = h('span', { class: 'ck-alarm-when-text' });
    c.name = h('span', { class: 'ck-alarm-name-text ellipsis' });
    c.days = h('div', { class: 'ck-alarm-days' });
    c.sound = h('span', { class: 'ellipsis' });
    c.snooze = h('span', { class: 'ellipsis' });
    c.el = h(
      'div',
      {
        class: 'card ck-card ck-alarm',
        role: 'listitem',
        tabindex: '0',
        dataset: { id: a.id },
        onclick: () => this.openEditor(this.store.alarms.find((x) => x.id === a.id)),
        onkeydown: (e) => {
          if (e.target !== c.el) return;
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            this.openEditor(this.store.alarms.find((x) => x.id === a.id));
          } else if (e.key === 'Delete') {
            e.preventDefault();
            this.store.deleteAlarm(a.id);
          }
        },
        oncontextmenu: (e) => this.menu(e, a.id),
      },
      h('div', { class: 'ck-alarm-top' }, h('div', { class: 'ck-alarm-timebox' }, c.time, c.period), c.toggle, c.del),
      h('div', { class: 'ck-alarm-when caption' }, icon('alert', { size: 14 }), c.when),
      h('div', { class: 'ck-alarm-name' }, icon('tag', { size: 14 }), c.name),
      c.days,
      h('div', { class: 'ck-alarm-meta caption text-2' }, h('span', { class: 'ck-meta' }, icon('speaker_2', { size: 14 }), c.sound), h('span', { class: 'ck-meta' }, icon('alert_snooze', { size: 14 }), c.snooze)),
    );
    enter(c.el, { y: 12 });
    return c;
  }

  fillCard(c, a) {
    const { t, lang, locale } = this.app;
    const tp = wallTime(a.hour, a.minute, { locale, h12: this.app.h12 });
    c.time.textContent = tp.main;
    c.period.textContent = tp.period;
    c.toggle.input.checked = a.enabled;
    c.el.classList.toggle('off', !a.enabled);
    c.name.textContent = this.store.alarmTitle(a);
    const names = weekdayNames(locale, 'short');
    const long = weekdayNames(locale, 'long');
    const order = weekOrder(locale);
    c.days.replaceChildren();
    if (!a.days.length) c.days.appendChild(this.app.h('span', { class: 'ck-chip once' }, t('alarm.once')));
    else if (a.days.length === 7) c.days.appendChild(this.app.h('span', { class: 'ck-chip on' }, t('alarm.everyDay')));
    else for (const d of order) c.days.appendChild(this.app.h('span', { class: ['ck-chip', a.days.includes(d) && 'on'], title: long[d] }, names[d]));
    c.sound.textContent = toneById(a.sound).name[lang] || toneById(a.sound).name.en;
    c.snooze.textContent = a.snooze ? t('alarm.snoozeMin', { n: a.snooze }) : t('alarm.snoozeOff');
    c.el.setAttribute('aria-label', `${tp.full}, ${this.store.alarmTitle(a)}, ${a.enabled ? t('common.on') : t('common.off')}`);
    c.alarm = a;
  }

  tick(now) {
    const { t } = this.app;
    for (const c of this.cards.values()) {
      const a = c.alarm;
      if (!a) continue;
      // a ring snoozed from the notification counts as "on": the toggle turns it off (cancels the snooze)
      const snoozed = this.store.snoozedUntil(a, now);
      const text = snoozed ? t('alarm.snoozedUntil', { time: this.app.timeText(snoozed) }) : a.enabled && a.at ? ringsIn(t, a.at - now) : t('alarm.offText');
      if (c.when.textContent !== text) c.when.textContent = text;
      const on = a.enabled || !!snoozed;
      if (c.toggle.input.checked !== on) c.toggle.input.checked = on;
      c.el.classList.toggle('off', !on);
      c.el.classList.toggle('snoozed', !!snoozed);
    }
  }

  wantsFrames() {
    return false;
  }

  onStore(kind, extra) {
    if (kind === 'alarms' || kind === 'all' || kind === 'notifications') this.render();
    if (kind === 'alarms' && extra?.fired) this.highlight(extra.fired);
  }

  highlight(id) {
    const c = this.cards.get(id);
    if (!c) return;
    c.el.scrollIntoView({ block: 'nearest' });
    c.el.classList.remove('flash');
    void c.el.offsetWidth;
    c.el.classList.add('flash');
  }

  menu(e, id) {
    const { t, ui } = this.app;
    const a = this.store.alarms.find((x) => x.id === id);
    if (!a) return;
    ui.menu(e, [
      { label: t('alarm.editOne'), icon: 'edit', action: () => this.openEditor(a) },
      { label: a.enabled ? t('alarm.turnOff') : t('alarm.turnOn'), icon: a.enabled ? 'alert_off' : 'alert_on', action: () => this.store.setAlarmEnabled(id, !a.enabled) },
      '-',
      { label: t('alarm.delete'), icon: 'delete', danger: true, action: () => this.store.deleteAlarm(id) },
    ]);
  }

  onKey(e) {
    if ((e.ctrlKey && e.key.toLowerCase() === 'n') || (e.key === 'Insert' && !e.ctrlKey)) {
      this.openEditor();
      return true;
    }
    return false;
  }

  /** Add (no alarm) or edit dialog. Resolves to the saved alarm, 'deleted' or null. */
  async openEditor(a = null) {
    if (this.dialogOpen) return null;
    const { h, t, icon, ui, win, locale, lang } = this.app;
    if (!a && this.store.alarms.length >= MAX_ALARMS) {
      this.dialogOpen = true;
      await ui.alert(t('alarm.limit', { n: MAX_ALARMS }), { title: t('alarm.addTitle'), parent: win });
      this.dialogOpen = false;
      return null;
    }
    // a new alarm starts at the next quarter hour
    const now = new Date(Math.ceil((Date.now() + 60000) / 900000) * 900000);
    const init = a || { hour: now.getHours(), minute: now.getMinutes(), name: '', days: [], sound: this.store.prefs.sound, snooze: this.store.prefs.snooze };
    const periods = (() => {
      const am = wallTime(9, 0, { locale, h12: true }).period || 'AM';
      const pm = wallTime(21, 0, { locale, h12: true }).period || 'PM';
      return [am, pm];
    })();
    let picked = { hour: init.hour, minute: init.minute };
    const preview = h('div', { class: 'ck-dlg-preview caption text-2', 'aria-live': 'polite' });
    const picker = timePicker({ h, icon, t, hour: init.hour, minute: init.minute, h12: this.app.h12, periods, onchange: (v) => ((picked = v), refresh()) });
    const name = h('input', { class: 'input grow', type: 'text', maxlength: 64, value: a ? a.name : '', placeholder: t('alarm.namePlaceholder'), 'aria-label': t('alarm.name') });
    const repeat = h('input', { type: 'checkbox', checked: init.days.length > 0 });
    const daysEl = dayToggles({ h, order: weekOrder(locale), names: weekdayNames(locale, 'short'), longNames: weekdayNames(locale, 'long'), days: init.days, onchange: (d) => {
      if (d.length && !repeat.checked) repeat.checked = true;
      refresh();
    } });
    repeat.addEventListener('change', () => {
      if (repeat.checked && !daysEl.get().length) daysEl.set([0, 1, 2, 3, 4, 5, 6]);
      if (!repeat.checked) daysEl.set([]);
      refresh();
    });
    const sound = ui.select({ options: TONES.map((x) => ({ value: x.id, label: x.name[lang] || x.name.en })), value: init.sound });
    sound.setAttribute('aria-label', t('alarm.sound'));
    sound.classList.add('grow');
    const play = h('button', { type: 'button', class: 'btn icon-btn', 'aria-label': t('alarm.preview'), 'data-tip': t('alarm.preview'), onclick: () => this.preview(sound.value) }, icon('play'));
    const snooze = ui.select({ options: SNOOZE_CHOICES.map((n) => ({ value: n, label: n ? t('alarm.snoozeMin', { n }) : t('alarm.snoozeOff') })), value: init.snooze });
    snooze.setAttribute('aria-label', t('alarm.snooze'));
    snooze.classList.add('grow');
    const refresh = () => {
      const days = repeat.checked ? daysEl.get() : [];
      const at = nextAlarmOccurrence({ hour: picked.hour, minute: picked.minute, days }, Date.now());
      preview.textContent = at ? ringsIn(t, at - Date.now()) : '';
    };
    const body = h(
      'div',
      { class: 'ck-dlg ck-dlg-alarm' },
      picker,
      preview,
      h('div', { class: 'ck-dlg-row' }, icon('edit', { size: 16 }), name),
      h('label', { class: 'checkbox ck-dlg-check' }, repeat, h('span', null, t('alarm.repeat'))),
      daysEl,
      h('div', { class: 'ck-dlg-row' }, icon('speaker_2', { size: 16 }), sound, play),
      h('div', { class: 'ck-dlg-row' }, icon('alert_snooze', { size: 16 }), snooze),
    );
    refresh();
    this.dialogOpen = true;
    let deleted = false;
    const res = await this.app.dialog({
      title: a ? t('alarm.editTitle') : t('alarm.addTitle'),
      body,
      buttons: [
        { label: t('common.save'), value: 'save', primary: true },
        { label: t('common.cancel'), value: null },
      ],
      onOpen: (dlg, done) => {
        if (a) {
          const del = h(
            'button',
            { type: 'button', class: 'btn subtle icon-btn ck-dlg-del', 'aria-label': t('alarm.delete'), 'data-tip': t('alarm.delete'), onclick: () => ((deleted = true), done('delete')) },
            icon('delete'),
          );
          dlg.querySelector('.dialog-body').appendChild(del);
        }
        setTimeout(() => picker.spins.hour.focus(), 40);
      },
    });
    this.dialogOpen = false;
    if (res === 'delete' && deleted && a) {
      this.store.deleteAlarm(a.id);
      return 'deleted';
    }
    if (res !== 'save') return null;
    const fields = { hour: picked.hour, minute: picked.minute, name: name.value.trim(), days: repeat.checked ? daysEl.get() : [], sound: sound.value, snooze: Number(snooze.value) };
    const saved = a ? this.store.updateAlarm(a.id, { ...fields, enabled: true }) : this.store.addAlarm(fields);
    if (saved) setTimeout(() => this.highlight(saved.id), 50);
    return saved;
  }

  preview(id) {
    const p = toneById(id).pattern;
    this.app.shell.sounds?.play?.(p || 'alarm');
  }

  destroy() {}
}
