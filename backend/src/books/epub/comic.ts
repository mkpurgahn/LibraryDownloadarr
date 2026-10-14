import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { ArchiveBudget, CBZ_LIMITS, PreparedResource, UnsafeEpub } from './manifest';

export interface StoredEntry { id: string; size: number; directory?: boolean }
export const comicDecoderLimits = () => ({
  decoderConcurrency: sharp.concurrency(), decoderCacheMemoryMiB: sharp.cache().memory.max,
});
const formats: Readonly<Record<string, { format: string; mime: string }>> = {
  '.png': { format: 'png', mime: 'image/png' },
  '.jpg': { format: 'jpeg', mime: 'image/jpeg' },
  '.jpeg': { format: 'jpeg', mime: 'image/jpeg' },
  '.webp': { format: 'webp', mime: 'image/webp' },
};
const ignored = (name: string) => {
  const basename = path.posix.basename(name);
  return name.startsWith('__MACOSX/') || basename.startsWith('._') ||
    ['.ds_store', 'thumbs.db', 'desktop.ini', 'comicinfo.xml'].includes(basename.toLowerCase());
};

function requireStaticPng(bytes: Buffer): void {
  if (!bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) throw new UnsafeEpub('Invalid PNG signature');
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (length > bytes.length - offset - 12 || ['acTL', 'fcTL', 'fdAT'].includes(type)) throw new UnsafeEpub('Animated or truncated PNG');
    offset += length + 12;
    if (type === 'IEND') {
      if (length !== 0 || offset !== bytes.length) throw new UnsafeEpub('Ambiguous PNG ending');
      return;
    }
  }
  throw new UnsafeEpub('Incomplete PNG');
}

function requireStaticWebp(bytes: Buffer): void {
  if (bytes.length < 12 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP' ||
      bytes.readUInt32LE(4) !== bytes.length - 8) throw new UnsafeEpub('Invalid WebP signature');
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const type = bytes.toString('ascii', offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4);
    if (length > bytes.length - offset - 8 || ['ANIM', 'ANMF'].includes(type) ||
        (type === 'VP8X' && length > 0 && (bytes[offset + 8] & 2))) throw new UnsafeEpub('Animated or truncated WebP');
    offset += 8 + length + (length % 2);
  }
  if (offset !== bytes.length) throw new UnsafeEpub('Incomplete WebP');
}

// Locale-independent numeric comparison; ties use fewer leading zeroes, then code units.
export function comicOrder(a: string, b: string): number {
  const left = a.toLowerCase().match(/\d+|\D+/g) ?? [];
  const right = b.toLowerCase().match(/\d+|\D+/g) ?? [];
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const x = left[i]; const y = right[i];
    if (x === y) continue;
    if (/^\d+$/.test(x) && /^\d+$/.test(y)) {
      const nx = x.replace(/^0+/, '') || '0'; const ny = y.replace(/^0+/, '') || '0';
      if (nx.length !== ny.length) return nx.length - ny.length;
      if (nx !== ny) return nx < ny ? -1 : 1;
      if (x.length !== y.length) return x.length - y.length;
    }
    return x < y ? -1 : 1;
  }
  return left.length - right.length || (a < b ? -1 : a > b ? 1 : 0);
}

export async function prepareComic(entries: Map<string, StoredEntry>, output: string, budget: ArchiveBudget): Promise<PreparedResource[]> {
  sharp.cache(false);
  sharp.concurrency(1);
  const pages = [...entries].filter(([name, entry]) => !entry.directory && !ignored(name)).sort(([a], [b]) => comicOrder(a, b));
  if (!pages.length || pages.length > CBZ_LIMITS.pages) throw new UnsafeEpub('CBZ page count limit');
  const resources: PreparedResource[] = [];
  for (const [name, entry] of pages) {
    const expected = formats[path.posix.extname(name).toLowerCase()];
    if (!expected) throw new UnsafeEpub('Unsupported CBZ page type');
    const filename = path.join(output, entry.id);
    budget.checkMemory(entry.size);
    const bytes = await fs.readFile(filename);
    if (expected.format === 'png') requireStaticPng(bytes);
    if (expected.format === 'webp') requireStaticWebp(bytes);
    const image = sharp(bytes, { limitInputPixels: CBZ_LIMITS.pixels, failOn: 'warning', sequentialRead: true });
    try {
      const metadata = await image.metadata();
      const { width, height } = metadata;
      if (metadata.format !== expected.format || !width || !height || width > CBZ_LIMITS.dimension ||
          height > CBZ_LIMITS.dimension || width * height > CBZ_LIMITS.pixels || (metadata.pages ?? 1) !== 1) {
        throw new UnsafeEpub('Unsupported or oversized CBZ raster');
      }
      budget.checkMemory(width * height * 4);
      // Decode all pixels now: a plausible header must not hide a damaged declared page.
      const decoded = await image.rotate().toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      if (decoded.info.width * decoded.info.height !== width * height || decoded.data.length !== width * height * 4) {
        throw new UnsafeEpub('Invalid CBZ decoded dimensions');
      }
      budget.checkMemory();
      resources.push({ resourceId: entry.id, mediaType: expected.mime, size: entry.size,
        width: decoded.info.width, height: decoded.info.height });
    } finally { image.destroy(); }
  }
  const retained = new Set(resources.map(resource => resource.resourceId));
  for (const entry of entries.values()) if (!entry.directory && !retained.has(entry.id)) {
    await fs.rm(path.join(output, entry.id));
  }
  return resources;
}
