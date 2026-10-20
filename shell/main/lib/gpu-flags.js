'use strict';
// Chromium GPU switches for the shell on Linux X11, from what the session scripts detected
// (rootfs/usr/lib/aurora/aurora-common: aurora_gpu_mode / aurora_gpu_env):
//   AURORA_DISABLE_GPU=1   software rendering (AURORA_GPU=off, no 3D-capable GPU, crash retry): nothing here
//   AURORA_GPU_ACCEL=1     a real GPU drives the screen:
//     GPU rasterization                       always
//     ignore the GPU blocklist                only for drivers known good (NVIDIA ≥ 470, i915 / xe, amdgpu)
//     zero-copy raster uploads                Mesa i915 / xe / amdgpu (not NVIDIA: corrupted tiles reported on X11)
//     VA-API video decode                     Mesa GPU with a VA driver installed (AURORA_GPU_VAAPI=1), never NVIDIA
//   Vsync stays on (Chromium's default: no --disable-gpu-vsync / --disable-frame-rate-limit).
// Without AURORA_GPU_ACCEL (dev, tests): Chromium's own defaults.

const MESA_GOOD = new Set(['i915', 'xe', 'amdgpu']);
const VAAPI_FEATURES = ['AcceleratedVideoDecodeLinuxGL', 'AcceleratedVideoDecodeLinuxZeroCopyGL', 'VaapiVideoDecoder', 'VaapiVideoDecodeLinuxGL'];

function gpuPlan(env = process.env) {
  if (env.AURORA_DISABLE_GPU === '1') return { accel: false, driver: '', switches: [], enableFeatures: [] };
  if (env.AURORA_GPU_ACCEL !== '1') return { accel: null, driver: '', switches: [], enableFeatures: [] };
  const driver = String(env.AURORA_GPU_DRIVER || '').trim().toLowerCase();
  const nv = driver === 'nvidia' ? parseFloat(String(env.AURORA_NVIDIA_VERSION || '')) || 0 : 0;
  const nvidia = driver === 'nvidia';
  const knownGood = nvidia ? nv === 0 || nv >= 470 : MESA_GOOD.has(driver);
  const switches = ['enable-gpu-rasterization'];
  if (knownGood) switches.push('ignore-gpu-blocklist');
  if (MESA_GOOD.has(driver)) switches.push('enable-zero-copy');
  const enableFeatures = !nvidia && env.AURORA_GPU_VAAPI === '1' && (MESA_GOOD.has(driver) || driver === 'radeon') ? VAAPI_FEATURES.slice() : [];
  return { accel: true, driver, switches, enableFeatures };
}

// --enable-features / --disable-features are one value each: merge with what is already on the command line
// (AURORA_ELECTRON_FLAGS) instead of replacing it.
function mergeFeatures(commandLine, name, list) {
  if (!list.length) return;
  const cur = String(commandLine.getSwitchValue(name) || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  commandLine.appendSwitch(name, [...new Set([...cur, ...list])].join(','));
}

function applyGpuSwitches(app, env = process.env) {
  const plan = gpuPlan(env);
  if (plan.accel === false) app.disableHardwareAcceleration();
  for (const s of plan.switches) if (!app.commandLine.hasSwitch(s)) app.commandLine.appendSwitch(s);
  mergeFeatures(app.commandLine, 'enable-features', plan.enableFeatures);
  return plan;
}

/** Paramètres > À propos: « Accélération graphique : activée / désactivée » from Chromium's own GPU status. */
function gpuStatus(app, plan) {
  let features = {};
  try {
    features = app.getGPUFeatureStatus() || {};
  } catch {}
  const on = (v) => typeof v === 'string' && v.startsWith('enabled');
  // The compositor on the GPU is what "hardware accelerated" means for the desktop.
  const enabled = on(features.gpu_compositing) && (on(features.webgl) || on(features.rasterization));
  return { enabled, rasterization: on(features.rasterization), video: on(features.video_decode), driver: plan?.driver || '', plan: plan?.accel ?? null, features };
}

module.exports = { gpuPlan, applyGpuSwitches, mergeFeatures, gpuStatus };
