'use strict';
// "Inside the home folder" check for paths the apps write to or read from (main/ipc/recorder.js, screenrec.js,
// camera.js). Symlinks are resolved: the path itself when it exists, else its deepest existing ancestor, so a link
// inside $HOME cannot point outside it.
//   await realInsideHome(p, { allowHome }) -> the real absolute path (symlinks resolved, missing parts appended) | null
//   null: not a string, outside $HOME once resolved, $HOME itself without allowHome, or a link that cannot be
//   resolved on the way (dangling, looping, unreadable).
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

/** true when `child` is `parent` or inside it (both absolute, normalised). */
function inside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

async function realDeep(abs) {
  let cur = abs;
  const rest = [];
  for (;;) {
    try {
      return path.join(await fsp.realpath(cur), ...rest);
    } catch {
      // something is there but does not resolve (dangling or looping link, no access): refuse rather than guess
      if (await fsp.lstat(cur).then(() => true, () => false)) return null;
      const up = path.dirname(cur);
      if (up === cur) return null;
      rest.unshift(path.basename(cur));
      cur = up;
    }
  }
}

async function realInsideHome(p, { allowHome = false } = {}) {
  if (typeof p !== 'string' || !p || p.includes('\0')) return null;
  const home = path.resolve(os.homedir());
  const realHome = await fsp.realpath(home).catch(() => home);
  const real = await realDeep(path.resolve(p));
  if (!real || !inside(real, realHome)) return null;
  if (real === realHome && !allowHome) return null;
  return real;
}

module.exports = { realInsideHome, inside };
