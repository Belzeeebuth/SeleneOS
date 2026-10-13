// Screen reader — « Lecteur d'écran » (Paramètres > Accessibilité > Lecteur d'écran, Super+Alt+S, Réglages rapides).
//
//   xvfb-run -a -s "-screen 0 1600x900x24" node test/screenreader.test.mjs
//
// Runs against fake orca / spd-say / gsettings put first on PATH (they only log what they are asked; nothing is
// spoken and the machine's real settings are never touched):
// 1. Settings page: voices of the UI language, the switch starts Orca (--replace) in French with Chromium accessibility
//    on and the a11y gsettings key set; rate and voice land in Orca's prefs and restart it; « Écouter » runs spd-say.
// 2. Accessibility tree (page.ariaSnapshot): taskbar, Lanceur, Réglages rapides, window title bars, the page itself —
//    every button has a name.
// 3. Super+Alt+S (shortcut trigger and a real key press) turns it off / on with a toast; Réglages rapides row.
// 4. Orca dying turns the switch off; the reader comes back at the next sign-in with --force-renderer-accessibility.
// Screenshots (1280x720, FR, Halo): test/out/screenreader-*.png
import { launchShell, OUT } from './lib.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let passed = 0;
const failures = [];
function check(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  ok  ${msg}`);
  } else {
    failures.push(msg);
    console.log(`  FAIL ${msg}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ fake tools
const FAKE = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-fake-'));
const LOG = path.join(FAKE, 'calls.log');
const PIDF = path.join(FAKE, 'orca.pid');
fs.writeFileSync(LOG, '');
const script = (name, body) => {
  fs.writeFileSync(path.join(FAKE, name), `#!/bin/bash\n${body}\n`);
  fs.chmodSync(path.join(FAKE, name), 0o755);
};
// orca: logs its arguments and environment; --replace stops the previous one (like Orca does); TERM = quit
script(
  'orca',
  `echo "orca $* LANG=$LANG LANGUAGE=$LANGUAGE LC_ALL=\${LC_ALL:-} A11Y=$ACCESSIBILITY_ENABLED" >> "$SR_LOG"
if [ -s "$SR_PID" ]; then kill -TERM "$(cat "$SR_PID")" 2>/dev/null; fi
echo $$ > "$SR_PID"
trap 'echo "orca-term $$" >> "$SR_LOG"; exit 0' TERM
while :; do sleep 0.1; done`,
);
script(
  'spd-say',
  `echo "spd-say $*" >> "$SR_LOG"
if [ "$*" = "-o espeak-ng -L" ]; then cat <<'EOF'
                   NAME     LANGUAGE     VARIANT
        French (France)        fr-FR        none
       French (Belgium)        fr-BE        none
   French (Switzerland)        fr-CH        none
      English (America)        en-US        none
EOF
fi`,
);
script('gsettings', 'echo "gsettings $*" >> "$SR_LOG"');
const ENV = { PATH: `${FAKE}:${process.env.PATH}`, SR_LOG: LOG, SR_PID: PIDF };
const log = () => fs.readFileSync(LOG, 'utf8');
async function waitFor(fn, ms = 6000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await sleep(150);
  }
  return false;
}
const count = (re) => (log().match(re) || []).length;
function killFakeOrca(sig = 'SIGTERM') {
  try {
    process.kill(Number(fs.readFileSync(PIDF, 'utf8')), sig);
  } catch {}
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-home-sr-'));
const prefsFile = path.join(home, '.local', 'share', 'orca', 'user-settings.conf');
const prefs = () => {
  try {
    return JSON.parse(fs.readFileSync(prefsFile, 'utf8'));
  } catch {
    return null;
  }
};
const unnamedButtons = (snap) => snap.split('\n').filter((l) => /^\s*- (button|switch|slider|checkbox|tab|menuitem)(:|\s*\[|$)/.test(l));

let s;
try {
  s = await launchShell({ lang: 'fr', theme: 'dark', size: '1280x720', home, env: ENV, settle: 1000 });
  const A = (fn, arg) => s.aurora(fn, arg);
  const page = s.page;

  // ================================================================ 1. Settings page
  console.log('\n# Paramètres > Accessibilité > Lecteur d’écran');
  await A(() => window.__aurora.registry.launch('settings', { page: 'screenReader' }));
  await page.waitForSelector('.st-screenreader', { timeout: 15000 });
  await sleep(700);
  const st0 = await A(() => window.__aurora.api.invoke('screenreader:status'));
  check(st0.available && st0.installed && !st0.running && !st0.chromium, `status before: available, not running, Chromium accessibility off (${JSON.stringify(st0)})`);
  const voices = await A(() => window.__aurora.api.invoke('screenreader:voices', 'fr'));
  check(voices.map((v) => v.name).join('|') === 'French (France)|French (Belgium)|French (Switzerland)', `French voices from spd-say: ${voices.map((v) => v.name).join(', ')}`);
  const comboText = await page.locator('.st-screenreader [data-section="voice"] .st-combo-text, .st-screenreader .st-combo .st-combo-text').first().textContent();
  check(/Automatique \(français\)/.test(comboText), `voice: « ${comboText} » by default`);
  const kbd = await page.locator('.st-screenreader .pzs-keys').first().getAttribute('aria-label');
  check(kbd === 'Super + Alt + S', `shortcut shown: ${kbd}`);
  await s.shot('screenreader-settings-fr-dark-off');

  // the switch
  await page.locator('.st-screenreader input[role="switch"]').first().click({ force: true });
  check(await waitFor(() => /orca --replace LANG=fr_FR\.UTF-8 LANGUAGE=fr LC_ALL= A11Y=1/.test(log())), 'switch on: orca --replace in French (LANG fr_FR, LANGUAGE fr, no LC_ALL), ACCESSIBILITY_ENABLED=1');
  check(/gsettings set org\.gnome\.desktop\.a11y\.applications screen-reader-enabled true/.test(log()), 'screen-reader-enabled set to true (AT-SPI ScreenReaderEnabled)');
  const st1 = await A(() => window.__aurora.api.invoke('screenreader:status'));
  const chromium1 = await s.app.evaluate(({ app }) => app.isAccessibilitySupportEnabled());
  check(st1.running && st1.chromium && chromium1, `running, Chromium accessibility on (${chromium1})`);
  check(prefs()?.profiles?.default?.voices?.default?.rate === 50 && !prefs()?.profiles?.default?.voices?.default?.family, "Orca prefs: normal rate, automatic voice (Orca's locale)");
  check((await A(() => window.__aurora.settings.get('screenReader.enabled'))) === true, 'setting screenReader.enabled = true');

  // rate
  await A(() => window.__aurora.settings.set('screenReader.rate', 70));
  check(await waitFor(() => prefs()?.profiles?.default?.voices?.default?.rate === 70 && count(/^orca --replace/gm) === 2), 'rate 70 -> prefs rate 70, Orca restarted');
  check(await waitFor(() => /orca-term/.test(log())), 'the previous Orca quit (replaced)');
  const sliderVal = await page.locator('.st-screenreader [data-section="rate"] .st-slider-val').textContent();
  check(sliderVal === '70', `slider follows (${sliderVal})`);

  // voice, picked in the combo
  await page.locator('.st-screenreader [data-section="voice"] .st-combo').click();
  await page.locator('.menu.st-combo-menu .menu-item', { hasText: 'Français (Belgique)' }).click();
  check(
    await waitFor(() => {
      const f = prefs()?.profiles?.default?.voices?.default?.family;
      return f && f.name === 'French (Belgium)' && f.lang === 'fr' && f.dialect === 'BE' && count(/^orca --replace/gm) === 3;
    }),
    'voice French (Belgium) -> Orca prefs family {fr, BE}, Orca restarted',
  );

  // Écouter
  await page.locator('.st-screenreader .sr-test').click();
  check(await waitFor(() => /spd-say -o espeak-ng -l fr -r 42 -y French \(Belgium\) -- Bonjour ! Voici la voix de votre lecteur d’écran\./.test(log())), 'Écouter: spd-say in French at the chosen rate and voice');
  await sleep(400);
  await s.shot('screenreader-settings-fr-dark');

  // ================================================================ 2. accessibility tree
  console.log('\n# Accessibility tree');
  const tb = await page.locator('#taskbar').ariaSnapshot();
  check(/toolbar "Barre des tâches"/.test(tb) && /button "Lanceur"/.test(tb) && /button "Paramètres/.test(tb), `taskbar: named toolbar, named app buttons${/toolbar "Barre/.test(tb) ? '' : `\n${tb.slice(0, 600)}`}`);
  check(unnamedButtons(tb).length === 0, `taskbar: no unnamed control ${unnamedButtons(tb).join(' / ')}`);
  const win = await page.locator('#windows').ariaSnapshot();
  check(/dialog "Paramètres/.test(win) && /button "Réduire"/.test(win) && /button "Agrandir"/.test(win) && /button "Fermer"/.test(win), `window: named, title bar buttons named${/dialog "Paramètres/.test(win) ? '' : `\n${win.slice(0, 400)}`}`);
  check(/switch "Lecteur d’écran" \[checked\]/.test(win) && /slider "Vitesse de la voix"/.test(win) && /button "Voix"/.test(win) && /button "Écouter"/.test(win), 'page: switch (checked), rate slider, voice combo and Écouter are named');
  check(unnamedButtons(win).length === 0, `Settings window: no unnamed control ${unnamedButtons(win).slice(0, 5).join(' / ')}`);
  await A(() => window.__aurora.shell.emit('start:toggle'));
  await sleep(900);
  const st = await page.locator('#start').ariaSnapshot();
  check(/dialog "Lanceur"/.test(st) && /list "Épinglées"/.test(st) && /listitem: Navigateur/.test(st), 'Lanceur: named dialog, « Épinglées » list of named tiles');
  check(unnamedButtons(st).length === 0, `Lanceur: no unnamed control ${unnamedButtons(st).join(' / ')}`);
  const tiles = await page.locator('#start .start-grid .start-tile').evaluateAll((els) => els.map((e) => [e.tagName, e.tabIndex]));
  check(tiles.length > 4 && tiles.every(([tag]) => tag === 'BUTTON') && tiles.filter(([, ti]) => ti === 0).length === 1, `Lanceur tiles are buttons with one tab stop (${tiles.length})`);
  await A(() => window.__aurora.shell.emit('start:close'));
  await sleep(300);
  await A(() => window.__aurora.shell.emit('quick:toggle'));
  await sleep(900);
  const qs = await page.locator('body').ariaSnapshot();
  const qsPart = qs.slice(qs.indexOf('dialog "Réglages rapides"'));
  check(qs.includes('dialog "Réglages rapides"') && /button "Accessibilité/.test(qsPart) && /slider "Volume"/.test(qsPart), 'Réglages rapides: named dialog, tiles and slider');
  check(unnamedButtons(qsPart.split('\n- ')[0]).length === 0, `Réglages rapides: no unnamed control ${unnamedButtons(qsPart.split('\n- ')[0]).join(' / ')}`);
  // its accessibility page has the screen reader row (on)
  await A(() => window.__aurora.quick.showPage('a11y'));
  await sleep(700);
  const qa = await page.locator('.qs-a11y').first().ariaSnapshot().catch(() => '');
  const rowOn = await page.locator('.qs-a11y-row', { hasText: 'Lecteur d’écran' }).locator('input').isChecked().catch(() => null);
  check(rowOn === true, `Réglages rapides > Accessibilité: « Lecteur d’écran » row, on (${rowOn})`);
  check(qa && !/^\s*- (switch|checkbox)\s*(\[|$)/m.test(qa) && /checkbox "Lecteur d’écran" \[checked\]/.test(qa), `its switches have names${/checkbox "Lecteur/.test(qa) ? '' : `\n${qa}`}`);
  await s.shot('screenreader-quick-fr-dark');
  await A(() => window.__aurora.shell.emit('flyouts:close'));
  await sleep(400);

  // ================================================================ 3. Super+Alt+S
  console.log('\n# Super+Alt+S');
  const bound = await A(() => window.__aurora.hotkeys.bindings['Super+Alt+S']);
  check(bound === 'screenReader', `Super+Alt+S is bound to the screen reader (${bound})`);
  const terms0 = count(/orca-term/g);
  await A(() => window.__aurora.hotkeys.trigger('Super+Alt+S'));
  check(await waitFor(async () => (await A(() => window.__aurora.settings.get('screenReader.enabled'))) === false), 'Super+Alt+S turns it off');
  check(await waitFor(() => /screen-reader-enabled false/.test(log()) && count(/orca-term/g) > terms0, 5000), 'off: screen-reader-enabled false, Orca quits (TERM after its own shutdown chance)');
  check(await waitFor(() => page.locator('#toasts').textContent().then((x) => x.includes('Lecteur d’écran désactivé'))), 'toast « Lecteur d’écran désactivé »');
  await s.shot('screenreader-toast-off-fr-dark');
  const st2 = await A(() => window.__aurora.api.invoke('screenreader:status'));
  const chromium2 = await s.app.evaluate(({ app }) => app.isAccessibilitySupportEnabled());
  check(!st2.running && st2.chromiumWanted === false, `not running, Chromium accessibility released (now ${chromium2 ? 'still on: Chromium turned it back on by itself' : 'off'})`);
  // a real key press, captured by the main process
  const starts0 = count(/^orca --replace/gm);
  await page.keyboard.down('Meta');
  await page.keyboard.down('Alt');
  await page.keyboard.press('s');
  await page.keyboard.up('Alt');
  await page.keyboard.up('Meta');
  const pressed = await waitFor(async () => (await A(() => window.__aurora.settings.get('screenReader.enabled'))) === true, 4000);
  if (!pressed) await A(() => window.__aurora.hotkeys.trigger('Super+Alt+S')); // xvfb without a Super modifier: same path
  check(await waitFor(() => count(/^orca --replace/gm) > starts0), `Super+Alt+S turns it back on (${pressed ? 'real key press' : 'shortcut trigger'})`);
  check(await waitFor(() => page.locator('#toasts').textContent().then((x) => x.includes('Lecteur d’écran activé'))), 'toast « Lecteur d’écran activé »');

  // ================================================================ 4. Orca dies; next sign-in
  console.log('\n# Orca crash, next sign-in');
  await sleep(800);
  killFakeOrca('SIGKILL');
  check(await waitFor(async () => (await A(() => window.__aurora.settings.get('screenReader.enabled'))) === false), 'Orca killed -> the switch turns off');
  check(await waitFor(() => page.locator('#toasts').textContent().then((x) => x.includes('Le lecteur d’écran s’est arrêté'))), 'toast « Le lecteur d’écran s’est arrêté »');
  await s.close();
  s = null;

  // the reader was on when the user signed out
  fs.writeFileSync(LOG, '');
  fs.rmSync(PIDF, { force: true });
  s = await launchShell({ home, keepHome: true, size: '1280x720', env: ENV, settings: { lang: 'fr', theme: 'light', screenReader: { enabled: true, rate: 70, voice: 'French (Belgium)' } }, settle: 1200 });
  check(await waitFor(() => /orca --replace LANG=fr_FR\.UTF-8/.test(log())), 'next sign-in: Orca starts with the session');
  const sw = await s.app.evaluate(({ app }) => [app.commandLine.hasSwitch('force-renderer-accessibility'), app.isAccessibilitySupportEnabled()]);
  check(sw[0] && sw[1], `Chromium accessibility from the first frame (--force-renderer-accessibility ${sw[0]}, enabled ${sw[1]})`);
  await s.aurora(() => window.__aurora.registry.launch('settings', { page: 'screenReader' }));
  await s.page.waitForSelector('.st-screenreader', { timeout: 15000 });
  await sleep(900);
  await s.shot('screenreader-settings-fr-light');
  await s.aurora(() => window.__aurora.settings.set('screenReader.enabled', false));
  check(await waitFor(() => /screen-reader-enabled false/.test(log())), 'turned off before leaving');
  await sleep(1800);
} catch (err) {
  failures.push(`exception: ${err.stack || err}`);
  console.log(err);
} finally {
  if (s) await s.close();
  killFakeOrca('SIGKILL');
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(FAKE, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failures.length} failed (screenshots in ${OUT})`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
