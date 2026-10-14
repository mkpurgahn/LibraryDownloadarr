import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import test, { after } from 'node:test';
import express from 'express';
import { DatabaseService } from '../models/database';
import { createBooksRouter } from '../books/routes';
import { BookStreams } from '../books/streams';
import { BooksPrincipal } from '../books/mediaAuth';
import { BookItem } from '../books/types';
import { PlexServerAccessDeniedError, PlexService, PlexServerClient } from '../services/plexService';
import { startFixtureApp } from '../books/proof/fixtureApp';
import { config } from '../config';
import { normalizeFixtureManifest } from '../books/proof/verifyAbs';
import Database from 'better-sqlite3';
import { createAuthRouter } from '../routes/auth';
import { createLibrariesRouter } from '../routes/libraries';
import { createMediaRouter } from '../routes/media';

const oldEnabled = process.env.BOOKS_ENABLED;
process.env.BOOKS_ENABLED = 'true';
after(() => { if (oldEnabled === undefined) delete process.env.BOOKS_ENABLED; else process.env.BOOKS_ENABLED = oldEnabled; });
const libraryId = '163ac435-50a9-4f56-96d0-276edf9303c1';
class MembershipFixture extends PlexService {
  denied = false;
  unavailable = false;
  forceChecks = 0;
  override createServerClient() {
    return new class extends PlexServerClient {
      override async getLibraries() { return []; }
    }('http://127.0.0.1:1', 'fixture-server-token');
  }
  override async validateExactServerMembership() {
    this.forceChecks += 1;
    if (this.unavailable) throw new Error('Fixture membership service unavailable');
    if (this.denied) throw new PlexServerAccessDeniedError();
    return { serverToken: 'synthetic-server-token', discoveredUrl: '', owned: false };
  }
}
async function listening(app: express.Express) {
  const server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { server, origin: `http://127.0.0.1:${address.port}` };
}
async function fixture() {
  const root = path.resolve('.test-data', 'books', randomUUID());
  await fs.mkdir(root, { recursive: true });
  const file = path.join(root, 'original.mp3');
  await fs.writeFile(file, '0123456789');
  const abs = express();
  let etag = '"fixture-v1"';
  let offload = false;
  let stall = false;
  let stallHeaders = false;
  let closed = 0;
  let active = 0;
  let denied = false;
  abs.use((req, res, next) => {
    if (req.headers.authorization !== 'Bearer synthetic-abs-credential' || denied) {
      res.status(403).end(); return;
    }
    next();
  });
  abs.get('/api/items/:itemId', (req, res) => res.json({
    id: req.params.itemId, libraryId: req.params.itemId === 'foreign' ? 'unselected' : libraryId,
    mediaType: 'book', isMissing: false, isInvalid: false,
    libraryFiles: [{
      ino: '17', fileType: 'audio',
      metadata: { filename: 'Audiobook \u00e9\u96ea.mp3', ext: '.mp3', size: 10, mtimeMs: 1700000000000, ctimeMs: 1700000000000 },
    }],
    media: {
      metadata: { title: 'Fixture audiobook', authors: [], narrators: [] },
      audioFiles: [{ ino: '17', duration: 10 }],
      tracks: [{ ino: '17', duration: 10, startOffset: 0 }], chapters: [],
    },
  }));
  abs.get(['/api/items/:itemId/file/:ino', '/api/items/:itemId/file/:ino/download'], (req, res) => {
    if (req.params.ino !== '17') { res.status(404).end(); return; }
    if (stallHeaders) return;
    if (offload) { res.set('X-Accel-Redirect', '/internal/private').status(204).end(); return; }
    res.set({
      ETag: etag, 'Last-Modified': 'Tue, 14 Nov 2023 22:13:20 GMT',
      'Set-Cookie': 'provider-secret=must-not-escape',
      'X-Internal-Path': '/private/torrents/books',
    });
    if (stall && req.method === 'GET') {
      active += 1;
      res.set({ 'Content-Type': 'audio/mpeg', 'Content-Length': '10', 'Accept-Ranges': 'bytes' });
      res.write('0');
      res.once('close', () => { active -= 1; closed += 1; });
      return;
    }
    res.sendFile(file);
  });
  const upstream = await listening(abs);
  const db = new DatabaseService(path.join(root, 'fixture.db'), 'fixture-encryption-key-longer-than-thirty-two');
  db.setSetting('plex_machine_id', 'fixture-machine');
  db.setSetting('plex_url', 'http://127.0.0.1:1');
  db.setSetting('plex_token', 'fixture-owner-server');
  db.books.setConfig({
    enabled: true, providerInstanceId: '', configGeneration: 0, origin: upstream.origin,
    libraryId, serverBindingProofId: 'delivery-fixture',
  }, 'synthetic-abs-credential');
  const a = db.createOrUpdatePlexUser({
    plexId: 'a', username: 'A', email: 'a@fixture.invalid', plexToken: 'a-server', plexAccountToken: 'a-account',
  });
  const b = db.createOrUpdatePlexUser({
    plexId: 'b', username: 'B', email: 'b@fixture.invalid', plexToken: 'b-server', plexAccountToken: 'b-account',
  });
  const sessions = [db.createSession(a.id), db.createSession(b.id), db.createSession(a.id)];
  const plex = new MembershipFixture();
  const app = express();
  app.use(express.json());
  app.use('/api/auth', createAuthRouter(db, plex));
  app.use('/api/libraries', createLibrariesRouter(db, plex));
  app.use('/api/media', createMediaRouter(db, { plex }));
  app.use('/api/books', createBooksRouter(db, { plex }));
  const local = await listening(app);
  const auth = (index = 0) => ({ Authorization: `Bearer ${sessions[index].token}` });
  const get = (url: string, options: RequestInit = {}) => fetch(`${local.origin}${url}`, options);
  const item: BookItem = await (await get('/api/books/items/item', { headers: auth() })).json() as BookItem;
  const target = { itemId: 'item', fileId: item.files[0].fileId, contentVersion: item.files[0].contentVersion };
  const content = `/api/books/items/item/files/${target.fileId}/content?version=${target.contentVersion}`;
  const issue = async (index = 0) => {
    const response = await get('/api/books/download-tickets', {
      method: 'POST', headers: { ...auth(index), Origin: local.origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ targets: [target] }),
    });
    assert.equal(response.status, 200);
    const result = await response.json() as { results: Array<{ ticket: { url: string } }> };
    return result.results[0].ticket.url;
  };
  const bridge = async (index = 0, cookie?: string) => {
    const response = await get('/api/books/media-session', {
      method: 'POST', headers: { ...auth(index), Origin: local.origin, ...(cookie ? { Cookie: cookie } : {}) },
    });
    assert.equal(response.status, 200);
    const set = response.headers.get('set-cookie')!;
    assert.match(set, /HttpOnly/);
    assert.match(set, /Secure/);
    assert.match(set, /SameSite=Strict/);
    assert.match(set, /Path=\/api\/books/);
    assert.equal(/Domain=/i.test(set), false);
    return set.split(';')[0];
  };
  return {
    db, sessions, plex, origin: local.origin, absOrigin: upstream.origin, root, auth, get, issue, bridge, target, content,
    etag: (value: string) => { etag = value; },
    offload: () => { offload = true; }, stall: () => { stall = true; },
    stallHeaders: () => { stallHeaders = true; },
    deny: () => { denied = true; }, closed: () => closed, active: () => active,
    async close() {
      db.close();
      local.server.closeAllConnections(); upstream.server.closeAllConnections();
      await Promise.all([local.server, upstream.server].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

test('every_content_route_rechecks_identity', async () => {
  const f = await fixture();
  try {
    const ticket = await f.issue();
    const cookie = await f.bridge();
    for (const method of ['GET', 'HEAD']) {
      for (const url of [f.content, ticket, '/api/books/items/item/cover']) {
        assert.equal((await f.get(url, { method })).status, 401);
        assert.equal((await f.get(url, { method, headers: { ...f.auth(1), Cookie: cookie } })).status, 403);
      }
      assert.equal((await f.get(ticket, { method, headers: f.auth(1) })).status, 404);
      assert.equal((await f.get(ticket, { method, headers: f.auth(2) })).status, 404);
      assert.equal((await f.get(f.content.replace('/items/item/', '/items/foreign/'), { method, headers: f.auth() })).status, 404);
      assert.equal((await f.get(f.content.replace(f.target.fileId, 'unknown-file'), { method, headers: f.auth() })).status, 404);
      const allowed = await f.get(f.content, { method, headers: { Cookie: cookie } });
      assert.equal(allowed.status, 200); await allowed.arrayBuffer();
    }
    for (const method of ['POST', 'PUT', 'DELETE']) {
      assert.equal((await f.get('/api/books/media-session', { method, headers: { Cookie: cookie, Origin: f.origin } })).status, 401);
    }
    for (const origin of ['', 'https://other.invalid']) {
      assert.equal((await f.get('/api/books/media-session', { method: 'POST', headers: { ...f.auth(), ...(origin ? { Origin: origin } : {}) } })).status, 403);
    }
    const switched = await f.bridge(1, cookie);
    assert.notEqual(switched, cookie);
    f.plex.denied = true;
    assert.equal((await f.get(f.content, { headers: { Cookie: cookie } })).status, 403);
    assert.equal(f.db.getSessionById(f.sessions[0].id), undefined);
  } finally { await f.close(); }
});

for (const spelling of ['canonical', 'uppercase', 'trailing-slash'] as const) {
  for (const failure of ['denied', 'unavailable'] as const) {
    test(`accepted_transfer_aliases_recheck_membership_${spelling}_${failure}`, async () => {
      const requests = [
        ['GET', 'content'], ['HEAD', 'content'], ['GET', 'download'], ['HEAD', 'download'],
        ['POST', 'tickets'], ['POST', 'reader'], ['GET', 'resource'], ['HEAD', 'resource'],
      ] as const;
      for (const [method, kind] of requests) {
        const f = await fixture();
        try {
          const ticket = await f.issue();
          const cookie = await f.bridge();
          const paths = {
            content: f.content.split('?')[0], download: ticket, tickets: '/api/books/download-tickets',
            reader: '/api/books/items/item/reader', resource: '/api/books/readers/unknown/resources/unknown',
          };
          let pathname = paths[kind];
          if (spelling === 'uppercase') {
            pathname = pathname.replace(/\/(items|files|content|downloads|download-tickets|reader|readers|resources)(?=\/|$)/g,
              segment => segment.toUpperCase());
          } else if (spelling === 'trailing-slash') pathname += '/';
          if (kind === 'content') pathname += `?version=${f.target.contentVersion}`;
          const before = f.plex.forceChecks;
          f.plex[failure] = true;
          const response = await f.get(pathname, {
            method, headers: {
              ...f.auth(), Cookie: cookie, Origin: f.origin, 'Content-Type': 'application/json',
            },
            ...(method === 'POST' ? { body: JSON.stringify(kind === 'tickets'
              ? { targets: [f.target] } : { fileId: f.target.fileId, contentVersion: f.target.contentVersion }) } : {}),
          });
          assert.equal(response.status, failure === 'denied' ? 403 : 503, `${method} ${kind} ${spelling}`);
          assert.equal(response.headers.get('cache-control'), 'private, no-store');
          assert.equal(f.plex.forceChecks, before + 1);
          const sql = new Database(path.join(f.root, 'fixture.db'), { readonly: true });
          try {
            const count = sql.prepare('SELECT COUNT(*) AS count FROM books_tickets').get() as { count: number };
            assert.equal(count.count, failure === 'denied' ? 0 : 1, 'No capability created after denial/uncertainty');
          } finally { sql.close(); }
          await response.arrayBuffer();
        } finally { await f.close(); }
      }
    });
  }
}

test('if_range_mismatch_restarts_unsatisfiable_single_range_get_and_head', async () => {
  const f = await fixture();
  try {
    const ticket = await f.issue();
    for (const method of ['GET', 'HEAD']) {
      for (const [validator, status] of [
        ['"fixture-v1"', 416], ['"old-longer-original"', 200],
        ['Tue, 14 Nov 2023 22:13:20 GMT', 416], ['Tue, 14 Nov 2023 22:13:19 GMT', 200],
      ] as const) {
        const response = await f.get(ticket, { method, headers: { ...f.auth(), Range: 'bytes=100-', 'If-Range': validator } });
        assert.equal(response.status, status, `${method} ${validator}`);
        assert.equal(response.headers.get('content-range'), status === 416 ? 'bytes */10' : null);
        if (status === 200) {
          assert.equal(response.headers.get('content-length'), '10');
          assert.equal(response.headers.get('etag'), '"fixture-v1"');
        }
        assert.equal(await response.text(), method === 'GET' && status === 200 ? '0123456789' : '');
      }
      for (const range of ['bytes=0-1,4-5', 'bytes=bad', 'bytes=5-2']) {
        const response = await f.get(ticket, { method, headers: { ...f.auth(), Range: range, 'If-Range': '"different"' } });
        assert.equal(response.status, 416, 'Malformed/multipart policy is unchanged');
        await response.arrayBuffer();
      }
    }
  } finally { await f.close(); }
});

test('books_saturation_and_provider_failure_preserve_plex_routes', async () => {
  const f = await fixture();
  const controllers = [new AbortController(), new AbortController()];
  try {
    f.stall();
    const responses = await Promise.all(controllers.map(controller =>
      f.get(f.content, { headers: f.auth(), signal: controller.signal })));
    const completed = responses.map(response => response.arrayBuffer().then(() => false, () => true));
    assert.equal((await f.get(f.content, { headers: f.auth() })).status, 429);
    assert.equal((await f.get('/api/libraries', { headers: f.auth() })).status, 200);
    assert.equal((await f.get('/api/media/season/123/download', { headers: f.auth() })).status, 410);
    controllers.forEach(controller => controller.abort());
    assert.deepEqual(await Promise.all(completed), [true, true]);
    f.deny();
    assert.equal((await f.get('/api/books/items/item', { headers: f.auth() })).status, 502);
    assert.equal((await f.get('/api/libraries', { headers: f.auth() })).status, 200);
    assert.equal((await f.get('/api/auth/me', { headers: f.auth() })).status, 200);
  } finally {
    controllers.forEach(controller => controller.abort());
    await f.close();
  }
});

test('books_probe_does_not_invalidate_first_run_plex_setup', async () => {
  const db = new DatabaseService(':memory:', 'bootstrap-fixture-key-longer-than-thirty-two');
  const user = db.createAdminUser({ username: 'bootstrap', email: 'bootstrap@fixture.invalid', passwordHash: 'fixture-placeholder', isAdmin: true });
  const session = db.createSession(user.id);
  const app = express(); app.use(express.json());
  app.use('/api/auth', createAuthRouter(db));
  app.use('/api/books', createBooksRouter(db));
  const { server, origin } = await listening(app);
  const headers = { Authorization: `Bearer ${session.token}`, Origin: origin };
  try {
    const probe = await fetch(`${origin}/api/books/media-session`, { method: 'POST', headers });
    assert.equal(probe.status, 403);
    assert.equal((await probe.json() as { code: string }).code, 'PLEX_ACCESS_REQUIRED');
    assert.ok(db.getSessionById(session.id));
    assert.equal((await fetch(`${origin}/api/auth/me`, { headers })).status, 200);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    db.close();
  }
});

test('logout_revokes_the_same_session_even_when_plex_is_unavailable', async () => {
  const f = await fixture();
  try {
    const cookie = await f.bridge();
    await f.issue();
    f.stall();
    const response = await f.get(f.content, { headers: f.auth() });
    const stopped = response.arrayBuffer().then(() => false, () => true);
    f.db.updatePlexMembership(f.sessions[0].userId, 'fixture-server', 0);
    f.plex.unavailable = true;
    const logout = await f.get('/api/auth/logout', { method: 'POST', headers: { ...f.auth(), Origin: f.origin } });
    assert.equal(logout.status, 200);
    assert.equal(f.db.getSessionById(f.sessions[0].id), undefined);
    assert.ok(f.db.getSessionById(f.sessions[1].id));
    assert.equal(await stopped, true);
    assert.equal(f.db.books.getMediaSession(cookie.slice(cookie.indexOf('=') + 1)), undefined);
  } finally { await f.close(); }
});

test('original_representation_is_truthful', async () => {
  const f = await fixture();
  try {
    const ticket = await f.issue();
    for (const [range, status, bytes, contentRange] of [
      [undefined, 200, '0123456789', null],
      ['bytes=2-5', 206, '2345', 'bytes 2-5/10'],
      ['bytes=7-', 206, '789', 'bytes 7-9/10'],
      ['bytes=-3', 206, '789', 'bytes 7-9/10'],
      ['bytes=100-', 416, '', 'bytes */10'],
      ['bytes=0-1,4-5', 416, '', 'bytes */10'],
    ] as const) {
      for (const method of ['GET', 'HEAD']) {
        const response = await f.get(ticket, { method, headers: { ...f.auth(), ...(range ? { Range: range } : {}) } });
        assert.equal(response.status, status, `${method} ${range}`);
        assert.equal(response.headers.get('content-range'), contentRange);
        assert.equal(await response.text(), method === 'HEAD' ? '' : bytes);
        if (status !== 416) assert.equal(response.headers.get('content-length'), String(bytes.length));
        assert.equal(response.headers.get('set-cookie'), null);
        assert.equal(response.headers.get('x-internal-path'), null);
      }
    }
    for (const [ifRange, status, bytes] of [
      ['"fixture-v1"', 206, '2345'], ['"changed"', 200, '0123456789'],
      ['Tue, 14 Nov 2023 22:13:20 GMT', 206, '2345'],
      ['Tue, 14 Nov 2023 22:13:19 GMT', 200, '0123456789'],
      ['W/"fixture-v1"', 200, '0123456789'],
    ] as const) {
      const response = await f.get(ticket, { headers: { ...f.auth(), Range: 'bytes=2-5', 'If-Range': ifRange } });
      assert.equal(response.status, status);
      assert.equal(await response.text(), bytes);
    }
    const head = await f.get(ticket, { method: 'HEAD', headers: f.auth() });
    assert.match(head.headers.get('content-disposition')!, /filename\*=UTF-8''Audiobook%20%C3%A9%E9%9B%AA\.mp3/);
    assert.ok(f.plex.forceChecks > 0);
    f.etag('"changed-same-size"');
    assert.equal((await f.get(ticket, { headers: f.auth() })).status, 409);
    const refreshed = await (await f.get('/api/books/items/item', { headers: f.auth() })).json() as BookItem;
    assert.notEqual(refreshed.files[0].contentVersion, f.target.contentVersion);
  } finally { await f.close(); }
});

test('weak_etag_is_never_promoted', async () => {
  const f = await fixture();
  try {
    f.etag('W/"fixture-v1"');
    const response = await f.get(f.content, { headers: { ...f.auth(), Range: 'bytes=2-5' } });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('etag'), 'W/"fixture-v1"');
    assert.equal(await response.text(), '2345');
  } finally { await f.close(); }
});

test('bridge_and_ticket_storage_is_hashed_and_expiry_requires_renewal', async () => {
  const f = await fixture();
  try {
    const ticket = await f.issue();
    const cookie = await f.bridge();
    const sql = new Database(path.join(f.root, 'fixture.db'), { readonly: true });
    try {
      const rows = JSON.stringify([
        sql.prepare('SELECT * FROM books_media_sessions').all(), sql.prepare('SELECT * FROM books_tickets').all(),
      ]);
      assert.equal(rows.includes(cookie.slice(cookie.indexOf('=') + 1)), false);
      assert.equal(rows.includes(ticket.split('/').pop()!), false);
      assert.equal(rows.includes(f.sessions[0].token), false);
    } finally { sql.close(); }
    const expired = f.db.books.createBookTicket({
      ...f.target, userId: f.sessions[0].userId, sessionId: f.sessions[0].id, expiresAt: Date.now() - 1,
      configGeneration: f.db.books.readConfig()!.configGeneration,
    });
    assert.equal((await f.get(`/api/books/downloads/${expired}`, { headers: f.auth() })).status, 410);
    const renewed = await f.issue();
    assert.notEqual(renewed, ticket);
    assert.equal((await f.get(renewed, { method: 'HEAD', headers: f.auth() })).status, 200);
    const issue = (targets: unknown[]) => f.get('/api/books/download-tickets', {
      method: 'POST', headers: { ...f.auth(), Origin: f.origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ targets }),
    });
    assert.equal((await issue(Array.from({ length: 101 }, () => f.target))).status, 400);
    const partial = await issue([f.target, { ...f.target, fileId: 'not-this-item' }]);
    const results = (await partial.json() as { results: Array<{ ticket?: unknown; error?: { status: number } }> }).results;
    assert.ok(results[0].ticket);
    assert.equal(results[1].error?.status, 404);
    assert.equal((await f.get(f.content, { headers: { 'Cookie': `${cookie}; ${cookie}` } })).status, 401);
  } finally { await f.close(); }
});

test('logout_and_generation_change_abort_streams', async () => {
  for (const revoke of ['session', 'generation'] as const) {
    const f = await fixture();
    try {
      f.stall();
      const response = await f.get(f.content, { headers: f.auth() });
      assert.equal(response.status, 200);
      const reading = response.arrayBuffer();
      if (revoke === 'session') f.db.deleteSession(f.sessions[0].token);
      else f.db.books.setConfig({ ...f.db.books.readConfig()!, enabled: false });
      await assert.rejects(reading);
      for (let i = 0; i < 30 && f.closed() === 0; i++) await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(f.closed(), 1);
      assert.equal(f.active(), 0);
    } finally { await f.close(); }
  }
});

test('upstream_offload_is_not_success', async () => {
  const f = await fixture();
  try {
    f.offload();
    for (const method of ['GET', 'HEAD']) {
      const response = await f.get(f.content, { method, headers: f.auth() });
      assert.equal(response.status, 502);
      assert.equal(response.headers.get('x-accel-redirect'), null);
      assert.equal(response.headers.get('set-cookie'), null);
    }
  } finally { await f.close(); }
});

test('file_connection_deadline_is_ten_seconds', { timeout: 20000 }, async () => {
  const f = await fixture();
  try {
    f.stallHeaders();
    const start = performance.now();
    const response = await f.get(f.content, { headers: f.auth() });
    const elapsed = performance.now() - start;
    assert.equal(response.status, 503);
    assert.ok(elapsed >= 9000 && elapsed < 15000, `Connection deadline observed at ${elapsed}ms`);
  } finally { await f.close(); }
});

test('idle_stream_is_cancelled_at_sixty_seconds', { timeout: 75000 }, async () => {
  const f = await fixture();
  try {
    f.stall();
    const response = await f.get(f.content, { headers: f.auth() });
    const start = performance.now();
    await assert.rejects(response.arrayBuffer());
    const elapsed = performance.now() - start;
    assert.ok(elapsed >= 59000 && elapsed < 70000, `Idle deadline observed at ${elapsed}ms`);
    for (let i = 0; i < 30 && f.closed() === 0; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(f.closed(), 1);
  } finally { await f.close(); }
});

test('stream_admission_is_bounded_without_queues', () => {
  const streams = new BookStreams();
  const principal = (userId: string): BooksPrincipal => ({ userId, sessionId: userId, expiresAt: Date.now() + 60000 });
  const releases: Array<() => void> = [];
  let aborted = 0;
  for (const user of ['a', 'a', 'b', 'b', 'c', 'c', 'd', 'd']) {
    releases.push(streams.register(principal(user), 1, () => { aborted += 1; }));
  }
  assert.throws(() => streams.register(principal('a'), 1, () => undefined), { status: 429 });
  assert.throws(() => streams.register(principal('new'), 1, () => undefined), { status: 429 });
  streams.revokeSession('a');
  assert.equal(aborted, 2);
  releases.forEach(release => release());
  assert.doesNotThrow(() => streams.register(principal('new'), 1, () => undefined)());
});

test('shutdown_invalidates_books_without_revoking_plex_sessions', async () => {
  const f = await fixture();
  try {
    const ticket = await f.issue();
    const cookie = await f.bridge();
    f.stall();
    const response = await f.get(f.content, { headers: f.auth() });
    const reading = response.arrayBuffer();
    f.db.stopBooks();
    await assert.rejects(reading);
    assert.ok(f.db.getSessionById(f.sessions[0].id));
    assert.equal((await f.get(ticket, { headers: f.auth() })).status, 410);
    assert.equal((await f.get(f.content, { headers: { Cookie: cookie } })).status, 401);
  } finally { await f.close(); }
});

test('consumer_proof_manifest_is_versioned_scoped_and_credential_free', () => {
  const fixtureFile = {
    absItemId: 'item', absIno: '17', relativePath: 'owned/Novel.mp3',
    role: 'audio', size: 10, sha256: 'a'.repeat(64), manifestVersion: 'fixture-version',
  };
  const input = {
    schemaVersion: 1, kind: 'independent-abs', runId: 'fixture-run',
    absVersion: '2.30.0', serverBindingProofId: 'fixture-binding',
    providerInstanceId: 'fixture-provider', libraryId, files: [fixtureFile],
  };
  const result = normalizeFixtureManifest(input);
  assert.equal(result.files[0].absIno, '17');
  assert.equal(result.files[0].sha256, 'a'.repeat(64));
  for (const invalid of [
    { ...input, schemaVersion: 2 }, { ...input, absVersion: '2.29.0' },
    { ...input, token: 'secret' }, { ...input, files: [{ ...fixtureFile, relativePath: '../outside' }] },
    { ...input, files: [fixtureFile, fixtureFile] },
  ]) assert.throws(() => normalizeFixtureManifest(invalid), /fixture/i);
});

test('ongoing_streams_recheck_membership_and_client_cancellation', { timeout: 5000 }, async () => {
  const ttl = config.plex.membershipTtlMs;
  config.plex.membershipTtlMs = 30;
  try {
    for (const reason of ['membership', 'disconnect']) {
      const f = await fixture();
      try {
        f.stall();
        const controller = new AbortController();
        const response = await f.get(f.content, { headers: f.auth(), signal: controller.signal });
        const reading = response.arrayBuffer();
        if (reason === 'membership') f.plex.denied = true;
        else controller.abort();
        await assert.rejects(reading);
        for (let i = 0; i < 30 && f.closed() === 0; i++) await new Promise(resolve => setTimeout(resolve, 10));
        assert.equal(f.closed(), 1);
      } finally { await f.close(); }
    }
  } finally { config.plex.membershipTtlMs = ttl; }
});

test('fixture_app_uses_real_https_authentication_without_test_login_routes', async () => {
  const f = await fixture();
  const root = path.join(f.root, 'https-app');
  const cert = path.join(root, 'fixture-cert.pem');
  const key = path.join(root, 'fixture-key.pem');
  const previous = {
    cert: process.env.BOOKS_PROOF_TLS_CERT_FILE, key: process.env.BOOKS_PROOF_TLS_KEY_FILE,
    token: process.env.BOOKS_PROOF_ABS_TOKEN,
    frontend: process.env.BOOKS_TEST_FRONTEND_DIST,
  };
  let app: Awaited<ReturnType<typeof startFixtureApp>> | undefined;
  try {
    await fs.mkdir(root);
    if (previous.cert && previous.key) {
      await Promise.all([fs.copyFile(previous.cert, cert), fs.copyFile(previous.key, key)]);
    } else {
      await promisify(execFile)('openssl', [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=localhost',
        '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-keyout', key, '-out', cert,
      ]);
    }
    process.env.BOOKS_PROOF_TLS_CERT_FILE = cert;
    process.env.BOOKS_PROOF_TLS_KEY_FILE = key;
    process.env.BOOKS_PROOF_ABS_TOKEN = 'synthetic-abs-credential';
    const publicPath = path.join(root, 'public');
    await fs.mkdir(publicPath);
    await fs.writeFile(path.join(publicPath, 'index.html'), '<!doctype html><title>Owned frontend fixture</title>');
    process.env.BOOKS_TEST_FRONTEND_DIST = publicPath;
    await assert.rejects(startFixtureApp(root, 'https://production.invalid', libraryId), /isolated/i);
    app = await startFixtureApp(root, f.absOrigin, libraryId);
    const ca = await fs.readFile(cert);
    const request = (pathname: string, method: string, headers: Record<string, string>, body?: string) => new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
      const req = https.request(new URL(pathname, app!.origin), { method, headers, ca }, res => {
        const chunks: Buffer[] = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      });
      req.once('error', reject); if (body) req.write(body); req.end();
    });
    assert.equal((await request('/api/books/items/item', 'GET', {})).status, 401);
    const frontend = await request('/', 'GET', {});
    assert.equal(frontend.status, 200);
    assert.ok(frontend.body.includes('Owned frontend fixture'));
    const headers = { Authorization: `Bearer ${app.users[0].bearer}`, Origin: app.origin };
    assert.equal((await request('/api/auth/me', 'GET', headers)).status, 200);
    assert.equal((await request('/api/media/recently-added', 'GET', headers)).status, 200);
    const bridge = await request('/api/books/media-session', 'POST', headers);
    assert.equal(bridge.status, 200);
    assert.match(bridge.headers['set-cookie']![0], /Secure/);
    const cookie = bridge.headers['set-cookie']![0].split(';')[0];
    assert.equal((await request('/api/books/items/item', 'HEAD', { Cookie: cookie })).status, 200);
    assert.equal((await request('/api/auth/me', 'GET', { Cookie: cookie })).status, 401);
    const malformed = await request('/api/settings/books', 'PUT', {
      Authorization: `Bearer ${app.users[2].bearer}`, Origin: app.origin, 'Content-Type': 'application/json',
    }, '{"credential":"synthetic-abs-credential"');
    assert.equal(malformed.status, 400);
    assert.equal(malformed.body.includes('synthetic-abs-credential'), false);
    assert.equal(malformed.headers['cache-control'], 'private, no-store');
    const logout = await request('/api/auth/logout', 'POST', headers);
    assert.equal(logout.status, 200);
    assert.equal((await request('/api/books/items/item', 'GET', { Cookie: cookie })).status, 401);
  } finally {
    await app?.stop();
    for (const [name, value] of [
      ['BOOKS_PROOF_TLS_CERT_FILE', previous.cert], ['BOOKS_PROOF_TLS_KEY_FILE', previous.key],
      ['BOOKS_PROOF_ABS_TOKEN', previous.token],
      ['BOOKS_TEST_FRONTEND_DIST', previous.frontend],
    ] as const) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    await f.close();
  }
});
