// Media controls: the shell side of MPRIS (main/ipc/sessionbus.js + helpers/aurora-sessionbus).
//   - Selene's Lecteur (apps/media/lib/session.js) sends its state on the shell bus ('mediactl:state' state | null,
//     'mediactl:seeked' position): it is forwarded to the helper, which exports it as org.mpris.MediaPlayer2.selene;
//     MPRIS calls from other programs (KDE Connect, playerctl…) come back as api 'mpris:call' and go to the Lecteur as
//     'mediactl:call' { method, offset, position, path, prop, value }.
//   - The other players on the session bus (api 'mpris:players': Spotify, VLC, browsers…) and the Lecteur make one list;
//     the « active » one is the most recently started (activeAt), or the one the user picked in the card's menu until
//     another one starts playing.
//   - A media card in Réglages rapides (quick.js asks ctx.mediaCard()): cover, title, artist, seek bar, previous /
//     play-pause / next, the player's name (a menu switches between players when there are several; the cover opens it).
//   - Media keys (features/hotkeys.js -> shell 'media:key' 'playpause'|'pause'|'stop'|'next'|'previous', from any window,
//     X11 apps included through aurora-xwm) act on the active player; the OSD (osd.js, kind 'media') shows the track.
// Test hook: window.__aurora.mediactl = { players(), active(), key(k), control(id, method, value), card }.
let ctx;
let local = null; // the Lecteur: { ...state, positionAt, activeAt }
let remote = [];
let chosen = null; // { id, at } picked in the card's menu
let card = null;
let els = {};
let tickTimer = null;
let dragging = false;
let osdPending = null;

const STRINGS = {
  en: {
    mediactl: {
      card: 'Now playing',
      play: 'Play',
      pause: 'Pause',
      next: 'Next',
      previous: 'Previous',
      seek: 'Position',
      seekValue: '{at} of {length}',
      open: 'Open {player}',
      choose: 'Choose the player',
      noTitle: 'Unknown title',
      stopped: 'Nothing playing',
    },
  },
  fr: {
    mediactl: {
      card: 'Lecture en cours',
      play: 'Lecture',
      pause: 'Pause',
      next: 'Suivant',
      previous: 'Précédent',
      seek: 'Position',
      seekValue: '{at} sur {length}',
      open: 'Ouvrir {player}',
      choose: 'Choisir le lecteur',
      noTitle: 'Titre inconnu',
      stopped: 'Aucune lecture en cours',
    },
  },
};

// ---------------------------------------------------------------- players
function players() {
  const list = [];
  if (local) {
    const art = local.track?.art ? ctx.api.mediaUrl(local.track.art) : null;
    list.push({ ...local, id: 'selene', local: true, identity: ctx.registry.name('media') || local.identity, icon: ctx.registry.iconUrl('media'), canRaise: true, canControl: true, track: local.track ? { ...local.track, art } : null });
  }
  for (const p of remote) list.push({ ...p, id: p.name, local: false });
  return list;
}

function active() {
  const list = players();
  if (!list.length) return null;
  const newest = list.reduce((a, b) => ((b.activeAt || 0) > (a.activeAt || 0) ? b : a));
  if (chosen) {
    const c = list.find((p) => p.id === chosen.id);
    if (c && !((newest.activeAt || 0) > chosen.at)) return c;
    if (!c) chosen = null;
  }
  const playing = list.filter((p) => p.status === 'Playing');
  if (playing.length) return playing.reduce((a, b) => ((b.activeAt || 0) > (a.activeAt || 0) ? b : a));
  return newest;
}

/** Where the player is now (s): its last known position, moved on by the time spent playing. */
function positionOf(p) {
  let pos = Number(p?.position) || 0;
  if (p?.status === 'Playing' && p.positionAt) pos += ((Date.now() - p.positionAt) / 1000) * (p.rate || 1);
  const len = p?.track?.length || 0;
  return Math.max(0, len ? Math.min(pos, len) : pos);
}

function control(p, method, value = 0) {
  if (!p) return Promise.resolve(false);
  if (p.local) {
    ctx.shell.emit('mediactl:call', method === 'Seek' ? { method, offset: value } : method === 'SetPosition' ? { method, position: value } : { method });
    return Promise.resolve(true);
  }
  return ctx.api.invoke('mpris:control', p.name, method, value).then(
    () => true,
    (err) => (console.warn(`[mediactl] ${p.identity} ${method} failed: ${err?.message || err}`), false),
  );
}

const KEYS = { playpause: 'PlayPause', play: 'Play', pause: 'Pause', stop: 'Stop', next: 'Next', previous: 'Previous' };
function onKey(k) {
  const method = KEYS[k];
  const p = active();
  if (!method || !p) return false;
  control(p, method);
  // the OSD shows the player's new state: at its next update (the new track's title after Next), at the latest 0.9 s on
  const predicted = method === 'PlayPause' ? (p.status === 'Playing' ? 'Paused' : 'Playing') : method === 'Pause' ? 'Paused' : method === 'Stop' ? 'Stopped' : null;
  clearTimeout(osdPending?.timer);
  osdPending = { id: p.id, predicted, updates: 0, timer: setTimeout(flushOsd, 900) };
  return true;
}
function flushOsd() {
  const o = osdPending;
  osdPending = null;
  if (!o) return;
  clearTimeout(o.timer);
  const p = players().find((x) => x.id === o.id);
  if (!p) return;
  // no news from the player (yet): what the key should have done
  const status = !o.updates && o.predicted ? o.predicted : p.status;
  ctx.shell.emit('osd', { kind: 'media', title: p.track?.title || '', artist: p.track?.artist || '', player: p.identity, art: p.track?.art || p.icon || null, status });
}
function updated(id) {
  if (osdPending?.id !== id) return;
  osdPending.updates++;
  clearTimeout(osdPending.timer);
  osdPending.timer = setTimeout(flushOsd, 150); // let the status and the track settle
}

// ---------------------------------------------------------------- the card
const fmt = (s) => {
  s = Math.max(0, Math.floor(Number(s) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
};

function buildCard() {
  const { h, t } = ctx;
  const icon = ctx.ui.icon;
  const btn = (cls, onclick) => h('button', { class: ['mc-btn', cls], type: 'button', onclick });
  els.art = h('button', { class: 'mc-art', type: 'button', onclick: () => control(active(), 'Raise').then(() => ctx.quick?.close()) });
  els.title = h('div', { class: 'mc-title' });
  els.artist = h('div', { class: 'mc-artist' });
  els.at = h('span', { class: 'mc-time mc-at' });
  els.len = h('span', { class: 'mc-time mc-len' });
  els.seek = ctx.ui.slider({
    min: 0,
    max: 1000,
    value: 0,
    oninput: () => (dragging = true),
    onchange: (v) => {
      dragging = false;
      const p = active();
      if (p?.track?.length) control(p, 'SetPosition', (p.track.length * v) / 1000);
    },
  });
  els.seek.classList.add('mc-seek');
  els.seek.addEventListener('pointerup', () => setTimeout(() => (dragging = false), 50));
  els.player = h('button', { class: 'mc-player', type: 'button', onclick: (e) => chooseMenu(e) });
  els.prev = btn('mc-prev', () => control(active(), 'Previous'));
  els.play = btn('mc-play', () => control(active(), 'PlayPause'));
  els.next = btn('mc-next', () => control(active(), 'Next'));
  els.prev.append(icon('skip-back', { size: 18, filled: true }));
  els.next.append(icon('skip-forward', { size: 18, filled: true }));
  card = h(
    'section',
    { class: 'mc-card', role: 'group', 'aria-label': t('mediactl.card'), hidden: true },
    h('div', { class: 'mc-top' }, els.art, h('div', { class: 'mc-info' }, els.title, els.artist)),
    h('div', { class: 'mc-seekrow' }, els.at, h('div', { class: 'mc-seekwrap' }, els.seek), els.len),
    h('div', { class: 'mc-bottom' }, els.player, h('div', { class: 'mc-ctl' }, els.prev, els.play, els.next)),
  );
  return card;
}

function chooseMenu(e) {
  const list = players();
  if (list.length < 2) return;
  const cur = active();
  ctx.ui.menu(
    e,
    list.map((p) => ({
      label: p.track?.title ? `${p.identity} — ${p.track.title}` : p.identity,
      checked: p.id === cur?.id,
      action: () => {
        chosen = { id: p.id, at: Date.now() };
        render();
      },
    })),
    { className: 'mc-menu' },
  );
}

function render() {
  if (!card) return;
  const { t } = ctx;
  const icon = ctx.ui.icon;
  const p = active();
  card.hidden = !p;
  stopTick();
  if (!p) return;
  const tr = p.track || {};
  const title = tr.title || (p.status === 'Stopped' && !p.track ? t('mediactl.stopped') : t('mediactl.noTitle'));
  card.setAttribute('aria-label', t('mediactl.card'));
  card.dataset.player = p.id;
  card.dataset.status = p.status;
  els.title.textContent = title;
  els.title.title = title;
  els.artist.textContent = [tr.artist, tr.album].filter(Boolean).join(' · ');
  els.artist.hidden = !els.artist.textContent;
  const art = tr.art || null;
  if (els.art.dataset.src !== (art || '') || !els.art.firstChild) {
    els.art.dataset.src = art || '';
    const ph = () => (p.icon ? ctx.h('img', { class: 'mc-art-app', src: p.icon, alt: '' }) : icon('music-notes', { size: 28 }));
    if (art) {
      const img = ctx.h('img', { src: art, alt: '', draggable: false });
      img.addEventListener('error', () => img.replaceWith(ph()));
      els.art.replaceChildren(img);
    } else els.art.replaceChildren(ph());
    els.art.classList.toggle('noart', !art);
  }
  const openLabel = t('mediactl.open', { player: p.identity });
  els.art.setAttribute('aria-label', openLabel);
  els.art.dataset.tip = openLabel;
  els.art.disabled = !p.canRaise;
  const list = players();
  els.player.replaceChildren(
    ...[p.icon ? ctx.h('img', { class: 'mc-player-ico', src: p.icon, alt: '' }) : icon('music-notes', { size: 14 }), ctx.h('span', { class: 'mc-player-name' }, p.identity), list.length > 1 ? icon('caret-down', { size: 12 }) : null].filter(Boolean),
  );
  els.player.disabled = list.length < 2;
  els.player.setAttribute('aria-label', list.length > 1 ? `${p.identity} — ${t('mediactl.choose')}` : p.identity);
  if (list.length > 1) els.player.dataset.tip = t('mediactl.choose');
  else delete els.player.dataset.tip;
  els.player.setAttribute('aria-haspopup', list.length > 1 ? 'menu' : 'false');
  const playing = p.status === 'Playing';
  const playLabel = playing ? t('mediactl.pause') : t('mediactl.play');
  els.play.replaceChildren(icon(playing ? 'pause' : 'play', { size: 20, filled: true }));
  els.play.setAttribute('aria-label', playLabel);
  els.play.dataset.tip = playLabel;
  els.play.disabled = !p.canControl || !(playing ? p.canPause : p.canPlay);
  for (const [el, key, can] of [
    [els.prev, 'previous', p.canPrev],
    [els.next, 'next', p.canNext],
  ]) {
    el.setAttribute('aria-label', t(`mediactl.${key}`));
    el.dataset.tip = t(`mediactl.${key}`);
    el.disabled = !p.canControl || !can;
  }
  els.seek.setAttribute('aria-label', t('mediactl.seek'));
  const seekable = !!(p.canSeek && tr.length);
  els.seek.disabled = !seekable;
  card.classList.toggle('noseek', !tr.length);
  updateTime();
  if (playing) tickTimer = setInterval(updateTime, 1000);
}

function updateTime() {
  const p = active();
  if (!p || !visible()) return stopTick();
  const len = p.track?.length || 0;
  const pos = positionOf(p);
  els.at.textContent = fmt(pos);
  els.len.textContent = len ? fmt(len) : '';
  if (!dragging) els.seek.setValue(len ? Math.round((pos / len) * 1000) : 0);
  els.seek.setAttribute('aria-valuetext', len ? ctx.t('mediactl.seekValue', { at: fmt(pos), length: fmt(len) }) : fmt(pos));
}
function stopTick() {
  clearInterval(tickTimer);
  tickTimer = null;
}

// the card is drawn while Réglages rapides is open (its page is kept in the DOM when it closes)
const visible = () => !!card?.isConnected && ctx.quick?.isOpen !== false;

function changed(id) {
  updated(id);
  if (visible()) render();
}

// ---------------------------------------------------------------- mount
export function mount(c) {
  ctx = c;
  ctx.i18n.extend(STRINGS);
  ctx.ui.loadCss('app://shell/core/features/mediactl.css');
  buildCard();
  // the Lecteur; a reloaded shell (crash recovery) first withdraws what its previous page may have left on the bus
  let sent = 'null';
  ctx.api.invoke('mpris:self', null).catch(() => {});
  ctx.shell.on('mediactl:state', (st) => {
    if (!st || typeof st !== 'object') {
      local = null;
      if (sent !== 'null') ctx.api.invoke('mpris:self', null).catch(() => {});
      sent = 'null';
      return changed('selene');
    }
    const now = Date.now();
    const startsPlaying = st.status === 'Playing' && local?.status !== 'Playing';
    local = { ...st, active: true, positionAt: now, activeAt: startsPlaying ? now : local?.activeAt || 0 };
    // the helper signals real changes only (PropertiesChanged): skip updates where only the position moved
    const key = JSON.stringify({ ...st, position: 0 });
    if (key !== sent) {
      sent = key;
      ctx.api.invoke('mpris:self', st).catch(() => {});
    }
    changed('selene');
  });
  ctx.shell.on('mediactl:seeked', (pos) => {
    if (!local) return;
    local = { ...local, position: Number(pos) || 0, positionAt: Date.now() };
    ctx.api.invoke('mpris:seeked', Number(pos) || 0).catch(() => {});
    if (visible()) updateTime();
  });
  ctx.api.on('mpris:call', (call) => call && ctx.shell.emit('mediactl:call', call));
  // the other players
  const setRemote = (list) => {
    const before = new Map(remote.map((p) => [p.name, JSON.stringify(p)]));
    remote = Array.isArray(list) ? list : [];
    for (const p of remote) if (before.get(p.name) !== JSON.stringify(p)) updated(p.name);
    if (visible()) render();
  };
  ctx.api.on('mpris:players', setRemote);
  ctx.api
    .invoke('mpris:players')
    .then(setRemote)
    .catch(() => {});
  ctx.shell.on('media:key', onKey);
  // Réglages rapides puts the card above its tiles (quick.js); it is kept up to date while it is shown
  c.mediaCard = () => {
    render();
    return card;
  };
  c.mediactl = { players, active, key: onKey, control: (id, method, value) => control(players().find((p) => p.id === id), method, value), card, positionOf };
}
