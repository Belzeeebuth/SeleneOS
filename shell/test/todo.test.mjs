// To Do tests — drive the real Electron shell with Playwright.
//   Pure math (due / overdue around midnight, planned buckets, reminder presets, repeat next instance: monthly on
//   the 31st, weekdays, yearly on Feb 29, custom every 2 weeks), first-run seed (EN / FR), add / complete /
//   uncomplete with the animation end state + chime, importance (+ "starred to top"), due dates and overdue state
//   when the clock passes midnight, reminders mirrored in shell.reminders (set, refreshed, removed on complete /
//   delete, re-added on uncomplete, orphans removed at sync, notification click opens the task), repeating tasks
//   completed through the UI, steps (add / complete / rename / reorder / promote / delete), My Day daily reset with a
//   fake date + suggestions, Planned grouping, list CRUD (create with emoji, rename, theme, duplicate, delete),
//   moving tasks (menu + drag onto the nav), drag to reorder, groups, search (title / step / note), keyboard
//   (arrows, Enter, Space, Delete, Ctrl+D / T / N / L / F, Ctrl+Shift+?), multi-select, settings, seed removal,
//   persistence across relaunch, migration of an old data file + reminder sync at launch, French + dark theme,
//   minimum and maximized sizes, overflow, console errors.
//   QA launches: no listener leaks over 15 open / close cycles, untrusted text never parsed as HTML, repeat rules
//   following a moved due date, double submits and rapid clicks, Tab kept in the window / flyouts, F6, Delete and F2
//   in the navigation pane, save failure + Retry, 1280x720 and 1920x1080 maximized layouts, wrapped steps,
//   keyboard-reachable suggestions, corrupt / unreadable / newer-version data files.
//   Documentation screenshots: aurora-os/docs/screenshots/todo-*.png
// Usage:  cd aurora-os/shell && xvfb-run -a -s "-screen 0 1600x900x24" node test/todo.test.mjs [--only=steps]
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
  if (current) {
    for (let i = 0; i < 6; i++) {
      const busy = await current.page.evaluate(`!!document.querySelector('.win.app-todo .dialog-layer:not(.closing), .menu, .win.app-todo .td-pop')`).catch(() => false);
      if (!busy) break;
      await current.page.keyboard.press('Escape').catch(() => {});
      await sleep(220);
    }
    await TD(current, (app) => {
      app.setNow(null);
      if (app.openId) app.closeDetail({ focus: false });
      return true;
    }).catch(() => {});
  }
}

const WIN = '.win.app-todo';
const DLG = `${WIN} .dialog-layer:not(.closing) .dialog`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Evaluate fn(app, arg) in the shell for the To Do window (expression string: the page CSP forbids eval).
function TD(s, fn, arg) {
  return s.page.evaluate(`(async () => { const el = document.querySelector(${JSON.stringify(WIN)}); return (${fn.toString()})(el && el.__todo, ${JSON.stringify(arg ?? null)}); })()`);
}
async function until(s, fn, { timeout = 6000, step = 60, label = 'condition', arg } = {}) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    last = await TD(s, fn, arg).catch((e) => `ERR ${e.message}`);
    if (last && !(typeof last === 'string' && last.startsWith('ERR'))) return last;
    await sleep(step);
  }
  throw new Error(`timed out waiting for ${label} (last: ${JSON.stringify(last)})`);
}
const go = (s, view) => TD(s, (app, v) => (app.go(v), app.renderNow(), true), view);
const render = (s) => TD(s, (app) => (app.renderNow(), true));
async function menuClick(s, label) {
  await s.page.waitForSelector('.menu .menu-item', { timeout: 4000 });
  const item = s.page.locator('.menu .menu-item', { hasText: label }).first();
  await item.click();
  await sleep(250);
}
async function dialogButton(s, label) {
  await s.page.waitForSelector(DLG, { timeout: 5000 });
  await s.page.locator(`${DLG} .dialog-footer .btn`, { hasText: label }).first().click();
  await sleep(300);
}
async function shot(s, name, { clip = true } = {}) {
  await sleep(400);
  const file = path.join(DOCS, `todo-${name}.png`);
  let rect = null;
  if (clip) rect = await s.page.evaluate(`(() => { const r = document.querySelector(${JSON.stringify(WIN)}).getBoundingClientRect(); return { x: Math.max(0, r.x - 1), y: Math.max(0, r.y - 1), width: r.width + 2, height: r.height + 2 }; })()`);
  await s.page.screenshot({ path: file, ...(rect ? { clip: rect } : {}) });
  return file;
}
function todoErrors(s) {
  return s.logs.filter((l) => /^\[(error|pageerror)\]/.test(l) && /todo|apps\/todo/i.test(l));
}
const rowSel = (id) => `${WIN} .td-task[data-id="${id}"]`;
const L = (y, mo, d, h = 0, mi = 0, sec = 0) => new Date(y, mo - 1, d, h, mi, sec).getTime();

/** Elements of the window that stick out of it or whose text is cut without an ellipsis. */
function overflowProbe(s) {
  return s.page.evaluate(`(() => {
    const win = document.querySelector(${JSON.stringify(WIN)});
    const wr = win.getBoundingClientRect();
    const bad = [];
    for (const el of win.querySelectorAll('.td *:not(.td-live)')) {
      if (!el.checkVisibility || !el.checkVisibility({ checkVisibilityCSS: true })) continue;
      if (el.closest('.td-ghost, .td-scroll, .td-nav-scroll, .td-d-scroll, .td-sg-body, .td-pop')) {
        // scroll areas clip their content; inside them only look for text cut without an ellipsis
      } else {
        const r = el.getBoundingClientRect();
        if (r.width && (r.right > wr.right + 1 || r.left < wr.left - 1)) bad.push('outside: ' + (el.className || el.tagName) + ' ' + (el.textContent || '').slice(0, 30));
      }
      const cs = getComputedStyle(el);
      const leaf = el.children.length === 0 && (el.textContent || '').trim();
      if (leaf && el.scrollWidth > el.clientWidth + 1 && cs.overflowX !== 'visible' && cs.textOverflow !== 'ellipsis' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) {
        bad.push('cut: ' + (el.className || el.tagName) + ' ' + el.textContent.slice(0, 30));
      }
    }
    return [...new Set(bad)].slice(0, 12);
  })()`);
}

// ================================================================== launch A: English, light
async function runEnglish() {
  const s = await launchShell({ open: ['todo'], lang: 'en', theme: 'light' });
  current = s;
  try {
    await s.page.waitForSelector(`${WIN} .td`, { timeout: 20000 });
    await until(s, (app) => !!app?.store, { label: 'todo ready' });
    // make sure the window has its default (docked detail) size
    await TD(s, (app) => (app.win.restore?.(), app.win.setSize?.(1180, 760), true));
    await sleep(300);

    await section('pure math: due states around midnight, planned buckets, presets, repeat rules', async () => {
      const r = await TD(s, async () => {
        const D = await import('app://shell/apps/todo/lib/dates.js');
        const L = (y, mo, d, h = 0, mi = 0, sec = 0) => new Date(y, mo - 1, d, h, mi, sec).getTime();
        const seq = (start, rule, n, ws = 0) => {
          const out = [];
          let d = start;
          for (let i = 0; i < n; i++) out.push((d = D.nextDue(d, rule, ws)));
          return out;
        };
        const mon = L(2026, 10, 12, 10); // Monday
        return {
          before: D.dueState('2026-10-10', L(2026, 10, 10, 23, 59, 59)),
          after: D.dueState('2026-10-10', L(2026, 10, 11, 0, 0, 0)),
          tomorrowAt2359: D.dueState('2026-10-11', L(2026, 10, 10, 23, 59, 59)),
          tomorrowAtMidnight: D.dueState('2026-10-11', L(2026, 10, 11, 0, 0, 0)),
          bucketsSun: ['2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-17', '2026-10-18', '2026-12-01'].map((x) => D.plannedBucket(x, mon, 0)),
          bucketsMon: ['2026-10-17', '2026-10-18', '2026-10-19'].map((x) => D.plannedBucket(x, mon, 1)),
          monthly31: seq('2026-01-31', D.makeRepeat('monthly', '2026-01-31'), 5),
          monthly30: seq('2026-01-30', D.makeRepeat('monthly', '2026-01-30'), 2),
          weekdays: ['2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12'].map((x) => D.nextDue(x, D.makeRepeat('weekdays', x))),
          weekly: D.nextDue('2026-10-14', D.makeRepeat('weekly', '2026-10-14')),
          daily: D.nextDue('2026-12-31', D.makeRepeat('daily', '2026-12-31')),
          yearlyLeap: seq('2028-02-29', D.makeRepeat('yearly', '2028-02-29'), 4),
          biweekly: seq('2026-10-12', D.normalizeRepeat({ freq: 'week', interval: 2, days: [1, 3] }), 4),
          every3days: D.nextDue('2026-10-30', D.normalizeRepeat({ freq: 'day', interval: 3 })),
          quarterly: seq('2026-11-30', D.normalizeRepeat({ freq: 'month', interval: 3, anchorDay: 30 }), 2),
          later: (() => {
            const p = D.reminderPresets(L(2026, 10, 10, 14, 15));
            return [new Date(p.laterToday).getHours(), new Date(p.tomorrow).getDate(), new Date(p.tomorrow).getHours(), new Date(p.nextWeek).getDay(), new Date(p.nextWeek).getDate()];
          })(),
          lateEvening: D.reminderPresets(L(2026, 10, 10, 20, 5)).laterToday,
          duePresetsSun: D.duePresets(L(2026, 10, 11, 9)),
          shift: (() => {
            const at = D.shiftReminder(L(2026, 1, 31, 9, 30), '2026-01-31', '2026-02-28');
            return [new Date(at).getMonth(), new Date(at).getDate(), new Date(at).getHours(), new Date(at).getMinutes()];
          })(),
          align: D.alignDue('2026-10-13', D.normalizeRepeat({ freq: 'week', interval: 1, days: [1, 4] })),
          repeatKeys: [D.repeatKey(D.makeRepeat('weekdays', '2026-10-12')), D.repeatKey(D.normalizeRepeat({ freq: 'week', interval: 2, days: [1] })), D.repeatKey(D.makeRepeat('yearly', '2026-10-12'))],
        };
      });
      check('due today at 23:59:59 is not overdue', r.before, 'today');
      check('due yesterday is overdue right after midnight', r.after, 'overdue');
      check('due tomorrow at 23:59:59', r.tomorrowAt2359, 'tomorrow');
      check('tomorrow becomes today at midnight', r.tomorrowAtMidnight, 'today');
      check('planned buckets (Monday, weeks start Sunday)', r.bucketsSun, ['earlier', 'today', 'tomorrow', 'thisWeek', 'thisWeek', 'later', 'later']);
      check('planned buckets (weeks start Monday)', r.bucketsMon, ['thisWeek', 'thisWeek', 'later']);
      check('monthly on the 31st keeps coming back to the 31st', r.monthly31, ['2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31', '2026-06-30']);
      check('monthly on the 30th (February clamps to 28)', r.monthly30, ['2026-02-28', '2026-03-30']);
      check('weekdays: Fri/Sat/Sun -> Monday, Monday -> Tuesday', r.weekdays, ['2026-10-12', '2026-10-12', '2026-10-12', '2026-10-13']);
      check('weekly', r.weekly, '2026-10-21');
      check('daily across the year end', r.daily, '2027-01-01');
      check('yearly on Feb 29', r.yearlyLeap, ['2029-02-28', '2030-02-28', '2031-02-28', '2032-02-29']);
      check('every 2 weeks on Mon + Wed', r.biweekly, ['2026-10-14', '2026-10-26', '2026-10-28', '2026-11-09']);
      check('every 3 days across a month end', r.every3days, '2026-11-02');
      check('every 3 months on the 30th', r.quarterly, ['2027-02-28', '2027-05-30']);
      check('reminder presets: later today 18:00, tomorrow 9:00, next week = Monday 9:00', r.later, [18, 11, 9, 1, 12]);
      check('no "later today" late in the evening', r.lateEvening, null);
      check('due presets on a Sunday (next week = tomorrow Monday)', r.duePresetsSun, { today: '2026-10-11', tomorrow: '2026-10-12', nextWeek: '2026-10-12' });
      check('reminder moves with the due date, same wall time', r.shift, [1, 28, 9, 30]);
      check('weekly rule on Mon/Thu aligns a Tuesday to Thursday', r.align, '2026-10-15');
      check('repeat preset detection', r.repeatKeys, ['weekdays', 'custom', 'yearly']);
    });

    await section('first run: seed in English, default lists, examples banner', async () => {
      const r = await TD(s, (app) => ({
        nav: [...app.nav.el.querySelectorAll('.td-nav-item')].map((n) => n.dataset.view.startsWith('list:') && n.dataset.view !== 'list:tasks' ? 'user' : n.dataset.view),
        labels: [...app.nav.el.querySelectorAll('.td-nav-smart .td-nav-label')].map((n) => n.textContent),
        seed: app.store.data.tasks.filter((t) => t.seed).length,
        lists: app.store.userLists().map((l) => [l.emoji, l.name]),
        titles: app.store.data.tasks.map((t) => t.title),
        banner: !!document.querySelector('.win.app-todo .td-seed-banner'),
        view: app.view,
        firstRun: app.store.firstRun,
      }));
      check('smart lists in order (Assigned to me hidden by default)', r.nav, ['myday', 'important', 'planned', 'all', 'completed', 'list:tasks', 'user']);
      check('smart list labels', r.labels, ['My Day', 'Important', 'Planned', 'All', 'Completed', 'Tasks']);
      check('example tasks', r.seed, 8);
      check('example list with an emoji icon', r.lists, [['🛒', 'Groceries']]);
      check('examples are in English', r.titles.some((x) => x.startsWith('Welcome to To Do')), true);
      check('examples banner shown in My Day', r.banner, true);
      check('opens on My Day', r.view, 'myday');
      check('first run detected', r.firstRun, true);
      await shot(s, 'myday-light-en');
    });

    let taskA;
    await section('add a task (Ctrl+N, Enter) and quick buttons', async () => {
      await go(s, 'list:tasks');
      await s.page.click(`${WIN} .td-row-title >> nth=0`);
      await s.page.keyboard.press('Escape');
      await s.page.keyboard.press('Control+n');
      check('Ctrl+N focuses "Add a task"', await s.page.evaluate(`document.activeElement?.classList.contains('td-add-input')`), true);
      check('add bar expands while typing', await s.page.evaluate(`!!document.querySelector('.win.app-todo .td-add.active')`), true);
      await s.page.keyboard.type('Water the plants');
      // quick button: due date -> Tomorrow
      await s.page.click(`${WIN} .td-add-due`);
      await menuClick(s, 'Tomorrow');
      const chip = await s.page.textContent(`${WIN} .td-add-due .td-add-opt-label`);
      check('due chip shows the chosen date', chip, 'Due Tomorrow');
      await shot(s, 'add-bar-light-en');
      await s.page.click(`${WIN} .td-add-input`);
      await s.page.keyboard.press('Enter');
      taskA = await until(s, (app) => app.store.data.tasks.find((t) => t.title === 'Water the plants')?.id, { label: 'task added' });
      const r = await TD(s, (app, id) => {
        const t = app.store.task(id);
        return { list: t.listId, due: t.due, tomorrow: (() => { const d = new Date(app.now()); d.setDate(d.getDate() + 1); return d.toISOString().slice(0, 10); })(), focus: document.activeElement?.className, value: app.list.addInput.value, row: !!app.list.rowEl(id), first: app.list.visibleIds()[0], important: app.store.data.tasks.filter((x) => !x.done && x.listId === 'tasks' && x.important).length };
      }, taskA);
      check('added to the Tasks list', r.list, 'tasks');
      check('due date from the quick button', !!r.due, true);
      check('input cleared and still focused', [r.value, r.focus], ['', 'td-add-input']);
      check('row rendered', await until(s, (app, id) => !!app.list.rowEl(id), { arg: taskA, label: 'row' }), true);
      check('new task on top (after the starred ones)', r.first === taskA || r.important > 0, true);
      // Enter on an empty box does nothing
      const before = await TD(s, (app) => app.store.data.tasks.length);
      await s.page.keyboard.press('Enter');
      check('empty title is not added', await TD(s, (app) => app.store.data.tasks.length), before);
      await s.page.keyboard.type('   ');
      await s.page.keyboard.press('Enter');
      check('blank title is not added', await TD(s, (app) => app.store.data.tasks.length), before);
      await s.page.keyboard.press('Escape');
    });

    await section('complete and uncomplete: animation end state + chime', async () => {
      const id = taskA;
      await TD(s, (app) => ((app.lastChime = 0), true));
      await s.page.click(`${rowSel(id)} .td-check`);
      await sleep(60);
      const mid = await TD(s, (app, id) => ({ completing: app.list.rowEl(id)?.classList.contains('completing'), aria: app.list.rowEl(id)?.querySelector('.td-check').getAttribute('aria-checked'), done: app.store.task(id).done, chime: app.lastChime > 0 }), id);
      check('row animates (completing) before it moves', mid.completing, true);
      check('checkbox reports checked at once', mid.aria, 'true');
      check('not committed during the animation', mid.done, false);
      check('completion chime played', mid.chime, true);
      await until(s, (app, id) => app.store.task(id).done, { arg: id, label: 'task completed' });
      // every animation of the row settles (a stuck or infinite animation would time out here)
      const settled = await until(s, (app, id) => {
        const row = app.list.rowEl(id);
        return !!row?.closest('.td-done-rows') && row.getAnimations({ subtree: true }).every((a) => a.playState !== 'running') && 'yes';
      }, { arg: id, timeout: 2500, label: 'animations settle' }).catch((e) => e.message);
      check('animations settle', settled, 'yes');
      const end = await TD(s, (app, id) => {
        const row = app.list.rowEl(id);
        return {
          inDone: !!row?.closest('.td-done-rows'),
          cls: row?.className,
          aria: row?.querySelector('.td-check').getAttribute('aria-checked'),
          completing: document.querySelectorAll('.win.app-todo .td-task.completing').length,
          completedAt: !!app.store.task(id).completedAt,
          count: document.querySelector('.win.app-todo .td-done-head .td-sec-count')?.textContent,
          nav: app.nav.itemFor('completed')?.querySelector('.td-nav-count')?.textContent,
        };
      }, id);
      check('row now in the Completed section', end.inDone, true);
      check('row has the done style', /\bdone\b/.test(end.cls), true);
      check('no row left mid-animation', end.completing, 0);
      check('checkbox checked', end.aria, 'true');
      check('completion time recorded', end.completedAt, true);
      check('Completed section count', end.count, '1');
      check('Completed smart list count', end.nav, '1');
      await shot(s, 'completed-light-en');
      // uncomplete
      await s.page.click(`${rowSel(id)} .td-check`);
      await until(s, (app, id) => !app.store.task(id).done && !app.list.rowEl(id)?.closest('.td-done-rows'), { arg: id, label: 'uncompleted' });
      check('uncompleted row back in the open list', await TD(s, (app, id) => !!app.list.rowEl(id)?.closest('.td-rows:not(.td-done-rows)') && app.store.task(id).completedAt === null, id), true);
      // clicking twice quickly cancels the completion
      await s.page.click(`${rowSel(id)} .td-check`);
      await sleep(80);
      await s.page.click(`${rowSel(id)} .td-check`);
      await sleep(700);
      check('second click during the animation cancels it', await TD(s, (app, id) => [app.store.task(id).done, app.list.rowEl(id)?.classList.contains('completing')], id), [false, false]);
    });

    await section('importance: star, Important list, starred to top, Ctrl+Shift+S', async () => {
      const id = taskA;
      await s.page.click(`${rowSel(id)} .td-star`);
      await sleep(250);
      const r = await TD(s, (app, id) => ({ imp: app.store.task(id).important, pressed: app.list.rowEl(id).querySelector('.td-star').getAttribute('aria-pressed'), inImportant: app.store.data.tasks.filter((t) => t.important && !t.done).map((t) => t.id).includes(id), first: app.list.visibleIds().slice(0, 2).includes(id) }), id);
      check('star marks important', r.imp, true);
      check('star pressed state', r.pressed, 'true');
      check('in the Important list', r.inImportant, true);
      check('starred tasks move to the top', r.first, true);
      await go(s, 'important');
      check('Important view lists it', await TD(s, (app, id) => !!app.list.rowEl(id), id), true);
      await s.page.click(`${rowSel(id)}`);
      await s.page.keyboard.press('Escape'); // close details, keep the row focused
      await s.page.focus(rowSel(id));
      await s.page.keyboard.press('Control+Shift+S');
      await sleep(250);
      check('Ctrl+Shift+S removes importance', await TD(s, (app, id) => app.store.task(id).important, id), false);
      await go(s, 'list:tasks');
    });

    await section('due dates: detail menu, overdue state when the clock passes midnight', async () => {
      const id = taskA;
      await s.page.click(`${rowSel(id)} .td-row-title`);
      await s.page.waitForSelector(`${WIN} .td-detail.shown`);
      await s.page.click(`${WIN} .td-opt[data-key="due"]`);
      await menuClick(s, 'Today');
      const today = await TD(s, (app) => app.today());
      const r = await TD(s, (app, id) => ({ due: app.store.task(id).due, label: document.querySelector('.win.app-todo .td-opt[data-key="due"] .td-opt-label').textContent, rowCls: app.list.rowEl(id).querySelector('.td-meta-due')?.className }), id);
      check('due date set from the details pane', r.due, today);
      check('detail label', r.label, 'Due Today');
      check('row shows "today" accent', /\btoday\b/.test(r.rowCls || ''), true);
      // the clock passes midnight: the task becomes overdue
      const [y, m, d] = today.split('-').map(Number);
      await TD(s, (app, t) => (app.setNow(t), app.renderNow(), true), L(y, m, d, 23, 59, 50));
      check('still due today at 23:59:50', await TD(s, (app, id) => app.list.rowEl(id).querySelector('.td-meta-due').className.includes('overdue'), id), false);
      await TD(s, (app, t) => (app.setNow(t), app.renderNow(), true), L(y, m, d + 1, 0, 0, 5));
      const o = await TD(s, (app, id) => ({ overdue: app.list.rowEl(id).querySelector('.td-meta-due').className.includes('overdue'), text: app.list.rowEl(id).querySelector('.td-meta-due').textContent, label: document.querySelector('.win.app-todo .td-opt[data-key="due"] .td-opt-label').textContent, tone: document.querySelector('.win.app-todo .td-opt[data-key="due"]').className }), id);
      check('overdue right after midnight', o.overdue, true);
      check('row says Yesterday', o.text, 'Yesterday');
      check('detail says Overdue', o.label, 'Overdue, Yesterday');
      check('detail row in danger tone', o.tone.includes('tone-overdue'), true);
      await shot(s, 'overdue-light-en');
      await TD(s, (app) => (app.setNow(null), app.renderNow(), true));
      // remove the due date with the ✕
      await s.page.click(`${WIN} .td-opt-clear[data-key="due-clear"]`);
      await sleep(200);
      check('due date removed', await TD(s, (app, id) => app.store.task(id).due, id), null);
      // pick a date in the calendar flyout
      await s.page.click(`${WIN} .td-opt[data-key="due"]`);
      await menuClick(s, 'Pick a date');
      await s.page.waitForSelector(`${WIN} .td-pop .td-cal-day`);
      await shot(s, 'date-picker-light-en');
      const target = await TD(s, (app) => {
        const days = [...document.querySelectorAll('.win.app-todo .td-pop .td-cal-day:not(.other)')];
        return days[days.length - 1].dataset.day;
      });
      await s.page.click(`${WIN} .td-pop .td-cal-day[data-day="${target}"]`);
      await s.page.click(`${WIN} .td-pop .td-pop-save`);
      await sleep(250);
      check('date picked in the calendar', await TD(s, (app, id) => app.store.task(id).due, id), target);
    });

    await section('reminders: shell.reminders set / refresh / remove, notification click', async () => {
      const id = taskA;
      await TD(s, (app, id) => (app.openTask(id), true), id);
      await s.page.click(`${WIN} .td-opt[data-key="remind"]`);
      await menuClick(s, 'Tomorrow');
      const r = await until(s, (app, id) => app.shell.reminders.get(`task-${id}`, 'todo'), { arg: id, label: 'reminder registered' });
      const exp = await TD(s, (app) => {
        const d = new Date();
        d.setDate(d.getDate() + 1);
        d.setHours(9, 0, 0, 0);
        return d.getTime();
      });
      check('reminder at tomorrow 9:00', r.at, exp);
      check('reminder title = task title', r.title, 'Water the plants');
      check('reminder body has the list name', r.body.startsWith('Tasks'), true);
      check('reminder data carries the task id', r.data, { taskId: id });
      check('reminder kind', r.kind, 'reminder');
      check('task stores the time', await TD(s, (app, id) => app.store.task(id).remindAt, id), exp);
      check('row shows the bell', await TD(s, (app, id) => !!app.list.rowEl(id).querySelector('.td-meta-remind'), id), true);
      // renaming the task refreshes the notification text
      const title = s.page.locator(`${WIN} .td-d-title`);
      await title.click();
      await s.page.keyboard.press('End');
      await s.page.keyboard.type(' now');
      await s.page.keyboard.press('Enter');
      await until(s, (app, id) => app.shell.reminders.get(`task-${id}`, 'todo')?.title === 'Water the plants now', { arg: id, label: 'reminder title refreshed' });
      check('rename refreshes the reminder', true, true);
      // complete -> removed, uncomplete -> back
      await TD(s, (app, id) => (app.complete([id], true, { animate: false }), true), id);
      await until(s, (app, id) => app.store.task(id).done && !app.shell.reminders.get(`task-${id}`, 'todo'), { arg: id, label: 'reminder removed on complete' });
      check('completing removes the reminder', true, true);
      await TD(s, (app, id) => (app.complete([id], false), true), id);
      await until(s, (app, id) => !!app.shell.reminders.get(`task-${id}`, 'todo'), { arg: id, label: 'reminder back on uncomplete' });
      check('uncompleting brings the reminder back', true, true);
      // notification click (relaunch with args) opens the task
      await go(s, 'planned');
      await TD(s, (app) => (app.closeDetail({ focus: false }), true));
      await TD(s, (app, id) => (app.shell.launch('todo', { reminder: { id: `task-${id}`, data: { taskId: id } } }), true), id);
      await sleep(400);
      const o = await TD(s, (app, id) => ({ open: app.openId, wins: app.shell.wm.byApp('todo').length, row: !!app.list.rowEl(id) }), id);
      check('notification click opens the task details', o.open, id);
      check('single instance (no second window)', o.wins, 1);
      check('task visible in the current list', o.row, true);
      // removing the reminder in the pane
      await s.page.click(`${WIN} .td-opt-clear[data-key="remind-clear"]`);
      await until(s, (app, id) => !app.shell.reminders.get(`task-${id}`, 'todo') && app.store.task(id).remindAt === null, { arg: id, label: 'reminder removed' });
      check('✕ removes the reminder', true, true);
      // pick date & time
      await s.page.click(`${WIN} .td-opt[data-key="remind"]`);
      await menuClick(s, 'Pick a date & time');
      await s.page.waitForSelector(`${WIN} .td-pop .td-time`);
      await shot(s, 'reminder-picker-light-en');
      const pick = await TD(s, () => {
        const days = [...document.querySelectorAll('.win.app-todo .td-pop .td-cal-day:not(.other)')];
        const day = days[days.length - 1].dataset.day;
        days[days.length - 1].click();
        const hSel = document.querySelector('.win.app-todo .td-pop .td-time-h');
        const mSel = document.querySelector('.win.app-todo .td-pop .td-time-m');
        const ap = document.querySelector('.win.app-todo .td-pop .td-time-ap');
        hSel.value = '7';
        mSel.value = '45';
        if (ap) ap.value = 'pm';
        return day;
      });
      await s.page.click(`${WIN} .td-pop .td-pop-save`);
      const at = await until(s, (app, id) => app.shell.reminders.get(`task-${id}`, 'todo')?.at, { arg: id, label: 'picked reminder' });
      const ad = new Date(at);
      check('picked reminder time', [ad.toISOString().slice(0, 10) === pick || `${ad.getFullYear()}-${String(ad.getMonth() + 1).padStart(2, '0')}-${String(ad.getDate()).padStart(2, '0')}` === pick, ad.getHours(), ad.getMinutes()], [true, 19, 45]);
      // end to end: the reminder fires from the shell, the toast click opens the task
      const rid = await TD(s, (app) => {
        const t = app.addTask({ title: 'Ring soon', listId: 'tasks' });
        app.remind(t.id, Date.now() + 1500);
        return t.id;
      });
      const toast = await until(s, () => window.__aurora.notifications.list().find((n) => n.title === 'Ring soon'), { timeout: 9000, label: 'reminder notification' });
      check('notification shows the list', (toast.body || '').includes('Tasks'), true);
      check('fired one-shot reminder left the schedule', await TD(s, (app, id) => app.shell.reminders.get(`task-${id}`, 'todo'), rid), null);
      await render(s);
      check('row bell shows the reminder has passed', await TD(s, (app, id) => !!app.list.rowEl(id)?.querySelector('.td-meta-remind.past'), rid), true);
      await go(s, 'important');
      await s.page.evaluate(`(() => { const n = window.__aurora.notifications.list().find((x) => x.title === 'Ring soon'); window.__aurora.notifications.activate(n.id); })()`);
      await until(s, (app, id) => app.openId === id, { arg: rid, label: 'notification click opens the task' });
      check('notification click opens the task (in its list)', await TD(s, (app) => app.view), 'list:tasks');
      await TD(s, (app, id) => app.deleteTasks([id], { confirm: false }), rid);
      // orphan removal at sync
      await TD(s, (app) => {
        app.shell.reminders.set({ id: 'task-ghost', appId: 'todo', at: Date.now() + 3600e3, title: 'ghost', data: { taskId: 'ghost' } });
        app.syncReminders();
        return true;
      });
      check('orphan reminder removed by the sync', await TD(s, (app) => app.shell.reminders.get('task-ghost', 'todo')), null);
      // delete the task -> reminder removed
      await TD(s, (app, id) => app.deleteTasks([id], { confirm: false }), id);
      await until(s, (app, id) => !app.store.task(id) && !app.shell.reminders.get(`task-${id}`, 'todo'), { arg: id, label: 'deleted' });
      check('deleting removes the reminder', true, true);
      check('no todo reminder left behind', await TD(s, (app) => app.shell.reminders.list('todo').filter((r) => !app.store.task(r.data?.taskId)).length), 0);
      // a notification for a task that no longer exists explains it
      await TD(s, (app, id) => (app.onRelaunch({ reminder: { id: `task-${id}`, data: { taskId: id } } }), true), id);
      await s.page.waitForSelector(DLG, { timeout: 3000 });
      check('missing task explained', (await s.page.textContent(DLG)).includes('no longer exists'), true);
      await dialogButton(s, 'OK');
    });

    await section('repeating tasks: next instance through the UI (monthly on the 31st, weekdays)', async () => {
      await go(s, 'list:tasks');
      const id = await TD(s, (app) => app.addTask({ title: 'Pay rent', listId: 'tasks', due: '2026-01-31', remindAt: new Date(2026, 0, 31, 9, 30).getTime() }).id);
      await TD(s, (app, id) => (app.openTask(id), true), id);
      await s.page.click(`${WIN} .td-opt[data-key="repeat"]`);
      await menuClick(s, 'Monthly');
      const rep = await TD(s, (app, id) => ({ r: app.store.task(id).repeat, label: document.querySelector('.win.app-todo .td-opt[data-key="repeat"] .td-opt-label').textContent, icon: !!app.list.rowEl(id).querySelector('.td-meta-repeat') }), id);
      check('monthly rule anchored on the 31st', [rep.r.freq, rep.r.interval, rep.r.anchorDay], ['month', 1, 31]);
      check('repeat label', rep.label, 'Monthly');
      check('row shows the repeat icon', rep.icon, true);
      await s.page.click(`${WIN} .td-d-titlerow .td-check`);
      const next = await until(s, (app, id) => {
        const t = app.store.task(id);
        return t.done && t.spawnedId && app.store.task(t.spawnedId);
      }, { arg: id, label: 'next instance' });
      check('next instance due Feb 28', next.due, '2026-02-28');
      check('next instance keeps the rule', next.repeat?.anchorDay, 31);
      check('reminder moved with it (same time)', [new Date(next.remindAt).getMonth(), new Date(next.remindAt).getDate(), new Date(next.remindAt).getHours(), new Date(next.remindAt).getMinutes()], [1, 28, 9, 30]);
      check('next instance is open, the old one done', await TD(s, (app, [a, b]) => [app.store.task(a).done, app.store.task(b).done], [id, next.id]), [true, false]);
      const third = await TD(s, (app, nid) => {
        const r = app.store.setDone(nid, true);
        return r.next;
      }, next.id);
      check('then Mar 31 (back to the 31st)', third.due, '2026-03-31');
      // uncompleting right away takes the untouched next instance back
      await TD(s, (app, nid) => (app.store.setDone(nid, false), true), next.id);
      check('uncomplete removes the untouched next instance', await TD(s, (app, tid) => app.store.task(tid), third.id), null);
      // weekdays from a Friday -> Monday
      const wd = await TD(s, async (app) => {
        const D = await import('app://shell/apps/todo/lib/dates.js');
        const t = app.addTask({ title: 'Stand-up', due: '2026-10-09', repeat: D.makeRepeat('weekdays', '2026-10-09') });
        return app.store.setDone(t.id, true).next;
      });
      check('weekdays: Friday -> Monday', wd.due, '2026-10-12');
      // repeat without a due date sets one (today)
      const nd = await TD(s, async (app) => {
        const D = await import('app://shell/apps/todo/lib/dates.js');
        const t = app.addTask({ title: 'Water ferns' });
        app.setRepeat(t.id, D.makeRepeat('daily'));
        return [app.store.task(t.id).due, app.today()];
      });
      check('setting a repeat gives a due date', nd[0], nd[1]);
      // custom rule through the dialog
      const cid = await TD(s, (app) => app.addTask({ title: 'Gym', due: '2026-10-12' }).id);
      await TD(s, (app, id) => (app.openTask(id), true), cid);
      await s.page.click(`${WIN} .td-opt[data-key="repeat"]`);
      await menuClick(s, 'Custom');
      await s.page.waitForSelector(`${DLG} .td-rep-n`);
      await s.page.fill(`${DLG} .td-rep-n`, '2');
      await s.page.selectOption(`${DLG} .td-rep-f`, 'week');
      // add Wednesday (Monday is preselected from the due date)
      await TD(s, () => {
        const b = [...document.querySelectorAll('.win.app-todo .dialog .td-rep-day')].find((x) => x.getAttribute('aria-label') === 'Wednesday');
        b.click();
        return true;
      });
      await shot(s, 'custom-repeat-light-en');
      await dialogButton(s, 'Save');
      const cr = await TD(s, (app, id) => ({ r: app.store.task(id).repeat, label: document.querySelector('.win.app-todo .td-opt[data-key="repeat"] .td-opt-label').textContent }), cid);
      check('custom rule saved', [cr.r.freq, cr.r.interval, cr.r.days], ['week', 2, [1, 3]]);
      check('custom rule label', cr.label, 'Every 2 weeks · Mon, Wed');
      await TD(s, (app) => (app.closeDetail({ focus: false }), true));
    });

    await section('steps: add, complete, rename, reorder, promote, delete', async () => {
      await go(s, 'list:tasks');
      const id = await TD(s, (app) => app.addTask({ title: 'Plan the trip' }).id);
      await render(s);
      await s.page.dblclick(`${rowSel(id)} .td-row-title`);
      await s.page.waitForSelector(`${WIN} .td-detail.shown`);
      await s.page.click(`${WIN} .td-addstep-input`);
      for (const st of ['Book flights', 'Book hotel', 'Pack']) {
        await s.page.keyboard.type(st);
        await s.page.keyboard.press('Enter');
        await sleep(120);
      }
      let r = await TD(s, (app, id) => ({ steps: app.store.task(id).steps.map((x) => x.title), meta: app.list.rowEl(id).querySelector('.td-meta-steps')?.textContent, focus: document.activeElement?.className, ph: document.querySelector('.win.app-todo .td-addstep-input').placeholder }), id);
      check('three steps added with Enter', r.steps, ['Book flights', 'Book hotel', 'Pack']);
      check('row shows 0 of 3', r.meta, '0 of 3');
      check('focus stays in the step box', r.focus, 'td-addstep-input');
      check('placeholder becomes "Next step"', r.ph, 'Next step');
      await s.page.click(`${WIN} .td-step >> nth=0 >> .td-check`);
      await sleep(200);
      r = await TD(s, (app, id) => ({ done: app.store.task(id).steps[0].done, meta: app.list.rowEl(id).querySelector('.td-meta-steps')?.textContent }), id);
      check('step completed', r.done, true);
      check('row shows 1 of 3', r.meta, '1 of 3');
      // rename the second step
      const second = s.page.locator(`${WIN} .td-step-input >> nth=1`);
      await second.click();
      await second.fill('Book a cosy hotel');
      await s.page.keyboard.press('Enter');
      await sleep(150);
      check('step renamed', await TD(s, (app, id) => app.store.task(id).steps[1].title, id), 'Book a cosy hotel');
      // reorder: Alt+Down on the first step
      await s.page.locator(`${WIN} .td-step-input >> nth=0`).click();
      await s.page.keyboard.press('Alt+ArrowDown');
      await sleep(150);
      check('Alt+Down moves the step', await TD(s, (app, id) => app.store.task(id).steps.map((x) => x.title), id), ['Book a cosy hotel', 'Book flights', 'Pack']);
      // drag the last step to the top
      const box = async (i) => s.page.locator(`${WIN} .td-step >> nth=${i}`).boundingBox();
      const b2 = await box(2);
      const b0 = await box(0);
      await s.page.mouse.move(b2.x + 60, b2.y + b2.height / 2);
      await s.page.mouse.down();
      await s.page.mouse.move(b2.x + 60, b2.y + b2.height / 2 - 12, { steps: 3 });
      await s.page.mouse.move(b0.x + 60, b0.y + 4, { steps: 8 });
      await s.page.mouse.up();
      await sleep(300);
      check('drag reorders steps', await TD(s, (app, id) => app.store.task(id).steps.map((x) => x.title), id), ['Pack', 'Book a cosy hotel', 'Book flights']);
      await shot(s, 'steps-light-en');
      // promote "Pack" to a task
      await s.page.locator(`${WIN} .td-step >> nth=0`).hover();
      await s.page.click(`${WIN} .td-step >> nth=0 >> .td-step-more`);
      await menuClick(s, 'Promote to task');
      r = await TD(s, (app, id) => {
        const t = app.store.task(id);
        const p = app.store.data.tasks.find((x) => x.title === 'Pack');
        return { steps: t.steps.length, promoted: !!p, list: p?.listId, after: p && p.order === t.order + 1 };
      }, id);
      check('promoted step removed from the task', r.steps, 2);
      check('promoted step is a task in the same list, right after', [r.promoted, r.list, r.after], [true, 'tasks', true]);
      // delete a step with the menu
      await s.page.locator(`${WIN} .td-step >> nth=0`).hover();
      await s.page.click(`${WIN} .td-step >> nth=0 >> .td-step-more`);
      await menuClick(s, 'Delete step');
      check('step deleted', await TD(s, (app, id) => app.store.task(id).steps.map((x) => x.title), id), ['Book flights']);
      // note autosave
      await s.page.click(`${WIN} .td-d-note`);
      await s.page.keyboard.type('Passport!\nTickets');
      await sleep(700);
      check('note autosaved', await TD(s, (app, id) => app.store.task(id).note, id), 'Passport!\nTickets');
      check('row shows the note icon', await TD(s, (app, id) => !!app.list.rowEl(id).querySelector('.td-meta-note'), id), true);
    });

    await section('My Day: add, daily reset with a fake date, suggestions', async () => {
      await go(s, 'list:tasks');
      const id = await TD(s, (app) => app.addTask({ title: 'Call the bank' }).id);
      await render(s);
      await s.page.click(`${rowSel(id)} .td-row-title`);
      await s.page.keyboard.press('Escape');
      await s.page.focus(rowSel(id));
      await s.page.keyboard.press('Control+t');
      await sleep(150);
      const today = await TD(s, (app) => app.today());
      check('Ctrl+T adds to My Day', await TD(s, (app, id) => app.store.task(id).myDay, id), today);
      check('row shows the My Day sun', await TD(s, (app, id) => !!app.list.rowEl(id).querySelector('.td-meta-myday'), id), true);
      await go(s, 'myday');
      check('listed in My Day', await TD(s, (app, id) => !!app.list.rowEl(id), id), true);
      // next morning: My Day starts empty again, yesterday's task is suggested
      const [y, m, d] = today.split('-').map(Number);
      await TD(s, (app, t) => (app.setNow(t), app.renderNow(), true), L(y, m, d + 1, 8, 0));
      const r = await TD(s, (app, id) => ({ inList: !!app.list.rowEl(id), count: app.list.visibleIds().length, sub: document.querySelector('.win.app-todo .td-subtitle').textContent, empty: !!document.querySelector('.win.app-todo .td-empty-myday'), data: app.store.task(id).myDay }), id);
      check('My Day cleared the next day', r.inList, false);
      check('My Day is empty (examples were added yesterday too)', r.count, 0);
      check('empty state shown', r.empty, true);
      check('history kept on the task', r.data, today);
      await shot(s, 'myday-empty-light-en');
      await s.page.click(`${WIN} .td-suggest-btn`);
      await s.page.waitForSelector(`${WIN} .td-suggest:not([hidden]) .td-sg-row`);
      const sg = await TD(s, (app, id) => ({ yesterday: [...document.querySelectorAll('.win.app-todo .td-sg-sec[data-key="yesterday"] .td-sg-row')].map((x) => x.dataset.id).includes(id), secs: [...document.querySelectorAll('.win.app-todo .td-sg-sec')].map((x) => x.dataset.key) }), id);
      check('suggested under Yesterday', sg.yesterday, true);
      check('suggestion sections', sg.secs.includes('yesterday'), true);
      await shot(s, 'suggestions-light-en');
      await s.page.click(`${WIN} .td-sg-row[data-id="${id}"] .td-sg-add`);
      await until(s, (app, id) => !!app.list.rowEl(id), { arg: id, label: 'back in My Day' });
      check('"+" adds the suggestion to today', await TD(s, (app, id) => app.store.task(id).myDay === app.today(), id), true);
      // two days later it appears under "Earlier in My Day"
      await TD(s, (app, id) => {
        app.store.update(id, { myDay: false });
        app.store.task(id).myDay = app.today();
        return true;
      }, id);
      await TD(s, (app, t) => (app.setNow(t), app.renderNow(), true), L(y, m, d + 3, 8, 0));
      check('older My Day history under "Earlier"', await TD(s, (app, id) => [...document.querySelectorAll('.win.app-todo .td-sg-sec[data-key="earlier"] .td-sg-row')].some((x) => x.dataset.id === id), id), true);
      await TD(s, (app) => (app.toggleSuggestions(false), app.setNow(null), app.renderNow(), true));
    });

    await section('Planned: groups Earlier / Today / Tomorrow / This week / Later with counts', async () => {
      // Monday 2026-10-12 10:00 (weeks start on Sunday in en-US)
      await TD(s, (app, t) => (app.setNow(t), true), L(2026, 10, 12, 10, 0));
      const ids = await TD(s, (app) => {
        const mk = (title, due) => app.addTask({ title, due, listId: 'tasks' }).id;
        return [mk('P earlier', '2026-10-01'), mk('P today', '2026-10-12'), mk('P tomorrow', '2026-10-13'), mk('P thursday', '2026-10-15'), mk('P saturday', '2026-10-17'), mk('P next week', '2026-10-19'), app.addTask({ title: 'P reminder only', remindAt: new Date(2026, 9, 12, 18, 0).getTime() }).id];
      });
      await go(s, 'planned');
      const r = await TD(s, (app, ids) => {
        const secs = [...document.querySelectorAll('.win.app-todo .td-body .td-sec')];
        const where = (id) => app.list.rowEl(id)?.closest('.td-sec')?.dataset.key;
        return { keys: secs.map((x) => x.dataset.key), labels: secs.map((x) => x.querySelector('.td-sec-label')?.textContent), where: ids.map(where), counts: secs.map((x) => Number(x.querySelector('.td-sec-count')?.textContent)), rows: secs.map((x) => x.querySelectorAll('.td-task').length) };
      }, ids);
      check('bucket per task', r.where, ['earlier', 'today', 'tomorrow', 'thisWeek', 'thisWeek', 'later', 'today']);
      check('sections in order', r.keys, ['earlier', 'today', 'tomorrow', 'thisWeek', 'later']);
      check('section labels', r.labels, ['Earlier', 'Today', 'Tomorrow', 'This week', 'Later']);
      check('counts match rows', JSON.stringify(r.counts), JSON.stringify(r.rows));
      await shot(s, 'planned-light-en');
      // collapse a group
      await s.page.click(`${WIN} .td-sec[data-key="earlier"] .td-sec-head`);
      await sleep(200);
      check('group collapses', await TD(s, () => document.querySelectorAll('.win.app-todo .td-sec[data-key="earlier"] .td-task').length), 0);
      await s.page.click(`${WIN} .td-sec[data-key="earlier"] .td-sec-head`);
      await TD(s, (app, ids) => (app.store.remove(ids), app.setNow(null), true), ids);
    });

    let listId;
    await section('lists: new (Ctrl+L) with emoji, rename, theme, duplicate, delete', async () => {
      await s.page.click(`${WIN} .td-nav-item[data-view="myday"]`);
      await s.page.keyboard.press('Control+l');
      await s.page.waitForSelector(`${WIN} .td-title-input`);
      check('new list title selected for typing', await s.page.evaluate(`(() => { const i = document.activeElement; return i?.classList.contains('td-title-input') && i.selectionStart === 0 && i.selectionEnd === i.value.length && i.value; })()`), 'Untitled list');
      await s.page.keyboard.type('🏖️ Holiday');
      await s.page.keyboard.press('Enter');
      await sleep(200);
      listId = await TD(s, (app) => app.view.slice(5));
      let r = await TD(s, (app, id) => ({ l: app.store.list(id), focus: document.activeElement?.className, nav: app.nav.itemFor(`list:${id}`)?.textContent }), listId);
      check('emoji becomes the list icon', [r.l.emoji, r.l.name], ['🏖️', 'Holiday']);
      check('Enter moves to "Add a task"', r.focus, 'td-add-input');
      check('list in the nav', r.nav.includes('Holiday'), true);
      for (const t of ['Sunscreen', 'Swimsuit', 'Book']) {
        await s.page.keyboard.type(t);
        await s.page.keyboard.press('Enter');
      }
      await sleep(200);
      check('tasks added to the new list (newest on top)', await TD(s, (app) => app.list.visibleIds().map((id) => app.store.task(id).title)), ['Book', 'Swimsuit', 'Sunscreen']);
      // rename by clicking the title
      await s.page.click(`${WIN} .td-title`);
      await s.page.fill(`${WIN} .td-title-input`, '🌴 Summer holiday');
      await s.page.keyboard.press('Enter');
      await sleep(150);
      r = await TD(s, (app, id) => app.store.list(id), listId);
      check('renamed with a new emoji', [r.emoji, r.name], ['🌴', 'Summer holiday']);
      // theme: colour then picture
      await s.page.click(`${WIN} .td-more`);
      await menuClick(s, 'Change theme');
      await s.page.waitForSelector(`${WIN} .td-pop-theme`);
      await s.page.click(`${WIN} .td-swatch.td-c-teal`);
      await sleep(150);
      check('colour theme applied', await TD(s, (app, id) => [app.store.list(id).theme.color, app.list.el.classList.contains('td-c-teal')], listId), ['teal', true]);
      await s.page.click(`${WIN} .td-bgthumb.td-bg-ocean`);
      await sleep(250);
      check('background picture applied', await TD(s, (app, id) => [app.store.list(id).theme.bg, app.list.el.classList.contains('td-bg-ocean'), app.list.el.classList.contains('has-bg')], listId), ['ocean', true, true]);
      await shot(s, 'theme-picker-light-en');
      await s.page.keyboard.press('Escape');
      await sleep(250);
      await shot(s, 'list-theme-light-en');
      // emoji picker from the title icon
      await s.page.click(`${WIN} .td-title-icon`);
      await s.page.waitForSelector(`${WIN} .td-emoji-grid`);
      await s.page.click(`${WIN} .td-emoji >> text=✈️`);
      await sleep(150);
      check('icon changed with the picker', await TD(s, (app, id) => app.store.list(id).emoji, listId), '✈️');
      // duplicate (open tasks only)
      await TD(s, (app, id) => {
        const t = app.store.data.tasks.find((x) => x.listId === id && x.title === 'Book');
        app.store.setDone(t.id, true);
        return true;
      }, listId);
      await s.page.click(`${WIN} .td-nav-item[data-view="list:${listId}"]`, { button: 'right' });
      await menuClick(s, 'Duplicate list');
      r = await TD(s, (app, id) => {
        const c = app.store.list(app.view.slice(5));
        return { name: c.name, emoji: c.emoji, theme: c.theme, tasks: app.store.data.tasks.filter((t) => t.listId === c.id).map((t) => t.title).sort(), other: c.id !== id, after: app.store.userLists().map((l) => l.id).indexOf(c.id) === app.store.userLists().map((l) => l.id).indexOf(id) + 1 };
      }, listId);
      check('duplicate name', [r.emoji, r.name], ['✈️', 'Summer holiday (copy)']);
      check('duplicate keeps the theme', r.theme, { color: 'teal', bg: 'ocean' });
      check('duplicate copies open tasks only', r.tasks, ['Sunscreen', 'Swimsuit']);
      check('duplicate placed right after', r.after, true);
      // delete the copy (confirm)
      const copyId = await TD(s, (app) => app.view.slice(5));
      await s.page.click(`${WIN} .td-more`);
      await menuClick(s, 'Delete list');
      await s.page.waitForSelector(DLG);
      check('delete asks for confirmation', (await s.page.textContent(DLG)).includes('permanently deleted'), true);
      await dialogButton(s, 'Cancel');
      check('cancel keeps the list', await TD(s, (app, id) => !!app.store.list(id), copyId), true);
      await s.page.click(`${WIN} .td-more`);
      await menuClick(s, 'Delete list');
      await dialogButton(s, 'Delete list');
      r = await TD(s, (app, id) => ({ list: !!app.store.list(id), tasks: app.store.data.tasks.filter((t) => t.listId === id).length, view: app.view }), copyId);
      check('list deleted with its tasks', [r.list, r.tasks], [false, 0]);
      check('falls back to Tasks', r.view, 'list:tasks');
    });

    await section('move tasks: menu and drag onto a list in the nav; drag to reorder', async () => {
      await go(s, `list:${listId}`);
      const ids = await TD(s, (app) => app.list.visibleIds());
      // context menu: Move to -> Groceries
      await s.page.click(rowSel(ids[0]), { button: 'right' });
      await s.page.waitForSelector('.menu');
      await s.page.locator('.menu .menu-item', { hasText: 'Move to' }).first().hover();
      await sleep(400);
      await s.page.locator('.menu .menu-item', { hasText: 'Groceries' }).last().click();
      await sleep(250);
      const groceries = await TD(s, (app) => app.store.userLists().find((l) => l.name === 'Groceries').id);
      check('moved with the menu', await TD(s, (app, id) => app.store.task(id).listId, ids[0]), groceries);
      // drag the remaining task onto "Tasks" in the nav
      await render(s);
      const remaining = await TD(s, (app) => app.list.visibleIds());
      const src = await s.page.locator(rowSel(remaining[0])).boundingBox();
      const dst = await s.page.locator(`${WIN} .td-nav-item[data-view="list:tasks"]`).boundingBox();
      await s.page.mouse.move(src.x + 120, src.y + src.height / 2);
      await s.page.mouse.down();
      await s.page.mouse.move(src.x + 110, src.y + src.height / 2 + 10, { steps: 3 });
      await s.page.mouse.move(dst.x + 40, dst.y + dst.height / 2, { steps: 12 });
      check('nav item highlights as a drop target', await s.page.evaluate(`!!document.querySelector('.win.app-todo .td-nav-item[data-view="list:tasks"].drop-target')`), true);
      check('ghost follows the pointer', await s.page.evaluate(`!!document.querySelector('.win.app-todo .td-ghost')`), true);
      await shot(s, 'drag-to-list-light-en');
      await s.page.mouse.up();
      await sleep(300);
      check('dropped onto Tasks', await TD(s, (app, id) => app.store.task(id).listId, remaining[0]), 'tasks');
      check('ghost removed', await s.page.evaluate(`!!document.querySelector('.win.app-todo .td-ghost')`), false);
      // drag onto My Day
      await go(s, 'list:tasks');
      await render(s);
      await sleep(300);
      const src2 = await s.page.locator(rowSel(remaining[0])).boundingBox();
      const dst2 = await s.page.locator(`${WIN} .td-nav-item[data-view="myday"]`).boundingBox();
      await s.page.mouse.move(src2.x + 120, src2.y + src2.height / 2);
      await s.page.mouse.down();
      await s.page.mouse.move(src2.x + 100, src2.y + 4, { steps: 3 });
      await s.page.mouse.move(dst2.x + 40, dst2.y + dst2.height / 2, { steps: 12 });
      await s.page.mouse.up();
      await sleep(250);
      check('dropped onto My Day', await TD(s, (app, id) => app.store.task(id).myDay === app.today(), remaining[0]), true);
      // drag to reorder inside a list (Groceries)
      await go(s, `list:${groceries}`);
      await TD(s, (app) => (app.store.setPref('starToTop', true), true));
      await render(s); // no re-render pending while the rows are measured
      await sleep(300);
      const order0 = await TD(s, (app) => app.list.visibleIds());
      const last = await s.page.locator(rowSel(order0[order0.length - 1])).boundingBox();
      const first = await s.page.locator(rowSel(order0[0])).boundingBox();
      await s.page.mouse.move(last.x + 150, last.y + last.height / 2);
      await s.page.mouse.down();
      await s.page.mouse.move(last.x + 150, last.y + last.height / 2 - 10, { steps: 3 });
      await s.page.mouse.move(first.x + 150, first.y + 6, { steps: 15 });
      await sleep(250);
      await s.page.mouse.up();
      await sleep(350);
      const order1 = await TD(s, (app) => app.list.visibleIds());
      check('last task dragged to the top', order1[0], order0[order0.length - 1]);
      check('order persisted in the model', await TD(s, (app, ids) => ids.map((id) => app.store.task(id).order), order1), [0, 1, 2, 3].slice(0, order1.length));
      // Escape cancels a drag
      const o2 = await TD(s, (app) => app.list.visibleIds());
      const b = await s.page.locator(rowSel(o2[0])).boundingBox();
      await s.page.mouse.move(b.x + 150, b.y + b.height / 2);
      await s.page.mouse.down();
      await s.page.mouse.move(b.x + 150, b.y + b.height * 2.5, { steps: 10 });
      await s.page.keyboard.press('Escape');
      await s.page.mouse.up();
      await sleep(250);
      check('Escape cancels the drag', await TD(s, (app) => app.list.visibleIds()), o2);
      // Alt+Down keyboard reorder
      await s.page.focus(rowSel(o2[0]));
      await s.page.keyboard.press('Alt+ArrowDown');
      await sleep(200);
      check('Alt+Down moves the task down', await TD(s, (app) => app.list.visibleIds()[1]), o2[0]);
    });

    await section('sort, group, copy as text, new list from task, copy to, hide a smart list', async () => {
      const lid = await TD(s, (app) => {
        const l = app.store.addList('Sorting');
        const mk = (title, f = {}, age = 0) => {
          const t = app.store.addTask({ title, listId: l.id, ...f }, { top: false });
          t.created -= age * 60000;
          return t;
        };
        mk('banana', { due: '2026-12-01' }, 3);
        mk('Apple', { important: true }, 2);
        mk('cherry', { due: '2026-11-01' }, 1);
        app.go(`list:${l.id}`);
        return l.id;
      });
      const order = () => TD(s, (app) => app.list.visibleIds().map((id) => app.store.task(id).title));
      await TD(s, (app, v) => (app.store.setPref('starToTop', false), app.store.setViewPref(v, { sort: { by: 'alpha', dir: 'asc' } }), app.renderNow(), true), `list:${lid}`);
      check('sort alphabetically (case-insensitive)', await order(), ['Apple', 'banana', 'cherry']);
      check('sort chip shown', await s.page.textContent(`${WIN} .td-sortchip`), 'Sorted by Alphabetically');
      await s.page.click(`${WIN} .td-chip-main`);
      await sleep(150);
      check('chip reverses the order', await order(), ['cherry', 'banana', 'Apple']);
      await TD(s, (app, v) => (app.store.setViewPref(v, { sort: { by: 'due', dir: 'asc' } }), app.renderNow(), true), `list:${lid}`);
      check('sort by due date (no date last)', await order(), ['cherry', 'banana', 'Apple']);
      await TD(s, (app, v) => (app.store.setViewPref(v, { sort: { by: 'importance', dir: 'asc' } }), app.renderNow(), true), `list:${lid}`);
      check('sort by importance', (await order())[0], 'Apple');
      await s.page.click(`${WIN} .td-sort-btn`);
      await menuClick(s, 'Creation date');
      check('sort menu: creation date (newest first)', await order(), ['cherry', 'Apple', 'banana']);
      await s.page.click(`${WIN} .td-chip-x`);
      await sleep(150);
      check('sort removed', await TD(s, (app, v) => app.store.viewPrefs(v).sort, `list:${lid}`), null);
      await s.page.click(`${WIN} .td-group-btn`);
      await menuClick(s, 'Due date');
      const g = await TD(s, () => [...document.querySelectorAll('.win.app-todo .td-body .td-sec')].map((x) => x.dataset.key));
      check('group a list by due date (+ "No due date")', g.includes('noDate') && g.length >= 2, true);
      await TD(s, (app, v) => (app.store.setViewPref(v, { groupBy: 'none' }), app.store.setPref('starToTop', true), true), `list:${lid}`);
      // smart list grouped by list
      await go(s, 'important');
      await TD(s, (app) => (app.store.setViewPref('important', { groupBy: 'list' }), app.renderNow(), true));
      check('Important grouped by list', await TD(s, () => [...document.querySelectorAll('.win.app-todo .td-body .td-sec-head .td-sec-label')].length > 0), true);
      await TD(s, (app) => (app.store.setViewPref('important', { groupBy: 'none' }), true));
      // copy as text -> clipboard
      await go(s, `list:${lid}`);
      await TD(s, (app, v) => app.copyListText(v).then(() => true), `list:${lid}`);
      const clip = await s.page.evaluate(`window.__aurora.api.invoke('clipboard:readText')`);
      check('list copied as text', clip.startsWith('Sorting\n') && clip.includes('☐ cherry'), true);
      // new list from a task (its steps become tasks)
      const nl = await TD(s, (app, lid) => {
        const t = app.store.addTask({ title: 'Wedding', listId: lid, steps: [{ title: 'Venue' }, { title: 'Rings', done: true }] });
        app.newListFromTask(t.id);
        const l = app.store.list(app.view.slice(5));
        return { name: l.name, tasks: app.store.data.tasks.filter((x) => x.listId === l.id).map((x) => [x.title, x.done]).sort(), gone: !app.store.task(t.id) };
      }, lid);
      check('new list from a task', [nl.name, nl.gone], ['Wedding', true]);
      check('its steps became tasks', nl.tasks, [['Rings', true], ['Venue', false]]);
      // copy to another list
      const cp = await TD(s, (app, lid) => {
        const src = app.store.data.tasks.find((x) => x.listId === lid && x.title === 'cherry');
        const c = app.store.copy(src.id, 'tasks');
        return [c.listId, c.title, c.due, app.store.task(src.id).listId === lid];
      }, lid);
      check('copy to keeps the original', cp, ['tasks', 'cherry', '2026-11-01', true]);
      // hide a smart list from its menu
      await s.page.click(`${WIN} .td-nav-item[data-view="planned"]`, { button: 'right' });
      await menuClick(s, 'Hide this smart list');
      check('smart list hidden', await TD(s, (app) => [!!app.nav.itemFor('planned'), app.store.data.prefs.smart.planned]), [false, false]);
      await TD(s, (app, lid) => (app.store.setPref('smart.planned', true), app.store.deleteList(lid), app.store.deleteList(app.store.userLists().find((l) => l.name === 'Wedding').id), true), lid);
    });

    await section('groups: create, rename, move a list in, collapse, ungroup', async () => {
      await s.page.click(`${WIN} .td-newgroup`);
      await s.page.waitForSelector(`${WIN} .td-group-edit`);
      await s.page.fill(`${WIN} .td-group-edit`, 'Personal');
      await s.page.keyboard.press('Enter');
      await sleep(150);
      const gid = await TD(s, (app) => app.store.data.groups.find((g) => g.name === 'Personal')?.id);
      check('group created and named', !!gid, true);
      await s.page.click(`${WIN} .td-nav-item[data-view="list:${listId}"]`, { button: 'right' });
      await s.page.locator('.menu .menu-item', { hasText: 'Move to group' }).first().hover();
      await sleep(400);
      await s.page.locator('.menu .menu-item', { hasText: 'Personal' }).last().click();
      await sleep(200);
      let r = await TD(s, (app, [gid, lid]) => ({ g: app.store.list(lid).groupId, inDom: !!document.querySelector(`.win.app-todo .td-group[data-group-id="${gid}"] .td-nav-item[data-view="list:${lid}"]`) }), [gid, listId]);
      check('list moved into the group', [r.g === gid, r.inDom], [true, true]);
      await shot(s, 'groups-light-en');
      await s.page.click(`${WIN} .td-group-head[data-group="${gid}"]`);
      await sleep(200);
      check('group collapses', await TD(s, (app, [gid, lid]) => [app.store.group(gid).collapsed, !!app.nav.itemFor(`list:${lid}`)?.checkVisibility()], [gid, listId]), [true, false]);
      await s.page.click(`${WIN} .td-group-head[data-group="${gid}"]`);
      await s.page.click(`${WIN} .td-group-head[data-group="${gid}"]`, { button: 'right' });
      await menuClick(s, 'Ungroup lists');
      r = await TD(s, (app, [gid, lid]) => [!!app.store.group(gid), app.store.list(lid).groupId], [gid, listId]);
      check('ungroup keeps the lists', r, [false, null]);
    });

    await section('search (Ctrl+F): title, step and note, highlight, Escape', async () => {
      await go(s, 'list:tasks');
      await TD(s, (app) => {
        const t = app.addTask({ title: 'Renew passport', listId: 'tasks' });
        app.store.addStep(t.id, 'Find the old passport photo');
        const n = app.addTask({ title: 'Dentist', listId: 'tasks', note: 'Bring the insurance card and the passport' });
        return true;
      });
      await TD(s, (app) => (app.list.focusList(), true));
      await s.page.keyboard.press('Control+f');
      check('Ctrl+F focuses search', await s.page.evaluate(`document.activeElement?.classList.contains('td-search-input')`), true);
      await s.page.keyboard.type('PASSPÒRT');
      await until(s, (app) => app.view === 'search' && app.list.visibleIds().length >= 2, { label: 'search results' });
      const r = await TD(s, (app) => ({
        titles: app.list.visibleIds().map((id) => app.store.task(id).title),
        title: document.querySelector('.win.app-todo .td-title').textContent,
        marks: [...document.querySelectorAll('.win.app-todo .td-mark')].map((m) => m.textContent),
        snips: [...document.querySelectorAll('.win.app-todo .td-meta-snip')].map((m) => m.textContent),
      }));
      check('finds the title match (case / accent insensitive)', r.titles.includes('Renew passport'), true);
      check('finds the note of another task', r.titles.includes('Plan the trip'), true);
      check('finds the note match', r.titles.includes('Dentist'), true);
      check('search title', r.title, 'Searching for “PASSPÒRT”');
      check('matches highlighted', r.marks.some((m) => m.toLowerCase() === 'passport'), true);
      check('note snippet shown', r.snips.some((x) => x.startsWith('Note:')), true);
      await shot(s, 'search-light-en');
      await s.page.fill(`${WIN} .td-search-input`, 'zzzz-nothing');
      await until(s, () => !!document.querySelector('.win.app-todo .td-empty-search'), { label: 'empty search' });
      check('no results state', true, true);
      await s.page.focus(`${WIN} .td-search-input`);
      await s.page.keyboard.press('Escape');
      await sleep(200);
      check('Escape clears the search and goes back', await TD(s, (app) => [app.view, app.query, app.nav.search.value]), ['list:tasks', '', '']);
    });

    await section('keyboard: arrows, Enter, Space, Ctrl+D, Delete, Ctrl+Shift+?', async () => {
      await go(s, 'list:tasks');
      await TD(s, (app) => (app.store.setPref('confirmDelete', true), true));
      const ids = await TD(s, (app) => app.list.visibleIds());
      await s.page.click(`${WIN} .td-add-input`);
      await s.page.keyboard.press('ArrowDown');
      check('Down from "Add a task" focuses the first task', await s.page.evaluate(`document.activeElement?.dataset?.id`), ids[0]);
      await s.page.keyboard.press('ArrowDown');
      await s.page.keyboard.press('ArrowDown');
      check('arrows move between tasks', await s.page.evaluate(`document.activeElement?.dataset?.id`), ids[2]);
      await s.page.keyboard.press('ArrowUp');
      check('ArrowUp', await s.page.evaluate(`document.activeElement?.dataset?.id`), ids[1]);
      await s.page.keyboard.press('Enter');
      await sleep(250);
      check('Enter opens the details (title focused)', await TD(s, (app) => [app.openId, document.activeElement?.dataset?.key]), [ids[1], 'title']);
      await s.page.keyboard.press('Escape');
      await sleep(250);
      check('Escape closes the details and returns to the row', await TD(s, (app) => [app.openId, document.activeElement?.dataset?.id]), [null, ids[1]]);
      await s.page.keyboard.press('Space');
      await until(s, (app, id) => app.store.task(id).done, { arg: ids[1], label: 'space completes' });
      check('Space completes the focused task', true, true);
      await TD(s, (app, id) => (app.complete([id], false), app.renderNow(), true), ids[1]);
      await s.page.focus(rowSel(ids[2]));
      await s.page.keyboard.press('Control+d');
      await until(s, (app, id) => app.store.task(id).done, { arg: ids[2], label: 'ctrl+d completes' });
      check('Ctrl+D completes', true, true);
      await TD(s, (app, id) => (app.complete([id], false), app.renderNow(), true), ids[2]);
      // Delete with confirmation
      await s.page.focus(rowSel(ids[3]));
      await s.page.keyboard.press('Delete');
      await s.page.waitForSelector(DLG);
      check('Delete asks first', (await s.page.textContent(DLG)).includes('will be permanently deleted'), true);
      await shot(s, 'delete-confirm-light-en');
      await dialogButton(s, 'Delete task');
      await until(s, (app, id) => !app.store.task(id), { arg: ids[3], label: 'deleted' });
      check('focus moves to the next task', await s.page.evaluate(`document.activeElement?.dataset?.id`), ids[4]);
      // help
      await s.page.keyboard.press('Control+Shift+?');
      await s.page.waitForSelector(`${DLG} .td-keys`);
      check('shortcuts sheet', (await s.page.textContent(DLG)).includes('Keyboard shortcuts'), true);
      await shot(s, 'shortcuts-light-en');
      await s.page.keyboard.press('Escape');
    });

    await section('multi-select: Ctrl+click, Shift+click, bulk menu', async () => {
      await go(s, 'list:tasks');
      const ids = await TD(s, (app) => app.list.visibleIds());
      await s.page.click(`${rowSel(ids[0])} .td-row-title`);
      await s.page.click(`${rowSel(ids[3])} .td-row-title`, { modifiers: ['Shift'] });
      check('Shift+click selects a range', await TD(s, (app) => app.sel.size), 4);
      check('details pane closes for a multi-selection', await TD(s, (app) => app.openId), null);
      await s.page.click(`${rowSel(ids[2])} .td-row-title`, { modifiers: ['Control'] });
      check('Ctrl+click removes from the selection', await TD(s, (app) => [...app.sel].sort()), [ids[0], ids[1], ids[3]].sort());
      await s.page.click(`${rowSel(ids[2])} .td-row-title`, { modifiers: ['Control'] });
      check('Ctrl+click adds to the selection', await TD(s, (app) => app.sel.size), 4);
      check('selected rows painted', await s.page.evaluate(`document.querySelectorAll('.win.app-todo .td-task.selected').length`), 4);
      await s.page.click(rowSel(ids[3]), { button: 'right' });
      await s.page.waitForSelector('.menu');
      check('bulk menu header', (await s.page.textContent('.menu')).includes('4 tasks selected'), true);
      await shot(s, 'multiselect-light-en', { clip: false });
      await menuClick(s, 'Add to My Day');
      check('bulk action applied to all', await TD(s, (app, ids) => ids.slice(0, 4).every((id) => app.store.task(id).myDay === app.today()), ids), true);
      await TD(s, (app, ids) => (app.store.setMyDay(ids.slice(0, 4), false), true), ids);
    });

    await section('accessibility: every control has a name, checkboxes report their state', async () => {
      await go(s, 'list:tasks');
      const id = await TD(s, (app) => app.store.data.tasks.find((t) => t.listId === 'tasks' && !t.done && t.steps.length)?.id || app.list.visibleIds()[0]);
      await TD(s, (app, id) => (app.openTask(id), true), id);
      await sleep(300);
      const r = await s.page.evaluate(`(() => {
        const win = document.querySelector('.win.app-todo .td');
        const unnamed = [];
        for (const el of win.querySelectorAll('button, input, textarea, select, [role="checkbox"], [role="listitem"]')) {
          if (el.closest('[aria-hidden="true"]') || el.getAttribute('aria-hidden') === 'true' || !el.checkVisibility()) continue;
          const name = (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.textContent || '').trim();
          if (!name) unnamed.push(el.className || el.tagName);
        }
        const checks = [...win.querySelectorAll('[role="checkbox"]')].filter((c) => !['true', 'false'].includes(c.getAttribute('aria-checked'))).length;
        const live = !!win.querySelector('[aria-live]');
        const landmarks = ['nav', 'main', 'aside'].map((t) => !!win.querySelector(t));
        return { unnamed: [...new Set(unnamed)], checks, live, landmarks };
      })()`);
      check('no unnamed controls', r.unnamed, []);
      check('checkboxes report aria-checked', r.checks, 0);
      check('live region for announcements', r.live, true);
      check('nav / main / aside landmarks', r.landmarks, [true, true, true]);
      await TD(s, (app) => (app.closeDetail({ focus: false }), true));
    });

    await section('settings: smart lists, confirm before deleting, sound', async () => {
      await s.page.click(`${WIN} .td-settings-btn`);
      await s.page.waitForSelector(`${WIN} .td-settings:not([hidden]) .td-set-row`);
      await shot(s, 'settings-light-en');
      await s.page.click(`${WIN} .td-set-row[data-key="smart.assigned"]`);
      await sleep(150);
      check('Assigned to me shown', await TD(s, (app) => !!app.nav.itemFor('assigned')), true);
      await s.page.click(`${WIN} .td-set-row[data-key="smart.all"]`);
      await sleep(150);
      check('All hidden', await TD(s, (app) => !!app.nav.itemFor('all')), false);
      await s.page.click(`${WIN} .td-set-row[data-key="confirmDelete"]`);
      await s.page.click(`${WIN} .td-set-row[data-key="sound"]`);
      await sleep(150);
      check('prefs saved', await TD(s, (app) => [app.store.data.prefs.confirmDelete, app.store.data.prefs.sound]), [false, false]);
      await s.page.click(`${WIN} .td-nav-item[data-view="assigned"]`);
      check('Assigned to me empty state', await s.page.evaluate(`!!document.querySelector('.win.app-todo .td-empty-assigned')`), true);
      // no confirmation, no chime now
      await go(s, 'list:tasks');
      const id = await TD(s, (app) => app.addTask({ title: 'Throwaway' }).id);
      await render(s);
      await TD(s, (app) => ((app.lastChime = 0), true));
      await s.page.click(`${rowSel(id)} .td-check`);
      await sleep(600);
      check('no chime when the sound is off', await TD(s, (app) => app.lastChime), 0);
      await TD(s, (app, id) => (app.select(id, { open: false }), app.list.focusRow(id), true), id);
      await s.page.keyboard.press('Delete');
      await sleep(250);
      check('deleted without confirmation', await TD(s, (app, id) => !!app.store.task(id), id), false);
      await TD(s, (app) => {
        app.store.setPref('confirmDelete', true);
        app.store.setPref('sound', true);
        app.store.setPref('smart.all', true);
        return true;
      });
    });

    await section('examples: remove from the banner', async () => {
      await go(s, 'myday');
      await TD(s, (app) => (app.store.setPref('seedBanner', true), true));
      await render(s);
      await s.page.click(`${WIN} .td-seed-remove`);
      await sleep(250);
      const r = await TD(s, (app) => ({ seed: app.store.data.tasks.filter((t) => t.seed).length, groceries: app.store.userLists().some((l) => l.name === 'Groceries'), banner: !!document.querySelector('.win.app-todo .td-seed-banner') }));
      check('example tasks removed', r.seed, 0);
      check('example list kept (it has a task of yours)', r.groceries, true);
      check('banner gone', r.banner, false);
    });

    await section('layout: minimum size and maximized', async () => {
      await go(s, 'list:tasks');
      const first = await TD(s, (app) => app.list.visibleIds()[0]);
      await TD(s, (app, id) => (app.openTask(id), true), first);
      await TD(s, (app) => (app.win.maximize(), true));
      await sleep(600);
      await shot(s, 'maximized-light-en', { clip: false });
      check('docked details when maximized', await TD(s, (app) => !app.root.classList.contains('overlay-detail')), true);
      check('no overflow (maximized)', await overflowProbe(s), []);
      await TD(s, (app) => (app.win.restore(), app.win.setSize(400, 480), true));
      await sleep(600);
      const r = await TD(s, (app) => ({ narrow: app.root.classList.contains('narrow'), tight: app.root.classList.contains('tight'), w: app.win.el.getBoundingClientRect().width, burger: !!app.list.burger.checkVisibility() }));
      check('narrow layout at the minimum size', [r.narrow, r.tight, r.burger], [true, true, true]);
      check('minimum width honoured', Math.round(r.w) >= 400, true);
      await shot(s, 'minsize-detail-light-en');
      check('no overflow (min size, details open)', await overflowProbe(s), []);
      await TD(s, (app) => (app.closeDetail({ focus: false }), true));
      await sleep(250);
      await s.page.click(`${WIN} .td-burger`);
      await sleep(400);
      check('hamburger opens the nav overlay', await TD(s, (app) => app.root.classList.contains('nav-open')), true);
      await shot(s, 'minsize-nav-light-en');
      await s.page.click(`${WIN} .td-nav-item[data-view="planned"]`);
      await sleep(300);
      check('choosing a list closes the overlay', await TD(s, (app) => [app.view, app.root.classList.contains('nav-open')]), ['planned', false]);
      check('no overflow (min size)', await overflowProbe(s), []);
      await TD(s, (app) => (app.win.setSize(1180, 760), app.win.center?.(), true));
      await sleep(400);
    });

    await section('persistence: data saved and reloaded after closing the window', async () => {
      await TD(s, async (app) => {
        app.addTask({ title: 'Persist me', listId: 'tasks', important: true, due: '2030-05-06', note: 'n' });
        await app.store.flush();
        return true;
      });
      const before = await TD(s, (app) => ({ tasks: app.store.data.tasks.length, lists: app.store.data.lists.length, version: app.store.data.version }));
      // close the window while a completion animates and a title is being typed: both must be kept
      const [fastId, editId] = await TD(s, (app) => {
        app.go('list:tasks');
        const a = app.addTask({ title: 'Complete then close', listId: 'tasks' });
        const b = app.addTask({ title: 'Rename then close', listId: 'tasks' });
        app.renderNow();
        app.complete([a.id], true);
        app.openTask(b.id);
        const ta = app.detail.el.querySelector('[data-key="title"]');
        ta.focus();
        ta.value = 'Renamed before closing';
        app.win.close();
        return [a.id, b.id];
      });
      await sleep(800);
      check('window closed', await s.page.evaluate(`!!document.querySelector('.win.app-todo')`), false);
      const file = path.join(s.home, '.config', 'aurora', 'apps', 'todo', 'data.json');
      const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
      check('stored on disk with the schema version', [disk.version, disk.tasks.length], [2, before.tasks + 2]);
      await s.page.evaluate(`window.__aurora.registry.launch('todo')`);
      await s.page.waitForSelector(`${WIN} .td`);
      await until(s, (app) => !!app?.store, { label: 'relaunched' });
      const after = await TD(s, (app) => ({ tasks: app.store.data.tasks.length, lists: app.store.data.lists.length, t: app.store.data.tasks.find((x) => x.title === 'Persist me'), firstRun: app.store.firstRun }));
      check('same tasks and lists after relaunch', [after.tasks, after.lists], [before.tasks + 2, before.lists]);
      check('task fields kept', [after.t?.important, after.t?.due, after.t?.note], [true, '2030-05-06', 'n']);
      check('no re-seeding on relaunch', after.firstRun, false);
      check('completion in flight when closing is kept', await TD(s, (app, id) => app.store.task(id)?.done, fastId), true);
      check('title typed when closing is kept', await TD(s, (app, id) => app.store.task(id)?.title, editId), 'Renamed before closing');
    });

    await section('two windows share one store (newWindow)', async () => {
      await s.page.evaluate(`window.__aurora.registry.launch('todo', { newWindow: true })`);
      await sleep(800);
      const r = await s.page.evaluate(`(() => {
        const wins = [...document.querySelectorAll('.win.app-todo')].map((w) => w.__todo).filter(Boolean);
        if (wins.length < 2) return { n: wins.length };
        const [a, b] = wins;
        const t = b.addTask({ title: 'Added in the second window', listId: 'tasks' });
        a.go('list:tasks');
        a.renderNow();
        return { n: wins.length, same: a.store === b.store, seen: !!a.list.rowEl(t.id), id: t.id };
      })()`);
      check('second window opened', r.n, 2);
      check('both windows use the same store', r.same, true);
      check('a task added in one window shows in the other', r.seen, true);
      // close the second window: the first keeps working and saving
      await s.page.evaluate(`(() => { const w = [...document.querySelectorAll('.win.app-todo')][1]; w.__todo.win.close(); })()`);
      await sleep(700);
      const after = await TD(s, async (app, id) => {
        const t = app.addTask({ title: 'After closing the other window', listId: 'tasks' });
        await app.store.flush();
        return { ok: !!app.store.task(id) && !!t, wins: document.querySelectorAll('.win.app-todo').length };
      }, r.id);
      check('first window still works', after, { ok: true, wins: 1 });
      const disk = JSON.parse(fs.readFileSync(path.join(s.home, '.config', 'aurora', 'apps', 'todo', 'data.json'), 'utf8'));
      check('both windows’ tasks saved', ['Added in the second window', 'After closing the other window'].every((x) => disk.tasks.some((t) => t.title === x)), true);
    });

    await section('performance: 1500 tasks', async () => {
      const r = await TD(s, (app) => {
        const lists = [];
        for (let i = 0; i < 10; i++) lists.push(app.store.addList(`Perf ${i}`).id);
        for (let i = 0; i < 1500; i++) app.store.addTask({ title: `Perf task ${i} with a few words`, listId: lists[i % 10], due: i % 3 ? `2026-11-${String(1 + (i % 28)).padStart(2, '0')}` : null, important: i % 7 === 0 }, { top: false });
        const time = (fn) => {
          const a = performance.now();
          fn();
          return Math.round(performance.now() - a);
        };
        app.go('all');
        const all = time(() => app.renderNow());
        app.go('planned');
        const planned = time(() => app.renderNow());
        app.go(`list:${lists[0]}`);
        const list = time(() => app.renderNow());
        app.setSearch('task 14');
        const search = time(() => app.renderNow());
        app.setSearch('');
        return { all, planned, list, search };
      });
      console.log(`      render times (ms): ${JSON.stringify(r)}`);
      check('All view with 1500 tasks renders in < 600 ms', r.all < 600, true);
      check('Planned with 1000 dated tasks renders in < 600 ms', r.planned < 600, true);
      check('a 150-task list renders in < 200 ms', r.list < 200, true);
      check('search renders in < 600 ms', r.search < 600, true);
    });

    await section('console: no errors from To Do', async () => {
      check('no console errors', todoErrors(s), []);
    });
  } finally {
    current = null;
    await s.close();
  }
}

// ================================================================== launch B: French, dark
async function runFrench() {
  const s = await launchShell({ open: ['todo'], lang: 'fr', theme: 'dark' });
  current = s;
  try {
    await s.page.waitForSelector(`${WIN} .td`, { timeout: 20000 });
    await until(s, (app) => !!app?.store, { label: 'todo ready' });
    await sleep(300);
    await section('French: seed, labels, dates, week starts on Monday', async () => {
      const r = await TD(s, (app) => ({
        labels: [...app.nav.el.querySelectorAll('.td-nav-smart .td-nav-label')].map((n) => n.textContent),
        seed: app.store.data.tasks.filter((t) => t.seed).map((t) => t.title),
        list: app.store.userLists().map((l) => l.name),
        add: app.list.addInput.placeholder,
        ws: app.weekStart,
        sub: document.querySelector('.win.app-todo .td-subtitle').textContent,
        title: document.querySelector('.win.app-todo .td-title').textContent,
      }));
      check('smart list labels in French', r.labels, ['Ma journée', 'Important', 'Planifié', 'Toutes', 'Terminées', 'Tâches']);
      check('examples in French', r.seed.some((x) => x.startsWith('Bienvenue dans Tâches')), true);
      check('example list in French', r.list, ['Courses']);
      check('add placeholder', r.add, 'Ajouter une tâche');
      check('weeks start on Monday', r.ws, 1);
      check('French long date', /^[a-z]+ \d+ [a-zéû]+$/.test(r.sub), true);
      check('title', r.title, 'Ma journée');
      await shot(s, 'myday-dark-fr');
    });
    await section('French: details, menus, pickers and overflow', async () => {
      await go(s, 'list:tasks');
      const id = await TD(s, (app) => app.store.data.tasks.find((t) => t.steps.length)?.id);
      await TD(s, (app, id) => (app.openTask(id), true), id);
      await sleep(300);
      const r = await TD(s, () => [...document.querySelectorAll('.win.app-todo .td-opt-label')].map((x) => x.textContent));
      check('detail options in French', r, ['Ajouter à Ma journée', 'Me le rappeler', 'Ajouter une date d’échéance', 'Répéter']);
      await shot(s, 'detail-dark-fr');
      check('no overflow (French, details open)', await overflowProbe(s), []);
      await s.page.click(`${WIN} .td-opt[data-key="remind"]`);
      await s.page.waitForSelector('.menu');
      const m = await s.page.textContent('.menu');
      check('reminder menu in French', m.includes('Demain') && m.includes('La semaine prochaine') && m.includes('Choisir une date et une heure'), true);
      await s.page.keyboard.press('Escape');
      await sleep(200);
      await s.page.click(`${WIN} .td-opt[data-key="repeat"]`);
      await menuClick(s, 'Toutes les semaines');
      const rl = await TD(s, () => document.querySelector('.win.app-todo .td-opt[data-key="repeat"] .td-opt-label').textContent);
      check('repeat label in French', /^Chaque semaine le (lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)$/.test(rl), true);
      await s.page.click(`${WIN} .td-opt[data-key="due"]`);
      await menuClick(s, 'Choisir une date');
      await s.page.waitForSelector(`${WIN} .td-pop .td-cal-head`);
      const head = await TD(s, () => document.querySelector('.win.app-todo .td-pop .td-cal-head span').textContent);
      check('calendar starts on Monday (L)', head.toUpperCase(), 'L');
      await shot(s, 'date-picker-dark-fr');
      await s.page.keyboard.press('Escape');
      await TD(s, (app) => (app.closeDetail({ focus: false }), true));
      await go(s, 'planned');
      await shot(s, 'planned-dark-fr');
      check('no overflow (Planned)', await overflowProbe(s), []);
      await TD(s, (app) => (app.win.setSize(400, 480), true));
      await sleep(600);
      await go(s, 'list:tasks');
      await shot(s, 'minsize-dark-fr');
      check('no overflow (French, min size)', await overflowProbe(s), []);
      await go(s, 'settings');
      await sleep(300);
      await shot(s, 'settings-minsize-dark-fr');
      check('no overflow (French settings, min size)', await overflowProbe(s), []);
      await TD(s, (app) => (app.win.maximize(), true));
      await sleep(600);
      await go(s, 'list:tasks');
      const first = await TD(s, (app) => app.list.visibleIds()[0]);
      await TD(s, (app, id) => (app.openTask(id), app.list.focusRow(id), true), first);
      await shot(s, 'maximized-dark-fr', { clip: false });
      await s.page.keyboard.press('Control+Shift+?');
      await s.page.waitForSelector(`${DLG} .td-keys`);
      check('shortcut names localized', (await s.page.textContent(DLG)).includes('Maj'), true);
      await s.page.keyboard.press('Escape');
    });
    await section('French: console', async () => {
      check('no console errors (fr)', todoErrors(s), []);
    });
  } finally {
    current = null;
    await s.close();
  }
}

// ================================================================== launch C: migration + reminder sync at launch
async function runMigration() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-home-'));
  const appDir = path.join(home, '.config', 'aurora', 'apps');
  fs.mkdirSync(path.join(appDir, 'todo'), { recursive: true });
  fs.mkdirSync(path.join(appDir, 'shell'), { recursive: true });
  const soon = Date.now() + 2 * 86400e3;
  fs.writeFileSync(
    path.join(appDir, 'todo', 'data.json'),
    JSON.stringify({
      version: 1,
      lists: [{ id: 'work', name: '💼 Work' }],
      tasks: [
        { id: 'a', listId: 'work', title: 'Old task', dueDate: new Date(2026, 9, 20).getTime(), reminder: soon, starred: true, steps: ['one', { text: 'two', checked: true }] },
        { id: 'b', listId: 'missing-list', title: 'Orphan list task', completed: true },
        { id: 'c', title: '' },
        { id: 'd', listId: 'work', title: 'Was in My Day', inMyDay: true, myDayDate: Date.now() },
      ],
    }),
  );
  fs.writeFileSync(
    path.join(appDir, 'shell', 'reminders.json'),
    JSON.stringify([
      { id: 'task-zzz', appId: 'todo', at: soon, title: 'stale', body: '', repeat: null, kind: 'reminder', snoozeMinutes: 10, data: { taskId: 'zzz' } },
      { id: 'alarm-1', appId: 'clock', at: soon, title: 'clock alarm', body: '', repeat: null, kind: 'alarm', snoozeMinutes: 10, data: null },
    ]),
  );
  const s = await launchShell({ open: ['todo'], lang: 'en', theme: 'light', home });
  current = s;
  try {
    await s.page.waitForSelector(`${WIN} .td`, { timeout: 20000 });
    await until(s, (app) => !!app?.store, { label: 'todo ready' });
    await sleep(400);
    await section('migration from schema v1', async () => {
      const r = await TD(s, (app) => {
        const a = app.store.task('a');
        return {
          version: app.store.data.version,
          a: a && { due: a.due, remindAt: a.remindAt, important: a.important, steps: a.steps.map((x) => [x.title, x.done]) },
          b: app.store.task('b') && [app.store.task('b').listId, app.store.task('b').done],
          c: app.store.task('c'),
          d: app.store.task('d')?.myDay === app.today(),
          work: app.store.list('work') && [app.store.list('work').emoji, app.store.list('work').name],
          firstRun: app.store.firstRun,
          seed: app.store.data.tasks.some((t) => t.seed),
        };
      });
      check('upgraded to schema 2', r.version, 2);
      check('v1 fields converted', r.a && [r.a.due, r.a.important, r.a.steps], ['2026-10-20', true, [['one', false], ['two', true]]]);
      check('task of an unknown list goes to Tasks', r.b, ['tasks', true]);
      check('task without a title dropped', r.c, null);
      check('My Day flag converted', r.d, true);
      check('leading emoji of a v1 list name becomes its icon', r.work, ['💼', 'Work']);
      check('existing data: no examples added', [r.firstRun, r.seed], [false, false]);
      const disk = JSON.parse(fs.readFileSync(path.join(appDir, 'todo', 'data.json'), 'utf8'));
      check('migrated copy written back', disk.version, 2);
    });
    await section('reminder sync at launch', async () => {
      const r = await TD(s, (app) => ({ todo: app.shell.reminders.list('todo').map((x) => x.id), clock: app.shell.reminders.list('clock').map((x) => x.id) }));
      check('stale reminder removed, missing one added', r.todo, ['task-a']);
      check('other apps’ reminders untouched', r.clock, ['alarm-1']);
    });
    await section('migration: console', async () => {
      check('no console errors (migration)', todoErrors(s), []);
    });
  } finally {
    current = null;
    await s.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// ================================================================== launch D: damaged data file
async function runDamaged() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-home-'));
  const dir = path.join(home, '.config', 'aurora', 'apps', 'todo');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'data.json'), '{"version":2,"tasks":[{"id":"x","title":"half writ');
  const s = await launchShell({ open: ['todo'], lang: 'en', theme: 'dark', home });
  current = s;
  try {
    await s.page.waitForSelector(`${WIN} .td`, { timeout: 20000 });
    await until(s, (app) => !!app?.store, { label: 'todo ready' });
    await section('damaged data file: kept aside, user told, app usable', async () => {
      await s.page.waitForSelector(DLG, { timeout: 5000 });
      const text = await s.page.textContent(DLG);
      check('user is told', text.includes('damaged'), true);
      await shot(s, 'damaged-dark-en');
      await dialogButton(s, 'OK');
      const files = fs.readdirSync(dir);
      const backup = files.find((f) => /^data\.damaged-\d+\.json$/.test(f));
      check('damaged file kept aside', !!backup, true);
      check('backup has the original bytes', backup && fs.readFileSync(path.join(dir, backup), 'utf8'), '{"version":2,"tasks":[{"id":"x","title":"half writ');
      const r = await TD(s, (app) => {
        const t = app.addTask({ title: 'Fresh start' });
        return { ok: !!t, seed: app.store.data.tasks.some((x) => x.seed), lists: app.store.data.lists.length };
      });
      check('app usable, no examples mixed in', [r.ok, r.seed, r.lists], [true, false, 1]);
      await TD(s, (app) => app.store.flush().then(() => true));
      check('new data file written', JSON.parse(fs.readFileSync(path.join(dir, 'data.json'), 'utf8')).tasks[0].title, 'Fresh start');
      check('no console errors (damaged)', todoErrors(s), []);
    });
  } finally {
    current = null;
    await s.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// ================================================================== launch E: QA (adversarial), English, light, 1280x720
// Listener leaks over 15 open / close cycles, untrusted text never parsed as HTML, repeat rule follows a moved
// due date, example copies, double submits / rapid clicks, Tab / F6 / Delete / F2 keyboard rules, save failure +
// retry, 1280x720 maximized layout (meta separators, option rows), wrapped steps, keyboard-reachable suggestions.
async function runQA() {
  const s = await launchShell({ open: [], lang: 'en', theme: 'light', size: '1280x720' });
  current = s;
  const ev = (fn, arg) => s.page.evaluate(`(async () => (${fn.toString()})(${JSON.stringify(arg ?? null)}))()`);
  try {
    await section('QA: no listener leaks after 15 open / close cycles (with flyouts and details open)', async () => {
      await ev(() => {
        const track = (target, name) => {
          const add = target.addEventListener.bind(target);
          const rem = target.removeEventListener.bind(target);
          const live = new Set();
          const key = (t, fn, o) => `${t}|${fn && (fn.__lk ??= Math.random())}|${typeof o === 'object' ? !!o?.capture : !!o}`;
          target.addEventListener = (t, fn, o) => (live.add(key(t, fn, o)), add(t, fn, o));
          target.removeEventListener = (t, fn, o) => (live.delete(key(t, fn, o)), rem(t, fn, o));
          window[`__live_${name}`] = live;
        };
        track(document, 'doc');
        track(window, 'win');
        const A = window.__aurora;
        window.__subs = { reminders: 0, settings: 0, i18n: 0 };
        for (const [obj, name] of [[A.shell.reminders, 'reminders'], [A.settings, 'settings'], [A.i18n, 'i18n']]) {
          const on = obj.on.bind(obj);
          obj.on = (k, fn) => {
            window.__subs[name]++;
            const off = on(k, fn);
            let done = false;
            return () => (done || ((done = true), window.__subs[name]--), off());
          };
        }
        return true;
      });
      const counts = () => ev(() => ({ doc: window.__live_doc.size, win: window.__live_win.size, subs: { ...window.__subs }, todo: document.querySelectorAll('.td').length, pops: document.querySelectorAll('.td-pop, .td-ghost').length }));
      const base = await counts();
      for (let i = 0; i < 15; i++) {
        await ev(() => window.__aurora.registry.launch('todo'));
        await s.page.waitForSelector(`${WIN} .td`, { timeout: 15000 });
        await until(s, (app) => !!app?.store, { label: 'todo ready' });
        if (i % 3 === 0) await TD(s, (app) => (app.go('list:tasks'), app.renderNow(), app.changeTheme(app.list.moreBtn, app.view), true));
        else if (i % 3 === 1) await TD(s, (app) => (app.openTask(app.store.data.tasks[0].id), app.pickDue(app.list.moreBtn, null), true));
        else await TD(s, (app) => (app.nav.search.value = 'x', app.nav.search.dispatchEvent(new Event('input')), true)); // search debounce pending
        await sleep(200);
        await ev(() => (window.__aurora.wm.byApp('todo').forEach((w) => w.close(true)), true));
        await sleep(450);
      }
      const after = await counts();
      check('document listeners back to baseline', after.doc, base.doc);
      check('window listeners back to baseline', after.win, base.win);
      check('reminders / settings / language subscriptions released', after.subs, base.subs);
      check('no To Do DOM or flyout left behind', [after.todo, after.pops], [0, 0]);
      check('no console errors while cycling', todoErrors(s), []);
    });
    // (outside the section so that --only=<name> runs of the other QA sections get a window too)
    await ev(() => window.__aurora.registry.launch('todo'));
    await s.page.waitForSelector(`${WIN} .td`, { timeout: 15000 });
    await until(s, (app) => !!app?.store, { label: 'todo ready' });
    await TD(s, (app) => (app.win.maximize(), true));
    await sleep(500);

    await section('QA: untrusted text (titles, list / group names, steps, notes) is never parsed as HTML', async () => {
      const X = '<img src=x onerror="window.__xss=(window.__xss||0)+1"><b>bold</b>';
      const ids = await TD(
        s,
        (app, X) => {
          window.__xss = 0;
          const l = app.store.addList(`${X} list`);
          app.store.addGroup(`${X} group`);
          const t = app.addTask({ title: X, listId: l.id, note: `${X} note`, steps: [`${X} step`], due: app.today() });
          app.addTask({ title: `${X} 2`, myDay: true });
          app.go(`list:${l.id}`);
          app.renderNow();
          app.openTask(t.id);
          return { list: l.id, task: t.id };
        },
        X,
      );
      await sleep(300);
      await s.page.click(`${rowSel(ids.task)}`, { button: 'right' });
      await sleep(250);
      await s.page.locator('.menu .menu-item', { hasText: 'Move to' }).first().hover();
      await sleep(400);
      const menuHtml = await ev(() => document.querySelectorAll('.menu img, .menu b').length);
      await s.page.keyboard.press('Escape');
      await s.page.keyboard.press('Escape');
      await sleep(200);
      await s.page.hover(`${WIN} .td-nav-item[data-list-id="${ids.list}"]`);
      await sleep(1100);
      const tipHtml = await ev(() => document.querySelectorAll('.tooltip img, .tooltip b').length);
      await TD(s, (app) => (app.deleteTasks([app.openId]), true));
      await s.page.waitForSelector(DLG);
      const dlgHtml = await ev(() => document.querySelectorAll('.dialog img, .dialog b').length);
      await s.page.keyboard.press('Escape');
      await sleep(250);
      await TD(s, (app) => (app.setSearch('img'), app.renderNow(), true));
      await sleep(200);
      await TD(s, (app) => (app.setSearch(''), app.go('myday'), app.toggleSuggestions(true), app.renderNow(), true));
      await sleep(250);
      // a reminder that fires now: the notification shows the title as text
      await TD(s, (app, id) => (app.store.update(id, { remindAt: Date.now() + 1200 }), app.applyReminder(id, { reset: true }), true), ids.task);
      await sleep(3000);
      const r = await ev(() => ({ fired: window.__xss, html: document.querySelectorAll('.win.app-todo .td img, .win.app-todo .td b, #toasts b, #toasts img[src="x"]').length, toast: [...document.querySelectorAll('#toasts *')].some((n) => n.textContent.includes('<img src=x')) }));
      check('no markup in menus, tooltips or dialogs', [menuHtml, tipHtml, dlgHtml], [0, 0, 0]);
      check('payload never executed', r.fired, 0);
      check('no elements created from task / list text', r.html, 0);
      check('notification shows the title as plain text', r.toast, true);
      await TD(s, (app) => (app.toggleSuggestions(false), true));
    });

    await section('QA: a repeating task follows its moved due date (Weekly, Monthly, add bar)', async () => {
      const r = await TD(s, (app) => {
        const sun = '2026-10-11'; // a Sunday
        const w = app.addTask({ title: 'QA weekly', due: sun });
        app.setRepeat(w.id, { kind: 'weekly', freq: 'week', interval: 1, days: [0] });
        app.setDue([w.id], '2026-10-16'); // Friday
        const wRule = app.store.task(w.id).repeat;
        const wNext = app.store.setDone(w.id, true).next;
        const m = app.addTask({ title: 'QA monthly', due: '2026-10-31' });
        app.setRepeat(m.id, { kind: 'monthly', freq: 'month', interval: 1, anchorDay: 31 });
        app.setDue([m.id], '2026-11-15');
        const mNext = app.store.setDone(m.id, true).next;
        const c = app.addTask({ title: 'QA custom 2 months', due: '2026-10-31', repeat: { kind: 'custom', freq: 'month', interval: 2, anchorDay: 31 } });
        app.setDue([c.id], '2026-11-10');
        const cNext = app.store.setDone(c.id, true).next;
        const cw = app.addTask({ title: 'QA custom weekdays', due: '2026-10-12', repeat: { kind: 'custom', freq: 'week', interval: 2, days: [1, 3] } });
        app.setDue([cw.id], '2026-10-14');
        const cwRule = app.store.task(cw.id).repeat;
        // add bar: "Weekly" picked before the due date (the rule is built from today), then the due date
        const a = app.addTask({ title: 'QA add bar', due: '2026-10-15', repeat: { kind: 'weekly', freq: 'week', interval: 1, days: [0] } });
        for (const t of [w, wNext, m, mNext, c, cNext, cw, a]) if (t) app.store.remove(t.id);
        return { wDays: wRule.days, wNext: wNext?.due, mNext: mNext?.due, cNext: cNext?.due, cwDays: cwRule.days, addDays: a.repeat.days };
      });
      check('Weekly moved to a Friday repeats on Fridays', [r.wDays, r.wNext], [[5], '2026-10-23']);
      check('Monthly moved from the 31st to the 15th comes back on the 15th', r.mNext, '2026-12-15');
      check('custom "every 2 months" takes the new day of the month', r.cNext, '2027-01-10');
      check('custom weekdays picked by the user are kept', r.cwDays, [1, 3]);
      check('add bar: Weekly follows the due date picked afterwards', r.addDays, [4]);
    });

    await section('QA: example copies, emoji-only names, double-clicked "New list"', async () => {
      const r = await TD(s, (app) => {
        if (!app.store.hasSeed()) app.settingsView.addExamples();
        const ex = app.store.data.tasks.find((t) => t.seed);
        const target = app.store.addList('QA target');
        const copy = app.store.copy(ex.id, target.id);
        app.store.removeSeed();
        return { copySurvives: !!app.store.task(copy.id), copySeed: !!app.store.task(copy.id)?.seed, target: target.id };
      });
      check('a copy of an example task is the user’s own task', [r.copySurvives, r.copySeed], [true, false]);
      await go(s, 'list:tasks');
      const n0 = await TD(s, (app) => app.store.data.lists.length);
      await s.page.dblclick(`${WIN} .td-newlist`);
      await sleep(500);
      check('double-clicking "New list" creates one list', (await TD(s, (app) => app.store.data.lists.length)) - n0, 1);
      await s.page.keyboard.press('Escape');
      const emoji = await TD(s, (app) => {
        const t = app.addTask({ title: '🎉', listId: 'tasks' });
        app.newListFromTask(t.id);
        const l = app.store.list(app.view.slice(5));
        return [l.emoji, l.name];
      });
      check('a list made from an emoji-only task gets the emoji and the localized default name', emoji, ['🎉', 'Untitled list']);
    });

    await section('QA: keyboard — Tab stays in the window, flyouts trap Tab, F6 cycles panes, Delete / F2 in the nav', async () => {
      await go(s, 'list:tasks');
      const id = await TD(s, (app) => app.addTask({ title: 'QA keyboard', listId: 'tasks' }).id);
      await render(s);
      await TD(s, (app, id) => (app.openTask(id), true), id);
      await sleep(300);
      // last Tab stop -> Tab wraps to the first one (never the taskbar / desktop)
      await TD(s, () => {
        const root = document.querySelector('.win.app-todo .td');
        const stops = [...root.querySelectorAll('button, input, textarea, select, [tabindex]')].filter((x) => !x.disabled && x.tabIndex >= 0 && x.checkVisibility({ checkVisibilityCSS: true, visibilityProperty: true }));
        stops[stops.length - 1].focus();
        window.__firstStop = stops[0];
        window.__lastStop = stops[stops.length - 1];
        return true;
      });
      await s.page.keyboard.press('Tab');
      let r = await ev(() => ({ inWin: !!document.activeElement.closest('.win.app-todo'), first: document.activeElement === window.__firstStop }));
      check('Tab after the last control wraps to the first one', [r.inWin, r.first], [true, true]);
      await s.page.keyboard.press('Shift+Tab');
      r = await ev(() => document.activeElement === window.__lastStop);
      check('Shift+Tab from the first control wraps to the last one', r, true);
      const outside = [];
      for (let i = 0; i < 45; i++) {
        await s.page.keyboard.press('Tab');
        if (!(await ev(() => !!document.activeElement.closest('.win.app-todo')))) outside.push(i);
      }
      check('45 Tabs never leave the window', outside, []);
      // flyout: Tab cycles inside it
      await TD(s, (app) => (app.pickDue(app.list.moreBtn, null), true));
      await s.page.waitForSelector(`${WIN} .td-pop`);
      await sleep(150);
      let escaped = 0;
      for (let i = 0; i < 12; i++) {
        await s.page.keyboard.press('Tab');
        if (!(await ev(() => !!document.activeElement.closest('.td-pop')))) escaped++;
      }
      check('Tab stays inside the date flyout', escaped, 0);
      await s.page.keyboard.press('Escape');
      await sleep(250);
      // F6: list -> details -> navigation -> list
      await TD(s, (app, id) => (app.list.focusRow(id), true), id);
      const panes = [];
      for (let i = 0; i < 3; i++) {
        await s.page.keyboard.press('F6');
        await sleep(80);
        panes.push(await ev(() => (document.activeElement.closest('.td-detail') ? 'detail' : document.activeElement.closest('.td-nav') ? 'nav' : document.activeElement.closest('.td-main') ? 'list' : 'other')));
      }
      check('F6 cycles details -> navigation -> list', panes, ['detail', 'nav', 'list']);
      // Delete / F2 on a list in the navigation pane act on that list, not on the selected task
      const lid = await TD(s, (app, id) => {
        const l = app.store.addList('QA nav list');
        app.go('list:tasks');
        app.renderNow();
        app.select(id);
        app.nav.itemFor(`list:${l.id}`).focus();
        return l.id;
      }, id);
      await s.page.keyboard.press('F2');
      await s.page.waitForSelector(DLG);
      check('F2 on a nav list renames that list', await s.page.inputValue(`${DLG} input`), 'QA nav list');
      await s.page.keyboard.press('Escape');
      await sleep(250);
      await TD(s, (app, lid) => (app.nav.itemFor(`list:${lid}`).focus(), true), lid);
      await s.page.keyboard.press('Delete');
      await s.page.waitForSelector(DLG);
      const txt = await s.page.textContent(DLG);
      check('Delete on a nav list asks to delete the list', txt.includes('QA nav list') && !txt.includes('QA keyboard'), true);
      await dialogButton(s, 'Delete list');
      r = await TD(s, (app, [lid, id]) => ({ list: !!app.store.list(lid), task: !!app.store.task(id) }), [lid, id]);
      check('the list is deleted, the selected task is kept', r, { list: false, task: true });
      await TD(s, (app) => (app.nav.itemFor('important').focus(), true));
      await s.page.keyboard.press('Delete');
      await sleep(300);
      check('Delete on a smart list does nothing', await ev(() => !!document.querySelector('.win.app-todo .dialog-layer:not(.closing)')), false);
      await TD(s, (app) => (app.closeDetail({ focus: false }), true));
    });

    await section('QA: rapid input — Enter spam, double Delete, rapid clicks on a repeating task', async () => {
      await go(s, 'list:tasks');
      const n0 = await TD(s, (app) => app.store.data.tasks.length);
      await TD(s, (app) => (app.list.focusAdd(), true));
      await s.page.keyboard.type('QA spam');
      await Promise.all([1, 2, 3, 4, 5].map(() => s.page.keyboard.press('Enter')));
      await sleep(300);
      check('Enter pressed 5 times adds one task', (await TD(s, (app) => app.store.data.tasks.length)) - n0, 1);
      const id = await TD(s, (app) => app.store.data.tasks.find((t) => t.title === 'QA spam').id);
      await TD(s, (app, id) => (app.renderNow(), app.list.focusRow(id), true), id);
      await s.page.keyboard.press('Delete');
      await s.page.keyboard.press('Delete');
      await sleep(400);
      check('a second Delete does not open a second dialog', await ev(() => document.querySelectorAll('.win.app-todo .dialog-layer:not(.closing)').length), 1);
      await s.page.keyboard.press('Escape');
      await sleep(300);
      const rid = await TD(s, (app) => app.addTask({ title: 'QA rapid repeat', listId: 'tasks', due: app.today(), repeat: { kind: 'daily', freq: 'day', interval: 1 } }).id);
      await render(s);
      const circle = s.page.locator(`${rowSel(rid)} .td-check`);
      await circle.click();
      await circle.click();
      await circle.click();
      await sleep(900);
      const r = await TD(s, (app) => app.store.data.tasks.filter((t) => t.title === 'QA rapid repeat').map((t) => t.done).sort());
      check('three quick clicks: completed once, exactly one next instance', r, [false, true]);
    });

    await section('QA: saving fails (file replaced by a folder), banner, Retry', async () => {
      const file = path.join(s.home, '.config', 'aurora', 'apps', 'todo', 'data.json');
      await TD(s, (app) => app.store.flush().then(() => true));
      fs.rmSync(file, { force: true });
      fs.mkdirSync(file);
      await TD(s, (app) => (app.addTask({ title: 'QA unsaved', listId: 'tasks' }), true));
      await until(s, (app) => !!app.store.saveError, { label: 'save error' });
      await render(s);
      const r = await TD(s, (app) => ({ banner: !!app.list.bannerSlot.querySelector('.infobar.error'), retry: !!app.list.bannerSlot.querySelector('.infobar.error .btn') }));
      check('save error banner with Retry', r, { banner: true, retry: true });
      fs.rmSync(file, { recursive: true, force: true });
      await s.page.click(`${WIN} .td-banner-slot .infobar.error .btn`);
      await until(s, (app) => !app.store.saveError, { label: 'saved again' });
      await render(s);
      check('banner gone after Retry', await TD(s, (app) => !!app.list.bannerSlot.querySelector('.infobar.error')), false);
      check('data written on Retry', JSON.parse(fs.readFileSync(file, 'utf8')).tasks.some((t) => t.title === 'QA unsaved'), true);
    });

    await section('QA: 1280x720 maximized — no overflow, meta separators, option rows', async () => {
      const id = await TD(s, (app) => {
        const l = app.store.addList('📚 A list with a really very long name to check the ellipsis in the rows');
        const t = app.addTask({ title: 'Prepare the quarterly presentation for the steering committee with the consolidated numbers', listId: l.id, due: app.today(), remindAt: Date.now() + 3 * 86400e3, repeat: { kind: 'custom', freq: 'week', interval: 2, days: [1, 2, 3, 4, 5] }, note: 'n', steps: ['a', 'b'], myDay: true, important: true });
        app.go('myday');
        app.renderNow();
        app.openTask(t.id);
        return t.id;
      });
      await sleep(500);
      check('no overflow (1280x720 maximized, My Day + details)', await overflowProbe(s), []);
      const r = await TD(s, (app, id) => {
        const row = app.list.rowEl(id);
        const meta = row.querySelector('.td-row-meta');
        const title = row.querySelector('.td-row-title').getBoundingClientRect();
        const sep = parseFloat(getComputedStyle(meta).getPropertyValue('--td-sep'));
        const listChip = meta.querySelector('.td-meta-list');
        const lines = new Map();
        for (const sp of meta.children) {
          const top = Math.round(sp.getBoundingClientRect().top);
          if (!lines.has(top)) lines.set(top, sp.getBoundingClientRect().left);
        }
        const opts = [...app.detail.el.querySelectorAll('.td-opt-row')].filter((x) => x.querySelector('.td-opt-clear')).map((x) => x.querySelector('.td-opt-label').getBoundingClientRect().right <= x.querySelector('.td-opt-clear').getBoundingClientRect().left + 0.5);
        return {
          aligned: Math.abs(meta.getBoundingClientRect().left + sep - title.left) <= 1,
          clipped: getComputedStyle(meta).clipPath.startsWith('inset'),
          lineStarts: [...lines.values()].every((x) => Math.abs(x - meta.getBoundingClientRect().left) <= 1),
          ellipsis: getComputedStyle(listChip).textOverflow === 'ellipsis' && listChip.scrollWidth > listChip.clientWidth,
          opts,
        };
      }, id);
      check('meta text lines up with the title; the separator strip is clipped', [r.aligned, r.clipped, r.lineStarts], [true, true, true]);
      check('a long list name is cut with an ellipsis', r.ellipsis, true);
      check('option labels stop before their × button', r.opts.length >= 3 && r.opts.every(Boolean), true);
      await shot(s, 'maximized-1280-light-en', { clip: false });
    });

    await section('QA: long steps wrap; Enter does not insert a line break', async () => {
      const id = await TD(s, (app) => {
        const t = app.addTask({ title: 'QA steps', listId: 'tasks', steps: ['A very long step title that has to wrap on several lines in the details pane instead of being cut off'] });
        app.go('list:tasks');
        app.renderNow();
        app.openTask(t.id);
        return t.id;
      });
      await sleep(400);
      const r = await TD(s, (app) => {
        const st = app.detail.el.querySelector('.td-step');
        const input = st.querySelector('.td-step-input');
        const check = st.querySelector('.td-check').getBoundingClientRect();
        return { tag: input.tagName, h: input.getBoundingClientRect().height, wrapped: input.scrollHeight <= input.clientHeight + 1, checkTop: Math.round(check.top - st.getBoundingClientRect().top) };
      });
      check('step editor grows to show the whole title', [r.tag, r.h > 40, r.wrapped], ['TEXTAREA', true, true]);
      check('the circle stays on the first line', r.checkTop <= 8, true);
      await s.page.locator(`${WIN} .td-step-input`).first().click();
      await s.page.keyboard.press('Control+End');
      await s.page.keyboard.type(' x');
      await s.page.keyboard.press('Enter');
      await sleep(200);
      const t = await TD(s, (app, id) => app.store.task(id).steps[0].title, id);
      check('Enter commits the step without a line break', [/\n/.test(t), t.endsWith('cut off x')], [false, true]);
      await TD(s, (app) => (app.closeDetail({ focus: false }), true));
    });

    await section('QA: suggestions are keyboard accessible', async () => {
      const id = await TD(s, (app) => {
        const t = app.addTask({ title: 'QA suggestion', listId: 'tasks', due: app.today() });
        app.go('myday');
        app.toggleSuggestions(true);
        app.renderNow();
        return t.id;
      });
      await sleep(400);
      await s.page.focus(`${WIN} .td-sg-row[data-id="${id}"] .td-sg-main`);
      await s.page.keyboard.press('Enter');
      await sleep(400);
      check('Enter on a suggestion opens its details', await TD(s, (app) => [app.openId === app.store.data.tasks.find((t) => t.title === 'QA suggestion').id, !!document.activeElement.closest('.td-detail')]), [true, true]);
    });

    await section('QA: console', async () => {
      check('no console errors (QA)', todoErrors(s), []);
    });
  } finally {
    current = null;
    await s.close();
  }
}

// ================================================================== launch F: French, dark, 1920x1080 maximized
async function runFrenchWide() {
  const s = await launchShell({ open: ['todo'], lang: 'fr', theme: 'dark', size: '1920x1080' });
  current = s;
  try {
    await s.page.waitForSelector(`${WIN} .td`, { timeout: 20000 });
    await until(s, (app) => !!app?.store, { label: 'todo ready' });
    await section('French 1920x1080: maximized layout, 24-hour times, localized default names', async () => {
      await TD(s, (app) => (app.win.maximize(), true));
      await sleep(500);
      const id = await TD(s, (app) => {
        const l = app.store.addList('📚 Une liste au nom vraiment très très long pour vérifier les points de suspension');
        const g = app.store.addGroup('Un groupe au nom extrêmement long qui ne tient pas');
        app.store.moveListToGroup(l.id, g.id);
        const at = new Date(app.now());
        at.setDate(at.getDate() + 2);
        at.setHours(9, 5, 0, 0);
        const t = app.addTask({ title: 'Préparer la présentation trimestrielle pour le comité de direction avec les chiffres consolidés', listId: l.id, due: app.today(), remindAt: at.getTime(), repeat: { kind: 'custom', freq: 'week', interval: 2, days: [1, 2, 3, 4, 5] }, steps: ['Rassembler les chiffres consolidés de toutes les filiales européennes et asiatiques', 'b'], note: 'x', myDay: true });
        for (let i = 0; i < 12; i++) app.addTask({ title: `${i} Relancer le fournisseur pour la facture en attente`, listId: l.id, due: app.today() });
        app.go(`list:${l.id}`);
        app.renderNow();
        app.openTask(t.id);
        return t.id;
      });
      await sleep(600);
      check('no overflow (1920x1080 maximized, French)', await overflowProbe(s), []);
      const r = await TD(s, (app) => app.detail.el.querySelector('[data-key="remind"] .td-opt-label').textContent);
      check('24-hour reminder time with a two-digit hour', r, 'Me le rappeler à 09:05');
      await shot(s, 'maximized-1920-dark-fr', { clip: false });
      await TD(s, (app) => (app.go('planned'), app.renderNow(), true));
      await sleep(300);
      check('no overflow (Planned, 1920x1080)', await overflowProbe(s), []);
      const names = await TD(s, (app) => {
        const t = app.addTask({ title: '🎉' });
        app.newListFromTask(t.id);
        const l = app.store.list(app.view.slice(5));
        const g = app.newGroup();
        return [l.name, app.store.group(g.id).name];
      });
      await s.page.keyboard.press('Escape');
      check('default names in French', names, ['Liste sans titre', 'Groupe sans titre']);
      check('no console errors (French wide)', todoErrors(s), []);
    });
  } finally {
    current = null;
    await s.close();
  }
}

// ================================================================== launch G: corrupt / unreadable / newer data files
async function runBadData() {
  const mk = (data) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-home-'));
    const dir = path.join(home, '.config', 'aurora', 'apps', 'todo');
    fs.mkdirSync(dir, { recursive: true });
    if (data === 'dir') fs.mkdirSync(path.join(dir, 'data.json'));
    else fs.writeFileSync(path.join(dir, 'data.json'), typeof data === 'string' ? data : JSON.stringify(data));
    return { home, dir };
  };
  // 1. corrupt values: quotes in ids, absurd timestamps
  {
    const { home } = mk({
      version: 2,
      groups: [{ id: 'g"]x', name: 'Bad group' }],
      lists: [{ id: 'l"]y', name: 'Bad list', groupId: 'g"]x' }],
      tasks: [
        { id: 't1', title: 'Huge reminder', remindAt: 1e20, due: '2026-10-12', created: 1e20, completedAt: 'x', myDayAt: -5 },
        { id: 't"]2', title: 'Quote id', listId: 'l"]y', created: -1e20, done: true, completedAt: 9e15 },
      ],
      prefs: { lastView: 'list:l"]y' },
    });
    const s = await launchShell({ open: ['todo'], lang: 'en', theme: 'light', home });
    current = s;
    try {
      await s.page.waitForSelector(`${WIN} .td`, { timeout: 20000 });
      await until(s, (app) => !!app?.store, { label: 'todo ready' });
      await section('corrupt values in the data file: every view still renders', async () => {
        const r = await TD(s, (app) => {
          const errs = [];
          const tryIt = (name, fn) => {
            try {
              fn();
            } catch (e) {
              errs.push(`${name}: ${e.message}`);
            }
          };
          tryIt('lastView', () => app.renderNow());
          for (const v of ['myday', 'planned', 'all', 'completed', 'list:tasks']) tryIt(v, () => (app.go(v), app.renderNow()));
          tryIt('details', () => (app.go('all'), app.renderNow(), app.openTask('t1'), app.renderNow()));
          tryIt('details of the quoted id', () => (app.go('completed'), app.renderNow(), app.openTask('t"]2'), app.renderNow()));
          tryIt('nav focus', () => (app.nav.el.querySelector('.td-group-head').focus(), app.renderNow()));
          return { errs, remindAt: app.store.task('t1').remindAt, created: app.store.task('t1').created > 0, rows: app.list.visibleIds().length };
        });
        check('no exception in any view', r.errs, []);
        check('impossible timestamps dropped or replaced', [r.remindAt, r.created], [null, true]);
        await TD(s, (app) => (app.nav.editGroup('g"]x'), true));
        await sleep(150);
        check('a group with a quote in its id can be renamed', await TD(s, () => !!document.querySelector('.win.app-todo .td-group-edit')), true);
        await s.page.keyboard.press('Escape');
        check('no console errors (corrupt values)', todoErrors(s), []);
      });
    } finally {
      current = null;
      await s.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
  // 2. unreadable file (a folder): read-only, told at start and by a banner that stays (French, dark)
  {
    const { home, dir } = mk('dir');
    const s = await launchShell({ open: ['todo'], lang: 'fr', theme: 'dark', home });
    current = s;
    try {
      await s.page.waitForSelector(`${WIN} .td`, { timeout: 20000 });
      await until(s, (app) => !!app?.store, { label: 'todo ready' });
      await section('unreadable data file: read-only, alert and a lasting banner (French)', async () => {
        await s.page.waitForSelector(DLG, { timeout: 5000 });
        check('user is told at start', (await s.page.textContent(DLG)).includes('Impossible de charger vos tâches'), true);
        await dialogButton(s, 'OK');
        await TD(s, (app) => (app.addTask({ title: 'Pas enregistrée' }), app.renderNow(), true));
        await sleep(400);
        const r = await TD(s, (app) => ({ ro: app.store.readOnly, banner: app.list.bannerSlot.querySelector('.td-readonly-banner')?.textContent || '' }));
        check('read-only banner stays visible', [r.ro, r.banner.startsWith('Les modifications ne sont pas enregistrées')], [true, true]);
        check('nothing written over the unreadable file', fs.statSync(path.join(dir, 'data.json')).isDirectory() && fs.readdirSync(dir).length, 1);
        await shot(s, 'readonly-dark-fr');
        check('no console errors (unreadable)', todoErrors(s), []);
      });
    } finally {
      current = null;
      await s.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
  // 3. data saved by a newer To Do: the original is kept before this version writes its own format
  {
    const original = JSON.stringify({ version: 7, lists: [], tasks: [{ id: 'a', title: 'From the future', fancy: { x: 1 } }], newThing: [1, 2, 3] });
    const { home, dir } = mk(original);
    const s = await launchShell({ open: ['todo'], lang: 'en', theme: 'light', home });
    current = s;
    try {
      await s.page.waitForSelector(`${WIN} .td`, { timeout: 20000 });
      await until(s, (app) => !!app?.store, { label: 'todo ready' });
      await section('data from a newer version: original kept, user told, tasks usable', async () => {
        await s.page.waitForSelector(DLG, { timeout: 5000 });
        check('user is told', (await s.page.textContent(DLG)).includes('newer version'), true);
        await dialogButton(s, 'OK');
        const backup = fs.readdirSync(dir).find((f) => /^data\.v7-\d+\.json$/.test(f));
        check('original file kept byte for byte', backup && fs.readFileSync(path.join(dir, backup), 'utf8'), original);
        const r = await TD(s, (app) => ({ title: app.store.task('a')?.title, fancy: app.store.task('a')?.fancy }));
        check('tasks loaded, unknown fields kept', r, { title: 'From the future', fancy: { x: 1 } });
        check('no console errors (newer data)', todoErrors(s), []);
      });
    } finally {
      current = null;
      await s.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
}

await runEnglish();
await runFrench();
await runMigration();
await runDamaged();
await runQA();
await runFrenchWide();
await runBadData();
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
