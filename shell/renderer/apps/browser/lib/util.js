// Aurora Browser — pure helpers: omnibox input classification, search engines, URL display,
// network error mapping. No DOM, no shell state.

export const ENGINES = {
  duckduckgo: { name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=%s', home: 'https://duckduckgo.com/' },
  google: { name: 'Google', url: 'https://www.google.com/search?q=%s', home: 'https://www.google.com/' },
  bing: { name: 'Bing', url: 'https://www.bing.com/search?q=%s', home: 'https://www.bing.com/' },
  qwant: { name: 'Qwant', url: 'https://www.qwant.com/?q=%s', home: 'https://www.qwant.com/' },
  ecosia: { name: 'Ecosia', url: 'https://www.ecosia.org/search?q=%s', home: 'https://www.ecosia.org/' },
  startpage: { name: 'Startpage', url: 'https://www.startpage.com/sp/search?query=%s', home: 'https://www.startpage.com/' },
};

export function engineOf(id) {
  return ENGINES[id] || ENGINES.duckduckgo;
}

export function searchUrl(engineId, q) {
  return engineOf(engineId).url.replace('%s', encodeURIComponent(q).replace(/%20/g, '+'));
}

// Internal pages (rendered by the app, not by a webview).
export const ROUTES = ['newtab', 'history', 'favorites', 'downloads', 'settings', 'about'];
const ALIASES = { bookmarks: 'favorites', home: 'newtab', 'new-tab': 'newtab', version: 'about', help: 'about', preferences: 'settings' };

export function parseInternal(url) {
  const m = /^(?:aurora|edge|chrome):\/\/([a-z-]+)\/?([^?#]*)(?:\?([^#]*))?/i.exec(String(url || '').trim());
  if (!m) return null;
  let route = m[1].toLowerCase();
  route = ALIASES[route] || route;
  const query = Object.fromEntries(new URLSearchParams(m[3] || ''));
  return { route: ROUTES.includes(route) ? route : 'notfound', sub: m[2] || '', query, raw: route };
}

export function internalUrl(route, query) {
  const q = query && Object.keys(query).length ? `?${new URLSearchParams(query)}` : '';
  return `aurora://${route}${q}`;
}

export function isInternal(url) {
  return /^aurora:\/\//i.test(String(url || ''));
}

// Two-letter country-code TLDs and the generic TLDs people actually type. A dotted word whose
// last label is not in here ("node.js", "index.html") is treated as a search, like Chrome does.
const CC =
  'ac ad ae af ag ai al am ao aq ar as at au aw ax az ba bb bd be bf bg bh bi bj bm bn bo br bs bt bw by bz ca cc cd cf cg ch ci ck cl cm cn co cr cu cv cw cx cy cz de dj dk dm do dz ec ee eg er es et eu fi fj fk fm fo fr ga gd ge gf gg gh gi gl gm gn gp gq gr gs gt gu gw gy hk hm hn hr ht hu id ie il im in io iq ir is it je jm jo jp ke kg kh ki km kn kp kr kw ky kz la lb lc li lk lr ls lt lu lv ly ma mc md me mg mh mk ml mm mn mo mp mq mr ms mt mu mv mw mx my mz na nc ne nf ng ni nl no np nr nu nz om pa pe pf pg ph pk pl pm pn pr ps pt pw py qa re ro rs ru rw sa sb sc sd se sg sh si sk sl sm sn so sr ss st su sv sx sy sz tc td tf tg th tj tk tl tm tn to tr tt tv tw tz ua ug uk us uy uz va vc ve vg vi vn vu wf ws ye yt za zm zw';
const GENERIC =
  'com net org info biz edu gov mil int arpa name pro aero asia cat coop jobs mobi museum post tel travel xxx io ai app dev page blog shop store online site tech website space cloud digital email live news world today life art design studio media agency network systems solutions services company group global software codes tools zone wiki guru ninja social chat link click top xyz club fun icu vip win bid one best plus pub run land city center church community foundation fund gallery games game help host hosting how inc law legal ltd market money moe nyc paris berlin london tokyo photo photos pics pizza place press red blue green pink black rocks school science show ski sport stream style team tips tours town toys university video watch work works yoga academy bar beer box build business buzz cafe camera capital care cash chat codes consulting cool day dog download earth eco education energy estate events exchange expert family fashion film finance fit fitness florist food football forsale free garden gift gold golf graphics guide health healthcare holiday house immo jetzt kim kitchen lgbt lol love map marketing mba men menu mom movie music ngo now observer ong ooo org party pet phd poker porn quest radio recipes rent repair report rest review reviews rip sale salon sex shopping sexy software solar stream study surf swiss tax taxi technology tennis theater tickets tube vegas vin vision vote voyage wang wtf zero mozilla google microsoft apple amazon goog ubuntu local lan internal home localdomain test example invalid onion intranet corp';
const TLDS = new Set(`${CC} ${GENERIC}`.split(/\s+/));

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

/**
 * Decide what an omnibox entry means.
 *   -> { type: 'url', url } | { type: 'internal', url, route, query } | { type: 'search', query, url }
 *      | { type: 'blocked', url } | { type: 'external', url }
 */
export function classify(text, engineId) {
  const s = String(text || '').trim();
  if (!s) return null;
  const search = () => ({ type: 'search', query: s, url: searchUrl(engineId, s) });
  if (/^(aurora|edge|chrome):\/\//i.test(s)) {
    const p = parseInternal(s);
    if (p && (p.route !== 'notfound' || /^aurora:/i.test(s))) return { type: 'internal', url: internalUrl(p.route === 'notfound' ? p.raw : p.route, p.query), ...p };
    return { type: 'blocked', url: s };
  }
  const about = /^about:([a-z-]+)$/i.exec(s);
  if (about) {
    const r = about[1].toLowerCase();
    if (r === 'blank') return { type: 'url', url: 'about:blank' };
    const p = parseInternal(`aurora://${r}`);
    if (p.route !== 'notfound') return { type: 'internal', url: internalUrl(p.route), ...p };
    return { type: 'blocked', url: s };
  }
  if (/^javascript:/i.test(s)) return search();
  if (/^view-source:/i.test(s)) {
    const inner = s.slice(12).trim();
    const c = classify(inner, engineId);
    if (c?.type === 'url' && /^https?:/i.test(c.url)) return { type: 'url', url: `view-source:${c.url}` };
    return search();
  }
  if (/^(file|app|media|chrome-extension|devtools|chrome-untrusted|blob):/i.test(s)) return { type: 'blocked', url: s };
  if (/^(mailto|tel|sms|callto|magnet|irc|ircs|xmpp|sip|webcal|geo|news):/i.test(s)) return { type: 'external', url: s };
  if (/^(https?|ftp):\/\//i.test(s)) {
    try {
      const u = new URL(s);
      if (!u.hostname) return search();
      return { type: 'url', url: u.href };
    } catch {
      return search();
    }
  }
  if (/^data:/i.test(s)) return { type: 'url', url: s };
  if (/\s/.test(s)) return search();
  const m = /^([^/?#:@]+|\[[0-9a-f:.]+\])(:\d{1,5})?([/?#].*)?$/i.exec(s);
  if (!m) return search();
  const host = m[1].toLowerCase();
  const hasPath = !!m[3];
  const hasPort = !!m[2];
  const toUrl = (scheme) => {
    try {
      return { type: 'url', url: new URL(`${scheme}://${s}`).href };
    } catch {
      return search();
    }
  };
  if (host === 'localhost' || host.endsWith('.localhost')) return toUrl('http');
  if (IPV4.test(host) || host.startsWith('[')) return toUrl('http');
  if (host.includes('.')) {
    if (/^\.|\.\.|\.$/.test(host) || !/^[\p{L}\p{N}.-]+$/u.test(host)) return search();
    const tld = host.split('.').pop();
    if (/^\d+$/.test(tld)) return search(); // "3.14"
    if (TLDS.has(tld) || /^xn--[a-z0-9-]+$/.test(tld) || hasPort || (hasPath && m[3].startsWith('/'))) return toUrl('https');
    return search();
  }
  // Single word: only a URL with an explicit port or a trailing path ("intranet/", "nas:5000").
  if ((hasPort || (hasPath && m[3].startsWith('/'))) && /^[\p{L}\p{N}-]+$/u.test(host)) return toUrl('http');
  return search();
}

export function hostOf(url) {
  try {
    const u = new URL(url);
    return u.hostname || '';
  } catch {
    return '';
  }
}

export function originOf(url) {
  try {
    const u = new URL(url);
    return u.origin === 'null' ? '' : u.origin;
  } catch {
    return '';
  }
}

/** "www.example.com" -> "example.com" */
export function bareHost(url) {
  return hostOf(url).replace(/^www\./, '');
}

export function isWebUrl(url) {
  return /^(https?|ftp):\/\//i.test(String(url || ''));
}

/** Human readable URL (percent-decoded where safe). */
export function displayUrl(url) {
  if (!url) return '';
  if (url === 'about:blank') return url;
  try {
    return decodeURI(url);
  } catch {
    return url;
  }
}

/** Split a URL for the Edge-style omnibox display: dim scheme/path, strong host. */
export function urlParts(url) {
  const d = displayUrl(url);
  const m = /^([a-z][a-z0-9+.-]*:(?:\/\/)?)([^/?#]*)(.*)$/i.exec(d);
  if (!m || !/^(https?|ftp|aurora):/i.test(d)) return { pre: '', host: d, post: '' };
  return { pre: m[1], host: m[2], post: m[3] };
}

/** Text the user is most likely to have typed for this URL ("wikipedia.org/wiki/X"). */
export function typedForm(url) {
  return displayUrl(url)
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '');
}

export function titleFor(url) {
  const host = bareHost(url);
  return host || url;
}

/** Short site label for tiles: "Wikipedia, the free encyclopedia" -> keeps it, "Home | GitHub" -> "GitHub". */
export function siteLabel(title, url) {
  const t = String(title || '').trim();
  if (!t) {
    const h = bareHost(url).split('.');
    const name = h.length > 1 ? h[h.length - 2] : h[0] || url;
    return name.charAt(0).toUpperCase() + name.slice(1);
  }
  const parts = t.split(/\s[|–—·-]\s/).map((x) => x.trim()).filter(Boolean);
  if (parts.length > 1) {
    const shortest = parts.reduce((a, b) => (b.length < a.length ? b : a));
    if (shortest.length >= 3) return shortest;
  }
  return t;
}

// Chromium net error codes -> message key + whether it is a certificate problem.
const NET = {
  '-2': 'FAILED',
  '-6': 'FILE_NOT_FOUND',
  '-7': 'TIMED_OUT',
  '-10': 'ACCESS_DENIED',
  '-20': 'BLOCKED_BY_CLIENT',
  '-21': 'NETWORK_CHANGED',
  '-27': 'BLOCKED_BY_RESPONSE',
  '-100': 'CONNECTION_CLOSED',
  '-101': 'CONNECTION_RESET',
  '-102': 'CONNECTION_REFUSED',
  '-103': 'CONNECTION_ABORTED',
  '-104': 'CONNECTION_FAILED',
  '-105': 'NAME_NOT_RESOLVED',
  '-106': 'INTERNET_DISCONNECTED',
  '-107': 'SSL_PROTOCOL_ERROR',
  '-108': 'ADDRESS_INVALID',
  '-109': 'ADDRESS_UNREACHABLE',
  '-111': 'TUNNEL_CONNECTION_FAILED',
  '-113': 'SSL_VERSION_OR_CIPHER_MISMATCH',
  '-118': 'CONNECTION_TIMED_OUT',
  '-130': 'PROXY_CONNECTION_FAILED',
  '-137': 'NAME_RESOLUTION_FAILED',
  '-138': 'NETWORK_ACCESS_DENIED',
  '-200': 'CERT_COMMON_NAME_INVALID',
  '-201': 'CERT_DATE_INVALID',
  '-202': 'CERT_AUTHORITY_INVALID',
  '-203': 'CERT_CONTAINS_ERRORS',
  '-204': 'CERT_NO_REVOCATION_MECHANISM',
  '-206': 'CERT_REVOKED',
  '-207': 'CERT_INVALID',
  '-208': 'CERT_WEAK_SIGNATURE_ALGORITHM',
  '-210': 'CERT_NON_UNIQUE_NAME',
  '-211': 'CERT_WEAK_KEY',
  '-212': 'CERT_NAME_CONSTRAINT_VIOLATION',
  '-213': 'CERT_VALIDITY_TOO_LONG',
  '-300': 'INVALID_URL',
  '-301': 'DISALLOWED_URL_SCHEME',
  '-302': 'UNKNOWN_URL_SCHEME',
  '-310': 'TOO_MANY_REDIRECTS',
  '-312': 'UNSAFE_PORT',
  '-320': 'INVALID_RESPONSE',
  '-324': 'EMPTY_RESPONSE',
  '-501': 'INSECURE_RESPONSE',
};

export function netError(code, desc) {
  const name = NET[String(code)] || String(desc || '').replace(/^ERR_/, '') || 'FAILED';
  const cert = Number(code) <= -200 && Number(code) > -300;
  let kind = 'generic';
  if (cert) kind = 'cert';
  else if (['NAME_NOT_RESOLVED', 'NAME_RESOLUTION_FAILED'].includes(name)) kind = 'dns';
  else if (['CONNECTION_REFUSED', 'CONNECTION_FAILED', 'ADDRESS_UNREACHABLE', 'CONNECTION_RESET', 'CONNECTION_CLOSED', 'EMPTY_RESPONSE'].includes(name)) kind = 'refused';
  else if (['INTERNET_DISCONNECTED', 'NETWORK_CHANGED', 'NETWORK_ACCESS_DENIED'].includes(name)) kind = 'offline';
  else if (['TIMED_OUT', 'CONNECTION_TIMED_OUT'].includes(name)) kind = 'timeout';
  else if (['TUNNEL_CONNECTION_FAILED', 'PROXY_CONNECTION_FAILED'].includes(name)) kind = 'proxy';
  else if (['TOO_MANY_REDIRECTS'].includes(name)) kind = 'redirects';
  else if (['BLOCKED_BY_CLIENT', 'BLOCKED_BY_RESPONSE', 'UNSAFE_PORT', 'DISALLOWED_URL_SCHEME', 'UNKNOWN_URL_SCHEME', 'ACCESS_DENIED'].includes(name)) kind = 'blocked';
  return { code: Number(code), name: `ERR_${name}`, kind, cert };
}

export function debounce(fn, ms) {
  let t = null;
  const d = (...a) => {
    clearTimeout(t);
    t = setTimeout(() => {
      t = null;
      fn(...a);
    }, ms);
  };
  d.flush = (...a) => {
    if (t) {
      clearTimeout(t);
      t = null;
      fn(...a);
    }
  };
  d.cancel = () => clearTimeout(t);
  return d;
}

export function uid(prefix = 'n') {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/** Stable pastel-ish color for a monogram tile. */
export function colorFor(str) {
  let h = 0;
  for (const c of String(str || '')) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const hues = [210, 4, 145, 265, 30, 190, 330, 95, 240, 15];
  return `hsl(${hues[h % hues.length]}, 55%, 46%)`;
}

export function monogram(title, url) {
  const s = (bareHost(url) || title || '?').replace(/^www\./, '');
  return (s.match(/[\p{L}\p{N}]/u)?.[0] || '?').toUpperCase();
}

/** Simple, fast fuzzy-ish match score for omnibox suggestions (0 = no match). */
export function matchScore(entry, terms) {
  if (!terms.length) return 0;
  const title = String(entry.title || '').toLowerCase();
  const url = String(entry.url || '').toLowerCase();
  const typed = typedForm(url).toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (typed.startsWith(term)) score += 40;
    else if (bareHost(url).split('.').some((p) => p.startsWith(term))) score += 25;
    else if (title.split(/[^\p{L}\p{N}]+/u).some((w) => w.startsWith(term))) score += 15;
    else if (url.includes(term) || title.includes(term)) score += 5;
    else return 0;
  }
  return score;
}

export const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];

export function nextZoom(current, dir) {
  const c = Math.round(current * 100) / 100;
  if (dir > 0) return ZOOM_STEPS.find((z) => z > c + 0.001) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1];
  return [...ZOOM_STEPS].reverse().find((z) => z < c - 0.001) ?? ZOOM_STEPS[0];
}

/** Normalise a DOM KeyboardEvent to the combo strings the backend sends ("Ctrl+Shift+T"). */
export function comboFromEvent(e) {
  const parts = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (e.metaKey) parts.push('Super');
  let key = e.key;
  if (['Control', 'Alt', 'Shift', 'Meta', 'OS'].includes(key)) return '';
  if (e.ctrlKey && (key === '=' || key === '+' || e.code === 'NumpadAdd')) return 'Ctrl+Plus';
  if (e.ctrlKey && (key === '-' || key === '_' || e.code === 'NumpadSubtract')) return 'Ctrl+Minus';
  if (e.ctrlKey && (key === '0' || e.code === 'Numpad0') && !e.shiftKey && !e.altKey) return 'Ctrl+0';
  if (/^Digit\d$/.test(e.code) && e.ctrlKey) key = e.code.slice(5);
  if (key === ' ') key = 'Space';
  if (key === 'Esc') key = 'Escape';
  if (key && key.length === 1) key = key.toUpperCase();
  return [...parts, key].join('+');
}
