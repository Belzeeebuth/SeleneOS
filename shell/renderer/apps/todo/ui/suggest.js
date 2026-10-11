// My Day suggestions pane: Yesterday, Earlier (My Day history), Overdue, Due today, Upcoming, Recently added.
// "+" adds a suggestion to My Day (the row leaves with a short animation).
import { suggestions } from '../lib/store.js';
import { reduceMotion, EASE } from './anim.js';

const SECTIONS = ['yesterday', 'earlier', 'overdue', 'today', 'upcoming', 'recent'];

export class Suggest {
  constructor(app) {
    this.app = app;
    this.el = this._build();
  }

  _build() {
    const { h, t, icon } = this.app;
    this.body = h('div', { class: 'td-sg-body' });
    return h(
      'aside',
      { class: 'td-suggest', 'aria-label': t('suggest.title'), hidden: true },
      h(
        'header',
        { class: 'td-sg-head' },
        h('div', { class: 'subtitle' }, t('suggest.title')),
        h('button', { type: 'button', class: 'btn subtle icon-btn', 'aria-label': t('common.close'), 'data-tip': t('common.close'), onclick: () => (this.app.toggleSuggestions(false), this.app.list.focusList()) }, icon('dismiss')),
      ),
      this.body,
    );
  }

  focus() {
    setTimeout(() => (this.body.querySelector('.td-sg-add') || this.el.querySelector('.td-sg-head button'))?.focus(), 50);
  }

  render() {
    const { app } = this;
    const show = app.suggestOpen && app.view === 'myday';
    const was = !this.el.hidden;
    if (!show) {
      if (was) {
        app.root.classList.remove('suggest-open');
        if (reduceMotion()) this.el.hidden = true;
        else this.el.animate([{ transform: 'none', opacity: 1 }, { transform: 'translateX(40px)', opacity: 0 }], { duration: 160, easing: 'cubic-bezier(0.7, 0, 1, 0.5)' }).finished.then(() => !app.suggestOpen && (this.el.hidden = true), () => {});
      }
      return;
    }
    const { h, t, icon } = app;
    const focusedId = this.body.contains(document.activeElement) ? document.activeElement.closest('[data-id]')?.dataset.id : null;
    app.ui.clear(this.body);
    const sg = suggestions(app.store.data, app.now());
    let any = false;
    for (const key of SECTIONS) {
      const list = sg[key];
      if (!list.length) continue;
      any = true;
      const rows = list.map((task) => {
        const l = app.store.list(task.listId);
        const meta = [h('span', null, l?.emoji ? `${l.emoji} ` : '', app.listName(l))];
        if (task.due) meta.push(h('span', { class: ['td-meta-due', key === 'overdue' && 'overdue', key === 'today' && 'today'] }, icon('calendar_ltr', { size: 12 }), app.fmt.dueShort(task.due)));
        if ((key === 'yesterday' || key === 'earlier') && task.myDay) meta.push(h('span', null, icon('weather_sunny', { size: 12 }), app.fmt.dayName(task.myDay)));
        const row = h(
          'div',
          { class: 'td-sg-row', dataset: { id: task.id } },
          h(
            'div',
            {
              class: 'td-sg-main',
              role: 'button',
              tabindex: '0',
              'aria-label': t('suggest.open', { title: task.title }),
              onclick: () => app.openTask(task.id),
              onkeydown: (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  app.openTask(task.id, { focus: true });
                }
              },
            },
            h('div', { class: 'td-sg-title' }, task.title),
            h('div', { class: 'td-row-meta' }, meta),
          ),
          h(
            'button',
            {
              type: 'button',
              class: 'btn subtle icon-btn td-sg-add',
              'aria-label': t('suggest.add', { title: task.title }),
              'data-tip': t('menu.addMyDay'),
              onclick: () => {
                const done = () => app.toggleMyDay([task.id], true);
                if (reduceMotion()) return done();
                row.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateX(-24px)' }], { duration: 180, easing: 'cubic-bezier(0.7, 0, 1, 0.5)', fill: 'forwards' }).finished.then(done, done);
              },
            },
            icon('add'),
          ),
        );
        return row;
      });
      this.body.appendChild(h('section', { class: 'td-sg-sec', dataset: { key } }, h('div', { class: 'td-sg-sec-title caption' }, t(`suggest.${key}`)), rows));
    }
    if (!any) this.body.appendChild(h('div', { class: 'td-sg-empty' }, icon('lightbulb', { size: 40 }), h('div', { class: 'body-strong' }, t('suggest.emptyTitle')), h('div', { class: 'caption text-2' }, t('suggest.empty'))));
    if (!was) {
      this.el.hidden = false;
      app.root.classList.add('suggest-open');
      if (!reduceMotion()) this.el.animate([{ transform: 'translateX(40px)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 280, easing: EASE });
    }
    if (focusedId) (this.body.querySelector(`[data-id="${CSS.escape(focusedId)}"] .td-sg-add`) || this.body.querySelector('.td-sg-add'))?.focus({ preventScroll: true });
  }
}
