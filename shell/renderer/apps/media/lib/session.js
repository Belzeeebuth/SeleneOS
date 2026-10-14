// The Lecteur as a media session for the shell (core/features/mediactl.js) and, through it, on the session bus as
// org.mpris.MediaPlayer2.selene (helpers/aurora-sessionbus): KDE Connect, a phone, playerctl, the media keys and the
// media card in Réglages rapides control it.
//
//   const off = bindSession(app)   while the window is open; off() withdraws the player (window closed)
//   shell bus:  emits 'mediactl:state' (state | null), 'mediactl:seeked' (position s)
//               handles 'mediactl:call' { method: PlayPause|Play|Pause|Stop|Next|Previous|Seek (offset s)|
//               SetPosition (position s)|OpenUri (path)|Raise|Quit|Set (prop: Volume|Rate|LoopStatus|Shuffle, value) }
//   state = { active, identity, status: Playing|Paused|Stopped, track: { id, title, artist, album, length (s), art
//             (cached cover, absolute path) } | null, position, rate, volume (0-1), loop: None|Track|Playlist, shuffle,
//             canNext, canPrev, canPlay, canPause, canSeek }
import { kindOf } from './util.js';

const LOOP = { off: 'None', one: 'Track', all: 'Playlist' };
const REPEAT = { None: 'off', Track: 'one', Playlist: 'all' };

/** The Lecteur's state as MPRIS sees it (pure apart from reading the app). */
export function sessionState(app) {
  const { player, queue } = app;
  const cur = queue.current;
  const e = cur ? app.currentEntry() : null;
  const loaded = !!player.path;
  const length = player.duration || e?.duration || 0;
  return {
    active: true,
    identity: app.t('app.name'),
    status: !loaded ? 'Stopped' : player.paused ? 'Paused' : 'Playing',
    track: e
      ? {
          id: cur.uid,
          title: app.titleOf(e),
          artist: e.kind === 'video' || kindOf(e.path) === 'video' ? e.artist || '' : e.artist || e.guessArtist || '',
          album: e.album || '',
          length: Math.round(length * 1000) / 1000,
          art: e.art || e.thumb || '',
        }
      : null,
    position: loaded ? player.currentTime : 0,
    rate: player.rate,
    volume: player.muted ? 0 : player.volume,
    loop: LOOP[queue.repeat] || 'None',
    shuffle: !!queue.shuffle,
    canNext: queue.peekNext() >= 0,
    canPrev: queue.length > 0,
    canPlay: !!cur || app.lib.songs().length > 0,
    canPause: loaded,
    canSeek: loaded && length > 0,
  };
}

export function bindSession(app) {
  const { shell, player, queue } = app;
  let timer = 0;
  let closed = false;
  const send = () => {
    timer = 0;
    if (closed || app._destroyed) return;
    shell.emit('mediactl:state', sessionState(app));
  };
  // several player / queue events come together (load, meta, state): one update for all of them
  const soon = () => {
    if (!timer) timer = setTimeout(send, 30);
  };
  const offs = ['state', 'load', 'meta', 'volume', 'rate'].map((ev) => player.on(ev, soon));
  offs.push(queue.on(soon));
  offs.push(
    app.lib.on((ev) => {
      if (ev.type === 'meta' && ev.paths?.includes(player.path)) soon();
    }),
  );
  const onSeeked = () => !closed && shell.emit('mediactl:seeked', player.currentTime);
  player.el.addEventListener('seeked', onSeeked);
  offs.push(() => player.el.removeEventListener('seeked', onSeeked));
  offs.push(shell.on('mediactl:call', (c) => call(app, c)));
  send();
  return () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    for (const off of offs) off?.();
    shell.emit('mediactl:state', null);
  };
}

function call(app, c) {
  if (!c || app._destroyed) return;
  const { player, queue } = app;
  switch (c.method) {
    case 'PlayPause':
      return app.togglePlay();
    case 'Play':
      return player.loaded && !player.paused ? null : app.togglePlay();
    case 'Pause':
      return player.pause();
    case 'Stop':
      player.pause();
      return player.loaded ? player.seek(0) : null;
    case 'Next':
      return app.next();
    case 'Previous':
      return app.prev();
    case 'Seek':
      return player.loaded ? player.seekBy(Number(c.offset) || 0) : null;
    case 'SetPosition':
      return player.loaded ? player.seek(Math.max(0, Number(c.position) || 0)) : null;
    case 'OpenUri':
      return typeof c.path === 'string' ? app.openArgs({ files: [c.path] }) : null;
    case 'Raise':
      if (app.win.minimized) app.win.restoreFromMinimize?.();
      return app.win.focus();
    case 'Quit':
      return app.win.close();
    case 'Set':
      if (c.prop === 'Volume') return app.setVolume(Number(c.value) || 0);
      if (c.prop === 'Rate') return Number(c.value) > 0 ? app.setRate(Number(c.value)) : player.pause();
      if (c.prop === 'LoopStatus' && REPEAT[c.value]) return queue.setRepeat(REPEAT[c.value]);
      if (c.prop === 'Shuffle') return queue.setShuffle(!!c.value);
      return null;
    default:
      return null;
  }
}
