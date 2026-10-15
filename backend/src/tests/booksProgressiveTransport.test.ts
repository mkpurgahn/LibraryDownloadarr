import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { RangeInterrupted, RangeSpool } from '../books/epub/rangeSpool';

async function transport(partial = false, weak = false) {
  const root = path.resolve('.test-data', 'progressive-transport', randomUUID());
  await fs.mkdir(root, { recursive: true });
  const file = await fs.open(path.join(root, 'source'), 'wx+', 0o600);
  const size = 1024 * 1024;
  await file.truncate(size);
  let requests = 0;
  const etag = weak ? 'W/"stable"' : '"stable"';
  const modified = weak ? 'Wed, 01 Jan 2020 00:00:00 GMT' : undefined;
  const server = http.createServer((req, res) => {
    requests++;
    assert.equal(req.headers['if-range'], modified ?? etag);
    const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '')!;
    assert.ok(range);
    const start = Number(range[1]), end = Number(range[2]) + 1;
    assert.ok(end - start <= 256 * 1024);
    res.writeHead(206, { ETag: etag, ...(modified ? { 'Last-Modified': modified } : {}), 'Content-Range': `bytes ${start}-${end - 1}/${size}`,
      'Content-Length': String(end - start) });
    if (partial) res.write(Buffer.alloc(192 * 1024, 3));
    else res.end(Buffer.alloc(end - start, 3));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const controller = new AbortController();
  const spool = new RangeSpool(file, { size, etag, lastModified: modified, ranges: true },
    (signal, range, ifRange) => new Promise((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${address.port}`, {
        signal, headers: { ...(range ? { Range: range } : {}), ...(ifRange ? { 'If-Range': ifRange } : {}) },
      }, res => { res.on('error', () => {}); resolve(res); });
      req.once('error', reject);
    }), controller.signal);
  return {
    spool, requests: () => requests,
    async close() {
      controller.abort(); server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await file.close(); await fs.rm(root, { recursive: true, force: true });
    },
  };
}

test('interrupted chunks consume the same finite body allowance without committing incomplete coverage', { timeout: 15000 }, async () => {
  const f = await transport(true);
  try {
    let rejected = false;
    for (let i = 0; i < 200 && !rejected; i++) {
      const before = f.spool.receivedBytes;
      let settled = false;
      const result = f.spool.ensure(0, 256 * 1024).then(() => {
        settled = true; throw new Error('Held incomplete range must not commit');
      }, error => { settled = true; return error; });
      while (!settled && f.spool.receivedBytes < before + 192 * 1024) await new Promise(resolve => setImmediate(resolve));
      if (!settled) f.spool.interrupt();
      const error: unknown = await result;
      if (!(error instanceof RangeInterrupted)) {
        assert.ok(error instanceof Error && 'code' in error && error.code === 'CBZ_RANGE_BUDGET');
        rejected = true;
      }
    }
    assert.equal(rejected, true);
    assert.deepEqual(f.spool.coverage, []);
    assert.ok(f.spool.receivedBytes <= 1024 * 1024 + 16 * 1024 * 1024, 'Do not request another block beyond remaining body allowance');
    assert.ok(f.spool.receivedBytes > 16 * 1024 * 1024, 'Exercise the actual cumulative allowance, not only metadata');
  } finally { await f.close(); }
});

test('the8193rd range is rejected without a provider request and committed ranges are not fetched twice', { timeout: 60000 }, async () => {
  const f = await transport();
  try {
    for (let i = 0; i < 8192; i++) await f.spool.ensure(i * 2, i * 2 + 1);
    assert.equal(f.requests(), 8192);
    assert.deepEqual(await f.spool.read(0, 1), Buffer.from([3]));
    assert.equal(f.requests(), 8192);
    await assert.rejects(f.spool.ensure(16384, 16385), { code: 'CBZ_RANGE_BUDGET' });
    assert.equal(f.requests(), 8192);
  } finally { await f.close(); }
});

test('weak ETags never become If-Range validators; a stable Last-Modified date is used instead', async () => {
  const f = await transport(false, true);
  try {
    assert.equal(f.spool.mode, 'range');
    assert.deepEqual(await f.spool.read(0, 5), Buffer.alloc(5, 3));
    assert.equal(f.requests(), 1);
  } finally { await f.close(); }
});
