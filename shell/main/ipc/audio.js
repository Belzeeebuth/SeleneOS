'use strict';
// Audio backend (PipeWire through wpctl, with a pactl fallback — pipewire-pulse speaks the PulseAudio
// protocol, and on a PulseAudio system pactl is all there is).
//
//   audio:status          -> { volume 0-100, muted, outputs: [{ id, name, default }], inputs: [{ id, name, default }],
//                              inputVolume 0-100, inputMuted, backend: 'wpctl'|'pactl'|'mock' }
//   audio:setVolume (n)   audio:setMuted (bool)    audio:setOutput (id)
//   audio:setInput (id)   audio:setInputVolume (n) audio:setInputMuted (bool)
//   event audio:changed (status)   pushed on changes ('pactl subscribe', or polling when only wpctl exists)
//
// Device ids are opaque strings: wpctl node ids ("46") with wpctl, sink/source names with pactl.
// The test sound is played by the renderer (WebAudio goes to the default output).
const { spawn } = require('child_process');
const { run, which } = require('../lib/exec');

// ------------------------------------------------------------------ parsers (unit-tested)
/**
 * `wpctl status` (WirePlumber 0.4 / 0.5). The Audio section looks like:
 *   Audio
 *    ├─ Sinks:
 *    │  *   46. Built-in Audio Analog Stereo        [vol: 0.40]
 *    │      51. HDMI / DisplayPort 1 Output         [vol: 1.00 MUTED]
 *    ├─ Sources:
 *    │  *   47. Built-in Audio Analog Stereo        [vol: 1.00]
 */
function parseWpctlStatus(text) {
  const res = { sinks: [], sources: [] };
  let section = null;
  let sub = null;
  for (const raw of String(text || '').split('\n')) {
    const line = raw.replace(/\r$/, '');
    const top = /^(\S.*?)\s*$/.exec(line);
    if (top && !/^[│├└\s]/.test(line)) {
      section = top[1].trim();
      sub = null;
      continue;
    }
    if (section !== 'Audio') continue;
    const hdr = /[├└]─\s*([A-Za-z ]+):\s*$/.exec(line);
    if (hdr) {
      sub = hdr[1].trim();
      continue;
    }
    if (sub !== 'Sinks' && sub !== 'Sources') continue;
    const m = /^[\s│]*(\*)?\s*(\d+)\.\s+(.+?)\s*(?:\[vol:\s*([\d.]+)(\s+MUTED)?\])?\s*$/.exec(line);
    if (!m) continue;
    const item = { id: m[2], name: m[3].trim(), default: !!m[1], volume: m[4] != null ? Math.round(parseFloat(m[4]) * 100) : null, muted: !!m[5] };
    (sub === 'Sinks' ? res.sinks : res.sources).push(item);
  }
  return res;
}

/** `wpctl get-volume <node>` -> { volume, muted }   e.g. "Volume: 0.40 [MUTED]" */
function parseWpctlVolume(text) {
  const m = /Volume:\s*([\d.]+)(.*)$/m.exec(String(text || ''));
  if (!m) return null;
  return { volume: Math.round(parseFloat(m[1]) * 100), muted: /MUTED/.test(m[2]) };
}

/** `pactl --format=json list sinks|sources` */
function parsePactlJson(text, { sources = false } = {}) {
  let arr;
  try {
    arr = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((d) => !sources || !(String(d.name || '').endsWith('.monitor') || (d.monitor_of_sink && d.monitor_of_sink !== 'n/a')))
    .map((d) => {
      const chans = Object.values(d.volume || {});
      const pcts = chans.map((c) => parseInt(String(c.value_percent || '').replace('%', ''), 10)).filter((n) => !Number.isNaN(n));
      return {
        id: String(d.name),
        name: String(d.description || d.name),
        volume: pcts.length ? Math.round(pcts.reduce((a, b) => a + b, 0) / pcts.length) : null,
        muted: !!d.mute,
        index: d.index,
      };
    });
}

/** `pactl list short sinks` -> [{ id: name, name }] (fallback for pactl without JSON output) */
function parsePactlShort(text, { sources = false } = {}) {
  return String(text || '')
    .split('\n')
    .map((l) => l.split('\t'))
    .filter((f) => f.length >= 2 && f[1])
    .filter((f) => !sources || !f[1].endsWith('.monitor'))
    .map((f) => ({ id: f[1], name: f[1], volume: null, muted: false, index: Number(f[0]) }));
}

/** `pactl get-sink-volume @DEFAULT_SINK@` -> percentage (average of channels) */
function parsePactlVolume(text) {
  const pcts = [...String(text || '').matchAll(/(\d+)%/g)].map((m) => Number(m[1]));
  return pcts.length ? Math.round(pcts.reduce((a, b) => a + b, 0) / pcts.length) : null;
}

/** `pactl get-sink-mute @DEFAULT_SINK@` -> boolean ("Mute: yes") */
function parsePactlMute(text) {
  return /Mute:\s*yes/i.test(String(text || ''));
}

const parsers = { parseWpctlStatus, parseWpctlVolume, parsePactlJson, parsePactlShort, parsePactlVolume, parsePactlMute };

const clamp = (n) => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));
function err(message, code) {
  const e = new Error(message);
  e.code = code;
  return e;
}

// ------------------------------------------------------------------ wpctl backend
function wpctlBackend() {
  const w = async (args) => {
    const r = await run('wpctl', args, { timeout: 8000 });
    if (r.code !== 0) throw err((r.stderr || r.stdout || 'wpctl failed').trim(), 'EAUDIO');
    return r.stdout;
  };
  async function status() {
    const [st, out, inp] = await Promise.all([
      w(['status']),
      w(['get-volume', '@DEFAULT_AUDIO_SINK@']).catch(() => ''),
      w(['get-volume', '@DEFAULT_AUDIO_SOURCE@']).catch(() => ''),
    ]);
    const p = parseWpctlStatus(st);
    const ov = parseWpctlVolume(out) || p.sinks.find((s) => s.default) || { volume: 0, muted: false };
    const iv = parseWpctlVolume(inp) || p.sources.find((s) => s.default) || { volume: 0, muted: false };
    return {
      volume: clamp(ov.volume),
      muted: !!ov.muted,
      outputs: p.sinks.map(({ id, name, default: d }) => ({ id, name, default: d })),
      inputs: p.sources.map(({ id, name, default: d }) => ({ id, name, default: d })),
      inputVolume: clamp(iv.volume),
      inputMuted: !!iv.muted,
      backend: 'wpctl',
    };
  }
  const vol = (target, n) => w(['set-volume', '-l', '1.0', target, (clamp(n) / 100).toFixed(2)]);
  const checkId = (id) => {
    if (!/^\d+$/.test(String(id))) throw err('Invalid device id', 'EINVAL');
    return String(id);
  };
  return {
    status,
    setVolume: (n) => vol('@DEFAULT_AUDIO_SINK@', n),
    setMuted: (m) => w(['set-mute', '@DEFAULT_AUDIO_SINK@', m ? '1' : '0']),
    setOutput: (id) => w(['set-default', checkId(id)]),
    setInput: (id) => w(['set-default', checkId(id)]),
    setInputVolume: (n) => vol('@DEFAULT_AUDIO_SOURCE@', n),
    setInputMuted: (m) => w(['set-mute', '@DEFAULT_AUDIO_SOURCE@', m ? '1' : '0']),
  };
}

// ------------------------------------------------------------------ pactl backend
function pactlBackend() {
  const p = async (args) => {
    const r = await run('pactl', args, { timeout: 8000 });
    if (r.code !== 0) throw err((r.stderr || r.stdout || 'pactl failed').trim(), 'EAUDIO');
    return r.stdout;
  };
  let json = true;
  async function list(kind) {
    if (json) {
      try {
        return parsePactlJson(await p(['--format=json', 'list', kind]), { sources: kind === 'sources' });
      } catch {
        json = false;
      }
    }
    return parsePactlShort(await p(['list', 'short', kind]), { sources: kind === 'sources' });
  }
  async function status() {
    const [sinks, sources, defSink, defSource, vol, mute, ivol, imute] = await Promise.all([
      list('sinks'),
      list('sources'),
      p(['get-default-sink']).catch(() => ''),
      p(['get-default-source']).catch(() => ''),
      p(['get-sink-volume', '@DEFAULT_SINK@']).catch(() => ''),
      p(['get-sink-mute', '@DEFAULT_SINK@']).catch(() => ''),
      p(['get-source-volume', '@DEFAULT_SOURCE@']).catch(() => ''),
      p(['get-source-mute', '@DEFAULT_SOURCE@']).catch(() => ''),
    ]);
    const ds = defSink.trim();
    const dsrc = defSource.trim();
    return {
      volume: clamp(parsePactlVolume(vol) ?? 0),
      muted: parsePactlMute(mute),
      outputs: sinks.map((s) => ({ id: s.id, name: s.name, default: s.id === ds })),
      inputs: sources.map((s) => ({ id: s.id, name: s.name, default: s.id === dsrc })),
      inputVolume: clamp(parsePactlVolume(ivol) ?? 0),
      inputMuted: parsePactlMute(imute),
      backend: 'pactl',
    };
  }
  const checkName = (id) => {
    if (!/^[\w.:@-]{1,200}$/.test(String(id))) throw err('Invalid device id', 'EINVAL');
    return String(id);
  };
  return {
    status,
    setVolume: (n) => p(['set-sink-volume', '@DEFAULT_SINK@', `${clamp(n)}%`]),
    setMuted: (m) => p(['set-sink-mute', '@DEFAULT_SINK@', m ? '1' : '0']),
    setOutput: (id) => p(['set-default-sink', checkName(id)]),
    setInput: (id) => p(['set-default-source', checkName(id)]),
    setInputVolume: (n) => p(['set-source-volume', '@DEFAULT_SOURCE@', `${clamp(n)}%`]),
    setInputMuted: (m) => p(['set-source-mute', '@DEFAULT_SOURCE@', m ? '1' : '0']),
  };
}

// ------------------------------------------------------------------ dev mock
function mockBackend() {
  const st = {
    volume: 46,
    muted: false,
    outputs: [
      { id: 'alsa_output.pci-0000_00_1f.3.analog-stereo', name: 'Speakers (Built-in Audio)', default: true },
      { id: 'alsa_output.pci-0000_00_1f.3.hdmi-stereo', name: 'HDMI / DisplayPort (Built-in Audio)', default: false },
      { id: 'bluez_output.38_18_4C_0A_9B_2E.1', name: 'Headphones (WH-1000XM4)', default: false },
    ],
    inputs: [
      { id: 'alsa_input.pci-0000_00_1f.3.analog-stereo', name: 'Microphone (Built-in Audio)', default: true },
      { id: 'alsa_input.usb-Logitech_Webcam_C920-02.analog-stereo', name: 'Microphone (HD Pro Webcam C920)', default: false },
    ],
    inputVolume: 72,
    inputMuted: false,
  };
  const pick = (list, id) => {
    if (!list.some((d) => d.id === id)) throw err('No such device', 'ENOTFOUND');
    list.forEach((d) => (d.default = d.id === id));
  };
  return {
    status: async () => ({ ...st, outputs: st.outputs.map((o) => ({ ...o })), inputs: st.inputs.map((o) => ({ ...o })), backend: 'mock' }),
    setVolume: async (n) => (st.volume = clamp(n)),
    setMuted: async (m) => (st.muted = !!m),
    setOutput: async (id) => pick(st.outputs, id),
    setInput: async (id) => pick(st.inputs, id),
    setInputVolume: async (n) => (st.inputVolume = clamp(n)),
    setInputMuted: async (m) => (st.inputMuted = !!m),
    mock: true,
  };
}

// ------------------------------------------------------------------ registration
function register(api) {
  const hasWp = !!which('wpctl');
  const hasPa = !!which('pactl');
  const useMock = api.DEV && process.env.AURORA_REAL_BACKENDS !== '1'; // dev: simulated devices
  let be = useMock ? mockBackend() : hasWp ? wpctlBackend() : hasPa ? pactlBackend() : null;
  let fellBack = false;

  async function status() {
    if (!be) throw err('No sound server tools (wpctl/pactl) available', 'ENOTSUP');
    try {
      return await be.status();
    } catch (e) {
      // wpctl exists but PipeWire is not running (e.g. PulseAudio system): try pactl once.
      if (!fellBack && !be.mock && hasWp && hasPa) {
        fellBack = true;
        be = pactlBackend();
        return be.status();
      }
      throw e;
    }
  }

  let lastJson = '';
  const push = (st) => {
    const j = JSON.stringify(st);
    if (j === lastJson) return;
    lastJson = j;
    api.broadcast('audio:changed', st);
  };
  let timer = null;
  const refreshSoon = (ms = 120) => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        push(await status());
      } catch {}
    }, ms);
  };
  const act = (fn) => async (...a) => {
    if (!be) throw err('No sound server tools (wpctl/pactl) available', 'ENOTSUP');
    await fn(...a);
    refreshSoon(be.mock ? 10 : 150);
    return true;
  };

  api.handle('audio:status', async () => {
    const st = await status();
    lastJson = JSON.stringify(st);
    return st;
  });
  api.handle('audio:setVolume', act((n) => be.setVolume(n)));
  api.handle('audio:setMuted', act((m) => be.setMuted(!!m)));
  api.handle('audio:setOutput', act((id) => be.setOutput(String(id))));
  api.handle('audio:setInput', act((id) => be.setInput(String(id))));
  api.handle('audio:setInputVolume', act((n) => be.setInputVolume(n)));
  api.handle('audio:setInputMuted', act((m) => be.setInputMuted(!!m)));

  // No change monitor for the sign-in screen (its system user has no sound session).
  if (useMock || !be || api.env?.mode === 'greeter') return;
  // Change notifications: 'pactl subscribe' prints "Event 'change' on sink #46" for every change
  // (works with pipewire-pulse too). Without pactl, poll the default devices.
  if (hasPa) {
    let restarts = 0;
    let child = null;
    const start = () => {
      try {
        child = spawn(which('pactl'), ['subscribe'], { stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, LC_ALL: 'C' } });
      } catch {
        return;
      }
      child.stdout.on('data', (d) => {
        if (/on (sink|source|server|card)/.test(String(d))) refreshSoon();
      });
      child.on('exit', () => {
        child = null;
        if (restarts++ < 30) setTimeout(start, Math.min(30000, 2000 * restarts));
      });
    };
    start();
    process.on('exit', () => child?.kill());
  } else {
    setInterval(() => refreshSoon(0), 3000).unref?.();
  }
}

module.exports = register;
module.exports.parsers = parsers;
