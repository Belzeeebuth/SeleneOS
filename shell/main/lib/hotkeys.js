'use strict';
// System-wide keyboard shortcuts. Keys are captured in the main process for the
// shell window AND every webview (browser tabs), then forwarded to the shell
// renderer as  aurora.on('shell:hotkey', ({combo}) => ...).
//
// Combos are normalised strings like "Super", "Super+D", "Alt+Tab", "Alt+Shift+Tab",
// "Ctrl+Alt+Delete", "Ctrl+Shift+Escape", "PrintScreen", "Super+Shift+S", "Alt+F4",
// "Super+ArrowLeft".
const SYSTEM = new Set([
  'Alt+Tab', 'Alt+Shift+Tab', 'Alt+F4', 'Ctrl+Alt+Delete', 'Ctrl+Shift+Escape', 'PrintScreen',
  'Super+D', 'Super+E', 'Super+L', 'Super+I', 'Super+A', 'Super+N', 'Super+S', 'Super+R', 'Super+X',
  'Super+Tab', 'Super+Shift+S', 'Super+M', 'Super+V', 'Super+W', 'Super+Q', 'Super+ArrowLeft', 'Super+ArrowRight',
  'Super+ArrowUp', 'Super+ArrowDown', 'Super+1', 'Super+2', 'Super+3', 'Super+4', 'Super+5',
  'Super+6', 'Super+7', 'Super+8', 'Super+9', 'Super+Period', 'Super+Comma', 'Super+H', 'Super+K', 'Super+P', 'Super+U',
]);

function comboOf(input) {
  const parts = [];
  if (input.control) parts.push('Ctrl');
  if (input.alt) parts.push('Alt');
  if (input.shift) parts.push('Shift');
  if (input.meta) parts.push('Super');
  let key = input.key;
  if (key === ' ') key = 'Space';
  if (key === 'Del') key = 'Delete';
  if (key === 'Esc') key = 'Escape';
  if (key === '.') key = 'Period';
  if (key === ',') key = 'Comma';
  if (key && key.length === 1) key = key.toUpperCase();
  if (['Control', 'Alt', 'Shift', 'Meta', 'OS', 'Super', 'Hyper'].includes(key)) return parts.join('+');
  // Shift+S with Super would otherwise arrive as key "S"
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
        superDown = true;
        superUsed = false;
        return;
      }
      if (superDown || input.meta) superUsed = true;
      const combo = comboOf(input);
      if (SYSTEM.has(combo) || (input.meta && combo.startsWith('Super+'))) {
        event.preventDefault();
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

module.exports = { installHotkeys, comboOf };
