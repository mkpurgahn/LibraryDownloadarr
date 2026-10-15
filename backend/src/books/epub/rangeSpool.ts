import { FileHandle } from 'node:fs/promises';
import { IncomingMessage } from 'node:http';
import { BooksError } from '../limits';
import { BookRepresentation } from '../repository';
import { inspectHeaders } from '../relay';
import { CBZ_LIMITS, UnsafeEpub } from './manifest';
import { Coverage, PROGRESSIVE_LIMITS } from './progressiveTypes';

export class RangeUnavailable extends Error {}
export class RangeInterrupted extends Error {}
type OpenSource = (signal: AbortSignal, range?: string, ifRange?: string) => Promise<IncomingMessage>;

// Only the parent owns provider credentials. The worker can read committed disk intervals, never the network.
export class RangeSpool {
  readonly coverage: Coverage = [];
  receivedBytes = 0;
  requests = 0;
  processingMs = 0;
  mode: 'range' | 'full-download';
  private current?: AbortController;
  private readonly validator?: string;
  private fallback = false;
  constructor(
    readonly file: FileHandle, readonly representation: BookRepresentation,
    private readonly open: OpenSource, private readonly signal: AbortSignal
  ) {
    if (!Number.isSafeInteger(representation.size) || representation.size <= 0 ||
        representation.size > CBZ_LIMITS.compressedBytes) throw new UnsafeEpub('Invalid CBZ source size');
    this.validator = representation.etag && !representation.etag.startsWith('W/')
      ? representation.etag : representation.lastModified;
    this.mode = representation.ranges && this.validator ? 'range' : 'full-download';
  }
  interrupt(): void { this.current?.abort(); }
  measure<T>(run: () => T): T {
    const started = performance.now();
    try { return run(); } finally { this.processingMs += performance.now() - started; }
  }
  private commit(start: number, end: number): void {
    this.coverage.push([start, end]);
    this.coverage.sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < this.coverage.length;) {
      if (this.coverage[i][0] <= this.coverage[i - 1][1]) {
        this.coverage[i - 1][1] = Math.max(this.coverage[i - 1][1], this.coverage[i][1]);
        this.coverage.splice(i, 1);
      } else i++;
    }
  }
  private async receive(start: number, end: number, full = false): Promise<void> {
    this.signal.throwIfAborted();
    if (this.requests >= PROGRESSIVE_LIMITS.requests ||
        this.receivedBytes + end - start > this.representation.size + PROGRESSIVE_LIMITS.overheadBytes) {
      throw new BooksError(422, 'CBZ_RANGE_BUDGET');
    }
    this.requests++;
    const controller = new AbortController();
    this.current = controller;
    const combined = AbortSignal.any([this.signal, controller.signal]);
    const response = await this.open(combined, full ? undefined : `bytes=${start}-${end - 1}`, this.validator)
      .catch(error => {
        if (this.current === controller) this.current = undefined;
        if (controller.signal.aborted && !this.signal.aborted) throw new RangeInterrupted();
        throw error;
      });
    const count = (bytes: number) => {
      this.receivedBytes += bytes;
      if (this.receivedBytes > this.representation.size + PROGRESSIVE_LIMITS.overheadBytes) {
        response.destroy(new BooksError(422, 'CBZ_RANGE_BUDGET'));
      }
    };
    // Include parser-buffered and abandoned chunks, not just data consumed by the disk writer.
    const push = response.push;
    count(response.readableLength);
    response.push = (chunk: Uint8Array | string | null, encoding?: BufferEncoding) => {
      if (chunk !== null) count(typeof chunk === 'string' ? Buffer.byteLength(chunk, encoding) : chunk.byteLength);
      return push.call(response, chunk, encoding);
    };
    try {
      const headers = response.headers;
      const representation = inspectHeaders(response, true);
      if (representation.etag !== this.representation.etag || representation.lastModified !== this.representation.lastModified) {
        throw new BooksError(409, 'BOOK_VERSION_CHANGED');
      }
      if (headers['x-accel-redirect'] || (headers['content-encoding'] && headers['content-encoding'] !== 'identity')) {
        throw new BooksError(502, 'ABS_INVALID_RANGE_RESPONSE');
      }
      if (!full && response.statusCode === 200) {
        if (headers['content-length'] !== String(this.representation.size)) throw new BooksError(409, 'BOOK_VERSION_CHANGED');
        throw new RangeUnavailable();
      }
      if (response.statusCode !== (full ? 200 : 206) || headers['content-length'] !== String(end - start) ||
          (!full && headers['content-range'] !== `bytes ${start}-${end - 1}/${this.representation.size}`)) {
        throw new BooksError(502, 'ABS_INVALID_RANGE_RESPONSE');
      }
      let position = start;
      for await (const value of response) {
        const chunk: Buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
        this.signal.throwIfAborted();
        if (position + chunk.length > end || this.receivedBytes > this.representation.size + PROGRESSIVE_LIMITS.overheadBytes) {
          throw new BooksError(422, 'CBZ_RANGE_BUDGET');
        }
        let offset = 0;
        while (offset < chunk.length) {
          const { bytesWritten } = await this.file.write(chunk, offset, chunk.length - offset, position + offset);
          if (!bytesWritten) throw new Error('CBZ spool write failed');
          offset += bytesWritten;
        }
        position += chunk.length;
      }
      if (position !== end || !response.complete) throw new BooksError(502, 'ABS_FILE_INCOMPLETE');
      this.commit(start, end);
    } catch (error) {
      if (controller.signal.aborted && !this.signal.aborted) throw new RangeInterrupted();
      throw error;
    } finally {
      response.destroy();
      response.push = push;
      if (this.current === controller) this.current = undefined;
    }
  }
  async fullDownload(): Promise<void> {
    if (this.fallback) throw new BooksError(502, 'ABS_RANGE_LOST');
    this.fallback = true; this.mode = 'full-download';
    await this.receive(0, this.representation.size, true);
  }
  async ensure(start: number, end: number): Promise<void> {
    if (![start, end].every(Number.isSafeInteger) || start < 0 || end < start || end > this.representation.size) {
      throw new UnsafeEpub('Archive offset outside original');
    }
    for (let position = start; position < end;) {
      const covered = this.coverage.find(([a, b]) => a <= position && b > position);
      if (covered) { position = Math.min(end, covered[1]); continue; }
      const next = this.coverage.find(([a]) => a > position)?.[0] ?? end;
      const stop = Math.min(end, next, position + PROGRESSIVE_LIMITS.blockBytes);
      await this.receive(position, stop);
      position = stop;
    }
  }
  async read(start: number, length: number): Promise<Buffer> {
    await this.ensure(start, start + length);
    const bytes = Buffer.alloc(length);
    const { bytesRead } = await this.file.read(bytes, 0, length, start);
    if (bytesRead !== length) throw new UnsafeEpub('Incomplete private spool');
    return bytes;
  }
  async directory(): Promise<number> {
    const total = this.representation.size;
    const tailStart = Math.max(0, total - 65557);
    const tail = await this.read(tailStart, total - tailStart);
    let started: number | undefined = performance.now();
    const pause = () => {
      if (started !== undefined) { this.processingMs += performance.now() - started; started = undefined; }
    };
    try {
      let eocd = -1;
      for (let i = tail.length - 22; i >= 0; i--) {
        if (tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) === tail.length) {
          if (eocd !== -1) throw new UnsafeEpub('Ambiguous ZIP footer');
          eocd = i;
        }
      }
      if (eocd < 0) throw new UnsafeEpub('Invalid ZIP footer');
      const disk = tail.readUInt16LE(eocd + 4), directoryDisk = tail.readUInt16LE(eocd + 6);
      if (![0, 0xffff].includes(disk) || ![0, 0xffff].includes(directoryDisk)) throw new UnsafeEpub('Split ZIP directory');
      let entries = tail.readUInt16LE(eocd + 10);
      let length = tail.readUInt32LE(eocd + 12);
      let start = tail.readUInt32LE(eocd + 16);
      let boundary = tailStart + eocd;
      if (disk === 0xffff || directoryDisk === 0xffff || entries === 0xffff || length === 0xffffffff || start === 0xffffffff) {
        if (boundary < 20) throw new UnsafeEpub('Invalid ZIP64 footer');
        pause();
        const locator = await this.read(boundary - 20, 20);
        started = performance.now();
        if (locator.readUInt32LE(0) !== 0x07064b50 || locator.readUInt32LE(4) || locator.readUInt32LE(16) !== 1) {
          throw new UnsafeEpub('Invalid ZIP64 locator');
        }
        const offset = Number(locator.readBigUInt64LE(8));
        if (!Number.isSafeInteger(offset) || offset < 0 || offset + 56 > boundary - 20) throw new UnsafeEpub('Invalid ZIP64 offset');
        pause();
        const record = await this.read(offset, 56);
        started = performance.now();
        if (record.readUInt32LE(0) !== 0x06064b50 || record.readUInt32LE(16) || record.readUInt32LE(20) ||
            record.readBigUInt64LE(24) !== record.readBigUInt64LE(32) ||
            offset + 12 + Number(record.readBigUInt64LE(4)) !== boundary - 20) throw new UnsafeEpub('Invalid ZIP64 directory');
        entries = Number(record.readBigUInt64LE(32));
        length = Number(record.readBigUInt64LE(40));
        start = Number(record.readBigUInt64LE(48));
        boundary = offset;
      } else if (tail.readUInt16LE(eocd + 8) !== entries) throw new UnsafeEpub('Split ZIP directory');
      if (![entries, length, start].every(Number.isSafeInteger) || entries < 1 || entries > 10000 ||
          start < 0 || length < 46 || length > 64 * 1024 * 1024 || start + length !== boundary) {
        throw new UnsafeEpub('ZIP directory limits exceeded');
      }
      pause();
      await this.ensure(start, start + length);
      return start;
    } finally { pause(); }
  }
}
