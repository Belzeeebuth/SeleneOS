// Renders the Éclipse mockup views to PNG (1600x900, DSF 1).
// Run from anywhere: node docs/design/mockups/eclipse/render.mjs
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, '../../../../shell/package.json'));
const { chromium } = require('playwright-core');

const shots = [
  ['desktop', 'dark', 'eclipse-desktop-dark.png'],
  ['launcher', 'dark', 'eclipse-launcher-dark.png'],
  ['panel', 'dark', 'eclipse-panel-dark.png'],
  ['desktop', 'light', 'eclipse-desktop-light.png'],
  ['icons', 'dark', 'eclipse-icons.png'],
];
const only = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
const base = pathToFileURL(join(here, 'index.html')).href;
for (const [view, mode, file] of shots) {
  if (only.length && !only.some((o) => file.includes(o))) continue;
  await page.goto(`${base}?view=${view}&mode=${mode}`);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(here, file) });
  console.log('wrote', file);
}
await browser.close();
