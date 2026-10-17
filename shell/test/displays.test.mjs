// Several screens, end to end (dev shell, fake screens):
//   xvfb-run -a -s "-screen 0 3600x1500x24" node test/displays.test.mjs
// Pass 1 « desktop »: a 3520x1080 window holding two fake screens (AURORA_DEV_MONITORS: main 1920x1080 on the left,
//   1600x900 on the right): bar / Lanceur on the main screen, wallpaper on the other, new window on the pointer's screen,
//   maximize / snap per screen, Super+Shift+Left/Right, fullscreen per screen, unplug -> windows come back.
// Pass 2 « backend »: mock xrandr with a laptop panel + HDMI screen (AURORA_MOCK_DISPLAYS=2): display:setLayout,
//   remembered per set of screens, hot plug, lid closed -> external only and back (AURORA_LID_DIR fixture), Super+P.
// Pass 3 « settings »: Paramètres > Écran (Plusieurs écrans) FR 1280x720 Halo dark + light screenshots.
import { launchShell, OUT } from './lib.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let failed = 0;
let passed = 0;
function check(name, cond, extra = '') {
  if (cond) passed++;
  else {
    failed++;
    console.log(`FAIL ${name} ${extra}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 4000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) return v;
    await sleep(100);
  }
}

// ---------------------------------------------------------------- pass 1: the desktop on two screens
{
  const s = await launchShell({ size: '3520x1080', lang: 'fr', theme: 'dark', settings: { finish: 'halo' }, env: { AURORA_DEV_MONITORS: '1920x1080+0+0*,1600x900+1920+0' } });
  const { page } = s;
  const A = (fn, arg) => page.evaluate(fn, arg);
  check('monitors known', (await A(() => window.__aurora.monitors.list.length)) === 2);
  const bar = await A(() => {
    const r = document.getElementById('taskbar').getBoundingClientRect();
    return { x: r.x, right: r.right, bottom: r.bottom };
  });
  check('bar on the main screen only', bar.x >= 0 && bar.right <= 1920 && bar.bottom === 1080, JSON.stringify(bar));
  const wall = await A(() => {
    const w = document.querySelector('#screen-walls .screen-wall');
    if (!w) return null;
    const r = w.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, bg: getComputedStyle(w).backgroundColor };
  });
  check('wallpaper drawn on the second screen', wall && wall.x === 1920 && wall.w === 1600 && wall.h === 900, JSON.stringify(wall));
  const desk = await A(() => document.getElementById('desktop').getBoundingClientRect().width);
  check('desktop (icons, wallpaper) on the main screen', desk === 1920, String(desk));
  // Lanceur on the main screen
  await A(() => window.__aurora.shell.emit('start:toggle'));
  await sleep(500);
  const st = await A(() => document.getElementById('start').getBoundingClientRect().right);
  check('Lanceur on the main screen', st <= 1920 && st > 0, String(st));
  await A(() => window.__aurora.shell.emit('start:toggle'));
  await sleep(300);

  // new window on the screen of the pointer
  await page.mouse.move(2600, 400);
  await A(() => window.__aurora.registry.launch('calculator'));
  await sleep(700);
  let w = await A(() => {
    const x = window.__aurora.wm.focused();
    return { x: x.x, y: x.y, w: x.w, h: x.h };
  });
  check('new window opens on the pointer screen', w.x >= 1920 && w.x + w.w <= 3520 && w.y + w.h <= 900, JSON.stringify(w));
  await A(() => window.__aurora.wm.focused().maximize());
  await sleep(500);
  w = await A(() => window.__aurora.wm.focused().rect());
  check('maximize fills the second screen (no bar there)', w.x === 1920 && w.y === 0 && w.width === 1600 && w.height === 900, JSON.stringify(w));
  await s.shot('displays-two-screens-fr-dark');
  await A(() => window.__aurora.hotkeys.trigger('Super+Shift+ArrowLeft'));
  await sleep(600);
  w = await A(() => window.__aurora.wm.focused().rect());
  const mwa = await A(() => window.__aurora.wm.workarea());
  check('Super+Shift+Left: maximized on the main screen, above the bar', w.x === 0 && w.y === mwa.y && w.width === 1920 && w.height === mwa.height && mwa.height < 1080, JSON.stringify(w));
  await A(() => window.__aurora.hotkeys.trigger('Super+Shift+ArrowRight'));
  await sleep(600);
  await A(() => window.__aurora.wm.focused().restore());
  await sleep(500);
  w = await A(() => window.__aurora.wm.focused().rect());
  check('restore stays on the second screen', w.x >= 1920, JSON.stringify(w));
  await A(() => window.__aurora.wm.focused().snapTo('left'));
  await sleep(500);
  w = await A(() => window.__aurora.wm.focused().rect());
  check('snap left = left half of the second screen', w.x === 1920 && w.width === 800 && w.height === 900, JSON.stringify(w));
  const z = await A(() => window.__aurora.wm.zoneRect('right', window.__aurora.wm.focused()));
  check('zoneRect per screen (Layouts)', z.x === 2720 && z.width === 800, JSON.stringify(z));
  // fullscreen covers its own screen
  await A(() => window.__aurora.wm.focused().setFullscreen(true));
  await sleep(300);
  const fs1 = await A(() => {
    const r = window.__aurora.wm.focused().el.getBoundingClientRect();
    return { x: r.x, w: r.width, h: r.height };
  });
  check('fullscreen on its own screen', fs1.x === 1920 && fs1.w === 1600 && fs1.h === 900, JSON.stringify(fs1));
  await A(() => window.__aurora.wm.focused().setFullscreen(false));
  // drag a window across screens with the mouse
  await A(() => window.__aurora.wm.focused().restore());
  await sleep(400);
  await A(() => window.__aurora.registry.launch('clock'));
  await sleep(800);
  let n = await A(() => window.__aurora.wm.focused().rect());
  const tb = await A(() => {
    const r = window.__aurora.wm.focused().el.querySelector('.win-titlebar').getBoundingClientRect();
    return { x: r.right - 260, y: r.y + 10 };
  });
  await page.mouse.move(tb.x, tb.y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(tb.x - i * 110, tb.y + 20);
  await page.mouse.up();
  await sleep(400);
  n = await A(() => window.__aurora.wm.focused().rect());
  check('a window dragged to the main screen', n.x < 1920 - 200, JSON.stringify(n));
  // unplug the second screen: its windows come to the main one
  await page.mouse.move(2600, 300);
  await A(() => window.__aurora.registry.launch('calendar'));
  await sleep(800);
  await A(() => window.__aurora.api.invoke('display:devMonitors', '1920x1080+0+0*'));
  await sleep(600);
  const all = await A(() => window.__aurora.wm.list().map((x) => ({ app: x.appId, ...x.rect() })));
  check('unplugged: every window on the remaining screen', all.length >= 3 && all.every((r) => r.x >= 0 && r.x + Math.min(r.width, 64) <= 1920), JSON.stringify(all));
  check('one screen: no extra wallpaper', (await A(() => document.querySelectorAll('#screen-walls .screen-wall').length)) === 0);
  await A(() => window.__aurora.api.invoke('display:devMonitors', '1920x1080+0+0*,1600x900+1920+0'));
  await sleep(400);
  check('plugged back: two screens', (await A(() => window.__aurora.monitors.list.length)) === 2);
  // locked: the other screens are covered
  const lockZ = await A(() => {
    document.body.classList.add('aurora-locked');
    const z1 = Number(getComputedStyle(document.getElementById('screen-walls')).zIndex);
    document.body.classList.remove('aurora-locked');
    return z1 > Number(getComputedStyle(document.getElementById('windows')).zIndex);
  });
  check('locked: wallpaper above the windows on the other screens', lockZ);
  await s.close();
}

// ---------------------------------------------------------------- pass 2: xrandr layouts, hot plug, lid, Super+P
{
  const lid = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-lid-'));
  fs.mkdirSync(path.join(lid, 'LID0'));
  fs.writeFileSync(path.join(lid, 'LID0', 'state'), 'state:      open\n');
  const s = await launchShell({ size: '1600x900', lang: 'fr', theme: 'dark', env: { AURORA_MOCK_DISPLAYS: '2', AURORA_DISPLAY_WATCH: '1', AURORA_DISPLAY_WATCH_MS: '250', AURORA_LID_DIR: lid } });
  const { page } = s;
  const I = (ch, ...a) => page.evaluate(([c, args]) => window.__aurora.api.invoke(c, ...args), [ch, a]);
  let st = await I('display:status');
  check('two outputs', st.outputs.length === 2 && st.outputs.some((o) => o.internal), JSON.stringify(st.outputs.map((o) => o.name)));
  check('initial layout extend', st.layout.mode === 'extend' && st.lid === 'open', JSON.stringify(st.layout));
  let r = await I('display:setLayout', { mode: 'extend', position: 'left', primary: 'HDMI-1' });
  st = await I('display:status');
  const hd = st.outputs.find((o) => o.name === 'HDMI-1');
  check('setLayout: left + main screen', st.layout.position === 'left' && st.layout.primary === 'HDMI-1' && hd.x === 1920, JSON.stringify(st.layout));
  check('setLayout returns the previous layout', r.previous.mode === 'extend' && r.previous.primary === 'eDP-1');
  await I('display:saveLayout', { mode: 'extend', position: 'left', primary: 'HDMI-1' });
  const saved = JSON.parse(fs.readFileSync(path.join(s.home, '.config', 'aurora', 'display.json'), 'utf8'));
  const key = Object.keys(saved.layouts)[0];
  check('saved per set of screens (names + EDID)', saved.version === 2 && /HDMI-1:[0-9a-f]{8}\|eDP-1:[0-9a-f]{8}/.test(key) && saved.layouts[key].primary === 'HDMI-1', JSON.stringify(saved));
  const bad = await page.evaluate(() => window.__aurora.api.invoke('display:setLayout', { mode: 'rm -rf' }).then(() => 'accepted', (e) => e.code));
  check('invalid layout refused', bad === 'EINVAL', String(bad));
  // lid closed with the external screen: external only; open: back
  fs.writeFileSync(path.join(lid, 'LID0', 'state'), 'state:      closed\n');
  st = await until(async () => {
    const x = await I('display:status');
    return x.layout.mode === 'external' ? x : null;
  }, 5000);
  check('lid closed -> external screen only', st && st.outputs.find((o) => o.name === 'eDP-1').active === false, JSON.stringify(st?.layout));
  fs.writeFileSync(path.join(lid, 'LID0', 'state'), 'state:      open\n');
  st = await until(async () => {
    const x = await I('display:status');
    return x.layout.mode === 'extend' ? x : null;
  }, 5000);
  check('lid opened -> remembered layout back', st && st.layout.primary === 'HDMI-1' && st.layout.position === 'left', JSON.stringify(st?.layout));
  // unplug / plug: laptop only, then the remembered layout again
  st = await I('display:devPlug', false);
  check('unplugged: one screen', st.outputs.length === 1 && st.outputs[0].active);
  st = await I('display:devPlug', true);
  st = await until(async () => {
    const x = await I('display:status');
    return x.outputs.length === 2 && x.outputs.every((o) => o.active) ? x : null;
  }, 5000);
  check('plugged back: remembered layout re-applied', st && st.layout.primary === 'HDMI-1' && st.layout.position === 'left', JSON.stringify(st?.layout));
  // Super+P picker
  await page.evaluate(() => window.__aurora.hotkeys.trigger('Super+P'));
  await page.waitForSelector('.proj-panel .proj-opt', { timeout: 4000 }).catch(() => null);
  const opts = await page.$$eval('.proj-opt', (els) => els.map((e) => e.dataset.mode));
  check('Super+P: four modes', opts.join(',') === 'extend,mirror,external,internal', opts.join(','));
  check('Super+P: French labels', (await page.textContent('.proj-panel')).includes('Seulement l’écran externe'));
  await s.shot('displays-projection-fr-dark');
  await page.click('.proj-opt[data-mode="mirror"]');
  st = await until(async () => {
    const x = await I('display:status');
    return x.layout.mode === 'mirror' ? x : null;
  });
  check('picker applies Dupliquer', !!st);
  check('picker closes', (await page.$('.proj-panel')) === null);
  const saved2 = JSON.parse(fs.readFileSync(path.join(s.home, '.config', 'aurora', 'display.json'), 'utf8'));
  check('picker choice remembered', Object.values(saved2.layouts)[0].mode === 'mirror');
  await page.evaluate(() => window.__aurora.hotkeys.trigger('Super+P'));
  await page.waitForSelector('.proj-panel', { timeout: 3000 }).catch(() => null);
  await page.keyboard.press('Escape');
  await sleep(200);
  check('Escape closes the picker', (await page.$('.proj-panel')) === null);
  await I('display:project', 'extend');
  await s.close();
}

// ---------------------------------------------------------------- pass 3: Paramètres > Écran screenshots
for (const theme of ['dark', 'light']) {
  const s = await launchShell({ size: '1280x720', lang: 'fr', theme, settings: { finish: 'halo' }, env: { AURORA_MOCK_DISPLAYS: '2' } });
  const { page } = s;
  await page.evaluate(() => window.__aurora.registry.launch('settings', { page: 'display' }));
  await page.waitForSelector('.st-display-map', { timeout: 8000 }).catch(() => null);
  await page.evaluate(() => window.__aurora.wm.focused()?.maximize());
  await sleep(800);
  const txt = await page.evaluate(() => document.querySelector('.win.active')?.innerText || '');
  check(`Écran page (${theme}): multi-screen group`, txt.includes('Plusieurs écrans') && txt.includes('Utilisation de vos écrans') && txt.includes('Écran principal'), txt.slice(0, 300));
  check(`Écran page (${theme}): arrangement map`, (await page.$$('.st-display-map .st-monitor')).length === 2);
  await s.shot(`displays-settings-fr-${theme}`);
  await s.close();
}

console.log(`displays: ${passed} passed, ${failed} failed (screenshots in ${OUT})`);
process.exit(failed ? 1 : 0);
