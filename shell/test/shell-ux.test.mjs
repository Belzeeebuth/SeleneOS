// Desktop shell UX test: taskbar, Start, search, quick settings, calendar + notification center,
// OSD, widgets, desktop icons, theme switching — in light/dark and English/French.
//
//   cd aurora-os/shell && xvfb-run -a -s "-screen 0 1600x900x24" node test/shell-ux.test.mjs
//   options: --quick (one locale/theme)  --unit (unit checks only)  --docs (copy the best screenshots to docs/screenshots)
//
// The system backends (net:*, audio:*, display:*, power:battery) belong to another area; when they
// are missing (or to get deterministic screenshots) the test installs a realistic in-renderer mock
// of those channels (see installMock). Screenshots land in test/out/ux-*.png.
import fs from 'node:fs';
import path from 'node:path';
import { launchShell, OUT } from './lib.mjs';

const QUICK = process.argv.includes('--quick');
const UNIT_ONLY = process.argv.includes('--unit');
const DOCS = process.argv.includes('--docs');
const DOCS_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'docs', 'screenshots');

let failures = 0;
let passes = 0;
function check(cond, msg) {
  if (cond) passes++;
  else {
    failures++;
    console.log(`  ✗ ${msg}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Errors that come from this area's files (other agents' apps may log their own 404s while they work).
const MINE = /core\/(taskbar|start|desktop|notify|theme)\.js|features\/(quick|calendar|search|osd|widgets)\.(js|css)|shell\.css|wallpapers\//;
function myErrors(s) {
  return s.logs.filter((l) => (l.startsWith('[pageerror]') || l.startsWith('[error]')) && (MINE.test(l) || l.startsWith('[pageerror]')));
}

async function shot(s, name, docName) {
  const file = await s.shot(`ux-${name}`);
  if (DOCS && docName) {
    fs.mkdirSync(DOCS_DIR, { recursive: true });
    fs.copyFileSync(file, path.join(DOCS_DIR, `${docName}.png`));
  }
  return file;
}

// Realistic mock of the system channels (shapes = the backend contract).
async function installMock(s) {
  await s.aurora(async () => {
    const { api } = await import('app://shell/core/api.js');
    if (api.__mocked) return;
    api.__mocked = true;
    const orig = api.invoke;
    const st = {
      net: {
        connectivity: 'full',
        wifiEnabled: true,
        airplane: false,
        primary: { type: 'wifi', name: 'Aurora-5G', strength: 82 },
        devices: [
          { device: 'wlp2s0', type: 'wifi', state: 'connected', connection: 'Aurora-5G' },
          { device: 'enp0s3', type: 'ethernet', state: 'unavailable', connection: '' },
        ],
      },
      wifi: [
        { ssid: 'Aurora-5G', signal: 82, security: 'WPA2', active: true, saved: true },
        { ssid: 'Livebox-8F21', signal: 64, security: 'WPA2', active: false, saved: false },
        { ssid: 'Café du Coin', signal: 41, security: '', active: false, saved: false },
        { ssid: 'FreeWifi_secure', signal: 30, security: 'WPA2 802.1X', active: false, saved: false },
        { ssid: 'DIRECT-7B-HP OfficeJet', signal: 18, security: 'WPA2', active: false, saved: false },
      ],
      audio: {
        volume: 64,
        muted: false,
        outputs: [
          { id: 'spk', name: 'Speakers (Built-in Audio)', default: true },
          { id: 'hdmi', name: 'HDMI / DisplayPort', default: false },
          { id: 'usb', name: 'USB Headset', default: false },
        ],
        inputs: [{ id: 'mic', name: 'Microphone', default: true }],
        inputVolume: 70,
        inputMuted: false,
      },
      display: { outputs: [{ name: 'Virtual-1', primary: true, width: 1600, height: 900, rate: 60, modes: [] }], brightness: 70 },
      battery: { percent: 76, charging: false, timeLeftMin: 187 },
      calls: [],
    };
    window.__mockState = st;
    const H = {
      'net:status': () => st.net,
      'net:wifiList': () => st.wifi,
      'net:wifiConnect': async (ssid, pw) => {
        await new Promise((r) => setTimeout(r, 300));
        const n = st.wifi.find((x) => x.ssid === ssid);
        if (!n) throw Object.assign(new Error('No network with SSID'), { code: 'ENOTFOUND' });
        if (n.security && !n.saved && pw !== 'password123') throw Object.assign(new Error('Secrets were required, but not provided'), { code: 'EAUTH' });
        st.wifi.forEach((x) => (x.active = x.ssid === ssid));
        n.saved = true;
        st.net.primary = { type: 'wifi', name: ssid, strength: n.signal };
        return true;
      },
      'net:wifiDisconnect': () => {
        st.wifi.forEach((x) => (x.active = false));
        st.net.primary = { type: null };
        st.net.connectivity = 'none';
        return true;
      },
      'net:setWifi': (v) => ((st.net.wifiEnabled = v), true),
      'net:setAirplane': (v) => ((st.net.airplane = v), true),
      'audio:status': () => st.audio,
      'audio:setVolume': (v) => ((st.audio.volume = v), true),
      'audio:setMuted': (v) => ((st.audio.muted = v), true),
      'audio:setOutput': (id) => (st.audio.outputs.forEach((o) => (o.default = o.id === id)), true),
      'display:status': () => st.display,
      'display:setBrightness': (v) => ((st.display.brightness = v), true),
      'power:battery': () => st.battery,
    };
    api.invoke = async (ch, ...a) => {
      if (H[ch]) {
        st.calls.push([ch, ...a]);
        return JSON.parse(JSON.stringify(await H[ch](...a)));
      }
      return orig(ch, ...a);
    };
    await window.__aurora.taskbar.refresh();
  });
}

const flyState = (s) =>
  s.aurora(() => ({
    start: document.getElementById('start').classList.contains('open'),
    search: !!document.getElementById('search-panel')?.classList.contains('open'),
    quick: !!document.getElementById('quick-settings')?.classList.contains('open'),
    calendar: !!document.getElementById('calendar-center')?.classList.contains('open'),
    widgets: !!document.getElementById('widgets-board')?.classList.contains('open'),
  }));
const openCount = (st) => Object.values(st).filter(Boolean).length;
// docs/screenshots names: the light/English run gets the plain name, the others a suffix.
const docName = (base, tag) => (tag === 'light-en' ? base : `${base}-${tag}`);

function seedHome(home) {
  fs.mkdirSync(path.join(home, 'Desktop', 'Projects'), { recursive: true });
  for (const n of ['Budget 2026.xlsx', 'Meeting notes.txt', 'Report.pdf', 'Holiday playlist.mp3']) fs.writeFileSync(path.join(home, 'Desktop', n), 'x');
  for (const n of ['Project plan.docx', 'Quarterly review.pptx', 'Invoice 0425.pdf', 'Recipes.txt']) fs.writeFileSync(path.join(home, 'Documents', n), 'x');
  const wp = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'renderer', 'assets', 'wallpapers');
  fs.copyFileSync(path.join(wp, 'dunes.jpg'), path.join(home, 'Desktop', 'Dunes.jpg'));
  fs.copyFileSync(path.join(wp, 'aurora.jpg'), path.join(home, 'Pictures', 'Northern lights.jpg'));
  fs.copyFileSync(path.join(wp, 'glow-light.jpg'), path.join(home, 'Pictures', 'Glow.jpg'));
}

// ------------------------------------------------------------------------------------------ units
async function unitTests() {
  console.log('• unit checks (theme, search, calendar, notifications)');
  const s = await launchShell({ lang: 'en', theme: 'light' });
  try {
    const r = await s.aurora(async () => {
      const th = await import('app://shell/core/theme.js');
      const st = await import('app://shell/core/start.js');
      const out = {};
      const dark = th.accentVars('#0078d4', 'dark');
      const light = th.accentVars('#0078d4', 'light');
      out.accentDarkHasOnAccent = dark['--on-accent'] === '#000000';
      out.accentLightOnAccent = light['--on-accent'] === '#ffffff';
      out.accentFallback = th.accentVars('not-a-colour', 'light')['--accent-base'] === '#0078d4';
      out.wpLight = th.resolveWallpaper('builtin:bloom', 'light').endsWith('bloom-light.jpg');
      out.wpDark = th.resolveWallpaper('builtin:bloom', 'dark').endsWith('bloom-dark.jpg');
      out.wpUnknown = th.resolveWallpaper('builtin:nope', 'light').endsWith('bloom-light.jpg');
      out.allWallpapers = await Promise.all(th.WALLPAPERS.flatMap((w) => [w.light, w.dark]).map((f) => fetch(`app://shell/assets/wallpapers/${f}`).then((x) => x.ok)));
      const sets = st.search.settings('wifi');
      out.settingsWifi = sets[0]?.page === 'wifi';
      out.settingsDark = st.search.settings('dark mode').some((x) => x.page === 'colors');
      out.settingsAccents = st.search.settings('resolution')[0]?.page === 'display';
      out.webUrl = st.search.webUrl('a b').endsWith('a%20b');
      out.fileTint = [st.fileTint({ ext: '.pdf' }), st.fileTint({ ext: '.xlsx' }), st.fileTint({ dir: true })].join(',');
      const { notify, notifications } = window.__aurora;
      notifications.clear();
      notify({ appId: 'winver', title: 'A', silent: true, timeout: 1 });
      notify({ appId: 'system', title: 'B', silent: true, timeout: 1 });
      notify({ appId: 'winver', title: 'C', silent: true, timeout: 1 });
      const g = notifications.groups();
      out.groups = g.map((x) => `${x.appId}:${x.items.length}`).join(',');
      out.unread = notifications.unread();
      notifications.clearApp('winver');
      out.afterClearApp = notifications.list().length;
      notifications.markAllRead();
      out.unreadAfter = notifications.unread();
      notifications.clear();
      return out;
    });
    check(r.accentDarkHasOnAccent && r.accentLightOnAccent, 'accentVars gives on-accent colours per mode');
    check(r.accentFallback, 'accentVars falls back to the default accent for invalid colours');
    check(r.wpLight && r.wpDark && r.wpUnknown, 'resolveWallpaper picks light/dark variants and falls back to bloom');
    check(r.allWallpapers.every(Boolean), `every built-in wallpaper is served (${r.allWallpapers.join(',')})`);
    check(r.settingsWifi && r.settingsDark && r.settingsAccents, 'settings search index finds Wi-Fi, dark mode, resolution');
    check(r.webUrl, 'web search URL is encoded');
    check(r.fileTint === 'pdf,xls,dir', `file type tints (${r.fileTint})`);
    check(r.groups === 'winver:2,system:1', `notifications grouped by app, newest group first (${r.groups})`);
    check(r.unread === 3 && r.afterClearApp === 1 && r.unreadAfter === 0, 'unread count, clearApp, markAllRead');
    // wallpaper files: size + dimensions
    const wpDir = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'renderer', 'assets', 'wallpapers');
    for (const f of fs.readdirSync(wpDir).filter((x) => x.endsWith('.jpg'))) {
      const buf = fs.readFileSync(path.join(wpDir, f));
      check(buf.length < 700 * 1024, `${f} is under 700 KB (${Math.round(buf.length / 1024)} KB)`);
      // JPEG SOF0/SOF2 marker -> dimensions
      let i = 2;
      let dims = null;
      while (i < buf.length) {
        if (buf[i] !== 0xff) break;
        const m = buf[i + 1];
        const len = buf.readUInt16BE(i + 2);
        if (m === 0xc0 || m === 0xc2) {
          dims = [buf.readUInt16BE(i + 7), buf.readUInt16BE(i + 5)];
          break;
        }
        i += 2 + len;
      }
      check(dims && dims[0] === 2560 && dims[1] === 1600, `${f} is 2560x1600 (${dims})`);
    }
    // French calendar starts on Monday
    await s.aurora(() => window.__aurora.settings.set('lang', 'fr'));
    await sleep(300);
    await s.aurora(() => window.__aurora.calendar.open());
    await sleep(500);
    const wk = await s.aurora(() => [...document.querySelectorAll('.cal-weekdays span')].map((x) => x.textContent));
    check(wk[0] === 'lu' && wk[6] === 'di', `French calendar weeks start on Monday (${wk.join(' ')})`);
    await s.aurora(() => window.__aurora.settings.set('lang', 'en'));
    await sleep(300);
    const wk2 = await s.aurora(() => [...document.querySelectorAll('.cal-weekdays span')].map((x) => x.textContent));
    check(wk2[0] === 'Su', `English calendar weeks start on Sunday (${wk2.join(' ')})`);
    // Every string used by this area exists in English and French.
    const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'renderer', 'core');
    const files = ['taskbar.js', 'start.js', 'desktop.js', 'notify.js', 'features/quick.js', 'features/calendar.js', 'features/search.js', 'features/osd.js', 'features/widgets.js'];
    const keys = new Set();
    for (const f of files) {
      const src = fs.readFileSync(path.join(root, f), 'utf8');
      for (const m of src.matchAll(/\bt\('([a-zA-Z0-9_.]+)'/g)) keys.add(m[1]);
    }
    for (const c of ['all', 'apps', 'documents', 'settings', 'web', 'bestMatch']) keys.add(`search.${c}`);
    const missing = await s.aurora(async (list) => {
      const { i18n } = window.__aurora;
      const out = [];
      for (const lang of ['en', 'fr']) {
        i18n.setLang(lang);
        for (const k of list) {
          const v = i18n.t(k, { count: 2, q: 'x', app: 'x', name: 'x', value: 1, percent: 1, time: 'x', n: 1, h: 1, m: 1, letter: 'A', msg: 'x', user: 'x' });
          if (v === k) out.push(`${lang}:${k}`);
        }
      }
      i18n.setLang('en');
      return out;
    }, [...keys]);
    check(missing.length === 0, `all ${keys.size} UI strings exist in EN and FR${missing.length ? ` (missing: ${missing.join(', ')})` : ''}`);
    const frSame = await s.aurora(async () => {
      const { i18n } = window.__aurora;
      const keys = ['quick.nightLight', 'cal.clearAll', 'search.bestMatch', 'start.searchPlaceholder', 'desktop.sortBy', 'widgets.notes'];
      i18n.setLang('en');
      const en = keys.map((k) => i18n.t(k));
      i18n.setLang('fr');
      const fr = keys.map((k) => i18n.t(k));
      i18n.setLang('en');
      return keys.filter((k, i) => en[i] === fr[i]);
    });
    check(frSame.length === 0, `French strings are actually translated (${frSame.join(', ')})`);
    check(myErrors(s).length === 0, `no renderer errors (unit) ${myErrors(s).join(' | ')}`);
  } finally {
    await s.close();
  }
}

// ------------------------------------------------------------------------------------------ scenario
async function scenario(theme, lang) {
  const tag = `${theme}-${lang}`;
  console.log(`• scenario ${tag}`);
  const s = await launchShell({ theme, lang, settings: { theme, lang, taskbar: { showWidgets: true } } });
  const P = s.page;
  try {
    seedHome(s.home);
    await installMock(s);
    await s.aurora(() => window.__aurora.desktop.refresh());
    await sleep(900);
    await shot(s, `desktop-${tag}`, docName('shell-desktop', tag));

    // ---- tray reflects backend status
    const tray = await s.aurora(() => ({
      net: !document.querySelector('.tb-net').hidden,
      vol: !document.querySelector('.tb-vol').hidden,
      bat: !document.querySelector('.tb-bat').hidden,
      tip: document.querySelector('.tb-vol').dataset.tip,
      clock: document.querySelector('.tb-time').textContent,
    }));
    check(tray.net && tray.vol && tray.bat, `[${tag}] tray shows network, volume and battery`);
    check(lang === 'fr' ? /\d{2}:\d{2}/.test(tray.clock) : /(AM|PM)/.test(tray.clock), `[${tag}] clock is locale aware (${tray.clock})`);
    // volume wheel
    await P.hover('.tb-vol');
    await P.mouse.wheel(0, -100);
    await sleep(500);
    const vol = await s.aurora(() => window.__mockState.audio.volume);
    check(vol === 66, `[${tag}] mouse wheel over the volume icon raises the volume (${vol})`);
    const osdShown = await s.aurora(() => !document.getElementById('osd').hidden);
    check(osdShown, `[${tag}] wheel shows the volume OSD`);
    if (theme === 'light' && lang === 'en') await shot(s, `osd-${tag}`, 'shell-osd');
    await P.mouse.move(800, 400);

    // ---- Start
    await P.click('.tb-start');
    await sleep(700);
    let st = await flyState(s);
    check(st.start && openCount(st) === 1, `[${tag}] Start opens alone`);
    check(await s.aurora(() => document.activeElement?.classList.contains('start-search')), `[${tag}] Start focuses its search box`);
    check(await s.aurora(() => document.querySelector('.tb-start').classList.contains('open')), `[${tag}] Start button shows its active state`);
    await shot(s, `start-${tag}`, `shell-start-${tag}`);
    if (tag === 'light-en') await shot(s, `start-${tag}`, 'shell-start');
    // keyboard: arrow into grid, Enter launches
    await P.keyboard.press('ArrowDown');
    check(await s.aurora(() => document.activeElement?.classList.contains('start-tile')), `[${tag}] ArrowDown moves into the pinned grid`);
    await P.keyboard.press('ArrowRight');
    check(await s.aurora(() => document.activeElement === document.querySelectorAll('.start-tile')[1]), `[${tag}] ArrowRight moves to the next tile`);
    // drag a pinned tile to reorder; drop one on the taskbar to pin it
    const pin0 = await s.aurora(() => [...document.querySelectorAll('.start-tile')].map((x) => x.dataset.app));
    await P.dragAndDrop('.start-tile:nth-child(1)', '.start-tile:nth-child(3)');
    await sleep(500);
    const pin1 = await s.aurora(() => [...document.querySelectorAll('.start-tile')].map((x) => x.dataset.app));
    check(pin1[2] === pin0[0] && pin1[0] === pin0[1], `[${tag}] dragging a pinned tile reorders Start (${pin0.slice(0, 3)} → ${pin1.slice(0, 3)})`);
    const lastTile = pin1[pin1.length - 1];
    await P.dragAndDrop(`.start-tile[data-app="${lastTile}"]`, '#taskbar .tb-apps');
    await sleep(500);
    check(await s.aurora((id) => window.__aurora.settings.get('pinned').includes(id), lastTile), `[${tag}] dropping a Start tile on the taskbar pins it (${lastTile})`);
    // All apps + jump list
    await P.click('.start-view-pinned .start-head-btn');
    await sleep(600);
    check(await s.aurora(() => !!document.querySelector('.start-view-all:not(.leaving) .start-letter')), `[${tag}] All apps shows letter headers`);
    if (theme === 'light' && lang === 'en') await shot(s, `start-all-${tag}`, 'shell-start-allapps');
    await P.click('.start-view-all .start-letter');
    await sleep(400);
    check(await s.aurora(() => !document.querySelector('.start-jump').hidden), `[${tag}] letter opens the jump grid`);
    await P.keyboard.press('Escape');
    await sleep(200);
    st = await flyState(s);
    check(st.start, `[${tag}] Esc closes the jump grid first`);
    // inline search
    await P.click('.start-search');
    await P.keyboard.type(lang === 'fr' ? 'son' : 'sound');
    await sleep(900);
    const startRes = await s.aurora(() => [...document.querySelectorAll('.start-view-search .sv-row')].map((r) => r.textContent));
    check(startRes.some((x) => /Son|Sound/.test(x)), `[${tag}] Start search finds the Sound settings page`);
    if (lang === 'en' && theme === 'dark') await shot(s, `start-search-${tag}`, 'shell-start-search');
    await P.keyboard.press('Escape');
    await sleep(300);
    st = await flyState(s);
    check(!st.start, `[${tag}] Esc closes Start`);
    // outside click
    await P.click('.tb-start');
    await sleep(500);
    await P.mouse.click(1300, 200);
    await sleep(400);
    check(!(await flyState(s)).start, `[${tag}] clicking outside closes Start`);
    // power + user menus exist and are localized
    await P.click('.tb-start');
    await sleep(500);
    await P.click('.start-power');
    await sleep(300);
    const power = await s.aurora(() => [...document.querySelectorAll('.menu .menu-item .label')].map((x) => x.textContent));
    check(power.length === 4, `[${tag}] power menu has Lock/Sleep/Shut down/Restart (${power.join(', ')})`);
    await P.keyboard.press('Escape');
    await P.keyboard.press('Escape');
    await sleep(300);

    // ---- mutual exclusion through the event bus
    await s.aurora(() => window.__aurora.shell.emit('start:toggle'));
    await sleep(300);
    await s.aurora(() => window.__aurora.shell.emit('quick:toggle'));
    await sleep(500);
    st = await flyState(s);
    check(st.quick && !st.start && openCount(st) === 1, `[${tag}] opening quick settings closes Start`);
    await s.aurora(() => window.__aurora.shell.emit('flyouts:close'));
    await sleep(400);
    check(openCount(await flyState(s)) === 0, `[${tag}] 'flyouts:close' closes everything`);

    // ---- Search
    await s.aurora(() => window.__aurora.shell.emit('search:open', { query: 'pro' }));
    await sleep(1300);
    const srch = await s.aurora(() => ({
      open: document.getElementById('search-panel').classList.contains('open'),
      value: document.querySelector('.sp-input').value,
      rows: [...document.querySelectorAll('#search-panel .sv-row')].map((r) => r.textContent),
      preview: !!document.querySelector('#search-panel .sv-pv'),
    }));
    check(srch.open && srch.value === 'pro', `[${tag}] search:open {query} opens with the query`);
    check(srch.rows.some((x) => x.includes('Project plan.docx')), `[${tag}] file search finds ~/Documents/Project plan.docx`);
    check(srch.preview, `[${tag}] preview pane shows the selected result`);
    await P.keyboard.press('ArrowDown');
    await sleep(200);
    await shot(s, `search-${tag}`, docName('shell-search', tag));
    // categories
    await P.click('#search-panel .sv-tab:nth-child(4)');
    await sleep(300);
    check(await s.aurora(() => document.querySelector('#search-panel .sv-tab.selected')?.textContent === window.__aurora.t('search.settings')), `[${tag}] category pivot switches to Settings`);
    await P.keyboard.press('Escape');
    await sleep(300);
    await P.click('.tb-search');
    await sleep(600);
    if (theme === 'light' && lang === 'en') await shot(s, `search-home-${tag}`, 'shell-search-home');
    await P.keyboard.press('Escape');
    await sleep(300);

    // ---- Quick settings
    await P.click('.tb-quick');
    await sleep(700);
    const qs = await s.aurora(() => ({
      tiles: [...document.querySelectorAll('.qs-tile')].map((x) => x.dataset.key),
      bright: !!document.querySelector('[data-key="brightness"]'),
      vol: !!document.querySelector('[data-key="volume"]'),
      battery: !!document.querySelector('.qs-battery'),
    }));
    check(['wifi', 'airplane', 'nightLight', 'darkMode', 'dnd', 'accessibility'].every((k) => qs.tiles.includes(k)), `[${tag}] quick settings tiles (${qs.tiles.join(',')})`);
    check(qs.bright && qs.vol && qs.battery, `[${tag}] brightness + volume sliders and battery`);
    await shot(s, `quick-${tag}`, docName('shell-quick-settings', tag));
    // DND tile toggles the setting
    await P.click('[data-key="dnd"] .qs-tile-main');
    await sleep(300);
    check(await s.aurora(() => window.__aurora.settings.get('notifications.dnd') === true), `[${tag}] DND tile turns on Do not disturb`);
    await P.click('[data-key="dnd"] .qs-tile-main');
    await sleep(300);
    // Wi-Fi page + password flow
    await P.click('[data-key="wifi"] .qs-tile-more');
    await sleep(800);
    check(await s.aurora(() => document.querySelectorAll('.qs-net').length === 5), `[${tag}] Wi-Fi page lists networks`);
    await P.click('.qs-net:nth-child(2) .qs-net-head');
    await sleep(250);
    await P.click('.qs-net.expanded .btn.primary');
    await sleep(250);
    await P.fill('.qs-pw input', 'wrong');
    await P.keyboard.press('Enter');
    await sleep(700);
    check(await s.aurora(() => !!document.querySelector('.qs-net.expanded .qs-error')), `[${tag}] wrong Wi-Fi key shows an error`);
    await P.fill('.qs-pw input', 'password123');
    if (theme === 'dark' && lang === 'en') await shot(s, `quick-wifi-pw-${tag}`, 'shell-quick-wifi-password');
    await P.keyboard.press('Enter');
    await sleep(1000);
    const active = await s.aurora(() => document.querySelector('.qs-net.active .qs-net-head')?.textContent || '');
    check(active.includes('Livebox-8F21'), `[${tag}] connecting with the right key makes it active (${active})`);
    if (theme === 'dark' && lang === 'en') await shot(s, `quick-wifi-${tag}`, 'shell-quick-wifi');
    await P.keyboard.press('Escape'); // back to the main page
    await sleep(500);
    check(await s.aurora(() => !!document.querySelector('.qs-main:not(.leaving)')), `[${tag}] Esc on a sub-page returns to the main page`);
    await P.click('.qs-slider-more');
    await sleep(600);
    await P.click('.qs-out:nth-child(3)');
    await sleep(400);
    check(await s.aurora(() => window.__mockState.audio.outputs.find((o) => o.default)?.id === 'usb'), `[${tag}] output picker switches the default sink`);
    if (theme === 'light' && lang === 'fr') await shot(s, `quick-audio-${tag}`, 'shell-quick-audio-fr');
    await P.keyboard.press('Escape');
    await sleep(400);
    await P.keyboard.press('Escape');
    await sleep(300);
    check(!(await flyState(s)).quick, `[${tag}] second Esc closes quick settings`);

    // ---- Toast
    if (tag === 'light-en' || tag === 'dark-fr') {
      await s.aurora((fr) => {
        window.__aurora.notify({
          appId: 'winver',
          title: fr ? 'Capture d’écran enregistrée' : 'Screenshot saved',
          body: fr ? 'Votre capture a été enregistrée dans Images.' : 'Your screenshot was saved to Pictures.',
          silent: true,
          timeout: 4000,
          actions: [{ label: fr ? 'Ouvrir' : 'Open' }, { label: fr ? 'Ignorer' : 'Dismiss' }],
        });
      }, lang === 'fr');
      await sleep(700);
      await shot(s, `toast-${tag}`, docName('shell-toast', tag));
      await s.aurora(() => window.__aurora.notifications.clear());
      await sleep(400);
    }

    // ---- Notifications + calendar
    await s.aurora(() => {
      const { notify } = window.__aurora;
      notify({ appId: 'winver', title: 'Aurora OS is up to date', body: 'You have the latest features and security fixes.', silent: true, timeout: 1 });
      notify({ appId: 'system', title: 'Low disk space', body: 'Free up space on “Local Disk (/)”.', silent: true, timeout: 1, actions: [{ label: 'Open Storage' }, { label: 'Dismiss' }] });
      notify({ appId: 'winver', title: 'Welcome to Aurora', body: 'Press the Start button to begin.', silent: true, timeout: 1 });
    });
    await sleep(500);
    const badge = await s.aurora(() => document.querySelector('.tb-count')?.textContent);
    check(badge === '3', `[${tag}] taskbar shows the unread badge (${badge})`);
    await P.click('.tb-clock');
    await sleep(900);
    const cal = await s.aurora(() => ({
      groups: document.querySelectorAll('.nc-group').length,
      items: document.querySelectorAll('.nc-item').length,
      today: document.querySelector('.cal-day.today')?.textContent,
    }));
    check(cal.groups === 2 && cal.items === 3, `[${tag}] notification center groups by app (${cal.groups} groups, ${cal.items} items)`);
    check(cal.today === String(new Date().getDate()), `[${tag}] today is highlighted`);
    await shot(s, `calendar-${tag}`, docName('shell-calendar', tag));
    check(await s.aurora(() => window.__aurora.notifications.unread() === 0), `[${tag}] opening the center marks notifications read`);
    const m0 = await s.aurora(() => document.querySelector('.cal-month').textContent);
    await P.click('.cal-nav .cal-icon-btn:last-child');
    await sleep(400);
    const m1 = await s.aurora(() => document.querySelector('.cal-month').textContent);
    check(m0 !== m1, `[${tag}] month navigation (${m0} → ${m1})`);
    await P.hover('.nc-item');
    await P.click('.nc-item .nc-item-x');
    await sleep(500);
    check(await s.aurora(() => document.querySelectorAll('.nc-item').length === 2), `[${tag}] dismiss removes one notification`);
    await P.click('.nc-clear');
    await sleep(700);
    check(await s.aurora(() => !!document.querySelector('.nc-empty')), `[${tag}] Clear all shows the empty state`);
    await P.click('.cal-collapse');
    await sleep(400);
    check(await s.aurora(() => document.querySelector('.cal-card').classList.contains('collapsed')), `[${tag}] calendar collapses`);
    await P.click('.cal-collapse');
    await sleep(300);
    await P.keyboard.press('Escape');
    await sleep(300);

    // ---- Widgets
    await P.click('.tb-widgets');
    await sleep(1300);
    check((await flyState(s)).widgets, `[${tag}] widgets board opens`);
    check(await s.aurora(() => document.querySelectorAll('.wg-photo img').length >= 1), `[${tag}] widgets show photos from ~/Pictures`);
    if (lang === 'en') await shot(s, `widgets-${tag}`, `shell-widgets-${theme}`);
    await P.keyboard.press('Escape');
    await sleep(300);

    // ---- Taskbar: windows, picker, progress, flash, jump list
    const apps = await s.aurora(() => {
      const { wm, registry } = window.__aurora;
      const make = (appId, title, opts = {}) => wm.create({ appId, title, icon: registry.iconUrl(appId), width: 520, height: 340, ...opts });
      const a = make('winver', 'About Aurora — 1');
      const b = make('winver', 'About Aurora — 2');
      make('winver', 'About Aurora — 3');
      const c = make('explorer-test', 'Downloads');
      c.setProgress(0.6);
      const d = make('mail-test', 'Inbox');
      a.focus();
      d.flash();
      b.focus();
      return wm.list().length;
    });
    await sleep(600);
    check(apps >= 5, `[${tag}] created test windows (${apps})`);
    const tb = await s.aurora(() => {
      const w = document.querySelector('.tb-app[data-app="winver"]');
      return {
        running: w?.classList.contains('running'),
        active: w?.classList.contains('active'),
        progress: document.querySelector('.tb-app[data-app="explorer-test"]')?.classList.contains('has-progress'),
        flash: document.querySelector('.tb-app[data-app="mail-test"]')?.classList.contains('flashing'),
      };
    });
    check(tb.running && tb.active, `[${tag}] running + active indicator`);
    check(tb.progress, `[${tag}] taskbar progress bar from win.setProgress`);
    check(tb.flash, `[${tag}] attention flashing from win.flash`);
    await P.click('.tb-app[data-app="winver"]');
    await sleep(700);
    const picker = await s.aurora(() => document.querySelectorAll('.tb-preview .tb-pv-item').length);
    check(picker === 3, `[${tag}] clicking an app with 3 windows shows the window picker (${picker})`);
    if (theme === 'light' && lang === 'en') await shot(s, `picker-${tag}`, 'shell-taskbar-picker');
    await P.click('.tb-preview .tb-pv-item:nth-child(3)');
    await sleep(400);
    check(await s.aurora(() => window.__aurora.wm.focused()?.title === 'About Aurora — 3'), `[${tag}] picking a thumbnail focuses that window`);
    await P.click('.tb-app[data-app="winver"]', { button: 'right' });
    await sleep(400);
    const jump = await s.aurora(() => [...document.querySelectorAll('.menu.tb-jump .menu-item .label')].map((x) => x.textContent));
    check(jump.length === 3, `[${tag}] jump list: app / pin / close all (${jump.join(' | ')})`);
    if (theme === 'dark' && lang === 'fr') await shot(s, `jump-${tag}`, 'shell-taskbar-jumplist-fr');
    await P.keyboard.press('Escape');
    await sleep(200);
    // taskbar context menu
    await P.click('#taskbar', { button: 'right', position: { x: 300, y: 24 } });
    await sleep(300);
    const tbm = await s.aurora(() => document.querySelectorAll('.menu .menu-item').length);
    check(tbm >= 1, `[${tag}] taskbar context menu`);
    await P.keyboard.press('Escape');
    // left alignment animates and keeps buttons inside
    await s.aurora(() => window.__aurora.settings.set('taskbar.align', 'left'));
    await sleep(700);
    const left = await s.aurora(() => document.querySelector('.tb-start').getBoundingClientRect().left);
    check(left < 40, `[${tag}] taskbar left alignment (${Math.round(left)}px)`);
    await P.click('.tb-start');
    await sleep(600);
    const sl = await s.aurora(() => document.getElementById('start').getBoundingClientRect().left);
    check(sl < 40, `[${tag}] Start opens on the left with a left taskbar (${Math.round(sl)}px)`);
    if (theme === 'dark' && lang === 'en') await shot(s, `taskbar-left-${tag}`, 'shell-taskbar-left');
    await P.keyboard.press('Escape');
    await s.aurora(() => window.__aurora.settings.set('taskbar.align', 'center'));
    await sleep(400);
    // auto-hide
    await s.aurora(() => window.__aurora.settings.set('taskbar.autohide', true));
    await P.mouse.move(800, 300);
    await sleep(1800);
    const hidden = await s.aurora(() => ({ hidden: document.getElementById('taskbar').classList.contains('hidden'), inset: window.__aurora.wm.workarea().height }));
    check(hidden.hidden && hidden.inset === 900, `[${tag}] auto-hide hides the taskbar and frees the work area (${JSON.stringify(hidden)})`);
    await P.mouse.move(800, 899);
    await sleep(500);
    check(await s.aurora(() => !document.getElementById('taskbar').classList.contains('hidden')), `[${tag}] bottom-edge hover reveals the taskbar`);
    await s.aurora(() => window.__aurora.settings.set('taskbar.autohide', false));
    await sleep(300);
    check(await s.aurora(() => window.__aurora.wm.workarea().height === 852), `[${tag}] turning auto-hide off restores the work area`);
    // close the test windows
    await s.aurora(() => window.__aurora.wm.list().forEach((w) => w.close(true)));
    await sleep(500);

    // ---- Desktop
    const desk = await s.aurora(() => window.__aurora.desktop.items().map((x) => x.label));
    check(desk.includes('Projects') && desk.includes('Dunes.jpg'), `[${tag}] desktop lists ~/Desktop`);
    check(await s.aurora(() => !!document.querySelector('.desk-icon[data-id$="Dunes.jpg"] .desk-thumb img')), `[${tag}] image files get thumbnails`);
    // rename inline
    await P.click('.desk-icon[data-id$="Meeting notes.txt"]');
    await P.keyboard.press('F2');
    await sleep(200);
    check(await s.aurora(() => document.activeElement?.classList.contains('desk-rename')), `[${tag}] F2 starts inline rename`);
    await P.keyboard.type('Minutes');
    await P.keyboard.press('Enter');
    await sleep(700);
    check(fs.existsSync(path.join(s.home, 'Desktop', 'Minutes.txt')), `[${tag}] rename keeps the extension (Minutes.txt)`);
    // drag into a folder
    await P.dragAndDrop('.desk-icon[data-id$="Report.pdf"]', '.desk-icon[data-id$="Projects"]');
    await sleep(800);
    check(fs.existsSync(path.join(s.home, 'Desktop', 'Projects', 'Report.pdf')), `[${tag}] dragging an icon onto a folder moves it`);
    // delete -> trash
    await P.click('.desk-icon[data-id$="Holiday playlist.mp3"]');
    await P.keyboard.press('Delete');
    await sleep(800);
    check(!fs.existsSync(path.join(s.home, 'Desktop', 'Holiday playlist.mp3')), `[${tag}] Delete moves the file to the trash`);
    // keyboard navigation
    await P.click('.desk-icon[data-special="thispc"]');
    await P.keyboard.press('ArrowDown');
    check(await s.aurora(() => document.activeElement?.dataset.special === 'trash'), `[${tag}] arrow keys move between desktop icons`);
    // context menu with submenus
    await P.click('#desktop', { button: 'right', position: { x: 760, y: 300 } });
    await sleep(300);
    const dm = await s.aurora(() => [...document.querySelectorAll('.menu .menu-item .label')].map((x) => x.textContent));
    check(dm.length >= 7, `[${tag}] desktop context menu (${dm.join(', ')})`);
    await P.hover(`.menu-item:has-text("${lang === 'fr' ? 'Affichage' : 'View'}")`);
    await sleep(500);
    if (theme === 'light' && lang === 'fr') await shot(s, `desktop-menu-${tag}`, 'shell-desktop-menu-fr');
    await P.click(`.menu-item:has-text("${lang === 'fr' ? 'Grandes icônes' : 'Large icons'}")`);
    await sleep(600);
    check(await s.aurora(() => document.getElementById('desktop').dataset.iconSize === 'large'), `[${tag}] View ▸ Large icons`);
    if (theme === 'dark' && lang === 'en') await shot(s, `desktop-large-${tag}`, 'shell-desktop-large-icons');
    await s.aurora(() => window.__aurora.settings.set('desktopIconSize', 'medium'));
    // New ▸ Folder starts a rename
    await P.click('#desktop', { button: 'right', position: { x: 900, y: 500 } });
    await sleep(300);
    await P.hover(`.menu-item:has-text("${lang === 'fr' ? 'Nouveau' : 'New'}")`);
    await sleep(500);
    await P.click('.menu .menu-item:has-text("' + (lang === 'fr' ? 'Dossier' : 'Folder') + '")');
    await sleep(700);
    check(await s.aurora(() => document.activeElement?.classList.contains('desk-rename')), `[${tag}] New ▸ Folder creates a folder in rename mode`);
    await P.keyboard.press('Escape');
    await sleep(300);

    // ---- theme switch cross-fade + transparency
    const other = theme === 'light' ? 'dark' : 'light';
    await s.aurora((m) => window.__aurora.settings.set('theme', m), other);
    await sleep(2000);
    const th = await s.aurora(() => ({ mode: document.documentElement.dataset.theme, layers: document.querySelectorAll('.wallpaper-layer').length, wp: getComputedStyle(document.querySelector('.wallpaper-layer')).backgroundImage }));
    check(th.mode === other && th.layers === 1 && th.wp.includes(`bloom-${other}`), `[${tag}] theme switch swaps the wallpaper with a cross-fade (${JSON.stringify(th)})`);
    await s.aurora(() => window.__aurora.settings.set('transparency', false));
    await sleep(400);
    check(await s.aurora(() => document.documentElement.dataset.transparency === 'off' && getComputedStyle(document.getElementById('taskbar')).backdropFilter === 'none'), `[${tag}] transparency off removes acrylic`);

    const errs = myErrors(s);
    check(errs.length === 0, `[${tag}] no renderer errors from the shell UX code${errs.length ? `: ${errs.join(' | ')}` : ''}`);
  } catch (err) {
    failures++;
    console.log(`  ✗ [${tag}] crashed: ${err.stack || err}`);
    await s.shot(`ux-crash-${tag}`).catch(() => {});
  } finally {
    await s.close();
  }
}

// ------------------------------------------------------------------------------------------ main
fs.mkdirSync(OUT, { recursive: true });
await unitTests();
const combos = UNIT_ONLY ? [] : QUICK ? [['light', 'en']] : [['light', 'en'], ['dark', 'fr'], ['dark', 'en'], ['light', 'fr']];
for (const [theme, lang] of combos) await scenario(theme, lang);
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
