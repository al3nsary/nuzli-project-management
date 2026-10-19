import { deflateSync } from 'node:zlib';
import { imageSize, MAX_OCR_PIXELS, ocrImageProblem } from './image-dimensions';

function png(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
  };
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.alloc(10))), chunk('IEND', Buffer.alloc(0))]);
}

function riff(chunk: string, payload: Buffer): Buffer {
  const head = Buffer.alloc(20);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(payload.length + 12, 4);
  head.write('WEBP', 8, 'latin1');
  head.write(chunk, 12, 'latin1');
  head.writeUInt32LE(payload.length, 16);
  return Buffer.concat([head, payload, Buffer.alloc(16)]);
}

function webpVp8x(width: number, height: number): Buffer {
  const p = Buffer.alloc(10);
  p.writeUIntLE(width - 1, 4, 3);
  p.writeUIntLE(height - 1, 7, 3);
  return riff('VP8X', p);
}

function webpVp8l(width: number, height: number): Buffer {
  const p = Buffer.alloc(5);
  p[0] = 0x2f;
  p.writeUInt32LE(((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14), 1);
  return riff('VP8L', p);
}

function webpVp8(width: number, height: number): Buffer {
  const p = Buffer.alloc(10);
  p[3] = 0x9d;
  p[4] = 0x01;
  p[5] = 0x2a;
  p.writeUInt16LE(width, 6);
  p.writeUInt16LE(height, 8);
  return riff('VP8 ', p);
}

function jpeg(width: number, height: number): Buffer {
  // SOI, an APP0 segment, a DQT-like segment, then SOF2 (progressive).
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xe0, 0x00, 0x10]),
    Buffer.from('JFIF\0', 'latin1'),
    Buffer.alloc(9),
    Buffer.from([0xff, 0xdb, 0x00, 0x04, 0x00, 0x00]),
    Buffer.from([0xff, 0xc2, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03]),
    Buffer.alloc(9),
  ]);
}

describe('image dimensions from the header (OCR image-bomb guard)', () => {
  it('reads JPEG (past APPn/DQT segments), PNG and the three WebP flavours', () => {
    expect(imageSize(jpeg(1600, 1000))).toEqual({ type: 'image/jpeg', width: 1600, height: 1000 });
    expect(imageSize(png(30_000, 30_000))).toEqual({ type: 'image/png', width: 30_000, height: 30_000 });
    expect(imageSize(webpVp8x(16_000, 16_000))).toEqual({ type: 'image/webp', width: 16_000, height: 16_000 });
    expect(imageSize(webpVp8l(1200, 800))).toEqual({ type: 'image/webp', width: 1200, height: 800 });
    expect(imageSize(webpVp8(640, 480))).toEqual({ type: 'image/webp', width: 640, height: 480 });
    expect(imageSize(Buffer.from('%PDF-1.7'))).toBeNull();
  });

  it('above 25 megapixels is refused; a normal photo passes; garbage is not an image', () => {
    expect(ocrImageProblem(png(30_000, 30_000))).toBe('IMAGE_TOO_LARGE');
    expect(ocrImageProblem(webpVp8x(16_000, 16_000))).toBe('IMAGE_TOO_LARGE');
    expect(ocrImageProblem(jpeg(5_001, 5_000))).toBe('IMAGE_TOO_LARGE');
    expect(ocrImageProblem(jpeg(1600, 1200))).toBeNull();
    expect(ocrImageProblem(png(5_000, 5_000))).toBeNull();
    expect(MAX_OCR_PIXELS).toBe(25_000_000);
    expect(ocrImageProblem(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))).toBe('NOT_AN_IMAGE');
    expect(ocrImageProblem(png(0, 10))).toBe('NOT_AN_IMAGE');
  });
});
