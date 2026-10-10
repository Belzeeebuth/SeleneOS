// Calendar — Windows 11 / Outlook-style calendar.
//   Views: Day, Work week, Week, Month, Agenda (+ search results); events with recurrence (RFC 5545
//   subset, DST-aware), exceptions, reminders through shell.reminders, holidays (France / United States),
//   .ics import / export. Data: ~/.config/aurora/apps/calendar/{events,calendars,prefs}.json
//   Launch args: { file: '/path/a.ics' } imports; { reminder: { data: { eventId, key } } } or
//   { open: { eventId, key } } opens an event; { date: 'YYYY-MM-DD', newEvent: true }.
//   Pure logic lives in lib/*.mjs (unit-tested in Node), the UI in ui/*.js.
import { CalendarApp } from './ui/app.js';

export default {
  async launch(ctx) {
    const app = new CalendarApp(ctx);
    ctx.win.el.__calendar = app; // test / debugging hook
    ctx.win.onBeforeClose(async () => {
      // an event being edited with unsaved changes: Save / Don't save / Cancel
      const st = app.editorState;
      if (!st || !st.dirty()) return true;
      const v = await ctx.ui.dialog({
        title: ctx.t('unsavedTitle'),
        body: ctx.t('unsavedBody'),
        parent: ctx.win,
        buttons: [
          { label: ctx.t('save'), value: 'save', primary: true },
          { label: ctx.t('dontSave'), value: 'discard' },
          { label: ctx.t('cancel'), value: null },
        ],
      });
      if (v === 'save') {
        st.done?.('save');
        // wait for the save to finish (the editor closes itself when it succeeds)
        for (let i = 0; i < 50 && app.editorState; i++) await new Promise((r) => setTimeout(r, 60));
        return !app.editorState;
      }
      return v === 'discard';
    });
    await app.init();
    return {
      calendar: app,
      onRelaunch(args = {}) {
        app.handleArgs(args || {});
      },
    };
  },
};
