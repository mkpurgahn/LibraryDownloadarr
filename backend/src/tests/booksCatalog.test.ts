import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import Database from 'better-sqlite3';
import express from 'express';
import { BooksRepository } from '../books/repository';
import { AbsClient } from '../books/absClient';
import { BooksCatalog } from '../books/catalog';
import { BooksConfig } from '../books/types';
import { boundedQuery, BooksError, validateCover, WindowBudget } from '../books/limits';
import { createBooksRouter } from '../books/routes';
import { createBooksSettingsRouter } from '../books/settingsRoutes';
import { DatabaseService } from '../models/database';
import { redactForLog } from '../utils/logger';
import { validateProofTarget, verifyCatalogContract } from '../books/proof/verifyAbs';

const libraryId = '163ac435-50a9-4f56-96d0-276edf9303c1';
const secret = 'fixture-only-encryption-secret-at-least-32-chars';
const token = 'synthetic-abs-token-not-a-real-credential';
const previousEnabled = process.env.BOOKS_ENABLED;
process.env.BOOKS_ENABLED = 'true';
after(() => {
  if (previousEnabled === undefined) delete process.env.BOOKS_ENABLED;
  else process.env.BOOKS_ENABLED = previousEnabled;
});
const metadata = (filename: string, size: number) => ({
  filename, ext: filename.slice(filename.lastIndexOf('.')), size,
  path: `/books/private/${filename}`, relPath: `private/${filename}`, mtimeMs: 1700000000000,
  ctimeMs: 1700000000000, birthtimeMs: 1600000000000,
});
const rawItem = (id = 'item-a', selectedLibrary = libraryId) => ({
  id, libraryId: selectedLibrary, mediaType: 'book', isMissing: false, isInvalid: false,
  libraryFiles: [
    { ino: 'ebook-ino', fileType: 'ebook', metadata: metadata('Novel.epub', 100) },
    { ino: 'supplement-ino', fileType: 'ebook', isSupplementary: true, metadata: metadata('Appendix.pdf', 200) },
    { ino: 'audio-ino', fileType: 'audio', metadata: metadata('Z first.mp3', 1000) },
    { ino: 'sidecar-ino', fileType: 'metadata', metadata: metadata('metadata.json', 50) },
  ],
  media: {
    metadata: {
      title: 'A dual book', authors: [{ id: 'author', name: 'A. Author' }],
      narrators: ['N. Narrator'], series: [{ id: 'series', name: 'Series' }],
      description: '<p>A safe description.</p><script>bad()</script>',
    },
    ebookFile: { ino: 'ebook-ino', ebookFormat: 'epub', metadata: metadata('Novel.epub', 100) },
    audioFiles: [{ ino: 'audio-ino', duration: 25, mimeType: 'audio/mpeg', metadata: metadata('Z first.mp3', 1000) }],
    tracks: [{ ino: 'audio-ino', duration: 25, startOffset: 0, metadata: metadata('Z first.mp3', 1000), contentUrl: '/api/secret' }],
    chapters: [{ id: 1, title: 'Opening', start: 0, end: 25 }],
    numAudioFiles: 1,
  },
  userMediaProgress: { currentTime: 999 },
});

async function fixture() {
  const requests: URL[] = [];
  let denied = false;
  let special: 'redirect' | 'oversized' | undefined;
  const fileRequests: Array<{ method?: string; range?: string; ifRange?: string | string[]; path: string }> = [];
  let responseItem = rawItem();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url!, 'http://fixture');
    requests.push(url);
    if (req.headers.authorization !== `Bearer ${token}` || denied) {
      res.writeHead(403); res.end('do not leak secret provider diagnostic'); return;
    }
    if (special === 'redirect') {
      res.writeHead(302, { Location: 'http://invalid.invalid/secret' }); res.end(); return;
    }
    if (special === 'oversized') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('x'.repeat(8 * 1024 * 1024 + 1)); return;
    }
    if (url.pathname.includes('/file/')) {
      fileRequests.push({ method: req.method, range: req.headers.range, ifRange: req.headers['if-range'], path: url.pathname });
      res.writeHead(200, { 'Content-Type': 'application/epub+zip', 'Content-Length': '10' });
      res.end('0123456789'); return;
    }
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname.endsWith('/search')) {
      res.end(JSON.stringify({ book: [{ libraryItem: responseItem }], authors: [{ name: 'Not a book' }] }));
    } else if (url.pathname.endsWith('/items')) {
      res.end(JSON.stringify({ results: [responseItem, rawItem('item-b')], total: 2, page: 0, limit: 50 }));
    } else if (url.pathname === '/api/libraries') {
      res.end(JSON.stringify({ libraries: [{ id: libraryId, name: 'ebooks', mediaType: 'book' }, { id: 'future', name: 'Private', mediaType: 'book' }] }));
    } else if (url.pathname === `/api/libraries/${libraryId}`) {
      res.end(JSON.stringify({ id: libraryId, name: 'ebooks', mediaType: 'book' }));
    } else {
      res.end(JSON.stringify({ ...responseItem, id: url.pathname === '/api/items/item-b' ? 'item-b' : responseItem.id }));
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const sqlite = new Database(':memory:');
  const repo = new BooksRepository(sqlite, secret);
  const config: BooksConfig = {
    enabled: true, providerInstanceId: randomUUID(), configGeneration: 1,
    origin: `http://127.0.0.1:${address.port}`, libraryId, serverBindingProofId: 'fixture-binding',
  };
  repo.setConfig(config, token);
  const client = new AbsClient(repo.readConfig()!, token, repo);
  const catalog = new BooksCatalog(repo);
  return {
    repo, sqlite, client, catalog, config: repo.readConfig()!, requests, fileRequests,
    deny: () => { denied = true; },
    respond: (mode: typeof special) => { special = mode; },
    replace: (item: ReturnType<typeof rawItem>) => { responseItem = item; },
    async close() {
      sqlite.close();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
const signal = () => new AbortController().signal;

test('only_selected_library_is_visible', async () => {
  const f = await fixture();
  try {
    const libraries = await f.catalog.libraries(signal());
    assert.deepEqual(libraries.map(x => x.libraryId), [libraryId]);
    await assert.rejects(f.catalog.list('user', 'future', boundedQuery({}), signal()), { status: 404 });
    const { item } = await f.catalog.authorizeItem('user', 'item-a', signal());
    await assert.rejects(f.catalog.resolveFile('user', 'item-a', 'unknown', undefined, signal()), { status: 404 });
    assert.equal(f.repo.inoForFileId({ ...item, itemId: 'other' }, item.files[0].fileId), undefined);
    f.replace(rawItem('item-a', 'future'));
    await assert.rejects(f.catalog.authorizeItem('user', 'item-a', signal()), { status: 404 });
  } finally { await f.close(); }
});

test('catalog_filters_and_search_are_provider_shaped', async () => {
  const f = await fixture();
  try {
    assert.equal(boundedQuery({}).limit, 50);
    assert.equal(boundedQuery({ limit: '1000' }).limit, 100);
    for (const [filter, encoded] of [['all', null], ['ebook', 'ebooks.ZWJvb2s='], ['single', 'tracks.c2luZ2xl'], ['multi', 'tracks.bXVsdGk=']] as const) {
      const result = await f.client.list(boundedQuery({ filter, sort: 'author', desc: 'true' }), signal());
      assert.equal(result.items.length, 2);
      const url = f.requests.at(-1)!;
      assert.equal(url.searchParams.get('filter'), encoded);
      assert.equal(url.searchParams.get('sort'), 'media.metadata.authorName');
      assert.equal(url.searchParams.get('minified'), '1');
      assert.equal(url.searchParams.get('desc'), '1');
      assert.ok(!url.search.includes('%253D'));
    }
    const matches = await f.client.search(libraryId, 'dual', signal());
    assert.equal(matches.length, 1);
    assert.equal(f.requests.at(-1)!.searchParams.get('limit'), '50');
    assert.equal(f.requests.at(-1)!.searchParams.has('page'), false);
    assert.ok(f.requests.every(url => !url.searchParams.has('include')));
    assert.equal(f.requests.filter(url => url.pathname.startsWith('/api/items/')).length, 0);
    assert.throws(() => boundedQuery({ url: 'http://evil.test' }), { status: 400 });
    assert.throws(() => boundedQuery({ page: '-1' }), { status: 400 });
    await assert.rejects(f.client.search(libraryId, 'a'.repeat(201), signal()), { status: 400 });
  } finally { await f.close(); }
});

test('dual_item_keeps_independent_actions', async () => {
  const f = await fixture();
  try {
    const item = await f.client.item('item-a', signal());
    assert.equal(item.read.available, true);
    assert.equal(item.listen.available, true);
    assert.deepEqual(item.files.map(file => file.basename), ['Novel.epub', 'Appendix.pdf', 'Z first.mp3']);
    assert.equal(item.tracks[0].fileId, item.files[2].fileId);
    const original = await f.catalog.resolveFile('user', item.itemId, item.files[1].fileId, item.files[1].contentVersion, signal());
    assert.equal(original.ino, 'supplement-ino');
    await assert.rejects(f.catalog.resolveFile('user', item.itemId, item.files[1].fileId, 'old-version', signal()), { status: 409 });
    const modified = rawItem();
    modified.media.metadata.title = 'Metadata correction';
    f.replace(modified);
    assert.equal((await f.client.item('item-a', signal())).files[0].contentVersion, item.files[0].contentVersion);
    modified.libraryFiles[0].metadata.mtimeMs += 1;
    f.replace(modified);
    assert.notEqual((await f.client.item('item-a', signal())).files[0].contentVersion, item.files[0].contentVersion);
  } finally { await f.close(); }
});

test('secrets_and_paths_never_leave_backend', async () => {
  const f = await fixture();
  try {
    const item = await f.client.item('item-a', signal());
    const json = JSON.stringify(item);
    for (const forbidden of ['ebook-ino', '/books', 'contentUrl', 'userMediaProgress', 'currentTime', token, '<script>']) {
      assert.equal(json.includes(forbidden), false, forbidden);
    }
    const row = JSON.stringify(f.sqlite.prepare('SELECT * FROM books_config').get());
    assert.equal(row.includes(token), false);
    assert.ok(row.includes('enc:v1:'));
    assert.equal(f.repo.readCredential(), token);
    const log = JSON.stringify(redactForLog({
      credential: token, url: 'https://example.test/api/books/downloads/private-capability',
      message: 'GET /api/books/readers/private-handle/resources/private-resource',
      position: { kind: 'audio', localSeconds: 100 },
    }));
    for (const forbidden of [token, 'private-capability', 'private-handle', 'localSeconds']) {
      assert.equal(log.includes(forbidden), false);
    }
  } finally { await f.close(); }
});

test('cached_metadata_never_grants_access', async () => {
  const f = await fixture();
  try {
    await f.catalog.authorizeItem('user', 'item-a', signal());
    f.deny();
    await assert.rejects(f.catalog.authorizeItem('user', 'item-a', signal()), (error: unknown) =>
      error instanceof BooksError && error.status === 502 && !error.message.includes('diagnostic'));
  } finally { await f.close(); }
});

test('provider_replacement_invalidates_generation', async () => {
  const f = await fixture();
  try {
    const item = await f.client.item('item-a', signal());
    const firstId = item.files[0].fileId;
    let invalidations = 0;
    f.repo.onConfigChanged(() => { invalidations += 1; });
    f.repo.setConfig({ ...f.config, origin: 'http://127.0.0.1:12345' }, token);
    const replacement = f.repo.readConfig()!;
    assert.notEqual(replacement.providerInstanceId, f.config.providerInstanceId);
    assert.equal(replacement.configGeneration, 2);
    assert.equal(f.repo.inoForFileId(item, firstId), undefined);
    assert.throws(() => f.repo.fileId(item, 'ebook-ino'), { status: 404 });
    assert.equal(invalidations, 1);
    f.repo.setConfig({ ...replacement, enabled: false });
    await assert.rejects(f.catalog.authorizeItem('user', 'item-a', signal()), { status: 503 });
  } finally { await f.close(); }
});

test('replacement_at_the_same_origin_cannot_inherit_identity_or_credential', async () => {
  const f = await fixture();
  try {
    f.repo.setConfig({ ...f.config, serverBindingProofId: 'replacement-server-binding' });
    assert.notEqual(f.repo.readConfig()!.providerInstanceId, f.config.providerInstanceId);
    assert.equal(f.repo.readCredential(), undefined);
  } finally { await f.close(); }
});

test('fixed_origin_and_bounded_response_fail_closed', async () => {
  const f = await fixture();
  try {
    for (const origin of ['file:///books', 'http://u:p@localhost', 'https://example.test/path', 'https://example.test/?token=x']) {
      assert.throws(() => new AbsClient({ ...f.config, origin }, token, f.repo), { status: 400 });
    }
    for (const id of ['../item', 'http://example.test', 'item%2fa', 'a\\b']) {
      await assert.rejects(f.client.item(id, signal()), { status: 404 });
    }
    const bad = rawItem();
    bad.mediaType = 'podcast';
    f.replace(bad);
    await assert.rejects(f.client.item('item-a', signal()), { status: 404 });
    f.respond('redirect');
    await assert.rejects(f.client.item('item-a', signal()), { status: 502 });
    f.respond('oversized');
    await assert.rejects(f.client.item('item-a', signal()), { status: 502 });
  } finally { await f.close(); }
});

test('original_request_uses_scoped_ino_and_no_provider_playback', async () => {
  const f = await fixture();
  try {
    const stream = await f.client.openFile('item-a', 'ebook-ino', {
      method: 'HEAD', attachment: true, range: 'bytes=2-', ifRange: '"original-v1"', signal: signal(),
    });
    stream.resume();
    assert.deepEqual(f.fileRequests, [{
      method: 'HEAD', range: 'bytes=2-', ifRange: '"original-v1"',
      path: '/api/items/item-a/file/ebook-ino/download',
    }]);
    await assert.rejects(f.client.openFile('item-a', '../../private', {
      method: 'GET', attachment: false, signal: signal(),
    }), { status: 404 });
  } finally { await f.close(); }
});

test('covers_reject_active_content_and_oversized_dimensions', () => {
  assert.equal(validateCover(Buffer.from('<svg onload="bad()"/>'), 'image/svg+xml'), false);
  const png = Buffer.alloc(24);
  Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').copy(png);
  png.writeUInt32BE(513, 16); png.writeUInt32BE(512, 20);
  assert.equal(validateCover(png, 'image/png'), false);
  png.writeUInt32BE(512, 16);
  assert.equal(validateCover(png, 'image/png'), true);
  assert.equal(validateCover(png, 'image/jpeg'), false);
  assert.equal(validateCover(Buffer.alloc(2 * 1024 * 1024 + 1), 'image/png'), false);
});

test('rate_admission_is_bounded_and_fair_per_user', () => {
  const budget = new WindowBudget(2, 60000);
  budget.take('user-a'); budget.take('user-a');
  assert.throws(() => budget.take('user-a'), { status: 429 });
  assert.doesNotThrow(() => budget.take('user-b'));
});

test('proof_is_read_only_isolated_and_reports_actual_catalog', async () => {
  const f = await fixture();
  try {
    assert.throws(() => validateProofTarget('https://production.invalid', false), /isolated/i);
    assert.doesNotThrow(() => validateProofTarget(f.config.origin, false));
    const attestation = {
      absVersion: '2.30.0', serverBindingProofId: 'fixture-binding', active: true, isAdmin: false,
      accessAllLibraries: false, libraryIds: [libraryId],
      permissions: { download: true, update: false, delete: false, upload: false },
    };
    const result = await verifyCatalogContract(f.repo, attestation, signal());
    assert.equal(result.verdict, 'pass');
    assert.equal(result.inventory.total, 2);
    assert.equal(result.dualItems.length, 2);
    assert.equal(result.principalRights, 'attested-by-isolated-provisioner');
    assert.equal(JSON.stringify(result).includes(token), false);
    assert.equal(JSON.stringify(result).includes('/books/private'), false);
    await assert.rejects(verifyCatalogContract(f.repo, { ...attestation, isAdmin: true }, signal()), /principal/i);
  } finally { await f.close(); }
});

test('catalog_routes_enforce_auth_allowlist_and_owner_origin', async () => {
  const f = await fixture();
  const db = new DatabaseService(':memory:', secret);
  db.books.setConfig(f.config, token);
  const user = db.createOrUpdatePlexUser({
    plexId: '1234', username: 'reader', email: 'reader@fixture.invalid',
    plexToken: 'fixture-server-token', plexAccountToken: 'fixture-account-token',
    isAdmin: false,
  });
  db.updatePlexMembership(user.id, 'fixture-server-token');
  const session = db.createSession(user.id);
  const app = express();
  app.use(express.json());
  app.use('/api/books', createBooksRouter(db));
  app.use('/api/settings/books', createBooksSettingsRouter(db));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr !== 'string');
  const origin = `http://127.0.0.1:${addr.port}`;
  const headers = { Authorization: `Bearer ${session.token}` };
  try {
    assert.equal((await fetch(`${origin}/api/books/libraries`)).status, 401);
    assert.equal((await fetch(`${origin}/api/books/libraries`, { headers })).status, 200);
    assert.equal((await fetch(`${origin}/api/books/libraries/future/items`, { headers })).status, 404);
    assert.equal((await fetch(`${origin}/api/settings/books`, { headers })).status, 403);
    db.setSetting('plex_machine_id', 'fixture-machine');
    db.setSetting('plex_owner_id', '1234');
    db.setSetting('plex_owner_validated_at', String(Date.now()));
    assert.equal((await fetch(`${origin}/api/settings/books`, { headers })).status, 200);
    const origins: Array<Record<string, string>> = [{}, { Origin: 'https://wrong.invalid' }];
    for (const input of origins) {
      assert.equal((await fetch(`${origin}/api/settings/books/verify`, { method: 'POST', headers: { ...headers, ...input } })).status, 403);
    }
    const settings = await (await fetch(`${origin}/api/settings/books`, { headers })).text();
    assert.ok(!settings.includes(token) && !settings.includes(f.config.origin));
    db.books.setConfig({ ...db.books.readConfig()!, enabled: false });
    assert.equal((await fetch(`${origin}/api/books/libraries`, { headers })).status, 503);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    db.close(); await f.close();
  }
});
