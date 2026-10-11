// Renders the "Clair de lune" mockup views to PNG (1600x900, DPR 1).
// Usage: node render.mjs   (from any directory)
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, '../../../../shell/package.json'));
const { chromium } = require('playwright-core');

const ID = 'clairdelune';
const shots = [
  ['desktop', 'dark', `${ID}-desktop-dark.png`],
  ['launcher', 'dark', `${ID}-launcher-dark.png`],
  ['panel', 'dark', `${ID}-panel-dark.png`],
  ['desktop', 'light', `${ID}-desktop-light.png`],
  ['icons', 'dark', `${ID}-icons.png`],
  ...(process.argv.includes('--extra') ? [['launcher', 'light', `${ID}-launcher-light.png`], ['panel', 'light', `${ID}-panel-light.png`]] : []),
];

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
for (const [view, mode, out] of shots) {
  const url = `${pathToFileURL(join(here, 'index.html')).href}?view=${view}&mode=${mode}`;
  await page.goto(url, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(here, out) });
  console.log('wrote', out);
}
await browser.close();
