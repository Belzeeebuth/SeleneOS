'use strict';
// FreeRDP 3 (xfreerdp3, package freerdp3-x11) for the Remote Desktop app's RDP connections: pure helpers used by
// main/ipc/remote.js (argument lines, option validation, exit code / log classification). No RDP code here: FreeRDP
// is a normal X11 client and its window becomes a Selene window through aurora-xwm (docs/XWINDOWS.md).
//
// Secrets never reach the command line: FreeRDP is started as `xfreerdp3 /args-from:stdin` and reads every argument
// (one per line, ended by an empty line) from its stdin, which it then closes. /proc/<pid>/cmdline shows only that.
// Certificates: `/cert:deny` always (FreeRDP never waits for an answer on its stdin); a certificate the person accepted
// in Selene's own dialog is passed as `fingerprint:sha256:<hex>` (FreeRDP accepts exactly that certificate).
const path = require('path');
const fs = require('fs');

const WM_CLASS = 'selene-app-remote'; // main/ipc/xapps.js maps it to the built-in app 'remote' (taskbar icon, grouping)
const SIZES = ['1024x768', '1280x720', '1280x800', '1366x768', '1600x900', '1920x1080', '2560x1440'];

const clean = (s, max) =>
  String(s ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .slice(0, max);

/** Options kept with a saved connection (anything else is dropped). */
function cleanOptions(o = {}) {
  o = o && typeof o === 'object' ? o : {};
  return {
    display: ['fit', 'fullscreen', 'fixed'].includes(o.display) ? o.display : 'fit',
    size: SIZES.includes(o.size) ? o.size : '1920x1080',
    multimon: !!o.multimon,
    clipboard: o.clipboard !== false,
    audio: o.audio !== false,
    drive: typeof o.drive === 'string' && o.drive ? o.drive : null,
  };
}

/** Problem with a shared folder path, or null when it can be used. */
function driveProblem(p) {
  if (typeof p !== 'string' || !path.isAbsolute(p) || p.length > 1024) return 'EINVAL';
  if (/[,\n\r\0]/.test(p)) return 'EDRIVECHARS'; // FreeRDP splits /drive:<name>,<path> on commas
  try {
    if (!fs.statSync(p).isDirectory()) return 'ENOTDIR';
  } catch {
    return 'ENOENT';
  }
  return null;
}

/**
 * Argument lines for `xfreerdp3 /args-from:stdin` (without the program name).
 * c: { host, kind ('ipv4'|'ipv6'|'hostname'), port, user, domain, password, title, options, fingerprint, screen: { width, height } }
 */
function buildArgs(c) {
  const o = cleanOptions(c.options);
  const host = c.kind === 'ipv6' ? `[${c.host}]` : c.host;
  const args = [`/v:${host}:${c.port}`];
  if (c.user) args.push(`/u:${clean(c.user, 256)}`);
  if (c.domain) args.push(`/d:${clean(c.domain, 256)}`);
  if (c.password) args.push(`/p:${clean(c.password, 512)}`);
  args.push(`/t:${clean(c.title || c.host, 120)}`, `/wm-class:${WM_CLASS}`);
  args.push(c.fingerprint ? `/cert:deny,fingerprint:sha256:${c.fingerprint}` : '/cert:deny');
  const sw = Math.max(640, Math.min(8192, Math.round(Number(c.screen?.width) || 1600)));
  const sh = Math.max(480, Math.min(8192, Math.round(Number(c.screen?.height) || 900)));
  if (o.display === 'fullscreen') {
    args.push('/f', '/floatbar:sticky:off,default:visible,show:fullscreen');
    if (o.multimon) args.push('/multimon');
  } else if (o.display === 'fixed') args.push(`/size:${o.size}`, '/smart-sizing');
  else args.push(`/size:${Math.round(sw * 0.8) & ~1}x${Math.round(sh * 0.8) & ~1}`, '/dynamic-resolution');
  args.push(o.clipboard ? '+clipboard' : '-clipboard');
  args.push(o.audio ? '/sound' : '/audio-mode:2');
  if (o.drive && !driveProblem(o.drive)) {
    const name = path.basename(o.drive).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || 'Selene';
    args.push(`/drive:${name},${o.drive}`);
  }
  args.push('/auto-reconnect');
  return args;
}

/** What stdin receives: one argument per line, then an empty line (FreeRDP stops reading there). */
const stdinText = (args) => `${args.join('\n')}\n\n`;

/** sha256 fingerprint FreeRDP printed for a certificate it refused (hex, no colons), or null. */
function fingerprintFromLog(log) {
  const m = /fingerprint for the host key sent by the remote host is ([0-9a-fA-F:]{64,95})/.exec(log || '');
  return m ? m[1].replace(/:/g, '').toLowerCase() : null;
}

/**
 * Plain-language class of a finished FreeRDP run: { code, ended } — ended = normal end of a session (no error).
 * Codes: ECERTNEW, ECERTCHANGED, EAUTH, ENEEDCRED (NLA: sign in first), EPWEXPIRED, ELOCKED, EDENIED, ENOTFOUND,
 * EUNREACHABLE (refused / timed out / no route), ETLS, ENEGO, EBOOTING, ELICENSE, ELOGOFF, EREPLACED, EIDLE, EFAIL.
 */
function classifyExit(code, signal, log = '', { stopped = false } = {}) {
  const L = String(log);
  if (stopped) return { code: null, ended: true };
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|NEW HOST IDENTIFICATION|Host key verification failed/.test(L)) {
    // FreeRDP prints the "changed" banner for a certificate it has never seen and the reverse (its messages are swapped)
    return { code: /New host key for/.test(L) ? 'ECERTCHANGED' : 'ECERTNEW', ended: false, fingerprint: fingerprintFromLog(L) };
  }
  const has = (re) => re.test(L);
  if (has(/ERRCONNECT_DNS_NAME_NOT_FOUND|ERRCONNECT_DNS_ERROR|getaddrinfo|Name or service not known/)) return { code: 'ENOTFOUND' };
  if (has(/ERRCONNECT_PASSWORD_EXPIRED|ERRCONNECT_PASSWORD_MUST_CHANGE|PASSWORD_CERTAINLY_EXPIRED/)) return { code: 'EPWEXPIRED' };
  if (has(/ERRCONNECT_ACCOUNT_LOCKED_OUT|ERRCONNECT_ACCOUNT_DISABLED|ERRCONNECT_ACCOUNT_EXPIRED/)) return { code: 'ELOCKED' };
  if (has(/HYBRID_REQUIRED_BY_SERVER|ERRCONNECT_NO_OR_MISSING_CREDENTIALS/)) return { code: 'ENEEDCRED' };
  if (has(/ERRCONNECT_LOGON_FAILURE|ERRCONNECT_WRONG_PASSWORD|ERRCONNECT_AUTHENTICATION_FAILED|STATUS_LOGON_FAILURE|SEC_E_LOGON_DENIED/)) return { code: 'EAUTH' };
  if (has(/ERRCONNECT_ACCESS_DENIED|ERRCONNECT_LOGON_TYPE_NOT_GRANTED|ERRCONNECT_ACCOUNT_RESTRICTION|INSUFFICIENT_PRIVILEGES/)) return { code: 'EDENIED' };
  if (has(/ERRCONNECT_CONNECT_FAILED|ERRCONNECT_CONNECT_TRANSPORT_FAILED|Connection refused|No route to host|timed out|Network is unreachable/)) return { code: 'EUNREACHABLE' };
  switch (code) {
    case 0:
    case 1:
    case 11:
    case 12:
      return { code: null, ended: true };
    case 2:
      return { code: 'ELOGOFF', ended: true };
    case 3:
    case 4:
      return { code: 'EIDLE', ended: true };
    case 5:
      return { code: 'EREPLACED', ended: true };
    case 7:
    case 9:
    case 144:
    case 155:
    case 156:
    case 158:
      return { code: 'EDENIED' };
    case 132:
    case 134:
    case 154:
      return { code: 'EAUTH' };
    case 133:
      return { code: 'ENEGO' };
    case 135:
    case 151:
    case 157:
      return { code: 'ELOCKED' };
    case 139:
    case 140:
      return { code: 'ENOTFOUND' };
    case 131:
    case 141:
    case 147:
      return { code: 'EUNREACHABLE' };
    case 143:
      return { code: 'ETLS' };
    case 148:
    case 149:
    case 152:
      return { code: 'EPWEXPIRED' };
    case 159:
    case 161:
      return { code: 'ENEEDCRED' };
    case 160:
      return { code: 'EBOOTING' };
    default:
      if (code >= 16 && code <= 26) return { code: 'ELICENSE' };
      if (signal) return { code: 'EFAIL' };
      return { code: 'EFAIL' };
  }
}

module.exports = { WM_CLASS, SIZES, cleanOptions, driveProblem, buildArgs, stdinText, fingerprintFromLog, classifyExit };
