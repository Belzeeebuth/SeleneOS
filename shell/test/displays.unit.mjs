// Several screens — layout maths (no Electron):  node test/displays.unit.mjs
//   main/lib/display-layout.js: planLayout (xrandr argv for Étendre / Dupliquer / external / internal, arrangement,
//   main screen, per-screen modes), currentLayout, setKey + parseEdids, simulate;
//   renderer/core/monitors.js: monitorAt, monitorForRect, neighbour, relocate, workareaOf;
//   main/ipc/display.js: parseMonitorSpec.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const L = require('../main/lib/display-layout.js');
const { parseMonitorSpec } = require('../main/ipc/display.js');
globalThis.window = { aurora: { env: {} } };
const M = await import('../renderer/core/monitors.js');

let failed = 0;
let passed = 0;
function check(name, cond, extra = '') {
  if (cond) passed++;
  else {
    failed++;
    console.log(`FAIL ${name} ${extra}`);
  }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const mode = (w, h, rates, pref = false) => ({ width: w, height: h, rates, preferred: pref, names: Object.fromEntries(rates.map((r) => [r, `${w}x${h}`])) });
const laptop = () => ({ name: 'eDP-1', primary: true, active: true, x: 0, y: 0, width: 1920, height: 1080, rate: 60, preferred: { width: 1920, height: 1080, rate: 60 }, modes: [mode(1920, 1080, [60, 48], true), mode(1280, 720, [60])] });
const hdmi = (on = false) => ({ name: 'HDMI-1', primary: false, active: on, x: on ? 1920 : 0, y: 0, width: on ? 2560 : null, height: on ? 1440 : null, rate: on ? 59.95 : null, preferred: { width: 2560, height: 1440, rate: 59.95 }, modes: [mode(2560, 1440, [59.95], true), mode(1920, 1080, [60, 50]), mode(1280, 720, [60])] });

// ---- planLayout: extend
let p = L.planLayout([laptop(), hdmi()], { mode: 'extend' });
check('extend: both on', eq(p.active, ['eDP-1', 'HDMI-1']) && !p.off.length);
check('extend: laptop main by default', p.primary === 'eDP-1');
check('extend: new screen on the right at its preferred mode', eq(p.rects['HDMI-1'], { x: 1920, y: 0, width: 2560, height: 1440 }), JSON.stringify(p.rects));
check('extend argv', eq(p.args, ['--output', 'eDP-1', '--mode', '1920x1080', '--rate', '60', '--pos', '0x0', '--scale', '1x1', '--primary', '--output', 'HDMI-1', '--mode', '2560x1440', '--pos', '1920x0', '--scale', '1x1']), p.args.join(' '));
p = L.planLayout([laptop(), hdmi()], { mode: 'extend', position: 'left', primary: 'HDMI-1' });
check('left of the main external screen', eq(p.rects['eDP-1'], { x: 0, y: 0, width: 1920, height: 1080 }) && eq(p.rects['HDMI-1'], { x: 1920, y: 0, width: 2560, height: 1440 }) && p.primary === 'HDMI-1', JSON.stringify(p.rects));
check('--primary on the chosen screen only', p.args.indexOf('--primary') > p.args.indexOf('HDMI-1') && p.args.filter((a) => a === '--primary').length === 1);
p = L.planLayout([laptop(), hdmi()], { mode: 'extend', position: 'above' });
check('above: centred, shifted to 0,0', eq(p.rects['HDMI-1'], { x: 0, y: 0, width: 2560, height: 1440 }) && eq(p.rects['eDP-1'], { x: 320, y: 1440, width: 1920, height: 1080 }), JSON.stringify(p.rects));
p = L.planLayout([laptop(), hdmi()], { mode: 'extend', position: 'below' });
check('below', eq(p.rects['eDP-1'], { x: 0, y: 0, width: 1920, height: 1080 }) && eq(p.rects['HDMI-1'], { x: -320 + 320, y: 1080, width: 2560, height: 1440 }) === false || (p.rects['HDMI-1'].y === 1080 && p.rects['eDP-1'].x === 320 && p.rects['HDMI-1'].x === 0), JSON.stringify(p.rects));
p = L.planLayout([laptop(), hdmi()], { mode: 'extend', outputs: { 'HDMI-1': { width: 1920, height: 1080, rate: 50 }, 'eDP-1': { width: 1280, height: 720 } } });
check('per-screen modes kept', eq(p.modes['HDMI-1'], { width: 1920, height: 1080, rate: 50 }) && eq(p.modes['eDP-1'], { width: 1280, height: 720, rate: 60 }) && p.rects['HDMI-1'].x === 1280, JSON.stringify(p.modes));
check('unknown saved mode falls back to preferred', L.planLayout([laptop(), hdmi()], { outputs: { 'HDMI-1': { width: 9999, height: 9 } } }).modes['HDMI-1'].width === 2560);

// ---- mirror
p = L.planLayout([laptop(), hdmi()], { mode: 'mirror' });
check('mirror: largest common size, same place', eq(p.modes['eDP-1'], { width: 1920, height: 1080, rate: 60 }) && p.modes['HDMI-1'].width === 1920 && eq(p.rects['HDMI-1'], { x: 0, y: 0, width: 1920, height: 1080 }) && !p.args.includes('--scale-from'), p.args.join(' '));
const odd = { ...hdmi(), modes: [mode(2560, 1440, [59.95], true)] };
p = L.planLayout([laptop(), odd], { mode: 'mirror' });
check('mirror without a common size: --scale-from', p.args.join(' ').includes('--output HDMI-1 --mode 2560x1440 --pos 0x0 --scale-from 1920x1080'), p.args.join(' '));

// ---- one screen only
p = L.planLayout([laptop(), hdmi(true)], { mode: 'external' });
check('external only: laptop off first, external main', p.args.slice(0, 3).join(' ') === '--output eDP-1 --off' && p.primary === 'HDMI-1' && eq(p.rects['HDMI-1'], { x: 0, y: 0, width: 2560, height: 1440 }), p.args.join(' '));
p = L.planLayout([laptop(), hdmi(true)], { mode: 'internal' });
check('internal only', p.args.slice(0, 3).join(' ') === '--output HDMI-1 --off' && p.primary === 'eDP-1' && eq(p.active, ['eDP-1']));
check('external only without external screen = extend', L.planLayout([laptop()], { mode: 'external' }).mode === 'extend');
check('mirror with one screen = extend', L.planLayout([laptop()], { mode: 'mirror' }).mode === 'extend');
check('bad cfg values fall back', L.planLayout([laptop(), hdmi()], { mode: 'nope', position: 'diagonal', primary: 'X' }).mode === 'extend');
check('isInternal', L.isInternal('eDP-1') && L.isInternal('eDP-1-1') && L.isInternal('LVDS-1') && L.isInternal('DSI-1') && !L.isInternal('HDMI-1') && !L.isInternal('DP-0') && !L.isInternal('Virtual-1'));

// ---- simulate + currentLayout round trip
let sim = L.simulate([laptop(), hdmi()], L.planLayout([laptop(), hdmi()], { mode: 'extend', position: 'left', primary: 'HDMI-1' }).args);
check('simulate: positions + primary', sim.find((o) => o.name === 'HDMI-1').primary && sim.find((o) => o.name === 'HDMI-1').x === 1920 && !sim.find((o) => o.name === 'eDP-1').primary);
check('currentLayout: extend / left / primary', eq(L.currentLayout(sim), { mode: 'extend', primary: 'HDMI-1', position: 'left' }), JSON.stringify(L.currentLayout(sim)));
sim = L.simulate([laptop(), hdmi(true)], L.planLayout([laptop(), hdmi(true)], { mode: 'external' }).args);
check('currentLayout: external', L.currentLayout(sim).mode === 'external' && sim.find((o) => o.name === 'eDP-1').active === false);
sim = L.simulate([laptop(), hdmi()], L.planLayout([laptop(), hdmi()], { mode: 'mirror' }).args);
check('currentLayout: mirror', L.currentLayout(sim).mode === 'mirror');
check('currentLayout: one screen = extend', L.currentLayout([laptop()]).mode === 'extend');
sim = L.simulate([laptop(), hdmi()], L.planLayout([laptop(), hdmi()], { mode: 'extend', position: 'above' }).args);
check('currentLayout: above', L.currentLayout(sim).position === 'above');

// ---- set keys + EDID
const prop = `Screen 0: minimum 8 x 8, current 4480 x 1440, maximum 32767 x 32767
eDP-1 connected primary 1920x1080+0+0 (normal left inverted right x axis y axis) 344mm x 194mm
\tEDID:
\t\t00ffffffffffff0030e4d8020000000000
\t\t1a0104951f1178ea9d4fa25b5c09
\tscaling mode: Full aspect
   1920x1080     60.00*+  48.00
HDMI-1 connected 2560x1440+1920+0 (normal left inverted right x axis y axis) 597mm x 336mm
\tEDID:
\t\t00ffffffffffff001e6d5a7701010101
\tnon-desktop: 0
   2560x1440     59.95*+
DP-1 disconnected (normal left inverted right x axis y axis)
`;
const ed = L.parseEdids(prop);
check('parseEdids: both connected screens', Object.keys(ed).length === 2 && /^[0-9a-f]{8}$/.test(ed['eDP-1']) && ed['eDP-1'] !== ed['HDMI-1'], JSON.stringify(ed));
check('setKey: sorted, with EDID', L.setKey([hdmi(), laptop()], ed) === `HDMI-1:${ed['HDMI-1']}|eDP-1:${ed['eDP-1']}`);
check('setKey: names only without EDID', L.setKey([hdmi(), laptop()]) === 'HDMI-1|eDP-1');

// ---- monitor spec (dev / tests)
const spec = parseMonitorSpec('1920x1080+0+0,2560x1440+1920+0*');
check('parseMonitorSpec', spec.length === 2 && spec[1].primary && !spec[0].primary && spec[1].x === 1920);
check('parseMonitorSpec: first is main by default', parseMonitorSpec('800x600+0+0,800x600+800+0')[0].primary);
check('parseMonitorSpec: garbage ignored', parseMonitorSpec('x;rm -rf,12+3').length === 0);

// ---- renderer maths
const mons = [
  { id: 'a', x: 0, y: 0, width: 1920, height: 1080, primary: true },
  { id: 'b', x: 1920, y: 0, width: 2560, height: 1440, primary: false },
];
check('monitorAt inside', M.monitorAt(mons, 100, 100).id === 'a' && M.monitorAt(mons, 2000, 1300).id === 'b');
check('monitorAt in the gap below the smaller screen: nearest', M.monitorAt(mons, 1000, 1300).id === 'a' && M.monitorAt(mons, 1910, 1400).id === 'b');
check('monitorForRect: most of the area', M.monitorForRect(mons, { x: 1500, y: 100, width: 800, height: 600 }).id === 'a' && M.monitorForRect(mons, { x: 1800, y: 100, width: 800, height: 600 }).id === 'b');
check('monitorForRect: off every screen = nearest', M.monitorForRect(mons, { x: 9000, y: 100, width: 100, height: 100 }).id === 'b');
check('neighbour wraps', M.neighbour(mons, mons[0], 'right').id === 'b' && M.neighbour(mons, mons[0], 'left').id === 'b' && M.neighbour(mons, mons[1], 'right').id === 'a');
check('neighbour: one screen', M.neighbour([mons[0]], mons[0], 'right') === null);
const wa = M.workareaOf(mons[0], { top: 0, right: 0, bottom: 48, left: 0 }, true);
const wb = M.workareaOf(mons[1], { top: 0, right: 0, bottom: 48, left: 0 }, false);
check('workareaOf: bar only on the main screen', eq(wa, { x: 0, y: 0, width: 1920, height: 1032 }) && eq(wb, { x: 1920, y: 0, width: 2560, height: 1440 }));
let r = M.relocate({ x: 100, y: 100, width: 800, height: 600 }, wa, wb);
check('relocate: same relative place', r.x > 1920 && r.y > 0 && r.width === 800 && r.height === 600, JSON.stringify(r));
r = M.relocate({ x: 1920, y: 0, width: 2560, height: 1440 }, wb, wa);
check('relocate: shrinks to fit', eq(r, { x: 0, y: 0, width: 1920, height: 1032 }), JSON.stringify(r));
r = M.relocate({ x: 0, y: 0, width: 1920, height: 1032 }, wa, wb);
check('relocate: fills the bigger screen corner', r.x === 1920 && r.y === 0);

// ---- display.js staleOutputs: an unplugged screen X still keeps a picture for is switched off with the next layout
const { parsers } = require('../main/ipc/display.js');
const stale = parsers.staleOutputs(
  'Screen 0: minimum 8 x 8, current 4480 x 1440, maximum 32767 x 32767\n' +
    'eDP-1 connected primary 1920x1080+0+0 (normal left inverted right x axis y axis) 344mm x 194mm\n' +
    '   1920x1080     60.00*+\n' +
    'HDMI-1 disconnected 2560x1440+1920+0 (normal left inverted right x axis y axis) 0mm x 0mm\n' +
    'DP-1 disconnected (normal left inverted right x axis y axis)\n',
);
check('staleOutputs: disconnected output still holding a picture', eq(stale, ['HDMI-1']), JSON.stringify(stale));

console.log(`displays unit: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
