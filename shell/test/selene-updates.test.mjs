// Selene self-updates in Paramètres > Mises à jour (docs/UPDATES.md).
//
//   xvfb-run -a -s "-screen 0 1600x900x24" node test/selene-updates.test.mjs
//
// 1. Unit: lib/selene-updates.js (one « Selene x.y.z » entry for aurora-shell / aurora-base / aurora-electron),
//    main/ipc/selene-update.js (version file, restart detection).
// 2. UI (dev fixtures, AURORA_DEV_SELENE_UPDATE=1 adds Selene's packages to the simulated apt updates): the list shows
//    « Selene 1.0.1 » once next to the Ubuntu packages; after « Tout installer » the page offers « Redémarrer la
//    session » (sign out). Screenshots 1280x720 FR, Halo dark + light: shell/test/out/selene-updates-*.png.
// The packaging, the signed repository and the apt fallback are tested by tools/test-selfupdate.sh (root).
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchShell } from './lib.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const require = createRequire(import.meta.url);
let passed = 0;
const failures = [];
function check(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  ok  ${msg}`);
  } else {
    failures.push(msg);
    console.log(`  FAIL ${msg}`);
  }
}

console.log('# unit');
const { groupSelene, upstreamVersion } = await import('../renderer/apps/settings/lib/selene-updates.js');
check(upstreamVersion('1.0.1-331') === '1.0.1' && upstreamVersion('2:44.7.1-1') === '44.7.1' && upstreamVersion('1.0') === '1.0', 'upstreamVersion drops the build number and the epoch');
const rows = [
  { name: 'tzdata', from: '2024a', to: '2024b', security: false },
  { name: 'aurora-base', from: '1.0.0-324', to: '1.0.1-331', security: false },
  { name: 'aurora-electron', from: '44.7.0-1', to: '44.7.1-1', security: true },
  { name: 'aurora-shell', from: '1.0.0-324', to: '1.0.1-331', security: false },
];
let g = groupSelene(rows);
check(g.others.length === 1 && g.others[0].name === 'tzdata', 'Ubuntu packages stay as they are');
check(g.selene && g.selene.version === '1.0.1' && g.selene.from === '1.0.0' && !g.selene.electron && g.selene.packages.length === 3, 'aurora-* become one « Selene 1.0.1 » entry (from 1.0.0)');
check(g.selene.security === true && g.selene.shell === true, 'Selene entry: security flag from Electron, needs a session restart');
g = groupSelene([{ name: 'aurora-electron', from: '44.7.0-1', to: '44.7.1-1', security: true }]);
check(g.selene.electron === true && g.selene.version === '44.7.1', 'Electron-only update: « Selene — Electron 44.7.1 »');
check(groupSelene([]).selene === null && groupSelene(null).others.length === 0, 'no Selene package: no entry');

const sel = require('../main/ipc/selene-update.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'selene-ver-'));
const vf = path.join(tmp, 'selene-version');
fs.writeFileSync(vf, '1.0.0-324\n');
check(sel.readVersion(vf) === '1.0.0-324', 'readVersion reads /opt/aurora/shell/selene-version');
fs.writeFileSync(vf, '$(rm -rf /)\n');
check(sel.readVersion(vf) === null && sel.readVersion(path.join(tmp, 'none')) === null, 'readVersion rejects junk and missing files');
// The real backend: running vs installed version.
{
  const handlers = {};
  const prev = process.env.AURORA_SELENE_VERSION_FILE;
  process.env.AURORA_SELENE_VERSION_FILE = vf;
  fs.writeFileSync(vf, '1.0.0-324\n');
  sel({ DEV: true, handle: (ch, fn) => (handlers[ch] = fn) });
  let st = await handlers['selene:status']();
  check(st.running === '1.0.0-324' && st.installed === '1.0.0-324' && st.restartNeeded === false, 'selene:status: same version, no restart');
  fs.writeFileSync(vf, '1.0.1-331\n');
  st = await handlers['selene:status']();
  check(st.installed === '1.0.1-331' && st.restartNeeded === true, 'selene:status: aurora-shell updated on disk -> restart needed');
  if (prev === undefined) delete process.env.AURORA_SELENE_VERSION_FILE;
  else process.env.AURORA_SELENE_VERSION_FILE = prev;
}
fs.rmSync(tmp, { recursive: true, force: true });

const S = (sel) => `.app-settings ${sel}`;
async function uac(s, password = 'aurora') {
  await s.page.waitForSelector('.uac-dialog', { timeout: 8000 });
  const pw = s.page.locator('.uac-dialog input[type=password]');
  if (await pw.count()) await pw.fill(password);
  await s.page.locator('.uac-dialog .dialog-footer .btn.primary').click();
  await s.page.waitForSelector('.uac-dialog', { state: 'detached', timeout: 8000 }).catch(() => {});
}
async function openUpdate(s) {
  await s.aurora(() => window.__aurora.registry.launch('settings', { page: 'update' }));
  await s.page.waitForSelector(S('.st-page[data-page="update"]'), { timeout: 20000 });
  await sleep(500);
}

async function run(theme) {
  console.log(`\n# Paramètres > Mises à jour — ${theme} / FR`);
  const s = await launchShell({ theme, lang: 'fr', size: '1280x720', env: { AURORA_DEV_SELENE_UPDATE: '1' } });
  try {
    await openUpdate(s);
    await s.page.locator(S('.btn'), { hasText: 'Rechercher des mises à jour' }).first().click();
    await uac(s);
    await s.page.waitForSelector(S('.st-pkg-selene'), { timeout: 15000 });
    await sleep(400);
    const names = await s.aurora(() => [...document.querySelectorAll('.app-settings .st-pkg')].map((e) => e.textContent));
    check(names.length === 6, `5 Ubuntu packages + one Selene entry (${names.length} rows)`);
    const selText = await s.page.locator(S('.st-pkg-selene')).innerText();
    check(/Selene 1\.0\.1/.test(selText) && /depuis 1\.0\.0|1\.0\.0/.test(selText), `the Selene entry reads « Selene 1.0.1 » (${selText.replace(/\s+/g, ' ')})`);
    check(!names.some((t) => /aurora-(shell|base|electron)/.test(t)), 'no aurora-* package names in the list');
    check(/6 mises à jour/.test(await s.page.locator(S('.st-hero-title')).innerText()), 'Selene counts as one update in the title');
    await s.shot(`selene-updates-list-${theme}`);
    await s.page.locator(S('.btn.primary'), { hasText: 'Tout installer' }).click();
    await uac(s);
    await s.page.waitForSelector(S('.st-selene-restart'), { timeout: 20000 });
    await sleep(500);
    const bar = await s.page.locator(S('.st-selene-restart')).innerText();
    check(/Selene a été mise à jour/.test(bar) && /Redémarrer la session/.test(bar), 'after the update: « Selene a été mise à jour » + « Redémarrer la session »');
    await s.shot(`selene-updates-restart-${theme}`);
    // The button signs out (session:logout); stub it so that the test shell stays up.
    const hooked = await s.aurora(() => {
      const sh = window.__aurora?.shell;
      if (!sh) return false;
      window.__seleneLogout = 0;
      sh.logout = async () => {
        window.__seleneLogout++;
      };
      return true;
    });
    if (hooked) {
      await s.page.locator(S('.st-selene-restart .btn'), { hasText: 'Redémarrer la session' }).click();
      await sleep(300);
      check((await s.aurora(() => window.__seleneLogout)) === 1, '« Redémarrer la session » signs out (shell.logout)');
    }
    const errs = s.logs.filter((l) => /^\[(error|pageerror)\]/.test(l) && !/Failed to load resource/.test(l));
    check(errs.length === 0, `no renderer errors${errs.length ? `: ${errs.slice(0, 3).join(' | ')}` : ''}`);
  } finally {
    await s.close();
  }
}

await run('dark');
await run('light');

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
process.exit(0);
