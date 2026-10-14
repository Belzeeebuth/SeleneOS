// Podcasts & News (« Podcasts et actus »): RSS / Atom / RDF / JSON Feed reader and podcast player.
// Launch arguments: { file: '/path/subscriptions.opml' } imports an OPML file; { url: 'https://…' } opens « Ajouter un
// abonnement » with that address. See lib/app.js (application), lib/parse.js (feeds, OPML, autodiscovery),
// lib/sanitize.js (reading pane), lib/store.js (storage), lib/player.js (audio), main/ipc/feeds.js (network, downloads).
import { FeedsApp } from './lib/app.js';

export default {
  async launch(ctx) {
    const ref = { app: new FeedsApp(ctx) };
    const ready = ref.app.init();
    ready.then(
      () => ref.app?.handleArgs(ctx.args || {}),
      (err) => console.error('[feeds] start failed', err),
    );
    ctx.onClose(() => (ref.app = null));
    return {
      onRelaunch: (args) =>
        ready
          .then(() => ref.app?.handleArgs(args || {}))
          .catch(() => {}),
    };
  },
};
