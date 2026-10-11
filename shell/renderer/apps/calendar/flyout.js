// Calendar data for the shell's taskbar flyout (core/features/calendar.js loads this module lazily and
// ignores it if it fails). It shows the events of the selected day under the month grid, and keeps
// shell.reminders filled with the next reminders when one fires while the Calendar app is closed.
//   renderAgenda(slot, { ctx, date, close })   resync(ctx)
import { loadData, visibleOccurrences, syncReminders } from './lib/store.mjs';
import { addDays, startOfDay, sameDay, localKey } from './lib/dates.mjs';

const TEXT = {
  en: { today: 'Today', noEvents: 'No events', addEvent: 'Add an event', more_one: '{n} more event', more_other: '{n} more events', allDay: 'All day', noTitle: '(No title)', open: 'Open Calendar' },
  fr: { today: 'Aujourd’hui', noEvents: 'Aucun événement', addEvent: 'Ajouter un événement', more_one: '{n} autre événement', more_other: '{n} autres événements', allDay: 'Toute la journée', noTitle: '(Sans titre)', open: 'Ouvrir le calendrier' },
};
const MAX = 4;
let gen = 0;

function hour12(settings, lang) {
  const v = settings?.get?.('clock24h');
  return v == null ? lang !== 'fr' : !v;
}

export async function renderAgenda(slot, { ctx, date = new Date(), close } = {}) {
  const my = ++gen;
  const lang = ctx.i18n?.lang === 'fr' ? 'fr' : 'en';
  const tx = TEXT[lang];
  const locale = ctx.i18n?.locale || 'en-US';
  const day = startOfDay(date);
  let occs = [];
  try {
    const data = await loadData(ctx.api, lang);
    occs = visibleOccurrences(data, day.getTime(), addDays(day, 1).getTime(), lang);
  } catch (err) {
    console.warn('[calendar flyout] no data', err?.message || err);
    return;
  }
  if (my !== gen || !slot.isConnected) return;
  const { h } = ctx;
  ctx.ui.loadCss('app://shell/apps/calendar/flyout.css');
  const h12 = hour12(ctx.settings, lang);
  const tf = new Intl.DateTimeFormat(locale, { hour: h12 ? 'numeric' : '2-digit', minute: '2-digit', hour12: h12 });
  const launch = (args) => {
    close?.();
    ctx.shell.launch('calendar', args);
  };
  const title = sameDay(day, new Date()) ? tx.today : new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'long' }).format(day);
  const list = h('div', { class: 'acf-list', role: 'list' });
  for (const o of occs.slice(0, MAX)) {
    const when = o.allDay || o.start < day.getTime() ? tx.allDay : tf.format(o.start);
    const item = h(
      'button',
      {
        class: 'acf-item',
        type: 'button',
        role: 'listitem',
        dataset: { eventId: o.eventId },
        onclick: () => launch(o.holiday ? { date: localKey(day) } : { open: { eventId: o.eventId, key: o.key } }),
      },
      h('span', { class: 'acf-bar', style: `--ev: ${o.color}` }),
      h('span', { class: 'acf-text' }, h('span', { class: 'acf-title' }, o.title || tx.noTitle), h('span', { class: 'acf-when' }, o.location ? `${when} · ${o.location}` : when)),
    );
    list.appendChild(item);
  }
  const extra = occs.length - MAX;
  const foot = h(
    'div',
    { class: 'acf-foot' },
    !occs.length ? h('span', { class: 'acf-empty' }, tx.noEvents) : extra > 0 ? h('button', { class: 'acf-link', type: 'button', onclick: () => launch({ date: localKey(day) }) }, (extra === 1 ? tx.more_one : tx.more_other).replace('{n}', extra)) : h('span'),
    h('button', { class: 'acf-link', type: 'button', onclick: () => launch({ date: localKey(day), newEvent: true }) }, tx.addEvent),
  );
  slot.replaceChildren(h('div', { class: 'acf', 'aria-label': title }, h('div', { class: 'acf-head' }, title), occs.length ? list : null, foot));
}

export async function resync(ctx) {
  // the open app keeps the reminders in sync itself, from its in-memory data (the file may lag behind
  // an edit that is still being saved)
  if (typeof document !== 'undefined' && document.querySelector('.win.app-calendar')) return { set: 0, removed: 0, skipped: true };
  const lang = ctx.i18n?.lang === 'fr' ? 'fr' : 'en';
  const data = await loadData(ctx.api, lang);
  return syncReminders({ reminders: ctx.shell?.reminders, events: data.events, lang, hour12: hour12(ctx.settings, lang) });
}
