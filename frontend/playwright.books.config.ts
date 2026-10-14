import { defineConfig } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const frontend = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(frontend, '..');
const proofRoot = process.env.BOOKS_PROOF_DIR ?? path.join(root, '.test-data', 'books', 'results');
const relative = path.relative(root, path.resolve(proofRoot));
const runId = process.env.BOOKS_TEST_RUN_ID;
if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !runId || !/^[0-9]+-[a-f0-9]{8}$/.test(runId)) {
  throw new Error('Run Books tests through npm run test:books with an execution-root proof directory');
}
if (process.argv.some(arg => ['--headed', '--debug', '--ui'].includes(arg)) ||
    (process.env.PWDEBUG && process.env.PWDEBUG !== '0')) throw new Error('Books tests must remain headless');

export default defineConfig({
  testDir: path.join(frontend, 'tests', 'books'),
  testMatch: '**/*.spec.ts',
  outputDir: path.join(proofRoot, runId, 'playwright'),
  workers: 1,
  fullyParallel: false,
  timeout: 45000,
  expect: { timeout: 10000 },
  retries: 0,
  reporter: [['list']],
  use: {
    headless: true,
    trace: 'off',
    video: 'off',
    screenshot: 'off',
    acceptDownloads: true,
    serviceWorkers: 'block',
    launchOptions: { downloadsPath: path.join(root, '.test-data', 'books', 'downloads') },
  },
  projects: ['chromium', 'firefox', 'webkit'].flatMap(browserName =>
    [
      { suffix: 'desktop', viewport: { width: 1280, height: 800 } },
      { suffix: 'narrow', viewport: { width: 390, height: 844 } },
    ].map(({ suffix, viewport }) => ({
      name: `${browserName}-${suffix}`,
      use: { browserName: browserName as 'chromium' | 'firefox' | 'webkit', viewport },
    }))),
});
