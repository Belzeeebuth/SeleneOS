'use strict';
// User accounts.
//
//   users:list                     -> [{ name, fullName, uid, admin, current, home, picture }]   human accounts (uid 1000-59999)
//   users:current                  -> the signed-in user (same shape)
//   users:setPicture (pngBytes)    -> writes ~/.face (account picture shown by Start, the lock and sign-in screens)
//   users:removePicture ()
//   users:changePassword (current, next)   -> true   errors: EAUTH (current password wrong), EWEAK (rejected by
//                                     the password policy; message says why), ECMD
//   event users:changed            after a picture change (and, in dev mode, after simulated admin actions)
//
// Account management (add / remove / change type / reset another user's password / automatic sign-in)
// goes through the elevation helper: shell.runAdmin('user-add', [name, fullName, '0|1', password]) etc.
// (see admin.js). Changing one's OWN password needs no administrator rights: `passwd` is driven
// through its prompts (it reads them from a pipe through PAM's conversation function).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { which } = require('../lib/exec');

const FACE_NAMES = ['.face', '.face.icon'];

// ------------------------------------------------------------------ parsers (unit-tested)
/** /etc/passwd + /etc/group -> human accounts */
function parseUsers(passwdText, groupText, currentName) {
  const admins = new Set();
  for (const line of String(groupText || '').split('\n')) {
    const [name, , , members] = line.split(':');
    if (['sudo', 'admin', 'wheel'].includes(name)) for (const m of (members || '').split(',')) if (m) admins.add(m.trim());
  }
  const out = [];
  for (const line of String(passwdText || '').split('\n')) {
    const f = line.split(':');
    if (f.length < 7) continue;
    const [name, , uidS, , gecos, home, shellPath] = f;
    const uid = Number(uidS);
    if (!(uid >= 1000 && uid < 60000)) continue;
    if (/(nologin|false)$/.test(shellPath || '')) continue;
    out.push({ name, fullName: (gecos || '').split(',')[0] || name, uid, admin: admins.has(name), current: name === currentName, home });
  }
  return out.sort((a, b) => (b.current ? 1 : 0) - (a.current ? 1 : 0) || a.uid - b.uid);
}

/** Classify passwd's output after a failed run (unit-tested). */
function passwdFailure(text) {
  const t = String(text || '');
  if (/Authentication token manipulation error|Authentication failure|authentication information cannot be recovered/i.test(t)) return { code: 'EAUTH', message: 'The current password is incorrect' };
  const bad =
    /BAD PASSWORD:\s*(.+)/.exec(t) ||
    /(You must choose a longer password\.?)/.exec(t) ||
    /(Bad: new password is too simple|Bad: new and old password are too similar|The password is too similar to the old one)/i.exec(t) ||
    /^(Password unchanged)/m.exec(t) ||
    /(Sorry, passwords do not match\.?)/i.exec(t);
  if (bad) return { code: 'EWEAK', message: bad[1].trim() };
  const last = t.split('\n').map((l) => l.trim()).filter(Boolean).pop() || 'passwd failed';
  return { code: 'ECMD', message: last.replace(/^passwd:\s*/, '') };
}

const parsers = { parseUsers, passwdFailure };

function err(message, code) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function pictureOf(home) {
  if (!home) return null;
  for (const n of FACE_NAMES) {
    const p = path.join(home, n);
    try {
      fs.accessSync(p, fs.constants.R_OK);
      if (fs.statSync(p).size > 0) return p;
    } catch {}
  }
  return null;
}

/** Drive `passwd` through its prompts: current password (if any), new, retype. */
function runPasswd(current, next) {
  return new Promise((resolve, reject) => {
    const bin = which('passwd');
    if (!bin) return reject(err('passwd is not available', 'ENOTSUP'));
    const child = spawn(bin, [], { env: { ...process.env, LC_ALL: 'C', LANG: 'C', LANGUAGE: '' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let text = '';
    let seen = 0; // index in `text` after the last answered prompt
    let step = 0; // 0: waiting for current/new, 1: waiting for new, 2: waiting for retype, 3: answered everything
    let failed = null;
    const timer = setTimeout(() => {
      failed = failed || { code: 'ETIMEDOUT', message: 'passwd did not answer' };
      child.kill('SIGKILL');
    }, 20000);
    const write = (s) => {
      try {
        child.stdin.write(`${s}\n`);
      } catch {}
    };
    const onData = (d) => {
      text += String(d);
      const tail = text.slice(seen);
      if (/Authentication token manipulation error|Authentication failure/i.test(tail) || (step >= 1 && /BAD PASSWORD|You must choose a longer|Bad: |^Password unchanged|do not match/im.test(tail))) {
        failed = passwdFailure(tail);
        child.kill('SIGTERM');
        return;
      }
      if (/(retype|re-enter|repeat)[^:\n]*password:\s*$/i.test(tail) && step >= 1) {
        seen = text.length;
        step = 3;
        write(next);
      } else if (/new[^:\n]*password:\s*$/i.test(tail) && step <= 1) {
        seen = text.length;
        step = 2;
        write(next);
      } else if (/(current|old|\(current\) unix)[^:\n]*password:\s*$/i.test(tail) && step === 0) {
        seen = text.length;
        step = 1;
        write(current ?? '');
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.stdin.on('error', () => {});
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && !failed) return resolve(true);
      const f = failed || passwdFailure(text);
      reject(err(f.message, f.code));
    });
  });
}

// ------------------------------------------------------------------ registration
function register(api) {
  const useMock = api.DEV && process.env.AURORA_REAL_BACKENDS !== '1';
  const me = os.userInfo();
  const home = os.homedir();
  let dev = null;
  if (useMock) {
    dev = require('./admin').dev;
    if (!dev.users) {
      const name = me.username === 'root' ? 'aurora' : me.username;
      const gecos = (readText('/etc/passwd').split('\n').find((l) => l.startsWith(`${me.username}:`)) || '').split(':')[4];
      const fullName = me.username === 'root' ? 'Selene User' : (gecos || '').split(',')[0] || name;
      dev.users = [
        { name, fullName, uid: me.uid >= 1000 ? me.uid : 1000, admin: true, current: true, home },
        { name: 'marie', fullName: 'Marie Dupont', uid: 1001, admin: false, current: false, home: '/home/marie' },
        { name: 'lucas', fullName: 'Lucas Bernard', uid: 1002, admin: true, current: false, home: '/home/lucas' },
      ];
      dev.passwords[name] = 'aurora';
    }
    dev.listeners.add((what) => what === 'users' && api.broadcast('users:changed', {}));
  }

  function list() {
    const users = useMock ? dev.users.map((u) => ({ ...u })) : parseUsers(readText('/etc/passwd'), readText('/etc/group'), me.username);
    for (const u of users) u.picture = u.current ? pictureOf(home) : useMock ? null : pictureOf(u.home);
    if (!users.some((u) => u.current)) {
      // root, or an account outside the human uid range (dev containers): describe it anyway
      const gecos = (readText('/etc/passwd').split('\n').find((l) => l.startsWith(`${me.username}:`)) || '').split(':')[4];
      users.unshift({ name: me.username, fullName: (gecos || '').split(',')[0] || me.username, uid: me.uid, admin: me.uid === 0, current: true, home, picture: pictureOf(home) });
    }
    return users;
  }

  api.handle('users:list', () => list());
  api.handle('users:current', () => list().find((u) => u.current));

  api.handle('users:setPicture', (bytes) => {
    const buf = Buffer.from(bytes || []);
    if (!buf.length || buf.length > 8 * 1024 * 1024) throw err('Invalid picture', 'EINVAL');
    const isPng = buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const isJpeg = buf[0] === 0xff && buf[1] === 0xd8;
    if (!isPng && !isJpeg) throw err('The picture must be a PNG or JPEG image', 'EINVAL');
    const file = path.join(home, '.face');
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, buf, { mode: 0o644 });
    fs.renameSync(tmp, file);
    try {
      const icon = path.join(home, '.face.icon');
      if (fs.lstatSync(icon).isFile()) fs.copyFileSync(file, icon);
    } catch {}
    api.broadcast('users:changed', { picture: file });
    return file;
  });
  api.handle('users:removePicture', () => {
    for (const n of FACE_NAMES) {
      try {
        fs.unlinkSync(path.join(home, n));
      } catch {}
    }
    api.broadcast('users:changed', { picture: null });
    return true;
  });

  api.handle('users:changePassword', async (current, next) => {
    if (typeof next !== 'string' || !next.length) throw err('The new password cannot be empty', 'EWEAK');
    if (/[\r\n\0]/.test(next) || /[\r\n\0]/.test(String(current ?? ''))) throw err('Passwords cannot contain line breaks', 'EINVAL');
    if (useMock) {
      await new Promise((r) => setTimeout(r, 400));
      const u = dev.users.find((x) => x.current);
      if ((dev.passwords[u.name] ?? '') !== String(current ?? '')) throw err('The current password is incorrect', 'EAUTH');
      if (next.length < 4) throw err('The password is shorter than 4 characters', 'EWEAK');
      dev.passwords[u.name] = next;
      return true;
    }
    if (me.uid === 0) throw err('Use an administrator action to change this account password', 'EPERM');
    return runPasswd(String(current ?? ''), next);
  });
}

module.exports = register;
module.exports.parsers = parsers;
module.exports.runPasswd = runPasswd;
