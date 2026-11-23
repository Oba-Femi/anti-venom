/**
 * Renders the toolbar/store icons procedurally (shield + check mark) and
 * encodes them as PNG with zlib, so the repo needs no binary assets or image
 * tooling. "off" variants are greyscale for the paused / allowlisted state.
 */
import { deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function encodePng(size: number, rgba: Uint8Array): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0; // filter: none
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * stride + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', new Uint8Array()),
  ]);
}

function inShield(x: number, y: number): boolean {
  const cx = 0.5;
  const half = 0.4;
  const top = 0.07 + 0.05 * ((x - cx) / half) ** 2;
  if (y < top) return false;
  if (y <= 0.5) return Math.abs(x - cx) <= half;
  const t = (y - 0.5) / 0.44;
  if (t >= 1) return false;
  return Math.abs(x - cx) <= half * Math.sqrt(1 - t * t) * (1 - 0.25 * t);
}

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function inCheck(x: number, y: number, stroke: number): boolean {
  return distToSegment(x, y, 0.31, 0.47, 0.45, 0.61) < stroke || distToSegment(x, y, 0.45, 0.61, 0.7, 0.34) < stroke;
}

type RGB = [number, number, number];

function render(size: number, top: RGB, bottom: RGB): Uint8Array {
  const out = new Uint8Array(size * size * 4);
  const ss = 4; // supersampling factor per axis
  const stroke = size <= 16 ? 0.085 : 0.07;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let cover = 0;
      let white = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const x = (px + (sx + 0.5) / ss) / size;
          const y = (py + (sy + 0.5) / ss) / size;
          if (inShield(x, y)) {
            cover++;
            if (inCheck(x, y, stroke)) white++;
          }
        }
      }
      if (!cover) continue;
      const i = (py * size + px) * 4;
      const g = py / size;
      const w = white / cover;
      for (let k = 0; k < 3; k++) {
        const base = top[k]! + (bottom[k]! - top[k]!) * g;
        out[i + k] = Math.round(base * (1 - w) + 255 * w);
      }
      out[i + 3] = Math.round((255 * cover) / (ss * ss));
    }
  }
  return out;
}

export async function generateIcons(outDir: string): Promise<void> {
  const dir = join(outDir, 'icons');
  await mkdir(dir, { recursive: true });
  const variants: Record<string, [RGB, RGB]> = {
    on: [[34, 197, 140], [12, 122, 96]],
    off: [[160, 166, 176], [104, 110, 120]],
  };
  for (const [name, [top, bottom]] of Object.entries(variants)) {
    for (const size of [16, 32, 48, 128]) {
      await writeFile(join(dir, `${name}-${size}.png`), encodePng(size, render(size, top, bottom)));
    }
  }
}
