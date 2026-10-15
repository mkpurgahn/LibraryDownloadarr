import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { MessageChannel, Worker } from 'node:worker_threads';
import test, { after } from 'node:test';
import sharp from 'sharp';
import { runArchiveWorker } from '../books/epub/prepare';
import { ArchiveBudget, CBZ_LIMITS, EPUB_LIMITS } from '../books/epub/manifest';
import { progressLocator } from '../books/progressTypes';
import { animatedComicPanel, buildCbzFixture, buildLargeCbzFixture, comicPanel } from '../books/proof/cbzFixture';

const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const evidence: Array<Record<string, unknown>> = [];
async function prepare(bytes: Buffer, inspect: (result: Awaited<ReturnType<typeof runArchiveWorker>>, output: string) => Promise<void>) {
  const root = path.resolve('.test-data', 'books-cbz', randomUUID());
  await fs.mkdir(root, { recursive: true });
  const source = path.join(root, 'original.cbz');
  const output = path.join(root, 'pages');
  await fs.writeFile(source, bytes);
  try {
    const result = await runArchiveWorker(source, output, new AbortController().signal, () =>
      new Worker(path.resolve('dist', 'books', 'epub', 'worker.js'), {
        workerData: { source, output, format: 'cbz' }, env: {},
        resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
      }), 'cbz');
    await inspect(result, output);
    assert.equal(hash(await fs.readFile(source)), hash(bytes));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}

test('CBZ prepares every numbered raster page in natural order, never cover artwork', async () => {
  await prepare(await buildCbzFixture(), async (result, output) => {
    assert.equal(result.state, 'ready');
    assert.deepEqual(result.spine, ['Pages/1.png', 'Pages/2.png', 'Pages/10.png'].map(hash));
    assert.equal(result.resources.length, 3);
    for (const [index, number] of [1, 2, 10].entries()) {
      assert.equal(hash(await fs.readFile(path.join(output, result.spine[index]))), hash(comicPanel(number)));
    }
  });
});

test('CBZ larger than the reported 168636333-byte original prepares from disk within existing worker bounds', { timeout: 60000 }, async () => {
  const bytes = await buildLargeCbzFixture();
  assert.ok(bytes.length > 168636333, 'Generated original must exceed the actual reported file size');
  await prepare(bytes, async (result, output) => {
    assert.equal(result.state, 'ready', JSON.stringify(result));
    assert.equal(result.resources.length, 243);
    assert.deepEqual(result.spine, Array.from({ length: 243 }, (_, index) => hash(`Pages/${index + 1}.png`)));
    assert.ok(result.metrics.peakTrackedBytes <= 256 * 1024 * 1024);
    assert.ok(result.metrics.expandedBytes <= 512 * 1024 * 1024);
    assert.ok(result.metrics.expandedBytes > 171043415, 'Generated expanded content must exceed the reported directory total');
    assert.ok(result.metrics.elapsedMs < 30000);
    assert.equal(result.metrics.decoderConcurrency, 1);
    assert.equal(result.metrics.decoderCacheMemoryMiB, 0);
    assert.equal(hash(await fs.readFile(path.join(output, result.spine[0]))), hash(comicPanel(1, 1, 960, 600, 0)));
    assert.equal(hash(await fs.readFile(path.join(output, result.spine[242]))), hash(comicPanel(2, 1, 480, 512, 0)));
    evidence.push({ case: 'above-actual-reported-original-size', reportedOriginalBytes: 168636333,
      generatedArchiveBytes: bytes.length, ...result.metrics,
      qualification: 'Generated243-page archive, not the user original; tracked worker budget is not a universal process-RSS bound.' });
  });
});

test('CBZ has a separate bounded archive allowance while EPUB and cache budgets stay unchanged', async () => {
  assert.doesNotThrow(() => new ArchiveBudget(256 * 1024 * 1024, undefined, 'cbz'));
  assert.throws(() => new ArchiveBudget(256 * 1024 * 1024 + 1, undefined, 'cbz'), { status: 413, code: 'CBZ_TOO_LARGE' });
  assert.doesNotThrow(() => new ArchiveBudget(100 * 1024 * 1024));
  assert.throws(() => new ArchiveBudget(100 * 1024 * 1024 + 1), { status: 413, code: 'EPUB_TOO_LARGE' });
  assert.equal(EPUB_LIMITS.cacheBytes - EPUB_LIMITS.expandedBytes - CBZ_LIMITS.compressedBytes, 256 * 1024 * 1024);
  const root = path.resolve('.test-data', 'books-cbz-oversize', randomUUID());
  await fs.mkdir(root, { recursive: true });
  const source = path.join(root, 'oversize.cbz');
  const file = await fs.open(source, 'wx');
  await file.truncate(256 * 1024 * 1024 + 1);
  await file.close();
  let started = false;
  try {
    await assert.rejects(runArchiveWorker(source, path.join(root, 'pages'), new AbortController().signal, () => {
      started = true;
      throw new Error('Oversized original must not start a worker');
    }, 'cbz'), { status: 413, code: 'CBZ_TOO_LARGE' });
    assert.equal(started, false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('CBZ mixed corrupt, encrypted, unsupported or ambiguous pages reject the whole original', async () => {
  for (const extra of [
    { name: '2.png', data: Buffer.from('not a PNG') },
    { name: '2.svg', data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>') },
    { name: '2.html', data: Buffer.from('<img src="https://fixture.invalid/page">') },
    { name: '2.gif', data: Buffer.from('GIF89a') },
    { name: '1.PNG', data: comicPanel(2) },
    { name: '2.png', data: comicPanel(2), password: 'generated-test-password' },
  ]) await prepare(await buildCbzFixture([{ name: '1.png', data: comicPanel(1) }, extra]), async result => {
    assert.equal(result.state, 'download-only', extra.name);
    assert.equal(result.resources.length, 0);
    assert.match(result.reason ?? '', /CBZ/);
  });
});

test('CBZ order is deterministic for folders, case, Unicode and numeric leading zeroes', async () => {
  const names = ['z/1.png', 'é/10.png', 'A/10.png', 'a/01.png', 'a/2.png', 'a/1.png', 'é/2.png'];
  await prepare(await buildCbzFixture(names.map(name => ({ name, data: comicPanel(1) }))), async result => {
    assert.equal(result.state, 'ready');
    assert.deepEqual(result.spine, ['a/1.png', 'a/01.png', 'a/2.png', 'A/10.png', 'z/1.png', 'é/2.png', 'é/10.png'].map(hash));
  });
});

test('CBZ rejects animated PNG, truncated pixels, extension spoofing and nested archives', async () => {
  for (const entry of [
    { name: '1.png', data: animatedComicPanel() },
    { name: '1.png', data: comicPanel(1).subarray(0, 180) },
    { name: '1.jpg', data: comicPanel(1) },
    { name: 'nested.cbz', data: await buildCbzFixture() },
  ]) await prepare(await buildCbzFixture([entry]), async result => {
    assert.equal(result.state, 'download-only', entry.name);
    assert.equal(result.spine.length, 0);
  });
});

test('CBZ validates JPEG and WebP pixels and ignores only known metadata junk', async () => {
  const png = comicPanel(1);
  const jpeg = await sharp(png).jpeg().toBuffer();
  const webp = await sharp(png).webp().toBuffer();
  await prepare(await buildCbzFixture([
    { name: '1.jpeg', data: jpeg }, { name: '2.webp', data: webp },
    { name: '__MACOSX/._1.jpeg', data: Buffer.from('generated junk') },
    { name: 'ComicInfo.xml', data: Buffer.from('<unparsed metadata/>') },
    { name: '.DS_Store', data: Buffer.from('generated junk') },
  ]), async (result, output) => {
    assert.equal(result.state, 'ready');
    assert.deepEqual(result.resources.map(resource => [resource.mediaType, resource.width, resource.height]),
      [['image/jpeg', 480, 720], ['image/webp', 480, 720]]);
    assert.equal((await fs.readdir(output)).length, 2);
  });
});

test('CBZ pixel and side limits apply at their actual thresholds', async () => {
  for (const [width, height, state] of [
    [4000, 4000, 'ready'], [4001, 4000, 'download-only'], [8192, 1, 'ready'], [8193, 1, 'download-only'],
  ] as const) {
    const png = await sharp({ create: { width, height, channels: 3, background: '#ddcfa5' } }).png().toBuffer();
    await prepare(await buildCbzFixture([{ name: '1.png', data: png }]), async result => {
      assert.equal(result.state, state, `${width}x${height}`);
      assert.ok(result.metrics.peakTrackedBytes <= 256 * 1024 * 1024);
      if (state === 'ready') {
        assert.equal(result.metrics.decoderConcurrency, 1);
        assert.equal(result.metrics.decoderCacheMemoryMiB, 0);
        assert.ok(result.metrics.peakProcessRssBytes! > 0);
      }
      evidence.push({ case: 'raster-boundary', width, height, state, ...result.metrics });
    });
  }
});

test('CBZ page count is bounded without silently omitting pages', { timeout: 30000 }, async () => {
  const png = comicPanel(1, 1, 1, 1);
  for (const count of [1000, 1001]) {
    await prepare(await buildCbzFixture(Array.from({ length: count }, (_, index) =>
      ({ name: `${index + 1}.png`, data: png }))), async result => {
      assert.equal(result.state, count === 1000 ? 'ready' : 'download-only');
      assert.equal(result.resources.length, count === 1000 ? 1000 : 0);
      evidence.push({ case: 'page-boundary', count, state: result.state, ...result.metrics });
    });
  }
});

test('CBZ metadata names used as folders cannot hide a damaged declared page', async () => {
  await prepare(await buildCbzFixture([
    { name: '1.png', data: comicPanel(1) },
    { name: 'ComicInfo.xml/2.png', data: Buffer.from('damaged page') },
  ]), async result => { assert.equal(result.state, 'download-only'); });
});

test('CBZ malformed ZIP, CRC damage and NFC duplicates cannot yield partial success', async () => {
  const crc = await buildCbzFixture([{ name: '1.png', data: comicPanel(1) }]);
  const pixel = crc.indexOf(Buffer.from('IDAT'));
  assert.ok(pixel > 0);
  crc[pixel + 5] ^= 1;
  for (const bytes of [
    Buffer.from('not a ZIP'), crc, (await buildCbzFixture()).subarray(0, 100),
    await buildCbzFixture([
      { name: 'e\u0301/1.png', data: comicPanel(1) }, { name: '\u00e9/1.png', data: comicPanel(2) },
    ]),
  ]) await prepare(bytes, async result => {
    assert.equal(result.state, 'download-only');
    assert.deepEqual(result.spine, []);
    assert.deepEqual(result.resources, []);
  });
});

test('CBZ locator rejects invalid values before prepared-manifest validation', () => {
  const locator = { kind: 'cbz', page: 1, offset: 0, horizontal: 0, policyVersion: 'cbz-pages-v1' };
  for (const changed of [
    { page: 0 }, { page: 1001 }, { page: 1.5 }, { page: Infinity }, { offset: -1 }, { offset: 1.01 },
    { horizontal: NaN }, { horizontal: 2 }, { readerId: 'transient-handle' },
  ]) assert.throws(() => progressLocator({ ...locator, ...changed }), { code: 'INVALID_BOOKS_REQUEST' });
  assert.deepEqual(progressLocator({ ...locator, page: 1000, offset: 1, horizontal: 1 }),
    { ...locator, page: 1000, offset: 1, horizontal: 1 });
});

test('CBZ real preparation cancellation terminates the worker before cleanup and permits a fresh preparation', async () => {
  const root = path.resolve('.test-data', 'books-cbz-cancel', randomUUID());
  await fs.mkdir(root, { recursive: true });
  const source = path.join(root, 'original.cbz'); const output = path.join(root, 'pages');
  const panel = await sharp({ create: { width: 4000, height: 4000, channels: 3, background: '#cdd9bb' } }).png().toBuffer();
  await fs.writeFile(source, await buildCbzFixture(Array.from({ length: 100 }, (_, index) => ({ name: `${index}.png`, data: panel }))));
  let exited = false;
  let timer: NodeJS.Timeout | undefined;
  const controller = new AbortController();
  const start = performance.now();
  try {
    await assert.rejects(runArchiveWorker(source, output, controller.signal, () => {
      const worker = new Worker(path.resolve('dist', 'books', 'epub', 'worker.js'), {
        workerData: { source, output, format: 'cbz' }, env: {},
        resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
      });
      worker.once('exit', () => { exited = true; });
      worker.once('online', () => { timer = setTimeout(() => controller.abort(), 150); });
      return worker;
    }, 'cbz'), { name: 'AbortError' });
    assert.equal(exited, true);
    assert.ok(performance.now() - start < 5000);
    evidence.push({ case: 'real-cbz-worker-abort', exited, elapsedMs: performance.now() - start });
  } finally { clearTimeout(timer); await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
  await prepare(await buildCbzFixture(), async result => { assert.equal(result.state, 'ready'); });
});

test('CBZ cooperatively cancels after observing an active native raster decode', async () => {
  const root = path.resolve('.test-data', 'books-cbz-native-cancel', randomUUID());
  await fs.mkdir(root, { recursive: true });
  const source = path.join(root, 'original.cbz'); const output = path.join(root, 'pages');
  const panel = await sharp({ create: { width: 4000, height: 4000, channels: 3, background: '#dedac1' } }).png().toBuffer();
  await fs.writeFile(source, await buildCbzFixture([1, 2, 3].map(index => ({ name: `${index}.png`, data: panel }))));
  const phase = new MessageChannel();
  const controller = new AbortController();
  let nativeProcessCount = 0;
  let exited = false;
  let observedAt = 0;
  phase.port1.once('message', (count: number) => {
    nativeProcessCount = count; observedAt = performance.now(); controller.abort();
  });
  try {
    await assert.rejects(runArchiveWorker(source, output, controller.signal, () => {
      const worker = new Worker(`
        const { workerData } = require('node:worker_threads');
        const sharp = require(${JSON.stringify(require.resolve('sharp'))});
        const original = sharp.prototype.toBuffer;
        sharp.prototype.toBuffer = function(...args) {
          const result = original.apply(this, args);
          const sample = setInterval(() => {
            const count = sharp.counters().process;
            if (count > 0) { clearInterval(sample); workerData.phase.postMessage(count); }
          }, 1);
          result.finally(() => clearInterval(sample)).catch(() => {});
          return result;
        };
        require(${JSON.stringify(path.resolve('dist', 'books', 'epub', 'worker.js'))});
      `, {
        eval: true, workerData: { source, output, format: 'cbz', phase: phase.port2 }, transferList: [phase.port2],
        env: {}, resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
      });
      worker.once('exit', () => { exited = true; });
      return worker;
    }, 'cbz'), { name: 'AbortError' });
    assert.ok(nativeProcessCount > 0);
    assert.equal(exited, true);
    assert.ok(performance.now() - observedAt < 5000);
    evidence.push({ case: 'observed-native-decode-abort', nativeProcessCount, exited,
      afterSignalMs: performance.now() - observedAt,
      scope: 'Representative PNG with native process counter observed before abort; not a universal native execution deadline.' });
  } finally {
    phase.port1.close(); phase.port2.close();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
  await prepare(await buildCbzFixture(), async result => { assert.equal(result.state, 'ready'); });
});

after(async () => {
  const output = path.resolve('.test-data', 'books-cbz-metrics.json');
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, JSON.stringify({
    node: process.version, platform: process.platform, sharp: sharp.versions.sharp, libvips: sharp.versions.vips,
    measurement: 'Sampled whole-process RSS includes native memory and host test overhead; not a hard bound or measured peak between samples.',
    evidence,
  }, null, 2));
});
