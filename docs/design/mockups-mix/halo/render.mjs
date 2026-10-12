// Renders the Halo mockup at 1600x900.
//   node docs/design/mockups-mix/halo/render.mjs [outDir] [style...]
// Default outDir: this folder. Writes halo-<style>.png (+ halo-icons.png).
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const require = createRequire(resolve(ROOT, '../../../../shell/package.json'));
const { chromium } = require('playwright-core');

const [outArg, ...only] = process.argv.slice(2);
const OUT = outArg ? resolve(outArg) : ROOT;
const shots = [
  ['nocturne', 'compose', 'halo-nocturne.png'],
  ['eclipse', 'compose', 'halo-eclipse.png'],
  ['clairdelune', 'compose', 'halo-clairdelune.png'],
  ['nocturne', 'icons', 'halo-icons.png'],
  ['nocturne', 'desktop', 'halo-nocturne-bureau.png'],
  ['eclipse', 'desktop', 'halo-eclipse-bureau.png'],
  ['clairdelune', 'desktop', 'halo-clairdelune-bureau.png'],
];
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
const base = pathToFileURL(join(ROOT, 'index.html')).href;
for (const [style, view, file] of shots) {
  if (only.length && !only.includes(style) && !only.includes(view)) continue;
  await page.goto(`${base}?style=${style}&view=${view}`);
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([...document.images].map((im) => (im.complete ? 0 : new Promise((r) => { im.onload = im.onerror = r; }))));
  });
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(OUT, file) });
  console.log('wrote', join(OUT, file));
}
await browser.close();
