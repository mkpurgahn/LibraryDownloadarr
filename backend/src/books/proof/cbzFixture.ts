import { deflateSync } from 'node:zlib';
import { ZipWriter, Uint8ArrayReader, Uint8ArrayWriter } from '@zip.js/zip.js';

function chunk(type: string, data: Buffer): Buffer {
  const bytes = Buffer.concat([Buffer.from(type), data]);
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length); bytes.copy(result, 4);
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
  return result;
}

// Original numbered panels, generated from pixels rather than third-party artwork.
export function comicPanel(page: number, chapter = 1, width = 480, height = 720, compressionLevel = 6): Buffer {
  const rows = Buffer.alloc((width * 3 + 1) * height);
  const digits = ['111101101101111', '010110010010111', '111001111100111', '111001111001111',
    '101101111001001', '111100111001111', '111100111101111', '111001010010010',
    '111101111101111', '111101111001111'];
  const label = String(page);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const digitX = Math.floor((x - 32) / 18);
    const digitY = Math.floor((y - 35) / 18);
    const digit = label[Math.floor(digitX / 4)];
    const ink = digit && digitX >= 0 && digitX % 4 < 3 && digitY >= 0 && digitY < 5 &&
      digits[Number(digit)][digitY * 3 + digitX % 4] === '1';
    const panel = y > 160 && y < height - 24 && x > 24 && x < width - 24;
    const border = panel && (x < 30 || x > width - 31 || y < 166 || y > height - 31 ||
      Math.abs(y - Math.round(height * 0.6)) < 3);
    const figure = panel && (Math.abs(x - width * 0.5) < 6 || Math.abs(x + y / 3 - width * 0.9) < 4);
    const base = ink || border || figure ? 28 : panel ? 214 + ((x * 13 + y * 17) % 18) : 244;
    const offset = y * (width * 3 + 1) + 1 + x * 3;
    rows[offset] = Math.max(0, base - (chapter === 2 ? 25 : 0));
    rows[offset + 1] = base;
    rows[offset + 2] = Math.max(0, base - (chapter === 1 ? 25 : 0));
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows, { level: compressionLevel })), chunk('IEND', Buffer.alloc(0))]);
}

export function animatedComicPanel(): Buffer {
  const png = comicPanel(1);
  const animation = Buffer.alloc(8); animation.writeUInt32BE(1);
  const frame = Buffer.alloc(26);
  frame.writeUInt32BE(480, 4); frame.writeUInt32BE(720, 8);
  frame.writeUInt16BE(1, 20); frame.writeUInt16BE(10, 22);
  return Buffer.concat([png.subarray(0, 33), chunk('acTL', animation), chunk('fcTL', frame), png.subarray(33)]);
}

export async function buildCbzFixture(entries: Array<{ name: string; data: Uint8Array; password?: string }> = [
  { name: 'Pages/10.png', data: comicPanel(10) },
  { name: 'Pages/2.png', data: comicPanel(2) },
  { name: 'Pages/1.png', data: comicPanel(1) },
  { name: 'ComicInfo.xml', data: Buffer.from('<ComicInfo><Title>Generated panels</Title></ComicInfo>') },
]): Promise<Buffer> {
  const zip = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false, useCompressionStream: false, level: 0 });
  for (const entry of entries) await zip.add(entry.name, new Uint8ArrayReader(entry.data), {
    password: entry.password, lastModDate: new Date('2020-01-01T00:00:00Z'),
  });
  return Buffer.from(await zip.close());
}

export async function buildLargeCbzFixture(): Promise<Buffer> {
  const first = comicPanel(1, 1, 960, 600, 0);
  const second = comicPanel(2, 1, 480, 512, 0);
  return buildCbzFixture(Array.from({ length: 243 }, (_, index) => ({
    name: `Pages/${index + 1}.png`, data: index === 0 ? first : second,
  })));
}
