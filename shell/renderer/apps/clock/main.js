// Clock (Selene): Focus, Timer, Alarm, Stopwatch, World clock and Settings.
//   lib/store.js    state + background service (survives the window; mirrors alarms, timers and focus
//                   sessions into shell.reminders so they fire while Clock is closed)
//   lib/app.js      window layout, navigation, routing, render loop, keyboard, relaunch arguments
//   lib/page-*.js   one module per page          lib/time.js, lib/sun.js   pure time / solar math
//   lib/widgets.js  ring, analog face, spin pickers, command bar          data/  cities + world map
// Launch arguments: { page: 'focus'|'timer'|'alarm'|'stopwatch'|'world'|'settings' } or, from a
// notification click, { reminder: { id, data: { alarmId } | { timerId } | { focus } } }.
import { ClockApp } from './lib/app.js';

export default {
  async launch(ctx) {
    const app = new ClockApp(ctx);
    await app.init();
    return {
      onRelaunch: (args) => app.onRelaunch(args),
    };
  },
};
