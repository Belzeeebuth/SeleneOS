// Media Player pages. Each view(app, arg) returns { el, onMeta?(paths), title? }.
import { formatTime, compareText, baseName } from './util.js';
import { artEl, entryArt, pageHeader, btn, emptyState, sectionHead, tile, grid, SongList } from './components.js';

const SONG_SORTS = ['az', 'artist', 'album', 'year', 'added'];
const VIDEO_SORTS = ['az', 'added', 'duration'];

function sortSongs(app, list, by) {
  const loc = app.locale;
  const T = (e) => app.titleOf(e);
  const cmp =
    {
      az: (a, b) => compareText(T(a), T(b), loc),
      artist: (a, b) => compareText(app.artistOf(a), app.artistOf(b), loc) || compareText(app.albumOf(a), app.albumOf(b), loc) || (a.track || 999) - (b.track || 999) || compareText(T(a), T(b), loc),
      album: (a, b) => compareText(app.albumOf(a), app.albumOf(b), loc) || (a.track || 999) - (b.track || 999) || compareText(T(a), T(b), loc),
      year: (a, b) => (b.year || 0) - (a.year || 0) || compareText(T(a), T(b), loc),
      added: (a, b) => (b.mtime || 0) - (a.mtime || 0),
      duration: (a, b) => (b.duration || 0) - (a.duration || 0),
    }[by] || ((a, b) => compareText(T(a), T(b), loc));
  return [...list].sort(cmp);
}

function sortSelect(app, value, options, onChange) {
  const { h, t } = app;
  const sel = h(
    'select',
    { class: 'select mp-sort', 'aria-label': t('music.sort'), onchange: (e) => onChange(e.target.value) },
    options.map((o) => h('option', { value: o, selected: o === value }, t(`sort.${o}`))),
  );
  return h('label', { class: 'mp-sort-wrap' }, h('span', { class: 'text-2 caption' }, t('music.sort')), sel);
}

function scanningBar(app) {
  return app.lib.scanning
    ? app.h(
        'div',
        { class: 'mp-scan', role: 'status' },
        app.h('div', { class: 'progress indeterminate' }, app.h('div', { class: 'bar' })),
        app.h('span', { class: 'caption text-2' }, app.t('library.scanning')),
      )
    : null;
}

function folderList(app, kind) {
  const { h, icon } = app;
  return h(
    'div',
    { class: 'mp-folder-chips' },
    app.lib.folders[kind].map((f) => h('span', { class: 'mp-chip', 'data-tip': f }, icon('folder', { filled: true }), h('span', { class: 'ellipsis' }, f.replace(app.home, '~')))),
  );
}

function libraryActions(app, kind) {
  const { t } = app;
  return [
    btn(app, { label: t('library.addFolder'), icon: 'folder_add', onClick: () => app.addLibraryFolder(kind), cls: 'mp-add-folder' }),
    btn(app, { label: t('library.refresh'), icon: 'arrow_sync', iconOnly: true, subtle: true, onClick: () => app.refreshLibrary(), cls: 'mp-refresh' }),
  ];
}

function songListView(app, songs, opts) {
  const list = new SongList(app, songs, {
    context: opts.context,
    trackNumbers: opts.trackNumbers,
    label: opts.label,
    onPlay: (i) => app.playEntries(songs, i),
  });
  app.trackList(list);
  return list;
}

function heroActions(app, getPaths, { shuffle = true, extra = [] } = {}) {
  const { t } = app;
  return [
    btn(app, { label: t('music.playAll'), icon: 'play', primary: true, onClick: () => app.playEntries(getPaths(), 0, { shuffle: false }), cls: 'mp-play-all' }),
    shuffle ? btn(app, { label: t('music.shuffle'), icon: 'arrow_shuffle', onClick: () => app.playEntries(getPaths(), 0, { shuffle: true }), cls: 'mp-shuffle-all' }) : null,
    btn(app, { label: t('music.addTo'), icon: 'add', onClick: (e) => app._menu(e, app.addToMenuItems(getPaths().map((x) => x.path || x))), cls: 'mp-add-to' }),
    ...extra,
  ].filter(Boolean);
}

function hero(app, { art, kicker, title, lines = [], actions }) {
  const { h } = app;
  return h(
    'div',
    { class: 'mp-hero' },
    h('div', { class: 'mp-hero-art' }, art),
    h(
      'div',
      { class: 'mp-hero-text' },
      kicker ? h('div', { class: 'caption text-2 mp-kicker' }, kicker) : null,
      h('h1', { class: 'mp-hero-title' }, title),
      lines.filter(Boolean).map((l) => h('div', { class: 'text-2 ellipsis mp-hero-line' }, l)),
      h('div', { class: 'mp-hero-actions' }, actions),
    ),
  );
}

function mosaic(app, entries, key) {
  const { h } = app;
  const arts = [];
  for (const e of entries) {
    const src = e.kind === 'video' ? e.thumb : e.art;
    if (src && !arts.includes(src)) arts.push(src);
    if (arts.length === 4) break;
  }
  if (arts.length >= 4)
    return h(
      'div',
      { class: 'mp-art mp-mosaic' },
      arts.map((src) => h('img', { src: app.api.mediaUrl(src), alt: '', draggable: false })),
    );
  if (arts.length) return artEl(app, { src: arts[0], key });
  return artEl(app, { key, glyph: 'text_bullet_list' });
}

// ====================================================================== Home
export function homeView(app) {
  const { h, t, icon } = app;
  const el = h('div', { class: 'mp-page mp-home' });
  el.appendChild(
    pageHeader(app, t('nav.home'), {
      actions: [
        btn(app, { label: t('home.openFiles'), icon: 'document', onClick: () => app.openFiles(), cls: 'mp-open-files' }),
        btn(app, { label: t('home.openFolder'), icon: 'folder_open', onClick: () => app.openFolder(), cls: 'mp-open-folder' }),
      ],
    }),
  );
  const recent = app.recent
    .map((p) => app.lib.get(p))
    .filter(Boolean)
    .slice(0, 12);
  if (!recent.length) {
    el.appendChild(
      h(
        'div',
        { class: 'mp-welcome card' },
        h('img', { class: 'mp-welcome-logo', src: app.appUrl('icon.svg'), alt: '' }),
        h(
          'div',
          { class: 'mp-welcome-text' },
          h('div', { class: 'subtitle' }, t('home.welcomeTitle')),
          h('div', { class: 'text-2' }, t('home.welcomeBody')),
          h(
            'div',
            { class: 'mp-welcome-actions' },
            btn(app, { label: t('home.browseMusic'), icon: 'music_note_2', primary: true, onClick: () => app.go({ name: 'music' }) }),
            btn(app, { label: t('home.browseVideos'), icon: 'video', onClick: () => app.go({ name: 'videos' }) }),
          ),
        ),
      ),
    );
  } else {
    el.appendChild(sectionHead(app, t('home.recent')));
    el.appendChild(
      grid(
        app,
        recent.map((e) =>
          tile(app, {
            art: entryArt(app, e),
            title: app.titleOf(e),
            subtitle: e.kind === 'video' ? t('kind.video') : app.artistOf(e),
            path: e.path,
            onOpen: () => app.playEntries([e], 0, { openStage: e.kind === 'video' }),
            onPlay: () => app.playEntries([e], 0),
            onMenu: (ev) => app.itemMenu(ev, [e], { context: 'recent' }),
          }),
        ),
        { cls: 'mp-recent' },
      ),
    );
  }
  const pls = app.playlists.list();
  if (pls.length) {
    el.appendChild(sectionHead(app, t('nav.playlists'), { onSeeAll: () => app.go({ name: 'playlists' }) }));
    el.appendChild(
      grid(
        app,
        pls.slice(0, 6).map((pl) => playlistTile(app, pl)),
      ),
    );
  }
  const albums = app.albums().slice(0, 6);
  if (albums.length) {
    el.appendChild(sectionHead(app, t('home.music'), { onSeeAll: () => app.go({ name: 'music', arg: 'albums' }) }));
    el.appendChild(
      grid(
        app,
        albums.map((a) => albumTile(app, a)),
      ),
    );
  }
  const vids = app.lib.videos().slice(0, 6);
  if (vids.length) {
    el.appendChild(sectionHead(app, t('home.videos'), { onSeeAll: () => app.go({ name: 'videos' }) }));
    el.appendChild(
      grid(
        app,
        vids.map((v) => videoTile(app, v)),
        { wide: true },
      ),
    );
  }
  if (!albums.length && !vids.length && !app.lib.scanning) {
    el.appendChild(h('div', { class: 'mp-hint caption text-2' }, icon('info'), t('home.libraryHint')));
  }
  return { el, rerenderOnMeta: true };
}

// ====================================================================== Music
function albumTile(app, a) {
  return tile(app, {
    art: artEl(app, { src: a.art, key: a.key, glyph: 'music_note_2' }),
    title: a.title,
    subtitle: a.artist,
    onOpen: () => app.go({ name: 'album', arg: a.key }),
    onPlay: () => app.playEntries(a.songs, 0),
    onMenu: (ev) => app.itemMenu(ev, a.songs, { context: 'group' }),
  });
}
function artistTile(app, a) {
  return tile(app, {
    art: artEl(app, { src: a.art, key: a.key, glyph: 'person', round: true }),
    title: a.name,
    subtitle: app.t('count.songs', { count: a.songs.length }),
    round: true,
    onOpen: () => app.go({ name: 'artist', arg: a.key }),
    onPlay: () => app.playEntries(a.songs, 0),
    onMenu: (ev) => app.itemMenu(ev, a.songs, { context: 'group' }),
  });
}

export function musicView(app, tab = 'songs') {
  const { h, t } = app;
  if (!['songs', 'albums', 'artists'].includes(tab)) tab = 'songs';
  const el = h('div', { class: 'mp-page mp-music' });
  el.appendChild(pageHeader(app, t('nav.music'), { actions: libraryActions(app, 'music') }));
  el.appendChild(
    h(
      'div',
      { class: 'tabs mp-tabs', role: 'tablist' },
      ['songs', 'albums', 'artists'].map((k) =>
        h(
          'button',
          {
            class: ['tab', k === tab && 'selected'],
            role: 'tab',
            'aria-selected': k === tab ? 'true' : 'false',
            dataset: { tab: k },
            onclick: () => app.go({ name: 'music', arg: k }, { replace: true }),
          },
          t(`music.${k}`),
        ),
      ),
    ),
  );
  const scan = scanningBar(app);
  if (scan) el.appendChild(scan);
  const songs = app.lib.songs();
  if (!songs.length) {
    if (!app.lib.scanning) {
      el.appendChild(
        emptyState(app, {
          glyph: 'music_note_2',
          title: t('library.emptyMusicTitle'),
          body: t('library.emptyMusicBody'),
          extra: folderList(app, 'music'),
          actions: [btn(app, { label: t('library.addFolder'), icon: 'folder_add', primary: true, onClick: () => app.addLibraryFolder('music') })],
        }),
      );
    }
    return { el, rerenderOnMeta: true };
  }
  if (tab === 'songs') {
    const by = SONG_SORTS.includes(app.prefs.songSort) ? app.prefs.songSort : 'az';
    const sorted = sortSongs(app, songs, by);
    el.appendChild(
      h(
        'div',
        { class: 'mp-toolbar' },
        btn(app, { label: t('music.shufflePlay'), icon: 'arrow_shuffle', primary: true, onClick: () => app.playEntries(sorted, 0, { shuffle: true }), cls: 'mp-shuffle-play' }),
        sortSelect(app, by, SONG_SORTS, (v) => {
          app.setPref('songSort', v);
          app.render();
        }),
        h('span', { class: 'grow' }),
        h('span', { class: 'caption text-2 mp-count' }, t('count.songs', { count: sorted.length })),
      ),
    );
    const list = songListView(app, sorted, { context: 'library', label: t('music.songs') });
    el.appendChild(list.el);
    return { el, onMeta: (paths) => list.update(paths) };
  }
  if (tab === 'albums') {
    const albums = app.albums();
    el.appendChild(
      h(
        'div',
        { class: 'mp-toolbar' },
        btn(app, { label: t('music.shufflePlay'), icon: 'arrow_shuffle', primary: true, onClick: () => app.playEntries(songs, 0, { shuffle: true }) }),
        h('span', { class: 'grow' }),
        h('span', { class: 'caption text-2 mp-count' }, t('count.albums', { count: albums.length })),
      ),
    );
    el.appendChild(
      grid(
        app,
        albums.map((a) => albumTile(app, a)),
      ),
    );
    return { el, rerenderOnMeta: true };
  }
  const artists = app.artists();
  el.appendChild(
    h(
      'div',
      { class: 'mp-toolbar' },
      btn(app, { label: t('music.shufflePlay'), icon: 'arrow_shuffle', primary: true, onClick: () => app.playEntries(songs, 0, { shuffle: true }) }),
      h('span', { class: 'grow' }),
      h('span', { class: 'caption text-2 mp-count' }, t('count.artists', { count: artists.length })),
    ),
  );
  el.appendChild(
    grid(
      app,
      artists.map((a) => artistTile(app, a)),
    ),
  );
  return { el, rerenderOnMeta: true };
}

export function albumView(app, key) {
  const { h, t } = app;
  const a = app.albums().find((x) => x.key === key);
  const el = h('div', { class: 'mp-page mp-album' });
  if (!a) {
    el.appendChild(emptyState(app, { glyph: 'music_note_2', title: t('library.gone'), actions: [btn(app, { label: t('nav.music'), onClick: () => app.go({ name: 'music', arg: 'albums' }) })] }));
    return { el };
  }
  const total = a.songs.reduce((s, e) => s + (e.duration || 0), 0);
  el.appendChild(
    hero(app, {
      art: artEl(app, { src: a.art, key: a.key }),
      kicker: t('kind.album'),
      title: a.title,
      lines: [[a.artist, a.year].filter(Boolean).join(' · '), [t('count.songs', { count: a.songs.length }), total ? app.fmtTotal(total) : null].filter(Boolean).join(' · ')],
      actions: heroActions(app, () => a.songs),
    }),
  );
  const list = songListView(app, a.songs, { context: 'album', trackNumbers: a.songs.some((s) => s.track), label: a.title });
  el.appendChild(list.el);
  return { el, rerenderOnMeta: true };
}

export function artistView(app, key) {
  const { h, t } = app;
  const a = app.artists().find((x) => x.key === key);
  const el = h('div', { class: 'mp-page mp-artist' });
  if (!a) {
    el.appendChild(emptyState(app, { glyph: 'person', title: t('library.gone'), actions: [btn(app, { label: t('nav.music'), onClick: () => app.go({ name: 'music', arg: 'artists' }) })] }));
    return { el };
  }
  const albums = new Set(a.songs.map((s) => s.album || ''));
  el.appendChild(
    hero(app, {
      art: artEl(app, { src: a.art, key: a.key, glyph: 'person', round: true }),
      kicker: t('kind.artist'),
      title: a.name,
      lines: [[t('count.songs', { count: a.songs.length }), t('count.albums', { count: albums.size })].join(' · ')],
      actions: heroActions(app, () => sortSongs(app, a.songs, 'album')),
    }),
  );
  const list = songListView(app, sortSongs(app, a.songs, 'album'), { context: 'artist', label: a.name });
  el.appendChild(list.el);
  return { el, rerenderOnMeta: true };
}

// ====================================================================== Videos
function videoTile(app, v) {
  return tile(app, {
    art: entryArt(app, v, { wide: true }),
    title: app.titleOf(v),
    subtitle: [baseName(v.dir), v.mtime ? app.i18n.formatDate(v.mtime, { dateStyle: 'medium' }) : null].filter(Boolean).join(' · '),
    wide: true,
    path: v.path,
    badge: v.duration ? formatTime(v.duration) : null,
    onOpen: () => app.playEntries([v], 0, { openStage: true }),
    onPlay: () => app.playEntries([v], 0, { openStage: true }),
    onMenu: (ev) => app.itemMenu(ev, [v], { context: 'library' }),
  });
}

export function videosView(app) {
  const { h, t } = app;
  const el = h('div', { class: 'mp-page mp-videos' });
  el.appendChild(pageHeader(app, t('nav.videos'), { actions: libraryActions(app, 'video') }));
  const scan = scanningBar(app);
  if (scan) el.appendChild(scan);
  const vids = app.lib.videos();
  if (!vids.length) {
    if (!app.lib.scanning) {
      el.appendChild(
        emptyState(app, {
          glyph: 'video',
          title: t('library.emptyVideoTitle'),
          body: t('library.emptyVideoBody'),
          extra: folderList(app, 'video'),
          actions: [btn(app, { label: t('library.addFolder'), icon: 'folder_add', primary: true, onClick: () => app.addLibraryFolder('video') })],
        }),
      );
    }
    return { el, rerenderOnMeta: true };
  }
  const by = VIDEO_SORTS.includes(app.prefs.videoSort) ? app.prefs.videoSort : 'az';
  const sorted = sortSongs(app, vids, by);
  el.appendChild(
    h(
      'div',
      { class: 'mp-toolbar' },
      btn(app, { label: t('music.playAll'), icon: 'play', primary: true, onClick: () => app.playEntries(sorted, 0, { openStage: true }) }),
      sortSelect(app, by, VIDEO_SORTS, (v) => {
        app.setPref('videoSort', v);
        app.render();
      }),
      h('span', { class: 'grow' }),
      h('span', { class: 'caption text-2 mp-count' }, t('count.videos', { count: sorted.length })),
    ),
  );
  el.appendChild(
    grid(
      app,
      sorted.map((v) => videoTile(app, v)),
      { wide: true, cls: 'mp-video-grid' },
    ),
  );
  return { el, rerenderOnMeta: true };
}

// ====================================================================== Play queue
export function queueView(app) {
  const { h, t } = app;
  const q = app.queue;
  const el = h('div', { class: 'mp-page mp-queue' });
  el.appendChild(
    pageHeader(app, t('nav.queue'), {
      sub: q.length ? [t('count.items', { count: q.length }), app.fmtTotal(q.items.reduce((s, it) => s + (app.lib.get(it.path)?.duration || 0), 0))].filter(Boolean).join(' · ') : null,
      actions: [
        btn(app, { label: t('queue.addFiles'), icon: 'add', onClick: () => app.openFiles({ append: true }), cls: 'mp-queue-add' }),
        btn(app, { label: t('queue.save'), icon: 'album_add', disabled: !q.length, onClick: () => app.newPlaylist(q.items.map((i) => i.path)), cls: 'mp-queue-save' }),
        btn(app, { label: t('queue.clear'), icon: 'delete', disabled: !q.length, onClick: () => app.clearQueue(), cls: 'mp-queue-clear' }),
      ],
    }),
  );
  if (!q.length) {
    el.appendChild(
      emptyState(app, {
        glyph: 'text_bullet_list',
        title: t('queue.empty'),
        body: t('queue.emptyBody'),
        actions: [btn(app, { label: t('home.openFiles'), icon: 'document', primary: true, onClick: () => app.openFiles() })],
      }),
    );
    return { el };
  }
  const entries = q.items.map((it) => app.lib.get(it.path) || { path: it.path, kind: null, name: baseName(it.path), guessTitle: baseName(it.path) });
  const list = new SongList(app, entries, {
    context: 'queue',
    label: t('nav.queue'),
    currentIndex: () => app.queue.index,
    onPlay: (i) => app.playQueueIndex(i),
    onRemove: (idx) => app.removeFromQueue(idx),
    onMove: (from, to) => app.moveInQueue(from, to),
  });
  app.trackList(list);
  el.appendChild(list.el);
  return { el, onMeta: (paths) => list.update(paths), queueBound: true };
}

// ====================================================================== Playlists
export function playlistTile(app, pl) {
  const { t } = app;
  const entries = pl.items.map((p) => app.lib.get(p)).filter(Boolean);
  return tile(app, {
    art: mosaic(app, entries, pl.id),
    title: pl.name,
    subtitle: t('count.items', { count: pl.items.length }),
    onOpen: () => app.go({ name: 'playlist', arg: pl.id }),
    onPlay: pl.items.length ? () => app.playEntries(pl.items, 0) : null,
    onMenu: (ev) =>
      app._menu(ev, [
        { label: t('menu.play'), icon: 'play', disabled: !pl.items.length, action: () => app.playEntries(pl.items, 0) },
        { label: t('menu.playNext'), icon: 'arrow_next', disabled: !pl.items.length, action: () => app.playNext(pl.items) },
        { label: t('menu.addToQueue'), icon: 'text_bullet_list_add', disabled: !pl.items.length, action: () => app.addToQueue(pl.items) },
        '-',
        { label: t('playlists.rename'), icon: 'rename', action: () => app.renamePlaylist(pl.id) },
        { label: t('playlists.delete'), icon: 'delete', danger: true, action: () => app.deletePlaylist(pl.id) },
      ]),
  });
}

export function playlistsView(app) {
  const { h, t } = app;
  const el = h('div', { class: 'mp-page mp-playlists' });
  el.appendChild(pageHeader(app, t('nav.playlists'), { actions: [btn(app, { label: t('playlists.new'), icon: 'add', primary: true, onClick: () => app.newPlaylist(), cls: 'mp-new-playlist' })] }));
  const pls = app.playlists.list();
  if (!pls.length) {
    el.appendChild(
      emptyState(app, {
        glyph: 'album',
        title: t('playlists.empty'),
        body: t('playlists.emptyBody'),
        actions: [btn(app, { label: t('playlists.new'), icon: 'add', primary: true, onClick: () => app.newPlaylist() })],
      }),
    );
    return { el };
  }
  el.appendChild(
    grid(
      app,
      pls.map((pl) => playlistTile(app, pl)),
      { cls: 'mp-playlist-grid' },
    ),
  );
  return { el, rerenderOnMeta: true };
}

export function playlistView(app, id) {
  const { h, t } = app;
  const pl = app.playlists.get(id);
  const el = h('div', { class: 'mp-page mp-playlist' });
  if (!pl) {
    el.appendChild(emptyState(app, { glyph: 'album', title: t('library.gone'), actions: [btn(app, { label: t('nav.playlists'), onClick: () => app.go({ name: 'playlists' }) })] }));
    return { el };
  }
  const entries = pl.items.map((p) => app.lib.get(p) || { path: p, kind: null, name: baseName(p), guessTitle: baseName(p) });
  const total = entries.reduce((s, e) => s + (e.duration || 0), 0);
  el.appendChild(
    hero(app, {
      art: mosaic(app, entries, pl.id),
      kicker: t('kind.playlist'),
      title: pl.name,
      lines: [[t('count.items', { count: pl.items.length }), total ? app.fmtTotal(total) : null].filter(Boolean).join(' · ')],
      actions: [
        ...(pl.items.length ? heroActions(app, () => pl.items.map((p) => app.lib.get(p) || { path: p })) : []),
        btn(app, { label: t('playlists.addMedia'), icon: 'document_add', onClick: () => app.addFilesToPlaylist(pl.id), cls: 'mp-pl-add' }),
        btn(app, {
          label: t('transport.more'),
          icon: 'more_horizontal',
          iconOnly: true,
          cls: 'mp-pl-more',
          onClick: (e) =>
            app._menu(e, [
              { label: t('playlists.rename'), icon: 'rename', action: () => app.renamePlaylist(pl.id) },
              { label: t('playlists.delete'), icon: 'delete', danger: true, action: () => app.deletePlaylist(pl.id) },
            ]),
        }),
      ],
    }),
  );
  if (!pl.items.length) {
    el.appendChild(emptyState(app, { glyph: 'text_bullet_list_add', title: t('playlists.emptyPlaylist'), body: t('playlists.emptyPlaylistBody') }));
    return { el };
  }
  const list = new SongList(app, entries, {
    context: 'playlist',
    playlistId: pl.id,
    label: pl.name,
    onPlay: (i) => app.playEntries(pl.items, i),
    onRemove: (idx) => app.playlists.removeAt(pl.id, idx),
    onMove: (from, to) => app.playlists.move(pl.id, from, to),
  });
  app.trackList(list);
  el.appendChild(list.el);
  return { el, onMeta: (paths) => list.update(paths) };
}

// ====================================================================== Search
export function searchView(app, query) {
  const { h, t } = app;
  const q = String(query || '')
    .trim()
    .toLowerCase();
  const el = h('div', { class: 'mp-page mp-search' });
  el.appendChild(pageHeader(app, t('search.results', { q: query })));
  const match = (...s) => s.some((x) => x && String(x).toLowerCase().includes(q));
  const songs = q ? app.lib.songs().filter((e) => match(app.titleOf(e), e.artist, e.album, e.name, e.genre)) : [];
  const vids = q ? app.lib.videos().filter((e) => match(app.titleOf(e), e.name)) : [];
  const albums = q ? app.albums().filter((a) => match(a.title, a.artist)) : [];
  const artists = q ? app.artists().filter((a) => match(a.name)) : [];
  const pls = q ? app.playlists.list().filter((p) => match(p.name)) : [];
  if (!songs.length && !vids.length && !albums.length && !artists.length && !pls.length) {
    el.appendChild(emptyState(app, { glyph: 'search', title: t('search.none', { q: query }), body: t('search.noneBody') }));
    return { el };
  }
  if (songs.length) {
    el.appendChild(sectionHead(app, `${t('music.songs')} (${songs.length})`));
    const sorted = sortSongs(app, songs, 'az');
    el.appendChild(songListView(app, sorted, { context: 'search', label: t('music.songs') }).el);
  }
  if (vids.length) {
    el.appendChild(sectionHead(app, `${t('home.videos')} (${vids.length})`));
    el.appendChild(
      grid(
        app,
        vids.map((v) => videoTile(app, v)),
        { wide: true },
      ),
    );
  }
  if (albums.length) {
    el.appendChild(sectionHead(app, `${t('music.albums')} (${albums.length})`));
    el.appendChild(
      grid(
        app,
        albums.map((a) => albumTile(app, a)),
      ),
    );
  }
  if (artists.length) {
    el.appendChild(sectionHead(app, `${t('music.artists')} (${artists.length})`));
    el.appendChild(
      grid(
        app,
        artists.map((a) => artistTile(app, a)),
      ),
    );
  }
  if (pls.length) {
    el.appendChild(sectionHead(app, `${t('nav.playlists')} (${pls.length})`));
    el.appendChild(
      grid(
        app,
        pls.map((p) => playlistTile(app, p)),
      ),
    );
  }
  return { el, rerenderOnMeta: true };
}

// ====================================================================== Settings
export function settingsView(app) {
  const { h, t, icon, ui } = app;
  const el = h('div', { class: 'mp-page mp-settings' });
  el.appendChild(pageHeader(app, t('nav.settings')));
  const folderCard = (kind) => {
    const rows = app.lib.folders[kind].map((f) =>
      h(
        'div',
        { class: 'mp-set-folder' },
        icon('folder', { filled: true, class: 'mp-folder-ic' }),
        h('span', { class: 'ellipsis grow selectable', title: f }, f),
        btn(app, {
          label: t('settings.remove'),
          icon: 'dismiss',
          iconOnly: true,
          subtle: true,
          onClick: () => app.removeLibraryFolder(kind, f),
          cls: 'mp-remove-folder',
        }),
      ),
    );
    return h(
      'div',
      { class: 'mp-set-card', dataset: { kind } },
      h(
        'div',
        { class: 'mp-set-row' },
        icon(kind === 'music' ? 'music_note_2' : 'video', { class: 'mp-set-ic' }),
        h('div', { class: 'grow' }, h('div', null, t(kind === 'music' ? 'settings.musicFolders' : 'settings.videoFolders')), h('div', { class: 'caption text-2' }, t('settings.foldersHint'))),
        btn(app, { label: t('library.addFolder'), icon: 'folder_add', onClick: () => app.addLibraryFolder(kind) }),
      ),
      rows.length ? h('div', { class: 'mp-set-sub' }, rows) : h('div', { class: 'mp-set-sub caption text-2 mp-set-none' }, t('settings.noFolders')),
    );
  };
  const vizSel = ui.select({
    options: ['bars', 'wave', 'off'].map((v) => ({ value: v, label: t(`settings.viz.${v}`) })),
    value: app.prefs.visualizer,
    onchange: (v) => app.setPref('visualizer', v),
  });
  vizSel.classList.add('mp-viz-select');
  const resume = ui.toggle({ checked: app.prefs.resume !== false, onchange: (v) => app.setPref('resume', v) });
  resume.classList.add('mp-resume-toggle');
  const autoStage = ui.toggle({ checked: app.prefs.videoStage !== false, onchange: (v) => app.setPref('videoStage', v) });
  const row = (ic, title, hint, control) =>
    h(
      'div',
      { class: 'mp-set-card' },
      h('div', { class: 'mp-set-row' }, icon(ic, { class: 'mp-set-ic' }), h('div', { class: 'grow' }, h('div', null, title), hint ? h('div', { class: 'caption text-2' }, hint) : null), control),
    );
  el.append(
    h('h2', { class: 'mp-set-section' }, t('settings.library')),
    folderCard('music'),
    folderCard('video'),
    row('arrow_sync', t('settings.rescan'), t('settings.rescanHint'), btn(app, { label: t('library.refresh'), onClick: () => app.refreshLibrary() })),
    h('h2', { class: 'mp-set-section' }, t('settings.playback')),
    row('data_bar_vertical_add', t('settings.visualizer'), document.documentElement.dataset.animations === 'off' ? t('settings.vizAnimOff') : t('settings.visualizerHint'), vizSel),
    row('history', t('settings.resume'), t('settings.resumeHint'), resume),
    row('video', t('settings.videoStage'), t('settings.videoStageHint'), autoStage),
    h('h2', { class: 'mp-set-section' }, t('settings.about')),
    row('image_arrow_counterclockwise', t('settings.cache'), t('settings.cacheHint'), btn(app, { label: t('settings.clear'), onClick: () => app.clearCache(), cls: 'mp-clear-cache' })),
    row('keyboard', t('shortcuts.title'), null, btn(app, { label: t('shortcuts.show'), onClick: () => app.showShortcuts() })),
    h(
      'div',
      { class: 'mp-set-card mp-about' },
      h('img', { src: app.appUrl('icon.svg'), alt: '', width: 32, height: 32 }),
      h(
        'div',
        null,
        h('div', { class: 'body-strong' }, t('app.name')),
        h('div', { class: 'caption text-2' }, t('settings.version', { v: '1.0' })),
        h('div', { class: 'caption text-2' }, t('settings.aboutBody')),
      ),
    ),
  );
  return { el };
}
