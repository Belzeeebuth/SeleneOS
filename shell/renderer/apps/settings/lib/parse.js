// Settings app — pure parsers (no DOM; unit-tested from Node).

/** `apt-get -s upgrade` "Inst" lines -> [{ name, from, to, origin, security }] */
export function parseAptSimulation(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const m = /^Inst\s+(\S+)\s+(?:\[([^\]]+)\]\s+)?\((\S+)\s+([^)]*)\)/.exec(line.trim());
    if (!m) continue;
    const origin = m[4].replace(/\s*\[[^\]]*\]\s*$/, '').trim();
    out.push({ name: m[1], from: m[2] || null, to: m[3], origin, security: /-security\b/.test(m[4]) });
  }
  return out;
}

/**
 * One APT status line (APT::Status-Fd) -> { phase: 'download'|'install'|'error', percent (0-100 overall), step, pkg, message } | null
 *   dlstatus:3:42.8571:Retrieving file 3 of 7
 *   pmstatus:firefox:57.1429:Unpacking firefox (131.0.3)
 *   pmerror:foo:50:subprocess installed post-installation script returned error exit status 1
 * Overall progress: downloads count for the first 40 %, installation for the rest.
 */
export function parseAptStatus(line) {
  const m = /^(dlstatus|pmstatus|pmerror|pmconffile):([^:]*):([\d.]+):(.*)$/.exec(String(line || '').trim());
  if (!m) return null;
  const pct = Math.max(0, Math.min(100, parseFloat(m[3]) || 0));
  if (m[1] === 'dlstatus') return { phase: 'download', percent: Math.round(pct * 0.4 * 10) / 10, step: pct, pkg: null, message: m[4] };
  if (m[1] === 'pmerror') return { phase: 'error', percent: null, step: pct, pkg: m[2] || null, message: m[4] };
  return { phase: 'install', percent: Math.round((40 + pct * 0.6) * 10) / 10, step: pct, pkg: m[2] || null, message: m[4] };
}

function splitPkgList(s) {
  // "a:amd64 (1, 2), b:amd64 (3, automatic)" -> ['a:amd64 (1, 2)', 'b:amd64 (3, automatic)']
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of String(s || '')) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function parsePkg(s) {
  const m = /^([^\s:]+)(?::(\S+))?\s*\(([^)]*)\)/.exec(s);
  if (!m) return { name: s, arch: null, from: null, to: null };
  const vers = m[3].split(',').map((x) => x.trim());
  return { name: m[1], arch: m[2] || null, from: vers.length > 1 && vers[1] !== 'automatic' ? vers[0] : null, to: vers.length > 1 && vers[1] !== 'automatic' ? vers[1] : vers[0], automatic: vers.includes('automatic') };
}

function parseAptDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/.exec(String(s || '').trim());
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])).getTime() : null;
}

/** /var/log/apt/history.log -> [{ start, end, commandline, requestedBy, upgrade: [pkg], install: [pkg], remove: [pkg], error }] newest first */
export function parseAptHistory(text) {
  const entries = [];
  for (const block of String(text || '').split(/\n\s*\n/)) {
    const kv = {};
    for (const line of block.split('\n')) {
      const i = line.indexOf(': ');
      if (i > 0) kv[line.slice(0, i).trim()] = line.slice(i + 2).trim();
    }
    if (!kv['Start-Date']) continue;
    entries.push({
      start: parseAptDate(kv['Start-Date']),
      end: parseAptDate(kv['End-Date']),
      commandline: kv.Commandline || null,
      requestedBy: kv['Requested-By'] ? kv['Requested-By'].replace(/\s*\(\d+\)$/, '') : null,
      upgrade: splitPkgList(kv.Upgrade).map(parsePkg),
      install: splitPkgList(kv.Install).map(parsePkg),
      remove: splitPkgList([kv.Remove, kv.Purge].filter(Boolean).join(', ')).map(parsePkg),
      error: kv.Error || null,
    });
  }
  return entries.sort((a, b) => (b.start || 0) - (a.start || 0));
}
