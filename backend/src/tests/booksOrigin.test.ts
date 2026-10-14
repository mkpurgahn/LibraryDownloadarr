import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

for (const [value, expected] of [
  ['', ''], ['https://books.example.test', 'https://books.example.test'],
  ['https://BOOKS.example.test:443/', 'https://books.example.test'],
  ['https://books.example.test:8443', 'https://books.example.test:8443'],
] as const) {
  test(`canonical_application_origin_normalizes_${value || 'unset'}`, () => {
    const result = spawnSync(process.execPath, ['-e',
      `process.stdout.write(JSON.stringify(require(${JSON.stringify(require.resolve('../config'))}).config.server.publicOrigin))`],
    { env: { ...process.env, APP_PUBLIC_ORIGIN: value }, encoding: 'utf8' });
    assert.equal(result.status, 0);
    assert.equal(JSON.parse(result.stdout), expected);
  });
}

for (const value of [
  'http://books.example.test', '*', 'null', 'https://name:password@books.example.test',
  'https://books.example.test/extra', 'https://books.example.test?query=1',
  'https://books.example.test#fragment', 'https://one.test,https://two.test',
]) {
  test(`canonical_application_origin_rejects_${value}`, () => {
    const result = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(require.resolve('../config'))})`],
      { env: { ...process.env, APP_PUBLIC_ORIGIN: value }, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /APP_PUBLIC_ORIGIN must be an (?:absolute )?HTTPS origin/);
  });
}
