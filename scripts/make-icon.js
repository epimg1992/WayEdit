'use strict';
/**
 * make-icon.js
 * Generates assets/icon.png (64x64) and assets/icon.ico (ICO with embedded PNG)
 * using only Node.js built-ins: zlib, fs, path, Buffer.
 *
 * Icon design:
 *   Background : dark navy  #0a0d12
 *   Diamond    : amber fill  #ffb454  (~80% of 64px canvas = ~51px tip-to-tip)
 *   Border ring: cyan        #4fd1e0  (1-2 px outline around diamond)
 */

const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

// Size + output name are overridable via argv so the macOS build can generate a
// high-res icon: `node scripts/make-icon.js 1024 icon-mac.png`. With no args this
// keeps the original 64×64 icon.png + icon.ico used by the Windows build.
const WIDTH  = parseInt(process.argv[2], 10) || 64;
const HEIGHT = WIDTH;
const OUT_PNG = process.argv[3] || 'icon.png';

// ── colour helpers ────────────────────────────────────────────────────────────

function hexToRgb(hex) {
  const v = parseInt(hex.replace('#', ''), 16);
  return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
}

const BG_COLOR     = hexToRgb('#0a0d12');
const DIAMOND_COLOR = hexToRgb('#ffb454');
const BORDER_COLOR  = hexToRgb('#4fd1e0');

// ── pixel rasteriser ──────────────────────────────────────────────────────────

/**
 * Returns an RGBA Uint8Array (WIDTH * HEIGHT * 4) with the icon drawn.
 *
 * Drone glyph (matches the in-app header logo), defined in a 100×100 design space and
 * scaled to WIDTH: four arms in an X from the centre to four rotors, four rotor rings,
 * and a filled central body. Amber drone (#ffb454) on the dark navy background.
 */
function renderPixels() {
  const pixels = new Uint8Array(WIDTH * HEIGHT * 4);
  const s = WIDTH / 100; // design-space (100) → pixels

  const C = [50, 50];
  const CORNERS = [[20, 20], [80, 20], [20, 80], [80, 80]];
  const ARM_HALF = 3.5;  // half of stroke-width 7
  const RING_R = 14, RING_HALF = 3;  // rotor ring radius / half of stroke-width 6
  const BODY_R = 10;     // filled centre body

  const segDist = (px, py, ax, ay, bx, by) => {
    const vx = bx - ax, vy = by - ay, wx = px - ax, wy = py - ay;
    let t = (wx * vx + wy * vy) / (vx * vx + vy * vy);
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
  };

  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const ux = (x + 0.5) / s, uy = (y + 0.5) / s; // pixel centre in design space

      // Signed distance to the drone shape (negative = inside), in design units.
      let d = Infinity;
      for (const [cx, cy] of CORNERS) d = Math.min(d, segDist(ux, uy, C[0], C[1], cx, cy) - ARM_HALF);
      for (const [cx, cy] of CORNERS) d = Math.min(d, Math.abs(Math.hypot(ux - cx, uy - cy) - RING_R) - RING_HALF);
      d = Math.min(d, Math.hypot(ux - C[0], uy - C[1]) - BODY_R);

      // 1-pixel anti-aliased coverage of drone over background.
      const cov = Math.max(0, Math.min(1, 0.5 - d * s));
      const r = Math.round(BG_COLOR[0] + (DIAMOND_COLOR[0] - BG_COLOR[0]) * cov);
      const g = Math.round(BG_COLOR[1] + (DIAMOND_COLOR[1] - BG_COLOR[1]) * cov);
      const b = Math.round(BG_COLOR[2] + (DIAMOND_COLOR[2] - BG_COLOR[2]) * cov);

      const i = (y * WIDTH + x) * 4;
      pixels[i]     = r;
      pixels[i + 1] = g;
      pixels[i + 2] = b;
      pixels[i + 3] = 255;
    }
  }
  return pixels;
}

// ── PNG builder ───────────────────────────────────────────────────────────────

function crc32(buf) {
  // Standard CRC-32 table
  if (!crc32._table) {
    crc32._table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : (c >>> 1);
      crc32._table[i] = c;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++)
    crc = crc32._table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const len = Buffer.allocUnsafe(4);
  len.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.allocUnsafe(4);
  const crcInput = Buffer.concat([typeBytes, data]);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([len, typeBytes, data, crcBuf]);
}

function buildPng(pixels, w, h) {
  // PNG signature
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR: width, height, bit-depth=8, colorType=2 (RGB) ... we use RGB+A → colorType=6
  const ihdrData = Buffer.allocUnsafe(13);
  ihdrData.writeUInt32BE(w, 0);
  ihdrData.writeUInt32BE(h, 4);
  ihdrData[8]  = 8;   // bit depth
  ihdrData[9]  = 6;   // colour type: RGBA
  ihdrData[10] = 0;   // compression
  ihdrData[11] = 0;   // filter
  ihdrData[12] = 0;   // interlace
  const ihdr = pngChunk('IHDR', ihdrData);

  // Raw scanline data: filter byte (0 = None) + RGBA per row
  const rawRows = Buffer.allocUnsafe(h * (1 + w * 4));
  for (let y = 0; y < h; y++) {
    const rowOffset = y * (1 + w * 4);
    rawRows[rowOffset] = 0; // filter type None
    pixels.copy(rawRows, rowOffset + 1, y * w * 4, (y + 1) * w * 4);
  }

  // Deflate (zlib)
  const compressed = zlib.deflateSync(rawRows, { level: 9 });
  const idat = pngChunk('IDAT', compressed);

  // IEND
  const iend = pngChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([sig, ihdr, idat, iend]);
}

// ── ICO builder ───────────────────────────────────────────────────────────────

/**
 * Modern ICO with a single embedded PNG image.
 * ICO directory entry with width/height = 0 signals a 256×256 icon per spec,
 * but for 64×64 we use 64 in those fields.
 */
function buildIco(pngData, w, h) {
  // ICO header: reserved(2) + type(2)=1 + count(2)=1
  const header = Buffer.allocUnsafe(6);
  header.writeUInt16LE(0,    0); // reserved
  header.writeUInt16LE(1,    2); // type: 1 = icon
  header.writeUInt16LE(1,    4); // image count

  // ICONDIRENTRY (16 bytes)
  const dirEntry = Buffer.allocUnsafe(16);
  dirEntry[0]  = w  >= 256 ? 0 : w;   // width  (0 = 256)
  dirEntry[1]  = h  >= 256 ? 0 : h;   // height (0 = 256)
  dirEntry[2]  = 0;                    // color count (0 = no palette)
  dirEntry[3]  = 0;                    // reserved
  dirEntry.writeUInt16LE(1,  4);       // planes
  dirEntry.writeUInt16LE(32, 6);       // bit count
  dirEntry.writeUInt32LE(pngData.length, 8);  // size of image data
  dirEntry.writeUInt32LE(6 + 16,      12);    // offset of image data (after header + one dir entry)

  return Buffer.concat([header, dirEntry, pngData]);
}

// ── main ──────────────────────────────────────────────────────────────────────

(function main() {
  const projectRoot = path.resolve(__dirname, '..');
  const assetsDir   = path.join(projectRoot, 'assets');

  if (!fs.existsSync(assetsDir)) {
    fs.mkdirSync(assetsDir, { recursive: true });
    console.log('Created assets/ directory');
  }

  console.log('Rendering pixels...');
  const pixelsBuf = Buffer.from(renderPixels().buffer);

  console.log('Building PNG...');
  const pngData = buildPng(pixelsBuf, WIDTH, HEIGHT);

  const pngPath = path.join(assetsDir, OUT_PNG);
  fs.writeFileSync(pngPath, pngData);
  console.log(`Written: ${pngPath}  (${pngData.length} bytes, ${WIDTH}×${HEIGHT})`);
  if (fs.statSync(pngPath).size === 0) throw new Error(OUT_PNG + ' is empty!');

  // Only emit the Windows .ico alongside the default icon.png.
  if (OUT_PNG === 'icon.png') {
    console.log('Building ICO...');
    const icoData = buildIco(pngData, WIDTH, HEIGHT);
    const icoPath = path.join(assetsDir, 'icon.ico');
    fs.writeFileSync(icoPath, icoData);
    console.log(`Written: ${icoPath}  (${icoData.length} bytes)`);
    if (fs.statSync(icoPath).size === 0) throw new Error('icon.ico is empty!');
  }

  console.log('\nDone.');
})();
