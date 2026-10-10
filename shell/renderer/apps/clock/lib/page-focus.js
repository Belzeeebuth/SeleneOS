// Clock — Focus sessions: pick a duration (15–240 min) with automatic breaks, big circular timer with
// the session timeline, pause / resume / stop / skip break, optional Do not disturb for the session
// (restored at the end), daily goal ring, streak, yesterday, and today's sessions.
import { MIN, hms, dayKey, addDays, minutesText } from './time.js';
import { planSegments, FOCUS_MIN, FOCUS_MAX } from './store.js';
import { progressRing, spinner, enter, reduceMotion } from './widgets.js';

const GOALS = [15, 30, 45, 60, 90, 120, 180, 240, 300, 360, 480];

export class FocusPage {
  constructor(app) {
    this.app = app;
    this.mode = null;
  }

  get store() {
    return this.app.store;
  }

  build() {
    const { h } = this.app;
    this.main = h('div', { class: 'card ck-focus-main' });
    this.progress = h('div', { class: 'card ck-focus-progress' });
    this.logCard = h('div', { class: 'card ck-focus-log' });
    this.el = h('section', { class: 'ck-focus' }, h('div', { class: 'ck-focus-grid' }, this.main, h('div', { class: 'ck-focus-side' }, this.progress, this.logCard)));
    this.buildProgress();
    this.render();
    return this.el;
  }

  show() {
    this.render();
  }

  modeNow() {
    const f = this.store.focus;
    if (f.session) return 'run';
    if (f.last && !f.last.seen) return 'done';
    return 'idle';
  }

  render() {
    if (!this.el) return;
    const mode = this.modeNow();
    if (mode !== this.mode) {
      this.mode = mode;
      this.main.replaceChildren();
      if (mode === 'idle') this.buildIdle();
      else if (mode === 'run') this.buildRun();
      else this.buildDone();
      enter(this.main.firstChild, { y: 10 });
    }
    if (mode === 'run') this.fillRun();
    if (mode === 'idle') this.fillIdle();
    this.fillProgress();
    this.renderLog();
    this.tick(Date.now());
  }

  // ------------------------------------------------------------------ idle: "Get ready to focus"
  buildIdle() {
    const { h, t, icon } = this.app;
    const f = this.store.prefs.focus;
    const values = [];
    for (let m = FOCUS_MIN; m <= FOCUS_MAX; m += 5) values.push({ value: m, label: String(m), text: minutesText(t, m) });
    this.minSpin = spinner({
      h,
      icon,
      values,
      value: f.minutes,
      wrap: false,
      label: t('focus.duration'),
      pageStep: 3,
      className: 'ck-focus-spin',
      tipUp: t('picker.increase'),
      tipDown: t('picker.decrease'),
      onchange: (v) => {
        this.store.setPref('focus.minutes', v);
        this.fillIdle();
      },
    });
    this.skip = h('input', { type: 'checkbox', checked: f.skipBreaks, onchange: () => (this.store.setPref('focus.skipBreaks', this.skip.checked), this.fillIdle()) });
    this.breaksText = h('div', { class: 'ck-focus-breaks text-2' });
    this.startBtn = h('button', { type: 'button', class: 'btn primary large ck-focus-start', onclick: () => this.start() }, icon('play', { filled: true }), t('focus.start'));
    this.main.appendChild(
      h(
        'div',
        { class: 'ck-focus-idle' },
        h('div', { class: 'subtitle' }, t('focus.ready')),
        h('div', { class: 'text-2 ck-focus-intro' }, t('focus.intro')),
        h('div', { class: 'ck-focus-pick' }, this.minSpin, h('div', { class: 'ck-focus-unit text-2' }, t('focus.mins'))),
        this.breaksText,
        h('label', { class: 'checkbox' }, this.skip, h('span', null, t('focus.skipBreaks'))),
        this.startBtn,
      ),
    );
  }

  fillIdle() {
    if (!this.breaksText) return;
    const { t } = this.app;
    const f = this.store.prefs.focus;
    // follow changes made elsewhere (Settings page, another window)
    if (this.minSpin && this.minSpin.value !== f.minutes) this.minSpin.setValue(f.minutes);
    if (this.skip && this.skip.checked !== f.skipBreaks) this.skip.checked = f.skipBreaks;
    const segs = planSegments(this.minSpin?.value ?? f.minutes, f.chunk, f.brk, this.skip?.checked);
    const n = segs.filter((g) => g.type === 'break').length;
    this.breaksText.textContent = n ? t('focus.breaks', { count: n, len: f.brk }) : t('focus.noBreaks');
  }

  async start() {
    const { t, ui, win, h, ctx } = this.app;
    const f = this.store.prefs.focus;
    let dnd = false;
    const dndOn = !!ctx.settings.get('notifications.dnd');
    if (!dndOn && f.dnd === 'always') dnd = true;
    else if (!dndOn && f.dnd === 'ask') {
      const remember = h('input', { type: 'checkbox' });
      const v = await ui.dialog({
        title: t('focus.dndTitle'),
        body: h('div', { class: 'ck-dlg' }, h('div', null, t('focus.dndBody')), h('label', { class: 'checkbox' }, remember, h('span', null, t('focus.dndRemember')))),
        parent: win,
        className: 'ck-dialog',
        buttons: [
          { label: t('focus.dndYes'), value: 'yes', primary: true },
          { label: t('focus.dndNo'), value: 'no' },
        ],
      });
      if (v == null) return; // Esc: don't start
      dnd = v === 'yes';
      if (remember.checked) this.store.setPref('focus.dnd', dnd ? 'always' : 'never');
    }
    await this.store.startFocus({ minutes: this.minSpin?.value ?? f.minutes, skipBreaks: this.skip?.checked, dnd });
  }

  // ------------------------------------------------------------------ running session
  buildRun() {
    const { h, t, icon } = this.app;
    this.ring = progressRing({ stroke: 2.4, className: 'ck-focus-ring' });
    this.phase = h('div', { class: 'ck-focus-phase body-strong' });
    this.left = h('div', { class: 'ck-focus-left', role: 'timer' });
    this.leftSub = h('div', { class: 'ck-focus-leftsub caption text-2' });
    this.next = h('div', { class: 'ck-focus-next caption text-2' });
    this.bar = h('div', { class: 'ck-focus-bar', 'aria-hidden': 'true' });
    this.pauseBtn = h('button', { type: 'button', class: 'btn primary ck-round big ck-focus-pause', onclick: () => this.togglePause() });
    this.stopBtn = h('button', { type: 'button', class: 'btn ck-round big ck-focus-stop', 'aria-label': t('focus.stop'), 'data-tip': t('focus.stop'), onclick: () => this.stop() }, icon('stop', { filled: true }));
    this.skipBtn = h('button', { type: 'button', class: 'btn ck-focus-skip', onclick: () => this.store.skipBreak() }, icon('next', { size: 16 }), t('focus.skipBreak'));
    this.main.appendChild(
      h(
        'div',
        { class: 'ck-focus-run' },
        this.phase,
        h('div', { class: 'ck-focus-dial' }, this.ring, h('div', { class: 'ck-focus-center' }, this.left, this.leftSub)),
        this.bar,
        this.next,
        h('div', { class: 'ck-focus-actions' }, this.pauseBtn, this.stopBtn, this.skipBtn),
      ),
    );
    this.barKey = '';
  }

  fillRun() {
    const { t, icon } = this.app;
    const s = this.store.focus.session;
    if (!s || !this.pauseBtn) return;
    const paused = s.state === 'paused';
    const ic = paused ? 'play' : 'pause';
    if (this.pauseBtn.dataset.icon !== ic) {
      this.pauseBtn.replaceChildren(icon(ic, { filled: true }));
      this.pauseBtn.dataset.icon = ic;
    }
    const label = paused ? t('focus.resume') : t('focus.pause');
    this.pauseBtn.setAttribute('aria-label', label);
    this.pauseBtn.dataset.tip = label;
    this.main.classList.toggle('paused', paused);
    // session timeline: one block per period, width proportional to its length
    const key = s.segs.map((g) => `${g.type}${g.ms}`).join();
    if (key !== this.barKey) {
      this.barKey = key;
      const total = this.store.focusTotal();
      this.bar.replaceChildren(
        ...s.segs.map((g) => {
          const el = this.app.h('div', { class: `ck-focus-seg ${g.type}`, style: { flexGrow: String(g.ms / total) } }, this.app.h('div', { class: 'fill' }));
          return el;
        }),
      );
    }
  }

  togglePause() {
    const s = this.store.focus.session;
    if (!s) return;
    if (s.state === 'paused') this.store.resumeFocus();
    else this.store.pauseFocus();
  }

  async stop() {
    const { t, ui, win } = this.app;
    const ok = await ui.confirm(t('focus.stopBody'), { title: t('focus.stopTitle'), okLabel: t('focus.stopOk'), parent: win });
    if (ok) await this.store.stopFocus({ completed: false });
  }

  // ------------------------------------------------------------------ summary
  buildDone() {
    const { h, t, icon } = this.app;
    const last = this.store.focus.last;
    this.main.appendChild(
      h(
        'div',
        { class: 'ck-focus-done' },
        h('div', { class: ['ck-focus-done-icon', last.completed && 'ok'] }, icon(last.completed ? 'checkmark_circle' : 'flag', { size: 48, filled: true })),
        h('div', { class: 'subtitle' }, last.completed ? t('focus.wellDone') : t('focus.ended')),
        h('div', { class: 'text-2' }, t('focus.youFocused', { time: minutesText(t, last.focusMin) })),
        h(
          'div',
          { class: 'ck-focus-actions' },
          h('button', { type: 'button', class: 'btn primary', onclick: () => this.store.dismissFocusSummary() }, t('focus.newSession')),
        ),
      ),
    );
  }

  // ------------------------------------------------------------------ daily progress
  buildProgress() {
    const { h, t, icon } = this.app;
    this.goalRing = progressRing({ stroke: 5.5, className: 'ck-goal-ring' });
    this.goalCenter = h('div', { class: 'ck-goal-center' });
    this.yesterday = h('div', { class: 'ck-stat-value' });
    this.streakEl = h('div', { class: 'ck-stat-value' });
    this.completed = h('div', { class: 'ck-goal-done caption text-2' });
    this.progress.append(
      h(
        'div',
        { class: 'ck-card-head' },
        h('div', { class: 'body-strong grow' }, t('focus.daily')),
        h('button', { type: 'button', class: 'btn subtle icon-btn', 'aria-label': t('focus.editGoal'), 'data-tip': t('focus.editGoal'), onclick: () => this.editGoal() }, icon('edit')),
      ),
      h(
        'div',
        { class: 'ck-goal-row' },
        h('div', { class: 'ck-stat' }, h('div', { class: 'caption text-2' }, t('focus.yesterday')), this.yesterday),
        h('div', { class: 'ck-goal' }, this.goalRing, this.goalCenter),
        h('div', { class: 'ck-stat' }, h('div', { class: 'caption text-2' }, t('focus.streak')), this.streakEl),
      ),
      this.completed,
    );
  }

  fillProgress(now = Date.now()) {
    const { h, t } = this.app;
    const goal = this.store.prefs.focus.goal;
    const today = this.store.todayMinutes(now);
    this.goalRing.set(Math.min(1, today / goal));
    this.goalRing.classList.toggle('met', today >= goal);
    const key = `${today}/${goal}`;
    if (this.goalCenter.dataset.key !== key) {
      this.goalCenter.dataset.key = key;
      this.goalCenter.replaceChildren(h('div', { class: 'caption text-2' }, t('focus.goal')), h('div', { class: 'ck-goal-value' }, minutesText(t, goal)));
    }
    const y = this.store.dayMinutes(addDays(dayKey(now), -1));
    const yTxt = minutesText(t, y);
    if (this.yesterday.textContent !== yTxt) this.yesterday.textContent = yTxt;
    const st = this.store.streak(now);
    const sTxt = t('focus.days', { count: st });
    if (this.streakEl.textContent !== sTxt) this.streakEl.textContent = sTxt;
    const cTxt = t('focus.completed', { time: minutesText(t, today) });
    if (this.completed.textContent !== cTxt) this.completed.textContent = cTxt;
  }

  async editGoal() {
    const { t, ui, win, h } = this.app;
    const sel = ui.select({ options: GOALS.map((m) => ({ value: m, label: minutesText(t, m) })), value: GOALS.includes(this.store.prefs.focus.goal) ? this.store.prefs.focus.goal : 60 });
    sel.setAttribute('aria-label', t('focus.goal'));
    sel.style.width = '100%';
    const v = await ui.dialog({
      title: t('focus.goalTitle'),
      body: h('div', { class: 'ck-dlg' }, h('div', { class: 'text-2' }, t('focus.goalBody')), sel),
      parent: win,
      className: 'ck-dialog',
      buttons: [
        { label: t('common.save'), value: 'save', primary: true },
        { label: t('common.cancel'), value: null },
      ],
    });
    if (v === 'save') {
      this.store.setPref('focus.goal', Number(sel.value));
      this.render();
    }
  }

  renderLog(now = Date.now()) {
    const { h, t, icon } = this.app;
    const today = dayKey(now);
    const items = this.store.focus.log.filter((e) => dayKey(e.start) === today).reverse();
    const key = items.map((e) => e.start).join() + this.app.lang;
    if (this.logKey === key) return;
    this.logKey = key;
    this.logCard.replaceChildren(
      h('div', { class: 'ck-card-head' }, h('div', { class: 'body-strong grow' }, t('focus.todaySessions'))),
      items.length
        ? h(
            'div',
            { class: 'ck-log-list' },
            items.slice(0, 12).map((e) =>
              h(
                'div',
                { class: 'ck-log-item' },
                icon(e.completed ? 'checkmark_circle' : 'dismiss_circle', { size: 16, class: e.completed ? 'ok' : 'stopped' }),
                h('div', { class: 'grow ellipsis' }, `${this.app.timeText(e.start)} – ${this.app.timeText(e.end)}`),
                h('div', { class: 'caption text-2' }, minutesText(t, e.focusMin)),
              ),
            ),
          )
        : h('div', { class: 'caption text-2 ck-log-empty' }, t('focus.noSessions')),
    );
  }

  // ------------------------------------------------------------------ ticking
  tick(now) {
    if (this.mode !== 'run' || !this.ring) {
      if (this._lastProg !== Math.floor(now / 30000)) {
        this._lastProg = Math.floor(now / 30000);
        this.fillProgress(now);
      }
      return;
    }
    const { t } = this.app;
    const st = this.store;
    const p = st.focusPhase(now);
    const s = st.focus.session;
    if (!p || !s) return;
    const smoothNow = reduceMotion() ? now - (now % 1000) : now;
    const pp = st.focusPhase(smoothNow) || p;
    this.ring.set(pp.left / pp.seg.ms);
    this.ring.classList.toggle('break', p.seg.type === 'break');
    this.main.classList.toggle('on-break', p.seg.type === 'break');
    const phase = p.seg.type === 'break' ? t('focus.onBreak') : p.periods > 1 ? t('focus.periodOf', { n: p.period, total: p.periods }) : t('focus.focusing');
    if (this.phase.textContent !== phase) this.phase.textContent = phase;
    const left = hms(p.left, { forceHours: false });
    if (this.left.textContent !== left) this.left.textContent = left;
    const sub = s.state === 'paused' ? t('focus.paused') : t('focus.endsAt', { time: this.app.timeText(st.focusEndsAt(now)) });
    if (this.leftSub.textContent !== sub) this.leftSub.textContent = sub;
    const nextSeg = s.segs[p.index + 1];
    const next = !nextSeg ? t('focus.lastPeriod') : nextSeg.type === 'break' ? t('focus.nextBreak', { n: Math.round(nextSeg.ms / MIN) }) : t('focus.nextFocus', { time: minutesText(t, nextSeg.ms / MIN) });
    if (this.next.textContent !== next) this.next.textContent = next;
    this.skipBtn.hidden = p.seg.type !== 'break';
    // timeline fill
    const fills = this.bar.querySelectorAll('.fill');
    let acc = 0;
    s.segs.forEach((g, i) => {
      const f = Math.max(0, Math.min(1, (pp.elapsed - acc) / g.ms));
      acc += g.ms;
      const w = `${(f * 100).toFixed(2)}%`;
      if (fills[i] && fills[i].style.width !== w) fills[i].style.width = w;
    });
    if (this._lastProg !== Math.floor(now / 15000)) {
      this._lastProg = Math.floor(now / 15000);
      this.fillProgress(now);
    }
  }

  wantsFrames() {
    return !reduceMotion() && this.store.focus.session?.state === 'running';
  }

  onStore(kind) {
    if (kind === 'focus' || kind === 'all' || kind === 'prefs') this.render();
  }

  onKey(e) {
    if (e.key === ' ' && e.repeat) return true;
    if (e.key === ' ' && !e.target?.closest?.('button') && this.store.focus.session) {
      this.togglePause();
      return true;
    }
    return false;
  }

  destroy() {}
}
