import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import test, { TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import express from 'express';
import Database from 'better-sqlite3';
import { DatabaseService } from '../models/database';
import { createBooksRouter } from '../books/routes';
import { BOOKS_COOKIE } from '../books/mediaAuth';
import { PlexService } from '../services/plexService';

class Membership extends PlexService {
  override async validateExactServerMembership() {
    return { serverToken: 'generated-server', discoveredUrl: '', owned: false };
  }
}

async function fixture(t: TestContext) {
  const enabled = process.env.BOOKS_ENABLED;
  process.env.BOOKS_ENABLED = 'true';
  const root = path.resolve('.test-data', 'catalog-lifecycle', randomUUID());
  await fs.mkdir(root, { recursive: true });
  let enter!: () => void;
  let abort!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const aborted = new Promise<void>(resolve => { abort = resolve; });
  const pending: Array<() => void> = [];
  let holding = true;
  let requests = 0;
  const provider = http.createServer((req, res) => {
    requests++;
    res.on('close', () => { if (!res.writableFinished) abort(); });
    const respond = () => {
      if (res.destroyed) return;
      const url = new URL(req.url!, 'http://fixture');
      const filter = url.searchParams.get('filter');
      const raw = { id: 'generated-book', libraryId: 'selected', mediaType: 'book',
        media: { metadata: { title: 'Generated title' }, ebookFormat: 'epub',
          numAudioFiles: filter === 'tracks.bXVsdGk=' ? 2 : 1 } };
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(url.pathname.endsWith('/search') ? { book: [{ libraryItem: raw }] } :
        url.pathname === '/api/libraries' ? { libraries: [{ id: 'selected', mediaType: 'book' }] } :
          url.pathname === '/api/libraries/selected' ? { id: 'selected', mediaType: 'book', name: 'Generated' } :
            { results: filter === 'tracks.bXVsdGk=' ? [] : [raw], total: filter === 'tracks.bXVsdGk=' ? 0 : 1 }));
    };
    if (holding) { pending.push(respond); enter(); } else respond();
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const upstream = provider.address(); assert.ok(upstream && typeof upstream !== 'string');
  const databasePath = path.join(root, 'fixture.db');
  const db = new DatabaseService(databasePath, 'generated-fixture-key-at-least-thirty-two-characters');
  const sql = new Database(databasePath);
  db.setSetting('plex_machine_id', 'generated-machine');
  db.books.setConfig({ enabled: true, providerInstanceId: '', configGeneration: 0,
    origin: `http://127.0.0.1:${upstream.port}`, libraryId: 'selected', serverBindingProofId: 'generated-binding',
  }, 'generated-credential');
  const user = db.createOrUpdatePlexUser({ plexId: 'generated-user', username: 'Generated',
    email: 'generated@invalid.test', plexAccountToken: 'generated-account', plexToken: 'generated-server' });
  const session = db.createSession(user.id);
  const app = express();
  app.use(express.json());
  app.use('/api/books', createBooksRouter(db, { plex: new Membership() }));
  let sessionListeners = 0;
  let configListeners = 0;
  const expiryTimers = new Set<NodeJS.Timeout>();
  const realSetTimeout = global.setTimeout;
  const realClearTimeout = global.clearTimeout;
  const timerSpy = t.mock.method(global, 'setTimeout', (...args: Parameters<typeof setTimeout>) => {
    const timer = realSetTimeout(...args);
    if (args[1] && args[1] > 60000) expiryTimers.add(timer);
    return timer;
  });
  const clearSpy = t.mock.method(global, 'clearTimeout', (...args: Parameters<typeof clearTimeout>) => {
    if (typeof args[0] === 'object') expiryTimers.delete(args[0]);
    return realClearTimeout(...args);
  });
  const onSession = db.onSessionRevoked.bind(db);
  const onConfig = db.books.onConfigChanged.bind(db.books);
  t.mock.method(db, 'onSessionRevoked', (listener: (id: string) => void) => {
    sessionListeners++;
    const remove = onSession(listener);
    return () => { sessionListeners--; remove(); };
  });
  t.mock.method(db.books, 'onConfigChanged', (listener: () => void) => {
    configListeners++;
    const remove = onConfig(listener);
    return () => { configListeners--; remove(); };
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    db, sql, session, entered, aborted,
    get requests() { return requests; },
    listeners: () => ({ session: sessionListeners, config: configListeners }),
    expiryTimers: () => expiryTimers.size,
    request(url: string, options: { method?: string; cookie?: boolean; signal?: AbortSignal } = {}) {
      const headers: Record<string, string> = options.cookie
        ? { Cookie: `${BOOKS_COOKIE}=${db.books.createMediaSession({
          userId: session.userId, sessionId: session.id, expiresAt: session.expiresAt,
        })}` }
        : { Authorization: `Bearer ${session.token}` };
      return fetch(`${origin}/api/books${url}`, { method: options.method, signal: options.signal, headers });
    },
    release() { holding = false; for (const respond of pending.splice(0)) respond(); },
    async close() {
      holding = false; for (const respond of pending.splice(0)) respond();
      server.closeAllConnections(); provider.closeAllConnections();
      await Promise.all([server, provider].map(s => new Promise<void>(resolve => s.close(() => resolve()))));
      sql.close(); db.close();
      timerSpy.mock.restore(); clearSpy.mock.restore();
      await fs.rm(root, { recursive: true, force: true });
      if (enabled === undefined) delete process.env.BOOKS_ENABLED; else process.env.BOOKS_ENABLED = enabled;
    },
  };
}

const paths = [
  ['audio-union', '/libraries/selected/items?category=books'],
  ['ebook-native', '/libraries/selected/items?category=ebooks'],
  ['audio-single', '/libraries/selected/items?category=books&filter=single'],
  ['audio-multi', '/libraries/selected/items?category=books&filter=multi'],
  ['audio-search', '/libraries/selected/items?category=books&q=Generated'],
  ['ebook-search', '/libraries/selected/items?category=ebooks&q=Generated'],
  ['legacy-list', '/libraries/selected/items'],
  ['legacy-search', '/libraries/selected/search?q=Generated'],
  ['libraries', '/libraries'],
] as const;

for (const [name, url] of paths) for (const reason of ['session', 'user', 'expiry', 'disable', 'replace'] as const) {
  test(`catalog_${name}_${reason}_aborts_before_provider_release`, { timeout: 5000 }, async t => {
    const f = await fixture(t);
    try {
      if (reason === 'expiry') f.sql.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?')
        .run(Date.now() + 250, f.session.id);
      const response = f.request(url);
      await f.entered;
      if (reason === 'session') f.db.deleteSession(f.session.token);
      if (reason === 'user') f.db.deleteSessionsForUser(f.session.userId);
      if (reason === 'disable' || reason === 'replace') f.db.books.setConfig({
        ...f.db.books.readConfig()!, ...(reason === 'disable' ? { enabled: false } : { serverBindingProofId: 'replacement' }),
      }, 'generated-replacement');
      const denied = await Promise.race([response, delay(1000).then(() => assert.fail('Catalog stayed active after invalidation'))]);
      assert.equal(denied.status, reason === 'disable' || reason === 'replace' ? 409 : 401);
      assert.equal((await denied.json() as { code: string }).code,
        reason === 'disable' || reason === 'replace' ? 'BOOKS_CONFIGURATION_CHANGED' : 'BOOKS_SESSION_REQUIRED');
      await Promise.race([f.aborted, delay(750).then(() => assert.fail('Held upstream was not aborted'))]);
      f.release();
      await delay(10);
      assert.equal(f.requests, 1, 'No additional page or search request after invalidation');
      assert.deepEqual(f.listeners(), { session: 0, config: 0 });
      assert.equal(f.expiryTimers(), 0);
    } finally { await f.close(); }
  });
}

for (const options of [{ method: 'HEAD' }, { cookie: true }]) {
  test(`catalog_alias_${JSON.stringify(options)}_uses_the_same_lifetime`, async t => {
    const f = await fixture(t);
    try {
      const response = f.request('/libraries/selected/items?category=books', options);
      await f.entered;
      f.db.deleteSession(f.session.token);
      const denied = await Promise.race([response, delay(750).then(() => assert.fail('Alias stayed active'))]);
      assert.equal(denied.status, 401);
      if (options.method === 'HEAD') assert.equal(await denied.text(), '');
      await f.aborted;
      assert.equal(f.requests, 1);
      assert.deepEqual(f.listeners(), { session: 0, config: 0 });
    } finally { await f.close(); }
  });
}

test('catalog_final_identity_check_rejects_silent_expiry_or_principal_reassignment', async t => {
  for (const change of ['expiry', 'identity'] as const) {
    const f = await fixture(t);
    try {
      const response = f.request('/libraries/selected/items?category=ebooks');
      await f.entered;
      if (change === 'expiry') f.sql.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').run(Date.now() - 1, f.session.id);
      else f.sql.prepare('UPDATE sessions SET user_id = ? WHERE id = ?').run('different-user', f.session.id);
      f.release();
      assert.equal((await response).status, 401, 'Final delivery must revalidate, even without an event');
      assert.deepEqual(f.listeners(), { session: 0, config: 0 });
    } finally { await f.close(); }
  }
});

test('catalog_success_and_disconnect_release_operation_listeners', async t => {
  const f = await fixture(t);
  try {
    const controller = new AbortController();
    const response = f.request('/libraries/selected/items?category=books', { signal: controller.signal });
    await f.entered;
    assert.deepEqual(f.listeners(), { session: 1, config: 1 });
    assert.equal(f.expiryTimers(), 1);
    controller.abort();
    await assert.rejects(response, { name: 'AbortError' });
    await f.aborted;
    await delay(10);
    assert.equal(f.requests, 1);
    assert.deepEqual(f.listeners(), { session: 0, config: 0 });
    assert.equal(f.expiryTimers(), 0);
    f.release();
    for (let i = 0; i < 3; i++) {
      assert.equal((await f.request('/libraries/selected/items?category=books')).status, 200);
      assert.deepEqual(f.listeners(), { session: 0, config: 0 });
      assert.equal(f.expiryTimers(), 0);
    }
    assert.equal((await f.request('/libraries/selected/items?category=invalid')).status, 400);
    assert.deepEqual(f.listeners(), { session: 0, config: 0 });
    assert.equal(f.expiryTimers(), 0);
  } finally { await f.close(); }
});
