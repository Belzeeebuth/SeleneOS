// EPUB fixtures for test/books.test.mjs, written from scratch (no external tool): a tiny ZIP writer (stored +
// deflate, zlib), a PNG encoder and the books themselves.
//
//   writeBookFixtures(dir, { port }) -> { voyage, classique, garden, added, drm, broken, notzip, badentry, deep }
//
//   voyage.epub     EPUB 3 (fr): nav.xhtml with a nested table of contents (+ landmarks), cover image, PNG and
//                   SVG figures, footnote (same chapter) and endnote (other chapter), cross-chapter link,
//                   external link, an embedded font obfuscated with the IDPF algorithm (META-INF/encryption.xml),
//                   long chapters (several pages), the word « astrolabe » 3 times in chapter 2 and once in
//                   chapter 3, and a hostile last chapter (« Annexe ») : <script>, onerror= / onload= /
//                   onclick=, javascript: links, a remote <img src="https://…">, local-server URLs (port) in
//                   img / srcset / CSS url() / @import / <link> / <iframe> / <object> / <embed> / <video
//                   poster> / <audio> / SVG <image> / meta refresh / <base> / <form>, an SVG <script>.
//                   Two hostile ZIP entry names (../evil.txt, /abs.txt) that the reader must ignore.
//   classique.epub  EPUB 2 (fr): toc.ncx (nested), <meta name="cover">, opf:role / opf:file-as, XHTML 1.1
//                   DOCTYPE with named entities, one chapter in ISO-8859-1.
//   garden.epub     EPUB 3 (en), small, cover.
//   added.epub      EPUB 3 (en), small, no cover (generated cover in the library).
//   drm.epub        content documents listed as AES-encrypted in META-INF/encryption.xml (+ rights.xml).
//   broken.epub     a valid book cut in half (no central directory).
//   notzip.epub     plain text.
//   badentry.epub   valid container, one chapter whose CRC is wrong (damaged chapter, the book still opens).
//   rtl.epub        right-to-left book (Arabic, page-progression-direction="rtl", dir="rtl").
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHELL = path.join(HERE, '..', '..', '..');

// ---------------------------------------------------------------- ZIP writer
/** files: [{ name, data, store, crc, usize }] -> Buffer (crc / usize override the real values: damaged files) */
export function zip(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, f.encoding || 'utf8');
    const name = Buffer.from(f.name, 'utf8');
    const method = f.store ? 0 : 8;
    const comp = method ? zlib.deflateRawSync(data) : data;
    const crc = (f.crc ?? zlib.crc32(data)) >>> 0;
    const usize = f.usize ?? data.length;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x800, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(0, 10);
    lh.writeUInt16LE(0x21, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(usize, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    parts.push(lh, name, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x800, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(0x21, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(usize, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, eocd]);
}

// ---------------------------------------------------------------- PNG encoder (RGB, 8 bits)
export function png(w, h, pixel) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const [r, g, b] = pixel(x, y);
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** A cover: vertical gradient between two colours, a light band (title area) and a "moon". */
function coverPng(top, bottom, w = 300, h = 450) {
  return png(w, h, (x, y) => {
    const t = y / h;
    let c = top.map((v, i) => Math.round(v + (bottom[i] - v) * t));
    if (y > h * 0.18 && y < h * 0.34) c = c.map((v) => Math.round(v * 0.55 + 255 * 0.45));
    const dx = x - w * 0.5;
    const dy = y - h * 0.62;
    if (dx * dx + dy * dy < (w * 0.18) ** 2) c = [240, 236, 220];
    return c;
  });
}

// ---------------------------------------------------------------- text
const WORDS = 'la lune éclaire le port pendant que les marins préparent la grande traversée vers les îles lointaines où personne ne revient jamais sans une histoire nouvelle à raconter aux enfants du village et aux voyageurs fatigués qui attendent le matin près du feu en écoutant le vent du large chanter dans les voiles'.split(' ');
const WORDS_EN = 'the night garden opens slowly under a silver sky while the old gardener walks between the quiet rows of flowers listening to the small sounds of the world asleep and dreaming of the morning light'.split(' ');
function para(seed, n = 60, words = WORDS) {
  let s = seed * 7919 + 13;
  const out = [];
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) % 2147483648;
    out.push(words[s % words.length]);
  }
  const t = out.join(' ');
  return `${t[0].toUpperCase()}${t.slice(1)}.`;
}
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const XHTML = (title, body, { lang = 'fr', head = '', epub = true } = {}) =>
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml"${epub ? ' xmlns:epub="http://www.idpf.org/2007/ops"' : ''} xml:lang="${lang}" lang="${lang}">
<head><meta charset="UTF-8"/><title>${esc(title)}</title><link rel="stylesheet" type="text/css" href="../styles/book.css"/>${head}</head>
<body>
${body}
</body>
</html>
`;

const container = (opf) => `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="${opf}" media-type="application/oebps-package+xml"/></rootfiles>
</container>
`;

function epubZip(files, extra = []) {
  return zip([{ name: 'mimetype', data: 'application/epub+zip', store: true }, ...Object.entries(files).map(([name, data]) => (data && typeof data === 'object' && !Buffer.isBuffer(data) ? { name, ...data } : { name, data })), ...extra]);
}

// ---------------------------------------------------------------- voyage.epub (EPUB 3)
export const VOYAGE_UID = 'urn:uuid:0f6c2c3a-8a8e-4f43-9c55-2f2a6b1e7d10';
function obfuscateIdpf(data, uid) {
  const key = crypto.createHash('sha1').update(uid.replace(/[ \u0009\u000d\u000a]/g, ''), 'utf8').digest();
  const out = Buffer.from(data);
  for (let i = 0; i < Math.min(out.length, 1040); i++) out[i] ^= key[i % key.length];
  return out;
}

function voyage(port) {
  const P = (i, extra = '') => `<p>${extra}${para(i)}</p>`;
  const ch1 = XHTML(
    'Chapitre 1',
    `<section epub:type="chapter"><h1 id="ch1-title">Chapitre 1 — Le départ</h1>
${P(100, '<span class="lettrine">L</span>')}
<p>Le capitaine montra la carte<a epub:type="noteref" href="#fn1" id="r1">1</a> puis la note de fin<a epub:type="noteref" href="notes.xhtml#n2" id="r2">2</a>. Plus loin, <a href="ch3.xhtml#arrivee-port" id="xref">voir le port d'arrivée</a> et le <a href="https://example.org/selene" id="extlink">site du livre</a>.</p>
<aside epub:type="footnote" id="fn1"><p>Note de bas de page : l'aube se lève sur la mer.</p></aside>
<div class="figure"><img src="../images/fig1.png" alt="Figure 1 : la baie" id="fig1"/><p class="caption">Figure 1 : la baie.</p></div>
${Array.from({ length: 34 }, (_, i) => P(101 + i)).join('\n')}
</section>`,
  );
  const ch2Paras = Array.from({ length: 44 }, (_, i) => {
    if (i === 5) return `<p>Elle sortit de son sac un vieil astrolabe de cuivre. ${para(205)}</p>`;
    if (i === 20) return `<h2 id="section-2">Une section</h2><p>Le second astrolabe était plus petit. ${para(220)}</p>`;
    if (i === 35) return `<p>Le troisième <em>astro</em>labe, brisé, dormait au fond de la cale. ${para(235)}</p>`;
    return P(200 + i);
  });
  const ch2 = XHTML(
    'Chapitre 2',
    `<section epub:type="chapter"><h1>Chapitre 2 — L'astrolabe</h1>
<p class="fancy" id="fancy">Une ligne dans la police du livre.</p>
<svg xmlns="http://www.w3.org/2000/svg" width="200" height="80" viewBox="0 0 200 80" id="inline-svg"><rect x="2" y="2" width="196" height="76" fill="none" stroke="currentColor"/><circle cx="40" cy="40" r="22" fill="currentColor"/><text x="80" y="46" font-size="16" fill="currentColor">SVG</text></svg>
<p><img src="../images/diagram.svg" alt="Schéma" id="diagram" style="width:120px"/></p>
${ch2Paras.join('\n')}
</section>`,
  );
  const ch3 = XHTML(
    'Chapitre 3',
    `<section epub:type="chapter"><h1>Chapitre 3 — La traversée</h1>
${Array.from({ length: 22 }, (_, i) => P(300 + i)).join('\n')}
<h2 id="arrivee-port">Le port d'arrivée</h2>
<p>On dit que l'astrolabe guide les marins perdus. ${para(399)}</p>
${Array.from({ length: 6 }, (_, i) => P(330 + i)).join('\n')}
</section>`,
  );
  const ch4 = XHTML('Chapitre 4', `<section epub:type="chapter"><h1>Chapitre 4 — L'arrivée</h1>\n${Array.from({ length: 5 }, (_, i) => P(400 + i)).join('\n')}\n<p id="the-end">Fin.</p></section>`);
  const notes = XHTML('Notes', `<section epub:type="endnotes"><h1>Notes</h1><ol><li id="n1"><p>Première note.</p></li><li id="n2"><p>Note de fin : la carte des étoiles.</p></li></ol></section>`);
  const cover = XHTML('Couverture', `<div class="cover"><img src="../images/cover.png" alt="Le Voyage de Sélène"/></div>`);
  const S = `http://127.0.0.1:${port}`;
  const hostile = XHTML(
    'Annexe',
    `<h1 onclick="parent.__booksPwned = 'onclick'">Annexe</h1>
<script>parent.__booksPwned = 'script'; top.__booksPwned = 'script';</script>
<script src="${S}/hostile-script.js"></script>
<p id="hostile-marker">Hostile chapter marker.</p>
<img src="https://evil.invalid/remote.png" alt="remote" id="remote-img"/>
<img src="${S}/img-src.png" srcset="${S}/img-srcset.png 2x" alt="local server"/>
<img src="no-such-image.png" onerror="parent.__booksPwned = 'onerror'" alt="broken"/>
<p style="background-image: url('${S}/inline-style.png'); color: red" id="styled">Styled paragraph.</p>
<style>@import url("${S}/import.css"); .bg { background: url(${S}/style-bg.png); } @font-face { font-family: Evil; src: url(${S}/font.woff2); }</style>
<link rel="stylesheet" href="${S}/link.css"/>
<p><a href="javascript:parent.__booksPwned='javascript-link'" id="jslink">javascript link</a> <a href="JaVaScRiPt:parent.__booksPwned='js2'" id="jslink2">second</a> <a href="${S}/clicked-link" id="netlink">network link</a></p>
<iframe src="${S}/iframe.html"></iframe>
<iframe srcdoc="&lt;script&gt;parent.parent.__booksPwned='srcdoc'&lt;/script&gt;"></iframe>
<object data="${S}/object.swf"></object>
<embed src="${S}/embed.swf"/>
<video poster="${S}/poster.png" src="${S}/video.mp4" autoplay="autoplay"></video>
<audio src="${S}/audio.mp3" autoplay="autoplay"></audio>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="50" height="50"><script>parent.__booksPwned = 'svg-script';</script><image xlink:href="${S}/svg-image.png" width="50" height="50"/><a xlink:href="javascript:parent.__booksPwned='svg-link'"><rect width="10" height="10"/></a></svg>
<meta http-equiv="refresh" content="0;url=${S}/refresh"/>
<base href="${S}/"/>
<form action="${S}/form" method="get"><input name="q" value="x" autofocus="autofocus"/><button type="submit" id="formbtn">Envoyer</button></form>
<div class="bg" onmouseover="parent.__booksPwned = 'mouseover'" data-books-href="javascript:parent.__booksPwned='spoof'">Background div.</div>
<p data-books-url="javascript:alert(1)">Spoofed attribute.</p>`,
    { head: `<script>parent.__booksPwned = 'head-script';</script><meta http-equiv="refresh" content="0;url=${S}/head-refresh"/><link rel="stylesheet" href="${S}/head-link.css"/><base href="${S}/base/"/>` },
  );
  const nav = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="fr">
<head><title>Sommaire</title></head>
<body>
<nav epub:type="landmarks"><ol><li><a epub:type="bodymatter" href="text/ch1.xhtml">Début</a></li></ol></nav>
<nav epub:type="toc" id="toc"><h1>Sommaire</h1>
<ol>
  <li><a href="text/cover.xhtml">Couverture</a></li>
  <li><a href="text/ch1.xhtml">Première partie</a>
    <ol>
      <li><a href="text/ch1.xhtml#ch1-title">Chapitre 1 — Le départ</a></li>
      <li><a href="text/ch2.xhtml">Chapitre 2 — L'astrolabe</a>
        <ol><li><a href="text/ch2.xhtml#section-2">Une section</a></li></ol>
      </li>
    </ol>
  </li>
  <li><span>Deuxième partie</span>
    <ol>
      <li><a href="text/ch3.xhtml">Chapitre 3 — La traversée</a></li>
      <li><a href="text/ch4.xhtml">Chapitre 4 — L'arrivée</a></li>
    </ol>
  </li>
  <li><a href="text/notes.xhtml">Notes</a></li>
  <li><a href="text/hostile.xhtml">Annexe</a></li>
</ol>
</nav>
</body>
</html>
`;
  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid" xml:lang="fr">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">${VOYAGE_UID}</dc:identifier>
    <dc:title id="t1">Le Voyage de Sélène</dc:title>
    <meta refines="#t1" property="title-type">main</meta>
    <dc:creator id="c1">Jeanne Martin</dc:creator>
    <meta refines="#c1" property="role" scheme="marc:relators">aut</meta>
    <meta refines="#c1" property="file-as">Martin, Jeanne</meta>
    <dc:creator id="c2">Paul Illustrateur</dc:creator>
    <meta refines="#c2" property="role" scheme="marc:relators">ill</meta>
    <dc:language>fr</dc:language>
    <dc:publisher>Éditions de la Lune</dc:publisher>
    <dc:date>2026-03-01</dc:date>
    <dc:description>&lt;p&gt;Un voyage &lt;b&gt;au long cours&lt;/b&gt; vers les îles.&lt;/p&gt;</dc:description>
    <meta property="belongs-to-collection" id="coll">Les Récits de la Lune</meta>
    <meta refines="#coll" property="group-position">2</meta>
    <meta property="dcterms:modified">2026-03-01T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="cover-img" href="images/cover.png" media-type="image/png" properties="cover-image"/>
    <item id="cover" href="text/cover.xhtml" media-type="application/xhtml+xml"/>
    <item id="css" href="styles/book.css" media-type="text/css"/>
    <item id="font" href="fonts/book.woff2" media-type="font/woff2"/>
    <item id="fig1" href="images/fig1.png" media-type="image/png"/>
    <item id="diagram" href="images/diagram.svg" media-type="image/svg+xml"/>
    <item id="ch1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch3" href="text/ch3.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch4" href="text/ch4.xhtml" media-type="application/xhtml+xml"/>
    <item id="notes" href="text/notes.xhtml" media-type="application/xhtml+xml"/>
    <item id="hostile" href="text/hostile.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="cover"/>
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
    <itemref idref="ch3"/>
    <itemref idref="ch4"/>
    <itemref idref="notes"/>
    <itemref idref="hostile"/>
  </spine>
</package>
`;
  const css = `@namespace epub url(http://www.idpf.org/2007/ops);
@font-face { font-family: "BookFont"; src: url("../fonts/book.woff2") format("woff2"); }
body { font-family: serif; }
h1 { text-align: center; font-size: 1.6em; }
p { text-indent: 1.2em; margin: 0 0 0.45em; line-height: 1.4; }
.fancy { font-family: "BookFont", monospace; }
.figure { text-align: center; }
.figure img { width: 60%; }
.caption { font-size: 0.85em; text-indent: 0; }
aside[epub|type~="footnote"] { font-size: 0.85em; font-style: italic; }
.lettrine { font-size: 1.6em; }
`;
  const inter = fs.readFileSync(path.join(SHELL, 'renderer', 'assets', 'fonts', 'inter-latin-wght-normal.woff2'));
  const fig1 = png(240, 120, (x, y) => [40 + ((x * 200) / 240) | 0, 90 + ((y * 120) / 120) | 0, 160]);
  const diagram = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60" viewBox="0 0 120 60"><rect width="120" height="60" fill="#2a5d9f"/><circle cx="30" cy="30" r="18" fill="#f3e9c6"/><script>parent.__booksPwned = 'svg-file-script';</script></svg>`;
  const encryption = `<?xml version="1.0" encoding="UTF-8"?>
<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#">
  <enc:EncryptedData>
    <enc:EncryptionMethod Algorithm="http://www.idpf.org/2008/embedding"/>
    <enc:CipherData><enc:CipherReference URI="OEBPS/fonts/book.woff2"/></enc:CipherData>
  </enc:EncryptedData>
</encryption>
`;
  return epubZip(
    {
      'META-INF/container.xml': container('OEBPS/content.opf'),
      'META-INF/encryption.xml': encryption,
      'OEBPS/content.opf': opf,
      'OEBPS/nav.xhtml': nav,
      'OEBPS/styles/book.css': css,
      'OEBPS/fonts/book.woff2': obfuscateIdpf(inter, VOYAGE_UID),
      'OEBPS/images/cover.png': coverPng([24, 36, 80], [120, 70, 140]),
      'OEBPS/images/fig1.png': fig1,
      'OEBPS/images/diagram.svg': diagram,
      'OEBPS/text/cover.xhtml': cover,
      'OEBPS/text/ch1.xhtml': ch1,
      'OEBPS/text/ch2.xhtml': ch2,
      'OEBPS/text/ch3.xhtml': ch3,
      'OEBPS/text/ch4.xhtml': ch4,
      'OEBPS/text/notes.xhtml': notes,
      'OEBPS/text/hostile.xhtml': hostile,
    },
    [
      { name: '../evil.txt', data: 'path traversal' },
      { name: '/abs.txt', data: 'absolute' },
    ],
  );
}

// ---------------------------------------------------------------- classique.epub (EPUB 2)
function classique() {
  const XH11 = (title, body, enc = 'UTF-8') => `<?xml version="1.0" encoding="${enc}"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="fr">
<head><title>${title}</title><link rel="stylesheet" href="style.css" type="text/css"/></head>
<body>
${body}
</body>
</html>
`;
  const poem = (seed, n) => Array.from({ length: n }, (_, i) => `<p class="vers">${para(seed + i, 9)}</p>`).join('\n');
  const c1 = XH11('I', `<h2 id="c1">I. Aurore</h2>\n<p>Le jour&nbsp;se lève &mdash; l&rsquo;aube &eacute;claire la plaine.</p>\n${poem(500, 30)}`);
  const c2 = XH11('II', `<h2 id="c2">II. Midi</h2>\n${poem(600, 30)}\n<h3 id="c2b">Strophe</h3>\n${poem(650, 12)}`);
  const c3body = `<h2 id="c3">III. Soir</h2>\n<p>Encodage ISO-8859-1 : été, à, ça, cœur.</p>\n${poem(700, 20)}`;
  const c3 = Buffer.from(XH11('III', c3body, 'ISO-8859-1').replace('cœur', 'coeur'), 'latin1');
  const ncx = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE ncx PUBLIC "-//NISO//DTD ncx 2005-1//EN" "http://www.daisy.org/z3986/2005/ncx-2005-1.dtd">
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="isbn-978-0-00-000000-0"/></head>
  <docTitle><text>Les Contemplations</text></docTitle>
  <navMap>
    <navPoint id="np1" playOrder="1"><navLabel><text>Livre premier</text></navLabel><content src="c1.xhtml"/>
      <navPoint id="np2" playOrder="2"><navLabel><text>I. Aurore</text></navLabel><content src="c1.xhtml#c1"/></navPoint>
      <navPoint id="np3" playOrder="3"><navLabel><text>II. Midi</text></navLabel><content src="c2.xhtml#c2"/>
        <navPoint id="np4" playOrder="4"><navLabel><text>Strophe</text></navLabel><content src="c2.xhtml#c2b"/></navPoint>
      </navPoint>
    </navPoint>
    <navPoint id="np5" playOrder="5"><navLabel><text>Livre deuxième</text></navLabel><content src="c3.xhtml"/>
      <navPoint id="np6" playOrder="6"><navLabel><text>III. Soir</text></navLabel><content src="c3.xhtml#c3"/></navPoint>
    </navPoint>
  </navMap>
</ncx>
`;
  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="BookId">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:title>Les Contemplations (extrait)</dc:title>
    <dc:creator opf:role="aut" opf:file-as="Hugo, Victor">Victor Hugo</dc:creator>
    <dc:language>fr</dc:language>
    <dc:identifier id="BookId" opf:scheme="ISBN">isbn-978-0-00-000000-0</dc:identifier>
    <meta name="cover" content="cover-image"/>
    <meta name="calibre:series" content="Poésie"/>
    <meta name="calibre:series_index" content="1"/>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="cover-image" href="cover.png" media-type="image/png"/>
    <item id="style" href="style.css" media-type="text/css"/>
    <item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="c2.xhtml" media-type="application/xhtml+xml"/>
    <item id="c3" href="c3.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="c1"/>
    <itemref idref="c2"/>
    <itemref idref="c3"/>
  </spine>
  <guide><reference type="cover" title="Couverture" href="c1.xhtml"/></guide>
</package>
`;
  return epubZip({
    'META-INF/container.xml': container('content.opf'),
    'content.opf': opf,
    'toc.ncx': ncx,
    'style.css': 'p.vers { text-indent: 0; margin: 0 0 .2em 2em; } h2 { text-align: center; }',
    'cover.png': coverPng([120, 30, 30], [230, 160, 80]),
    'c1.xhtml': c1,
    'c2.xhtml': c2,
    'c3.xhtml': c3,
  });
}

// ---------------------------------------------------------------- small English books
function small({ title, author, uid, cover, chapters = 3, lang = 'en' }) {
  const items = [];
  const files = {};
  for (let i = 1; i <= chapters; i++) {
    files[`EPUB/c${i}.xhtml`] = XHTML(`Chapter ${i}`, `<h1>Chapter ${i}</h1>\n${Array.from({ length: 14 }, (_, k) => `<p>${para(900 + i * 50 + k, 50, WORDS_EN)}</p>`).join('\n')}`, { lang }).replace('../styles/book.css', 'book.css');
    items.push(i);
  }
  const nav = `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol>${items.map((i) => `<li><a href="c${i}.xhtml">Chapter ${i}</a></li>`).join('')}</ol></nav></body></html>`;
  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">${uid}</dc:identifier><dc:title>${title}</dc:title><dc:creator>${author}</dc:creator><dc:language>${lang}</dc:language>
    <meta property="dcterms:modified">2026-01-01T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    ${cover ? '<item id="cov" href="cover.png" media-type="image/png" properties="cover-image"/>' : ''}
    <item id="css" href="book.css" media-type="text/css"/>
    ${items.map((i) => `<item id="c${i}" href="c${i}.xhtml" media-type="application/xhtml+xml"/>`).join('\n    ')}
  </manifest>
  <spine>${items.map((i) => `<itemref idref="c${i}"/>`).join('')}</spine>
</package>
`;
  return epubZip({
    'META-INF/container.xml': container('EPUB/package.opf'),
    'EPUB/package.opf': opf,
    'EPUB/nav.xhtml': nav,
    'EPUB/book.css': 'p { margin: 0 0 .5em; }',
    ...(cover ? { 'EPUB/cover.png': coverPng(...cover) } : {}),
    ...files,
  });
}

// ---------------------------------------------------------------- rtl.epub (right-to-left)
function rtl() {
  const words = 'القمر يضيء الميناء بينما يستعد البحارة للرحلة الطويلة نحو الجزر البعيدة حيث لا يعود أحد بدون قصة جديدة'.split(' ');
  const chapter = (n) => `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="ar" lang="ar" dir="rtl"><head><title>${n}</title></head>
<body><h1 id="start-${n}">الفصل ${n}</h1>
${Array.from({ length: 30 }, (_, k) => `<p>${para(1000 + n * 40 + k, 60, words)}</p>`).join('\n')}
</body></html>`;
  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid" dir="rtl"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">urn:uuid:cccccccc-1111-2222-3333-444444444444</dc:identifier><dc:title>رحلة القمر</dc:title><dc:language>ar</dc:language></metadata>
<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="c2.xhtml" media-type="application/xhtml+xml"/></manifest>
<spine page-progression-direction="rtl"><itemref idref="c1"/><itemref idref="c2"/></spine></package>`;
  const nav = `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" dir="rtl"><head><title>المحتويات</title></head><body><nav epub:type="toc"><ol><li><a href="c1.xhtml">الفصل 1</a></li><li><a href="c2.xhtml">الفصل 2</a></li></ol></nav></body></html>`;
  return epubZip({ 'META-INF/container.xml': container('OPS/package.opf'), 'OPS/package.opf': opf, 'OPS/nav.xhtml': nav, 'OPS/c1.xhtml': chapter(1), 'OPS/c2.xhtml': chapter(2) });
}

// ---------------------------------------------------------------- damaged / protected
function drm() {
  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">urn:uuid:11111111-2222-3333-4444-555555555555</dc:identifier><dc:title>Livre protégé</dc:title><dc:language>fr</dc:language></metadata>
<manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="c2.xhtml" media-type="application/xhtml+xml"/></manifest>
<spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>`;
  const enc = `<?xml version="1.0" encoding="UTF-8"?>
<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#" xmlns:ds="http://www.w3.org/2000/09/xmldsig#">
  <enc:EncryptedData><enc:EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes128-cbc"/><ds:KeyInfo><resource xmlns="http://ns.adobe.com/adept">urn:uuid:abc</resource></ds:KeyInfo><enc:CipherData><enc:CipherReference URI="OEBPS/c1.xhtml"/></enc:CipherData></enc:EncryptedData>
  <enc:EncryptedData><enc:EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes128-cbc"/><enc:CipherData><enc:CipherReference URI="OEBPS/c2.xhtml"/></enc:CipherData></enc:EncryptedData>
</encryption>`;
  return epubZip({
    'META-INF/container.xml': container('OEBPS/content.opf'),
    'META-INF/encryption.xml': enc,
    'META-INF/rights.xml': '<?xml version="1.0"?><adept:rights xmlns:adept="http://ns.adobe.com/adept"/>',
    'OEBPS/content.opf': opf,
    'OEBPS/c1.xhtml': crypto.randomBytes(2048),
    'OEBPS/c2.xhtml': crypto.randomBytes(2048),
  });
}

function badentry() {
  const good = XHTML('Bon', '<h1>Bon chapitre</h1><p>Ce chapitre se lit.</p>');
  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">urn:uuid:99999999-2222-3333-4444-555555555555</dc:identifier><dc:title>Chapitre abîmé</dc:title><dc:language>fr</dc:language></metadata>
<manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="c2.xhtml" media-type="application/xhtml+xml"/></manifest>
<spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>`;
  return zip([
    { name: 'mimetype', data: 'application/epub+zip', store: true },
    { name: 'META-INF/container.xml', data: container('OEBPS/content.opf') },
    { name: 'OEBPS/content.opf', data: opf },
    { name: 'OEBPS/c1.xhtml', data: good },
    { name: 'OEBPS/c2.xhtml', data: XHTML('Abîmé', '<p>Damaged.</p>'), crc: 12345 },
  ]);
}

export function writeBookFixtures(dir, { port = 9 } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const out = {};
  const write = (name, buf) => {
    const p = path.join(dir, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, buf);
    return p;
  };
  const v = voyage(port);
  out.voyage = write('voyage.epub', v);
  out.classique = write('classique.epub', classique());
  out.garden = write('garden.epub', small({ title: 'The Night Garden', author: 'Amelia Hart', uid: 'urn:uuid:aaaaaaaa-1111-2222-3333-444444444444', cover: [[20, 60, 50], [120, 180, 120]] }));
  out.added = write('added.epub', small({ title: 'Winter Letters', author: 'Tom Ashby', uid: 'urn:uuid:bbbbbbbb-1111-2222-3333-444444444444', cover: null, chapters: 2 }));
  out.drm = write('drm.epub', drm());
  out.broken = write('broken.epub', v.subarray(0, Math.floor(v.length / 2)));
  out.notzip = write('notzip.epub', 'This is not an EPUB file.\n');
  out.badentry = write('badentry.epub', badentry());
  out.rtl = write('rtl.epub', rtl());
  return out;
}

// node test/fixtures/books/make-fixtures.mjs <dir>  -> writes the books there (handy to open them by hand)
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2] || path.join(process.cwd(), 'books-fixtures');
  console.log(writeBookFixtures(dir));
}
