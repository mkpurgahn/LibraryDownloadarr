import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { decryptSecret, encryptSecret, isEncrypted, randomToken } from '../utils/crypto';
import { BookKey, BooksConfig } from './types';
import { invalidInput, notFound, opaqueSegment, providerOrigin } from './limits';

export class BooksRepository {
  private readonly listeners = new Set<() => void>();
  constructor(private readonly db: Database.Database, private readonly encryptionKey: string) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS books_config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        config_json TEXT NOT NULL,
        credential TEXT
      );
      CREATE TABLE IF NOT EXISTS books_files (
        provider_id TEXT NOT NULL, library_id TEXT NOT NULL, item_id TEXT NOT NULL,
        generation INTEGER NOT NULL, ino TEXT NOT NULL, file_id TEXT NOT NULL UNIQUE,
        PRIMARY KEY (provider_id, library_id, item_id, generation, ino)
      );
    `);
  }
  readConfig(): BooksConfig | undefined {
    const row = this.db.prepare('SELECT config_json FROM books_config WHERE id = 1').get() as
      { config_json: string } | undefined;
    return row ? JSON.parse(row.config_json) as BooksConfig : undefined;
  }
  readCredential(): string | undefined {
    const row = this.db.prepare('SELECT credential FROM books_config WHERE id = 1').get() as
      { credential: string | null } | undefined;
    return decryptSecret(row?.credential, this.encryptionKey);
  }
  setConfig(input: BooksConfig, credential?: string): void {
    const origin = providerOrigin(input.origin).origin;
    opaqueSegment(input.libraryId);
    opaqueSegment(input.serverBindingProofId);
    if (credential !== undefined && (credential.length < 8 || credential.length > 8192 ||
        /[\r\n]/.test(credential) || isEncrypted(credential))) throw invalidInput();
    const previous = this.readConfig();
    const replaced = !!previous && (previous.origin !== origin || previous.serverBindingProofId !== input.serverBindingProofId);
    const next: BooksConfig = {
      enabled: input.enabled === true,
      providerInstanceId: replaced ? randomUUID() : (previous?.providerInstanceId ?? randomUUID()),
      configGeneration: (previous?.configGeneration ?? 0) + 1,
      origin, libraryId: input.libraryId, serverBindingProofId: input.serverBindingProofId,
    };
    const stored = credential !== undefined ? encryptSecret(credential, this.encryptionKey) :
      (replaced ? null : this.db.prepare('SELECT credential FROM books_config WHERE id = 1').get() as
        { credential: string | null } | undefined)?.credential ?? null;
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO books_config VALUES (1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET config_json = excluded.config_json, credential = excluded.credential`)
        .run(JSON.stringify(next), stored);
      this.db.prepare('DELETE FROM books_files').run();
    })();
    for (const listener of this.listeners) listener();
  }
  onConfigChanged(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  private current(key: BookKey): BooksConfig {
    const config = this.readConfig();
    if (!config || !config.enabled || key.providerInstanceId !== config.providerInstanceId ||
        key.libraryId !== config.libraryId) throw notFound();
    opaqueSegment(key.itemId);
    return config;
  }
  fileId(key: BookKey, ino: string): string {
    const config = this.current(key);
    opaqueSegment(ino);
    const args = [key.providerInstanceId, key.libraryId, key.itemId, config.configGeneration, ino];
    const existing = this.db.prepare(`SELECT file_id FROM books_files
      WHERE provider_id = ? AND library_id = ? AND item_id = ? AND generation = ? AND ino = ?`)
      .get(...args) as { file_id: string } | undefined;
    if (existing) return existing.file_id;
    const id = randomToken(18);
    this.db.prepare('INSERT INTO books_files VALUES (?, ?, ?, ?, ?, ?)').run(...args, id);
    return id;
  }
  inoForFileId(key: BookKey, fileId: string): string | undefined {
    const config = this.readConfig();
    if (!config?.enabled || key.providerInstanceId !== config.providerInstanceId ||
        key.libraryId !== config.libraryId) return undefined;
    const row = this.db.prepare(`SELECT ino FROM books_files
      WHERE provider_id = ? AND library_id = ? AND item_id = ? AND generation = ? AND file_id = ?`)
      .get(key.providerInstanceId, key.libraryId, key.itemId, config.configGeneration, fileId) as
      { ino: string } | undefined;
    return row?.ino;
  }
}
