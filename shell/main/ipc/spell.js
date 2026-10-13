'use strict';
// Spell check with LOCAL dictionaries (Courrier, Notes, Éditeur de texte, Navigateur text fields).
//
// Chromium's Hunspell reads <lang>-<ver>.bdic files from <userData>/Dictionaries and downloads missing ones from
// Google. Selene ships fr-FR and en-US in /usr/share/aurora/dictionaries (dev: rootfs/ of the checkout; refreshed by
// tools/fetch-dictionaries.sh) and copies them there before any session asks for them; the download URL points to
// a closed local port, so nothing is ever fetched from the network.
//
//   spell:status ()        -> { enabled, languages, dictionaries: [{ file, path }], dir }
//   spell:add (word)       -> true   « Ajouter au dictionnaire » (the session's custom dictionary, shared by every
//                                     session that has spell check: shell windows and browser tabs)
//   spell:languages (lang) -> languages, UI language first (after a language change)
// Other modules: require('./spell.js').prepare(session) enables the same languages on another session.
const fs = require('fs');
const path = require('path');
const { app, session } = require('electron');

const FILES = { 'fr-FR': 'fr-FR-3-0.bdic', 'en-US': 'en-US-10-1.bdic' };
const NO_DOWNLOAD = 'http://127.0.0.1:9/'; // discard port: a download attempt fails at once, offline
const WORD = /^[\p{L}\p{M}'’-]{1,64}$/u;

function sourceDirs(ROOT) {
  return [process.env.AURORA_DICT_DIR, '/usr/share/aurora/dictionaries', path.join(ROOT || path.join(__dirname, '..', '..'), '..', 'rootfs', 'usr', 'share', 'aurora', 'dictionaries')].filter(Boolean);
}

/** Copy the shipped .bdic files into <userData>/Dictionaries (only when missing or of another size). */
function installDictionaries(ROOT) {
  const dir = path.join(app.getPath('userData'), 'Dictionaries');
  const out = [];
  for (const [lang, file] of Object.entries(FILES)) {
    const src = sourceDirs(ROOT)
      .map((d) => path.join(d, file))
      .find((f) => fs.existsSync(f));
    if (!src) continue;
    const dst = path.join(dir, file);
    try {
      const same = fs.existsSync(dst) && fs.statSync(dst).size === fs.statSync(src).size;
      if (!same) {
        fs.mkdirSync(dir, { recursive: true });
        fs.copyFileSync(src, `${dst}.tmp`);
        fs.renameSync(`${dst}.tmp`, dst);
      }
      out.push({ lang, file, path: dst });
    } catch (err) {
      console.warn(`[spell] cannot install ${file}:`, err.message);
    }
  }
  return { dir, dictionaries: out };
}

let installed = { dir: '', dictionaries: [] };

/** Turn spell check on for a session with the local dictionaries (UI language first). */
function prepare(ses, lang) {
  if (!ses) return;
  try {
    ses.setSpellCheckerDictionaryDownloadURL(NO_DOWNLOAD);
    const have = installed.dictionaries.map((d) => d.lang);
    const first = String(lang || '').startsWith('fr') ? 'fr-FR' : 'en-US';
    const langs = [first, ...have.filter((l) => l !== first)].filter((l) => have.includes(l));
    if (!langs.length) {
      ses.setSpellCheckerEnabled(false);
      return;
    }
    ses.setSpellCheckerLanguages(langs);
    ses.setSpellCheckerEnabled(true);
  } catch (err) {
    console.warn('[spell] setup failed:', err.message);
  }
}

function register(api) {
  if (api.env.mode !== 'shell') return;
  installed = installDictionaries(api.ROOT);
  prepare(session.defaultSession, api.env.lang);
  // Spelling for the shell's own windows (apps) — each app turns it on only for prose fields (core/features/spell.js).
  api.handle('spell:status', () => ({
    enabled: session.defaultSession.isSpellCheckerEnabled(),
    languages: session.defaultSession.getSpellCheckerLanguages(),
    dictionaries: installed.dictionaries.map(({ file, path: p }) => ({ file, path: p })),
    dir: installed.dir,
  }));
  api.handle('spell:add', (word) => {
    const w = String(word || '').trim();
    if (!WORD.test(w)) throw api.error('Invalid word', 'EINVAL');
    return session.defaultSession.addWordToSpellCheckerDictionary(w);
  });
  api.handle('spell:languages', (lang) => {
    prepare(session.defaultSession, String(lang || ''));
    return session.defaultSession.getSpellCheckerLanguages();
  });
}

module.exports = register;
module.exports.register = register;
module.exports.prepare = prepare;
module.exports.installDictionaries = installDictionaries;
module.exports.FILES = FILES;
