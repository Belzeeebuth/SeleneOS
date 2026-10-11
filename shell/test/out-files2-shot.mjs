// temp screenshot helper for files2 track (scratch)
import { launchShell } from './lib.mjs';
import fs from 'node:fs';
import path from 'node:path';
const OUTD = process.env.SHOTDIR;
const combos = (process.env.COMBOS || 'nocturne:dark:1600x900').split(',');
for (const c of combos) {
  const [style, theme, size] = c.split(':');
  const s = await launchShell({ lang: process.env.LANG2 || 'fr', theme, size, settings: { style } });
  const { page, home } = s;
  fs.writeFileSync(path.join(home, 'Documents', 'Budget 2026.ods'), 'x'.repeat(4000));
  fs.writeFileSync(path.join(home, 'Documents', 'Notes.md'), '# hi');
  fs.writeFileSync(path.join(home, 'Documents', 'Rapport.pdf'), 'x'.repeat(200000));
  fs.mkdirSync(path.join(home, 'Documents', 'Projets'));
  fs.mkdirSync(path.join(home, 'Documents', 'Factures'));
  await page.evaluate(() => window.__aurora.shell.launch ? window.__aurora.shell.launch('files') : null).catch(e => console.log(e.message));
  await page.waitForTimeout(1500);
  await s.page.screenshot({ path: path.join(OUTD, `${style}-${theme}-${size}-home.png`) });
  if (process.env.DOCS) {
    await page.keyboard.press('Control+l');
    await page.keyboard.type(path.join(home, 'Documents'));
    await page.keyboard.press('Enter');
    await page.waitForTimeout(800);
    const row = page.locator('.fx-item, [data-name]').filter({ hasText: 'Notes.md' }).first();
    await row.click().catch(()=>{});
    await page.waitForTimeout(300);
    await s.page.screenshot({ path: path.join(OUTD, `${style}-${theme}-${size}-docs.png`) });
  }
  await s.close();
}
