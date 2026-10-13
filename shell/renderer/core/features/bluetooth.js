// Bluetooth pairing dialog (bluetooth track). The session's pairing agent (main/ipc/bluetooth.js ->
// helpers/aurora-bluetooth) sends 'bluetooth:agent' requests; this feature asks the person with a Selene dialog
// wherever they are (Paramètres open or not) and answers with 'bluetooth:agentReply'.
//   confirm   « Le code 123456 s'affiche-t-il sur l'appareil ? »     Oui, associer / Non
//   pin       PIN to type (old keyboards, game controllers)          passkey: 6 digits
//   display-* code to type on the device (no answer needed)          authorize: the device asks to pair
//   cancel    BlueZ gave up: the open dialog closes
const STRINGS = {
  en: {
    btagent: {
      title: 'Pair “{name}”',
      confirm: 'Is the code {code} shown on the device?',
      confirmHint: 'If it is the same code, confirm on the device too.',
      yes: 'Yes, pair',
      no: 'No',
      pin: 'Enter the PIN code of the device',
      pinHint: 'Often 0000 or 1234, or written in its manual.',
      passkey: 'Enter the code shown on the device',
      display: 'Type {code} on the device, then press Enter.',
      authorize: '“{name}” wants to pair with this computer. Allow it?',
      allow: 'Allow',
      refuse: 'Decline',
      pair: 'Pair',
      cancel: 'Cancel',
      close: 'Close',
      unknown: 'Bluetooth device',
      invalidPin: 'Use digits and letters only (16 at most).',
      invalidPasskey: 'The code has 6 digits at most.',
    },
  },
  fr: {
    btagent: {
      title: 'Associer « {name} »',
      confirm: 'Le code {code} s’affiche-t-il sur l’appareil ?',
      confirmHint: 'Si c’est le même code, confirmez aussi sur l’appareil.',
      yes: 'Oui, associer',
      no: 'Non',
      pin: 'Saisissez le code PIN de l’appareil',
      pinHint: 'Souvent 0000 ou 1234, ou indiqué dans sa notice.',
      passkey: 'Saisissez le code affiché sur l’appareil',
      display: 'Tapez {code} sur l’appareil, puis appuyez sur Entrée.',
      authorize: '« {name} » souhaite s’associer à cet ordinateur. L’autoriser ?',
      allow: 'Autoriser',
      refuse: 'Refuser',
      pair: 'Associer',
      cancel: 'Annuler',
      close: 'Fermer',
      unknown: 'Appareil Bluetooth',
      invalidPin: 'Utilisez seulement des chiffres et des lettres (16 au maximum).',
      invalidPasskey: 'Le code compte 6 chiffres au maximum.',
    },
  },
};

const KIND_ICONS = { headphones: 'headphones', headset: 'headphones', speaker: 'speaker-high', mouse: 'cursor', keyboard: 'keyboard', gamepad: 'game-controller', phone: 'device-mobile', computer: 'laptop', tablet: 'device-tablet', printer: 'printer' };

let ctx = null;
let open = null; // { req, layer }

function codeBox(code) {
  const { h } = ctx;
  return h('div', { class: 'bt-code', style: { font: '600 32px/40px var(--font-display)', letterSpacing: '0.12em', textAlign: 'center', padding: 'var(--sp-4) 0', fontVariantNumeric: 'tabular-nums', color: 'var(--text)' } }, String(code).replace(/^(\d{3})(\d{3})$/, '$1 $2'));
}

async function ask(r) {
  const { h, ui, t, api } = ctx;
  const name = r.name || t('btagent.unknown');
  const head = h(
    'div',
    { style: { display: 'flex', alignItems: 'center', gap: 'var(--sp-3)', marginBottom: 'var(--sp-2)' } },
    h('span', { style: { display: 'inline-flex', width: '40px', height: '40px', alignItems: 'center', justifyContent: 'center', borderRadius: 'var(--r)', background: 'var(--accent-subtle)', color: 'var(--accent-text)' } }, ui.icon(KIND_ICONS[r.deviceKind] || 'bluetooth', { size: 22 })),
    h('div', { class: 'caption', style: { color: 'var(--text-2)' } }, r.address || ''),
  );
  const reply = (accept, value) => api.invoke('bluetooth:agentReply', { req: r.req, accept, value }).catch(() => null);
  let body;
  let buttons;
  let input = null;
  let hint = null;
  if (r.kind === 'confirm') {
    body = h('div', { class: 'bt-agent', style: { minWidth: '360px' } }, head, h('div', null, t('btagent.confirm', { code: r.passkey })), codeBox(r.passkey), h('div', { class: 'caption', style: { color: 'var(--text-2)' } }, t('btagent.confirmHint')));
    buttons = [
      { label: t('btagent.yes'), value: 'yes', primary: true },
      { label: t('btagent.no'), value: null },
    ];
  } else if (r.kind === 'pin' || r.kind === 'passkey') {
    input = h('input', { class: 'input', type: 'text', inputmode: r.kind === 'passkey' ? 'numeric' : 'text', maxlength: r.kind === 'passkey' ? 6 : 16, autocomplete: 'off', spellcheck: false, style: { width: '100%' }, 'aria-label': t(`btagent.${r.kind}`) });
    hint = h('div', { class: 'caption', style: { color: 'var(--text-2)', minHeight: '16px' } }, r.kind === 'pin' ? t('btagent.pinHint') : '');
    // typing again clears the « invalid » message shown by _validate
    input.addEventListener('input', () => {
      if (!input.classList.contains('invalid')) return;
      input.classList.remove('invalid');
      hint.textContent = r.kind === 'pin' ? t('btagent.pinHint') : '';
      hint.style.color = 'var(--text-2)';
    });
    body = h('div', { class: 'bt-agent field', style: { minWidth: '360px', margin: 0 } }, head, h('label', null, t(`btagent.${r.kind}`)), input, hint);
    buttons = [
      { label: t('btagent.pair'), value: 'yes', primary: true },
      { label: t('btagent.cancel'), value: null },
    ];
  } else if (r.kind === 'authorize') {
    body = h('div', { class: 'bt-agent', style: { minWidth: '360px' } }, head, h('div', null, t('btagent.authorize', { name })));
    buttons = [
      { label: t('btagent.allow'), value: 'yes', primary: true },
      { label: t('btagent.refuse'), value: null },
    ];
  } else {
    // display-pin / display-passkey: just show the code to type on the device
    body = h('div', { class: 'bt-agent', style: { minWidth: '360px' } }, head, h('div', null, t('btagent.display', { code: r.passkey })), codeBox(r.passkey));
    buttons = [{ label: t('btagent.close'), value: null, primary: true }];
  }
  const v = await ui.dialog({
    title: t('btagent.title', { name }),
    body,
    buttons,
    className: 'bt-agent-dialog',
    onOpen: (dlg) => {
      open = { req: r.req, layer: dlg.closest('.dialog-layer') || dlg.parentElement };
      if (input) {
        dlg._validate = () => {
          const ok = r.kind === 'pin' ? /^[0-9A-Za-z]{1,16}$/.test(input.value) : /^[0-9]{1,6}$/.test(input.value);
          if (!ok) {
            hint.textContent = t(r.kind === 'pin' ? 'btagent.invalidPin' : 'btagent.invalidPasskey');
            hint.style.color = 'var(--danger)';
            input.classList.add('invalid');
          }
          return ok;
        };
        setTimeout(() => input.focus(), 40);
      }
    },
  });
  open = null;
  if (r.req && !String(r.kind).startsWith('display')) reply(v === 'yes', v === 'yes' && input ? input.value : '');
}

function closeOpen(req) {
  if (!open || (req && open.req !== req)) return;
  open.layer?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
}

export function mount(c) {
  ctx = c;
  c.i18n.extend(STRINGS);
  const queue = [];
  let running = false;
  const pump = async () => {
    if (running) return;
    running = true;
    while (queue.length) {
      const r = queue.shift();
      try {
        await ask(r);
      } catch (err) {
        console.error('[bluetooth] pairing dialog failed', err);
      }
    }
    running = false;
  };
  c.api.on('bluetooth:agent', (r) => {
    if (!r) return;
    if (r.kind === 'cancel') {
      const i = queue.findIndex((x) => x.req === r.req);
      if (i >= 0) queue.splice(i, 1);
      return closeOpen(r.req);
    }
    // a new code replaces the code shown before (display-passkey is sent again as keys are typed)
    if (String(r.kind).startsWith('display') && open && !open.req) closeOpen();
    queue.push(r);
    pump();
  });
  c.bluetoothAgent = { closeOpen };
}
