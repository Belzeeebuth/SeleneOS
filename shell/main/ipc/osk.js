'use strict';
// « Clavier visuel » (on-screen keyboard, core/features/osk.js): real key events for the shell's own fields.
//
//   send osk:input (target, events)
//     target  { shell: true } -> the shell page (its focused element) | { webview: <webContentsId> } -> a <webview> of
//             the shell (Navigateur tab, Courrier…) | null -> no element has the DOM focus: the <webview> page that has
//             Chromium's focus, else the shell page
//     events  [{ type: 'keyDown' | 'char' | 'keyUp', keyCode, modifiers: ['shift'|'control'|'alt'|'meta'] }]
//             at most 24 per message; keyCode is one of NAMED or a single character (code point ≥ U+0020)
//   Each event goes through webContents.sendInputEvent(), so the page receives trusted keydown / keypress / beforeinput
//   / input / keyup events, exactly as from a physical keyboard: inputs, textareas, contenteditable (Notes), CodeMirror
//   (Éditeur de code) and xterm.js (Terminal) all type, and the system shortcuts (main/lib/hotkeys.js, Alt+Tab, Super)
//   see them in before-input-event. Only the shell window may send; a webview target must be a guest of that window.
//   X11 application windows are typed into by aurora-xwm through XTest instead (main/ipc/xwin.js 'osk-key').
//   osk:status -> { ok: true }   (the renderer checks the backend is there)
const NAMED = new Set([
  'Backspace', 'Delete', 'Tab', 'Enter', 'Escape', 'Space', 'Insert', 'Home', 'End', 'PageUp', 'PageDown',
  'Up', 'Down', 'Left', 'Right', 'Shift', 'Control', 'Alt', 'Meta', 'AltGr',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
]);
const TYPES = new Set(['keyDown', 'char', 'keyUp']);
const MODIFIERS = new Set(['shift', 'control', 'alt', 'meta', 'isAutoRepeat']);
const MAX_EVENTS = 24;

/** One event as sendInputEvent wants it, or null when it is not allowed. */
function cleanEvent(ev) {
  if (!ev || typeof ev !== 'object' || !TYPES.has(ev.type) || typeof ev.keyCode !== 'string') return null;
  const code = ev.keyCode;
  const chars = [...code];
  // a char event may carry '\r' (Enter) or '\t'; key events a named key or one printable character
  const okChar = chars.length === 1 && (code.codePointAt(0) >= 0x20 || (ev.type === 'char' && (code === '\r' || code === '\t'))) && code.codePointAt(0) !== 0x7f;
  if (!NAMED.has(code) && !okChar) return null;
  const mods = Array.isArray(ev.modifiers) ? [...new Set(ev.modifiers.filter((m) => MODIFIERS.has(m)))] : [];
  return { type: ev.type, keyCode: code, modifiers: mods };
}

function register(api) {
  if (api.env?.mode !== 'shell') return;
  const { webContents } = require('electron');

  function targetOf(sender, target) {
    const w = api.getMainWindow();
    if (!w || w.isDestroyed()) return null;
    const host = w.webContents;
    if (sender && sender !== host) return null; // only the shell page itself
    const guestOf = (wc) => (wc && !wc.isDestroyed() && wc.getType?.() === 'webview' && wc.hostWebContents === host ? wc : null);
    if (target && typeof target === 'object' && Number.isInteger(target.webview)) return guestOf(webContents.fromId(target.webview));
    if (target && typeof target === 'object' && target.shell === true) return host;
    // The shell page's DOM focus can sit on nothing while Chromium's focus is in a <webview> page (a press on the keyboard
    // moved it to the shell page): the focused guest page of this window is the target then.
    return guestOf(webContents.getFocusedWebContents?.()) || host;
  }

  api.on('osk:input', (target, events, event) => {
    const wc = targetOf(event?.sender, target);
    if (!wc || !Array.isArray(events)) return;
    // A <webview> guest only types when it is the focused page (a press on the keyboard may have moved Chromium's
    // focus to the shell page; the webview element itself kept the DOM focus).
    if (wc.getType?.() === 'webview' && !wc.isFocused?.()) {
      try {
        wc.focus();
      } catch {}
    }
    for (const raw of events.slice(0, MAX_EVENTS)) {
      const ev = cleanEvent(raw);
      if (!ev) continue;
      try {
        wc.sendInputEvent(ev);
      } catch (err) {
        console.warn('[osk] sendInputEvent failed:', err.message);
      }
    }
  });
  api.handle('osk:status', () => ({ ok: true }));
}

module.exports = register;
module.exports.cleanEvent = cleanEvent;
