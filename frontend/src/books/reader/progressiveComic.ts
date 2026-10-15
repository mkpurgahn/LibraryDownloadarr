import { BooksApiError, booksApi, aborted } from '../api';
import { BookTarget, ComicDescriptor, ComicResource, ProgressiveComicDescriptor } from '../types';

export class ProgressiveComicSource {
  private readonly controller = new AbortController();
  private poll?: AbortController;
  private running?: Promise<void>;
  private renewing = false;
  private wanted: number;
  private error?: unknown;
  private readonly listeners = new Set<() => void>();
  private readonly abort = () => this.dispose();
  constructor(
    private current: ProgressiveComicDescriptor, private readonly target: BookTarget,
    page: number, private readonly signal: AbortSignal
  ) {
    this.wanted = page;
    signal.addEventListener('abort', this.abort, { once: true });
    if (signal.aborted) this.dispose(); else this.startLoop();
  }
  get snapshot(): ProgressiveComicDescriptor { return this.current; }
  get readerId(): string { return this.current.readerId; }
  get failure(): string | undefined { return this.error instanceof Error ? this.error.message : undefined; }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  private emit(): void { for (const listener of this.listeners) listener(); }
  private resource(page: number): ComicResource | undefined {
    return this.current.resources.find(r => r.resourceId === this.current.spine[page - 1]);
  }
  private accept(next: ProgressiveComicDescriptor): void {
    if (next.readerId !== this.current.readerId || next.contentVersion !== this.current.contentVersion ||
        next.revision < this.current.revision ||
        (this.current.spine.length && JSON.stringify(next.spine) !== JSON.stringify(this.current.spine)) ||
        this.current.resources.some(old => !next.resources.some(r => JSON.stringify(r) === JSON.stringify(old)))) {
      throw new Error('The CBZ reader changed. Open it again to choose a position.');
    }
    this.current = next; this.emit();
  }
  private startLoop(): void {
    if (this.running || this.renewing || this.controller.signal.aborted || this.current.state !== 'preparing') return;
    this.running = this.loop().catch(error => { this.error = error; this.emit(); })
      .finally(() => { this.running = undefined; });
  }
  private async loop(): Promise<void> {
    while (!this.controller.signal.aborted && !this.renewing && this.current.state === 'preparing') {
      this.poll = new AbortController();
      const cancel = () => this.poll?.abort();
      this.controller.signal.addEventListener('abort', cancel, { once: true });
      try {
        const page = this.resource(this.wanted) ? undefined : this.wanted;
        this.accept(await booksApi.readerStatus(this.readerId, page, this.poll.signal));
      } catch (error) {
        if (this.controller.signal.aborted) throw error;
        if (aborted(error)) continue;
        if (!(error instanceof BooksApiError) || error.status !== 429) throw error;
        await new Promise<void>((resolve, reject) => {
          const finish = () => { this.controller.signal.removeEventListener('abort', abort); resolve(); };
          const timer = window.setTimeout(finish, error.retryAfterMs ?? 2000);
          const abort = () => { window.clearTimeout(timer); this.controller.signal.removeEventListener('abort', abort); reject(this.controller.signal.reason); };
          this.controller.signal.addEventListener('abort', abort, { once: true });
        });
      } finally {
        this.controller.signal.removeEventListener('abort', cancel);
        this.poll = undefined;
      }
    }
  }
  private wait<T>(read: () => T | undefined, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const finish = (value?: T, error?: unknown) => {
        this.listeners.delete(update);
        signal.removeEventListener('abort', abort);
        this.controller.signal.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(value!);
      };
      const abort = () => finish(undefined, new DOMException('Reader cancelled', 'AbortError'));
      const update = () => {
        if (signal.aborted || this.controller.signal.aborted) { abort(); return; }
        const value = read();
        if (value !== undefined) finish(value);
        else if (this.error) finish(undefined, this.error);
        else if (this.current.state !== 'preparing') finish(undefined,
          new Error(this.current.reason ?? 'This page was not prepared. Download the original.'));
      };
      this.listeners.add(update);
      signal.addEventListener('abort', abort, { once: true });
      this.controller.signal.addEventListener('abort', abort, { once: true });
      update();
    });
  }
  async descriptor(signal: AbortSignal): Promise<ComicDescriptor> {
    await this.wait(() => this.current.spine.length ? true : undefined, signal);
    return { readerId: this.readerId, policyVersion: 'cbz-pages-v1', contentVersion: this.current.contentVersion,
      state: 'preparing', spine: [...this.current.spine], resources: [], toc: [] };
  }
  async page(page: number, signal: AbortSignal): Promise<ComicResource> {
    if (!Number.isSafeInteger(page) || page < 1 || page > this.current.spine.length) throw new Error('Page outside this book.');
    if (page !== this.wanted && !this.resource(page)) {
      this.wanted = page;
      this.poll?.abort();
    }
    return this.wait(() => this.resource(page), signal);
  }
  async renew(page: number, signal: AbortSignal): Promise<void> {
    this.renewing = true;
    this.poll?.abort();
    await this.running;
    const previous = this.current;
    let next: ProgressiveComicDescriptor | undefined;
    try {
      next = await booksApi.prepareProgressive(this.target, page, signal);
      while (!next.spine.length && next.state === 'preparing') next = await booksApi.readerStatus(next.readerId, page, signal);
      if (next.contentVersion !== previous.contentVersion || JSON.stringify(next.spine) !== JSON.stringify(previous.spine)) {
        throw new Error('The CBZ or reader policy changed. Open it again to choose a position.');
      }
      signal.throwIfAborted(); this.controller.signal.throwIfAborted();
      this.current = next; this.wanted = page; this.error = undefined; next = undefined;
      this.emit();
      await booksApi.releaseReader(previous.readerId).catch(error => {
        if (!(error instanceof BooksApiError) || ![404, 410].includes(error.status)) throw error;
      });
    } finally {
      if (next) await booksApi.releaseReader(next.readerId);
      this.renewing = false; this.startLoop();
    }
  }
  dispose(): void {
    this.signal.removeEventListener('abort', this.abort);
    this.controller.abort(); this.poll?.abort();
    this.emit();
  }
  async release(): Promise<void> { this.dispose(); await booksApi.releaseReader(this.readerId); }
}
