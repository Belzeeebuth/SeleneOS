// Numérisation — files written by the app, without any library:
//   buildPdf(pages, { title, date }) -> Uint8Array   a PDF 1.4 with one page per JPEG (DCTDecode stream, not
//       re-encoded), each page at the scan's physical size: width_pt = pixels / dpi × 72.
//       pages: [{ jpeg: Uint8Array, dpi, dpiY? }] (size and colour components are read from the JPEG itself)
//   jpegInfo(bytes) -> { width, height, components } | null      (SOF0–SOF15 marker)
//   setJpegDpi(bytes, dpi) -> Uint8Array   JFIF density in dots per inch (inserts a JFIF APP0 when missing)
//   setPngDpi(bytes, dpi)  -> Uint8Array   pHYs chunk in pixels per metre (replaced or inserted after IHDR)
// Pure functions (no DOM): test/scan.unit.mjs imports this module in Node.

const enc = new TextEncoder();
const bytes = (s) => enc.encode(s);

export function jpegInfo(b) {
  if (!b || b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let p = 2;
  while (p + 4 <= b.length) {
    if (b[p] !== 0xff) return null;
    let m = b[p + 1];
    while (m === 0xff && p + 2 < b.length) {
      p++;
      m = b[p + 1];
    }
    if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) {
      p += 2;
      continue;
    }
    const len = (b[p + 2] << 8) | b[p + 3];
    // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC)
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      if (p + 9 >= b.length) return null;
      return { height: (b[p + 5] << 8) | b[p + 6], width: (b[p + 7] << 8) | b[p + 8], components: b[p + 9] };
    }
    if (m === 0xda || m === 0xd9) return null;
    p += 2 + len;
  }
  return null;
}

const pt = (px, dpi) => Math.round(((px / (dpi || 72)) * 72) * 100) / 100;
const num = (v) => (Number.isInteger(v) ? String(v) : String(Number(v.toFixed(2))));

/** A PDF text string: plain ASCII as (…) with escapes, anything else as UTF-16BE hex with a BOM. */
function pdfString(s) {
  const str = String(s ?? '');
  if (/^[\x20-\x7e]*$/.test(str)) return `(${str.replace(/[\\()]/g, (c) => `\\${c}`)})`;
  let hex = 'FEFF';
  for (let i = 0; i < str.length; i++) hex += str.charCodeAt(i).toString(16).padStart(4, '0').toUpperCase();
  return `<${hex}>`;
}

function pdfDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const a = Math.abs(off);
  return `D:${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${sign}${p(Math.floor(a / 60))}'${p(a % 60)}'`;
}

export function buildPdf(pages, { title = '', date = new Date(), producer = 'Selene Numérisation' } = {}) {
  if (!Array.isArray(pages) || !pages.length) throw new Error('No page');
  const chunks = [];
  let size = 0;
  const offsets = [];
  const push = (data) => {
    const b = typeof data === 'string' ? bytes(data) : data;
    chunks.push(b);
    size += b.length;
  };
  const begin = (n) => {
    offsets[n] = size;
    push(`${n} 0 obj\n`);
  };
  push('%PDF-1.4\n');
  push(Uint8Array.of(0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a)); // binary file marker
  // objects: 1 catalog, 2 page tree, 3 info, then per page: page, contents, image
  const n = pages.length;
  const pageRef = (i) => 4 + i * 3;
  begin(1);
  push('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  begin(2);
  push(`<< /Type /Pages /Kids [${pages.map((_, i) => `${pageRef(i)} 0 R`).join(' ')}] /Count ${n} >>\nendobj\n`);
  begin(3);
  push(`<< /Producer ${pdfString(producer)} /Creator ${pdfString(producer)} /CreationDate (${pdfDate(date)})${title ? ` /Title ${pdfString(title)}` : ''} >>\nendobj\n`);
  pages.forEach((pg, i) => {
    const info = jpegInfo(pg.jpeg);
    if (!info || !info.width || !info.height) throw new Error(`Page ${i + 1} is not a JPEG`);
    if (info.components !== 1 && info.components !== 3) throw new Error(`Page ${i + 1}: unsupported JPEG colour`);
    const w = pt(info.width, pg.dpi);
    const hgt = pt(info.height, pg.dpiY || pg.dpi);
    const ref = pageRef(i);
    begin(ref);
    push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(w)} ${num(hgt)}] /Resources << /XObject << /Im0 ${ref + 2} 0 R >> /ProcSet [/PDF /ImageB /ImageC] >> /Contents ${ref + 1} 0 R >>\nendobj\n`);
    const content = `q\n${num(w)} 0 0 ${num(hgt)} 0 0 cm\n/Im0 Do\nQ\n`;
    begin(ref + 1);
    push(`<< /Length ${bytes(content).length} >>\nstream\n${content}endstream\nendobj\n`);
    begin(ref + 2);
    push(`<< /Type /XObject /Subtype /Image /Width ${info.width} /Height ${info.height} /ColorSpace ${info.components === 1 ? '/DeviceGray' : '/DeviceRGB'} /BitsPerComponent 8 /Filter /DCTDecode /Length ${pg.jpeg.length} >>\nstream\n`);
    push(pg.jpeg);
    push('\nendstream\nendobj\n');
  });
  const count = 4 + n * 3;
  const xref = size;
  let table = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let i = 1; i < count; i++) table += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  push(table);
  const id = Array.from({ length: 16 }, (_, i) => ((size * 31 + i * 97 + n * 13 + date.getTime()) >>> (i % 4) * 8 & 0xff).toString(16).padStart(2, '0')).join('');
  push(`trailer\n<< /Size ${count} /Root 1 0 R /Info 3 0 R /ID [<${id}> <${id}>] >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(size);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

export function setJpegDpi(b, dpi) {
  const d = Math.max(1, Math.min(65535, Math.round(dpi || 0)));
  if (!b || b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8 || !dpi) return b;
  const isJfif = b[2] === 0xff && b[3] === 0xe0 && b.length > 18 && String.fromCharCode(b[6], b[7], b[8], b[9]) === 'JFIF' && b[10] === 0;
  if (isJfif) {
    const out = b.slice();
    out[13] = 1; // dots per inch
    out[14] = d >> 8;
    out[15] = d & 0xff;
    out[16] = d >> 8;
    out[17] = d & 0xff;
    return out;
  }
  const app0 = Uint8Array.of(0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x01, d >> 8, d & 0xff, d >> 8, d & 0xff, 0x00, 0x00);
  const out = new Uint8Array(b.length + app0.length);
  out.set(b.subarray(0, 2), 0);
  out.set(app0, 2);
  out.set(b.subarray(2), 2 + app0.length);
  return out;
}

let CRC_TABLE = null;
function crc32(b, start, end) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) crc = CRC_TABLE[(crc ^ b[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function setPngDpi(b, dpi) {
  if (!b || b.length < 33 || b[0] !== 0x89 || b[1] !== 0x50 || !dpi) return b;
  const ppm = Math.round(dpi / 0.0254);
  const chunk = new Uint8Array(21);
  const dv = new DataView(chunk.buffer);
  dv.setUint32(0, 9);
  chunk.set([0x70, 0x48, 0x59, 0x73], 4); // pHYs
  dv.setUint32(8, ppm);
  dv.setUint32(12, ppm);
  chunk[16] = 1;
  dv.setUint32(17, crc32(chunk, 4, 17));
  // walk the chunks before IDAT: replace an existing pHYs, else insert after IHDR
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let p = 8;
  const ihdrEnd = 8 + 12 + view.getUint32(8);
  while (p + 8 <= b.length) {
    const len = view.getUint32(p);
    const type = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
    if (type === 'pHYs') {
      const out = new Uint8Array(b.length - (12 + len) + chunk.length);
      out.set(b.subarray(0, p), 0);
      out.set(chunk, p);
      out.set(b.subarray(p + 12 + len), p + chunk.length);
      return out;
    }
    if (type === 'IDAT' || type === 'IEND') break;
    p += 12 + len;
  }
  const out = new Uint8Array(b.length + chunk.length);
  out.set(b.subarray(0, ihdrEnd), 0);
  out.set(chunk, ihdrEnd);
  out.set(b.subarray(ihdrEnd), ihdrEnd + chunk.length);
  return out;
}
