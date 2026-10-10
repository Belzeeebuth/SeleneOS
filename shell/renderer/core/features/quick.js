// Quick settings flyout (Win+A / taskbar network-volume-battery button) — Windows 11 style.
//   Tiles: Wi-Fi (split, ▸ network list), Airplane mode, Night light, Dark mode, Do not disturb,
//   Accessibility (▸ animation / transparency toggles). Sliders: brightness (hidden when the
//   display has no backlight), volume (+ ▸ output device picker). Footer: battery, Settings.
//   Sub-pages slide horizontally; backend channels (net:*, audio:*, display:*, power:battery) are
//   optional — controls whose backend is missing are hidden, failures are reported inline.
//   Opens on shell 'quick:toggle' / 'quick:open'.
import { createFlyout } from '../taskbar.js';

let ctx;
let fly;
let root;
let pagesEl;
let mainPage;
const state = { net: undefined, audio: undefined, display: undefined, battery: undefined, wifiList: null, scanning: false };

const STRINGS = {
  en: {
    quick: {
      title: 'Quick settings',
      wifi: 'Wi-Fi',
      airplane: 'Airplane mode',
      nightLight: 'Night light',
      darkMode: 'Dark mode',
      dnd: 'Do not disturb',
      accessibility: 'Accessibility',
      brightness: 'Brightness',
      volume: 'Volume',
      mute: 'Mute',
      unmute: 'Unmute',
      soundOutput: 'Sound output',
      selectOutput: 'Select a sound output',
      moreVolume: 'More volume settings',
      manageWifi: 'Manage Wi-Fi connections',
      moreWifi: 'More Wi-Fi settings',
      connected: 'Connected',
      connectedSecured: 'Connected, secured',
      secured: 'Secured',
      openNet: 'Open',
      connect: 'Connect',
      disconnect: 'Disconnect',
      connecting: 'Connecting…',
      next: 'Next',
      cancel: 'Cancel',
      password: 'Enter the network security key',
      showPassword: 'Show characters',
      connectAuto: 'Connect automatically',
      cantConnect: 'Can’t connect to this network',
      wrongKey: 'The network security key isn’t correct. Please try again.',
      noNetworks: 'No Wi-Fi networks found',
      wifiIsOff: 'Wi-Fi is turned off',
      scanning: 'Searching for networks…',
      refresh: 'Refresh',
      allSettings: 'All settings',
      animations: 'Animation effects',
      transparency: 'Transparency effects',
      moreAccessibility: 'More accessibility settings',
      back: 'Back',
      batterySettings: 'Power & battery settings',
      notAvailable: 'Not available',
      hidden: 'Hidden network',
      errorGeneric: 'Something went wrong: {msg}',
    },
  },
  fr: {
    quick: {
      title: 'Paramètres rapides',
      wifi: 'Wi-Fi',
      airplane: 'Mode Avion',
      nightLight: 'Éclairage nocturne',
      darkMode: 'Mode sombre',
      dnd: 'Ne pas déranger',
      accessibility: 'Accessibilité',
      brightness: 'Luminosité',
      volume: 'Volume',
      mute: 'Couper le son',
      unmute: 'Rétablir le son',
      soundOutput: 'Sortie audio',
      selectOutput: 'Sélectionner une sortie audio',
      moreVolume: 'Plus de paramètres de volume',
      manageWifi: 'Gérer les connexions Wi-Fi',
      moreWifi: 'Plus de paramètres Wi-Fi',
      connected: 'Connecté',
      connectedSecured: 'Connecté, sécurisé',
      secured: 'Sécurisé',
      openNet: 'Ouvert',
      connect: 'Se connecter',
      disconnect: 'Se déconnecter',
      connecting: 'Connexion…',
      next: 'Suivant',
      cancel: 'Annuler',
      password: 'Entrez la clé de sécurité réseau',
      showPassword: 'Afficher les caractères',
      connectAuto: 'Se connecter automatiquement',
      cantConnect: 'Impossible de se connecter à ce réseau',
      wrongKey: 'La clé de sécurité réseau est incorrecte. Réessayez.',
      noNetworks: 'Aucun réseau Wi-Fi trouvé',
      wifiIsOff: 'Le Wi-Fi est désactivé',
      scanning: 'Recherche de réseaux…',
      refresh: 'Actualiser',
      allSettings: 'Tous les paramètres',
      animations: 'Effets d’animation',
      transparency: 'Effets de transparence',
      moreAccessibility: 'Plus de paramètres d’accessibilité',
      back: 'Retour',
      batterySettings: 'Paramètres d’alimentation et de batterie',
      notAvailable: 'Non disponible',
      hidden: 'Réseau masqué',
      errorGeneric: 'Une erreur s’est produite : {msg}',
    },
  },
};

const reduceMotion = () => document.documentElement.dataset.animations === 'off';

// ---------------------------------------------------------------- backend helpers
async function load(kind) {
  const ch = { net: 'net:status', audio: 'audio:status', display: 'display:status', battery: 'power:battery' }[kind];
  try {
    state[kind] = (await ctx.api.invoke(ch)) ?? null;
  } catch {
    state[kind] = null;
  }
}
function throttle(fn, ms) {
  let last = 0;
  let timer = null;
  let pending = null;
  return (...args) => {
    pending = args;
    const now = Date.now();
    const run = () => {
      last = Date.now();
      timer = null;
      fn(...pending);
    };
    if (now - last >= ms) run();
    else if (!timer) timer = setTimeout(run, ms - (now - last));
  };
}
function suppressOsd() {
  ctx.shell.emit('osd:suppress', 1500);
}

// ---------------------------------------------------------------- small UI helpers
function appendAll(el, ...nodes) {
  el.append(...nodes.filter((n) => n != null && n !== false));
}
function wifiGlyph(signal, secured, size = 20) {
  const { h } = ctx;
  const level = signal >= 75 ? 4 : signal >= 50 ? 3 : signal >= 25 ? 2 : 1;
  const k = Math.SQRT1_2;
  const arc = (r) => `M${(10 - r * k).toFixed(2)} ${(16.5 - r * k).toFixed(2)}A${r} ${r} 0 0 1 ${(10 + r * k).toFixed(2)} ${(16.5 - r * k).toFixed(2)}`;
  const arcs = [4.6, 8.2, 11.8].map((r, i) => `<path d="${arc(r)}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" opacity="${i < level - 1 ? 1 : 0.3}"/>`).join('');
  const lock = secured ? '<rect x="13.6" y="13.2" width="5.6" height="4.8" rx="1" fill="currentColor"/><path d="M14.7 13.4v-1.2a1.7 1.7 0 0 1 3.4 0v1.2" fill="none" stroke="currentColor" stroke-width="1.1"/>' : '';
  return h('span', { class: 'icon', style: { width: `${size}px`, height: `${size}px` }, html: `<svg viewBox="0 0 20 20" aria-hidden="true">${arcs}<circle cx="10" cy="16.4" r="1.35" fill="currentColor"/>${lock}</svg>` });
}

function tile({ key, label, iconName, on, onToggle, onMore, moreLabel, disabled }) {
  const { h, icon } = ctx;
  const main = h(
    'button',
    {
      class: 'qs-tile-main',
      'aria-pressed': onToggle ? String(!!on) : null,
      'aria-label': label,
      disabled: !!disabled,
      onclick: () => (onToggle ? onToggle(!on) : onMore?.()),
    },
    typeof iconName === 'string' ? icon(iconName, { size: 20 }) : iconName,
  );
  const more =
    onMore && onToggle
      ? h('button', { class: 'qs-tile-more', 'aria-label': moreLabel || label, disabled: !!disabled, onclick: onMore }, icon('chevron_right', { size: 16 }))
      : null;
  return h(
    'div',
    { class: ['qs-tile', on && 'on', more && 'split', disabled && 'disabled'], dataset: { key } },
    h('div', { class: 'qs-tile-btns' }, main, more),
    h('div', { class: 'qs-tile-label' }, label),
  );
}

function pageHeader(title, extra) {
  const { h, icon, t } = ctx;
  return h(
    'div',
    { class: 'qs-sub-head' },
    h('button', { class: 'qs-back', 'aria-label': t('quick.back'), onclick: () => showPage(null) }, icon('chevron_left', { size: 16 })),
    h('div', { class: 'qs-sub-title' }, title),
    extra || null,
  );
}

// ---------------------------------------------------------------- main page
function renderMain() {
  const { h, icon, t, settings, shell } = ctx;
  const s = settings.all();
  const net = state.net;
  const hasWifi = !!net && (net.devices || []).some((d) => d.type === 'wifi' || d.type === 'wireless');
  const a11yActive = s.animations === false || s.transparency === false;
  const tiles = h('div', { class: 'qs-tiles' });
  if (hasWifi) {
    const p = net.primary || {};
    tiles.appendChild(
      tile({
        key: 'wifi',
        label: p.type === 'wifi' && p.name ? p.name : t('quick.wifi'),
        iconName: net.wifiEnabled && !net.airplane ? wifiGlyph(p.type === 'wifi' ? Number(p.strength ?? 100) : 100, false) : icon('wifi_off', { size: 20 }),
        on: !!net.wifiEnabled && !net.airplane,
        moreLabel: t('quick.manageWifi'),
        onToggle: (v) => backend('net:setWifi', [v], () => (state.net = { ...state.net, wifiEnabled: v })),
        onMore: () => showPage('wifi'),
      }),
    );
  }
  if (net) {
    tiles.appendChild(
      tile({ key: 'airplane', label: t('quick.airplane'), iconName: 'airplane', on: !!net.airplane, onToggle: (v) => backend('net:setAirplane', [v], () => (state.net = { ...state.net, airplane: v })) }),
    );
  }
  tiles.append(
    tile({ key: 'nightLight', label: t('quick.nightLight'), iconName: 'weather_moon', on: !!s.nightLight, onToggle: (v) => settings.set('nightLight', v) }),
    tile({ key: 'darkMode', label: t('quick.darkMode'), iconName: 'dark_theme', on: s.theme === 'dark', onToggle: (v) => settings.set('theme', v ? 'dark' : 'light') }),
    tile({ key: 'dnd', label: t('quick.dnd'), iconName: 'alert_snooze', on: !!s.notifications?.dnd, onToggle: (v) => settings.set('notifications.dnd', v) }),
    tile({ key: 'accessibility', label: t('quick.accessibility'), iconName: 'accessibility', on: a11yActive, onMore: () => showPage('a11y') }),
  );

  const sliders = h('div', { class: 'qs-sliders' });
  const d = state.display;
  if (d && d.brightness != null) {
    const sl = ctx.ui.slider({
      min: 0,
      max: 100,
      value: d.brightness,
      oninput: throttle((v) => {
        suppressOsd();
        state.display = { ...state.display, brightness: v };
        ctx.api.invoke('display:setBrightness', v).catch((err) => toastError(err));
      }, 80),
    });
    sl.setAttribute('aria-label', t('quick.brightness'));
    sliders.appendChild(h('div', { class: 'qs-slider-row', dataset: { key: 'brightness' } }, h('span', { class: 'qs-slider-icon' }, icon('brightness_high', { size: 20 })), sl, h('span', { class: 'qs-slider-spacer' })));
  }
  const a = state.audio;
  if (a) {
    const vol = Math.round(a.volume ?? 0);
    const volIcon = () => (state.audio.muted ? 'speaker_mute' : state.audio.volume === 0 ? 'speaker_0' : state.audio.volume < 34 ? 'speaker_1' : 'speaker_2');
    const muteBtn = h('button', {
      class: 'qs-slider-icon qs-mute',
      'aria-label': a.muted ? t('quick.unmute') : t('quick.mute'),
      'data-tip': a.muted ? t('quick.unmute') : t('quick.mute'),
      onclick: () => {
        const m = !state.audio.muted;
        suppressOsd();
        backend('audio:setMuted', [m], () => (state.audio = { ...state.audio, muted: m }));
      },
    });
    muteBtn.appendChild(icon(volIcon(), { size: 20 }));
    const sl = ctx.ui.slider({
      min: 0,
      max: 100,
      value: vol,
      oninput: throttle((v) => {
        suppressOsd();
        state.audio = { ...state.audio, volume: v };
        muteBtn.replaceChildren(icon(volIcon(), { size: 20 }));
        valueTip.textContent = String(v);
        ctx.api.invoke('audio:setVolume', v).catch((err) => toastError(err));
      }, 60),
    });
    sl.setAttribute('aria-label', t('quick.volume'));
    sl.classList.toggle('muted', !!a.muted);
    const valueTip = h('span', { class: 'qs-value' }, String(vol));
    sliders.appendChild(
      h(
        'div',
        { class: 'qs-slider-row', dataset: { key: 'volume' } },
        muteBtn,
        h('div', { class: 'qs-slider-wrap' }, sl, valueTip),
        (a.outputs || []).length
          ? h('button', { class: 'qs-slider-more', 'aria-label': t('quick.selectOutput'), 'data-tip': t('quick.selectOutput'), onclick: () => showPage('audio') }, icon('speaker_settings', { size: 18 }))
          : h('span', { class: 'qs-slider-spacer' }),
      ),
    );
  }

  const b = state.battery;
  const footer = h(
    'div',
    { class: 'qs-footer' },
    b
      ? h(
          'button',
          { class: 'qs-battery', 'aria-label': ctx.t('quick.batterySettings'), onclick: () => (fly.close('launch'), shell.launch('settings', { page: 'power' })) },
          batteryIcon(b),
          h('span', null, `${Math.round(b.percent ?? 0)}${ctx.i18n.lang === 'fr' ? ' %' : '%'}`),
        )
      : h('span'),
    h(
      'div',
      { class: 'qs-footer-right' },
      h('button', { class: 'qs-foot-btn', 'aria-label': t('quick.allSettings'), 'data-tip': t('quick.allSettings'), onclick: () => (fly.close('launch'), shell.launch('settings')) }, icon('settings', { size: 16 })),
    ),
  );
  const page = h('div', { class: 'qs-page qs-main' }, h('div', { class: 'qs-body' }, tiles, sliders.children.length ? sliders : null), footer);
  return page;
}

function batteryIcon(b) {
  const { h } = ctx;
  const pct = Math.max(0, Math.min(100, b.percent ?? 0));
  const w = ((12.4 * pct) / 100).toFixed(1);
  return h('span', {
    class: 'icon',
    style: { width: '20px', height: '20px' },
    html: `<svg viewBox="0 0 20 20"><rect x="1.7" y="5.7" width="15" height="8.6" rx="2" fill="none" stroke="currentColor" stroke-width="1.3"/><rect x="17.4" y="8.2" width="1.4" height="3.6" rx=".6" fill="currentColor"/><rect x="3.3" y="7.3" width="${w}" height="5.4" rx="1" fill="${pct <= 10 && !b.charging ? '#e81123' : 'currentColor'}"/>${
      b.charging ? '<path d="M10.6 4.2 7.4 10.4h2.7l-.9 5.4 3.4-6.6H9.9z" fill="currentColor"/>' : ''
    }</svg>`,
  });
}

// ---------------------------------------------------------------- Wi-Fi page
let expandedSsid = null;
let wifiBusy = null; // { ssid, phase: 'connecting' }
let wifiError = null;

async function scanWifi(rescan = true) {
  state.scanning = true;
  if (currentPage === 'wifi') refreshPage();
  try {
    const list = await ctx.api.invoke('net:wifiList', rescan);
    state.wifiList = (Array.isArray(list) ? list : []).sort((x, y) => (y.active ? 1 : 0) - (x.active ? 1 : 0) || (y.signal ?? 0) - (x.signal ?? 0));
  } catch (err) {
    state.wifiList = state.wifiList || [];
    wifiError = { ssid: null, msg: err.message };
  }
  state.scanning = false;
  if (currentPage === 'wifi') refreshPage();
}

function renderWifi() {
  const { h, icon, t, ui } = ctx;
  const net = state.net || {};
  const on = !!net.wifiEnabled && !net.airplane;
  const toggle = ui.toggle({
    checked: on,
    onchange: (v) => backend('net:setWifi', [v], () => (state.net = { ...state.net, wifiEnabled: v }), () => v && scanWifi(true)),
  });
  toggle.input.setAttribute('aria-label', t('quick.wifi'));
  const list = h('div', { class: 'qs-net-list', role: 'list' });
  if (!on) list.appendChild(h('div', { class: 'qs-empty' }, icon('wifi_off', { size: 32 }), h('div', null, t('quick.wifiIsOff'))));
  else if (state.wifiList && !state.wifiList.length && !state.scanning) list.appendChild(h('div', { class: 'qs-empty' }, h('div', null, t('quick.noNetworks'))));
  else if (!state.wifiList) list.appendChild(h('div', { class: 'qs-empty' }, h('span', { class: 'spinner small' }), h('div', null, t('quick.scanning'))));
  if (on && wifiError && !wifiError.ssid) list.appendChild(h('div', { class: 'qs-error caption' }, t('quick.errorGeneric', { msg: wifiError.msg })));
  for (const n of on ? state.wifiList || [] : []) list.appendChild(netItem(n));
  return h(
    'div',
    { class: 'qs-page qs-sub qs-wifi' },
    pageHeader(t('quick.wifi'), toggle),
    h('div', { class: ['qs-scanbar', state.scanning && on && 'on'] }),
    list,
    h(
      'div',
      { class: 'qs-sub-foot' },
      h('button', { class: 'qs-link', onclick: () => (fly.close('launch'), ctx.shell.launch('settings', { page: 'wifi' })) }, t('quick.moreWifi')),
      on ? h('button', { class: 'qs-foot-btn', 'aria-label': t('quick.refresh'), 'data-tip': t('quick.refresh'), onclick: () => scanWifi(true) }, icon('arrow_clockwise', { size: 16 })) : null,
    ),
  );
}

function netItem(n) {
  const { h, t, ui } = ctx;
  const secured = !!n.security && n.security !== '--' && n.security !== 'none';
  const expanded = expandedSsid === n.ssid;
  const busy = wifiBusy?.ssid === n.ssid;
  const err = wifiError?.ssid === n.ssid ? wifiError : null;
  const status = n.active ? (secured ? t('quick.connectedSecured') : t('quick.connected')) : secured ? t('quick.secured') : t('quick.openNet');
  const head = h(
    'button',
    {
      class: 'qs-net-head',
      'aria-expanded': String(expanded),
      onclick: () => {
        expandedSsid = expanded ? null : n.ssid;
        if (wifiError?.ssid === n.ssid && !expanded) wifiError = null;
        refreshPage();
      },
    },
    wifiGlyph(n.signal ?? 0, secured),
    h('div', { class: 'qs-net-text' }, h('div', { class: 'ellipsis' }, n.ssid || t('quick.hidden')), h('div', { class: 'caption text-2 ellipsis' }, busy ? t('quick.connecting') : status)),
  );
  const item = h('div', { class: ['qs-net', n.active && 'active', expanded && 'expanded'], role: 'listitem' }, head);
  if (!expanded) return item;
  const body = h('div', { class: 'qs-net-body' });
  if (n.active) {
    body.appendChild(h('div', { class: 'qs-net-actions' }, h('button', { class: 'btn', onclick: () => disconnectWifi() }, t('quick.disconnect'))));
  } else if (busy) {
    body.appendChild(h('div', { class: 'qs-net-busy caption', role: 'status', 'aria-label': t('quick.connecting') }, h('div', { class: 'progress indeterminate grow' }, h('div', { class: 'bar' }))));
  } else if (wifiBusy?.needKey === n.ssid || (err && err.code === 'EAUTH')) {
    const pw = h('input', { class: 'input', type: 'password', placeholder: t('quick.password'), 'aria-label': t('quick.password') });
    const show = h('button', {
      class: 'qs-eye',
      type: 'button',
      'aria-label': t('quick.showPassword'),
      onpointerdown: () => (pw.type = 'text'),
      onpointerup: () => (pw.type = 'password'),
      onpointerleave: () => (pw.type = 'password'),
    });
    show.appendChild(ctx.icon('eye', { size: 16 }));
    const go = () => pw.value.length >= 1 && connectWifi(n, pw.value);
    pw.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        // Prevent the Enter keypress from activating whatever gets focus after the re-render.
        e.preventDefault();
        go();
      }
    });
    appendAll(
      body,
      h('div', { class: 'qs-pw' }, pw, show),
      err ? h('div', { class: 'qs-error caption' }, err.code === 'EAUTH' ? t('quick.wrongKey') : err.msg) : null,
      h(
        'div',
        { class: 'qs-net-actions two' },
        h('button', { class: 'btn primary', onclick: go }, t('quick.next')),
        h(
          'button',
          {
            class: 'btn',
            onclick: () => {
              wifiBusy = null;
              wifiError = null;
              expandedSsid = null;
              refreshPage();
            },
          },
          t('quick.cancel'),
        ),
      ),
    );
    setTimeout(() => pw.isConnected && pw.focus(), 30);
  } else {
    const auto = h('label', { class: 'checkbox caption' }, h('input', { type: 'checkbox', checked: true, class: 'qs-auto' }), h('span', null, t('quick.connectAuto')));
    appendAll(
      body,
      auto,
      err ? h('div', { class: 'qs-error caption' }, t('quick.cantConnect'), h('br'), h('span', { class: 'text-2' }, err.msg)) : null,
      h(
        'div',
        { class: 'qs-net-actions' },
        h(
          'button',
          {
            class: 'btn primary',
            onclick: () => {
              if (secured && !n.saved) {
                wifiBusy = { needKey: n.ssid };
                wifiError = null;
                refreshPage();
              } else connectWifi(n);
            },
          },
          t('quick.connect'),
        ),
      ),
    );
  }
  item.appendChild(body);
  return item;
}

async function connectWifi(n, password) {
  wifiBusy = { ssid: n.ssid };
  wifiError = null;
  refreshPage();
  try {
    await ctx.api.invoke('net:wifiConnect', n.ssid, password);
    wifiBusy = null;
    expandedSsid = null;
    await load('net');
    await scanWifi(false);
  } catch (err) {
    const code = err.code === 'EAUTH' || /secrets|password|key|802-11-wireless-security/i.test(err.message) ? 'EAUTH' : err.code;
    wifiBusy = code === 'EAUTH' ? { needKey: n.ssid } : null;
    wifiError = { ssid: n.ssid, code, msg: err.message };
    refreshPage();
  }
}

async function disconnectWifi() {
  try {
    await ctx.api.invoke('net:wifiDisconnect');
    expandedSsid = null;
    await load('net');
    await scanWifi(false);
  } catch (err) {
    wifiError = { ssid: null, msg: err.message };
    refreshPage();
  }
}

// ---------------------------------------------------------------- audio output page
function renderAudio() {
  const { h, icon, t } = ctx;
  const a = state.audio || {};
  const list = h('div', { class: 'qs-out-list', role: 'listbox' });
  for (const o of a.outputs || []) {
    const isHead = /head|casque|earbud|airpod/i.test(o.name || '');
    list.appendChild(
      h(
        'button',
        {
          class: ['qs-out', o.default && 'selected'],
          role: 'option',
          'aria-selected': String(!!o.default),
          onclick: () =>
            backend('audio:setOutput', [o.id], () => {
              state.audio = { ...state.audio, outputs: state.audio.outputs.map((x) => ({ ...x, default: x.id === o.id })) };
            }),
        },
        icon(isHead ? 'headphones' : 'speaker_2', { size: 20 }),
        h('span', { class: 'ellipsis grow' }, o.name || o.id),
        o.default ? icon('checkmark', { size: 16 }) : null,
      ),
    );
  }
  return h(
    'div',
    { class: 'qs-page qs-sub qs-audio' },
    pageHeader(t('quick.soundOutput')),
    list,
    h('div', { class: 'qs-sub-foot' }, h('button', { class: 'qs-link', onclick: () => (fly.close('launch'), ctx.shell.launch('settings', { page: 'sound' })) }, t('quick.moreVolume'))),
  );
}

// ---------------------------------------------------------------- accessibility page
function renderA11y() {
  const { h, t, ui, settings } = ctx;
  const s = settings.all();
  const row = (label, checked, onchange) => h('div', { class: 'qs-a11y-row' }, h('span', { class: 'grow' }, label), ui.toggle({ checked, onchange }));
  return h(
    'div',
    { class: 'qs-page qs-sub qs-a11y' },
    pageHeader(t('quick.accessibility')),
    h(
      'div',
      { class: 'qs-a11y-list' },
      row(t('quick.animations'), s.animations !== false, (v) => settings.set('animations', v)),
      row(t('quick.transparency'), s.transparency !== false, (v) => settings.set('transparency', v)),
    ),
    h('div', { class: 'qs-sub-foot' }, h('button', { class: 'qs-link', onclick: () => (fly.close('launch'), ctx.shell.launch('settings', { page: 'accessibility' })) }, t('quick.moreAccessibility'))),
  );
}

// ---------------------------------------------------------------- page management
let currentPage = null; // null = main

function buildPage(name) {
  if (name === 'wifi') return renderWifi();
  if (name === 'audio') return renderAudio();
  if (name === 'a11y') return renderA11y();
  return renderMain();
}

function refreshPage() {
  if (!pagesEl) return;
  const old = pagesEl.querySelector('.qs-page:not(.leaving)');
  const focusKey = document.activeElement && old?.contains(document.activeElement) ? focusPath(document.activeElement, old) : null;
  const scroll = old?.querySelector('.qs-net-list')?.scrollTop || 0;
  const next = buildPage(currentPage);
  if (old) old.replaceWith(next);
  else pagesEl.appendChild(next);
  const nl = next.querySelector('.qs-net-list');
  if (nl) nl.scrollTop = scroll;
  if (focusKey) restoreFocus(next, focusKey);
  if (!currentPage) mainPage = next;
}

// Keep keyboard focus on "the same" control after a re-render.
function focusPath(el, rootEl) {
  const key = el.closest('[data-key]')?.dataset.key;
  const all = [...rootEl.querySelectorAll('button, input')];
  return { key, idx: all.indexOf(el), cls: el.className };
}
function restoreFocus(rootEl, f) {
  const cls = String(f.cls || '').split(' ')[0];
  let el = f.key && cls ? rootEl.querySelector(`[data-key="${f.key}"] .${CSS.escape(cls)}`) : null;
  // Inside the network list keep focus on the expanded network rather than a random control.
  if (!el) el = rootEl.querySelector('.qs-net.expanded input, .qs-net.expanded .btn.primary, .qs-net.expanded .qs-net-head');
  if (!el) el = [...rootEl.querySelectorAll('button, input')][f.idx];
  el?.focus({ preventScroll: true });
}

function showPage(name) {
  const prev = currentPage;
  currentPage = name;
  const old = pagesEl.querySelector('.qs-page:not(.leaving)');
  const next = buildPage(name);
  if (!old || reduceMotion()) {
    pagesEl.replaceChildren(next);
  } else {
    const fwd = !!name;
    const h0 = pagesEl.offsetHeight;
    old.classList.add('leaving');
    pagesEl.appendChild(next);
    const h1 = next.offsetHeight;
    pagesEl.style.height = `${h0}px`;
    old.animate([{ transform: 'none', opacity: 1 }, { transform: `translateX(${fwd ? -40 : 40}%)`, opacity: 0 }], { duration: 200, easing: 'cubic-bezier(0.7,0,1,0.5)', fill: 'forwards' }).finished.then(
      () => old.remove(),
      () => old.remove(),
    );
    next.animate([{ transform: `translateX(${fwd ? 40 : -40}%)`, opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 300, easing: 'cubic-bezier(0.1,0.9,0.2,1)' });
    pagesEl
      .animate([{ height: `${h0}px` }, { height: `${h1}px` }], { duration: 300, easing: 'cubic-bezier(0.1,0.9,0.2,1)' })
      .finished.then(
        () => (pagesEl.style.height = ''),
        () => (pagesEl.style.height = ''),
      );
  }
  if (!name) mainPage = next;
  if (name === 'wifi') {
    expandedSsid = null;
    wifiError = null;
    wifiBusy = null;
    scanWifi(true);
  }
  setTimeout(() => next.querySelector(name ? '.qs-back' : `[data-key="${prev === 'wifi' ? 'wifi' : prev === 'a11y' ? 'accessibility' : 'volume'}"] button`)?.focus({ preventScroll: true }), 40);
}

// Run a backend call; optimistic update, then re-sync from the backend.
async function backend(channel, args, optimistic, after) {
  optimistic?.();
  refreshPage();
  try {
    await ctx.api.invoke(channel, ...args);
    after?.();
  } catch (err) {
    toastError(err);
  }
  const kind = channel.split(':')[0] === 'net' ? 'net' : channel.split(':')[0] === 'audio' ? 'audio' : channel.split(':')[0] === 'display' ? 'display' : null;
  if (kind) {
    await load(kind);
    refreshPage();
  }
}

function toastError(err) {
  if (!fly?.isOpen) return;
  const msg = ctx.t('quick.errorGeneric', { msg: err?.message || String(err) });
  const el = ctx.h('div', { class: 'qs-toast caption', role: 'alert' }, msg);
  root.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

async function onOpen() {
  currentPage = null;
  pagesEl.replaceChildren(renderMain());
  await Promise.all(['net', 'audio', 'display', 'battery'].map(load));
  if (fly.isOpen && !currentPage) refreshPage();
}

export function mount(c) {
  // Feature context = the shell context plus the icon helper.
  ctx = Object.create(c);
  ctx.icon = c.ui.icon;
  ctx.i18n.extend(STRINGS);
  ctx.ui.loadCss('app://shell/core/features/quick.css');
  root = ctx.h('div', { id: 'quick-settings', class: 'qs', role: 'dialog', 'aria-label': ctx.t('quick.title') });
  pagesEl = ctx.h('div', { class: 'qs-pages' });
  root.appendChild(pagesEl);
  document.getElementById('flyouts').appendChild(root);
  fly = createFlyout({
    id: 'quick',
    el: root,
    button: '.tb-quick',
    onOpen,
    // Esc on a sub-page goes back to the main page (a second Esc closes the flyout).
    onEscape: () => {
      if (!currentPage) return false;
      showPage(null);
      return true;
    },
    focus: () => root.querySelector('.qs-tile-main'),
  });
  ctx.shell.on('quick:toggle', () => fly.toggle());
  ctx.shell.on('quick:open', () => fly.open());
  // Live updates from the backend while the flyout is open.
  ctx.api.on('net:changed', (st) => {
    state.net = st || null;
    if (fly.isOpen && (!currentPage || currentPage === 'wifi') && !wifiBusy) refreshPage();
  });
  ctx.api.on('audio:changed', (st) => {
    const outputsChanged = JSON.stringify(st?.outputs) !== JSON.stringify(state.audio?.outputs);
    state.audio = st || null;
    // Don't fight the user's slider drag: only refresh when not interacting.
    if (fly.isOpen && (currentPage === 'audio' || (outputsChanged && !currentPage) || (!currentPage && !root.querySelector('.slider:active')))) refreshPage();
  });
  ctx.settings.on('*', () => fly.isOpen && (!currentPage || currentPage === 'a11y') && refreshPage());
  ctx.i18n.on('change', () => {
    root.setAttribute('aria-label', ctx.t('quick.title'));
    if (fly.isOpen) refreshPage();
  });
  pagesEl.appendChild(renderMain());
  c.quick = {
    open: () => fly.open(),
    close: () => fly.close('api'),
    showPage,
    get isOpen() {
      return fly.isOpen;
    },
    state,
  };
}
