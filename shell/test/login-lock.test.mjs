// Sign-in screen (greeter), lock screen and session "Welcome" — unit + end-to-end tests.
//
//   cd aurora-os/shell && xvfb-run -a -s "-screen 0 1920x1080x24" node test/login-lock.test.mjs
//   options: --unit (unit checks only)  --quick (skip the slow / extra-resolution runs)  --only=<groups> (see the end)
//            --docs (copy the screenshots to docs/screenshots/login-*.png and lock-*.png)
//
// Unit: greetd framing + client against an in-process fake greetd (real unix socket), /etc/passwd and
// setxkbmap parsers, rate limiter, the aurora-checkpass PAM helper (through a throwaway PAM config dir with
// pam_exec, since the container cannot authenticate a real user) and auth.js' checkPassword().
// E2E (Electron, dev mode): greeter with the mock greetd (password "aurora"), greeter against the fake greetd
// server ($GREETD_SOCK), lock / unlock in the desktop shell, auto-lock, live session, Welcome transition.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright-core';
import { launchShell, OUT, ROOT } from './lib.mjs';

const require = createRequire(import.meta.url);
const UNIT_ONLY = process.argv.includes('--unit');
const QUICK = process.argv.includes('--quick');
const DOCS = process.argv.includes('--docs');
const REPO = path.join(ROOT, '..');
const DOCS_DIR = path.join(REPO, 'docs', 'screenshots');
const HELPER = path.join(REPO, 'rootfs', 'usr', 'lib', 'aurora', 'helpers', 'aurora-checkpass');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-login-test-'));

let failures = 0;
let passes = 0;
function check(cond, msg) {
  if (cond) passes++;
  else {
    failures++;
    console.log(`  ✗ ${msg}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const section = (name) => console.log(`\n▸ ${name}`);

async function shot(page, name) {
  const file = path.join(OUT, `${name}.png`);
  fs.mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: file });
  if (DOCS && /^(login|lock)-/.test(name)) {
    fs.mkdirSync(DOCS_DIR, { recursive: true });
    fs.copyFileSync(file, path.join(DOCS_DIR, `${name}.png`));
  }
  return file;
}

// Renderer errors coming from this area's files (other agents' apps may log their own while they work).
const MINE = /greeter\/|features\/(lock|welcome)|greeter\.html|ipc\/(greetd|auth)|lockui|\[greeter\]|\[lock\]|\[welcome\]/;
function myErrors(logs) {
  return logs.filter((l) => (l.startsWith('[pageerror]') || l.startsWith('[error]')) && (MINE.test(l) || l.startsWith('[pageerror]')));
}

const greetd = require('../main/ipc/greetd.js');
const auth = require('../main/ipc/auth.js');
const { encodeFrame, FrameDecoder, GreetdClient, parsePasswd, parseShells, parseXkbQuery, layoutId, sniffImage, sessionEnv, SESSION_CMD } = greetd;

// ======================================================================= fake greetd (real protocol)
// users: { name: password }; passwordless: [names]; info: send an info message before the password prompt;
// expire: [names] whose correct password is followed by a second secret prompt; chunked: split frames.
function fakeGreetd(sockPath, opts = {}) {
  const users = opts.users || { marie: 's3cret' };
  const log = [];
  const state = { started: null, connections: 0 };
  const server = net.createServer((sock) => {
    state.connections++;
    const dec = new FrameDecoder();
    let session = null;
    const send = (obj) => {
      const frame = encodeFrame(obj);
      if (!opts.chunked) return sock.write(frame);
      // Deliver the frame in three pieces (length prefix split too).
      const cuts = [0, 2, Math.max(3, frame.length >> 1), frame.length];
      cuts.slice(1).forEach((end, i) => setTimeout(() => !sock.destroyed && sock.write(frame.subarray(cuts[i], end)), 5 * (i + 1)));
    };
    sock.on('error', () => {});
    sock.on('data', (chunk) => {
      for (const req of dec.push(chunk)) {
        log.push(req);
        if (opts.dropOn && req.type === opts.dropOn) {
          sock.destroy();
          return;
        }
        if (req.type === 'create_session') {
          if (session) {
            send({ type: 'error', error_type: 'error', description: 'a session is already being configured' });
            continue;
          }
          session = { user: req.username, stage: opts.info ? 'info' : 'secret' };
          if ((opts.passwordless || []).includes(req.username)) {
            session.stage = 'done';
            send({ type: 'success' });
          } else if (opts.info) send({ type: 'auth_message', auth_message_type: 'info', auth_message: 'Last login: Fri Oct  9 21:02 on tty7' });
          else send({ type: 'auth_message', auth_message_type: 'secret', auth_message: 'Password: ' });
        } else if (req.type === 'post_auth_message_response') {
          if (!session) {
            send({ type: 'error', error_type: 'error', description: 'no session' });
          } else if (session.stage === 'info') {
            session.stage = 'secret';
            send({ type: 'auth_message', auth_message_type: 'secret', auth_message: 'Password: ' });
          } else if (session.stage === 'secret') {
            if (Object.hasOwn(users, session.user) && users[session.user] === req.response) {
              if ((opts.expire || []).includes(session.user)) {
                session.stage = 'expired';
                send({ type: 'auth_message', auth_message_type: 'secret', auth_message: 'New password: ' });
              } else {
                session.stage = 'done';
                send({ type: 'success' });
              }
            } else {
              session.stage = 'failed';
              send({ type: 'error', error_type: 'auth_error', description: 'pam_authenticate: AUTH_ERR' });
            }
          } else send({ type: 'error', error_type: 'error', description: 'unexpected response' });
        } else if (req.type === 'start_session') {
          if (session?.stage !== 'done') send({ type: 'error', error_type: 'error', description: 'session not authenticated' });
          else {
            state.started = { user: session.user, cmd: req.cmd, env: req.env };
            send({ type: 'success' });
          }
        } else if (req.type === 'cancel_session') {
          session = null;
          send({ type: 'success' });
        } else send({ type: 'error', error_type: 'error', description: `unknown request ${req.type}` });
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(sockPath, () => resolve({ log, state, close: () => new Promise((r) => server.close(r)), server }));
  });
}

// ======================================================================= unit tests
async function unitTests() {
  section('greetd framing');
  {
    const f = encodeFrame({ type: 'create_session', username: 'élise' });
    const body = Buffer.from(JSON.stringify({ type: 'create_session', username: 'élise' }), 'utf8');
    check(f.length === 4 + body.length, 'frame = 4-byte length + JSON');
    const len = os.endianness() === 'LE' ? f.readUInt32LE(0) : f.readUInt32BE(0);
    check(len === body.length, 'length prefix is native-endian byte length (UTF-8)');
    const dec = new FrameDecoder();
    const two = Buffer.concat([f, encodeFrame({ type: 'cancel_session' })]);
    let got = [];
    for (let i = 0; i < two.length; i++) got.push(...dec.push(two.subarray(i, i + 1)));
    check(got.length === 2 && got[0].username === 'élise' && got[1].type === 'cancel_session', 'decoder handles byte-by-byte delivery');
    got = new FrameDecoder().push(two);
    check(got.length === 2, 'decoder handles two frames in one chunk');
    const huge = Buffer.alloc(4);
    huge.writeUInt32LE(5 << 20, 0);
    let threw = false;
    try {
      new FrameDecoder().push(huge);
    } catch (e) {
      threw = e.code === 'EGREETD';
    }
    check(threw, 'oversized frame is rejected');
  }

  section('/etc/passwd + /etc/shells parsing');
  {
    const passwd = [
      'root:x:0:0:root:/root:/bin/bash',
      'daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin',
      '_greetd:x:998:998::/var/lib/aurora-greeter:/usr/sbin/nologin',
      'aurora:x:999:999:Aurora Live,,,:/home/aurora:/bin/bash',
      'marie:x:1000:1000:Marie Curie,Lab 3,,:/home/marie:/bin/bash',
      'leo:x:1001:1001::/home/leo:/usr/bin/zsh',
      'svc:x:1002:1002:Service:/srv:/usr/sbin/nologin',
      'ghost:x:1003:1003:Ghost:/home/ghost:/bin/false',
      'nobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin',
      'nixbld1:x:30001:30000:Nix build user 1:/var/empty:/sbin/nologin',
      'big:x:61000:61000:Too high:/home/big:/bin/bash',
      'marie:x:1004:1004:Duplicate:/home/m2:/bin/bash',
      '# comment',
      'broken:line',
      '',
    ].join('\n');
    const shells = parseShells('# /etc/shells\n/bin/sh\n/bin/bash\n/usr/bin/bash\n/usr/bin/zsh\n');
    let users = parsePasswd(passwd, { shells });
    check(users.map((u) => u.name).join(',') === 'marie,leo', `human users only (got ${users.map((u) => u.name)})`);
    check(users[0].fullName === 'Marie Curie' && users[1].fullName === 'leo', 'full name from the first GECOS field, user name when empty');
    users = parsePasswd(passwd, { shells, liveUser: 'aurora' });
    check(users.some((u) => u.name === 'aurora' && u.live), 'the live user (uid 999) is listed in a live session');
    users = parsePasswd(passwd, { shells: parseShells('/bin/bash\n') });
    check(!users.some((u) => u.name === 'leo'), 'users whose shell is not in /etc/shells are hidden');
    check(parsePasswd('', {}).length === 0, 'empty passwd -> no users');
    const defs = greetd.parseLoginDefs('# login.defs\nUID_MIN\t\t 1000\nUID_MAX\t\t 60000\n#UID_MAX 5\n');
    check(defs.minUid === 1000 && defs.maxUid === 60000, 'UID_MIN / UID_MAX from login.defs');
    check(greetd.parseLoginDefs('').minUid === 1000, 'login.defs defaults');
    check(parsePasswd(passwd, { shells, minUid: 1001 }).map((u) => u.name).join() === 'leo', 'honours UID_MIN');
  }

  section('setxkbmap -query parsing');
  {
    const q1 = 'rules:      evdev\nmodel:      pc105\nlayout:     fr\noptions:    terminate:ctrl_alt_bksp\n';
    const q2 = 'rules:      evdev\nmodel:      pc105\nlayout:     ch,us\nvariant:    fr,\n';
    const a = parseXkbQuery(q1);
    const b = parseXkbQuery(q2);
    check(a.layout === 'fr' && a.variant === '' && a.model === 'pc105' && a.options === 'terminate:ctrl_alt_bksp', 'single layout');
    check(b.layout === 'ch' && b.variant === 'fr', 'first layout + variant of a group');
    check(layoutId('ch', 'fr') === 'ch:fr' && layoutId('us', '') === 'us' && layoutId('dvorak', 'x') === 'dvorak:x', 'layout ids');
    check(parseXkbQuery('').layout === '', 'empty output');
  }

  section('account pictures, session environment');
  {
    check(sniffImage(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0])) === 'image/png', 'PNG signature');
    check(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])) === 'image/jpeg', 'JPEG signature');
    check(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')) === 'image/svg+xml', 'SVG');
    check(sniffImage(Buffer.from('#!/bin/sh\necho hi\n')) === null, 'non-images rejected');
    const fr = sessionEnv('fr');
    check(fr.includes('LANG=fr_FR.UTF-8') && fr.includes('AURORA_LANG=fr') && fr.includes('XDG_SESSION_TYPE=x11'), 'French session env');
    check(!sessionEnv(null).some((e) => e.startsWith('LANG=')), 'no LANG when the language was not chosen at sign-in');
    check(SESSION_CMD[0] === '/usr/bin/aurora-session', 'session command');
  }

  section('account picture hand-off (session -> sign-in screen)');
  {
    const faces = path.join(TMP, 'faces');
    fs.mkdirSync(faces, { mode: 0o1777 });
    fs.chmodSync(faces, 0o1777);
    const home = path.join(TMP, 'home-face');
    fs.mkdirSync(home);
    const realPng = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
    fs.writeFileSync(path.join(home, '.face'), realPng);
    const uid = process.getuid();
    check(greetd.publishFace({ home, name: 'tester', facesDir: faces }) === true, 'picture published for the sign-in screen');
    check(fs.readFileSync(path.join(faces, 'tester')).equals(realPng) && (fs.statSync(path.join(faces, 'tester')).mode & 0o777) === 0o644, 'published copy is identical, mode 0644');
    check(fs.readdirSync(faces).length === 1, 'no temporary file left behind');
    const url = greetd.readAvatar({ name: 'tester', uid, home: '/nonexistent' }, { facesDir: faces });
    check(url?.startsWith('data:image/png;base64,'), 'greeter reads the published picture');
    check(greetd.readAvatar({ name: 'tester', uid: uid + 1, home: '/nonexistent' }, { facesDir: faces }) === null, 'a picture owned by another account is ignored');
    fs.symlinkSync(path.join(home, '.face'), path.join(faces, 'linked'));
    check(greetd.readAvatar({ name: 'linked', uid, home: '/nonexistent' }, { facesDir: faces }) === null, 'symlinks are not followed');
    fs.writeFileSync(path.join(home, 'notimg'), 'hello world, not an image at all');
    fs.renameSync(path.join(home, 'notimg'), path.join(home, '.face.icon'));
    check(greetd.readAvatar({ name: 'nobody-here', uid, home }, { facesDir: faces })?.startsWith('data:image/png'), '~/.face read directly when readable');
    fs.unlinkSync(path.join(home, '.face'));
    greetd.publishFace({ home, name: 'tester', facesDir: faces });
    check(!fs.existsSync(path.join(faces, 'tester')), 'removing the picture removes the published copy (non-images are ignored)');
    check(greetd.publishFace({ home, name: 'tester', facesDir: path.join(TMP, 'no-such-dir') }) === false, 'no faces directory: nothing published');
  }

  section('rate limiter (auth.js)');
  {
    let now = 1000;
    const lim = auth.createLimiter({ now: () => now });
    for (let i = 0; i < 4; i++) lim.fail();
    check(lim.wait() === 0, '4 failures: no wait');
    check(lim.fail() === 30000, '5th failure: 30 s');
    now += 10000;
    check(lim.wait() === 20000, 'countdown');
    now += 20000;
    check(lim.fail() === 60000, '6th failure: 60 s');
    for (let i = 0; i < 6; i++) lim.fail();
    check(lim.wait() === 300000, 'capped at 5 min');
    lim.succeed();
    check(lim.wait() === 0 && lim.failures === 0, 'success resets');
  }

  section('greetd client <-> fake greetd (unix socket)');
  {
    const sock = path.join(TMP, 'greetd-unit.sock');
    const g = await fakeGreetd(sock, { users: { marie: 's3cret', leo: 'pw' }, info: true, passwordless: ['aurora'], expire: ['leo'], chunked: true });
    const c = new GreetdClient(sock, { timeout: 5000 });
    let err = null;
    try {
      await c.login('marie', 'wrong');
    } catch (e) {
      err = e;
    }
    check(err?.code === 'EAUTH', `wrong password -> EAUTH (got ${err?.code})`);
    const types = g.log.map((r) => r.type);
    check(types.join(',') === 'create_session,post_auth_message_response,post_auth_message_response,cancel_session', `request sequence on failure: ${types}`);
    check(g.log[1].response === null, 'info message answered with a null response');
    check(g.log[2].response === 'wrong', 'secret prompt answered with the password');
    g.log.length = 0;
    err = null;
    try {
      await c.login('leo', 'pw');
    } catch (e) {
      err = e;
    }
    check(err?.code === 'EEXPIRED' && /New password/.test(err.message), `second secret prompt -> EEXPIRED (got ${err?.code})`);
    check(g.log.at(-1)?.type === 'cancel_session', 'expired: session cancelled');
    g.log.length = 0;
    const r = await c.login('aurora', '', { env: sessionEnv('en') });
    check(r.ok && g.state.started?.user === 'aurora', 'passwordless account: create_session -> success -> start_session');
    check(JSON.stringify(g.state.started.cmd) === '["/usr/bin/aurora-session"]' && g.state.started.env.includes('LANG=en_US.UTF-8'), 'start_session carries cmd + env');
    // A stale half-configured session (left by a crashed greeter) is cancelled and retried once.
    g.log.length = 0;
    g.state.started = null;
    const raw = new GreetdClient(sock, { timeout: 5000 });
    await raw.request({ type: 'create_session', username: 'marie' });
    const r2 = await raw.login('marie', 's3cret');
    check(r2.ok && g.state.started?.user === 'marie', 'stale session cancelled, then signed in');
    check(g.log.filter((x) => x.type === 'cancel_session').length === 1, 'exactly one cancel for the stale session');
    raw.close();
    c.close();
    await g.close();

    // Connection dropped by greetd in the middle of a sign-in.
    const sock2 = path.join(TMP, 'greetd-drop.sock');
    const g2 = await fakeGreetd(sock2, { dropOn: 'post_auth_message_response' });
    const c2 = new GreetdClient(sock2, { timeout: 5000 });
    err = null;
    try {
      await c2.login('marie', 's3cret');
    } catch (e) {
      err = e;
    }
    check(err?.code === 'EGREETD', `dropped connection -> EGREETD (got ${err?.code})`);
    await g2.close();
    err = null;
    try {
      await new GreetdClient(path.join(TMP, 'missing.sock'), { timeout: 2000 }).login('x', 'y');
    } catch (e) {
      err = e;
    }
    check(err?.code === 'EGREETD', 'missing socket -> EGREETD');
  }

  section('aurora-checkpass (PAM helper)');
  {
    const run = (args, input, extra = {}) => spawnSync(HELPER, args, { input, encoding: 'utf8', timeout: 20000, ...extra });
    check(fs.statSync(HELPER).mode & 0o111, 'helper is executable');
    check(fs.readFileSync(HELPER, 'utf8').startsWith('#!/usr/bin/python3 -I'), 'isolated python3 shebang');
    let r = run(['--help'], '');
    check(r.status === 0 && /Exit status/.test(r.stdout), '--help');
    r = run(['--bogus'], 'x\n');
    check(r.status === 2, `unknown argument -> 2 (got ${r.status})`);
    r = run(['--service'], 'x\n');
    check(r.status === 2, 'missing option value -> 2');
    r = run(['--service', '../../etc/shadow'], 'x\n');
    check(r.status === 2, 'service names cannot be paths');
    r = run([], `${'a'.repeat(5000)}\n`);
    check(r.status === 2 && /too long/.test(r.stderr), 'password longer than 4096 bytes -> 2');
    // A throwaway PAM configuration whose auth module (pam_exec + expose_authtok) checks the password
    // received through our conversation function.
    const confdir = path.join(TMP, 'pam.d');
    fs.mkdirSync(confdir, { recursive: true });
    const checker = path.join(TMP, 'check-authtok.py');
    fs.writeFileSync(checker, '#!/usr/bin/python3\nimport sys\nd = sys.stdin.buffer.read().rstrip(b"\\0\\n")\nsys.exit(0 if d == "s3cret pâté".encode() else 1)\n', { mode: 0o755 });
    fs.writeFileSync(path.join(confdir, 'aurora-test'), `auth required pam_exec.so expose_authtok quiet ${checker}\naccount required pam_permit.so\n`);
    fs.writeFileSync(path.join(confdir, 'aurora-locked'), `auth required pam_exec.so expose_authtok quiet ${checker}\naccount required pam_deny.so\n`);
    const pamOk = fs.existsSync('/usr/lib/x86_64-linux-gnu/security/pam_exec.so') || fs.existsSync('/lib/x86_64-linux-gnu/security/pam_exec.so') || fs.existsSync('/usr/lib/aarch64-linux-gnu/security/pam_exec.so');
    if (pamOk) {
      r = run(['--service', 'aurora-test', '--confdir', confdir], 's3cret pâté\n');
      check(r.status === 0, `correct password through the PAM conversation -> 0 (got ${r.status}: ${r.stderr})`);
      r = run(['--service', 'aurora-test', '--confdir', confdir], 's3cret pâté');
      check(r.status === 0, 'no trailing newline needed');
      r = run(['--service', 'aurora-test', '--confdir', confdir], 'wrong\n');
      check(r.status === 1, `wrong password -> 1 (got ${r.status})`);
      r = run(['--service', 'aurora-test', '--confdir', confdir], 's3cret\0pâté\n');
      check(r.status === 1, 'NUL byte in the password -> 1');
      r = run(['--service', 'aurora-locked', '--confdir', confdir], 's3cret pâté\n');
      check(r.status === 1, 'right password but account refused (pam_acct_mgmt) -> 1');
      r = run(['--service', 'aurora-test', '--confdir', path.join(TMP, 'nope')], 'x\n');
      check(r.status === 3, `PAM cannot start -> 3 (got ${r.status})`);
      // auth.js checkPassword() through the same helper.
      const helperArgs = ['--service', 'aurora-test', '--confdir', confdir];
      check((await auth.checkPassword('s3cret pâté', { helper: HELPER, args: helperArgs })) === true, 'checkPassword(): right password -> true');
      check((await auth.checkPassword('nope', { helper: HELPER, args: helperArgs })) === false, 'checkPassword(): wrong password -> false');
    } else console.log('  (pam_exec.so not found: PAM conversation tests skipped)');
    // The real stack (falls back to /etc/pam.d/other -> common-auth -> pam_unix): wrong password for this user.
    if (process.getuid() === 0) {
      r = run(['--service', 'aurora-lock-test-nonexistent'], 'definitely-not-the-password\n');
      check(r.status === 1, `real pam_unix stack, wrong password -> 1 (got ${r.status}: ${r.stderr.trim()})`);
      const nobody = spawnSync('runuser', ['-u', 'nobody', '--', 'true']);
      if (nobody.status === 0) {
        const copy = path.join(TMP, 'aurora-checkpass');
        fs.copyFileSync(HELPER, copy);
        fs.chmodSync(copy, 0o755);
        fs.chmodSync(TMP, 0o755);
        r = spawnSync('runuser', ['-u', 'nobody', '--', copy, '--user', 'root'], { input: 'x\n', encoding: 'utf8' });
        check(r.status === 2 && /only root/.test(r.stderr), 'a normal user cannot check another account');
      }
    }
    let err = null;
    try {
      await auth.checkPassword('x', { helper: path.join(TMP, 'missing-helper') });
    } catch (e) {
      err = e;
    }
    check(err?.code === 'ECHECKPASS', 'missing helper -> ECHECKPASS (never a success)');
    err = null;
    try {
      await auth.checkPassword('x', { helper: HELPER, args: ['--bogus'] });
    } catch (e) {
      err = e;
    }
    check(err?.code === 'ECHECKPASS', 'helper usage error -> ECHECKPASS');
  }

  section('static: PAM service, packages, strings');
  {
    const pam = fs.readFileSync(path.join(REPO, 'rootfs', 'etc', 'pam.d', 'aurora-lock'), 'utf8');
    check(/^@include common-auth$/m.test(pam) && /^@include common-account$/m.test(pam), 'aurora-lock PAM service = common-auth + common-account');
    const pkgs = fs.readFileSync(path.join(REPO, 'iso', 'packages.d', 'login.list'), 'utf8');
    for (const p of ['greetd', 'python3', 'libpam-modules', 'x11-xkb-utils']) check(new RegExp(`^${p}$`, 'm').test(pkgs), `login.list has ${p}`);
    const src = fs.readFileSync(path.join(ROOT, 'renderer', 'core', 'greeter', 'strings.js'), 'utf8');
    const { STRINGS } = await import(`data:text/javascript;base64,${Buffer.from(src).toString('base64')}`);
    const keys = (o, pre = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? keys(v, `${pre}${k}.`) : [`${pre}${k}`]));
    const en = keys(STRINGS.en).sort();
    const fr = keys(STRINGS.fr).sort();
    check(JSON.stringify(en) === JSON.stringify(fr), `EN/FR string keys match (${en.filter((k) => !fr.includes(k)).concat(fr.filter((k) => !en.includes(k)))})`);
    const html = fs.readFileSync(path.join(ROOT, 'renderer', 'greeter.html'), 'utf8');
    check(html.includes('core/greeter/greeter.js') && !/boot\.js|shell\.css/.test(html), 'greeter.html loads only the sign-in screen');
  }
}

// ======================================================================= E2E helpers
async function launchRaw({ env = {}, settings = {}, size = '1600x900', mode = 'shell' } = {}) {
  const home = fs.mkdtempSync(path.join(TMP, 'home-'));
  for (const d of ['Desktop', 'Documents', 'Downloads', 'Pictures', 'Music', 'Videos']) fs.mkdirSync(path.join(home, d), { recursive: true });
  fs.mkdirSync(path.join(home, '.config', 'aurora'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config', 'aurora', 'settings.json'), JSON.stringify(settings));
  const app = await electron.launch({
    executablePath: require('electron'),
    args: [ROOT, '--dev', '--no-sandbox', `--size=${size}`, `--mode=${mode}`],
    env: { ...process.env, HOME: home, AURORA_LIVE: '0', LANG: settings.lang === 'fr' ? 'fr_FR.UTF-8' : 'en_US.UTF-8', ...env },
    timeout: 60000,
  });
  const page = await app.firstWindow();
  const logs = [];
  page.on('console', (m) => {
    logs.push(`[${m.type()}] ${m.text()}`);
    if (m.type() === 'error') console.log(`[renderer:error] ${m.text()}`);
  });
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
  return { app, page, logs, home, close: () => app.close().catch(() => {}) };
}

function waitClose(app, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    app.once('close', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function greeter(opts = {}) {
  const state = opts.state || fs.mkdtempSync(path.join(TMP, 'gstate-'));
  const s = await launchShell({ mode: 'greeter', size: opts.size, lang: opts.lang, settle: 200, settings: opts.settings, live: opts.live, env: { AURORA_GREETER_STATE: state, ...(opts.env || {}) } });
  await s.page.waitForSelector('body.ready', { timeout: 30000 });
  await s.page.waitForTimeout(opts.settle ?? 1700);
  return { ...s, state };
}

const q = (page, sel) => page.$(sel);
const text = (page, sel) => page.$eval(sel, (e) => e.textContent.trim()).catch(() => '');
const visible = (page, sel) =>
  page
    .$eval(sel, (e) => {
      const r = e.getBoundingClientRect();
      const cs = getComputedStyle(e);
      return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
    })
    .catch(() => false);

// Layout sanity: nothing clipped or overlapping in the sign-in view.
async function layoutProblems(page) {
  return page.evaluate(() => {
    const out = [];
    const vw = innerWidth;
    const vh = innerHeight;
    const rect = (s) => document.querySelector(s)?.getBoundingClientRect();
    const inside = (r) => r && r.left >= -1 && r.top >= -1 && r.right <= vw + 1 && r.bottom <= vh + 1;
    for (const s of ['.lk-card', '.lk-tray', '.lk-users', '.lk-field:not([hidden])', '.lk-link:not([hidden])']) {
      const r = rect(s);
      if (r && r.width && !inside(r)) out.push(`${s} outside the screen`);
    }
    const overlap = (a, b) => a && b && a.width && b.width && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    const card = rect('.lk-card');
    const users = rect('.lk-users');
    const tray = rect('.lk-tray');
    if (overlap(card, users)) out.push('card overlaps the user list');
    if (overlap(card, tray)) out.push('card overlaps the tray');
    if (overlap(users, tray)) out.push('user list overlaps the tray');
    for (const el of document.querySelectorAll('.lk-msg, .lk-link, .lk-name, .lk-user-name, .lk-help, .lk-busy-text, .lk-signin-btn, .lk-dialog-title, .lk-dialog-body, .lk-dbtn')) {
      if (!el.offsetParent) continue;
      if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).textOverflow !== 'ellipsis') out.push(`text overflows in .${el.className.split(' ')[0]}: "${el.textContent.slice(0, 40)}"`);
    }
    return out;
  });
}

// ======================================================================= greeter E2E (mock greetd)
async function greeterTests() {
  section('greeter (dev mock): curtain, sign-in, errors, users, EN');
  const s = await greeter({ lang: 'en' });
  const { page } = s;
  check(await visible(page, '.lk-curtain'), 'starts on the lock-screen picture');
  const time = await text(page, '.lk-time');
  check(/^\d{1,2}[:.h]\d{2}$/.test(time), `big clock shows the time (${time})`);
  check(/day/.test(await text(page, '.lk-date')), 'date with weekday');
  // Which modules does the sign-in screen load? (reload with request tracking: app:// loads are not in Resource Timing)
  const res = [];
  page.on('request', (r) => res.push(r.url()));
  await page.reload();
  await page.waitForSelector('body.ready', { timeout: 30000 });
  await page.waitForTimeout(1700);
  const desk = res.filter((n) => /core\/(boot|wm|taskbar|start|desktop|registry|services|notify|sounds)\.js|features\/|shell\.css|\/apps\//.test(n));
  check(res.length > 5 && desk.length === 0, `greeter loads no desktop modules (${desk})`);
  check(res.some((n) => n.includes('core/greeter/lockui.js')), 'greeter loads the shared lock UI');
  check(await page.evaluate(() => !window.__aurora && !document.getElementById('taskbar')), 'no shell globals or chrome in the greeter');
  await shot(page, 'login-curtain-en');
  // Typing on the curtain opens the sign-in view and keeps the character.
  await page.keyboard.press('k');
  await page.waitForTimeout(900);
  check(await page.$eval('.lockui', (e) => e.classList.contains('stage-signin')), 'a key press opens the sign-in view');
  check((await page.$eval('.lk-pw-field input', (e) => e.value)) === 'k', 'the typed character goes to the password box');
  check(await page.evaluate(() => document.activeElement?.classList.contains('lk-input')), 'password box focused');
  await page.fill('.lk-pw-field input', '');
  await page.waitForTimeout(300);
  check((await text(page, '.lk-name')) === 'Alex Morgan', 'remembered/first user selected');
  check((await page.$$('.lk-user')).length === 3, 'bottom-left user list (3 accounts)');
  check(await page.$eval('.lk-pw-field input', (e) => e.placeholder === 'Password'), 'placeholder');
  check((await layoutProblems(page)).length === 0, `layout OK: ${await layoutProblems(page)}`);
  await shot(page, 'login-signin-en');
  // Escape returns to the picture, a click opens the sign-in view again.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(800);
  check(await page.$eval('.lockui', (e) => e.classList.contains('stage-curtain')), 'Esc goes back to the picture');
  await page.mouse.click(800, 600);
  await page.waitForTimeout(900);
  check(await page.$eval('.lockui', (e) => e.classList.contains('stage-signin')), 'a click opens the sign-in view');
  // Wrong password.
  await page.fill('.lk-pw-field input', 'hunter2');
  check(await visible(page, '.lk-reveal'), 'reveal button appears with text');
  await page.click('.lk-reveal');
  check((await page.$eval('.lk-pw-field input', (e) => e.type)) === 'text', 'reveal shows the password');
  await page.keyboard.press('Alt+F8');
  check((await page.$eval('.lk-pw-field input', (e) => e.type)) === 'password', 'Alt+F8 hides it again');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  check(await page.$eval('.lockui', (e) => e.classList.contains('busy')), 'busy while checking');
  check((await text(page, '.lk-busy-text')) === 'Welcome', '"Welcome" + spinner while signing in');
  await shot(page, 'login-busy-en');
  await page.waitForTimeout(700);
  check(await page.$eval('.lk-pw-field', (e) => e.classList.contains('lk-shake')), 'shake animation on a wrong password');
  check(/password is incorrect/.test(await text(page, '.lk-msg')), 'error message');
  check((await page.$eval('.lk-pw-field input', (e) => e.value)) === '', 'password box cleared');
  await page.waitForTimeout(250);
  await shot(page, 'login-error-en');
  await page.click('.lk-link');
  await page.waitForTimeout(250);
  check(/administrator/.test(await text(page, '.lk-help')), '"I forgot my password" help');
  await shot(page, 'login-forgot-en');
  // Switch user from the bottom-left list.
  await page.click('.lk-user[data-user="camille"]');
  await page.waitForTimeout(500);
  check((await text(page, '.lk-name')) === 'Camille Laurent', 'clicking a user switches the account');
  check(await page.$eval('.lk-user[data-user="camille"]', (e) => e.classList.contains('selected')), 'selected user highlighted');
  check((await text(page, '.lk-msg')) === '', 'switching user clears the error');
  check(await page.$eval('.lk-avatar-slot img', (e) => e.complete && e.naturalWidth > 0).catch(() => false), 'account picture shown');
  await shot(page, 'login-users-en');
  // Keyboard: arrows move in the user list.
  await page.focus('.lk-user[data-user="camille"]');
  await page.keyboard.press('ArrowDown');
  check(await page.evaluate(() => document.activeElement?.dataset?.user === 'sam'), 'arrow keys move between accounts');
  // Power menu + input indicator.
  await page.click('.lk-power');
  await page.waitForSelector('.menu.lk-menu');
  const items = await page.$$eval('.menu.lk-menu .menu-item .label', (els) => els.map((e) => e.textContent));
  check(items.join('|') === 'Sleep|Shut down|Restart', `power menu (${items})`);
  await page.waitForTimeout(300);
  await shot(page, 'login-power-en');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  check(!(await q(page, '.menu.lk-menu')), 'Esc closes the menu');
  check(await page.$eval('.lockui', (e) => e.classList.contains('stage-signin')), 'Esc in a menu does not leave the sign-in view');
  check(!myErrors(s.logs).length, `no renderer errors: ${myErrors(s.logs)}`);
  await s.close();
}

async function greeterFrTests() {
  section('greeter (dev mock): French, keyboard layout, language passed to the session, quit');
  const s = await greeter({ lang: 'en' });
  const { page } = s;
  await page.mouse.click(800, 450);
  await page.waitForTimeout(900);
  await page.click('.lk-ind');
  await page.waitForSelector('.menu.lk-menu');
  await page.waitForTimeout(250);
  await shot(page, 'login-input-menu-en');
  await page.click('.menu.lk-menu .menu-item:has-text("Français")');
  await page.waitForTimeout(300);
  check((await page.$eval('html', (e) => e.lang)) === 'fr', 'language switched to French');
  check(await page.$eval('.lk-pw-field input', (e) => e.placeholder === 'Mot de passe'), 'placeholder re-rendered in French');
  check(/oublié/.test(await text(page, '.lk-link')), 'link in French');
  check((await text(page, '.lk-ind-lang')) === 'FRA', 'indicator shows FRA');
  const frDate = await text(page, '.lk-date');
  check(/^(Lundi|Mardi|Mercredi|Jeudi|Vendredi|Samedi|Dimanche) \d{1,2} [a-zéû]+$/.test(frDate), `date re-rendered in French (${frDate})`);
  await page.click('.lk-ind');
  await page.waitForSelector('.menu.lk-menu');
  await page.click('.menu.lk-menu .menu-item:has-text("Français (AZERTY)")');
  await page.waitForTimeout(300);
  check((await text(page, '.lk-ind-kb')) === 'FR', 'keyboard layout indicator shows FR');
  await page.click('.lk-user[data-user="camille"]');
  await page.fill('.lk-pw-field input', 'mauvais');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1000);
  check(/incorrect/.test(await text(page, '.lk-msg')), 'French error message');
  check((await layoutProblems(page)).length === 0, `French layout OK: ${await layoutProblems(page)}`);
  await shot(page, 'login-error-fr');
  await page.click('.lk-link');
  await page.waitForTimeout(250);
  check((await layoutProblems(page)).length === 0, `French help layout OK: ${await layoutProblems(page)}`);
  await page.click('.lk-link');
  await page.click('.lk-a11y');
  await page.waitForSelector('.menu.lk-menu');
  const a11y = await page.$$eval('.menu.lk-menu .menu-item .label', (els) => els.map((e) => e.textContent));
  check(a11y.includes('Texte plus grand') && a11y.includes('Effets d’animation'), `accessibility menu in French (${a11y})`);
  await page.waitForTimeout(250);
  await shot(page, 'login-a11y-fr');
  await page.keyboard.press('Escape');
  await page.click('.lk-power');
  await page.waitForSelector('.menu.lk-menu');
  await page.waitForTimeout(250);
  await shot(page, 'login-power-fr');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  await page.fill('.lk-pw-field input', 'aurora');
  const closed = waitClose(s.app, 8000);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(250);
  check((await text(page, '.lk-busy-text')) === 'Bienvenue', '"Bienvenue" while signing in');
  await shot(page, 'login-welcome-fr');
  check(await closed, 'the greeter quits after a successful sign-in (greetd then starts the session)');
  const st = JSON.parse(fs.readFileSync(path.join(s.state, 'greeter-state.json'), 'utf8'));
  check(st.lastUser === 'camille' && st.lang === 'fr' && st.keyboard === 'fr', `state remembered (${JSON.stringify(st)})`);
  check(!myErrors(s.logs).length, `no renderer errors: ${myErrors(s.logs)}`);
  await s.close();

  section('greeter: remembers the last user + language');
  const s2 = await greeter({ state: s.state });
  await s2.page.mouse.click(800, 450);
  await s2.page.waitForTimeout(900);
  check((await text(s2.page, '.lk-name')) === 'Camille Laurent', 'last signed-in user preselected');
  check((await s2.page.$eval('html', (e) => e.lang)) === 'fr', 'last chosen language restored');
  check((await text(s2.page, '.lk-ind-kb')) === 'FR', 'last keyboard layout restored');
  await shot(s2.page, 'login-signin-fr');
  const s2curtainBack = async () => {
    await s2.page.keyboard.press('Escape');
    await s2.page.waitForTimeout(800);
  };
  await s2curtainBack();
  await shot(s2.page, 'login-curtain-fr');
  check(!myErrors(s2.logs).length, `no renderer errors: ${myErrors(s2.logs)}`);
  await s2.close();
}

async function greeterVariants() {
  section('greeter: live (passwordless) user, no users, resolutions, animations off');
  {
    const s = await greeter({ live: true, env: { AURORA_MOCK_USERS: '2' } });
    await s.page.keyboard.press('Enter');
    await s.page.waitForTimeout(900);
    check((await text(s.page, '.lk-name')) === 'Aurora Live', 'live user first');
    check(await visible(s.page, '.lk-signin-btn'), '"Sign in" button instead of a password box');
    check(!(await visible(s.page, '.lk-pw-field')), 'no password box for the live user');
    await shot(s.page, 'login-live-en');
    const closed = waitClose(s.app, 8000);
    await s.page.click('.lk-signin-btn');
    check(await closed, 'live user signs in with one click');
    await s.close();
  }
  {
    const s = await greeter({ env: { AURORA_MOCK_USERS: '0' } });
    await s.page.keyboard.press('Enter');
    await s.page.waitForTimeout(900);
    check((await text(s.page, '.lk-name')) === 'Other user', '"Other user" when no account is listed');
    check(await visible(s.page, '.lk-user-field'), 'user name box');
    check(await s.page.evaluate(() => document.activeElement?.classList.contains('lk-user-input')), 'user name box focused');
    await s.page.keyboard.type('alex');
    await s.page.keyboard.press('Tab');
    await s.page.keyboard.type('nope');
    await s.page.keyboard.press('Enter');
    await s.page.waitForTimeout(1000);
    check(/incorrect/.test(await text(s.page, '.lk-msg')), 'other user: wrong password error');
    await shot(s.page, 'login-other-user-en');
    await s.close();
  }
  const sizes = QUICK ? ['1280x720'] : ['1280x720', '1024x768', '1920x1080', '800x600'];
  for (const size of sizes) {
    const s = await greeter({ size, lang: size === '1024x768' ? 'fr' : 'en', settle: 1200 });
    const vp = await s.page.evaluate(() => `${innerWidth}x${innerHeight}`);
    await s.page.keyboard.press('Enter');
    await s.page.waitForTimeout(900);
    await s.page.fill('.lk-pw-field input', 'x');
    await s.page.keyboard.press('Enter');
    await s.page.waitForTimeout(1000);
    const probs = await layoutProblems(s.page);
    check(probs.length === 0, `${size} (viewport ${vp}): ${probs}`);
    await shot(s.page, `login-signin-${size}`);
    await s.close();
  }
  {
    const s = await greeter({ settings: { animations: false } });
    check((await s.page.$eval('html', (e) => e.dataset.animations)) === 'off', 'system "animations off" honoured');
    await s.page.keyboard.press('Enter');
    await s.page.waitForTimeout(150);
    check(await s.page.$eval('.lockui', (e) => e.classList.contains('stage-signin')), 'sign-in view (no animation)');
    await s.close();
  }
}

// ======================================================================= greeter against a fake greetd
async function greeterRealProtocol() {
  section('greeter <-> fake greetd over $GREETD_SOCK (real client in the Electron main process)');
  const sock = path.join(TMP, 'greetd-e2e.sock');
  const g = await fakeGreetd(sock, { users: { marie: 's3cret' }, info: true });
  const passwd = path.join(TMP, 'passwd');
  fs.writeFileSync(
    passwd,
    ['root:x:0:0:root:/root:/bin/bash', 'marie:x:1000:1000:Marie Curie,,,:/home/marie:/bin/bash', 'leo:x:1001:1001:Léo Martin:/home/leo:/bin/bash', 'svc:x:1002:1002::/srv:/usr/sbin/nologin'].join('\n'),
  );
  const s = await greeter({ env: { GREETD_SOCK: sock, AURORA_GREETER_PASSWD: passwd } });
  const { page } = s;
  const info = await page.evaluate(() => window.aurora.invoke('greeter:info'));
  check(info.mock === false, 'real greetd client (not the dev mock)');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(900);
  const names = await page.$$eval('.lk-user .lk-user-name', (els) => els.map((e) => e.textContent));
  check(names.join('|') === 'Léo Martin|Marie Curie', `users from passwd (${names})`);
  await page.click('.lk-user:has-text("Marie Curie")');
  await page.fill('.lk-pw-field input', 'wrong');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(800);
  check(/incorrect/.test(await text(page, '.lk-msg')), 'greetd auth_error -> wrong password message');
  check(g.log.some((r) => r.type === 'cancel_session'), 'failed session cancelled');
  check(g.log[0]?.type === 'create_session' && g.log[0].username === 'marie', 'create_session for the selected user');
  // Choose French, sign in for real.
  await page.click('.lk-ind');
  await page.waitForSelector('.menu.lk-menu');
  await page.click('.menu.lk-menu .menu-item:has-text("Français")');
  await page.waitForTimeout(200);
  await page.fill('.lk-pw-field input', 's3cret');
  const closed = waitClose(s.app, 8000);
  await page.keyboard.press('Enter');
  check(await closed, 'greeter exits once greetd accepted start_session');
  const st = g.state.started;
  check(st?.user === 'marie', 'session started for marie');
  check(JSON.stringify(st?.cmd) === '["/usr/bin/aurora-session"]', 'cmd = /usr/bin/aurora-session');
  check(st?.env?.includes('LANG=fr_FR.UTF-8') && st.env.includes('AURORA_LANG=fr'), `env passes the language chosen at sign-in (${st?.env})`);
  const types = g.log.map((r) => r.type);
  check(types.at(-1) === 'start_session', `protocol sequence ends with start_session (${types})`);
  check(!myErrors(s.logs).length, `no renderer errors: ${myErrors(s.logs)}`);
  await s.close();
  await g.close();
}

// ======================================================================= lock screen E2E
async function lockTests(theme, lang) {
  section(`lock screen in the desktop session (${theme}, ${lang})`);
  const s = await launchShell({ theme, lang, open: ['calculator'] });
  const { page } = s;
  await page.waitForTimeout(600);
  await s.aurora(() => {
    window.__aurora.notify({ title: 'Build finished', body: 'aurora.iso is ready', appId: 'calculator', silent: true });
    window.__aurora.notify({ title: 'Reminder', body: 'Stand-up at 10:00', silent: true });
    window.__aurora.notify({ title: 'Update', body: 'x', silent: true });
  });
  await page.waitForTimeout(300);
  const calc = await page.$eval('.app-calculator', (e) => {
    const r = e.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  let unlocks = 0;
  await page.exposeFunction('__unlocked', () => unlocks++);
  await s.aurora(() => window.__aurora.shell.on('unlock', () => window.__unlocked()));
  // Lock with the real Super+L key (main-process hotkeys) — fall back to the shell API.
  await page.keyboard.press('Meta+l');
  await page.waitForTimeout(400);
  let via = (await s.aurora(() => window.__aurora.lockScreen.locked)) ? 'the Super+L key' : '';
  if (!via) {
    // Synthetic CDP key events do not go through the main-process hotkey hook: trigger the same action.
    await s.aurora(() => window.__aurora.hotkeys?.trigger('Super+L'));
    await page.waitForTimeout(200);
    via = (await s.aurora(() => window.__aurora.lockScreen.locked)) ? 'the Super+L hotkey action' : '';
  }
  if (!via) {
    await s.aurora(() => window.__aurora.shell.lock());
    via = 'shell.lock()';
  }
  console.log(`  (locked with ${via})`);
  check(via !== 'shell.lock()', 'Super+L locks the session');
  await page.waitForTimeout(1400);
  check(await s.aurora(() => window.__aurora.lockScreen.locked), 'locked');
  check(await page.$eval('#overlays > .lockui', () => true).catch(() => false), 'lock screen in #overlays');
  check(await page.evaluate(() => ['desktop', 'windows', 'taskbar'].every((id) => document.getElementById(id).inert)), 'desktop, windows and taskbar are inert');
  const hit = await page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest('.lockui'), calc);
  check(hit, 'pointer input over a window reaches the lock screen, not the window');
  check(await page.evaluate(() => !document.activeElement || document.activeElement === document.body || !!document.activeElement.closest('.lockui')), 'keyboard focus is not in a window');
  const badges = await page.$$eval('.lk-badge', (els) => els.map((e) => e.textContent));
  check(badges.length === 2 && badges.includes('2') && badges.includes('1'), `notification counts on the lock screen (${badges})`);
  // A dialog that opens while locked stays behind and cannot take the keyboard.
  await s.aurora(() => {
    window.__lockTestDialog = window.__aurora.ui.prompt({ title: 'Behind', label: 'x' });
  });
  await page.waitForTimeout(400);
  check(await page.evaluate(() => !!document.querySelector('#overlays > .dialog-layer')?.inert), 'a dialog opened while locked is inert');
  check(await page.evaluate(() => !document.activeElement || document.activeElement === document.body || !!document.activeElement.closest('.lockui')), 'focus stays on the lock screen');
  await shot(page, `lock-curtain-${theme}-${lang}`);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(900);
  check(await visible(page, '.lk-switch'), '"Switch user" bottom-left');
  check(!(await visible(page, '.lk-ind')), 'no language switcher on the lock screen');
  await shot(page, `lock-signin-${theme}-${lang}`);
  await page.keyboard.type('wrong');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(900);
  check(await page.$eval('.lk-pw-field', (e) => e.classList.contains('lk-shake')), 'shake on a wrong password');
  check((await text(page, '.lk-msg')).length > 5, 'error message');
  check(await s.aurora(() => window.__aurora.lockScreen.locked), 'still locked after a wrong password');
  check((await layoutProblems(page)).length === 0, `layout OK: ${await layoutProblems(page)}`);
  await shot(page, `lock-error-${theme}-${lang}`);
  // Switch user dialog (cancelled).
  await page.click('.lk-switch');
  await page.waitForSelector('.lk-dialog');
  await page.waitForTimeout(300);
  check((await layoutProblems(page)).length === 0, `dialog layout OK: ${await layoutProblems(page)}`);
  await shot(page, `lock-switch-${theme}-${lang}`);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  check(!(await q(page, '.lk-dialog-layer:not(.closing)')), 'Esc cancels the dialog');
  // Power menu with the warning dialog.
  await page.click('.lk-power');
  await page.waitForSelector('.menu.lk-menu');
  await page.click('.menu.lk-menu .menu-item:nth-child(2)');
  await page.waitForSelector('.lk-dialog');
  await page.waitForTimeout(300);
  await shot(page, `lock-power-${theme}-${lang}`);
  await page.click('.lk-dialog .lk-dbtn:not(.primary)');
  await page.waitForTimeout(250);
  // Unlock.
  await page.fill('.lk-pw-field input', 'aurora');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1200);
  check(!(await s.aurora(() => window.__aurora.lockScreen.locked)), 'unlocked with the right password');
  check(await page.evaluate(() => !document.querySelector('#overlays > .dialog-layer')?.inert), 'the dialog is usable again after unlocking');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  check(unlocks === 1, `'unlock' emitted once (${unlocks})`);
  check(!(await q(page, '.lockui')), 'lock screen removed after the fade');
  check(await page.evaluate(() => !document.getElementById('windows').inert && !document.getElementById('taskbar').inert), 'input restored');
  check(!(await page.evaluate(() => document.body.classList.contains('aurora-locked'))), 'body class cleared');
  // Hotkeys work again after unlocking (Super+L locks again).
  await s.aurora(() => window.__aurora.shell.lock());
  await page.waitForTimeout(300);
  check(await s.aurora(() => window.__aurora.lockScreen.locked), 'locks again');
  await page.keyboard.press('a');
  await page.waitForTimeout(700);
  await page.keyboard.type('urora');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1200);
  check(!(await s.aurora(() => window.__aurora.lockScreen.locked)), 'typing on the picture goes straight into the password box');
  check(!myErrors(s.logs).length, `no renderer errors: ${myErrors(s.logs)}`);
  await s.close();
}

async function lockExtraTests() {
  section('lock screen: rate limiting');
  {
    const s = await launchShell({ theme: 'dark', lang: 'en' });
    const { page } = s;
    await s.aurora(() => window.__aurora.shell.lock());
    await page.waitForTimeout(800);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(800);
    for (let i = 0; i < 5; i++) {
      await page.fill('.lk-pw-field input', `wrong${i}`);
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => !document.querySelector('.lockui')?.classList.contains('busy'), null, { timeout: 5000 });
      await page.waitForTimeout(80);
    }
    await page.waitForTimeout(400);
    const msg = await text(page, '.lk-msg');
    check(/Too many attempts\. Try again in (29|30) seconds/.test(msg), `countdown after 5 failures (${msg})`);
    check(await page.$eval('.lk-pw-field input', (e) => e.disabled), 'password box disabled while rate-limited');
    const st = await page.evaluate(() => window.aurora.invoke('auth:status'));
    check(st.retryAfter > 25000 && st.failures === 5, 'backend enforces the wait');
    const err = await page.evaluate(() => window.__aurora.api.invoke('auth:verify', 'aurora').then(() => null, (e) => e.code));
    check(err === 'ERATE', `backend refuses attempts meanwhile (${err})`);
    await shot(page, 'lock-rate-dark-en');
    await s.close();
  }

  section('lock screen: live session (no password)');
  {
    const s = await launchShell({ theme: 'light', lang: 'fr', live: true });
    const { page } = s;
    await s.aurora(() => window.__aurora.shell.lock());
    await page.waitForTimeout(900);
    await page.mouse.click(700, 500);
    await page.waitForTimeout(900);
    check(await visible(page, '.lk-signin-btn'), '"Se connecter" button');
    check((await text(page, '.lk-signin-btn')) === 'Se connecter', 'French label');
    await shot(page, 'lock-live-light-fr');
    await page.click('.lk-signin-btn');
    await page.waitForTimeout(900);
    check(!(await s.aurora(() => window.__aurora.lockScreen.locked)), 'unlocked without a password');
    await s.close();
  }

  section('lock screen: transparency and animation effects off');
  {
    const s = await launchShell({ theme: 'dark', lang: 'en', settings: { transparency: false, animations: false } });
    const { page } = s;
    await s.aurora(() => window.__aurora.shell.lock());
    await page.waitForTimeout(200);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
    check(await page.$eval('.lockui', (e) => e.classList.contains('stage-signin')), 'sign-in view at once with animations off');
    const bg = await page.$eval('.lk-pw-field', (e) => getComputedStyle(e).backgroundColor);
    check(/^rgb\(/.test(bg), `opaque password box with transparency off (${bg})`);
    await page.fill('.lk-pw-field input', 'aurora');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(900);
    check(!(await q(page, '.lockui')), 'unlocks and disappears without animations');
    check(!myErrors(s.logs).length, `no renderer errors: ${myErrors(s.logs)}`);
    await s.close();
  }

  section('lock screen: automatic lock after inactivity');
  {
    const s = await launchShell({ theme: 'light', lang: 'en', settings: { lockTimeout: 0.05 } });
    const { page } = s;
    // Activity keeps it unlocked…
    for (let i = 0; i < 10; i++) {
      await page.mouse.move(300 + i * 10, 300);
      await page.waitForTimeout(400);
    }
    check(!(await s.aurora(() => window.__aurora.lockScreen.locked)), 'pointer activity keeps the session unlocked');
    // …inactivity locks it.
    await page.waitForTimeout(5000);
    check(await s.aurora(() => window.__aurora.lockScreen.locked), 'locked after lockTimeout of inactivity');
    const idle = await page.evaluate(() => window.aurora.invoke('auth:idle'));
    check(typeof idle === 'number' && idle >= 0, `system idle time available (${idle}s)`);
    await s.close();
  }
}

// ======================================================================= welcome
async function welcomeTests() {
  section('session Welcome transition');
  const w = await launchRaw({ env: { AURORA_WELCOME: '1', AURORA_WELCOME_HOLD: '2500' }, settings: { theme: 'dark', lang: 'fr' } });
  const { page } = w;
  await page.waitForSelector('.lk-welcome', { timeout: 30000 });
  const early = await page.evaluate(() => document.body.classList.contains('ready'));
  check(!early, 'Welcome covers the screen while the desktop is still loading');
  // Screenshot as soon as the overlay is styled (it stays about one second).
  await page.waitForFunction(
    () => {
      const c = document.querySelector('.lk-welcome .lk-card');
      return c && getComputedStyle(c).opacity === '1' && document.querySelector('.lk-welcome .lk-blur.ready');
    },
    null,
    { polling: 16, timeout: 3000 },
  ).catch(() => {});
  check((await text(page, '.lk-welcome .lk-busy-text')) === 'Bienvenue', 'French "Bienvenue"');
  check(await visible(page, '.lk-welcome .lk-spinner'), 'spinner visible');
  await shot(page, 'login-session-welcome-dark-fr');
  await page.waitForSelector('body.ready', { timeout: 30000 });
  await page.waitForSelector('.lk-welcome', { state: 'detached', timeout: 7000 }).catch(() => {});
  check(!(await q(page, '.lk-welcome')), 'Welcome fades into the desktop');
  const span = await page.evaluate(() => {
    const a = performance.getEntriesByName('aurora:welcome-shown')[0];
    const b = performance.getEntriesByName('aurora:welcome-finish')[0];
    return a && b ? Math.round(b.startTime - a.startTime) : -1;
  });
  check(span >= 900 + 2500 - 50 && span < 2500 + 4000, `held for the minimum time, then revealed (${span} ms incl. 2500 ms test hold)`);
  check(await page.evaluate(() => window.__aurora?.welcome?.done === true), 'welcome done');
  check(!(await page.evaluate(() => window.aurora.invoke('session:welcome'))), 'only once per session');
  await page.waitForTimeout(800);
  await shot(page, 'login-session-desktop-dark-fr');
  check(!myErrors(w.logs).length, `no renderer errors: ${myErrors(w.logs)}`);
  await w.close();

  // Natural duration (no hold): about one second.
  const w1 = await launchRaw({ env: { AURORA_WELCOME: '1' }, settings: { theme: 'light', lang: 'en' } });
  await w1.page.waitForSelector('body.ready', { timeout: 30000 });
  await w1.page.waitForTimeout(2200);
  const natural = await w1.page.evaluate(() => {
    const a = performance.getEntriesByName('aurora:welcome-shown')[0];
    const b = performance.getEntriesByName('aurora:welcome-finish')[0];
    return a && b ? Math.round(b.startTime - a.startTime) : -1;
  });
  check(natural >= 850 && natural < 2500, `Welcome lasts about a second (${natural} ms before the fade)`);
  check(!(await q(w1.page, '.lk-welcome')), 'gone afterwards');
  await w1.close();

  // Skippable.
  const w2 = await launchRaw({ env: { AURORA_WELCOME: '1' }, settings: { theme: 'light', lang: 'en' } });
  await w2.page.waitForSelector('.lk-welcome', { timeout: 30000 });
  await w2.page.waitForTimeout(150);
  await w2.page.mouse.click(400, 400);
  await w2.page.waitForSelector('.lk-welcome', { state: 'detached', timeout: 1500 }).catch(() => {});
  check(!(await q(w2.page, '.lk-welcome')), 'a click skips the Welcome');
  await w2.close();

  // Not shown with animations off, nor without AURORA_WELCOME in dev (other tests are unaffected).
  const w3 = await launchRaw({ env: { AURORA_WELCOME: '1' }, settings: { animations: false } });
  await w3.page.waitForSelector('body.ready', { timeout: 30000 });
  check(!(await q(w3.page, '.lk-welcome')), 'no Welcome with animations off');
  await w3.close();
  const w4 = await launchShell({});
  check(!(await q(w4.page, '.lk-welcome')), 'no Welcome in dev runs unless AURORA_WELCOME=1');
  await w4.close();
}

// ======================================================================= main
// --only=unit,greeter,greeter-fr,protocol,variants,lock,lock-extra,welcome  runs a subset.
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
const want = (name) => !ONLY.length || ONLY.includes(name);
try {
  if (want('unit')) await unitTests();
  if (!UNIT_ONLY) {
    if (want('greeter')) await greeterTests();
    if (want('greeter-fr')) await greeterFrTests();
    if (want('protocol')) await greeterRealProtocol();
    if (want('variants')) await greeterVariants();
    if (want('lock')) {
      await lockTests('light', 'en');
      await lockTests('dark', 'fr');
    }
    if (want('lock-extra')) await lockExtraTests();
    if (want('welcome')) await welcomeTests();
  }
} catch (err) {
  failures++;
  console.log(`  ✗ test crashed: ${err.stack || err}`);
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
