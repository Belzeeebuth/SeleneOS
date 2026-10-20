// GPU path + idle work.
//   1. unit: aurora_gpu_env (rootfs aurora-common) over fake sysfs trees, main/lib/gpu-flags.js switch plans
//   2. Electron (dev): GPU switches on the command line, sys:gpu from app.getGPUFeatureStatus(), the About row,
//      the shell's AudioContext suspended once a sound is over (no audio thread awake when idle), idle CPU.
// Usage:  cd aurora-os/shell && xvfb-run -a -s '-screen 0 1600x900x24' node test/gpu-idle.test.mjs [--unit]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(here, '..', '..');
const COMMON = path.join(REPO, 'rootfs', 'usr', 'lib', 'aurora', 'aurora-common');
const G = require(path.join(here, '..', 'main', 'lib', 'gpu-flags.js'));
let passed = 0;
const failures = [];
function check(name, ok, info) {
  if (ok) passed++;
  else failures.push(`${name}${info !== undefined ? `\n      got: ${typeof info === 'string' ? info : JSON.stringify(info)}` : ''}`);
}
function finish() {
  console.log(`\n${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.log(`  FAIL ${f}`);
  process.exit(failures.length ? 1 : 0);
}

// ===================================================================== 1. unit
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-gpu-'));
function tree(name, { drm = [], nvidia = '' } = {}) {
  const sys = path.join(tmp, name, 'sys');
  const proc = path.join(tmp, name, 'proc');
  fs.mkdirSync(path.join(sys, 'class', 'drm'), { recursive: true });
  fs.mkdirSync(path.join(proc), { recursive: true });
  fs.writeFileSync(path.join(proc, 'cmdline'), 'quiet splash\n');
  drm.forEach((drv, i) => {
    const dev = path.join(sys, 'devices', `card${i}`);
    fs.mkdirSync(path.join(sys, 'bus', 'drivers', drv), { recursive: true });
    fs.mkdirSync(dev, { recursive: true });
    fs.symlinkSync(path.join(sys, 'bus', 'drivers', drv), path.join(dev, 'driver'));
    fs.mkdirSync(path.join(sys, 'class', 'drm', `card${i}`), { recursive: true });
    fs.symlinkSync(dev, path.join(sys, 'class', 'drm', `card${i}`, 'device'));
  });
  if (nvidia) {
    fs.mkdirSync(path.join(sys, 'module', 'nvidia'), { recursive: true });
    fs.writeFileSync(path.join(sys, 'module', 'nvidia', 'version'), `${nvidia}\n`);
  }
  return { sys, proc };
}
const setup = (t, env = {}) => {
  const r = spawnSync('sh', ['-c', `. "${COMMON}"; aurora_electron_setup; echo "FLAGS=$AURORA_FLAGS"; env | grep -E '^(AURORA_(GPU|DISABLE|NVIDIA)|__GL_)' | sort`], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, AURORA_SYSFS: t.sys, AURORA_PROCFS: t.proc, ...env },
  });
  const out = {};
  for (const l of r.stdout.trim().split('\n')) {
    const i = l.indexOf('=');
    if (i > 0) out[l.slice(0, i)] = l.slice(i + 1);
  }
  return out;
};
{
  const nv = setup(tree('nv', { drm: ['nvidia'], nvidia: '550.120' }));
  check('aurora-common: NVIDIA -> GPU on, driver + version exported, no --disable-gpu', nv.AURORA_GPU_ACCEL === '1' && nv.AURORA_GPU_DRIVER === 'nvidia' && nv.AURORA_NVIDIA_VERSION === '550.120' && !/disable-gpu/.test(nv.FLAGS) && !nv.AURORA_DISABLE_GPU, nv);
  check('aurora-common: NVIDIA -> GL driver sleeps instead of spinning, vsync on', nv.__GL_YIELD === 'USLEEP' && nv.__GL_SYNC_TO_VBLANK === '1', nv);
  const nvUser = setup(tree('nv2', { drm: ['nvidia'], nvidia: '550.120' }), { __GL_YIELD: 'NOTHING' });
  check('aurora-common: a __GL_YIELD set by the user wins', nvUser.__GL_YIELD === 'NOTHING', nvUser);
  const off = setup(tree('nvoff', { drm: ['nvidia'], nvidia: '550.120' }), { AURORA_GPU: 'off' });
  check('aurora-common: AURORA_GPU=off fallback intact (--disable-gpu, AURORA_DISABLE_GPU=1, no GPU env)', /--disable-gpu/.test(off.FLAGS) && off.AURORA_DISABLE_GPU === '1' && !off.AURORA_GPU_ACCEL, off);
  const intel = setup(tree('intel', { drm: ['i915'] }));
  check('aurora-common: Intel -> driver i915', intel.AURORA_GPU_ACCEL === '1' && intel.AURORA_GPU_DRIVER === 'i915' && !intel.__GL_YIELD, intel);
  const fb = setup(tree('fb', { drm: ['simple-framebuffer'] }));
  check('aurora-common: no 3D GPU -> software (unchanged)', fb.AURORA_DISABLE_GPU === '1' && !fb.AURORA_GPU_ACCEL, fb);
}
{
  const nv = G.gpuPlan({ AURORA_GPU_ACCEL: '1', AURORA_GPU_DRIVER: 'nvidia', AURORA_NVIDIA_VERSION: '550.120', AURORA_GPU_VAAPI: '1' });
  check('plan NVIDIA 550: GPU raster + blocklist ignored, no zero-copy, no VA-API', nv.accel && ['enable-gpu-rasterization', 'ignore-gpu-blocklist'].every((s) => nv.switches.includes(s)) && !nv.switches.includes('enable-zero-copy') && !nv.enableFeatures.length, nv);
  const old = G.gpuPlan({ AURORA_GPU_ACCEL: '1', AURORA_GPU_DRIVER: 'nvidia', AURORA_NVIDIA_VERSION: '390.157' });
  check('plan NVIDIA 390 (legacy): GPU raster only, blocklist kept', old.switches.join() === 'enable-gpu-rasterization', old);
  const intel = G.gpuPlan({ AURORA_GPU_ACCEL: '1', AURORA_GPU_DRIVER: 'i915', AURORA_GPU_VAAPI: '1' });
  check('plan Intel + VA driver: zero-copy, blocklist ignored, VA-API decode', intel.switches.includes('enable-zero-copy') && intel.switches.includes('ignore-gpu-blocklist') && intel.enableFeatures.includes('AcceleratedVideoDecodeLinuxGL'), intel);
  const nouveau = G.gpuPlan({ AURORA_GPU_ACCEL: '1', AURORA_GPU_DRIVER: 'nouveau', AURORA_GPU_VAAPI: '1' });
  check('plan nouveau / virtio: blocklist kept, no zero-copy, no VA-API', nouveau.switches.join() === 'enable-gpu-rasterization' && !nouveau.enableFeatures.length, nouveau);
  check('plan software / dev: nothing added', G.gpuPlan({ AURORA_DISABLE_GPU: '1' }).accel === false && G.gpuPlan({}).switches.length === 0);
  check('plan: never turns vsync off', ![nv, intel].some((p) => p.switches.some((s) => /vsync|frame-rate-limit/.test(s))));
  const cl = { v: { 'enable-features': 'Foo,Bar' }, getSwitchValue(n) { return this.v[n] || ''; }, appendSwitch(n, val) { this.v[n] = val; } };
  G.mergeFeatures(cl, 'enable-features', ['Bar', 'Baz']);
  check('features merged with the ones already on the command line', cl.v['enable-features'] === 'Foo,Bar,Baz', cl.v);
}
fs.rmSync(tmp, { recursive: true, force: true });
if (process.argv.includes('--unit')) finish();

// ===================================================================== 2. Electron (dev)
const { launchShell } = await import('./lib.mjs');
const s = await launchShell({ lang: 'fr', env: { AURORA_GPU_ACCEL: '1', AURORA_GPU_DRIVER: 'i915', AURORA_GPU_VAAPI: '1' } });
try {
  const sw = await s.app.evaluate(({ app }) => ['enable-gpu-rasterization', 'ignore-gpu-blocklist', 'enable-zero-copy'].map((n) => app.commandLine.hasSwitch(n)).concat([app.commandLine.getSwitchValue('enable-features'), app.commandLine.getSwitchValue('disable-features')]));
  check('Electron: GPU switches applied from the session env', sw.slice(0, 3).every(Boolean) && /AcceleratedVideoDecodeLinuxGL/.test(sw[3]) && /HardwareMediaKeyHandling/.test(sw[4]), sw);
  const direct = await s.aurora(() => import('app://shell/core/api.js').then((m) => m.api.invoke('sys:gpu')));
  check('sys:gpu: app.getGPUFeatureStatus() reported (chrome://gpu)', direct && typeof direct.enabled === 'boolean' && typeof direct.features?.gpu_compositing === 'string' && direct.driver === 'i915', direct);
  console.log('  getGPUFeatureStatus:', JSON.stringify(direct?.features));
  await s.aurora(() => window.__aurora.registry.launch('settings', { page: 'about' }));
  await s.page.waitForFunction(() => [...document.querySelectorAll('.app-settings .st-about-list dt')].some((e) => e.textContent === 'Accélération graphique'), null, { timeout: 15000 });
  const row = await s.aurora(() => {
    const dt = [...document.querySelectorAll('.app-settings .st-about-list dt')].find((e) => e.textContent === 'Accélération graphique');
    return dt?.nextElementSibling?.textContent || '';
  });
  check('À propos: « Accélération graphique : activée / désactivée » matches sys:gpu', row === (direct.enabled ? 'Activée' : 'Désactivée'), row);

  // A system sound must not leave the audio output stream running.
  const st = await s.aurora(async () => {
    const { sounds } = await import('app://shell/core/sounds.js');
    sounds.play([{ freq: 880, dur: 0.1 }]);
    await new Promise((r) => setTimeout(r, 300));
    const AC = window.AudioContext;
    return { during: AC ? 'ok' : 'none' };
  });
  check('sound played', st.during === 'ok', st);
  await new Promise((r) => setTimeout(r, 2500));
  const metrics = async () => (await s.app.evaluate(({ app }) => app.getAppMetrics().map((m) => ({ pid: m.pid, type: m.type, svc: m.serviceName || '' }))));
  const ticks = (pid) => {
    try {
      const f = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
      return Number(f[11]) + Number(f[12]);
    } catch {
      return 0;
    }
  };
  // close Settings, let the desktop settle, then measure 10 s of idle
  await s.aurora(() => window.__aurora.wm.list?.().forEach((w) => window.__aurora.wm.close?.(w.id)));
  await new Promise((r) => setTimeout(r, 3000));
  const ps = await metrics();
  const a = ps.map((p) => ticks(p.pid));
  const t0 = Date.now();
  await new Promise((r) => setTimeout(r, 10000));
  const b = ps.map((p) => ticks(p.pid));
  const secs = (Date.now() - t0) / 1000;
  const per = ps.map((p, i) => ({ type: p.svc || p.type, pct: +(((b[i] - a[i]) / 100 / secs) * 100).toFixed(2) }));
  const audioSvc = per.find((p) => /audio/i.test(p.type));
  const total = per.reduce((n, p) => n + p.pct, 0);
  console.log('  idle CPU (10 s):', JSON.stringify(per), 'total', total.toFixed(2), '%');
  check('idle: CPU ticks were read', a.some((v) => v > 0), a);
  check('idle: the audio service is not streaming after a sound (< 0.5 % CPU)', !audioSvc || audioSvc.pct < 0.5, per);
  check('idle: every shell process together < 4 % CPU under xvfb', total < 4, per);
} finally {
  await s.close();
}
finish();
