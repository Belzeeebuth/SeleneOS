// critic one-off: last-recording card after the CSS fix (Halo dark + light, FR) — deleted after use
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { launchShell } from './lib.mjs';
const OUTDIR = process.argv[2];
for (const theme of ['dark', 'light']) {
  const s = await launchShell({ open: ['screenrec'], lang: 'fr', theme, size: '1280x720' });
  try {
    const dir = `${s.home}/Videos/Enregistrements d'écran`;
    fs.mkdirSync(dir, { recursive: true });
    const f = `${dir}/Enregistrement d'écran 2026-10-13 17.01.05.webm`;
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=10', '-t', '2', '-c:v', 'libvpx', f]);
    await s.page.waitForSelector('.win.app-screenrec.sr-ready .sr-start', { timeout: 10000 });
    await s.page.evaluate((p) => {
      const app = document.querySelector('.win.app-screenrec').__screenrec.app;
      app.last = { path: p, size: 275000, duration: 4, format: 'webm' };
      app.renderLast();
    }, f);
    await s.page.waitForTimeout(800);
    await s.page.screenshot({ path: `${OUTDIR}/card-${theme}.png` });
  } finally {
    await s.close();
  }
}
