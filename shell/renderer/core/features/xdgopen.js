// Links and files opened from Linux / Flatpak apps (xdg-open, the OpenURI portal -> /usr/bin/aurora-open ->
// main/ipc/xdgopen.js, already validated there) open in Selene, like a click in Selene would.
//   xdg:open { app, url } | { app, path } | { app }   app: '' (pick by type) or a Selene app id
export function open(ctx, req = {}) {
  const { shell } = ctx;
  const app = typeof req.app === 'string' ? req.app : '';
  if (typeof req.url === 'string') {
    if (/^mailto:/i.test(req.url)) return shell.launch('mail', { mailto: req.url });
    if (/^https?:\/\//i.test(req.url)) return shell.openUrl(req.url);
    return null;
  }
  if (typeof req.path === 'string' && req.path.startsWith('/')) {
    if (app === 'files') return shell.launch('files', { path: req.path });
    // A specific Selene app only when it declares the type; otherwise the usual handler (or the office prompt).
    const m = app ? shell.registry.get(app) : null;
    const ext = (/\.[^./]+$/.exec(req.path)?.[0] || '').toLowerCase();
    const opts = m && (m.fileTypes || []).includes(ext) ? { appId: app } : {};
    return shell.openFile(req.path, opts);
  }
  if (app === 'browser' || app === 'mail') return shell.launch(app, {});
  return null;
}

export function mount(ctx) {
  ctx.api.on('xdg:open', (req) => {
    Promise.resolve(open(ctx, req)).catch((err) => console.error('[xdgopen] open failed', err));
  });
}
