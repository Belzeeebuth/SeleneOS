// Navigateur: links to other apps (custom URL schemes: claude://, spotify:, zoommtg: …). A page that redirects,
// navigates or opens a window to such a link gets « Ouvrir Claude ? » in its tab (a pop-up's request in its opener
// tab, even when the page closes the pop-up), and « Ouvrir » hands the link to xdg-open (one argv entry). Fake
// xdg-mime / xdg-open on PATH (the calls are recorded), fixture .desktop files in test/fixtures/schemes/.
//   xvfb-run -a -s "-screen 0 1600x900x24" node test/browser-schemes.test.mjs [--only=name]
// Screenshot (FR, Halo dark, 1280x720): test/out/browser-scheme-prompt-fr-dark.png
import { launchShell } from './lib.mjs';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const schemes = require('../main/lib/url-schemes.js');
const only = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
const results = [];
let onFail = null; // set once the shell runs: closes a prompt a failed test left open

function assert(cond, msg) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}
async function test(name, fn) {
  if (only.length && !only.some((o) => name.startsWith(o))) return;
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✔ ${name} (${Date.now() - t0} ms)`);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.log(`  ✘ ${name}\n      ${String(err?.stack || err).split('\n').slice(0, 4).join('\n      ')}`);
    await onFail?.().catch(() => {});
  }
}

// ---------------------------------------------------------------- pure checks (no shell)
await test('url-schemes: which links may go to another app', async () => {
  for (const u of ['claude://login?code=x', 'zoommtg://zoom.us/join?confno=1', 'spotify:track:1', 'steam://run/1', 'msteams:/l/meetup', 'magnet:?xt=urn:btih:1'])
    assert(schemes.checkUrl(u), `${u} is a link to an app`);
  for (const u of ['javascript:alert(1)', 'JavaScript:alert(1)', 'vbscript:msgbox(1)', 'file:///etc/passwd', 'data:text/html,x', 'http://a.b/', 'https://a.b/', 'about:blank', 'blob:http://a/1', 'view-source:http://a/', 'mailto:a@b.c', 'chrome://gpu', 'aurora://settings'])
    assert(!schemes.checkUrl(u), `${u} never goes to another app`);
  assert(!schemes.checkUrl(`claude://x?${'a'.repeat(8200)}`), 'longer than 8 KB: refused');
  assert(!schemes.checkUrl('claude://x\ny') && !schemes.checkUrl('claude://x\u0000') && !schemes.checkUrl('claude://x\u007f'), 'control characters: refused');
  assert(!schemes.checkUrl(`${'a'.repeat(40)}://x`) && !schemes.checkUrl('c://x'), 'scheme syntax ^[a-z][a-z0-9+.-]{1,31}$');
});

// ---------------------------------------------------------------- fake system: xdg-mime, xdg-open, .desktop files
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-schemes-'));
const bin = path.join(tmp, 'bin');
const fake = path.join(tmp, 'xdg');
const home = path.join(tmp, 'home');
fs.mkdirSync(bin, { recursive: true });
fs.mkdirSync(fake, { recursive: true });
const OPEN_LOG = path.join(fake, 'open.log');
fs.writeFileSync(path.join(fake, 'defaults'), 'x-scheme-handler/claude=claude-desktop.desktop\nx-scheme-handler/spotify=com.spotify.Client.desktop\n');
fs.writeFileSync(
  path.join(bin, 'xdg-mime'),
  `#!/bin/sh
# fake xdg-mime: query default <type> from $FAKE_XDG_DIR/defaults (nothing printed: no default app)
[ "$1" = query ] && [ "$2" = default ] || exit 1
grep -m1 -F "$3=" "$FAKE_XDG_DIR/defaults" | cut -d= -f2-
exit 0
`,
  { mode: 0o755 },
);
fs.writeFileSync(
  path.join(bin, 'xdg-open'),
  `#!/bin/sh
# fake xdg-open: records each call (argument count, then one line per argument)
{ printf 'CALL %s\\n' "$#"; for a in "$@"; do printf 'ARG %s\\n' "$a"; done; } >> "$FAKE_XDG_DIR/open.log"
`,
  { mode: 0o755 },
);
const FIX = path.join(here, 'fixtures', 'schemes');
const apps = path.join(home, '.local', 'share', 'applications');
const flat = path.join(home, '.local', 'share', 'flatpak', 'exports', 'share', 'applications');
fs.mkdirSync(apps, { recursive: true });
fs.mkdirSync(flat, { recursive: true });
fs.copyFileSync(path.join(FIX, 'applications', 'claude-desktop.desktop'), path.join(apps, 'claude-desktop.desktop'));
fs.copyFileSync(path.join(FIX, 'flatpak-exports', 'applications', 'com.spotify.Client.desktop'), path.join(flat, 'com.spotify.Client.desktop'));

/** xdg-open calls so far: [[arg, …], …] */
function opened() {
  let txt = '';
  try {
    txt = fs.readFileSync(OPEN_LOG, 'utf8');
  } catch {}
  const calls = [];
  for (const line of txt.split('\n')) {
    if (line.startsWith('CALL ')) calls.push({ argc: Number(line.slice(5)), argv: [] });
    else if (line.startsWith('ARG ')) calls[calls.length - 1]?.argv.push(line.slice(4));
  }
  return calls;
}

// ---------------------------------------------------------------- local sites
// The site on http://127.0.0.1:<port>, a sign-in provider on http://localhost:<port> (another site).
const server = http.createServer((req, res) => {
  const port = server.address().port;
  const IDP = `http://localhost:${port}`;
  const url = new URL(req.url, 'http://x');
  const page = (title, body) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>body{font:15px system-ui,sans-serif;margin:32px;color:#1b1b1b;background:#fff}.card{max-width:440px;padding:24px;border:1px solid #ddd;border-radius:12px}a.btn{display:inline-block;padding:9px 16px;border-radius:8px;background:#c96442;color:#fff;text-decoration:none}</style></head><body>${body}</body></html>`);
  };
  switch (url.pathname) {
    case '/app':
      return page(
        'App',
        `<div class="card"><h2>Connexion réussie</h2><p>Vous êtes connecté. Retournez dans l'application pour continuer.</p>
<a class="btn" id="direct" href="/go?to=${encodeURIComponent('claude://login?code=x')}">Ouvrir l'application</a>
<a id="blank" href="claude://login?code=blank" target="_blank">nouvel onglet</a>
<button id="pop">Pop-up</button></div>
<script>document.getElementById('pop').onclick = () => window.open('${IDP}/popup', 'signin', 'width=420,height=400');</script>`,
      );
    case '/go':
      res.writeHead(302, { location: url.searchParams.get('to') || '/app' });
      return res.end();
    case '/popup':
      // A sign-in pop-up that hands the result to the app and closes itself right away.
      return page('Pop-up', `<p>OK</p><script>location.href = 'claude://login?code=pop'; window.close();</script>`);
    default:
      res.writeHead(404);
      return res.end('not found');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const SITE = `http://127.0.0.1:${port}`;
const IDP = `http://localhost:${port}`;
const go = (to) => `${SITE}/go?to=${encodeURIComponent(to)}`;

const s = await launchShell({
  open: ['browser'],
  theme: 'dark',
  lang: 'fr',
  size: '1280x720',
  settings: { finish: 'halo' },
  home,
  env: { PATH: `${bin}:${process.env.PATH}`, FAKE_XDG_DIR: fake },
});
const CTL = `window.__aurora.registry.instance(window.__aurora.wm.byApp('browser')[0].id).hooks.ctl`;
const run = (expr) => s.page.evaluate(`(async () => { const bw = ${CTL}; return (${expr}); })()`);
const waitFor = async (fn, { timeout = 10000, msg } = {}) => {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e.message;
    }
    await s.page.waitForTimeout(100);
  }
  throw new Error(`Timed out waiting for ${msg} (last: ${JSON.stringify(last)})`);
};
const pageJs = (code) => run(`bw.active.wv.executeJavaScript(${JSON.stringify(code)}, true)`);
const open = async (url, title) => {
  await run(`bw.navigate(bw.active, ${JSON.stringify(url)})`);
  await waitFor(() => run(`!bw.active.web.loading && bw.active.web.title === ${JSON.stringify(title)}`), { msg: `page « ${title} »` });
};
/** The prompt in the shell: { title, body, check, buttons } | null */
const prompt = () =>
  s.page.evaluate(() => {
    const el = document.querySelector('.app-browser .bw-flyout.bw-scheme:not(.leaving)');
    if (!el) return null;
    return {
      title: el.querySelector('.bw-pop-title')?.textContent || '',
      body: el.querySelector('.bw-perm-kind .bw-wrap')?.textContent || '',
      check: el.querySelector('.bw-check')?.textContent || null,
      buttons: [...el.querySelectorAll('.bw-pop-actions .btn')].map((b) => b.textContent),
      label: el.getAttribute('aria-label'),
    };
  });
const waitPrompt = (msg = 'the prompt') => waitFor(prompt, { msg });
const noPrompt = () => waitFor(async () => !(await prompt()), { msg: 'the prompt closed' });
const click = (which) => s.page.click(`.app-browser .bw-flyout.bw-scheme .bw-pop-actions .btn${which === 'primary' ? '.primary' : ':not(.primary)'}`);
/** Waits for the next xdg-open call after `n` calls. */
const nextOpen = (n) => waitFor(() => (opened().length > n ? opened()[n] : null), { msg: 'xdg-open called' });
const quiet = (ms = 1200) => s.page.waitForTimeout(ms);
onFail = async () => {
  await run('bw.closeFlyout()');
  await run('window.__aurora.settings.set("lang", "fr")');
};

try {
  await waitFor(() => run('bw.tabs.length === 1 && !!bw.active'), { msg: 'browser window' });
  await run('bw.win.maximize()');
  await open(`${SITE}/app`, 'App');

  await test('a redirect to claude://login?code=x asks « Ouvrir Claude ? » (FR) and does not navigate', async () => {
    await pageJs("document.getElementById('direct').click()");
    const p = await waitPrompt();
    assert(p.title === 'Ouvrir Claude ?', `title « ${p.title} »`);
    assert(p.body === "Ce site veut ouvrir l'application Claude.", `body « ${p.body} »`);
    assert(p.check === 'Toujours autoriser 127.0.0.1 à ouvrir ce type de lien', `checkbox « ${p.check} »`);
    assert(JSON.stringify(p.buttons) === JSON.stringify(['Ouvrir', 'Annuler']), `buttons ${p.buttons}`);
    assert(p.label === 'Ouvrir Claude ?', 'the dialog is named');
    assert((await run('bw.active.web.url')) === `${SITE}/app`, 'the tab stays on the page');
    assert(!(await run('bw.active.web.error')), 'no error page');
    await quiet(500);
    const file = await s.shot('browser-scheme-prompt-fr-dark');
    console.log(`      ${file}`);
  });

  await test('« Annuler » does nothing', async () => {
    await click('cancel');
    await noPrompt();
    await quiet();
    assert(opened().length === 0, `xdg-open not called (${JSON.stringify(opened())})`);
    assert((await run('bw.active.web.url')) === `${SITE}/app`, 'still on the page');
  });

  await test('« Ouvrir » calls xdg-open with exactly the URL, as its only argument', async () => {
    await pageJs(`location.href = ${JSON.stringify(go('claude://login?code=y&state=a b'))}`);
    await waitPrompt();
    await click('primary');
    await noPrompt();
    const c = await nextOpen(0);
    assert(c.argc === 1 && c.argv.length === 1, `one argument (${JSON.stringify(c)})`);
    assert(c.argv[0] === 'claude://login?code=y&state=a%20b' || c.argv[0] === 'claude://login?code=y&state=a b', `the URL ${c.argv[0]}`);
    await quiet(600);
    assert(opened().length === 1, 'opened once');
  });

  await test('the page itself going to claude:// (location.href, target=_blank link) asks too', async () => {
    const n = opened().length;
    const tabs = await run('bw.tabs.length');
    await pageJs("location.href = 'claude://login?code=loc'");
    await waitPrompt('the prompt (location.href)');
    await click('cancel');
    await noPrompt();
    await pageJs("document.getElementById('blank').click()");
    await waitPrompt('the prompt (target=_blank)');
    assert((await run('bw.tabs.length')) === tabs, 'no new tab');
    await click('cancel');
    await noPrompt();
    await quiet();
    assert(opened().length === n, 'nothing opened');
  });

  await test('a sign-in pop-up that goes to claude:// and closes itself: the prompt shows in the opener tab', async () => {
    const n = opened().length;
    await pageJs("document.getElementById('pop').click()");
    const p = await waitPrompt('the prompt from the pop-up');
    assert(p.title === 'Ouvrir Claude ?', p.title);
    assert(p.check === 'Toujours autoriser localhost à ouvrir ce type de lien', `the asking site is the pop-up's (${p.check})`);
    const left = await waitFor(
      () => s.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && /\/popup/.test(w.webContents.getURL())).length === 0),
      { msg: 'the pop-up closed' },
    );
    assert(left, 'pop-up gone');
    await click('primary');
    const c = await nextOpen(n);
    assert(c.argc === 1 && c.argv[0] === 'claude://login?code=pop', JSON.stringify(c));
  });

  await test('an unknown scheme shows the calm notice, nothing opens', async () => {
    const n = opened().length;
    await pageJs(`location.href = ${JSON.stringify(go('zzapp://hello'))}`);
    const p = await waitPrompt('the notice');
    assert(p.title === 'Aucune application ne sait ouvrir ce lien', p.title);
    assert(/« zzapp: »/.test(p.body), p.body);
    assert(p.check === null, 'no checkbox');
    assert(JSON.stringify(p.buttons) === JSON.stringify(['Fermer']), `buttons ${p.buttons}`);
    await click('cancel');
    await noPrompt();
    await quiet();
    assert(opened().length === n, 'nothing opened');
    // A page cannot stack notices (or questions): one per tab at a time, the rest are dropped.
    await pageJs("for (let i = 1; i <= 5; i++) { const f = document.createElement('iframe'); f.src = 'zz' + i + 'app://x'; document.body.appendChild(f); } true");
    await waitPrompt('one notice');
    const count = await s.page.evaluate(() => document.querySelectorAll('.app-browser .bw-flyout.bw-scheme:not(.leaving)').length);
    assert(count === 1, `one notice shown (${count})`);
    await click('cancel');
    await noPrompt();
    await quiet(800);
    assert(!(await prompt()), 'no second notice queued');
    await open(`${SITE}/app`, 'App');
  });

  await test('Flatpak app (exports/share/applications) and English', async () => {
    await run('window.__aurora.settings.set("lang", "en")');
    await waitFor(() => run("bw.t('scheme.open') === 'Open'"), { msg: 'English' });
    await pageJs(`location.href = ${JSON.stringify(go('spotify:track:4uLU6hMCjMI75M1A2tKUQC'))}`);
    const p = await waitPrompt();
    assert(p.title === 'Open Spotify?', p.title);
    assert(p.body === 'This site wants to open the Spotify app.', p.body);
    assert(p.check === 'Always allow 127.0.0.1 to open this type of link', p.check);
    assert(JSON.stringify(p.buttons) === JSON.stringify(['Open', 'Cancel']), `buttons ${p.buttons}`);
    await click('cancel');
    await noPrompt();
    await run('window.__aurora.settings.set("lang", "fr")');
    await waitFor(() => run("bw.t('scheme.open') === 'Ouvrir'"), { msg: 'French again' });
  });

  await test('javascript:, vbscript:, file:, data: and oversized links never reach xdg-open', async () => {
    const n = opened().length;
    await pageJs(`(() => {
      try { window.open('javascript:document.title = "js"'); } catch {}
      try { window.open('vbscript:msgbox(1)'); } catch {}
      try { window.open('data:text/html,<p>x</p>'); } catch {}
      const f = document.createElement('iframe'); f.src = 'file:///etc/hostname'; document.body.appendChild(f);
      const g = document.createElement('iframe'); g.src = ${JSON.stringify(go('javascript:alert(1)'))}; document.body.appendChild(g);
      const k = document.createElement('iframe'); k.src = ${JSON.stringify(go('file:///etc/hostname'))}; document.body.appendChild(k);
      const v = document.createElement('iframe'); v.src = 'vbscript:msgbox(1)'; document.body.appendChild(v);
      return true;
    })()`);
    await pageJs(`location.href = ${JSON.stringify(go(`claude://big?${'a'.repeat(8300)}`))}`);
    await quiet(2500);
    assert(!(await prompt()), 'no prompt');
    assert(opened().length === n, `nothing opened (${JSON.stringify(opened().slice(n)).slice(0, 300)})`);
    const forged = await run("bw.ctx.api.invoke('browser:schemeReply', 's999999', { open: true, always: true })");
    assert(forged === false, 'an answer to a question never asked opens nothing');
    await quiet(400);
    assert(opened().length === n, 'still nothing opened');
    await open(`${SITE}/app`, 'App');
  });

  await test('« Toujours autoriser 127.0.0.1 … » skips the prompt next time (site permission, reset asks again)', async () => {
    const n = opened().length;
    await pageJs(`location.href = ${JSON.stringify(go('claude://login?code=z'))}`);
    await waitPrompt();
    await s.page.click('.app-browser .bw-flyout.bw-scheme .bw-check input');
    await click('primary');
    const c = await nextOpen(n);
    assert(c.argv[0] === 'claude://login?code=z', c.argv[0]);
    const saved = await run("bw.ctx.api.invoke('browser:sitePermissions')");
    assert(saved[SITE]?.['app:claude'] === 'allow', `saved for the origin + scheme (${JSON.stringify(saved)})`);
    const file = JSON.parse(fs.readFileSync(path.join(home, '.config', 'aurora', 'apps', 'browser', 'site-permissions.json'), 'utf8'));
    assert(file[SITE]?.['app:claude'] === 'allow', 'kept on disk');
    // Next time: no question, the link opens right away.
    let seen = false;
    await pageJs(`location.href = ${JSON.stringify(go('claude://login?code=w'))}`);
    const c2 = await waitFor(async () => {
      if (await prompt()) seen = true;
      return opened().length > n + 1 ? opened()[n + 1] : null;
    }, { msg: 'opened without asking' });
    assert(!seen, 'no prompt');
    assert(c2.argc === 1 && c2.argv[0] === 'claude://login?code=w', JSON.stringify(c2));
    // A page looping over links of an allowed scheme does not launch the app again and again.
    await quiet(2100);
    await pageJs("location.href = 'claude://loop?1'; setTimeout(() => { location.href = 'claude://loop?2'; }, 300); setTimeout(() => { location.href = 'claude://loop?3'; }, 600); true");
    await nextOpen(n + 2);
    await quiet(1500);
    assert(opened().length === n + 3 && opened()[n + 2].argv[0] === 'claude://loop?1', `one launch for the loop (${JSON.stringify(opened().slice(n + 2))})`);
    // Only for that site and that scheme: another scheme still asks.
    await pageJs(`location.href = ${JSON.stringify(go('spotify:track:1'))}`);
    await waitPrompt('spotify still asks');
    await click('cancel');
    await noPrompt();
    // Listed with the site permissions, and reset there.
    await run('bw.omni.siteBtn.click()');
    const label = await waitFor(() => s.page.evaluate(() => [...document.querySelectorAll('.app-browser .bw-site-perm')].map((e) => e.textContent).join(' | ')), { msg: 'site permissions' });
    assert(/Ouvrir les liens claude:Autorisé/.test(label), label);
    await s.page.click('.app-browser .bw-site-perms .btn');
    await waitFor(async () => !(await run("bw.ctx.api.invoke('browser:sitePermissions')"))[SITE], { msg: 'reset' });
    await quiet(2100); // past the one-question-per-link-every-2-s limit
    await pageJs(`location.href = ${JSON.stringify(go('claude://login?code=w'))}`);
    await waitPrompt('asks again after the reset');
    await click('cancel');
    await noPrompt();
  });

  await test('no renderer errors', async () => {
    const errs = s.logs.filter((l) => /^\[(error|pageerror)\]/.test(l) && !/Failed to load resource/.test(l));
    assert(!errs.length, errs.join('\n'));
  });
} finally {
  await s.close();
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
