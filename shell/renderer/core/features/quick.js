// Réglages rapides (Super+A / the bar's network-volume-battery button).
//   Header: title, battery chip, gear button (opens Settings). Tiles: Wi-Fi (split, > network list),
//   Airplane mode, Focus, Dark mode, Night light, Do not disturb, Accessibility (> animation /
//   transparency toggles). Sliders: brightness (hidden when the display has no backlight), volume
//   (+ > output device picker). Appearance: theme (Halo / Prisme / Sobre, settings.finish), style, ambiance and accent
//   (core/theme.js API).
//   Sub-pages slide horizontally; backend channels (net:*, audio:*, display:*, power:battery) are
//   optional — controls whose backend is missing are hidden, failures are reported inline.
//   Opens on shell 'quick:toggle' / 'quick:open'. Above the tiles: the media card of features/mediactl.js (ctx.mediaCard()).
import { createFlyout } from '../taskbar.js';
import { STYLES, AMBIANCES, ACCENT_PRESETS, chooseStyle, accentPreset, ambianceOf } from '../theme.js';
import { FINISHES, DEFAULT_FINISH, finishDefaults, finishAccent, offeredAccents } from '../finishes.js';

/** The accents offered for a finish: its own three (one per style), then the four Selene accents (as in Settings). */
function accentChoices(finish, current = '') {
  return offeredAccents(finish, ACCENT_PRESETS, current);
}

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
      on: 'On',
      off: 'Off',
      onF: 'On',
      offF: 'Off',
      notConnected: 'Not connected',
      a11ySub: 'Motion, transparency',
      openSettings: 'Open Settings',
      batteryChip: '{percent}%',
      batteryLeft: 'about {time}',
      charging: 'Charging',
      appearance: 'Appearance',
      finish: 'Theme',
      style: 'Style',
      ambiance: 'Ambiance',
      accent: 'Accent colour',
      customAccent: 'Custom',
      contrastNote: 'High contrast uses its own colours.',
      airplane: 'Airplane mode',
      btNotConnected: 'Not connected',
      btManage: 'Manage Bluetooth devices',
      nightLight: 'Night light',
      darkMode: 'Dark mode',
      dnd: 'Do not disturb',
      focus: 'Focus',
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
      allSettings: 'Open Settings',
      animations: 'Animation effects',
      transparency: 'Transparency effects',
      moreAccessibility: 'More accessibility settings',
      magnifier: 'Magnifier',
      back: 'Back',
      batterySettings: 'Power & battery settings',
      notAvailable: 'Not available',
      hidden: 'Hidden network',
      errorGeneric: 'Something went wrong: {msg}',
    },
  },
  fr: {
    quick: {
      title: 'Réglages rapides',
      wifi: 'Wi-Fi',
      on: 'Activé',
      off: 'Désactivé',
      onF: 'Activée',
      offF: 'Désactivée',
      notConnected: 'Non connecté',
      a11ySub: 'Animations, transparence',
      openSettings: 'Ouvrir les Paramètres',
      batteryChip: '{percent} %',
      batteryLeft: 'environ {time}',
      charging: 'En charge',
      appearance: 'Apparence',
      finish: 'Thème',
      style: 'Style',
      ambiance: 'Ambiance',
      accent: 'Couleur d’accent',
      customAccent: 'Personnalisée',
      contrastNote: 'Le contraste élevé utilise ses propres couleurs.',
      airplane: 'Mode avion',
      btNotConnected: 'Non connecté',
      btManage: 'Gérer les appareils Bluetooth',
      nightLight: 'Éclairage nocturne',
      darkMode: 'Mode sombre',
      dnd: 'Ne pas déranger',
      focus: 'Concentration',
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
      allSettings: 'Ouvrir les Paramètres',
      animations: 'Effets d’animation',
      transparency: 'Effets de transparence',
      moreAccessibility: 'Plus de paramètres d’accessibilité',
      magnifier: 'Loupe',
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
  // Keep the taskbar tray in sync (a backend pushes only changes, and this read can swallow one).
  if (kind !== 'display') ctx.taskbar?.applyStatus?.(kind, state[kind]);
}
// Power mode for the tile (inputpower track, main/ipc/inputpower.js): null without power-profiles-daemon.
async function loadPowerProfiles() {
  try {
    state.powerProfiles = (await ctx.api.invoke('power:profiles')) ?? null;
  } catch {
    state.powerProfiles = null;
  }
}
// Bluetooth state for the tile (bluetooth track); null when there is no adapter / no backend.
async function loadBluetooth() {
  try {
    state.bluetooth = (await ctx.api.invoke('bluetooth:status')) ?? null;
  } catch {
    state.bluetooth = null;
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
  const { h, icon } = ctx;
  const name = signal >= 75 ? 'wifi-high' : signal >= 50 ? 'wifi-medium' : signal >= 25 ? 'wifi-low' : 'wifi-none';
  if (!secured) return icon(name, { size });
  return h('span', { class: 'qs-wifi-ico' }, icon(name, { size }), h('span', { class: 'qs-wifi-lock' }, icon('lock-simple', { size: 10, weight: 'fill' })));
}

function tile({ key, label, sub, iconName, on, onToggle, onMore, moreLabel, disabled }) {
  const { h, icon } = ctx;
  const main = h(
    'button',
    {
      class: 'qs-tile-main',
      'aria-pressed': onToggle ? String(!!on) : null,
      disabled: !!disabled,
      onclick: () => (onToggle ? onToggle(!on) : onMore?.()),
    },
    h('span', { class: 'qs-tile-ico' }, typeof iconName === 'string' ? icon(iconName, { size: 20, filled: !!on }) : iconName),
    h('span', { class: 'qs-tile-text' }, h('span', { class: 'qs-tile-label' }, label), sub ? h('span', { class: 'qs-tile-sub' }, sub) : null),
  );
  const more =
    onMore && onToggle
      ? h('button', { class: 'qs-tile-more', 'aria-label': moreLabel || label, 'data-tip': moreLabel || label, disabled: !!disabled, onclick: onMore }, icon('caret-right', { size: 16 }))
      : !onToggle && onMore
        ? h('span', { class: 'qs-tile-caret', 'aria-hidden': 'true' }, icon('caret-right', { size: 14 }))
        : null;
  if (more && !onToggle) main.appendChild(more);
  return h('div', { class: ['qs-tile', on && 'on', onToggle && more && 'split', disabled && 'disabled'], dataset: { key } }, main, onToggle ? more : null);
}

function pageHeader(title, extra) {
  const { h, icon, t } = ctx;
  return h(
    'div',
    { class: 'qs-sub-head' },
    h('button', { class: 'qs-back', 'aria-label': t('quick.back'), 'data-tip': t('quick.back'), onclick: () => showPage(null) }, icon('caret-left', { size: 16 })),
    h('div', { class: 'qs-sub-title' }, title),
    extra || null,
  );
}

const pct = (v) => ctx.t('quick.batteryChip', { percent: Math.round(v) });
const onOff = (on, fem) => ctx.t(`quick.${on ? 'on' : 'off'}${fem ? 'F' : ''}`);
const L = (o) => (o && typeof o === 'object' ? o[ctx.i18n.lang] || o.en : o);

// ---------------------------------------------------------------- main page
function renderMain() {
  const { h, icon, t, settings, shell } = ctx;
  const s = settings.all();
  const net = state.net;
  const hasWifi = !!net && (net.devices || []).some((d) => d.type === 'wifi' || d.type === 'wireless');
  const a11yActive = s.animations === false || s.transparency === false || s.screenReader?.enabled === true || s.magnifier?.enabled === true;
  const tiles = h('div', { class: 'qs-tiles' });
  if (hasWifi) {
    const p = net.primary || {};
    // The Wi-Fi tile names the connected network even when Ethernet is the primary connection.
    const wdev = (net.devices || []).find((d) => (d.type === 'wifi' || d.type === 'wireless') && /^connected/.test(d.state || '') && d.connection);
    const ssid = p.type === 'wifi' && p.name ? p.name : wdev?.connection || null;
    const ap = ssid ? (state.wifiList || []).find((n) => n.ssid === ssid) : null;
    const strength = p.type === 'wifi' && p.strength != null ? Number(p.strength) : ap?.signal ?? 100;
    const wifiOn = !!net.wifiEnabled && !net.airplane;
    tiles.appendChild(
      tile({
        key: 'wifi',
        label: t('quick.wifi'),
        sub: wifiOn ? ssid || t('quick.notConnected') : t('quick.off'),
        iconName: wifiOn ? wifiGlyph(ssid ? strength : 0, false) : icon('wifi-slash', { size: 20 }),
        on: wifiOn,
        moreLabel: t('quick.manageWifi'),
        onToggle: (v) => backend('net:setWifi', [v], () => (state.net = { ...state.net, wifiEnabled: v })),
        onMore: () => showPage('wifi'),
      }),
    );
  }
  if (net) {
    tiles.appendChild(
      tile({ key: 'airplane', label: t('quick.airplane'), sub: onOff(!!net.airplane), iconName: 'airplane', on: !!net.airplane, onToggle: (v) => backend('net:setAirplane', [v], () => (state.net = { ...state.net, airplane: v })) }),
    );
  }
  // Bluetooth tile (bluetooth track, main/ipc/bluetooth.js): toggles the adapter; the arrow opens Paramètres > Bluetooth et appareils.
  const bt = state.bluetooth;
  if (bt?.available) {
    const btDev = bt.powered ? (bt.devices || []).find((d) => d.paired && d.connected) : null;
    tiles.appendChild(
      tile({
        key: 'bluetooth',
        label: 'Bluetooth',
        sub: !bt.powered ? t('quick.off') : btDev ? btDev.name : t('quick.btNotConnected'),
        iconName: bt.powered ? 'bluetooth' : 'bluetooth-slash',
        on: !!bt.powered,
        moreLabel: t('quick.btManage'),
        onToggle: (v) => {
          state.bluetooth = { ...bt, powered: v };
          refreshPage();
          ctx.api
            .invoke('bluetooth:setPowered', v)
            .catch(toastError)
            .finally(() => loadBluetooth().then(() => fly.isOpen && !currentPage && refreshPage()));
        },
        onMore: () => {
          fly.close('launch');
          shell.launch('settings', { page: 'bluetooth' });
        },
      }),
    );
  }
  // Power mode tile (inputpower track): a click moves to the next mode (Économie d'énergie > Équilibré > Performances);
  // the arrow opens Paramètres > Alimentation. Only when power-profiles-daemon offers several modes.
  const pp = state.powerProfiles;
  if (pp?.profiles?.length > 1) {
    const PP_ICONS = { 'power-saver': 'leaf', balanced: 'scales', performance: 'rocket-launch' };
    tiles.appendChild(
      tile({
        key: 'powerMode',
        label: t('pwr.tile'),
        sub: t(`pwr.profile.${pp.active}`),
        iconName: PP_ICONS[pp.active] || 'gauge',
        on: pp.active !== 'balanced',
        moreLabel: t('quick.batterySettings'),
        onToggle: () => {
          const next = pp.profiles[(pp.profiles.indexOf(pp.active) + 1) % pp.profiles.length];
          state.powerProfiles = { ...pp, active: next };
          refreshPage();
          ctx.api
            .invoke('power:setProfile', next)
            .catch(toastError)
            .finally(() => loadPowerProfiles().then(() => fly.isOpen && !currentPage && refreshPage()));
        },
        onMore: () => {
          fly.close('launch');
          shell.launch('settings', { page: 'power' });
        },
      }),
    );
  }
  tiles.append(
    // Focus mode (features/focus.js): hides notifications, dims the desktop, simplifies the bar
    tile({ key: 'focus', label: t('quick.focus'), sub: onOff(!!s.focusMode?.active, true), iconName: 'target', on: !!s.focusMode?.active, onToggle: (v) => shell.emit(v ? 'focus:start' : 'focus:stop') }),
    tile({ key: 'darkMode', label: t('quick.darkMode'), sub: onOff(s.theme === 'dark'), iconName: 'circle-half', on: s.theme === 'dark', onToggle: (v) => settings.set('theme', v ? 'dark' : 'light') }),
    tile({ key: 'nightLight', label: t('quick.nightLight'), sub: onOff(!!s.nightLight), iconName: 'moon-stars', on: !!s.nightLight, onToggle: (v) => settings.set('nightLight', v) }),
    tile({ key: 'dnd', label: t('quick.dnd'), sub: onOff(!!s.notifications?.dnd), iconName: 'bell-slash', on: !!s.notifications?.dnd, onToggle: (v) => settings.set('notifications.dnd', v) }),
    tile({ key: 'accessibility', label: t('quick.accessibility'), sub: t('quick.a11ySub'), iconName: 'person-arms-spread', on: a11yActive, onMore: () => showPage('a11y') }),
  );

  const sliders = h('div', { class: 'qs-sliders' });
  const d = state.display;
  if (d && d.brightness != null) {
    const val = h('span', { class: 'qs-value' }, pct(d.brightness));
    const sl = ctx.ui.slider({
      min: 0,
      max: 100,
      value: d.brightness,
      oninput: throttle((v) => {
        suppressOsd();
        state.display = { ...state.display, brightness: v };
        val.textContent = pct(v);
        ctx.api.invoke('display:setBrightness', v).catch((err) => toastError(err));
      }, 80),
    });
    sl.setAttribute('aria-label', t('quick.brightness'));
    sliders.appendChild(
      h('div', { class: 'qs-slider-row', dataset: { key: 'brightness' } }, h('span', { class: 'qs-slider-icon', 'aria-hidden': 'true' }, icon('sun', { size: 20 })), h('div', { class: 'qs-slider-wrap' }, sl), val, h('span', { class: 'qs-slider-spacer' })),
    );
  }
  const a = state.audio;
  if (a) {
    const vol = Math.round(a.volume ?? 0);
    const volIcon = () => (state.audio.muted ? 'speaker-x' : state.audio.volume === 0 ? 'speaker-none' : state.audio.volume < 34 ? 'speaker-low' : 'speaker-high');
    const muteBtn = h('button', {
      class: 'qs-slider-icon qs-mute',
      'aria-label': a.muted ? t('quick.unmute') : t('quick.mute'),
      'aria-pressed': String(!!a.muted),
      'data-tip': a.muted ? t('quick.unmute') : t('quick.mute'),
      onclick: () => {
        const m = !state.audio.muted;
        suppressOsd();
        backend('audio:setMuted', [m], () => (state.audio = { ...state.audio, muted: m }));
      },
    });
    muteBtn.appendChild(icon(volIcon(), { size: 20 }));
    const valueTip = h('span', { class: 'qs-value' }, pct(vol));
    const sl = ctx.ui.slider({
      min: 0,
      max: 100,
      value: vol,
      oninput: throttle((v) => {
        suppressOsd();
        state.audio = { ...state.audio, volume: v };
        muteBtn.replaceChildren(icon(volIcon(), { size: 20 }));
        valueTip.textContent = pct(v);
        ctx.api.invoke('audio:setVolume', v).catch((err) => toastError(err));
      }, 60),
    });
    sl.setAttribute('aria-label', t('quick.volume'));
    sl.classList.toggle('muted', !!a.muted);
    sliders.appendChild(
      h(
        'div',
        { class: 'qs-slider-row', dataset: { key: 'volume' } },
        muteBtn,
        h('div', { class: 'qs-slider-wrap' }, sl),
        valueTip,
        (a.outputs || []).length
          ? h('button', { class: 'qs-slider-more', 'aria-label': t('quick.selectOutput'), 'data-tip': t('quick.selectOutput'), onclick: () => showPage('audio') }, icon('caret-right', { size: 16 }))
          : h('span', { class: 'qs-slider-spacer' }),
      ),
    );
  }

  const b = state.battery;
  const head = h(
    'div',
    { class: 'qs-head' },
    h('h2', { class: 'qs-title' }, t('quick.title')),
    b
      ? h(
          'button',
          { class: 'qs-battery', 'aria-label': `${t('quick.batterySettings')} (${pct(b.percent ?? 0)})`, 'data-tip': t('quick.batterySettings'), onclick: () => (fly.close('launch'), shell.launch('settings', { page: 'power' })) },
          batteryIcon(b),
          h('span', { class: 'qs-bat-pct' }, pct(b.percent ?? 0)),
          b.charging ? h('span', { class: 'qs-bat-time' }, t('quick.charging')) : b.timeLeftMin > 0 ? h('span', { class: 'qs-bat-time' }, t('quick.batteryLeft', { time: hm(b.timeLeftMin) })) : null,
        )
      : null,
    h('button', { class: 'qs-foot-btn qs-gear', 'aria-label': t('quick.allSettings'), 'data-tip': t('quick.allSettings'), onclick: () => (fly.close('launch'), shell.launch('settings')) }, icon('gear-six', { size: 20 })),
  );
  // media card (features/mediactl.js: the active MPRIS player, Selene's Lecteur or another one) above the tiles
  const media = ctx.mediaCard?.() || null;
  const page = h('div', { class: 'qs-page qs-main' }, head, h('div', { class: 'qs-body' }, media, tiles, sliders.children.length ? sliders : null, renderAppearance(s)));
  return page;
}

function hm(min) {
  const m = Math.round(min);
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
}

// ---------------------------------------------------------------- appearance: style, ambiance, accent
function renderAppearance(s) {
  const { h, icon, t } = ctx;
  const mode = s.theme === 'light' ? 'light' : 'dark';
  const styleId = STYLES.some((x) => x.id === s.style) ? s.style : 'nocturne';
  const isContrast = styleId === 'contrast';
  const amb = ambianceOf(s);
  const preset = accentPreset(s.accent) || finishAccent(s.accent);
  const group = (key, title, value, body) =>
    h('div', { class: 'qs-group', dataset: { key }, role: 'group', 'aria-label': title }, h('div', { class: 'qs-group-head' }, h('span', { class: 'qs-group-title' }, title), value ? h('span', { class: 'qs-group-value' }, value) : null), body);
  const choice = (cls, value, pressed, label, onclick, ...kids) =>
    h('button', { class: [cls, pressed && 'on'], dataset: { value }, 'aria-pressed': String(!!pressed), 'aria-label': label, onclick: () => !pressed && onclick() }, ...kids);

  const styles = h(
    'div',
    { class: 'qs-styles' },
    ...STYLES.map((st) => {
      const def = st.defaults;
      const ap = def ? accentPreset(def.accent) : null;
      const sw = def
        ? h('span', { class: 'qs-style-sw', style: { background: AMBIANCES.find((x) => x.id === def.ambiance)?.swatch[mode] } }, h('span', { class: 'qs-style-dot', style: { background: ap?.[mode].accent || def.accent } }))
        : h('span', { class: 'qs-style-sw contrast' }, icon('circle-half', { size: 16, filled: true }));
      return choice('qs-style', st.id, st.id === styleId, L(st.name), () => chooseStyle(st.id).catch((err) => toastError(err)), sw, h('span', { class: 'qs-style-name' }, L(st.name)), st.id === styleId ? icon('check', { size: 14, class: 'qs-check' }) : null);
    }),
  );
  // the theme: a compact segmented choice above the style (settings.finish; theme.js applies its defaults)
  const finishId = FINISHES.some((f) => f.id === s.finish) ? s.finish : DEFAULT_FINISH;
  const finishes = h(
    'div',
    { class: 'qs-finishes' },
    ...FINISHES.map((f) => choice('qs-finish', f.id, f.id === finishId, L(f.name), () => ctx.settings.set('finish', f.id).catch((err) => toastError(err)), h('span', { class: 'qs-finish-name' }, L(f.name)))),
  );
  const out = [group('finish', t('quick.finish'), null, finishes), group('style', t('quick.style'), null, styles)];
  if (isContrast) {
    out.push(h('p', { class: 'qs-note' }, t('quick.contrastNote')));
  } else {
    const ambs = h(
      'div',
      { class: 'qs-ambs' },
      ...AMBIANCES.map((x) =>
        choice(
          'qs-amb',
          x.id,
          x.id === amb,
          L(x.name),
          () => ctx.settings.set('ambiance', x.id),
          h('span', { class: 'qs-amb-sw', 'aria-hidden': 'true' }, h('span', { style: { background: x.swatch.dark } }), h('span', { style: { background: x.swatch.light } })),
          h('span', { class: 'qs-amb-name' }, L(x.name), x.id === amb ? icon('check', { size: 14, class: 'qs-check' }) : null),
        ),
      ),
    );
    out.push(group('ambiance', t('quick.ambiance'), L(AMBIANCES.find((x) => x.id === amb)?.name), ambs));
    const accents = h(
      'div',
      { class: 'qs-accents' },
      ...accentChoices(FINISHES.some((f) => f.id === s.finish) ? s.finish : DEFAULT_FINISH, s.accent).map((x) =>
        choice(
          'qs-accent',
          x.id,
          preset?.id === x.id,
          L(x.name),
          () => ctx.api.invoke('settings:setMany', s.accentFromWallpaper ? { accent: x.hex, accentFromWallpaper: false } : { accent: x.hex }).catch((err) => toastError(err)),
          h('span', { class: 'qs-accent-sw', style: { background: x[mode].accent, color: x[mode].on } }, preset?.id === x.id ? icon('check', { size: 16, weight: 'bold' }) : null),
        ),
      ),
    );
    out.push(group('accent', t('quick.accent'), preset ? L(preset.name) : t('quick.customAccent'), accents));
  }
  return h('section', { class: 'qs-appearance', 'aria-labelledby': 'qs-appearance-title' }, h('h3', { class: 'qs-sec-title', id: 'qs-appearance-title' }, t('quick.appearance')), ...out);
}

function batteryIcon(b) {
  const p = Math.max(0, Math.min(100, b.percent ?? 0));
  const name = b.charging ? 'battery-charging' : p >= 90 ? 'battery-full' : p >= 60 ? 'battery-high' : p >= 30 ? 'battery-medium' : p > 10 ? 'battery-low' : 'battery-empty';
  const el = ctx.icon(name, { size: 20 });
  if (p <= 10 && !b.charging) el.classList.add('qs-bat-low');
  return el;
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
  if (!on) list.appendChild(h('div', { class: 'qs-empty' }, icon('wifi-slash', { size: 32 }), h('div', null, t('quick.wifiIsOff'))));
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
      on ? h('button', { class: 'qs-foot-btn', 'aria-label': t('quick.refresh'), 'data-tip': t('quick.refresh'), onclick: () => scanWifi(true) }, icon('arrow-clockwise', { size: 16 })) : null,
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
        icon(isHead ? 'headphones' : 'speaker-high', { size: 20 }),
        h('span', { class: 'ellipsis grow' }, o.name || o.id),
        o.default ? icon('check', { size: 16 }) : null,
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
  const row = (label, checked, onchange) => h('div', { class: 'qs-a11y-row' }, h('span', { class: 'grow' }, label), ui.toggle({ checked, onchange, ariaLabel: label }));
  return h(
    'div',
    { class: 'qs-page qs-sub qs-a11y' },
    pageHeader(t('quick.accessibility')),
    h(
      'div',
      { class: 'qs-a11y-list' },
      row(t('quick.animations'), s.animations !== false, (v) => settings.set('animations', v)),
      row(t('quick.transparency'), s.transparency !== false, (v) => settings.set('transparency', v)),
      row(t('screenreader.title'), s.screenReader?.enabled === true, (v) => settings.set('screenReader.enabled', v)), // Lecteur d'écran (features/screenreader.js)
      row(t('quick.magnifier'), s.magnifier?.enabled === true, (v) => settings.set('magnifier.enabled', v)), // Loupe (features/magnifier.js)
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
  const bodyScroll = old?.querySelector('.qs-body')?.scrollTop || 0;
  const next = buildPage(currentPage);
  if (old) old.replaceWith(next);
  else pagesEl.appendChild(next);
  const nl = next.querySelector('.qs-net-list');
  if (nl) nl.scrollTop = scroll;
  const body = next.querySelector('.qs-body');
  if (body) body.scrollTop = bodyScroll;
  if (focusKey) restoreFocus(next, focusKey);
  if (!currentPage) mainPage = next;
}

// Keep keyboard focus on "the same" control after a re-render.
function focusPath(el, rootEl) {
  const key = el.closest('[data-key]')?.dataset.key;
  const all = [...rootEl.querySelectorAll('button, input')];
  return { key, value: el.dataset.value, idx: all.indexOf(el), cls: el.className, inList: !!el.closest('.qs-net-list') };
}
function restoreFocus(rootEl, f) {
  const cls = String(f.cls || '').split(' ')[0];
  let el = f.key && f.value ? rootEl.querySelector(`[data-key="${f.key}"] [data-value="${CSS.escape(f.value)}"]`) : null;
  if (!el && f.key && cls) el = rootEl.querySelector(`[data-key="${f.key}"] .${CSS.escape(cls)}`);
  // Inside the network list keep focus on the expanded (or newly connected) network.
  if (!el) el = rootEl.querySelector('.qs-net.expanded input, .qs-net.expanded .btn.primary, .qs-net.expanded .qs-net-head');
  if (!el && f.inList) el = rootEl.querySelector('.qs-net.active .qs-net-head, .qs-net .qs-net-head');
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
    old.animate([{ transform: 'none', opacity: 1 }, { transform: `translateX(${fwd ? -24 : 24}px)`, opacity: 0 }], { duration: 140, easing: 'cubic-bezier(0.4,0,1,1)', fill: 'forwards' }).finished.then(
      () => old.remove(),
      () => old.remove(),
    );
    next.animate([{ transform: `translateX(${fwd ? 24 : -24}px)`, opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 180, easing: 'cubic-bezier(0.2,0.8,0.2,1)' });
    pagesEl
      .animate([{ height: `${h0}px` }, { height: `${h1}px` }], { duration: 180, easing: 'cubic-bezier(0.2,0.8,0.2,1)' })
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
  await Promise.all([...['net', 'audio', 'display', 'battery'].map(load), loadBluetooth(), loadPowerProfiles()]);
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
  ctx.api.on('bluetooth:changed', (st) => {
    state.bluetooth = st || null;
    if (fly.isOpen && !currentPage) refreshPage();
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
