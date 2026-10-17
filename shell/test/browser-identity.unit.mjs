// Unit tests for main/lib/chrome-identity.js (the Navigateur's Chrome identity), checked against the Sec-CH-UA values
// real Google Chrome builds send.   node test/browser-identity.unit.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const id = require('../main/lib/chrome-identity.js');
let n = 0;
let failed = 0;
const check = (cond, msg) => {
  n++;
  if (cond) return;
  failed++;
  console.log(`  ✘ ${msg}`);
};
const header = (full) => id.hintValues(full)['sec-ch-ua'];
// Real Chrome headers (Linux / any desktop: the brand list does not depend on the platform).
const REAL = {
  '120.0.6099.109': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
  '124.0.6367.91': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  '131.0.6778.85': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
  '137.0.7151.68': '"Google Chrome";v="137", "Chromium";v="137", "Not/A)Brand";v="24"',
};
for (const [v, want] of Object.entries(REAL)) check(header(v) === want, `sec-ch-ua for Chrome ${v}: ${header(v)}`);
check(id.greaseBrand(152).brand === 'Not?A_Brand' && id.greaseBrand(152).version === '24', 'GREASE brand of Chromium 152 (as Electron 44 reports it)');
check(JSON.stringify(id.brands(true, '131.0.6778.85')) === JSON.stringify([{ brand: 'Google Chrome', version: '131.0.6778.85' }, { brand: 'Chromium', version: '131.0.6778.85' }, { brand: 'Not_A Brand', version: '24.0.0.0' }]), 'full version list');
check(id.userAgent('152.0.7977.130') === `Mozilla/5.0 (${process.arch === 'arm64' ? 'X11; Linux aarch64' : 'X11; Linux x86_64'}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36`, 'reduced UA string');
check(id.platformVersion('6.8.0-45-generic') === '6.8.0' && id.platformVersion('7.0') === '7.0.0' && id.platformVersion('x') === '', 'platform version from the kernel release');
check(id.acceptLanguages('fr') === 'fr-FR,fr,en-US,en' && id.acceptLanguages('en') === 'en-US,en', 'accept languages (no q-values: Electron adds them)');
const hv = id.hintValues('152.0.7977.130');
check(hv['sec-ch-ua-mobile'] === '?0' && hv['sec-ch-ua-platform'] === '"Linux"' && hv['sec-ch-ua-model'] === '""' && hv['sec-ch-ua-wow64'] === '?0' && hv['sec-ch-ua-bitness'] === '"64"', 'hint values');
// withHints: secure requests only, low-entropy always, high-entropy when asked, Chromium's own values replaced
const base = { 'User-Agent': 'x', 'sec-ch-ua': '"Chromium";v="152"', 'Sec-CH-UA-Mobile': '?1' };
let h = id.withHints(base, 'https://accounts.google.com/', new Set(), '152.0.7977.130');
check(h['sec-ch-ua'] === hv['sec-ch-ua'] && h['sec-ch-ua-mobile'] === '?0' && !('Sec-CH-UA-Mobile' in h) && h['User-Agent'] === 'x', 'low-entropy hints replace Chromium ones');
check(!('sec-ch-ua-full-version-list' in h), 'no high-entropy hint unasked');
h = id.withHints(base, 'https://accounts.google.com/', id.parseHintList(['Sec-CH-UA-Full-Version-List, sec-ch-ua-arch, Sec-CH-Prefers-Color-Scheme']), '152.0.7977.130');
check(h['sec-ch-ua-full-version-list'] === hv['sec-ch-ua-full-version-list'] && h['sec-ch-ua-arch'] === hv['sec-ch-ua-arch'] && !('sec-ch-prefers-color-scheme' in h), 'asked hints only (UA ones)');
h = id.withHints(base, 'http://example.com/', new Set(['sec-ch-ua-arch']), '152.0.7977.130');
check(!Object.keys(h).some((k) => /^sec-ch-ua/i.test(k)), 'no hints on plain http');
check(id.isSecureUrl('http://localhost:8080/') && id.isSecureUrl('http://127.0.0.1/') && id.isSecureUrl('wss://a.b/') && !id.isSecureUrl('http://192.168.1.2/') && !id.isSecureUrl('ftp://x/') && !id.isSecureUrl('nonsense'), 'secure URLs');
const md = id.metadata('152.0.7977.130');
check(md.platform === 'Linux' && md.mobile === false && md.bitness === '64' && md.fullVersion === '152.0.7977.130' && md.brands.length === 3 && md.formFactors[0] === 'Desktop', 'DevTools metadata');
check(id.chromeVersion('bad') === '146.0.0.0' && id.chromeVersion('152.0.7977.130') === '152.0.7977.130', 'version fallback');
console.log(`${n - failed}/${n} passed`);
process.exit(failed ? 1 : 0);
