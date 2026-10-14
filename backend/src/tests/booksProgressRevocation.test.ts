import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import express from 'express';
import Database from 'better-sqlite3';
import { DatabaseService } from '../models/database';
import { createBooksRouter } from '../books/routes';
import { createAuthRouter } from '../routes/auth';
import { BooksCatalog } from '../books/catalog';
import { BooksRelay } from '../books/relay';
import { BookStreams } from '../books/streams';
import { EpubPreparation } from '../books/epub/prepare';
import { buildEpubFixture } from '../books/proof/epubFixture';
import { buildCbzFixture } from '../books/proof/cbzFixture';
import { BookItem } from '../books/types';
import { audioEdition, ProgressWrite } from '../books/progressTypes';
import { ReaderDescriptor } from '../books/epub/manifest';
import { PlexService } from '../services/plexService';

class Membership extends PlexService {
  override async validateExactServerMembership() {
    return { serverToken: 'synthetic-server', discoveredUrl: '', owned: false };
  }
}

async function fixture(format: 'epub' | 'cbz' = 'epub') {
  const enabled = process.env.BOOKS_ENABLED;
  process.env.BOOKS_ENABLED = 'true';
  const root = path.resolve('.test-data', 'books-progress-revocation', randomUUID());
  await fs.mkdir(root, { recursive: true });
  const bytes = format === 'cbz' ? await buildCbzFixture() : await buildEpubFixture();
  let hold: { phase: 'item' | 'head'; entered(): void; released: Promise<void> } | undefined;
  const libraryId = 'selected-library';
  const provider = express();
  provider.use(async (req, _res, next) => {
    const pending = hold;
    if (pending && (pending.phase === 'item' ? req.path === '/api/items/book' : req.method === 'HEAD')) {
      hold = undefined; pending.entered(); await pending.released;
    }
    next();
  });
  provider.get('/api/items/book', (_req, res) => res.json({
    id: 'book', libraryId, mediaType: 'book',
    libraryFiles: ['pdf', format, 'mp3'].map(ext => ({
      ino: ext, fileType: ext === 'mp3' ? 'audio' : 'ebook',
      metadata: { filename: `Original.${ext}`, size: ext === format ? bytes.length : 10, mtimeMs: 1 },
    })),
    media: {
      metadata: { title: 'Private fixture' }, ebookFile: { ino: 'pdf' },
      tracks: [{ ino: 'mp3', duration: 10, startOffset: 0 }], chapters: [],
    },
  }));
  provider.get(`/api/items/book/file/${format}`, (req, res) => {
    res.set({ 'Content-Length': String(bytes.length), 'Content-Type': 'application/epub+zip', ETag: '"original"' });
    res.status(200);
    if (req.method === 'HEAD') res.end(); else res.end(bytes);
  });
  const upstream = provider.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => upstream.once('listening', resolve));
  const up = upstream.address(); assert.ok(up && typeof up !== 'string');
  const databasePath = path.join(root, 'fixture.db');
  const db = new DatabaseService(databasePath, 'synthetic-key-at-least-thirty-two-characters');
  const sql = new Database(databasePath);
  db.setSetting('plex_machine_id', 'fixture-machine');
  db.books.setConfig({
    enabled: true, providerInstanceId: '', configGeneration: 0,
    origin: `http://127.0.0.1:${up.port}`, libraryId, serverBindingProofId: 'synthetic-binding',
  }, 'synthetic-provider-credential');
  const user = db.createOrUpdatePlexUser({
    plexId: 'private-user', username: 'Fixture', email: 'fixture@invalid.test',
    plexAccountToken: 'synthetic-account', plexToken: 'synthetic-server',
  });
  const other = db.createOrUpdatePlexUser({
    plexId: 'other-user', username: 'Other', email: 'other@invalid.test',
    plexAccountToken: 'synthetic-other-account', plexToken: 'synthetic-other-server',
  });
  const sessions = [db.createSession(user.id), db.createSession(user.id), db.createSession(other.id)];
  const plex = new Membership();
  const catalog = new BooksCatalog(db.books);
  const preparation = new EpubPreparation(db, catalog, new BooksRelay(db, catalog, new BookStreams(), plex), plex);
  const app = express(); app.use(express.json());
  app.use('/api/auth', createAuthRouter(db, plex));
  app.use('/api/books', createBooksRouter(db, { plex, preparation }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const request = (url: string, method = 'GET', body?: unknown, session = 0) => fetch(`${origin}${url}`, {
    method, headers: { Authorization: `Bearer ${sessions[session].token}`, Origin: origin, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const book = await (await request('/api/books/items/book')).json() as BookItem;
  const epub = book.files.find(file => file.extension === format)!;
  const descriptor = await (await request('/api/books/items/book/reader', 'POST', {
    fileId: epub.fileId, contentVersion: epub.contentVersion,
  })).json() as ReaderDescriptor;
  assert.equal(descriptor.state, 'ready');
  return {
    db, sql, sessions, request, book, descriptor,
    hold(phase: 'item' | 'head') {
      let entered!: () => void; let release!: () => void;
      const waiting = new Promise<void>(resolve => { entered = resolve; });
      const released = new Promise<void>(resolve => { release = resolve; });
      hold = { phase, entered, released };
      return { waiting, release };
    },
    snapshot: () => ({
      progress: sql.prepare('SELECT * FROM books_progress').all(),
      history: sql.prepare('SELECT * FROM books_progress_history').all(),
    }),
    async close() {
      sql.close(); db.close();
      server.closeAllConnections(); upstream.closeAllConnections();
      await Promise.all([server, upstream].map(s => new Promise<void>(resolve => s.close(() => resolve()))));
      await fs.rm(root, { recursive: true, force: true });
      if (enabled === undefined) delete process.env.BOOKS_ENABLED; else process.env.BOOKS_ENABLED = enabled;
    },
  };
}

for (const kind of ['pdf', 'audio', 'epub', 'cbz'] as const) {
  for (const operation of ['GET', 'HEAD', 'claim', 'save'] as const) {
    for (const revocation of ['logout', 'user-revocation', 'expiry'] as const) {
      test(`held_progress_${kind}_${operation}_${revocation}_has_no_authority`, { timeout: 15000 }, async () => {
        const f = await fixture(kind === 'cbz' ? 'cbz' : 'epub');
        let release: (() => void) | undefined;
        try {
          const file = f.book.files.find(file => file.extension === kind)!;
          const edition = kind === 'audio' ? audioEdition(f.book)! : {
            editionId: file.fileId, contentVersion: kind === 'epub' || kind === 'cbz' ? f.descriptor.contentVersion : file.contentVersion,
          };
          const locator: ProgressWrite['locator'] = kind === 'pdf' ? { kind, page: 3, offset: 0.25 } :
            kind === 'cbz' ? { kind, page: 2, offset: 0.2, horizontal: 0.5, policyVersion: f.descriptor.policyVersion } :
            kind === 'audio' ? { kind, trackId: f.book.tracks[0].fileId, localSeconds: 5, globalSeconds: 5 } :
              { kind, resourceId: f.descriptor.spine[0], textOffset: 10, fraction: 0.2, policyVersion: f.descriptor.policyVersion };
          const url = `/api/books/items/book/progress/${kind === 'audio' ? 'audio' : 'ebook'}`;
          const body = {
            ...edition, op: 'claim', expectedRevision: 0, writerId: 'device-one', sequence: 1, locator,
          };
          if (operation !== 'claim') assert.equal((await f.request(url, 'PUT', body)).status, 200);
          const before = f.snapshot();
          const pending = f.hold('item');
          release = pending.release;
          const response = operation === 'GET' || operation === 'HEAD'
            ? f.request(`${url}?editionId=${edition.editionId}`, operation)
            : f.request(url, 'PUT', operation === 'claim' ? body : {
              ...body, op: 'save', expectedRevision: 1, epoch: 1, sequence: 2,
            });
          await pending.waiting;
          if (revocation === 'logout') assert.equal((await f.request('/api/auth/logout', 'POST')).status, 200);
          else if (revocation === 'user-revocation') f.db.deleteSessionsForUser(f.sessions[0].userId);
          else f.sql.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').run(Date.now() - 1, f.sessions[0].id);
          pending.release();
          const denied = await response;
          assert.equal(denied.status, 401);
          const payload = await denied.text();
          if (operation === 'HEAD') assert.equal(payload, '');
          else {
            assert.equal(JSON.parse(payload).code, 'BOOKS_SESSION_REQUIRED');
            assert.equal('progress' in JSON.parse(payload), false);
            assert.equal('canonical' in JSON.parse(payload), false);
            assert.equal('history' in JSON.parse(payload), false);
          }
          assert.deepEqual(f.snapshot(), before, 'No claim, revision or history mutation by a revoked request');
          const validSession = revocation === 'user-revocation' ? 2 : 1;
          assert.equal((await f.request(`${url}?editionId=${edition.editionId}`, 'GET', undefined, validSession)).status, 200);
        } finally { release?.(); await f.close(); }
      });
    }
  }
}

for (const kind of ['epub', 'cbz'] as const) test(`held_${kind}_locator_validation_revocation_cannot_commit`, { timeout: 15000 }, async () => {
  const f = await fixture(kind);
  const pending = f.hold('head');
  try {
    const file = f.book.files.find(file => file.extension === kind)!;
    const before = f.snapshot();
    const response = f.request('/api/books/items/book/progress/ebook', 'PUT', {
      editionId: file.fileId, contentVersion: f.descriptor.contentVersion,
      op: 'claim', writerId: 'device-one', sequence: 1, expectedRevision: 0,
      locator: kind === 'cbz' ? { kind, page: 2, offset: 0, horizontal: 0, policyVersion: f.descriptor.policyVersion } :
        { kind, resourceId: f.descriptor.spine[0], textOffset: 10, fraction: 0.2, policyVersion: f.descriptor.policyVersion },
    });
    await pending.waiting;
    f.db.deleteSession(f.sessions[0].token);
    pending.release();
    assert.equal((await response).status, 401);
    assert.deepEqual(f.snapshot(), before);
  } finally { pending.release(); await f.close(); }
});

for (const reason of ['logout', 'expiry'] as const) {
  test(`pending_progress_${reason}_cancels_without_provider_release`, { timeout: 5000 }, async () => {
    const f = await fixture();
    const pending = f.hold('item');
    try {
      if (reason === 'expiry') {
        f.sql.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').run(Date.now() + 200, f.sessions[0].id);
      }
      const pdf = f.book.files.find(file => file.extension === 'pdf')!;
      const before = f.snapshot();
      const response = f.request(`/api/books/items/book/progress/ebook?editionId=${pdf.fileId}`);
      await pending.waiting;
      if (reason === 'logout') assert.equal((await f.request('/api/auth/logout', 'POST')).status, 200);
      const denied = await response;
      assert.equal(denied.status, 401);
      assert.equal((await denied.json() as { code: string }).code, 'BOOKS_SESSION_REQUIRED');
      assert.deepEqual(f.snapshot(), before);
    } finally { pending.release(); await f.close(); }
  });
}
