import fs from 'node:fs/promises';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { createApp } from '../../index';
import { config } from '../../config';
import { DatabaseService } from '../../models/database';
import { BurnManager } from '../../services/burnService';
import { PlexService, PlexServerClient, PlexServerAccessDeniedError } from '../../services/plexService';
import { normalizeFixtureManifest, validateProofTarget } from './verifyAbs';
import { BooksCatalog } from '../catalog';
import { BooksRelay } from '../relay';
import { BookStreams } from '../streams';
import { EpubPreparation } from '../epub/prepare';

export interface FixtureAppOptions {
  port?: number;
  listenOnContainerInterface?: boolean;
  previousUsers?: Array<{ label: string; bearer: string }>;
  readerNow?: () => number;
  reverseProxy?: { publicOrigin: boolean };
}
export interface FixtureApplication {
  origin: string;
  instanceId: string;
  providerInstanceId: string;
  users: Array<{ label: string; bearer: string; userId: string; expiresAt: number }>;
  readerCache(): Promise<Array<{ id: string; createdAt: number }>>;
  mapManifest(manifest: ReturnType<typeof normalizeFixtureManifest>): Promise<Array<{
    absItemId: string; absIno: string; fileId: string; contentVersion: string; size: number; role: 'ebook' | 'audio';
  }>>;
  stop(): Promise<void>;
}

class FixturePlexClient extends PlexServerClient {
  override async getLibraries() { return []; }
}
class FixturePlexService extends PlexService {
  override async validateExactServerMembership(accountToken: string, machineId: string) {
    if (!/^fixture-account-(a|b|owner)$/.test(accountToken) || machineId !== 'books-fixture-machine') {
      throw new PlexServerAccessDeniedError();
    }
    return { serverToken: 'fixture-server', discoveredUrl: 'http://127.0.0.1:1', owned: accountToken === 'fixture-account-owner' };
  }
  override async getServerOwnerIdentity(accountToken: string, machineId: string) {
    if (accountToken !== 'fixture-account-owner' || machineId !== 'books-fixture-machine') throw new PlexServerAccessDeniedError();
    return { id: 'fixture-owner', username: 'Fixture owner' };
  }
  override createServerClient() { return new FixturePlexClient('http://127.0.0.1:1', 'fixture-server'); }
  override async generatePin(): Promise<never> { throw new Error('Interactive OAuth is not enabled in isolated proof'); }
  override async checkPin(): Promise<never> { throw new Error('Interactive OAuth is not enabled in isolated proof'); }
}

export async function startFixtureApp(
  root: string, absOrigin: string, libraryId: string, options: FixtureAppOptions = {}
): Promise<FixtureApplication> {
  validateProofTarget(absOrigin, false);
  if (options.port !== undefined && (!Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65535)) throw new Error('Invalid fixture port');
  const executionRoot = await fs.realpath(process.cwd());
  const relative = path.relative(executionRoot, path.resolve(root));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Fixture root must be inside the isolated execution root');
  await fs.mkdir(root, { recursive: true });
  const actual = path.relative(executionRoot, await fs.realpath(root));
  if (actual.startsWith('..') || path.isAbsolute(actual)) throw new Error('Fixture root escapes execution root');
  const certFile = process.env.BOOKS_PROOF_TLS_CERT_FILE;
  const keyFile = process.env.BOOKS_PROOF_TLS_KEY_FILE;
  if (!certFile || !keyFile) throw new Error('HTTPS fixture certificate and key required; Secure cookie proof is blocked');
  const [cert, key] = await Promise.all([fs.readFile(certFile), fs.readFile(keyFile)]);
  const credential = process.env.BOOKS_PROOF_ABS_TOKEN ??
    (process.env.BOOKS_PROOF_ABS_TOKEN_FILE ? (await fs.readFile(process.env.BOOKS_PROOF_ABS_TOKEN_FILE, 'utf8')).trim() : '');
  if (!credential) throw new Error('Isolated ABS fixture credential required');
  const secretFile = path.join(root, 'fixture-encryption-key');
  let secret: string;
  try {
    await fs.writeFile(secretFile, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
  }
  if ((await fs.lstat(secretFile)).isSymbolicLink()) throw new Error('Fixture secret cannot be a symbolic link');
  secret = await fs.readFile(secretFile, 'utf8');
  const db = new DatabaseService(path.join(root, 'books-fixture.db'), secret);
  try {
    db.setSetting('plex_machine_id', 'books-fixture-machine');
    db.setSetting('plex_owner_id', 'fixture-owner');
    db.setSetting('plex_owner_validated_at', String(Date.now()));
    db.setSetting('plex_url', 'http://127.0.0.1:1');
    db.setSetting('plex_token', 'fixture-account-owner');
    const users = ['a', 'b', 'owner'].map(label => {
      const user = db.createOrUpdatePlexUser({
        username: `Fixture ${label}`, email: `${label}@fixture.invalid`, plexId: `fixture-${label}`,
        plexToken: 'fixture-server', plexAccountToken: `fixture-account-${label}`, isAdmin: label === 'owner',
      });
      const existing = options.previousUsers?.find(user => user.label === label);
      if (existing && db.getSessionByToken(existing.bearer)?.userId === user.id) return existing;
      db.deleteSessionsForUser(user.id);
      return { label, bearer: db.createSession(user.id).token };
    });
    const firstUser = db.getSessionByToken(users[0].bearer)!;
    const previousSecond = options.previousUsers?.find(user => user.label === 'a-second-device');
    users.push(previousSecond && db.getSessionByToken(previousSecond.bearer)?.userId === firstUser.userId
      ? previousSecond : { label: 'a-second-device', bearer: db.createSession(firstUser.userId).token });
    if (options.readerNow) {
      // Synthetic sessions outlive the controlled 24-hour cache clock; production session policy is unchanged.
      const fixtureDb = new Database(path.join(root, 'books-fixture.db'));
      try {
        for (const user of users) fixtureDb.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?')
          .run(Date.now() + 72 * 60 * 60 * 1000, db.getSessionByToken(user.bearer)!.id);
      } finally { fixtureDb.close(); }
    }
    const previous = db.books.readConfig();
    if (!previous || previous.origin !== absOrigin || previous.libraryId !== libraryId) {
      db.books.setConfig({
        enabled: true, origin: absOrigin, libraryId, configGeneration: 0, providerInstanceId: '',
        serverBindingProofId: process.env.BOOKS_PROOF_SERVER_BINDING ?? 'isolated-fixture-binding',
      }, credential);
    }
    if (process.env.BOOKS_ENABLED !== 'true') throw new Error('Isolated fixture requires explicit BOOKS_ENABLED=true');
    const burnManager = new BurnManager(db, { ...config.burn, cacheDir: path.join(root, 'burn-cache') });
    await burnManager.start();
    const publicPath = process.env.BOOKS_TEST_FRONTEND_DIST
      ? await fs.realpath(process.env.BOOKS_TEST_FRONTEND_DIST) : undefined;
    if (publicPath) {
      const publicRelative = path.relative(executionRoot, publicPath);
      if (!publicRelative || publicRelative.startsWith('..') || path.isAbsolute(publicRelative)) throw new Error('Fixture assets escape execution root');
    }
    const plex = new FixturePlexService();
    const catalog = new BooksCatalog(db.books);
    const booksPreparation = options.readerNow
      ? new EpubPreparation(db, catalog, new BooksRelay(db, catalog, new BookStreams(), plex), plex, options.readerNow)
      : undefined;
    const app = createApp(db, burnManager, { plex, publicPath, booksPreparation });
    const priorOrigin = config.server.publicOrigin;
    const upstream = options.reverseProxy ? http.createServer(app) : undefined;
    if (upstream) {
      app.set('trust proxy', 1);
      await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    }
    const server = https.createServer({ cert, key }, upstream ? (req, res) => {
      const upstreamAddress = upstream.address();
      if (!upstreamAddress || typeof upstreamAddress === 'string') { res.writeHead(502).end(); return; }
      const forwarded = http.request({
        host: '127.0.0.1', port: upstreamAddress.port, method: req.method, path: req.url,
        headers: { ...req.headers, 'x-forwarded-proto': 'http', 'x-forwarded-host': req.headers.host },
      }, response => {
        res.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(res);
      });
      forwarded.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      res.once('close', () => { if (!res.writableFinished) forwarded.destroy(); });
      req.pipe(forwarded);
    } : app);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.port ?? 0, options.listenOnContainerInterface ? '0.0.0.0' : '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture listener unavailable');
    if (options.reverseProxy?.publicOrigin) Object.assign(config.server, { publicOrigin: `https://127.0.0.1:${address.port}` });
    let stopped = false;
    return {
      origin: `https://127.0.0.1:${address.port}`, instanceId: randomUUID(),
      providerInstanceId: db.books.readConfig()!.providerInstanceId,
      users: users.map(user => {
        const session = db.getSessionByToken(user.bearer)!;
        return { ...user, userId: session.userId, expiresAt: session.expiresAt };
      }),
      async mapManifest(manifest) {
        const current = db.books.readConfig()!;
        if (manifest.libraryId !== current.libraryId || manifest.serverBindingProofId !== current.serverBindingProofId) {
          throw new Error('Fixture manifest binding mismatch');
        }
        const user = db.getSessionByToken(users[0].bearer)!;
        const mapped = [];
        const items = new Map<string, Awaited<ReturnType<BooksCatalog['authorizeItem']>>['item']>();
        for (const expected of manifest.files) {
          let item = items.get(expected.absItemId);
          if (!item) {
            item = (await catalog.authorizeItem(user.userId, expected.absItemId, AbortSignal.timeout(10000))).item;
            items.set(expected.absItemId, item);
          }
          const file = item.files.find(file => db.books.inoForFileId(item!, file.fileId) === expected.absIno);
          if (!file?.available || file.size !== expected.size || file.role !== expected.role ||
              file.basename !== path.posix.basename(expected.relativePath)) throw new Error('Fixture file mapping mismatch');
          mapped.push({ absItemId: item.itemId, absIno: expected.absIno, fileId: file.fileId,
            contentVersion: file.contentVersion, size: file.size, role: file.role });
        }
        return mapped;
      },
      async readerCache() {
        let files: string[];
        try { files = await fs.readdir(db.booksCacheDir); } catch (error) {
          if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
          throw error;
        }
        return Promise.all(files.filter(name => /^prepared-[a-f0-9]{64}$/.test(name)).map(async name => ({
          id: name.slice('prepared-'.length), createdAt: (await fs.stat(path.join(db.booksCacheDir, name))).birthtimeMs,
        })));
      },
      async stop() {
        if (stopped) return;
        stopped = true;
        await db.stopBooks();
        db.close();
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
        if (upstream) {
          upstream.closeAllConnections();
          await new Promise<void>(resolve => upstream.close(() => resolve()));
          Object.assign(config.server, { publicOrigin: priorOrigin });
        }
      },
    };
  } catch (error) { db.close(); throw error; }
}

async function fixtureMain(): Promise<void> {
  const args = process.argv.slice(2);
  const options = new Map<string, string>();
  let listenOnContainerInterface = false;
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (key === '--listen-container') { listenOnContainerInterface = true; continue; }
    if (!['--root', '--session-file', '--port', '--fixture-manifest'].includes(key) || options.has(key) || !args[index + 1]) {
      throw new Error('Invalid fixture CLI arguments');
    }
    options.set(key, args[++index]);
  }
  const root = path.resolve(options.get('--root') ?? '');
  const privateRoot = path.resolve('.test-data');
  const rootRelative = path.relative(privateRoot, root);
  if (!rootRelative || rootRelative.startsWith('..') || path.isAbsolute(rootRelative)) throw new Error('Fixture root must be inside execution-root .test-data');
  const sessionFile = path.resolve(options.get('--session-file') ?? '');
  const relativeSession = path.relative(root, sessionFile);
  if (!relativeSession || relativeSession.startsWith('..') || path.isAbsolute(relativeSession)) throw new Error('Session output must be inside the private fixture root');
  const revision = process.env.BOOKS_PROOF_REVISION ?? '';
  const archive = process.env.BOOKS_TEST_SOURCE_ARCHIVE_SHA256 ?? '';
  if (!/^[a-f0-9]{40}$/.test(revision) || !/^[a-f0-9]{64}$/.test(archive)) throw new Error('Candidate source identity is required');
  const origin = process.env.BOOKS_PROOF_ABS_ORIGIN ?? '';
  const library = process.env.BOOKS_PROOF_LIBRARY_ID ?? '';
  let app: FixtureApplication | undefined;
  try {
    app = await startFixtureApp(root, origin, library, {
      port: Number(options.get('--port') ?? 0), listenOnContainerInterface,
    });
    const manifestFile = options.get('--fixture-manifest');
    if (manifestFile) {
      const relative = path.relative(await fs.realpath(process.cwd()), await fs.realpath(manifestFile));
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative) ||
          (await fs.stat(manifestFile)).size > 4 * 1024 * 1024) throw new Error('Fixture manifest is outside its scope or size bound');
    }
    const fileMap = manifestFile ? await app.mapManifest(normalizeFixtureManifest(JSON.parse(await fs.readFile(manifestFile, 'utf8')))) : [];
    const publicPath = process.env.BOOKS_TEST_FRONTEND_DIST ?? path.join(__dirname, '..', '..', '..', 'public');
    await fs.mkdir(path.dirname(sessionFile), { recursive: true, mode: 0o700 });
    const parent = path.relative(await fs.realpath(root), await fs.realpath(path.dirname(sessionFile)));
    if (parent.startsWith('..') || path.isAbsolute(parent)) throw new Error('Session output escapes the private root');
    await fs.writeFile(sessionFile, JSON.stringify({
      schemaVersion: 1, kind: 'isolated-books-fixture', origin: app.origin, instanceId: app.instanceId,
      binding: { providerInstanceId: app.providerInstanceId, libraryId: library, serverBindingProofId: process.env.BOOKS_PROOF_SERVER_BINDING },
      candidate: { revision, sourceArchiveSha256: archive, dirty: process.env.BOOKS_TEST_SOURCE_DIRTY === 'true',
        backendFixtureSha256: createHash('sha256').update(await fs.readFile(__filename)).digest('hex'),
        frontendIndexSha256: createHash('sha256').update(await fs.readFile(path.join(publicPath, 'index.html'))).digest('hex') },
      users: app.users, fileMap,
    }), { mode: 0o600, flag: 'wx' });
    console.log('Isolated Books fixture ready; protected session artifact written.');
    const stop = () => { void app!.stop().then(() => process.exit(0)); };
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
  } catch (error) { await app?.stop(); throw error; }
}

if (require.main === module) {
  void fixtureMain().catch(() => {
    console.error('Isolated Books fixture setup failed; verify scoped inputs and protected files.');
    process.exitCode = 1;
  });
}
