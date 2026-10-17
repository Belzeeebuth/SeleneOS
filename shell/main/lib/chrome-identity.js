'use strict';
// What the Navigateur says it is: exactly what a stable Google Chrome on Linux sends, for the Chromium version
// Electron ships (pure functions, unit-tested in test/browser-identity.unit.mjs).
//
// Electron alone gives itself away: its user agent carries « Electron/x » and the app name, navigator.userAgentData
// lists « Chromium » without « Google Chrome », and it never sends the Sec-CH-UA request headers (Electron has no
// client hints delegate), so a « Chrome/152 » user agent arrives without the hints every real Chrome sends. Google's
// sign-in page treats that as an embedded browser (« Ce navigateur ou cette application ne sont peut-être pas
// sécurisés »). main/ipc/browser.js applies these values to every browser session: the UA string, the request headers
// (low-entropy hints on every secure request, high-entropy ones once the site asked with Accept-CH, like Chrome) and,
// through the DevTools protocol, navigator.userAgentData / getHighEntropyValues in pages, frames and workers.
const os = require('os');

const GREASE_CHARS = [' ', '(', ':', '-', '.', '/', ')', ';', '=', '?', '_'];
const GREASE_VERSIONS = ['8', '99', '24'];
// Chromium's brand order for 3 brands (components/embedder_support/user_agent_utils.cc), indexed by major % 6.
const ORDER = [
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0],
];
// Client hints Chrome sends without being asked (on secure requests) and those a site must ask for (Accept-CH).
const LOW = ['sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform'];
const HIGH = ['sec-ch-ua-arch', 'sec-ch-ua-bitness', 'sec-ch-ua-full-version', 'sec-ch-ua-full-version-list', 'sec-ch-ua-model', 'sec-ch-ua-platform-version', 'sec-ch-ua-wow64', 'sec-ch-ua-form-factors'];

function chromeVersion(v = process.versions.chrome) {
  return /^\d+(\.\d+){3}$/.test(String(v || '')) ? String(v) : '146.0.0.0';
}
const majorOf = (full) => Number(String(full).split('.')[0]) || 146;

/** Chromium's GREASE brand for a major version (e.g. 152 -> « Not?A_Brand » v24). */
function greaseBrand(major) {
  const n = GREASE_CHARS.length;
  return { brand: `Not${GREASE_CHARS[major % n]}A${GREASE_CHARS[(major + 1) % n]}Brand`, version: GREASE_VERSIONS[major % GREASE_VERSIONS.length] };
}

/** Brand list in Chrome's order: { brand, version } with major versions, or full versions when full is true. */
function brands(full = false, chrome = chromeVersion()) {
  const major = majorOf(chrome);
  const g = greaseBrand(major);
  const list = [];
  const o = ORDER[major % 6];
  list[o[0]] = { brand: g.brand, version: full ? `${g.version}.0.0.0` : g.version };
  list[o[1]] = { brand: 'Chromium', version: full ? chrome : String(major) };
  list[o[2]] = { brand: 'Google Chrome', version: full ? chrome : String(major) };
  return list;
}

function arch() {
  return /^arm/.test(process.arch) ? 'arm' : 'x86';
}

/** The reduced user agent string Chrome sends on Linux. */
function userAgent(chrome = chromeVersion()) {
  const plat = process.arch === 'arm64' ? 'X11; Linux aarch64' : 'X11; Linux x86_64';
  return `Mozilla/5.0 (${plat}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${majorOf(chrome)}.0.0.0 Safari/537.36`;
}

/** navigator.platform in Chrome on Linux. */
function navigatorPlatform() {
  return process.arch === 'arm64' ? 'Linux aarch64' : 'Linux x86_64';
}

function platformVersion(release = os.release()) {
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(release || ''));
  return m ? `${m[1]}.${m[2]}.${m[3] || 0}` : '';
}

/** userAgentMetadata for the DevTools protocol (Emulation.setUserAgentOverride). */
function metadata(chrome = chromeVersion()) {
  return {
    brands: brands(false, chrome),
    fullVersionList: brands(true, chrome),
    fullVersion: chrome,
    platform: 'Linux',
    platformVersion: platformVersion(),
    architecture: arch(),
    model: '',
    mobile: false,
    bitness: '64',
    wow64: false,
    formFactors: ['Desktop'],
  };
}

const quote = (s) => `"${String(s).replace(/["\\]/g, '')}"`;
const brandHeader = (list) => list.map((b) => `${quote(b.brand)};v=${quote(b.version)}`).join(', ');

/** Header values for every hint Chrome knows (lower-case names). */
function hintValues(chrome = chromeVersion()) {
  const md = metadata(chrome);
  return {
    'sec-ch-ua': brandHeader(md.brands),
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': quote(md.platform),
    'sec-ch-ua-arch': quote(md.architecture),
    'sec-ch-ua-bitness': quote(md.bitness),
    'sec-ch-ua-full-version': quote(chrome),
    'sec-ch-ua-full-version-list': brandHeader(md.fullVersionList),
    'sec-ch-ua-model': quote(''),
    'sec-ch-ua-platform-version': quote(md.platformVersion),
    'sec-ch-ua-wow64': '?0',
    'sec-ch-ua-form-factors': quote('Desktop'),
  };
}

/** The hints named in an Accept-CH / Critical-CH header value (only the UA ones we send). */
function parseHintList(value) {
  const out = new Set();
  for (const v of [].concat(value || [])) {
    for (const part of String(v).split(',')) {
      const name = part.trim().toLowerCase();
      if (HIGH.includes(name) || LOW.includes(name)) out.add(name);
    }
  }
  return out;
}

/** Chrome sends client hints on secure requests only (https, wss, and localhost / loopback over http). */
function isSecureUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:' || u.protocol === 'wss:') return true;
    if (u.protocol !== 'http:' && u.protocol !== 'ws:') return false;
    const h = u.hostname.replace(/^\[|\]$/g, '');
    return h === 'localhost' || h.endsWith('.localhost') || /^127\./.test(h) || h === '::1';
  } catch {
    return false;
  }
}

/**
 * Request headers with the UA client hints a stable Chrome would send: the low-entropy ones always (secure requests),
 * the high-entropy ones the origin asked for. Any hint Chromium added itself is replaced, so the brands always match.
 */
function withHints(headers, url, askedFor = new Set(), chrome = chromeVersion()) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) if (!/^sec-ch-ua(-|$)/i.test(k)) out[k] = v;
  if (!isSecureUrl(url)) return out;
  const vals = hintValues(chrome);
  for (const k of LOW) out[k] = vals[k];
  for (const k of askedFor) if (HIGH.includes(k)) out[k] = vals[k];
  return out;
}

/** Accept-Language for the session's language (Electron adds the q-values itself: plain list). */
function acceptLanguages(lang) {
  return lang === 'fr' ? 'fr-FR,fr,en-US,en' : 'en-US,en';
}

module.exports = { LOW, HIGH, chromeVersion, greaseBrand, brands, userAgent, navigatorPlatform, platformVersion, metadata, hintValues, parseHintList, isSecureUrl, withHints, acceptLanguages };
