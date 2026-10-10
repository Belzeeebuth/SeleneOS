// temporary probe (removed later): renders each effect full screen and screenshots it
import { launchShell } from './lib.mjs';
const mode = process.argv[2] || 'dark';
const s = await launchShell({ theme: mode, size: '1600x900' });
const ids = ['aurora', 'bloom', 'fluid', 'bokeh', 'starfield', 'waves'];
for (const id of ids) {
  const info = await s.page.evaluate(async ({ id, mode }) => {
    const { WallpaperRenderer } = await import('app://shell/core/wallpaper/engine.js');
    const { effectById } = await import('app://shell/core/wallpaper/effects/index.js');
    document.getElementById('wp-probe')?.remove();
    const host = document.createElement('div');
    host.id = 'wp-probe';
    host.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#000';
    document.body.append(host);
    const st = document.createElement('style');
    st.textContent = '#wp-probe .wp-scene{position:absolute;inset:0}#wp-probe canvas{position:absolute;inset:0;width:100%;height:100%}';
    host.append(st);
    const t0 = performance.now();
    const r = new WallpaperRenderer({ host, effect: effectById(id), params: { mode, accent: '#0078d4', intensity: 0.5, speed: 1 }, fps: 30 });
    const build = performance.now() - t0;
    // time 20 frames
    const t1 = performance.now();
    const gg = r.anim.getContext('2d');
    for (let i = 0; i < 20; i++) { r.renderStill(10 + i * 0.033); gg.getImageData(0, 0, 1, 1); }
    const per = (performance.now() - t1) / 20;
    r.renderStill(r.effect.heroTime ?? 12);
    window.__probe = r;
    return { build: Math.round(build), perFrameMs: per.toFixed(2), canvas: [r.anim.width, r.anim.height] };
  }, { id, mode });
  console.log(id, JSON.stringify(info));
  await s.page.waitForTimeout(200);
  await s.page.screenshot({ path: `/tmp/claude-0/scratch/fx-${id}-${mode}.png` });
}
await s.close();
