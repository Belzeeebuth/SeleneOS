'use strict';
// Battery information (power:shutdown / reboot / suspend live in sys.js).
//
//   power:battery  -> null (no system battery, e.g. desktops and VMs)
//                     | { percent 0-100, charging, full, timeLeftMin | null, ac, vendor, model }
//   event power:changed (battery)   every 30 s when the battery state changed
//
// Reads /sys/class/power_supply: devices of type "Battery" whose scope is not "Device" (mice and
// headsets report their own batteries) and "Mains"/"USB" adapters for the AC state.
// Dev mode: AURORA_MOCK_BATTERY=<percent>[,charging] simulates a laptop battery.
const fs = require('fs');
const path = require('path');

const PS = '/sys/class/power_supply';

function read(dir, name) {
  try {
    return fs.readFileSync(path.join(dir, name), 'utf8').trim();
  } catch {
    return null;
  }
}
const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

/** Battery state from a power_supply directory map: { name: { file: value } } (unit-tested). */
function batteryFrom(supplies) {
  const bats = [];
  let ac = null;
  for (const [, f] of Object.entries(supplies)) {
    if (f.type === 'Mains' || f.type === 'USB') {
      if (f.online != null) ac = ac || f.online === '1';
      continue;
    }
    if (f.type !== 'Battery' || (f.scope && f.scope.toLowerCase() === 'device') || f.present === '0') continue;
    bats.push(f);
  }
  if (!bats.length) return null;
  // Several batteries (some ThinkPads): add the energies up.
  let now = 0;
  let full = 0;
  let rate = 0;
  let pctSum = 0;
  let unitsOk = true;
  const statuses = [];
  for (const b of bats) {
    const en = num(b.energy_now) ?? num(b.charge_now);
    const ef = num(b.energy_full) ?? num(b.charge_full);
    const pw = num(b.power_now) ?? num(b.current_now);
    if (en == null || ef == null) unitsOk = false;
    now += en || 0;
    full += ef || 0;
    rate += Math.abs(pw || 0);
    pctSum += num(b.capacity) ?? (ef ? ((en || 0) / ef) * 100 : 0);
    statuses.push(b.status || 'Unknown');
  }
  const percent = Math.max(0, Math.min(100, Math.round(unitsOk && full > 0 ? (now / full) * 100 : pctSum / bats.length)));
  const charging = statuses.includes('Charging');
  const isFull = statuses.every((s) => s === 'Full') || (percent >= 100 && !statuses.includes('Discharging'));
  let timeLeftMin = null;
  if (unitsOk && rate > 0) {
    if (statuses.includes('Discharging')) timeLeftMin = Math.round((now / rate) * 60);
    else if (charging) timeLeftMin = Math.round(((full - now) / rate) * 60);
  }
  if (timeLeftMin != null && (timeLeftMin < 0 || timeLeftMin > 48 * 60)) timeLeftMin = null;
  return {
    percent,
    charging,
    full: isFull,
    timeLeftMin,
    ac: ac ?? (charging || statuses.includes('Not charging') || isFull),
    vendor: bats[0].manufacturer || null,
    model: bats[0].model_name || null,
  };
}

function readSupplies() {
  const out = {};
  let names = [];
  try {
    names = fs.readdirSync(PS);
  } catch {
    return out;
  }
  const files = ['type', 'scope', 'present', 'online', 'status', 'capacity', 'energy_now', 'energy_full', 'power_now', 'charge_now', 'charge_full', 'current_now', 'manufacturer', 'model_name'];
  for (const n of names) {
    const d = path.join(PS, n);
    const f = {};
    for (const k of files) {
      const v = read(d, k);
      if (v != null) f[k] = v;
    }
    out[n] = f;
  }
  return out;
}

function register(api) {
  const mockSpec = api.DEV ? process.env.AURORA_MOCK_BATTERY : null;
  const battery = () => {
    if (mockSpec) {
      const [pct, flag] = String(mockSpec).split(',');
      const percent = Math.max(0, Math.min(100, Number(pct) || 76));
      const charging = flag === 'charging';
      return { percent, charging, full: false, timeLeftMin: charging ? 48 : Math.round(percent * 3.1), ac: charging, vendor: 'SMP', model: '5B10W13930' };
    }
    if (api.DEV && process.env.AURORA_REAL_BACKENDS !== '1') return null;
    return batteryFrom(readSupplies());
  };
  api.handle('power:battery', () => battery());

  let last = JSON.stringify(battery());
  if (last !== 'null') {
    setInterval(() => {
      const b = battery();
      const j = JSON.stringify(b);
      if (j !== last) {
        last = j;
        api.broadcast('power:changed', b);
      }
    }, 30000).unref?.();
  }
}

module.exports = register;
module.exports.parsers = { batteryFrom };
