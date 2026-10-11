// External X11 windows (docs/XWINDOWS.md): region.js unit checks, the renderer/main integration driven by
// the fake helper (test/fixtures/xwm-fake), then — when rootfs/usr/lib/aurora/helpers/aurora-xwm exists —
// an end-to-end run with the real helper and a real xterm (pixels checked in an xwd root capture).
//   xvfb-run -a -s '-screen 0 1600x900x24' node test/xwin.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { launchShell, ROOT } from './lib.mjs';

const require = createRequire(import.meta.url);
const region = require('../main/lib/region.js');
let passed = 0;
let failed = 0;
function check(name, ok, extra = '') {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && extra ? ` — ${extra}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 6000, step = 60) {
  const end = Date.now() + ms;
  for (;;) {
    let v;
    try {
      v = await fn();
    } catch {
      v = null;
    }
    if (v) return v;
    if (Date.now() > end) return v;
    await sleep(step);
  }
}

// ------------------------------------------------------------------ region.js
{
  const S = { x: 0, y: 0, width: 1600, height: 900 };
  const hole = { x: 100, y: 100, width: 400, height: 300 };
  check('region: norm drops empty rects', region.norm({ x: 0, y: 0, width: 0, height: 5 }) === null && region.norm(null) === null);
  check('region: subtract inner rect gives 4 pieces', region.subtract(S, hole).length === 4);
  check('region: subtract disjoint keeps the rect', region.subtract(hole, { x: 900, y: 0, width: 10, height: 10 }).length === 1);
  check('region: subtract covering rect leaves nothing', region.subtract(hole, S).length === 0);
  const c1 = region.complement(S, [hole]);
  check('region: complement area = screen − hole', region.area(c1) === 1600 * 900 - 400 * 300, String(region.area(c1)));
  check('region: complement is compact (≤ 4 rects)', c1.length <= 4, String(c1.length));
  const c2 = region.complement(S, [hole, { x: 300, y: 200, width: 400, height: 300 }]);
  check('region: overlapping holes counted once', region.area(c2) === 1600 * 900 - (400 * 300 + 400 * 300 - 200 * 200), String(region.area(c2)));
  const pts = [[150, 150], [650, 450], [50, 50], [1500, 800]];
  const inside = (rs, [x, y]) => rs.some((r) => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height);
  check('region: points in holes are not in the shape', !inside(c2, pts[0]) && !inside(c2, pts[1]) && inside(c2, pts[2]) && inside(c2, pts[3]));
  check('region: no holes -> whole screen', region.complement(S, []).length === 1);
  check('region: hole outside bounds is clipped', region.area(region.complement(S, [{ x: 1500, y: 800, width: 400, height: 400 }])) === 1600 * 900 - 100 * 100);
  const many = Array.from({ length: 200 }, (_, i) => ({ x: (i % 20) * 80 + 5, y: Math.floor(i / 20) * 80 + 5, width: 30, height: 30 }));
  check('region: rect count limited by max', region.complement(S, many, { max: 60 }).length <= 60);
  check('region: equal()', region.equal([{ x: 1, y: 2, width: 3, height: 4 }], [{ x: 1, y: 2, width: 3, height: 4 }]) && !region.equal([], [{ x: 1, y: 2, width: 3, height: 4 }]));
  check('region: subtractAll', region.area(region.subtractAll([S], [hole, { x: 0, y: 0, width: 1600, height: 50 }])) === 1600 * 850 - 400 * 300);
}

// ------------------------------------------------------------------ fake helper
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-xwin-'));
const CTL = path.join(tmp, 'ctl');
const LOG = path.join(tmp, 'log');
fs.writeFileSync(CTL, '');
fs.writeFileSync(LOG, '');
const FAKE = path.join(ROOT, 'test', 'fixtures', 'xwm-fake', 'aurora-xwm');
const emit = (o) => fs.appendFileSync(CTL, `${JSON.stringify(o)}\n`);
const cmds = () =>
  fs
    .readFileSync(LOG, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
const lastCmd = (pred) => cmds().filter(pred).pop();

const ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const XID = 4194305;
const s = await launchShell({ env: { AURORA_XWM: '1', AURORA_XWM_HELPER: FAKE, AURORA_XWM_FAKE_LOG: LOG, AURORA_XWM_FAKE_CTL: CTL } });
const { page } = s;
try {
  // Device px = CSS px + the shell window's content origin (zoom and scale are 1 here). The dev window is centred
  // by Electron, so the origin is not (0,0) when the Xvfb screen is larger than the window (run-all uses 1920x1080).
  const O = await s.app.evaluate(({ BrowserWindow }) => {
    const b = BrowserWindow.getAllWindows()[0].getContentBounds();
    return { x: b.x, y: b.y };
  });
  const st = await waitFor(() => page.evaluate(() => window.__aurora.api.invoke('xwin:status')).then((x) => x?.ready && x));
  check('helper started and ready', !!st?.ready && st.enabled, JSON.stringify(st));
  await waitFor(() => page.evaluate(() => !!window.__aurora.xwin));

  emit({ ev: 'new', id: XID, title: 'Fake Term', wmClass: ['fakeprog', 'FakeProg'], pid: null, type: 'normal', transientFor: null, modal: false, x: 0, y: 0, width: 640, height: 400, minWidth: 100, minHeight: 80, maxWidth: 0, maxHeight: 0, decorated: true, fullscreen: false, icon: null, startupId: null, gtkAppId: null });
  const info = await waitFor(() =>
    page.evaluate((id) => {
      const rec = window.__aurora.xwin.frames.get(id);
      if (!rec?.win || rec.win.el.getAnimations().length) return null;
      const w = rec.win;
      const b = w.body.getBoundingClientRect();
      return { cls: w.el.className, title: w.el.querySelector('.win-title')?.textContent, appId: w.appId, name: window.__aurora.registry.name(w.appId), bw: Math.round(b.width), bh: Math.round(b.height), kids: w.body.querySelectorAll(':scope > :not(.xwin-ph)').length, bg: getComputedStyle(w.body).backgroundColor };
    }, XID),
  );
  check('frame created from new', !!info && /\bxwin\b/.test(info.cls), JSON.stringify(info));
  check('frame shows the client title', info?.title === 'Fake Term', info?.title);
  check('unknown app gets a transient registry entry', info?.appId === 'x11:fakeprog' && info?.name === 'FakeProg', `${info?.appId} ${info?.name}`);
  check('content area matches the client size', info?.bw === 640 && info?.bh === 400, `${info?.bw}x${info?.bh}`);
  check('content area is empty and transparent', info?.kids === 0 && /rgba\(0, 0, 0, 0\)|transparent/.test(info?.bg || ''), `${info?.kids} ${info?.bg}`);
  const tb = await waitFor(() => page.evaluate(() => !!document.querySelector('#taskbar [data-app="x11:fakeprog"]')));
  check('taskbar entry for the external window', tb);
  const p0 = await waitFor(() => lastCmd((c) => c.cmd === 'place' && c.id === XID));
  check('place sent on creation (device px)', p0 && p0.width === 640 && p0.height === 400, JSON.stringify(p0));

  emit({ ev: 'title', id: XID, title: 'user@host: ~' });
  emit({ ev: 'icon', id: XID, icon: ICON });
  const ti = await waitFor(() => page.evaluate((id) => {
    const w = window.__aurora.xwin.frames.get(id).win;
    return { title: w.title, icon: String(w.iconUrl).slice(0, 22) };
  }, XID).then((r) => r.title === 'user@host: ~' && r.icon?.startsWith('data:image/png') && r));
  check('title and icon updates reach the frame', !!ti, JSON.stringify(ti));

  // move -> place at the new content position
  const moved = await page.evaluate((id) => {
    const w = window.__aurora.xwin.frames.get(id).win;
    w.setRect({ x: 200, y: 150 });
    const b = w.body.getBoundingClientRect();
    return { x: Math.round(b.left), y: Math.round(b.top), width: Math.round(b.width), height: Math.round(b.height) };
  }, XID);
  const p1 = await waitFor(() => lastCmd((c) => c.cmd === 'place' && c.id === XID && c.x === moved.x + O.x && c.y === moved.y + O.y));
  check('move -> place with the content origin', !!p1, `${JSON.stringify(moved)} last=${JSON.stringify(lastCmd((c) => c.cmd === 'place'))}`);
  await page.evaluate((id) => window.__aurora.xwin.frames.get(id).win.setRect({ width: 700, height: 500 }), XID);
  const p2 = await waitFor(() => lastCmd((c) => c.cmd === 'place' && c.id === XID && c.width === 698));
  check('resize -> place with the content size', !!p2, JSON.stringify(lastCmd((c) => c.cmd === 'place')));

  // maximize
  await page.evaluate((id) => window.__aurora.xwin.frames.get(id).win.maximize(), XID);
  await sleep(500);
  const mx = await page.evaluate((id) => {
    const w = window.__aurora.xwin.frames.get(id).win;
    const b = w.body.getBoundingClientRect();
    return { x: Math.round(b.left), y: Math.round(b.top), width: Math.round(b.width), height: Math.round(b.height), wa: window.__aurora.wm.workarea() };
  }, XID);
  const p3 = await waitFor(() => lastCmd((c) => c.cmd === 'place' && c.id === XID && c.width === mx.width && c.height === mx.height && c.y === mx.y + O.y));
  check('maximize -> place fills the work area', !!p3 && mx.width >= mx.wa.width - 2, `${JSON.stringify(mx)} ${JSON.stringify(lastCmd((c) => c.cmd === 'place'))}`);
  check('maximize -> state command', !!(await waitFor(() => lastCmd((c) => c.cmd === 'state' && c.id === XID && c.maximized === true))));

  // shape: holes = content minus taskbar
  const sh = await waitFor(async () => {
    const d = await page.evaluate(() => window.__aurora.api.invoke('xwin:debug'));
    return d?.holes?.length && d;
  });
  const tbr = await page.evaluate(() => {
    const r = document.getElementById('taskbar').getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  });
  const hits = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
  check('shape holes computed', !!sh && sh.holes.length >= 1 && sh.shape.length >= 1, JSON.stringify(sh?.holes));
  check('holes exclude the taskbar', !!sh && !sh.holes.some((r) => hits(r, tbr)), JSON.stringify({ holes: sh?.holes, tbr }));
  const area0 = sh ? region.area(sh.holes) : 0;
  check('hole covers the maximized content', area0 >= mx.width * mx.height * 0.95, `${area0}`);

  // Start menu above the client
  await page.evaluate(() => window.__aurora.start.open());
  await sleep(700);
  const sr = await page.evaluate(() => {
    const r = document.getElementById('start').getBoundingClientRect();
    return { open: document.getElementById('start').classList.contains('open'), x: r.left, y: r.top, width: r.width, height: r.height };
  });
  const sh2 = await waitFor(async () => {
    const d = await page.evaluate(() => window.__aurora.api.invoke('xwin:debug'));
    return d && !d.holes.some((r) => hits(r, sr)) && d;
  });
  check('open Start menu is cut out of the holes', sr.open && !!sh2, JSON.stringify({ sr, holes: sh2?.holes }));
  await page.evaluate(() => window.__aurora.start.close());
  await sleep(500);
  const sh3 = await waitFor(async () => {
    const d = await page.evaluate(() => window.__aurora.api.invoke('xwin:debug'));
    return d && region.area(d.holes) >= area0 * 0.99 && d;
  });
  check('Start closed -> hole restored', !!sh3);

  // DOM window above the external one
  await page.evaluate(() => window.__aurora.registry.launch('notepad'));
  const np = await waitFor(() => page.evaluate(() => {
    const w = window.__aurora.wm.focused();
    return w && w.appId === 'notepad' && !w.el.getAnimations().length && w.rect();
  }));
  await sleep(400);
  const sh4 = await page.evaluate(() => window.__aurora.api.invoke('xwin:debug'));
  check('DOM window above is cut out of the hole', !!np && !sh4.holes.some((r) => hits(r, { x: np.x + 2, y: np.y + 2, width: np.width - 4, height: np.height - 4 })), JSON.stringify({ np, holes: sh4.holes }));
  check('focus moved to a DOM window -> focus null', !!(await waitFor(() => { const c = lastCmd((x) => x.cmd === 'focus'); return c && c.id === null; })), JSON.stringify(lastCmd((x) => x.cmd === 'focus')));
  const before = cmds().length;
  await page.evaluate((id) => window.__aurora.xwin.frames.get(id).win.focus(), XID);
  check('external frame focused -> focus id', !!(await waitFor(() => cmds().slice(before).some((c) => c.cmd === 'focus' && c.id === XID))));
  check('stack command puts the client on top of the X stack', !!(await waitFor(() => { const c = lastCmd((x) => x.cmd === 'stack'); return c && c.ids[c.ids.length - 1] === XID; })));
  // the client clicked: the helper reports it, the frame is raised
  await page.evaluate(() => window.__aurora.wm.byApp('notepad')[0].focus());
  await sleep(200);
  emit({ ev: 'click', id: XID });
  check('click event raises and focuses the frame', !!(await waitFor(() => page.evaluate((id) => window.__aurora.wm.focused()?.xwin === id, XID))));
  await page.evaluate(() => window.__aurora.wm.byApp('notepad')[0].close(true));

  // system keys from the helper behave like the shell's own hotkeys
  await page.evaluate(() => window.__aurora.registry.launch('calculator'));
  await sleep(800);
  emit({ ev: 'key', combo: 'Alt+Tab', repeat: false });
  check('key Alt+Tab opens the switcher', !!(await waitFor(() => page.evaluate(() => window.__aurora.alttab?.isOpen))));
  const altShown = await waitFor(() => page.evaluate(() => !!document.querySelector('.alttab .alttab-icon, .alttab-item, .alttab')));
  check('switcher lists the external window (window icon)', !!(await waitFor(() => page.evaluate(() => [...document.querySelectorAll('img')].some((i) => i.closest('#overlays') && i.src.startsWith('data:image/png'))))), String(altShown));
  emit({ ev: 'key', combo: 'Alt:up' });
  check('Alt:up commits the switcher', !!(await waitFor(() => page.evaluate(() => !window.__aurora.alttab.isOpen))));
  await page.evaluate(() => window.__aurora.wm.byApp('calculator')[0]?.close(true));
  await sleep(300);

  // drag from the helper moves the frame (no place sent back while dragging)
  await page.evaluate((id) => window.__aurora.xwin.frames.get(id).win.restore(), XID);
  await sleep(500);
  const nPlace = cmds().filter((c) => c.cmd === 'place').length;
  emit({ ev: 'drag', id: XID, x: 300 + O.x, y: 260 + O.y, width: 698, height: 467, done: false });
  const dr = await waitFor(() => page.evaluate((id) => {
    const b = window.__aurora.xwin.frames.get(id).win.body.getBoundingClientRect();
    return Math.round(b.left) === 300 && Math.round(b.top) === 260 && { x: b.left, y: b.top };
  }, XID));
  check('drag event moves the frame onto the client', !!dr);
  check('no place sent back during a helper drag', cmds().filter((c) => c.cmd === 'place').length === nPlace);
  emit({ ev: 'drag', id: XID, x: 320 + O.x, y: 260 + O.y, width: 698, height: 467, done: true });
  await sleep(300);
  // configure-request
  emit({ ev: 'configure-request', id: XID, width: 500, height: 300 });
  check('configure-request resizes and answers with place', !!(await waitFor(() => lastCmd((c) => c.cmd === 'place' && c.id === XID && c.width === 500 && c.height === 300))));
  emit({ ev: 'state-request', id: XID, fullscreen: true });
  check('fullscreen state request -> setFullscreen', !!(await waitFor(() => page.evaluate((id) => window.__aurora.xwin.frames.get(id).win.fullscreen, XID))));
  emit({ ev: 'state-request', id: XID, fullscreen: false });
  await sleep(300);
  emit({ ev: 'state-request', id: XID, minimized: true });
  check('minimize request -> frame minimized, no hole', !!(await waitFor(async () => (await page.evaluate((id) => window.__aurora.xwin.frames.get(id).win.minimized, XID)) && (await page.evaluate(() => window.__aurora.api.invoke('xwin:debug'))).holes.length === 0)));
  await page.evaluate((id) => window.__aurora.xwin.frames.get(id).win.restoreFromMinimize(), XID);
  await sleep(600);

  // dialog transient for the main window: centred over its parent, no taskbar entry
  const DLG = XID + 7;
  emit({ ev: 'new', id: DLG, title: 'Dialog', wmClass: ['xterm', 'XTerm'], type: 'dialog', transientFor: XID, x: 0, y: 0, width: 300, height: 120, minWidth: 0, minHeight: 0, maxWidth: 0, maxHeight: 0, decorated: true, fullscreen: false, icon: null });
  const dl = await waitFor(() => page.evaluate(([a, b]) => {
    const p = window.__aurora.xwin.frames.get(a)?.win;
    const d = window.__aurora.xwin.frames.get(b)?.win;
    return d && p && { dc: d.x + d.w / 2, pc: p.x + p.w / 2, dy: d.y + d.h / 2, py: p.y + p.h / 2, skip: !!d.opts.skipTaskbar };
  }, [XID, DLG]));
  check('dialog centred over its parent', !!dl && Math.abs(dl.dc - dl.pc) <= 2 && Math.abs(dl.dy - dl.py) <= 2 && dl.skip, JSON.stringify(dl));
  emit({ ev: 'gone', id: DLG });
  check('gone removes the dialog frame', !!(await waitFor(() => page.evaluate((id) => !window.__aurora.xwin.frames.has(id) && !document.querySelector('.win.xwin-dialog'), DLG))));

  // close -> 'close' command; the fake client goes away
  await page.evaluate((id) => window.__aurora.xwin.frames.get(id).win.close(), XID);
  check('close sends the close command', !!(await waitFor(() => lastCmd((c) => c.cmd === 'close' && c.id === XID))));
  check('gone removes the frame and taskbar entry', !!(await waitFor(() => page.evaluate(() => !document.querySelector('.win.xwin') && !document.querySelector('#taskbar [data-app="x11:fakeprog"]')))));
  const sh5 = await waitFor(async () => {
    const d = await page.evaluate(() => window.__aurora.api.invoke('xwin:debug'));
    return d && d.holes.length === 0 && d;
  });
  check('no external window -> rectangular shell (no holes)', !!sh5 && sh5.shape.length === 0);

  // a stubborn client: End task after 5 s
  const STB = XID + 20;
  emit({ fake: 'stubborn', id: STB });
  emit({ ev: 'new', id: STB, title: 'Stubborn', wmClass: ['stub', 'Stub'], type: 'normal', transientFor: null, x: 0, y: 0, width: 400, height: 300, decorated: false, fullscreen: false, icon: null });
  const und = await waitFor(() => page.evaluate((id) => {
    const w = window.__aurora.xwin.frames.get(id)?.win;
    return w && { tb: !!w.el.querySelector(':scope > .win-titlebar'), cls: w.el.className };
  }, STB));
  check('undecorated client: frame without our title bar', !!und && !und.tb && /xwin-undecorated/.test(und.cls), JSON.stringify(und));
  await page.evaluate((id) => window.__aurora.xwin.frames.get(id).win.close(), STB);
  await sleep(1000);
  check('stubborn client still framed after close', await page.evaluate((id) => window.__aurora.xwin.frames.has(id), STB));
  const btn = await waitFor(() => page.evaluate(() => { const l = [...document.querySelectorAll('.xwin-stuck button')].map((b) => b.textContent); return l.length && l; }), 9000);
  check('"End task" offered after 5 s', Array.isArray(btn) && btn.includes('End task'), JSON.stringify(btn) + (await page.evaluate(() => document.getElementById('overlays').innerHTML.slice(0, 400))) + s.logs.slice(-5).join(' | '));
  await page.evaluate(() => [...document.querySelectorAll('.xwin-stuck button')].find((b) => b.textContent === 'End task')?.click());
  check('End task -> kill command, frame removed', !!(await waitFor(() => lastCmd((c) => c.cmd === 'kill' && c.id === STB))) && !!(await waitFor(() => page.evaluate((id) => !window.__aurora.xwin.frames.has(id), STB))));

  // FR strings
  const fr = await page.evaluate(() => {
    const { i18n, t } = window.__aurora;
    const prev = i18n.lang;
    i18n.setLang('fr');
    const v = t('xwin.endTask');
    i18n.setLang(prev);
    return v;
  });
  check('French strings', fr === 'Fin de tâche', fr);

  // helper restart: frames reset, helper re-announced
  emit({ ev: 'new', id: XID + 30, title: 'Again', wmClass: ['xterm', 'XTerm'], type: 'normal', x: 0, y: 0, width: 300, height: 200, decorated: true, icon: null });
  await waitFor(() => page.evaluate((id) => window.__aurora.xwin.frames.has(id), XID + 30));
  emit({ fake: 'exit', code: 1 });
  check('helper exit drops the frames', !!(await waitFor(() => page.evaluate(() => window.__aurora.xwin.frames.size === 0))));
  const st2 = await waitFor(() => page.evaluate(() => window.__aurora.api.invoke('xwin:status')).then((x) => x?.ready && x.restarts >= 1 && x), 8000);
  check('helper restarted', !!st2, JSON.stringify(st2));
} catch (err) {
  check('fake-helper part ran without exceptions', false, err?.stack || String(err));
} finally {
  await s.close();
}

// ------------------------------------------------------------------ end to end (real helper + xterm)
const REAL = path.join(ROOT, '..', 'rootfs', 'usr', 'lib', 'aurora', 'helpers', 'aurora-xwm');
const have = (b) => spawnSync('sh', ['-c', `command -v ${b}`]).status === 0;
if (!fs.existsSync(REAL)) {
  console.log(`SKIP end-to-end part: ${REAL} does not exist yet`);
} else if (!have('xterm') || !have('xwd') || !have('convert') || !have('xdotool')) {
  console.log('SKIP end-to-end part: xterm / xwd / convert / xdotool missing');
} else {
  await e2e().catch((err) => check('end-to-end part ran without exceptions', false, err?.stack || String(err)));
}

async function e2e() {
  const xs = await launchShell({ env: { AURORA_XWM: '1', AURORA_XWM_HELPER: REAL } });
  const { page: pg } = xs;
  let term = null;
  const okFile = path.join(tmp, 'xwin-ok');
  const pixel = (x, y) => {
    const png = path.join(tmp, 'root.png');
    execFileSync('sh', ['-c', `xwd -root -silent | convert xwd:- ${png}`]);
    const out = execFileSync('convert', [png, '-crop', `1x1+${x}+${y}`, '-depth', '8', 'txt:-']).toString();
    const m = /\((\d+),(\d+),(\d+)/.exec(out.split('\n')[1] || '');
    return m ? m.slice(1, 4).map(Number) : null;
  };
  try {
    const ready = await waitFor(() => pg.evaluate(() => window.__aurora.api.invoke('xwin:status')).then((x) => x?.ready && x), 10000);
    check('e2e: real helper ready', !!ready, JSON.stringify(await pg.evaluate(() => window.__aurora.api.invoke('xwin:status'))));
    if (!ready) return;
    term = (await import('node:child_process')).spawn('xterm', ['-bg', 'rgb:ff/00/ff', '-fg', 'black', '-geometry', '80x24', '-e', 'sh'], { stdio: 'ignore', detached: false });
    const fr = await waitFor(() => pg.evaluate(() => {
      const rec = [...window.__aurora.xwin.frames.values()][0];
      if (!rec?.win || rec.win.el.getAnimations().length) return null;
      const b = rec.win.body.getBoundingClientRect();
      return { id: rec.id, x: b.left, y: b.top, w: b.width, h: b.height };
    }), 10000);
    check('e2e: xterm gets a frame', !!fr);
    if (!fr) return;
    await sleep(1200);
    const cx = Math.round(fr.x + fr.w - 30);
    const cy = Math.round(fr.y + fr.h - 30);
    const px = pixel(cx, cy);
    check('e2e: xterm pixels visible in the content area', !!px && px[0] > 200 && px[1] < 60 && px[2] > 200, JSON.stringify(px));
    execFileSync('mkdir', ['-p', path.join(ROOT, '..', 'docs', 'screenshots')]);
    execFileSync('sh', ['-c', `xwd -root -silent | convert xwd:- ${path.join(ROOT, '..', 'docs', 'screenshots', 'xwin-xterm.png')}`]);
    execFileSync('xdotool', ['mousemove', String(cx), String(cy), 'click', '1']);
    await sleep(500);
    execFileSync('xdotool', ['type', '--delay', '20', `echo XWIN_OK > ${okFile}`]);
    execFileSync('xdotool', ['key', 'Return']);
    check('e2e: typing after a click reaches xterm', !!(await waitFor(() => fs.existsSync(okFile) && fs.readFileSync(okFile, 'utf8').includes('XWIN_OK'), 6000)));
    await pg.evaluate((id) => window.__aurora.xwin.frames.get(id).win.minimize(), fr.id);
    await sleep(1000);
    const pm = pixel(cx, cy);
    check('e2e: minimize hides the client', !!pm && !(pm[0] > 200 && pm[1] < 60 && pm[2] > 200), JSON.stringify(pm));
    await pg.evaluate((id) => window.__aurora.xwin.frames.get(id).win.restoreFromMinimize(), fr.id);
    await sleep(1000);
    await pg.evaluate(() => window.__aurora.start.open());
    await sleep(1000);
    const srr = await pg.evaluate(() => {
      const r = document.getElementById('start').getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    });
    const ix = Math.round(Math.max(fr.x, srr.x) + 10);
    const iy = Math.round(Math.max(fr.y, srr.y) + 10);
    const inBoth = ix < fr.x + fr.w && ix < srr.x + srr.w && iy < fr.y + fr.h && iy < srr.y + srr.h;
    const ps = inBoth ? pixel(ix, iy) : null;
    check('e2e: Start menu opened over the client covers it', inBoth && !!ps && !(ps[0] > 200 && ps[1] < 60 && ps[2] > 200), JSON.stringify({ ps, srr, fr }));
    await pg.evaluate(() => window.__aurora.start.close());
    await sleep(400);
    await pg.evaluate((id) => window.__aurora.xwin.frames.get(id).win.close(), fr.id);
    const ended = await waitFor(() => term.exitCode !== null || term.signalCode !== null, 6000);
    check('e2e: close ends xterm', !!ended);
  } finally {
    if (term && term.exitCode === null) term.kill();
    await xs.close();
  }
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
