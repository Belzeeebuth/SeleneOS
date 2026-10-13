// Printing UI (track "printing"): Paramètres > Appareils > Imprimantes et scanners in dev mode (simulated CUPS from
// main/ipc/printers.js, simulated aurora-admin printer-* actions): printers with state and ink, the queue (cancel own job,
// another user's job through the administrator prompt), discovery and one-click add (driverless), default, pause /
// resume, rename, test page, remove; « L'impression n'est pas installée » without CUPS; printers:print for the print dialog.
// Screenshots 1280x720 FR, Halo dark + light -> test/out/printers-*.png. Parsers, real-mode argv and aurora-admin:
// test/printers.unit.mjs (run first here).
// Usage:  cd aurora-os/shell && xvfb-run -a -s "-screen 0 1600x900x24" node test/printers.test.mjs
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launchShell } from './lib.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
const failures = [];
function check(name, actual, expected) {
  const ok = typeof expected === 'function' ? !!expected(actual) : Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++;
  else failures.push(`${name}\n      expected: ${typeof expected === 'function' ? '(predicate)' : JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}`);
  return ok;
}

const unit = spawnSync(process.execPath, [path.join(ROOT, 'test', 'printers.unit.mjs')], { encoding: 'utf8' });
process.stdout.write(unit.stdout);
check('printers.unit.mjs passes', unit.status, 0);

const inv = (s, ch, ...a) => s.aurora(([c, args]) => window.__aurora.api.invoke(c, ...args), [ch, a]);
async function uac(s) {
  await s.page.waitForSelector('.uac-dialog', { timeout: 8000 });
  const pw = s.page.locator('.uac-dialog input[type=password]');
  if (await pw.count()) await pw.fill('aurora');
  await s.page.locator('.uac-dialog .dialog-footer .btn.primary').click();
  await s.page.waitForSelector('.uac-dialog', { state: 'detached', timeout: 8000 }).catch(() => {});
}
const shots = [];

for (const theme of ['dark', 'light']) {
  console.log(`\n# Imprimantes et scanners — FR, Halo ${theme}, 1280x720`);
  const s = await launchShell({ lang: 'fr', theme, size: '1280x720', env: { AURORA_DEV_PRINTERS: 'office' } });
  const P = s.page;
  try {
    await inv(s, 'printers:devSet', { kind: 'office', fail: false });
    await s.aurora(() => window.__aurora.registry.launch('settings', { page: 'printers' }));
    await P.waitForSelector('.st-prn .st-prn-printer', { timeout: 15000 });
    await P.waitForTimeout(500);
    check(`[${theme}] title « Imprimantes et scanners »`, await P.textContent('.app-settings .st-title'), (v) => /Imprimantes et scanners/.test(v || ''));
    const names = await P.$$eval('.st-prn-printer .st-prn-name', (els) => els.map((e) => e.textContent));
    check(`[${theme}] the two printers, HP marked « Par défaut »`, names, ['HP LaserJet M110wPar défaut', 'Canon PIXMA G3570']);
    const states = await P.$$eval('.st-prn-printer .st-prn-state', (els) => els.map((e) => e.textContent));
    check(`[${theme}] states said simply`, states, ['Prête', 'Prête']);
    check(`[${theme}] ink low shown as a warning after the state`, await P.textContent('.st-prn-printer[data-printer="Canon_PIXMA_G3570"] .st-prn-warn'), ' · encre faible');
    check(`[${theme}] queue: two documents`, await P.$$eval('.st-prn-job .st-row-title', (els) => els.map((e) => e.textContent)), ['Rapport annuel.pdf', 'Facture octobre.pdf']);
    // open the Canon printer: ink levels + actions
    await P.click('.st-prn-printer[data-printer="Canon_PIXMA_G3570"] .st-exp-head');
    await P.waitForSelector('.st-prn-printer[data-printer="Canon_PIXMA_G3570"] .st-prn-ink', { timeout: 5000 });
    const inks = await P.$$eval('.st-prn-printer[data-printer="Canon_PIXMA_G3570"] .st-prn-ink', (els) => els.map((e) => e.textContent));
    check(`[${theme}] ink levels (cartridge names in French)`, inks, ['Noir72 %', 'Cyan45 %', 'Magenta18 %', 'Jaune60 %']);
    check(`[${theme}] actions: test page, default, pause, rename, remove`, await P.$$eval('.st-prn-printer[data-printer="Canon_PIXMA_G3570"] .st-prn-actions .btn', (els) => els.map((e) => e.textContent)), ['Imprimer une page de test', 'Définir par défaut', 'Mettre en pause', 'Renommer', 'Supprimer']);
    shots.push(await s.shot(`printers-page-fr-${theme}`));

    if (theme === 'dark') {
      // test page -> a new job in the queue
      await P.click('.st-prn-printer[data-printer="Canon_PIXMA_G3570"] .st-prn-test');
      await P.waitForSelector('.st-prn-job[data-job="Canon_PIXMA_G3570-14"]', { timeout: 8000 });
      check('test page queued (« Page de test »)', await P.textContent('.st-prn-job[data-job="Canon_PIXMA_G3570-14"] .st-row-title'), 'Page de test');
      // cancel own job: no prompt
      await P.click('.st-prn-job[data-job="Canon_PIXMA_G3570-14"] .st-prn-cancel');
      await P.waitForSelector('.st-prn-job[data-job="Canon_PIXMA_G3570-14"]', { state: 'detached', timeout: 8000 });
      check('own job cancelled without a prompt', await P.locator('.uac-dialog').count(), 0);
      // another user's job: administrator prompt
      await P.click('.st-prn-job[data-job="HP_LaserJet_M110w-13"] .st-prn-cancel');
      await uac(s);
      await P.waitForSelector('.st-prn-job[data-job="HP_LaserJet_M110w-13"]', { state: 'detached', timeout: 8000 });
      check('another user\'s job cancelled after « Autorisation administrateur »', true, true);
      // pause, then resume
      await P.click('.st-prn-printer[data-printer="Canon_PIXMA_G3570"] .st-prn-pause');
      await uac(s);
      await P.waitForFunction(() => document.querySelector('.st-prn-printer[data-printer="Canon_PIXMA_G3570"] .st-prn-state')?.textContent.startsWith('En pause'), null, { timeout: 8000 });
      check('paused: « En pause »', await P.textContent('.st-prn-printer[data-printer="Canon_PIXMA_G3570"] .st-prn-state'), (v) => /^En pause/.test(v));
      shots.push(await s.shot('printers-paused-fr-dark'));
      await P.click('.st-prn-printer[data-printer="Canon_PIXMA_G3570"] .st-prn-resume');
      await uac(s);
      await P.waitForFunction(() => document.querySelector('.st-prn-printer[data-printer="Canon_PIXMA_G3570"] .st-prn-state')?.textContent.startsWith('Prête'), null, { timeout: 8000 });
      check('resumed: « Prête »', true, true);
      // set as default
      await P.click('.st-prn-printer[data-printer="Canon_PIXMA_G3570"] .st-prn-setdefault');
      await uac(s);
      await P.waitForFunction(() => document.querySelector('.st-prn-printer[data-printer="Canon_PIXMA_G3570"] .st-prn-default'), null, { timeout: 8000 });
      check('Canon is now the default printer', (await inv(s, 'printers:list')).default, 'Canon_PIXMA_G3570');
      // rename
      await P.click('.st-prn-printer[data-printer="Canon_PIXMA_G3570"] .st-prn-rename');
      await P.waitForSelector('.dialog input', { timeout: 5000 });
      await P.fill('.dialog input', 'Imprimante du salon');
      await P.locator('.dialog .dialog-footer .btn.primary').click();
      await uac(s);
      await P.waitForFunction(() => document.querySelector('.st-prn-printer[data-printer="Canon_PIXMA_G3570"] .st-prn-name')?.textContent.startsWith('Imprimante du salon'), null, { timeout: 8000 });
      check('renamed: « Imprimante du salon » (queue name kept)', (await inv(s, 'printers:list')).printers.find((p) => p.name === 'Canon_PIXMA_G3570')?.label, 'Imprimante du salon');
    }

    // discovery + one-click add
    await P.click('.st-prn-search');
    await P.waitForSelector('.st-prn-found', { timeout: 8000 });
    const found = await P.$$eval('.st-prn-found .st-row-title', (els) => els.map((e) => e.textContent));
    check(`[${theme}] found: Brother, Epson, Samsung (driver needed); HP (same UUID) and the Canon on ipp-usb (localhost:60000) already added`, found, ['Brother MFC-L2710DW series', 'EPSON ET-2850 Series', 'Samsung ML-1660 Series']);
    check(`[${theme}] the Samsung needs a driver (no « Ajouter » button)`, await P.textContent('.st-prn-found:has-text("Samsung") .st-row-right'), 'Pilote nécessaire');
    shots.push(await s.shot(`printers-add-fr-${theme}`));
    if (theme === 'dark') {
      await P.click('.st-prn-found:has-text("EPSON") .st-prn-addbtn');
      await uac(s);
      await P.waitForSelector('.st-prn-printer[data-printer="EPSON_ET-2850_Series"]', { timeout: 8000 });
      check('Epson added (driverless) and listed', (await inv(s, 'printers:list')).printers.map((p) => p.name), (v) => v.includes('EPSON_ET-2850_Series'));
      check('Epson no longer offered', await P.$$eval('.st-prn-found .st-row-title', (els) => els.map((e) => e.textContent)), (v) => !v.includes('EPSON ET-2850 Series'));
      // a printer that does not answer
      await inv(s, 'printers:devSet', { fail: true, kind: 'office' });
      await P.click('.st-prn-search');
      await P.waitForSelector('.st-prn-found:has-text("Brother")', { timeout: 8000 });
      await P.click('.st-prn-found:has-text("Brother") .st-prn-addbtn');
      await uac(s);
      await P.waitForSelector('.st-prn-error', { timeout: 8000 });
      check('add failure explained simply', await P.textContent('.st-prn-error'), (v) => /n’a pas répondu/.test(v));
      shots.push(await s.shot('printers-adderror-fr-dark'));
      await inv(s, 'printers:devSet', { fail: false, kind: 'office' });
      // remove (confirm dialog)
      await s.aurora(() => window.__aurora.registry.launch('settings', { page: 'printers' }));
      await P.waitForSelector('.st-prn-printer[data-printer="Canon_PIXMA_G3570"]', { timeout: 8000 });
      // the page remembers which printers were open
      check('the open printer stays open after a page change', await P.getAttribute('.st-prn-printer[data-printer="Canon_PIXMA_G3570"] .st-exp-head', 'aria-expanded'), 'true');
      await P.click('.st-prn-printer[data-printer="Canon_PIXMA_G3570"] .st-prn-remove');
      await P.waitForSelector('.dialog .dialog-footer', { timeout: 5000 });
      check('remove asks first', await P.textContent('.dialog'), (v) => /Supprimer Canon PIXMA G3570 \?/.test(v));
      await P.locator('.dialog .dialog-footer .btn.primary, .dialog .dialog-footer .btn.st-danger, .dialog .dialog-footer .btn.danger').first().click();
      await uac(s);
      await P.waitForSelector('.st-prn-printer[data-printer="Canon_PIXMA_G3570"]', { state: 'detached', timeout: 8000 });
      check('Canon removed', (await inv(s, 'printers:list')).printers.map((p) => p.name), ['HP_LaserJet_M110w']);
      // the print dialog's channel
      const doc = path.join(os.tmpdir(), 'aurora-printers-doc.pdf');
      fs.writeFileSync(doc, '%PDF-1.4\n');
      const r = await inv(s, 'printers:print', doc, { printer: 'HP_LaserJet_M110w', copies: 2, pages: '1-3,5', duplex: true, orientation: 'landscape', media: 'A4' });
      check('printers:print -> job id', r.jobId, (v) => /^HP_LaserJet_M110w-\d+$/.test(v));
      check('printers:print -> lp options', await inv(s, 'printers:devLastLp'), ['-d', 'HP_LaserJet_M110w', '-n', '2', '-o', 'page-ranges=1-3,5', '-o', 'sides=two-sided-short-edge', '-o', 'orientation-requested=4', '-o', 'media=A4', '--', doc]);
      const bad = await s.aurora(([d]) => window.__aurora.api.invoke('printers:print', d, { pages: '5-1' }).then(() => 'ok', (e) => e.code || e.message), [doc]);
      check('printers:print rejects a bad page range', bad, (v) => /EINVAL|Invalid page range/.test(v));
      fs.rmSync(doc, { force: true });
    }

    // empty system + CUPS missing
    await inv(s, 'printers:devSet', { kind: 'none' });
    await s.aurora(() => window.__aurora.registry.launch('settings', { page: 'printers' }));
    await P.waitForSelector('.st-prn-empty', { timeout: 8000 });
    await P.waitForTimeout(300);
    check(`[${theme}] no printer yet: « Aucune imprimante pour l’instant »`, await P.textContent('.st-prn-empty'), (v) => /Aucune imprimante pour l’instant/.test(v));
    check(`[${theme}] empty queue`, await P.textContent('.st-prn-queue-empty'), (v) => /Aucun document en attente/.test(v));
    if (theme === 'light') shots.push(await s.shot('printers-empty-fr-light'));
    await inv(s, 'printers:devSet', { kind: 'nocups' });
    await s.aurora(() => window.__aurora.registry.launch('settings', { page: 'bluetooth' }));
    await P.waitForTimeout(300);
    await s.aurora(() => window.__aurora.registry.launch('settings', { page: 'printers' }));
    await P.waitForSelector('.st-prn-nocups', { timeout: 8000 });
    check(`[${theme}] without CUPS: « L’impression n’est pas installée »`, await P.textContent('.st-prn-nocups'), (v) => /L’impression n’est pas installée/.test(v));
    // settings search finds the page
    const hits = await s.aurora(async () => (await import('app://shell/apps/settings/lib/index.js')).searchIndex('ajouter une imprimante', 'fr').map((x) => x.page));
    check(`[${theme}] search « ajouter une imprimante » -> printers`, hits[0], 'printers');
    const errs = s.logs.filter((l) => /\[pageerror\]|\[error\]/.test(l) && !/favicon|ERR_FILE_NOT_FOUND/.test(l));
    check(`[${theme}] no renderer errors`, errs, []);
  } catch (e) {
    failures.push(`[${theme}] exception: ${e.stack || e}`);
    await s.shot(`printers-failure-${theme}`).catch(() => {});
  } finally {
    await s.close();
  }
}

console.log(`\nscreenshots:\n${shots.map((x) => `  ${x}`).join('\n')}`);
console.log(`\nprinters: ${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  FAIL ${f}`);
process.exit(failures.length ? 1 : 0);
