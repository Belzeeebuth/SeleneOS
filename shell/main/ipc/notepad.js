'use strict';
// Notepad backend: the font families installed on the system (Font dialog).
//   notepad:fonts -> { all: ['Cascadia Mono', 'DejaVu Sans', …], mono: ['Cascadia Mono', …] }
//   (sorted, unique; empty lists when fontconfig is missing, e.g. on a bare dev machine)
//   Cached until the Fonts app installs or removes a font (fonts.js generation()).
const { run } = require('../lib/exec');

let cache = null;
let cacheGen = 0;
// The Fonts app (main/ipc/fonts.js) bumps a generation when it installs or removes a font: the list is read again.
const fontsGeneration = () => {
  try {
    return require('./fonts').generation();
  } catch {
    return 0;
  }
};

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
    if (cache && cacheGen === fontsGeneration()) return cache;
    cacheGen = fontsGeneration();
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
