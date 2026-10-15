import fs from 'node:fs/promises';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { BooksError } from '../limits';
import { PreparedResource, CBZ_DOWNLOAD_ONLY_REASON, UnsafeEpub } from './manifest';
import { ComicCommand, ComicIndex, ComicReply, PROGRESSIVE_LIMITS } from './progressiveTypes';
import { RangeInterrupted, RangeSpool, RangeUnavailable } from './rangeSpool';

export class ProgressiveComic {
  readonly resources: PreparedResource[] = [];
  spine: string[] = [];
  state: 'preparing' | 'complete' | 'failed' = 'preparing';
  activePage?: number;
  reason?: string;
  revision = 0;
  private workerMs = 0;
  get processingMs(): number { return this.workerMs + this.spool.processingMs; }
  metrics: ComicReply['metrics'] = { expandedBytes: 0, peakTrackedBytes: 0, peakProcessRssBytes: 0 };
  private worker?: Worker;
  private readonly controller = new AbortController();
  private readonly signal: AbortSignal;
  private readonly listeners = new Set<() => void>();
  private priority: number;
  private priorityQueue: number[] = [];
  private lease: NodeJS.Timeout;
  private readonly deadline: NodeJS.Timeout;
  private workerFailed = false;
  private ending = false;
  readonly done: Promise<void>;
  constructor(
    readonly spool: RangeSpool, private readonly source: string, private readonly output: string,
    page: number, signal: AbortSignal, private readonly check: () => void,
    private readonly changed: () => void, private readonly failed: (error: unknown) => void,
    private readonly verify: () => Promise<void>
  ) {
    this.priority = page;
    this.signal = AbortSignal.any([signal, this.controller.signal]);
    this.lease = setTimeout(() => this.controller.abort(), PROGRESSIVE_LIMITS.leaseMs);
    this.deadline = setTimeout(() => this.controller.abort(), PROGRESSIVE_LIMITS.deadlineMs);
    this.done = this.run();
  }
  renew(): void {
    if (this.state !== 'preparing') return;
    clearTimeout(this.lease);
    this.lease = setTimeout(() => this.controller.abort(), PROGRESSIVE_LIMITS.leaseMs);
  }
  cancel(): void { this.controller.abort(); this.spool.interrupt(); }
  prioritize(page: number): void {
    if (this.state !== 'preparing' || this.resources.some(r => r.resourceId === this.spine[page - 1]) || page === this.priority) return;
    this.priority = page;
    if (this.spine.length) {
      this.window();
      if (this.spool.mode === 'range') this.spool.interrupt();
    }
  }
  private window(): void {
    this.priorityQueue = Array.from({ length: Math.min(10, this.spine.length - this.priority + 1) }, (_, i) => this.priority + i);
  }
  private publish(): void {
    this.signal.throwIfAborted(); this.check();
    this.revision++;
    this.changed();
    for (const listener of this.listeners) listener();
  }
  private fail(error: unknown): void {
    this.state = 'failed'; this.activePage = undefined; this.revision++;
    this.reason = CBZ_DOWNLOAD_ONLY_REASON;
    this.failed(this.signal.aborted ? this.signal.reason : error);
  }
  async wait(page: number | undefined, signal: AbortSignal): Promise<void> {
    const ready = () => this.state !== 'preparing' ||
      (page !== undefined && this.resources.some(r => r.resourceId === this.spine[page - 1]));
    if (ready()) return;
    await new Promise<void>((resolve, reject) => {
      const finish = () => {
        clearTimeout(timer); this.listeners.delete(update); signal.removeEventListener('abort', abort);
        resolve();
      };
      const abort = () => { finish(); reject(signal.reason); };
      const update = () => { if (ready()) finish(); };
      const timer = setTimeout(finish, PROGRESSIVE_LIMITS.pollMs);
      this.listeners.add(update);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      else update();
    });
    signal.throwIfAborted();
  }
  private async command(command: ComicCommand): Promise<ComicReply> {
    this.signal.throwIfAborted();
    const remaining = PROGRESSIVE_LIMITS.processingMs - this.processingMs;
    if (remaining <= 0 || this.workerFailed) throw new BooksError(422, 'CBZ_PROCESSING_DEADLINE');
    const start = performance.now();
    if (!this.worker) {
      this.worker = new Worker(path.join(__dirname, 'progressiveWorker.js'), {
        workerData: { source: this.source, output: this.output, size: this.spool.representation.size },
        env: {}, resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
      });
      const failed = () => {
        if (!this.ending) { this.workerFailed = true; this.spool.interrupt(); }
      };
      this.worker.on('error', failed);
      this.worker.on('exit', failed);
    }
    const worker = this.worker;
    try {
      return await new Promise<ComicReply>((resolve, reject) => {
        const clean = () => {
          clearTimeout(timer);
          worker.removeListener('message', message); worker.removeListener('error', error); worker.removeListener('exit', exit);
          this.signal.removeEventListener('abort', abort);
        };
        const error = () => { this.workerFailed = true; clean(); reject(new BooksError(422, 'CBZ_WORKER_FAILURE')); };
        const exit = () => error();
        const abort = () => { clean(); reject(this.signal.reason); };
        const message = (reply: ComicReply) => {
          clean(); this.metrics = reply.metrics;
          if (reply.error) reject(new UnsafeEpub(reply.error)); else resolve(reply);
        };
        const timer = setTimeout(() => {
          this.workerFailed = true; clean(); reject(new BooksError(422, 'CBZ_PROCESSING_DEADLINE'));
        }, remaining);
        worker.once('message', message); worker.once('error', error); worker.once('exit', exit);
        this.signal.addEventListener('abort', abort, { once: true });
        worker.postMessage(command);
      });
    } finally {
      this.workerMs += performance.now() - start;
      if (this.processingMs > PROGRESSIVE_LIMITS.processingMs) throw new BooksError(422, 'CBZ_PROCESSING_DEADLINE');
    }
  }
  private async network<T>(run: () => Promise<T>): Promise<T> {
    try { return await run(); }
    catch (error) {
      if (!(error instanceof RangeUnavailable) || this.resources.length || this.spool.mode !== 'range') throw error;
      await this.spool.fullDownload();
      return run();
    }
  }
  private async run(): Promise<void> {
    let completed = false;
    let closed = false;
    const interrupt = () => this.spool.interrupt();
    this.signal.addEventListener('abort', interrupt, { once: true });
    try {
      if (this.spool.mode === 'full-download') await this.spool.fullDownload();
      const directoryStart = await this.network(() => this.spool.directory());
      const reply = await this.command({ type: 'index', coverage: this.spool.coverage, directoryStart });
      const index: ComicIndex = reply.index!;
      this.spine = index.spine;
      if (this.priority > this.spine.length) throw new UnsafeEpub('Requested page outside archive');
      this.window(); this.publish();
      const done = new Set<number>();
      while (done.size < index.entries.length) {
        this.signal.throwIfAborted(); this.check();
        if (this.workerFailed) throw new BooksError(422, 'CBZ_WORKER_FAILURE');
        const wanted = this.priorityQueue.find(page => !done.has(index.entries.findIndex(e => e.page === page)));
        const i = wanted === undefined ? index.entries.findIndex((_e, n) => !done.has(n))
          : index.entries.findIndex(e => e.page === wanted);
        const plan = index.entries[i];
        const priority = this.priority;
        this.activePage = plan.page;
        this.publish();
        try {
          if (!plan.directory) await this.network(async () => {
            const header = await this.spool.read(plan.offset, 30);
            const local = this.spool.measure(() => {
              if (header.readUInt32LE(0) !== 0x04034b50) throw new UnsafeEpub('Invalid local ZIP record');
              const size = 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
              if (plan.offset + size + plan.compressedSize > plan.end) throw new UnsafeEpub('Overlapping local ZIP record');
              return size;
            });
            await this.spool.ensure(plan.offset, Math.min(plan.end, plan.offset + local + plan.compressedSize + 24));
          });
        } catch (error) { if (error instanceof RangeInterrupted && !this.signal.aborted) continue; throw error; }
        if (this.priority !== priority) continue;
        const value = await this.command({ type: 'entry', index: i, coverage: this.spool.coverage });
        this.signal.throwIfAborted(); this.check();
        if (value.resource) this.resources.push(value.resource);
        done.add(i); this.publish();
      }
      await this.verify();
      await this.command({ type: 'close' }); closed = true;
      completed = true;
    } catch (error) {
      this.fail(error);
    } finally {
      try {
        if (this.worker) {
          if (!closed && !this.signal.aborted && !this.workerFailed && this.processingMs < PROGRESSIVE_LIMITS.processingMs) {
            try { await this.command({ type: 'close' }); }
            catch (error) { this.failed(error); }
          }
          this.ending = true;
          await this.worker.terminate();
          this.worker.removeAllListeners();
          this.worker = undefined;
        }
        const retained = new Set(this.resources.map(r => r.resourceId));
        for (const name of await fs.readdir(this.output)) {
          if (!retained.has(name)) await fs.rm(path.join(this.output, name));
        }
        if (completed) {
          try { this.state = 'complete'; this.activePage = undefined; this.publish(); }
          catch (error) { this.fail(error); }
        }
      } catch (error) {
        this.fail(error);
        throw error;
      } finally {
        clearTimeout(this.lease); clearTimeout(this.deadline);
        this.signal.removeEventListener('abort', interrupt);
        for (const listener of this.listeners) listener();
      }
    }
  }
}
