'use strict';
// Runs main/ipc/journal.js in its real mode (api.DEV false: it spawns `journalctl`) against fake-journalctl.mjs and
// prints the results as JSON, for test/logs.test.mjs. Never run against the real journalctl: the test puts the fake
// first in PATH. Usage: node real-harness.cjs <scenario>   env: FAKE_JOURNAL_DIR, FAKE_JOURNAL_MODE, FAKE_JOURNAL_LOG,
// HARNESS_OUT (a folder for export files).
const path = require('path');
const fs = require('fs');
const register = require('../../../main/ipc/journal.js');

const handlers = new Map();
const events = [];
register({ DEV: false, handle: (c, f) => handlers.set(c, f), sendTo: (_s, c, p) => events.push({ c, p }) });
const sender = { id: 7, isDestroyed: () => false, once() {}, on() {} };
const call = async (c, ...a) => {
  try {
    return { ok: true, v: await handlers.get(c)(...a, { sender }) };
  } catch (e) {
    return { ok: false, code: e.code, message: e.message };
  }
};
const cursors = (r) => (r.ok ? r.v.entries.map((e) => e.cursor) : r);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const scenarios = {
  async basic() {
    const r = {};
    r.boots = (await call('journal:boots')).v;
    const errors = await call('journal:query', { boot: 'current', priority: 3, limit: 5 });
    r.errors = { cursors: cursors(errors), more: errors.v.more, limited: errors.v.limited, mock: errors.v.mock };
    r.older = cursors(await call('journal:query', { boot: 'current', priority: 3, limit: 5, before: errors.v.entries[4].cursor }));
    r.newer = cursors(await call('journal:query', { boot: 'current', priority: 3, limit: 2, after: errors.v.entries[4].cursor }));
    r.kernel = cursors(await call('journal:query', { boot: 'all', kernel: true, limit: 5000 }));
    r.userUnit = cursors(await call('journal:query', { boot: 'all', user: true, unit: 'pipewire.service', limit: 5000 }));
    r.ident = cursors(await call('journal:query', { boot: 'all', identifier: 'CRON', limit: 5000 }));
    const range = { boot: 'all', since: '2026-10-14T07:17:00.000Z', until: '2026-10-14T07:18:00.500Z' };
    r.range = cursors(await call('journal:query', { ...range, limit: 5000 }));
    const p1 = await call('journal:query', { ...range, limit: 5 });
    const p2 = await call('journal:query', { ...range, limit: 5, before: p1.v.entries[4].cursor });
    r.rangePaged = [...cursors(p1), ...cursors(p2)];
    r.grep = (await call('journal:query', { boot: 'all', grep: '(*) on link (a+b)?' })).v.entries.map((e) => e.msg);
    r.grepCase = cursors(await call('journal:query', { boot: 'all', grep: 'RFKILL' }));
    r.grepNone = await call('journal:query', { boot: 'all', grep: 'zzz-nothing' });
    r.noBoot = await call('journal:query', { boot: 'f'.repeat(32) });
    const all = (await call('journal:query', { boot: 'all', limit: 5000 })).v.entries;
    const colord = all.find((e) => e.msg.includes('scan failed'));
    r.colord = colord;
    r.entry = await call('journal:entry', colord.cursor);
    r.entryUnknown = await call('journal:entry', 's=1;i=2;b=3;m=4;t=5;x=6');
    r.context = await call('journal:context', colord.cursor, { before: 3, after: 2 });
    r.sources = (await call('journal:sources', { user: false })).v;
    const out = process.env.HARNESS_OUT;
    r.exportText = await call('journal:export', { boot: 'current', priority: 3 }, { path: path.join(out, 'real.txt'), format: 'text' });
    r.exportJson = await call('journal:export', { boot: 'all' }, { path: path.join(out, 'real.json'), format: 'json' });
    return r;
  },
  async limited() {
    const q = await call('journal:query', { boot: 'current', priority: 3 });
    const u = await call('journal:query', { boot: 'current', priority: 3, user: true });
    return { boots: (await call('journal:boots')).v.limited, errors: { cursors: cursors(q), limited: q.v.limited }, user: { limited: u.v.limited } };
  },
  async nopcre() {
    const a = await call('journal:query', { boot: 'all', grep: 'rfkill' });
    const b = await call('journal:query', { boot: 'all', grep: 'soft lockup' });
    return { a: { cursors: cursors(a), fallback: a.v.grepFallback }, b: { msgs: b.v.entries.map((e) => e.msg), fallback: b.v.grepFallback } };
  },
  async oldboots() {
    return (await call('journal:boots')).v;
  },
  async follow() {
    const { appendEntry } = await import('./fixture-lib.mjs');
    const dir = process.env.FAKE_JOURNAL_DIR;
    const f = await call('journal:follow', { boot: 'current', priority: 3 });
    await sleep(500);
    const t0 = Date.UTC(2026, 9, 14, 8, 30);
    const a = appendEntry(dir, { boot: 'current', ms: t0, prio: 3, ident: 'smartd', unit: 'smartd.service', pid: 990, msg: 'real-mode follow: error' });
    appendEntry(dir, { boot: 'current', ms: t0 + 10, prio: 6, ident: 'smartd', unit: 'smartd.service', pid: 990, msg: 'real-mode follow: info' });
    for (let i = 0; i < 60 && !events.some((e) => e.c === 'journal:entries'); i++) await sleep(50);
    const count = (await call('journal:follows')).v;
    const un = await call('journal:unfollow', f.v.id);
    await sleep(200);
    const after = (await call('journal:follows')).v;
    // Starting after a cursor: what came after it, then live.
    const g = await call('journal:follow', { boot: 'current', priority: 3, after: (await call('journal:query', { boot: 'current', priority: 3, limit: 3 })).v.entries[2].cursor });
    for (let i = 0; i < 60 && events.filter((e) => e.c === 'journal:entries' && e.p.id === g.v.id).length === 0; i++) await sleep(50);
    await call('journal:unfollow', g.v.id);
    const old = await call('journal:follow', { boot: 'previous' });
    return { id: f.v.id, appended: a.__CURSOR, running: count, unfollow: un.v, after, events, afterId: g.v.id, previous: old };
  },
};

(async () => {
  const r = await scenarios[process.argv[2]]();
  process.stdout.write(JSON.stringify(r));
  process.exit(0);
})().catch((e) => {
  process.stdout.write(JSON.stringify({ crashed: String(e?.stack || e) }));
  process.exit(1);
});
