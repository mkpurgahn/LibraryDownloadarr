import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import https from 'node:https';
import { Readable } from 'node:stream';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { streamFixtureDownload } from '../books/proof/verifyAbs';

test('proof_downloads_are_streamed_resumed_and_hashed_from_disk', { timeout: 30000 }, async () => {
  const root = path.resolve('.test-data', 'books-proof', randomUUID());
  await fs.mkdir(root, { recursive: true });
  const certPath = path.join(root, 'cert.pem'); const keyPath = path.join(root, 'key.pem');
  if (process.env.BOOKS_PROOF_TLS_CERT_FILE && process.env.BOOKS_PROOF_TLS_KEY_FILE) {
    await Promise.all([fs.copyFile(process.env.BOOKS_PROOF_TLS_CERT_FILE, certPath), fs.copyFile(process.env.BOOKS_PROOF_TLS_KEY_FILE, keyPath)]);
  } else {
    await promisify(execFile)('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', keyPath, '-out', certPath]);
  }
  const cert = await fs.readFile(certPath);
  const chunk = Buffer.alloc(65536, 71); const size = 32 * 1024 * 1024;
  const hash = createHash('sha256');
  for (let index = 0; index < size / chunk.length; index++) hash.update(chunk);
  const expected = hash.digest('hex');
  const server = https.createServer({ cert, key: await fs.readFile(keyPath) }, (req, res) => {
    const range = /^bytes=(\d+)-$/.exec(req.headers.range ?? '');
    const start = range ? Number(range[1]) : 0;
    res.writeHead(range ? 206 : 200, { 'Content-Length': String(size - start), 'Content-Type': 'application/octet-stream',
      ...(range ? { 'Content-Range': `bytes ${start}-${size - 1}/${size}` } : {}) });
    const source = Readable.from((function* () {
      for (let offset = start; offset < size;) {
        const bytes = chunk.subarray(0, Math.min(chunk.length, size - offset));
        offset += bytes.length; yield bytes;
      }
    })());
    res.once('close', () => source.destroy()); source.pipe(res);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const url = new URL(`https://127.0.0.1:${address.port}/original`);
  try {
    const full = await streamFixtureDownload(url, cert, path.join(root, 'full.bin'), { expectedBytes: size });
    assert.equal(full.status, 200); assert.equal(full.savedBytes, size); assert.equal(full.sha256, expected);
    assert.ok(full.peakChunkBytes <= 65536);
    const resumedPath = path.join(root, 'resumed.bin');
    await fs.writeFile(resumedPath, chunk.subarray(0, 8192), { flag: 'wx' });
    const resumed = await streamFixtureDownload(url, cert, resumedPath, {
      expectedBytes: size - 8192, append: true, headers: { Range: 'bytes=8192-' },
    });
    assert.equal(resumed.status, 206); assert.equal(resumed.savedBytes, size); assert.equal(resumed.sha256, expected);
    assert.equal(resumed.receivedBytes, size - 8192);
    assert.ok(resumed.peakChunkBytes <= 65536);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  }
});
