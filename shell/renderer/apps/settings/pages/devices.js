// Settings > Bluetooth & devices: Bluetooth status, Mouse, Typing, Printers & scanners.
import { PAGES } from '../lib/index.js';

async function bluetoothAdapters(pc) {
  const ents = await pc.api.invoke('fs:list', '/sys/class/bluetooth', { hidden: true }).catch(() => []);
  return (ents || []).map((e) => e.name).filter((n) => /^hci\d+$/.test(n));
}

async function bluetooth(pc) {
  const { h, t, kit, L } = pc;
  const adapters = await bluetoothAdapters(pc);
  const sub = (id) => kit.row({ icon: PAGES[id].icon, title: L(PAGES[id].title), desc: L(PAGES[id].desc), onClick: () => pc.go(id) });
  return h(
    'div',
    null,
    kit.group(
      null,
      kit.row({
        icon: adapters.length ? 'bluetooth' : 'bluetooth_disabled',
        title: t('dev.bluetooth'),
        desc: adapters.length ? t('dev.btAdapterNoSupport', { name: adapters[0] }) : t('dev.btNone'),
        control: h('span', { class: 'st-pill' }, adapters.length ? t('dev.btUnsupported') : t('dev.btUnavailable')),
      }),
    ),
    kit.group(t('dev.devices'), sub('mouse'), sub('typing'), sub('printers')),
  );
}

async function mouse(pc) {
  const { h, t, kit, api } = pc;
  const st = await pc.tryInvoke('input:mouse');
  if (!st?.available) return h('div', null, kit.infobar({ kind: 'info', title: t('dev.noMouseTitle'), message: t('dev.noMouse') }));
  // libinput speed -1..1 shown like Windows: 1..20, 10 = default
  const toUi = (s) => Math.round(((Number(s) || 0) + 1) * 9.5 + 0.5);
  const fromUi = (v) => Math.round(((v - 0.5) / 9.5 - 1) * 100) / 100;
  let tmr = null;
  return h(
    'div',
    null,
    kit.group(
      null,
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
    ),
    st.devices?.length ? kit.group(t('dev.pointers'), ...st.devices.map((d) => kit.row({ icon: /tablet|touch/i.test(d) ? 'tablet' : 'cursor', title: d }))) : null,
  );
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

async function printers(pc) {
  const { h, t, icon } = pc;
  return h('div', { class: 'st-empty' }, icon('print', { size: 40 }), h('div', { class: 'body-large' }, t('dev.noPrinters')), h('div', null, t('dev.noPrintersDesc')));
}

export default { bluetooth, mouse, typing, printers };
