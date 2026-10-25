/**
 * icons.mjs: procedural app icons for the PWA manifest (build tooling).
 *
 * Pet Studio ships no image assets, so the home-screen icons are drawn here
 * at build time: an original pink bunny pet on a warm pastel tile, rendered
 * from signed-distance shapes with analytic anti-aliasing and written as PNG
 * with node:zlib (no dependencies). build.mjs writes:
 *   icons/icon-192.png, icons/icon-512.png        purpose "any" (rounded tile)
 *   icons/icon-maskable-512.png                    purpose "maskable" (full bleed,
 *                                                  pet inside the 80% safe zone)
 *   icons/apple-touch-icon.png                     180 x 180 (iOS home screen)
 */
import { deflateSync } from 'node:zlib';

// ---------------------------------------------------------------------------
// PNG encoding (RGBA, 8 bits per channel, no filtering)
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

export function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Tiny signed-distance rasteriser (unit coordinates, y down)
// ---------------------------------------------------------------------------
const hex = (h, a = 1) => {
  const v = parseInt(h.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255, a];
};

function ellipseSd(px, py, cx, cy, rx, ry, rot = 0) {
  let x = px - cx;
  let y = py - cy;
  if (rot) {
    const c = Math.cos(rot);
    const s = Math.sin(rot);
    [x, y] = [x * c + y * s, -x * s + y * c];
  }
  const k = Math.hypot(x / rx, y / ry);
  return (k - 1) * Math.min(rx, ry);
}

function roundRectSd(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - hw + r;
  const qy = Math.abs(py - cy) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

function arcSd(px, py, cx, cy, r, a0, a1, w) {
  let a = Math.atan2(py - cy, px - cx);
  if (a < a0 - Math.PI) a += Math.PI * 2;
  if (a >= a0 && a <= a1) return Math.abs(Math.hypot(px - cx, py - cy) - r) - w / 2;
  const d0 = Math.hypot(px - (cx + r * Math.cos(a0)), py - (cy + r * Math.sin(a0)));
  const d1 = Math.hypot(px - (cx + r * Math.cos(a1)), py - (cy + r * Math.sin(a1)));
  return Math.min(d0, d1) - w / 2;
}

const ebox = (cx, cy, rx, ry, pad = 0) => {
  const r = Math.max(rx, ry) + pad + 0.01;
  return [cx - r, cy - r, cx + r, cy + r];
};

/** The pet, as a list of layers: [signed distance (u, v) -> number, colour or (u, v) -> colour, bounding box?]. */
function petLayers({ inset = 0, tile = 'rounded' }) {
  const s = 1 - 2 * inset; // content scale (maskable icons keep the pet in the safe zone)
  const P = (u) => inset + u * s;
  const L = (v) => v * s;
  const OUT = hex('#3d2838');
  const BODY = hex('#ffb8c9');
  const layers = [];
  const bg = (u, v) => {
    const t = Math.min(1, Math.max(0, v));
    const top = [255, 244, 230];
    const bottom = [246, 214, 230];
    return [top[0] + (bottom[0] - top[0]) * t, top[1] + (bottom[1] - top[1]) * t, top[2] + (bottom[2] - top[2]) * t, 1];
  };
  if (tile === 'rounded') layers.push([(u, v) => roundRectSd(u, v, 0.5, 0.5, 0.5, 0.5, 0.22), bg]);
  else layers.push([() => -1, bg]);
  // Warm sun disc and a sparkle behind the pet.
  const ell = (cx, cy, rx, ry, color, rot = 0, grow = 0) => layers.push([
    (u, v) => ellipseSd(u, v, P(cx), P(cy), L(rx), L(ry), rot) - grow, color, ebox(P(cx), P(cy), L(rx), L(ry), grow),
  ]);
  const w = L(0.02);
  const outlined = (cx, cy, rx, ry, rot = 0) => {
    ell(cx, cy, rx, ry, OUT, rot, w);
    ell(cx, cy, rx, ry, BODY, rot);
  };
  ell(0.5, 0.56, 0.36, 0.36, hex('#ffe3c8', 0.85));
  for (const [cx, cy, a, b, c] of [[0.8, 0.2, 0.012, 0.055, '#ffc04d'], [0.2, 0.3, 0.008, 0.035, '#b9a6ff']]) {
    layers.push([(u, v) => Math.min(ellipseSd(u, v, P(cx), P(cy), L(a), L(b)), ellipseSd(u, v, P(cx), P(cy), L(b), L(a))), hex(c), ebox(P(cx), P(cy), L(b), L(b))]);
  }
  ell(0.5, 0.885, 0.25, 0.045, hex('#a0647a', 0.2)); // ground shadow
  for (const side of [-1, 1]) {
    outlined(0.5 + side * 0.125, 0.25, 0.07, 0.165, side * 0.14); // bunny ears
    ell(0.5 + side * 0.125, 0.265, 0.032, 0.115, hex('#ff93ae'), side * 0.14);
  }
  outlined(0.5, 0.76, 0.19, 0.135); // body
  ell(0.5, 0.79, 0.11, 0.085, hex('#fff1dc')); // tummy
  outlined(0.5, 0.52, 0.27, 0.235); // head
  for (const side of [-1, 1]) {
    ell(0.5 + side * 0.165, 0.585, 0.05, 0.03, hex('#ff7d9c', 0.55)); // cheeks
    ell(0.5 + side * 0.09, 0.5, 0.03, 0.043, hex('#2b2034')); // eyes
    ell(0.5 + side * 0.09 - 0.009, 0.486, 0.01, 0.012, hex('#ffffff'));
  }
  layers.push([(u, v) => arcSd(u, v, P(0.5), P(0.548), L(0.04), Math.PI * 0.18, Math.PI * 0.82, L(0.016)), hex('#2b2034'), ebox(P(0.5), P(0.548), L(0.06), L(0.06))]);
  return layers;
}

/** Renders the icon at `size` px (RGBA bytes). `maskable` = full bleed with the pet inside the safe zone. */
export function renderIcon(size, { maskable = false } = {}) {
  const layers = petLayers(maskable ? { inset: 0.11, tile: 'square' } : { inset: 0.02, tile: 'rounded' });
  const out = new Uint8Array(size * size * 4);
  const px = 1 / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) * px;
      const v = (y + 0.5) * px;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (const [sd, color, box] of layers) {
        if (box && (u < box[0] || v < box[1] || u > box[2] || v > box[3])) continue;
        const d = sd(u, v);
        const cov = Math.min(1, Math.max(0, 0.5 - d / px));
        if (cov <= 0) continue;
        const c = typeof color === 'function' ? color(u, v) : color;
        const sa = cov * c[3];
        r = c[0] * sa + r * (1 - sa);
        g = c[1] * sa + g * (1 - sa);
        b = c[2] * sa + b * (1 - sa);
        a = sa + a * (1 - sa);
      }
      const i = (y * size + x) * 4;
      // Colours accumulate premultiplied: un-premultiply for PNG.
      out[i] = a > 0 ? Math.round(Math.min(255, r / a)) : 0;
      out[i + 1] = a > 0 ? Math.round(Math.min(255, g / a)) : 0;
      out[i + 2] = a > 0 ? Math.round(Math.min(255, b / a)) : 0;
      out[i + 3] = Math.round(a * 255);
    }
  }
  return out;
}

export const ICONS = Object.freeze([
  { file: 'icon-192.png', size: 192 },
  { file: 'icon-512.png', size: 512 },
  { file: 'icon-maskable-512.png', size: 512, maskable: true },
  { file: 'apple-touch-icon.png', size: 180, maskable: true },
]);

/** PNG buffers for every manifest icon: [{ file, png }]. */
export function buildIcons() {
  return ICONS.map(({ file, size, maskable }) => ({ file, png: encodePng(size, size, renderIcon(size, { maskable })) }));
}
