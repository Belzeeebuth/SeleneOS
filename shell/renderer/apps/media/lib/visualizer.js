// Media Player visualizer: smooth spectrum bars or a waveform drawn from the player's AnalyserNode.
//   const viz = new Visualizer(canvas, () => player.analyser, { style: 'bars' });
//   viz.start() viz.stop() viz.setStyle('bars' | 'wave' | 'off') viz.setColors([c1, c2])
// Bars rise quickly and fall with gravity; when playback pauses they settle to rest.
export class Visualizer {
  constructor(canvas, getAnalyser, { style = 'bars', isPlaying = () => true } = {}) {
    this.canvas = canvas;
    this.g = canvas.getContext('2d');
    this.getAnalyser = getAnalyser;
    this.isPlaying = isPlaying;
    this.style = style;
    this.levels = new Float32Array(128);
    this.peaks = new Float32Array(128);
    this.colors = ['rgba(255,255,255,0.28)', 'rgba(255,255,255,0.92)'];
    this.raf = 0;
    this.frames = 0;
    this._tick = this._tick.bind(this);
  }
  setStyle(s) {
    this.style = s;
    if (s === 'off') this._clear();
  }
  setColors(c) {
    if (c?.length >= 2) this.colors = c;
  }
  start() {
    if (this.raf || this.style === 'off') return;
    this.raf = requestAnimationFrame(this._tick);
  }
  stop() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }
  get running() {
    return !!this.raf;
  }
  _clear() {
    this.g.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }
  _fit() {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    return { w, h, dpr };
  }
  _tick() {
    this.raf = requestAnimationFrame(this._tick);
    if (!this.canvas.isConnected || !this.canvas.clientWidth) return;
    const { w, h, dpr } = this._fit();
    const a = this.getAnalyser();
    const live = !!a && this.isPlaying();
    this.frames++;
    this.g.clearRect(0, 0, w, h);
    if (this.style === 'wave') this._wave(a, live, w, h, dpr);
    else this._bars(a, live, w, h, dpr);
    // Paused and settled: keep the resting frame on screen but stop redrawing it 60 times a
    // second. The stage restarts the loop when playback resumes (Stage.syncViz -> start()).
    if (!live && this._settled()) this.stop();
  }
  _settled() {
    if (this.style === 'wave') return !this._wy || this._wy.every((v) => Math.abs(v) < 0.002);
    return this.levels.every((v) => v < 0.002) && this.peaks.every((v) => v < 0.002);
  }
  _gradient(y0, y1) {
    const gr = this.g.createLinearGradient(0, y0, 0, y1);
    gr.addColorStop(0, this.colors[1]);
    gr.addColorStop(1, this.colors[0]);
    return gr;
  }
  _bars(a, live, w, h, dpr) {
    const g = this.g;
    const n = Math.max(16, Math.min(96, Math.floor(w / (14 * dpr))));
    const gap = 4 * dpr;
    const bw = (w - gap * (n - 1)) / n;
    let data = null;
    let rate = 48000;
    if (a && live) {
      data = this._freq || (this._freq = new Uint8Array(a.frequencyBinCount));
      if (data.length !== a.frequencyBinCount) data = this._freq = new Uint8Array(a.frequencyBinCount);
      a.getByteFrequencyData(data);
      rate = a.context.sampleRate;
    }
    const lo = Math.log(40);
    const hi = Math.log(15000);
    const binHz = rate / 2 / (data?.length || 1024);
    for (let i = 0; i < n; i++) {
      let v = 0;
      if (data) {
        const f0 = Math.exp(lo + ((hi - lo) * i) / n);
        const f1 = Math.exp(lo + ((hi - lo) * (i + 1)) / n);
        const b0 = Math.max(0, Math.floor(f0 / binHz));
        const b1 = Math.min(data.length - 1, Math.max(b0, Math.ceil(f1 / binHz)));
        for (let b = b0; b <= b1; b++) v = Math.max(v, data[b]);
        v = (v / 255) ** 1.6 * (0.85 + (0.35 * i) / n); // tilt: highs are quieter
      }
      const cur = this.levels[i];
      this.levels[i] = v > cur ? cur + (v - cur) * 0.6 : Math.max(v, cur - 0.025);
      this.peaks[i] = Math.max(this.levels[i], this.peaks[i] - 0.008);
    }
    const base = h - 2 * dpr;
    const maxH = h * 0.92;
    g.fillStyle = this._gradient(base - maxH, base);
    for (let i = 0; i < n; i++) {
      const lv = Math.min(1, this.levels[i]);
      const bh = Math.max(3 * dpr, lv * maxH);
      const x = i * (bw + gap);
      g.globalAlpha = 0.55 + 0.45 * lv;
      g.beginPath();
      g.roundRect(x, base - bh, bw, bh, Math.min(bw / 2, 3 * dpr));
      g.fill();
      const pk = Math.min(1, this.peaks[i]);
      if (pk > 0.04) {
        g.globalAlpha = 0.7;
        g.fillRect(x, base - pk * maxH - 4 * dpr, bw, 2 * dpr);
      }
    }
    g.globalAlpha = 1;
  }
  _wave(a, live, w, h, dpr) {
    const g = this.g;
    const mid = h / 2;
    const pts = 160;
    let data = null;
    if (a && live) {
      data = this._time || (this._time = new Float32Array(a.fftSize));
      if (data.length !== a.fftSize) data = this._time = new Float32Array(a.fftSize);
      a.getFloatTimeDomainData(data);
    }
    if (!this._wy || this._wy.length !== pts) this._wy = new Float32Array(pts);
    for (let i = 0; i < pts; i++) {
      let v = 0;
      if (data) {
        const k = Math.floor((i / pts) * data.length);
        v = data[k];
      }
      this._wy[i] += (v - this._wy[i]) * 0.5;
    }
    for (const [lw, alpha] of [
      [8, 0.18],
      [2.5, 1],
    ]) {
      g.beginPath();
      for (let i = 0; i < pts; i++) {
        const x = (i / (pts - 1)) * w;
        const env = Math.sin((Math.PI * i) / (pts - 1));
        const y = mid + Math.max(-1, Math.min(1, this._wy[i] * 2.4)) * mid * 0.92 * env;
        if (i === 0) g.moveTo(x, y);
        else {
          const px = ((i - 0.5) / (pts - 1)) * w;
          g.quadraticCurveTo(px, y, x, y);
        }
      }
      const gr = g.createLinearGradient(0, 0, w, 0);
      gr.addColorStop(0, this.colors[0]);
      gr.addColorStop(1, this.colors[1]);
      g.strokeStyle = gr;
      g.globalAlpha = alpha;
      g.lineWidth = lw * dpr;
      g.lineCap = 'round';
      g.stroke();
    }
    g.globalAlpha = 1;
  }
}
