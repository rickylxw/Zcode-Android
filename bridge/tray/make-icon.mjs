// 一次性工具：生成 src-tauri/icons/icon.ico（深色圆角底 + 蓝色 Z，16/32/48 三档）。
// 用法：node make-icon.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'src-tauri', 'icons');
fs.mkdirSync(outDir, { recursive: true });

// 点到线段距离（归一化坐标）
function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function drawPixel(nx, ny) {
  // 背景：圆角方 #1b202b
  const r = 0.16;
  const cx = Math.max(r, Math.min(1 - r, nx));
  const cy = Math.max(r, Math.min(1 - r, ny));
  const insideBg = Math.hypot(nx - cx, ny - cy) <= r;
  if (!insideBg) return [0, 0, 0, 0];

  // Z 字：上横杠、下横杠、对角线（#5b9bff）
  const inBar = (nx > 0.24 && nx < 0.76) && (ny < 0.335 || ny > 0.665);
  const d = distToSeg(nx, ny, 0.72, 0.335, 0.28, 0.665);
  if (inBar || d < 0.075) return [0xff, 0x9b, 0x5b, 0xff]; // BGRA → B,G,R,A：蓝 #5b9bff

  return [0x2b, 0x20, 0x1b, 0xff]; // BGRA：#1b202b
}

function makeImage(size) {
  const xor = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // ICO 像素自底向上
      const [b, g, r, a] = drawPixel((x + 0.5) / size, (size - 1 - y + 0.5) / size);
      const o = (y * size + x) * 4;
      xor[o] = b; xor[o + 1] = g; xor[o + 2] = r; xor[o + 3] = a;
    }
  }
  const andMask = Buffer.alloc(Math.ceil(size / 32) * 4 * size); // 全 0：alpha 已在 XOR 里
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // XOR + AND
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  return Buffer.concat([header, xor, andMask]);
}

const sizes = [16, 32, 48];
const images = sizes.map(makeImage);
const dir = Buffer.alloc(6);
dir.writeUInt16LE(0, 0);
dir.writeUInt16LE(1, 2); // type: icon
dir.writeUInt16LE(sizes.length, 4);

const entries = [];
let offset = 6 + sizes.length * 16;
for (let i = 0; i < sizes.length; i++) {
  const e = Buffer.alloc(16);
  e.writeUInt8(sizes[i] === 256 ? 0 : sizes[i], 0);
  e.writeUInt8(sizes[i] === 256 ? 0 : sizes[i], 1);
  e.writeUInt8(0, 2);
  e.writeUInt8(0, 3);
  e.writeUInt16LE(1, 4);
  e.writeUInt16LE(32, 6);
  e.writeUInt32LE(images[i].length, 8);
  e.writeUInt32LE(offset, 12);
  offset += images[i].length;
  entries.push(e);
}

const out = path.join(outDir, 'icon.ico');
fs.writeFileSync(out, Buffer.concat([dir, ...entries, ...images]));
console.log('icon.ico written:', fs.statSync(out).size, 'bytes');
