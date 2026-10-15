import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import test, { TestContext } from 'node:test';
import express from 'express';
import { DatabaseService } from '../models/database';
import { createBooksRouter } from '../books/routes';
import { BookItem } from '../books/types';
import { PlexService } from '../services/plexService';
import { buildCbzFixture, comicPanel } from '../books/proof/cbzFixture';
import type { WorkerOptions, Worker as NodeWorker } from 'node:worker_threads';
import { BooksCatalog } from '../books/catalog';
import { BooksRelay } from '../books/relay';
import { BookStreams } from '../books/streams';
import { EpubPreparation } from '../books/epub/prepare';
import Database from 'better-sqlite3';
import { ZipWriter, Uint8ArrayReader, Uint8ArrayWriter } from '@zip.js/zip.js';

class Membership extends PlexService {
  gate?: { entered(): void; promise: Promise<void> };
  override async validateExactServerMembership() {
    const gate = this.gate;
    if (gate) { this.gate = undefined; gate.entered(); await gate.promise; }
    return { serverToken: 'synthetic-server', discoveredUrl: '', owned: false };
  }
}
interface Status {
  contentVersion: string;
  protocol: string; revision: number; pages: Array<{ resourceId: string; state: string }>;
  readerId: string; state: 'preparing' | 'complete' | 'failed';
  mode: 'range' | 'full-download'; spine: string[];
  resources: Array<{ resourceId: string; size: number }>; reason?: string;
}
const digest = (name: string) => createHash('sha256').update(name).digest('hex');

type ProviderMode = 'range' | 'ignored' | 'entry-ignored' | 'malformed' | 'changed' | 'short' | 'no-validator';
async function fixture(mode: ProviderMode = 'range', corrupt: boolean | number = false, original?: Buffer) {
  const enabled = process.env.BOOKS_ENABLED;
  process.env.BOOKS_ENABLED = 'true';
  const root = path.resolve('.test-data', 'books-progressive', randomUUID());
  await fs.mkdir(root, { recursive: true });
  const panel = comicPanel(1, 1, 480, 512, 0);
  const bytes = original ?? await buildCbzFixture(Array.from({ length: 12 }, (_, i) => ({
    name: `Pages/${i + 1}.png`, data: i + 1 === (corrupt === true ? 11 : corrupt) ? Buffer.alloc(panel.length) : panel,
  })));
  const heldStart = bytes.indexOf(Buffer.from('Pages/11.png')) - 30;
  const heldEnd = bytes.indexOf(Buffer.from('Pages/12.png')) - 30;
  let held = true, received = 0, active = 0, full = 0, ranges = 0, calls = 0;
  const waiting = new Set<() => void>();
  const waitingIndex = new Set<() => void>();
  let indexGate: { entered(): void } | undefined;
  let fullGate: { entered(): void; released: Promise<void> } | undefined;
  const provider = express();
  provider.use((_req, _res, next) => { calls++; next(); });
  provider.get('/api/items/book', (_req, res) => res.json({
    id: 'book', libraryId: 'library', mediaType: 'book',
    libraryFiles: [{ ino: 'cbz', fileType: 'ebook', metadata: {
      filename: 'Generated.cbz', size: bytes.length, mtimeMs: 1,
    } }],
    media: { metadata: { title: 'Progressive fixture' }, ebookFile: { ino: 'cbz' } },
  }));
  provider.get('/api/items/book/file/cbz', (req, res) => {
    res.set({ 'Content-Type': 'application/zip', ETag: '"original"', 'Accept-Ranges': 'bytes' });
    if (mode === 'no-validator') { res.removeHeader('ETag'); res.removeHeader('Accept-Ranges'); }
    if (req.method === 'HEAD') { res.set('Content-Length', String(bytes.length)).end(); return; }
    active++;
    const finish = () => { active--; waiting.delete(send); waitingIndex.delete(send); };
    res.once('close', finish);
    const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '');
    const start = match ? Number(match[1]) : 0;
    const end = match ? Number(match[2]) + 1 : bytes.length;
    if (match) { ranges++; assert.equal(req.headers['if-range'], '"original"'); } else full++;
    const send = () => {
      if (res.destroyed) return;
      const partial = Boolean(match) && mode !== 'ignored' && !(mode === 'entry-ignored' && start !== bytes.length - 65557);
      res.status(partial ? 206 : 200);
      if (partial) res.set('Content-Range', `bytes ${start}-${end - 1}/${bytes.length}`);
      if (mode === 'malformed') res.set('Content-Range', `bytes ${start}-${end - 1}/${bytes.length + 1}`);
      if (mode === 'changed') res.set('ETag', '"changed"');
      const body = partial ? bytes.subarray(start, end) : bytes;
      res.set('Content-Length', String(body.length));
      if (!match && fullGate) {
        const gate = fullGate; fullGate = undefined;
        received += 65536; res.write(body.subarray(0, 65536)); gate.entered();
        void gate.released.then(() => {
          if (!res.destroyed) { received += body.length - 65536; res.end(body.subarray(65536)); }
        });
        return;
      }
      if (mode === 'short') { res.write(body.subarray(0, body.length - 1)); res.destroy(); return; }
      received += body.length; res.end(body);
    };
    if (indexGate && start === bytes.length - 65557) { waitingIndex.add(send); indexGate.entered(); }
    else if (mode === 'range' && held && start >= heldStart && start < heldEnd) waiting.add(send);
    else send();
  });
  const upstream = provider.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => upstream.once('listening', resolve));
  const up = upstream.address(); assert.ok(up && typeof up !== 'string');
  const db = new DatabaseService(path.join(root, 'fixture.db'), 'synthetic-key-at-least-thirty-two-characters');
  db.setSetting('plex_machine_id', 'fixture-machine');
  db.books.setConfig({ enabled: true, origin: `http://127.0.0.1:${up.port}`, libraryId: 'library',
    configGeneration: 0, providerInstanceId: '', serverBindingProofId: 'fixture' }, 'synthetic-credential');
  const user = db.createOrUpdatePlexUser({ plexId: 'a', username: 'Fixture', email: 'a@fixture.invalid',
    plexAccountToken: 'synthetic-account', plexToken: 'synthetic-server' });
  const session = db.createSession(user.id);
  const membership = new Membership();
  let clockOffset = 0;
  const catalog = new BooksCatalog(db.books);
  const preparation = new EpubPreparation(db, catalog, new BooksRelay(db, catalog, new BookStreams(), membership),
    membership, () => Date.now() + clockOffset);
  let responseHold: { entered(res: express.Response, baseline: number): void; released: Promise<void> } | undefined;
  const app = express(); app.use(express.json());
  app.use((req, res, next) => {
    if (req.path.endsWith('/reader-progressive')) {
      const baseline = res.listenerCount('finish'), json = res.json;
      res.json = function(body: unknown) {
        const held = responseHold;
        if (!held) return json.call(this, body);
        responseHold = undefined;
        held.entered(res, baseline);
        void held.released.then(() => { if (!res.destroyed) json.call(res, body); });
        return res;
      };
    }
    next();
  });
  app.use('/api/books', createBooksRouter(db, { plex: membership, preparation }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const request = (url: string, method = 'GET', body?: unknown, signal?: AbortSignal) => fetch(`${origin}/api/books${url}`, {
    signal,
    method, headers: { Authorization: `Bearer ${session.token}`, Origin: origin, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const item = await (await request('/items/book')).json() as BookItem;
  const target = { fileId: item.files[0].fileId, contentVersion: item.files[0].contentVersion };
  return {
    request, target, db, session, root, bytes, membership, origin,
    advanceReaderTime(milliseconds: number) { clockOffset += milliseconds; },
    accountedBytes(): number {
      const cache: unknown = Reflect.get(preparation, 'cache');
      assert.ok(cache instanceof Map);
      return [...cache.values()].reduce((sum: number, value: unknown) => {
        assert.ok(value && typeof value === 'object' && 'bytes' in value && typeof value.bytes === 'number');
        return sum + value.bytes;
      }, 0);
    },
    mode: (value: ProviderMode) => { mode = value; },
    counts: () => ({ received, active, full, ranges, calls }),
    holdFull() {
      let entered!: () => void, release!: () => void;
      const waiting = new Promise<void>(resolve => { entered = resolve; });
      fullGate = { entered, released: new Promise<void>(resolve => { release = resolve; }) };
      return { waiting, release };
    },
    holdIndex() {
      let entered!: () => void;
      const waiting = new Promise<void>(resolve => { entered = resolve; });
      indexGate = { entered };
      return { waiting, release() { indexGate = undefined; for (const send of waitingIndex) send(); waitingIndex.clear(); } };
    },
    holdResponse() {
      let response: express.Response, baseline = 0;
      let entered!: () => void, release!: () => void;
      const waiting = new Promise<void>(resolve => { entered = resolve; });
      responseHold = { released: new Promise<void>(resolve => { release = resolve; }),
        entered(res, count) { response = res; baseline = count; entered(); } };
      return { waiting, release, listeners: () => response.listenerCount('finish') - baseline };
    },
    release: () => { held = false; for (const send of waiting) send(); waiting.clear(); },
    async start(page = 1) {
      const response = await request('/items/book/reader-progressive', 'POST', { ...target, page });
      assert.equal(response.status, 202, await response.clone().text());
      return response.json() as Promise<Status>;
    },
    async status(reader: Status, page?: number) {
      const response = await request(`/readers/${reader.readerId}/status${page === undefined ? '' : `?page=${page}`}`);
      assert.equal(response.status, 200, await response.clone().text());
      return response.json() as Promise<Status>;
    },
    async close() {
      db.close(); server.closeAllConnections(); upstream.closeAllConnections();
      await Promise.all([server, upstream].map(s => new Promise<void>(resolve => s.close(() => resolve()))));
      // Background ownership must finish cleanup, not keep the next preparation slot occupied.
      for (let i = 0; i < 100 && (await fs.readdir(db.booksCacheDir).catch(() => [])).some(n => n.startsWith('work-')); i++) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      await fs.rm(root, { recursive: true, force: true });
      if (enabled === undefined) delete process.env.BOOKS_ENABLED; else process.env.BOOKS_ENABLED = enabled;
    },
  };
}

test('progressive first ten are usable while a later payload is held; legacy remains complete-only', { timeout: 15000 }, async () => {
  const f = await fixture();
  try {
    let reader = await f.start();
    while (reader.resources.length < 10 && reader.state === 'preparing') reader = await f.status(reader);
    assert.equal(reader.state, 'preparing');
    assert.equal(reader.spine.length, 12);
    assert.equal(reader.resources.length, 10);
    const first = await f.request(`/readers/${reader.readerId}/resources/${digest('Pages/1.png')}`);
    assert.equal(first.status, 200); assert.ok((await first.arrayBuffer()).byteLength > 0);
    assert.equal((await f.request(`/readers/${reader.readerId}/resources/${digest('Pages/11.png')}`)).status, 425);
    assert.equal((await f.request('/items/book/reader', 'POST', f.target)).status, 429);
    assert.ok(f.counts().received < f.bytes.length);
    assert.equal(f.counts().full, 0);
    assert.equal((await f.request(`/readers/${reader.readerId}`, 'DELETE')).status, 204);
  } finally { await f.close(); }
});

for (const mode of ['malformed', 'changed', 'short'] as const) {
  test(`invalid ${mode} range never exposes pages or starts a full-file fallback`, { timeout: 10000 }, async () => {
    const f = await fixture(mode);
    try {
      let reader = await f.start();
      const response = await f.request(`/readers/${reader.readerId}/status?page=1`);
      if (response.status === 200) {
        reader = await response.json() as Status;
        assert.equal(reader.state, 'failed');
        assert.equal(reader.resources.length, 0);
      } else assert.equal(response.status, 404);
      assert.equal(f.counts().full, 0);
    } finally { await f.close(); }
  });
}

test('losing ranges after publication is partial failure, never a second full transfer', { timeout: 15000 }, async () => {
  const f = await fixture();
  try {
    let reader = await f.start();
    reader = await f.status(reader);
    assert.equal(reader.resources.length, 10);
    f.mode('ignored'); f.release();
    reader = await f.status(reader, 11);
    assert.equal(reader.state, 'failed');
    assert.equal(reader.resources.length, 10);
    assert.equal(f.counts().full, 0);
  } finally { await f.close(); }
});

test('missing validators explicitly downloads the original before publishing pages', { timeout: 15000 }, async () => {
  const f = await fixture('no-validator');
  try {
    let reader = await f.start();
    assert.equal(reader.mode, 'full-download');
    while (reader.state === 'preparing') reader = await f.status(reader);
    assert.equal(reader.state, 'complete');
    assert.equal(f.counts().ranges, 0); assert.equal(f.counts().full, 1);
  } finally { await f.close(); }
});

test('a corrupt first page cannot create a readable resource', { timeout: 10000 }, async () => {
  const f = await fixture('range', 1);
  try {
    let reader = await f.start();
    while (reader.state === 'preparing') reader = await f.status(reader, 1);
    assert.equal(reader.state, 'failed'); assert.deepEqual(reader.resources, []);
    assert.equal((await f.request(`/readers/${reader.readerId}/resources/${digest('Pages/1.png')}`)).status, 422);
  } finally { await f.close(); }
});

test('valid held-auth startup disconnect performs zero provider operations after authentication releases', { timeout: 10000 }, async () => {
  const f = await fixture();
  let release!: () => void;
  try {
    let entered!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    f.membership.gate = { entered, promise: new Promise<void>(resolve => { release = resolve; }) };
    const before = f.counts().calls;
    const controller = new AbortController();
    const pending = f.request('/items/book/reader-progressive', 'POST', { ...f.target, page: 1 }, controller.signal);
    await waiting; controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    await new Promise(resolve => setTimeout(resolve, 20));
    release();
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(f.counts().calls, before);
    assert.deepEqual(await fs.readdir(f.db.booksCacheDir).catch(() => []), []);
  } finally { release?.(); await f.close(); }
});

function jobClock(context: TestContext) {
  const set = globalThis.setTimeout, clear = globalThis.clearTimeout;
  let now = 0;
  const timers = new Map<NodeJS.Timeout, { at: number; callback(): void }>();
  context.mock.method(globalThis, 'setTimeout', (fn: (...args: unknown[]) => void, milliseconds?: number, ...args: unknown[]) => {
    const timer = set(fn, milliseconds, ...args);
    if ([60000, 300000].includes(milliseconds ?? 0) && new Error().stack?.replace(/\\/g, '/').includes('/books/epub/progressive.js')) {
      timers.set(timer, { at: now + milliseconds!, callback: () => fn(...args) });
    }
    return timer;
  });
  context.mock.method(globalThis, 'clearTimeout', (timer: NodeJS.Timeout | undefined) => {
    if (timer) timers.delete(timer); clear(timer);
  });
  return {
    advance(milliseconds: number) {
      now += milliseconds;
      for (const [timer, entry] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (entry.at <= now && timers.has(timer)) { clear(timer); timers.delete(timer); entry.callback(); }
      }
    },
    size: () => timers.size,
  };
}
  function observeWorkers(context: TestContext, stallEntries = false): NodeWorker[] {
    const threads = require('node:worker_threads') as typeof import('node:worker_threads');
    const Original = threads.Worker;
    const workers: NodeWorker[] = [];
    context.mock.method(threads, 'Worker', function(filename: string | URL, options?: WorkerOptions) {
      const worker = stallEntries ? new Original(`
        const { parentPort, workerData } = require('node:worker_threads');
        const on = parentPort.on.bind(parentPort);
        parentPort.on = (event, handler) => on(event, command => {
          if (command.type === 'entry') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 11000);
          handler(command);
        });
        require(workerData.module);
      `, { ...options, eval: true, workerData: { ...options?.workerData, module: String(filename) } }) : new Original(filename, options);
      workers.push(worker);
      return worker;
    });
    return workers;
  }

  test('unexpected idle worker exit terminates held background work and preserves only validated pages', { timeout: 15000 }, async context => {
    const f = await fixture();
    const workers = observeWorkers(context);
    try {
      let reader = await f.start();
      reader = await f.status(reader);
      assert.equal(reader.resources.length, 10);
      assert.equal(workers.length, 1);
      await workers[0].terminate();
      reader = await f.status(reader);
      assert.equal(reader.state, 'failed');
      assert.equal(reader.resources.length, 10);
      assert.equal(f.counts().active, 0);
    } finally { await f.close(); }
  });

  test('three eleven-second worker commands share one thirty-second processing watchdog', { timeout: 40000 }, async context => {
    const f = await fixture();
    observeWorkers(context, true);
    const started = performance.now();
    try {
      let reader = await f.start();
      while (reader.state === 'preparing') reader = await f.status(reader);
      assert.equal(reader.state, 'failed');
      assert.equal(reader.resources.length, 2, 'The third command must not receive a fresh30second allowance');
      assert.ok(performance.now() - started >= 29000);
      assert.ok(performance.now() - started < 35000);
    } finally { await f.close(); }
  });

  test('a lost initial response after handoff is reclaimed by the unrenewed lease', { timeout: 10000 }, async context => {
    const f = await fixture();
    const clock = jobClock(context);
    try {
      const response = await f.request('/items/book/reader-progressive', 'POST', { ...f.target, page: 1 });
      assert.equal(response.status, 202);
      await response.body?.cancel();
      clock.advance(60000);
      for (let i = 0; i < 100 && (await fs.readdir(f.db.booksCacheDir)).length; i++) await new Promise(resolve => setTimeout(resolve, 20));
      assert.deepEqual(await fs.readdir(f.db.booksCacheDir), []);
      assert.equal(f.counts().active, 0); assert.equal(clock.size(), 0);
      await f.start();
    } finally { await f.close(); }
  });

for (const expiry of ['lease', 'absolute'] as const) test(`${expiry} job deadline cancels held background work and cleans the shared slot`, { timeout: 15000 }, async context => {
  const f = await fixture();
  const clock = jobClock(context);
  try {
    let reader = await f.start();
    reader = await f.status(reader, 1);
    assert.equal(reader.pages[0].state, 'ready');
    if (expiry === 'absolute') {
      for (let i = 0; i < 5; i++) {
        clock.advance(59999);
        reader = await f.status(reader, 1);
      }
      clock.advance(5);
    } else {
      clock.advance(59999);
      assert.equal((await f.request(`/readers/${reader.readerId}/resources/${digest('Pages/1.png')}`)).status, 200);
      clock.advance(1);
    }
    for (let i = 0; i < 100 && (await fs.readdir(f.db.booksCacheDir)).length; i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal((await f.request(`/readers/${reader.readerId}/status`)).status, 404);
    assert.deepEqual(await fs.readdir(f.db.booksCacheDir), []);
    assert.equal(f.counts().active, 0); assert.equal(clock.size(), 0);
    await f.start();
  } finally { await f.close(); }
});

test('cold later-page priority does not prepare preceding pages', { timeout: 15000 }, async () => {
  const f = await fixture();
  try {
    let reader = await f.start(12);
    while (!reader.resources.some(r => r.resourceId === digest('Pages/12.png')) && reader.state === 'preparing') {
      reader = await f.status(reader, 12);
    }
    assert.ok(reader.resources.some(r => r.resourceId === digest('Pages/12.png')));
    assert.ok(f.counts().received < 2 * 1024 * 1024);
    assert.equal(f.counts().full, 0);
  } finally { await f.close(); }
});

test('ignored initial range uses one explicit full-download fallback, never labels it incremental', { timeout: 15000 }, async () => {
  const f = await fixture('ignored');
  try {
    let reader = await f.start();
    while (reader.state === 'preparing') reader = await f.status(reader);
    assert.equal(reader.state, 'complete');
    assert.equal(reader.mode, 'full-download');
    assert.equal(reader.resources.length, 12);
    assert.equal(f.counts().ranges, 1);
    assert.equal(f.counts().full, 1);
    const legacy = await f.request('/items/book/reader', 'POST', f.target);
    assert.equal(legacy.status, 200);
    const complete = await legacy.json() as { state: string; spine: string[] };
    assert.equal(complete.state, 'ready'); assert.equal(complete.spine.length, 12);
  } finally { await f.close(); }
});

test('late damaged page retains validated pages with a persistent failure, not a complete book', { timeout: 15000 }, async () => {
  const f = await fixture('range', true);
  try {
    let reader = await f.start();
    while (reader.resources.length < 10 && reader.state === 'preparing') reader = await f.status(reader);
    f.release();
    while (reader.state === 'preparing') reader = await f.status(reader, 11);
    assert.equal(reader.state, 'failed');
    assert.ok(reader.reason);
    assert.equal(reader.resources.length, 10);
    assert.equal((await f.request(`/readers/${reader.readerId}/resources/${digest('Pages/1.png')}`)).status, 200);
    assert.equal((await f.request(`/readers/${reader.readerId}/resources/${digest('Pages/11.png')}`)).status, 422);
  } finally { await f.close(); }
});

test('partial protocol identifies every pending page and advances revision without pretending completeness', { timeout: 15000 }, async () => {
  const f = await fixture();
  try {
    let reader = await f.start();
    assert.equal(reader.protocol, 'cbz-progressive-v1');
    const revision = reader.revision;
    reader = await f.status(reader, 1);
    assert.ok(reader.revision > revision);
    assert.equal(reader.pages.length, 12);
    assert.equal(reader.pages[0].state, 'ready');
    assert.notEqual(reader.pages[10].state, 'ready');
  } finally { await f.close(); }
});

test('releasing a terminal partial failure removes retained bytes and permits reopening', { timeout: 15000 }, async () => {
  const f = await fixture('range', true);
  try {
    let reader = await f.start();
    reader = await f.status(reader);
    f.release();
    while (reader.state === 'preparing') reader = await f.status(reader);
    assert.equal(reader.state, 'failed');
    assert.equal((await f.request(`/readers/${reader.readerId}`, 'DELETE')).status, 204);
    for (let i = 0; i < 100 && (await fs.readdir(f.db.booksCacheDir)).length; i++) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.deepEqual(await fs.readdir(f.db.booksCacheDir), [], 'Released partial resources are not an orphaned cache entry');
    await f.start();
  } finally { await f.close(); }
});

test('application shutdown waits for background worker and retained-file cleanup', { timeout: 15000 }, async () => {
  const f = await fixture();
  try {
    let reader = await f.start();
    reader = await f.status(reader, 1);
    assert.equal(reader.pages[0].state, 'ready');
    await f.db.stopBooks();
    assert.deepEqual(await fs.readdir(f.db.booksCacheDir), []);
    assert.equal(f.counts().active, 0);
  } finally { await f.close(); }
});

test('disconnect before the initial response handoff cancels the job and removes operation listeners', { timeout: 10000 }, async () => {
  const f = await fixture();
  const held = f.holdResponse();
  try {
    const controller = new AbortController();
    const pending = f.request('/items/book/reader-progressive', 'POST', { ...f.target, page: 1 }, controller.signal);
    await held.waiting;
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    for (let i = 0; i < 100 && (await fs.readdir(f.db.booksCacheDir)).length; i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(await fs.readdir(f.db.booksCacheDir), []);
    assert.equal(held.listeners(), 0);
    assert.equal(f.counts().active, 0);
    await f.start();
  } finally { held.release(); await f.close(); }
});

for (const invalidation of ['session', 'user', 'configuration', 'source'] as const) {
  test(`${invalidation} invalidation revokes even validated partial resources and stops held transport`, { timeout: 10000 }, async () => {
    const f = await fixture();
    try {
      let reader = await f.start();
      reader = await f.status(reader);
      assert.equal(reader.resources.length, 10);
      if (invalidation === 'session') f.db.deleteSession(f.session.token);
      if (invalidation === 'user') f.db.deleteSessionsForUser(f.session.userId);
      if (invalidation === 'configuration') f.db.books.setConfig({ ...f.db.books.readConfig()!, serverBindingProofId: 'replacement-binding' }, 'synthetic-credential');
      if (invalidation === 'source') { f.mode('changed'); f.release(); }
      for (let i = 0; i < 100 && (await fs.readdir(f.db.booksCacheDir)).length; i++) await new Promise(resolve => setTimeout(resolve, 20));
      assert.deepEqual(await fs.readdir(f.db.booksCacheDir), []);
      const response = await f.request(`/readers/${reader.readerId}/resources/${digest('Pages/1.png')}`);
      assert.equal(response.status, invalidation === 'session' || invalidation === 'user' ? 401 : 404);
      assert.equal(f.counts().active, 0);
    } finally { await f.close(); }
  });
}

test('pending-page claim/save cannot replace the last ready-page position', { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    let reader = await f.start();
    reader = await f.status(reader);
    const url = '/items/book/progress/ebook';
    const write = { editionId: f.target.fileId, contentVersion: reader.contentVersion, op: 'claim',
      expectedRevision: 0, writerId: 'fixture-reader', sequence: 1,
      locator: { kind: 'cbz', page: 1, offset: 0, horizontal: 0, policyVersion: 'cbz-pages-v1' } };
    assert.equal((await f.request(url, 'PUT', { ...write, locator: { ...write.locator, page: 11 } })).status, 422);
    assert.equal((await f.request(url, 'PUT', write)).status, 200);
    const before = await (await f.request(`${url}?editionId=${f.target.fileId}`)).json();
    assert.equal((await f.request(url, 'PUT', { ...write, op: 'save', expectedRevision: 1, epoch: 1, sequence: 2,
      locator: { ...write.locator, page: 11 } })).status, 422);
    assert.deepEqual(await (await f.request(`${url}?editionId=${f.target.fileId}`)).json(), before);
  } finally { await f.close(); }
});

test('whole-directory name, type, page and declared-entry guards run before any page is exposed', { timeout: 20000 }, async () => {
  const page = comicPanel(1, 1, 1, 1);
  const archives = [
    await buildCbzFixture([{ name: '1.png', data: page }, { name: '1.PNG', data: page }]),
    await buildCbzFixture([{ name: 'e\u0301.png', data: page }, { name: '\u00e9.png', data: page }]),
    await buildCbzFixture([{ name: '1.png', data: page }, { name: '2.svg', data: Buffer.from('<svg/>') }]),
    await buildCbzFixture([{ name: '1.png', data: page }, { name: '2.png', data: page, password: 'fixture-only' }]),
    await buildCbzFixture(Array.from({ length: 1001 }, (_, i) => ({ name: `${i + 1}.png`, data: page }))),
  ];
  const oversized = await buildCbzFixture([{ name: '1.png', data: page }]);
  const central = oversized.indexOf(Buffer.from('504b0102', 'hex'));
  oversized.writeUInt32LE(32 * 1024 * 1024 + 1, central + 24);
  archives.push(oversized);
  for (const archive of archives) {
    const f = await fixture('range', false, archive);
    try {
      let reader = await f.start();
      while (reader.state === 'preparing') reader = await f.status(reader);
      assert.equal(reader.state, 'failed');
      assert.deepEqual(reader.resources, []);
    } finally { await f.close(); }
  }
});

test('expired partial handles cannot pin a failed preparation until the24hour complete-cache TTL', { timeout: 10000 }, async () => {
  const f = await fixture('range', true);
  try {
    let reader = await f.start();
    reader = await f.status(reader);
    f.release();
    while (reader.state === 'preparing') reader = await f.status(reader);
    f.advanceReaderTime(31 * 60 * 1000);
    assert.equal((await f.request(`/readers/${reader.readerId}/status`)).status, 410);
    await f.start();
  } finally { await f.close(); }
});

test('the shared reservation is not downgraded until spool cleanup finishes and retained pages stay charged', { timeout: 10000 }, async context => {
  const f = await fixture('range', true);
  const rm = fs.rm;
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  context.mock.method(fs, 'rm', async (filename: Parameters<typeof fs.rm>[0], options?: Parameters<typeof fs.rm>[1]) => {
    if (String(filename).startsWith(f.db.booksCacheDir) && path.basename(String(filename)).startsWith('work-')) {
      entered(); await released;
    }
    return rm(filename, options);
  });
  try {
    let reader = await f.start();
    reader = await f.status(reader);
    f.release();
    await waiting;
    assert.equal(f.accountedBytes(), 768 * 1024 * 1024);
    release();
    const retained = reader.resources.reduce((sum, resource) => sum + resource.size, 0);
    for (let i = 0; i < 100 && f.accountedBytes() !== retained; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(f.accountedBytes(), retained);
    assert.ok(retained > 0);
    assert.equal((await f.request(`/readers/${reader.readerId}/resources/${digest('Pages/1.png')}`)).status, 200);
  } finally { release(); await f.close(); }
});

test('status waits are coalesced per reader, not across independent completed-cache handles', { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const reader = await f.start();
    const pending = await Promise.all([0, 1].map(() => f.request(`/readers/${reader.readerId}/status`)));
    assert.deepEqual(pending.map(r => r.status).sort(), [200, 429]);
    f.release();
    let ready = await f.status(reader);
    while (ready.state === 'preparing') ready = await f.status(ready);
    const second = await f.start();
    const independent = await Promise.all([reader, second].map(r => f.request(`/readers/${r.readerId}/status`)));
    assert.deepEqual(independent.map(r => r.status), [200, 200]);
  } finally { await f.close(); }
});

test('release after native exit but before complete publication still closes and removes the original spool', { timeout: 10000 }, async context => {
  const f = await fixture();
  const workers = observeWorkers(context);
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  try {
    const reader = await f.start();
    await f.status(reader);
    assert.equal(workers.length, 1);
    const terminate = workers[0].terminate.bind(workers[0]);
    context.mock.method(workers[0], 'terminate', async () => {
      const result = await terminate(); entered(); await released; return result;
    });
    f.release();
    await waiting;
    assert.equal(workers[0].threadId, -1);
    assert.equal((await f.request(`/readers/${reader.readerId}`, 'DELETE')).status, 204);
    release();
    await f.db.stopBooks();
    assert.deepEqual(await fs.readdir(f.db.booksCacheDir), []);
    assert.equal(f.counts().active, 0);
  } finally { release(); await f.close(); }
});

test('the original session expiry cancels held background work without a renewal or another client request', { timeout: 10000 }, async () => {
  const f = await fixture();
  const sql = new Database(path.join(f.root, 'fixture.db'));
  try {
    sql.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').run(Date.now() + 2000, f.session.id);
    const reader = await f.start();
    await f.status(reader, 1);
    for (let i = 0; i < 300 && (await fs.readdir(f.db.booksCacheDir)).length; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(await fs.readdir(f.db.booksCacheDir), []);
    assert.equal(f.counts().active, 0);
    assert.equal((await f.request(`/readers/${reader.readerId}/status`)).status, 401);
  } finally { sql.close(); await f.close(); }
});

test('a partial reader belongs to its exact session and cannot be borrowed even by the same user', { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const reader = await f.start();
    await f.status(reader, 1);
    const other = f.db.createSession(f.session.userId);
    for (const url of [`/readers/${reader.readerId}/status`, `/readers/${reader.readerId}/resources/${digest('Pages/1.png')}`]) {
      const response = await fetch(`${f.origin}/api/books${url}`, { headers: { Authorization: `Bearer ${other.token}` } });
      assert.equal(response.status, 404);
    }
  } finally { await f.close(); }
});

test('a priority change during held directory loading waits for the validated index instead of failing the job', { timeout: 10000 }, async () => {
  const f = await fixture();
  const held = f.holdIndex();
  try {
    const reader = await f.start();
    await held.waiting;
    const pending = f.status(reader, 12);
    await new Promise(resolve => setTimeout(resolve, 30));
    held.release();
    const status = await pending;
    assert.notEqual(status.state, 'failed');
    assert.ok(status.resources.some(r => r.resourceId === digest('Pages/12.png')));
    assert.ok(f.counts().received < 2 * 1024 * 1024);
  } finally { held.release(); await f.close(); }
});

test('a failed cache entry reports unsupported content instead of a preparation that is no longer running', { timeout: 10000 }, async () => {
  const f = await fixture('range', true);
  try {
    f.release();
    const legacy = await f.request('/items/book/reader', 'POST', f.target);
    assert.equal(legacy.status, 200);
    assert.equal((await legacy.json() as { state: string }).state, 'download-only');
    const response = await f.request('/items/book/reader-progressive', 'POST', { ...f.target, page: 1 });
    assert.equal(response.status, 422);
    assert.equal((await response.json() as { code: string }).code, 'BOOK_DOWNLOAD_ONLY');
    assert.equal(f.counts().full, 1);
  } finally { await f.close(); }
});

test('a valid forced-ZIP64 directory still prepares its original page bytes', { timeout: 10000 }, async () => {
  const panel = comicPanel(1, 1, 16, 16);
  const writer = new ZipWriter(new Uint8ArrayWriter(), { zip64: true, useWebWorkers: false, useCompressionStream: false });
  await writer.add('1.png', new Uint8ArrayReader(panel));
  const f = await fixture('range', false, Buffer.from(await writer.close()));
  try {
    let reader = await f.start();
    while (reader.state === 'preparing') reader = await f.status(reader, 1);
    assert.equal(reader.state, 'complete', `Generated ZIP64 footer: ${f.bytes.subarray(-22).toString('hex')}`);
    assert.equal(reader.spine.length, 1);
    const response = await f.request(`/readers/${reader.readerId}/resources/${digest('1.png')}`);
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), panel);
  } finally { await f.close(); }
});

test('a priority change during the one full-download fallback does not abort or restart that transfer', { timeout: 10000 }, async () => {
  const f = await fixture('entry-ignored');
  const held = f.holdFull();
  try {
    const reader = await f.start();
    await held.waiting;
    const pending = f.status(reader, 12);
    await new Promise(resolve => setTimeout(resolve, 30));
    held.release();
    const status = await pending;
    assert.notEqual(status.state, 'failed');
    assert.equal(status.mode, 'full-download');
    assert.equal(status.resources[0]?.resourceId, digest('Pages/12.png'));
    assert.equal(f.counts().full, 1);
    assert.equal(f.counts().ranges, 2, 'Only the directory and ignored local-header probe used ranges');
  } finally { held.release(); await f.close(); }
});
