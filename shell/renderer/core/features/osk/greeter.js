// « Clavier visuel » on the sign-in screen (core/greeter/greeter.js, Accessibilité menu of the tray): someone without a
// working keyboard can type the user name and the password. The keys edit the sign-in screen's own fields directly
// (execCommand insertText / delete, caret moves, Enter submits the form): nothing goes through IPC or the main
// process, nothing is stored, no key sound, and the panel itself shows no typed text, so the password is never readable
// by anything else. The layout follows the sign-in screen's keyboard layout (greeter:keyboard ids: 'fr', 'ch:fr'…).
//
//   const k = greeterKeyboard({ ls, layout: () => 'fr', onClose });   k.show(); k.hide(); k.setLayout(id); k.keyboard
import { OnScreenKeyboard, OSK_CSS, cssReady } from './keyboard.js';
import { layoutFor } from './layouts.js';
import { ui } from '../../ui.js';

const editable = (el) => !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && !el.disabled && !el.readOnly;

export function greeterKeyboard({ ls, layout, onClose }) {
  ui.loadCss(OSK_CSS);
  let wanted = false;

  function field() {
    if (ls.stage === 'curtain') ls.reveal?.();
    ls._bumpIdle?.(); // typing on the keyboard is activity (the sign-in view stays up)
    let el = document.activeElement;
    if (!editable(el)) {
      ls.focus?.();
      el = document.activeElement;
    }
    return editable(el) ? el : null;
  }
  function insert(el, text) {
    if (!document.execCommand('insertText', false, text)) {
      const s = el.selectionStart ?? el.value.length;
      el.setRangeText(text, s, el.selectionEnd ?? s, 'end');
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    }
  }
  function caret(el, key, extend) {
    const len = el.value.length;
    const s = el.selectionStart ?? len;
    const e = el.selectionEnd ?? len;
    const dir = el.selectionDirection === 'backward' ? 'backward' : 'forward';
    let head = dir === 'backward' ? s : e;
    const anchor = dir === 'backward' ? e : s;
    if (key === 'ArrowLeft') head = !extend && s !== e ? s : Math.max(0, head - 1);
    else if (key === 'ArrowRight') head = !extend && s !== e ? e : Math.min(len, head + 1);
    else if (key === 'Home' || key === 'ArrowUp') head = 0;
    else if (key === 'End' || key === 'ArrowDown') head = len;
    if (extend) el.setSelectionRange(Math.min(anchor, head), Math.max(anchor, head), head < anchor ? 'backward' : 'forward');
    else el.setSelectionRange(head, head);
  }
  function moveFocus(back) {
    const root = ls.el;
    const list = [...root.querySelectorAll('input, button, [tabindex]')].filter((x) => x.tabIndex >= 0 && !x.disabled && x.offsetParent !== null && !x.closest('[inert]'));
    if (!list.length) return;
    const i = list.indexOf(document.activeElement);
    const next = list[(i + (back ? -1 : 1) + list.length) % list.length];
    next.focus();
  }
  function deliver(ev) {
    if (ev.type === 'hold' || ev.type === 'super') return;
    const el = field();
    if (ev.type === 'text') {
      if (!el) return;
      if (ev.mods?.ctrl || ev.mods?.alt || ev.mods?.super) {
        if (ev.mods.ctrl && /^a$/i.test(ev.text)) el.select();
        return;
      }
      insert(el, ev.text);
      return;
    }
    if (ev.type !== 'key') return;
    switch (ev.key) {
      case 'Backspace':
        if (el && !document.execCommand('delete')) {
          const s = el.selectionStart ?? 0;
          const e = el.selectionEnd ?? 0;
          if (s !== e || s > 0) {
            el.setRangeText('', s === e ? s - 1 : s, e, 'end');
            el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
          }
        }
        break;
      case 'Delete':
        if (el) document.execCommand('forwardDelete');
        break;
      case 'Enter':
        if (el?.form) el.form.requestSubmit();
        break;
      case 'Tab':
        moveFocus(!!ev.mods?.shift);
        break;
      case 'Escape':
        // the sign-in screen's own key handler (back to the clock)
        (document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
        break;
      default:
        if (el) caret(el, ev.key, !!ev.mods?.shift);
        break;
    }
  }

  const kb = new OnScreenKeyboard({
    layout: layoutFor(layout?.()),
    deliver,
    sound: () => false,
    mode: 'docked',
    size: 'medium',
    bottom: () => 16,
    className: 'osk-greeter',
    themeScope: 'dark',
    chrome: { close: () => onClose?.(), settings: null, dock: null, move: false },
  });
  document.body.append(kb.el);
  // the sign-in card stays above the keyboard (osk.css: body.osk-open .lk-center)
  const fit = () => document.body.style.setProperty('--osk-reserve', `${Math.max(0, Math.round(window.innerHeight - kb.el.offsetTop))}px`);
  window.addEventListener('resize', () => kb.visible && fit());
  // (also once osk.css has loaded and whenever the keyboard changes size)
  try {
    new ResizeObserver(() => kb.visible && fit()).observe(kb.el);
  } catch {}
  return {
    keyboard: kb,
    show() {
      wanted = true;
      cssReady().then(() => {
        if (!wanted) return;
        kb.show();
        document.body.classList.add('osk-open');
        fit();
        field();
      });
    },
    hide() {
      wanted = false;
      kb.hide();
      document.body.classList.remove('osk-open');
    },
    get visible() {
      return kb.visible;
    },
    setLayout(id) {
      kb.setLayout(layoutFor(id));
    },
  };
}
