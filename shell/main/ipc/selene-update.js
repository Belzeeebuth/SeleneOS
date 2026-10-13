'use strict';
// Selene self-updates (docs/UPDATES.md): which Selene version runs, which one is installed.
//
//   selene:status () -> { running, installed, restartNeeded }
//     running    the aurora-shell package version this session started with (/opt/aurora/shell/selene-version, read
//                once when the shell starts)
//     installed  the same file read now: an update of aurora-shell (Paramètres > Mises à jour, apt) replaces it
//     restartNeeded  installed !== running: Paramètres offers « Redémarrer la session » (sign out and back in)
//
// Dev / tests (api.DEV unless AURORA_REAL_BACKENDS=1): the version file is AURORA_SELENE_VERSION_FILE when set,
// else none (running = installed = null); admin.js's simulated apt-upgrade calls devUpdated() when its fixture
// list holds aurora-shell, which makes `installed` newer.
const fs = require('fs');
const path = require('path');

const VERSION_RE = /^[0-9][0-9A-Za-z.+~-]{0,63}$/;
const dev = { installed: null };

function readVersion(file) {
  try {
    const v = fs.readFileSync(file, 'utf8').trim();
    return VERSION_RE.test(v) ? v : null;
  } catch {
    return null;
  }
}

function register(api) {
  const useMock = api.DEV && process.env.AURORA_REAL_BACKENDS !== '1';
  const file = useMock ? process.env.AURORA_SELENE_VERSION_FILE || null : path.join(__dirname, '..', '..', 'selene-version');
  const running = file ? readVersion(file) : null;
  api.handle('selene:status', () => {
    const installed = useMock && dev.installed ? dev.installed : file ? readVersion(file) : null;
    return { running, installed, restartNeeded: !!(running && installed && installed !== running) || !!(useMock && dev.installed) };
  });
}

/** Dev: the simulated apt-upgrade installed a new aurora-shell. */
function devUpdated(version) {
  dev.installed = VERSION_RE.test(String(version || '')) ? String(version) : '0.0.0-dev';
}

module.exports = register;
module.exports.devUpdated = devUpdated;
module.exports.readVersion = readVersion;
