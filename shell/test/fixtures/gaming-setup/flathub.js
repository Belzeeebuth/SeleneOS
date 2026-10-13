'use strict';
// Stub Flathub source for test/gaming-setup.test.mjs (loaded by main/ipc/store.js through AURORA_STORE_SOURCES_DIR,
// dev only): the six gaming apps of the installer's « Jeux » step + two others, simulated per-user installs with
// progress. Control files in AURORA_GAMING_STUB_CTL (read at each install, so a test can change them while it runs):
//   offline  exists -> install fails with ENET (no network)
//   fail     one flatpak id per line -> install of that id fails with EFLATPAK
// AURORA_GAMING_STUB_STEP_MS: delay of each of the 10 progress steps (default 60).
const fs = require('fs');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function iconFor(name, color) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect x="4" y="4" width="56" height="56" rx="14" fill="${color}"/><text x="32" y="42" font-family="sans-serif" font-size="28" font-weight="700" fill="#fff" text-anchor="middle">${name[0]}</text></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}
const APPS = [
  ['com.valvesoftware.Steam', 'Steam', 'Launcher for the Steam software distribution service', 'Lanceur du service de distribution Steam', '#1b2838'],
  ['com.heroicgameslauncher.hgl', 'Heroic Games Launcher', 'An Epic Games, GOG and Amazon Prime Games launcher', 'Un lanceur pour Epic Games, GOG et Amazon Prime Games', '#7c3aed'],
  ['net.lutris.Lutris', 'Lutris', 'Video game preservation platform', 'Plateforme de préservation des jeux vidéo', '#e8a33d'],
  ['net.davidotek.pupgui2', 'ProtonUp-Qt', 'Install Wine- and Proton-based compatibility tools', 'Installez des outils de compatibilité basés sur Wine et Proton', '#2d7dd2'],
  ['com.usebottles.bottles', 'Bottles', 'Run Windows software', 'Exécutez des logiciels Windows', '#3fa34d'],
  ['com.discordapp.Discord', 'Discord', 'Messaging, voice and video client', 'Messagerie, voix et vidéo', '#5865f2'],
  ['org.mozilla.firefox', 'Firefox', 'Fast, Private & Safe Web Browser', 'Navigateur web rapide, privé et sûr', '#e66000'],
  ['org.gimp.GIMP', 'GNU Image Manipulation Program', 'Create images and edit photographs', 'Créez des images et retouchez des photos', '#5c5543'],
].map(([id, name, summary, summaryFr, color]) => ({
  source: 'flathub',
  id,
  appId: id,
  name,
  summary,
  summaryFr,
  icon: iconFor(name, color),
  categories: id.startsWith('org.') ? (id.includes('GIMP') ? ['Graphics'] : ['Network']) : id === 'com.discordapp.Discord' ? ['Network'] : ['Game'],
  desktopId: `${id}.desktop`,
}));

const state = { installed: new Map(), ctx: null };
const ctl = (name) => (process.env.AURORA_GAMING_STUB_CTL ? path.join(process.env.AURORA_GAMING_STUB_CTL, name) : null);
const fr = () => (state.ctx?.api?.settings?.get?.('lang') || state.ctx?.env?.lang) === 'fr';
const view = ({ summaryFr, ...it }) => ({ ...it, summary: fr() ? summaryFr : it.summary, installed: state.installed.has(it.id) });
const err = (message, code) => Object.assign(new Error(message), { code });

module.exports = {
  id: 'flathub',
  label: { en: 'Flathub', fr: 'Flathub' },
  init(ctx) {
    state.ctx = ctx;
  },
  async status() {
    return { available: true, ready: true, updatedAt: Date.now() - 3600 * 1000, count: APPS.length };
  },
  async refresh() {
    return { count: APPS.length };
  },
  async search({ query = '', category = '', offset = 0, limit = 60 } = {}) {
    const q = String(query).toLowerCase().trim();
    const list = APPS.filter((it) => (!category || it.categories.includes(category)) && (!q || `${it.name} ${it.summary} ${it.id}`.toLowerCase().includes(q))).sort((a, b) => a.name.localeCompare(b.name));
    return { items: list.slice(offset, offset + Math.min(limit, 60)).map(view), total: list.length };
  },
  async details(id) {
    const it = APPS.find((i) => i.id === id);
    if (!it) throw err(`unknown app ${id}`, 'ENOENT');
    return { ...view(it), description: `${it.name}. ${fr() ? it.summaryFr : it.summary}.`, homepage: `https://example.org/${id}`, license: 'GPL-3.0-or-later', version: '1.0.0', downloadSize: 300e6 };
  },
  async installed() {
    return [...state.installed].map(([id, version]) => ({ id, version }));
  },
  async install(id, onProgress) {
    const it = APPS.find((i) => i.id === id);
    if (!it) throw err(`unknown app ${id}`, 'ENOENT');
    const step = Number(process.env.AURORA_GAMING_STUB_STEP_MS || 60);
    if (ctl('offline') && fs.existsSync(ctl('offline'))) {
      await sleep(step);
      throw err(fr() ? 'Pas de connexion réseau : Flathub est injoignable' : 'No network connection: Flathub could not be reached', 'ENET');
    }
    let failing = [];
    try {
      failing = fs.readFileSync(ctl('fail'), 'utf8').split('\n').map((s) => s.trim());
    } catch {}
    for (let k = 1; k <= 10; k++) {
      await sleep(step);
      if (k === 4 && failing.includes(id)) throw err(fr() ? 'Échec de Flatpak : le téléchargement a été interrompu' : 'Flatpak failed: the download was interrupted', 'EFLATPAK');
      onProgress?.({ percent: k * 10, message: k === 10 ? 'Done' : 'Installing…' });
    }
    state.installed.set(id, '1.0.0');
    return { desktopId: it.desktopId };
  },
  async remove(id) {
    state.installed.delete(id);
    return {};
  },
};
