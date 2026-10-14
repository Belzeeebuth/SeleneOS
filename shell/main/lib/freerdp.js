'use strict';
// FreeRDP 3 (xfreerdp3, package freerdp3-x11 in noble) for the Remote Desktop app's RDP connections: pure helpers used
// by main/ipc/remote.js (argument lines, option validation, exit code / log classification). No RDP code here: FreeRDP
// is a normal X11 client and its window becomes a Selene window through aurora-xwm (docs/XWINDOWS.md).
//
// Secrets never reach the command line: FreeRDP is started as `xfreerdp3 /args-from:stdin` (FreeRDP >= 3.0: with that
// single argument, client/common/cmdline.c reads one argument per line from stdin, stops at the first empty line and
// closes stdin). /proc/<pid>/cmdline shows only `/args-from:stdin`; the password is in one of the stdin lines (/p:…).
// A value holding a line break would start another argument: such values are refused (validText), never cleaned.
//
// Certificates: always `/cert:deny`, so FreeRDP never waits for an answer on its (closed) stdin. An unknown certificate
// makes it log "The fingerprint for the host key sent by the remote host is aa:bb:…" (sha256) and stop; Selene shows
// that fingerprint in its own dialog and, when the person trusts it, connects again with
// `/cert:deny,fingerprint:sha256:<hex>`: FreeRDP then accepts exactly that certificate (tls.c is_accepted_fingerprint)
// and still refuses any other one. FreeRDP's own banners are swapped (3.5 → 3.32): the "REMOTE HOST IDENTIFICATION HAS
// CHANGED" text is printed for a certificate it has never seen, "New host key for" when its own store
// (~/.config/freerdp/server) holds a different one.
//
// Exit codes: client/X11/xfreerdp.h `enum XF_EXIT_CODE` (same values in 3.5.0 and 3.32.0).
const path = require('path');
const fs = require('fs');

// WM_CLASS class of the session window (FreeRDP sets res_name "xfreerdp", res_class from /wm-class). The app registers
// a transient taskbar entry 'x11:selene-remote' (core/features/xwin.js naming) with its own name and icon.
const WM_CLASS = 'selene-remote';
const SIZES = ['1024x768', '1280x720', '1280x800', '1366x768', '1600x900', '1920x1080', '2560x1440'];

/** The string when it has no control character (line breaks included) and fits max, else null. */
function validText(s, max) {
  if (typeof s !== 'string' || s.length > max) return null;
  return /[\u0000-\u001f\u007f]/.test(s) ? null : s;
}
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
    drive: typeof o.drive === 'string' && o.drive ? o.drive.slice(0, 1024) : null,
  };
}

/** Problem with a shared folder path (code), or null when it can be used. */
function driveProblem(p) {
  if (typeof p !== 'string' || !path.isAbsolute(p) || p.length > 1024) return 'EINVAL';
  if (/[,\u0000-\u001f\u007f]/.test(p)) return 'EDRIVECHARS'; // FreeRDP splits /drive:<name>,<path> on commas
  try {
    if (!fs.statSync(p).isDirectory()) return 'ENOTDIR';
  } catch {
    return 'ENOENT';
  }
  return null;
}

/** Name of the shared drive as Windows shows it ("Selene" when the folder name has no usable character). */
const driveName = (p) =>
  path
    .basename(p)
    .replace(/[^A-Za-z0-9_-]/g, '')
    .slice(0, 24) || 'Selene';

/**
 * Argument lines for `xfreerdp3 /args-from:stdin` (without the program name). Values must be validated before
 * (main/ipc/remote.js); clean() is only a last guard so that no line break can ever reach stdin.
 * c: { host, kind ('ipv4'|'ipv6'|'hostname'), port, user, domain, password, title, options, fingerprint (hex),
 *      screen: { width, height } (device px of the work area) }
 */
function buildArgs(c) {
  const o = cleanOptions(c.options);
  const host = c.kind === 'ipv6' ? `[${c.host}]` : c.host;
  const args = [`/v:${host}:${c.port}`];
  if (c.user) args.push(`/u:${clean(c.user, 256)}`);
  if (c.domain) args.push(`/d:${clean(c.domain, 256)}`);
  if (c.password) args.push(`/p:${clean(c.password, 512)}`);
  args.push(`/t:${clean(c.title || c.host, 120)}`, `/wm-class:${WM_CLASS}`);
  const fp = typeof c.fingerprint === 'string' && /^[0-9a-f]{64}$/.test(c.fingerprint) ? c.fingerprint : null;
  args.push(fp ? `/cert:deny,fingerprint:sha256:${fp}` : '/cert:deny');
  const sw = Math.max(640, Math.min(8192, Math.round(Number(c.screen?.width) || 1600)));
  const sh = Math.max(480, Math.min(8192, Math.round(Number(c.screen?.height) || 900)));
  if (o.display === 'fullscreen') {
    args.push('/f', '/floatbar:sticky:off,default:visible,show:fullscreen');
    if (o.multimon) args.push('/multimon');
  } else {
    if (o.display === 'fixed') args.push(`/size:${o.size}`, '/smart-sizing');
    // fit: start at 85 % of the work area; /dynamic-resolution follows the Selene frame when it is resized or maximised
    else args.push(`/size:${Math.round(sw * 0.85) & ~1}x${Math.round(sh * 0.85) & ~1}`, '/dynamic-resolution');
    // in a window, Selene's own shortcuts (Super, Alt+Tab: aurora-xwm's grabs) keep working; full screen sends them
    // to the remote computer, like other RDP clients (FreeRDP's floating bar leaves full screen)
    args.push('-grab-keyboard');
  }
  args.push(o.clipboard ? '+clipboard' : '-clipboard');
  args.push(o.audio ? '/sound' : '/audio-mode:2'); // 2 = no sound at all (1 would play it on the remote computer)
  if (o.drive && !driveProblem(o.drive)) args.push(`/drive:${driveName(o.drive)},${o.drive}`);
  args.push('+auto-reconnect');
  return args;
}

/** What stdin receives: one argument per line, then an empty line (FreeRDP stops reading there). */
const stdinText = (args) => `${args.join('\n')}\n\n`;

/** sha256 fingerprint FreeRDP printed for a certificate it refused (hex, no colons), or null. */
function fingerprintFromLog(log) {
  const m = /fingerprint for the host key sent by the remote host is ((?:[0-9a-fA-F]{2}:){31}[0-9a-fA-F]{2}|[0-9a-fA-F]{64})\b/.exec(log || '');
  return m ? m[1].replace(/:/g, '').toLowerCase() : null;
}

const NORMAL_END = new Map([
  [0, null],
  [1, null], // the server ended the session
  [2, 'ELOGOFF'],
  [3, 'EIDLE'],
  [4, 'EIDLE'],
  [5, 'EREPLACED'],
  [11, null], // closed by the person (window closed)
  [12, null],
]);
const BY_CODE = {
  7: 'EDENIED',
  8: 'EDENIED',
  9: 'EDENIED',
  10: 'ENEEDCRED',
  131: 'EUNREACHABLE',
  132: 'EAUTH',
  133: 'ENEGO',
  134: 'EAUTH',
  135: 'ELOCKED',
  139: 'ENOTFOUND',
  140: 'ENOTFOUND',
  141: 'EUNREACHABLE',
  143: 'ETLS',
  144: 'EDENIED',
  145: 'ENEEDCRED', // FreeRDP asked for credentials on its closed stdin: nothing was given
  147: 'EUNREACHABLE',
  148: 'EPWEXPIRED',
  149: 'EPWEXPIRED',
  150: 'EUNREACHABLE', // Kerberos KDC unreachable
  151: 'ELOCKED',
  152: 'EPWEXPIRED',
  153: 'ELOCKED',
  154: 'EAUTH',
  155: 'EDENIED',
  156: 'EDENIED',
  157: 'ELOCKED',
  158: 'EDENIED',
  159: 'ENEEDCRED',
  160: 'EBOOTING',
  161: 'ENEEDCRED',
};

/**
 * Plain-language class of a finished FreeRDP run: { code, ended, fingerprint?, freerdpChanged? }.
 *   ended: the session ended without an error worth an alert (code may still say why: ELOGOFF, EIDLE, EREPLACED).
 * Codes: ECERTNEW, ECERTCHANGED, EAUTH, ENEEDCRED (sign-in information missing: NLA), EPWEXPIRED, ELOCKED, EDENIED,
 * ENOTFOUND, EUNREACHABLE (refused / timed out / no route), ETLS, ENEGO, EBOOTING, ELICENSE, ELOGOFF, EIDLE, EREPLACED,
 * EARGS (FreeRDP refused an option), EFAIL. The log is only read for runs that did not end normally, so warnings
 * printed during a long session never turn a normal end into an error.
 */
function classifyExit(code, signal, log = '', { stopped = false } = {}) {
  if (stopped) return { code: null, ended: true };
  if (NORMAL_END.has(code)) return { code: NORMAL_END.get(code), ended: true };
  const L = String(log);
  const fingerprint = fingerprintFromLog(L);
  if (fingerprint || /Host key verification failed|New host key for/.test(L)) {
    return { code: /New host key for/.test(L) ? 'ECERTCHANGED' : 'ECERTNEW', ended: false, fingerprint, freerdpChanged: /New host key for/.test(L) };
  }
  const has = (re) => re.test(L);
  if (has(/ERRCONNECT_DNS_NAME_NOT_FOUND|ERRCONNECT_DNS_ERROR|Name or service not known|getaddrinfo/)) return { code: 'ENOTFOUND', ended: false };
  if (has(/ERRCONNECT_PASSWORD_EXPIRED|ERRCONNECT_PASSWORD_MUST_CHANGE|ERRCONNECT_PASSWORD_CERTAINLY_EXPIRED/)) return { code: 'EPWEXPIRED', ended: false };
  if (has(/ERRCONNECT_ACCOUNT_LOCKED_OUT|ERRCONNECT_ACCOUNT_DISABLED|ERRCONNECT_ACCOUNT_EXPIRED|ERRCONNECT_CLIENT_REVOKED/)) return { code: 'ELOCKED', ended: false };
  if (has(/ERRCONNECT_LOGON_FAILURE|ERRCONNECT_WRONG_PASSWORD|ERRCONNECT_AUTHENTICATION_FAILED|STATUS_LOGON_FAILURE|SEC_E_LOGON_DENIED/)) return { code: 'EAUTH', ended: false };
  if (has(/HYBRID_REQUIRED_BY_SERVER|ERRCONNECT_NO_OR_MISSING_CREDENTIALS|ERRCONNECT_CONNECT_CANCELLED/)) return { code: 'ENEEDCRED', ended: false };
  if (has(/ERRCONNECT_ACCESS_DENIED|ERRCONNECT_LOGON_TYPE_NOT_GRANTED|ERRCONNECT_ACCOUNT_RESTRICTION|ERRCONNECT_INSUFFICIENT_PRIVILEGES|ERRINFO_SERVER_INSUFFICIENT_PRIVILEGES/)) return { code: 'EDENIED', ended: false };
  if (has(/ERRCONNECT_CONNECT_FAILED|ERRCONNECT_CONNECT_TRANSPORT_FAILED|Connection refused|No route to host|Network is unreachable|[Cc]onnection timed out/)) return { code: 'EUNREACHABLE', ended: false };
  if (code in BY_CODE) return { code: BY_CODE[code], ended: false };
  if (code >= 16 && code <= 26) return { code: 'ELICENSE', ended: false };
  if (code === 128) return { code: 'EARGS', ended: false };
  return { code: 'EFAIL', ended: false, signal: signal || null };
}

/** The last error lines of a FreeRDP log, for a "details" view: no password, no colour codes, at most 1500 chars. */
function logExcerpt(log, secrets = []) {
  let s = String(log || '').replace(/\u001b\[[0-9;]*m/g, '');
  for (const p of secrets) if (p) s = s.split(p).join('••••');
  const lines = s.split('\n').filter((l) => /ERROR|WARN|ERRCONNECT|ERRINFO|failed|refused/i.test(l));
  return lines.slice(-12).join('\n').slice(-1500);
}

module.exports = { WM_CLASS, SIZES, validText, cleanOptions, driveProblem, driveName, buildArgs, stdinText, fingerprintFromLog, classifyExit, logExcerpt };
