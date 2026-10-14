import { isIP } from 'node:net';
import { Request } from 'express';
import { CatalogQuery } from './types';
import { config } from '../config';

export const SELECTED_LIBRARY_ID = '163ac435-50a9-4f56-96d0-276edf9303c1';
export const BOOKS_LIMITS = {
  metadataBytes: 8 * 1024 * 1024,
  metadataTimeoutMs: 10000,
  coverBytes: 2 * 1024 * 1024,
  coverCacheBytes: 64 * 1024 * 1024,
  coverTtlMs: 5 * 60 * 1000,
  metadataCacheBytes: 8 * 1024 * 1024,
  metadataTtlMs: 30000,
  connectionTimeoutMs: 10000,
  idleTimeoutMs: 60000,
} as const;

export class BooksError extends Error {
  constructor(public readonly status: number, public readonly code: string, message = code) {
    super(message);
    this.name = 'BooksError';
  }
}
export const notFound = (): BooksError => new BooksError(404, 'BOOK_NOT_FOUND', 'Book not found');
export const invalidInput = (): BooksError => new BooksError(400, 'INVALID_BOOKS_REQUEST', 'Invalid Books request');

export function opaqueSegment(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(value)) throw notFound();
  return value;
}

export function privateAddress(address: string): boolean {
  if (address === '::1' || /^f[cd][0-9a-f]{2}:/i.test(address)) return true;
  if (address.startsWith('::ffff:')) return privateAddress(address.substring(7));
  if (isIP(address) !== 4) return false;
  const [a, b] = address.split('.').map(Number);
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export function providerOrigin(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw invalidInput(); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash) throw invalidInput();
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (url.protocol === 'http:' && !privateAddress(hostname) &&
      hostname !== 'localhost' && !/^[a-z0-9][a-z0-9-]*$/i.test(hostname)) {
    throw new BooksError(400, 'PRIVATE_ABS_ORIGIN_REQUIRED', 'HTTP requires an approved private ABS origin');
  }
  return url;
}

export function sameOrigin(req: Request): void {
  // An inner HTTP proxy can overwrite the public TLS scheme; pin it explicitly rather than trusting more headers.
  const expected = config.server.publicOrigin || `${req.protocol}://${req.get('host')}`;
  if (!req.headers.origin || req.headers.origin !== expected ||
      (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin')) {
    throw new BooksError(403, 'SAME_ORIGIN_REQUIRED', 'Same-origin request required');
  }
}

export function boundedQuery(query: Record<string, unknown>): CatalogQuery {
  if (Object.keys(query).some(key => !['page', 'limit', 'filter', 'sort', 'desc'].includes(key))) throw invalidInput();
  const integer = (value: unknown, fallback: number): number => {
    if (value === undefined) return fallback;
    if (typeof value !== 'string' || !/^\d{1,9}$/.test(value)) throw invalidInput();
    return Number(value);
  };
  const page = integer(query.page, 0);
  const limit = integer(query.limit, 50);
  const filter = query.filter ?? 'all';
  const sort = query.sort ?? 'title';
  const desc = query.desc ?? 'false';
  if (limit < 1 || !['all', 'ebook', 'single', 'multi'].includes(String(filter)) ||
      !['title', 'author'].includes(String(sort)) || !['true', 'false', '1', '0'].includes(String(desc)) ||
      typeof filter !== 'string' || typeof sort !== 'string' || typeof desc !== 'string') throw invalidInput();
  return {
    page, limit: Math.min(100, limit),
    filter: filter as CatalogQuery['filter'], sort: sort as CatalogQuery['sort'],
    desc: desc === 'true' || desc === '1',
  };
}

export class WindowBudget {
  private readonly users = new Map<string, { count: number; end: number }>();
  constructor(private readonly limit: number, private readonly windowMs: number) {}
  take(user: string): void {
    const now = Date.now();
    for (const [key, value] of this.users) if (value.end <= now) this.users.delete(key);
    const value = this.users.get(user);
    if (value && value.count >= this.limit) throw new BooksError(429, 'BOOKS_RATE_LIMIT', 'Books request limit reached');
    if (value) value.count += 1;
    else {
      if (this.users.size >= 10000) throw new BooksError(429, 'BOOKS_CAPACITY', 'Books is busy');
      this.users.set(user, { count: 1, end: now + this.windowMs });
    }
  }
}

export class ByteCache<T> {
  private readonly entries = new Map<string, { value: T; bytes: number; until: number }>();
  private bytes = 0;
  constructor(private readonly maxBytes: number, private readonly ttlMs: number) {}
  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.until <= Date.now()) { this.remove(key); return undefined; }
    this.entries.delete(key); this.entries.set(key, entry);
    return entry.value;
  }
  put(key: string, value: T, bytes: number): void {
    this.remove(key);
    if (bytes > this.maxBytes) return;
    while (this.bytes + bytes > this.maxBytes) this.remove(this.entries.keys().next().value!);
    this.entries.set(key, { value, bytes, until: Date.now() + this.ttlMs });
    this.bytes += bytes;
  }
  clear(): void { this.entries.clear(); this.bytes = 0; }
  private remove(key: string): void {
    const entry = this.entries.get(key);
    if (entry) { this.bytes -= entry.bytes; this.entries.delete(key); }
  }
}

export function validateCover(body: Buffer, mime: string): boolean {
  if (body.length > BOOKS_LIMITS.coverBytes) return false;
  let width = 0; let height = 0;
  if (mime === 'image/png' && body.length >= 24 &&
      body.subarray(0, 16).equals(Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'))) {
    width = body.readUInt32BE(16); height = body.readUInt32BE(20);
  } else if (mime === 'image/jpeg' && body[0] === 0xff && body[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < body.length) {
      if (body[offset] !== 0xff) return false;
      const marker = body[offset + 1];
      const size = body.readUInt16BE(offset + 2);
      if (size < 2 || offset + 2 + size > body.length) return false;
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        height = body.readUInt16BE(offset + 5); width = body.readUInt16BE(offset + 7); break;
      }
      offset += 2 + size;
    }
  } else if (mime === 'image/webp' && body.length >= 30 &&
      body.toString('ascii', 0, 4) === 'RIFF' && body.toString('ascii', 8, 12) === 'WEBP') {
    const type = body.toString('ascii', 12, 16);
    if (type === 'VP8X') { width = 1 + body.readUIntLE(24, 3); height = 1 + body.readUIntLE(27, 3); }
    else if (type === 'VP8 ' && body.subarray(23, 26).equals(Buffer.from([0x9d, 0x01, 0x2a]))) {
      width = body.readUInt16LE(26) & 0x3fff; height = body.readUInt16LE(28) & 0x3fff;
    } else if (type === 'VP8L' && body[20] === 0x2f) {
      const bits = body.readUInt32LE(21);
      width = 1 + (bits & 0x3fff); height = 1 + ((bits >>> 14) & 0x3fff);
    }
  }
  return width > 0 && height > 0 && width <= 512 && height <= 512;
}
