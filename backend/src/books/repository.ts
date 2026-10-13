import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { decryptSecret, encryptSecret, hashToken, isEncrypted, randomToken } from '../utils/crypto';
import { BookFile, BookKey, BooksConfig } from './types';
import { invalidInput, notFound, opaqueSegment, providerOrigin } from './limits';
import type { BooksPrincipal } from './mediaAuth';

export interface BookRepresentation {
  size: number;
  etag?: string;
  lastModified?: string;
  ranges: boolean;
}
export interface BookTicketRecord extends BooksPrincipal {
  itemId: string;
  fileId: string;
  contentVersion: string;
  configGeneration: number;
}

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
      CREATE TABLE IF NOT EXISTS books_media_sessions (
        token_hash TEXT PRIMARY KEY, session_id TEXT NOT NULL, user_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL, generation INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS books_media_session_idx ON books_media_sessions(session_id);
      CREATE TABLE IF NOT EXISTS books_tickets (
        token_hash TEXT PRIMARY KEY, session_id TEXT NOT NULL, user_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL, generation INTEGER NOT NULL, ticket_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS books_ticket_session_idx ON books_tickets(session_id);
      CREATE TABLE IF NOT EXISTS books_representations (
        file_id TEXT PRIMARY KEY, manifest_version TEXT NOT NULL, version TEXT NOT NULL,
        representation_json TEXT NOT NULL
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
      this.db.prepare('DELETE FROM books_media_sessions').run();
      this.db.prepare('DELETE FROM books_tickets').run();
      this.db.prepare('DELETE FROM books_representations').run();
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
  createMediaSession(principal: BooksPrincipal): string {
    const generation = this.readConfig()?.configGeneration;
    if (!generation) throw notFound();
    const token = randomToken();
    this.cleanupExpired();
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM books_media_sessions WHERE session_id = ?').run(principal.sessionId);
      this.db.prepare('INSERT INTO books_media_sessions VALUES (?, ?, ?, ?, ?)')
        .run(hashToken(token), principal.sessionId, principal.userId, principal.expiresAt, generation);
    })();
    return token;
  }
  getMediaSession(token: string): BooksPrincipal | undefined {
    const row = this.db.prepare(`SELECT session_id, user_id, expires_at FROM books_media_sessions
      WHERE token_hash = ? AND expires_at > ? AND generation = ?`)
      .get(hashToken(token), Date.now(), this.readConfig()?.configGeneration ?? -1) as
      { session_id: string; user_id: string; expires_at: number } | undefined;
    return row ? { sessionId: row.session_id, userId: row.user_id, expiresAt: row.expires_at } : undefined;
  }
  createBookTicket(record: BookTicketRecord): string {
    const token = randomToken();
    this.cleanupExpired();
    this.db.prepare('INSERT INTO books_tickets VALUES (?, ?, ?, ?, ?, ?)')
      .run(hashToken(token), record.sessionId, record.userId, record.expiresAt, record.configGeneration, JSON.stringify(record));
    return token;
  }
  getBookTicket(token: string): BookTicketRecord | undefined {
    const row = this.db.prepare(`SELECT ticket_json FROM books_tickets
      WHERE token_hash = ? AND expires_at > ? AND generation = ?`)
      .get(hashToken(token), Date.now(), this.readConfig()?.configGeneration ?? -1) as { ticket_json: string } | undefined;
    return row ? JSON.parse(row.ticket_json) as BookTicketRecord : undefined;
  }
  revokeBooksSession(sessionId: string): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM books_media_sessions WHERE session_id = ?').run(sessionId);
      this.db.prepare('DELETE FROM books_tickets WHERE session_id = ?').run(sessionId);
    })();
  }
  cleanupExpired(): void {
    this.db.prepare('DELETE FROM books_media_sessions WHERE expires_at <= ?').run(Date.now());
    this.db.prepare('DELETE FROM books_tickets WHERE expires_at <= ?').run(Date.now());
  }
  fileVersion(fileId: string, manifestVersion: string): string {
    const row = this.db.prepare('SELECT version FROM books_representations WHERE file_id = ? AND manifest_version = ?')
      .get(fileId, manifestVersion) as { version: string } | undefined;
    return row?.version ?? manifestVersion;
  }
  observeRepresentation(file: BookFile, value: BookRepresentation): boolean {
    const row = this.db.prepare('SELECT manifest_version, version, representation_json FROM books_representations WHERE file_id = ?')
      .get(file.fileId) as { manifest_version: string; version: string; representation_json: string } | undefined;
    const previous = row && row.version === file.contentVersion ? JSON.parse(row.representation_json) as BookRepresentation : undefined;
    const changed = previous !== undefined && (
      previous.size !== value.size || previous.etag !== value.etag || previous.lastModified !== value.lastModified
    );
    const manifestVersion = previous && row ? row.manifest_version : file.contentVersion;
    const version = changed ? hashToken(JSON.stringify([manifestVersion, value.size, value.etag, value.lastModified])) : file.contentVersion;
    this.db.prepare(`INSERT INTO books_representations VALUES (?, ?, ?, ?)
      ON CONFLICT(file_id) DO UPDATE SET manifest_version = excluded.manifest_version,
        version = excluded.version, representation_json = excluded.representation_json`)
      .run(file.fileId, manifestVersion, version, JSON.stringify(value));
    return !changed;
  }
}
