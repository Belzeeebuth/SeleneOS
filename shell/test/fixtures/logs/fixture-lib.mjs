// Journal fixture for the « Journaux système » app (apps/logs, backend main/ipc/journal.js).
//
// Layout of a fixture directory (AURORA_JOURNAL_FIXTURE=<dir>; dev default: test/fixtures/logs/default):
//   boots.json             what `journalctl --list-boots --output=json` prints (oldest first)
//   system/<boot_id>.jsonl what `journalctl --output=json --all --boot=<id> --system` prints (chronological)
//   user/<boot_id>.jsonl   the same for `--user`
//   meta.json              optional: { limited, pcre2, missing } (see main/ipc/journal.js)
// The fake follow (journal:follow in fixture mode) tails the current boot's files: tests append lines with
// appendEntry() and they show up live.
//
// Regenerate the committed default fixture:  node test/fixtures/logs/fixture-lib.mjs
// Everything is deterministic (fixed dates, a seeded generator).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BOOTS = {
  older: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
  previous: 'b7e4d2c19a0f4e6b8c3d5a7f9e1b2c4d',
  current: 'c0ffee5e1e7e4a2b9d8c7b6a5f4e3d2c',
};
export const MACHINE = '5e1e7e0a5e1e7e0a5e1e7e0a5e1e7e0a';
export const HOST = 'selene';
const SEQ_SYSTEM = 'd280216c34134558a14fe3da8ad7b90d';
const SEQ_USER = 'e391327d45245669b25f04eb9be8ca1e';

// Boot windows (UTC). Paris is UTC+2 in October.
export const BOOT_TIMES = {
  older: { start: Date.UTC(2026, 9, 12, 6, 2, 11), end: Date.UTC(2026, 9, 12, 10, 40, 5) },
  previous: { start: Date.UTC(2026, 9, 13, 16, 10, 7), end: Date.UTC(2026, 9, 13, 20, 47, 31) },
  current: { start: Date.UTC(2026, 9, 14, 7, 17, 17), end: Date.UTC(2026, 9, 14, 8, 5, 42) },
};

let rnd = 0x5e1e7e;
function rand() {
  rnd = (rnd * 1103515245 + 12345) & 0x7fffffff;
  return rnd / 0x7fffffff;
}
const hex = (n) => n.toString(16);
const seqState = { system: 0x3e000, user: 0x1200 };

/** One journal entry, as journalctl --output=json prints it (every value a string, or a byte array). */
export function makeEntry({ boot, ns = 'system', ms, prio, ident, msg, pid, unit, userUnit, transport, uid, comm, exe, extra = {}, seq }) {
  const bootId = BOOTS[boot] || boot;
  const startKey = Object.keys(BOOTS).find((k) => BOOTS[k] === bootId);
  const start = BOOT_TIMES[startKey]?.start ?? ms - 1000;
  const us = BigInt(Math.round(ms)) * 1000n + BigInt(Math.floor((ms % 1) * 1000));
  const mono = BigInt(Math.max(1, Math.round((ms - start) * 1000))) + 2_000_000n;
  const s = seq ?? ++seqState[ns];
  const seqId = ns === 'user' ? SEQ_USER : SEQ_SYSTEM;
  const tr = transport || (ident === 'kernel' ? 'kernel' : unit && ident !== 'systemd' ? 'journal' : 'syslog');
  const e = {
    __CURSOR: `s=${seqId};i=${hex(s)};b=${bootId};m=${mono.toString(16)};t=${us.toString(16)};x=${hex((s * 2654435761) >>> 0)}`,
    __REALTIME_TIMESTAMP: us.toString(),
    __MONOTONIC_TIMESTAMP: mono.toString(),
    __SEQNUM: String(s),
    __SEQNUM_ID: seqId,
    _BOOT_ID: bootId,
    _MACHINE_ID: MACHINE,
    _HOSTNAME: HOST,
    _TRANSPORT: tr,
    _RUNTIME_SCOPE: ns === 'user' ? 'user' : 'system',
  };
  if (prio != null) e.PRIORITY = String(prio);
  if (tr === 'kernel') e.SYSLOG_FACILITY = '0';
  else e.SYSLOG_FACILITY = ns === 'user' ? '1' : '3';
  if (ident) e.SYSLOG_IDENTIFIER = ident;
  if (tr !== 'kernel') {
    const p = pid ?? (ident === 'systemd' ? (ns === 'user' ? 1771 : 1) : 400 + Math.floor(rand() * 3000));
    e._PID = String(p);
    if (ident !== 'systemd') e.SYSLOG_PID = String(p);
    e._UID = String(uid ?? (ns === 'user' ? 1000 : 0));
    e._GID = e._UID;
    e._COMM = comm || (ident || 'unknown').slice(0, 15);
    if (exe) e._EXE = exe;
    if (unit) e._SYSTEMD_UNIT = unit;
    if (userUnit) {
      e._SYSTEMD_USER_UNIT = userUnit;
      e._SYSTEMD_UNIT = 'user@1000.service';
      e._SYSTEMD_OWNER_UID = '1000';
    }
    e._SYSTEMD_CGROUP = userUnit ? `/user.slice/user-1000.slice/user@1000.service/app.slice/${userUnit}` : unit ? `/system.slice/${unit}` : '/';
  }
  if (msg !== undefined) e.MESSAGE = msg;
  return Object.assign(e, extra);
}

/** Append one entry (journalctl JSON line) to a fixture's boot file. */
export function appendEntry(dir, opts) {
  const ns = opts.ns === 'user' ? 'user' : 'system';
  const file = path.join(dir, ns, `${BOOTS[opts.boot] || opts.boot}.jsonl`);
  // The next sequence number of that namespace (cursors must stay unique and follow time).
  let seq = opts.seq;
  if (seq == null) {
    let max = ns === 'user' ? 0x1200 : 0x3e000;
    for (const f of fs.readdirSync(path.join(dir, ns))) {
      for (const m of fs.readFileSync(path.join(dir, ns, f), 'utf8').matchAll(/"__SEQNUM":"(\d+)"/g)) max = Math.max(max, Number(m[1]));
    }
    seq = max + 1;
  }
  const e = makeEntry({ ...opts, seq });
  fs.appendFileSync(file, `${JSON.stringify(e)}\n`);
  return e;
}

const bytes = (s) => [...Buffer.from(s, 'latin1')];

function bootKernel(boot, t0, out, { gpuWarn = false } = {}) {
  const k = (dt, prio, msg) => out.push(makeEntry({ boot, ms: t0 + dt, prio, ident: 'kernel', msg }));
  k(0, 5, 'Linux version 6.8.0-45-generic (buildd@lcy02-amd64-075) (x86_64-linux-gnu-gcc-13 (Ubuntu 13.2.0-23ubuntu4) 13.2.0, GNU ld (GNU Binutils for Ubuntu) 2.42) #45-Ubuntu SMP PREEMPT_DYNAMIC Fri Aug 30 12:02:04 UTC 2024 (Ubuntu 6.8.0-45.45-generic 6.8.12)');
  k(1, 6, 'Command line: BOOT_IMAGE=/boot/vmlinuz-6.8.0-45-generic root=UUID=4b1d0c3e-5a7f-4e2b-9c8d-1f0e3a6b7c5d ro quiet splash vt.handoff=7');
  k(2, 6, 'KERNEL supported cpus:');
  k(3, 6, '  Intel GenuineIntel');
  k(4, 6, '  AMD AuthenticAMD');
  k(8, 6, 'BIOS-provided physical RAM map:');
  k(12, 6, 'ACPI: RSDP 0x00000000000F05B0 000024 (v02 ALASKA)');
  k(40, 3, 'ACPI BIOS Error (bug): Could not resolve symbol [\\_SB.PCI0.GPP0.SWUS], AE_NOT_FOUND (20230628/dswload2-162)');
  k(41, 3, 'ACPI Error: AE_NOT_FOUND, During name lookup/catalog (20230628/psobject-220)');
  k(60, 6, 'PCI: Using configuration type 1 for base access');
  k(240, 6, 'nvme nvme0: 16/0/0 default/read/poll queues');
  k(250, 6, ' nvme0n1: p1 p2');
  k(420, 6, 'usb 1-4: new high-speed USB device number 3 using xhci_hcd');
  k(430, 6, 'usb 1-4: New USB device found, idVendor=0bda, idProduct=5411, bcdDevice= 1.36');
  k(900, 6, 'EXT4-fs (nvme0n1p2): mounted filesystem 4b1d0c3e-5a7f-4e2b-9c8d-1f0e3a6b7c5d ro with ordered data mode. Quota mode: none.');
  k(1400, 5, 'audit: type=1400 audit(1791962240.112:2): apparmor="STATUS" operation="profile_load" profile="unconfined" name="lsb_release" pid=612 comm="apparmor_parser"');
  k(1800, 4, 'iwlwifi 0000:02:00.0: firmware: failed to load iwl-debug-yoyo.bin (-2)');
  k(1801, 6, 'iwlwifi 0000:02:00.0: loaded firmware version 86.fb5c9aeb.0 ty-a0-gf-a0-86.ucode op_mode iwlmvm');
  k(2100, 6, 'amdgpu 0000:05:00.0: amdgpu: SMU is initialized successfully!');
  if (gpuWarn) k(2101, 4, 'amdgpu 0000:05:00.0: amdgpu: Secure display: Generic Failure.');
  k(2500, 3, 'Bluetooth: hci0: Reading supported features failed (-16)');
  k(2600, 6, 'EXT4-fs (nvme0n1p2): re-mounted 4b1d0c3e-5a7f-4e2b-9c8d-1f0e3a6b7c5d r/w. Quota mode: none.');
}

function bootSystemd(boot, t0, out) {
  const sd = (dt, prio, msg, unit) => out.push(makeEntry({ boot, ms: t0 + dt, prio, ident: 'systemd', msg, extra: unit ? { UNIT: unit, CODE_FILE: 'src/core/job.c', CODE_FUNC: 'job_emit_done_message' } : {} }));
  out.push(makeEntry({ boot, ms: t0 + 2700, prio: 6, ident: 'systemd-journald', unit: 'systemd-journald.service', msg: 'Journal started', pid: 312 }));
  out.push(makeEntry({ boot, ms: t0 + 2701, prio: 6, ident: 'systemd-journald', unit: 'systemd-journald.service', msg: 'System Journal (/var/log/journal/5e1e7e0a5e1e7e0a5e1e7e0a5e1e7e0a) is 312.0M, max 4.0G, 3.6G free.', pid: 312 }));
  sd(2800, 6, 'Starting NetworkManager.service - Network Manager...', 'NetworkManager.service');
  sd(2950, 6, 'Started NetworkManager.service - Network Manager.', 'NetworkManager.service');
  sd(3000, 6, 'Starting bluetooth.service - Bluetooth service...', 'bluetooth.service');
  sd(3050, 6, 'Started bluetooth.service - Bluetooth service.', 'bluetooth.service');
  out.push(makeEntry({ boot, ms: t0 + 3060, prio: 6, ident: 'bluetoothd', unit: 'bluetooth.service', msg: 'Bluetooth daemon 5.72', pid: 811, exe: '/usr/libexec/bluetooth/bluetoothd' }));
  out.push(makeEntry({ boot, ms: t0 + 3070, prio: 6, ident: 'bluetoothd', unit: 'bluetooth.service', msg: 'Starting SDP server', pid: 811, exe: '/usr/libexec/bluetooth/bluetoothd' }));
  out.push(makeEntry({ boot, ms: t0 + 3300, prio: 3, ident: 'bluetoothd', unit: 'bluetooth.service', msg: 'Failed to set mode: Blocked through rfkill (0x12)', pid: 811, exe: '/usr/libexec/bluetooth/bluetoothd' }));
  sd(3100, 6, 'Starting cups-browsed.service - Make remote CUPS printers available locally...', 'cups-browsed.service');
  out.push(makeEntry({ boot, ms: t0 + 3400, prio: 3, ident: 'cups-browsed', unit: 'cups-browsed.service', msg: 'cups-browsed: Unable to connect to the CUPS scheduler: No such file or directory', pid: 902 }));
  sd(3410, 5, 'cups-browsed.service: Main process exited, code=exited, status=1/FAILURE', 'cups-browsed.service');
  sd(3411, 4, 'cups-browsed.service: Failed with result \'exit-code\'.', 'cups-browsed.service');
  sd(3412, 3, 'Failed to start cups-browsed.service - Make remote CUPS printers available locally.', 'cups-browsed.service');
  sd(3500, 6, 'Started cron.service - Regular background program processing daemon.', 'cron.service');
  out.push(makeEntry({ boot, ms: t0 + 3510, prio: 6, ident: 'cron', unit: 'cron.service', msg: '(CRON) INFO (pidfile fd = 3)', pid: 905 }));
  sd(3600, 6, 'Starting greetd.service - Greeter daemon...', 'greetd.service');
  sd(3601, 6, 'Started greetd.service - Greeter daemon.', 'greetd.service');
  sd(3700, 6, 'Reached target graphical.target - Graphical Interface.', 'graphical.target');
  sd(3900, 3, 'Failed to start plymouth-quit-wait.service - Hold until boot process finishes up.', 'plymouth-quit-wait.service');
  out.push(makeEntry({ boot, ms: t0 + 4000, prio: 4, ident: 'fwupd', unit: 'fwupd.service', msg: 'Failed to load SMBIOS: invalid DMI data size, got 2946 bytes, expected 3014', pid: 1210 }));
  out.push(makeEntry({ boot, ms: t0 + 9000, prio: 6, ident: 'greetd', unit: 'greetd.service', msg: 'pam_unix(greetd:session): session opened for user ana(uid=1000) by (uid=0)', pid: 1301 }));
  out.push(makeEntry({ boot, ms: t0 + 9010, prio: 6, ident: 'systemd-logind', unit: 'systemd-logind.service', msg: 'New session 2 of user ana.', pid: 820 }));
}

function periodic(boot, t0, t1, out, { ufw = true, step = 20000 } = {}) {
  // NetworkManager, UFW blocks, cron, earlyoom: background noise across the boot.
  let t = t0 + 12000;
  let n = 0;
  while (t < t1) {
    n++;
    const r = rand();
    if (ufw && r < 0.35) {
      out.push(makeEntry({ boot, ms: t, prio: 4, ident: 'kernel', msg: `[UFW BLOCK] IN=wlan0 OUT= MAC=01:00:5e:00:00:fb:16:99:fd:af:da:09:08:00 SRC=192.168.1.${10 + Math.floor(rand() * 200)} DST=224.0.0.251 LEN=32 TOS=0x00 PREC=0x00 TTL=1 ID=${Math.floor(rand() * 65000)} PROTO=2 ` }));
    } else if (r < 0.55) {
      out.push(makeEntry({ boot, ms: t, prio: 6, ident: 'NetworkManager', unit: 'NetworkManager.service', pid: 820, msg: `<info>  [${(t / 1000).toFixed(4)}] device (wlan0): supplicant interface state: completed -> completed` }));
    } else if (r < 0.62) {
      out.push(makeEntry({ boot, ms: t, prio: 4, ident: 'NetworkManager', unit: 'NetworkManager.service', pid: 820, msg: `<warn>  [${(t / 1000).toFixed(4)}] dhcp4 (wlan0): request timed out` }));
    } else if (r < 0.72) {
      out.push(makeEntry({ boot, ms: t, prio: 6, ident: 'CRON', unit: 'cron.service', pid: 2000 + n, msg: '(root) CMD (test -x /etc/cron.daily/popularity-contest && /etc/cron.daily/popularity-contest --crond)' }));
      out.push(makeEntry({ boot, ms: t + 1, prio: 6, ident: 'CRON', unit: 'cron.service', pid: 2000 + n, msg: 'pam_unix(cron:session): session opened for user root(uid=0) by root(uid=0)' }));
    } else if (r < 0.82) {
      out.push(makeEntry({ boot, ms: t, prio: 6, ident: 'earlyoom', unit: 'earlyoom.service', pid: 640, msg: `mem avail: ${11000 + Math.floor(rand() * 2000)} of 15890 MiB (${(70 + rand() * 10).toFixed(2)}%), swap free: 2047 of 2047 MiB (100.00%)` }));
    } else if (r < 0.9) {
      out.push(makeEntry({ boot, ms: t, prio: 7, ident: 'wpa_supplicant', unit: 'wpa_supplicant.service', pid: 833, msg: `wlan0: CTRL-EVENT-SIGNAL-CHANGE above=1 signal=-${50 + Math.floor(rand() * 20)} noise=9999 txrate=866700` }));
    } else {
      out.push(makeEntry({ boot, ms: t, prio: 5, ident: 'kernel', msg: `audit: type=1107 audit(${(t / 1000).toFixed(3)}:${300 + n}): pid=880 uid=103 auid=4294967295 ses=4294967295 subj=unconfined msg='apparmor="DENIED" operation="dbus_signal" bus="system" path="/org/freedesktop/NetworkManager"'` }));
    }
    t += step + Math.floor(rand() * step * 2);
  }
}

function userSession(boot, t0, t1, out) {
  const u = (dt, prio, ident, msg, o = {}) => out.push(makeEntry({ boot, ns: 'user', ms: t0 + dt, prio, ident, msg, ...o }));
  u(100, 6, 'systemd', 'Starting pipewire.service - PipeWire Multimedia Service...', { extra: { USER_UNIT: 'pipewire.service' } });
  u(150, 6, 'systemd', 'Started pipewire.service - PipeWire Multimedia Service.', { extra: { USER_UNIT: 'pipewire.service' } });
  u(400, 4, 'pipewire', "spa.alsa: 'front:0': playback open failed: Device or resource busy", { userUnit: 'pipewire.service', pid: 1802 });
  u(500, 4, 'wireplumber', 'wp-device: SPA handle \'api.libcamera.enum.manager\' could not be loaded; is it installed?', { userUnit: 'wireplumber.service', pid: 1803 });
  u(900, 4, 'gnome-keyring-daemon', "couldn't access control socket: /run/user/1000/keyring/control: No such file or directory", { userUnit: 'gnome-keyring-daemon.service', pid: 1790 });
  u(1500, 6, 'aurora-shell', '[shell] Selene shell 1.0.0 started (shell mode)', { pid: 1850, comm: 'electron' });
  u(1800, 4, 'xdg-desktop-portal', 'Failed to load module: /usr/lib/x86_64-linux-gnu/xdg-desktop-portal/impl-gtk.so', { userUnit: 'xdg-desktop-portal.service', pid: 1901 });
  let t = 60000;
  let n = 0;
  while (t0 + t < t1) {
    n++;
    const r = rand();
    if (r < 0.4) u(t, 6, 'aurora-shell', `[autostart] ${['nm-applet', 'blueman-applet', 'org.flameshot.Flameshot', 'syncthing-start'][n % 4]}: skipped (Selene provides it)`, { pid: 1850, comm: 'electron' });
    else if (r < 0.6) u(t, 4, 'org.mozilla.firefox', '[GFX1-]: glxtest: libEGL missing', { userUnit: `app-flatpak-org.mozilla.firefox-${4200 + n}.scope`, pid: 4200 + n, comm: 'firefox-bin' });
    else if (r < 0.8) u(t, 6, 'pipewire', `mod.client-node: ${n}: running`, { userUnit: 'pipewire.service', pid: 1802 });
    else u(t, 7, 'aurora-shell', `[ipc] storage:set files/prefs (${200 + n} bytes)`, { pid: 1850, comm: 'electron' });
    t += 90000 + Math.floor(rand() * 120000);
  }
}

export function buildDefault() {
  rnd = 0x5e1e7e;
  seqState.system = 0x3e000;
  seqState.user = 0x1200;
  const sys = { older: [], previous: [], current: [] };
  const usr = { older: [], previous: [], current: [] };
  // ---- two days ago: a normal day, clean shutdown
  {
    const { start, end } = BOOT_TIMES.older;
    bootKernel('older', start, sys.older);
    bootSystemd('older', start, sys.older);
    periodic('older', start, end - 60000, sys.older, { step: 70000 });
    userSession('older', start + 9500, end - 60000, usr.older);
    const sd = (dt, msg, unit) => sys.older.push(makeEntry({ boot: 'older', ms: end - 4000 + dt, prio: 6, ident: 'systemd', msg, extra: unit ? { UNIT: unit } : {} }));
    sd(0, 'Stopping greetd.service - Greeter daemon...', 'greetd.service');
    sd(800, 'Stopped greetd.service - Greeter daemon.', 'greetd.service');
    sd(1500, 'Reached target shutdown.target - System Shutdown.', 'shutdown.target');
    sys.older.push(makeEntry({ boot: 'older', ms: end - 1000, prio: 6, ident: 'systemd-shutdown', pid: 1, msg: 'Syncing filesystems and block devices.' }));
    sys.older.push(makeEntry({ boot: 'older', ms: end, prio: 5, ident: 'kernel', msg: 'reboot: Power down' }));
  }
  // ---- yesterday: ends with a GPU hang (the session froze; no shutdown messages)
  {
    const { start, end } = BOOT_TIMES.previous;
    bootKernel('previous', start, sys.previous, { gpuWarn: true });
    bootSystemd('previous', start, sys.previous);
    periodic('previous', start, end - 120000, sys.previous, { step: 70000 });
    userSession('previous', start + 9500, end - 120000, usr.previous);
    const k = (dt, prio, msg) => sys.previous.push(makeEntry({ boot: 'previous', ms: end - 40000 + dt, prio, ident: 'kernel', msg }));
    usr.previous.push(makeEntry({ boot: 'previous', ns: 'user', ms: end - 42000, prio: 4, ident: 'aurora-shell', pid: 1850, comm: 'electron', msg: '[robust] shell renderer unresponsive, waiting 5 s before reloading it' }));
    k(0, 3, 'amdgpu 0000:05:00.0: amdgpu: ring gfx_0.0.0 timeout, signaled seq=184467, emitted seq=184469');
    k(1, 3, 'amdgpu 0000:05:00.0: amdgpu:  Process information: process Xorg pid 1342 thread Xorg:cs0 pid 1360');
    k(2, 4, 'amdgpu 0000:05:00.0: amdgpu: GPU reset begin!');
    k(9000, 3, 'amdgpu 0000:05:00.0: amdgpu: GPU reset(2) failed');
    k(20000, 0, 'watchdog: BUG: soft lockup - CPU#3 stuck for 26s! [Xorg:1342]');
    k(20001, 4, 'Modules linked in: rfcomm snd_seq_dummy snd_hrtimer amdgpu amdxcp drm_exec gpu_sched drm_buddy iwlmvm mac80211 iwlwifi cfg80211 nvme');
    k(20002, 4, 'CPU: 3 PID: 1342 Comm: Xorg Tainted: G             L     6.8.0-45-generic #45-Ubuntu');
    k(31000, 2, 'rcu: INFO: rcu_preempt detected stalls on CPUs/tasks:');
    k(31001, 2, 'rcu: \t3-...!: (1 GPs behind) idle=8a4c/1/0x4000000000000000 softirq=212043/212044 fqs=1205');
  }
  // ---- this boot (still running)
  {
    const { start, end } = BOOT_TIMES.current;
    bootKernel('current', start, sys.current);
    bootSystemd('current', start, sys.current);
    periodic('current', start, end - 30000, sys.current);
    userSession('current', start + 9500, end - 30000, usr.current);
    const t = start + 20 * 60000;
    // A message that is not valid UTF-8 (journalctl prints it as a byte array): colour codes + 0xff 0xfe + « é ».
    sys.current.push(
      makeEntry({
        boot: 'current',
        ms: t,
        prio: 4,
        ident: 'colord-sane',
        unit: 'colord.service',
        pid: 1460,
        msg: bytes('\x1b[1;31mcolord-sane\x1b[0m: scan failed on device \xff\xfe (caf\xc3\xa9 scanner)'),
        extra: { _CMDLINE: bytes('/usr/libexec/colord-sane\x00--verbose') },
      }),
    );
    // A field that appears twice in the entry: journalctl prints an array of strings.
    sys.current.push(makeEntry({ boot: 'current', ms: t + 60000, prio: 4, ident: 'sensors', pid: 1555, msg: ["sensors: Can't open /sys/class/hwmon/hwmon3/temp1_input", 'sensors: retrying with hwmon4'] }));
    // A field too large for journalctl without --all: null.
    sys.current.push(makeEntry({ boot: 'current', ms: t + 120000, prio: 6, ident: 'Xorg', unit: 'greetd.service', pid: 1342, msg: null }));
    // A huge, multi-line message (a JavaScript stack trace dumped by an app): ~100 KB.
    const frames = [];
    for (let i = 0; frames.join('\n').length < 100000; i++) frames.push(`    at walk (app://shell/apps/code/lib/tree.js:${100 + (i % 400)}:${7 + (i % 30)})`);
    usr.current.push(makeEntry({ boot: 'current', ns: 'user', ms: t + 180000, prio: 3, ident: 'aurora-shell', pid: 1850, comm: 'electron', msg: `[renderer:code] Uncaught RangeError: Maximum call stack size exceeded\n${frames.join('\n')}` }));
    usr.current.push(makeEntry({ boot: 'current', ns: 'user', ms: t + 240000, prio: 3, ident: 'aurora-shell', pid: 1850, comm: 'electron', msg: "[renderer:files] TypeError: Cannot read properties of null (reading 'path') (app://shell/apps/files/main.js:812)" }));
    // Regex characters in a message (search must treat the text literally).
    sys.current.push(makeEntry({ boot: 'current', ms: t + 300000, prio: 5, ident: 'kernel', msg: 'pcieport 0000:00:1c.0: [12] Timeout (*) on link (a+b)?' }));
  }
  const sortE = (a) => a.sort((x, y) => Number(BigInt(x.__REALTIME_TIMESTAMP) - BigInt(y.__REALTIME_TIMESTAMP)) || Number(x.__SEQNUM) - Number(y.__SEQNUM));
  // Sequence numbers follow time, as in a real journal file: renumber after sorting (cursors carry them).
  const renumber = (list, first) => list.forEach((e, i) => {
    const s = first + i;
    e.__SEQNUM = String(s);
    e.__CURSOR = e.__CURSOR.replace(/;i=[0-9a-f]+;/, `;i=${hex(s)};`).replace(/;x=[0-9a-f]+$/, `;x=${hex((s * 2654435761) >>> 0)}`);
  });
  const files = {};
  let nextSys = 0x3e000;
  let nextUsr = 0x1200;
  for (const k of Object.keys(BOOTS)) {
    sortE(sys[k]);
    sortE(usr[k]);
    renumber(sys[k], nextSys);
    renumber(usr[k], nextUsr);
    nextSys += sys[k].length;
    nextUsr += usr[k].length;
    files[`system/${BOOTS[k]}.jsonl`] = sys[k];
    files[`user/${BOOTS[k]}.jsonl`] = usr[k];
  }
  seqState.system = nextSys;
  seqState.user = nextUsr;
  const boots = ['older', 'previous', 'current'].map((k, i) => {
    const all = [...sys[k], ...usr[k]];
    const us = all.map((e) => BigInt(e.__REALTIME_TIMESTAMP));
    const min = us.reduce((a, b) => (b < a ? b : a));
    const max = us.reduce((a, b) => (b > a ? b : a));
    return { index: i - 2, boot_id: BOOTS[k], first_entry: Number(min), last_entry: Number(max) };
  });
  return { boots, files };
}

export function writeFixture(dir, built = buildDefault(), meta = {}) {
  fs.mkdirSync(path.join(dir, 'system'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'user'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'boots.json'), `${JSON.stringify(built.boots)}\n`);
  for (const [rel, entries] of Object.entries(built.files)) fs.writeFileSync(path.join(dir, rel), entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'meta.json'), `${JSON.stringify({ limited: false, pcre2: true, missing: false, ...meta }, null, 2)}\n`);
}

/** Copy a fixture directory (tests work on a copy: follow appends to it). */
export function copyFixture(from, to) {
  fs.cpSync(from, to, { recursive: true });
  return to;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'default');
  writeFixture(dir);
  const b = buildDefault();
  const counts = Object.fromEntries(Object.entries(b.files).map(([k, v]) => [k, v.length]));
  console.log(`fixture written to ${dir}`, counts);
}
