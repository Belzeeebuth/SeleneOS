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
//   QA3: closing Clock with a dialog open (no global key handler left behind), Settings keeps the keyboard
//   focus when it refreshes, Do not disturb handed over to the shell's Focus mode, incremental lap rows,
//   world clock refresh rate, extra cities (Adelaide…), oversized storage capped, 15 open / close cycles.
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
// The quick timers live in a small menu in the Timer page header.
async function pickPreset(s, label) {
  await s.page.click(`${WIN} .ck-presets-btn`);
  await s.page.waitForSelector('body > .menu .menu-item');
  await s.page.locator('body > .menu .menu-item', { has: s.page.locator('.label', { hasText: new RegExp(`^${label}$`) }) }).click();
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
      await s.page.keyboard.press('Control+3');
      check('Ctrl+3 -> Stopwatch', await CK(s, (app) => app.pageId), 'stopwatch');
      await s.page.keyboard.press('Control+5');
      check('Ctrl+5 -> Focus sessions', await CK(s, (app) => app.pageId), 'focus');
      await s.page.keyboard.press('Control+1');
      check('Ctrl+1 -> Alarms', await CK(s, (app) => app.pageId), 'alarm');
      await s.page.keyboard.press('Control+5');
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
      // QA2: the card says it was snoozed (not "Off"), and its toggle cancels the pending ring
      const card = `${WIN} .ck-alarm[data-id="${id}"]`;
      await until(s, (app, id) => /^Snoozed until /.test(app.win.el.querySelector(`.ck-alarm[data-id="${id}"] .ck-alarm-when-text`)?.textContent || ''), { arg: id, label: 'snoozed text' });
      check('card: Snoozed until <time in 10 min>', await s.page.textContent(`${card} .ck-alarm-when-text`), `Snoozed until ${await CK(s, (app, at) => app.timeText(at), snoozed.at)}`);
      check('card: toggle on while a snoozed ring is pending', await s.page.isChecked(`${card} .ck-alarm-toggle input`), true);
      await s.page.click(`${card} .ck-alarm-toggle`);
      await sleep(250);
      check('toggle off cancels the snoozed ring', (await reminders(s)).some((r) => r.id.startsWith(`alarm-${id}`)), false);
      check('card back to Off', await s.page.textContent(`${card} .ck-alarm-when-text`), 'Off');
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
      check('no floating command bar: the actions sit in the page header', await s.page.evaluate(`(() => { const b = document.querySelector('${WIN} .ck-page-timer .ck-cmdbar'); return !!b && getComputedStyle(b).position === 'static' && b === b.parentElement.firstElementChild; })()`), true);
      check('timers are list rows with a progress line (no ring cards)', await s.page.evaluate(`[!!document.querySelector('${WIN} .ck-timer-list .ck-timer .ck-line'), !!document.querySelector('${WIN} .ck-timer-list .ck-ring')]`), [true, false]);
      await pickPreset(s, '10 min');
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
      await sleep(60);
      // go up to New York's row first, then across: each step lets the grid re-flow under the pointer
      await s.page.mouse.move(from.x + from.width / 2, to.y + to.height / 2, { steps: 10 });
      await sleep(60);
      await s.page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 10 });
      await sleep(60);
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
      // minutes recorded before (a session that crosses midnight is split over two days: sum them)
      const histSum = () => CK(s, (app) => Object.values(app.store.focus.history).reduce((n, v) => n + v, 0));
      const before = await histSum();
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
      check('completed summary', await s.page.textContent(`${WIN} .ck-focus-done .subtitle`), 'Well done');
      check('30 focus minutes recorded (split at midnight if needed)', (await histSum()) - before, 30);
      check('today counts the part done today', await CK(s, (app) => app.store.todayMinutes()), (v) => v >= 1 && v <= 30 + 60);
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

    // ---------------------------------------------------------------- QA regressions (adversarial pass)
    await section('QA: Tab in the time picker goes hours -> minutes -> AM/PM -> name (chevrons are not Tab stops)', async () => {
      await go(s, 'alarm');
      await s.page.click(`${WIN} .ck-page-alarm .ck-cmd-add`);
      await s.page.waitForSelector(`${DLG} .ck-picker`);
      await sleep(450);
      const order = [];
      for (let i = 0; i < 4; i++) {
        order.push(await s.page.evaluate(`document.activeElement?.getAttribute('aria-label') || document.activeElement?.tagName`));
        await s.page.keyboard.press('Tab');
      }
      check('Tab order in the alarm dialog', order, ['Hours', 'Minutes', 'AM or PM', 'Alarm name']);
      check('chevrons are not buttons (a dialog Tab trap would stop on them)', await s.page.evaluate(`[...document.querySelectorAll(${JSON.stringify(DLG + ' .ck-spin-btn')})].every((e) => e.tagName !== 'BUTTON')`), true);
      // typing a time column by column with Tab
      await s.page.focus(`${DLG} .ck-spin[aria-label="Hours"]`);
      await s.page.keyboard.type('9');
      await s.page.keyboard.press('Tab');
      await s.page.keyboard.type('05');
      await s.page.keyboard.press('Tab');
      await s.page.keyboard.press('a');
      check('9 : 05 AM typed with Tab between columns', await s.page.evaluate(`[...document.querySelectorAll(${JSON.stringify(DLG + ' .ck-spin')})].map((e) => e.getAttribute('aria-valuetext'))`), ['9', '05', 'AM']);
      // the chevrons still work with the mouse and keep the focus on their column
      await s.page.hover(`${DLG} .ck-spin[aria-label="Hours"]`);
      await s.page.click(`${DLG} .ck-spin[aria-label="Hours"] .ck-spin-btn.up`);
      check('chevron click: +1 hour', await s.page.getAttribute(`${DLG} .ck-spin[aria-label="Hours"]`, 'aria-valuetext'), '10');
      check('chevron click focuses its column', await s.page.evaluate(`document.activeElement?.getAttribute('aria-label')`), 'Hours');
      await s.page.keyboard.press('Escape');
      await sleep(250);
      // duration picker in the timer dialog
      await go(s, 'timer');
      await s.page.click(`${WIN} .ck-page-timer .ck-cmd-add`);
      await s.page.waitForSelector(`${DLG} .ck-dur`);
      await sleep(450);
      await s.page.focus(`${DLG} .ck-spin[aria-label="Hours"]`);
      const seq = [];
      for (let i = 0; i < 3; i++) {
        seq.push(await s.page.evaluate(`document.activeElement?.getAttribute('aria-label')`));
        await s.page.keyboard.press('Tab');
      }
      check('Tab order in the timer dialog', seq, ['Hours', 'Minutes', 'Seconds']);
      await s.page.keyboard.press('Escape');
      await sleep(250);
    });

    await section('QA: navigation pane is one Tab stop (roving tabindex), Home / End', async () => {
      await go(s, 'timer');
      check('only the selected item is tabbable', await s.page.evaluate(`[...document.querySelectorAll('${WIN} .ck-nav-item')].filter((e) => e.tabIndex === 0).map((e) => e.dataset.page)`), ['timer']);
      await s.page.focus(`${WIN} .ck-nav-item[data-page="timer"]`);
      await s.page.keyboard.press('End');
      check('End -> Settings', await s.page.evaluate(`document.activeElement?.dataset?.page`), 'settings');
      await s.page.keyboard.press('Home');
      check('Home -> Focus sessions', await s.page.evaluate(`document.activeElement?.dataset?.page`), 'focus');
      await s.page.keyboard.press('Tab');
      check('Tab leaves the pane', await s.page.evaluate(`!document.activeElement?.classList.contains('ck-nav-item')`), true);
    });

    await section('QA: double clicks never answer a dialog or start things twice', async () => {
      await go(s, 'focus');
      await CK(s, (app) => app.store.setPref('focus.dnd', 'ask'));
      await sleep(150);
      await s.page.dblclick(`${WIN} .ck-focus-start`);
      await sleep(400);
      check('double click on Start: the DND question is asked once', await s.page.evaluate(`document.querySelectorAll(${JSON.stringify(DLG)}).length`), 1);
      check('…and is not answered by the second click', await CK(s, (app) => [!!app.store.focus.session, !!app.ctx.settings.get('notifications.dnd')]), [false, false]);
      await s.page.keyboard.press('Escape');
      await sleep(300);
      check('Esc: no session', await CK(s, (app) => !!app.store.focus.session), false);
      // two concurrent starts (Space + click) make one session
      const r = await CK(s, async (app) => {
        app.store.setPref('focus.dnd', 'never');
        const p = app.page;
        await Promise.all([p.start(), p.start(), app.store.startFocus({ minutes: 20 })]);
        const id = app.store.focus.session?.id;
        await app.store.stopFocus();
        app.store.dismissFocusSummary();
        return { id: !!id, logged: app.store.focus.log.length };
      });
      check('concurrent starts -> one session', r.id, true);
      // a double click on a preset starts one timer
      await go(s, 'timer');
      const n15 = () => CK(s, (app) => app.store.timers.filter((x) => x.duration === 15 * 60000 && x.state === 'running').length);
      const before = await n15();
      // a real double click on the menu item (the two clicks are a few ms apart, whatever the machine load)
      await s.page.click(`${WIN} .ck-presets-btn`);
      await s.page.waitForSelector('body > .menu .menu-item');
      await s.page.locator('body > .menu .menu-item', { has: s.page.locator('.label', { hasText: /^15 min$/ }) }).dblclick();
      await sleep(300);
      check('double-clicking the 15 min preset starts one timer', (await n15()) - before, 1);
      await CK(s, (app) => app.store.timers.filter((x) => x.duration === 15 * 60000).forEach((x) => app.store.deleteTimer(x.id)));
      await CK(s, (app) => app.store.setPref('focus.dnd', 'ask'));
    });

    await section('QA: with Do not disturb on, a ringing alarm still shows its Snooze / Dismiss toast', async () => {
      await CK(s, (app) => app.ctx.settings.set('notifications.dnd', true));
      await until(s, (app) => app.ctx.settings.get('notifications.dnd') === true, { label: 'DND on' });
      await go(s, 'alarm');
      check('alarm page note says alarms ring through DND', await s.page.textContent(`${WIN} .ck-note`), (v) => v.includes('Alarms and timers still ring'));
      const id = await CK(s, (app) => {
        const a = app.store.addAlarm({ hour: 5, minute: 45, name: 'DND ring', days: [] });
        app.shell.reminders.set({ ...app.shell.reminders.get(`alarm-${a.id}`, 'clock'), at: Date.now() + 1000 });
        return a.id;
      });
      await until(s, (app, id) => app.store.alarms.find((x) => x.id === id)?.enabled === false, { arg: id, label: 'alarm rang', timeout: 8000 });
      const toast = s.page.locator('#toasts .toast', { hasText: 'DND ring' }).first();
      check('toast shown despite Do not disturb', await toast.count(), 1);
      check('…with Snooze and Dismiss', await toast.locator('.toast-actions .btn').allTextContents(), ['Snooze 10 min', 'Dismiss']);
      await toast.locator('.toast-actions .btn', { hasText: 'Dismiss' }).click();
      // an ordinary (non-alarm) notification stays hidden
      await CK(s, (app) => app.shell.notify({ title: 'Hidden by DND', body: 'x', appId: 'clock' }));
      await sleep(300);
      check('ordinary notifications stay hidden by DND', await s.page.locator('#toasts .toast', { hasText: 'Hidden by DND' }).count(), 0);
      await CK(s, (app, id) => app.store.deleteAlarm(id), id);
      await CK(s, (app) => app.ctx.settings.set('notifications.dnd', false));
      await until(s, (app) => !app.ctx.settings.get('notifications.dnd'), { label: 'DND off' });
    });

    await section('QA: focus time of a session that runs past midnight is split between the two days', async () => {
      const r = await CK(s, async (app) => {
        const st = app.store;
        const S = await import('app://shell/apps/clock/lib/store.js');
        const MIN = 60000;
        const M = new Date(2026, 9, 12).getTime(); // local midnight (Paris)
        const plan = S.planSegments(60, 30, 5); // 30 focus, 5 break, 30 focus = 65 min
        const base = { id: 'fx', minutes: 60, segs: plan, startedAt: M - 20 * MIN, state: 'running', pausedAt: null, pausedTotal: 0, pauses: [], dndChanged: false };
        const plain = st._focusByDay(base, base.startedAt + 65 * MIN, Math.round);
        // paused from 23:50 to 00:05
        const paused = { ...base, pauses: [[M - 10 * MIN, M + 5 * MIN]], pausedTotal: 15 * MIN };
        const withPause = st._focusByDay(paused, paused.startedAt + 80 * MIN, Math.round);
        // completed through stopFocus (on a scratch copy of the focus state)
        const saved = st.focus;
        st.focus = { session: { ...base }, history: {}, log: [], last: null };
        await st.stopFocus({ completed: true }, base.startedAt + 65 * MIN);
        const hist = st.focus.history;
        const last = st.focus.last;
        // live "today" while the session is still running at 00:10
        st.focus = { session: { ...base }, history: {}, log: [], last: null };
        const liveToday = st.todayMinutes(M + 10 * MIN);
        st.focus = saved;
        st.emit('focus');
        return { plain, withPause, hist, total: last.focusMin, liveToday };
      });
      check('20 min before midnight, 40 after', r.plain, { '2026-10-11': 20, '2026-10-12': 40 });
      check('a pause across midnight is not counted', r.withPause, { '2026-10-11': 10, '2026-10-12': 50 });
      check('stopFocus records each day its part', r.hist, { '2026-10-11': 20, '2026-10-12': 40 });
      check('the summary still shows the whole session', r.total, 60);
      check('while running at 00:10, today shows only the 10 min after midnight', r.liveToday, 10);
    });

    await section('QA: a time zone change re-registers alarms at their wall time', async () => {
      const r = await CK(s, (app) => {
        const st = app.store;
        const a = st.addAlarm({ hour: 9, minute: 0, name: 'tz', days: [] });
        const at0 = st.shell.reminders.get(`alarm-${a.id}`, 'clock').at;
        // pretend the reminder was computed in another zone (7 h later: earlier could already be in
        // the past at night, and the shell would ring it at once)
        st.shell.reminders.set({ ...st.shell.reminders.get(`alarm-${a.id}`, 'clock'), at: at0 + 7 * 3600000 });
        st.zone = 'Asia/Tokyo';
        const changed = st.checkZone();
        const at1 = st.shell.reminders.get(`alarm-${a.id}`, 'clock').at;
        const again = st.checkZone();
        st.deleteAlarm(a.id);
        return { changed, again, back: at1 === at0, zone: st.zone };
      });
      check('zone change detected once', [r.changed, r.again], [true, false]);
      check('alarm re-registered at 9:00 local', r.back, true);
      check('store follows the system zone', r.zone, 'Europe/Paris');
    });

    await section('QA: leftover focus reminders without a session are removed on reconcile', async () => {
      const r = await CK(s, (app) => {
        const st = app.store;
        if (st.focus.session) return 'session running';
        st.shell.reminders.set({ id: 'focus-7', appId: 'clock', at: Date.now() + 3600000, title: 'stale break', kind: 'reminder', data: { focus: 'gone' } });
        const before = st.shell.reminders.list('clock').some((x) => x.id === 'focus-7');
        st.reconcile();
        return [before, st.shell.reminders.list('clock').some((x) => x.id === 'focus-7')];
      });
      check('stale focus-7 reminder removed', r, [true, false]);
    });

    await section('QA: names are shown as text, never parsed as HTML', async () => {
      const evil = '<img src=x onerror="window.__ckXss=1"><b>bold</b>';
      const ids = await CK(s, (app, evil) => ({ a: app.store.addAlarm({ hour: 4, minute: 0, name: evil, days: [] }).id, t: app.store.addTimer({ name: evil, duration: 60000 }).id }), evil);
      await go(s, 'alarm');
      await sleep(150);
      check('alarm name rendered literally', await s.page.textContent(`${WIN} .ck-alarm[data-id="${ids.a}"] .ck-alarm-name-text`), evil);
      await go(s, 'timer');
      await sleep(150);
      check('timer name rendered literally', await s.page.textContent(`${WIN} .ck-timer[data-id="${ids.t}"] .ck-timer-name`), evil);
      check('no injected element', await s.page.evaluate(`document.querySelectorAll('img[src="x"], ${WIN} b').length`), 0);
      check('no script ran', await s.page.evaluate(`window.__ckXss === undefined`), true);
      check('reminder title is the plain name', (await reminders(s)).find((r) => r.id === `alarm-${ids.a}`)?.title, evil);
      await CK(s, (app, ids) => (app.store.deleteAlarm(ids.a), app.store.deleteTimer(ids.t)), ids);
    });

    await section('QA: Settings has a link to a per-app accent color (Settings > App themes)', async () => {
      await go(s, 'settings');
      const row = `${WIN} .ck-set-row[data-key="accent"]`;
      if (await s.page.locator(row).count()) {
        check('accent row', await s.page.textContent(`${row} .ck-set-text`), (v) => v.startsWith('Accent color'));
        await s.page.click(`${row} .btn`);
        await until(s, () => !!document.querySelector('.win.app-settings'), { label: 'Settings app opened' });
        await sleep(600);
        check('Settings opens on App themes', await s.page.evaluate(`document.querySelector('.win.app-settings')?.textContent.includes('App themes')`), true);
        await s.page.evaluate(`window.__aurora.wm.byApp('settings').forEach((w) => w.close(true))`);
        await sleep(400);
        await s.page.evaluate(`window.__aurora.wm.byApp('clock')[0]?.focus()`);
      } else check('accent row only with per-app themes', await CK(s, (app) => app.page.perAppThemes), false);
    });

    // ---------------------------------------------------------------- QA2 regressions (second adversarial pass)
    await section('QA2: stopwatch laps — header columns line up with the rows (wide and narrow windows)', async () => {
      await go(s, 'stopwatch');
      await CK(s, (app) => {
        app.store.stopwatch = { running: false, startedAt: 0, base: 4000000, laps: [1000000, 2500000, 3900000] };
        app.store.emit('stopwatch');
      });
      const cols = () =>
        CK(s, (app) => {
          const head = [...app.win.el.querySelectorAll('.ck-laps-head > *')].map((e) => e.getBoundingClientRect().left);
          const rows = [...app.win.el.querySelectorAll('.ck-lap')].map((r) => [...r.children].map((e) => e.getBoundingClientRect().left));
          return { tight: app.root.classList.contains('tight'), worst: Math.max(...rows.flatMap((r) => r.map((x, i) => Math.abs(x - head[i])))) };
        });
      for (const [w, h] of [
        [1040, 720],
        [480, 640],
      ]) {
        await CK(s, (app, sz) => app.win.setSize(sz[0], sz[1]), [w, h]);
        await sleep(350);
        const c = await cols();
        check(`laps columns aligned at ${w} px${c.tight ? ' (narrow layout)' : ''} (worst offset ${Math.round(c.worst)} px)`, c.worst, (v) => v < 1.5);
      }
      await CK(s, (app) => app.win.setSize(1040, 720));
      await sleep(300);
      await CK(s, (app) => app.store.swReset());
    });

    await section('QA2: picker neighbours are readable (secondary text), timer dialog has no blank error row', async () => {
      await go(s, 'alarm');
      await s.page.click(`${WIN} .ck-page-alarm .ck-cmd-add`);
      await s.page.waitForSelector(`${DLG} .ck-picker`);
      await sleep(300);
      const c = await s.page.evaluate(`(() => { const d = document.querySelector(${JSON.stringify(DLG)}); return [getComputedStyle(d.querySelector('.ck-spin-cell.above')).color, getComputedStyle(d.querySelector('.ck-dlg-preview')).color]; })()`);
      check('neighbour values use --text-2 (≥ 4.5:1), like the preview caption', c[0], c[1]);
      await s.page.keyboard.press('Escape');
      await sleep(250);
      await go(s, 'timer');
      await s.page.click(`${WIN} .ck-page-timer .ck-cmd-add`);
      await s.page.waitForSelector(`${DLG} .ck-dur`);
      await sleep(300);
      check('empty error row takes no space', await s.page.evaluate(`getComputedStyle(document.querySelector(${JSON.stringify(DLG + ' .ck-dlg-err')})).display`), 'none');
      for (const n of [0, 1, 2]) {
        await s.page.focus(`${DLG} .ck-dur .ck-spin >> nth=${n}`);
        await s.page.keyboard.type('00');
      }
      await s.page.locator(`${DLG} .dialog-footer .btn`, { hasText: 'Save' }).click();
      check('the error shows when there is one', await s.page.isVisible(`${DLG} .ck-dlg-err`), true);
      await s.page.keyboard.press('Escape');
      await sleep(250);
    });

    await section('QA2: at most 60 cities — the search dialog says so instead of doing nothing', async () => {
      await go(s, 'world');
      const r = await CK(s, async (app) => {
        const C = await import('app://shell/apps/clock/lib/cities.js');
        const saved = [...app.store.cities];
        const free = C.allCities().map((c) => c.id).filter((id) => !saved.includes(id));
        for (const id of free) if (app.store.cities.length < 60) app.store.addCity(id);
        const extra = C.cityById(free.at(-1));
        return { n: app.store.cities.length, refused: app.store.addCity(extra.id) === false, saved, name: extra.en };
      });
      check('60 cities stored, the 61st refused', [r.n, r.refused], [60, true]);
      await s.page.click(`${WIN} .ck-page-world .ck-cmd-add`);
      await s.page.waitForSelector(`${DLG} input[type="search"]`);
      await sleep(80);
      await s.page.keyboard.type(r.name);
      await sleep(150);
      await s.page.keyboard.press('Enter');
      await sleep(400);
      check('limit explained in a dialog', await s.page.textContent(`${DLG} .dialog-body`), (v) => /up to 60 cities/.test(v));
      await s.page.keyboard.press('Escape');
      await sleep(250);
      await CK(s, (app, saved) => {
        app.store.cities = saved;
        app.store.persist('cities');
        app.store.emit('cities');
      }, r.saved);
      check('cities restored', await CK(s, (app) => app.store.cities.length), r.saved.length);
    });

    await section('QA2: a snoozed repeating alarm says when it rings again; deleting it cancels the snooze', async () => {
      await go(s, 'alarm');
      const id = await CK(s, (app) => {
        const a = app.store.addAlarm({ hour: 5, minute: 0, name: 'Daily', days: [0, 1, 2, 3, 4, 5, 6] });
        const R = app.shell.reminders;
        R.set({ ...R.get(`alarm-${a.id}`, 'clock'), id: `alarm-${a.id}~snooze`, at: Date.now() + 5 * 60000, repeat: null }); // what Snooze on its toast does
        return a.id;
      });
      const txt = await until(s, (app, id) => {
        const v = app.win.el.querySelector(`.ck-alarm[data-id="${id}"] .ck-alarm-when-text`)?.textContent || '';
        return /^Snoozed until /.test(v) && v;
      }, { arg: id, label: 'snoozed repeating alarm text' });
      check('repeating alarm: Snoozed until …', txt, (v) => /^Snoozed until \d{1,2}:\d\d [AP]M$/.test(v));
      await CK(s, (app, id) => app.store.deleteAlarm(id), id);
      check('deleting it removes the snoozed ring too', (await reminders(s)).some((r) => r.id.startsWith(`alarm-${id}`)), false);
    });

    await section('QA3: closing Clock with a dialog open leaves no key handler behind (Tab still works in other windows)', async () => {
      // count document-level keydown listeners (ui.dialog adds one per open dialog)
      await s.page.evaluate(`(() => {
        if (window.__ckDocKeys != null) return;
        window.__ckDocKeys = 0;
        const add = document.addEventListener.bind(document), rem = document.removeEventListener.bind(document);
        const seen = new Set();
        document.addEventListener = (t, f, o) => { if (t === 'keydown' && !seen.has(f)) { seen.add(f); window.__ckDocKeys++; } return add(t, f, o); };
        document.removeEventListener = (t, f, o) => { if (t === 'keydown' && seen.has(f)) { seen.delete(f); window.__ckDocKeys--; } return rem(t, f, o); };
      })()`);
      const base = await s.page.evaluate('window.__ckDocKeys');
      await go(s, 'alarm');
      await s.page.click(`${WIN} .ck-cmd-add`);
      await s.page.waitForSelector(`${DLG} .ck-picker`);
      check('the open dialog has its document key handler', await s.page.evaluate('window.__ckDocKeys'), base + 1);
      // taskbar button > right-click > Close window, while the dialog is open
      await s.page.click('.tb-btn.tb-app[data-app="clock"]', { button: 'right' });
      await s.page.locator('.menu .menu-item', { hasText: 'Close window' }).first().click();
      const t0 = Date.now();
      while (Date.now() - t0 < 4000 && (await s.page.evaluate(`window.__aurora.wm.byApp('clock').length`))) await sleep(60);
      check('Clock closed', await s.page.evaluate(`window.__aurora.wm.byApp('clock').length`), 0);
      check('no key handler left behind', await s.page.evaluate('window.__ckDocKeys'), base);
      await s.page.evaluate(`window.__aurora.registry.launch('settings')`);
      await s.page.waitForSelector('.win.app-settings .st-user, .win.app-settings input', { timeout: 8000 });
      await sleep(400);
      const focusSeq = [];
      for (let i = 0; i < 3; i++) {
        await s.page.keyboard.press('Tab');
        await sleep(60);
        focusSeq.push(await s.page.evaluate(`(() => { const a = document.activeElement; return a ? a.tagName + '.' + String(a.className).split(' ')[0] + (a.getAttribute('aria-label') || '') : ''; })()`));
      }
      check('Tab moves the focus in another window afterwards', new Set(focusSeq).size, (n) => n >= 2);
      await s.page.evaluate(`window.__aurora.wm.byApp('settings')[0]?.close(true)`);
      await s.page.evaluate(`window.__aurora.registry.launch('clock', { page: 'alarm' })`);
      await s.page.waitForSelector(`${WIN} .ck`);
      await until(s, (app) => !!app?.store && app.pageId === 'alarm', { label: 'clock reopened' });
    });

    await section('QA3: Settings keeps the keyboard focus on the app theme radios while the page refreshes', async () => {
      await go(s, 'settings');
      const radio = (v) => `${WIN} .ck-set-row[data-key="theme"] input[type="radio"][value="${v}"]`;
      await s.page.waitForSelector(radio('system'));
      await s.page.focus(radio('system'));
      await s.page.keyboard.press('ArrowUp'); // -> Dark
      await until(s, (app) => app.ctx.settings.get('appThemes')?.clock?.theme === 'dark', { label: 'app theme dark' });
      await sleep(250);
      const act = () => s.page.evaluate(`(() => { const a = document.activeElement; return a && a.closest('.win.app-clock') ? a.type + ':' + a.value : 'lost:' + (a && a.tagName); })()`);
      check('focus stays on the Dark radio after the page refreshed', await act(), 'radio:dark');
      await s.page.keyboard.press('ArrowDown'); // -> Use system setting
      await until(s, (app) => app.ctx.settings.get('appThemes')?.clock?.theme === 'system', { label: 'app theme system' });
      await sleep(250);
      check('…and on Use system setting after the next arrow key', await act(), 'radio:system');
      await s.page.evaluate(`window.__aurora.settings.set('appThemes', {})`);
      await sleep(200);
    });

    await section('QA3: a focus session that ends under the shell Focus mode hands Do not disturb over to it', async () => {
      await s.page.evaluate(`window.__aurora.settings.set('notifications.dnd', false)`);
      await go(s, 'focus');
      await CK(s, (app) => app.store.startFocus({ minutes: 15, dnd: true }));
      check('Clock turned Do not disturb on', await s.page.evaluate(`window.__aurora.settings.get('notifications.dnd')`), true);
      await s.page.evaluate(`window.__aurora.shell.focus.start(60)`);
      await sleep(300);
      check('Focus mode saved "on" as the value to restore', await s.page.evaluate(`window.__aurora.settings.get('focusMode.prevDnd')`), true);
      await CK(s, (app) => app.store.stopFocus({ completed: false }));
      await sleep(300);
      const mid = await s.page.evaluate(`({ dnd: window.__aurora.settings.get('notifications.dnd'), prev: window.__aurora.settings.get('focusMode.prevDnd'), quiet: document.documentElement.dataset.focusQuiet || null })`);
      check('Do not disturb stays on while Focus mode runs', mid, { dnd: true, prev: false, quiet: 'on' });
      await s.page.evaluate(`window.__aurora.shell.focus.stop()`);
      await sleep(300);
      check('…and goes back off when Focus mode ends (not stuck on)', await s.page.evaluate(`window.__aurora.settings.get('notifications.dnd')`), false);
      await CK(s, (app) => app.store.dismissFocusSummary());
    });

    await section('QA3: stopwatch adds lap rows one at a time and moves the Fastest / Slowest tags', async () => {
      await go(s, 'stopwatch');
      const r = await CK(s, async (app) => {
        const st = app.store;
        st.swReset();
        const T = Date.now() - 20000;
        st.swStart(T);
        st.swLap(T + 1000); // 1.00
        st.swLap(T + 3000); // 2.00  slowest
        st.swLap(T + 3500); // 0.50  fastest
        const rows = () => [...app.win.el.querySelectorAll('.ck-lap')];
        const firstRow = rows().find((x) => x.dataset.lap === '1');
        const tags = () => rows().map((x) => [x.dataset.lap, x.querySelector('.ck-lap-tag')?.classList.contains('fast') ? 'fast' : x.querySelector('.ck-lap-tag')?.classList.contains('slow') ? 'slow' : '', x.classList.contains('fast') ? 'F' : x.classList.contains('slow') ? 'S' : ''].join(''));
        const before = tags();
        st.swLap(T + 6500); // 3.00  new slowest
        const after = tags();
        const same = rows().find((x) => x.dataset.lap === '1') === firstRow;
        st.swPause(T + 7000);
        return { before, after, same, n: rows().length };
      });
      check('3 laps: lap 3 fastest, lap 2 slowest (newest first)', r.before, ['3fastF', '2slowS', '1']);
      check('a 4th, slower lap takes the Slowest tag from lap 2', r.after, ['4slowS', '3fastF', '2', '1']);
      check('existing rows are kept (no rebuild of the whole table)', r.same, true);
      check('one row per lap', r.n, 4);
      await CK(s, (app) => app.store.swReset());
    });

    await section('QA3: world clock refreshes city cards once a minute (the local clock every second)', async () => {
      await go(s, 'world');
      const added = await CK(s, (app) => ['tokyo-jp', 'kolkata-in', 'new-york-city-us'].filter((id) => app.store.addCity(id)));
      await sleep(200);
      const r = await CK(s, (app) => {
        const pg = app.page;
        const n = pg.cards.size;
        let calls = [];
        const orig = pg.fillTime;
        pg.fillTime = function (c, at) {
          calls.push(c.local ? 'local' : 'city');
          return orig.call(this, c, at);
        };
        const T = Math.floor(Date.now() / 60000) * 60000 + 10000; // hh:mm:10
        pg.tick(T, true);
        calls = [];
        pg.tick(T + 1000); // next second, same minute
        const sameMinute = calls.slice();
        calls = [];
        pg.tick(T + 50000); // hh:(mm+1):00
        const nextMinute = calls.slice();
        pg.fillTime = orig;
        pg.tick(Date.now(), true);
        return { n, sameMinute, nextMinute };
      });
      check('several cards on the page', r.n, (v) => v >= 3);
      check('next second: only the local card is refreshed', r.sameMinute, ['local']);
      check('next minute: every card is refreshed', r.nextMinute.length, r.n);
      await CK(s, (app, ids) => ids.forEach((id) => app.store.removeCity(id)), added);
    });

    await section('QA3: bundled cities include Adelaide (+9:30 with DST), Zurich, Calgary, Easter Island, Norfolk Island', async () => {
      const r = await s.page.evaluate(`(async () => {
        const C = await import('app://shell/apps/clock/lib/cities.js');
        const T = await import('app://shell/apps/clock/lib/time.js');
        const pick = (q) => C.searchCities(q, 'en', 3)[0];
        const a = pick('Adelaide');
        return {
          names: ['Adelaide', 'Zurich', 'Calgary', 'Easter Island', 'Norfolk'].map((q) => pick(q)?.en || null),
          fr: C.searchCities('Pâques', 'fr', 1)[0]?.fr || null,
          tz: a?.tz,
          jan: T.zoneOffset(a.tz, Date.UTC(2026, 0, 15)),
          jul: T.zoneOffset(a.tz, Date.UTC(2026, 6, 15)),
          valid: C.allCities().every((c) => T.isValidZone(c.tz)),
          count: C.allCities().length,
        };
      })()`);
      check('found by name', r.names, ['Adelaide', 'Zurich', 'Calgary', 'Easter Island', 'Norfolk Island']);
      check('French name', r.fr, 'Île de Pâques');
      check('Adelaide zone and its half-hour offsets (summer / winter)', [r.tz, r.jan, r.jul], ['Australia/Adelaide', 630, 570]);
      check('every bundled zone is valid', r.valid, true);
      check('about 430 cities', r.count, (n) => n >= 425 && n <= 450);
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
      // long names must ellipsize (they used to widen the grid past the window at the minimum size)
      st.addAlarm({ hour: 7, minute: 45, name: 'Un nom d’alarme vraiment très très long pour voir ce qui se passe', days: [2, 4], enabled: false });
      st.addTimer({ name: 'Un nom de minuteur vraiment très long pour tester la mise en page', duration: 99 * 3600000 + 59 * 60000 + 59000 });
      st.stopwatch = { running: false, startedAt: 0, base: 4000000, laps: [1000000, 2500000, 3900000] };
      st.emit('stopwatch');
    });

    await section('French: strings, 24 h format, week order, offsets', async () => {
      check('window title', await s.page.evaluate(`window.__aurora.wm.byApp('clock')[0].title`), 'Horloge');
      check('nav labels', await s.page.evaluate(`[...document.querySelectorAll('${WIN} .ck-nav-label')].map((e) => e.textContent)`), ['Alarmes', 'Minuteurs', 'Chronomètre', 'Horloges', 'Concentration', 'Paramètres']);
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
        const box = sc.getBoundingClientRect();
        if (sc.scrollWidth > sc.clientWidth + 1) bad.push(`page ${sc.scrollWidth}>${sc.clientWidth}`);
        for (const el of app.root.querySelectorAll('.ck-card, .ck-set-row, .ck-note, .ck-cmdbar, .ck-sw-display, .ck-focus-main, .ck-lap, .ck-laps-head')) {
          if (!el.offsetParent) continue;
          if (el.scrollWidth > el.clientWidth + 2) bad.push(`${el.className.split(' ').slice(0, 3).join('.')} ${el.scrollWidth}>${el.clientWidth}`);
          // a card wider than the page (a grid column sized by a long name) sticks out on the right
          const r = el.getBoundingClientRect();
          if (r.right > box.right + 1) bad.push(`${el.className.split(' ').slice(0, 3).join('.')} sticks out ${Math.round(r.right - box.right)} px`);
        }
        // lap table header: cells must not overlap each other (Copy laps used to cover "Total")
        const head = [...app.root.querySelectorAll('.ck-laps-head > *')].filter((e) => e.offsetParent).map((e) => e.getBoundingClientRect());
        for (let i = 1; i < head.length; i++) if (head[i].left < head[i - 1].right - 1) bad.push(`lap header cells ${i - 1}/${i} overlap`);
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

    await section('QA3 (minimum size): icon-only pane has tooltips, its overlay closes when Tab leaves it, the city search scrolls once', async () => {
      check('each icon-only item names itself in a tooltip', await s.page.evaluate(`[...document.querySelectorAll('${WIN} .ck-nav-item')].map((e) => e.dataset.tip || '')`), [
        'Alarmes',
        'Minuteurs',
        'Chronomètre',
        'Horloges',
        'Concentration',
        'Paramètres',
      ]);
      await s.page.click(`${WIN} .ck-burger`);
      await sleep(250);
      check('labels shown in the open overlay: no redundant tooltips', await s.page.evaluate(`[...document.querySelectorAll('${WIN} .ck-nav-item')].some((e) => e.dataset.tip)`), false);
      await s.page.keyboard.press('Tab'); // from the selected item into the page
      await sleep(250);
      check('Tab out of the overlay pane closes it (light dismiss)', await CK(s, (app) => [app.root.classList.contains('nav-open'), app.navEl.contains(document.activeElement)]), [false, false]);
      await go(s, 'world');
      await s.page.click(`${WIN} .ck-page-world .ck-cmd-add`);
      await s.page.waitForSelector(`${DLG} input`);
      await s.page.keyboard.type('san');
      await sleep(300);
      const r = await s.page.evaluate(`(() => {
        const d = document.querySelector(${JSON.stringify(DLG)});
        const b = d.querySelector('.dialog-body');
        const l = d.querySelector('.ck-search-list');
        const w = document.querySelector(${JSON.stringify(WIN)}).getBoundingClientRect();
        const dr = d.getBoundingClientRect();
        return { bodyScrolls: b.scrollHeight > b.clientHeight + 1, listScrolls: l.scrollHeight > l.clientHeight, inside: dr.top >= w.top - 1 && dr.bottom <= w.bottom + 1, listH: Math.round(l.clientHeight) };
      })()`);
      check('search dialog in a 500 px window: only the result list scrolls', [r.bodyScrolls, r.listScrolls, r.inside], [false, true, true]);
      check('…and the list keeps a usable height', r.listH, (v) => v >= 112);
      await s.page.keyboard.press('Escape');
      await sleep(250);
    });

    await section('maximized in French', async () => {
      await CK(s, (app) => app.win.maximize());
      await sleep(500);
      for (const p of ['world', 'timer', 'focus', 'stopwatch', 'alarm', 'settings']) {
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
      // (polls for up to 4 s: other test runs may load the machine)
      const digits = () => s.page.evaluate(`[...document.querySelectorAll('${WIN} .ck-timer.state-running .ck-timer-time')].map((e) => e.textContent)[0]`);
      const a = await digits();
      let b = a;
      for (let i = 0; i < 20 && b === a; i++) {
        await sleep(200);
        b = await digits();
      }
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

// ================================================================== launch D: other screen sizes, leaks, save errors
async function runSizes(size, lang, theme) {
  const s = await launchShell({ open: ['clock'], lang, theme, size, env: { TZ: 'Europe/Paris' } });
  current = s;
  const tag = `${size} ${lang} ${theme}`;
  try {
    await s.page.waitForSelector(`${WIN} .ck`, { timeout: 20000 });
    await until(s, (app) => !!app?.store, { label: 'clock ready' });
    await CK(s, (app) => {
      const st = app.store;
      for (const id of ['new-york-city-us', 'tokyo-jp', 'kolkata-in', 'sydney-au', 'kathmandu-np']) st.addCity(id);
      st.addAlarm({ hour: 6, minute: 30, name: 'A rather long alarm name that has to be cut with an ellipsis', days: [1, 3, 5] });
      st.addTimer({ name: 'A rather long timer name that has to be cut with an ellipsis', duration: 25 * 60000 });
      st.startTimer(st.timers[1].id);
    });
    const pageOverflow = () =>
      CK(s, (app) => {
        const bad = [];
        const box = app.scroller.getBoundingClientRect();
        if (app.scroller.scrollWidth > app.scroller.clientWidth + 1) bad.push('horizontal scroll');
        for (const el of app.root.querySelectorAll('.ck-card, .ck-set-row, .ck-cmdbar, .ck-lap, .ck-map-card')) {
          if (!el.offsetParent) continue;
          const r = el.getBoundingClientRect();
          if (r.right > box.right + 1 || r.left < box.left - 1) bad.push(`${el.className.split(' ').slice(0, 3).join('.')} outside the page`);
        }
        return bad;
      });

    await section(`${tag}: maximized, every page fits; the world map keeps its proportions (no stretch, no repeat)`, async () => {
      await CK(s, (app) => app.win.maximize());
      await sleep(600);
      for (const p of ['focus', 'timer', 'alarm', 'stopwatch', 'world', 'settings']) {
        await go(s, p);
        await sleep(300);
        check(`${tag}: no overflow on ${p}`, await pageOverflow(), []);
      }
      await go(s, 'world');
      await sleep(400);
      const m = await CK(s, (app) => {
        const p = app.page;
        const r = p.map.getBoundingClientRect();
        const vb = p.mapSvg.getAttribute('viewBox').split(' ').map(Number);
        const pins = [...p.pins.querySelectorAll('.ck-pin')].map((el) => {
          const b = el.getBoundingClientRect();
          return { id: el.dataset.id, x: b.left - r.left, y: b.top - r.top };
        });
        // pixel x of a longitude in the drawn map vs the pin
        const ny = pins.find((x) => x.id === 'new-york-city-us');
        const expX = ((-74.0 + 180 - vb[0]) / vb[2]) * r.width;
        const page = p.el.getBoundingClientRect();
        const card = p.mapCard.getBoundingClientRect();
        // suns whose centre is inside the visible 0..360 view (the ±360° copies only show at the date line)
        const sunsInView = p.suns.filter((g) => {
          const x = Number(/translate\(([-\d.]+)/.exec(g.getAttribute('transform') || '')?.[1]);
          return x >= vb[0] && x <= vb[0] + vb[2];
        }).length;
        return {
          w: r.width, h: r.height, vb, aspect: r.width / r.height, vbAspect: vb[2] / vb[3], lands: p.lands.length, sunsInView,
          centred: Math.abs(card.left + card.width / 2 - (page.left + page.width / 2)), screenH: window.innerHeight,
          nyDx: ny ? Math.abs(ny.x - expX) : null, inside: pins.every((x) => x.x >= 0 && x.x <= r.width && x.y >= 0 && x.y <= r.height),
        };
      });
      check(`${tag}: map not distorted (viewBox aspect = box aspect)`, Math.abs(m.aspect - m.vbAspect), (v) => v < 0.02);
      check(`${tag}: the map shows the world exactly once (360°)`, [m.vb[0], m.vb[2]], [0, 360]);
      check(`${tag}: one land shape, one sun in view (no repeated continents)`, [m.lands, m.sunsInView], [1, 1]);
      check(`${tag}: map height at most 60 % of the screen`, m.h, (v) => v <= m.screenH * 0.6 + 1);
      check(`${tag}: map centred on the page`, m.centred, (v) => v < 2);
      check(`${tag}: pins inside the map`, m.inside, true);
      check(`${tag}: New York pin at its longitude`, m.nyDx, (v) => v != null && v < 6);
      // pin labels: none overlaps another label or another city's dot, and each stays inside the map
      const lab = await CK(s, (app) => {
        const p = app.page;
        const box = p.pins.getBoundingClientRect();
        const ov = (a, b) => !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom);
        const pins = [...p.pins.querySelectorAll('.ck-pin')];
        const labels = pins.map((el) => (el.classList.contains('nolabel') ? null : el.querySelector('.ck-pin-label').getBoundingClientRect()));
        const dots = pins.map((el) => el.querySelector('.ck-pin-dot').getBoundingClientRect());
        const bad = [];
        labels.forEach((l, i) => {
          if (!l) return;
          if (l.left < box.left || l.right > box.right) bad.push(`${pins[i].dataset.id} outside`);
          labels.forEach((m, j) => j > i && m && ov(l, m) && bad.push(`${pins[i].dataset.id}/${pins[j].dataset.id} labels`));
          dots.forEach((d, j) => j !== i && ov(l, d) && bad.push(`${pins[i].dataset.id} label over ${pins[j].dataset.id} dot`));
        });
        return { bad, shown: labels.filter(Boolean).length, tips: pins.every((el) => /·/.test(el.querySelector('.ck-pin-dot').dataset.tip || '')) };
      });
      check(`${tag}: pin labels never cover another label or dot`, lab.bad, []);
      check(`${tag}: most pin labels shown`, lab.shown, (n) => n >= 4);
      check(`${tag}: every pin dot has a name · time tooltip`, lab.tips, true);
      await shot(s, `world-${size}`, { clip: false });
    });

    await section(`${tag}: opening and closing Clock 15 times (some with a dialog open) leaves no listeners behind`, async () => {
      await s.page.evaluate(`(() => {
        const A = window.__aurora;
        window.__ckSubs = { settings: 0, i18n: 0, doc: 0, win: 0 };
        const wrap = (obj, kind) => {
          const orig = obj.on.bind(obj);
          obj.on = (k, fn) => { window.__ckSubs[kind]++; const off = orig(k, fn); let done = false; return () => { if (!done) { done = true; window.__ckSubs[kind]--; } return off?.(); }; };
        };
        wrap(A.settings, 'settings');
        wrap(A.i18n, 'i18n');
        for (const [obj, k] of [[document, 'doc'], [window, 'win']]) {
          const add = obj.addEventListener.bind(obj), rem = obj.removeEventListener.bind(obj);
          const seen = new Set();
          obj.addEventListener = (t, f, o) => { if (!seen.has(f)) { seen.add(f); window.__ckSubs[k]++; } return add(t, f, o); };
          obj.removeEventListener = (t, f, o) => { if (seen.has(f)) { seen.delete(f); window.__ckSubs[k]--; } return rem(t, f, o); };
        }
      })()`);
      const stats = () => s.page.evaluate(`(() => { const A = window.__aurora; return { subs: { ...window.__ckSubs }, wm: [...A.wm._h.values()].reduce((n, x) => n + x.size, 0), store: window.__ckStore ? window.__ckStore.subs.size : null, wins: A.wm.byApp('clock').length, layers: document.querySelectorAll('.dialog-layer').length }; })()`);
      const closeClock = async () => {
        await s.page.evaluate(`window.__aurora.wm.byApp('clock').find((w) => !w._closing)?.close()`);
        const t0 = Date.now();
        while (Date.now() - t0 < 5000 && (await s.page.evaluate(`window.__aurora.wm.byApp('clock').length`))) await sleep(50);
      };
      await s.page.evaluate(`window.__ckStore = document.querySelector('${WIN}').__clock.store`);
      await closeClock();
      await sleep(300);
      const base = await stats();
      const pages = ['focus', 'timer', 'alarm', 'stopwatch', 'world', 'settings'];
      for (let i = 0; i < 15; i++) {
        const p = pages[i % pages.length];
        await s.page.evaluate(`window.__aurora.registry.launch('clock', { page: '${p}' })`);
        await until(s, (app, p) => !!app && !app.closed && app.pageId === p && !app.win._closing, { arg: p, label: `clock open on ${p}` });
        await sleep(200);
        // every other round, close it with a dialog still open (taskbar "Close window" does that)
        if (i % 2 === 1) {
          const opener = { focus: `${WIN} .ck-focus-progress .icon-btn`, timer: `${WIN} .ck-cmd-add`, alarm: `${WIN} .ck-cmd-add`, world: `${WIN} .ck-cmd-add`, stopwatch: null, settings: null }[p];
          if (opener) {
            await s.page.click(opener);
            await s.page.waitForSelector(`${WIN} > .dialog-layer .dialog`, { timeout: 4000 });
          }
        }
        await closeClock();
        await sleep(120);
      }
      await sleep(400);
      const after = await stats();
      check('no Clock window left', after.wins, 0);
      check('store listeners back to zero', [base.store, after.store], [0, 0]);
      check('settings / language / document / window listeners back to baseline', after.subs, base.subs);
      check('window manager listeners back to baseline', after.wm, base.wm);
      check('no dialog layer left behind', after.layers, 0);
      await s.page.evaluate(`window.__aurora.registry.launch('clock', { page: 'alarm' })`);
      await s.page.waitForSelector(`${WIN} .ck`);
      await until(s, (app) => !!app?.store, { label: 'clock reopened' });
      check('state survived the 15 reopenings', await CK(s, (app) => [app.store.cities.length, app.store.timers.some((x) => x.state === 'running')]), [5, true]);
    });

    await section(`${tag}: a failed save shows an error bar, which goes away once saving works again`, async () => {
      const dir = path.join(s.home, '.config', 'aurora', 'apps', 'clock');
      const file = path.join(dir, 'alarms.json');
      fs.rmSync(file, { force: true });
      fs.mkdirSync(path.join(file, 'blocker'), { recursive: true }); // alarms.json is now a directory: the write fails
      await go(s, 'alarm');
      await CK(s, (app) => app.store.addAlarm({ hour: 5, minute: 5, name: 'Disk full', days: [] }));
      await until(s, (app) => !!app.store.saveError, { label: 'save error', timeout: 4000 });
      check('error bar shown', await s.page.isVisible(`${WIN} .ck-info-slot .infobar.error`), true);
      check('the alarm still works (registered)', await CK(s, (app) => app.shell.reminders.list('clock').some((r) => r.title === 'Disk full')), true);
      fs.rmSync(file, { recursive: true, force: true });
      await CK(s, (app) => app.store.persist('alarms'));
      await until(s, (app) => !app.store.saveError, { label: 'save works again', timeout: 4000 });
      check('error bar gone', await s.page.isVisible(`${WIN} .ck-info-slot .infobar.error`), false);
      check('alarms written', JSON.parse(fs.readFileSync(file, 'utf8')).some((a) => a.name === 'Disk full'), true);
    });

    await section(`console (${tag}): no unexpected errors from Clock`, async () => {
      // the save failure above is logged on purpose
      check('no Clock errors in the console', clockErrors(s).filter((l) => !/saving alarms failed/.test(l)), []);
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
    // rang 5 min ago while Clock was never opened, and the user pressed Snooze on its notification
    { id: 'snz', hour: 6, minute: 0, name: 'Snoozed', days: [], enabled: true, at: now - 5 * 60000 },
    { id: 'arep', hour: 9, minute: 0, name: 'Duplicate id', days: [], enabled: false },
  ]);
  w('timers', [
    { id: 'tdone', name: 'Ended', duration: 60000, state: 'running', endAt: now - 5000, runTotal: 60000 },
    { id: 'tlive', name: 'Live', duration: 600000, state: 'running', endAt: now + 300000, runTotal: 600000 },
    { id: 'tlive', name: 'Duplicate id', duration: 60000 },
  ]);
  w('cities', ['tokyo-jp', 'no-such-city', 'tokyo-jp', 'kolkata-in', 42]);
  w('prefs', { focus: { minutes: 17 } });
  // the shell re-registered the snoozed one-shot ring under the alarm's own id
  const shellDir = path.join(home, '.config', 'aurora', 'apps', 'shell');
  fs.mkdirSync(shellDir, { recursive: true });
  fs.writeFileSync(path.join(shellDir, 'reminders.json'), JSON.stringify([{ id: 'alarm-snz', appId: 'clock', at: now + 5 * 60000, title: 'Snoozed', body: '6:00 AM', repeat: null, kind: 'alarm', snoozeMinutes: 10, data: { alarmId: 'snz' } }]));
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
          history: Object.values(st.focus.history).reduce((n, v) => n + v, 0),
          dnd: app.ctx.settings.get('notifications.dnd'),
          rems: app.shell.reminders.list('clock').map((x) => x.id).sort(),
          snz: a('snz')?.enabled,
          snzAt: app.shell.reminders.get('alarm-snz', 'clock')?.at,
          repName: a('arep')?.name,
          timerIds: st.timers.map((x) => x.id),
          cities: st.cities,
          focusMin: st.prefs.focus.minutes,
          loadErrors: st.loadErrors,
        };
      });
      check('one-shot alarm that rang while closed is off', r.once, false);
      check('repeating alarm still on', r.rep, true);
      check('repeating alarm rescheduled in the future', r.repAt > Date.now(), true);
      check('corrupt alarm sanitized', r.bad, [23, 0, [], false, '']);
      check('garbage entries and duplicate ids dropped', r.count, 5);
      check('the first of two alarms with one id is kept', r.repName, 'Weekdays');
      check('snoozed one-shot alarm: turned off…', r.snz, false);
      check('…but its snoozed ring is kept (it still rings in 5 min)', r.snzAt && Math.round((r.snzAt - Date.now()) / 60000), 5);
      check('duplicate timer id dropped', r.timerIds, ['tdone', 'tlive']);
      check('unknown and duplicate cities dropped', r.cities, ['tokyo-jp', 'kolkata-in']);
      check('focus length put back on the 5-minute grid', r.focusMin, 15);
      check('valid files are not reported as damaged', r.loadErrors, []);
      check('timer that ended while closed is done', r.tdone, 'done');
      check('live timer still running', r.tlive, 'running');
      check('stopwatch kept running from its timestamps', r.sw, (v) => v >= 6000 && v < 60000);
      check('stopwatch running', r.swRunning, true);
      check('finished focus session closed', r.session, null);
      check('…as completed', r.last?.completed, true);
      check('…and its 30 minutes counted (on the day(s) they were done)', r.history, 30);
      check('…and DND restored', r.dnd, false);
      check('reminders re-registered', r.rems, ['alarm-arep', 'alarm-snz', 'timer-tlive']);
      await go(s, 'focus');
      // (the session that completed while Clock was closed shows its summary first)
      check('summary of the session that ended while closed', await s.page.textContent(`${WIN} .ck-focus-done .subtitle`), 'Well done');
      await s.page.click(`${WIN} .ck-focus-done .btn`);
      check('the focus picker shows the stored length', await s.page.getAttribute(`${WIN} .ck-focus-spin`, 'aria-valuenow'), '15');
      await go(s, 'world');
      await sleep(200);
      check('one card per stored city', await s.page.evaluate(`[...document.querySelectorAll('${WIN} .ck-city:not(.local)')].map((e) => e.dataset.id)`), ['tokyo-jp', 'kolkata-in']);
      await s.page.click(`${WIN} .ck-city[data-id="kolkata-in"]`, { button: 'right' });
      await s.page.locator('.menu .menu-item', { hasText: 'Move up' }).click();
      check('Move up on the second city makes it first', await CK(s, (app) => app.store.cities), ['kolkata-in', 'tokyo-jp']);
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

// ================================================================== launch E: damaged storage files
async function runDamaged() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-home-'));
  const dir = path.join(home, '.config', 'aurora', 'apps', 'clock');
  fs.mkdirSync(dir, { recursive: true });
  const brokenAlarms = '[{"id":"a1","hour":6,"minute":0,"name":"My alarm","days":[1],"enabled":tr';
  fs.writeFileSync(path.join(dir, 'alarms.json'), brokenAlarms); // truncated JSON
  fs.writeFileSync(path.join(dir, 'timers.json'), JSON.stringify({ not: 'a list' })); // wrong shape
  fs.writeFileSync(path.join(dir, 'cities.json'), JSON.stringify(['tokyo-jp'])); // fine
  const s = await launchShell({ open: ['clock'], lang: 'en', theme: 'light', home, env: { TZ: 'Europe/Paris' } });
  current = s;
  try {
    await s.page.waitForSelector(`${WIN} .ck`, { timeout: 20000 });
    await until(s, (app) => !!app?.store, { label: 'clock ready' });
    await section('damaged storage: files set aside (never replaced by first-run defaults), warning bar, dismiss', async () => {
      await sleep(400);
      const r = await CK(s, (app) => ({ alarms: app.store.alarms.length, timers: app.store.timers.length, cities: app.store.cities, errs: app.store.loadErrors.map((e) => [e.name, /^\w+\.unreadable-[\d-]+\.json$/.test(e.backup || '')]) }));
      check('no "Good morning" / default timers over the damaged files', [r.alarms, r.timers], [0, 0]);
      check('readable files still load', r.cities, ['tokyo-jp']);
      check('damaged files reported, each with a backup name', r.errs, [
        ['alarms', true],
        ['timers', true],
      ]);
      const files = fs.readdirSync(dir).sort();
      const backup = files.find((f) => f.startsWith('alarms.unreadable-'));
      check('damaged alarms.json renamed, not overwritten', [files.includes('alarms.json'), !!backup], [false, true]);
      check('backup keeps the original bytes', backup && fs.readFileSync(path.join(dir, backup), 'utf8'), brokenAlarms);
      const bar = `${WIN} .ck-info-slot .ck-load-error`;
      check('warning bar names what was lost and the backup', await s.page.textContent(bar), (v) => v.includes('(alarms, timers)') && v.includes(backup));
      await s.page.click(`${bar} .btn`);
      check('dismissed', await s.page.isVisible(bar), false);
      await CK(s, (app) => app.store.addAlarm({ hour: 7, minute: 0, name: 'Fresh', days: [] }));
      await sleep(400);
      check('new alarms are saved to a fresh alarms.json', JSON.parse(fs.readFileSync(path.join(dir, 'alarms.json'), 'utf8')).map((a) => a.name), ['Fresh']);
      check('backup left untouched', fs.readFileSync(path.join(dir, backup), 'utf8'), brokenAlarms);
    });
    await section('console (damaged storage run): no errors from Clock', async () => {
      check('no Clock errors in the console', clockErrors(s), []);
    });
  } finally {
    await s.close();
    current = null;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// ================================================================== launch F: oversized storage (thousands of entries)
async function runOversized() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-home-'));
  const dir = path.join(home, '.config', 'aurora', 'apps', 'clock');
  fs.mkdirSync(dir, { recursive: true });
  const w = (n, v) => fs.writeFileSync(path.join(dir, `${n}.json`), JSON.stringify(v));
  w('alarms', Array.from({ length: 5000 }, (_, i) => ({ id: `a${i}`, hour: i % 24, minute: i % 60, days: [1, 2], enabled: i % 2 === 0, name: 'x'.repeat(300) })));
  w('timers', Array.from({ length: 3000 }, (_, i) => ({ id: `t${i}`, name: 'T', duration: 120000 })));
  w('stopwatch', { running: true, startedAt: Date.now() - 5e6, base: 0, laps: Array.from({ length: 5000 }, (_, i) => i * 1000) });
  const t0 = Date.now();
  const s = await launchShell({ open: ['clock'], lang: 'en', theme: 'light', home, env: { TZ: 'Europe/Paris' } });
  current = s;
  try {
    await s.page.waitForSelector(`${WIN} .ck`, { timeout: 30000 });
    await until(s, (app) => !!app?.store, { label: 'clock ready' });
    await section('oversized storage: thousands of alarms / timers / laps are capped, Clock still opens quickly', async () => {
      check('Clock opened in reasonable time', Date.now() - t0, (ms) => ms < 25000);
      const r = await CK(s, (app) => ({ alarms: app.store.alarms.length, timers: app.store.timers.length, laps: app.store.stopwatch.laps.length, rems: app.shell.reminders.list('clock').length, name: app.store.alarms[0].name.length }));
      check('at most 100 alarms, 100 timers, 999 laps kept', [r.alarms, r.timers, r.laps], [100, 100, 999]);
      check('one reminder per enabled alarm (50)', r.rems, 50);
      check('names cut to 64 characters', r.name, 64);
      await go(s, 'alarm');
      await s.page.click(`${WIN} .ck-cmd-add`);
      await s.page.waitForSelector(DLG);
      check('Add at the limit explains why instead of doing nothing', await s.page.textContent(`${DLG} .dialog-body`), (v) => v.includes('up to 100 alarms'));
      await dialogButton(s, 'OK');
      check('…and adds nothing', await CK(s, (app) => app.store.alarms.length), 100);
      await go(s, 'timer');
      await pickPreset(s, 'Custom');
      await s.page.waitForSelector(DLG);
      check('Custom timer at the limit says so too', await s.page.textContent(`${DLG} .dialog-body`), (v) => v.includes('up to 100 timers'));
      await dialogButton(s, 'OK');
      await pickPreset(s, '30 min');
      await s.page.waitForSelector(DLG);
      check('a quick-start preset needing a new timer says so too', await s.page.textContent(`${DLG} .dialog-body`), (v) => v.includes('up to 100 timers'));
      await dialogButton(s, 'OK');
      check('no timer added', await CK(s, (app) => app.store.timers.length), 100);
      await go(s, 'stopwatch');
      const ms = await CK(s, (app) => {
        const t = performance.now();
        app.store.swLap();
        return performance.now() - t;
      });
      check('a new lap with 999 rows on screen is quick (no table rebuild)', ms, (v) => v < 40);
    });
    await section('console (oversized storage run): no errors from Clock', async () => {
      check('no Clock errors in the console', clockErrors(s), []);
    });
  } finally {
    await s.close();
    current = null;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

console.log('Clock tests');
{
  // every English string has a French translation with the same placeholders (static check)
  const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'renderer', 'apps', 'clock', 'i18n.json'), 'utf8'));
  const flat = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? flat(v, `${p}${k}.`) : [[p + k, v]]));
  const en = Object.fromEntries(flat(j.en));
  const fr = Object.fromEntries(flat(j.fr));
  const ph = (v) => [...String(v).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join();
  check('i18n: every English key exists in French', Object.keys(en).filter((k) => !(k in fr)), []);
  check('i18n: no French-only key', Object.keys(fr).filter((k) => !(k in en)), []);
  check('i18n: same placeholders in both languages', Object.keys(en).filter((k) => k in fr && ph(en[k]) !== ph(fr[k])), []);
}
await runEnglish();
await runFrench();
await runReconcile();
await runDamaged();
await runOversized();
await runSizes('1280x720', 'fr', 'dark');
await runSizes('1920x1080', 'en', 'light');
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(`\nFailures:\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
