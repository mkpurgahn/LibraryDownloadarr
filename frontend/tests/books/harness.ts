import { test as base, expect, chromium, errors, BrowserContext, Page, TestInfo, Download } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID, X509Certificate } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { TLSSocket } from 'node:tls';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
process.chdir(repoRoot);
const libraryId = '163ac435-50a9-4f56-96d0-276edf9303c1';
type App = {
  origin: string;
  users: Array<{ label: string; bearer: string }>;
  stop(): Promise<void>;
};
type Provider = {
  origin: string;
  token: string;
  libraryId: string;
  setUnavailable(value: boolean): void;
  replaceEpub(): Promise<void>;
  stop(): Promise<void>;
};
export type BooksApp = App & {
  live: boolean;
  certificatePin: string;
  setUnavailable(value: boolean): void;
  replaceEpub(): Promise<void>;
};

async function syntheticProvider(): Promise<Provider> {
  const token = randomUUID();
  let unavailable = false;
  const files = new Map<string, Buffer>();
  const makeItem = (id: string, title: string, extensions: string[]) => {
    const manifest = extensions.map((ext, index) => {
      const ino = `${id}-${index}`;
      const data = Buffer.from(`Generated authorized original ${id} ${index}\n`.repeat(32));
      files.set(`${id}:${ino}`, data);
      return {
        ino, fileType: ['mp3', 'm4b'].includes(ext) ? 'audio' : 'ebook',
        metadata: {
          filename: `${title} ${index + 1}.${ext}`, ext: `.${ext}`,
          size: data.length, mtimeMs: 1700000000000, ctimeMs: 1700000000000,
          path: `/books/${id}/${index}.${ext}`, relPath: `${index}.${ext}`,
        },
      };
    });
    const audio = manifest.filter(file => file.fileType === 'audio');
    return {
      id, libraryId, mediaType: 'book', isMissing: false, isInvalid: false,
      libraryFiles: manifest,
      media: {
        metadata: {
          title, authors: [{ name: 'Fixture Author' }], narrators: ['Fixture Narrator'],
          description: '<p>Generated content for the native Books experience.</p>',
          series: [{ name: 'Fixture collection' }],
        },
        ebookFile: manifest.find(file => file.fileType === 'ebook') ?? null,
        audioFiles: audio.map(file => ({ ...file, duration: 5, mimeType: 'audio/mpeg' })),
        tracks: audio.map((file, index) => ({ ...file, duration: 5, startOffset: index * 5 })),
        numTracks: audio.length, numAudioFiles: audio.length, chapters: [],
      },
    };
  };
  const items = [
    makeItem('dual', 'A Tale in Two Formats', ['epub', 'pdf', 'mp3', 'mp3']),
    makeItem('unsupported', 'Download-only Archive', ['azw3']),
    makeItem('collection', 'One Hundred and One Tracks', Array.from({ length: 101 }, () => 'mp3')),
  ];
  const { buildEpubFixture, fixtureChapter } = await import('../../../backend/dist/books/proof/epubFixture.js');
  const hostile = '<script>window.bookScriptExecuted = true;</script>' +
    '<form action="https://fixture.invalid/blocked"><input name="private"/></form>' +
    '<iframe src="https://fixture.invalid/blocked"></iframe>' +
    '<svg xmlns="http://www.w3.org/2000/svg" onload="window.bookScriptExecuted = true;"><script>window.bookScriptExecuted = true;</script><foreignObject>Excluded</foreignObject></svg>' +
    '<style>@import "https://fixture.invalid/blocked"; p { background-image: u\\72l("https://fixture.invalid/blocked"); }</style>' +
    '<a href="https://fixture.invalid/blocked" onclick="window.bookScriptExecuted = true;">External reference</a>';
  const ebook = await buildEpubFixture({ first: fixtureChapter('First section', 100).replace('</body>', `${hostile}</body>`), long: true });
  files.set('dual:dual-0', ebook);
  items[0].libraryFiles[0].metadata.size = ebook.length;
  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(403).end(); return; }
    if (unavailable) { res.writeHead(503).end(); return; }
    const url = new URL(req.url!, 'http://fixture');
    const json = (value: unknown) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
    if (url.pathname === '/api/libraries') { json({ libraries: [{ id: libraryId, name: 'Fixture Books', mediaType: 'book' }] }); return; }
    if (url.pathname === `/api/libraries/${libraryId}`) { json({ id: libraryId, name: 'Fixture Books', mediaType: 'book' }); return; }
    if (url.pathname === `/api/libraries/${libraryId}/items`) {
      const filter = url.searchParams.get('filter') ?? '';
      const selected = items.filter(item =>
        filter.startsWith('ebooks.') ? Boolean(item.media.ebookFile) :
        filter === 'tracks.c2luZ2xl' ? item.media.numTracks === 1 :
        filter === 'tracks.bXVsdGk=' ? item.media.numTracks > 1 : true);
      const limit = Number(url.searchParams.get('limit') ?? 50);
      const page = Number(url.searchParams.get('page') ?? 0);
      json({ results: selected.slice(page * limit, (page + 1) * limit), total: selected.length, page, limit }); return;
    }
    if (url.pathname === `/api/libraries/${libraryId}/search`) {
      const query = (url.searchParams.get('q') ?? '').toLowerCase();
      json({ book: items.filter(item => `${item.media.metadata.title} Fixture Author`.toLowerCase().includes(query)).map(libraryItem => ({ libraryItem })) }); return;
    }
    const match = /^\/api\/items\/([^/]+)(?:\/file\/([^/]+)(?:\/download)?)?$/.exec(url.pathname);
    const item = match ? items.find(item => item.id === match[1]) : undefined;
    if (!item || !match) { res.writeHead(404).end(); return; }
    if (!match[2]) { json(item); return; }
    const data = files.get(`${item.id}:${match[2]}`);
    const file = item.libraryFiles.find(file => file.ino === match[2]);
    if (!data || !file) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', file.fileType === 'audio' ? 'audio/mpeg' : file.metadata.ext === '.pdf' ? 'application/pdf' : 'application/octet-stream');
    res.setHeader('ETag', `"${createHash('sha256').update(data).digest('hex')}"`);
    res.setHeader('Last-Modified', 'Tue, 14 Nov 2023 22:13:20 GMT');
    res.setHeader('Accept-Ranges', 'bytes');
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
    let bytes = data;
    if (range) {
      const start = Number(range[1]); const end = range[2] ? Math.min(Number(range[2]), data.length - 1) : data.length - 1;
      if (start >= data.length || start > end) { res.writeHead(416, { 'Content-Range': `bytes */${data.length}` }).end(); return; }
      bytes = data.subarray(start, end + 1);
      res.statusCode = 206; res.setHeader('Content-Range', `bytes ${start}-${end}/${data.length}`);
    }
    res.setHeader('Content-Length', String(bytes.length));
    res.end(req.method === 'HEAD' ? undefined : bytes);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Synthetic ABS listener unavailable');
  return {
    origin: `http://127.0.0.1:${address.port}`, token, libraryId,
    setUnavailable(value) { unavailable = value; },
    async replaceEpub() {
      const replacement = await buildEpubFixture({ first: fixtureChapter('Revised first section', 10) });
      files.set('dual:dual-0', replacement);
      items[0].libraryFiles[0].metadata.size = replacement.length;
      items[0].libraryFiles[0].metadata.mtimeMs += 1000;
    },
    async stop() {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

async function verifiedFixtureTls(origin: string, cert: Buffer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = https.get(new URL('/api/health', origin), { ca: cert }, response => {
      response.resume();
      if (response.statusCode === 200 && response.socket instanceof TLSSocket && response.socket.authorized) resolve();
      else reject(new Error('The isolated HTTPS certificate could not be verified'));
    });
    req.once('error', reject);
  });
}

export const test = base.extend<{ app: BooksApp; liveProvider: boolean }>({
  liveProvider: [false, { option: true }],
  app: async ({ liveProvider }, use, testInfo) => {
    const root = path.join(repoRoot, '.test-data', 'books', 'apps', randomUUID());
    await fs.mkdir(root, { recursive: true });
    const certFile = path.join(root, 'cert.pem');
    const keyFile = path.join(root, 'key.pem');
    await promisify(execFile)('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-keyout', keyFile, '-out', certFile,
    ]);
    let provider: Provider | undefined;
    const keys = ['BOOKS_ENABLED', 'BOOKS_PROOF_ABS_TOKEN', 'BOOKS_PROOF_ABS_TOKEN_FILE', 'BOOKS_PROOF_TLS_CERT_FILE',
      'BOOKS_PROOF_TLS_KEY_FILE', 'BOOKS_PROOF_SERVER_BINDING', 'BOOKS_TEST_FRONTEND_DIST'] as const;
    const previous = keys.map(key => [key, process.env[key]] as const);
    let app: App | undefined;
    try {
      if (!liveProvider) provider = await syntheticProvider();
      const absOrigin = provider?.origin ?? process.env.BOOKS_TEST_ABS_ORIGIN;
      const selectedLibrary = provider?.libraryId ?? process.env.BOOKS_PROOF_LIBRARY_ID;
      if (!absOrigin || !selectedLibrary) throw new Error('Isolated ABS fixture inputs are required');
      process.env.BOOKS_ENABLED = 'true';
      process.env.BOOKS_PROOF_TLS_CERT_FILE = certFile;
      process.env.BOOKS_PROOF_TLS_KEY_FILE = keyFile;
      process.env.BOOKS_TEST_FRONTEND_DIST = path.join(repoRoot, 'frontend', 'dist');
      if (provider) {
        process.env.BOOKS_PROOF_ABS_TOKEN = provider.token;
        process.env.BOOKS_PROOF_SERVER_BINDING = 'synthetic-browser-fixture';
      }
      else delete process.env.BOOKS_PROOF_ABS_TOKEN;
      const backend = await import('../../../backend/dist/books/proof/fixtureApp.js');
      app = await backend.startFixtureApp(root, absOrigin, selectedLibrary);
      await verifiedFixtureTls(app.origin, await fs.readFile(certFile));
      const fixture: BooksApp = {
        ...app, live: liveProvider,
        certificatePin: createHash('sha256').update(new X509Certificate(await fs.readFile(certFile)).publicKey.export({ format: 'der', type: 'spki' })).digest('base64'),
        setUnavailable(value) {
          if (!provider) throw new Error('Live fixture outages are not mutated by browser tests');
          provider.setUnavailable(value);
        },
        async replaceEpub() {
          if (!provider) throw new Error('Live provider originals cannot be replaced by consumer tests');
          await provider.replaceEpub();
        },
      };
      await use(fixture);
      const git = await promisify(execFile)('git', ['rev-parse', 'HEAD'], { cwd: repoRoot });
      const status = await promisify(execFile)('git', ['status', '--porcelain'], { cwd: repoRoot });
      await fs.writeFile(testInfo.outputPath('run.json'), JSON.stringify({
        baseRevision: git.stdout.trim(), workingTreeDirty: Boolean(status.stdout.trim()),
        builtIndexSha256: createHash('sha256').update(await fs.readFile(path.join(repoRoot, 'frontend', 'dist', 'index.html'))).digest('hex'),
        provider: liveProvider ? 'isolated-ABS-2.30.0' : 'synthetic-ABS-contract',
        browser: testInfo.project.name, status: testInfo.status, expectedStatus: testInfo.expectedStatus,
        observedAt: new Date().toISOString(), tls: 'explicit-fixture-CA-verified-before-browser-context',
      }, null, 2));
    } finally {
      await app?.stop();
      await provider?.stop();
      for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      await fs.rm(root, { recursive: true, force: true });
    }
  },
  context: async ({ browser, browserName, app, viewport, serviceWorkers, launchOptions }, use, testInfo) => {
    const ownedBrowser = serviceWorkers === 'allow' && browserName === 'chromium'
      ? await chromium.launch({
        ...launchOptions, headless: true,
        args: [...(launchOptions.args ?? []), `--ignore-certificate-errors-spki-list=${app.certificatePin}`],
      }) : undefined;
    let context: BrowserContext | undefined;
    try {
      context = await (ownedBrowser ?? browser).newContext({
        baseURL: app.origin, viewport, acceptDownloads: true, serviceWorkers,
        // These contexts contain only the CA-verified, generated loopback fixture.
        ignoreHTTPSErrors: !ownedBrowser,
      });
      await context.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.origin !== app.origin && ['http:', 'https:'].includes(url.protocol)) return route.abort();
        return route.continue();
      });
      await use(context);
      await fs.writeFile(testInfo.outputPath('browser.json'), JSON.stringify({
        engine: browserName, version: (ownedBrowser ?? browser).version(),
        headless: true, fixtureCertificatePin: app.certificatePin,
      }, null, 2));
    } finally { await context?.close(); await ownedBrowser?.close(); }
  },
});
export { expect };

export async function signIn(page: Page, app: BooksApp, index = 0): Promise<void> {
  await page.goto(`${app.origin}/manifest.json`);
  await page.evaluate(token => localStorage.setItem('token', token), app.users[index].bearer);
  await page.goto(`${app.origin}/books`);
  await expect(page.getByRole('heading', { name: 'Books', exact: true })).toBeVisible();
}

export async function capture(page: Page, name: string, info: TestInfo): Promise<void> {
  await page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: true });
  await fs.writeFile(info.outputPath(`${name}-state.json`), JSON.stringify({
    title: await page.title(),
    heading: await page.locator('main h1').allTextContents(),
    viewport: page.viewportSize(), observedAt: new Date().toISOString(),
    approval: 'technical-capture-not-appearance-acceptance',
  }, null, 2));
}

export async function originalDownload(page: Page, click: () => Promise<void>, info: TestInfo): Promise<Download> {
  const events: Array<Record<string, unknown>> = [];
  const response = (response: import('@playwright/test').Response) => {
    if (new URL(response.url()).pathname.startsWith('/api/books/downloads/')) events.push({ event: 'original-response', status: response.status() });
  };
  const failed = (request: import('@playwright/test').Request) => {
    if (new URL(request.url()).pathname.startsWith('/api/books/downloads/')) events.push({ event: 'original-request-failed', reason: request.failure()?.errorText });
  };
  page.on('response', response); page.on('requestfailed', failed);
  try {
    const automatic = page.waitForEvent('download', { timeout: 3000 }).catch(error => {
      if (error instanceof errors.TimeoutError) return undefined;
      throw error;
    });
    await click();
    let download = await automatic;
    if (!download) {
      events.push({ event: 'manual-save-fallback' });
      const manual = page.waitForEvent('download', { timeout: 10000 });
      await page.getByRole('link', { name: 'Save file', exact: true }).first().click();
      download = await manual;
    }
    events.push({ event: 'native-download-observed' });
    return download;
  } finally {
    page.removeListener('response', response); page.removeListener('requestfailed', failed);
    const cookies = page.isClosed() ? [] : await page.context().cookies();
    await fs.writeFile(info.outputPath('download-events.json'), JSON.stringify({
      events, cookieFlags: cookies.map(({ name, secure, httpOnly, sameSite, path }) => ({ name, secure, httpOnly, sameSite, path })),
    }, null, 2));
  }
}
