// critic one-off: Lanceur search shots (Halo dark + light, FR) — deleted after use
import { launchShell } from './lib.mjs';
const OUTDIR = process.argv[2];
for (const theme of ['dark', 'light']) {
  const s = await launchShell({ lang: 'fr', theme, size: '1280x720' });
  try {
    await s.aurora(() => window.__aurora.shell.emit('start:open'));
    await s.page.waitForSelector('#start .start-search', { timeout: 10000 });
    await s.page.fill('#start .start-search', 'enregistr');
    await s.page.waitForTimeout(900);
    await s.page.screenshot({ path: `${OUTDIR}/lanceur-search-${theme}.png` });
    await s.page.fill('#start .start-search', 'capture');
    await s.page.waitForTimeout(900);
    await s.page.screenshot({ path: `${OUTDIR}/lanceur-capture-${theme}.png` });
    const txt = await s.page.evaluate(() => document.querySelector('#start').innerText.slice(0, 600));
    console.log(theme, JSON.stringify(txt));
  } finally {
    await s.close();
  }
}
