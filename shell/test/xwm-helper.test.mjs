// aurora-xwm (rootfs/usr/lib/aurora/helpers/aurora-xwm) driven directly under Xvfb, without Electron.
// A python-xlib fixture (test/fixtures/xwm/xclient.py) stands in for the shell window and for a client
// with icons, Motif hints and EWMH requests; xterm and xeyes are real clients. Protocol: docs/XWINDOWS.md.
//
//   cd shell && xvfb-run -a -s '-screen 0 1600x900x24' node test/xwm-helper.test.mjs
import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const HELPER = path.join(here, '..', '..', 'rootfs', 'usr', 'lib', 'aurora', 'helpers', 'aurora-xwm');
const FIXTURE = path.join(here, 'fixtures', 'xwm', 'xclient.py');
const SCREEN = { width: 1600, height: 900 };

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) passed++;
  else failures.push(name);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail !== undefined ? ` -- ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const children = [];

// A child process whose stdout is read as lines.
function start(cmd, args, opts = {}) {
  const proc = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], ...opts });
  children.push(proc);
  const lines = [];
  let buf = '';
  let stderr = '';
  proc.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      lines.push(buf.slice(0, i));
      buf = buf.slice(i + 1);
    }
  });
  proc.stderr.on('data', (d) => { stderr += d; });
  proc.stdin.on('error', () => {});
  const exited = new Promise((r) => proc.on('exit', (code, signal) => r({ code, signal })));
  return {
    proc, lines, exited,
    get stderr() { return stderr; },
    async waitLine(pred, ms = 5000, from = 0) {
      const end = Date.now() + ms;
      for (;;) {
        for (let i = from; i < lines.length; i++) if (pred(lines[i])) return lines[i];
        if (Date.now() > end) return null;
        await sleep(20);
      }
    },
    write(s) { try { proc.stdin.write(s); } catch {} },
  };
}

async function fixture(mode) {
  const f = start('python3', ['-I', FIXTURE, mode]);
  const line = await f.waitLine((l) => l.startsWith('xid '), 8000);
  f.id = line ? Number(line.split(' ')[1]) : 0;
  let cursor = f.lines.length;
  f.cmd = async (c) => {
    const from = f.lines.length;
    f.write(c + '\n');
    const ok = await f.waitLine((l) => l === 'ok', 5000, from);
    cursor = f.lines.length;
    return !!ok;
  };
  return f;
}

function startHelper(xid, extraArgs = []) {
  const h = start(HELPER, ['--shell-xid', String(xid), ...extraArgs]);
  h.events = () => h.lines.map((l) => { try { return JSON.parse(l); } catch { return { bad: l }; } });
  h.mark = () => h.lines.length;
  h.wait = async (pred, ms = 6000, from = 0) => {
    const line = await h.waitLine((l) => { try { return pred(JSON.parse(l)); } catch { return false; } }, ms, from);
    return line ? JSON.parse(line) : null;
  };
  h.send = (obj) => h.write((typeof obj === 'string' ? obj : JSON.stringify(obj)) + '\n');
  return h;
}

const x = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8', timeout: 10000 }); } catch (e) { return `ERROR ${e.message}`; } };
const xdo = (...args) => x('xdotool', args);
function geom(id) {
  const out = x('xwininfo', ['-id', String(id)]);
  const num = (re) => Number((out.match(re) || [])[1]);
  return { x: num(/Absolute upper-left X:\s+(-?\d+)/), y: num(/Absolute upper-left Y:\s+(-?\d+)/), width: num(/Width:\s+(\d+)/), height: num(/Height:\s+(\d+)/), viewable: /Map State: IsViewable/.test(out), out };
}
// Root children, top of the stack first (xwininfo's order).
const stackTopFirst = () => x('xwininfo', ['-root', '-children']).split('\n').map((l) => l.match(/^\s+(0x[0-9a-f]+)/)).filter(Boolean).map((m) => parseInt(m[1], 16));
const xprop = (args) => x('xprop', args);
const focusNow = () => Number(xdo('getwindowfocus').trim());

async function main() {
  if (!process.env.DISPLAY) {
    check('DISPLAY is set (run under xvfb-run)', false);
    return;
  }

  // ---- usage and missing python3-xlib ------------------------------------------------------
  const usage = start(HELPER, []);
  check('no --shell-xid: exit status 2', (await usage.exited).code === 2);
  const noxlib = start('python3', ['-I', '-S', HELPER, '--shell-xid', '1']);
  const nx = await noxlib.exited;
  check('python3-xlib missing: exit 4 with fatal ENOXLIB', nx.code === 4 && noxlib.lines.some((l) => /"fatal".*"ENOXLIB"/.test(l)), { code: nx.code, out: noxlib.lines });

  // ---- startup: shell stand-in, an already-mapped xeyes, the helper -----------------------
  const shell = await fixture('shell');
  check('stand-in shell window created', shell.id > 0);
  const xeyes = start('xeyes', ['-geometry', '150x100+0+0']);
  await sleep(700);
  const wm = startHelper(`0x${shell.id.toString(16)}`);
  const ready = await wm.wait((e) => e.ev === 'ready', 8000);
  check('ready with screen size and version', ready && ready.screen.width === SCREEN.width && ready.screen.height === SCREEN.height && typeof ready.version === 'string', ready);
  const eyes = await wm.wait((e) => e.ev === 'new' && e.wmClass?.[1] === 'XEyes');
  check('already-mapped xeyes adopted as new', !!eyes && eyes.x === 0 && eyes.y === 0 && eyes.width === 150, eyes);
  check('the shell itself is never managed', !wm.events().some((e) => e.ev === 'new' && e.id === shell.id));

  const check1 = xprop(['-root', '_NET_SUPPORTING_WM_CHECK']).match(/0x[0-9a-f]+/);
  check('_NET_SUPPORTING_WM_CHECK names aurora-xwm', !!check1 && /"aurora-xwm"/.test(xprop(['-id', check1[0], '_NET_WM_NAME'])));
  const supported = xprop(['-root', '_NET_SUPPORTED']);
  check('_NET_SUPPORTED lists the EWMH features', ['_NET_WM_MOVERESIZE', '_NET_WM_STATE_FULLSCREEN', '_NET_CLOSE_WINDOW', '_NET_ACTIVE_WINDOW', '_NET_WM_ICON'].every((a) => supported.includes(a)), supported);

  // ---- xterm: new, centred, below the shell ------------------------------------------------
  let m = wm.mark();
  const xterm = start('xterm', ['-e', 'sleep', '600']);
  const xt = await wm.wait((e) => e.ev === 'new' && e.wmClass?.[1] === 'XTerm', 8000, m);
  check('xterm -> new with wmClass [xterm, XTerm]', !!xt && xt.wmClass[0] === 'xterm', xt);
  if (!xt) return;
  const XT = xt.id;
  check('new carries the pid', xt.pid === xterm.proc.pid, { pid: xt.pid, expected: xterm.proc.pid });
  check('new has every documented field', ['title', 'type', 'transientFor', 'modal', 'minWidth', 'maxHeight', 'decorated', 'fullscreen', 'icon', 'startupId', 'gtkAppId'].every((k) => k in xt) && xt.type === 'normal' && xt.decorated === true, xt);
  check('a client asking for 0,0 is centred', xt.x === Math.floor((SCREEN.width - xt.width) / 2) && xt.y === Math.floor((SCREEN.height - xt.height) / 2), xt);
  let g = geom(XT);
  check('xterm is mapped at the announced geometry', g.viewable && g.x === xt.x && g.y === xt.y, g);
  let order = stackTopFirst();
  check('clients are stacked below the shell', order.indexOf(shell.id) >= 0 && order.indexOf(shell.id) < order.indexOf(XT) && order.indexOf(shell.id) < order.indexOf(eyes.id), order);
  check('WM_STATE Normal and _NET_FRAME_EXTENTS 0', /Normal/.test(xprop(['-id', String(XT), 'WM_STATE'])) && /0, 0, 0, 0/.test(xprop(['-id', String(XT), '_NET_FRAME_EXTENTS'])));
  check('_NET_CLIENT_LIST lists the clients', xprop(['-root', '_NET_CLIENT_LIST']).includes(`0x${XT.toString(16)}`));

  // ---- place / stack -------------------------------------------------------------------------
  wm.send({ cmd: 'place', id: XT, x: 100, y: 120, width: 400, height: 250 });
  await sleep(400);
  g = geom(XT);
  check('place moves and resizes the client', g.x === 100 && g.y === 120 && g.width === 400 && g.height === 250, g);
  wm.send({ cmd: 'stack', ids: [XT, eyes.id] });
  await sleep(300);
  order = stackTopFirst();
  check('stack: last id on top, all below the shell', order.indexOf(shell.id) < order.indexOf(eyes.id) && order.indexOf(eyes.id) < order.indexOf(XT), order);
  wm.send({ cmd: 'stack', ids: [eyes.id, XT] });
  await sleep(300);
  order = stackTopFirst();
  check('stack reversed', order.indexOf(shell.id) < order.indexOf(XT) && order.indexOf(XT) < order.indexOf(eyes.id), order);

  // ---- focus and keyboard grabs --------------------------------------------------------------
  const focusClient = async (id) => {
    const mk = wm.mark();
    wm.send({ cmd: 'focus', id });
    return wm.wait((e) => e.ev === 'focus' && e.id === id, 4000, mk);
  };
  check('focus command -> focus event', !!(await focusClient(XT)));
  check('xterm has X focus', focusNow() === XT, focusNow());
  check('_NET_ACTIVE_WINDOW follows focus', xprop(['-root', '_NET_ACTIVE_WINDOW']).includes(`0x${XT.toString(16)}`));

  m = wm.mark();
  xdo('key', 'super');
  const kSuper = await wm.wait((e) => e.ev === 'key' && e.combo === 'Super', 4000, m);
  check('Super alone -> key Super on release', !!kSuper && kSuper.repeat === false, wm.lines.slice(m));
  check('Super moves focus to the shell', !!(await wm.wait((e) => e.ev === 'focus' && e.id === null, 3000, m)) && focusNow() === shell.id);

  await focusClient(XT);
  m = wm.mark();
  xdo('key', 'alt+Tab');
  check('Alt+Tab -> key Alt+Tab', !!(await wm.wait((e) => e.ev === 'key' && e.combo === 'Alt+Tab', 4000, m)), wm.lines.slice(m));
  check('Alt+Tab gives the shell focus first', !!(await wm.wait((e) => e.ev === 'focus' && e.id === null, 3000, m)) && focusNow() === shell.id);

  await focusClient(XT);
  m = wm.mark();
  xdo('key', 'alt+shift+Tab');
  check('Alt+Shift+Tab -> key Alt+Shift+Tab', !!(await wm.wait((e) => e.ev === 'key' && e.combo === 'Alt+Shift+Tab', 4000, m)), wm.lines.slice(m));

  await focusClient(XT);
  m = wm.mark();
  xdo('key', 'super+d');
  check('Super+D -> key Super+D', !!(await wm.wait((e) => e.ev === 'key' && e.combo === 'Super+D', 4000, m)), wm.lines.slice(m));
  xdo('key', 'alt+F4');
  check('Alt+F4 -> key Alt+F4', !!(await wm.wait((e) => e.ev === 'key' && e.combo === 'Alt+F4', 4000, m)));
  xdo('key', 'XF86AudioRaiseVolume');
  check('volume key -> AudioVolumeUp', !!(await wm.wait((e) => e.ev === 'key' && e.combo === 'AudioVolumeUp', 4000, m)));
  xdo('key', 'ctrl+c');
  await sleep(400);
  const keys = wm.events().slice(m).filter((e) => e.ev === 'key').map((e) => e.combo);
  check('no stray Super tap and no ordinary keys forwarded', !keys.includes('Super') && !keys.includes('Ctrl+C'), keys);
  check('other combos keep focus on the client', focusNow() === XT, focusNow());

  m = wm.mark();
  wm.send({ cmd: 'focus', id: null });
  check('focus null -> shell focused', !!(await wm.wait((e) => e.ev === 'focus' && e.id === null, 4000, m)) && focusNow() === shell.id);
  m = wm.mark();
  xdo('key', 'super');
  await sleep(600);
  check('no key grabs while the shell has focus', !wm.events().slice(m).some((e) => e.ev === 'key'), wm.lines.slice(m));

  // ---- click to focus ------------------------------------------------------------------------
  m = wm.mark();
  xdo('mousemove', '300', '245');
  xdo('click', '1');
  check('clicking a client -> click event', !!(await wm.wait((e) => e.ev === 'click' && e.id === XT, 4000, m)), wm.lines.slice(m));
  check('clicking a client focuses it', !!(await wm.wait((e) => e.ev === 'focus' && e.id === XT, 4000, m)) && focusNow() === XT);

  // ---- configure requests --------------------------------------------------------------------
  m = wm.mark();
  xdo('windowsize', String(XT), '300', '200');
  const cr = await wm.wait((e) => e.ev === 'configure-request' && e.id === XT && 'width' in e, 4000, m);
  check('configure-request with the asked size', !!cr && cr.width === 300 && cr.height === 200, cr);
  g = geom(XT);
  check('the helper does not grant it by itself', g.width === 400 && g.height === 250, g);
  m = wm.mark();
  wm.send({ cmd: 'place', id: XT, x: 100, y: 120, width: 400, height: 250 });
  wm.send({ cmd: 'ping', seq: 1 });
  check('unchanged place (synthetic ConfigureNotify) is harmless', !!(await wm.wait((e) => e.ev === 'pong' && e.seq === 1, 3000, m)));

  // ---- fixture client: icon, hints, EWMH requests ---------------------------------------------
  m = wm.mark();
  const fc = await fixture('client');
  const fnew = await wm.wait((e) => e.ev === 'new' && e.id === fc.id, 6000, m);
  check('fixture client -> new', !!fnew, wm.lines.slice(m));
  if (fnew) {
    check('decorated:false from Motif hints', fnew.decorated === false);
    check('min/max size from WM_NORMAL_HINTS', fnew.minWidth === 120 && fnew.minHeight === 80 && fnew.maxWidth === 1000 && fnew.maxHeight === 700, fnew);
    check('UTF-8 title, wmClass, pid, gtkAppId, startupId', fnew.title === 'Fixture client \u00e9' && fnew.wmClass[1] === 'Fixture' && fnew.pid === fc.proc.pid && fnew.gtkAppId === 'org.example.Fixture' && fnew.startupId === 'fixture-startup-1', fnew);
    const png = typeof fnew.icon === 'string' && fnew.icon.startsWith('data:image/png;base64,') ? Buffer.from(fnew.icon.split(',')[1], 'base64') : null;
    check('icon is a PNG data URL', !!png && png.subarray(1, 4).toString() === 'PNG');
    check('icon picks the 32 px size', !!png && png.readUInt32BE(16) === 32 && png.readUInt32BE(20) === 32);
  }
  const FC = fc.id;

  m = wm.mark();
  await fc.cmd('fullscreen');
  check('_NET_WM_STATE fullscreen -> state-request', !!(await wm.wait((e) => e.ev === 'state-request' && e.id === FC && e.fullscreen === true, 4000, m)));
  await fc.cmd('maximize');
  check('_NET_WM_STATE maximized -> state-request', !!(await wm.wait((e) => e.ev === 'state-request' && e.id === FC && e.maximized === true, 4000, m)));
  await fc.cmd('activate');
  check('_NET_ACTIVE_WINDOW -> state-request activate', !!(await wm.wait((e) => e.ev === 'state-request' && e.id === FC && e.activate === true, 4000, m)));
  await fc.cmd('iconify');
  check('WM_CHANGE_STATE -> state-request minimized', !!(await wm.wait((e) => e.ev === 'state-request' && e.id === FC && e.minimized === true, 4000, m)));
  await fc.cmd('title Hello there');
  check('title change -> title event', !!(await wm.wait((e) => e.ev === 'title' && e.id === FC && e.title === 'Hello there', 4000, m)));
  await fc.cmd('minsize 150 90');
  check('WM_NORMAL_HINTS change -> hints event', !!(await wm.wait((e) => e.ev === 'hints' && e.id === FC && e.minWidth === 150 && e.minHeight === 90 && e.decorated === false, 4000, m)));

  wm.send({ cmd: 'state', id: FC, fullscreen: true, minimized: false });
  await sleep(300);
  check('state: _NET_WM_STATE set on the client', /_NET_WM_STATE_FULLSCREEN/.test(xprop(['-id', String(FC), '_NET_WM_STATE'])));
  m = wm.mark();
  await fc.cmd('unfullscreen');
  check('state-request fullscreen:false once the state is known', !!(await wm.wait((e) => e.ev === 'state-request' && e.id === FC && e.fullscreen === false, 4000, m)));
  wm.send({ cmd: 'state', id: FC, fullscreen: false, minimized: true });
  await sleep(300);
  check('state minimized: WM_STATE Iconic, still mapped', /Iconic/.test(xprop(['-id', String(FC), 'WM_STATE'])) && geom(FC).viewable);
  wm.send({ cmd: 'state', id: FC, minimized: false });

  // ---- _NET_WM_MOVERESIZE drags --------------------------------------------------------------
  const g0 = geom(FC);
  const px = g0.x + 60;
  const py = g0.y + 50;
  xdo('mousemove', String(px), String(py));
  xdo('mousedown', '1');
  m = wm.mark();
  await fc.cmd(`moveresize 8 ${px} ${py}`);
  for (let i = 1; i <= 5; i++) {
    xdo('mousemove', String(px + i * 10), String(py + i * 8));
    await sleep(40);
  }
  const mid = await wm.wait((e) => e.ev === 'drag' && e.id === FC && !e.done, 4000, m);
  check('move drag -> drag events while moving', !!mid, wm.lines.slice(m));
  xdo('mouseup', '1');
  const mdone = await wm.wait((e) => e.ev === 'drag' && e.id === FC && e.done, 4000, m);
  check('move drag ends with done:true at the final position', !!mdone && mdone.x === g0.x + 50 && mdone.y === g0.y + 40 && mdone.width === g0.width, { mdone, g0 });
  g = geom(FC);
  check('the client really moved', g.x === g0.x + 50 && g.y === g0.y + 40, g);

  const g1 = geom(FC);
  const bx = g1.x + g1.width - 3;
  const by = g1.y + g1.height - 3;
  xdo('mousemove', String(bx), String(by));
  xdo('mousedown', '1');
  m = wm.mark();
  await fc.cmd(`moveresize 4 ${bx} ${by}`);
  xdo('mousemove', String(bx + 50), String(by + 30));
  await sleep(100);
  xdo('mousemove', String(bx + 100), String(by + 70));
  await sleep(100);
  xdo('mouseup', '1');
  const rdone = await wm.wait((e) => e.ev === 'drag' && e.id === FC && e.done, 4000, m);
  check('bottom-right resize drag', !!rdone && rdone.width === g1.width + 100 && rdone.height === g1.height + 70 && rdone.x === g1.x, { rdone, g1 });
  m = wm.mark();
  const g2 = geom(FC);
  xdo('mousemove', String(g2.x + 2), String(g2.y + 2));
  xdo('mousedown', '1');
  await fc.cmd(`moveresize 0 ${g2.x + 2} ${g2.y + 2}`);
  xdo('mousemove', String(g2.x + 900), String(g2.y + 900));
  await sleep(100);
  xdo('mouseup', '1');
  const tl = await wm.wait((e) => e.ev === 'drag' && e.id === FC && e.done, 4000, m);
  check('top-left resize respects the minimum size and keeps the far edge', !!tl && tl.width === 150 && tl.height === 90 && tl.x + tl.width === g2.x + g2.width && tl.y + tl.height === g2.y + g2.height, { tl, g2 });
  m = wm.mark();
  await fc.cmd(`moveresize 8 ${g2.x} ${g2.y}`);
  const nobutton = await wm.wait((e) => e.ev === 'drag' && e.id === FC && e.done, 3000, m);
  check('a drag without a pressed button ends at once', !!nobutton, wm.lines.slice(m));
  m = wm.mark();
  wm.send({ cmd: 'ping', seq: 2 });
  check('helper still responsive after drags', !!(await wm.wait((e) => e.ev === 'pong' && e.seq === 2, 3000, m)));

  // ---- shell requests -------------------------------------------------------------------------
  await focusClient(XT);
  m = wm.mark();
  await shell.cmd('activate');
  check('_NET_ACTIVE_WINDOW for the shell focuses it', !!(await wm.wait((e) => e.ev === 'focus' && e.id === null, 4000, m)) && focusNow() === shell.id);
  await shell.cmd('fullscreen');
  await sleep(300);
  check('_NET_WM_STATE for the shell sets the property', /_NET_WM_STATE_FULLSCREEN/.test(xprop(['-id', String(shell.id), '_NET_WM_STATE'])));
  g = geom(shell.id);
  check('a fullscreen shell covers the screen, above the clients', g.x === 0 && g.y === 0 && g.width === SCREEN.width && g.height === SCREEN.height && stackTopFirst().indexOf(shell.id) < stackTopFirst().indexOf(FC), g);

  // ---- robustness -------------------------------------------------------------------------------
  m = wm.mark();
  wm.send('this is {not json');
  wm.send({ cmd: 'place', id: XT, x: 'a' });
  wm.send({ cmd: 'focus', id: 12345 });
  wm.send({ cmd: 'nonsense' });
  wm.send({ cmd: 'ping', seq: 3 });
  check('malformed line logged and ignored', !!(await wm.wait((e) => e.ev === 'log' && /malformed/.test(e.message), 3000, m)));
  check('bad commands do not stop the helper (pong)', !!(await wm.wait((e) => e.ev === 'pong' && e.seq === 3, 3000, m)));
  const other = startHelper(shell.id);
  const oexit = await other.exited;
  check('second helper on the same display: exit 3, fatal EOTHERWM', oexit.code === 3 && other.lines.some((l) => /"fatal".*"EOTHERWM"/.test(l)), { code: oexit.code, lines: other.lines });

  // ---- closing ------------------------------------------------------------------------------------
  const fc2 = await fixture('client');
  await wm.wait((e) => e.ev === 'new' && e.id === fc2.id, 5000);
  m = wm.mark();
  await fc2.cmd('unmap');
  check('client withdraws -> gone', !!(await wm.wait((e) => e.ev === 'gone' && e.id === fc2.id, 4000, m)));
  m = wm.mark();
  await fc.cmd(`closemsg ${FC}`);
  check('_NET_CLOSE_WINDOW -> WM_DELETE_WINDOW to the client', !!(await fc.waitLine((l) => l === 'delete', 4000)));
  check('closed fixture -> gone', !!(await wm.wait((e) => e.ev === 'gone' && e.id === FC, 4000, m)));
  m = wm.mark();
  wm.send({ cmd: 'close', id: XT });
  const xtExit = await Promise.race([xterm.exited, sleep(5000).then(() => null)]);
  check('close -> xterm exits', !!xtExit, xtExit);
  check('xterm -> gone', !!(await wm.wait((e) => e.ev === 'gone' && e.id === XT, 4000, m)));
  wm.send({ cmd: 'kill', id: eyes.id });
  const eyesExit = await Promise.race([xeyes.exited, sleep(5000).then(() => null)]);
  check('kill -> xeyes is disconnected', !!eyesExit);
  await wm.wait((e) => e.ev === 'gone' && e.id === eyes.id, 3000, m);
  await sleep(300);
  const gones = wm.events().filter((e) => e.ev === 'gone');
  check('each window gone exactly once', [XT, FC, fc2.id, eyes.id].every((id) => gones.filter((e) => e.id === id).length === 1), gones);
  check('no gone for the shell', !gones.some((e) => e.id === shell.id));
  check('no error-level log during the run', !wm.events().some((e) => e.ev === 'log' && e.level === 'error'), wm.events().filter((e) => e.ev === 'log' && e.level === 'error'));

  wm.proc.stdin.end();
  const wexit = await Promise.race([wm.exited, sleep(5000).then(() => null)]);
  check('stdin EOF -> clean exit 0', !!wexit && wexit.code === 0, { wexit, stderr: wm.stderr });
  check('no Python traceback on stderr', !/Traceback/.test(wm.stderr), wm.stderr);
}

const timer = setTimeout(() => { console.log('timeout'); finish(); }, 110000);
function finish() {
  clearTimeout(timer);
  for (const c of children) if (c.exitCode === null && c.signalCode === null) { try { c.kill('SIGKILL'); } catch {} }
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) console.log('Failed:\n  ' + failures.join('\n  '));
  process.exit(failures.length ? 1 : 0);
}
main().catch((e) => { check(`no exception (${e.stack || e})`, false); }).finally(finish);
