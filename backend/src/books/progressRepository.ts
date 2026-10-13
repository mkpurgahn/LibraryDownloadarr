import Database from 'better-sqlite3';
import { hashToken } from '../utils/crypto';
import { invalidInput } from './limits';
import { Progress, ProgressKey, ProgressResult, ProgressWrite, progressWrite } from './progressTypes';

const KEY = 'user_id = ? AND provider_id = ? AND library_id = ? AND item_id = ? AND mode = ?';
const EDITION_KEY = `${KEY} AND edition_id = ?`;
const params = (key: Omit<ProgressKey, 'editionId'>): string[] =>
  [key.userId, key.providerInstanceId, key.libraryId, key.itemId, key.mode];
interface ProgressRow {
  progress_json: string;
  last_write_hash: string;
}

export class BooksProgressRepository {
  constructor(private readonly db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS books_progress (
        user_id TEXT NOT NULL, provider_id TEXT NOT NULL, library_id TEXT NOT NULL,
        item_id TEXT NOT NULL, mode TEXT NOT NULL, edition_id TEXT NOT NULL,
        progress_json TEXT NOT NULL, last_write_hash TEXT NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, provider_id, library_id, item_id, mode, edition_id)
      );
      CREATE TABLE IF NOT EXISTS books_progress_history (
        user_id TEXT NOT NULL, provider_id TEXT NOT NULL, library_id TEXT NOT NULL,
        item_id TEXT NOT NULL, mode TEXT NOT NULL, edition_id TEXT NOT NULL,
        content_version TEXT NOT NULL, revision INTEGER NOT NULL, progress_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, provider_id, library_id, item_id, mode, edition_id, content_version, revision)
      );
    `);
  }
  read(key: ProgressKey): Progress | undefined {
    const row = this.db.prepare(`SELECT progress_json FROM books_progress WHERE ${EDITION_KEY}`)
      .get(...params(key), key.editionId) as { progress_json: string } | undefined;
    return row ? JSON.parse(row.progress_json) as Progress : undefined;
  }
  write(key: ProgressKey, input: ProgressWrite): ProgressResult {
    const write = progressWrite(input);
    if ((key.mode === 'audio') !== (write.locator.kind === 'audio')) throw invalidInput();
    const fingerprint = hashToken(JSON.stringify(write));
    return this.db.transaction((): ProgressResult => {
      const row = this.db.prepare(`SELECT progress_json, last_write_hash FROM books_progress WHERE ${EDITION_KEY}`)
        .get(...params(key), key.editionId) as ProgressRow | undefined;
      const current = row ? JSON.parse(row.progress_json) as Progress : undefined;
      if (current && row?.last_write_hash === fingerprint) return { status: 'saved', value: current };
      if (current && current.contentVersion !== write.contentVersion && write.op !== 'claim') {
        return { status: 'incompatible', canonical: current };
      }
      if (write.expectedRevision !== (current?.revision ?? 0)) return { status: 'conflict', canonical: current };
      if (write.op === 'save' && (!current || write.writerId !== current.writerId ||
          write.epoch !== current.epoch || write.sequence <= current.sequence)) {
        return { status: 'conflict', canonical: current };
      }
      const revision = (current?.revision ?? 0) + 1;
      const epoch = write.op === 'claim' ? (current?.epoch ?? 0) + 1 : current!.epoch;
      if (!Number.isSafeInteger(revision) || !Number.isSafeInteger(epoch)) throw invalidInput();
      if (current && current.contentVersion !== write.contentVersion) {
        this.db.prepare('INSERT INTO books_progress_history VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(...params(key), key.editionId, current.contentVersion, current.revision, JSON.stringify(current), current.updatedAt);
      }
      const value: Progress = {
        key: { ...key }, contentVersion: write.contentVersion, locator: write.locator,
        revision, writerId: write.writerId, epoch, sequence: write.sequence, updatedAt: Date.now(),
        completed: write.completed ?? current?.completed ?? false,
      };
      this.db.prepare(`INSERT INTO books_progress VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, provider_id, library_id, item_id, mode, edition_id) DO UPDATE SET
          progress_json = excluded.progress_json, last_write_hash = excluded.last_write_hash, updated_at = excluded.updated_at`)
        .run(...params(key), key.editionId, JSON.stringify(value), fingerprint, value.updatedAt);
      return { status: 'saved', value };
    }).immediate();
  }
  history(key: Omit<ProgressKey, 'editionId'>): Progress[] {
    const rows = this.db.prepare(`
      SELECT progress_json, updated_at FROM books_progress WHERE ${KEY}
      UNION ALL
      SELECT progress_json, updated_at FROM books_progress_history WHERE ${KEY}
      ORDER BY updated_at DESC LIMIT 100
    `).all(...params(key), ...params(key)) as Array<{ progress_json: string }>;
    return rows.map(row => JSON.parse(row.progress_json) as Progress);
  }
}
