// Terminal tests.
//   Part 1 (plain node): the aurora-pty helper — echo, window size + resize over fd 3, exit codes,
//     UTF-8 both ways, Ctrl+C, signals, hang-up on SIGTERM / stdin EOF, login shell, cwd, environment,
//     large binary-safe output with backpressure.
//   Part 2 (real Electron shell + Playwright): echo, OSC title -> tab title, stty size after resizing
//     and maximizing, UTF-8 (é, emoji), Ctrl+C interrupts sleep, exit closes the tab, tabs (new, switch,
//     close, rename, duplicate), split panes (Alt+Shift+D, focus with Alt+arrows, close pane), copy/paste
//     (Ctrl+Shift+C/V, Ctrl+C with a selection), context menu, find, font zoom, colour schemes in light
//     and dark (follow system theme + explicit), settings tab (persisted), link click -> openUrl, bell,
//     confirm on close, French UI, minimum size and maximized layouts, 10 open/close cycles without
//     orphan processes, and no console errors.
//   QA regressions: pasted ESC sequences cannot break out of bracketed paste, large-paste warning,
//     OSC 8 targets shown on hover, program titles sanitised, window shortcuts and Tab focus stay
//     inside an open dialog, find listeners do not stack, copy on select only for mouse selections,
//     readable exit message + spawn failure hint, Export text, starting directory validation (~),
//     launch cwd '~/x' / relative / junk, IPC event never taken from the arguments, installed fonts
//     only, OSC 9;4 progress ring + taskbar progress, French tab menu / paste warning / min-size
//     settings, 15 open/close cycles with unchanged listeners, sessions and DOM.
//   Documentation screenshots: aurora-os/docs/screenshots/terminal-*.png
//   Ambiances: the default scheme and the profile icons follow the ambiance (cold unchanged, no blue in neutral / warm,
//     live), explicit schemes kept, Clair de lune's violet accent when the style was written without its follow rule.
// Usage:  cd aurora-os/shell && xvfb-run -a -s "-screen 0 1600x900x24" node test/terminal.test.mjs [--only=helper|ui|fr|ambiance|orphans|shots]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { launchShell, ROOT } from './lib.mjs';

const DOCS = path.join(ROOT, '..', 'docs', 'screenshots');
fs.mkdirSync(DOCS, { recursive: true });
const HELPER = path.join(ROOT, '..', 'rootfs', 'usr', 'lib', 'aurora', 'helpers', 'aurora-pty');
const only = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7).toLowerCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
const failures = [];
function check(name, actual, expected) {
  const ok = typeof expected === 'function' ? !!expected(actual) : Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++;
  else failures.push(`${name}\n      expected: ${typeof expected === 'function' ? '(predicate)' : JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
  return ok;
}
let recover = null;
async function section(group, name, fn) {
  if (only && group !== only && !name.toLowerCase().includes(only)) return;
  const t0 = Date.now();
  const before = failures.length;
  try {
    await fn();
    console.log(`  ${failures.length === before ? '✓' : '✗'} ${name} (${Date.now() - t0} ms)`);
  } catch (err) {
    failures.push(`${name}: threw ${err?.stack || err}`);
    console.log(`  ✗ ${name}: ${err?.message || err}`);
  }
  await recover?.();
}
async function until(fn, { timeout = 6000, step = 50, label = 'condition' } = {}) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    last = await fn();
    if (last) return last;
    await sleep(step);
  }
  throw new Error(`timed out waiting for ${label} (last: ${JSON.stringify(last)})`);
}

// ================================================================== part 1: the helper
// The commands typed below are POSIX shell: pin bash as the login shell (aurora-pty, inherited by the test shells
// through the environment) instead of the developer's own (fish on the user's PC never ran `...; exit`).
process.env.AURORA_PTY_LOGIN_SHELL = fs.existsSync('/bin/bash') ? '/bin/bash' : '/usr/bin/bash';
function pty(args, { env = {}, cwd } = {}) {
  const child = spawn(HELPER, args, { stdio: ['pipe', 'pipe', 'pipe', 'pipe'], env: { ...process.env, LANG: 'C.UTF-8', ...env }, cwd });
  const st = { child, out: Buffer.alloc(0), err: '', code: null, signal: null, pid: 0 };
  child.stdout.on('data', (d) => (st.out = Buffer.concat([st.out, d])));
  child.stderr.on('data', (d) => {
    st.err += d;
    const m = /@pid (\d+)/.exec(st.err);
    if (m) st.pid = Number(m[1]);
  });
  st.done = new Promise((r) =>
    child.on('exit', (code, signal) => {
      st.code = code;
      st.signal = signal;
      r(st);
    }),
  );
  st.text = () => st.out.toString('utf8');
  st.write = (s) => child.stdin.write(s);
  st.ctl = (s) => child.stdio[3].write(s);
  st.waitFor = (re, timeout = 5000) => until(() => re.test(st.text()), { timeout, label: String(re) });
  return st;
}
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const BASH = ['--', 'bash', '--norc', '--noprofile', '-i'];

async function helperTests() {
  console.log('aurora-pty helper');
  await section('helper', 'echo, @pid line and exit status', async () => {
    const p = pty(['--', 'sh', '-c', 'echo hello; exit 3']);
    await p.done;
    check('output', p.text(), (t) => t.includes('hello\r\n'));
    check('exit code', p.code, 3);
    check('stderr announces the child pid', /^@pid \d+\n$/.test(p.err), true);
  });
  await section('helper', 'window size and resize over fd 3', async () => {
    const p = pty(['--cols', '100', '--rows', '30', ...BASH]);
    await p.waitFor(/[$#] $/);
    p.write('stty size\r');
    await p.waitFor(/[\r\n]30 100\r\n/);
    p.ctl('resize 120 40\n');
    await sleep(100);
    p.write('stty size; echo "cols=$COLUMNS"\r');
    await p.waitFor(/[\r\n]40 120\r\n/);
    check('initial size', /[\r\n]30 100\r\n/.test(p.text()), true);
    check('resized size', /[\r\n]40 120\r\n/.test(p.text()), true);
    await p.waitFor(/cols=120/);
    check('SIGWINCH reached the shell (checkwinsize)', /cols=120/.test(p.text()), true);
    p.ctl('resize 0 abc\n');
    p.ctl('bogus command\n');
    p.write('exit 0\r');
    await p.done;
    check('bad control lines are ignored', p.code, 0);
  });
  await section('helper', 'UTF-8 output and input', async () => {
    const p = pty(['--', 'sh', '-c', 'printf "é🙂€\\n"; IFS= read -r line; printf "got:%s\\n" "$line"']);
    await p.waitFor(/é🙂€/);
    p.write('ünïcödé ✓ 🙂\r');
    await p.done;
    check('UTF-8 output', p.text().includes('é🙂€'), true);
    check('UTF-8 input round trip', p.text().includes('got:ünïcödé ✓ 🙂'), true);
  });
  await section('helper', 'Ctrl+C interrupts the foreground job', async () => {
    const p = pty(BASH);
    await p.waitFor(/[$#] $/);
    p.write('sleep 100\r');
    await sleep(400);
    p.write('\x03');
    await sleep(200);
    p.write('echo "rc=$?"\r');
    await p.waitFor(/rc=130/);
    check('sleep got SIGINT (130)', /rc=130/.test(p.text()), true);
    p.write('exit 5\r');
    await p.done;
    check('exit status of the shell', p.code, 5);
  });
  await section('helper', 'signal over fd 3 and death by signal', async () => {
    const p = pty(['--', 'sleep', '100']);
    await until(() => p.pid, { label: 'pid' });
    p.ctl('signal TERM\n');
    await p.done;
    check('killed by SIGTERM -> 143', p.code, 143);
    const q = pty(['--', 'nonexistent-command-xyz']);
    await q.done;
    check('command not found -> 127', q.code, 127);
    check('error text on the terminal', q.text(), (t) => t.includes("cannot run 'nonexistent-command-xyz'"));
  });
  await section('helper', 'SIGTERM to the helper hangs the terminal up', async () => {
    const p = pty(['--', 'sh', '-c', 'sleep 100; echo never']);
    await until(() => p.pid, { label: 'pid' });
    await sleep(200);
    p.child.kill('SIGTERM');
    await p.done;
    check('helper exits with 128+SIGHUP', p.code, 129);
    await sleep(100);
    check('child is gone', alive(p.pid), false);
  });
  await section('helper', 'EOF on stdin hangs the terminal up (no orphans)', async () => {
    const p = pty(BASH);
    await p.waitFor(/[$#] $/);
    p.write('sleep 300 &\r');
    await sleep(300);
    p.write('sleep 301\r');
    await sleep(300);
    p.child.stdin.end();
    await p.done;
    await sleep(200);
    check('shell gone', alive(p.pid), false);
    const left = fs
      .readdirSync('/proc')
      .filter((d) => /^\d+$/.test(d))
      .filter((d) => {
        try {
          return /^sleep\0(300|301)\0$/.test(fs.readFileSync(`/proc/${d}/cmdline`, 'utf8'));
        } catch {
          return false;
        }
      });
    check('background and foreground jobs got SIGHUP', left, []);
  });
  await section('helper', 'a shell killed before it passes the hang-up on still has its background jobs hung up', async () => {
    // On a loaded machine the shell may not exit within the grace period, and once it is killed it can no longer
    // send SIGHUP to its background jobs: the helper must. A zero grace period makes that case deterministic.
    const procs = (re) =>
      fs.readdirSync('/proc').filter((d) => {
        if (!/^\d+$/.test(d)) return false;
        try {
          return re.test(fs.readFileSync(`/proc/${d}/cmdline`, 'utf8'));
        } catch {
          return false;
        }
      });
    const p = pty(BASH, { env: { AURORA_PTY_HANGUP_GRACE: '0' } });
    await p.waitFor(/[$#] $/);
    p.write('sleep 302 & sleep 303\r');
    for (let i = 0; i < 40 && !(procs(/^sleep\x00302\x00$/).length && procs(/^sleep\x00303\x00$/).length); i++) await sleep(50);
    check('background and foreground jobs started', procs(/^sleep\x00302\x00$/).length === 1 && procs(/^sleep\x00303\x00$/).length === 1, true);
    p.child.stdin.end();
    await p.done;
    for (let i = 0; i < 30 && procs(/^sleep\x00(302|303)\x00$/).length; i++) await sleep(50);
    const left = procs(/^sleep\x00(302|303)\x00$/);
    for (const d of left) try { process.kill(Number(d), 'SIGKILL'); } catch {}
    check('jobs of a killed shell got SIGHUP', left, []);
  });
  await section('helper', 'login shell, cwd and environment', async () => {
    const p = pty(['--cwd', '/tmp'], { env: { HOME: os.tmpdir() } });
    await sleep(600);
    p.write('echo "z=$0|$PWD|$TERM|$COLORTERM|${LANG}"; exit\r');
    await p.done;
    check('login shell argv0, cwd, TERM, COLORTERM, LANG', /z=-\w+\|\/tmp\|xterm-256color\|truecolor\|C\.UTF-8/.test(p.text()), true);
    const q = pty(['--cwd', '/nonexistent/dir', '--', 'sh', '-c', 'pwd'], { env: { HOME: '/' } });
    await q.done;
    check('missing cwd falls back to home', q.text().trim(), (t) => t.length > 0 && !t.includes('nonexistent'));
    const r = spawn(HELPER, ['--cols', 'x'], { stdio: 'ignore' });
    const code = await new Promise((res) => r.on('exit', res));
    check('usage error -> 2', code, 2);
  });
  await section('helper', 'hang-up while the reader is stalled still exits', async () => {
    const p = pty(['--', 'yes']);
    await until(() => p.out.length > 0, { label: 'output' });
    p.child.stdout.pause(); // nobody reads any more (like a renderer that went away)
    await sleep(300);
    const t0 = Date.now();
    p.child.kill('SIGTERM');
    await Promise.race([p.done, sleep(6000)]);
    check('helper exited', p.code !== null || p.signal !== null, true);
    check('within the grace period', Date.now() - t0 < 4000, true);
    check('yes is gone', alive(p.pid), false);
    p.child.stdout.destroy();
  });
  await section('helper', 'large output with backpressure', async () => {
    const p = pty(['--', 'sh', '-c', 'head -c 3000000 /dev/zero | tr "\\0" "x"; echo; echo END']);
    p.child.stdout.pause();
    await sleep(700); // the helper must stop reading the PTY, not buffer without limit or die
    p.child.stdout.resume();
    await p.done;
    const t = p.text();
    check('all bytes arrive', (t.match(/x/g) || []).length, 3000000);
    check('then the end marker', t.trimEnd().endsWith('END'), true);
    check('exit 0', p.code, 0);
  });
}

// ================================================================== part 2: the app
const WIN = '.win.app-terminal';
// Evaluate fn(app, el, arg) for the last (or index-th) Terminal window. Expression string: the shell's
// CSP forbids building functions inside the page.
function TM(s, fn, arg, index = -1) {
  const expr = `(() => { const all = [...document.querySelectorAll(${JSON.stringify(WIN)})].filter((e) => !e.classList.contains('closing')); const el = all.at(${index}); return (${fn.toString()})(el && el.__terminal, el, ${JSON.stringify(arg ?? null)}); })()`;
  return s.page.evaluate(expr);
}
const run = (s, expr) => s.page.evaluate(expr);
const winCount = (s) => run(s, `[...document.querySelectorAll('${WIN}')].filter((e) => !e.classList.contains('closing')).length`);
// Text of the active pane's buffer (or of pane i of the active tab).
const buffer = (s, pane = null) =>
  TM(
    s,
    (app, el, i) => {
      const ses = i == null ? app?.session : app?.active?.tree?.sessions()[i];
      if (!ses?.term) return ''; // window still starting
      const b = ses.term.buffer.active;
      const out = [];
      for (let y = 0; y < b.length; y++) out.push(b.getLine(y).translateToString(true));
      return out.join('\n');
    },
    pane,
  );
const tabInfo = (s) =>
  TM(s, (app) => ({
    count: app.tabs.length,
    active: app.tabs.indexOf(app.active),
    titles: app.tabs.map((t) => t.titleEl.textContent),
    panes: app.active?.tree ? app.active.tree.count : 0,
    winTitle: app.win.title,
  }));
async function focusTerm(s) {
  await TM(s, (app) => app.session?.focus());
  await sleep(40);
}
async function typeLine(s, line) {
  await focusTerm(s);
  await s.page.keyboard.type(line);
  await s.page.keyboard.press('Enter');
}
// Drag the mouse over the first `chars` cells of the last buffer line equal to `text` (a real selection).
async function mouseSelect(s, text, chars = text.length) {
  const r = await TM(
    s,
    (app, el, text) => {
      const b = app.session.term.buffer.active;
      let row = -1;
      for (let y = 0; y < b.length; y++) if (b.getLine(y).translateToString(true) === text) row = y - b.viewportY;
      const screen = app.session.el.querySelector('.xterm-screen').getBoundingClientRect();
      return { row, x: screen.left, y: screen.top + (row + 0.5) * (screen.height / app.session.term.rows), cw: screen.width / app.session.term.cols };
    },
    text,
  );
  if (r.row < 0) throw new Error(`line not on screen: ${text}`);
  await s.page.mouse.move(r.x + 2, r.y);
  await s.page.mouse.down();
  await s.page.mouse.move(r.x + r.cw * chars - 2, r.y, { steps: 5 });
  await s.page.mouse.up();
  await sleep(60);
}
async function waitText(s, re, opts = {}) {
  return until(async () => re.test(await buffer(s, opts.pane ?? null)), { timeout: opts.timeout || 6000, label: `buffer ${re}` });
}
async function waitReady(s) {
  await until(() => TM(s, (app) => app?.session?.state === 'running' && app.session.term.buffer.active.length > 0), { label: 'terminal running', timeout: 15000 });
  await waitText(s, /[$#] *$/m, { timeout: 15000 });
}
async function openTerminal(s, args = {}) {
  const n = await winCount(s);
  await run(s, `window.__aurora.shell.launch('terminal', ${JSON.stringify(args)}); 0`);
  await until(async () => (await winCount(s)) > n, { label: 'terminal window', timeout: 10000 });
  await waitReady(s);
}
const dialogOpen = (s) => run(s, `!!document.querySelector('${WIN} > .dialog-layer:not(.closing)')`);
const dialogText = (s) => run(s, `(document.querySelector('${WIN} > .dialog-layer:not(.closing) .dialog-body')||{}).innerText || ''`);
async function dialogButton(s, label) {
  await until(() => dialogOpen(s), { label: 'dialog' });
  await s.page.locator(`${WIN} > .dialog-layer:not(.closing) .dialog-footer .btn`, { hasText: label }).first().click();
  await sleep(250);
}
const menuLabels = (s) => run(s, `[...document.querySelectorAll('body > .menu .menu-item .label')].map((e) => e.textContent)`);
async function closeMenus(s) {
  for (let i = 0; i < 4 && (await run(s, `!!document.querySelector('body > .menu')`)); i++) {
    await s.page.keyboard.press('Escape');
    await sleep(120);
  }
}
function errorsSince(s, mark) {
  return s.logs.slice(mark).filter((l) => /^\[(error|pageerror)\]/.test(l) && !/status of 404/.test(l) && !/net::ERR_|webview/i.test(l));
}
async function shot(s, name, { clip = false } = {}) {
  await sleep(350);
  const file = path.join(DOCS, `terminal-${name}.png`);
  if (clip) {
    const r = await run(s, `(() => { const r = [...document.querySelectorAll('${WIN}')].pop().getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
    await s.page.screenshot({ path: file, clip: { x: Math.max(0, r.x - 24), y: Math.max(0, r.y - 24), width: Math.min(1600, r.width + 48), height: Math.min(900, r.height + 48) } });
  } else await s.page.screenshot({ path: file });
  return file;
}
// Processes started for this shell's terminals (the helpers and everything they run) carry
// AURORA_TERMINAL=1 and this test's HOME.
function terminalProcs(home) {
  const out = [];
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const env = fs.readFileSync(`/proc/${d}/environ`, 'utf8').split('\0');
      if (env.includes('AURORA_TERMINAL=1') && env.includes(`HOME=${home}`)) out.push(`${d}:${fs.readFileSync(`/proc/${d}/comm`, 'utf8').trim()}`);
    } catch {}
  }
  return out;
}
// A home with things for `ls --color` to colour.
function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-term-'));
  for (const d of ['Desktop', 'Documents', 'Downloads', 'Music', 'Pictures', 'Videos', 'Projects/aurora-shell/src']) fs.mkdirSync(path.join(home, d), { recursive: true });
  fs.writeFileSync(path.join(home, 'notes.txt'), 'Aurora OS terminal test\nhello world\n');
  fs.writeFileSync(path.join(home, 'build.sh'), '#!/bin/sh\necho build\n', { mode: 0o755 });
  fs.writeFileSync(path.join(home, 'photos-2026.tar.gz'), Buffer.alloc(2048));
  fs.writeFileSync(path.join(home, 'wallpaper.png'), Buffer.alloc(512));
  fs.symlinkSync(path.join(home, 'Documents'), path.join(home, 'docs-link'));
  fs.writeFileSync(path.join(home, 'Projects/aurora-shell/README.md'), '# Aurora\n');
  fs.writeFileSync(path.join(home, 'Projects/aurora-shell/src/main.py'), 'print("hello")\n');
  return home;
}

async function uiTests() {
  console.log('Terminal app (en, dark)');
  const home = makeHome();
  const s = await launchShell({ open: ['terminal'], lang: 'en', theme: 'dark', home });
  recover = async () => {
    await closeMenus(s).catch(() => {});
    for (let i = 0; i < 4 && (await dialogOpen(s).catch(() => false)); i++) {
      await s.page.keyboard.press('Escape').catch(() => {});
      await sleep(200);
    }
    await TM(s, (app) => app?.find.isOpen && app.find.close()).catch(() => {});
  };
  const mark0 = s.logs.length;
  try {
    await s.page.waitForSelector(`${WIN} .xterm`, { timeout: 20000 });
    await waitReady(s);

    await section('ui', 'opens with one tab running the login shell', async () => {
      const ti = await tabInfo(s);
      check('one tab', ti.count, 1);
      check('one pane', ti.panes, 1);
      check('tab strip is a row under the title bar', await run(s, `!!document.querySelector('${WIN} .win-body > .tm-strip .tm-tab.active') && !document.querySelector('${WIN} .win-titlebar .tm-strip')`), true);
      check('no dropdown chevron next to +', await run(s, `!document.querySelector('${WIN} .tm-newgroup .tm-dropdown') && document.querySelector('${WIN} .tm-newgroup').children.length === 1`), true);
      check('xterm styles loaded', await run(s, `getComputedStyle(document.querySelector('${WIN} .xterm-helper-textarea')).opacity`), '0');
      const env = await TM(s, (app) => app.env);
      check('pty:env knows the login shell', env.shell, (v) => /\/(ba|z|da|fi)?sh$/.test(v));
      check('profiles', await TM(s, (app) => app.profiles().map((p) => p.id)), (v) => v[0] === 'shell' && v.includes('python'));
    });

    await section('ui', 'echo hello', async () => {
      await typeLine(s, 'echo hel""lo');
      await waitText(s, /^hello$/m);
      check('output line', /^hello$/m.test(await buffer(s)), true);
    });

    await section('ui', 'OSC title becomes the tab and window title', async () => {
      await typeLine(s, "printf '\\033]0;mytitle\\007'; sleep 2");
      await until(async () => (await tabInfo(s)).titles[0] === 'mytitle', { label: 'tab title', timeout: 4000 });
      const ti = await tabInfo(s);
      check('tab title', ti.titles[0], 'mytitle');
      check('window title', ti.winTitle, 'mytitle');
      check('taskbar/window title follows', await run(s, `[...window.__aurora.wm.list()].find((w) => w.appId === 'terminal').title`), 'mytitle');
      await waitText(s, /sleep 2\n.*[$#] *$/m, { timeout: 5000 });
    });

    await section('ui', 'stty size after resize and maximize', async () => {
      const sizeOf = () => TM(s, (app) => `${app.session.term.rows} ${app.session.term.cols}`);
      await TM(s, (app) => app.win.setSize(640, 380));
      await sleep(400);
      const small = await sizeOf();
      await typeLine(s, 'clear; stty size');
      await waitText(s, new RegExp(`^${small}$`, 'm'));
      check('stty size == xterm size (small)', new RegExp(`^${small}$`, 'm').test(await buffer(s)), true);
      check('window really got smaller', Number(small.split(' ')[1]) < 80, true);
      await TM(s, (app) => app.win.maximize());
      await sleep(600);
      const big = await sizeOf();
      await typeLine(s, 'clear; stty size');
      await waitText(s, new RegExp(`^${big}$`, 'm'));
      check('stty size == xterm size (maximized)', new RegExp(`^${big}$`, 'm').test(await buffer(s)), true);
      check('maximized is bigger', Number(big.split(' ')[1]) > Number(small.split(' ')[1]), true);
      await TM(s, (app) => app.win.restore());
      await sleep(400);
    });

    await section('ui', 'UTF-8: accents and emoji', async () => {
      await typeLine(s, 'clear; echo "café 🙂 ünïcödé"');
      await waitText(s, /^café 🙂 ünïcödé$/m);
      check('echoed back intact', /^café 🙂 ünïcödé$/m.test(await buffer(s)), true);
      const wide = await TM(s, (app) => {
        const b = app.session.term.buffer.active;
        for (let y = 0; y < b.length; y++) {
          const line = b.getLine(y);
          if (line.translateToString(true) === 'café 🙂 ünïcödé') return line.getCell(5).getChars() + line.getCell(5).getWidth();
        }
        return null;
      });
      check('emoji is one wide cell', wide, '🙂2');
    });

    await section('ui', 'Ctrl+C interrupts sleep 100', async () => {
      await typeLine(s, 'sleep 100');
      await until(() => TM(s, (app) => app.session.busy), { label: 'busy (sleep running)', timeout: 4000 });
      check('tab title shows the running command', (await tabInfo(s)).titles[0], (t) => /sleep/.test(t));
      await s.page.keyboard.press('Control+c');
      await sleep(250);
      await typeLine(s, 'echo "rc=$?"');
      await waitText(s, /^rc=130$/m);
      check('exit status 130', /^rc=130$/m.test(await buffer(s)), true);
      await until(() => TM(s, (app) => !app.session.busy), { label: 'not busy', timeout: 4000 });
    });

    await section('ui', 'output flood: stays responsive, Ctrl+C stops it', async () => {
      await typeLine(s, 'yes "flood-line aurora terminal 0123456789 abcdefghijklmnopqrstuvwxyz"');
      await until(() => TM(s, (app) => app.session.busy), { label: 'yes running' });
      await sleep(2500);
      // the shell page keeps answering while xterm digests the flood
      const t0 = Date.now();
      await run(s, '1 + 1');
      check('renderer responsive during the flood', Date.now() - t0 < 1000, true);
      const lag = await run(s, `new Promise((r) => { const t = performance.now(); requestAnimationFrame(() => r(performance.now() - t)); })`);
      check('frames keep coming', lag < 500, true);
      await s.page.keyboard.press('Control+c');
      await until(() => TM(s, (app) => !app.session.busy), { label: 'yes stopped', timeout: 8000 });
      await typeLine(s, 'clear; echo after-flood');
      await waitText(s, /^after-flood$/m, { timeout: 8000 });
      check('terminal usable after the flood', /^after-flood$/m.test(await buffer(s)), true);
    });

    await section('ui', 'tabs: new, switch, rename, duplicate, close', async () => {
      await s.page.keyboard.press('Control+Shift+T');
      await until(async () => (await tabInfo(s)).count === 2, { label: '2 tabs' });
      await waitReady(s);
      check('new tab is active', (await tabInfo(s)).active, 1);
      await s.page.keyboard.press('Control+Tab');
      await sleep(150);
      check('Ctrl+Tab switches', (await tabInfo(s)).active, 0);
      await s.page.keyboard.press('Control+Shift+Tab');
      await sleep(150);
      check('Ctrl+Shift+Tab switches back', (await tabInfo(s)).active, 1);
      // Click the + button, then use the dropdown to open Python.
      await s.page.click(`${WIN} .tm-newtab`);
      await until(async () => (await tabInfo(s)).count === 3, { label: '3 tabs' });
      await waitReady(s);
      await s.page.click(`${WIN} .tm-newtab`, { button: 'right' });
      await until(() => run(s, `!!document.querySelector('body > .menu.tm-profile-menu')`), { label: 'profiles menu (right-click on +)' });
      check('right-click on + opens the profiles, not a tab', (await tabInfo(s)).count, 3);
      await closeMenus(s);
      await s.page.click(`${WIN} .tm-dropdown`);
      await until(() => run(s, `!!document.querySelector('body > .menu.tm-profile-menu')`), { label: 'profiles menu' });
      check('profiles menu', await menuLabels(s), (l) => l[0] === 'Bash' && l.includes('Python 3') && l.includes('Settings'));
      check('profile icons drawn', await run(s, `document.querySelector('body > .menu.tm-profile-menu .menu-item .icon svg linearGradient') != null`), true);
      await s.page.locator('body > .menu.tm-profile-menu .menu-item', { hasText: 'Python 3' }).click();
      await until(async () => (await tabInfo(s)).count === 4, { label: '4 tabs' });
      await waitText(s, /^>>> *$/m, { timeout: 10000 });
      check('python tab title', (await tabInfo(s)).titles[3], 'Python 3');
      await typeLine(s, 'print(6*7)');
      await waitText(s, /^42$/m);
      check('python REPL works', /^42$/m.test(await buffer(s)), true);
      // exit() closes the tab (exit code 0)
      await typeLine(s, 'exit()');
      await until(async () => (await tabInfo(s)).count === 3, { label: 'python tab closed' });
      // exit in a shell tab closes it
      await TM(s, (app) => app.activate(app.tabs[2]));
      await typeLine(s, 'exit');
      await until(async () => (await tabInfo(s)).count === 2, { label: 'exit closes tab' });
      check('exit closed the tab', (await tabInfo(s)).count, 2);
      // a failing exit keeps the pane with the WT message, Enter restarts
      await TM(s, (app) => app.activate(app.tabs[1]));
      await typeLine(s, 'exit 3');
      await waitText(s, /process exited with code 3 \(0x00000003\)/);
      check('tab kept with exit message', (await tabInfo(s)).count, 2);
      await focusTerm(s);
      await s.page.keyboard.press('Enter');
      await until(() => TM(s, (app) => app.session.state === 'running'), { label: 'restarted' });
      await waitText(s, /[$#] *$/m);
      check('Enter restarts the shell', await TM(s, (app) => app.session.state), 'running');
      // rename (double click) and duplicate
      await s.page.dblclick(`${WIN} .tm-tab.active .tm-tab-title`);
      await until(() => run(s, `!!document.querySelector('${WIN} .tm-tab-rename')`), { label: 'rename box' });
      await s.page.keyboard.press('Control+a');
      await s.page.keyboard.type('Build server');
      await s.page.keyboard.press('Enter');
      await sleep(100);
      check('renamed tab', (await tabInfo(s)).titles[1], 'Build server');
      check('double-clicking a tab does not maximize', await TM(s, (app) => app.win.state), 'normal');
      await TM(s, (app) => app.session.focus());
      await s.page.keyboard.press('Control+Shift+D');
      await until(async () => (await tabInfo(s)).count === 3, { label: 'duplicated tab' });
      await waitReady(s);
      check('duplicate is next to the source', (await tabInfo(s)).active, 2);
      // close with Ctrl+Shift+W and with the tab's close button
      await s.page.keyboard.press('Control+Shift+W');
      await until(async () => (await tabInfo(s)).count === 2, { label: 'Ctrl+Shift+W' });
      await s.page.click(`${WIN} .tm-tab.active .tm-tab-close`);
      await until(async () => (await tabInfo(s)).count === 1, { label: 'close button' });
      check('one tab left', (await tabInfo(s)).count, 1);
    });

    await section('ui', 'split panes: duplicate, focus with Alt+arrows, resize, close', async () => {
      await focusTerm(s);
      await s.page.keyboard.press('Alt+Shift+D');
      await until(async () => (await tabInfo(s)).panes === 2, { label: '2 panes' });
      await waitReady(s);
      const layout = await TM(s, (app) => {
        const [a, b] = app.active.tree.leaves().map((l) => l.el.getBoundingClientRect());
        return { side: Math.abs(a.top - b.top) < 2 && b.left > a.left, focusedRight: app.session === app.active.tree.sessions()[1], border: !!document.querySelector('.win.app-terminal .tm-pane.focused') };
      });
      check('auto split goes side by side', layout.side, true);
      check('new pane has the focus', layout.focusedRight, true);
      check('focused pane is outlined', layout.border, true);
      await s.page.keyboard.press('Alt+Shift+Minus');
      await until(async () => (await tabInfo(s)).panes === 3, { label: '3 panes' });
      await waitReady(s);
      const stacked = await TM(s, (app) => {
        const l = app.active.tree.leaves().map((x) => x.el.getBoundingClientRect());
        return Math.abs(l[1].left - l[2].left) < 2 && l[2].top > l[1].top;
      });
      check('Alt+Shift+- splits down', stacked, true);
      const idx = () => TM(s, (app) => app.active.tree.sessions().indexOf(app.session));
      await s.page.keyboard.press('Alt+ArrowUp');
      await sleep(100);
      check('Alt+Up -> pane above', await idx(), 1);
      await s.page.keyboard.press('Alt+ArrowLeft');
      await sleep(100);
      check('Alt+Left -> left pane', await idx(), 0);
      await typeLine(s, 'echo left-pane');
      await waitText(s, /^left-pane$/m, { pane: 0 });
      check('typing goes to the focused pane', /^left-pane$/m.test(await buffer(s, 0)), true);
      check('…and not to the others', /^left-pane$/m.test(await buffer(s, 1)), false);
      const before = await TM(s, (app) => app.active.tree.root.ratio);
      await s.page.keyboard.press('Alt+Shift+ArrowRight');
      await sleep(100);
      check('Alt+Shift+Right grows the pane', await TM(s, (app) => app.active.tree.root.ratio), (r) => r > before);
      // each pane's PTY has its own size
      await typeLine(s, 'stty size');
      const sz = await TM(s, (app) => `${app.session.term.rows} ${app.session.term.cols}`);
      await waitText(s, new RegExp(`^${sz}$`, 'm'), { pane: 0 });
      check('left pane PTY size', new RegExp(`^${sz}$`, 'm').test(await buffer(s, 0)), true);
      await shot(s, 'split-dark');
      await s.page.keyboard.press('Control+Shift+W');
      await until(async () => (await tabInfo(s)).panes === 2, { label: 'pane closed' });
      check('Ctrl+Shift+W closes the pane, not the tab', (await tabInfo(s)).count, 1);
      await TM(s, (app) => app.closeSession(app.active.tree.sessions()[1], { force: true }));
      await until(async () => (await tabInfo(s)).panes === 1, { label: 'one pane' });
      check('no pane outline with a single pane', await run(s, `document.querySelector('${WIN} .tm-view.active').classList.contains('multi') || !!document.querySelector('${WIN} .tm-view.active .tm-pane.focused')`), false);
    });

    await section('ui', 'copy and paste', async () => {
      await typeLine(s, 'clear; echo copytest-$((40+2))');
      await waitText(s, /^copytest-42$/m);
      // select the output line with the mouse (drag over it)
      const r = await TM(s, (app) => {
        const b = app.session.term.buffer.active;
        let row = -1;
        for (let y = 0; y < b.length; y++) if (b.getLine(y).translateToString(true) === 'copytest-42') row = y - b.viewportY;
        const screen = app.session.el.querySelector('.xterm-screen').getBoundingClientRect();
        const cw = screen.width / app.session.term.cols;
        const ch = screen.height / app.session.term.rows;
        return { x: screen.left, y: screen.top + (row + 0.5) * ch, cw };
      });
      await s.page.mouse.move(r.x + 2, r.y);
      await s.page.mouse.down();
      await s.page.mouse.move(r.x + r.cw * 11 - 2, r.y, { steps: 5 });
      await s.page.mouse.up();
      check('mouse selection', await TM(s, (app) => app.session.term.getSelection()), 'copytest-42');
      await s.page.keyboard.press('Control+Shift+C');
      await until(async () => (await run(s, `window.aurora.invoke('clipboard:readText')`)) === 'copytest-42', { label: 'clipboard' });
      check('Ctrl+Shift+C copies', await run(s, `window.aurora.invoke('clipboard:readText')`), 'copytest-42');
      await run(s, `window.aurora.invoke('clipboard:writeText', 'x'); 0`);
      await s.page.keyboard.press('Control+c');
      await until(async () => (await run(s, `window.aurora.invoke('clipboard:readText')`)) === 'copytest-42', { label: 'Ctrl+C copies selection' });
      check('Ctrl+C with a selection copies (and clears it)', await TM(s, (app) => app.session.term.hasSelection()), false);
      check('…and does not interrupt', /\^C/.test(await buffer(s)), false);
      await run(s, `window.aurora.invoke('clipboard:writeText', 'echo pasted-$((6*7))'); 0`);
      await focusTerm(s);
      await s.page.keyboard.press('Control+Shift+V');
      await sleep(150);
      await s.page.keyboard.press('Enter');
      await waitText(s, /^pasted-42$/m);
      check('Ctrl+Shift+V pastes', /^pasted-42$/m.test(await buffer(s)), true);
      // copy on select (setting): a mouse selection is copied; Select all and the find box are not
      await TM(s, (app) => app.prefs.set('copyOnSelect', true));
      await mouseSelect(s, 'pasted-42');
      await until(async () => (await run(s, `window.aurora.invoke('clipboard:readText')`)) === 'pasted-42', { label: 'copy on select' });
      check('copy on select', await run(s, `window.aurora.invoke('clipboard:readText')`), 'pasted-42');
      await run(s, `window.aurora.invoke('clipboard:writeText', 'keep-me'); 0`);
      await TM(s, (app) => app.session.selectAll());
      await TM(s, (app) => {
        app.find.open(app.session);
        app.find.input.value = 'pasted';
        app.find.run({ keepIndex: false });
      });
      await sleep(400);
      check('find matches and Select all leave the clipboard alone', await run(s, `window.aurora.invoke('clipboard:readText')`), 'keep-me');
      await TM(s, (app) => app.find.close());
      await TM(s, (app) => app.session.term.clearSelection());
      await TM(s, (app) => app.prefs.set('copyOnSelect', false));
      // multi-line paste without bracketed paste mode asks first (sh -c 'cat' has no bracketed paste)
      await typeLine(s, "sh -c 'IFS= read -r a; IFS= read -r b; echo \"[$a+$b]\"'");
      await until(() => TM(s, (app) => app.session.busy), { label: 'sh running' });
      await run(s, `window.aurora.invoke('clipboard:writeText', 'one\\ntwo\\n'); 0`);
      await focusTerm(s);
      await s.page.keyboard.press('Control+Shift+V');
      await until(() => dialogOpen(s), { label: 'paste warning' });
      check('multi-line paste warning', await dialogText(s), (t) => /2 lines/.test(t));
      await dialogButton(s, 'Paste anyway');
      await waitText(s, /^\[one\+two\]$/m);
      check('pasted both lines', /^\[one\+two\]$/m.test(await buffer(s)), true);
      // middle click pastes the X11 PRIMARY selection (selecting text sets it)
      await run(s, `window.aurora.invoke('pty:primaryWrite', 'echo primary-$((2*21))'); 0`);
      const mid = await run(s, `(() => { const r = document.querySelector('${WIN} .tm-view.active .xterm-screen').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height - 20 }; })()`);
      await s.page.mouse.click(mid.x, mid.y, { button: 'middle' });
      await sleep(200);
      await focusTerm(s);
      await s.page.keyboard.press('Enter');
      await waitText(s, /^primary-42$/m);
      check('middle click pastes PRIMARY', /^primary-42$/m.test(await buffer(s)), true);
      await mouseSelect(s, 'primary-42');
      await until(async () => (await run(s, `window.aurora.invoke('pty:primaryRead')`)) === 'primary-42', { label: 'selection -> PRIMARY' });
      check('selecting sets PRIMARY', await run(s, `window.aurora.invoke('pty:primaryRead')`), 'primary-42');
      // dropping text inserts it at the prompt
      await run(
        s,
        `(() => { const dt = new DataTransfer(); dt.setData('text/plain', 'echo dropped-ok'); const t = document.querySelector('${WIN} .tm-view.active .xterm-screen'); t.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true })); t.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); return 0; })()`,
      );
      await sleep(150);
      await s.page.keyboard.press('Enter');
      await waitText(s, /^dropped-ok$/m);
      check('drop inserts the text', /^dropped-ok$/m.test(await buffer(s)), true);
    });

    await section('ui', 'context menu', async () => {
      await focusTerm(s);
      const box = await run(s, `(() => { const r = document.querySelector('${WIN} .tm-view.active .xterm-screen').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
      await s.page.mouse.click(box.x, box.y, { button: 'right' });
      await until(() => run(s, `!!document.querySelector('body > .menu.tm-menu')`), { label: 'context menu' });
      const labels = await menuLabels(s);
      for (const l of ['Copy', 'Paste', 'Select all', 'Find…', 'Clear buffer', 'Split pane', 'Close tab']) check(`context menu has ${l}`, labels.includes(l), true);
      check('Copy disabled without a selection', await run(s, `[...document.querySelectorAll('body > .menu .menu-item')].find((e) => e.textContent.includes('Copy')).classList.contains('disabled')`), true);
      await shot(s, 'context-menu-dark');
      await s.page.locator('body > .menu .menu-item', { hasText: 'Select all' }).click();
      await sleep(100);
      check('Select all', await TM(s, (app) => app.session.term.getSelection().includes('pasted-42')), true);
      await s.page.mouse.click(box.x, box.y, { button: 'right' });
      await until(() => run(s, `!!document.querySelector('body > .menu.tm-menu')`), { label: 'context menu 2' });
      await s.page.locator('body > .menu .menu-item', { hasText: 'Split pane' }).hover();
      await until(async () => (await menuLabels(s)).includes('Split right'), { label: 'submenu' });
      await s.page.locator('body > .menu .menu-item', { hasText: 'Split down' }).click();
      await until(async () => (await tabInfo(s)).panes === 2, { label: 'split from menu' });
      await waitReady(s);
      check('vertical stack from Split down', await TM(s, (app) => app.active.tree.root.dir), 'col');
      await TM(s, (app) => app.closeSession(app.session, { force: true }));
      await until(async () => (await tabInfo(s)).panes === 1, { label: 'back to one pane' });
      await s.page.mouse.click(box.x, box.y, { button: 'right' });
      await until(() => run(s, `!!document.querySelector('body > .menu.tm-menu')`), { label: 'context menu 3' });
      await s.page.locator('body > .menu .menu-item', { hasText: 'Clear buffer' }).click();
      await sleep(300);
      check('Clear buffer empties the scrollback', await buffer(s), (t) => !t.includes('copytest'));
    });

    await section('ui', 'find', async () => {
      await typeLine(s, 'for i in 1 2 3; do echo "needle-$i"; done; echo NEEDLE-upper');
      await waitText(s, /^NEEDLE-upper$/m);
      await s.page.keyboard.press('Control+Shift+F');
      await until(() => run(s, `!!document.querySelector('${WIN} .tm-find:not([hidden]) input:focus')`), { label: 'find box focused' });
      await s.page.keyboard.type('needle-');
      await until(async () => /of/.test(await run(s, `document.querySelector('${WIN} .tm-find-count').textContent`)), { label: 'count' });
      const count = () => run(s, `document.querySelector('${WIN} .tm-find-count').textContent`);
      // command line (needle- and NEEDLE-) + 3 outputs + the upper-case output (case-insensitive) = 6
      check('matches (case-insensitive)', await count(), (c) => /of 6$/.test(c));
      check('current match is selected', await TM(s, (app) => app.session.term.getSelection().toLowerCase()), 'needle-');
      check('matches are highlighted', await run(s, `document.querySelectorAll('${WIN} .xterm-decoration').length`), (n) => n >= 6);
      await shot(s, 'find-dark');
      await s.page.click(`${WIN} .tm-find-case`);
      await sleep(200);
      check('match case', await count(), (c) => /of 4$/.test(c));
      await s.page.click(`${WIN} .tm-find-re`);
      await s.page.fill(`${WIN} .tm-find-input`, 'needle-[23]$');
      await sleep(300);
      check('regular expression', await count(), (c) => /of 2$/.test(c));
      const first = await count();
      await s.page.keyboard.press('Enter');
      await sleep(80);
      check('Enter = next', await count(), (c) => c !== first);
      await s.page.fill(`${WIN} .tm-find-input`, 'needle-[');
      await sleep(300);
      check('invalid regex', await count(), 'Invalid pattern');
      await s.page.fill(`${WIN} .tm-find-input`, 'zzz-not-there');
      await sleep(300);
      check('no results', await count(), 'No results');
      await s.page.keyboard.press('Escape');
      await sleep(100);
      check('Esc closes and gives the focus back', await run(s, `!!document.querySelector('${WIN} .tm-find[hidden]') && document.activeElement.classList.contains('xterm-helper-textarea')`), true);
      check('decorations removed', await run(s, `document.querySelectorAll('${WIN} .xterm-decoration').length`), 0);
      await TM(s, (app) => {
        app.find.caseSensitive = false;
        app.find.regex = false;
        app.find.caseBtn.classList.remove('on');
        app.find.reBtn.classList.remove('on');
      });
      // With the find box open but the keyboard in the terminal, Esc belongs to the program (vim!).
      await s.page.keyboard.press('Control+Shift+F');
      await sleep(150);
      await typeLine(s, 'clear; cat -v');
      await until(() => TM(s, (app) => app.session.busy), { label: 'cat running' });
      await s.page.keyboard.press('Escape');
      await s.page.keyboard.press('Enter');
      await waitText(s, /^\^\[$/m);
      check('Esc reaches the program', /^\^\[$/m.test(await buffer(s)), true);
      check('find box still open', await run(s, `!!document.querySelector('${WIN} .tm-find:not([hidden])')`), true);
      await s.page.keyboard.press('Control+d');
      await until(() => TM(s, (app) => !app.session.busy), { label: 'cat ended' });
      await TM(s, (app) => app.find.close());
    });

    await section('ui', 'font zoom', async () => {
      const fs0 = await TM(s, (app) => app.session.term.options.fontSize);
      await focusTerm(s);
      await s.page.keyboard.press('Control+Equal');
      await sleep(100);
      check('Ctrl+= zooms in', await TM(s, (app) => app.session.term.options.fontSize), fs0 + 1);
      check('font size toast', await run(s, `document.querySelector('${WIN} .tm-toast').textContent`), `Font size ${fs0 + 1}`);
      await s.page.keyboard.press('Control+Minus');
      await s.page.keyboard.press('Control+Minus');
      await sleep(100);
      check('Ctrl+- zooms out', await TM(s, (app) => app.session.term.options.fontSize), fs0 - 1);
      await s.page.keyboard.press('Control+0');
      await sleep(100);
      check('Ctrl+0 resets', await TM(s, (app) => app.session.term.options.fontSize), fs0);
    });

    await section('ui', 'colour schemes: follow system theme, explicit scheme, opacity', async () => {
      const bg = () => TM(s, (app) => ({ term: app.session.term.options.theme.background, scheme: app.scheme.id, view: getComputedStyle(app.active.view).backgroundColor }));
      check('dark mode -> One Half Dark', (await bg()).scheme, 'one-half-dark');
      check('terminal background', (await bg()).term, '#282C34');
      await run(s, `window.__aurora.settings.set('theme', 'light')`);
      await until(async () => (await bg()).scheme === 'one-half-light', { label: 'light scheme' });
      check('light mode -> One Half Light', (await bg()).term, '#FAFAFA');
      check('pane background follows', (await bg()).view, 'rgb(250, 250, 250)');
      await run(s, `window.__aurora.settings.set('theme', 'dark')`);
      await until(async () => (await bg()).scheme === 'one-half-dark', { label: 'dark scheme' });
      await TM(s, (app) => app.prefs.set('scheme', 'campbell'));
      await sleep(100);
      check('explicit scheme ignores the system theme', (await bg()).term, '#0C0C0C');
      await TM(s, (app) => app.prefs.set('opacity', 70));
      await sleep(100);
      check('opacity -> translucent background', (await bg()).view, 'rgba(12, 12, 12, 0.7)');
      await TM(s, (app) => app.prefs.set('acrylic', true));
      await sleep(100);
      // Windows never blur live (blur is reserved for the bar, the Lanceur and the panels): with the acrylic option the
      // window surface stays opaque in the Sobre theme, and is the theme's pre-blurred glass (Mica-like) in Halo / Prisme.
      const finish = await run(s, `document.documentElement.dataset.finish`);
      check('acrylic option: no window blur', await run(s, `getComputedStyle(document.querySelector('${WIN}')).backdropFilter`), (v) => !/blur/.test(v));
      check(`acrylic option: window surface opaque (Sobre) or theme glass (${finish})`, await run(s, `getComputedStyle(document.querySelector('${WIN}')).backgroundColor`), (v) => (finish === 'sobre' ? /^rgb\(/.test(v) : /^rgba?\(/.test(v)));
      await TM(s, (app) => {
        app.prefs.set('acrylic', false);
        app.prefs.set('opacity', 100);
        app.prefs.set('scheme', 'system');
      });
      await sleep(400);
      const saved = JSON.parse(fs.readFileSync(path.join(home, '.config/aurora/apps/terminal/prefs.json'), 'utf8'));
      check('settings persisted with ctx.storage', saved.scheme, 'system');
    });

    await section('ui', 'settings tab', async () => {
      await focusTerm(s);
      await s.page.keyboard.press('Control+Comma');
      await until(async () => (await tabInfo(s)).titles.includes('Settings'), { label: 'settings tab' });
      const ti = await tabInfo(s);
      check('settings opens as a tab', ti.titles[ti.active], 'Settings');
      check('left navigation', await run(s, `[...document.querySelectorAll('${WIN} .tm-set-nav .nav-item')].map((e) => e.textContent)`), ['Startup', 'Interaction', 'Appearance', 'Color schemes', 'Advanced']);
      await s.page.keyboard.press('Control+Comma');
      await sleep(100);
      check('Ctrl+, again does not open a second one', (await tabInfo(s)).count, ti.count);
      await shot(s, 'settings-dark');
      // Appearance: cursor shape, font size, scheme select
      await s.page.click(`${WIN} .tm-set-nav [data-section="appearance"]`);
      await sleep(300);
      await s.page.locator(`${WIN} .tm-cursor-opt`, { hasText: 'Filled box' }).click();
      check('cursor shape -> block', await TM(s, (app) => app.tabs[0].session.term.options.cursorStyle), 'block');
      await s.page.locator(`${WIN} [data-setting="fontSize"] button[aria-label="Increase"]`).click();
      check('font size +1', await TM(s, (app) => app.tabs[0].session.term.options.fontSize), 15);
      await s.page.selectOption(`${WIN} select[data-key="scheme"]`, 'solarized-dark');
      await sleep(100);
      check('scheme select', await TM(s, (app) => app.tabs[0].session.term.options.theme.background), '#002B36');
      await shot(s, 'settings-appearance-dark');
      await s.page.click(`${WIN} .tm-set-nav [data-section="schemes"]`);
      await sleep(300);
      check('scheme cards', await run(s, `document.querySelectorAll('${WIN} .tm-scheme-card').length`), 9);
      check('selected card', await run(s, `document.querySelector('${WIN} .tm-scheme-card.selected').dataset.scheme`), 'solarized-dark');
      await s.page.click(`${WIN} .tm-scheme-card[data-scheme="tango-dark"]`);
      check('card click applies', await TM(s, (app) => app.prefs.get('scheme')), 'tango-dark');
      await shot(s, 'settings-schemes-dark');
      await s.page.click(`${WIN} .tm-set-nav [data-section="interaction"]`);
      await sleep(300);
      check('interaction rows', await run(s, `document.querySelectorAll('${WIN} .tm-set-row').length`), 6);
      await s.page.click(`${WIN} .tm-set-nav [data-section="advanced"]`);
      await sleep(300);
      await s.page.locator(`${WIN} [data-setting="reset"] .btn`).click();
      await dialogButton(s, 'Reset');
      check('reset to defaults', await TM(s, (app) => [app.prefs.get('scheme'), app.prefs.get('fontSize'), app.prefs.get('cursorShape')]), ['system', 14, 'bar']);
      // default profile: new tabs open Python
      await s.page.click(`${WIN} .tm-set-nav [data-section="startup"]`);
      await sleep(300);
      await s.page.selectOption(`${WIN} select[data-key="defaultProfile"]`, 'python');
      check('default profile saved', await TM(s, (app) => app.prefs.get('defaultProfile')), 'python');
      const before = (await tabInfo(s)).count;
      await s.page.keyboard.press('Control+Shift+T');
      await until(async () => (await tabInfo(s)).count === before + 1, { label: 'new tab' });
      await waitText(s, /^>>> *$/m, { timeout: 10000 });
      check('new tab uses the default profile', await TM(s, (app) => app.session.profile.id), 'python');
      await TM(s, (app) => app.closeTab(app.active, { force: true }));
      await TM(s, (app) => app.prefs.set('defaultProfile', 'shell'));
      await TM(s, (app) => app.openSettings());
      await sleep(200);
      // keyboard navigation in the settings nav
      await s.page.click(`${WIN} .tm-set-nav [data-section="startup"]`);
      await s.page.keyboard.press('ArrowDown');
      await sleep(200);
      check('arrow keys move in the nav', await run(s, `document.querySelector('${WIN} .tm-set-nav .nav-item.selected').dataset.section`), 'interaction');
      await s.page.keyboard.press('Control+Shift+W');
      await until(async () => (await tabInfo(s)).count === 1, { label: 'settings closed' });
    });

    await section('ui', 'links open in the browser', async () => {
      await run(s, `window.__opened = []; window.__aurora.shell.__openUrl = window.__aurora.shell.openUrl; window.__aurora.shell.openUrl = (u) => { window.__opened.push(u); }; 0`);
      await typeLine(s, 'clear; echo "see https://example.com/aurora?x=1 now"');
      await waitText(s, /^see https:\/\/example\.com\/aurora\?x=1 now$/m);
      const p = await TM(s, (app) => {
        const b = app.session.term.buffer.active;
        let row = -1;
        for (let y = 0; y < b.length; y++) if (b.getLine(y).translateToString(true).startsWith('see https')) row = y - b.viewportY;
        const screen = app.session.el.querySelector('.xterm-screen').getBoundingClientRect();
        return { x: screen.left + (screen.width / app.session.term.cols) * 12.5, y: screen.top + (row + 0.5) * (screen.height / app.session.term.rows) };
      });
      await s.page.mouse.move(p.x - 30, p.y);
      await s.page.mouse.move(p.x, p.y, { steps: 4 });
      await until(() => run(s, `!!document.querySelector('${WIN} .tm-linktip')`), { label: 'link tooltip' });
      check('link tooltip shows the URL', await run(s, `document.querySelector('${WIN} .tm-linktip-url').textContent`), 'https://example.com/aurora?x=1');
      await s.page.mouse.click(p.x, p.y);
      await until(() => run(s, `window.__opened.length > 0`), { label: 'openUrl' });
      check('shell.openUrl called', await run(s, `window.__opened[0]`), 'https://example.com/aurora?x=1');
      await run(s, `window.__aurora.shell.openUrl = window.__aurora.shell.__openUrl; 0`);
      await s.page.mouse.move(10, 10);
    });

    await section('ui', 'security: pasted escape sequences, OSC 8 targets, program titles', async () => {
      // An embedded "ESC [201~" must not end bracketed paste and run the rest as a command.
      await typeLine(s, 'clear');
      await waitText(s, /[$#] *$/m);
      check('bash uses bracketed paste', await TM(s, (app) => app.session.term.modes.bracketedPasteMode), true);
      await run(s, `window.aurora.invoke('clipboard:writeText', 'echo safe\\x1b[201~echo INJECTED-$((1+1))\\r'); 0`);
      await TM(s, (app) => app.session.paste());
      await sleep(700);
      check('paste injection did not run', /^INJECTED-2$/m.test(await buffer(s)), false);
      check('…the text stayed on the command line', /echo safeecho INJECTED/.test(await buffer(s)), true);
      await focusTerm(s);
      await s.page.keyboard.press('Control+c');
      await sleep(200);
      // Control characters in pasted text are dropped (tabs and line breaks stay).
      check('sanitizePaste', await run(s, `import('app://shell/apps/terminal/lib/session.js').then((m) => JSON.stringify(m.sanitizePaste('a\\x1b[31mb\\x07c\\td\\x9be\\x7ff\\r\\ng')))`), JSON.stringify('a[31mbc\tde' + 'f\r\ng'));
      // A large paste asks first (Windows Terminal: more than 5 KiB).
      await run(s, `window.aurora.invoke('clipboard:writeText', 'echo ' + 'x'.repeat(6000)); 0`);
      await focusTerm(s);
      await s.page.keyboard.press('Control+Shift+V');
      await until(() => dialogOpen(s), { label: 'large paste warning' });
      check('large paste warning', await dialogText(s), (t) => /large amount of text/.test(t) && /5 KB/.test(t));
      await dialogButton(s, 'Cancel');
      check('cancelled: nothing pasted', /xxxxxxxxxx/.test(await buffer(s)), false);
      // OSC 8 hyperlink whose text differs from its target: hovering shows the real target.
      await run(s, `window.__opened = []; window.__aurora.shell.__openUrl = window.__aurora.shell.openUrl; window.__aurora.shell.openUrl = (u) => { window.__opened.push(u); }; 0`);
      await typeLine(s, `clear; printf '\\033]8;;https://evil.example/x\\033\\\\click here please\\033]8;;\\033\\\\\\n'`);
      await waitText(s, /^click here please$/m);
      const p = await TM(s, (app) => {
        const b = app.session.term.buffer.active;
        let row = -1;
        for (let y = 0; y < b.length; y++) if (b.getLine(y).translateToString(true) === 'click here please') row = y - b.viewportY;
        const screen = app.session.el.querySelector('.xterm-screen').getBoundingClientRect();
        return { x: screen.left + (screen.width / app.session.term.cols) * 3.5, y: screen.top + (row + 0.5) * (screen.height / app.session.term.rows) };
      });
      await s.page.mouse.move(p.x + 40, p.y + 60);
      await s.page.mouse.move(p.x, p.y, { steps: 6 });
      await until(() => run(s, `!!document.querySelector('${WIN} .tm-linktip')`), { label: 'OSC 8 tooltip' });
      check('OSC 8 tooltip shows the real target', await run(s, `document.querySelector('${WIN} .tm-linktip-url').textContent`), 'https://evil.example/x');
      await s.page.mouse.click(p.x, p.y);
      await until(() => run(s, `window.__opened.length > 0`), { label: 'OSC 8 open' });
      check('OSC 8 click opens the target', await run(s, `window.__opened[0]`), 'https://evil.example/x');
      await run(s, `window.__aurora.shell.openUrl = window.__aurora.shell.__openUrl; 0`);
      await s.page.mouse.move(10, 10);
      await sleep(100);
      check('tooltip hidden on leave', await run(s, `!!document.querySelector('${WIN} .tm-linktip')`), false);
      // Titles set by programs: HTML stays text, control and bidi-override characters are removed.
      await typeLine(s, `clear; printf '\\033]0;<img src=x onerror="window.__xss=1">\\a'; sleep 1; echo title-$((1+1))`);
      await until(async () => (await tabInfo(s)).titles[0].startsWith('<img'), { label: 'html title' });
      check('HTML title is shown as text', await run(s, `!window.__xss && !document.querySelector('img[src="x"]')`), true);
      await waitText(s, /^title-2$/m, { timeout: 5000 });
      await typeLine(s, `clear; printf '\\033]0;abc\\u202Eevil\\a'; sleep 1; echo title-$((1+2))`);
      await until(async () => /^abc/.test((await tabInfo(s)).titles[0]), { label: 'bidi title' });
      check('bidi override stripped from the title', (await tabInfo(s)).titles[0], 'abcevil');
      await waitText(s, /^title-3$/m, { timeout: 5000 });
    });

    await section('ui', 'dialogs own the keyboard: no shortcuts behind a dialog', async () => {
      await typeLine(s, 'clear; sleep 30');
      await until(() => TM(s, (app) => app.session.busy), { label: 'busy' });
      await s.page.keyboard.press('Control+Shift+W');
      await until(() => dialogOpen(s), { label: 'confirm' });
      await sleep(100);
      const n = (await tabInfo(s)).count;
      await s.page.keyboard.press('Control+Shift+T');
      await s.page.keyboard.press('Control+Shift+W');
      await s.page.keyboard.press('Control+Tab');
      await sleep(500);
      check('no new tab opened behind the dialog', (await tabInfo(s)).count, n);
      check('no second dialog', await run(s, `document.querySelectorAll('${WIN} > .dialog-layer:not(.closing)').length`), 1);
      check('the dialog keeps the focus', await run(s, `!!document.activeElement.closest('${WIN} > .dialog-layer')`), true);
      const tabbed = [];
      for (const key of ['Tab', 'Tab', 'Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab']) {
        await s.page.keyboard.press(key);
        tabbed.push(await run(s, `!!document.activeElement.closest('${WIN} > .dialog-layer')`));
      }
      check('Tab and Shift+Tab cycle inside the dialog', tabbed, [true, true, true, true, true, true]);
      await dialogButton(s, 'Cancel');
      check('cancel keeps the tab', (await tabInfo(s)).count, n);
      await focusTerm(s);
      await s.page.keyboard.press('Control+c');
      await until(() => TM(s, (app) => !app.session.busy), { label: 'sleep stopped' });
      // closing other tabs asks when one of them runs a program
      await s.page.keyboard.press('Control+Shift+T');
      await until(async () => (await tabInfo(s)).count === n + 1, { label: 'second tab' });
      await waitReady(s);
      await typeLine(s, 'sleep 40');
      await until(() => TM(s, (app) => app.session.busy), { label: 'busy 2' });
      await TM(s, (app) => {
        app.closeOtherTabs(app.tabs[0]); // (not awaited: it waits for the dialog)
      });
      await until(() => dialogOpen(s), { label: 'close others confirm' });
      await dialogButton(s, 'Cancel');
      check('close other tabs asked (running program)', (await tabInfo(s)).count, n + 1);
      await TM(s, (app, el, n) => app.closeTab(app.tabs[n], { force: true }), n);
      await until(async () => (await tabInfo(s)).count === n, { label: 'closed' });
    });

    await section('ui', 'find box: reopening does not stack listeners', async () => {
      const live = await TM(s, (app) => {
        const term = app.session.term;
        let n = 0;
        const orig = term.onWriteParsed; // (a getter on the prototype: shadow it on the instance)
        Object.defineProperty(term, 'onWriteParsed', {
          configurable: true,
          value: (fn) => {
            const d = orig(fn);
            n++;
            let live = true;
            return { dispose: () => (live && n--, (live = false), d.dispose()) };
          },
        });
        for (let i = 0; i < 4; i++) app.find.open(app.session);
        const open = n;
        app.find.close();
        delete term.onWriteParsed;
        return [open, n];
      });
      check('one write listener while open, none after closing', live, [1, 0]);
    });

    await section('ui', 'exit: readable message, title reset, spawn failure hint', async () => {
      await TM(s, (app) => app.prefs.set('closeOnExit', 'never'));
      await s.page.keyboard.press('Control+Shift+T');
      await until(async () => (await tabInfo(s)).count === 2, { label: 'tab' });
      await waitReady(s);
      await typeLine(s, 'exit');
      await waitText(s, /process exited with code 0/);
      const attrs = await TM(s, (app) => {
        const b = app.session.term.buffer.active;
        for (let y = 0; y < b.length; y++) {
          const line = b.getLine(y);
          if (line.translateToString(true).startsWith('[process exited')) {
            const c = line.getCell(1);
            return { def: c.isFgDefault(), title: app.active.titleEl.textContent };
          }
        }
        return null;
      });
      check('exit message in the default colour (readable)', attrs?.def, true);
      check('exited tab shows the profile name, not the last command', attrs?.title, 'Bash');
      await focusTerm(s);
      await s.page.keyboard.press('Control+d');
      await until(async () => (await tabInfo(s)).count === 1, { label: 'Ctrl+D closed' });
      await TM(s, (app) => app.prefs.set('closeOnExit', 'graceful'));
      // the helper cannot start: the error, how to retry, and Enter retries
      await TM(s, (app) => {
        app.__invoke = app.ctx.api.invoke;
        app.ctx.api.invoke = (ch, ...a) => (ch === 'pty:spawn' ? Promise.reject(new Error('helper missing')) : app.__invoke.call(app.ctx.api, ch, ...a));
      });
      await TM(s, (app) => app.newTab());
      await waitText(s, /could not start: helper missing/);
      check('spawn failure explains how to retry', /press Enter to restart/.test(await buffer(s)), true);
      check('…and the tab is marked as exited', await TM(s, (app) => app.active.el.classList.contains('exited')), true);
      await TM(s, (app) => (app.ctx.api.invoke = app.__invoke));
      await focusTerm(s);
      await s.page.keyboard.press('Enter');
      await waitReady(s);
      check('Enter retries', await TM(s, (app) => app.session.state), 'running');
      await TM(s, (app) => app.closeTab(app.active, { force: true }));
      await until(async () => (await tabInfo(s)).count === 1, { label: 'back to one tab' });
    });

    await section('ui', 'export text from the tab menu', async () => {
      await typeLine(s, 'clear; echo export-marker-$((6*7))');
      await waitText(s, /^export-marker-42$/m);
      const tb = await run(s, `(() => { const r = document.querySelector('${WIN} .tm-tab.active').getBoundingClientRect(); return { x: r.x + 40, y: r.y + r.height / 2 }; })()`);
      await s.page.mouse.click(tb.x, tb.y, { button: 'right' });
      await until(async () => (await menuLabels(s)).includes('Export text…'), { label: 'tab menu' });
      check('tab menu has Find…', (await menuLabels(s)).includes('Find…'), true);
      await s.page.locator('body > .menu .menu-item', { hasText: 'Export text…' }).click();
      await until(() => run(s, `!!document.querySelector('${WIN} > .dialog-layer .fp-bottom input')`), { label: 'save dialog' });
      check('suggested name', await run(s, `document.querySelector('${WIN} > .dialog-layer .fp-bottom input').value`), (v) => /\.txt$/.test(v));
      await s.page.fill(`${WIN} > .dialog-layer .fp-bottom input`, 'terminal-export.txt');
      await s.page.locator(`${WIN} > .dialog-layer .dialog-footer .btn.primary`).click();
      const file = path.join(home, 'Documents', 'terminal-export.txt');
      // the file appears before its write has finished: wait for the content, not just the name
      await until(() => fs.existsSync(file) && /export-marker-42/.test(fs.readFileSync(file, 'utf8')), { label: 'exported file' });
      check('exported buffer', fs.readFileSync(file, 'utf8'), (t) => /^export-marker-42$/m.test(t) && t.endsWith('\n'));
      await until(() => run(s, `!document.querySelector('${WIN} > .dialog-layer:not(.closing)')`), { label: 'dialog closed' });
    });

    await section('ui', 'settings: starting directory must be a folder, ~ works; launch cwd', async () => {
      await TM(s, (app) => app.openSettings('startup'));
      await sleep(300);
      await s.page.fill(`${WIN} .tm-dir`, '/etc/passwd');
      await s.page.keyboard.press('Enter');
      await until(() => dialogOpen(s), { label: 'not a folder' });
      check('a file is refused', await dialogText(s), (t) => /not an existing folder/.test(t));
      await dialogButton(s, 'OK');
      check('setting unchanged', await TM(s, (app) => app.prefs.get('startDir')), '');
      await s.page.fill(`${WIN} .tm-dir`, '~/Documents');
      await s.page.keyboard.press('Enter');
      await sleep(300);
      check('~/Documents accepted', await TM(s, (app) => app.prefs.get('startDir')), '~/Documents');
      await s.page.keyboard.press('Control+Shift+T');
      await waitReady(s);
      await typeLine(s, 'pwd');
      await waitText(s, new RegExp(`^${home}/Documents$`, 'm'));
      check('new tab starts in ~/Documents', new RegExp(`^${home}/Documents$`, 'm').test(await buffer(s)), true);
      await TM(s, (app) => app.prefs.set('startDir', ''));
      await TM(s, (app) => {
        for (const t of [...app.tabs].slice(1)) app.closeTab(t, { force: true });
      });
      await until(async () => (await tabInfo(s)).count === 1, { label: 'one tab' });
      // launch arguments: '~/…' and paths relative to home; junk is ignored
      const n = await winCount(s);
      for (const [cwd, want] of [['~/Music', `${home}/Music`], ['Projects', `${home}/Projects`], [42, home]]) {
        await openTerminal(s, { cwd, command: cwd === 42 ? 42 : undefined });
        await typeLine(s, 'pwd');
        await waitText(s, new RegExp(`^${want}$`, 'm'));
        check(`launch cwd ${JSON.stringify(cwd)}`, new RegExp(`^${want}$`, 'm').test(await buffer(s)), true);
        await TM(s, (app) => app.win.close(true));
        await until(async () => (await winCount(s)) === n, { label: 'closed' });
      }
    });

    await section('ui', 'backend: the IPC event is never taken from the arguments', async () => {
      const id = await run(s, `window.aurora.invoke('pty:spawn')`);
      check('pty:spawn without options still works', id, (v) => /^pty\d+$/.test(v));
      check('pty:info with extra arguments', await run(s, `window.aurora.invoke('pty:info', ${JSON.stringify(id)}, 'x', 'y').then((r) => typeof r.pid)`), 'number');
      check('pty:resize with missing arguments uses defaults', await run(s, `window.aurora.invoke('pty:resize', ${JSON.stringify(id)}).then((r) => r, (e) => e.message)`), true);
      check('unknown terminal', await run(s, `window.aurora.invoke('pty:resize', 'pty999999', 80, 24).then(() => 'ok', (e) => e.code || e.message)`), (v) => /ENOENT|No terminal/.test(v));
      check('pty:kill', await run(s, `window.aurora.invoke('pty:kill', ${JSON.stringify(id)})`), true);
      const fonts = await run(s, `window.aurora.invoke('pty:fonts')`);
      check('pty:fonts lists installed monospace fonts', fonts, (f) => Array.isArray(f) && f.includes('DejaVu Sans Mono') && !f.some((x) => /emoji/i.test(x)));
      check('the font face list offers only installed fonts', await TM(s, (app) => {
        app.openSettings('appearance');
        const opts = [...app.win.el.querySelectorAll('select[data-key="fontFace"] option')].map((o) => o.value);
        app.closeTab(app.tabs.find((t) => t.kind === 'settings'));
        return opts.filter((f) => f !== app.prefs.get('fontFace') && !app.fonts.includes(f));
      }), []);
    });

    await section('ui', 'progress (OSC 9;4): ring on the tab, taskbar progress', async () => {
      await typeLine(s, "clear; printf '\\033]9;4;1;40\\a'");
      await until(() => TM(s, (app) => !app.active.progEl.hidden), { label: 'progress ring' });
      check('tab ring at 40 %', await TM(s, (app) => app.active.progEl.style.getPropertyValue('--p')), '40');
      check('taskbar button progress', await TM(s, (app) => app.win.progress), 0.4);
      await shot(s, 'progress-dark', { clip: true });
      await typeLine(s, "printf '\\033]9;4;2;70\\a'");
      await until(() => TM(s, (app) => app.active.progEl.classList.contains('s2')), { label: 'error state' });
      check('error state', await TM(s, (app) => app.win.progress), 0.7);
      await typeLine(s, "printf '\\033]9;4;0;0\\a'");
      await until(() => TM(s, (app) => app.active.progEl.hidden), { label: 'progress cleared' });
      check('taskbar progress cleared', await TM(s, (app) => app.win.progress), null);
      check('other OSC 9 sequences are ignored', await TM(s, (app) => app.session.onProgress('hello')), false);
    });

    await section('ui', 'bell: visual flash and tab badge', async () => {
      await typeLine(s, 'clear');
      await s.page.keyboard.press('Control+Shift+T');
      await until(async () => (await tabInfo(s)).count === 2, { label: '2 tabs' });
      await waitReady(s);
      await TM(s, (app) => app.activate(app.tabs[0]));
      await typeLine(s, "sleep 0.8; printf '\\a'");
      await TM(s, (app) => app.activate(app.tabs[1]));
      await until(() => run(s, `document.querySelector('${WIN} .tm-tab').classList.contains('bell')`), { label: 'bell badge', timeout: 4000 });
      check('background tab shows the bell', true, true);
      await TM(s, (app) => app.activate(app.tabs[0]));
      check('activating clears it', await run(s, `document.querySelector('${WIN} .tm-tab').classList.contains('bell')`), false);
      await TM(s, (app) => app.closeTab(app.tabs[1], { force: true }));
      await until(async () => (await tabInfo(s)).count === 1, { label: 'closed' });
    });

    await section('ui', 'launch arguments, new window, profile shortcuts, shared settings', async () => {
      const n = await winCount(s);
      await run(s, `window.__aurora.shell.launch('terminal', { cwd: '/tmp', command: 'pwd; echo from-args; sleep 30' }); 0`);
      await until(async () => (await winCount(s)) === n + 1, { label: 'window from args' });
      await waitText(s, /^from-args$/m, { timeout: 10000 });
      check('command and cwd from args', /^\/tmp\nfrom-args$/m.test(await buffer(s)), true);
      check('busy with the command', await until(() => TM(s, (app) => app.session.busy), { label: 'busy' }), true);
      await TM(s, (app) => app.win.close(true));
      await until(async () => (await winCount(s)) === n, { label: 'closed' });
      await openTerminal(s, { cwd: '/usr/share' });
      await typeLine(s, 'pwd');
      await waitText(s, /^\/usr\/share$/m);
      check('cwd from args', /^\/usr\/share$/m.test(await buffer(s)), true);
      // Ctrl+Shift+N opens another window; settings changed in one apply to the other.
      await focusTerm(s);
      await s.page.keyboard.press('Control+Shift+N');
      await until(async () => (await winCount(s)) === n + 2, { label: 'Ctrl+Shift+N' });
      await waitReady(s);
      check('new window', await winCount(s), n + 2);
      await TM(s, (app) => app.prefs.set('fontSize', 17));
      await sleep(100);
      check('settings shared by every window', await TM(s, (app) => app.session.term.options.fontSize, null, -2), 17);
      await TM(s, (app) => app.prefs.set('fontSize', 14));
      // Ctrl+Shift+2 = second profile (Python 3)
      await focusTerm(s);
      await s.page.keyboard.press('Control+Shift+Digit2');
      await until(async () => (await tabInfo(s)).count === 2, { label: 'python tab' });
      await waitText(s, /^>>> *$/m, { timeout: 10000 });
      check('Ctrl+Shift+2 opens Python', (await tabInfo(s)).titles[1], 'Python 3');
      // many tabs: the strip scrolls, with arrows, and the active tab stays visible
      // (enough tabs that their 48 px minimum width overflows the strip whatever the caption buttons take)
      for (let i = 0; i < 20; i++) await TM(s, (app) => app.newTab());
      await until(async () => (await tabInfo(s)).count === 22, { label: '22 tabs' });
      await sleep(400);
      const strip = await TM(s, (app) => {
        const t = app.tabsEl;
        const a = app.active.el.getBoundingClientRect();
        const box = t.getBoundingClientRect();
        return { over: t.scrollWidth > t.clientWidth, arrows: !app.scrollL.hidden && !app.scrollR.hidden, visible: a.left >= box.left - 1 && a.right <= box.right + 1 };
      });
      check('tab strip overflows', strip.over, true);
      check('scroll arrows shown', strip.arrows, true);
      check('active tab visible', strip.visible, true);
      await s.page.click(`${WIN}:last-of-type .tm-scroll-l`).catch(() => TM(s, (app) => app.scrollTabs(-1)));
      await sleep(500);
      check('left arrow scrolls', await TM(s, (app) => app.tabsEl.scrollLeft < app.tabsEl.scrollWidth - app.tabsEl.clientWidth - 1), true);
      await TM(s, (app) => app.win.close(true));
      await TM(s, (app) => app.win.close(true));
      await until(async () => (await winCount(s)) === n, { label: 'windows closed' });
    });

    await section('ui', 'closing the window asks when tabs or programs are running', async () => {
      await openTerminal(s);
      await s.page.keyboard.press('Control+Shift+T');
      await until(async () => (await tabInfo(s)).count === 2, { label: '2 tabs' });
      await waitReady(s);
      const n = await winCount(s);
      await TM(s, (app) => {
        app.win.close();
      });
      await until(() => dialogOpen(s), { label: 'confirm dialog' });
      check('confirm text', await dialogText(s), (t) => /close 2 tabs/.test(t));
      await shot(s, 'confirm-close-dark');
      await dialogButton(s, 'Cancel');
      check('cancel keeps the window', await winCount(s), n);
      await TM(s, (app) => app.closeTab(app.tabs[1], { force: true }));
      await typeLine(s, 'sleep 50');
      await until(() => TM(s, (app) => app.session.busy), { label: 'busy' });
      await TM(s, (app) => {
        app.win.close();
      });
      await until(() => dialogOpen(s), { label: 'running dialog' });
      check('running program named', await dialogText(s), (t) => /sleep/.test(t));
      await dialogButton(s, 'Close');
      await until(async () => (await winCount(s)) === n - 1, { label: 'window closed' });
      check('window closed', await winCount(s), n - 1);
    });

    await section('ui', 'minimum size and maximized layouts', async () => {
      await TM(s, (app) => app.win.setSize(100, 100));
      await sleep(400);
      const r = await TM(s, (app) => {
        const w = app.win.el.getBoundingClientRect();
        const strip = app.strip.getBoundingClientRect();
        const ctl = app.win.el.querySelector('.win-controls').getBoundingClientRect();
        // The strip is its own row under the title bar: it never reaches the window buttons and
        // never runs past the window's edge.
        return { w: Math.round(w.width), h: Math.round(w.height), cols: app.session.term.cols, rows: app.session.term.rows, overlap: strip.top < ctl.bottom - 1 || strip.right > w.right + 1 || app.dropBtn.getBoundingClientRect().right > w.right + 1 };
      });
      check('min width honoured', r.w, 420);
      check('min height honoured', r.h, 260);
      check('still a usable terminal', r.cols >= 40 && r.rows >= 8, true);
      check('tabs do not run under the window buttons', r.overlap, false);
      await typeLine(s, 'clear; ls --color=auto ~; echo "$COLUMNS x $LINES"');
      await waitText(s, / x /);
      await shot(s, 'minsize-dark', { clip: true });
      await TM(s, (app) => app.openSettings());
      await sleep(400);
      check('settings nav collapses to icons when narrow', await run(s, `getComputedStyle(document.querySelector('${WIN} .tm-set-nav')).width`), '56px');
      await shot(s, 'minsize-settings-dark', { clip: true });
      await TM(s, (app) => app.closeTab(app.tabs.find((t) => t.kind === 'settings')));
      await TM(s, (app) => app.win.setSize(980, 600));
      await TM(s, (app) => app.win.center());
      await sleep(300);
    });

    await section('ui', 'no console errors', async () => {
      check('console errors', errorsSince(s, mark0), []);
      check('no warnings from the terminal', s.logs.slice(mark0).filter((l) => /^\[warning\]/.test(l) && /terminal|xterm|icons\]/i.test(l)), []);
    });
  } finally {
    recover = null;
    await s.close();
    const left = terminalProcs(home);
    if (left.length) {
      await sleep(2500);
    }
    check('no terminal processes left after quitting the shell', terminalProcs(home), []);
    fs.rmSync(home, { recursive: true, force: true });
  }
}

async function orphanTests() {
  console.log('Open/close cycles');
  const home = makeHome();
  const s = await launchShell({ lang: 'en', theme: 'dark', home });
  try {
    await section('orphans', '10 open/close cycles leave no processes behind', async () => {
      for (let i = 0; i < 10; i++) {
        await openTerminal(s);
        // a second tab and a running job make each cycle a bit harder
        if (i % 2 === 0) {
          await s.page.keyboard.press('Control+Shift+T');
          await until(async () => (await tabInfo(s)).count === 2, { label: '2 tabs' });
          await waitReady(s);
          await typeLine(s, 'sleep 500 & sleep 400');
          await until(() => TM(s, (app) => app.session.busy), { label: 'busy' });
        }
        await TM(s, (app) => app.win.close(true));
        await until(async () => (await winCount(s)) === 0, { label: 'closed' });
      }
      await until(() => terminalProcs(home).length === 0, { label: 'processes gone', timeout: 8000 }).catch(() => {});
      check('no orphans (helpers, shells, jobs)', terminalProcs(home), []);
    });
    await section('orphans', '15 open/close cycles leak no listeners, nodes or sessions', async () => {
      const counts = () =>
        run(
          s,
          `import('app://shell/apps/terminal/lib/bus.js').then(({ bus }) => { const a = window.__aurora; const em = (e) => { let n = 0; for (const set of (e?._h?.values?.() || [])) n += set.size; return n; }; return { wm: em(a.wm), i18n: em(a.i18n), sessions: bus.size, nodes: document.getElementsByTagName('*').length, css: document.querySelectorAll('link[rel=stylesheet]').length, tips: document.querySelectorAll('.tooltip, .tm-linktip').length, menus: document.querySelectorAll('body > .menu').length }; })`,
        );
      const gone = () => until(() => run(s, `document.querySelectorAll('${WIN}').length === 0 && !document.querySelector('.tooltip')`), { label: 'window removed', timeout: 8000 });
      await openTerminal(s);
      await TM(s, (app) => app.win.close(true));
      await gone();
      await sleep(600);
      const before = await counts();
      for (let i = 0; i < 15; i++) {
        await openTerminal(s);
        if (i % 3 === 0) {
          await s.page.keyboard.press('Alt+Shift+D');
          await until(async () => (await tabInfo(s)).panes === 2, { label: 'split' });
          await TM(s, (app) => {
            app.openSettings('appearance');
            app.find.open(app.tabs[0].session);
          });
        }
        await TM(s, (app) => app.win.close(true));
        await until(async () => (await winCount(s)) === 0, { label: 'closed' });
      }
      await gone();
      await sleep(600);
      const after = await counts();
      check('same listeners, sessions and DOM after 15 cycles', after, before);
      await until(() => terminalProcs(home).length === 0, { label: 'processes gone', timeout: 8000 }).catch(() => {});
      check('…and no processes', terminalProcs(home), []);
    });
    await section('orphans', 'a page reload kills its terminals', async () => {
      // Reloading the shell page kills its terminals too.
      await openTerminal(s);
      check('a terminal runs', terminalProcs(home).length >= 2, true);
      await s.page.reload();
      await s.page.waitForSelector('body.ready', { timeout: 30000 });
      await until(() => terminalProcs(home).length === 0, { label: 'gone after reload', timeout: 8000 }).catch(() => {});
      check('page reload leaves no terminal processes', terminalProcs(home), []);
    });
  } finally {
    await s.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

async function frenchTests() {
  console.log('Terminal app (fr, light)');
  const home = makeHome();
  // Also with the system's "animation effects" and "transparency effects" turned off.
  const s = await launchShell({ open: ['terminal'], lang: 'fr', theme: 'light', home, settings: { animations: false, transparency: false } });
  recover = async () => {
    await closeMenus(s).catch(() => {});
    for (let i = 0; i < 4 && (await dialogOpen(s).catch(() => false)); i++) {
      await s.page.keyboard.press('Escape').catch(() => {});
      await sleep(200);
    }
  };
  const mark0 = s.logs.length;
  try {
    await s.page.waitForSelector(`${WIN} .xterm`, { timeout: 20000 });
    await waitReady(s);
    await section('fr', 'French menus, find box and settings', async () => {
      check('light scheme', await TM(s, (app) => app.scheme.id), 'one-half-light');
      await focusTerm(s);
      const box = await run(s, `(() => { const r = document.querySelector('${WIN} .xterm-screen').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
      await s.page.mouse.click(box.x, box.y, { button: 'right' });
      await until(() => run(s, `!!document.querySelector('body > .menu.tm-menu')`), { label: 'menu' });
      const labels = await menuLabels(s);
      for (const l of ['Copier', 'Coller', 'Tout sélectionner', 'Rechercher…', 'Effacer la mémoire tampon', 'Fractionner le volet', 'Fermer l’onglet']) check(`menu: ${l}`, labels.includes(l), true);
      check('shortcuts in French (Maj)', await run(s, `[...document.querySelectorAll('body > .menu .menu-item .shortcut')].map((e) => e.textContent).includes('Ctrl+Maj+C')`), true);
      await s.page.locator('body > .menu .menu-item', { hasText: 'Fractionner le volet' }).hover();
      await until(async () => (await menuLabels(s)).includes('Fractionner vers la droite'), { label: 'submenu (fr)' });
      check('no menu runs off screen (fr)', await run(s, `[...document.querySelectorAll('body > .menu')].every((m) => m.getBoundingClientRect().right <= window.innerWidth)`), true);
      await shot(s, 'context-menu-fr-light');
      await closeMenus(s);
      await s.page.click(`${WIN} .tm-dropdown`);
      await until(() => run(s, `!!document.querySelector('body > .menu.tm-profile-menu')`), { label: 'profiles' });
      check('profiles menu (fr)', await menuLabels(s), (l) => l.includes('Shell root') && l.includes('Paramètres') && l.includes('Nouvelle fenêtre') && l.includes('À propos'));
      await closeMenus(s);
      check('new tab tooltip', await run(s, `document.querySelector('${WIN} .tm-newtab').dataset.tip`), 'Nouvel onglet (Ctrl+Maj+T)');
      await focusTerm(s);
      await s.page.keyboard.press('Control+Shift+F');
      await s.page.keyboard.type('zzz');
      await sleep(300);
      check('find (fr)', await run(s, `document.querySelector('${WIN} .tm-find-count').textContent`), 'Aucun résultat');
      check('find placeholder', await run(s, `document.querySelector('${WIN} .tm-find-input').placeholder`), 'Rechercher');
      await s.page.keyboard.press('Escape');
      await s.page.keyboard.press('Control+Comma');
      await until(async () => (await tabInfo(s)).titles.includes('Paramètres'), { label: 'settings' });
      check('nav (fr)', await run(s, `[...document.querySelectorAll('${WIN} .tm-set-nav .nav-item')].map((e) => e.textContent)`), ['Démarrage', 'Interaction', 'Apparence', 'Modèles de couleurs', 'Avancé']);
      await shot(s, 'settings-fr-light');
      // transparency effects off: the opacity setting is not applied, and the page says why
      await TM(s, (app) => app.prefs.set('opacity', 60));
      await s.page.click(`${WIN} .tm-set-nav [data-section="appearance"]`);
      await sleep(300);
      check('opaque while transparency effects are off', await TM(s, (app) => app.tabs[0].session.term.options.theme.background), '#FAFAFA');
      check('note about transparency', await run(s, `!document.querySelector('${WIN} .tm-set-note').hidden`), true);
      await TM(s, (app) => app.prefs.set('opacity', 100));
      for (const sec of ['interaction', 'appearance', 'advanced']) {
        await s.page.click(`${WIN} .tm-set-nav [data-section="${sec}"]`);
        await sleep(300);
        // nothing overflows its row (French is longer)
        const over = await run(s, `[...document.querySelectorAll('${WIN} .tm-set-row')].filter((r) => r.scrollWidth > r.clientWidth + 1).map((r) => r.dataset.setting)`);
        check(`no overflow in ${sec} (fr)`, over, []);
        if (sec === 'appearance') {
          await shot(s, 'settings-appearance-fr-light');
          check('percent in French', await run(s, `document.querySelector('${WIN} .tm-slider-val').textContent`), (v) => /^100[\u202f\u00a0 ]%$/.test(v));
        }
      }
      // tab menu and the large paste warning in French
      await TM(s, (app) => app.activate(app.tabs[0]));
      const tb = await run(s, `(() => { const r = document.querySelector('${WIN} .tm-tab').getBoundingClientRect(); return { x: r.x + 40, y: r.y + r.height / 2 }; })()`);
      await s.page.mouse.click(tb.x, tb.y, { button: 'right' });
      await until(async () => (await menuLabels(s)).includes('Exporter le texte…'), { label: 'tab menu (fr)' });
      check('tab menu (fr)', await menuLabels(s), (l) => l.includes('Rechercher…') && l.includes('Renommer l’onglet') && l.includes('Fermer les autres onglets'));
      await closeMenus(s);
      await run(s, `window.aurora.invoke('clipboard:writeText', 'y'.repeat(6000)); 0`);
      await TM(s, (app) => {
        app.session.paste();
      });
      await until(() => dialogOpen(s), { label: 'large paste (fr)' });
      check('large paste warning (fr)', await dialogText(s), (t) => /Coller un texte volumineux/.test(t) && /5 Ko/.test(t));
      await dialogButton(s, 'Annuler');
      // minimum window size in French: nothing scrolls sideways, both tabs fit
      await TM(s, (app) => app.win.setSize(100, 100));
      await sleep(300);
      for (const sec of ['startup', 'interaction', 'appearance', 'schemes', 'advanced']) {
        await TM(s, (app, el, sec) => app.openSettings(sec), sec);
        await sleep(250);
        check(`min size, ${sec} (fr): no sideways scrolling`, await run(s, `(() => { const m = document.querySelector('${WIN} .tm-set-main'); return m.scrollWidth - m.clientWidth; })()`), (v) => v <= 1);
      }
      check('min size: both tabs fit without scroll arrows', await TM(s, (app) => app.scrollL.hidden && app.tabsEl.scrollWidth <= app.tabsEl.clientWidth + 1), true);
      check('min size: settings nav has no scrollbar', await run(s, `getComputedStyle(document.querySelector('${WIN} .tm-set-nav')).scrollbarWidth`), 'none');
      await shot(s, 'minsize-settings-fr-light', { clip: true });
      await TM(s, (app) => {
        app.win.setSize(980, 600);
        app.win.center();
      });
      await sleep(300);
      // exit message in French
      await TM(s, (app) => app.activate(app.tabs[0]));
      await typeLine(s, 'exit 2');
      await waitText(s, /le processus s’est terminé avec le code 2/);
      check('exit message (fr)', /appuyer sur Entrée pour le redémarrer/.test(await buffer(s)), true);
      await focusTerm(s);
      await s.page.keyboard.press('Enter');
      await waitReady(s);
      // window close confirmation (fr)
      await s.page.keyboard.press('Control+Shift+T');
      await until(async () => (await tabInfo(s)).count === 3, { label: '3 tabs' });
      await waitReady(s);
      await TM(s, (app) => {
        app.win.close();
      });
      await until(() => dialogOpen(s), { label: 'confirm' });
      check('confirm (fr)', await dialogText(s), (t) => /Fermer tous les onglets/.test(t) && /fermer 2 onglets/.test(t));
      await dialogButton(s, 'Annuler');
    });
    await section('fr', 'no console errors (fr)', async () => {
      check('console errors', errorsSince(s, mark0), []);
    });
  } finally {
    recover = null;
    await s.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// The ambiances: the default scheme and the profile icons follow <html data-ambiance> (cold unchanged; neutral and
// warm draw from the Selene app-icon palette, core/app-icon-art.js, with no blue), live; a scheme the user picked
// stays; Clair de lune written straight into the settings file still gets its violet accent (core/theme.js accentOf).
const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(String(h).slice(i, i + 2), 16));
const cssRgb = (c) => (String(c).match(/\d+(\.\d+)?/g) || []).slice(0, 3).map(Number);
function hueOf([r, g, b]) {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  if (mx === mn) return { h: 0, s: 0 };
  const d = mx - mn;
  const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s: d / mx };
}
// blue: b clearly above r and g AND a blue/cyan hue (185°–250°) with some saturation
const isBlue = (rgb) => {
  const [r, g, b] = rgb;
  const { h, s } = hueOf(rgb);
  return b > Math.max(r, g) + 8 && h >= 185 && h <= 250 && s > 0.12;
};
const lum = (rgb) => {
  const c = rgb.map((v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
};

async function ambianceTests() {
  console.log('Terminal in the ambiances (fr)');
  const schemes = await import(path.join(ROOT, 'renderer', 'apps', 'terminal', 'lib', 'schemes.js'));
  await section('ambiance', 'default scheme per ambiance: cold unchanged, readable, no blue ground', async () => {
    check('cold dark = One Half Dark', schemes.systemScheme('dark', 'cold').colors.background, '#282C34');
    check('cold light = One Half Light', schemes.systemScheme('light', 'cold').colors.background, '#FAFAFA');
    check('no ambiance = cold', schemes.resolveScheme('system', 'dark').colors.background, '#282C34');
    for (const amb of ['neutral', 'warm']) {
      for (const mode of ['dark', 'light']) {
        const c = schemes.systemScheme(mode, amb).colors;
        check(`${amb} ${mode}: own ground`, c.background, (v) => v !== schemes.systemScheme(mode, 'cold').colors.background);
        check(`${amb} ${mode}: ground, text and greys are not blue`, ['background', 'foreground', 'black', 'white', 'brightBlack', 'cursor'].filter((k) => isBlue(hexRgb(c[k]))), []);
        check(`${amb} ${mode}: text >= 4.5:1 (${ratio(hexRgb(c.foreground), hexRgb(c.background)).toFixed(1)})`, ratio(hexRgb(c.foreground), hexRgb(c.background)) >= 4.5, true);
        check(`${amb} ${mode}: bright black >= 3:1`, ratio(hexRgb(c.brightBlack), hexRgb(c.background)) >= 3, true);
        const cold = schemes.systemScheme(mode, 'cold').colors;
        // the chromatic ANSI colours keep their meaning and are at least as readable as on the cold ground
        check(`${amb} ${mode}: ANSI colours kept`, ['red', 'green', 'yellow', 'blue', 'purple', 'cyan'].every((k) => c[k] === cold[k]), true);
        check(`${amb} ${mode}: ANSI contrast not lower than in cold`, ['red', 'green', 'yellow', 'blue', 'purple', 'cyan'].filter((k) => ratio(hexRgb(c[k]), hexRgb(c.background)) < ratio(hexRgb(cold[k]), hexRgb(cold.background)) - 0.05), []);
      }
    }
    check('a scheme the user picked is never changed', schemes.resolveScheme('campbell-powershell', 'dark', 'warm').colors.background, '#012456');
  });

  const home = makeHome();
  // Clair de lune written straight into the settings file (no follow rule): its own accent and ambiance apply.
  const s = await launchShell({ open: ['terminal'], lang: 'fr', theme: 'light', home, size: '1280x720', settings: { style: 'clairdelune', finish: 'sobre' } }); // the Sobre theme's Clair de lune accents (Halo / Prisme have their own)
  recover = async () => {
    await closeMenus(s).catch(() => {});
  };
  const mark0 = s.logs.length;
  const iconColors = () =>
    TM(s, (app, el) =>
      [...el.querySelectorAll('.tm-tab .tm-picon')].map((p) => ({
        kind: p.dataset.picon,
        colors: [...p.innerHTML.matchAll(/(?:stop-color|fill|stroke)="(#[0-9a-fA-F]{6})"/g)].map((m) => m[1].toLowerCase()),
      })),
    );
  const look = () => TM(s, (app) => ({ amb: document.documentElement.dataset.ambiance, mode: document.documentElement.dataset.theme, bg: app.session.term.options.theme.background, scheme: app.scheme.id }));
  const setting = (k, v) => run(s, `window.__aurora.settings.set(${JSON.stringify(k)}, ${JSON.stringify(v)}).then(() => 0)`);
  try {
    await s.page.waitForSelector(`${WIN} .xterm`, { timeout: 20000 });
    await waitReady(s);
    await TM(s, (app) => {
      for (const p of app.profiles().slice(1)) app.newTab(p);
      app.activate(app.tabs[0]);
    });
    await until(async () => (await iconColors()).length >= 2, { label: 'profile tabs' });

    await section('ambiance', 'Clair de lune light: violet accent (style set without the follow rule)', async () => {
      await until(() => run(s, `window.__aurora.settings.get('accent') === '#a58bf2'`), { label: 'accent saved' });
      check('--accent is the violet of Clair de lune light', await run(s, `getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()`), '#6a4bc3');
      check('the style accent and ambiance are saved once', await run(s, `[window.__aurora.settings.get('accent'), window.__aurora.settings.get('ambiance')]`), ['#a58bf2', 'warm']);
      await TM(s, (app) => app.openSettings('interaction'));
      await until(() => TM(s, (app, el) => !!el.querySelector('.tm-settings .toggle input:checked')), { label: 'settings toggles' });
      const on = await TM(s, (app, el) => getComputedStyle(el.querySelector('.tm-settings .toggle input:checked')).backgroundColor);
      check(`a switch that is on uses the violet accent (${on})`, cssRgb(on), [106, 75, 195]);
      await TM(s, (app) => app.activate(app.tabs[0]));
      // a colour the user picks afterwards is theirs, silver included
      await setting('accent', '#c9d3e6');
      await until(() => run(s, `getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() === '#55637e'`), { label: 'silver picked' });
      check('silver picked by the user stays silver', await run(s, `window.__aurora.settings.get('accent')`), '#c9d3e6');
      await setting('accent', '#a58bf2');
    });

    await section('ambiance', 'warm: plum-black / cream scheme, profile icons from the warm palette, no blue', async () => {
      check('warm light scheme', await look(), (v) => v.amb === 'warm' && v.mode === 'light' && v.scheme === 'one-half-light' && v.bg === schemes.systemScheme('light', 'warm').colors.background);
      const view = await TM(s, (app) => getComputedStyle(app.active.view).backgroundColor);
      check(`terminal ground is not blue (${view})`, isBlue(cssRgb(view)), false);
      const icons = await iconColors();
      check('three profile icons', icons.map((i) => i.kind).sort(), ['python', 'root', 'shell']);
      check('warm light icons: no blue colour', icons.flatMap((i) => i.colors.filter((c) => isBlue(hexRgb(c)))), []);
      check('warm light icons: no original blue artwork', icons.flatMap((i) => i.colors).filter((c) => ['#3b82f6', '#2f6fb8', '#3f86cf', '#3a4254', '#151922'].includes(c)), []);
      await setting('theme', 'dark');
      await until(async () => (await look()).bg === schemes.systemScheme('dark', 'warm').colors.background, { label: 'warm dark scheme' });
      check('warm dark: plum-black ground', (await look()).bg, '#251a25');
      check('warm dark icons: no blue colour', (await iconColors()).flatMap((i) => i.colors.filter((c) => isBlue(hexRgb(c)))), []);
      await shot(s, 'ambiance-warm-dark', { clip: true });
    });

    await section('ambiance', 'neutral, live: warm near-black scheme and icons redrawn at once', async () => {
      const before = JSON.stringify(await iconColors());
      await setting('ambiance', 'neutral');
      await until(async () => (await look()).bg === '#1b1917', { label: 'neutral dark scheme' });
      check('icons redrawn on the ambiance change', JSON.stringify(await iconColors()) !== before, true);
      check('neutral dark icons: no blue colour', (await iconColors()).flatMap((i) => i.colors.filter((c) => isBlue(hexRgb(c)))), []);
      await setting('theme', 'light');
      await until(async () => (await look()).bg === schemes.systemScheme('light', 'neutral').colors.background, { label: 'neutral light scheme' });
      check('neutral light icons: no blue colour', (await iconColors()).flatMap((i) => i.colors.filter((c) => isBlue(hexRgb(c)))), []);
      const strip = await TM(s, (app, el) => getComputedStyle(el.querySelector('.tm-tab.active') || el.querySelector('.tm-tab')).backgroundColor);
      check(`neutral light active tab is not blue (${strip})`, isBlue(cssRgb(strip)), false);
      await shot(s, 'ambiance-neutral-light', { clip: true });
      // the explicit scheme a user picked is not touched by the ambiance
      await TM(s, (app) => app.prefs.set('scheme', 'campbell-powershell'));
      await until(async () => (await look()).bg === '#012456', { label: 'explicit scheme' });
      check('explicit scheme kept in neutral', (await look()).bg, '#012456');
      await TM(s, (app) => app.prefs.set('scheme', 'system'));
    });

    await section('ambiance', 'cold: the original scheme and icons, unchanged', async () => {
      await setting('ambiance', 'cold');
      await setting('theme', 'dark');
      await until(async () => (await look()).bg === '#282C34', { label: 'cold dark scheme' });
      const icons = await iconColors();
      const shell = icons.find((i) => i.kind === 'shell').colors;
      const python = icons.find((i) => i.kind === 'python').colors;
      check('cold shell icon: original colours', shell, (c) => ['#3a4254', '#151922', '#2ec6c0', '#3b82f6', '#7fe3d4'].every((x) => c.includes(x)));
      check('cold python icon: original colours', python, (c) => ['#2f6fb8', '#3f86cf', '#e6b422'].every((x) => c.includes(x)));
      check('cold root icon: original colours', icons.find((i) => i.kind === 'root').colors, (c) => ['#f0743e', '#c42b1c'].every((x) => c.includes(x)));
    });

    await section('ambiance', 'no console errors (ambiances)', async () => {
      check('console errors', errorsSince(s, mark0), []);
    });
  } finally {
    recover = null;
    await s.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// Documentation screenshots: colourful output in dark and light, Python, split panes.
async function screenshotTests() {
  for (const theme of ['dark', 'light']) {
    console.log(`Screenshots (${theme})`);
    const home = makeHome();
    const s = await launchShell({ open: ['terminal'], lang: 'en', theme, home });
    try {
      await s.page.waitForSelector(`${WIN} .xterm`, { timeout: 20000 });
      await waitReady(s);
      await section('shots', `screenshots ${theme}`, async () => {
        await TM(s, (app) => {
          app.win.setSize(1180, 680);
          app.win.center();
        });
        await sleep(400);
        await typeLine(s, 'clear; ls --color=auto -l; git --version; printf "\\e[1;35mbold magenta\\e[0m \\e[4munderline\\e[0m \\e[7minverse\\e[0m \\e[38;2;255;140;0mtruecolor\\e[0m café 🙂\\n"');
        await waitText(s, /truecolor/);
        await s.page.keyboard.press('Alt+Shift+D');
        await until(async () => (await tabInfo(s)).panes === 2, { label: 'split' });
        await waitReady(s);
        await typeLine(s, 'python3 -q');
        await waitText(s, /^>>> *$/m, { timeout: 10000, pane: 1 });
        await typeLine(s, 'import sys, platform');
        await typeLine(s, '[n * n for n in range(1, 11)]');
        await typeLine(s, 'f"Python {platform.python_version()} on {sys.platform}"');
        await waitText(s, /^'Python .* on linux'$/m, { pane: 1 });
        await TM(s, (app) => app.focusSession(app.active.tree.sessions()[0]));
        await shot(s, theme === 'dark' ? 'dark' : 'light');
        if (theme === 'dark') {
          await TM(s, (app) => app.win.maximize());
          await sleep(500);
          await typeLine(s, 'clear; ls --color=auto -la ~ ~/Projects/aurora-shell; git --version');
          await waitText(s, /git version/);
          await shot(s, 'maximized-dark');
          await TM(s, (app) => app.win.restore());
          await sleep(400);
          await TM(s, (app) => app.openSettings('appearance'));
          await sleep(500);
          await shot(s, 'settings');
        }
      });
    } finally {
      await s.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
}

// ---------------------------------------------------------------- main
const t0 = Date.now();
// --only=<group> runs one group; any other --only=<text> runs the sections whose name contains it.
const GROUPS = ['helper', 'ui', 'fr', 'ambiance', 'orphans', 'shots'];
const want = (g) => !only || !GROUPS.includes(only) || only === g;
if (want('helper')) await helperTests();
if (want('ui')) await uiTests();
if (want('fr')) await frenchTests();
if (want('ambiance')) await ambianceTests();
if (want('orphans')) await orphanTests();
if (want('shots')) await screenshotTests();
console.log(`\n${passed} checks passed, ${failures.length} failed (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
if (failures.length) {
  console.log(`\nFailures:\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
