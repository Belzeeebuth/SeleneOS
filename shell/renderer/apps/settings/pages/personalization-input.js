// Settings > Personalization > Keyboard shortcuts, Snap layouts — STUBS (area B3 replaces this module).
// Keys: shortcuts { [actionId]: combo | null }, snapPresets [{ id, name, zones }] (docs/PERSONALIZATION.md §1.2).
import { comingSoon } from './personalization-strings.js';

async function shortcuts(pc) {
  return comingSoon(pc, 'shortcuts', { keys: ['shortcuts'] });
}
async function snapPresets(pc) {
  return comingSoon(pc, 'snapPresets', { keys: ['snapPresets'] });
}

export default { shortcuts, snapPresets };
