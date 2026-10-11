// Key names as Windows shows them in each language ("Ctrl+Maj+N", "Suppr" in French).
const NAMES = {
  fr: { Shift: 'Maj', Delete: 'Suppr', Enter: 'Entrée', Space: 'Espace', Escape: 'Échap', Esc: 'Échap', Home: 'Origine', End: 'Fin' },
};

export function keyLabel(combo, lang) {
  const map = NAMES[lang];
  if (!map || !combo) return combo;
  return String(combo).replace(/\b(Shift|Delete|Enter|Space|Escape|Esc|Home|End)\b/g, (m) => map[m]);
}
