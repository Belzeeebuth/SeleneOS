import { launchShell } from './lib.mjs';
const [lang = 'en', theme = 'light'] = process.argv.slice(2);
const s = await launchShell({ open: ['todo'], lang, theme });
const W = '.win.app-todo';
await s.page.waitForSelector(`${W} .td`, { timeout: 20000 });
await s.page.waitForTimeout(800);
const p = s.page;
// go to Tasks
await p.click(`${W} .td-nav-item[data-view="list:tasks"]`);
await p.waitForTimeout(400);
await s.shot('todo-p1-tasks');
// open detail of the steps task
await p.click(`${W} .td-task:nth-child(4) .td-row-title`);
await p.waitForTimeout(500);
await s.shot('todo-p2-detail');
// add task
await p.click(`${W} .td-add-input`);
await p.keyboard.type('Buy flowers');
await p.waitForTimeout(200);
await s.shot('todo-p3-adding');
await p.keyboard.press('Enter');
await p.waitForTimeout(400);
// complete first task
await p.click(`${W} .td-task .td-check`);
await p.waitForTimeout(150);
await s.shot('todo-p4-completing');
await p.waitForTimeout(900);
await s.shot('todo-p5-completed');
await p.click(`${W} .td-nav-item[data-view="planned"]`);
await p.waitForTimeout(500);
await s.shot('todo-p6-planned');
console.log(s.logs.filter((l) => /error|warn/i.test(l)).join('\n'));
await s.close();
