'use strict';
// Aurora Mail backend: accounts, IMAP (imapflow), SMTP (nodemailer) and MIME parsing (mailparser).
//
// Channels (renderer: api.invoke('mail:…')):
//   mail:presets                           -> [{ id, name, sub, color, fg, mono, domains, imap, smtp, appPasswordUrl, webmail, manual }]
//   mail:autodetect(email)                 -> { provider, imap, smtp, source: 'preset' | 'ispdb' | 'guess' }
//   mail:storage                           -> { secure, backend }  (how passwords are protected on this machine)
//   mail:accounts                          -> [account]  (never contains a password)
//   mail:testAccount(cfg)                  -> { ok: true } | { ok: false, error: { code, side, host, message, cert? } }
//   mail:addAccount(cfg)                   -> account (tested first unless cfg.skipTest)
//   mail:updateAccount(id, patch)          -> account (server changes are tested first)
//   mail:removeAccount(id)                 -> true
//   mail:folders(accountId)                -> { tree: [folder], special: { inbox, sent, drafts, trash, junk, archive, all } }
//   mail:list(accountId, folder, { page, pageSize = 50, search, filter: 'unread' | 'flagged' })
//                                          -> { messages, total, page, pageSize, hasMore }
//   mail:message(accountId, folder, uid, { markSeen = true }) -> parsed message (see parseMessage)
//   mail:attachment(accountId, folder, uid, attachmentId, { dest })  -> saved path (~/Downloads, unique name)
//   mail:setFlags(accountId, folder, uids, { seen, flagged, answered })
//   mail:move(accountId, folder, uids, toFolder)      mail:archive(accountId, folder, uids)
//   mail:delete(accountId, folder, uids)   -> { permanent }  (moves to Trash, expunges when already there)
//   mail:send(accountId, msg)              -> { messageId, accepted, rejected }
//   mail:saveDraft(accountId, msg, { replaceUid }) -> { folder, uid }
//   mail:source(accountId, folder, uid)    -> raw RFC 822 text
//   mail:parseFile(path)                   -> parsed message of an .eml file (attachments: accountId '@file', folder = path)
//   mail:watch(on)                         -> keep IDLE watchers (new-mail notifications) running for every account
// Events (api.on): mail:new { accountId, folder, count, from, subject, uid }
//                  mail:changed { accountId, folder }      mail:status { accountId, online, code }
//
// Error codes (err.code): EAUTH, ECONN, ETLS, ETIMEOUT, EINSECURE, EEXISTS, ENOACCOUNT, ENOMSG, EINVAL, EFAIL.
// Test / connection errors carry the side in the message ("imap: …" / "smtp: …").
//
// Storage: ~/.config/aurora/mail/accounts.json (dir 0700, file 0600). Passwords are encrypted with
// Electron safeStorage when a real OS keyring backs it; otherwise they are obfuscated (AES with a
// machine-derived key) and the account is flagged `insecureStorage`. Secrets never leave this file.
const { app, safeStorage, net: electronNet } = require('electron');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const tls = require('tls');
const netMod = require('net');

const HOME = os.homedir();
const DIR = path.join(HOME, '.config', 'aurora', 'mail');
const FILE = path.join(DIR, 'accounts.json');
const SECURITY = new Set(['ssl', 'starttls', 'none']);
const OP_TIMEOUT = 90000;
const CONNECT_TIMEOUT = 20000;
const PAGE_SIZE = 50;
const MAX_SOURCE = 60 * 1024 * 1024;

// Libraries are loaded on first use so they never slow the shell's startup.
let _imapflow = null;
let _nodemailer = null;
let _composer = null;
let _parser = null;
const ImapFlow = () => (_imapflow ||= require('imapflow').ImapFlow);
const nodemailer = () => (_nodemailer ||= require('nodemailer'));
const MailComposer = () => {
  if (!_composer) {
    const m = require('nodemailer/lib/mail-composer');
    _composer = m.default || m;
  }
  return _composer;
};
const simpleParser = () => (_parser ||= require('mailparser').simpleParser);

function log(...a) {
  console.log('[mail]', ...a);
}

// ------------------------------------------------------------------ provider presets
const PRESETS = [
  {
    id: 'outlook',
    name: 'Outlook.com',
    sub: 'Outlook.com, Hotmail, Live, MSN',
    color: '#0f6cbd',
    mono: 'O',
    domains: ['outlook.com', 'outlook.fr', 'hotmail.com', 'hotmail.fr', 'hotmail.co.uk', 'live.com', 'live.fr', 'msn.com', 'passport.com'],
    imap: { host: 'outlook.office365.com', port: 993, security: 'ssl' },
    smtp: { host: 'smtp-mail.outlook.com', port: 587, security: 'starttls' },
    appPasswordUrl: 'https://account.live.com/proofs/AppPassword',
    webmail: 'https://outlook.live.com/mail/',
    sent: 'check',
  },
  {
    id: 'gmail',
    name: 'Google',
    sub: 'Gmail',
    color: '#d93025',
    mono: 'G',
    domains: ['gmail.com', 'googlemail.com'],
    imap: { host: 'imap.gmail.com', port: 993, security: 'ssl' },
    smtp: { host: 'smtp.gmail.com', port: 465, security: 'ssl' },
    appPasswordUrl: 'https://myaccount.google.com/apppasswords',
    webmail: 'https://mail.google.com/',
    sent: 'auto',
  },
  {
    id: 'yahoo',
    name: 'Yahoo',
    sub: 'Yahoo Mail',
    color: '#6001d2',
    mono: 'Y',
    domains: ['yahoo.com', 'yahoo.fr', 'yahoo.co.uk', 'ymail.com', 'rocketmail.com'],
    imap: { host: 'imap.mail.yahoo.com', port: 993, security: 'ssl' },
    smtp: { host: 'smtp.mail.yahoo.com', port: 465, security: 'ssl' },
    appPasswordUrl: 'https://login.yahoo.com/myaccount/security/app-password',
    webmail: 'https://mail.yahoo.com/',
    sent: 'append',
  },
  {
    id: 'icloud',
    name: 'iCloud',
    sub: 'iCloud Mail',
    color: '#1f6fd1',
    mono: 'iC',
    domains: ['icloud.com', 'me.com', 'mac.com'],
    imap: { host: 'imap.mail.me.com', port: 993, security: 'ssl' },
    smtp: { host: 'smtp.mail.me.com', port: 587, security: 'starttls' },
    appPasswordUrl: 'https://account.apple.com/account/manage',
    webmail: 'https://www.icloud.com/mail',
    sent: 'check',
  },
  {
    id: 'orange',
    name: 'Orange',
    sub: 'orange.fr, wanadoo.fr',
    color: '#ff7900',
    fg: '#000000',
    mono: 'Or',
    domains: ['orange.fr', 'wanadoo.fr'],
    imap: { host: 'imap.orange.fr', port: 993, security: 'ssl' },
    smtp: { host: 'smtp.orange.fr', port: 465, security: 'ssl' },
    webmail: 'https://messagerie.orange.fr/',
    sent: 'append',
  },
  {
    id: 'free',
    name: 'Free',
    sub: 'free.fr',
    color: '#cd1e25',
    mono: 'F',
    domains: ['free.fr'],
    imap: { host: 'imap.free.fr', port: 993, security: 'ssl' },
    smtp: { host: 'smtp.free.fr', port: 465, security: 'ssl' },
    webmail: 'https://webmail.free.fr/',
    sent: 'append',
  },
  {
    id: 'sfr',
    name: 'SFR',
    sub: 'sfr.fr, neuf.fr',
    color: '#e2001a',
    mono: 'S',
    domains: ['sfr.fr', 'neuf.fr', 'cegetel.net', 'club-internet.fr', '9online.fr'],
    imap: { host: 'imap.sfr.fr', port: 993, security: 'ssl' },
    smtp: { host: 'smtp.sfr.fr', port: 465, security: 'ssl' },
    webmail: 'https://webmail.sfr.fr/',
    sent: 'append',
  },
  {
    id: 'laposte',
    name: 'La Poste',
    sub: 'laposte.net',
    color: '#ffc72c',
    fg: '#1d1d1b',
    mono: 'LP',
    domains: ['laposte.net'],
    imap: { host: 'imap.laposte.net', port: 993, security: 'ssl' },
    smtp: { host: 'smtp.laposte.net', port: 465, security: 'ssl' },
    webmail: 'https://www.laposte.net/accueil',
    sent: 'append',
  },
  {
    id: 'gmx',
    name: 'GMX',
    sub: 'gmx.com, gmx.fr, gmx.net',
    color: '#1c449b',
    mono: 'GMX',
    domains: ['gmx.com', 'gmx.fr', 'gmx.us', 'gmx.co.uk', 'gmx.net', 'gmx.de', 'gmx.at', 'gmx.ch'],
    imap: { host: 'imap.gmx.com', port: 993, security: 'ssl' },
    smtp: { host: 'mail.gmx.com', port: 587, security: 'starttls' },
    // German GMX domains live on the gmx.net servers.
    domainServers: {
      'gmx.net': { imap: 'imap.gmx.net', smtp: 'mail.gmx.net' },
      'gmx.de': { imap: 'imap.gmx.net', smtp: 'mail.gmx.net' },
      'gmx.at': { imap: 'imap.gmx.net', smtp: 'mail.gmx.net' },
      'gmx.ch': { imap: 'imap.gmx.net', smtp: 'mail.gmx.net' },
    },
    webmail: 'https://www.gmx.com/',
    sent: 'append',
  },
  {
    id: 'proton',
    name: 'Proton Mail',
    sub: 'Proton Mail Bridge',
    color: '#6d4aff',
    mono: 'P',
    domains: ['proton.me', 'protonmail.com', 'protonmail.ch', 'pm.me'],
    imap: { host: '127.0.0.1', port: 1143, security: 'starttls' },
    smtp: { host: '127.0.0.1', port: 1025, security: 'starttls' },
    webmail: 'https://mail.proton.me/',
    bridge: true,
    sent: 'check',
  },
  { id: 'other', name: 'Other account', sub: 'IMAP / SMTP', color: '#5c5c5c', mono: '@', domains: [], manual: true, sent: 'append' },
];
const presetById = (id) => PRESETS.find((p) => p.id === id) || null;

function presetForEmail(email) {
  const domain = String(email || '').split('@')[1]?.toLowerCase().trim();
  if (!domain) return null;
  const p = PRESETS.find((x) => x.domains.includes(domain));
  if (!p) return null;
  const imap = { ...p.imap };
  const smtp = { ...p.smtp };
  const over = p.domainServers?.[domain];
  if (over) {
    imap.host = over.imap;
    smtp.host = over.smtp;
  }
  return { provider: p.id, imap, smtp };
}

// ------------------------------------------------------------------ helpers
function err(message, code, extra) {
  const e = new Error(message);
  e.code = code;
  if (extra) Object.assign(e, extra);
  return e;
}

function isLoopback(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h) || h.endsWith('.localhost');
}

function withTimeout(promise, ms, onTimeout) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        try {
          onTimeout?.();
        } catch {}
        reject(err('The server did not respond in time.', 'ETIMEOUT'));
      }, ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

const TLS_CODES = new Set([
  'ETLS',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'ERR_SSL_WRONG_VERSION_NUMBER',
  'ERR_SSL_PACKET_LENGTH_TOO_LONG',
  'ERR_SSL_UNSUPPORTED_PROTOCOL',
  'ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION',
  'EPROTO',
  'ClosedAfterConnectTLS',
  'UPGRADE_TIMEOUT',
  'STARTTLS_INJECTION',
]);
const CERT_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);
const CONN_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ECONNRESET',
  'EAI_AGAIN',
  'EPIPE',
  'ECONNECTION',
  'ESOCKET',
  'EDNS',
  'NoConnection',
  'EConnectionClosed',
  'ClosedAfterConnectText',
  'StateLogout',
]);

// Map any imapflow / nodemailer / socket error to one of our codes.
function classify(e) {
  if (!e) return 'EFAIL';
  const code = String(e.code || '');
  const msg = String(e.message || e);
  const all = `${code} ${msg} ${e.response || ''}`;
  if (['EAUTH', 'ECONN', 'ETLS', 'ETIMEOUT', 'EINSECURE', 'EEXISTS', 'ENOACCOUNT', 'ENOMSG', 'EINVAL', 'EACCES', 'ENOSPC', 'ENOENT', 'ESERVER'].includes(code)) return code;
  // Local file system errors (saving attachments, reading files to send).
  if (e.syscall && ['EPERM', 'EROFS', 'EISDIR', 'ENOTDIR'].includes(code)) return 'EACCES';
  if (e.syscall && code === 'EDQUOT') return 'ENOSPC';
  if (e.authenticationFailed || code === 'EAUTH' || e.responseCode === 535 || e.responseCode === 534 || /AUTHENTICATIONFAILED|authentication failed|invalid credentials|LOGIN failed|Username and Password not accepted|\bAUTHENTICATE failed/i.test(all)) return 'EAUTH';
  if (CERT_CODES.has(code) || TLS_CODES.has(code) || /certificate|\bSSL\b|\bTLS\b|wrong version number|handshake|STARTTLS/i.test(all)) return 'ETLS';
  if (/TIMEOUT|ETIMEDOUT|timed? ?out|Greeting never received/i.test(all)) return 'ETIMEOUT';
  if (CONN_CODES.has(code) || /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|ECONNRESET|getaddrinfo|Connection closed|socket hang up|Unexpected close/i.test(all)) return 'ECONN';
  return 'EFAIL';
}

function isConnectionError(e) {
  const c = classify(e);
  return c === 'ECONN' || c === 'ETIMEOUT' || ['NoConnection', 'EConnectionClosed', 'StateLogout'].includes(e?.code);
}

// Short, secret-free description of an error.
function describe(e) {
  let m = String(e?.responseText || e?.response || e?.message || e || 'error');
  m = m.replace(/\s+/g, ' ').trim();
  return m.length > 300 ? `${m.slice(0, 300)}…` : m;
}

function mapError(e, side) {
  if (e && e.__mapped) return e;
  const code = classify(e);
  // File system errors carry the path only: the renderer words them in the user's language.
  const fsError = e?.syscall && ['EACCES', 'ENOSPC', 'ENOENT'].includes(code);
  const out = err(fsError ? String(e.path || e.dest || describe(e)) : `${side ? `${side}: ` : ''}${describe(e)}`, code);
  out.__mapped = true;
  return out;
}

function addrList(v) {
  // Normalise renderer input ('a@b, c@d' | [{name, address}] | ['a@b']) to nodemailer address objects.
  if (!v) return [];
  const arr = Array.isArray(v) ? v : String(v).split(/[,;]/);
  const out = [];
  for (const x of arr) {
    if (!x) continue;
    if (typeof x === 'string') {
      const s = x.trim();
      if (!s) continue;
      const m = /^(.*)<([^>]+)>\s*$/.exec(s);
      if (m) out.push({ name: m[1].trim().replace(/^"|"$/g, ''), address: m[2].trim() });
      else out.push({ name: '', address: s });
    } else if (x.address) out.push({ name: String(x.name || ''), address: String(x.address).trim() });
  }
  return out.filter((a) => /^[^\s@<>()]+@[^\s@<>()]+$/.test(a.address));
}

function envAddrs(list) {
  return (list || []).map((a) => ({ name: a.name || '', address: a.address || (a.mailbox && a.host ? `${a.mailbox}@${a.host}` : '') })).filter((a) => a.address || a.name);
}

function uidList(uids) {
  const arr = (Array.isArray(uids) ? uids : [uids]).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (!arr.length) throw err('No message selected.', 'EINVAL');
  return arr;
}

function safeFileName(name, fallback = 'attachment') {
  let n = String(name || '')
    .replace(/[\u0000-\u001f\u007f/\\]/g, '_')
    .replace(/^\.+/, '')
    .trim();
  if (!n) n = fallback;
  if (n.length > 180) {
    const ext = path.extname(n).slice(0, 16);
    n = n.slice(0, 180 - ext.length) + ext;
  }
  return n;
}

function downloadsDir() {
  try {
    const txt = fs.readFileSync(path.join(HOME, '.config', 'user-dirs.dirs'), 'utf8');
    const m = /^XDG_DOWNLOAD_DIR="?([^"\n]+)"?/m.exec(txt);
    if (m) {
      const p = m[1].replace(/^\$HOME/, HOME);
      if (path.isAbsolute(p)) return p;
    }
  } catch {}
  return path.join(HOME, 'Downloads');
}

// Write `data` as dir/name, or "name (1).ext", "name (2).ext"… when taken. The file is created
// exclusively (O_EXCL), so two saves at the same time never overwrite each other. With `reuse`,
// an existing copy with exactly the same content is returned instead of writing another one
// (opening the same attachment twice must not fill Downloads with copies).
async function writeUnique(dir, name, data, { reuse = false } = {}) {
  const ext = path.extname(name);
  const base = ext ? name.slice(0, -ext.length) : name;
  for (let i = 0; i < 10000; i++) {
    const candidate = path.join(dir, i ? `${base} (${i})${ext}` : name);
    if (reuse) {
      try {
        const st = await fsp.stat(candidate);
        if (st.isFile() && st.size === data.length && (await fsp.readFile(candidate)).equals(data)) return candidate;
      } catch {}
    }
    try {
      await fsp.writeFile(candidate, data, { flag: 'wx' });
      return candidate;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
  const last = path.join(dir, `${base} (${Date.now()})${ext}`);
  await fsp.writeFile(last, data, { flag: 'wx' });
  return last;
}

// ------------------------------------------------------------------ secrets
let storageMode = null; // { secure, backend }
function secretMode() {
  if (storageMode) return storageMode;
  let backend = 'unavailable';
  let secure = false;
  try {
    if (safeStorage?.isEncryptionAvailable()) {
      backend = typeof safeStorage.getSelectedStorageBackend === 'function' ? safeStorage.getSelectedStorageBackend() : 'unknown';
      // 'basic_text' is Chromium's hard-coded key: no better than our own obfuscation.
      secure = process.platform !== 'linux' || !['basic_text', 'unknown'].includes(backend);
    }
  } catch {}
  storageMode = { secure, backend };
  return storageMode;
}

let obfKey = null;
function obfuscationKey() {
  if (obfKey) return obfKey;
  let machine = '';
  for (const f of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
    try {
      machine = fs.readFileSync(f, 'utf8').trim();
      if (machine) break;
    } catch {}
  }
  obfKey = crypto.createHash('sha256').update(`aurora-mail\0${machine}\0${os.userInfo().username}\0${HOME}`).digest();
  return obfKey;
}

function sealSecret(plain) {
  if (plain == null || plain === '') return null;
  const mode = secretMode();
  if (mode.secure) return { m: 'safe', v: safeStorage.encryptString(String(plain)).toString('base64') };
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', obfuscationKey(), iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return { m: 'obf', v: Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64') };
}

function openSecret(sealed) {
  if (!sealed?.v) return '';
  try {
    const buf = Buffer.from(sealed.v, 'base64');
    if (sealed.m === 'safe') return safeStorage.decryptString(buf);
    const d = crypto.createDecipheriv('aes-256-gcm', obfuscationKey(), buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
  } catch (e) {
    log('cannot decrypt a stored password:', e.message);
    return '';
  }
}

// ------------------------------------------------------------------ accounts file
let accountsCache = null;

async function ensureDir() {
  await fsp.mkdir(DIR, { recursive: true, mode: 0o700 });
  try {
    await fsp.chmod(DIR, 0o700);
  } catch {}
}

async function loadAccounts() {
  if (accountsCache) return accountsCache;
  try {
    const data = JSON.parse(await fsp.readFile(FILE, 'utf8'));
    accountsCache = Array.isArray(data?.accounts) ? data.accounts : [];
  } catch (e) {
    if (e.code !== 'ENOENT') {
      // Keep the damaged file aside instead of overwriting it with the next save.
      log('accounts.json unreadable:', e.message);
      try {
        await fsp.rename(FILE, `${FILE}.damaged-${Date.now()}`);
      } catch {}
    }
    accountsCache = [];
  }
  return accountsCache;
}

let saveChain = Promise.resolve();
function saveAccounts() {
  const run = async () => {
    await ensureDir();
    const tmp = `${FILE}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify({ version: 1, accounts: accountsCache || [] }, null, 2), { mode: 0o600 });
    await fsp.chmod(tmp, 0o600);
    await fsp.rename(tmp, FILE);
  };
  saveChain = saveChain.then(run, run);
  return saveChain;
}

async function getAccount(id) {
  const list = await loadAccounts();
  const a = list.find((x) => x.id === id);
  if (!a) throw err('This account no longer exists.', 'ENOACCOUNT');
  return a;
}

function publicAccount(a) {
  return {
    id: a.id,
    email: a.email,
    name: a.name || '',
    provider: a.provider || 'other',
    imap: { host: a.imap.host, port: a.imap.port, security: a.imap.security, user: a.imap.user, trusted: !!a.imap.trustedCert },
    smtp: { host: a.smtp.host, port: a.smtp.port, security: a.smtp.security, user: a.smtp.user, sameAuth: a.smtp.sameAuth !== false, trusted: !!a.smtp.trustedCert },
    insecureStorage: a.secret?.imap?.m !== 'safe',
    insecureTransport: a.imap.security === 'none' || a.smtp.security === 'none',
    signature: a.signature ?? null,
    signatureEnabled: a.signatureEnabled !== false,
    sentMode: a.sentMode || 'append',
    created: a.created,
  };
}

function secretsOf(a) {
  const imap = openSecret(a.secret?.imap);
  const smtp = a.smtp.sameAuth !== false ? imap : openSecret(a.secret?.smtp) || imap;
  return { imap, smtp };
}

// Validate and normalise an account configuration coming from the renderer.
function normalizeCfg(cfg, existing) {
  const c = cfg || {};
  const email = String(c.email ?? existing?.email ?? '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && !/^[^\s@]+@[^\s@]+$/.test(email)) throw err('Invalid e-mail address.', 'EINVAL');
  const preset = presetForEmail(email);
  const provider = String(c.provider || existing?.provider || preset?.provider || 'other');
  const p = presetById(provider);
  const server = (s, def, side) => {
    const src = { ...(def || {}), ...(s || {}) };
    const host = String(src.host || '').trim();
    if (!host || /[\s/]/.test(host)) throw err(`${side}: invalid server name`, 'EINVAL');
    const port = Number(src.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw err(`${side}: invalid port`, 'EINVAL');
    const security = SECURITY.has(src.security) ? src.security : 'ssl';
    let user = String(src.user ?? '').trim();
    if (!user || user === 'local') user = src.user === 'local' ? email.split('@')[0] : email;
    return { host, port, security, user };
  };
  const imapDef = existing?.imap || (p && !p.manual ? (preset?.provider === provider ? preset.imap : p.imap) : null);
  const smtpDef = existing?.smtp || (p && !p.manual ? (preset?.provider === provider ? preset.smtp : p.smtp) : null);
  const imap = server(c.imap, imapDef, 'imap');
  const smtp = server(c.smtp, smtpDef, 'smtp');
  smtp.sameAuth = c.smtp?.sameAuth ?? existing?.smtp?.sameAuth ?? true;
  if (smtp.sameAuth) smtp.user = c.smtp?.user ? smtp.user : imap.user;
  for (const [side, s] of [
    ['imap', imap],
    ['smtp', smtp],
  ]) {
    if (s.security === 'none' && !isLoopback(s.host) && !c.allowInsecure && !existing?.allowInsecure) {
      throw err(`${side}: unencrypted connections are only allowed to this computer`, 'EINSECURE');
    }
  }
  // Certificates the user explicitly trusted (self-signed servers such as Proton Mail Bridge).
  const trust = c.trust || {};
  imap.trustedCert = trust.imap !== undefined ? trust.imap || null : existing?.imap?.trustedCert && existing.imap.host === imap.host ? existing.imap.trustedCert : null;
  smtp.trustedCert = trust.smtp !== undefined ? trust.smtp || null : existing?.smtp?.trustedCert && existing.smtp.host === smtp.host ? existing.smtp.trustedCert : null;
  return {
    email,
    name: String(c.name ?? existing?.name ?? '').trim() || email.split('@')[0],
    provider,
    imap,
    smtp,
    allowInsecure: !!(c.allowInsecure || existing?.allowInsecure),
    password: c.password != null && c.password !== '' ? String(c.password) : null,
    smtpPassword: c.smtp?.password != null && c.smtp.password !== '' ? String(c.smtp.password) : null,
  };
}

function sentModeFor(n) {
  const host = n.imap.host.toLowerCase();
  if (n.provider === 'gmail' || /(^|\.)(gmail|googlemail)\.com$/.test(host)) return 'auto';
  if (/office365\.com$|outlook\.com$|\.me\.com$/.test(host)) return 'check';
  return presetById(n.provider)?.sent || 'append';
}

// ------------------------------------------------------------------ TLS helpers
function pemOf(cert) {
  if (!cert?.raw) return null;
  const b64 = cert.raw.toString('base64').replace(/(.{64})/g, '$1\n');
  return `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`;
}

function fingerprintOf(pem) {
  try {
    return new crypto.X509Certificate(pem).fingerprint256;
  } catch {
    return null;
  }
}

function tlsOptions(server) {
  const o = { minVersion: 'TLSv1.2' };
  if (!netMod.isIP(server.host)) o.servername = server.host;
  if (server.trustedCert) {
    // Certificate pinning: the user trusted exactly this certificate (TOFU, like a security exception).
    const fp = fingerprintOf(server.trustedCert);
    o.ca = [server.trustedCert];
    o.checkServerIdentity = (host, cert) => (fp && cert?.fingerprint256 === fp ? undefined : tls.checkServerIdentity(host, cert));
  }
  return o;
}

// Read the server certificate (without trusting it) so the user can decide to trust it.
function probeCertificate(server, protocol) {
  return new Promise((resolve) => {
    let done = false;
    let sock = null;
    let secure = null;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        secure?.destroy();
        sock?.destroy();
      } catch {}
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), 10000);
    const upgrade = (socket) => {
      // Only reads the certificate for display: no credentials or data are ever sent on this socket.
      secure = tls.connect({ socket, host: server.host, port: server.port, servername: netMod.isIP(server.host) ? undefined : server.host, rejectUnauthorized: false }, () => {
        const c = secure.getPeerCertificate(true);
        const pem = pemOf(c);
        if (!pem) return finish(null);
        finish({
          pem,
          fingerprint: c.fingerprint256,
          subject: c.subject?.CN || '',
          issuer: c.issuer?.O || c.issuer?.CN || '',
          validFrom: c.valid_from,
          validTo: c.valid_to,
          selfSigned: c.issuerCertificate === c || (c.subject?.CN === c.issuer?.CN && c.subject?.O === c.issuer?.O),
          authorizationError: secure.authorizationError || null,
        });
      });
      secure.on('error', () => finish(null));
    };
    if (server.security === 'ssl') {
      sock = netMod.connect({ host: server.host, port: server.port }, () => upgrade(sock));
      sock.on('error', () => finish(null));
      return;
    }
    if (server.security !== 'starttls') return finish(null);
    sock = netMod.connect({ host: server.host, port: server.port });
    sock.setEncoding('latin1');
    let buf = '';
    let step = 0;
    sock.on('error', () => finish(null));
    sock.on('data', (chunk) => {
      buf += chunk;
      const lines = buf.split('\r\n');
      buf = lines.pop();
      for (const line of lines) {
        if (protocol === 'imap') {
          if (step === 0 && /^\* (OK|PREAUTH)/i.test(line)) {
            step = 1;
            sock.write('A1 STARTTLS\r\n');
          } else if (step === 1 && /^A1 OK/i.test(line)) {
            step = 2;
            sock.removeAllListeners('data');
            upgrade(sock);
          } else if (step === 1 && /^A1 (NO|BAD)/i.test(line)) finish(null);
        } else {
          if (step === 0 && /^220 /.test(line)) {
            step = 1;
            sock.write('EHLO aurora.localdomain\r\n');
          } else if (step === 1 && /^250 /.test(line)) {
            step = 2;
            sock.write('STARTTLS\r\n');
          } else if (step === 2 && /^220/.test(line)) {
            step = 3;
            sock.removeAllListeners('data');
            upgrade(sock);
          } else if (/^[45]\d\d /.test(line)) finish(null);
        }
      }
    });
  });
}

// ------------------------------------------------------------------ IMAP connections
function imapOptions(acc, pass, { idle = false } = {}) {
  const s = acc.imap;
  return {
    host: s.host,
    port: s.port,
    secure: s.security === 'ssl',
    doSTARTTLS: s.security === 'starttls' ? true : s.security === 'none' ? false : undefined,
    auth: { user: s.user || acc.email, pass },
    tls: tlsOptions(s),
    logger: false, // imapflow logs can contain message data; we log short, secret-free lines ourselves
    clientInfo: { name: 'Selene Mail', vendor: 'Selene OS', version: '1.0' },
    connectionTimeout: CONNECT_TIMEOUT,
    greetingTimeout: 15000,
    socketTimeout: idle ? 10 * 60 * 1000 : 5 * 60 * 1000,
    disableAutoIdle: !idle,
    // The watcher connection does nothing but IDLE: enter it at once (servers only push new-mail
    // notifications during IDLE or with a command response).
    autoIdleDelay: idle ? 500 : undefined,
    maxIdleTime: idle ? 4 * 60 * 1000 : undefined,
  };
}

async function connectImap(acc, pass, opts) {
  const Flow = ImapFlow();
  const client = new Flow(imapOptions(acc, pass, opts));
  client.on('error', (e) => log(`${acc.id} imap error: ${describe(e)}`));
  try {
    await withTimeout(client.connect(), CONNECT_TIMEOUT + 15000, () => client.close());
  } catch (e) {
    try {
      client.close();
    } catch {}
    throw e;
  }
  return client;
}

class Pool {
  constructor(id) {
    this.id = id;
    this.client = null;
    this.connecting = null;
    this.specialCache = null;
  }
  async get() {
    if (this.client?.usable) return this.client;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const acc = await getAccount(this.id);
      const { imap } = secretsOf(acc);
      log(`${this.id} imap connect ${acc.imap.host}:${acc.imap.port} (${acc.imap.security})`);
      try {
        const c = await connectImap(acc, imap);
        c.on('close', () => {
          if (this.client === c) this.client = null;
        });
        this.client = c;
        setStatus(this.id, true);
        return c;
      } catch (e) {
        setStatus(this.id, false, classify(e));
        throw e;
      }
    })().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }
  drop() {
    const c = this.client;
    this.client = null;
    try {
      c?.close();
    } catch {}
  }
  async close() {
    const c = this.client;
    this.client = null;
    if (!c) return;
    try {
      await withTimeout(c.logout(), 3000);
    } catch {
      try {
        c.close();
      } catch {}
    }
  }
}
const pools = new Map();
function poolFor(id) {
  if (!pools.has(id)) pools.set(id, new Pool(id));
  return pools.get(id);
}

const statuses = new Map();
let broadcast = () => {};
function setStatus(id, online, code) {
  const prev = statuses.get(id);
  if (prev && prev.online === online && prev.code === code) return;
  statuses.set(id, { online, code: code || null });
  broadcast('mail:status', { accountId: id, online, code: code || null });
}

// Run fn(client) on the account's command connection; reconnects once when the link dropped.
async function withImap(accountId, fn, { retry = true } = {}) {
  const pool = poolFor(accountId);
  let client;
  try {
    client = await pool.get();
    return await withTimeout(fn(client), OP_TIMEOUT, () => pool.drop());
  } catch (e) {
    if (retry && isConnectionError(e) && classify(e) !== 'EAUTH') {
      pool.drop();
      return withImap(accountId, fn, { retry: false });
    }
    if (classify(e) === 'ETIMEOUT') pool.drop();
    throw mapError(e);
  }
}

// imapflow reports a refused STORE / MOVE / EXPUNGE by returning false (or undefined) instead of
// throwing: turn that into an error, so the UI never shows a change the server did not make.
// A dropped connection becomes ECONN (withImap reconnects and retries once).
function must(client, res) {
  if (res !== false && res != null) return res;
  if (!client.usable) throw err('The connection to the server was lost.', 'ECONN');
  throw err('The server refused this operation.', 'ESERVER');
}

async function withMailbox(client, folder, fn) {
  const lock = await client.getMailboxLock(folder);
  try {
    return await fn(client.mailbox);
  } finally {
    lock.release();
  }
}

// ------------------------------------------------------------------ folders
const SPECIAL_ORDER = ['inbox', 'drafts', 'sent', 'archive', 'junk', 'trash'];
function specialName(flag) {
  const f = String(flag || '').toLowerCase();
  return { '\\inbox': 'inbox', '\\sent': 'sent', '\\drafts': 'drafts', '\\trash': 'trash', '\\junk': 'junk', '\\archive': 'archive', '\\all': 'all', '\\flagged': 'flagged', '\\important': 'important' }[f] || null;
}

async function listFolders(client) {
  const list = await client.list({ statusQuery: { messages: true, unseen: true } });
  const special = {};
  const nodes = new Map();
  for (const m of list) {
    const su = m.path.toUpperCase() === 'INBOX' ? 'inbox' : specialName(m.specialUse);
    const flags = [...(m.flags || [])].map((f) => String(f).toLowerCase());
    const node = {
      path: m.path,
      name: m.name,
      delimiter: m.delimiter,
      parent: m.parentPath || '',
      special: su,
      noselect: flags.includes('\\noselect') || flags.includes('\\nonexistent'),
      unseen: m.status?.unseen ?? 0,
      total: m.status?.messages ?? 0,
      children: [],
    };
    if (su && !special[su]) special[su] = m.path;
    nodes.set(m.path, node);
  }
  const roots = [];
  for (const n of nodes.values()) {
    const parent = n.parent && nodes.get(n.parent);
    if (parent) parent.children.push(n);
    else roots.push(n);
  }
  const rank = (n) => (n.special && SPECIAL_ORDER.includes(n.special) ? SPECIAL_ORDER.indexOf(n.special) : 100);
  const sortRec = (arr) => {
    arr.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
    for (const n of arr) sortRec(n.children);
  };
  sortRec(roots);
  return { tree: roots, special };
}

async function specialFolders(accountId, client) {
  const pool = poolFor(accountId);
  if (pool.specialCache) return pool.specialCache;
  const { special } = await listFolders(client);
  pool.specialCache = special;
  return special;
}

// Find a special folder, creating a plain one when the server has none (e.g. no Archive).
async function ensureSpecial(accountId, client, kind) {
  const sp = await specialFolders(accountId, client);
  if (sp[kind]) return sp[kind];
  if (kind === 'archive' && sp.all) return sp.all; // Gmail: archiving = removing from the inbox
  const names = { sent: 'Sent', drafts: 'Drafts', trash: 'Trash', archive: 'Archive', junk: 'Junk' };
  const name = names[kind];
  if (!name) throw err(`No ${kind} folder`, 'EFAIL');
  try {
    const res = await client.mailboxCreate(name);
    sp[kind] = res?.path || name;
  } catch (e) {
    // It may exist without a special-use flag.
    const all = await client.list();
    const hit = all.find((m) => m.name.toLowerCase() === name.toLowerCase());
    if (!hit) throw e;
    sp[kind] = hit.path;
  }
  return sp[kind];
}

// ------------------------------------------------------------------ message list
function walkStructure(node, fn, depth = 0) {
  if (!node || depth > 30) return;
  fn(node);
  for (const c of node.childNodes || []) walkStructure(c, fn, depth + 1);
}

function hasAttachments(bs) {
  let found = false;
  walkStructure(bs, (n) => {
    if (found || n.childNodes) return;
    const type = String(n.type || '').toLowerCase();
    const disp = String(n.disposition || '').toLowerCase();
    if (disp === 'attachment') found = true;
    else if (disp !== 'inline' && !type.startsWith('text/') && !type.startsWith('multipart/') && type !== 'message/delivery-status') {
      // An image referenced from the HTML (Content-ID, no disposition) is not an attachment.
      if (!(type.startsWith('image/') && n.id)) found = true;
    } else if (disp === 'inline' && n.dispositionParameters?.filename && !type.startsWith('image/') && !type.startsWith('text/')) found = true;
  });
  return found;
}

// Which body part gives the cheapest readable preview.
function previewPart(bs) {
  if (!bs) return null;
  const leaf = (n) => {
    const type = String(n.type || '').toLowerCase();
    if (String(n.disposition || '').toLowerCase() === 'attachment') return null;
    if (type === 'text/plain' || type === 'text/html') return { part: n.part || '1', type, encoding: String(n.encoding || '7bit').toLowerCase(), charset: n.parameters?.charset || 'utf-8' };
    return null;
  };
  const visit = (n, depth = 0) => {
    if (!n || depth > 20) return null;
    const type = String(n.type || '').toLowerCase();
    if (!n.childNodes) return leaf(n);
    if (type === 'multipart/alternative') {
      const kids = n.childNodes;
      const plain = kids.find((k) => String(k.type).toLowerCase() === 'text/plain');
      if (plain) return leaf(plain);
      for (const k of kids) {
        const r = visit(k, depth + 1);
        if (r) return r;
      }
      return null;
    }
    if (type === 'multipart/encrypted' || type === 'multipart/signed') return visit(n.childNodes[0], depth + 1);
    for (const k of n.childNodes) {
      const r = visit(k, depth + 1);
      if (r) return r;
    }
    return null;
  };
  return visit(bs);
}

let _libqp = null;
let _iconv = null;
function decodeBody(buf, encoding, charset) {
  let data = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf || ''), 'binary');
  try {
    if (encoding === 'base64') {
      let s = data.toString('latin1').replace(/[^A-Za-z0-9+/]/g, '');
      s = s.slice(0, s.length - (s.length % 4));
      data = Buffer.from(s, 'base64');
    } else if (encoding === 'quoted-printable') {
      _libqp ||= require('libqp');
      data = _libqp.decode(data.toString('latin1').replace(/=[0-9A-Fa-f]?$/, ''));
    }
  } catch {}
  const cs = String(charset || 'utf-8').toLowerCase();
  if (cs === 'utf-8' || cs === 'utf8' || cs === 'us-ascii' || cs === 'ascii') return data.toString('utf8');
  try {
    _iconv ||= require('iconv-lite');
    if (_iconv.encodingExists(cs)) return _iconv.decode(data, cs);
  } catch {}
  return data.toString('latin1');
}

const ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", eacute: 'é', egrave: 'è', agrave: 'à', ccedil: 'ç', ecirc: 'ê', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', ndash: '–', mdash: '—', euro: '€', copy: '©', reg: '®', zwnj: '', zwj: '' };
function htmlToPreview(html) {
  return String(html || '')
    .replace(/<(head|style|script|title)[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<(head|style|script|title)\b[\s\S]*$/i, ' ') // a block cut by the partial fetch
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|\/p|\/div|\/tr|\/h\d|\/li)[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] === '#') {
        const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        try {
          return String.fromCodePoint(n);
        } catch {
          return ' ';
        }
      }
      return ENTITIES[e.toLowerCase()] ?? ' ';
    });
}

function cleanPreview(text) {
  let src = String(text || '').replace(/\r/g, '');
  // Stop at the quoted original of a reply ("On … wrote:", "Le … a écrit :", "-----Original Message-----").
  const cut = src.search(/(^|\n)[^\n]{0,8}(On [^\n]{4,200} wrote:|Le [^\n]{4,200} a écrit\s?:|-{3,} ?Original Message ?-{3,}|-{3,} ?Message d'origine ?-{3,})/i);
  if (cut > 0) src = src.slice(0, cut);
  const lines = src.split('\n').filter((l) => !/^\s*>/.test(l)); // drop quoted text
  return lines
    .join(' ')
    .replace(/[​-‏­͏﻿ ⁠]/g, '')
    .replace(/�+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

const previewCache = new Map(); // `${accountId}|${folder}|${uidValidity}|${uid}` -> text
function cachePreview(key, text) {
  previewCache.set(key, text);
  if (previewCache.size > 5000) previewCache.delete(previewCache.keys().next().value);
}

function summarize(m) {
  const env = m.envelope || {};
  const flags = m.flags || new Set();
  return {
    uid: m.uid,
    seq: m.seq,
    subject: env.subject || '',
    from: envAddrs(env.from),
    to: envAddrs(env.to),
    cc: envAddrs(env.cc),
    replyTo: envAddrs(env.replyTo),
    date: (env.date && !Number.isNaN(new Date(env.date).getTime()) ? new Date(env.date) : m.internalDate ? new Date(m.internalDate) : new Date()).toISOString(),
    received: m.internalDate ? new Date(m.internalDate).toISOString() : null,
    messageId: env.messageId || null,
    inReplyTo: env.inReplyTo || null,
    size: m.size || 0,
    seen: flags.has('\\Seen'),
    flagged: flags.has('\\Flagged'),
    answered: flags.has('\\Answered'),
    forwarded: flags.has('$Forwarded'),
    draft: flags.has('\\Draft'),
    hasAttachments: hasAttachments(m.bodyStructure),
    preview: null,
  };
}

async function addPreviews(client, accountId, folder, mailbox, rows, fetched) {
  const groups = new Map(); // part -> [{row, info}]
  const uv = String(mailbox.uidValidity || '');
  for (let i = 0; i < rows.length; i++) {
    const key = `${accountId}|${folder}|${uv}|${rows[i].uid}`;
    if (previewCache.has(key)) {
      rows[i].preview = previewCache.get(key);
      continue;
    }
    const info = previewPart(fetched[i].bodyStructure);
    if (!info) continue;
    if (!groups.has(info.part)) groups.set(info.part, []);
    groups.get(info.part).push({ row: rows[i], info, key });
  }
  for (const [part, items] of groups) {
    const byUid = new Map(items.map((x) => [x.row.uid, x]));
    try {
      const html = items.some((x) => x.info.type === 'text/html');
      const res = await client.fetchAll(items.map((x) => x.row.uid).join(','), { uid: true, bodyParts: [{ key: part, start: 0, maxLength: html ? 8192 : 2048 }] }, { uid: true });
      for (const m of res) {
        const it = byUid.get(m.uid);
        if (!it || !m.bodyParts) continue;
        const raw = m.bodyParts.get(part) || m.bodyParts.get(part.toLowerCase()) || [...m.bodyParts.values()][0];
        if (!raw) continue;
        let text = decodeBody(raw, it.info.encoding, it.info.charset);
        if (it.info.type === 'text/html') text = htmlToPreview(text);
        it.row.preview = cleanPreview(text);
        cachePreview(it.key, it.row.preview);
      }
    } catch (e) {
      log(`${accountId} preview fetch failed: ${describe(e)}`);
    }
  }
}

function searchQuery(text, filter) {
  const q = {};
  const s = String(text || '').trim();
  if (s) q.or = [{ subject: s }, { from: s }, { to: s }, { cc: s }, { body: s }];
  if (filter === 'unread') q.seen = false;
  if (filter === 'flagged') q.flagged = true;
  return Object.keys(q).length ? q : null;
}

async function listMessages(accountId, folder, opts = {}) {
  const page = Math.max(0, Number(opts.page) || 0);
  const pageSize = Math.min(500, Math.max(1, Number(opts.pageSize) || PAGE_SIZE));
  const query = searchQuery(opts.search, opts.filter);
  return withImap(accountId, (client) =>
    withMailbox(client, folder, async (mailbox) => {
      // A mailbox that was already selected only learns about new messages (EXISTS) with the
      // response to a command: sync first so the page range is computed on the current count.
      if (opts.sync !== false) await client.noop().catch(() => {});
      mailbox = client.mailbox || mailbox;
      let total = mailbox.exists || 0;
      let fetched = [];
      if (query) {
        let uids = (await client.search(query, { uid: true })) || [];
        uids = [...new Set(uids)].sort((a, b) => b - a);
        total = uids.length;
        const slice = uids.slice(page * pageSize, (page + 1) * pageSize);
        if (slice.length) fetched = await client.fetchAll(slice.join(','), { uid: true, flags: true, envelope: true, bodyStructure: true, internalDate: true, size: true }, { uid: true });
        const order = new Map(slice.map((u, i) => [u, i]));
        fetched.sort((a, b) => order.get(a.uid) - order.get(b.uid));
      } else if (total > 0) {
        const end = total - page * pageSize;
        if (end >= 1) {
          const start = Math.max(1, end - pageSize + 1);
          fetched = await client.fetchAll(`${start}:${end}`, { uid: true, flags: true, envelope: true, bodyStructure: true, internalDate: true, size: true });
          fetched.sort((a, b) => b.seq - a.seq);
        }
      }
      // Newest received first inside the page. Arrival order (sequence numbers) is the same thing,
      // except for messages moved back into the folder (Undo, Not junk…): they keep their received
      // date and must not jump to the top of the list.
      const when = (m) => (m.internalDate ? new Date(m.internalDate).getTime() : 0) || 0;
      fetched.sort((a, b) => when(b) - when(a) || b.seq - a.seq);
      const rows = fetched.map(summarize);
      await addPreviews(client, accountId, folder, mailbox, rows, fetched);
      return {
        folder,
        total,
        page,
        pageSize,
        hasMore: (page + 1) * pageSize < total,
        uidValidity: String(mailbox.uidValidity || ''),
        messages: rows,
      };
    }),
  );
}

// ------------------------------------------------------------------ message parsing
const parsedCache = new Map(); // key -> { attachments: [{filename, contentType, content}] , at }
function cacheParsed(key, value) {
  parsedCache.delete(key);
  parsedCache.set(key, value);
  let total = 0;
  for (const v of parsedCache.values()) total += v.bytes || 0;
  while (parsedCache.size > 12 || (total > 150 * 1024 * 1024 && parsedCache.size > 1)) {
    const k = parsedCache.keys().next().value;
    total -= parsedCache.get(k).bytes || 0;
    parsedCache.delete(k);
  }
}

function addrObjects(v) {
  if (!v) return [];
  const arr = Array.isArray(v) ? v : [v];
  const out = [];
  const visit = (a) => {
    if (!a) return;
    if (a.group) a.group.forEach(visit);
    else if (a.address || a.name) out.push({ name: a.name || '', address: a.address || '' });
  };
  for (const x of arr) (x.value || []).forEach(visit);
  return out;
}

async function parseMessage(source, key) {
  const parsed = await simpleParser()(source, { keepCidLinks: true, skipImageLinks: true, skipTextToHtml: true, skipTextLinks: true, maxHtmlLengthToParse: 4 * 1024 * 1024 });
  const html = typeof parsed.html === 'string' ? parsed.html : null;
  const attachments = [];
  const inlineCids = {};
  let inlineBytes = 0;
  let bytes = 0;
  const stored = [];
  (parsed.attachments || []).forEach((a, i) => {
    const content = Buffer.isBuffer(a.content) ? a.content : Buffer.alloc(0);
    bytes += content.length;
    const cid = a.cid || (a.contentId ? String(a.contentId).replace(/^<|>$/g, '') : null);
    const type = String(a.contentType || 'application/octet-stream').toLowerCase();
    const referenced = !!(cid && html && html.includes(`cid:${cid}`));
    if (referenced && type.startsWith('image/') && content.length <= 8 * 1024 * 1024 && inlineBytes + content.length <= 24 * 1024 * 1024) {
      inlineCids[cid] = `data:${type};base64,${content.toString('base64')}`;
      inlineBytes += content.length;
    }
    let filename = a.filename;
    if (!filename) {
      const ext = { 'message/rfc822': '.eml', 'text/calendar': '.ics', 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'application/pdf': '.pdf', 'text/plain': '.txt' }[type] || '';
      filename = `${type === 'message/rfc822' ? 'message' : 'attachment'}${attachments.length ? ` ${attachments.length + 1}` : ''}${ext}`;
    }
    stored.push({ filename: safeFileName(filename), contentType: type, content });
    attachments.push({ id: i, filename: safeFileName(filename), contentType: type, size: content.length, cid: cid || null, inline: referenced });
  });
  cacheParsed(key, { attachments: stored, bytes });
  const refs = parsed.references ? (Array.isArray(parsed.references) ? parsed.references : String(parsed.references).split(/\s+/)) : [];
  return {
    subject: parsed.subject || '',
    from: addrObjects(parsed.from),
    to: addrObjects(parsed.to),
    cc: addrObjects(parsed.cc),
    bcc: addrObjects(parsed.bcc),
    replyTo: addrObjects(parsed.replyTo),
    date: parsed.date && !Number.isNaN(parsed.date.getTime()) ? parsed.date.toISOString() : null,
    html,
    text: typeof parsed.text === 'string' ? parsed.text : '',
    attachments,
    inlineCids,
    messageId: parsed.messageId || null,
    inReplyTo: parsed.inReplyTo || null,
    references: refs.filter(Boolean),
    listUnsubscribe: parsed.headers?.get?.('list-unsubscribe') ? true : false,
    priority: parsed.priority || 'normal',
  };
}

async function getMessage(accountId, folder, uid, opts = {}) {
  uid = Number(uid);
  const markSeen = opts.markSeen !== false;
  const res = await withImap(accountId, (client) =>
    withMailbox(client, folder, async () => {
      const m = await client.fetchOne(String(uid), { uid: true, flags: true, source: true, internalDate: true, size: true }, { uid: true });
      if (!m || !m.source) throw err('This message no longer exists.', 'ENOMSG');
      if (m.source.length > MAX_SOURCE) throw err('This message is too large to open.', 'EFAIL');
      let seen = m.flags?.has('\\Seen');
      if (!seen && markSeen) {
        try {
          await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
          seen = true;
        } catch (e) {
          log(`${accountId} cannot mark seen: ${describe(e)}`);
        }
      }
      return { m, seen };
    }),
  );
  const parsed = await parseMessage(res.m.source, `${accountId}|${folder}|${uid}`);
  const flags = res.m.flags || new Set();
  return {
    accountId,
    folder,
    uid,
    ...parsed,
    date: parsed.date || (res.m.internalDate ? new Date(res.m.internalDate).toISOString() : null),
    size: res.m.size || res.m.source.length,
    seen: res.seen,
    flagged: flags.has('\\Flagged'),
    answered: flags.has('\\Answered'),
    forwarded: flags.has('$Forwarded'),
    draft: flags.has('\\Draft'),
  };
}

async function saveAttachment(accountId, folder, uid, attachmentId, opts = {}) {
  const key = accountId === '@file' ? `file|${folder}` : `${accountId}|${folder}|${Number(uid)}`;
  if (!parsedCache.has(key)) {
    if (accountId === '@file') await parseFile(folder);
    else await getMessage(accountId, folder, uid, { markSeen: false });
  }
  const entry = parsedCache.get(key);
  const a = entry?.attachments?.[Number(attachmentId)];
  if (!a) throw err('This attachment could not be found.', 'ENOMSG');
  if (opts.dest) {
    // "Save as": the user picked this exact path (and confirmed replacing it in the file picker).
    const dest = String(opts.dest);
    if (!path.isAbsolute(dest)) throw err('Invalid destination.', 'EINVAL');
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.writeFile(dest, a.content);
    return dest;
  }
  const dir = opts.dir && path.isAbsolute(String(opts.dir)) ? String(opts.dir) : downloadsDir();
  await fsp.mkdir(dir, { recursive: true });
  return writeUnique(dir, safeFileName(a.filename), a.content, { reuse: !!opts.reuse });
}

async function parseFile(file) {
  const p = String(file || '');
  if (!path.isAbsolute(p)) throw err('Invalid file.', 'EINVAL');
  const st = await fsp.stat(p);
  if (st.size > MAX_SOURCE) throw err('This message is too large to open.', 'EFAIL');
  const source = await fsp.readFile(p);
  const parsed = await parseMessage(source, `file|${p}`);
  return { accountId: '@file', folder: p, uid: 0, ...parsed, size: st.size, seen: true, flagged: false };
}

// ------------------------------------------------------------------ SMTP
function smtpTransport(acc, pass) {
  const s = acc.smtp;
  return nodemailer().createTransport({
    host: s.host,
    port: s.port,
    secure: s.security === 'ssl',
    requireTLS: s.security === 'starttls',
    ignoreTLS: s.security === 'none',
    auth: pass ? { user: s.user || acc.email, pass } : undefined,
    tls: tlsOptions(s),
    name: 'aurora.localdomain',
    connectionTimeout: CONNECT_TIMEOUT,
    greetingTimeout: 15000,
    socketTimeout: 60000,
    logger: false,
    disableFileAccess: false,
    disableUrlAccess: true,
  });
}

function compose(acc, msg, { keepBcc = false, messageId, date } = {}) {
  const C = MailComposer();
  const mail = {
    from: { name: acc.name || '', address: acc.email },
    to: addrList(msg.to),
    cc: addrList(msg.cc),
    bcc: addrList(msg.bcc),
    subject: String(msg.subject || ''),
    messageId,
    date,
    headers: { 'X-Mailer': 'Selene Mail' },
    attachments: [],
  };
  if (msg.html) mail.html = String(msg.html);
  mail.text = String(msg.text ?? '');
  if (msg.inReplyTo) mail.inReplyTo = String(msg.inReplyTo);
  if (msg.references) mail.references = Array.isArray(msg.references) ? msg.references.map(String) : String(msg.references);
  for (const a of msg.attachments || []) {
    const p = typeof a === 'string' ? a : a?.path;
    if (!p || !path.isAbsolute(p)) continue;
    mail.attachments.push({ path: p, filename: safeFileName(typeof a === 'object' && a.filename ? a.filename : path.basename(p)) });
  }
  // Pictures inside the HTML (pasted images, quoted inline images) travel as related parts
  // (cid:) — many mail clients refuse data: URLs.
  if (mail.html && /\bsrc=["']data:image\//i.test(mail.html)) {
    let n = 0;
    const stamp = crypto.randomBytes(4).toString('hex');
    mail.html = mail.html.replace(/(<img\b[^>]*?\bsrc=)(["'])data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)\2/gi, (m, pre, q, type, b64) => {
      const cid = `image${++n}.${stamp}@aurora`;
      const ext = type.split('/')[1].replace('jpeg', 'jpg').replace(/[^a-z0-9]/gi, '').slice(0, 5) || 'img';
      mail.attachments.push({ cid, content: Buffer.from(b64.replace(/\s+/g, ''), 'base64'), contentType: type, filename: `image${n}.${ext}`, contentDisposition: 'inline' });
      return `${pre}${q}cid:${cid}${q}`;
    });
  }
  if (!mail.attachments.length) delete mail.attachments;
  const node = new C(mail).compile();
  node.keepBcc = keepBcc;
  return new Promise((resolve, reject) => node.build((e, buf) => (e ? reject(e) : resolve(buf))));
}

async function sendMessage(accountId, msg = {}) {
  const acc = await getAccount(accountId);
  const to = addrList(msg.to);
  const cc = addrList(msg.cc);
  const bcc = addrList(msg.bcc);
  const rcpt = [...to, ...cc, ...bcc].map((a) => a.address);
  if (!rcpt.length) throw err('Add at least one recipient.', 'EINVAL');
  for (const a of msg.attachments || []) {
    const p = typeof a === 'string' ? a : a?.path;
    try {
      await fsp.access(p, fs.constants.R_OK);
    } catch (e) {
      // The message is the file's path: the composer says which attachment is missing, in its language.
      throw err(String(p || ''), e.code === 'EACCES' ? 'EACCES' : 'ENOENT');
    }
  }
  const domain = acc.email.split('@')[1] || 'aurora.localdomain';
  const messageId = `<${crypto.randomUUID()}@${domain}>`;
  const date = new Date();
  let raw;
  try {
    raw = await compose(acc, msg, { messageId, date });
  } catch (e) {
    throw err(`Could not build the message: ${describe(e)}`, 'EFAIL');
  }
  const { smtp: pass } = secretsOf(acc);
  const transport = smtpTransport(acc, pass);
  let info;
  try {
    log(`${accountId} smtp send to ${rcpt.length} recipient(s) via ${acc.smtp.host}:${acc.smtp.port}`);
    info = await withTimeout(transport.sendMail({ envelope: { from: acc.email, to: rcpt }, raw }), 120000, () => transport.close());
  } catch (e) {
    throw mapError(e, 'smtp');
  } finally {
    transport.close();
  }
  // Follow-ups never fail the send: flags on the original, Sent copy, draft clean-up.
  (async () => {
    try {
      if (msg.origin?.folder && msg.origin?.uid) {
        const flag = msg.origin.action === 'forward' ? '$Forwarded' : '\\Answered';
        await withImap(accountId, (c) => withMailbox(c, msg.origin.folder, () => c.messageFlagsAdd(String(msg.origin.uid), [flag], { uid: true })));
        broadcast('mail:changed', { accountId, folder: msg.origin.folder });
      }
    } catch (e) {
      log(`${accountId} cannot flag the original: ${describe(e)}`);
    }
    try {
      await storeSentCopy(acc, msg, { messageId, date });
    } catch (e) {
      log(`${accountId} cannot save to Sent: ${describe(e)}`);
    }
    try {
      if (msg.draft?.uid) {
        await withImap(accountId, (c) => withMailbox(c, msg.draft.folder, () => c.messageDelete(String(msg.draft.uid), { uid: true })));
        broadcast('mail:changed', { accountId, folder: msg.draft.folder });
      }
    } catch (e) {
      log(`${accountId} cannot remove the draft: ${describe(e)}`);
    }
  })();
  return { messageId, accepted: info?.accepted || rcpt, rejected: info?.rejected || [] };
}

async function storeSentCopy(acc, msg, { messageId, date }) {
  const mode = acc.sentMode || 'append';
  if (mode === 'auto') return; // Gmail files sent mail itself
  const copy = await compose(acc, msg, { keepBcc: true, messageId, date });
  await withImap(acc.id, async (client) => {
    const sent = await ensureSpecial(acc.id, client, 'sent');
    if (mode === 'check') {
      await new Promise((r) => setTimeout(r, 2500));
      const found = await withMailbox(client, sent, () => client.search({ header: { 'message-id': messageId } }, { uid: true }));
      if (found && found.length) return;
    }
    await client.append(sent, copy, ['\\Seen'], date);
    broadcast('mail:changed', { accountId: acc.id, folder: sent });
  });
}

async function saveDraft(accountId, msg = {}, opts = {}) {
  const acc = await getAccount(accountId);
  const domain = acc.email.split('@')[1] || 'aurora.localdomain';
  const raw = await compose(acc, { ...msg, to: msg.to, cc: msg.cc, bcc: msg.bcc }, { keepBcc: true, messageId: `<${crypto.randomUUID()}@${domain}>`, date: new Date() });
  return withImap(accountId, async (client) => {
    const drafts = await ensureSpecial(accountId, client, 'drafts');
    const res = await client.append(drafts, raw, ['\\Draft', '\\Seen']);
    if (opts.replaceUid) {
      try {
        await withMailbox(client, drafts, () => client.messageDelete(String(opts.replaceUid), { uid: true }));
      } catch (e) {
        log(`${accountId} cannot replace the old draft: ${describe(e)}`);
      }
    }
    broadcast('mail:changed', { accountId, folder: drafts });
    return { folder: drafts, uid: res?.uid || null };
  });
}

// ------------------------------------------------------------------ account testing
async function testImap(n, pass) {
  const acc = { id: 'test', email: n.email, imap: n.imap };
  const client = await connectImap(acc, pass);
  try {
    await withTimeout(client.list(), 20000);
  } finally {
    try {
      await withTimeout(client.logout(), 3000);
    } catch {
      client.close();
    }
  }
}

async function testSmtp(n, pass) {
  const t = smtpTransport({ email: n.email, smtp: n.smtp }, pass);
  try {
    await withTimeout(t.verify(), CONNECT_TIMEOUT + 20000, () => t.close());
  } finally {
    t.close();
  }
}

async function testConfig(n, imapPass, smtpPass) {
  for (const side of ['imap', 'smtp']) {
    try {
      if (side === 'imap') await testImap(n, imapPass);
      else await testSmtp(n, smtpPass);
    } catch (e) {
      const code = classify(e);
      const server = n[side];
      const error = { code: code === 'EFAIL' && side === 'imap' && /LOGIN|AUTH/i.test(describe(e)) ? 'EAUTH' : code, side, host: server.host, port: server.port, message: describe(e) };
      if (code === 'ETLS') {
        const cert = await probeCertificate(server, side);
        if (cert) error.cert = cert;
      }
      log(`test ${side} ${server.host}:${server.port} failed: ${error.code} ${error.message}`);
      return { ok: false, error };
    }
  }
  return { ok: true };
}

// ------------------------------------------------------------------ IDLE watchers
let watching = false;
const watchers = new Map(); // accountId -> watcher
const BACKOFF = [2000, 5000, 15000, 30000, 60000, 120000, 300000];

class Watcher {
  constructor(id) {
    this.id = id;
    this.client = null;
    this.timer = null;
    this.failures = 0;
    this.stopped = false;
    this.exists = 0;
    this.changeTimer = null;
    this.start();
  }
  async start() {
    if (this.stopped) return;
    let c = null;
    try {
      const acc = await getAccount(this.id);
      const { imap } = secretsOf(acc);
      c = await connectImap(acc, imap, { idle: true });
      if (this.stopped) {
        c.close();
        return;
      }
      this.client = c;
      const mb = await withTimeout(c.mailboxOpen('INBOX'), 30000);
      this.exists = mb.exists || 0;
      this.failures = 0;
      setStatus(this.id, true);
      c.on('exists', (d) => this.onExists(d).catch((e) => log(`${this.id} new mail check failed: ${describe(e)}`)));
      c.on('expunge', () => {
        this.exists = Math.max(0, (c.mailbox?.exists ?? this.exists - 1));
        this.changed();
      });
      c.on('flags', () => this.changed());
      c.on('close', () => {
        if (this.client === c) this.client = null;
        this.retry();
      });
      // imapflow enters IDLE on its own once the connection is quiet.
      log(`${this.id} watching INBOX (${c.capabilities.has('IDLE') ? 'IDLE' : 'polling'})`);
      if (!c.capabilities.has('IDLE')) this.poll();
    } catch (e) {
      // Connected but INBOX could not be opened: drop that connection, a new one is made on retry.
      if (c && this.client === c) this.client = null;
      try {
        c?.close();
      } catch {}
      const code = classify(e);
      setStatus(this.id, false, code);
      log(`${this.id} watcher connect failed: ${code}`);
      if (code === 'ENOACCOUNT') return this.stop();
      this.retry(code === 'EAUTH');
    }
  }
  poll() {
    clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => {
      if (this.client?.usable) this.client.noop().catch(() => {});
    }, 120000);
  }
  retry(slow = false) {
    if (this.stopped || this.timer) return;
    const delay = slow ? 15 * 60 * 1000 : BACKOFF[Math.min(this.failures, BACKOFF.length - 1)];
    this.failures++;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.start();
    }, delay);
  }
  changed() {
    clearTimeout(this.changeTimer);
    this.changeTimer = setTimeout(() => broadcast('mail:changed', { accountId: this.id, folder: 'INBOX' }), 300);
  }
  async onExists(d) {
    if (process.env.AURORA_MAIL_DEBUG) log(`${this.id} exists ${JSON.stringify(d)} (was ${this.exists})`);
    // imapflow reports the count before this EXISTS (expunges by other sessions included).
    const prev = Number.isInteger(d.prevCount) ? d.prevCount : this.exists;
    this.exists = d.count;
    if (d.count <= prev || !this.client) {
      this.changed();
      return;
    }
    const c = this.client;
    const list = await c.fetchAll(`${prev + 1}:${d.count}`, { uid: true, flags: true, envelope: true });
    const fresh = list.filter((m) => !m.flags?.has('\\Seen'));
    if (fresh.length) {
      const last = fresh[fresh.length - 1];
      const from = envAddrs(last.envelope?.from)[0] || {};
      broadcast('mail:new', { accountId: this.id, folder: 'INBOX', count: fresh.length, uid: last.uid, from: from.name || from.address || '', fromAddress: from.address || '', subject: last.envelope?.subject || '' });
    }
    this.changed();
  }
  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    clearTimeout(this.changeTimer);
    clearInterval(this.pollTimer);
    const c = this.client;
    this.client = null;
    if (c) withTimeout(c.logout(), 3000).catch(() => c.close());
  }
}

async function syncWatchers() {
  const list = watching ? await loadAccounts() : [];
  const ids = new Set(list.map((a) => a.id));
  for (const [id, w] of watchers) {
    if (!ids.has(id)) {
      w.stop();
      watchers.delete(id);
    }
  }
  for (const id of ids) if (!watchers.has(id)) watchers.set(id, new Watcher(id));
}

function restartWatcher(id) {
  const w = watchers.get(id);
  if (w) {
    w.stop();
    watchers.delete(id);
  }
  if (watching) syncWatchers().catch(() => {});
}

// ------------------------------------------------------------------ autodetect (Mozilla ISPDB)
async function autodetect(email) {
  const known = presetForEmail(email);
  if (known) return { ...known, source: 'preset' };
  const domain = String(email || '').split('@')[1]?.toLowerCase().trim();
  if (!domain || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return null;
  try {
    const fetcher = electronNet?.fetch ? electronNet.fetch.bind(electronNet) : fetch;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetcher(`https://autoconfig.thunderbird.net/v1.1/${encodeURIComponent(domain)}`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (res.ok) {
      const xml = await res.text();
      const pick = (tag, type) => {
        const re = new RegExp(`<${tag}[^>]*type="${type}"[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
        const block = re.exec(xml)?.[1];
        if (!block) return null;
        const get = (k) => new RegExp(`<${k}>([^<]*)</${k}>`, 'i').exec(block)?.[1]?.trim();
        const sock = (get('socketType') || '').toUpperCase();
        const host = get('hostname');
        const port = Number(get('port'));
        if (!host || !port) return null;
        const user = get('username') || '';
        return { host, port, security: sock === 'SSL' ? 'ssl' : sock === 'STARTTLS' ? 'starttls' : 'none', user: user.includes('%EMAILLOCALPART%') ? 'local' : '' };
      };
      const imap = pick('incomingServer', 'imap');
      const smtp = pick('outgoingServer', 'smtp');
      if (imap && smtp && imap.security !== 'none' && smtp.security !== 'none') return { provider: 'other', imap, smtp, source: 'ispdb' };
    }
  } catch {}
  return { provider: 'other', imap: { host: `imap.${domain}`, port: 993, security: 'ssl' }, smtp: { host: `smtp.${domain}`, port: 465, security: 'ssl' }, source: 'guess' };
}

// ------------------------------------------------------------------ registration
module.exports = function register(api) {
  broadcast = (ch, payload) => api.broadcast(ch, payload);
  const handle = (channel, fn) =>
    api.handle(channel, async (...args) => {
      try {
        return await fn(...args.slice(0, -1)); // last argument is the IPC event
      } catch (e) {
        const m = mapError(e);
        if (!['ENOMSG', 'EINVAL', 'EAUTH', 'ECONN', 'ETIMEOUT'].includes(m.code)) log(`${channel} failed: ${m.code} ${m.message}`);
        throw api.error(m.message, m.code);
      }
    });

  handle('mail:presets', () =>
    PRESETS.map((p) => ({ id: p.id, name: p.name, sub: p.sub, color: p.color, fg: p.fg || '#ffffff', mono: p.mono, domains: p.domains, imap: p.imap || null, smtp: p.smtp || null, appPasswordUrl: p.appPasswordUrl || null, webmail: p.webmail || null, manual: !!p.manual, bridge: !!p.bridge })),
  );
  handle('mail:autodetect', (email) => autodetect(email));
  handle('mail:storage', () => ({ ...secretMode() }));
  handle('mail:accounts', async () => (await loadAccounts()).map(publicAccount));

  handle('mail:testAccount', async (cfg) => {
    let existing = null;
    if (cfg?.id) existing = await getAccount(cfg.id);
    const n = normalizeCfg(cfg, existing);
    const stored = existing ? secretsOf(existing) : { imap: '', smtp: '' };
    const imapPass = n.password ?? stored.imap;
    const smtpPass = n.smtp.sameAuth ? imapPass : n.smtpPassword ?? stored.smtp ?? imapPass;
    if (!imapPass) throw err('Enter your password.', 'EINVAL');
    return testConfig(n, imapPass, smtpPass);
  });

  handle('mail:addAccount', async (cfg) => {
    const n = normalizeCfg(cfg);
    if (!n.password) throw err('Enter your password.', 'EINVAL');
    const list = await loadAccounts();
    if (list.some((a) => a.email.toLowerCase() === n.email.toLowerCase())) throw err('This account has already been added.', 'EEXISTS');
    const smtpPass = n.smtp.sameAuth ? n.password : n.smtpPassword || n.password;
    if (!cfg.skipTest) {
      const res = await testConfig(n, n.password, smtpPass);
      if (!res.ok) throw err(`${res.error.side}: ${res.error.message}`, res.error.code);
    }
    const acc = {
      id: crypto.randomBytes(6).toString('hex'),
      email: n.email,
      name: n.name,
      provider: n.provider,
      imap: n.imap,
      smtp: n.smtp,
      allowInsecure: n.allowInsecure,
      secret: { imap: sealSecret(n.password), smtp: n.smtp.sameAuth ? null : sealSecret(smtpPass) },
      sentMode: sentModeFor(n),
      signature: null,
      signatureEnabled: true,
      created: Date.now(),
    };
    list.push(acc);
    await saveAccounts();
    log(`account ${acc.id} added (${acc.provider}, ${acc.imap.host})`);
    if (watching) syncWatchers().catch(() => {});
    return publicAccount(acc);
  });

  handle('mail:updateAccount', async (id, patch = {}) => {
    const acc = await getAccount(id);
    const serverChange = patch.imap || patch.smtp || patch.password || patch.email || patch.trust;
    if (serverChange) {
      const n = normalizeCfg({ ...patch, provider: patch.provider || acc.provider }, acc);
      const stored = secretsOf(acc);
      const imapPass = n.password ?? stored.imap;
      const smtpPass = n.smtp.sameAuth ? imapPass : n.smtpPassword ?? stored.smtp ?? imapPass;
      if (!patch.skipTest) {
        const res = await testConfig(n, imapPass, smtpPass);
        if (!res.ok) throw err(`${res.error.side}: ${res.error.message}`, res.error.code);
      }
      Object.assign(acc, { email: n.email, name: n.name, provider: n.provider, imap: n.imap, smtp: n.smtp, allowInsecure: n.allowInsecure, sentMode: sentModeFor(n) });
      acc.secret = { imap: sealSecret(imapPass), smtp: n.smtp.sameAuth ? null : sealSecret(smtpPass) };
      await poolFor(id).close();
      pools.delete(id);
      restartWatcher(id);
    }
    if (patch.name !== undefined) acc.name = String(patch.name || '').trim() || acc.email.split('@')[0];
    if (patch.signature !== undefined) acc.signature = patch.signature == null ? null : String(patch.signature).slice(0, 20000);
    if (patch.signatureEnabled !== undefined) acc.signatureEnabled = !!patch.signatureEnabled;
    await saveAccounts();
    return publicAccount(acc);
  });

  handle('mail:removeAccount', async (id) => {
    const list = await loadAccounts();
    const i = list.findIndex((a) => a.id === id);
    if (i < 0) return true;
    list.splice(i, 1);
    await saveAccounts();
    const w = watchers.get(id);
    if (w) {
      w.stop();
      watchers.delete(id);
    }
    await poolFor(id).close();
    pools.delete(id);
    statuses.delete(id);
    for (const k of [...parsedCache.keys()]) if (k.startsWith(`${id}|`)) parsedCache.delete(k);
    for (const k of [...previewCache.keys()]) if (k.startsWith(`${id}|`)) previewCache.delete(k);
    log(`account ${id} removed`);
    return true;
  });

  handle('mail:folders', (accountId) =>
    withImap(accountId, async (client) => {
      const res = await listFolders(client);
      poolFor(accountId).specialCache = res.special;
      return res;
    }),
  );
  handle('mail:list', (accountId, folder, opts) => listMessages(accountId, String(folder || 'INBOX'), opts || {}));
  handle('mail:message', (accountId, folder, uid, opts) => getMessage(accountId, String(folder), uid, opts || {}));
  handle('mail:attachment', (accountId, folder, uid, attachmentId, opts) => saveAttachment(accountId, String(folder), uid, attachmentId, opts || {}));
  handle('mail:parseFile', (file) => parseFile(file));

  handle('mail:setFlags', (accountId, folder, uids, flags = {}) => {
    const list = uidList(uids).join(',');
    return withImap(accountId, (client) =>
      withMailbox(client, String(folder), async () => {
        const add = [];
        const remove = [];
        for (const [k, f] of [
          ['seen', '\\Seen'],
          ['flagged', '\\Flagged'],
          ['answered', '\\Answered'],
        ]) {
          if (flags[k] === true) add.push(f);
          else if (flags[k] === false) remove.push(f);
        }
        if (add.length) must(client, await client.messageFlagsAdd(list, add, { uid: true }));
        if (remove.length) must(client, await client.messageFlagsRemove(list, remove, { uid: true }));
        return true;
      }),
    );
  });

  // Moves report the messages' new UIDs (UIDPLUS COPYUID) so the renderer can offer "Undo".
  const movedUids = (res) => (res?.uidMap instanceof Map && res.uidMap.size ? [...res.uidMap.values()] : null);

  handle('mail:move', (accountId, folder, uids, toFolder) => {
    const list = uidList(uids).join(',');
    if (!toFolder || String(toFolder) === String(folder)) throw err('Choose another folder.', 'EINVAL');
    return withImap(accountId, (client) =>
      withMailbox(client, String(folder), async () => {
        const res = must(client, await client.messageMove(list, String(toFolder), { uid: true }));
        return { folder: String(toFolder), uids: movedUids(res) };
      }),
    );
  });

  handle('mail:archive', (accountId, folder, uids) => {
    const list = uidList(uids).join(',');
    return withImap(accountId, async (client) => {
      const archive = await ensureSpecial(accountId, client, 'archive');
      if (archive === folder) throw err('These messages are already archived.', 'EINVAL');
      const res = await withMailbox(client, String(folder), async () => must(client, await client.messageMove(list, archive, { uid: true })));
      return { folder: archive, uids: movedUids(res) };
    });
  });

  handle('mail:delete', (accountId, folder, uids) => {
    const list = uidList(uids).join(',');
    return withImap(accountId, async (client) => {
      const sp = await specialFolders(accountId, client);
      const trash = sp.trash;
      const permanent = !trash || trash === folder;
      let res = null;
      await withMailbox(client, String(folder), async () => {
        if (permanent) must(client, await client.messageDelete(list, { uid: true }));
        else res = must(client, await client.messageMove(list, trash, { uid: true }));
      });
      return { permanent, trash: trash || null, folder: permanent ? null : trash, uids: permanent ? null : movedUids(res) };
    });
  });

  handle('mail:emptyFolder', (accountId, folder) =>
    withImap(accountId, (client) =>
      withMailbox(client, String(folder), async (mb) => {
        if (mb.exists) must(client, await client.messageDelete('1:*'));
        return true;
      }),
    ),
  );

  handle('mail:markAllRead', (accountId, folder) =>
    withImap(accountId, (client) =>
      withMailbox(client, String(folder), async (mb) => {
        if (mb.exists) must(client, await client.messageFlagsAdd('1:*', ['\\Seen']));
        return true;
      }),
    ),
  );

  // Private scratch folder (forwarded attachments, files to open): ~/.cache/aurora/mail/tmp-*
  handle('mail:tempDir', async () => {
    const base = path.join(HOME, '.cache', 'aurora', 'mail');
    await fsp.mkdir(base, { recursive: true, mode: 0o700 });
    return fsp.mkdtemp(path.join(base, 'tmp-'));
  });

  handle('mail:send', (accountId, msg) => sendMessage(accountId, msg || {}));
  handle('mail:saveDraft', (accountId, msg, opts) => saveDraft(accountId, msg || {}, opts || {}));

  handle('mail:source', (accountId, folder, uid) =>
    withImap(accountId, (client) =>
      withMailbox(client, String(folder), async () => {
        const m = await client.fetchOne(String(Number(uid)), { uid: true, source: true }, { uid: true });
        if (!m?.source) throw err('This message no longer exists.', 'ENOMSG');
        return m.source.subarray(0, 4 * 1024 * 1024).toString('utf8');
      }),
    ),
  );

  handle('mail:saveSource', async (accountId, folder, uid, dest) => {
    if (!dest || !path.isAbsolute(String(dest))) throw err('Invalid destination.', 'EINVAL');
    const src = await withImap(accountId, (client) =>
      withMailbox(client, String(folder), async () => {
        const m = await client.fetchOne(String(Number(uid)), { uid: true, source: true }, { uid: true });
        if (!m?.source) throw err('This message no longer exists.', 'ENOMSG');
        return m.source;
      }),
    );
    await fsp.writeFile(String(dest), src);
    return String(dest);
  });

  handle('mail:watch', async (on) => {
    watching = !!on;
    await syncWatchers();
    return watching;
  });
  handle('mail:status', () => Object.fromEntries(statuses));

  // Remove scratch folders left by earlier sessions (older than a day).
  setTimeout(async () => {
    const base = path.join(HOME, '.cache', 'aurora', 'mail');
    try {
      for (const name of await fsp.readdir(base)) {
        if (!name.startsWith('tmp-')) continue;
        const p = path.join(base, name);
        const st = await fsp.stat(p);
        if (Date.now() - st.mtimeMs > 86400000) await fsp.rm(p, { recursive: true, force: true });
      }
    } catch {}
  }, 30000).unref?.();

  app.on('before-quit', () => {
    watching = false;
    for (const w of watchers.values()) w.stop();
    watchers.clear();
    for (const p of pools.values()) p.drop();
  });
};

// Exposed for unit tests (node test runner without Electron).
module.exports.__test = { classify, presetForEmail, normalizeCfg, htmlToPreview, cleanPreview, decodeBody, previewPart, hasAttachments, addrList, safeFileName, isLoopback };
