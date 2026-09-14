#!/usr/bin/env node
// Draws the app icon (a great-circle leg between two airports, the same mark the map uses)
// and writes the PNG sizes a PWA install needs. No image libraries: shapes are rasterized
// with 4x4 supersampling and encoded as PNG with the built-in zlib.
// Usage: node scripts/make-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const GROUND_TOP = hex('#20262a'), GROUND_BOTTOM = hex('#101311'), LIMB = hex('#2f3a37'), ARC = hex('#5598e7'), DOT = hex('#ffffff');

// Unit-square geometry, y down. A leg sweeping from the lower left to the upper right.
const A = [0.215, 0.70], B = [0.80, 0.38], CTRL = [0.47, 0.20];
const bez = (t) => { const u = 1 - t; return [u * u * A[0] + 2 * u * t * CTRL[0] + t * t * B[0], u * u * A[1] + 2 * u * t * CTRL[1] + t * t * B[1]]; };
const ARCPTS = Array.from({ length: 81 }, (_, i) => bez(i / 80));

function distToPolyline(p, pts) {
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const [x1, y1] = pts[i - 1], [x2, y2] = pts[i];
    const dx = x2 - x1, dy = y2 - y1, len2 = dx * dx + dy * dy;
    let t = len2 ? ((p[0] - x1) * dx + (p[1] - y1) * dy) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const ex = p[0] - (x1 + t * dx), ey = p[1] - (y1 + t * dy);
    const d = Math.sqrt(ex * ex + ey * ey);
    if (d < best) best = d;
  }
  return best;
}
const dist = (p, c) => Math.hypot(p[0] - c[0], p[1] - c[1]);

/** Content in unit coords, scaled about the center so maskable icons keep clear of the crop. */
function sample(x, y, s) {
  const p = [0.5 + (x - 0.5) / s, 0.5 + (y - 0.5) / s];
  const px = [];
  // earth's limb: a big circle centred far below, catching the lower corners
  const limb = Math.abs(dist(p, [0.5, 2.06]) - 1.28);
  if (limb < 0.012) px.push([LIMB, 1]);
  if (distToPolyline(p, ARCPTS) < 0.040) px.push([ARC, 1]);
  if (dist(p, A) < 0.062) px.push([DOT, 1]);
  if (dist(p, B) < 0.072) px.push([DOT, 1]);
  return px.length ? px[px.length - 1][0] : null;
}

function render(size, contentScale) {
  const SS = 4, buf = Buffer.alloc(size * size * 3);
  for (let py = 0; py < size; py++) {
    const g = py / (size - 1);
    const bg = [0, 1, 2].map((i) => Math.round(GROUND_TOP[i] + (GROUND_BOTTOM[i] - GROUND_TOP[i]) * g));
    for (let px = 0; px < size; px++) {
      let r = 0, gg = 0, b = 0;
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
        const c = sample((px + (sx + 0.5) / SS) / size, (py + (sy + 0.5) / SS) / size, contentScale) || bg;
        r += c[0]; gg += c[1]; b += c[2];
      }
      const o = (py * size + px) * 3, n = SS * SS;
      buf[o] = Math.round(r / n); buf[o + 1] = Math.round(gg / n); buf[o + 2] = Math.round(b / n);
    }
  }
  return buf;
}

function png(size, rgb) {
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) { raw[y * (size * 3 + 1)] = 0; rgb.copy(raw, y * (size * 3 + 1) + 1, y * size * 3, (y + 1) * size * 3); }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const byte of b) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

mkdirSync(resolve(ROOT, 'icons'), { recursive: true });
const jobs = [['icons/icon-192.png', 192, 1], ['icons/icon-512.png', 512, 1], ['icons/maskable-512.png', 512, 0.72], ['icons/apple-touch-icon.png', 180, 0.86], ['icons/icon-32.png', 32, 1]];
for (const [file, size, scale] of jobs) {
  writeFileSync(resolve(ROOT, file), png(size, render(size, scale)));
  console.log(`wrote ${file} (${size}px)`);
}

// Vector twin, for browsers that prefer it and for crisp tab icons.
const path = ARCPTS.map(([x, y], i) => `${i ? 'L' : 'M'}${(x * 512).toFixed(1)} ${(y * 512).toFixed(1)}`).join('');
writeFileSync(resolve(ROOT, 'icons/icon.svg'), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#20262a"/><stop offset="1" stop-color="#101311"/></linearGradient>
  <clipPath id="c"><rect width="512" height="512"/></clipPath></defs>
  <rect width="512" height="512" fill="url(#g)"/>
  <g clip-path="url(#c)"><circle cx="256" cy="1055" r="655" fill="none" stroke="#2f3a37" stroke-width="12"/></g>
  <path d="${path}" fill="none" stroke="#5598e7" stroke-width="41" stroke-linecap="round"/>
  <circle cx="${(A[0] * 512).toFixed(1)}" cy="${(A[1] * 512).toFixed(1)}" r="32" fill="#ffffff"/>
  <circle cx="${(B[0] * 512).toFixed(1)}" cy="${(B[1] * 512).toFixed(1)}" r="37" fill="#ffffff"/>
</svg>
`);
console.log('wrote icons/icon.svg');
