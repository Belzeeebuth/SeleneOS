// Aurora Mail end-to-end tests: a local IMAP server (hoodiecrow-imap, in this process) and a local
// SMTP server (smtp-server) seeded with ~65 messages, driven through the real shell.
//   xvfb-run -a -s "-screen 0 1600x900x24" node test/mail.test.mjs [--only=name,name] [--keep] [--server]
// The two test-only packages are NOT shell dependencies: they are installed once into
// $MAILTEST_DIR (default /tmp/claude-0/mailtest, or <tmp>/aurora-mailtest) with `npm i smtp-server hoodiecrow-imap`.
// --server only starts the servers (prints ports) for manual testing.
// Screenshots: test/out/mail-*.png; the reference ones are copied to docs/screenshots/.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { launchShell } from './lib.mjs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const DOCS_SHOTS = path.join(here, '..', '..', 'docs', 'screenshots');

export const USER = 'alice@aurora.test';
export const PASS = 'Aurora-Test-1';

// ------------------------------------------------------------------ test-only dependencies
function testDeps() {
  const candidates = [process.env.MAILTEST_DIR, '/tmp/claude-0/mailtest', path.join(os.tmpdir(), 'aurora-mailtest')].filter(Boolean);
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'node_modules', 'hoodiecrow-imap')) && fs.existsSync(path.join(dir, 'node_modules', 'smtp-server'))) return dir;
  }
  const dir = candidates[0];
  fs.mkdirSync(dir, { recursive: true });
  console.log(`[mailtest] installing smtp-server + hoodiecrow-imap into ${dir}`);
  if (!fs.existsSync(path.join(dir, 'package.json'))) fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"aurora-mailtest","private":true}');
  execFileSync('npm', ['i', '--no-audit', '--no-fund', 'smtp-server', 'hoodiecrow-imap'], { cwd: dir, stdio: 'inherit' });
  return dir;
}

// ------------------------------------------------------------------ fixtures
function crc32(buf) {
  let c;
  const table = (crc32.t ||= Array.from({ length: 256 }, (_, n) => {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  }));
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// A small gradient PNG (no image library needed).
export function png(w = 96, h = 64, [r1, g1, b1] = [40, 110, 240], [r2, g2, b2] = [120, 220, 200]) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const t = (x + y) / (w + h);
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = Math.round(r1 + (r2 - r1) * t);
      raw[o + 1] = Math.round(g1 + (g2 - g1) * t);
      raw[o + 2] = Math.round(b1 + (b2 - b1) * t);
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function pdf(text = 'Aurora quarterly report') {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const stream = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET`;
  objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let out = '%PDF-1.4\n';
  const offs = [];
  objs.forEach((o, i) => {
    offs.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const MailComposer = (() => {
  const m = require('nodemailer/lib/mail-composer');
  return m.default || m;
})();
export function build(mail) {
  const node = new MailComposer({ headers: { 'X-Mailer': 'Aurora test fixtures' }, ...mail }).compile();
  node.keepBcc = true;
  return new Promise((resolve, reject) => node.build((e, b) => (e ? reject(e) : resolve(b.toString('binary')))));
}

const SENDERS = [
  ['Contoso Weekly', 'news@contoso.example'],
  ['Marc Dupont', 'marc@dupont.example'],
  ['Sophie Martin', 'sophie@martin.example'],
  ['Élodie Fournier', 'elodie@exemple.fr'],
  ['Ravi Patel', 'ravi@fabrikam.example'],
  ['GitHub', 'noreply@github.example'],
  ['Northwind Bank', 'alerts@northwind.example'],
  ['Lucas Bernard', 'lucas.bernard@exemple.fr'],
  ['Mia Chen', 'mia.chen@adatum.example'],
  ['Travel Desk', 'travel@tailspin.example'],
];
const TOPICS = [
  ['Build #{n} passed', 'All checks passed on main. 1 284 tests, 0 failures. Artifacts are ready for download.'],
  ['Your statement is ready', 'Your monthly statement for account ending 4821 is available in online banking.'],
  ['Lunch on Thursday?', 'Are you free for lunch on Thursday? There is a new place near the office.'],
  ['Weekly sync notes', 'Action items: update the roadmap, review the design specs, book the meeting room.'],
  ['Flight confirmation XK{n}', 'Your flight is confirmed. Check-in opens 24 hours before departure.'],
  ['Code review requested', 'You have been asked to review a change in aurora-shell: "Improve window snapping".'],
  ['Photos from the weekend', 'Here are a few photos from the weekend. The weather was great!'],
  ['Invoice {n}', 'Please find the details of invoice {n} in your customer area.'],
];

export async function seed({ gmail = false } = {}) {
  const now = Date.now();
  const H = 3600 * 1000;
  const D = 24 * H;
  const at = (ms) => new Date(now - ms);
  const inbox = [];
  const add = async (box, mail, { flags = [], ago = H } = {}) => {
    const date = at(ago);
    box.push({ raw: await build({ date, to: `Alice Martin <${USER}>`, ...mail }), flags, internaldate: date });
  };
  // Filler first (oldest), so the interesting messages are on the first page.
  for (let i = 0; i < 48; i++) {
    const [name, address] = SENDERS[(i * 3) % SENDERS.length];
    const [subject, body] = TOPICS[i % TOPICS.length];
    const n = 1000 + i;
    await add(inbox, { from: { name, address }, subject: subject.replace('{n}', n), text: `Hi Alice,\n\n${body.replaceAll('{n}', n)}\n\nBest regards,\n${name}` }, { flags: ['\\Seen'], ago: (6 + i * 1.7) * D });
  }
  await add(
    inbox,
    {
      from: { name: 'Ravi Patel', address: 'ravi@fabrikam.example' },
      cc: [{ name: 'Mia Chen', address: 'mia.chen@adatum.example' }, 'lucas.bernard@exemple.fr'],
      subject: 'Re: Projet Aurora — planning',
      inReplyTo: '<thread-2@fabrikam.example>',
      references: ['<thread-1@aurora.test>', '<thread-2@fabrikam.example>'],
      text: 'Sounds good to me. Let us freeze the scope on Friday.\n\nRavi\n\nOn Tue, Mia Chen wrote:\n> I updated the planning with the new milestones.\n> The beta is now planned for next month.\n>\n>> On Mon, Alice Martin wrote:\n>> Can everyone review the planning before Friday?\n',
    },
    { flags: ['\\Seen', '\\Answered'], ago: 3 * D },
  );
  await add(
    inbox,
    {
      from: { name: 'Mallory', address: 'mallory@evil.example' },
      subject: 'Security test message',
      html: `<html><head><meta http-equiv="refresh" content="0;url=https://evil.example/refresh"><script>window.top.postMessage('pwned','*')</script><link rel="stylesheet" href="https://evil.example/style.css"><base href="https://evil.example/"></head>
<body><h2 id="safe-heading">Totally safe content</h2><p>Click <a id="js-link" href="javascript:alert(1)">here</a> or <a id="web-link" href="https://www.example.com/page">a normal link</a>.</p>
<img id="onerror-img" src="x" onerror="alert(1)"><iframe src="https://evil.example/frame"></iframe><form action="https://evil.example/steal"><input name="password"><button>Go</button></form>
<object data="https://evil.example/x.swf"></object><svg><script>alert(2)</script></svg><div style="background:url(https://evil.example/bg.png)">Background</div></body></html>`,
      text: 'Totally safe content',
    },
    { flags: [], ago: 2.5 * D },
  );
  await add(
    inbox,
    {
      from: { name: 'Élodie Fournier', address: 'elodie@exemple.fr' },
      messageId: '<meeting-notes@exemple.fr>',
      subject: "Réunion d'équipe — compte rendu",
      text: "Bonjour à tous,\n\nVoici le compte rendu de la réunion d'équipe de mardi :\n\n• Les déploiements se feront désormais le jeudi.\n• L'équipe « Interface » présentera la maquette à la fin du mois.\n• Prochaine réunion : lundi 14 h 30, salle Hélène-Boucher.\n\nN'hésitez pas à me répondre si j'ai oublié quelque chose.\n\nÉlodie\nhttps://intranet.exemple.fr/reunions",
    },
    { flags: ['\\Flagged'], ago: 2 * D },
  );
  await add(
    inbox,
    {
      from: { name: 'Lucas Bernard', address: 'lucas.bernard@exemple.fr' },
      subject: 'Contact et liens',
      html: '<p>Bonjour Alice,</p><p>Écris-moi à <a id="mailto-link" href="mailto:lucas.bernard@exemple.fr?subject=Bonjour%20Lucas">lucas.bernard@exemple.fr</a> ou consulte <a href="https://www.example.com/agenda">l\'agenda</a>.</p><p>Lucas</p>',
      text: 'Bonjour Alice, écris-moi à lucas.bernard@exemple.fr',
    },
    { flags: ['\\Seen'], ago: 1.6 * D },
  );
  await add(
    inbox,
    {
      from: { name: 'Sophie Martin', address: 'sophie@martin.example' },
      subject: 'Photo from the trip',
      html: '<p>Hi Alice!</p><p>Here is the view from the hotel:</p><p><img id="inline-photo" src="cid:photo1@aurora.test" width="192" height="128" alt="View"></p><p>See you soon,<br>Sophie</p>',
      text: 'Hi Alice! Here is the view from the hotel. See you soon, Sophie',
      attachments: [{ filename: 'view.png', content: png(192, 128, [250, 150, 60], [90, 60, 200]), cid: 'photo1@aurora.test', contentType: 'image/png' }],
    },
    { flags: ['\\Seen'], ago: 1.1 * D },
  );
  await add(
    inbox,
    {
      from: { name: 'Marc Dupont', address: 'marc@dupont.example' },
      subject: 'Quarterly report (PDF + spreadsheet)',
      text: 'Hello Alice,\n\nPlease find attached the quarterly report and the raw data.\n\nMarc',
      attachments: [
        { filename: 'Quarterly report.pdf', content: pdf(), contentType: 'application/pdf' },
        { filename: 'data.csv', content: 'month,revenue\nJanuary,1200\nFebruary,1350\nMarch,1610\n', contentType: 'text/csv' },
        { filename: 'chart.png', content: png(120, 80), contentType: 'image/png' },
      ],
    },
    { flags: [], ago: 20 * H },
  );
  await add(
    inbox,
    {
      from: { name: 'Contoso Weekly', address: 'news@contoso.example' },
      subject: 'Your weekly digest: 5 stories you might have missed',
      html: `<!doctype html><html><head><style>.wrap{max-width:560px;margin:0 auto;font-family:Arial,sans-serif;color:#222}.hero{width:100%;border-radius:8px}h1{color:#0f6cbd}.btn{display:inline-block;background:#0f6cbd;color:#fff;padding:10px 18px;border-radius:4px;text-decoration:none}</style></head>
<body><div class="wrap"><img id="hero" class="hero" src="https://images.contoso.example/hero.png" alt="Weekly digest"><h1>This week at Contoso</h1>
<p>Five stories you might have missed, hand-picked by our editors.</p><ol><li>New offices open in Lyon</li><li>Product roadmap for the next quarter</li><li>Meet the team behind the redesign</li><li>Tips for remote collaboration</li><li>Community highlights</li></ol>
<p><a class="btn" href="https://www.contoso.example/digest">Read the digest</a></p><img src="https://track.contoso.example/open.gif?u=alice" width="1" height="1" alt=""></div></body></html>`,
      text: 'This week at Contoso — five stories you might have missed.',
    },
    { flags: [], ago: 2 * H },
  );
  await add(
    inbox,
    {
      from: { name: 'Aurora Team', address: 'team@aurora.test' },
      subject: 'Welcome to Aurora Mail',
      text: 'Hi Alice,\n\nWelcome to Aurora Mail! Your account is ready.\n\nTips:\n- Press Ctrl+N to write a new message.\n- Flag important messages to find them quickly.\n\nLearn more at https://aurora.example/docs/mail\n\nThe Aurora team',
    },
    { flags: [], ago: 0.5 * H },
  );

  const sent = [];
  await add(sent, { from: { name: 'Alice Martin', address: USER }, to: 'Ravi Patel <ravi@fabrikam.example>', subject: 'Projet Aurora — planning', text: 'Can everyone review the planning before Friday?' }, { flags: ['\\Seen'], ago: 4 * D });
  await add(sent, { from: { name: 'Alice Martin', address: USER }, to: 'mia.chen@adatum.example', subject: 'Design review', text: 'The new mockups look great.' }, { flags: ['\\Seen'], ago: 5 * D });
  const drafts = [];
  await add(drafts, { from: { name: 'Alice Martin', address: USER }, to: 'sophie@martin.example', subject: 'Trip plans (draft)', html: '<p>Hi Sophie, about the trip…</p>', text: 'Hi Sophie, about the trip…' }, { flags: ['\\Seen', '\\Draft'], ago: 6 * H });
  const archive = [];
  await add(archive, { from: { name: 'Travel Desk', address: 'travel@tailspin.example' }, subject: 'Hotel booking confirmed', text: 'Your hotel booking is confirmed.' }, { flags: ['\\Seen'], ago: 30 * D });
  const junk = [];
  await add(junk, { from: { name: 'Prize Center', address: 'win@spam.example' }, subject: 'You have won!!!', text: 'Claim your prize now.' }, { flags: [], ago: 3 * H });
  const trash = [];
  await add(trash, { from: { name: 'Old Newsletter', address: 'old@news.example' }, subject: 'Old news', text: 'Nothing to see.' }, { flags: ['\\Seen'], ago: 9 * D });
  const projects = [];
  await add(projects, { from: { name: 'Mia Chen', address: 'mia.chen@adatum.example' }, subject: 'Aurora milestones', text: 'Milestone 1: alpha. Milestone 2: beta.' }, { flags: [], ago: 8 * D });

  if (gmail) {
    // Gmail-like tree: special folders nested under a \\Noselect "[Gmail]" parent.
    return {
      INBOX: { messages: inbox },
      '': {
        separator: '/',
        folders: {
          '[Gmail]': {
            flags: ['\\Noselect'],
            folders: {
              'All Mail': { 'special-use': '\\All', messages: [...archive] },
              Drafts: { 'special-use': '\\Drafts', messages: drafts },
              'Sent Mail': { 'special-use': '\\Sent', messages: sent },
              Spam: { 'special-use': '\\Junk', messages: junk },
              Starred: { 'special-use': '\\Flagged' },
              Trash: { 'special-use': '\\Trash', messages: trash },
            },
          },
          Receipts: { messages: projects },
        },
      },
    };
  }
  return {
    INBOX: { messages: inbox },
    '': {
      separator: '/',
      folders: {
        Sent: { 'special-use': '\\Sent', messages: sent },
        Drafts: { 'special-use': '\\Drafts', messages: drafts },
        Archive: { 'special-use': '\\Archive', messages: archive },
        Junk: { 'special-use': '\\Junk', messages: junk },
        Trash: { 'special-use': '\\Trash', messages: trash },
        Projects: { folders: { Aurora: { messages: projects } } },
      },
    },
  };
}

// ------------------------------------------------------------------ servers
export async function startMailServer({ tlsImap = false, gmail = false } = {}) {
  const dir = testDeps();
  const req = createRequire(path.join(dir, 'package.json'));
  const hoodiecrow = req('hoodiecrow-imap');
  const { SMTPServer } = req('smtp-server');
  const storage = await seed({ gmail });
  const imap = hoodiecrow({
    plugins: ['ID', 'IDLE', 'ENABLE', 'NAMESPACE', 'SPECIAL-USE', 'UNSELECT', 'UIDPLUS', 'MOVE', 'LIST-STATUS', 'LITERALPLUS', 'ESEARCH'],
    users: { [USER]: { password: PASS } },
    storage,
    secureConnection: tlsImap,
  });
  await new Promise((r) => imap.listen(0, '127.0.0.1', r));
  const captured = [];
  const smtp = new SMTPServer({
    secure: false,
    disabledCommands: ['STARTTLS'],
    authOptional: false,
    allowInsecureAuth: true,
    logger: false,
    onAuth(auth, session, cb) {
      if (auth.username === USER && auth.password === PASS) return cb(null, { user: auth.username });
      const e = new Error('Invalid username or password');
      e.responseCode = 535;
      return cb(e);
    },
    onData(stream, session, cb) {
      const chunks = [];
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', () => {
        const raw = Buffer.concat(chunks).toString('binary');
        const rcpt = session.envelope.rcptTo.map((r) => r.address);
        captured.push({ from: session.envelope.mailFrom?.address, rcpt, raw });
        if (rcpt.includes(USER)) imap.appendMessage('INBOX', [], false, raw);
        cb();
      });
    },
  });
  await new Promise((r) => smtp.listen(0, '127.0.0.1', r));
  const imapPort = imap.server.address().port;
  const smtpPort = smtp.server.address().port;
  return {
    imap,
    smtp,
    imapPort,
    smtpPort,
    captured,
    box: (name) => imap.getMailbox(name),
    deliver: (raw, flags = []) => imap.appendMessage('INBOX', flags, false, raw),
    async close() {
      await new Promise((r) => smtp.close(r));
      await new Promise((r) => imap.close(r));
    },
  };
}


// ================================================================== end-to-end tests
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const only = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
const results = [];
const consoleErrors = [];
let cur = null; // current shell
const M = '.app-mail';

function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}
async function until(fn, { timeout = 10000, interval = 120, msg = 'condition' } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await sleep(interval);
  }
  throw new Error(`timed out waiting for ${msg}${last instanceof Error ? ` (${last.message})` : ''}`);
}
async function step(name, fn) {
  if (only.length && !only.some((o) => name.startsWith(o))) return;
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name} (${Date.now() - t0} ms)`);
  } catch (e) {
    results.push({ name, ok: false, error: e.message });
    console.log(`  ✗ ${name}\n      ${String(e.stack || e).split('\n').slice(0, 4).join('\n      ')}`);
    if (cur) await cur.shot(`mail-FAIL-${name.replace(/\W+/g, '-')}`).catch(() => {});
  }
}
function docShot(file) {
  try {
    fs.mkdirSync(DOCS_SHOTS, { recursive: true });
    fs.copyFileSync(file, path.join(DOCS_SHOTS, path.basename(file)));
  } catch (e) {
    console.log(`    (could not copy ${file}: ${e.message})`);
  }
}
const serverMsg = (srv, box, re) => srv.box(box).messages.find((m) => re.test(m.raw));
const subjectOf = (m) => /\r?\nSubject: ([^\r\n]*)/.exec(`\n${m.raw}`)?.[1] || '';

const mainLog = [];
async function launch(opts) {
  const s = await launchShell({ ...opts, keepHome: true });
  for (const stream of [s.app.process().stdout, s.app.process().stderr]) {
    stream?.on('data', (d) => {
      for (const line of String(d).split('\n')) if (line.includes('[mail]')) mainLog.push(line);
      if (process.env.MAIL_TEST_VERBOSE) process.stdout.write(`    [main] ${d}`);
    });
  }
  s.page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(`[${opts.lang}/${opts.theme}] ${m.text()}`);
  });
  s.page.on('pageerror', (e) => consoleErrors.push(`[pageerror] ${e.message}`));
  // Record URLs the shell would open in Aurora Browser instead of launching it.
  await s.page.evaluate(() => {
    window.__openedUrls = [];
    window.__aurora.shell.openUrl = (u) => window.__openedUrls.push(u);
  });
  cur = s;
  return s;
}
const mailApp = (p) => p.evaluate(() => !!document.querySelector('.app-mail')?.__mail);
async function rowBySubject(p, text) {
  const loc = p.locator(`${M} .ml-item`, { has: p.locator('.ml-subj', { hasText: text }) }).first();
  await loc.waitFor({ timeout: 10000 });
  return loc;
}
async function openBySubject(p, text) {
  await (await rowBySubject(p, text)).click();
  await p.waitForSelector(`${M} .ml-read-subject:has-text(${JSON.stringify(text)})`, { timeout: 10000 });
  await p.waitForSelector(`${M} .ml-reader:not(.loading) iframe.ml-frame`, { timeout: 10000 });
}
const srcdoc = (p) => p.$eval(`${M} iframe.ml-frame`, (f) => f.srcdoc);
async function inbox(p) {
  await p.click(`${M} .ml-folder.sp-inbox`);
  await p.waitForSelector(`${M} .ml-item:not(.skeleton)`);
}

// Backend helpers, without Electron (electron is stubbed for this require only).
async function unitTests() {
  await step('unit: backend helpers (classify, presets, previews, file names)', async () => {
    const Module = require('node:module');
    const orig = Module._load;
    Module._load = function (req, ...rest) {
      if (req === 'electron') return { app: { on() {} }, safeStorage: { isEncryptionAvailable: () => false }, net: null };
      return orig.call(this, req, ...rest);
    };
    let m;
    try {
      m = require('../main/ipc/mail.js').__test;
    } finally {
      Module._load = orig;
    }
    const c = (e) => m.classify(e);
    assert(c({ authenticationFailed: true }) === 'EAUTH' && c({ code: 'EAUTH', responseCode: 535 }) === 'EAUTH', 'EAUTH');
    assert(c({ code: 'ECONNREFUSED' }) === 'ECONN' && c({ code: 'ENOTFOUND' }) === 'ECONN', 'ECONN');
    assert(c({ code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }) === 'ETLS' && c({ code: 'ERR_SSL_WRONG_VERSION_NUMBER' }) === 'ETLS', 'ETLS');
    assert(c({ code: 'ETIMEDOUT' }) === 'ETIMEOUT' && c({ code: 'CONNECT_TIMEOUT' }) === 'ETIMEOUT' && c({ message: 'Greeting never received' }) === 'ETIMEOUT', 'ETIMEOUT');
    assert(m.presetForEmail('a@gmail.com').provider === 'gmail' && m.presetForEmail('a@hotmail.fr').provider === 'outlook', 'presets');
    assert(m.presetForEmail('a@gmx.de').imap.host === 'imap.gmx.net' && m.presetForEmail('a@laposte.net').smtp.host === 'smtp.laposte.net', 'domain specific servers');
    assert(m.presetForEmail('a@proton.me').imap.port === 1143 && m.presetForEmail('a@proton.me').imap.security === 'starttls', 'proton bridge');
    assert(m.cleanPreview('Sounds good.\n\nOn Tue, Mia wrote:\n> quoted') === 'Sounds good.', 'reply quote removed from preview');
    assert(m.cleanPreview('Merci !\nLe sam. 10/10, Bob a écrit :\n> x') === 'Merci !', 'French quote header removed');
    assert(m.htmlToPreview('<head><style>.a{}</style></head><p>Hi&nbsp;<b>there</b> &amp; you</p><style>.cut{').replace(/\s+/g, ' ').trim() === 'Hi there & you', 'html preview');
    assert(!m.safeFileName('../../etc/passwd').includes('/') && m.safeFileName('') === 'attachment', 'safe file names');
    assert(m.isLoopback('127.0.0.1') && m.isLoopback('localhost') && m.isLoopback('::1') && !m.isLoopback('192.168.1.2'), 'loopback detection');
    let threw = null;
    try {
      m.normalizeCfg({ email: 'a@example.com', provider: 'other', imap: { host: 'mail.example.com', port: 143, security: 'none' }, smtp: { host: 'mail.example.com', port: 25, security: 'none' } });
    } catch (e) {
      threw = e.code;
    }
    assert(threw === 'EINSECURE', 'plain text to a remote host refused without consent');
    const ok = m.normalizeCfg({ email: 'a@example.com', provider: 'other', allowInsecure: true, imap: { host: 'mail.example.com', port: 143, security: 'none' }, smtp: { host: 'mail.example.com', port: 25, security: 'none' } });
    assert(ok.imap.user === 'a@example.com' && ok.smtp.sameAuth === true, 'defaults');
    assert(m.addrList('Ann <ann@x.org>, bob@y.org; not-an-address').map((a) => a.address).join() === 'ann@x.org,bob@y.org', 'address parsing');
  });
}

export async function runTests() {
  await unitTests();
  const srv = await startMailServer();
  const tlsSrv = await startMailServer({ tlsImap: true, gmail: true });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-mail-test-'));
  console.log(`IMAP :${srv.imapPort}  SMTP :${srv.smtpPort}  TLS-IMAP :${tlsSrv.imapPort}  HOME ${home}`);
  let s = await launch({ open: ['mail'], lang: 'en', theme: 'light', home });
  let p = s.page;
  // Remote images of the newsletter are served by the test (the session's https handler), so we can
  // count whether the reading pane requested them.
  const hookRemote = async (sh) => {
    await sh.app.evaluate(({ session }, b64) => {
      globalThis.__mailRemoteHits = 0;
      const body = Buffer.from(b64, 'base64');
      session.defaultSession.protocol.handle('https', (req) => {
        if (/^https:\/\/(images|track)\.contoso\.example\//.test(req.url)) {
          globalThis.__mailRemoteHits++;
          return new Response(body, { headers: { 'content-type': 'image/png' } });
        }
        return new Response('blocked by test', { status: 404 });
      });
    }, png(560, 180, [15, 108, 189], [120, 220, 255]).toString('base64'));
  };
  const hits = () => cur.app.evaluate(() => globalThis.__mailRemoteHits || 0);
  await hookRemote(s);

  // ---------------------------------------------------------------- first run
  await step('welcome: provider tiles + webmail link', async () => {
    await p.waitForSelector(`${M} .ml-provider`);
    const names = await p.$$eval(`${M} .ml-provider-name`, (els) => els.map((e) => e.textContent));
    assert(names.length === 11, `11 providers, got ${names.length}`);
    for (const n of ['Outlook.com', 'Google', 'Yahoo', 'iCloud', 'Orange', 'Free', 'SFR', 'La Poste', 'GMX', 'Proton Mail', 'Other account']) assert(names.includes(n), `tile ${n}`);
    assert(!(await p.$(`${M} .ml-provider img`)), 'no logos, monograms only');
    await sleep(400);
    docShot(await s.shot('mail-welcome'));
    await p.click(`${M} .ml-provider[data-provider="gmail"]`);
    await p.waitForSelector(`${M} .ml-help`);
    assert((await p.textContent(`${M} .ml-help`)).includes('app password'), 'gmail app password note');
    await p.click(`${M} .ml-webmail`);
    await until(() => p.evaluate(() => window.__openedUrls.includes('https://mail.google.com/')), { msg: 'webmail opened in browser' });
    await p.click(`${M} .ml-help a`);
    await until(() => p.evaluate(() => window.__openedUrls.includes('https://myaccount.google.com/apppasswords')), { msg: 'app password page' });
    // Autodetect from the e-mail domain on the "Other" form
    await p.click(`${M} .ml-form-head button`);
    await p.click(`${M} .ml-provider[data-provider="other"]`);
    await p.fill(`${M} input[name=email]`, 'someone@orange.fr');
    await until(async () => (await p.inputValue(`${M} input[name=imap-host]`)) === 'imap.orange.fr', { msg: 'servers autodetected from the domain' });
    assert((await p.inputValue(`${M} input[name=smtp-host]`)) === 'smtp.orange.fr', 'smtp autodetected');
    assert((await p.inputValue(`${M} select[name=imap-security]`)) === 'ssl', 'ssl autodetected');
  });

  const fillOther = async (email, password, imapPort, smtpPort) => {
    await p.fill(`${M} input[name=email]`, email);
    await p.fill(`${M} input[name=name]`, 'Alice Martin');
    await p.fill(`${M} input[name=password]`, password);
    await p.fill(`${M} input[name=imap-host]`, '127.0.0.1');
    await p.selectOption(`${M} select[name=imap-security]`, 'none');
    await p.fill(`${M} input[name=imap-port]`, String(imapPort));
    await p.fill(`${M} input[name=smtp-host]`, '127.0.0.1');
    await p.selectOption(`${M} select[name=smtp-security]`, 'none');
    await p.fill(`${M} input[name=smtp-port]`, String(smtpPort));
  };

  await step('setup: unencrypted host is refused unless accepted', async () => {
    await fillOther(USER, PASS, srv.imapPort, srv.smtpPort);
    await p.fill(`${M} input[name=imap-host]`, 'mail.example.com');
    await p.waitForSelector(`${M} input[name=allow-insecure]`);
    assert(await p.isDisabled(`${M} button[name=signin]`), 'sign in disabled until the risk is accepted');
    await p.fill(`${M} input[name=imap-host]`, '127.0.0.1');
    await until(async () => !(await p.$(`${M} input[name=allow-insecure]`)), { msg: 'localhost needs no confirmation' });
    assert(await p.isEnabled(`${M} button[name=signin]`), 'sign in enabled for localhost');
  });

  await step('setup: wrong password shows EAUTH', async () => {
    await p.fill(`${M} input[name=password]`, 'not-the-password');
    await p.click(`${M} button[name=signin]`);
    await p.waitForSelector(`${M} .ml-error-box[data-code="EAUTH"]`, { timeout: 20000 });
    const txt = await p.textContent(`${M} .ml-error-box`);
    assert(/password is incorrect/i.test(txt), `error text: ${txt}`);
    assert(/IMAP/.test(txt), 'says which server');
    await s.shot('mail-setup-error');
  });

  await step('setup: add account + secure storage of the password', async () => {
    await p.fill(`${M} input[name=password]`, PASS);
    await p.click(`${M} button[name=signin]`);
    await p.waitForSelector(`${M} .ml-setup-done`, { timeout: 20000 });
    await s.shot('mail-setup-done');
    await p.click(`${M} button[name=done]`);
    await p.waitForSelector(`${M} .ml-item:not(.skeleton)`, { timeout: 20000 });
    const file = path.join(home, '.config', 'aurora', 'mail', 'accounts.json');
    const st = fs.statSync(file);
    assert((st.mode & 0o777) === 0o600, `accounts.json mode ${(st.mode & 0o777).toString(8)}`);
    assert((fs.statSync(path.dirname(file)).mode & 0o777) === 0o700, 'mail dir 0700');
    const raw = fs.readFileSync(file, 'utf8');
    assert(!raw.includes(PASS), 'password not stored in clear text');
    const accs = await p.evaluate(() => window.aurora.invoke('mail:accounts'));
    assert(accs.length === 1 && !JSON.stringify(accs).includes(PASS), 'renderer never receives the password');
    assert(typeof accs[0].insecureStorage === 'boolean', 'insecureStorage flag');
  });

  // ---------------------------------------------------------------- folders & list
  await step('folders: special folders, localized names, unread badge, tree', async () => {
    const names = await p.$$eval(`${M} .ml-folder .label`, (els) => els.map((e) => e.textContent));
    for (const n of ['Inbox', 'Drafts', 'Sent Items', 'Archive', 'Junk Email', 'Deleted Items', 'Projects', 'Aurora']) assert(names.includes(n), `folder ${n} in ${names}`);
    const badge = await p.textContent(`${M} .ml-folder.sp-inbox .ml-count`);
    assert(badge === '5', `inbox unread badge 5, got ${badge}`);
    assert((await p.textContent(`${M} .ml-list-title`)) === 'Inbox', 'list title');
  });

  await step('list: envelopes, unread, icons, pagination', async () => {
    const n = await p.$$eval(`${M} .ml-item:not(.skeleton)`, (els) => els.length);
    assert(n === 50, `first page 50 rows, got ${n}`);
    const unread = await p.$$eval(`${M} .ml-item.unread`, (els) => els.length);
    assert(unread === 5, `5 unread rows, got ${unread}`);
    const report = await rowBySubject(p, 'Quarterly report');
    assert(await report.locator('.ml-ic-attach').count(), 'attachment icon');
    const elodie = await rowBySubject(p, "Réunion d'équipe");
    assert(await elodie.locator('.ml-ic-flag').count(), 'flag icon');
    assert((await elodie.locator('.ml-row3').textContent()).includes('Bonjour à tous'), 'preview snippet with accents');
    const groups = await p.$$eval(`${M} .ml-group`, (els) => els.map((e) => e.textContent));
    assert(groups[0] === 'Today', `first group Today (${groups})`);
    await p.$eval(`${M} .ml-list`, (el) => (el.scrollTop = el.scrollHeight));
    await until(async () => (await p.$$eval(`${M} .ml-item:not(.skeleton)`, (els) => els.length)) === 56, { msg: 'infinite scroll loads 56' });
    await p.$eval(`${M} .ml-list`, (el) => (el.scrollTop = 0));
  });

  await step('read: HTML mail sandboxed, remote pictures blocked then shown', async () => {
    await openBySubject(p, 'Your weekly digest');
    const sandbox = await p.$eval(`${M} iframe.ml-frame`, (f) => f.getAttribute('sandbox'));
    assert(sandbox === 'allow-popups allow-popups-to-escape-sandbox', `sandbox=${sandbox}`);
    const doc = await srcdoc(p);
    assert(/Content-Security-Policy" content="default-src 'none'; img-src data:;/.test(doc), 'CSP blocks remote images');
    assert(!doc.includes('images.contoso.example') && !doc.includes('track.contoso.example'), 'remote URLs removed while blocked');
    assert(doc.includes('<base target="_blank">'), 'links open in new window');
    await p.waitForSelector(`${M} .ml-pictures-bar`);
    await sleep(800);
    assert((await hits()) === 0, `no remote request while blocked (${await hits()})`);
    const row = await rowBySubject(p, 'Your weekly digest');
    await until(async () => !(await row.getAttribute('class')).includes('unread'), { msg: 'marked read in list' });
    await until(() => serverMsg(srv, 'INBOX', /weekly digest/).flags.includes('\\Seen'), { msg: 'marked seen on server' });
    await until(async () => (await p.textContent(`${M} .ml-folder.sp-inbox .ml-count`)) === '4', { msg: 'badge 4' });
    await sleep(300);
    docShot(await s.shot('mail-inbox'));
    await p.click(`${M} button[name=show-pictures]`);
    await until(async () => (await hits()) >= 1, { msg: 'remote image requested after "Show pictures"' });
    assert(!(await p.$(`${M} .ml-pictures-bar`)), 'infobar gone');
    assert((await srcdoc(p)).includes("img-src data: https: http:"), 'CSP relaxed for images only');
    const frame = p.frameLocator(`${M} iframe.ml-frame`);
    await until(() => frame.locator('#hero').evaluate((img) => img.complete && img.naturalWidth > 0), { msg: 'hero image loaded' });
    await s.shot('mail-pictures-shown');
  });

  await step('read: hostile HTML is neutralized', async () => {
    await openBySubject(p, 'Security test message');
    const doc = await srcdoc(p);
    for (const bad of ['<script', 'javascript:', '<iframe', '<object', 'evil.example/style.css', 'evil.example/refresh', 'evil.example/bg.png', '<form', 'href="https://evil.example/"']) assert(!doc.includes(bad), `srcdoc must not contain ${bad}`);
    assert(!/\son[a-z]+\s*=/i.test(doc.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '')), 'no inline event handlers');
    assert(doc.includes('safe-heading') && doc.includes('href="https://www.example.com/page"'), 'safe content kept');
    const frame = p.frameLocator(`${M} iframe.ml-frame`);
    await frame.locator('#safe-heading').waitFor();
    assert((await frame.locator('script').count()) === 0, 'no script element in the frame');
    // Clicking a web link goes to Aurora Browser through the shell's main process.
    await frame.locator('#web-link').click();
    await until(() => p.evaluate(() => window.__openedUrls.includes('https://www.example.com/page')), { msg: 'link routed to the browser' });
    assert(!(await p.evaluate(() => location.href)).startsWith('http'), 'shell did not navigate');
  });

  await step('read: mailto: link opens a new message', async () => {
    await openBySubject(p, 'Contact et liens');
    await p.frameLocator(`${M} iframe.ml-frame`).locator('#mailto-link').click();
    await p.waitForSelector(`${M} .ml-compose`, { timeout: 10000 });
    await p.waitForSelector(`${M} .ml-addr[data-field=to] .ml-chip[data-address="lucas.bernard@exemple.fr"]`);
    assert((await p.inputValue(`${M} .ml-subject`)) === 'Bonjour Lucas', 'subject from mailto');
    await p.click(`${M} .ml-compose button[name=discard]`);
    await p.waitForSelector(`${M} .ml-compose`, { state: 'detached' });
  });

  await step('read: inline cid: image', async () => {
    await openBySubject(p, 'Photo from the trip');
    const doc = await srcdoc(p);
    assert(doc.includes('data:image/png;base64,') && !doc.includes('cid:'), 'cid replaced by data URL');
    const ok = await p.frameLocator(`${M} iframe.ml-frame`).locator('#inline-photo').evaluate((img) => img.complete && img.naturalWidth === 192);
    assert(ok, 'inline image rendered');
    assert(!(await p.$(`${M} .ml-read-atts`)), 'inline image is not listed as an attachment');
  });

  await step('attachments: chips, save to Downloads (unique names), open with default app', async () => {
    await openBySubject(p, 'Quarterly report');
    const chips = await p.$$eval(`${M} .ml-read-atts .ml-att`, (els) => els.map((e) => e.dataset.name));
    assert(chips.join('|') === 'Quarterly report.pdf|data.csv|chart.png', `chips ${chips}`);
    await p.click(`${M} .ml-att[data-name="Quarterly report.pdf"] .ml-att-menu`);
    await p.click('.menu .menu-item:has-text("Save to Downloads")');
    const f1 = path.join(home, 'Downloads', 'Quarterly report.pdf');
    await until(() => fs.existsSync(f1), { msg: 'saved file' });
    assert(fs.readFileSync(f1).subarray(0, 5).toString() === '%PDF-', 'PDF content');
    await p.waitForSelector(`${M} .ml-snack`);
    await p.click(`${M} .ml-att[data-name="Quarterly report.pdf"] .ml-att-menu`);
    await p.click('.menu .menu-item:has-text("Save to Downloads")');
    await until(() => fs.existsSync(path.join(home, 'Downloads', 'Quarterly report (1).pdf')), { msg: 'unique name (1)' });
    await p.click(`${M} .ml-att[data-name="data.csv"]`);
    await until(() => p.evaluate(() => window.__aurora.wm.list().some((w) => w.appId === 'notepad')), { msg: 'csv opened in Notepad' });
    await p.evaluate(() => window.__aurora.wm.list().filter((w) => w.appId === 'notepad').forEach((w) => w.close(true)));
    await p.evaluate(() => window.__aurora.wm.list().find((w) => w.appId === 'mail')?.focus());
  });

  await step('flags: quick actions, toolbar and shortcuts sync with the server', async () => {
    const lucas = /Subject: Contact et liens/;
    const row = await rowBySubject(p, 'Contact et liens');
    await row.hover();
    await row.locator('button[name=qa-flag]').click();
    await until(() => serverMsg(srv, 'INBOX', lucas).flags.includes('\\Flagged'), { msg: 'flagged on server' });
    await row.click();
    await p.waitForSelector(`${M} .ml-reader:not(.loading) iframe.ml-frame`);
    await p.click(`${M} .ml-read-bar button[name=unread]`);
    await until(() => !serverMsg(srv, 'INBOX', lucas).flags.includes('\\Seen'), { msg: 'unread on server' });
    await p.focus(`${M} .ml-list`);
    await p.keyboard.press('Control+q');
    await until(() => serverMsg(srv, 'INBOX', lucas).flags.includes('\\Seen'), { msg: 'Ctrl+Q marks read' });
    await p.keyboard.press('Control+u');
    await until(() => !serverMsg(srv, 'INBOX', lucas).flags.includes('\\Seen'), { msg: 'Ctrl+U marks unread' });
    await p.keyboard.press('Insert');
    await until(() => !serverMsg(srv, 'INBOX', lucas).flags.includes('\\Flagged'), { msg: 'Insert toggles the flag' });
  });

  await step('delete / move / archive', async () => {
    const trash0 = srv.box('Trash').messages.length;
    await (await rowBySubject(p, 'Invoice 1047')).click();
    await p.focus(`${M} .ml-list`);
    await p.keyboard.press('Delete');
    await until(() => srv.box('Trash').messages.length === trash0 + 1, { msg: 'moved to Trash' });
    await until(async () => !(await p.$(`${M} .ml-item .ml-subj:text-is("Invoice 1047")`)), { msg: 'removed from list' });
    await p.waitForSelector(`${M} .ml-snack:has-text("Deleted Items")`);
    // Move to a user folder
    const aurora0 = srv.box('Projects/Aurora').messages.length;
    await (await rowBySubject(p, 'Invoice 1039')).click();
    await p.waitForSelector(`${M} .ml-read-bar button[name=move]:not([disabled])`);
    await p.click(`${M} .ml-read-bar button[name=move]`);
    await p.click('.menu .menu-item:has-text("Aurora")');
    await until(() => srv.box('Projects/Aurora').messages.length === aurora0 + 1, { msg: 'moved to Projects/Aurora' });
    // Archive
    const arch0 = srv.box('Archive').messages.length;
    await (await rowBySubject(p, 'Invoice 1031')).click();
    await p.waitForSelector(`${M} .ml-read-bar button[name=archive]:not([disabled])`);
    await p.click(`${M} .ml-read-bar button[name=archive]`);
    await until(() => srv.box('Archive').messages.length === arch0 + 1, { msg: 'archived' });
    // Drag & drop a message onto a folder
    const junk0 = srv.box('Junk').messages.length;
    const src = await rowBySubject(p, 'Invoice 1023');
    await src.dragTo(p.locator(`${M} .ml-folder.sp-junk`));
    await until(() => srv.box('Junk').messages.length === junk0 + 1, { msg: 'dragged to Junk' });
  });

  await step('multi-select + bulk mark as read', async () => {
    const a = await rowBySubject(p, 'Welcome to Aurora Mail');
    const b = await rowBySubject(p, 'Security test message');
    await a.click();
    await b.click({ modifiers: ['Control'] });
    await p.waitForSelector(`${M} .ml-multi [data-count="2"]`);
    await p.click(`${M} .ml-multi button[name=read]`);
    await until(() => serverMsg(srv, 'INBOX', /Subject: Welcome to Aurora Mail/).flags.includes('\\Seen') && serverMsg(srv, 'INBOX', /Subject: Security test message/).flags.includes('\\Seen'), { msg: 'both read on server' });
  });

  await step('search: server-side IMAP search + clear', async () => {
    await p.fill(`${M} .ml-search-input`, 'digest');
    await p.press(`${M} .ml-search-input`, 'Enter');
    await until(async () => (await p.$$eval(`${M} .ml-item:not(.skeleton)`, (els) => els.map((e) => e.querySelector('.ml-subj').textContent))).join() === 'Your weekly digest: 5 stories you might have missed', { msg: 'one search result' });
    assert(await p.$(`${M} .ml-search-banner:not([hidden])`), 'search banner');
    await p.fill(`${M} .ml-search-input`, 'zzzz-nothing');
    await p.press(`${M} .ml-search-input`, 'Enter');
    await p.waitForSelector(`${M} .ml-list-empty:has-text("didn't find")`);
    await p.click(`${M} button[name=clear-search]`);
    await until(async () => (await p.$$eval(`${M} .ml-item:not(.skeleton)`, (els) => els.length)) >= 50, { msg: 'full list back' });
  });

  await step('compose: chips, autocomplete, formatting, drag & drop attachment, send, Sent copy', async () => {
    const attach = path.join(home, 'Documents', 'notes.txt');
    fs.writeFileSync(attach, 'Aurora test attachment\n');
    await p.click(`${M} .ml-list`);
    await p.keyboard.press('Control+n');
    await p.waitForSelector(`${M} .ml-compose`);
    await p.click(`${M} .ml-addr[data-field=to] .ml-chip-input`);
    await p.keyboard.type('ravi');
    await p.waitForSelector(`${M} .ml-suggest-item:has-text("Ravi Patel")`);
    await p.keyboard.press('Enter');
    await p.waitForSelector(`${M} .ml-addr[data-field=to] .ml-chip[data-address="ravi@fabrikam.example"]`);
    await p.keyboard.type('bad-address, mia.chen@adatum.example;');
    await p.waitForSelector(`${M} .ml-chip.invalid[data-address="bad-address"]`);
    await p.click(`${M} .ml-chip.invalid .ml-chip-x`, { force: true });
    await p.click(`${M} button[name=show-cc]`);
    await p.keyboard.type('lucas.bernard@exemple.fr');
    await p.fill(`${M} .ml-subject`, 'Aurora test send');
    await p.click(`${M} .ml-editor`);
    await p.keyboard.press('Control+Home');
    await p.keyboard.type('Hello team, ');
    await p.keyboard.press('Control+b');
    await p.keyboard.type('bold news');
    await p.keyboard.press('Control+b');
    await p.keyboard.type(' inside.');
    assert(await p.$(`${M} .ml-editor b, ${M} .ml-editor strong`), 'bold text in editor');
    assert((await p.textContent(`${M} .ml-editor`)).includes('Sent from Aurora OS'), 'default signature');
    await p.$eval(`${M} .ml-compose`, (el, file) => {
      const dt = new DataTransfer();
      dt.setData('application/x-aurora-paths', JSON.stringify([file]));
      el.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true }));
      el.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    }, attach);
    await p.waitForSelector(`${M} .ml-attach-row .ml-att[data-name="notes.txt"]`);
    await sleep(300);
    await s.shot('mail-compose-new');
    const sent0 = srv.box('Sent').messages.length;
    await p.keyboard.press('Control+Enter');
    await p.waitForSelector(`${M} .ml-snack:has-text("Message sent")`, { timeout: 20000 });
    const cap = await until(() => srv.captured.find((c) => /Subject: Aurora test send/.test(c.raw)), { msg: 'SMTP received' });
    assert(cap.rcpt.includes('ravi@fabrikam.example') && cap.rcpt.includes('mia.chen@adatum.example') && cap.rcpt.includes('lucas.bernard@exemple.fr'), `recipients ${cap.rcpt}`);
    assert(!cap.rcpt.includes('bad-address'), 'invalid chip removed');
    assert(/filename="?notes\.txt/.test(cap.raw) && /<b>bold news<\/b>|<strong>bold news<\/strong>/.test(cap.raw.replace(/=\r\n/g, '')), 'attachment + HTML formatting');
    assert(/Content-Type: text\/plain/.test(cap.raw), 'plain text alternative');
    await until(() => srv.box('Sent').messages.length === sent0 + 1, { msg: 'copy appended to Sent' });
    assert(subjectOf(srv.box('Sent').messages.at(-1)) === 'Aurora test send', 'Sent copy subject');
    await p.click(`${M} .ml-folder.sp-sent`);
    await rowBySubject(p, 'Aurora test send');
    await inbox(p);
  });

  await step('reply: recipients, subject and quoted original', async () => {
    await openBySubject(p, "Réunion d'équipe");
    await p.focus(`${M} .ml-list`);
    await p.keyboard.press('Control+r');
    await p.waitForSelector(`${M} .ml-compose`);
    await p.waitForSelector(`${M} .ml-addr[data-field=to] .ml-chip[data-address="elodie@exemple.fr"]`);
    assert((await p.inputValue(`${M} .ml-subject`)) === "Re: Réunion d'équipe — compte rendu", 'Re: subject');
    const head = await p.textContent(`${M} .ml-editor .ml-quote-head`);
    assert(/^On .+, Élodie Fournier wrote:$/.test(head), `quote header: ${head}`);
    assert((await p.textContent(`${M} .ml-editor blockquote.ml-quote`)).includes('Bonjour à tous'), 'quoted original');
    await p.keyboard.type('Merci Élodie !');
    await p.$$eval(`${M} .ml-snack`, (els) => els.forEach((e) => e.remove()));
    await sleep(300);
    docShot(await s.shot('mail-compose'));
    await p.keyboard.press('Control+Enter');
    await p.waitForSelector(`${M} .ml-snack:has-text("Message sent")`, { timeout: 20000 });
    const cap = await until(() => srv.captured.find((c) => /Subject: Re: R/.test(c.raw) || /R=C3=A9union/.test(c.raw)), { msg: 'reply sent' });
    assert(/In-Reply-To: </i.test(cap.raw) && /References: </i.test(cap.raw), 'threading headers');
    assert(cap.raw.includes('Merci'), 'typed reply text sent');
    await until(() => serverMsg(srv, 'INBOX', /Message-ID: <meeting-notes@exemple\.fr>/i).flags.includes('\\Answered'), { msg: 'original marked answered' });
  });

  await step('reply all + forward prefill', async () => {
    await openBySubject(p, 'Re: Projet Aurora');
    await p.focus(`${M} .ml-list`);
    await p.keyboard.press('Control+Shift+r');
    await p.waitForSelector(`${M} .ml-compose`);
    const to = await p.$$eval(`${M} .ml-addr[data-field=to] .ml-chip`, (els) => els.map((e) => e.dataset.address));
    const cc = await p.$$eval(`${M} .ml-addr[data-field=cc] .ml-chip`, (els) => els.map((e) => e.dataset.address));
    assert(to.join() === 'ravi@fabrikam.example', `reply-all to ${to}`);
    assert(cc.includes('mia.chen@adatum.example') && cc.includes('lucas.bernard@exemple.fr') && !cc.includes(USER), `reply-all cc ${cc}`);
    await p.click(`${M} .ml-compose button[name=discard]`);
    await p.waitForSelector(`${M} .ml-compose`, { state: 'detached' });
    await openBySubject(p, 'Quarterly report');
    await p.focus(`${M} .ml-list`);
    await p.keyboard.press('Control+f');
    await p.waitForSelector(`${M} .ml-compose`);
    assert((await p.inputValue(`${M} .ml-subject`)) === 'Fwd: Quarterly report (PDF + spreadsheet)', 'Fwd: subject');
    await p.waitForSelector(`${M} .ml-compose .ml-attach-row .ml-att[data-name="chart.png"]`);
    assert((await p.$$(`${M} .ml-compose .ml-attach-row .ml-att`)).length === 3, 'original attachments forwarded');
    assert((await p.textContent(`${M} .ml-editor`)).includes('Forwarded message'), 'forward header');
    await p.click(`${M} .ml-compose button[name=discard]`);
    await p.waitForSelector(`${M} .ml-compose`, { state: 'detached' });
  });

  await step('compose: pop-out window + plain text', async () => {
    await p.keyboard.press('Control+n');
    await p.waitForSelector(`${M} .ml-compose`);
    await p.keyboard.type('bob@example.com,');
    await p.fill(`${M} .ml-subject`, 'Popped out');
    await p.click(`${M} .ml-compose button[name=popout]`);
    await p.waitForSelector(`${M} .ml-compose-window .ml-compose`);
    assert(!(await p.$(`${M} .ml-readpane .ml-compose`)), 'inline composer closed');
    const W = `${M}:has(.ml-compose-window)`;
    assert((await p.inputValue(`${W} .ml-subject`)) === 'Popped out', 'subject carried over');
    assert(await p.$(`${W} .ml-chip[data-address="bob@example.com"]`), 'recipient carried over');
    await p.click(`${W} button[name=more]`);
    await p.click('.menu .menu-item:has-text("Switch to plain text")');
    await p.click(`${W} .dialog button:has-text("Switch")`);
    await p.waitForSelector(`${W} textarea[name=body-plain]:visible`);
    await p.click(`${W} textarea[name=body-plain]`);
    await p.keyboard.press('Control+Home');
    await p.keyboard.type('Plain text body.');
    await s.shot('mail-compose-window');
    await p.keyboard.press('Control+Enter');
    await until(async () => !(await p.$(`${M} .ml-compose-window`)), { msg: 'compose window closed after sending' });
    const cap = await until(() => srv.captured.find((c) => /Subject: Popped out/.test(c.raw)), { msg: 'sent from the pop-out' });
    assert(!/text\/html/i.test(cap.raw) && cap.raw.includes('Plain text body.'), 'plain text only');
    await p.evaluate(() => window.__aurora.wm.list().find((w) => w.appId === 'mail')?.focus());
  });

  await step('compose: unsaved prompt when opening another message', async () => {
    await p.click(`${M} .ml-list`);
    await p.keyboard.press('Control+n');
    await p.waitForSelector(`${M} .ml-compose`);
    await p.fill(`${M} .ml-subject`, 'Not finished');
    await (await rowBySubject(p, 'Photo from the trip')).click();
    await p.waitForSelector(`${M} .dialog:has-text("Save this message?")`);
    await p.click(`${M} .dialog button:has-text("Don't save")`);
    await p.waitForSelector(`${M} .ml-read-subject:has-text("Photo from the trip")`);
    assert(!(await p.$(`${M} .ml-compose`)), 'composer closed');
  });

  await step('folders: context menu "Mark all as read"', async () => {
    await p.click(`${M} .ml-folder.sp-inbox`, { button: 'right' });
    await p.click('.menu .menu-item:has-text("Mark all as read")');
    await until(() => srv.box('INBOX').messages.every((m) => m.flags.includes('\\Seen')), { msg: 'all seen on server' });
    await until(async () => !(await p.$(`${M} .ml-folder.sp-inbox .ml-count`)), { msg: 'badge cleared' });
    assert(!(await p.$(`${M} .ml-item.unread`)), 'no unread rows');
  });

  await step('drafts: Ctrl+S saves to Drafts, unsaved prompt on close', async () => {
    const d0 = srv.box('Drafts').messages.length;
    await p.keyboard.press('Control+n');
    await p.waitForSelector(`${M} .ml-compose`);
    await p.fill(`${M} .ml-subject`, 'Draft from test');
    await p.keyboard.press('Control+s');
    await until(() => srv.box('Drafts').messages.some((m) => subjectOf(m) === 'Draft from test'), { msg: 'draft on server' });
    await p.waitForSelector(`${M} .ml-compose-status:has-text("Draft saved")`);
    await p.fill(`${M} .ml-subject`, 'Draft from test v2');
    // Closing the window asks to save
    await p.click(`${M} .win-close`);
    await p.waitForSelector(`${M} .dialog:has-text("Save this message?")`);
    await p.click(`${M} .dialog button:has-text("Cancel")`);
    assert(await p.$(`${M} .ml-compose`), 'still composing after Cancel');
    await p.click(`${M} .win-close`);
    await p.click(`${M} .dialog button:has-text("Save draft")`);
    await until(() => srv.box('Drafts').messages.some((m) => subjectOf(m) === 'Draft from test v2'), { msg: 'updated draft saved' });
    await until(async () => !(await mailApp(p)), { msg: 'window closed' });
    assert(srv.box('Drafts').messages.filter((m) => !m.flags.includes('\\Deleted')).length === d0 + 1, 'old draft replaced');
    await p.evaluate(() => window.__aurora.shell.launch('mail'));
    await p.waitForSelector(`${M} .ml-item:not(.skeleton)`, { timeout: 20000 });
  });

  await step('new mail: IDLE push -> list refresh + notification', async () => {
    await inbox(p);
    srv.deliver(await build({ from: { name: 'Zoé Durand', address: 'zoe@durand.example' }, to: USER, subject: 'Fresh news from Zoé', text: 'Hello Alice!', date: new Date() }));
    await until(() => p.evaluate(() => window.__aurora.notifications.list().some((n) => n.appId === 'mail' && n.title === 'Zoé Durand' && n.body === 'Fresh news from Zoé')), { timeout: 15000, msg: 'notification' });
    await rowBySubject(p, 'Fresh news from Zoé').catch(async (e) => {
      console.log('    list state:', await p.evaluate(() => {
        const a = document.querySelector('.app-mail').__mail;
        return JSON.stringify({ n: a.list.messages.length, loading: a.list.loading, queued: a.list.queuedSoft, seq: a.list.seq, folder: a.folder, first: a.list.messages[0]?.subject, err: a.list.error?.message });
      }));
      throw e;
    });
    const first = await p.textContent(`${M} .ml-item:not(.skeleton) .ml-subj`);
    assert(first === 'Fresh news from Zoé', `new message on top (${first})`);
    await sleep(500);
    await s.shot('mail-new-notification');
  });

  await step('launch args: mailto / {to, subject, body} open a prefilled composer', async () => {
    await p.evaluate(() => window.__aurora.shell.launch('mail', { to: 'Bob <bob@example.com>', subject: 'From another app', body: 'Line 1' }));
    await p.waitForSelector(`${M} .ml-compose .ml-chip[data-address="bob@example.com"]`);
    assert((await p.inputValue(`${M} .ml-subject`)) === 'From another app', 'subject');
    assert((await p.textContent(`${M} .ml-editor`)).includes('Line 1'), 'body');
    await p.click(`${M} .ml-compose button[name=discard]`);
    await p.waitForSelector(`${M} .ml-compose`, { state: 'detached' });
  });

  await step('settings: storage warning, signature, notifications toggle', async () => {
    await p.click(`${M} button[name=settings]`);
    await p.waitForSelector(`${M} .ml-settings`);
    const secure = await p.evaluate(() => window.aurora.invoke('mail:storage'));
    if (!secure.secure) assert(await p.$(`${M} .ml-storage-warning`), 'insecure storage warning shown');
    await s.shot('mail-settings');
    await p.click(`${M} button[name=section-signature]`);
    await p.fill(`${M} textarea[name=signature]`, 'Cheers,\nAlice');
    await p.waitForSelector(`${M} .ml-sig-status:has-text("Saved")`);
    await p.click(`${M} button[name=section-notifications]`);
    await p.waitForSelector(`${M} input[name=notifications]`);
    await p.click(`${M} button[name=close-settings]`);
    await p.keyboard.press('Control+n');
    await p.waitForSelector(`${M} .ml-compose`);
    assert((await p.textContent(`${M} .ml-editor .ml-signature`)).includes('Cheers,Alice') || (await p.innerText(`${M} .ml-editor .ml-signature`)).includes('Cheers,\nAlice'), 'new signature used');
    await p.click(`${M} .ml-compose button[name=discard]`);
    await p.waitForSelector(`${M} .ml-compose`, { state: 'detached' });
  });

  await step('keyboard: arrows move through the list and open messages', async () => {
    await (await rowBySubject(p, 'Fresh news from Zoé')).click();
    await p.focus(`${M} .ml-list`);
    await p.keyboard.press('ArrowDown');
    await p.keyboard.press('ArrowDown');
    const subjects = await p.$$eval(`${M} .ml-item:not(.skeleton) .ml-subj`, (els) => els.map((e) => e.textContent));
    await p.waitForSelector(`${M} .ml-read-subject:has-text(${JSON.stringify(subjects[2])})`, { timeout: 10000 });
    await p.keyboard.press('Home');
    await p.waitForSelector(`${M} .ml-read-subject:has-text(${JSON.stringify(subjects[0])})`, { timeout: 10000 });
  });

  await step('message window: double-click opens it, actions work there', async () => {
    await (await rowBySubject(p, 'Photo from the trip')).dblclick();
    const W = `${M}:has(.ml-msg-window)`;
    await p.waitForSelector(`${W} .ml-read-subject:has-text("Photo from the trip")`, { timeout: 15000 });
    await p.click(`${W} .ml-read-bar button[name=flag]`);
    await until(() => serverMsg(srv, 'INBOX', /Subject: Photo from the trip/).flags.includes('\\Flagged'), { msg: 'flagged from the message window' });
    await until(async () => (await (await rowBySubject(p, 'Photo from the trip')).locator('.ml-ic-flag').count()) === 1, { msg: 'main list updated' });
    await p.click(`${W} .ml-read-bar button[name=reply]`);
    await p.waitForSelector(`${M} .ml-compose-window .ml-chip[data-address="sophie@martin.example"]`);
    await s.shot('mail-message-window');
    await p.click(`${M} .ml-compose-window button[name=discard]`);
    await until(async () => !(await p.$(`${M} .ml-compose-window`)), { msg: 'compose window closed' });
    const trash0 = srv.box('Trash').messages.length;
    await p.click(`${W} .ml-read-bar button[name=delete]`);
    await until(() => srv.box('Trash').messages.length === trash0 + 1, { msg: 'deleted from the message window' });
    await until(async () => !(await p.$(`${M} .ml-msg-window`)), { msg: 'message window closed' });
    await until(async () => !(await p.$(`${M} .ml-item .ml-subj:text-is("Photo from the trip")`)), { msg: 'gone from the main list' });
  });

  await step('eml: .eml files open in a read-only Mail window', async () => {
    const msgs = await p.evaluate(() => window.aurora.invoke('mail:accounts'));
    const accId = msgs[0].id;
    const list = await p.evaluate((id) => window.aurora.invoke('mail:list', id, 'Trash', { search: 'Photo from the trip' }), accId);
    const eml = path.join(home, 'Documents', 'photo.eml');
    await p.evaluate(([id, uid, dest]) => window.aurora.invoke('mail:saveSource', id, 'Trash', uid, dest), [accId, list.messages[0].uid, eml]);
    await p.evaluate((f) => window.__aurora.shell.openFile(f), eml);
    await p.waitForSelector(`${M} .ml-eml-window .ml-read-subject:has-text("Photo from the trip")`, { timeout: 15000 });
    await p.evaluate(() => window.__aurora.wm.list().filter((w) => w.title.startsWith('Photo from the trip')).forEach((w) => w.close(true)));
  });

  await step('add second account (TLS with a self-signed certificate -> trust)', async () => {
    await p.click(`${M} button[name=account]`);
    await p.click('.menu .menu-item:has-text("Add account")');
    await p.waitForSelector(`${M} .ml-setup-dialog .ml-provider`);
    await p.click(`${M} .ml-setup-dialog .ml-provider[data-provider="other"]`);
    await p.fill(`${M} .ml-setup-dialog input[name=email]`, 'alice2@aurora.test');
    await p.fill(`${M} .ml-setup-dialog input[name=password]`, PASS);
    await p.fill(`${M} .ml-setup-dialog input[name=imap-host]`, '127.0.0.1');
    await p.selectOption(`${M} .ml-setup-dialog select[name=imap-security]`, 'ssl');
    await p.fill(`${M} .ml-setup-dialog input[name=imap-port]`, String(tlsSrv.imapPort));
    await p.fill(`${M} .ml-setup-dialog input[name=imap-user]`, USER);
    await p.fill(`${M} .ml-setup-dialog input[name=smtp-host]`, '127.0.0.1');
    await p.selectOption(`${M} .ml-setup-dialog select[name=smtp-security]`, 'none');
    await p.fill(`${M} .ml-setup-dialog input[name=smtp-port]`, String(tlsSrv.smtpPort));
    await p.click(`${M} .ml-setup-dialog button[name=signin]`);
    await p.waitForSelector(`${M} .dialog:has-text("Untrusted certificate")`, { timeout: 20000 });
    assert(/SHA-256/.test(await p.textContent(`${M} .dialog:has-text("Untrusted certificate")`)), 'fingerprint shown');
    await s.shot('mail-cert-trust');
    await p.click(`${M} .dialog button:has-text("Trust this certificate")`);
    await p.waitForSelector(`${M} .ml-setup-dialog .ml-setup-done`, { timeout: 20000 });
    await p.click(`${M} .ml-setup-dialog button[name=done]`);
    await until(async () => (await p.textContent(`${M} .ml-account`)).includes('alice2@aurora.test'), { msg: 'switched to the new account' });
    await p.waitForSelector(`${M} .ml-item:not(.skeleton)`, { timeout: 20000 });
    const accs = await p.evaluate(() => window.aurora.invoke('mail:accounts'));
    assert(accs.length === 2 && accs[1].imap.trusted, 'certificate pinned for the account');
    // Gmail-like folder tree: nested special folders are listed first, the rest under "Folders".
    const top = await p.$$eval(`${M} .ml-folders > .ml-folder .label`, (els) => els.map((e) => e.textContent));
    assert(top.join('|') === 'Inbox|Drafts|Sent Items|Junk Email|Deleted Items', `special folders on top: ${top}`);
    const rest = await p.$$eval(`${M} .ml-folder-group .ml-folder .label`, (els) => els.map((e) => e.textContent));
    assert(rest.includes('[Gmail]') && rest.includes('All Mail') && rest.includes('Starred') && rest.includes('Receipts') && !rest.includes('Trash'), `other folders: ${rest}`);
    await s.shot('mail-second-account');
    // switch back
    await p.click(`${M} button[name=account]`);
    await p.click(`.menu .menu-item:has-text("${USER}")`);
    await until(async () => (await p.textContent(`${M} .ml-account`)).includes(USER), { msg: 'switched back' });
  });

  await step('settings: editing an account with a wrong password is refused', async () => {
    await p.click(`${M} button[name=settings]`);
    await p.waitForSelector(`${M} .ml-settings .ml-acct-row`);
    await p.click(`${M} .ml-acct-row:has-text("${USER}") button[name=edit-account]`);
    await p.waitForSelector(`${M} .ml-settings .ml-setup-form`);
    await p.fill(`${M} .ml-settings input[name=password]`, 'definitely-wrong');
    await p.click(`${M} .ml-settings button[name=signin]`);
    await p.waitForSelector(`${M} .ml-settings .ml-error-box[data-code="EAUTH"]`, { timeout: 20000 });
    await s.shot('mail-settings-edit-error');
    await p.click(`${M} .ml-settings .ml-form-foot button:has-text("Cancel")`);
    await p.waitForSelector(`${M} .ml-settings .ml-acct-row`);
    await p.click(`${M} button[name=close-settings]`);
    await p.click(`${M} button[name=refresh]`);
    await p.waitForSelector(`${M} .ml-item:not(.skeleton)`);
    assert(!(await p.$(`${M} .ml-list-banner .infobar.error`)), 'stored password unchanged');
  });

  await step('offline server + remove account', async () => {
    await p.click(`${M} button[name=account]`);
    await p.click('.menu .menu-item:has-text("alice2@aurora.test")');
    await until(async () => (await p.textContent(`${M} .ml-account`)).includes('alice2@aurora.test'), { msg: 'switched to alice2' });
    await p.waitForSelector(`${M} .ml-item:not(.skeleton)`, { timeout: 20000 });
    await tlsSrv.close();
    tlsSrv.closed = true;
    await p.click(`${M} button[name=refresh]`);
    await until(async () => (await p.$(`${M} .ml-offline:not([hidden]) .infobar`)) || (await p.$(`${M} .ml-list-banner .infobar.error`)), { timeout: 20000, msg: 'offline / error shown' });
    await sleep(300);
    await s.shot('mail-offline');
    await p.click(`${M} button[name=settings]`);
    await p.click(`${M} .ml-acct-row:has-text("alice2@aurora.test") button[name=remove-account]`);
    await p.click(`${M} .dialog:has-text("Remove account") button:has-text("Remove")`);
    await until(async () => (await p.$$(`${M} .ml-acct-row`)).length === 1, { msg: 'one account left' });
    await p.click(`${M} button[name=close-settings]`);
    await until(async () => (await p.textContent(`${M} .ml-account`)).includes(USER), { msg: 'back on the remaining account' });
    await p.waitForSelector(`${M} .ml-item:not(.skeleton)`, { timeout: 20000 });
    const accs = await p.evaluate(() => window.aurora.invoke('mail:accounts'));
    assert(accs.length === 1 && accs[0].email === USER, 'account removed from accounts.json');
  });

  await step('layout: medium width uses a navigation rail', async () => {
    await p.evaluate(() => {
      const w = window.__aurora.wm.list().find((x) => x.appId === 'mail');
      w.restore?.();
      w.setSize(960, 680);
    });
    await until(() => p.$eval(`${M} .ml-root`, (el) => el.dataset.layout === 'medium'), { msg: 'medium layout' });
    await (await rowBySubject(p, 'Quarterly report')).click();
    await p.waitForSelector(`${M} .ml-reader:not(.loading) iframe.ml-frame`);
    await sleep(400);
    const navW = await p.$eval(`${M} .ml-nav`, (el) => el.getBoundingClientRect().width);
    assert(navW < 60, `rail width ${navW}`);
    await s.shot('mail-medium');
    await p.click(`${M} .ml-nav button[name=nav-toggle]`);
    await p.waitForSelector(`${M} .ml-root.nav-open .ml-folder .label:visible`);
    await sleep(300);
    await s.shot('mail-medium-nav-open');
    await p.keyboard.press('Escape');
    await p.waitForSelector(`${M} .ml-root:not(.nav-open)`);
  });

  await step('layout: minimum size (narrow, single pane) and maximized', async () => {
    await p.evaluate(() => {
      const w = window.__aurora.wm.list().find((x) => x.appId === 'mail');
      w.restore?.();
      w.setSize(520, 440);
    });
    await until(() => p.$eval(`${M} .ml-root`, (el) => el.dataset.layout === 'narrow'), { msg: 'narrow layout' });
    if (await p.$(`${M} .ml-root.show-reader`)) {
      // The open message stays on screen; Back returns to the list.
      await p.click(`${M} .ml-back`);
    }
    await p.waitForSelector(`${M} .ml-listpane .ml-item:not(.skeleton)`);
    await until(async () => !(await p.isVisible(`${M} .ml-folder.sp-inbox`)), { msg: 'navigation hidden in narrow windows' });
    await sleep(300);
    await s.shot('mail-min-size-list');
    await (await rowBySubject(p, 'Your weekly digest')).click();
    await p.waitForSelector(`${M} .ml-root.show-reader .ml-back`);
    await sleep(400);
    docShot(await s.shot('mail-min-size'));
    await p.click(`${M} .ml-back`);
    await p.waitForSelector(`${M} .ml-root:not(.show-reader)`);
    await p.click(`${M} .ml-nav-toggle`);
    await p.waitForSelector(`${M} .ml-root.nav-open`);
    await sleep(300);
    await s.shot('mail-min-size-nav');
    await p.click(`${M} .ml-scrim`, { position: { x: 400, y: 200 } });
    await p.evaluate(() => window.__aurora.wm.list().find((x) => x.appId === 'mail').maximize());
    await until(() => p.$eval(`${M} .ml-root`, (el) => el.dataset.layout === 'wide'), { msg: 'wide layout' });
    await sleep(500);
    docShot(await s.shot('mail-maximized'));
  });

  await s.close();

  // ---------------------------------------------------------------- French + dark
  s = await launch({ open: ['mail'], lang: 'fr', theme: 'dark', home });
  p = s.page;
  await hookRemote(s);
  await step('fr/dark: localized folders, dates, reading pane, composer', async () => {
    await p.waitForSelector(`${M} .ml-item:not(.skeleton)`, { timeout: 20000 });
    const names = await p.$$eval(`${M} .ml-folder .label`, (els) => els.map((e) => e.textContent));
    for (const n of ['Boîte de réception', 'Brouillons', 'Éléments envoyés', 'Courrier indésirable', 'Éléments supprimés']) assert(names.includes(n), `folder ${n}`);
    assert((await p.textContent(`${M} button[name=new-mail]`)).includes('Nouveau message'), 'Nouveau message');
    const groups = await p.$$eval(`${M} .ml-group`, (els) => els.map((e) => e.textContent));
    assert(groups[0] === "Aujourd'hui", `groupes ${groups}`);
    await openBySubject(p, "Réunion d'équipe");
    assert((await srcdoc(p)).includes('color-scheme:dark'), 'plain text follows the dark theme');
    await sleep(400);
    docShot(await s.shot('mail-fr-dark'));
    await openBySubject(p, 'Your weekly digest');
    await sleep(400);
    await s.shot('mail-fr-dark-html');
    await p.focus(`${M} .ml-list`);
    await p.keyboard.press('Control+r');
    await p.waitForSelector(`${M} .ml-compose`);
    assert((await p.inputValue(`${M} .ml-subject`)).startsWith('RE : Your weekly digest'), 'RE : prefix');
    assert(/^Le .+, Contoso Weekly a écrit :$/.test(await p.textContent(`${M} .ml-editor .ml-quote-head`)), 'French quote header');
    await sleep(300);
    docShot(await s.shot('mail-compose-fr-dark'));
    await p.click(`${M} .ml-compose button[name=discard]`);
    await p.waitForSelector(`${M} .ml-compose`, { state: 'detached' });
    // Text overflow check (French is longer): nothing clipped in the panes, at default and maximized size.
    const overflowCheck = () => p.evaluate(() => [...document.querySelectorAll('.app-mail .ml-nav, .app-mail .ml-list-head, .app-mail .ml-read-bar, .app-mail .ml-compose-bar, .app-mail .ml-folder')].filter((el) => el.offsetParent && el.scrollWidth > el.clientWidth + 1).map((el) => el.className));
    let overflow = await overflowCheck();
    assert(!overflow.length, `overflow in ${overflow}`);
    await p.evaluate(() => window.__aurora.wm.list().find((x) => x.appId === 'mail').maximize());
    await openBySubject(p, 'Quarterly report');
    await sleep(500);
    overflow = await overflowCheck();
    assert(!overflow.length, `overflow (maximized) in ${overflow}`);
    await s.shot('mail-fr-dark-maximized');
    await p.focus(`${M} .ml-list`);
    await p.keyboard.press('Control+n');
    await p.waitForSelector(`${M} .ml-compose`);
    overflow = await overflowCheck();
    assert(!overflow.length, `overflow (composer) in ${overflow}`);
    await p.click(`${M} .ml-compose button[name=discard]`);
  });

  await step('fr/dark: welcome (separate profile)', async () => {
    const h2 = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-mail-test-fr-'));
    const s2 = await launch({ open: ['mail'], lang: 'fr', theme: 'dark', home: h2 });
    await s2.page.waitForSelector(`${M} .ml-provider`);
    await sleep(500);
    docShot(await s2.shot('mail-welcome-fr-dark'));
    await s2.page.click(`${M} .ml-provider[data-provider="proton"]`);
    await s2.page.waitForSelector(`${M} .ml-help`);
    assert((await s2.page.textContent(`${M} .ml-help`)).includes('Bridge'), 'Proton Bridge note');
    await s2.shot('mail-setup-fr-dark');
    await s2.close();
    fs.rmSync(h2, { recursive: true, force: true });
    cur = s;
  });

  await s.close();
  await srv.close();
  if (!tlsSrv.closed) await tlsSrv.close();
  fs.rmSync(home, { recursive: true, force: true });

  const relevant = consoleErrors.filter((e) => !/Autofill|DevTools|net::ERR_|favicon/i.test(e));
  if (relevant.length) {
    console.log('\nConsole errors:');
    for (const e of relevant) console.log(`  ${e}`);
  }
  results.push({ name: 'no console errors', ok: relevant.length === 0 });
  const failed = results.filter((r) => !r.ok);
  if (failed.length) console.log(`\nMain process [mail] log (last 40 lines):\n${mainLog.slice(-40).join('\n')}`);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain && process.argv.includes('--server')) {
  const s = await startMailServer();
  console.log(`IMAP 127.0.0.1:${s.imapPort}  SMTP 127.0.0.1:${s.smtpPort}  user ${USER} / ${PASS}`);
} else if (isMain) {
  await runTests();
}
