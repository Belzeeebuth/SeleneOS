// Settings > Accessibility: Text size, Visual effects.
import { PAGES } from '../lib/index.js';

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
  const { h, t, kit, settings } = pc;
  const cur = Number(settings.get('scale')) || 100;
  let pending = cur;
  const sample = h('div', { class: 'st-text-preview-sample' }, t('a11y.sample'));
  const pct = (v) => (pc.lang === 'fr' ? `${v} %` : `${v}%`);
  const paintSample = () => (sample.style.fontSize = `${(14 * pending) / 100}px`);
  paintSample();
  const apply = kit.button(t('common.apply'), async () => {
    await settings.set('scale', pending);
    apply.disabled = true;
  }, { primary: true, disabled: true });
  const slider = kit.slider({
    min: 100,
    max: 200,
    step: 5,
    value: cur,
    label: t('a11y.textSize'),
    format: pct,
    iconStart: 'text_font_size',
    onInput: (v) => {
      pending = v;
      paintSample();
      apply.disabled = v === (Number(settings.get('scale')) || 100);
    },
  });
  slider.style.width = '360px';
  pc.onDispose(
    settings.on('scale', (v) => {
      pending = Number(v) || 100;
      slider.set(pending);
      paintSample();
      apply.disabled = true;
    }),
  );
  return h(
    'div',
    null,
    h('div', { class: 'st-row st-text-preview', style: { flexDirection: 'column', alignItems: 'stretch', gap: '8px' } }, h('div', { class: 'caption text-2' }, t('a11y.preview')), sample),
    kit.group(null, kit.row({ icon: 'text_font_size', title: t('a11y.textSize'), desc: t('a11y.textSizeDesc'), control: h('div', { class: 'row', style: { gap: '12px' } }, slider, apply) })),
  );
}

async function visualEffects(pc) {
  const { h, t, kit } = pc;
  return h(
    'div',
    null,
    kit.group(
      null,
      kit.settingToggleRow({ icon: 'blur', title: t('pers.transparency'), desc: t('a11y.transparencyDesc'), key: 'transparency', def: true, section: 'transparency' }),
      kit.settingToggleRow({ icon: 'sparkle', title: t('a11y.animations'), desc: t('a11y.animationsDesc'), key: 'animations', def: true, section: 'animations' }),
    ),
  );
}

export default { accessibility, textSize, visualEffects };
