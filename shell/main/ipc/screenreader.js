'use strict';
// Screen reader — « Lecteur d'écran » (Paramètres > Accessibilité > Lecteur d'écran, Super+Alt+S).
// Orca runs for the session user and speaks through speech-dispatcher + espeak-ng in the UI language
// (packages: iso/packages.d/screen-reader.list). While it runs, Chromium accessibility is on so Orca can read the
// shell, its apps and web pages over AT-SPI.
//
//   screenreader:status                          -> { available, installed, running, chromium, chromiumWanted, simulated }
//   screenreader:start ({ lang, rate, voice })   -> status   (re)starts Orca with these settings (orca --replace)
//   screenreader:stop                            -> status   Orca says « Lecteur d'écran désactivé » as it quits
//   screenreader:voices (lang)                   -> [{ name, lang, variant }]  speech-dispatcher voices of that language
//   screenreader:test ({ lang, rate, voice, text }) -> true  speaks a sample with spd-say
//   event 'screenreader:changed' { running, crashed? }       broadcast when Orca starts, stops or dies
//
// rate: Orca's own scale 0–100 (50 = normal). voice: a speech-dispatcher voice name, '' = automatic (Orca then picks
// a voice of its locale, which we set to the UI language). Orca reads both from its prefs file
// (~/.local/share/orca/user-settings.conf): mergeOrcaPrefs() writes them in and keeps everything else the user set.
// Starting also sets org.gnome.desktop.a11y.applications screen-reader-enabled (at-spi-bus-launcher mirrors it into
// org.a11y.Status.ScreenReaderEnabled, which apps watch); stopping clears it, and Orca quits by itself on that.
//
// The shell also starts with --force-renderer-accessibility when the reader was on at sign-in (early(), called by
// main/index.js before the app is ready), so the shell's tree is complete from the first frame.
//
// Dev mode with no orca on PATH: simulated (nothing is run). Tests put fake orca / spd-say / gsettings on PATH.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { run, which } = require('../lib/exec');

const LOCALES = { fr: 'fr_FR.UTF-8', en: 'en_US.UTF-8' };
const VOICE_RE = /^[\p{L}\p{N} ()+_.,'’-]{1,64}$/u;

// ------------------------------------------------------------------ pure helpers (unit-tested)
const clampRate = (r) => {
  const n = Math.round(Number(r));
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 50;
};
const cleanLang = (l) => (/^[a-z]{2,3}$/.test(String(l || '')) ? String(l) : 'en');
const cleanVoice = (v) => (typeof v === 'string' && VOICE_RE.test(v) ? v : '');
/** Orca rate (0–100) -> speech-dispatcher rate (-100–100), the way Orca converts it. */
const sdRate = (r) => Math.round(2 * Math.max(0, Math.min(99, clampRate(r))) - 98);

/** Locale for Orca's process: the UI language, keeping the user's region when it already matches (fr_CA stays). */
function localeFor(lang, envLang = '') {
  const l = cleanLang(lang);
  const cur = String(envLang || '');
  if (cur.toLowerCase().startsWith(`${l}_`)) return cur;
  return LOCALES[l] || `${l}_${l.toUpperCase()}.UTF-8`;
}

/**
 * Parse `spd-say -L` (list of synthesis voices):
 *        NAME   LANGUAGE   VARIANT
 *        French (France)   fr   none
 * -> [{ name, lang, variant }] (variant null for "none"); header and junk lines skipped.
 */
function parseVoices(text) {
  const out = [];
  const seen = new Set();
  for (const line of String(text || '').split('\n')) {
    if (!line.trim() || /^\s*NAME\s+LANGUAGE\b/i.test(line)) continue;
    const m = /^\s*(.+?)\s+([a-z]{2,3}(?:-[A-Za-z0-9]{1,8})*)\s+(\S+)\s*$/.exec(line);
    if (!m || !VOICE_RE.test(m[1])) continue;
    const key = `${m[1]}\u0000${m[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name: m[1], lang: m[2], variant: m[3] === 'none' ? null : m[3] });
  }
  return out;
}
/** Voices of one language (fr matches fr, fr-FR, fr-BE…), the main region first. */
function voicesFor(list, lang) {
  const l = cleanLang(lang);
  const main = `${l}-${l === 'en' ? 'us' : l}`;
  return list
    .filter((v) => v.lang.toLowerCase() === l || v.lang.toLowerCase().startsWith(`${l}-`))
    .sort((a, b) => (a.lang.toLowerCase() === l || a.lang.toLowerCase() === main ? 0 : 1) - (b.lang.toLowerCase() === l || b.lang.toLowerCase() === main ? 0 : 1) || a.name.localeCompare(b.name));
}

// Orca's own defaults for the voices it expects (orca/settings.py).
const ORCA_VOICES = { default: {}, uppercase: { 'average-pitch': 7.0 }, hyperlink: {}, system: {} };
/**
 * Orca prefs (user-settings.conf, JSON) with our rate and voice in the starting profile's default voice; every
 * other setting is kept. A missing or unreadable file gives a minimal valid one (Orca fills in its defaults).
 * voiceLang: language of the chosen voice ('fr', 'fr-be'); voice '' removes the family so Orca follows its locale.
 */
function mergeOrcaPrefs(text, { rate, voice, voiceLang } = {}) {
  let p = null;
  try {
    p = text ? JSON.parse(text) : null;
  } catch {
    p = null;
  }
  if (!p || typeof p !== 'object' || Array.isArray(p)) p = {};
  for (const k of ['general', 'pronunciations', 'keybindings', 'profiles']) if (!p[k] || typeof p[k] !== 'object' || Array.isArray(p[k])) p[k] = {};
  const sp = Array.isArray(p.general.startingProfile) ? p.general.startingProfile[1] : null;
  const id = typeof sp === 'string' && sp ? sp : 'default';
  if (!p.profiles[id] || typeof p.profiles[id] !== 'object') p.profiles[id] = { profile: [id === 'default' ? 'Default' : id, id], pronunciations: {}, keybindings: {} };
  const prof = p.profiles[id];
  if (!prof.voices || typeof prof.voices !== 'object' || Array.isArray(prof.voices)) prof.voices = JSON.parse(JSON.stringify(ORCA_VOICES));
  for (const [k, v] of Object.entries(ORCA_VOICES)) if (!prof.voices[k] || typeof prof.voices[k] !== 'object') prof.voices[k] = { ...v };
  const dv = prof.voices.default;
  dv.rate = clampRate(rate);
  dv.established = true;
  const name = cleanVoice(voice);
  if (name) {
    const [l, d] = String(voiceLang || '').toLowerCase().split('-');
    dv.family = { name, lang: /^[a-z]{2,3}$/.test(l || '') ? l : '', dialect: /^[a-z0-9]{1,8}$/.test(d || '') ? d.toUpperCase() : '', variant: null };
  } else delete dv.family;
  return `${JSON.stringify(p, null, 4)}\n`;
}

/** Processes named orca of this user, from /proc (no pkill -f). */
function orcaPids(uid, procDir = '/proc') {
  const out = [];
  let ents = [];
  try {
    ents = fs.readdirSync(procDir);
  } catch {
    return out;
  }
  for (const e of ents) {
    if (!/^\d+$/.test(e) || Number(e) === process.pid) continue;
    try {
      if (fs.readFileSync(path.join(procDir, e, 'comm'), 'utf8').trim() !== 'orca') continue;
      const st = fs.readFileSync(path.join(procDir, e, 'status'), 'utf8');
      const m = /^Uid:\s+(\d+)/m.exec(st);
      if (m && Number(m[1]) === uid) out.push(Number(e));
    } catch {}
  }
  return out;
}

// ------------------------------------------------------------------ early (before app ready)
function readUserSettings() {
  try {
    return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.config', 'aurora', 'settings.json'), 'utf8')) || {};
  } catch {
    return {};
  }
}
/** Called by main/index.js before the app is ready: the reader was on at sign-in -> Chromium accessibility from the start. */
function early(app, mode) {
  if (mode !== 'shell') return;
  if (readUserSettings()?.screenReader?.enabled !== true) return;
  app.commandLine.appendSwitch('force-renderer-accessibility');
  process.env.ACCESSIBILITY_ENABLED = '1';
}

// ------------------------------------------------------------------ IPC
module.exports = function register(api) {
  if (api.env.mode !== 'shell') return;
  const { app } = require('electron');
  const uid = process.getuid?.() ?? 0;
  const prefsDir = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'orca');
  let child = null; // the Orca we started
  let simulated = false; // dev, no orca: pretend
  let running = false;
  let stopTimer = null;

  const available = () => !!which('orca') || api.DEV;
  const chromium = () => {
    try {
      return app.isAccessibilitySupportEnabled();
    } catch {
      return false;
    }
  };
  const status = () => ({ available: available(), installed: !!which('orca'), running, chromium: chromium(), chromiumWanted: wanted, simulated });
  const changed = (extra = {}) => api.broadcast('screenreader:changed', { ...status(), ...extra });
  let wanted = false; // Chromium accessibility requested by the reader
  const setChromium = (on) => {
    wanted = !!on;
    try {
      app.setAccessibilitySupportEnabled(!!on);
    } catch (err) {
      console.warn('[screenreader] accessibility support:', err.message);
    }
    if (on) process.env.ACCESSIBILITY_ENABLED = '1';
  };
  const gsettings = (on) => (which('gsettings') ? run('gsettings', ['set', 'org.gnome.desktop.a11y.applications', 'screen-reader-enabled', on ? 'true' : 'false'], { timeout: 4000 }).catch(() => null) : null);

  function writePrefs(rate, voice, voiceLang) {
    const file = path.join(prefsDir, 'user-settings.conf');
    let text = null;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {}
    fs.mkdirSync(prefsDir, { recursive: true });
    const tmp = `${file}.aurora-${process.pid}`;
    fs.writeFileSync(tmp, mergeOrcaPrefs(text, { rate, voice, voiceLang }));
    fs.renameSync(tmp, file);
  }

  async function voiceLangOf(voice, lang) {
    if (!voice) return '';
    const list = await listVoices().catch(() => []);
    return list.find((v) => v.name === voice)?.lang || cleanLang(lang);
  }

  async function listVoices() {
    if (!which('spd-say')) {
      if (!api.DEV) return [];
      return parseVoices(DEV_VOICES);
    }
    const r = await run('spd-say', ['-o', 'espeak-ng', '-L'], { timeout: 8000 });
    return parseVoices(r.stdout);
  }

  api.handle('screenreader:status', () => status());

  api.handle('screenreader:voices', async (lang) => voicesFor(await listVoices(), lang).slice(0, 60));

  api.handle('screenreader:start', async (opts = {}) => {
    const lang = cleanLang(opts?.lang || api.env.lang);
    const rate = clampRate(opts?.rate ?? 50);
    const voice = cleanVoice(opts?.voice);
    clearTimeout(stopTimer);
    if (!which('orca')) {
      if (!api.DEV) throw api.error('Orca is not installed', 'ENOENT');
      simulated = true;
      running = true;
      setChromium(true);
      changed();
      return status();
    }
    simulated = false;
    writePrefs(rate, voice, await voiceLangOf(voice, lang));
    await gsettings(true);
    setChromium(true);
    const locale = localeFor(lang, process.env.LANG);
    const env = { ...process.env, LANG: locale, LANGUAGE: lang, LC_MESSAGES: locale, ACCESSIBILITY_ENABLED: '1' };
    delete env.LC_ALL;
    const prev = child;
    const c = spawn(which('orca'), ['--replace'], { env, detached: true, stdio: 'ignore' });
    child = c;
    running = true;
    const t0 = Date.now();
    c.on('error', (err) => console.warn('[screenreader] orca:', err.message));
    c.on('exit', (code, sig) => {
      if (child !== c) return; // replaced by a newer Orca
      child = null;
      running = false;
      // died on its own (not stopped by us): tell the shell so the switch follows
      changed({ crashed: !c.aurora_stopping, code, signal: sig, early: Date.now() - t0 < 4000 });
    });
    c.unref();
    if (prev && prev.exitCode == null) prev.aurora_stopping = true; // `--replace` takes it over
    changed();
    return status();
  });

  api.handle('screenreader:stop', async () => {
    const wasSimulated = simulated;
    simulated = false;
    running = false;
    if (wasSimulated || !which('orca')) {
      setChromium(false);
      changed();
      return status();
    }
    if (child) child.aurora_stopping = true;
    // Orca quits by itself (and says so) when the key goes false; SIGTERM does the same if it did not listen.
    await gsettings(false);
    const pids = new Set(orcaPids(uid));
    if (child?.pid) pids.add(child.pid);
    clearTimeout(stopTimer);
    stopTimer = setTimeout(() => {
      for (const pid of pids) {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {}
      }
    }, 1500);
    // (Chromium may switch its accessibility back on by itself after it has been used — seen under Xvfb with windows
    // open; it then only costs some speed until the shell restarts. status().chromium tells.)
    setChromium(false);
    changed();
    return status();
  });

  api.handle('screenreader:test', async (opts = {}) => {
    const lang = cleanLang(opts?.lang || api.env.lang);
    const text = String(opts?.text || '').replace(/[\u0000-\u001f]/g, ' ').slice(0, 300).trim();
    if (!text) return false;
    if (!which('spd-say')) {
      if (api.DEV) return true;
      throw api.error('spd-say is not installed', 'ENOENT');
    }
    const args = ['-o', 'espeak-ng', '-l', lang, '-r', String(sdRate(opts?.rate ?? 50))];
    const voice = cleanVoice(opts?.voice);
    if (voice) args.push('-y', voice);
    args.push('--', text);
    await run('spd-say', args, { timeout: 8000 });
    return true;
  });
  // (no stop on quit: signing out takes Orca with the X session; after a shell crash the next shell replaces it)
};

// Voices shown in dev when spd-say is missing (the shape of `spd-say -o espeak-ng -L` on Ubuntu 24.04).
const DEV_VOICES = `                   NAME     LANGUAGE     VARIANT
        French (France)           fr        none
       French (Belgium)        fr-be        none
   French (Switzerland)        fr-ch        none
                English        en-gb        none
  English (America)        en-us        none
`;

module.exports.parsers = { parseVoices, voicesFor, mergeOrcaPrefs, localeFor, sdRate, clampRate, cleanVoice, orcaPids };
module.exports.early = early;
