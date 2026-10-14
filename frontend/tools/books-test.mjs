import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { redactProofs } from './redact-books-proofs.mjs';

const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(frontend, '..');
const temporary = path.join(root, '.test-data', 'books', 'tmp');
mkdirSync(temporary, { recursive: true });
const args = process.argv.slice(2);
if (args.some(arg => ['--headed', '--debug', '--ui', '--config'].some(flag => arg === flag || arg.startsWith(`${flag}=`))) ||
    (process.env.PWDEBUG && process.env.PWDEBUG !== '0')) {
  throw new Error('Books automated testing is headless only');
}
const runId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
const proofRoot = process.env.BOOKS_PROOF_DIR ?? path.join(root, '.test-data', 'books', 'results');
const relative = path.relative(root, path.resolve(proofRoot));
if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Books proof must stay inside its execution root');
const require = createRequire(import.meta.url);
const cli = path.join(path.dirname(require.resolve('@playwright/test')), 'cli.js');
const command = args[0] === 'install' ? args : ['test', '--config', 'playwright.books.config.ts', ...args];
const environment = {
  ...process.env, TEMP: temporary, TMP: temporary, TMPDIR: temporary,
  PLAYWRIGHT_BROWSERS_PATH: path.join(root, '.test-data', 'books', 'browsers'),
  BOOKS_TEST_RUN_ID: runId,
};
if (command[0] === 'test') {
  if (process.versions.node.split('.')[0] !== '20' || !process.env.npm_execpath) {
    throw new Error('Run Books fixture tests through npm with Node 20, matching the backend runtime.');
  }
  for (const packageRoot of [path.join(root, 'backend'), frontend]) {
    const build = spawn(process.execPath, [process.env.npm_execpath, '--prefix', packageRoot, 'run', 'build'], {
      cwd: root, stdio: 'inherit', env: environment,
    });
    const code = await new Promise((resolve, reject) => {
      build.once('error', reject); build.once('exit', code => resolve(code ?? 1));
    });
    if (code !== 0) process.exit(code);
  }
}
const child = spawn(process.execPath, [cli, ...command], {
  cwd: frontend, stdio: 'inherit',
  env: environment,
});
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('close', async code => {
  try {
    if (command[0] === 'test') await redactProofs(path.join(proofRoot, runId));
    process.exitCode = code ?? 1;
  } catch {
    console.error('Books proof redaction failed; diagnostics must not be shared before repair.');
    process.exitCode = 1;
  }
});
