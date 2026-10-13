// Small media files for the Video Editor tests, made with ffmpeg (test pattern + tones), so no binary lives in git.
//   makeMedia(dir) -> { video, video2, image, music } (absolute paths), or null when ffmpeg is missing
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export function makeMedia(dir) {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  } catch {
    return null;
  }
  fs.mkdirSync(dir, { recursive: true });
  const ff = (...a) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...a], { stdio: 'inherit' });
  const out = {
    video: path.join(dir, 'Plage.mp4'),
    video2: path.join(dir, 'Montagne.mp4'),
    image: path.join(dir, 'Coucher de soleil.png'),
    music: path.join(dir, 'Guitare douce.m4a'),
  };
  if (!fs.existsSync(out.video)) ff('-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=4', '-f', 'lavfi', '-i', 'sine=f=440:d=4', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', out.video);
  if (!fs.existsSync(out.video2)) ff('-f', 'lavfi', '-i', 'smptebars=s=640x360:r=30:d=3', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', out.video2);
  if (!fs.existsSync(out.image)) ff('-f', 'lavfi', '-i', 'gradients=s=800x450:c0=0xf2a65a:c1=0x6a4bc3:x0=0:y0=0:x1=800:y1=450:d=1', '-frames:v', '1', out.image);
  if (!fs.existsSync(out.music)) ff('-f', 'lavfi', '-i', 'sine=f=330:d=8', '-c:a', 'aac', out.music);
  return out;
}
