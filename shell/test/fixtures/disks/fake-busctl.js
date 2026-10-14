'use strict';
// In-process stand-in for `busctl --system --json=short …` talking to udisks2, used by main/ipc/disks.js in dev mode
// (AURORA_REAL_BACKENDS unset) and by test/disks-health.test.mjs. It answers the exact argument vectors the backend
// builds (main/ipc/disks-smart.js argv.*) from a fixture directory written by make-fixtures.mjs (udisks.json: the
// GetManagedObjects answer and the SmartGetAttributes answers, in busctl's JSON format) and returns
// { code, stdout, stderr } like lib/exec.js run(): errors are "Call failed: <udisks message>" on stderr, exit 1.
//
// Simulated: SmartUpdate (SmartUpdated = now), self-tests (SmartSelftestStart / SmartSelftestAbort; the progress
// follows the clock: AURORA_DISKS_SELFTEST_MS=<short>,<extended>, default 4000,9000 ms; the result is "success" or
// the fixture's fake.selftestResult), a test that stays in progress (fake.selftestStatic), refusals
// (patch { denySelftest: true } -> "Not authorized to perform operation"), a sleeping disk (patch { asleep: true }).
// create(dir).patch(device, { ata: {…props}, nvme: {…props}, nvmeAttrs: {…}, denySelftest, asleep }) changes a drive
// (dev / tests: disks:devHealth); .reset() goes back to the fixture; .smartctl(device) is the smartctl -j -a answer
// (health/smartctl.json) used by the aurora-admin smart-info simulation.
const fs = require('fs');
const path = require('path');

const ATA = 'org.freedesktop.UDisks2.Drive.Ata';
const NVME = 'org.freedesktop.UDisks2.NVMe.Controller';
const NVME_ATTR_TYPES = {
  avail_spare: 'y', spare_thresh: 'y', percent_used: 'y', total_data_read: 't', total_data_written: 't', ctrl_busy_time: 't', power_cycles: 't',
  unsafe_shutdowns: 't', media_errors: 't', num_err_log_entries: 't', temp_sensors: 'aq', wctemp: 'q', cctemp: 'q', warning_temp_time: 'u', critical_temp_time: 'u',
};
const PROP_TYPES = {
  SmartSupported: 'b', SmartEnabled: 'b', SmartUpdated: 't', SmartFailing: 'b', SmartPowerOnSeconds: 't', SmartNumAttributesFailing: 'i',
  SmartNumAttributesFailedInThePast: 'i', SmartNumBadSectors: 'x', SmartSelftestStatus: 's', SmartSelftestPercentRemaining: 'i',
  SmartCriticalWarning: 'as', SmartPowerOnHours: 't',
};
const clone = (x) => JSON.parse(JSON.stringify(x));
const bytesToString = (a) => Buffer.from((a || []).filter((b) => b !== 0)).toString('utf8');

function create(dir, { now = () => Date.now() } = {}) {
  const fx = JSON.parse(fs.readFileSync(path.join(dir, 'udisks.json'), 'utf8'));
  let smartctl = {};
  try {
    smartctl = JSON.parse(fs.readFileSync(path.join(dir, 'smartctl.json'), 'utf8'));
  } catch {}
  const [shortMs, extMs] = String(process.env.AURORA_DISKS_SELFTEST_MS || '4000,9000').split(',').map(Number);
  let st;
  function reset() {
    st = { objects: clone(fx.managedObjects.data[0]), attributes: clone(fx.attributes || {}), fake: clone(fx.fake || {}), tests: {} };
    // udisks refreshes SMART data on its own (housekeeping): the fixture's timestamps become "2 minutes ago".
    const ago = Math.floor(now() / 1000) - 120;
    for (const o of Object.values(st.objects)) for (const i of [ATA, NVME]) if (o[i]?.SmartUpdated?.data) o[i].SmartUpdated.data = ago;
  }
  reset();

  const ok = (value) => ({ code: 0, stdout: value === undefined ? '' : `${JSON.stringify(value)}\n`, stderr: '' });
  const fail = (msg) => ({ code: 1, stdout: '', stderr: `Call failed: ${msg}\n` });
  const ifaceOf = (obj, iface) => st.objects[obj]?.[iface] || null;
  const setProp = (p, k, v) => {
    p[k] = { type: PROP_TYPES[k] || (typeof v === 'boolean' ? 'b' : typeof v === 'string' ? 's' : 'i'), data: v };
  };

  /** Self-test progress follows the clock (ATA reports 10 % steps, NVMe percents). */
  function tick() {
    for (const [obj, t] of Object.entries(st.tests)) {
      const p = ifaceOf(obj, t.iface);
      if (!p) continue;
      const done = Math.min(1, (now() - t.started) / t.duration);
      if (done >= 1) {
        setProp(p, 'SmartSelftestStatus', t.result);
        setProp(p, 'SmartSelftestPercentRemaining', t.iface === ATA ? 0 : -1);
        if (t.iface === ATA) setProp(p, 'SmartUpdated', Math.floor(now() / 1000));
        delete st.tests[obj];
      } else {
        const left = t.iface === ATA ? Math.max(10, Math.min(90, Math.ceil((1 - done) * 10) * 10)) : Math.max(1, Math.round((1 - done) * 100));
        setProp(p, 'SmartSelftestPercentRemaining', left);
      }
    }
  }

  async function busctl(argv) {
    const a = [...argv];
    while (a.length && a[0].startsWith('--')) a.shift(); // --system --json=short --timeout=… --allow-interactive-authorization=no
    if (a[0] !== 'call' || a[1] !== 'org.freedesktop.UDisks2') return { code: 1, stdout: '', stderr: `fake busctl: unsupported ${argv.join(' ')}\n` };
    const [, , obj, iface, method, sig, ...args] = a;
    tick();
    if (method === 'GetManagedObjects') return ok({ type: 'a{oa{sa{sv}}}', data: [st.objects] });
    if (!st.objects[obj]) return fail(`Unknown object '${obj}'.`);
    if (iface === 'org.freedesktop.DBus.Properties' && method === 'GetAll') {
      return ok({ type: 'a{sv}', data: [st.objects[obj][args[0]] || {}] });
    }
    const p = ifaceOf(obj, iface);
    if (!p) return fail(`No such interface '${iface}' on object at path ${obj}`);
    const fk = st.fake[obj] || {};
    const opts = {};
    if (sig && sig.endsWith('a{sv}')) {
      const rest = sig === 'sa{sv}' ? args.slice(1) : args;
      for (let i = 1; i + 2 < rest.length; i += 3) opts[rest[i]] = rest[i + 2] === 'true'; // count, then key 'b' value…
    }
    switch (method) {
      case 'SmartGetAttributes':
        return st.attributes[obj] ? ok(st.attributes[obj]) : fail('SMART data not collected');
      case 'SmartUpdate':
        if (iface === ATA && fk.asleep && opts.nowakeup) return fail('Disk is in sleep mode and the nowakeup option was passed');
        if (iface === ATA) fk.asleep = false;
        setProp(p, 'SmartUpdated', Math.floor(now() / 1000));
        return ok();
      case 'SmartSelftestStart': {
        const type = args[0];
        if (iface === NVME && !p.SmartSelftestStatus?.data) return fail('The NVMe controller has no support for self-test operations');
        if (iface === ATA && !(p.SmartSupported?.data && p.SmartEnabled?.data)) return fail('SMART is not supported or enabled');
        if (!['short', 'extended'].includes(type) && !(iface === ATA && type === 'conveyance')) return fail(`Unknown self-test type ${type}`);
        if (p.SmartSelftestStatus?.data === 'inprogress') return fail(iface === ATA ? 'There is already SMART self-test running' : 'There is already device self-test running');
        if (fk.denySelftest) return fail('Not authorized to perform operation');
        st.tests[obj] = { iface, type, started: now(), duration: type === 'short' ? shortMs : extMs, result: fk.selftestResult || 'success' };
        setProp(p, 'SmartSelftestStatus', 'inprogress');
        setProp(p, 'SmartSelftestPercentRemaining', iface === ATA ? 90 : 100);
        return ok();
      }
      case 'SmartSelftestAbort':
        if (fk.denySelftest) return fail('Not authorized to perform operation');
        delete st.tests[obj];
        if (p.SmartSelftestStatus?.data === 'inprogress') {
          setProp(p, 'SmartSelftestStatus', 'aborted');
          setProp(p, 'SmartSelftestPercentRemaining', iface === ATA ? 0 : -1);
        }
        return ok();
      default:
        return fail(`Unknown method ${method} or interface ${iface}.`);
    }
  }

  function driveOf(device) {
    for (const [obj, o] of Object.entries(st.objects)) {
      const b = o['org.freedesktop.UDisks2.Block'];
      if (b && !o['org.freedesktop.UDisks2.Partition'] && bytesToString(b.Device?.data) === device) return b.Drive?.data || null;
    }
    return null;
  }
  busctl.patch = (device, patch = {}) => {
    const obj = driveOf(device);
    if (!obj || !st.objects[obj]) return false;
    const fk = (st.fake[obj] = st.fake[obj] || {});
    if ('denySelftest' in patch) fk.denySelftest = !!patch.denySelftest;
    if ('asleep' in patch) fk.asleep = !!patch.asleep;
    for (const [key, iface] of [['ata', ATA], ['nvme', NVME]]) {
      const p = ifaceOf(obj, iface);
      if (p && patch[key]) for (const [k, v] of Object.entries(patch[key])) setProp(p, k, v);
    }
    if (patch.nvmeAttrs && st.attributes[obj]?.type === 'a{sv}') {
      const d = st.attributes[obj].data[0];
      for (const [k, v] of Object.entries(patch.nvmeAttrs)) d[k] = { type: NVME_ATTR_TYPES[k] || 't', data: v };
    }
    return true;
  };
  busctl.reset = reset;
  busctl.smartctl = (device) => (smartctl[device] ? clone(smartctl[device]) : null);
  return busctl;
}

module.exports = { create };
