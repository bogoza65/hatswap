// Generates the Hatswap toolbar icons (a top hat with a coloured band) as PNGs.
// No dependencies: shapes are rasterised with 8x8 supersampling and encoded with
// node:zlib. Run with `node scripts/generate-icons.mjs`.

import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import path from 'node:path';

const OUT = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'extension', 'icons');
const SIZES = [16, 32, 48, 128];
const SAMPLES = 8;

const INK = [23, 24, 28];
const WHITE = [255, 255, 255];
const CORAL = [242, 85, 61];

// Geometry on a 128-unit canvas. Small sizes get chunkier shapes so the hat
// still reads at 16 px.
const GEOMETRY = {
  regular: { radius: 28, crown: { top: 24, bottom: 82, topHalf: 27, bottomHalf: 24, round: 7 }, band: { top: 66, bottom: 82 }, brim: { left: 18, right: 110, top: 82, bottom: 97, round: 7.5 } },
  small: { radius: 26, crown: { top: 22, bottom: 80, topHalf: 33, bottomHalf: 30, round: 6 }, band: { top: 60, bottom: 80 }, brim: { left: 12, right: 116, top: 80, bottom: 102, round: 9 } },
};

function insideRoundedRect(x, y, left, top, right, bottom, r) {
  if (x < left || x > right || y < top || y > bottom) return false;
  const cx = Math.min(Math.max(x, left + r), right - r);
  const cy = Math.min(Math.max(y, top + r), bottom - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

/** Crown: slightly wider at the top, with rounded top corners. */
function insideCrown(x, y, c) {
  if (y < c.top || y > c.bottom) return false;
  const t = (y - c.top) / (c.bottom - c.top);
  const half = c.topHalf + (c.bottomHalf - c.topHalf) * t;
  if (Math.abs(x - 64) > half) return false;
  if (y < c.top + c.round) {
    const cornerX = 64 + Math.sign(x - 64) * (c.topHalf - c.round);
    if (Math.abs(x - 64) > c.topHalf - c.round) return (x - cornerX) ** 2 + (y - (c.top + c.round)) ** 2 <= c.round ** 2;
  }
  return true;
}

function colourAt(x, y, g) {
  if (!insideRoundedRect(x, y, 0, 0, 128, 128, g.radius)) return null;
  if (insideRoundedRect(x, y, g.brim.left, g.brim.top, g.brim.right, g.brim.bottom, g.brim.round)) return WHITE;
  if (insideCrown(x, y, g.crown)) return y >= g.band.top && y <= g.band.bottom ? CORAL : WHITE;
  return INK;
}

function render(size) {
  const g = size <= 32 ? GEOMETRY.small : GEOMETRY.regular;
  const pixels = Buffer.alloc(size * size * 4);
  const unit = 128 / size;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, gr = 0, b = 0, a = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const colour = colourAt((px + (sx + 0.5) / SAMPLES) * unit, (py + (sy + 0.5) / SAMPLES) * unit, g);
          if (!colour) continue;
          r += colour[0];
          gr += colour[1];
          b += colour[2];
          a++;
        }
      }
      const i = (py * size + px) * 4;
      if (a) {
        // Average only covered samples (straight alpha), then store coverage as alpha.
        pixels[i] = Math.round(r / a);
        pixels[i + 1] = Math.round(gr / a);
        pixels[i + 2] = Math.round(b / a);
      }
      pixels[i + 3] = Math.round((a / (SAMPLES * SAMPLES)) * 255);
    }
  }
  return pixels;
}

// --- Minimal PNG encoder ----------------------------------------------------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    rows[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(OUT, { recursive: true });
for (const size of SIZES) {
  const file = path.join(OUT, `icon${size}.png`);
  writeFileSync(file, encodePng(size, render(size)));
  console.log(`wrote ${path.relative(process.cwd(), file)}`);
}
