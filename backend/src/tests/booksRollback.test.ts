import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../models/database';

test('baseline_database_reopens_additive_books_state_without_rewinding_plex', {
  skip: !process.env.BOOKS_BASELINE_DATABASE_MODULE && 'Requires the pinned deployed runtime fixture module',
}, async () => {
  const modulePath = process.env.BOOKS_BASELINE_DATABASE_MODULE!;
  assert.ok(path.isAbsolute(modulePath));
  const imported: unknown = require(modulePath);
  assert.ok(imported && typeof imported === 'object' && 'DatabaseService' in imported && typeof imported.DatabaseService === 'function');
  type LegacyDatabase = Pick<DatabaseService, 'getSetting' | 'setSetting' | 'getSessionByToken' | 'getPlexUserById' | 'close'>;
  const Legacy = imported.DatabaseService as new (file: string, key: string) => LegacyDatabase;
  const root = path.resolve('.test-data', 'books-rollback', randomUUID());
  await fs.mkdir(root, { recursive: true });
  const file = path.join(root, 'fixture.db');
  const secret = 'owned-rollback-fixture-encryption-key-more-than-32';
  let current: DatabaseService | undefined;
  let legacy: LegacyDatabase | undefined;
  try {
    current = new DatabaseService(file, secret);
    const user = current.createOrUpdatePlexUser({ plexId: 'rollback-user', username: 'Newer Plex user',
      email: 'fixture@invalid.test', plexToken: 'synthetic-server', plexAccountToken: 'synthetic-account' });
    const session = current.createSession(user.id);
    current.setSetting('plex_server_name', 'Newer Plex state');
    current.books.setConfig({
      enabled: false, providerInstanceId: '', configGeneration: 0,
      origin: 'http://127.0.0.1:1', libraryId: 'fixture-library', serverBindingProofId: 'rollback-fixture',
    });
    const key = { userId: user.id, providerInstanceId: current.books.readConfig()!.providerInstanceId,
      libraryId: 'fixture-library', itemId: 'fixture-item', mode: 'ebook' as const, editionId: 'fixture-file' };
    current.booksProgress.write(key, { op: 'claim', contentVersion: 'fixture-version', expectedRevision: 0,
      writerId: 'fixture-writer', sequence: 1, locator: { kind: 'pdf', page: 3, offset: 0.25 } });
    current.close(); current = undefined;
    legacy = new Legacy(file, secret);
    assert.equal(legacy.getSetting('plex_server_name'), 'Newer Plex state');
    assert.equal(legacy.getSessionByToken(session.token)?.userId, user.id);
    assert.equal(legacy.getPlexUserById(user.id)?.username, 'Newer Plex user');
    legacy.setSetting('plex_server_name', 'Updated while rolled back');
    legacy.close(); legacy = undefined;
    current = new DatabaseService(file, secret);
    assert.equal(current.getSetting('plex_server_name'), 'Updated while rolled back');
    assert.deepEqual(current.booksProgress.read(key)?.locator, { kind: 'pdf', page: 3, offset: 0.25 });
    assert.equal(current.getSessionByToken(session.token)?.userId, user.id);
  } finally {
    legacy?.close(); current?.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
