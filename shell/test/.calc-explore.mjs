// temporary exploration script (deleted before hand-off)
import { launchShell } from './lib.mjs';
const [theme = 'light', lang = 'en', which = 'all'] = process.argv.slice(2);
const s = await launchShell({ open: ['calculator'], lang, theme });
const p = s.page;
const W = () => s.aurora(() => window.__aurora.wm.byApp('calculator')[0].rect());
async function crop(name) {
  await p.waitForTimeout(450);
  const r = await W();
  await p.screenshot({ path: `test/out/${name}.png`, clip: { x: Math.max(0, r.x - 8), y: Math.max(0, r.y - 8), width: Math.min(1600, r.width + 16), height: Math.min(900, r.height + 16) } });
}
const click = (k) => p.click(`.app-calculator [data-key="${k}"]`);
const setSize = (w, h) => s.aurora(([w, h]) => window.__aurora.wm.byApp('calculator')[0].setRect({ width: w, height: h }), [w, h]);
await p.waitForSelector('.app-calculator .ck[data-key="7"]', { timeout: 15000 });
for (const k of ['1', '2', '3', '4', 'decimal', '5', 'add', '6', 'mul']) await click(k);
await crop('cx-std');
if (which === 'all' || which === 'sci') {
  await click('nav'); await p.waitForTimeout(400);
  await p.click('.app-calculator .calc-nav-item[data-mode="scientific"]');
  for (const k of ['2', 'add', '3', 'mul', 'lparen', '4']) await click(k);
  await crop('cx-sci-narrow');
  await setSize(800, 640);
  await crop('cx-sci-wide');
  await click('trig'); await crop('cx-sci-trig');
  await p.keyboard.press('Escape');
  await setSize(340, 560);
}
if (which === 'all' || which === 'prog') {
  await click('nav'); await p.waitForTimeout(400);
  await p.click('.app-calculator .calc-nav-item[data-mode="programmer"]');
  for (const k of ['2', '5', '5']) await click(k);
  await crop('cx-prog');
  await click('kp-bits'); await crop('cx-prog-bits'); await click('kp-full');
}
if (which === 'all' || which === 'conv') {
  await click('nav'); await p.waitForTimeout(400);
  await p.click('.app-calculator .calc-nav-item[data-mode="conv-length"]');
  for (const k of ['1', '0', '0']) await click(k);
  await crop('cx-conv');
  await click('nav'); await p.waitForTimeout(400);
  await p.click('.app-calculator .calc-nav-item[data-mode="date"]');
  await crop('cx-date');
  await p.click('.app-calculator [data-picker="to"]'); await crop('cx-date-cal');
  await p.keyboard.press('Escape');
}
console.log(s.logs.filter((l) => /error|warn|pageerror/i.test(l)).join('\n'));
await s.close();
