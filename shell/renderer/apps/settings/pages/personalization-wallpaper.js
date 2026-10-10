// Settings > Personalization > Animated & dynamic wallpapers — STUB (area B1 replaces this module).
// Keys (defaults in main/ipc/settings.js, docs/PERSONALIZATION.md §1.2): wallpaperMode, animatedWallpaper,
// dynamicWallpaper; the separate lock screen picture (lockWallpaper) already has the 'lockscreen' page.
import { comingSoon } from './personalization-strings.js';

async function wallpaperEffects(pc) {
  return comingSoon(pc, 'wallpaperEffects', { keys: ['wallpaperMode', 'animatedWallpaper', 'dynamicWallpaper'] });
}

export default { wallpaperEffects };
