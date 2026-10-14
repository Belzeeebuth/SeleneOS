// Aide (apps/help): when the shell offers the one-time « Découvrez Selene » notification
// (renderer/core/features/help-welcome.js; the « shown » mark itself is the app's storage, storage:get/set 'help').
//   help:welcome () -> { enabled, live, delay }
//     enabled: false in the live session; false in dev / test shells unless AURORA_HELP_WELCOME=1, so other
//     suites and developers never see it; delay: ms after the desktop is ready (AURORA_HELP_WELCOME_DELAY_MS, 8000).
module.exports = function register(api) {
  api.handle('help:welcome', () => {
    const live = !!api.env?.live;
    const forced = process.env.AURORA_HELP_WELCOME === '1';
    const d = process.env.AURORA_HELP_WELCOME_DELAY_MS;
    const delay = d != null && /^\d{1,7}$/.test(d) ? Number(d) : 8000;
    return { enabled: !live && (!api.DEV || forced), live, delay };
  });
};
