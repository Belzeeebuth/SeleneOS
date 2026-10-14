// Aide (apps/help): offline help, « Bien démarrer » tour, first-sign-in « Découvrez Selene » notification.
//   Content (Node, no Electron): every article and tour step in English and French with the same structure; ids,
//   links, related articles, {{sc:…}} catalog ids and key names valid; every action target valid (built-in app ids,
//   Paramètres page ids from apps/settings/lib/index.js and (page, section) pairs that exist, store / files / nettools /
//   backup arguments those apps accept); articles about optional apps (books, scan, logs, fonts, feeds) or features
//   (emoji panel, magnifier, on-screen keyboard) are gated by `requires`; no removed app (Traducteur, Mémos) appears.
//   lib.js: norm() / search() ignore accents and case, resolveFind(), isVisible().
//   Shell (Electron, dev): FR dark — home (tiles), topics, articles, breadcrumb, back / forward (buttons, Alt+Left,
//   Alt+Right), « Articles liés », search with and without accents, F1 focuses the search only while Help is the
//   active window, the shortcut article matches core/shortcuts.js and follows a custom shortcut (changed, turned off,
//   app shortcut), the Aide catalog shortcut opens Help, action buttons open the right app / Paramètres page, hidden
//   when the app is missing, optional articles appear / disappear with their app, the tour (Suivant / Précédent /
//   arrows / dots / Terminer); EN light — the same views in English; screenshots en/fr × light/dark;
//   first sign-in notification shown once per user (AURORA_HELP_WELCOME=1), never by default in dev, never live.
// Usage:  cd aurora-os/shell && xvfb-run -a -s "-screen 0 1600x900x24" node test/help.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launchShell } from './lib.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const R = path.join(ROOT, 'renderer');
const imp = (rel) => import(pathToFileURL(path.join(R, rel)).href);

let passed = 0;
const failures = [];
function check(name, actual, expected = true) {
  const ok = typeof expected === 'function' ? !!expected(actual) : Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++;
  else failures.push(`${name}\n      expected: ${typeof expected === 'function' ? '(predicate)' : JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
  return ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Optional apps / features built by other parts of Selene: their articles must be gated.
const OPTIONAL_APPS = new Set(['books', 'scan', 'logs', 'fonts', 'feeds']);
const REMOVED = [/\btranslat/i, /traduct/i, /\bmemos?\b/i, /\bmémos?\b/i];
const MODS = new Set(['Super', 'Ctrl', 'Alt', 'Shift']);
const KEY = /^([A-Z0-9]|[-=;/[\]]|F([1-9]|1[0-9]|2[0-4])|Arrow(Left|Right|Up|Down)|Home|End|PageUp|PageDown|Insert|Delete|Space|Tab|Escape|Enter|Backspace|Period|Comma|Pause|PrintScreen)$/;

try {
  // ================================================================== content (Node)
  const { TOPICS, ARTICLES, TOUR } = await imp('apps/help/content/index.js');
  const L = await imp('apps/help/lib.js');
  const SC = await imp('core/shortcuts.js');
  const ST = await imp('apps/settings/lib/index.js');
  const builtin = new Set(fs.readdirSync(path.join(R, 'apps')).filter((d) => fs.existsSync(path.join(R, 'apps', d, 'manifest.json'))));
  const ids = new Set(ARTICLES.map((a) => a.id));
  const sectionPairs = new Set([...ST.INDEX.map((e) => `${e.page}/${e.section}`)]);

  check('content: 15 topics, in the asked order', TOPICS.map((tp) => tp.id), ['desktop', 'shortcuts', 'personalization', 'files', 'network', 'bluetooth', 'printers', 'apps', 'updates', 'accounts', 'backup', 'accessibility', 'install', 'troubleshooting', 'privacy']);
  check('content: unique article ids', ids.size, ARTICLES.length);
  check('content: at least 50 articles', ARTICLES.length, (n) => n >= 50);
  check('content: every topic has an article', TOPICS.filter((tp) => !ARTICLES.some((a) => a.topic === tp.id)).map((tp) => tp.id), []);
  check('content: every topic has an icon, en + fr title and description', TOPICS.filter((tp) => !(tp.icon && tp.title?.en && tp.title?.fr && tp.desc?.en && tp.desc?.fr)).map((tp) => tp.id), []);
  check('content: tour of 5 to 7 steps', TOUR.length, (n) => n >= 5 && n <= 7);

  const problems = [];
  const bodyShape = (b) => (b || []).map((x) => (typeof x === 'string' ? 's' : Object.keys(x).filter((k) => !['label'].includes(k)).join('+') + (x.steps ? x.steps.length : x.list ? x.list.length : x.actions ? x.actions.length : '')));
  for (const a of [...ARTICLES, ...TOUR.map((s) => ({ ...s, tour: true }))]) {
    const where = `${a.tour ? 'tour ' : ''}${a.id}`;
    if (!a.tour && !TOPICS.some((tp) => tp.id === a.topic)) problems.push(`${where}: unknown topic ${a.topic}`);
    for (const lang of ['en', 'fr']) {
      if (!a.title?.[lang]) problems.push(`${where}: no ${lang} title`);
      if (!a.tour && !a.summary?.[lang]) problems.push(`${where}: no ${lang} summary`);
      if (!a.tour && !(a.keywords?.[lang] || []).length) problems.push(`${where}: no ${lang} keywords`);
      if (!Array.isArray(a.body?.[lang]) || !a.body[lang].length) problems.push(`${where}: no ${lang} body`);
      for (const s of [...L.blockStrings(a.body?.[lang]), a.title?.[lang] || '', a.summary?.[lang] || '']) {
        if (/\*\*[^*]*$|\{\{[^}]*$|\[\[[^\]]*$/.test(s.replace(/\*\*(.+?)\*\*|\{\{(.+?)\}\}|\[\[(.+?)\]\]/g, ''))) problems.push(`${where}: unbalanced markup in ${lang}: ${s.slice(0, 60)}`);
        if (lang === 'fr' && /[a-zà-ÿ]'[a-zà-ÿ]/i.test(s.replace(/\{\{.*?\}\}|\[\[.*?\]\]/g, ''))) problems.push(`${where}: straight apostrophe in French: ${s.slice(0, 60)}`);
        for (const r of REMOVED) if (r.test(s)) problems.push(`${where}: mentions a removed app (${r}): ${s.slice(0, 60)}`);
      }
      for (const tk of L.bodyTokens(a.body?.[lang])) {
        if (tk.t === 'link' && !ids.has(tk.v)) problems.push(`${where}: link to unknown article ${tk.v}`);
        if (tk.t === 'sc' && !SC.SHORTCUT_IDS.has(tk.v)) problems.push(`${where}: unknown shortcut action ${tk.v}`);
        if (tk.t === 'keys') {
          const parts = tk.v.split('+');
          const key = parts.pop();
          if (!(parts.every((p) => MODS.has(p)) && (KEY.test(key) || MODS.has(key)))) problems.push(`${where}: bad key combo ${tk.v}`);
        }
      }
      for (const id of L.blockActions(a.body?.[lang])) if (!a.actions?.[id]) problems.push(`${where}: action ${id} not declared`);
    }
    if (JSON.stringify(bodyShape(a.body?.en)) !== JSON.stringify(bodyShape(a.body?.fr))) problems.push(`${where}: en and fr bodies differ in structure`);
    if (L.blockActions(a.body?.en).join() !== L.blockActions(a.body?.fr).join()) problems.push(`${where}: en and fr actions differ`);
    for (const r of a.related || []) if (!ids.has(r) || r === a.id) problems.push(`${where}: bad related ${r}`);
    for (const lang of ['en', 'fr']) for (const k of a.keywords?.[lang] || []) for (const rx of REMOVED) if (rx.test(k)) problems.push(`${where}: removed app in keywords`);
    // action targets
    const requiredApps = new Set((a.requires || []).filter((r) => r.app).map((r) => r.app));
    for (const [id, spec] of Object.entries(a.actions || {})) {
      if (!spec || typeof spec !== 'object') {
        problems.push(`${where}: action ${id} is not an object`);
        continue;
      }
      if (spec.article) {
        if (!ids.has(spec.article)) problems.push(`${where}: action ${id} -> unknown article ${spec.article}`);
        continue;
      }
      if (spec.tour) continue;
      const app = spec.app;
      if (['translate', 'sticky'].includes(app)) problems.push(`${where}: action ${id} opens a removed app`);
      if (OPTIONAL_APPS.has(app)) {
        if (!requiredApps.has(app)) problems.push(`${where}: action ${id} opens optional app ${app} without requires`);
      } else if (!builtin.has(app)) problems.push(`${where}: action ${id} -> unknown app ${app}`);
      const args = spec.args || {};
      if (app === 'settings') {
        if (!ST.PAGES[args.page]) problems.push(`${where}: action ${id} -> unknown Paramètres page ${args.page}`);
        if (args.section && !sectionPairs.has(`${args.page}/${args.section}`)) problems.push(`${where}: action ${id} -> section ${args.page}/${args.section} not in the Settings index`);
        if (Object.keys(args).some((k) => !['page', 'section'].includes(k))) problems.push(`${where}: action ${id} -> unknown Settings argument`);
      }
      if (app === 'store' && args.view && !['installed', 'sources', 'categories', 'updates'].includes(args.view)) problems.push(`${where}: store view ${args.view}`);
      if (app === 'files' && args.path && !['home', 'thispc', 'trash', 'gallery', '~'].includes(args.path)) problems.push(`${where}: files path ${args.path}`);
      if (app === 'nettools' && args.tab && !['vpn', 'ping', 'dns'].includes(args.tab)) problems.push(`${where}: nettools tab ${args.tab}`);
      if (app === 'backup' && args.page && !['home', 'snapshots', 'settings'].includes(args.page)) problems.push(`${where}: backup page ${args.page}`);
    }
    for (const r of a.requires || []) if (r.find && !a.find) problems.push(`${where}: requires find without find`);
  }
  check('content: every article and step complete in en + fr, same structure, valid links / keys / actions', problems, []);
  for (const id of ['books', 'scan', 'logs-app', 'fonts-app', 'feeds', 'emoji', 'magnifier', 'osk']) check(`content: optional article ${id} is gated (requires)`, !!ARTICLES.find((a) => a.id === id)?.requires?.length);
  check('content: no article about a removed app', ARTICLES.filter((a) => /translat|sticky|memo/i.test(a.id)).map((a) => a.id), []);
  check('content: the shortcut article holds the live list', ARTICLES.find((a) => a.id === 'shortcuts')?.body.fr.some((b) => b && b.shortcuts));
  check('content: the « Aide » catalog shortcut exists, no default combo', SC.SHORTCUTS.find((s) => s.id === 'help'), (s) => s && s.combo === null && s.name.fr === 'Aide' && s.group === 'apps');

  // lib.js
  check('norm: accents, case, ligatures, apostrophes, hyphens', [L.norm('Périphérique'), L.norm('PÉRIPHÉRIQUE'), L.norm('Wi-Fi'), L.norm('l’écran'), L.norm('Cœur')], ['peripherique', 'peripherique', 'wifi', 'l ecran', 'coeur']);
  check('parseInline: bold, keys, catalog shortcut, links', L.parseInline('Press {{Super+S}} or {{sc:search}} in **Search**, see [[usb]] and [[trash|the Trash]].').map((t) => t.t + ':' + t.v), ['text:Press ', 'keys:Super+S', 'text: or ', 'sc:search', 'text: in ', 'b:Search', 'text:, see ', 'link:usb', 'text: and ', 'link:trash', 'text:.']);
  const all = () => true;
  const visibleNow = ARTICLES.filter(all);
  const ixFr = L.buildIndex(visibleNow, 'fr', { topicTitle: (id, l) => TOPICS.find((tp) => tp.id === id)?.title[l] });
  const ixEn = L.buildIndex(visibleNow, 'en', { topicTitle: (id, l) => TOPICS.find((tp) => tp.id === id)?.title[l] });
  const top = (ix, q) => L.search(ix, q).map((r) => r.id);
  check('search fr: « peripherique » (no accents) finds « périphérique »', top(ixFr, 'peripherique'), (r) => r.includes('usb'));
  check('search fr: « PÉRIPHÉRIQUE » (capitals, accents) same result', top(ixFr, 'PÉRIPHÉRIQUE'), (r) => JSON.stringify(r) === JSON.stringify(top(ixFr, 'peripherique')));
  check('search fr: « imprimante » -> printer articles first', top(ixFr, 'imprimante').slice(0, 2), (r) => r.includes('printer-add'));
  check('search fr: « cle usb » -> usb first', top(ixFr, 'cle usb')[0], 'usb');
  check('search fr: « comment changer le fond d’ecran » -> wallpaper first', top(ixFr, 'comment changer le fond d’ecran')[0], 'wallpaper');
  check('search en: « bluetooth headphones » -> bluetooth pairing', top(ixEn, 'bluetooth headphones')[0], 'bluetooth-pair');
  check('search en: « VPN » -> vpn first', top(ixEn, 'VPN')[0], 'vpn');
  check('search: nothing for « zzqqx »', top(ixFr, 'zzqqx'), []);
  const part = L.search(ixFr, 'wifi zzqqx');
  check('search: partial results when no article holds every word', [part.partial, part.map((r) => r.id).includes('wifi')], [true, true]);
  const env = { hasApp: (id) => id === 'magnifier', shortcuts: [{ id: 'emoji', combo: 'Super+Period', name: { en: 'Emoji and symbols', fr: 'Émojis et symboles' } }], bindings: {}, settingsEntries: [{ page: 'accessibility', section: 'osk', name: { en: 'On-screen keyboard', fr: 'Clavier visuel' } }] };
  const art = (id) => ARTICLES.find((a) => a.id === id);
  check('resolveFind: emoji panel found by its catalog shortcut', L.resolveFind(art('emoji').find, env), { shortcut: { id: 'emoji' } });
  check('resolveFind: magnifier found by its app', L.resolveFind(art('magnifier').find, env), { app: 'magnifier' });
  check('resolveFind: on-screen keyboard found by its Settings entry', L.resolveFind(art('osk').find, env), { settings: { page: 'accessibility', section: 'osk' } });
  check('isVisible: gated articles hidden when nothing exists', ['emoji', 'magnifier', 'osk', 'books', 'scan'].map((id) => L.isVisible(art(id), { hasApp: () => false, shortcuts: [], bindings: {}, settingsEntries: [] })), [false, false, false, false, false]);
  check('isVisible: books shown with the books app', L.isVisible(art('books'), { hasApp: (id) => id === 'books' }), true);

  // ================================================================== shell (Electron)
  const state = (s) => s.aurora(() => {
    const api = document.querySelector('.app-help .hp')?.parentElement?.__help;
    return api ? { ...api.state } : null;
  });
  // (a relaunch without arguments only brings the window forward: go home explicitly then)
  async function openHelp(s, args) {
    await s.aurora((a) => window.__aurora.shell.launch('help', a), args || {});
    await s.page.waitForSelector('.app-help .hp-page', { timeout: 15000 });
    if (!args) await s.aurora(() => document.querySelector('.app-help .hp').parentElement.__help.navigate({ view: 'home' }));
  }
  async function closeApps(s, ids) {
    await s.aurora((list) => {
      for (const w of window.__aurora.wm.list()) if (list.includes(w.appId)) w.close(true);
    }, ids);
    await sleep(350);
  }

  // ---------------------------------------------------------------- FR dark: the full walk
  {
    const s = await launchShell({ lang: 'fr', theme: 'dark', size: '1600x900' });
    try {
      check('[fr] the « Aide » app is registered (system category)', await s.aurora(() => {
        const m = window.__aurora.registry.get('help');
        return m && [m.category, window.__aurora.registry.name('help')];
      }), ['system', 'Aide']);
      check('[fr] no « Découvrez Selene » feature in a dev shell by default', await s.aurora(() => !window.__aurora.helpWelcome), true);
      await openHelp(s);
      const tiles = await s.page.$$eval('.app-help .hp-tile', (els) => els.map((e) => e.dataset.topic));
      check('[fr] home: one tile per topic with articles', tiles.length, (n) => n >= 14);
      check('[fr] home: « Bien démarrer » card and its button', await s.page.textContent('.app-help .hp-tourcard'), (x) => /Bien démarrer/.test(x) && /Commencer la visite/.test(x));
      check('[fr] home: window title « Aide »', await s.aurora(() => window.__aurora.wm.byApp('help')[0]?.title), 'Aide');
      await s.shot('help-home-fr-dark');

      // topic -> article -> related -> back / forward
      await s.page.click('.app-help .hp-tile[data-topic="network"]');
      await s.page.waitForSelector('.app-help .hp-topic[data-topic="network"]');
      check('[fr] topic view: its articles', await s.page.$$eval('.app-help .hp-topic .hp-row', (els) => els.map((e) => e.dataset.article)), (r) => r.includes('wifi') && r.includes('vpn'));
      await s.page.click('.app-help .hp-row[data-article="wifi"]');
      await s.page.waitForSelector('.app-help .hp-article[data-article="wifi"]');
      check('[fr] article: title, breadcrumb', [await s.page.textContent('.app-help .hp-article h1'), await s.page.textContent('.app-help .hp-crumbs')], (x) => x[0] === 'Se connecter au Wi-Fi' && /Aide.*Internet et réseau.*Se connecter au Wi-Fi/.test(x[1]));
      check('[fr] article: key caps drawn from the catalog (Super + A for Réglages rapides)', await s.page.$$eval('.app-help .hp-article kbd.hp-combo', (els) => els.map((e) => e.textContent)), (r) => r.includes('Super+A'));
      check('[fr] article: « Articles liés »', await s.page.textContent('.app-help .hp-related'), (x) => /Articles liés/.test(x) && /Le mode avion/.test(x));
      await s.shot('help-article-fr-dark');
      await s.page.click('.app-help .hp-related .hp-row[data-article="airplane"]');
      await s.page.waitForSelector('.app-help .hp-article[data-article="airplane"]');
      await s.page.click('.app-help .hp-bar button[aria-label^="Précédent"]');
      check('[fr] back button -> previous article', (await state(s))?.id, 'wifi');
      await s.page.keyboard.press('Alt+ArrowLeft');
      check('[fr] Alt+Left -> the topic', (await state(s))?.view, 'topic');
      await s.page.keyboard.press('Alt+ArrowRight');
      check('[fr] Alt+Right -> forward to the article', (await state(s))?.id, 'wifi');
      await s.page.click('.app-help .hp-bar button[aria-label^="Suivant"]');
      check('[fr] forward button', (await state(s))?.id, 'airplane');
      check('[fr] forward disabled at the end', await s.page.$eval('.app-help .hp-bar button[aria-label^="Suivant"]', (b) => b.disabled), true);
      await s.page.click('.app-help .hp-crumb >> nth=0');
      check('[fr] breadcrumb « Aide » -> home', (await state(s))?.view, 'home');

      // in-article link
      await openHelp(s, { article: 'backup-restore' });
      await s.page.click('.app-help .hp-article a.hp-link[data-article="trash"]');
      check('[fr] in-text link opens the linked article', (await state(s))?.id, 'trash');

      // search
      await s.page.click('.app-help .hp-search-input');
      await s.page.keyboard.type('peripherique');
      await s.page.waitForSelector('.app-help .hp-results .hp-row[data-article="usb"]', { timeout: 3000 }).catch(() => {});
      check('[fr] search « peripherique » finds « Clés USB et disques externes »', await s.page.$$eval('.app-help .hp-results .hp-row', (els) => els.map((e) => e.dataset.article)), (r) => r.includes('usb'));
      await s.shot('help-search-fr-dark');
      await s.page.fill('.app-help .hp-search-input', 'PÉRIPHÉRIQUE');
      await sleep(400);
      check('[fr] search with capitals and accents: same', await s.page.$$eval('.app-help .hp-results .hp-row', (els) => els.map((e) => e.dataset.article)), (r) => r.includes('usb'));
      await s.page.fill('.app-help .hp-search-input', 'imprimante');
      await sleep(400);
      check('[fr] search « imprimante »', await s.page.$$eval('.app-help .hp-results .hp-row', (els) => els.map((e) => e.dataset.article).slice(0, 3)), (r) => r.includes('printer-add'));
      check('[fr] search typing does not pile up history', await s.aurora(() => document.querySelector('.app-help .hp').parentElement.__help.history.entries.filter((e) => e.view === 'search').length), 1);
      await s.page.fill('.app-help .hp-search-input', 'capture');
      await sleep(400);
      check('[fr] search « capture » also finds the live shortcut list', await s.page.$$eval('.app-help .hp-results .hp-row', (els) => els.map((e) => e.dataset.article)), (r) => r.includes('screenshots') && r.includes('shortcuts'));
      await s.page.fill('.app-help .hp-search-input', 'zzqqx');
      await sleep(400);
      check('[fr] no result: message and « Parcourir les sujets »', await s.page.textContent('.app-help .hp-results'), (x) => /Aucun article ne correspond à « zzqqx »/.test(x) && /Parcourir les sujets/.test(x));
      await s.page.keyboard.press('Escape');
      await sleep(200);
      check('[fr] Escape clears the search and leaves the results', [await s.page.inputValue('.app-help .hp-search-input'), (await state(s))?.view], (x) => x[0] === '' && x[1] !== 'search');

      // F1
      await s.page.click('.app-help .hp-page h1');
      await s.page.keyboard.press('F1');
      check('[fr] F1 focuses the search box', await s.page.evaluate(() => document.activeElement?.classList.contains('hp-search-input')), true);
      await s.aurora(() => window.__aurora.shell.launch('calculator'));
      await s.page.waitForSelector('.app-calculator');
      await sleep(300);
      await s.page.click('.app-calculator');
      await s.page.keyboard.press('F1');
      check('[fr] F1 in another window does not jump to Help', await s.page.evaluate(() => document.activeElement?.classList.contains('hp-search-input')), false);
      await closeApps(s, ['calculator']);

      // shortcut article: live, follows the user's shortcuts
      await openHelp(s, { article: 'shortcuts' });
      const live = await s.aurora(async () => {
        const m = await import('app://shell/core/shortcuts.js');
        const eff = m.effectiveShortcuts(window.__aurora.settings.get('shortcuts') || {});
        const rows = Object.fromEntries([...document.querySelectorAll('.app-help .hp-sc-table tr[data-sc]')].map((tr) => [tr.dataset.sc, tr.dataset.combo]));
        return { missing: m.SHORTCUTS.filter((s) => !(s.id in rows)).map((s) => s.id), wrong: m.SHORTCUTS.filter((s) => (rows[s.id] || null) !== (eff[s.id] || null)).map((s) => s.id), n: m.SHORTCUTS.length };
      });
      check('[fr] shortcut article: one row per catalog action, with the combo in effect', live, (x) => x.n > 40 && !x.missing.length && !x.wrong.length);
      check('[fr] shortcut article: French key names (Maj, Échap)', await s.page.textContent('.app-help .hp-sc'), (x) => /Maj/.test(x) && /Échap/.test(x));
      check('[fr] shortcut article: fixed combos and the Help window keys', await s.page.textContent('.app-help .hp-sc'), (x) => /Toujours disponibles/.test(x) && /Alt\+Tab/.test(x) && /Dans la fenêtre Aide/.test(x) && /F1/.test(x));
      await s.shot('help-shortcuts-fr-dark');
      await s.aurora(() => window.__aurora.settings.set('shortcuts', { search: 'Super+F', lock: null, 'app:calculator': 'Super+Alt+C', help: 'Super+Alt+H' }));
      await sleep(400);
      const after = await s.aurora(() => {
        const row = (id) => document.querySelector(`.app-help .hp-sc-table tr[data-sc="${id}"]`);
        return { search: row('search')?.dataset.combo, searchChanged: !!row('search')?.querySelector('.hp-badge'), lock: row('lock')?.textContent, app: row('app:calculator')?.textContent, help: row('help')?.dataset.combo };
      });
      check('[fr] custom shortcut shown at once, marked « modifié »', [after.search, after.searchChanged], ['Super+F', true]);
      check('[fr] turned-off shortcut shown « désactivé »', after.lock, (x) => /désactivé/.test(x || ''));
      check('[fr] app shortcut listed as « Ouvrir Calculatrice »', after.app, (x) => /Ouvrir Calculatrice/.test(x || '') && /Super/.test(x || ''));
      check('[fr] the « Aide » shortcut row follows the setting', after.help, 'Super+Alt+H');
      await openHelp(s, { article: 'search' });
      check('[fr] other articles follow the custom shortcut too ({{sc:search}} -> Super+F)', await s.page.$$eval('.app-help .hp-article kbd.hp-combo', (els) => els.map((e) => e.textContent)), (r) => r.includes('Super+F') && !r.includes('Super+S'));
      await openHelp(s, { article: 'lock' });
      check('[fr] a turned-off shortcut reads « désactivé » in an article', await s.page.textContent('.app-help .hp-body p'), (x) => /désactivé/.test(x));
      await closeApps(s, ['help']);
      await s.aurora(() => window.__aurora.hotkeys.trigger('Super+Alt+H'));
      await s.page.waitForSelector('.app-help .hp-page', { timeout: 5000 }).catch(() => {});
      check('[fr] the « Aide » catalog shortcut opens Help', await s.aurora(() => window.__aurora.wm.byApp('help').length), 1);
      await s.aurora(() => window.__aurora.settings.set('shortcuts', {}));
      await sleep(200);

      // actions: Paramètres pages, apps, hidden when missing
      await openHelp(s, { article: 'wifi' });
      check('[fr] action button labelled with the Paramètres breadcrumb', await s.page.textContent('.app-help .hp-action[data-page="wifi"]'), (x) => /Ouvrir Paramètres : Réseau › Wi-Fi/.test(x));
      await s.page.click('.app-help .hp-action[data-page="wifi"]');
      await s.page.waitForSelector('.app-settings .st-page[data-page="wifi"]', { timeout: 10000 }).catch(() => {});
      check('[fr] « Paramètres › Wi-Fi » opens on the Wi-Fi page', await s.aurora(() => document.querySelector('.app-settings .st-page')?.dataset.page), 'wifi');
      await closeApps(s, ['settings']);
      await openHelp(s, { article: 'diagnostic' });
      await s.page.click('.app-help .hp-action[data-page="about"]');
      await s.page.waitForSelector('.app-settings .st-page[data-page="about"]', { timeout: 10000 }).catch(() => {});
      check('[fr] action with a section opens that page (À propos, diagnostic)', await s.aurora(() => document.querySelector('.app-settings .st-page')?.dataset.page), 'about');
      await closeApps(s, ['settings']);
      await openHelp(s, { article: 'vpn' });
      check('[fr] app action: « Ouvrir Outils réseau »', await s.page.textContent('.app-help .hp-action[data-app="nettools"]'), (x) => /Ouvrir Outils réseau/.test(x));
      await s.page.click('.app-help .hp-action[data-app="nettools"]');
      await s.page.waitForSelector('.app-nettools', { timeout: 10000 }).catch(() => {});
      check('[fr] it opens Outils réseau', await s.aurora(() => window.__aurora.wm.byApp('nettools').length), 1);
      await closeApps(s, ['nettools']);
      // a missing app: its button disappears, an article about it disappears
      await s.aurora(() => {
        const reg = window.__aurora.registry;
        reg.__origGet = reg.get;
        reg.get = (id) => (id === 'nettools' || id === 'books' ? undefined : reg.__origGet(id));
        window.dispatchEvent(new CustomEvent('aurora:apps-changed'));
      });
      await sleep(200);
      check('[fr] action hidden when its app is missing', await s.page.$$eval('.app-help .hp-action[data-app="nettools"]', (els) => els.length), 0);
      check('[fr] the article text is still there', await s.page.textContent('.app-help .hp-article h1'), 'Utiliser un VPN');
      check('[fr] article about a missing optional app hidden (books)', await s.aurora(() => document.querySelector('.app-help .hp').parentElement.__help.visibleIds().includes('books')), false);
      await s.aurora(() => {
        const reg = window.__aurora.registry;
        reg.get = (id) => (id === 'books' ? { id: 'books', name: { en: 'Books', fr: 'Livres' }, category: 'media' } : reg.__origGet(id));
        reg.__origName = reg.name;
        reg.name = (id) => (id === 'books' ? 'Livres' : reg.__origName(id));
        window.dispatchEvent(new CustomEvent('aurora:apps-changed'));
      });
      await openHelp(s, { article: 'books' });
      check('[fr] with the books app: its article and « Ouvrir Livres »', [await s.page.textContent('.app-help .hp-article h1'), await s.page.textContent('.app-help .hp-action[data-app="books"]').catch(() => '')], (x) => x[0] === 'Lire des livres numériques' && /Ouvrir Livres/.test(x[1]));
      await s.aurora(() => {
        const reg = window.__aurora.registry;
        reg.get = reg.__origGet;
        reg.name = reg.__origName;
        window.dispatchEvent(new CustomEvent('aurora:apps-changed'));
      });
      // every action rendered on this computer opens an app that exists
      const allActions = await s.aurora(async () => {
        const api = document.querySelector('.app-help .hp').parentElement.__help;
        const out = [];
        for (const id of api.visibleIds()) {
          api.navigate({ view: 'article', id });
          await new Promise((r) => setTimeout(r, 0));
          for (const b of document.querySelectorAll('.app-help .hp-action')) out.push([id, b.dataset.kind, b.dataset.app || b.dataset.article || '', b.dataset.page || '']);
        }
        return out;
      });
      const reg = await s.aurora(() => window.__aurora.registry.list({ includeHidden: true }).map((m) => m.id));
      check('[fr] every rendered action targets an installed app or an article', allActions.filter(([, kind, target]) => (kind === 'article' ? false : !reg.includes(target))), []);
      check('[fr] many actions rendered', allActions.length, (n) => n >= 40);
      check('[fr] installer action only where the installer app exists (live session; dev lists it)', allActions.some(([, , app]) => app === 'installer'), reg.includes('installer'));

      // tour
      await openHelp(s);
      await s.page.click('.app-help .hp-tour-start');
      await s.page.waitForSelector('.app-help .hp-tour');
      check('[fr] tour: step 1, « Étape 1 sur 7 »', await s.page.textContent('.app-help .hp-tour-count'), 'Étape 1 sur 7');
      check('[fr] tour: illustration highlights the bar', await s.page.getAttribute('.app-help .hp-tour .hp-ill', 'data-focus'), 'bar');
      await s.shot('help-tour-fr-dark');
      await s.page.click('.app-help .hp-tour-next');
      check('[fr] tour: « Suivant » -> step 2 (windows)', await s.page.getAttribute('.app-help .hp-tour', 'data-step-id'), 'windows');
      await s.page.keyboard.press('ArrowRight');
      check('[fr] tour: Right arrow -> step 3', await s.page.getAttribute('.app-help .hp-tour', 'data-step'), '2');
      await s.page.click('.app-help .hp-tour-prev');
      check('[fr] tour: « Précédent » -> step 2', await s.page.getAttribute('.app-help .hp-tour', 'data-step'), '1');
      await s.page.click('.app-help .hp-dot >> nth=6');
      check('[fr] tour: last step via its dot, « Terminer »', [await s.page.getAttribute('.app-help .hp-tour', 'data-step-id'), await s.page.textContent('.app-help .hp-tour-next')], ['help', 'Terminer']);
      check('[fr] tour: last step links to the shortcut article', await s.page.textContent('.app-help .hp-tour .hp-action[data-kind="article"]'), (x) => /Voir les raccourcis clavier/.test(x));
      await s.page.click('.app-help .hp-tour-next');
      check('[fr] tour: « Terminer » -> home', (await state(s))?.view, 'home');
      check('[fr] tour steps do not fill the history', await s.aurora(() => document.querySelector('.app-help .hp').parentElement.__help.history.entries.filter((e) => e.view === 'tour').length), (n) => n <= 1);
      await openHelp(s, { tour: true, step: 3 });
      check('[fr] launch args { tour, step } (relaunch of the single window)', [await s.page.getAttribute('.app-help .hp-tour', 'data-step-id'), await s.aurora(() => window.__aurora.wm.byApp('help').length)], ['files', 1]);
      check('[fr] tour step « Vos fichiers » offers « Ouvrir Fichiers »', await s.page.textContent('.app-help .hp-tour .hp-action[data-app="files"]'), (x) => /Ouvrir Fichiers/.test(x));

      // all topics and articles render in French with no error
      const errs = await s.aurora(async () => {
        const api = document.querySelector('.app-help .hp').parentElement.__help;
        const bad = [];
        for (const id of api.visibleIds()) {
          api.navigate({ view: 'article', id });
          const h1 = document.querySelector('.app-help .hp-article h1')?.textContent;
          if (!h1 || /undefined|\{\{|\*\*|\[\[/.test(document.querySelector('.app-help .hp-article').textContent)) bad.push(id);
        }
        return bad;
      });
      check('[fr] every visible article renders cleanly', errs, []);
      check('[fr] no renderer error', s.logs.filter((l) => /\[pageerror\]|\[error\]/.test(l) && /help/i.test(l)), []);
    } finally {
      await s.close();
    }
  }

  // ---------------------------------------------------------------- EN light
  {
    const s = await launchShell({ lang: 'en', theme: 'light', size: '1600x900' });
    try {
      await openHelp(s);
      check('[en] home in English', await s.page.textContent('.app-help .hp-home'), (x) => /Selene Help/.test(x) && /Get started/.test(x) && /Start the tour/.test(x) && /Topics/.test(x));
      await s.shot('help-home-en-light');
      await s.page.click('.app-help .hp-tile[data-topic="desktop"]');
      await s.page.click('.app-help .hp-row[data-article="layouts"]');
      await s.page.waitForSelector('.app-help .hp-article[data-article="layouts"]');
      check('[en] article in English', await s.page.textContent('.app-help .hp-article h1'), 'Layouts');
      check('[en] key caps in English', await s.page.$$eval('.app-help .hp-article kbd.hp-combo', (els) => els.map((e) => e.textContent)), (r) => r.includes('Super+Z'));
      check('[en] action « Open Settings: Personalization › Layouts »', await s.page.textContent('.app-help .hp-action[data-page="snapPresets"]'), (x) => /Open Settings: Personalization › Layouts/.test(x));
      await s.shot('help-article-en-light');
      await s.page.click('.app-help .hp-search-input');
      await s.page.keyboard.type('usb stick');
      await sleep(400);
      check('[en] search « usb stick »', (await s.page.$$eval('.app-help .hp-results .hp-row', (els) => els.map((e) => e.dataset.article)))[0], 'usb');
      await s.page.keyboard.press('ArrowDown');
      check('[en] Arrow down moves from the search box to the first result', await s.page.evaluate(() => document.activeElement?.dataset?.article), 'usb');
      await s.page.keyboard.press('Enter');
      check('[en] Enter opens it', (await state(s))?.id, 'usb');
      await openHelp(s, { tour: true });
      check('[en] tour in English', [await s.page.textContent('.app-help .hp-tour-count'), await s.page.textContent('.app-help .hp-tour-next')], ['Step 1 of 7', 'Next']);
      await s.page.click('.app-help .hp-tour-next');
      await s.page.click('.app-help .hp-tour-next');
      check('[en] tour step 3: Quick settings', await s.page.getAttribute('.app-help .hp-tour .hp-ill', 'data-focus'), 'quick');
      await s.shot('help-tour-en-light');
      // language switch while open
      await s.aurora(() => window.__aurora.settings.set('lang', 'fr'));
      await sleep(500);
      check('[en→fr] switching the language re-renders the open view', await s.page.textContent('.app-help .hp-tour-count'), 'Étape 3 sur 7');
      await s.aurora(() => window.__aurora.settings.set('lang', 'en'));
      await sleep(300);
      // narrow window
      await s.aurora(() => window.__aurora.wm.byApp('help')[0].setSize(440, 640));
      await openHelp(s);
      await sleep(300);
      check('[en] narrow window: no horizontal overflow', await s.page.$eval('.app-help .hp-main', (m) => m.scrollWidth <= m.clientWidth + 1), true);
      await s.shot('help-narrow-en-light');
    } finally {
      await s.close();
    }
  }

  // ---------------------------------------------------------------- remaining screenshots (fr light, en dark)
  for (const [lang, theme] of [['fr', 'light'], ['en', 'dark']]) {
    const s = await launchShell({ lang, theme, size: '1600x900' });
    try {
      await openHelp(s);
      await s.shot(`help-home-${lang}-${theme}`);
      await openHelp(s, { article: 'usb' });
      await s.shot(`help-article-${lang}-${theme}`);
      await openHelp(s, { article: 'shortcuts' });
      await s.shot(`help-shortcuts-${lang}-${theme}`);
      await openHelp(s, { tour: true, step: 1 });
      await s.shot(`help-tour-${lang}-${theme}`);
      check(`[${lang} ${theme}] screenshots taken`, fs.existsSync(path.join(ROOT, 'test', 'out', `help-tour-${lang}-${theme}.png`)), true);
    } finally {
      await s.close();
    }
  }

  // ---------------------------------------------------------------- first sign-in « Découvrez Selene »
  {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-help-home-'));
    const ENV = { AURORA_HELP_WELCOME: '1', AURORA_HELP_WELCOME_DELAY_MS: '300' };
    try {
      const s = await launchShell({ lang: 'fr', theme: 'dark', home, env: ENV });
      try {
        const shown = await s.page.waitForFunction(() => window.__aurora.notifications.list().some((n) => n.title === 'Découvrez Selene'), null, { timeout: 8000 }).then(() => true, () => false);
        check('[welcome] « Découvrez Selene » shown after the first sign-in', shown);
        check('[welcome] one notification only', await s.aurora(() => window.__aurora.notifications.list().filter((n) => n.title === 'Découvrez Selene').length), 1);
        check('[welcome] its toast offers « Commencer la visite »', await s.page.textContent('#toasts').catch(() => ''), (x) => /Découvrez Selene/.test(x) && /Commencer la visite/.test(x));
        await s.shot('help-welcome-fr-dark');
        check('[welcome] marked as shown in the Aide storage of this user', JSON.parse(fs.readFileSync(path.join(home, '.config', 'aurora', 'apps', 'help', 'welcome.json'), 'utf8')).shown, true);
        await s.page.click('#toasts .toast-actions button');
        await s.page.waitForSelector('.app-help .hp-tour', { timeout: 10000 }).catch(() => {});
        check('[welcome] « Commencer la visite » opens the tour', await s.page.getAttribute('.app-help .hp-tour', 'data-step').catch(() => null), '0');
        check('[welcome] a second call does nothing', await s.aurora(async () => (await window.__aurora.helpWelcome.show()) == null), true);
      } finally {
        await s.close();
      }
      const s2 = await launchShell({ lang: 'fr', theme: 'dark', home, env: ENV });
      try {
        await sleep(1500);
        check('[welcome] never again for this user', await s2.aurora(() => window.__aurora.notifications.list().filter((n) => n.title === 'Découvrez Selene').length), 0);
      } finally {
        await s2.close();
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
    const s3 = await launchShell({ lang: 'fr', theme: 'dark', live: true, env: ENV });
    try {
      await sleep(1500);
      check('[welcome] never in the live session', [await s3.aurora(() => !window.__aurora.helpWelcome), await s3.aurora(() => window.__aurora.notifications.list().filter((n) => n.title === 'Découvrez Selene').length)], [true, 0]);
    } finally {
      await s3.close();
    }
  }
} catch (err) {
  failures.push(`crashed: ${err.stack || err}`);
}

console.log(`\nhelp: ${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  FAIL ${f}`);
process.exit(failures.length ? 1 : 0);
