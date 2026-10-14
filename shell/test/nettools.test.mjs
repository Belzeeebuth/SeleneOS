// Network tools tests — backend helpers (host validation, nmcli parsing) + the real Electron shell with Playwright
// (mocked nmcli / ping / DNS in dev mode): VPN list, connect / disconnect, WireGuard import, delete with confirmation,
// ping streaming + cancel + invalid host, DNS lookups and errors, keyboard tabs, backend input validation, FR + dark.
// Usage:  cd aurora-os/shell && xvfb-run -a -s "-screen 0 1600x900x24" node test/nettools.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { launchShell, ROOT } from './lib.mjs';

const require = createRequire(import.meta.url);
const DOCS = path.join(ROOT, '..', 'docs', 'screenshots');
fs.mkdirSync(DOCS, { recursive: true });
const WIN = '.win.app-nettools';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
const failures = [];
function check(name, actual, expected) {
  const ok = typeof expected === 'function' ? !!expected(actual) : Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++;
  else failures.push(`${name}\n      expected: ${typeof expected === 'function' ? '(predicate)' : JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
  return ok;
}
async function section(name, fn) {
  const t0 = Date.now();
  const before = failures.length;
  try {
    await fn();
    console.log(`  ${failures.length === before ? '✓' : '✗'} ${name} (${Date.now() - t0} ms)`);
  } catch (err) {
    failures.push(`${name}: threw ${err?.stack || err}`);
    console.log(`  ✗ ${name}: ${err?.message || err}`);
  }
}
async function until(page, expr, timeout = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await page.evaluate(expr).catch(() => false)) return true;
    await sleep(60);
  }
  return false;
}
const text = (page, sel) => page.evaluate(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? null`);
const rows = (page) =>
  page.evaluate(`[...document.querySelectorAll('${WIN} .nt-vpn')].map((r) => ({ name: r.querySelector('.nt-vpn-name').textContent, status: r.querySelector('.nt-status').textContent, btn: r.querySelector('[data-act=toggle]').textContent, active: r.classList.contains('active') }))`);
const invokeRaw = (page, channel, ...args) =>
  page.evaluate(
    `(async () => { const b = window.aurora; try { const r = b.invokeRaw ? await b.invokeRaw(${JSON.stringify(channel)}, ...${JSON.stringify(args)}) : { ok: true, value: await b.invoke(${JSON.stringify(channel)}, ...${JSON.stringify(args)}) }; return r; } catch (e) { return { ok: false, error: { message: e.message, code: e.code } }; } })()`,
  );

// ---------------------------------------------------------------- backend helpers
await section('backend helpers: host validation and nmcli parsing', async () => {
  const m = require('../main/ipc/nettools.js');
  const kinds = {
    'example.com': 'hostname',
    localhost: 'hostname',
    '1.2.3.4': 'ipv4',
    '::1': 'ipv6',
    '2001:db8::1': 'ipv6',
    '-oProxyCommand=x': null,
    'a b': null,
    'example.com; rm -rf /': null,
    '$(id)': null,
    'fe80::1%eth0': null,
    '999.1.1.1': null,
    'exa_mple.com': null,
    'a..b': null,
    '': null,
  };
  for (const [h, k] of Object.entries(kinds)) check(`hostKind(${JSON.stringify(h)})`, m.hostKind(h), k);
  check('hostKind(non-string)', m.hostKind({}), null);
  check('hostKind(label > 63)', m.hostKind(`${'x'.repeat(64)}.com`), null);
  check('splitTerse escapes', m.splitTerse('a\\:b:c\\\\d:e'), ['a:b', 'c\\d', 'e']);
  const items = m.parseConnections(
    'Home\\:WG:5b1e0c4a-1f7e-4c3b-9a43-0d2a6c1e8f01:wireguard:wg0:yes\nEth:11111111-1f7e-4c3b-9a43-0d2a6c1e8f01:802-3-ethernet:eth0:yes\nWork:9d3f2b77-6a10-4e8d-b2c5-71f0a9e4d302:vpn:--:no\nbad:not-a-uuid:vpn::no\n',
  );
  check('parseConnections keeps vpn + wireguard only', items.map((i) => i.name), ['Home:WG', 'Work']);
  check('parseConnections active/device', [items[0].active, items[0].device, items[1].active, items[1].device], [true, 'wg0', false, '']);
  check('formatRecords MX sorted', m.formatRecords('MX', [{ priority: 20, exchange: 'b' }, { priority: 10, exchange: 'a' }]), ['10 a', '20 b']);
  check('formatRecords TXT joined', m.formatRecords('TXT', [['v=spf1 ', '-all']]), ['v=spf1 -all']);
  check('DNS types', m.DNS_TYPES, ['A', 'AAAA', 'MX', 'TXT', 'NS', 'CNAME']);
});

// ---------------------------------------------------------------- English, light
let s = await launchShell({ open: ['nettools'], lang: 'en', theme: 'light', env: { AURORA_NETTOOLS_PING_MS: '60' } });
const page = s.page;
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(e.message));

await section('launch: window, tabs, VPN list', async () => {
  check('window opened', await until(page, `!!document.querySelector('${WIN} .nt-vpn')`, 20000), true);
  check('six tabs', await page.evaluate(`[...document.querySelectorAll('${WIN} [role=tab]')].map((t) => t.textContent)`), ['VPN', 'Ping', 'Traceroute', 'DNS lookup', 'Ports', 'Speed test']);
  check('VPN tab selected', await page.evaluate(`document.querySelector('${WIN} #nt-tab-vpn').getAttribute('aria-selected')`), 'true');
  check('other panels hidden', await page.evaluate(`[...document.querySelectorAll('${WIN} [role=tabpanel]')].map((p) => p.hidden)`), [false, true, true, true, true, true]);
  const r = await rows(page);
  check('two mock connections', r.map((x) => x.name), ['Home WireGuard', 'Office VPN']);
  check('Home WireGuard connected', r[0].status, 'Connected · wg-home');
  check('Office VPN not connected', [r[1].status, r[1].btn], ['Not connected', 'Connect']);
  check('import hint', await text(page, `${WIN} .nt-later`), 'Import a WireGuard .conf or an OpenVPN .ovpn file, or drop it here. Certificates and keys next to an .ovpn file are copied with it.');
  check('title shows app name', await page.evaluate(`document.querySelector('${WIN}').textContent.includes('Network tools')`), true);
  check('no "null"/"undefined" text', await page.evaluate(`/\\b(null|undefined)\\b/.test(document.querySelector('${WIN} .nt-root').textContent)`), false);
});

await section('VPN: connect and disconnect', async () => {
  await page.click(`${WIN} .nt-vpn:nth-child(2) [data-act=toggle]`);
  check('working state shown', await until(page, `[...document.querySelectorAll('${WIN} .nt-status')].some((x) => x.textContent === 'Working…')`, 2000), true);
  check('Office VPN connects', await until(page, `document.querySelectorAll('${WIN} .nt-vpn')[1]?.querySelector('.nt-status').textContent === 'Connected · tun0'`), true);
  check('button now Disconnect', (await rows(page))[1].btn, 'Disconnect');
  await page.click(`${WIN} .nt-vpn:nth-child(1) [data-act=toggle]`);
  check('Home WireGuard disconnects', await until(page, `document.querySelectorAll('${WIN} .nt-vpn')[0]?.querySelector('.nt-status').textContent === 'Not connected'`), true);
  check('active class follows', (await rows(page)).map((x) => x.active), [false, true]);
});

await section('VPN: import WireGuard file', async () => {
  const conf = path.join(s.home, 'Documents', 'travel.conf');
  fs.writeFileSync(conf, '[Interface]\nPrivateKey = x\nAddress = 10.0.0.2/32\n[Peer]\nPublicKey = y\nEndpoint = vpn.example.com:51820\nAllowedIPs = 0.0.0.0/0\n');
  await page.click(`${WIN} [data-act=import]`);
  check('file picker opens', await until(page, `!!document.querySelector('.dialog-layer:not(.closing) .dialog')`, 5000), true);
  await page.keyboard.press('Escape');
  await until(page, `!document.querySelector('.dialog-layer:not(.closing) .dialog')`, 3000);
  await page.evaluate(`document.querySelector('${WIN} .nt-root').parentElement.__nettools.importPath(${JSON.stringify(conf)})`);
  check('imported row appears', await until(page, `[...document.querySelectorAll('${WIN} .nt-vpn-name')].some((x) => x.textContent === 'travel')`), true);
  check('success infobar', await text(page, `${WIN} .nt-vpn-info .infobar.success`), '“travel” was imported.');
  check('imported as WireGuard', await page.evaluate(`[...document.querySelectorAll('${WIN} .nt-vpn')].find((r) => r.textContent.includes('travel')).querySelector('.nt-badge').textContent`), 'WireGuard');
  await page.evaluate(`document.querySelector('${WIN} .nt-root').parentElement.__nettools.importPath(${JSON.stringify(conf)})`);
  check('duplicate import -> error infobar', await until(page, `!!document.querySelector('${WIN} .nt-vpn-info .infobar.error')`), true);
  const bad = path.join(s.home, 'Documents', 'notes.txt');
  fs.writeFileSync(bad, 'x');
  check('backend rejects non-.conf', (await invokeRaw(page, 'nettools:vpnImport', bad)).error?.code, 'EINVAL');
  check('backend rejects relative path', (await invokeRaw(page, 'nettools:vpnImport', 'travel.conf')).error?.code, 'EINVAL');
  check('backend rejects missing file', (await invokeRaw(page, 'nettools:vpnImport', path.join(s.home, 'nope.conf'))).error?.code, 'ENOENT');
  await page.evaluate(`document.querySelector('${WIN} .nt-root').parentElement.__nettools.importPath(${JSON.stringify(bad)})`);
  check('bad file -> localized error', await until(page, `(document.querySelector('${WIN} .nt-vpn-info .infobar.error')?.textContent || '').includes('64 KB')`), true);
});

await section('VPN: delete asks for confirmation', async () => {
  const delSel = `${WIN} .nt-vpn[data-uuid] [aria-label="Delete “travel”"]`;
  await page.click(delSel);
  check('confirm dialog', await until(page, `!!document.querySelector('.dialog-layer:not(.closing) .dialog')`, 4000), true);
  check('dialog title', await text(page, '.dialog-layer:not(.closing) .dialog-title'), 'Delete this VPN connection?');
  await page.click('.dialog-layer:not(.closing) .dialog-footer .btn:not(.danger)');
  await sleep(400);
  check('cancel keeps the row', (await rows(page)).some((x) => x.name === 'travel'), true);
  await page.click(delSel);
  await until(page, `!!document.querySelector('.dialog-layer:not(.closing) .dialog-footer .btn.danger')`, 4000);
  check('danger button label', await text(page, '.dialog-layer:not(.closing) .dialog-footer .btn.danger'), 'Delete');
  await page.click('.dialog-layer:not(.closing) .dialog-footer .btn.danger');
  check('row removed', await until(page, `![...document.querySelectorAll('${WIN} .nt-vpn-name')].some((x) => x.textContent === 'travel')`), true);
  check('two rows left', (await rows(page)).length, 2);
});

await section('backend validation (no shell, strict host / uuid)', async () => {
  check('ping rejects option injection', (await invokeRaw(page, 'nettools:ping', '-c 1000 example.com')).error?.code, 'EINVAL');
  check('ping rejects shell metachars', (await invokeRaw(page, 'nettools:ping', 'a.com;id')).error?.code, 'EINVAL');
  check('ping rejects non-string', (await invokeRaw(page, 'nettools:ping', { host: 'x' })).error?.code, 'EINVAL');
  check('vpnUp rejects bad uuid', (await invokeRaw(page, 'nettools:vpnUp', '--help')).error?.code, 'EINVAL');
  check('vpnDelete rejects bad uuid', (await invokeRaw(page, 'nettools:vpnDelete', 'abc')).error?.code, 'EINVAL');
  check('dns rejects IP', (await invokeRaw(page, 'nettools:dns', '1.2.3.4', 'A')).error?.code, 'EINVAL');
  check('dns rejects type', (await invokeRaw(page, 'nettools:dns', 'example.com', 'AXFR')).error?.code, 'EINVAL');
  check('vpnList mock flag', (await invokeRaw(page, 'nettools:vpnList')).value?.mock, true);
});

await section('keyboard: arrow keys move between tabs', async () => {
  await page.focus(`${WIN} #nt-tab-vpn`);
  await page.keyboard.press('ArrowRight');
  check('Ping selected', await page.evaluate(`document.querySelector('${WIN} #nt-tab-ping').getAttribute('aria-selected')`), 'true');
  check('Ping tab focused', await page.evaluate(`document.activeElement?.id`), 'nt-tab-ping');
  check('ping panel visible', await page.evaluate(`document.querySelector('${WIN} #nt-panel-ping').hidden`), false);
  await page.keyboard.press('End');
  check('End -> Speed test', await page.evaluate(`document.activeElement?.id`), 'nt-tab-speed');
  await page.keyboard.press('ArrowRight');
  check('wraps to VPN', await page.evaluate(`document.activeElement?.id`), 'nt-tab-vpn');
  await page.keyboard.press('ArrowLeft');
  check('ArrowLeft wraps to Speed test', await page.evaluate(`document.activeElement?.id`), 'nt-tab-speed');
  check('roving tabindex', await page.evaluate(`[...document.querySelectorAll('${WIN} [role=tab]')].map((t) => t.tabIndex)`), [-1, -1, -1, -1, -1, 0]);
});

await section('ping: stream, invalid host, failure, cancel', async () => {
  await page.click(`${WIN} #nt-tab-ping`);
  await page.fill(`${WIN} #nt-ping-host`, '-oProxy');
  await page.press(`${WIN} #nt-ping-host`, 'Enter');
  check('invalid host message', await text(page, `${WIN} #nt-panel-ping .nt-status-line`), 'Enter a host name, IPv4 or IPv6 address.');
  check('aria-invalid set', await page.getAttribute(`${WIN} #nt-ping-host`, 'aria-invalid'), 'true');
  await page.fill(`${WIN} #nt-ping-host`, 'example.com');
  await page.press(`${WIN} #nt-ping-host`, 'Enter');
  check('running status', await text(page, `${WIN} #nt-panel-ping .nt-status-line`), 'Pinging example.com…');
  check('lines stream in', await until(page, `document.querySelector('${WIN} .nt-out').textContent.includes('icmp_seq=1')`, 5000), true);
  check('finishes ok', await until(page, `document.querySelector('${WIN} #nt-panel-ping .nt-status-line').textContent === 'Done: example.com answered.'`, 8000), true);
  const out = await text(page, `${WIN} .nt-out`);
  check('four replies', (out.match(/icmp_seq=/g) || []).length, 4);
  check('summary line', out.includes('4 packets transmitted, 4 received, 0% packet loss'), true);
  check('start re-enabled, cancel disabled', await page.evaluate(`[document.querySelector('${WIN} [data-act=ping]').disabled, document.querySelector('${WIN} [data-act=cancel]').disabled]`), [false, true]);
  await page.fill(`${WIN} #nt-ping-host`, '192.0.2.1');
  await page.click(`${WIN} [data-act=ping]`);
  check('unreachable -> no answer', await until(page, `document.querySelector('${WIN} #nt-panel-ping .nt-status-line').textContent === 'No answer from 192.0.2.1.'`, 8000), true);
  check('100% loss shown', (await text(page, `${WIN} .nt-out`)).includes('100% packet loss'), true);
  await page.fill(`${WIN} #nt-ping-host`, '2001:db8::1');
  await page.click(`${WIN} [data-act=ping]`);
  await until(page, `!document.querySelector('${WIN} [data-act=cancel]').disabled`, 3000);
  await page.click(`${WIN} [data-act=cancel]`);
  check('cancelled', await until(page, `document.querySelector('${WIN} #nt-panel-ping .nt-status-line').textContent === 'Cancelled.'`, 4000), true);
  const lines = (await text(page, `${WIN} .nt-out`)).match(/icmp_seq=/g) || [];
  await sleep(500);
  check('no lines after cancel', ((await text(page, `${WIN} .nt-out`)).match(/icmp_seq=/g) || []).length, lines.length);
  check('output is a log region', await page.getAttribute(`${WIN} .nt-out`, 'role'), 'log');
});

await section('DNS: lookups and errors', async () => {
  await page.click(`${WIN} #nt-tab-dns`);
  await page.fill(`${WIN} #nt-dns-host`, 'example.com');
  await page.press(`${WIN} #nt-dns-host`, 'Enter');
  check('A record', await until(page, `document.querySelector('${WIN} .nt-rvalue')?.textContent === '93.184.215.14'`), true);
  check('count status', await text(page, `${WIN} #nt-panel-dns .nt-status-line`), '1 A record');
  await page.selectOption(`${WIN} #nt-dns-type`, 'NS');
  await page.click(`${WIN} [data-act=lookup]`);
  check('NS records', await until(page, `document.querySelectorAll('${WIN} .nt-record').length === 2`), true);
  check('NS plural status', await text(page, `${WIN} #nt-panel-dns .nt-status-line`), '2 NS records');
  check('NS values', await page.evaluate(`[...document.querySelectorAll('${WIN} .nt-rvalue')].map((x) => x.textContent)`), ['a.iana-servers.net', 'b.iana-servers.net']);
  await page.selectOption(`${WIN} #nt-dns-type`, 'CNAME');
  await page.fill(`${WIN} #nt-dns-host`, 'www.example.com');
  await page.click(`${WIN} [data-act=lookup]`);
  check('CNAME', await until(page, `document.querySelector('${WIN} .nt-rvalue')?.textContent === 'example.com'`), true);
  await page.fill(`${WIN} #nt-dns-host`, 'example.com');
  await page.click(`${WIN} [data-act=lookup]`);
  check('no CNAME -> none message', await until(page, `document.querySelector('${WIN} #nt-panel-dns .nt-status-line').textContent === 'No CNAME records for example.com.'`), true);
  await page.selectOption(`${WIN} #nt-dns-type`, 'MX');
  await page.fill(`${WIN} #nt-dns-host`, 'nothing.invalid');
  await page.click(`${WIN} [data-act=lookup]`);
  check('NXDOMAIN message', await until(page, `document.querySelector('${WIN} #nt-panel-dns .nt-status-line').textContent === 'nothing.invalid doesn’t exist.'`), true);
  check('no records listed', await page.evaluate(`document.querySelectorAll('${WIN} .nt-record').length`), 0);
  await page.fill(`${WIN} #nt-dns-host`, '8.8.8.8');
  await page.click(`${WIN} [data-act=lookup]`);
  check('IP rejected in UI', await text(page, `${WIN} #nt-panel-dns .nt-status-line`), 'Enter a domain name such as example.com.');
  await page.selectOption(`${WIN} #nt-dns-type`, 'A');
  await page.fill(`${WIN} #nt-dns-host`, 'example.com');
  await page.click(`${WIN} [data-act=lookup]`);
  await until(page, `!!document.querySelector('${WIN} .nt-rvalue')`);
  check('copy button labelled', await page.evaluate(`document.querySelector('${WIN} .nt-record button').getAttribute('aria-label')`), 'Copy 93.184.215.14');
});

await section('screenshot + console', async () => {
  await page.click(`${WIN} #nt-tab-vpn`);
  await until(page, `document.querySelectorAll('${WIN} .nt-vpn').length === 2`);
  await sleep(300);
  await page.locator(WIN).screenshot({ path: path.join(DOCS, 'nettools-light-en.png') });
  check('light screenshot written', fs.existsSync(path.join(DOCS, 'nettools-light-en.png')), true);
  check('no console errors', errors.filter((e) => !/favicon|ERR_FILE_NOT_FOUND/.test(e)), []);
});
await s.close();

// ---------------------------------------------------------------- French, dark
s = await launchShell({ open: ['nettools'], lang: 'fr', theme: 'dark', env: { AURORA_NETTOOLS_PING_MS: '40' } });
await section('French + dark theme', async () => {
  const p = s.page;
  check('window opened (fr)', await until(p, `!!document.querySelector('${WIN} .nt-vpn')`, 20000), true);
  check('FR tabs', await p.evaluate(`[...document.querySelectorAll('${WIN} [role=tab]')].map((t) => t.textContent)`), ['VPN', 'Ping', 'Traceroute', 'Recherche DNS', 'Ports', 'Test de débit']);
  check('FR title', await text(p, `${WIN} .nt-h2`), 'Connexions VPN');
  check('FR status', (await rows(p))[0].status, 'Connecté · wg-home');
  check('FR connect button', (await rows(p))[1].btn, 'Se connecter');
  check('FR import hint', (await text(p, `${WIN} .nt-later`)).startsWith('Importez un fichier .conf WireGuard ou .ovpn OpenVPN'), true);
  check('FR import label', await text(p, `${WIN} [data-act=import]`), 'Importer un fichier VPN');
  const dark = await p.evaluate(`(() => { const c = getComputedStyle(document.querySelector('${WIN} .nt-vpn-name')).color.match(/\\d+/g).map(Number); return (c[0] + c[1] + c[2]) / 3; })()`);
  check('dark theme: light text', dark, (v) => v > 180);
  await p.locator(WIN).screenshot({ path: path.join(DOCS, 'nettools-dark-fr.png') });
  await p.click(`${WIN} #nt-tab-ping`);
  await p.fill(`${WIN} #nt-ping-host`, 'example.com');
  await p.press(`${WIN} #nt-ping-host`, 'Enter');
  check('FR ping done', await until(p, `document.querySelector('${WIN} #nt-panel-ping .nt-status-line').textContent === 'Terminé : example.com a répondu.'`, 8000), true);
  await p.click(`${WIN} #nt-tab-dns`);
  await p.fill(`${WIN} #nt-dns-host`, 'example.com');
  await p.press(`${WIN} #nt-dns-host`, 'Enter');
  check('FR DNS count', await until(p, `document.querySelector('${WIN} #nt-panel-dns .nt-status-line').textContent === '1 enregistrement A'`), true);
  check('remembered tab is restored next launch (stored)', await p.evaluate(`document.querySelector('${WIN} #nt-tab-dns').getAttribute('aria-selected')`), 'true');
  check('dark screenshot written', fs.existsSync(path.join(DOCS, 'nettools-dark-fr.png')), true);
});
await s.close();

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
process.exit(0);
