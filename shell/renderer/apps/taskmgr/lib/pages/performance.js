// Performance page: the selected device's detail: its current value in large type, one 60-second
// area chart, key figures as chips and a short "Details" card. The meters along the top of the
// window are the device picker; a small chip row above the detail chooses among several disks or
// several network adapters, and only shows when there is more than one.
import { Chart, niceMax } from '../chart.js';

const SPAN = 60000;

export class PerformancePage {
  constructor(app) {
    this.app = app;
    this.id = 'performance';
    this.icon = 'pulse';
    this.needs = { procs: false, shell: false };
    this.devices = [];
    this.devSig = '';
    this.selected = 'cpu';
    this.lastOf = {}; // kind -> the disk / adapter last chosen, for the meters
    this.tiles = new Map();
    this.detail = null;
    this.colors = {};
  }

  title() {
    return this.app.t('nav.performance');
  }

  mount(el) {
    const { h } = this.app.ctx;
    this.list = h('div', { class: 'tm-devs', role: 'listbox', tabindex: '0', hidden: true, 'aria-label': this.app.t('perf.disks') });
    this.detailEl = h('div', { class: 'tm-pd' });
    this.root = h('div', { class: 'tm-perf' }, this.list, this.detailEl);
    el.appendChild(this.root);
    this.list.addEventListener('keydown', (e) => {
      if (e.defaultPrevented) return; // an open menu's keys
      const ids = this.siblings().map((d) => d.id);
      const i = ids.indexOf(this.selected);
      let j = null;
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') j = Math.min(ids.length - 1, i + 1);
      else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') j = Math.max(0, i - 1);
      else if (e.key === 'Home') j = 0;
      else if (e.key === 'End') j = ids.length - 1;
      if (j == null) return;
      e.preventDefault();
      this.select(ids[j]);
    });
    this.root.addEventListener('keydown', (e) => {
      if (e.defaultPrevented) return;
      if (e.ctrlKey && (e.key === 'c' || e.key === 'C') && !String(window.getSelection?.() || '')) {
        e.preventDefault();
        this.copy();
      }
    });
    this.root.addEventListener('contextmenu', (e) => {
      if (!this.detailEl.contains(e.target)) return;
      e.preventDefault();
      this.app.menu(e, this.chartMenu());
    });
  }

  focus() {
    if (!this.list.hidden) this.list.focus({ preventScroll: true });
    else this.app.meters?.get(this.kindOf(this.selected))?.focus({ preventScroll: true });
  }
  kindOf(id) {
    return String(id).split(':')[0];
  }
  // The devices of the selected one's kind (all the disks, all the adapters).
  siblings() {
    const kind = this.kindOf(this.selected);
    return this.devices.filter((d) => d.kind === kind);
  }
  show() {
    this.readColors();
    if (this.app.store.perf) this.update(this.app.store);
  }
  onPref(key) {
    if (key === 'cpuGraph' && this.selected === 'cpu') this.buildDetail();
  }
  relabel() {
    this.devSig = '';
    if (this.app.store.perf) {
      this.syncDevices(this.app.store.perf);
      this.buildDetail();
      this.update(this.app.store);
    }
  }

  readColors() {
    const cs = getComputedStyle(this.root);
    for (const k of ['cpu', 'mem', 'disk', 'net', 'gpu']) this.colors[k] = cs.getPropertyValue(`--tm-c-${k}`).trim() || '#117dbb';
    const theme = document.documentElement.dataset.theme;
    if (this._theme !== theme) {
      this._theme = theme;
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------------ devices
  syncDevices(p) {
    const { t } = this.app;
    const devs = [{ id: 'cpu', kind: 'cpu' }, { id: 'mem', kind: 'mem' }];
    p.disks.forEach((d, i) => devs.push({ id: `disk:${d.name}`, kind: 'disk', name: d.name, index: i }));
    let eth = 0;
    let wifi = 0;
    for (const n of p.net) devs.push({ id: `net:${n.iface}`, kind: 'net', name: n.iface, index: n.type === 'wifi' ? wifi++ : eth++, wifi: n.type === 'wifi' });
    if (p.gpu) devs.push({ id: 'gpu', kind: 'gpu' });
    const sig = devs.map((d) => d.id).join('|');
    if (sig === this.devSig) return false;
    this.devSig = sig;
    this.devices = devs;
    const { h } = this.app.ctx;
    this.list.textContent = '';
    this.tiles.clear();
    for (const d of devs) {
      if (d.kind !== 'disk' && d.kind !== 'net') continue;
      const t1 = h('span', { class: 'tm-dev-title ellipsis' });
      const t2 = h('span', { class: 'tm-dev-sub ellipsis' });
      const t3 = h('span', { class: 'tm-dev-val ellipsis' });
      const el = h(
        'div',
        { class: ['tm-dev', `k-${d.kind}`], role: 'option', id: `tm-dev-${d.id.replace(/[^\w-]/g, '_')}`, 'aria-selected': 'false', dataset: { dev: d.id }, onclick: () => this.select(d.id) },
        h('span', { class: 'tm-dev-text' }, t1, t2, t3),
      );
      this.tiles.set(d.id, { el, t1, t2, t3, dev: d });
      this.list.appendChild(el);
    }
    if (!devs.some((d) => d.id === this.selected)) this.selected = 'cpu';
    this.markSelected();
    return true;
  }

  devLabel(d) {
    const { t } = this.app;
    const p = this.app.store.perf;
    if (d.kind === 'cpu') return t('perf.cpu');
    if (d.kind === 'mem') return t('perf.memory');
    if (d.kind === 'gpu') return t('perf.gpu', { n: 0 });
    if (d.kind === 'disk') {
      const disk = p.disks.find((x) => x.name === d.name);
      const mounts = disk?.mounts?.length ? ` (${disk.mounts.slice(0, 2).join(' ')}${disk.mounts.length > 2 ? ' …' : ''})` : '';
      return `${t('perf.disk', { n: d.index })}${mounts}`;
    }
    return d.wifi ? t('perf.wifi') : t('perf.ethernet');
  }

  select(id) {
    if (!this.devices.some((d) => d.id === id)) return;
    this.selected = id;
    this.lastOf[this.kindOf(id)] = id;
    this.markSelected();
    this.buildDetail();
    if (this.app.store.perf) this.update(this.app.store, { animate: false });
    if (this.app.current === this) this.app.updateMeters?.();
  }
  // The chip row lists the selected device's siblings, and only when there are several.
  markSelected() {
    const kind = this.kindOf(this.selected);
    const many = this.devices.filter((d) => d.kind === kind).length > 1;
    const hadFocus = this.list.contains(document.activeElement);
    this.list.hidden = !many;
    this.list.setAttribute('aria-label', this.app.t(kind === 'net' ? 'perf.adapters' : 'perf.disks'));
    for (const [id, tile] of this.tiles) {
      const on = id === this.selected;
      tile.el.hidden = !many || tile.dev.kind !== kind;
      tile.el.classList.toggle('selected', on);
      tile.el.setAttribute('aria-selected', String(on));
      if (on) this.list.setAttribute('aria-activedescendant', tile.el.id);
    }
    if (!many) this.list.removeAttribute('aria-activedescendant');
    if (hadFocus && !many) this.focus();
  }

  // ------------------------------------------------------------------ detail
  // Selene layout: a header (device name, its model, the current value in large type), ONE area
  // chart (soft accent fill, faint baseline, the time span as a caption), a few key figures as
  // chips, then the hardware details in a short card (the less useful lines behind "Show all").
  buildDetail() {
    const { h } = this.app.ctx;
    const { t } = this.app;
    const dev = this.devices.find((d) => d.id === this.selected);
    for (const c of this.detail?.charts || []) c.destroy();
    this.detailEl.textContent = '';
    if (!dev) return;
    const charts = [];
    const stat = (label, cls) => {
      const v = h('div', { class: 'tm-stat-v' });
      const el = h('div', { class: ['tm-stat', cls] }, h('div', { class: 'tm-stat-l' }, label), v);
      return { el, v };
    };
    const kvRow = (label, more) => {
      const v = h('dd', { class: more ? 'more' : null });
      return { el: [h('dt', { class: more ? 'more' : null }, label), v], v };
    };
    const title = h('h2', { class: 'tm-pd-title' }, this.devLabel(dev).replace(/ \(.*$/, ''));
    const sub = h('div', { class: 'tm-pd-sub ellipsis' });
    const value = h('div', { class: 'tm-pd-value', 'aria-live': 'off' });
    const head = h('div', { class: 'tm-pd-head' }, h('div', { class: 'tm-pd-name' }, title, sub), value);
    const chartBox = (label, opts = {}) => {
      const chart = new Chart({ label, grid: false });
      charts.push(chart);
      const scale = h('span', { class: 'tm-chart-scale' });
      const wrap = h('div', { class: ['tm-chart', opts.cls] }, chart.canvas);
      const box = h('div', { class: ['tm-chartbox', opts.box] }, wrap, h('div', { class: 'tm-chart-cap' }, h('span', { class: 'tm-chart-span' }, t('perf.lastMinute')), scale));
      return { chart, box, scale, wrap };
    };
    const d = { kind: dev.kind, dev, charts, sub, title, value, valueLabel: '', stats: {}, kv: {} };
    const body = h('div', { class: ['tm-pd-body', `k-${dev.kind}`] });
    const chips = h('div', { class: 'tm-stats', role: 'list' });
    const kv = h('dl', { class: 'tm-kv tm-kv-perf' });
    let moreCount = 0;
    const addStats = (row) => {
      for (const [key, label, cls] of row) {
        const s = stat(label, cls);
        s.el.setAttribute('role', 'listitem');
        d.stats[key] = s.v;
        chips.appendChild(s.el);
      }
    };
    // [key, label, more?]: "more" lines stay hidden until "Show all".
    const addKv = (rows) => {
      for (const [key, label, more] of rows) {
        const r = kvRow(label, more);
        if (more) moreCount++;
        d.kv[key] = r.v;
        kv.append(...r.el);
      }
    };
    const graphBox = (box) => {
      body.appendChild(box);
    };

    if (dev.kind === 'cpu') {
      d.valueLabel = t('perf.util');
      const logical = this.app.prefs.cpuGraph === 'logical';
      if (logical) {
        const n = this.app.store.perf?.cpu.perCore.length || 1;
        const grid = h('div', { class: 'tm-coregrid' });
        const cols = n <= 2 ? n : n <= 4 ? 2 : n <= 6 ? 3 : n <= 16 ? 4 : n <= 24 ? 6 : n <= 32 ? 8 : Math.ceil(Math.sqrt(n * 2));
        grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
        d.cores = [];
        for (let i = 0; i < n; i++) {
          const c = new Chart({ grid: false, label: t('perf.cpuN', { n: i }) });
          charts.push(c);
          grid.appendChild(h('div', { class: 'tm-chart' }, c.canvas));
          d.cores.push(c);
        }
        graphBox(h('div', { class: 'tm-chartbox main' }, grid, h('div', { class: 'tm-chart-cap' }, h('span', { class: 'tm-chart-span' }, t('perf.lastMinute')))));
      } else {
        const c = chartBox(t('perf.utilization'), { box: 'main' });
        d.main = c.chart;
        graphBox(c.box);
      }
      addStats([
        ['speed', t('perf.speed')],
        ['procs', t('perf.processes')],
        ['threads', t('perf.threads')],
        ['uptime', t('perf.uptime')],
      ]);
      addKv([
        ['base', t('perf.baseSpeed')],
        ['cores', t('perf.cores')],
        ['logical', t('perf.logical')],
        ['virt', t('perf.virtualization')],
        ['load', t('perf.load')],
        ['handles', t('perf.handles'), true],
        ['sockets', t('perf.sockets'), true],
        ['vm', t('perf.vm'), true],
        ['l1', t('perf.l1'), true],
        ['l2', t('perf.l2'), true],
        ['l3', t('perf.l3'), true],
      ]);
    } else if (dev.kind === 'mem') {
      d.valueLabel = t('perf.memUsage');
      const c = chartBox(t('perf.memUsage'), { box: 'main' });
      d.main = c.chart;
      d.mainRight = c.scale;
      graphBox(c.box);
      addStats([
        ['inuse', t('perf.inUse')],
        ['avail', t('perf.available')],
        ['committed', t('perf.committed')],
        ['cached', t('perf.cached')],
      ]);
      const segs = {};
      const bar = h('div', { class: 'tm-membar', role: 'img' });
      for (const k of ['inuse', 'modified', 'standby', 'free']) {
        segs[k] = h('div', { class: `tm-seg s-${k}` });
        bar.appendChild(segs[k]);
      }
      d.segs = segs;
      d.bar = bar;
      d.comp = h('div', { class: 'tm-chartbox comp' }, h('div', { class: 'tm-comp-label' }, t('perf.memComposition')), bar);
      addKv([
        ['total', t('perf.installed')],
        ['swap', t('perf.swap')],
        ['shared', t('perf.shared'), true],
        ['kernel', t('perf.kernelMem'), true],
        ['buffers', t('perf.buffers'), true],
        ['reserved', t('perf.reserved'), true],
      ]);
    } else if (dev.kind === 'disk') {
      d.valueLabel = t('perf.activeTime');
      // One graph: the active time, or the transfer rate (read solid, write dashed) from the
      // "Change graph to" menu.
      d.rate = this.diskGraph === 'rate';
      const c = chartBox(d.rate ? t('perf.transferRate') : t('perf.activeTime'), { box: 'main' });
      d.main = c.chart;
      d.scale = c.scale;
      graphBox(c.box);
      addStats([
        ['resp', t('perf.avgResponse')],
        ['read', t('perf.readSpeed'), d.rate ? 'lg-solid' : null],
        ['write', t('perf.writeSpeed'), d.rate ? 'lg-dash' : null],
      ]);
      addKv([
        ['capacity', t('perf.capacity')],
        ['type', t('perf.type')],
        ['model', t('perf.model')],
        ['mounts', t('perf.mounts')],
        ['formatted', t('perf.formatted'), true],
        ['system', t('perf.systemDisk'), true],
        ['swapfile', t('perf.pageFile'), true],
      ]);
    } else if (dev.kind === 'net') {
      d.valueLabel = t('perf.throughput');
      const c = chartBox(t('perf.throughput'), { box: 'main' });
      d.main = c.chart;
      d.mainRight = c.scale;
      graphBox(c.box);
      addStats([
        ['recv', t('perf.receive'), 'lg-solid'],
        ['send', t('perf.send'), 'lg-dash'],
      ]);
      addKv([
        ['adapter', t('perf.adapter')],
        ['ctype', t('perf.connType')],
        ['speed', t('perf.linkSpeed')],
        ['ipv4', t('perf.ipv4')],
        ['signal', t('perf.signal'), true],
        ['ipv6', t('perf.ipv6'), true],
        ['mac', t('perf.mac'), true],
      ]);
    } else if (dev.kind === 'gpu') {
      d.valueLabel = t('perf.util');
      const c = chartBox(t('perf.utilization'), { box: 'main' });
      d.main = c.chart;
      graphBox(c.box);
      addStats([['vram', t('perf.vram')]]);
      addKv([['driver', t('perf.driver')]]);
    }
    if (dev.kind === 'disk' || dev.kind === 'net') chips.classList.add('legend');
    value.setAttribute('aria-label', d.valueLabel);
    const card = h('section', { class: 'tm-pd-card', 'aria-label': t('perf.detailsTitle') }, h('h3', { class: 'tm-pd-card-title' }, t('perf.detailsTitle')), kv);
    if (moreCount) {
      const more = h('button', { class: 'btn subtle small tm-pd-more', type: 'button', 'aria-expanded': 'false' }, t('perf.showAll'));
      more.addEventListener('click', () => {
        const on = !card.classList.contains('all');
        card.classList.toggle('all', on);
        this.showAllDetails = on;
        more.setAttribute('aria-expanded', String(on));
        more.textContent = t(on ? 'perf.showLess' : 'perf.showAll');
      });
      if (this.showAllDetails) more.click();
      card.appendChild(more);
    }
    // Key figures (and the memory composition) on the left, the Details card on their right when
    // the window is wide enough, so the chart and the figures fit without scrolling.
    body.appendChild(h('div', { class: 'tm-pd-stats' }, h('div', { class: 'tm-pd-figs' }, chips, d.comp || null), card));
    this.detailEl.append(head, body);
    this.detail = d;
  }

  // ------------------------------------------------------------------ updates
  update(store, { animate = true } = {}) {
    const p = store.perf;
    if (!p || this.el?.hidden) return;
    const themeChanged = this.readColors();
    if (this.syncDevices(p) || !this.detail || this.detail.dev.id !== this.selected || themeChanged) this.buildDetail();
    const now = p.time;
    const { t } = this.app;
    const f = this.app.fmt;
    // ---- sibling chips (several disks / adapters): short name, current value
    for (const tile of this.tiles.values()) {
      if (tile.el.hidden) continue;
      const dv = tile.dev;
      const set = (a, tip, b, c) => {
        if (tile.t1.textContent !== a) tile.t1.textContent = a;
        if (tile.el.dataset.tip !== tip) tile.el.dataset.tip = tip; // the mount points of a disk
        if (tile.t2.textContent !== b) tile.t2.textContent = b;
        if (tile.t3.textContent !== c) tile.t3.textContent = c;
      };
      if (dv.kind === 'disk') {
        const dk = p.disks.find((x) => x.name === dv.name);
        if (dk) set(this.devLabel(dv).replace(/ \(.*$/, ''), this.devLabel(dv), '', f.pct(dk.busyPct));
      } else if (dv.kind === 'net') {
        const n = p.net.find((x) => x.iface === dv.name);
        if (n) set(this.devLabel(dv), `${this.devLabel(dv)} (${n.iface})`, n.iface, t('perf.sendRecv', { s: f.bits(n.txBps), r: f.bits(n.rxBps) }));
      }
    }
    // ---- detail
    const d = this.detail;
    if (!d) return;
    const S = (k, v) => {
      const el = d.stats[k] || d.kv[k];
      if (el && el.textContent !== v) el.textContent = v;
    };
    const K = (k, v) => {
      const el = d.kv[k];
      if (el && el.textContent !== v) el.textContent = v;
    };
    const V = (v) => {
      if (d.value.textContent !== v) d.value.textContent = v;
    };
    const color = this.colors[d.kind];
    if (d.kind === 'cpu') {
      const c = p.cpu;
      V(f.pct(c.total));
      if (d.sub.textContent !== c.model) d.sub.textContent = c.model;
      if (d.main) d.main.set({ color, max: 100, series: [{ points: store.get('cpu') }] }, now, { animate });
      if (d.cores) d.cores.forEach((ch, i) => ch.set({ color, max: 100, series: [{ points: store.get(`cpu${i}`) }] }, now, { animate }));
      S('util', f.pct(c.total));
      S('speed', f.ghz(c.speedMHz));
      S('procs', f.int(c.processes));
      S('threads', f.int(c.threads));
      S('handles', f.int(c.handles));
      S('uptime', f.uptime(c.uptime));
      K('base', c.baseMHz ? f.ghz(c.baseMHz) : t('props.na'));
      K('sockets', f.int(c.sockets));
      K('cores', f.int(c.cores));
      K('logical', f.int(c.logical));
      K('virt', t(`perf.virt.${c.virtualization}`));
      K('vm', c.vm ? t('common.yes') : t('common.no'));
      K('l1', c.caches.l1 ? f.size(c.caches.l1) : t('props.na'));
      K('l2', c.caches.l2 ? f.size(c.caches.l2) : t('props.na'));
      K('l3', c.caches.l3 ? f.size(c.caches.l3) : t('props.na'));
      K('load', c.loadavg.map((x) => f.num(x, 2, 2)).join(' · '));
    } else if (d.kind === 'mem') {
      const m = p.mem;
      const total = f.size(m.total, 1);
      if (d.sub.textContent !== total) d.sub.textContent = total;
      if (d.mainRight.textContent !== total) d.mainRight.textContent = total;
      V(f.pct((m.used / (m.total || 1)) * 100));
      d.main.set({ color, max: m.total, series: [{ points: store.get('mem') }] }, now, { animate });
      const parts = { inuse: m.used, modified: m.modified, standby: m.standby, free: m.free };
      const sum = Object.values(parts).reduce((a, b) => a + b, 0) || 1;
      for (const [k, v] of Object.entries(parts)) {
        d.segs[k].style.flexGrow = String(Math.max(0, v / sum));
        d.segs[k].dataset.tip = `${t(`perf.comp.${k}`)} (${f.size(v, 1)})\n${t(`perf.comp.${k}Desc`)}`;
      }
      d.bar.setAttribute('aria-label', Object.entries(parts).map(([k, v]) => `${t(`perf.comp.${k}`)} ${f.size(v, 1)}`).join(', '));
      S('inuse', f.size(m.used, 1));
      S('avail', f.size(m.available, 1));
      S('committed', f.gbPair(m.committed, m.commitLimit));
      S('cached', f.size(m.cached, 1));
      S('shared', f.size(m.shared, 1));
      S('kernel', f.size(m.slab + m.kernelStack + m.pageTables, 1));
      K('total', total);
      K('swap', m.swapTotal ? `${f.size(m.swapUsed, 1)} / ${f.size(m.swapTotal, 1)}` : t('perf.noSwap'));
      K('buffers', f.size(m.buffers, 1));
      K('reserved', f.size(m.hardwareReserved, 1));
    } else if (d.kind === 'disk') {
      const dk = p.disks.find((x) => x.name === d.dev.name);
      if (!dk) return;
      const sub = dk.model || dk.name;
      if (d.sub.textContent !== sub) d.sub.textContent = sub;
      V(f.pct(dk.busyPct));
      if (!d.rate) d.main.set({ color, max: 100, series: [{ points: store.get(`disk:${dk.name}:busy`) }] }, now, { animate });
      const peak = niceMax(Math.max(store.peak(`disk:${dk.name}:read`, now), store.peak(`disk:${dk.name}:write`, now)), 102400);
      const pr = d.rate ? f.rate(peak) : '';
      if (d.scale.textContent !== pr) d.scale.textContent = pr;
      if (d.rate)
        d.main.set(
        {
          color,
          max: peak,
          series: [
            { points: store.get(`disk:${dk.name}:read`) },
            { points: store.get(`disk:${dk.name}:write`), dash: true, fill: false },
          ],
        },
        now,
        { animate },
      );
      S('active', f.pct(dk.busyPct));
      S('resp', f.ms(dk.avgResponseMs));
      S('read', f.rate(dk.readBps));
      S('write', f.rate(dk.writeBps));
      K('capacity', f.size(dk.size, 1));
      K('formatted', dk.formatted ? f.size(dk.formatted, 1) : t('props.na'));
      K('system', dk.system ? t('common.yes') : t('common.no'));
      K('swapfile', dk.swap ? t('common.yes') : t('common.no'));
      K('type', t(`disk.${dk.type}`));
      K('model', dk.model || t('props.na'));
      K('mounts', dk.mounts.join(', ') || t('props.none'));
    } else if (d.kind === 'net') {
      const n = p.net.find((x) => x.iface === d.dev.name);
      if (!n) return;
      if (d.sub.textContent !== n.iface) d.sub.textContent = n.iface;
      const peak = niceMax(Math.max(store.peak(`net:${n.iface}:rx`, now), store.peak(`net:${n.iface}:tx`, now)), 10000);
      const pr = f.bits(peak);
      if (d.mainRight.textContent !== pr) d.mainRight.textContent = pr;
      V(f.bits(n.rxBps + n.txBps));
      d.main.set(
        {
          color,
          max: peak,
          series: [
            { points: store.get(`net:${n.iface}:rx`) },
            { points: store.get(`net:${n.iface}:tx`), dash: true, fill: false },
          ],
        },
        now,
        { animate },
      );
      S('send', f.bits(n.txBps));
      S('recv', f.bits(n.rxBps));
      K('adapter', n.driver ? `${n.iface} (${n.driver})` : n.iface);
      K('ctype', n.type === 'wifi' ? t('perf.wifi') : t('perf.ethernet'));
      K('speed', n.speedMbps ? f.bits(n.speedMbps * 1e6) : t('props.na'));
      K('signal', n.signal != null ? f.pct(n.signal) : t('props.na'));
      K('ipv4', n.ipv4.join(', ') || t('props.na'));
      K('ipv6', n.ipv6.join(', ') || t('props.na'));
      K('mac', n.mac || t('props.na'));
      if (!n.up) S('recv', t('perf.disconnected'));
    } else if (d.kind === 'gpu') {
      const g = p.gpu;
      if (!g) return;
      if (d.sub.textContent !== g.name) d.sub.textContent = g.name;
      V(f.pct(g.busyPct));
      d.main.set({ color, max: 100, series: [{ points: store.get('gpu') }] }, now, { animate });
      S('util', f.pct(g.busyPct));
      S('vram', g.vramTotal ? `${f.size(g.vramUsed, 1)} / ${f.size(g.vramTotal, 1)}` : t('props.na'));
      K('driver', g.driver || t('props.na'));
    }
  }

  // ------------------------------------------------------------------ menus / commands
  summaryText() {
    const p = this.app.store.perf;
    if (!p || !this.detail) return '';
    const lines = [`${this.detail.title.textContent}\t${this.detail.sub.textContent}`, ''];
    if (this.detail.valueLabel) lines.push(`${this.detail.valueLabel}\t${this.detail.value.textContent}`);
    for (const el of this.detailEl.querySelectorAll('.tm-stat')) lines.push(`${el.querySelector('.tm-stat-l').textContent}\t${el.querySelector('.tm-stat-v').textContent}`);
    const dts = this.detailEl.querySelectorAll('.tm-kv dt');
    for (const dt of dts) lines.push(`${dt.textContent}\t${dt.nextElementSibling?.textContent || ''}`);
    return lines.join('\n');
  }
  copy() {
    this.app.ctx.api.invoke('clipboard:writeText', this.summaryText()).catch(() => {});
  }
  chartMenu() {
    const { t } = this.app;
    const items = [];
    if (this.selected === 'cpu') {
      items.push({
        label: t('perf.changeGraph'),
        submenu: [
          { label: t('perf.overall'), checked: this.app.prefs.cpuGraph !== 'logical', action: () => this.app.setPref('cpuGraph', 'overall') },
          { label: t('perf.logicalGraph'), checked: this.app.prefs.cpuGraph === 'logical', action: () => this.app.setPref('cpuGraph', 'logical') },
        ],
      });
      items.push('-');
    }
    if (this.selected.startsWith('disk:')) {
      const set = (v) => {
        this.diskGraph = v;
        this.buildDetail();
        if (this.app.store.perf) this.update(this.app.store, { animate: false });
      };
      items.push({
        label: t('perf.changeGraph'),
        submenu: [
          { label: t('perf.activeTime'), checked: this.diskGraph !== 'rate', action: () => set('active') },
          { label: t('perf.transferRate'), checked: this.diskGraph === 'rate', action: () => set('rate') },
        ],
      });
      items.push('-');
    }
    items.push({ label: t('cmd.copy'), icon: 'copy', shortcut: 'Ctrl+C', action: () => this.copy() });
    items.push({ label: t('view.speed'), submenu: this.app.speedMenu() });
    return items;
  }
  commands() {
    const { t } = this.app;
    return [
      { id: 'run', icon: 'window_new', label: t('cmd.run'), action: () => this.app.actions.runNewTask() },
      { id: 'more', icon: 'dots-three', label: t('cmd.more'), menu: () => this.chartMenu() },
    ];
  }
  destroy() {
    for (const c of this.detail?.charts || []) c.destroy();
  }
}
