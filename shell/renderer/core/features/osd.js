// Volume / brightness OSD: a slim vertical slab at the right edge (icon, gauge, value with its unit), on
//   shell.emit('osd', { kind: 'volume' | 'brightness', value: 0-100, muted })
//   shell.emit('osd', { kind: 'media', title, artist, player, art (URL | null), status: 'Playing'|'Paused'|'Stopped' })
//   shows the track instead (a wider card at the same place; media keys, features/mediactl.js).
//   Also reacts to audio:changed coming from elsewhere (hardware keys, other apps) unless the change
//   came from the shell's own UI: features emit 'osd:suppress' (ms) while the user drags a slider.
let ctx;
let el;
let bar;
let valueEl;
let iconEl;
let hideTimer = null;
let lastAudio = null;
let lastOsdAt = 0;
let suppressUntil = 0;
let mediaEl = null;
let mediaTimer = null;

const STRINGS = {
  // The value carries its unit the same way as Réglages rapides (quick.batteryChip): "48%" / "48 %".
  en: { osd: { volume: 'Volume', brightness: 'Brightness', muted: 'Muted', value: '{v}%', playing: 'Playing', paused: 'Paused', stopped: 'Stopped', noTitle: 'Unknown title' } },
  fr: { osd: { volume: 'Volume', brightness: 'Luminosité', muted: 'Son coupé', value: '{v} %', playing: 'Lecture', paused: 'En pause', stopped: 'Arrêté', noTitle: 'Titre inconnu' } },
};

function volIcon(v, muted) {
  if (muted) return 'speaker-x';
  if (v === 0) return 'speaker-none';
  return v < 34 ? 'speaker-low' : 'speaker-high';
}

function showMedia({ title, artist, player, art, status } = {}) {
  const { h, t } = ctx;
  const icon = ctx.ui.icon;
  el.hidden = true; // one OSD at a time
  clearTimeout(hideTimer);
  const st = ['Playing', 'Paused', 'Stopped'].includes(status) ? status : 'Stopped';
  const cover = art ? h('img', { class: 'osd-media-art', src: art, alt: '', draggable: false }) : h('span', { class: 'osd-media-art osd-media-noart' }, icon('music-notes', { size: 24 }));
  cover.addEventListener?.('error', () => cover.replaceWith(h('span', { class: 'osd-media-art osd-media-noart' }, icon('music-notes', { size: 24 }))));
  const name = String(title || '') || t('osd.noTitle');
  const sub = [artist, player].filter(Boolean).join(' · ');
  const stateText = t(`osd.${st.toLowerCase()}`);
  mediaEl.replaceChildren(
    cover,
    h('span', { class: 'osd-media-text' }, h('span', { class: 'osd-media-title' }, name), sub ? h('span', { class: 'osd-media-sub' }, sub) : null),
    h('span', { class: 'osd-media-state', 'aria-hidden': 'true' }, icon(st === 'Playing' ? 'play' : st === 'Paused' ? 'pause' : 'stop', { size: 18, filled: true })),
  );
  mediaEl.dataset.status = st;
  mediaEl.setAttribute('aria-label', `${stateText} : ${name}${sub ? ` — ${sub}` : ''}`);
  mediaEl.hidden = false;
  mediaEl.classList.remove('hiding');
  void mediaEl.offsetWidth;
  mediaEl.classList.add('show');
  clearTimeout(mediaTimer);
  mediaTimer = setTimeout(hideMedia, 2500);
}

function hideMedia() {
  if (!mediaEl || mediaEl.hidden) return;
  mediaEl.classList.add('hiding');
  mediaEl.classList.remove('show');
  mediaTimer = setTimeout(() => {
    mediaEl.hidden = true;
    mediaEl.classList.remove('hiding');
  }, 220);
}

function show({ kind = 'volume', value = 0, muted = false, ...rest } = {}) {
  if (kind === 'media') return showMedia(rest);
  if (mediaEl && !mediaEl.hidden) mediaEl.hidden = true;
  const v = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
  const icon = ctx.ui.icon;
  lastOsdAt = Date.now();
  iconEl.replaceChildren(icon(kind === 'brightness' ? 'sun' : volIcon(v, muted), { size: 20 }));
  el.classList.toggle('muted', kind === 'volume' && !!muted);
  bar.style.setProperty('--v', `${v}%`);
  const shown = ctx.t('osd.value', { v });
  valueEl.textContent = shown;
  el.setAttribute('aria-label', `${kind === 'brightness' ? ctx.t('osd.brightness') : ctx.t('osd.volume')} ${shown}${muted ? ` (${ctx.t('osd.muted')})` : ''}`);
  el.hidden = false;
  el.classList.remove('hiding');
  void el.offsetWidth;
  el.classList.add('show');
  clearTimeout(hideTimer);
  hideTimer = setTimeout(hide, 1800);
}

function hide() {
  el.classList.add('hiding');
  el.classList.remove('show');
  hideTimer = setTimeout(() => {
    el.hidden = true;
    el.classList.remove('hiding');
  }, 220);
}

export function mount(c) {
  ctx = c;
  ctx.i18n.extend(STRINGS);
  ctx.ui.loadCss('app://shell/core/features/osd.css');
  const { h } = ctx;
  iconEl = h('span', { class: 'osd-icon' });
  bar = h('div', { class: 'osd-bar' }, h('div', { class: 'osd-fill' }));
  valueEl = h('span', { class: 'osd-value' });
  el = h('div', { id: 'osd', class: 'osd', role: 'status', 'aria-live': 'polite', hidden: true, onpointerenter: () => clearTimeout(hideTimer), onpointerleave: () => (hideTimer = setTimeout(hide, 1200)) }, iconEl, bar, valueEl);
  document.getElementById('overlays').appendChild(el);
  mediaEl = h('div', { id: 'osd-media', class: 'osd osd-media', role: 'status', 'aria-live': 'polite', hidden: true, onpointerenter: () => clearTimeout(mediaTimer), onpointerleave: () => (mediaTimer = setTimeout(hideMedia, 1200)) });
  document.getElementById('overlays').appendChild(mediaEl);
  ctx.shell.on('osd', (o) => show(o || {}));
  ctx.shell.on('osd:suppress', (ms) => (suppressUntil = Date.now() + (Number(ms) || 1500)));
  ctx.shell.on('lock', () => (el.hidden = true));
  // Opening Start / a flyout moves on from the volume change: don't leave the pill floating over it.
  ctx.shell.on('flyouts:close', () => {
    if (!el.hidden && !el.classList.contains('hiding')) hide();
    hideMedia();
  });
  ctx.api
    .invoke('audio:status')
    .then((st) => (lastAudio = st ? { volume: st.volume, muted: st.muted } : null))
    .catch(() => {});
  ctx.api.on('audio:changed', (st) => {
    if (!st) return;
    const prev = lastAudio;
    lastAudio = { volume: st.volume, muted: st.muted };
    if (!prev || (prev.volume === st.volume && prev.muted === st.muted)) return;
    const now = Date.now();
    if (now < suppressUntil || now - lastOsdAt < 700) return; // our own UI or the hotkey handler already showed it
    if (ctx.quick?.isOpen) return; // the user is looking at the quick settings slider
    show({ kind: 'volume', value: st.volume, muted: st.muted });
  });
  c.osd = { show, hide, hideMedia };
}
