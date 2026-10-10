// System backends + Settings app test.
//
//   xvfb-run -a -s "-screen 0 1600x900x24" node test/system-settings.test.mjs [--unit] [--skip-dark]
//
// 1. Unit tests of the backend parsers against captured outputs of nmcli, wpctl, pactl, xrandr,
//    timedatectl, setxkbmap, xinput, /proc and /sys files (no Electron needed).
// 2. The privileged helper (aurora-admin) argument validation and aurora-apply-display's parser.
// 3. End-to-end: the real shell (dev mode = simulated system) driven through the Settings UI —
//    every setting is checked to really take effect (settings store, DOM of the shell, backends).
// 4. Screenshots: light/en and dark/fr, copied to docs/screenshots/settings-*.png.
import { launchShell, ROOT, OUT } from './lib.mjs';
import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ARGS = new Set(process.argv.slice(2));
const DOCS = path.join(ROOT, '..', 'docs', 'screenshots');
const REPO = path.join(ROOT, '..');
let passed = 0;
const failures = [];
function check(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  ok  ${msg}`);
  } else {
    failures.push(msg);
    console.log(`  FAIL ${msg}`);
  }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ===================================================================== 1. parsers
console.log('\n# Backend parsers');
{
  const { parsers: n } = require('../main/ipc/net.js');
  check(eq(n.splitTerse('a\\:b:c\\\\d:e'), ['a:b', 'c\\d', 'e']), 'nmcli terse split honours \\: and \\\\ escapes');
  check(eq(n.splitTerse('KEY:v\\:a:b', 2), ['KEY', 'v:a:b']), 'nmcli terse split with a field limit');
  const devs = n.parseDeviceStatus(['enp0s3:ethernet:connected:Wired connection 1', 'wlp2s0:wifi:connected:Café\\:Wifi', 'lo:loopback:connected (externally):lo', 'p2p-dev-wlp2s0:wifi-p2p:disconnected:', 'docker0:bridge:connected (externally):docker0', 'wwan0:gsm:unavailable:--'].join('\n'));
  check(eq(devs.map((d) => d.device), ['enp0s3', 'wlp2s0', 'wwan0']) && devs[1].connection === 'Café:Wifi' && devs[2].type === 'wwan' && devs[2].connection === null, 'nmcli device status: types, escaped connection names, ignored virtual devices');
  const wl = n.parseWifiList(
    [
      '*:Café\\:Wifi:A4\\:3E\\:51\\:0C\\:22\\:10:86:WPA2:5180 MHz:36:540 Mbit/s',
      ' :Livebox-4F2A:7C\\:26\\:64\\:4F\\:2A\\:01:67:WPA1 WPA2:2437 MHz:6:195 Mbit/s',
      ' :Livebox-4F2A:7C\\:26\\:64\\:4F\\:2A\\:02:72:WPA1 WPA2:5240 MHz:48:270 Mbit/s',
      ' :--:00\\:11\\:22\\:33\\:44\\:55:40::2412 MHz:1:54 Mbit/s',
      ' :Open Net::33::2462 MHz:11:65 Mbit/s',
      ':Back\\\\slash:11\\:22\\:33\\:44\\:55\\:66:20:WPA3:2412 MHz:1:54 Mbit/s',
    ].join('\n'),
    new Set(['Livebox-4F2A']),
  );
  check(wl.length === 4 && wl[0].ssid === 'Café:Wifi' && wl[0].active && wl[0].bssid === 'A4:3E:51:0C:22:10' && wl[0].freq === 5180, 'wifi list: active first, escaped SSID and BSSID, frequency');
  check(wl[1].ssid === 'Livebox-4F2A' && wl[1].signal === 72 && wl[1].saved && wl[1].chan === 48, 'wifi list: one entry per SSID (strongest access point), saved flag');
  check(wl.some((x) => x.ssid === 'Open Net' && x.security === '') && wl.some((x) => x.ssid === 'Back\\slash') && !wl.some((x) => x.ssid === '--'), 'wifi list: open networks, backslash SSIDs, hidden networks skipped');
  const show = n.parseDeviceShow(
    [
      'GENERAL.DEVICE:enp0s3',
      'GENERAL.TYPE:ethernet',
      'GENERAL.HWADDR:52\\:54\\:00\\:12\\:34\\:56',
      'GENERAL.MTU:1500',
      'GENERAL.STATE:100 (connected)',
      'GENERAL.CONNECTION:Wired connection 1',
      'CAPABILITIES.SPEED:1000 Mb/s',
      'WIRED-PROPERTIES.CARRIER:on',
      'IP4.ADDRESS[1]:10.0.2.15/24',
      'IP4.GATEWAY:10.0.2.2',
      'IP4.ROUTE[1]:dst = 0.0.0.0/0, nh = 10.0.2.2, mt = 100',
      'IP4.DNS[1]:10.0.2.3',
      'IP4.DNS[2]:9.9.9.9',
      'IP6.ADDRESS[1]:fec0\\:\\:5054\\:ff\\:fe12\\:3456/64',
      'IP6.ADDRESS[2]:fe80\\:\\:5054\\:ff\\:fe12\\:3456/64',
      'IP6.GATEWAY:fe80\\:\\:2',
      'IP6.DNS[1]:--',
    ].join('\n'),
  );
  check(show.mac === '52:54:00:12:34:56' && show.state === 'connected' && show.speed === 1000 && show.carrier === true && show.mtu === 1500, 'device show: MAC, state, link speed, carrier');
  check(eq(show.ipv4, ['10.0.2.15/24']) && eq(show.dns4, ['10.0.2.3', '9.9.9.9']) && eq(show.ipv6, ['fec0::5054:ff:fe12:3456/64']) && show.gateway6 === 'fe80::2' && eq(show.dns6, []), 'device show: IPv4/IPv6 lists (link-local hidden when a global address exists)');
  const route = 'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\nwlp2s0\t00000000\t0101A8C0\t0003\t0\t0\t600\t00000000\t0\t0\t0\nenp0s3\t00000000\t0202000A\t0003\t0\t0\t100\t00000000\t0\t0\t0\nenp0s3\t0002000A\t00000000\t0001\t0\t0\t100\t00FFFFFF\t0\t0\t0\n';
  check(n.parseDefaultRoute(route) === 'enp0s3', '/proc/net/route: default route with the lowest metric');
  const dev = 'Inter-|   Receive                                                |  Transmit\n face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n    lo:  123456     100    0    0    0     0          0         0   123456     100    0    0    0     0       0          0\nenp0s3: 734003200  500000    0    0    0     0          0         0 52428800  30000    0    0    0     0       0          0\n';
  check(eq(n.parseProcNetDev(dev), [{ iface: 'enp0s3', rx: 734003200, tx: 52428800 }]), '/proc/net/dev: per-interface totals without lo');
  check(n.mapConnectivity('full', 'connected') === 'full' && n.mapConnectivity('portal', 'connected (site only)') === 'limited' && n.mapConnectivity('unknown', 'connected') === 'full' && n.mapConnectivity('none', 'disconnected') === 'none', 'connectivity mapping (full / portal / unknown / none)');
  check(n.isAuthError('Error: Connection activation failed: (7) Secrets were required, but not provided.') && !n.isAuthError("Error: No network with SSID 'x' found."), 'wrong Wi-Fi key detection');
}
{
  const { parsers: a } = require('../main/ipc/audio.js');
  const wp = `PipeWire 'pipewire-0' [1.0.5, aurora@aurora, cookie:3405563733]
 └─ Clients:
        31. WirePlumber                         [1.0.5, aurora@aurora, pid:1236]

Audio
 ├─ Devices:
 │      40. Built-in Audio                      [alsa]
 │
 ├─ Sinks:
 │  *   46. Built-in Audio Analog Stereo        [vol: 0.40]
 │      51. HDMI / DisplayPort 1 Output         [vol: 1.00 MUTED]
 │
 ├─ Sink endpoints:
 │
 ├─ Sources:
 │  *   47. Built-in Audio Analog Stereo        [vol: 0.74]
 │
 ├─ Source endpoints:
 │
 └─ Streams:
        62. Firefox
             63. output_FL       > Built-in Audio:playback_FL	[active]

Video
 ├─ Devices:
 │      45. Integrated Camera                   [v4l2]
 │
 ├─ Sources:
 │  *   49. Integrated Camera (V4L2)
 │
 └─ Streams:

Settings
 └─ Default Configured Node Names:
         0. Audio/Sink    alsa_output.pci-0000_00_1f.3.analog-stereo
`;
  const p = a.parseWpctlStatus(wp);
  check(p.sinks.length === 2 && p.sinks[0].id === '46' && p.sinks[0].default && p.sinks[0].volume === 40 && p.sinks[1].muted && p.sinks[1].name === 'HDMI / DisplayPort 1 Output', 'wpctl status: sinks with ids, default marker, volume, MUTED');
  check(p.sources.length === 1 && p.sources[0].id === '47' && p.sources[0].volume === 74, 'wpctl status: audio sources only (not the camera)');
  check(eq(a.parseWpctlVolume('Volume: 0.40 [MUTED]\n'), { volume: 40, muted: true }) && eq(a.parseWpctlVolume('Volume: 1.00\n'), { volume: 100, muted: false }), 'wpctl get-volume');
  const sinks = a.parsePactlJson(JSON.stringify([{ index: 46, name: 'alsa_output.pci-0000_00_1f.3.analog-stereo', description: 'Built-in Audio Analog Stereo', mute: false, volume: { 'front-left': { value: 26214, value_percent: '40%', db: '-23.88 dB' }, 'front-right': { value: 26214, value_percent: '40%', db: '-23.88 dB' } } }]));
  check(sinks[0].id === 'alsa_output.pci-0000_00_1f.3.analog-stereo' && sinks[0].name === 'Built-in Audio Analog Stereo' && sinks[0].volume === 40, 'pactl JSON sinks');
  const srcs = a.parsePactlJson(JSON.stringify([{ name: 'alsa_output.x.monitor', description: 'Monitor', monitor_of_sink: 'alsa_output.x', volume: {} }, { name: 'alsa_input.x', description: 'Mic', monitor_of_sink: 'n/a', volume: { mono: { value_percent: '74%' } }, mute: true }]), { sources: true });
  check(srcs.length === 1 && srcs[0].id === 'alsa_input.x' && srcs[0].muted && srcs[0].volume === 74, 'pactl JSON sources without monitors');
  check(a.parsePactlVolume('Volume: front-left: 26214 /  40% / -23.88 dB,   front-right: 26214 /  40% / -23.88 dB\n        balance 0.00\n') === 40 && a.parsePactlMute('Mute: yes') && !a.parsePactlMute('Mute: no'), 'pactl get-sink-volume / get-sink-mute');
  check(eq(a.parsePactlShort('46\talsa_output.a\tPipeWire\ts32le 2ch 48000Hz\tSUSPENDED\n47\talsa_output.a.monitor\tPipeWire\ts32le 2ch\tSUSPENDED\n', { sources: true }).map((x) => x.id), ['alsa_output.a']), 'pactl short lists (fallback)');
}
{
  const { parsers: d } = require('../main/ipc/display.js');
  const x = `Screen 0: minimum 320 x 200, current 3200 x 1080, maximum 16384 x 16384
Virtual-1 connected primary 1920x1080+0+0 (normal left inverted right x axis y axis) 0mm x 0mm
   1920x1080     60.00*+  59.96    59.93
   1600x900      59.99    59.94
   1280x800      59.81 +
   1920x1080_60.00  59.96
Virtual-2 disconnected (normal left inverted right x axis y axis)
   1024x768      60.00
HDMI-1 connected 1080x1920+1920+0 left (normal left inverted right x axis y axis) 527mm x 296mm
   1920x1080     60.00 +  50.00    59.94
   1920x1080i    60.00    50.00
   1280x1024     75.02*   60.02
`;
  const r = d.parseXrandr(x);
  const v1 = r.outputs[0];
  const h1 = r.outputs[1];
  check(r.outputs.length === 2 && v1.name === 'Virtual-1' && v1.primary && v1.width === 1920 && v1.rate === 60 && eq(v1.preferred, { width: 1920, height: 1080, rate: 60 }), 'xrandr: connected outputs, primary, current mode (*) and preferred (+)');
  check(eq(v1.modes.map((m) => `${m.width}x${m.height}`), ['1920x1080', '1600x900', '1280x800']) && eq(v1.modes[0].rates, [60, 59.96, 59.93]), 'xrandr: modes merged by size, largest first, rates sorted');
  check(v1.modes[2].preferred === true && v1.modes[1].preferred === false, 'xrandr: "59.81 +" (preferred, not current) with a space');
  check(h1.rotation === 'left' && h1.x === 1920 && h1.mmWidth === 527 && h1.rate === 75.02 && h1.width === 1280, 'xrandr: rotated output, position, physical size, current rate on a later mode');
  check(eq(d.modeName(v1, 1920, 1080, 59.96), { name: '1920x1080', rate: 59.96 }) && d.modeName(v1, 1024, 768) === null, 'mode name lookup (custom cvt modes do not shadow the standard name)');
  check(eq(h1.modes.find((m) => m.width === 1920).rates, [60, 59.94, 50]), 'xrandr: interlaced duplicates are dropped');
}
{
  const { parsers: p } = require('../main/ipc/power-ext.js');
  const b = p.batteryFrom({
    BAT0: { type: 'Battery', present: '1', status: 'Discharging', capacity: '76', energy_now: '38000000', energy_full: '50000000', power_now: '9500000', manufacturer: 'SMP', model_name: '5B10W13930' },
    AC: { type: 'Mains', online: '0' },
    hidpp_battery_0: { type: 'Battery', scope: 'Device', capacity: '30', status: 'Discharging' },
  });
  check(b && b.percent === 76 && b.charging === false && b.timeLeftMin === 240 && b.ac === false, 'battery: percent, discharging, time left from energy/power (mouse battery ignored)');
  const c = p.batteryFrom({ BAT1: { type: 'Battery', status: 'Charging', capacity: '50', charge_now: '2500000', charge_full: '5000000', current_now: '1250000' }, ADP1: { type: 'Mains', online: '1' } });
  check(c.charging && c.timeLeftMin === 120 && c.ac, 'battery: charging, time to full from charge/current');
  check(p.batteryFrom({ AC: { type: 'Mains', online: '1' } }) === null, 'no battery -> null (desktops and VMs)');
}
{
  const { parsers: u } = require('../main/ipc/users.js');
  const passwd = 'root:x:0:0:root:/root:/bin/bash\nsyslog:x:104:110::/home/syslog:/usr/sbin/nologin\naurora:x:1000:1000:Aurora User,,,:/home/aurora:/bin/bash\nmarie:x:1001:1001:Marie Dupont:/home/marie:/bin/bash\nnobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin\nsvc:x:1002:1002::/var/svc:/usr/sbin/nologin\n';
  const group = 'sudo:x:27:aurora\nadm:x:4:syslog,aurora\nmarie:x:1001:\n';
  const us = u.parseUsers(passwd, group, 'marie');
  check(eq(us.map((x) => x.name), ['marie', 'aurora']) && us[1].admin && !us[0].admin && us[1].fullName === 'Aurora User' && us[0].current, 'human accounts (uid >= 1000, login shell), sudo membership, current first');
  check(u.passwdFailure('Current password: \npasswd: Authentication token manipulation error\npasswd: password unchanged\n').code === 'EAUTH', 'passwd: wrong current password -> EAUTH');
  check(eq(u.passwdFailure('New password: \nBAD PASSWORD: The password is shorter than 8 characters\n'), { code: 'EWEAK', message: 'The password is shorter than 8 characters' }), 'passwd: pwquality rejection -> EWEAK with the reason');
  check(u.passwdFailure('Retype new password: \nPassword unchanged\n').code === 'EWEAK', 'passwd: same password -> EWEAK');
}
{
  const { parsers: l } = require('../main/ipc/locale.js');
  check(eq(l.parseTimedatectl('Timezone=Europe/Paris\nLocalRTC=no\nCanNTP=yes\nNTP=yes\nNTPSynchronized=no\nTimeUSec=Sat 2026-10-10 18:00:00 CEST\n'), { timezone: 'Europe/Paris', ntp: true, ntpSynced: false, canNtp: true }), 'timedatectl show');
  check(eq(l.parseEnvFile('# comment\nXKBMODEL="pc105"\nXKBLAYOUT="fr"\nXKBVARIANT=""\nBACKSPACE=guess\n'), { XKBMODEL: 'pc105', XKBLAYOUT: 'fr', XKBVARIANT: '', BACKSPACE: 'guess' }), '/etc/default/keyboard');
  check(eq(l.parseXkbQuery('rules:      evdev\nmodel:      pc105\nlayout:     ch\nvariant:    fr\noptions:    grp:alt_shift_toggle\n'), { layout: 'ch', variant: 'fr', options: 'grp:alt_shift_toggle' }), 'setxkbmap -query');
  check(eq(l.splitLayout('ch(fr)'), { layout: 'ch', variant: 'fr' }) && eq(l.splitLayout('fr+bepo'), { layout: 'fr', variant: 'bepo' }) && eq(l.splitLayout('us'), { layout: 'us', variant: '' }) && l.splitLayout('us; rm -rf') === null, 'keyboard layout strings (ch(fr), fr+bepo, invalid)');
  const xl = l.parseXinputList('⎡ Virtual core pointer                    \tid=2\t[master pointer  (3)]\n⎜   ↳ Virtual core XTEST pointer              \tid=4\t[slave  pointer  (2)]\n⎜   ↳ ImExPS/2 Generic Explorer Mouse         \tid=11\t[slave  pointer  (2)]\n⎜   ↳ SynPS/2 Synaptics TouchPad              \tid=12\t[slave  pointer  (2)]\n⎣ Virtual core keyboard                   \tid=3\t[master keyboard (2)]\n    ↳ AT Translated Set 2 keyboard            \tid=10\t[slave  keyboard (3)]\n');
  check(eq(xl, [{ id: 11, name: 'ImExPS/2 Generic Explorer Mouse' }, { id: 12, name: 'SynPS/2 Synaptics TouchPad' }]), 'xinput list: slave pointers without XTEST');
  check(eq(l.parseXinputProps('Device \'SynPS/2\':\n\tlibinput Accel Speed (300):\t-0.250000\n\tlibinput Left Handed Enabled (305):\t1\n'), { accel: -0.25, leftHanded: true }), 'xinput list-props: libinput speed and left-handed');
}
{
  const { parsers: ad } = require('../main/ipc/admin.js');
  const ok = (a, args) => {
    try {
      return ad.validate(a, args);
    } catch {
      return null;
    }
  };
  check(eq(ok('user-add', ['bob', 'Bob Martin', '1', 'p@ss: w"o\\rd'])?.args, ['bob', 'Bob Martin', '1']) && ok('user-add', ['bob', 'Bob Martin', '1', 'p@ss: w"o\\rd']).secret === 'p@ss: w"o\\rd', 'admin: user-add takes the password out of argv');
  check(ok('user-add', ['Bob', 'x', '0', 'pw']) === null && ok('user-add', ['bob', 'a:b', '0', 'pw']) === null && ok('user-add', ['bob', 'x', '2', 'pw']) === null && ok('user-add', ['bob', 'x', '0', 'a\nb']) === null, 'admin: invalid user name / full name / flag / multi-line password rejected');
  check(ok('set-hostname', ['my-pc']) && !ok('set-hostname', ['bad;name']) && !ok('set-hostname', ['-pc']), 'admin: host names');
  check(ok('set-timezone', ['America/Argentina/Buenos_Aires']) && !ok('set-timezone', ['../etc/passwd']) && !ok('set-timezone', ['posix/Europe/Paris']), 'admin: time zones');
  check(ok('set-keyboard', ['fr']) && ok('set-keyboard', ['ch', 'fr']) && !ok('set-keyboard', ['fr', 'a b']) && !ok('set-keyboard', []), 'admin: keyboard with an optional variant');
  check(!ok('rm', ['-rf', '/']) && !ok('__proto__', []) && !ok('service', ['enable', 'ssh']) && ok('service', ['restart', 'NetworkManager.service']), 'admin: only allow-listed actions and verbs');
  check(ad.parseGreetdAutologin('[terminal]\nvt = 7\n\n[default_session]\ncommand = "x"\nuser = "_greetd"\n\n[initial_session]\ncommand = "/usr/bin/aurora-session"\nuser = "aurora"\n') === 'aurora' && ad.parseGreetdAutologin('[default_session]\nuser = "_greetd"\n') === null, 'greetd config: automatic sign-in user');
}
{
  const parse = await import('../renderer/apps/settings/lib/parse.js');
  const sim = parse.parseAptSimulation('Reading package lists...\nInst firefox [1:131.0.2+build1-0ubuntu0.24.04.1] (1:131.0.3+build1-0ubuntu0.24.04.1 Ubuntu:24.04/noble-updates [amd64])\nInst libssl3t64 [3.0.13-0ubuntu3.3] (3.0.13-0ubuntu3.4 Ubuntu:24.04/noble-security, Ubuntu:24.04/noble-updates [amd64])\nInst linux-image-6.8.0-48-generic (6.8.0-48.48 Ubuntu:24.04/noble-updates [amd64])\nConf firefox (1:131.0.3 Ubuntu:24.04/noble-updates [amd64])\n');
  check(sim.length === 3 && sim[0].name === 'firefox' && sim[0].from === '1:131.0.2+build1-0ubuntu0.24.04.1' && sim[0].to === '1:131.0.3+build1-0ubuntu0.24.04.1' && sim[1].security && !sim[0].security && sim[2].from === null, 'apt simulation: upgrades, security origin, new packages, Conf lines ignored');
  check(eq(parse.parseAptStatus('dlstatus:3:50.0000:Retrieving file 3 of 6'), { phase: 'download', percent: 20, step: 50, pkg: null, message: 'Retrieving file 3 of 6' }) && parse.parseAptStatus('pmstatus:firefox:50:Unpacking firefox').percent === 70 && parse.parseAptStatus('pmerror:foo:10:failed').phase === 'error' && parse.parseAptStatus('random') === null, 'APT status fd lines -> overall progress');
  const hist = parse.parseAptHistory('\nStart-Date: 2026-09-01  10:41:27\nCommandline: apt-get -y upgrade\nRequested-By: aurora (1000)\nUpgrade: libssl3t64:amd64 (3.0.13-0ubuntu3.3, 3.0.13-0ubuntu3.4), openssl:amd64 (3.0.13-0ubuntu3.3, 3.0.13-0ubuntu3.4)\nEnd-Date: 2026-09-01  10:41:40\n\nStart-Date: 2026-09-20  08:00:01\nCommandline: apt-get install foo\nInstall: foo:amd64 (1.0-1), libfoo1:amd64 (1.0-1, automatic)\nEnd-Date: 2026-09-20  08:00:09\n');
  check(hist.length === 2 && hist[0].install.length === 2 && hist[0].install[1].automatic && hist[1].upgrade[0].name === 'libssl3t64' && hist[1].upgrade[0].from === '3.0.13-0ubuntu3.3' && hist[1].requestedBy === 'aurora', 'apt history.log: entries newest first, package lists with versions');
  const idx = await import('../renderer/apps/settings/lib/index.js');
  const links = [['wifi'], ['sound'], ['power'], ['accessibility'], ['about'], ['network'], ['apps'], ['taskbar'], ['display'], ['personalization'], ['accounts', 'password'], ['accessibility', 'animations'], ['display', 'nightLight'], ['network', 'airplane'], ['colors', 'mode'], ['defaultApps'], ['users'], ['time'], ['language'], ['keyboard'], ['mouse'], ['printers'], ['privacy'], ['update'], ['storage'], ['notifications'], ['background'], ['themes'], ['lockscreen'], ['start'], ['ethernet'], ['system']];
  const bad = links.filter(([p, s]) => !idx.PAGES[idx.resolvePage(p, s).page] || (idx.resolvePage(p, s).page === 'system' && p !== 'system'));
  check(!bad.length, `every deep link used by the shell resolves to a page${bad.length ? ` (bad: ${bad.join(' ')})` : ''}`);
  check(eq(idx.resolvePage('accounts', 'password'), { page: 'signIn', section: 'password' }) && eq(idx.resolvePage('accessibility', 'animations'), { page: 'visualEffects', section: 'animations' }) && idx.resolvePage('ms-settings:windowsupdate').page === 'update' && idx.resolvePage('nope').page === 'system', 'section redirects and aliases');
  check(idx.searchIndex('night', 'en')[0]?.section === 'nightLight' && idx.searchIndex('fuseau', 'fr')[0]?.section === 'timezone' && idx.searchIndex('mot de passe', 'fr').some((e) => e.page === 'signIn') && idx.searchIndex('zzzz', 'en').length === 0, 'in-app search (en, fr, accents)');
  const man = JSON.parse(fs.readFileSync(path.join(ROOT, 'renderer/apps/settings/manifest.json'), 'utf8'));
  check(man.searchIndex?.length === idx.INDEX.length && man.searchIndex.every((e, i) => e.page === idx.INDEX[i].page && e.name.fr === idx.INDEX[i].name.fr), 'manifest.json searchIndex (Start search) matches lib/index.js');
  const i18n = JSON.parse(fs.readFileSync(path.join(ROOT, 'renderer/apps/settings/i18n.json'), 'utf8'));
  const flat = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (typeof v === 'object' ? flat(v, `${p}${k}.`) : [`${p}${k}`]));
  const en = flat(i18n.en);
  const fr = new Set(flat(i18n.fr));
  check(en.length > 500 && en.every((k) => fr.has(k)) && fr.size === en.length, `every Settings string exists in English and French (${en.length})`);
  const used = new Set();
  for (const f of ['main.js', 'lib/kit.js', ...fs.readdirSync(path.join(ROOT, 'renderer/apps/settings/pages')).map((x) => `pages/${x}`)]) for (const m of fs.readFileSync(path.join(ROOT, 'renderer/apps/settings', f), 'utf8').matchAll(/\bt\('([a-zA-Z0-9_.]+)'/g)) used.add(m[1]);
  const core = flat(JSON.parse(fs.readFileSync(path.join(ROOT, 'renderer/core/i18n/en.json'), 'utf8')));
  const missing = [...used].filter((k) => !en.includes(k) && !en.includes(`${k}_one`) && !core.includes(k));
  check(!missing.length, `no missing string keys${missing.length ? `: ${missing.join(' ')}` : ''}`);
}

// ===================================================================== 2. helper scripts
console.log('\n# Privileged helper + display restore script');
{
  const helper = path.join(REPO, 'rootfs/usr/lib/aurora/helpers/aurora-admin');
  const st = fs.statSync(helper);
  check((st.mode & 0o111) !== 0, 'aurora-admin is executable');
  if (spawnSync('which', ['shellcheck']).status === 0) check(spawnSync('shellcheck', [helper]).status === 0, 'aurora-admin passes shellcheck');
  if (process.getuid?.() === 0) {
    // Only cases rejected before anything is changed (we may be root in a dev container).
    const run = (...a) => spawnSync(helper, a, { encoding: 'utf8', input: '' });
    const cases = [
      [['bogus'], 2],
      [['set-hostname', 'bad;name'], 2],
      [['set-timezone', '../../etc/shadow'], 2],
      [['user-delete', 'root', '0'], 3],
      [['user-add', 'Bad', 'x', '0', '0123456789abcdef0123456789abcdef'], 2],
      [['user-add', 'bob', 'a:b', '0', '0123456789abcdef0123456789abcdef'], 2],
      [['kill-process', '1', 'KILL'], 4],
      [['service', 'restart', 'x;reboot'], 2],
      [['set-locale', 'de_DE.UTF-8'], 2],
      [['set-keyboard', 'fr', 'bad variant'], 2],
      [['set-ntp', 'yes'], 2],
      [['firewall', 'reset'], 2],
      [['set-password', 'nosuchuser1', '0123456789abcdef0123456789abcdef'], 3],
    ];
    const wrong = cases.filter(([a, code]) => run(...a).status !== code);
    check(!wrong.length, `aurora-admin rejects invalid input with the right exit codes${wrong.length ? ` (wrong: ${wrong.map((w) => w[0].join(' ')).join(' | ')})` : ''}`);
    check(run('ping').stdout.trim() === 'pong', 'aurora-admin ping');
  }
  const py = spawnSync(
    'python3',
    [
      '-I',
      '-c',
      `
import importlib.machinery, importlib.util, json, sys
loader = importlib.machinery.SourceFileLoader('aad', sys.argv[1])
spec = importlib.util.spec_from_loader('aad', loader); m = importlib.util.module_from_spec(spec); loader.exec_module(m)
q = """Screen 0: minimum 320 x 200, current 1920 x 1080, maximum 16384 x 16384
Virtual-1 connected primary 1920x1080+0+0 (normal left inverted right x axis y axis) 0mm x 0mm
   1920x1080     60.00*+  59.96
   1600x900      59.99    59.94
   1920x1080_60.00  59.96
HDMI-1 disconnected (normal left inverted right x axis y axis)
"""
r = m.parse_xrandr(q)
print(json.dumps({k: {"current": v["current"], "modes": {f"{a}x{b}": {str(x): n for x, n in rr.items()} for (a, b), rr in v["modes"].items()}} for k, v in r.items()}))
`,
      path.join(REPO, 'rootfs/usr/lib/aurora/helpers/aurora-apply-display'),
    ],
    { encoding: 'utf8' },
  );
  let parsed = null;
  try {
    parsed = JSON.parse(py.stdout);
  } catch {}
  check(parsed && eq(parsed['Virtual-1'].current, [1920, 1080, 60]) && parsed['Virtual-1'].modes['1920x1080']['59.96'] === '1920x1080' && parsed['Virtual-1'].modes['1600x900']['59.94'] === '1600x900' && !parsed['HDMI-1'], 'aurora-apply-display parses xrandr (current mode, rates, disconnected outputs)');
}

if (ARGS.has('--unit')) finish();

// ===================================================================== 3. end to end
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(DOCS, { recursive: true });

async function docShot(s, name) {
  const file = await s.shot(`settings-${name}`);
  fs.copyFileSync(file, path.join(DOCS, `settings-${name}.png`));
}
const errorsOf = (s) => s.logs.filter((l) => /^\[(error|pageerror)\]/.test(l) && !/Failed to load resource/.test(l));

async function go(s, page, section) {
  await s.aurora(([p, sec]) => window.__aurora.registry.launch('settings', { page: p, section: sec }), [page, section]);
  await s.page.waitForFunction(
    ([p]) => {
      const el = document.querySelector('.app-settings .st-page');
      return el && el.dataset.page === p && !document.querySelector('.app-settings .st-content > .st-loading');
    },
    [await s.aurora(([p, sec]) => import('app://shell/apps/settings/lib/index.js').then((m) => m.resolvePage(p, sec).page), [page, section])],
    { timeout: 10000 },
  );
  await sleep(450);
}
const S = (sel) => `.app-settings ${sel}`;
async function rowControl(s, title) {
  // the row whose title matches -> its right-hand control area
  const row = s.page.locator(S('.st-row, .st-exp-head')).filter({ has: s.page.locator('.st-row-title', { hasText: title }) }).first();
  await row.waitFor({ timeout: 5000 });
  return row;
}
async function pickCombo(s, rowTitle, optionText) {
  const row = await rowControl(s, rowTitle);
  await row.locator('.st-combo').first().click();
  await s.page.locator('.menu .menu-item', { hasText: optionText }).first().click();
  await sleep(300);
}
async function uac(s, password = 'aurora') {
  await s.page.waitForSelector('.uac-dialog', { timeout: 8000 });
  const pw = s.page.locator('.uac-dialog input[type=password]');
  if (await pw.count()) await pw.fill(password);
  await s.page.locator('.uac-dialog .dialog-footer .btn.primary').click();
  await s.page.waitForSelector('.uac-dialog', { state: 'detached', timeout: 8000 }).catch(() => {});
}
async function setRange(loc, v) {
  await loc.evaluate((el, val) => {
    el.value = String(val);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, v);
}
const get = (s, key) => s.aurora((k) => window.__aurora.settings.get(k), key);
const inv = (s, ch, ...a) => s.aurora(([c, args]) => window.__aurora.api.invoke(c, ...args), [ch, a]);

async function lightEnglish() {
  console.log('\n# Settings app — light / English');
  const s = await launchShell({ theme: 'light', lang: 'en', open: ['settings'] });
  try {
    await s.page.waitForSelector(S('.st-page[data-page="system"]'), { timeout: 20000 });
    await sleep(700);
    check((await s.page.locator(S('.st-nav-item')).count()) === 10, 'nav has the 10 Windows 11 categories');
    check((await s.page.locator(S('.st-title')).innerText()).trim() === 'System', 'opens on System');
    check(await s.page.locator('.app-settings .st-tb-back').isDisabled(), 'back button disabled on the first page');
    await docShot(s, 'system-light-en');

    // ---- nav + breadcrumb + back
    await s.page.locator(S('.st-nav-item[data-cat="network"]')).click();
    await s.page.waitForSelector(S('.st-page[data-page="network"]'));
    await s.page.locator(S('.st-row'), { hasText: 'Advanced network settings' }).first().click();
    await s.page.waitForSelector(S('.st-page[data-page="advancedNetwork"]'));
    check((await s.page.locator(S('.st-title')).innerText()).replace(/\s+/g, ' ').includes('Network & internet Advanced network settings'), 'breadcrumb shows the parent page');
    check((await s.page.locator(S('.st-nav-item.selected')).getAttribute('data-cat')) === 'network', 'nav keeps the category selected on sub pages');
    await s.page.locator('.app-settings .st-tb-back').click();
    await s.page.waitForSelector(S('.st-page[data-page="network"]'));
    check(true, 'title bar back button returns to the previous page');
    await s.page.locator(S('button.st-crumb'), { hasText: 'Network' }).count();

    // ---- search
    await s.page.locator(S('.st-search input')).fill('night');
    await s.page.waitForSelector(S('.st-suggest .st-suggest-item'));
    check((await s.page.locator(S('.st-suggest .st-suggest-item')).first().innerText()).includes('Night light'), 'Find a setting suggests "Night light"');
    await s.page.locator(S('.st-search input')).press('ArrowDown');
    await s.page.locator(S('.st-search input')).press('Enter');
    await s.page.waitForSelector(S('.st-page[data-page="display"] .st-expander.open[data-section="nightLight"]'), { timeout: 5000 }).then(
      () => check(true, 'choosing a suggestion opens the page at that setting (expander opened)'),
      () => check(false, 'choosing a suggestion opens the page at that setting (expander opened)'),
    );
    await s.page.locator(S('.st-search input')).fill('fuseau xyz');
    await s.page.locator(S('.st-search input')).press('Enter');
    await s.page.waitForSelector(S('.st-page[data-page="search"]'));
    check((await s.page.locator(S('.st-page .st-empty')).count()) === 1, 'search results page with an empty state');
    await s.page.locator(S('.st-search input')).fill('');

    // ---- Display: night light, scale, resolution with the keep / revert dialog
    await go(s, 'display');
    await (await rowControl(s, 'Night light')).locator('.toggle input').click();
    await sleep(500);
    check((await get(s, 'nightLight')) === true && (await s.aurora(() => !!document.getElementById('night-light'))), 'Night light toggle turns the warm overlay on');
    if (!(await s.page.locator(S('.st-expander[data-section="nightLight"].open')).count())) await s.page.locator(S('.st-expander[data-section="nightLight"] .st-exp-chev')).click();
    await setRange(s.page.locator(S('.st-expander[data-section="nightLight"] .slider')), 80);
    await sleep(300);
    check((await get(s, 'nightLightStrength')) === 80, 'Night light strength slider');
    await (await rowControl(s, 'Night light')).locator('.toggle input').click();
    await sleep(300);
    check((await get(s, 'nightLight')) === false, 'Night light off');
    await pickCombo(s, 'Scale', '125%');
    check((await get(s, 'scale')) === 125, 'Scale combo sets settings.scale');
    await pickCombo(s, 'Scale', '100%');
    await pickCombo(s, 'Display resolution', '1600 × 900');
    await s.page.waitForSelector('.st-keep-dialog', { timeout: 5000 });
    check(/Reverting to previous display settings in 1[45] seconds/.test(await s.page.locator('.st-keep-dialog').innerText()), 'resolution change asks "Keep these display settings?" with a countdown');
    await docShot(s, 'display-keep');
    await s.page.locator('.st-keep-dialog .dialog-footer .btn.primary').click();
    await sleep(500);
    const saved = await inv(s, 'display:saved');
    check(saved?.outputs?.['Virtual-1']?.width === 1600, 'Keep changes saves the mode for the next sign-in (display.json)');
    await pickCombo(s, 'Display resolution', '1920 × 1080');
    await s.page.waitForSelector('.st-keep-dialog');
    await s.page.locator('.st-keep-dialog .dialog-footer .btn', { hasText: 'Revert' }).click();
    await sleep(700);
    check((await inv(s, 'display:status')).outputs[0].width === 1600, 'Revert restores the previous mode');
    await pickCombo(s, 'Display resolution', '1920 × 1080');
    await s.page.waitForSelector('.st-keep-dialog');
    await s.page.locator('.st-keep-dialog .dialog-footer .btn.primary').click();
    await sleep(500);
    await docShot(s, 'display');

    // ---- Sound
    await go(s, 'sound');
    await setRange(s.page.locator(S('.st-row[data-section="volume"] .slider')), 73);
    await sleep(400);
    check((await inv(s, 'audio:status')).volume === 73, 'Volume slider sets the output volume');
    await s.page.locator(S('.st-expander[data-section="output"] label'), { hasText: 'Headphones' }).click();
    await sleep(400);
    check((await inv(s, 'audio:status')).outputs.find((o) => o.default)?.name.includes('Headphones'), 'choosing an output device makes it the default');
    await s.page.locator(S('.st-row[data-section="volume"] .st-row-icon button')).click();
    await sleep(300);
    check((await inv(s, 'audio:status')).muted === true, 'mute button');
    await s.page.locator(S('.st-row[data-section="volume"] .st-row-icon button')).click();
    await sleep(200);

    // ---- Network: airplane, Wi-Fi with a wrong then right key
    await go(s, 'network');
    await docShot(s, 'network');
    await (await rowControl(s, 'Airplane mode')).locator('.toggle input').click();
    await sleep(500);
    const air = await inv(s, 'net:status');
    check(air.airplane === true && air.wifiEnabled === false, 'Airplane mode turns the radios off');
    await (await rowControl(s, 'Airplane mode')).locator('.toggle input').click();
    await sleep(500);
    check((await inv(s, 'net:status')).wifiEnabled === true, 'Airplane mode off restores Wi-Fi');
    await go(s, 'wifi');
    await s.page.waitForSelector(S('.st-wifi-list .st-row-title'), { timeout: 8000 });
    await s.page.locator(S('.st-wifi-list .st-row'), { hasText: 'Livebox-4F2A' }).first().click();
    await s.page.locator(S('.st-wifi-form .btn.primary'), { hasText: 'Connect' }).click();
    await s.page.locator(S('.st-wifi-form input[type=password]')).fill('wrong');
    await s.page.locator(S('.st-wifi-form .btn.primary')).click();
    await s.page.waitForSelector(S('.st-wifi-form .st-infobar.error'), { timeout: 8000 });
    check((await s.page.locator(S('.st-wifi-form')).innerText()).includes("isn't correct"), 'wrong Wi-Fi key: inline error, the key prompt stays');
    await s.page.locator(S('.st-wifi-form input[type=password]')).fill('correct-horse');
    await s.page.locator(S('.st-wifi-form .btn.primary')).click();
    await s.page.waitForFunction(() => [...document.querySelectorAll('.app-settings .st-wifi-list .st-row')].some((r) => r.textContent.includes('Livebox-4F2A') && r.textContent.includes('Connected')), null, { timeout: 10000 });
    check((await inv(s, 'net:status')).devices.find((d) => d.type === 'wifi').connection === 'Livebox-4F2A', 'right Wi-Fi key connects');
    await docShot(s, 'wifi');

    // ---- Personalization
    await go(s, 'personalization');
    await docShot(s, 'personalization-light-en');
    await s.page.locator(S('.st-theme[data-theme="glow"]')).first().click();
    await sleep(900);
    check((await get(s, 'wallpaper')) === 'builtin:glow' && (await get(s, 'theme')) === 'dark' && (await get(s, 'accent')) === '#8764b8' && (await s.aurora(() => document.documentElement.dataset.theme)) === 'dark', 'theme preset applies wallpaper + dark mode + accent to the shell');
    await go(s, 'colors');
    await s.page.locator(S('.segmented button'), { hasText: 'Light' }).click();
    await sleep(600);
    check((await s.aurora(() => document.documentElement.dataset.theme)) === 'light', 'Light / Dark mode switch');
    await s.page.locator(S('.st-swatch[aria-label="#e3008c"]')).click();
    await sleep(500);
    check((await get(s, 'accent')) === '#e3008c' && (await s.aurora(() => getComputedStyle(document.documentElement).getPropertyValue('--accent-base').trim())) === '#e3008c', 'accent color swatch recolors the shell');
    await (await rowControl(s, 'Transparency effects')).locator('.toggle input').click();
    await sleep(300);
    check((await s.aurora(() => document.documentElement.dataset.transparency)) === 'off', 'transparency effects off');
    await (await rowControl(s, 'Transparency effects')).locator('.toggle input').click();
    await go(s, 'background');
    await s.page.locator(S('.st-wall[aria-label="Flow"]')).click();
    await sleep(400);
    check((await get(s, 'wallpaper')) === 'builtin:flow', 'background picture tile');
    await pickCombo(s, 'Choose a fit for your desktop image', 'Fit');
    check((await get(s, 'wallpaperFit')) === 'fit', 'background fit');
    await pickCombo(s, 'Personalize your background', 'Solid color');
    await s.page.locator(S('.st-solid-grid .st-swatch')).nth(5).click();
    await sleep(500);
    check(String(await get(s, 'wallpaper')).startsWith('data:image/svg+xml') && (await s.aurora(() => document.querySelector('.wallpaper-layer:last-child')?.style.backgroundImage.includes('data:image/svg+xml'))), 'solid color background reaches the desktop');
    await pickCombo(s, 'Personalize your background', 'Picture');
    await s.page.locator(S('.st-wall[aria-label="Bloom"]')).click();
    await pickCombo(s, 'Choose a fit for your desktop image', 'Fill');
    await go(s, 'taskbar');
    await pickCombo(s, 'Taskbar alignment', 'Left');
    check((await get(s, 'taskbar.align')) === 'left', 'taskbar alignment');
    await pickCombo(s, 'Taskbar alignment', 'Center');
    await (await rowControl(s, 'Widgets')).locator('.toggle input').click();
    await sleep(300);
    check((await get(s, 'taskbar.showWidgets')) === true, 'taskbar Widgets button toggle');
    await (await rowControl(s, 'Widgets')).locator('.toggle input').click();
    await go(s, 'lockscreen');
    await s.page.locator(S('.st-wall[aria-label="Dunes"]')).click();
    await sleep(300);
    check((await get(s, 'lockWallpaper')) === 'builtin:dunes', 'lock screen picture (settings.lockWallpaper)');
    await pickCombo(s, 'Lock the screen after', '5 minutes');
    check((await get(s, 'lockTimeout')) === 5, 'screen lock timeout (settings.lockTimeout)');
    await go(s, 'colors');
    await s.page.locator(S('.st-swatch[aria-label="#0078d4"]')).click();
    await go(s, 'background');
    await sleep(300);

    // ---- Accounts (UAC)
    await go(s, 'users');
    await s.page.locator(S('.btn.primary'), { hasText: 'Add account' }).click();
    await s.page.waitForSelector('.dialog .st-form');
    await sleep(250); // dialog entrance + initial focus
    await s.page.locator('.dialog .st-form input').nth(0).fill('Hélène Martin');
    check((await s.page.locator('.dialog .st-form input').nth(1).inputValue()) === 'helene', 'user name is suggested from the full name');
    await s.page.locator('.dialog .st-form input[type=password]').nth(0).fill('Bonjour123');
    await s.page.locator('.dialog .st-form input[type=password]').nth(1).fill('Bonjour12');
    await s.page.locator('.dialog .dialog-footer .btn.primary').click();
    check(await s.page.waitForFunction(() => document.querySelector('.dialog .field-hint.error')?.textContent.includes("don't match"), null, { timeout: 3000 }).then(() => true, () => false), 'password confirmation is checked');
    await s.page.locator('.dialog .st-form input[type=password]').nth(1).fill('Bonjour123');
    await s.page.locator('.dialog .st-form input[type=checkbox]').check();
    await docShot(s, 'accounts-add');
    await s.page.locator('.dialog .dialog-footer .btn.primary').click();
    await uac(s, 'wrong');
    await s.page.waitForSelector('.uac-dialog');
    check((await s.page.locator('.uac-dialog').innerText()).length > 0, 'wrong administrator password: the UAC prompt asks again');
    await uac(s, 'aurora');
    await s.page.waitForFunction(() => [...document.querySelectorAll('.app-settings .st-expander .st-row-title')].some((e) => e.textContent === 'Hélène Martin'), null, { timeout: 8000 });
    const users = await inv(s, 'users:list');
    check(users.some((u) => u.name === 'helene' && u.admin && u.fullName === 'Hélène Martin'), 'Add account creates an administrator through the elevation helper');
    await s.page.waitForSelector('.dialog-layer', { state: 'detached', timeout: 5000 }).catch(() => {});
    await sleep(900);
    await docShot(s, 'accounts');
    await s.page.locator(S('.st-expander .st-exp-head'), { hasText: 'Hélène Martin' }).click();
    await s.page.locator(S('.st-expander.open .btn'), { hasText: 'Remove' }).click();
    await s.page.locator('.dialog .dialog-footer .btn', { hasText: 'Delete account and data' }).click();
    await uac(s);
    await s.page.waitForFunction(() => ![...document.querySelectorAll('.app-settings .st-expander .st-row-title')].some((e) => e.textContent === 'Hélène Martin'), null, { timeout: 8000 });
    check(!(await inv(s, 'users:list')).some((u) => u.name === 'helene'), 'Remove deletes the account');
    await go(s, 'accounts', 'password');
    await s.page.locator(S('.st-expander[data-section="password"] .btn'), { hasText: 'Change' }).click();
    await s.page.waitForSelector('.dialog input[type=password]');
    await sleep(250);
    await s.page.locator('.dialog input[type=password]').nth(0).fill('nope');
    await s.page.locator('.dialog input[type=password]').nth(1).fill('NewPass456');
    await s.page.locator('.dialog input[type=password]').nth(2).fill('NewPass456');
    await s.page.locator('.dialog .dialog-footer .btn.primary').click();
    await s.page.waitForFunction(() => document.querySelector('.dialog .field-hint.error')?.textContent.includes('incorrect'), null, { timeout: 5000 });
    check(true, 'changing the password with a wrong current password shows an error');
    await s.page.locator('.dialog input[type=password]').nth(0).fill('aurora');
    await s.page.locator('.dialog .dialog-footer .btn.primary').click();
    await s.page.waitForSelector(S('.st-errors .st-infobar.success'), { timeout: 5000 });
    check(true, 'password changed with the right current password');
    await go(s, 'signIn');
    await (await rowControl(s, 'Sign in automatically')).locator('.toggle input').click();
    await uac(s);
    await sleep(400);
    check((await inv(s, 'admin:securityStatus')).autologin === 'aurora', 'automatic sign-in (greetd initial_session)');

    // ---- account picture + custom wallpaper through the file picker
    // a real photo (one of the bundled wallpapers) as the account picture and a custom wallpaper
    fs.copyFileSync(path.join(ROOT, 'renderer/assets/wallpapers/aurora.jpg'), path.join(s.home, 'Pictures', 'portrait.jpg'));
    await go(s, 'yourInfo');
    await s.page.locator(S('.btn'), { hasText: 'Browse files' }).click();
    await s.page.waitForSelector('.fp-dialog .fp-row');
    await s.page.locator('.fp-dialog .fp-row', { hasText: 'portrait.jpg' }).click();
    await s.page.locator('.fp-dialog .dialog-footer .btn.primary').click();
    await s.page.waitForSelector(S('.st-account-hero .st-avatar img'), { timeout: 8000 });
    const face = path.join(s.home, '.face');
    check(fs.existsSync(face) && fs.readFileSync(face).subarray(1, 4).toString() === 'PNG', 'account picture: cropped PNG written to ~/.face');
    check((await s.page.locator('.app-settings .st-user .st-avatar img').count()) === 1, 'the account card shows the new picture');
    await go(s, 'background');
    await s.page.locator(S('.btn'), { hasText: 'Browse photos' }).click();
    await s.page.waitForSelector('.fp-dialog .fp-row');
    await s.page.locator('.fp-dialog .fp-row', { hasText: 'portrait.jpg' }).click();
    await s.page.locator('.fp-dialog .dialog-footer .btn.primary').click();
    await sleep(800);
    check((await get(s, 'wallpaper')) === path.join(s.home, 'Pictures', 'portrait.jpg') && (await s.page.locator(S('.st-wall[aria-label="portrait.jpg"].selected')).count()) === 1, 'custom wallpaper from Pictures (and listed in recent images)');
    await s.page.locator(S('.st-wall[aria-label="Bloom"]')).click();
    await sleep(300);

    // ---- Time & language
    await go(s, 'time');
    await (await rowControl(s, 'Time zone')).locator('.st-combo').click();
    await s.page.locator('.st-picker input').fill('tokyo');
    await s.page.locator('.st-picker .menu-item').first().click();
    await uac(s);
    await sleep(500);
    check((await inv(s, 'locale:status')).timezone === 'Asia/Tokyo', 'time zone picker (searchable) sets the system time zone');
    await (await rowControl(s, '24-hour clock')).locator('.toggle input').click();
    await sleep(200);
    check((await get(s, 'clock24h')) === true, '24-hour clock (settings.clock24h, taskbar clock)');
    await (await rowControl(s, 'Set time automatically')).locator('.toggle input').click();
    await uac(s);
    await sleep(300);
    check((await inv(s, 'locale:status')).ntp === false, 'NTP toggle');
    await go(s, 'keyboard');
    await (await rowControl(s, 'Keyboard layout')).locator('.st-combo').click();
    await s.page.locator('.st-picker input').fill('azerty');
    await s.page.locator('.st-picker .menu-item').first().click();
    await sleep(500);
    check((await get(s, 'keyboardLayout')) === 'fr' && (await inv(s, 'locale:status')).keyboard === 'fr', 'keyboard layout applies to the session and persists');
    await go(s, 'language');
    await pickCombo(s, 'Aurora display language', 'Français');
    await sleep(700);
    check((await get(s, 'lang')) === 'fr' && (await s.page.locator(S('.st-nav-item[data-cat="system"]')).innerText()).includes('Système'), 'display language switches the shell to French live');
    await pickCombo(s, 'Langue d’affichage d’Aurora', 'English');
    await sleep(700);
    check((await s.page.locator(S('.st-nav-item[data-cat="system"]')).innerText()).includes('System'), 'and back to English');

    // ---- Privacy: firewall
    await go(s, 'privacy');
    await (await rowControl(s, 'Firewall & network protection')).locator('.toggle input').click();
    await uac(s);
    await sleep(500);
    check((await inv(s, 'admin:securityStatus')).firewall.enabled === true, 'firewall toggle (ufw through the helper)');
    await docShot(s, 'privacy');

    // ---- Update: check, install with progress
    await go(s, 'update');
    await s.page.locator(S('.btn'), { hasText: 'Check for updates' }).first().click();
    await uac(s);
    await s.page.waitForFunction(() => /updates available/.test(document.querySelector('.app-settings .st-hero-title')?.textContent || ''), null, { timeout: 10000 });
    check((await s.page.locator(S('.st-pkg')).count()) === 5, 'Check for updates lists the pending packages');
    await docShot(s, 'update');
    await s.page.locator(S('.btn.primary'), { hasText: 'Install all' }).click();
    await uac(s);
    await s.page.waitForSelector(S('.st-upd-progress .progress .bar'), { timeout: 5000 });
    await sleep(900);
    await docShot(s, 'update-installing');
    const pct = await s.page.locator(S('.st-upd-progress .progress')).getAttribute('aria-valuenow');
    check(Number(pct) > 0, `installing shows live progress (${pct}%)`);
    await s.page.waitForFunction(() => /up to date/.test(document.querySelector('.app-settings .st-hero-title')?.textContent || ''), null, { timeout: 15000 });
    check(true, 'after installing: "You\'re up to date"');

    // ---- About: rename this PC
    await go(s, 'about');
    await s.page.locator(S('.btn'), { hasText: 'Rename this PC' }).click();
    await s.page.locator('.dialog input').fill('bad name!');
    await s.page.locator('.dialog .dialog-footer .btn.primary').click();
    check(await s.page.locator('.dialog input.invalid').count(), 'invalid PC names are refused');
    await s.page.locator('.dialog input').fill('AURORA-LAPTOP');
    await s.page.locator('.dialog .dialog-footer .btn.primary').click();
    await uac(s);
    await s.page.waitForFunction(() => document.querySelector('.app-settings .st-hero-title')?.textContent === 'AURORA-LAPTOP', null, { timeout: 8000 });
    check(true, 'Rename this PC (set-hostname)');
    await docShot(s, 'about');

    // ---- Apps
    await go(s, 'installedApps');
    await s.page.locator(S('.st-apps-tools input')).fill('calc');
    await sleep(200);
    check((await s.page.locator(S('.st-group-rows .st-row')).count()) === 1, 'installed apps search');
    await go(s, 'defaultApps');
    const extRow = s.page.locator(S('.st-row'), { hasText: '.png' }).first();
    if (await extRow.count()) {
      const opts = await s.aurora(() => window.__aurora.registry.list({ includeHidden: true }).filter((m) => (m.fileTypes || []).includes('.png')).map((m) => window.__aurora.i18n.name(m.name)));
      if (opts.length > 1) {
        await extRow.locator('.st-combo').click();
        await s.page.locator('.menu .menu-item', { hasText: opts[1] }).first().click();
        await sleep(300);
        const chosen = (await get(s, 'defaultApps'))['.png'];
        check(!!chosen && (await s.aurora(() => window.__aurora.registry.handlerFor('/x/a.png'))) === chosen, 'default app for .png drives the shell file handler');
      } else check(true, 'default apps list (.png has a single handler)');
    }

    // ---- deep links used by other parts of the shell
    const links = [
      ['wifi', null, 'wifi'],
      ['accounts', 'password', 'signIn'],
      ['accessibility', 'animations', 'visualEffects'],
      ['taskbar', null, 'taskbar'],
      ['power', null, 'power'],
      ['apps', null, 'apps'],
      ['network', 'airplane', 'network'],
    ];
    let okLinks = 0;
    for (const [p, sec, want] of links) {
      await go(s, p, sec);
      if ((await s.page.locator(S('.st-page')).getAttribute('data-page')) === want) okLinks++;
    }
    check(okLinks === links.length, 'deep links from Start, quick settings, Win+X and the security menu');
    check((await s.page.locator(S('[data-section="airplane"].st-flash')).count()) === 1, 'deep link with a section highlights the setting');

    // ---- compact (narrow) layout
    await s.aurora(() => window.__aurora.wm.list().find((w) => w.appId === 'settings').setSize(680, 640));
    await sleep(500);
    check(await s.page.locator('.app-settings .st-tb-menu').isVisible(), 'narrow window: navigation button in the title bar');
    await sleep(1800); // let the deep-link highlight fade
    await docShot(s, 'compact');
    await s.page.locator('.app-settings .st-tb-menu').click();
    await sleep(500);
    await docShot(s, 'compact-nav');
    await s.page.locator(S('.st-nav-item[data-cat="update"]')).click();
    await s.page.waitForSelector(S('.st-page[data-page="update"]'));
    await sleep(300);
    check(!(await s.aurora(() => document.querySelector('.app-settings .st-root').classList.contains('pane-open'))), 'choosing a category closes the navigation pane');
    const overflow = await s.aurora(() => {
      const sc = document.querySelector('.app-settings .st-scroll');
      return sc.scrollWidth - sc.clientWidth;
    });
    check(overflow <= 1, 'no horizontal overflow in a narrow window');

    const errs = errorsOf(s);
    check(!errs.length, `no renderer errors${errs.length ? `:\n${errs.join('\n')}` : ''}`);
  } catch (err) {
    check(false, `light/en flow crashed: ${err.stack || err}`);
    await s.shot('settings-crash-light').catch(() => {});
  } finally {
    await s.close();
  }
}

async function darkFrench() {
  console.log('\n# Settings app — dark / French');
  const s = await launchShell({ theme: 'dark', lang: 'fr', open: ['settings'] });
  try {
    await s.page.waitForSelector(S('.st-page[data-page="system"]'), { timeout: 20000 });
    await sleep(600);
    check((await s.page.locator(S('.st-title')).innerText()).trim() === 'Système', 'opens in French');
    const pages = ['system', 'display', 'sound', 'network', 'wifi', 'personalization', 'colors', 'background', 'accounts', 'users', 'time', 'language', 'keyboard', 'privacy', 'update', 'about', 'installedApps', 'power', 'storage'];
    const over = [];
    for (const p of pages) {
      await go(s, p);
      const o = await s.aurora(() => {
        const sc = document.querySelector('.app-settings .st-scroll');
        const clipped = [...document.querySelectorAll('.app-settings .st-row-right')].filter((r) => r.getBoundingClientRect().right > sc.getBoundingClientRect().right + 1).length;
        return sc.scrollWidth - sc.clientWidth + clipped;
      });
      if (o > 1) over.push(p);
      if (['personalization', 'network', 'display', 'accounts', 'update', 'about', 'system', 'time'].includes(p)) await docShot(s, `${p}-dark-fr`);
    }
    check(!over.length, `French text fits (no overflow) on every page${over.length ? `: ${over.join(', ')}` : ''}`);
    const untranslated = await s.aurora(() => {
      const bad = [];
      for (const el of document.querySelectorAll('.app-settings .st-row-title, .app-settings .st-group-title, .app-settings .btn, .app-settings .st-nav-item')) {
        const tx = el.textContent.trim();
        if (/^(Settings|Display|Sound|Storage|Background|Colors|Themes|Add|Remove|Change|Check for updates|Browse|Open|Copy)$/i.test(tx)) bad.push(tx);
      }
      return bad;
    });
    check(!untranslated.length, `no English leftovers in French${untranslated.length ? `: ${untranslated.join(', ')}` : ''}`);
    await go(s, 'update');
    await s.page.locator(S('.btn'), { hasText: 'Rechercher des mises à jour' }).first().click();
    await uac(s);
    await s.page.waitForFunction(() => /disponibles/.test(document.querySelector('.app-settings .st-hero-title')?.textContent || ''), null, { timeout: 10000 });
    await docShot(s, 'update-dark-fr');
    check(true, 'update check in French');
    const errs = errorsOf(s);
    check(!errs.length, `no renderer errors (dark/fr)${errs.length ? `:\n${errs.join('\n')}` : ''}`);
  } catch (err) {
    check(false, `dark/fr flow crashed: ${err.stack || err}`);
    await s.shot('settings-crash-dark').catch(() => {});
  } finally {
    await s.close();
  }
}

await lightEnglish();
if (!ARGS.has('--skip-dark')) await darkFrench();
finish();

function finish() {
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) console.log(failures.map((f) => ` - ${f}`).join('\n'));
  process.exit(failures.length ? 1 : 0);
}
