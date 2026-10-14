import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import http from 'node:http';
import express from 'express';
import Database from 'better-sqlite3';
import { deflateRawSync } from 'node:zlib';
import test, { after } from 'node:test';
import { ArchiveBudget, EPUB_LIMITS, validateArchiveName } from '../books/epub/manifest';
import { EpubPreparation, runArchiveWorker } from '../books/epub/prepare';
import { buildEpubFixture as epub, fixturePackage as packageXml, fixtureChapter as chapter } from '../books/proof/epubFixture';
import { buildCbzFixture } from '../books/proof/cbzFixture';
import { DatabaseService } from '../models/database';
import { createBooksRouter } from '../books/routes';
import { PlexService } from '../services/plexService';
import { BookItem } from '../books/types';
import { ReaderDescriptor } from '../books/epub/manifest';
import { BooksCatalog } from '../books/catalog';
import { BooksRelay } from '../books/relay';
import { BookStreams } from '../books/streams';

const evidence: Array<Record<string, unknown>> = [];
function rawArchive(entries: Array<{ name: string; data?: Buffer; declaredSize?: number; symlink?: boolean; deflate?: boolean }>): Buffer {
  const records: Buffer[] = []; const directory: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const original = entry.data ?? Buffer.alloc(0);
    const bytes = entry.deflate ? deflateRawSync(original) : original;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(2048, 6);
    local.writeUInt16LE(entry.deflate ? 8 : 0, 8); local.writeUInt32LE(bytes.length, 18);
    local.writeUInt32LE(entry.declaredSize ?? original.length, 22); local.writeUInt16LE(name.length, 26);
    records.push(local, name, bytes);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(3 * 256 + 20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(2048, 8); central.writeUInt16LE(entry.deflate ? 8 : 0, 10);
    central.writeUInt32LE(bytes.length, 20); central.writeUInt32LE(entry.declaredSize ?? original.length, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt32LE(entry.symlink ? (0o120777 << 16) >>> 0 : 0, 38);
    central.writeUInt32LE(offset, 42); directory.push(central, name);
    offset += local.length + name.length + bytes.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.reduce((sum, data) => sum + data.length, 0), 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...records, ...directory, end]);
}
async function withArchive(bytes: Buffer, run: (source: string, output: string) => Promise<void>) {
  const root = path.resolve('.test-data', 'books-epub', randomUUID());
  await fs.mkdir(root, { recursive: true });
  const source = path.join(root, 'original.epub');
  await fs.writeFile(source, bytes);
  try {
    await run(source, path.join(root, 'prepared'));
    assert.equal(createHash('sha256').update(await fs.readFile(source)).digest('hex'), createHash('sha256').update(bytes).digest('hex'));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}

test('archive_limits_apply_to_actual_output', () => {
  const budget = new ArchiveBudget(100 * 1024 * 1024);
  const megabyte = new Uint8Array(1024 * 1024);
  for (let entry = 0; entry < 16; entry++) {
    budget.beginEntry();
    for (let chunk = 0; chunk < 32; chunk++) budget.consume(megabyte);
  }
  assert.equal(budget.expandedBytes, 512 * 1024 * 1024);
  budget.beginEntry();
  assert.throws(() => budget.consume(new Uint8Array(1)), /expanded/i);
  const entryBudget = new ArchiveBudget(1024 * 1024);
  entryBudget.beginEntry();
  for (let chunk = 0; chunk < 32; chunk++) entryBudget.consume(megabyte);
  assert.throws(() => entryBudget.consume(new Uint8Array(1)), /entry/i);
  const ratio = new ArchiveBudget(10);
  ratio.beginEntry(); ratio.consume(new Uint8Array(1000));
  assert.throws(() => ratio.consume(new Uint8Array(1)), /ratio/i);
  const entries = new ArchiveBudget(1024);
  for (let index = 0; index < 10000; index++) entries.beginEntry();
  assert.throws(() => entries.beginEntry(), /entries/i);
  assert.throws(() => new ArchiveBudget(100 * 1024 * 1024 + 1), { status: 413 });
  assert.throws(() => new ArchiveBudget(1).checkMemory(EPUB_LIMITS.memoryBytes), /memory/i);
  evidence.push({ test: 'archive_limits_apply_to_actual_output', maxEntryBytes: 32 * 1024 * 1024, maxExpandedBytes: budget.expandedBytes, ratio: 100, maxEntries: 10000, verdict: 'pass' });
});

test('archive_names_and_xml_are_untrusted', async () => {
  for (const name of ['/absolute', '../escape', 'OPS/../escape', 'C:/drive', 'OPS\\path', 'OPS//ambiguous', 'OPS/./ambiguous', 'OPS/\0bad']) {
    assert.throws(() => validateArchiveName(name), /unsafe/i);
  }
  assert.equal(validateArchiveName('OPS/chapter.xhtml'), 'OPS/chapter.xhtml');
  await withArchive(await epub({ first: '<!DOCTYPE html [<!ENTITY unsafe "fixture">]>' + chapter('&unsafe;') }), async (source, output) => {
    const result = await runArchiveWorker(source, output, new AbortController().signal);
    assert.equal(result.state, 'download-only');
    assert.equal(result.reason, 'Cannot read safely here; download original.');
  });
  await withArchive(await epub({ package: packageXml.replace('<spine>', '<spine><itemref idref="missing"/>') }), async (source, output) => {
    assert.equal((await runArchiveWorker(source, output, new AbortController().signal)).state, 'download-only');
  });
  evidence.push({ test: 'archive_names_and_xml_are_untrusted', invalidNames: 'rejected', dtd: 'rejected', unknownSpine: 'rejected', verdict: 'pass' });
});

for (const format of ['epub', 'cbz'] as const) test(`${format}_binary_archive_rejects_unsafe_entries_and_observes_inflated_bytes`, async () => {
    for (const entries of [
      [{ name: '../escape' }], [{ name: '/absolute' }], [{ name: 'duplicate' }, { name: 'duplicate' }],
      [{ name: 'OPS//ambiguous' }], [{ name: 'link', symlink: true }],
    ]) await withArchive(rawArchive(entries), async (source, output) => {
      assert.equal((await runArchiveWorker(source, output, new AbortController().signal, undefined, format)).state, 'download-only');
    });
    await withArchive(rawArchive([{ name: 'oversized', data: Buffer.alloc(33 * 1024 * 1024), declaredSize: 1 }]), async (source, output) => {
      const result = await runArchiveWorker(source, output, new AbortController().signal, undefined, format);
      assert.equal(result.state, 'download-only');
      assert.ok(result.metrics.expandedBytes <= EPUB_LIMITS.entryBytes);
    });
    await withArchive(rawArchive([{ name: 'ratio', data: Buffer.alloc(2 * 1024 * 1024), deflate: true }]), async (source, output) => {
      const result = await runArchiveWorker(source, output, new AbortController().signal, undefined, format);
      assert.equal(result.state, 'download-only');
      assert.ok(result.metrics.expandedBytes > 0);
      assert.ok(result.metrics.expandedBytes <= (await fs.stat(source)).size * EPUB_LIMITS.ratio);
    });
    await withArchive(rawArchive(Array.from({ length: 10001 }, (_, index) => ({ name: `entry-${index}` }))), async (source, output) => {
      const result = await runArchiveWorker(source, output, new AbortController().signal, undefined, format);
      assert.equal(result.state, 'download-only');
      assert.equal(result.metrics.entries, 10000);
    });
    evidence.push({ test: `${format}_binary_archive_rejects_unsafe_entries_and_observes_inflated_bytes`, actualEntryCount: 10001, sizeLie: 'rejected', streamRatio: 'bounded', verdict: 'pass' });
});

test('valid_epub_is_manifest_bounded_and_original_stays_unchanged', async () => {
  await withArchive(await epub(), async (source, output) => {
    const result = await runArchiveWorker(source, output, new AbortController().signal);
    assert.equal(result.state, 'ready');
    assert.equal(result.spine.length, 2);
    assert.deepEqual(result.toc.map(entry => entry.title), ['First section', 'Second section']);
    const first = result.resources.find(resource => resource.resourceId === result.spine[0])!;
    const bytes = await fs.readFile(path.join(output, first.resourceId), 'utf8');
    assert.ok(bytes.includes('First section'));
    assert.ok(bytes.includes('book-resource:'));
    assert.equal(bytes.includes('href="second.xhtml'), false);
    assert.ok(first.textLength! > 0);
    assert.ok(result.metrics.peakTrackedBytes <= 256 * 1024 * 1024);
    evidence.push({ test: 'valid_epub_is_manifest_bounded_and_original_stays_unchanged', spine: 2, resources: result.resources.length, peakTrackedBytes: result.metrics.peakTrackedBytes, verdict: 'pass' });
  });
});

test('unsafe_or_encrypted_renditions_remain_download_only', async () => {
  for (const value of [
    await epub({ package: packageXml.replace('</metadata>', '<meta property="rendition:layout">pre-paginated</meta></metadata>') }),
    await epub({ package: packageXml.replace('id="first" href=', 'id="first" properties="scripted" href=') }),
    await epub({ extra: [{ name: 'encrypted.bin', data: Buffer.from('owned fixture'), password: 'fixture-only-password' }] }),
    await epub({ extra: [{ name: 'META-INF/encryption.xml', data: Buffer.from('<encryption/>') }] }),
  ]) await withArchive(value, async (source, output) => {
    const result = await runArchiveWorker(source, output, new AbortController().signal);
    assert.equal(result.state, 'download-only');
  });
  evidence.push({ test: 'unsafe_or_encrypted_renditions_remain_download_only', verdict: 'pass' });
});

test('epub_two_navigation_and_unused_nested_archives', async () => {
  const ncx = '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><navMap><navPoint id="one"><navLabel><text>First chapter</text></navLabel><content src="first.xhtml"/></navPoint></navMap></ncx>';
  const pack = packageXml.replace('version="3.0"', 'version="2.0"')
    .replace('<manifest>', '<manifest><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>')
    .replace('<spine>', '<spine toc="ncx">')
    .replace(' properties="nav"', '');
  await withArchive(await epub({ package: pack, extra: [
    { name: 'OPS/toc.ncx', data: Buffer.from(ncx) },
    { name: 'unused.zip', data: await epub() },
  ] }), async (source, output) => {
    const result = await runArchiveWorker(source, output, new AbortController().signal);
    assert.equal(result.state, 'ready');
    assert.equal(result.toc[0].title, 'First chapter');
    assert.equal(result.resources.some(resource => resource.mediaType === 'application/zip'), false);
    assert.equal(result.metrics.entries, 9);
  });
  evidence.push({ test: 'epub_two_navigation_and_unused_nested_archives', ncx: 'renderable', nestedExpansion: false, verdict: 'pass' });
});

for (const format of ['epub', 'cbz'] as const) test(`${format}_resource_navigation_is_non_executable_and_handles_are_session_bound`, async () => {
  const bytes = format === 'cbz' ? await buildCbzFixture() : await epub();
  const root = path.resolve('.test-data', 'books-epub', randomUUID());
  await fs.mkdir(root, { recursive: true });
  const oldEnabled = process.env.BOOKS_ENABLED;
  process.env.BOOKS_ENABLED = 'true';
  let version = '"fixture-v1"';
  let declaredSize = bytes.length;
  let stallSource = false;
  let beginOriginal: (() => void) | undefined;
  const libraryId = '163ac435-50a9-4f56-96d0-276edf9303c1';
  const upstream = http.createServer((req, res) => {
    const url = new URL(req.url!, 'http://fixture');
    if (url.pathname === '/api/items/item') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        id: 'item', libraryId, mediaType: 'book',
        libraryFiles: [{ ino: 'ebook', fileType: 'ebook', metadata: {
          filename: `Fixture.${format}`, ext: `.${format}`, size: declaredSize, mtimeMs: 1700000000000,
        } }],
        media: { metadata: { title: 'Reader fixture' }, ebookFile: { ino: 'ebook' }, audioFiles: [], tracks: [], chapters: [] },
      }));
    } else if (url.pathname === '/api/items/item/file/ebook') {
      res.writeHead(200, { 'Content-Type': 'application/epub+zip', 'Content-Length': declaredSize, ETag: version });
      if (stallSource && req.method === 'GET') { res.write(bytes.subarray(0, 1)); beginOriginal?.(); return; }
      res.end(req.method === 'HEAD' ? undefined : bytes);
    } else res.writeHead(404).end();
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  assert.ok(address && typeof address !== 'string');
  const db = new DatabaseService(path.join(root, 'fixture.db'), 'fixture-encryption-key-longer-than-thirty-two');
  db.setSetting('plex_machine_id', 'fixture-machine');
  db.books.setConfig({ enabled: true, providerInstanceId: '', configGeneration: 0,
    origin: `http://127.0.0.1:${address.port}`, libraryId, serverBindingProofId: 'reader-fixture' }, 'synthetic-credential');
  const user = db.createOrUpdatePlexUser({ plexId: 'reader', username: 'Reader', email: 'reader@fixture.invalid', plexToken: 'synthetic', plexAccountToken: 'synthetic' });
  const sessions = [db.createSession(user.id), db.createSession(user.id)];
  const fixtureDb = new Database(path.join(root, 'fixture.db'));
  for (const session of sessions) {
    session.expiresAt = Date.now() + 3 * EPUB_LIMITS.cacheTtlMs;
    fixtureDb.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').run(session.expiresAt, session.id);
  }
  fixtureDb.close();
  class Membership extends PlexService {
    override async validateExactServerMembership() { return { serverToken: 'synthetic', discoveredUrl: '', owned: false }; }
  }
  let now = Date.now();
  const plex = new Membership();
  const catalog = new BooksCatalog(db.books);
  const preparation = new EpubPreparation(db, catalog, new BooksRelay(db, catalog, new BookStreams(), plex), plex, () => now);
  const app = express(); app.use(express.json());
  app.use('/api/books', createBooksRouter(db, { plex, preparation }));
  const server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const appAddress = server.address();
  assert.ok(appAddress && typeof appAddress !== 'string');
  const origin = `http://127.0.0.1:${appAddress.port}`;
  const request = (url: string, method = 'GET', index = 0, body?: object) => fetch(`${origin}/api/books${url}`, {
    method, headers: { Authorization: `Bearer ${sessions[index].token}`, Origin: origin, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  try {
    assert.equal(typeof EpubPreparation, 'function');
    const item = await (await request('/items/item')).json() as BookItem;
    assert.equal(item.read.available, true);
    const file = item.files[0];
    const principal = { userId: user.id, sessionId: sessions[0].id, expiresAt: sessions[0].expiresAt };
    const controller = new AbortController();
    const originalStarted = new Promise<void>(resolve => { beginOriginal = resolve; });
    stallSource = true;
    const cancelled = preparation.prepareReader(principal, {
      itemId: 'item', fileId: file.fileId, contentVersion: file.contentVersion,
    }, controller.signal);
    await originalStarted;
    assert.equal((await request('/items/item/reader', 'POST', 0, { fileId: file.fileId, contentVersion: file.contentVersion })).status, 429);
    controller.abort();
    await assert.rejects(cancelled, { name: 'AbortError' });
    stallSource = false;
    const prepared = await request('/items/item/reader', 'POST', 0, { fileId: file.fileId, contentVersion: file.contentVersion });
    assert.equal(prepared.status, 200);
    const descriptor = await prepared.json() as ReaderDescriptor;
    assert.equal(descriptor.state, 'ready');
    assert.notEqual(descriptor.contentVersion, file.contentVersion);
    const resource = `/readers/${descriptor.readerId}/resources/${descriptor.spine[0]}`;
    for (const method of ['GET', 'HEAD']) {
      const response = await request(resource, method);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'application/octet-stream');
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.match(response.headers.get('content-disposition') ?? '', /^attachment/);
      assert.equal(response.headers.get('cache-control'), 'private, no-store');
      await response.arrayBuffer();
      assert.equal((await request(resource, method, 1)).status, 404);
      assert.equal((await fetch(`${origin}/api/books${resource}`, { method })).status, 401);
    }
    const write = {
      editionId: file.fileId, op: 'claim', contentVersion: descriptor.contentVersion, expectedRevision: 0,
      writerId: 'reader-a', sequence: 1, locator: format === 'cbz' ? {
        kind: 'cbz', page: 2, offset: 0.2, horizontal: 0, policyVersion: descriptor.policyVersion,
      } : {
        kind: 'epub', resourceId: descriptor.spine[0], textOffset: 10, fraction: 0.2, policyVersion: descriptor.policyVersion,
      },
    };
    assert.equal((await request('/items/item/progress/ebook', 'PUT', 0, write)).status, 200);
    assert.equal((await request('/items/item/progress/ebook', 'PUT', 0, {
      ...write, expectedRevision: 1, locator: format === 'cbz'
        ? { ...write.locator, page: 4 } : { ...write.locator, textOffset: 1000000 },
    })).status, 422);
    now += EPUB_LIMITS.handleTtlMs + 1;
    assert.equal((await request(resource)).status, 410);
    const renewed = await (await request('/items/item/reader', 'POST', 0, { fileId: file.fileId, contentVersion: file.contentVersion })).json() as ReaderDescriptor;
    const pinned = await preparation.readResource(principal, renewed.readerId, renewed.spine[0], new AbortController().signal);
    now += EPUB_LIMITS.cacheTtlMs;
    const busy = await request('/items/item/reader', 'POST', 0, { fileId: file.fileId, contentVersion: file.contentVersion });
    assert.equal(busy.status, 429);
    const closed = new Promise<void>(resolve => pinned.once('close', resolve));
    pinned.destroy(); await closed;
    const rebuilt = await request('/items/item/reader', 'POST', 0, { fileId: file.fileId, contentVersion: file.contentVersion });
    assert.equal(rebuilt.status, 200);
    const rebuiltReader = await rebuilt.json() as ReaderDescriptor;
    assert.equal(rebuiltReader.contentVersion, descriptor.contentVersion);
    version = '"fixture-v2"';
    assert.equal((await request(`/readers/${rebuiltReader.readerId}/resources/${rebuiltReader.spine[0]}`)).status, 409);
    declaredSize = EPUB_LIMITS.compressedBytes + 1;
    const oversized = await (await request('/items/item')).json() as BookItem;
    assert.equal((await request('/items/item/reader', 'POST', 0, {
      fileId: oversized.files[0].fileId, contentVersion: oversized.files[0].contentVersion,
    })).status, 413);
    db.deleteSession(sessions[0].token);
    assert.equal((await request(resource)).status, 401);
    evidence.push({ test: `${format}_resource_navigation_is_non_executable_and_handles_are_session_bound`, get: true, head: true, replacement: 409, foreignSession: 404, verdict: 'pass' });
  } finally {
    db.close();
    for (const service of [server, upstream]) {
      service.closeAllConnections();
      await new Promise<void>(resolve => service.close(() => resolve()));
    }
    if (oldEnabled === undefined) delete process.env.BOOKS_ENABLED; else process.env.BOOKS_ENABLED = oldEnabled;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('preparation_is_cancellable_and_has_an_external_thirty_second_watchdog', { timeout: 40000 }, async () => {
  await withArchive(await epub(), async (source, output) => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(runArchiveWorker(source, output, controller.signal), { name: 'AbortError' });
    const active = new AbortController();
    const pending = runArchiveWorker(source, output, active.signal, () => new Worker('setInterval(() => {}, 1000)', { eval: true }));
    setTimeout(() => active.abort(), 100);
    await assert.rejects(pending, { name: 'AbortError' });
    const start = performance.now();
    const result = await runArchiveWorker(source, output, new AbortController().signal, () =>
      new Worker('setInterval(() => {}, 1000)', { eval: true, resourceLimits: { maxOldGenerationSizeMb: 256 } }));
    const elapsed = performance.now() - start;
    assert.equal(result.state, 'download-only');
    assert.ok(elapsed >= 29000 && elapsed < 35000);
    assert.equal(EPUB_LIMITS.timeoutMs, 30000);
    evidence.push({ test: 'preparation_is_cancellable_and_has_an_external_thirty_second_watchdog', elapsedMs: elapsed, verdict: 'pass' });
  });
});

after(async () => {
  const output = process.env.BOOKS_PROOF_DIR;
  if (!output) return;
  const relative = path.relative(process.cwd(), path.resolve(output));
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, 'epub-worker-verdict.json'), JSON.stringify({
    schemaVersion: 1, cases: evidence, verdict: evidence.length === 10 ? 'pass' : 'blocked', node: process.version,
  }, null, 2));
});
