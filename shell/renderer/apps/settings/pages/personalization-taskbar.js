// Settings > Personalization > Taskbar, Start (module owned by personalization area B2: taskbar size,
// position, labels, combine, widgets, transparency; Start layout, folders, background style — see
// docs/PERSONALIZATION.md §1.2). The current implementations were moved here unchanged from personalization.js.
// ------------------------------------------------------------------ Start
async function start(pc) {
  const { h, t, kit, settings, ui } = pc;
  return h(
    'div',
    null,
    kit.group(
      null,
      kit.settingToggleRow({ icon: 'history', title: t('pers.startRecent'), desc: t('pers.startRecentDesc'), key: 'startShowRecent', def: true }),
      kit.row({
        icon: 'pin',
        title: t('pers.resetStartPins'),
        desc: t('pers.resetStartPinsDesc'),
        control: kit.button(t('pers.reset'), async () => {
          if (await ui.confirm(t('pers.resetStartConfirm'), { title: t('pers.resetStartPins'), okLabel: t('pers.reset'), parent: pc.win })) {
            await settings.reset('startPinned');
            pc.toast(t('pers.resetDone'));
          }
        }),
      }),
      kit.row({ icon: 'apps', title: t('pers.openStart'), desc: t('pers.openStartDesc'), control: kit.button(t('common.open'), () => pc.shell.emit('start:toggle')) }),
    ),
  );
}

// ------------------------------------------------------------------ Taskbar
async function taskbar(pc) {
  const { h, t, kit, settings, ui } = pc;
  const tb = () => settings.get('taskbar') || {};
  const alignCombo = kit.combo({
    options: [
      { value: 'left', label: t('pers.alignLeft') },
      { value: 'center', label: t('pers.alignCenter') },
    ],
    value: tb().align === 'left' ? 'left' : 'center',
    label: t('pers.alignment'),
    onChange: (v) => settings.set('taskbar.align', v),
  });
  pc.onDispose(settings.on('taskbar', () => alignCombo.setValue(tb().align === 'left' ? 'left' : 'center')));
  return h(
    'div',
    null,
    kit.group(
      t('pers.taskbarItems'),
      kit.settingToggleRow({ icon: 'search', title: t('pers.tbSearch'), key: 'taskbar.showSearch', def: true, section: 'items' }),
      kit.settingToggleRow({ icon: 'window_multiple', title: t('pers.tbTaskView'), key: 'taskbar.showTaskView', def: true }),
      kit.settingToggleRow({ icon: 'board', title: t('pers.tbWidgets'), key: 'taskbar.showWidgets', def: false }),
    ),
    kit.group(
      t('pers.taskbarBehaviors'),
      kit.row({ icon: 'align_center_horizontal', title: t('pers.alignment'), desc: t('pers.alignmentDesc'), section: 'align', control: alignCombo }),
      kit.settingToggleRow({ icon: 'panel_bottom_contract', title: t('pers.autohide'), desc: t('pers.autohideDesc'), key: 'taskbar.autohide', def: false, section: 'autohide' }),
      kit.row({
        icon: 'pin',
        title: t('pers.resetTbPins'),
        desc: t('pers.resetTbPinsDesc'),
        control: kit.button(t('pers.reset'), async () => {
          if (await ui.confirm(t('pers.resetTbConfirm'), { title: t('pers.resetTbPins'), okLabel: t('pers.reset'), parent: pc.win })) {
            await settings.reset('pinned');
            pc.toast(t('pers.resetDone'));
          }
        }),
      }),
    ),
  );
}

export default { start, taskbar };
