// Builds index.html for the "Clair de lune" mockup (static, self-contained apart from fonts, icons and wallpapers).
// Usage: node gen-assets.mjs && node build.mjs
import { writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOGO, crescent } from './gen-assets.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const PH = '/tmp/claude-0/-home-user-claudeai-test/43a764b0-782a-59d4-b82c-ab1cdd8af354/scratchpad/designkit/phosphor-icons-core-2.1.1/package/assets';
const names = JSON.parse(readFileSync(join(here, 'icons/names.json'), 'utf8'));

// Phosphor icon, inlined (currentColor).
const ic = (name, weight = 'regular', cls = '') => {
  const file = weight === 'regular' ? `${name}.svg` : `${name}-${weight}.svg`;
  const inner = readFileSync(join(PH, weight, file), 'utf8').replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
  return `<svg class="ph ${cls}" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">${inner}</svg>`;
};
const app = (id, cls = '') => `<img class="appicon ${cls}" src="icons/${id}.svg" alt="">`;
const logoSvg = (cls = '') => `<svg class="logo ${cls}" viewBox="0 0 48 48" aria-hidden="true"><path d="${LOGO.LOGO_PATH}" fill="url(#logo-grad)"/><path d="${LOGO.STAR_PATH}" fill="url(#logo-grad)"/></svg>`;

/* ----------------------------------------------------------------- bar */
const dock = [
  ['fichiers', 'active'], ['navigateur', 'running'], ['courrier', ''], ['calendrier', 'running'],
  ['lecteur', 'running'], ['photos', ''], ['terminal', ''], ['logitheque', ''], ['parametres', ''],
];
const bar = `
<nav class="bar" aria-label="Barre">
  <div class="pill glass pill-left">
    <button class="launcher-btn" aria-label="Lanceur">${logoSvg()}</button>
    <button class="bar-search">${ic('magnifying-glass')}<span>Rechercher</span></button>
  </div>
  <div class="pill glass pill-apps" role="toolbar" aria-label="Applications">
    ${dock.map(([id, st]) => `<button class="dock-app ${st}" aria-label="${names[id]}">${app(id)}<i class="dot"></i></button>`).join('')}
  </div>
  <div class="pill glass pill-status">
    <button class="tray">${ic('wifi-high')}${ic('speaker-high')}${ic('battery-high')}<span class="pct">82&nbsp;%</span></button>
    <button class="clock"><span class="date">dim. 11 oct.</span><span class="time">21:40</span></button>
    <button class="bell" aria-label="Notifications, 1 nouvelle">${ic('bell')}<i class="badge"></i></button>
  </div>
</nav>`;

/* ------------------------------------------------------------- windows */
const winButtons = `<div class="wbtns">
  <button aria-label="Réduire">${ic('minus')}</button>
  <button aria-label="Agrandir">${ic('square')}</button>
  <button class="close" aria-label="Fermer">${ic('x')}</button></div>`;

const side = [
  ['Emplacements', [['house', 'Dossier personnel'], ['desktop', 'Bureau'], ['file-text', 'Documents', 'sel'], ['download-simple', 'Téléchargements'], ['image', 'Images'], ['music-notes', 'Musique'], ['film-strip', 'Vidéos']]],
  ['Appareils', [['hard-drives', 'Ordinateur'], ['usb', 'Clé USB (16 Go)'], ['trash', 'Corbeille']]],
];
const ftype = {
  dir: ['folder-simple', 'fill', 't-dir'], pdf: ['file-pdf', 'regular', 't-pdf'], ods: ['file-xls', 'regular', 't-ods'],
  odt: ['file-doc', 'regular', 't-odt'], jpg: ['file-image', 'regular', 't-img'], txt: ['file-text', 'regular', 't-txt'], zip: ['file-zip', 'regular', 't-zip'],
};
const rows = [
  ['dir', 'Administratif', '3 oct. 2026 à 17:52', 'Dossier', '14 éléments'],
  ['dir', 'Factures', '28 sept. 2026 à 09:10', 'Dossier', '32 éléments'],
  ['dir', 'Voyage à Lisbonne', '5 oct. 2026 à 22:31', 'Dossier', '9 éléments'],
  ['pdf', "Attestation d'assurance habitation.pdf", 'Hier à 18:12', 'Document PDF', '214 Ko', 'sel'],
  ['ods', 'Budget familial 2026.ods', '8 oct. 2026 à 21:05', 'Feuille de calcul', '48 Ko'],
  ['odt', 'Compte rendu copropriété.odt', '6 oct. 2026 à 20:47', 'Document texte', '31 Ko'],
  ['jpg', "Photo d'identité.jpg", '29 sept. 2026 à 14:02', 'Image JPEG', '1,2 Mo'],
  ['txt', 'Recette tarte aux pommes.txt', "Aujourd'hui à 19:20", 'Texte brut', '2 Ko'],
  ['pdf', 'Relevé de compte septembre.pdf', '2 oct. 2026 à 09:31', 'Document PDF', '86 Ko'],
  ['zip', 'Sauvegarde contacts.zip', '21 sept. 2026 à 11:48', 'Archive ZIP', '3,4 Mo'],
];
const files = `
<section class="win win-files active" aria-label="Fichiers">
  <header class="titleband">${app('fichiers', 'ti')}<h2>Documents</h2><span class="app-name">Fichiers</span>${winButtons}</header>
  <div class="toolbar">
    <button class="ib" aria-label="Précédent">${ic('arrow-left')}</button>
    <button class="ib" disabled aria-label="Suivant">${ic('arrow-right')}</button>
    <button class="ib" aria-label="Dossier parent">${ic('arrow-up')}</button>
    <ol class="crumbs"><li><button>${ic('house')}Dossier personnel</button></li><li class="sep">${ic('caret-right')}</li><li><button class="cur">Documents</button></li></ol>
    <div class="field small">${ic('magnifying-glass')}<span>Rechercher dans Documents</span></div>
    <div class="seg" role="group" aria-label="Affichage"><button class="on" aria-label="Liste">${ic('list-bullets')}</button><button aria-label="Grille">${ic('squares-four')}</button></div>
    <button class="btn">${ic('folder-plus')}Nouveau dossier</button>
  </div>
  <div class="fbody">
    <aside class="sidebar">
      ${side.map(([h, items]) => `<h3>${h}</h3><ul>${items.map(([i, l, s]) => `<li class="${s || ''}">${ic(i, s ? 'fill' : 'regular')}<span>${l}</span></li>`).join('')}</ul>`).join('')}
      <div class="storage"><div class="st-row"><span>Ordinateur</span><span>182 Go libres</span></div><div class="meter" role="img" aria-label="330 Go utilisés sur 512 Go"><i style="width:64%"></i></div></div>
    </aside>
    <div class="listing" role="grid" aria-label="Contenu de Documents">
      <div class="lrow lhead"><span class="c-name">Nom ${ic('caret-up', 'bold', 'sort')}</span><span class="c-date">Modifié le</span><span class="c-type">Type</span><span class="c-size">Taille</span></div>
      ${rows.map(([t, n, d, ty, sz, s]) => `<div class="lrow ${s ? 'sel focus' : ''}"><span class="c-name">${ic(ftype[t][0], ftype[t][1], 'ft ' + ftype[t][2])}<span class="nm">${n}</span></span><span class="c-date">${d}</span><span class="c-type">${ty}</span><span class="c-size">${sz}</span></div>`).join('')}
      <div class="statusline"><span>10 éléments, 1 sélectionné (214 Ko)</span><span>182 Go disponibles</span></div>
    </div>
  </div>
</section>`;

// Calendar, October 2026 (starts Thursday). Grid from Monday 28 September.
const events = { 6: [['Yoga', 'ev-b']], 9: [['Piscine', 'ev-g']], 13: [['Cinéma', 'ev-a']], 16: [['Piscine', 'ev-g']], 17: [['Dîner', 'ev-r']], 23: [['Piscine', 'ev-g']], 24: [['Train', 'ev-b']] };
let cells = '';
for (let i = 0; i < 35; i++) {
  const day = i - 2; // 0 => 28 sept.
  const out = day <= 0 || day > 31;
  const num = out ? (day <= 0 ? [28, 29, 30][i] : day - 31) : day;
  cells += `<div class="cal-cell ${out ? 'out' : ''} ${num === 11 && !out ? 'today' : ''}"><span class="num">${num}</span>${(!out && events[num] ? events[num] : []).map(([t, c]) => `<span class="ev ${c}">${t}</span>`).join('')}</div>`;
}
const calendar = `
<section class="win win-cal" aria-label="Calendrier">
  <header class="titleband">${app('calendrier', 'ti')}<h2>Calendrier</h2>${winButtons}</header>
  <div class="cal-tools">
    <h3>Octobre 2026</h3>
    <button class="ib" aria-label="Mois précédent">${ic('caret-left')}</button><button class="ib" aria-label="Mois suivant">${ic('caret-right')}</button>
    <button class="btn">Aujourd'hui</button>
  </div>
  <div class="cal-grid">
    ${['lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.', 'dim.'].map((d) => `<div class="cal-wd">${d}</div>`).join('')}
    ${cells}
  </div>
</section>`;

/* ------------------------------------------------------------ launcher */
const pinned = ['navigateur', 'courrier', 'fichiers', 'calendrier', 'photos', 'lecteur', 'logitheque', 'parametres', 'terminal', 'calculatrice', 'editeur', 'notes', 'horloge', 'meteo', 'moniteur', 'capture', 'archives', 'echecs'];
const recs = [
  ['pdf', "Attestation d'assurance habitation.pdf", 'Hier à 18:12'],
  ['img', 'IMG_0412.jpg', '5 oct. à 16:40'],
  ['ods', 'Budget familial 2026.ods', 'Jeudi à 21:05'],
  ['txt', 'Recette tarte aux pommes.txt', "Aujourd'hui à 19:20"],
  ['odt', 'Compte rendu copropriété.odt', '6 oct. à 20:47'],
  ['pdf', 'Relevé de compte septembre.pdf', '2 oct. à 09:31'],
];
const recIcon = { pdf: ['file-pdf', 't-pdf'], ods: ['file-xls', 't-ods'], txt: ['file-text', 't-txt'], odt: ['file-doc', 't-odt'] };
const launcher = `
<section class="launcher glass" aria-label="Lanceur">
  <div class="l-search field focus">${ic('magnifying-glass')}<span>Rechercher une application, un fichier ou un réglage</span></div>
  <div class="l-head"><h2>Épinglées</h2><button class="link">Toutes les applications${ic('caret-right')}</button></div>
  <div class="l-grid">${pinned.map((id) => `<button class="l-app">${app(id)}<span>${names[id]}</span></button>`).join('')}</div>
  <div class="l-head"><h2>Récents</h2><button class="link">Afficher plus${ic('caret-right')}</button></div>
  <div class="l-recs">${recs.map(([t, n, d]) => `<button class="rec">${t === 'img' ? '<span class="thumb"></span>' : `<span class="ficon ${recIcon[t][1]}">${ic(recIcon[t][0])}</span>`}<span class="rt"><span class="rn">${n}</span><span class="rd">${d}</span></span></button>`).join('')}</div>
  <footer class="l-foot">
    <button class="user"><span class="avatar">CD</span><span>Camille Durand</span></button>
    <div class="l-actions"><button class="ib" aria-label="Verrouiller">${ic('lock-simple')}</button><button class="ib" aria-label="Éteindre ou redémarrer">${ic('power')}</button></div>
  </footer>
</section>`;

/* ------------------------------------------------- quick settings panel */
const tiles = [
  ['wifi-high', 'Wi-Fi', 'Maison', 'on', true], ['bluetooth', 'Bluetooth', '1 appareil', 'on', true],
  ['moon-stars', 'Concentration', 'Désactivée', '', false], ['circle-half', 'Mode sombre', 'Activé', 'on dm', false],
];
const accents = [['argent', 'Argent lunaire'], ['nuit', 'Bleu nuit'], ['violet', 'Violet', 'on'], ['ambre', 'Ambre']];
const moods = [['froide', 'Froide'], ['neutre', 'Neutre'], ['chaude', 'Chaude', 'on']];
const panel = `
<div class="side-stack">
  <section class="notifs glass" aria-label="Notifications">
    <div class="n-head"><h2>Notifications</h2><button class="link">Tout effacer</button></div>
    <article class="note">${app('logitheque', 'ni')}<div><div class="n-meta"><b>Logithèque</b><span>20:05</span></div><p>3 mises à jour sont disponibles.</p><div class="n-actions"><button class="btn primary">Installer</button><button class="btn">Plus tard</button></div></div></article>
  </section>
  <section class="qs glass" aria-label="Réglages rapides">
    <div class="qs-head"><h2>Réglages rapides</h2><span class="batt" title="Batterie">${ic('battery-high')}<b>82&nbsp;%</b><span>environ 4&nbsp;h&nbsp;10</span></span><button class="ib" aria-label="Ouvrir les Paramètres">${ic('gear-six')}</button></div>
    <div class="qs-tiles">${tiles.map(([i, l, s, on, more]) => `<div class="tile ${on}"><button class="t-main">${ic(i, on ? 'fill' : 'regular')}<span class="tt"><b>${l}</b><span>${s}</span></span></button>${more ? `<button class="t-more" aria-label="Choisir">${ic('caret-right')}</button>` : ''}</div>`).join('')}</div>
    <div class="slider"><button class="ib" aria-label="Couper le son">${ic('speaker-high')}</button><div class="track"><i style="width:64%"></i><b style="left:64%"></b></div><span class="val">64&nbsp;%</span></div>
    <div class="slider"><button class="ib" aria-label="Luminosité">${ic('sun')}</button><div class="track"><i style="width:80%"></i><b style="left:80%"></b></div><span class="val">80&nbsp;%</span></div>
    <hr>
    <h3>Couleur d'accent</h3>
    <div class="accents">${accents.map(([k, l, on]) => `<button class="chip ${on || ''}"><i class="sw sw-${k}">${on ? ic('check', 'bold') : ''}</i>${l}</button>`).join('')}</div>
    <h3>Ambiance</h3>
    <div class="moods">${moods.map(([k, l, on]) => `<button class="mood ${on || ''} ${on ? 'focus' : ''}"><i class="mv mv-${k}"><b></b><b></b><b></b></i>${l}</button>`).join('')}</div>
  </section>
</div>`;

/* ----------------------------------------------------------- icon sheet */
const sheetIds = ['fichiers', 'navigateur', 'courrier', 'parametres', 'terminal', 'logitheque', 'photos', 'calendrier', 'lecteur', 'calculatrice'];
const extraIds = ['editeur', 'notes', 'horloge', 'meteo', 'moniteur', 'capture', 'archives', 'echecs'];
const sheetHalf = (m) => `
<div class="sheet-half sh-${m}">
  <div class="sh-logo"><img src="icons/selene-logo-${m}.svg" alt=""><span>Selene</span><em>${m === 'dark' ? 'Icônes d\'applications sur fond sombre, 96 px et 56 px' : 'Icônes d\'applications sur fond clair, 96 px et 56 px'}</em></div>
  <div class="sh-row">${sheetIds.map((id) => `<figure>${app(id, 'big')}<figcaption>${names[id]}</figcaption></figure>`).join('')}</div>
  <div class="sh-row small">${extraIds.map((id) => `<figure>${app(id, 'mid')}<figcaption>${names[id]}</figcaption></figure>`).join('')}</div>
</div>`;
const sheet = `<div class="sheet">${sheetHalf('dark')}${sheetHalf('light')}</div>`;

const css = readFileSync(join(here, 'style.css'), 'utf8');
const html = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Clair de lune</title>
<style>
${css}
</style>
<script>
  const q = new URLSearchParams(location.search);
  document.documentElement.dataset.view = q.get('view') || 'desktop';
  document.documentElement.dataset.mode = q.get('mode') || 'dark';
</script>
</head>
<body>
<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
  <linearGradient id="logo-grad" x1="6" y1="10" x2="34" y2="44" gradientUnits="userSpaceOnUse"><stop offset="0" class="lg-a"/><stop offset="1" class="lg-b"/></linearGradient>
</defs></svg>
<main class="desktop">
  ${calendar}
  ${files}
  ${launcher}
  ${panel}
  ${bar}
</main>
${sheet}
<script>
  // Light mode: the "Mode sombre" tile is off.
  if (document.documentElement.dataset.mode === 'light') {
    const t = document.querySelector('.tile.dm');
    t.classList.remove('on');
    t.querySelector('.tt span').textContent = 'Désactivé';
  }
</script>
</body>
</html>`;
writeFileSync(join(here, 'index.html'), html);
console.log('index.html written', html.length);
