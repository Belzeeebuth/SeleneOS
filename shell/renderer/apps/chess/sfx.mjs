// Aurora Chess — sound effects synthesised with WebAudio (no audio assets).
//   const sfx = new Sfx(() => enabled);  sfx.play('move' | 'capture' | 'castle' | 'check' | 'promote'
//                                                  | 'win' | 'lose' | 'draw' | 'illegal' | 'notify' | 'start')
export class Sfx {
  constructor(enabled) {
    this.enabled = enabled;
    this.ac = null;
    this.noise = null;
  }

  _ctx() {
    if (!this.ac) {
      this.ac = new AudioContext();
      const len = Math.round(this.ac.sampleRate * 0.3);
      const buf = this.ac.createBuffer(1, len, this.ac.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this.noise = buf;
    }
    if (this.ac.state === 'suspended') this.ac.resume().catch(() => {});
    return this.ac;
  }

  // A short filtered noise click + a low body resonance: sounds like wood on wood.
  _knock(t0, { freq = 1100, q = 1.2, body = 170, gain = 0.22, dur = 0.07 } = {}) {
    const ac = this.ac;
    const src = ac.createBufferSource();
    src.buffer = this.noise;
    const f = ac.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f).connect(g).connect(ac.destination);
    src.start(t0, Math.random() * 0.2);
    src.stop(t0 + dur + 0.02);
    const o = ac.createOscillator();
    const og = ac.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(body, t0);
    o.frequency.exponentialRampToValueAtTime(body * 0.7, t0 + dur);
    og.gain.setValueAtTime(0.0001, t0);
    og.gain.exponentialRampToValueAtTime(gain * 0.9, t0 + 0.004);
    og.gain.exponentialRampToValueAtTime(0.0001, t0 + dur * 1.3);
    o.connect(og).connect(ac.destination);
    o.start(t0);
    o.stop(t0 + dur * 1.5);
  }

  _tone(t0, freq, dur, gain, type = 'sine') {
    const ac = this.ac;
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(ac.destination);
    o.start(t0);
    o.stop(t0 + dur + 0.05);
  }

  play(kind) {
    if (!this.enabled()) return;
    try {
      const ac = this._ctx();
      const t = ac.currentTime + 0.005;
      switch (kind) {
        case 'move':
          this._knock(t);
          break;
        case 'capture':
          this._knock(t, { freq: 1700, q: 0.9, body: 210, gain: 0.26, dur: 0.06 });
          this._knock(t + 0.045, { freq: 900, q: 1.1, body: 150, gain: 0.18, dur: 0.08 });
          break;
        case 'castle':
          this._knock(t);
          this._knock(t + 0.11, { freq: 1000, body: 160, gain: 0.18 });
          break;
        case 'check':
          this._knock(t, { gain: 0.18 });
          this._tone(t + 0.02, 880, 0.16, 0.05);
          this._tone(t + 0.09, 1174.66, 0.24, 0.045);
          break;
        case 'promote':
          this._knock(t);
          [659.25, 880, 1318.5].forEach((f, i) => this._tone(t + 0.04 + i * 0.07, f, 0.28, 0.04));
          break;
        case 'win':
          [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => this._tone(t + i * 0.1, f, 0.7, 0.05));
          break;
        case 'lose':
          [440, 349.23, 293.66].forEach((f, i) => this._tone(t + i * 0.14, f, 0.6, 0.05, 'triangle'));
          break;
        case 'draw':
          this._tone(t, 587.33, 0.5, 0.045);
          this._tone(t + 0.14, 587.33 * 1.335, 0.6, 0.04);
          break;
        case 'illegal':
          this._tone(t, 160, 0.14, 0.08, 'triangle');
          break;
        case 'notify':
          this._tone(t, 784, 0.16, 0.04);
          this._tone(t + 0.08, 1046.5, 0.22, 0.035);
          break;
        case 'start':
          this._knock(t, { gain: 0.14 });
          this._knock(t + 0.07, { gain: 0.12, freq: 1300 });
          break;
        default:
          break;
      }
    } catch {
      // audio is a nicety; never let it break the game
    }
  }

  dispose() {
    this.ac?.close().catch(() => {});
    this.ac = null;
  }
}
