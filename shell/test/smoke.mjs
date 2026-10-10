// Smoke test: boots the shell, opens Start and the reference app, checks for renderer errors.
// Usage: xvfb-run -a -s "-screen 0 1600x900x24" node test/smoke.mjs [--lang=fr] [--theme=dark]
import { launchShell } from './lib.mjs';

const arg = (n, d) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').split('=')[1] || d;
const lang = arg('lang', 'en');
const theme = arg('theme', 'light');
const s = await launchShell({ lang, theme, open: ['winver'] });
const errors = s.logs.filter((l) => l.startsWith('[error]') || l.startsWith('[pageerror]'));
await s.shot(`smoke-${lang}-${theme}-desktop`);
await s.page.click('.tb-start');
await s.page.waitForTimeout(600);
await s.shot(`smoke-${lang}-${theme}-start`);
await s.close();
console.log(errors.length ? `FAIL: ${errors.length} renderer errors\n${errors.join('\n')}` : 'OK: no renderer errors');
process.exit(errors.length ? 1 : 0);
