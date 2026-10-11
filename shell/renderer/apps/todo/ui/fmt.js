// Localised labels for dates, reminders and repeat rules.
import * as D from '../lib/dates.js';

export class Fmt {
  constructor(app) {
    this.app = app;
    this.cache = new Map();
  }

  /** Intl.DateTimeFormat instances are costly to create: one per locale + options. */
  dtf(opts) {
    const key = `${this.locale}|${JSON.stringify(opts)}`;
    let f = this.cache.get(key);
    if (!f) {
      f = new Intl.DateTimeFormat(this.locale, opts);
      this.cache.set(key, f);
    }
    return f;
  }
  get t() {
    return this.app.t;
  }
  get locale() {
    return this.app.i18n.locale;
  }

  /** 'Sat, Oct 10' (+ year when not the current year) */
  date(day, { weekday = 'short', month = 'short', withYear = null } = {}) {
    const d = D.parseYmd(day);
    if (!d) return '';
    const y = withYear ?? d.getFullYear() !== new Date(this.app.now()).getFullYear();
    return this.dtf({ weekday, month, day: 'numeric', ...(y ? { year: 'numeric' } : {}) }).format(d);
  }

  /** Today / Tomorrow / Yesterday / 'Mon, Oct 12' */
  dayName(day) {
    const today = this.app.today();
    if (day === today) return this.t('day.today');
    if (day === D.addDays(today, 1)) return this.t('day.tomorrow');
    if (day === D.addDays(today, -1)) return this.t('day.yesterday');
    return this.date(day);
  }

  /** 'Sat' */
  weekday(day) {
    const d = D.parseYmd(day);
    return d ? this.dtf({ weekday: 'short' }).format(d) : '';
  }

  /** '9:00 AM' / '09:00' (24-hour clocks pad the hour, like Windows and the taskbar clock) */
  time(ms) {
    if (D.validTs(ms) == null) return '';
    const h12 = this.app.h12;
    return this.dtf({ hour: h12 ? 'numeric' : '2-digit', minute: '2-digit', hour12: h12 }).format(new Date(ms));
  }

  /** Row label of a due date (overdue rows are red; the aria label says "Overdue") */
  dueShort(due) {
    return this.dayName(due);
  }

  /** 'Ctrl+Shift+S' -> localized key names ('Ctrl+Maj+S' in French) */
  keys(combo) {
    return combo
      .split('+')
      .map((k) => {
        const v = this.t(`kbd.${k}`);
        return v === `kbd.${k}` ? k : v;
      })
      .join('+');
  }

  /** Detail pane label: 'Due Today', 'Due Tomorrow', 'Due Mon, Oct 12', 'Overdue, Mon, Oct 5' */
  dueLong(due) {
    const st = D.dueState(due, this.app.now());
    if (st === 'today') return this.t('due.dueToday');
    if (st === 'tomorrow') return this.t('due.dueTomorrow');
    if (st === 'overdue') return this.t('due.overdueOn', { date: this.dayName(due) });
    return this.t('due.dueOn', { date: this.date(due) });
  }

  reminderMain(ms) {
    return this.t('remind.at', { time: this.time(ms) });
  }
  reminderSub(ms) {
    return D.validTs(ms) == null ? '' : this.dayName(D.ymd(ms));
  }
  /** Compact reminder text for rows: '9:00 AM' today, else 'Tomorrow, 9:00 AM' */
  reminderShort(ms) {
    if (D.validTs(ms) == null) return '';
    const day = D.ymd(ms);
    return day === this.app.today() ? this.time(ms) : `${this.dayName(day)}, ${this.time(ms)}`;
  }

  weekdayNames(style = 'short') {
    const f = this.dtf({ weekday: style });
    // 2026-10-11 is a Sunday
    return Array.from({ length: 7 }, (_, i) => f.format(new Date(2026, 9, 11 + i)));
  }

  repeat(r) {
    if (!r) return '';
    const key = D.repeatKey(r);
    if (key !== 'custom') {
      if (key === 'weekly' && r.days?.length === 1) return this.t('repeat.weeklyOn', { day: this.weekdayNames('long')[r.days[0]] });
      return this.t(`repeat.${key}`);
    }
    const unit = this.t(`repeat.unit.${r.freq}`, { count: r.interval });
    let s = r.interval === 1 ? this.t('repeat.everyOne', { unit }) : this.t('repeat.everyN', { n: r.interval, unit });
    if (r.freq === 'week' && r.days?.length) {
      const names = this.weekdayNames('short');
      const ws = this.app.weekStart;
      const days = [...r.days].sort((a, b) => ((a - ws + 7) % 7) - ((b - ws + 7) % 7));
      s += ` · ${days.map((d) => names[d]).join(', ')}`;
    }
    return s;
  }

  createdOn(ms) {
    if (D.validTs(ms) == null) return '';
    const day = D.ymd(ms);
    if (day === this.app.today()) return this.t('detail.createdToday');
    return this.t('detail.createdOn', { date: this.date(day) });
  }
  completedOn(ms) {
    if (D.validTs(ms) == null) return '';
    const day = D.ymd(ms);
    if (day === this.app.today()) return this.t('detail.completedToday');
    return this.t('detail.completedOn', { date: this.date(day) });
  }

  longToday() {
    return this.dtf({ weekday: 'long', month: 'long', day: 'numeric' }).format(new Date(this.app.now()));
  }
}
