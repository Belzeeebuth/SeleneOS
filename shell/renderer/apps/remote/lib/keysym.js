// KeyboardEvent -> X11 keysym (RFC 6143 §7.5.4). Pure: unit-tested in test/remote.test.mjs.
//   keysymFor({ key, code, location }) -> number | null
const BY_CODE = {
  ShiftLeft: 0xffe1, ShiftRight: 0xffe2, ControlLeft: 0xffe3, ControlRight: 0xffe4,
  AltLeft: 0xffe9, AltRight: 0xffea, MetaLeft: 0xffeb, MetaRight: 0xffec, OSLeft: 0xffeb, OSRight: 0xffec,
  CapsLock: 0xffe5, NumLock: 0xff7f, ScrollLock: 0xff14, ContextMenu: 0xff67,
  Numpad0: 0xffb0, Numpad1: 0xffb1, Numpad2: 0xffb2, Numpad3: 0xffb3, Numpad4: 0xffb4, Numpad5: 0xffb5,
  Numpad6: 0xffb6, Numpad7: 0xffb7, Numpad8: 0xffb8, Numpad9: 0xffb9, NumpadDecimal: 0xffae, NumpadAdd: 0xffab,
  NumpadSubtract: 0xffad, NumpadMultiply: 0xffaa, NumpadDivide: 0xffaf, NumpadEnter: 0xff8d,
};
const BY_KEY = {
  Backspace: 0xff08, Tab: 0xff09, Enter: 0xff0d, Escape: 0xff1b, Esc: 0xff1b, Delete: 0xffff, Insert: 0xff63,
  Home: 0xff50, End: 0xff57, PageUp: 0xff55, PageDown: 0xff56,
  ArrowLeft: 0xff51, ArrowUp: 0xff52, ArrowRight: 0xff53, ArrowDown: 0xff54, Left: 0xff51, Up: 0xff52, Right: 0xff53, Down: 0xff54,
  Shift: 0xffe1, Control: 0xffe3, Alt: 0xffe9, AltGraph: 0xfe03, Meta: 0xffeb, OS: 0xffeb, Super: 0xffeb,
  CapsLock: 0xffe5, NumLock: 0xff7f, ScrollLock: 0xff14, Pause: 0xff13, PrintScreen: 0xff61, ContextMenu: 0xff67,
  ' ': 0x20, Spacebar: 0x20,
};
for (let i = 1; i <= 24; i++) BY_KEY[`F${i}`] = 0xffbe + i - 1;

export function keysymFor(e) {
  const key = e?.key ?? '';
  const code = e?.code ?? '';
  if (key === 'AltGraph') return 0xfe03;
  // Modifiers and keypad: the physical key decides (left vs right, digits vs navigation on the keypad).
  if (code in BY_CODE && (!code.startsWith('Numpad') || /^[\d.+\-*/]$|^Enter$/.test(key))) return BY_CODE[code];
  if (key in BY_KEY) return BY_KEY[key];
  if (key === 'Dead' || key === 'Unidentified' || key === 'Process') return null;
  const chars = [...key];
  if (chars.length !== 1) return null;
  const cp = chars[0].codePointAt(0);
  if (cp < 0x20) return null;
  if ((cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff)) return cp; // Latin-1 keysyms equal the code point
  return 0x01000000 | cp; // Unicode keysym
}

export const KEYSYM = { Control_L: 0xffe3, Alt_L: 0xffe9, Delete: 0xffff, Shift_L: 0xffe1 };
