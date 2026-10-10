// Clock — alarm / timer tones synthesised with WebAudio (tone patterns understood by shell.sounds.play
// and by shell.reminders' `sound` field, so they ring even when the app is closed). Each pattern is
// shorter than the 1.6 s ring loop of the reminder scheduler.
const N = { C5: 523.25, D5: 587.33, E5: 659.25, F5: 698.46, G5: 783.99, A5: 880, B5: 987.77, C6: 1046.5, D6: 1174.66, E6: 1318.51, G6: 1567.98, A6: 1760, C7: 2093 };

export const TONES = [
  { id: 'classic', name: { en: 'Classic', fr: 'Classique' }, pattern: null }, // the system alarm sound
  {
    id: 'chimes',
    name: { en: 'Chimes', fr: 'Carillon' },
    pattern: [
      { freq: N.E6, dur: 0.9, gain: 0.11 },
      { freq: N.C6, start: 0.28, dur: 0.9, gain: 0.11 },
      { freq: N.D6, start: 0.56, dur: 0.9, gain: 0.1 },
      { freq: N.G5, start: 0.84, dur: 0.7, gain: 0.1 },
    ],
  },
  {
    id: 'xylophone',
    name: { en: 'Xylophone', fr: 'Xylophone' },
    pattern: [
      { freq: N.C6, dur: 0.18, gain: 0.16, type: 'triangle' },
      { freq: N.E6, start: 0.14, dur: 0.18, gain: 0.16, type: 'triangle' },
      { freq: N.G6, start: 0.28, dur: 0.18, gain: 0.16, type: 'triangle' },
      { freq: N.E6, start: 0.42, dur: 0.18, gain: 0.15, type: 'triangle' },
      { freq: N.C7, start: 0.56, dur: 0.4, gain: 0.14, type: 'triangle' },
    ],
  },
  {
    id: 'chords',
    name: { en: 'Chords', fr: 'Accords' },
    pattern: [
      { freq: N.C5, dur: 0.55, gain: 0.07 },
      { freq: N.E5, dur: 0.55, gain: 0.07 },
      { freq: N.G5, dur: 0.55, gain: 0.07 },
      { freq: N.F5, start: 0.6, dur: 0.7, gain: 0.07 },
      { freq: N.A5, start: 0.6, dur: 0.7, gain: 0.07 },
      { freq: N.C6, start: 0.6, dur: 0.7, gain: 0.07 },
    ],
  },
  {
    id: 'tap',
    name: { en: 'Tap', fr: 'Tapotement' },
    pattern: [
      { freq: 1500, dur: 0.06, gain: 0.12, type: 'square' },
      { freq: 1500, start: 0.16, dur: 0.06, gain: 0.12, type: 'square' },
      { freq: 1500, start: 0.32, dur: 0.06, gain: 0.12, type: 'square' },
      { freq: 1500, start: 0.48, dur: 0.06, gain: 0.12, type: 'square' },
    ],
  },
  {
    id: 'jingle',
    name: { en: 'Jingle', fr: 'Clochettes' },
    pattern: [
      { freq: N.A6, dur: 0.3, gain: 0.08 },
      { freq: N.A6 * 2.01, dur: 0.2, gain: 0.03 },
      { freq: N.E6, start: 0.18, dur: 0.3, gain: 0.08 },
      { freq: N.E6 * 2.01, start: 0.18, dur: 0.2, gain: 0.03 },
      { freq: N.A6, start: 0.36, dur: 0.3, gain: 0.08 },
      { freq: N.C7, start: 0.54, dur: 0.6, gain: 0.08 },
    ],
  },
  {
    id: 'bounce',
    name: { en: 'Bounce', fr: 'Rebond' },
    pattern: [
      { freq: 600, glide: 1200, dur: 0.16, gain: 0.12 },
      { freq: 600, glide: 1200, start: 0.24, dur: 0.16, gain: 0.12 },
      { freq: 700, glide: 1400, start: 0.48, dur: 0.22, gain: 0.12 },
    ],
  },
  {
    id: 'echo',
    name: { en: 'Echo', fr: 'Écho' },
    pattern: [
      { freq: N.G6, dur: 0.3, gain: 0.14 },
      { freq: N.G6, start: 0.3, dur: 0.3, gain: 0.08 },
      { freq: N.G6, start: 0.6, dur: 0.3, gain: 0.045 },
      { freq: N.G6, start: 0.9, dur: 0.3, gain: 0.02 },
    ],
  },
  {
    id: 'ascending',
    name: { en: 'Ascending', fr: 'Ascendant' },
    pattern: [N.C5, N.E5, N.G5, N.C6, N.E6].map((freq, i) => ({ freq, start: i * 0.15, dur: 0.3, gain: 0.11, type: 'triangle' })),
  },
  {
    id: 'descending',
    name: { en: 'Descending', fr: 'Descendant' },
    pattern: [N.E6, N.C6, N.G5, N.E5, N.C5].map((freq, i) => ({ freq, start: i * 0.15, dur: 0.3, gain: 0.11, type: 'triangle' })),
  },
];

// Soft two-note cue for focus periods / breaks (played by the app, not looped).
export const FOCUS_CUE = [
  { freq: N.G5, dur: 0.5, gain: 0.09 },
  { freq: N.C6, start: 0.22, dur: 0.8, gain: 0.08 },
];

export function toneById(id) {
  return TONES.find((x) => x.id === id) || TONES[1];
}
