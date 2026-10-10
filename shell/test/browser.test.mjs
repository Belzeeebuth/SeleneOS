// Aurora Browser functional tests: drives the real shell (Electron + Playwright) against a local
// HTTP test server, plus an optional real-HTTPS check.
//   xvfb-run -a -s "-screen 0 1600x900x24" node test/browser.test.mjs [--only=name,name] [--keep]
// Screenshots: test/out/browser-*.png, and the reference ones are copied to docs/screenshots/.
import { launchShell, OUT } from './lib.mjs';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const DOCS_SHOTS = path.join(here, '..', '..', 'docs', 'screenshots');
const only = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
const results = [];
const notes = [];

// ------------------------------------------------------------------ local test server
function wav(seconds = 2, freq = 440) {
  const rate = 22050;
  const n = rate * seconds;
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + n * 2, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 6000), 44 + i * 2);
  return b;
}
const TONE = wav();

function startServer() {
  const favicon = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="#e5533d"/><circle cx="8" cy="8" r="4" fill="#fff"/></svg>';
  const page = (title, body, head = '') =>
    `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><link rel="icon" href="/favicon.svg">${head}<style>body{font:16px system-ui,sans-serif;margin:40px;line-height:1.5;color:#1b1b1b}h1{font-weight:600}a{display:inline-block;margin:6px 14px 6px 0;color:#0b57d0}.card{max-width:720px;padding:20px 24px;border:1px solid #ddd;border-radius:12px;background:#fafafa}</style></head><body>${body}</body></html>`;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const html = (status, s) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
      res.end(s);
    };
    if (url.pathname === '/favicon.svg') {
      res.writeHead(200, { 'content-type': 'image/svg+xml' });
      return res.end(favicon);
    }
    if (url.pathname === '/') {
      return html(
        200,
        page(
          'Aurora Test Page',
          `<div class="card"><h1>Aurora test page</h1><p>The aurora borealis is an aurora seen in the north. Aurora!</p>
<p><a id="next" href="/page2">Next page</a><a id="blank" href="/page2?from=blank" target="_blank">Open in new tab</a><a id="dl" href="/file.bin">Download file</a><a id="dlblank" href="/file.bin?n=2" target="_blank">Download in new tab</a></p>
<p><button id="pop" onclick="window.open('/page2?from=popup','_blank','width=420,height=320')">Pop-up window</button> <button id="fs" onclick="document.documentElement.requestFullscreen()">Full screen</button></p>
<p><img id="img" src="/favicon.svg" width="64" height="64" alt="logo"></p></div><p style="height:1400px">Long content</p>`,
        ),
      );
    }
    if (url.pathname === '/page2') return html(200, page('Second Page', `<div class="card"><h1>Second page</h1><p>Query: ${url.search.replace(/[<>&]/g, '')}</p><a id="home" href="/">Home</a></div>`));
    if (url.pathname === '/file.bin') {
      const total = 3 * 1024 * 1024;
      const n = url.searchParams.get('n');
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': total, 'content-disposition': `attachment; filename="aurora-test${n ? `-${n}` : ''}.bin"` });
      let sent = 0;
      const chunk = Buffer.alloc(48 * 1024, 65);
      const iv = setInterval(() => {
        if (res.destroyed) return clearInterval(iv);
        const k = Math.min(chunk.length, total - sent);
        res.write(chunk.subarray(0, k));
        sent += k;
        if (sent >= total) {
          clearInterval(iv);
          res.end();
        }
      }, 40);
      return;
    }
    if (url.pathname === '/tone.wav') {
      res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': TONE.length });
      return res.end(TONE);
    }
    if (url.pathname === '/audio') return html(200, page('Audio page', '<audio id="a" loop controls src="/tone.wav"></audio>'));
    if (url.pathname === '/perm') return html(200, page('Permission page', `<button id="b" onclick="Notification.requestPermission().then((r) => (document.title = 'perm:' + r))">Ask</button>`));
    if (url.pathname === '/popups') return html(200, page('Popups page', `<button id="b" onclick="for (let i = 0; i < 5; i++) window.open('/page2?spam=' + i)">Spam</button>`));
    if (url.pathname === '/data') {
      return html(
        200,
        page('Data page', `<button id="html" onclick="window.open('data:text/html,<title>phish</title><h1>Sign in</h1>')">html</button><button id="img" onclick="window.open('data:image/png;base64,iVBORw0KGgo=')">img</button>`),
      );
    }
    if (url.pathname === '/xss') return html(200, page('&lt;img src=x onerror="window.top.__pwned=1"&gt;', '<a id="a" href="/">home</a>'));
    if (url.pathname === '/dialogs') {
      return html(
        200,
        page(
          'Dialogs page',
          `<button id="alert" onclick="alert('Hello from the page'); document.title = 'alert:done'">alert</button>
<button id="confirm" onclick="document.title = 'confirm:' + confirm('Delete everything?')">confirm</button>
<button id="prompt" onclick="document.title = 'prompt:' + prompt('Your name?', 'Ada')">prompt</button>`,
        ),
      );
    }
    if (url.pathname === '/auth2') {
      // Separate realm and credentials: the cached ones of /auth never match.
      if (req.headers.authorization === `Basic ${Buffer.from('ada:lovelace').toString('base64')}`) return html(200, page('Authorized 2', '<h1>Welcome</h1>'));
      res.writeHead(401, { 'www-authenticate': 'Basic realm="Aurora second"', 'content-type': 'text/html' });
      return res.end(page('Denied', 'denied'));
    }
    if (url.pathname === '/auth') {
      if (req.headers.authorization === `Basic ${Buffer.from('aurora:secret').toString('base64')}`) return html(200, page('Authorized', '<h1>Welcome</h1>'));
      res.writeHead(401, { 'www-authenticate': 'Basic realm="Aurora test"', 'content-type': 'text/html' });
      return res.end(page('Denied', 'denied'));
    }
    return html(404, page('Not found', '<h1>404</h1>'));
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, port: server.address().port, url: `http://127.0.0.1:${server.address().port}` })));
}

function freePort() {
  return new Promise((r) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => r(p));
    });
  });
}

// ------------------------------------------------------------------ helpers
function assert(cond, msg) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

async function test(name, fn) {
  if (only.length && !only.some((o) => name.startsWith(o))) return;
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - t0 });
    console.log(`  ✔ ${name} (${Date.now() - t0} ms)`);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.log(`  ✘ ${name}\n      ${String(err?.stack || err).split('\n').slice(0, 4).join('\n      ')}`);
  }
}

const CTL = (i = 0) => `window.__aurora.registry.instance(window.__aurora.wm.byApp('browser')[${i}].id).hooks.ctl`;

function harness(s) {
  const run = (expr, i = 0) => s.page.evaluate(`(async () => { const bw = ${CTL(i)}; const shared = bw.store && (await import('app://shell/apps/browser/lib/shared.js')).shared; return (${expr}); })()`);
  const waitFor = async (expr, { timeout = 8000, i = 0, msg } = {}) => {
    const t0 = Date.now();
    let last;
    while (Date.now() - t0 < timeout) {
      try {
        last = await run(expr, i);
        if (last) return last;
      } catch (e) {
        last = e.message;
      }
      await s.page.waitForTimeout(100);
    }
    throw new Error(`Timed out waiting for ${msg || expr} (last: ${JSON.stringify(last)})`);
  };
  // Real keyboard input inside the focused tab's page (CDP key events bypass before-input-event).
  const guestKey = async (keyCode, modifiers = [], i = 0) => {
    const id = await run('bw.isWeb(bw.active) && bw.active.ready ? bw.active.wcId : null', i);
    if (id == null) {
      // Internal page: the key goes to the shell document like a real key press would.
      await s.page.waitForTimeout(200);
      await run('bw.omni.editing || document.activeElement?.closest?.(".bw-find") ? null : bw.active.pageEl?.focus()', i);
      const mods = modifiers.map((m) => ({ control: 'Control', shift: 'Shift', alt: 'Alt' })[m]);
      await s.page.keyboard.press([...mods, keyCode].join('+'));
      await s.page.waitForTimeout(150);
      return;
    }
    await s.app.evaluate(({ webContents }, { id, keyCode, modifiers }) => {
      const g = webContents.fromId(id);
      g.focus();
      g.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
      g.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    }, { id, keyCode, modifiers });
    await s.page.waitForTimeout(150);
  };
  const pageJs = (code, i = 0) => run(`bw.active.wv.executeJavaScript(${JSON.stringify(code)}, true)`, i);
  const errors = () => s.logs.filter((l) => /^\[(error|pageerror)\]/.test(l) && !/Failed to load resource/.test(l));
  return { run, waitFor, guestKey, pageJs, errors };
}

function copyShot(file, name) {
  fs.mkdirSync(DOCS_SHOTS, { recursive: true });
  fs.copyFileSync(file, path.join(DOCS_SHOTS, `${name}.png`));
}

// English UI strings (app + core dictionaries) that have a different French translation: any of
// them visible while the UI is in French is an untranslated string.
function englishPatterns() {
  const root = path.join(here, '..', 'renderer');
  const flat = (o, p = '', out = {}) => {
    for (const [k, v] of Object.entries(o)) {
      if (v && typeof v === 'object') flat(v, `${p}${k}.`, out);
      else out[p + k] = v;
    }
    return out;
  };
  const app = JSON.parse(fs.readFileSync(path.join(root, 'apps', 'browser', 'i18n.json'), 'utf8'));
  const coreEn = flat(JSON.parse(fs.readFileSync(path.join(root, 'core', 'i18n', 'en.json'), 'utf8')));
  const coreFr = flat(JSON.parse(fs.readFileSync(path.join(root, 'core', 'i18n', 'fr.json'), 'utf8')));
  const vals = [...Object.entries(app.en).filter(([k, v]) => app.fr[k] !== v), ...Object.entries(coreEn).filter(([k, v]) => typeof v === 'string' && coreFr[k] !== v)].map(([, v]) => v);
  return vals
    .filter((v) => v.replace(/\{[^}]+\}/g, '').trim().length >= 3)
    .map((v) => `^${v.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\\?\{[^}]+\\?\}/g, '.*')}$`);
}

/** Visible texts / labels of the browser UI (window, its menus, flyouts and dialogs) matching English strings. */
async function findEnglish(s, pats) {
  return s.page.evaluate((pats) => {
    const res = pats.map((p) => new RegExp(p));
    const found = new Set();
    const roots = [...document.querySelectorAll('.app-browser, .menu, .dialog-layer')];
    for (const root of roots) {
      const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = w.nextNode())) {
        const t = n.textContent.trim();
        const el = n.parentElement;
        if (!t || !el || !el.getClientRects().length || el.closest('webview')) continue;
        if (res.some((r) => r.test(t))) found.add(t);
      }
      for (const el of root.querySelectorAll('[aria-label], [placeholder], [data-tip]')) {
        for (const a of ['aria-label', 'placeholder', 'data-tip']) {
          const v = el.getAttribute(a);
          if (v && res.some((r) => r.test(v))) found.add(`${a}=${v}`);
        }
      }
    }
    return [...found];
  }, pats);
}

/** Elements of the browser window whose content overflows horizontally (clipped or spilling text). */
function overflowing(s) {
  return s.page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('.app-browser.win *')) {
      if (!el.getClientRects().length || el.closest('.bw-tab, svg')) continue;
      const cs = getComputedStyle(el);
      if (cs.overflowX !== 'visible' || cs.textOverflow === 'ellipsis' || el.classList.contains('ellipsis')) continue;
      if (el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1) out.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ').slice(0, 2).join('.')} ${el.scrollWidth}>${el.clientWidth}`);
    }
    return out.slice(0, 12);
  });
}

// ------------------------------------------------------------------ tests
const srv = await startServer();
const deadPort = await freePort();
console.log(`Local test server: ${srv.url}`);

// ======== Session 1: light / English, normal window
{
  const s = await launchShell({ open: ['browser'], theme: 'light', lang: 'en' });
  const { run, waitFor, guestKey, pageJs, errors } = harness(s);
  await waitFor('bw.tabs.length === 1 && bw.active && document.querySelector(".app-browser .bp-ntp")', { msg: 'browser window' });
  console.log('Session 1 (light, en)');

  await test('new tab page renders (logo, search box, shortcut tiles, favorites bar)', async () => {
    const info = await run(`({
      tiles: document.querySelectorAll('.app-browser .bp-tile:not(.add)').length,
      placeholder: document.querySelector('.app-browser .bp-ntp-input').placeholder,
      omniFocused: document.activeElement === bw.omni.input,
      favs: [...document.querySelectorAll('.app-browser .bw-favbar .bw-fav-label')].map((x) => x.textContent),
      title: bw.win.title,
      tabTitle: bw.active.el.textContent,
    })`);
    assert(info.tiles >= 5, `>= 5 tiles (got ${info.tiles})`);
    assert(/DuckDuckGo/.test(info.placeholder), 'NTP placeholder mentions DuckDuckGo');
    assert(info.omniFocused, 'omnibox focused on a new tab');
    for (const f of ['Wikipedia', 'DuckDuckGo', 'OpenStreetMap', 'MDN Web Docs', 'Ubuntu', 'Aurora OS']) assert(info.favs.includes(f), `seed favorite ${f}`);
    assert(/New tab - Aurora Browser/.test(info.title), `window title (${info.title})`);
    await s.page.waitForTimeout(400);
    copyShot(await s.shot('browser-newtab'), 'browser-newtab');
  });

  await test('omnibox: URL vs search classification', async () => {
    const r = await s.page.evaluate(async () => {
      const { classify } = await import('app://shell/apps/browser/lib/util.js');
      const c = (x) => {
        const v = classify(x, 'duckduckgo');
        return `${v.type}|${v.url}`;
      };
      return {
        host: c('example.com'),
        path: c('wikipedia.org/wiki/Aurora'),
        words: c('aurora borealis'),
        word: c('weather'),
        localhost: c('localhost:8080/x'),
        ip: c('192.168.1.10'),
        js: c('node.js'),
        scheme: c('http://example.org/a b'),
        internal: c('aurora://settings'),
        edge: c('edge://history'),
        file: c('file:///etc/passwd'),
        mail: c('mailto:a@b.c'),
        intranet: c('intranet/'),
        vs: c('view-source:example.com'),
      };
    });
    assert(r.host === 'url|https://example.com/', `example.com -> ${r.host}`);
    assert(r.path === 'url|https://wikipedia.org/wiki/Aurora', r.path);
    assert(r.words === 'search|https://duckduckgo.com/?q=aurora+borealis', r.words);
    assert(r.word.startsWith('search|'), r.word);
    assert(r.localhost === 'url|http://localhost:8080/x', r.localhost);
    assert(r.ip === 'url|http://192.168.1.10/', r.ip);
    assert(r.js.startsWith('search|'), `node.js is a search (${r.js})`);
    assert(r.scheme === 'url|http://example.org/a%20b', r.scheme);
    assert(r.internal === 'internal|aurora://settings', r.internal);
    assert(r.edge === 'internal|aurora://history', r.edge);
    assert(r.file.startsWith('blocked|'), r.file);
    assert(r.mail.startsWith('external|'), r.mail);
    assert(r.intranet === 'url|http://intranet/', r.intranet);
    assert(r.vs === 'url|view-source:https://example.com/', r.vs);
  });

  await test('typing a URL in the omnibox loads the page (title, favicon, history, security chip)', async () => {
    await s.page.click('.app-browser .bw-omni-input');
    await s.page.keyboard.type(`127.0.0.1:${srv.port}/`);
    await s.page.waitForSelector('.app-browser .bw-suggest:not([hidden]) .bw-sug.sel');
    await s.page.keyboard.press('Enter');
    await waitFor(`bw.active.web.title === 'Aurora Test Page' && !bw.active.web.loading`, { msg: 'page load' });
    await waitFor('bw.active.web.favicon && bw.active.el.querySelector(".bw-tab-icon img")', { msg: 'favicon' });
    const info = await run(`({ url: bw.active.web.url, omni: bw.omni.input.value, site: bw.omni.siteBtn.className, hist: bw.store.history.has('${srv.url}/'), histTitle: bw.store.history.get('${srv.url}/')?.title, back: !bw.backBtn.disabled })`);
    assert(info.url === `${srv.url}/`, `url ${info.url}`);
    assert(info.omni === `${srv.url}/`, `omnibox shows the URL (${info.omni})`);
    assert(/local/.test(info.site), `local http site chip (${info.site})`);
    assert(info.hist && info.histTitle === 'Aurora Test Page', 'history entry with title');
    assert(info.back, 'back enabled (goes back to the new tab page)');
  });

  await test('links, back and forward (web history + internal new tab page)', async () => {
    await pageJs("document.getElementById('next').click()");
    await waitFor(`bw.active.web.title === 'Second Page'`, { msg: 'second page' });
    await s.page.click('.app-browser .bw-tbtn[aria-label="Back"]');
    await waitFor(`bw.active.web.title === 'Aurora Test Page'`, { msg: 'back to first page' });
    assert(await run('!bw.fwdBtn.disabled'), 'forward enabled');
    await guestKey('Right', ['alt']);
    await waitFor(`bw.active.web.title === 'Second Page'`, { msg: 'Alt+Right forward' });
    await guestKey('Left', ['alt']);
    await waitFor(`bw.active.web.title === 'Aurora Test Page'`, { msg: 'Alt+Left back' });
    await run('bw.goBack()');
    await waitFor(`bw.entry(bw.active).route === 'newtab'`, { msg: 'back to new tab page' });
    await run('bw.goForward()');
    await waitFor(`bw.isWeb(bw.active) && bw.active.web.title === 'Aurora Test Page'`, { msg: 'forward to web page' });
  });

  await test('back / forward buttons: right-click lists the tab history with page titles', async () => {
    await s.page.click('.app-browser .bw-tbtn[aria-label="Forward"]', { button: 'right' });
    await s.page.waitForSelector('.bw-menu .menu-item');
    let labels = await s.page.$$eval('.bw-menu .menu-item .label', (els) => els.map((e) => e.textContent));
    assert(labels[0] === 'Second Page' && labels.includes('Show full history'), `forward list (${labels})`);
    await s.page.keyboard.press('Escape');
    await waitFor('!document.querySelector(".bw-menu")', { msg: 'menu closed' });
    await s.page.click('.app-browser .bw-tbtn[aria-label="Back"]', { button: 'right' });
    await s.page.waitForSelector('.bw-menu .menu-item');
    labels = await s.page.$$eval('.bw-menu .menu-item .label', (els) => els.map((e) => e.textContent));
    assert(labels[0] === 'New tab', `back list goes to the new tab page (${labels})`);
    await s.page.keyboard.press('Escape');
    // Pick an entry from the forward list.
    await s.page.click('.app-browser .bw-tbtn[aria-label="Forward"]', { button: 'right' });
    await s.page.locator('.bw-menu .menu-item', { hasText: 'Second Page' }).click();
    await waitFor('bw.active.web.title === "Second Page" && !bw.active.web.loading', { msg: 'went forward from the list' });
    await run('bw.goBack()');
    await waitFor('bw.active.web.title === "Aurora Test Page" && !bw.active.web.loading', { msg: 'back to the test page' });
  });

  await test('link with target=_blank opens a new foreground tab next to its opener', async () => {
    await pageJs("document.getElementById('blank').click()");
    await waitFor('bw.tabs.length === 2 && bw.active.web.title === "Second Page"', { msg: 'new tab' });
    const r = await run('({ idx: bw.tabs.indexOf(bw.active), url: bw.active.web.url, opener: bw.active.openerId === bw.tabs[0].id })');
    assert(r.idx === 1 && r.opener, 'new tab right after opener');
    assert(r.url.endsWith('/page2?from=blank'), r.url);
  });

  await test('tabs: Ctrl+T, Ctrl+W, middle-click close, Ctrl+Shift+T reopen, Ctrl+Tab / Ctrl+1', async () => {
    await guestKey('T', ['control']);
    await waitFor('bw.tabs.length === 3 && bw.entry(bw.active).route === "newtab"', { msg: 'Ctrl+T in page' });
    await s.page.keyboard.press('Control+w'); // focus is in the omnibox (shell side)
    await waitFor('bw.tabs.length === 2', { msg: 'Ctrl+W' });
    // middle-click the second tab
    const box = await s.page.locator('.app-browser .bw-tab').nth(1).boundingBox();
    await s.page.mouse.click(box.x + 40, box.y + box.height / 2, { button: 'middle' });
    await waitFor('bw.tabs.length === 1', { msg: 'middle-click close' });
    await guestKey('T', ['control', 'shift']);
    await waitFor('bw.tabs.length === 2 && bw.active.web.url.endsWith("/page2?from=blank")', { msg: 'reopen closed tab' });
    await waitFor('bw.active.web.title === "Second Page"');
    await guestKey('Tab', ['control']);
    await waitFor('bw.tabs.indexOf(bw.active) === 0', { msg: 'Ctrl+Tab wraps' });
    await guestKey('2', ['control']);
    await waitFor('bw.tabs.indexOf(bw.active) === 1', { msg: 'Ctrl+2' });
    await guestKey('1', ['control']);
    await waitFor('bw.tabs.indexOf(bw.active) === 0', { msg: 'Ctrl+1' });
  });

  await test('tabs: drag to reorder', async () => {
    await run('bw.newTab({ url: "aurora://about" })');
    await waitFor('bw.tabs.length === 3');
    const before = await run('bw.tabs.map((t) => bw.tabTitle(t))');
    const tabs = s.page.locator('.app-browser .bw-tab');
    const a = await tabs.nth(0).boundingBox();
    const c = await tabs.nth(2).boundingBox();
    await s.page.mouse.move(a.x + 50, a.y + a.height / 2);
    await s.page.mouse.down();
    for (let i = 1; i <= 12; i++) await s.page.mouse.move(a.x + 50 + ((c.x + c.width - 20 - (a.x + 50)) * i) / 12, a.y + a.height / 2);
    await s.page.mouse.up();
    await s.page.waitForTimeout(300);
    const after = await run('bw.tabs.map((t) => bw.tabTitle(t))');
    assert(after[2] === before[0] && after[0] === before[1], `dragged first tab to the end (${before} -> ${after})`);
    const dom = await run('[...bw.tabsEl.children].map((el) => el.dataset.tab).join() === bw.tabs.map((t) => t.id).join()');
    assert(dom, 'DOM order matches the model');
  });

  await test('keyboard: tab strip arrow keys / Delete, toolbar buttons are labelled', async () => {
    await run('bw.activate(bw.tabs[0], { focusPage: false })');
    await run('bw.active.el.focus()');
    await s.page.keyboard.press('ArrowRight');
    await waitFor('bw.tabs.indexOf(bw.active) === 1 && document.activeElement === bw.active.el', { msg: 'ArrowRight moves to the next tab' });
    await s.page.keyboard.press('Home');
    await waitFor('bw.tabs.indexOf(bw.active) === 0', { msg: 'Home goes to the first tab' });
    const unlabelled = await run('[...bw.toolbar.querySelectorAll("button")].filter((b) => !b.hidden && !b.getAttribute("aria-label")).map((b) => b.className)');
    assert(!unlabelled.length, `buttons without aria-label: ${unlabelled}`);
    assert(await run('bw.tabsEl.getAttribute("role") === "tablist" && bw.active.el.getAttribute("aria-selected") === "true"'), 'tablist semantics');
  });

  await test('tab context menu has the expected commands and Duplicate works', async () => {
    const box = await s.page.locator('.app-browser .bw-tab').nth(0).boundingBox();
    await s.page.mouse.click(box.x + 40, box.y + box.height / 2, { button: 'right' });
    await s.page.waitForSelector('.menu .menu-item');
    const labels = await s.page.$$eval('.menu .menu-item .label', (els) => els.map((e) => e.textContent));
    for (const l of ['New tab to the right', 'Refresh', 'Duplicate tab', 'Close tab', 'Close other tabs', 'Reopen closed tab']) assert(labels.includes(l), `menu has ${l}`);
    const n = await run('bw.tabs.length');
    await s.page.locator('.menu .menu-item', { hasText: 'Duplicate tab' }).click();
    await waitFor(`bw.tabs.length === ${n + 1}`, { msg: 'duplicate' });
    await run('bw.closeTab(bw.active)');
  });

  await test('page context menu (right-click a link inside the page)', async () => {
    await run('bw.activate(bw.tabs.find((t) => t.web.title === "Aurora Test Page") || bw.tabs[0])');
    await run(`bw.navigate(bw.active, '${srv.url}/')`);
    await waitFor('bw.active.web.title === "Aurora Test Page" && !bw.active.web.loading');
    const r = await pageJs("(() => { const b = document.getElementById('next').getBoundingClientRect(); return { x: b.left + 10, y: b.top + 8 }; })()");
    const wv = await run('(() => { const b = bw.active.wv.getBoundingClientRect(); return { x: b.left, y: b.top }; })()');
    // The first input after a tab becomes visible can race the guest's hit-test setup: retry.
    for (let attempt = 0; attempt < 4; attempt++) {
      await s.page.mouse.move(wv.x + r.x, wv.y + r.y);
      await s.page.mouse.click(wv.x + r.x, wv.y + r.y, { button: 'right' });
      try {
        await s.page.waitForSelector('.menu .menu-item', { timeout: 2000 });
        break;
      } catch (e) {
        if (attempt === 3) throw e;
      }
    }
    const labels = await s.page.$$eval('.menu .menu-item .label', (els) => els.map((e) => e.textContent));
    for (const l of ['Open link in new tab', 'Open link in Private window', 'Copy link', 'Save link as…', 'View page source']) assert(labels.includes(l), `menu has ${l} (${labels})`);
    // The keyboard works in the menu although the right-click happened inside the page.
    await s.page.keyboard.press('Escape');
    await waitFor('!document.querySelector(".menu")', { msg: 'Esc closes the page menu' });
    await waitFor('document.activeElement === bw.active.wv', { msg: 'focus back in the page' });
    await s.page.mouse.click(wv.x + r.x, wv.y + r.y, { button: 'right' });
    await s.page.waitForSelector('.menu .menu-item');
    const n = await run('bw.tabs.length');
    await s.page.keyboard.press('ArrowDown'); // first item: Open link in new tab
    await s.page.keyboard.press('Enter');
    await waitFor(`bw.tabs.length === ${n + 1}`, { msg: 'open link in new tab (keyboard)' });
    assert(await run('bw.active.web.title === "Aurora Test Page"'), 'opened in the background');
  });

  await test('find in page (Ctrl+F): match count, next, close with Esc', async () => {
    await guestKey('F', ['control']);
    await waitFor('!bw.findBar.el.hidden && document.activeElement.classList.contains("bw-find-input")', { msg: 'find bar' });
    await s.page.keyboard.type('aurora');
    const count = await waitFor('/^\\d+\\/\\d+$/.test(document.querySelector(".app-browser .bw-find-count").textContent) && document.querySelector(".app-browser .bw-find-count").textContent', { msg: 'count' });
    const [cur, total] = count.split('/').map(Number);
    assert(total >= 4 && cur === 1, `count ${count}`);
    await s.page.keyboard.press('Enter');
    await waitFor('document.querySelector(".app-browser .bw-find-count").textContent.startsWith("2/")', { msg: 'next match' });
    await s.page.keyboard.press('Shift+Enter');
    await waitFor('document.querySelector(".app-browser .bw-find-count").textContent.startsWith("1/")', { msg: 'previous match' });
    await s.page.keyboard.type('zzzz');
    await waitFor('bw.findBar.el.classList.contains("nomatch")', { msg: 'no match state' });
    await s.page.keyboard.press('Escape');
    await waitFor('bw.findBar.el.hidden', { msg: 'closed' });
  });

  await test('zoom (Ctrl+Plus / Ctrl+Minus / Ctrl+0) with omnibox indicator', async () => {
    await guestKey('=', ['control']);
    await waitFor('Math.abs(bw.active.wv.getZoomFactor() - 1.1) < 0.01 && !bw.omni.zoomBtn.hidden', { msg: 'zoom in to 110%' });
    await guestKey('=', ['control']);
    await waitFor('Math.abs(bw.active.zoom - 1.25) < 0.01', { msg: '125%' });
    await guestKey('-', ['control']);
    await waitFor('Math.abs(bw.active.zoom - 1.1) < 0.01', { msg: 'zoom out' });
    await guestKey('0', ['control']);
    await waitFor('Math.abs(bw.active.wv.getZoomFactor() - 1) < 0.01 && bw.omni.zoomBtn.hidden', { msg: 'reset' });
  });

  await test('favorites: Ctrl+D adds (star + bar + flyout), edit name, remove', async () => {
    await guestKey('D', ['control']);
    await waitFor('bw.flyout && bw.flyout.kind === "favorite"', { msg: 'favorite flyout' });
    assert(await run('bw.omni.starBtn.classList.contains("on")'), 'star is on');
    assert(await run(`!!bw.store.findBookmark('${srv.url}/')`), 'stored');
    await s.page.fill('.app-browser .bw-fav-pop input', 'My test page');
    await s.page.keyboard.press('Enter');
    await waitFor('!bw.flyout');
    await waitFor(`bw.store.findBookmark('${srv.url}/').title === 'My test page'`, { msg: 'renamed' });
    await waitFor('[...document.querySelectorAll(".app-browser .bw-favbar .bw-fav-label")].some((x) => x.textContent === "My test page")', { msg: 'shown in favorites bar' });
    // remove via the flyout
    await waitFor('!document.querySelector(".app-browser .bw-flyout")', { msg: 'previous flyout gone' });
    await s.page.click('.app-browser .bw-star');
    await s.page.waitForSelector('.app-browser .bw-flyout:not(.leaving) .bw-fav-pop');
    assert(await run('document.querySelector(".app-browser .bw-fav-pop .bw-pop-title").textContent === "Edit favorite"'), 'edit mode for an existing favorite');
    await s.page.locator('.app-browser .bw-flyout:not(.leaving) .bw-fav-pop .btn', { hasText: 'Remove' }).click();
    await waitFor(`!bw.store.findBookmark('${srv.url}/') && !bw.omni.starBtn.classList.contains('on')`, { msg: 'removed' });
    assert(await run('![...document.querySelectorAll(".app-browser .bw-favbar .bw-fav-label")].some((x) => x.textContent === "My test page")'), 'gone from bar');
  });

  await test('favorites bar folder menu, toggle with Ctrl+Shift+B, favorites manager page', async () => {
    await s.page.locator('.app-browser .bw-favbar .bw-fav', { hasText: 'Aurora OS' }).click();
    await s.page.waitForSelector('.bw-menu .menu-item');
    const labels = await s.page.$$eval('.bw-menu .menu-item .label', (els) => els.map((e) => e.textContent));
    assert(labels.some((l) => /Aurora OS/.test(l)), `folder menu (${labels})`);
    await s.page.keyboard.press('Escape');
    await guestKey('B', ['control', 'shift']);
    await waitFor('bw.favbar.el.hidden', { msg: 'bar hidden' });
    await guestKey('B', ['control', 'shift']);
    await waitFor('!bw.favbar.el.hidden', { msg: 'bar shown' });
    await guestKey('O', ['control', 'shift']);
    await waitFor('bw.entry(bw.active).route === "favorites" && document.querySelectorAll(".app-browser .bw-view.active .bp-fav-row").length >= 6', { msg: 'favorites page' });
    // add a folder through the page
    await s.page.locator('.app-browser .bw-view.active .bp-head .btn', { hasText: 'Add folder' }).click();
    await s.page.waitForSelector('.dialog input');
    await s.page.fill('.dialog input', 'Test folder');
    await s.page.keyboard.press('Enter');
    await waitFor('bw.store.bookmarks.bar.children.some((n) => n.type === "folder" && n.title === "Test folder")', { msg: 'folder added' });
    await waitFor('[...document.querySelectorAll(".app-browser .bw-view.active .bp-tree-item")].some((x) => x.textContent === "Test folder")', { msg: 'folder in tree' });
  });

  await test('history page: grouped by day, search, delete an entry', async () => {
    await guestKey('H', ['control']);
    await waitFor('bw.entry(bw.active).route === "history" && document.querySelectorAll(".app-browser .bw-view.active .bp-row").length >= 2', { msg: 'history page' });
    const day = await run('document.querySelector(".app-browser .bw-view.active .bp-day").textContent');
    assert(/^Today/.test(day), `grouped under Today (${day})`);
    const n = await run('document.querySelectorAll(".app-browser .bw-view.active .bp-row").length');
    await s.page.fill('.app-browser .bw-view.active .bp-search input', 'Second');
    await waitFor('document.querySelectorAll(".app-browser .bw-view.active .bp-row").length >= 1 && [...document.querySelectorAll(".app-browser .bw-view.active .bp-row-title")].every((x) => /Second/.test(x.textContent))', { msg: 'filtered' });
    await s.page.fill('.app-browser .bw-view.active .bp-search input', '');
    await waitFor(`document.querySelectorAll(".app-browser .bw-view.active .bp-row").length === ${n}`);
    await s.page.hover('.app-browser .bw-view.active .bp-row');
    await s.page.click('.app-browser .bw-view.active .bp-row .bp-row-del');
    await waitFor(`document.querySelectorAll(".app-browser .bw-view.active .bp-row").length === ${n - 1}`, { msg: 'deleted' });
  });

  await test('download: progress UI, lands in ~/Downloads, completion notification, downloads page', async () => {
    await run(`bw.navigate(bw.active, '${srv.url}/')`);
    await waitFor('bw.active.web.title === "Aurora Test Page" && !bw.active.web.loading');
    await pageJs("document.getElementById('dl').click()");
    await waitFor('bw.flyout && bw.flyout.kind === "downloads"', { msg: 'downloads flyout opens' });
    await waitFor('document.querySelector(".app-browser .bw-dl-row.state-progressing .bw-dl-progress")', { msg: 'progress bar' });
    assert(await run('!bw.dlBtn.hidden && bw.dlBtn.classList.contains("progress") && !bw.dlBadge.hidden'), 'toolbar button shows progress ring + badge');
    const ringExpr = `(() => { const r = bw.dlBtn.querySelector('.bw-dl-ring'); const bar = r.querySelector('.bar'); const b = r.getBoundingClientRect(); return { ns: r.namespaceURI, w: b.width, opacity: getComputedStyle(r).opacity, dash: getComputedStyle(bar).strokeDasharray }; })()`;
    const ring = await waitFor(`(() => { const x = ${ringExpr}; return x.opacity === '1' && !/^0(px)?,/.test(x.dash) && x; })()`, { msg: 'progress ring' }).catch(() => run(ringExpr));
    assert(ring.ns === 'http://www.w3.org/2000/svg' && ring.w > 20 && ring.opacity === '1', `progress ring is a rendered SVG (${JSON.stringify(ring)})`);
    assert(!/^0(px)?,/.test(ring.dash), `ring shows progress (${ring.dash})`);
    await s.page.waitForTimeout(500);
    await s.shot('browser-downloads-progress');
    await waitFor('document.querySelector(".app-browser .bw-dl-row.state-completed")', { timeout: 20000, msg: 'download completed' });
    const file = path.join(s.home, 'Downloads', 'aurora-test.bin');
    assert(fs.existsSync(file) && fs.statSync(file).size === 3 * 1024 * 1024, 'file saved with full size');
    await waitFor('window.__aurora.notify && document.querySelector("#toasts .toast")', { msg: 'notification toast' });
    // a second download of the same name gets a unique name
    await pageJs("document.getElementById('dl').click()");
    await waitFor(`[...shared.downloads.values()].filter((d) => d.state === 'completed').length === 2`, { timeout: 20000, msg: 'second download' });
    assert(fs.existsSync(path.join(s.home, 'Downloads', 'aurora-test (2).bin')), 'unique name for the second file');
    await guestKey('J', ['control']);
    await waitFor('bw.entry(bw.active).route === "downloads" && document.querySelectorAll(".app-browser .bw-view.active .bw-dl-row").length === 2', { msg: 'downloads page' });
    await s.page.waitForTimeout(300);
    copyShot(await s.shot('browser-downloads'), 'browser-downloads');
  });

  await test('download started from a target=_blank link closes the temporary tab', async () => {
    await run(`bw.navigate(bw.active, '${srv.url}/')`);
    await waitFor('bw.active.web.title === "Aurora Test Page" && !bw.active.web.loading');
    const n = await run('bw.tabs.length');
    await pageJs("document.getElementById('dlblank').click()");
    await waitFor(`[...shared.downloads.values()].some((d) => d.filename === 'aurora-test-2.bin')`, { msg: 'download started' });
    await waitFor(`bw.tabs.length === ${n}`, { msg: 'temporary tab closed' });
    // pause / resume / cancel through the backend
    const id = await run(`[...shared.downloads.values()].find((d) => d.filename === 'aurora-test-2.bin').id`);
    const st = await run(`shared.downloads.get('${id}').state`);
    if (st === 'progressing') {
      await run(`bw.ctx.api.invoke('browser:downloadPause', '${id}')`);
      await waitFor(`shared.downloads.get('${id}').paused`, { msg: 'paused' });
      await run(`bw.ctx.api.invoke('browser:downloadResume', '${id}')`);
      await waitFor(`!shared.downloads.get('${id}').paused`, { msg: 'resumed' });
      await run(`bw.ctx.api.invoke('browser:downloadCancel', '${id}')`);
      await waitFor(`shared.downloads.get('${id}').state === 'cancelled'`, { msg: 'cancelled' });
    }
  });

  await test('error page for an unreachable address, retry button', async () => {
    await run(`bw.navigate(bw.active, 'http://127.0.0.1:${deadPort}/')`);
    await waitFor('bw.active.web.error && bw.active.errorEl && bw.active.errorEl.isConnected', { msg: 'error page' });
    const r = await run('({ title: bw.active.errorEl.querySelector(".bp-err-title").textContent, code: bw.active.errorEl.querySelector(".bp-err-code").textContent, btn: bw.active.errorEl.querySelector(".btn.primary").textContent, omni: bw.omni.input.value, tab: bw.tabTitle(bw.active) })');
    assert(/can't reach this page/.test(r.title), r.title);
    assert(r.code === 'ERR_CONNECTION_REFUSED', r.code);
    assert(r.btn === 'Refresh', r.btn);
    assert(r.omni.includes(`127.0.0.1:${deadPort}`), 'omnibox keeps the failed URL');
    await s.shot('browser-error');
    await run('bw.goBack()');
    await waitFor('!bw.active.web.error && bw.active.web.title === "Aurora Test Page"', { msg: 'back from error page' });
  });

  await test('pop-up with window features opens a new browser window', async () => {
    await pageJs("document.getElementById('pop').click()");
    await waitFor('window.__aurora.wm.byApp("browser").length === 2 && window.__aurora.registry.instance(window.__aurora.wm.byApp("browser")[1].id)?.hooks?.ctl?.active', { msg: 'second window' });
    await waitFor('bw.active.web.title === "Second Page"', { i: 1, msg: 'popup content' });
    await run('bw.win.close()', 1);
    await waitFor('window.__aurora.wm.byApp("browser").length === 1');
  });

  await test('settings: search engine, home button, favorites bar mode', async () => {
    await run('bw.openInternal("settings")');
    await waitFor('document.querySelector(".app-browser .bw-view.active .bp-settings")');
    await s.page.selectOption('.app-browser .bw-view.active .bp-engine-select', 'google');
    await waitFor('bw.prefs.engine === "google" && /Google/.test(bw.omni.input.placeholder)', { msg: 'engine' });
    const c = await s.page.evaluate(async () => (await import('app://shell/apps/browser/lib/util.js')).classify('hello world', 'google').url);
    assert(c === 'https://www.google.com/search?q=hello+world', c);
    await run('bw.store.setPref("engine", "duckduckgo")');
    await run('bw.store.setPref("homeButton", false)');
    await waitFor('bw.homeBtn.hidden');
    await run('bw.store.setPref("homeButton", true)');
    await waitFor('!bw.homeBtn.hidden');
    await waitFor('bw.ctx.storage.get("prefs").then((p) => p && p.engine === "duckduckgo" && p.homeButton === true)', { msg: 'prefs persisted' });
  });

  await test('clear browsing data dialog clears history', async () => {
    assert((await run('bw.store.history.size')) > 0, 'has history');
    await guestKey('Delete', ['control', 'shift']);
    await s.page.waitForSelector('.dialog .bw-clear');
    await s.page.locator('.dialog .btn.primary').click();
    await waitFor('bw.store.history.size === 0', { msg: 'history cleared' });
  });

  await test('HTML fullscreen and F11 hide the browser chrome', async () => {
    await run(`bw.navigate(bw.active, '${srv.url}/')`);
    await waitFor('bw.active.web.title === "Aurora Test Page" && !bw.active.web.loading');
    await guestKey('F11');
    await waitFor('bw.fs === "user" && bw.win.el.classList.contains("fullscreen")', { msg: 'F11 fullscreen' });
    await guestKey('F11');
    await waitFor('!bw.fs && !bw.win.el.classList.contains("fullscreen")', { msg: 'F11 exit' });
    await pageJs("document.getElementById('fs').click()");
    await waitFor('bw.fs === "html"', { msg: 'page requested fullscreen' });
    await pageJs('document.exitFullscreen()');
    await waitFor('!bw.fs', { msg: 'left html fullscreen' });
  });

  await test('session is saved for "continue where you left off"', async () => {
    await run('bw.store.setPref("startup", "continue")');
    await run('bw.saveSession()');
    await s.page.waitForTimeout(1200);
    const sess = await run('bw.ctx.storage.get("session")');
    assert(sess?.windows?.[0]?.tabs?.length === (await run('bw.tabs.length')), 'session has every tab');
  });

  await test('omnibox suggestions: inline completion, arrow keys, search row, Esc restores the URL', async () => {
    await run(`bw.navigate(bw.active, '${srv.url}/page2')`);
    await waitFor('bw.active.web.title === "Second Page" && !bw.active.web.loading');
    await s.page.click('.app-browser .bw-omni-input');
    await s.page.keyboard.type('127.0');
    await waitFor('!bw.omni.suggestEl.hidden && bw.omni.items.length >= 2', { msg: 'suggestions' });
    const r = await run(`({ value: bw.omni.input.value, sel: bw.omni.input.value.slice(bw.omni.input.selectionStart, bw.omni.input.selectionEnd), kinds: bw.omni.items.map((i) => i.kind), last: bw.omni.items[bw.omni.items.length - 1].url })`);
    assert(r.value.startsWith('127.0') && r.value.length > 5 && r.sel === r.value.slice(5), `inline completion selected (${r.value} / ${r.sel})`);
    assert(r.kinds.includes('history'), `history suggestions (${r.kinds})`);
    assert(r.last.startsWith('https://duckduckgo.com/?q=127.0'), `search row last (${r.last})`);
    await s.page.keyboard.press('ArrowDown');
    assert(await run('bw.omni.sel === 1 && bw.omni.input.value.includes("127.0.0.1")'), 'arrow selects next suggestion');
    await s.page.keyboard.press('Escape'); // back to the first suggestion
    await s.page.keyboard.press('Escape'); // close + restore URL
    await waitFor(`bw.omni.suggestEl.hidden && bw.omni.input.value === '${srv.url}/page2'`, { msg: 'Esc restores URL' });
    await s.page.keyboard.press('Escape'); // focus returns to the page
    await waitFor('!bw.omni.editing');
    // Text typed but not submitted stays with its tab.
    await s.page.click('.app-browser .bw-omni-input');
    await s.page.keyboard.type('draft words');
    const a = await run('bw.active.id');
    await run('bw.newTab({ url: "aurora://about" })');
    await waitFor('bw.omni.input.value === "aurora://about"', { msg: 'other tab shows its URL' });
    await run(`bw.activate(bw.tabs.find((t) => t.id === '${a}'))`);
    await waitFor('bw.omni.input.value === "draft words"', { msg: 'typed text restored' });
    await run(`bw.closeTab(bw.tabs.find((t) => bw.tabUrl(t) === 'aurora://about'))`);
    await run('(bw.omni.reset(), bw.omni.sync(bw.active))');
  });

  await test('audio indicator on the playing tab, click to mute', async () => {
    await run(`bw.navigate(bw.active, '${srv.url}/audio')`);
    await waitFor('bw.active.web.title === "Audio page" && !bw.active.web.loading');
    const played = await pageJs("document.getElementById('a').play().then(() => 'ok', (e) => e.message)");
    assert(played === 'ok', `audio plays (${played})`);
    await waitFor('bw.active.el.classList.contains("audible")', { msg: 'audible tab' });
    console.log('DEBUG audio', JSON.stringify(await run(`({ n: bw.tabs.length, w: bw.active.el.getBoundingClientRect().width, audio: (() => { const b = bw.active.parts.audio.getBoundingClientRect(); const cs = getComputedStyle(bw.active.parts.audio); return [b.width, b.height, cs.display, cs.transform, cs.opacity, cs.animationName, cs.animationPlayState]; })(), locked: bw.tabsEl.className })`)));
    await s.page.click('.app-browser .bw-tab.active .bw-tab-audio');
    await waitFor('bw.active.muted && bw.active.wv.isAudioMuted()', { msg: 'muted' });
    await s.page.click('.app-browser .bw-tab.active .bw-tab-audio');
    await waitFor('!bw.active.muted && !bw.active.wv.isAudioMuted()', { msg: 'unmuted' });
    await pageJs("document.getElementById('a').pause()");
    await waitFor('!bw.active.el.classList.contains("audible")', { timeout: 6000, msg: 'indicator goes away' });
  });

  await test('HTML5 media codecs (H.264/AAC, VP9/Opus, MP3) are supported', async () => {
    const c = await pageJs(`[document.createElement('video').canPlayType('video/mp4; codecs="avc1.42E01E, mp4a.40.2"'), MediaSource.isTypeSupported('video/mp4; codecs="avc1.4d401f"'), document.createElement('video').canPlayType('video/webm; codecs="vp9, opus"'), document.createElement('audio').canPlayType('audio/mpeg')]`);
    assert(c[0] === 'probably' && c[1] === true && c[2] === 'probably' && c[3] === 'probably', JSON.stringify(c));
  });

  await test('permission request bubble (notifications): Allow is remembered for the site', async () => {
    await run(`bw.navigate(bw.active, '${srv.url}/perm')`);
    await waitFor('bw.active.web.title === "Permission page" && !bw.active.web.loading');
    await pageJs("document.getElementById('b').click()");
    await s.page.waitForSelector('.app-browser .bw-perm-pop');
    const text = await s.page.textContent('.app-browser .bw-perm-pop');
    assert(/127\.0\.0\.1 wants to/.test(text) && /Show notifications/.test(text), text);
    await s.page.locator('.app-browser .bw-perm-pop .btn', { hasText: 'Allow' }).click();
    await waitFor('bw.active.web.title === "perm:granted"', { msg: 'granted' });
    const perms = await run('bw.ctx.api.invoke("browser:sitePermissions")');
    assert(perms[srv.url]?.notifications === 'allow', JSON.stringify(perms));
    await run(`bw.ctx.api.invoke('browser:resetSitePermissions', '${srv.url}')`);
  });

  await test('pop-up flood is limited and the blocked pop-ups chip appears', async () => {
    await run(`bw.navigate(bw.active, '${srv.url}/popups')`);
    await waitFor('bw.active.web.title === "Popups page" && !bw.active.web.loading');
    const src = await run('bw.active.id');
    const n = await run('bw.tabs.length');
    await pageJs("document.getElementById('b').click()");
    await waitFor(`bw.tabs.length === ${n + 3}`, { msg: '3 pop-ups opened' });
    await s.page.waitForTimeout(500);
    assert((await run('bw.tabs.length')) === n + 3, 'only 3 opened');
    await run(`bw.activate(bw.tabs.find((t) => t.id === '${src}'))`);
    await waitFor('!bw.omni.popupBtn.hidden && bw.active.blockedPopups.length === 2', { msg: 'blocked chip' });
    await run(`bw.closeOtherTabs(bw.tabs.find((t) => t.id === '${src}'))`);
  });

  await test('HTTP authentication dialog', async () => {
    await run(`bw.navigate(bw.active, '${srv.url}/auth')`);
    await s.page.waitForSelector('.dialog input[autocomplete="username"]');
    await s.page.fill('.dialog input[autocomplete="username"]', 'aurora');
    await s.page.fill('.dialog input[type="password"]', 'secret');
    await s.page.locator('.dialog .btn.primary').click();
    await waitFor('bw.active.web.title === "Authorized"', { msg: 'authorized' });
  });

  await test('view page source opens a view-source: tab (Ctrl+U)', async () => {
    const n = await run('bw.tabs.length');
    await guestKey('U', ['control']);
    await waitFor(`bw.tabs.length === ${n + 1} && bw.active.web.url.startsWith('view-source:')`, { msg: 'view-source tab' });
    await run('bw.closeTab(bw.active)');
  });

  await test('security: pages cannot open data: documents (images are fine)', async () => {
    await run(`bw.navigate(bw.active, '${srv.url}/data')`);
    await waitFor('bw.active.web.title === "Data page" && !bw.active.web.loading');
    const n = await run('bw.tabs.length');
    await pageJs("document.getElementById('html').click()");
    await s.page.waitForTimeout(700);
    assert((await run('bw.tabs.length')) === n, 'data:text/html pop-up refused');
    await pageJs("document.getElementById('img').click()");
    await waitFor(`bw.tabs.length === ${n + 1}`, { msg: 'data:image opens in a tab' });
    await run('bw.closeTab(bw.active)');
  });

  await test('security: page titles and URLs are shown as text, never parsed as HTML', async () => {
    await run(`bw.navigate(bw.active, '${srv.url}/xss')`);
    await waitFor('bw.active.web.title.startsWith("<img") && !bw.active.web.loading', { msg: 'hostile title' });
    await s.page.waitForTimeout(300);
    const r = await run(`({ pwned: !!window.__pwned, tabText: bw.active.el.querySelector('.bw-tab-title').textContent, imgs: bw.active.el.querySelectorAll('.bw-tab-title img').length, win: bw.win.title })`);
    assert(!r.pwned && r.imgs === 0 && r.tabText.startsWith('<img'), JSON.stringify(r));
    await run('bw.showHoverCard(bw.active)');
    assert(await run('!document.querySelector(".bw-hovercard img") && document.querySelector(".bw-hovercard .bw-hc-title").textContent.startsWith("<img")'), 'hover card text only');
    await run('bw.hideHoverCard()');
    // The history page renders it as text too.
    await run('bw.openInternal("history")');
    await waitFor('document.querySelector(".app-browser .bw-view.active .bp-row-title")');
    assert(await run('!document.querySelector(".app-browser .bw-view.active .bp-row-title img") && !window.__pwned'), 'history row text only');
    await run('bw.closeTab(bw.active)');
  });

  await test('page dialogs: alert / confirm / prompt open an Edge-style dialog and return the answer', async () => {
    await run(`bw.navigate(bw.active, '${srv.url}/dialogs')`);
    await waitFor('bw.active.web.title === "Dialogs page" && !bw.active.web.loading');
    const fire = (id) => pageJs(`document.title = 'waiting'; setTimeout(() => document.getElementById('${id}').click()); 0`);
    const dlg = '.dialog-layer:not(.closing) .bw-jsdlg';
    await fire('confirm');
    await s.page.waitForSelector(dlg);
    const head = await s.page.evaluate(() => ({ title: document.querySelector('.dialog-layer:not(.closing) .dialog-title').textContent, msg: document.querySelector('.dialog-layer:not(.closing) .bw-jsdlg-msg').textContent }));
    assert(head.title === `127.0.0.1 says` && head.msg === 'Delete everything?', JSON.stringify(head));
    await s.page.locator('.dialog-layer:not(.closing) .btn.primary').click();
    await waitFor('bw.active.web.title === "confirm:true"', { msg: 'confirm OK -> true' });
    await fire('confirm');
    await s.page.waitForSelector(dlg);
    // From the second dialog on, the page can be silenced.
    assert(await s.page.locator('.dialog-layer:not(.closing) .bw-jsdlg input[type=checkbox]').count(), 'suppress checkbox offered');
    await waitFor('document.activeElement?.matches(".dialog-layer:not(.closing) .btn.primary")', { msg: 'OK button focused' });
    await s.page.keyboard.press('Escape');
    await waitFor('bw.active.web.title === "confirm:false"', { msg: 'Esc -> false' });
    await fire('prompt');
    await s.page.waitForSelector(`${dlg} input.input`);
    assert((await s.page.inputValue(`${dlg} input.input`)) === 'Ada', 'prompt default value');
    await waitFor('document.activeElement?.matches(".dialog-layer:not(.closing) .bw-jsdlg input.input")', { msg: 'prompt input focused' });
    await s.page.fill(`${dlg} input.input`, 'Grace');
    await s.page.keyboard.press('Enter');
    await waitFor('bw.active.web.title === "prompt:Grace"', { msg: 'prompt value returned' });
    await fire('alert');
    await s.page.waitForSelector(dlg);
    assert((await s.page.locator('.dialog-layer:not(.closing) .dialog-footer .btn').count()) === 1, 'alert has only OK');
    await s.page.check('.dialog-layer:not(.closing) .bw-jsdlg input[type=checkbox]');
    await s.page.locator('.dialog-layer:not(.closing) .btn.primary').click();
    await waitFor('bw.active.web.title === "alert:done"', { msg: 'alert returns after OK' });
    await fire('confirm');
    await waitFor('bw.active.web.title === "confirm:false"', { msg: 'silenced page gets the default answer' });
    assert(!(await s.page.locator(dlg).count()), 'no dialog once silenced');
    // A dialog left open is closed when the tab navigates away.
    await run(`bw.navigate(bw.active, '${srv.url}/dialogs')`);
    await waitFor('bw.active.web.title === "Dialogs page" && !bw.active.web.loading');
    await fire('confirm');
    await s.page.waitForSelector(dlg);
    await run(`bw.navigate(bw.active, '${srv.url}/page2')`);
    await waitFor('bw.active.web.title === "Second Page"', { msg: 'navigation goes through' });
    await waitFor(`!document.querySelector('${dlg}')`, { msg: 'dialog closed with its page' });
  });

  await test('HTTP sign-in dialog takes the focus and closes when the tab moves on', async () => {
    await run(`bw.navigate(bw.active, '${srv.url}/auth2')`);
    await s.page.waitForSelector('.dialog-layer:not(.closing) input[autocomplete="username"]');
    await waitFor('document.activeElement?.getAttribute("autocomplete") === "username"', { msg: 'username focused' });
    await run(`bw.navigate(bw.active, '${srv.url}/')`);
    await waitFor('bw.active.web.title === "Aurora Test Page" && !bw.active.web.loading', { msg: 'navigated away' });
    await waitFor('!document.querySelector(".dialog-layer:not(.closing) input[autocomplete=username]")', { msg: 'sign-in dialog closed' });
    await run(`bw.navigate(bw.active, '${srv.url}/auth2')`);
    await s.page.waitForSelector('.dialog-layer:not(.closing) input[autocomplete="username"]');
    await s.page.waitForTimeout(200);
    await s.page.keyboard.press('Escape');
    await waitFor('bw.active.web.title === "Denied" && !document.querySelector(".dialog-layer:not(.closing)")', { msg: 'Esc cancels -> 401 page' });
  });

  await test('rapid clicks: new tab / close keep the strip and the model in sync', async () => {
    const n = await run('bw.tabs.length');
    for (let i = 0; i < 6; i++) await s.page.click('.app-browser .bw-newtab');
    for (let i = 0; i < 3; i++) await s.page.keyboard.press('Control+w');
    await s.page.click('.app-browser .bw-newtab');
    await s.page.waitForTimeout(500);
    const r = await run('({ n: bw.tabs.length, dom: [...bw.tabsEl.children].map((e) => e.dataset.tab).join() === bw.tabs.map((t) => t.id).join(), active: bw.tabs.includes(bw.active) })');
    assert(r.n === n + 4 && r.dom && r.active, JSON.stringify(r));
    await run('bw.closeOtherTabs(bw.tabs[0])');
  });

  await test('"Close other tabs" never loads the background tabs it closes', async () => {
    await run(`bw.navigate(bw.tabs[0], '${srv.url}/')`);
    for (let i = 0; i < 4; i++) await run(`bw.createTab({ lazy: { url: '${srv.url}/page2?lazy=${i}', title: 'Lazy ${i}' }, active: false, activateIfNone: false })`);
    await run('bw.activate(bw.tabs[2])'); // the user looks at one of them: it loads
    await waitFor('bw.tabs[2].wv', { msg: 'activated lazy tab loads' });
    await run('(window.__cw = 0, bw.__cw = bw.createWebview, bw.createWebview = function (...a) { window.__cw++; return bw.__cw.apply(this, a); }, 0)');
    await run('bw.closeOtherTabs(bw.tabs[0])');
    const created = await run('window.__cw');
    await run('(bw.createWebview = bw.__cw, 0)');
    assert(created === 0, `no webview created while closing the other tabs (${created})`);
    assert((await run('bw.tabs.length')) === 1 && (await run('bw.active === bw.tabs[0]')), 'one tab left, active');
  });

  await test('translated errors for failed backend calls', async () => {
    const r = await run(`[shared.errorText({ code: 'ENOSPC' }), shared.errorText({ code: 'ENORESUME' }), shared.errorText({ message: 'boom' })]`);
    assert(r[0] === "There isn't enough space on the disk." && /can't be resumed/.test(r[1]) && r[2] === 'Something went wrong: boom', JSON.stringify(r));
  });

  await test('no leaks: extra windows and app relaunches release every listener', async () => {
    const counts = () => s.page.evaluate(async () => {
      const { shared } = await import('app://shell/apps/browser/lib/shared.js');
      return { app: shared.listenerCount(), wm: [...window.__aurora.wm._h.values()].reduce((n, x) => n + x.size, 0), dom: document.querySelectorAll('.app-browser.win, .bw-flyout, .bw-menu, .bw-hovercard, .bw-suggest').length };
    });
    const before = await counts();
    for (let i = 0; i < 15; i++) {
      await s.page.evaluate(() => window.__aurora.shell.launch('browser', { newWindow: true }));
      await waitFor('window.__aurora.wm.byApp("browser").length === 2 && window.__aurora.registry.instance(window.__aurora.wm.byApp("browser")[1].id)?.hooks?.ctl?.active', { msg: 'second window' });
      await run('(bw.newTab({ url: "aurora://history" }), bw.newTab({ url: "aurora://favorites" }), bw.newTab({ url: "aurora://downloads" }), bw.toggleDownloads(), 0)', 1);
      await run('bw.win.close()', 1);
      await waitFor('window.__aurora.wm.byApp("browser").length === 1', { msg: 'closed' });
    }
    await s.page.waitForTimeout(400);
    const mid = await counts();
    assert(mid.app === before.app && mid.wm <= before.wm, `extra windows released their listeners (${JSON.stringify(before)} -> ${JSON.stringify(mid)})`);
    // Close the app entirely and start it again, 15 times.
    for (let i = 0; i < 15; i++) {
      await run('bw.win.close()');
      await s.page.waitForFunction(() => window.__aurora.wm.byApp('browser').length === 0, null, { timeout: 8000 });
      await s.page.evaluate(() => window.__aurora.shell.launch('browser'));
      await s.page.waitForFunction(() => window.__aurora.registry.instance(window.__aurora.wm.byApp('browser')[0]?.id)?.hooks?.ctl?.active, null, { timeout: 8000 });
    }
    await s.page.waitForTimeout(400);
    const after = await counts();
    assert(after.app === before.app && after.wm <= before.wm && after.dom === 1, `relaunches released everything (${JSON.stringify(before)} -> ${JSON.stringify(after)})`);
  });

  await test('no renderer errors', async () => {
    const e = errors();
    assert(!e.length, e.join('\n'));
  });
  await s.close();
}

// ======== Session 2: restore + private window
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-home-'));
  const appDir = path.join(home, '.config', 'aurora', 'apps', 'browser');
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(path.join(appDir, 'prefs.json'), JSON.stringify({ startup: 'continue' }));
  fs.writeFileSync(path.join(appDir, 'session.json'), JSON.stringify({ windows: [{ tabs: [{ url: `${srv.url}/`, title: 'Aurora Test Page' }, { url: 'aurora://history', title: 'History' }], active: 1 }] }));
  // Damaged data files (hand-edited / truncated): the app must keep what is valid and start normally.
  fs.writeFileSync(
    path.join(appDir, 'bookmarks.json'),
    JSON.stringify({
      bar: { id: 'bar', type: 'folder', children: [null, 42, { type: 'url', title: 'Valid', url: 'https://valid.example/' }, { type: 'url', title: 'No URL' }, { id: 'fx', type: 'folder', title: 'Broken folder', children: 'oops' }] },
      other: { children: [] },
    }),
  );
  fs.writeFileSync(path.join(appDir, 'history.json'), JSON.stringify([null, 'x', { url: 'javascript:alert(1)' }, { url: 'https://valid.example/', title: 5, visits: 'abc', last: 1700000000000 }]));
  const s = await launchShell({ open: ['browser'], theme: 'light', lang: 'en', home, keepHome: false });
  const { run, waitFor, errors } = harness(s);
  console.log('Session 2 (restore, private window)');

  await test('damaged favorites / history files: valid entries kept, no crash', async () => {
    await waitFor('bw.tabs.length === 2', { msg: 'window up' });
    const r = await run(`({ bar: bw.store.bookmarks.bar.children.map((n) => n.title), folder: bw.store.bookmarks.bar.children.find((n) => n.title === 'Broken folder')?.children, hist: [...bw.store.history.values()], favbar: [...document.querySelectorAll('.app-browser .bw-favbar .bw-fav-label')].map((x) => x.textContent) })`);
    assert(JSON.stringify(r.bar) === '["Valid","Broken folder"]', `bar ${JSON.stringify(r.bar)}`);
    assert(Array.isArray(r.folder) && !r.folder.length, 'broken folder repaired');
    assert(r.hist.length === 1 && r.hist[0].url === 'https://valid.example/' && r.hist[0].title === '' && r.hist[0].visits === 1, JSON.stringify(r.hist));
    assert(r.favbar.includes('Valid') && r.favbar.includes('Broken folder'), `favorites bar ${r.favbar}`);
  });

  await test('startup restores the previous session (lazy background tabs)', async () => {
    await waitFor('bw.tabs.length === 2', { msg: 'restored tabs' });
    const r = await run('({ active: bw.tabs.indexOf(bw.active), route: bw.entry(bw.active)?.route, lazy: !!bw.tabs[0].lazy, title: bw.tabTitle(bw.tabs[0]) })');
    assert(r.active === 1 && r.route === 'history', 'active restored tab is History');
    assert(r.lazy && r.title === 'Aurora Test Page', 'first tab restored lazily with its title');
    await run('bw.activate(bw.tabs[0])');
    await waitFor('bw.active.web.title === "Aurora Test Page" && !bw.active.web.loading', { msg: 'lazy tab loads on activation' });
  });

  await test('Private window: dark styling, badge, separate partition, no history', async () => {
    const before = await run('bw.store.history.size');
    await run('window.__aurora.shell.launch("browser", { private: true })');
    await waitFor('window.__aurora.wm.byApp("browser").length === 2 && window.__aurora.registry.instance(window.__aurora.wm.byApp("browser")[1].id)?.hooks?.ctl?.active', { msg: 'private window' });
    const r = await run('({ cls: bw.win.el.className, badge: bw.privateBadge?.textContent, part: bw.partition, title: bw.win.title, ntp: !!document.querySelector(".app-browser.bw-private .bp-private-card") })', 1);
    assert(/bw-private/.test(r.cls), 'private class');
    assert(r.badge === 'Private', `badge (${r.badge})`);
    assert(/^browser-private-/.test(r.part), r.part);
    assert(/Private - Aurora Browser/.test(r.title), r.title);
    assert(r.ntp, 'private new tab page explainer');
    await run(`bw.navigate(bw.active, '${srv.url}/page2?private=1')`, 1);
    await waitFor('bw.active.web.title === "Second Page" && !bw.active.web.loading', { i: 1, msg: 'private page load' });
    await run('bw.newTab()', 1);
    await s.page.waitForTimeout(600);
    copyShot(await s.shot('browser-private'), 'browser-private');
    await s.page.waitForTimeout(1600); // let any (wrong) debounced history write happen
    const after = await run('bw.store.history.size');
    assert(after === before, `history unchanged by private browsing (${before} -> ${after})`);
    const disk = await run('bw.ctx.storage.get("history", [])');
    assert(!disk.some((e) => e.url.includes('private=1')), 'not persisted');
    // cookies are isolated per partition
    await run(`bw.navigate(bw.active, '${srv.url}/')`, 1);
    await waitFor('bw.active.web.title === "Aurora Test Page" && !bw.active.web.loading', { i: 1 });
    await run(`bw.active.wv.executeJavaScript('document.cookie = "priv=1; path=/"')`, 1);
    const normalCookie = await run(`bw.active.wv.executeJavaScript('document.cookie')`, 0);
    assert(!/priv=1/.test(normalCookie), 'private cookie not visible in normal window');
    await run('bw.win.close()', 1);
    await waitFor('window.__aurora.wm.byApp("browser").length === 1');
  });

  await test('Private window downloads stay out of normal windows and are forgotten on close', async () => {
    await run('window.__aurora.shell.launch("browser", { private: true })');
    await waitFor('window.__aurora.wm.byApp("browser").length === 2 && window.__aurora.registry.instance(window.__aurora.wm.byApp("browser")[1].id)?.hooks?.ctl?.active', { msg: 'private window' });
    await run(`bw.navigate(bw.active, '${srv.url}/')`, 1);
    await waitFor('bw.active.web.title === "Aurora Test Page" && !bw.active.web.loading', { i: 1 });
    await run(`bw.active.wv.executeJavaScript("document.getElementById('dl').click()", true)`, 1);
    await waitFor(`[...shared.downloads.values()].some((d) => d.private && d.state === 'completed')`, { timeout: 20000, msg: 'private download done' });
    const r = await run(`({ normal: shared.downloadList(bw).filter((d) => d.private).length, privateWin: shared.downloadList(${CTL(1)}).filter((d) => d.private).length, disk: (await bw.ctx.storage.get('downloads', [])).length })`);
    assert(r.normal === 0 && r.privateWin === 1 && r.disk === 0, JSON.stringify(r));
    await run('bw.win.close()', 1);
    await waitFor('window.__aurora.wm.byApp("browser").length === 1');
    await waitFor('![...shared.downloads.values()].some((d) => d.private)', { msg: 'forgotten with the Private session' });
    assert(fs.existsSync(path.join(home, 'Downloads', 'aurora-test.bin')), 'the downloaded file itself is kept');
  });

  await test('relaunch with a URL opens a tab in the most recent normal window', async () => {
    const n = await run('bw.tabs.length');
    await run(`window.__aurora.shell.openUrl('${srv.url}/page2?from=shell')`);
    await waitFor(`bw.tabs.length === ${n + 1} && bw.active.web.title === 'Second Page'`, { msg: 'openUrl -> new tab' });
    assert(await run('window.__aurora.wm.byApp("browser").length === 1'), 'no extra window');
  });

  await test('closing the last tab closes the window and keeps the tab for "continue where you left off"', async () => {
    await run(`bw.navigate(bw.active, '${srv.url}/page2?last=1')`);
    await waitFor('bw.active.web.title === "Second Page" && !bw.active.web.loading');
    await run('bw.closeOtherTabs(bw.active)');
    await s.page.waitForTimeout(300);
    await run('bw.closeTab(bw.active)');
    await s.page.waitForFunction(() => window.__aurora.wm.byApp('browser').length === 0, null, { timeout: 8000 });
    await s.page.waitForTimeout(300);
    await s.page.evaluate(() => window.__aurora.shell.launch('browser'));
    await waitFor('bw.tabs.length === 1 && bw.tabUrl(bw.active).endsWith("/page2?last=1")', { msg: 'restored the last tab' });
  });

  await test('no renderer errors (session 2)', async () => {
    const e = errors();
    assert(!e.length, e.join('\n'));
  });
  await s.close();
  fs.rmSync(home, { recursive: true, force: true });
}

// ======== Session 3: French + dark, internal pages, small and maximized windows
{
  const s = await launchShell({ open: ['browser'], theme: 'dark', lang: 'fr' });
  const { run, waitFor, errors } = harness(s);
  await waitFor('bw.tabs.length === 1 && document.querySelector(".app-browser .bp-ntp")');
  console.log('Session 3 (dark, fr)');

  await test('internal pages render in French (dark)', async () => {
    const r = await run(`({ ph: document.querySelector('.app-browser .bp-ntp-input').placeholder, tab: bw.tabTitle(bw.active), back: bw.backBtn.getAttribute('aria-label') })`);
    assert(/Rechercher avec DuckDuckGo/.test(r.ph), r.ph);
    assert(r.tab === 'Nouvel onglet', r.tab);
    assert(r.back === 'Précédent', r.back);
    const pages = { history: 'Historique', favorites: 'Favoris', downloads: 'Téléchargements', settings: 'Paramètres', about: 'À propos du Navigateur Aurora' };
    for (const [route, title] of Object.entries(pages)) {
      await run(`bw.navigate(bw.active, 'aurora://${route}')`);
      await waitFor(`document.querySelector('.app-browser .bw-view.active .bp-title')?.textContent === ${JSON.stringify(title)}`, { msg: `${route} title in French` });
    }
    await run('bw.navigate(bw.active, "aurora://settings")');
    await waitFor('document.querySelector(".app-browser .bw-view.active .bp-settings")');
    await run('(bw.omni.input.blur(), bw.focusPage())');
    await s.page.waitForTimeout(400);
    copyShot(await s.shot('browser-fr-dark'), 'browser-fr-dark');
  });

  await test('French: no English text in any menu, flyout, dialog or page', async () => {
    const pats = englishPatterns();
    const found = {};
    const close = async () => {
      for (let i = 0; i < 4 && (await s.page.locator('.menu').count()); i++) {
        await s.page.keyboard.press('Escape');
        await s.page.waitForTimeout(120);
      }
      assert(!(await s.page.locator('.menu').count()), 'menus close with Esc');
    };
    const scan = async (label) => {
      await s.page.waitForTimeout(250);
      const e = await findEnglish(s, pats);
      if (e.length) found[label] = e;
    };
    const dialogDone = async () => {
      await waitFor('document.activeElement?.closest(".dialog-layer:not(.closing)")', { msg: `focus in the dialog (${await s.page.evaluate(() => document.activeElement?.outerHTML.slice(0, 120))})` });
      await s.page.keyboard.press('Escape');
      await waitFor('!document.querySelector(".dialog-layer:not(.closing)")', { msg: 'dialog closed' });
    };
    const P = "(await import('app://shell/apps/browser/lib/panels.js'))";
    await run('bw.navigate(bw.active, "aurora://newtab")');
    await scan('new tab page');
    await s.page.click('.app-browser .bp-ntp-tool');
    await scan('new tab customize menu');
    await close();
    await s.page.click('.app-browser .bp-tile:not(.add)', { button: 'right' });
    await scan('shortcut menu');
    await close();
    await s.page.click('.app-browser .bp-tile.add');
    await s.page.waitForSelector('.dialog-layer:not(.closing)');
    await scan('add shortcut dialog');
    await dialogDone();
    await s.page.click('.app-browser .bw-tab', { button: 'right' });
    await scan('tab menu');
    await close();
    await s.page.click('.app-browser .bw-tbtn[aria-label="Paramètres et plus"]');
    await s.page.locator('.bw-menu .menu-item', { hasText: "Plus d'outils" }).hover();
    await s.page.waitForTimeout(400);
    await scan('settings and more menu + more tools');
    await close();
    await run(`${P}.favoritesMenu(bw, bw.favBtn)`);
    await scan('favorites menu');
    await close();
    await s.page.locator('.app-browser .bw-favbar .bw-fav.folder').first().click();
    await scan('favorites bar folder');
    await close();
    await s.page.click('.app-browser .bw-favbar', { button: 'right', position: { x: 600, y: 8 } });
    await scan('favorites bar menu');
    await close();
    await run(`bw.navigate(bw.active, '${srv.url}/dialogs')`);
    await waitFor('bw.active.web.title === "Dialogs page" && !bw.active.web.loading');
    await run(`${P}.favoriteFlyout(bw)`);
    await scan('favorite flyout');
    await run('bw.closeFlyout()');
    await run(`${P}.siteInfo(bw, bw.omni.siteBtn)`);
    await scan('site information');
    await run('bw.closeFlyout()');
    await run('bw.zoom(1)');
    await run(`${P}.zoomFlyout(bw, bw.omni.zoomBtn)`);
    await scan('zoom flyout');
    await run('(bw.closeFlyout(), bw.zoom(0))');
    await run('bw.findBar.open()');
    await s.page.keyboard.type('zzzz');
    await scan('find bar');
    await run('bw.findBar.close()');
    await run('bw.toggleDownloads()');
    await scan('downloads flyout');
    await run('bw.closeFlyout()');
    await run(`${P}.pageMenu(bw, bw.active, { x: 5, y: 5, linkURL: '${srv.url}/page2', mediaType: 'image', srcURL: '${srv.url}/favicon.svg', isEditable: false, selectionText: 'aurora', editFlags: {} })`);
    await scan('page menu: link, image, selection');
    await close();
    await run(`${P}.pageMenu(bw, bw.active, { x: 5, y: 5, linkURL: '', mediaType: 'video', srcURL: '${srv.url}/v.mp4', isEditable: true, selectionText: '', editFlags: {} })`);
    await scan('page menu: video, editable');
    await close();
    await run(`bw.active.wv.executeJavaScript("setTimeout(() => document.getElementById('prompt').click()); 0", true)`);
    await s.page.waitForSelector('.dialog-layer:not(.closing) .bw-jsdlg');
    await scan('page prompt dialog');
    await dialogDone();
    await run('(bw.findBar.open(), 0)');
    await run(`(${P}.clearDataDialog(bw), 0)`);
    await s.page.waitForSelector('.dialog-layer:not(.closing) .bw-clear');
    await scan('clear browsing data dialog');
    await dialogDone();
    for (const route of ['history', 'favorites', 'downloads', 'settings', 'about']) {
      await run(`bw.navigate(bw.active, 'aurora://${route}')`);
      await scan(`${route} page`);
    }
    await run(`(${P}.addFavoriteDialog(bw), 0)`);
    await s.page.waitForSelector('.dialog-layer:not(.closing)');
    await scan('add favorite dialog');
    await dialogDone();
    await run(`(${P}.editFavoriteDialog(bw, bw.store.bookmarks.bar.children[0]), 0)`);
    await s.page.waitForSelector('.dialog-layer:not(.closing)');
    await scan('edit favorite dialog');
    await dialogDone();
    await run(`(${P}.deleteFavorite(bw, bw.store.bookmarks.bar.children.find((n) => n.type === 'folder')), 0)`);
    await s.page.waitForSelector('.dialog-layer:not(.closing)');
    await scan('delete folder confirmation');
    await dialogDone();
    await run('bw.navigate(bw.active, "file:///etc/passwd")');
    await scan('blocked address page');
    await run('bw.navigate(bw.active, "aurora://nowhere")');
    await scan('unknown aurora page');
    await run('(window.__aurora && 0)');
    assert(!Object.keys(found).length, `English strings in the French UI: ${JSON.stringify(found)}`);
    // First-run favorites are localized too.
    const seeds = await run('bw.store.bookmarks.bar.children.find((n) => n.title === "Aurora OS").children.map((n) => n.title)');
    assert(seeds.includes('Paramètres du Navigateur Aurora'), `French seed favorites (${seeds})`);
    assert((await run(`shared.errorText({ code: 'ENOSPC' })`)) === "L'espace disque est insuffisant.", 'French error text');
  });

  await test('French error page and labels', async () => {
    await run(`bw.navigate(bw.active, 'http://127.0.0.1:${deadPort}/')`);
    await waitFor('bw.active.errorEl && bw.active.errorEl.isConnected');
    const title = await run('bw.active.errorEl.querySelector(".bp-err-title").textContent');
    assert(/impossible d'atteindre cette page/.test(title), title);
    await s.shot('browser-fr-dark-error');
  });

  await test('minimum window size keeps the toolbar usable (no overflow)', async () => {
    await run('bw.navigate(bw.active, "aurora://newtab")');
    await run('bw.win.setRect({ width: 520, height: 420 })');
    await s.page.waitForTimeout(400);
    const r = await run(`({ w: bw.win.el.getBoundingClientRect().width, tb: bw.toolbar.scrollWidth <= bw.toolbar.clientWidth + 1, omni: bw.omni.el.getBoundingClientRect().width, more: bw.moreBtn.getBoundingClientRect().right <= bw.win.el.getBoundingClientRect().right })`);
    assert(r.w === 520, `width ${r.w}`);
    assert(r.tb && r.more, 'toolbar fits');
    assert(r.omni >= 140, `omnibox width ${r.omni}`);
    for (let i = 0; i < 12; i++) await run('bw.newTab({ url: "aurora://about" })');
    await s.page.waitForTimeout(400);
    const tabs = await run(`({ min: Math.min(...bw.tabs.map((t) => t.el.getBoundingClientRect().width)), scroll: bw.tabsEl.scrollWidth > bw.tabsEl.clientWidth, activeVisible: (() => { const a = bw.active.el.getBoundingClientRect(); const c = bw.tabsEl.getBoundingClientRect(); return a.left >= c.left - 1 && a.right <= c.right + 1; })() })`);
    assert(tabs.min >= 50, `tabs shrink to a minimum width (${tabs.min})`);
    assert(tabs.activeVisible, 'active tab scrolled into view');
    await s.shot('browser-min-size');
    await run('bw.closeOtherTabs(bw.tabs[0])');
    for (const route of ['newtab', 'history', 'favorites', 'downloads', 'settings', 'about']) {
      await run(`bw.navigate(bw.active, 'aurora://${route}')`);
      await s.page.waitForTimeout(250);
      const o = await overflowing(s);
      assert(!o.length, `${route} page fits the minimum window (${o})`);
    }
    await run(`bw.navigate(bw.active, 'http://127.0.0.1:${deadPort}/')`);
    await waitFor('bw.active.errorEl?.isConnected');
    assert(!(await overflowing(s)).length, 'error page fits the minimum window');
  });

  await test('maximized window', async () => {
    await run('bw.win.maximize()');
    await s.page.waitForTimeout(500);
    await run('bw.navigate(bw.active, "aurora://favorites")');
    await s.page.waitForTimeout(400);
    await s.shot('browser-maximized-fr-dark');
    assert(await run('bw.win.isMaximized()'), 'maximized');
  });

  await test('user agent looks like Chrome (no Electron / app tokens)', async () => {
    const ua = await run(`bw.active.wv ? bw.active.wv.executeJavaScript('navigator.userAgent') : bw.ctx.api.invoke('browser:info').then((i) => i.ua)`);
    assert(/Chrome\/\d+\.0\.0\.0 Safari\/537\.36$/.test(ua) && !/Electron|aurora/i.test(ua), ua);
  });

  await test('certificate errors show the "connection isn\'t private" page (no trusted CA in this profile)', async () => {
    await run(`bw.navigate(bw.active, 'https://ubuntu.com/')`);
    let r = null;
    try {
      r = await waitFor('bw.active.web.error && { cert: bw.active.web.error.cert, name: bw.active.web.error.name }', { timeout: 30000 });
    } catch {}
    if (!r) {
      notes.push('cert-error check skipped: no error and no page (network?)');
      return;
    }
    if (!r.cert) {
      notes.push(`cert-error check: got ${r.name} instead of a certificate error (network blocked?)`);
      return;
    }
    const title = await run('bw.active.errorEl.querySelector(".bp-err-title").textContent');
    assert(title === "Votre connexion n'est pas privée", title);
    const st = await run('({ btn: bw.active.errorEl.querySelector(".btn.primary").textContent, chip: bw.omni.siteBtn.className, editing: bw.omni.editing, dirty: bw.omni.dirty, sec: bw.omni.security(bw.active) })');
    assert(st.btn === 'Revenir en arrière', `Go back button (${st.btn})`);
    assert(/danger/.test(st.chip), `danger chip (${JSON.stringify(st)})`);
    await s.page.waitForTimeout(400);
    await s.shot('browser-cert-error-fr-dark');
    await run('bw.navigate(bw.active, "aurora://favorites")');
  });

  await test('switching the language live updates the browser UI', async () => {
    await run('bw.navigate(bw.active, "aurora://favorites")');
    await run('window.__aurora.settings.set("lang", "en")');
    await waitFor('bw.backBtn.getAttribute("aria-label") === "Back" && bw.tabTitle(bw.active) !== "Favoris"', { msg: 'English labels' });
    assert(await run('document.querySelector(".app-browser .bw-view.active .bp-title").textContent === "Favorites"'), 'page re-rendered in English');
    await run('window.__aurora.settings.set("lang", "fr")');
    await waitFor('bw.backBtn.getAttribute("aria-label") === "Précédent"', { msg: 'French again' });
  });

  await test('no renderer errors (session 3)', async () => {
    const e = errors();
    assert(!e.length, e.join('\n'));
  });
  await s.close();
}

// ======== Session 5: maximized on common screen sizes (layout must fill and never overflow)
for (const [size, lang, theme] of [
  ['1280x720', 'fr', 'light'],
  ['1920x1080', 'en', 'dark'],
]) {
  const s = await launchShell({ open: ['browser'], theme, lang, size });
  const { run, waitFor, errors } = harness(s);
  await waitFor('bw.tabs.length === 1 && document.querySelector(".app-browser .bp-ntp")');
  console.log(`Session 5 (${size}, ${lang}, ${theme}, maximized)`);
  await test(`maximized ${size}: every page fills the window without horizontal overflow`, async () => {
    await run('bw.win.maximize()');
    await s.page.waitForTimeout(500);
    const [w] = size.split('x').map(Number);
    const r = await run(`({ win: bw.win.el.getBoundingClientRect().width, tb: bw.toolbar.scrollWidth <= bw.toolbar.clientWidth + 1, more: bw.moreBtn.getBoundingClientRect().right <= bw.win.el.getBoundingClientRect().right })`);
    assert(Math.abs(r.win - w) <= 1 && r.tb && r.more, `window ${r.win}px wide, toolbar fits (${JSON.stringify(r)})`);
    for (const route of ['newtab', 'history', 'favorites', 'downloads', 'settings', 'about']) {
      await run(`bw.navigate(bw.active, 'aurora://${route}')`);
      await s.page.waitForTimeout(250);
      const o = await overflowing(s);
      assert(!o.length, `${route}: ${o}`);
    }
    await run(`bw.navigate(bw.active, '${srv.url}/')`);
    await waitFor('bw.active.web.title === "Aurora Test Page" && !bw.active.web.loading');
    const wv = await run('(() => { const a = bw.active.wv.getBoundingClientRect(); const b = bw.views.getBoundingClientRect(); return Math.abs(a.width - b.width) < 1 && Math.abs(a.height - b.height) < 1; })()');
    assert(wv, 'the page fills the content area');
    await run('(bw.omni.input.blur(), bw.navigate(bw.active, "aurora://newtab"), 0)');
    await s.page.waitForTimeout(300);
    await s.shot(`browser-maximized-${size}`);
  });
  await test(`no renderer errors (${size})`, async () => {
    const e = errors();
    assert(!e.length, e.join('\n'));
  });
  await s.close();
}

// ======== Session 4: real HTTPS (network dependent; failures are reported, not fatal)
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-home-'));
  // A real user profile trusts the system/NSS certificate store; copy the build machine's NSS DB
  // (it contains the egress proxy CA in this container) so HTTPS can be verified normally.
  const nss = path.join(os.homedir(), '.pki', 'nssdb');
  if (fs.existsSync(nss)) fs.cpSync(nss, path.join(home, '.pki', 'nssdb'), { recursive: true });
  const s = await launchShell({ open: ['browser'], theme: 'light', lang: 'en', home });
  const { run, waitFor } = harness(s);
  await waitFor('bw.tabs.length === 1');
  console.log('Session 4 (real HTTPS)');
  let real = false;
  for (const site of ['https://ubuntu.com/', 'https://en.wikipedia.org/wiki/Aurora', 'https://example.com/']) {
    await run(`bw.navigate(bw.active, '${site}')`);
    try {
      await waitFor('!bw.active.web.loading && (bw.active.web.error || bw.active.web.title)', { timeout: 30000 });
    } catch {}
    const r = await run('({ err: bw.active.web.error?.name || null, title: bw.active.web.title, site: bw.omni.siteBtn.className })');
    notes.push(`${site}: ${r.err ? `failed (${r.err})` : `loaded "${r.title}"`}`);
    if (!r.err && r.title) {
      real = true;
      await test(`real HTTPS site loads with a secure lock (${site})`, async () => {
        assert(/secure/.test(r.site), `lock chip (${r.site})`);
      });
      try {
        await waitFor('!bw.active.web.loading', { timeout: 15000 });
      } catch {}
      await run('(bw.omni.input.blur(), bw.focusPage())');
      await s.page.waitForTimeout(5000); // let the site finish its own intro animations
      copyShot(await s.shot('browser-page'), 'browser-page');
      break;
    }
  }
  if (!real) {
    await run(`bw.navigate(bw.active, '${srv.url}/')`);
    await waitFor('bw.active.web.title === "Aurora Test Page" && !bw.active.web.loading');
    await run('(bw.omni.input.blur(), bw.focusPage())');
    await s.page.waitForTimeout(400);
    copyShot(await s.shot('browser-page'), 'browser-page');
    notes.push('No real HTTPS site was reachable; browser-page.png shows the local test page.');
  }
  await s.close();
  fs.rmSync(home, { recursive: true, force: true });
}

srv.server.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} tests passed`);
for (const n of notes) console.log(`note: ${n}`);
if (failed.length) {
  console.log('Failed:');
  for (const f of failed) console.log(` - ${f.name}: ${f.err?.message}`);
}
console.log(`Screenshots in ${OUT}`);
process.exit(failed.length ? 1 : 0);
