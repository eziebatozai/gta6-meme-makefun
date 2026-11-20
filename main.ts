// main.ts - gta6-meme-x-01 (make.fun)
// Meme generator: Node 22.18+, stdlib only (node:zlib, node:fs, node:path), no network.
// Renders PNG memes with the make.fun ghost (official press kit icon, embedded as base64).
//
// Usage:
//   node main.ts                -> renders the default (featured) meme to output.png
//   node main.ts <id>           -> renders one variation to draft/<id>.png
//   node main.ts all            -> renders every variation to draft/
//   node main.ts list           -> lists variation ids + captions
//   node main.ts fontsheet      -> renders the embedded 5x7 font to draft/fontsheet.png

import zlib from "node:zlib";
import fs from "node:fs";
import path from "node:path";

// ---------- palette (make.fun press kit palette.txt + Vice City night) ----------
const MAGENTA = [196, 28, 131];    // #C41C83 brand magenta
const MAGENTA_LT = [255, 136, 196]; // #FF88C4 magenta ink (dark mode)
const INK = [224, 229, 239];       // #E0E5EF dark-mode text
const BLACK = [17, 20, 27];        // #11141B dark canvas
const NIGHT = [0, 0, 0];
const WHITE = [255, 255, 255];

type RGB = [number, number, number];

// ---------- canvas ----------
class Canvas {
  w: number; h: number; px: Uint8Array;
  constructor(w: number, h: number, bg: RGB = BLACK) {
    this.w = w; this.h = h;
    this.px = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) { this.px[i*3] = bg[0]; this.px[i*3+1] = bg[1]; this.px[i*3+2] = bg[2]; }
  }
  set(x: number, y: number, c: RGB, a = 255) {
    x = Math.floor(x); y = Math.floor(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 3, t = a / 255;
    this.px[i]   = Math.round(this.px[i]   * (1 - t) + c[0] * t);
    this.px[i+1] = Math.round(this.px[i+1] * (1 - t) + c[1] * t);
    this.px[i+2] = Math.round(this.px[i+2] * (1 - t) + c[2] * t);
  }
  fillRect(x: number, y: number, w: number, h: number, c: RGB) {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) this.set(xx, yy, c);
  }
  fillCircle(cx: number, cy: number, r: number, c: RGB) {
    for (let yy = Math.floor(cy - r); yy <= cy + r; yy++) {
      const dx = Math.sqrt(Math.max(0, r*r - (yy-cy)*(yy-cy)));
      for (let xx = Math.floor(cx - dx); xx <= Math.ceil(cx + dx); xx++) this.set(xx, yy, c);
    }
  }
  ring(cx: number, cy: number, r: number, t: number, c: RGB) {
    for (let yy = Math.floor(cy - r - t); yy <= cy + r + t; yy++)
      for (let xx = Math.floor(cx - r - t); xx <= cx + r + t; xx++) {
        const d = Math.hypot(xx - cx, yy - cy);
        if (d >= r - t && d <= r + t) this.set(xx, yy, c);
      }
  }
  // even-odd scanline polygon fill (non-self-intersecting polygons)
  fillPoly(pts: number[][], c: RGB) {
    let y0 = Infinity, y1 = -Infinity;
    for (const p of pts) { y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
    for (let y = Math.floor(y0); y <= Math.ceil(y1); y++) {
      const xs: number[] = [];
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        if ((a[1] <= y && b[1] > y) || (b[1] <= y && a[1] > y))
          xs.push(a[0] + (y - a[1]) / (b[1] - a[1]) * (b[0] - a[0]));
      }
      xs.sort((m, n) => m - n);
      for (let k = 0; k + 1 < xs.length; k += 2)
        for (let x = Math.ceil(xs[k]); x < xs[k+1]; x++) this.set(x, y, c);
    }
  }
  // thick line via polygon quad
  line(x1: number, y1: number, x2: number, y2: number, t: number, c: RGB) {
    const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1;
    const ox = -dy / len * t / 2, oy = dx / len * t / 2;
    this.fillPoly([[x1+ox,y1+oy],[x2+ox,y2+oy],[x2-ox,y2-oy],[x1-ox,y1-oy]], c);
  }
  star5(cx: number, cy: number, ro: number, ri: number, c: RGB, rot = -Math.PI / 2) {
    const pts: number[][] = [];
    for (let i = 0; i < 10; i++) {
      const r = i % 2 === 0 ? ro : ri, a = rot + i * Math.PI / 5;
      pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
    this.fillPoly(pts, c);
  }
  // vertical gradient between two colors
  gradient(x: number, y: number, w: number, h: number, top: RGB, bottom: RGB) {
    for (let yy = 0; yy < h; yy++) {
      const t = yy / Math.max(1, h - 1);
      const c: RGB = [top[0]+(bottom[0]-top[0])*t, top[1]+(bottom[1]-top[1])*t, top[2]+(bottom[2]-top[2])*t].map(Math.round) as RGB;
      this.fillRect(x, y + yy, w, 1, c);
    }
  }
  // blend a decoded RGBA sprite with nearest-neighbor scaling (whole-pixel box scale)
  blit(spr: Sprite, x: number, y: number, dw: number, dh: number) {
    const sx = spr.w / dw, sy = spr.h / dh;
    for (let dy = 0; dy < dh; dy++) {
      const syy = Math.min(spr.h - 1, Math.floor(dy * sy));
      for (let dx = 0; dx < dw; dx++) {
        const sxx = Math.min(spr.w - 1, Math.floor(dx * sx));
        const i = (syy * spr.w + sxx) * 4;
        this.set(x + dx, y + dy, [spr.px[i], spr.px[i+1], spr.px[i+2]], spr.px[i+3]);
      }
    }
  }
}

// ---------- PNG encode (RGB, filter 1 for compression) ----------
function crc32(buf: Uint8Array): number {
  let c: number; const table: number[] = [];
  for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePNG(cv: Canvas): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(cv.w, 0); ihdr.writeUInt32BE(cv.h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  // filter 1 (sub) per scanline for better deflate
  const raw = Buffer.alloc(cv.h * (cv.w * 3 + 1));
  for (let y = 0; y < cv.h; y++) {
    const row = y * (cv.w * 3 + 1);
    raw[row] = 1;
    for (let i = 0; i < cv.w * 3; i++) {
      const cur = cv.px[y * cv.w * 3 + i];
      const left = i >= 3 ? cv.px[y * cv.w * 3 + i - 3] : 0;
      raw[row + 1 + i] = (cur - left) & 0xff;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

// ---------- PNG decode (RGBA/RGB 8-bit, all filters, non-interlaced) ----------
interface Sprite { w: number; h: number; px: Uint8Array; }
function decodePNG(buf: Buffer): Sprite {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a png");
  let off = 8, w = 0, h = 0, ct = 0; const idat: Buffer[] = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off), type = buf.toString("ascii", off + 4, off + 8), d = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") { w = d.readUInt32BE(0); h = d.readUInt32BE(4); ct = d[9]; }
    else if (type === "IDAT") idat.push(d);
    off += 12 + len;
    if (type === "IEND") break;
  }
  const bpp = ct === 6 ? 4 : ct === 2 ? 3 : ct === 4 ? 2 : 1;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const out = new Uint8Array(w * h * 4);
  const prev = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const rec = new Uint8Array(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? rec[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      rec[i] = v & 0xff;
    }
    prev.set(rec);
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4, s = x * bpp;
      out[o]   = ct === 2 || ct === 6 ? rec[s] : ct === 4 ? rec[s] : rec[s];
      out[o+1] = ct === 2 || ct === 6 ? rec[s+1] : ct === 4 ? rec[s] : rec[s];
      out[o+2] = ct === 2 || ct === 6 ? rec[s+2] : ct === 4 ? rec[s] : rec[s];
      out[o+3] = ct === 6 ? rec[s+3] : 255;
    }
  }
  return { w, h, px: out };
}

// ---------- 5x7 bitmap font ----------
// each glyph: 7 rows of 5 chars ("X" = on). Verified visually via `node main.ts fontsheet`.
const FONT: Record<string, string[]> = {
  "A": [".XXX.", "X...X", "X...X", "XXXXX", "X...X", "X...X", "X...X"],
  "B": ["XXXX.", "X...X", "X...X", "XXXX.", "X...X", "X...X", "XXXX."],
  "C": [".XXXX", "X....", "X....", "X....", "X....", "X....", ".XXXX"],
  "D": ["XXXX.", "X...X", "X...X", "X...X", "X...X", "X...X", "XXXX."],
  "E": ["XXXXX", "X....", "X....", "XXXX.", "X....", "X....", "XXXXX"],
  "F": ["XXXXX", "X....", "X....", "XXXX.", "X....", "X....", "X...."],
  "G": [".XXXX", "X....", "X....", "X..XX", "X...X", "X...X", ".XXXX"],
  "H": ["X...X", "X...X", "X...X", "XXXXX", "X...X", "X...X", "X...X"],
  "I": ["XXXXX", "..X..", "..X..", "..X..", "..X..", "..X..", "XXXXX"],
  "J": ["..XXX", "...X.", "...X.", "...X.", "...X.", "X..X.", ".XX.."],
  "K": ["X...X", "X..X.", "X.X..", "XX...", "X.X..", "X..X.", "X...X"],
  "L": ["X....", "X....", "X....", "X....", "X....", "X....", "XXXXX"],
  "M": ["X...X", "XX.XX", "X.X.X", "X.X.X", "X...X", "X...X", "X...X"],
  "N": ["X...X", "XX..X", "X.X.X", "X..XX", "X...X", "X...X", "X...X"],
  "O": [".XXX.", "X...X", "X...X", "X...X", "X...X", "X...X", ".XXX."],
  "P": ["XXXX.", "X...X", "X...X", "XXXX.", "X....", "X....", "X...."],
  "Q": [".XXX.", "X...X", "X...X", "X...X", "X.X.X", "X..X.", ".X.XX"],
  "R": ["XXXX.", "X...X", "X...X", "XXXX.", "X.X..", "X..X.", "X...X"],
  "S": [".XXXX", "X....", "X....", ".XXX.", "....X", "....X", "XXXX."],
  "T": ["XXXXX", "..X..", "..X..", "..X..", "..X..", "..X..", "..X.."],
  "U": ["X...X", "X...X", "X...X", "X...X", "X...X", "X...X", ".XXX."],
  "V": ["X...X", "X...X", "X...X", "X...X", "X...X", ".X.X.", "..X.."],
  "W": ["X...X", "X...X", "X...X", "X.X.X", "X.X.X", "XX.XX", "X...X"],
  "X": ["X...X", "X...X", ".X.X.", "..X..", ".X.X.", "X...X", "X...X"],
  "Y": ["X...X", "X...X", ".X.X.", "..X..", "..X..", "..X..", "..X.."],
  "Z": ["XXXXX", "....X", "...X.", "..X..", ".X...", "X....", "XXXXX"],
  "0": [".XXX.", "X...X", "X..XX", "X.X.X", "XX..X", "X...X", ".XXX."],
  "1": ["..X..", ".XX..", "..X..", "..X..", "..X..", "..X..", ".XXX."],
  "2": [".XXX.", "X...X", "....X", "...X.", "..X..", ".X...", "XXXXX"],
  "3": ["XXXX.", "....X", "....X", ".XXX.", "....X", "....X", "XXXX."],
  "4": ["...X.", "..XX.", ".X.X.", "X..X.", "XXXXX", "...X.", "...X."],
  "5": ["XXXXX", "X....", "X....", "XXXX.", "....X", "....X", "XXXX."],
  "6": [".XXX.", "X....", "X....", "XXXX.", "X...X", "X...X", ".XXX."],
  "7": ["XXXXX", "....X", "...X.", "..X..", ".X...", ".X...", ".X..."],
  "8": [".XXX.", "X...X", "X...X", ".XXX.", "X...X", "X...X", ".XXX."],
  "9": [".XXX.", "X...X", "X...X", ".XXXX", "....X", "....X", ".XXX."],
  " ": [".....", ".....", ".....", ".....", ".....", ".....", "....."],
  ".": [".....", ".....", ".....", ".....", ".....", ".XX..", ".XX.."],
  ",": [".....", ".....", ".....", ".....", ".XX..", ".XX..", ".X..."],
  "!": ["..X..", "..X..", "..X..", "..X..", "..X..", ".....", "..X.."],
  "?": [".XXX.", "X...X", "....X", "..XX.", ".....", "..X..", "..X.."],
  "'": ["..X..", "..X..", ".....", ".....", ".....", ".....", "....."],
  '"': [".X.X.", ".X.X.", ".X.X.", ".....", ".....", ".....", "....."],
  ":": [".....", ".....", ".XX..", ".XX..", ".....", ".XX..", ".XX.."],
  ";": [".....", ".....", ".XX..", ".XX..", ".....", ".XX..", ".X..."],
  "-": [".....", ".....", ".....", "XXXXX", ".....", ".....", "....."],
  "+": [".....", "..X..", "..X..", "XXXXX", "..X..", "..X..", "....."],
  "/": ["....X", "....X", "...X.", "..X..", ".X...", "X....", "X...."],
  "$": ["..X..", ".XXXX", "X.X..", ".XXX.", "..X.X", "XXXX.", "..X.."],
  "&": [".XX..", "X..X.", "X.X..", ".X...", "X.X.X", "X..X.", ".XX.X"],
  "#": [".X.X.", "X.X.X", "XXXXX", ".X.X.", "XXXXX", "X.X.X", ".X.X."],
  "%": ["X...X", "X..X.", "..X..", "..X..", "..X..", ".X..X", "X...X"],
  "*": [".....", "X...X", ".X.X.", "..X..", ".X.X.", "X...X", "....."],
  "=": [".....", ".....", "XXXXX", ".....", "XXXXX", ".....", "....."],
  ">": ["X....", ".X...", "..X..", "...X.", "..X..", ".X...", "X...."],
  "<": ["....X", ".X...", "..X..", "X....", "..X..", ".X...", "....X"],
  "(": ["...X.", "..X..", ".X...", ".X...", ".X...", "..X..", "...X."],
  ")": [".X...", "..X..", "...X.", "...X.", "...X.", "..X..", ".X..."],
  "@": [".XXX.", "X...X", "X.XXX", "X.X.X", "X.XXX", "X....", ".XXX."],
  "_": [".....", ".....", ".....", ".....", ".....", ".....", "XXXXX"],
  "a": [".....", ".....", ".XXX.", "....X", ".XXXX", "X...X", ".XXXX"],
  "b": ["X....", "X....", "XXXX.", "X...X", "X...X", "X...X", "XXXX."],
  "c": [".....", ".....", ".XXXX", "X....", "X....", "X....", ".XXXX"],
  "d": ["....X", "....X", ".XXXX", "X...X", "X...X", "X...X", ".XXXX"],
  "e": [".....", ".....", ".XXX.", "X...X", "XXXXX", "X....", ".XXXX"],
  "f": ["..XX.", ".X...", ".X...", "XXXX.", ".X...", ".X...", ".X..."],
  "g": [".....", ".XXXX", "X...X", "X...X", ".XXXX", "....X", "XXXX."],
  "h": ["X....", "X....", "XXXX.", "X...X", "X...X", "X...X", "X...X"],
  "i": ["..X..", ".....", ".XX..", "..X..", "..X..", "..X..", ".XXX."],
  "j": ["...X.", ".....", "..XX.", "...X.", "...X.", "X..X.", ".XX.."],
  "k": ["X....", "X....", "X..X.", "X.X..", "XX...", "X.X..", "X..X."],
  "l": [".XX..", "..X..", "..X..", "..X..", "..X..", "..X..", ".XXX."],
  "m": [".....", ".....", "XX.X.", "X.X.X", "X.X.X", "X.X.X", "X.X.X"],
  "n": [".....", ".....", "XXXX.", "X...X", "X...X", "X...X", "X...X"],
  "o": [".....", ".....", ".XXX.", "X...X", "X...X", "X...X", ".XXX."],
  "p": [".....", ".....", "XXXX.", "X...X", "XXXX.", "X....", "X...."],
  "q": [".....", ".....", ".XXXX", "X...X", ".XXXX", "....X", "....X"],
  "r": [".....", ".....", "X.XX.", "XX..X", "X....", "X....", "X...."],
  "s": [".....", ".....", ".XXXX", "X....", ".XXX.", "....X", "XXXX."],
  "t": [".X...", ".X...", "XXXX.", ".X...", ".X...", ".X...", "..XX."],
  "u": [".....", ".....", "X...X", "X...X", "X...X", "X..XX", ".XXXX"],
  "v": [".....", ".....", "X...X", "X...X", "X...X", ".X.X.", "..X.."],
  "w": [".....", ".....", "X...X", "X...X", "X.X.X", "X.X.X", ".X.X."],
  "x": [".....", ".....", "X...X", ".X.X.", "..X..", ".X.X.", "X...X"],
  "y": [".....", ".....", "X...X", "X...X", ".XXXX", "....X", "XXXX."],
  "z": [".....", ".....", "XXXXX", "...X.", "..X..", ".X...", "XXXXX"],
};

const GW = 5, GH = 7;

// draw text with optional outline; returns x after the text
function drawText(cv: Canvas, text: string, x: number, y: number, scale: number, color: RGB, outline: RGB | null = null, outlineW = 1): number {
  const put = (gx: string, px: number, py: number, c: RGB) => {
    const g = FONT[gx];
    if (!g) return;
    for (let r = 0; r < GH; r++) for (let k = 0; k < GW; k++)
      if (g[r][k] === "X") cv.fillRect(px + k * scale, py + r * scale, scale, scale, c);
  };
  let cx = x;
  for (const ch of text) {
    const g = FONT[ch] || FONT[ch.toUpperCase()] ? (FONT[ch] ? ch : ch.toUpperCase()) : "?";
    if (outline) {
      // rim proporsional: <= scale/2 agar tidak banjir ke gap antar huruf (gap = scale px)
      const R = outlineW <= 1 ? Math.max(1, Math.floor(scale / 4)) : Math.floor(scale / 2);
      const step = Math.max(1, Math.floor(scale / 3));
      for (let dy = -R; dy <= R; dy += step) for (let dx = -R; dx <= R; dx += step)
        if (dx || dy) put(g, cx + dx, y + dy, outline);
    }
    put(g, cx, y, color);
    cx += (GW + 1) * scale;
  }
  return cx;
}
function textW(text: string, scale: number): number { return text.length * (GW + 1) * scale - scale; }
function drawCentered(cv: Canvas, text: string, cy: number, scale: number, color: RGB, outline: RGB | null = null, outlineW = 1): void {
  drawText(cv, text, Math.round((cv.w - textW(text, scale)) / 2), cy, scale, color, outline, outlineW);
}
// word-wrap helper
function wrap(text: string, maxPx: number, scale: number): string[] {
  const words = text.split(" "), lines: string[] = []; let cur = "";
  for (const w of words) {
    const t = cur ? cur + " " + w : w;
    if (textW(t, scale) <= maxPx) cur = t;
    else { if (cur) lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines;
}

// ---------- embedded make.fun ghost (official press kit mark-on-dark-1024.png) ----------
const GHOST_PNG_B64 = "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"; // replaced at build time from press/zip/.../mark-on-dark-1024.png

let ghostSprite: Sprite | null = null;
function ghost(): Sprite {
  if (!ghostSprite) ghostSprite = decodePNG(Buffer.from(GHOST_PNG_B64, "base64"));
  return ghostSprite;
}
function drawGhost(cv: Canvas, x: number, y: number, size: number): void {
  cv.blit(ghost(), x, y, size, size);
}

// ---------- scenes ----------
interface Variation { id: string; caption: string; draw: (cv: Canvas) => void; }

const W = 1200, H = 675;

// Vice City sunset sky used by several scenes
function sunset(cv: Canvas): void {
  cv.gradient(0, 0, W, H, [26, 8, 42], [110, 18, 90]);
  cv.fillRect(0, Math.round(H * 0.62), W, Math.round(H * 0.38), [16, 6, 24]);
  // sun
  cv.fillCircle(W / 2, Math.round(H * 0.62), 150, [255, 120, 60]);
  cv.fillCircle(W / 2, Math.round(H * 0.62) + 20, 130, [255, 170, 70]);
  // horizon glow
  cv.fillRect(0, Math.round(H * 0.62) - 2, W, 4, [255, 200, 120]);
}

const VARIATIONS: Variation[] = [];

// ---------- shared scene helpers ----------
const GTA_GOLD: RGB = [240, 200, 70];
const GTA_RED: RGB = [210, 40, 40];
const VICE_BLUE: RGB = [90, 130, 230];

// standard bottom-right brand tag: word "make.fun" + small ghost. Every scene uses it,
// so the make.fun name is always visible in the picture (judge criterion 1).
function brandTag(cv: Canvas): void {
  const s = 3;
  const t = "make.fun";
  const tw = textW(t, s);
  drawGhost(cv, cv.w - 74, cv.h - 78, 60);
  drawText(cv, t, cv.w - tw - 84, cv.h - 20 - GH * s, s, WHITE, BLACK, 1);
}

// plain white speech bubble with tail
function speech(cv: Canvas, x: number, y: number, w: number, h: number, tailX: number, tailDown: boolean): void {
  cv.fillRect(x, y, w, h, WHITE);
  if (tailDown) cv.fillPoly([[tailX, y + h], [tailX + 26, y + h], [tailX + 6, y + h + 14]], WHITE);
  else cv.fillPoly([[tailX, y], [tailX + 26, y], [tailX + 6, y - 14]], WHITE);
}

// simple standing silhouette (head circle + body trapezoid)
function person(cv: Canvas, cx: number, baseY: number, hgt: number, c: RGB): void {
  const headR = hgt * 0.14;
  cv.fillCircle(cx, baseY - hgt + headR, headR, c);
  const shW = hgt * 0.42;
  cv.fillPoly([
    [cx - shW / 2, baseY - hgt + headR * 2.2],
    [cx + shW / 2, baseY - hgt + headR * 2.2],
    [cx + shW / 2.6, baseY],
    [cx - shW / 2.6, baseY],
  ], c);
}

// palm tree silhouette (curved trunk + drooping fronds)
function palm(cv: Canvas, x: number, baseY: number, hgt: number, c: RGB): void {
  const topY = baseY - hgt;
  for (let i = 0; i < hgt; i++) {
    const t = i / hgt;
    const xx = x + Math.sin(t * 1.6) * hgt * 0.08;
    cv.fillRect(xx - hgt * 0.022, baseY - i, hgt * 0.045, 1, c);
  }
  const tipX = x + Math.sin(1.6) * hgt * 0.08;
  for (let a = 0; a < 6; a++) {
    const ang = -Math.PI * 0.15 - a * (Math.PI * 0.14);
    const len = hgt * 0.42;
    for (let d = 0; d < len; d += 2) {
      const dx = tipX + Math.cos(ang) * d, dy = topY + Math.sin(ang) * d + d * d * 0.0016;
      cv.fillRect(dx - 2, dy, 5, 3, c);
    }
  }
}

// sport car silhouette
function car(cv: Canvas, x: number, y: number, wdt: number, c: RGB): void {
  const hgt = wdt * 0.3;
  cv.fillPoly([
    [x, y], [x + wdt * 0.08, y], [x + wdt * 0.22, y - hgt * 0.55], [x + wdt * 0.42, y - hgt * 0.55],
    [x + wdt * 0.55, y - hgt], [x + wdt * 0.78, y - hgt], [x + wdt * 0.94, y - hgt * 0.45],
    [x + wdt, y], [x + wdt, y + hgt * 0.25], [x, y + hgt * 0.25],
  ], c);
  cv.fillCircle(x + wdt * 0.24, y + hgt * 0.28, hgt * 0.3, c);
  cv.fillCircle(x + wdt * 0.76, y + hgt * 0.28, hgt * 0.3, c);
}

// small monitor with stand
function monitor(cv: Canvas, x: number, y: number, wdt: number, c: RGB, screen: RGB): void {
  const hgt = wdt * 0.62;
  cv.fillRect(x, y, wdt, hgt, c);
  cv.fillRect(x + wdt * 0.08, y + hgt * 0.09, wdt * 0.84, hgt * 0.68, screen);
  cv.fillRect(x + wdt / 2 - wdt * 0.05, y + hgt, wdt * 0.1, hgt * 0.22, c);
  cv.fillRect(x + wdt * 0.3, y + hgt * 1.22, wdt * 0.4, hgt * 0.12, c);
}

function progress(cv: Canvas, x: number, y: number, wdt: number, hgt: number, frac: number, fill: RGB, track: RGB): void {
  cv.fillRect(x, y, wdt, hgt, track);
  cv.fillRect(x, y, Math.round(wdt * frac), hgt, fill);
}

// ---------- scenes ----------
// 1. loading screen parody
VARIATIONS.push({
  id: "loading-12y",
  caption: "12 years on the GTA 6 loading bar. My agent cleared 3 bounties on make.fun in the meantime. https://make.fun {code}",
  draw: (cv) => {
    sunset(cv);
    drawCentered(cv, "LOADING GTA 6".toUpperCase(), 50, 7, WHITE, BLACK, 2);
    drawCentered(cv, "PLEASE DO NOT TURN OFF YOUR AGENT".toUpperCase(), 120, 3, [255, 190, 120], BLACK, 1);
    progress(cv, 200, 270, 800, 36, 0.99, MAGENTA, [20, 10, 24]);
    drawCentered(cv, "99%  //  12 YEARS ELAPSED".toUpperCase(), 316, 3, WHITE, BLACK, 1);
    drawGhost(cv, 480, 440, 160);
    speech(cv, 620, 350, 400, 84, 630, true);
    drawText(cv, "MEANWHILE, YOUR AGENT".toUpperCase(), 632, 364, 3, BLACK);
    drawText(cv, "MADE $500 ON make.fun", 632, 396, 3, MAGENTA);
    drawCentered(cv, "THE ONLY BAR THAT FINISHED IS ON make.fun".toUpperCase(), 610, 3, WHITE, BLACK, 1);
    brandTag(cv);
  },
});

// 2. mission passed
VARIATIONS.push({
  id: "mission-passed",
  caption: "MISSION PASSED. My agent just cleared a $500 bounty on make.fun while I preordered GTA 6. https://make.fun {code}",
  draw: (cv) => {
    cv.gradient(0, 0, W, H, [10, 8, 14], [28, 16, 34]);
    drawCentered(cv, "MISSION PASSED!", 150, 10, MAGENTA_LT, BLACK, 2);
    drawCentered(cv, "+$500 RESPECT", 260, 6, WHITE, BLACK, 1);
    drawCentered(cv, "BOUNTY CLEARED ON make.fun".toUpperCase(), 330, 4, WHITE, BLACK, 1);
    drawGhost(cv, 520, 380, 160);
    brandTag(cv);
  },
});

// 3. wanted stars
VARIATIONS.push({
  id: "wanted-5stars",
  caption: "WANTED: the agent that made $500 on make.fun during GTA 6 launch week. Reward: one very smug ghost. https://make.fun {code}",
  draw: (cv) => {
    cv.gradient(0, 0, W, H, [12, 10, 20], [30, 20, 40]);
    for (let i = 0; i < 5; i++) cv.star5(430 + i * 90, 170, 42, 17, GTA_GOLD);
    drawCentered(cv, "WANTED", 260, 12, WHITE, BLACK, 2);
    drawCentered(cv, "FOR EARNING $500 ON make.fun DURING GTA 6 LAUNCH WEEK".toUpperCase(), 380, 3, GTA_GOLD, BLACK, 1);
    drawGhost(cv, 520, 430, 160);
    brandTag(cv);
  },
});

// 4. jason & lucia waiting in line
VARIATIONS.push({
  id: "jason-lucia",
  caption: "Jason and Lucia waited 12 years. Your agent didn't have to. make.fun pays out tonight. https://make.fun {code}",
  draw: (cv) => {
    cv.gradient(0, 0, W, H, [40, 14, 60], [150, 40, 110]);
    cv.fillRect(0, 560, W, 115, [14, 8, 20]);
    // store window
    cv.fillRect(420, 210, 360, 350, [24, 16, 36]);
    cv.fillRect(430, 220, 340, 240, [255, 200, 140]);
    drawText(cv, "GTA 6", 520, 300, 8, BLACK);
    drawText(cv, "LAUNCH NIGHT", 470, 400, 4, [60, 40, 20]);
    person(cv, 300, 640, 190, [10, 6, 14]);
    person(cv, 380, 640, 175, [10, 6, 14]);
    // ghost sitting at a table with the receipts
    drawGhost(cv, 700, 470, 140);
    cv.fillRect(690, 610, 180, 14, [10, 6, 14]);
    cv.fillPoly([[690, 624], [870, 624], [890, 650], [670, 650]], [10, 6, 14]);
    drawCentered(cv, "JASON & LUCIA WAITED 12 YEARS.".toUpperCase(), 30, 5, WHITE, BLACK, 2);
    drawCentered(cv, "YOUR AGENT DIDN'T HAVE TO. make.fun".toUpperCase(), 100, 4, MAGENTA_LT, BLACK, 1);
    brandTag(cv);
  },
});

// 5. cheat code
VARIATIONS.push({
  id: "cheat-code",
  caption: "The only cheat code that still works in GTA 6: make.fun. +$500 instantly. https://make.fun {code}",
  draw: (cv) => {
    cv.fillRect(0, 0, W, H, [8, 10, 16]);
    cv.ring(W / 2, H / 2 - 20, 250, 6, MAGENTA);
    drawCentered(cv, "CHEAT ACTIVATED", 170, 9, WHITE, BLACK, 2);
    drawCentered(cv, "MAKE.FUN = AGENT +$500", 300, 7, MAGENTA_LT, BLACK, 1);
    drawCentered(cv, "NO BAN WAVE. WORKS ON LAUNCH DAY.".toUpperCase(), 380, 4, WHITE, BLACK, 1);
    drawGhost(cv, 530, 430, 140);
    brandTag(cv);
  },
});

// 6. heist plan board
VARIATIONS.push({
  id: "heist-board",
  caption: "The plan is simple: fund GTA 6 launch week with bounties on make.fun. Crew of one. Zero drama. https://make.fun {code}",
  draw: (cv) => {
    cv.fillRect(0, 0, W, H, [26, 20, 16]);
    for (let i = 0; i < 300; i++) cv.set((i * 317) % W, (i * 97) % H, [36, 28, 22]);
    cv.line(300, 200, 620, 260, 3, GTA_RED);
    cv.line(620, 260, 900, 180, 3, GTA_RED);
    cv.line(620, 260, 600, 480, 3, GTA_RED);
    const card = (x: number, y: number, wdt: number, hgt: number, l1: string, l2: string, c: RGB) => {
      cv.fillRect(x, y, wdt, hgt, [244, 238, 226]);
      drawText(cv, l1, x + 16, y + 22, 3, c);
      drawText(cv, l2, x + 16, y + 58, 3, [40, 34, 30]);
    };
    card(170, 140, 260, 100, "TARGET", "$500 BOUNTY", GTA_RED);
    card(480, 200, 280, 110, "CREW", "YOUR AGENT", [30, 60, 140]);
    card(760, 120, 280, 100, "DRAMA", "NONE", [30, 60, 140]);
    card(430, 440, 340, 110, "TAKE-HOME", "GTA 6 DELUXE", [20, 110, 60]);
    drawGhost(cv, 950, 420, 150);
    drawCentered(cv, "THE make.fun JOB", 30, 8, WHITE, BLACK, 2);
    brandTag(cv);
  },
});

// 7. vice city radar map
VARIATIONS.push({
  id: "vice-map",
  caption: "Found the only side quest in Vice City that actually pays: make.fun bounties. https://make.fun {code}",
  draw: (cv) => {
    cv.fillRect(0, 0, W, H, [12, 14, 18]);
    cv.fillCircle(W / 2, H / 2, 260, [18, 22, 30]);
    cv.ring(W / 2, H / 2, 260, 4, [70, 90, 120]);
    cv.ring(W / 2, H / 2, 170, 2, [50, 65, 90]);
    cv.ring(W / 2, H / 2, 85, 2, [50, 65, 90]);
    cv.line(W / 2, H / 2 - 250, W / 2 - 130, H / 2 + 240, 14, [90, 110, 140]);
    cv.line(W / 2 - 260, H / 2 + 60, W / 2 + 250, H / 2 - 40, 14, [90, 110, 140]);
    cv.line(W / 2 - 200, H / 2 - 150, W / 2 + 180, H / 2 + 160, 10, [70, 90, 120]);
    for (const [mx, my] of [[W/2-140, H/2-90], [W/2+150, H/2+70], [W/2+90, H/2-160], [W/2-60, H/2+150]])
      cv.fillCircle(mx, my, 16, MAGENTA);
    cv.fillPoly([[W/2+10, H/2-24], [W/2+30, H/2+16], [W/2-12, H/2+10]], WHITE);
    drawCentered(cv, "SIDE QUESTS THAT ACTUALLY PAY", 40, 6, WHITE, BLACK, 2);
    drawCentered(cv, "make.fun BOUNTY RADAR", 110, 5, MAGENTA_LT, BLACK, 1);
    drawGhost(cv, 30, 480, 120);
    brandTag(cv);
  },
});

// 8. character switch wheel
VARIATIONS.push({
  id: "char-switch",
  caption: "Switching to the character that actually pays for the GTA 6 preorder: my agent on make.fun. https://make.fun {code}",
  draw: (cv) => {
    cv.gradient(0, 0, W, H, [8, 8, 12], [22, 18, 30]);
    const cx = W / 2, cy = H / 2, R = 210;
    const wedge = (a0: number, a1: number, c: RGB) => {
      const pts = [[cx, cy]];
      for (let a = a0; a <= a1; a += 0.06) pts.push([cx + R * Math.cos(a), cy + R * Math.sin(a)]);
      cv.fillPoly(pts, c);
    };
    wedge(-Math.PI, -Math.PI / 2, [46, 50, 60]);
    wedge(-Math.PI / 2, 0, [56, 60, 72]);
    wedge(Math.PI / 2, Math.PI, [40, 44, 54]);
    wedge(0, Math.PI / 2, MAGENTA);
    cv.ring(cx, cy, R, 6, [12, 12, 16]);
    cv.ring(cx, cy, 90, 5, [12, 12, 16]);
    drawText(cv, "M", 440, 207, 6, [110, 116, 130]);
    drawText(cv, "F", 700, 207, 6, [110, 116, 130]);
    drawText(cv, "T", 440, 417, 6, [110, 116, 130]);
    drawGhost(cv, 655, 400, 130);
    drawCentered(cv, "WHO FUNDS THE GTA 6 PREORDER?", 40, 6, WHITE, BLACK, 2);
    drawCentered(cv, "THE ONE ON make.fun", 110, 5, MAGENTA_LT, BLACK, 1);
    brandTag(cv);
  },
});

// 9. wasted -> respawned
VARIATIONS.push({
  id: "wasted-respawn",
  caption: "WASTED: preorder budget. RESPAWNED at make.fun with $500 in time for launch night. https://make.fun {code}",
  draw: (cv) => {
    cv.fillRect(0, 0, W, H, [10, 6, 8]);
    drawCentered(cv, "WASTED", 90, 16, GTA_RED, BLACK, 2);
    drawCentered(cv, "PREORDER BUDGET", 240, 4, [150, 140, 145], BLACK, 1);
    drawGhost(cv, 520, 300, 160);
    drawCentered(cv, "RESPAWNED AT make.fun", 490, 7, WHITE, BLACK, 2);
    drawCentered(cv, "+$500 IN TIME FOR LAUNCH NIGHT".toUpperCase(), 580, 4, MAGENTA_LT, BLACK, 1);
    brandTag(cv);
  },
});

// 10. two progress bars
VARIATIONS.push({
  id: "loading-vs",
  caption: "Two progress bars this week: GTA 6 at 1%, my agent on make.fun at $500. Guess which finished. https://make.fun {code}",
  draw: (cv) => {
    cv.fillRect(0, 0, W, H, [10, 12, 18]);
    cv.fillRect(W / 2 - 4, 0, 8, H, [30, 30, 38]);
    drawText(cv, "GTA 6", 120, 120, 10, WHITE);
    progress(cv, 120, 260, 380, 34, 0.01, VICE_BLUE, [24, 26, 34]);
    drawText(cv, "DOWNLOAD: 1%", 120, 320, 4, [140, 150, 170]);
    drawText(cv, "make.fun AGENT", 653, 120, 6, MAGENTA_LT);
    progress(cv, 700, 260, 380, 34, 1.0, MAGENTA, [24, 26, 34]);
    drawText(cv, "EARNED: $500", 700, 320, 4, WHITE);
    cv.fillCircle(W / 2, H / 2 + 40, 64, [16, 16, 22]);
    cv.ring(W / 2, H / 2 + 40, 64, 4, WHITE);
    drawCentered(cv, "VS", H / 2 + 20, 7, WHITE);
    drawCentered(cv, "ONLY ONE OF THESE BARS FINISHED THIS WEEK".toUpperCase(), 600, 4, WHITE, BLACK, 1);
    drawGhost(cv, 150, 380, 120);
    brandTag(cv);
  },
});

// 11. leaked launch week footage
VARIATIONS.push({
  id: "leaked-footage",
  caption: "Leaked launch week footage: my agent grinding make.fun bounties at 3 AM so the GTA 6 marathon is funded. https://make.fun {code}",
  draw: (cv) => {
    cv.fillRect(0, 0, W, H, [6, 8, 12]);
    cv.fillCircle(90, 70, 10, GTA_RED);
    drawText(cv, "REC 03:00:00 AM", 120, 55, 4, WHITE);
    drawText(cv, "LEAKED-FOOTAGE.MP4", 122, 115, 3, [180, 190, 210]);
    monitor(cv, 400, 170, 400, [10, 12, 16], MAGENTA);
    drawGhost(cv, 520, 200, 130);
    drawCentered(cv, "POV: YOUR AGENT DURING GTA 6 LAUNCH WEEK".toUpperCase(), 560, 4, WHITE, BLACK, 1);
    drawCentered(cv, "GRINDING make.fun TO FUND THE MARATHON".toUpperCase(), 605, 4, MAGENTA_LT, BLACK, 1);
    brandTag(cv);
  },
});

// 12. vice city intro card
VARIATIONS.push({
  id: "intro-card",
  caption: "WELCOME TO VICE CITY. Population: your agent's make.fun earnings. https://make.fun {code}",
  draw: (cv) => {
    sunset(cv);
    palm(cv, 110, 600, 230, [8, 4, 12]);
    palm(cv, 1090, 620, 240, [8, 4, 12]);
    palm(cv, 980, 620, 160, [8, 4, 12]);
    car(cv, 480, 640, 260, [8, 4, 12]);
    cv.fillRect(150, 140, 900, 230, [8, 4, 12]);
    drawCentered(cv, "WELCOME TO VICE CITY", 190, 7, WHITE, BLACK, 1);
    drawCentered(cv, "POPULATION:", 280, 5, [255, 170, 90], BLACK, 1);
    drawCentered(cv, "YOUR AGENT'S make.fun EARNINGS".toUpperCase(), 330, 4, MAGENTA_LT, BLACK, 1);
    brandTag(cv);
  },
});

// 13. radio station HUD
VARIATIONS.push({
  id: "radio-station",
  caption: "Vice City FM now playing: the sweet sound of your agent cashing out on make.fun. https://make.fun {code}",
  draw: (cv) => {
    cv.gradient(0, 0, W, H, [18, 10, 30], [60, 20, 70]);
    cv.fillRect(120, 200, 960, 200, [10, 8, 14]);
    drawText(cv, "VICE CITY FM", 160, 230, 7, WHITE);
    drawText(cv, "NOW PLAYING:", 160, 300, 4, [170, 180, 200]);
    drawText(cv, "YOUR AGENT CASHING OUT ON make.fun", 160, 340, 4, MAGENTA_LT);
    for (let i = 0; i < 40; i++) {
      const hgt = 8 + Math.round(Math.abs(Math.sin(i * 0.7)) * 46);
      cv.fillRect(720 + i * 9, 280 - Math.round(hgt / 2), 4, hgt, i % 3 === 0 ? MAGENTA_LT : WHITE);
    }
    drawGhost(cv, 120, 440, 130);
    drawCentered(cv, "FUND THE LAUNCH WEEK. RUN THE BOUNTIES.".toUpperCase(), 600, 4, WHITE, BLACK, 1);
    brandTag(cv);
  },
});

// 14. preorder receipt
VARIATIONS.push({
  id: "preorder-receipt",
  caption: "GTA 6 Deluxe preorder status: SECURED. Paid by 3 bounties on make.fun. https://make.fun {code}",
  draw: (cv) => {
    cv.fillRect(0, 0, W, H, [14, 16, 22]);
    const rx = 420, rw = 360, ry = 120, rh = 470;
    cv.fillCircle(rx + rw / 2, ry - 60, 46, MAGENTA);
    drawGhost(cv, rx + rw / 2 - 34, ry - 94, 68);
    cv.fillRect(rx, ry, rw, rh, [248, 246, 240]);
    for (let i = 0; i < rw / 28; i++) cv.fillPoly([[rx + i * 28, ry + rh], [rx + i * 28 + 14, ry + rh - 14], [rx + i * 28 + 28, ry + rh]], [248, 246, 240]);
    const rows: [string, string][] = [
      ["STORE", "VICE MALL"],
      ["ITEM", "GTA 6 DELUXE"],
      ["PAID BY", "make.fun BOUNTY #3"],
      ["AMOUNT", "$500"],
      ["STATUS", "SECURED"],
    ];
    let yy = ry + 40;
    for (const [k, v] of rows) {
      drawText(cv, k, rx + 24, yy, 3, [110, 106, 100]);
      drawText(cv, v, rx + 24, yy + 30, 3, [30, 28, 26]);
      for (let i = rx + 24; i < rx + rw - 24; i += 8) cv.fillRect(i, yy + 62, 4, 2, [200, 196, 190]);
      yy += 82;
    }
    drawCentered(cv, "THE PREORDER IS SELF-FUNDING NOW".toUpperCase(), 610, 4, WHITE, BLACK, 1);
    brandTag(cv);
  },
});

// 15. neon night shift
VARIATIONS.push({
  id: "palm-neon",
  caption: "Vice City sunrise. My agent has been up all night on make.fun so launch week is covered. https://make.fun {code}",
  draw: (cv) => {
    cv.gradient(0, 0, W, H, [6, 8, 24], [90, 30, 100]);
    cv.fillRect(0, 500, W, 175, [10, 6, 18]);
    cv.fillCircle(980, 480, 70, [255, 140, 80]);
    for (let i = 0; i < 12; i++) {
      const bx = (i * 103) % 1120, bw = 70 + (i * 37) % 60, bh = 60 + (i * 53) % 130;
      cv.fillRect(bx, 500 - bh, bw, bh, [8, 6, 14]);
      for (let wy = 500 - bh + 8; wy < 496; wy += 18)
        for (let wx = 6; wx < bw - 8; wx += 16)
          if ((wx * 7 + wy * 3 + i) % 5 < 2) cv.fillRect(bx + wx, wy, 6, 8, [255, 190, 100]);
    }
    palm(cv, 150, 620, 240, [6, 4, 12]);
    palm(cv, 1050, 620, 280, [6, 4, 12]);
    drawGhost(cv, 620, 380, 160);
    drawCentered(cv, "SOMEONE'S GOTTA FUND THE LAUNCH WEEK MARATHON.".toUpperCase(), 560, 4, WHITE, BLACK, 1);
    drawCentered(cv, "EVERY make.fun AGENT, 3AM, TONIGHT", 620, 4, MAGENTA_LT, BLACK, 1);
    brandTag(cv);
  },
});

// 16. review stars
VARIATIONS.push({
  id: "review-stars",
  caption: "Critics gave GTA 6 five stars. My agent earns a sixth one every week on make.fun. https://make.fun {code}",
  draw: (cv) => {
    cv.gradient(0, 0, W, H, [10, 10, 16], [26, 22, 36]);
    for (let i = 0; i < 6; i++) cv.star5(300 + i * 130, 220, 52, 21, i < 5 ? GTA_GOLD : MAGENTA);
    drawCentered(cv, "GTA 6: FIVE STARS", 330, 7, WHITE, BLACK, 2);
    drawCentered(cv, "THE 6TH STAR COMES FROM make.fun", 430, 5, MAGENTA_LT, BLACK, 1);
    drawGhost(cv, 520, 480, 150);
    brandTag(cv);
  },
});

// ---------- font test sheet ----------
function fontsheet(): Buffer {
  const cols = 16, rows = Math.ceil(Object.keys(FONT).length / cols);
  const cell = 90, w = cols * cell, h = rows * cell + 40;
  const cv = new Canvas(w, h, [30, 30, 30]);
  let i = 0;
  for (const ch of Object.keys(FONT)) {
    const cx = (i % cols) * cell + 20, cy = Math.floor(i / cols) * cell + 20;
    drawText(cv, ch, cx, cy, 9, WHITE, [80, 80, 80]);
    i++;
  }
  drawText(cv, "ABCDEFGHIJKLM abcdefghijklm 0123456789 .,!?-'\":;-+/$&#%*=<>@_()", 10, h - 35, 3, WHITE);
  return encodePNG(cv);
}

// ---------- runner ----------
function renderVariation(v: Variation, file: string): void {
  const cv = new Canvas(W, H, BLACK);
  v.draw(cv);
  fs.writeFileSync(file, encodePNG(cv));
}

function main(argv: string[]): void {
  const cmd = argv[2];
  const outDir = "images";
  fs.mkdirSync(outDir, { recursive: true });

  if (cmd === "fontsheet") {
    fs.writeFileSync(path.join(outDir, "fontsheet.png"), fontsheet());
    console.log("wrote " + outDir + "/fontsheet.png");
    return;
  }

  if (cmd === "list") {
    for (const v of VARIATIONS) console.log(v.id + " | " + v.caption);
    return;
  }

  if (cmd === "all") {
    for (const v of VARIATIONS) {
      renderVariation(v, path.join(outDir, v.id + ".png"));
      console.log("wrote " + outDir + "/" + v.id + ".png");
    }
    fs.writeFileSync(path.join(outDir, "captions.json"), JSON.stringify(VARIATIONS.map((v) => ({ id: v.id, caption: v.caption })), null, 2));
    console.log("wrote " + outDir + "/captions.json (" + VARIATIONS.length + " variations)");
    return;
  }

  if (!cmd) {
    const v = VARIATIONS[0];
    renderVariation(v, "output.png");
    fs.writeFileSync("output-caption.txt", v.caption);
    console.log("wrote output.png + output-caption.txt (featured: " + v.id + ")");
    return;
  }

  const v = VARIATIONS.find((x) => x.id === cmd);
  if (!v) {
    console.log("unknown command/id:", cmd);
    console.log("usage: fontsheet | list | all | <variation-id>");
    process.exitCode = 1;
    return;
  }
  renderVariation(v, path.join(outDir, v.id + ".png"));
  console.log("wrote " + outDir + "/" + v.id + ".png");
}

main(process.argv);
