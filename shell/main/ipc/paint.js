'use strict';
// Paint backend: lists the font families installed on the system (for the Text tool).
//   paint:fonts -> ['DejaVu Sans', 'Inter', …]  (sorted, unique; [] when fontconfig is missing)
const { run } = require('../lib/exec');

let cache = null;

module.exports = function register(api) {
  api.handle('paint:fonts', async () => {
    if (cache) return cache;
    try {
      const { stdout } = await run('fc-list', ['--format', '%{family[0]}\n', ':scalable=true'], { timeout: 15000 });
      const set = new Set();
      for (const line of stdout.split('\n')) {
        const f = line.trim();
        if (f && !f.startsWith('.') && !/emoji|symbol/i.test(f)) set.add(f);
      }
      cache = [...set].sort((a, b) => a.localeCompare(b));
    } catch {
      cache = [];
    }
    return cache;
  });
};
