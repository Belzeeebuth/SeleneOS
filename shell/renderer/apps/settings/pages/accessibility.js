// Settings > Accessibility: Text size, Visual effects, Screen reader.
// The text size / UI scale / transparency / motion controls are the same builders as Personalization >
// Theme designer (pages/personalization-designer.js), so each setting has a single source of truth.
import { PAGES } from '../lib/index.js';
import { textSizeControls, motionControls, transparencyControls } from './personalization-designer.js';
import { comboKeys } from '../../../core/shortcuts.js';

async function accessibility(pc) {
  const { h, t, kit, L } = pc;
  const sub = (id) => kit.row({ icon: PAGES[id].icon, title: L(PAGES[id].title), desc: L(PAGES[id].desc), onClick: () => pc.go(id) });
  return h(
    'div',
    null,
    kit.group(t('a11y.vision'), sub('textSize'), sub('visualEffects'), sub('screenReader')),
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

// Lecteur d'écran (Orca): the switch follows settings.screenReader.enabled, core/features/screenreader.js starts / stops
// Orca; rate and voice are applied by restarting it (main/ipc/screenreader.js).
async function screenReader(pc) {
  const { h, t, kit } = pc;
  pc.ui.loadCss('app://shell/apps/settings/pages/personalization-shell.css');
  const st = await pc.api.invoke('screenreader:status').catch(() => ({ available: false }));
  const conf = () => pc.settings.get('screenReader') || {};
  const lang = pc.lang;
  const langName = (() => {
    try {
      return new Intl.DisplayNames([lang], { type: 'language' }).of(lang);
    } catch {
      return lang;
    }
  })();

  const main = kit.settingToggleRow({ icon: 'chat-centered-text', title: pc.pageTitle('screenReader'), desc: t('sr.toggleDesc'), key: 'screenReader.enabled', section: 'toggle' });
  if (!st.available) main.querySelector('input[role="switch"]')?.setAttribute('disabled', '');
  const combo = pc.shell?.hotkeys?.combos?.().screenReader ?? 'Super+Alt+S';
  const keys = comboKeys(combo, lang);
  const keyCaps = combo ? h('span', { class: 'pzs-keys', 'aria-label': keys.join(' + ') }, keys.map((k) => h('kbd', null, k))) : h('span', { class: 'pzs-keys off caption text-2' }, t('common.off'));
  const shortcut = kit.row({ icon: 'keyboard', title: t('sr.shortcutTitle'), desc: t('sr.shortcutDesc'), control: keyCaps, onClick: () => pc.go('shortcuts'), section: 'shortcut' });

  // speech rate: Orca's 0–100 scale (50 = normal)
  const rateVal = () => (Number.isFinite(Number(conf().rate)) ? Math.max(0, Math.min(100, Math.round(Number(conf().rate)))) : 50);
  const fmt = (v) => (Number(v) === 50 ? t('sr.normal') : String(v));
  const rate = kit.slider({ min: 0, max: 100, step: 5, value: rateVal(), format: fmt, label: t('sr.rate'), onChange: (v) => pc.settings.set('screenReader.rate', Number(v)) });
  const rateRow = kit.row({ icon: 'gauge', title: t('sr.rate'), desc: t('sr.rateDesc'), control: rate, section: 'rate' });

  // voice: automatic (the display language) or one of speech-dispatcher's voices of that language
  const voices = await pc.api.invoke('screenreader:voices', lang).catch(() => []);
  const cur = typeof conf().voice === 'string' ? conf().voice : '';
  // speech-dispatcher names its voices in English (« French (Belgium) »): show them in the display language from
  // their language code (« Français (Belgique) »), with the voice's own name only when two share one code
  const voiceLabels = voices.map((v) => {
    try {
      const s = new Intl.DisplayNames([lang], { type: 'language', languageDisplay: 'standard' }).of(v.lang);
      return s && s.toLowerCase() !== String(v.lang).toLowerCase() ? s.charAt(0).toLocaleUpperCase(lang) + s.slice(1) : v.name;
    } catch {
      return v.name;
    }
  });
  const voiceLabel = (i) => (voiceLabels.filter((l) => l === voiceLabels[i]).length > 1 ? `${voiceLabels[i]} – ${voices[i].name}` : voiceLabels[i]);
  const options = [{ value: '', label: `${t('sr.voiceAuto')} (${langName})` }, ...voices.map((v, i) => ({ value: v.name, label: voiceLabel(i) }))];
  if (cur && !voices.some((v) => v.name === cur)) options.push({ value: cur, label: cur });
  const voice = kit.combo({ options, value: cur, width: 220, label: t('sr.voice'), onChange: (v) => pc.settings.set('screenReader.voice', v) });
  const voiceRow = kit.row({ icon: 'speaker-high', title: t('sr.voice'), desc: t('sr.voiceDesc'), control: voice, section: 'voice' });

  const testBtn = kit.button(t('sr.test'), () => kit.busy(testBtn, () => pc.api.invoke('screenreader:test', { lang, rate: rateVal(), voice: conf().voice || '', text: t('sr.sample') }).catch((err) => pc.toastError(err))), { icon: 'play' });
  testBtn.classList.add('sr-test');
  const testRow = kit.row({ icon: 'play-circle', title: t('sr.testTitle'), desc: t('sr.testDesc'), control: testBtn, section: 'test' });

  const tips = kit.group(
    t('sr.tipsTitle'),
    kit.row({ icon: 'keyboard', title: t('sr.tipMove') }),
    kit.row({ icon: 'chat-centered-text', title: t('sr.tipOrca') }),
  );
  const off = pc.settings.on('screenReader', () => {
    rate.set(rateVal());
    voice.setValue(typeof conf().voice === 'string' ? conf().voice : '');
  });
  pc.onDispose(off);
  return h(
    'div',
    { class: 'st-screenreader' },
    st.available ? null : kit.infobar({ kind: 'warning', message: t('sr.missing') }),
    kit.group(null, main, shortcut),
    kit.group(t('sr.voiceGroup'), rateRow, voiceRow, testRow),
    tips,
  );
}

export default { accessibility, textSize, visualEffects, screenReader };
