// Core ui.dialog lifecycle: a dialog whose window closes must settle (null, like Esc) and stop
// handling keys, otherwise Tab and Esc stay captured for every other app.
// Run: cd aurora-os/shell && xvfb-run -a -s "-screen 0 1600x900x24" node test/core-dialogs.test.mjs
import { launchShell } from './lib.mjs';

let passed = 0;
const failures = [];
const check = (name, got, want) => {
  const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
  if (ok) passed++;
  else failures.push(`${name}: got ${JSON.stringify(got)}, want ${typeof want === 'function' ? 'predicate' : JSON.stringify(want)}`);
  console.log(`  ${ok ? '✓' : '✗'} ${name}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const s = await launchShell({ open: ['notepad', 'calculator'] });
const errors = [];
s.page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
try {
  await s.page.waitForFunction(() => window.__aurora?.wm?.list().length >= 2, null, { timeout: 30000 });

  console.log('Dialog of a window that closes');
  await s.aurora(() => {
    const { wm, ui } = window.__aurora;
    const win = wm.list().find((w) => w.appId === 'notepad');
    window.__dlgResult = 'pending';
    ui.dialog({ title: 'Probe', body: 'probe', parent: win, buttons: [{ label: 'OK', value: 'ok', primary: true }] }).then((v) => (window.__dlgResult = v));
  });
  await sleep(300);
  check('dialog is open', await s.page.evaluate(() => document.querySelectorAll('.dialog-layer:not(.closing)').length), 1);
  await s.aurora(() => window.__aurora.wm.list().find((w) => w.appId === 'notepad').close(true));
  await sleep(600);
  check('closing its window settles the dialog with null', await s.page.evaluate(() => window.__dlgResult), null);

  // A stale handler would move focus into the removed dialog on Tab (focus lands on <body>).
  await s.aurora(() => window.__aurora.wm.list().find((w) => w.appId === 'calculator').focus());
  await sleep(200);
  await s.page.keyboard.press('Tab');
  await sleep(150);
  await s.page.keyboard.press('Tab');
  await sleep(150);
  check('Tab keeps focus inside the remaining window', await s.page.evaluate(() => !!document.activeElement?.closest('.win.app-calculator')), true);

  console.log('Dialog whose window element is removed without a close event');
  await s.aurora(() => {
    const { wm, ui } = window.__aurora;
    const win = wm.list().find((w) => w.appId === 'calculator');
    window.__dlgResult2 = 'pending';
    ui.dialog({ title: 'Probe 2', body: 'probe', parent: win }).then((v) => (window.__dlgResult2 = v));
  });
  await sleep(300);
  await s.page.evaluate(() => document.querySelector('.win.app-calculator .dialog-layer')?.remove());
  await s.page.keyboard.press('Shift');
  await sleep(300);
  check('a detached dialog settles on the next key press', await s.page.evaluate(() => window.__dlgResult2), null);

  console.log('Normal dialogs still work');
  await s.aurora(() => {
    const { ui } = window.__aurora;
    window.__dlgResult3 = 'pending';
    ui.dialog({ title: 'Probe 3', body: 'probe', buttons: [{ label: 'OK', value: 'ok', primary: true }] }).then((v) => (window.__dlgResult3 = v));
  });
  await sleep(300);
  await s.page.keyboard.press('Enter');
  await sleep(300);
  check('Enter picks the primary button', await s.page.evaluate(() => window.__dlgResult3), 'ok');

  console.log('File dialog in a 720p-sized window');
  await s.aurora(() => window.__aurora.shell.launch('notepad'));
  await s.page.waitForFunction(() => window.__aurora.wm.list().some((w) => w.appId === 'notepad'), null, { timeout: 15000 });
  await sleep(800);
  await s.aurora(() => {
    const { wm, ui } = window.__aurora;
    const win = wm.list().find((w) => w.appId === 'notepad');
    win.setSize(960, 600);
    win.center?.();
    window.__fpResult = 'pending';
    ui.filePicker({ mode: 'save', parent: win }).then((v) => (window.__fpResult = v));
  });
  await s.page.waitForSelector('.fp-dialog', { timeout: 8000 });
  await sleep(600);
  const fit = await s.page.evaluate(() => {
    const d = document.querySelector('.fp-dialog');
    const w = d.closest('.win').getBoundingClientRect();
    const r = d.getBoundingClientRect();
    const body = d.querySelector('.dialog-body');
    return {
      inside: r.top >= w.top + 8 && r.bottom <= w.bottom - 8 && r.left >= w.left && r.right <= w.right,
      bodyScrolls: body.scrollHeight > body.clientHeight + 1 || body.scrollWidth > body.clientWidth + 1,
      titleShown: d.querySelector('.dialog-title').getBoundingClientRect().top >= r.top,
      cut: [...d.querySelectorAll('.fp-side .nav-item .ellipsis')].filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.textContent),
      listScrolls: getComputedStyle(d.querySelector('.fp-list')).overflowY,
    };
  });
  check('the file dialog fits its window (margin kept)', fit.inside, true);
  check('the dialog body never scrolls (the lists do)', [fit.bodyScrolls, fit.listScrolls], [false, 'auto']);
  check('the title stays in view', fit.titleShown, true);
  check('the places are not cut (Home, Downloads…)', fit.cut, []);
  await s.page.keyboard.press('Escape');
  await sleep(400);
  check('Esc cancels the file dialog', await s.page.evaluate(() => window.__fpResult), null);
  check('no console errors', errors, []);
} catch (err) {
  failures.push(`threw ${err.stack || err}`);
} finally {
  await s.close();
}
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(`\nFailures:\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
