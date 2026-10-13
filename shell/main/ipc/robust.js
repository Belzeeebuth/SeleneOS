'use strict';
// Robustness backend (track "robust"): safe mode, settings recovery notices, low disk space, diagnostic report.
//   robust:status          -> { safeMode, safeReason, lookKeys, settingsRecovered, saveFailed, lowDisk, acked }
//   robust:ack (what)      -> marks a notice as shown ('settings' | 'save' | 'disk'): told once per session
//   robust:leaveSafeMode   -> safe mode off, then the shell window reloads normally (the session stays locked if it was)
//   robust:report          -> { path, name, files } ~/selene-diagnostic-<date>.tar.gz (see REPORT_NOTICE)
// Events: 'robust:changed' (status) when a notice appears (save failure, low disk found by the hourly check).
// Low disk space: the home partition with less than 5 % or less than 1 GB free, checked at sign-in and every hour.
// Dev / tests: AURORA_FAKE_DISK="<availBytes>,<totalBytes>" replaces the real statfs (dev mode without it: no check).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { run, which } = require('../lib/exec');
const robust = require('../lib/robust');

const GB = 1024 ** 3;
const HOUR = 60 * 60 * 1000;

/** True when a partition is low on space: under 5 % free or under 1 GB free. */
function isLowDisk({ avail, total }) {
  if (!(total > 0) || !(avail >= 0)) return false;
  return avail < GB || avail / total < 0.05;
}

function diskOf(dir) {
  const fake = process.env.AURORA_FAKE_DISK;
  if (fake) {
    const [avail, total] = fake.split(',').map(Number);
    return { avail, total, path: dir };
  }
  const s = fs.statfsSync(dir);
  return { avail: s.bavail * s.bsize, total: s.blocks * s.bsize, path: dir };
}

// Settings keys left out of the diagnostic report (passwords, tokens, keys of online services, locations).
const SECRET_KEY = /pass|token|secret|credential|api_?key|cookie|^auth|location|^(lat|lon|lng)$/i;
function scrub(v, depth = 0) {
  if (depth > 8) return '…';
  if (Array.isArray(v)) return v.map((x) => scrub(x, depth + 1));
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = SECRET_KEY.test(k) ? '(removed)' : scrub(x, depth + 1);
    return out;
  }
  return v;
}

const REPORT_NOTICE = `Selene OS diagnostic report
===========================
This archive was created on request from Settings > System > About. Nothing was sent anywhere:
you decide who receives it (for example attached to https://github.com/Belzeeebuth/claudeai-test/issues).

What is inside:
  README.txt     this notice
  versions.txt   Selene, Electron, Chromium, Node and kernel versions, os-release, memory and disk space
  journal.txt    messages of your Selene session since the last start (journalctl, your user only)
  settings.json  your Selene settings, without passwords, tokens or places (removed keys say "(removed)")
  lsusb.txt      list of USB devices
  lspci.txt      list of PCI devices (graphics, network, sound…)
No files, e-mails, browsing history or passwords of yours are included.
`;

async function cmdText(cmd, args, timeout = 15000) {
  try {
    const r = await run(cmd, args, { timeout });
    return (r.stdout || '') + (r.code ? `\n(exit status ${r.code}) ${r.stderr || ''}` : '');
  } catch (err) {
    return `(${cmd} unavailable: ${err.message})\n`;
  }
}

async function buildReport(api, home = os.homedir()) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 13);
  const name = `selene-diagnostic-${stamp}`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-diag-'));
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir);
  try {
    const w = (f, text) => fs.writeFileSync(path.join(dir, f), text);
    w('README.txt', REPORT_NOTICE);
    let disk = '';
    try {
      const d = diskOf(home);
      disk = `home: ${(d.avail / GB).toFixed(1)} GB free of ${(d.total / GB).toFixed(1)} GB`;
    } catch {}
    let rel = '';
    try {
      rel = fs.readFileSync('/etc/os-release', 'utf8');
    } catch {}
    w(
      'versions.txt',
      [
        `Selene shell ${api.env.version} (${api.env.mode}${api.env.live ? ', live session' : ''}${robust.state.safeMode ? ', SAFE MODE' : ''})`,
        `Electron ${process.versions.electron}, Chromium ${process.versions.chrome}, Node ${process.versions.node}`,
        `Kernel ${os.release()} ${os.arch()}`,
        `Memory ${(os.totalmem() / GB).toFixed(1)} GB, ${os.cpus().length} CPU(s) ${os.cpus()[0]?.model || ''}`,
        disk,
        `Renderer crashes in the last 2 minutes: ${robust.state.crashes}`,
        '',
        '/etc/os-release:',
        rel,
      ].join('\n'),
    );
    const uid = process.getuid?.() ?? 1000;
    w('journal.txt', await cmdText('journalctl', ['-b', '--no-pager', '-o', 'short-iso', '-n', '20000', `_UID=${uid}`], 30000));
    let settings = {};
    try {
      settings = JSON.parse(fs.readFileSync(path.join(home, '.config', 'aurora', 'settings.json'), 'utf8'));
    } catch (err) {
      settings = { error: `settings.json unreadable: ${err.message}` };
    }
    w('settings.json', JSON.stringify(scrub(settings), null, 2));
    w('lsusb.txt', await cmdText('lsusb', []));
    w('lspci.txt', await cmdText('lspci', ['-nn']));
    const files = fs.readdirSync(dir).sort();
    const out = path.join(home, `${name}.tar.gz`);
    const tmpOut = `${out}.part`;
    if (!which('tar')) throw api.error('tar is missing', 'ENOENT');
    const r = await run('tar', ['-czf', tmpOut, '-C', tmp, name], { timeout: 60000 });
    if (r.code !== 0) {
      fs.rmSync(tmpOut, { force: true });
      throw api.error((r.stderr || 'tar failed').trim(), /No space/i.test(r.stderr) ? 'ENOSPC' : 'EFAIL');
    }
    fs.renameSync(tmpOut, out);
    return { path: out, name: path.basename(out), files };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = function register(api) {
  const st = robust.state;
  const status = () => ({
    safeMode: st.safeMode,
    safeReason: st.safeReason,
    lookKeys: require('./settings.js').SAFE_LOOK_KEYS || [],
    settingsRecovered: st.settingsRecovered,
    saveFailed: st.saveFailed,
    lowDisk: st.lowDisk,
    acked: { ...st.acked },
  });
  api.robust = { status, changed: () => api.broadcast('robust:changed', status()) };

  const checkDisk = () => {
    // Dev mode (tests, xvfb): never the build machine's real disk, only AURORA_FAKE_DISK (no stray toasts in other suites).
    if (api.DEV && !process.env.AURORA_FAKE_DISK) return;
    let d = null;
    try {
      d = diskOf(api.env.home || os.homedir());
    } catch {
      return;
    }
    const low = isLowDisk(d);
    if (low && !st.lowDisk) {
      console.error(`[robust] low disk space in ${d.path}: ${(d.avail / GB).toFixed(2)} GB free of ${(d.total / GB).toFixed(1)} GB`);
      st.lowDisk = d;
      api.robust.changed();
    } else if (!low && st.lowDisk) {
      st.lowDisk = null;
      delete st.acked.disk; // tell again if it comes back
    }
  };
  checkDisk();
  setInterval(checkDisk, HOUR).unref?.();

  api.handle('robust:status', () => status());
  api.handle('robust:ack', (what) => {
    if (['settings', 'save', 'disk', 'safe'].includes(what)) st.acked[what] = Date.now();
    return true;
  });
  api.handle('robust:leaveSafeMode', () => {
    robust.leaveSafeMode();
    const win = api.getMainWindow();
    setTimeout(() => win && !win.isDestroyed() && win.webContents.reload(), 100);
    return true;
  });
  let busy = null;
  api.handle('robust:report', () => {
    busy = busy || buildReport(api).finally(() => (busy = null));
    return busy;
  });
};

module.exports.isLowDisk = isLowDisk;
module.exports.scrub = scrub;
module.exports.buildReport = buildReport;
module.exports.REPORT_NOTICE = REPORT_NOTICE;
