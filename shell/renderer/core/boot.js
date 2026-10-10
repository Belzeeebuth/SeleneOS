// Shell entry point: loads settings, language, icons, theme and apps, then mounts the desktop.
// Extra shell features (quick settings, calendar, Alt+Tab, task view, lock screen, …) live in
// core/features/*.js; each exports `mount(ctx)` and is loaded from FEATURES below.
import { api, env } from './api.js';
import { i18n, t } from './i18n.js';
import { loadIcons } from './icons.js';
import { settings } from './settings.js';
import { applyTheme, watchTheme, theme } from './theme.js';
import { wm } from './wm.js';
import { registry, setShellServices } from './registry.js';
import { shell } from './services.js';
import { notifications, notify } from './notify.js';
import { taskbar } from './taskbar.js';
import { start } from './start.js';
import { desktop } from './desktop.js';
import { sounds } from './sounds.js';
import { h, ui } from './ui.js';

// Feature modules in core/features/ are discovered at runtime; FEATURES only fixes the load order.
// A broken feature is logged and skipped — it never blocks the desktop.
const FEATURES = ['hotkeys', 'quick', 'calendar', 'alttab', 'taskview', 'search', 'lock', 'snaplayouts', 'widgets', 'security', 'osd', 'dbus-notify'];

async function main() {
  await Promise.all([settings.load(), loadIcons()]);
  i18n.init(settings.get('lang') || env.lang);
  await i18n.load();
  await applyTheme();
  watchTheme();
  settings.on('lang', (l) => i18n.setLang(l || env.lang));

  shell.xdg = await api.invoke('fs:xdg').catch(() => null);
  setShellServices(shell);
  await registry.load();

  const $ = (id) => document.getElementById(id);
  wm.mount($('windows'));
  wm.setInsets({ bottom: settings.get('taskbar.autohide') ? 0 : 48 });
  notifications.mount($('toasts'), (appId) => (registry.get(appId) ? registry.iconUrl(appId) : null));
  await desktop.mount($('desktop'));
  taskbar.mount($('taskbar'));
  start.mount($('start'));

  const ctx = { api, env, i18n, t, settings, theme, wm, registry, shell, notify, notifications, taskbar, start, desktop, sounds, h, ui };
  window.__aurora = ctx; // handy for debugging & tests
  const available = new Set(await api.invoke('shell:features').catch(() => []));
  const ordered = [...FEATURES.filter((f) => available.has(f)), ...[...available].filter((f) => !FEATURES.includes(f)).sort()];
  for (const name of ordered) {
    try {
      const mod = await import(`./features/${name}.js`);
      await mod.mount?.(ctx);
    } catch (err) {
      console.error(`[boot] feature ${name} failed`, err);
    }
  }

  // Links opened from sandboxed content (e.g. mail bodies) arrive here and open in the browser.
  api.on('shell:open-url', ({ url }) => url && shell.openUrl(url));

  document.body.classList.add('ready');
  if (!sessionStorage.getItem('aurora-started')) {
    sessionStorage.setItem('aurora-started', '1');
    sounds.play('startup');
  }
  for (const id of env.open || []) await registry.launch(id);
  shell.emit('ready');
}

main().catch((err) => {
  console.error('[boot] fatal', err);
  document.body.innerHTML = `<pre style="color:#fff;padding:24px;white-space:pre-wrap">Aurora shell failed to start:\n${err?.stack || err}</pre>`;
});
