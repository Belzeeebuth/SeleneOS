import { launchShell } from './lib.mjs';
const s = await launchShell({ lang: 'fr', theme: 'dark', size: '1280x720' });
const P = s.page;
await P.evaluate(() => window.__aurora.shell.emit('start:toggle'));
await P.waitForTimeout(800);
const info = await P.evaluate(() => ({
  inputs: [...document.querySelectorAll('#start input')].map((i) => i.className + '|' + i.placeholder),
  imgs: [...document.querySelectorAll('#start img')].map((i) => i.getAttribute('src')),
  text: document.querySelector('#start')?.innerText.slice(0, 600),
}));
console.log(JSON.stringify(info, null, 1));
await s.shot('critic-music-lanceur-dark');
// look for an "all apps" button
const all = await P.evaluate(() => [...document.querySelectorAll('#start button')].map((b) => b.className + '|' + b.textContent.trim()).slice(0, 30));
console.log(all.join('\n'));
await P.keyboard.type('musique');
await P.waitForTimeout(800);
console.log('SEARCH', await P.evaluate(() => document.querySelector('#start')?.innerText.slice(0, 400)));
console.log('SEARCHIMG', await P.evaluate(() => [...document.querySelectorAll('#start img')].map((i) => i.getAttribute('src')).slice(0, 6)));
await s.shot('critic-music-search-dark');
await P.evaluate(() => window.__aurora.settings.set('theme', 'light'));
await P.waitForTimeout(700);
await s.shot('critic-music-search-light');
await P.keyboard.press('Enter');
await P.waitForTimeout(2500);
console.log('WINS', await P.evaluate(() => [...document.querySelectorAll('.win')].map((w) => w.className)));
await s.shot('critic-music-opened-light');
console.log('LOGS', s.logs.filter((l) => /error/i.test(l)).slice(0, 10));
await s.close();
