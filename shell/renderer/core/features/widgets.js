// Widgets board (Win+W / taskbar Widgets button when settings.taskbar.showWidgets): left-side panel
// with a greeting + clock, a weather card (current conditions from 'weather:current' at the place chosen for the
// dynamic wallpaper — main/ipc/weather.js; offline / no place: a placeholder with a link),
// quick notes (persisted per user), a photo slideshow from ~/Pictures and live system usage.
// Shell events: 'widgets:toggle', 'widgets:open', 'widgets:close'.
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
      title: 'Widgets',
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
      settings: 'Widget settings',
    },
  },
  fr: {
    widgets: {
      title: 'Widgets',
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
      settings: 'Paramètres des widgets',
    },
  },
};

const IMG = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.avif'];

function greeting() {
  const hr = new Date().getHours();
  return ctx.t(hr < 12 ? 'widgets.morning' : hr < 18 ? 'widgets.afternoon' : 'widgets.evening');
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
  let name = shell.env?.user || '';
  try {
    const u = await api.invoke('users:current');
    name = u?.fullName || u?.name || name;
  } catch {
    try {
      const si = await api.invoke('sys:info');
      name = si.fullName || si.user || name;
    } catch {}
  }
  if (!fly.isOpen) return; // closed while we were waiting for the backend
  const first = String(name).split(/\s+/)[0];
  const clockTime = h('div', { class: 'wg-time' });
  const clockDate = h('div', { class: 'wg-date' });
  const tick = () => {
    const now = new Date();
    clockTime.textContent = i18n.formatTime(now, { hour: 'numeric', minute: '2-digit' });
    const d = i18n.formatDate(now, { weekday: 'long', day: 'numeric', month: 'long' });
    clockDate.textContent = d.charAt(0).toUpperCase() + d.slice(1);
  };
  tick();
  timers.push(setInterval(tick, 10000));

  const header = h('div', { class: 'wg-header' }, h('div', null, clockTime, clockDate), h('div', { class: 'wg-greet' }, `${greeting()}${first ? `, ${first}` : ''}`));

  // Weather: current conditions (main/ipc/weather.js, place of the dynamic wallpaper); placeholder offline / without a place
  const wxBody = h(
    'div',
    { class: 'wg-weather-body' },
    h('div', { class: 'wg-weather-art' }, icon('weather_partly_cloudy_day', { size: 56, filled: true })),
    h('div', { class: 'caption text-2' }, t('widgets.weatherOffline')),
  );
  let wxAction = () => shell.openUrl('https://wttr.in/');
  const wxBtn = h('button', { class: 'btn small', onclick: () => (fly.close('launch'), wxAction()) }, t('widgets.weatherOpen'));
  const weather = card('wg-weather', t('widgets.weather'), 'weather_partly_cloudy_day', wxBody, wxBtn);
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
  const notesCard = card('wg-notes-card', t('widgets.notes'), 'note_edit', notes, status);

  // Photos
  const photoBox = h('div', { class: 'wg-photo' });
  const photosCard = card('wg-photos', t('widgets.photos'), 'image_multiple', photoBox);
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
          icon('image_multiple', { size: 32 }),
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
    'data_histogram',
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

  root.replaceChildren(
    h(
      'div',
      { class: 'wg-top' },
      h('div', { class: 'wg-title' }, t('widgets.title')),
      h('button', { class: 'wg-icon-btn', 'aria-label': t('widgets.settings'), 'data-tip': t('widgets.settings'), onclick: () => (fly.close('launch'), shell.launch('settings', { page: 'taskbar' })) }, icon('settings', { size: 16 })),
    ),
    header,
    h('div', { class: 'wg-grid' }, h('div', { class: 'wg-col' }, weather, sysCard), h('div', { class: 'wg-col' }, photosCard, notesCard)),
  );
}

export function mount(c) {
  ctx = c;
  ctx.i18n.extend(STRINGS);
  ctx.ui.loadCss('app://shell/core/features/widgets.css');
  root = ctx.h('div', { id: 'widgets-board', class: 'wg', role: 'dialog', 'aria-label': ctx.t('widgets.title') });
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
    focus: () => root.querySelector('.wg-icon-btn'),
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
