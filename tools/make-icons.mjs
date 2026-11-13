#!/usr/bin/env node
// Writes app/icons/*.png and icon.svg: a green square with a white magnifying glass. Node stdlib only.
// Run: node tools/make-icons.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'app', 'icons');
mkdirSync(out, { recursive: true });
const BG = [0x2f, 0x7d, 0x4f], FG = [0xff, 0xff, 0xff];

// Shape in a 0..1 unit square. inset: 0 for normal icons, larger for maskable (safe zone).
function coverage(x, y, size, rounded, inset) {
  // background: rounded square (or full square for maskable)
  const r = rounded ? 0.18 : 0;
  const inBg = (() => {
    if (!r) return true;
    const cx = Math.min(Math.max(x, r), 1 - r), cy = Math.min(Math.max(y, r), 1 - r);
    return Math.hypot(x - cx, y - cy) <= r;
  })();
  if (!inBg) return null;
  // magnifier: ring + handle, scaled into the inset box
  const s = 1 - 2 * inset;
  const u = (x - inset) / s, v = (y - inset) / s;
  const cx = 0.43, cy = 0.43, R = 0.22, W = 0.075;
  const d = Math.hypot(u - cx, v - cy);
  if (Math.abs(d - R) <= W / 1) return 'fg';
  // handle along the diagonal from the ring towards bottom right
  const t = ((u - cx) + (v - cy)) / Math.SQRT2;
  const n = Math.abs((u - cx) - (v - cy)) / Math.SQRT2;
  if (t >= R && t <= R + 0.26 && n <= 0.07) return 'fg';
  return 'bg';
}

function png(size, rounded, inset) {
  const SS = 4; // supersampling
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let fg = 0, bg = 0;
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
        const c = coverage((x + (sx + 0.5) / SS) / size, (y + (sy + 0.5) / SS) / size, size, rounded, inset);
        if (c === 'fg') fg++; else if (c === 'bg') bg++;
      }
      const n = SS * SS, a = (fg + bg) / n;
      const o = y * (size * 4 + 1) + 1 + x * 4;
      for (let k = 0; k < 3; k++) raw[o + k] = a ? Math.round((FG[k] * fg + BG[k] * bg) / (fg + bg)) : 0;
      raw[o + 3] = Math.round(a * 255);
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

writeFileSync(join(out, 'icon-192.png'), png(192, true, 0));
writeFileSync(join(out, 'icon-512.png'), png(512, true, 0));
writeFileSync(join(out, 'icon-maskable-512.png'), png(512, false, 0.12));
writeFileSync(join(out, 'icon.svg'), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
<rect width="100" height="100" rx="18" fill="#2f7d4f"/>
<circle cx="43" cy="43" r="22" fill="none" stroke="#fff" stroke-width="15"/>
<path d="M58.6 58.6 L77 77" stroke="#fff" stroke-width="14" stroke-linecap="butt"/>
</svg>
`);
console.log(`icons written to ${out}`);
