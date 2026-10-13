// Touchpad + power — unit tests (no Electron): parsers of main/ipc/inputpower.js and power-ext.js on fixtures,
// admin.js validation of power-lid, aurora-admin's power-lid block (drop-in text, refusals), the xorg.conf.d snippet.
//   node test/inputpower.unit.mjs
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.join(ROOT, '..');
let passed = 0;
const failures = [];
function check(cond, msg) {
  if (cond) passed++;
  else failures.push(msg);
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${msg}`);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const ip = require('../main/ipc/inputpower.js').parsers;
console.log('# xinput');
const LIST = `⎡ Virtual core pointer                    \tid=2\t[master pointer  (3)]
⎜   ↳ Virtual core XTEST pointer              \tid=4\t[slave  pointer  (2)]
⎜   ↳ ELAN0672:00 04F3:3187 Mouse             \tid=11\t[slave  pointer  (2)]
⎜   ↳ ELAN0672:00 04F3:3187 Touchpad          \tid=12\t[slave  pointer  (2)]
⎜   ↳ Logitech USB Optical Mouse              \tid=15\t[slave  pointer  (2)]
⎣ Virtual core keyboard                   \tid=3\t[master keyboard (2)]
    ↳ AT Translated Set 2 keyboard            \tid=14\t[slave  keyboard (3)]`;
check(eq(ip.parsePointers(LIST).map((d) => d.id), [11, 12, 15]), 'xinput list: slave pointers without XTEST / keyboards');
const PROPS = `Device 'ELAN0672:00 04F3:3187 Touchpad':
\tDevice Enabled (190):\t1
\tCoordinate Transformation Matrix (192):\t1.000000, 0.000000, 0.000000, 0.000000, 1.000000, 0.000000, 0.000000, 0.000000, 1.000000
\tlibinput Tapping Enabled (326):\t0
\tlibinput Tapping Enabled Default (327):\t0
\tlibinput Natural Scrolling Enabled (300):\t1
\tlibinput Natural Scrolling Enabled Default (301):\t0
\tlibinput Disable While Typing Enabled (334):\t1
\tlibinput Scrolling Pixel Distance (341):\t15
\tlibinput Accel Speed (311):\t0.000000`;
check(eq(ip.parseTouchpadProps(PROPS), { enabled: true, tap: false, natural: true, dwt: true, scrollPx: 15 }), 'list-props: touchpad properties (Default variants ignored)');
const MOUSE = `Device 'Logitech USB Optical Mouse':\n\tDevice Enabled (190):\t1\n\tlibinput Natural Scrolling Enabled (300):\t0\n\tlibinput Accel Speed (311):\t0.000000`;
check(ip.parseTouchpadProps(MOUSE).tap === null, 'a mouse has no Tapping property (not a touchpad)');
check(ip.scrollPxOf(5) === 15 && ip.scrollPxOf(1) === 40 && ip.scrollPxOf(10) === 5 && ip.scrollPxOf(99) === 5, 'scroll speed 1..10 -> pixel distance (5 = libinput default 15)');
check(ip.SCROLL_PX.every((px, i) => ip.scrollSpeedOf(px) === i + 1) && ip.scrollSpeedOf(14) === 5 && ip.scrollSpeedOf(null) === null, 'pixel distance -> scroll speed (round trip, nearest)');

console.log('# powerprofilesctl');
const PPC = `  performance:
    CpuDriver:\tintel_pstate
    Degraded:   no

* balanced:
    CpuDriver:\tintel_pstate
    PlatformDriver:\tplatform_profile

  power-saver:
    CpuDriver:\tintel_pstate
    PlatformDriver:\tplatform_profile
`;
check(eq(ip.parseProfiles(PPC), { active: 'balanced', profiles: ['power-saver', 'balanced', 'performance'] }), 'list: three modes, active balanced, ordered saver -> performance');
const VM = `* balanced:\n    PlatformDriver:\tplaceholder\n\n  power-saver:\n    PlatformDriver:\tplaceholder\n`;
check(eq(ip.parseProfiles(VM), { active: 'balanced', profiles: ['power-saver', 'balanced'] }), 'list in a VM (placeholder driver): two modes');
check(ip.parseProfiles('') === null && ip.parseProfiles('Failed to connect') === null, 'no daemon: null');

console.log('# logind lid');
check(ip.parseLid('[Login]\nHandleLidSwitch=ignore\n') === 'ignore' && ip.parseLid('') === 'suspend' && ip.parseLid('HandleLidSwitch=hibernate') === 'suspend', 'drop-in -> lid action (default suspend)');

console.log('# battery (power-ext)');
const { batteryFrom } = require('../main/ipc/power-ext.js').parsers;
const b = batteryFrom({ AC: { type: 'Mains', online: '0' }, BAT0: { type: 'Battery', present: '1', status: 'Discharging', capacity: '9', energy_now: '4500000', energy_full: '50000000', power_now: '9000000' } });
check(b.percent === 9 && !b.charging && b.ac === false && b.timeLeftMin === 30, 'fixture: 9 % discharging, 30 min left, not on mains');

console.log('# admin.js + aurora-admin power-lid');
const { validate } = require('../main/ipc/admin.js').parsers;
let refused = 0;
for (const bad of [['hibernate'], ['suspend; reboot'], [], ['suspend', 'x']]) {
  try {
    validate('power-lid', bad);
  } catch {
    refused++;
  }
}
check(refused === 4 && validate('power-lid', ['ignore']).args[0] === 'ignore', 'admin.js: power-lid takes exactly suspend | ignore | poweroff');
const HELPER = path.join(REPO, 'rootfs/usr/lib/aurora/helpers/aurora-admin');
const src = fs.readFileSync(HELPER, 'utf8');
check(spawnSync('bash', ['-n', HELPER]).status === 0, 'aurora-admin passes bash -n');
check(/BEGIN power[\s\S]*\npower-lid\)[\s\S]*END power/.test(src), 'aurora-admin has the delimited power-lid block');
const fn = /^ {2}power_lid_conf\(\) \{\n[\s\S]*?\n {2}\}\n/m.exec(src)?.[0];
const out = spawnSync('bash', ['-c', `${fn}\npower_lid_conf "$1"`, 'x', 'ignore'], { encoding: 'utf8' }).stdout;
check(/\[Login\]\nHandleLidSwitch=ignore\nHandleLidSwitchExternalPower=ignore\n/.test(out), 'drop-in sets HandleLidSwitch and HandleLidSwitchExternalPower');
const block = src.slice(src.indexOf('\npower-lid)'), src.indexOf('# ------------------------------------------------------------------ END power'));
check(/\[\[ \$1 =~ \^\(suspend\|ignore\|poweroff\)\$ \]\] \|\| die 2/.test(block) && /need_args \$# 1/.test(block), 'helper validates the action itself (allow-list, one argument)');
check(/mv -f -- "\$power_lid_tmp" \/etc\/systemd\/logind\.conf\.d\/50-aurora-lid\.conf/.test(block) && !/eval|bash -c/.test(block), 'atomic write of the drop-in, no eval');

console.log('# xorg.conf.d');
const xorg = fs.readFileSync(path.join(REPO, 'rootfs/etc/X11/xorg.conf.d/40-aurora-touchpad.conf'), 'utf8');
check(/MatchIsTouchpad "on"/.test(xorg) && /Option "Tapping" "on"/.test(xorg) && !/Driver/.test(xorg), 'touchpads: Tapping on, no driver forced (verify-iso rule)');
const pkgs = fs.readFileSync(path.join(REPO, 'iso/packages.d/power.list'), 'utf8');
check(/^power-profiles-daemon$/m.test(pkgs), 'power.list ships power-profiles-daemon');

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  FAIL ${f}`);
  process.exit(1);
}
