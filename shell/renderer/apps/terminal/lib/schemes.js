// Colour schemes (the classic Windows Terminal set) and their xterm.js themes.
//   SCHEMES: [{ id, name, dark, colors: { background, foreground, cursor, selection, black … brightWhite } }]
//   resolveScheme(prefs.scheme, uiMode) -> scheme   ('system' follows the Selene light/dark theme)
//   xtermTheme(scheme, opacity) -> ITheme
const S = (id, name, dark, c) => ({ id, name, dark, colors: c });

const TANGO = {
  black: '#000000', red: '#CC0000', green: '#4E9A06', yellow: '#C4A000', blue: '#3465A4', purple: '#75507B', cyan: '#06989A', white: '#D3D7CF',
  brightBlack: '#555753', brightRed: '#EF2929', brightGreen: '#8AE234', brightYellow: '#FCE94F', brightBlue: '#729FCF', brightPurple: '#AD7FA8', brightCyan: '#34E2E2', brightWhite: '#EEEEEC',
};
const SOLARIZED = {
  black: '#002B36', red: '#DC322F', green: '#859900', yellow: '#B58900', blue: '#268BD2', purple: '#D33682', cyan: '#2AA198', white: '#EEE8D5',
  brightBlack: '#073642', brightRed: '#CB4B16', brightGreen: '#586E75', brightYellow: '#657B83', brightBlue: '#839496', brightPurple: '#6C71C4', brightCyan: '#93A1A1', brightWhite: '#FDF6E3',
};
const CAMPBELL = {
  black: '#0C0C0C', red: '#C50F1F', green: '#13A10E', yellow: '#C19C00', blue: '#0037DA', purple: '#881798', cyan: '#3A96DD', white: '#CCCCCC',
  brightBlack: '#767676', brightRed: '#E74856', brightGreen: '#16C60C', brightYellow: '#F9F1A5', brightBlue: '#3B78FF', brightPurple: '#B4009E', brightCyan: '#61D6D6', brightWhite: '#F2F2F2',
};

export const SCHEMES = [
  S('campbell', 'Campbell', true, { background: '#0C0C0C', foreground: '#CCCCCC', cursor: '#FFFFFF', selection: '#FFFFFF', ...CAMPBELL }),
  S('campbell-powershell', 'Campbell Powershell', true, { background: '#012456', foreground: '#CCCCCC', cursor: '#FFFFFF', selection: '#FFFFFF', ...CAMPBELL }),
  S('one-half-dark', 'One Half Dark', true, {
    background: '#282C34', foreground: '#DCDFE4', cursor: '#FFFFFF', selection: '#FFFFFF',
    black: '#282C34', red: '#E06C75', green: '#98C379', yellow: '#E5C07B', blue: '#61AFEF', purple: '#C678DD', cyan: '#56B6C2', white: '#DCDFE4',
    brightBlack: '#5A6374', brightRed: '#E06C75', brightGreen: '#98C379', brightYellow: '#E5C07B', brightBlue: '#61AFEF', brightPurple: '#C678DD', brightCyan: '#56B6C2', brightWhite: '#DCDFE4',
  }),
  S('one-half-light', 'One Half Light', false, {
    background: '#FAFAFA', foreground: '#383A42', cursor: '#4F525D', selection: '#4F525D',
    black: '#383A42', red: '#E45649', green: '#50A14F', yellow: '#C18301', blue: '#0184BC', purple: '#A626A4', cyan: '#0997B3', white: '#FAFAFA',
    brightBlack: '#4F525D', brightRed: '#DF6C75', brightGreen: '#98C379', brightYellow: '#E4C07A', brightBlue: '#61AFEF', brightPurple: '#C577DD', brightCyan: '#56B5C1', brightWhite: '#FFFFFF',
  }),
  S('solarized-dark', 'Solarized Dark', true, { background: '#002B36', foreground: '#839496', cursor: '#FFFFFF', selection: '#FFFFFF', ...SOLARIZED }),
  S('solarized-light', 'Solarized Light', false, { background: '#FDF6E3', foreground: '#657B83', cursor: '#002B36', selection: '#073642', ...SOLARIZED }),
  S('tango-dark', 'Tango Dark', true, { background: '#000000', foreground: '#D3D7CF', cursor: '#FFFFFF', selection: '#FFFFFF', ...TANGO }),
  S('tango-light', 'Tango Light', false, { background: '#FFFFFF', foreground: '#555753', cursor: '#000000', selection: '#555753', ...TANGO }),
];

export const SYSTEM_SCHEME = { dark: 'one-half-dark', light: 'one-half-light' };

export function schemeById(id) {
  return SCHEMES.find((s) => s.id === id) || null;
}

export function resolveScheme(id, uiMode) {
  if (!id || id === 'system') return schemeById(uiMode === 'dark' ? SYSTEM_SCHEME.dark : SYSTEM_SCHEME.light);
  return schemeById(id) || schemeById(SYSTEM_SCHEME.dark);
}

export function hexToRgb(hex) {
  const h = String(hex).replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgba(hex, a) {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${Math.round(a * 1000) / 1000})`;
}

// Mix two #rrggbb colours: t = 0 -> a, 1 -> b.
export function mix(a, b, t) {
  const x = hexToRgb(a);
  const y = hexToRgb(b);
  const c = x.map((v, i) => Math.round(v + (y[i] - v) * t));
  return `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

export function xtermTheme(scheme, opacity = 1) {
  const c = scheme.colors;
  const sel = scheme.dark ? 0.3 : 0.22;
  return {
    background: opacity >= 1 ? c.background : rgba(c.background, opacity),
    foreground: c.foreground,
    cursor: c.cursor,
    cursorAccent: c.background,
    selectionBackground: rgba(c.selection, sel),
    selectionInactiveBackground: rgba(c.selection, sel * 0.55),
    scrollbarSliderBackground: rgba(c.foreground, 0.22),
    scrollbarSliderHoverBackground: rgba(c.foreground, 0.36),
    scrollbarSliderActiveBackground: rgba(c.foreground, 0.48),
    overviewRulerBorder: 'transparent',
    black: c.black,
    red: c.red,
    green: c.green,
    yellow: c.yellow,
    blue: c.blue,
    magenta: c.purple,
    cyan: c.cyan,
    white: c.white,
    brightBlack: c.brightBlack,
    brightRed: c.brightRed,
    brightGreen: c.brightGreen,
    brightYellow: c.brightYellow,
    brightBlue: c.brightBlue,
    brightMagenta: c.brightPurple,
    brightCyan: c.brightCyan,
    brightWhite: c.brightWhite,
  };
}

export const PALETTE_KEYS = ['black', 'red', 'green', 'yellow', 'blue', 'purple', 'cyan', 'white', 'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightPurple', 'brightCyan', 'brightWhite'];
