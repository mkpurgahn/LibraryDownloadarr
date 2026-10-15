import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { AbsClient } from '../books/absClient';

const clientAt = (origin: string) => new AbsClient({
  enabled: true, providerInstanceId: 'generated-provider', configGeneration: 1,
  origin, libraryId: 'generated-library', serverBindingProofId: 'generated-binding',
}, 'generated-credential', { fileId: () => 'unused' });

for (const length of [undefined, '1', '262144']) {
  test(`metadata_remaining_budget_is_enforced_on_chunks_content_length_${length}`, async () => {
    const client = clientAt('http://127.0.0.1:1');
    const response = new http.IncomingMessage(new net.Socket());
    response.statusCode = 200;
    if (length) response.headers['content-length'] = length;
    const budget = { bytes: 33554432 - 131072, requests: 0 };
    let produced = 0;
    response._read = () => {
      setImmediate(() => {
        if (response.destroyed) return;
        if (produced === 4) { response.push(null); return; }
        produced++;
        response.push(Buffer.alloc(65536, ' '));
      });
    };
    // A stream-level fixture also exercises a misleading header independently of HTTP framing.
    await assert.rejects(Reflect.apply(client['body'], client, [response, 8388608, budget]),
      { code: 'BOOKS_CATEGORY_CAPACITY', status: 503 });
    assert.equal(response.destroyed, true);
    assert.ok(budget.bytes <= 33554432, 'No over-budget chunk is accepted into the body buffers');
    if (length !== '262144') {
      assert.equal(budget.bytes, 33554432);
      assert.ok(produced <= 3, 'Stop at the first over-budget transport chunk, not the whole response');
    } else assert.equal(produced, 0, 'An honest oversized header is rejected before reading');
  });
}

test('metadata_aggregate_budget_counts_accepted_bytes_and_terminates_the_crossing_http_response', async t => {
  const responseBytes = 6 * 1024 * 1024;
  const body = Buffer.from(`{"padding":"${'x'.repeat(responseBytes - 14)}"}`);
  assert.equal(body.length, responseBytes);
  let requests = 0;
  let completed = 0;
  let sent = 0;
  let terminated!: () => void;
  const closed = new Promise<void>(resolve => { terminated = resolve; });
  const server = http.createServer((_req, res) => {
    requests++;
    res.setHeader('Content-Type', 'application/json');
    res.once('close', () => { if (!res.writableFinished) terminated(); });
    void (async () => {
      for (let offset = 0; offset < body.length && !res.destroyed; offset += 65536) {
        const chunk = body.subarray(offset, offset + 65536);
        res.write(chunk); sent += chunk.length;
        await delay(1);
      }
      if (!res.destroyed) { completed++; res.end(); }
    })();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const client = clientAt(`http://127.0.0.1:${address.port}`);
  const budget = { bytes: 0, requests: 0 };
  try {
    for (let i = 0; i < 5; i++) await client['json']('/page', new AbortController().signal, budget);
    assert.equal(budget.bytes, 31457280);
    await assert.rejects(client['json']('/page', new AbortController().signal, budget),
      { code: 'BOOKS_CATEGORY_CAPACITY' });
    await Promise.race([closed, delay(750).then(() => assert.fail('Upstream was not terminated promptly'))]);
    assert.equal(requests, 6);
    assert.equal(completed, 5, 'The sixth response must not complete');
    assert.ok(budget.bytes <= 33554432);
    assert.ok(budget.bytes >= 33554432 - 65536, 'Stop on the crossing chunk, not an arbitrary lower cap');
    assert.ok(sent < responseBytes * 6, 'Do not consume the entire over-budget response');
    t.diagnostic(JSON.stringify({ acceptedBytes: budget.bytes, sentBytes: sent, requests, completed,
      qualification: 'Accepted buffers are bounded; transport/socket buffers can receive an overrun chunk.' }));
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('metadata_exhausted_budget_does_not_open_another_request', async () => {
  const client = clientAt('http://127.0.0.1:1');
  await assert.rejects(client['json']('/must-not-request', new AbortController().signal,
    { bytes: 33554432, requests: 5 }), { code: 'BOOKS_CATEGORY_CAPACITY' });
});

test('metadata_per_response_ceiling_remains_distinct_from_aggregate_capacity', async () => {
  const client = clientAt('http://127.0.0.1:1');
  const response = new http.IncomingMessage(new net.Socket());
  response.statusCode = 200;
  response.headers['content-length'] = '8388609';
  const budget = { bytes: 0, requests: 0 };
  await assert.rejects(Reflect.apply(client['body'], client, [response, 8388608, budget]),
    { code: 'ABS_RESPONSE_TOO_LARGE', status: 502 });
  assert.equal(budget.bytes, 0);
  assert.equal(response.destroyed, true);
});
