// Tableau de bord (Super+W / the bar's dashboard button when settings.taskbar.showWidgets): a centred overlay of
// cards of different sizes (no clock: the bar has it): the weather with the moon phase of the day (current
// conditions from 'weather:current' at the place chosen for the dynamic wallpaper — main/ipc/weather.js; offline /
// no place: a placeholder with a link), the agenda of the day (apps/calendar/flyout.js), a photo slideshow from
// ~/Pictures, live system usage and quick notes (persisted per user). Escape, a click outside or the close button
// closes it. Shell events: 'widgets:toggle', 'widgets:open', 'widgets:close'.
import { createFlyout } from '../taskbar.js';
import { weatherDescribe, weatherIconName, formatTemperature } from '../wallpaper/weather-text.js';

let ctx;
let fly;
let root;
let timers = [];
let notesSave = null;

const STRINGS = {
  en: {
    widgets: {
      title: 'Dashboard',
      morning: 'Good morning',
      afternoon: 'Good afternoon',
      evening: 'Good evening',
      weather: 'Weather',
      weatherOffline: 'Forecasts need an internet connection.',
      weatherOpen: 'See forecast',
      weatherWhere: '{place} · updated {time}',
      weatherStale: '{place} · last known at {time}',
      weatherNoPlace: 'Choose a location to see the weather here.',
      weatherSetPlace: 'Choose a location',
      notes: 'Quick notes',
      notesPlaceholder: 'Write something down…',
      photos: 'Photos',
      photosEmpty: 'Add pictures to your Pictures folder to see them here.',
      openPictures: 'Open Pictures',
      system: 'System',
      cpu: 'Processor',
      memory: 'Memory',
      uptime: 'Up for {time}',
      saved: 'Saved',
      settings: 'Dashboard settings',
      close: 'Close the dashboard',
      agenda: 'Agenda',
      moon: 'Moon',
      moonLit: '{value}% lit',
      phase0: 'New moon',
      phase1: 'Waxing crescent',
      phase2: 'First quarter',
      phase3: 'Waxing gibbous',
      phase4: 'Full moon',
      phase5: 'Waning gibbous',
      phase6: 'Last quarter',
      phase7: 'Waning crescent',
    },
  },
  fr: {
    widgets: {
      title: 'Tableau de bord',
      morning: 'Bonjour',
      afternoon: 'Bon après-midi',
      evening: 'Bonsoir',
      weather: 'Météo',
      weatherOffline: 'Les prévisions nécessitent une connexion Internet.',
      weatherOpen: 'Voir les prévisions',
      weatherWhere: '{place} · mis à jour à {time}',
      weatherStale: '{place} · dernières données à {time}',
      weatherNoPlace: 'Choisissez un lieu pour voir la météo ici.',
      weatherSetPlace: 'Choisir un lieu',
      notes: 'Notes rapides',
      notesPlaceholder: 'Notez quelque chose…',
      photos: 'Photos',
      photosEmpty: 'Ajoutez des images à votre dossier Images pour les voir ici.',
      openPictures: 'Ouvrir Images',
      system: 'Système',
      cpu: 'Processeur',
      memory: 'Mémoire',
      uptime: 'Allumé depuis {time}',
      saved: 'Enregistré',
      settings: 'Paramètres du tableau de bord',
      close: 'Fermer le tableau de bord',
      agenda: 'Agenda',
      moon: 'Lune',
      moonLit: 'Éclairée à {value} %',
      phase0: 'Nouvelle lune',
      phase1: 'Premier croissant',
      phase2: 'Premier quartier',
      phase3: 'Gibbeuse croissante',
      phase4: 'Pleine lune',
      phase5: 'Gibbeuse décroissante',
      phase6: 'Dernier quartier',
      phase7: 'Dernier croissant',
    },
  },
};

const IMG = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.avif'];

// Moon phase of a day: age in the synodic month (0 = new moon, 0.5 = full moon) and the lit fraction.
const SYNODIC = 29.530588853;
export function moonPhase(date = new Date()) {
  const jd = date.getTime() / 86400000 + 2440587.5;
  const age = ((((jd - 2451550.1) / SYNODIC) % 1) + 1) % 1;
  return { age, lit: (1 - Math.cos(2 * Math.PI * age)) / 2, index: Math.round(age * 8) % 8 };
}

// The moon drawn in the theme colours: an unlit disc (dark, with an outline) and its lit part (terminator as a half
// ellipse). A new moon is the unlit disc alone, never a light one.
function moonSvg(age, size = 64) {
  const r = 28;
  const c = 32;
  const k = Math.cos(2 * Math.PI * age);
  const rx = Math.max(0.01, Math.abs(k) * r).toFixed(2);
  const waxing = age < 0.5;
  const outer = waxing ? 1 : 0;
  const term = waxing ? (k > 0 ? 0 : 1) : k > 0 ? 1 : 0;
  const lit = `M ${c} ${c - r} A ${r} ${r} 0 0 ${outer} ${c} ${c + r} A ${rx} ${r} 0 0 ${term} ${c} ${c - r} Z`;
  const litFrac = (1 - k) / 2;
  const litPath = litFrac < 0.02 ? '' : `<path class="wg-moon-lit" d="${lit}"/>`;
  return `<svg class="wg-moon-svg" viewBox="0 0 64 64" width="${size}" height="${size}" aria-hidden="true"><circle class="wg-moon-dark" cx="${c}" cy="${c}" r="${r}"/>${litPath}</svg>`;
}

function card(cls, title, iconName, ...children) {
  const { h } = ctx;
  return h('section', { class: ['wg-card', cls] }, h('div', { class: 'wg-card-head caption' }, ctx.ui.icon(iconName, { size: 16 }), h('span', null, title)), ...children);
}

function fmtDuration(sec) {
  const d = Math.floor(sec / 86400);
  const hrs = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d ? `${d}${ctx.i18n.lang === 'fr' ? '\u00a0j' : 'd'} ${hrs}\u00a0h` : `${hrs}\u00a0h ${m}\u00a0min`;
}

async function render() {
  const { h, t, i18n, api, shell } = ctx;
  const icon = ctx.ui.icon;
  timers.forEach(clearInterval);
  timers = [];
  if (!fly.isOpen) return;
  const now = new Date();

  // Weather: current conditions (main/ipc/weather.js, place of the dynamic wallpaper); placeholder offline / without a place
  const wxBody = h(
    'div',
    { class: 'wg-weather-body' },
    h('div', { class: 'wg-weather-art' }, icon('cloud-sun', { size: 56, filled: true })),
    h('div', { class: 'caption text-2' }, t('widgets.weatherOffline')),
  );
  let wxAction = () => shell.openUrl('https://wttr.in/');
  const wxBtn = h('button', { class: 'btn small', onclick: () => (fly.close('launch'), wxAction()) }, t('widgets.weatherOpen'));
  const moon = moonPhase(now);
  const moonArt = h('span', { class: 'wg-moon-art' });
  moonArt.innerHTML = moonSvg(moon.age); // numbers only, built above
  const moonBox = h(
    'div',
    { class: 'wg-moon', dataset: { phase: String(moon.index) } },
    moonArt,
    h('div', { class: 'wg-moon-text' }, h('div', { class: 'wg-moon-name' }, t(`widgets.phase${moon.index}`)), h('div', { class: 'wg-moon-pct' }, t('widgets.moonLit', { value: Math.round(moon.lit * 100) }))),
  );
  const weather = card('wg-weather', t('widgets.weather'), 'cloud-sun', h('div', { class: 'wg-weather-row' }, h('div', { class: 'wg-weather-main' }, wxBody, wxBtn), moonBox));
  api.invoke('weather:current').then(
    (w) => {
      if (!w) return;
      const time = i18n.formatTime(new Date(w.fetchedAt || Date.now()), { hour: 'numeric', minute: '2-digit' });
      const place = w.location?.name || '';
      weather.dataset.kind = w.kind || '';
      wxBody.replaceChildren(
        h('div', { class: 'wg-weather-art' }, icon(weatherIconName(w), { size: 56, filled: true })),
        h(
          'div',
          { class: 'wg-weather-now' },
          h('div', { class: 'wg-weather-temp' }, formatTemperature(w, (n) => i18n.formatNumber(n)) || '—'),
          h('div', { class: 'body-strong' }, weatherDescribe(w, i18n.lang)),
          h('div', { class: 'caption text-2 ellipsis' }, t(w.stale ? 'widgets.weatherStale' : 'widgets.weatherWhere', { place, time }).replace(/^ · /, '')),
        ),
      );
      if (place) wxAction = () => shell.openUrl(`https://wttr.in/${encodeURIComponent(place)}`);
    },
    (err) => {
      if (err?.code !== 'ENOLOCATION') return;
      wxBody.lastChild.textContent = t('widgets.weatherNoPlace');
      wxBtn.textContent = t('widgets.weatherSetPlace');
      wxAction = () => shell.launch('settings', { page: 'wallpaperEffects', section: 'location' });
    },
  );

  // Notes
  const status = h('span', { class: 'caption text-2 wg-saved' });
  const notes = h('textarea', { class: 'textarea wg-notes', placeholder: t('widgets.notesPlaceholder'), spellcheck: false });
  api
    .invoke('storage:get', 'shell', 'widget-notes', '')
    .then((v) => {
      if (!notes.value && typeof v === 'string') notes.value = v; // never clobber what the user already typed
    })
    .catch(() => {});
  notes.addEventListener('input', () => {
    clearTimeout(notesSave);
    status.textContent = '';
    notesSave = setTimeout(() => api.invoke('storage:set', 'shell', 'widget-notes', notes.value).then(() => (status.textContent = t('widgets.saved'))).catch(() => {}), 500);
  });
  notes.addEventListener('keydown', (e) => e.key === 'Escape' && notes.blur());
  const notesCard = card('wg-notes-card', t('widgets.notes'), 'note-pencil', notes, status);

  // Photos
  const photoBox = h('div', { class: 'wg-photo' });
  const photosCard = card('wg-photos', t('widgets.photos'), 'images', photoBox);
  (async () => {
    const pics = shell.xdg?.pictures;
    let files = [];
    try {
      if (pics) files = (await api.invoke('fs:list', pics)).filter((e) => !e.dir && IMG.includes((e.ext || '').toLowerCase()));
    } catch {}
    if (!files.length) {
      photoBox.replaceChildren(
        h(
          'div',
          { class: 'wg-photo-empty' },
          icon('images', { size: 32 }),
          h('div', { class: 'caption text-2' }, t('widgets.photosEmpty')),
          pics ? h('button', { class: 'btn small', onclick: () => (fly.close('launch'), shell.launch('files', { path: pics })) }, t('widgets.openPictures')) : null,
        ),
      );
      return;
    }
    let i = 0;
    const show = () => {
      const f = files[i++ % files.length];
      const img = h('img', { src: api.mediaUrl(f.path), alt: f.name, draggable: false, onclick: () => (fly.close('launch'), shell.openFile(f.path)) });
      img.addEventListener('error', () => img.remove()); // unreadable picture: skip it, never pile up
      img.addEventListener('load', () => {
        const old = [...photoBox.querySelectorAll('img')].filter((x) => x !== img);
        img.classList.add('in');
        setTimeout(() => old.forEach((o) => o.remove()), 700);
      });
      photoBox.appendChild(img);
    };
    show();
    if (files.length > 1 && fly.isOpen) timers.push(setInterval(show, 7000));
  })();

  // System usage
  const cpuBar = h('div', { class: 'wg-meter' }, h('div', { class: 'wg-meter-fill' }));
  const memBar = h('div', { class: 'wg-meter' }, h('div', { class: 'wg-meter-fill' }));
  const cpuVal = h('span', { class: 'caption' });
  const memVal = h('span', { class: 'caption' });
  const up = h('div', { class: 'caption text-2' });
  const sysCard = card(
    'wg-sys',
    t('widgets.system'),
    'gauge',
    h('div', { class: 'wg-meter-row' }, h('span', { class: 'grow' }, t('widgets.cpu')), cpuVal),
    cpuBar,
    h('div', { class: 'wg-meter-row' }, h('span', { class: 'grow' }, t('widgets.memory')), memVal),
    memBar,
    up,
  );
  const poll = async () => {
    try {
      const st = await api.invoke('sys:stats');
      const cpu = Math.round(st.cpu || 0);
      const mem = st.mem?.total ? Math.round((st.mem.used / st.mem.total) * 100) : 0;
      cpuBar.firstChild.style.width = `${cpu}%`;
      memBar.firstChild.style.width = `${mem}%`;
      cpuVal.textContent = `${cpu}${i18n.lang === 'fr' ? ' %' : '%'}`;
      memVal.textContent = `${i18n.formatSize(st.mem?.used || 0)} / ${i18n.formatSize(st.mem?.total || 0)}`;
      up.textContent = t('widgets.uptime', { time: fmtDuration(st.uptime || 0) });
    } catch {
      sysCard.hidden = true;
    }
  };
  poll();
  timers.push(setInterval(() => fly.isOpen && poll(), 2000));

  // Agenda of the day, from the Calendar app (optional: the card stays empty if the module is missing)
  const agendaSlot = h('div', { class: 'wg-agenda' });
  const agendaCard = card('wg-agenda-card', t('widgets.agenda'), 'calendar-blank', agendaSlot);
  import('../../apps/calendar/flyout.js')
    .then((m) => fly.isOpen && m?.renderAgenda?.(agendaSlot, { ctx, date: now, close: () => fly.close('launch') }))
    .catch(() => {});

  const dateLine = i18n.formatDate(now, { weekday: 'long', day: 'numeric', month: 'long' });
  root.replaceChildren(
    h(
      'div',
      { class: 'wg-top' },
      h('div', { class: 'wg-title' }, t('widgets.title')),
      h('div', { class: 'wg-today' }, dateLine.charAt(0).toUpperCase() + dateLine.slice(1)),
      h('button', { class: 'wg-icon-btn', 'aria-label': t('widgets.settings'), 'data-tip': t('widgets.settings'), onclick: () => (fly.close('launch'), shell.launch('settings', { page: 'taskbar' })) }, icon('gear-six', { size: 16 })),
      h('button', { class: 'wg-icon-btn wg-close', 'aria-label': t('widgets.close'), 'data-tip': t('widgets.close'), onclick: () => fly.close('button') }, icon('x', { size: 16 })),
    ),
    h('div', { class: 'wg-grid' }, weather, agendaCard, photosCard, sysCard, notesCard),
  );
}

export function mount(c) {
  ctx = c;
  ctx.i18n.extend(STRINGS);
  ctx.ui.loadCss('app://shell/core/features/widgets.css');
  // The board itself takes the focus on open (tabindex -1, no ring): the gear shows a ring only once Tab reaches it.
  root = ctx.h('div', { id: 'widgets-board', class: 'wg', role: 'dialog', tabindex: '-1', 'aria-label': ctx.t('widgets.title') });
  document.getElementById('flyouts').appendChild(root);
  fly = createFlyout({
    id: 'widgets',
    el: root,
    button: '.tb-widgets',
    onOpen: () => render(),
    onClose: () => {
      timers.forEach(clearInterval);
      timers = [];
    },
    focus: () => root,
  });
  ctx.shell.on('widgets:toggle', () => fly.toggle());
  ctx.shell.on('widgets:open', () => fly.open());
  ctx.shell.on('widgets:close', () => fly.close('event'));
  ctx.i18n.on('change', () => fly.isOpen && render());
  c.widgets = {
    open: () => fly.open(),
    close: () => fly.close('api'),
    get isOpen() {
      return fly.isOpen;
    },
  };
}
