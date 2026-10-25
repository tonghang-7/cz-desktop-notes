import zlib from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0;
    rgba.copy(raw, y * stride + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

function sdRoundBox(px, py, hw, hh, r) {
  const dx = Math.abs(px) - (hw - r);
  const dy = Math.abs(py) - (hh - r);
  const ax = Math.max(dx, 0);
  const ay = Math.max(dy, 0);
  return Math.sqrt(ax * ax + ay * ay) + Math.min(Math.max(dx, dy), 0) - r;
}

function sdSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const t = clamp01((wx * vx + wy * vy) / (vx * vx + vy * vy));
  const ddx = wx - vx * t;
  const ddy = wy - vy * t;
  return Math.sqrt(ddx * ddx + ddy * ddy);
}

function pointInTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

function render(size) {
  const buf = Buffer.alloc(size * size * 4);
  const aa = 1.4 / size;
  const hw = 0.44;
  const hh = 0.44;
  const radius = 0.11;
  const foldX = 0.62;
  const foldY = 0.06;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = (x + 0.5) / size - 0.5;
      const py = (y + 0.5) / size - 0.5;
      const i = (y * size + x) * 4;

      const d = sdRoundBox(px, py, hw, hh, radius);
      const bodyA = clamp01(0.5 - d / aa);
      if (bodyA <= 0) continue;

      let r = 251;
      let g = 191;
      let b = 36;

      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;
      const inFold = pointInTriangle(u, v, foldX, foldY, 0.94, foldY, 0.94, 0.38);
      if (inFold) {
        r = 217;
        g = 119;
        b = 6;
      }

      const lineW = 0.035;
      const lines = [
        [0.2, 0.42, 0.72, 0.42],
        [0.2, 0.56, 0.72, 0.56],
        [0.2, 0.7, 0.58, 0.7],
      ];
      let lineA = 0;
      for (const [ax, ay, bx, by] of lines) {
        const ld = sdSegment(u, v, ax, ay, bx, by) - lineW;
        lineA = Math.max(lineA, clamp01(0.5 - ld / aa));
      }
      if (lineA > 0) {
        const k = lineA * 0.55;
        r = r * (1 - k) + 120 * k;
        g = g * (1 - k) + 53 * k;
        b = b * (1 - k) + 15 * k;
      }

      buf[i] = Math.round(r);
      buf[i + 1] = Math.round(g);
      buf[i + 2] = Math.round(b);
      buf[i + 3] = Math.round(bodyA * 255);
    }
  }
  return buf;
}

const outDir = path.join(process.cwd(), 'assets');
mkdirSync(outDir, { recursive: true });

for (const [name, size] of [
  ['icon.png', 256],
  ['tray.png', 16],
  ['tray@2x.png', 32],
]) {
  writeFileSync(path.join(outDir, name), encodePng(size, size, render(size)));
  console.log('wrote assets/' + name);
}
