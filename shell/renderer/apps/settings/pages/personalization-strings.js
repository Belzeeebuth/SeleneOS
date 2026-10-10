// Personalization pages (area A) — shared helpers. Their strings ("pz.*", English + French) live in the
// Settings app dictionary apps/settings/i18n.json; later areas (B1–B3) add theirs there too.
import { PAGES } from '../lib/index.js';

/** Kept for the page modules that call it: strings now come from apps/settings/i18n.json. */
export function ensureStrings() {}

/** Placeholder page body for a personalization area that is not built yet (replaced by areas B1–B3). */
export function comingSoon(pc, pageId, { keys = [] } = {}) {
  const { h, t, kit, icon, L } = pc;
  return h(
    'div',
    { class: 'pz-stub', dataset: { stub: pageId, keys: keys.join(' ') } },
    kit.infobar({ kind: 'info', title: t('pz.comingSoon'), message: t('pz.comingSoonDesc') }),
    h('div', { class: 'st-empty pz-stub-empty' }, icon(PAGES[pageId]?.icon || 'paint_brush_sparkle', { size: 40 }), h('div', { class: 'body-large' }, pc.pageTitle(pageId)), h('div', { class: 'text-2' }, L(PAGES[pageId]?.desc) || '')),
    kit.related([{ icon: 'window_brush', title: t('pz.relatedDesigner'), desc: t('pz.relatedDesignerDesc'), onClick: () => pc.go('themeDesigner') }]),
  );
}
