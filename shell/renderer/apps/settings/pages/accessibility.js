// Settings > Accessibility: Text size, Visual effects.
// The text size / UI scale / transparency / motion controls are the same builders as Personalization >
// Theme designer (pages/personalization-designer.js), so each setting has a single source of truth.
import { PAGES } from '../lib/index.js';
import { textSizeControls, motionControls, transparencyControls } from './personalization-designer.js';

async function accessibility(pc) {
  const { h, t, kit, L } = pc;
  const sub = (id) => kit.row({ icon: PAGES[id].icon, title: L(PAGES[id].title), desc: L(PAGES[id].desc), onClick: () => pc.go(id) });
  return h(
    'div',
    null,
    kit.group(t('a11y.vision'), sub('textSize'), sub('visualEffects')),
    kit.group(
      t('a11y.quick'),
      kit.settingToggleRow({ icon: 'sparkle', title: t('a11y.animations'), desc: t('a11y.animationsDesc'), key: 'animations', def: true }),
      kit.settingToggleRow({ icon: 'blur', title: t('pers.transparency'), desc: t('a11y.transparencyDesc'), key: 'transparency', def: true }),
    ),
    kit.related([
      { icon: 'desktop', title: pc.pageTitle('display'), desc: t('a11y.relatedDisplay'), onClick: () => pc.go('display') },
      { icon: 'cursor', title: pc.pageTitle('mouse'), desc: t('a11y.relatedMouse'), onClick: () => pc.go('mouse') },
      { icon: 'keyboard', title: pc.pageTitle('keyboard'), desc: t('a11y.relatedKeyboard'), onClick: () => pc.go('keyboard') },
    ]),
  );
}

async function textSize(pc) {
  const { h, kit } = pc;
  pc.ui.loadCss('app://shell/apps/settings/pages/personalization.css');
  const tx = textSizeControls(pc, { sample: true });
  return h(
    'div',
    null,
    h('div', { class: 'st-text-preview' }, h('div', { class: 'caption text-2' }, pc.t('a11y.preview')), tx.sample),
    kit.group(null, tx.sizeRow, tx.fontRow),
    kit.group(null, tx.scaleRow),
  );
}

async function visualEffects(pc) {
  const { h, kit } = pc;
  pc.ui.loadCss('app://shell/apps/settings/pages/personalization.css');
  const tr = transparencyControls(pc);
  const mo = motionControls(pc);
  return h('div', null, kit.group(null, tr.toggleRow, tr.levelRow, tr.blurRow), kit.group(null, mo.animationsRow, mo.reducedRow));
}

export default { accessibility, textSize, visualEffects };
