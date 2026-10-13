// Print dialog tests (core/print.js + main/ipc/print.js) in the apps that print: Éditeur de texte, Lecteur PDF,
// Photos, Navigateur, Notes. The printing backend ('printers:list' / 'printers:print') is faked in the page
// (api.invoke is wrapped): no CUPS, no printer, no real job. What reaches 'printers:print' is checked: the PDF
// exists, holds the document's text, and the options (copies, sides, media) are the ones chosen.
// Usage:  cd aurora-os/shell && xvfb-run -a -s "-screen 0 1600x900x24" node test/print.test.mjs [--only=notepad]
// Screenshots: test/out/print-*.png (1280x720, French, Halo, dark and light).
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { launchShell } from './lib.mjs';

const only = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7).toLowerCase();
let passed = 0;
const failures = [];
function check(name, actual, expected) {
  const ok = typeof expected === 'function' ? !!expected(actual) : Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++;
  else failures.push(`${name}\n      expected: ${typeof expected === 'function' ? '(predicate)' : JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
  return ok;
}
async function section(name, fn) {
  if (only && !name.toLowerCase().includes(only)) return;
  const t0 = Date.now();
  const before = failures.length;
  try {
    await fn();
    console.log(`  ${failures.length === before ? '✓' : '✗'} ${name} (${Date.now() - t0} ms)`);
  } catch (err) {
    failures.push(`${name}: threw ${err?.stack || err}`);
    console.log(`  ✗ ${name}: ${err?.message || err}`);
  }
}
async function until(fn, { timeout = 15000, label = 'condition' } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timeout: ${label}`);
}
const pdfText = (f) => {
  try {
    return execFileSync('pdftotext', ['-layout', f, '-'], { encoding: 'utf8' });
  } catch {
    return '';
  }
};
const pdfPages = (f) => Number((/Pages:\s+(\d+)/.exec(execFileSync('pdfinfo', [f], { encoding: 'utf8' })) || [])[1] || 0);
const pdfSize = (f) => (/Page size:\s+([\d.]+) x ([\d.]+)/.exec(execFileSync('pdfinfo', [f], { encoding: 'utf8' })) || []).slice(1).map(Number);

// The fake printing backend. printers = null restores the real invoke (no 'printers:*' handler: ENOHANDLER).
async function fakePrinters(s, printers, { fail = null } = {}) {
  await s.page.evaluate(
    async ([printers, fail]) => {
      const { api } = await import('app://shell/core/api.js');
      if (!api.__origInvoke) api.__origInvoke = api.invoke;
      const orig = api.__origInvoke;
      window.__printJobs = [];
      api.invoke =
        printers === null
          ? orig
          : async (ch, ...a) => {
              if (ch === 'printers:list') return printers;
              if (ch === 'printers:print') {
                if (fail) throw Object.assign(new Error(fail), { code: 'EFAIL' });
                window.__printJobs.push({ file: a[0], ...a[1] });
                return { jobId: `${a[1]?.printer}-${41 + window.__printJobs.length}` };
              }
              return orig(ch, ...a);
            };
    },
    [printers, fail],
  );
}
const PRINTERS = [
  { name: 'Bureau', info: 'Brother HL-L2350DW (bureau)', isDefault: true, state: 'idle' },
  { name: 'Salon', info: 'HP DeskJet 2700', state: 'idle' },
];
const jobs = (s) => s.page.evaluate(() => window.__printJobs || []);
const lastJob = async (s) => (await jobs(s)).at(-1) || {};
const dialogOpen = (s) => s.page.evaluate(() => !!document.querySelector('.pd-dialog'));
async function waitDialog(s) {
  await until(() => s.page.evaluate(() => !!document.querySelector('.pd-dialog .pd-thumb canvas')), { label: 'print preview', timeout: 20000 });
  await s.page.waitForTimeout(250);
}
async function waitClosed(s) {
  await until(async () => !(await dialogOpen(s)), { label: 'dialog closed' });
}
const D = (s, fn, arg) => s.page.evaluate(`(() => { const dlg = document.querySelector('.pd-dialog'); return (${fn.toString()})(dlg, ${JSON.stringify(arg ?? null)}); })()`);
async function savePicker(s, file) {
  await until(() => s.page.evaluate(() => !!document.querySelector('.fp-dialog')), { label: 'save picker' });
  await s.page.waitForTimeout(150);
  await s.page.fill('.fp-dialog .fp-bottom input', file);
  await s.page.click('.fp-dialog .dialog-footer .btn.primary');
  await s.page.waitForTimeout(300);
  if (process.env.PRINT_DEBUG) await s.shot('print-debug-after-save');
}

const TEXT_LINES = ['Liste de courses pour samedi', 'Pain, beurre, confiture', 'Une ligne très longue qui doit revenir à la ligne sur le papier au lieu d’être coupée au bord de la page, comme dans l’éditeur.'];

let s = null;
let home = null;
try {
  // ================================================================ dark, French
  s = await launchShell({ open: ['notepad'], lang: 'fr', theme: 'dark', size: '1280x720' });
  home = s.home;
  await until(() => s.page.evaluate(() => !!document.querySelector('.win.app-notepad textarea')), { label: 'notepad' });

  await section('notepad: Ctrl+P opens the dialog with printers, A4, live preview', async () => {
    await fakePrinters(s, PRINTERS);
    await s.page.click('.win.app-notepad textarea');
    await s.page.keyboard.type(TEXT_LINES.join('\n'), { delay: 1 });
    await s.page.keyboard.press('Control+p');
    await waitDialog(s);
    const info = await D(s, (dlg) => ({
      title: dlg.querySelector('.dialog-title')?.textContent,
      printers: [...dlg.querySelectorAll('.pd-printer option')].map((o) => o.textContent),
      target: dlg.querySelector('.pd-printer').value,
      paper: dlg.querySelector('.pd-paper').value,
      copiesShown: !dlg.querySelector('.pd-copies').closest('.pd-row').hidden,
      go: dlg.querySelector('.pd-go').textContent,
      pages: dlg.querySelector('.pd-pageinfo').textContent,
      thumbW: dlg.querySelector('.pd-thumb canvas').getBoundingClientRect().width,
    }));
    check('dialog title', info.title, 'Imprimer');
    check('printers + Enregistrer en PDF', info.printers, ['Brother HL-L2350DW (bureau)', 'HP DeskJet 2700', 'Enregistrer en PDF']);
    check('default printer selected', info.target, 'Bureau');
    check('A4 in French', info.paper, 'A4');
    check('copies shown for a printer', info.copiesShown, true);
    check('primary button', info.go, 'Imprimer');
    check('page count', info.pages, '1 page');
    check('thumbnail drawn', info.thumbW, (w) => w > 150);
    await s.shot('print-notepad-fr-dark');
  });

  await section('notepad: range validation, copies, recto verso, print job', async () => {
    await s.page.click('.pd-dialog .pd-pages button:nth-child(2)');
    await s.page.waitForTimeout(100);
    await s.page.keyboard.type('3-1', { delay: 5 });
    const bad = await D(s, (dlg) => ({ hint: dlg.querySelector('.pd-hint').textContent, disabled: dlg.querySelector('.pd-go').disabled }));
    check('reversed range refused', bad, { hint: 'Une plage va de la plus petite page à la plus grande.', disabled: true });
    await s.page.fill('.pd-dialog .pd-range', '2');
    const past = await D(s, (dlg) => dlg.querySelector('.pd-hint').textContent);
    check('page past the end refused', past, 'Le document n’a qu’une page.');
    await s.shot('print-notepad-range-error');
    await s.page.fill('.pd-dialog .pd-range', '1');
    await s.page.click('.pd-dialog .pd-plus');
    await s.page.click('.pd-dialog .pd-duplex');
    await s.page.click('.pd-dialog .pd-go');
    await waitClosed(s);
    const j = await jobs(s);
    check('one job', j.length, 1);
    const job = j[0] || {};
    check('job options', { printer: job.printer, title: job.title, copies: job.copies, sides: job.sides, orientation: job.orientation, media: job.media }, {
      printer: 'Bureau',
      title: 'Sans titre',
      copies: 2,
      sides: 'two-sided-long-edge',
      orientation: 'portrait',
      media: 'A4',
    });
    check('job file is a PDF', fs.existsSync(job.file) && fs.readFileSync(job.file).subarray(0, 5).toString(), '%PDF-');
    const txt = pdfText(job.file);
    check('PDF holds the text', txt.includes('Liste de courses pour samedi') && txt.includes('Pain, beurre'), true);
    check('long line wrapped (not cut)', /coupée au bord/.test(txt), true);
    check('A4 page', pdfSize(job.file), ([w, h]) => Math.abs(w - 595) < 3 && Math.abs(h - 842) < 3);
    check('spool folder private', (fs.statSync(path.dirname(job.file)).mode & 0o777).toString(8), '700');
    const notes = await s.page.evaluate(() => [...document.querySelectorAll('.toast, .notification, .notif')].map((n) => n.textContent).join(' | '));
    check('notification', notes, (x) => /envoyé à l’imprimante/.test(x));
  });

  await section('notepad: « … » menu item, Enregistrer en PDF, landscape', async () => {
    await s.page.click('.win.app-notepad textarea');
    // the « … » menu entry
    const moreBtn = await s.page.$('.win.app-notepad [aria-label^="Plus"]');
    await moreBtn.click();
    await until(() => s.page.evaluate(() => !!document.querySelector('.np-menu [data-id="print"]')), { label: 'menu item' });
    const label = await s.page.evaluate(() => document.querySelector('.np-menu [data-id="print"] .label').textContent);
    check('menu label', label, 'Imprimer…');
    await s.page.click('.np-menu [data-id="print"]');
    await waitDialog(s);
    await D(s, (dlg) => {
      const sel = dlg.querySelector('.pd-printer');
      sel.value = '__pdf__';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const st = await D(s, (dlg) => ({ go: dlg.querySelector('.pd-go').textContent, copies: dlg.querySelector('.pd-copies').closest('.pd-row').hidden, duplex: dlg.querySelector('.pd-duplex').closest('.pd-row').hidden }));
    check('PDF target: Enregistrer, no copies / duplex', st, { go: 'Enregistrer', copies: true, duplex: true });
    await s.page.click('.pd-dialog .pd-orient button:nth-child(2)');
    await until(() => D(s, (dlg) => dlg.querySelector('.pd-thumb').classList.contains('landscape') && !dlg.querySelector('.pd-thumb').classList.contains('loading')), { label: 'landscape preview' });
    await s.shot('print-notepad-pdf-landscape');
    await s.page.click('.pd-dialog .pd-go');
    const dest = path.join(home, 'Documents', 'courses.pdf');
    await savePicker(s, dest);
    await waitClosed(s);
    await until(() => fs.existsSync(dest), { label: 'saved PDF' });
    check('saved PDF text', pdfText(dest).includes('Liste de courses'), true);
    check('landscape A4', pdfSize(dest), ([w, h]) => Math.abs(w - 842) < 3 && Math.abs(h - 595) < 3);
    check('no printer job', (await jobs(s)).length, 1);
  });

  await section('no printer: « Enregistrer en PDF » is the default', async () => {
    await fakePrinters(s, { available: true, printers: [] });
    await s.page.click('.win.app-notepad textarea');
    await s.page.keyboard.press('Control+p');
    await waitDialog(s);
    const st = await D(s, (dlg) => ({ target: dlg.querySelector('.pd-printer').value, note: dlg.querySelector('.pd-note')?.textContent || '' }));
    check('PDF by default', st.target, '__pdf__');
    check('note about adding a printer', st.note, (x) => /Aucune imprimante/.test(x));
    await s.shot('print-noprinter-fr-dark');
    await s.page.keyboard.press('Escape');
    await waitClosed(s);
  });

  await section('printer error stays in the dialog', async () => {
    await fakePrinters(s, PRINTERS, { fail: 'The printer is not responding' });
    await s.page.click('.win.app-notepad textarea');
    await s.page.keyboard.press('Control+p');
    await waitDialog(s);
    await s.page.click('.pd-dialog .pd-go');
    await until(() => D(s, (dlg) => dlg && !dlg.querySelector('.pd-error').hidden), { label: 'error shown' });
    const err = await D(s, (dlg) => dlg.querySelector('.pd-error').textContent);
    check('error text', err, (x) => x.startsWith('L’impression n’a pas abouti') && x.includes('not responding'));
    check('dialog still open', await dialogOpen(s), true);
    await s.page.keyboard.press('Escape');
    await waitClosed(s);
  });

  // ---------------------------------------------------------------- PDF reader
  await section('pdf reader: prints the file itself, a range of pages', async () => {
    await fakePrinters(s, PRINTERS);
    if (!fs.existsSync(path.join(home, 'Documents', 'courses.pdf'))) {
      // run alone (--only=pdf): make the one-page PDF first
      await s.page.click('.win.app-notepad textarea');
      await s.page.keyboard.type(TEXT_LINES.join('\n'), { delay: 1 });
      await s.page.keyboard.press('Control+p');
      await waitDialog(s);
      await D(s, (dlg) => {
        const sel = dlg.querySelector('.pd-printer');
        sel.value = '__pdf__';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await s.page.click('.pd-dialog .pd-go');
      await savePicker(s, path.join(home, 'Documents', 'courses.pdf'));
      await waitClosed(s);
    }
    const one = path.join(home, 'Documents', 'courses.pdf');
    const three = path.join(home, 'Documents', 'trois-pages.pdf');
    execFileSync('pdfunite', [one, one, one, three]);
    await s.aurora((p) => window.__aurora.registry.launch('pdf', { file: p }), three);
    await until(() => s.page.evaluate(() => !!document.querySelector('.win.app-pdf .page canvas, .win.app-pdf .page .canvasWrapper')), { label: 'pdf loaded', timeout: 20000 });
    await s.page.waitForTimeout(500);
    await s.page.click('.win.app-pdf .pdf-scroller');
    await s.page.keyboard.press('Control+p');
    await waitDialog(s);
    check('3 pages', await D(s, (dlg) => dlg.querySelector('.pd-pageinfo').textContent), '3 pages');
    await s.page.click('.pd-dialog .pd-pages button:nth-child(2)');
    await s.page.keyboard.type('2-3', { delay: 5 });
    check('pages to print', await D(s, (dlg) => dlg.querySelector('.pd-pageinfo').textContent), '2 pages à imprimer');
    await s.shot('print-pdf-range-fr-dark');
    await s.page.click('.pd-dialog .pd-go');
    await waitClosed(s);
    const job = await lastJob(s);
    check('fit to page for a PDF', job.fitToPage, true);
    check('extracted pages', job.file && pdfPages(job.file), 2);
  });

  // ---------------------------------------------------------------- Photos
  await section('photos: the photo fitted to a landscape page', async () => {
    await fakePrinters(s, PRINTERS);
    const pic = path.join(home, 'Pictures', 'paysage.png');
    const dataUrl = await s.page.evaluate(() => {
      const c = document.createElement('canvas');
      c.width = 900;
      c.height = 500;
      const g = c.getContext('2d');
      const gr = g.createLinearGradient(0, 0, 900, 500);
      gr.addColorStop(0, '#1d3b6e');
      gr.addColorStop(1, '#e9b566');
      g.fillStyle = gr;
      g.fillRect(0, 0, 900, 500);
      g.fillStyle = '#fff';
      g.beginPath();
      g.arc(650, 160, 70, 0, Math.PI * 2);
      g.fill();
      return c.toDataURL('image/png');
    });
    fs.writeFileSync(pic, Buffer.from(dataUrl.split(',')[1], 'base64'));
    await s.aurora((p) => window.__aurora.registry.launch('photos', { file: p }), pic);
    await until(() => s.page.evaluate(() => !!document.querySelector('.win.app-photos .ph-viewer img, .win.app-photos img.ph-img, .win.app-photos .ph-stage img')), { label: 'photo shown', timeout: 20000 });
    await s.page.waitForTimeout(600);
    await s.page.keyboard.press('Control+p');
    await waitDialog(s);
    const orient = await D(s, (dlg) => dlg.querySelector('.pd-orient .selected')?.textContent);
    check('wide photo: landscape by default', orient, (x) => /Paysage/.test(x || ''));
    await s.shot('print-photos-fr-dark');
    await s.page.click('.pd-dialog .pd-go');
    await waitClosed(s);
    const job = await lastJob(s);
    check('one page', job.file && pdfPages(job.file), 1);
    check('landscape', job.orientation, 'landscape');
    const imgs = execFileSync('pdfimages', ['-list', job.file], { encoding: 'utf8' }).split('\n').filter((l) => /^\s*\d+\s+\d+\s+image/.test(l));
    check('photo in the PDF', imgs.length, (n) => n >= 1);
  });
} catch (err) {
  failures.push(`dark run: ${err?.stack || err}`);
} finally {
  await s?.close();
}

// ================================================================ light, French: browser and Notes
let server = null;
try {
  server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>Page de test</title><h1>Bonjour depuis le Navigateur</h1><p>Une page servie en local pour le test d’impression.</p>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  s = await launchShell({ open: ['browser'], lang: 'fr', theme: 'light', size: '1280x720' });
  home = s.home;
  const CTL = `window.__aurora.registry.instance(window.__aurora.wm.byApp('browser')[0].id).hooks.ctl`;
  const run = (expr) => s.page.evaluate(`(async () => { const bw = ${CTL}; return (${expr}); })()`);

  await section('browser: Ctrl+P prints the current page', async () => {
    await fakePrinters(s, PRINTERS);
    await until(() => run('!!bw.active'), { label: 'browser' });
    await run(`bw.navigate(bw.active, ${JSON.stringify(url)})`);
    await until(() => run(`bw.active.web.title === 'Page de test' && !bw.active.web.loading && bw.active.ready`), { label: 'page load', timeout: 20000 });
    await s.page.waitForTimeout(400);
    await run('(await import("app://shell/apps/browser/lib/panels.js")).printPage(bw) && true');
    await waitDialog(s);
    await s.shot('print-browser-fr-light');
    await s.page.click('.pd-dialog .pd-go');
    await waitClosed(s);
    const job = await lastJob(s);
    check('page title as job title', job.title, 'Page de test');
    check('page text in the PDF', pdfText(job.file || '/nonexistent').includes('Bonjour depuis le Navigateur'), true);
  });

  await section('notes: Imprimer… prints the note', async () => {
    await s.aurora(() => window.__aurora.registry.launch('notes'));
    await until(() => s.page.evaluate(() => !!document.querySelector('.win.app-notes .nt-body')), { label: 'notes', timeout: 20000 });
    await s.page.waitForTimeout(400);
    await s.page.keyboard.press('Control+n');
    await s.page.waitForTimeout(400);
    await s.page.keyboard.type('Recette des crêpes', { delay: 5 });
    await s.page.keyboard.press('Enter');
    await s.page.waitForTimeout(200);
    await s.page.keyboard.type('Farine, oeufs, lait et une pincée de sel.', { delay: 2 });
    await s.page.waitForTimeout(300);
    await s.page.keyboard.press('Control+Shift+p');
    await waitDialog(s);
    const before = (await jobs(s)).length;
    check('Letter is not the default in French', await D(s, (dlg) => dlg.querySelector('.pd-paper').value), 'A4');
    await s.shot('print-notes-fr-light');
    await s.page.click('.pd-dialog .pd-go');
    await waitClosed(s);
    check('one more job', (await jobs(s)).length, before + 1);
    const job = await lastJob(s);
    const txt = pdfText(job.file || '/nonexistent');
    check('note title and body', txt.includes('Recette des crêpes') && txt.includes('pincée de sel'), true);
  });
} catch (err) {
  failures.push(`light run: ${err?.stack || err}`);
} finally {
  await s?.close();
  server?.close();
}

// ================================================================ English: Letter
await section('english: Letter paper by default', async () => {
  const e = await launchShell({ open: ['notepad'], lang: 'en', theme: 'dark', size: '1280x720' });
  try {
    await until(() => e.page.evaluate(() => !!document.querySelector('.win.app-notepad textarea')), { label: 'notepad' });
    await e.page.click('.win.app-notepad textarea');
    await e.page.keyboard.type('Hello paper', { delay: 2 });
    await e.page.keyboard.press('Control+p');
    await waitDialog(e);
    const st = await D(e, (dlg) => ({ paper: dlg.querySelector('.pd-paper').value, title: dlg.querySelector('.dialog-title').textContent, target: dlg.querySelector('.pd-printer').value, go: dlg.querySelector('.pd-go').textContent }));
    // The real printers backend of dev mode (main/ipc/printers.js, simulated CUPS): its default printer, and
    // the lp command line it would run.
    check('english dialog (values)', { paper: st.paper, title: st.title, go: st.go, printer: st.target !== '__pdf__' }, { paper: 'Letter', title: 'Print', go: 'Print', printer: true });
    await e.shot('print-notepad-en-dark');
    await e.page.click('.pd-dialog .pd-go');
    await until(async () => !(await e.page.evaluate(() => !!document.querySelector('.pd-dialog'))), { label: 'dialog closed' });
    const lp = await e.page.evaluate(async () => (await import('app://shell/core/api.js')).api.invoke('printers:devLastLp'));
    const args = JSON.stringify(lp);
    check('lp: printer, Letter, the spooled PDF', /media=Letter/i.test(args) && /aurora-print-/.test(args) && args.includes(st.target), true);
  } finally {
    await e.close();
  }
});

console.log(`\nprint: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
