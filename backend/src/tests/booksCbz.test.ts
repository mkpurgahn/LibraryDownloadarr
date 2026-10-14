import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import test from 'node:test';
import { runArchiveWorker } from '../books/epub/prepare';
import { buildCbzFixture, comicPanel } from '../books/proof/cbzFixture';

const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
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
      }));
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
