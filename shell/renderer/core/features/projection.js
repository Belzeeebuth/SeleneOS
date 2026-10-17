// Super+P: « Projeter » — a small picker on the right of the main screen with the four ways of using several screens
// (Étendre, Dupliquer, Seulement l'écran externe, Seulement l'écran de l'ordinateur). Choosing applies at once and
// is remembered for this set of screens (display:project, main/ipc/display.js). Super+P again / arrows move the
// choice, Enter applies, Échap closes. With one screen it says so and offers Paramètres > Écran.
import { api } from '../api.js';
import { h } from '../ui.js';
import { i18n, t } from '../i18n.js';
import { shell } from '../services.js';
import { registry } from '../registry.js';
import { notify } from '../notify.js';

i18n.extend({
  en: {
    projection: {
      title: 'Project',
      extend: 'Extend',
      extendDesc: 'One big desktop across your screens',
      mirror: 'Duplicate',
      mirrorDesc: 'The same picture on every screen',
      external: 'External screen only',
      externalDesc: 'The computer’s own screen turns off',
      internal: 'Computer screen only',
      internalDesc: 'The external screen turns off',
      single: 'Only one screen is connected. Plug in another screen to extend or duplicate your desktop.',
      settings: 'Display settings',
      failed: 'The screens could not be changed',
    },
  },
  fr: {
    projection: {
      title: 'Projeter',
      extend: 'Étendre',
      extendDesc: 'Un seul grand bureau sur vos écrans',
      mirror: 'Dupliquer',
      mirrorDesc: 'La même image sur chaque écran',
      external: 'Seulement l’écran externe',
      externalDesc: 'L’écran de l’ordinateur s’éteint',
      internal: 'Seulement l’écran de l’ordinateur',
      internalDesc: 'L’écran externe s’éteint',
      single: 'Un seul écran est branché. Branchez un autre écran pour étendre ou dupliquer votre bureau.',
      settings: 'Paramètres d’affichage',
      failed: 'Impossible de changer les écrans',
    },
  },
});

const CSS = `
.proj-panel { position: absolute; top: 12px; right: 12px; width: 340px; max-height: calc(100% - var(--wa-bottom, 48px) - 24px); overflow: auto;
  display: flex; flex-direction: column; gap: 6px; padding: 18px 14px; border-radius: var(--radius-overlay, 12px);
  background: var(--flyout-bg, var(--bg-elevated, #20232e)); color: var(--text, #fff); border: 1px solid var(--window-stroke, rgba(255,255,255,.1));
  box-shadow: var(--shadow-flyout, 0 16px 48px rgba(0,0,0,.4)); backdrop-filter: blur(var(--blur, 40px)) saturate(160%); z-index: 50;
  animation: proj-in 180ms var(--ease, ease-out); }
@keyframes proj-in { from { opacity: 0; transform: translateX(24px); } to { opacity: 1; transform: none; } }
.proj-panel h2 { font: 600 16px/1.3 var(--font-display, inherit); margin: 0 6px 8px; }
.proj-opt { display: flex; align-items: center; gap: 14px; padding: 10px; border-radius: 8px; border: 1px solid transparent; background: transparent;
  color: inherit; text-align: left; font: inherit; cursor: default; }
.proj-opt:hover { background: var(--subtle-hover, rgba(255,255,255,.06)); }
.proj-opt:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.proj-opt.current { background: var(--subtle-selected, rgba(255,255,255,.09)); border-color: color-mix(in srgb, var(--accent) 55%, transparent); }
.proj-opt b { display: block; font-weight: 600; font-size: 14px; }
.proj-opt span { display: block; font-size: 12px; opacity: .72; margin-top: 2px; }
.proj-pic { flex: none; width: 64px; height: 40px; position: relative; }
.proj-pic i { position: absolute; top: 6px; width: 30px; height: 22px; border-radius: 3px; border: 2px solid currentColor; box-sizing: border-box; }
.proj-pic i.a { left: 0; } .proj-pic i.b { left: 32px; }
.proj-pic i.fill { background: color-mix(in srgb, var(--accent) 70%, transparent); border-color: var(--accent); }
.proj-pic i.dim { opacity: .35; border-style: dashed; }
.proj-pic.mirror i.b { left: 6px; top: 12px; }
.proj-single { font-size: 13px; line-height: 1.5; margin: 0 6px; opacity: .85; }
.proj-link { margin: 10px 6px 0; align-self: flex-start; background: none; border: 0; color: var(--accent-text, var(--accent)); font: inherit; font-size: 13px; padding: 4px 0; }
`;

const OPTIONS = [
  { id: 'extend', pic: ['fill', 'fill'] },
  { id: 'mirror', pic: ['fill', 'fill'], cls: 'mirror' },
  { id: 'external', pic: ['dim', 'fill'] },
  { id: 'internal', pic: ['fill', 'dim'] },
];

let panel = null;

function close() {
  if (!panel) return;
  panel.remove();
  panel = null;
}

async function open() {
  if (panel) return cycle();
  if (!document.getElementById('proj-css')) document.head.appendChild(h('style', { id: 'proj-css' }, CSS));
  const st = await api.invoke('display:status').catch(() => null);
  const outputs = (st?.outputs || []).filter((o) => !o.readOnly);
  const host = document.getElementById('overlays') || document.body;
  panel = h('div', { class: 'proj-panel', role: 'dialog', 'aria-label': t('projection.title'), tabindex: '-1' });
  panel.appendChild(h('h2', {}, t('projection.title')));
  if (outputs.length < 2) {
    panel.appendChild(h('p', { class: 'proj-single' }, t('projection.single')));
    panel.appendChild(
      h('button', { class: 'proj-link', type: 'button', onclick: () => (close(), registry.launch('settings', { page: 'display' })) }, t('projection.settings')),
    );
  } else {
    const current = st?.layout?.mode || 'extend';
    for (const o of OPTIONS) {
      const b = h(
        'button',
        { class: `proj-opt${o.id === current ? ' current' : ''}`, type: 'button', 'data-mode': o.id, 'aria-pressed': String(o.id === current), onclick: () => choose(o.id) },
        h('div', { class: `proj-pic ${o.cls || ''}` }, h('i', { class: `a ${o.pic[0]}` }), h('i', { class: `b ${o.pic[1]}` })),
        h('div', {}, h('b', {}, t(`projection.${o.id}`)), h('span', {}, t(`projection.${o.id}Desc`))),
      );
      panel.appendChild(b);
    }
  }
  panel.addEventListener('keydown', (e) => {
    const opts = [...panel.querySelectorAll('.proj-opt')];
    const i = opts.indexOf(document.activeElement);
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowDown' && opts.length) opts[(i + 1) % opts.length].focus();
    else if (e.key === 'ArrowUp' && opts.length) opts[(i - 1 + opts.length) % opts.length].focus();
    else return;
    e.preventDefault();
    e.stopPropagation();
  });
  panel.addEventListener('focusout', () =>
    setTimeout(() => {
      if (panel && !panel.contains(document.activeElement)) close();
    }, 0),
  );
  host.appendChild(panel);
  (panel.querySelector('.proj-opt.current') || panel.querySelector('button') || panel).focus();
}

function cycle() {
  const opts = [...panel.querySelectorAll('.proj-opt')];
  if (!opts.length) return;
  const i = opts.indexOf(document.activeElement);
  opts[(i + 1) % opts.length].focus();
}

async function choose(mode) {
  close();
  try {
    await api.invoke('display:project', mode);
  } catch (err) {
    notify({ title: t('projection.failed'), body: err?.message || '', appId: 'settings' });
    console.error('[projection]', err);
  }
}

export function mount(ctx) {
  shell.on('projection:toggle', () => (panel && !panel.querySelector('.proj-opt') ? close() : open()));
  shell.on('projection:close', close);
  // the picker closes when the screen locks or another shell surface opens
  shell.on('lock', close);
  ctx.projection = { open, close, choose };
}
