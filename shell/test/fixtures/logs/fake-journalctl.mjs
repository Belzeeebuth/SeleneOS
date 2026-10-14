// A stand-in for journalctl used by test/logs.test.mjs to test main/ipc/journal.js's real mode (spawned process,
// streamed JSON lines, stderr hints, exit codes) without this PC's journal. It reads a fixture directory
// (FAKE_JOURNAL_DIR, layout in fixture-lib.mjs) and follows the behaviour checked against journalctl 262:
//   --list-boots [--output=json]   JSON array; FAKE_JOURNAL_MODE=oldboots prints the old text table (UTC) instead
//   --field=NAME                   unique values
//   --output=json --all --no-pager [--user] [--boot=N|ID] [--priority=N] [--unit=U] [--user-unit=U] [--identifier=T]
//     [--since=@s] [--until=@s] [--grep=PCRE] [--reverse] [--lines=N] [--cursor=C | --after-cursor=C] [--follow]
//     [_TRANSPORT=kernel]
//   --since with a cursor -> "Please specify only one of --since=, --cursor=, …", exit 1
//   unknown boot -> "No journal boot entry found for the specified boot (N).", exit 1
//   --grep matching nothing -> exit 1, no message (like grep)
//   FAKE_JOURNAL_MODE=limited: the permission hint on stderr and only the user journal (without --user)
//   FAKE_JOURNAL_MODE=nopcre: --grep -> "PCRE2 support is not installed.", exit 1
//   --follow: the selection, then every line appended to the current boot's files (polled every 40 ms)
// FAKE_JOURNAL_LOG=<file>: every argument vector is appended there (one JSON array per line).
import fs from 'node:fs';
import path from 'node:path';

const dir = process.env.FAKE_JOURNAL_DIR;
const mode = new Set((process.env.FAKE_JOURNAL_MODE || '').split(',').filter(Boolean));
const args = process.argv.slice(2);
if (process.env.FAKE_JOURNAL_LOG) fs.appendFileSync(process.env.FAKE_JOURNAL_LOG, `${JSON.stringify(args)}\n`);
const opt = (name) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a == null ? null : a.slice(name.length + 3);
};
const has = (name) => args.includes(`--${name}`);
// Synchronous writes (process.exit() would cut pending pipe writes); a full pipe is waited for, a closed one
// (the backend stopped reading: it has its page) ends the process like journalctl's SIGPIPE.
const pause = new Int32Array(new SharedArrayBuffer(4));
const out = (s) => {
  let b = Buffer.from(s);
  while (b.length) {
    try {
      b = b.subarray(fs.writeSync(1, b));
    } catch (e) {
      if (e.code === 'EPIPE') process.exit(0);
      if (e.code !== 'EAGAIN') throw e;
      Atomics.wait(pause, 0, 0, 5);
    }
  }
};
const die = (msg, code = 1) => {
  if (msg) fs.writeSync(2, `${msg}\n`);
  process.exit(code);
};
const HINT = "Hint: You are currently not seeing messages from other users and the system.\n      Users in groups 'adm', 'systemd-journal' can see all messages.\n      Pass -q to turn off this notice.\n";
const boots = JSON.parse(fs.readFileSync(path.join(dir, 'boots.json'), 'utf8')).sort((a, b) => a.index - b.index);
const user = has('user');
const limited = mode.has('limited') && !user;
if (limited) fs.writeSync(2, HINT);

if (has('list-boots')) {
  if (mode.has('oldboots')) {
    const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const fmt = (us) => {
      const d = new Date(Math.floor(us / 1000));
      return `${day[d.getUTCDay()]} ${d.toISOString().slice(0, 19).replace('T', ' ')} UTC`;
    };
    out('IDX BOOT ID                          FIRST ENTRY                 LAST ENTRY\n');
    for (const b of boots) out(`${String(b.index).padStart(3)} ${b.boot_id} ${fmt(b.first_entry)}—${fmt(b.last_entry)}\n`);
  } else out(`${JSON.stringify(boots)}\n`);
  process.exit(0);
}

const nss = user || limited ? ['user'] : ['system', 'user'];
const readAll = (ids) => {
  const list = [];
  for (const id of ids) for (const ns of nss) list.push(...readFile(path.join(dir, ns, `${id}.jsonl`)));
  return list.sort(cmp);
};
function readFile(f) {
  try {
    return fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}
const key = (c) => ({ t: parseInt(/t=([0-9a-f]+)/.exec(c)?.[1] || '0', 16), i: parseInt(/i=([0-9a-f]+)/.exec(c)?.[1] || '0', 16) });
const cmpKey = (a, b) => a.t - b.t || a.i - b.i;
const cmp = (a, b) => cmpKey(key(a.__CURSOR), key(b.__CURSOR));

const field = opt('field');
if (field) {
  const set = new Set();
  for (const e of readAll(boots.map((b) => b.boot_id))) if (typeof e[field] === 'string') set.add(e[field]);
  for (const v of set) out(`${v}\n`);
  process.exit(0);
}

let ids = boots.map((b) => b.boot_id);
const b = opt('boot');
if (b != null) {
  const want = /^-?\d+$/.test(b) ? boots.find((x) => x.index === Number(b)) : boots.find((x) => x.boot_id === b);
  if (!want) die(`No journal boot entry found for the specified boot (${b}).`);
  ids = [want.boot_id];
}
const cursor = opt('cursor');
const after = opt('after-cursor');
if (opt('since') != null && (cursor != null || after != null)) die('Please specify only one of --since=, --cursor=, --cursor-file=, and --after-cursor=.');
const grep = opt('grep');
if (grep != null && mode.has('nopcre')) die('PCRE2 support is not installed.');

const text = (v) => (v == null ? '' : typeof v === 'string' ? v : Array.isArray(v) && v.every((x) => typeof x === 'number') ? Buffer.from(v).toString('utf8') : Array.isArray(v) ? v.map(text).join('\n') : String(v));
const glob = (g) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
const prio = opt('priority');
const unit = opt('unit');
const userUnit = opt('user-unit');
const ident = opt('identifier');
const since = opt('since');
const until = opt('until');
const sinceUs = since ? Number(since.slice(1)) * 1e6 : null;
const untilUs = until ? Number(until.slice(1)) * 1e6 : null;
const kernel = args.includes('_TRANSPORT=kernel');
const re = grep != null ? new RegExp(grep, /[A-Z]/.test(grep) ? '' : 'i') : null;
const match = (e) => {
  const us = Number(e.__REALTIME_TIMESTAMP);
  if (prio != null && !(e.PRIORITY != null && Number(e.PRIORITY) <= Number(prio))) return false;
  if (unit && !['_SYSTEMD_UNIT', 'UNIT', 'COREDUMP_UNIT', 'OBJECT_SYSTEMD_UNIT'].some((k) => glob(unit).test(text(e[k])))) return false;
  if (userUnit && !['_SYSTEMD_USER_UNIT', 'USER_UNIT', 'COREDUMP_USER_UNIT', 'OBJECT_SYSTEMD_USER_UNIT'].some((k) => glob(userUnit).test(text(e[k])))) return false;
  if (ident && text(e.SYSLOG_IDENTIFIER) !== ident) return false;
  if (kernel && e._TRANSPORT !== 'kernel') return false;
  if (sinceUs != null && us < sinceUs) return false;
  if (untilUs != null && us > untilUs) return false;
  if (re && !re.test(text(e.MESSAGE))) return false;
  return true;
};

const all = readAll(ids);
const reverse = has('reverse');
const linesArg = opt('lines');
const lines = linesArg == null ? null : Number(linesArg);
let seq = reverse ? all.slice().reverse() : all.slice();
const pos = cursor ?? after;
if (pos != null) {
  const k = key(pos);
  seq = seq.filter((e) => {
    const c = cmpKey(key(e.__CURSOR), k);
    if (after != null) return reverse ? c < 0 : c > 0;
    return reverse ? c <= 0 : c >= 0;
  });
}
let picked = seq.filter(match);
const follow = has('follow');
if (lines != null) {
  if (follow && pos == null) picked = lines ? picked.slice(-lines) : [];
  else if (!reverse && pos == null) picked = picked.slice(-lines);
  else picked = picked.slice(0, lines);
}
for (const e of picked) out(`${JSON.stringify(e)}\n`);
if (!follow) {
  if (re && !picked.length) process.exit(1);
  process.exit(0);
}
// --follow: tail the current boot's files.
const cur = boots.find((x) => x.index === 0)?.boot_id;
const files = nss.map((ns) => path.join(dir, ns, `${cur}.jsonl`));
const sizes = new Map(files.map((f) => [f, fs.existsSync(f) ? fs.statSync(f).size : 0]));
setInterval(() => {
  for (const f of files) {
    const size = fs.existsSync(f) ? fs.statSync(f).size : 0;
    const from = sizes.get(f);
    if (size <= from) continue;
    const buf = Buffer.alloc(size - from);
    const fd = fs.openSync(f, 'r');
    fs.readSync(fd, buf, 0, buf.length, from);
    fs.closeSync(fd);
    const s = buf.toString('utf8');
    const end = s.lastIndexOf('\n');
    if (end < 0) continue;
    sizes.set(f, from + Buffer.byteLength(s.slice(0, end + 1)));
    for (const l of s.slice(0, end).split('\n')) {
      if (!l.trim()) continue;
      const e = JSON.parse(l);
      if ((ids.includes(e._BOOT_ID) || b == null) && match(e)) out(`${JSON.stringify(e)}\n`);
    }
  }
}, 40);
