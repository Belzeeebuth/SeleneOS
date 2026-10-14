'use strict';
// Scanners backend (apps/scan « Numérisation », Paramètres > Imprimantes et scanners). SANE's scanimage (sane-utils),
// run as the signed-in user with an argument vector (never a shell, never root); parsers in main/lib/sane.js.
// USB scanners come through the SANE backends (libsane1: udev hwdb + uaccess give the active session access), network
// and IPP-over-USB scanners through sane-airscan (eSCL / WSD, driverless, like IPP Everywhere for printers).
//
//   scan:devices ({ refresh }) -> { available, devices: [Device], simulated }
//       Device = { name, label, vendor, model, type, kind: flatbed|mfp|sheetfed|film|handheld, connection: usb|network,
//                  protocol: 'eSCL'|'WSD'|null, address, backend }
//       `scanimage -f '%d<US>%v<US>%m<US>%t%n'`; webcams (v4l) left out, a scanner seen twice (airscan + escl, eSCL +
//       WSD) listed once. Kept 15 s unless refresh. available: false when scanimage is not installed.
//   scan:options (device, { source }) -> { device, resolutions: { list|null, range: { min, max, step }|null, def },
//       modes: [{ value, kind: color|gray|lineart }], mode, sources: [{ id, value, kind: flatbed|adf|adf-duplex|film|other,
//       adfMode }], source, area: { unit: 'mm'|'px', width, height } | null, preview: dpi }
//       `scanimage --device-name=DEV [--source=S] -A` (the source changes the area: feeders are often longer).
//   scan:scan (jobId, device, { kind: 'preview'|'scan', resolution, mode, source, area: { left, top, width, height },
//       format: 'png'|'tiff', batch }) -> { pages: [Page], cancelled, error: { code, message } | null }
//       Page = { path, width, height, dpi, format }   (a PNG / TIFF in this session's temp folder, 0700)
//       Events to the asking window: scan:progress { jobId, page, percent }, scan:page { jobId, page: Page, index }.
//       mode: a kind (color|gray|lineart) or one of the scanner's values; source: an id from scan:options. Preview: the
//       lowest resolution near 75 dpi, whole area, colour, flatbed only. Feeder sources (and a sheet-fed scanner
//       without a source option, when batch is true) scan pages until the feeder is empty
//       (`--batch=DIR/page-%03d.png --batch-print`), at most 500. Area in the scanner's unit (mm), clamped.
//       Rejects when no page was scanned: EBUSY (in use), ECOVER (cover open), ENODOCS (feeder empty), EJAM (paper jam),
//       EGONE (scanner disconnected / not answering), EACCES (no permission on the device), ENOMEM, ETIMEDOUT (no
//       output for 3 min), EINVAL (bad argument), ENOTSUP (scanimage missing), ESCAN (other). A feeder batch that
//       stops on an error after some pages resolves with those pages and `error`.
//   scan:cancel (jobId) -> { ok }     SIGTERM to the process group (scanimage asks the scanner to stop and park its
//                                      head), SIGTERM again after 4 s (scanimage then exits), SIGKILL after 8 s.
//   scan:discard (paths) -> { removed }   deletes temporary scans (only files inside this session's temp folder)
//   scan:cleanup () -> { ok }        removes the session's temp folder (Numérisation calls it when it closes)
//
// Dev / tests: the fake scanimage of test/fixtures/scan/bin is used when AURORA_SCAN_FIXTURE is set, or in dev mode
// when scanimage is missing (this machine). Its scanners and failures are driven by $AURORA_SCAN_FAKE_DIR/ctl.json.
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { which } = require('../lib/exec');
const sane = require('../lib/sane');

const FAKE = path.join(__dirname, '..', '..', 'test', 'fixtures', 'scan', 'bin', 'scanimage');
const LIST_TTL = 15000;
const IDLE_LIMIT = 180000; // no output for 3 minutes: the scanner stopped answering
const TOTAL_LIMIT = 60 * 60000;
const MAX_PAGES = 500;
const JOB_ID = /^[A-Za-z0-9_-]{1,64}$/;

function err(message, code) {
  const e = new Error(message);
  e.code = code;
  return e;
}

module.exports = function register(api) {
  const bin = () => {
    if (process.env.AURORA_SCAN_FIXTURE) return fs.existsSync(FAKE) ? FAKE : null;
    const real = which('scanimage');
    if (real) return real;
    return api.DEV && fs.existsSync(FAKE) ? FAKE : null;
  };
  const env = () => ({ ...process.env, LC_ALL: 'C' });
  let listCache = null; // { at, devices }
  const known = new Set(); // every device name a listing returned in this session
  const optCache = new Map(); // `${device}\n${source}` -> summary
  const jobs = new Map(); // jobId -> job
  const busy = new Map(); // device -> jobId
  let tmpRoot = null;

  /** Runs scanimage, collects its output (capped), kills the group after `timeout`. */
  const asRoot = () => typeof process.getuid === 'function' && process.getuid() === 0;
  function exec(args, timeout) {
    if (asRoot()) return Promise.reject(err('scanimage is never run as root', 'EPERM'));
    const b = bin();
    if (!b) return Promise.reject(err('scanimage is not installed (sane-utils)', 'ENOTSUP'));
    return new Promise((resolve) => {
      let out = '';
      let errText = '';
      const child = spawn(b, args, { env: env(), stdio: ['ignore', 'pipe', 'pipe'], detached: true });
      const timer = setTimeout(() => killGroup(child, 'SIGKILL'), timeout);
      child.stdout.on('data', (d) => (out = (out + d).slice(-4e6)));
      child.stderr.on('data', (d) => (errText = (errText + d).slice(-64000)));
      child.on('error', (e) => {
        clearTimeout(timer);
        resolve({ code: 127, stdout: out, stderr: String(e.message) });
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        resolve({ code: code ?? 1, signal, stdout: out, stderr: errText });
      });
    });
  }

  function killGroup(child, sig) {
    try {
      process.kill(-child.pid, sig);
    } catch {
      try {
        child.kill(sig);
      } catch {}
    }
  }

  async function devices(refresh) {
    if (!bin()) return { available: false, devices: [], simulated: false };
    if (!refresh && listCache && Date.now() - listCache.at < LIST_TTL) return { available: true, devices: listCache.devices, simulated: bin() === FAKE };
    const r = await exec(['-f', sane.LIST_FORMAT], 30000);
    optCache.clear();
    const list = r.code === 0 || r.stdout ? sane.devicesOf(r.stdout) : [];
    for (const d of list) known.add(d.name);
    listCache = { at: Date.now(), devices: list };
    return { available: true, devices: list, simulated: bin() === FAKE, ...(r.code !== 0 && !list.length ? { warning: sane.errorOf(r.stderr, r.code).message } : {}) };
  }

  async function checkDevice(device) {
    if (!sane.validDevice(device)) throw err('Invalid scanner name', 'EINVAL');
    if (!known.has(device)) await devices(true);
    if (!known.has(device)) throw err('This scanner is not connected', 'EGONE');
  }

  async function options(device, source) {
    await checkDevice(device);
    const key = `${device}\n${source || ''}`;
    if (optCache.has(key)) return optCache.get(key);
    let value = null;
    if (source) {
      const base = await options(device, null);
      const s = base.sources.find((x) => x.id === source);
      if (!s) throw err('Unknown source', 'EINVAL');
      value = s.value;
    }
    const args = [`--device-name=${device}`];
    if (value) args.push(`--source=${value}`);
    args.push('-A');
    const r = await exec(args, 45000);
    if (r.code !== 0 && !/^\s*-/m.test(r.stdout)) {
      const e = sane.errorOf(r.stderr, r.code);
      throw err(e.message, r.code === 127 ? 'ENOTSUP' : e.code);
    }
    const summary = { device, ...sane.summarizeOptions(sane.parseOptions(r.stdout)) };
    // the sources of the whole device (setting a feeder source can hide the others on some backends)
    if (source) {
      const base = optCache.get(`${device}\n`);
      if (base) Object.assign(summary, { sources: base.sources });
      summary.source = source;
    }
    summary.preview = sane.previewResolution(summary.resolutions);
    optCache.set(key, summary);
    return summary;
  }

  async function sessionDir() {
    if (tmpRoot && fs.existsSync(tmpRoot)) return tmpRoot;
    tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'aurora-scan-'));
    await fsp.chmod(tmpRoot, 0o700).catch(() => {});
    return tmpRoot;
  }
  const insideTmp = (p) => {
    if (!tmpRoot || typeof p !== 'string' || p.includes('\0')) return false;
    const rel = path.relative(tmpRoot, path.resolve(p));
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  };

  async function pageOf(file, dpi, format) {
    const fd = await fsp.open(file, 'r');
    let head;
    try {
      head = Buffer.alloc(65536);
      const { bytesRead } = await fd.read(head, 0, head.length, 0);
      head = head.subarray(0, bytesRead);
    } finally {
      await fd.close();
    }
    const info = format === 'png' ? sane.pngInfo(head) : null;
    return { path: file, width: info?.width || null, height: info?.height || null, dpi: info?.dpiX && Math.abs(info.dpiX - dpi) < dpi * 0.02 ? dpi : info?.dpiX || dpi, format };
  }

  /** Validates what the renderer asked against the scanner's own options; returns scanimage's values. */
  function resolveRequest(opts, o) {
    const kind = o.kind === 'preview' ? 'preview' : 'scan';
    const format = ['png', 'tiff'].includes(o.format) ? o.format : 'png';
    const src = o.source ? opts.sources.find((s) => s.id === o.source || s.value === o.source) : opts.sources.find((s) => s.id === opts.source) || null;
    if (o.source && !src) throw err('Unknown source', 'EINVAL');
    const feeder = /^adf/.test(src?.kind || '');
    if (kind === 'preview' && feeder) throw err('A preview needs the flatbed', 'EINVAL');
    const modeKind = kind === 'preview' ? (opts.modes.some((m) => m.kind === 'color') ? 'color' : null) : o.mode || null;
    const mode = modeKind ? opts.modes.find((m) => m.kind === modeKind || m.value === modeKind) : null;
    if (o.mode && kind !== 'preview' && !mode) throw err('Unknown mode', 'EINVAL');
    let resolution;
    if (kind === 'preview') resolution = opts.preview;
    else if (o.resolution != null) {
      resolution = Number(o.resolution);
      const r = opts.resolutions;
      const ok = Number.isInteger(resolution) && resolution > 0 && resolution <= 19200 && (r.list ? r.list.includes(resolution) : r.range ? resolution >= r.range.min && resolution <= r.range.max : true);
      if (!ok) throw err('Unsupported resolution', 'EINVAL');
    }
    let area = null;
    if (opts.area) {
      const W = opts.area.width;
      const H = opts.area.height;
      const a = kind === 'preview' || !o.area ? { left: 0, top: 0, width: W, height: H } : o.area;
      const nums = [a.left, a.top, a.width, a.height].map(Number);
      if (!nums.every(Number.isFinite)) throw err('Invalid scan area', 'EINVAL');
      let [l, t, w, h] = nums;
      l = Math.min(Math.max(0, l), W);
      t = Math.min(Math.max(0, t), H);
      w = Math.min(Math.max(0, w), W - l);
      h = Math.min(Math.max(0, h), H - t);
      if (w < 1 || h < 1) throw err('The scan area is too small', 'EINVAL');
      area = { left: l, top: t, width: w, height: h };
    }
    // a sheet-fed scanner with no source option: the renderer asks for a batch itself
    const batch = kind === 'scan' && (feeder ? o.batch !== false : o.batch === true && !opts.sources.length);
    return { kind, format, src, feeder, mode, resolution, area, batch };
  }

  async function scan(jobId, device, o = {}, event) {
    if (typeof jobId !== 'string' || !JOB_ID.test(jobId) || jobs.has(jobId)) throw err('Invalid job id', 'EINVAL');
    if (!o || typeof o !== 'object') throw err('Invalid options', 'EINVAL');
    await checkDevice(device);
    if (busy.has(device)) throw err('A scan is already running on this scanner', 'EBUSY');
    const job = { id: jobId, device, child: null, cancelled: false, pages: [], sender: event?.sender, dir: null, starting: true };
    jobs.set(jobId, job);
    busy.set(device, jobId);
    try {
      const base = await options(device, null);
      const wanted = o.source ? base.sources.find((s) => s.id === o.source || s.value === o.source) : null;
      if (o.source && !wanted) throw err('Unknown source', 'EINVAL');
      // a feeder source can have other limits (longer pages): its own options
      const opts = wanted && wanted.id !== base.source && base.sources.length > 1 ? await options(device, wanted.id).catch(() => base) : base;
      const req = resolveRequest(opts, o);
      if (job.cancelled) return { pages: [], cancelled: true, error: null };
      job.dir = await fsp.mkdtemp(path.join(await sessionDir(), `${req.kind}-`));
      const ext = req.format === 'tiff' ? 'tiff' : 'png';
      const output = path.join(job.dir, `${req.kind}.${ext}`);
      const args = sane.scanArgs(device, {
        format: req.format,
        source: req.src && base.sources.length > 1 ? req.src.value : null,
        adfMode: req.src?.adfMode || null,
        mode: req.mode?.value || null,
        resolution: req.resolution || null,
        area: req.area,
        batch: req.batch ? path.join(job.dir, `page-%03d.${ext}`) : null,
        output: req.batch ? null : output,
      });
      return await runScan(job, args, { ...req, output, ext });
    } finally {
      jobs.delete(jobId);
      if (busy.get(device) === jobId) busy.delete(device);
    }
  }

  function runScan(job, args, req) {
    if (asRoot()) return Promise.reject(err('scanimage is never run as root', 'EPERM'));
    const b = bin();
    if (!b) return Promise.reject(err('scanimage is not installed (sane-utils)', 'ENOTSUP'));
    const send = (ch, payload) => api.sendTo(job.sender, ch, payload);
    const dpi = req.resolution || 0;
    return new Promise((resolve, reject) => {
      let stderrTail = '';
      let stdoutBuf = '';
      let errBuf = '';
      let page = 1;
      let lastPercent = -1;
      let lastSent = 0;
      let idle = null;
      const pending = [];
      const child = spawn(b, args, { env: env(), stdio: ['ignore', 'pipe', 'pipe'], detached: true });
      job.child = child;
      const total = setTimeout(() => ((job.timedOut = true), killGroup(child, 'SIGKILL')), TOTAL_LIMIT);
      const poke = () => {
        clearTimeout(idle);
        idle = setTimeout(() => ((job.timedOut = true), killGroup(child, 'SIGKILL')), IDLE_LIMIT);
      };
      poke();
      const progress = (percent) => {
        const now = Date.now();
        if (percent === lastPercent || (now - lastSent < 120 && percent < 100)) return;
        lastPercent = percent;
        lastSent = now;
        send('scan:progress', { jobId: job.id, page, percent });
      };
      const pageDone = (file) => {
        const abs = path.resolve(file.trim());
        if (path.dirname(abs) !== job.dir || !fs.existsSync(abs)) return;
        if (job.pages.some((p) => p.path === abs)) return;
        pending.push(
          pageOf(abs, dpi, req.format).then((p) => {
            job.pages.push(p);
            job.pages.sort((a, c) => a.path.localeCompare(c.path));
            send('scan:page', { jobId: job.id, page: p, index: job.pages.indexOf(p) });
            if (job.pages.length >= MAX_PAGES && !job.limit) {
              job.limit = true;
              killGroup(child, 'SIGTERM');
            }
          }),
        );
      };
      child.stdout.on('data', (d) => {
        poke();
        stdoutBuf += d;
        const lines = stdoutBuf.split('\n');
        stdoutBuf = lines.pop();
        if (req.batch) for (const l of lines) if (l.trim()) pageDone(l);
        if (stdoutBuf.length > 65536) stdoutBuf = '';
      });
      child.stderr.on('data', (d) => {
        poke();
        const s = String(d);
        stderrTail = (stderrTail + s).slice(-16000);
        errBuf += s;
        const parts = errBuf.split(/[\r\n]/);
        errBuf = parts.pop();
        for (const line of parts) {
          let m = /^Progress:\s*([\d.]+)%/.exec(line);
          if (m) progress(Math.max(0, Math.min(100, Math.round(Number(m[1])))));
          else if ((m = /^Scanning page (\d+)/.exec(line))) {
            page = Number(m[1]);
            lastPercent = -1;
            progress(0);
          }
        }
        if (errBuf.length > 4096) errBuf = '';
      });
      child.on('error', (e) => {
        clearTimeout(total);
        clearTimeout(idle);
        reject(err(e.code === 'ENOENT' ? 'scanimage is not installed (sane-utils)' : e.message, e.code === 'ENOENT' ? 'ENOTSUP' : 'ESCAN'));
      });
      child.on('close', async (code, signal) => {
        clearTimeout(total);
        clearTimeout(idle);
        clearTimeout(job.killTimer);
        clearTimeout(job.killTimer2);
        if (req.batch && stdoutBuf.trim()) pageDone(stdoutBuf);
        // pages written but not printed yet (the last --batch-print line may race the exit)
        if (req.batch && !job.cancelled) for (const f of (await fsp.readdir(job.dir).catch(() => [])).sort()) if (/^page-\d+\.(png|tiff)$/.test(f)) pageDone(path.join(job.dir, f));
        await Promise.allSettled(pending);
        // whatever scanimage left half-written (.part files, a cancelled single page)
        const leftovers = async (keep) => {
          for (const f of await fsp.readdir(job.dir).catch(() => [])) {
            const p = path.join(job.dir, f);
            if (!keep.includes(p)) await fsp.rm(p, { force: true }).catch(() => {});
          }
        };
        if (job.limit) {
          await leftovers(job.pages.map((p) => p.path));
          return resolve({ pages: job.pages, cancelled: false, error: null });
        }
        if (job.cancelled) {
          await leftovers(job.pages.map((p) => p.path));
          return resolve({ pages: job.pages, cancelled: true, error: null });
        }
        if (job.timedOut) {
          await leftovers(job.pages.map((p) => p.path));
          const e = { code: 'ETIMEDOUT', message: 'The scanner stopped answering' };
          return job.pages.length ? resolve({ pages: job.pages, cancelled: false, error: e }) : reject(err(e.message, e.code));
        }
        if (code === 0 && !req.batch) {
          if (fs.existsSync(req.output)) {
            const p = await pageOf(req.output, dpi, req.format).catch(() => null);
            if (p) {
              job.pages.push(p);
              send('scan:page', { jobId: job.id, page: p, index: 0 });
              return resolve({ pages: job.pages, cancelled: false, error: null });
            }
          }
          return reject(err('The scanner sent no image', 'ESCAN'));
        }
        if (code === 0) {
          await leftovers(job.pages.map((p) => p.path));
          if (job.pages.length) return resolve({ pages: job.pages, cancelled: false, error: null });
          return reject(err('Document feeder out of documents', 'ENODOCS'));
        }
        const e = sane.errorOf(stderrTail, signal ? 1 : code);
        await leftovers(job.pages.map((p) => p.path));
        if (job.pages.length) return resolve({ pages: job.pages, cancelled: false, error: e });
        reject(err(e.message, e.code));
      });
    });
  }

  function cancel(jobId) {
    const job = jobs.get(jobId);
    if (!job) return { ok: false };
    job.cancelled = true;
    if (!job.child) return { ok: true };
    killGroup(job.child, 'SIGTERM');
    job.killTimer = setTimeout(() => killGroup(job.child, 'SIGTERM'), 4000);
    job.killTimer2 = setTimeout(() => killGroup(job.child, 'SIGKILL'), 8000);
    return { ok: true };
  }

  api.handle('scan:devices', async (o = {}) => devices(!!o?.refresh));
  api.handle('scan:options', async (device, o = {}) => {
    const source = o?.source == null ? null : String(o.source);
    if (source !== null && !/^(flatbed|adf|adf-duplex|film|other:.{1,120})$/.test(source)) throw err('Unknown source', 'EINVAL');
    const base = await options(device, null);
    if (!source || source === base.source) return base;
    return options(device, source);
  });
  // the IPC event comes last, after however many arguments the window sent
  api.handle('scan:scan', (...a) => {
    const event = a.pop();
    return scan(a[0], a[1], a[2] && typeof a[2] === 'object' ? a[2] : {}, event);
  });
  api.handle('scan:cancel', async (jobId) => cancel(String(jobId || '')));
  api.handle('scan:discard', async (paths) => {
    let removed = 0;
    for (const p of Array.isArray(paths) ? paths.slice(0, 2000) : []) {
      if (!insideTmp(p)) continue;
      await fsp.rm(path.resolve(p), { force: true }).then(() => removed++, () => {});
    }
    return { removed };
  });
  api.handle('scan:cleanup', async () => {
    if (jobs.size) return { ok: false };
    if (tmpRoot) await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
    tmpRoot = null;
    return { ok: true };
  });

  // a scan still running when the shell quits: stop the scanner, do not leave the temp folder behind
  process.on('exit', () => {
    for (const job of jobs.values()) if (job.child) killGroup(job.child, 'SIGTERM');
    if (tmpRoot) {
      try {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      } catch {}
    }
  });
};
