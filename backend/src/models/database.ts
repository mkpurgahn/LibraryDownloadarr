import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { logger } from '../utils/logger';
import { decryptSecret, encryptSecret, hashToken, isEncrypted, randomToken } from '../utils/crypto';

export interface User {
  id: string;
  username: string;
  email: string;
  plexToken?: string;
  plexAccountToken?: string;
  plexId?: string;
  isAdmin: boolean;
  createdAt: number;
  lastLogin?: number;
  membershipValidatedAt?: number;
}

export interface AdminUser {
  id: string;
  username: string;
  passwordHash: string;
  email: string;
  isAdmin: boolean;
  createdAt: number;
  lastLogin?: number;
}

export interface Session {
  id: string;
  userId: string;
  expiresAt: number;
  createdAt: number;
}

export type BurnJobStatus = 'queued' | 'preparing' | 'ready' | 'failed' | 'cancelled';

export interface DownloadTicket {
  id: string;
  userId: string;
  ratingKey: string;
  partKey: string;
  filePath: string;
  sourceFingerprint: string;
  artifactId?: string;
  filename: string;
  expiresAt: number;
  createdAt: number;
}

export interface BurnArtifact {
  id: string;
  cacheKey: string;
  filePath: string;
  filename: string;
  size: number;
  createdAt: number;
  expiresAt: number;
}

export interface BurnJob {
  id: string;
  userId: string;
  ratingKey: string;
  partKey: string;
  subtitleStreamId: string;
  sourcePath: string;
  sourceFingerprint: string;
  subtitleFingerprint?: string;
  cacheKey: string;
  status: BurnJobStatus;
  progress: number;
  error?: string;
  filename?: string;
  size?: number;
  artifactId?: string;
  mediaDurationMs?: number;
  subtitleJson: string;
  createdAt: number;
  updatedAt: number;
}

export class DatabaseService {
  private db: Database.Database;
  private readonly secret: string;

  constructor(dbPath: string, secret = process.env.TOKEN_ENCRYPTION_KEY || '') {
    if (secret.length < 32) {
      throw new Error('TOKEN_ENCRYPTION_KEY is required and must be at least 32 characters');
    }
    this.secret = secret;

    const dir = path.dirname(dbPath);
    fs.mkdirSync(dir, { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = DELETE');
    this.db.pragma('foreign_keys = ON');
    this.initializeTables();
    this.migrateSecretsAndSessions();
    this.retireLocalAdminAccounts();
    logger.info(`Database initialized at ${dbPath}`);
  }

  private columnExists(table: string, column: string): boolean {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return rows.some(row => row.name === column);
  }

  private initializeTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS admin_users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        is_admin INTEGER DEFAULT 1,
        created_at INTEGER NOT NULL,
        last_login INTEGER
      );
      CREATE TABLE IF NOT EXISTS plex_users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        email TEXT,
        plex_token TEXT,
        plex_account_token TEXT,
        plex_id TEXT UNIQUE,
        server_url TEXT,
        is_admin INTEGER DEFAULT 0,
        membership_validated_at INTEGER,
        created_at INTEGER NOT NULL,
        last_login INTEGER
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS download_logs (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        username TEXT,
        media_title TEXT NOT NULL,
        media_key TEXT NOT NULL,
        file_size INTEGER,
        downloaded_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS download_tickets (
        id TEXT PRIMARY KEY,
        token_hash TEXT UNIQUE NOT NULL,
        user_id TEXT NOT NULL,
        rating_key TEXT NOT NULL,
        part_key TEXT NOT NULL,
        file_path TEXT NOT NULL,
        source_fingerprint TEXT NOT NULL,
        artifact_id TEXT,
        filename TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS download_tickets_hash_idx ON download_tickets(token_hash);
      CREATE TABLE IF NOT EXISTS burn_artifacts (
        id TEXT PRIMARY KEY,
        cache_key TEXT UNIQUE NOT NULL,
        file_path TEXT NOT NULL,
        filename TEXT NOT NULL,
        size INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS burn_jobs (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        rating_key TEXT NOT NULL,
        part_key TEXT NOT NULL,
        subtitle_stream_id TEXT NOT NULL,
        source_path TEXT NOT NULL,
        source_fingerprint TEXT NOT NULL,
        subtitle_fingerprint TEXT,
        cache_key TEXT NOT NULL,
        status TEXT NOT NULL,
        progress INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        filename TEXT,
        size INTEGER,
        artifact_id TEXT,
        media_duration_ms INTEGER,
        subtitle_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS burn_jobs_user_idx ON burn_jobs(user_id, created_at);
    `);

    if (!this.columnExists('plex_users', 'plex_account_token')) {
      this.db.exec('ALTER TABLE plex_users ADD COLUMN plex_account_token TEXT');
    }
    if (!this.columnExists('plex_users', 'membership_validated_at')) {
      this.db.exec('ALTER TABLE plex_users ADD COLUMN membership_validated_at INTEGER');
    }
    if (!this.columnExists('plex_users', 'server_url')) {
      this.db.exec('ALTER TABLE plex_users ADD COLUMN server_url TEXT');
    }
    if (!this.columnExists('download_logs', 'username')) {
      this.db.exec('ALTER TABLE download_logs ADD COLUMN username TEXT');
    }
    if (!this.columnExists('download_tickets', 'source_fingerprint')) {
      this.db.exec("ALTER TABLE download_tickets ADD COLUMN source_fingerprint TEXT NOT NULL DEFAULT ''");
    }
    if (!this.columnExists('burn_jobs', 'subtitle_fingerprint')) {
      this.db.exec('ALTER TABLE burn_jobs ADD COLUMN subtitle_fingerprint TEXT');
    }
  }

  private migrateSecretsAndSessions(): void {
    const migrate = this.db.transaction(() => {
      const users = this.db.prepare(
        'SELECT id, plex_token, plex_account_token FROM plex_users WHERE plex_token IS NOT NULL OR plex_account_token IS NOT NULL'
      ).all() as Array<{ id: string; plex_token?: string; plex_account_token?: string }>;
      const updateUser = this.db.prepare(
        'UPDATE plex_users SET plex_token = ?, plex_account_token = ? WHERE id = ?'
      );
      for (const user of users) {
        const serverToken = user.plex_token
          ? (isEncrypted(user.plex_token) ? user.plex_token : encryptSecret(user.plex_token, this.secret))
          : null;
        const accountToken = user.plex_account_token
          ? (
            isEncrypted(user.plex_account_token)
              ? user.plex_account_token
              : encryptSecret(user.plex_account_token, this.secret)
          )
          : null;
        updateUser.run(serverToken, accountToken, user.id);
      }

      const owner = this.db.prepare("SELECT value FROM settings WHERE key = 'plex_token'").get() as
        | { value: string }
        | undefined;
      if (owner?.value && !isEncrypted(owner.value)) {
        this.db.prepare("UPDATE settings SET value = ?, updated_at = ? WHERE key = 'plex_token'")
          .run(encryptSecret(owner.value, this.secret), Date.now());
      }

      const sessionSql = this.db.prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='sessions'"
      ).get() as { sql?: string } | undefined;
      if (!sessionSql) {
        this.createSessionsTable();
      } else if (!this.columnExists('sessions', 'token_hash')) {
        this.db.exec('ALTER TABLE sessions RENAME TO sessions_legacy');
        this.createSessionsTable();
        const rows = this.db.prepare(
          'SELECT id, user_id, token, expires_at, created_at FROM sessions_legacy'
        ).all() as Array<{ id: string; user_id: string; token: string; expires_at: number; created_at: number }>;
        const insert = this.db.prepare(
          'INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)'
        );
        for (const row of rows) {
          insert.run(row.id, row.user_id, hashToken(row.token), row.expires_at, row.created_at);
        }
        this.db.exec('DROP TABLE sessions_legacy');
      }
    });
    migrate();
  }

  private createSessionsTable(): void {
    this.db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        token_hash TEXT UNIQUE NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_hash_idx ON sessions(token_hash);
    `);
  }

  private retireLocalAdminAccounts(): void {
    if (!this.getSetting('plex_machine_id')) {
      return;
    }
    this.removeLocalAdminAccounts();
  }

  createAdminUser(user: Omit<AdminUser, 'id' | 'createdAt'>): AdminUser {
    const id = randomToken(18);
    const createdAt = Date.now();
    this.db.prepare(`
      INSERT INTO admin_users (id, username, password_hash, email, is_admin, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, user.username, user.passwordHash, user.email, user.isAdmin ? 1 : 0, createdAt);
    return { ...user, id, createdAt };
  }

  getAdminUserByUsername(username: string): AdminUser | undefined {
    const row = this.db.prepare('SELECT * FROM admin_users WHERE username = ?').get(username);
    return row ? this.mapAdminUser(row) : undefined;
  }

  getAdminUserById(id: string): AdminUser | undefined {
    const row = this.db.prepare('SELECT * FROM admin_users WHERE id = ?').get(id);
    return row ? this.mapAdminUser(row) : undefined;
  }

  hasAdminUser(): boolean {
    const result = this.db.prepare('SELECT COUNT(*) as count FROM admin_users WHERE is_admin = 1').get() as { count: number };
    return result.count > 0;
  }

  updateAdminLastLogin(id: string): void {
    this.db.prepare('UPDATE admin_users SET last_login = ? WHERE id = ?').run(Date.now(), id);
  }

  updateAdminPassword(id: string, passwordHash: string): void {
    this.db.prepare('UPDATE admin_users SET password_hash = ? WHERE id = ?').run(passwordHash, id);
  }

  createOrUpdatePlexUser(
    plexUser: Omit<User, 'id' | 'createdAt' | 'isAdmin'> & {
      plexToken: string;
      plexAccountToken: string;
      isAdmin?: boolean;
    }
  ): User {
    const existing = this.getPlexUserByPlexId(plexUser.plexId!);
    const now = Date.now();
    const serverToken = encryptSecret(plexUser.plexToken, this.secret);
    const accountToken = encryptSecret(plexUser.plexAccountToken, this.secret);
    const isAdmin = plexUser.isAdmin === true;
    const save = this.db.transaction(() => {
      if (isAdmin) {
        this.db.prepare('UPDATE plex_users SET is_admin = 0 WHERE plex_id <> ?')
          .run(plexUser.plexId);
      }
      if (existing) {
        this.db.prepare(`
          UPDATE plex_users
          SET username = ?, email = ?, plex_token = ?, plex_account_token = ?,
              server_url = NULL, is_admin = ?, membership_validated_at = ?, last_login = ?
          WHERE plex_id = ?
        `).run(
          plexUser.username,
          plexUser.email,
          serverToken,
          accountToken,
          isAdmin ? 1 : 0,
          now,
          now,
          plexUser.plexId
        );
        return;
      }

      this.db.prepare(`
        INSERT INTO plex_users (
          id, username, email, plex_token, plex_account_token, plex_id, server_url,
          is_admin, membership_validated_at, created_at, last_login
        ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
      `).run(
        randomToken(18),
        plexUser.username,
        plexUser.email,
        serverToken,
        accountToken,
        plexUser.plexId,
        isAdmin ? 1 : 0,
        now,
        now,
        now
      );
    });
    save();
    return this.getPlexUserByPlexId(plexUser.plexId!)!;
  }

  setExclusivePlexAdminByPlexId(plexId: string): void {
    this.db.prepare(
      'UPDATE plex_users SET is_admin = CASE WHEN plex_id = ? THEN 1 ELSE 0 END'
    ).run(plexId);
  }

  clearPlexOwner(): void {
    const clear = this.db.transaction(() => {
      this.db.prepare(
        "DELETE FROM settings WHERE key IN ('plex_owner_id', 'plex_owner_username', 'plex_owner_validated_at')"
      ).run();
      this.db.prepare('UPDATE plex_users SET is_admin = 0').run();
    });
    clear();
  }

  removeLocalAdminAccounts(): void {
    const remove = this.db.transaction(() => {
      this.db.prepare(`
        UPDATE download_logs
        SET username = COALESCE(
          username,
          (SELECT au.username FROM admin_users au WHERE au.id = download_logs.user_id)
        )
        WHERE user_id IN (SELECT id FROM admin_users)
      `).run();
      const ownerPlexId = this.getSetting('plex_owner_id');
      const owner = ownerPlexId
        ? this.db.prepare(
          'SELECT id, username FROM plex_users WHERE plex_id = ?'
        ).get(ownerPlexId) as { id: string; username: string } | undefined
        : undefined;
      if (owner) {
        this.db.prepare(`
          UPDATE download_logs
          SET user_id = ?, username = ?
          WHERE user_id IN (SELECT id FROM admin_users)
        `).run(owner.id, owner.username);
        this.db.prepare(`
          UPDATE burn_jobs
          SET user_id = ?
          WHERE user_id IN (SELECT id FROM admin_users)
        `).run(owner.id);
      }
      this.db.prepare(
        'DELETE FROM download_tickets WHERE user_id IN (SELECT id FROM admin_users)'
      ).run();
      this.db.prepare(
        'DELETE FROM sessions WHERE user_id IN (SELECT id FROM admin_users)'
      ).run();
      this.db.prepare('DELETE FROM admin_users').run();
    });
    remove();
  }

  updatePlexMembership(userId: string, serverToken: string, validatedAt = Date.now()): void {
    this.db.prepare(
      'UPDATE plex_users SET plex_token = ?, membership_validated_at = ? WHERE id = ?'
    ).run(encryptSecret(serverToken, this.secret), validatedAt, userId);
  }

  clearPlexMembership(userId: string): void {
    this.db.prepare('UPDATE plex_users SET membership_validated_at = NULL WHERE id = ?').run(userId);
  }

  getPlexUserByPlexId(plexId: string): User | undefined {
    const row = this.db.prepare('SELECT * FROM plex_users WHERE plex_id = ?').get(plexId);
    return row ? this.mapPlexUser(row) : undefined;
  }

  getPlexUserById(id: string): User | undefined {
    const row = this.db.prepare('SELECT * FROM plex_users WHERE id = ?').get(id);
    return row ? this.mapPlexUser(row) : undefined;
  }

  createSession(userId: string, expiresIn = 24 * 60 * 60 * 1000): Session & { token: string } {
    const id = randomToken(18);
    const token = randomToken();
    const createdAt = Date.now();
    const expiresAt = createdAt + expiresIn;
    this.db.prepare(`
      INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, userId, hashToken(token), expiresAt, createdAt);
    return { id, userId, token, expiresAt, createdAt };
  }

  getSessionByToken(token: string): Session | undefined {
    const row = this.db.prepare(
      'SELECT id, user_id, expires_at, created_at FROM sessions WHERE token_hash = ? AND expires_at > ?'
    ).get(hashToken(token), Date.now());
    return row ? this.mapSession(row) : undefined;
  }

  deleteSession(token: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
  }

  deleteSessionsForUser(userId: string): void {
    this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  }

  cleanupExpiredSessions(): void {
    this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
    this.db.prepare('DELETE FROM download_tickets WHERE expires_at <= ?').run(Date.now());
  }

  getSetting(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    if (!row) return undefined;
    return key === 'plex_token' ? decryptSecret(row.value, this.secret) : row.value;
  }

  setSetting(key: string, value: string): void {
    const stored = key === 'plex_token' ? encryptSecret(value, this.secret) : value;
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, stored, now);
  }

  createDownloadTicket(input: Omit<DownloadTicket, 'id' | 'createdAt'>): DownloadTicket & { token: string } {
    const token = randomToken();
    const ticket: DownloadTicket = { ...input, id: randomToken(18), createdAt: Date.now() };
    this.db.prepare(`
      INSERT INTO download_tickets (
        id, token_hash, user_id, rating_key, part_key, file_path, source_fingerprint,
        artifact_id, filename, expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      ticket.id, hashToken(token), ticket.userId, ticket.ratingKey, ticket.partKey,
      ticket.filePath, ticket.sourceFingerprint, ticket.artifactId || null,
      ticket.filename, ticket.expiresAt, ticket.createdAt
    );
    return { ...ticket, token };
  }

  getDownloadTicket(token: string): DownloadTicket | undefined {
    const row = this.db.prepare(
      'SELECT * FROM download_tickets WHERE token_hash = ? AND expires_at > ?'
    ).get(hashToken(token), Date.now());
    return row ? this.mapTicket(row) : undefined;
  }

  createBurnJob(input: Omit<BurnJob, 'id' | 'status' | 'progress' | 'createdAt' | 'updatedAt'>): BurnJob {
    const now = Date.now();
    const job: BurnJob = {
      ...input,
      id: randomToken(18),
      status: 'queued',
      progress: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.db.prepare(`
      INSERT INTO burn_jobs (
        id, user_id, rating_key, part_key, subtitle_stream_id, source_path,
        source_fingerprint, subtitle_fingerprint, cache_key, status, progress,
        error, filename, size, artifact_id, media_duration_ms, subtitle_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      job.id, job.userId, job.ratingKey, job.partKey, job.subtitleStreamId,
      job.sourcePath, job.sourceFingerprint, job.subtitleFingerprint || null,
      job.cacheKey, job.status, job.progress, job.error || null, job.filename || null,
      job.size || null, job.artifactId || null, job.mediaDurationMs || null,
      job.subtitleJson, now, now
    );
    return job;
  }

  getBurnJob(id: string): BurnJob | undefined {
    const row = this.db.prepare('SELECT * FROM burn_jobs WHERE id = ?').get(id);
    return row ? this.mapBurnJob(row) : undefined;
  }

  updateBurnJob(
    id: string,
    updates: Partial<Pick<BurnJob, 'status' | 'progress' | 'error' | 'filename' | 'size' | 'artifactId'>>
  ): void {
    const current = this.getBurnJob(id);
    if (!current) return;
    const next = { ...current, ...updates };
    this.db.prepare(`
      UPDATE burn_jobs SET status = ?, progress = ?, error = ?, filename = ?,
        size = ?, artifact_id = ?, updated_at = ? WHERE id = ?
    `).run(
      next.status, next.progress, next.error || null, next.filename || null,
      next.size ?? null, next.artifactId || null, Date.now(), id
    );
  }

  listQueuedBurnJobs(): BurnJob[] {
    return (this.db.prepare(
      "SELECT * FROM burn_jobs WHERE status IN ('queued', 'preparing') ORDER BY created_at"
    ).all() as unknown[]).map(row => this.mapBurnJob(row));
  }

  resetInterruptedBurnJobs(): void {
    this.db.prepare(
      "UPDATE burn_jobs SET status = 'queued', progress = 0, error = NULL, updated_at = ? WHERE status = 'preparing'"
    ).run(Date.now());
  }

  countPreparingBurnJobsForUser(userId: string): number {
    const row = this.db.prepare(
      "SELECT COUNT(*) count FROM burn_jobs WHERE user_id = ? AND status = 'preparing'"
    ).get(userId) as { count: number };
    return row.count;
  }

  createArtifact(input: Omit<BurnArtifact, 'id' | 'createdAt'>): BurnArtifact {
    const artifact: BurnArtifact = { ...input, id: randomToken(18), createdAt: Date.now() };
    this.db.prepare(`
      INSERT INTO burn_artifacts (id, cache_key, file_path, filename, size, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(cache_key) DO UPDATE SET
        file_path = excluded.file_path, filename = excluded.filename, size = excluded.size,
        created_at = excluded.created_at, expires_at = excluded.expires_at
    `).run(
      artifact.id, artifact.cacheKey, artifact.filePath, artifact.filename,
      artifact.size, artifact.createdAt, artifact.expiresAt
    );
    return this.getArtifactByCacheKey(artifact.cacheKey)!;
  }

  getArtifactByCacheKey(cacheKey: string): BurnArtifact | undefined {
    const row = this.db.prepare(
      'SELECT * FROM burn_artifacts WHERE cache_key = ? AND expires_at > ?'
    ).get(cacheKey, Date.now());
    return row ? this.mapArtifact(row) : undefined;
  }

  getArtifact(id: string): BurnArtifact | undefined {
    const row = this.db.prepare('SELECT * FROM burn_artifacts WHERE id = ?').get(id);
    return row ? this.mapArtifact(row) : undefined;
  }

  listExpiredArtifacts(now = Date.now()): BurnArtifact[] {
    return (this.db.prepare('SELECT * FROM burn_artifacts WHERE expires_at <= ?').all(now) as unknown[])
      .map(row => this.mapArtifact(row));
  }

  listArtifactsOldestFirst(): BurnArtifact[] {
    return (this.db.prepare(
      'SELECT * FROM burn_artifacts ORDER BY created_at ASC'
    ).all() as unknown[]).map(row => this.mapArtifact(row));
  }

  listEvictableArtifactsOldestFirst(
    createdBefore: number,
    now = Date.now()
  ): BurnArtifact[] {
    return (this.db.prepare(
      `SELECT artifact.*
       FROM burn_artifacts artifact
       WHERE artifact.created_at <= ?
         AND NOT EXISTS (
           SELECT 1
           FROM download_tickets ticket
           WHERE ticket.artifact_id = artifact.id AND ticket.expires_at > ?
         )
       ORDER BY artifact.created_at ASC`
    ).all(createdBefore, now) as unknown[]).map(row => this.mapArtifact(row));
  }

  deleteArtifact(id: string): void {
    const remove = this.db.transaction(() => {
      this.db.prepare(`
        UPDATE burn_jobs
        SET artifact_id = NULL, status = 'failed',
            error = 'Prepared file expired or was removed from the cache.',
            updated_at = ?
        WHERE artifact_id = ?
      `).run(Date.now(), id);
      this.db.prepare('DELETE FROM burn_artifacts WHERE id = ?').run(id);
    });
    remove();
  }

  logDownload(userId: string, mediaTitle: string, mediaKey: string, fileSize?: number): void {
    const user = this.db.prepare(`
      SELECT username FROM admin_users WHERE id = ?
      UNION ALL
      SELECT username FROM plex_users WHERE id = ?
      LIMIT 1
    `).get(userId, userId) as { username?: string } | undefined;
    this.db.prepare(`
      INSERT INTO download_logs (
        id, user_id, username, media_title, media_key, file_size, downloaded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomToken(18),
      userId,
      user?.username || null,
      mediaTitle,
      mediaKey,
      fileSize || null,
      Date.now()
    );
  }

  getDownloadHistory(userId: string, limit = 50): unknown[] {
    return this.db.prepare(
      'SELECT * FROM download_logs WHERE user_id = ? ORDER BY downloaded_at DESC LIMIT ?'
    ).all(userId, limit);
  }

  getAllDownloadHistory(limit = 100): unknown[] {
    return this.db.prepare(`
      SELECT
        dl.id,
        dl.user_id,
        dl.media_title,
        dl.media_key,
        dl.file_size,
        dl.downloaded_at,
        COALESCE(pu.username, au.username, dl.username) AS username
      FROM download_logs dl
      LEFT JOIN admin_users au ON dl.user_id = au.id
      LEFT JOIN plex_users pu ON dl.user_id = pu.id
      ORDER BY downloaded_at DESC LIMIT ?
    `).all(limit);
  }

  getDownloadStats(userId?: string): unknown {
    if (userId) {
      return this.db.prepare(
        'SELECT COUNT(*) as count, SUM(file_size) as total_size FROM download_logs WHERE user_id = ?'
      ).get(userId);
    }
    return this.db.prepare(
      'SELECT COUNT(*) as count, SUM(file_size) as total_size FROM download_logs'
    ).get();
  }

  private mapAdminUser(row: any): AdminUser {
    return {
      id: row.id, username: row.username, passwordHash: row.password_hash,
      email: row.email, isAdmin: row.is_admin === 1, createdAt: row.created_at,
      lastLogin: row.last_login,
    };
  }

  private mapPlexUser(row: any): User {
    return {
      id: row.id, username: row.username, email: row.email,
      plexToken: decryptSecret(row.plex_token, this.secret),
      plexAccountToken: decryptSecret(row.plex_account_token, this.secret),
      plexId: row.plex_id, isAdmin: row.is_admin === 1, createdAt: row.created_at,
      lastLogin: row.last_login, membershipValidatedAt: row.membership_validated_at,
    };
  }

  private mapSession(row: any): Session {
    return {
      id: row.id, userId: row.user_id, expiresAt: row.expires_at, createdAt: row.created_at,
    };
  }

  private mapTicket(row: any): DownloadTicket {
    return {
      id: row.id, userId: row.user_id, ratingKey: row.rating_key,
      partKey: row.part_key, filePath: row.file_path,
      sourceFingerprint: row.source_fingerprint || '',
      artifactId: row.artifact_id || undefined,
      filename: row.filename, expiresAt: row.expires_at, createdAt: row.created_at,
    };
  }

  private mapArtifact(row: any): BurnArtifact {
    return {
      id: row.id, cacheKey: row.cache_key, filePath: row.file_path,
      filename: row.filename, size: row.size, createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
  }

  private mapBurnJob(row: any): BurnJob {
    return {
      id: row.id, userId: row.user_id, ratingKey: row.rating_key,
      partKey: row.part_key, subtitleStreamId: row.subtitle_stream_id,
      sourcePath: row.source_path, sourceFingerprint: row.source_fingerprint,
      subtitleFingerprint: row.subtitle_fingerprint || undefined,
      cacheKey: row.cache_key, status: row.status, progress: row.progress,
      error: row.error || undefined, filename: row.filename || undefined,
      size: row.size ?? undefined, artifactId: row.artifact_id || undefined,
      mediaDurationMs: row.media_duration_ms ?? undefined, subtitleJson: row.subtitle_json,
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  close(): void {
    this.db.close();
  }
}
