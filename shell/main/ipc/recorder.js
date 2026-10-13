'use strict';
// Voice Recorder backend (apps/recorder): .m4a / .mp3 export through ffmpeg (iso/packages.d/screenrec.list).
//   recorder:tools()              -> { ffmpeg: boolean }
//   recorder:export(src, format)  -> { path }   format 'm4a' (AAC 128k) or 'mp3' (LAME 128k); the copy is written next
//                                    to src with a free name (<base>.m4a, <base> (2).m4a, ...). src must be a file under
//                                    $HOME; ffmpeg runs with an argv array (no shell), input after '-i' as a path.
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { run, which } = require('../lib/exec');

const FORMATS = {
  m4a: ['-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart'],
  mp3: ['-c:a', 'libmp3lame', '-b:a', '128k'],
};

function insideHome(p) {
  const home = path.resolve(os.homedir());
  const abs = path.resolve(String(p || ''));
  return abs.startsWith(home + path.sep) ? abs : null;
}

module.exports = function register(api) {
  api.handle('recorder:tools', () => ({ ffmpeg: !!which('ffmpeg') }));

  api.handle('recorder:export', async (src, format) => {
    const fmt = String(format || '');
    if (!Object.hasOwn(FORMATS, fmt)) throw api.error('Unknown format', 'EINVAL');
    const abs = insideHome(src);
    if (!abs) throw api.error('The file must be in your home folder', 'EACCES');
    const st = await fsp.stat(abs).catch(() => null);
    if (!st || !st.isFile()) throw api.error('No such recording', 'ENOENT');
    if (!which('ffmpeg')) throw api.error('ffmpeg is not installed', 'ENOFFMPEG');
    const dir = path.dirname(abs);
    const base = path.basename(abs).replace(/\.[^.]+$/, '');
    let out = null;
    for (let i = 1; i < 1000 && !out; i++) {
      const p = path.join(dir, `${base}${i > 1 ? ` (${i})` : ''}.${fmt}`);
      if (!fs.existsSync(p)) out = p;
    }
    if (!out) throw api.error('No free file name', 'EEXIST');
    const tmp = `${out}.part`;
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', abs, '-vn', '-map_metadata', '-1', ...FORMATS[fmt], '-f', fmt === 'm4a' ? 'ipod' : 'mp3', tmp];
    const r = await run('ffmpeg', args, { timeout: 30 * 60000 }).catch((e) => ({ code: 1, stderr: e.message }));
    if (r.code !== 0 || !fs.existsSync(tmp)) {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      throw api.error(String(r.stderr || 'ffmpeg failed').trim().split('\n').pop().slice(0, 200), 'EFFMPEG');
    }
    await fsp.rename(tmp, out);
    return { path: out };
  });
};
