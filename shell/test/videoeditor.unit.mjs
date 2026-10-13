// Video Editor unit tests (no Electron): project validation, the ffmpeg argv builder, -progress parsing, the
// renderer model (timeline maths, split, trim, undo / redo), and a real export of a small project when ffmpeg is
// installed (H.264 + AAC MP4 at 720p, duration checked with ffprobe).
// Usage:  cd aurora-os/shell && node test/videoeditor.unit.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';
import { makeMedia } from './fixtures/videoeditor/make-media.mjs';
import * as M from '../renderer/apps/videoeditor/lib/model.js';

const require = createRequire(import.meta.url);
const B = require('../main/ipc/videoeditor.js');

let passed = 0;
const failures = [];
function check(name, actual, expected) {
  const ok = typeof expected === 'function' ? !!expected(actual) : JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++;
  else failures.push(`${name}\n      expected: ${typeof expected === 'function' ? '(predicate)' : JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
}
const throws = (name, fn, code) => {
  try {
    fn();
    failures.push(`${name}: did not throw`);
  } catch (e) {
    check(name, e.code, code);
  }
};

const yes = () => true;
const base = () => ({
  media: [
    { id: 'a', path: '/m/a.mp4', kind: 'video', duration: 10, audio: true },
    { id: 'i', path: '/m/p.png', kind: 'image', duration: 0 },
    { id: 's', path: '/m/s.m4a', kind: 'audio', duration: 60, audio: true },
  ],
  video: [
    { id: 'c1', type: 'media', mediaId: 'a', in: 1, out: 4, volume: 0.5, fade: 1, text: { value: "L'été: 100% [ok]; a,b", size: 48, pos: 'bottom', color: '#FFFFFF' } },
    { id: 'c2', type: 'media', mediaId: 'i', in: 0, out: 2 },
    { id: 't', type: 'title', duration: 2, bg: '#101820', fade: 0.5, text: { value: 'Fin', size: 72, pos: 'center', color: '#e9b566' } },
  ],
  music: [{ id: 'm', mediaId: 's', in: 0, out: 30, volume: 0.8, fadeIn: 2, fadeOut: 3 }],
});

// ---- validation
{
  const v = B.validateProject(base(), { exists: yes });
  check('validate: 3 video clips', v.video.map((c) => c.type), ['video', 'image', 'title']);
  check('validate: durations', v.video.map((c) => c.duration), [3, 2, 2]);
  check('validate: colour lower-cased', v.video[0].text.color, '#ffffff');
  check('validate: total', B.totalDuration(v), 7);
  const bad = (mut, code = 'EINVAL') => {
    const p = base();
    mut(p);
    throws(`validate rejects ${mut.toString().slice(6, 70)}`, () => B.validateProject(p, { exists: yes }), code);
  };
  bad((p) => (p.media[0].path = 'rel/a.mp4'));
  bad((p) => (p.media[0].path = '/m/../etc/passwd'));
  bad((p) => (p.video[0].out = 0.5));
  bad((p) => (p.video[0].out = 11));
  bad((p) => (p.video[0].volume = 5));
  bad((p) => (p.video[0].in = NaN));
  bad((p) => (p.video[0].text.color = 'red'));
  bad((p) => (p.video[0].text.value = 'x'.repeat(301)));
  bad((p) => (p.video[0].mediaId = 'zz'));
  bad((p) => (p.video[2].bg = 'url(x)'));
  bad((p) => (p.music[0].mediaId = 'i'));
  bad((p) => (p.video = []), 'EEMPTY');
  throws('validate: missing file', () => B.validateProject(base(), { exists: () => false }), 'ENOENT');
}

// ---- argv
{
  const v = B.validateProject(base(), { exists: yes });
  const { args, duration, textFiles } = B.buildArgs(v, { out: '/home/u/Vidéos/Mon film.mp4', height: 720, font: '/usr/share/fonts/x.otf', tmpDir: '/tmp/ve-1' });
  const graph = args[args.indexOf('-filter_complex') + 1];
  check('argv: duration', duration, 7);
  check('argv: inputs use file:', args.filter((a, i) => args[i - 1] === '-i'), ['file:/m/a.mp4', 'file:/m/p.png', 'file:/m/s.m4a']);
  check('argv: image looped for its duration', args.slice(args.indexOf('-loop'), args.indexOf('-loop') + 6), ['-loop', '1', '-framerate', '30', '-t', '2']);
  check('argv: 720p', graph.includes('scale=1280:720') && graph.includes('s=1280x720'), true);
  check('argv: trim of clip 1', graph.includes('[0:v]trim=start=1:end=4'), true);
  check('argv: user text never in graph', graph.includes('été') || graph.includes('[ok]'), false);
  check('argv: text files', textFiles.map((t) => [path.basename(t.path), t.text]), [['text0.txt', "L'été: 100% [ok]; a,b"], ['text2.txt', 'Fin']]);
  check('argv: drawtext expansion off', graph.includes('textfile=/tmp/ve-1/text0.txt:expansion=none'), true);
  check('argv: font size scaled to 720p', graph.includes('fontsize=48:'), true);
  check('argv: fades (clip 1 out 0.5, image in 0.5)', graph.includes('fade=t=out:st=2.5:d=0.5') && graph.includes('[1:v]trim=duration=2,setpts=PTS-STARTPTS,scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30,format=yuv420p,fade=t=in:st=0:d=0.5'), true);
  check('argv: last clip fades fully to black', graph.includes('fade=t=out:st=1.5:d=0.5[v2]'), true);
  check('argv: clip volume', graph.includes('volume=0.5'), true);
  check('argv: silent image audio', graph.includes('anullsrc=r=48000:cl=stereo,atrim=duration=2'), true);
  check('argv: concat', graph.includes('[v0][a0][v1][a1][v2][a2]concat=n=3:v=1:a=1[vout][vaud]'), true);
  check('argv: music fades + mix', graph.includes('afade=t=in:st=0:d=2') && graph.includes('afade=t=out:st=27:d=3') && graph.includes('amix=inputs=2:duration=first'), true);
  check('argv: H.264 + AAC + progress', ['libx264', 'aac', '-progress', 'pipe:1', '+faststart'].every((x) => args.includes(x)), true);
  check('argv: output last, file:', args.at(-1), 'file:/home/u/Vidéos/Mon film.mp4');
  check('argv: 1080p', B.buildArgs(v, { out: '/x/a.mp4', height: 1080, font: '/f.otf', tmpDir: '/t' }).args.join(' ').includes('scale=1920:1080'), true);
  throws('argv: output must be mp4', () => B.buildArgs(v, { out: '/x/a.mkv' }), 'EINVAL');
  throws('argv: unsafe tmp dir', () => B.buildArgs(v, { out: '/x/a.mp4', tmpDir: "/tmp/a'b" }), 'EUNSAFE');
}

// ---- progress
check('progress: out_time_us', B.parseProgress('frame=10\nout_time_us=2500000\nprogress=continue\n'), { time: 2.5, end: false });
check('progress: end', B.parseProgress('out_time_ms=7000000\nprogress=end\n'), { time: 7, end: true });
check('progress: nothing', B.parseProgress('frame=1\n'), { time: null, end: false });

// ---- renderer model
{
  const p = M.newProject('Test');
  M.addMedia(p, { id: 'a', path: '/m/a.mp4', name: 'a.mp4', kind: 'video', duration: 10, audio: true });
  M.addMedia(p, { id: 'i', path: '/m/p.png', name: 'p.png', kind: 'image', duration: 0 });
  M.addMedia(p, { id: 's', path: '/m/s.m4a', name: 's.m4a', kind: 'audio', duration: 20, audio: true });
  const c1 = M.addToTimeline(p, 'a');
  const c2 = M.addToTimeline(p, 'i');
  const m1 = M.addToTimeline(p, 's');
  check('model: image default 4 s', M.clipDuration(p.video[1]), 4);
  check('model: total', M.totalDuration(p), 14);
  check('model: music on music track', p.music.length, 1);
  check('model: clipAt', M.clipAt(p, 11).clip.id, c2.id);
  check('model: clipAt offset', Math.round(M.clipAt(p, 11).offset * 10) / 10, 1);
  const parts = M.split(p, 3);
  check('model: split', [p.video.length, p.video[0].out, p.video[1].in, parts?.[1]?.mediaId], [3, 3, 3, 'a']);
  check('model: split at edge does nothing', M.split(p, 0), null);
  M.trim(p, p.video[0].id, 'start', 1);
  check('model: trim start', [p.video[0].in, p.video[0].out], [1, 3]);
  M.trim(p, p.video[0].id, 'end', -5);
  check('model: trim keeps min length', p.video[0].out - p.video[0].in >= M.MIN_CLIP - 1e-9, true);
  M.trim(p, p.video[2].id, 'end', 2);
  check('model: trim image end = longer still', M.clipDuration(p.video[2]), 6);
  M.move(p, 'video', p.video[2].id, 0);
  check('model: move', p.video[0].mediaId, 'i');
  M.remove(p, m1.id);
  check('model: remove', p.music.length, 0);
  const tc = M.addTitle(p, 1, { value: 'Bonjour' });
  check('model: title', [p.video[1].type, p.video[1].text.value, tc.duration], ['title', 'Bonjour', 3]);
  check('model: time format', [M.fmtTime(0), M.fmtTime(65.4), M.fmtTime(3725, true)], ['0:00', '1:05', '1:02:05.0']);
  const h = M.history();
  h.commit(p);
  p.name = 'Changed';
  check('undo', h.undo(p).name, 'Test');
  check('redo', h.redo(h.current).name, 'Changed');
  check('serialize/parse', M.parse(M.serialize(p)).video.length, p.video.length);
  let bad = null;
  try {
    M.parse('{"format":"other"}');
  } catch (e) {
    bad = e.code;
  }
  check('parse: rejects other files', bad, 'EFORMAT');
  check('export view', B.validateProject(M.forExport(p), { exists: yes }).video.length, p.video.length);
}

// ---- real export (ffmpeg on this machine)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 've-unit-'));
const media = makeMedia(path.join(tmp, 'media'));
if (!media) console.log('  - ffmpeg missing: real export skipped');
else {
  const p = {
    media: [
      { id: 'a', path: media.video, kind: 'video', duration: 4, audio: true },
      { id: 'b', path: media.video2, kind: 'video', duration: 3, audio: false },
      { id: 'i', path: media.image, kind: 'image', duration: 0 },
      { id: 's', path: media.music, kind: 'audio', duration: 8, audio: true },
    ],
    video: [
      { id: '1', type: 'media', mediaId: 'a', in: 0.5, out: 2.5, volume: 1, fade: 0.6, text: { value: "Vacances d'été : 100 %", size: 40, pos: 'bottom', color: '#ffffff' } },
      { id: '2', type: 'media', mediaId: 'b', in: 0, out: 1.5, fade: 0.4 },
      { id: '3', type: 'media', mediaId: 'i', in: 0, out: 1 },
      { id: '4', type: 'title', duration: 1, bg: '#202840', text: { value: 'Fin', size: 64, pos: 'center', color: '#e9b566' } },
    ],
    music: [{ id: 'm', mediaId: 's', in: 1, out: 6, volume: 0.5, fadeIn: 1, fadeOut: 1 }],
  };
  const v = B.validateProject(p);
  const out = path.join(tmp, 'Mon film.mp4');
  const font = ['/usr/share/fonts/opentype/inter/Inter-Bold.otf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'].find((f) => fs.existsSync(f));
  const tdir = fs.mkdtempSync(path.join(os.tmpdir(), 've-text-'));
  const { args, textFiles } = B.buildArgs(v, { out, height: 720, font, tmpDir: tdir });
  for (const t of textFiles) fs.writeFileSync(t.path, t.text);
  const t0 = Date.now();
  const r = spawnSync('ffmpeg', args, { encoding: 'utf8' });
  check('export: ffmpeg exit 0', r.status, 0);
  if (r.status !== 0) console.log(r.stderr);
  check('export: progress lines', /out_time_us=\d+/.test(r.stdout) && /progress=end/.test(r.stdout), true);
  const info = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', out], { encoding: 'utf8' }));
  const vs = info.streams.find((s) => s.codec_type === 'video');
  const as = info.streams.find((s) => s.codec_type === 'audio');
  check('export: h264 1280x720', [vs?.codec_name, vs?.width, vs?.height], ['h264', 1280, 720]);
  check('export: aac stereo', [as?.codec_name, as?.channels], ['aac', 2]);
  check('export: duration ≈ 5.5 s', Number(info.format.duration), (d) => Math.abs(d - 5.5) < 0.15);
  console.log(`  real export: ${Date.now() - t0} ms, ${fs.statSync(out).size} bytes`);
}
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`videoeditor.unit: ${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  ✗ ${f}`);
process.exit(failures.length ? 1 : 0);
