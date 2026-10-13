import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import Database from 'better-sqlite3';
import express from 'express';
import { BooksProgressRepository } from '../books/progressRepository';
import { ProgressKey, ProgressWrite, audioEdition } from '../books/progressTypes';
import { validateProgressLocator } from '../books/progressRoutes';
import { BookItem } from '../books/types';
import { DatabaseService } from '../models/database';
import { createBooksRouter } from '../books/routes';

const reports: Array<Record<string, unknown>> = [];
const key: ProgressKey = {
  userId: 'user-a', providerInstanceId: 'provider-a', libraryId: 'library-a', itemId: 'book-a',
  mode: 'audio', editionId: 'audio-edition',
};
const write = (overrides: Partial<ProgressWrite> = {}): ProgressWrite => ({
  op: 'claim', contentVersion: 'version-a', expectedRevision: 0, writerId: 'device-a', sequence: 1,
  locator: { kind: 'audio', trackId: 'track-a', localSeconds: 50, globalSeconds: 50 }, ...overrides,
});
function repository() {
  const db = new Database(':memory:');
  return { db, repo: new BooksProgressRepository(db) };
}
const item = (): BookItem => ({
  providerInstanceId: 'provider-a', libraryId: 'library-a', itemId: 'book-a', title: 'Fixture',
  authors: [], narrators: [], series: [], description: '', missing: false, invalid: false,
  read: { available: true }, listen: { available: true },
  files: [
    { fileId: 'track-a', basename: 'Z.mp3', role: 'audio', extension: 'mp3', mime: 'audio/mpeg', size: 10, available: true, contentVersion: 'audio-file-a' },
    { fileId: 'track-b', basename: 'A.mp3', role: 'audio', extension: 'mp3', mime: 'audio/mpeg', size: 10, available: true, contentVersion: 'audio-file-b' },
    { fileId: 'ebook-pdf', basename: 'Book.pdf', role: 'ebook', extension: 'pdf', mime: 'application/pdf', size: 10, available: true, contentVersion: 'pdf-version' },
    { fileId: 'ebook-epub', basename: 'Book.epub', role: 'ebook', extension: 'epub', mime: 'application/epub+zip', size: 10, available: true, contentVersion: 'epub-version' },
  ],
  tracks: [{ fileId: 'track-a', duration: 30, startOffset: 0 }, { fileId: 'track-b', duration: 45, startOffset: 30 }],
  chapters: [],
});

test('users_and_modes_are_independent', () => {
  const { db, repo } = repository();
  try {
    assert.equal(repo.write(key, write()).status, 'saved');
    assert.equal(repo.read({ ...key, userId: 'user-b' }), undefined);
    assert.equal(repo.read({ ...key, mode: 'ebook' }), undefined);
    const ebookKey: ProgressKey = { ...key, mode: 'ebook', editionId: 'pdf-file' };
    const ebook = repo.write(ebookKey, write({ locator: { kind: 'pdf', page: 3, offset: 0.25 } }));
    assert.equal(ebook.status, 'saved');
    assert.deepEqual(repo.read(key)!.locator, { kind: 'audio', trackId: 'track-a', localSeconds: 50, globalSeconds: 50 });
    assert.equal(repo.history({ ...key, userId: 'user-b' }).length, 0);
    reports.push({ test: 'users_and_modes_are_independent', otherUser: 'no-record', modes: 'separate', verdict: 'pass' });
  } finally { db.close(); }
});

test('rewind_wins_only_in_current_epoch', () => {
  const { db, repo } = repository();
  try {
    repo.write(key, write());
    repo.write(key, write({ op: 'save', expectedRevision: 1, epoch: 1, sequence: 2 }));
    const claim = repo.write(key, write({ writerId: 'device-b', expectedRevision: 2 }));
    assert.equal(claim.status, 'saved');
    if (claim.status !== 'saved') throw new Error('Expected claim');
    assert.equal(claim.value.revision, 3);
    assert.equal(claim.value.epoch, 2);
    const rewindWrite = write({
      op: 'save', writerId: 'device-b', expectedRevision: 3, epoch: 2, sequence: 2,
      locator: { kind: 'audio', trackId: 'track-a', localSeconds: 15, globalSeconds: 15 },
    });
    const rewind = repo.write(key, rewindWrite);
    assert.equal(rewind.status, 'saved');
    if (rewind.status !== 'saved') throw new Error('Expected rewind');
    assert.equal(rewind.value.revision, 4);
    assert.equal(rewind.value.locator.kind, 'audio');
    if (rewind.value.locator.kind !== 'audio') throw new Error('Expected audio locator');
    assert.equal(rewind.value.locator.globalSeconds, 15);
    for (const staleWrite of [
      write({ op: 'save', expectedRevision: 4, epoch: 1, sequence: 100 }),
      { ...rewindWrite, expectedRevision: 4, sequence: 1 },
      { ...rewindWrite, locator: { kind: 'audio' as const, trackId: 'track-a', localSeconds: 14, globalSeconds: 14 } },
    ]) {
      const stale = repo.write(key, staleWrite);
      assert.equal(stale.status, 'conflict');
      assert.equal(stale.canonical!.revision, 4);
    }
    const retry = repo.write(key, rewindWrite);
    assert.equal(retry.status, 'saved');
    if (retry.status !== 'saved') throw new Error('Expected idempotent retry');
    assert.equal(retry.value.revision, 4);
    assert.deepEqual(retry.value, rewind.value);
    reports.push({ test: 'rewind_wins_only_in_current_epoch', revision: 4, epoch: 2, acceptedRewindSeconds: 15, staleWrites: 'conflict', identicalRetryRevision: 4, verdict: 'pass' });
  } finally { db.close(); }
});

test('replacement_retains_incompatible_history', () => {
  const { db, repo } = repository();
  try {
    const ebookKey: ProgressKey = { ...key, mode: 'ebook', editionId: 'ebook-file' };
    repo.write(ebookKey, write({ locator: { kind: 'pdf', page: 3, offset: 0.25 } }));
    const stale = repo.write(ebookKey, write({
      op: 'save', contentVersion: 'replaced-pdf', expectedRevision: 1, epoch: 1, sequence: 2,
      locator: { kind: 'pdf', page: 1, offset: 0 },
    }));
    assert.equal(stale.status, 'incompatible');
    assert.equal(repo.read(ebookKey)!.contentVersion, 'version-a');
    const restarted = repo.write(ebookKey, write({
      contentVersion: 'replaced-pdf', expectedRevision: 1, locator: { kind: 'pdf', page: 1, offset: 0 },
    }));
    assert.equal(restarted.status, 'saved');
    assert.ok(repo.history(ebookKey).some(record => record.contentVersion === 'version-a' && record.locator.kind === 'pdf' && record.locator.page === 3));
    repo.write(key, write());
    const changedEdition = { ...key, editionId: 'reordered-tracks' };
    assert.equal(repo.read(changedEdition), undefined);
    assert.ok(repo.history(changedEdition).some(record => record.key.editionId === key.editionId));
    const epubKey: ProgressKey = { ...key, mode: 'ebook', editionId: 'epub-file' };
    repo.write(epubKey, write({
      contentVersion: 'epub-policy-v1', locator: { kind: 'epub', resourceId: 'section-a', textOffset: 10, fraction: 0.3, policyVersion: 'epub-scroll-v1' },
    }));
    assert.equal(repo.write(epubKey, write({
      op: 'save', expectedRevision: 1, epoch: 1, sequence: 2, contentVersion: 'epub-policy-v2',
      locator: { kind: 'epub', resourceId: 'section-a', textOffset: 10, fraction: 0.3, policyVersion: 'epub-scroll-v2' },
    })).status, 'incompatible');
    reports.push({ test: 'replacement_retains_incompatible_history', staleSave: 'incompatible', policyReplacement: 'incompatible', explicitRestart: 'saved', priorVersionRetained: true, newTrackEditionPosition: null, verdict: 'pass' });
  } finally { db.close(); }
});

test('restart_retains_writer_and_position', async () => {
  const root = path.resolve('.test-data', 'books-progress', randomUUID());
  await fs.mkdir(root, { recursive: true });
  const file = path.join(root, 'progress.db');
  let db = new Database(file);
  try {
    const repo = new BooksProgressRepository(db);
    const claim = write();
    repo.write(key, claim);
    const saved = repo.read(key);
    db.close(); db = new Database(file);
    const reopened = new BooksProgressRepository(db);
    assert.deepEqual(reopened.read(key), saved);
    const replay = reopened.write(key, claim);
    assert.equal(replay.status, 'saved');
    if (replay.status !== 'saved') throw new Error('Expected persisted idempotency');
    assert.equal(replay.value.revision, 1);
    reports.push({ test: 'restart_retains_writer_and_position', reopenedSameRecord: true, replayRevision: 1, verdict: 'pass' });
  } finally { db.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('current_manifest_bounds_locations_and_audio_edition', async () => {
  const book = item();
  const edition = audioEdition(book)!;
  assert.ok(edition.editionId && edition.contentVersion);
  const valid = write({
    contentVersion: edition.contentVersion,
    locator: { kind: 'audio', trackId: 'track-b', localSeconds: 5, globalSeconds: 35 },
  });
  assert.equal(await validateProgressLocator(book, edition.editionId, valid), true);
  for (const locator of [
    { kind: 'audio', trackId: 'foreign', localSeconds: 5, globalSeconds: 35 },
    { kind: 'audio', trackId: 'track-b', localSeconds: 46, globalSeconds: 76 },
    { kind: 'audio', trackId: 'track-b', localSeconds: 5, globalSeconds: 5 },
    { kind: 'audio', trackId: 'track-b', localSeconds: NaN, globalSeconds: 35 },
  ] as const) assert.equal(await validateProgressLocator(book, edition.editionId, { ...valid, locator }), false);
  for (const page of [0, 5001, 1.5]) assert.equal(await validateProgressLocator(book, 'ebook-pdf', write({
    contentVersion: 'pdf-version', locator: { kind: 'pdf', page, offset: 0 },
  })), false);
  assert.equal(await validateProgressLocator(book, 'ebook-pdf', write({
    contentVersion: 'pdf-version', locator: { kind: 'pdf', page: 3, offset: 0.25 },
  })), true);
  assert.equal(await validateProgressLocator(book, 'ebook-epub', write({
    contentVersion: 'epub-version', locator: { kind: 'epub', resourceId: 'guessed', textOffset: 1, fraction: 0, policyVersion: 'epub-scroll-v1' },
  })), false);
  book.title = 'Metadata correction';
  assert.deepEqual(audioEdition(book), edition);
  book.tracks = [{ fileId: 'track-b', duration: 45, startOffset: 0 }, { fileId: 'track-a', duration: 30, startOffset: 45 }];
  const reordered = audioEdition(book);
  assert.ok(reordered);
  assert.notEqual(reordered.editionId, edition.editionId);
  book.files[0].contentVersion = 'new-original';
  assert.notDeepEqual(audioEdition(book), reordered);
  reports.push({ test: 'current_manifest_bounds_locations_and_audio_edition', invalidBounds: 'rejected', epubWithoutPreparation: 'rejected', metadataCorrection: 'compatible', changedAudioFile: 'new-edition', verdict: 'pass' });
});

test('progress_routes_bind_identity_and_return_conflicts_without_abs_writes', async () => {
  const enabled = process.env.BOOKS_ENABLED;
  process.env.BOOKS_ENABLED = 'true';
  const libraryId = '163ac435-50a9-4f56-96d0-276edf9303c1';
  const methods: string[] = [];
  const provider = express();
  provider.use((req, _res, next) => { methods.push(req.method); next(); });
  provider.get('/api/items/book', (_req, res) => res.json({
    id: 'book', libraryId, mediaType: 'book', libraryFiles: [
      { ino: '1', fileType: 'ebook', metadata: { filename: 'Fixture.pdf', size: 10, mtimeMs: 1 } },
    ],
    media: { metadata: { title: 'Fixture' }, ebookFile: { ino: '1' }, tracks: [], chapters: [] },
  }));
  const upstream = provider.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => upstream.once('listening', resolve));
  const up = upstream.address(); assert.ok(up && typeof up !== 'string');
  const db = new DatabaseService(':memory:', 'fixture-key-longer-than-thirty-two-characters');
  db.books.setConfig({
    enabled: true, providerInstanceId: '', configGeneration: 0, origin: `http://127.0.0.1:${up.port}`,
    libraryId, serverBindingProofId: 'fixture-binding',
  }, 'fixture-abs-credential');
  const sessions = ['a', 'b'].map(label => db.createSession(db.createOrUpdatePlexUser({
    plexId: label, username: label, email: `${label}@fixture.invalid`, plexAccountToken: 'fixture-account', plexToken: 'fixture-server',
  }).id));
  const app = express(); app.use(express.json()); app.use('/api/books', createBooksRouter(db));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const addr = server.address(); assert.ok(addr && typeof addr !== 'string');
  const origin = `http://127.0.0.1:${addr.port}`;
  const headers = (index = 0) => ({ Authorization: `Bearer ${sessions[index].token}`, Origin: origin, 'Content-Type': 'application/json' });
  try {
    const book = await (await fetch(`${origin}/api/books/items/book`, { headers: headers() })).json() as BookItem;
    const file = book.files[0];
    const url = `${origin}/api/books/items/book/progress/ebook`;
    const body = { ...write({ contentVersion: file.contentVersion, locator: { kind: 'pdf', page: 3, offset: 0.25 } }), editionId: file.fileId };
    const claim = await fetch(url, { method: 'PUT', headers: headers(), body: JSON.stringify(body) });
    assert.equal(claim.status, 200);
    const other = await (await fetch(`${url}?editionId=${file.fileId}`, { headers: headers(1) })).json() as { progress: unknown; history: unknown[] };
    assert.equal(other.progress, null);
    assert.deepEqual(other.history, []);
    db.booksProgress.write({
      providerInstanceId: book.providerInstanceId, libraryId, itemId: book.itemId,
      userId: sessions[1].userId, mode: 'ebook', editionId: 'removed-original',
    }, write({ contentVersion: 'removed-version', locator: { kind: 'pdf', page: 2, offset: 0.5 } }));
    const replacement = await (await fetch(`${url}?editionId=${file.fileId}`, { headers: headers(1) })).json() as { progress: unknown; compatible: boolean; history: unknown[] };
    assert.equal(replacement.progress, null);
    assert.equal(replacement.compatible, false);
    assert.equal(replacement.history.length, 1);
    assert.equal((await fetch(url, { method: 'PUT', headers: headers(), body: JSON.stringify({ ...body, userId: sessions[1].userId }) })).status, 400);
    assert.equal((await fetch(url, { method: 'PUT', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).status, 401);
    const takeover = await fetch(url, { method: 'PUT', headers: headers(), body: JSON.stringify({ ...body, writerId: 'device-b', expectedRevision: 1 }) });
    assert.equal(takeover.status, 200);
    const stale = await fetch(url, { method: 'PUT', headers: headers(), body: JSON.stringify({ ...body, op: 'save', epoch: 1, expectedRevision: 2, sequence: 2 }) });
    assert.equal(stale.status, 409);
    const concurrent = await Promise.all(['device-c', 'device-d'].map(writerId =>
      fetch(url, { method: 'PUT', headers: headers(1), body: JSON.stringify({ ...body, writerId }) })));
    assert.deepEqual(concurrent.map(result => result.status).sort(), [200, 409]);
    assert.deepEqual([...new Set(methods)], ['GET']);
    reports.push({ test: 'progress_routes_bind_identity_and_return_conflicts_without_abs_writes', otherUser: 'independent', spoofedUser: 400, cookieOnly: 401, staleEpoch: 409, concurrentClaims: [200, 409], providerMethods: ['GET'], verdict: 'pass' });
  } finally {
    server.closeAllConnections(); upstream.closeAllConnections();
    await Promise.all([server, upstream].map(s => new Promise<void>(resolve => s.close(() => resolve()))));
    db.close();
    if (enabled === undefined) delete process.env.BOOKS_ENABLED; else process.env.BOOKS_ENABLED = enabled;
  }
});

after(async () => {
  const output = process.env.BOOKS_PROOF_DIR;
  if (!output) return;
  const relative = path.relative(process.cwd(), path.resolve(output));
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Proof must stay in execution root');
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, 'progress-verdict.json'), JSON.stringify({
    schemaVersion: 1, kind: 'synthetic-private-progress', runtime: process.version,
    observedAt: new Date().toISOString(), cases: reports, verdict: reports.length === 6 ? 'pass' : 'blocked',
  }, null, 2));
});
