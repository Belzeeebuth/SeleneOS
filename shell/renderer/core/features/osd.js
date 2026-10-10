// On-screen display for volume / brightness (Windows 11 pill above the taskbar).
//   shell.emit('osd', { kind: 'volume' | 'brightness', value: 0-100, muted })
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

const STRINGS = {
  en: { osd: { volume: 'Volume', brightness: 'Brightness', muted: 'Muted' } },
  fr: { osd: { volume: 'Volume', brightness: 'Luminosité', muted: 'Son coupé' } },
};

function volIcon(v, muted) {
  if (muted) return 'speaker_mute';
  if (v === 0) return 'speaker_0';
  return v < 34 ? 'speaker_1' : 'speaker_2';
}

function show({ kind = 'volume', value = 0, muted = false } = {}) {
  const v = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
  const icon = ctx.ui.icon;
  lastOsdAt = Date.now();
  iconEl.replaceChildren(icon(kind === 'brightness' ? 'brightness_high' : volIcon(v, muted), { size: 20 }));
  el.classList.toggle('muted', kind === 'volume' && !!muted);
  bar.style.setProperty('--v', `${v}%`);
  valueEl.textContent = String(v);
  el.setAttribute('aria-label', `${kind === 'brightness' ? ctx.t('osd.brightness') : ctx.t('osd.volume')} ${v}${muted ? ` (${ctx.t('osd.muted')})` : ''}`);
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
  ctx.shell.on('osd', (o) => show(o || {}));
  ctx.shell.on('osd:suppress', (ms) => (suppressUntil = Date.now() + (Number(ms) || 1500)));
  ctx.shell.on('lock', () => (el.hidden = true));
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
  c.osd = { show, hide };
}
