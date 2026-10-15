import { BooksApiError, booksApi, aborted, BOOKS_CHANGED_EVENT } from './api';
import { AudioLocator, BookKey, EbookLocator, Progress, ProgressWrite, flag, record, parseProgress } from './types';
import { SESSION_CHANGED_EVENT, useAuthStore } from '../stores/authStore';

export type SaveState = 'saved' | 'unsaved' | 'conflict';
export class ProgressClient {
  private readonly writerId = crypto.randomUUID();
  private readonly controller = new AbortController();
  private readonly userId = useAuthStore.getState().user?.id;
  private readonly sessionRevision = useAuthStore.getState().sessionRevision;
  private readonly changed = () => this.dispose();
  private queue: Promise<unknown> = Promise.resolve();
  private pending?: ProgressWrite;
  private canonical?: Progress;
  private listeners = new Set<(state: SaveState) => void>();
  private state: SaveState = 'unsaved';
  private localRevision = 0;
  private localLocation?: EbookLocator | AudioLocator;
  compatible = true;
  get location(): EbookLocator | AudioLocator | undefined { return this.localLocation; }
  set location(locator: EbookLocator | AudioLocator | undefined) {
    this.localLocation = locator; this.localRevision++;
  }
  constructor(
    private readonly key: BookKey, private readonly mode: 'ebook' | 'audio',
    private readonly editionId: string, private readonly contentVersion: string
  ) {
    window.addEventListener(SESSION_CHANGED_EVENT, this.changed);
    window.addEventListener(BOOKS_CHANGED_EVENT, this.changed);
  }
  get revision(): number { return this.canonical?.revision ?? 0; }
  get current(): Progress | undefined { return this.canonical; }
  subscribe(listener: (state: SaveState) => void): () => void {
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  }
  private notify(state: SaveState): void { this.state = state; for (const listener of this.listeners) listener(state); }
  private accept(value: unknown): Progress {
    const progress = parseProgress(value);
    if (progress.key.userId !== this.userId || progress.key.providerInstanceId !== this.key.providerInstanceId ||
        progress.key.libraryId !== this.key.libraryId || progress.key.itemId !== this.key.itemId ||
        progress.key.mode !== this.mode || progress.key.editionId !== this.editionId) throw new Error('Saved position does not match this book.');
    return progress;
  }
  private assertSession(): void {
    const state = useAuthStore.getState();
    if (this.controller.signal.aborted || state.user?.id !== this.userId || state.sessionRevision !== this.sessionRevision) {
      this.dispose(); throw new DOMException('Session changed', 'AbortError');
    }
  }
  async load(): Promise<Progress | undefined> {
    this.assertSession();
    const value = record(await booksApi.loadProgress(this.key.itemId, this.mode, this.editionId, this.controller.signal));
    this.canonical = value.progress ? this.accept(value.progress) : undefined;
    this.compatible = flag(value.compatible) && (!this.canonical || this.canonical.contentVersion === this.contentVersion);
    return this.canonical;
  }
  private serialize<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run); this.queue = next.catch(() => {}); return next;
  }
  async claim(locator: EbookLocator | AudioLocator, canonicalRevision: number): Promise<Progress> {
    const renderedRevision = locator.kind === 'cbz' ? this.localRevision : undefined;
    return this.serialize(async () => {
      this.assertSession();
      this.pending = undefined;
      const write: ProgressWrite = {
        op: 'claim', contentVersion: this.contentVersion, expectedRevision: canonicalRevision,
        writerId: this.writerId, sequence: 1, locator,
      };
      try {
        const response = record(await booksApi.saveProgress(this.key.itemId, this.mode, this.editionId, write, this.controller.signal));
        this.canonical = this.accept(response.progress); this.compatible = true;
        // CBZ claims follow rendering; other readers/players apply their chosen position after the claim.
        if (renderedRevision === undefined || this.localRevision === renderedRevision) this.localLocation = locator;
        this.notify('saved'); return this.canonical;
      } catch (error) { this.failed(error); throw error; }
    });
  }
  private failed(error: unknown): SaveState {
    if (error instanceof BooksApiError && error.status === 409) {
      if (error.canonical) this.canonical = this.accept(error.canonical);
      this.pending = undefined;
      if (error.code === 'BOOK_VERSION_CHANGED') this.compatible = false;
      this.notify('conflict'); return 'conflict';
    }
    if (!aborted(error)) this.notify('unsaved');
    return 'unsaved';
  }
  async save(locator: EbookLocator | AudioLocator): Promise<SaveState> {
    this.location = locator;
    return this.serialize(async () => {
      try { this.assertSession(); } catch { return 'unsaved'; }
      if (this.state === 'conflict') return 'conflict';
      if (!this.canonical || this.canonical.writerId !== this.writerId || this.controller.signal.aborted) return 'unsaved';
      try {
        if (this.pending) {
          const response = record(await booksApi.saveProgress(this.key.itemId, this.mode, this.editionId, this.pending, this.controller.signal));
          this.canonical = this.accept(response.progress); this.pending = undefined;
        }
        this.pending = {
          op: 'save', contentVersion: this.contentVersion, expectedRevision: this.canonical.revision,
          writerId: this.writerId, epoch: this.canonical.epoch, sequence: this.canonical.sequence + 1, locator,
        };
        const response = record(await booksApi.saveProgress(this.key.itemId, this.mode, this.editionId, this.pending, this.controller.signal));
        this.canonical = this.accept(response.progress); this.pending = undefined;
        this.notify('saved'); return 'saved';
      } catch (error) { return this.failed(error); }
    });
  }
  dispose(): void {
    window.removeEventListener(SESSION_CHANGED_EVENT, this.changed);
    window.removeEventListener(BOOKS_CHANGED_EVENT, this.changed);
    this.controller.abort(); this.listeners.clear(); this.pending = undefined; this.location = undefined; this.canonical = undefined;
  }
}
