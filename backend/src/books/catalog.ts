import { AbsClient } from './absClient';
import { BooksRepository } from './repository';
import { BOOKS_LIMITS, BooksError, ByteCache, notFound, opaqueSegment } from './limits';
import { BooksConfig, CatalogQuery } from './types';

export class BooksCatalog {
  private readonly covers = new ByteCache<{ body: Buffer; mime: string }>(BOOKS_LIMITS.coverCacheBytes, BOOKS_LIMITS.coverTtlMs);
  constructor(private readonly repository: BooksRepository) {
    repository.onConfigChanged(() => this.covers.clear());
  }
  current(): { config: BooksConfig; client: AbsClient } {
    const config = this.repository.readConfig();
    const credential = this.repository.readCredential();
    if (process.env.BOOKS_ENABLED !== 'true' || !config?.enabled) throw new BooksError(503, 'BOOKS_DISABLED', 'Books is not enabled');
    if (!credential) throw new BooksError(503, 'BOOKS_NOT_CONFIGURED', 'Books connection is not configured');
    return { config, client: new AbsClient(config, credential, this.repository) };
  }
  private unchanged(generation: number): void {
    if (this.repository.readConfig()?.configGeneration !== generation) throw new BooksError(409, 'BOOKS_CONFIGURATION_CHANGED');
  }
  async libraries(signal: AbortSignal) {
    const { config, client } = this.current();
    const library = await client.library(signal);
    this.unchanged(config.configGeneration);
    return [{ ...library, providerInstanceId: config.providerInstanceId }];
  }
  async list(userId: string, libraryId: string, query: CatalogQuery, signal: AbortSignal) {
    const { config, client } = this.current();
    if (!userId || libraryId !== config.libraryId) throw notFound();
    const result = await client.list(query, signal);
    this.unchanged(config.configGeneration);
    return result;
  }
  async search(userId: string, libraryId: string, q: string, signal: AbortSignal) {
    const { config, client } = this.current();
    if (!userId || libraryId !== config.libraryId) throw notFound();
    const items = await client.search(libraryId, q, signal);
    this.unchanged(config.configGeneration);
    return items;
  }
  async authorizeItem(userId: string, itemId: string, signal: AbortSignal) {
    if (!userId) throw notFound();
    const { config, client } = this.current();
    const item = await client.item(opaqueSegment(itemId), signal);
    this.unchanged(config.configGeneration);
    return { item, configGeneration: config.configGeneration };
  }
  async resolveFile(userId: string, itemId: string, fileId: string, version: string | undefined, signal: AbortSignal) {
    const { item, configGeneration } = await this.authorizeItem(userId, itemId, signal);
    const file = item.files.find(file => file.fileId === fileId);
    const ino = this.repository.inoForFileId(item, fileId);
    if (!file?.available || !ino) throw notFound();
    if (version !== undefined && file.contentVersion !== version) throw new BooksError(409, 'BOOK_VERSION_CHANGED');
    return { item, file, ino, configGeneration };
  }
  async cover(userId: string, itemId: string, signal: AbortSignal) {
    const { item, configGeneration } = await this.authorizeItem(userId, itemId, signal);
    const key = `${item.providerInstanceId}:${configGeneration}:${itemId}`;
    const cached = this.covers.get(key);
    if (cached) return cached;
    const value = await this.current().client.cover(itemId, signal);
    this.unchanged(configGeneration);
    this.covers.put(key, value, value.body.length);
    return value;
  }
}
