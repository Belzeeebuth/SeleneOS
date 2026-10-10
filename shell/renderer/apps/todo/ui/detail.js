// Task detail pane (slides in from the right): title + checkbox + star, steps (add / complete / rename /
// reorder by drag or Alt+arrows / delete / promote to task), Add to My Day, Remind me, Add due date, Repeat,
// note (autosaved), created / completed footer, delete.
import * as D from '../lib/dates.js';
import { checkSvg } from './listview.js';
import { beginDrag, liveReorder } from './drag.js';
import { reduceMotion, EASE } from './anim.js';

export class Detail {
  constructor(app) {
    this.app = app;
    this.taskId = null;
    this.pending = null; // { field, value } typed but not yet saved
    this.el = this._build();
  }

  _build() {
    const { h, t, icon } = this.app;
    this.scroll = h('div', { class: 'td-d-scroll' });
    this.foot = h('footer', { class: 'td-d-foot' });
    const el = h('aside', { class: 'td-detail', 'aria-label': t('detail.label'), hidden: true }, this.scroll, this.foot);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !e.target.closest('.td-step-input, .td-addstep-input')) {
        e.preventDefault();
        e.stopPropagation();
        this.app.closeDetail();
      }
    });
    return el;
  }

  get task() {
    return this.taskId ? this.app.store.task(this.taskId) : null;
  }

  /** Save what is being typed in the title / note right now. */
  flush() {
    clearTimeout(this._noteT);
    const p = this.pending;
    this.pending = null;
    if (!p || !this.app.store.task(p.id)) return;
    if (p.field === 'note' && this.app.store.task(p.id).note !== p.value) {
      this.app.store.update(p.id, { note: p.value }, { silent: true });
      this.app.list.render({ animate: false });
    }
  }

  /** Commit the title / step being edited (used when the window closes: no blur event comes then). */
  commitFocused() {
    const el = document.activeElement;
    const task = this.task;
    if (!task || !el || !this.el.contains(el)) return;
    const key = el.dataset?.key || '';
    const v = String(el.value ?? '').replace(/[\r\n]+/g, ' ').trim();
    if (key === 'title' && v && v !== task.title) this.app.store.update(task.id, { title: v });
    else if (key.startsWith('step-') && v) {
      const step = task.steps.find((x) => `step-${x.id}` === key);
      if (step && step.title !== v) this.app.store.updateStep(task.id, step.id, { title: v });
    } else if (key === 'addstep' && v) this.app.store.addStep(task.id, v);
  }

  render({ force = false } = {}) {
    const { app } = this;
    const open = !!app.openId && !!app.store.task(app.openId);
    const wasOpen = !this.el.hidden && this.el.classList.contains('shown');
    if (!open) {
      if (wasOpen) this._hide();
      this.taskId = null;
      return;
    }
    if (app.openId !== this.taskId) force = true;
    this.taskId = app.openId;
    // keep the field being edited (focus, caret, scroll)
    const act = this.el.contains(document.activeElement) ? document.activeElement : null;
    const key = act?.dataset?.key;
    const sel = act && 'selectionStart' in act ? [act.selectionStart, act.selectionEnd] : null;
    const st = this.scroll.scrollTop;
    if (key === 'note' || key === 'title') this.flush();
    this._fill();
    if (!force) this.scroll.scrollTop = st;
    if (key) {
      const n = this.el.querySelector(`[data-key="${CSS.escape(key)}"]`);
      if (n) {
        if ('value' in act && act.value !== n.value && key !== 'note') n.value = act.value; // keep unsaved typing
        n.focus({ preventScroll: true });
        if (sel && 'setSelectionRange' in n) {
          try {
            n.setSelectionRange(sel[0], sel[1]);
          } catch {}
        }
      }
    }
    if (!wasOpen) this._show();
  }

  _show() {
    this.el.hidden = false;
    this.el.classList.add('shown');
    this.app.root.classList.add('detail-open');
    if (!reduceMotion()) this.el.animate([{ transform: 'translateX(40px)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 280, easing: EASE });
  }

  _hide() {
    this.el.classList.remove('shown');
    this.app.root.classList.remove('detail-open');
    if (reduceMotion()) {
      this.el.hidden = true;
      return;
    }
    const a = this.el.animate([{ transform: 'none', opacity: 1 }, { transform: 'translateX(40px)', opacity: 0 }], { duration: 160, easing: 'cubic-bezier(0.7, 0, 1, 0.5)' });
    a.finished.then(
      () => !this.el.classList.contains('shown') && (this.el.hidden = true),
      () => {},
    );
  }

  focus(field) {
    const n = field === 'title' ? this.el.querySelector('[data-key="title"]') : this.el.querySelector('[data-key="title"]');
    n?.focus();
    if (field === 'title' && n) n.setSelectionRange(n.value.length, n.value.length);
  }

  markCompleting(id, on) {
    if (id !== this.taskId) return;
    const c = this.el.querySelector('.td-d-titlerow .td-check');
    this.el.querySelector('.td-d-titlerow')?.classList.toggle('completing', on);
    c?.setAttribute('aria-checked', String(on || !!this.task?.done));
  }

  // ---------------------------------------------------------------- content
  _fill() {
    const { app } = this;
    const { h, t, icon } = app;
    const task = this.task;
    const id = task.id;
    app.ui.clear(this.scroll);
    app.ui.clear(this.foot);
    const today = app.today();

    // title card -------------------------------------------------------
    const title = h('textarea', {
      class: 'td-d-title',
      rows: 1,
      maxlength: '400',
      'aria-label': t('detail.title'),
      dataset: { key: 'title' },
      spellcheck: true,
    });
    title.value = task.title;
    const autosize = () => {
      title.style.height = 'auto';
      title.style.height = `${title.scrollHeight}px`;
    };
    title.addEventListener('input', () => {
      const v = title.value.replace(/[\r\n]+/g, ' ');
      if (v !== title.value) title.value = v;
      autosize();
    });
    title.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        title.blur();
      } else if (e.key === 'Escape') {
        title.value = this.task?.title || '';
        autosize();
      }
    });
    title.addEventListener('blur', () => {
      const v = title.value.trim();
      const cur = this.app.store.task(id);
      if (!cur) return;
      if (!v) {
        title.value = cur.title;
        autosize();
      } else if (v !== cur.title) app.store.update(id, { title: v });
    });
    requestAnimationFrame(autosize);
    const check = h(
      'button',
      {
        type: 'button',
        class: 'td-check',
        role: 'checkbox',
        'aria-checked': String(task.done),
        'aria-label': t(task.done ? 'row.markNotCompleted' : 'row.markCompleted', { title: task.title }),
        'data-tip': t(task.done ? 'row.markNotCompletedTip' : 'row.markCompletedTip'),
        onclick: () => app.complete([id], !(task.done || app.completing.has(id))),
      },
      checkSvg(),
    );
    const star = h(
      'button',
      {
        type: 'button',
        class: ['td-star', task.important && 'on'],
        'aria-pressed': String(task.important),
        'aria-label': t(task.important ? 'row.removeImportanceTip' : 'row.markImportantTip'),
        'data-tip': t(task.important ? 'row.removeImportanceTip' : 'row.markImportantTip'),
        onclick: () => app.toggleImportant([id]),
      },
      icon('star', { filled: task.important }),
    );
    const titleRow = h('div', { class: ['td-d-titlerow', task.done && 'done', app.completing.has(id) && 'completing'] }, check, title, star);

    // steps -------------------------------------------------------------
    const steps = h('div', { class: 'td-steps', role: 'list', 'aria-label': t('detail.steps') });
    task.steps.forEach((s, i) => steps.appendChild(this._step(task, s, i)));
    const addStep = h('input', {
      class: 'td-addstep-input',
      placeholder: task.steps.length ? t('detail.nextStep') : t('detail.addStep'),
      'aria-label': t('detail.addStep'),
      maxlength: '400',
      dataset: { key: 'addstep' },
      onkeydown: (e) => {
        if (e.key === 'Enter' && addStep.value.trim()) {
          e.preventDefault();
          app.store.addStep(id, addStep.value);
          addStep.value = '';
          // the pane re-renders and keeps the focus in "Next step"
        } else if (e.key === 'Escape' && addStep.value) {
          e.preventDefault();
          e.stopPropagation();
          addStep.value = '';
        }
      },
    });
    const addStepRow = h('div', { class: 'td-addstep' }, h('button', { type: 'button', class: 'td-addstep-ic', tabindex: '-1', 'aria-hidden': 'true', onclick: () => addStep.focus() }, icon('add')), addStep);
    this.scroll.appendChild(h('section', { class: 'td-d-card td-d-main' }, titleRow, steps, addStepRow));

    // My Day ---------------------------------------------------------------
    const inMyDay = task.myDay === today;
    this.scroll.appendChild(
      h(
        'section',
        { class: 'td-d-card' },
        this._optRow({
          key: 'myday',
          ic: 'weather_sunny',
          label: t(inMyDay ? 'detail.addedMyDay' : 'detail.addMyDay'),
          active: inMyDay,
          onclick: () => !inMyDay && app.toggleMyDay([id], true),
          onclear: inMyDay ? () => app.toggleMyDay([id], false) : null,
          clearLabel: t('detail.removeMyDay'),
        }),
      ),
    );

    // reminder / due / repeat ---------------------------------------------
    const remindPast = Number.isFinite(task.remindAt) && task.remindAt <= Date.now();
    const dueSt = task.due ? D.dueState(task.due, app.now()) : null;
    this.scroll.appendChild(
      h(
        'section',
        { class: 'td-d-card td-d-group' },
        this._optRow({
          key: 'remind',
          ic: 'alert',
          label: Number.isFinite(task.remindAt) ? app.fmt.reminderMain(task.remindAt) : t('detail.remindMe'),
          sub: Number.isFinite(task.remindAt) ? app.fmt.reminderSub(task.remindAt) : null,
          active: Number.isFinite(task.remindAt),
          tone: remindPast ? 'past' : null,
          onclick: async (e) => {
            const v = await app.reminderMenu(e.currentTarget, task.remindAt);
            if (v !== undefined) app.remind(id, v);
          },
          onclear: Number.isFinite(task.remindAt) ? () => app.remind(id, null) : null,
          clearLabel: t('remind.remove'),
        }),
        this._optRow({
          key: 'due',
          ic: 'calendar_ltr',
          label: task.due ? app.fmt.dueLong(task.due) : t('detail.addDue'),
          active: !!task.due,
          tone: !task.done && dueSt === 'overdue' ? 'overdue' : !task.done && dueSt === 'today' ? 'today' : null,
          onclick: async (e) => {
            const v = await app.dueMenu(e.currentTarget, task.due);
            if (v !== undefined) app.setDue([id], v);
          },
          onclear: task.due ? () => app.setDue([id], null) : null,
          clearLabel: t('due.remove'),
        }),
        this._optRow({
          key: 'repeat',
          ic: 'arrow_repeat_all',
          label: task.repeat ? app.fmt.repeat(task.repeat) : t('detail.repeat'),
          active: !!task.repeat,
          onclick: async (e) => {
            const v = await app.repeatMenu(e.currentTarget, task.repeat, task.due);
            if (v !== undefined) app.setRepeat(id, v);
          },
          onclear: task.repeat ? () => app.setRepeat(id, null) : null,
          clearLabel: t('repeat.never'),
        }),
      ),
    );

    // note --------------------------------------------------------------
    const note = h('textarea', { class: 'td-d-note', placeholder: t('detail.addNote'), 'aria-label': t('detail.note'), dataset: { key: 'note' }, maxlength: '20000', spellcheck: true });
    note.value = task.note;
    const saveNote = () => {
      clearTimeout(this._noteT);
      this._noteT = setTimeout(() => this.flush(), 450);
    };
    note.addEventListener('input', () => {
      this.pending = { id, field: 'note', value: note.value };
      saveNote();
      sizeNote();
    });
    note.addEventListener('blur', () => this.flush());
    const sizeNote = () => {
      note.style.height = 'auto';
      note.style.height = `${Math.max(96, note.scrollHeight)}px`;
    };
    requestAnimationFrame(sizeNote);
    this.scroll.appendChild(h('section', { class: 'td-d-card td-d-notecard' }, note));

    // footer ------------------------------------------------------------
    this.foot.append(
      h('button', { type: 'button', class: 'btn subtle icon-btn td-d-close', 'aria-label': t('detail.hide'), 'data-tip': t('detail.hide'), onclick: () => app.closeDetail() }, icon('panel_right_contract')),
      h('div', { class: 'td-d-dates caption' }, task.done && task.completedAt ? app.fmt.completedOn(task.completedAt) : app.fmt.createdOn(task.created)),
      h('button', { type: 'button', class: 'btn subtle icon-btn td-d-delete', 'aria-label': t('menu.deleteTask'), 'data-tip': t('menu.deleteTask'), onclick: () => app.deleteTasks([id]) }, icon('delete')),
    );
  }

  _optRow({ key, ic, label, sub, active, tone, onclick, onclear, clearLabel }) {
    const { h, icon } = this.app;
    const main = h(
      'button',
      { type: 'button', class: ['td-opt', active && 'active', tone && `tone-${tone}`], dataset: { key }, onclick },
      icon(ic, { filled: false }),
      h('span', { class: 'td-opt-text' }, h('span', { class: 'td-opt-label ellipsis' }, label), sub ? h('span', { class: 'td-opt-sub caption ellipsis' }, sub) : null),
    );
    return h(
      'div',
      { class: 'td-opt-row' },
      main,
      onclear ? h('button', { type: 'button', class: 'btn subtle icon-btn td-opt-clear', 'aria-label': clearLabel, 'data-tip': clearLabel, dataset: { key: `${key}-clear` }, onclick: onclear }, icon('dismiss', { size: 12 })) : null,
    );
  }

  _step(task, s, i) {
    const { app } = this;
    const { h, t, icon } = app;
    const id = task.id;
    const input = h('input', { class: 'td-step-input', value: s.title, maxlength: '400', 'aria-label': t('detail.stepN', { n: i + 1 }), dataset: { key: `step-${s.id}` }, spellcheck: true });
    const commit = () => {
      const v = input.value.trim();
      if (!v) input.value = s.title;
      else if (v !== s.title) app.store.updateStep(id, s.id, { title: v });
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commit();
        this.el.querySelector('.td-addstep-input')?.focus();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        input.value = s.title;
        input.blur();
      } else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault();
        const j = i + (e.key === 'ArrowDown' ? 1 : -1);
        if (j >= 0 && j < task.steps.length) {
          commit();
          app.store.moveStep(id, s.id, j);
        }
      } else if (e.key === 'Backspace' && !input.value) {
        e.preventDefault();
        const prev = task.steps[i - 1];
        app.store.removeStep(id, s.id);
        if (prev) requestAnimationFrame(() => this.el.querySelector(`[data-key="step-${CSS.escape(prev.id)}"]`)?.focus());
      }
    });
    const check = h(
      'button',
      {
        type: 'button',
        class: 'td-check td-check-sm',
        role: 'checkbox',
        'aria-checked': String(s.done),
        'aria-label': t(s.done ? 'detail.stepUndone' : 'detail.stepDone', { title: s.title }),
        onclick: () => {
          if (!s.done) app.chime();
          app.store.updateStep(id, s.id, { done: !s.done });
        },
      },
      checkSvg(),
    );
    const more = h(
      'button',
      {
        type: 'button',
        class: 'btn subtle icon-btn td-step-more',
        'aria-label': t('detail.stepOptions'),
        'data-tip': t('detail.stepOptions'),
        onclick: (e) =>
          app.menu(e, [
            { label: t(s.done ? 'detail.markStepUndone' : 'detail.markStepDone'), icon: s.done ? 'circle' : 'checkmark_circle', action: () => app.store.updateStep(id, s.id, { done: !s.done }) },
            { label: t('detail.promote'), icon: 'arrow_up_right', action: () => {
              const n = app.store.promoteStep(id, s.id);
              if (n) app.announce(t('a11y.promoted', { title: n.title }));
            } },
            i > 0 ? { label: t('detail.moveUp'), icon: 'arrow_up', shortcut: app.fmt.keys('Alt+↑'), action: () => app.store.moveStep(id, s.id, i - 1) } : null,
            i < task.steps.length - 1 ? { label: t('detail.moveDown'), icon: 'arrow_down', shortcut: app.fmt.keys('Alt+↓'), action: () => app.store.moveStep(id, s.id, i + 1) } : null,
            '-',
            { label: t('detail.deleteStep'), icon: 'delete', danger: true, action: () => app.store.removeStep(id, s.id) },
          ].filter(Boolean)),
      },
      icon('more_horizontal'),
    );
    const el = h('div', { class: ['td-step', s.done && 'done'], role: 'listitem', 'aria-label': s.done ? `${s.title}, ${t('row.completed')}` : s.title, dataset: { id: s.id } }, check, input, more);
    el.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button') || e.button !== 0) return;
      if (e.target === input && document.activeElement === input) return; // selecting text
      const container = el.parentElement;
      const start = [...container.children].map((x) => x.dataset.id);
      beginDrag(e, {
        el,
        host: app.root,
        scroller: this.scroll,
        threshold: 8,
        onStart: () => {
          el.classList.add('td-dragging');
          input.blur();
        },
        onMove: (x, y) => liveReorder(container, el, y, '.td-step'),
        onDrop: () => {
          el.classList.remove('td-dragging');
          const order = [...container.children].map((x) => x.dataset.id);
          const j = order.indexOf(s.id);
          if (order.join() !== start.join()) app.store.moveStep(id, s.id, j);
          return el.getBoundingClientRect();
        },
        onCancel: () => {
          el.classList.remove('td-dragging');
          const map = new Map([...container.children].map((x) => [x.dataset.id, x]));
          for (const sid of start) container.appendChild(map.get(sid));
        },
      });
    });
    return el;
  }
}
