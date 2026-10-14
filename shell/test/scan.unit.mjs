// Unit tests for scanning (no Electron): main/lib/sane.js (scanimage output parsers, argv, errors, PNG header) with
// real-world outputs of the SANE backends (genesys, pixma, epson2, fujitsu, brother4, airscan, escl, hpaio), and the
// app's own files: apps/scan/lib/pdf.js (PDF writer read back by pdf.js, JFIF / pHYs dpi) and lib/image.js (document
// detection, resolution presets). Run by test/scan.test.mjs first; alone: node test/scan.unit.mjs
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const sane = require(path.join(ROOT, 'main/lib/sane.js'));
const pdf = await import(pathToFileURL(path.join(ROOT, 'renderer/apps/scan/lib/pdf.js')).href);
const img = await import(pathToFileURL(path.join(ROOT, 'renderer/apps/scan/lib/image.js')).href);

let passed = 0;
const failures = [];
function check(name, actual, expected) {
  const ok = typeof expected === 'function' ? !!expected(actual) : Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++;
  else failures.push(`${name}\n      expected: ${typeof expected === 'function' ? '(predicate)' : JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}`);
}

// ------------------------------------------------------------------ device list
console.log('# devices');
const US = '\x1f';
const listOut = [
  ['genesys:libusb:001:004', 'Canon', 'LiDE 300', 'flatbed scanner'],
  ['airscan:e0:Brother MFC-L2710DW series', 'eSCL', 'Brother MFC-L2710DW series', 'ip=192.168.1.42, fe80::3e2a:f4ff:fea1:b2c3'],
  ['airscan:w1:Brother MFC-L2710DW series', 'WSD', 'Brother MFC-L2710DW series', 'ip=192.168.1.42'],
  ['escl:https://192.168.1.42:443', 'Brother', 'MFC-L2710DW series', 'flatbed scanner'],
  ['v4l:/dev/video0', 'Noname', 'Integrated Camera: Integrated C', 'virtual device'],
  ['pixma:04A91912_4E8C3A', 'CANON', 'Canon PIXMA MG3600 Series', 'multi-function peripheral'],
  ['epson2:net:192.168.1.50', 'Epson', 'PID 08BC', 'flatbed scanner'],
  ['hpaio:/usb/Deskjet_2540_series?serial=CN3AB1234', 'Hewlett-Packard', 'Deskjet_2540_series', 'all-in-one'],
  ['airscan:e2:Canon G3070 series (USB)', 'eSCL', 'Canon G3070 series (USB)', 'ip=127.0.0.1'],
  ['fujitsu:fi-7160:1234', 'FUJITSU', 'fi-7160', 'sheetfed scanner'],
]
  .map((f) => f.join(US))
  .join('\n');
const raw = sane.parseDeviceList(`${listOut}\n`);
check('-f output: every line read (10)', raw.length, 10);
const devs = sane.devicesOf(`${listOut}\n`);
check('webcam (v4l) left out, eSCL seen three times listed once', devs.map((d) => d.name), ['genesys:libusb:001:004', 'airscan:e0:Brother MFC-L2710DW series', 'pixma:04A91912_4E8C3A', 'epson2:net:192.168.1.50', 'hpaio:/usb/Deskjet_2540_series?serial=CN3AB1234', 'airscan:e2:Canon G3070 series (USB)', 'fujitsu:fi-7160:1234']);
const by = Object.fromEntries(devs.map((d) => [d.name, d]));
check('USB flatbed: label « Canon LiDE 300 », usb', [by['genesys:libusb:001:004'].label, by['genesys:libusb:001:004'].connection, by['genesys:libusb:001:004'].kind], ['Canon LiDE 300', 'usb', 'flatbed']);
check('airscan: network, eSCL, address, label = network name', [by['airscan:e0:Brother MFC-L2710DW series'].label, by['airscan:e0:Brother MFC-L2710DW series'].connection, by['airscan:e0:Brother MFC-L2710DW series'].protocol, by['airscan:e0:Brother MFC-L2710DW series'].address], ['Brother MFC-L2710DW series', 'network', 'eSCL', '192.168.1.42']);
check('pixma USB id: usb, vendor not repeated', [by['pixma:04A91912_4E8C3A'].label, by['pixma:04A91912_4E8C3A'].connection, by['pixma:04A91912_4E8C3A'].kind], ['Canon PIXMA MG3600 Series', 'usb', 'mfp']);
check('epson2 net: network', by['epson2:net:192.168.1.50'].connection, 'network');
check('hpaio usb: underscores read as spaces', [by['hpaio:/usb/Deskjet_2540_series?serial=CN3AB1234'].label, by['hpaio:/usb/Deskjet_2540_series?serial=CN3AB1234'].connection], ['Hewlett-Packard Deskjet 2540 series', 'usb']);
check('IPP-over-USB (ipp-usb on localhost): usb', by['airscan:e2:Canon G3070 series (USB)'].connection, 'usb');
check('sheetfed scanner kind', by['fujitsu:fi-7160:1234'].kind, 'sheetfed');
check('WSD kept when there is no eSCL twin', sane.devicesOf(['airscan:w0:HP OfficeJet 8010', 'WSD', 'HP OfficeJet 8010', 'ip=10.0.0.9'].join(US)).map((d) => d.protocol), ['WSD']);
check('-L lines read too', sane.parseDeviceList("device `genesys:libusb:001:004' is a Canon LiDE 300 flatbed scanner\n").map((d) => d.name), ['genesys:libusb:001:004']);
check('no scanner: -L message gives nothing', sane.devicesOf('\nNo scanners were identified. If you were expecting something different,\ncheck that the scanner is plugged in\n'), []);
check('device names validated', ['genesys:libusb:001:004', '-dfoo:bar', 'nocolon', 'a:b\nc', `x:${'a'.repeat(300)}`, 'airscan:e0:Brother MFC-L2710DW series', 'escl:https://192.168.1.42:443'].map(sane.validDevice), [true, false, false, false, false, true, true]);

// ------------------------------------------------------------------ options
console.log('# options');
const LIDE = `
All options specific to device \`genesys:libusb:001:004':
  Scan Mode:
    --mode Color|Gray|Lineart [Gray]
        Selects the scan mode (e.g., lineart, monochrome, or color).
    --source Flatbed [inactive]
        Selects the scan source (such as a document-feeder).
    --preview[=(yes|no)] [no]
        Request a preview-quality scan.
    --depth 8|16 [8]
        Number of bits per sample.
    --resolution 4800|2400|1200|600|300|150|100|75dpi [75]
        Sets the resolution of the scanned image.
  Geometry:
    -l 0..216.7mm [0]
        Top-left x position of scan area.
    -t 0..299.7mm [0]
        Top-left y position of scan area.
    -x 0..216.7mm [216.7]
        Width of scan-area.
    -y 0..299.7mm [299.7]
        Height of scan-area.
  Enhancement:
    --gamma-table 0..65535,... [inactive]
        Gamma-correction table.
    --brightness -100..100 (in steps of 1) [0]
        Controls the brightness of the acquired image.
  Buttons:
    --button-update
        Update button state
`;
const o1 = sane.parseOptions(LIDE);
check('options read (mode, source, preview, depth, resolution, l t x y, gamma-table, brightness, button-update)', Object.keys(o1).length, 12);
check('bool option', [o1.preview.bool, o1.preview.def], [true, 'no']);
check('inactive option', [o1.source.inactive, o1['gamma-table'].inactive], [true, true]);
check('button option', o1['button-update'].button, true);
check('range with steps', o1.brightness.constraint, { type: 'range', min: -100, max: 100, unit: '', step: 1, auto: false });
const s1 = sane.summarizeOptions(o1);
check('LiDE: resolutions sorted', s1.resolutions, { list: [75, 100, 150, 300, 600, 1200, 2400, 4800], range: null, def: 75 });
check('LiDE: modes colour / grey / black and white, default grey', [s1.modes, s1.mode], [[{ value: 'Color', kind: 'color' }, { value: 'Gray', kind: 'gray' }, { value: 'Lineart', kind: 'lineart' }], 'gray']);
check('LiDE: an inactive source gives no source choice', s1.sources, []);
check('LiDE: area in mm', s1.area, { unit: 'mm', width: 216.7, height: 299.7, left: 216.7, top: 299.7 });
check('LiDE: preview at 75 dpi', sane.previewResolution(s1.resolutions), 75);

const AIRSCAN = `
All options specific to device \`airscan:e0:Brother MFC-L2710DW series':
  Standard:
    --resolution 100|200|300|600dpi [300]
        Sets the resolution of the scanned image.
    --mode Color|Gray [Color]
        Selects the scan mode (e.g., lineart, monochrome, or color).
    --source Flatbed|ADF|ADF Duplex [ADF]
        Selects the scan source (such as a document-feeder).
  Geometry:
    -l 0..215.9mm [0]
    -t 0..355.6mm [0]
    -x 0..215.9mm [215.9]
    -y 0..355.6mm [355.6]
  Enhancement:
    --analog-gamma 0.0999908..4 [1]
        Analog gamma-correction
`;
const s2 = sane.summarizeOptions(sane.parseOptions(AIRSCAN));
check('airscan: sources Vitre / Chargeur / Chargeur recto verso, ADF chosen', [s2.sources.map((s) => [s.id, s.value]), s2.source], [[['flatbed', 'Flatbed'], ['adf', 'ADF'], ['adf-duplex', 'ADF Duplex']], 'adf']);
check('airscan: no black and white offered', s2.modes.map((m) => m.kind), ['color', 'gray']);
check('airscan: feeder area (legal length)', [s2.area.width, s2.area.height], [215.9, 355.6]);
check('airscan: preview at 100 dpi (its lowest)', sane.previewResolution(s2.resolutions), 100);
check('fractional range read', sane.parseOptions(AIRSCAN)['analog-gamma'].constraint, { type: 'range', min: 0.0999908, max: 4, unit: '', step: 0, auto: false });

const EPSON2 = `
All options specific to device \`epson2:libusb:002:005':
  Scan Mode:
    --mode Lineart|Gray|Color [Lineart]
    --resolution 50..1200dpi (in steps of 1) [300]
    --source Flatbed|Automatic Document Feeder [Flatbed]
    --adf-mode Simplex|Duplex [inactive]
  Geometry:
    -l 0..215.9mm [0]
    -t 0..297.18mm [0]
    -x 0..215.9mm [215.9]
    -y 0..297.18mm [297.18]
`;
const s3 = sane.summarizeOptions(sane.parseOptions(EPSON2));
check('epson2: resolution range', s3.resolutions, { list: null, range: { min: 50, max: 1200, step: 1 }, def: 300 });
check('epson2: --adf-mode Duplex gives « Chargeur recto verso »', s3.sources.map((s) => [s.id, s.value, s.adfMode]), [['flatbed', 'Flatbed', null], ['adf', 'Automatic Document Feeder', 'Simplex'], ['adf-duplex', 'Automatic Document Feeder', 'Duplex']]);
check('epson2: presets 150 / 300 / 600 exact on a range', img.presetResolutions(s3.resolutions), [{ preset: 150, dpi: 150 }, { preset: 300, dpi: 300 }, { preset: 600, dpi: 600 }]);
check('range preview at 75 dpi', sane.previewResolution(s3.resolutions), 75);

const FUJITSU = `
All options specific to device \`fujitsu:fi-7160:1234':
  Standard:
    --source ADF Front|ADF Back|ADF Duplex [ADF Front]
    --mode Lineart|Halftone|Gray|Color [Lineart]
    --resolution 50..600dpi (in steps of 1) [600]
`;
const s4 = sane.summarizeOptions(sane.parseOptions(FUJITSU));
check('fujitsu: ADF Front = feeder, ADF Back kept as itself, ADF Duplex = both sides', s4.sources.map((s) => [s.id, s.value]), [['adf', 'ADF Front'], ['other:ADF Back', 'ADF Back'], ['adf-duplex', 'ADF Duplex']]);
check('fujitsu: « Lineart » preferred over « Halftone »', s4.modes.find((m) => m.kind === 'lineart').value, 'Lineart');
check('fujitsu: no geometry -> no area', s4.area, null);

const BROTHER4 = `
All options specific to device \`brother4:bus2;dev1':
  Mode:
    --mode Black & White|Gray[Error Diffusion]|True Gray|24bit Color[Fast] [24bit Color[Fast]]
        Select the scan mode
    --resolution 100|150|200|300|400|600|1200|2400|4800|9600dpi [200]
    --source FlatBed|Automatic Document Feeder(left aligned)|Automatic Document Feeder(centrally aligned) [Automatic Document Feeder(left aligned)]
`;
const o5 = sane.parseOptions(BROTHER4);
check('brother4: brackets inside values', [o5.mode.constraint.values, o5.mode.def], [['Black & White', 'Gray[Error Diffusion]', 'True Gray', '24bit Color[Fast]'], '24bit Color[Fast]']);
const s5 = sane.summarizeOptions(o5);
check('brother4: modes by kind', s5.modes, [{ value: '24bit Color[Fast]', kind: 'color' }, { value: 'Gray[Error Diffusion]', kind: 'gray' }, { value: 'Black & White', kind: 'lineart' }]);
check('brother4: FlatBed + two feeder alignments (first kept)', [s5.sources.map((s) => s.id), s5.source], [['flatbed', 'adf'], 'adf']);
check('brother4: preset 150 -> 150, 600 -> 600', img.presetResolutions(s5.resolutions).map((p) => p.dpi), [150, 300, 600]);

const PIXMA_AUTO = `
All options specific to device \`pixma:04A91912_4E8C3A':
  Scan mode:
    --resolution auto|75|150|300|600|1200dpi [75]
    --mode auto|Color|Gray|Lineart [Color]
    --source Flatbed|Automatic Document Feeder|ADF Duplex [Flatbed]
`;
const s6 = sane.summarizeOptions(sane.parseOptions(PIXMA_AUTO));
check('« auto| » prefix ignored', [s6.resolutions.list, s6.modes.map((m) => m.value)], [[75, 150, 300, 600, 1200], ['Color', 'Gray', 'Lineart']]);
check('mode / source kinds', [sane.modeKind('True Gray'), sane.modeKind('Binary'), sane.sourceKind('Document Table'), sane.sourceKind('Transparency Adapter'), sane.sourceKind('ADF Back')], ['gray', 'lineart', 'flatbed', 'film', 'other']);

// presets on a list without 150
check('presets on 100|200|300|600: 150 -> 200 (tie goes higher)', img.presetResolutions({ list: [100, 200, 300, 600] }), [{ preset: 150, dpi: 200 }, { preset: 300, dpi: 300 }, { preset: 600, dpi: 600 }]);
check('presets on 75|150|300 only: 600 -> 300 merged', img.presetResolutions({ list: [75, 150, 300] }), [{ preset: 150, dpi: 150 }, { preset: 300, dpi: 300 }]);
check('main and renderer agree on the nearest resolution', [150, 300, 600, 250].map((d) => sane.nearestResolution(d, { list: [100, 200, 300, 600] })), [150, 300, 600, 250].map((d) => img.nearestResolution(d, { list: [100, 200, 300, 600] })));
check('range snapped to its step', img.nearestResolution(310, { range: { min: 50, max: 1200, step: 25 } }), 300);

// ------------------------------------------------------------------ argv
console.log('# argv');
check('scan argv: device first, values as --opt=value or separate entries, never a shell', sane.scanArgs('airscan:e0:Brother MFC-L2710DW series', { format: 'png', source: 'ADF Duplex', mode: 'Gray', resolution: 200, area: { left: 0, top: 0, width: 210, height: 297 }, batch: '/tmp/x/page-%03d.png' }), ['--device-name=airscan:e0:Brother MFC-L2710DW series', '--format=png', '--progress', '--source=ADF Duplex', '--mode=Gray', '--resolution=200', '-l', '0', '-t', '0', '-x', '210', '-y', '297', '--batch=/tmp/x/page-%03d.png', '--batch-print']);
check('scan argv: single page to a file, area rounded to 0.01 mm, epson2 adf-mode', sane.scanArgs('epson2:libusb:002:005', { format: 'tiff', source: 'Automatic Document Feeder', adfMode: 'Duplex', mode: 'Color', resolution: 300, area: { left: 18.97235, top: 13.985, width: 149.7954, height: 212.123 }, output: '/tmp/x/scan.tiff' }), ['--device-name=epson2:libusb:002:005', '--format=tiff', '--progress', '--source=Automatic Document Feeder', '--adf-mode=Duplex', '--mode=Color', '--resolution=300', '-l', '18.97', '-t', '13.99', '-x', '149.8', '-y', '212.12', '--output-file=/tmp/x/scan.tiff']);

// ------------------------------------------------------------------ errors
console.log('# errors');
const E = (stderr, code) => sane.errorOf(stderr, code).code;
check('Device busy', E('scanimage: sane_start: Device busy\n', 3), 'EBUSY');
check('cover open', E('scanimage: sane_start: Scanner cover is open\n', 8), 'ECOVER');
check('feeder empty', E('Scanning page 1\nscanimage: sane_start: Document feeder out of documents\nBatch terminated, 0 pages scanned\n', 7), 'ENODOCS');
check('paper jam', E('scanimage: sane_read: Document feeder jammed\n', 6), 'EJAM');
check('disconnected (open failed: Invalid argument)', E('scanimage: open of device airscan:e0:X failed: Invalid argument\n', 1), 'EGONE');
check('disconnected mid-scan (I/O error)', E('Progress: 40.0%\rscanimage: sane_read: Error during device I/O\n', 9), 'EGONE');
check('permission denied', E('scanimage: open of device genesys:libusb:001:004 failed: Access to resource has been denied\n', 1), 'EACCES');
check('status code alone', E('', 11), 'EACCES');
check('bad option value', E('scanimage: setting of option --mode failed (Invalid argument)\n', 1), 'EINVAL');
check('other: message without the prefix', sane.errorOf('scanimage: something odd\n', 1), { code: 'ESCAN', message: 'something odd' });

// ------------------------------------------------------------------ PNG header
console.log('# png');
function makePng(w, hh, dpi) {
  const crc = (b) => zlib.crc32(b) >>> 0;
  const chunk = (type, data) => {
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(hh, 4);
  ihdr[8] = 8;
  ihdr[9] = 0;
  const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr)];
  if (dpi) {
    const ph = Buffer.alloc(9);
    ph.writeUInt32BE(Math.round(dpi / 0.0254), 0);
    ph.writeUInt32BE(Math.round(dpi / 0.0254), 4);
    ph[8] = 1;
    parts.push(chunk('pHYs', ph));
  }
  parts.push(chunk('IDAT', zlib.deflateSync(Buffer.alloc((w + 1) * hh, 0x80))), chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}
check('pngInfo: size and dpi from pHYs', sane.pngInfo(makePng(1240, 1754, 150)), { width: 1240, height: 1754, depth: 8, colorType: 0, dpiX: 150, dpiY: 150 });
check('pngInfo: no pHYs', sane.pngInfo(makePng(10, 10, 0)).dpiX, null);
check('pngInfo: not a PNG', sane.pngInfo(Buffer.from('hello world, this is not a png file at all')), null);
const withDpi = pdf.setPngDpi(new Uint8Array(makePng(20, 10, 0)), 300);
check('setPngDpi inserts pHYs after IHDR (valid CRC, read back)', [sane.pngInfo(Buffer.from(withDpi)).dpiX, zlib.crc32(Buffer.from(withDpi.subarray(33 + 4, 33 + 17))) >>> 0 === Buffer.from(withDpi).readUInt32BE(33 + 17)], [300, true]);
check('setPngDpi replaces an existing pHYs', [sane.pngInfo(Buffer.from(pdf.setPngDpi(new Uint8Array(makePng(20, 10, 72)), 600))).dpiX, pdf.setPngDpi(new Uint8Array(makePng(20, 10, 72)), 600).length], [600, makePng(20, 10, 72).length]);

// ------------------------------------------------------------------ JPEG + PDF
console.log('# pdf');
function fakeJpeg(w, hh, comps = 3, jfif = true) {
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
  const sof = [0xff, 0xc0, 0x00, 8 + comps * 3, 8, hh >> 8, hh & 0xff, w >> 8, w & 0xff, comps];
  for (let c = 0; c < comps; c++) sof.push(c + 1, 0x11, 0);
  return Uint8Array.from([0xff, 0xd8, ...(jfif ? app0 : []), ...sof, 0xff, 0xd9]);
}
check('jpegInfo reads SOF0', pdf.jpegInfo(fakeJpeg(2480, 3508)), { height: 3508, width: 2480, components: 3 });
const j300 = pdf.setJpegDpi(fakeJpeg(10, 10), 300);
check('setJpegDpi: JFIF density 300 dpi', [j300[13], (j300[14] << 8) | j300[15], (j300[16] << 8) | j300[17], j300.length], [1, 300, 300, fakeJpeg(10, 10).length]);
const jIns = pdf.setJpegDpi(fakeJpeg(10, 10, 3, false), 150);
check('setJpegDpi: JFIF inserted when missing', [jIns[2], jIns[3], String.fromCharCode(...jIns.subarray(6, 10)), (jIns[14] << 8) | jIns[15], pdf.jpegInfo(jIns).width], [0xff, 0xe0, 'JFIF', 150, 10]);

const pages = [
  { jpeg: fakeJpeg(1240, 1754), dpi: 150 }, // A4 at 150 dpi
  { jpeg: fakeJpeg(3508, 2480, 1), dpi: 300 }, // A4 landscape at 300 dpi, grey JPEG
  { jpeg: fakeJpeg(850, 1100), dpi: 100 }, // Letter at 100 dpi
];
const bytes = pdf.buildPdf(pages, { title: 'Numérisation 2026-10-14 10.32.05', date: new Date(2026, 9, 14, 10, 32, 5) });
const text = Buffer.from(bytes).toString('latin1');
check('PDF header and EOF', [text.startsWith('%PDF-1.4\n'), text.trimEnd().endsWith('%%EOF')], [true, true]);
const xrefAt = Number(/startxref\n(\d+)\n%%EOF/.exec(text)[1]);
check('startxref points at the xref table', text.slice(xrefAt, xrefAt + 4), 'xref');
const entries = text.slice(xrefAt).split('\n').slice(2).filter((l) => /^\d{10} \d{5} [nf] $/.test(l));
check('xref: 3 + 3 × pages objects + the free entry, each 20 bytes', [entries.length, text.slice(xrefAt).split('\n')[2].length + 1], [13, 20]);
check('every xref offset points at its object', entries.slice(1).every((l, i) => text.startsWith(`${i + 1} 0 obj`, Number(l.slice(0, 10)))), true);
const boxes = [...text.matchAll(/\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/g)].map((m) => [Number(m[1]), Number(m[2])]);
check('MediaBox = pixels / dpi × 72 pt (A4 portrait, A4 landscape, Letter)', boxes, [[595.2, 841.92], [841.92, 595.2], [612, 792]]);
check('grey JPEG -> /DeviceGray, colour -> /DeviceRGB', [...text.matchAll(/\/ColorSpace \/(Device\w+)/g)].map((m) => m[1]), ['DeviceRGB', 'DeviceGray', 'DeviceRGB']);
check('title in UTF-16 (é)', text.includes('/Title <FEFF004E0075006D00E9'), true);
check('a non-JPEG page is refused', (() => {
  try {
    pdf.buildPdf([{ jpeg: new Uint8Array([1, 2, 3]), dpi: 300 }]);
    return 'built';
  } catch (e) {
    return e.message;
  }
})(), 'Page 1 is not a JPEG');
// read back by an independent parser (pdf.js, already a shell dependency)
const pdfjs = await import(pathToFileURL(path.join(ROOT, 'node_modules/pdfjs-dist/legacy/build/pdf.mjs')).href);
const task = pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, useSystemFonts: false, verbosity: 0 });
const doc = await task.promise;
const views = [];
for (let i = 1; i <= doc.numPages; i++) views.push((await doc.getPage(i)).view.map((v) => Math.round(v * 100) / 100));
check('pdf.js: 3 pages', doc.numPages, 3);
check('pdf.js: page sizes', views, [[0, 0, 595.2, 841.92], [0, 0, 841.92, 595.2], [0, 0, 612, 792]]);
const info = await doc.getMetadata();
check('pdf.js: title and producer', [info.info.Title, info.info.Producer], ['Numérisation 2026-10-14 10.32.05', 'Selene Numérisation']);
await task.destroy();

// ------------------------------------------------------------------ document detection
console.log('# detection');
function glassImage(W, H, doc, lid = [200, 203, 207], paper = [252, 252, 250]) {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const inDoc = doc && x >= doc.x && x < doc.x + doc.w && y >= doc.y && y < doc.y + doc.h;
      const text = inDoc && (y - doc.y) % 9 < 2 && x > doc.x + 6 && x < doc.x + doc.w - 10;
      const c = text ? [40, 40, 45] : inDoc ? paper : lid;
      data.set([c[0], c[1], c[2], 255], (y * W + x) * 4);
    }
  return { data, width: W, height: H };
}
check('A5 on a grey lid: found to the pixel', img.detectDocument(glassImage(160, 220, { x: 15, y: 11, w: 109, h: 155 })), { x: 15, y: 11, w: 109, h: 155 });
check('empty glass: nothing', img.detectDocument(glassImage(160, 220, null)), null);
check('document as large as the glass: nothing to crop', img.detectDocument(glassImage(100, 140, { x: 0, y: 0, w: 100, h: 140 })), null);
check('white lid: only the printed block stands out (kept, smaller)', img.detectDocument(glassImage(160, 220, { x: 15, y: 11, w: 109, h: 155 }, [252, 252, 250])), (b) => b && b.x >= 15 && b.w < 109);
check('clampArea keeps the area inside the glass and at least 5 mm', [img.clampArea({ left: 200, top: -4, width: 2, height: 400 }, 216, 297, 5), img.clampArea({ left: 214, top: 10, width: 20, height: 20 }, 216, 297, 5)], [{ left: 200, top: 0, width: 5, height: 297 }, { left: 196, top: 10, width: 20, height: 20 }]);
check('paper sizes cut to the feeder', [img.paperArea('a4', { width: 215.9, height: 355.6 }), img.paperArea('legal', { width: 215.9, height: 297 }), img.paperArea('max', { width: 215.9, height: 355.6 })], [{ left: 0, top: 0, width: 210, height: 297 }, { left: 0, top: 0, width: 215.9, height: 297 }, { left: 0, top: 0, width: 215.9, height: 355.6 }]);
check('filters', [img.filterOf({}), img.filterOf({ brightness: 20, contrast: -10 })], ['none', 'brightness(1.2) contrast(0.9)']);

console.log(`\nscan.unit: ${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  FAIL ${f}`);
process.exit(failures.length ? 1 : 0);
