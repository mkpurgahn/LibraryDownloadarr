import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { Worker } from 'node:worker_threads';
import { BooksError, notFound, opaqueSegment } from '../limits';
import { ArchiveResult, DOWNLOAD_ONLY_REASON, EPUB_LIMITS, EPUB_POLICY, ReaderDescriptor, epubContentVersion } from './manifest';
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

export async function runArchiveWorker(
  source: string, output: string, signal: AbortSignal,
  factory?: () => Worker
): Promise<ArchiveResult> {
  if (signal.aborted) throw new DOMException('Preparation cancelled', 'AbortError');
  if ((await fs.stat(source)).size > EPUB_LIMITS.compressedBytes) {
    throw new BooksError(413, 'EPUB_TOO_LARGE', DOWNLOAD_ONLY_REASON);
  }
  const started = performance.now();
  const worker = factory ? factory() : new Worker(path.join(__dirname, 'worker.js'), {
    workerData: { source, output },
    env: {},
    resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
  });
  return new Promise((resolve, reject) => {
    let settled = false;
    const unsupported = (): ArchiveResult => ({
      state: 'download-only', resources: [], spine: [], toc: [], reason: DOWNLOAD_ONLY_REASON,
      failureCode: 'WORKER_FAILURE',
      metrics: { entries: 0, expandedBytes: 0, peakTrackedBytes: 0, elapsedMs: performance.now() - started },
    });
    const finish = (value: ArchiveResult, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      void worker.terminate().then(() => {
        if (error) reject(error); else resolve(value);
      }, reject);
    };
    const abort = () => finish(unsupported(), new DOMException('Preparation cancelled', 'AbortError'));
    const timer = setTimeout(() => finish({ ...unsupported(), failureCode: 'WORKER_TIMEOUT' }), EPUB_LIMITS.timeoutMs);
    signal.addEventListener('abort', abort, { once: true });
    worker.once('message', (value: ArchiveResult) => finish(value));
    worker.once('error', () => finish(unsupported()));
    worker.once('exit', () => { if (!settled) finish(unsupported()); });
    if (signal.aborted) abort();
  });
}

interface CacheEntry {
  key: string;
  directory: string;
  target: BookTarget;
  generation: number;
  result: ArchiveResult;
  bytes: number;
  createdAt: number;
  usedAt: number;
  readers: number;
}
interface Handle {
  principal: BooksPrincipal;
  entry?: CacheEntry;
  expiresAt: number;
}
let preparing = false;
const expiredReader = () => new BooksError(410, 'BOOK_READER_EXPIRED', 'Reader expired; open the book again.');

export class EpubPreparation {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly handles = new Map<string, Handle>();
  private readonly active = new Set<{ principal: BooksPrincipal; controller: AbortController }>();
  private initialization?: Promise<void>;
  private stopped = false;
  private readonly timer: NodeJS.Timeout;
  private maintenance: Promise<void> = Promise.resolve();

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
      this.handles.clear();
    });
    db.onBooksStopped(() => {
      this.stopped = true; clearInterval(this.timer);
      for (const operation of this.active) operation.controller.abort();
      this.handles.clear();
    });
    this.timer = setInterval(() => {
      void this.prune(0).catch(() => logger.error('Books reader cache maintenance failed', { code: 'EPUB_CACHE_IO' }));
    }, 60000);
    this.timer.unref();
  }
  revokeSession(id: string): void {
    for (const [key, handle] of this.handles) if (handle.principal.sessionId === id) this.handles.delete(key);
    for (const operation of this.active) if (operation.principal.sessionId === id) operation.controller.abort();
  }
  private session(principal: BooksPrincipal): void {
    if (this.stopped || principal.expiresAt <= this.now() ||
        this.db.getSessionById(principal.sessionId)?.userId !== principal.userId) {
      throw new BooksError(401, 'BOOKS_SESSION_REQUIRED');
    }
  }
  private key(target: BookTarget): string {
    return createHash('sha256').update(JSON.stringify([
      this.catalog.current().config.configGeneration, target.itemId, target.fileId, target.contentVersion, EPUB_POLICY,
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
  private operation(principal: BooksPrincipal, signal: AbortSignal) {
    this.session(principal);
    const controller = new AbortController();
    const abort = () => controller.abort();
    const record = { principal, controller };
    this.active.add(record);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
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
      close: () => { clearTimeout(timer); signal.removeEventListener('abort', abort); this.active.delete(record); controller.abort(); },
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
      readerId, state: entry.result.state, contentVersion: epubContentVersion(entry.target.contentVersion),
      policyVersion: EPUB_POLICY, resources: entry.result.resources.map(({ resourceId, mediaType, size }) => ({ resourceId, mediaType, size })),
      spine: entry.result.spine, toc: entry.result.toc, ...(entry.result.reason ? { reason: entry.result.reason } : {}),
    };
  }
  async prepareEpub(principal: BooksPrincipal, target: BookTarget, signal: AbortSignal): Promise<ReaderDescriptor> {
    this.session(principal);
    await this.initialize();
    const checked = await this.relay.inspect(principal, target, signal);
    if (checked.file.extension !== 'epub' || checked.file.role !== 'ebook') throw new BooksError(422, 'BOOK_DOWNLOAD_ONLY', DOWNLOAD_ONLY_REASON);
    if (checked.file.size > EPUB_LIMITS.compressedBytes) throw new BooksError(413, 'EPUB_TOO_LARGE', DOWNLOAD_ONLY_REASON);
    const key = this.key(target);
    await this.prune(0);
    const cached = this.cache.get(key);
    if (cached) {
      if (cached.createdAt + EPUB_LIMITS.cacheTtlMs <= this.now()) throw new BooksError(429, 'EPUB_CACHE_BUSY', 'An active read is finishing; try again shortly.');
      cached.usedAt = this.now(); return this.describe(principal, cached);
    }
    if (preparing) throw new BooksError(429, 'EPUB_PREPARATION_BUSY', 'Another book is being prepared; try again shortly.');
    const operation = this.operation(principal, signal);
    preparing = true;
    const work = path.join(this.db.booksCacheDir, `work-${randomUUID()}`);
    const destination = path.join(this.db.booksCacheDir, `prepared-${key}`);
    try {
      await this.prune(EPUB_LIMITS.expandedBytes + EPUB_LIMITS.compressedBytes);
      await fs.mkdir(work, { mode: 0o700 });
      const original = path.join(work, 'original');
      const source = await fs.open(original, 'wx', 0o600);
      try {
        await this.relay.copyOriginal(principal, target, source.createWriteStream({ autoClose: false }), operation.signal, EPUB_LIMITS.compressedBytes);
      } finally { await source.close(); }
      const result = await runArchiveWorker(original, path.join(work, 'resources'), operation.signal);
      if (operation.signal.aborted) throw new DOMException('Preparation cancelled', 'AbortError');
      this.session(principal);
      if (checked.configGeneration !== this.catalog.current().config.configGeneration) throw new BooksError(409, 'BOOKS_CONFIGURATION_CHANGED');
      if (result.failureCode) logger.warn('Books EPUB is download-only', { code: result.failureCode, ...result.metrics });
      else logger.info('Books EPUB preparation completed', { code: 'EPUB_PREPARED', ...result.metrics });
      if (result.state === 'ready') await fs.rename(path.join(work, 'resources'), destination);
      const entry: CacheEntry = {
        key, directory: destination, target, generation: checked.configGeneration, result,
        bytes: result.resources.reduce((sum, resource) => sum + resource.size, 0),
        createdAt: this.now(), usedAt: this.now(), readers: 0,
      };
      this.cache.set(key, entry);
      return this.describe(principal, entry);
    } finally {
      operation.close();
      try { await fs.rm(work, { recursive: true, force: true }); }
      finally { preparing = false; }
    }
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
    if (!resource || entry.result.state !== 'ready') throw notFound();
    if (entry.readers >= 8 || this.active.size >= 16) throw new BooksError(429, 'EPUB_RESOURCE_BUSY');
    const operation = this.operation(principal, signal);
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
    } finally { if (!handedOff) release(); }
  }
  resourceSize(principal: BooksPrincipal, readerId: string, resourceId: string): number {
    const resource = this.handle(principal, readerId).entry.result.resources.find(resource => resource.resourceId === resourceId);
    if (!resource) throw notFound();
    return resource.size;
  }
  release(principal: BooksPrincipal, readerId: string): void {
    this.handle(principal, readerId); this.handles.delete(readerId);
  }
  async validateLocator(principal: BooksPrincipal, target: BookTarget, locator: EbookLocator, signal: AbortSignal): Promise<boolean> {
    if (locator.kind !== 'epub' || locator.policyVersion !== EPUB_POLICY) return false;
    await this.relay.inspect(principal, target, signal);
    const entry = this.cache.get(this.key(target));
    if (!entry || entry.result.state !== 'ready' || entry.createdAt + EPUB_LIMITS.cacheTtlMs <= this.now()) return false;
    const resource = entry.result.resources.find(resource => resource.resourceId === locator.resourceId);
    return Boolean(resource && entry.result.spine.includes(resource.resourceId) &&
      resource.textLength !== undefined && locator.textOffset <= resource.textLength);
  }
}
