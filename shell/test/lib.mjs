// Test helpers: launch the real Electron shell (dev mode) and drive it with Playwright.
//
//   import { launchShell } from './lib.mjs';
//   const { app, page, close, shot } = await launchShell({ open: ['calculator'], lang: 'fr', theme: 'dark' });
//   await page.click('text=7');  await shot('calc-fr-dark');   // -> test/out/calc-fr-dark.png
//   await close();
//
// Needs an X display: run under  xvfb-run -a -s "-screen 0 1600x900x24" node test/your-test.mjs
// Each launch uses a throwaway HOME (unless opts.home is given) so tests never touch real data.
import { _electron as electron } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(here, '..');
export const OUT = path.join(here, 'out');

export async function launchShell(opts = {}) {
  const home = opts.home || fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-home-'));
  for (const d of ['Desktop', 'Documents', 'Downloads', 'Pictures', 'Music', 'Videos']) fs.mkdirSync(path.join(home, d), { recursive: true });
  const settingsFile = path.join(home, '.config', 'aurora', 'settings.json');
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  const preset = { ...(opts.settings || {}) };
  if (opts.theme) preset.theme = opts.theme;
  if (opts.lang) preset.lang = opts.lang;
  if (!fs.existsSync(settingsFile) || opts.settings || opts.theme || opts.lang) fs.writeFileSync(settingsFile, JSON.stringify(preset));
  const [w, h] = (opts.size || '1600x900').split('x').map(Number);
  const args = [ROOT, '--dev', '--no-sandbox', `--size=${w}x${h}`, `--mode=${opts.mode || 'shell'}`];
  if (opts.open?.length) args.push(`--open=${opts.open.join(',')}`);
  // extra Electron / Chromium switches, e.g. ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream']
  if (Array.isArray(opts.args)) args.push(...opts.args);
  // Always the X display of xvfb-run: on a developer's Wayland desktop, Electron would otherwise open the shell on the
  // real session (real screen, real clipboard) instead of the throwaway X server.
  args.push('--ozone-platform=x11');
  const baseEnv = { ...process.env };
  for (const k of ['WAYLAND_DISPLAY', 'WAYLAND_SOCKET', 'ELECTRON_OZONE_PLATFORM_HINT']) delete baseEnv[k];
  baseEnv.XDG_SESSION_TYPE = 'x11';
  const app = await electron.launch({
    executablePath: require('electron'),
    args,
    env: { ...baseEnv, HOME: home, AURORA_LIVE: opts.live ? '1' : '0', LANG: opts.lang === 'fr' ? 'fr_FR.UTF-8' : 'en_US.UTF-8', ...(opts.env || {}) },
    timeout: 60000,
  });
  const page = await app.firstWindow();
  const logs = [];
  page.on('console', (m) => {
    logs.push(`[${m.type()}] ${m.text()}`);
    if (opts.verbose || m.type() === 'error') console.log(`[renderer:${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', (e) => {
    logs.push(`[pageerror] ${e.message}`);
    console.log(`[pageerror] ${e.stack || e.message}`);
  });
  await page.setViewportSize?.({ width: w, height: h }).catch(() => {});
  if (opts.mode !== 'greeter') await page.waitForSelector('body.ready', { timeout: 60000 });
  else await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(opts.settle ?? 800);
  fs.mkdirSync(OUT, { recursive: true });
  return {
    app,
    page,
    home,
    logs,
    async shot(name) {
      const file = path.join(OUT, `${name}.png`);
      await page.screenshot({ path: file });
      return file;
    },
    // Evaluate inside the shell with access to window.__aurora (wm, registry, shell, settings…)
    aurora(fn, arg) {
      return page.evaluate(fn, arg);
    },
    async close() {
      await app.close().catch(() => {});
      if (!opts.home && !opts.keepHome) fs.rmSync(home, { recursive: true, force: true });
    },
  };
}
