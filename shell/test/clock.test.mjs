// Clock tests — drive the real Electron shell with Playwright.
//   Time math (alarm next occurrence incl. repeat days, past times, DST gap / overlap; zone offsets incl.
//   half-hour / 45-min zones and DST; formatting), focus plans, solar position, sunrise / sunset;
//   alarms (add / edit / toggle / delete through the UI, mirrored in shell.reminders, one-shot alarm turns
//   itself off when it rings, Snooze on the notification), timers (accuracy, pause / resume, +1 min,
//   presets, expanded view, done state + notification, notification click opens the timer page),
//   stopwatch (Space / L / R keys, laps with fastest / slowest, copy laps, keeps running while closed),
//   world clock (search incl. other-language names, offsets, reorder, remove, compare mode, the day / night
//   terminator checked point by point against the solar math, pins), focus sessions (Do not disturb offer +
//   restore on stop and on completion, pause / resume reminders, already-on DND left alone, daily progress),
//   settings (tones, per-timer sound), keyboard navigation, reconcile on launch (things that fired while
//   Clock was closed), French + dark theme, minimum and maximized sizes, and console errors.
//   Documentation screenshots: aurora-os/docs/screenshots/clock-*.png
// Usage:  cd aurora-os/shell && xvfb-run -a -s "-screen 0 1600x900x24" node test/clock.test.mjs [--only=world]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchShell, ROOT } from './lib.mjs';

const DOCS = path.join(ROOT, '..', 'docs', 'screenshots');
fs.mkdirSync(DOCS, { recursive: true });
const only = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7).toLowerCase();

let passed = 0;
const failures = [];
function check(name, actual, expected) {
  const ok = typeof expected === 'function' ? !!expected(actual) : Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++;
  else failures.push(`${name}\n      expected: ${typeof expected === 'function' ? '(predicate)' : JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
  return ok;
}
let current = null;
async function section(name, fn) {
  if (only && !name.toLowerCase().includes(only)) return;
  const t0 = Date.now();
  const before = failures.length;
  try {
    await fn();
    console.log(`  ${failures.length === before ? '✓' : '✗'} ${name} (${Date.now() - t0} ms)`);
  } catch (err) {
    failures.push(`${name}: threw ${err?.stack || err}`);
    console.log(`  ✗ ${name}: ${err?.message || err}`);
  }
  // leave no dialog / menu open for the next section
  if (current) {
    for (let i = 0; i < 5; i++) {
      const busy = await current.page.evaluate(`!!document.querySelector('.win.app-clock > .dialog-layer:not(.closing), .menu')`).catch(() => false);
      if (!busy) break;
      await current.page.keyboard.press('Escape').catch(() => {});
      await sleep(250);
    }
  }
}

const WIN = '.win.app-clock';
const DLG = `${WIN} > .dialog-layer:not(.closing) .dialog`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Evaluate fn(app, arg) in the shell for the Clock window (expression string: the page CSP forbids eval).
function CK(s, fn, arg) {
  return s.page.evaluate(`(async () => { const el = document.querySelector(${JSON.stringify(WIN)}); return (${fn.toString()})(el && el.__clock, ${JSON.stringify(arg ?? null)}); })()`);
}
async function until(s, fn, { timeout = 6000, step = 60, label = 'condition', arg } = {}) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    last = await CK(s, fn, arg).catch((e) => `ERR ${e.message}`);
    if (last && !(typeof last === 'string' && last.startsWith('ERR'))) return last;
    await sleep(step);
  }
  throw new Error(`timed out waiting for ${label} (last: ${JSON.stringify(last)})`);
}
const reminders = (s) => CK(s, (app) => app.shell.reminders.list('clock'));
const go = (s, page) => CK(s, (app, p) => app.go(p, { animate: false }) && true, page);
async function dialogButton(s, label) {
  await s.page.waitForSelector(DLG, { timeout: 5000 });
  await s.page.locator(`${DLG} .dialog-footer .btn`, { hasText: label }).first().click();
  await sleep(250);
}
async function shot(s, name, { clip = true } = {}) {
  await sleep(350);
  const file = path.join(DOCS, `clock-${name}.png`);
  let rect = null;
  if (clip) rect = await s.page.evaluate(`(() => { const r = document.querySelector(${JSON.stringify(WIN)}).getBoundingClientRect(); return { x: Math.max(0, r.x - 1), y: Math.max(0, r.y - 1), width: r.width + 2, height: r.height + 2 }; })()`);
  await s.page.screenshot({ path: file, ...(rect ? { clip: rect } : {}) });
  return file;
}
function clockErrors(s) {
  return s.logs.filter((l) => /^\[(error|pageerror)\]/.test(l) && /clock|apps\/clock/i.test(l));
}

// ================================================================== launch A: English, light, Paris
async function runEnglish() {
  const s = await launchShell({ open: ['clock'], lang: 'en', theme: 'light', env: { TZ: 'Europe/Paris' } });
  current = s;
  try {
    await s.page.waitForSelector(`${WIN} .ck`, { timeout: 20000 });
    await until(s, (app) => !!app?.store, { label: 'clock ready' });

    await section('time math: alarm next occurrence (repeat days, past times, DST)', async () => {
      const r = await CK(s, async () => {
        const T = await import('app://shell/apps/clock/lib/time.js');
        const L = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi).getTime();
        const n = T.nextAlarmOccurrence;
        // 2026-10-14 is a Wednesday
        return {
          laterToday: n({ hour: 18, minute: 0, days: [] }, L(2026, 10, 14, 10, 0)) === L(2026, 10, 14, 18, 0),
          pastToday: n({ hour: 9, minute: 0, days: [] }, L(2026, 10, 14, 10, 0)) === L(2026, 10, 15, 9, 0),
          sameMinute: n({ hour: 10, minute: 0, days: [] }, L(2026, 10, 14, 10, 0)) === L(2026, 10, 15, 10, 0),
          monWedFriFromFri: n({ hour: 7, minute: 0, days: [1, 3, 5] }, L(2026, 10, 16, 10, 0)) === L(2026, 10, 19, 7, 0),
          wedOnlyPassed: n({ hour: 9, minute: 0, days: [3] }, L(2026, 10, 14, 10, 0)) === L(2026, 10, 21, 9, 0),
          weekend: n({ hour: 8, minute: 30, days: [0, 6] }, L(2026, 10, 14, 10, 0)) === L(2026, 10, 17, 8, 30),
          // 2026-03-29: Paris jumps 02:00 -> 03:00; 02:30 does not exist and rings at 03:30 CEST (01:30 UTC)
          springGap: n({ hour: 2, minute: 30, days: [] }, Date.UTC(2026, 2, 28, 23, 0)) === Date.UTC(2026, 2, 29, 1, 30),
          // 2026-10-25: 03:00 -> 02:00; a daily 07:00 alarm stays at 07:00 wall time (25 h later)
          fallBackHours: (n({ hour: 7, minute: 0, days: [0, 1, 2, 3, 4, 5, 6] }, Date.UTC(2026, 9, 24, 5, 1)) - Date.UTC(2026, 9, 24, 5, 0)) / 3600000,
          fallBackUtc: n({ hour: 7, minute: 0, days: [0, 1, 2, 3, 4, 5, 6] }, Date.UTC(2026, 9, 24, 5, 1)) === Date.UTC(2026, 9, 25, 6, 0),
          springDaily: (n({ hour: 7, minute: 0, days: [0, 1, 2, 3, 4, 5, 6] }, Date.UTC(2026, 2, 28, 6, 1)) - Date.UTC(2026, 2, 28, 6, 0)) / 3600000,
        };
      });
      for (const [k, v] of Object.entries(r)) if (typeof v === 'boolean') check(`next occurrence: ${k}`, v, true);
      check('fall back day: 25 h between two 07:00 alarms', r.fallBackHours, 25);
      check('spring forward day: 23 h between two 07:00 alarms', r.springDaily, 23);
    });

    await section('time math: zone offsets (half-hour, 45-min, DST), formatting, focus plans', async () => {
      const r = await CK(s, async (app) => {
        const T = await import('app://shell/apps/clock/lib/time.js');
        const S = await import('app://shell/apps/clock/lib/store.js');
        const oct = Date.UTC(2026, 9, 10, 12, 0); // Paris = UTC+2
        const dec = Date.UTC(2026, 11, 10, 12, 0); // Paris = UTC+1
        const mar = Date.UTC(2026, 2, 20, 12, 0); // New York already on DST, Paris not yet
        const t = app.t;
        return {
          local: T.localZone(),
          kolkataUtc: T.zoneOffset('Asia/Kolkata', oct),
          kolkata: T.offsetFromLocal('Asia/Kolkata', oct),
          kathmandu: T.offsetFromLocal('Asia/Kathmandu', oct),
          newYorkOct: T.offsetFromLocal('America/New_York', oct),
          newYorkMar: T.offsetFromLocal('America/New_York', mar),
          adelaideOct: T.offsetFromLocal('Australia/Adelaide', oct),
          adelaideJul: T.offsetFromLocal('Australia/Adelaide', Date.UTC(2026, 6, 1, 12)),
          sydneyDec: T.offsetFromLocal('Australia/Sydney', dec),
          chatham: T.zoneOffset('Pacific/Chatham', dec),
          stJohns: T.zoneOffset('America/St_Johns', dec),
          short330: T.shortOffset(t, 210),
          shortNeg: T.shortOffset(t, -360),
          short0: T.shortOffset(t, 0),
          long: T.longOffset(t, 225),
          tokyoTomorrow: T.dayDelta('Asia/Tokyo', Date.UTC(2026, 9, 10, 21, 30)),
          honoluluYesterday: T.dayDelta('Pacific/Honolulu', Date.UTC(2026, 9, 10, 23, 30)),
          ringsIn: T.ringsIn(t, 7 * 3600000 + 15 * 60000),
          ringsInDays: T.ringsIn(t, 26 * 3600000 + 5 * 60000),
          ringsSoon: T.ringsIn(t, 30000),
          hms: T.hms(3661000),
          sw: T.swText(3723456),
          wall12: T.wallTime(18, 45, { locale: 'en-US', h12: true }).full,
          wall24: T.wallTime(7, 5, { locale: 'fr-FR', h12: false }).full,
          h12en: T.uses12h('en-US', null),
          h12fr: T.uses12h('fr-FR', null),
          h12forced: T.uses12h('en-US', true),
          weekFr: T.weekOrder('fr-FR')[0],
          weekUs: T.weekOrder('en-US')[0],
          plan60: S.planSegments(60, 30, 5).map((g) => `${g.type[0]}${g.ms / 60000}`).join(' '),
          plan35: S.planSegments(35, 30, 5).map((g) => `${g.type[0]}${g.ms / 60000}`).join(' '),
          plan90: S.planSegments(90, 25, 5).map((g) => `${g.type[0]}${g.ms / 60000}`).join(' '),
          plan240breaks: S.planSegments(240, 30, 5).filter((g) => g.type === 'break').length,
          planSkip: S.planSegments(120, 30, 5, true).length,
          durName: T.durationName(t, 150000),
        };
      });
      check('test runs in Europe/Paris', r.local, 'Europe/Paris');
      check('Asia/Kolkata is UTC+5:30', r.kolkataUtc, 330);
      check('Kolkata vs Paris in October: +3 h 30', r.kolkata, 210);
      check('Kathmandu vs Paris: +3 h 45', r.kathmandu, 225);
      check('New York vs Paris in October: −6 h', r.newYorkOct, -360);
      check('New York vs Paris in March (US DST first): −5 h', r.newYorkMar, -300);
      check('Adelaide vs Paris in October (both DST): +8 h 30', r.adelaideOct, 510);
      check('Adelaide vs Paris in July: +7 h 30', r.adelaideJul, 450);
      check('Sydney vs Paris in December: +10 h', r.sydneyDec, 600);
      check('Chatham in December is UTC+13:45', r.chatham, 825);
      check("St John's in December is UTC−3:30", r.stJohns, -210);
      check('short offset with minutes', r.short330, '+3 h 30');
      check('short negative offset', r.shortNeg, '−6 h');
      check('same time', r.short0, 'Same time');
      check('long offset', r.long, '3 hours 45 minutes ahead');
      check('Tokyo is tomorrow late in the evening', r.tokyoTomorrow, 1);
      check('Honolulu is yesterday just after midnight', r.honoluluYesterday, -1);
      check('rings in text', r.ringsIn, 'Rings in 7 hours, 15 minutes');
      check('rings in (days)', r.ringsInDays, 'Rings in 1 day, 2 hours');
      check('rings soon', r.ringsSoon, 'Rings in less than a minute');
      check('hh:mm:ss', r.hms, '01:01:01');
      check('stopwatch text', r.sw, '01:02:03.45');
      check('12-hour wall time', r.wall12, '6:45 PM');
      check('24-hour wall time (fr)', r.wall24, '07:05');
      check('en-US uses 12 h by default', r.h12en, true);
      check('fr-FR uses 24 h by default', r.h12fr, false);
      check('clock24h setting wins', r.h12forced, false);
      check('French weeks start on Monday', r.weekFr, 1);
      check('US weeks start on Sunday', r.weekUs, 0);
      check('60 min focus plan', r.plan60, 'f30 b5 f30');
      check('35 min focus plan (no tiny tail)', r.plan35, 'f35');
      check('90 min plan with 25-min periods', r.plan90, 'f25 b5 f25 b5 f25 b5 f15');
      check('240 min plan has 7 breaks', r.plan240breaks, 7);
      check('skip breaks', r.planSkip, 1);
      check('timer name from its length', r.durName, '2 min 30 sec');
    });

    await section('solar math: declination, subsolar point, sunrise / sunset, polar day', async () => {
      const r = await CK(s, async () => {
        const S = await import('app://shell/apps/clock/lib/sun.js');
        const jun = S.solarPosition(Date.UTC(2026, 5, 21, 12, 0));
        const dec = S.solarPosition(Date.UTC(2026, 11, 21, 12, 0));
        const mar = S.solarPosition(Date.UTC(2026, 2, 20, 15, 0));
        const parisDay = new Date(2026, 5, 21).getTime();
        const paris = S.sunTimes(48.86, 2.35, parisDay);
        const tromsoJun = S.sunTimes(69.65, 18.96, parisDay);
        const tromsoDec = S.sunTimes(69.65, 18.96, new Date(2026, 11, 21).getTime());
        const fmt = (t) => new Date(t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' });
        return {
          junDecl: jun.decl,
          junLon: jun.subLon,
          decDecl: dec.decl,
          marDecl: mar.decl,
          rise: fmt(paris.rise),
          set: fmt(paris.set),
          riseMin: (paris.rise - new Date(2026, 5, 21, 5, 47).getTime()) / 60000,
          setMin: (paris.set - new Date(2026, 5, 21, 21, 58).getTime()) / 60000,
          polarDay: tromsoJun.polar,
          polarNight: tromsoDec.polar,
          equatorNoon: S.sunAltitude(0, 0, Date.UTC(2026, 2, 20, 12, 7)),
        };
      });
      check('June solstice declination ≈ +23.4°', r.junDecl, (v) => Math.abs(v - 23.44) < 0.3);
      check('June solstice noon UTC: subsolar longitude ≈ 0°', r.junLon, (v) => Math.abs(v) < 1.5);
      check('December solstice declination ≈ −23.4°', r.decDecl, (v) => Math.abs(v + 23.44) < 0.3);
      check('March equinox declination ≈ 0°', r.marDecl, (v) => Math.abs(v) < 0.7);
      check(`Paris sunrise on June 21 ≈ 05:47 (got ${r.rise})`, r.riseMin, (v) => Math.abs(v) <= 4);
      check(`Paris sunset on June 21 ≈ 21:58 (got ${r.set})`, r.setMin, (v) => Math.abs(v) <= 4);
      check('Tromsø midnight sun', r.polarDay, 'day');
      check('Tromsø polar night', r.polarNight, 'night');
      check('sun is overhead at the equator on the equinox', r.equatorNoon, (v) => v > 88);
    });

    await section('navigation: pane, pill, Ctrl+1..5, Ctrl+comma, arrow keys, narrow overlay', async () => {
      await s.page.click(`${WIN} .ck-nav-item[data-page="alarm"]`);
      check('click selects Alarm', await CK(s, (app) => app.pageId), 'alarm');
      check('selected item marked', await s.page.getAttribute(`${WIN} .ck-nav-item[data-page="alarm"]`, 'aria-selected'), 'true');
      await s.page.keyboard.press('Control+4');
      check('Ctrl+4 -> Stopwatch', await CK(s, (app) => app.pageId), 'stopwatch');
      await s.page.keyboard.press('Control+1');
      check('Ctrl+1 -> Focus sessions', await CK(s, (app) => app.pageId), 'focus');
      await s.page.keyboard.press('Control+,');
      check('Ctrl+, -> Settings', await CK(s, (app) => app.pageId), 'settings');
      await s.page.focus(`${WIN} .ck-nav-item[data-page="timer"]`);
      await s.page.keyboard.press('ArrowDown');
      check('ArrowDown moves focus in the pane', await s.page.evaluate(`document.activeElement?.dataset?.page`), 'alarm');
      await s.page.keyboard.press('Enter');
      check('Enter opens the focused page', await CK(s, (app) => app.pageId), 'alarm');
      await sleep(300);
      const pill = await CK(s, (app) => {
        const p = app.pill.getBoundingClientRect();
        const it = app.navItems.alarm.getBoundingClientRect();
        return { dy: Math.abs(p.top + p.height / 2 - (it.top + it.height / 2)), dx: Math.abs(p.left - it.left) };
      });
      check('selection pill sits on the selected item', pill, (v) => v.dy < 2 && v.dx < 2);
      // hamburger collapses / expands the pane (remembered)
      await s.page.click(`${WIN} .ck-burger`);
      await sleep(300);
      check('collapsed pane is 48 px', await CK(s, (app) => app.navEl.getBoundingClientRect().width), (w) => Math.abs(w - 48) < 2);
      check('collapse remembered', await CK(s, (app) => app.store.prefs.navCollapsed), true);
      await s.page.click(`${WIN} .ck-burger`);
      await sleep(300);
      check('expanded again', await CK(s, (app) => app.navEl.getBoundingClientRect().width), (w) => w > 200);
      check('page remembered in prefs', await CK(s, (app) => app.store.prefs.page), 'alarm');
    });

    await section('alarms: add through the dialog (wheel picker by keyboard), mirrored in shell.reminders', async () => {
      await go(s, 'alarm');
      await s.page.click(`${WIN} .ck-page-alarm .ck-cmd-add`);
      await s.page.waitForSelector(`${DLG} .ck-picker`);
      await sleep(120);
      check('hour wheel focused', await s.page.evaluate(`document.activeElement?.getAttribute('aria-label')`), 'Hours');
      await s.page.keyboard.type('6');
      await s.page.keyboard.press('Tab');
      await s.page.keyboard.type('45');
      await s.page.keyboard.press('Tab');
      await s.page.keyboard.press('p');
      const picked = await s.page.evaluate(`[...document.querySelectorAll(${JSON.stringify(DLG + ' .ck-spin')})].map((e) => e.getAttribute('aria-valuetext'))`);
      check('picker shows 6 : 45 PM', picked, ['6', '45', 'PM']);
      // the up chevron / wheel increase the value
      await s.page.hover(`${DLG} .ck-spin[aria-label="Minutes"]`);
      await s.page.click(`${DLG} .ck-spin[aria-label="Minutes"] .ck-spin-btn.up`);
      await s.page.mouse.wheel(0, 120);
      await sleep(100);
      check('chevron +1 then wheel down −3 = 43', await s.page.getAttribute(`${DLG} .ck-spin[aria-label="Minutes"]`, 'aria-valuenow'), '43');
      await s.page.focus(`${DLG} .ck-spin[aria-label="Minutes"]`);
      await s.page.keyboard.press('ArrowUp');
      await s.page.keyboard.press('ArrowUp');
      check('ArrowUp ×2 = 45', await s.page.getAttribute(`${DLG} .ck-spin[aria-label="Minutes"]`, 'aria-valuenow'), '45');
      check('preview shows when it rings', await s.page.textContent(`${DLG} .ck-dlg-preview`), (v) => /^Rings in /.test(v));
      await s.page.fill(`${DLG} input[type="text"]`, 'Test alarm');
      await dialogButton(s, 'Save');
      const a = await CK(s, (app) => app.store.alarms.find((x) => x.name === 'Test alarm'));
      check('alarm saved 18:45, once, on', a && [a.hour, a.minute, a.days.length, a.enabled], [18, 45, 0, true]);
      const card = `${WIN} .ck-alarm[data-id="${a.id}"]`;
      check('card time', await s.page.textContent(`${card} .ck-alarm-clock`), '6:45');
      check('card period', await s.page.textContent(`${card} .ck-alarm-period`), 'PM');
      check('card says only once', await s.page.textContent(`${card} .ck-alarm-days`), 'Only once');
      check('card rings-in text', await s.page.textContent(`${card} .ck-alarm-when-text`), (v) => /^Rings in (\d+ hours?, )?\d+ minutes?$|^Rings in \d+ hours?$|^Rings in less/.test(v));
      const rem = (await reminders(s)).find((r) => r.id === `alarm-${a.id}`);
      const expectAt = await CK(s, async () => {
        const T = await import('app://shell/apps/clock/lib/time.js');
        return T.nextAlarmOccurrence({ hour: 18, minute: 45, days: [] }, Date.now());
      });
      check('reminder registered', !!rem, true);
      check('reminder fields', rem && { kind: rem.kind, repeat: rem.repeat, title: rem.title, body: rem.body, snooze: rem.snoozeMinutes, data: rem.data, hasSound: Array.isArray(rem.sound) }, { kind: 'alarm', repeat: null, title: 'Test alarm', body: '6:45 PM', snooze: 10, data: { alarmId: a.id }, hasSound: true });
      check('reminder at = next occurrence', rem?.at, expectAt);
      // toggle off / on from the card
      await s.page.click(`${card} .ck-alarm-toggle`);
      await sleep(150);
      check('toggle off removes the reminder', (await reminders(s)).some((r) => r.id === `alarm-${a.id}`), false);
      check('card dimmed when off', await s.page.evaluate(`document.querySelector('${card}').classList.contains('off')`), true);
      check('card says Off', await s.page.textContent(`${card} .ck-alarm-when-text`), 'Off');
      await s.page.click(`${card} .ck-alarm-toggle`);
      await sleep(150);
      check('toggle on registers it again', (await reminders(s)).some((r) => r.id === `alarm-${a.id}`), true);
      // edit: repeat on Monday and Tuesday
      await s.page.click(`${card} .ck-alarm-name`);
      await s.page.waitForSelector(`${DLG} .ck-days`);
      check('edit dialog title', await s.page.textContent(`${DLG} .dialog-title`), 'Edit alarm');
      await s.page.click(`${DLG} .ck-day[data-day="1"]`);
      await s.page.click(`${DLG} .ck-day[data-day="2"]`);
      check('picking days ticks Repeat', await s.page.isChecked(`${DLG} .ck-dlg-check input`), true);
      await s.page.selectOption(`${DLG} select[aria-label="Snooze time"]`, '5');
      await s.page.selectOption(`${DLG} select[aria-label="Alarm sound"]`, 'xylophone');
      await dialogButton(s, 'Save');
      const r2 = (await reminders(s)).find((r) => r.id === `alarm-${a.id}`);
      const exp2 = await CK(s, async () => (await import('app://shell/apps/clock/lib/time.js')).nextAlarmOccurrence({ hour: 18, minute: 45, days: [1, 2] }, Date.now()));
      check('repeat days mirrored', r2?.repeat, { days: [1, 2] });
      check('snooze mirrored', r2?.snoozeMinutes, 5);
      check('next occurrence on Mon/Tue', r2?.at, exp2);
      check('day chips highlighted', await s.page.evaluate(`[...document.querySelectorAll('${card} .ck-chip.on')].map((e) => e.textContent)`), ['Mon', 'Tue']);
      check('card shows the sound', await s.page.textContent(`${card} .ck-alarm-meta`), (v) => v.includes('Xylophone') && v.includes('5 minutes'));
      // context menu -> turn off
      await s.page.click(card, { button: 'right' });
      await s.page.locator('.menu .menu-item', { hasText: 'Turn off' }).click();
      check('menu: turn off', await CK(s, (app, id) => app.store.alarms.find((x) => x.id === id).enabled, a.id), false);
      // edit mode -> delete
      await s.page.click(`${WIN} .ck-page-alarm .ck-cmd-edit`);
      check('edit mode shows delete buttons', await s.page.isVisible(`${card} .ck-card-del`), true);
      await s.page.click(`${card} .ck-card-del`);
      await sleep(150);
      check('deleted from the store', await CK(s, (app, id) => app.store.alarms.some((x) => x.id === id), a.id), false);
      check('deleted from reminders', (await reminders(s)).some((r) => r.id.startsWith(`alarm-${a.id}`)), false);
      await s.page.click(`${WIN} .ck-page-alarm .ck-cmd-edit`);
      await shot(s, 'alarm');
    });

    await section('alarms: one-shot alarm turns itself off when it rings; Snooze on the notification', async () => {
      await go(s, 'alarm');
      const id = await CK(s, (app) => app.store.addAlarm({ hour: 6, minute: 0, name: 'Ring test', days: [] }).id);
      // make it ring in ~1.2 s
      await CK(s, (app, id) => {
        const r = app.shell.reminders.get(`alarm-${id}`, 'clock');
        app.shell.reminders.set({ ...r, at: Date.now() + 1200 });
      }, id);
      await until(s, (app, id) => app.store.alarms.find((x) => x.id === id)?.enabled === false, { arg: id, label: 'one-shot disabled', timeout: 8000 });
      check('card turned off', await s.page.evaluate(`document.querySelector('${WIN} .ck-alarm[data-id="${id}"]').classList.contains('off')`), true);
      const toast = s.page.locator('#toasts .toast', { hasText: 'Ring test' }).first();
      check('notification shown', await toast.count(), 1);
      check('notification body is the time', await toast.locator('.toast-body').textContent(), '6:00 AM');
      await toast.locator('button', { hasText: 'Snooze 10 min' }).click();
      await sleep(200);
      const snoozed = (await reminders(s)).find((r) => r.id === `alarm-${id}`);
      const now = await s.page.evaluate('Date.now()');
      check('snooze rescheduled the one-shot alarm in 10 min', snoozed && Math.round((snoozed.at - now) / 60000), 10);
      check('alarm stays off (only the snoozed ring is pending)', await CK(s, (app, id) => app.store.alarms.find((x) => x.id === id).enabled, id), false);
      await CK(s, (app, id) => app.store.deleteAlarm(id), id);
    });

    await section('timers: accuracy, done state, notification, click opens Timer', async () => {
      await go(s, 'timer');
      const id = await CK(s, (app) => app.store.addTimer({ name: 'Quick', duration: 3000 }).id);
      const card = `${WIN} .ck-timer[data-id="${id}"]`;
      await s.page.waitForSelector(card);
      check('named timer card', await s.page.textContent(`${card} .ck-timer-name`), 'Quick');
      check('shows 00:00:03', await s.page.textContent(`${card} .ck-timer-time`), '00:00:03');
      await s.page.click(`${card} .ck-timer-play`);
      const rem = (await reminders(s)).find((r) => r.id === `timer-${id}`);
      const x = await CK(s, (app, id) => app.store.timers.find((t) => t.id === id), id);
      check('running timer mirrored as an alarm reminder', rem && { kind: rem.kind, at: rem.at, data: rem.data, snooze: rem.snoozeMinutes }, { kind: 'alarm', at: x.endAt, data: { timerId: id }, snooze: 0 });
      await sleep(1300);
      const mid = await CK(s, (app, id) => app.store.remainingOf(app.store.timers.find((t) => t.id === id)), id);
      check('remaining after ~1.3 s', mid, (v) => v > 1200 && v < 1900);
      await until(s, (app, id) => app.store.timers.find((t) => t.id === id)?.state === 'done', { arg: id, label: 'timer done', timeout: 6000 });
      const done = await CK(s, (app, id) => app.store.timers.find((t) => t.id === id), id);
      check(`fires on time (late by ${done.doneAt - done.endAt} ms)`, done.doneAt - done.endAt, (v) => v >= -20 && v < 700);
      check('card in done state', await s.page.evaluate(`document.querySelector('${card}').classList.contains('state-done')`), true);
      check('shows 00:00:00', await s.page.textContent(`${card} .ck-timer-time`), '00:00:00');
      check("says time's up", await s.page.textContent(`${card} .ck-timer-sub`), "Time's up");
      check('reminder consumed', (await reminders(s)).some((r) => r.id === `timer-${id}`), false);
      const toast = s.page.locator('#toasts .toast', { hasText: 'Quick' }).first();
      check('timer notification', await toast.count(), 1);
      await shot(s, 'timer-done');
      // clicking the notification opens Clock on the Timer page
      await go(s, 'stopwatch');
      await toast.locator('.toast-title').click();
      await until(s, (app) => app.pageId === 'timer', { label: 'notification click -> timer page' });
      check('notification click opened the Timer page', await CK(s, (app) => app.pageId), 'timer');
      await s.page.click(`${card} .ck-timer-reset`);
      check('reset -> idle', await CK(s, (app, id) => app.store.timers.find((t) => t.id === id).state, id), 'idle');
      await CK(s, (app, id) => app.store.deleteTimer(id), id);
    });

    await section('timers: pause / resume / +1 min / presets / edit / expanded view', async () => {
      await go(s, 'timer');
      const id = await CK(s, (app) => app.store.addTimer({ name: 'Tea', duration: 10000 }).id);
      const card = `${WIN} .ck-timer[data-id="${id}"]`;
      await s.page.click(`${card} .ck-timer-play`);
      await sleep(1200);
      await s.page.click(`${card} .ck-timer-play`);
      const p1 = await CK(s, (app, id) => app.store.timers.find((t) => t.id === id), id);
      check('paused', p1.state, 'paused');
      check('remaining ≈ 8.8 s', p1.remaining, (v) => v > 8300 && v < 9100);
      check('pause removes the reminder', (await reminders(s)).some((r) => r.id === `timer-${id}`), false);
      check('card says Paused', await s.page.textContent(`${card} .ck-timer-sub`), 'Paused');
      await sleep(1000);
      check('time frozen while paused', await CK(s, (app, id) => app.store.timers.find((t) => t.id === id).remaining, id), p1.remaining);
      await s.page.click(`${card} .ck-timer-play`);
      const now = await s.page.evaluate('Date.now()');
      const r1 = (await reminders(s)).find((r) => r.id === `timer-${id}`);
      check('resume re-registers at now + remaining', r1 && Math.abs(r1.at - (now + p1.remaining)), (v) => v < 300);
      await s.page.click(`${card} .ck-timer-plus`);
      const r2 = (await reminders(s)).find((r) => r.id === `timer-${id}`);
      check('+1 min moves the end by 60 s', r2.at - r1.at, 60000);
      check('ring progress below 1 after +1 min', await CK(s, (app, id) => app.store.progressOf(app.store.timers.find((t) => t.id === id)), id), (v) => v > 0.8 && v < 1);
      // expanded view
      await s.page.click(`${card} .ck-timer-expand`);
      check('expanded view visible', await s.page.isVisible(`${WIN} .ck-timer-big .ck-timer.big`), true);
      check('cards hidden behind it', await s.page.isVisible(card), false);
      await shot(s, 'timer-expanded');
      await s.page.keyboard.press('Escape');
      check('Esc leaves the expanded view', await s.page.isVisible(`${WIN} .ck-timer-big`), false);
      // timer sound setting follows to the running timer's reminder
      await CK(s, (app) => app.store.setPref('timerSound', 'tap'));
      const r3 = (await reminders(s)).find((r) => r.id === `timer-${id}`);
      const tap = await CK(s, async () => (await import('app://shell/apps/clock/lib/tones.js')).toneById('tap').pattern);
      check('timer sound applied to the running timer', r3?.sound?.length, tap.length);
      await CK(s, (app) => app.store.setPref('timerSound', 'chimes'));
      await s.page.click(`${card} .ck-timer-reset`);
      check('reset clears the reminder', (await reminders(s)).some((r) => r.id === `timer-${id}`), false);
      // presets
      const before = await CK(s, (app) => app.store.timers.length);
      await s.page.click(`${WIN} .ck-preset[data-min="10"]`);
      const pre = await CK(s, (app) => app.store.timers.find((t) => t.duration === 600000 && t.state === 'running'));
      check('10 min preset starts a timer', !!pre && (await CK(s, (app) => app.store.timers.length)) === before + 1, true);
      check('preset timer named by length', await s.page.textContent(`${WIN} .ck-timer[data-id="${pre.id}"] .ck-timer-name`), '10 min');
      check('preset reminder', (await reminders(s)).some((r) => r.id === `timer-${pre.id}`), true);
      await shot(s, 'timer');
      await CK(s, (app, id) => app.store.deleteTimer(id), pre.id);
      // add a custom timer through the dialog
      await s.page.click(`${WIN} .ck-page-timer .ck-cmd-add`);
      await s.page.waitForSelector(`${DLG} .ck-dur`);
      await s.page.click(`${DLG} .ck-dlg-presets .btn:has-text("3 min")`);
      const spins = `${DLG} .ck-dur .ck-spin`;
      await s.page.focus(`${spins} >> nth=2`);
      await s.page.keyboard.type('30');
      await s.page.fill(`${DLG} input[type="text"]`, 'Eggs');
      await dialogButton(s, 'Save');
      const eggs = await CK(s, (app) => app.store.timers.find((t) => t.name === 'Eggs'));
      check('custom timer 3:30 saved', eggs?.duration, 210000);
      // zero duration is refused
      await s.page.click(`${WIN} .ck-timer[data-id="${eggs.id}"] .ck-timer-time`);
      await s.page.waitForSelector(`${DLG} .ck-dur`);
      for (const n of [0, 1, 2]) {
        await s.page.focus(`${spins} >> nth=${n}`);
        await s.page.keyboard.type('00');
      }
      await s.page.locator(`${DLG} .dialog-footer .btn`, { hasText: 'Save' }).click();
      check('0 s timer refused with a message', await s.page.textContent(`${DLG} .ck-dlg-err`), 'Choose a time of at least 1 second.');
      await s.page.keyboard.press('Escape');
      await sleep(250);
      await CK(s, (app, id) => app.store.deleteTimer(id), eggs.id);
      await CK(s, (app, id) => app.store.deleteTimer(id), id);
    });

    await section('stopwatch: Space / L / R keys, laps & splits, fastest / slowest, copy laps', async () => {
      await go(s, 'stopwatch');
      await s.page.click(`${WIN} .ck-sw-display`);
      await s.page.keyboard.press('Space');
      check('Space starts', await CK(s, (app) => app.store.stopwatch.running), true);
      await sleep(400);
      await s.page.keyboard.press('l');
      await sleep(700);
      await s.page.keyboard.press('l');
      await sleep(200);
      await s.page.keyboard.press('L');
      const laps = await CK(s, (app) => app.store.stopwatch.laps);
      check('three laps', laps.length, 3);
      check('laps increase', laps[0] < laps[1] && laps[1] < laps[2], true);
      check('lap rows (newest first)', await s.page.evaluate(`[...document.querySelectorAll('${WIN} .ck-lap')].map((e) => e.dataset.lap)`), ['3', '2', '1']);
      check('fastest = lap 3', await s.page.evaluate(`document.querySelector('${WIN} .ck-lap.fast')?.dataset.lap`), '3');
      check('slowest = lap 2', await s.page.evaluate(`document.querySelector('${WIN} .ck-lap.slow')?.dataset.lap`), '2');
      await shot(s, 'stopwatch');
      await s.page.keyboard.press(' ');
      const e1 = await CK(s, (app) => app.store.swElapsed());
      await sleep(400);
      check('Space pauses (time frozen)', await CK(s, (app) => app.store.swElapsed()), e1);
      check('display matches the elapsed time', await s.page.evaluate(`[...document.querySelectorAll('${WIN} .ck-sw-num')].map((e) => e.textContent).join(':')`), (v) => v.startsWith('00:00:01:') || v.startsWith('00:00:02:'));
      check('lap disabled while paused', await s.page.isDisabled(`${WIN} .ck-sw-lap`), true);
      await s.page.click(`${WIN} .ck-sw-copy`);
      await sleep(200);
      const clip = await CK(s, (app) => app.ctx.api.invoke('clipboard:readText'));
      const lines = clip.split('\n');
      check('copied header', lines[0], 'Laps\tTime\tTotal');
      check('copied 3 laps', lines.length, 4);
      check('copied lap format', lines[1], (v) => /^1\t00:00:00\.\d\d\t00:00:00\.\d\d$/.test(v));
      check('copy button feedback', await s.page.textContent(`${WIN} .ck-sw-copy`), 'Copied');
      await s.page.keyboard.press('r');
      check('R resets', await CK(s, (app) => [app.store.swElapsed(), app.store.stopwatch.laps.length]), [0, 0]);
      check('display back to zero', await s.page.textContent(`${WIN} .ck-sw-num.s`), '00');
      // keeps running while Clock is closed (time from timestamps)
      await s.page.click(`${WIN} .ck-sw-display`);
      await s.page.keyboard.press('Space');
      check('Space starts again after clicking the page', await CK(s, (app) => app.store.stopwatch.running), true);
      await CK(s, (app) => app.win.close());
      await sleep(1500);
      check('window closed', await s.page.evaluate(`document.querySelectorAll('${WIN}').length`), 0);
      await s.page.evaluate(`window.__aurora.registry.launch('clock')`);
      await until(s, (app) => app?.pageId === 'stopwatch', { label: 'clock relaunched on the stopwatch' });
      const bg = await CK(s, (app) => ({ running: app.store.stopwatch.running, e: app.store.swElapsed() }));
      check('still running after reopening', bg.running, true);
      check('time kept counting while closed', bg.e, (v) => v >= 1400);
      await s.page.keyboard.press('r');
      await CK(s, (app) => app.store.swReset());
    });

    await section('world clock: search (other-language names), offsets, reorder, remove, pins', async () => {
      await go(s, 'world');
      await s.page.click(`${WIN} .ck-page-world .ck-cmd-add`);
      await s.page.waitForSelector(`${DLG} input[type="search"]`);
      await sleep(80);
      await s.page.keyboard.type('Calcu'); // French name of Kolkata
      await sleep(150);
      check('first result is Kolkata', await s.page.evaluate(`document.querySelector('${DLG} .ck-search-item.selected')?.dataset.id`), 'kolkata-in');
      check('result shows the offset', await s.page.textContent(`${DLG} .ck-search-item.selected .ck-search-time`), (v) => v.includes('+3 h 30'));
      await s.page.keyboard.press('Enter');
      await sleep(250);
      for (const [q, id] of [
        ['new york', 'new-york-city-us'],
        ['kathm', 'kathmandu-np'],
        ['tokyo', 'tokyo-jp'],
      ]) {
        await s.page.click(`${WIN} .ck-page-world .ck-cmd-add`);
        await s.page.waitForSelector(`${DLG} input[type="search"]`);
        await sleep(60);
        await s.page.keyboard.type(q);
        await sleep(120);
        check(`search "${q}"`, await s.page.evaluate(`document.querySelector('${DLG} .ck-search-item.selected')?.dataset.id`), id);
        await s.page.keyboard.press('Enter');
        await sleep(200);
      }
      check('cities stored in order', await CK(s, (app) => app.store.cities), ['kolkata-in', 'new-york-city-us', 'kathmandu-np', 'tokyo-jp']);
      const rel = (id) => s.page.textContent(`${WIN} .ck-city[data-id="${id}"] .ck-city-rel`);
      const exp = await CK(s, async (app) => {
        const T = await import('app://shell/apps/clock/lib/time.js');
        const now = Date.now();
        return Object.fromEntries(['Asia/Kolkata', 'America/New_York', 'Asia/Kathmandu'].map((z) => [z, T.shortOffset(app.t, T.offsetFromLocal(z, now))]));
      });
      check('Kolkata card offset', await rel('kolkata-in'), (v) => v.endsWith(exp['Asia/Kolkata']) && /\+[34] h 30/.test(v));
      check('New York card offset', await rel('new-york-city-us'), (v) => v.endsWith(exp['America/New_York']));
      check('Kathmandu card offset', await rel('kathmandu-np'), (v) => v.endsWith(exp['Asia/Kathmandu']) && / 45$/.test(v));
      const tk = await CK(s, (app) => {
        const tp = app.timeParts(Date.now(), { tz: 'Asia/Tokyo' });
        return tp.main;
      });
      check('Tokyo card time', await s.page.textContent(`${WIN} .ck-city[data-id="tokyo-jp"] .ck-city-clock`), tk);
      const tkDate = await CK(s, async (app) => (await import('app://shell/apps/clock/lib/time.js')).formatDate(Date.now(), 'en-US', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Tokyo' }));
      check('Tokyo card date (in Tokyo)', await s.page.textContent(`${WIN} .ck-city[data-id="tokyo-jp"] .ck-city-date`), tkDate);
      check('local card first, named after Paris', await s.page.textContent(`${WIN} .ck-city.local .ck-city-place`), 'Paris, France');
      check('local card shows sunrise / sunset', await s.page.evaluate(`document.querySelectorAll('${WIN} .ck-city.local .ck-sun-row').length`), (n) => n >= 2);
      check('one pin per city with coordinates', await s.page.evaluate(`document.querySelectorAll('${WIN} .ck-pin').length`), 5);
      check('day/night faces follow the sun', await CK(s, async (app) => {
        const S = await import('app://shell/apps/clock/lib/sun.js');
        const C = await import('app://shell/apps/clock/lib/cities.js');
        return app.store.cities.every((id) => {
          const c = C.cityById(id);
          const card = app.win.el.querySelector(`.ck-city[data-id="${id}"]`);
          return card.dataset.light === S.daylight(c.lat, c.lon, Date.now());
        });
      }), true);
      // already added
      await s.page.click(`${WIN} .ck-page-world .ck-cmd-add`);
      await s.page.waitForSelector(`${DLG} input[type="search"]`);
      await sleep(60);
      await s.page.keyboard.type('tokyo');
      await sleep(120);
      check('already added is flagged', await s.page.textContent(`${DLG} .ck-search-item.selected .ck-search-time`), (v) => v.includes('Already added'));
      await s.page.keyboard.type('zzzz');
      await sleep(120);
      check('no results message', await s.page.textContent(`${DLG} .ck-search-hint`), 'No matching cities.');
      check('Add disabled without a selection', await s.page.isDisabled(`${DLG} .dialog-footer .btn.primary`), true);
      await s.page.keyboard.press('Escape');
      await sleep(250);
      // reorder with Alt+Up and the context menu, remove
      await s.page.focus(`${WIN} .ck-city[data-id="tokyo-jp"]`);
      await s.page.keyboard.press('Alt+ArrowUp');
      await sleep(100);
      check('Alt+Up moves Tokyo up', await CK(s, (app) => app.store.cities), ['kolkata-in', 'new-york-city-us', 'tokyo-jp', 'kathmandu-np']);
      await s.page.click(`${WIN} .ck-city[data-id="kolkata-in"]`, { button: 'right' });
      await s.page.locator('.menu .menu-item', { hasText: 'Move down' }).click();
      check('menu: move down', await CK(s, (app) => app.store.cities[1]), 'kolkata-in');
      // drag reorder in edit mode
      await s.page.click(`${WIN} .ck-page-world .ck-cmd-edit`);
      await CK(s, (app) => app.win.el.querySelector('.ck-city[data-id="kathmandu-np"]').scrollIntoView({ block: 'center' }));
      await sleep(150);
      const from = await s.page.locator(`${WIN} .ck-city[data-id="kathmandu-np"] .ck-city-handle`).boundingBox();
      const to = await s.page.locator(`${WIN} .ck-city[data-id="new-york-city-us"]`).boundingBox();
      await s.page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
      await s.page.mouse.down();
      await s.page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
      await s.page.mouse.up();
      await sleep(200);
      check('drag moved Kathmandu first', await CK(s, (app) => app.store.cities[0]), 'kathmandu-np');
      await s.page.click(`${WIN} .ck-city[data-id="kathmandu-np"] .ck-card-del`);
      check('removed', await CK(s, (app) => app.store.cities.includes('kathmandu-np')), false);
      await s.page.click(`${WIN} .ck-page-world .ck-cmd-edit`);
      await shot(s, 'world');
    });

    await section('world clock: day/night terminator matches the solar math; compare mode', async () => {
      await go(s, 'world');
      const check1 = async (label) => {
        const r = await CK(s, async (app) => {
          const S = await import('app://shell/apps/clock/lib/sun.js');
          const page = app.page;
          const at = page.at();
          const path0 = page.nights[0];
          const path3 = page.nights[3];
          let tested = 0;
          let bad = [];
          let nightPts = 0;
          let inner = 0;
          for (let lat = -55; lat <= 80; lat += 5) {
            for (let lon = -175; lon <= 175; lon += 10) {
              const alt = S.sunAltitude(lat, lon, at);
              const pt = new DOMPoint(lon + 180, 90 - lat);
              const night = path0.isPointInFill(pt);
              if (Math.abs(alt) > 1.5) {
                tested++;
                if (night !== alt < 0) bad.push([lat, lon, Math.round(alt)]);
                if (night) nightPts++;
              }
              if (path3.isPointInFill(pt) && !night) inner++;
            }
          }
          return { tested, bad: bad.slice(0, 5), nbad: bad.length, nightPts, inner };
        });
        check(`${label}: night shading matches sun altitude (${r.tested} points)`, r.nbad, 0);
        check(`${label}: some night on the map`, r.nightPts, (n) => n > 50);
        check(`${label}: astronomical night lies inside the night`, r.inner, 0);
        if (r.nbad) console.log('    mismatches:', JSON.stringify(r.bad));
      };
      await check1('now');
      await s.page.click(`${WIN} .ck-page-world .ck-cmd-compare`);
      check('compare bar shown', await s.page.isVisible(`${WIN} .ck-compare`), true);
      await CK(s, (app) => app.page.setShift(9 * 60));
      await sleep(150);
      const exp = await CK(s, (app) => app.timeParts(Date.now() + 9 * 3600000, { tz: 'Asia/Tokyo' }).main);
      check('cards show the shifted time', await s.page.textContent(`${WIN} .ck-city[data-id="tokyo-jp"] .ck-city-clock`), exp);
      check('compare label', await s.page.textContent(`${WIN} .ck-cmp-sub`), 'In 9 hr');
      await check1('+9 h');
      // keyboard on the slider: steps of 15 min
      await s.page.focus(`${WIN} .ck-cmp-slider`);
      await s.page.keyboard.press('ArrowRight');
      await sleep(80);
      check('slider arrow = +15 min', await CK(s, (app) => app.page.shift), 9 * 60 + 15);
      await shot(s, 'world-compare');
      await s.page.click(`${WIN} .ck-compare .btn:has-text("Now")`);
      check('Now resets the shift', await CK(s, (app) => app.page.shift), 0);
      await s.page.keyboard.press('Escape');
      await sleep(100);
      check('Esc leaves compare mode', await s.page.isVisible(`${WIN} .ck-compare`), false);
    });

    await section('focus sessions: Do not disturb offer, pause/resume reminders, stop restores DND', async () => {
      await go(s, 'focus');
      await CK(s, (app) => app.store.setPref('focus.dnd', 'ask'));
      check('DND off at start', await CK(s, (app) => !!app.ctx.settings.get('notifications.dnd')), false);
      check('30 min: no breaks text', await s.page.textContent(`${WIN} .ck-focus-breaks`), "You'll have no breaks");
      await s.page.focus(`${WIN} .ck-focus-spin`);
      for (let i = 0; i < 6; i++) await s.page.keyboard.press('ArrowUp');
      check('duration 60 min', await s.page.getAttribute(`${WIN} .ck-focus-spin`, 'aria-valuenow'), '60');
      check('60 min: one break', await s.page.textContent(`${WIN} .ck-focus-breaks`), "You'll have 1 break of 5 minutes");
      await shot(s, 'focus');
      await s.page.click(`${WIN} .ck-focus-start`);
      await s.page.waitForSelector(DLG);
      check('DND offer', await s.page.textContent(`${DLG} .dialog-title`), 'Turn on do not disturb?');
      await dialogButton(s, 'Turn on');
      await until(s, (app) => !!app.store.focus.session, { label: 'session started' });
      check('DND turned on', await CK(s, (app) => app.ctx.settings.get('notifications.dnd')), true);
      const ids = (await reminders(s)).filter((r) => r.id.startsWith('focus-')).map((r) => r.id).sort();
      check('focus reminders: break, back, end', ids, ['focus-1', 'focus-2', 'focus-end']);
      await sleep(400);
      const st = await CK(s, async (app) => (await app.ctx.storage.get('focus')).status);
      check('session state exposed in storage', st && { active: st.active, state: st.state, phase: st.phase, minutes: st.minutes, breaks: st.breaks }, { active: true, state: 'running', phase: 'focus', minutes: 60, breaks: 1 });
      check('phase label', await s.page.textContent(`${WIN} .ck-focus-phase`), 'Focus period 1 of 2');
      check('next label', await s.page.textContent(`${WIN} .ck-focus-next`), 'Next: 5-minute break');
      check('timeline has 3 blocks', await s.page.evaluate(`document.querySelectorAll('${WIN} .ck-focus-seg').length`), 3);
      await shot(s, 'focus-running');
      await s.page.click(`${WIN} .ck-focus-pause`);
      check('paused', await CK(s, (app) => app.store.focus.session.state), 'paused');
      check('pause removes focus reminders', (await reminders(s)).filter((r) => r.id.startsWith('focus-')).length, 0);
      await sleep(600);
      await s.page.click(`${WIN} .ck-focus-pause`);
      const endR = (await reminders(s)).find((r) => r.id === 'focus-end');
      const endsAt = await CK(s, (app) => app.store.focusEndsAt());
      check('resume re-registers the end, shifted by the pause', endR && Math.abs(endR.at - endsAt), (v) => v < 50);
      await s.page.click(`${WIN} .ck-focus-stop`);
      await dialogButton(s, 'End session');
      await until(s, (app) => !app.store.focus.session, { label: 'session stopped' });
      check('DND restored on stop', await CK(s, (app) => app.ctx.settings.get('notifications.dnd')), false);
      check('focus reminders cleared', (await reminders(s)).filter((r) => r.id.startsWith('focus-')).length, 0);
      check('summary shown', await s.page.textContent(`${WIN} .ck-focus-done .subtitle`), 'Session ended');
      check('logged as stopped', await CK(s, (app) => app.store.focus.log.at(-1).completed), false);
      await s.page.click(`${WIN} .ck-focus-done .btn`);
      check('back to the start card', await s.page.isVisible(`${WIN} .ck-focus-start`), true);
    });

    await section('focus sessions: completion restores DND before the end, records progress; existing DND kept', async () => {
      await go(s, 'focus');
      await CK(s, (app) => app.store.setPref('focus.dnd', 'always'));
      await CK(s, (app) => app.store.setPref('focus.minutes', 30));
      await s.page.click(`${WIN} .ck-focus-start`);
      await until(s, (app) => !!app.store.focus.session, { label: 'session started' });
      check('"always" turns DND on without asking', await CK(s, (app) => app.ctx.settings.get('notifications.dnd')), true);
      // fast-forward: the session ends in ~2.5 s
      await CK(s, (app) => {
        const st = app.store;
        st.focus.session.startedAt = Date.now() - st.focusTotal() + 2500;
        st._syncFocusReminders();
        st.emit('focus');
      });
      await until(s, (app) => !app.ctx.settings.get('notifications.dnd'), { label: 'DND restored just before the end', timeout: 6000 });
      check('still running when DND comes back', await CK(s, (app) => !!app.store.focus.session), true);
      await until(s, (app) => !app.store.focus.session, { label: 'session completed', timeout: 6000 });
      check('completed summary', await s.page.textContent(`${WIN} .ck-focus-done .subtitle`), 'Well done!');
      check('today counts 30 min', await CK(s, (app) => app.store.todayMinutes()), (v) => v >= 30);
      check('completion notification visible (DND was off again)', await s.page.locator('#toasts .toast', { hasText: 'Focus session complete' }).count(), 1);
      check('daily progress text', await s.page.textContent(`${WIN} .ck-goal-done`), (v) => /^Completed today: (30 min|\d+ min)$/.test(v));
      await shot(s, 'focus-done');
      await s.page.click(`${WIN} .ck-focus-done .btn`);
      // DND already on before the session: never switched off by Clock
      await CK(s, (app) => app.ctx.settings.set('notifications.dnd', true));
      await CK(s, (app) => app.store.setPref('focus.dnd', 'ask'));
      await sleep(100);
      await s.page.click(`${WIN} .ck-focus-start`);
      await until(s, (app) => !!app.store.focus.session, { label: 'session started' });
      check('no DND question when it is already on', await s.page.evaluate(`!!document.querySelector('${DLG}')`), false);
      await CK(s, (app) => app.store.stopFocus());
      check('DND left on', await CK(s, (app) => app.ctx.settings.get('notifications.dnd')), true);
      await CK(s, (app) => app.ctx.settings.set('notifications.dnd', false));
      await CK(s, (app) => app.store.dismissFocusSummary());
    });

    await section('settings: tones, snooze default, focus options, links', async () => {
      await go(s, 'settings');
      await s.page.selectOption(`${WIN} .ck-set-row[data-key="sound"] select`, 'echo');
      check('default alarm sound saved', await CK(s, (app) => app.store.prefs.sound), 'echo');
      await s.page.selectOption(`${WIN} .ck-set-row[data-key="snooze"] select`, '20');
      check('default snooze saved', await CK(s, (app) => app.store.prefs.snooze), 20);
      const a = await CK(s, (app) => app.store.addAlarm({ hour: 9, minute: 0, name: 'Defaults' }));
      check('new alarms use the defaults', [a.sound, a.snooze], ['echo', 20]);
      check('…and the reminder carries the tone', (await reminders(s)).find((r) => r.id === `alarm-${a.id}`)?.sound?.length, 4);
      await CK(s, (app, id) => app.store.deleteAlarm(id), a.id);
      await s.page.selectOption(`${WIN} .ck-set-row[data-key="chunk"] select`, '25');
      check('focus period saved', await CK(s, (app) => app.store.prefs.focus.chunk), 25);
      await s.page.click(`${WIN} .ck-set-row[data-key="focusSound"] .toggle`);
      check('focus sound toggled', await CK(s, (app) => app.store.prefs.focus.sound), false);
      check('toggle label follows', await s.page.textContent(`${WIN} .ck-set-row[data-key="focusSound"] .toggle-label`), 'Off');
      check('notification status', await s.page.textContent(`${WIN} .ck-set-row[data-key="notifications"] .caption`), 'Notifications are on');
      check('time format', await s.page.textContent(`${WIN} .ck-set-row[data-key="format"] .caption`), '12-hour clock (7:00 AM)');
      // app theme: per-app theme radios when the shell supports them (core/theme.js appThemes), else a link
      const radios = await s.page.locator(`${WIN} .ck-set-row[data-key="theme"] input[type="radio"]`).count();
      if (radios) {
        check('three theme choices', radios, 3);
        check('system selected by default', await s.page.isChecked(`${WIN} .ck-set-row[data-key="theme"] input[value="system"]`), true);
        await s.page.click(`${WIN} .ck-set-row[data-key="theme"] input[value="dark"]`);
        await until(s, (app) => app.win.el.dataset.theme === 'dark', { label: 'per-app dark theme' });
        check('Clock window switched to dark on its own', await CK(s, (app) => [app.win.el.dataset.theme, document.documentElement.dataset.theme]), ['dark', 'light']);
        await shot(s, 'settings-app-theme-dark');
        await s.page.click(`${WIN} .ck-set-row[data-key="theme"] input[value="system"]`);
        await until(s, (app) => app.win.el.dataset.theme !== 'dark', { label: 'back to the system theme' });
        check('back to the system theme', await CK(s, (app) => app.ctx.settings.get('appThemes')?.clock?.theme), 'system');
      } else {
        check('link to the Colors settings', await s.page.textContent(`${WIN} .ck-set-row[data-key="theme"] .btn`), 'Colors');
      }
      await s.page.click(`${WIN} .ck-set-row[data-key="notifications"] .btn`);
      await until(s, () => !!document.querySelector('.win.app-settings'), { label: 'Settings app opened' });
      check('opens system Settings', await s.page.evaluate(`!!document.querySelector('.win.app-settings')`), true);
      await s.page.evaluate(`window.__aurora.wm.byApp('settings').forEach((w) => w.close(true))`);
      await sleep(400);
      await s.page.evaluate(`window.__aurora.wm.byApp('clock')[0]?.focus()`);
      await CK(s, (app) => {
        app.store.setPref('sound', 'chimes');
        app.store.setPref('snooze', 10);
        app.store.setPref('focus.chunk', 30);
        app.store.setPref('focus.sound', true);
      });
      await shot(s, 'settings');
    });

    await section('alarm page screenshot with a few alarms (docs)', async () => {
      await CK(s, (app) => {
        app.store.addAlarm({ hour: 6, minute: 30, name: 'Gym', days: [1, 3, 5] });
        app.store.addAlarm({ hour: 22, minute: 15, name: 'Medication', days: [0, 1, 2, 3, 4, 5, 6], sound: 'jingle', snooze: 5 });
      });
      await go(s, 'alarm');
      await shot(s, 'alarm');
      const id = await CK(s, (app) => app.store.alarms.find((x) => x.name === 'Gym').id);
      await s.page.click(`${WIN} .ck-alarm[data-id="${id}"] .ck-alarm-name`);
      await s.page.waitForSelector(`${DLG} .ck-picker`);
      await shot(s, 'alarm-edit');
      await s.page.keyboard.press('Escape');
    });

    await section('console: no errors from Clock', async () => {
      const errs = clockErrors(s);
      check('no Clock errors in the console', errs, []);
      const all = s.logs.filter((l) => /^\[(error|pageerror)\]/.test(l));
      if (all.length) console.log(`    (other console errors in the shell: ${all.length})`);
    });
  } finally {
    await s.close();
    current = null;
  }
}

// ================================================================== launch B: French, dark, sizes
async function runFrench() {
  const s = await launchShell({ open: ['clock'], lang: 'fr', theme: 'dark', env: { TZ: 'Europe/Paris' } });
  current = s;
  try {
    await s.page.waitForSelector(`${WIN} .ck`, { timeout: 20000 });
    await until(s, (app) => !!app?.store, { label: 'clock ready' });
    await CK(s, (app) => {
      const st = app.store;
      for (const id of ['new-york-city-us', 'tokyo-jp', 'kolkata-in', 'sydney-au']) st.addCity(id);
      st.addAlarm({ hour: 6, minute: 30, name: 'Sport', days: [1, 3, 5] });
      st.addAlarm({ hour: 22, minute: 15, name: '', days: [] });
      st.startTimer(st.timers[1].id);
    });

    await section('French: strings, 24 h format, week order, offsets', async () => {
      check('window title', await s.page.evaluate(`window.__aurora.wm.byApp('clock')[0].title`), 'Horloge');
      check('nav labels', await s.page.evaluate(`[...document.querySelectorAll('${WIN} .ck-nav-label')].map((e) => e.textContent)`), ['Sessions de concentration', 'Minuteur', 'Alarme', 'Chronomètre', 'Horloge mondiale', 'Paramètres']);
      await go(s, 'alarm');
      const a = await CK(s, (app) => app.store.alarms.find((x) => x.name === 'Sport'));
      const card = `${WIN} .ck-alarm[data-id="${a.id}"]`;
      check('24 h time', await s.page.textContent(`${card} .ck-alarm-clock`), '06:30');
      check('no AM/PM', await s.page.textContent(`${card} .ck-alarm-period`), '');
      check('French days, Monday first', await s.page.evaluate(`[...document.querySelectorAll('${card} .ck-chip')].map((e) => e.textContent)`), ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim']);
      check('rings-in in French', await s.page.textContent(`${card} .ck-alarm-when-text`), (v) => /^Sonne dans /.test(v));
      const one = await CK(s, (app) => app.store.alarms.find((x) => x.hour === 22).id);
      check('default name', await s.page.textContent(`${WIN} .ck-alarm[data-id="${one}"] .ck-alarm-name-text`), 'Alarme');
      check('reminder title/body localized', (await reminders(s)).find((r) => r.id === `alarm-${one}`), (r) => r.title === 'Alarme' && r.body === '22:15');
      await shot(s, 'alarm-fr-dark');
      await s.page.click(`${card} .ck-alarm-name`);
      await s.page.waitForSelector(`${DLG} .ck-picker`);
      check('no AM/PM wheel in French', await s.page.evaluate(`document.querySelectorAll('${DLG} .ck-spin').length`), 2);
      check('dialog in French', await s.page.textContent(`${DLG} .dialog-title`), 'Modifier l’alarme');
      await shot(s, 'alarm-edit-fr-dark');
      await s.page.keyboard.press('Escape');
      await sleep(200);
      await go(s, 'world');
      await sleep(200);
      check('French city name', await s.page.textContent(`${WIN} .ck-city[data-id="kolkata-in"] .ck-city-name`), 'Calcutta');
      check('French country (region equal to the city name is not repeated)', await s.page.textContent(`${WIN} .ck-city[data-id="new-york-city-us"] .ck-city-place`), 'États-Unis');
      check('French region names', await s.page.textContent(`${WIN} .ck-city[data-id="sydney-au"] .ck-city-place`), 'Nouvelle-Galles du Sud, Australie');
      check('French relative day', await s.page.textContent(`${WIN} .ck-city[data-id="kolkata-in"] .ck-city-rel`), (v) => /^(Aujourd’hui|Demain), \+[34] h 30$/.test(v));
      check('local card in French', await s.page.textContent(`${WIN} .ck-city.local .ck-city-name`), 'Heure locale');
      await shot(s, 'world-fr-dark');
      await go(s, 'timer');
      check('timer endsAt in French', await s.page.evaluate(`[...document.querySelectorAll('${WIN} .ck-timer-sub')].map((e) => e.textContent).find((t) => t)`), (v) => /^Sonne à \d\d:\d\d$/.test(v));
      await shot(s, 'timer-fr-dark');
      await go(s, 'focus');
      check('focus intro in French', await s.page.textContent(`${WIN} .ck-focus-idle .subtitle`), 'Préparez-vous à vous concentrer');
      await shot(s, 'focus-fr-dark');
      await go(s, 'stopwatch');
      check('decimal comma', await s.page.textContent(`${WIN} .ck-sw-display`), (v) => v.includes(','));
      await go(s, 'settings');
      check('settings in French', await s.page.textContent(`${WIN} .ck-set-title`), 'Paramètres');
      await shot(s, 'settings-fr-dark');
    });

    const overflow = () =>
      CK(s, (app) => {
        const bad = [];
        const sc = app.scroller;
        if (sc.scrollWidth > sc.clientWidth + 1) bad.push(`page ${sc.scrollWidth}>${sc.clientWidth}`);
        for (const el of app.root.querySelectorAll('.ck-card, .ck-set-row, .ck-note, .ck-presets, .ck-sw-display, .ck-focus-main')) {
          if (el.offsetParent && el.scrollWidth > el.clientWidth + 2) bad.push(`${el.className.split(' ').slice(0, 3).join('.')} ${el.scrollWidth}>${el.clientWidth}`);
        }
        return bad;
      });

    await section('minimum size (400×500) in French: compact pane, no horizontal overflow', async () => {
      await CK(s, (app) => app.win.setSize(400, 500));
      await sleep(400);
      check('pane compact at min size', await CK(s, (app) => app.root.classList.contains('compact')), true);
      for (const p of ['focus', 'timer', 'alarm', 'stopwatch', 'world', 'settings']) {
        await go(s, p);
        await sleep(250);
        check(`no overflow on ${p}`, await overflow(), []);
      }
      await go(s, 'world');
      await shot(s, 'minsize-fr-dark');
      // hamburger opens the pane over the page; choosing a page closes it
      await s.page.click(`${WIN} .ck-burger`);
      await sleep(300);
      check('overlay pane open', await CK(s, (app) => app.root.classList.contains('nav-open') && app.navEl.getBoundingClientRect().width > 200), true);
      await shot(s, 'minsize-nav-fr-dark');
      await s.page.click(`${WIN} .ck-nav-item[data-page="alarm"]`);
      check('overlay closes after navigation', await CK(s, (app) => [app.pageId, app.root.classList.contains('nav-open')]), ['alarm', false]);
      // dialogs fit at the minimum size
      await s.page.click(`${WIN} .ck-page-alarm .ck-cmd-add`);
      await s.page.waitForSelector(`${DLG} .ck-picker`);
      const fits = await s.page.evaluate(`(() => { const d = document.querySelector(${JSON.stringify(DLG)}).getBoundingClientRect(); const w = document.querySelector(${JSON.stringify(WIN)}).getBoundingClientRect(); return d.left >= w.left - 1 && d.right <= w.right + 1; })()`);
      check('alarm dialog fits in the window', fits, true);
      await shot(s, 'minsize-dialog-fr-dark');
      await s.page.keyboard.press('Escape');
      await sleep(250);
    });

    await section('maximized in French', async () => {
      await CK(s, (app) => app.win.maximize());
      await sleep(500);
      for (const p of ['world', 'timer', 'focus', 'stopwatch']) {
        await go(s, p);
        await sleep(250);
        check(`no overflow maximized on ${p}`, await overflow(), []);
      }
      await go(s, 'world');
      check('pane expanded when maximized', await CK(s, (app) => app.root.classList.contains('compact')), false);
      check('local card shows sunrise when wide', await s.page.isVisible(`${WIN} .ck-sun-info`), true);
      await shot(s, 'maximized-fr-dark', { clip: false });
    });

    await section('animations off: no frame loop for smooth hands / rings, pages still update', async () => {
      await CK(s, (app) => app.ctx.settings.set('animations', false));
      await until(s, () => document.documentElement.dataset.animations === 'off', { label: 'animations off' });
      await go(s, 'world');
      check('world clock ticks once a second', await CK(s, (app) => app.page.wantsFrames()), false);
      const t1 = await s.page.textContent(`${WIN} .ck-city.local .ck-city-clock`);
      check('local time still shown', t1, (v) => /^\d\d:\d\d$/.test(v));
      await go(s, 'timer');
      check('running timer without frame loop', await CK(s, (app) => app.page.wantsFrames()), false);
      const a = await s.page.evaluate(`[...document.querySelectorAll('${WIN} .ck-timer.state-running .ck-timer-time')].map((e) => e.textContent)[0]`);
      await sleep(1300);
      const b = await s.page.evaluate(`[...document.querySelectorAll('${WIN} .ck-timer.state-running .ck-timer-time')].map((e) => e.textContent)[0]`);
      check('…but its digits still count down', a !== b, true);
      await go(s, 'stopwatch');
      await CK(s, (app) => app.store.swStart());
      check('stopwatch digits keep their frame loop (core function)', await CK(s, (app) => app.page.wantsFrames()), true);
      await CK(s, (app) => app.store.swReset());
      await CK(s, (app) => app.ctx.settings.set('animations', true));
    });

    await section('console (French run): no errors from Clock', async () => {
      check('no Clock errors in the console', clockErrors(s), []);
    });
  } finally {
    await s.close();
    current = null;
  }
}

// ================================================================== launch C: reconcile on launch
async function runReconcile() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-home-'));
  const dir = path.join(home, '.config', 'aurora', 'apps', 'clock');
  fs.mkdirSync(dir, { recursive: true });
  const now = Date.now();
  const w = (n, v) => fs.writeFileSync(path.join(dir, `${n}.json`), JSON.stringify(v));
  w('alarms', [
    { id: 'aonce', hour: 6, minute: 0, name: 'Rang while closed', days: [], enabled: true, at: now - 3600000 },
    { id: 'arep', hour: 7, minute: 30, name: 'Weekdays', days: [1, 2, 3, 4, 5], enabled: true, at: now - 3600000 },
    { id: 'aoff', hour: 8, minute: 0, name: 'Off', days: [], enabled: false, at: null },
    { id: 'bad', hour: 99, minute: -5, name: 42, days: ['x', 9], enabled: 'yes' },
    'garbage',
  ]);
  w('timers', [
    { id: 'tdone', name: 'Ended', duration: 60000, state: 'running', endAt: now - 5000, runTotal: 60000 },
    { id: 'tlive', name: 'Live', duration: 600000, state: 'running', endAt: now + 300000, runTotal: 600000 },
  ]);
  w('stopwatch', { running: true, startedAt: now - 5000, base: 1000, laps: [500] });
  w('focus', {
    session: { id: 'f1', minutes: 30, segs: [{ type: 'focus', ms: 1800000 }], startedAt: now - 1900000, state: 'running', pausedTotal: 0, dndChanged: true },
    history: {},
    log: [],
  });
  const s = await launchShell({ open: ['clock'], lang: 'en', theme: 'light', home, settings: { notifications: { enabled: true, dnd: true, sounds: true } }, env: { TZ: 'Europe/Paris' } });
  current = s;
  try {
    await s.page.waitForSelector(`${WIN} .ck`, { timeout: 20000 });
    await until(s, (app) => !!app?.store, { label: 'clock ready' });
    await section('reconcile on launch: what fired while Clock was closed', async () => {
      const r = await CK(s, (app) => {
        const st = app.store;
        const a = (id) => st.alarms.find((x) => x.id === id);
        return {
          once: a('aonce')?.enabled,
          rep: a('arep')?.enabled,
          repAt: a('arep')?.at,
          bad: a('bad') && [a('bad').hour, a('bad').minute, a('bad').days, a('bad').enabled, a('bad').name],
          count: st.alarms.length,
          tdone: st.timers.find((x) => x.id === 'tdone')?.state,
          tlive: st.timers.find((x) => x.id === 'tlive')?.state,
          sw: st.swElapsed(),
          swRunning: st.stopwatch.running,
          session: st.focus.session,
          last: st.focus.last,
          history: st.todayMinutes(),
          dnd: app.ctx.settings.get('notifications.dnd'),
          rems: app.shell.reminders.list('clock').map((x) => x.id).sort(),
        };
      });
      check('one-shot alarm that rang while closed is off', r.once, false);
      check('repeating alarm still on', r.rep, true);
      check('repeating alarm rescheduled in the future', r.repAt > Date.now(), true);
      check('corrupt alarm sanitized', r.bad, [23, 0, [], false, '']);
      check('garbage entries dropped', r.count, 4);
      check('timer that ended while closed is done', r.tdone, 'done');
      check('live timer still running', r.tlive, 'running');
      check('stopwatch kept running from its timestamps', r.sw, (v) => v >= 6000 && v < 60000);
      check('stopwatch running', r.swRunning, true);
      check('finished focus session closed', r.session, null);
      check('…as completed', r.last?.completed, true);
      check('…and counted for today', r.history, 30);
      check('…and DND restored', r.dnd, false);
      check('reminders re-registered', r.rems, ['alarm-arep', 'timer-tlive']);
    });
    await section('console (reconcile run): no errors from Clock', async () => {
      check('no Clock errors in the console', clockErrors(s), []);
    });
  } finally {
    await s.close();
    current = null;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

console.log('Clock tests');
await runEnglish();
await runFrench();
await runReconcile();
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(`\nFailures:\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
