// Navigateur sign-in: Chrome identity (user agent, client hints, navigator.userAgentData) and real pop-up windows
// for « Se connecter avec … » flows (window.opener, postMessage, window.close, shared cookies), against a local
// fake OAuth provider. The provider runs on http://localhost:<port>, the client site on http://127.0.0.1:<port>
// (two different sites, like accounts.google.com and the site using it).
//   xvfb-run -a -s "-screen 0 1600x900x24" node test/browser-signin.test.mjs [--only=name] [--no-shots]
// Screenshots (FR, Halo, dark + light, 1280x720, real aurora-xwm framing): test/out/browser-signin-popup-fr-*.png
import { launchShell, OUT } from './lib.mjs';
import http from 'node:http';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const identity = require('../main/lib/chrome-identity.js');
const only = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
const noShots = process.argv.includes('--no-shots');
const results = [];

function startServer() {
  const server = http.createServer((req, res) => {
    const port = server.address().port;
    const CLIENT = `http://127.0.0.1:${port}`;
    const IDP = `http://localhost:${port}`;
    const url = new URL(req.url, 'http://x');
    const page = (title, body, headers = {}) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...headers });
      res.end(`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>body{font:15px system-ui,sans-serif;margin:28px;color:#1b1b1b;background:#fff}button{font:inherit;padding:8px 16px;border-radius:8px;border:1px solid #0b57d0;background:#0b57d0;color:#fff}.card{max-width:420px;padding:20px;border:1px solid #ddd;border-radius:12px}</style></head><body>${body}</body></html>`);
    };
    const echo = () => `<pre id="h">${JSON.stringify(req.headers).replace(/</g, '&lt;')}</pre>`;
    switch (url.pathname) {
      case '/echo':
        return page('Echo', echo());
      case '/ach':
        return page('ACH', echo(), { 'accept-ch': 'Sec-CH-UA-Full-Version-List, Sec-CH-UA-Platform-Version, Sec-CH-UA-Arch' });
      case '/critical':
        return page(req.headers['sec-ch-ua-bitness'] ? 'bitness ok' : 'no bitness', echo(), { 'accept-ch': 'Sec-CH-UA-Bitness', 'critical-ch': 'Sec-CH-UA-Bitness' });
      case '/frame':
        return page('Frame', `<iframe id="f" src="${IDP}/echo" width="600" height="200"></iframe>`);
      case '/whoami':
        return page('Who', `<p id="c">${String(req.headers.cookie || '').replace(/</g, '&lt;')}</p>`);
      case '/client':
        return page(
          'Fake client',
          `<div class="card"><h2>Exemple</h2><button id="signin">Se connecter avec Fake ID</button> <a id="plain" href="/whoami" target="_blank">lien</a>
<iframe id="who" src="${IDP}/whoami" width="380" height="60"></iframe></div>
<script>
window.__events = [];
document.getElementById('signin').onclick = () => {
  const w = window.open('${IDP}/authorize?client=demo', 'fakeid', 'width=460,height=520,left=120,top=80');
  window.__popupReturned = !!w;
  const t = setInterval(() => { if (w && w.closed) { clearInterval(t); window.__closed = true; } }, 100);
};
window.addEventListener('message', (e) => {
  window.__events.push({ origin: e.origin, data: e.data, hasSource: !!e.source });
  if (e.data && e.data.code) document.title = 'Signed in ' + e.data.code;
});
</script>`,
        );
      case '/authorize':
        return page(
          'Fake ID - Connexion',
          `<div class="card"><h2>Fake ID</h2><p>Exemple souhaite accéder à votre compte.</p><button id="allow">Continuer</button></div>
<script>window.__hasOpener = !!window.opener; document.getElementById('allow').onclick = () => { location = '/callback?code=abc123'; };</script>`,
          { 'set-cookie': 'idp=1; Path=/; SameSite=None; Secure' },
        );
      case '/callback':
        return page(
          'Fake ID',
          `<p>OK</p><script>
const msg = { code: new URLSearchParams(location.search).get('code'), cookie: document.cookie, ua: navigator.userAgent };
if (window.opener) window.opener.postMessage(msg, '${CLIENT}');
setTimeout(() => window.close(), 150);
</script>`,
        );
      default:
        res.writeHead(404);
        return res.end('not found');
    }
  });
  return new Promise((r) =>
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      r({ server, port, client: `http://127.0.0.1:${port}`, idp: `http://localhost:${port}` });
    }),
  );
}

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
  }
}

const CTL = `window.__aurora.registry.instance(window.__aurora.wm.byApp('browser')[0].id).hooks.ctl`;
function harness(s) {
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
  const go = async (url, title) => {
    await run(`bw.navigate(bw.active, ${JSON.stringify(url)})`);
    await waitFor(() => run(`!bw.active.web.loading && bw.active.web.title === ${JSON.stringify(title)}`), { msg: `page « ${title} »` });
  };
  // Pop-up windows (BrowserWindows other than the shell) in the main process.
  const popups = () =>
    s.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .filter((w) => !w.isDestroyed() && w.webContents.getType() === 'window' && /\/(authorize|callback)/.test(w.webContents.getURL()))
        .map((w) => ({ id: w.id, wcId: w.webContents.id, url: w.webContents.getURL(), title: w.getTitle(), bounds: w.getContentBounds(), visible: w.isVisible() })),
    );
  const popupJs = (wcId, code) => s.app.evaluate(({ webContents }, { wcId, code }) => webContents.fromId(wcId).executeJavaScript(code, true), { wcId, code });
  return { run, waitFor, pageJs, go, popups, popupJs };
}

const srv = await startServer();
console.log(`Fake client ${srv.client}, fake provider ${srv.idp}`);

// ======== Session 1: identity + pop-up flow (English, light)
if (!only.length || only.some((o) => !o.startsWith('screenshot'))) {
  const s = await launchShell({ open: ['browser'], theme: 'light', lang: 'en' });
  const h = harness(s);
  const { run, waitFor, pageJs, go, popups, popupJs } = h;
  await waitFor(() => run('bw.tabs.length === 1 && !!bw.active'), { msg: 'browser window' });
  const chrome = await s.app.evaluate(() => process.versions.chrome);
  const major = chrome.split('.')[0];
  console.log(`Session 1 (Chromium ${chrome})`);

  await test('request headers: Chrome user agent and Sec-CH-UA hints with « Google Chrome » (no Electron)', async () => {
    await go(`${srv.client}/echo`, 'Echo');
    const hd = JSON.parse(await pageJs("document.getElementById('h').textContent"));
    assert(hd['user-agent'] === `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`, hd['user-agent']);
    assert(!/electron|aurora|selene/i.test(JSON.stringify(hd)), 'no Electron / app token in any header');
    assert(hd['sec-ch-ua'] === identity.hintValues(chrome)['sec-ch-ua'], `sec-ch-ua ${hd['sec-ch-ua']}`);
    assert(hd['sec-ch-ua'].includes(`"Google Chrome";v="${major}"`) && hd['sec-ch-ua'].includes(`"Chromium";v="${major}"`), hd['sec-ch-ua']);
    assert(hd['sec-ch-ua-mobile'] === '?0' && hd['sec-ch-ua-platform'] === '"Linux"', 'mobile / platform');
    assert(!hd['sec-ch-ua-full-version-list'], 'no high-entropy hint before the site asks');
    assert(hd['accept-language'] === 'en-US,en;q=0.9', `accept-language ${hd['accept-language']}`);
  });

  await test('Accept-CH: high-entropy hints once the site asked; Critical-CH retries the page once', async () => {
    await go(`${srv.client}/ach`, 'ACH');
    await go(`${srv.client}/echo`, 'Echo');
    const hd = JSON.parse(await pageJs("document.getElementById('h').textContent"));
    assert(hd['sec-ch-ua-full-version-list']?.includes(`"Google Chrome";v="${chrome}"`), `full version list ${hd['sec-ch-ua-full-version-list']}`);
    assert(hd['sec-ch-ua-arch'] === '"x86"' && /^"\d+\.\d+\.\d+"$/.test(hd['sec-ch-ua-platform-version'] || ''), 'arch / platform version');
    assert(!hd['sec-ch-ua-model'], 'only the hints asked for');
    await go(`${srv.client}/critical`, 'bitness ok');
  });

  await test('navigator.userAgentData / getHighEntropyValues / languages / window.chrome like Chrome', async () => {
    const r = await pageJs(`(async () => ({
      ua: navigator.userAgent, platform: navigator.platform, vendor: navigator.vendor, webdriver: navigator.webdriver,
      brands: navigator.userAgentData.brands, mobile: navigator.userAgentData.mobile, uaPlatform: navigator.userAgentData.platform,
      hev: await navigator.userAgentData.getHighEntropyValues(['architecture', 'bitness', 'fullVersionList', 'platformVersion', 'uaFullVersion', 'model', 'wow64']),
      langs: navigator.languages, chromeKeys: Object.keys(window.chrome || {}), csi: typeof window.chrome?.csi?.()?.startE, lt: typeof window.chrome?.loadTimes?.()?.requestTime,
      workerBrands: await new Promise((res) => { const w = new Worker(URL.createObjectURL(new Blob(['postMessage(navigator.userAgentData.brands.map(b => b.brand))'], { type: 'text/javascript' }))); w.onmessage = (e) => res(e.data); setTimeout(() => res('timeout'), 3000); }),
    }))()`);
    const want = identity.brands(false, chrome);
    assert(JSON.stringify(r.brands) === JSON.stringify(want), `brands ${JSON.stringify(r.brands)}`);
    assert(JSON.stringify(r.hev.fullVersionList) === JSON.stringify(identity.brands(true, chrome)), `fullVersionList ${JSON.stringify(r.hev.fullVersionList)}`);
    assert(r.hev.uaFullVersion === chrome && r.hev.architecture === 'x86' && r.hev.bitness === '64' && r.hev.model === '' && r.hev.wow64 === false, JSON.stringify(r.hev));
    assert(r.uaPlatform === 'Linux' && r.mobile === false && r.platform === 'Linux x86_64' && r.vendor === 'Google Inc.', JSON.stringify(r));
    // navigator.webdriver is true here only because Playwright starts Electron with --remote-debugging-port; Selene
    // never does (checked without Playwright: false, with the DevTools-protocol override attached).
    if (r.webdriver !== false) console.log('      (navigator.webdriver is true under Playwright: --remote-debugging-port)');
    assert(r.langs[0] === 'en-US' && r.langs.includes('en'), `languages ${r.langs}`);
    assert(['app', 'csi', 'loadTimes'].every((k) => r.chromeKeys.includes(k)) && r.csi === 'number' && r.lt === 'number', `window.chrome ${r.chromeKeys}`);
    assert(Array.isArray(r.workerBrands) && r.workerBrands.includes('Google Chrome'), `worker brands ${JSON.stringify(r.workerBrands)}`);
  });

  await test('cross-site iframe (separate process) has the same brands and hints', async () => {
    await go(`${srv.client}/frame`, 'Frame');
    const wcId = await run('bw.active.wcId');
    const r = await waitFor(
      () =>
        s.app.evaluate(async ({ webContents }, id) => {
          const f = webContents.fromId(id).mainFrame.frames[0];
          if (!f || !/\/echo/.test(f.url)) return null;
          return { brands: await f.executeJavaScript('navigator.userAgentData.brands.map((b) => b.brand)'), headers: JSON.parse(await f.executeJavaScript("document.getElementById('h').textContent")), pid: f.osProcessId, top: webContents.fromId(id).mainFrame.osProcessId };
        }, wcId),
      { msg: 'iframe loaded' },
    );
    assert(r.brands.includes('Google Chrome'), `iframe brands ${r.brands}`);
    assert(r.headers['sec-ch-ua']?.includes('"Google Chrome"'), 'iframe request has sec-ch-ua');
    if (r.pid === r.top) console.log('      (note: the iframe shares the page process here)');
  });

  await test('« Se connecter avec … » pop-up: real window, window.opener + postMessage, window.close, same session', async () => {
    // A cookie the provider set earlier in the normal browser session (as if already signed in to it).
    await s.app.evaluate(({ session }, url) => session.fromPartition('persist:browser').cookies.set({ url, name: 'pre', value: '1' }), srv.idp);
    await go(`${srv.client}/client`, 'Fake client');
    const tabs = await run('bw.tabs.length');
    await pageJs("document.getElementById('signin').click()");
    const [p] = await waitFor(async () => {
      const l = await popups();
      return l.length && l[0].url.includes('/authorize') ? l : null;
    }, { msg: 'pop-up window' });
    assert(p.visible, 'pop-up shown');
    assert(p.bounds.width === 460 && p.bounds.height === 520, `size from the window features ${JSON.stringify(p.bounds)}`);
    assert((await run('bw.tabs.length')) === tabs, 'no new tab');
    assert(await pageJs('window.__popupReturned === true'), 'window.open returned the window');
    await waitFor(() => popups().then((l) => l[0]?.title.startsWith('localhost') && l[0].title), { msg: 'title starts with the real site' });
    const hasOpener = await popupJs(p.wcId, 'window.__hasOpener');
    assert(hasOpener === true, 'the pop-up page has window.opener');
    await popupJs(p.wcId, "document.getElementById('allow').click()");
    const title = await waitFor(() => run('bw.active.web.title.startsWith("Signed in") && bw.active.web.title'), { msg: 'opener got the message' });
    assert(title === 'Signed in abc123', title);
    const ev = await pageJs('window.__events[0]');
    assert(ev.origin === srv.idp && ev.hasSource, `message origin ${ev.origin}`);
    assert(/(^|; )pre=1/.test(ev.data.cookie) && /(^|; )idp=1/.test(ev.data.cookie), `pop-up shares the session cookies (${ev.data.cookie})`);
    assert(!/electron/i.test(ev.data.ua), 'pop-up user agent');
    await waitFor(async () => (await popups()).length === 0, { msg: 'window.close() closed the pop-up' });
    await waitFor(() => pageJs('window.__closed === true'), { msg: 'opener sees popup.closed' });
    const cookies = await s.app.evaluate(({ session }, url) => session.fromPartition('persist:browser').cookies.get({ url }).then((c) => c.map((x) => x.name)), srv.idp);
    assert(cookies.includes('idp'), 'the cookie the pop-up got is in the browser session');
  });

  await test('third-party cookies and storage access behave like Chrome (allowed by default)', async () => {
    await run('bw.reload()');
    await waitFor(() => run('!bw.active.web.loading'), { msg: 'reloaded' });
    const wcId = await run('bw.active.wcId');
    const r = await waitFor(
      () =>
        s.app.evaluate(async ({ webContents }, id) => {
          const f = webContents.fromId(id).mainFrame.frames[0];
          if (!f || !/whoami/.test(f.url)) return null;
          return { cookie: await f.executeJavaScript("document.getElementById('c').textContent"), access: await f.executeJavaScript('document.hasStorageAccess()'), req: await f.executeJavaScript('document.requestStorageAccess().then(() => "granted", (e) => "refused " + e)', true) };
        }, wcId),
      { msg: 'third-party frame' },
    );
    assert(/idp=1/.test(r.cookie), `third-party request carries the SameSite=None cookie (${r.cookie})`);
    assert(r.req === 'granted', `requestStorageAccess ${r.req}`);
    console.log(`      hasStorageAccess: ${r.access}`);
  });

  await test('plain target=_blank links still open as tabs', async () => {
    const n = await run('bw.tabs.length');
    await pageJs("document.getElementById('plain').click()");
    await waitFor(() => run(`bw.tabs.length === ${n + 1}`), { msg: 'new tab' });
    assert((await popups()).length === 0, 'no pop-up window');
    await run('bw.closeTab(bw.active)');
  });

  await test('pop-up windows: at most 3 per tab (more open as before), no fullscreen, no shell events', async () => {
    await go(`${srv.client}/client`, 'Fake client');
    const wins = () => s.page.evaluate("window.__aurora.wm.byApp('browser').length");
    const n = await wins();
    const open = (i) => pageJs(`window.open('${srv.idp}/authorize?client=cap${i}', 'cap${i}', 'width=420,height=400'), true`);
    await s.page.waitForTimeout(1200); // past the 3-per-second flood limit of the earlier tests
    for (const i of [1, 2, 3]) await open(i);
    const l = await waitFor(async () => {
      const p = await popups();
      return p.filter((w) => /client=cap/.test(w.url)).length === 3 ? p : null;
    }, { msg: '3 pop-up windows' });
    await s.page.waitForTimeout(1200); // past the 3-per-second flood limit
    await open(4);
    // The 4th: as before this change, a small Navigateur window of the shell (renderer/apps/browser/lib/window.js).
    await waitFor(async () => (await wins()) === n + 1, { msg: 'the 4th opened in a Navigateur window' });
    assert((await popups()).filter((w) => /client=cap/.test(w.url)).length === 3, 'still 3 pop-up windows');
    const fs = await popupJs(l[0].wcId, 'Promise.race([document.documentElement.requestFullscreen().then(() => "fullscreen", () => "refused"), new Promise((r) => setTimeout(() => r(document.fullscreenElement ? "fullscreen (no answer)" : "no answer"), 3000))])');
    // Electron leaves the page's promise pending when fullscreen is refused (« no answer »); without the refusal the
    // pop-up covered the whole screen (« fullscreen »).
    assert(!/^fullscreen/.test(fs), `fullscreen in a pop-up: ${fs}`);
    const marked = await s.app.evaluate(({ webContents }, id) => webContents.fromId(id).__auroraWebPage === true, l[0].wcId);
    assert(marked, 'pop-up marked as a web page (main/lib/ipc.js broadcast skips it)');
    await s.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => /client=cap/.test(w.webContents.getURL())).forEach((w) => w.close()));
    await waitFor(async () => (await popups()).length === 0, { msg: 'pop-ups closed' });
    await s.page.evaluate("window.__aurora.wm.byApp('browser').slice(1).forEach((w) => w.close())");
    await waitFor(async () => (await wins()) === n, { msg: 'extra Navigateur window closed' });
  });

  await test('French: Accept-Language and navigator.languages follow the language', async () => {
    await run('window.__aurora.settings.set("lang", "fr")');
    await s.page.waitForTimeout(800);
    await go(`${srv.client}/echo`, 'Echo');
    const hd = JSON.parse(await pageJs("document.getElementById('h').textContent"));
    assert(hd['accept-language'] === 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7', `accept-language ${hd['accept-language']}`);
    const langs = await pageJs('navigator.languages');
    assert(langs[0] === 'fr-FR' && langs.includes('fr'), `languages ${langs}`);
    await run('window.__aurora.settings.set("lang", "en")');
  });

  await test('no renderer errors', async () => {
    const errs = s.logs.filter((l) => /^\[(error|pageerror)\]/.test(l) && !/Failed to load resource/.test(l));
    assert(!errs.length, errs.join('\n'));
  });
  await s.close();
}

// ======== Sessions 2-3: screenshots with the real window manager (pop-up framed by the shell), FR Halo dark + light
if (!noShots) {
  for (const theme of ['dark', 'light']) {
    const s = await launchShell({ open: ['browser'], theme, lang: 'fr', size: '1280x720', settings: { finish: 'halo' }, env: { AURORA_XWM: '1' } });
    const { run, waitFor, pageJs, go, popups } = harness(s);
    await test(`screenshot: sign-in pop-up framed as a Navigateur window (FR, Halo ${theme})`, async () => {
      await waitFor(() => run('bw.tabs.length === 1 && !!bw.active'), { msg: 'browser window' });
      await run('bw.win.maximize()');
      await go(`${srv.client}/client`, 'Fake client');
      await pageJs("document.getElementById('signin').click()");
      await waitFor(async () => (await popups()).length === 1, { msg: 'pop-up window' });
      const frame = await waitFor(
        () => s.page.evaluate(() => window.__aurora.wm.byApp('browser').map((w) => ({ id: w.id, title: w.title || w.el?.querySelector('.win-title, .title')?.textContent || '', xwin: w.xwin ?? null })).find((w) => w.xwin != null)),
        { timeout: 15000, msg: 'the shell frames the pop-up as a Navigateur window' },
      );
      await s.page.waitForTimeout(1200);
      const b = await s.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith('app://')).getContentBounds());
      const file = path.join(OUT, `browser-signin-popup-fr-${theme}.png`);
      execFileSync('import', ['-window', 'root', '-crop', `${b.width}x${b.height}+${b.x}+${b.y}`, '+repage', file]);
      console.log(`      ${file} (frame: ${JSON.stringify(frame)})`);
    });
    await s.close();
  }
}

srv.server.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
