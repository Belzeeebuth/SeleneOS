// Settings > System: summary (System), Display, Sound, Notifications, Power, Storage, Window management
// (multitasking), Clipboard, About. Display, Sound and About are their own entries in the navigation.
import { PAGES } from '../lib/index.js';

const SUBPAGES = ['gpuDrivers', 'notifications', 'power', 'storage', 'multitasking', 'clipboard']; // gpuDrivers: pages/drivers.js
const HOST_RE = /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

function subpageRows(pc, ids) {
  const { kit, L } = pc;
  return ids.map((id) => kit.row({ icon: PAGES[id].icon, title: L(PAGES[id].title), desc: L(PAGES[id].desc), onClick: () => pc.go(id) }));
}

// sys:info reports "Virtual machine" when the firmware has no vendor / product name.
function machineName(pc, info) {
  if (!info?.machine) return pc.t('system.thisDevice');
  return info.machine === 'Virtual machine' ? pc.t('system.virtualMachine') : info.machine;
}

// The real host name. The developer simulation starts with a placeholder name: show "selene" for it.
async function hostname(pc) {
  const sec = await pc.tryInvoke('admin:securityStatus');
  if (sec?.hostname) return sec.simulated && sec.hostname === 'AURORA-PC' ? 'selene' : sec.hostname;
  const info = await pc.tryInvoke('sys:info');
  return info?.hostname || pc.env.hostname || 'selene';
}

// Device name, edited in place: a field and a Rename button (enabled once the name changed).
function nameEditor(pc, host, info, adm, { bare = false } = {}) {
  const { h, t, kit } = pc;
  const uid = Math.random().toString(36).slice(2, 8);
  const hintId = `st-host-hint-${uid}`;
  const baseHint = `${machineName(pc, info)} · ${t('system.deviceNameHint')}`;
  const hint = h('div', { class: 'st-host-hint', id: hintId }, baseHint);
  const input = h('input', { class: 'input st-host-input', type: 'text', value: host, spellcheck: false, autocomplete: 'off', maxlength: 63, id: `st-host-${uid}`, 'aria-describedby': hintId });
  const btn = kit.button(t('system.rename'), () => save(), { className: 'st-host-save', icon: adm && !adm.isAdmin ? 'shield_keyhole' : null, disabled: true });
  const sync = () => {
    const v = input.value.trim();
    btn.disabled = !v || v === host;
    input.classList.remove('invalid');
    input.removeAttribute('aria-invalid');
    hint.classList.remove('error');
    hint.textContent = baseHint;
  };
  input.addEventListener('input', sync);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      save();
    } else if (e.key === 'Escape' && input.value !== host) {
      e.stopPropagation();
      input.value = host;
      sync();
    }
  });
  async function save() {
    const v = input.value.trim();
    if (!v || v === host) return;
    if (!HOST_RE.test(v)) {
      input.classList.add('invalid');
      input.setAttribute('aria-invalid', 'true');
      hint.classList.add('error');
      hint.textContent = t('system.renameInvalid');
      input.focus();
      return;
    }
    btn.disabled = true;
    try {
      await pc.runAdmin('set-hostname', [v], 'system.reasonHostname');
      await pc.refresh();
      pc.toast(t('system.renamed', { name: v }));
    } catch (err) {
      pc.toastError(err);
      btn.disabled = false;
    }
  }
  // bare: inside the About list, whose line already names the field
  if (bare) input.setAttribute('aria-label', t('about.deviceName'));
  return h(
    'div',
    { class: ['st-host', bare && 'bare'], dataset: { section: 'rename' } },
    bare ? null : h('label', { class: 'st-sum-label', for: `st-host-${uid}` }, t('about.deviceName')),
    h('div', { class: 'st-host-edit' }, input, btn),
    hint,
  );
}

function meter(pc, label, used, total) {
  const { h, t } = pc;
  const pct = total ? Math.min(1, used / total) : 0;
  return h(
    'div',
    { class: 'st-sum-cell' },
    h('div', { class: 'st-sum-label' }, label),
    h('div', { class: 'st-sum-value' }, total ? t('storage.usedOf', { used: pc.fmtSize(used), total: pc.fmtSize(total) }) : '—'),
    h('div', { class: ['st-bar', pct > 0.9 && 'warn'], role: 'meter', 'aria-label': label, 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(pct * 100)) }, h('i', { style: { width: `${(pct * 100).toFixed(1)}%` } })),
  );
}

// ------------------------------------------------------------------ System (summary)
async function system(pc) {
  const { h, t, kit } = pc;
  const [host, info, adm, usage, stats] = await Promise.all([hostname(pc), pc.tryInvoke('sys:info'), pc.adminStatus(), pc.tryInvoke('fs:usage', '/'), pc.tryInvoke('sys:stats')]);
  const i = info || {};
  const mem = stats?.mem || (i.memTotal ? { total: i.memTotal, used: 0 } : null);
  const summary = h(
    'section',
    { class: 'st-summary', 'aria-label': t('system.summaryLabel') },
    nameEditor(pc, host, i, adm),
    h(
      'div',
      { class: 'st-sum-facts' },
      h('div', { class: 'st-sum-cell' }, h('div', { class: 'st-sum-label' }, t('system.version')), h('div', { class: 'st-sum-value' }, `${i.osName || 'Selene OS'} ${i.version || pc.env.version || ''}`.trim()), kit.link(t('system.allSpecs'), () => pc.go('about'))),
      meter(pc, L(pc, 'storage'), usage?.used || 0, usage?.size || 0),
      meter(pc, t('system.memory'), mem?.used || 0, mem?.total || 0),
    ),
  );
  return h('div', null, summary, kit.group(t('system.sections'), ...subpageRows(pc, SUBPAGES)));
}
function L(pc, id) {
  return pc.L(PAGES[id].title);
}

// ------------------------------------------------------------------ Display
function resLabel(pc, m, preferred) {
  const s = `${m.width} × ${m.height}`;
  return preferred ? `${s} (${pc.t('system.recommended')})` : s;
}
function rateLabel(pc, r) {
  const v = Math.abs(r - Math.round(r)) < 0.005 ? String(Math.round(r)) : pc.fmtNum(r, { maximumFractionDigits: 2 });
  return `${v} Hz`;
}

// "Keep these display settings?" with a 15 s countdown that reverts automatically.
function keepDialog(pc) {
  const { h, t, ui } = pc;
  let left = 15;
  const msg = h('div', { class: 'st-countdown' }, t('system.revertIn', { count: left }));
  let timer = null;
  return ui.dialog({
    title: t('system.keepTitle'),
    body: msg,
    buttons: [
      { label: t('system.keepChanges'), value: 'keep', primary: true },
      { label: t('system.revert'), value: 'revert' },
    ],
    onOpen: (dlg, done) => {
      dlg.classList.add('st-keep-dialog');
      timer = setInterval(() => {
        left -= 1;
        msg.textContent = t('system.revertIn', { count: left });
        if (left <= 0) {
          clearInterval(timer);
          done('revert');
        }
      }, 1000);
    },
  }).finally(() => clearInterval(timer));
}

async function display(pc) {
  const { h, t, kit, api, settings } = pc;
  const st = await pc.tryInvoke('display:status');
  const outputs = st?.outputs || [];
  let sel = outputs.find((o) => o.primary) || outputs[0] || null;
  const root = h('div');

  const rerender = async () => {
    const fresh = await pc.tryInvoke('display:status');
    if (fresh) {
      outputs.splice(0, outputs.length, ...fresh.outputs);
      sel = outputs.find((o) => o.name === sel?.name) || outputs[0];
    }
    paint();
  };

  async function applyMode(width, height, rate) {
    const o = sel;
    let res;
    try {
      res = await api.invoke('display:setMode', o.name, width, height, rate);
    } catch (err) {
      pc.toastError(err);
      return false;
    }
    await rerender();
    const v = await keepDialog(pc);
    if (v === 'keep') {
      await pc.tryInvoke('display:save');
      return true;
    }
    try {
      await api.invoke('display:setMode', o.name, res.previous.width, res.previous.height, res.previous.rate);
    } catch (err) {
      pc.toastError(err);
    }
    await rerender();
    return false;
  }

  function paint() {
    pc.ui.clear(root);
    const groups = [];
    if (outputs.length > 1) {
      const maxW = Math.max(...outputs.map((o) => o.width || 1));
      groups.push(
        h(
          'div',
          { class: 'st-display-pick' },
          outputs.map((o, i) => {
            const w = Math.max(70, Math.round(((o.width || 1) / maxW) * 140));
            return h(
              'button',
              {
                class: 'st-monitor',
                type: 'button',
                style: { width: `${w}px`, height: `${Math.round((w * (o.height || 9)) / (o.width || 16))}px`, opacity: o === sel ? '1' : '0.55' },
                'aria-label': `${t('system.displayN', { n: i + 1 })} – ${o.name}`,
                'aria-pressed': String(o === sel),
                onclick: () => {
                  sel = o;
                  paint();
                },
              },
              String(i + 1),
            );
          }),
        ),
      );
    }
    // Brightness & color
    const bc = [];
    if (st?.brightness != null) {
      let tmr = null;
      bc.push(
        kit.row({
          icon: 'brightness_high',
          title: t('system.brightness'),
          desc: t('system.brightnessDesc'),
          section: 'brightness',
          control: kit.slider({
            value: st.brightness,
            label: t('system.brightness'),
            iconStart: 'brightness_low',
            onInput: (v) => {
              pc.shell.emit('osd:suppress', 1500);
              clearTimeout(tmr);
              tmr = setTimeout(() => api.invoke('display:setBrightness', v).catch(pc.toastError), 40);
            },
          }),
        }),
      );
    }
    const nlToggle = kit.toggle({ value: !!settings.get('nightLight'), label: t('system.nightLight'), onChange: (v) => settings.set('nightLight', v) });
    pc.onDispose(settings.on('nightLight', (v) => nlToggle.set(!!v)));
    bc.push(
      kit.expander({
        icon: 'weather_moon',
        title: t('system.nightLight'),
        desc: t('system.nightLightDesc'),
        control: nlToggle,
        section: 'nightLight',
        open: pc.section === 'nightLight',
        body: () =>
          kit.subRow({
            title: t('system.strength'),
            control: kit.slider({
              value: settings.get('nightLightStrength') ?? 40,
              label: t('system.strength'),
              onInput: (v) => settings.set('nightLightStrength', v),
            }),
          }),
      }),
    );
    groups.push(kit.group(t('system.brightnessColor'), ...bc));

    // Scale & layout
    const scale = Number(settings.get('scale')) || 100;
    const pct = (v) => (pc.lang === 'fr' ? `${v} %` : `${v}%`);
    const steps = [100, 125, 150, 175];
    if (!steps.includes(scale)) steps.push(scale);
    // Like Windows, scales that would leave too small a desktop on this screen are not offered.
    const maxScale = pc.maxScale();
    const scaleOpts = steps
      .sort((a, b) => a - b)
      .map((v) => ({ value: v, disabled: v > maxScale && v !== scale, label: v === 100 ? `${pct(v)} (${t('system.recommended')})` : [125, 150, 175].includes(v) ? pct(v) : `${pct(v)} (${t('system.custom')})` }));
    const sl = [
      kit.row({
        icon: 'zoom_in',
        title: t('system.scale'),
        desc: t('system.scaleDesc'),
        section: 'scale',
        control: kit.combo({ options: scaleOpts, value: scale, label: t('system.scale'), onChange: (v) => settings.set('scale', Number(v)) }),
      }),
    ];
    if (sel && sel.modes?.length && !sel.readOnly) {
      const resOpts = sel.modes.map((m) => ({ value: `${m.width}x${m.height}`, label: resLabel(pc, m, m.preferred) }));
      sl.push(
        kit.row({
          icon: 'resize',
          title: t('system.resolution'),
          desc: t('system.resolutionDesc'),
          section: 'resolution',
          control: kit.combo({
            options: resOpts,
            value: `${sel.width}x${sel.height}`,
            width: 220,
            label: t('system.resolution'),
            onChange: async (v) => {
              const [w, hh] = String(v).split('x').map(Number);
              const m = sel.modes.find((x) => x.width === w && x.height === hh);
              const rate = m.rates.includes(sel.rate) ? sel.rate : m.rates[0];
              const ok = await applyMode(w, hh, rate);
              return ok ? undefined : false;
            },
          }),
        }),
      );
      const cur = sel.modes.find((m) => m.width === sel.width && m.height === sel.height);
      if (cur) {
        sl.push(
          kit.row({
            icon: 'desktop_pulse',
            title: t('system.refreshRate'),
            desc: t('system.refreshRateDesc'),
            section: 'refresh',
            control: kit.combo({
              options: cur.rates.map((r) => ({ value: r, label: rateLabel(pc, r) })),
              value: sel.rate,
              label: t('system.refreshRate'),
              onChange: async (v) => ((await applyMode(sel.width, sel.height, Number(v))) ? undefined : false),
            }),
          }),
        );
      }
    } else {
      sl.push(
        kit.row({
          icon: 'resize',
          title: t('system.resolution'),
          desc: t('system.resolutionReadOnly'),
          section: 'resolution',
          control: h('span', { class: 'st-row-value' }, sel ? `${sel.width} × ${sel.height}` : '—'),
        }),
      );
    }
    groups.push(kit.group(t('system.scaleLayout'), ...sl));
    groups.push(
      kit.related([
        { icon: 'paint_brush', title: pc.pageTitle('personalization'), desc: t('system.relatedPersonalization'), onClick: () => pc.go('personalization') },
        { icon: 'text_font_size', title: pc.pageTitle('textSize'), desc: t('system.relatedTextSize'), onClick: () => pc.go('textSize') },
        { icon: 'developer_board', title: pc.pageTitle('gpuDrivers'), desc: pc.L(PAGES.gpuDrivers.desc), onClick: () => pc.go('gpuDrivers') },
      ]),
    );
    root.append(...groups);
  }
  paint();
  return root;
}

// ------------------------------------------------------------------ Sound
function playTestSound() {
  const ac = new AudioContext();
  const notes = [
    [523.25, -0.8, 0],
    [659.25, 0, 0.18],
    [783.99, 0.8, 0.36],
  ];
  for (const [f, pan, at] of notes) {
    const o = ac.createOscillator();
    const g = ac.createGain();
    const p = ac.createStereoPanner();
    o.type = 'sine';
    o.frequency.value = f;
    p.pan.value = pan;
    const t0 = ac.currentTime + at;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.22, t0 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.55);
    o.connect(g).connect(p).connect(ac.destination);
    o.start(t0);
    o.stop(t0 + 0.6);
  }
  setTimeout(() => ac.close().catch(() => {}), 1400);
}

async function sound(pc) {
  const { h, t, kit, api, ui, icon } = pc;
  let st = await pc.tryInvoke('audio:status');
  const root = h('div');
  if (!st) {
    root.append(kit.infobar({ kind: 'warning', title: t('sound.noAudio'), message: t('sound.noAudioDesc') }), soundAdvanced(pc));
    return root;
  }
  let dragging = false;
  let micStream = null;
  let micPending = false;
  let disposed = false;
  let raf = 0;
  pc.onDispose(() => {
    disposed = true;
    stopMic();
  });

  const deviceList = (list, kind) => {
    const name = `st-${kind}-${Math.random().toString(36).slice(2, 7)}`;
    if (!list.length) return h('div', { class: 'st-sub' }, h('span', { class: 'text-2' }, t('sound.noDevices')));
    return h(
      'div',
      { role: 'radiogroup' },
      list.map((d) =>
        h(
          'label',
          { class: 'st-sub radio', style: { cursor: 'default' } },
          h('input', {
            type: 'radio',
            name,
            checked: !!d.default,
            onchange: async () => {
              try {
                await api.invoke(kind === 'out' ? 'audio:setOutput' : 'audio:setInput', d.id);
              } catch (err) {
                pc.toastError(err);
              }
            },
          }),
          h('div', { class: 'st-row-text' }, h('div', { class: 'st-row-title' }, d.name), h('div', { class: 'st-row-desc' }, deviceKind(d.name, kind))),
        ),
      ),
    );
  };
  function deviceKind(name, kind) {
    if (/hdmi|displayport/i.test(name)) return t('sound.kindHdmi');
    if (/bluez|headphone|headset|casque|wh-|airpods|buds/i.test(name)) return t('sound.kindHeadphones');
    if (/usb|webcam/i.test(name)) return t('sound.kindUsb');
    return kind === 'out' ? t('sound.kindSpeakers') : t('sound.kindMic');
  }

  function volRow({ isInput }) {
    const vol = isInput ? st.inputVolume : st.volume;
    const muted = isInput ? st.inputMuted : st.muted;
    const muteBtn = h('button', { class: 'btn subtle icon-btn', type: 'button' });
    const paintMute = (m, v) => {
      muteBtn.replaceChildren(icon(isInput ? (m ? 'mic_off' : 'mic') : m ? 'speaker_mute' : v === 0 ? 'speaker_0' : v < 34 ? 'speaker_1' : 'speaker_2', { size: 20 }));
      muteBtn.setAttribute('aria-label', m ? t('sound.unmute') : t('sound.mute'));
      muteBtn.dataset.tip = m ? t('sound.unmute') : t('sound.mute');
    };
    paintMute(muted, vol);
    let tmr = null;
    const slider = kit.slider({
      value: vol,
      label: isInput ? t('sound.inputVolume') : t('sound.volume'),
      onInput: (v) => {
        dragging = true;
        if (!isInput) pc.shell.emit('osd:suppress', 1500);
        paintMute(isInput ? st.inputMuted : st.muted, v);
        clearTimeout(tmr);
        tmr = setTimeout(() => api.invoke(isInput ? 'audio:setInputVolume' : 'audio:setVolume', v).catch(pc.toastError), 30);
      },
      onChange: () => setTimeout(() => (dragging = false), 400),
    });
    muteBtn.onclick = async () => {
      const m = !(isInput ? st.inputMuted : st.muted);
      if (!isInput) pc.shell.emit('osd:suppress', 1500);
      try {
        await api.invoke(isInput ? 'audio:setInputMuted' : 'audio:setMuted', m);
        if (isInput) st.inputMuted = m;
        else st.muted = m;
        paintMute(m, isInput ? st.inputVolume : st.volume);
      } catch (err) {
        pc.toastError(err);
      }
    };
    const row = kit.row({ icon: muteBtn, title: isInput ? t('sound.inputVolume') : t('sound.volume'), section: isInput ? 'inputVolume' : 'volume', control: slider });
    row.update = () => {
      if (dragging) return;
      slider.set(isInput ? st.inputVolume : st.volume);
      paintMute(isInput ? st.inputMuted : st.muted, isInput ? st.inputVolume : st.volume);
    };
    return row;
  }

  const meter = h('div', { class: 'st-level', role: 'meter', 'aria-label': t('sound.inputLevel'), 'aria-valuemin': '0', 'aria-valuemax': '100' }, h('i'));
  const micBtn = kit.button(t('sound.startTest'), () => (micStream ? stopMic() : startMic()));
  const micMsg = h('span', { class: 'caption text-2' });
  async function startMic() {
    if (micPending) return; // a second click while the microphone is being opened
    micPending = true;
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      micMsg.textContent = t('sound.micUnavailable');
      return;
    } finally {
      micPending = false;
    }
    // The page was left while the microphone was opening: release it right away.
    if (disposed) {
      stream.getTracks().forEach((tr) => tr.stop());
      return;
    }
    micStream = stream;
    micMsg.textContent = t('sound.speakNow');
    micBtn.textContent = t('sound.stopTest');
    const ac = new AudioContext();
    const src = ac.createMediaStreamSource(micStream);
    const an = ac.createAnalyser();
    an.fftSize = 512;
    src.connect(an);
    const buf = new Float32Array(an.fftSize);
    const bar = meter.firstChild;
    const tick = () => {
      an.getFloatTimeDomainData(buf);
      let peak = 0;
      for (const x of buf) peak = Math.max(peak, Math.abs(x));
      const lvl = Math.min(1, peak * 1.6);
      bar.style.transform = `scaleX(${lvl.toFixed(3)})`;
      meter.setAttribute('aria-valuenow', String(Math.round(lvl * 100)));
      raf = requestAnimationFrame(tick);
    };
    tick();
    micStream._ac = ac;
  }
  function stopMic() {
    cancelAnimationFrame(raf);
    if (micStream) {
      micStream.getTracks().forEach((tr) => tr.stop());
      micStream._ac?.close().catch(() => {});
      micStream = null;
    }
    if (meter.firstChild) meter.firstChild.style.transform = 'scaleX(0)';
    micBtn.textContent = t('sound.startTest');
    micMsg.textContent = '';
  }

  let outExp;
  let inExp;
  let outVol;
  let inVol;
  const outName = () => st.outputs.find((o) => o.default)?.name || t('sound.none');
  const inName = () => st.inputs.find((o) => o.default)?.name || t('sound.none');
  function build() {
    outExp = kit.expander({ icon: 'speaker_2', title: t('sound.chooseOutput'), desc: outName(), section: 'output', open: true, body: () => deviceList(st.outputs, 'out') });
    inExp = kit.expander({ icon: 'mic', title: t('sound.chooseInput'), desc: inName(), section: 'input', open: pc.section === 'input', body: () => deviceList(st.inputs, 'in') });
    outVol = volRow({ isInput: false });
    inVol = volRow({ isInput: true });
    const testRow = kit.row({ icon: 'music_note_2', title: t('sound.test'), desc: t('sound.testDesc'), control: kit.button(t('sound.testBtn'), () => playTestSound()) });
    const micRow = kit.row({ icon: 'mic_pulse', title: t('sound.testMic'), desc: micMsg, control: h('div', { class: 'row', style: { gap: '12px' } }, meter, micBtn) });
    root.append(kit.group(t('sound.output'), outExp, outVol, testRow), kit.group(t('sound.input'), inExp, inVol, micRow), soundAdvanced(pc));
  }
  build();
  pc.on('audio:changed', (next) => {
    if (!next) return;
    const devsChanged = JSON.stringify([next.outputs, next.inputs]) !== JSON.stringify([st.outputs, st.inputs]);
    st = next;
    if (devsChanged) {
      outExp.querySelector('.st-row-desc').textContent = outName();
      inExp.querySelector('.st-row-desc').textContent = inName();
      outExp.rebuild();
      inExp.rebuild();
    }
    outVol.update();
    inVol.update();
  });
  return root;
}

function soundAdvanced(pc) {
  const { t, kit } = pc;
  return kit.group(t('sound.advanced'), kit.settingToggleRow({ icon: 'music_note_2', title: t('sound.systemSounds'), desc: t('sound.systemSoundsDesc'), key: 'sounds', def: true, section: 'systemSounds' }));
}

// ------------------------------------------------------------------ Notifications
async function notifications(pc) {
  const { h, t, kit } = pc;
  return h(
    'div',
    null,
    kit.group(
      null,
      kit.settingToggleRow({ icon: 'alert', title: t('notif.enabled'), desc: t('notif.enabledDesc'), key: 'notifications.enabled', def: true }),
      kit.settingToggleRow({ icon: 'alert_snooze', title: t('notif.dnd'), desc: t('notif.dndDesc'), key: 'notifications.dnd', section: 'dnd' }),
      kit.settingToggleRow({ icon: 'music_note_2', title: t('notif.sounds'), desc: t('notif.soundsDesc'), key: 'notifications.sounds', def: true }),
    ),
    kit.group(
      t('notif.try'),
      kit.row({
        icon: 'alert_badge',
        title: t('notif.test'),
        desc: t('notif.testDesc'),
        control: kit.button(t('notif.testBtn'), () => pc.shell.notify({ title: t('notif.testTitle'), body: t('notif.testBody'), appId: 'settings' })),
      }),
    ),
  );
}

// ------------------------------------------------------------------ Power
function fmtDuration(pc, min) {
  const hh = Math.floor(min / 60);
  const mm = min % 60;
  if (hh && mm) return pc.t('power.hm', { h: hh, m: mm });
  if (hh) return pc.t('power.h', { count: hh });
  return pc.t('power.m', { count: mm });
}

// Screen and sleep, lid, power mode, low battery (inputpower track: core/features/power.js applies settings.power,
// main/ipc/inputpower.js: power:profiles / power:lid, aurora-admin power-lid). Defaults = core/features/power.js POWER_DEFAULTS.
const POWER_DEFAULTS = { screenOffBattery: 5, screenOffAc: 10, sleepBattery: 15, sleepAc: 0, lockOnScreenOff: true };
async function energyGroups(pc, bat) {
  const { t, kit, settings, api } = pc;
  const cfg = { ...POWER_DEFAULTS, ...(settings.get('power') || {}) };
  const minLabel = (m) => (m === 0 ? t('power.never') : m >= 60 ? t('power.h', { count: m / 60 }) : t('power.m', { count: m }));
  const OFF = [1, 2, 3, 5, 10, 15, 20, 30, 45, 60, 0];
  const SLEEP = [5, 10, 15, 20, 30, 45, 60, 120, 0];
  const minRow = (key, list, titleKey, descKey, icon) => {
    const v = Number(cfg[key]) || 0;
    const opts = (list.includes(v) ? list : [...list, v].sort((a, b) => (a || 1e9) - (b || 1e9))).map((m) => ({ value: m, label: minLabel(m) }));
    return kit.row({ icon, title: t(titleKey), desc: t(descKey), section: key, control: kit.combo({ options: opts, value: v, label: t(titleKey), onChange: (x) => settings.set(`power.${key}`, Number(x)) }) });
  };
  const rows = bat
    ? [
        minRow('screenOffBattery', OFF, 'energy.screenOffBattery', 'energy.screenOffDesc', 'monitor'),
        minRow('screenOffAc', OFF, 'energy.screenOffAc', 'energy.screenOffDesc', 'monitor'),
        minRow('sleepBattery', SLEEP, 'energy.sleepBattery', 'energy.sleepDesc', 'moon'),
        minRow('sleepAc', SLEEP, 'energy.sleepAc', 'energy.sleepDesc', 'moon'),
      ]
    : [minRow('screenOffAc', OFF, 'energy.screenOff', 'energy.screenOffDesc', 'monitor'), minRow('sleepAc', SLEEP, 'energy.sleep', 'energy.sleepDesc', 'moon')];
  rows.push(
    kit.row({
      icon: 'lock-simple',
      title: t('energy.lockOnOff'),
      desc: t('energy.lockOnOffDesc'),
      section: 'lockOnScreenOff',
      control: kit.toggle({ value: cfg.lockOnScreenOff !== false, label: t('energy.lockOnOff'), onChange: (v) => settings.set('power.lockOnScreenOff', !!v) }),
    }),
  );
  const groups = [kit.group(t('energy.screenSleep'), ...rows)];
  const [profiles, lid] = await Promise.all([pc.tryInvoke('power:profiles'), bat ? pc.tryInvoke('power:lid') : null]);
  const more = [];
  if (profiles?.profiles?.length > 1) {
    const names = { 'power-saver': t('energy.modeSaver'), balanced: t('energy.modeBalanced'), performance: t('energy.modePerformance') };
    more.push(
      kit.row({
        icon: 'gauge',
        title: t('energy.mode'),
        desc: t('energy.modeDesc'),
        section: 'mode',
        control: kit.combo({ options: profiles.profiles.map((p) => ({ value: p, label: names[p] || p })), value: profiles.active, label: t('energy.mode'), onChange: (v) => api.invoke('power:setProfile', v).catch(pc.toastError) }),
      }),
    );
  }
  if (lid) {
    more.push(
      kit.row({
        icon: 'laptop',
        title: t('energy.lid'),
        desc: t('energy.lidDesc'),
        section: 'lid',
        control: kit.combo({
          options: [
            { value: 'suspend', label: t('energy.lidSuspend') },
            { value: 'ignore', label: t('energy.lidIgnore') },
            { value: 'poweroff', label: t('energy.lidPoweroff') },
          ],
          value: lid.action,
          label: t('energy.lid'),
          onChange: async (v) => {
            try {
              await pc.runAdmin('power-lid', [v], 'energy.reasonLid');
            } catch (e) {
              if (e?.code !== 'ECANCELED') pc.toastError(e);
              pc.refresh();
            }
          },
        }),
      }),
    );
  }
  if (bat) more.push(kit.row({ icon: 'battery-low', title: t('energy.lowBattery'), desc: t('energy.lowBatteryDesc'), section: 'lowBattery' }));
  if (more.length) groups.push(kit.group(null, ...more));
  return groups;
}

async function power(pc) {
  const { h, t, kit, settings, icon, ui } = pc;
  const bat = await pc.tryInvoke('power:battery');
  const parts = [];
  if (bat) {
    const lvl = Math.max(0, Math.min(10, Math.round(bat.percent / 10)));
    const status = bat.full ? t('power.full') : bat.charging ? (bat.timeLeftMin ? t('power.chargingLeft', { time: fmtDuration(pc, bat.timeLeftMin) }) : t('power.charging')) : bat.timeLeftMin ? t('power.remaining', { time: fmtDuration(pc, bat.timeLeftMin) }) : t('power.onBattery');
    parts.push(
      h(
        'div',
        { class: 'st-hero', dataset: { section: 'battery' } },
        h('span', { class: 'st-upd-icon' }, icon(bat.charging ? `battery_charge_${lvl}` : `battery_${lvl}`, { size: 56 })),
        h('div', { class: 'st-hero-text' }, h('div', { class: 'st-hero-title' }, pc.lang === 'fr' ? `${bat.percent} %` : `${bat.percent}%`), h('div', { class: 'st-hero-sub' }, status)),
      ),
    );
  }
  const opts = [0, 1, 2, 3, 5, 10, 15, 20, 30, 45, 60].map((m) => ({ value: m, label: m === 0 ? t('power.never') : m >= 60 ? t('power.h', { count: m / 60 }) : t('power.m', { count: m }) }));
  const lockCombo = kit.combo({ options: opts, value: Number(settings.get('lockTimeout')) || 0, label: t('power.lockAfter'), onChange: (v) => settings.set('lockTimeout', Number(v)) });
  parts.push(
    kit.group(
      t('power.screen'),
      kit.row({ icon: 'lock_closed', title: t('power.lockAfter'), desc: t('power.lockAfterDesc'), section: 'lock', control: lockCombo }),
      kit.row({ icon: 'lock_closed_key', title: t('power.lockNow'), desc: t('power.lockNowDesc'), control: kit.button(t('power.lockBtn'), () => pc.shell.lock()) }),
    ),
  );
  parts.push(...(await energyGroups(pc, bat)));
  const confirmThen = async (msg, okLabel, fn) => {
    if (await ui.confirm(msg, { title: okLabel, okLabel, parent: pc.win })) fn().catch?.(pc.toastError);
  };
  parts.push(
    kit.group(
      t('power.buttons'),
      kit.row({
        icon: 'power',
        title: t('power.buttonsTitle'),
        desc: t('power.buttonsDesc'),
        section: 'buttons',
        control: h(
          'div',
          { class: 'st-hero-actions' },
          kit.button(t('power.sleep'), () => pc.shell.suspend().catch(pc.toastError), { icon: 'weather_moon' }),
          kit.button(t('power.restart'), () => confirmThen(t('power.restartConfirm'), t('power.restart'), () => pc.shell.reboot()), { icon: 'arrow_clockwise' }),
          kit.button(t('power.shutdown'), () => confirmThen(t('power.shutdownConfirm'), t('power.shutdown'), () => pc.shell.shutdown()), { icon: 'power' }),
        ),
      }),
    ),
  );
  return h('div', null, parts);
}

// ------------------------------------------------------------------ Storage
async function storage(pc) {
  const { h, t, kit, api, icon, ui } = pc;
  const xdg = pc.shell.xdg || (await pc.tryInvoke('fs:xdg')) || {};
  const usage = await pc.tryInvoke('fs:usage', '/');
  const root = h('div');
  if (usage) {
    const pct = usage.size ? usage.used / usage.size : 0;
    root.append(
      h(
        'div',
        { class: 'st-row', style: { flexDirection: 'column', alignItems: 'stretch', gap: '10px', padding: '16px 20px' } },
        h('div', { class: 'st-storage-head' }, h('div', { class: 'row' }, icon('hard_drive', { size: 20 }), h('span', { class: 'body-strong' }, t('storage.system'))), h('span', { class: 'text-2' }, t('storage.usedOf', { used: pc.fmtSize(usage.used), total: pc.fmtSize(usage.size) }))),
        h('div', { class: ['st-bar', pct > 0.9 && 'warn'] }, h('i', { style: { width: `${(pct * 100).toFixed(1)}%` } })),
        h('div', { class: 'caption text-2' }, t('storage.free', { free: pc.fmtSize(usage.free) })),
      ),
    );
  }
  const cats = [
    { key: 'documents', icon: 'document', path: xdg.documents },
    { key: 'downloads', icon: 'arrow_download', path: xdg.downloads },
    { key: 'pictures', icon: 'image', path: xdg.pictures },
    { key: 'videos', icon: 'video', path: xdg.videos },
    { key: 'music', icon: 'music_note_2', path: xdg.music },
    { key: 'desktop', icon: 'desktop', path: xdg.desktop },
    { key: 'trash', icon: 'delete', path: xdg.trash },
  ].filter((c) => c.path);
  const list = h('div', { class: 'st-group-rows st-storage-cats' });
  const rowsByKey = {};
  for (const c of cats) {
    const val = h('span', { class: 'st-row-value' }, h('span', { class: 'spinner small' }));
    const bar = h('div', { class: 'st-bar st-bar-light' }, h('i', { style: { width: '0%' } }));
    const control = c.key === 'trash' ? h('div', { class: 'row', style: { gap: '12px' } }, val, kit.button(t('storage.empty'), (e) => emptyTrash(e.currentTarget))) : val;
    const row = kit.row({
      icon: c.icon,
      title: t(`storage.${c.key}`),
      desc: h('div', { class: 'st-storage-cat', style: { marginTop: '6px' } }, bar),
      control,
      section: c.key === 'trash' ? 'recycle' : null,
      onClick: c.key === 'trash' ? null : () => pc.shell.launch('files', { path: c.path }),
    });
    rowsByKey[c.key] = { row, val, bar, c };
    list.appendChild(row);
  }
  const otherRow = kit.row({ icon: 'apps', title: t('storage.other'), desc: h('div', { class: 'st-storage-cat', style: { marginTop: '6px' } }, h('div', { class: 'st-bar st-bar-light' }, h('i', { style: { width: '0%' } }))), control: h('span', { class: 'st-row-value' }, h('span', { class: 'spinner small' })) });
  list.appendChild(otherRow);
  root.append(h('section', { class: 'st-group' }, h('h3', { class: 'st-group-title' }, t('storage.usage')), list));

  async function measure() {
    const sizes = {};
    await Promise.all(
      cats.map(async (c) => {
        const r = await pc.tryInvoke('fs:dirSize', c.path);
        sizes[c.key] = r?.bytes ?? 0;
      }),
    );
    const total = usage?.used || Object.values(sizes).reduce((a, b) => a + b, 0) || 1;
    const sum = Object.values(sizes).reduce((a, b) => a + b, 0);
    const other = Math.max(0, total - sum);
    const max = Math.max(other, ...Object.values(sizes), 1);
    for (const [k, r] of Object.entries(rowsByKey)) {
      r.val.textContent = pc.fmtSize(sizes[k] || 0);
      r.bar.firstChild.style.width = `${Math.max(sizes[k] ? 1 : 0, ((sizes[k] || 0) / max) * 100).toFixed(1)}%`;
    }
    otherRow.querySelector('.st-row-value').textContent = pc.fmtSize(other);
    otherRow.querySelector('.st-bar > i').style.width = `${((other / max) * 100).toFixed(1)}%`;
    // biggest first, "other" last
    const ordered = Object.values(rowsByKey).sort((a, b) => (sizes[b.c.key] || 0) - (sizes[a.c.key] || 0));
    for (const r of ordered) list.appendChild(r.row);
    list.appendChild(otherRow);
  }
  async function emptyTrash(btn) {
    const items = await pc.tryInvoke('fs:trashList');
    if (!items?.length) {
      pc.toast(t('storage.trashEmpty'), 'info');
      return;
    }
    if (!(await ui.confirm(t('storage.emptyConfirm', { count: items.length }), { title: t('storage.empty'), okLabel: t('common.delete'), parent: pc.win }))) return;
    await kit.busy(btn, async () => {
      try {
        await api.invoke('fs:trashEmpty');
        pc.toast(t('storage.emptied'));
      } catch (err) {
        pc.toastError(err);
      }
    });
    measure();
  }
  measure();

  const drives = ((await pc.tryInvoke('fs:drives')) || []).filter((d) => d.mountpoint && d.mountpoint !== '/' && d.size);
  if (drives.length) {
    root.append(
      kit.group(
        t('storage.otherDrives'),
        ...drives.map((d) => {
          const p = d.size ? (d.size - d.free) / d.size : 0;
          return kit.row({
            icon: d.removable ? 'usb_stick' : 'hard_drive',
            title: d.label || d.mountpoint,
            desc: h('div', { class: 'st-storage-cat', style: { marginTop: '6px' } }, h('div', { class: 'st-bar' }, h('i', { style: { width: `${(p * 100).toFixed(1)}%` } })), h('span', null, t('storage.freeOf', { free: pc.fmtSize(d.free), total: pc.fmtSize(d.size) }))),
            onClick: () => pc.shell.launch('files', { path: d.mountpoint }),
          });
        }),
      ),
    );
  }
  return root;
}

// ------------------------------------------------------------------ Multitasking
async function multitasking(pc) {
  const { h, t, kit, settings } = pc;
  const opt = (k, def = true) => {
    const v = settings.get(`multitasking.${k}`);
    return v == null ? def : v !== false;
  };
  const check = (k, label) => {
    const input = h('input', { type: 'checkbox', checked: opt(k), onchange: (e) => settings.set(`multitasking.${k}`, e.target.checked) });
    return h('label', { class: 'checkbox st-sub' }, input, h('span', null, label));
  };
  const snapToggle = kit.toggle({ value: opt('snap'), label: t('multi.snap'), onChange: (v) => settings.set('multitasking.snap', v) });
  pc.onDispose(settings.on('multitasking', () => snapToggle.set(opt('snap'))));
  const shakeToggle = kit.toggle({ value: opt('shake', false), label: t('multi.shake'), onChange: (v) => settings.set('multitasking.shake', v) });
  return h(
    'div',
    null,
    kit.group(
      null,
      kit.expander({
        icon: 'layout_column_two',
        title: t('multi.snap'),
        desc: t('multi.snapDesc'),
        control: snapToggle,
        section: 'snap',
        open: true,
        body: () => h('div', null, check('snapLayouts', t('multi.snapLayouts')), check('snapAssist', t('multi.snapAssist'))),
      }),
      kit.row({ icon: 'window_multiple', title: t('multi.shake'), desc: t('multi.shakeDesc'), control: shakeToggle, section: 'shake' }),
    ),
  );
}

// ------------------------------------------------------------------ Clipboard
async function clipboard(pc) {
  const { h, t, kit, api } = pc;
  return h(
    'div',
    null,
    kit.group(
      null,
      kit.settingToggleRow({ icon: 'clipboard_paste', title: t('clip.history'), desc: t('clip.historyDesc'), key: 'clipboard.history', def: false }),
      kit.row({
        icon: 'clipboard',
        title: t('clip.clear'),
        desc: t('clip.clearDesc'),
        control: kit.button(t('clip.clearBtn'), async (e) => {
          const b = e.currentTarget;
          await kit.busy(b, async () => {
            await api.invoke('clipboard:writeText', '').catch(pc.toastError);
            await new Promise((r) => setTimeout(r, 300));
          });
          b.replaceChildren(pc.icon('checkmark', { size: 16 }), t('clip.cleared'));
        }),
      }),
    ),
  );
}

// ------------------------------------------------------------------ About
function specText(rows) {
  return rows.map(([k, v]) => `${k}\t${v}`).join('\n');
}

// « Créer un rapport de diagnostic » (track "robust"): main/ipc/robust.js robust:report writes ~/selene-diagnostic-<date>.tar.gz;
// the notice says what is inside before anything is created.
function diagnosticGroup(pc) {
  const { h, t, kit, api } = pc;
  const result = h('div', { class: 'st-diag-result', role: 'status', 'aria-live': 'polite', hidden: true, style: 'padding: 0 16px 14px 56px; font-size: var(--fs-small); color: var(--text-2)' });
  const btn = kit.button(t('diag.button'), () =>
    kit.busy(btn, async () => {
      result.textContent = '';
      result.hidden = false;
      try {
        const r = await api.invoke('robust:report');
        result.replaceChildren(
          h('span', null, t('diag.done', { name: r.name })),
          ' ',
          kit.link(t('diag.show'), () => pc.shell.launch('files', { path: r.path.replace(/\/[^/]*$/, ''), select: r.path })),
        );
      } catch (err) {
        result.textContent = err?.code === 'ENOSPC' ? t('diag.noSpace') : t('diag.failed');
      }
    }),
  );
  return kit.group(
    t('diag.title'),
    kit.row({ icon: 'folder_zip', title: t('diag.create'), desc: t('diag.notice'), control: btn, section: 'diagnostic', className: 'st-diag-row' }),
    result,
  );
}

async function about(pc) {
  const { h, t, kit, api, icon } = pc;
  const [info, host, adm, usage] = await Promise.all([pc.tryInvoke('sys:info'), hostname(pc), pc.adminStatus(), pc.tryInvoke('fs:usage', '/')]);
  const i = info || {};
  const archLabel = { x64: 'x64', arm64: 'ARM64', ia32: 'x86' }[i.arch] || i.arch || '';
  const upMin = Math.round((i.uptime || 0) / 60);
  // One plain list, the device name first (edited in place), then everything else as key / value lines.
  const rows = [
    [t('about.osVersion'), `${i.osName || 'Selene OS'} ${i.version || pc.env.version || ''}`.trim()],
    [t('about.processor'), i.cpu ? `${i.cpu}${i.cores ? ` (${t('about.cores', { count: i.cores })})` : ''}` : '—'],
    [t('about.ram'), i.memTotal ? pc.fmtSize(i.memTotal) : '—'],
    [t('about.systemType'), t('about.systemTypeValue', { arch: archLabel })],
    [t('about.storage'), usage?.size ? t('storage.usedOf', { used: pc.fmtSize(usage.used || 0), total: pc.fmtSize(usage.size) }) : '—'],
    [t('about.machine'), machineName(pc, i)],
    [t('about.build'), i.buildId || 'dev'],
    [t('about.base'), i.distro || 'Linux'],
    [t('about.kernel'), i.kernel || '—'],
    [t('about.uptime'), upMin >= 60 * 24 ? t('about.days', { count: Math.floor(upMin / 1440) }) + ' ' + fmtDuration(pc, upMin % 1440) : fmtDuration(pc, upMin)],
  ];
  if (i.live) rows.push([t('about.session'), t('about.liveSession')]);
  const copyBtn = kit.button(
    t('about.copyAll'),
    async (e) => {
      const b = e.currentTarget;
      const ok = await api.invoke('clipboard:writeText', specText([[t('about.deviceName'), host], ...rows])).then(() => true, (err) => (pc.toastError(err), false));
      if (!ok) return;
      b.replaceChildren(icon('checkmark', { size: 16 }), h('span', null, t('about.copiedAll')));
      setTimeout(() => b.isConnected && b.replaceChildren(icon('copy', { size: 16 }), h('span', null, t('about.copyAll'))), 1600);
    },
    { icon: 'copy', className: 'st-about-copy' },
  );
  const list = h(
    'dl',
    { class: 'st-about-list', dataset: { section: 'specs' }, 'aria-label': t('about.listLabel') },
    h('div', { class: 'st-about-item st-about-name' }, h('dt', { class: 'k' }, t('about.deviceName')), h('dd', { class: 'v' }, nameEditor(pc, host, i, adm, { bare: true }))),
    rows.map(([k, v]) => h('div', { class: 'st-about-item' }, h('dt', { class: 'k' }, k), h('dd', { class: 'v' }, v))),
  );
  return h(
    'div',
    null,
    h('section', { class: 'st-group st-about' }, h('div', { class: 'st-group-rows' }, list, h('div', { class: 'st-about-foot' }, copyBtn))),
    diagnosticGroup(pc),
    kit.related([
      { icon: 'arrow_sync', title: pc.pageTitle('update'), desc: t('about.relatedUpdate'), onClick: () => pc.go('update') },
      ...(pc.ctx.shell.registry?.get?.('winver') ? [{ icon: 'info', title: t('about.aboutAurora'), desc: t('about.aboutAuroraDesc'), onClick: () => pc.shell.launch('winver'), external: true }] : []),
    ]),
  );
}

export default { system, display, sound, notifications, power, storage, multitasking, clipboard, about };
