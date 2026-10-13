// Screen sharing picker for getDisplayMedia (main/ipc/browser.js onDisplayMedia): « Écran entier » or one window,
// with thumbnails. « Annuler », Esc or closing the window = the site gets a refusal.
import { h, icon, ui } from './dom.js';
import { shared } from './shared.js';

const open = new Map(); // request id -> close()

export function dropPicker(id) {
  open.get(id)?.();
}

export async function pickSource(bw, tab, p) {
  const t = bw.t;
  const host = (() => {
    try {
      return new URL(p.origin).host;
    } catch {
      return p.origin;
    }
  })();
  let chosen = (p.sources.find((s) => s.kind === 'screen') || p.sources[0])?.id || null;
  const cards = [];
  const card = (s, i) => {
    const label = s.kind === 'screen' ? (p.sources.filter((x) => x.kind === 'screen').length > 1 ? t('share.screenN', { n: i + 1 }) : t('share.screen')) : s.name || t('share.window');
    const el = h(
      'button',
      { class: ['bw-share-card', s.id === chosen && 'selected'], type: 'button', role: 'radio', 'aria-checked': String(s.id === chosen), dataset: { source: s.id, kind: s.kind }, title: label },
      s.thumb ? h('img', { class: 'bw-share-thumb', src: s.thumb, alt: '' }) : h('div', { class: 'bw-share-thumb empty' }, icon(s.kind === 'screen' ? 'desktop' : 'window', { size: 32 })),
      h('div', { class: 'bw-share-name' }, icon(s.kind === 'screen' ? 'desktop' : 'window', { size: 16 }), h('span', null, label)),
    );
    el.addEventListener('click', () => {
      chosen = s.id;
      for (const c of cards) {
        const on = c.dataset.source === chosen;
        c.classList.toggle('selected', on);
        c.setAttribute('aria-checked', String(on));
      }
    });
    el.addEventListener('dblclick', () => el.closest('.dialog')?.querySelector('.dialog-footer .btn.primary')?.click());
    cards.push(el);
    return el;
  };
  const screens = p.sources.filter((s) => s.kind === 'screen');
  const windows = p.sources.filter((s) => s.kind === 'window');
  const body = h(
    'div',
    { class: 'bw-share' },
    h('p', { class: 'body text-2' }, t('share.body', { host })),
    screens.length ? h('div', { class: 'bw-share-group' }, h('div', { class: 'body-strong' }, t('share.screens')), h('div', { class: 'bw-share-grid', role: 'radiogroup' }, screens.map(card))) : null,
    windows.length ? h('div', { class: 'bw-share-group' }, h('div', { class: 'body-strong' }, t('share.windows')), h('div', { class: 'bw-share-grid', role: 'radiogroup' }, windows.map(card))) : null,
  );
  const answer = ui.dialog({
    title: t('share.title'),
    body,
    parent: bw.win,
    width: 620,
    className: 'bw-share-dialog',
    onOpen: (_dlg, done) => open.set(p.id, () => done(null)),
    buttons: [
      { label: t('share.cancel'), value: null },
      { label: t('share.share'), value: 'share', primary: true },
    ],
  });
  const v = await answer;
  open.delete(p.id);
  shared.api.invoke('browser:displayMediaReply', p.id, v === 'share' ? chosen : null).catch(() => {});
}
