// Calendar tests — pure-module unit tests (calendar.unit.mjs) + the real Electron shell driven by Playwright.
//   Create (drag on the grid + quick create, New event dialog), edit (peek, editor), move (drag & drop
//   between days, snapping to 15 min), resize (bottom edge), delete + undo, recurrence with exceptions
//   (single occurrence edit / delete, "this and following"), reminders registered in shell.reminders with
//   the right times (and removed again), opening an event from a reminder, holidays (France and
//   United States, 2026–2027), .ics import (open with the default app) and export roundtrip, many
//   overlapping events laid out side by side, month "+N more", agenda, search, keyboard shortcuts,
//   settings (week numbers, first day), calendars (add / hide / delete), persistence, the taskbar
//   flyout's day events, English + French, light + dark, minimum and maximized sizes, console errors.
//   QA regressions: quick-create double submit, typed times validated before saving, work week of a
//   Sunday, daylight-saving days drawn at wall-clock time, no half-visible lines in event blocks, Tab kept
//   inside flyouts and the window, Delete on pane controls, AZERTY view keys, series rename keeps its
//   exceptions, multi-week WKST, import undo, settings in a small window, export errors, hidden
//   calendars, listener leaks over 15 open/close cycles, damaged events.json kept aside, French key names.
//   QA3: "Delete occurrence" asks once, re-import preselects the same-named calendar, reminders already
//   due shown at once, snoozed reminders kept by the sync, absurd imported durations, long event cards.
//   Documentation screenshots: aurora-os/docs/screenshots/calendar-*.png
// Usage:  cd aurora-os/shell && xvfb-run -a -s "-screen 0 1600x900x24" node test/calendar.test.mjs [--only=name] [--unit]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchShell, ROOT } from './lib.mjs';
import { runUnitTests } from './calendar.unit.mjs';
import { parseIcs } from '../renderer/apps/calendar/lib/ics.mjs';

const DOCS = path.join(ROOT, '..', 'docs', 'screenshots');
fs.mkdirSync(DOCS, { recursive: true });
const only = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7).toLowerCase();
const unitOnly = process.argv.includes('--unit');
const TZ = 'Europe/Paris';

let passed = 0;
const failures = [];
function check(name, actual, expected) {
  const ok = typeof expected === 'function' ? !!expected(actual) : Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++;
  else failures.push(`${name}\n      expected: ${typeof expected === 'function' ? '(predicate)' : JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
  return ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let recover = null;
async function section(name, fn) {
  // --only=a,b runs the sections whose name contains any of the comma-separated words
  if (only && !only.split(',').some((o) => o && name.toLowerCase().includes(o))) return;
  const t0 = Date.now();
  const before = failures.length;
  try {
    await fn();
    console.log(`  ${failures.length === before ? '✓' : '✗'} ${name} (${Date.now() - t0} ms)`);
  } catch (err) {
    failures.push(`${name}: threw ${err?.stack || err}`);
    console.log(`  ✗ ${name}: ${err?.message || err}`);
  }
  await recover?.();
}

// ---------------------------------------------------------------- helpers
const WIN = '.win.app-calendar';
const DLG = `${WIN} > .dialog-layer:not(.closing) .dialog`;
async function until(fn, { timeout = 6000, step = 50, label = 'condition' } = {}) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    last = await fn();
    if (last) return last;
    await sleep(step);
  }
  throw new Error(`timed out waiting for ${label} (last: ${JSON.stringify(last)})`);
}
// Evaluate fn(app, arg) in the shell (expression string: the shell CSP forbids eval in the page).
function CAL(s, fn, arg) {
  const expr = `(async () => { const el = document.querySelector(${JSON.stringify(WIN)}); const app = el && el.__calendar; return (${fn.toString()})(app, ${JSON.stringify(arg ?? null)}); })()`;
  return s.page.evaluate(expr);
}
const run = (s, expr) => s.page.evaluate(expr);
const dialogOpen = (s) => run(s, `!!document.querySelector(${JSON.stringify(DLG)})`);
// the topmost (last) open dialog of the window
const dialogText = (s) => run(s, `([...document.querySelectorAll(${JSON.stringify(DLG)})].pop() || {}).innerText || ''`);
async function dialogButton(s, label) {
  await until(() => dialogOpen(s), { label: 'dialog' });
  await sleep(120);
  await s.page.locator(DLG).last().locator('.dialog-footer .btn', { hasText: label }).first().click();
  await sleep(250);
}
const popOpen = (s, cls = '') => run(s, `!!document.querySelector('body > .ac-pop${cls}:not(.closing)')`);
async function closeFlyouts(s) {
  for (let i = 0; i < 6; i++) {
    const busy = await run(s, `!!document.querySelector('body > .ac-pop:not(.closing), body > .menu, ${DLG}')`).catch(() => false);
    if (!busy) break;
    await s.page.keyboard.press('Escape').catch(() => {});
    await sleep(220);
    // the editor asks before discarding changes (English or French)
    const discard = await run(s, `(() => { const d = [...document.querySelectorAll(${JSON.stringify(DLG)})].pop(); return !!d && /Discard changes|Abandonner les modifications/.test(d.innerText); })()`).catch(() => false);
    if (discard) await s.page.locator(`${DLG} .dialog-footer .btn.primary`).last().click().catch(() => {});
  }
}
function setRecover(s) {
  recover = async () => {
    await closeFlyouts(s);
  };
}
const events = (s) => CAL(s, (app) => app.data.events.map((e) => ({ id: e.id, title: e.title, start: e.start, end: e.end, allDay: e.allDay, rrule: e.rrule, exdates: e.exdates, overrides: e.overrides, calendarId: e.calendarId, reminder: e.reminder, location: e.location })));
const evByTitle = async (s, title) => (await events(s)).find((e) => e.title === title);
const localMs = (y, m, d, hh = 0, mi = 0) => new Date(Date.UTC(y, m, d, hh, mi)).getTime(); // placeholder replaced in page
async function pageMs(s, y, m, d, hh = 0, mi = 0) {
  return run(s, `new Date(${y}, ${m}, ${d}, ${hh}, ${mi}).getTime()`);
}
async function setView(s, view, date) {
  await CAL(s, (app, a) => {
    if (a.date) app.state.date = new Date(a.date[0], a.date[1], a.date[2]);
    app.state.view = a.view;
    app.state.selected = null;
    app.render({ animate: false });
    // time grids start at 8:00 whatever the real clock says (the default scroll follows "now")
    const sc = app.viewEl.querySelector('.ac-tg-scroll');
    if (sc) sc.scrollTop = a.scroll;
  }, { view, date, scroll: 8 * 48 });
  await sleep(350);
}
async function rect(s, sel) {
  return run(s, `(() => { const r = document.querySelector(${JSON.stringify(sel)})?.getBoundingClientRect(); return r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null; })()`);
}
// Point of a time in a time-grid column (week/day views).
async function slot(s, dateKey, hours) {
  const col = await rect(s, `${WIN} .ac-tg-col[data-date="${dateKey}"]`);
  const cols = await rect(s, `${WIN} .ac-tg-cols`);
  return { x: col.x + col.w * 0.4, y: cols.y + hours * 48 + 3 };
}
async function drag(s, from, to, steps = 8) {
  await s.page.mouse.move(from.x, from.y);
  await s.page.mouse.down();
  for (let i = 1; i <= steps; i++) await s.page.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
  await sleep(60);
  await s.page.mouse.up();
  await sleep(350);
}
async function shot(s, name, clip = true) {
  await sleep(350);
  const file = path.join(DOCS, `calendar-${name}.png`);
  if (clip) {
    const r = await rect(s, WIN);
    await s.page.screenshot({ path: file, clip: { x: Math.max(0, r.x - 16), y: Math.max(0, r.y - 16), width: Math.min(1600 - Math.max(0, r.x - 16), r.w + 32), height: Math.min(900 - Math.max(0, r.y - 16), r.h + 32) } });
  } else await s.page.screenshot({ path: file });
  return file;
}
function errorsSince(s, mark) {
  return s.logs.slice(mark).filter((l) => /^\[(error|pageerror)\]/.test(l) && !/status of 404/.test(l) && !/net::ERR_/.test(l));
}
async function openCalendar(s, args) {
  await run(s, `window.__aurora.shell.launch('calendar', ${JSON.stringify(args || {})}); 0`);
  await until(() => CAL(s, (app) => !!app?.root), { label: 'calendar app', timeout: 15000 });
  await sleep(300);
}
async function seed(s, list) {
  await CAL(s, async (app, list) => {
    for (const e of list) await app.upsert({ tz: Intl.DateTimeFormat().resolvedOptions().timeZone, calendarId: 'personal', ...e });
    app.select(null);
  }, list);
}
void localMs;

const SAMPLE_ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Test//Calendar test//EN',
  'X-WR-CALNAME:Team Paris',
  'BEGIN:VEVENT',
  'UID:standup-ics@test',
  'DTSTART;TZID=Europe/Paris:20261005T093000',
  'DTEND;TZID=Europe/Paris:20261005T094500',
  'RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;UNTIL=20261231T235959Z',
  'EXDATE;TZID=Europe/Paris:20261012T093000',
  'SUMMARY:Daily scrum\\, Paris team',
  'LOCATION:Room 4\\; 2nd floor',
  'DESCRIPTION:Agenda:\\n- blockers\\n- demo',
  'BEGIN:VALARM',
  'ACTION:DISPLAY',
  'TRIGGER:-PT10M',
  'END:VALARM',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:standup-ics@test',
  'RECURRENCE-ID;TZID=Europe/Paris:20261014T093000',
  'DTSTART;TZID=Europe/Paris:20261014T110000',
  'DTEND;TZID=Europe/Paris:20261014T111500',
  'SUMMARY:Daily scrum (late)',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:retreat-ics@test',
  'DTSTART;VALUE=DATE:20261026',
  'DTEND;VALUE=DATE:20261029',
  'SUMMARY:Team retreat',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:call-ics@test',
  'DTSTART:20261021T150000Z',
  'DURATION:PT45M',
  'SUMMARY:Call with New York',
  'END:VEVENT',
  'END:VCALENDAR',
  '',
].join('\r\n');

// ---------------------------------------------------------------- main
console.log('Calendar unit tests');
let before = failures.length;
runUnitTests(check);
console.log(`  ${failures.length === before ? '✓' : '✗'} pure modules (${passed} checks)`);

if (!unitOnly) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-cal-'));
  fs.writeFileSync(path.join(home, 'team.ics'), SAMPLE_ICS);
  console.log('Calendar app (English, light)');
  let s = await launchShell({ home, keepHome: true, lang: 'en', theme: 'light', env: { TZ }, settings: { lang: 'en', theme: 'light' } });
  setRecover(s);
  const mark0 = s.logs.length;

  await section('boot: window, calendars, toolbar', async () => {
    await openCalendar(s);
    const info = await CAL(s, (app) => ({
      title: app.win.title,
      cals: app.data.calendars.map((c) => [c.id, c.visible, c.kind]),
      rows: [...app.root.querySelectorAll('.ac-cal-row')].map((r) => r.querySelector('.ac-cal-name').textContent),
      views: [...app.root.querySelectorAll('.ac-views button')].map((b) => b.textContent.trim()),
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }));
    check('window title', info.title, 'Calendar');
    check('default calendars', info.cals, [
      ['personal', true, 'user'],
      ['work', true, 'user'],
      ['birthdays', true, 'user'],
      ['holidays-fr', false, 'holidays'],
      ['holidays-us', true, 'holidays'],
    ]);
    check('calendar names', info.rows, ['Personal', 'Work', 'Birthdays', 'Holidays in France', 'Holidays in United States']);
    check('view switcher', info.views, ['Day', 'Work week', 'Week', 'Month', 'Agenda']);
    check('system time zone in the app', info.tz, TZ);
    await setView(s, 'month', [2026, 9, 10]);
    check('month title', await run(s, `document.querySelector('${WIN} .ac-title-text').textContent`), 'October 2026');
    check('EN weeks start on Sunday', await run(s, `document.querySelector('${WIN} .ac-mo-wd .long').textContent`), 'Sunday');
    check('month grid has 5 weeks for Oct 2026 (Sunday first)', await run(s, `document.querySelectorAll('${WIN} .ac-mo-week').length`), 5);
    check('Columbus Day shown (US holidays on in English)', await run(s, `[...document.querySelectorAll('${WIN} .ac-mo-cell[data-date]')].length > 0 && !![...document.querySelectorAll('${WIN} .ac-chip')].find((c) => c.textContent.includes('Columbus Day'))`), true);
  });

  await section('create: drag a time range + quick create', async () => {
    await setView(s, 'week', [2026, 9, 12]);
    check('week title', await run(s, `document.querySelector('${WIN} .ac-title-text').textContent`), 'October 2026');
    const a = await slot(s, '2026-10-13', 14);
    const b = await slot(s, '2026-10-13', 15.3);
    await drag(s, a, b);
    await until(() => popOpen(s, '.ac-pop-quick'), { label: 'quick create' });
    check('selection label', await run(s, `document.querySelector('${WIN} .ac-tg-sel')?.textContent`), '2:00 PM – 3:30 PM');
    check('quick create summary', await run(s, `document.querySelector('.ac-pop-quick .ac-quick-when').textContent`), 'Tue, Oct 13, 2026 · 2:00 PM – 3:30 PM');
    await shot(s, 'quick-create');
    await s.page.keyboard.type('Product demo');
    await s.page.keyboard.press('Enter');
    await sleep(400);
    const ev = await evByTitle(s, 'Product demo');
    check('event created', !!ev, true);
    check('event start (snapped to 15 min)', ev && ev.start, await pageMs(s, 2026, 9, 13, 14, 0));
    check('event end', ev && ev.end, await pageMs(s, 2026, 9, 13, 15, 30));
    check('default reminder 15 min', ev && ev.reminder, 15);
    check('block drawn in Tuesday column', await run(s, `!!document.querySelector('${WIN} .ac-tg-col[data-date="2026-10-13"] .ac-ev[data-event-id="${ev.id}"]')`), true);
    check('selection removed', await run(s, `!!document.querySelector('${WIN} .ac-tg-sel')`), false);
    // a single click selects a half hour; Escape cancels
    const c = await slot(s, '2026-10-15', 9.6);
    await s.page.mouse.click(c.x, c.y);
    await until(() => popOpen(s, '.ac-pop-quick'), { label: 'quick create (click)' });
    check('click selects the half hour', await run(s, `document.querySelector('.ac-pop-quick .ac-quick-when').textContent`), 'Thu, Oct 15, 2026 · 9:30 AM – 10:00 AM');
    await s.page.keyboard.press('Escape');
    await sleep(250);
    check('Escape closes without creating', (await events(s)).length, 1);
  });

  await section('peek + edit an event', async () => {
    const ev = await evByTitle(s, 'Product demo');
    await s.page.click(`${WIN} .ac-ev[data-event-id="${ev.id}"]`);
    await until(() => popOpen(s, '.ac-pop-peek'), { label: 'peek' });
    check('peek title', await run(s, `document.querySelector('.ac-pop-peek .ac-peek-title').textContent`), 'Product demo');
    check('peek when', await run(s, `document.querySelector('.ac-pop-peek .ac-peek-row .ac-peek-text').textContent`), 'Tuesday, October 13, 2026 · 2:00 PM – 3:30 PM');
    check('event selected', await run(s, `document.querySelector('${WIN} .ac-ev[data-event-id="${ev.id}"]').classList.contains('selected')`), true);
    await shot(s, 'peek');
    await s.page.click('.ac-pop-peek .ac-peek-edit');
    await until(() => dialogOpen(s), { label: 'editor' });
    await sleep(300); // let the dialog settle (entrance animation, initial focus)
    check('editor title field', await run(s, `document.querySelector('${DLG} .ac-ed-title').value`), 'Product demo');
    await s.page.fill(`${DLG} .ac-ed-title`, 'Product demo v2');
    await s.page.fill(`${DLG} .ac-ed-loc`, 'Room Ada');
    // type a time in the end field (24 h input is accepted in English too)
    await s.page.click(`${DLG} .ac-timefield >> nth=1`);
    await s.page.keyboard.press('Control+A');
    await s.page.keyboard.type('16:15');
    await s.page.keyboard.press('Tab');
    await sleep(150);
    check('end time parsed', await run(s, `document.querySelectorAll('${DLG} .ac-timefield')[1].value`), '4:15 PM');
    await dialogButton(s, 'Save');
    const e2 = await evByTitle(s, 'Product demo v2');
    check('edited title + location', e2 && [e2.title, e2.location], ['Product demo v2', 'Room Ada']);
    check('edited end', e2 && e2.end, await pageMs(s, 2026, 9, 13, 16, 15));
  });

  await section('move by drag & drop (other day, 15-min snap)', async () => {
    const ev = await evByTitle(s, 'Product demo v2');
    const r = await rect(s, `${WIN} .ac-ev[data-event-id="${ev.id}"]`);
    const from = { x: r.x + r.w / 2, y: r.y + 10 };
    const wed = await slot(s, '2026-10-14', 0);
    // 2 h 07 min later on Wednesday -> start 16:07 -> snaps to 16:00 (Outlook-like 15-min grid)
    const to = { x: wed.x, y: from.y + 2 * 48 + 5.6 };
    await drag(s, from, to, 12);
    const e2 = await evByTitle(s, 'Product demo v2');
    check('moved start', e2.start, await pageMs(s, 2026, 9, 14, 16, 0));
    check('duration kept', e2.end - e2.start, (2 * 60 + 15) * 60000);
    check('block now in Wednesday column', await run(s, `!!document.querySelector('${WIN} .ac-tg-col[data-date="2026-10-14"] .ac-ev[data-event-id="${ev.id}"]')`), true);
    check('undo offered', await run(s, `document.querySelector('${WIN} .ac-snack.show')?.textContent || ''`), (t) => t.includes('Event moved') && t.includes('Undo'));
  });

  await section('resize by dragging the bottom edge', async () => {
    const ev = await evByTitle(s, 'Product demo v2');
    // keep the bottom edge away from the auto-scroll zone of the grid
    await CAL(s, (app) => (app.viewEl.querySelector('.ac-tg-scroll').scrollTop = 12 * 48));
    await sleep(100);
    const r = await rect(s, `${WIN} .ac-ev[data-event-id="${ev.id}"] .ac-ev-resize`);
    const from = { x: r.x + r.w / 2, y: r.y + 3 };
    await drag(s, from, { x: from.x, y: from.y + 48 * 0.75 + 2 }, 6); // +45 min
    const e2 = await evByTitle(s, 'Product demo v2');
    check('resized end (+45 min)', e2.end, await pageMs(s, 2026, 9, 14, 19, 0));
    check('start unchanged', e2.start, await pageMs(s, 2026, 9, 14, 16, 0));
    // keyboard nudge: Alt+Down moves 15 minutes later
    await s.page.focus(`${WIN} .ac-ev[data-event-id="${ev.id}"]`);
    await s.page.keyboard.press('Alt+ArrowDown');
    await sleep(300);
    const e3 = await evByTitle(s, 'Product demo v2');
    check('Alt+Down nudges 15 min', e3.start, await pageMs(s, 2026, 9, 14, 16, 15));
  });

  await section('delete + undo', async () => {
    const ev = await evByTitle(s, 'Product demo v2');
    await s.page.click(`${WIN} .ac-ev[data-event-id="${ev.id}"]`);
    await sleep(200);
    await s.page.keyboard.press('Escape'); // close the peek, keep the selection
    await sleep(200);
    await s.page.focus(`${WIN} .ac-ev[data-event-id="${ev.id}"]`);
    await s.page.keyboard.press('Delete');
    await sleep(300);
    check('deleted', await evByTitle(s, 'Product demo v2'), undefined);
    await s.page.click(`${WIN} .ac-snack .ac-undo`);
    await sleep(300);
    check('undo restores it', !!(await evByTitle(s, 'Product demo v2')), true);
  });

  await section('month view: drag across days to create, drag an event to another day', async () => {
    await setView(s, 'month', [2026, 9, 10]);
    const cell = async (key) => {
      const r = await rect(s, `${WIN} .ac-mo-cell[data-date="${key}"]`);
      return { x: r.x + r.w * 0.7, y: r.y + r.h - 8 };
    };
    await drag(s, await cell('2026-10-19'), await cell('2026-10-21'));
    await until(() => popOpen(s, '.ac-pop-quick'), { label: 'quick create (month)' });
    check('multi-day all-day selection', await run(s, `document.querySelector('.ac-pop-quick .ac-quick-when').textContent`), 'Mon, Oct 19, 2026 – Wed, Oct 21, 2026');
    await s.page.keyboard.type('Ski trip');
    await s.page.keyboard.press('Enter');
    await sleep(350);
    const ski = await evByTitle(s, 'Ski trip');
    check('all-day event created', ski && [ski.allDay, ski.start, ski.end], [true, '2026-10-19', '2026-10-22']);
    check('drawn as one bar', await run(s, `document.querySelectorAll('${WIN} .ac-chip.bar[data-event-id="${ski.id}"]').length`), 1);
    // drag the bar two days later
    const bar = await rect(s, `${WIN} .ac-chip.bar[data-event-id="${ski.id}"]`);
    const from = { x: bar.x + 30, y: bar.y + 10 }; // grabbed on Oct 19
    const to = await cell('2026-10-21');
    await drag(s, from, to);
    const ski2 = await evByTitle(s, 'Ski trip');
    check('moved by two days, same length', [ski2.start, ski2.end], ['2026-10-21', '2026-10-24']);
    // timed event moved to another day keeps its time
    const demo = await evByTitle(s, 'Product demo v2');
    const chip = await rect(s, `${WIN} .ac-chip[data-event-id="${demo.id}"]`);
    await drag(s, { x: chip.x + 20, y: chip.y + 10 }, await cell('2026-10-16'));
    const demo2 = await evByTitle(s, 'Product demo v2');
    check('timed event moved to Oct 16, same time', demo2.start, await pageMs(s, 2026, 9, 16, 16, 15));
    await s.page.click(`${WIN} .ac-snack .ac-undo`);
    await sleep(300);
    check('undo moves it back', (await evByTitle(s, 'Product demo v2')).start, await pageMs(s, 2026, 9, 14, 16, 15));
    // week view all-day row: drag the bar one day earlier
    await setView(s, 'week', [2026, 9, 19]);
    const wbar = await rect(s, `${WIN} .ac-tg-adgrid .ac-chip[data-event-id="${ski.id}"]`);
    const day = await rect(s, `${WIN} .ac-tg-dh[data-date="2026-10-20"]`);
    await drag(s, { x: wbar.x + 20, y: wbar.y + 8 }, { x: day.x + 20, y: wbar.y + 8 });
    check('all-day row drag', (await evByTitle(s, 'Ski trip')).start, '2026-10-20');
  });

  await section('new event dialog: weekly repeat + reminder', async () => {
    await setView(s, 'week', [2026, 9, 19]);
    await CAL(s, (app) => app.viewEl.focus());
    await s.page.keyboard.press('n');
    await until(() => dialogOpen(s), { label: 'editor' });
    await sleep(300);
    await s.page.fill(`${DLG} .ac-ed-title`, 'Piano lesson');
    // start time 17:30 (typed, French style)
    await s.page.click(`${DLG} .ac-timefield >> nth=0`);
    await s.page.keyboard.press('Control+A');
    await s.page.keyboard.type('17h30');
    await s.page.keyboard.press('Tab');
    await sleep(150);
    check('end follows start (keeps duration)', await run(s, `document.querySelectorAll('${DLG} .ac-timefield')[1].value`), '6:00 PM');
    const options = await run(s, `[...document.querySelectorAll('${DLG} .ac-ed-repeat option')].map((o) => o.value)`);
    check('repeat presets', options, ['none', 'daily', 'weekdays', 'weekly', 'monthlyDay', 'monthlyNth', 'yearly', 'custom']);
    check('weekly label uses the start day', await run(s, `document.querySelector('${DLG} .ac-ed-repeat option[value="weekly"]').textContent`), 'Every week on Monday');
    await s.page.selectOption(`${DLG} .ac-ed-repeat`, 'weekly');
    await s.page.selectOption(`${DLG} .ac-ed-endmode`, 'count');
    await s.page.fill(`${DLG} .ac-ed-count`, '6');
    await s.page.selectOption(`${DLG} .ac-ed-reminder`, '30');
    await shot(s, 'editor');
    await dialogButton(s, 'Save');
    const ev = await evByTitle(s, 'Piano lesson');
    check('weekly rule', ev && { freq: ev.rrule.freq, byday: ev.rrule.byday, count: ev.rrule.count }, { freq: 'WEEKLY', byday: ['MO'], count: 6 });
    check('start Monday 17:30', ev && ev.start, await pageMs(s, 2026, 9, 19, 17, 30));
    check('reminder 30', ev && ev.reminder, 30);
    // custom: every 2 weeks on Tue + Thu
    await s.page.keyboard.press('n');
    await until(() => dialogOpen(s), { label: 'editor 2' });
    await s.page.fill(`${DLG} .ac-ed-title`, 'Running club');
    await s.page.selectOption(`${DLG} .ac-ed-repeat`, 'custom');
    await sleep(100);
    await s.page.fill(`${DLG} .ac-ed-interval`, '2');
    // days: toggle Monday off (the start day), Tuesday + Thursday on
    for (const label of ['Tuesday', 'Thursday', 'Monday']) await s.page.click(`${DLG} .ac-ed-day[aria-label="${label}"]`);
    await shot(s, 'editor-custom-repeat');
    await dialogButton(s, 'Save');
    const rc = await evByTitle(s, 'Running club');
    check('custom rule', rc && { interval: rc.rrule.interval, byday: rc.rrule.byday }, { interval: 2, byday: ['TU', 'TH'] });
    check('start moved to the first matching day (Tuesday)', rc && new Date(rc.start).getDay(), 2);
  });

  await section('recurrence: occurrence edit, delete one, this and following', async () => {
    const ev = await evByTitle(s, 'Piano lesson');
    await setView(s, 'month', [2026, 9, 19]);
    const keys = await CAL(s, (app, id) => [...app.viewEl.querySelectorAll(`.ac-chip[data-event-id="${id}"]`)].map((c) => c.dataset.key), ev.id);
    check('occurrences shown in October (19, 26)', keys.length, 2);
    await setView(s, 'month', [2026, 10, 10]);
    const nov = await CAL(s, (app, id) => [...app.viewEl.querySelectorAll(`.ac-chip[data-event-id="${id}"]`)].map((c) => c.closest('.ac-mo-week') && c.dataset.key), ev.id);
    check('COUNT=6 -> 4 in November', nov.length, 4);
    // edit only the Nov 9 occurrence
    const k9 = String(await pageMs(s, 2026, 10, 9, 17, 30));
    await s.page.dblclick(`${WIN} .ac-chip[data-event-id="${ev.id}"][data-key="${k9}"]`);
    await until(() => dialogOpen(s), { label: 'series prompt' });
    check('asks occurrence or series', await dialogText(s), (t) => t.includes('recurring event'));
    await dialogButton(s, 'Just this one');
    await until(() => run(s, `!!document.querySelector('${DLG} .ac-ed-title')`), { label: 'occurrence editor' });
    check('repeat disabled for one occurrence', await run(s, `document.querySelector('${DLG} .ac-ed-repeat').disabled`), true);
    await s.page.fill(`${DLG} .ac-ed-title`, 'Piano recital');
    await dialogButton(s, 'Save');
    const e2 = await evByTitle(s, 'Piano lesson');
    check('override stored', e2.overrides[k9], { title: 'Piano recital' });
    check('other occurrences keep the title', await CAL(s, (app, id) => [...app.viewEl.querySelectorAll(`.ac-chip[data-event-id="${id}"] .ac-chip-title`)].map((c) => c.textContent), ev.id), ['Piano lesson', 'Piano recital', 'Piano lesson', 'Piano lesson']);
    // delete the Nov 16 occurrence only
    const k16 = String(await pageMs(s, 2026, 10, 16, 17, 30));
    await s.page.click(`${WIN} .ac-chip[data-event-id="${ev.id}"][data-key="${k16}"]`);
    await sleep(200);
    await s.page.keyboard.press('Escape');
    await s.page.focus(`${WIN} .ac-chip[data-event-id="${ev.id}"][data-key="${k16}"]`);
    await s.page.keyboard.press('Delete');
    await until(() => dialogOpen(s), { label: 'delete prompt' });
    await shot(s, 'delete-recurring');
    await dialogButton(s, 'Delete'); // default choice: this event
    const e3 = await evByTitle(s, 'Piano lesson');
    check('exdate added', e3.exdates, [k16]);
    check('Nov occurrences now 3', await CAL(s, (app, id) => app.viewEl.querySelectorAll(`.ac-chip[data-event-id="${id}"]`).length, ev.id), 3);
    // "this and following" from Nov 23
    const k23 = String(await pageMs(s, 2026, 10, 23, 17, 30));
    await s.page.click(`${WIN} .ac-chip[data-event-id="${ev.id}"][data-key="${k23}"]`);
    await until(() => popOpen(s, '.ac-pop-peek'), { label: 'peek' });
    check('peek shows recurrence', await run(s, `document.querySelector('.ac-pop-peek').innerText`), (t) => t.includes('Every week on Monday, 6 times'));
    await s.page.click('.ac-pop-peek .ac-peek-delete');
    await until(() => dialogOpen(s), { label: 'delete prompt 2' });
    await s.page.click(`${DLG} input[value="following"]`);
    await dialogButton(s, 'Delete');
    const e4 = await evByTitle(s, 'Piano lesson');
    check('series truncated (UNTIL before Nov 23)', e4.rrule.until, Number(k23) - 1000);
    check('Nov occurrences now 2', await CAL(s, (app, id) => app.viewEl.querySelectorAll(`.ac-chip[data-event-id="${id}"]`).length, ev.id), 2);
  });

  await section('reminders registered in shell.reminders', async () => {
    // an event next week (relative to the real clock, so reminders are in the future)
    const t0 = await run(s, `(() => { const d = new Date(); d.setDate(d.getDate() + 7); d.setHours(10, 0, 0, 0); return d.getTime(); })()`);
    await seed(s, [{ id: 'rem1', title: 'Doctor', start: t0, end: t0 + 3600000, location: 'Clinic', reminder: 60, rrule: { freq: 'DAILY', interval: 1 } }]);
    await sleep(300);
    const list = await run(s, `window.__aurora.shell.reminders.list('calendar').filter((r) => r.id.startsWith('evt-rem1-'))`);
    check('next 3 occurrences scheduled', list.length, 3);
    check('reminder ids + times', list.map((r) => [r.id, r.at]).sort((a, b) => a[1] - b[1]), [0, 1, 2].map((i) => {
      const at = new Date(t0);
      at.setDate(at.getDate() + i);
      return [`evt-rem1-${at.getTime()}`, at.getTime() - 3600000];
    }));
    check('reminder text', list[0] && [list[0].title, list[0].body.includes('10:00 AM – 11:00 AM'), list[0].body.endsWith('Clinic'), list[0].data.eventId], ['Doctor', true, true, 'rem1']);
    // opening the app from a reminder shows that event
    await CAL(s, (app) => app.goTo(new Date(2026, 0, 1)));
    await run(s, `window.__aurora.shell.launch('calendar', { reminder: { id: ${JSON.stringify(list[0].id)}, data: ${JSON.stringify(list[0].data)} } }); 0`);
    await until(() => popOpen(s, '.ac-pop-peek'), { label: 'peek from reminder' });
    check('peek for the reminded event', await run(s, `document.querySelector('.ac-pop-peek .ac-peek-title').textContent`), 'Doctor');
    await closeFlyouts(s);
    // changing the reminder reschedules, deleting the event removes them
    await CAL(s, async (app) => app.applySeriesEdit(app.data.events.find((e) => e.id === 'rem1'), { reminder: 5 }));
    await sleep(300);
    const list2 = await run(s, `window.__aurora.shell.reminders.list('calendar').filter((r) => r.id.startsWith('evt-rem1-'))`);
    check('rescheduled 5 min before', list2.map((r) => r.at).sort()[0], t0 - 5 * 60000);
    await CAL(s, async (app) => app.commit(app.data.events.filter((e) => e.id !== 'rem1')));
    await sleep(300);
    check('removed with the event', await run(s, `window.__aurora.shell.reminders.list('calendar').filter((r) => r.id.startsWith('evt-rem1-')).length`), 0);
  });

  await section('holidays (France + United States) 2026-2027', async () => {
    await s.page.click(`${WIN} .ac-cal-row[data-cal="holidays-fr"] input`);
    await sleep(250);
    await setView(s, 'month', [2026, 3, 6]);
    const chips = async (key) => run(s, `[...document.querySelectorAll('${WIN} .ac-chip.holiday')].filter((c) => c.dataset.key === '${key}').map((c) => c.textContent)`);
    check('Easter Monday 2026-04-06 (FR calendar, English names)', await chips('2026-04-06'), ['Easter Monday']);
    await setView(s, 'month', [2026, 4, 1]);
    check('Ascension 2026-05-14', await chips('2026-05-14'), ['Ascension Day']);
    check('Whit Monday + Memorial Day 2026-05-25', (await chips('2026-05-25')).sort(), ['Memorial Day', 'Whit Monday']);
    await setView(s, 'month', [2026, 10, 1]);
    check('Thanksgiving 2026-11-26', await chips('2026-11-26'), ['Thanksgiving Day']);
    await setView(s, 'month', [2027, 2, 1]);
    check('Easter Monday 2027-03-29', await chips('2027-03-29'), ['Easter Monday']);
    await setView(s, 'month', [2027, 10, 1]);
    check('Thanksgiving 2027-11-25', await chips('2027-11-25'), ['Thanksgiving Day']);
    // holidays are read-only: peek has no Edit / Delete, dragging does nothing
    await s.page.click(`${WIN} .ac-chip.holiday[data-key="2027-11-25"]`);
    await until(() => popOpen(s, '.ac-pop-peek'), { label: 'holiday peek' });
    check('holiday peek has no actions', await run(s, `!!document.querySelector('.ac-pop-peek .ac-peek-actions')`), false);
    check('holiday kind', await run(s, `document.querySelector('.ac-pop-peek').innerText`), (t) => t.includes('Public holiday') && t.includes('Holidays in United States'));
    await closeFlyouts(s);
    await s.page.click(`${WIN} .ac-cal-row[data-cal="holidays-fr"] input`);
    await sleep(200);
  });

  await section('.ics import (default app) and export roundtrip', async () => {
    const handler = await run(s, `window.__aurora.registry.handlerFor('/x/team.ics')`);
    check('Calendar is the default app for .ics', handler, 'calendar');
    await run(s, `window.__aurora.shell.openFile(${JSON.stringify(path.join(home, 'team.ics'))}); 0`);
    await until(() => dialogOpen(s), { label: 'import dialog' });
    check('import summary', await dialogText(s), (t) => t.includes('3 events found in team.ics') && t.includes('New calendar: Team Paris'));
    await shot(s, 'import');
    await dialogButton(s, 'Import');
    const cal = await CAL(s, (app) => app.data.calendars.find((c) => c.name === 'Team Paris'));
    check('new calendar created', !!cal, true);
    const imp = (await events(s)).filter((e) => e.calendarId === cal.id);
    check('3 events imported', imp.map((e) => e.title).sort(), ['Call with New York', 'Daily scrum, Paris team', 'Team retreat']);
    const scrum = imp.find((e) => e.title.startsWith('Daily'));
    check('imported recurrence', [scrum.rrule.freq, scrum.rrule.byday, scrum.location, scrum.reminder], ['WEEKLY', ['MO', 'WE', 'FR'], 'Room 4; 2nd floor', 10]);
    check('imported exception + override', [scrum.exdates.length, Object.values(scrum.overrides)[0]?.title], [1, 'Daily scrum (late)']);
    await setView(s, 'week', [2026, 9, 12]);
    await CAL(s, (app) => (app.viewEl.querySelector('.ac-tg-scroll').scrollTop = 9 * 48));
    const wk = await CAL(s, (app, id) => [...app.viewEl.querySelectorAll(`.ac-ev[data-event-id="${id}"]`)].map((e) => [e.closest('.ac-tg-col').dataset.date, e.querySelector('.ac-ev-title').textContent]), scrum.id);
    check('week of Oct 12: Monday excluded, Wednesday moved', wk, [
      ['2026-10-14', 'Daily scrum (late), 11:00 AM'],
      ['2026-10-16', 'Daily scrum, Paris team, 9:30 AM'],
    ]);
    // importing the same file again updates instead of duplicating
    await run(s, `window.__aurora.shell.openFile(${JSON.stringify(path.join(home, 'team.ics'))}); 0`);
    await until(() => dialogOpen(s), { label: 'import dialog 2' });
    check('re-import: the calendar with the same name is preselected', await run(s, `document.querySelector('${DLG} select').value`), cal.id);
    await dialogButton(s, 'Import');
    check('re-import does not create a second calendar', await CAL(s, (app) => app.data.calendars.filter((c) => c.name === 'Team Paris').length), 1);
    check('re-import does not duplicate', (await events(s)).filter((e) => e.calendarId === cal.id).length, 3);
    // export everything through the "…" menu and the save picker
    await s.page.click(`${WIN} .ac-more`);
    await s.page.locator('body > .menu .menu-item', { hasText: 'Export all calendars' }).click();
    await until(() => run(s, `!!document.querySelector('${DLG}.fp-dialog .fp-bottom input')`), { label: 'save picker' });
    const out = path.join(home, 'Documents', 'export-all.ics');
    await sleep(200);
    await s.page.fill(`${DLG}.fp-dialog .fp-bottom input`, out);
    await s.page.keyboard.press('Enter');
    await until(() => fs.existsSync(out), { label: 'exported file' });
    await sleep(300);
    const text = fs.readFileSync(out, 'utf8');
    const back = parseIcs(text, { defaultTz: TZ });
    const all = await events(s);
    check('export contains every event', back.events.length, all.length);
    const bScrum = back.events.find((e) => e.title === 'Daily scrum, Paris team');
    check('roundtrip keeps the rule, exceptions, alarm', bScrum && [bScrum.rrule.freq, bScrum.rrule.byday, bScrum.exdates, Object.values(bScrum.overrides || {})[0]?.title, bScrum.reminder, bScrum.start], ['WEEKLY', ['MO', 'WE', 'FR'], scrum.exdates, 'Daily scrum (late)', 10, scrum.start]);
    const bPiano = back.events.find((e) => e.title === 'Piano lesson');
    const piano = all.find((e) => e.title === 'Piano lesson');
    check('roundtrip keeps the occurrence override + UNTIL', bPiano && [Object.values(bPiano.overrides)[0]?.title, bPiano.rrule.until, bPiano.exdates], [Object.values(piano.overrides)[0]?.title, piano.rrule.until, piano.exdates]);
    check('exported lines folded at 75 octets', text.split('\r\n').every((l) => Buffer.byteLength(l) <= 75), true);
    check('export toast', await run(s, `document.querySelector('${WIN} .ac-snack.show')?.textContent || ''`), (t) => t.includes('exported to export-all.ics'));
  });

  await section('many overlapping events (week, day, month, agenda)', async () => {
    const list = [];
    for (let i = 0; i < 10; i++) list.push({ id: `ov${i}`, title: `Overlap ${i + 1}`, start: await pageMs(s, 2026, 11, 2, 9, i * 10), end: await pageMs(s, 2026, 11, 2, 11, 0), calendarId: i % 2 ? 'work' : 'personal' });
    list.push({ id: 'ovAllDay1', title: 'Offsite day 1', allDay: true, start: '2026-12-01', end: '2026-12-04' });
    list.push({ id: 'ovAllDay2', title: 'Hackathon', allDay: true, start: '2026-12-02', end: '2026-12-03' });
    list.push({ id: 'ovAllDay3', title: 'Release freeze', allDay: true, start: '2026-11-30', end: '2026-12-05' });
    list.push({ id: 'ovAllDay4', title: 'Team photo', allDay: true, start: '2026-12-02', end: '2026-12-03' });
    await seed(s, list);
    await setView(s, 'week', [2026, 11, 2]);
    // (the imported "Daily scrum" also happens that Wednesday: count it among the overlaps)
    const boxes = await run(s, `[...document.querySelectorAll('${WIN} .ac-tg-col[data-date="2026-12-02"] .ac-ev')].map((e) => { const r = e.getBoundingClientRect(); return { id: e.dataset.eventId, x: r.x, w: r.width, y: r.y, h: r.height }; })`);
    check('10 overlapping blocks drawn (+ the imported scrum)', boxes.map((b) => b.id).filter((id) => id.startsWith('ov')).length, 10);
    check('11 blocks in that column', boxes.length, 11);
    const overlap = boxes.some((a, i) => boxes.some((b, j) => i < j && a.x < b.x + b.w - 1 && b.x < a.x + a.w - 1 && a.y < b.y + b.h - 1 && b.y < a.y + a.h - 1));
    check('blocks never overlap', overlap, false);
    check('all blocks have a width', boxes.every((b) => b.w > 4), true);
    check('all-day row collapses to 3 lanes with "+N more"', await run(s, `[...document.querySelectorAll('${WIN} .ac-tg-admore')].map((b) => b.textContent)`), (t) => t.length > 0 && t.every((x) => /^\+\d more$/.test(x)));
    await shot(s, 'week-overlaps');
    await s.page.click(`${WIN} .ac-tg-adtoggle`);
    await sleep(200);
    check('expanded all-day row shows every bar', await run(s, `document.querySelectorAll('${WIN} .ac-tg-adgrid .ac-chip').length`), 4);
    await setView(s, 'day', [2026, 11, 2]);
    check('day view: 11 blocks', await run(s, `document.querySelectorAll('${WIN} .ac-tg-col .ac-ev').length`), 11);
    await setView(s, 'month', [2026, 11, 2]);
    check('month: "+N more" on Dec 2', await run(s, `[...document.querySelectorAll('${WIN} .ac-more-btn')].map((b) => b.getAttribute('aria-label')).find((l) => l.includes('December 2'))`), (l) => /\d+ more events on Wednesday, December 2, 2026/.test(l || ''));
    await s.page.locator(`${WIN} .ac-more-btn[aria-label*="December 2"]`).click();
    await until(() => popOpen(s, '.ac-pop-day'), { label: 'day list' });
    check('day list shows all 15 events', await run(s, `document.querySelectorAll('.ac-pop-day .ac-chip').length`), 15);
    await closeFlyouts(s);
    await setView(s, 'agenda', [2026, 11, 2]);
    check('agenda lists them under Wednesday', await run(s, `document.querySelectorAll('${WIN} .ac-ag-day[data-date="2026-12-02"] .ac-ag-row').length`), 15);
  });

  await section('keyboard: views, today, arrows, periods, search', async () => {
    await setView(s, 'month', [2026, 9, 21]);
    await CAL(s, (app) => app.viewEl.focus());
    const view = () => run(s, `document.querySelector('${WIN} .ac-view').dataset.view`);
    for (const [k, v] of [['1', 'day'], ['2', 'workweek'], ['3', 'week'], ['5', 'agenda'], ['4', 'month']]) {
      await s.page.keyboard.press(k);
      await sleep(120);
      check(`key ${k} -> ${v}`, await view(), v);
    }
    const date = () => CAL(s, (app) => app.state.date.toDateString());
    await s.page.keyboard.press('ArrowRight');
    check('ArrowRight +1 day', await date(), new Date(2026, 9, 22).toDateString());
    await s.page.keyboard.press('ArrowDown');
    check('ArrowDown +7 days', await date(), new Date(2026, 9, 29).toDateString());
    await s.page.keyboard.press('PageDown');
    await sleep(100);
    check('PageDown next month', await run(s, `document.querySelector('${WIN} .ac-title-text').textContent`), 'November 2026');
    await s.page.keyboard.press('t');
    await sleep(100);
    check('T goes to today', await date(), await run(s, 'new Date().toDateString()')); // the shell's time zone, not Node's
    // work week shows Monday..Friday
    await s.page.keyboard.press('2');
    await sleep(150);
    check('work week has 5 days', await run(s, `document.querySelectorAll('${WIN} .ac-tg-dh').length`), 5);
    // search
    await s.page.keyboard.press('Control+f');
    await s.page.keyboard.type('piano');
    await sleep(500);
    check('search view', await view(), 'search');
    check('search results', await run(s, `[...document.querySelectorAll('${WIN} .ac-ag-row .ac-ag-title')].map((e) => e.textContent)`), (t) => t.length >= 3 && t.every((x) => /piano/i.test(x)));
    check('match highlighted', await run(s, `document.querySelector('${WIN} .ac-ag-title mark')?.textContent`), 'Piano');
    await shot(s, 'search');
    await s.page.keyboard.press('Escape');
    await sleep(300);
    check('Escape clears the search', await view(), 'workweek');
    // Next while search results are shown leaves the search and moves one week (it used to do nothing)
    await s.page.keyboard.press('Control+f');
    await s.page.keyboard.type('piano');
    await sleep(500);
    const t0 = await CAL(s, (app) => app.state.date.getTime());
    await s.page.click(`${WIN} .ac-next`);
    await sleep(300);
    check('Next leaves the search results', [await view(), await run(s, `document.querySelector('${WIN} .ac-search input').value`)], ['workweek', '']);
    check('…and moves one week', await CAL(s, (app, t0) => Math.round((app.state.date.getTime() - t0) / 86400000), t0), 7);
  });

  await section('settings: first day, week numbers, work week', async () => {
    await s.page.click(`${WIN} .ac-more`);
    await s.page.locator('body > .menu .menu-item', { hasText: 'Calendar settings' }).click();
    await until(() => dialogOpen(s), { label: 'settings' });
    await s.page.selectOption(`${DLG} .ac-settings select >> nth=0`, '1');
    await s.page.click(`${DLG} .ac-settings .toggle input`);
    await shot(s, 'settings');
    await dialogButton(s, 'Save');
    await setView(s, 'month', [2026, 9, 10]);
    check('weeks start on Monday', await run(s, `document.querySelector('${WIN} .ac-mo-wd .long').textContent`), 'Monday');
    check('week numbers shown (ISO)', await run(s, `[...document.querySelectorAll('${WIN} .ac-mo-wn')].map((b) => b.textContent)`), ['40', '41', '42', '43', '44']);
    check('prefs saved', await CAL(s, (app) => [app.prefs.firstDay, app.prefs.weekNumbers]), [1, true]);
  });

  await section('calendars: add, hide, delete', async () => {
    await s.page.click(`${WIN} .ac-add-cal`);
    await until(() => dialogOpen(s), { label: 'add calendar' });
    await s.page.fill(`${DLG} .ac-calname`, 'Sports');
    await s.page.click(`${DLG} .ac-color >> nth=2`);
    await dialogButton(s, 'Add');
    const cal = await CAL(s, (app) => app.data.calendars.find((c) => c.name === 'Sports'));
    check('calendar added', cal && [cal.color, cal.visible], ['#107c10', true]);
    await seed(s, [{ id: 'sp1', title: 'Football', start: await pageMs(s, 2026, 9, 24, 15), end: await pageMs(s, 2026, 9, 24, 17), calendarId: cal.id }]);
    await setView(s, 'month', [2026, 9, 10]);
    const visible = () => run(s, `!!document.querySelector('${WIN} .ac-chip[data-event-id="sp1"]')`);
    check('event visible', await visible(), true);
    check('event color follows the calendar', await run(s, `getComputedStyle(document.querySelector('${WIN} .ac-chip[data-event-id="sp1"] .ac-chip-dot')).backgroundColor`), 'rgb(16, 124, 16)');
    await s.page.click(`${WIN} .ac-cal-row[data-cal="${cal.id}"] input`);
    await sleep(200);
    check('hidden calendar hides its events', await visible(), false);
    await s.page.click(`${WIN} .ac-cal-row[data-cal="${cal.id}"] .ac-cal-more`);
    await s.page.locator('body > .menu .menu-item', { hasText: 'Delete calendar' }).click();
    await until(() => dialogOpen(s), { label: 'confirm delete' });
    check('confirm mentions the event count', await dialogText(s), (t) => t.includes('its 1 event'));
    await dialogButton(s, 'Delete');
    check('calendar + events deleted', await CAL(s, (app) => [app.data.calendars.some((c) => c.name === 'Sports'), app.data.events.some((e) => e.id === 'sp1')]), [false, false]);
  });

  await section('taskbar flyout shows the day’s events', async () => {
    const today = await run(s, `(() => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); })()`);
    const tomorrow = await run(s, `(() => { const d = new Date(); d.setDate(d.getDate() + 1); const p = (n) => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); })()`);
    await seed(s, [{ id: 'fly1', title: 'Flyout check', allDay: true, start: today, end: tomorrow }]);
    await run(s, `window.__aurora.shell.emit('calendar:open'); 0`);
    await until(() => run(s, `!!document.querySelector('#calendar-center .acf-item[data-event-id="fly1"]')`), { label: 'flyout events' });
    check('flyout lists the event', await run(s, `document.querySelector('#calendar-center .acf-item[data-event-id="fly1"]').textContent`), (t) => t.includes('Flyout check') && t.includes('All day'));
    await s.shot('calendar-flyout');
    fs.copyFileSync(path.join(ROOT, 'test', 'out', 'calendar-flyout.png'), path.join(DOCS, 'calendar-taskbar-flyout.png'));
    await s.page.click('#calendar-center .acf-item[data-event-id="fly1"]');
    await until(() => popOpen(s, '.ac-pop-peek'), { label: 'peek from flyout' });
    check('clicking opens the event in Calendar', await run(s, `document.querySelector('.ac-pop-peek .ac-peek-title').textContent`), 'Flyout check');
    await closeFlyouts(s);
  });

  await section('robustness: invalid .ics, unreadable file, many events', async () => {
    fs.writeFileSync(path.join(home, 'broken.ics'), 'this is not a calendar\n');
    await run(s, `window.__aurora.shell.openFile(${JSON.stringify(path.join(home, 'broken.ics'))}); 0`);
    await until(() => dialogOpen(s), { label: 'error dialog' });
    check('invalid .ics -> error dialog', await dialogText(s), (t) => t.includes('isn’t an iCalendar (.ics) file'));
    await dialogButton(s, 'OK');
    fs.writeFileSync(path.join(home, 'empty.ics'), 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n');
    await run(s, `window.__aurora.shell.launch('calendar', { file: ${JSON.stringify(path.join(home, 'empty.ics'))} }); 0`);
    await until(() => dialogOpen(s), { label: 'no events dialog' });
    check('empty calendar -> message', await dialogText(s), (t) => t.includes('No events were found in empty.ics'));
    await dialogButton(s, 'OK');
    await run(s, `window.__aurora.shell.launch('calendar', { file: ${JSON.stringify(path.join(home, 'missing.ics'))} }); 0`);
    await until(() => dialogOpen(s), { label: 'read error dialog' });
    check('missing file -> error', await dialogText(s), (t) => t.includes('missing.ics couldn’t be read'));
    await dialogButton(s, 'OK');
    // 800 single events + 40 daily series: views stay fast
    const t0 = await pageMs(s, 2026, 8, 1, 8);
    const n = await CAL(s, async (app, t0) => {
      const list = [...app.data.events];
      for (let i = 0; i < 800; i++) list.push({ id: `perf${i}`, title: `Perf ${i}`, start: t0 + i * 3 * 3600000, end: t0 + i * 3 * 3600000 + 3600000, tz: 'Europe/Paris', calendarId: 'personal', allDay: false, exdates: [], overrides: {}, rrule: null, reminder: null });
      for (let i = 0; i < 40; i++) list.push({ id: `perfd${i}`, title: `Daily ${i}`, start: t0 - 400 * 86400000 + i * 600000, end: t0 - 400 * 86400000 + i * 600000 + 1800000, tz: 'Europe/Paris', calendarId: 'work', allDay: false, exdates: [], overrides: {}, rrule: { freq: 'DAILY', interval: 1 }, reminder: null });
      app.data.events = list;
      return list.length;
    }, t0);
    const times = {};
    for (const v of ['month', 'week', 'day', 'agenda']) {
      times[v] = await CAL(s, (app, v) => {
        app.state.date = new Date(2026, 9, 12);
        app.state.view = v;
        const a = performance.now();
        app.render({ animate: false });
        return performance.now() - a;
      }, v);
    }
    check(`${n} events: every view renders in < 800 ms`, times, (t) => Object.values(t).every((x) => x < 800));
    console.log(`    render times: ${Object.entries(times).map(([k, v]) => `${k} ${Math.round(v)} ms`).join(', ')}`);
    await CAL(s, async (app) => {
      app.data.events = app.data.events.filter((e) => !e.id.startsWith('perf'));
      await app.saveEvents();
    });
  });

  // ---------------------------------------------------------------- QA regressions (bugs found in review)
  await section('QA: quick create double submit, double click on Save', async () => {
    await setView(s, 'week', [2026, 10, 2]);
    const before = (await events(s)).length;
    const c = await slot(s, '2026-11-03', 10);
    await s.page.mouse.click(c.x, c.y);
    await until(() => popOpen(s, '.ac-pop-quick'), { label: 'quick create' });
    await sleep(150); // the title field gets the focus
    await s.page.keyboard.type('Twice');
    await s.page.keyboard.press('Enter');
    await s.page.keyboard.press('Enter');
    await sleep(500);
    check('Enter pressed twice creates one event', (await events(s)).filter((e) => e.title === 'Twice').length, 1);
    const c2 = await slot(s, '2026-11-04', 14);
    await s.page.mouse.click(c2.x, c2.y);
    await until(() => popOpen(s, '.ac-pop-quick'), { label: 'quick create 2' });
    await sleep(150);
    await s.page.keyboard.type('Dbl');
    const save = await rect(s, '.ac-pop-quick .btn.primary');
    await s.page.mouse.dblclick(save.x + 10, save.y + 10);
    await sleep(600);
    check('double click on Save creates one event', (await events(s)).filter((e) => e.title === 'Dbl').length, 1);
    check('…and opens neither the editor nor a new quick create', [await dialogOpen(s), await popOpen(s, '.ac-pop-quick')], [false, false]);
    check('two events added in all', (await events(s)).length, before + 2);
  });

  await section('QA: editor validates a typed time even before it is committed', async () => {
    await setView(s, 'week', [2026, 10, 2]);
    await CAL(s, (app, a) => {
      app.newEvent({ start: new Date(...a.s).getTime(), end: new Date(...a.e).getTime() });
    }, { s: [2026, 10, 5, 10], e: [2026, 10, 5, 11] });
    await until(() => dialogOpen(s), { label: 'editor' });
    await sleep(300);
    await s.page.fill(`${DLG} .ac-ed-title`, 'Typed end');
    await s.page.click(`${DLG} .ac-timefield >> nth=1`);
    await s.page.keyboard.press('Control+A');
    await s.page.keyboard.type('8:00');
    // click Save right away (no Tab / blur): the typed end is before the start
    await s.page.locator(`${DLG} .dialog-footer .btn.primary`).click();
    await sleep(400);
    check('not saved with an end before the start', !!(await evByTitle(s, 'Typed end')), false);
    check('error shown, editor still open', await run(s, `document.querySelector('${DLG} .ac-ed-error')?.textContent || ''`), (t) => t.length > 0);
    await s.page.click(`${DLG} .ac-timefield >> nth=1`);
    await s.page.keyboard.press('Control+A');
    await s.page.keyboard.type('12:15');
    await s.page.keyboard.press('Control+s');
    await sleep(500);
    const ev = await evByTitle(s, 'Typed end');
    check('Ctrl+S right after typing saves the typed end', ev && ev.end, await pageMs(s, 2026, 10, 5, 12, 15));
    check('editor closed', await dialogOpen(s), false);
  });

  await section('QA: work week of a Sunday follows the first day of the week', async () => {
    const first = await CAL(s, (app) => app.prefs.firstDay);
    await CAL(s, (app) => (app.prefs.firstDay = 0));
    await setView(s, 'workweek', [2026, 9, 11]);
    check('Sunday-first week: Sun Oct 11 -> Mon 12 … Fri 16', await run(s, `[...document.querySelectorAll('${WIN} .ac-tg-dh')].map((d) => d.dataset.date)`), ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16']);
    await CAL(s, (app) => (app.prefs.firstDay = 1));
    await setView(s, 'workweek', [2026, 9, 11]);
    check('Monday-first week: Sun Oct 11 -> Mon 5 … Fri 9', await run(s, `[...document.querySelectorAll('${WIN} .ac-tg-dh')].map((d) => d.dataset.date)`), ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09']);
    await CAL(s, (app, f) => (app.prefs.firstDay = f), first);
  });

  await section('QA: daylight-saving days draw events at their wall-clock time', async () => {
    await seed(s, [
      { id: 'dstA', title: 'DST autumn', start: await pageMs(s, 2026, 9, 25, 9), end: await pageMs(s, 2026, 9, 25, 10) },
      { id: 'dstS', title: 'DST spring', start: await pageMs(s, 2027, 2, 28, 9), end: await pageMs(s, 2027, 2, 28, 10, 30) },
    ]);
    for (const [id, date, h] of [
      ['dstA', [2026, 9, 25], 48 - 2],
      ['dstS', [2027, 2, 28], 72 - 2],
    ]) {
      await setView(s, 'day', date);
      const g = await run(s, `(() => { const e = document.querySelector('${WIN} .ac-ev[data-event-id="${id}"]'); return e && [parseFloat(e.style.top), parseFloat(e.style.height)]; })()`);
      check(`${id}: 09:00 block on the 9:00 line (top, height)`, g, [9 * 48, h]);
    }
    // resize on the autumn day: bottom edge to 11:00 -> ends at 11:00 wall-clock
    await setView(s, 'day', [2026, 9, 25]);
    const r = await rect(s, `${WIN} .ac-ev[data-event-id="dstA"] .ac-ev-resize`);
    const cols = await rect(s, `${WIN} .ac-tg-cols`);
    await drag(s, { x: r.x + r.w / 2, y: r.y + 3 }, { x: r.x + r.w / 2, y: cols.y + 11 * 48 + 2 }, 6);
    check('resize on a DST day ends at 11:00', (await evByTitle(s, 'DST autumn')).end, await pageMs(s, 2026, 9, 25, 11));
    // the current-time line and the hour labels share the same wall-clock scale
    check('hour label 9 AM at 9 × 48 px', await run(s, `parseFloat([...document.querySelectorAll('${WIN} .ac-tg-hour')][8].style.top)`), 9 * 48);
  });

  await section('QA: event blocks never show half a line', async () => {
    await seed(s, [{ id: 'cut1', title: 'One hour with place', start: await pageMs(s, 2026, 10, 10, 9), end: await pageMs(s, 2026, 10, 10, 10), location: 'Room with a long name' }]);
    await setView(s, 'week', [2026, 10, 10]);
    const g = await run(s, `(() => { const e = document.querySelector('${WIN} .ac-ev[data-event-id="cut1"]'); const r = e.getBoundingClientRect(); return [...e.querySelectorAll('.ac-ev-in > *')].map((x) => { const q = x.getBoundingClientRect(); return q.left >= r.right - 1 || q.bottom <= r.bottom + 0.5; }); })()`);
    check('every line is either fully inside the block or moved out of view', g, (a) => a.length >= 2 && a.every(Boolean));
  });

  await section('QA: keyboard focus stays in flyouts and in the window', async () => {
    await setView(s, 'week', [2026, 10, 10]);
    await s.page.focus(`${WIN} .ac-ev[data-event-id="cut1"]`);
    await s.page.keyboard.press(' ');
    await until(() => popOpen(s, '.ac-pop-peek'), { label: 'peek' });
    await sleep(100);
    const inPeek = [];
    for (let i = 0; i < 4; i++) {
      await s.page.keyboard.press('Tab');
      inPeek.push(await run(s, `!!document.activeElement.closest('.ac-pop-peek')`));
    }
    check('Tab cycles inside the event card', inPeek, [true, true, true, true]);
    await s.page.keyboard.press('Escape');
    await sleep(250);
    const inWin = [];
    for (let i = 0; i < 45; i++) {
      await s.page.keyboard.press('Tab');
      inWin.push(await run(s, `!!document.activeElement.closest('${WIN}')`));
    }
    check('Tab never leaves the window (wraps around)', inWin.every(Boolean), true);
    // Delete while a pane control has the focus does not delete the selected event
    await CAL(s, (app) => {
      const o = app.occurrences(new Date(2026, 10, 10), new Date(2026, 10, 11)).find((x) => x.eventId === 'cut1');
      app.select(o, null, { peek: false });
    });
    await s.page.focus(`${WIN} .ac-cal-more`);
    await s.page.keyboard.press('Delete');
    await sleep(300);
    check('Delete on a pane button keeps the event', !!(await evByTitle(s, 'One hour with place')), true);
    // AZERTY: the digit row types & é " ' ( — the view shortcuts follow the physical key
    await CAL(s, (app) => app.viewEl.focus());
    await run(s, `document.querySelector('${WIN} .ac-view').dispatchEvent(new KeyboardEvent('keydown', { key: 'é', code: 'Digit2', bubbles: true, cancelable: true })); 0`);
    check('AZERTY "é" (Digit2) -> Work week', await CAL(s, (app) => app.state.view), 'workweek');
  });

  await section('QA: series edit of the title keeps exceptions; multi-week rule gets WKST', async () => {
    await seed(s, [{ id: 'exc1', title: 'Biweekly club', start: await pageMs(s, 2026, 10, 1, 18), end: await pageMs(s, 2026, 10, 1, 19), rrule: { freq: 'WEEKLY', interval: 2, byday: ['SU', 'MO'], wkst: 'SU' } }]);
    // delete one occurrence and rename another (exceptions)
    await CAL(s, async (app) => {
      const occs = app.occurrences(new Date(2026, 10, 1), new Date(2026, 11, 31)).filter((o) => o.eventId === 'exc1');
      await app.applyOccurrenceEdit(occs[1], { title: 'Special session' });
      const ev = app.data.events.find((e) => e.id === 'exc1');
      const { deleteOccurrence } = await import('app://shell/apps/calendar/lib/events.mjs');
      await app.commit(app.data.events.map((e) => (e.id === 'exc1' ? deleteOccurrence(ev, occs[2].key) : e)));
    });
    const before = await evByTitle(s, 'Biweekly club');
    check('exceptions stored', [before.exdates.length, Object.keys(before.overrides).length], [1, 1]);
    await CAL(s, async (app) => {
      const ev = app.data.events.find((e) => e.id === 'exc1');
      const { openEditor } = await import('app://shell/apps/calendar/ui/editor.js');
      openEditor(app, { ev, occ: null, mode: 'series' });
    });
    await until(() => dialogOpen(s), { label: 'series editor' });
    await sleep(300);
    await s.page.fill(`${DLG} .ac-ed-title`, 'Biweekly club (renamed)');
    await s.page.locator(`${DLG} .dialog-footer .btn.primary`).click();
    await sleep(500);
    check('no "exceptions will be lost" prompt', await dialogOpen(s), false);
    const after = await evByTitle(s, 'Biweekly club (renamed)');
    check('exceptions kept after renaming the series', after && [after.exdates.length, Object.keys(after.overrides).length, after.rrule.wkst], [1, 1, 'SU']);
    // a new custom "every 2 weeks" rule follows the user's first day of the week
    const first = await CAL(s, (app) => app.prefs.firstDay);
    await CAL(s, (app) => {
      app.prefs.firstDay = 0;
      app.newEvent({ start: new Date(2026, 10, 1, 8).getTime(), end: new Date(2026, 10, 1, 9).getTime() });
    });
    await until(() => dialogOpen(s), { label: 'editor' });
    await sleep(300);
    await s.page.fill(`${DLG} .ac-ed-title`, 'Every other week');
    await s.page.selectOption(`${DLG} .ac-ed-repeat`, 'custom');
    await s.page.fill(`${DLG} .ac-ed-interval`, '2');
    await s.page.click(`${DLG} .ac-ed-day[aria-label="Monday"]`);
    await s.page.locator(`${DLG} .dialog-footer .btn.primary`).click();
    await sleep(500);
    const eow = await evByTitle(s, 'Every other week');
    check('custom every 2 weeks (Sunday-first) stores WKST=SU', eow && [eow.rrule.interval, eow.rrule.wkst, eow.rrule.byday], [2, 'SU', ['SU', 'MO']]);
    const occ = await CAL(s, (app) => app.occurrences(new Date(2026, 10, 1), new Date(2026, 10, 20)).filter((o) => o.eventId === app.data.events.find((e) => e.title === 'Every other week').id).map((o) => new Date(o.start).getDate()));
    check('Sun 1 + Mon 2, then Sun 15 + Mon 16 (same week, every other week)', occ, [1, 2, 15, 16]);
    await CAL(s, (app, f) => (app.prefs.firstDay = f), first);
  });

  await section('QA: import undo removes the new calendar; settings fit a small window', async () => {
    fs.writeFileSync(path.join(home, 'undo.ics'), ['BEGIN:VCALENDAR', 'VERSION:2.0', 'X-WR-CALNAME:Undo me', 'BEGIN:VEVENT', 'UID:undo1@test', 'DTSTART:20261120T100000Z', 'DTEND:20261120T110000Z', 'SUMMARY:Undo import', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n'));
    await run(s, `window.__aurora.shell.launch('calendar', { file: ${JSON.stringify(path.join(home, 'undo.ics'))} }); 0`);
    await until(async () => /Undo me/.test(await dialogText(s)), { label: 'import dialog' });
    await dialogButton(s, 'Import');
    check('calendar created by the import', await CAL(s, (app) => app.data.calendars.some((c) => c.name === 'Undo me')), true);
    await s.page.click(`${WIN} .ac-snack .ac-undo`);
    await sleep(400);
    check('Undo removes the events and the new calendar', await CAL(s, (app) => [app.data.events.some((e) => e.title === 'Undo import'), app.data.calendars.some((c) => c.name === 'Undo me')]), [false, false]);
    // settings dialog inside a minimum-size window
    await CAL(s, (app) => app.win.setSize(480, 440));
    await sleep(400);
    await s.page.click(`${WIN} .ac-more`);
    await s.page.locator('body > .menu .menu-item', { hasText: 'Calendar settings' }).click();
    await until(() => dialogOpen(s), { label: 'settings' });
    await sleep(300);
    const fit = await run(s, `(() => { const w = document.querySelector('${WIN}').getBoundingClientRect(); const d = document.querySelector('${DLG}').getBoundingClientRect(); const b = document.querySelector('${DLG} .dialog-body'); return d.left >= w.left - 1 && d.right <= w.right + 1 && b.scrollWidth <= b.clientWidth + 1; })()`);
    check('settings dialog fits a 480 px window', fit, true);
    await dialogButton(s, 'Cancel');
    await CAL(s, (app) => app.win.setSize(1180, 760));
    await sleep(300);
    // export to a place that can't be written: an error dialog, no toast
    await s.page.click(`${WIN} .ac-more`);
    await s.page.locator('body > .menu .menu-item', { hasText: 'Export all calendars' }).click();
    await until(() => run(s, `!!document.querySelector('${DLG}.fp-dialog .fp-bottom input')`), { label: 'save picker' });
    await sleep(200);
    // (a "folder" that is a file: the write fails whoever runs the test, root included)
    await s.page.fill(`${DLG}.fp-dialog .fp-bottom input`, path.join(home, 'team.ics', 'out.ics'));
    await s.page.keyboard.press('Enter');
    await until(async () => /couldn’t be exported/.test(await dialogText(s)), { label: 'export error' });
    check('export failure -> error dialog', await dialogText(s), (t) => t.includes('The calendar couldn’t be exported'));
    await dialogButton(s, 'OK');
    // creating an event in a hidden calendar shows that calendar (otherwise the event "disappears")
    await CAL(s, (app) => app.setCalendarVisible('birthdays', false));
    await setView(s, 'week', [2026, 10, 2]);
    const c = await slot(s, '2026-11-06', 15); // a free slot
    await s.page.mouse.click(c.x, c.y);
    await until(() => popOpen(s, '.ac-pop-quick'), { label: 'quick create' });
    await sleep(150);
    await s.page.selectOption('.ac-pop-quick .ac-cal-select', 'birthdays');
    await s.page.fill('.ac-pop-quick .ac-quick-title', 'Hidden calendar event');
    await s.page.keyboard.press('Enter');
    await sleep(500);
    check('the hidden calendar is shown again', await CAL(s, (app) => app.calendar('birthdays').visible), true);
    check('…and the new event is on screen', await run(s, `!!document.querySelector('${WIN} .ac-ev[data-event-id]') && [...document.querySelectorAll('${WIN} .ac-ev')].some((e) => e.textContent.includes('Hidden calendar event'))`), true);
  });

  // ---------------------------------------------------------------- QA3 regressions
  await section('QA3: "Delete occurrence" in the editor of one occurrence asks nothing more', async () => {
    await seed(s, [{ id: 'club', title: 'Book club', start: await pageMs(s, 2027, 0, 4, 19), end: await pageMs(s, 2027, 0, 4, 20), rrule: { freq: 'WEEKLY', byday: ['MO'] } }]);
    await setView(s, 'month', [2027, 0, 11]);
    const k = String(await pageMs(s, 2027, 0, 11, 19));
    await s.page.dblclick(`${WIN} .ac-chip[data-event-id="club"][data-key="${k}"]`);
    await until(() => dialogOpen(s), { label: 'series prompt' });
    await dialogButton(s, 'Just this one');
    await until(() => run(s, `!!document.querySelector('${DLG} .ac-ed-title')`), { label: 'occurrence editor' });
    await dialogButton(s, 'Delete occurrence');
    await sleep(300);
    check('no second "which occurrences?" question', await dialogOpen(s), false);
    check('that occurrence is deleted', (await evByTitle(s, 'Book club')).exdates, [k]);
    check('the others stay', await CAL(s, () => document.querySelectorAll('.win.app-calendar .ac-chip[data-event-id="club"]').length), (n) => n >= 3);
    await s.page.click(`${WIN} .ac-snack .ac-undo`);
    await sleep(400);
    check('Undo brings it back', (await evByTitle(s, 'Book club')).exdates, []);
  });

  await section('QA3: a reminder already due is shown right away; a snoozed one survives the next sync', async () => {
    await run(s, `window.__aurora.notifications.clear(); 0`);
    // starts in 10 minutes with a 15-minute reminder: its reminder time has passed
    const start = await run(s, `Math.ceil((Date.now() + 10 * 60000) / 60000) * 60000`);
    await seed(s, [{ id: 'soon', title: 'Stand-up soon', start, end: start + 1800000, reminder: 15, location: 'Room 2' }]);
    await sleep(400);
    const notes = () => run(s, `window.__aurora.notifications.list().filter((n) => n.appId === 'calendar' && n.title.startsWith('Stand-up')).map((n) => n.body)`);
    const n1 = await notes();
    check('the reminder is shown at once', n1.length, 1);
    check('…with the time and the place', n1[0] || '', (b) => b.endsWith('Room 2') && b.includes('–'));
    // another edit of the same event does not show it again
    await CAL(s, async (app) => app.applySeriesEdit(app.data.events.find((e) => e.id === 'soon'), { title: 'Stand-up soon!' }));
    await sleep(400);
    check('not shown twice', (await notes()).length, 1);
    // an event whose reminder time had already passed before (its reminder was shown by the scheduler):
    // renaming it does not show the reminder again
    await CAL(s, async (app, start) => {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      app.data.events.push({ id: 'shown', uid: 'shown@x', title: 'Already reminded', start, end: start + 1800000, reminder: 15, tz, calendarId: 'personal', allDay: false, exdates: [], overrides: {}, location: '', description: '', color: null, rrule: null });
      await app.applySeriesEdit(app.data.events.find((e) => e.id === 'shown'), { title: 'Already reminded (renamed)' });
    }, start);
    await sleep(300);
    check('no reminder for an edit of an event already due', await run(s, `window.__aurora.notifications.list().filter((n) => n.appId === 'calendar' && n.title.startsWith('Already reminded')).length`), 0);
    // …but changing its reminder so that it becomes due shows it
    await CAL(s, async (app, start) => {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      app.data.events.push({ id: 'remchg', uid: 'remchg@x', title: 'Reminder changed', start: start + 60000, end: start + 1800000, reminder: 5, tz, calendarId: 'personal', allDay: false, exdates: [], overrides: {}, location: '', description: '', color: null, rrule: null });
      await app.applySeriesEdit(app.data.events.find((e) => e.id === 'remchg'), { reminder: 30 });
    }, start);
    await sleep(300);
    check('a reminder made due by an edit is shown', await run(s, `window.__aurora.notifications.list().filter((n) => n.appId === 'calendar' && n.title === 'Reminder changed').length`), 1);
    await CAL(s, async (app) => app.commit(app.data.events.filter((e) => !['shown', 'remchg'].includes(e.id))));
    // an event 2 hours away with a 15-minute reminder: nothing yet, a normal scheduled reminder
    const later = start + 2 * 3600000;
    await seed(s, [{ id: 'later', title: 'Later meeting', start: later, end: later + 1800000, reminder: 15 }]);
    await sleep(300);
    check('a future reminder is only scheduled', await run(s, `[window.__aurora.notifications.list().some((n) => n.title === 'Later meeting'), window.__aurora.shell.reminders.list('calendar').filter((r) => r.data?.eventId === 'later').map((r) => r.at)]`), [false, [later - 15 * 60000]]);
    // snooze the reminder that was shown: the next sync keeps the snoozed copy
    const id = `evt-soon-${start}`;
    const kept = await CAL(s, async (app, id) => {
      const r = window.__aurora.shell.reminders;
      r.snooze(id, 'calendar', 5);
      const before = r.list('calendar').some((x) => x.id === id);
      await app.syncReminders();
      return [before, r.list('calendar').some((x) => x.id === id)];
    }, id);
    check('snoozed reminder kept by the sync', kept, [true, true]);
    // deleting the event removes the snoozed reminder too
    await CAL(s, async (app) => app.commit(app.data.events.filter((e) => e.id !== 'soon' && e.id !== 'later')));
    await sleep(300);
    check('…and removed with its event', await run(s, `window.__aurora.shell.reminders.list('calendar').filter((r) => ['soon', 'later'].includes(r.data?.eventId)).length`), 0);
    await run(s, `window.__aurora.notifications.clear(); 0`);
    // a big calendar never floods the shell scheduler: only the 64 soonest reminders are registered
    const base = await run(s, `(() => { const d = new Date(); d.setDate(d.getDate() + 3); d.setHours(8, 0, 0, 0); return d.getTime(); })()`);
    const many = Array.from({ length: 40 }, (_, i) => ({ id: `bulk${i}`, title: `Bulk ${i}`, start: base + i * 3600000, end: base + i * 3600000 + 1800000, reminder: 10, rrule: { freq: 'DAILY' } }));
    await CAL(s, async (app, many) => {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      await app.commit([...app.data.events, ...many.map((e) => ({ tz, calendarId: 'personal', allDay: false, exdates: [], overrides: {}, location: '', description: '', color: null, ...e }))]);
      await app.syncReminders();
    }, many);
    const bulk = await run(s, `window.__aurora.shell.reminders.list('calendar').filter((r) => String(r.data?.eventId).startsWith('bulk')).map((r) => r.at).sort((a, b) => a - b)`);
    const all = await run(s, `window.__aurora.shell.reminders.list('calendar').length`);
    check('at most 64 calendar reminders registered (40 daily series = 120 planned)', all <= 64 && bulk.length >= 60, true);
    check('…the soonest ones', bulk[0], base - 10 * 60000);
    await CAL(s, async (app) => app.commit(app.data.events.filter((e) => !e.id.startsWith('bulk'))));
    await sleep(300);
    check('…and all removed with their events', await run(s, `window.__aurora.shell.reminders.list('calendar').filter((r) => String(r.data?.eventId).startsWith('bulk')).length`), 0);
  });

  await section('QA3: an imported event with an absurd DURATION is limited; export and agenda still work', async () => {
    fs.writeFileSync(path.join(home, 'huge.ics'), ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:huge@test', 'DTSTART:20261021T080000Z', 'DURATION:P99999999W', 'SUMMARY:Huge', 'END:VEVENT', 'BEGIN:VEVENT', 'UID:far@test', 'DTSTART:99991231T080000Z', 'SUMMARY:Far future', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n'));
    await run(s, `window.__aurora.shell.launch('calendar', { file: ${JSON.stringify(path.join(home, 'huge.ics'))} }); 0`);
    await until(() => dialogOpen(s), { label: 'import dialog' });
    await dialogButton(s, 'Import');
    const huge = await evByTitle(s, 'Huge');
    check('imported, at most 10 years long', huge && huge.end - huge.start, (d) => d > 0 && d <= 3660 * 86400000);
    check('an event in year 9999 is skipped', !!(await evByTitle(s, 'Far future')), false);
    const ser = await CAL(s, async (app) => {
      const { serializeIcs } = await import('app://shell/apps/calendar/lib/ics.mjs');
      try {
        return serializeIcs({ name: 'x', events: app.data.events }).length > 0;
      } catch (e) {
        return e.message;
      }
    });
    check('export of all calendars still works', ser, true);
    await setView(s, 'agenda', [2026, 9, 21]);
    check('agenda renders (no error)', await run(s, `[!!document.querySelector('${WIN} .ac-view .empty .mono'), [...document.querySelectorAll('${WIN} .ac-ag-title')].some((t) => t.textContent === 'Huge')]`), [false, true]);
    await CAL(s, async (app) => app.commit(app.data.events.filter((e) => e.title !== 'Huge')));
  });

  await section('QA3: the event card fits the screen with a very long title and description', async () => {
    const long = 'Pneumonoultramicroscopicsilicovolcanoconiosis '.repeat(12);
    await seed(s, [{ id: 'longev', title: long.replace(/ /g, ''), location: long, description: long.repeat(4), start: await pageMs(s, 2026, 10, 18, 13), end: await pageMs(s, 2026, 10, 18, 14), calendarId: 'work' }]);
    await setView(s, 'week', [2026, 10, 18]);
    await CAL(s, (app) => {
      const o = app.occurrences(new Date(2026, 10, 18), new Date(2026, 10, 19)).find((x) => x.eventId === 'longev');
      app.select(o, app.viewEl.querySelector('[data-event-id="longev"]'));
    });
    await until(() => popOpen(s, '.ac-pop-peek'), { label: 'peek' });
    await sleep(300);
    const g = await run(s, `(() => { const p = document.querySelector('body > .ac-pop-peek').getBoundingClientRect(); const e = document.querySelector('.ac-pop-peek .ac-peek-edit').getBoundingClientRect(); const wa = window.__aurora.wm.workarea(); window.__peekDbg = [p.top, p.bottom, p.height, wa.y, wa.height, e.top, e.bottom]; return { top: p.top >= wa.y - 1, bottom: p.bottom <= wa.y + wa.height + 1, edit: e.bottom <= p.bottom && e.top >= p.top && e.bottom <= wa.y + wa.height, w: p.width }; })()`);
    if (!g.bottom) console.log('    peek geometry', await run(s, 'window.__peekDbg'));
    check('card inside the work area, Edit button reachable', g, { top: true, bottom: true, edit: true, w: 340 });
    await s.page.click('.ac-pop-peek .ac-peek-edit');
    await until(() => dialogOpen(s), { label: 'editor from long card' });
    check('Edit opens the editor', await run(s, `document.querySelector('${DLG} .ac-ed-title').value.length`), (n) => n > 400);
    await closeFlyouts(s);
    await CAL(s, async (app) => app.commit(app.data.events.filter((e) => e.id !== 'longev')));
  });

  await section('QA3: the mini calendar header opens the year view (months), like Windows 11', async () => {
    await setView(s, 'month', [2026, 9, 14]);
    const PANE = `${WIN} .ac-pane-mini`;
    await s.page.click(`${PANE} .ac-mini-title`);
    await sleep(300);
    check('12 months shown', await run(s, `document.querySelectorAll('${PANE} .ac-mini-month').length`), 12);
    check('title is the year', await run(s, `document.querySelector('${PANE} .ac-mini-title').textContent`), '2026');
    check('current month highlighted', await run(s, `document.querySelector('${PANE} .ac-mini-month.today')?.textContent`), (t) => /Oct/.test(t || ''));
    await shot(s, 'year-view');
    // the arrows change the year
    await s.page.click(`${PANE} .ac-mini-nav >> nth=1`);
    await sleep(300);
    check('next arrow -> 2027', await run(s, `document.querySelector('${PANE} .ac-mini-title').textContent`), '2027');
    await s.page.click(`${PANE} .ac-mini-month[data-month="2"]`);
    await sleep(350);
    check('picking March shows its days', [await run(s, `document.querySelector('${PANE} .ac-mini-title').textContent`), await run(s, `document.querySelectorAll('${PANE} .ac-mini-day').length`)], ['March 2027', 42]);
    check('the main view did not move', await CAL(s, (app) => app.state.date.toDateString()), 'Wed Oct 14 2026');
    // keyboard: Enter on the header, arrows, Enter on a month; Esc goes back
    await s.page.focus(`${PANE} .ac-mini-title`);
    await s.page.keyboard.press('Enter');
    await sleep(300);
    check('focus on the shown month', await run(s, `document.activeElement.dataset.month`), '2');
    await s.page.keyboard.press('ArrowDown');
    await s.page.keyboard.press('ArrowRight');
    check('ArrowDown + ArrowRight -> August', await run(s, `document.activeElement.dataset.month`), '7');
    await s.page.keyboard.press('Enter');
    await sleep(300);
    check('Enter opens August 2027, focus on a day', [await run(s, `document.querySelector('${PANE} .ac-mini-title').textContent`), await run(s, `document.activeElement.classList.contains('ac-mini-day')`)], ['August 2027', true]);
    await s.page.focus(`${PANE} .ac-mini-title`);
    await s.page.keyboard.press('Enter');
    await sleep(250);
    await s.page.keyboard.press('Escape');
    await sleep(250);
    check('Esc goes back to the days', await run(s, `document.querySelectorAll('${PANE} .ac-mini-day').length`), 42);
    // the date picker of the toolbar title has it too
    await s.page.click(`${WIN} .ac-title`);
    await until(() => popOpen(s, '.ac-pop-date'), { label: 'date picker' });
    await s.page.click('.ac-pop-date .ac-mini-title');
    await sleep(300);
    await s.page.click('.ac-pop-date .ac-mini-month[data-month="0"]');
    await sleep(300);
    await s.page.click('.ac-pop-date .ac-mini-day[data-date="2026-01-15"]');
    await sleep(400);
    check('picked Jan 15 through the year view', await CAL(s, (app) => app.state.date.toDateString()), 'Thu Jan 15 2026');
  });

  await section('QA: no listener or node leaks when the app is opened and closed', async () => {
    const cdp = await s.page.context().newCDPSession(s.page);
    const counts = async () => {
      const out = [];
      for (const target of ['window', 'document', 'document.body']) {
        const { result } = await cdp.send('Runtime.evaluate', { expression: target });
        const { listeners } = await cdp.send('DOMDebugger.getEventListeners', { objectId: result.objectId });
        out.push(listeners.length);
      }
      return out;
    };
    await CAL(s, (app) => app.win.close());
    await until(async () => !(await run(s, `!!document.querySelector('${WIN}')`)), { label: 'closed' });
    await sleep(300);
    // count the shell emitter subscriptions (settings, reminders) the app makes and releases
    await run(s, `(() => {
      const A = window.__aurora;
      window.__subs = { settings: 0, reminders: 0 };
      for (const [name, obj] of [['settings', A.settings], ['reminders', A.shell.reminders]]) {
        if (obj.__wrapped) continue;
        const on = obj.on.bind(obj);
        obj.on = (ev, fn) => { window.__subs[name]++; const off = on(ev, fn); let done = false; return () => { if (!done) { done = true; window.__subs[name]--; } return typeof off === 'function' ? off() : undefined; }; };
        obj.__wrapped = true;
      }
      return 0;
    })()`);
    const c0 = await counts();
    for (let i = 0; i < 15; i++) {
      await openCalendar(s);
      await CAL(s, (app, i) => app.setView(['month', 'week', 'day', 'agenda', 'workweek'][i % 5]), i);
      await run(s, `document.querySelector('${WIN} .ac-title').click(); 0`);
      await sleep(120);
      await CAL(s, (app) => app.win.close());
      await until(async () => !(await run(s, `!!document.querySelector('${WIN}')`)), { label: 'closed' });
    }
    await sleep(400);
    const c1 = await counts();
    check('window/document/body listeners unchanged after 15 open/close', c1, c0);
    check('settings / reminders subscriptions all released', await run(s, `window.__subs`), (v) => v && v.settings <= 0 && v.reminders <= 0);
    check('no calendar flyouts left in <body>', await run(s, `document.querySelectorAll('body > .ac-pop, body > .app-calendar').length`), 0);
    await cdp.detach().catch(() => {});
    await openCalendar(s);
  });

  await section('screenshots EN light + sizes', async () => {
    await CAL(s, async (app) => {
      app.data.events = app.data.events.filter((e) => !/^ov|^fly/.test(e.id));
      await app.saveEvents();
    });
    await seed(s, [
      { id: 'd1', title: 'Team standup', start: await pageMs(s, 2026, 9, 5, 9), end: await pageMs(s, 2026, 9, 5, 9, 30), calendarId: 'work', rrule: { freq: 'WEEKLY', byday: ['MO', 'TU', 'WE', 'TH', 'FR'] }, location: 'Teams' },
      { id: 'd2', title: 'Design review', start: await pageMs(s, 2026, 9, 13, 10), end: await pageMs(s, 2026, 9, 13, 11, 30), calendarId: 'work', location: 'Room Everest' },
      { id: 'd3', title: 'Lunch with Marie', start: await pageMs(s, 2026, 9, 15, 12, 30), end: await pageMs(s, 2026, 9, 15, 13, 30), location: 'Café de Flore' },
      { id: 'd4', title: 'Sprint planning', start: await pageMs(s, 2026, 9, 12, 10), end: await pageMs(s, 2026, 9, 12, 12), calendarId: 'work' },
      { id: 'd5', title: '1:1 with Alex', start: await pageMs(s, 2026, 9, 12, 10, 30), end: await pageMs(s, 2026, 9, 12, 11, 15), calendarId: 'work' },
      { id: 'd6', title: 'Dentist', start: await pageMs(s, 2026, 9, 14, 16), end: await pageMs(s, 2026, 9, 14, 17), reminder: 60 },
      { id: 'd7', title: 'Paris Web conference', allDay: true, start: '2026-10-14', end: '2026-10-17', calendarId: 'work' },
      { id: 'd8', title: 'Yoga', start: await pageMs(s, 2026, 9, 6, 18, 30), end: await pageMs(s, 2026, 9, 6, 19, 30), rrule: { freq: 'WEEKLY', byday: ['TU'] } },
      { id: 'd9', title: "Léa's birthday", allDay: true, start: '2026-10-22', end: '2026-10-23', calendarId: 'birthdays', rrule: { freq: 'YEARLY' } },
      { id: 'd10', title: 'Offsite', start: await pageMs(s, 2026, 9, 16, 9), end: await pageMs(s, 2026, 9, 16, 17), calendarId: 'work', location: 'Lyon' },
    ]);
    await CAL(s, (app) => app.setPref('weekNumbers', false));
    await setView(s, 'month', [2026, 9, 12]);
    await shot(s, 'month-light-en');
    await setView(s, 'week', [2026, 9, 12]);
    await shot(s, 'week-light-en');
    await setView(s, 'day', [2026, 9, 12]);
    await shot(s, 'day-light-en');
    await setView(s, 'agenda', [2026, 9, 12]);
    await shot(s, 'agenda-light-en');
    // maximized + minimum size
    await CAL(s, (app) => app.win.maximize());
    await sleep(500);
    await setView(s, 'week', [2026, 9, 12]);
    check('maximized: toolbar fits', await CAL(s, (app) => app.toolbar.scrollWidth <= app.toolbar.clientWidth + 1), true);
    await shot(s, 'week-maximized', false);
    await CAL(s, (app) => app.win.restore());
    await sleep(400);
    await CAL(s, (app) => app.win.setSize(1, 1)); // clamped to the minimum size
    await sleep(500);
    const size = await rect(s, WIN);
    check('minimum size respected', [Math.round(size.w), Math.round(size.h)], [480, 440]);
    for (const v of ['month', 'week', 'agenda']) {
      await setView(s, v, [2026, 9, 12]);
      check(`min size ${v}: no horizontal overflow`, await CAL(s, (app) => app.toolbar.scrollWidth <= app.toolbar.clientWidth + 1 && app.root.scrollWidth <= app.root.clientWidth + 1), true);
    }
    await shot(s, 'min-size');
    check('pane becomes an overlay', await CAL(s, (app) => app.root.classList.contains('pane-overlay')), true);
    await s.page.click(`${WIN} .ac-pane-toggle`);
    await sleep(350);
    check('overlay pane opens', await run(s, `getComputedStyle(document.querySelector('${WIN} .ac-pane')).visibility`), 'visible');
    await s.page.keyboard.press('Escape');
    await sleep(350);
    await CAL(s, (app) => app.win.setSize(1180, 760));
    await sleep(300);
  });

  await section('closing with an unsaved event asks Save / Don’t save / Cancel', async () => {
    await CAL(s, (app) => app.viewEl.focus());
    await s.page.keyboard.press('n');
    await until(() => dialogOpen(s), { label: 'editor' });
    await sleep(300);
    await s.page.fill(`${DLG} .ac-ed-title`, 'Unsaved idea');
    await CAL(s, (app) => {
      app.win.close();
    });
    await until(async () => /Save changes to this event/.test(await dialogText(s)), { label: 'unsaved prompt' });
    await shot(s, 'unsaved-prompt');
    await dialogButton(s, 'Cancel');
    check('Cancel keeps the window and the editor', await run(s, `!!document.querySelector('${WIN}') && !!document.querySelector('${DLG} .ac-ed-title')`), true);
    await CAL(s, (app) => {
      app.win.close();
    });
    await until(async () => /Save changes to this event/.test(await dialogText(s)), { label: 'unsaved prompt 2' });
    await dialogButton(s, 'Save');
    await until(async () => !(await run(s, `!!document.querySelector('${WIN}')`)), { label: 'closed after saving' });
    await openCalendar(s);
    check('Save saved the event before closing', !!(await evByTitle(s, 'Unsaved idea')), true);
  });

  await section('persistence across relaunch', async () => {
    const n = (await events(s)).length;
    await CAL(s, (app) => app.win.close());
    await until(async () => !(await run(s, `!!document.querySelector('${WIN}')`)), { label: 'closed' });
    await openCalendar(s);
    check('events reloaded', (await events(s)).length, n);
    check('prefs reloaded', await CAL(s, (app) => app.prefs.firstDay), 1);
  });

  await section('QA: an unreadable events.json is kept aside, not overwritten', async () => {
    await CAL(s, (app) => app.win.close());
    await until(async () => !(await run(s, `!!document.querySelector('${WIN}')`)), { label: 'closed' });
    const store = path.join(home, '.config', 'aurora', 'apps', 'calendar');
    const good = fs.readFileSync(path.join(store, 'events.json'), 'utf8');
    const cut = good.slice(0, Math.floor(good.length / 2)); // a truncated write (power loss…)
    fs.writeFileSync(path.join(store, 'events.json'), cut);
    await openCalendar(s);
    check('the app still starts (no events)', (await events(s)).length, 0);
    const copies = fs.readdirSync(store).filter((f) => /^events\.damaged-.*\.json$/.test(f));
    check('a copy of the damaged file is kept', copies.length, 1);
    check('…with the original bytes', copies.length ? fs.readFileSync(path.join(store, copies[0]), 'utf8') === cut : false, true);
    check('the user is told where the copy is', await run(s, `document.querySelector('${WIN} .ac-snack.show')?.textContent || ''`), (t) => t.includes(copies[0] || '?'));
    await seed(s, [{ id: 'after-damage', title: 'After damage', start: await pageMs(s, 2026, 10, 2, 9), end: await pageMs(s, 2026, 10, 2, 10) }]);
    check('the copy survives the next save', fs.existsSync(path.join(store, copies[0] || 'none')), true);
  });

  check('no console errors (English run)', errorsSince(s, mark0), []);
  await s.close();

  // ---------------------------------------------------------------- French + dark
  console.log('Calendar app (French, dark)');
  const homeFr = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-cal-fr-'));
  // damaged data files: the app keeps what is valid and never crashes
  const store = path.join(homeFr, '.config', 'aurora', 'apps', 'calendar');
  fs.mkdirSync(store, { recursive: true });
  fs.writeFileSync(path.join(store, 'calendars.json'), JSON.stringify('garbage'));
  fs.writeFileSync(path.join(store, 'prefs.json'), JSON.stringify({ firstDay: 9, view: 'nope', workStart: 30 }));
  fs.writeFileSync(
    path.join(store, 'events.json'),
    JSON.stringify([
      null,
      42,
      { title: 'no start' },
      { id: 'ok1', title: 'Valide', start: Date.UTC(2026, 9, 20, 8), end: Date.UTC(2026, 9, 20, 9), calendarId: 'nowhere' },
      { id: 'badrule', title: 'Règle cassée', allDay: true, start: '2026-10-21', end: 'x', rrule: { freq: 'NOPE' }, exdates: 'x', overrides: 5 },
      { id: 'badkey', title: 'Mauvaise date', allDay: true, start: '2026-02-30' },
    ]),
  );
  s = await launchShell({ home: homeFr, lang: 'fr', theme: 'dark', env: { TZ }, settings: { lang: 'fr', theme: 'dark' } });
  setRecover(s);
  const mark1 = s.logs.length;
  await section('French: damaged data files are repaired', async () => {
    await openCalendar(s);
    const st = await CAL(s, (app) => ({ cals: app.data.calendars.map((c) => c.id), prefs: [app.prefs.firstDay, app.prefs.view, app.prefs.workStart], evs: app.data.events.map((e) => [e.id, e.calendarId, e.allDay ? e.end : null, e.rrule]) }));
    check('default calendars restored', st.cals, ['personal', 'work', 'birthdays', 'holidays-fr', 'holidays-us']);
    check('invalid prefs reset', st.prefs, ['auto', 'month', 8]);
    check('valid events kept and repaired', st.evs, [
      ['ok1', 'personal', null, null],
      ['badrule', 'personal', '2026-10-22', null],
    ]);
  });

  await section('French: labels, Monday first, 24 h, FR holidays', async () => {
    await setView(s, 'month', [2026, 3, 6]);
    check('titre du mois', await run(s, `document.querySelector('${WIN} .ac-title-text').textContent`), 'avril 2026');
    check('lundi en premier', await run(s, `document.querySelector('${WIN} .ac-mo-wd .long').textContent`), 'lundi');
    check('Lundi de Pâques 2026-04-06', await run(s, `[...document.querySelectorAll('${WIN} .ac-chip.holiday')].filter((c) => c.dataset.key === '2026-04-06').map((c) => c.textContent)`), ['Lundi de Pâques']);
    check('fériés FR visibles, US masqués', await CAL(s, (app) => app.data.calendars.filter((c) => c.kind === 'holidays').map((c) => c.visible)), [true, false]);
    await setView(s, 'month', [2027, 4, 1]);
    check('Ascension 2027 + Lundi de Pentecôte 2027', await run(s, `[...document.querySelectorAll('${WIN} .ac-chip.holiday')].filter((c) => ['2027-05-06', '2027-05-17'].includes(c.dataset.key)).map((c) => c.textContent)`), ['Ascension', 'Lundi de Pentecôte']);
    await seed(s, [
      { id: 'f1', title: 'Réunion d’équipe', start: await pageMs(s, 2026, 9, 12, 9), end: await pageMs(s, 2026, 9, 12, 10, 30), calendarId: 'work', location: 'Salle Montmartre', rrule: { freq: 'WEEKLY', byday: ['MO'] }, reminder: 15 },
      { id: 'f2', title: 'Déjeuner avec Marie', start: await pageMs(s, 2026, 9, 13, 12, 30), end: await pageMs(s, 2026, 9, 13, 14), location: 'Café de Flore' },
      { id: 'f3', title: 'Conférence Paris Web', allDay: true, start: '2026-10-14', end: '2026-10-17', calendarId: 'work' },
      { id: 'f4', title: 'Revue de sprint', start: await pageMs(s, 2026, 9, 12, 9, 30), end: await pageMs(s, 2026, 9, 12, 11), calendarId: 'work' },
      { id: 'f5', title: 'Dentiste', start: await pageMs(s, 2026, 9, 15, 17), end: await pageMs(s, 2026, 9, 15, 18) },
      { id: 'f6', title: 'Anniversaire de Léa', allDay: true, start: '2026-10-22', end: '2026-10-23', calendarId: 'birthdays', rrule: { freq: 'YEARLY' } },
    ]);
    await setView(s, 'week', [2026, 9, 12]);
    check('heures 24 h', await run(s, `[...document.querySelectorAll('${WIN} .ac-tg-hour')].slice(8, 10).map((e) => e.textContent)`), ['09:00', '10:00']);
    check('libellé de la journée entière', await run(s, `document.querySelector('${WIN} .ac-tg-adlabel span').textContent`), 'Toute la journée');
    check('bloc en français', await run(s, `document.querySelector('${WIN} .ac-ev[data-event-id="f2"] .ac-ev-meta').textContent`), '12:30 – 14:00');
    check('toolbar fits in French', await CAL(s, (app) => app.toolbar.scrollWidth <= app.toolbar.clientWidth + 1 && app.titleText.scrollWidth <= app.titleText.clientWidth + 1), true);
    await shot(s, 'week-dark-fr');
    await setView(s, 'month', [2026, 9, 12]);
    await shot(s, 'month-dark-fr');
    await setView(s, 'agenda', [2026, 9, 12]);
    await shot(s, 'agenda-dark-fr');
    await setView(s, 'week', [2026, 9, 12]);
    await s.page.click(`${WIN} .ac-ev[data-event-id="f1"]`);
    await until(() => popOpen(s, '.ac-pop-peek'), { label: 'aperçu' });
    check('aperçu: répétition', await run(s, `document.querySelector('.ac-pop-peek').innerText`), (t) => t.includes('Toutes les semaines le lundi') && t.includes('15 minutes avant') && t.includes('lundi 12 octobre 2026 · 09:00 – 10:30'));
    await shot(s, 'peek-dark-fr');
    await closeFlyouts(s);
    await s.page.keyboard.press('n');
    await until(() => dialogOpen(s), { label: 'éditeur' });
    check('éditeur en français', await dialogText(s), (t) => t.includes('Nouvel événement') && t.includes('Toute la journée') && t.includes('Début') && t.includes('Fin'));
    check('options de répétition FR', await run(s, `[...document.querySelectorAll('${DLG} .ac-ed-repeat option')].map((o) => o.textContent).slice(0, 4)`), (t) => t[0] === 'Ne se répète pas' && t[1] === 'Tous les jours' && t[3].startsWith('Toutes les semaines le '));
    await s.page.selectOption(`${DLG} .ac-ed-repeat`, 'custom');
    await shot(s, 'editor-dark-fr');
    check('no horizontal overflow in the editor', await run(s, `(() => { const b = document.querySelector('${DLG} .dialog-body'); return b.scrollWidth <= b.clientWidth + 1; })()`), true);
    await s.page.keyboard.press('Escape');
    await until(async () => /Abandonner les modifications/.test(await dialogText(s)), { label: 'discard prompt' });
    await dialogButton(s, 'Abandonner');
    check('editor closed after discarding', await dialogOpen(s), false);
    // reminders are written in French
    const r = await run(s, `window.__aurora.shell.reminders.list('calendar')[0] || null`);
    check('rappel en français (24 h)', r && r.body, (b) => /^\S+ \d+ \S+ · \d\d:\d\d – \d\d:\d\d · Salle Montmartre$/.test(b || ''));
  });
  await section('French: minimum size', async () => {
    await CAL(s, (app) => app.win.setSize(480, 440));
    await sleep(400);
    for (const v of ['month', 'week', 'day', 'agenda']) {
      await setView(s, v, [2026, 9, 12]);
      check(`FR min ${v}: fits`, await CAL(s, (app) => app.toolbar.scrollWidth <= app.toolbar.clientWidth + 1 && app.root.scrollWidth <= app.root.clientWidth + 1), true);
    }
    await setView(s, 'month', [2026, 9, 12]);
    await shot(s, 'min-size-dark-fr');
  });
  await section('French: agenda times never cut, shortcut key names', async () => {
    // still at the minimum size (previous section): "Toute la journée" wraps instead of being cut
    await setView(s, 'agenda', [2026, 9, 12]);
    check('agenda: no cut time label', await run(s, `[...document.querySelectorAll('${WIN} .ac-ag-when')].filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.textContent)`), []);
    await CAL(s, (app) => app.win.setSize(1180, 760));
    await sleep(300);
    await CAL(s, (app) => app.viewEl.focus());
    await s.page.keyboard.press('?');
    await until(() => dialogOpen(s), { label: 'raccourcis' });
    const keys = await run(s, `[...document.querySelectorAll('${DLG} .ac-keys kbd')].map((k) => k.textContent)`);
    check('noms des touches en français', keys, (k) => ['Entrée', 'Suppr', 'Échap', 'Pg préc', 'Pg suiv', 'Ctrl', 'Alt'].every((x) => k.includes(x)) && !k.some((x) => /^(Enter|Delete|Esc|Page Up|Page Down)$/.test(x)));
    await shot(s, 'shortcuts-dark-fr');
    await dialogButton(s, 'Fermer');
  });
  check('no console errors (French run)', errorsSince(s, mark1), []);
  await s.close();

  // ---------------------------------------------------------------- shell start without the app
  console.log('Shell start (Calendar not opened)');
  await section('QA3: reminders are planned again at shell start, without opening Calendar', async () => {
    const homeBoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-cal-boot-'));
    const st = path.join(homeBoot, '.config', 'aurora', 'apps', 'calendar');
    fs.mkdirSync(st, { recursive: true });
    const start = Math.ceil((Date.now() + 3 * 86400000) / 3600000) * 3600000;
    fs.writeFileSync(path.join(st, 'events.json'), JSON.stringify([{ id: 'boot1', title: 'Boot check', start, end: start + 3600000, reminder: 60, tz: TZ, calendarId: 'personal' }]));
    const sb = await launchShell({ home: homeBoot, lang: 'en', theme: 'light', env: { TZ }, settings: { lang: 'en', theme: 'light' } });
    try {
      const ids = await until(() => sb.page.evaluate(`window.__aurora.shell.reminders.list('calendar').map((r) => r.id + '@' + r.at).join()`), { timeout: 20000, label: 'boot resync' });
      check('the event’s reminder is registered after start', ids, `evt-boot1-${start}@${start - 3600000}`);
      check('the Calendar app was not opened', await sb.page.evaluate(`!!document.querySelector('${WIN}')`), false);
      check('no console errors at start', errorsSince(sb, 0), []);
    } finally {
      await sb.close();
      fs.rmSync(homeBoot, { recursive: true, force: true });
    }
  });
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(homeFr, { recursive: true, force: true });
}

for (const f of failures) console.log(`  ✗ ${f}`);
console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
