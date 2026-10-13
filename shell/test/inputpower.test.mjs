// Touchpad + power — « Souris et pavé tactile », « Alimentation », Réglages rapides power mode, battery alerts, idle.
//
//   xvfb-run -a -s "-screen 0 1600x900x24" node test/inputpower.test.mjs
//
// Runs against fakes (nothing touches the machine): xinput (a Synaptics touchpad + a USB mouse, properties kept in
// files), powerprofilesctl (three modes), xset (logs), a fake /sys/class/power_supply (AURORA_POWER_SUPPLY) the test
// rewrites, and a logind drop-in directory (AURORA_LOGIND_DIR) for the simulated aurora-admin power-lid.
// Screenshots (1280x720, FR, Halo dark + light): test/out/inputpower-*.png
// Idle inhibitors: the shell on a PRIVATE dbus-daemon with the real session-bus helper and the fake app of
// test/sessionbus.test.mjs: a film in VLC (ScreenSaver.Inhibit) -> no screen off, lock or idle sleep while it is held,
// released -> the delays apply again; music (PowerManagement.Inhibit) -> the screen turns off but no idle sleep; the
// 3 % countdown still sleeps (skipped without python3-dbus / dbus-daemon).
import { launchShell } from './lib.mjs';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
const failures = [];
function check(cond, msg) {
  if (cond) passed++;
  else failures.push(msg);
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${msg}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 6000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await sleep(150);
  }
  return false;
}

const unit = spawnSync(process.execPath, [path.join(ROOT, 'test', 'inputpower.unit.mjs')], { encoding: 'utf8' });
process.stdout.write(unit.stdout);
check(unit.status === 0, 'inputpower.unit.mjs passes');

// ------------------------------------------------------------------ fakes
const FAKE = fs.mkdtempSync(path.join(os.tmpdir(), 'ip-fake-'));
const ST = path.join(FAKE, 'state');
const PS = path.join(FAKE, 'power_supply');
const LOGIND = path.join(FAKE, 'logind.conf.d');
for (const d of [ST, LOGIND, path.join(PS, 'AC'), path.join(PS, 'BAT0')]) fs.mkdirSync(d, { recursive: true });
const script = (name, body) => {
  fs.writeFileSync(path.join(FAKE, name), `#!/bin/bash\nD="$IP_STATE"\n${body}\n`);
  fs.chmodSync(path.join(FAKE, name), 0o755);
};
script(
  'xinput',
  `echo "xinput $*" >> "$D/log"
case "$1" in
list) printf '⎡ Virtual core pointer                    \\tid=2\\t[master pointer  (3)]\\n⎜   ↳ Virtual core XTEST pointer              \\tid=4\\t[slave  pointer  (2)]\\n⎜   ↳ SynPS/2 Synaptics TouchPad              \\tid=12\\t[slave  pointer  (2)]\\n⎜   ↳ Logitech USB Optical Mouse              \\tid=15\\t[slave  pointer  (2)]\\n' ;;
list-props)
  if [ "$2" = 12 ]; then
    echo "Device 'SynPS/2 Synaptics TouchPad':"
    printf '\\tDevice Enabled (190):\\t%s\\n\\tlibinput Tapping Enabled (326):\\t%s\\n\\tlibinput Tapping Enabled Default (327):\\t0\\n\\tlibinput Natural Scrolling Enabled (300):\\t%s\\n\\tlibinput Disable While Typing Enabled (334):\\t%s\\n\\tlibinput Scrolling Pixel Distance (341):\\t%s\\n\\tlibinput Accel Speed (311):\\t0.000000\\n' "$(cat "$D/enabled")" "$(cat "$D/tap")" "$(cat "$D/natural")" "$(cat "$D/dwt")" "$(cat "$D/px")"
  else
    printf "Device 'Logitech USB Optical Mouse':\\n\\tDevice Enabled (190):\\t1\\n\\tlibinput Accel Speed (311):\\t0.000000\\n\\tlibinput Left Handed Enabled (300):\\t0\\n"
  fi ;;
set-prop)
  case "$3" in "Device Enabled") f=enabled ;; "libinput Tapping Enabled") f=tap ;; "libinput Natural Scrolling Enabled") f=natural ;; "libinput Disable While Typing Enabled") f=dwt ;; "libinput Scrolling Pixel Distance") f=px ;; *) f=other ;; esac
  [ "$2" = 12 ] && echo "$4" > "$D/$f" ;;
esac`,
);
script(
  'powerprofilesctl',
  `echo "ppc $*" >> "$D/log"
case "$1" in
list) a="$(cat "$D/profile")"; for p in performance balanced power-saver; do m=' '; [ "$p" = "$a" ] && m='*'; printf '%s %s:\\n    CpuDriver:\\tintel_pstate\\n\\n' "$m" "$p"; done ;;
set) echo "$2" > "$D/profile" ;;
get) cat "$D/profile" ;;
esac`,
);
script('xset', 'echo "xset $*" >> "$D/log"');
const put = (f, v) => fs.writeFileSync(path.join(ST, f), `${v}\n`);
const val = (f) => fs.readFileSync(path.join(ST, f), 'utf8').trim();
const log = () => fs.readFileSync(path.join(ST, 'log'), 'utf8');
function setBat(percent, status = 'Discharging', online = 0) {
  fs.writeFileSync(path.join(PS, 'AC', 'type'), 'Mains\n');
  fs.writeFileSync(path.join(PS, 'AC', 'online'), `${online}\n`);
  for (const [k, v] of Object.entries({ type: 'Battery', present: '1', status, capacity: String(percent), energy_full: '50000000', energy_now: String(percent * 500000), power_now: '9000000' })) fs.writeFileSync(path.join(PS, 'BAT0', k), `${v}\n`);
}
function resetState() {
  for (const [k, v] of Object.entries({ enabled: 1, tap: 0, natural: 0, dwt: 0, px: 15, profile: 'balanced', log: '' })) put(k, v);
  fs.writeFileSync(path.join(ST, 'log'), '');
  for (const f of fs.readdirSync(LOGIND)) fs.rmSync(path.join(LOGIND, f));
  setBat(76);
}
const ENV = {
  IP_STATE: ST,
  AURORA_XINPUT: path.join(FAKE, 'xinput'),
  AURORA_POWERPROFILESCTL: path.join(FAKE, 'powerprofilesctl'),
  AURORA_XSET: path.join(FAKE, 'xset'),
  AURORA_POWER_SUPPLY: PS,
  AURORA_POWER_POLL_MS: '400',
  AURORA_LOGIND_DIR: LOGIND,
};

const S = (sel) => `.app-settings ${sel}`;
const inv = (s, ch, ...a) => s.aurora(([c, args]) => window.__aurora.api.invoke(c, ...args), [ch, a]);
async function go(s, page) {
  await s.aurora((p) => window.__aurora.registry.launch('settings', { page: p }), page);
  await s.page.waitForFunction((p) => document.querySelector('.app-settings .st-page')?.dataset.page === p && !document.querySelector('.app-settings .st-content > .st-loading'), page, { timeout: 10000 });
  await sleep(500);
}
async function pickCombo(s, section, optionText) {
  await s.page.locator(S(`[data-section="${section}"] .st-combo`)).first().click();
  await s.page.locator('.menu .menu-item', { hasText: optionText }).first().click();
  await sleep(400);
}
async function uac(s) {
  await s.page.waitForSelector('.uac-dialog', { timeout: 8000 });
  const pw = s.page.locator('.uac-dialog input[type=password]');
  if (await pw.count()) await pw.fill('aurora');
  await s.page.locator('.uac-dialog .dialog-footer .btn.primary').click();
  await s.page.waitForSelector('.uac-dialog', { state: 'detached', timeout: 8000 }).catch(() => {});
}
const notifTitles = (s) => s.aurora(() => window.__aurora.notifications.list().map((n) => n.title));
const shots = [];

for (const theme of ['dark', 'light']) {
  console.log(`\n# Souris et pavé tactile / Alimentation — FR, Halo ${theme}, 1280x720`);
  resetState();
  const s = await launchShell({ lang: 'fr', theme, size: '1280x720', env: ENV });
  const P = s.page;
  // Toasts from other features (e.g. « Espace disque faible » in dev) would cover the screenshots.
  const hideToasts = () => s.aurora(() => window.__aurora.notifications.list().forEach((n) => window.__aurora.notifications.hide(n.id))).then(() => sleep(500));
  try {
    await hideToasts();
    // ---- session start: the defaults (tap to click, disable while typing) are applied with xinput
    check(await waitFor(() => val('tap') === '1' && val('dwt') === '1', 5000), `[${theme}] session start: tap-to-click and disable-while-typing applied to the touchpad (xinput set-prop)`);

    // ---- Souris et pavé tactile
    await go(s, 'mouse');
    check(/Souris et pavé tactile/.test((await P.textContent(S('.st-title'))) || ''), `[${theme}] page title « Souris et pavé tactile »`);
    const tpTitles = await P.$$eval('.app-settings .st-touchpad .st-row-title', (els) => els.map((e) => e.textContent));
    check(JSON.stringify(tpTitles) === JSON.stringify(['Pavé tactile', 'Toucher pour cliquer', 'Défilement naturel', 'Vitesse du défilement', 'Désactiver pendant la saisie']), `[${theme}] Pavé tactile section: ${tpTitles.join(', ')}`);
    check((await P.locator(S('[data-section="tap"] input[role=switch]')).isChecked()) && !(await P.locator(S('[data-section="natural"] input[role=switch]')).isChecked()), `[${theme}] switches show the live state (tap on, natural off)`);
    check(/pas encore disponibles/.test((await P.textContent(S('.st-touchpad .st-note'))) || ''), `[${theme}] gestures: said they are not available yet`);
    await P.locator(S('.st-page')).evaluate((el) => el.closest('.st-content, .st-scroll')?.scrollTo?.(0, 0));
    await hideToasts();
    shots.push(await s.shot(`inputpower-touchpad-fr-${theme}`));

    if (theme === 'dark') {
      await P.locator(S('[data-section="natural"] .st-toggle')).click();
      check(await waitFor(() => val('natural') === '1'), 'Défilement naturel on -> xinput sets libinput Natural Scrolling Enabled 1');
      await P.locator(S('[data-section="scrollSpeed"] .slider')).evaluate((el) => {
        el.value = '8';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      });
      check(await waitFor(() => val('px') === '8'), 'Vitesse du défilement 8 -> libinput Scrolling Pixel Distance 8');
      await P.locator(S('[data-section="touchpad"] .st-toggle')).click();
      check(await waitFor(() => val('enabled') === '0'), 'Pavé tactile off -> Device Enabled 0');
      check((await P.locator(S('.st-touchpad .st-row.disabled')).count()) === 4, 'the four other rows are greyed out while the touchpad is off');
      await P.locator(S('[data-section="touchpad"] .st-toggle')).click();
      check(await waitFor(() => val('enabled') === '1'), 'Pavé tactile back on');
      const saved = await s.aurora(() => window.__aurora.settings.get('touchpad'));
      check(saved?.natural === true && saved?.scrollSpeed === 8 && saved?.tap === true && saved?.enabled === true, 'choices saved in settings.touchpad (re-applied at the next sign-in)');
      let bad = 0;
      for (const v of [0, 11, 2.5, 'x']) await inv(s, 'input:setTouchpad', { scrollSpeed: v }).catch(() => bad++);
      check(bad === 4, 'input:setTouchpad refuses scroll speeds outside 1..10');
    }

    // ---- Alimentation
    await go(s, 'power');
    const sections = await P.$$eval('.app-settings [data-section]', (els) => els.map((e) => e.dataset.section));
    const want = ['battery', 'screenOffBattery', 'screenOffAc', 'sleepBattery', 'sleepAc', 'lockOnScreenOff', 'mode', 'lid', 'lowBattery'];
    check(want.every((w) => sections.includes(w)), `[${theme}] Alimentation: battery, screen off / sleep on battery and mains, lock, mode, lid, low battery (${want.filter((w) => !sections.includes(w)).join(', ') || 'all'})`);
    const comboText = async (sec) => (await P.textContent(S(`[data-section="${sec}"] .st-combo`)))?.trim();
    check((await comboText('screenOffBattery')) === '5 minutes' && (await comboText('screenOffAc')) === '10 minutes' && (await comboText('sleepBattery')) === '15 minutes' && (await comboText('sleepAc')) === 'Jamais', `[${theme}] defaults: screen off 5 min / 10 min, sleep 15 min on battery / never on mains`);
    check((await comboText('mode')) === 'Équilibré' && (await comboText('lid')) === 'Mettre en veille', `[${theme}] power mode Équilibré, lid Mettre en veille`);
    await hideToasts();
    shots.push(await s.shot(`inputpower-power-fr-${theme}`));
    await P.locator(S('[data-section="lowBattery"]')).scrollIntoViewIfNeeded();
    await hideToasts();
    shots.push(await s.shot(`inputpower-power-bottom-fr-${theme}`));

    if (theme === 'dark') {
      await pickCombo(s, 'screenOffBattery', '2 minutes');
      check((await s.aurora(() => window.__aurora.settings.get('power')))?.screenOffBattery === 2, 'screen off on battery -> settings.power.screenOffBattery = 2');
      await pickCombo(s, 'mode', 'Performances');
      check(await waitFor(() => val('profile') === 'performance'), 'Performances -> powerprofilesctl set performance');
      await pickCombo(s, 'lid', 'Ne rien faire');
      await uac(s);
      check(await waitFor(() => /HandleLidSwitch=ignore/.test(fs.readdirSync(LOGIND).map((f) => fs.readFileSync(path.join(LOGIND, f), 'utf8')).join(''))), 'lid « Ne rien faire » -> « Autorisation administrateur » -> logind drop-in HandleLidSwitch=ignore');
      check((await inv(s, 'power:lid')).action === 'ignore', 'power:lid reads it back');

      // ---- Réglages rapides: power mode tile
      await hideToasts();
      await s.aurora(() => window.__aurora.shell.emit('quick:open'));
      await P.waitForSelector('#quick-settings .qs-tile[data-key="powerMode"]', { timeout: 6000 });
      await sleep(400);
      check(/Performances/.test(await P.textContent('#quick-settings .qs-tile[data-key="powerMode"]')), 'Réglages rapides: « Mode d’alimentation » tile shows Performances');
      await hideToasts();
      shots.push(await s.shot('inputpower-quick-fr-dark'));
      await P.click('#quick-settings .qs-tile[data-key="powerMode"] .qs-tile-main');
      check(await waitFor(() => val('profile') === 'power-saver'), 'tile click -> next mode (Économie d’énergie)');
      check(await waitFor(async () => /Économie d’énergie/.test(await P.textContent('#quick-settings .qs-tile[data-key="powerMode"]'))), 'tile shows Économie d’énergie');
      await s.aurora(() => window.__aurora.quick.close());

      // ---- battery alerts
      await hideToasts();
      setBat(9);
      check(await waitFor(async () => (await notifTitles(s)).includes('Batterie faible'), 5000), 'battery at 9 % -> « Batterie faible »');
      setBat(5);
      check(await waitFor(async () => (await notifTitles(s)).includes('Batterie presque vide'), 5000), 'battery at 5 % -> « Batterie presque vide »');
      await s.aurora(() => (window.__aurora.power.countdownSec = 30));
      setBat(3);
      check(await waitFor(async () => (await notifTitles(s)).includes('Mise en veille pour protéger votre travail'), 5000), 'battery at 3 % discharging -> sleep countdown notification');
      await sleep(1200);
      shots.push(await s.shot('inputpower-countdown-fr-dark'));
      setBat(3, 'Charging', 1);
      check(await waitFor(async () => (await notifTitles(s)).includes('En charge'), 5000), 'plugged in -> countdown cancelled (« En charge »)');
      check((await s.aurora(() => window.__aurora.power.state.sleepCount)) === 0, 'no sleep after plugging in');
      await s.aurora(() => (window.__aurora.power.countdownSec = 2));
      setBat(3);
      const slept = await waitFor(() => s.aurora(() => window.__aurora.power.state.sleepCount >= 1), 10000);
      check(slept, `still unplugged at the end of the countdown -> sleep (${JSON.stringify(await s.aurora(() => ({ ...window.__aurora.power.state, countdown: !!window.__aurora.power.state.countdown })))})`);

      // ---- idle: screen off (+ lock) after inactivity
      setBat(80, 'Discharging', 0);
      await s.aurora(() => window.__aurora.settings.set('power', { screenOffBattery: 0.05, screenOffAc: 0.05, sleepBattery: 0, sleepAc: 0, lockOnScreenOff: true }));
      await sleep(3600);
      await s.aurora(() => window.__aurora.power.tick());
      check(await waitFor(() => /xset dpms force off/.test(log())), 'no input for the delay -> screen off (xset dpms force off)');
      check(await waitFor(() => s.aurora(() => window.__aurora.lockScreen?.locked)), 'the session locks when the screen turns off (account with a password)');
    }
    const errs = s.logs.filter((l) => /^\[(error|pageerror)\]/.test(l) && !/favicon|net::ERR/.test(l));
    check(!errs.length, `[${theme}] no renderer errors${errs.length ? `: ${errs.slice(0, 3).join(' | ')}` : ''}`);
  } catch (e) {
    check(false, `[${theme}] ${e.message}`);
  } finally {
    await s.close();
  }
}

// ------------------------------------------------------------------ idle inhibitors (private session bus)
{
  const PY = process.env.AURORA_SESSIONBUS_PYTHON || 'python3.12';
  const pyPath = spawnSync('sh', ['-c', `command -v ${PY}`], { encoding: 'utf8' }).stdout.trim();
  const haveBus = !!pyPath && spawnSync(pyPath, ['-c', 'import dbus, gi; from gi.repository import GLib'], { stdio: 'ignore' }).status === 0 && spawnSync('sh', ['-c', 'command -v dbus-daemon'], { stdio: 'ignore' }).status === 0;
  if (!haveBus) console.log(`\n# idle inhibitors: SKIPPED (${PY} without python3-dbus / python3-gi, or no dbus-daemon)`);
  else {
    console.log('\n# idle inhibitors (org.freedesktop.ScreenSaver on a private bus) — FR, 1280x720');
    resetState();
    const btmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ip-bus-'));
    const r = spawnSync('dbus-daemon', ['--session', '--fork', '--print-address=1', '--print-pid=1', `--address=unix:path=${btmp}/bus`], { encoding: 'utf8' });
    const [address, busPid] = r.stdout.trim().split('\n');
    const HELPER = path.join(ROOT, '..', 'rootfs', 'usr', 'lib', 'aurora', 'helpers', 'aurora-sessionbus');
    const FAKE_APP = path.join(ROOT, 'test', 'fixtures', 'sessionbus', 'fake-app.py');
    const apps = [];
    const fakeApp = () => {
      const p = spawn(pyPath, ['-I', FAKE_APP], { env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: address }, stdio: ['pipe', 'pipe', 'inherit'] });
      const lines = [];
      let buf = '';
      p.stdout.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          try {
            lines.push(JSON.parse(buf.slice(0, i)));
          } catch {}
          buf = buf.slice(i + 1);
        }
      });
      const a = { lines, send: (o) => p.stdin.write(`${JSON.stringify(o)}\n`), quit: () => (p.stdin.end(), setTimeout(() => p.kill(), 1000)), proc: p };
      apps.push(a);
      return a;
    };
    const s = await launchShell({ lang: 'fr', theme: 'dark', size: '1280x720', env: { ...ENV, DBUS_SESSION_BUS_ADDRESS: address, AURORA_SESSIONBUS: '1', AURORA_SESSIONBUS_HELPER: HELPER, AURORA_SESSIONBUS_PYTHON: pyPath } });
    const pw = (fn, arg) => s.aurora(fn, arg);
    const tickFor = async (ms) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        await pw(() => window.__aurora.power.tick());
        await sleep(500);
      }
    };
    try {
      check(await waitFor(async () => (await inv(s, 'sessionbus:status')).screensaver, 10000), 'the helper owns org.freedesktop.ScreenSaver on the session bus');
      const vlc = fakeApp();
      await waitFor(() => vlc.lines.includes('READY'), 8000);
      vlc.send({ cmd: 'inhibit', kind: 'screen', app: 'VLC', reason: 'Lecture d’une vidéo' });
      // (the shell's own Electron may hold a short 'power' one of its own: Chromium's audio wake lock for UI sounds)
      const vlcHeld = () => pw(() => (window.__aurora.power.inhibitors.list || []).some((i) => i.app === 'VLC' && i.kind === 'screen'));
      check(await waitFor(vlcHeld, 6000), 'a film in VLC (ScreenSaver.Inhibit) reaches the shell as a « screen » inhibitor');
      check((await pw(() => window.__aurora.power.inhibitors.apps)).includes('VLC'), 'the inhibitor is named after its app (VLC)');
      setBat(80, 'Discharging', 0);
      fs.writeFileSync(path.join(ST, 'log'), '');
      await pw(() => {
        window.__aurora.settings.set('power', { screenOffBattery: 0.05, screenOffAc: 0.05, sleepBattery: 0.08, sleepAc: 0.08, lockOnScreenOff: true });
        window.__aurora.settings.set('lockTimeout', 0.05);
      });
      await tickFor(7000);
      const st = await pw(() => ({ off: window.__aurora.power.state.screenOffCount, sleep: window.__aurora.power.state.sleepCount, locked: !!window.__aurora.lockScreen?.locked }));
      check(!/dpms force off/.test(log()) && st.off === 0, `inhibited: no screen off after 7 s with a 3 s delay (${JSON.stringify(st)})`);
      check(st.sleep === 0, 'inhibited: no idle sleep after 7 s with a 4.8 s delay');
      check(!st.locked, 'inhibited: no lock (lock at screen off, and lockTimeout 3 s)');
      // SimulateUserActivity restarts the delays
      const before = await pw(() => window.__aurora.power.lastActivity);
      await sleep(50);
      vlc.send({ cmd: 'simulate' });
      check(await waitFor(async () => (await pw(() => window.__aurora.power.lastActivity)) > before + 20, 5000), 'SimulateUserActivity -> the idle timer starts again');
      // released (the app quits without UnInhibit): the delays apply again
      vlc.quit();
      check(await waitFor(async () => !(await vlcHeld()), 6000), 'VLC leaves the bus -> its inhibitor is released');
      await tickFor(4500);
      check(await waitFor(() => /xset dpms force off/.test(log()), 4000), 'no inhibitor any more -> the screen turns off after the delay');
      check(await waitFor(() => pw(() => !!window.__aurora.lockScreen?.locked), 4000), 'and the session locks');
      // music (PowerManagement.Inhibit): the screen turns off, the computer does not sleep until it stops
      const ff = fakeApp();
      await waitFor(() => ff.lines.includes('READY'), 8000);
      ff.send({ cmd: 'inhibit', kind: 'power', app: 'Firefox', reason: 'audio-playing' });
      check(await waitFor(() => pw(() => (window.__aurora.power.inhibitors.list || []).some((i) => i.app === 'Firefox' && i.kind === 'power')), 6000), 'PowerManagement.Inhibit (music in Firefox) reaches the shell as a « power » inhibitor');
      const st0 = await pw(() => ({ off: window.__aurora.power.state.screenOffCount, sleep: window.__aurora.power.state.sleepCount }));
      await pw(() => window.dispatchEvent(new PointerEvent('pointermove'))); // someone moves the mouse, then leaves
      await tickFor(7000);
      const st1 = await pw(() => ({ off: window.__aurora.power.state.screenOffCount, sleep: window.__aurora.power.state.sleepCount }));
      check(st1.off > st0.off && st1.sleep === st0.sleep, `music: the screen turns off after 3 s, no idle sleep after 7 s with a 4.8 s delay (${JSON.stringify([st0, st1])})`);
      const ffCookie = ff.lines.find((l) => l?.inhibited)?.inhibited;
      ff.send({ cmd: 'uninhibit', kind: 'power', cookie: ffCookie });
      await waitFor(() => pw(() => !(window.__aurora.power.inhibitors.list || []).some((i) => i.app === 'Firefox')), 6000);
      await tickFor(1500);
      check(await waitFor(() => pw((n) => window.__aurora.power.state.sleepCount > n, st0.sleep), 6000), 'music stopped (UnInhibit) -> idle sleep');
      // battery safety first: the 3 % countdown still sleeps while a film and music play
      ff.send({ cmd: 'inhibit', kind: 'power', app: 'Firefox', reason: 'audio-playing' });
      ff.send({ cmd: 'inhibit', kind: 'screen', app: 'Firefox', reason: 'video-playing' });
      check(await waitFor(() => pw(() => (window.__aurora.power.inhibitors.list || []).filter((i) => i.app === 'Firefox').length === 2), 6000), 'Firefox holds both kinds');
      await pw(() => {
        window.__aurora.settings.set('power', { screenOffBattery: 0, screenOffAc: 0, sleepBattery: 0, sleepAc: 0, lockOnScreenOff: false });
        window.__aurora.power.countdownSec = 2;
      });
      const sleeps = await pw(() => window.__aurora.power.state.sleepCount);
      setBat(3);
      check(await waitFor(() => pw((n) => window.__aurora.power.state.sleepCount > n, sleeps), 10000), 'battery at 3 % while inhibited -> the countdown still puts the computer to sleep');
      ff.quit();
      const errs = s.logs.filter((l) => /^\[(error|pageerror)\]/.test(l) && !/favicon|net::ERR/.test(l));
      check(!errs.length, `[inhibitors] no renderer errors${errs.length ? `: ${errs.slice(0, 3).join(' | ')}` : ''}`);
    } catch (e) {
      check(false, `[inhibitors] ${e.message}`);
    } finally {
      for (const a of apps) a.quit();
      await s.close();
      try {
        process.kill(Number(busPid), 'SIGTERM');
      } catch {}
      fs.rmSync(btmp, { recursive: true, force: true });
    }
  }
}

console.log(`\nScreenshots:\n${shots.map((f) => `  ${f}`).join('\n')}`);
console.log(`\n${passed} passed, ${failures.length} failed`);
fs.rmSync(FAKE, { recursive: true, force: true });
if (failures.length) {
  for (const f of failures) console.log(`  FAIL ${f}`);
  process.exit(1);
}
