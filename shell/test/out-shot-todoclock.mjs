// scratch screenshot helper (todoclock track) -- not a test
import { launchShell } from './lib.mjs';
const OUTD = '/tmp/claude-0/-home-user-claudeai-test/43a764b0-782a-59d4-b82c-ab1cdd8af354/scratchpad/shots';
const app = process.argv[2] || 'todo';
const combos = (process.argv[3] || 'nocturne:dark,eclipse:light,clairdelune:dark').split(',');
const pages = (process.argv[4] || '').split(',').filter(Boolean);
for (const c of combos) {
  const [style, theme] = c.split(':');
  const s = await launchShell({ open: [app], lang: 'fr', theme, size: '1280x720', settings: { style }, env: { TZ: 'Europe/Paris' } });
  await s.page.waitForTimeout(1200);
  await s.page.evaluate(() => { const el = document.querySelector('.win.app-todo, .win.app-clock'); const a = el?.__todo || el?.__clock; a?.win?.maximize?.(); });
  await s.page.waitForTimeout(600);
  if (!pages.length) await s.page.screenshot({ path: `${OUTD}/${app}-${style}-${theme}.png` });
  if (app === 'clock') await s.page.evaluate(() => { const a = document.querySelector('.win.app-clock').__clock; ['tokyo-jp', 'new-york-city-us', 'kolkata-in'].forEach((id) => a.store.addCity(id)); a.store.addAlarm?.({ hour: 6, minute: 30, days: [], name: '' }); });
  for (const p of pages) {
    if (app === 'clock') await s.page.evaluate((p) => document.querySelector(`.win.app-clock [data-page="${p}"]`)?.click(), p);
    else await s.page.evaluate((p) => document.querySelector(`.win.app-todo [data-view="${p}"]`)?.click(), p);
    await s.page.waitForTimeout(700);
    if (p === 'world') await s.page.evaluate(() => document.querySelectorAll('.win.app-clock *').forEach((e) => { if (e.scrollHeight > e.clientHeight + 20 && getComputedStyle(e).overflowY !== 'visible') e.scrollTop = 9999; }));
    await s.page.waitForTimeout(200);
    await s.page.screenshot({ path: `${OUTD}/${app}-${p.replace(/[^a-z0-9]/gi,'_')}-${style}-${theme}.png` });
  }
  await s.close();
}
console.log('done');
