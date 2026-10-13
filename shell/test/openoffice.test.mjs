// Linux app integration, part 2: aurora-open + .desktop handlers + mimeapps defaults, the office prompt
// (fake store: the dev Flathub simulation + a LibreOffice .desktop written by the test), local spell check,
// screen sharing in the Navigateur (getDisplayMedia -> Selene picker).
//   xvfb-run -a -s '-screen 0 1600x900x24' node test/openoffice.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { launchShell, ROOT } from './lib.mjs';

const require = createRequire(import.meta.url);
const REPO = path.join(ROOT, '..');
const RFS = path.join(REPO, 'rootfs');
const AURORA_OPEN = path.join(RFS, 'usr/bin/aurora-open');
let pass = 0;
let fail = 0;
const check = (ok, msg) => {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, { timeout = 15000, step = 200 } = {}) {
  const end = Date.now() + timeout;
  let v;
  while (Date.now() < end) {
    try {
      v = await fn();
      if (v) return v;
    } catch {}
    await sleep(step);
  }
  return v;
}

// ------------------------------------------------------------------ unit: mime table + desktop files
function parseIni(text) {
  const out = {};
  let g = null;
  for (const line of text.split('\n')) {
    const l = line.trim();
    if (!l || l.startsWith('#')) continue;
    const m = /^\[(.+)\]$/.exec(l);
    if (m) {
      g = out[m[1]] = {};
      continue;
    }
    const i = l.indexOf('=');
    if (g && i > 0) g[l.slice(0, i)] = l.slice(i + 1);
  }
  return out;
}
{
  const dir = path.join(RFS, 'usr/share/applications');
  const files = fs.readdirSync(dir).filter((f) => /^aurora-.*\.desktop$/.test(f));
  const appIds = new Set(fs.readdirSync(path.join(ROOT, 'renderer/apps')));
  const mimesOf = {};
  let allGood = true;
  for (const f of files) {
    const e = parseIni(fs.readFileSync(path.join(dir, f), 'utf8'))['Desktop Entry'] || {};
    const m = /^aurora-open ([a-z]+) %U$/.exec(e.Exec || '');
    const ok = e.Type === 'Application' && e.NoDisplay === 'true' && m && appIds.has(m[1]) && `aurora-${m[1]}.desktop` === f && (e.MimeType || '').endsWith(';');
    if (!ok) console.log('  bad desktop entry', f, e);
    allGood &&= !!ok;
    mimesOf[f] = new Set((e.MimeType || '').split(';').filter(Boolean));
  }
  check(files.length >= 8 && allGood, `${files.length} NoDisplay aurora-*.desktop handlers, Exec=aurora-open <Selene app> %U`);
  const list = parseIni(fs.readFileSync(path.join(RFS, 'etc/xdg/mimeapps.list'), 'utf8'));
  const defs = list['Default Applications'] || {};
  const bad = Object.entries(defs).filter(([mime, d]) => !mimesOf[d]?.has(mime));
  check(Object.keys(defs).length > 40 && bad.length === 0, `mimeapps.list: ${Object.keys(defs).length} defaults, each one declared by its .desktop file ${bad.length ? JSON.stringify(bad.slice(0, 3)) : ''}`);
  const want = { 'x-scheme-handler/http': 'aurora-browser.desktop', 'x-scheme-handler/https': 'aurora-browser.desktop', 'x-scheme-handler/mailto': 'aurora-mail.desktop', 'inode/directory': 'aurora-files.desktop', 'application/pdf': 'aurora-pdf.desktop', 'image/png': 'aurora-photos.desktop', 'text/plain': 'aurora-notepad.desktop', 'application/zip': 'aurora-archive.desktop', 'video/mp4': 'aurora-media.desktop' };
  check(Object.entries(want).every(([k, v]) => defs[k] === v), 'defaults: http(s) -> Navigateur, mailto -> Courrier, folders -> Fichiers, PDF, images, text, archives, video');
  check(!Object.keys(defs).some((k) => /officedocument|msword|ms-excel|opendocument/.test(k)), 'no office type claimed by Selene (LibreOffice handles them once installed)');
  // Linux apps list (main/ipc/xapps.js) hides NoDisplay entries: no duplicates in the Lanceur.
  const X = require(path.join(ROOT, 'main/ipc/xapps.js'));
  const toEntry = X.toEntry || X._test?.toEntry;
  if (toEntry) check(files.every((f) => toEntry({ 'Desktop Entry': parseIni(fs.readFileSync(path.join(dir, f), 'utf8'))['Desktop Entry'] }, { desktopId: f }) === null), 'xapps ignores the handlers (NoDisplay)');
  // Server-side validation (main/ipc/xdgopen.js).
  const XO = require(path.join(ROOT, 'main/ipc/xdgopen.js'));
  const ok = (r) => {
    try {
      XO.checkRequest(r);
      return true;
    } catch {
      return false;
    }
  };
  check(ok({ v: 1, app: 'browser', items: [{ kind: 'url', value: 'https://example.org/a?b=1' }] }) && ok({ v: 1, app: 'mail', items: [{ kind: 'url', value: 'mailto:a@b.c' }] }) && ok({ v: 1, app: 'files', items: [{ kind: 'path', value: os.tmpdir() }] }), 'xdgopen accepts http(s), mailto and existing paths');
  check(
    !ok({ v: 1, app: 'browser', items: [{ kind: 'url', value: 'javascript:alert(1)' }] }) &&
      !ok({ v: 1, app: 'browser', items: [{ kind: 'url', value: 'file:///etc/passwd' }] }) &&
      !ok({ v: 1, app: 'files', items: [{ kind: 'path', value: 'relative/x' }] }) &&
      !ok({ v: 1, app: 'files', items: [{ kind: 'path', value: '/nonexistent/zz' }] }) &&
      !ok({ v: 1, app: 'terminal', items: [] }) &&
      !ok({ v: 1, app: 'browser', items: [{ kind: 'url', value: 'https://a.b/\nx' }] }) &&
      !ok({ v: 2, app: 'browser', items: [] }),
    'xdgopen refuses other schemes, relative / missing paths, unknown apps, control characters, other versions',
  );
  // Client-side refusals (no shell needed).
  const run = (args, env = {}) => spawnSync('python3', [AURORA_OPEN, ...args], { env: { ...process.env, AURORA_OPEN_SOCKET: '/nonexistent/aurora-open.sock', ...env }, encoding: 'utf8' });
  const js = run(['browser', 'javascript:alert(1)']);
  const ftp = run(['browser', 'ftp://example.org/']);
  const miss = run(['photos', '/nonexistent/a.png']);
  const unk = run(['terminal', 'https://example.org']);
  check(js.status === 1 && ftp.status === 1 && miss.status === 1 && unk.status === 1, `aurora-open refuses javascript:, ftp:, missing files and unknown apps (exit 1): ${[js, ftp, miss, unk].map((r) => r.status).join(',')}`);
  const down = run(['browser', 'https://example.org/']);
  check(down.status === 2 && /not running/.test(down.stderr), 'aurora-open without a running shell: exit 2, clear message');
  // Dictionaries shipped (Chromium .bdic, names compiled into Electron).
  const D = path.join(RFS, 'usr/share/aurora/dictionaries');
  check(['fr-FR-3-0.bdic', 'en-US-10-1.bdic'].every((f) => fs.statSync(path.join(D, f)).size > 300000 && fs.readFileSync(path.join(D, f)).subarray(0, 4).toString('latin1') === 'BDic'), 'fr-FR and en-US .bdic dictionaries in rootfs/usr/share/aurora/dictionaries');
}

// ------------------------------------------------------------------ shell: aurora-open, office prompt, spelling, screen sharing
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-oo-'));
const sock = path.join(tmp, 'run', 'aurora', 'open.sock');
const appsDir = path.join(tmp, 'apps');
fs.mkdirSync(appsDir, { recursive: true });
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><title>Partage</title><body style="font:16px sans-serif;background:#fff"><h1>Test de partage</h1><div id="r">-</div>
<script>window.share = () => navigator.mediaDevices.getDisplayMedia({ video: true }).then((s) => { const tr = s.getVideoTracks()[0]; document.getElementById('r').textContent = 'ok:' + tr.kind; window.__res = 'ok:' + tr.kind; tr.stop(); }, (e) => { window.__res = 'err:' + e.name; document.getElementById('r').textContent = 'err:' + e.name; });</script></body>`);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const pageUrl = `http://127.0.0.1:${server.address().port}/share.html`;

for (const theme of ['dark', 'light']) {
  const s = await launchShell({ lang: 'fr', theme, size: '1280x720', env: { AURORA_OPEN_SOCKET: sock, AURORA_XAPPS_DIRS: appsDir } });
  const shotOut = (n) => s.shot(`openoffice-${n}-${theme}`);
  for (const st of [s.app.process().stdout, s.app.process().stderr]) st?.on('data', (d) => String(d).split('\n').filter((l) => /DBGSHARE|display media|desktopCapturer|\[browser\]/.test(l)).forEach((l) => console.log('  [main]', l)));
  const open = (...args) => spawnSync('python3', [AURORA_OPEN, ...args], { env: { ...process.env, AURORA_OPEN_SOCKET: sock }, encoding: 'utf8', cwd: s.home });
  const winsOf = (app) => s.aurora((a) => window.__aurora.wm.byApp(a).length, app);
  const closeAll = () => s.aurora(() => window.__aurora.wm.list?.().forEach((w) => w.close()) ?? [...document.querySelectorAll('.window')].length);
  try {
    if (theme === 'dark') {
      check(await waitFor(() => fs.existsSync(sock)), 'the shell listens on the open socket');
      check((fs.statSync(sock).mode & 0o777) === 0o600 && (fs.statSync(path.dirname(sock)).mode & 0o777) === 0o700, 'socket 0600 in a 0700 directory');
      // Files, text, folder, mailto, web.
      fs.writeFileSync(path.join(s.home, 'Documents', 'note.txt'), 'Bonjour');
      let r = open('files', 'Documents');
      check(r.status === 0 && (await waitFor(() => winsOf('files'))), `aurora-open files Documents -> Fichiers (${r.stderr.trim()})`);
      r = open('notepad', `file://${path.join(s.home, 'Documents', 'note.txt')}`);
      check(r.status === 0 && (await waitFor(() => winsOf('notepad'))), 'aurora-open notepad file:///…/note.txt -> Éditeur de texte');
      check(await waitFor(() => s.aurora(() => [...document.querySelectorAll('.np-text')].some((t) => t.value === 'Bonjour'))), 'the text file is open in the editor');
      r = open('mail', 'mailto:camille@example.org?subject=Salut');
      check(r.status === 0 && (await waitFor(() => winsOf('mail'))), 'aurora-open mail mailto: -> Courrier');
      r = open('browser', `${pageUrl}?from=xdg`);
      check(r.status === 0 && (await waitFor(() => winsOf('browser'))), 'aurora-open browser http://… -> Navigateur');
      const r2 = open('browser', 'javascript:alert(1)');
      check(r2.status === 1, 'javascript: refused by aurora-open');
      // Raw socket: the shell itself refuses what aurora-open would not send.
      const raw = execFileSync('python3', ['-c', 'import socket,sys;s=socket.socket(socket.AF_UNIX);s.connect(sys.argv[1]);s.sendall(b\'{"v":1,"app":"browser","items":[{"kind":"url","value":"file:///etc/passwd"}]}\\n\');print(s.recv(999).decode())', sock], { encoding: 'utf8' });
      check(/"ok":false/.test(raw), `shell refuses a file:// URL sent straight to the socket (${raw.trim()})`);
      await s.aurora(() => window.__aurora.wm.byApp('files').concat(window.__aurora.wm.byApp('notepad'), window.__aurora.wm.byApp('mail'), window.__aurora.wm.byApp('browser')).forEach((w) => w.close()));
      await sleep(800);
    }

    // Office prompt: a .docx with nothing to open it.
    const doc = path.join(s.home, 'Documents', 'rapport.docx');
    fs.writeFileSync(doc, 'PK fake docx');
    await s.aurora(() => {
      window.__launched = [];
      const reg = window.__aurora.registry;
      const orig = reg.launch.bind(reg);
      reg.launch = (id, args) => (window.__launched.push([id, args]), orig(id, args));
    });
    const r = open('-', doc);
    check(r.status === 0, 'aurora-open - rapport.docx handed over');
    const dlg = await waitFor(() => s.aurora(() => document.querySelector('.office-dialog')?.textContent || ''));
    check(/installez LibreOffice/.test(dlg) && /rapport\.docx/.test(dlg), `office prompt: « Pour ouvrir ce document, installez LibreOffice » (${theme})`);
    await shotOut('prompt');
    if (theme === 'light') {
      await s.page.click('.office-dialog .btn:not(.primary)');
      check(await waitFor(() => s.aurora(() => !document.querySelector('.office-dialog'))), '« Plus tard » closes the prompt');
    } else {
      await s.page.click('.office-dialog .btn.primary');
      // The fake store: dev simulation of the Flathub install; the test plays the role of flatpak's exported .desktop.
      await sleep(500);
      check(await waitFor(() => s.aurora(() => [...document.querySelectorAll('.toast, .notification')].some((n) => /Installation de LibreOffice/.test(n.textContent))), { timeout: 5000 }), 'install progress notification');
      await shotOut('installing');
      fs.writeFileSync(
        path.join(appsDir, 'org.libreoffice.LibreOffice.desktop'),
        '[Desktop Entry]\nType=Application\nName=LibreOffice\nExec=/usr/bin/true %U\nMimeType=application/vnd.openxmlformats-officedocument.wordprocessingml.document;application/vnd.oasis.opendocument.text;\n',
      );
      const launched = await waitFor(() => s.aurora(() => window.__launched.find(([id, a]) => /libreoffice/i.test(id) && /rapport\.docx$/.test(a?.file || ''))), { timeout: 40000 });
      check(!!launched, `after the install the document opens in LibreOffice (${JSON.stringify(launched)})`);
      check(await s.aurora(() => /libreoffice/i.test(window.__aurora.registry.handlerFor('/x/y.odt') || '')), 'registry.handlerFor finds LibreOffice by MIME type');
      // Opening it again (Fichiers double-click path) launches LibreOffice without a « no app » warning.
      const warnBefore = await s.aurora(() => [...document.querySelectorAll('.toast, .notification')].filter((n) => /Aucune application/.test(n.textContent)).length);
      await s.aurora((p) => window.__aurora.shell.openFile(p), doc);
      await sleep(600);
      const warnAfter = await s.aurora(() => [...document.querySelectorAll('.toast, .notification')].filter((n) => /Aucune application/.test(n.textContent)).length);
      check(warnAfter === warnBefore, `shell.openFile on a .docx with LibreOffice installed shows no « no app » warning (${warnBefore} -> ${warnAfter})`);
      // Files: same prompt from a double-click (no handler -> office prompt, not « Ouvrir avec »).
      fs.rmSync(path.join(appsDir, 'org.libreoffice.LibreOffice.desktop'));
      await waitFor(() => s.aurora(async () => (await window.__aurora.registry.load(), !window.__aurora.registry.handlerFor('/a.docx'))));
      fs.writeFileSync(path.join(s.home, 'Documents', 'budget.xlsx'), 'PK fake');
      await s.aurora((p) => window.__aurora.shell.launch('files', { path: p }), path.join(s.home, 'Documents'));
      const item = await waitFor(() => s.page.$('.app-files .fx-item:has-text("budget.xlsx")'));
      if (item) await item.dblclick();
      const d2 = await waitFor(() => s.aurora(() => document.querySelector('.office-dialog')?.textContent || ''));
      check(/budget\.xlsx/.test(d2), 'Fichiers: double-click on a .xlsx shows the office prompt');
      await s.page.keyboard.press('Escape');
      await s.aurora(() => window.__aurora.wm.byApp('files').forEach((w) => w.close()));
    }

    // Spell check: dictionaries installed locally, French first, notepad prose field, right-click suggestions.
    const st = await s.aurora(() => window.__aurora.api.invoke('spell:status'));
    check(st.enabled && st.languages[0] === 'fr-FR' && st.languages.includes('en-US') && st.dictionaries.length === 2 && st.dictionaries.every((d) => fs.existsSync(d.path)), `spell check on, ${st.languages.join(' + ')}, dictionaries in ${st.dir}`);
    await s.aurora(() => window.__aurora.shell.launch('notepad', {}));
    await waitFor(() => s.page.$('.np-doc:not([hidden]) .np-text'));
    const ta = '.np-doc:not([hidden]) .np-text';
    check(await s.aurora((sel) => document.querySelector(sel).spellcheck === true, ta), 'Éditeur de texte: new document is spell-checked');
    await s.page.click(ta);
    await s.page.keyboard.type('Une maison trés bonjuor ');
    await sleep(1200);
    check(await s.aurora(() => window.aurora.spell.misspelled('bonjuor') && !window.aurora.spell.misspelled('maison')), '« bonjuor » misspelled, « maison » correct (local French dictionary)');
    // Right-click on the misspelled word (Chromium selects it) -> Selene menu.
    const box = await s.aurora((sel) => {
      const t = document.querySelector(sel);
      const r = t.getBoundingClientRect();
      // measure the word offset with a canvas in the textarea's font
      const c = document.createElement('canvas').getContext('2d');
      const cs = getComputedStyle(t);
      c.font = `${cs.fontSize} ${cs.fontFamily}`;
      const before = c.measureText('Une maison trés ').width;
      const w = c.measureText('bonjuor').width;
      return { x: r.left + parseFloat(cs.paddingLeft) + before + w / 2, y: r.top + parseFloat(cs.paddingTop) + parseFloat(cs.lineHeight || 20) / 2 };
    }, ta);
    await s.page.mouse.click(box.x, box.y, { button: 'right' });
    const menu = await waitFor(() => s.aurora(() => document.querySelector('.spell-menu, .menu.spell-menu')?.textContent || [...document.querySelectorAll('.menu')].map((m) => m.textContent).find((x) => /Ajouter au dictionnaire/.test(x)) || ''), { timeout: 4000 });
    check(/Bonjour|bonjour/.test(menu) && /Ajouter au dictionnaire/.test(menu), `right-click: suggestions + « Ajouter au dictionnaire » (${menu.slice(0, 80)})`);
    if (theme === 'dark' || menu) await shotOut('spell');
    if (menu) {
      const okClick = await s.aurora(() => {
        const it = [...document.querySelectorAll('.menu [role="menuitem"], .menu .menu-item, .menu button')].find((e) => /^\s*bonjour\s*$/i.test(e.textContent));
        it?.click();
        return !!it;
      });
      check(okClick && (await waitFor(() => s.aurora((sel) => /bonjour /i.test(document.querySelector(sel).value), ta))), 'choosing « bonjour » replaces the word');
    }
    if (theme === 'light') {
      const added = await s.aurora(() => window.__aurora.api.invoke('spell:add', 'Seleneos'));
      const words = await s.app.evaluate(({ session }) => session.defaultSession.listWordsInSpellCheckerDictionary());
      check(added === true && words.includes('Seleneos'), '« Ajouter au dictionnaire » (spell:add) writes the word to the session dictionary');
      check(!(await s.aurora(() => window.__aurora.api.invoke('spell:add', 'rm -rf').then(() => true, () => false))), 'spell:add refuses anything but a word');
      await s.aurora(() => window.__aurora.settings.set('spellcheck', false));
      check(await waitFor(() => s.aurora((sel) => document.querySelector(sel).spellcheck === false, ta)), 'setting off: the editor is no longer checked');
      await s.aurora(() => window.__aurora.settings.set('spellcheck', true));
      check(await s.aurora(() => document.documentElement.spellcheck === false && document.querySelector('.taskbar input, #start input, input')?.spellcheck !== true), 'other shell fields stay unchecked');
    }
    await s.aurora(() => window.__aurora.wm.byApp('notepad').forEach((w) => w.close()));
    await sleep(300);
    const dont = await s.page.$('.dialog .btn:not(.primary)');
    if (dont) await s.aurora(() => [...document.querySelectorAll('.dialog .btn')].find((b) => /Ne pas enregistrer|Don/.test(b.textContent))?.click());

    // Screen sharing (dark: share; light: cancel = deny).
    await s.aurora((u) => window.__aurora.shell.openUrl(u), pageUrl);
    const CTL = "window.__aurora.registry.instance(window.__aurora.wm.byApp('browser')[0].id).hooks.ctl";
    await waitFor(() => s.page.evaluate(`(() => { const bw = ${CTL}; return bw.active && bw.active.ready && bw.active.wv; })()`).catch(() => false), { timeout: 20000 });
    await sleep(800);
    await s.page.evaluate(`(() => { const bw = ${CTL}; bw.active.wv.executeJavaScript('window.share(); 1', true); return 1; })()`);
    const picker = await waitFor(() => s.aurora(() => document.querySelector('.bw-share-dialog')?.textContent || ''), { timeout: 10000 });
    check(/Partager votre écran/.test(picker) && /Écran entier/.test(picker), `screen sharing picker « Partager votre écran » with « Écran entier » (${theme})`);
    await shotOut('share');
    if (theme === 'dark') await s.page.click('.bw-share-dialog .btn.primary');
    else await s.page.click('.bw-share-dialog .btn:not(.primary)');
    const res = await waitFor(() => s.page.evaluate(`(() => { const bw = ${CTL}; return bw.active.wv.executeJavaScript('window.__res || ""'); })()`), { timeout: 10000 });
    if (theme === 'dark') check(res === 'ok:video', `« Partager »: the page gets a video track (${res})`);
    else check(/^err:(NotAllowedError|AbortError)/.test(res || ''), `« Annuler »: the page is refused, no stream (${res})`);
  } catch (err) {
    check(false, `${theme}: ${err.stack || err}`);
  } finally {
    const errs = s.logs.filter((l) => /\[pageerror\]/.test(l));
    check(errs.length === 0, `no page errors (${theme}) ${errs.slice(0, 3).join(' | ')}`);
    await s.close();
  }
}
server.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nopenoffice: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
