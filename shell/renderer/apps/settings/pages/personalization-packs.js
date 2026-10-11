// Settings > Personalization > Cursors, Icon packs, Sound packs (docs/PERSONALIZATION.md §11).
// Keys: cursorPack, iconPack, soundPack, soundEvents { notification, startup, shutdown }. Runtime: core/packs.js
// (cursors, icons) and core/sounds.js (sounds). Every choice applies at once; cards are radio groups (arrow keys).
import { CURSOR_PACKS, ICON_PACKS, packs } from '../../../core/packs.js';
import { SOUND_PACKS, SOUND_EVENTS, sounds } from '../../../core/sounds.js';
import { rovingFocus } from './personalization-designer.js';
import { setupShellPages, boundToggle } from './personalization-shell-kit.js';
import { PAGES } from '../lib/index.js';

const AUDIO_EXT = ['.ogg', '.oga', '.opus', '.wav', '.mp3', '.flac', '.m4a', '.webm'];

/** A radio group of cards bound to a settings key. render(pack) -> preview node. */
function packCards(pc, { key, list, def, label, render, className }) {
  const { h, settings, L } = pc;
  const cur = () => (list.some((p) => p.id === settings.get(key)) ? settings.get(key) : def);
  const grid = h('div', { class: ['pzs-cards', className], role: 'radiogroup', 'aria-label': label });
  const cards = list.map((p) =>
    h(
      'button',
      {
        class: 'pzs-card',
        type: 'button',
        role: 'radio',
        dataset: { pack: p.id },
        'aria-label': L(p.name),
        onclick: () => settings.set(key, p.id),
      },
      h('span', { class: 'pzs-card-pv' }, render(p)),
      h('span', { class: 'pzs-card-name' }, L(p.name)),
    ),
  );
  grid.append(...cards);
  const sync = rovingFocus(grid, '.pzs-card');
  const mark = () => {
    for (const c of cards) {
      const on = c.dataset.pack === cur();
      c.classList.toggle('selected', on);
      c.setAttribute('aria-checked', String(on));
    }
    sync();
  };
  mark();
  pc.onDispose(settings.on(key, mark));
  grid.repaint = () => cards.forEach((c, i) => c.querySelector('.pzs-card-pv').replaceChildren(render(list[i])));
  return grid;
}

// ------------------------------------------------------------------ Cursors
const SHAPES = ['arrow', 'hand', 'text', 'wait', 'move', 'nwse'];
async function cursors(pc) {
  setupShellPages(pc);
  const { h, t, kit, settings } = pc;
  const preview = (p) =>
    h(
      'span',
      { class: 'pzs-cursor-row' },
      SHAPES.map((s) => {
        const url = packs.cursorPreview(p.id, s);
        return url ? h('img', { src: url, alt: '', draggable: false }) : h('span', { class: `pzs-sys-cursor pzs-sys-${s}`, style: { cursor: { arrow: 'default', hand: 'pointer', text: 'text', wait: 'wait', move: 'move', nwse: 'nwse-resize' }[s] } }, pc.icon({ arrow: 'cursor', hand: 'hand_left', text: 'text_font', wait: 'spinner_ios', move: 'arrow_move', nwse: 'arrow_maximize' }[s] || 'cursor', { size: 18 }));
      }),
    );
  const cards = packCards(pc, { key: 'cursorPack', list: CURSOR_PACKS, def: 'default', label: t('pzs.cursorPack'), render: preview, className: 'pzs-cursor-cards' });
  pc.onDispose(settings.on('accent', () => cards.repaint()));
  const pad = h('div', { class: 'pzs-try', tabindex: '-1' },
    h('span', { class: 'caption text-2' }, t('pzs.tryCursor')),
    h('div', { class: 'pzs-try-row' },
      h('button', { class: 'btn', type: 'button' }, t('pzs.tryButton')),
      h('input', { class: 'input', type: 'text', placeholder: t('pzs.tryText'), 'aria-label': t('pzs.tryText') }),
      h('a', { class: 'st-link pzs-try-link', href: '#', onclick: (e) => e.preventDefault() }, t('pzs.tryLink')),
      h('span', { class: 'pzs-try-move', style: { cursor: 'move' } }, t('pzs.tryMove')),
    ),
  );
  return h(
    'div',
    { class: 'pzs-page' },
    h('p', { class: 'pzs-intro text-2' }, t('pzs.cursorIntro')),
    kit.group(t('pzs.cursorPack'), h('div', { dataset: { section: 'cursorPack' } }, cards), pad),
    kit.related([{ icon: PAGES.mouse.icon, title: pc.pageTitle('mouse'), desc: pc.L(PAGES.mouse.desc), onClick: () => pc.go('mouse') }]),
  );
}

// ------------------------------------------------------------------ Icon packs
const SAMPLE_APPS = ['files', 'browser', 'mail', 'notepad', 'settings', 'calculator'];
async function iconPacks(pc) {
  setupShellPages(pc);
  const { h, t, kit, settings } = pc;
  const reg = pc.shell.registry;
  const apps = () => SAMPLE_APPS.filter((id) => reg.get(id));
  const preview = (p) => h('span', { class: 'pzs-icon-row' }, apps().map((id) => h('img', { src: packs.appIcon(p.id, id), alt: '', width: 28, height: 28, draggable: false, dataset: { iconFixed: '' } })));
  const cards = packCards(pc, { key: 'iconPack', list: ICON_PACKS, def: 'fluent', label: t('pzs.iconPack'), render: preview, className: 'pzs-icon-cards' });
  pc.onDispose(settings.on('accent', () => cards.repaint()));
  return h(
    'div',
    { class: 'pzs-page' },
    h('p', { class: 'pzs-intro text-2' }, t('pzs.iconIntro')),
    kit.group(t('pzs.iconPack'), h('div', { dataset: { section: 'iconPack' } }, cards)),
    h('p', { class: 'caption text-2 pzs-after' }, t('pzs.iconNote')),
    kit.related([
      { icon: 'panel_bottom', title: pc.pageTitle('taskbar'), desc: pc.L(PAGES.taskbar.desc), onClick: () => pc.go('taskbar') },
      { icon: 'apps', title: pc.pageTitle('start'), desc: pc.L(PAGES.start.desc), onClick: () => pc.go('start') },
    ]),
  );
}

// ------------------------------------------------------------------ Sound packs
async function soundPacks(pc) {
  setupShellPages(pc);
  const { h, t, kit, settings, ui, L } = pc;
  const preview = (p) =>
    h(
      'span',
      { class: 'pzs-sound-pv' },
      pc.icon(p.id === 'silent' ? 'speaker_mute' : 'music_note_2', { size: 22 }),
      p.id === 'silent'
        ? null
        : h(
            'span',
            {
              class: 'btn subtle small pzs-play',
              role: 'button',
              tabindex: '-1',
              'aria-label': `${t('pzs.play')} — ${L(p.name)}`,
              onclick: (e) => {
                e.stopPropagation();
                sounds.preview(p.id, 'notify');
              },
            },
            pc.icon('play', { size: 14 }),
            t('pzs.play'),
          ),
    );
  const cards = packCards(pc, { key: 'soundPack', list: SOUND_PACKS, def: 'aurora', label: t('pzs.soundPack'), render: preview, className: 'pzs-sound-cards' });

  // per-event sound: the pack's, none, another pack's, or an audio file
  const eventRow = (ev) => {
    const key = `soundEvents.${ev}`;
    const value = () => {
      const v = settings.get(key);
      return v == null ? 'pack' : v;
    };
    const fileLabel = (p) => t('pzs.soundFile', { name: String(p).split('/').pop() });
    const options = () => {
      const v = value();
      const list = [
        { value: 'pack', label: t('pzs.soundOfPack') },
        { value: 'none', label: t('pzs.soundNone') },
        '-',
        ...sounds.choices(ev).map((c) => ({ value: c.id, label: L(c.pack.name) })),
        '-',
        { value: 'file', label: t('pzs.soundBrowse') },
      ];
      if (typeof v === 'string' && v.startsWith('/')) list.splice(list.length - 1, 0, { value: v, label: fileLabel(v) });
      return list;
    };
    const combo = kit.combo({
      label: t(`pzs.ev_${ev}`),
      options: options(),
      value: value(),
      width: 200,
      onChange: async (v) => {
        if (v === 'pack') return settings.set(key, null).then(() => true);
        if (v === 'file') {
          const picked = await ui.filePicker({ mode: 'open', title: t('pzs.soundBrowse'), filters: [{ name: t('pzs.audioFiles'), ext: AUDIO_EXT }], parent: pc.win }).catch(() => null);
          const path = Array.isArray(picked) ? picked[0] : picked;
          if (!path || typeof path !== 'string' || !AUDIO_EXT.some((x) => path.toLowerCase().endsWith(x))) return false;
          await settings.set(key, path);
          return true;
        }
        await settings.set(key, v);
        return true;
      },
    });
    combo.dataset.key = key;
    pc.onDispose(
      settings.on('soundEvents', () => {
        combo.setOptions(options(), value());
      }),
    );
    const play = h('button', { class: 'btn subtle icon-btn pzs-play-ev', type: 'button', 'aria-label': `${t('pzs.play')} — ${t(`pzs.ev_${ev}`)}`, 'data-tip': t('pzs.play'), onclick: () => sounds.preview(settings.get(key) ?? null, { notification: 'notify', startup: 'startup', shutdown: 'shutdown' }[ev]) }, pc.icon('play', { size: 14 }));
    return kit.row({ icon: { notification: 'alert', startup: 'power', shutdown: 'arrow_exit' }[ev], title: t(`pzs.ev_${ev}`), desc: t(`pzs.ev_${ev}Desc`), section: `ev-${ev}`, control: h('div', { class: 'pz-inline' }, play, combo) });
  };
  const offNote = kit.infobar({ kind: 'info', message: t('pzs.soundsOff'), className: 'pzs-sounds-off' });
  const paintOff = () => (offNote.hidden = settings.get('sounds') !== false);
  paintOff();
  pc.onDispose(settings.on('sounds', paintOff));
  return h(
    'div',
    { class: 'pzs-page' },
    h('p', { class: 'pzs-intro text-2' }, t('pzs.soundIntro')),
    offNote,
    kit.group(null, kit.row({ icon: 'speaker_2', title: t('pzs.systemSounds'), desc: t('pzs.systemSoundsDesc'), section: 'sounds', control: boundToggle(pc, 'sounds', true, t('pzs.systemSounds')) })),
    kit.group(t('pzs.soundPack'), h('div', { dataset: { section: 'soundPack' } }, cards)),
    kit.group(t('pzs.soundEvents'), ...SOUND_EVENTS.map(eventRow)),
    kit.related([{ icon: 'speaker_2', title: pc.pageTitle('sound'), desc: pc.L(PAGES.sound.desc), onClick: () => pc.go('sound') }]),
  );
}

export default { cursors, iconPacks, soundPacks };
