import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import express from 'express';
import axios from 'axios';
import { config } from '../config';
import { createApp } from '../index';
import {
  AuthRequest,
  createAuthMiddleware,
  createAdminMiddleware,
} from '../middleware/auth';
import { DatabaseService } from '../models/database';
import { createAuthRouter } from '../routes/auth';
import { createMediaRouter } from '../routes/media';
import {
  buildBurnCommand,
  buildCompatibleCommand,
  burnCacheKey,
  COMPATIBLE_STREAM_ID,
} from '../services/burnService';
import { ensurePlexMembership } from '../services/membershipService';
import { sanitizeMedia } from '../services/mediaSanitizer';
import {
  OnlineSubtitleResultUnavailableError,
  OnlineSubtitleService,
} from '../services/onlineSubtitleService';
import { probeEmbeddedSubtitles } from '../services/subtitleProbe';
import { cachePlexSubtitle } from '../services/subtitleCache';
import { redactForLog } from '../utils/logger';
import {
  PlexMedia,
  PlexAccountUnauthorizedError,
  PlexOnlineSubtitleCandidate,
  PlexServerAccessDeniedError,
  PlexServerClient,
  PlexServerOwnershipRequiredError,
  PlexService,
  PlexSubtitleAttachError,
  PlexSubtitleTrack,
} from '../services/plexService';

const secret = 'test-only-encryption-key-with-more-than-32-characters';
const testRoot = path.join(process.cwd(), '.test-data', randomUUID());
const mediaRoot = path.join(testRoot, 'media');
const cacheRoot = path.join(testRoot, 'cache');
const mediaFile = path.join(mediaRoot, 'movie.mkv');
const partKey = '/library/parts/123/file.mkv';
const ratingKey = '42';

const subtitle = (overrides: Partial<PlexSubtitleTrack> = {}): PlexSubtitleTrack => ({
  id: '77',
  index: 4,
  subtitleIndex: 1,
  language: 'English',
  languageCode: 'eng',
  title: 'English',
  codec: 'srt',
  forced: false,
  hearingImpaired: false,
  embedded: true,
  external: false,
  ...overrides,
});

const metadata = (file = mediaFile): PlexMedia => ({
  ratingKey,
  key: `/library/metadata/${ratingKey}`,
  title: 'Test Movie',
  type: 'movie',
  thumb: `/library/metadata/${ratingKey}/thumb`,
  duration: 120000,
  Media: [{
    id: 1,
    videoCodec: 'h264',
    audioCodec: 'aac',
    Part: [{
      id: 123,
      key: partKey,
      file,
      size: 10,
      duration: 120000,
      container: 'mkv',
      Stream: [
        {
          id: 11,
          index: 0,
          streamType: 1,
          codec: 'h264',
          file: '/private/video-path',
        },
        {
          id: 12,
          index: 1,
          streamType: 2,
          codec: 'aac',
        },
        {
          id: 77,
          index: 4,
          streamType: 3,
          codec: 'srt',
          language: 'English',
          languageCode: 'eng',
          displayTitle: 'English',
          forced: '0',
        },
        {
          id: 88,
          index: 5,
          streamType: 3,
          codec: 'hdmv_pgs_subtitle',
          language: 'English',
          languageCode: 'eng',
          title: 'English PGS',
          hearingImpaired: '1',
          key: '/library/streams/88',
          file: '/private/subtitle.sup',
        },
        {
          id: 99,
          index: 6,
          streamType: 3,
          codec: 'eia_608',
          language: 'English',
          key: '/library/streams/99',
          file: '/private/captions.bin',
        },
      ],
      subtitles: [subtitle(), subtitle({
        id: '88',
        index: 5,
        subtitleIndex: 2,
        codec: 'hdmv_pgs_subtitle',
        title: 'English PGS',
      })],
    }],
  }],
});

class MockClient extends PlexServerClient {
  private readonly current: PlexMedia;
  private attachedOnlineSubtitle = false;
  private pendingOnlineAttachment?: NodeJS.Timeout;

  constructor(
    private readonly service: MockPlexService,
    value: PlexMedia,
    private readonly denied = false
  ) {
    super('http://plex.test:32400', 'token');
    this.current = structuredClone(value);
  }

  override async getMediaMetadata(requestedRatingKey: string): Promise<PlexMedia> {
    if (this.denied || requestedRatingKey !== this.current.ratingKey) throw new Error('not accessible');
    if (this.attachedOnlineSubtitle && this.service.metadataFailuresAfterAttach > 0) {
      this.service.metadataFailuresAfterAttach -= 1;
      throw new Error('simulated metadata failure after subtitle attachment');
    }
    return structuredClone(this.current);
  }

  override async getEpisodes(_seasonRatingKey: string): Promise<PlexMedia[]> {
    if (this.denied) throw new Error('not accessible');
    return [structuredClone(this.current)];
  }

  override async searchSubtitles(
    requestedRatingKey: string,
    options: { language: string; mediaItemId?: number | string }
  ): Promise<PlexOnlineSubtitleCandidate[]> {
    if (this.denied || requestedRatingKey !== this.current.ratingKey) throw new Error('not accessible');
    this.service.onlineEvents.push(
      `search:${requestedRatingKey}:${options.language}:${options.mediaItemId || ''}`
    );
    return structuredClone(this.service.onlineCandidates);
  }

  override async attachSubtitle(
    requestedRatingKey: string,
    candidate: PlexOnlineSubtitleCandidate
  ): Promise<string | undefined> {
    if (this.denied || requestedRatingKey !== this.current.ratingKey) throw new Error('not accessible');
    this.service.activeOnlineAttachments += 1;
    this.service.maximumConcurrentOnlineAttachments = Math.max(
      this.service.maximumConcurrentOnlineAttachments,
      this.service.activeOnlineAttachments
    );
    if (this.service.onlineAttachDelayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, this.service.onlineAttachDelayMs));
    }
    this.service.onlineEvents.push(`attach:${candidate.id}`);
    this.service.activeOnlineAttachments -= 1;
    if (this.service.onlineAsyncAttachDelayMs > 0) {
      this.pendingOnlineAttachment = setTimeout(
        () => this.applyOnlineSubtitle(candidate),
        this.service.onlineAsyncAttachDelayMs
      );
    } else {
      this.applyOnlineSubtitle(candidate);
    }
    return `activity-${candidate.id}`;
  }

  private applyOnlineSubtitle(candidate: PlexOnlineSubtitleCandidate): void {
    const part = this.current.Media![0].Part[0];
    for (const stream of part.Stream || []) {
      if (Number(stream.streamType) === 3) stream.selected = 0;
    }
    const attachedId = Number(candidate.id) + 1000;
    part.Stream = [
      ...(part.Stream || []),
      {
        id: attachedId,
        index: 7,
        streamType: 3,
        codec: candidate.codec,
        language: candidate.language,
        languageCode: candidate.languageCode,
        title: candidate.title,
        displayTitle: candidate.displayTitle,
        providerTitle: candidate.providerTitle,
        forced: candidate.forced ? 1 : 0,
        hearingImpaired: candidate.hearingImpaired ? 1 : 0,
        selected: 1,
        downloaded: 1,
        transient: 1,
        sourceKey: candidate.key,
        key: `/library/streams/${attachedId}`,
      },
    ];
    this.attachedOnlineSubtitle = true;
    this.pendingOnlineAttachment = undefined;
  }

  override async selectSubtitle(
    partId: number | string,
    selectedId: number | string
  ): Promise<void> {
    this.service.onlineEvents.push(`select:${partId}:${selectedId}`);
    for (const stream of this.current.Media![0].Part[0].Stream || []) {
      if (Number(stream.streamType) === 3) {
        stream.selected = String(stream.id) === String(selectedId) ? 1 : 0;
      }
    }
  }

  override async deleteSubtitle(resourcePath: string): Promise<boolean> {
    this.service.onlineEvents.push(`delete:${resourcePath}`);
    const part = this.current.Media![0].Part[0];
    const before = part.Stream?.length || 0;
    part.Stream = (part.Stream || []).filter(stream => stream.key !== resourcePath);
    return part.Stream.length < before;
  }

  override async cancelActivity(activityId: string): Promise<boolean> {
    this.service.onlineEvents.push(`cancel:${activityId}`);
    if (!this.pendingOnlineAttachment) return false;
    clearTimeout(this.pendingOnlineAttachment);
    this.pendingOnlineAttachment = undefined;
    return true;
  }
}

class MockPlexService extends PlexService {
  revoked = false;
  ownerRevoked = false;
  denyUserMedia = false;
  value = metadata();
  onlineEvents: string[] = [];
  metadataFailuresAfterAttach = 0;
  onlineAttachDelayMs = 0;
  onlineAsyncAttachDelayMs = 0;
  activeOnlineAttachments = 0;
  maximumConcurrentOnlineAttachments = 0;
  onlineCandidates: PlexOnlineSubtitleCandidate[] = [{
    id: '700',
    key: '/library/streams/700',
    codec: 'srt',
    language: 'English',
    languageCode: 'eng',
    title: 'Test Movie 1080p WEB-DL',
    displayTitle: 'English',
    providerTitle: 'OpenSubtitles',
    score: 9900,
    perfectMatch: true,
    forced: false,
    hearingImpaired: false,
    downloaded: false,
    mediaItemId: '1',
  }];

  override createServerClient(_serverUrl: string, token: string): PlexServerClient {
    return new MockClient(this, this.value, this.denyUserMedia && token === 'server-token');
  }

  override async validateExactServerMembership(
    _accountToken: string,
    _machineId: string
  ): Promise<{ serverToken: string; discoveredUrl: string; owned: boolean }> {
    if (this.revoked) throw new PlexServerAccessDeniedError();
    return {
      serverToken: 'server-token',
      discoveredUrl: 'http://plex.test:32400',
      owned: false,
    };
  }

  override async getServerOwnerIdentity(
    _token: string,
    _machineId: string
  ): Promise<{ id: string; username: string }> {
    if (this.ownerRevoked) throw new PlexServerOwnershipRequiredError();
    return { id: 'plex-admin-one', username: 'admin-one' };
  }
}

let db: DatabaseService;
let server: http.Server;
let baseUrl: string;
let adminOneToken: string;
let adminTwoToken: string;
const service = new MockPlexService();
const onlineSubtitles = new OnlineSubtitleService({
  pollIntervalMs: 1,
  pollTimeoutMs: 100,
  cacheSubtitle: async subtitleTrack => {
    const subtitlePath = path.join(cacheRoot, `${subtitleTrack.id}.srt`);
    await fs.writeFile(subtitlePath, '1\n00:00:00,000 --> 00:00:01,000\nTest subtitle\n');
    subtitleTrack.file = subtitlePath;
  },
});

const request = async (
  pathname: string,
  init: RequestInit = {},
  token = adminOneToken
): Promise<Response> => fetch(`${baseUrl}${pathname}`, {
  ...init,
  headers: {
    ...(init.body ? { 'content-type': 'application/json' } : {}),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...init.headers,
  },
});

before(async () => {
  await fs.mkdir(mediaRoot, { recursive: true });
  await fs.mkdir(cacheRoot, { recursive: true });
  await fs.writeFile(mediaFile, '0123456789');
  config.media.roots.splice(0, config.media.roots.length, mediaRoot);
  config.burn.cacheDir = cacheRoot;
  config.plex.membershipTtlMs = 60_000;
  config.rateLimit.creationMax = 1000;
  db = new DatabaseService(path.join(testRoot, 'test.db'), secret);
  db.setSetting('plex_url', 'http://plex.test:32400');
  db.setSetting('plex_token', 'owner-token');
  db.setSetting('plex_machine_id', 'exact-machine');
  db.setSetting('plex_owner_id', 'plex-admin-one');
  db.setSetting('plex_owner_username', 'admin-one');
  db.setSetting('plex_owner_validated_at', String(Date.now()));
  const adminOne = db.createOrUpdatePlexUser({
    username: 'admin-one',
    email: 'one@example.test',
    plexToken: 'server-token',
    plexAccountToken: 'account-token-one',
    plexId: 'plex-admin-one',
    isAdmin: true,
  });
  const adminTwo = db.createOrUpdatePlexUser({
    username: 'admin-two',
    email: 'two@example.test',
    plexToken: 'server-token',
    plexAccountToken: 'account-token-two',
    plexId: 'plex-admin-two',
  });
  adminOneToken = db.createSession(adminOne.id).token;
  adminTwoToken = db.createSession(adminTwo.id).token;

  const app = express();
  app.use(express.json());
  const authMiddleware = createAuthMiddleware(db, service);
  app.get('/api/test-auth', authMiddleware, (req: AuthRequest, res) => res.json({
    user: req.user,
  }));
  app.get(
    '/api/test-admin',
    authMiddleware,
    createAdminMiddleware(db),
    (_req, res) => res.json({ ok: true })
  );
  app.use('/api/auth', createAuthRouter(db));
  app.use('/api/media', createMediaRouter(db, {
    plex: service,
    onlineSubtitles,
    burnManager: {
      enqueue: () => undefined,
      cancel: () => ({ cancelled: false }),
    } as never,
  }));
  server = app.listen(0);
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  db.close();
  await fs.rm(testRoot, { recursive: true, force: true });
  await fs.rmdir(path.dirname(testRoot)).catch(() => undefined);
});

test('exact server matching fails closed without fallback', () => {
  const result = service.findBestServerConnection([
    {
      provides: 'server',
      clientIdentifier: 'different-machine',
      owned: '1',
      Connection: { uri: 'http://wrong.test:32400', local: '1' },
    },
  ], 'exact-machine');
  assert.deepEqual(result, {
    serverUrl: null,
    accessToken: null,
    matched: false,
    owned: false,
  });
});

test('exact membership does not depend on optional Plex connection metadata', async () => {
  const isolated = new PlexService();
  isolated.getUserServers = async () => [{
    provides: 'server',
    clientIdentifier: 'exact-machine',
    owned: '1',
  }];
  const membership = await isolated.validateExactServerMembership('account-token', 'exact-machine');
  assert.equal(membership.serverToken, 'account-token');
  assert.equal(membership.owned, true);
});

test('server owner identity rejects shared Plex access tokens', async () => {
  const isolated = new PlexService();
  isolated.getUserInfo = async () => ({
    uuid: 'account-1',
    username: 'owner-candidate',
  });
  isolated.getUserServers = async () => [{
    provides: 'server',
    clientIdentifier: 'exact-machine',
    owned: '0',
    accessToken: 'shared-server-token',
  }];
  await assert.rejects(
    () => isolated.getServerOwnerIdentity('shared-account-token', 'exact-machine'),
    PlexServerOwnershipRequiredError
  );

  isolated.getUserServers = async () => [{
    provides: 'server',
    clientIdentifier: 'exact-machine',
    owned: '1',
  }];
  assert.deepEqual(
    await isolated.getServerOwnerIdentity('owner-account-token', 'exact-machine'),
    { id: 'account-1', username: 'owner-candidate' }
  );
});

test('only the configured Plex owner receives administrator access', async () => {
  const owner = await request('/api/test-auth');
  assert.equal(owner.status, 200);
  const ownerBody = await owner.json() as { user: { isAdmin: boolean } };
  assert.equal(ownerBody.user.isAdmin, true);

  const ownerAdmin = await request('/api/test-admin');
  assert.equal(ownerAdmin.status, 200);

  const sharedUser = await request('/api/test-auth', {}, adminTwoToken);
  assert.equal(sharedUser.status, 200);
  const sharedUserBody = await sharedUser.json() as { user: { isAdmin: boolean } };
  assert.equal(sharedUserBody.user.isAdmin, false);

  const denied = await request('/api/test-admin', {}, adminTwoToken);
  assert.equal(denied.status, 403);
  assert.deepEqual(await denied.json(), { error: 'Plex owner access required' });
});

test('stale owner sessions lose admin access when Plex ownership is revoked', async () => {
  db.setSetting('plex_owner_validated_at', '0');
  service.ownerRevoked = true;
  const denied = await request('/api/test-admin');
  assert.equal(denied.status, 403);
  assert.equal(db.getSetting('plex_owner_id'), undefined);

  service.ownerRevoked = false;
  db.setSetting('plex_owner_id', 'plex-admin-one');
  db.setSetting('plex_owner_username', 'admin-one');
  db.setSetting('plex_owner_validated_at', String(Date.now()));
  db.setExclusivePlexAdminByPlexId('plex-admin-one');
});

test('configured servers reject local admin sessions and expose no password login', async () => {
  const localAdmin = db.createAdminUser({
    username: 'legacy-admin',
    passwordHash: 'unused',
    email: 'legacy@example.test',
    isAdmin: true,
  });
  const localToken = db.createSession(localAdmin.id).token;
  const denied = await request('/api/test-admin', {}, localToken);
  assert.equal(denied.status, 401);

  const login = await request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: 'legacy-admin', password: 'unused' }),
  }, '');
  assert.equal(login.status, 404);
});

test('unconfigured bootstrap setup can be resumed with the same credentials', async () => {
  const databasePath = path.join(testRoot, 'bootstrap-resume.db');
  const setupDb = new DatabaseService(databasePath, secret);
  const setupApp = express();
  setupApp.use(express.json());
  setupApp.use('/api/auth', createAuthRouter(setupDb));
  const setupServer = setupApp.listen(0);
  await new Promise<void>(resolve => setupServer.once('listening', resolve));
  const address = setupServer.address();
  assert(address && typeof address === 'object');
  const setupUrl = `http://127.0.0.1:${address.port}`;
  const body = JSON.stringify({
    username: 'bootstrap-admin',
    password: 'bootstrap-password-123',
  });
  try {
    const first = await fetch(`${setupUrl}/api/auth/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    assert.equal(first.status, 200);

    const required = await fetch(`${setupUrl}/api/auth/setup/required`);
    assert.deepEqual(await required.json(), { setupRequired: true });

    const resumed = await fetch(`${setupUrl}/api/auth/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    assert.equal(resumed.status, 200);
    assert.equal((await resumed.json() as { message: string }).message, 'Setup resumed successfully');
  } finally {
    await new Promise<void>(resolve => setupServer.close(() => resolve()));
    setupDb.close();
  }
});

test('database restart removes configured legacy admin accounts and sessions', () => {
  const databasePath = path.join(testRoot, 'legacy-admin-cleanup.db');
  const initial = new DatabaseService(databasePath, secret);
  const legacy = initial.createAdminUser({
    username: 'legacy',
    passwordHash: 'unused',
    email: 'legacy-cleanup@example.test',
    isAdmin: true,
  });
  const legacySession = initial.createSession(legacy.id).token;
  initial.logDownload(legacy.id, 'Legacy Download', 'legacy-key', 1234);
  initial.setSetting('plex_machine_id', 'configured-machine');
  initial.close();

  const reopened = new DatabaseService(databasePath, secret);
  assert.equal(reopened.hasAdminUser(), false);
  assert.equal(reopened.getSessionByToken(legacySession), undefined);
  const history = reopened.getAllDownloadHistory() as Array<{ username: string }>;
  assert.equal(history[0].username, 'legacy');
  reopened.close();
});

test('revoked membership invalidates active sessions', async () => {
  const user = db.createOrUpdatePlexUser({
    username: 'plex-user',
    email: 'plex@example.test',
    plexId: 'plex-1',
    plexToken: 'server-token',
    plexAccountToken: 'account-token',
  });
  const sessionToken = db.createSession(user.id).token;
  service.revoked = true;
  await assert.rejects(() => ensurePlexMembership(db, user.id, true, service));
  assert.equal(db.getSessionByToken(sessionToken), undefined);
  service.revoked = false;
});

test('authorized tickets are denied after revocation on every GET and HEAD resume', async () => {
  for (const method of ['GET', 'HEAD']) {
    service.revoked = false;
    const user = db.createOrUpdatePlexUser({
      username: `ticket-${method.toLowerCase()}`,
      email: `${method.toLowerCase()}@example.test`,
      plexId: `plex-ticket-${method.toLowerCase()}`,
      plexToken: 'server-token',
      plexAccountToken: 'account-token',
    });
    const sessionToken = db.createSession(user.id).token;
    const created = await request(`/api/media/${ratingKey}/download-ticket`, {
      method: 'POST',
      body: JSON.stringify({ partKey }),
    }, sessionToken);
    assert.equal(created.status, 200);
    const body = await created.json() as { url: string };

    service.revoked = true;
    const denied = await request(body.url, { method }, '');
    assert.equal(denied.status, 403);
    assert.equal(db.getSessionByToken(sessionToken), undefined);
  }
  service.revoked = false;
});

test('existing tickets are denied after access to their media item is removed', async () => {
  const user = db.createOrUpdatePlexUser({
    username: 'library-revoked',
    email: 'library-revoked@example.test',
    plexId: 'plex-library-revoked',
    plexToken: 'server-token',
    plexAccountToken: 'account-token',
  });
  const sessionToken = db.createSession(user.id).token;
  const created = await request(`/api/media/${ratingKey}/download-ticket`, {
    method: 'POST',
    body: JSON.stringify({ partKey }),
  }, sessionToken);
  assert.equal(created.status, 200);
  const { url } = await created.json() as { url: string };

  service.denyUserMedia = true;
  try {
    const denied = await request(url, {}, '');
    assert.equal(denied.status, 403);
    assert.notEqual(db.getSessionByToken(sessionToken), undefined);
  } finally {
    service.denyUserMedia = false;
  }
});

test('partKey mismatch is rejected before ticket creation', async () => {
  const response = await request(`/api/media/${ratingKey}/download-ticket`, {
    method: 'POST',
    body: JSON.stringify({ partKey: '/library/parts/999/file.mkv' }),
  });
  assert.equal(response.status, 403);
});

test('original tickets are scoped and expire', async () => {
  const response = await request(`/api/media/${ratingKey}/download-ticket`, {
    method: 'POST',
    body: JSON.stringify({ partKey }),
  });
  assert.equal(response.status, 200);
  const body = await response.json() as { url: string; filename: string };
  const token = body.url.split('/').pop()!;
  const ticket = db.getDownloadTicket(token);
  assert.equal(ticket?.ratingKey, ratingKey);
  assert.equal(ticket?.partKey, partKey);
  assert.equal(ticket?.filePath, await fs.realpath(mediaFile));
  assert.equal(ticket?.filename, 'movie.mkv');

  const expired = db.createDownloadTicket({
    userId: ticket!.userId,
    ratingKey,
    partKey,
    filePath: mediaFile,
    sourceFingerprint: ticket!.sourceFingerprint,
    filename: 'movie.mkv',
    expiresAt: Date.now() - 1,
  });
  const expiredResponse = await request(`/api/media/downloads/${expired.token}`, {}, '');
  assert.equal(expiredResponse.status, 404);
});

test('ticket responses can target a separate HTTPS download origin', async () => {
  const originalOrigin = config.media.publicDownloadOrigin;
  config.media.publicDownloadOrigin = 'https://files.example.test:8443';
  try {
    const single = await request(`/api/media/${ratingKey}/download-ticket`, {
      method: 'POST',
      body: JSON.stringify({ partKey }),
    });
    assert.equal(single.status, 200);
    const singleBody = await single.json() as { url: string };
    assert.match(
      singleBody.url,
      /^https:\/\/files\.example\.test:8443\/api\/media\/downloads\/[A-Za-z0-9_-]+$/
    );

    const batch = await request('/api/media/download-tickets', {
      method: 'POST',
      body: JSON.stringify({ items: [{ ratingKey, partKey }] }),
    });
    assert.equal(batch.status, 200);
    const batchBody = await batch.json() as { tickets: Array<{ url: string }> };
    assert.match(
      batchBody.tickets[0].url,
      /^https:\/\/files\.example\.test:8443\/api\/media\/downloads\/[A-Za-z0-9_-]+$/
    );
  } finally {
    config.media.publicDownloadOrigin = originalOrigin;
  }
});

test('batch ticket creation supports multiple resumable originals in one request', async () => {
  const response = await request('/api/media/download-tickets', {
    method: 'POST',
    body: JSON.stringify({
      items: [
        { ratingKey, partKey },
        { ratingKey, partKey },
      ],
    }),
  });
  assert.equal(response.status, 200);
  const body = await response.json() as {
    tickets: Array<{ ratingKey: string; partKey: string; url: string }>;
    errors: unknown[];
  };
  assert.equal(body.tickets.length, 1);
  assert.equal(body.errors.length, 0);
  assert.equal(body.tickets[0].ratingKey, ratingKey);
  assert.equal(body.tickets[0].partKey, partKey);
  const range = await fetch(`${baseUrl}${body.tickets[0].url}`, {
    headers: { range: 'bytes=0-3' },
  });
  assert.equal(range.status, 206);
  assert.equal(await range.text(), '0123');
});

test('batch ticket creation rejects more than 100 files', async () => {
  const response = await request('/api/media/download-tickets', {
    method: 'POST',
    body: JSON.stringify({
      items: Array.from({ length: 101 }, () => ({ ratingKey, partKey })),
    }),
  });
  assert.equal(response.status, 400);
});

test('download endpoint supports HEAD, full, open, bounded, and suffix ranges', async () => {
  const created = await request(`/api/media/${ratingKey}/download-ticket`, {
    method: 'POST',
    body: JSON.stringify({ partKey }),
  });
  const { url } = await created.json() as { url: string };

  const head = await request(url, { method: 'HEAD' }, '');
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('accept-ranges'), 'bytes');
  assert.equal(head.headers.get('content-length'), '10');
  assert.match(head.headers.get('etag') || '', /^"[a-f0-9]{64}"$/);
  assert.equal(await head.text(), '');

  const full = await request(url, {}, '');
  assert.equal(full.status, 200);
  assert.equal(await full.text(), '0123456789');

  const open = await request(url, { headers: { range: 'bytes=4-' } }, '');
  assert.equal(open.status, 206);
  assert.equal(open.headers.get('content-range'), 'bytes 4-9/10');
  assert.equal(await open.text(), '456789');

  const bounded = await request(url, { headers: { range: 'bytes=2-5' } }, '');
  assert.equal(bounded.status, 206);
  assert.equal(await bounded.text(), '2345');

  const suffix = await request(url, { headers: { range: 'bytes=-3' } }, '');
  assert.equal(suffix.status, 206);
  assert.equal(suffix.headers.get('content-range'), 'bytes 7-9/10');
  assert.equal(await suffix.text(), '789');

  const ifRangeMismatch = await request(url, {
    headers: { range: 'bytes=4-', 'if-range': '"different-version"' },
  }, '');
  assert.equal(ifRangeMismatch.status, 200);
  assert.equal(await ifRangeMismatch.text(), '0123456789');
});

test('invalid range returns 416 with unsatisfied content range', async () => {
  const created = await request(`/api/media/${ratingKey}/download-ticket`, {
    method: 'POST',
    body: JSON.stringify({ partKey }),
  });
  const { url } = await created.json() as { url: string };
  const response = await request(url, { headers: { range: 'bytes=99-100' } }, '');
  assert.equal(response.status, 416);
  assert.equal(response.headers.get('content-range'), 'bytes */10');
});

test('ticket refuses a file version changed after authorization', async () => {
  const created = await request(`/api/media/${ratingKey}/download-ticket`, {
    method: 'POST',
    body: JSON.stringify({ partKey }),
  });
  const { url } = await created.json() as { url: string };
  await fs.writeFile(mediaFile, 'changed-file');
  try {
    const response = await request(url, {}, '');
    assert.equal(response.status, 409);
  } finally {
    await fs.writeFile(mediaFile, '0123456789');
  }
});

test('derivative ticket creation enforces job ownership', async () => {
  const artifactPath = path.join(cacheRoot, 'artifact.mp4');
  await fs.writeFile(artifactPath, 'artifact');
  const artifact = db.createArtifact({
    cacheKey: 'artifact-key',
    filePath: artifactPath,
    filename: 'movie.eng.mp4',
    size: 8,
    expiresAt: Date.now() + 60_000,
  });
  const adminOne = db.getSessionByToken(adminOneToken)!;
  const job = db.createBurnJob({
    userId: adminOne.userId,
    ratingKey,
    partKey,
    subtitleStreamId: '77',
    sourcePath: mediaFile,
    sourceFingerprint: 'fingerprint',
    cacheKey: 'artifact-key',
    filename: artifact.filename,
    size: artifact.size,
    artifactId: artifact.id,
    mediaDurationMs: 120000,
    subtitleJson: JSON.stringify(subtitle()),
  });
  db.updateBurnJob(job.id, {
    status: 'ready',
    progress: 100,
    artifactId: artifact.id,
    filename: artifact.filename,
    size: artifact.size,
  });

  const denied = await request(`/api/media/burn-jobs/${job.id}/ticket`, { method: 'POST' }, adminTwoToken);
  assert.equal(denied.status, 404);
  const originalOrigin = config.media.publicDownloadOrigin;
  config.media.publicDownloadOrigin = 'https://files.example.test:8443';
  try {
    const allowed = await request(
      `/api/media/burn-jobs/${job.id}/ticket`,
      { method: 'POST' },
      adminOneToken
    );
    assert.equal(allowed.status, 200);
    const body = await allowed.json() as { url: string };
    assert.match(
      body.url,
      /^https:\/\/files\.example\.test:8443\/api\/media\/downloads\/[A-Za-z0-9_-]+$/
    );
  } finally {
    config.media.publicDownloadOrigin = originalOrigin;
  }
});

test('compatible MP4 jobs are authorized, cached, and queued without a subtitle', async () => {
  const response = await request(`/api/media/${ratingKey}/compatible-jobs`, {
    method: 'POST',
    body: JSON.stringify({ partKey }),
  });
  assert.equal(response.status, 202);
  const body = await response.json() as {
    job: {
      id: string;
      mode: string;
      strategy: string;
      subtitleStreamId: string;
      filename: string;
    };
  };
  assert.equal(body.job.mode, 'compatible');
  assert.equal(body.job.strategy, 'remux');
  assert.equal(body.job.subtitleStreamId, COMPATIBLE_STREAM_ID);
  assert.equal(body.job.filename, 'movie.mp4');
  const job = db.getBurnJob(body.job.id);
  assert.equal(job?.subtitleJson, JSON.stringify({ strategy: 'remux' }));
  assert.equal(job?.status, 'queued');
});

test('batch compatible MP4 jobs deduplicate selections and report per-item errors', async () => {
  const response = await request('/api/media/compatible-jobs', {
    method: 'POST',
    body: JSON.stringify({
      items: [
        { ratingKey, partKey },
        { ratingKey, partKey },
        { ratingKey: 'missing', partKey },
      ],
    }),
  });
  assert.equal(response.status, 202);
  const body = await response.json() as {
    jobs: Array<{ ratingKey: string; partKey: string; filename: string }>;
    errors: Array<{ ratingKey: string; partKey: string; error: string }>;
  };
  assert.equal(body.jobs.length, 1);
  assert.deepEqual(
    body.jobs.map(job => ({
      ratingKey: job.ratingKey,
      partKey: job.partKey,
      filename: job.filename,
    })),
    [{ ratingKey, partKey, filename: 'movie.mp4' }]
  );
  assert.equal(body.errors.length, 1);
  assert.equal(body.errors[0].ratingKey, 'missing');
  assert.match(body.errors[0].error, /could not be prepared as MP4/i);

  const oversized = await request('/api/media/compatible-jobs', {
    method: 'POST',
    body: JSON.stringify({
      items: Array.from({ length: 101 }, (_, index) => ({
        ratingKey: String(index),
        partKey,
      })),
    }),
  });
  assert.equal(oversized.status, 400);
});

test('compatible MP4 converts unknown audio and rejects audio-only media', async () => {
  const original = service.value;
  try {
    const incompatibleAudio = metadata();
    incompatibleAudio.Media![0].audioCodec = undefined;
    incompatibleAudio.Media![0].Part[0].Stream = incompatibleAudio.Media![0].Part[0].Stream!
      .filter(stream => Number(stream.streamType) !== 2);
    service.value = incompatibleAudio;
    const converted = await request(`/api/media/${ratingKey}/compatible-jobs`, {
      method: 'POST',
      body: JSON.stringify({ partKey }),
    });
    assert.equal(converted.status, 202);
    const convertedBody = await converted.json() as {
      job: { id: string; strategy: string };
    };
    assert.equal(convertedBody.job.strategy, 'audio');
    assert.equal(
      db.getBurnJob(convertedBody.job.id)?.subtitleJson,
      JSON.stringify({ strategy: 'audio' })
    );

    const audioOnly = metadata();
    audioOnly.type = 'track';
    audioOnly.Media![0].videoCodec = undefined;
    audioOnly.Media![0].Part[0].Stream = audioOnly.Media![0].Part[0].Stream!
      .filter(stream => Number(stream.streamType) !== 1);
    service.value = audioOnly;
    const rejected = await request(`/api/media/${ratingKey}/compatible-jobs`, {
      method: 'POST',
      body: JSON.stringify({ partKey }),
    });
    assert.equal(rejected.status, 422);
    assert.match(
      (await rejected.json() as { error: string }).error,
      /requires a media part with a video stream/i
    );
  } finally {
    service.value = original;
  }
});

test('online subtitle search is exact-part authorized, bounded, and opaque', async () => {
  const originalCandidates = service.onlineCandidates;
  service.onlineEvents = [];
  service.onlineCandidates = Array.from({ length: 24 }, (_, index) => ({
    ...originalCandidates[0],
    id: String(700 + index),
    key: `/library/streams/${700 + index}`,
    title: `Subtitle result ${index + 1}`,
    score: index,
    perfectMatch: false,
  }));
  try {
    const invalidLanguage = await request(
      `/api/media/${ratingKey}/subtitle-search?partKey=${encodeURIComponent(partKey)}&language=english`
    );
    assert.equal(invalidLanguage.status, 400);

    const wrongPart = await request(
      `/api/media/${ratingKey}/subtitle-search?partKey=${encodeURIComponent('/library/parts/999/file.mkv')}&language=en`
    );
    assert.equal(wrongPart.status, 403);

    const response = await request(
      `/api/media/${ratingKey}/subtitle-search?partKey=${encodeURIComponent(partKey)}&language=en`
    );
    assert.equal(response.status, 200);
    const body = await response.json() as {
      results: Array<{
        id: string;
        title: string;
        provider?: string;
        burnSupported: boolean;
        key?: string;
      }>;
      expiresAt: string;
    };
    assert.equal(body.results.length, 20);
    assert.equal(body.results[0].title, 'Subtitle result 24');
    assert.match(body.results[0].id, /^online_[A-Za-z0-9_-]+$/);
    assert.equal(body.results[0].provider, 'OpenSubtitles');
    assert.equal(body.results[0].burnSupported, true);
    assert.equal(body.results.every(result => !('key' in result)), true);
    assert(Number.isFinite(Date.parse(body.expiresAt)));
    assert.deepEqual(service.onlineEvents, ['search:42:en:1']);
  } finally {
    service.onlineCandidates = originalCandidates;
  }
});

test('online subtitle selection is user-scoped, cached, restored, and queued for burn-in', async () => {
  const originalMetadata = service.value;
  const selectedMetadata = metadata();
  selectedMetadata.Media![0].Part[0].Stream!
    .find(stream => String(stream.id) === '77')!.selected = 1;
  service.value = selectedMetadata;
  service.onlineEvents = [];
  try {
    const search = await request(
      `/api/media/${ratingKey}/subtitle-search?partKey=${encodeURIComponent(partKey)}&language=en`
    );
    assert.equal(search.status, 200);
    const searchBody = await search.json() as { results: Array<{ id: string }> };
    const resultId = searchBody.results[0].id;

    const denied = await request(`/api/media/${ratingKey}/burn-jobs`, {
      method: 'POST',
      body: JSON.stringify({ partKey, subtitleStreamId: resultId }),
    }, adminTwoToken);
    assert.equal(denied.status, 410);
    assert.equal(service.onlineEvents.some(event => event.startsWith('attach:')), false);

    const response = await request(`/api/media/${ratingKey}/burn-jobs`, {
      method: 'POST',
      body: JSON.stringify({ partKey, subtitleStreamId: resultId }),
    });
    const body = await response.json() as {
      job: { id: string; subtitleStreamId: string; filename: string };
      error?: string;
    };
    assert.equal(response.status, 202, JSON.stringify({
      body,
      events: service.onlineEvents,
    }));
    assert.match(body.job.subtitleStreamId, /^online-[a-f0-9]{64}$/);
    assert.equal(body.job.filename, 'movie.eng.mp4');

    const job = db.getBurnJob(body.job.id)!;
    const savedSubtitle = JSON.parse(job.subtitleJson) as PlexSubtitleTrack;
    assert.equal(savedSubtitle.external, true);
    assert.equal(savedSubtitle.embedded, false);
    assert.equal(savedSubtitle.codec, 'srt');
    assert.match(savedSubtitle.file || '', new RegExp(`^${cacheRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    const cachedSubtitle = await fs.readFile(savedSubtitle.file!);
    assert.equal(
      job.subtitleFingerprint,
      createHash('sha256').update(cachedSubtitle).digest('hex')
    );
    assert.deepEqual(
      service.onlineEvents.filter(event =>
        event.startsWith('attach:') ||
        event.startsWith('select:') ||
        event.startsWith('delete:')
      ),
      [
        'attach:700',
        'select:123:77',
        'delete:/library/streams/1700',
      ]
    );

    const reused = await request(`/api/media/${ratingKey}/burn-jobs`, {
      method: 'POST',
      body: JSON.stringify({ partKey, subtitleStreamId: resultId }),
    });
    assert.equal(reused.status, 410);
  } finally {
    service.value = originalMetadata;
  }
});

test('unsupported and expired online subtitle results fail before Plex attachment', async () => {
  const originalCandidates = service.onlineCandidates;
  try {
    service.onlineEvents = [];
    service.onlineCandidates = [{
      ...originalCandidates[0],
      id: '701',
      key: '/library/streams/701',
      codec: 'eia_608',
    }];
    const search = await request(
      `/api/media/${ratingKey}/subtitle-search?partKey=${encodeURIComponent(partKey)}&language=en`
    );
    const resultId = ((await search.json()) as { results: Array<{ id: string }> }).results[0].id;
    const unsupported = await request(`/api/media/${ratingKey}/burn-jobs`, {
      method: 'POST',
      body: JSON.stringify({ partKey, subtitleStreamId: resultId }),
    });
    assert.equal(unsupported.status, 422);
    assert.equal(service.onlineEvents.some(event => event.startsWith('attach:')), false);

    let now = 1000;
    const expiring = new OnlineSubtitleService({
      ttlMs: 10,
      now: () => now,
      cacheSubtitle: async () => undefined,
    });
    service.onlineCandidates = originalCandidates;
    const client = new MockClient(service, metadata());
    const result = await expiring.search({
      userId: 'user-one',
      ratingKey,
      partKey,
      language: 'en',
      mediaItemId: 1,
      client,
    });
    now = 1011;
    await assert.rejects(
      () => expiring.acquire({
        userId: 'user-one',
        ratingKey,
        partKey,
        resultId: result.results[0].id,
        client,
      }),
      OnlineSubtitleResultUnavailableError
    );
  } finally {
    service.onlineCandidates = originalCandidates;
  }
});

test('online subtitle results are atomically claimed and item mutations are serialized', async () => {
  service.onlineEvents = [];
  service.onlineAttachDelayMs = 10;
  service.activeOnlineAttachments = 0;
  service.maximumConcurrentOnlineAttachments = 0;
  const broker = new OnlineSubtitleService({
    pollIntervalMs: 1,
    pollTimeoutMs: 100,
    cleanupTimeoutMs: 100,
    cacheSubtitle: async subtitleTrack => {
      const subtitlePath = path.join(cacheRoot, `${subtitleTrack.id}-serialized.srt`);
      await fs.writeFile(subtitlePath, 'serialized');
      subtitleTrack.file = subtitlePath;
    },
  });
  try {
    const firstClient = new MockClient(service, metadata());
    const secondItem = metadata();
    secondItem.Media![0].Part[0].id = 124;
    secondItem.Media![0].Part[0].key = '/library/parts/124/file.mkv';
    const secondClient = new MockClient(service, secondItem);
    const firstSearch = await broker.search({
      userId: 'user-one',
      ratingKey,
      partKey,
      language: 'en',
      mediaItemId: 1,
      client: firstClient,
    });
    const secondSearch = await broker.search({
      userId: 'user-two',
      ratingKey,
      partKey: '/library/parts/124/file.mkv',
      language: 'en',
      mediaItemId: 1,
      client: secondClient,
    });

    const firstAcquisition = broker.acquire({
      userId: 'user-one',
      ratingKey,
      partKey,
      resultId: firstSearch.results[0].id,
      client: firstClient,
    });
    await assert.rejects(
      () => broker.acquire({
        userId: 'user-one',
        ratingKey,
        partKey,
        resultId: firstSearch.results[0].id,
        client: firstClient,
      }),
      OnlineSubtitleResultUnavailableError
    );
    const secondAcquisition = broker.acquire({
      userId: 'user-two',
      ratingKey,
      partKey: '/library/parts/124/file.mkv',
      resultId: secondSearch.results[0].id,
      client: secondClient,
    });
    await Promise.all([firstAcquisition, secondAcquisition]);
    assert.equal(service.maximumConcurrentOnlineAttachments, 1);
  } finally {
    service.onlineAttachDelayMs = 0;
  }
});

test('post-attach metadata failures still restore and delete the temporary subtitle', async () => {
  service.onlineEvents = [];
  service.metadataFailuresAfterAttach = 0;
  const broker = new OnlineSubtitleService({
    pollIntervalMs: 1,
    pollTimeoutMs: 100,
    cleanupTimeoutMs: 100,
    cacheSubtitle: async subtitleTrack => {
      const subtitlePath = path.join(cacheRoot, `${subtitleTrack.id}-cleanup.srt`);
      await fs.writeFile(subtitlePath, 'cleanup');
      subtitleTrack.file = subtitlePath;
    },
  });
  const client = new MockClient(service, metadata());
  const search = await broker.search({
    userId: 'cleanup-user',
    ratingKey,
    partKey,
    language: 'en',
    mediaItemId: 1,
    client,
  });
  service.metadataFailuresAfterAttach = 1;
  await assert.rejects(
    () => broker.acquire({
      userId: 'cleanup-user',
      ratingKey,
      partKey,
      resultId: search.results[0].id,
      client,
    }),
    /simulated metadata failure/
  );
  assert.deepEqual(
    service.onlineEvents.filter(event =>
      event.startsWith('cancel:') ||
      event.startsWith('select:') ||
      event.startsWith('delete:')
    ),
    [
      'cancel:activity-700',
      'select:123:0',
      'delete:/library/streams/1700',
    ]
  );
  assert.equal(service.metadataFailuresAfterAttach, 0);
});

test('timed-out Plex subtitle activities are cancelled before a late attachment can appear', async () => {
  service.onlineEvents = [];
  service.onlineAsyncAttachDelayMs = 50;
  const broker = new OnlineSubtitleService({
    pollIntervalMs: 1,
    pollTimeoutMs: 5,
    cleanupTimeoutMs: 10,
    cacheSubtitle: async () => undefined,
  });
  const client = new MockClient(service, metadata());
  try {
    const search = await broker.search({
      userId: 'late-user',
      ratingKey,
      partKey,
      language: 'en',
      mediaItemId: 1,
      client,
    });
    await assert.rejects(
      () => broker.acquire({
        userId: 'late-user',
        ratingKey,
        partKey,
        resultId: search.results[0].id,
        client,
      }),
      /did not finish downloading/
    );
    await new Promise(resolve => setTimeout(resolve, 60));
    const current = await client.getMediaMetadata(ratingKey);
    assert.equal(
      current.Media![0].Part[0].Stream!.some(stream => String(stream.id) === '1700'),
      false
    );
    assert.equal(service.onlineEvents.includes('cancel:activity-700'), true);
  } finally {
    service.onlineAsyncAttachDelayMs = 0;
  }
});

test('external subtitle cache enforces limits and rejects error documents', async () => {
  const fixtureServer = http.createServer((req, res) => {
    if (req.url === '/oversized.srt') {
      res.writeHead(200, {
        'content-type': 'application/x-subrip',
        'content-length': String(50 * 1024 * 1024 + 1),
      });
      res.end();
      return;
    }
    if (req.url === '/error.srt') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><body>Plex error</body></html>');
      return;
    }
    if (req.url === '/plex-mislabeled.srt') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('1\n00:00:00,000 --> 00:00:01,000\nValid Plex subtitle\n');
      return;
    }
    if (req.url === '/slow.srt') {
      res.writeHead(200, { 'content-type': 'application/x-subrip' });
      res.write('1\n00:00:00,000 --> 00:00:01,000\n');
      setTimeout(() => res.end('Too late\n'), 1000);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/x-subrip' });
    res.end('1\n00:00:00,000 --> 00:00:01,000\nCached subtitle\n');
  });
  fixtureServer.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => fixtureServer.once('listening', resolve));
  const address = fixtureServer.address();
  assert(address && typeof address === 'object');
  const fixturePort = address.port;

  class FixtureResourceClient extends PlexServerClient {
    constructor() {
      super(`http://127.0.0.1:${fixturePort}`, 'fixture-token');
    }

    override getResourceRequest(resourcePath: string) {
      return {
        url: `${this.baseUrl}${resourcePath}`,
        headers: { 'X-Plex-Token': 'fixture-token' },
        maxRedirects: 0 as const,
      };
    }
  }

  const client = new FixtureResourceClient();
  try {
    const cached = subtitle({
      id: 'online-test',
      codec: 'srt',
      embedded: false,
      external: true,
      key: '/ok.srt',
      file: undefined,
    });
    await cachePlexSubtitle(cached, client, cacheRoot);
    assert.equal(await fs.readFile(cached.file!, 'utf8'), '1\n00:00:00,000 --> 00:00:01,000\nCached subtitle\n');

    const mislabeled = subtitle({
      id: 'online-mislabeled',
      codec: 'srt',
      embedded: false,
      external: true,
      key: '/plex-mislabeled.srt',
      file: undefined,
    });
    await cachePlexSubtitle(mislabeled, client, cacheRoot);
    assert.equal(
      await fs.readFile(mislabeled.file!, 'utf8'),
      '1\n00:00:00,000 --> 00:00:01,000\nValid Plex subtitle\n'
    );

    const oversized = subtitle({
      codec: 'srt',
      embedded: false,
      external: true,
      key: '/oversized.srt',
      file: undefined,
    });
    await assert.rejects(
      () => cachePlexSubtitle(oversized, client, cacheRoot),
      /exceeds the 50 MiB limit/
    );

    const errorDocument = subtitle({
      codec: 'srt',
      embedded: false,
      external: true,
      key: '/error.srt',
      file: undefined,
    });
    await assert.rejects(
      () => cachePlexSubtitle(errorDocument, client, cacheRoot),
      /error document instead of subtitle text/
    );

    const originalTimeout = config.plex.requestTimeoutMs;
    config.plex.requestTimeoutMs = 50;
    try {
      const slow = subtitle({
        codec: 'srt',
        embedded: false,
        external: true,
        key: '/slow.srt',
        file: undefined,
      });
      await assert.rejects(
        () => cachePlexSubtitle(slow, client, cacheRoot),
        /aborted|canceled|timeout/i
      );
    } finally {
      config.plex.requestTimeoutMs = originalTimeout;
    }
  } finally {
    await new Promise<void>(resolve => fixtureServer.close(() => resolve()));
  }
});

test('Plex attachment errors distinguish definitive rejection from ambiguous server failure', async () => {
  let responseStatus = 502;
  const fixtureServer = http.createServer((_req, res) => {
    res.setHeader('X-Plex-Activity', 'activity-from-error');
    res.writeHead(responseStatus, { 'content-type': 'application/json' });
    res.end('{}');
  });
  fixtureServer.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => fixtureServer.once('listening', resolve));
  const address = fixtureServer.address();
  assert(address && typeof address === 'object');
  const client = new PlexServerClient(`http://127.0.0.1:${address.port}`, 'fixture-token');
  const candidate = service.onlineCandidates[0];
  try {
    await assert.rejects(
      () => client.attachSubtitle(ratingKey, candidate, 1000),
      (error: unknown) =>
        error instanceof PlexSubtitleAttachError &&
        error.mayHaveStarted &&
        error.activityId === 'activity-from-error'
    );
    responseStatus = 400;
    await assert.rejects(
      () => client.attachSubtitle(ratingKey, candidate, 1000),
      (error: unknown) =>
        error instanceof PlexSubtitleAttachError &&
        !error.mayHaveStarted
    );
  } finally {
    await new Promise<void>(resolve => fixtureServer.close(() => resolve()));
  }
});

test('cache eviction excludes artifacts with active download tickets and refreshes regenerated age', async () => {
  const protectedArtifact = db.createArtifact({
    cacheKey: 'protected-artifact',
    filePath: path.join(cacheRoot, 'protected.mp4'),
    filename: 'protected.mp4',
    size: 10,
    expiresAt: Date.now() + 60_000,
  });
  db.createDownloadTicket({
    userId: db.getSessionByToken(adminOneToken)!.userId,
    ratingKey,
    partKey,
    filePath: protectedArtifact.filePath,
    sourceFingerprint: 'protected-fingerprint',
    artifactId: protectedArtifact.id,
    filename: protectedArtifact.filename,
    expiresAt: Date.now() + 60_000,
  });
  const evictableArtifact = db.createArtifact({
    cacheKey: 'evictable-artifact',
    filePath: path.join(cacheRoot, 'evictable.mp4'),
    filename: 'evictable.mp4',
    size: 10,
    expiresAt: Date.now() + 60_000,
  });
  const firstCreatedAt = evictableArtifact.createdAt;
  await new Promise(resolve => setTimeout(resolve, 5));
  const regenerated = db.createArtifact({
    cacheKey: 'evictable-artifact',
    filePath: evictableArtifact.filePath,
    filename: evictableArtifact.filename,
    size: 12,
    expiresAt: Date.now() + 120_000,
  });
  assert(regenerated.createdAt > firstCreatedAt);

  const candidates = db.listEvictableArtifactsOldestFirst(Date.now() + 1);
  assert.equal(candidates.some(artifact => artifact.id === protectedArtifact.id), false);
  assert.equal(candidates.some(artifact => artifact.id === regenerated.id), true);
});

test('season and album ZIP download routes return 410 guidance', async () => {
  for (const url of [
    '/api/media/season/season-1/download',
    '/api/media/album/album-1/download',
  ]) {
    const response = await request(url);
    assert.equal(response.status, 410);
    assert.match((await response.json() as { error: string }).error, /individual files/i);
  }
});

test('trust proxy is disabled by default and bounded to configured hops', () => {
  const original = config.server.trustProxyHops;
  config.server.trustProxyHops = 0;
  const direct = createApp(db, {} as never);
  assert.equal(direct.get('trust proxy'), false);

  config.server.trustProxyHops = 1;
  const proxied = createApp(db, {} as never);
  const trust = proxied.get('trust proxy fn') as (address: string, index: number) => boolean;
  assert.equal(trust('127.0.0.1', 0), true);
  assert.equal(trust('10.0.0.1', 1), false);
  config.server.trustProxyHops = original;
});

test('public media sanitizer removes paths and annotates subtitle support', () => {
  const sanitized = sanitizeMedia(metadata());
  const part = sanitized.Media![0].Part[0];
  assert.equal('file' in part, false);
  assert.equal(part.filename, 'movie.mkv');
  assert.equal(JSON.stringify(sanitized).includes('/private/'), false);
  assert.equal(JSON.stringify(sanitized).includes(mediaRoot), false);

  const streams = part.Stream!.filter(stream => Number(stream.streamType) === 3);
  assert.deepEqual(streams.map(stream => ({
    id: stream.id,
    embedded: stream.embedded,
    external: stream.external,
    burnSupported: stream.burnSupported,
    hearingImpaired: stream.hearingImpaired,
  })), [
    { id: '77', embedded: true, external: false, burnSupported: true, hearingImpaired: false },
    { id: '88', embedded: false, external: true, burnSupported: true, hearingImpaired: true },
    { id: '99', embedded: false, external: true, burnSupported: false, hearingImpaired: false },
  ]);
  assert.equal(streams.every(stream => !('file' in stream)), true);
  assert.equal(part.subtitles!.every(track => !('file' in track)), true);
});

test('ffprobe fallback exposes and authorizes embedded subtitles omitted by Plex', async () => {
  const originalFfmpegPath = config.burn.ffmpegPath;
  const originalMetadata = service.value;
  const fakeBin = path.join(testRoot, 'fake-ffmpeg');
  const fakeProbe = path.join(fakeBin, 'ffprobe');
  await fs.mkdir(fakeBin, { recursive: true });
  await fs.writeFile(
    fakeProbe,
    `#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  streams: [
    {
      index: 3,
      codec_name: 'subrip',
      tags: { language: 'eng' },
      disposition: { forced: 0, hearing_impaired: 0 }
    },
    {
      index: 4,
      codec_name: 'subrip',
      tags: { language: 'eng', title: 'SDH' },
      disposition: { forced: 0, hearing_impaired: 1 }
    }
  ]
}));
`
  );
  await fs.chmod(fakeProbe, 0o755);
  config.burn.ffmpegPath = path.join(fakeBin, 'ffmpeg');

  const withoutPlexSubtitles = metadata();
  withoutPlexSubtitles.Media![0].Part[0].Stream =
    withoutPlexSubtitles.Media![0].Part[0].Stream!
      .filter(stream => Number(stream.streamType) !== 3);
  withoutPlexSubtitles.Media![0].Part[0].subtitles = [];
  service.value = withoutPlexSubtitles;

  try {
    const tracks = await probeEmbeddedSubtitles(mediaFile, `probe-${randomUUID()}`);
    assert.deepEqual(
      tracks.map(track => ({
        id: track.id,
        index: track.index,
        subtitleIndex: track.subtitleIndex,
        language: track.language,
        title: track.title,
        hearingImpaired: track.hearingImpaired,
      })),
      [
        {
          id: 'probe-3',
          index: 3,
          subtitleIndex: 0,
          language: 'English',
          title: 'English',
          hearingImpaired: false,
        },
        {
          id: 'probe-4',
          index: 4,
          subtitleIndex: 1,
          language: 'English',
          title: 'English - SDH',
          hearingImpaired: true,
        },
      ]
    );

    const detail = await request(`/api/media/${ratingKey}`);
    assert.equal(detail.status, 200);
    const detailBody = await detail.json() as { metadata: PlexMedia };
    const subtitleStreams = detailBody.metadata.Media![0].Part[0].Stream!
      .filter(stream => Number(stream.streamType) === 3);
    assert.deepEqual(
      subtitleStreams.map(stream => ({
        id: stream.id,
        displayTitle: stream.displayTitle,
        hearingImpaired: stream.hearingImpaired,
        burnSupported: stream.burnSupported,
      })),
      [
        {
          id: 'probe-3',
          displayTitle: 'English',
          hearingImpaired: false,
          burnSupported: true,
        },
        {
          id: 'probe-4',
          displayTitle: 'English - SDH',
          hearingImpaired: true,
          burnSupported: true,
        },
      ]
    );

    const episodeList = await request('/api/media/season-2/episodes');
    assert.equal(episodeList.status, 200);
    const episodeBody = await episodeList.json() as { episodes: PlexMedia[] };
    assert.deepEqual(
      episodeBody.episodes[0].Media![0].Part[0].Stream!
        .filter(stream => Number(stream.streamType) === 3)
        .map(stream => stream.id),
      ['probe-3', 'probe-4']
    );

    const burn = await request(`/api/media/${ratingKey}/burn-jobs`, {
      method: 'POST',
      body: JSON.stringify({ partKey, subtitleStreamId: 'probe-4' }),
    });
    assert.equal(burn.status, 202);
    const burnBody = await burn.json() as { job: { id: string } };
    const savedSubtitle = JSON.parse(db.getBurnJob(burnBody.job.id)!.subtitleJson) as PlexSubtitleTrack;
    assert.equal(savedSubtitle.index, 4);
    assert.equal(savedSubtitle.subtitleIndex, 1);
    assert.equal(savedSubtitle.hearingImpaired, true);
  } finally {
    config.burn.ffmpegPath = originalFfmpegPath;
    service.value = originalMetadata;
  }
});

test('Plex resource URLs cannot escape the configured server origin', () => {
  const client = new PlexServerClient('http://plex.test:32400', 'secret-token');
  assert.throws(() => client.getResourceRequest('//attacker.example/collect'), /server-relative/);
  assert.deepEqual(
    client.getResourceRequest('/library/metadata/42/thumb'),
    {
      url: 'http://plex.test:32400/library/metadata/42/thumb',
      headers: { 'X-Plex-Token': 'secret-token' },
      maxRedirects: 0,
    }
  );
});

test('Plex resource requests do not forward tokens across redirects', async () => {
  let receivedToken = false;
  const target = http.createServer((req, res) => {
    receivedToken = Boolean(req.headers['x-plex-token']);
    res.end('target');
  });
  await new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve));
  const targetAddress = target.address();
  assert(targetAddress && typeof targetAddress === 'object');
  const redirect = http.createServer((_req, res) => {
    res.writeHead(302, { location: `http://127.0.0.1:${targetAddress.port}/collect` });
    res.end();
  });
  await new Promise<void>(resolve => redirect.listen(0, '127.0.0.1', resolve));
  const redirectAddress = redirect.address();
  assert(redirectAddress && typeof redirectAddress === 'object');
  try {
    const client = new PlexServerClient(`http://127.0.0.1:${redirectAddress.port}`, 'secret-token');
    const resource = client.getResourceRequest('/image');
    await assert.rejects(() => axios.get(resource.url, {
      headers: resource.headers,
      maxRedirects: resource.maxRedirects,
    }));
    assert.equal(receivedToken, false);
  } finally {
    await new Promise<void>(resolve => redirect.close(() => resolve()));
    await new Promise<void>(resolve => target.close(() => resolve()));
  }
});

test('thumbnail paths must belong to the requested media item', async () => {
  const nestedUrl = encodeURIComponent('/photo/:/transcode?url=http://169.254.169.254/latest/meta-data');
  const response = await request(
    `/api/media/thumb/${ratingKey}?path=${nestedUrl}`,
    { headers: { cookie: `librarydownloadarr_session=${encodeURIComponent(adminOneToken)}` } },
    ''
  );
  assert.equal(response.status, 403);
});

test('external subtitle content participates in the burn artifact cache key', () => {
  const first = burnCacheKey('media-fingerprint', '77', 'subtitle-a', 'h264_vaapi', '/dev/dri/renderD128');
  const second = burnCacheKey('media-fingerprint', '77', 'subtitle-b', 'h264_vaapi', '/dev/dri/renderD128');
  assert.notEqual(first, second);
});

test('log redaction removes Plex tokens from URLs and headers', () => {
  const secretToken = 'secret-plex-token-value';
  const error = Object.assign(
    new Error(`Request failed for http://plex.test/image?X-Plex-Token=${secretToken}`),
    {
      config: {
        url: `http://plex.test/image?X-Plex-Token=${secretToken}`,
        headers: {
          Authorization: `Bearer ${secretToken}`,
          'X-Plex-Token': secretToken,
        },
      },
    }
  );
  const serialized = JSON.stringify(redactForLog({ error }));
  assert.equal(serialized.includes(secretToken), false);
  assert.match(serialized, /REDACTED/);
});

test('default Plex polling limit covers the complete two-minute login flow', () => {
  assert(config.rateLimit.plexPollMax >= 60);
});

test('log redaction removes credentials from raw HTTP header strings and arrays', () => {
  const secrets = ['cookie-secret', 'basic-secret', 'plex-secret'];
  const serialized = JSON.stringify(redactForLog({
    request: {
      rawHeader: [
        'Cookie: librarydownloadarr_session=cookie-secret',
        'Authorization: Basic basic-secret',
      ].join('\r\n'),
      rawHeaders: [
        'X-Plex-Token',
        'plex-secret',
        'Cookie',
        'librarydownloadarr_session=cookie-secret',
      ],
    },
  }));
  for (const secretValue of secrets) {
    assert.equal(serialized.includes(secretValue), false);
  }
  assert.match(serialized, /REDACTED/);
});

test('temporary Plex failures do not revoke sessions', async () => {
  const plexUser = db.createOrUpdatePlexUser({
    username: 'outage-user',
    email: 'outage@example.test',
    plexToken: 'server-token',
    plexAccountToken: 'account-token',
    plexId: 'outage-user-id',
  });
  const session = db.createSession(plexUser.id);
  const unavailable = new MockPlexService();
  unavailable.validateExactServerMembership = async () => {
    throw new Error('Plex temporarily unavailable');
  };
  await assert.rejects(
    () => ensurePlexMembership(db, plexUser.id, true, unavailable),
    /temporarily unavailable/
  );
  assert(db.getSessionByToken(session.token));
});

test('expired Plex account authorization revokes sessions', async () => {
  const plexUser = db.createOrUpdatePlexUser({
    username: 'expired-user',
    email: 'expired@example.test',
    plexToken: 'server-token',
    plexAccountToken: 'expired-account-token',
    plexId: 'expired-user-id',
  });
  const session = db.createSession(plexUser.id);
  const unavailable = new MockPlexService();
  unavailable.validateExactServerMembership = async () => {
    throw new PlexAccountUnauthorizedError();
  };
  await assert.rejects(() => ensurePlexMembership(db, plexUser.id, true, unavailable));
  assert.equal(db.getSessionByToken(session.token), undefined);
});

test('FFmpeg command selects exact text and bitmap subtitle streams', () => {
  const text = buildBurnCommand(mediaFile, 'text.mp4', subtitle({ subtitleIndex: 2 }), {
    ffmpegPath: 'ffmpeg',
    encoder: 'libx264',
    qsvDevice: '/dev/dri/renderD128',
  });
  assert.equal(text.kind, 'text');
  assert(text.args.includes(`subtitles='${mediaFile}':si=2`));
  assert.deepEqual(text.args.slice(text.args.indexOf('-map'), text.args.indexOf('-map') + 2), ['-map', '0:v:0']);

  const bitmap = buildBurnCommand(
    mediaFile,
    'bitmap.mp4',
    subtitle({ codec: 'hdmv_pgs_subtitle', subtitleIndex: 3 }),
    { ffmpegPath: 'ffmpeg', encoder: 'h264_qsv', qsvDevice: '/dev/dri/renderD128' }
  );
  assert.equal(bitmap.kind, 'bitmap');
  assert(bitmap.args.includes('[0:v:0][0:s:3]overlay,format=nv12[v]'));
  assert.deepEqual(bitmap.args.slice(0, 4), ['-hide_banner', '-y', '-qsv_device', '/dev/dri/renderD128']);

  const vaapi = buildBurnCommand(mediaFile, 'vaapi.mp4', subtitle(), {
    ffmpegPath: 'ffmpeg',
    encoder: 'h264_vaapi',
    qsvDevice: '/dev/dri/renderD128',
  });
  assert(vaapi.args.includes('-vaapi_device'));
  assert(vaapi.args.includes(`subtitles='${mediaFile}':si=1,format=nv12,hwupload`));
  assert.deepEqual(vaapi.args.slice(vaapi.args.indexOf('-c:v'), vaapi.args.indexOf('-c:v') + 4), [
    '-c:v', 'h264_vaapi', '-qp', '23',
  ]);

  const compatible = buildCompatibleCommand(mediaFile, 'compatible.mp4', 'transcode', {
    ffmpegPath: 'ffmpeg',
    encoder: 'h264_vaapi',
    qsvDevice: '/dev/dri/renderD128',
  });
  assert.equal(compatible.kind, 'compatible');
  assert(compatible.args.includes('format=nv12,hwupload'));
  assert.equal(compatible.args.some(argument => argument.includes('subtitles=') || argument.includes('overlay')), false);
  assert.deepEqual(
    compatible.args.slice(compatible.args.indexOf('-map'), compatible.args.indexOf('-map') + 4),
    ['-map', '0:v:0', '-map', '0:a:0?']
  );

  const remux = buildCompatibleCommand(mediaFile, 'remux.mp4', 'remux', {
    ffmpegPath: 'ffmpeg',
    encoder: 'h264_vaapi',
    qsvDevice: '/dev/dri/renderD128',
  });
  assert(remux.args.includes('copy'));
  assert.equal(remux.args.includes('-vaapi_device'), false);
  assert.equal(remux.args.includes('-vf'), false);

  const audio = buildCompatibleCommand(mediaFile, 'audio.mp4', 'audio', {
    ffmpegPath: 'ffmpeg',
    encoder: 'h264_vaapi',
    qsvDevice: '/dev/dri/renderD128',
  });
  assert.deepEqual(
    audio.args.slice(audio.args.indexOf('-c:v'), audio.args.indexOf('-c:v') + 4),
    ['-c:v', 'copy', '-c:a', 'aac']
  );
  assert.deepEqual(
    audio.args.slice(audio.args.indexOf('-ac'), audio.args.indexOf('-ac') + 4),
    ['-ac', '2', '-b:a', '256k']
  );
});
