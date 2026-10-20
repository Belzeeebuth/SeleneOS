// Rendering mode of the shell: <html data-gfx="gpu" | "soft">.
//   soft = no usable 3D (AURORA_GPU=off, no driver, a VM, Xvfb): the compositor draws in software, where a live
//   backdrop-filter blur costs 20-30 ms per frame on a large panel. The glass panels (Lanceur, Réglages rapides) then
//   paint the pre-blurred wallpaper (--mica-image) under the same tint instead (shell-personalize.css), which looks the
//   same over the desktop and costs nothing per frame. gpu = keep the live blur.
// Detected once: a WebGL context that refuses a major performance caveat (SwiftShader / llvmpipe) means software.
export function detectGfx() {
  let mode = 'soft';
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl', { failIfMajorPerformanceCaveat: true }) || null;
    if (gl) {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      const r = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) || '');
      mode = /swiftshader|llvmpipe|softpipe|software/i.test(r) ? 'soft' : 'gpu';
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
  } catch {
    mode = 'soft';
  }
  document.documentElement.dataset.gfx = mode;
  return mode;
}
