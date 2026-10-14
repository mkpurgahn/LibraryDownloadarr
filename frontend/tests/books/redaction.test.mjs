import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { redactProofs } from '../../tools/redact-books-proofs.mjs';

test('retained browser diagnostics remove credentials and capability URLs', async () => {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const root = path.join(repo, '.test-data', 'books', `redaction-${randomUUID()}`);
  await fs.mkdir(root, { recursive: true });
  try {
    await fs.writeFile(path.join(root, 'error-context.md'),
      'Save file: /api/books/downloads/fixture-capability\nResource: /api/books/readers/fixture-reader/resources/fixture-resource\nAuthorization: Bearer fixture-session-token\n');
    await fs.writeFile(path.join(root, 'run.json'), JSON.stringify({
      cookie: 'fixture-cookie-value', Authorization: 'fixture-header-value',
      url: '/api/books/downloads/fixture-capability', title: 'Safe fixture title', count: 3,
    }));
    await redactProofs(root);
    const markdown = await fs.readFile(path.join(root, 'error-context.md'), 'utf8');
    const json = JSON.parse(await fs.readFile(path.join(root, 'run.json'), 'utf8'));
    for (const value of ['fixture-capability', 'fixture-reader', 'fixture-resource', 'fixture-session-token']) assert.equal(markdown.includes(value), false);
    assert.equal(JSON.stringify(json).includes('fixture-cookie-value'), false);
    assert.equal(JSON.stringify(json).includes('fixture-header-value'), false);
    assert.equal(json.title, 'Safe fixture title');
    assert.equal(json.count, 3);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
