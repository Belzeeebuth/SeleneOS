// Polling + history for Task Manager. One timer drives everything:
//   perf:snapshot every tick (cheap: a handful of /proc reads) -> header totals + Performance history,
//   proc:list / proc:shell only while a page that shows processes is visible.
// Polling stops while the window is minimized or the update speed is "Paused" (F5 still refreshes).
import { Emitter } from '../../../core/api.js';

export const SPEEDS = { high: 500, normal: 1000, low: 4000, paused: 0 };
const KEEP_MS = 65000;

export class Store extends Emitter {
  constructor(api) {
    super();
    this.api = api;
    this.speed = 'normal';
    this.perf = null;
    this.procs = null;
    this.shellInfo = null;
    this.needProcs = false;
    this.needShell = false;
    this.series = new Map();
    this.running = false;
    this.timer = null;
    this.busy = false;
    this.pending = false;
    this.error = null;
    this.ticks = 0;
    this.lastTick = 0;
  }

  get interval() {
    return SPEEDS[this.speed] ?? 1000;
  }

  setSpeed(s) {
    if (!(s in SPEEDS)) return;
    this.speed = s;
    this._schedule(this.interval || 0);
    this.emit('speed', s);
  }

  setNeeds({ procs = false, shell = false } = {}) {
    const more = (procs && !this.needProcs) || (shell && !this.needShell);
    this.needProcs = procs;
    this.needShell = shell;
    if (more) this.refresh();
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.refresh();
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    this.timer = null;
  }

  // For good (the window closed): a request still in flight is dropped when it returns.
  dispose() {
    this.disposed = true;
    this.stop();
  }

  // Fetch now (also while paused); the regular schedule resumes from here.
  refresh() {
    if (this.disposed) return;
    if (this.busy) {
      this.pending = true;
      return;
    }
    clearTimeout(this.timer);
    this.timer = null;
    this._tick();
  }

  _schedule(ms) {
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.running || !this.interval) return;
    this.timer = setTimeout(() => this._tick(), ms);
  }

  async _tick() {
    if (this.busy || this.disposed) return;
    this.busy = true;
    const inv = (ch) => this.api.invoke(ch);
    try {
      const [perf, procs, shellInfo] = await Promise.all([
        inv('perf:snapshot'),
        this.needProcs ? inv('proc:list') : null,
        this.needShell ? inv('proc:shell') : null,
      ]);
      this.perf = perf;
      if (procs) {
        this.procs = procs;
        this.procsAt = Date.now();
      }
      if (this.disposed) return;
      if (shellInfo) this.shellInfo = shellInfo;
      this._record(perf);
      this.error = null;
      this.ticks++;
      this.lastTick = Date.now();
      this.emit('tick', this);
    } catch (err) {
      this.error = err;
      if (!this.disposed) this.emit('error', err);
    } finally {
      this.busy = false;
      if (this.pending) {
        this.pending = false;
        setTimeout(() => this.refresh(), 0);
      } else this._schedule(this.interval);
    }
  }

  _push(key, t, v) {
    let s = this.series.get(key);
    if (!s) {
      s = [];
      this.series.set(key, s);
    }
    s.push([t, v]);
    while (s.length && t - s[0][0] > KEEP_MS) s.shift();
    if (s.length > 400) s.splice(0, s.length - 400);
  }

  _record(p) {
    const t = p.time || Date.now();
    this._push('cpu', t, p.cpu.total);
    p.cpu.perCore.forEach((v, i) => this._push(`cpu${i}`, t, v));
    this._push('mem', t, p.mem.used);
    for (const d of p.disks) {
      this._push(`disk:${d.name}:busy`, t, d.busyPct);
      this._push(`disk:${d.name}:read`, t, d.readBps);
      this._push(`disk:${d.name}:write`, t, d.writeBps);
    }
    for (const n of p.net) {
      this._push(`net:${n.iface}:rx`, t, n.rxBps);
      this._push(`net:${n.iface}:tx`, t, n.txBps);
    }
    if (p.gpu) this._push('gpu', t, p.gpu.busyPct);
  }

  get(key) {
    return this.series.get(key) || [];
  }

  // Largest value of a series over the visible minute (for auto-scaled charts).
  peak(key, now = Date.now(), span = 60000) {
    let m = 0;
    for (const [t, v] of this.get(key)) if (now - t <= span + 2000 && v > m) m = v;
    return m;
  }
}
