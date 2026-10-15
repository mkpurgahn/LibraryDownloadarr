import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { Worker } from 'node:worker_threads';
import { BooksError, notFound, opaqueSegment } from '../limits';
import {
  ArchiveFormat, ArchiveResult, CBZ_DOWNLOAD_ONLY_REASON, CBZ_POLICY, DOWNLOAD_ONLY_REASON, EPUB_LIMITS,
  EPUB_POLICY, ReaderDescriptor, UnsafeEpub, archiveCompressedLimit, cbzContentVersion, epubContentVersion,
} from './manifest';
import { DatabaseService } from '../../models/database';
import { BooksCatalog } from '../catalog';
import { BooksRelay } from '../relay';
import { BooksPrincipal } from '../mediaAuth';
import { BookTarget } from '../tickets';
import { EbookLocator } from '../progressTypes';
import { logger } from '../../utils/logger';
import { ensurePlexMembership } from '../../services/membershipService';
import { PlexService } from '../../services/plexService';
import { config } from '../../config';
import { ProgressiveComic } from './progressive';
import { RangeSpool } from './rangeSpool';
import { ProgressiveDescriptor } from './progressiveTypes';

export async function runArchiveWorker(
  source: string, output: string, signal: AbortSignal,
  factory?: () => Worker, format: ArchiveFormat = 'epub'
): Promise<ArchiveResult> {
  if (signal.aborted) throw new DOMException('Preparation cancelled', 'AbortError');
  if ((await fs.stat(source)).size > archiveCompressedLimit(format)) {
    throw new BooksError(413, format === 'cbz' ? 'CBZ_TOO_LARGE' : 'EPUB_TOO_LARGE',
      format === 'cbz' ? CBZ_DOWNLOAD_ONLY_REASON : DOWNLOAD_ONLY_REASON);
  }
  const started = performance.now();
  const worker = factory ? factory() : new Worker(path.join(__dirname, 'worker.js'), {
    workerData: { source, output, format },
    env: {},
    resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
  });
  return new Promise((resolve, reject) => {
    let settled = false;
    let cancellation: 'abort' | 'timeout' | undefined;
    let cancellationTimer: NodeJS.Timeout | undefined;
    const unsupported = (): ArchiveResult => ({
      state: 'download-only', resources: [], spine: [], toc: [],
      reason: format === 'cbz' ? CBZ_DOWNLOAD_ONLY_REASON : DOWNLOAD_ONLY_REASON,
      failureCode: 'WORKER_FAILURE',
      metrics: { entries: 0, expandedBytes: 0, peakTrackedBytes: 0, elapsedMs: performance.now() - started },
    });
    const finish = (value: ArchiveResult, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(watchdog); clearTimeout(cancellationTimer);
      signal.removeEventListener('abort', abort);
      void worker.terminate().then(() => {
        if (error) reject(error); else resolve(value);
      }, reject);
    };
    const cancelledError = () => cancellation === 'abort' ? new DOMException('Preparation cancelled', 'AbortError') : undefined;
    const cancelledResult = () => ({ ...unsupported(), failureCode: 'WORKER_TIMEOUT' as const });
    const cancel = (reason: 'abort' | 'timeout') => {
      if (settled) return;
      if (cancellation) { if (reason === 'abort') cancellation = reason; return; }
      cancellation = reason;
      worker.postMessage({ type: 'cancel' });
      cancellationTimer = setTimeout(() => finish(cancelledResult(), cancelledError()), 1000);
    };
    const abort = () => cancel('abort');
    // Cooperate first so in-flight file handles close; an unresponsive worker still has the original hard deadline.
    const timer = setTimeout(() => cancel('timeout'), EPUB_LIMITS.timeoutMs - 1000);
    const watchdog = setTimeout(() => finish(cancelledResult(), cancelledError()), EPUB_LIMITS.timeoutMs);
    signal.addEventListener('abort', abort, { once: true });
    worker.once('message', (value: ArchiveResult) => finish(cancellation === 'timeout' ? cancelledResult() : value, cancelledError()));
    worker.once('error', () => finish(unsupported(), cancelledError()));
    worker.once('exit', () => { if (!settled) finish(unsupported(), cancelledError()); });
    if (signal.aborted) abort();
  });
}

interface CacheEntry {
  format: ArchiveFormat;
  key: string;
  directory: string;
  target: BookTarget;
  generation: number;
  result: ArchiveResult;
  bytes: number;
  createdAt: number;
  usedAt: number;
  readers: number;
  progressive?: {
    job: ProgressiveComic; owner: string;
    cancel(): Promise<void>;
  };
}
interface Handle {
  principal: BooksPrincipal;
  entry?: CacheEntry;
  expiresAt: number;
  polling?: boolean;
}
let preparing = false;
const expiredReader = () => new BooksError(410, 'BOOK_READER_EXPIRED', 'Reader expired; open the book again.');

export class EpubPreparation {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly handles = new Map<string, Handle>();
  private readonly active = new Set<{ principal: BooksPrincipal; controller: AbortController; entry?: CacheEntry; closed: Promise<void> }>();
  private initialization?: Promise<void>;
  private stopped = false;
  private readonly timer: NodeJS.Timeout;
  private maintenance: Promise<void> = Promise.resolve();
  private readonly cleanup = new Set<Promise<void>>();
  private cleanupFailure?: unknown;

  constructor(
    private readonly db: DatabaseService,
    private readonly catalog: BooksCatalog,
    private readonly relay: BooksRelay,
    private readonly plex: PlexService,
    private readonly now = Date.now
  ) {
    db.onSessionRevoked(id => this.revokeSession(id));
    db.books.onConfigChanged(() => {
      for (const operation of this.active) operation.controller.abort();
      for (const entry of this.cache.values()) entry.progressive?.cancel();
      this.handles.clear();
    });
    db.onBooksStopped(() => {
      this.stopped = true; clearInterval(this.timer);
      for (const operation of this.active) operation.controller.abort();
      for (const entry of this.cache.values()) entry.progressive?.cancel();
      this.handles.clear();
      return this.drain();
    });
    this.timer = setInterval(() => {
      void this.prune(0).catch(() => logger.error('Books reader cache maintenance failed', { code: 'EPUB_CACHE_IO' }));
    }, 60000);
    this.timer.unref();
  }
  private track(promise: Promise<void>): void {
    this.cleanup.add(promise);
    void promise.then(() => this.cleanup.delete(promise), error => {
      this.cleanup.delete(promise); this.cleanupFailure = error;
    });
  }
  private async drain(): Promise<void> {
    await Promise.all([...this.active].map(operation => operation.closed));
    while (this.cleanup.size) await Promise.all([...this.cleanup]);
    await this.maintenance;
    if (this.cleanupFailure) throw this.cleanupFailure;
  }
  revokeSession(id: string): void {
    for (const entry of this.cache.values()) if (entry.progressive?.owner === id && entry.progressive.job.state !== 'complete') entry.progressive.cancel();
    for (const [key, handle] of this.handles) if (handle.principal.sessionId === id) this.handles.delete(key);
    for (const operation of this.active) if (operation.principal.sessionId === id) operation.controller.abort();
  }
  private session(principal: BooksPrincipal): void {
    if (this.stopped || principal.expiresAt <= this.now() ||
        this.db.getSessionById(principal.sessionId)?.userId !== principal.userId) {
      throw new BooksError(401, 'BOOKS_SESSION_REQUIRED');
    }
  }
  private key(target: BookTarget, format: ArchiveFormat): string {
    return createHash('sha256').update(JSON.stringify([
      this.catalog.current().config.configGeneration, target.itemId, target.fileId, target.contentVersion,
      format === 'cbz' ? CBZ_POLICY : EPUB_POLICY,
    ])).digest('hex');
  }
  private initialize(): Promise<void> {
    if (!this.initialization) this.initialization = (async () => {
      await fs.mkdir(this.db.booksCacheDir, { recursive: true, mode: 0o700 });
      if ((await fs.lstat(this.db.booksCacheDir)).isSymbolicLink()) throw new Error('Reader cache cannot be a symbolic link');
      for (const name of await fs.readdir(this.db.booksCacheDir)) {
        if (/^prepared-[a-f0-9]{64}$|^work-[a-f0-9-]{36}$/.test(name)) {
          await fs.rm(path.join(this.db.booksCacheDir, name), { recursive: true, force: true });
        }
      }
    })();
    return this.initialization;
  }
  private prune(reserve: number): Promise<void> {
    const run = async () => {
      const now = this.now();
      for (const handle of this.handles.values()) if (handle.expiresAt <= now) handle.entry = undefined;
      for (const entry of [...this.cache.values()]) {
        if (entry.progressive && entry.progressive.job.state !== 'complete' &&
            ![...this.handles.values()].some(handle => handle.entry === entry)) await entry.progressive.cancel();
      }
      let bytes = [...this.cache.values()].reduce((sum, entry) => sum + entry.bytes, 0);
      for (const entry of [...this.cache.values()].sort((a, b) => a.usedAt - b.usedAt)) {
        const outdated = entry.createdAt + EPUB_LIMITS.cacheTtlMs <= now;
        if (entry.readers || (!outdated && bytes + reserve <= EPUB_LIMITS.cacheBytes && this.cache.size < EPUB_LIMITS.cacheEntries)) continue;
        this.cache.delete(entry.key);
        for (const handle of this.handles.values()) if (handle.entry === entry) handle.entry = undefined;
        await fs.rm(entry.directory, { recursive: true, force: true });
        bytes -= entry.bytes;
      }
      if (bytes + reserve > EPUB_LIMITS.cacheBytes) throw new BooksError(429, 'EPUB_CACHE_BUSY', 'Reader cache is busy; try again shortly.');
    };
    const result = this.maintenance.then(run);
    this.maintenance = result.catch(() => {});
    return result;
  }
  private operation(principal: BooksPrincipal, signal: AbortSignal, entry?: CacheEntry) {
    this.session(principal);
    const controller = new AbortController();
    const abort = () => controller.abort();
    let finish!: () => void;
    const closed = new Promise<void>(resolve => { finish = resolve; });
    const record = { principal, controller, entry, closed };
    this.active.add(record);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    const expiry = setTimeout(abort, Math.max(1, Math.min(2147483647, principal.expiresAt - this.now())));
    expiry.unref();
    let timer: NodeJS.Timeout;
    const schedule = () => {
      timer = setTimeout(() => {
        void (async () => {
          this.session(principal);
          await ensurePlexMembership(this.db, principal.userId, true, this.plex);
          this.session(principal);
        })().then(() => { if (!controller.signal.aborted) schedule(); }, abort);
      }, Math.max(1, Math.min(config.plex.membershipTtlMs || 100, principal.expiresAt - this.now())));
      timer.unref();
    };
    schedule();
    return {
      signal: controller.signal,
      detach: () => signal.removeEventListener('abort', abort),
      close: () => { clearTimeout(timer); clearTimeout(expiry); signal.removeEventListener('abort', abort); this.active.delete(record); controller.abort(); finish(); },
    };
  }
  private describe(principal: BooksPrincipal, entry: CacheEntry): ReaderDescriptor {
    this.session(principal);
    if (entry.generation !== this.catalog.current().config.configGeneration) throw new BooksError(409, 'BOOKS_CONFIGURATION_CHANGED');
    for (const [id, handle] of this.handles) if (handle.expiresAt <= this.now()) this.handles.delete(id);
    if (this.handles.size >= EPUB_LIMITS.handles) throw new BooksError(429, 'EPUB_HANDLE_CAPACITY', 'Too many open readers.');
    const readerId = randomUUID();
    this.handles.set(readerId, { principal, entry, expiresAt: Math.min(principal.expiresAt, this.now() + EPUB_LIMITS.handleTtlMs) });
    return {
      readerId, state: entry.result.state,
      contentVersion: entry.format === 'cbz' ? cbzContentVersion(entry.target.contentVersion) : epubContentVersion(entry.target.contentVersion),
      policyVersion: entry.format === 'cbz' ? CBZ_POLICY : EPUB_POLICY,
      resources: entry.result.resources.map(({ resourceId, mediaType, size, width, height }) =>
        ({ resourceId, mediaType, size, ...(width && height ? { width, height } : {}) })),
      spine: entry.result.spine, toc: entry.result.toc, ...(entry.result.reason ? { reason: entry.result.reason } : {}),
    };
  }
  async prepareReader(principal: BooksPrincipal, target: BookTarget, signal: AbortSignal): Promise<ReaderDescriptor> {
    this.session(principal);
    await this.initialize();
    const checked = await this.relay.inspect(principal, target, signal);
    const format = checked.file.extension;
    if ((format !== 'epub' && format !== 'cbz') || checked.file.role !== 'ebook') throw new BooksError(422, 'BOOK_DOWNLOAD_ONLY', DOWNLOAD_ONLY_REASON);
    const compressedLimit = archiveCompressedLimit(format);
    if (checked.file.size > compressedLimit) throw new BooksError(413, format === 'cbz' ? 'CBZ_TOO_LARGE' : 'EPUB_TOO_LARGE',
      format === 'cbz' ? CBZ_DOWNLOAD_ONLY_REASON : DOWNLOAD_ONLY_REASON);
    const key = this.key(target, format);
    await this.prune(0);
    const cached = this.cache.get(key);
    if (cached) {
      if (cached.progressive && cached.progressive.job.state !== 'complete') {
        throw new BooksError(cached.progressive.job.state === 'preparing' ? 429 : 422,
          cached.progressive.job.state === 'preparing' ? 'EPUB_PREPARATION_BUSY' : 'BOOK_DOWNLOAD_ONLY',
          'This book is not fully prepared. Reopen the reader or download the original.');
      }
      if (cached.createdAt + EPUB_LIMITS.cacheTtlMs <= this.now()) throw new BooksError(429, 'EPUB_CACHE_BUSY', 'An active read is finishing; try again shortly.');
      cached.usedAt = this.now(); return this.describe(principal, cached);
    }
    if (preparing) throw new BooksError(429, 'EPUB_PREPARATION_BUSY', 'Another book is being prepared; try again shortly.');
    const operation = this.operation(principal, signal);
    preparing = true;
    const work = path.join(this.db.booksCacheDir, `work-${randomUUID()}`);
    const destination = path.join(this.db.booksCacheDir, `prepared-${key}`);
    try {
      await this.prune(EPUB_LIMITS.expandedBytes + compressedLimit);
      await fs.mkdir(work, { mode: 0o700 });
      const original = path.join(work, 'original');
      const source = await fs.open(original, 'wx', 0o600);
      try {
        await this.relay.copyOriginal(principal, target, source.createWriteStream({ autoClose: false }), operation.signal, compressedLimit);
      } finally { await source.close(); }
      const result = await runArchiveWorker(original, path.join(work, 'resources'), operation.signal, undefined, format);
      if (operation.signal.aborted) throw new DOMException('Preparation cancelled', 'AbortError');
      this.session(principal);
      if (checked.configGeneration !== this.catalog.current().config.configGeneration) throw new BooksError(409, 'BOOKS_CONFIGURATION_CHANGED');
      if (result.failureCode) logger.warn('Books archive is download-only', { format, code: result.failureCode, ...result.metrics });
      else logger.info('Books archive preparation completed', { format, code: 'BOOK_ARCHIVE_PREPARED', ...result.metrics });
      if (result.state === 'ready') await fs.rename(path.join(work, 'resources'), destination);
      const entry: CacheEntry = {
        key, format, directory: destination, target, generation: checked.configGeneration, result,
        bytes: result.resources.reduce((sum, resource) => sum + resource.size, 0),
        createdAt: this.now(), usedAt: this.now(), readers: 0,
      };
      this.cache.set(key, entry);
      return this.describe(principal, entry);
    } finally {
      operation.close();
      try { await fs.rm(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
      finally { preparing = false; }
    }
  }
  private progressiveDescriptor(readerId: string, entry: CacheEntry): ProgressiveDescriptor {
    const job = entry.progressive?.job;
    const ready = new Set(entry.result.resources.map(r => r.resourceId));
    return {
      protocol: 'cbz-progressive-v1', revision: job?.revision ?? 0,
      readerId, policyVersion: CBZ_POLICY, contentVersion: cbzContentVersion(entry.target.contentVersion),
      state: job?.state ?? 'complete', mode: job?.spool.mode ?? 'full-download',
      spine: [...entry.result.spine], resources: [...entry.result.resources],
      pages: entry.result.spine.map((resourceId, index) => ({ resourceId,
        state: ready.has(resourceId) ? 'ready' : job?.state === 'failed' ? 'failed'
          : job?.activePage === index + 1 ? 'validating' : 'pending' })),
      ...(job?.activePage ? { activePage: job.activePage } : {}),
      ...(job?.reason ? { reason: job.reason } : {}),
    };
  }
  async prepareProgressive(principal: BooksPrincipal, target: BookTarget, page: number, signal: AbortSignal) {
    const initial = this.operation(principal, signal);
    let checked: Awaited<ReturnType<BooksRelay['inspect']>>;
    try {
      await this.initialize();
      checked = await this.relay.inspect(principal, target, initial.signal);
    } finally { initial.close(); }
    if (checked.file.extension !== 'cbz' || checked.file.role !== 'ebook') throw new BooksError(422, 'BOOK_DOWNLOAD_ONLY');
    if (checked.file.size > archiveCompressedLimit('cbz')) throw new BooksError(413, 'CBZ_TOO_LARGE', CBZ_DOWNLOAD_ONLY_REASON);
    signal.throwIfAborted();
    const key = this.key(target, 'cbz');
    await this.prune(0);
    const cached = this.cache.get(key);
    if (cached?.result.state === 'ready' && (!cached.progressive || cached.progressive.job.state === 'complete')) {
      if (cached.createdAt + EPUB_LIMITS.cacheTtlMs <= this.now()) throw new BooksError(429, 'EPUB_CACHE_BUSY', 'An active read is finishing; try again shortly.');
      const { readerId } = this.describe(principal, cached);
      return { descriptor: this.progressiveDescriptor(readerId, cached),
        handoff: () => {}, cancel: () => { this.handles.delete(readerId); } };
    }
    if (preparing || cached?.progressive?.job.state === 'preparing') throw new BooksError(429, 'EPUB_PREPARATION_BUSY', 'Another book is being prepared; try again shortly.');
    if (cached) throw new BooksError(422, 'BOOK_DOWNLOAD_ONLY', cached.result.reason ?? CBZ_DOWNLOAD_ONLY_REASON);
    const operation = this.operation(principal, signal);
    preparing = true;
    const work = path.join(this.db.booksCacheDir, `work-${randomUUID()}`);
    const directory = path.join(this.db.booksCacheDir, `prepared-${key}`);
    let started = false;
    let source: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      const reserve = EPUB_LIMITS.expandedBytes + archiveCompressedLimit('cbz');
      await this.prune(reserve);
      await fs.mkdir(work, { mode: 0o700 });
      await fs.mkdir(directory, { mode: 0o700 });
      const filename = path.join(work, 'original');
      source = await fs.open(filename, 'wx+', 0o600);
      await source.truncate(checked.file.size);
      operation.signal.throwIfAborted();
      const entry: CacheEntry = {
        key, format: 'cbz', target, directory, generation: checked.configGeneration,
        bytes: reserve, createdAt: this.now(), usedAt: this.now(), readers: 1,
        result: { state: 'download-only', spine: [], resources: [], toc: [],
          metrics: { entries: 0, expandedBytes: 0, peakTrackedBytes: 0, elapsedMs: 0 } },
      };
      this.cache.set(key, entry);
      const { readerId } = this.describe(principal, entry);
      let invalidated = false;
      let finished: Promise<void>;
      let removal: Promise<void> | undefined;
      const cancel = (): Promise<void> => {
        invalidated = true;
        for (const [id, handle] of this.handles) if (handle.entry === entry) this.handles.delete(id);
        job.cancel();
        if (removal) return removal;
        entry.readers++;
        const reads = [...this.active].filter(operation => operation.entry === entry);
        for (const read of reads) read.controller.abort();
        removal = Promise.resolve().then(async () => {
          await finished;
          await Promise.all(reads.map(read => read.closed));
          await fs.rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
          this.cache.delete(key);
        }).catch(error => {
          logger.error('Progressive CBZ retained-data cleanup failed', { code: 'CBZ_CACHE_IO' }); throw error;
        });
        this.track(removal);
        return removal;
      };
      const check = () => {
        operation.signal.throwIfAborted(); this.session(principal);
        if (entry.generation !== this.catalog.current().config.configGeneration) throw new BooksError(409, 'BOOKS_CONFIGURATION_CHANGED');
      };
      const spool = new RangeSpool(source, checked.representation, async (requestSignal, range, ifRange) => {
        check();
        return checked.client.openFile(target.itemId, checked.ino, {
          method: 'GET', attachment: false, signal: requestSignal, range, ifRange,
        });
      }, operation.signal);
      const job = new ProgressiveComic(spool, filename, directory, page, operation.signal, check, () => {
        check();
        entry.result.resources = [...job.resources];
        entry.result.spine = [...job.spine];
        entry.result.state = job.state === 'complete' ? 'ready' : 'download-only';
      }, error => {
        invalidated ||= operation.signal.aborted || (error instanceof Error && error.name === 'AbortError') ||
          (error instanceof BooksError && [401, 403, 409].includes(error.status));
        if (invalidated) {
          cancel();
        }
        logger.warn('Progressive CBZ preparation stopped', {
          code: error instanceof BooksError ? error.code : invalidated ? 'CBZ_CANCELLED' : 'UNSAFE_CBZ',
          readyPages: job.resources.length,
          reason: error instanceof UnsafeEpub ? error.message : undefined,
        });
      }, async () => { await this.relay.inspect(principal, target, operation.signal); check(); });
      entry.progressive = { job, owner: principal.sessionId, cancel };
      started = true;
      const original = source;
      let workerCleaned = false;
      finished = job.done.then(() => { workerCleaned = true; }).finally(async () => {
        await original.close();
        await fs.rm(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        if (workerCleaned) {
          entry.bytes = entry.result.resources.reduce((sum, r) => sum + r.size, 0);
          entry.readers--;
        }
      }).catch(error => {
        logger.error('Progressive CBZ cleanup failed', { code: 'CBZ_CACHE_IO' });
        entry.result.state = 'download-only'; job.state = 'failed';
        this.handles.delete(readerId);
        throw error;
      }).finally(() => { operation.close(); preparing = false; });
      this.track(finished);
      return { descriptor: this.progressiveDescriptor(readerId, entry), handoff: operation.detach, cancel };
    } finally {
      if (!started) {
        operation.close();
        await source?.close();
        try {
          await fs.rm(work, { recursive: true, force: true });
          await fs.rm(directory, { recursive: true, force: true });
        } finally { this.cache.delete(key); preparing = false; }
      }
    }
  }
  async progressiveStatus(principal: BooksPrincipal, readerId: string, page: number | undefined, signal: AbortSignal): Promise<ProgressiveDescriptor> {
    const { entry } = this.handle(principal, readerId);
    if (entry.format !== 'cbz') throw notFound();
    const current = entry.progressive;
    const handle = this.handles.get(readerId)!;
    if (current && current.owner !== principal.sessionId && current.job.state !== 'complete') throw notFound();
    if (handle.polling) throw new BooksError(429, 'CBZ_STATUS_BUSY');
    if (page !== undefined && entry.result.spine.length && page > entry.result.spine.length) throw new BooksError(400, 'INVALID_BOOKS_REQUEST');
    handle.polling = true;
    try {
      await this.relay.inspect(principal, entry.target, signal);
      this.handle(principal, readerId);
      if (current) {
        current.job.renew();
        if (page !== undefined) current.job.prioritize(page);
        await current.job.wait(page, signal);
      }
      this.handle(principal, readerId);
      return this.progressiveDescriptor(readerId, entry);
    } catch (error) {
      if (error instanceof BooksError && [401, 403, 409].includes(error.status)) current?.cancel();
      throw error;
    } finally { handle.polling = false; }
  }
  private handle(principal: BooksPrincipal, readerId: string): Handle & { entry: CacheEntry } {
    this.session(principal);
    const handle = this.handles.get(opaqueSegment(readerId));
    if (!handle || handle.principal.sessionId !== principal.sessionId || handle.principal.userId !== principal.userId) throw notFound();
    if (handle.expiresAt <= this.now() || !handle.entry || !this.cache.has(handle.entry.key)) throw expiredReader();
    if (handle.entry.generation !== this.catalog.current().config.configGeneration) throw new BooksError(409, 'BOOKS_CONFIGURATION_CHANGED');
    return { ...handle, entry: handle.entry };
  }
  async readResource(principal: BooksPrincipal, readerId: string, resourceId: string, signal: AbortSignal): Promise<Readable> {
    const handle = this.handle(principal, readerId);
    const entry = handle.entry;
    const resource = entry.result.resources.find(resource => resource.resourceId === opaqueSegment(resourceId));
    if (!resource && entry.progressive && entry.result.spine.includes(resourceId)) {
      if (entry.progressive.job.state === 'failed') throw new BooksError(422, 'CBZ_PAGE_FAILED', 'This page could not be validated; download the original.');
      throw new BooksError(425, 'CBZ_PAGE_PENDING', 'This page has not been validated yet.');
    }
    if (!resource || (entry.result.state !== 'ready' && !entry.progressive)) throw notFound();
    if (entry.readers >= 8 || this.active.size >= 16) throw new BooksError(429, 'EPUB_RESOURCE_BUSY');
    const operation = this.operation(principal, signal, entry);
    entry.readers += 1;
    let handedOff = false;
    const release = () => { entry.readers -= 1; operation.close(); };
    try {
      await this.relay.inspect(principal, entry.target, operation.signal);
      this.handle(principal, readerId);
      if (operation.signal.aborted) throw new DOMException('Resource cancelled', 'AbortError');
      const stream = createReadStream(path.join(entry.directory, resource.resourceId), { signal: operation.signal });
      stream.once('close', release);
      entry.usedAt = this.now(); handedOff = true;
      return stream;
    } catch (error) {
      if (error instanceof BooksError && [401, 403, 409].includes(error.status)) entry.progressive?.cancel();
      throw error;
    } finally { if (!handedOff) release(); }
  }
  resourceSize(principal: BooksPrincipal, readerId: string, resourceId: string): number {
    const resource = this.handle(principal, readerId).entry.result.resources.find(resource => resource.resourceId === resourceId);
    if (!resource) throw notFound();
    return resource.size;
  }
  release(principal: BooksPrincipal, readerId: string): void {
    const { entry } = this.handle(principal, readerId); this.handles.delete(readerId);
    if (entry.progressive && entry.progressive.job.state !== 'complete') entry.progressive.cancel();
  }
  async validateLocator(principal: BooksPrincipal, target: BookTarget, locator: EbookLocator, signal: AbortSignal): Promise<boolean> {
    if ((locator.kind !== 'epub' || locator.policyVersion !== EPUB_POLICY) &&
        (locator.kind !== 'cbz' || locator.policyVersion !== CBZ_POLICY)) return false;
    const checked = await this.relay.inspect(principal, target, signal);
    if (checked.file.extension !== locator.kind) return false;
    const entry = this.cache.get(this.key(target, locator.kind));
    if (!entry || (entry.result.state !== 'ready' && !entry.progressive) || entry.createdAt + EPUB_LIMITS.cacheTtlMs <= this.now()) return false;
    if (locator.kind === 'cbz') {
      if (entry.progressive && entry.progressive.job.state !== 'complete' &&
          ![...this.handles.values()].some(h => h.entry === entry && h.principal.sessionId === principal.sessionId && h.expiresAt > this.now())) return false;
      return entry.result.resources.some(r => r.resourceId === entry.result.spine[locator.page - 1]);
    }
    const resource = entry.result.resources.find(resource => resource.resourceId === locator.resourceId);
    return Boolean(resource && entry.result.spine.includes(resource.resourceId) &&
      resource.textLength !== undefined && locator.textOffset <= resource.textLength);
  }
}
