// Linux app integration, part 1 (track "trayn"): desktop notifications (org.freedesktop.Notifications), the system
// tray (StatusNotifierWatcher + host, dbusmenu) and XDG autostart.
//   1. units: autostart planning (main/ipc/autostart.js), notification / tray item mapping and icon lookup
//      (main/ipc/sessionbus.js)
//   2. helper + backend against a fake app (test/fixtures/sessionbus/fake-app.py) and gdbus (an independent client,
//      like notify-send) on a PRIVATE dbus-daemon — never the machine's session bus
//   2b. MPRIS: the Lecteur's org.mpris.MediaPlayer2.selene (properties, PropertiesChanged, Seeked, calls forwarded,
//      OpenUri / Set checks, gone with the Lecteur) and the client side (a fake external player listed, controlled,
//      followed; playerctld skipped) — test/fixtures/sessionbus/fake-player.py is both the fake player and the probe
//   3. UI: the real shell on that private bus: toasts with actions, Ne pas déranger, the tray icon, its menu, the item
//      leaving with its app, autostart; screenshots 1280x720 FR, Halo dark + light -> test/out/sessionbus-*.png
// Needs python3 with dbus + gi (AURORA_SESSIONBUS_PYTHON, default python3.12); 2 and 3 are skipped without it.
// Usage:  cd aurora-os/shell && xvfb-run -a -s "-screen 0 1600x900x24" node test/sessionbus.test.mjs [--unit]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { launchShell } from './lib.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HELPER = path.join(ROOT, '..', 'rootfs', 'usr', 'lib', 'aurora', 'helpers', 'aurora-sessionbus');
const FAKE = path.join(ROOT, 'test', 'fixtures', 'sessionbus', 'fake-app.py');
const FAKE_PLAYER = path.join(ROOT, 'test', 'fixtures', 'sessionbus', 'fake-player.py');
const ARGS = new Set(process.argv.slice(2));
const PY = process.env.AURORA_SESSIONBUS_PYTHON || 'python3.12';

let passed = 0;
const failures = [];
function check(name, actual, expected) {
  const ok = typeof expected === 'function' ? !!expected(actual) : Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++;
  else failures.push(`${name}\n      expected: ${typeof expected === 'function' ? '(predicate)' : JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}`);
  return ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn();
    if (v) return v;
    await sleep(50);
  }
  return null;
}

// ===================================================================== 1. units
console.log('\n# autostart planning');
{
  const { parsers: A } = require(path.join(ROOT, 'main', 'ipc', 'autostart.js'));
  const files = {
    '/u/autostart/sys-disabled.desktop': '[Desktop Entry]\nType=Application\nName=Off\nExec=tool-a\nHidden=true\n',
    '/u/autostart/mine.desktop': '[Desktop Entry]\nType=Application\nName=Mine\nExec=tool-b --flag "two words" %U\n',
    '/u/autostart/gnome-off.desktop': '[Desktop Entry]\nType=Application\nName=G\nExec=tool-a\nX-GNOME-Autostart-enabled=false\n',
    '/s/autostart/sys-disabled.desktop': '[Desktop Entry]\nType=Application\nName=Sys\nExec=tool-a\n',
    '/s/autostart/gnome-only.desktop': '[Desktop Entry]\nType=Application\nName=GO\nExec=tool-a\nOnlyShowIn=GNOME;Unity;\n',
    '/s/autostart/selene-only.desktop': '[Desktop Entry]\nType=Application\nName=SO\nExec=tool-a\nOnlyShowIn=Selene;\n',
    '/s/autostart/not-here.desktop': '[Desktop Entry]\nType=Application\nName=NH\nExec=tool-a\nNotShowIn=Aurora;\n',
    '/s/autostart/tryexec.desktop': '[Desktop Entry]\nType=Application\nName=TE\nTryExec=missing-tool\nExec=tool-a\n',
    '/s/autostart/missing.desktop': '[Desktop Entry]\nType=Application\nName=M\nExec=/opt/nothing/here\n',
    '/s/autostart/spice-vdagent.desktop': '[Desktop Entry]\nType=Application\nName=Spice\nExec=tool-a\n',
    '/s/autostart/link.desktop': '[Desktop Entry]\nType=Link\nName=L\nURL=https://x\n',
    '/s/autostart/broken.desktop': 'garbage',
    '/s/autostart/notes.txt': 'x',
  };
  const r = A.plan({
    dirs: ['/u/autostart', '/s/autostart'],
    read: (f) => files[f] ?? null,
    list: (d) => Object.keys(files).filter((f) => path.dirname(f) === d).map((f) => path.basename(f)),
    desktops: ['Aurora', 'Selene', 'X-Selene'],
    which: (p) => (['tool-a', 'tool-b'].includes(p) ? `/usr/bin/${p}` : null),
  });
  check('started: own entry, Selene-only entry (argv: quotes kept, %U dropped)', r.started.map((s) => [s.id, s.argv]), [
    ['mine', ['tool-b', '--flag', 'two words']],
    ['selene-only', ['tool-a']],
  ]);
  const why = Object.fromEntries(r.skipped.map((s) => [s.id, s.reason]));
  check('user Hidden=true hides the system entry of the same name (Moniteur système toggle)', why['sys-disabled'], 'hidden');
  check('X-GNOME-Autostart-enabled=false skipped', why['gnome-off'], 'disabled');
  check('OnlyShowIn=GNOME / NotShowIn=Aurora skipped', [why['gnome-only'], why['not-here']], ['desktop', 'desktop']);
  check('TryExec not found / program not found skipped', [why.tryexec, why.missing], ['tryexec', 'missing']);
  check('deny list: spice-vdagent (the session already runs it)', why['spice-vdagent'], 'deny');
  check('Type=Link and a broken file skipped; .txt ignored', [why.link, why.broken, why.notes], ['type', 'invalid', undefined]);
  check('deny list covers the image entries Selene runs itself', ['spice-vdagent', 'xdg-user-dirs', 'orca-autostart'].every((d) => A.DENY.has(d)), true);
}

console.log('\n# notification / tray mapping, icon lookup');
{
  const { parsers: S } = require(path.join(ROOT, 'main', 'ipc', 'sessionbus.js'));
  const iconUrl = (n) => (n === 'mail-unread' ? 'media://local/mail.svg' : n === '/tmp/pic.png' ? 'media://local/tmp/pic.png' : null);
  const base = { id: 4, app: 'Chat', icon: 'mail-unread', image: null, imagePath: '', summary: 'Salut', body: 'Corps', actions: [['default', 'Ouvrir'], ['r', 'Répondre']], urgency: 1, timeout: -1, entry: '' };
  const n = S.toNotification(base, { iconUrl });
  check('icon from the theme, default timeout 6 s, actions mapped', [n.icon, n.timeout, n.actions], ['media://local/mail.svg', 6000, [{ key: 'default', label: 'Ouvrir' }, { key: 'r', label: 'Répondre' }]]);
  check('critical: never expires; low: silent; 0: never expires; huge timeout capped', [S.toNotification({ ...base, urgency: 2 }, {}).timeout, S.toNotification({ ...base, urgency: 0 }, {}).silent, S.toNotification({ ...base, timeout: 0 }, {}).timeout, S.toNotification({ ...base, timeout: 999999 }, {}).timeout], [0, true, 0, 60000]);
  const img = S.toNotification({ ...base, icon: '', image: 'data:image/png;base64,AAA' }, { iconUrl });
  check('picture without an app icon becomes the icon', [img.icon, img.image], ['data:image/png;base64,AAA', null]);
  const both = S.toNotification({ ...base, imagePath: '/tmp/pic.png' }, { iconUrl });
  check('app icon + picture: picture as preview', [both.icon, both.image], ['media://local/mail.svg', 'media://local/tmp/pic.png']);
  const flat = S.toNotification({ ...base, app: '', icon: '', entry: 'org.example.Chat' }, { iconUrl, entry: (id) => (id === 'org.example.Chat' ? { id, name: 'Chat Exemple', icon: 'media://local/chat.png' } : null) });
  check('Flatpak (desktop-entry hint): name + icon of the app', [flat.appName, flat.icon, flat.appId], ['Chat Exemple', 'media://local/chat.png', 'org.example.Chat']);
  const it = { key: ':1.5/StatusNotifierItem', id: 'x', title: 'X', status: 'NeedsAttention', icon: 'a', iconPng: 'data:image/png;base64,N', attentionIcon: '', attentionPng: 'data:image/png;base64,ATT', tooltip: { title: 'T', body: 'B' }, menu: true };
  check('NeedsAttention shows the attention pixmap', S.toItem(it, {}).icon, 'data:image/png;base64,ATT');
  check('Active: icon pixmap; unknown status -> Active', [S.toItem({ ...it, status: 'Active' }, {}).icon, S.toItem({ ...it, status: 'Weird' }, {}).status], ['data:image/png;base64,N', 'Active']);
  check('icon name looked up with the item IconThemePath', S.toItem({ ...it, status: 'Active', iconPng: null, icon: 'tray-x', themePath: '/opt/app/icons' }, { iconUrl: (n, extra) => `${extra[0]}/${n}` }).icon, '/opt/app/icons/tray-x');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-icons-'));
  fs.mkdirSync(path.join(tmp, 'icons', 'hicolor', '22x22', 'status'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'icons', 'hicolor', '22x22', 'status', 'app-tray.png'), 'x');
  fs.mkdirSync(path.join(tmp, 'own'));
  fs.writeFileSync(path.join(tmp, 'own', 'own-icon.svg'), '<svg/>');
  check('findIcon: theme status icon, IconThemePath dir, bad names refused', [S.findIcon('app-tray', { bases: [path.join(tmp, 'icons')] }), S.findIcon('own-icon', { bases: [], extra: [path.join(tmp, 'own')] }), S.findIcon('../etc/passwd', { bases: [path.join(tmp, 'icons')] })], [path.join(tmp, 'icons', 'hicolor', '22x22', 'status', 'app-tray.png'), path.join(tmp, 'own', 'own-icon.svg'), null]);
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('\n# MPRIS mapping (sessionbus.js)');
{
  const { parsers: S } = require(path.join(ROOT, 'main', 'ipc', 'sessionbus.js'));
  const exists = (p) => ['/home/u/.cache/aurora/media/art/ab.jpg', '/tmp/.org.chromium.Chromium.x1'].includes(p);
  check('artUrl: file:// image -> media://, extensionless browser cover ok, https kept', [S.artUrl('file:///home/u/.cache/aurora/media/art/ab.jpg', { exists }), S.artUrl('file:///tmp/.org.chromium.Chromium.x1', { exists }), S.artUrl('https://i.scdn.co/image/ab67', { exists })], ['media://local/home/u/.cache/aurora/media/art/ab.jpg', 'media://local/tmp/.org.chromium.Chromium.x1', 'https://i.scdn.co/image/ab67']);
  check('artUrl: http, data:, missing file, remote host, encoded ../ and junk refused', [S.artUrl('http://x/a.png', { exists }), S.artUrl('data:image/png;base64,AA', { exists }), S.artUrl('file:///nope.png', { exists }), S.artUrl('file://host/home/u/.cache/aurora/media/art/ab.jpg', { exists }), S.artUrl('file:///home/u/x%2F..%2F.cache/aurora/media/art/ab.jpg', { exists: () => true }), S.artUrl(42)], [null, null, null, null, null, null]);
  const pl = S.toPlayer({ name: 'org.mpris.MediaPlayer2.vlc', identity: 'VLC', desktop: 'vlc', status: 'Weird', track: { id: '/t/1', title: 'T'.repeat(400), artist: 'A', album: '', length: 12.5, art: 'https://x/y.jpg' }, position: -3, positionAt: 5, rate: 0, activeAt: 7, canNext: 1, canControl: undefined }, { entry: (id) => (id === 'vlc' ? { name: 'VLC media player', icon: 'media://local/vlc.svg' } : null) });
  check('toPlayer: unknown status -> Stopped, title capped, position >= 0, rate 0 -> 1, desktop entry name + icon', [pl.status, pl.track.title.length, pl.position, pl.rate, pl.appName, pl.icon, pl.canNext, pl.canControl, pl.track.art], ['Stopped', 300, 0, 1, 'VLC media player', 'media://local/vlc.svg', true, true, 'https://x/y.jpg']);
  const st = S.cleanSelf({ active: true, identity: 'Lecteur', status: 'Playing', track: { id: 'q1', title: 'Lune', artist: 'X', album: 'Y', length: 1e9, art: '/home/u/.cache/aurora/media/art/ab.jpg' }, position: -1, rate: 9, volume: 2, loop: 'Bad', shuffle: 1, canNext: 1 }, { exists });
  check('cleanSelf: clamps (length, position, rate, volume), checks loop / art', [st.track.length, st.position, st.rate, st.volume, st.loop, st.shuffle, st.track.art, st.canNext, st.canSeek], [1e7, 0, 4, 1, 'None', true, '/home/u/.cache/aurora/media/art/ab.jpg', true, false]);
  check('cleanSelf: art outside an image file / relative refused; inactive -> null', [S.cleanSelf({ active: true, track: { art: '/etc/passwd' } }, { exists: () => true }).track.art, S.cleanSelf({ active: true, track: { art: 'rel.jpg' } }, { exists: () => true }).track.art, S.cleanSelf({ active: false }), S.cleanSelf(null)], ['', '', null, null]);
  check('toCall: known methods only, Set props checked, OpenUri needs an absolute path', [S.toCall({ method: 'Seek', offset: '2.5' }), S.toCall({ method: 'Set', prop: 'Volume', value: '0.4' }), S.toCall({ method: 'Set', prop: 'Metadata', value: 1 }), S.toCall({ method: 'OpenUri', path: 'rel.mp3' }), S.toCall({ method: 'Exec' })], [{ method: 'Seek', offset: 2.5 }, { method: 'Set', prop: 'Volume', value: 0.4 }, null, null, null]);
}

// ===================================================================== private bus + fake app
function haveDbusPython() {
  return spawnSync(PY, ['-c', 'import dbus, gi; from gi.repository import GLib'], { stdio: 'ignore' }).status === 0;
}
function startBus() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-sb-'));
  const r = spawnSync('dbus-daemon', ['--session', '--fork', '--print-address=1', '--print-pid=1', `--address=unix:path=${tmp}/bus`], { encoding: 'utf8' });
  const [address, pid] = r.stdout.trim().split('\n');
  return { tmp, address, pid: Number(pid), stop: () => (process.kill(Number(pid), 'SIGTERM'), fs.rmSync(tmp, { recursive: true, force: true })) };
}
function fakeApp(address) {
  const p = spawn(PY, ['-I', FAKE], { env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: address }, stdio: ['pipe', 'pipe', 'inherit'] });
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
  return {
    lines,
    send: (o) => p.stdin.write(`${JSON.stringify(o)}\n`),
    wait: (pred, ms = 5000) => until(() => lines.find(pred), ms),
    quit: () => {
      try {
        p.stdin.write('{"cmd":"quit"}\n');
      } catch {}
      setTimeout(() => p.kill(), 1000);
    },
    proc: p,
  };
}

// ===================================================================== 2. helper + backend
async function helperTests() {
  console.log('\n# helper + backend on a private bus');
  const bus = startBus();
  const env0 = { ...process.env };
  Object.assign(process.env, { DBUS_SESSION_BUS_ADDRESS: bus.address, AURORA_SESSIONBUS_HELPER: HELPER, AURORA_SESSIONBUS_PYTHON: spawnSync('sh', ['-c', `command -v ${PY}`], { encoding: 'utf8' }).stdout.trim() });
  let be = null;
  const app = fakeApp(bus.address);
  try {
    for (const k of Object.keys(require.cache)) if (/main[\\/]ipc[\\/]sessionbus\.js$/.test(k)) delete require.cache[k];
    const register = require(path.join(ROOT, 'main', 'ipc', 'sessionbus.js'));
    const handlers = new Map();
    const events = [];
    be = register({ DEV: false, env: { version: '9.9' }, handle: (c, f) => handlers.set(c, f), broadcast: (ch, p) => events.push([ch, p]) });
    const call = (ch, ...a) => handlers.get(ch)(...a);
    check('helper owns both names', await until(async () => { const s = await call('sessionbus:status'); return s.notifications && s.tray && s; }, 8000), (s) => s && s.running);
    check('fake app is up', await app.wait((l) => l === 'READY', 8000), 'READY');
    app.send({ cmd: 'caps' });
    app.send({ cmd: 'info' });
    check('GetCapabilities: actions, body, body-markup, icon-static, persistence', (await app.wait((l) => l.caps))?.caps, ['actions', 'body', 'body-markup', 'icon-static', 'persistence']);
    check('GetServerInformation: Selene, spec 1.2', (await app.wait((l) => l.info))?.info, ['Selene', 'Selene OS', '9.9', '1.2']);
    // notify-send-like independent client: gdbus
    const g = spawnSync('gdbus', ['call', '--session', '--dest', 'org.freedesktop.Notifications', '--object-path', '/org/freedesktop/Notifications', '--method', 'org.freedesktop.Notifications.Notify', 'gdbus', '0', 'dialog-information', 'Sauvegarde', 'Terminée <i>sans</i> erreur &amp; vite', '[]', '{"urgency": <byte 0>}', '3000'], { env: process.env, encoding: 'utf8' });
    check('gdbus Notify answers an id', g.stdout.trim(), (v) => /^\(uint32 \d+,\)$/.test(v));
    const ev1 = await until(() => events.find(([c, p]) => c === 'notify:desktop' && p.title === 'Sauvegarde'));
    check('markup stripped safely, entities decoded, low urgency silent, timeout kept', ev1 && [ev1[1].body, ev1[1].silent, ev1[1].timeout, ev1[1].appName], ['Terminée sans erreur & vite', true, 3000, 'gdbus']);
    // python client: actions + image-data (RGB) + replace + close
    app.send({ cmd: 'notify', args: ['Discussion', 0, '', 'Camille', 'Tu viens <b>ce soir</b> ?', ['default', 'Ouvrir', 'reply', 'Répondre', 'no', 'Plus tard'], { 'image-data': { w: 2, h: 2, channels: 3, data: [255, 0, 0, 0, 255, 0, 0, 0, 255, 9, 9, 9] } }, -1] });
    const nid = (await app.wait((l) => l.notified))?.notified;
    const ev2 = await until(() => events.find(([c, p]) => c === 'notify:desktop' && p.id === nid));
    check('image-data -> PNG data URL used as the icon; actions kept in order', ev2 && [ev2[1].icon.startsWith('data:image/png;base64,iVBORw0KGgo'), ev2[1].image, ev2[1].actions.map((a) => a.key)], [true, null, ['default', 'reply', 'no']]);
    await call('notify:desktopAction', nid, 'reply');
    check('ActionInvoked(reply) then NotificationClosed(2)', [(await app.wait((l) => l.signal === 'ActionInvoked'))?.key, (await app.wait((l) => l.signal === 'NotificationClosed' && l.id === nid))?.reason], ['reply', 2]);
    app.send({ cmd: 'notify', args: ['Lecteur', 0, '', 'Titre 1', '', [], {}, 0] });
    await app.wait((l) => l.notified && l.notified !== nid);
    const n3 = app.lines.filter((l) => l.notified).pop().notified;
    app.send({ cmd: 'notify', args: ['Lecteur', n3, '', 'Titre 2', '', [], {}, 0] });
    check('replaces_id keeps the same id', (await until(() => app.lines.filter((l) => l.notified).length >= 3 && app.lines.filter((l) => l.notified).pop()))?.notified, n3);
    check('replacement flagged for the shell', !!(await until(() => events.find(([c, p]) => c === 'notify:desktop' && p.title === 'Titre 2' && p.replaces && p.timeout === 0))), true);
    app.send({ cmd: 'close', nid: n3 });
    check('CloseNotification -> notify:desktopClose + NotificationClosed(3)', [!!(await until(() => events.find(([c, p]) => c === 'notify:desktopClose' && p.id === n3))), (await app.wait((l) => l.signal === 'NotificationClosed' && l.id === n3))?.reason], [true, 3]);
    check('shell dismissal of an unknown id is harmless', await call('notify:desktopClosed', 4242, 2), false);
    // idle inhibitors: org.freedesktop.ScreenSaver (both paths) + org.freedesktop.PowerManagement.Inhibit
    const inh = () => events.filter(([c]) => c === 'power:inhibitors').pop()?.[1] || { count: 0, apps: [] };
    check('helper owns org.freedesktop.ScreenSaver and org.freedesktop.PowerManagement', await call('sessionbus:status'), (s) => s.screensaver === true && s.power === true);
    check('no inhibitor at first', (await call('power:inhibitors')).count, 0);
    app.send({ cmd: 'inhibit', kind: 'screen', app: 'VLC', reason: 'Lecture d’une vidéo' });
    const c1 = (await app.wait((l) => l.inhibited))?.inhibited;
    check('ScreenSaver.Inhibit (/org/freedesktop/ScreenSaver) -> a cookie, reported to the shell (count + app name)', [c1 > 0, !!(await until(() => inh().count === 1)), inh().apps, inh().list?.[0]?.kind, inh().list?.[0]?.reason], [true, true, ['VLC'], 'screen', 'Lecture d’une vidéo']);
    app.send({ cmd: 'inhibit', kind: 'screen', path: '/ScreenSaver', app: 'VLC', reason: 'second' });
    const c2 = (await app.wait((l) => l.inhibited && l.inhibited !== c1))?.inhibited;
    check('KDE path /ScreenSaver works too; cookies are distinct', [!!c2 && c2 !== c1, !!(await until(() => inh().count === 2)), inh().apps], [true, true, ['VLC']]);
    check('power:inhibitors handler returns the same state', (await call('power:inhibitors')).count, 2);
    app.send({ cmd: 'uninhibit', kind: 'screen', cookie: c1 });
    await app.wait((l) => l.uninhibited === c1);
    check('UnInhibit(cookie) -> count 1', !!(await until(() => inh().count === 1 && inh().list[0].cookie === c2)), true);
    const stolen = spawnSync('gdbus', ['call', '--session', '--dest', 'org.freedesktop.ScreenSaver', '--object-path', '/org/freedesktop/ScreenSaver', '--method', 'org.freedesktop.ScreenSaver.UnInhibit', String(c2)], { env: process.env, encoding: 'utf8' });
    await sleep(300);
    check('another connection cannot release a cookie it did not take', [stolen.status, (await call('power:inhibitors')).count], [0, 1]);
    const app2 = fakeApp(bus.address);
    await app2.wait((l) => l === 'READY', 8000);
    app2.send({ cmd: 'inhibit', kind: 'power', app: 'Firefox', reason: 'audio-playing' });
    const c3 = (await app2.wait((l) => l.inhibited))?.inhibited;
    app.send({ cmd: 'hasInhibit' });
    check('PowerManagement.Inhibit -> cookie, HasInhibit true, both apps listed', [c3 > 0, (await app.wait((l) => l?.hasInhibit !== undefined))?.hasInhibit, !!(await until(() => inh().count === 2)), inh().apps, inh().list.find((i) => i.app === 'Firefox')?.kind], [true, true, true, ['VLC', 'Firefox'], 'power']);
    app2.quit();
    check('the app leaves the bus without UnInhibit -> its cookie is released (NameOwnerChanged)', !!(await until(() => inh().count === 1 && inh().apps.join() === 'VLC', 6000)), true);
    const g2 = spawnSync('gdbus', ['call', '--session', '--dest', 'org.freedesktop.ScreenSaver', '--object-path', '/ScreenSaver', '--method', 'org.freedesktop.ScreenSaver.Inhibit', 'mpv-script', 'film'], { env: process.env, encoding: 'utf8' });
    check('gdbus Inhibit then exits at once: cookie given, then released with its connection', [/^\(uint32 \d+,\)$/.test(g2.stdout.trim()), !!(await until(() => events.some(([c, p]) => c === 'power:inhibitors' && p.apps.includes('mpv-script')))), !!(await until(() => inh().count === 1 && !inh().apps.includes('mpv-script')))], [true, true, true]);
    app.send({ cmd: 'uninhibit', kind: 'screen', cookie: c2 });
    app.send({ cmd: 'hasInhibit' });
    check('last UnInhibit -> count 0, HasInhibit false', [!!(await until(() => inh().count === 0)), (await until(() => app.lines.filter((l) => l?.hasInhibit !== undefined).length >= 2 && app.lines.filter((l) => l?.hasInhibit !== undefined).pop()))?.hasInhibit], [true, false]);
    app.send({ cmd: 'active' });
    app.send({ cmd: 'simulate' });
    check('GetActive false; SimulateUserActivity -> power:userActivity', [(await app.wait((l) => l?.active !== undefined))?.active, !!(await until(() => events.some(([c]) => c === 'power:userActivity')))], [false, true]);
    // a second helper on the same bus: every name is taken -> it says so (stderr) and keeps answering
    const h2 = spawn(process.env.AURORA_SESSIONBUS_PYTHON, ['-I', HELPER], { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let h2out = '';
    let h2err = '';
    h2.stdout.on('data', (d) => (h2out += d));
    h2.stderr.on('data', (d) => (h2err += d));
    await until(() => /"ready"/.test(h2out), 8000);
    h2.stdin.write('{"id": 1, "cmd": "inhibitors"}\n');
    await until(() => /"id": 1/.test(h2out), 5000);
    const h2lines = h2out.trim().split('\n').map((l) => JSON.parse(l));
    check('names already owned: ready says so, stderr logs it, the helper keeps working', [h2lines[0], /org\.freedesktop\.ScreenSaver is owned by another program/.test(h2err), h2lines[1]?.ok], [{ event: 'ready', notifications: false, tray: false, screensaver: false, power: false }, true, true]);
    h2.kill();
    // tray
    app.send({ cmd: 'sni', name: 'org.kde.StatusNotifierItem-777-1' });
    const reg = await app.wait((l) => l.sni);
    check('watcher: host registered, item listed', reg && [reg.host, reg.items], [true, ['org.kde.StatusNotifierItem-777-1/StatusNotifierItem']]);
    const items = await until(() => events.filter(([c]) => c === 'tray:items').pop()?.[1].length && events.filter(([c]) => c === 'tray:items').pop()[1]);
    const it = items?.[0];
    check('tray item: pixmap -> PNG, tooltip markup stripped, has a menu', it && [it.icon.startsWith('data:image/png;base64,'), it.tooltip, it.menu, it.status], [true, { title: 'Discussion', body: '3 messages non lus' }, true, 'Active']);
    const menu = await call('tray:menu', it.key);
    check('dbusmenu: labels, separator, toggle, disabled, hidden dropped, submenu, mnemonic removed', menu.map((e) => [e.id, e.type === 'separator' ? '-' : e.label, e.enabled, e.toggle, e.state, e.children.map((c) => c.label)]), [
      [1, 'Ouvrir la fenêtre', true, null, -1, []],
      [2, '-', true, null, -1, []],
      [3, 'Mode silencieux', true, 'checkmark', 1, []],
      [4, 'Indisponible', false, null, -1, []],
      [5, 'Plus', true, null, -1, ['À propos']],
      [7, 'Quitter', true, null, -1, []],
    ]);
    await call('tray:menuEvent', it.key, 6);
    check('Event(6, clicked) reaches the app', (await app.wait((l) => l.call === 'Event'))?.id, 6);
    await call('tray:activate', it.key, 100, 700);
    check('Activate(x, y)', (await app.wait((l) => l.call === 'Activate')) || null, { call: 'Activate', x: 100, y: 700 });
    await call('tray:scroll', it.key, -1, 'vertical');
    check('Scroll', (await app.wait((l) => l.call === 'Scroll'))?.delta, -1);
    check('bad item key refused', await Promise.resolve().then(() => call('tray:activate', 'bad key!', 0, 0)).catch((e) => e.code), 'EINVAL');
    app.send({ cmd: 'status', value: 'Passive' });
    check('NewStatus re-read (Passive)', !!(await until(() => events.filter(([c]) => c === 'tray:items').pop()?.[1][0]?.status === 'Passive')), true);
    app.quit();
    check('item removed when its app leaves the bus', !!(await until(() => events.filter(([c]) => c === 'tray:items').pop()?.[1].length === 0, 6000)), true);
  } catch (e) {
    check('helper flow', e.stack, '(no exception)');
  } finally {
    app.quit();
    be?.stop();
    await sleep(300);
    bus.stop();
    for (const k of ['DBUS_SESSION_BUS_ADDRESS', 'AURORA_SESSIONBUS_HELPER', 'AURORA_SESSIONBUS_PYTHON']) {
      if (env0[k] === undefined) delete process.env[k];
      else process.env[k] = env0[k];
    }
  }
}

// ===================================================================== 2b. MPRIS
function fakePlayer(address) {
  const p = spawn(PY, ['-I', FAKE_PLAYER], { env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: address }, stdio: ['pipe', 'pipe', 'inherit'] });
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
  let mark = 0;
  return {
    lines,
    send: (o) => p.stdin.write(`${JSON.stringify(o)}\n`),
    /** the first line matching pred after the last ask() / since(): answers are not mixed up with older ones */
    since: () => (mark = lines.length),
    fresh: () => lines.slice(mark),
    wait: (pred, ms = 5000) => until(() => lines.slice(mark).find(pred), ms),
    async ask(o, pred, ms = 5000) {
      mark = lines.length;
      p.stdin.write(`${JSON.stringify(o)}\n`);
      return until(() => lines.slice(mark).find(pred), ms);
    },
    quit: () => {
      try {
        p.stdin.write('{"cmd":"quit"}\n');
      } catch {}
      setTimeout(() => p.kill(), 1000);
    },
  };
}

async function mprisTests() {
  console.log('\n# MPRIS on a private bus: the Lecteur exported, other players listed and driven');
  const bus = startBus();
  const env0 = { ...process.env };
  Object.assign(process.env, { DBUS_SESSION_BUS_ADDRESS: bus.address, AURORA_SESSIONBUS_HELPER: HELPER, AURORA_SESSIONBUS_PYTHON: spawnSync('sh', ['-c', `command -v ${PY}`], { encoding: 'utf8' }).stdout.trim() });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-mpris-'));
  const art = path.join(tmp, 'cover.png');
  fs.writeFileSync(art, Buffer.from('89504e470d0a1a0a', 'hex'));
  const song = path.join(tmp, 'chanson été.mp3');
  fs.writeFileSync(song, 'x');
  let be = null;
  const probe = fakePlayer(bus.address);
  const other = fakePlayer(bus.address);
  const dup = fakePlayer(bus.address);
  try {
    for (const k of Object.keys(require.cache)) if (/main[\\/]ipc[\\/]sessionbus\.js$/.test(k)) delete require.cache[k];
    const register = require(path.join(ROOT, 'main', 'ipc', 'sessionbus.js'));
    const handlers = new Map();
    const events = [];
    be = register({ DEV: false, env: { version: '9.9' }, handle: (c, f) => handlers.set(c, f), broadcast: (ch, p) => events.push([ch, p]) });
    const call = (ch, ...a) => Promise.resolve().then(() => handlers.get(ch)(...a));
    await until(async () => (await call('sessionbus:status')).notifications, 8000);
    await probe.wait((l) => l === 'READY', 8000);
    const SEL = 'org.mpris.MediaPlayer2.selene';
    const PLAYER = 'org.mpris.MediaPlayer2.Player';
    const names = async () => (await probe.ask({ cmd: 'names' }, (l) => l.names))?.names || [];
    check('no Lecteur, no org.mpris.MediaPlayer2.selene', (await names()).includes(SEL), false);
    const state = { active: true, identity: 'Lecteur', status: 'Playing', track: { id: 'q1a', title: 'Marée haute', artist: 'Lune Rousse', album: 'Nuits claires', length: 182.5, art }, position: 12, rate: 1, volume: 0.8, loop: 'None', shuffle: false, canNext: true, canPrev: false, canPlay: true, canPause: true, canSeek: true };
    check('mpris:self (Lecteur open) -> true', await call('mpris:self', state), true);
    check('org.mpris.MediaPlayer2.selene appears', !!(await until(async () => (await names()).includes(SEL), 5000)), true);
    const root = (await probe.ask({ cmd: 'getall', name: SEL, iface: 'org.mpris.MediaPlayer2' }, (l) => l.all || l.error))?.value || {};
    check('MediaPlayer2: Identity, CanRaise / CanQuit, file:// only, no track list', [root.Identity, root.CanRaise, root.CanQuit, root.SupportedUriSchemes, root.HasTrackList], ['Lecteur', true, true, ['file'], false]);
    const all = (await probe.ask({ cmd: 'getall', name: SEL, iface: PLAYER }, (l) => l.all || l.error))?.value || {};
    const md = all.Metadata || {};
    check('Player: status, Metadata (trackid, title, artist list, album, length µs, artUrl file://)', [all.PlaybackStatus, md['mpris:trackid'], md['xesam:title'], md['xesam:artist'], md['xesam:album'], md['mpris:length'], md['mpris:artUrl']], ['Playing', '/org/mpris/MediaPlayer2/selene/track/q1a', 'Marée haute', ['Lune Rousse'], 'Nuits claires', 182500000, `file://${art}`]);
    check('Player: capabilities, volume, rate, loop, shuffle', [all.CanGoNext, all.CanGoPrevious, all.CanPlay, all.CanPause, all.CanSeek, all.CanControl, all.Volume, all.Rate, all.LoopStatus, all.Shuffle], [true, false, true, true, true, true, 0.8, 1, 'None', false]);
    check('Position while playing moves on from the last state (µs)', all.Position, (v) => v >= 12e6 && v < 14e6);
    await probe.ask({ cmd: 'watch', name: SEL }, (l) => l.watching);
    probe.since();
    await call('mpris:self', { ...state, status: 'Paused', position: 20 });
    const pc = await probe.wait((l) => l.signal === 'PropertiesChanged');
    check('PropertiesChanged on a change: only what changed (PlaybackStatus), never Position', pc && [pc.iface, Object.keys(pc.changed)], [PLAYER, ['PlaybackStatus']]);
    check('paused: Position is the state position', (await probe.ask({ cmd: 'get', name: SEL, iface: PLAYER, prop: 'Position' }, (l) => l.got || l.error))?.value, 20e6);
    probe.since();
    await call('mpris:self', { ...state, status: 'Paused', position: 20, track: { ...state.track, id: 'q2b', title: 'Phare' } });
    const pc2 = await probe.wait((l) => l.signal === 'PropertiesChanged');
    check('new track -> PropertiesChanged Metadata', pc2?.changed?.Metadata?.['xesam:title'], 'Phare');
    probe.since();
    await call('mpris:self', { ...state, status: 'Paused', position: 20, track: { ...state.track, id: 'q2b', title: 'Phare' } });
    await sleep(300);
    check('same state again: no signal', probe.fresh().some((l) => l.signal === 'PropertiesChanged'), false);
    probe.since();
    await call('mpris:seeked', 30.5);
    check('mpris:seeked -> Seeked(µs)', (await probe.wait((l) => l.signal === 'Seeked'))?.position, 30500000);
    // calls from an MPRIS client go back to the Lecteur
    const callEv = (pred) => until(() => events.filter(([c]) => c === 'mpris:call').map(([, p]) => p).find(pred), 3000);
    const n0 = () => events.filter(([c]) => c === 'mpris:call').length;
    await probe.ask({ cmd: 'call', name: SEL, method: 'PlayPause' }, (l) => l.called || l.error);
    check('PlayPause -> mpris:call', !!(await callEv((c) => c.method === 'PlayPause')), true);
    await probe.ask({ cmd: 'call', name: SEL, method: 'Next' }, (l) => l.called || l.error);
    check('Next (CanGoNext) -> mpris:call', !!(await callEv((c) => c.method === 'Next')), true);
    const before = n0();
    await probe.ask({ cmd: 'call', name: SEL, method: 'Previous' }, (l) => l.called || l.error);
    await sleep(300);
    check('Previous with CanGoPrevious false: no effect (spec)', n0(), before);
    await probe.ask({ cmd: 'call', name: SEL, method: 'Seek', args: [-5000000], sig: 'x' }, (l) => l.called || l.error);
    check('Seek(-5 s) -> { offset: -5 }', (await callEv((c) => c.method === 'Seek'))?.offset, -5);
    await probe.ask({ cmd: 'call', name: SEL, method: 'SetPosition', args: ['/org/mpris/MediaPlayer2/selene/track/q2b', 60000000], sig: 'ox' }, (l) => l.called || l.error);
    check('SetPosition(current track, 60 s) -> { position: 60 }', (await callEv((c) => c.method === 'SetPosition'))?.position, 60);
    const b2 = n0();
    await probe.ask({ cmd: 'call', name: SEL, method: 'SetPosition', args: ['/org/mpris/MediaPlayer2/selene/track/q1a', 1000000], sig: 'ox' }, (l) => l.called || l.error);
    await probe.ask({ cmd: 'call', name: SEL, method: 'SetPosition', args: ['/org/mpris/MediaPlayer2/selene/track/q2b', 999000000], sig: 'ox' }, (l) => l.called || l.error);
    await sleep(300);
    check('SetPosition with another track id or past the end: ignored (spec)', n0(), b2);
    await probe.ask({ cmd: 'call', name: SEL, method: 'OpenUri', args: [`file://${encodeURI(song)}`], sig: 's' }, (l) => l.called || l.error);
    check('OpenUri(file:// local media, percent-encoded) -> { path }', (await callEv((c) => c.method === 'OpenUri'))?.path, song);
    const bad = [];
    for (const u of ['https://example.com/a.mp3', `file://${tmp}/missing.mp3`, `file://${art}`, 'file://evil/etc/passwd.mp3', `file://${encodeURI(song)}?x=1`]) bad.push((await probe.ask({ cmd: 'call', name: SEL, method: 'OpenUri', args: [u], sig: 's' }, (l) => l.called || l.error))?.error);
    check('OpenUri refuses http(s), missing files, non-media, remote hosts, queries', bad, Array(5).fill('org.freedesktop.DBus.Error.InvalidArgs'));
    await probe.ask({ cmd: 'setprop', name: SEL, prop: 'Volume', value: 1.7, sig: 'd' }, (l) => l.setprop || l.error);
    check('Set Volume 1.7 -> clamped to 1, sent to the Lecteur', (await callEv((c) => c.method === 'Set' && c.prop === 'Volume'))?.value, 1);
    await probe.ask({ cmd: 'setprop', name: SEL, prop: 'LoopStatus', value: 'Track', sig: 's' }, (l) => l.setprop || l.error);
    check('Set LoopStatus Track', (await callEv((c) => c.method === 'Set' && c.prop === 'LoopStatus'))?.value, 'Track');
    check('Set LoopStatus junk / PlaybackStatus -> errors', [(await probe.ask({ cmd: 'setprop', name: SEL, prop: 'LoopStatus', value: 'Forever', sig: 's' }, (l) => l.setprop || l.error))?.error, (await probe.ask({ cmd: 'setprop', name: SEL, prop: 'PlaybackStatus', value: 'Playing', sig: 's' }, (l) => l.setprop || l.error))?.error], ['org.freedesktop.DBus.Error.InvalidArgs', 'org.freedesktop.DBus.Error.PropertyReadOnly']);
    await probe.ask({ cmd: 'call', name: SEL, method: 'Raise', iface: 'org.mpris.MediaPlayer2' }, (l) => l.called || l.error);
    check('Raise -> mpris:call', !!(await callEv((c) => c.method === 'Raise')), true);
    // the client side: other players
    const players = () => events.filter(([c]) => c === 'mpris:players').pop()?.[1] || [];
    check('the Lecteur is not listed among the other players', players().some((p) => p.name === SEL), false);
    await other.wait((l) => l === 'READY', 8000);
    await other.ask({ cmd: 'own', name: 'org.mpris.MediaPlayer2.fakeplayer', identity: 'Lecteur Test', state: { PlaybackStatus: 'Playing', Metadata: { trackid: '/fake/track/7', title: 'Song Seven', artist: 'Band', album: 'LP', length: 200, art: `file://${art}` } } }, (l) => l.owned);
    const fp = await until(() => players().find((p) => p.name === 'org.mpris.MediaPlayer2.fakeplayer' && p.track?.title === 'Song Seven'), 5000);
    check('external player listed: identity, status, track, length, cover as media://, activeAt set (it is playing)', fp && [fp.identity, fp.status, fp.track.artist, fp.track.album, fp.track.length, fp.track.art, fp.activeAt > 0, fp.canRaise], ['Lecteur Test', 'Playing', 'Band', 'LP', 200, `media://local${art.split('/').map(encodeURIComponent).join('/')}`, true, true]);
    check('mpris:players handler returns the same list', (await call('mpris:players')).map((p) => p.name), ['org.mpris.MediaPlayer2.fakeplayer']);
    await other.ask({ cmd: 'position', value: 42 }, (l) => l.position);
    check('mpris:position reads it from the player', await call('mpris:position', 'org.mpris.MediaPlayer2.fakeplayer'), 42);
    other.since();
    await call('mpris:control', 'org.mpris.MediaPlayer2.fakeplayer', 'PlayPause');
    check('mpris:control PlayPause reaches the player; its PropertiesChanged is followed (Paused)', [!!(await other.wait((l) => l.call === 'PlayPause')), !!(await until(() => players()[0]?.status === 'Paused', 3000))], [true, true]);
    await call('mpris:control', 'org.mpris.MediaPlayer2.fakeplayer', 'SetPosition', 90);
    const sp = await other.wait((l) => l.call === 'SetPosition');
    check('SetPosition(90 s) uses the current track id; Seeked updates the position', [sp?.track, sp?.position, !!(await until(() => players()[0]?.position === 90, 3000))], ['/fake/track/7', 90000000, true]);
    await call('mpris:control', 'org.mpris.MediaPlayer2.fakeplayer', 'Next');
    await call('mpris:control', 'org.mpris.MediaPlayer2.fakeplayer', 'Raise');
    check('Next / Raise reach the player', [!!(await other.wait((l) => l.call === 'Next')), !!(await other.wait((l) => l.call === 'Raise'))], [true, true]);
    const t0 = players()[0].activeAt;
    await sleep(20);
    await other.ask({ cmd: 'set', state: { PlaybackStatus: 'Playing' } }, (l) => l.set);
    check('starting again moves activeAt on (the shell follows the most recently active player)', !!(await until(() => players()[0]?.status === 'Playing' && players()[0].activeAt > t0, 3000)), true);
    check('mpris:control: unknown player -> ENOTFOUND, bad name / method -> EINVAL', [await call('mpris:control', 'org.mpris.MediaPlayer2.nobody', 'Play').catch((e) => e.code), await call('mpris:control', 'org.example.evil', 'Play').catch((e) => e.code), await call('mpris:control', 'org.mpris.MediaPlayer2.fakeplayer', 'Quit').catch((e) => e.code)], ['ENOTFOUND', 'EINVAL', 'EINVAL']);
    await dup.wait((l) => l === 'READY', 8000);
    await dup.ask({ cmd: 'own', name: 'org.mpris.MediaPlayer2.playerctld', identity: 'playerctld', state: { PlaybackStatus: 'Playing' } }, (l) => l.owned);
    await sleep(400);
    check('playerctld (a proxy of the active player) is not listed', players().map((p) => p.name), ['org.mpris.MediaPlayer2.fakeplayer']);
    await other.ask({ cmd: 'release' }, (l) => l.released);
    check('a player that leaves the bus leaves the list', !!(await until(() => players().length === 0, 4000)), true);
    // the Lecteur closes
    await call('mpris:self', null);
    check('mpris:self(null) (Lecteur closed) -> the name is released', !!(await until(async () => !(await names()).includes(SEL), 4000)), true);
    check('mpris:seeked without the Lecteur is harmless', await call('mpris:seeked', 3), false);
  } catch (e) {
    check('MPRIS flow', e.stack, '(no exception)');
  } finally {
    for (const p of [probe, other, dup]) p.quit();
    be?.stop();
    await sleep(300);
    bus.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
    for (const k of ['DBUS_SESSION_BUS_ADDRESS', 'AURORA_SESSIONBUS_HELPER', 'AURORA_SESSIONBUS_PYTHON']) {
      if (env0[k] === undefined) delete process.env[k];
      else process.env[k] = env0[k];
    }
  }
}

// ===================================================================== 3. UI
async function uiTests() {
  console.log('\n# shell on a private bus (FR, 1280x720)');
  const shots = [];
  const pyPath = spawnSync('sh', ['-c', `command -v ${PY}`], { encoding: 'utf8' }).stdout.trim();
  for (const theme of ['dark', 'light']) {
    const bus = startBus();
    // autostart fixtures: one entry that runs, one turned off in Moniteur système
    const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-sb-cfg-'));
    fs.mkdirSync(path.join(cfg, 'user', 'autostart'), { recursive: true });
    fs.mkdirSync(path.join(cfg, 'sys', 'autostart'), { recursive: true });
    fs.writeFileSync(path.join(cfg, 'sys', 'autostart', 'touch-on.desktop'), `[Desktop Entry]\nType=Application\nName=On\nExec=/usr/bin/touch ${cfg}/ran-on\n`);
    fs.writeFileSync(path.join(cfg, 'sys', 'autostart', 'touch-off.desktop'), `[Desktop Entry]\nType=Application\nName=Off\nExec=/usr/bin/touch ${cfg}/ran-off\n`);
    fs.writeFileSync(path.join(cfg, 'user', 'autostart', 'touch-off.desktop'), `[Desktop Entry]\nHidden=true\nX-GNOME-Autostart-enabled=false\nType=Application\nName=Off\nExec=/usr/bin/touch ${cfg}/ran-off\n`);
    const s = await launchShell({
      lang: 'fr',
      theme,
      size: '1280x720',
      settings: { finish: 'halo' },
      env: { DBUS_SESSION_BUS_ADDRESS: bus.address, AURORA_SESSIONBUS: '1', AURORA_SESSIONBUS_HELPER: HELPER, AURORA_SESSIONBUS_PYTHON: pyPath, AURORA_AUTOSTART: '1', XDG_CONFIG_HOME: path.join(cfg, 'user'), XDG_CONFIG_DIRS: path.join(cfg, 'sys') },
    });
    const P = s.page;
    const app = fakeApp(bus.address);
    try {
      check(`[${theme}] autostart: enabled entry ran, the one turned off did not`, [!!(await until(() => fs.existsSync(path.join(cfg, 'ran-on')), 8000)), fs.existsSync(path.join(cfg, 'ran-off'))], [true, false]);
      await app.wait((l) => l === 'READY', 8000);
      await until(async () => (await s.aurora(() => window.__aurora.api.invoke('sessionbus:status'))).notifications, 8000);
      app.send({ cmd: 'notify', args: ['Discussion', 0, 'mail-unread', 'Camille', 'Tu viens <b>ce soir</b> ? On part à 19 h.', ['default', 'Ouvrir', 'reply', 'Répondre', 'later', 'Plus tard'], { 'image-data': { w: 2, h: 2, channels: 4, data: [80, 120, 200, 255, 90, 130, 210, 255, 100, 140, 220, 255, 110, 150, 230, 255] } }, -1] });
      await P.waitForSelector('.toast:has-text("Camille")', { timeout: 8000 });
      const toast = await P.$eval('.toast:has-text("Camille")', (e) => ({ app: e.querySelector('.toast-head')?.textContent.trim(), body: e.querySelector('.toast-body')?.textContent, buttons: [...e.querySelectorAll('.toast-actions button')].map((b) => b.textContent), img: !!e.querySelector('img') }));
      check(`[${theme}] toast: app name, plain body, « Répondre » / « Plus tard » buttons (default action = click)`, toast, { app: 'Discussion', body: 'Tu viens ce soir ? On part à 19 h.', buttons: ['Répondre', 'Plus tard'], img: true });
      // tray item
      app.send({ cmd: 'sni', name: 'org.kde.StatusNotifierItem-4242-1' });
      await P.waitForSelector('#taskbar .tb-sni .tb-sni-item', { timeout: 8000 });
      check(`[${theme}] tray icon in the bar, before Réglages rapides, with its tooltip`, await P.$eval('#taskbar .tb-sni-item', (b) => [b.dataset.tip, !!b.querySelector('img[src^="data:image/png"]'), !!b.closest('.tb-tray')?.querySelector('.tb-sni + .tb-minis, .tb-sni ~ .tb-quick')]), ['Discussion — 3 messages non lus', true, true]);
      shots.push(await s.shot(`sessionbus-toast-fr-${theme}`));
      await P.click('.toast:has-text("Camille") .toast-actions button:has-text("Répondre")');
      check(`[${theme}] « Répondre » -> ActionInvoked(reply)`, (await app.wait((l) => l.signal === 'ActionInvoked'))?.key, 'reply');
      check(`[${theme}] then NotificationClosed(2), gone from the centre`, [(await app.wait((l) => l.signal === 'NotificationClosed'))?.reason, await s.aurora(() => window.__aurora.notifications.list().some((n) => n.title === 'Camille'))], [2, false]);
      // right click: the app's menu
      await P.click('#taskbar .tb-sni-item', { button: 'right' });
      await P.waitForSelector('.menu.tray-menu', { timeout: 5000 });
      const m = await P.$eval('.menu.tray-menu', (e) => ({ labels: [...e.querySelectorAll('.menu-item .label')].map((l) => l.textContent), seps: e.querySelectorAll('.menu-sep').length, disabled: [...e.querySelectorAll('.menu-item.disabled .label')].map((l) => l.textContent), checked: [...e.querySelectorAll('.menu-item')].filter((i) => i.querySelector('.check svg')).map((i) => i.querySelector('.label').textContent) }));
      check(`[${theme}] menu: labels, separator, disabled entry, checkmark`, m, { labels: ['Ouvrir la fenêtre', 'Mode silencieux', 'Indisponible', 'Plus', 'Quitter'], seps: 1, disabled: ['Indisponible'], checked: ['Mode silencieux'] });
      shots.push(await s.shot(`sessionbus-traymenu-fr-${theme}`));
      await P.click('.menu.tray-menu .menu-item:has-text("Mode silencieux")');
      check(`[${theme}] menu entry -> Event(3, clicked)`, (await app.wait((l) => l.call === 'Event'))?.id, 3);
      await P.click('#taskbar .tb-sni-item');
      check(`[${theme}] left click -> Activate`, !!(await app.wait((l) => l.call === 'Activate')), true);
      if (theme === 'dark') {
        // Ne pas déranger: kept in the centre, no toast; a critical one still shows
        await s.aurora(() => window.__aurora.settings.set('notifications.dnd', true));
        await P.waitForTimeout(200);
        app.send({ cmd: 'notify', args: ['Mises à jour', 0, '', 'Silencieuse', 'Rien à voir', [], {}, -1] });
        await until(async () => s.aurora(() => window.__aurora.notifications.list().some((n) => n.title === 'Silencieuse')), 5000);
        await P.waitForTimeout(300);
        check('[dark] Ne pas déranger: in the centre, no toast', await P.locator('.toast:has-text("Silencieuse")').count(), 0);
        app.send({ cmd: 'notify', args: ['Batterie', 0, '', 'Critique', 'Branchez le chargeur', [], { urgency: 2 }, -1] });
        check('[dark] critical notification still shows its toast', !!(await P.waitForSelector('.toast:has-text("Critique")', { timeout: 5000 }).catch(() => null)), true);
        await s.aurora(() => window.__aurora.settings.set('notifications.dnd', false));
        // NeedsAttention, then Passive hides it
        app.send({ cmd: 'status', value: 'NeedsAttention' });
        check('[dark] NeedsAttention marks the icon', !!(await P.waitForSelector('#taskbar .tb-sni-item.attention', { timeout: 5000 }).catch(() => null)), true);
        app.send({ cmd: 'status', value: 'Passive' });
        check('[dark] Passive hides it', await P.waitForSelector('#taskbar .tb-sni-item', { state: 'detached', timeout: 5000 }).then(() => true, () => false), true);
        app.send({ cmd: 'status', value: 'Active' });
        await P.waitForSelector('#taskbar .tb-sni-item', { timeout: 5000 });
      }
      app.quit();
      check(`[${theme}] icon leaves with its app`, await P.waitForSelector('#taskbar .tb-sni-item', { state: 'detached', timeout: 8000 }).then(() => true, () => false), true);
      const errs = s.logs.filter((l) => /\[pageerror\]|\[error\]/.test(l) && !/favicon|ERR_FILE_NOT_FOUND/.test(l));
      check(`[${theme}] no page errors`, errs, []);
    } catch (e) {
      check(`[${theme}] UI flow`, e.message, '(no exception)');
      await s.shot(`sessionbus-failure-${theme}`).catch(() => {});
    } finally {
      app.quit();
      await s.close();
      bus.stop();
      fs.rmSync(cfg, { recursive: true, force: true });
    }
  }
  console.log(`\nscreenshots:\n  ${shots.join('\n  ')}`);
}

if (haveDbusPython()) {
  await helperTests();
  await mprisTests();
  if (!ARGS.has('--unit')) await uiTests();
} else console.log(`\n# helper + UI: SKIPPED (${PY} without python3-dbus / python3-gi)`);
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
process.exit(0);
