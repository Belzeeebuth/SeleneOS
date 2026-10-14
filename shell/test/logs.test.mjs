// « Journaux système » (System Logs) tests.
// Part 1 (node): backend helpers of main/ipc/journal.js (query validation, journalctl argument vectors, parsing of
// binary / repeated / missing / huge fields, boots in JSON and text form, journalctl's stderr hints, text lines) and
// the renderer's pure helpers (apps/logs/lib/format.js), fixture determinism, strings and CSS rules.
// Part 2 (Electron, fixture journals through AURORA_JOURNAL_FIXTURE, never this PC's journal): views, filters, search,
// boots, service / program suggestions, details of binary / repeated / missing / huge messages, copy, context,
// live follow (lines appended to the fixture), text and JSON export files, remembered filters, the System Monitor's
// « View log », keyboard, IPC validation; thousands of entries (paging, DOM size, render time, new-entries pill);
// permission infobar, journalctl without PCRE2 / missing, no previous boot; French + dark, screenshots.
// Usage:  cd aurora-os/shell && xvfb-run -a -s "-screen 0 1600x900x24" node test/logs.test.mjs
// Times in the fixtures are shown in local time: the same zone for this process and the shell, whatever the PC's.
process.env.TZ = 'Europe/Paris';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { launchShell, ROOT, OUT } from './lib.mjs';
import { BOOTS, BOOT_TIMES, buildDefault, appendEntry, copyFixture, makeEntry } from './fixtures/logs/fixture-lib.mjs';

const require = createRequire(import.meta.url);
const J = require('../main/ipc/journal.js');
// format.js has no imports: loaded from a data: URL (no "module type" warning for a renderer ES module).
const F = await import(`data:text/javascript;base64,${fs.readFileSync(path.join(ROOT, 'renderer/apps/logs/lib/format.js')).toString('base64')}`);
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'logs', 'default');
const WIN = '.win.app-logs';
const DLG = `${WIN} > .dialog-layer:not(.closing) .dialog`;
const APP = "window.__aurora.wm.byApp('logs')[0]?.logs";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const args = new Set(process.argv.slice(2));

let passed = 0;
const failures = [];
function check(name, actual, expected) {
  const ok = typeof expected === 'function' ? !!expected(actual) : Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++;
  else failures.push(`${name}\n      expected: ${typeof expected === 'function' ? '(predicate)' : JSON.stringify(expected)?.slice(0, 600)}\n      actual:   ${JSON.stringify(actual)?.slice(0, 900)}`);
  return ok;
}
async function section(name, fn) {
  const t0 = Date.now();
  const before = failures.length;
  try {
    await fn();
    console.log(`  ${failures.length === before ? '✓' : '✗'} ${name} (${Date.now() - t0} ms)`);
  } catch (err) {
    failures.push(`${name}: threw ${err?.stack || err}`);
    console.log(`  ✗ ${name}: ${err?.message || err}`);
  }
}
async function until(page, expr, timeout = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await page.evaluate(expr).catch(() => false)) return true;
    await sleep(50);
  }
  return false;
}
function finish() {
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exit(1);
  }
  process.exit(0);
}

// ---------------------------------------------------------------- fixture data (expectations)
const readJsonl = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)) : []);
const key = (r) => J.cursorKey(r.__CURSOR);
const newestFirst = (list) => list.sort((a, b) => key(b).t - key(a).t || key(b).i - key(a).i);
function fx(dir, { boots = [BOOTS.current], ns = ['system', 'user'], filter = () => true } = {}) {
  const out = [];
  for (const b of boots) for (const n of ns) out.push(...readJsonl(path.join(dir, n, `${b}.jsonl`)));
  return newestFirst(out.filter(filter));
}
const ALL_BOOTS = [BOOTS.older, BOOTS.previous, BOOTS.current];
const prio = (r) => (r.PRIORITY == null ? null : Number(r.PRIORITY));
const msgOf = (r) => J.parseRaw(r).full;
const curs = (list) => list.map((r) => r.__CURSOR);

function tmpFixture(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `aurora-journal-${name}-`));
  copyFixture(FIXTURE, dir);
  return dir;
}

// ================================================================ Part 1: node
await section('backend: query validation', async () => {
  const v = J.validateQuery({});
  check('defaults', [v.boot, v.priority, v.limit, v.kernel, v.user, v.grep], ['current', 7, 500, false, false, '']);
  check('limit capped at 5000', J.validateQuery({ limit: 99999 }).limit, 5000);
  check('a boot id is accepted', J.validateQuery({ boot: BOOTS.previous }).boot, BOOTS.previous);
  check('ISO dates -> ms', [J.validateQuery({ since: '2026-10-14T07:17:00Z' }).since, J.validateQuery({ until: '2026-10-14T09:17:00+02:00' }).until], [Date.UTC(2026, 9, 14, 7, 17), Date.UTC(2026, 9, 14, 7, 17)]);
  check('unit with an escape and a glob', J.validateQuery({ unit: 'systemd-fsck@dev-disk-by\\x2duuid-1.service' }).unit, 'systemd-fsck@dev-disk-by\\x2duuid-1.service');
  const bad = [
    { boot: '-1; rm -rf /' },
    { boot: 'ABC' },
    { boot: -1 },
    { priority: 8 },
    { priority: -1 },
    { priority: '3' },
    { priority: 2.5 },
    { unit: '--output=cat' },
    { unit: '-x.service' },
    { unit: 'a b.service' },
    { unit: 'a/b.service' },
    { identifier: '-t' },
    { identifier: 'bad\nname' },
    { identifier: ' padded' },
    { since: 'yesterday' },
    { since: '1970-01-01' },
    { until: 'now' },
    { since: '2026-10-14T10:00:00Z', until: '2026-10-14T09:00:00Z' },
    { grep: 'x'.repeat(201) },
    { grep: 'a\nb' },
    { limit: 0 },
    { limit: 'lots' },
    { before: 'not a cursor' },
    { after: 's=1;i=2 --boot' },
    { before: 's=aa;i=1', after: 's=aa;i=2' },
    { tag: 'x'.repeat(65) },
    'string',
    [1, 2],
  ];
  const codes = bad.map((q) => {
    try {
      J.validateQuery(q);
      return 'accepted';
    } catch (e) {
      return e.code;
    }
  });
  check('every bad query -> EINVAL', codes, bad.map(() => 'EINVAL'));
});

await section('backend: journalctl argument vectors', async () => {
  const base = ['--output=json', '--all', '--no-pager'];
  check('errors of this boot, first page', J.buildArgs(J.validateQuery({ boot: 'current', priority: 3 }), 'page', { lines: 501 }), [...base, '--boot=0', '--priority=3', '--reverse', '--lines=501']);
  check('previous boot', J.buildArgs(J.validateQuery({ boot: 'previous' }), 'page', { lines: 11 }), [...base, '--boot=-1', '--reverse', '--lines=11']);
  check('every boot: no --boot', J.buildArgs(J.validateQuery({ boot: 'all' }), 'page', { lines: 11 }), [...base, '--reverse', '--lines=11']);
  check('a boot id', J.buildArgs(J.validateQuery({ boot: BOOTS.older }), 'page', {}), [...base, `--boot=${BOOTS.older}`, '--reverse']);
  check('kernel: a _TRANSPORT match after the options (not -k, which forces the current boot)', J.buildArgs(J.validateQuery({ boot: 'all', kernel: true }), 'page', { lines: 2 }), [...base, '--reverse', '--lines=2', '_TRANSPORT=kernel']);
  check('user journal + unit -> --user-unit', J.buildArgs(J.validateQuery({ user: true, unit: 'pipewire.service' }), 'page', {}), [...base, '--user', '--boot=0', '--user-unit=pipewire.service', '--reverse']);
  check('system unit, identifier', J.buildArgs(J.validateQuery({ unit: 'ssh.service', identifier: 'sshd' }), 'page', {}), [...base, '--boot=0', '--unit=ssh.service', '--identifier=sshd', '--reverse']);
  check('since / until in epoch seconds', J.buildArgs(J.validateQuery({ since: '2026-10-14T07:17:00.500Z', until: '2026-10-14T07:18:00.200Z' }), 'page', {}), [...base, '--boot=0', `--since=@${Date.UTC(2026, 9, 14, 7, 17) / 1000}`, `--until=@${Date.UTC(2026, 9, 14, 7, 18) / 1000 + 1}`, '--reverse']);
  check('search: escaped, lower case (smart case = ignore case)', J.buildArgs(J.validateQuery({ grep: 'Timeout (*) on [12]?' }), 'page', {}).find((a) => a.startsWith('--grep=')), '--grep=timeout \\(\\*\\) on \\[12\\]\\?');
  check('search done in JS: no --grep', J.buildArgs(J.validateQuery({ grep: 'x' }), 'page', { grep: false }).some((a) => a.startsWith('--grep')), false);
  const c = 's=d280216c34134558a14fe3da8ad7b90d;i=3ea10;b=5c0c9720b7fa482f9176d063ee70adf1;m=d5719e50;t=65dc88de16132;x=866cd4c1cf423438';
  check('older page: --reverse --after-cursor', J.buildArgs(J.validateQuery({ before: c }), 'page', { lines: 3 }).slice(-3), ['--reverse', `--after-cursor=${c}`, '--lines=3']);
  check('newer page: --after-cursor without --reverse', J.buildArgs(J.validateQuery({ after: c }), 'page', { lines: 3 }).slice(-2), [`--after-cursor=${c}`, '--lines=3']);
  check('follow from the end: -f -n 0, no --reverse, no --until', J.buildArgs(J.validateQuery({ priority: 4, until: '2026-10-14T07:18:00Z' }), 'follow'), [...base, '--boot=0', '--priority=4', '--follow', '--lines=0']);
  check('follow after a cursor', J.buildArgs(J.validateQuery({ after: c }), 'follow').slice(-2), ['--follow', `--after-cursor=${c}`]);
  const since = '2026-10-14T07:17:00Z';
  check('no --since with a cursor (journalctl refuses both): the date is checked in JS', [J.buildArgs(J.validateQuery({ since, before: c }), 'page', {}).some((x) => x.startsWith('--since')), J.buildArgs(J.validateQuery({ since, after: c }), 'follow').some((x) => x.startsWith('--since')), J.buildArgs(J.validateQuery({ since }), 'page', {}).some((x) => x.startsWith('--since'))], [false, false, true]);
  check('every value is one --option=value argument', J.buildArgs(J.validateQuery({ unit: 'a.service', identifier: 'b c', grep: 'd e' }), 'page', {}).every((a) => a.startsWith('--') || a === '_TRANSPORT=kernel'), true);
  check('escapePcre', J.escapePcre('a.b*c?(d)[e]{f}|g^h$i\\j/k+l-m#'), 'a\\.b\\*c\\?\\(d\\)\\[e\\]\\{f\\}\\|g\\^h\\$i\\\\j\\/k\\+l\\-m\\#');
});

await section('backend: parsing (binary, repeated, missing, huge, colour codes)', async () => {
  const bytes = [...Buffer.from('\x1b[1;31mred\x1b[0m caf\xc3\xa9 \xff\xfe end', 'latin1')];
  const d = J.decodeValue(bytes);
  check('byte array -> UTF-8 text with U+FFFD for bad bytes', [d.binary, d.text], [true, '\x1b[1;31mred\x1b[0m café \uFFFD\uFFFD end']);
  check('colour codes removed', J.cleanText(d.text), 'red café \uFFFD\uFFFD end');
  check('other control characters -> U+FFFD, CR LF and lone CR -> LF, tabs kept', J.cleanText('a\x00b\x07c\r\nd\te\rf'), 'a\uFFFDb\uFFFDc\nd\te\nf');
  check('OSC title sequence removed', J.cleanText('x\x1b]0;title\x07y'), 'xy');
  const multi = J.decodeValue(['one', 'two']);
  check('repeated field -> joined lines, multi count', [multi.text, multi.multi], ['one\ntwo', 2]);
  const mixed = J.decodeValue(['ok', [104, 105, 0xff]]);
  check('repeated field mixing text and bytes', [mixed.text, mixed.binary, mixed.multi], ['ok\nhi\uFFFD', true, 2]);
  check('null -> missing', J.decodeValue(null), { text: '', missing: true });
  check('empty byte array -> empty text', J.decodeValue([]).text, '');
  const raw = { __CURSOR: 's=1;i=2;b=3;m=4;t=5;x=6', __REALTIME_TIMESTAMP: '1791962237123456', PRIORITY: '3', _COMM: 'comm', _PID: '42', _TRANSPORT: 'stdout', MESSAGE: bytes, _SYSTEMD_UNIT: 'x.service', _BOOT_ID: BOOTS.current, _HOSTNAME: 'selene' };
  const p = J.parseRaw(raw).entry;
  check('entry fields', [p.ts, p.us, p.prio, p.source, p.pid, p.unit, p.binary, p.msg], [1791962237123, '1791962237123456', 3, 'comm', '42', 'x.service', true, 'red café \uFFFD\uFFFD end']);
  check('source fallback: SYSLOG_IDENTIFIER > _COMM > _EXE > kernel', [J.parseRaw({ SYSLOG_IDENTIFIER: 'id', _COMM: 'c' }).entry.source, J.parseRaw({ _EXE: '/usr/bin/prog' }).entry.source, J.parseRaw({ _TRANSPORT: 'kernel' }).entry.source], ['id', 'prog', 'kernel']);
  check('bad PRIORITY -> null', [J.parseRaw({ PRIORITY: '9' }).entry.prio, J.parseRaw({ PRIORITY: 'x' }).entry.prio, J.parseRaw({}).entry.prio], [null, null, null]);
  check('user unit wins over user@1000.service', J.parseRaw({ _SYSTEMD_UNIT: 'user@1000.service', _SYSTEMD_USER_UNIT: 'pipewire.service' }).entry.unit, 'pipewire.service');
  const huge = 'é'.repeat(70000);
  const h = J.parseRaw({ MESSAGE: huge }).entry;
  check('huge message cut at 4 KiB in lists, size in bytes', [h.msg.length, h.truncated, h.size], [J.LIST_MSG_MAX, true, 140000]);
  const hd = J.parseRaw({ MESSAGE: huge }, J.DETAIL_MAX).entry;
  check('64 KiB in details', [hd.msg.length, hd.truncated], [J.DETAIL_MAX, true]);
  check('a surrogate pair is never cut in half', J.parseRaw({ MESSAGE: `${'a'.repeat(4095)}😀b` }).entry.msg.length, 4095);
  check('missing message flagged', J.parseRaw({ MESSAGE: null }).entry.missing, true);
  const fields = J.entryFields({ __CURSOR: 'c', _PID: '1', MESSAGE: ['a', 'b'], ZED: [0x41, 0xff], 'bad-name': 'x', CODE_LINE: '3' });
  check('fields: user fields, then trusted (_), then address (__); bad names skipped', fields.map((f) => f.name), ['CODE_LINE', 'MESSAGE', 'MESSAGE', 'ZED', '_PID', '__CURSOR']);
  check('fields: binary flag and repeated values', [fields.find((f) => f.name === 'ZED').binary, fields.filter((f) => f.name === 'MESSAGE').map((f) => f.value)], [true, ['a', 'b']]);
  check('fields: long value cut', J.entryFields({ BIG: 'x'.repeat(100) }, 10)[0], { name: 'BIG', value: 'xxxxxxxxxx', truncated: true, size: 100 });
});

await section('backend: boots, stderr hints, text lines', async () => {
  const json = '[{"index":-1,"boot_id":"b7e4d2c19a0f4e6b8c3d5a7f9e1b2c4d","first_entry":1791907807000000,"last_entry":1791924442001000},{"index":0,"boot_id":"c0ffee5e1e7e4a2b9d8c7b6a5f4e3d2c","first_entry":1791962237000000,"last_entry":1791965083516000},{"index":1,"boot_id":"nope"}]';
  check('JSON boots, newest first, ms', J.parseBootsJson(json), [
    { index: 0, id: BOOTS.current, first: 1791962237000, last: 1791965083516 },
    { index: -1, id: BOOTS.previous, first: 1791907807000, last: 1791924442001 },
  ]);
  check('not JSON -> null (text fallback)', J.parseBootsJson(' -1 b7e4… Mon'), null);
  const text = 'IDX BOOT ID                          FIRST ENTRY                 LAST ENTRY\n -1 b7e4d2c19a0f4e6b8c3d5a7f9e1b2c4d Tue 2026-10-13 16:10:07 UTC Tue 2026-10-13 20:47:31 UTC\n  0 c0ffee5e1e7e4a2b9d8c7b6a5f4e3d2c Wed 2026-10-14 07:17:17 UTC—Wed 2026-10-14 08:05:42 UTC\n';
  check('text boots (TZ=UTC)', J.parseBootsText(text), [
    { index: 0, id: BOOTS.current, first: Date.UTC(2026, 9, 14, 7, 17, 17), last: Date.UTC(2026, 9, 14, 8, 5, 42) },
    { index: -1, id: BOOTS.previous, first: Date.UTC(2026, 9, 13, 16, 10, 7), last: Date.UTC(2026, 9, 13, 20, 47, 31) },
  ]);
  const hint = "Hint: You are currently not seeing messages from other users and the system.\n      Users in groups 'adm', 'systemd-journal' can see all messages.\n      Pass -q to turn off this notice.\n";
  check('permission hint -> limited', J.stderrFlags(hint).limited, true);
  check('no journal readable -> limited + noFiles', [J.stderrFlags('No journal files were opened due to insufficient permissions.').limited, J.stderrFlags('No journal files were opened due to insufficient permissions.').noFiles], [true, true]);
  check('no PCRE2', [J.stderrFlags('PCRE2 support is not installed.').noPcre, J.stderrFlags('Compiled without pattern matching support').noPcre, J.stderrFlags(hint).noPcre], [true, true, false]);
  check('no such boot', [J.stderrFlags('No journal boot entry found for the specified boot (-1).').noBoot, J.stderrFlags('Data from the specified boot (-1) is not available: No such boot ID in journal').noBoot], [true, true]);
  check('errorLine skips the hint', [J.errorLine(hint), J.errorLine(`${hint}Failed to open files: Permission denied\n`)], ['', 'Failed to open files: Permission denied']);
  const e = { ts: Date.UTC(2026, 9, 14, 7, 17, 20, 5), prio: 3, source: 'bluetoothd', pid: '811', msg: 'line one\nline two' };
  const line = J.entryLine(e);
  check('text line: ISO local time with offset, level, source[pid]', line.split('\n')[0], (l) => /^2026-10-14T\d\d:17:20\.005[+-]\d\d:\d\d err {5}bluetoothd\[811\]: line one$/.test(l));
  check('text line: continuation indented under the message', line.split('\n')[1], (l) => l.trim() === 'line two' && l.startsWith(' '.repeat(40)));
  check('renderer copy = export line', F.entryLine(e), line);
  check('cut message marked', J.entryLine({ ...e, truncated: true }).endsWith(' […]'), true);
});

await section('renderer helpers: views, saved filters, query', async () => {
  check('five views', F.PRESET_ORDER, ['errors', 'previous', 'kernel', 'mine', 'all']);
  check('default = errors of this boot', [F.presetOf(F.DEFAULT_STATE), F.sanitizeState(null).priority, F.sanitizeState(null).boot], ['errors', 3, 'current']);
  check('presetOf each view', F.PRESET_ORDER.map((id) => F.presetOf(F.PRESETS[id])), F.PRESET_ORDER);
  check('custom filters -> no view', F.presetOf({ ...F.PRESETS.errors, search: 'usb' }), null);
  const bad = F.sanitizeState({ boot: '../x', priority: 12, period: 'forever', scope: 'root', source: { kind: 'unit', value: '-x' }, search: 'a\nb', extra: 1 });
  check('saved filters sanitized', [bad.boot, bad.priority, bad.period, bad.scope, bad.source, bad.search, 'extra' in bad], ['current', 3, 'all', 'all', null, 'a b', false]);
  check('custom period without dates -> any time', F.sanitizeState({ period: 'custom' }).period, 'all');
  check('custom period reversed -> any time', F.sanitizeState({ period: 'custom', since: '2026-10-14T10:00:00.000Z', until: '2026-10-14T09:00:00.000Z' }).period, 'all');
  const now = Date.UTC(2026, 9, 14, 10);
  check('toQuery: errors', F.toQuery(F.PRESETS.errors, now), { boot: 'current', priority: 3 });
  check('toQuery: kernel / mine', [F.toQuery(F.PRESETS.kernel).kernel, F.toQuery(F.PRESETS.mine).user], [true, true]);
  check('toQuery: source, search, last hour', F.toQuery({ ...F.PRESETS.all, period: '1h', source: { kind: 'unit', value: 'cron.service' }, search: '  rfkill ' }, now), { boot: 'all', priority: 7, unit: 'cron.service', since: new Date(now - 3600e3).toISOString(), grep: 'rfkill' });
  check('toQuery: program', F.toQuery({ ...F.PRESETS.all, source: { kind: 'ident', value: 'CRON' } }).identifier, 'CRON');
  check('follow only for the running boot', [F.canFollow(F.PRESETS.errors), F.canFollow(F.PRESETS.all), F.canFollow(F.PRESETS.previous), F.canFollow({ ...F.PRESETS.all, boot: BOOTS.current }, BOOTS.current), F.canFollow({ ...F.PRESETS.all, boot: BOOTS.older }, BOOTS.current), F.canFollow({ ...F.PRESETS.all, period: 'custom', until: '2020-01-01T00:00:00.000Z' })], [true, true, false, true, false, false]);
  check('guessSource', [F.guessSource('ssh.service'), F.guessSource('CRON', { units: [], identifiers: ['CRON'] }), F.guessSource('firefox'), F.guessSource('  '), F.guessSource('-x')], [{ kind: 'unit', value: 'ssh.service' }, { kind: 'ident', value: 'CRON' }, { kind: 'ident', value: 'firefox' }, null, null]);
  check('priority tones', [0, 1, 2, 3, 4, 5, 6, 7, null].map(F.prioTone), ['critical', 'critical', 'critical', 'error', 'warning', 'notice', 'info', 'debug', 'none']);
  check('backend and renderer agree on the level names', F.LEVEL_KEYS, J.LEVELS);
});

await section('fixture: deterministic, committed copy up to date', async () => {
  const b = buildDefault();
  const files = Object.fromEntries(Object.entries(b.files).map(([k, v]) => [k, v.map((e) => JSON.stringify(e)).join('\n') + '\n']));
  const same = Object.entries(files).every(([k, v]) => fs.readFileSync(path.join(FIXTURE, k), 'utf8') === v);
  check('test/fixtures/logs/default = node test/fixtures/logs/fixture-lib.mjs output', same, true);
  check('boots.json', JSON.parse(fs.readFileSync(path.join(FIXTURE, 'boots.json'), 'utf8')), b.boots);
  const cur = fx(FIXTURE, { boots: ALL_BOOTS });
  check('cursors unique', new Set(cur.map((r) => r.__CURSOR)).size, cur.length);
  check('fixture has the special entries', [cur.some((r) => Array.isArray(r.MESSAGE) && typeof r.MESSAGE[0] === 'number'), cur.some((r) => Array.isArray(r.MESSAGE) && typeof r.MESSAGE[0] === 'string'), cur.some((r) => r.MESSAGE === null), cur.some((r) => typeof r.MESSAGE === 'string' && r.MESSAGE.length > 70000)], [true, true, true, true]);
});

await section('strings and styles', async () => {
  const dict = JSON.parse(fs.readFileSync(path.join(ROOT, 'renderer/apps/logs/i18n.json'), 'utf8'));
  const flat = (o, p = '', out = new Map()) => {
    for (const [k, v] of Object.entries(o)) typeof v === 'object' ? flat(v, `${p}${k}.`, out) : out.set(`${p}${k}`, v);
    return out;
  };
  const en = flat(dict.en);
  const fr = flat(dict.fr);
  check('every EN string has a FR translation', [...en.keys()].filter((k) => !fr.has(k)), []);
  check('every FR string exists in EN', [...fr.keys()].filter((k) => !en.has(k)), []);
  check('no empty strings', [...en.values(), ...fr.values()].every((v) => String(v).length > 0), true);
  const src = ['main.js', 'lib/app.js', 'lib/list.js', 'lib/detail.js', 'lib/source.js', 'lib/format.js'].map((f) => fs.readFileSync(path.join(ROOT, 'renderer/apps/logs', f), 'utf8')).join('\n');
  const has = (k) => en.has(k) || en.has(`${k}_one`) || en.has(`${k}_other`);
  const used = [...src.matchAll(/\bt\(\s*'([a-zA-Z0-9_.]+)'/g)].map((x) => x[1]).filter((k) => !k.startsWith('common.'));
  check('every t() key used exists', [...new Set(used)].filter((k) => !has(k)), []);
  const dyn = [...[0, 1, 2, 3, 4, 5, 6, 7].flatMap((p) => [`prio.${p}`, `level.${p}`]), ...F.PRESET_ORDER.flatMap((id) => [`preset.${id}`, `presetTip.${id}`]), ...F.PERIODS.map((p) => `period.${p}`), ...F.SCOPES.map((s) => `scope.${s}`)];
  check('keys built at run time exist', dyn.filter((k) => !has(k)), []);
  check('French level names', [0, 1, 2, 3, 4, 5, 6, 7].map((p) => fr.get(`prio.${p}`)), ['Urgence', 'Alerte', 'Critique', 'Erreur', 'Avertissement', 'Notice', 'Information', 'Débogage']);
  const css = fs.readFileSync(path.join(ROOT, 'renderer/apps/logs/style.css'), 'utf8');
  check('CSS: no hex colours', css.match(/#[0-9a-fA-F]{3,8}\b/g), null);
  check('CSS: every rule scoped under .app-logs (or the animations-off root selector)', css.replace(/\/\*[\s\S]*?\*\//g, '').match(/(^|})\s*([^@\s{}][^{}]*)\{/g).map((m) => m.replace(/^}?\s*/, '').replace(/\{$/, '').trim()).filter((sel) => !/^(from|to|\d+%)$/.test(sel) && sel.split(',').some((x) => !/\.app-logs/.test(x))), []);
  check('CSS: animations off respected', /:root\[data-animations="off"\] \.app-logs \.lg-row\.fresh/.test(css), true);
  const icons = JSON.parse(fs.readFileSync(path.join(ROOT, 'renderer/assets/icons/phosphor.json'), 'utf8'));
  const names = new Set([...Object.keys(icons.glyphs), ...Object.keys(icons.aliases)]);
  const usedIcons = [...new Set([...src.matchAll(/icon\('([a-z0-9-]+)'/g)].map((m) => m[1]).concat(F.PRIO_ICONS, ['circle', 'check-circle', 'clock-counter-clockwise', 'magnifying-glass', 'warning', 'clock']))];
  check('every icon name exists in phosphor.json', usedIcons.filter((n) => !names.has(n)), []);
});

await section('real mode: journalctl spawned and streamed (a fake journalctl reading the fixture)', async () => {
  // main/ipc/journal.js with DEV off runs `journalctl`: a fake one first in PATH (test/fixtures/logs/fake-journalctl.mjs,
  // the behaviour checked against journalctl 262), never this PC's journal.
  const { execFileSync } = await import('node:child_process');
  const fdir = tmpFixture('real');
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-fakebin-'));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-realout-'));
  const log = path.join(out, 'argv.log');
  fs.writeFileSync(path.join(bin, 'journalctl'), `#!/bin/sh\nexec "${process.execPath}" "${path.join(ROOT, 'test/fixtures/logs/fake-journalctl.mjs')}" "$@"\n`, { mode: 0o755 });
  const harness = (scenario, mode = '') => {
    fs.writeFileSync(log, '');
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_JOURNAL_DIR: fdir, FAKE_JOURNAL_MODE: mode, FAKE_JOURNAL_LOG: log, HARNESS_OUT: out };
    return JSON.parse(execFileSync(process.execPath, [path.join(ROOT, 'test/fixtures/logs/real-harness.cjs'), scenario], { env, encoding: 'utf8', timeout: 60000 }));
  };
  const argv = () => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const r = harness('basic');
  check('real: no crash', r.crashed, undefined);
  check('real: boots from --list-boots --output=json', [r.boots.boots.map((b) => b.id), r.boots.mock, r.boots.limited], [[BOOTS.current, BOOTS.previous, BOOTS.older], false, false]);
  const errs = fx(fdir, { filter: (x) => prio(x) != null && prio(x) <= 3 });
  check('real: first page (--reverse --lines=limit+1), more', [r.errors.cursors, r.errors.more, r.errors.limited, r.errors.mock], [curs(errs).slice(0, 5), true, false, false]);
  check('real: older page (--reverse --after-cursor)', r.older, curs(errs).slice(5, 10));
  check('real: newer page (--after-cursor), newest first', r.newer, curs(errs).slice(2, 4));
  const allF = fx(fdir, { boots: ALL_BOOTS });
  check('real: kernel only (_TRANSPORT=kernel)', r.kernel, curs(allF.filter((x) => x._TRANSPORT === 'kernel')));
  check('real: user journal + --user-unit', r.userUnit, curs(fx(fdir, { boots: ALL_BOOTS, ns: ['user'], filter: (x) => x._SYSTEMD_USER_UNIT === 'pipewire.service' || x.USER_UNIT === 'pipewire.service' })));
  check('real: --identifier', r.ident, curs(allF.filter((x) => x.SYSLOG_IDENTIFIER === 'CRON')));
  const inRange = allF.filter((x) => {
    const ms = Number(BigInt(x.__REALTIME_TIMESTAMP) / 1000n);
    return ms >= Date.UTC(2026, 9, 14, 7, 17) && ms <= Date.UTC(2026, 9, 14, 7, 18, 0, 500);
  });
  check('real: since / until exact to the millisecond', r.range, curs(inRange));
  check('real: paging a date range (no --since with a cursor)', r.rangePaged, curs(inRange).slice(0, 10));
  check('real: --grep literal text', r.grep, ['pcieport 0000:00:1c.0: [12] Timeout (*) on link (a+b)?']);
  check('real: --grep ignores case', r.grepCase, curs(allF.filter((x) => msgOf(x).toLowerCase().includes('rfkill'))));
  check('real: --grep without match (exit status 1) = no entries, not an error', [r.grepNone.ok, r.grepNone.v?.entries.length], [true, 0]);
  check('real: unknown boot -> ENOBOOT', r.noBoot.code, 'ENOBOOT');
  check('real: binary message decoded', [r.colord.binary, r.colord.msg], [true, 'colord-sane: scan failed on device �� (café scanner)']);
  check('real: one entry (--cursor --lines=1), every field', [r.entry.ok, r.entry.v?.fields.find((f) => f.name === '_CMDLINE')?.binary], [true, true]);
  check('real: unknown cursor -> ENOENT', r.entryUnknown.code, 'ENOENT');
  const ci = allF.findIndex((x) => x.__CURSOR === r.colord.cursor);
  check('real: context (--cursor forward + --reverse --after-cursor)', r.context.v?.entries.map((e) => e.cursor), curs(allF.slice(ci - 2, ci + 4)));
  check('real: sources (--field)', [r.sources.units.includes('NetworkManager.service'), r.sources.identifiers.includes('CRON')], [true, true]);
  check('real: text export', [r.exportText.v?.count, fs.readFileSync(path.join(out, 'real.txt'), 'utf8').split('\n')[0]], [errs.length, `-- Boot ${BOOTS.current} --`]);
  check('real: JSON export', [r.exportJson.v?.count, JSON.parse(fs.readFileSync(path.join(out, 'real.json'), 'utf8')).length], [allF.length, allF.length]);
  const calls = argv();
  check('real: errors page argument vector', calls[1], ['--output=json', '--all', '--no-pager', '--boot=0', '--priority=3', '--reverse', '--lines=6']);
  check('real: every argument is an --option=value or the kernel match', calls.every((a) => a.every((x) => x.startsWith('--') || x === '_TRANSPORT=kernel')), true);
  check('real: never --since together with a cursor', calls.some((a) => a.some((x) => x.startsWith('--since')) && a.some((x) => /^--(after-)?cursor=/.test(x))), false);
  const lim = harness('limited', 'limited');
  check('real: permission hint -> limited, own entries only', [lim.boots, lim.errors.limited, lim.errors.cursors, lim.user.limited], [true, true, curs(fx(fdir, { ns: ['user'], filter: (x) => prio(x) != null && prio(x) <= 3 })), false]);
  const np = harness('nopcre', 'nopcre');
  check('real: no PCRE2 -> searched here', [np.a.fallback, np.a.cursors, np.b.fallback, np.b.msgs.length], [true, curs(allF.filter((x) => msgOf(x).toLowerCase().includes('rfkill'))), true, 1]);
  check('real: no PCRE2 is remembered (no second --grep)', argv().filter((a) => a.some((x) => x.startsWith('--grep'))).length, 1);
  const ob = harness('oldboots', 'oldboots');
  check('real: old journalctl, boots from the text table (to the second)', ob.boots.map((b) => [b.index, b.id, Math.floor(b.first / 1000), Math.floor(b.last / 1000)]), r.boots.boots.map((b) => [b.index, b.id, Math.floor(b.first / 1000), Math.floor(b.last / 1000)]));
  const f = harness('follow');
  check('real: follow streams the matching new entry only', f.events.filter((e) => e.c === 'journal:entries' && e.p.id === f.id).flatMap((e) => e.p.entries.map((x) => x.msg)), ['real-mode follow: error']);
  check('real: follow stops (unfollow, then followEnd)', [f.running, f.unfollow.ok, f.after, f.events.some((e) => e.c === 'journal:followEnd' && e.p.id === f.id && e.p.error === null)], [1, true, 0, true]);
  const errs2 = fx(fdir, { filter: (x) => prio(x) != null && prio(x) <= 3 });
  check('real: follow after a cursor sends what came after it first', f.events.filter((e) => e.c === 'journal:entries' && e.p.id === f.afterId).flatMap((e) => e.p.entries.map((x) => x.cursor)), curs(errs2.slice(0, 2).reverse()));
  check('real: follow refused for another boot', f.previous.code, 'EINVAL');
  check('real: the follow argument vectors', argv().filter((a) => a.includes('--follow')).map((a) => a.slice(3)), [['--boot=0', '--priority=3', '--follow', '--lines=0'], ['--boot=0', '--priority=3', '--follow', `--after-cursor=${errs2[2].__CURSOR}`]]);
  for (const d of [fdir, bin, out]) fs.rmSync(d, { recursive: true, force: true });
});

if (args.has('--node-only')) finish();

// ================================================================ Part 2: Electron, EN light
const dir = tmpFixture('main');
const ENV = { AURORA_JOURNAL_FIXTURE: dir, AURORA_JOURNAL_POLL_MS: '60' };
let s = await launchShell({ open: ['logs'], lang: 'en', theme: 'light', env: ENV });
let page = s.page;
const errors = [];
const watch = (p) => {
  p.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('requestfailed', (r) => errors.push(`request failed: ${r.url()}`));
  p.on('response', (r) => r.status() >= 400 && errors.push(`HTTP ${r.status()} ${r.url()}`));
};
watch(page);

const app = (fn, arg) => page.evaluate(`(${fn})(${APP}, ${JSON.stringify(arg ?? null)})`);
const entries = () => app((a) => a.list.entries.map((e) => e.cursor));
const loaded = () => until(page, `(() => { const a = ${APP}; return !!a && !a.loading && !a.loadingMore; })()`, 10000);
async function reload(action) {
  const before = await app((a) => a.loadSeq);
  await action();
  await until(page, `(() => { const a = ${APP}; return !!a && a.loadSeq > ${before} && !a.loading; })()`, 10000);
}
const rowsDom = () =>
  page.evaluate(`[...document.querySelectorAll('${WIN} .lg-row:not([hidden])')].map((r) => ({ y: r._y, cls: r.className, cells: [...r.querySelectorAll('.lg-td')].map((x) => x.textContent), tones: [...r.querySelectorAll('.lg-td')].map((x) => x.className) })).sort((a, b) => a.y - b.y)`);
const pressed = () => page.evaluate(`[...document.querySelectorAll('${WIN} .lg-preset')].filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.dataset.preset)`);
const preset = (id) => reload(() => page.click(`${WIN} .lg-preset[data-preset="${id}"]`));
const clip = () => page.evaluate(`window.aurora.invoke('clipboard:readText')`);
const invokeRaw = (channel, ...a) => page.evaluate(`(async () => { try { return { ok: true, value: await window.__aurora_api_invoke(${JSON.stringify(channel)}, ...${JSON.stringify(a)}) }; } catch (e) { return { ok: false, code: e.code, message: e.message }; } })()`);
await page.evaluate(`window.__aurora_api_invoke = (c, ...a) => window.aurora.invokeRaw(c, ...a).then((r) => { if (r && r.ok) return r.value; const e = new Error(r?.error?.message); e.code = r?.error?.code; throw e; })`);

await section('launch: errors of this boot', async () => {
  check('window opened', await until(page, `!!document.querySelector('${WIN} .lg-row')`, 20000), true);
  await loaded();
  const want = fx(dir, { filter: (r) => prio(r) != null && prio(r) <= 3 });
  check('default view: « Errors this boot » pressed', await pressed(), ['errors']);
  check('entries = errors of this boot (system + user), newest first', await entries(), curs(want));
  check('status count', await page.textContent(`${WIN} .lg-count`), `${want.length} entries`);
  const dom = await rowsDom();
  check('first row: time, level, source, message', dom[0]?.cells, (c) => /^Oct 14, 0?9:41:17/.test(c[0]) && c[1] === 'Error' && c[2] === 'aurora-shell' && c[3].startsWith('[renderer:files] TypeError'));
  check('level cell coloured (tone-error) with an icon', await page.evaluate(`!!document.querySelector('${WIN} .lg-row .lg-td.c-level.tone-error .lg-ico svg')`), true);
  check('rows tinted for errors', dom.every((r) => /\bp-error\b|\bp-critical\b/.test(r.cls)), true);
  check('window title', await page.textContent(`${WIN} .win-title`), 'System Logs');
  check('details: nothing selected', await page.textContent(`${WIN} .lg-detail`), (t) => t.includes('Select an entry to see its details.'));
  check('boot filter: this boot, with its start time', await page.evaluate(`document.querySelector('${WIN} .lg-boot').selectedOptions[0].textContent`), (t) => /^This boot \(since .+\)$/.test(t));
  check('older boots listed', await page.evaluate(`[...document.querySelectorAll('${WIN} .lg-boot optgroup option')].map((o) => o.value)`), [BOOTS.older]);
  check('level filter options', await page.evaluate(`[...document.querySelectorAll('${WIN} .lg-level option')].map((o) => o.textContent)`), ['All levels', 'Info or more serious', 'Notice or more serious', 'Warning or more serious', 'Error or more serious', 'Critical or more serious', 'Alert or more serious', 'Emergencies only']);
  check('no "undefined" / "null" text (outside the journal messages)', await page.evaluate(`[...document.querySelectorAll('${WIN} .lg-bar, ${WIN} .lg-filters, ${WIN} .lg-status, ${WIN} .lg-detail, ${WIN} .lg-head, ${WIN} .c-time, ${WIN} .c-level, ${WIN} .c-source')].some((e) => /\\b(undefined|null|NaN)\\b/.test(e.innerText))`), false);
  check('list is a grid with a row count', await page.evaluate(`[document.querySelector('${WIN} .lg-list').getAttribute('role'), document.querySelector('${WIN} .lg-list').getAttribute('aria-rowcount')]`), ['grid', String(want.length + 1)]);
});

await section('views: previous boot, kernel, my apps, everything', async () => {
  await preset('previous');
  const prev = fx(dir, { boots: [BOOTS.previous] });
  check('previous boot: every entry, newest first', await entries(), curs(prev));
  check('previous view pressed, boot filter follows', [await pressed(), await page.inputValue(`${WIN} .lg-boot`)], [['previous'], 'previous']);
  const first = await app((a) => a.list.entries.slice(0, 12).map((e) => [e.prio, e.msg]));
  check('the last messages before the freeze come first', first[0][1].startsWith('rcu:'), true);
  check('soft lockup = Emergency', first.find(([, m]) => m.includes('soft lockup'))?.[0], 0);
  const dom = await rowsDom();
  const lock = dom.find((r) => r.cells[3].includes('soft lockup'));
  check('Emergency row: label, critical tone and tint', lock && [lock.cells[1], lock.tones[1].includes('tone-critical'), /\bp-critical\b/.test(lock.cls)], ['Emergency', true, true]);
  check('level column: « Emergency » in bold is not cut', await page.evaluate(`(() => { const td = [...document.querySelectorAll('${WIN} .lg-td.c-level.tone-critical')].find((x) => x.textContent === 'Emergency'); return td && td.scrollWidth <= td.clientWidth; })()`), true);
  check('boot filter: the previous boot range is not cut', await page.evaluate(`(() => { const s = document.querySelector('${WIN} .lg-boot'); return s.selectedOptions[0].textContent; })()`), (t) => /^Previous boot \(Oct 13, .+–.+\)$/.test(t));
  await preset('kernel');
  const k = fx(dir, { filter: (r) => r._TRANSPORT === 'kernel' });
  check('kernel: kernel messages of this boot', await entries(), curs(k));
  check('kernel: journal filter = kernel only', await page.inputValue(`${WIN} .lg-scope`), 'kernel');
  await preset('mine');
  const mine = fx(dir, { ns: ['user'] });
  check('my apps: the user journal of this boot', await entries(), curs(mine));
  check('my apps: journal filter', await page.inputValue(`${WIN} .lg-scope`), 'user');
  await preset('all');
  const all = fx(dir, { boots: ALL_BOOTS });
  check('everything: every boot (one page)', await entries(), curs(all));
  check('everything: nothing more to load', await app((a) => [a.more, a.moreBtn.hidden]), [false, true]);
});

await section('filters: level, boot, journal, period', async () => {
  await reload(() => page.selectOption(`${WIN} .lg-level`, '4'));
  check('level ≤ warning, every boot', await entries(), curs(fx(dir, { boots: ALL_BOOTS, filter: (r) => prio(r) != null && prio(r) <= 4 })));
  check('no view pressed for custom filters', await pressed(), []);
  await reload(() => page.selectOption(`${WIN} .lg-boot`, BOOTS.older));
  check('an older boot', await entries(), curs(fx(dir, { boots: [BOOTS.older], filter: (r) => prio(r) != null && prio(r) <= 4 })));
  await reload(() => page.selectOption(`${WIN} .lg-scope`, 'kernel'));
  check('+ kernel only', await entries(), curs(fx(dir, { boots: [BOOTS.older], filter: (r) => prio(r) != null && prio(r) <= 4 && r._TRANSPORT === 'kernel' })));
  check('follow is off for an older boot', await page.evaluate(`[document.querySelector('${WIN} .lg-follow').disabled, document.querySelector('${WIN} .lg-follow').dataset.tip]`), [true, 'Only possible for the current boot']);
  await preset('all');
  // custom period: 07:17:00 → 07:18:00 UTC of this boot, typed as local times
  const local = (ms) => {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const from = Date.UTC(2026, 9, 14, 7, 17);
  const to = Date.UTC(2026, 9, 14, 7, 18);
  await page.selectOption(`${WIN} .lg-period`, 'custom');
  check('period dialog opens', await until(page, `!!document.querySelector('${DLG} .lg-period-form')`), true);
  await page.fill(`${DLG} .lg-from`, local(from));
  await page.fill(`${DLG} .lg-to`, local(from - 60000));
  await page.click(`${DLG} .dialog-footer .btn.primary`);
  check('end before start: refused with a message', await page.evaluate(`[!!document.querySelector('${DLG} .lg-period-form'), document.querySelector('${DLG} .lg-period-err').textContent]`), [true, 'The end must be after the start.']);
  await page.fill(`${DLG} .lg-to`, local(to));
  await reload(() => page.click(`${DLG} .dialog-footer .btn.primary`));
  check('custom period applied', await entries(), curs(fx(dir, { boots: ALL_BOOTS, filter: (r) => { const ms = Number(BigInt(r.__REALTIME_TIMESTAMP) / 1000n); return ms >= from && ms <= to; } })));
  check('period label shows the range', await page.evaluate(`document.querySelector('${WIN} .lg-period').selectedOptions[0].textContent`), (t) => t.includes('–') && /Oct 14/.test(t));
  await page.selectOption(`${WIN} .lg-period`, 'edit');
  check('« Change the period… » opens the dialog with the current range', await until(page, `document.querySelector('${DLG} .lg-from')?.value === ${JSON.stringify(local(from))}`), true);
  await page.keyboard.press('Escape');
  await sleep(250);
  check('cancelled edit: the custom period stays', [await page.inputValue(`${WIN} .lg-period`), (await entries()).length > 0], ['custom', true]);
  // cancelling the dialog keeps the period
  await page.selectOption(`${WIN} .lg-period`, 'all');
  await loaded();
  await page.selectOption(`${WIN} .lg-period`, 'custom');
  await until(page, `!!document.querySelector('${DLG} .lg-period-form')`);
  await page.keyboard.press('Escape');
  await sleep(250);
  check('cancelled: back to « Any time »', await page.inputValue(`${WIN} .lg-period`), 'all');
  await reload(() => page.selectOption(`${WIN} .lg-period`, '1h'));
  const lastHour = await app((a) => a.list.entries.map((e) => e.ts));
  check('last hour: only entries of the last hour', lastHour.every((ts) => ts >= Date.now() - 3600e3 - 10000), true);
  await preset('all');
});

await section('service or app: suggestions, unit, program', async () => {
  await page.click(`${WIN} .lg-source-input`);
  await page.fill(`${WIN} .lg-source-input`, 'blue');
  check('suggestions open', await until(page, `document.querySelector('${WIN} .lg-source-input').getAttribute('aria-expanded') === 'true' && !!document.querySelector('${WIN} .lg-suggest-item')`), true);
  const sugg = await page.evaluate(`[...document.querySelectorAll('${WIN} .lg-suggest-item')].map((o) => o.dataset.kind + ':' + o.dataset.value)`);
  check('units and programs matching « blue »', sugg, (l) => l.includes('unit:bluetooth.service') && l.includes('ident:bluetoothd') && l.every((x) => x.toLowerCase().includes('blue')));
  check('group headers', await page.evaluate(`[...document.querySelectorAll('${WIN} .lg-suggest .menu-header')].map((x) => x.textContent)`), ['Services', 'Programs']);
  check('combobox: active option announced', await page.evaluate(`document.getElementById(document.querySelector('${WIN} .lg-source-input').getAttribute('aria-activedescendant'))?.dataset.value`), 'bluetooth.service');
  await reload(() => page.keyboard.press('Enter'));
  const unitWant = fx(dir, { boots: ALL_BOOTS, filter: (r) => ['_SYSTEMD_UNIT', 'UNIT'].some((k) => r[k] === 'bluetooth.service') });
  check('unit filter: bluetooth.service, every boot', await entries(), curs(unitWant));
  check('unit filter entries: bluetoothd + systemd', [...new Set(await app((a) => a.list.entries.map((e) => e.source)))].sort(), ['bluetoothd', 'systemd']);
  check('source shown in the box', await page.inputValue(`${WIN} .lg-source-input`), 'bluetooth.service');
  await reload(() => page.press(`${WIN} .lg-source-input`, 'Escape'));
  check('Escape clears the source', [await page.inputValue(`${WIN} .lg-source-input`), (await entries()).length], ['', fx(dir, { boots: ALL_BOOTS }).length]);
  await page.fill(`${WIN} .lg-source-input`, 'cron');
  await until(page, `!!document.querySelector('${WIN} .lg-suggest-item[data-kind=ident][data-value=CRON]')`);
  await reload(() => page.click(`${WIN} .lg-suggest-item[data-kind=ident][data-value=CRON]`));
  check('program filter: CRON', await entries(), curs(fx(dir, { boots: ALL_BOOTS, filter: (r) => r.SYSLOG_IDENTIFIER === 'CRON' })));
  check('state: identifier', await app((a) => a.state.source), { kind: 'ident', value: 'CRON' });
  await reload(() => page.click(`${WIN} .lg-source .lg-field-clear`));
  check('clear button', await app((a) => a.state.source), null);
});

await section('search: text, case, regex characters, empty state', async () => {
  await reload(async () => {
    await page.fill(`${WIN} .lg-search-input`, 'RFKILL');
    await page.press(`${WIN} .lg-search-input`, 'Enter');
  });
  check('ignores case', await entries(), curs(fx(dir, { boots: ALL_BOOTS, filter: (r) => msgOf(r).toLowerCase().includes('rfkill') })));
  check('three boots, three matches', (await entries()).length, 3);
  await reload(async () => {
    await page.fill(`${WIN} .lg-search-input`, '(*) on link (a+b)?');
    await page.press(`${WIN} .lg-search-input`, 'Enter');
  });
  check('regex characters are literal', await app((a) => a.list.entries.map((e) => e.msg)), ['pcieport 0000:00:1c.0: [12] Timeout (*) on link (a+b)?']);
  await reload(async () => {
    await page.fill(`${WIN} .lg-search-input`, 'zzz-nothing-here');
    await page.press(`${WIN} .lg-search-input`, 'Enter');
  });
  check('empty state', await page.evaluate(`[document.querySelector('${WIN} .lg-empty').hidden, document.querySelector('${WIN} .lg-empty-title')?.textContent, document.querySelector('${WIN} .lg-empty .btn')?.textContent, document.querySelector('${WIN} .lg-empty').innerText.includes('null')]`), [false, 'No entries match these filters.', 'Clear the filters', false]);
  await reload(() => page.click(`${WIN} .lg-empty .btn`));
  check('« Clear the filters » keeps the boot, clears the rest', [await page.inputValue(`${WIN} .lg-search-input`), await app((a) => [a.state.boot, a.state.priority, a.state.search]), (await entries()).length], ['', ['all', 7, ''], fx(dir, { boots: ALL_BOOTS }).length]);
  // typing searches after a pause
  await reload(() => page.fill(`${WIN} .lg-search-input`, 'soft lockup'));
  check('search while typing', (await entries()).length, 1);
  await reload(() => page.press(`${WIN} .lg-search-input`, 'Escape'));
  check('Escape clears the search', [await page.inputValue(`${WIN} .lg-search-input`), (await entries()).length], ['', fx(dir, { boots: ALL_BOOTS }).length]);
});

async function searchSelect(text) {
  await reload(async () => {
    await page.fill(`${WIN} .lg-search-input`, text);
    await page.press(`${WIN} .lg-search-input`, 'Enter');
  });
  await page.click(`${WIN} .lg-row:not([hidden])`);
  await until(page, `!!document.querySelector('${WIN} .lg-fields')`);
}

await section('details: binary, repeated, missing and huge messages', async () => {
  await searchSelect('scan failed');
  const e = await app((a) => a.list.selected());
  check('binary message decoded: colour codes gone, bad bytes = U+FFFD, é kept', [e.binary, e.msg], [true, 'colord-sane: scan failed on device \uFFFD\uFFFD (café scanner)']);
  check('row text has no control characters', (await rowsDom())[0].cells[3], (t) => !/[\x00-\x1f]/.test(t) && t.includes('café'));
  const det = await page.textContent(`${WIN} .lg-detail`);
  check('details: level, source[pid] · unit, binary note', [det.includes('Warning'), det.includes('colord-sane[1460] · colord.service'), det.includes('bytes that are not valid text')], [true, true, true]);
  check('details: no "null" / "undefined" outside the fields', await page.evaluate(`[...document.querySelector('${WIN} .lg-detail').childNodes].filter((n) => !n.classList?.contains('lg-fields')).some((n) => /\\b(null|undefined)\\b/.test(n.textContent))`), false);
  check('details: only element children (nothing written as text)', await page.evaluate(`[...document.querySelector('${WIN} .lg-detail').childNodes].every((n) => n.nodeType === 1)`), true);
  const cmd = await page.evaluate(`[...document.querySelectorAll('${WIN} .lg-fields dt')].find((d) => d.textContent === '_CMDLINE')?.nextElementSibling?.textContent`);
  check('binary field decoded, tagged', cmd, '/usr/libexec/colord-sane\uFFFD--verbosebinary');
  check('fields: every field but MESSAGE (shown above)', await page.evaluate(`[...document.querySelectorAll('${WIN} .lg-fields dt')].map((d) => d.textContent)`), (l) => l.includes('PRIORITY') && l.includes('_SYSTEMD_UNIT') && l.includes('__CURSOR') && !l.includes('MESSAGE'));
  await searchSelect('hwmon3');
  const rep = await app((a) => a.list.selected());
  check('repeated MESSAGE: both values', [rep.multi, rep.msg], [2, "sensors: Can't open /sys/class/hwmon/hwmon3/temp1_input\nsensors: retrying with hwmon4"]);
  check('row: first line, « more » marker', await page.evaluate(`[document.querySelector('${WIN} .lg-row:not([hidden]) .c-message').textContent, document.querySelector('${WIN} .lg-row:not([hidden]) .c-message').classList.contains('more')]`), ["sensors: Can't open /sys/class/hwmon/hwmon3/temp1_input", true]);
  check('details: both lines', await page.textContent(`${WIN} .lg-detail-msg`), rep.msg);
  const full = await invokeRaw('journal:entry', rep.cursor);
  check('journal:entry lists the repeated field twice', full.value?.fields.filter((f) => f.name === 'MESSAGE').map((f) => f.value), ["sensors: Can't open /sys/class/hwmon/hwmon3/temp1_input", 'sensors: retrying with hwmon4']);
  await reload(() => app((a) => a.setState({ source: { kind: 'ident', value: 'Xorg' }, search: '' })));
  await page.click(`${WIN} .lg-row:not([hidden])`);
  await until(page, `!!document.querySelector('${WIN} .lg-fields')`);
  check('missing message: row text', (await rowsDom())[0].cells[3], '(message not provided)');
  check('missing message: note', await page.textContent(`${WIN} .lg-detail`), (t) => t.includes('The journal did not provide this message'));
  await reload(() => app((a) => a.setState({ source: null })));
  await searchSelect('Maximum call stack');
  const big = await app((a) => a.list.selected());
  check('huge message: 4 KiB in the list, real size kept', [big.msg.length, big.truncated, big.size > 90000], [4096, true, true]);
  check('huge message: note with its size', await page.textContent(`${WIN} .lg-detail-notes`), (t) => /Long message \(\d+ KB\): only its beginning is shown\./.test(t));
  check('huge message: 64 KiB in the details', await page.evaluate(`document.querySelector('${WIN} .lg-detail-msg').textContent.length`), 65536);
  check('huge message: the details box scrolls (no giant pane)', await page.evaluate(`(() => { const m = document.querySelector('${WIN} .lg-detail-msg'); return m.scrollHeight > m.clientHeight && m.clientHeight < 600; })()`), true);
  await reload(() => page.press(`${WIN} .lg-search-input`, 'Escape'));
});

await section('copy: button, Ctrl+C, context menu', async () => {
  await preset('errors');
  await page.click(`${WIN} .lg-row:not([hidden])`);
  const e0 = await app((a) => a.list.selected());
  await until(page, `!${APP}.copyBtn.disabled`);
  await page.click(`${WIN} .lg-actions [data-act=copy]`);
  await until(page, `document.querySelector('${WIN} .lg-flash').textContent === 'Copied to the clipboard'`, 3000);
  check('toolbar Copy = the text line of the entry', await clip(), F.entryLine(e0));
  await app((a) => a.list.focus());
  await page.keyboard.press('ArrowDown');
  const e1 = await app((a) => a.list.selected());
  check('↓ moved the selection', e1.cursor !== e0.cursor, true);
  await page.keyboard.press('Control+c');
  await sleep(200);
  check('Ctrl+C copies the selected entry', await clip(), F.entryLine(e1));
  await page.click(`${WIN} .lg-row:not([hidden])`, { button: 'right' });
  await page.waitForSelector('body > .menu .menu-item', { timeout: 3000 });
  const items = await page.evaluate(`[...document.querySelectorAll('body > .menu .menu-item')].map((m) => m.textContent.trim())`);
  check('context menu items', items, ['Copy', 'Copy the message', 'Copy the entries shown', 'Show context', 'Only this source', 'Details']);
  await page.locator('body > .menu .menu-item', { hasText: 'Copy the entries shown' }).click();
  await sleep(250);
  const n = (await entries()).length;
  const lines = (await clip()).split('\n').filter((l) => /^\d{4}-\d\d-\d\dT/.test(l));
  check('« Copy the entries shown »: every entry, oldest first', [lines.length, lines[0].includes('ACPI BIOS Error')], [n, true]);
  check('flash message with the count', await page.textContent(`${WIN} .lg-flash`), `${n} entries copied to the clipboard`);
});

await section('details actions: only this source', async () => {
  const rf = await app((a) => a.list.entries.find((e) => e.msg.includes('rfkill')).cursor);
  await app((a, c) => a.list.select(c), rf);
  await until(page, `!!document.querySelector('${WIN} .lg-detail [data-act=only]')`);
  await reload(() => page.click(`${WIN} .lg-detail [data-act=only]`));
  check('« Only this source » filters on the unit', await app((a) => [a.state.source, a.list.entries.every((e) => e.unit === 'bluetooth.service' || e.source === 'systemd')]), [{ kind: 'unit', value: 'bluetooth.service' }, true]);
  await preset('errors');
});

await section('context: entries around one, back to the results', async () => {
  const before = await entries();
  const rf = before[await app((a) => a.list.entries.findIndex((e) => e.msg.includes('rfkill')))];
  await app((a, c) => a.list.select(c), rf);
  await until(page, `!!document.querySelector('${WIN} .lg-detail [data-act=context]')`);
  await page.click(`${WIN} .lg-detail [data-act=context]`);
  check('context banner', await until(page, `!document.querySelector('${WIN} .lg-context').hidden`), true);
  check('banner text', await page.textContent(`${WIN} .lg-context-text`), (t) => t.startsWith('Entries written around') && t.includes('every source'));
  const ctx = await app((a) => ({ n: a.list.entries.length, sel: a.list.sel, anchor: a.list.anchor, prios: [...new Set(a.list.entries.map((e) => e.prio))], i: a.list.index.get(a.list.anchor) }));
  const all = fx(dir, { boots: ALL_BOOTS });
  const ai = all.findIndex((r) => r.__CURSOR === rf);
  check('context = 40 before + the entry + 40 after, whatever their level', [ctx.n, ctx.sel, ctx.anchor, ctx.prios.includes(6)], [Math.min(all.length, ai + 41) - Math.max(0, ai - 40), rf, rf, true]);
  check('context entries are the neighbours in the journal', await entries(), curs(all.slice(Math.max(0, ai - 40), ai + 41)));
  check('anchor row marked and selected', await page.evaluate(`(() => { const r = [...document.querySelectorAll('${WIN} .lg-row.anchor')]; return r.length === 1 && r[0].classList.contains('sel'); })()`), true);
  check('follow and « Show context » disabled meanwhile', await page.evaluate(`[document.querySelector('${WIN} .lg-follow').disabled, document.querySelector('${WIN} .lg-detail [data-act=context]').disabled]`), [true, true]);
  await page.keyboard.press('Escape');
  check('Escape: back to the results', await until(page, `document.querySelector('${WIN} .lg-context').hidden`), true);
  check('results and selection restored', [await entries(), await app((a) => a.list.sel)], [before, rf]);
});

await section('live view: Follow', async () => {
  await preset('errors');
  const n0 = (await entries()).length;
  await page.click(`${WIN} .lg-follow`);
  check('Follow pressed', await until(page, `document.querySelector('${WIN} .lg-follow').getAttribute('aria-pressed') === 'true' && ${APP}.followId != null`), true);
  check('one follow running', (await invokeRaw('journal:follows')).value, 1);
  check('status says live', await page.textContent(`${WIN} .lg-count`), (t) => t.endsWith('· live'));
  const t0 = BOOT_TIMES.current.end + 60000;
  const a1 = appendEntry(dir, { boot: 'current', ms: t0, prio: 3, ident: 'smartd', unit: 'smartd.service', pid: 990, msg: 'Device: /dev/nvme0, Critical Warning (0x04): Reliability' });
  check('a new error appears on top', await until(page, `${APP}.list.entries[0]?.cursor === ${JSON.stringify(a1.__CURSOR)}`, 4000), true);
  check('highlighted as new', await page.evaluate(`document.querySelector('${WIN} .lg-row.fresh') != null`), true);
  appendEntry(dir, { boot: 'current', ms: t0 + 1000, prio: 6, ident: 'smartd', unit: 'smartd.service', pid: 990, msg: 'Device: /dev/nvme0, opened' });
  await sleep(700);
  check('an info message does not match the view', (await entries()).length, n0 + 1);
  const a3 = appendEntry(dir, { boot: 'current', ns: 'user', ms: t0 + 2000, prio: 2, ident: 'aurora-shell', pid: 1850, comm: 'electron', msg: '[robust] shell renderer crashed (crashed), reloading it' });
  check('a user-journal error arrives too', await until(page, `${APP}.list.entries[0]?.cursor === ${JSON.stringify(a3.__CURSOR)}`, 4000), true);
  check('count updated', await page.textContent(`${WIN} .lg-count`), `${n0 + 2} entries · live`);
  await page.click(`${WIN} .lg-follow`);
  check('Follow off: the backend stops', await until(page, `document.querySelector('${WIN} .lg-follow').getAttribute('aria-pressed') === 'false'`), true);
  await sleep(150);
  check('no follow running', (await invokeRaw('journal:follows')).value, 0);
  appendEntry(dir, { boot: 'current', ms: t0 + 3000, prio: 3, ident: 'smartd', unit: 'smartd.service', pid: 990, msg: 'Device: /dev/nvme0, failed to read SMART values' });
  await sleep(600);
  check('nothing arrives while off', (await entries()).length, n0 + 2);
  await reload(() => page.click(`${WIN} .lg-actions [data-act=refresh]`));
  check('Refresh reads it', await entries(), curs(fx(dir, { filter: (r) => prio(r) != null && prio(r) <= 3 })));
  // follow survives a filter change, stops when the window closes
  await page.click(`${WIN} .lg-follow`);
  await until(page, `${APP}.followId != null`);
  await reload(() => page.selectOption(`${WIN} .lg-level`, '4'));
  check('still following after a filter change (restarted)', await until(page, `${APP}.followId != null && ${APP}.following`), true);
  check('still one follow', (await invokeRaw('journal:follows')).value, 1);
  await app((a) => a.ctx.win.close());
  await until(page, `!document.querySelector('${WIN}')`);
  await sleep(200);
  check('closing the window stops the follow', (await invokeRaw('journal:follows')).value, 0);
  check('follow refused for an older boot', (await invokeRaw('journal:follow', { boot: BOOTS.older })).code, 'EINVAL');
});

await section('remembered filters', async () => {
  await page.evaluate(`window.__aurora.registry.launch('logs')`);
  await until(page, `!!${APP}`, 10000);
  await loaded();
  check('filters of the last session restored (level ≤ warning)', [await page.inputValue(`${WIN} .lg-level`), await app((a) => a.state.priority)], ['4', 4]);
  await reload(() => page.selectOption(`${WIN} .lg-scope`, 'kernel'));
  await reload(async () => {
    await page.fill(`${WIN} .lg-search-input`, 'usb');
    await page.press(`${WIN} .lg-search-input`, 'Enter');
  });
  await sleep(500); // saved after 300 ms
  await app((a) => a.ctx.win.close());
  await until(page, `!document.querySelector('${WIN}')`);
  await page.evaluate(`window.__aurora.registry.launch('logs')`);
  await until(page, `!!${APP}`, 10000);
  await loaded();
  check('restored after reopening', [await page.inputValue(`${WIN} .lg-level`), await page.inputValue(`${WIN} .lg-scope`), await page.inputValue(`${WIN} .lg-search-input`)], ['4', 'kernel', 'usb']);
  check('restored filters applied', await entries(), curs(fx(dir, { filter: (r) => prio(r) != null && prio(r) <= 4 && r._TRANSPORT === 'kernel' && msgOf(r).toLowerCase().includes('usb') })));
  const saved = JSON.parse(fs.readFileSync(path.join(s.home, '.config', 'aurora', 'apps', 'logs', 'state.json'), 'utf8'));
  check('saved in the app storage', [saved.scope, saved.search, saved.priority], ['kernel', 'usb', 4]);
});

await section('System Monitor: « View log » of a service', async () => {
  await app((a) => a.ctx.win.close());
  await until(page, `!document.querySelector('${WIN}')`);
  await page.evaluate(`window.__aurora.registry.launch('taskmgr')`);
  await until(page, `!!window.__aurora.wm.byApp('taskmgr')[0]?.taskmgr?.pages?.services`, 15000);
  // Two known services instead of this PC's systemd units (the page never reloads them during the test).
  await page.evaluate(`(() => {
    const T = window.__aurora.wm.byApp('taskmgr')[0].taskmgr;
    const P = T.pages.services;
    P.load = async () => P.render();
    const svc = (unit, description, pid) => ({ unit, name: unit.replace(/\.service$/, ''), description, load: 'loaded', active: 'active', sub: 'running', startup: 'enabled', pid });
    P.data = { mock: false, services: [svc('bluetooth.service', 'Bluetooth service', 811), svc('cron.service', 'Regular background program processing daemon', 905)] };
    T.go('services', { focus: false });
    P.render();
  })()`);
  await sleep(400);
  const row = page.locator('.app-taskmgr .tm-page-services .tm-row', { hasText: 'cron' }).first();
  await row.click({ button: 'right' });
  await page.waitForSelector('body > .menu .menu-item', { timeout: 3000 });
  const items = await page.evaluate(`[...document.querySelectorAll('body > .menu .menu-item')].map((m) => m.textContent.trim())`);
  check('« View log » in the Services menu', items.includes('View log'), true);
  await page.locator('body > .menu .menu-item', { hasText: 'View log' }).click();
  check('System Logs opens', await until(page, `!!${APP} && !${APP}.loading && ${APP}.loadSeq > 0`, 15000), true);
  await loaded();
  check('filtered on cron.service, this boot, every level', await app((a) => [a.state.source, a.state.boot, a.state.priority, a.state.search]), [{ kind: 'unit', value: 'cron.service' }, 'current', 7, '']);
  check('cron.service entries', await entries(), curs(fx(dir, { filter: (r) => ['_SYSTEMD_UNIT', 'UNIT'].some((k) => r[k] === 'cron.service') })));
  // already open: the same window switches to the other unit
  const row2 = page.locator('.app-taskmgr .tm-page-services .tm-row', { hasText: 'bluetooth' }).first();
  await page.evaluate(`window.__aurora.wm.byApp('taskmgr')[0].focus()`);
  await row2.click({ button: 'right' });
  await page.waitForSelector('body > .menu .menu-item', { timeout: 3000 });
  await reload(() => page.locator('body > .menu .menu-item', { hasText: 'View log' }).click());
  check('single window, now bluetooth.service', [await page.evaluate(`window.__aurora.wm.byApp('logs').length`), await app((a) => a.state.source?.value)], [1, 'bluetooth.service']);
  await page.evaluate(`window.__aurora.wm.byApp('taskmgr')[0].close()`);
  await sleep(300);
});

await section('export: text and JSON files', async () => {
  await preset('errors');
  const want = fx(dir, { filter: (r) => prio(r) != null && prio(r) <= 3 });
  await page.click(`${WIN} .lg-export`);
  await page.waitForSelector('body > .menu .menu-item', { timeout: 3000 });
  check('export menu', await page.evaluate(`[...document.querySelectorAll('body > .menu .menu-item')].map((m) => m.textContent.trim())`), ['Text file (.txt)…', 'JSON file (.json)…', 'Copy the entries shown']);
  await page.locator('body > .menu .menu-item', { hasText: 'Text file' }).click();
  check('save picker', await until(page, `!!document.querySelector('${DLG}.fp-dialog .fp-bottom input')`), true);
  check('suggested name', await page.inputValue(`${DLG}.fp-dialog .fp-bottom input`), (v) => /^journal-\d{4}-\d\d-\d\d-\d{4}\.txt$/.test(v));
  const out = path.join(s.home, 'Documents', 'errors.txt');
  await sleep(150);
  await page.fill(`${DLG}.fp-dialog .fp-bottom input`, out);
  await page.keyboard.press('Enter');
  check('text file written', await until(page, `${APP}.lastExport?.path === ${JSON.stringify(out)}`, 8000) && fs.existsSync(out), true);
  const text = fs.readFileSync(out, 'utf8');
  const lines = text.split('\n').filter(Boolean);
  check('starts with the boot', lines[0], `-- Boot ${BOOTS.current} --`);
  const heads = lines.filter((l) => /^\d{4}-\d\d-\d\dT/.test(l));
  check('one line per entry (+ indented continuation lines), oldest first', [heads.length, heads[0].includes('ACPI BIOS Error (bug)'), heads.at(-1).includes(msgOf(want[0]).split('\n')[0].slice(0, 30))], [want.length, true, true]);
  check('continuation lines of a multi-line message are indented', lines.some((l) => /^ {20,}at walk \(app:/.test(l)), true);
  check('line layout', lines.find((l) => l.includes('rfkill')), (l) => /^2026-10-14T\d\d:\d\d:\d\d\.\d{3}[+-]\d\d:\d\d err {5}bluetoothd\[811\]: Failed to set mode: Blocked through rfkill \(0x12\)$/.test(l));
  check('flash: count + file name', await page.textContent(`${WIN} .lg-flash`), `${want.length} entries exported to errors.txt`);
  check('no temporary file left', fs.readdirSync(path.join(s.home, 'Documents')).filter((f) => f.includes('.part-')), []);
  // JSON, every boot
  await preset('all');
  await page.click(`${WIN} .lg-export`);
  await page.waitForSelector('body > .menu .menu-item', { timeout: 3000 });
  await page.locator('body > .menu .menu-item', { hasText: 'JSON file' }).click();
  await until(page, `!!document.querySelector('${DLG}.fp-dialog .fp-bottom input')`);
  const jout = path.join(s.home, 'Documents', 'all.json');
  await sleep(150);
  await page.fill(`${DLG}.fp-dialog .fp-bottom input`, jout);
  await page.keyboard.press('Enter');
  check('JSON file written', await until(page, `${APP}.lastExport?.path === ${JSON.stringify(jout)}`, 8000), true);
  const arr = JSON.parse(fs.readFileSync(jout, 'utf8'));
  const all = fx(dir, { boots: ALL_BOOTS });
  check('JSON: every entry, oldest first, all fields', [arr.length, arr[0].__CURSOR, arr.at(-1).__CURSOR, arr.every((o) => o.__CURSOR && o._BOOT_ID && '__REALTIME_TIMESTAMP' in o)], [all.length, all.at(-1).__CURSOR, all[0].__CURSOR, true]);
  const col = arr.find((o) => String(o.MESSAGE).includes('scan failed'));
  check('JSON: binary message decoded to text', col?.MESSAGE, 'colord-sane: scan failed on device \uFFFD\uFFFD (café scanner)');
  check('JSON: repeated field = array', arr.find((o) => Array.isArray(o.MESSAGE))?.MESSAGE, ["sensors: Can't open /sys/class/hwmon/hwmon3/temp1_input", 'sensors: retrying with hwmon4']);
  const big = arr.find((o) => String(o.MESSAGE).startsWith('[renderer:code]'));
  check('JSON: huge value cut at 64 KiB and marked', [big.MESSAGE.length, big.MESSAGE.endsWith(' […]')], [65536 + 4, true]);
  // backend checks of the path
  check('export: relative path refused', (await invokeRaw('journal:export', { boot: 'current' }, { path: 'x.txt', format: 'text' })).code, 'EINVAL');
  check('export: missing folder', (await invokeRaw('journal:export', { boot: 'current' }, { path: path.join(s.home, 'nope', 'x.txt'), format: 'text' })).code, 'ENOENT');
  check('export: a folder is not a file', (await invokeRaw('journal:export', { boot: 'current' }, { path: path.join(s.home, 'Documents'), format: 'text' })).code, 'EISDIR');
  check('export: unknown format', (await invokeRaw('journal:export', { boot: 'current' }, { path: path.join(s.home, 'x.csv'), format: 'csv' })).code, 'EINVAL');
  check('export: path with ..', (await invokeRaw('journal:export', { boot: 'current' }, { path: `${s.home}/Documents/../x.txt`, format: 'text' })).code, 'EINVAL');
});

await section('keyboard: list, views, search, focus ring', async () => {
  await preset('errors');
  await app((a) => a.list.select(null));
  await app((a) => a.list.focus());
  await page.keyboard.press('ArrowDown');
  const all = await entries();
  check('↓ selects the first entry', await app((a) => a.list.sel), all[0]);
  await page.keyboard.press('ArrowDown');
  check('↓ again: the second', await app((a) => a.list.sel), all[1]);
  await page.keyboard.press('End');
  check('End: the last', await app((a) => a.list.sel), all.at(-1));
  await page.keyboard.press('Home');
  check('Home: the first', await app((a) => a.list.sel), all[0]);
  check('aria-activedescendant on the selected row', await page.evaluate(`(() => { const l = document.querySelector('${WIN} .lg-list'); return document.getElementById(l.getAttribute('aria-activedescendant'))?.getAttribute('aria-selected'); })()`), 'true');
  await page.keyboard.press('Enter');
  check('Enter: focus goes to the message in the details', await until(page, `document.activeElement?.classList.contains('lg-detail-msg')`, 2000), true);
  await page.keyboard.press('Control+f');
  check('Ctrl+F: search box', await page.evaluate(`document.activeElement?.classList.contains('lg-search-input')`), true);
  await page.keyboard.press('Tab');
  check('Tab from the search: the list', await page.evaluate(`document.activeElement?.classList.contains('lg-list')`), true);
  await page.focus(`${WIN} .lg-preset[data-preset=errors]`);
  await page.keyboard.press('ArrowRight');
  check('→ moves between the views', await page.evaluate(`document.activeElement?.dataset.preset`), 'previous');
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  check('focus ring on a view button', await page.evaluate(`getComputedStyle(document.activeElement).outlineStyle`), 'solid');
  const unlabeled = await page.evaluate(`[...document.querySelectorAll('${WIN} .lg-root button, ${WIN} .lg-root select, ${WIN} .lg-root input')].filter((b) => !b.hidden && !(b.getAttribute('aria-label') || b.textContent.trim())).map((b) => b.className)`);
  check('every control has a name', unlabeled, []);
});

await section('backend through IPC: validation and errors', async () => {
  for (const [name, q] of [
    ['boot', { boot: '0; reboot' }],
    ['unit', { unit: '--file=/etc/shadow' }],
    ['identifier', { identifier: '-f' }],
    ['priority', { priority: 9 }],
    ['cursor', { before: '../../etc' }],
    ['date', { since: 'tomorrow' }],
  ]) check(`journal:query rejects a bad ${name}`, (await invokeRaw('journal:query', q)).code, 'EINVAL');
  check('journal:entry rejects a bad cursor', (await invokeRaw('journal:entry', 'x;--all')).code, 'EINVAL');
  check('journal:entry: unknown cursor', (await invokeRaw('journal:entry', 's=1;i=2;b=3;m=4;t=5;x=6')).code, 'ENOENT');
  check('journal:context: unknown cursor', (await invokeRaw('journal:context', 's=1;i=2;b=3;m=4;t=5;x=6', { before: 2, after: 2 })).code, 'ENOENT');
  check('journal:query: unknown boot', (await invokeRaw('journal:query', { boot: 'f'.repeat(32) })).code, 'ENOBOOT');
  const b = (await invokeRaw('journal:boots')).value;
  check('journal:boots', [b.boots.map((x) => x.index), b.boots[0].id, b.mock], [[0, -1, -2], BOOTS.current, true]);
  const src = (await invokeRaw('journal:sources', { user: false })).value;
  check('journal:sources: system units and programs', [src.units.includes('NetworkManager.service'), src.units.includes('pipewire.service'), src.identifiers.includes('kernel')], [true, false, true]);
  const usrc = (await invokeRaw('journal:sources', { user: true })).value;
  check('journal:sources: user units', [usrc.units.includes('pipewire.service'), usrc.units.includes('NetworkManager.service')], [true, false]);
  const p1 = (await invokeRaw('journal:query', { boot: 'all', limit: 100 })).value;
  const p2 = (await invokeRaw('journal:query', { boot: 'all', limit: 100, before: p1.entries.at(-1).cursor })).value;
  const all = fx(dir, { boots: ALL_BOOTS });
  check('paging with cursors (older page)', [p1.more, p2.entries.map((e) => e.cursor)], [true, curs(all.slice(100, 200))]);
  const p0 = (await invokeRaw('journal:query', { boot: 'all', limit: 5, after: p2.entries[0].cursor })).value;
  check('newer page (after a cursor), newest first', [p0.entries.map((e) => e.cursor), p0.more], [curs(all.slice(95, 100)), true]);
  check('limit capped at 5000', (await invokeRaw('journal:query', { boot: 'all', limit: 10 ** 6 })).value.entries.length, all.length);
  await page.evaluate(`(() => { const a = window.aurora; window.__tagged = [a.invokeRaw('journal:query', { boot: 'all', tag: 't1' }), a.invokeRaw('journal:query', { boot: 'all', tag: 't1' })]; })()`);
  const tagged = await page.evaluate(`Promise.all(window.__tagged).then((r) => r.map((x) => x.ok))`);
  check('two queries with the same tag both answer (fixture reads are instant)', tagged, [true, true]);
});

await section('screenshot EN light + no console errors', async () => {
  await preset('previous');
  const lock = await app((a) => a.list.entries.find((e) => e.msg.includes('soft lockup')).cursor);
  await app((a, c) => a.list.select(c), lock);
  await until(page, `!!document.querySelector('${WIN} .lg-fields')`);
  await sleep(300);
  await page.locator(WIN).screenshot({ path: path.join(OUT, 'logs-en-light.png') });
  check('screenshot written', fs.existsSync(path.join(OUT, 'logs-en-light.png')), true);
  check('bar fits (no horizontal overflow)', await page.evaluate(`(() => { const b = document.querySelector('${WIN} .lg-root'); return b.scrollWidth <= b.clientWidth + 1; })()`), true);
  check('no console errors', errors, []);
});
await s.close();

// ================================================================ thousands of entries
const big = tmpFixture('big');
{
  const lines = [];
  let seq = 0x50000;
  const t0 = BOOT_TIMES.current.end + 1000;
  const units = ['NetworkManager.service', 'cron.service', 'bluetooth.service', 'colord.service'];
  for (let i = 0; i < 6000; i++) lines.push(JSON.stringify(makeEntry({ boot: 'current', ms: t0 + i * 250, prio: [6, 6, 6, 4, 7, 5, 3][i % 7], ident: ['NetworkManager', 'CRON', 'bluetoothd', 'colord'][i % 4], unit: units[i % 4], pid: 700 + (i % 4), msg: `stress message number ${i} ${'x'.repeat(i % 120)}`, seq: seq++ })));
  fs.appendFileSync(path.join(big, 'system', `${BOOTS.current}.jsonl`), `${lines.join('\n')}\n`);
}
s = await launchShell({ open: ['logs'], lang: 'en', theme: 'dark', env: { AURORA_JOURNAL_FIXTURE: big, AURORA_JOURNAL_POLL_MS: '60' } });
page = s.page;
errors.length = 0;
watch(page);
await page.evaluate(`window.__aurora_api_invoke = (c, ...a) => window.aurora.invokeRaw(c, ...a).then((r) => { if (r && r.ok) return r.value; const e = new Error(r?.error?.message); e.code = r?.error?.code; throw e; })`);

await section('thousands of entries: pages, DOM size, render time', async () => {
  await until(page, `!!${APP}`, 20000);
  await loaded();
  await preset('all');
  const total = fx(big, { boots: ALL_BOOTS });
  check('first page: 1 000 entries, more to load', [(await entries()).length, await app((a) => a.more)], [1000, true]);
  check('status', await page.textContent(`${WIN} .lg-count`), '1,000 entries · older ones available');
  check('« Load older entries » button', await page.evaluate(`!document.querySelector('${WIN} .lg-more').hidden && document.querySelector('${WIN} .lg-more').textContent`), 'Load older entries');
  check('only the visible rows exist', await app((a) => a.list.domRows()), (n) => n > 10 && n < 90);
  await page.click(`${WIN} .lg-more`);
  await until(page, `${APP}.list.entries.length === 2000 && !${APP}.loadingMore`);
  check('the button loads the next page', (await entries()).length, 2000);
  // scrolling to the end loads the rest
  for (let i = 0; i < 12 && (await app((a) => a.more)); i++) {
    const n = await app((a) => a.list.entries.length);
    await app((a) => (a.list.scroller.scrollTop = 1e9));
    await until(page, `${APP}.list.entries.length > ${n} || !${APP}.more`, 6000);
    await until(page, `!${APP}.loadingMore`);
  }
  const got = await entries();
  check('every entry after scrolling down', [got.length, await app((a) => a.more)], [total.length, false]);
  check('newest first, no duplicates', [JSON.stringify(got) === JSON.stringify(curs(total)), new Set(got).size], [true, total.length]);
  check('still only the visible rows in the DOM', await app((a) => a.list.domRows()), (n) => n < 90);
  // Frame cost (render + the style / layout it causes) for wheel steps, page steps and far jumps.
  const perf = await app((a) => {
    const L = a.list;
    const sc = L.scroller;
    const max = L.entries.length - 40;
    const run = (rows, n = 60) => {
      let pos = 1000;
      const t0 = performance.now();
      for (let i = 0; i < n; i++) {
        pos = (pos + rows) % max;
        sc.scrollTop = pos * 28;
        L._render();
        void L.body.offsetHeight;
      }
      return (performance.now() - t0) / n;
    };
    run(3, 10); // warm up
    return { wheel: run(3), page: run(20), far: run(2711, 30) };
  });
  console.log(`      (frame cost: wheel step ${perf.wheel.toFixed(2)} ms, page ${perf.page.toFixed(2)} ms, far jump ${perf.far.toFixed(2)} ms)`);
  check('wheel scrolling: under 8 ms per frame', perf.wheel, (v) => v < 8);
  check('page down: under one 60 Hz frame (16 ms)', perf.page, (v) => v < 16);
  check('a jump anywhere: under 40 ms', perf.far, (v) => v < 40);
  const row = await app((a) => {
    a.list.scroller.scrollTop = 3000 * 28;
    a.list._render();
    const el = [...a.list.body.children].find((r) => !r.hidden && r._y === 3000 * 28);
    return [el?.querySelector('.c-time').textContent, a.fmtTime(a.list.entries[3000].ts), el?.querySelector('.c-message').textContent, a.list.entries[3000].msg.split('\n')[0]];
  });
  check('the row at a scroll position shows that entry', [row[0] === row[1], row[2] === row[3]], [true, true]);
});

await section('thousands of entries: live view while reading further down', async () => {
  await reload(() => app((a) => a.setState({ priority: 7 })));
  await app((a) => (a.list.scroller.scrollTop = 140 * 28));
  await sleep(100);
  await page.click(`${WIN} .lg-follow`);
  await until(page, `${APP}.followId != null`);
  const topCursor = await app((a) => a.list.entries[140].cursor);
  const t0 = BOOT_TIMES.current.end + 1000 + 6000 * 250 + 5000;
  for (let i = 0; i < 3; i++) appendEntry(big, { boot: 'current', ms: t0 + i * 10, prio: 4, ident: 'smartd', unit: 'smartd.service', pid: 990, msg: `new while reading ${i}` });
  check('pill: 3 new entries above', await until(page, `!document.querySelector('${WIN} .lg-newpill').hidden && document.querySelector('${WIN} .lg-newpill').textContent === '3 new entries above'`, 4000), true);
  check('the rows being read stay in place', await app((a) => a.list.entries[Math.round(a.list.scroller.scrollTop / 28)].cursor), topCursor);
  await page.click(`${WIN} .lg-newpill`);
  check('pill: back to the newest', [await app((a) => a.list.scroller.scrollTop), await page.evaluate(`document.querySelector('${WIN} .lg-newpill').hidden`)], [0, true]);
  await page.click(`${WIN} .lg-follow`);
  await page.locator(WIN).screenshot({ path: path.join(OUT, 'logs-en-dark-many.png') });
  check('no console errors', errors, []);
});
await s.close();

// ================================================================ permissions, journalctl variants (meta.json switched live)
const lim = tmpFixture('limited');
const meta = (m) => fs.writeFileSync(path.join(lim, 'meta.json'), JSON.stringify({ limited: false, pcre2: true, missing: false, ...m }));
meta({ limited: true });
s = await launchShell({ open: ['logs'], lang: 'en', theme: 'light', env: { AURORA_JOURNAL_FIXTURE: lim } });
page = s.page;
errors.length = 0;
watch(page);

await section('only your own messages: infobar', async () => {
  await until(page, `!!${APP}`, 20000);
  await loaded();
  check('infobar shown', await until(page, `!document.querySelector('${WIN} .lg-limited').hidden`), true);
  check('infobar text', await page.textContent(`${WIN} .lg-limited`), 'You only see the messages of your own account. Messages from the system and from other accounts are hidden: an administrator can add your account to the adm group.');
  check('only the user journal is visible', await entries(), curs(fx(lim, { ns: ['user'], filter: (r) => prio(r) != null && prio(r) <= 3 })));
  await preset('mine');
  check('« My apps »: no infobar (nothing hidden there)', await page.evaluate(`document.querySelector('${WIN} .lg-limited').hidden`), true);
  meta({});
  await preset('errors');
  check('full access: no infobar', await page.evaluate(`document.querySelector('${WIN} .lg-limited').hidden`), true);
  await page.locator(WIN).screenshot({ path: path.join(OUT, 'logs-en-light-errors.png') });
});

await section('journalctl without PCRE2: search done by Selene', async () => {
  meta({ pcre2: false });
  await preset('all');
  await reload(async () => {
    await page.fill(`${WIN} .lg-search-input`, 'rfkill');
    await page.press(`${WIN} .lg-search-input`, 'Enter');
  });
  check('same results', (await entries()).length, 3);
  check('flagged', [await app((a) => a.grepFallback), await page.getAttribute(`${WIN} .lg-count`, 'title')], [true, 'Search done by Selene: this journalctl has no pattern matching.']);
  await reload(() => page.press(`${WIN} .lg-search-input`, 'Escape'));
});

await section('journalctl missing, no previous boot', async () => {
  meta({ missing: true });
  await reload(() => page.click(`${WIN} .lg-actions [data-act=refresh]`));
  check('missing journalctl: message', await page.evaluate(`[document.querySelector('${WIN} .lg-empty').hidden, document.querySelector('${WIN} .lg-empty-title').textContent]`), [false, 'journalctl was not found on this system.']);
  meta({});
  const boots = JSON.parse(fs.readFileSync(path.join(lim, 'boots.json'), 'utf8'));
  fs.writeFileSync(path.join(lim, 'boots.json'), JSON.stringify(boots.filter((b) => b.index === 0)));
  await preset('previous');
  check('no previous boot: message + hint', await page.evaluate(`[document.querySelector('${WIN} .lg-empty-title').textContent, document.querySelector('${WIN} .lg-empty-hint')?.textContent]`), ['No previous boot is recorded in the journal.', 'The journal keeps older boots only when it is saved on the disk (not in the live session).']);
  check('no previous boot: nothing to follow', await page.evaluate(`document.querySelector('${WIN} .lg-follow').disabled`), true);
  fs.writeFileSync(path.join(lim, 'boots.json'), JSON.stringify(boots));
  await preset('errors');
  check('custom filters with no match: the generic message', await (async () => {
    await reload(() => app((a, b) => a.setState({ boot: b, priority: 0 }), BOOTS.current));
    return page.evaluate(`document.querySelector('${WIN} .lg-empty-title').textContent`);
  })(), 'No entries match these filters.');
  const noErr = tmpFixture('clean');
  for (const ns of ['system', 'user']) {
    const f = path.join(noErr, ns, `${BOOTS.current}.jsonl`);
    fs.writeFileSync(f, readJsonl(f).filter((r) => !(prio(r) <= 3)).map((r) => JSON.stringify(r)).join('\n') + '\n');
  }
  check('errors view, clean boot', await (async () => {
    const s2 = await launchShell({ open: ['logs'], lang: 'en', theme: 'light', env: { AURORA_JOURNAL_FIXTURE: noErr } });
    const p2 = s2.page;
    await until(p2, `!!${APP} && !${APP}.loading && ${APP}.loadSeq > 0`, 20000);
    await until(p2, `!document.querySelector('${WIN} .lg-empty').hidden`);
    const r = await p2.evaluate(`[document.querySelector('${WIN} .lg-empty-title').textContent, document.querySelector('${WIN} .lg-empty-hint').textContent, document.querySelector('${WIN} .lg-empty').innerText.includes('null') ? 'null shown' : 'ok']`);
    await s2.close();
    return r;
  })(), ['No errors since the computer started.', 'Messages of other levels are still in the journal: choose “Everything” to see them.', 'ok']);
  check('no console errors', errors, []);
});
await s.close();

// ================================================================ French + dark, then light, then English dark (live switches)
const frDir = tmpFixture('fr');
s = await launchShell({ open: ['logs'], lang: 'fr', theme: 'dark', env: { AURORA_JOURNAL_FIXTURE: frDir } });
page = s.page;
errors.length = 0;
watch(page);

await section('French + dark', async () => {
  await until(page, `!!${APP}`, 20000);
  await loaded();
  check('FR views', await page.evaluate(`[...document.querySelectorAll('${WIN} .lg-preset')].map((b) => b.textContent)`), ['Erreurs de ce démarrage', 'Démarrage précédent', 'Noyau', 'Mes applications', 'Tout']);
  check('FR actions', await page.evaluate(`[document.querySelector('${WIN} .lg-follow').textContent, document.querySelector('${WIN} .lg-export').textContent]`), ['Suivre', 'Exporter']);
  check('FR column headers', await page.evaluate(`[...document.querySelectorAll('${WIN} .lg-th')].map((x) => x.textContent)`), ['Heure', 'Niveau', 'Source', 'Message']);
  check('FR count', await page.textContent(`${WIN} .lg-count`), `${fx(frDir, { filter: (r) => prio(r) != null && prio(r) <= 3 }).length} entrées`);
  check('FR level filter', await page.evaluate(`[...document.querySelectorAll('${WIN} .lg-level option')].map((o) => o.textContent)`), ['Tous les niveaux', 'Information ou plus grave', 'Notice ou plus grave', 'Avertissement ou plus grave', 'Erreur ou plus grave', 'Critique ou plus grave', 'Alerte ou plus grave', 'Urgences uniquement']);
  check('FR boots, journal and period filters', await page.evaluate(`[document.querySelector('${WIN} .lg-boot').selectedOptions[0].textContent, [...document.querySelectorAll('${WIN} .lg-scope option')].map((o) => o.textContent), [...document.querySelectorAll('${WIN} .lg-period option')].map((o) => o.textContent)]`), (v) => /^Ce démarrage \(depuis .+\)$/.test(v[0]) && JSON.stringify(v[1]) === JSON.stringify(['Tout le journal', 'Noyau uniquement', 'Mes applications']) && JSON.stringify(v[2]) === JSON.stringify(['Toute la période', 'Dernière heure', 'Dernières 24 heures', '7 derniers jours', 'Période personnalisée…']));
  await preset('all');
  const want = new Set(fx(frDir, { boots: ALL_BOOTS }).map(prio));
  const names = { 0: 'Urgence', 1: 'Alerte', 2: 'Critique', 3: 'Erreur', 4: 'Avertissement', 5: 'Notice', 6: 'Information', 7: 'Débogage' };
  const shown = await app((a) => [...new Set(a.list.entries.map((e) => e.prio))].map((p) => a.prioName(p)));
  check('FR level names in the list', shown.sort(), [...want].map((p) => names[p]).sort());
  await preset('previous');
  const lock = await app((a) => a.list.entries.find((e) => e.msg.includes('soft lockup')).cursor);
  await app((a, c) => a.list.select(c), lock);
  await until(page, `!!document.querySelector('${WIN} .lg-fields')`);
  const det = await page.textContent(`${WIN} .lg-detail`);
  check('FR details', [det.includes('Urgence'), det.includes('mardi 13 octobre 2026'), det.includes('Tous les champs'), det.includes('Afficher le contexte'), det.includes('Seulement cette source')], [true, true, true, true, true]);
  const dark = await page.evaluate(`(() => { const c = getComputedStyle(document.querySelector('${WIN} .lg-row .c-message')).color.match(/\\d+/g).map(Number); return (c[0] + c[1] + c[2]) / 3; })()`);
  check('dark theme: light text', dark, (v) => v > 170);
  const crit = await page.evaluate(`(() => { const td = [...document.querySelectorAll('${WIN} .lg-td.c-level.tone-critical')][0]; const c = getComputedStyle(td).color.match(/\\d+/g).map(Number); return c; })()`);
  check('dark theme: emergency in the danger colour (reddish)', crit, (c) => c[0] > c[1] + 40 && c[0] > c[2] + 40);
  await sleep(200);
  await page.locator(WIN).screenshot({ path: path.join(OUT, 'logs-fr-dark.png') });
  // the limited infobar in French (fixture switched live)
  fs.writeFileSync(path.join(frDir, 'meta.json'), JSON.stringify({ limited: true }));
  await preset('errors');
  check('FR permission infobar', await page.textContent(`${WIN} .lg-limited`), 'Vous ne voyez que les messages de votre compte. Ceux du système et des autres comptes sont masqués : un administrateur peut ajouter votre compte au groupe adm.');
  fs.writeFileSync(path.join(frDir, 'meta.json'), JSON.stringify({}));
  await preset('previous');
  // narrow window: details under the list, nothing overflows
  await app((a) => a.ctx.win.setSize(680, 620));
  await sleep(400);
  check('narrow window, nothing selected: the list takes the whole height', await page.evaluate(`getComputedStyle(document.querySelector('${WIN} .lg-detail')).display`), 'none');
  const lock2 = await app((a) => a.list.entries.find((e) => e.msg.includes('soft lockup')).cursor);
  await app((a, c) => a.list.select(c), lock2);
  await until(page, `!!document.querySelector('${WIN} .lg-fields')`);
  const lay = await page.evaluate(`(() => { const l = document.querySelector('${WIN} .lg-listwrap').getBoundingClientRect(); const d = document.querySelector('${WIN} .lg-detail').getBoundingClientRect(); const r = document.querySelector('${WIN} .lg-root'); return { below: d.top >= l.bottom - 1, overflow: r.scrollWidth > r.clientWidth + 1 }; })()`);
  check('narrow window: details below the list, no overflow', lay, { below: true, overflow: false });
  await page.locator(WIN).screenshot({ path: path.join(OUT, 'logs-fr-dark-narrow.png') });
  await app((a) => a.ctx.win.setSize(1120, 700));
  await sleep(300);
});

await section('live switch: French light, then English dark', async () => {
  const lock = await app((a) => a.list.entries.find((e) => e.msg.includes('soft lockup')).cursor);
  await app((a, c) => a.list.select(c), lock);
  await until(page, `!!document.querySelector('${WIN} .lg-fields')`);
  await page.evaluate(`window.__aurora.settings.set('theme', 'light')`);
  await sleep(500);
  const light = await page.evaluate(`(() => { const c = getComputedStyle(document.querySelector('${WIN} .lg-row .c-message')).color.match(/\\d+/g).map(Number); return (c[0] + c[1] + c[2]) / 3; })()`);
  check('light theme: dark text', light, (v) => v < 90);
  await page.locator(WIN).screenshot({ path: path.join(OUT, 'logs-fr-light.png') });
  await page.evaluate(`window.__aurora.settings.set('theme', 'dark')`);
  await page.evaluate(`window.__aurora.settings.set('lang', 'en')`);
  check('relabelled in English', await until(page, `document.querySelector('${WIN} .lg-preset').textContent === 'Errors this boot'`, 4000), true);
  check('window title follows the language', await page.textContent(`${WIN} .win-title`), 'System Logs');
  check('EN details after the switch', await page.textContent(`${WIN} .lg-detail`), (t) => t.includes('Emergency') && t.includes('All fields'));
  check('EN list levels after the switch', await page.evaluate(`[...document.querySelectorAll('${WIN} .lg-row .c-level')].map((x) => x.textContent)`), (l) => l.includes('Emergency') && !l.includes('Urgence'));
  check('EN headers after the switch', await page.evaluate(`[...document.querySelectorAll('${WIN} .lg-th')].map((x) => x.textContent)`), ['Time', 'Level', 'Source', 'Message']);
  await sleep(300);
  await page.locator(WIN).screenshot({ path: path.join(OUT, 'logs-en-dark.png') });
  check('screenshots written', ['logs-en-light.png', 'logs-en-dark.png', 'logs-fr-light.png', 'logs-fr-dark.png'].every((f) => fs.existsSync(path.join(OUT, f))), true);
  check('no console errors', errors, []);
});
await s.close();

for (const d of [dir, big, lim, frDir]) fs.rmSync(d, { recursive: true, force: true });
finish();
