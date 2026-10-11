// Settings > Personalization > Cursors, Icon packs, Sound packs (docs/PERSONALIZATION.md §11).
// Keys: cursorPack, cursorSize, iconPack, soundPack, soundEvents { notification, startup, shutdown }, soundVolume,
// startupSound, sounds. Runtime: core/packs.js (cursors, icons) and core/sounds.js (sounds). Every choice applies at
// once; cards are radio groups (arrow keys).
import { CURSOR_PACKS, ICON_PACKS, packs } from '../../../core/packs.js';
import { SOUND_PACKS, SOUND_EVENTS, SOUND_NAMES, sounds } from '../../../core/sounds.js';
import { rovingFocus, liveSlider, ctl } from './personalization-designer.js';
import { setupShellPages, boundToggle } from './personalization-shell-kit.js';
import { PAGES } from '../lib/index.js';
import './personalization-b3-strings.js';

const AUDIO_EXT = ['.ogg', '.oga', '.opus', '.wav', '.mp3', '.flac', '.m4a', '.webm'];
export const B3_CSS = 'app://shell/apps/settings/pages/personalization-b3.css';
function setup(pc) {
  setupShellPages(pc);
  pc.ui.loadCss('app://shell/apps/settings/pages/personalization.css'); // ctl() rows and sliders of the designer
  pc.ui.loadCss(B3_CSS);
}
const pct = (pc, v) => (pc.lang === 'fr' ? `${v} %` : `${v}%`);

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
// the preview grid: CSS keyword shown, in Windows' order
const GRID = ['default', 'help', 'progress', 'wait', 'crosshair', 'text', 'not-allowed', 'ns-resize', 'ew-resize', 'nwse-resize', 'nesw-resize', 'move', 'pointer', 'grab', 'grabbing', 'col-resize'];
const KW_SHAPE = { default: 'arrow', help: 'help', progress: 'progress', wait: 'wait', crosshair: 'cross', text: 'text', 'not-allowed': 'no', 'ns-resize': 'ns', 'ew-resize': 'ew', 'nwse-resize': 'nwse', 'nesw-resize': 'nesw', move: 'move', pointer: 'hand', grab: 'palm', grabbing: 'fist', 'col-resize': 'col' };
const SYS_ICON = { default: 'cursor', help: 'question_circle', progress: 'spinner_ios', wait: 'spinner_ios', crosshair: 'add', text: 'text_font', 'not-allowed': 'prohibited', 'ns-resize': 'arrow_bidirectional_up_down', 'ew-resize': 'arrow_bidirectional_left_right', 'nwse-resize': 'arrow_maximize', 'nesw-resize': 'arrow_maximize', move: 'arrow_move', pointer: 'hand_left', grab: 'hand_left', grabbing: 'hand_left', 'col-resize': 'arrow_bidirectional_left_right' };

async function cursors(pc) {
  setup(pc);
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

  // size
  const size = liveSlider(pc, { key: 'cursorSize', min: 100, max: 300, step: 25, def: 100, label: t('pzx.cursorSize'), format: (v) => pct(pc, v), iconStart: 'cursor' });
  const sizeRow = ctl(pc, { icon: 'cursor', title: t('pzx.cursorSize'), desc: t('pzx.cursorSizeDesc'), control: size, stacked: true, section: 'cursorSize' });

  // every pointer of the pack in use (hover a cell to try it)
  const grid = h('div', { class: 'pzb-cursor-grid', role: 'list' });
  const note = h('p', { class: 'caption text-2 pzb-note' });
  const paintGrid = () => {
    const drawn = packs.cursorDrawn;
    const sz = Number(settings.get('cursorSize')) || 100;
    note.hidden = drawn !== 'default';
    note.textContent = t('pzx.cursorSystemNote');
    grid.replaceChildren(
      ...GRID.map((kw) => {
        const info = packs.cursorInfo(drawn, KW_SHAPE[kw], sz);
        return h(
          'div',
          { class: 'pzb-cursor-cell', role: 'listitem', dataset: { kw }, style: { cursor: kw }, title: t(`pzx.sh_${kw}`) },
          h(
            'span',
            { class: 'pzb-cursor-img' },
            info
              ? h('img', { src: info.url, alt: '', draggable: false, style: { width: `${Math.min(48, info.size)}px`, height: `${Math.min(48, info.size)}px` } })
              : pc.icon(SYS_ICON[kw] || 'cursor', { size: 20 }),
          ),
          h('span', { class: 'pzb-cursor-name caption' }, t(`pzx.sh_${kw}`)),
        );
      }),
    );
  };
  paintGrid();
  pc.onDispose(settings.on('cursorPack', paintGrid));
  pc.onDispose(settings.on('cursorSize', paintGrid));
  pc.onDispose(settings.on('accent', paintGrid));

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
    kit.group(t('pzs.cursorPack'), h('div', { dataset: { section: 'cursorPack' } }, cards), sizeRow),
    kit.group(t('pzx.cursorPreview'), h('div', { dataset: { section: 'cursorPreview' }, class: 'pzb-pad' }, h('p', { class: 'caption text-2' }, t('pzx.cursorPreviewDesc')), grid, note), pad),
    kit.related([{ icon: PAGES.mouse.icon, title: pc.pageTitle('mouse'), desc: pc.L(PAGES.mouse.desc), onClick: () => pc.go('mouse') }]),
  );
}

// ------------------------------------------------------------------ Icon packs
const SAMPLE_APPS = ['files', 'browser', 'mail', 'notepad', 'settings', 'calculator'];
async function iconPacks(pc) {
  setup(pc);
  const { h, t, kit, settings } = pc;
  const reg = pc.shell.registry;
  const apps = () => SAMPLE_APPS.filter((id) => reg.get(id));
  const fixedImg = (src, size = 28) => h('img', { src, alt: '', width: size, height: size, draggable: false, dataset: { iconFixed: '' } });
  const preview = (p) => h('span', { class: 'pzs-icon-row' }, apps().map((id) => fixedImg(packs.appIcon(p.id, id))));
  const cards = packCards(pc, { key: 'iconPack', list: ICON_PACKS, def: 'fluent', label: t('pzs.iconPack'), render: preview, className: 'pzs-icon-cards' });
  pc.onDispose(settings.on('accent', () => cards.repaint()));
  pc.onDispose(settings.on('theme', () => cards.repaint()));

  // where the icons appear: a taskbar strip and the desktop's special icons, in the pack in use
  const scene = h('div', { class: 'pzb-icon-scene', dataset: { section: 'iconPreview' } });
  const paintScene = () => {
    const id = packs.iconPack;
    const tbApps = ['files', 'browser', 'mail', 'terminal', 'photos', 'settings'].filter((a) => reg.get(a));
    scene.replaceChildren(
      h(
        'div',
        { class: 'pzb-desk' },
        h('div', { class: 'pzb-desk-icon' }, fixedImg(packs.specialIcon(id, 'thispc'), 36), h('span', { class: 'caption' }, t('desktop.thisPc'))),
        h('div', { class: 'pzb-desk-icon' }, fixedImg(packs.specialIcon(id, 'trash'), 36), h('span', { class: 'caption' }, t('desktop.recycleBin'))),
      ),
      h('div', { class: 'pzb-tb', 'aria-hidden': 'true' }, h('span', { class: 'pzb-tb-start' }, pc.icon('grid', { size: 16, filled: true })), tbApps.map((a) => h('span', { class: 'pzb-tb-btn' }, fixedImg(packs.appIcon(id, a), 22)))),
    );
  };
  paintScene();
  pc.onDispose(settings.on('iconPack', paintScene));
  pc.onDispose(settings.on('accent', paintScene));
  pc.onDispose(settings.on('theme', paintScene));
  return h(
    'div',
    { class: 'pzs-page' },
    h('p', { class: 'pzs-intro text-2' }, t('pzs.iconIntro')),
    kit.group(t('pzs.iconPack'), h('div', { dataset: { section: 'iconPack' } }, cards)),
    kit.group(t('pzx.iconPreview'), h('p', { class: 'caption text-2 pzb-note' }, t('pzx.iconPreviewDesc')), scene),
    h('p', { class: 'caption text-2 pzs-after' }, `${t('pzs.iconNote')} ${t('pzx.iconSpecialNote')}`),
    kit.related([
      { icon: 'panel_bottom', title: pc.pageTitle('taskbar'), desc: pc.L(PAGES.taskbar.desc), onClick: () => pc.go('taskbar') },
      { icon: 'apps', title: pc.pageTitle('start'), desc: pc.L(PAGES.start.desc), onClick: () => pc.go('start') },
    ]),
  );
}

// ------------------------------------------------------------------ Sound packs
const EVENT_SOUND = { notification: 'notify', startup: 'startup', shutdown: 'shutdown' };
const soundName = (pc, id) => pc.L(SOUND_NAMES.find((s) => s.id === id)?.name || { en: id, fr: id });
const packName = (pc, id) => pc.L(SOUND_PACKS.find((p) => p.id === id)?.name || { en: id, fr: id });

/** Dialog: every sound of every pack (radio list with a play button each). Resolves to '<pack>.<sound>' or null. */
async function chooseSound(pc, ev, current) {
  const { h, t, ui, icon } = pc;
  let chosen = typeof current === 'string' && /^[a-z]+\.[a-zA-Z]+$/.test(current) ? current : null;
  const groups = sounds.choices(ev);
  const name = `pzb-snd-${ev}`;
  const body = h(
    'div',
    { class: 'pzb-sound-list', role: 'radiogroup', 'aria-label': t('pzx.chooseSound') },
    groups.map((g) =>
      h(
        'div',
        { class: 'pzb-sound-group', role: 'group', 'aria-label': pc.L(g.pack.name) },
        h('div', { class: 'pzb-sound-pack body-strong' }, pc.L(g.pack.name)),
        g.sounds.map((s) =>
          h(
            'label',
            { class: 'pzb-sound-item' },
            h('input', { type: 'radio', name, value: s.id, checked: s.id === chosen, onchange: () => (chosen = s.id) }),
            h('span', { class: 'grow' }, pc.L(s.sound.name), s.own ? h('span', { class: 'caption text-2' }, ` (${t('pzx.ownSound')})`) : null),
            h('button', { class: 'btn subtle icon-btn', type: 'button', 'aria-label': `${t('pzs.play')} — ${pc.L(g.pack.name)}, ${pc.L(s.sound.name)}`, onclick: (e) => (e.preventDefault(), sounds.preview(s.id, s.sound.id)) }, icon('play', { size: 14 })),
          ),
        ),
      ),
    ),
  );
  const r = await ui.dialog({ title: t('pzx.chooseSoundFor', { event: t(`pzs.ev_${ev}`) }), body, parent: pc.win, className: 'pzb-sound-dialog', buttons: [{ label: t('common.ok'), value: 'ok', primary: true }, { label: t('common.cancel'), value: null }] });
  return r === 'ok' ? chosen : null;
}

async function soundPacks(pc) {
  setup(pc);
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

  // every sound of the pack in use
  const packList = h('div', { class: 'pzb-pack-sounds' });
  const paintPackList = () => {
    const id = SOUND_PACKS.some((p) => p.id === settings.get('soundPack')) ? settings.get('soundPack') : 'aurora';
    const pat = sounds.packSounds(id) || {};
    packList.replaceChildren(
      ...SOUND_NAMES.filter((s) => pat[s.id]).map((s) =>
        h('button', { class: 'btn pzb-pack-sound', type: 'button', dataset: { sound: s.id }, onclick: () => sounds.preview(id, s.id) }, pc.icon('play', { size: 14 }), L(s.name)),
      ),
    );
  };
  paintPackList();
  pc.onDispose(settings.on('soundPack', paintPackList));
  const listen = kit.expander({ icon: 'speaker_2', title: t('pzx.packSounds'), desc: t('pzx.packSoundsDesc'), section: 'packSounds', body: () => packList });

  // per-event sound: the pack's, none, a pack's own sound for the event, any other sound, or an audio file
  const eventRow = (ev) => {
    const key = `soundEvents.${ev}`;
    const own = EVENT_SOUND[ev];
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
        ...SOUND_PACKS.filter((p) => p.id !== 'silent' && sounds.packSounds(p.id)?.[own]).map((p) => ({ value: `${p.id}.${own}`, label: L(p.name) })),
      ];
      const m = typeof v === 'string' ? /^([a-z]+)\.([a-zA-Z]+)$/.exec(v) : null;
      if (m && m[2] !== own) list.push({ value: v, label: t('pzx.soundOf', { pack: packName(pc, m[1]), sound: soundName(pc, m[2]) }) });
      list.push({ value: 'other', label: t('pzx.otherSound') });
      list.push('-');
      if (typeof v === 'string' && v.startsWith('/')) list.push({ value: v, label: fileLabel(v) });
      list.push({ value: 'file', label: t('pzs.soundBrowse') });
      return list;
    };
    const combo = kit.combo({
      label: t(`pzs.ev_${ev}`),
      options: options(),
      value: value(),
      width: 220,
      onChange: async (v) => {
        if (v === 'pack') return settings.set(key, null).then(() => true);
        if (v === 'other') {
          const picked = await chooseSound(pc, ev, settings.get(key));
          if (!picked) return false;
          await settings.set(key, picked);
          combo.setOptions(options(), value());
          return true;
        }
        if (v === 'file') {
          const picked = await ui.filePicker({ mode: 'open', title: t('pzs.soundBrowse'), filters: [{ name: t('pzs.audioFiles'), ext: AUDIO_EXT }], parent: pc.win }).catch(() => null);
          const path = Array.isArray(picked) ? picked[0] : picked;
          if (!path || typeof path !== 'string' || !AUDIO_EXT.some((x) => path.toLowerCase().endsWith(x))) return false;
          await settings.set(key, path);
          combo.setOptions(options(), value());
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
    const play = h('button', { class: 'btn subtle icon-btn pzs-play-ev', type: 'button', 'aria-label': `${t('pzs.play')} — ${t(`pzs.ev_${ev}`)}`, 'data-tip': t('pzs.play'), onclick: () => sounds.preview(settings.get(key) ?? null, own) }, pc.icon('play', { size: 14 }));
    return kit.row({ icon: { notification: 'alert', startup: 'power', shutdown: 'arrow_exit' }[ev], title: t(`pzs.ev_${ev}`), desc: t(`pzs.ev_${ev}Desc`), section: `ev-${ev}`, control: h('div', { class: 'pz-inline' }, play, combo) });
  };
  const offNote = kit.infobar({ kind: 'info', message: t('pzs.soundsOff'), className: 'pzs-sounds-off' });
  const paintOff = () => (offNote.hidden = settings.get('sounds') !== false);
  paintOff();
  pc.onDispose(settings.on('sounds', paintOff));
  const volume = liveSlider(pc, { key: 'soundVolume', min: 0, max: 100, step: 5, def: 100, label: t('pzx.volume'), format: (v) => pct(pc, v), iconStart: 'speaker_0', iconEnd: 'speaker_2' });
  return h(
    'div',
    { class: 'pzs-page' },
    h('p', { class: 'pzs-intro text-2' }, t('pzs.soundIntro')),
    offNote,
    kit.group(
      null,
      kit.row({ icon: 'speaker_2', title: t('pzs.systemSounds'), desc: t('pzs.systemSoundsDesc'), section: 'sounds', control: boundToggle(pc, 'sounds', true, t('pzs.systemSounds')) }),
      ctl(pc, { icon: 'speaker_1', title: t('pzx.volume'), desc: t('pzx.volumeDesc'), control: volume, stacked: true, section: 'soundVolume', className: 'pzb-volume' }),
      kit.row({ icon: 'power', title: t('pzx.startupSound'), desc: t('pzx.startupSoundDesc'), section: 'startupSound', control: boundToggle(pc, 'startupSound', true, t('pzx.startupSound')) }),
    ),
    kit.group(t('pzs.soundPack'), h('div', { dataset: { section: 'soundPack' } }, cards), listen),
    kit.group(t('pzs.soundEvents'), ...SOUND_EVENTS.map(eventRow)),
    kit.related([{ icon: 'speaker_2', title: pc.pageTitle('sound'), desc: pc.L(PAGES.sound.desc), onClick: () => pc.go('sound') }]),
  );
}

export default { cursors, iconPacks, soundPacks };
