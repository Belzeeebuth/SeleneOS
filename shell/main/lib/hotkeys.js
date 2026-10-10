'use strict';
// System-wide keyboard shortcuts. Keys are captured in the main process for the
// shell window AND every webview (browser tabs), then forwarded to the shell
// renderer as  aurora.on('shell:hotkey', ({combo, repeat}) => ...).
//
// Combos are normalised strings: modifiers in the order Super, Ctrl, Alt, Shift, then the key
// (KeyboardEvent.key, letters upper-cased): "Super", "Super+D", "Alt+Tab", "Alt+Shift+Tab",
// "Ctrl+Alt+Delete", "Ctrl+Shift+Escape", "PrintScreen", "Super+Shift+S", "Alt+F4",
// "Super+ArrowLeft", "Super+Ctrl+ArrowRight", "Super+Ctrl+D", "Alt+Space", "AudioVolumeUp".
// "Alt:up" is sent when Alt is released (commits the Alt+Tab switcher).
// Every combo that includes Super is forwarded (and swallowed); other combos only when listed in SYSTEM.
// Auto-repeated presses are forwarded with repeat=true (the renderer ignores repeats except for
// Alt+Tab cycling and the volume / brightness keys).
//
// A focused <webview> receives its own before-input-event (the embedding shell does not get a
// second one), so each key press is forwarded exactly once.
//
// Alt release: when a keyDown is swallowed here, Chromium also drops every following keyUp on that
// page until the next keyDown — so the Alt release after a swallowed Alt+Tab would never be seen.
// In the shell's own page the switcher combos are therefore forwarded WITHOUT being swallowed (the
// shell renderer cancels the DOM event itself); in webviews they are swallowed and the shell moves
// keyboard focus into its own page at once, so the Alt release arrives there.
const SWITCHER = new Set(['Alt+Tab', 'Alt+Shift+Tab', 'Ctrl+Alt+Tab']);

const SYSTEM = new Set([
  'Alt+Tab', 'Alt+Shift+Tab', 'Ctrl+Alt+Tab', 'Alt+F4', 'Alt+Space', 'Ctrl+Alt+Delete', 'Ctrl+Shift+Escape', 'PrintScreen',
  'Super+D', 'Super+E', 'Super+L', 'Super+I', 'Super+A', 'Super+N', 'Super+S', 'Super+R', 'Super+X',
  'Super+Tab', 'Super+Shift+S', 'Super+M', 'Super+V', 'Super+W', 'Super+Q', 'Super+ArrowLeft', 'Super+ArrowRight',
  'Super+ArrowUp', 'Super+ArrowDown', 'Super+1', 'Super+2', 'Super+3', 'Super+4', 'Super+5',
  'Super+6', 'Super+7', 'Super+8', 'Super+9', 'Super+Period', 'Super+Comma', 'Super+H', 'Super+K', 'Super+P', 'Super+U',
  'AudioVolumeUp', 'AudioVolumeDown', 'AudioVolumeMute', 'BrightnessUp', 'BrightnessDown',
]);

function comboOf(input) {
  const parts = [];
  if (input.meta) parts.push('Super');
  if (input.control) parts.push('Ctrl');
  if (input.alt) parts.push('Alt');
  if (input.shift) parts.push('Shift');
  let key = input.key;
  if (key === ' ') key = 'Space';
  if (key === 'Del') key = 'Delete';
  if (key === 'Esc') key = 'Escape';
  if (key === '.') key = 'Period';
  if (key === ',') key = 'Comma';
  if (key === 'VolumeUp') key = 'AudioVolumeUp';
  if (key === 'VolumeDown') key = 'AudioVolumeDown';
  if (key === 'VolumeMute') key = 'AudioVolumeMute';
  if (key === 'MonBrightnessUp') key = 'BrightnessUp';
  if (key === 'MonBrightnessDown') key = 'BrightnessDown';
  if (key && key.length === 1) key = key.toUpperCase();
  // Super+Shift+digit arrives as the shifted character on some layouts; keep the digit.
  if (input.meta && /^Digit[0-9]$/.test(input.code || '') && !/^[0-9]$/.test(key)) key = input.code.slice(5);
  if (['Control', 'Alt', 'Shift', 'Meta', 'OS', 'Super', 'Hyper'].includes(key)) return parts.join('+');
  return [...parts, key].join('+');
}

function installHotkeys(contents, ipc, mode) {
  if (mode !== 'shell') return;
  let superDown = false;
  let superUsed = false;
  contents.on('before-input-event', (event, input) => {
    const isSuper = input.key === 'Meta' || input.key === 'OS' || input.key === 'Super' || input.code === 'MetaLeft' || input.code === 'MetaRight';
    if (input.type === 'keyDown') {
      if (isSuper) {
        if (!input.isAutoRepeat) {
          superDown = true;
          superUsed = false;
        }
        return;
      }
      if (superDown || input.meta) superUsed = true;
      const combo = comboOf(input);
      if (SYSTEM.has(combo) || (input.meta && combo.startsWith('Super+'))) {
        if (!(SWITCHER.has(combo) && contents.getType?.() !== 'webview')) event.preventDefault();
        ipc.broadcast('shell:hotkey', { combo, repeat: !!input.isAutoRepeat });
      }
    } else if (input.type === 'keyUp') {
      if (isSuper) {
        if (superDown && !superUsed) ipc.broadcast('shell:hotkey', { combo: 'Super' });
        superDown = false;
        superUsed = false;
      }
      if (input.key === 'Alt') ipc.broadcast('shell:hotkey', { combo: 'Alt:up' });
    }
  });
}

module.exports = { installHotkeys, comboOf, SYSTEM, SWITCHER };
