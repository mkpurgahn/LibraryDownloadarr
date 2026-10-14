import { BooksError } from '../limits';
import { createHash } from 'node:crypto';

export const EPUB_POLICY = 'epub-scroll-v1' as const;
export const CBZ_POLICY = 'cbz-pages-v1' as const;
export type ArchiveFormat = 'epub' | 'cbz';
export const CBZ_LIMITS = { pages: 1000, pixels: 16000000, dimension: 8192 } as const;
export const CBZ_DOWNLOAD_ONLY_REASON = 'This CBZ is corrupt, unsupported, or exceeds the safe reading limits; download the original.';
export const EPUB_LIMITS = {
  compressedBytes: 100 * 1024 * 1024,
  expandedBytes: 512 * 1024 * 1024,
  entryBytes: 32 * 1024 * 1024,
  entries: 10000,
  ratio: 100,
  timeoutMs: 30000,
  memoryBytes: 256 * 1024 * 1024,
  cacheBytes: 1024 * 1024 * 1024,
  cacheTtlMs: 24 * 60 * 60 * 1000,
  handleTtlMs: 30 * 60 * 1000,
  xmlNodes: 100000,
  xmlDepth: 128,
  sectionCharacters: 1024 * 1024,
  cacheEntries: 128,
  handles: 256,
} as const;
export const DOWNLOAD_ONLY_REASON = 'Cannot read safely here; download original.';
export const epubContentVersion = (fileVersion: string): string =>
  createHash('sha256').update(`${EPUB_POLICY}:${fileVersion}`).digest('hex');
export const cbzContentVersion = (fileVersion: string): string =>
  createHash('sha256').update(`${CBZ_POLICY}:${fileVersion}`).digest('hex');

export interface ReaderDescriptor {
  readerId: string;
  state: 'preparing' | 'ready' | 'download-only';
  contentVersion: string;
  policyVersion: typeof EPUB_POLICY | typeof CBZ_POLICY;
  resources: Array<{ resourceId: string; mediaType: string; size: number; width?: number; height?: number }>;
  spine: string[];
  toc: Array<{ title: string; resourceId: string; fragment?: string }>;
  reason?: string;
}
export interface PreparedResource {
  resourceId: string;
  mediaType: string;
  size: number;
  textLength?: number;
  width?: number;
  height?: number;
}
export interface ArchiveResult {
  state: 'ready' | 'download-only';
  resources: PreparedResource[];
  spine: string[];
  toc: ReaderDescriptor['toc'];
  reason?: string;
  failureCode?: 'UNSAFE_EPUB' | 'UNSAFE_CBZ' | 'WORKER_FAILURE' | 'WORKER_TIMEOUT';
  metrics: { entries: number; expandedBytes: number; peakTrackedBytes: number; elapsedMs: number;
    peakProcessRssBytes?: number; decoderConcurrency?: number; decoderCacheMemoryMiB?: number };
}
export class UnsafeEpub extends Error {
  constructor(reason: string) { super(reason); this.name = 'UnsafeEpub'; }
}
export function validateArchiveName(value: string): string {
  const name = value.normalize('NFC');
  const parts = name.replace(/\/$/, '').split('/');
  if (!name || name.length > 4096 || /^[\\/]|^[A-Za-z]:/.test(name) ||
      /[\\\u0000-\u001f\u007f]/.test(name) ||
      parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part))) {
    throw new UnsafeEpub('Unsafe archive name');
  }
  return name;
}
export class ArchiveBudget {
  expandedBytes = 0;
  entries = 0;
  peakTrackedBytes = 0;
  peakProcessRssBytes = 0;
  private entryBytes = 0;
  constructor(private readonly compressedBytes: number, private readonly signal?: AbortSignal) {
    if (!Number.isSafeInteger(compressedBytes) || compressedBytes <= 0) throw new UnsafeEpub('Invalid archive size');
    if (compressedBytes > EPUB_LIMITS.compressedBytes) throw new BooksError(413, 'EPUB_TOO_LARGE', DOWNLOAD_ONLY_REASON);
  }
  beginEntry(): void {
    this.signal?.throwIfAborted();
    if (this.entries >= EPUB_LIMITS.entries) throw new UnsafeEpub('Too many archive entries');
    this.entries += 1; this.entryBytes = 0;
  }
  consume(chunk: Uint8Array): void {
    const entry = this.entryBytes + chunk.byteLength;
    const expanded = this.expandedBytes + chunk.byteLength;
    if (entry > EPUB_LIMITS.entryBytes) throw new UnsafeEpub('Expanded entry limit exceeded');
    if (expanded > EPUB_LIMITS.expandedBytes) throw new UnsafeEpub('Aggregate expanded limit exceeded');
    if (expanded / this.compressedBytes > EPUB_LIMITS.ratio) throw new UnsafeEpub('Expansion ratio limit exceeded');
    this.entryBytes = entry; this.expandedBytes = expanded;
    this.checkMemory();
  }
  checkMemory(additionalBytes = 0): void {
    this.signal?.throwIfAborted();
    const memory = process.memoryUsage();
    this.peakProcessRssBytes = Math.max(this.peakProcessRssBytes, memory.rss);
    const accounted = memory.heapUsed + memory.external + additionalBytes;
    this.peakTrackedBytes = Math.max(this.peakTrackedBytes, accounted);
    if (accounted > EPUB_LIMITS.memoryBytes) throw new UnsafeEpub('Worker memory budget exceeded');
  }
}
