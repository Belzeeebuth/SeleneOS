'use strict';
// Firmware updates through fwupd (Paramètres > Mises à jour > « Microprogrammes »; iso/packages.d/firmware-updates.list).
//
//   firmware:status ()  -> Status   reads `fwupdmgr get-devices --json` and `fwupdmgr get-updates --json` (the session
//                                   user talks to the fwupd daemon over D-Bus: no privileges needed to read)
//   firmware:refresh () -> Status   « Rechercher »: `fwupdmgr refresh` (LVFS metadata; exit 2 = already up to date),
//                                   then the same reads
//   Status = { available (fwupdmgr present), devices: [Device] (updatable devices only: the page hides the section
//              when there is none), updates: [Update], pendingReboot (an update waits for a restart), error, errorCode,
//              checkedAt, simulated }
//   Device = { id (40 hex), name, vendor, version, plugin, requireAc, needsReboot }
//   Update = { deviceId, deviceName, vendor, from, to, summary, description (plain text), size (bytes|null),
//              urgency, requireAc, needsReboot }
// The update itself runs as root through the UAC prompt: shell.runAdmin('firmware-update', [deviceId]) ->
// aurora-admin firmware-update <40 hex> (fwupdmgr update for that device only; prints "reboot-required" when the
// device needs a restart to finish). Validated here (admin.js ACTIONS) and again in the helper.
//
// Dev / tests (api.DEV unless AURORA_REAL_BACKENDS=1): fixtures shell/test/fixtures/fwupd/{devices,updates}.json
// (AURORA_FWUPD_FIXTURE=<dir> for another set; AURORA_FWUPD_FIXTURE=none: fwupd sees no updatable device);
// the admin action is simulated by devRun() below (admin.js delegates). AURORA_FWUPDMGR=<path> replaces the binary.
const fs = require('fs');
const path = require('path');
const { run } = require('../lib/exec');

const DEVICE_ID = /^[0-9a-f]{40}$/;
const FIXTURES = path.join(__dirname, '..', '..', 'test', 'fixtures', 'fwupd');
const str = (v, max = 300) => (typeof v === 'string' ? v.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').slice(0, max) : '');
const arr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);

/** fwupd release description (AppStream markup: <p>, <ul><li>) -> plain text (unit-tested). */
function markupToText(s) {
  return String(s || '')
    .replace(/<li>\s*/gi, '• ')
    .replace(/<\/(p|li|ul|ol)>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .slice(0, 4000);
}

function jsonOf(text) {
  try {
    const j = JSON.parse(String(text || ''));
    return j && typeof j === 'object' ? j : null;
  } catch {
    // Some versions print a line ("No updatable devices" / "Devices with no available firmware updates: …") before
    // or instead of the JSON document.
    const t = String(text || '');
    const i = t.indexOf('{');
    if (i < 0) return null;
    try {
      return JSON.parse(t.slice(i));
    } catch {
      return null;
    }
  }
}

function device(d) {
  if (!d || typeof d !== 'object' || !DEVICE_ID.test(d.DeviceId || '')) return null;
  const flags = arr(d.Flags);
  return {
    id: d.DeviceId,
    name: str(d.Name, 120) || str(d.Plugin, 60) || d.DeviceId.slice(0, 8),
    vendor: str(d.Vendor, 120),
    version: str(d.Version, 60),
    plugin: str(d.Plugin, 60),
    updatable: flags.includes('updatable'),
    requireAc: flags.includes('require-ac'),
    needsReboot: flags.includes('needs-reboot') || flags.includes('needs-shutdown'),
    pending: String(d.UpdateState || '') === 'needs-reboot' || arr(d.Problems).includes('update-pending'),
  };
}

/** `fwupdmgr get-devices --json` -> [Device] (every device; unit-tested) */
function parseDevices(text) {
  const j = jsonOf(text);
  const out = [];
  const seen = new Set();
  for (const d of Array.isArray(j?.Devices) ? j.Devices : []) {
    const dev = device(d);
    if (!dev || seen.has(dev.id)) continue;
    seen.add(dev.id);
    out.push(dev);
  }
  return out;
}

/** `fwupdmgr get-updates --json` -> [Update] (the newest non-downgrade release per device; unit-tested) */
function parseUpdates(text) {
  const j = jsonOf(text);
  const out = [];
  const seen = new Set();
  for (const d of Array.isArray(j?.Devices) ? j.Devices : []) {
    const dev = device(d);
    if (!dev || seen.has(dev.id)) continue;
    const rel = (Array.isArray(d.Releases) ? d.Releases : []).find((r) => r && typeof r === 'object' && str(r.Version, 60) && !arr(r.Flags).includes('is-downgrade'));
    if (!rel) continue;
    seen.add(dev.id);
    const size = Number(rel.Size);
    out.push({
      deviceId: dev.id,
      deviceName: dev.name,
      vendor: dev.vendor || str(rel.Vendor, 120),
      from: dev.version,
      to: str(rel.Version, 60),
      summary: str(rel.Summary, 300),
      description: markupToText(rel.Description),
      size: Number.isFinite(size) && size > 0 ? size : null,
      urgency: ['low', 'medium', 'high', 'critical'].includes(rel.Urgency) ? rel.Urgency : null,
      requireAc: dev.requireAc,
      needsReboot: dev.needsReboot,
    });
  }
  return out;
}

const useMockOf = (api) => api.DEV && process.env.AURORA_REAL_BACKENDS !== '1';

// Dev: the simulated system (updated devices and a pending restart survive page changes).
const dev = { updated: new Map(), pendingReboot: false, refreshedAt: null };
function fixtureDir() {
  const f = process.env.AURORA_FWUPD_FIXTURE;
  if (f === 'none') return null;
  return f && path.isAbsolute(f) ? f : FIXTURES;
}
function readFixture(name) {
  const dir = fixtureDir();
  if (!dir) return '{"Devices":[]}';
  try {
    return fs.readFileSync(path.join(dir, `${name}.json`), 'utf8');
  } catch {
    return '{"Devices":[]}';
  }
}
function devStatus() {
  const devices = parseDevices(readFixture('devices')).map((d) => (dev.updated.has(d.id) ? { ...d, version: dev.updated.get(d.id) } : d));
  const updates = parseUpdates(readFixture('updates')).filter((u) => !dev.updated.has(u.deviceId));
  return { devices, updates, pendingReboot: dev.pendingReboot };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** admin.js devRun delegate: firmware-update <id> (simulated). */
async function devRun(action, args) {
  if (action !== 'firmware-update') throw Object.assign(new Error(`Action not allowed: ${action}`), { code: 'EINVAL' });
  const id = args[0];
  const u = parseUpdates(readFixture('updates')).find((x) => x.deviceId === id && !dev.updated.has(id));
  if (!u) throw Object.assign(new Error('no firmware update for this device'), { code: 'ENOTFOUND' });
  await sleep(Number(process.env.AURORA_FWUPD_DEV_DELAY) >= 0 && process.env.AURORA_FWUPD_DEV_DELAY ? Number(process.env.AURORA_FWUPD_DEV_DELAY) : 1200);
  if (process.env.AURORA_FWUPD_DEV_FAIL === id) throw Object.assign(new Error('the device did not accept the firmware (simulated)'), { code: 'ECMD' });
  dev.updated.set(id, u.to);
  if (u.needsReboot) dev.pendingReboot = true;
  return `Writing…\nSuccessfully installed firmware\n${u.needsReboot ? 'reboot-required\n' : ''}done\n`;
}

function register(api) {
  const useMock = useMockOf(api);
  let lastError = null;
  let checkedAt = null;

  function bin() {
    const forced = process.env.AURORA_FWUPDMGR;
    if (forced) return fs.existsSync(forced) ? forced : null;
    for (const d of ['/usr/bin', '/bin', '/usr/local/bin']) if (fs.existsSync(path.join(d, 'fwupdmgr'))) return path.join(d, 'fwupdmgr');
    return null;
  }
  async function fwupd(args, timeout = 60000) {
    const b = bin();
    if (!b) throw Object.assign(new Error('fwupd is not installed'), { code: 'ENOENT' });
    // --no-unreported-check / --no-metadata-check: never prompt (no tty here); LANG=C: stable messages.
    return run(b, args, { timeout, env: { ...process.env, LC_ALL: 'C.UTF-8', LANGUAGE: '' } });
  }

  async function status() {
    if (useMock) return { available: true, ...devStatus(), error: lastError?.message || null, errorCode: lastError?.code || null, checkedAt: dev.refreshedAt, simulated: true };
    if (!bin()) return { available: false, devices: [], updates: [], pendingReboot: false, error: null, errorCode: null, checkedAt: null };
    let devices = [];
    let updates = [];
    let error = lastError;
    try {
      const r = await fwupd(['get-devices', '--json', '--no-unreported-check'], 30000);
      devices = parseDevices(r.stdout);
      if (!devices.length && r.code !== 0 && r.code !== 2) error = { message: str(r.stderr || r.stdout, 300) || 'fwupd did not answer', code: 'EFWUPD' };
    } catch (e) {
      error = { message: str(e?.message || String(e), 300), code: e?.code === 'ENOENT' ? 'ENOENT' : 'EFWUPD' };
    }
    if (devices.some((d) => d.updatable)) {
      try {
        // Exit code 2 = nothing to do (no update); the JSON document (when printed) is read either way.
        const r = await fwupd(['get-updates', '--json', '--no-unreported-check', '--no-metadata-check'], 60000);
        updates = parseUpdates(r.stdout);
      } catch (e) {
        error = error || { message: str(e?.message || String(e), 300), code: 'EFWUPD' };
      }
    }
    return { available: true, devices: devices.filter((d) => d.updatable), updates, pendingReboot: devices.some((d) => d.pending), error: error?.message || null, errorCode: error?.code || null, checkedAt };
  }

  api.handle('firmware:status', async () => {
    const st = await status();
    return { ...st, devices: st.devices.filter((d) => d.updatable) };
  });
  api.handle('firmware:refresh', async () => {
    lastError = null;
    if (useMock) {
      await sleep(Number(process.env.AURORA_FWUPD_DEV_DELAY) >= 0 && process.env.AURORA_FWUPD_DEV_DELAY ? Number(process.env.AURORA_FWUPD_DEV_DELAY) : 600);
      dev.refreshedAt = Date.now();
      if (process.env.AURORA_FWUPD_DEV_OFFLINE === '1') lastError = { message: 'Failed to download metadata: could not resolve host fwupd.org (simulated)', code: 'ENET' };
    } else if (bin()) {
      const r = await fwupd(['refresh', '--no-unreported-check'], 180000).catch((e) => ({ code: 1, stdout: '', stderr: e?.message || String(e) }));
      // 0: downloaded; 2: metadata already up to date.
      if (r.code !== 0 && r.code !== 2) {
        const text = `${r.stderr}\n${r.stdout}`;
        lastError = { message: str(text.trim().split('\n').pop(), 300) || 'fwupdmgr refresh failed', code: /resolve|network|connect|timed out|download/i.test(text) ? 'ENET' : /auth|polkit|not authorized/i.test(text) ? 'EPERM' : 'EFWUPD' };
      }
      checkedAt = Date.now();
    }
    const st = await status();
    return { ...st, devices: st.devices.filter((d) => d.updatable) };
  });
}

module.exports = register;
module.exports.devRun = devRun;
module.exports.dev = dev;
module.exports.parsers = { parseDevices, parseUpdates, markupToText, DEVICE_ID };
