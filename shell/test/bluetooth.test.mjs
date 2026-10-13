// Bluetooth (track "bluetooth"): main/ipc/bluetooth.js, helpers/aurora-bluetooth, Paramètres > Bluetooth et
// appareils, the pairing dialog (core/features/bluetooth.js) and the Réglages rapides tile.
//   1. parsers: device kinds (BlueZ Icon, Class of Device, LE Appearance), rfkill --json, state normalisation
//   2. the real helper + backend against a FAKE BlueZ (test/fixtures/bluetooth/fake-bluez.py) on a private
//      dbus-daemon, with a fake rfkill on PATH — never the machine's system bus (needs python3 with dbus + gi:
//      AURORA_BT_PYTHON, default python3.12; skipped when missing)
//   3. UI in dev mode (simulated adapter): search, pair with the code dialog, connect / forget, the tile;
//      screenshots 1280x720 FR, Halo dark + light -> test/out/bluetooth-*.png
// Usage:  cd aurora-os/shell && xvfb-run -a -s "-screen 0 1600x900x24" node test/bluetooth.test.mjs [--unit]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HELPER = path.join(ROOT, '..', 'rootfs', 'usr', 'lib', 'aurora', 'helpers', 'aurora-bluetooth');
const FAKE = path.join(ROOT, 'test', 'fixtures', 'bluetooth', 'fake-bluez.py');
const ARGS = new Set(process.argv.slice(2));

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

// ===================================================================== 1. parsers
console.log('\n# parsers');
{
  const { parsers: P } = require(path.join(ROOT, 'main', 'ipc', 'bluetooth.js'));
  const k = P.deviceKind;
  check('kind from BlueZ Icon', ['audio-headphones', 'audio-headset', 'input-mouse', 'input-keyboard', 'input-gaming', 'phone', 'audio-card'].map((icon) => k({ icon })), ['headphones', 'headset', 'mouse', 'keyboard', 'gamepad', 'phone', 'speaker']);
  check('kind from Class of Device (no Icon)', [0x240404, 0x002540, 0x002580, 0x002508, 0x5a020c, 0x3c010c, 0x240418].map((c) => k({ class: c })), ['headset', 'keyboard', 'mouse', 'gamepad', 'phone', 'computer', 'headphones']);
  check('kind from LE Appearance', [0x03c1, 0x03c2, 0x03c4, 0x0941].map((appearance) => k({ appearance })), ['keyboard', 'mouse', 'gamepad', 'headphones']);
  check('unknown device -> other', k({}), 'other');
  check('rfkill --json: bluetooth soft-blocked', P.parseRfkill(JSON.stringify({ rfkilldevices: [{ id: 0, type: 'wlan', device: 'phy0', soft: 'unblocked', hard: 'unblocked' }, { id: 1, type: 'bluetooth', device: 'hci0', soft: 'blocked', hard: 'unblocked' }] })), { soft: true, hard: false });
  check('rfkill --json: hard block, no bluetooth, garbage', [P.parseRfkill('{"rfkilldevices":[{"type":"bluetooth","soft":"unblocked","hard":"blocked"}]}'), P.parseRfkill('{"rfkilldevices":[]}'), P.parseRfkill('nope')], [{ soft: false, hard: true }, null, null]);
  const raw = {
    available: true,
    adapter: { address: '00:1A:7D:DA:71:13', name: 'selene', powered: true, discovering: true },
    devices: [
      { address: '11:22:33:44:55:66', name: 'Pixel', icon: 'phone', paired: false, rssi: -70 },
      { address: 'aa:bb:cc:dd:ee:01', name: 'Near', icon: 'audio-card', paired: false, rssi: -40 },
      { address: '22:22:22:22:22:22', name: '22-22-22-22-22-22', hasName: false, paired: false },
      { address: 'E4:17:D8:00:00:01', name: 'Clavier', icon: 'input-keyboard', paired: true, connected: false },
      { address: 'AC:80:0A:12:34:56', name: 'Casque', icon: 'audio-headphones', paired: true, connected: true, battery: 80 },
      { address: 'BAD', name: 'bad' },
      { address: '33:33:33:33:33:33', name: 'Blocked', paired: true, blocked: true },
    ],
  };
  const st = P.normalizeState(raw, { soft: false, hard: false });
  check('state: paired+connected first, then paired, then nearby by signal; nameless / blocked / bad dropped', st.devices.map((d) => d.name), ['Casque', 'Clavier', 'Near', 'Pixel']);
  check('state: battery, kind, upper-case address', [st.devices[0].battery, st.devices[0].kind, st.devices[2].address], [80, 'headphones', 'AA:BB:CC:DD:EE:01']);
  check('state: powered + discovering', [st.available, st.powered, st.discovering, st.blocked], [true, true, true, null]);
  const bl = P.normalizeState({ ...raw, adapter: { ...raw.adapter, powered: false, powerState: 'off-blocked' } }, null);
  check('state: off-blocked adapter -> blocked soft, not powered', [bl.blocked, bl.powered], ['soft', false]);
  check('state: hard rfkill wins', P.normalizeState(raw, { soft: true, hard: true }).blocked, 'hard');
  check('state: no adapter', P.normalizeState({ available: false, adapter: null, devices: [] }), (s) => s.available === false && s.reason === 'noadapter' && s.devices.length === 0);
  check('state: discoverable only while powered', [P.normalizeState({ ...raw, adapter: { ...raw.adapter, discoverable: true } }, null).discoverable, P.normalizeState({ ...raw, adapter: { ...raw.adapter, discoverable: true, powered: false } }, null).discoverable], [true, false]);
  // error codes said in French (and English), never BlueZ's English text inside a sentence
  const i18n = JSON.parse(fs.readFileSync(path.join(ROOT, 'renderer', 'apps', 'settings', 'i18n.json'), 'utf8'));
  const page = fs.readFileSync(path.join(ROOT, 'renderer', 'apps', 'settings', 'pages', 'bluetooth.js'), 'utf8');
  const keys = ['errNotReady', 'errInProgress', 'errRfkill', 'errGenericNamed', 'errGenericPlain', 'visibleDesc', 'onPlain'];
  check('i18n: FR + EN messages for ENOTREADY / EINPROGRESS / ERFKILL / generic, without {msg}', ['en', 'fr'].flatMap((l) => keys.map((k) => i18n[l].bt[k])).every((v) => v && !v.includes('{msg}')), true);
  check('page: each error code has its own sentence (ENOADAPTER, ENOSERVICE too); the raw text only in the log', ['ENOTREADY', 'EINPROGRESS', 'ERFKILL', 'ENOADAPTER', 'ENOSERVICE'].every((c) => page.includes(`'${c}'`)) && !/errGeneric'/.test(page) && /console\.warn\('\[bluetooth\]'/.test(page), true);
}

// ===================================================================== 2. helper + backend vs fake BlueZ
async function helperTests() {
  const PY = process.env.AURORA_BT_PYTHON || 'python3.12';
  if (spawnSync(PY, ['-c', 'import dbus, gi; from gi.repository import GLib'], { stdio: 'ignore' }).status !== 0) {
    console.log(`\n# helper: SKIPPED (${PY} without python3-dbus / python3-gi)`);
    return;
  }
  console.log('\n# helper + backend against a fake BlueZ on a private bus');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-bt-'));
  const bus = spawnSync('dbus-daemon', ['--session', '--fork', '--print-address=1', '--print-pid=1', `--address=unix:path=${tmp}/bus`], { encoding: 'utf8' });
  const [address, pid] = bus.stdout.trim().split('\n');
  // fake rfkill: state in a file, "unblock bluetooth" clears the soft block, calls logged
  const bin = path.join(tmp, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(tmp, 'rfkill.state'), 'blocked');
  fs.writeFileSync(
    path.join(bin, 'rfkill'),
    `#!/bin/sh\necho "$*" >> "${tmp}/rfkill.log"\nif [ "$1" = unblock ] && [ "$2" = bluetooth ]; then echo unblocked > "${tmp}/rfkill.state"; exit 0; fi\nif [ "$1" = --json ]; then printf '{"rfkilldevices":[{"id":0,"type":"bluetooth","device":"hci0","soft":"%s","hard":"unblocked"}]}\\n' "$(cat "${tmp}/rfkill.state")"; exit 0; fi\nexit 1\n`,
    { mode: 0o755 },
  );
  const env0 = { ...process.env };
  Object.assign(process.env, { AURORA_BT_AGENT_TIMEOUT: '3', DBUS_SYSTEM_BUS_ADDRESS: address, AURORA_BT_HELPER: HELPER, AURORA_BT_PYTHON: spawnSync('sh', ['-c', `command -v ${PY}`], { encoding: 'utf8' }).stdout.trim(), PATH: `${bin}:${process.env.PATH}` });
  delete process.env.AURORA_BT_DEV;
  const fake = spawn(PY, ['-I', FAKE], { env: process.env, stdio: ['ignore', 'pipe', 'inherit'] });
  let fakeOut = '';
  fake.stdout.on('data', (d) => (fakeOut += d));
  let be = null;
  try {
    check('fake BlueZ is up', await until(() => fakeOut.includes('READY'), 8000), (v) => !!v);
    // fresh module instance (HELPER / PATH are read when it loads)
    for (const k of Object.keys(require.cache)) if (/main[\\/](ipc[\\/]bluetooth|lib[\\/]exec)\.js$/.test(k)) delete require.cache[k];
    const register = require(path.join(ROOT, 'main', 'ipc', 'bluetooth.js'));
    const handlers = new Map();
    const events = [];
    be = register({ DEV: false, handle: (c, f) => handlers.set(c, f), broadcast: (ch, p) => events.push([ch, p]), error: (m, c) => Object.assign(new Error(m), { code: c }) });
    const call = async (ch, ...a) => {
      try {
        return await handlers.get(ch)(...a);
      } catch (e) {
        return { ERR: e.code, msg: e.message };
      }
    };
    const last = () => [...events].reverse().find(([ch]) => ch === 'bluetooth:changed')?.[1];
    let st = await call('bluetooth:status');
    check('agent registered as KeyboardDisplay + default agent', await until(() => /RegisterAgent \/org\/selene\/bluetooth\/agent KeyboardDisplay[\s\S]*RequestDefaultAgent/.test(fakeOut)), (v) => !!v);
    check('status: adapter, paired devices with battery, soft rfkill block', [st.available, st.name, st.blocked, st.powered, st.devices.map((d) => `${d.name}|${d.kind}|${d.paired}|${d.connected}|${d.battery}`)], [true, 'selene', 'soft', false, ['Casque WH-1000XM4|headphones|true|true|80', 'Clavier K380|keyboard|true|false|null']]);
    // the Bluetooth page opens while the adapter is off: remembered, applied once it is on (BlueZ refuses before)
    check('visible (page open) while off: accepted, not discoverable yet', [await call('bluetooth:visible', true), st.discoverable], [true, false]);
    check('turn on: rfkill unblock as the user, then Powered', await call('bluetooth:setPowered', true), true);
    check('rfkill was called with "unblock bluetooth"', fs.readFileSync(path.join(tmp, 'rfkill.log'), 'utf8').includes('unblock bluetooth'), true);
    st = await call('bluetooth:status');
    check('status: powered, not blocked', [st.powered, st.blocked], [true, null]);
    check('turned on with the page open: discoverable (lease of 180 s, renewed)', [!!(await until(async () => (await call('bluetooth:status')).discoverable)), /ADAPTER DiscoverableTimeout=180[\s\S]*ADAPTER Discoverable=1/.test(fakeOut)], [true, true]);
    await call('bluetooth:visible', false);
    check('page closed: not discoverable any more', !!(await until(async () => !(await call('bluetooth:status')).discoverable && fakeOut.includes('ADAPTER Discoverable=0'))), true);
    check('scan starts (discovery)', await call('bluetooth:scan', true), true);
    const found = await until(() => last()?.devices?.filter((d) => !d.paired).length === 3 && last());
    check('nearby devices pushed by bluetooth:changed (keyboard, gamepad, phone; discovering)', found && [found.discovering, found.devices.filter((d) => !d.paired).map((d) => `${d.name}|${d.kind}`)], [true, ['Clavier MX Keys|keyboard', 'Manette sans fil|gamepad', 'Pixel 8 de Camille|phone']]);
    check('discoverable while a search runs', !!(await until(async () => (await call('bluetooth:status')).discoverable)), true);
    // pairing the phone: the agent asks to confirm 123456
    const pairing = call('bluetooth:pair', '11:22:33:44:55:66');
    const ask = await until(() => events.find(([ch, p]) => ch === 'bluetooth:agent' && p.kind === 'confirm')?.[1]);
    check('agent request: confirm passkey 123456 for the phone', ask && [ask.passkey, ask.name, ask.deviceKind, ask.address], ['123456', 'Pixel 8 de Camille', 'phone', '11:22:33:44:55:66']);
    check('agent reply accepted', await call('bluetooth:agentReply', { req: ask?.req, accept: true }), true);
    check('pair resolves', await pairing, true);
    const after = await until(() => last()?.devices?.find((d) => d.address === '11:22:33:44:55:66' && d.paired && d.connected));
    check('phone paired, trusted and connected', !!after, true);
    // gamepad: PIN request, wrong PIN -> EAUTH; rejected -> EREJECTED
    let p2 = call('bluetooth:pair', '77:88:99:AA:BB:CC');
    let pin = await until(() => events.find(([ch, p]) => ch === 'bluetooth:agent' && p.kind === 'pin')?.[1]);
    check('agent request: PIN for the gamepad', pin?.deviceKind, 'gamepad');
    await call('bluetooth:agentReply', { req: pin.req, accept: true, value: '1234' });
    check('wrong PIN -> EAUTH', (await p2).ERR, 'EAUTH');
    events.length = 0;
    p2 = call('bluetooth:pair', '77:88:99:AA:BB:CC');
    pin = await until(() => events.find(([ch, p]) => ch === 'bluetooth:agent' && p.kind === 'pin')?.[1]);
    await call('bluetooth:agentReply', { req: pin.req, accept: false });
    check('declined -> EREJECTED', (await p2).ERR, 'EREJECTED');
    // a request BlueZ never answers nor cancels is dropped (AURORA_BT_AGENT_TIMEOUT=3 here, 65 s by default)
    events.length = 0;
    p2 = call('bluetooth:pair', '77:88:99:AA:BB:CC');
    pin = await until(() => events.find(([ch, p]) => ch === 'bluetooth:agent' && p.kind === 'pin')?.[1]);
    const dropped = await until(() => events.find(([ch, p]) => ch === 'bluetooth:agent' && p.kind === 'cancel' && p.req === pin?.req), 6000);
    check('unanswered PIN request dropped after the timeout (dialog closed, pairing refused)', [!!dropped, (await p2).ERR, await call('bluetooth:agentReply', { req: pin?.req, accept: true, value: '0000' })], [true, 'EREJECTED', false]);
    // keyboard: the code to type, sent again as keys are typed, then BlueZ cancels -> the code dialog closes
    events.length = 0;
    const p3 = call('bluetooth:pair', 'DD:EE:FF:00:11:22');
    const shown = await until(() => events.filter(([ch, p]) => ch === 'bluetooth:agent' && p.kind === 'display-passkey').length === 2 && events.some(([ch, p]) => ch === 'bluetooth:agent' && p.kind === 'cancel') && events);
    const codes = (shown || []).filter(([ch]) => ch === 'bluetooth:agent').map(([, p]) => `${p.kind}|${p.req}|${p.passkey ?? ''}|${p.address}`);
    check('display-passkey twice (req 0), then a cancel for that address', codes, ['display-passkey|0|048213|DD:EE:FF:00:11:22', 'display-passkey|0|048213|DD:EE:FF:00:11:22', 'cancel|0||DD:EE:FF:00:11:22']);
    check('keyboard pairing cancelled -> ECANCELED', (await p3).ERR, 'ECANCELED');
    check('PIN with a shell metacharacter refused before reaching the helper', (await call('bluetooth:agentReply', { req: 1, accept: true, value: '0;rm' })).ERR, 'EINVAL');
    check('disconnect / connect the headphones', [await call('bluetooth:disconnect', 'AC:80:0A:12:34:56'), await call('bluetooth:connect', 'ac:80:0a:12:34:56')], [true, true]);
    check('forget the keyboard', await call('bluetooth:forget', 'E4:17:D8:00:00:01'), true);
    check('keyboard gone', !!(await until(() => last() && !last().devices.some((d) => d.address === 'E4:17:D8:00:00:01'))), true);
    check('invalid address -> EINVAL', [(await call('bluetooth:pair', '11:22:33')).ERR, (await call('bluetooth:connect', 'AA:BB:CC:DD:EE:FF; reboot')).ERR], ['EINVAL', 'EINVAL']);
    check('unknown device -> ENOTFOUND', (await call('bluetooth:connect', '00:00:00:00:00:01')).ERR, 'ENOTFOUND');
    check('stop the scan', await call('bluetooth:scan', false), true);
    check('search over: not discoverable', !!(await until(async () => !(await call('bluetooth:status')).discoverable)), true);
    // the helper exits (shell quits / restarts it) while the page is open: the computer is hidden again
    await call('bluetooth:visible', true);
    await until(async () => (await call('bluetooth:status')).discoverable);
    const hidden = fakeOut.split('ADAPTER Discoverable=0').length;
    be.stop();
    check('helper stopped (SIGTERM): Discoverable set back to false', !!(await until(() => fakeOut.split('ADAPTER Discoverable=0').length > hidden, 5000)), true);
    check('turn off', [await call('bluetooth:setPowered', false), (await call('bluetooth:status')).powered], [true, false]);
  } finally {
    be?.stop?.();
    fake.kill();
    try {
      process.kill(Number(pid));
    } catch {}
    for (const k of Object.keys(env0)) process.env[k] = env0[k];
    for (const k of ['DBUS_SYSTEM_BUS_ADDRESS', 'AURORA_BT_HELPER', 'AURORA_BT_PYTHON', 'AURORA_BT_AGENT_TIMEOUT']) if (!(k in env0)) delete process.env[k];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ===================================================================== 3. UI (dev mode)
async function uiTests() {
  const { launchShell } = await import('./lib.mjs');
  const shots = [];
  for (const theme of ['dark', 'light']) {
    console.log(`\n# UI — FR, Halo ${theme}, 1280x720`);
    const s = await launchShell({ lang: 'fr', theme, size: '1280x720', env: { AURORA_BT_SCAN_MS: '60000' } });
    const P = s.page;
    try {
      await s.aurora(() => window.__aurora.registry.launch('settings', { page: 'bluetooth' }));
      await P.waitForSelector('.st-bt .st-bt-dev', { timeout: 15000 });
      const title = await P.textContent('.app-settings h1, .app-settings .st-title').catch(() => '');
      check(`[${theme}] page title « Bluetooth et appareils »`, title, (v) => /Bluetooth et appareils/.test(v || ''));
      const mine = await P.$$eval('.st-bt .st-bt-dev .st-row-title', (els) => els.map((e) => e.textContent));
      check(`[${theme}] « Mes appareils » lists the paired devices`, mine, ['Casque WH-1000XM4', 'Souris MX Master 3', 'Clavier K380']);
      check(`[${theme}] battery shown once (badge, read as « Batterie 80 % »), not in the description`, [await P.textContent('.st-bt-dev .st-row-desc'), await P.textContent('.st-bt-dev .st-bt-batt'), await P.getAttribute('.st-bt-dev .st-bt-batt', 'aria-label')], ['Connecté', '80 %', 'Batterie 80 %']);
      await P.waitForFunction(() => /visible sous le nom/.test(document.querySelector('.st-bt .st-row[data-section="bluetooth"] .st-row-desc')?.textContent || ''), null, { timeout: 5000 }).catch(() => {});
      check(`[${theme}] page open: « visible sous le nom « selene » tant que cette page est ouverte »`, [await P.textContent('.st-bt .st-row[data-section="bluetooth"] .st-row-desc'), (await s.aurora(() => window.__aurora.api.invoke('bluetooth:status'))).discoverable], ['Activé — visible sous le nom « selene » tant que cette page est ouverte', true]);
      check(`[${theme}] mouse / typing / printers rows kept below`, await P.$$eval('.st-bt .st-group-title', (els) => els.map((e) => e.textContent)), (v) => v.includes('Mes appareils') && v.includes('Appareils à proximité') && v.length >= 3);
      await P.click('.st-bt-search');
      await P.waitForSelector('text=Clavier MX Keys', { timeout: 5000 });
      await P.waitForTimeout(600);
      check(`[${theme}] search: « Recherche… » and nearby devices`, await P.$$eval('.st-bt-nearby .st-row-title', (els) => els.map((e) => e.textContent)), ['Pixel 8 de Camille', 'Clavier MX Keys', 'Manette sans fil', 'JBL Flip 6']);
      shots.push(await s.shot(`bluetooth-page-fr-${theme}`));
      // pair the phone -> the Selene dialog with the code
      await P.click('.st-bt-nearby .st-bt-dev:has-text("Pixel 8 de Camille") button');
      await P.waitForSelector('.bt-agent-dialog', { timeout: 5000 });
      await P.waitForTimeout(450); // dialog fade-in
      const q = await P.textContent('.bt-agent-dialog');
      check(`[${theme}] pairing dialog asks « Le code 123456 s’affiche-t-il sur l’appareil ? »`, q, (v) => v.includes('Le code 123456 s’affiche-t-il sur l’appareil ?') && v.includes('123 456') && v.includes('Associer « Pixel 8 de Camille »'));
      shots.push(await s.shot(`bluetooth-pair-fr-${theme}`));
      await P.click('.bt-agent-dialog button:has-text("Oui, associer")');
      await P.waitForFunction(() => [...document.querySelectorAll('.st-bt .st-group')].find((g) => g.textContent.includes('Mes appareils'))?.textContent.includes('Pixel 8 de Camille'), null, { timeout: 5000 });
      check(`[${theme}] phone moved to « Mes appareils »`, true, true);
      check(`[${theme}] success message`, await P.textContent('.app-settings').then((v) => v.includes('« Pixel 8 de Camille » est associé')), true);
      if (theme === 'dark') {
        // gamepad: PIN dialog, wrong format refused in the dialog, right PIN pairs
        await P.click('.st-bt-nearby .st-bt-dev:has-text("Manette sans fil") button');
        await P.waitForSelector('.bt-agent-dialog input', { timeout: 5000 });
        await P.fill('.bt-agent-dialog input', '00 00');
        await P.click('.bt-agent-dialog button:has-text("Associer")');
        check('[dark] PIN with a space refused in the dialog', await P.textContent('.bt-agent-dialog'), (v) => v.includes('seulement des chiffres et des lettres'));
        await P.fill('.bt-agent-dialog input', '0000');
        await P.waitForTimeout(300);
        check('[dark] PIN error cleared once the PIN is corrected', await P.textContent('.bt-agent-dialog'), (v) => !v.includes('seulement des chiffres et des lettres'));
        shots.push(await s.shot('bluetooth-pin-fr-dark'));
        await P.click('.bt-agent-dialog button:has-text("Associer")');
        await P.waitForFunction(() => [...document.querySelectorAll('.st-bt .st-group')].find((g) => g.textContent.includes('Mes appareils'))?.textContent.includes('Manette sans fil'), null, { timeout: 5000 });
        check('[dark] gamepad paired with PIN 0000', true, true);
        // keyboard: the code to type on it; sent again as keys are typed (updated in place), closes by itself once paired
        await P.click('.st-bt-nearby .st-bt-dev:has-text("Clavier MX Keys") button');
        await P.waitForSelector('.bt-agent-dialog .bt-code', { timeout: 5000 });
        await P.$eval('.bt-agent-dialog', (e) => (e.dataset.first = '1'));
        await P.waitForTimeout(1000); // the code is sent again at 700 ms
        check('[dark] passkey dialog: « Tapez 482913 sur l’appareil », same dialog after the code is sent again', [await P.textContent('.bt-agent-dialog .bt-display-line'), await P.textContent('.bt-agent-dialog .bt-code'), await P.locator('.bt-agent-dialog[data-first="1"]').count(), await P.locator('.bt-agent-dialog').count()], ['Tapez 482913 sur l’appareil, puis appuyez sur Entrée.', '482 913', 1, 1]);
        shots.push(await s.shot('bluetooth-passkey-fr-dark'));
        await P.waitForSelector('.bt-agent-dialog', { state: 'detached', timeout: 6000 });
        await P.waitForFunction(() => [...document.querySelectorAll('.st-bt .st-group')].find((g) => g.textContent.includes('Mes appareils'))?.textContent.includes('Clavier MX Keys'), null, { timeout: 5000 });
        check('[dark] keyboard paired: the code dialog closed by itself', true, true);
        // disconnect + forget the keyboard (confirm dialog)
        await P.click('.st-bt-dev:has-text("Casque WH-1000XM4") button:has-text("Déconnecter")');
        await P.waitForSelector('.st-bt-dev:has-text("Casque WH-1000XM4") button:has-text("Connecter")', { timeout: 5000 });
        check('[dark] disconnect -> « Connecter »', true, true);
        await P.click('.st-bt-dev:has-text("Clavier K380") .st-bt-forget');
        await P.waitForSelector('.dialog:has-text("Oublier cet appareil ?")', { timeout: 5000 });
        await P.click('.dialog:has-text("Oublier cet appareil ?") button:has-text("Oublier")');
        await P.waitForFunction(() => !document.querySelector('.st-bt')?.textContent.includes('Clavier K380'), null, { timeout: 5000 });
        check('[dark] keyboard forgotten', true, true);
      }
      // quick settings tile
      await P.click('.tb-quick');
      await P.waitForSelector('.qs-tile[data-key="bluetooth"]', { timeout: 5000 });
      check(`[${theme}] quick tile on, names a connected device`, await P.$eval('.qs-tile[data-key="bluetooth"]', (e) => [e.classList.contains('on'), e.querySelector('.qs-tile-sub')?.textContent]), (v) => v[0] === true && /Souris MX Master 3|Pixel 8 de Camille|Casque/.test(v[1]));
      shots.push(await s.shot(`bluetooth-quick-fr-${theme}`));
      await P.click('.qs-tile[data-key="bluetooth"] .qs-tile-main');
      await P.waitForSelector('.qs-tile[data-key="bluetooth"]:not(.on)', { timeout: 5000 });
      check(`[${theme}] tile toggles Bluetooth off`, await P.textContent('.qs-tile[data-key="bluetooth"] .qs-tile-sub'), 'Désactivé');
      await P.keyboard.press('Escape');
      await P.waitForSelector('.st-bt .infobar, .st-bt [class*="infobar"]', { timeout: 5000 });
      check(`[${theme}] page follows: « Le Bluetooth est désactivé »`, await P.textContent('.st-bt'), (v) => v.includes('Le Bluetooth est désactivé'));
      if (theme === 'light') shots.push(await s.shot('bluetooth-off-fr-light'));
      // back on from the page switch
      await P.click('.st-bt .st-row[data-section="bluetooth"] .toggle');
      await P.waitForSelector('.st-bt .st-bt-dev', { timeout: 5000 });
      check(`[${theme}] page switch turns it back on`, true, true);
      // tile arrow opens the page
      await P.click('.tb-quick');
      await P.waitForSelector('.qs-tile[data-key="bluetooth"] .qs-tile-more', { timeout: 5000 });
      await P.click('.qs-tile[data-key="bluetooth"] .qs-tile-more');
      await P.waitForTimeout(500);
      check(`[${theme}] tile arrow closes the flyout`, await s.aurora(() => window.__aurora.quick?.isOpen ?? false), false);
      // leaving the page: not discoverable any more
      await s.aurora(() => window.__aurora.registry.launch('settings', { page: 'printers' }));
      check(`[${theme}] page left: not discoverable`, !!(await until(async () => !(await s.aurora(() => window.__aurora.api.invoke('bluetooth:status'))).discoverable)), true);
      const errs = s.logs.filter((l) => /\[pageerror\]|\[error\]/.test(l) && !/favicon|ERR_FILE_NOT_FOUND/.test(l));
      check(`[${theme}] no page errors`, errs, []);
    } catch (e) {
      check(`[${theme}] UI flow`, e.message, '(no exception)');
      await s.shot(`bluetooth-failure-${theme}`).catch(() => {});
    } finally {
      await s.close();
    }
  }
  // no adapter + hardware switch
  for (const [variant, expect] of [
    ['none', 'Aucun adaptateur Bluetooth'],
    ['hard', 'Rallumez-le avec le bouton ou la touche Bluetooth'],
  ]) {
    const s = await launchShell({ lang: 'fr', theme: 'dark', size: '1280x720', env: { AURORA_BT_DEV: variant } });
    try {
      await s.aurora(() => window.__aurora.registry.launch('settings', { page: 'bluetooth' }));
      await s.page.waitForSelector('.st-bt .st-row', { timeout: 15000 });
      await s.page.waitForTimeout(300);
      check(`AURORA_BT_DEV=${variant}: « ${expect} »`, await s.page.textContent('.st-bt'), (v) => v.includes(expect));
      await s.page.click('.tb-quick');
      await s.page.waitForTimeout(400);
      check(`AURORA_BT_DEV=${variant}: tile ${variant === 'none' ? 'hidden' : 'shown off'}`, await s.page.$eval('.qs-tile[data-key="bluetooth"]', (e) => !e.classList.contains('on')).catch(() => 'absent'), variant === 'none' ? 'absent' : true);
      if (variant === 'hard') shots.push(await s.shot('bluetooth-hardblock-fr-dark'));
    } finally {
      await s.close();
    }
  }
  console.log(`\nscreenshots:\n  ${shots.join('\n  ')}`);
}

await helperTests();
if (!ARGS.has('--unit')) await uiTests();
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
process.exit(0);
