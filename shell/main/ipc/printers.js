'use strict';
// Printers backend (Paramètres > Appareils > Imprimantes et scanners, and the Selene print dialog). CUPS through its
// command-line clients, run as the user; parsers in main/lib/cups.js.
//
//   printers:list ()  -> { available, running, printers: [{ name, label, description, location, uri, connection,
//                          isDefault, state: idle|printing|paused|error|offline, accepting, message, reasons[], jobs,
//                          markers: [{ name, level 0–100|-3|null, color, type }] }], default, jobs: [{ id, printer,
//                          number, user, size, date, title, rank, mine }], tools, simulated }
//                        `lpstat -l -p`, `lpstat -d`, `lpstat -v`, `lpstat -a`, `lpstat -o`, `lpq -a` (titles),
//                        `ipptool -tv ipp://localhost/printers/NAME get-printer-attributes.test` (ink / toner levels).
//   printers:discover () -> { printers: [{ key, queue, label, model, uri, info, location, connection: network|usb,
//                          driverless, color, duplex }], tools }
//                        DNS-SD (`avahi-browse -rtp _ipp._tcp` and `_ipps._tcp`: network printers, and USB printers
//                        shared by ipp-usb on the loopback interface) plus `lpinfo -l -v --include-schemes dnssd,usb`
//                        when CUPS lets this user list devices. Printers that already have a queue are left out.
//                        A driverless one is added with aurora-admin printer-add <queue> <uri> <label>
//                        (lpadmin -p QUEUE -E -v URI -m everywhere).
//   printers:testPage (name)        -> { jobId }    lp -d NAME -t "Page de test" /usr/share/cups/data/default-testpage.pdf
//   printers:cancel (jobId)         -> { ok }       cancel JOBID (the user's own jobs; EPERM for another user's job:
//                                                   aurora-admin printer-job-cancel then)
//   printers:print (file, options)  -> { jobId, printer }   lp [options] -- FILE. Used by the print dialog.
//       options: { printer (queue name; the default printer when omitted), copies 1–999, pages "1-3,5",
//       duplex: true|false|'long'|'short' (or sides: one-sided|two-sided-long-edge|two-sided-short-edge),
//       orientation: portrait|landscape (or landscape: bool), media (or pageSize): A4|A5|A3|Letter|Legal,
//       color: 'color'|'monochrome'|bool, collate: bool, fitToPage: bool, title }   -> -o page-ranges=, sides=,
//       orientation-requested=, media=, print-color-mode=, collate=, fit-to-page. All validated (EINVAL); the file
//       must be an absolute path to a readable regular file (ENOENT).
// Errors: ENOTSUP (CUPS is not installed: no lpstat), EINVAL, ENOENT, EPERM, ECMD.
//
// Administration (add, remove, default, pause / resume, rename, cancel another user's job) goes through
// aurora-admin printer-* actions (shell.runAdmin: « Autorisation administrateur »), see admin.js.
//
// Dev mode (--dev): a simulated CUPS that answers with real CUPS 2.4 / avahi 0.8 outputs, read by the same parsers.
//   AURORA_DEV_PRINTERS=office (default: two printers, one job) | none (no printer yet) | nocups (CUPS not installed)
// admin.js routes the simulated printer-* actions to devRun() below.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { run, which } = require('../lib/exec');
const cups = require('../lib/cups');

// Test page: Ubuntu 24.04 ships the PDF one of libcupsfilters2-common (Debian drops CUPS' own data/testprint);
// testprint is kept as a fallback for an upstream CUPS build.
const TESTPRINTS = ['/usr/share/cups/data/default-testpage.pdf', '/usr/share/cups/data/testprint'];
const testPrintFile = () => TESTPRINTS.find((f) => fs.existsSync(f));
const MAX_FILE = 1024 * 1024 * 1024;

function err(message, code) {
  const e = new Error(message);
  e.code = code;
  return e;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ simulated CUPS (dev, UI tests)
const DATE = 'Tue 13 Oct 2026 09:12:04 AM CEST';
const DEV_SERVICES = [
  // Already added below (same UUID): left out of the discovery list.
  ['eth0', 'HP\\032LaserJet\\032M110w\\032\\0914F2A1B\\093', '_ipp._tcp', 'HPLJM110w.local', '192.168.1.20', 631, ['txtvers=1', 'rp=ipp/print', 'ty=HP LaserJet M110w', 'note=Bureau', 'UUID=564e4333-4a31-4d31-3130-4f2a1b000001', 'pdl=application/pdf,image/urf,image/pwg-raster', 'Color=F', 'Duplex=F']],
  ['eth0', 'EPSON\\032ET-2850\\032Series', '_ipp._tcp', 'EPSON1C2B3A.local', '192.168.1.31', 631, ['txtvers=1', 'rp=ipp/print', 'ty=EPSON ET-2850 Series', 'note=Salon', 'UUID=cfe92100-67c4-11d4-a45f-e0bb9e1c2b3a', 'pdl=application/octet-stream,image/pwg-raster,image/urf,image/jpeg', 'Color=T', 'Duplex=T']],
  ['eth0', 'EPSON\\032ET-2850\\032Series', '_ipps._tcp', 'EPSON1C2B3A.local', '192.168.1.31', 443, ['txtvers=1', 'rp=ipp/print', 'ty=EPSON ET-2850 Series', 'note=Salon', 'UUID=cfe92100-67c4-11d4-a45f-e0bb9e1c2b3a', 'TLS=1.2', 'Color=T', 'Duplex=T']],
  ['eth0', 'Brother\\032MFC-L2710DW\\032series', '_ipp._tcp', 'BRW3C2AF4.local', '192.168.1.42', 631, ['txtvers=1', 'rp=ipp/print', 'ty=Brother MFC-L2710DW series', 'note=', 'UUID=e3248000-80ce-11db-8000-3c2af4a1b2c3', 'pdl=application/octet-stream,image/urf,image/pwg-raster', 'Color=F', 'Duplex=T']],
  ['lo', 'Canon\\032PIXMA\\032G3570\\032\\040USB\\041', '_ipp._tcp', 'selene.local', '127.0.0.1', 60000, ['txtvers=1', 'rp=ipp/print', 'ty=Canon PIXMA G3570', 'UUID=00000000-0000-1000-8000-60128b7a9c10', 'usb_MFG=Canon', 'usb_MDL=G3070 series', 'Color=T', 'Duplex=F']],
];
const DEV_LPINFO = [
  'Device: uri = usb://Samsung/ML-1660%20Series?serial=Z5G2BKFZ300712V',
  '        class = direct',
  '        info = Samsung ML-1660 Series',
  '        make-and-model = Samsung ML-1660 Series',
  '        device-id = MFG:Samsung;CMD:SPL,FWV,PIC,BDN,EXT;MDL:ML-1660 Series;CLS:PRINTER;MODE:SPL3;',
  '        location = ',
].join('\n');

let devState = null;
function dev() {
  if (!devState) {
    const kind = ['office', 'none', 'nocups'].includes(process.env.AURORA_DEV_PRINTERS) ? process.env.AURORA_DEV_PRINTERS : 'office';
    const q = (name, description, location, uri, extra = {}) => ({ name, description, location, uri, enabled: true, accepting: true, reasons: [], message: '', markers: null, ...extra });
    devState = { kind, nextJob: 14, def: null, queues: [], jobs: [] };
    if (kind === 'office') {
      devState.queues.push(
        q('HP_LaserJet_M110w', 'HP LaserJet M110w', 'Bureau', 'dnssd://HP%20LaserJet%20M110w%20%5B4F2A1B%5D._ipp._tcp.local/?uuid=564e4333-4a31-4d31-3130-4f2a1b000001', {
          markers: { names: ['Black Cartridge HP 142A'], levels: [64], colors: ['#000000'], types: ['toner-cartridge'] },
        }),
        q('Canon_PIXMA_G3570', 'Canon PIXMA G3570', '', 'ipp://localhost:60000/ipp/print', {
          reasons: ['marker-supply-low-warning'],
          message: 'Niveau d’encre faible',
          markers: { names: ['Black', 'Cyan', 'Magenta', 'Yellow'], levels: [72, 45, 18, 60], colors: ['#000000', '#00FFFF', '#FF00FF', '#FFFF00'], types: ['ink', 'ink', 'ink', 'ink'] },
        }),
      );
      devState.def = 'HP_LaserJet_M110w';
      const me = os.userInfo().username;
      devState.jobs.push({ printer: 'HP_LaserJet_M110w', number: 12, user: me, size: 248832, title: 'Rapport annuel.pdf' }, { printer: 'HP_LaserJet_M110w', number: 13, user: 'camille', size: 51200, title: 'Facture octobre.pdf' });
    }
  }
  return devState;
}
const devQueue = (name) => dev().queues.find((x) => x.name === name);

/** Dev: what the CUPS / avahi tools print for these argv (C locale). */
async function devExec(cmd, args) {
  const st = dev();
  const ok = (stdout) => ({ code: 0, stdout, stderr: '' });
  const fail = (stderr, code = 1) => ({ code, stdout: '', stderr });
  if (st.kind === 'nocups' && ['lpstat', 'lp', 'lpq', 'cancel', 'lpinfo', 'ipptool'].includes(cmd)) throw err(`${cmd}: command not found`, 'ENOENT');
  await sleep(30);
  const a = args.join(' ');
  if (cmd === 'lpstat') {
    if (a === '-l -p') {
      if (!st.queues.length) return fail('lpstat: No destinations added.\n');
      return ok(
        st.queues
          .map((x) => {
            const active = st.jobs.find((j) => j.printer === x.name && j.active);
            const head = !x.enabled ? `printer ${x.name} disabled since ${DATE} -` : active ? `printer ${x.name} now printing ${x.name}-${active.number}.  enabled since ${DATE}` : `printer ${x.name} is idle.  enabled since ${DATE}`;
            const msg = x.message || (!x.enabled ? 'Paused' : '');
            return [head, msg ? `\t${msg}` : null, '\tForm mounted:', '\tContent types: any', '\tPrinter types: unknown', `\tDescription: ${x.description}`, `\tAlerts: ${[...(x.enabled ? [] : ['paused']), ...x.reasons].join(' ') || 'none'}`, `\tLocation: ${x.location}`, '\tConnection: direct', `\tInterface: /etc/cups/ppd/${x.name}.ppd`, '\tOn fault: no alert', '\tAfter fault: continue', '\tUsers allowed:', '\t\t(all)', '\tForms allowed:', '\t\t(none)', '\tBanner required', '\tCharset sets:', '\t\t(none)', '\tDefault pitch:', '\tDefault page size:', '\tDefault port settings:']
              .filter((l) => l != null)
              .join('\n');
          })
          .join('\n') + '\n',
      );
    }
    if (a === '-d') return ok(st.def ? `system default destination: ${st.def}\n` : 'no system default destination\n');
    if (a === '-v') return st.queues.length ? ok(st.queues.map((x) => `device for ${x.name}: ${x.uri}\n`).join('')) : fail('lpstat: No destinations added.\n');
    if (a === '-a') return ok(st.queues.map((x) => (x.accepting ? `${x.name} accepting requests since ${DATE}\n` : `${x.name} not accepting requests since ${DATE} -\n\tRejecting Jobs\n`)).join(''));
    if (a === '-o') return ok(st.jobs.map((j) => `${`${j.printer}-${j.number}`.padEnd(20)} ${j.user.padEnd(15)} ${String(j.size).padStart(8)}   ${DATE}\n`).join(''));
    return fail(`lpstat: unknown simulated arguments ${a}\n`);
  }
  if (cmd === 'lpq' && a === '-a') {
    if (!st.jobs.length) return ok('no entries\n');
    return ok(`Rank    Owner   Job     File(s)                         Total Size\n${st.jobs.map((j, i) => `${(i === 0 ? 'active' : `${i}${['st', 'nd', 'rd'][i - 1] || 'th'}`).padEnd(7)} ${j.user.slice(0, 7).padEnd(7)} ${String(j.number).padEnd(7)} ${j.title.padEnd(31)} ${j.size} bytes\n`).join('')}`);
  }
  if (cmd === 'ipptool') {
    const name = /\/printers\/([^/\s]+)$/.exec(args.find((x) => x.startsWith('ipp://')) || '')?.[1];
    const x = devQueue(name);
    if (!x) return fail('ipptool: Unable to connect\n');
    const m = x.markers;
    const body = ['"/usr/share/cups/ipptool/get-printer-attributes.test":', '    Get-Printer-Attributes:', '        attributes-charset (charset) = utf-8', `        printer-name (nameWithoutLanguage) = ${x.name}`, '        printer-state (enum) = idle'];
    if (m) body.push(`        marker-colors (1setOf nameWithoutLanguage) = ${m.colors.join(',')}`, `        marker-levels (1setOf integer) = ${m.levels.join(',')}`, `        marker-names (1setOf nameWithoutLanguage) = ${m.names.join(',')}`, `        marker-types (1setOf keyword) = ${m.types.join(',')}`);
    return ok(`${body.join('\n')}\n    [PASS]\n`);
  }
  if (cmd === 'avahi-browse') {
    const type = args[args.length - 1];
    return ok(
      DEV_SERVICES.filter((s) => s[2] === type)
        .map(([iface, name, t, host, addr, port, txt]) => `+;${iface};IPv4;${name};${t};local\n=;${iface};IPv4;${name};${t};local;${host};${addr};${port};${txt.map((v) => `"${v}"`).join(' ')}`)
        .join('\n') + '\n',
    );
  }
  if (cmd === 'lpinfo') return ok(`${DEV_LPINFO}\n`);
  if (cmd === 'lp') {
    const d = args[args.indexOf('-d') + 1];
    const name = args.includes('-d') ? d : st.def;
    if (!name) return fail('lp: Error - no default destination available.\n');
    const x = devQueue(name);
    if (!x) return fail('lp: The printer or class does not exist.\n');
    if (!x.accepting) return fail(`lp: Destination "${name}" is not accepting jobs.\n`);
    const n = st.nextJob++;
    const title = args.includes('-t') ? args[args.indexOf('-t') + 1] : path.basename(args[args.length - 1]);
    st.jobs.push({ printer: name, number: n, user: os.userInfo().username, size: 20480, title, active: false });
    st.lastLp = args;
    return ok(`request id is ${name}-${n} (1 file(s))\n`);
  }
  if (cmd === 'cancel') {
    const id = args[0];
    const j = st.jobs.find((x) => `${x.printer}-${x.number}` === id);
    if (!j) return fail(`cancel: Job ID ${id} does not exist.\n`);
    if (j.user !== os.userInfo().username) return fail(`cancel: ${id}: You don't own job ID ${id}.\n`);
    st.jobs = st.jobs.filter((x) => x !== j);
    return ok('');
  }
  return fail(`${cmd}: not simulated\n`, 127);
}

/** Dev: simulated aurora-admin printer-* actions (called by admin.js). */
async function devRun(action, args) {
  const st = dev();
  const need = (name) => {
    const x = devQueue(name);
    if (!x) throw err(`no such printer: ${name}`, 'ENOTFOUND');
    return x;
  };
  await sleep(action === 'printer-add' ? 700 : 200);
  switch (action) {
    case 'printer-add': {
      const [name, uri, info] = args;
      // st.temp: a queue CUPS holds without listing it (a temporary queue made when an app printed to the printer)
      if (devQueue(name) || st.temp?.includes(name)) throw err(`a printer named ${name} already exists`, 'EPERM');
      if (process.env.AURORA_PRINTERS_DEV_FAIL === '1') throw err(`could not add ${name}: the printer did not answer (IPP Everywhere)`, 'ECMD');
      st.queues.push({ name, description: info || name, location: '', uri, enabled: true, accepting: true, reasons: [], message: '', markers: null });
      if (!st.def) st.def = name;
      return `ok ${name}\n`;
    }
    case 'printer-remove':
      need(args[0]);
      st.queues = st.queues.filter((x) => x.name !== args[0]);
      st.jobs = st.jobs.filter((j) => j.printer !== args[0]);
      if (st.def === args[0]) st.def = null;
      return 'ok\n';
    case 'printer-default':
      need(args[0]);
      st.def = args[0];
      return 'ok\n';
    case 'printer-enable': {
      const x = need(args[0]);
      x.enabled = args[1] === '1';
      if (x.enabled) x.accepting = true;
      return 'ok\n';
    }
    case 'printer-rename':
      need(args[0]).description = args[1];
      return 'ok\n';
    case 'printer-job-cancel': {
      const before = st.jobs.length;
      st.jobs = st.jobs.filter((j) => `${j.printer}-${j.number}` !== args[0]);
      if (st.jobs.length === before) throw err(`no such job: ${args[0]}`, 'ENOTFOUND');
      return 'ok\n';
    }
    default:
      throw err(`unknown action: ${action}`, 'EINVAL');
  }
}

// ------------------------------------------------------------------ module
function register(api) {
  const useMock = api.DEV && process.env.AURORA_REAL_BACKENDS !== '1';
  const exec = (cmd, args, opts = {}) => (useMock ? devExec(cmd, args) : run(cmd, args, { timeout: 15000, ...opts }));
  const has = (cmd) => (useMock ? !(dev().kind === 'nocups' && ['lpstat', 'lp', 'lpinfo', 'ipptool', 'lpq', 'cancel'].includes(cmd)) : !!which(cmd));
  const text = async (cmd, args, opts) => {
    try {
      const r = await exec(cmd, args, opts);
      return r;
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
  };
  const tools = () => ({ lpstat: has('lpstat'), lpinfo: has('lpinfo'), avahi: has('avahi-browse'), ipptool: has('ipptool') });

  async function markers(name) {
    if (!has('ipptool')) return [];
    const r = await text('ipptool', ['-T', '3', '-tv', `ipp://localhost/printers/${name}`, 'get-printer-attributes.test'], { timeout: 6000 }).catch(() => null);
    return r?.stdout ? cups.markersOf(cups.parseIppAttributes(r.stdout)) : [];
  }

  async function queues() {
    const r = await text('lpstat', ['-l', '-p']);
    if (!r) return null;
    // "No destinations added." is not an error; "Unable to connect" / "Bad file descriptor" = the scheduler is down.
    const down = r.code !== 0 && !/No destinations added/i.test(r.stderr);
    return { printers: r.code === 0 ? cups.parseLpstatPrinters(r.stdout) : [], running: !down, stderr: r.stderr };
  }

  async function list() {
    const q = await queues();
    if (!q) return { available: false, running: false, printers: [], default: null, jobs: [], tools: tools(), simulated: useMock };
    const [d, v, a, o, lpq] = await Promise.all([text('lpstat', ['-d']), text('lpstat', ['-v']), text('lpstat', ['-a']), text('lpstat', ['-o']), text('lpq', ['-a'])]);
    const def = cups.parseLpstatDefault(d?.stdout);
    const jobs = cups.parseLpstatJobs(o?.stdout);
    const titles = cups.parseLpq(lpq?.stdout);
    const me = os.userInfo().username;
    const mk = {};
    await Promise.all(q.printers.map(async (p) => (mk[p.name] = await markers(p.name))));
    const printers = cups.summarize({ printers: q.printers, def, devices: cups.parseLpstatDevices(v?.stdout), accepting: cups.parseLpstatAccepting(a?.stdout), jobs, markers: mk });
    return {
      available: true,
      running: q.running,
      printers,
      default: def,
      jobs: jobs.map((j) => ({ ...j, title: titles[j.number]?.title || '', rank: titles[j.number]?.rank || '', mine: j.user === me || j.user === me.slice(0, 7) })),
      tools: tools(),
      simulated: useMock,
    };
  }

  api.handle('printers:list', list);

  api.handle('printers:discover', async () => {
    const q = await queues();
    const devices = q ? cups.parseLpstatDevices((await text('lpstat', ['-v']))?.stdout) : {};
    const known = (q?.printers || []).map((p) => ({ name: p.name, uri: devices[p.name] || '' }));
    const browse = async (type) => {
      if (!has('avahi-browse')) return [];
      const r = await text('avahi-browse', ['-rtp', type], { timeout: 10000 }).catch(() => null);
      return r?.stdout ? cups.parseAvahiBrowse(r.stdout) : [];
    };
    const lpinfo = async () => {
      if (!has('lpinfo')) return [];
      // Needs CUPS administrator rights (CUPS-Get-Devices): empty for most users, which is fine.
      const r = await text('lpinfo', ['-l', '-v', '--include-schemes', 'dnssd,usb', '--timeout', '5'], { timeout: 12000 }).catch(() => null);
      return r?.code === 0 ? cups.parseLpinfo(r.stdout) : [];
    };
    const [ipp, ipps, info] = await Promise.all([browse('_ipp._tcp'), browse('_ipps._tcp'), lpinfo()]);
    return { printers: cups.discoveredPrinters({ services: [...ipp, ...ipps], lpinfo: info, queues: known }), tools: tools(), available: !!q, simulated: useMock };
  });

  async function lp(args) {
    let r;
    try {
      r = await exec('lp', args, { timeout: 60000 });
    } catch (e) {
      if (e.code === 'ENOENT') throw err('CUPS is not installed', 'ENOTSUP');
      throw e;
    }
    if (r.code !== 0) throw err((r.stderr || r.stdout || 'lp failed').trim().replace(/^lp: /, ''), /not exist|no default destination/i.test(r.stderr) ? 'ENOENT' : 'ECMD');
    return cups.parseRequestId(r.stdout);
  }

  api.handle('printers:testPage', async (name) => {
    if (!cups.validQueue(name)) throw err('Invalid printer name', 'EINVAL');
    const file = useMock ? TESTPRINTS[0] : testPrintFile();
    if (!file) throw err(`${TESTPRINTS[0]} is missing`, 'ENOENT');
    const jobId = await lp(['-d', name, '-t', 'Page de test', '--', file]);
    return { jobId };
  });

  api.handle('printers:cancel', async (jobId) => {
    if (!cups.validJob(jobId)) throw err('Invalid job id', 'EINVAL');
    let r;
    try {
      r = await exec('cancel', [jobId]);
    } catch (e) {
      if (e.code === 'ENOENT') throw err('CUPS is not installed', 'ENOTSUP');
      throw e;
    }
    if (r.code !== 0) {
      const m = (r.stderr || '').trim();
      throw err(m || 'cancel failed', /don't own|not-authorized|Forbidden|not authorized/i.test(m) ? 'EPERM' : /does not exist/i.test(m) ? 'ENOENT' : 'ECMD');
    }
    return { ok: true };
  });

  api.handle('printers:print', async (file, options = {}) => {
    if (typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\0')) throw err('Invalid file path', 'EINVAL');
    const args = cups.lpArgs(path.normalize(file), options || {});
    if (!useMock) {
      let st;
      try {
        st = fs.statSync(file);
        fs.accessSync(file, fs.constants.R_OK);
      } catch {
        throw err(`${file}: no such readable file`, 'ENOENT');
      }
      if (!st.isFile()) throw err(`${file} is not a file`, 'EINVAL');
      if (st.size > MAX_FILE) throw err(`${file} is too large to print`, 'EINVAL');
    }
    const jobId = await lp(args);
    return { jobId, printer: jobId ? jobId.replace(/-\d+$/, '') : options?.printer || null };
  });

  if (useMock) {
    // Dev helpers for tests: another simulated system (tempQueue: a hidden queue name, « already exists »), or the
    // arguments of the last lp call.
    api.handle('printers:devSet', async (o = {}) => {
      if (o.kind) process.env.AURORA_DEV_PRINTERS = String(o.kind);
      if ('fail' in o) process.env.AURORA_PRINTERS_DEV_FAIL = o.fail ? '1' : '0';
      devState = null;
      if (o.tempQueue) dev().temp = [String(o.tempQueue)];
      return dev().kind;
    });
    api.handle('printers:devLastLp', async () => dev().lastLp || null);
  }
}

module.exports = register;
module.exports.devRun = devRun;
module.exports.devExec = devExec;
