// Animated wallpaper effects (settings.animatedWallpaper.id). Each module exports the effect contract described in
// core/wallpaper/engine.js. Order = gallery order in Settings.
import aurora from './aurora.js';
import bloom from './bloom.js';
import fluid from './fluid.js';
import bokeh from './bokeh.js';
import starfield from './starfield.js';
import waves from './waves.js';
import weather from './weather.js';

export const EFFECTS = [aurora, bloom, fluid, bokeh, starfield, waves];
export const WEATHER_EFFECT = weather;
export const effectById = (id) => EFFECTS.find((e) => e.id === id) || EFFECTS[0];
