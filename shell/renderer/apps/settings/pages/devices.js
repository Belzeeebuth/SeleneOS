// Settings > Bluetooth & devices: Bluetooth status, Mouse and touchpad, Typing, Printers & scanners.
import { PAGES } from '../lib/index.js';
import { bluetoothPage } from './bluetooth.js';

// Bluetooth part: pages/bluetooth.js (adapter, Mes appareils, Appareils à proximité); the other device pages below it.
async function bluetooth(pc) {
  const { kit, L } = pc;
  const sub = (id) => kit.row({ icon: PAGES[id].icon, title: L(PAGES[id].title), desc: L(PAGES[id].desc), onClick: () => pc.go(id) });
  return bluetoothPage(pc, [sub('mouse'), sub('typing'), sub('printers')]);
}

async function mouse(pc) {
  const { h, t, kit } = pc;
  const [st, tp] = await Promise.all([pc.tryInvoke('input:mouse'), pc.tryInvoke('input:touchpad')]);
  const parts = [];
  if (st?.available) parts.push(mouseGroup(pc, st, tp?.available ? t('tpad.mouse') : null));
  // Touchpad (inputpower track, main/ipc/inputpower.js): only on computers with one (xinput list).
  if (tp?.available) parts.push(touchpadGroup(pc, tp));
  if (!parts.length) return h('div', null, kit.infobar({ kind: 'info', title: t('dev.noMouseTitle'), message: t('dev.noMouse') }));
  if (st?.devices?.length) parts.push(kit.group(t('dev.pointers'), ...st.devices.map((d) => kit.row({ icon: /tablet|touch/i.test(d) ? 'tablet' : 'cursor', title: d }))));
  return h('div', null, parts);
}

function mouseGroup(pc, st, title) {
  const { t, kit, api } = pc;
  // libinput speed -1..1 shown like Windows: 1..20, 10 = default (0); 1 = -1 and 20 = +1 exactly.
  const toUi = (s) => {
    const x = Math.max(-1, Math.min(1, Number(s) || 0));
    return Math.round(x < 0 ? 10 + x * 9 : 10 + x * 10);
  };
  const fromUi = (v) => Math.round((v < 10 ? (v - 10) / 9 : (v - 10) / 10) * 100) / 100;
  let tmr = null;
  return kit.group(
    title,
    kit.row({
      icon: 'cursor_click',
      title: t('dev.primary'),
      desc: t('dev.primaryDesc'),
      section: 'primary',
      control: kit.combo({
        options: [
          { value: 'left', label: t('dev.left') },
          { value: 'right', label: t('dev.right') },
        ],
        value: st.leftHanded ? 'right' : 'left',
        label: t('dev.primary'),
        onChange: (v) => api.invoke('input:setMouse', { leftHanded: v === 'right' }),
      }),
    }),
    kit.row({
      icon: 'cursor',
      title: t('dev.speed'),
      desc: t('dev.speedDesc'),
      section: 'speed',
      control: kit.slider({
        min: 1,
        max: 20,
        value: Math.max(1, Math.min(20, toUi(st.speed))),
        label: t('dev.speed'),
        onInput: (v) => {
          clearTimeout(tmr);
          tmr = setTimeout(() => api.invoke('input:setMouse', { speed: Math.max(-1, Math.min(1, fromUi(v))) }).catch(pc.toastError), 120);
        },
      }),
    }),
  );
}

function touchpadGroup(pc, tp) {
  const { h, t, kit, api } = pc;
  const set = (patch) => api.invoke('input:setTouchpad', patch).catch(pc.toastError);
  const rows = [];
  const dependent = [];
  const toggleRow = (key, icon, section) =>
    kit.row({ icon, title: t(`tpad.${key}`), desc: t(`tpad.${key}Desc`), section, control: kit.toggle({ value: !!tp[key], label: t(`tpad.${key}`), onChange: (v) => set({ [key]: v }) }) });
  const enabledToggle = kit.toggle({
    value: tp.enabled !== false,
    label: t('tpad.enabled'),
    onChange: (v) => {
      for (const r of dependent) r.classList.toggle('disabled', !v);
      set({ enabled: v });
    },
  });
  rows.push(kit.row({ icon: 'hand', title: t('tpad.enabled'), desc: t('tpad.enabledDesc'), section: 'touchpad', control: enabledToggle }));
  dependent.push(toggleRow('tap', 'cursor-click', 'tap'), toggleRow('natural', 'arrows-down-up', 'natural'));
  if (tp.hasScrollSpeed !== false) {
    let tmr = null;
    dependent.push(
      kit.row({
        icon: 'scroll',
        title: t('tpad.scrollSpeed'),
        desc: t('tpad.scrollSpeedDesc'),
        section: 'scrollSpeed',
        control: kit.slider({
          min: 1,
          max: 10,
          value: Math.max(1, Math.min(10, Number(tp.scrollSpeed) || 5)),
          label: t('tpad.scrollSpeed'),
          onInput: (v) => {
            clearTimeout(tmr);
            tmr = setTimeout(() => set({ scrollSpeed: Math.round(v) }), 150);
          },
        }),
      }),
    );
  }
  dependent.push(toggleRow('dwt', 'keyboard', 'dwt'));
  for (const r of dependent) r.classList.toggle('disabled', tp.enabled === false);
  return h('div', { class: 'st-touchpad', dataset: { section: 'touchpadGroup' } }, kit.group(t('tpad.section'), ...rows, ...dependent), h('p', { class: 'st-note caption' }, t('tpad.gestures')));
}

async function typing(pc) {
  const { h, t, kit } = pc;
  const st = await pc.tryInvoke('locale:status');
  const test = h('input', { class: 'input st-type-test', placeholder: t('kbd.testPlaceholder'), 'aria-label': t('kbd.test'), spellcheck: false });
  return h(
    'div',
    null,
    kit.group(
      null,
      kit.row({ icon: 'keyboard', title: t('kbd.layout'), desc: st?.keyboard ? t('dev.currentLayout', { name: st.keyboard }) : t('kbd.layoutDesc'), onClick: () => pc.go('keyboard') }),
      kit.row({ icon: 'text_font', title: t('kbd.test'), desc: t('kbd.testDesc'), control: test }),
      kit.row({ icon: 'local_language', title: pc.pageTitle('language'), desc: t('dev.languageDesc'), onClick: () => pc.go('language') }),
    ),
  );
}

// Printers & scanners: pages/printers.js (module 'printers').

export default { bluetooth, mouse, typing };
