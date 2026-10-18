import { deflateSync } from 'node:zlib';

/**
 * Test fixture generator (no canvas dependency): renders digits and separators with a small
 * stroke font (lines and elliptic arcs drawn with a round pen) into a grayscale PNG, so the OCR
 * smoke test can run the real tesseract.js engine. Used only by tests.
 */
type Pt = [number, number];

/** Points of an elliptic arc in the unit glyph box (y grows downwards; 270° = top). */
function arc(cx: number, cy: number, rx: number, ry: number, from: number, to: number, steps = 28): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = ((from + ((to - from) * i) / steps) * Math.PI) / 180;
    out.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
  }
  return out;
}

const line = (...pts: Pt[]): Pt[] => pts;

/** Each glyph is a list of polylines in a box 1 high and ~0.62 wide (x in 0..1 of that width). */
const GLYPHS: Record<string, Pt[][]> = {
  '0': [arc(0.5, 0.5, 0.4, 0.47, 0, 360, 48)],
  '1': [line([0.22, 0.22], [0.56, 0.03], [0.56, 0.97]), line([0.25, 0.97], [0.87, 0.97])],
  '2': [[...arc(0.5, 0.29, 0.36, 0.25, 190, 395), [0.12, 0.97]], line([0.12, 0.97], [0.9, 0.97])],
  '3': [arc(0.48, 0.27, 0.33, 0.23, 205, 450), arc(0.48, 0.73, 0.38, 0.25, 270, 515)],
  '4': [line([0.72, 0.97], [0.72, 0.03], [0.08, 0.68], [0.95, 0.68])],
  '5': [[[0.85, 0.03], [0.22, 0.03], [0.16, 0.47], ...arc(0.5, 0.68, 0.38, 0.29, 225, 500)]],
  '6': [arc(0.5, 0.7, 0.36, 0.27, 0, 360, 40), arc(0.72, 0.62, 0.58, 0.58, 180, 262)],
  '7': [line([0.1, 0.03], [0.9, 0.03], [0.4, 0.97])],
  '8': [arc(0.5, 0.27, 0.31, 0.23, 0, 360, 40), arc(0.5, 0.73, 0.38, 0.25, 0, 360, 40)],
  '9': [arc(0.5, 0.3, 0.36, 0.27, 0, 360, 40), arc(0.28, 0.38, 0.58, 0.58, -2, 80)],
  '/': [line([0.85, 0.0], [0.15, 1.0])],
  '-': [line([0.2, 0.55], [0.8, 0.55])],
  ' ': [],
};

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function distToSegment(px: number, py: number, a: Pt, b: Pt): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / len2)) : 0;
  const x = a[0] + t * dx - px;
  const y = a[1] + t * dy - py;
  return Math.sqrt(x * x + y * y);
}

/** Grayscale 8-bit PNG of `lines` (dark text on white), glyphs `height` pixels tall. */
export function renderTextPng(lines: string[], height = 48): Buffer {
  const glyphW = Math.round(height * 0.62);
  const advance = Math.round(height * 0.86);
  const lineH = Math.round(height * 1.8);
  const margin = Math.round(height * 0.8);
  const pen = Math.max(2, height * 0.065);
  const cols = Math.max(...lines.map((l) => l.length));
  const width = cols * advance + margin * 2;
  const imgH = lines.length * lineH + margin * 2;
  const raw = Buffer.alloc((width + 1) * imgH, 0xff);
  for (let y = 0; y < imgH; y++) raw[y * (width + 1)] = 0; // PNG filter byte: none
  lines.forEach((text, li) => {
    [...text].forEach((ch, ci) => {
      const ox = margin + ci * advance;
      const oy = margin + li * lineH;
      const segments: Array<[Pt, Pt]> = [];
      for (const poly of GLYPHS[ch] ?? []) {
        const pts = poly.map(([x, y]) => [ox + x * glyphW, oy + y * height] as Pt);
        for (let i = 1; i < pts.length; i++) segments.push([pts[i - 1]!, pts[i]!]);
      }
      if (!segments.length) return;
      const pad = Math.ceil(pen + 2);
      for (let y = Math.max(0, oy - pad); y < Math.min(imgH, oy + height + pad); y++) {
        for (let x = Math.max(0, ox - pad); x < Math.min(width, ox + glyphW + pad); x++) {
          let d = Infinity;
          for (const [a, b] of segments) d = Math.min(d, distToSegment(x + 0.5, y + 0.5, a, b));
          // Round pen with a one-pixel anti-aliased edge.
          const ink = Math.max(0, Math.min(1, pen - d + 0.5));
          if (ink > 0) {
            const i = y * (width + 1) + 1 + x;
            raw[i] = Math.min(raw[i]!, Math.round(255 * (1 - ink) + 20 * ink));
          }
        }
      }
    });
  });
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(imgH, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // grayscale
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
