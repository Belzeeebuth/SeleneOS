// Renders the Nocturne mockup views to PNG (1600x900, scale 1).
// Run from anywhere: node docs/design/mockups/nocturne/render.mjs
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const require = createRequire(resolve(ROOT, '../../../../shell/package.json'));
const { chromium } = require('playwright-core');

const shots = [
  ['desktop', 'dark', 'nocturne-desktop-dark.png'],
  ['launcher', 'dark', 'nocturne-launcher-dark.png'],
  ['panel', 'dark', 'nocturne-panel-dark.png'],
  ['desktop', 'light', 'nocturne-desktop-light.png'],
  ['icons', 'dark', 'nocturne-icons.png'],
];
const only = process.argv.slice(2);

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
const base = pathToFileURL(join(ROOT, 'index.html')).href;
for (const [view, mode, file] of shots) {
  if (only.length && !only.includes(view + '-' + mode) && !only.includes(view)) continue;
  await page.goto(`${base}?view=${view}&mode=${mode}`);
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([...document.images].map((im) => im.complete ? 0 : new Promise((r) => { im.onload = im.onerror = r; })));
  });
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(ROOT, file) });
  console.log('wrote', file);
}
await browser.close();
