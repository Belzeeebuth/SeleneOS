// Settings > Personalization > Cursors, Icon packs, Sound packs — STUBS (area B3 replaces this module).
// Keys: cursorPack, iconPack, soundPack, soundEvents { notification, startup, shutdown } (docs/PERSONALIZATION.md §1.2).
import { comingSoon } from './personalization-strings.js';

async function cursors(pc) {
  return comingSoon(pc, 'cursors', { keys: ['cursorPack'] });
}
async function iconPacks(pc) {
  return comingSoon(pc, 'iconPacks', { keys: ['iconPack'] });
}
async function soundPacks(pc) {
  return comingSoon(pc, 'soundPacks', { keys: ['soundPack', 'soundEvents'] });
}

export default { cursors, iconPacks, soundPacks };
