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
    await s.page.mouse.click(wv.x + r.x, wv.y + r.y, { button: 'right' });
    await s.page.waitForSelector('.menu .menu-item');
    const labels = await s.page.$$eval('.menu .menu-item .label', (els) => els.map((e) => e.textContent));
    for (const l of ['Open link in new tab', 'Open link in Private window', 'Copy link', 'Save link as…', 'View page source']) assert(labels.includes(l), `menu has ${l} (${labels})`);
    const n = await run('bw.tabs.length');
    await s.page.locator('.menu .menu-item', { hasText: 'Open link in new tab' }).click();
    await waitFor(`bw.tabs.length === ${n + 1}`, { msg: 'open link in new tab' });
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
    await s.page.click('.app-browser .bw-star');
    await s.page.waitForSelector('.app-browser .bw-fav-pop');
    await s.page.locator('.app-browser .bw-fav-pop .btn', { hasText: 'Remove' }).click();
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
    await waitFor('window.__aurora.wm.byApp("browser").length === 2', { msg: 'second window' });
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
    const stored = await run('bw.ctx.storage.get("prefs")');
    assert(stored && stored.engine === 'duckduckgo', 'prefs persisted');
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
  const s = await launchShell({ open: ['browser'], theme: 'light', lang: 'en', home, keepHome: false });
  const { run, waitFor, errors } = harness(s);
  console.log('Session 2 (restore, private window)');

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
    await waitFor('window.__aurora.wm.byApp("browser").length === 2', { msg: 'private window' });
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

  await test('relaunch with a URL opens a tab in the most recent normal window', async () => {
    const n = await run('bw.tabs.length');
    await run(`window.__aurora.shell.openUrl('${srv.url}/page2?from=shell')`);
    await waitFor(`bw.tabs.length === ${n + 1} && bw.active.web.title === 'Second Page'`, { msg: 'openUrl -> new tab' });
    assert(await run('window.__aurora.wm.byApp("browser").length === 1'), 'no extra window');
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
    await s.page.waitForTimeout(400);
    copyShot(await s.shot('browser-fr-dark'), 'browser-fr-dark');
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
  });

  await test('maximized window', async () => {
    await run('bw.win.maximize()');
    await s.page.waitForTimeout(500);
    await run('bw.navigate(bw.active, "aurora://favorites")');
    await s.page.waitForTimeout(400);
    await s.shot('browser-maximized-fr-dark');
    assert(await run('bw.win.isMaximized()'), 'maximized');
  });

  await test('no renderer errors (session 3)', async () => {
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
      await s.page.waitForTimeout(2500);
      copyShot(await s.shot('browser-page'), 'browser-page');
      break;
    }
  }
  if (!real) {
    await run(`bw.navigate(bw.active, '${srv.url}/')`);
    await waitFor('bw.active.web.title === "Aurora Test Page" && !bw.active.web.loading');
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
