// Aurora game kit — shared Fluent chrome for the classic games (Minesweeper, Snake, 2048).
// An identical copy lives in apps/minesweeper, apps/snake and apps/game2048 so every app stays
// self-contained; test/games-classic.test.mjs checks that the copies do not drift apart.
//
//   const kit = createKit(ctx);
//   kit.button({ icon, label, tip, onClick, chevron })   kit.iconButton({ icon, tip, onClick })
//   kit.chip({ icon, label, value })  -> el (.setValue(v), .setLabel(s), .bump())
//   kit.toolbar([...left], [...right])
//   kit.bindKeys((e) => ...)          -> keydown while this window is focused and no dialog/menu is open
//   kit.sound.play('pop' | 'click' | 'flag' | 'boom' | 'win' | 'eat' | 'die' | 'merge' | 'move')
//   kit.overlay(host)                 -> { show({ icon, tone, title, text, badge, actions }), hide(), visible }
//   kit.confetti(host, { count, duration })
//   kit.statsDialog({ title, categories, value, render(cat), onReset })
//   kit.helpDialog({ title, sections: [{ title, items }], keys: [[combo, label]] })
//   kit.fmtTime(ms, decimals)  kit.fmtNum(n)  kit.reduceMotion()
//   kit.load(name, fallback) / kit.save(name, value)   per-app JSON storage that never throws
// Strings use the 'gk.*' keys, present in each game's i18n.json.

export function reduceMotion() {
  return document.documentElement.dataset.animations === 'off';
}

export function createKit(ctx) {
  const { h, icon, ui, t, win } = ctx;

  // ---------------------------------------------------------------- buttons & chips
  // collapsible: the label hides (icon + tooltip only) when the toolbar runs out of room.
  function button({ icon: ic, label, tip, onClick, chevron = false, primary = false, collapsible = false, cls, id }) {
    return h(
      'button',
      {
        class: ['btn', primary ? 'primary' : 'subtle', 'gk-btn', cls],
        'data-tip': tip || null,
        'data-tip-pos': 'below',
        'data-id': id || null,
        'data-collapsible': collapsible ? '' : null,
        'aria-label': collapsible ? label : null,
        'aria-haspopup': chevron ? 'menu' : null,
        onclick: (e) => onClick?.(e),
      },
      ic ? icon(ic) : null,
      label != null ? h('span', { class: 'gk-btn-label' }, label) : null,
      chevron ? icon('chevron_down', { size: 12, class: 'gk-chevron' }) : null,
    );
  }

  function iconButton({ icon: ic, tip, onClick, id, cls }) {
    return h(
      'button',
      {
        class: ['btn', 'subtle', 'icon-btn', 'gk-btn', cls],
        'data-tip': tip,
        'data-tip-pos': 'below',
        'aria-label': tip,
        'data-id': id || null,
        onclick: (e) => onClick?.(e),
      },
      icon(ic),
    );
  }

  function chip({ icon: ic, iconNode, label, value = '', cls, id, tip }) {
    const valueEl = h('span', { class: 'gk-chip-value' }, String(value));
    const labelEl = label != null ? h('span', { class: 'gk-chip-label' }, label) : null;
    const el = h(
      'div',
      { class: ['gk-chip', cls, label != null && 'labelled'], 'data-id': id || null, 'data-tip': tip || null, role: 'status' },
      iconNode || (ic ? icon(ic, { class: 'gk-chip-icon' }) : null),
      h('span', { class: 'gk-chip-text' }, labelEl, valueEl),
    );
    el.setValue = (v) => {
      const s = String(v);
      if (valueEl.textContent !== s) valueEl.textContent = s;
    };
    el.setLabel = (s) => labelEl && (labelEl.textContent = s);
    el.setTip = (s) => (el.dataset.tip = s);
    el.bump = () => {
      if (reduceMotion()) return;
      valueEl.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.18)' }, { transform: 'scale(1)' }], { duration: 260, easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)' });
    };
    return el;
  }

  function toolbar(left = [], right = []) {
    const el = h('div', { class: 'gk-toolbar' }, h('div', { class: 'gk-toolbar-group' }, left), h('div', { class: 'gk-spacer' }), h('div', { class: 'gk-toolbar-group' }, right));
    let raf = 0;
    // Width the toolbar needs with every label shown.
    el.fullWidth = () => {
      const was = el.classList.contains('compact');
      el.classList.remove('compact');
      // groups + side padding (2 × 8) + flex gaps (2 × 4) + spacer minimum (4)
      const w = [...el.querySelectorAll(':scope > .gk-toolbar-group')].reduce((n, g) => n + g.scrollWidth, 0) + 28;
      if (was) el.classList.add('compact');
      return w;
    };
    el.refit = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (!el.isConnected || !el.clientWidth) return;
        el.classList.toggle('compact', el.fullWidth() > el.clientWidth);
      });
    };
    const ro = new ResizeObserver(() => el.refit());
    ro.observe(el);
    ctx.onClose(() => {
      ro.disconnect();
      cancelAnimationFrame(raf);
    });
    return el;
  }

  // ---------------------------------------------------------------- keyboard
  function bindKeys(handler) {
    const onKey = (e) => {
      if (e.defaultPrevented) return;
      const focused = typeof win.isFocused === 'function' ? win.isFocused() : true;
      if (!focused || win._closing) return;
      const tgt = e.target;
      if (tgt !== document.body && !win.el.contains(tgt)) return;
      if (document.querySelector('.menu, #overlays > .dialog-layer')) return;
      const layers = win.el.querySelectorAll(':scope > .dialog-layer:not(.closing)');
      if (layers.length) {
        // A dialog of this window is open but focus has not moved into it yet: Esc still closes it.
        const top = layers[layers.length - 1];
        const dlg = top.querySelector('.dialog');
        if (e.key === 'Escape' && !top.contains(tgt) && typeof dlg?._done === 'function') {
          e.preventDefault();
          dlg._done(null);
        }
        return;
      }
      if (tgt.closest?.('input, textarea, select, [contenteditable="true"]')) return;
      if ((e.key === ' ' || e.key === 'Enter') && tgt.closest?.('button, a, [role="button"]')) return;
      handler(e);
    };
    document.addEventListener('keydown', onKey);
    ctx.onClose(() => document.removeEventListener('keydown', onKey));
  }

  // ---------------------------------------------------------------- sounds (tiny WebAudio synth)
  let audio = null;
  const sound = {
    enabled: true,
    play(name, arg = 0) {
      if (!sound.enabled || ctx.settings?.get?.('sounds') === false) return;
      try {
        if (!audio) audio = new AudioContext();
        if (audio.state === 'suspended') audio.resume().catch(() => {});
        const presets = {
          click: [{ f: 880, d: 0.05, g: 0.035, type: 'triangle' }],
          pop: [{ f: 520, d: 0.08, g: 0.05, glide: 780 }],
          flag: [{ f: 660, d: 0.07, g: 0.05, glide: 990, type: 'triangle' }],
          move: [{ f: 300, d: 0.05, g: 0.02, type: 'triangle' }],
          merge: [{ f: 392 * Math.pow(2, Math.min(arg, 11) / 6), d: 0.11, g: 0.05, glide: 523 * Math.pow(2, Math.min(arg, 11) / 6) }],
          eat: [{ f: 600, d: 0.09, g: 0.06, glide: 1100, type: 'square', lp: 2400 }],
          die: [
            { f: 330, d: 0.18, g: 0.07, glide: 160, type: 'sawtooth', lp: 1200 },
            { f: 196, s: 0.15, d: 0.3, g: 0.06, glide: 90, type: 'sawtooth', lp: 900 },
          ],
          boom: [
            { noise: true, d: 0.5, g: 0.22, lp: 700 },
            { f: 110, d: 0.4, g: 0.12, glide: 40, type: 'sine' },
          ],
          win: [
            { f: 523.25, d: 0.16, g: 0.06 },
            { f: 659.25, s: 0.1, d: 0.16, g: 0.06 },
            { f: 783.99, s: 0.2, d: 0.16, g: 0.06 },
            { f: 1046.5, s: 0.3, d: 0.4, g: 0.06 },
          ],
        };
        for (const p of presets[name] || []) tone(audio, p);
      } catch {}
    },
  };
  function tone(ac, { f = 440, s = 0, d = 0.1, g = 0.05, glide, type = 'sine', noise = false, lp }) {
    const t0 = ac.currentTime + s;
    const gain = ac.createGain();
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(g, t0 + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + d);
    let src;
    if (noise) {
      const buf = ac.createBuffer(1, Math.ceil(ac.sampleRate * d), ac.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
      src = ac.createBufferSource();
      src.buffer = buf;
    } else {
      src = ac.createOscillator();
      src.type = type;
      src.frequency.setValueAtTime(f, t0);
      if (glide) src.frequency.exponentialRampToValueAtTime(glide, t0 + d);
    }
    let node = src;
    if (lp) {
      const filter = ac.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = lp;
      node.connect(filter);
      node = filter;
    }
    node.connect(gain).connect(ac.destination);
    src.start(t0);
    src.stop(t0 + d + 0.05);
  }
  ctx.onClose(() => audio?.close?.().catch(() => {}));

  // ---------------------------------------------------------------- overlay card (win / lose / pause)
  function overlay(host) {
    const card = h('div', { class: 'gk-overlay-card', role: 'alertdialog', 'aria-live': 'assertive' });
    const el = h('div', { class: 'gk-overlay', hidden: true }, card);
    host.appendChild(el);
    const api = {
      el,
      visible: false,
      kind: null,
      show({ kind = null, icon: ic, art, tone = 'accent', title, text, badge, extra, actions = [] }) {
        ui.clear(card);
        api.kind = kind;
        if (kind) el.dataset.kind = kind;
        else delete el.dataset.kind;
        card.className = `gk-overlay-card tone-${tone}`;
        if (art) card.appendChild(h('div', { class: 'gk-overlay-art' }, art));
        else if (ic) card.appendChild(h('div', { class: 'gk-overlay-icon' }, icon(ic, { size: 28, filled: true })));
        card.appendChild(h('div', { class: 'gk-overlay-title' }, title));
        if (badge) card.appendChild(h('div', { class: 'gk-badge' }, icon('trophy', { size: 14, filled: true }), badge));
        if (text) card.appendChild(h('div', { class: 'gk-overlay-text' }, text));
        if (extra) card.appendChild(extra);
        if (actions.length) {
          card.appendChild(
            h(
              'div',
              { class: 'gk-overlay-actions' },
              actions.map((a) => h('button', { class: ['btn', a.primary ? 'primary' : '', 'gk-overlay-btn'], 'data-id': a.id || null, onclick: () => a.onClick?.() }, a.label)),
            ),
          );
        }
        el.hidden = false;
        el.classList.remove('leaving');
        api.visible = true;
        const primary = card.querySelector('.btn.primary');
        if (primary && win.isFocused?.() !== false) setTimeout(() => api.visible && primary.focus({ preventScroll: true }), 60);
      },
      hide() {
        if (!api.visible) return;
        api.visible = false;
        api.kind = null;
        if (reduceMotion()) {
          el.hidden = true;
          return;
        }
        el.classList.add('leaving');
        setTimeout(() => {
          if (!api.visible) el.hidden = true;
          el.classList.remove('leaving');
        }, 160);
      },
    };
    return api;
  }

  // ---------------------------------------------------------------- confetti
  function confetti(host, { count = 140, duration = 2600, colors } = {}) {
    if (reduceMotion() || !host.isConnected) return;
    const r = host.getBoundingClientRect();
    if (r.width < 10 || r.height < 10) return;
    const dpr = window.devicePixelRatio || 1;
    const canvas = h('canvas', { class: 'gk-confetti', width: Math.round(r.width * dpr), height: Math.round(r.height * dpr) });
    host.appendChild(canvas);
    const g = canvas.getContext('2d');
    g.scale(dpr, dpr);
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#0078d4';
    const palette = colors || [accent, '#ffb900', '#e74856', '#00cc6a', '#8764b8', '#18b6e8', '#ff8c00'];
    const parts = Array.from({ length: count }, (_, i) => {
      const fromLeft = i % 2 === 0;
      return {
        x: fromLeft ? -10 : r.width + 10,
        y: r.height * (0.35 + Math.random() * 0.4),
        vx: (fromLeft ? 1 : -1) * (180 + Math.random() * 420),
        vy: -(380 + Math.random() * 520),
        w: 5 + Math.random() * 6,
        h: 8 + Math.random() * 8,
        rot: Math.random() * Math.PI,
        vr: (Math.random() - 0.5) * 14,
        color: palette[i % palette.length],
        round: Math.random() < 0.3,
      };
    });
    let last = performance.now();
    const start = last;
    let raf = 0;
    const frame = (now) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const el = now - start;
      g.clearRect(0, 0, r.width, r.height);
      g.globalAlpha = el > duration - 500 ? Math.max(0, (duration - el) / 500) : 1;
      for (const p of parts) {
        p.vy += 900 * dt;
        p.vx *= 0.985;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.rot += p.vr * dt;
        g.save();
        g.translate(p.x, p.y);
        g.rotate(p.rot);
        g.fillStyle = p.color;
        if (p.round) {
          g.beginPath();
          g.arc(0, 0, p.w / 2, 0, Math.PI * 2);
          g.fill();
        } else g.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.rot * 1.3)) + 1);
        g.restore();
      }
      if (el < duration && canvas.isConnected) raf = requestAnimationFrame(frame);
      else canvas.remove();
    };
    raf = requestAnimationFrame(frame);
    ctx.onClose(() => cancelAnimationFrame(raf));
  }

  // ---------------------------------------------------------------- dialogs
  async function statsDialog({ title, categories = [], value, render, onReset }) {
    let current = value ?? categories[0]?.value;
    const content = h('div', { class: 'gk-stats-content' });
    const paint = async () => {
      const node = await render(current);
      ui.clear(content).appendChild(node);
    };
    let picker = null;
    if (categories.length > 1) {
      const short = categories.reduce((n, c) => n + String(c.label).length, 0) <= 26;
      picker = short
        ? ui.segmented({ options: categories, value: current, onchange: (v) => ((current = v), paint()) })
        : ui.select({ options: categories, value: current, onchange: (v) => ((current = v), paint()) });
      picker.classList.add('gk-stats-picker');
    }
    await paint();
    const body = h('div', { class: 'gk-stats' }, picker, content);
    return ui.dialog({
      title: title || t('gk.statistics'),
      body,
      parent: win,
      className: 'gk-dialog gk-stats-dialog',
      buttons: [
        { label: t('gk.reset'), value: 'reset' },
        { label: t('common.close'), value: 'close', primary: true },
      ],
      onOpen: (dlg) => {
        let confirming = false; // a double-click on Reset must not stack two confirmations
        dlg._validate = (v) => {
          if (v !== 'reset') return true;
          if (confirming) return false;
          confirming = true;
          ui.confirm(t('gk.resetConfirm'), { title: t('gk.resetTitle'), okLabel: t('gk.reset'), danger: true, parent: win })
            .then(async (ok) => {
              if (!ok) return;
              await onReset?.(current);
              await paint();
            })
            .catch((err) => console.error(err))
            .finally(() => (confirming = false));
          return false;
        };
      },
    });
  }

  function statTile(label, value, { accent = false, id } = {}) {
    return h('div', { class: ['gk-stat', accent && 'accent'], 'data-id': id || null }, h('div', { class: 'gk-stat-value' }, String(value)), h('div', { class: 'gk-stat-label' }, label));
  }

  function helpDialog({ title, intro, sections = [], keys = [] }) {
    const body = h(
      'div',
      { class: 'gk-help' },
      intro ? h('p', { class: 'gk-help-intro' }, intro) : null,
      sections.map((s) =>
        h(
          'section',
          { class: 'gk-help-section' },
          h('h3', { class: 'gk-help-title' }, s.icon ? icon(s.icon, { size: 16 }) : null, s.title),
          h(
            'ul',
            null,
            s.items.map((it) => h('li', null, it)),
          ),
        ),
      ),
      keys.length
        ? h(
            'section',
            { class: 'gk-help-section' },
            h('h3', { class: 'gk-help-title' }, icon('keyboard', { size: 16 }), t('gk.keyboard')),
            h(
              'div',
              { class: 'gk-keys' },
              keys.map(([combo, label]) =>
                h(
                  'div',
                  { class: 'gk-key-row' },
                  h(
                    'span',
                    { class: 'gk-key-combo' },
                    combo.split(' / ').map((k, i) => [i ? h('span', { class: 'gk-key-sep' }, '/') : null, h('kbd', null, k)]),
                  ),
                  h('span', { class: 'gk-key-label' }, label),
                ),
              ),
            ),
          )
        : null,
    );
    return ui.dialog({ title: title || t('gk.howToPlay'), body, parent: win, className: 'gk-dialog gk-help-dialog', buttons: [{ label: t('gk.gotIt'), value: true, primary: true }] });
  }

  // ---------------------------------------------------------------- formatting & storage
  const nf = () => new Intl.NumberFormat(ctx.lang === 'fr' ? 'fr-FR' : 'en-US');
  function fmtNum(n) {
    return nf().format(n || 0);
  }
  function fmtTime(ms, decimals = 1) {
    const sec = Math.max(0, ms) / 1000;
    const loc = ctx.lang === 'fr' ? 'fr-FR' : 'en-US';
    if (sec < 60) return `${new Intl.NumberFormat(loc, { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(Math.floor(sec * 10 ** decimals) / 10 ** decimals)} s`;
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    if (m < 60) return `${m}:${String(s).padStart(2, '0')}`;
    return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
  }
  async function load(name, fallback) {
    try {
      const v = await ctx.storage.get(name, fallback);
      return v ?? fallback;
    } catch (err) {
      console.warn(`[${ctx.appId}] could not read ${name}`, err);
      return fallback;
    }
  }
  const pending = new Map();
  let saveWarned = false;
  // A failed write (disk full, read-only home…) is reported once per session, without interrupting the game.
  function saveFailed(name, err) {
    console.warn(`[${ctx.appId}] could not save ${name}`, err);
    if (saveWarned) return;
    saveWarned = true;
    try {
      ctx.shell?.notify?.({ title: ctx.i18n?.name ? ctx.i18n.name(ctx.manifest?.name) : ctx.appId, body: t('gk.saveFailed'), appId: ctx.appId, icon: 'warning' });
    } catch {}
  }
  function save(name, value) {
    // Coalesce rapid writes (e.g. a 2048 game saved after every move).
    clearTimeout(pending.get(name)?.timer);
    const job = { value, timer: setTimeout(() => flushOne(name), 250) };
    pending.set(name, job);
  }
  function flushOne(name) {
    const job = pending.get(name);
    if (!job) return Promise.resolve();
    pending.delete(name);
    clearTimeout(job.timer);
    return Promise.resolve()
      .then(() => ctx.storage.set(name, job.value))
      .catch((err) => saveFailed(name, err));
  }
  function flush() {
    return Promise.all([...pending.keys()].map(flushOne));
  }
  ctx.onClose(() => flush());

  return { button, iconButton, chip, toolbar, bindKeys, sound, overlay, confetti, statsDialog, statTile, helpDialog, fmtNum, fmtTime, load, save, flush, reduceMotion };
}
