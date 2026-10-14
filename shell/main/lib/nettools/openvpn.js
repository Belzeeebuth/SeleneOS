'use strict';
// OpenVPN helpers for main/ipc/nettools.js (Outils réseau): .ovpn parsing, the private copy imported into
// NetworkManager, nmcli value escaping and `vpn.data` parsing. Pure functions (unit-tested in
// test/nettools-extra.test.mjs) plus prepareCopy() (writes under ~/.local/share/aurora/nettools/openvpn).
//
// NetworkManager-openvpn notes (1.10.2 in noble, properties/import-export.c):
//   * `nmcli connection import type openvpn file X.ovpn` names the connection after X, resolves relative file
//     references against the .ovpn's folder, writes inline <ca>/<cert>/<key>/… blobs to ~/.cert/nm-openvpn/,
//     and sets password-flags=1 (agent-owned) for auth-user-pass and cert-pass-flags=1 for an encrypted key.
//   * nmcli's own secret agent (passwd-file / --ask) only answers secrets whose flags are agent-owned (1) or
//     not-saved (2) (libnmc-base/nm-secret-agent-simple.c add_vpn_secret_helper), so a password kept by
//     NetworkManager (flags 0) is written with `nmcli connection edit` (commands on stdin), never on argv.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_OVPN = 256 * 1024; // inline certificates make profiles a few KB; 256 KB is plenty
const MAX_REF = 1024 * 1024; // one referenced certificate / key file
const MAX_COPY = 4 * 1024 * 1024; // all referenced files together

// Directives whose first argument is a file (or "[inline]"). auth-user-pass / askpass take an optional file.
const FILE_DIRECTIVES = ['ca', 'cert', 'key', 'pkcs12', 'tls-auth', 'tls-crypt', 'tls-crypt-v2', 'secret', 'extra-certs', 'crl-verify', 'dh'];
const OPTIONAL_FILE_DIRECTIVES = ['auth-user-pass', 'askpass'];

/** OpenVPN config tokenizer: whitespace separated, "double" (with \ escapes) and 'single' quotes. */
function tokenize(line) {
  const out = [];
  let cur = '';
  let has = false;
  let q = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q === '"') {
      if (c === '\\' && i + 1 < line.length) cur += line[++i];
      else if (c === '"') q = null;
      else cur += c;
    } else if (q === "'") {
      if (c === "'") q = null;
      else cur += c;
    } else if (c === '"' || c === "'") {
      q = c;
      has = true;
    } else if (/\s/.test(c)) {
      if (has || cur) out.push(cur);
      cur = '';
      has = false;
    } else if (c === '\\' && i + 1 < line.length) {
      cur += line[++i];
      has = true;
    } else {
      cur += c;
      has = true;
    }
  }
  if (has || cur) out.push(cur);
  return out;
}

/** Quote one argument for an .ovpn line (only when needed). */
function quoteArg(s) {
  const v = String(s);
  return /^[^\s"'\\#;]+$/.test(v) ? v : `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

const isEncryptedPem = (text) => /-----BEGIN ENCRYPTED PRIVATE KEY-----|Proc-Type:\s*4,ENCRYPTED/.test(String(text || ''));

/**
 * Parse an .ovpn profile. `dir` resolves relative file references; `readFile(abs)` (optional) returns the
 * referenced file's text (for the encrypted-key check and auth-user-pass) or null.
 * -> { ok, problem?, remotes: [{ host, port, proto }], client, dev, auth: 'password'|'password-tls'|'tls'|'static-key',
 *      needsAuth, needsKeyPass, inline: [tag], files: [{ directive, arg, path, line }], authFile, lines }
 */
function parseOvpn(text, dir, readFile = () => null) {
  const src = String(text || '');
  const lines = src.split(/\r?\n/);
  const remotes = [];
  const inline = [];
  const inlineText = {};
  const files = [];
  let client = false;
  let port = 1194;
  let proto = 'udp';
  let dev = 'tun';
  let needsAuth = false;
  let askpass = false;
  let authFile = null;
  const seen = new Set();
  let block = null;
  let blockBody = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (block) {
      if (trimmed.toLowerCase() === `</${block}>`) {
        inline.push(block);
        inlineText[block] = blockBody.join('\n');
        seen.add(block);
        block = null;
        blockBody = [];
      } else blockBody.push(raw);
      continue;
    }
    if (!trimmed || trimmed[0] === '#' || trimmed[0] === ';') continue;
    const open = /^<([a-z0-9-]+)>$/i.exec(trimmed);
    if (open) {
      block = open[1].toLowerCase();
      continue;
    }
    const tok = tokenize(trimmed);
    if (!tok.length) continue;
    const d = tok[0].replace(/^--/, '').toLowerCase();
    const args = tok.slice(1);
    switch (d) {
      case 'client':
      case 'tls-client':
      case 'pull':
        client = true;
        break;
      case 'remote':
        if (args[0]) remotes.push({ host: args[0], port: args[1] && /^\d+$/.test(args[1]) ? Number(args[1]) : null, proto: args[2] || null });
        break;
      case 'port':
      case 'rport':
        if (/^\d+$/.test(args[0] || '')) port = Number(args[0]);
        break;
      case 'proto':
        if (args[0]) proto = args[0].toLowerCase();
        break;
      case 'dev':
        if (args[0]) dev = args[0];
        break;
      default:
        break;
    }
    if (OPTIONAL_FILE_DIRECTIVES.includes(d)) {
      if (d === 'auth-user-pass') needsAuth = true;
      if (d === 'askpass') askpass = true;
      if (args[0] && args[0] !== '[inline]') {
        const abs = path.isAbsolute(args[0]) ? args[0] : path.join(dir || '.', args[0]);
        files.push({ directive: d, arg: args[0], path: abs, line: i, optional: true });
        if (d === 'auth-user-pass') authFile = abs;
      }
      continue;
    }
    if (FILE_DIRECTIVES.includes(d)) {
      seen.add(d);
      if (args[0] && args[0] !== '[inline]') {
        const abs = path.isAbsolute(args[0]) ? args[0] : path.join(dir || '.', args[0]);
        files.push({ directive: d, arg: args[0], path: abs, line: i });
      }
    }
  }
  if (inline.includes('auth-user-pass')) needsAuth = true;
  for (const r of remotes) {
    if (r.port == null) r.port = port;
    r.proto = (r.proto || proto || 'udp').toLowerCase().replace(/-client$/, '');
  }
  const hasCert = seen.has('cert') || seen.has('pkcs12');
  let auth;
  if (needsAuth) auth = hasCert ? 'password-tls' : 'password';
  else if (hasCert) auth = 'tls';
  else if (seen.has('secret')) auth = 'static-key';
  else auth = 'tls';
  // Encrypted private key (or PKCS#12, normally protected): NetworkManager then asks for a « cert-pass ».
  let keyText = inlineText.key || null;
  const keyRef = files.find((f) => f.directive === 'key');
  if (!keyText && keyRef) keyText = readFile(keyRef.path);
  const needsKeyPass = askpass || isEncryptedPem(keyText) || seen.has('pkcs12');
  let problem = null;
  if (/\0/.test(src)) problem = 'binary';
  else if (block) problem = 'unclosed';
  else if (!remotes.length) problem = 'noRemote';
  else if (!client && !seen.has('secret')) problem = 'notClient';
  else if (client && !seen.has('pkcs12') && !seen.has('ca')) problem = 'noCa';
  return { ok: !problem, problem, remotes, client, dev, proto, auth, needsAuth, needsKeyPass, inline, files, authFile, lines };
}

/** First two lines of an auth-user-pass file -> { username, password } (either may be ''). */
function parseAuthFile(text) {
  const [u = '', p = ''] = String(text || '').split(/\r?\n/);
  return { username: u.trim().slice(0, 256), password: p.replace(/\r$/, '').slice(0, 1024) };
}

/** A safe connection / file name: no '/', no control characters, at most 64 characters. */
function cleanName(name) {
  const s = String(name || '')
    .replace(/[\u0000-\u001f\u007f/\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 64)
    .trim();
  return s || 'VPN';
}

/**
 * Copy the profile and the files it references into a private folder (0700, files 0600) so the imported
 * connection keeps working when the download folder is cleaned up. Every file reference is rewritten to the
 * copied file's absolute path; auth-user-pass / askpass lose their file argument (NetworkManager asks for the
 * credentials itself). -> { dir, file }
 */
function prepareCopy(info, name, baseDir) {
  fs.mkdirSync(baseDir, { recursive: true, mode: 0o700 });
  const slug = cleanName(name).replace(/[^a-zA-Z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'vpn';
  const dir = path.join(baseDir, `${slug}-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(dir, { mode: 0o700 });
  const lines = info.lines.slice();
  const used = new Set();
  let total = 0;
  try {
    for (const f of info.files) {
      if (f.optional) {
        lines[f.line] = f.directive;
        continue;
      }
      const st = fs.statSync(f.path);
      total += st.size;
      if (!st.isFile() || st.size > MAX_REF || total > MAX_COPY) throw Object.assign(new Error(`${f.arg}: ${st.isFile() ? 'too large' : 'not a regular file'}`), { code: 'EINVAL' });
      let base = path.basename(f.path).replace(/[^a-zA-Z0-9_.-]+/g, '_') || 'file';
      if (base.startsWith('.')) base = `_${base}`;
      let n = 1;
      const stem = base;
      while (used.has(base) || base === `${cleanName(name)}.ovpn`) base = `${n++}-${stem}`;
      used.add(base);
      const dest = path.join(dir, base);
      fs.writeFileSync(dest, fs.readFileSync(f.path), { mode: 0o600, flag: 'wx' });
      const tok = tokenize(lines[f.line].trim());
      lines[f.line] = [tok[0], dest, ...tok.slice(2)].map(quoteArg).join(' ');
    }
    const file = path.join(dir, `${cleanName(name)}.ovpn`);
    fs.writeFileSync(file, lines.join('\n'), { mode: 0o600, flag: 'wx' });
    return { dir, file };
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}

/** vpn.data { ca: '/…/openvpn/work-1a2b/ca.crt', … } -> private copy folders (direct children of baseDir) it uses. */
function copyDirsIn(data, baseDir) {
  const out = new Set();
  const root = path.resolve(baseDir) + path.sep;
  for (const v of Object.values(data || {})) {
    if (typeof v !== 'string' || !path.isAbsolute(v)) continue;
    const abs = path.resolve(v);
    if (!abs.startsWith(root)) continue;
    const first = abs.slice(root.length).split(path.sep)[0];
    if (first && first !== '.' && first !== '..' && /^[a-zA-Z0-9_.-]+-[0-9a-f]{8}$/.test(first)) out.add(path.join(root, first));
  }
  return [...out];
}

// ---------------------------------------------------------------- nmcli escaping
/**
 * Escape a value for nmcli's option lists (vpn.data / vpn.secrets: "key=value, key2=value2"), the inverse of
 * nm_utils_escaped_tokens_options_split(): backslash before '\', ',', '=' and white space.
 */
function nmOptEscape(v) {
  return String(v).replace(/[\\,=\s]/g, (c) => `\\${c}`);
}

/** Split nmcli's printed option list (`ca = /x, remote = a\, b`) -> { key: value }. */
function parseVpnData(text) {
  const out = {};
  const s = String(text || '').trim();
  if (!s || s === '--') return out;
  const parts = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) {
      cur += c + s[++i];
    } else if (c === ',') {
      parts.push(cur);
      cur = '';
    } else cur += c;
  }
  parts.push(cur);
  for (const p of parts) {
    let key = '';
    let val = null;
    let buf = '';
    for (let i = 0; i < p.length; i++) {
      const c = p[i];
      if (c === '\\' && i + 1 < p.length) buf += p[++i];
      else if (c === '=' && val === null) {
        key = buf.trim();
        buf = '';
        val = '';
      } else buf += c;
    }
    if (val === null) continue;
    if (key) out[key] = buf.trim();
  }
  return out;
}

/** Escape a secret for an nmcli passwd-file line (nm_utils_buf_utf8safe_unescape): '\' doubled, white space octal. */
function passwdFileEscape(v) {
  return String(v).replace(/[\\\s]/g, (c) => (c === '\\' ? '\\\\' : `\\${c.charCodeAt(0).toString(8).padStart(3, '0')}`));
}

/** A credential field: a string without control characters (newlines would end an nmcli line). */
function validSecret(v, max = 1024) {
  return typeof v === 'string' && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
}

/**
 * `nmcli -e no -t -f vpn.service-type,vpn.data connection show uuid U` -> details.
 * { service, remote, username, auth, passwordFlags, certPassFlags, passwordSaved, needsPassword, keyPass: 'none'|'saved'|'ask' }
 */
function parseVpnDetails(text) {
  const fields = {};
  for (const line of String(text || '').split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) fields[line.slice(0, i).trim()] = line.slice(i + 1);
  }
  const st = String(fields['vpn.service-type'] || '').trim();
  const service = st.replace(/^org\.freedesktop\.NetworkManager\./, '') || '';
  const data = parseVpnData(fields['vpn.data'] || '');
  const auth = data['connection-type'] || '';
  const withPass = auth === 'password' || auth === 'password-tls';
  const pf = data['password-flags'] != null ? Number(data['password-flags']) : 0;
  const cf = data['cert-pass-flags'] != null ? Number(data['cert-pass-flags']) : null;
  const remote = String(data.remote || '')
    .split(/\s*,\s*/)
    .filter(Boolean)
    .map((r) => r.split(':')[0])[0] || '';
  return {
    service,
    remote,
    username: data.username || '',
    auth,
    passwordFlags: withPass ? pf : null,
    certPassFlags: cf,
    passwordSaved: withPass && pf === 0,
    needsPassword: withPass && !(pf & 4) && pf !== 0,
    keyPass: cf == null || cf & 4 ? 'none' : cf === 0 ? 'saved' : 'ask',
  };
}

/** Classify an nmcli error message for the UI. */
function classifyNmError(msg) {
  const m = String(msg || '');
  if (/failed to find VPN plugin|failed to load VPN plugin|unknown VPN plugin|Missing client plugin|cannot load (?:legacy-only )?VPN plugin/i.test(m)) return 'ENOPLUGIN';
  if (/Invalid secrets|login failed|AUTH_FAILED/i.test(m)) return 'EAUTH';
  if (/No valid secrets|secrets were required|not given in 'passwd-file'|no secrets|No agents were available/i.test(m)) return 'ENEEDAUTH';
  if (/failed to import|wasn.t a valid OpenVPN|invalid passwd-file/i.test(m)) return 'EBADFILE';
  if (/timed out|timeout/i.test(m)) return 'ETIMEDOUT';
  return 'ECMD';
}

module.exports = {
  MAX_OVPN,
  tokenize,
  quoteArg,
  parseOvpn,
  parseAuthFile,
  cleanName,
  prepareCopy,
  copyDirsIn,
  nmOptEscape,
  parseVpnData,
  passwdFileEscape,
  validSecret,
  parseVpnDetails,
  classifyNmError,
  isEncryptedPem,
};
