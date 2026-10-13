// Screen reader backend (main/ipc/screenreader.js): unit tests, no Electron, nothing spoken.
//
//   node test/screenreader.unit.mjs
//
// spd-say voice list parser, voices of the UI language, Orca prefs merge (keeps the user's own Orca settings),
// Orca's locale, rate conversion, voice-name validation, finding the user's orca processes in a fake /proc.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { parsers: p } = require('../main/ipc/screenreader.js');
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
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// `spd-say -o espeak-ng -L` (speech-dispatcher 0.12, right-aligned columns)
const LIST = `                   NAME     LANGUAGE     VARIANT
              Afrikaans           af        none
        French (France)        fr-FR        none
       French (Belgium)        fr-BE        none
   French (Switzerland)        fr-CH        none
                 French           fr        none
      English (America)        en-US        none
                English        en-GB        none
                Español           es      Annie
         Bad;name$(rm)           fr        none
        French (France)        fr-FR        none
garbage line
`;
console.log('\n# spd-say -L');
const all = p.parseVoices(LIST);
check(all.length === 8 && all[0].name === 'Afrikaans' && all[0].variant === null && all[7].variant === 'Annie', `parses names with spaces, languages and variants (${all.length})`);
check(!all.some((v) => /[;$]/.test(v.name)) && all.filter((v) => v.name === 'French (France)').length === 1, 'drops unsafe names and duplicates');
const fr = p.voicesFor(all, 'fr');
check(eq(fr.map((v) => v.name), ['French', 'French (France)', 'French (Belgium)', 'French (Switzerland)']), `French voices, main region first: ${fr.map((v) => v.name).join(', ')}`);
check(eq(p.voicesFor(all, 'en').map((v) => v.lang), ['en-US', 'en-GB']), 'English voices (en-US first)');
check(p.parseVoices('').length === 0 && p.parseVoices(null).length === 0, 'empty output');

console.log('\n# Orca prefs');
const fresh = JSON.parse(p.mergeOrcaPrefs(null, { rate: 72, voice: '', voiceLang: '' }));
check(fresh.profiles.default.voices.default.rate === 72 && !('family' in fresh.profiles.default.voices.default) && eq(fresh.profiles.default.profile, ['Default', 'default']), 'no file: minimal prefs, rate set, no voice family (Orca follows its locale)');
check(fresh.profiles.default.voices.uppercase['average-pitch'] === 7 && 'hyperlink' in fresh.profiles.default.voices && 'system' in fresh.profiles.default.voices && eq(fresh.general, {}), "Orca's other voices are there");
const user = {
  general: { startingProfile: ['Travail', 'travail'], enableEchoByWord: true, orcaModifierKeys: ['Caps_Lock'] },
  pronunciations: { GNOME: ['GNOME', 'gnome'] },
  keybindings: {},
  profiles: {
    default: { profile: ['Default', 'default'], voices: { default: { rate: 40 } } },
    travail: { profile: ['Travail', 'travail'], enableKeyEcho: false, voices: { default: { rate: 30, 'average-pitch': 6, family: { name: 'English', lang: 'en' } }, uppercase: { 'average-pitch': 8 } } },
  },
};
const merged = JSON.parse(p.mergeOrcaPrefs(JSON.stringify(user), { rate: 85, voice: 'French (Belgium)', voiceLang: 'fr-BE' }));
const tv = merged.profiles.travail.voices;
check(tv.default.rate === 85 && eq(tv.default.family, { name: 'French (Belgium)', lang: 'fr', dialect: 'BE', variant: null }) && tv.default['average-pitch'] === 6, 'starting profile gets the rate and the voice; its pitch is kept');
check(merged.general.enableEchoByWord === true && eq(merged.general.orcaModifierKeys, ['Caps_Lock']) && merged.pronunciations.GNOME && merged.profiles.travail.enableKeyEcho === false && tv.uppercase['average-pitch'] === 8 && merged.profiles.default.voices.default.rate === 40, "the user's other Orca settings are untouched");
const auto = JSON.parse(p.mergeOrcaPrefs(JSON.stringify(merged), { rate: 50, voice: '' }));
check(!('family' in auto.profiles.travail.voices.default) && auto.profiles.travail.voices.default.rate === 50, 'automatic voice removes the family again');
const broken = JSON.parse(p.mergeOrcaPrefs('{not json', { rate: 500, voice: 'x;rm -rf /' }));
check(broken.profiles.default.voices.default.rate === 100 && !('family' in broken.profiles.default.voices.default), 'unreadable file -> fresh prefs; rate clamped; unsafe voice ignored');
check(p.mergeOrcaPrefs('[]', {}).includes('"rate": 50'), 'array JSON -> fresh prefs with the default rate');

console.log('\n# locale, rate, voice names');
check(p.localeFor('fr', 'en_US.UTF-8') === 'fr_FR.UTF-8' && p.localeFor('fr', 'fr_CA.UTF-8') === 'fr_CA.UTF-8' && p.localeFor('en', '') === 'en_US.UTF-8' && p.localeFor('$(x)', '') === 'en_US.UTF-8', 'Orca locale follows the UI language, keeps a matching region');
check(p.sdRate(50) === 2 && p.sdRate(0) === -98 && p.sdRate(100) === 100 && p.sdRate('abc') === 2, 'Orca rate -> speech-dispatcher rate like Orca does');
check(p.cleanVoice('French (France)') === 'French (France)' && p.cleanVoice('fr+Annie') === 'fr+Annie' && p.cleanVoice('a`b') === '' && p.cleanVoice('-x'.padEnd(80, 'x')) === '' && p.cleanVoice(3) === '', 'voice names: letters, spaces, () + only');

console.log('\n# orca processes (fake /proc)');
const proc = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-proc-'));
const mk = (pid, comm, uid) => {
  fs.mkdirSync(path.join(proc, String(pid)));
  fs.writeFileSync(path.join(proc, String(pid), 'comm'), `${comm}\n`);
  fs.writeFileSync(path.join(proc, String(pid), 'status'), `Name:\t${comm}\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`);
};
mk(101, 'orca', 1000);
mk(102, 'orca', 0);
mk(103, 'orca-helper', 1000);
mk(104, 'bash', 1000);
fs.mkdirSync(path.join(proc, 'self'));
check(eq(p.orcaPids(1000, proc), [101]) && eq(p.orcaPids(0, proc), [102]) && eq(p.orcaPids(1000, path.join(proc, 'nope')), []), "only this user's processes named exactly orca");
fs.rmSync(proc, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
