// « Clavier visuel » (on-screen keyboard): core/features/osk.js, osk/keyboard.js, osk/layouts.js, osk/greeter.js,
// main/ipc/osk.js (real key events), aurora-xwm 'osk-key' / 'osk-area' (XTest typing into X11 windows).
//
//   cd shell && PATH=…/xvfb/pkg/usr/bin:$PATH xvfb-run -a -s "-screen 0 1600x900x24" node test/osk.test.mjs
//
// Parts: 1. units (layouts, dead keys, event validation, the helper's keysym / keycode planning in python);
// 2. aurora-xwm under a private Xvfb with a python-xlib client (fr then us keymap, borrowed keycodes, Caps Lock, focus
// kept on the client when the "shell" takes it while the pointer is on the keyboard); 3. the desktop: shortcut and
// setting, typing into an input, a textarea, a contenteditable, the Terminal (xterm.js) and the Code Editor
// (CodeMirror) on AZERTY and QWERTY with Shift / AltGr / dead keys, sticky Ctrl (Ctrl+A, Ctrl+C, Ctrl+V), Super twice,
// focus never leaving the field, auto-show, the bar button, Paramètres round-trip, the lock screen; 4. the sign-in
// screen (password typed with the keyboard, then signed in). Screenshots: test/out/osk-*.png (en/fr, light/dark).
// python3-xlib: the system one, else $AURORA_PYXLIB or ~/.cache/selene-dev/pylib (PYTHONPATH); part 2 is skipped
// without it or without Xvfb.
import { launchShell, ROOT } from './lib.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const HELPER = path.join(ROOT, '..', 'rootfs', 'usr', 'lib', 'aurora', 'helpers', 'aurora-xwm');
const XKEYS = path.join(ROOT, 'test', 'fixtures', 'osk', 'xkeys.py');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'osk-test-'));
// --only=x11,desktop,greeter,x11desktop runs those parts (the units always run)
const ONLY = (process.argv.find((a) => a.startsWith('--only='))?.slice(7) || '').split(',').filter(Boolean);
const part = (name) => !ONLY.length || ONLY.includes(name);
// Electron on the X server (Xvfb), never on a Wayland session the environment points to (ELECTRON_OZONE_PLATFORM_HINT /
// WAYLAND_DISPLAY): the windows, the clipboard and the key events stay on the test display.
const X11 = ['--ozone-platform=x11'];

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) passed++;
  else failures.push(name);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail !== undefined ? ` -- ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, { timeout = 5000, every = 50 } = {}) {
  const end = Date.now() + timeout;
  let last;
  for (;;) {
    try {
      last = await fn();
      if (last) return last;
    } catch {}
    if (Date.now() > end) return last;
    await sleep(every);
  }
}
const have = (bin) => spawnSync('sh', ['-c', `command -v ${bin}`]).status === 0;

// ================================================================== part 1: units
console.log('--- units');
const L = await import('../renderer/core/features/osk/layouts.js');
{
  check('layoutFor: fr, fr(oss), ch(fr), ch:fr (greeter), us(intl), unknown -> us', L.layoutFor('fr') === 'fr' && L.layoutFor('fr(oss)') === 'fr-oss' && L.layoutFor('ch(fr)') === 'ch-fr' && L.layoutFor('ch:fr') === 'ch-fr' && L.layoutFor('us(intl)') === 'us' && L.layoutFor('ru') === 'us' && L.layoutFor('be') === 'fr' && L.layoutFor(null) === 'us');
  const fr = L.LAYOUTS.fr;
  const e2 = fr.r0[2];
  const st = (o) => ({ shift: false, caps: false, altgr: false, ...o });
  check('AZERTY digit row: é, Shift -> 2, Caps Lock -> É, Caps + Shift -> 2', L.output(e2, st()) === 'é' && L.output(e2, st({ shift: true })) === '2' && L.output(e2, st({ caps: true })) === 'É' && L.output(e2, st({ caps: true, shift: true })) === '2');
  check('AZERTY letters: a, Shift / Caps -> A, Caps + Shift -> a', L.output(fr.r1[0], st()) === 'a' && L.output(fr.r1[0], st({ shift: true })) === 'A' && L.output(fr.r1[0], st({ caps: true })) === 'A' && L.output(fr.r1[0], st({ caps: true, shift: true })) === 'a');
  check('AZERTY AltGr: e -> €, z -> «, x -> », o -> œ, à -> @, Shift+AltGr o -> Œ', L.output(fr.r1[2], st({ altgr: true })) === '€' && L.output(fr.r1[1], st({ altgr: true })) === '«' && L.output(fr.r3[2], st({ altgr: true })) === '»' && L.output(fr.r1[8], st({ altgr: true })) === 'œ' && L.output(fr.r0[10], st({ altgr: true })) === '@' && L.output(fr.r1[8], st({ altgr: true, shift: true })) === 'Œ');
  check('AZERTY dead keys: ^ and ¨ (Shift) on the key right of P', L.output(fr.r1[10], st()) === 'dead_circumflex' && L.output(fr.r1[10], st({ shift: true })) === 'dead_diaeresis');
  check('ù, ç, è, à on AZERTY; Caps Lock gives Ù Ç È À', ['ù', 'ç', 'è', 'à'].every((c) => [fr.r2[10], fr.r0[9], fr.r0[7], fr.r0[10]].some((k) => L.output(k, st()) === c)) && L.output(fr.r2[10], st({ caps: true })) === 'Ù' && L.output(fr.r0[9], st({ caps: true })) === 'Ç');
  check('compose: ^e ê, ^a â, ¨e ë, ¨i ï, `a à (grave), ´e é, ~n ñ, ^ + space -> ^, ^x -> null', L.compose('dead_circumflex', 'e') === 'ê' && L.compose('dead_circumflex', 'a') === 'â' && L.compose('dead_diaeresis', 'e') === 'ë' && L.compose('dead_diaeresis', 'i') === 'ï' && L.compose('dead_grave', 'a') === 'à' && L.compose('dead_acute', 'e') === 'é' && L.compose('dead_tilde', 'n') === 'ñ' && L.compose('dead_circumflex', ' ') === '^' && L.compose('dead_circumflex', 'x') === null && L.compose('dead_circumflex', 'E') === 'Ê');
  check('deadSpacing: ^ ¨ ` ~', L.deadSpacing('dead_circumflex') === '^' && L.deadSpacing('dead_diaeresis') === '¨' && L.deadSpacing('dead_grave') === '`' && L.deadSpacing('dead_tilde') === '~');
  const us = L.LAYOUTS.us;
  check('QWERTY US: q w e…, Shift+1 -> !, no AltGr', L.output(us.r1[0], st()) === 'q' && L.output(us.r0[1], st({ shift: true })) === '!' && us.noAltGr === true);
  const ch = L.LAYOUTS['ch-fr'];
  check('Swiss French: QWERTZ (z on the top row), é à è, Shift+è -> ü, AltGr+e -> €, ^ dead', L.output(ch.r1[5], st()) === 'z' && L.output(ch.r2[9], st()) === 'é' && L.output(ch.r2[10], st()) === 'à' && L.output(ch.r1[10], st({ shift: true })) === 'ü' && L.output(ch.r1[2], st({ altgr: true })) === '€' && L.output(ch.r0[12], st()) === 'dead_circumflex');
  const oss = L.LAYOUTS['fr-oss'];
  check('fr(oss): AltGr+r -> ê, AltGr+o -> œ, AltGr+w -> «', L.output(oss.r1[3], st({ altgr: true })) === 'ê' && L.output(oss.r1[8], st({ altgr: true })) === 'œ' && L.output(oss.r3[1], st({ altgr: true })) === '«');
  const sizes = Object.values(L.LAYOUTS).map((x) => [x.r0.length, x.r1.length, x.r2.length, x.r3.length].join('/'));
  check('every layout: 13 / 12 / 11 / 11 (10 on ANSI) keys', sizes.every((s) => /^13\/12\/11\/1[01]$/.test(s)), sizes);
  check('symbol pages: digits, @ # €, French accents and capitals', L.PAGES.sym.r0.map((k) => k[0]).join('').startsWith('1234567890') && L.PAGES.sym.r1.some((k) => k[0] === '€') && L.PAGES.acc.r2.some((k) => k[0] === 'É') && L.PAGES.acc.r1.some((k) => k[0] === 'œ'));

  const { cleanEvent } = require('../main/ipc/osk.js');
  const ce = cleanEvent;
  check('osk:input validation: named keys and one character pass, modifiers filtered', JSON.stringify(ce({ type: 'keyDown', keyCode: 'Backspace', modifiers: ['control', 'evil'] })) === JSON.stringify({ type: 'keyDown', keyCode: 'Backspace', modifiers: ['control'] }) && ce({ type: 'char', keyCode: 'é' })?.keyCode === 'é' && ce({ type: 'char', keyCode: '😀' })?.keyCode === '😀' && ce({ type: 'char', keyCode: '\r' })?.keyCode === '\r');
  check('osk:input validation: refuses other types, strings, control characters', !ce({ type: 'mouseDown', keyCode: 'a' }) && !ce({ type: 'keyDown', keyCode: 'rm -rf' }) && !ce({ type: 'keyDown', keyCode: '\u0003' }) && !ce({ type: 'keyDown', keyCode: '\r' }) && !ce(null) && !ce({ type: 'char', keyCode: 42 }));
}

// python3-xlib for the helper (unit + part 2)
function pyEnv() {
  const ok = (extra) => spawnSync('python3', ['-c', 'import Xlib.ext.xtest'], { env: { ...process.env, ...extra } }).status === 0;
  if (ok({})) return {};
  for (const dir of [process.env.AURORA_PYXLIB, path.join(os.homedir(), '.cache', 'selene-dev', 'pylib')].filter(Boolean)) if (ok({ PYTHONPATH: dir })) return { PYTHONPATH: dir };
  return null;
}
const PYENV = pyEnv();
const UNIT_PY = `
import importlib.machinery, importlib.util, json, sys
l = importlib.machinery.SourceFileLoader('xwm', sys.argv[1])
spec = importlib.util.spec_from_loader('xwm', l); m = importlib.util.module_from_spec(spec); l.exec_module(m)
out = {}
k = m.keysym_for_char
out['ks'] = [k('a'), k('é'), k('€'), k('œ'), k('Œ'), k('ê'), k('😀'), k('\\x01'), k('ab')]
out['chars'] = [m.char_of_keysym(x) for x in (0x61, 0xe9, 0x20ac, 0x13bd, 0x101f600, 0xff0d)]
# a French keymap (core columns): é on 11 col 0, 2 on 11 col 1, € on 26 col 4, a/A on 24, ê nowhere
fr = {0xe9: [(11, 0)], 0x32: [(11, 1)], 0x20ac: [(26, 4)], 0x61: [(24, 0)], 0x41: [(24, 1)], 0xea: [], 0x40: [(19, 4), (49, 2)]}
mods = {'Shift_L': 50, 'ISO_Level3_Shift': 92, 'Mode_switch': 0}
mk = lambda n: mods.get(n, 0)
p = lambda ks, **kw: m.plan_key(fr.get(ks, []), mk, **kw)
out['plan'] = [p(0xe9), p(0x32), p(0x20ac), p(0x61), p(0x41), p(0xea), p(0x40)]
alpha = lambda kc: kc == 24
out['caps'] = [p(0x61, lock=True, alphabetic=alpha), p(0x41, lock=True, alphabetic=alpha), p(0xe9, lock=True, alphabetic=alpha)]
out['nolevel3'] = m.plan_key([(26, 4)], lambda n: 50 if n == 'Shift_L' else 0)
print(json.dumps(out))
`;
if (!PYENV) console.log('SKIP helper units: python3-xlib not found');
else {
  const r = spawnSync('python3', ['-c', UNIT_PY, HELPER], { env: { ...process.env, ...PYENV }, encoding: 'utf8' });
  let u = null;
  try {
    u = JSON.parse(r.stdout);
  } catch {}
  check('helper loads as a module (python)', !!u, r.stderr.slice(-400));
  if (u) {
    check('keysym_for_char: Latin-1, legacy € œ Œ, Unicode ê 😀, None for controls / strings', JSON.stringify(u.ks) === JSON.stringify([0x61, 0xe9, 0x20ac, 0x13bd, 0x13bc, 0xea, 0x101f600, null, null]), u.ks);
    check('char_of_keysym is the reverse (Return has none)', JSON.stringify(u.chars) === JSON.stringify(['a', 'é', '€', 'œ', '😀', null]), u.chars);
    check('plan_key: é plain, 2 with Shift, € with AltGr (ISO_Level3_Shift), A with Shift, ê not on the keymap', JSON.stringify(u.plan.slice(0, 6)) === JSON.stringify([[11, []], [11, [50]], [26, [92]], [24, []], [24, [50]], null]), u.plan);
    check('plan_key: the AltGr column beats a Mode_switch column that has no modifier key', JSON.stringify(u.plan[6]) === JSON.stringify([19, [92]]), u.plan[6]);
    check('plan_key with Caps Lock: a needs Shift, A needs nothing, é (not a letter key) unchanged', JSON.stringify(u.caps) === JSON.stringify([[24, [50]], [24, []], [11, []]]), u.caps);
    check('plan_key: no ISO_Level3_Shift on the keymap -> cannot use the AltGr column', u.nolevel3 === null, u.nolevel3);
  }
}

// ================================================================== part 2: aurora-xwm + XTest under a private Xvfb
async function xpart() {
  if (!PYENV) return console.log('SKIP X11 part: python3-xlib not found');
  if (!have('Xvfb') || !have('setxkbmap')) return console.log('SKIP X11 part: Xvfb / setxkbmap missing');
  let n = 140 + Math.floor(Math.random() * 50);
  while (fs.existsSync(`/tmp/.X11-unix/X${n}`) || fs.existsSync(`/tmp/.X${n}-lock`)) n++;
  const DISPLAY = `:${n}`;
  const procs = [];
  const env = { ...process.env, ...PYENV, DISPLAY };
  const xvfb = spawn('Xvfb', [DISPLAY, '-screen', '0', '1280x800x24', '-nolisten', 'tcp', '-noreset'], { stdio: 'ignore' });
  procs.push(xvfb);
  try {
    if (!(await until(() => fs.existsSync(`/tmp/.X11-unix/X${n}`), { timeout: 8000 }))) return check('private Xvfb started', false);
    await sleep(300);
    const kb = (layout) => spawnSync('setxkbmap', ['-display', DISPLAY, layout], { env, encoding: 'utf8' });
    const r0 = kb('fr');
    check('private Xvfb with the French keymap (setxkbmap fr)', r0.status === 0, r0.stderr);
    // line-reading children
    const start = (args) => {
      const p = spawn('python3', args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
      procs.push(p);
      const lines = [];
      let buf = '';
      let err = '';
      p.stdout.setEncoding('utf8');
      p.stdout.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          lines.push(buf.slice(0, i));
          buf = buf.slice(i + 1);
        }
      });
      p.stderr.on('data', (d) => (err += d));
      p.stdin.on('error', () => {});
      return {
        p,
        lines,
        get err() {
          return err;
        },
        write: (s) => p.stdin.write(`${s}\n`),
        wait: (pred, ms = 4000, from = 0) => until(() => lines.slice(from).find(pred), { timeout: ms, every: 20 }),
      };
    };
    const shell = start([XKEYS, 'shell']);
    const sid = Number((await shell.wait((l) => l.startsWith('xid ')))?.split(' ')[1]);
    const xwm = start([HELPER, '--shell-xid', String(sid)]);
    const ev = (name, pred = () => true, from = 0, ms = 4000) => xwm.wait((l) => l.includes(`"ev":"${name}"`) && pred(JSON.parse(l)), ms, from).then((l) => (l ? JSON.parse(l) : null));
    check('helper ready on the private display', !!(await ev('ready')), xwm.err.slice(-300));
    const cl = start([XKEYS, 'client']);
    const cid = Number((await cl.wait((l) => l.startsWith('xid ')))?.split(' ')[1]);
    check('client managed', !!(await ev('new', (e) => e.id === cid)));
    const cmd = (o) => xwm.p.stdin.write(`${JSON.stringify(o)}\n`);
    cmd({ cmd: 'focus', id: cid });
    check('client focused', !!(await ev('focus', (e) => e.id === cid)));
    const MODKEYS = new Set(['Shift_L', 'Shift_R', 'ISO_Level3_Shift', 'Control_L', 'Alt_L', 'Super_L', 'Caps_Lock', 'Mode_switch']);
    // the keys the client received (the modifier keys pressed around them are left out)
    const keysFrom = (from, mods = false) => cl.lines.slice(from).filter((l) => l.startsWith('{"ev": "key"')).map((l) => JSON.parse(l)).filter((e) => mods || !MODKEYS.has(e.name));
    async function typed(list, count, mods = false) {
      const from = cl.lines.length;
      for (const o of list) cmd({ cmd: 'osk-key', id: cid, ...o });
      await until(() => keysFrom(from, mods).length >= count, { timeout: 4000 });
      await sleep(80);
      return keysFrom(from, mods);
    }
    let k = await typed([{ char: 'é' }, { char: '2' }, { char: 'A' }, { char: '€' }, { char: '@' }], 5);
    check('fr keymap: é (plain), 2 (Shift), A (Shift), € and @ (AltGr) reach the client', k.map((x) => x.char).join('') === 'é2A€@', k);
    check('…with the right modifiers (Shift for 2 / A, Mod5 for € / @)', !(k[0].state & 1) && k[1].state & 1 && k[2].state & 1 && k[3].state & 0x80 && k[4].state & 0x80, k.map((x) => x.state));
    k = await typed([{ char: 'ê' }, { char: 'œ' }, { char: 'ë' }, { char: '😀' }], 4);
    check('characters the fr keymap lacks (ê œ ë 😀) are typed through borrowed spare keycodes', k.map((x) => x.char).join('') === 'êœë😀', k);
    k = await typed([{ name: 'Return' }, { name: 'BackSpace' }, { name: 'Tab', mods: ['shift'] }, { char: 'c', mods: ['ctrl'] }], 4);
    check('keys by name (Return, BackSpace, Shift+Tab -> ISO_Left_Tab) and Ctrl+c', k[0]?.name === 'Return' && k[1]?.name === 'BackSpace' && k[2]?.name === 'ISO_Left_Tab' && k[3]?.char === 'c' && k[3].state & 4, k.map((x) => [x.name, x.state]));
    // Caps Lock on: a letter still comes out as asked
    cl.write('keys Caps_Lock');
    await cl.wait((l) => l === 'ok');
    k = await typed([{ char: 'a' }, { char: 'B' }, { char: 'é' }], 3);
    check('Caps Lock on the server: a, B, é come out as a, B, é', k.map((x) => x.char).join('') === 'aBé', k.map((x) => [x.char, x.state]));
    cl.write('keys Caps_Lock');
    await cl.wait((l) => l === 'ok', 4000, cl.lines.length - 1);
    // locked modifier: press, a key, release
    k = await typed([{ name: 'Alt_L', action: 'press' }, { char: 'x' }, { name: 'Alt_L', action: 'release' }], 2, true);
    check('a locked Alt stays down across keys (press / release)', k[0]?.name === 'Alt_L' && k[1]?.char === 'x' && k[1].state & 8, k.map((x) => [x.name, x.state]));
    // US keymap: € and é are borrowed
    const r1 = kb('us');
    await sleep(300);
    k = await typed([{ char: 'é' }, { char: '€' }, { char: 'q' }, { char: '!' }], 4);
    check('us keymap: é € (borrowed), q, ! (Shift)', r1.status === 0 && k.map((x) => x.char).join('') === 'é€q!', k);
    // focus: the "shell" (Chromium) takes the X focus while the pointer is on the keyboard: the client keeps it
    const getFocus = async () => {
      const from = shell.lines.length;
      shell.write('getfocus');
      const l = await shell.wait((x) => x.startsWith('focus '), 3000, from);
      return Number(l?.split(' ')[1]);
    };
    const sendShell = async (c) => {
      const from = shell.lines.length;
      shell.write(c);
      await shell.wait((l) => l === 'ok', 3000, from);
      await sleep(250);
    };
    cmd({ cmd: 'osk-area', rects: [{ x: 0, y: 480, width: 1280, height: 320 }] });
    await sendShell('pointer 600 700');
    const evFrom = xwm.lines.length;
    await sendShell('takefocus');
    check('a click on the keyboard (XSetInputFocus by the shell): the client keeps the X focus', (await getFocus()) === cid, await getFocus());
    await sendShell('activate');
    check('…and _NET_ACTIVE_WINDOW from the shell is ignored there', (await getFocus()) === cid);
    check('…and the shell is never told the client lost the focus', !xwm.lines.slice(evFrom).some((l) => /"ev":"focus","id":null/.test(l)), xwm.lines.slice(evFrom));
    k = await typed([{ char: 'z' }], 1);
    check('typing still reaches the client afterwards', k[0]?.char === 'z');
    await sendShell('pointer 600 100');
    await sendShell('activate');
    check('outside the keyboard area the shell takes the focus as before', (await until(async () => (await getFocus()) === sid, { timeout: 2000 })) === true || (await getFocus()) === sid);
    // typing into the client again moves the X focus back to it first
    k = await typed([{ char: 'y' }], 1);
    check('osk-key gives the client the X focus first (the shell had it)', k[0]?.char === 'y' && (await getFocus()) === cid);
    cmd({ cmd: 'osk-area', rects: [] });
    await sendShell('pointer 600 700');
    await sendShell('takefocus');
    check('with no keyboard area, a click in the shell takes the focus (unchanged behaviour)', (await getFocus()) === sid);
    // borrowed keycodes are given back once idle
    await sleep(3500);
    const spare = spawnSync('python3', ['-c', 'from Xlib import display; d = display.Display(); lo, hi = d.display.info.min_keycode, d.display.info.max_keycode; m = d.get_keyboard_mapping(lo, hi - lo + 1); print(sum(1 for s in m if any(x in (0xea, 0x153, 0x1001f600, 0x20ac, 0xe9, 0xeb, 0x13bd) for x in s)))'], { env, encoding: 'utf8' });
    check('borrowed keycodes are given back after a few idle seconds', spare.stdout.trim() === '0', spare.stdout + spare.stderr);
  } finally {
    for (const p of procs.reverse()) {
      try {
        p.kill('SIGTERM');
      } catch {}
    }
  }
}
console.log('--- X11 (aurora-xwm)');
if (part('x11')) await xpart().catch((err) => check('X11 part ran without exceptions', false, err?.stack || String(err)));

// ================================================================== part 3: the desktop
console.log('--- desktop');
if (part('desktop')) await desktop();
async function desktop() {
const s = await launchShell({ lang: 'fr', theme: 'dark', args: X11, settings: { keyboardLayout: 'fr', sounds: false } });
const { page } = s;
const A = (fn, arg) => s.aurora(fn, arg);
const visible = () => A(() => !!window.__aurora.osk?.visible());
const enabled = () => A(() => window.__aurora.settings.get('osk')?.enabled === true);
async function center(id) {
  return page.evaluate((id) => {
    const el = document.querySelector(`.osk [data-k="${id}"]`);
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  }, id);
}
async function tap(id) {
  const c = await center(id);
  if (!c) throw new Error(`no key ${id}`);
  await page.mouse.click(c.x, c.y);
  await sleep(35);
}
/** Tap the key that types ch in the current state. */
async function tapOut(ch) {
  const id = await A((ch) => window.__aurora.osk.keyboard.keyFor(ch), ch);
  if (!id) throw new Error(`no key types ${ch}`);
  await tap(id);
}
async function tapText(text) {
  for (const ch of text) {
    if (ch === ' ') await tap('Space');
    else await tapOut(ch);
  }
}
/** Type text from a neutral state: Shift / AltGr / dead keys as needed (kb.plan). */
async function typeText(text) {
  for (const ch of text) {
    const ids = await A((ch) => window.__aurora.osk.keyboard.plan(ch), ch);
    if (!ids) throw new Error(`cannot type ${ch}`);
    for (const id of ids) await tap(id);
  }
}
async function value(sel) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return el ? (el.isContentEditable ? el.innerText : el.value) : null;
  }, sel);
}
const waitValue = (sel, want, timeout = 3000) => until(async () => (await value(sel)) === want, { timeout }).then(() => value(sel));

try {
  // ---- open / close: shortcut, setting
  check('hidden by default', !(await visible()));
  await A(() => window.__aurora.hotkeys.trigger('Super+Ctrl+O'));
  check('Super+Ctrl+O shows it and turns the setting on', (await until(visible)) && (await enabled()));
  const barInset = await A(() => window.__aurora.wm.baseInsets().bottom);
  check('in the shortcut catalog (onScreenKeyboard = Super+Ctrl+O)', (await A(() => window.__aurora.hotkeys.combos().onScreenKeyboard)) === 'Super+Ctrl+O');
  await A(() => window.__aurora.hotkeys.trigger('Super+Ctrl+O'));
  check('Super+Ctrl+O again hides it and turns it off', !!(await until(async () => !(await visible()))) && !(await enabled()));
  check('hidden: the work area is the bar\'s again', (await A(() => window.__aurora.wm.insets.bottom)) === barInset, [await A(() => window.__aurora.wm.insets.bottom), barInset]);
  await A(() => window.__aurora.settings.set('osk.enabled', true));
  check('the setting shows it', await until(visible));
  await sleep(400); // the slide-in
  const geo = await A(() => {
    const r = window.__aurora.osk.keyboard.el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, w: innerWidth, h: innerHeight, inset: window.__aurora.wm.baseInsets().bottom, layout: window.__aurora.osk.layout(), parent: window.__aurora.osk.keyboard.el.parentElement.id };
  });
  check('docked: centred above the bar, inside the screen, in #overlays', geo.bottom <= geo.h - geo.inset + 1 && geo.bottom > geo.h - geo.inset - 20 && Math.abs(geo.left + geo.right - geo.w) < 4 && geo.parent === 'overlays', geo);
  check('layout follows the keyboard setting (fr -> AZERTY)', geo.layout === 'fr');
  const wa = await A(() => {
    const k = window.__aurora.osk.keyboard.el.getBoundingClientRect();
    const a = window.__aurora.wm.workarea();
    return { waBottom: a.y + a.height, kbTop: k.top, base: window.__aurora.wm.baseInsets().bottom };
  });
  check('docked: the work area ends above it (maximized windows and dialogs stay visible)', wa.waBottom <= wa.kbTop + 1 && wa.waBottom > wa.kbTop - 20, wa);
  check('keys labelled: é on the digit row, ^ dead key, AltGr hint € on e', await page.evaluate(() => !!document.querySelector('.osk [data-k="r0-2"]')?.textContent.startsWith('é') && document.querySelector('.osk [data-k="r1-10"]')?.classList.contains('osk-dead') && document.querySelector('.osk [data-k="r1-2"] .k-alt')?.textContent === '€'));

  // ---- a test window: input, textarea, contenteditable
  await A(() => {
    const w = window.__aurora.wm.create({ appId: 'notepad', title: 'Saisie', width: 560, height: 360, x: 60, y: 40 });
    w.body.style.cssText = 'display:flex;flex-direction:column;gap:8px;padding:12px';
    const inp = Object.assign(document.createElement('input'), { id: 'osk-in', className: 'input' });
    const ta = Object.assign(document.createElement('textarea'), { id: 'osk-ta', rows: 3 });
    const ce = Object.assign(document.createElement('div'), { id: 'osk-ce', contentEditable: 'true' });
    ce.style.cssText = 'min-height:40px;border:1px solid var(--line);padding:4px';
    w.body.append(inp, ta, ce);
    window.__oskBlurs = 0;
    for (const el of [inp, ta, ce]) el.addEventListener('blur', () => window.__oskBlurs++);
    inp.focus();
  });
  await tapText('ça va');
  check('input: « ça va » typed (AZERTY ç, Space)', (await waitValue('#osk-in', 'ça va')) === 'ça va', await value('#osk-in'));
  check('the field kept the focus through every key press', (await page.evaluate(() => [document.activeElement.id, window.__oskBlurs])).join() === 'osk-in,0', await page.evaluate(() => [document.activeElement.id, window.__oskBlurs]));
  // Shift (once), AltGr, dead keys, Caps Lock
  await tap('Shift');
  check('Shift: keys show capitals and the digits of the AZERTY row', await page.evaluate(() => document.querySelector('.osk [data-k="r1-0"]').dataset.out === 'A' && document.querySelector('.osk [data-k="r0-2"]').dataset.out === '2'));
  await tapOut('2');
  check('Shift is released after one key (once)', await page.evaluate(() => document.querySelector('.osk [data-k="r1-0"]').dataset.out === 'a' && document.querySelector('.osk [data-k="Shift"]').getAttribute('aria-pressed') === 'false'));
  await tap('AltGr');
  await tapOut('€');
  await tap('r1-10'); // dead circumflex (shown as ^)
  check('a waiting dead key shows the composed letters (ê on e)', await page.evaluate(() => document.querySelector('.osk [data-k="r1-2"] .k-main').textContent === 'ê'));
  await tapOut('e');
  await tap('Shift');
  await tap('r1-10'); // Shift: dead diaeresis
  await tapOut('e');
  await tap('r1-10');
  await tap('Space');
  await tap('Caps');
  await tapOut('É');
  await tap('Caps');
  check('input: Shift+é -> 2, AltGr+e -> €, ^e -> ê, ¨e -> ë, ^ + Espace -> ^, Verr. maj + é -> É', (await waitValue('#osk-in', 'ça va2€êë^É')) === 'ça va2€êë^É', await value('#osk-in'));
  // Shift locked (twice) types several capitals
  await tap('Shift');
  await tap('Shift');
  await tapText('AB');
  await tap('Shift');
  check('Shift twice locks it (AB), a third tap unlocks', (await waitValue('#osk-in', 'ça va2€êë^ÉAB')) === 'ça va2€êë^ÉAB' && (await page.evaluate(() => document.querySelector('.osk [data-k="r1-0"]').dataset.out)) === 'a');
  // Backspace, arrows, Home, End
  await tap('Backspace');
  await tap('Home');
  await tapOut('x');
  await tap('End');
  await tap('ArrowLeft');
  await tapOut('y');
  check('Backspace, Origine, Fin, ← move and delete like keys', (await waitValue('#osk-in', 'xça va2€êë^ÉyA')) === 'xça va2€êë^ÉyA', await value('#osk-in'));
  // key repeat: hold Backspace
  {
    const c = await center('Backspace');
    const before = (await value('#osk-in')).length;
    await page.evaluate(() => {
      window.__oskEv = [];
      for (const t of ['pointerdown', 'pointerup', 'pointercancel', 'lostpointercapture']) window.addEventListener(t, (e) => window.__oskEv.push(`${t}:${Math.round(performance.now())}`), true);
    });
    await page.mouse.move(c.x, c.y);
    await page.mouse.down();
    await sleep(900);
    await page.mouse.up();
    await sleep(150);
    const after = (await value('#osk-in')).length;
    check('holding a key repeats it (Backspace held ~0.9 s deletes several characters)', before - after >= 4, { before, after, ev: await page.evaluate(() => window.__oskEv) });
    check('…and the focus is still in the field', await page.evaluate(() => document.activeElement.id === 'osk-in'));
  }
  // sticky Ctrl: Ctrl+A, Ctrl+C in the textarea, Ctrl+V in the input
  await page.evaluate(() => {
    document.getElementById('osk-ta').focus();
    window.__oskBlurs = 0; // (programmatic focus moves are not the keyboard's)
  });
  await tapText('ligne');
  await tap('Enter');
  await tapText('deux');
  check('textarea: Entrée makes a new line', (await waitValue('#osk-ta', 'ligne\ndeux')) === 'ligne\ndeux', await value('#osk-ta'));
  await tap('Ctrl');
  check('Ctrl is latched (tinted, aria-pressed)', await page.evaluate(() => document.querySelector('.osk [data-k="Ctrl"]').classList.contains('osk-on')));
  await tapOut('a');
  check('Ctrl+A selects all of the textarea', await until(() => page.evaluate(() => { const t = document.getElementById('osk-ta'); return t.selectionStart === 0 && t.selectionEnd === t.value.length; })));
  check('Ctrl is released after one key', await page.evaluate(() => !document.querySelector('.osk [data-k="Ctrl"]').classList.contains('osk-on')));
  await A(() => window.__aurora.api.invoke('clipboard:writeText', ''));
  await tap('Ctrl');
  await tapOut('c');
  check('Ctrl+C copies the selection', (await until(() => A(() => window.__aurora.api.invoke('clipboard:readText')).then((t) => t === 'ligne\ndeux'))) === true);
  await page.evaluate(() => {
    const i = document.getElementById('osk-in');
    i.value = '';
    i.focus();
    window.__oskBlurs = 0;
  });
  await tap('Ctrl');
  await tapOut('v');
  check('Ctrl+V pastes in the input (the line break becomes a space in a one-line field)', (await waitValue('#osk-in', 'ligne deux')) === 'ligne deux', await value('#osk-in'));
  // contenteditable
  await page.evaluate(() => {
    document.getElementById('osk-ce').focus();
    window.__oskBlurs = 0;
  });
  await typeText('Noël à œ');
  check('contenteditable: « Noël à œ » (ë composed, AltGr+o -> œ)', (await until(async () => (await value('#osk-ce'))?.replace(/ /g, ' ') === 'Noël à œ')) === true, await value('#osk-ce'));
  check('no field lost the focus because of a key press (textarea, input, contenteditable)', (await page.evaluate(() => window.__oskBlurs)) === 0, await page.evaluate(() => window.__oskBlurs));
  // a <webview> (Navigateur tab, Courrier): the keys go to the guest page
  {
    await page.evaluate(() => {
      const w = window.__aurora.wm.create({ appId: 'browser', title: 'Web', width: 420, height: 200, x: 700, y: 40 });
      const wv = document.createElement('webview');
      wv.id = 'osk-wv';
      wv.setAttribute('partition', 'browser-osk-test');
      wv.setAttribute('src', 'data:text/html;charset=utf-8,' + encodeURIComponent('<input id="q" style="width:90%">'));
      wv.style.cssText = 'width:100%;height:100%';
      w.body.append(wv);
    });
    const wvReady = await until(() => page.evaluate(() => {
      const wv = document.getElementById('osk-wv');
      try {
        return wv.getWebContentsId() > 0 && !wv.isLoading();
      } catch {
        return false;
      }
    }), { timeout: 8000 });
    await page.evaluate(() => {
      const wv = document.getElementById('osk-wv');
      wv.focus();
      return wv.executeJavaScript('document.getElementById("q").focus(); 1');
    });
    await sleep(200);
    check('webview: the keyboard targets the focused <webview> guest', !!wvReady && (await A(() => window.__aurora.osk.target().webview > 0)), await A(() => window.__aurora.osk.target()));
    await typeText('Où ?');
    const wvVal = () => page.evaluate(() => document.getElementById('osk-wv').executeJavaScript('document.getElementById("q").value'));
    check('webview (Navigateur): « Où ? » typed into the page', (await until(async () => (await wvVal()) === 'Où ?', { timeout: 3000 })) === true, await wvVal());
    await page.evaluate(() => window.__aurora.wm.list().find((x) => x.body.querySelector('#osk-wv'))?.close());
    await page.evaluate(() => {
      document.getElementById('osk-ce').focus();
      window.__oskBlurs = 0;
    });
  }
  // symbols page
  await tap('Page');
  check('&123 page: digits and symbols', await page.evaluate(() => document.querySelector('.osk [data-k="r0-0"]').dataset.out === '1' && [...document.querySelectorAll('.osk .osk-char')].some((k) => k.dataset.out === '@')));
  await tapText('42@');
  await tap('Page');
  check('àéç page: French accented capitals', await page.evaluate(() => [...document.querySelectorAll('.osk .osk-char')].some((k) => k.dataset.out === 'É')));
  await tapOut('À');
  await tap('Page');
  check('ABC: back to the letters', await page.evaluate(() => document.querySelector('.osk [data-k="r1-0"]').dataset.out === 'a'));
  check('contenteditable: 42@À from the symbol pages', (await until(async () => (await value('#osk-ce'))?.endsWith('42@À'))) === true, await value('#osk-ce'));
  await s.shot('osk-desktop-fr-dark');

  // ---- Terminal (xterm.js)
  await A(() => window.__aurora.shell.launch('terminal'));
  const termReady = await until(() => page.evaluate(() => {
    const el = [...document.querySelectorAll('.win.app-terminal')].pop();
    const ses = el?.__terminal?.session;
    return ses?.state === 'running' && ses.term.buffer.active.length > 0;
  }), { timeout: 15000 });
  check('Terminal running', !!termReady);
  await sleep(1200);
  const termBuf = () => page.evaluate(() => {
    const ses = [...document.querySelectorAll('.win.app-terminal')].pop()?.__terminal?.session;
    const b = ses?.term.buffer.active;
    const out = [];
    for (let y = 0; b && y < b.length; y++) out.push(b.getLine(y).translateToString(true));
    return out.join('\n');
  });
  await page.evaluate(() => [...document.querySelectorAll('.win.app-terminal')].pop().__terminal.session.focus());
  await sleep(100);
  await tapText('echo ');
  await tapOut('é');
  await tap('AltGr');
  await tapOut('€');
  await tap('r1-10');
  await tapOut('e');
  await tap('Shift');
  await tapOut('A');
  await tap('Enter');
  check('Terminal (xterm.js): « echo é€êA » + Entrée prints é€êA', !!(await until(async () => /^é€êA\s*$/m.test(await termBuf()), { timeout: 5000 })), (await termBuf()).slice(-300));
  check('the terminal kept the focus (its helper textarea)', await page.evaluate(() => document.activeElement?.classList.contains('xterm-helper-textarea')));
  // Ctrl+C in the terminal interrupts (sticky Ctrl)
  await typeText('sleep 30');
  await tap('Enter');
  await sleep(400);
  await tap('Ctrl');
  await tapOut('c');
  await sleep(300);
  await tapText('echo fini');
  await tap('Enter');
  check('Terminal: Ctrl+C (sticky) interrupts sleep 30', !!(await until(async () => /^fini\s*$/m.test(await termBuf()), { timeout: 6000 })), (await termBuf()).slice(-300));

  // ---- Code Editor (CodeMirror)
  const file = path.join(s.home, 'Documents', 'essai.txt');
  fs.writeFileSync(file, 'début\n');
  await A((f) => window.__aurora.shell.launch('code', { file: f }), file);
  const cmReady = await until(() => page.evaluate(() => {
    const a = document.querySelector('.win.app-code')?.__code;
    return !!(a?.view && a.active?.name === 'essai.txt');
  }), { timeout: 15000 });
  check('Code Editor open on essai.txt', !!cmReady);
  await page.evaluate(() => {
    const a = document.querySelector('.win.app-code').__code;
    a.view.dispatch({ selection: { anchor: a.view.state.doc.length } });
    a.view.focus();
  });
  await sleep(150);
  await tapText('f');
  await tap('r1-10');
  await tapText('ete ');
  await tap('AltGr');
  await tapOut('€');
  await tap('Enter');
  await tapText('ok');
  const doc = () => page.evaluate(() => document.querySelector('.win.app-code').__code.view.state.doc.toString());
  // « fête »: f, ^ (dead) + e, t, e
  check('Code Editor (CodeMirror): typed « fête € » + Entrée + ok', !!(await until(async () => (await doc()).startsWith('début\nfête €\nok') || (await doc()).includes('fête €\nok'), { timeout: 4000 })), await doc());
  check('CodeMirror kept the focus', await page.evaluate(() => !!document.activeElement?.closest('.cm-editor')));
  await tap('Ctrl');
  await tapOut('a');
  check('Code Editor: Ctrl+A selects the whole document', !!(await until(() => page.evaluate(() => { const v = document.querySelector('.win.app-code').__code.view; return v.state.selection.main.from === 0 && v.state.selection.main.to === v.state.doc.length; }))));
  await tap('ArrowRight');

  // ---- Notes (contenteditable): Ctrl+N with the sticky Ctrl, a title, Entrée, the body
  await A(() => window.__aurora.shell.launch('notes'));
  const notesOk = await until(() => page.evaluate(() => !!document.querySelector('.win.app-notes')?.__notes?.editor), { timeout: 10000 });
  check('Notes open', !!notesOk);
  await sleep(600);
  await page.evaluate(() => document.querySelector('.win.app-notes .nt-body')?.focus());
  await tap('Ctrl');
  await tapOut('n');
  const titleFocused = await until(() => page.evaluate(() => document.activeElement === document.querySelector('.win.app-notes').__notes.editor.title && !document.activeElement.value), { timeout: 4000 });
  check('Notes: Ctrl+N (sticky Ctrl) makes a note and focuses its title', !!titleFocused);
  await typeText('Courses');
  await tap('Enter');
  await until(() => page.evaluate(() => document.activeElement === document.querySelector('.win.app-notes .nt-body')), { timeout: 3000 });
  await typeText('Pâtes, crème brûlée');
  const noteText = () => page.evaluate(() => [document.querySelector('.win.app-notes').__notes.editor.title.value, document.querySelector('.win.app-notes .nt-body').innerText.trim()]);
  check('Notes (contenteditable): title « Courses », body « Pâtes, crème brûlée »', (await until(async () => JSON.stringify(await noteText()) === JSON.stringify(['Courses', 'Pâtes, crème brûlée']), { timeout: 4000 })) === true, await noteText());

  // ---- QWERTY
  await A(() => window.__aurora.settings.set('osk.layout', 'us'));
  await until(() => A(() => window.__aurora.osk.keyboard.layoutId === 'us'));
  check('layout chosen in the settings: QWERTY US (q on the top row, no AltGr)', await page.evaluate(() => document.querySelector('.osk [data-k="r1-0"]').dataset.out === 'q' && !document.querySelector('.osk [data-k="AltGr"]') && !!document.querySelector('.osk [data-k="CtrlR"]')));
  await page.evaluate(() => {
    const i = document.getElementById('osk-in');
    i.value = '';
    const w = window.__aurora.wm.list().find((x) => x.body.contains(i));
    w.focus();
    i.focus();
  });
  await tap('Shift');
  await tapOut('H');
  await tapText('i');
  await tap('Shift');
  await tapOut('!');
  await typeText(' @2');
  check('QWERTY: Shift+h, i, Shift+1, @ -> « Hi! @2 »', (await waitValue('#osk-in', 'Hi! @2')) === 'Hi! @2', await value('#osk-in'));
  await s.shot('osk-qwerty-fr-dark');
  await A(() => window.__aurora.settings.set('osk.layout', 'ch-fr'));
  await until(() => A(() => window.__aurora.osk.keyboard.layoutId === 'ch-fr'));
  await page.evaluate(() => (document.getElementById('osk-in').value = ''));
  await tapText('zèé');
  await tap('Shift');
  await tapOut('ü');
  check('Swiss French: z è é, Shift+è -> ü', (await waitValue('#osk-in', 'zèéü')) === 'zèéü', await value('#osk-in'));
  await A(() => window.__aurora.settings.set('osk.layout', 'auto'));
  await until(() => A(() => window.__aurora.osk.keyboard.layoutId === 'fr'));

  // ---- Super twice opens the Lanceur; Super+Ctrl+O typed on the keyboard itself closes it
  await tap('Super');
  await tap('Super');
  check('Super twice opens the Lanceur', !!(await until(() => page.evaluate(() => document.getElementById('start')?.classList.contains('open')))));
  await until(() => page.evaluate(() => document.activeElement?.classList.contains('start-search')), { timeout: 2000 });
  await tapText('calc');
  check('…and typing goes to the Lanceur search (it stays open)', !!(await until(() => page.evaluate(() => document.getElementById('start')?.classList.contains('open') && /calc/.test(document.querySelector('#start input')?.value || '')))), await page.evaluate(() => document.querySelector('#start input')?.value));
  await tap('Escape');
  await until(() => page.evaluate(() => !document.getElementById('start')?.classList.contains('open')));
  await tap('Super');
  await tap('Ctrl');
  await tapOut('o');
  check('Super, Ctrl, o on the keyboard = Super+Ctrl+O: it closes itself (system shortcuts see its keys)', !!(await until(async () => !(await visible()))));
  await A(() => window.__aurora.settings.set('osk.enabled', true));
  await until(visible);

  // ---- locked Alt: Alt+Tab, Tab, then Alt commits the switcher
  {
    const before = await A(() => window.__aurora.wm.focused()?.appId);
    await tap('Alt');
    await tap('Alt');
    check('Alt twice: locked (filled)', await page.evaluate(() => document.querySelector('.osk [data-k="Alt"]').classList.contains('osk-locked')));
    await tap('Tab');
    const opened = await until(() => page.evaluate(() => !!document.querySelector('.alttab, #alttab, .at-switcher')?.offsetParent || document.body.classList.contains('alttab-open')), { timeout: 1500 });
    await tap('Alt');
    await sleep(400);
    const after = await A(() => window.__aurora.wm.focused()?.appId);
    check('locked Alt + Tab, then Alt again: switches window (Alt+Tab)', before !== after, { before, after, opened });
  }

  // ---- auto-show
  await A(() => window.__aurora.api.invoke('settings:setMany', { 'osk.enabled': false, 'osk.autoShow': true }));
  await until(async () => !(await visible()));
  await page.evaluate(() => {
    window.__aurora.wm.list().find((x) => x.body.contains(document.getElementById('osk-in')))?.focus();
    document.activeElement?.blur();
  });
  await sleep(300);
  await page.click('#osk-in');
  check('auto-show: clicking into a text field shows it', !!(await until(visible)));
  check('…without turning the setting on', !(await enabled()));
  await page.evaluate(() => document.getElementById('osk-in').blur());
  check('…and it goes away when the focus leaves text fields', !!(await until(async () => !(await visible()))));
  await A(() => window.__aurora.api.invoke('settings:setMany', { 'osk.autoShow': false }));

  // ---- bar button
  await A(() => window.__aurora.settings.set('osk.trayButton', true));
  const trayBtn = await until(() => page.$('#taskbar [data-status="osk"]'));
  check('bar button shown with the setting', !!trayBtn);
  await page.evaluate(() => document.getElementById('osk-in').focus());
  await page.click('#taskbar [data-status="osk"]');
  check('bar button opens it', !!(await until(visible)));
  check('…without taking the focus from the field', await page.evaluate(() => document.activeElement.id === 'osk-in'));
  await page.click('#taskbar [data-status="osk"]');
  check('bar button closes it again', !!(await until(async () => !(await visible()))));
  await A(() => window.__aurora.settings.set('osk.enabled', true));
  await until(visible);

  // ---- floating, size, settings round-trip
  await A(() => window.__aurora.api.invoke('settings:setMany', { 'osk.mode': 'floating', 'osk.float': { x: 120, y: 200, width: 700 } }));
  await sleep(450); // (after the slide-in)
  const fl = await A(() => {
    const r = window.__aurora.osk.keyboard.el.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), floating: window.__aurora.osk.keyboard.el.classList.contains('osk-floating') };
  });
  check('floating: placed and sized from settings.osk.float', fl.floating && fl.x === 120 && fl.y === 200 && fl.w === 700, fl);
  {
    const g = await page.evaluate(() => {
      const r = document.querySelector('.osk .osk-grip').getBoundingClientRect();
      return { x: r.left + 120, y: r.top + r.height / 2 };
    });
    await page.mouse.move(g.x, g.y);
    await page.mouse.down();
    await page.mouse.move(g.x + 100, g.y - 50, { steps: 6 });
    await page.mouse.up();
    const saved = await until(() => A(() => window.__aurora.settings.get('osk.float')).then((f) => f && f.x === 220 && f.y === 150 && f));
    check('dragging the grip moves it and saves the place', !!saved, await A(() => window.__aurora.settings.get('osk.float')));
    const rz = await page.evaluate(() => {
      const r = document.querySelector('.osk .osk-resize').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await page.mouse.move(rz.x, rz.y);
    await page.mouse.down();
    await page.mouse.move(rz.x + 160, rz.y, { steps: 6 });
    await page.mouse.up();
    const grown = await until(() => A(() => window.__aurora.settings.get('osk.float')).then((f) => f && f.width === 860 && f));
    const kh = await A(() => parseInt(getComputedStyle(window.__aurora.osk.keyboard.el).getPropertyValue('--osk-kh')));
    check('the corner handle resizes the floating keyboard (width saved, keys grow with it)', !!grown && kh >= 40, { f: await A(() => window.__aurora.settings.get('osk.float')), kh });
  }
  await A(() => window.__aurora.api.invoke('settings:setMany', { 'osk.mode': 'docked', 'osk.size': 'large' }));
  await sleep(150);
  const lg = await A(() => window.__aurora.osk.keyboard.el.getBoundingClientRect().width);
  check('size large: wider docked keyboard', lg > 1100, lg);
  await A(() => window.__aurora.settings.set('osk.size', 'medium'));

  // Settings > Accessibilité > Clavier visuel
  await A(() => window.__aurora.shell.launch('settings', { page: 'onScreenKeyboard' }));
  const stOk = await until(() => page.evaluate(() => !!document.querySelector('.app-settings .st-osk')), { timeout: 8000 });
  check('Paramètres opens on « Clavier visuel » (deep link osk too)', !!stOk);
  const stInfo = await page.evaluate(() => ({
    title: document.querySelector('.app-settings .st-crumb.current')?.textContent,
    rows: [...document.querySelectorAll('.app-settings .st-osk .st-row')].map((r) => r.dataset.section).filter(Boolean),
    keys: [...document.querySelectorAll('.app-settings .st-osk .pzs-keys kbd')].map((k) => k.textContent).join('+'),
  }));
  check('page: switch, shortcut (Super + Ctrl + O), layout, size, position, sound, auto-show, bar button', stInfo.title === 'Clavier visuel' && ['toggle', 'shortcut', 'layout', 'size', 'position', 'sound', 'autoShow', 'trayButton'].every((x) => stInfo.rows.includes(x)) && stInfo.keys === 'Super+Ctrl+O', stInfo);
  // (the docked keyboard covers the bottom of the Settings window: the switches are clicked directly)
  const sw = async (section) => page.evaluate((sec) => document.querySelector(`.app-settings .st-osk [data-section="${sec}"] input[role="switch"]`).click(), section);
  await sw('toggle');
  check('the switch turns it off', !!(await until(async () => !(await visible()) && !(await enabled()))));
  await sw('toggle');
  check('…and on', !!(await until(async () => (await visible()) && (await enabled()))));
  await sw('sound');
  check('« Son des touches » -> osk.sound', (await until(() => A(() => window.__aurora.settings.get('osk.sound') === true))) === true);
  await sw('trayButton');
  check('« Afficher le bouton… dans la barre » -> osk.trayButton off', (await until(() => A(() => window.__aurora.settings.get('osk.trayButton') === false && !document.querySelector('#taskbar [data-status="osk"]')))) === true);
  await page.click('.app-settings .st-osk [data-section="size"] .st-combo');
  await page.waitForSelector('body > .menu');
  await page.click('body > .menu .menu-item:nth-child(1)');
  check('size combo -> osk.size small', (await until(() => A(() => window.__aurora.settings.get('osk.size') === 'small'))) === true);
  await page.click('.app-settings .st-osk [data-section="layout"] .st-combo');
  await page.waitForSelector('body > .menu');
  const opts = await page.evaluate(() => [...document.querySelectorAll('body > .menu .menu-item')].map((m) => m.textContent.trim()));
  check('layout combo: « Comme le clavier (Français (AZERTY)) » first, then the four layouts', /^Comme le clavier \(Français \(AZERTY\)\)/.test(opts[0]) && opts.length >= 5, opts);
  await page.click('body > .menu .menu-item:nth-child(3)');
  check('layout combo -> osk.layout fr-oss, the keyboard follows', (await until(() => A(() => window.__aurora.settings.get('osk.layout') === 'fr-oss' && window.__aurora.osk.keyboard.layoutId === 'fr-oss'))) === true);
  await A(() => window.__aurora.api.invoke('settings:setMany', { 'osk.layout': 'auto', 'osk.size': 'medium', 'osk.sound': false }));
  await sleep(300);
  await s.shot('osk-settings-fr-dark');
  // the accessibility page lists it
  await A(() => window.__aurora.shell.launch('settings', { page: 'accessibility' }));
  check('Accessibilité lists « Clavier visuel »', !!(await until(() => page.evaluate(() => [...document.querySelectorAll('.app-settings .st-row')].some((r) => /Clavier visuel/.test(r.textContent))), { timeout: 5000 })));
  check('settings search finds it (« clavier visuel »)', await page.evaluate(async () => (await import('app://shell/apps/settings/lib/index.js')).searchIndex('clavier visuel', 'fr')[0]?.page === 'onScreenKeyboard'));

  // ---- sound: never for passwords
  await A(() => window.__aurora.settings.set('osk.sound', true));
  await page.evaluate(() => {
    const p = Object.assign(document.createElement('input'), { type: 'password', id: 'osk-pw' });
    document.getElementById('osk-in').after(p);
    p.focus();
  });
  check('key sound off in a password field, on elsewhere', await page.evaluate(() => {
    const k = window.__aurora.osk.keyboard;
    const pw = k.o.sound();
    document.getElementById('osk-in').focus();
    return pw === false && k.o.sound() === true;
  }));
  await A(() => window.__aurora.settings.set('osk.sound', false));

  // ---- screenshots: en / fr, light / dark (the keyboard over a window, and the settings page)
  for (const [lang, theme] of [['en', 'light'], ['fr', 'light'], ['en', 'dark']]) {
    await A(([l, t]) => window.__aurora.api.invoke('settings:setMany', { lang: l, theme: t }), [lang, theme]);
    await sleep(700);
    await A(() => window.__aurora.shell.launch('settings', { page: 'onScreenKeyboard' }));
    await sleep(700);
    await s.shot(`osk-settings-${lang}-${theme}`);
    await page.evaluate(() => {
      const w = window.__aurora.wm.list().find((x) => x.body.contains(document.getElementById('osk-in')));
      w?.focus();
      document.getElementById('osk-in').focus();
    });
    await tap('Shift');
    await sleep(200);
    await s.shot(`osk-desktop-${lang}-${theme}`);
    await A(() => window.__aurora.osk.keyboard.reset()); // (Shift once -> off)
  }
  const enLabels = await page.evaluate(() => ({ title: document.querySelector('.osk .osk-title')?.textContent, enter: document.querySelector('.osk [data-k="Enter"]')?.textContent }));
  check('English labels (On-screen keyboard, Enter)', enLabels.title === 'On-screen keyboard' && enLabels.enter === 'Enter', enLabels);
  await A(() => window.__aurora.api.invoke('settings:setMany', { lang: 'fr', theme: 'dark' }));
  await sleep(500);

  // ---- lock screen: the keyboard stays above it and types the password
  await A(() => window.__aurora.shell.lock());
  await until(() => page.$('.lockui'));
  await sleep(700);
  const above = await page.evaluate(() => {
    const k = window.__aurora.osk.keyboard.el.getBoundingClientRect();
    const hit = document.elementFromPoint(k.left + k.width / 2, k.top + k.height / 2);
    return !!hit?.closest('.osk');
  });
  check('locked: the keyboard is above the lock screen', above);
  check('locked: no settings / docking buttons on it', await page.evaluate(() => getComputedStyle(document.querySelector('.osk .osk-settings')).display === 'none'));
  await tapText('aurora'); // any key reveals the sign-in card; the rest goes to the password box
  await sleep(300);
  const pwv = await page.evaluate(() => document.querySelector('.lockui .lk-pw-field input')?.value);
  check('locked: the password is typed with the keyboard', pwv === 'aurora' || pwv === 'urora', pwv);
  if (pwv !== 'aurora') await page.evaluate(() => (document.querySelector('.lockui .lk-pw-field input').value = 'aurora'));
  await s.shot('osk-lock-fr-dark');
  await tap('Enter');
  check('locked: Entrée on the keyboard unlocks', !!(await until(() => A(() => !window.__aurora.lockScreen.locked), { timeout: 5000 })));
} catch (err) {
  check('desktop part ran without exceptions', false, err?.stack || String(err));
} finally {
  await s.close();
}
}

// ================================================================== part 4: the sign-in screen
console.log('--- sign-in screen');
if (part('greeter')) {
  const state = path.join(tmp, 'greeter-state');
  fs.mkdirSync(state, { recursive: true });
  const g = await launchShell({ mode: 'greeter', lang: 'fr', settle: 300, args: X11, env: { AURORA_GREETER_STATE: state, AURORA_GREETER_DATA: path.join(tmp, 'greeter-data') } });
  const gp = g.page;
  try {
    await until(() => gp.evaluate(() => !!window.__greeter?.ls), { timeout: 15000 });
    await gp.mouse.click(800, 450); // the curtain -> sign-in view
    await sleep(600);
    await gp.click('.lk-tray .lk-a11y');
    await gp.waitForSelector('.menu.lk-menu');
    const items = await gp.evaluate(() => [...document.querySelectorAll('.menu.lk-menu .menu-item')].map((m) => m.textContent.trim()));
    check('sign-in screen: « Clavier visuel » in the Accessibilité menu', items.some((t) => /Clavier visuel/.test(t)), items);
    await gp.evaluate(() => [...document.querySelectorAll('.menu.lk-menu .menu-item')].find((m) => /Clavier visuel/.test(m.textContent)).click());
    const gv = await until(() => gp.evaluate(() => !!window.__greeter.osk?.visible && !document.querySelector('.osk').hidden), { timeout: 3000 });
    check('…it opens the keyboard', !!gv);
    await sleep(400);
    check('the password box has the focus', await gp.evaluate(() => document.activeElement?.classList.contains('lk-input') && document.activeElement.type === 'password'));
    check('no key sound on the sign-in screen', await gp.evaluate(() => window.__greeter.osk.keyboard.o.sound() === false));
    check('no settings / move / dock buttons there (close only)', await gp.evaluate(() => !document.querySelector('.osk .osk-settings') && !document.querySelector('.osk .osk-dock') && !!document.querySelector('.osk .osk-close')));
    const gtap = async (id) => {
      const c = await gp.evaluate((id) => {
        const b = document.querySelector(`.osk [data-k="${id}"]`).getBoundingClientRect();
        return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
      }, id);
      await gp.mouse.click(c.x, c.y);
      await sleep(40);
    };
    const gout = async (ch) => gtap(await gp.evaluate((ch) => window.__greeter.osk.keyboard.keyFor(ch), ch));
    for (const ch of 'aurorx') await gout(ch);
    await gtap('Backspace');
    await gout('a');
    const pw = await gp.evaluate(() => document.querySelector('.lk-pw-field input').value);
    check('password typed with the keyboard (Backspace too): the box holds it', pw === 'aurora', pw);
    check('the typed password is not shown anywhere on the keyboard', await gp.evaluate(() => !document.querySelector('.osk').textContent.includes('aurora')));
    check('the password box kept the focus', await gp.evaluate(() => document.activeElement?.type === 'password'));
    await g.shot('osk-greeter-fr-dark');
    check('the choice is remembered (greeter:a11y osk)', (await gp.evaluate(() => window.aurora.invoke('greeter:a11y'))).osk === true);
    await gtap('Enter');
    check('Entrée on the keyboard signs in', !!(await until(() => gp.evaluate(() => document.body.classList.contains('signed-in')), { timeout: 6000 })));
  } catch (err) {
    check('sign-in part ran without exceptions', false, err?.stack || String(err));
  } finally {
    await g.close();
  }
  // a new sign-in screen shows the keyboard again
  const g2 = await launchShell({ mode: 'greeter', lang: 'en', settle: 300, args: X11, env: { AURORA_GREETER_STATE: state, AURORA_GREETER_DATA: path.join(tmp, 'greeter-data') } });
  try {
    const shown = await until(() => g2.page.evaluate(() => !!window.__greeter?.osk?.visible), { timeout: 8000 });
    check('next sign-in screen: the keyboard is there from the start', !!shown);
    await sleep(500);
    await g2.shot('osk-greeter-en-dark');
  } finally {
    await g2.close();
  }
}

// ================================================================== part 5: the desktop + aurora-xwm + an X11 client
// The real shell on a private Xvfb (fr keymap) with the real helper; a python-xlib client gets a frame and the X focus;
// the keyboard's keys are clicked with real X pointer events (XTest), so Chromium sees real button presses on its window.
async function xdesktop() {
  if (!PYENV) return console.log('SKIP X11 desktop part: python3-xlib not found');
  if (!have('Xvfb') || !have('setxkbmap')) return console.log('SKIP X11 desktop part: Xvfb / setxkbmap missing');
  let n = 200 + Math.floor(Math.random() * 50);
  while (fs.existsSync(`/tmp/.X11-unix/X${n}`) || fs.existsSync(`/tmp/.X${n}-lock`)) n++;
  const DISPLAY = `:${n}`;
  const env = { ...process.env, ...PYENV, DISPLAY };
  const procs = [];
  const xvfb = spawn('Xvfb', [DISPLAY, '-screen', '0', '1600x900x24', '-nolisten', 'tcp', '-noreset'], { stdio: 'ignore' });
  procs.push(xvfb);
  let xs = null;
  try {
    if (!(await until(() => fs.existsSync(`/tmp/.X11-unix/X${n}`), { timeout: 8000 }))) return check('X11 desktop: private Xvfb started', false);
    await sleep(300);
    spawnSync('setxkbmap', ['-display', DISPLAY, 'fr'], { env });
    // the helper with python3-xlib from PYTHONPATH when the system has none (its shebang runs python3 -I)
    let helper = HELPER;
    if (PYENV.PYTHONPATH) {
      helper = path.join(tmp, 'aurora-xwm-wrapper');
      fs.writeFileSync(helper, `#!/bin/sh\nexec python3 '${HELPER}' "$@"\n`, { mode: 0o755 });
    }
    xs = await launchShell({ lang: 'fr', theme: 'dark', args: X11, settings: { keyboardLayout: 'fr', sounds: false }, env: { DISPLAY, AURORA_XWM: '1', AURORA_XWM_HELPER: helper, ...PYENV } });
    const pg = xs.page;
    const ready = await until(() => pg.evaluate(() => window.__aurora.api.invoke('xwin:status')).then((x) => x?.ready), { timeout: 10000 });
    check('X11 desktop: the real helper manages the private display', !!ready);
    if (!ready) return;
    const cl = spawn('python3', [XKEYS, 'client'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    procs.push(cl);
    const lines = [];
    let buf = '';
    cl.stdout.setEncoding('utf8');
    cl.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        lines.push(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
    cl.stdin.on('error', () => {});
    const cid = Number((await until(() => lines.find((l) => l.startsWith('xid ')), { timeout: 5000 }))?.split(' ')[1]);
    const fr = await until(() => pg.evaluate((id) => {
      const rec = window.__aurora.xwin.frames.get(id);
      return rec?.win && !rec.win.el.getAnimations().length ? true : null;
    }, cid), { timeout: 8000 });
    check('X11 desktop: the client got a frame', !!fr);
    await pg.evaluate((id) => window.__aurora.xwin.frames.get(id).win.focus(), cid);
    const focused = await until(() => pg.evaluate((id) => window.__aurora.xwin.xFocus === id, cid), { timeout: 4000 });
    check('X11 desktop: the client has the X focus', !!focused);
    await xs.aurora(() => window.__aurora.settings.set('osk.enabled', true));
    await until(() => xs.aurora(() => window.__aurora.osk.visible()));
    await sleep(500);
    check('X11 desktop: keys go to the X client (target x)', (await xs.aurora((id) => JSON.stringify(window.__aurora.osk.target()) === JSON.stringify({ kind: 'x', id }), cid)) === true, await xs.aurora(() => window.__aurora.osk.target()));
    const holeFree = await pg.evaluate(() => {
      const k = window.__aurora.osk.keyboard.el.getBoundingClientRect();
      return window.__aurora.xwin.holes().every((h) => h.x >= k.right || h.x + h.width <= k.left || h.y >= k.bottom || h.y + h.height <= k.top);
    });
    check('X11 desktop: the keyboard is cut out of the client holes (drawn above the client)', holeFree);
    const f = await pg.evaluate(() => window.__aurora.api.invoke('xwin:debug').then((d) => d.factors));
    const CLICK = `import sys, time
from Xlib import X, display
from Xlib.ext import xtest
d = display.Display()
x, y = int(sys.argv[1]), int(sys.argv[2])
xtest.fake_input(d, X.MotionNotify, x=x, y=y); d.sync(); time.sleep(0.03)
xtest.fake_input(d, X.ButtonPress, 1); d.sync(); time.sleep(0.03)
xtest.fake_input(d, X.ButtonRelease, 1); d.sync()`;
    const xclick = async (id) => {
      const c = await pg.evaluate((id) => {
        const b = document.querySelector(`.osk [data-k="${id}"]`).getBoundingClientRect();
        return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
      }, id);
      const k = f.zoom * f.scale;
      spawnSync('python3', ['-c', CLICK, String(Math.round(c.x * k + f.ox)), String(Math.round(c.y * k + f.oy))], { env });
      await sleep(120);
    };
    const keysNow = () => lines.filter((l) => l.startsWith('{"ev": "key"')).map((l) => JSON.parse(l)).filter((e) => !['Shift_L', 'ISO_Level3_Shift', 'Control_L', 'Alt_L', 'Super_L'].includes(e.name));
    const getFocus = () => {
      const r = spawnSync('python3', ['-c', 'from Xlib import display; d = display.Display(); f = d.get_input_focus().focus; w = f\nwhile True:\n    p = w.query_tree().parent\n    if not p or p.id == d.screen().root.id: break\n    w = p\nprint(w.id)'], { env, encoding: 'utf8' });
      return Number(r.stdout.trim());
    };
    // é (AZERTY digit row), AltGr + e = €, ^ (dead) + e = ê, Shift + a = A, then Entrée
    for (const id of ['r0-2', 'AltGr', 'r1-2', 'r1-10', 'r1-2', 'Shift', 'r1-0', 'Enter']) await xclick(id);
    const got = await until(() => (keysNow().length >= 5 ? keysNow() : null), { timeout: 5000 });
    check('X11 desktop: real clicks on the keyboard type « é€êA » + Return into the X client', (got || []).map((e) => e.char || e.name).join('') === 'é€êA\r' || (got || []).map((e) => e.char || e.name).join('|') === 'é|€|ê|A|Return', (got || keysNow()).map((e) => [e.char, e.name]));
    check('X11 desktop: the client kept the X focus through the clicks', getFocus() === cid, getFocus());
    check('X11 desktop: its frame is still the active window', (await pg.evaluate((id) => window.__aurora.wm.focused()?.xwin === id && window.__aurora.xwin.xFocus === id, cid)) === true);
    await xs.shot('osk-x11-fr-dark');
  } catch (err) {
    check('X11 desktop part ran without exceptions', false, err?.stack || String(err));
  } finally {
    await xs?.close();
    for (const p of procs.reverse()) {
      try {
        p.kill('SIGTERM');
      } catch {}
    }
  }
}
console.log('--- X11 desktop');
if (part('x11desktop')) await xdesktop();

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(`failures:\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
process.exit(0);
