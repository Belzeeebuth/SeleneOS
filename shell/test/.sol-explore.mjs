import { launchShell } from './lib.mjs';
const s = await launchShell({ open: ['solitaire'], lang: 'en', theme: 'light' });
const T = (fn, ...a) => s.page.evaluate(([f, a2]) => { const w = window.__aurora.wm.byApp('solitaire')[0]; return window.__aurora.registry.instance(w.id).hooks.test[f](...a2); }, [fn, a]);
await s.page.waitForSelector('.app-solitaire .sol-card');
await s.page.waitForTimeout(1800);
// mid-deal
await s.page.evaluate(() => { const w = window.__aurora.wm.byApp('solitaire')[0]; const h = window.__aurora.registry.instance(w.id).hooks.test; h.deal(99, { animate: true }); });
await s.page.waitForTimeout(420);
await s.shot('sol-frame-deal');
await s.page.waitForTimeout(1500);
// flip mid-draw
const st = await T('pileRect', 'stock');
await s.page.mouse.click(st.x + 30, st.y + 30);
await s.page.waitForTimeout(130);
await s.shot('sol-frame-flip');
await s.page.waitForTimeout(600);
// drag lift
await T('load', { t: [['9S', '8H', '7C'], ['10H'], [], [], [], [], []], waste: ['6D'], f: [['AS', '2S', '3S']] });
const r = await T('cardRect', '9S');
await s.page.mouse.move(r.x + 40, r.y + 15);
await s.page.mouse.down();
await s.page.mouse.move(r.x + 120, r.y + 60, { steps: 8 });
await s.page.waitForTimeout(100);
await s.shot('sol-frame-drag');
const t1 = await T('pileRect', 't1');
await s.page.mouse.move(t1.x + 40, t1.y + 60, { steps: 8 });
await s.page.waitForTimeout(100);
await s.shot('sol-frame-drag-over');
await s.page.mouse.up();
await s.page.waitForTimeout(500);
console.log(JSON.stringify((await T('state')).t.slice(0, 2)));
await s.shot('sol-frame-dropped');
const errs = s.logs.filter((l) => l.startsWith('[error]') || l.startsWith('[pageerror]') || l.startsWith('[warning]'));
console.log(errs.join('\n'));
await s.close();
