// Paramètres > Écran, « Plusieurs écrans » (shown when two screens or more are connected): how to use them (Étendre /
// Dupliquer / one screen only), where the other screen sits next to the main one, and which screen is the main one
// (the bar and the Lanceur live there). Each change is applied at once with « Conserver ces modifications ? »
// (15 s, then back), then remembered for this set of screens (display:setLayout / display:saveLayout, main/ipc/display.js).
const STR = {
  en: {
    group: 'Several screens',
    mode: 'How to use your screens',
    modeDesc: 'Super+P also lets you choose',
    extend: 'Extend these screens',
    mirror: 'Duplicate these screens',
    external: 'External screen only',
    internal: 'Computer screen only',
    position: 'Where is the other screen?',
    positionDesc: 'Compared with the main screen, so that the pointer goes from one to the other naturally',
    right: 'On the right',
    left: 'On the left',
    above: 'Above',
    below: 'Below',
    primary: 'Main screen',
    primaryDesc: 'The bar, the Launcher and notifications appear on it',
    internalName: 'Computer screen',
    off: 'off',
    lid: 'When you close the lid with an external screen connected, everything moves to the external screen. Opening it brings your layout back.',
  },
  fr: {
    group: 'Plusieurs écrans',
    mode: 'Utilisation de vos écrans',
    modeDesc: 'Vous pouvez aussi choisir avec Super+P',
    extend: 'Étendre ces écrans',
    mirror: 'Dupliquer ces écrans',
    external: 'Seulement l’écran externe',
    internal: 'Seulement l’écran de l’ordinateur',
    position: 'Où se trouve l’autre écran ?',
    positionDesc: 'Par rapport à l’écran principal, pour que le pointeur passe naturellement de l’un à l’autre',
    right: 'À droite',
    left: 'À gauche',
    above: 'Au-dessus',
    below: 'En dessous',
    primary: 'Écran principal',
    primaryDesc: 'La barre, le Lanceur et les notifications s’y affichent',
    internalName: 'Écran de l’ordinateur',
    off: 'éteint',
    lid: 'Quand vous fermez l’ordinateur avec un écran externe branché, tout passe sur l’écran externe. En le rouvrant, vous retrouvez votre disposition.',
  },
};

export function screenLabel(pc, o, i) {
  const s = STR[pc.lang === 'fr' ? 'fr' : 'en'];
  const name = o.internal ? s.internalName : o.name;
  return `${i + 1} · ${name}${o.active === false ? ` (${s.off})` : ''}`;
}

/** The « Plusieurs écrans » group, or null with fewer than two screens. applyLayout(cfg) -> Promise<boolean>. */
export function multiScreenGroup(pc, { outputs, layout, applyLayout }) {
  const { h, kit } = pc;
  const s = STR[pc.lang === 'fr' ? 'fr' : 'en'];
  const real = outputs.filter((o) => !o.readOnly);
  if (real.length < 2) return null;
  const lay = { mode: 'extend', position: 'right', primary: null, ...(layout || {}) };
  const hasInt = real.some((o) => o.internal);
  const hasExt = real.some((o) => !o.internal);
  const modes = ['extend', 'mirror', ...(hasInt && hasExt ? ['external', 'internal'] : [])];
  const rows = [
    kit.row({
      icon: 'desktop',
      title: s.mode,
      desc: s.modeDesc,
      section: 'multi',
      control: kit.combo({
        options: modes.map((m) => ({ value: m, label: s[m] })),
        value: modes.includes(lay.mode) ? lay.mode : 'extend',
        width: 260,
        label: s.mode,
        onChange: async (v) => ((await applyLayout({ mode: v })) ? undefined : false),
      }),
    }),
  ];
  if (lay.mode === 'extend') {
    rows.push(
      kit.row({
        icon: 'resize',
        title: s.position,
        desc: s.positionDesc,
        section: 'arrangement',
        control: kit.combo({
          options: ['right', 'left', 'above', 'below'].map((p) => ({ value: p, label: s[p] })),
          value: lay.position || 'right',
          width: 200,
          label: s.position,
          onChange: async (v) => ((await applyLayout({ mode: 'extend', position: v })) ? undefined : false),
        }),
      }),
      kit.row({
        icon: 'desktop',
        title: s.primary,
        desc: s.primaryDesc,
        section: 'primary',
        control: kit.combo({
          options: real.map((o, i) => ({ value: o.name, label: screenLabel(pc, o, i) })),
          value: lay.primary || real.find((o) => o.primary)?.name || real[0].name,
          width: 260,
          label: s.primary,
          onChange: async (v) => ((await applyLayout({ mode: 'extend', primary: v })) ? undefined : false),
        }),
      }),
    );
  }
  if (hasInt && hasExt) rows.push(h('p', { class: 'st-multi-lid', style: { margin: '6px 4px 0', fontSize: '12px', opacity: '0.75', lineHeight: '1.5' } }, s.lid));
  return kit.group(s.group, ...rows);
}

/** Mini map of the screens as they are arranged (click = select a screen for its resolution below). */
export function arrangementMap(pc, { outputs, selected, onSelect }) {
  const { h } = pc;
  const on = outputs.filter((o) => o.active !== false && o.width);
  if (!on.length) return null;
  const minX = Math.min(...on.map((o) => o.x || 0));
  const minY = Math.min(...on.map((o) => o.y || 0));
  const W = Math.max(...on.map((o) => (o.x || 0) + o.width)) - minX;
  const H = Math.max(...on.map((o) => (o.y || 0) + o.height)) - minY;
  const k = Math.min(320 / W, 150 / H);
  const map = h('div', { class: 'st-display-map', style: { position: 'relative', width: `${Math.round(W * k)}px`, height: `${Math.round(H * k)}px`, margin: '8px auto 18px' } });
  outputs.forEach((o, i) => {
    if (!(o.active !== false && o.width)) return;
    map.appendChild(
      h(
        'button',
        {
          class: `st-monitor${o === selected ? ' selected' : ''}`,
          type: 'button',
          'data-output': o.name,
          'aria-pressed': String(o === selected),
          'aria-label': screenLabel(pc, o, i),
          title: screenLabel(pc, o, i),
          style: {
            position: 'absolute',
            left: `${Math.round(((o.x || 0) - minX) * k) + 2}px`,
            top: `${Math.round(((o.y || 0) - minY) * k) + 2}px`,
            width: `${Math.max(24, Math.round(o.width * k) - 4)}px`,
            height: `${Math.max(18, Math.round(o.height * k) - 4)}px`,
            opacity: o === selected ? '1' : '0.6',
          },
          onclick: () => onSelect(o),
        },
        String(i + 1),
      ),
    );
  });
  return map;
}
