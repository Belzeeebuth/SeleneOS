'use strict';
// System information, power/session control, app discovery, shell-window helpers, clipboard.
//
//   sys:info                     -> {hostname, osName, version, distro, kernel, arch, cpu, cores, memTotal, user, fullName, live, machine, uptime}
//   sys:stats                    -> {cpu, cores:[...], mem:{total, used, available, swapTotal, swapUsed}, net:{rx, tx}, uptime}
//   sys:gpu                      -> {enabled, rasterization, video, driver, plan, features}  (app.getGPUFeatureStatus())
//   power:shutdown | power:reboot | power:suspend
//   session:logout               -> quits the shell (ends the X session -> back to login screen)
//   apps:list                    -> [manifest]   (renderer/apps/*/manifest.json)
//   shell:zoom (factor)          -> sets the shell zoom factor (display scaling)
//   shell:capture (rect?)        -> Uint8Array PNG of the shell window (or a sub-rectangle)
//   shell:devtools               -> toggles devtools (dev only)
//   clipboard:readText / clipboard:writeText (text) / clipboard:writeImage (pngBytes) / clipboard:readImage -> pngBytes|null
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { app, clipboard, nativeImage } = require('electron');
const { run } = require('../lib/exec');

function readFirst(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
}

function osRelease() {
  const txt = readFirst('/etc/os-release');
  const out = {};
  for (const line of txt.split('\n')) {
    const m = /^(\w+)=("?)(.*)\2$/.exec(line);
    if (m) out[m[1]] = m[3];
  }
  return out;
}

function fullName(user) {
  try {
    const line = fs.readFileSync('/etc/passwd', 'utf8').split('\n').find((l) => l.startsWith(`${user}:`));
    const gecos = line ? line.split(':')[4] : '';
    return (gecos || '').split(',')[0] || user;
  } catch {
    return user;
  }
}

let prevCpu = null;
function cpuSample() {
  const lines = readFirst('/proc/stat').split('\n').filter((l) => /^cpu\d* /.test(l));
  return lines.map((l) => {
    const v = l.trim().split(/\s+/).slice(1).map(Number);
    const idle = v[3] + (v[4] || 0);
    const total = v.reduce((a, b) => a + b, 0);
    return { idle, total };
  });
}

function memInfo() {
  const m = {};
  for (const line of readFirst('/proc/meminfo').split('\n')) {
    const r = /^(\w+):\s+(\d+)/.exec(line);
    if (r) m[r[1]] = Number(r[2]) * 1024;
  }
  return {
    total: m.MemTotal || os.totalmem(),
    available: m.MemAvailable ?? os.freemem(),
    used: (m.MemTotal || os.totalmem()) - (m.MemAvailable ?? os.freemem()),
    cached: (m.Cached || 0) + (m.Buffers || 0),
    swapTotal: m.SwapTotal || 0,
    swapUsed: (m.SwapTotal || 0) - (m.SwapFree || 0),
  };
}

function netTotals() {
  let rx = 0;
  let tx = 0;
  for (const line of readFirst('/proc/net/dev').split('\n').slice(2)) {
    const [iface, rest] = line.split(':');
    if (!rest || iface.trim() === 'lo') continue;
    const v = rest.trim().split(/\s+/).map(Number);
    rx += v[0];
    tx += v[8];
  }
  return { rx, tx };
}

module.exports = function register(api) {
  const { env, DEV } = api;

  api.handle('sys:info', () => {
    const rel = osRelease();
    const cpus = os.cpus();
    return {
      hostname: os.hostname(),
      osName: 'Selene OS',
      version: env.version,
      distro: rel.PRETTY_NAME || 'Linux',
      kernel: os.release(),
      arch: os.arch(),
      cpu: cpus[0]?.model?.replace(/\s+/g, ' ').trim() || 'Unknown CPU',
      cores: cpus.length,
      memTotal: os.totalmem(),
      user: env.user,
      fullName: fullName(env.user),
      live: env.live,
      machine: [readFirst('/sys/class/dmi/id/sys_vendor'), readFirst('/sys/class/dmi/id/product_name')].filter(Boolean).join(' ') || 'Virtual machine',
      uptime: os.uptime(),
      buildId: readFirst('/etc/aurora/build-id') || 'dev',
    };
  });

  api.handle('sys:gpu', async () => {
    const { gpuPlan, gpuStatus } = require('../lib/gpu-flags');
    // the GPU process reports its status once it is up (a moment after the first window)
    try {
      await app.getGPUInfo('basic');
    } catch {}
    return gpuStatus(app, gpuPlan(process.env));
  });

  api.handle('sys:stats', () => {
    const cur = cpuSample();
    let cpu = 0;
    let cores = [];
    if (prevCpu && prevCpu.length === cur.length) {
      const pct = (a, b) => {
        const dt = b.total - a.total;
        return dt > 0 ? Math.max(0, Math.min(100, (1 - (b.idle - a.idle) / dt) * 100)) : 0;
      };
      cpu = pct(prevCpu[0], cur[0]);
      cores = cur.slice(1).map((c, i) => pct(prevCpu[i + 1], c));
    }
    prevCpu = cur;
    return { cpu, cores, mem: memInfo(), net: netTotals(), uptime: os.uptime(), loadavg: os.loadavg() };
  });

  const systemctl = async (verb) => {
    if (DEV) {
      console.log(`[power] (dev) systemctl ${verb}`);
      return true;
    }
    const r = await run('systemctl', [verb], { timeout: 15000 });
    if (r.code !== 0) throw api.error(r.stderr.trim() || `systemctl ${verb} failed`, 'EPOWER');
    return true;
  };
  api.handle('power:shutdown', () => systemctl('poweroff'));
  api.handle('power:reboot', () => systemctl('reboot'));
  api.handle('power:suspend', () => systemctl('suspend'));
  api.handle('session:logout', () => {
    setTimeout(() => app.quit(), 50);
    return true;
  });

  api.handle('apps:list', async () => {
    const dir = path.join(api.RENDERER, 'apps');
    const out = [];
    let names = [];
    try {
      names = await fsp.readdir(dir);
    } catch {}
    for (const n of names.sort()) {
      try {
        const m = JSON.parse(await fsp.readFile(path.join(dir, n, 'manifest.json'), 'utf8'));
        if (!m.id) m.id = n;
        if (m.id !== n) console.warn(`[apps] manifest id ${m.id} != folder ${n}`);
        m.id = n;
        if (m.liveOnly && !env.live && !DEV) continue;
        out.push(m);
      } catch (err) {
        if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') console.error(`[apps] bad manifest in ${n}:`, err.message);
      }
    }
    return out;
  });

  api.handle('shell:features', async () => {
    try {
      return (await fsp.readdir(path.join(api.RENDERER, 'core', 'features'))).filter((f) => f.endsWith('.js')).map((f) => f.slice(0, -3));
    } catch {
      return [];
    }
  });
  api.handle('shell:zoom', (factor) => {
    const w = api.getMainWindow();
    if (w) w.webContents.setZoomFactor(Math.max(0.5, Math.min(3, Number(factor) || 1)));
    return true;
  });
  api.handle('shell:capture', async (rect) => {
    const w = api.getMainWindow();
    if (!w) throw api.error('No window', 'ENOWIN');
    const zoom = w.webContents.getZoomFactor();
    const r = rect
      ? { x: Math.round(rect.x * zoom), y: Math.round(rect.y * zoom), width: Math.max(1, Math.round(rect.width * zoom)), height: Math.max(1, Math.round(rect.height * zoom)) }
      : undefined;
    const img = await w.webContents.capturePage(r);
    return new Uint8Array(img.toPNG());
  });
  api.handle('shell:devtools', () => {
    const w = api.getMainWindow();
    if (w) w.webContents.toggleDevTools();
    return true;
  });
  api.handle('shell:screenSize', () => {
    const { screen } = require('electron');
    const d = screen.getPrimaryDisplay();
    return { width: d.size.width, height: d.size.height, scaleFactor: d.scaleFactor };
  });

  api.handle('clipboard:readText', () => clipboard.readText());
  api.handle('clipboard:writeText', (t) => {
    clipboard.writeText(String(t ?? ''));
    return true;
  });
  // Images: Electron 44 replaced clipboard.writeImage/readImage with the async W3C-style
  // clipboard.write/read of ClipboardItems; support both.
  api.handle('clipboard:writeImage', async (bytes) => {
    const buf = Buffer.from(bytes);
    if (typeof clipboard.writeImage === 'function') {
      clipboard.writeImage(nativeImage.createFromBuffer(buf));
      return true;
    }
    const Item = require('electron').ClipboardItem;
    if (!Item || typeof clipboard.write !== 'function') throw api.error('Clipboard images are not supported', 'ENOCLIP');
    await clipboard.write([new Item({ 'image/png': new Blob([buf], { type: 'image/png' }) })]);
    return true;
  });
  api.handle('clipboard:readImage', async () => {
    if (typeof clipboard.readImage === 'function') {
      const img = clipboard.readImage();
      return img.isEmpty() ? null : new Uint8Array(img.toPNG());
    }
    if (typeof clipboard.read !== 'function') return null;
    for (const item of (await clipboard.read()) || []) {
      const types = item.types || [];
      const type = types.includes('image/png') ? 'image/png' : types.find((t) => /^image\//.test(t));
      if (!type) continue;
      const blob = await item.getType(type);
      if (blob && typeof blob.arrayBuffer === 'function') return new Uint8Array(await blob.arrayBuffer());
    }
    return null;
  });
};
