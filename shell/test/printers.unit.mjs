// Printing backend, no Electron window:
// 1. main/lib/cups.js parsers on real CUPS 2.4 / avahi 0.8 outputs (lpstat, lpq, lpinfo, avahi-browse, ipptool),
//    discovery merge, queue names, lp argv validation for printers:print;
// 2. main/ipc/printers.js in REAL mode against fake lpstat / lp / cancel / lpq / lpinfo / avahi-browse / ipptool on PATH
//    (argv logged, state in a temp dir) — the machine's own CUPS is never used;
// 3. main/ipc/printers.js in dev mode (simulated CUPS + simulated aurora-admin printer-* actions);
// 4. aurora-admin: the printer-* branch run with fake lpadmin / lpstat / cupsenable… (exact argv), and the real helper
//    refusing bad arguments before anything runs (as root).
// Usage:  cd aurora-os/shell && node test/printers.unit.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HELPER = path.join(ROOT, '..', 'rootfs', 'usr', 'lib', 'aurora', 'helpers', 'aurora-admin');
let passed = 0;
const failures = [];
function check(name, actual, expected) {
  const ok = typeof expected === 'function' ? !!expected(actual) : Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++;
  else failures.push(`${name}\n      expected: ${typeof expected === 'function' ? '(predicate)' : JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
  return ok;
}
async function rejects(name, promise, code) {
  try {
    await promise;
    check(name, 'resolved', `rejects ${code}`);
  } catch (e) {
    check(name, e.code, code);
  }
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-printers-'));

// ---------------------------------------------------------------- fixtures (C locale outputs)
const LPSTAT_LP = `printer HP_LaserJet_M110w is idle.  enabled since Tue 13 Oct 2026 09:12:04 AM CEST
\tForm mounted:
\tContent types: any
\tPrinter types: unknown
\tDescription: HP LaserJet M110w
\tAlerts: none
\tLocation: Bureau
\tConnection: direct
\tInterface: /etc/cups/ppd/HP_LaserJet_M110w.ppd
\tOn fault: no alert
\tAfter fault: continue
\tUsers allowed:
\t\t(all)
\tForms allowed:
\t\t(none)
\tBanner required
\tCharset sets:
\t\t(none)
\tDefault pitch:
\tDefault page size:
\tDefault port settings:
printer Office.2 now printing Office.2-31.  enabled since Tue 13 Oct 2026 09:20:00 AM CEST
\tSending data to printer.
\tDescription: Brother MFC-L2710DW
\tAlerts: toner-low-warning
\tLocation:
printer Canon disabled since Tue 13 Oct 2026 09:00:00 AM CEST -
\tPaused
\tDescription: Canon PIXMA G3570
\tAlerts: paused
\tLocation: Salon
printer Epson is idle.  enabled since Tue 13 Oct 2026 09:00:00 AM CEST
\tThe printer is not responding.
\tDescription: EPSON ET-2850
\tAlerts: offline-report
\tLocation:
printer Jammed is idle.  enabled since Tue 13 Oct 2026 09:00:00 AM CEST
\tDescription: Jammed
\tAlerts: media-jam-error cover-open-error
\tLocation:
`;
const AVAHI = `+;eth0;IPv4;EPSON\\032ET-2850\\032Series;_ipp._tcp;local
=;eth0;IPv4;EPSON\\032ET-2850\\032Series;_ipp._tcp;local;EPSON1C2B3A.local;192.168.1.31;631;"txtvers=1" "rp=ipp/print" "ty=EPSON ET-2850 Series" "note=Salon" "UUID=cfe92100-67c4-11d4-a45f-e0bb9e1c2b3a" "Color=T" "Duplex=T"
=;eth0;IPv4;HP\\032LaserJet\\032M110w\\032\\0914F2A1B\\093;_ipp._tcp;local;HPLJM110w.local;192.168.1.20;631;"txtvers=1" "rp=ipp/print" "ty=HP LaserJet M110w" "UUID=564e4333-4a31-4d31-3130-4f2a1b000001"
=;lo;IPv4;Canon\\032G3070\\032series\\032\\040USB\\041;_ipp._tcp;local;selene.local;127.0.0.1;60000;"txtvers=1" "rp=ipp/print" "ty=Canon PIXMA G3570" "UUID=00000000-0000-1000-8000-60128b7a9c10"
=;eth0;IPv6;Bad\\.Name\\\\x;_ipp._tcp;local;bad.local;fe80::1;631;"ty=(Weird \\"quoted\\" model)"
`;
const AVAHI_S = `=;eth0;IPv4;EPSON\\032ET-2850\\032Series;_ipps._tcp;local;EPSON1C2B3A.local;192.168.1.31;443;"txtvers=1" "rp=ipp/print" "ty=EPSON ET-2850 Series" "UUID=cfe92100-67c4-11d4-a45f-e0bb9e1c2b3a"
`;
const LPINFO = `Device: uri = dnssd://Brother%20MFC-L2710DW%20series._ipp._tcp.local/?uuid=e3248000-80ce-11db-8000-3c2af4a1b2c3
        class = network
        info = Brother MFC-L2710DW series
        make-and-model = Brother MFC-L2710DW series
        device-id = MFG:Brother;CMD:PJL,PCL,PCLXL,URF;MDL:MFC-L2710DW series;CLS:PRINTER;
        location = Couloir
Device: uri = usb://Samsung/ML-1660%20Series?serial=Z5G2BKFZ300712V
        class = direct
        info = Samsung ML-1660 Series
        make-and-model = Samsung ML-1660 Series
        device-id = MFG:Samsung;CMD:SPL;MDL:ML-1660 Series;
        location =
Device: uri = usb://Canon/G3070%20series?serial=1234
        class = direct
        info = Canon G3070 series
        make-and-model = Canon PIXMA G3570
        device-id =
        location =
`;
const IPPTOOL = `"/usr/share/cups/ipptool/get-printer-attributes.test":
    Get-Printer-Attributes:
        attributes-charset (charset) = utf-8
        printer-name (nameWithoutLanguage) = Canon
        marker-colors (1setOf nameWithoutLanguage) = #000000,#00FFFF,#FF00FF,#FFFF00,none
        marker-levels (1setOf integer) = 72,45,18,-3,-1
        marker-names (1setOf nameWithoutLanguage) = Black,Cyan,Magenta,Yellow,Waste
        marker-types (1setOf keyword) = ink,ink,ink,ink,waste-ink
    [PASS]
`;

try {
  // ================================================================ 1. parsers
  const c = require('../main/lib/cups.js');
  const ps = c.parseLpstatPrinters(LPSTAT_LP);
  check('lpstat -l -p: 5 printers', ps.map((p) => p.name), ['HP_LaserJet_M110w', 'Office.2', 'Canon', 'Epson', 'Jammed']);
  check('lpstat: idle / printing (job id with dots) / paused', ps.map((p) => [p.state, p.job]).slice(0, 3), [['idle', null], ['printing', 'Office.2-31'], ['paused', null]]);
  check('lpstat: description, location, alerts', [ps[0].description, ps[0].location, ps[0].reasons, ps[1].reasons], ['HP LaserJet M110w', 'Bureau', [], ['toner-low-warning']]);
  check('lpstat: state message line', [ps[1].message, ps[2].message, ps[3].message], ['Sending data to printer.', 'Paused', 'The printer is not responding.']);
  check('lpstat -d', [c.parseLpstatDefault('system default destination: HP_LaserJet_M110w\n'), c.parseLpstatDefault('no system default destination\n')], ['HP_LaserJet_M110w', null]);
  check('lpstat -v', c.parseLpstatDevices('device for HP: dnssd://HP%20LaserJet._ipp._tcp.local/?uuid=1\ndevice for Canon: ipp://localhost:60000/ipp/print\n'), { HP: 'dnssd://HP%20LaserJet._ipp._tcp.local/?uuid=1', Canon: 'ipp://localhost:60000/ipp/print' });
  check('lpstat -a', c.parseLpstatAccepting('HP accepting requests since Tue 13 Oct 2026\nCanon not accepting requests since Tue 13 Oct 2026 -\n\tRejecting Jobs\n'), { HP: true, Canon: false });
  const jobs = c.parseLpstatJobs('HP_LaserJet_M110w-12    anna            248832   Tue 13 Oct 2026 09:12:04 AM CEST\nOffice.2-31 camille 1024   Tue 13 Oct 2026 09:20:00 AM CEST\n');
  check('lpstat -o', jobs, [
    { id: 'HP_LaserJet_M110w-12', printer: 'HP_LaserJet_M110w', number: 12, user: 'anna', size: 248832, date: 'Tue 13 Oct 2026 09:12:04 AM CEST' },
    { id: 'Office.2-31', printer: 'Office.2', number: 31, user: 'camille', size: 1024, date: 'Tue 13 Oct 2026 09:20:00 AM CEST' },
  ]);
  check('lpq -a: titles with spaces, rank', c.parseLpq('Rank    Owner   Job     File(s)                         Total Size\nactive  anna    12      Rapport annuel 2026.pdf         248832 bytes\n1st     camille 31      Test Page                       1024 bytes\n'), { 12: { rank: 'active', owner: 'anna', title: 'Rapport annuel 2026.pdf' }, 31: { rank: '1st', owner: 'camille', title: 'Test Page' } });
  const li = c.parseLpinfo(LPINFO);
  check('lpinfo -l -v', [li.length, li[0].cls, li[0].model, li[0].location, li[1].uri], [3, 'network', 'Brother MFC-L2710DW series', 'Couloir', 'usb://Samsung/ML-1660%20Series?serial=Z5G2BKFZ300712V']);
  const av = c.parseAvahiBrowse(AVAHI);
  check('avahi-browse -rtp: resolved lines only, \\DDD and \\. unescaped', av.map((s) => s.name), ['EPSON ET-2850 Series', 'HP LaserJet M110w [4F2A1B]', 'Canon G3070 series (USB)', 'Bad.Name\\x']);
  check('avahi-browse: TXT records (keys lower-case, quotes unescaped)', [av[0].txt.ty, av[0].txt.uuid, av[0].txt.color, av[3].txt.ty], ['EPSON ET-2850 Series', 'cfe92100-67c4-11d4-a45f-e0bb9e1c2b3a', 'T', '(Weird "quoted" model)']);
  check('dnssd URI like CUPS', c.dnssdUri('HP LaserJet M110w [4F2A1B]', '_ipp._tcp', 'local', 'abc-1'), 'dnssd://HP%20LaserJet%20M110w%20%5B4F2A1B%5D._ipp._tcp.local/?uuid=abc-1');
  check('queue names: model, accents, [suffix], unique', [c.queueName('HP LaserJet M110w [4F2A1B]'), c.queueName('Imprimante Étage #2'), c.queueName('EPSON ET-2850', ['EPSON_ET-2850']), c.queueName('***'), c.queueName('x'.repeat(80)).length], ['HP_LaserJet_M110w', 'Imprimante_Etage_2', 'EPSON_ET-2850_2', 'Imprimante', 40]);
  const attrs = c.parseIppAttributes(IPPTOOL);
  check('ipptool attributes', attrs['marker-levels'], ['72', '45', '18', '-3', '-1']);
  check('ink markers', c.markersOf(attrs), [
    { name: 'Black', level: 72, color: '#000000', type: 'ink' },
    { name: 'Cyan', level: 45, color: '#00FFFF', type: 'ink' },
    { name: 'Magenta', level: 18, color: '#FF00FF', type: 'ink' },
    { name: 'Yellow', level: -3, color: '#FFFF00', type: 'ink' },
    { name: 'Waste', level: null, color: null, type: 'waste-ink' },
  ]);
  const sum = c.summarize({ printers: ps, def: 'HP_LaserJet_M110w', devices: { HP_LaserJet_M110w: 'dnssd://HP._ipp._tcp.local/?uuid=1', Canon: 'ipp://localhost:60000/ipp/print' }, accepting: { Canon: false }, jobs, markers: { Canon: [{ name: 'Black', level: 5 }] } });
  check('summary: states (ready, printing, paused, offline, error)', sum.map((p) => p.state), ['idle', 'printing', 'paused', 'offline', 'error']);
  check('summary: default, label, connection, jobs, accepting, markers', [sum[0].isDefault, sum[1].isDefault, sum[0].label, sum[0].connection, sum[2].connection, sum[0].jobs, sum[1].jobs, sum[2].accepting, sum[0].accepting, sum[2].markers.length], [true, false, 'HP LaserJet M110w', 'network', 'usb', 1, 1, false, true, 1]);
  check('summary: reasons said simply (suffixes dropped, paused hidden)', [sum[1].reasons, sum[2].reasons, sum[4].reasons], [['toner-low'], [], ['media-jam', 'cover-open']]);
  const found = c.discoveredPrinters({ services: [...av, ...c.parseAvahiBrowse(AVAHI_S)], lpinfo: li, queues: [{ name: 'HP_LaserJet_M110w', uri: 'dnssd://HP%20LaserJet%20M110w%20%5B4F2A1B%5D._ipp._tcp.local/?uuid=564e4333-4a31-4d31-3130-4f2a1b000001' }] });
  const byModel = Object.fromEntries(found.map((f) => [f.model, f]));
  check('discovery: configured printer (same UUID) left out', found.some((f) => /M110w/.test(f.model)), false);
  check('discovery: IPP + IPPS of one printer -> one entry, IPPS kept', [found.filter((f) => /ET-2850/.test(f.model)).length, byModel['EPSON ET-2850 Series']?.type, byModel['EPSON ET-2850 Series']?.uri], [1, '_ipps._tcp', 'dnssd://EPSON%20ET-2850%20Series._ipps._tcp.local/?uuid=cfe92100-67c4-11d4-a45f-e0bb9e1c2b3a']);
  check('discovery: ipp-usb printer on loopback = USB, driverless; plain usb:// of the same model dropped', [byModel['Canon PIXMA G3570']?.connection, byModel['Canon PIXMA G3570']?.driverless, found.filter((f) => /G3570|G3070/.test(f.model)).length], ['usb', true, 1]);
  check('discovery: lpinfo dnssd printer added (driverless), usb-only printer needs a driver', [byModel['Brother MFC-L2710DW series']?.driverless, byModel['Brother MFC-L2710DW series']?.location, byModel['Samsung ML-1660 Series']?.driverless], [true, 'Couloir', false]);
  check('discovery: queue names unique and valid, labels valid, URIs valid', found.every((f) => c.validQueue(f.queue) && c.validInfo(f.label) && (!f.driverless || c.validUri(f.uri))) && new Set(found.map((f) => f.queue)).size === found.length, true);
  check('discovery: weird names sanitised (quotes)', found.find((f) => /Weird/.test(f.model))?.label, (l) => l && !/["\\]/.test(l));
  check('discovery: driverless first', found.map((f) => f.driverless), (a) => a.indexOf(false) === a.length - 1);
  // labels: 127 UTF-8 BYTES, like aurora-admin (${#v} under LC_ALL=C)
  check('labels: byte length (accents count twice), 127 bytes max', [c.labelBytes('Imprimante de l’étage'), c.validInfo('é'.repeat(63)), c.validInfo('é'.repeat(64)), c.validInfo('x'.repeat(127))], [24, true, false, true]);
  check('labels: fitLabel cuts at 127 bytes without splitting a character', [c.labelBytes(c.fitLabel('é'.repeat(100))), c.fitLabel('é'.repeat(100)).endsWith('é'), c.fitLabel('  Bureau  ')], [126, true, 'Bureau']);
  const longModel = `Imprimante très spéciale ${'é'.repeat(80)}`;
  const longFound = c.discoveredPrinters({ services: [{ ...av[0], name: 'Longue', txt: { ...av[0].txt, ty: longModel, uuid: 'long-1' } }] });
  check('discovery: a long accented model gives a label the helper accepts', longFound.map((f) => [c.validInfo(f.label), c.labelBytes(f.label) <= 127]), (v) => v.length === 1 && v[0][0] === true && v[0][1] === true);
  // the page's free name (a temporary CUPS queue of the same name, a printer with the same label)
  {
    const pageSrc = path.join(tmp, 'printers-page.mjs');
    fs.writeFileSync(pageSrc, fs.readFileSync(path.join(ROOT, 'renderer', 'apps', 'settings', 'pages', 'printers.js'), 'utf8'));
    const { freeName } = await import(pageSrc);
    const ep = { queue: 'EPSON_ET-2850_Series', label: 'EPSON ET-2850 Series' };
    check('free name: nothing in the way -> unchanged', freeName(ep, [{ name: 'HP', label: 'HP' }]), ep);
    check('free name: the helper said « already exists » -> _2 queue, « (2) » label', freeName(ep, [], ['EPSON_ET-2850_Series']), { queue: 'EPSON_ET-2850_Series_2', label: 'EPSON ET-2850 Series (2)' });
    check('free name: same label and _2 taken -> (3)', freeName(ep, [{ name: 'Old', label: 'EPSON ET-2850 Series' }, { name: 'epson_et-2850_series_2', label: 'x' }]), { queue: 'EPSON_ET-2850_Series_3', label: 'EPSON ET-2850 Series (3)' });
    const long = freeName({ queue: 'Q'.repeat(63), label: 'é'.repeat(63) }, [{ name: 'Q'.repeat(63), label: 'y' }]);
    check('free name: long names stay valid (63-char queue, 127-byte label)', [c.validQueue(long.queue), c.validInfo(long.label), long.label.endsWith(' (2)')], [true, true, true]);
  }
  // lp argv
  check('lp argv: everything', c.lpArgs('/home/a/doc.pdf', { printer: 'HP_LaserJet_M110w', copies: 2, pages: '1-3, 5', duplex: true, orientation: 'portrait', media: 'a4', color: 'monochrome', collate: true, title: 'Rapport' }), ['-d', 'HP_LaserJet_M110w', '-n', '2', '-t', 'Rapport', '-o', 'page-ranges=1-3,5', '-o', 'sides=two-sided-long-edge', '-o', 'orientation-requested=3', '-o', 'media=A4', '-o', 'print-color-mode=monochrome', '-o', 'collate=true', '--', '/home/a/doc.pdf']);
  check('lp argv: landscape duplex = short edge, Letter, defaults omitted', c.lpArgs('/f.pdf', { landscape: true, duplex: true, pageSize: 'Letter' }), ['-o', 'sides=two-sided-short-edge', '-o', 'orientation-requested=4', '-o', 'media=Letter', '--', '/f.pdf']);
  check('lp argv: no options -> default printer', c.lpArgs('/f.pdf', {}), ['--', '/f.pdf']);
  const badOpts = [{ printer: '-x' }, { printer: 'a b' }, { copies: 0 }, { copies: 1000 }, { copies: '2; rm' }, { pages: '3-1' }, { pages: '0' }, { pages: '1,,a' }, { pages: '1-2-3' }, { duplex: 'yes' }, { orientation: 'up' }, { media: 'A4;x' }, { media: 'Tabloid' }, { color: 'red' }, { title: 'a\nb' }];
  check('lp argv: every bad option -> EINVAL', badOpts.filter((o) => { try { c.lpArgs('/f.pdf', o); return true; } catch (e) { return e.code !== 'EINVAL'; } }), []);
  check('page ranges', [c.pageRanges('1-3, 5'), c.pageRanges(' 2 – 4 '), c.pageRanges('')], ['1-3,5', '2-4', null]);
  check('request id', c.parseRequestId('request id is HP_LaserJet_M110w-14 (1 file(s))\n'), 'HP_LaserJet_M110w-14');
  check('validators', [c.validJob('HP-12'), c.validJob('HP-0'), c.validJob('-x-1'), c.validUri('ipp://[fe80::1]:631/ipp/print'), c.validUri('file:///etc/passwd'), c.validUri('ipp://a b'), c.validUri("ipp://a/'x'")], [true, false, false, true, false, false, false]);

  // ================================================================ 2. real mode against fake tools on PATH
  const bin = path.join(tmp, 'bin');
  const state = path.join(tmp, 'state');
  fs.mkdirSync(bin);
  fs.mkdirSync(state);
  fs.writeFileSync(path.join(state, 'lpstat-lp'), LPSTAT_LP);
  fs.writeFileSync(path.join(state, 'avahi-ipp'), AVAHI);
  fs.writeFileSync(path.join(state, 'avahi-ipps'), AVAHI_S);
  fs.writeFileSync(path.join(state, 'lpinfo'), LPINFO);
  fs.writeFileSync(path.join(state, 'ipptool'), IPPTOOL);
  const tool = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/bin/bash\nS='${state}'\nprintf '%s\\0' ${name} "$@" >>"$S/argv"; printf '\\n' >>"$S/argv"\n${body}\n`, { mode: 0o755 });
  tool('lpstat', `case "$*" in
  "-l -p") cat "$S/lpstat-lp" ;;
  "-d") echo "system default destination: HP_LaserJet_M110w" ;;
  "-v") printf 'device for HP_LaserJet_M110w: dnssd://HP%%20LaserJet%%20M110w%%20%%5B4F2A1B%%5D._ipp._tcp.local/?uuid=564e4333-4a31-4d31-3130-4f2a1b000001\\ndevice for Canon: ipp://localhost:60000/ipp/print\\n' ;;
  "-a") echo "HP_LaserJet_M110w accepting requests since Tue 13 Oct 2026" ;;
  "-o") printf 'HP_LaserJet_M110w-12    %s            248832   Tue 13 Oct 2026 09:12:04 AM CEST\\nOffice.2-31 camille 1024   Tue 13 Oct 2026\\n' "$(id -un)" ;;
  *) exit 1 ;;
esac`);
  tool('lpq', `printf 'Rank    Owner   Job     File(s)                         Total Size\\nactive  me      12      Rapport annuel.pdf              248832 bytes\\n'`);
  tool('ipptool', `[[ "$*" == *"/printers/Canon "* ]] && cat "$S/ipptool"; exit 0`);
  tool('avahi-browse', `case "$2" in _ipp._tcp) cat "$S/avahi-ipp" ;; _ipps._tcp) cat "$S/avahi-ipps" ;; esac`);
  tool('lpinfo', `echo "lpinfo: Forbidden" >&2; exit 1`);
  tool('lp', `[[ "$*" == *nope* ]] && { echo "lp: The printer or class does not exist." >&2; exit 1; }; echo "request id is \${2:-HP}-77 (1 file(s))"`);
  tool('cancel', `case "$1" in *-12) exit 0 ;; *-31) echo "cancel: Office.2-31: You don't own job ID Office.2-31." >&2; exit 1 ;; *) echo "cancel: Job ID $1 does not exist." >&2; exit 1 ;; esac`);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  for (const k of Object.keys(require.cache)) if (/main[\\/](lib[\\/]exec|ipc[\\/]printers)\.js$/.test(k)) delete require.cache[k];
  const handlers = {};
  const fakeApi = { DEV: false, env: {}, handle: (ch, fn) => (handlers[ch] = fn) };
  require('../main/ipc/printers.js')(fakeApi);
  const argvLog = () => fs.readFileSync(path.join(state, 'argv'), 'utf8').split('\n').filter(Boolean).map((l) => l.split('\0').filter(Boolean));
  const L = await handlers['printers:list']();
  check('real: printers:list available, 5 printers, default', [L.available, L.running, L.printers.length, L.default, L.printers[0].isDefault], [true, true, 5, 'HP_LaserJet_M110w', true]);
  check('real: ink levels from ipptool for Canon only', [L.printers.find((p) => p.name === 'Canon').markers.length, L.printers[0].markers.length], [5, 0]);
  check('real: jobs with titles, mine flag', L.jobs.map((j) => [j.id, j.title, j.mine]), [['HP_LaserJet_M110w-12', 'Rapport annuel.pdf', true], ['Office.2-31', '', false]]);
  const calls = argvLog();
  check('real: lpstat -l -p / -d / -v / -a / -o, lpq -a, ipptool per queue (argv)', ['lpstat -l -p', 'lpstat -d', 'lpstat -v', 'lpstat -a', 'lpstat -o', 'lpq -a', 'ipptool -T 3 -tv ipp://localhost/printers/Canon get-printer-attributes.test'].every((x) => calls.some((cl) => cl.join(' ') === x)), true);
  const D = await handlers['printers:discover']();
  check('real: discovery without lpinfo rights (Forbidden) still lists DNS-SD printers (Canon on ipp-usb already a queue)', D.printers.map((p) => p.model).sort(), ['EPSON ET-2850 Series', 'Weird "quoted" model']);
  check('real: avahi-browse argv', ['avahi-browse -rtp _ipp._tcp', 'avahi-browse -rtp _ipps._tcp', 'lpinfo -l -v --include-schemes dnssd,usb --timeout 5'].every((x) => argvLog().some((cl) => cl.join(' ') === x)), true);
  const doc = path.join(tmp, 'mon document.pdf');
  fs.writeFileSync(doc, '%PDF-1.4\n');
  fs.writeFileSync(path.join(state, 'argv'), '');
  const P = await handlers['printers:print'](doc, { printer: 'HP_LaserJet_M110w', copies: 3, pages: '2-4', duplex: true, media: 'A4', orientation: 'portrait' });
  check('real: printers:print -> job id', P, { jobId: 'HP_LaserJet_M110w-77', printer: 'HP_LaserJet_M110w' });
  check('real: lp argv (options as -o values, file after --)', argvLog()[0], ['lp', '-d', 'HP_LaserJet_M110w', '-n', '3', '-o', 'page-ranges=2-4', '-o', 'sides=two-sided-long-edge', '-o', 'orientation-requested=3', '-o', 'media=A4', '--', doc]);
  await rejects('real: print a missing file -> ENOENT', handlers['printers:print'](path.join(tmp, 'missing.pdf'), {}), 'ENOENT');
  await rejects('real: print a relative path -> EINVAL', handlers['printers:print']('doc.pdf', {}), 'EINVAL');
  await rejects('real: print a folder -> EINVAL', handlers['printers:print'](tmp, {}), 'EINVAL');
  await rejects('real: print with bad options -> EINVAL', handlers['printers:print'](doc, { copies: -1 }), 'EINVAL');
  await rejects('real: print on an unknown printer -> ENOENT', handlers['printers:print'](doc, { printer: 'nope' }), 'ENOENT');
  check('real: cancel own job', await handlers['printers:cancel']('HP_LaserJet_M110w-12'), { ok: true });
  await rejects('real: cancel another user\'s job -> EPERM', handlers['printers:cancel']('Office.2-31'), 'EPERM');
  await rejects('real: cancel unknown job -> ENOENT', handlers['printers:cancel']('HP-99'), 'ENOENT');
  await rejects('real: cancel bad id -> EINVAL', handlers['printers:cancel']('-a'), 'EINVAL');
  await rejects('real: test page bad name -> EINVAL', handlers['printers:testPage']('a;b'), 'EINVAL');
  // No CUPS at all: lpstat missing.
  process.env.PATH = path.join(tmp, 'empty');
  for (const k of Object.keys(require.cache)) if (/main[\\/](lib[\\/]exec|ipc[\\/]printers)\.js$/.test(k)) delete require.cache[k];
  const h2 = {};
  require('../main/ipc/printers.js')({ DEV: false, env: {}, handle: (ch, fn) => (h2[ch] = fn) });
  const L2 = await h2['printers:list']();
  check('real: no CUPS -> available false', [L2.available, L2.printers.length], [false, 0]);
  await rejects('real: print without CUPS -> ENOTSUP', h2['printers:print'](doc, {}), 'ENOTSUP');
  process.env.PATH = oldPath;
  for (const k of Object.keys(require.cache)) if (/main[\\/](lib[\\/]exec|ipc[\\/]printers)\.js$/.test(k)) delete require.cache[k];

  // ================================================================ 3. dev mode (simulated CUPS + admin actions)
  const h3 = {};
  const printersMod = require('../main/ipc/printers.js');
  printersMod({ DEV: true, env: {}, handle: (ch, fn) => (h3[ch] = fn) });
  await h3['printers:devSet']({ kind: 'office' });
  const d1 = await h3['printers:list']();
  check('dev: office = 2 printers, HP default, Canon ink low', [d1.printers.map((p) => p.name), d1.default, d1.printers[1].reasons, d1.printers[1].markers.length], [['HP_LaserJet_M110w', 'Canon_PIXMA_G3570'], 'HP_LaserJet_M110w', ['marker-supply-low'], 4]);
  const d2 = await h3['printers:discover']();
  check('dev: discovery = Epson (IPPS), Brother + Samsung (driver needed); HP (UUID) and Canon (ipp://localhost:60000 = ipp-usb) already added', d2.printers.map((p) => [p.queue, p.driverless]), [['Brother_MFC-L2710DW_series', true], ['EPSON_ET-2850_Series', true], ['Samsung_ML-1660_Series', false]]);
  check('discovery: a queue on ipp://HOST:PORT hides that service (host name, address or loopback)', [c.discoveredPrinters({ services: av, queues: [{ name: 'E', uri: 'ipp://192.168.1.31/ipp/print' }, { name: 'C', uri: 'ipp://localhost:60000/ipp/print' }] }).map((f) => f.model).sort(), c.discoveredPrinters({ services: av, queues: [{ name: 'E', uri: 'ipps://EPSON1C2B3A.local:631/ipp/print' }] }).some((f) => /ET-2850/.test(f.model))], [['HP LaserJet M110w', 'Weird "quoted" model'], false]);
  const admin = require('../main/ipc/admin.js').parsers;
  const ep = d2.printers[1];
  check('admin.js validates the add action built from discovery', (() => { try { admin.validate('printer-add', [ep.queue, ep.uri, ep.label]); return true; } catch (e) { return e.message; } })(), true);
  await printersMod.devRun('printer-add', [ep.queue, ep.uri, ep.label]);
  await printersMod.devRun('printer-default', [ep.queue]);
  await printersMod.devRun('printer-enable', ['HP_LaserJet_M110w', '0']);
  await printersMod.devRun('printer-rename', ['HP_LaserJet_M110w', 'Imprimante du bureau']);
  const d3 = await h3['printers:list']();
  check('dev: added, default changed, HP paused and renamed', [d3.printers.length, d3.default, d3.printers[0].state, d3.printers[0].label], [3, 'EPSON_ET-2850_Series', 'paused', 'Imprimante du bureau']);
  const t1 = await h3['printers:testPage']('EPSON_ET-2850_Series');
  check('dev: test page job', t1.jobId, 'EPSON_ET-2850_Series-14');
  await rejects('dev: cancel another user\'s job -> EPERM', h3['printers:cancel']('HP_LaserJet_M110w-13'), 'EPERM');
  await printersMod.devRun('printer-job-cancel', ['HP_LaserJet_M110w-13']);
  await printersMod.devRun('printer-remove', ['Canon_PIXMA_G3570']);
  const d4 = await h3['printers:list']();
  check('dev: job cancelled by admin, printer removed', [d4.jobs.map((j) => j.id), d4.printers.map((p) => p.name)], [['HP_LaserJet_M110w-12', 'EPSON_ET-2850_Series-14'], ['HP_LaserJet_M110w', 'EPSON_ET-2850_Series']]);
  await h3['printers:devSet']({ kind: 'nocups' });
  check('dev: nocups', (await h3['printers:list']()).available, false);
  await h3['printers:devSet']({ kind: 'office' });

  // ================================================================ 4. aurora-admin
  const src = fs.readFileSync(HELPER, 'utf8');
  const start = src.indexOf('\nprinter-add | printer-remove | printer-default | printer-enable | printer-rename | printer-job-cancel)\n');
  const end = src.indexOf('# ------------------------------------------------------------------ END printers');
  check('aurora-admin has the printer-* branch', start > 0 && end > start, true);
  const branch = src.slice(start + 1, end); // the whole case item: pattern, body, ;;
  // Run the branch body with fake CUPS admin tools first on PATH (functions die / log / need_args / valid_bool /
  // run_or_die copied from the helper itself).
  const fn = (name) => new RegExp(`^${name}\\(\\) \\{[^\\n]*; \\}\\n`, 'm').exec(src)?.[0] || new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?\\n\\}\\n`, 'm').exec(src)?.[0];
  const helpers = ['die', 'run_or_die', 'need_args', 'valid_bool'].map(fn);
  check('helper functions found', helpers.every(Boolean), true);
  const abin = path.join(tmp, 'abin');
  fs.mkdirSync(abin);
  const alog = path.join(tmp, 'admin-argv');
  for (const b of ['lpadmin', 'cupsenable', 'cupsdisable', 'cupsaccept', 'cancel', 'timeout']) {
    fs.writeFileSync(path.join(abin, b), `#!/bin/bash\nprintf '%s\\0' ${b} "$@" >>'${alog}'; printf '\\n' >>'${alog}'\n${b === 'timeout' ? 'shift; exec "$@"' : ''}\n`, { mode: 0o755 });
  }
  fs.writeFileSync(path.join(abin, 'lpstat'), `#!/bin/bash\ncase "$*" in "-p HP"|"-p Old") exit 0 ;; "-d") [ -e '${tmp}/hasdefault' ] && echo "system default destination: HP" || echo "no system default destination"; exit 0 ;; *) exit 1 ;; esac\n`, { mode: 0o755 });
  const runBranch = (...args) => {
    fs.writeFileSync(alog, '');
    const script = `set -euo pipefail\nPROG=aurora-admin\nCALLER=tester\nlog() { :; }\n${helpers.join('')}\nACTION=$1\nshift\ncase $ACTION in\n${branch}\nesac\n`;
    const r = spawnSync('bash', ['-c', script, 'x', ...args], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', PATH: `${abin}:/usr/bin:/bin` } }); // the helper exports LC_ALL=C
    return { code: r.status, out: r.stdout, err: r.stderr, argv: fs.readFileSync(alog, 'utf8').split('\n').filter(Boolean).map((l) => l.split('\0').filter(Boolean)) };
  };
  const a1 = runBranch('printer-add', 'EPSON_ET-2850', 'dnssd://EPSON%20ET-2850%20Series._ipps._tcp.local/?uuid=cfe92100', 'EPSON ET-2850 Series');
  check('helper printer-add: lpadmin -p Q -E -v URI -m everywhere -D label, retry-job, first printer = default', [a1.code, a1.argv.map((a) => a.join(' '))], [0, ['timeout 80 lpadmin -p EPSON_ET-2850 -E -v dnssd://EPSON%20ET-2850%20Series._ipps._tcp.local/?uuid=cfe92100 -m everywhere -D EPSON ET-2850 Series -o printer-error-policy=retry-job', 'lpadmin -p EPSON_ET-2850 -E -v dnssd://EPSON%20ET-2850%20Series._ipps._tcp.local/?uuid=cfe92100 -m everywhere -D EPSON ET-2850 Series -o printer-error-policy=retry-job', 'lpadmin -d EPSON_ET-2850']]);
  fs.writeFileSync(path.join(tmp, 'hasdefault'), '');
  check('helper printer-add: an existing default is kept', runBranch('printer-add', 'Brother', 'ipp://192.168.1.42/ipp/print', 'Brother').argv.map((a) => a[0] + (a[0] === 'timeout' ? '' : ` ${a[1]}`)), ['timeout', 'lpadmin -p']);
  check('helper printer-add: existing queue refused (exit 4)', runBranch('printer-add', 'HP', 'ipp://a/ipp/print', 'HP').code, 4);
  check('helper printer-remove / default / rename / enable / job-cancel argv', [runBranch('printer-remove', 'HP').argv, runBranch('printer-default', 'HP').argv, runBranch('printer-rename', 'HP', 'Imprimante du bureau').argv, runBranch('printer-enable', 'HP', '0').argv, runBranch('printer-enable', 'HP', '1').argv, runBranch('printer-job-cancel', 'HP-12').argv], [[['lpadmin', '-x', 'HP']], [['lpadmin', '-d', 'HP']], [['lpadmin', '-p', 'HP', '-D', 'Imprimante du bureau']], [['cupsdisable', 'HP']], [['cupsenable', 'HP'], ['cupsaccept', 'HP']], [['cancel', 'HP-12']]]);
  check('helper: unknown printer -> exit 3', runBranch('printer-remove', 'Nope').code, 3);
  const badArgs = [
    ['printer-add', 'HP;x', 'ipp://a/b', 'L'],
    ['printer-add', '-HP', 'ipp://a/b', 'L'],
    ['printer-add', 'HP2', 'file:///etc/passwd', 'L'],
    ['printer-add', 'HP2', 'usb://Samsung/ML', 'L'],
    ['printer-add', 'HP2', 'ipp://a b', 'L'],
    ['printer-add', 'HP2', 'ipp://a/b', 'L"x'],
    ['printer-add', 'HP2', 'ipp://a/b', 'L\\x'],
    ['printer-add', 'HP2', 'ipp://a/b', ' L'],
    ['printer-add', 'HP2', 'ipp://a/b', 'x'.repeat(128)],
    ['printer-add', 'HP2', 'ipp://a/b', 'é'.repeat(64)], // 64 characters but 128 bytes
    ['printer-rename', 'HP', `Imprimante ${'é'.repeat(60)}`],
    ['printer-add', 'HP2', 'ipp://a/b'],
    ['printer-rename', 'HP', 'a\nb'],
    ['printer-enable', 'HP', 'yes'],
    ['printer-job-cancel', 'HP'],
    ['printer-job-cancel', '-a-1'],
    ['printer-remove', '../etc'],
    ['printer-remove', 'HP', 'extra'],
  ];
  const wrong = badArgs.filter((a) => runBranch(...a).code !== 2);
  check(`helper refuses bad arguments with exit 2 (nothing run)${wrong.length ? ` wrong: ${wrong.map((w) => w.join(' ')).join(' | ')}` : ''}`, wrong.length, 0);
  check('helper refusals ran nothing', badArgs.every((a) => runBranch(...a).argv.length === 0), true);
  if (process.getuid?.() === 0) {
    const real = (...a) => spawnSync(HELPER, a, { encoding: 'utf8', input: '' });
    const w2 = badArgs.filter((a) => real(...a).status !== 2);
    check(`real aurora-admin (root) refuses bad printer arguments before anything runs${w2.length ? ` wrong: ${w2.map((w) => w.join(' ')).join(' | ')}` : ''}`, w2.length, 0);
  }
  if (spawnSync('which', ['shellcheck']).status === 0) check('aurora-admin passes shellcheck', spawnSync('shellcheck', [HELPER]).status, 0);
  check('helper + admin.js accept 127 bytes of accents (63 é + 1)', [runBranch('printer-rename', 'HP', `${'é'.repeat(63)}x`).code, (() => { try { admin.validate('printer-rename', ['HP', `${'é'.repeat(63)}x`]); return 0; } catch (e) { return e.code; } })()], [0, 0]);
  check('admin.js: same refusals', badArgs.filter((a) => { try { admin.validate(a[0], a.slice(1)); return true; } catch (e) { return e.code !== 'EINVAL'; } }).map((a) => a.join(' ')), []);

  // ================================================================ 5. image: package list, services, verify-iso
  const list = fs.readFileSync(path.join(ROOT, '..', 'iso', 'packages.d', 'printing.list'), 'utf8').split('\n').filter((l) => l && !l.startsWith('#'));
  check('printing.list', list, ['cups', 'cups-filters', 'cups-ipp-utils', 'ipp-usb', 'avahi-daemon', 'avahi-utils', 'libnss-mdns']);
  const build = fs.readFileSync(path.join(ROOT, '..', 'iso', 'build.sh'), 'utf8');
  check('build.sh enables cups + avahi units', /for u in cups\.socket cups\.path cups\.service avahi-daemon\.socket avahi-daemon\.service; do/.test(build), true);
  const verify = fs.readFileSync(path.join(ROOT, '..', 'tools', 'verify-iso.sh'), 'utf8');
  check('verify-iso checks printing binaries, units and helper actions', ['/usr/sbin/lpadmin', 'ipp-usb', 'for u in cups.socket cups.path cups.service avahi-daemon.service', 'printer-add | printer-remove'].every((x) => verify.includes(x)), true);
} catch (e) {
  failures.push(`exception: ${e.stack || e}`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`printers.unit: ${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  FAIL ${f}`);
process.exit(failures.length ? 1 : 0);
