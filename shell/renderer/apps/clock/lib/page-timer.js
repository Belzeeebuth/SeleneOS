// Clock — Timer page: a calm list of timers (one row each: name, time left, a slim progress line,
// play / pause, reset, +1 min), a page header with "Add" and a small "Quick timers" menu, the expanded
// (big) view with its progress ring, the add / edit dialog with an hh:mm:ss wheel picker, edit mode.
import { hms, MIN } from './time.js';
import { progressRing, durationPicker, commandBar, enter, reduceMotion } from './widgets.js';
import { MAX_TIMERS } from './store.js';

const PRESETS = [1, 3, 5, 10, 15, 30];

export class TimerPage {
  constructor(app) {
    this.app = app;
    this.editing = false;
    this.cards = new Map();
    this.expanded = null;
  }

  get store() {
    return this.app.store;
  }

  build() {
    const { h, t, icon } = this.app;
    this.grid = h('div', { class: 'ck-timer-list', role: 'list' });
    this.empty = h(
      'div',
      { class: 'empty ck-empty', hidden: true },
      icon('hourglass_half', { size: 48 }),
      h('div', { class: 'subtitle' }, t('timer.emptyTitle')),
      h('div', { class: 'text-2' }, t('timer.emptyBody')),
    );
    this.cmd = commandBar(
      h,
      [
        { icon: icon('timer'), label: t('timer.quick'), text: t('timer.quick'), className: 'ck-presets-btn', menu: true, onclick: (e) => this.presetMenu(e) },
        { icon: icon('edit'), label: t('timer.edit'), className: 'ck-cmd-edit', ref: (el) => (this.editBtn = el), onclick: () => this.setEditing(!this.editing) },
        { icon: icon('add'), label: t('timer.add'), text: t('timer.addShort'), className: 'ck-cmd-add', onclick: () => this.openEditor() },
      ],
      { title: t('nav.timer') },
    );
    this.big = h('div', { class: 'ck-timer-big', hidden: true, role: 'dialog', 'aria-modal': 'false' });
    this.el = h('section', { class: 'ck-timers' }, this.cmd, this.grid, this.empty, this.big);
    this.render();
    return this.el;
  }

  show() {
    this.render();
  }

  hide() {
    if (this.expanded) this.collapse();
  }

  setEditing(on) {
    this.editing = !!on && this.store.timers.length > 0;
    this.el.classList.toggle('editing', this.editing);
    const { t, icon } = this.app;
    this.editBtn.replaceChildren(icon(this.editing ? 'checkmark' : 'edit'));
    this.editBtn.dataset.tip = this.editing ? t('common.done') : t('timer.edit');
    this.editBtn.setAttribute('aria-label', this.editBtn.dataset.tip);
    this.editBtn.classList.toggle('primary', this.editing);
    this.editBtn.classList.toggle('subtle', !this.editing);
  }

  render() {
    if (!this.el) return;
    const list = this.store.timers;
    const ids = new Set(list.map((x) => x.id));
    for (const [id, c] of this.cards) {
      if (!ids.has(id)) {
        c.el.remove();
        this.cards.delete(id);
      }
    }
    list.forEach((x, i) => {
      let c = this.cards.get(x.id);
      if (!c) {
        c = this.makeCard(x);
        this.cards.set(x.id, c);
      }
      this.fill(c, x);
      if (this.grid.children[i] !== c.el) this.grid.insertBefore(c.el, this.grid.children[i] || null);
    });
    this.empty.hidden = list.length > 0;
    this.grid.hidden = list.length === 0;
    if (!list.length && this.editing) this.setEditing(false);
    if (this.expanded && !ids.has(this.expanded)) this.collapse();
    if (this.expanded) this.fillBig();
    this.tick(Date.now());
  }

  // one card (also used for the expanded view with big = true)
  makeCard(x, big = false) {
    const { h, t, icon } = this.app;
    const c = { id: x.id, big };
    if (big) c.ring = progressRing({ stroke: 2 });
    else {
      // slim progress line under the row (scaleX only: cheap to animate)
      const fill = h('div', { class: 'ck-line-fill' });
      c.ring = h('div', { class: 'ck-line', 'aria-hidden': 'true' }, fill);
      c.ring.set = (frac) => (fill.style.transform = `scaleX(${Math.max(0, Math.min(1, frac))})`);
    }
    c.time = h('div', { class: 'ck-timer-time', role: 'timer', 'aria-live': 'off' });
    c.sub = h('div', { class: 'ck-timer-sub caption text-2' });
    c.name = h('div', { class: 'ck-timer-name ellipsis' });
    c.play = h('button', { type: 'button', class: ['btn', big ? 'primary' : 'subtle', 'ck-round', 'ck-timer-play'], onclick: (e) => (e.stopPropagation(), this.toggle(x.id)) });
    c.reset = h('button', { type: 'button', class: 'btn ck-round ck-timer-reset', 'aria-label': t('timer.reset'), 'data-tip': t('timer.reset'), onclick: (e) => (e.stopPropagation(), this.store.resetTimer(x.id)) }, icon('arrow_reset'));
    c.plus = h('button', { type: 'button', class: 'btn subtle ck-timer-plus', 'aria-label': t('timer.plusOne'), 'data-tip': t('timer.plusOne'), onclick: (e) => (e.stopPropagation(), this.store.addMinute(x.id)) }, t('timer.plusOneShort'));
    const expandBtn = big
      ? h('button', { type: 'button', class: 'btn subtle icon-btn ck-timer-expand', 'aria-label': t('timer.collapse'), 'data-tip': t('timer.collapse'), onclick: () => this.collapse() }, icon('full_screen_minimize'))
      : h('button', { type: 'button', class: 'btn subtle icon-btn ck-timer-expand', 'aria-label': t('timer.expand'), 'data-tip': t('timer.expand'), onclick: (e) => (e.stopPropagation(), this.expand(x.id)) }, icon('full_screen_maximize'));
    const del = big
      ? null
      : h('button', { type: 'button', class: 'btn subtle icon-btn ck-card-del', 'aria-label': t('timer.delete'), 'data-tip': t('timer.delete'), onclick: (e) => (e.stopPropagation(), this.store.deleteTimer(x.id)) }, icon('delete'));
    const dial = big ? h('div', { class: 'ck-timer-dial' }, c.ring, h('div', { class: 'ck-timer-center' }, c.time, c.sub)) : null;
    if (!big) {
      c.time.addEventListener('click', (e) => {
        if (this.editing) return;
        e.stopPropagation();
        const cur = this.store.timers.find((tm) => tm.id === x.id);
        if (cur) this.openEditor(cur);
      });
    }
    c.el = h(
      'div',
      {
        class: ['card', 'ck-card', 'ck-timer', big && 'big'],
        role: big ? null : 'listitem',
        tabindex: big ? null : '0',
        dataset: { id: x.id },
        onclick: () => {
          if (!big && this.editing) this.openEditor(this.store.timers.find((tm) => tm.id === x.id));
        },
        onkeydown: (e) => {
          if (big || e.target !== c.el) return;
          if (e.key === 'Enter') {
            e.preventDefault();
            this.openEditor(this.store.timers.find((tm) => tm.id === x.id));
          } else if (e.key === ' ') {
            e.preventDefault();
            this.toggle(x.id);
          } else if (e.key === 'Delete') {
            e.preventDefault();
            this.store.deleteTimer(x.id);
          }
        },
        oncontextmenu: big ? null : (e) => this.menu(e, x.id),
      },
      ...(big
        ? [h('div', { class: 'ck-timer-head' }, c.name, expandBtn, del), dial, h('div', { class: 'ck-timer-actions' }, c.play, c.reset, c.plus)]
        : [
            c.play,
            h('div', { class: 'ck-timer-label' }, c.name, c.sub),
            c.time,
            h('div', { class: 'ck-timer-actions' }, c.reset, c.plus, expandBtn, del),
            c.ring,
          ]),
    );
    if (!big) enter(c.el, { y: 6 });
    return c;
  }

  fill(c, x) {
    const { t, icon } = this.app;
    c.timer = x;
    c.name.textContent = this.store.timerTitle(x);
    c.el.classList.remove('state-idle', 'state-running', 'state-paused', 'state-done');
    c.el.classList.add(`state-${x.state}`);
    const running = x.state === 'running';
    const label = running ? t('timer.pause') : x.state === 'done' ? t('timer.restart') : x.state === 'paused' ? t('timer.resume') : t('timer.start');
    const ic = running ? 'pause' : x.state === 'done' ? 'arrow_counterclockwise' : 'play';
    if (c.play.dataset.icon !== ic) {
      c.play.replaceChildren(icon(ic, { filled: c.big || ic !== 'arrow_counterclockwise' }));
      c.play.dataset.icon = ic;
    }
    c.play.setAttribute('aria-label', label);
    c.play.dataset.tip = label;
    c.reset.disabled = x.state === 'idle';
    c.el.setAttribute('aria-label', `${this.store.timerTitle(x)}, ${hms(x.duration)}`);
  }

  tick(now) {
    for (const c of this.cards.values()) this.tickCard(c, now);
    if (this.bigCard) this.tickCard(this.bigCard, now);
  }

  tickCard(c, now) {
    const x = c.timer;
    if (!x) return;
    const { t } = this.app;
    const rem = this.store.remainingOf(x, now);
    const txt = hms(rem);
    if (c.time.textContent !== txt) c.time.textContent = txt;
    // with animations off the ring moves once a second
    const frac = this.store.progressOf(x, reduceMotion() ? now - (now % 1000) : now);
    c.ring.set(frac);
    let sub = '';
    if (x.state === 'running') sub = t('timer.endsAt', { time: this.app.timeText(x.endAt) });
    else if (x.state === 'paused') sub = t('timer.paused');
    else if (x.state === 'done') sub = t('timer.doneShort');
    if (c.sub.textContent !== sub) c.sub.textContent = sub;
  }

  wantsFrames() {
    return !reduceMotion() && this.store.timers.some((x) => x.state === 'running');
  }

  onStore(kind, extra) {
    if (kind !== 'timers' && kind !== 'all') return;
    if (kind === 'all') {
      this.render();
      return;
    }
    this.render();
    if (extra?.fired) this.highlight(extra.fired);
  }

  toggle(id) {
    const x = this.store.timers.find((tm) => tm.id === id);
    if (!x) return;
    if (x.state === 'running') this.store.pauseTimer(id);
    else this.store.startTimer(id);
  }

  quickStart(m) {
    const ms = m * MIN;
    // a double click on a preset starts one timer, not two
    const last = this._lastQuick;
    if (last && last.m === m && Date.now() - last.at < 600 && this.store.timers.some((tm) => tm.id === last.id && tm.state === 'running')) {
      this.highlight(last.id);
      return this.store.timers.find((tm) => tm.id === last.id);
    }
    // reuse an idle timer of that length instead of piling up duplicates
    let x = this.store.timers.find((tm) => tm.duration === ms && tm.state === 'idle' && !tm.name);
    if (!x) x = this.store.addTimer({ name: '', duration: ms });
    if (!x) {
      this.limitAlert();
      return null;
    }
    this.store.startTimer(x.id);
    this._lastQuick = { m, id: x.id, at: Date.now() };
    setTimeout(() => this.highlight(x.id), 30);
    return x;
  }

  /** "Quick timers" menu: 1 … 30 min start at once; "Custom" opens the editor. */
  presetMenu(e) {
    const { t, ui } = this.app;
    // anchored under the button (an Element also works from the keyboard)
    ui.menu(e.currentTarget, [
      ...PRESETS.map((m) => ({ label: t('timer.presetLabel', { n: m }), icon: 'play', action: () => this.quickStart(m) })),
      '-',
      { label: t('timer.custom'), icon: 'add', action: () => this.openEditor() },
    ]);
  }

  highlight(id) {
    const c = this.cards.get(id);
    if (!c) return;
    c.el.scrollIntoView({ block: 'nearest' });
    c.el.classList.remove('flash');
    void c.el.offsetWidth;
    c.el.classList.add('flash');
  }

  expand(id) {
    const x = this.store.timers.find((tm) => tm.id === id);
    if (!x) return;
    this.expanded = id;
    this.fillBig();
    this.big.hidden = false;
    this.el.classList.add('has-big');
    if (!reduceMotion()) this.big.animate([{ opacity: 0, transform: 'scale(0.96)' }, { opacity: 1, transform: 'none' }], { duration: 250, easing: 'cubic-bezier(0.1, 0.9, 0.2, 1)' });
    this.big.querySelector('.ck-timer-play')?.focus();
    this.app.kick();
  }

  fillBig() {
    const x = this.store.timers.find((tm) => tm.id === this.expanded);
    if (!x) return;
    if (!this.bigCard || this.bigCard.id !== x.id) {
      this.bigCard = this.makeCard(x, true);
      this.big.replaceChildren(this.bigCard.el);
    }
    this.fill(this.bigCard, x);
    this.tickCard(this.bigCard, Date.now());
  }

  collapse() {
    const id = this.expanded;
    this.expanded = null;
    this.bigCard = null;
    this.big.hidden = true;
    this.big.replaceChildren();
    this.el.classList.remove('has-big');
    if (id) this.cards.get(id)?.el.focus();
  }

  menu(e, id) {
    const { t, ui } = this.app;
    const x = this.store.timers.find((tm) => tm.id === id);
    if (!x) return;
    ui.menu(e, [
      { label: x.state === 'running' ? t('timer.pause') : t('timer.start'), icon: x.state === 'running' ? 'pause' : 'play', action: () => this.toggle(id) },
      { label: t('timer.reset'), icon: 'arrow_reset', disabled: x.state === 'idle', action: () => this.store.resetTimer(id) },
      { label: t('timer.plusOne'), icon: 'add', action: () => this.store.addMinute(id) },
      { label: t('timer.expand'), icon: 'full_screen_maximize', action: () => this.expand(id) },
      { label: t('timer.editOne'), icon: 'edit', action: () => this.openEditor(x) },
      '-',
      { label: t('timer.delete'), icon: 'delete', danger: true, action: () => this.store.deleteTimer(id) },
    ]);
  }

  onKey(e) {
    if (e.key === 'Escape' && this.expanded) {
      this.collapse();
      return true;
    }
    if (e.ctrlKey && e.key.toLowerCase() === 'n') {
      this.openEditor();
      return true;
    }
    return false;
  }

  async limitAlert() {
    const { t, ui, win } = this.app;
    if (this.dialogOpen) return;
    this.dialogOpen = true;
    await ui.alert(t('timer.limit', { n: MAX_TIMERS }), { title: t('timer.addTitle'), parent: win });
    this.dialogOpen = false;
  }

  async openEditor(x = null) {
    if (this.dialogOpen) return null;
    const { h, t, icon, ui, win } = this.app;
    if (!x && this.store.timers.length >= MAX_TIMERS) {
      await this.limitAlert();
      return null;
    }
    const picker = durationPicker({ h, icon, t, ms: x ? x.duration : 15 * MIN, onchange: () => check() });
    const name = h('input', { class: 'input grow', type: 'text', maxlength: 64, value: x ? x.name : '', placeholder: t('timer.namePlaceholder'), 'aria-label': t('timer.name') });
    const err = h('div', { class: 'ck-dlg-err caption', role: 'alert' });
    const chips = h(
      'div',
      { class: 'ck-dlg-presets' },
      PRESETS.map((m) => h('button', { type: 'button', class: 'btn small ck-preset', onclick: () => (picker.set(m * MIN), check()) }, t('timer.presetLabel', { n: m }))),
    );
    const check = () => {
      const ok = picker.get() >= 1000;
      err.textContent = ok ? '' : t('timer.tooShort');
      return ok;
    };
    const body = h('div', { class: 'ck-dlg ck-dlg-timer' }, picker, chips, h('div', { class: 'ck-dlg-row' }, icon('edit', { size: 16 }), name), err);
    this.dialogOpen = true;
    const res = await this.app.dialog({
      title: x ? t('timer.editTitle') : t('timer.addTitle'),
      body,
      buttons: [
        { label: t('common.save'), value: 'save', primary: true },
        { label: t('common.cancel'), value: null },
      ],
      onOpen: (dlg, done) => {
        dlg._validate = (v) => (v === 'save' ? check() : true);
        if (x) {
          dlg.querySelector('.dialog-body').appendChild(
            h('button', { type: 'button', class: 'btn subtle icon-btn ck-dlg-del', 'aria-label': t('timer.delete'), 'data-tip': t('timer.delete'), onclick: () => done('delete') }, icon('delete')),
          );
        }
        setTimeout(() => picker.querySelectorAll('.ck-spin')[1]?.focus(), 40);
      },
    });
    this.dialogOpen = false;
    if (res === 'delete' && x) {
      this.store.deleteTimer(x.id);
      return 'deleted';
    }
    if (res !== 'save') return null;
    const fields = { name: name.value.trim(), duration: picker.get() };
    const saved = x ? this.store.updateTimer(x.id, fields) : this.store.addTimer(fields);
    if (saved) setTimeout(() => this.highlight(saved.id), 40);
    return saved;
  }

  destroy() {}
}
