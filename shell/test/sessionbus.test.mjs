// Linux app integration, part 1 (track "trayn"): desktop notifications (org.freedesktop.Notifications), the system
// tray (StatusNotifierWatcher + host, dbusmenu) and XDG autostart.
//   1. units: autostart planning (main/ipc/autostart.js), notification / tray item mapping and icon lookup
//      (main/ipc/sessionbus.js)
//   2. helper + backend against a fake app (test/fixtures/sessionbus/fake-app.py) and gdbus (an independent client,
//      like notify-send) on a PRIVATE dbus-daemon — never the machine's session bus
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
  if (!ARGS.has('--unit')) await uiTests();
} else console.log(`\n# helper + UI: SKIPPED (${PY} without python3-dbus / python3-gi)`);
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
process.exit(0);
