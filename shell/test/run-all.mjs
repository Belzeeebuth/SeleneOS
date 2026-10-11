// Runs every shell test suite (test/*.test.mjs, test/*.unit.mjs, test/smoke.mjs), each under
// its own Xvfb display, and prints a summary. Exit code 1 if any suite fails.
//
//   node test/run-all.mjs                 # all suites, 2 at a time
//   node test/run-all.mjs -j 3            # 3 at a time
//   node test/run-all.mjs --only=files,mail --skip=pdf
//   node test/run-all.mjs --retry         # re-run failed suites once, alone (separates load flakes)
//   node test/run-all.mjs --timeout=25    # minutes per suite (default 20)
//
// Logs: test/out/logs/<suite>.log
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const LOGS = path.join(HERE, 'out', 'logs');

const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.findIndex((a) => a === `-${name}` || a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return def;
  const a = argv[i];
  if (a.includes('=')) return a.slice(a.indexOf('=') + 1);
  const next = argv[i + 1];
  return next && !next.startsWith('-') ? next : true;
};
const list = (v) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);

const jobs = Math.max(1, Number(opt('j', 2)) || 2);
const timeoutMin = Number(opt('timeout', 20)) || 20;
const only = list(opt('only'));
const skip = list(opt('skip'));
const retry = Boolean(opt('retry', false));

const suiteName = (f) => f.replace(/\.test\.mjs$|\.mjs$/, '');
let suites = fs.readdirSync(HERE)
  .filter((f) => /\.(test|unit)\.mjs$/.test(f) || f === 'smoke.mjs')
  .sort();
if (only.length) suites = suites.filter((f) => only.includes(suiteName(f)));
if (skip.length) suites = suites.filter((f) => !skip.includes(suiteName(f)));
if (!suites.length) {
  console.error('no suites selected');
  process.exit(2);
}
fs.mkdirSync(LOGS, { recursive: true });

function runSuite(file, attempt = 1) {
  return new Promise((resolve) => {
    const name = suiteName(file);
    const log = path.join(LOGS, `${name}${attempt > 1 ? `.retry${attempt - 1}` : ''}.log`);
    const out = fs.openSync(log, 'w');
    const t0 = Date.now();
    // xvfb-run kills its Xvfb when the command exits; detached + group kill covers Electron children on timeout.
    const child = spawn('xvfb-run', ['-a', '-s', '-screen 0 1920x1080x24', 'node', path.join('test', file)], {
      cwd: ROOT, stdio: ['ignore', out, out], detached: true, env: process.env,
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    }, timeoutMin * 60_000);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      fs.closeSync(out);
      const secs = Math.round((Date.now() - t0) / 1000);
      const text = fs.readFileSync(log, 'utf8');
      const tail = text.trim().split('\n').slice(-40);
      const counts = [...text.matchAll(/(\d+)\s+passed,\s+(\d+)\s+failed/g)].pop();
      const ok = code === 0 && !timedOut;
      resolve({
        file, name, ok, code, signal, timedOut, secs, log,
        counts: counts ? `${counts[1]} passed, ${counts[2]} failed` : '',
        tail: ok ? [] : tail,
      });
    });
  });
}

async function pool(items, n, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
      const r = results[i];
      console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(26)} ${String(r.secs).padStart(5)}s  ${r.timedOut ? 'TIMEOUT' : r.counts}`);
    }
  }));
  return results;
}

console.log(`Running ${suites.length} suites, ${jobs} at a time (timeout ${timeoutMin} min). Logs: ${path.relative(process.cwd(), LOGS)}/\n`);
const t0 = Date.now();
let results = await pool(suites, jobs, (f) => runSuite(f));

if (retry) {
  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    console.log(`\nRe-running ${failed.length} failed suite(s) one at a time…`);
    for (const r of failed) {
      const again = await runSuite(r.file, 2);
      console.log(`${again.ok ? 'PASS' : 'FAIL'}  ${again.name.padEnd(26)} ${String(again.secs).padStart(5)}s  (retry) ${again.counts}`);
      if (again.ok) Object.assign(r, { ok: true, flaky: true });
      else Object.assign(r, { tail: again.tail, log: again.log });
    }
  }
}

const failed = results.filter((r) => !r.ok);
const flaky = results.filter((r) => r.flaky);
console.log(`\n${results.length - failed.length}/${results.length} suites passed in ${Math.round((Date.now() - t0) / 60000)} min.`);
if (flaky.length) console.log(`Passed only on retry (load-sensitive): ${flaky.map((r) => r.name).join(', ')}`);
for (const r of failed) {
  console.log(`\n--- ${r.name} (${r.timedOut ? 'timeout' : `exit ${r.code}`}) — ${path.relative(process.cwd(), r.log)}`);
  console.log(r.tail.join('\n'));
}
process.exit(failed.length ? 1 : 0);
