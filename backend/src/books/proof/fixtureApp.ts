import fs from 'node:fs/promises';
import path from 'node:path';
import https from 'node:https';
import { randomBytes } from 'node:crypto';
import { createApp } from '../../index';
import { config } from '../../config';
import { DatabaseService } from '../../models/database';
import { BurnManager } from '../../services/burnService';
import { PlexService, PlexServerClient, PlexServerAccessDeniedError } from '../../services/plexService';
import { validateProofTarget } from './verifyAbs';

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
  root: string, absOrigin: string, libraryId: string
): Promise<{ origin: string; users: Array<{ label: string; bearer: string }>; stop(): Promise<void> }> {
  validateProofTarget(absOrigin, false);
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
      db.deleteSessionsForUser(user.id);
      return { label, bearer: db.createSession(user.id).token };
    });
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
    const app = createApp(db, burnManager, { plex: new FixturePlexService(), publicPath });
    const server = https.createServer({ cert, key }, app);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture listener unavailable');
    let stopped = false;
    return {
      origin: `https://127.0.0.1:${address.port}`, users,
      async stop() {
        if (stopped) return;
        stopped = true;
        db.close();
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
      },
    };
  } catch (error) { db.close(); throw error; }
}
