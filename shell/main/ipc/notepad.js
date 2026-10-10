'use strict';
// Notepad backend: the font families installed on the system (Font dialog).
//   notepad:fonts -> { all: ['Cascadia Mono', 'DejaVu Sans', …], mono: ['Cascadia Mono', …] }
//   (sorted, unique; empty lists when fontconfig is missing, e.g. on a bare dev machine)
const { run } = require('../lib/exec');

let cache = null;

function families(stdout) {
  const set = new Set();
  for (const line of String(stdout || '').split('\n')) {
    const f = line.trim();
    if (f && !f.startsWith('.') && !/emoji|symbol|opensymbol|^unifont (csur|sample|upper)/i.test(f)) set.add(f);
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

module.exports = function register(api) {
  api.handle('notepad:fonts', async () => {
    if (cache) return cache;
    try {
      const [all, mono] = await Promise.all([
        run('fc-list', ['--format', '%{family[0]}\n', ':scalable=true'], { timeout: 15000 }),
        run('fc-list', ['--format', '%{family[0]}\n', ':scalable=true:spacing=100'], { timeout: 15000 }),
      ]);
      cache = { all: families(all.stdout), mono: families(mono.stdout) };
    } catch {
      cache = { all: [], mono: [] };
    }
    return cache;
  });
};
