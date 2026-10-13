'use strict';
// Background check for system updates (core/features/update-check.js) and the badge on Paramètres > Mises à jour.
//
//   updates:pending () -> Result   read-only, as the session user: `apt-get -s upgrade --with-new-pkgs` over the
//                                  package lists apt-daily.timer refreshes as root every day (APT::Periodic,
//                                  rootfs/etc/apt/apt.conf.d/21aurora-auto-upgrades). Nothing installs, no root.
//   updates:last ()    -> Result | null   the last result, without running apt again (Settings' badge)
//   updates:schedule () -> { live, firstDelay, interval }   5 min after sign-in, then daily
//   event updates:changed Result (broadcast) after every check, and after « Mettre à jour » (updates:clear)
//   updates:clear ()   -> Result   the system was just updated (Paramètres): count 0 until the next check
//   Result = { count, security, packages: [{ name, from, to, security }], checkedAt, live, error }
// The live session never checks (live: true, count 0): nothing would be kept anyway.
//
// After « Mettre à jour », admin.js runs aurora-admin apt-autoremove (old kernels, unused dependencies) as the
// follow-up of apt-upgrade, with the same authorization (one prompt).
//
// Dev / tests (api.DEV unless AURORA_REAL_BACKENDS=1): the pending updates are admin.js's simulated system
// (dev.upgradable; none once the simulated upgrade ran); AURORA_DEV_UPDATES=<n> fakes n updates instead.
// AURORA_APT_GET=<path> replaces apt-get for the real path (tests use a fake). devRun() simulates apt-autoremove.
const { run } = require('../lib/exec');

/** `apt-get -s upgrade` output -> [{ name, from, to, security }] (unit-tested). */
function parseSimulation(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const m = /^Inst\s+(\S+)\s+(?:\[([^\]]+)\]\s+)?\((\S+)\s+([^)]*)\)/.exec(line.trim());
    if (!m) continue;
    out.push({ name: m[1], from: m[2] || null, to: m[3], security: /-security\b/.test(m[4]) });
  }
  return out;
}

// Selene's own packages (docs/UPDATES.md) count as one update, as in Paramètres > Mises à jour (lib/selene-updates.js).
const SELENE_PACKAGES = ['aurora-shell', 'aurora-base', 'aurora-electron'];
const updateCount = (packages) =>
  packages.filter((p) => !SELENE_PACKAGES.includes(p.name)).length + (packages.some((p) => SELENE_PACKAGES.includes(p.name)) ? 1 : 0);

const result = (packages, extra = {}) => ({
  count: updateCount(packages),
  security: packages.filter((p) => p.security).length,
  packages: packages.slice(0, 200),
  checkedAt: Date.now(),
  live: false,
  error: null,
  ...extra,
});

function devPackages() {
  const n = process.env.AURORA_DEV_UPDATES;
  if (n != null && /^\d+$/.test(n)) {
    return Array.from({ length: Number(n) }, (_, i) => ({ name: `package-${i + 1}`, from: '1.0-1', to: '1.0-2', security: i % 3 === 0 }));
  }
  const dev = require('./admin').dev;
  if (dev.updated) return [];
  return dev.upgradable.map(([name, epoch, from, to, origin]) => ({ name, from: `${epoch ? `${epoch}:` : ''}${from}`, to, security: /-security\b/.test(origin) }));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Dev: simulated `aurora-admin apt-autoremove` (APT status lines, like the helper). */
async function devRun(action, args, onLine) {
  if (action !== 'apt-autoremove') throw Object.assign(new Error(`Action not allowed: ${action}`), { code: 'EINVAL' });
  const old = ['linux-image-6.8.0-146-generic', 'linux-modules-6.8.0-146-generic'];
  old.forEach((p, i) => onLine?.(`pmstatus:${p}:${(((i + 1) / old.length) * 100).toFixed(4)}:Removing ${p}\n`));
  await sleep(150);
  return 'done\n';
}

function register(api) {
  const useMock = api.DEV && process.env.AURORA_REAL_BACKENDS !== '1';
  const live = !!api.env?.live;
  let last = null;
  let running = null;

  async function check() {
    if (live) return (last = result([], { live: true }));
    if (useMock && !process.env.AURORA_APT_GET) return (last = result(devPackages()));
    const bin = process.env.AURORA_APT_GET || 'apt-get';
    try {
      const r = await run(bin, ['-s', '-q', '-o', 'Debug::NoLocking=1', 'upgrade', '--with-new-pkgs'], {
        timeout: 120000,
        env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
      });
      if (r.code !== 0) throw new Error((r.stderr || '').trim().split('\n').pop() || `apt-get exited with ${r.code}`);
      last = result(parseSimulation(r.stdout));
    } catch (err) {
      last = result([], { error: err.message || String(err) });
    }
    return last;
  }

  api.handle('updates:pending', async () => {
    if (!running) {
      running = check().finally(() => {
        running = null;
      });
    }
    const r = await running;
    api.broadcast('updates:changed', r);
    return r;
  });
  api.handle('updates:last', () => last);
  // When the shell checks: 5 minutes after sign-in, then every day (tests: AURORA_UPDATE_CHECK_DELAY_MS / _INTERVAL_MS).
  api.handle('updates:schedule', () => {
    const num = (v, d) => (v != null && /^\d+$/.test(v) ? Number(v) : d);
    // Dev: off unless a test asks for it (AURORA_UPDATE_CHECK_DELAY_MS), so other suites never see the notification.
    const enabled = !live && (!useMock || process.env.AURORA_UPDATE_CHECK_DELAY_MS != null);
    return { live, enabled, firstDelay: num(process.env.AURORA_UPDATE_CHECK_DELAY_MS, 5 * 60 * 1000), interval: num(process.env.AURORA_UPDATE_CHECK_INTERVAL_MS, 24 * 3600 * 1000) };
  });
  api.handle('updates:clear', () => {
    last = result([], { live });
    api.broadcast('updates:changed', last);
    return last;
  });
}

module.exports = register;
module.exports.devRun = devRun;
module.exports.parsers = { parseSimulation };
