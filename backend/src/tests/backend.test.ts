import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import express from 'express';
import axios from 'axios';
import { config } from '../config';
import { createApp } from '../index';
import { DatabaseService } from '../models/database';
import { createMediaRouter } from '../routes/media';
import { buildBurnCommand, burnCacheKey } from '../services/burnService';
import { ensurePlexMembership } from '../services/membershipService';
import { sanitizeMedia } from '../services/mediaSanitizer';
import { redactForLog } from '../utils/logger';
import {
  PlexMedia,
  PlexAccountUnauthorizedError,
  PlexServerAccessDeniedError,
  PlexServerClient,
  PlexService,
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
  constructor(private readonly value: PlexMedia, private readonly denied = false) {
    super('http://plex.test:32400', 'token');
  }

  override async getMediaMetadata(requestedRatingKey: string): Promise<PlexMedia> {
    if (this.denied || requestedRatingKey !== this.value.ratingKey) throw new Error('not accessible');
    return structuredClone(this.value);
  }
}

class MockPlexService extends PlexService {
  revoked = false;
  denyUserMedia = false;
  value = metadata();

  override createServerClient(_serverUrl: string, token: string): PlexServerClient {
    return new MockClient(this.value, this.denyUserMedia && token === 'server-token');
  }

  override async validateExactServerMembership(
    _accountToken: string,
    _machineId: string
  ): Promise<{ serverToken: string; discoveredUrl: string }> {
    if (this.revoked) throw new PlexServerAccessDeniedError();
    return { serverToken: 'server-token', discoveredUrl: 'http://plex.test:32400' };
  }
}

let db: DatabaseService;
let server: http.Server;
let baseUrl: string;
let adminOneToken: string;
let adminTwoToken: string;
const service = new MockPlexService();

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
  db = new DatabaseService(path.join(testRoot, 'test.db'), secret);
  db.setSetting('plex_url', 'http://plex.test:32400');
  db.setSetting('plex_token', 'owner-token');
  db.setSetting('plex_machine_id', 'exact-machine');
  const adminOne = db.createAdminUser({
    username: 'admin-one',
    passwordHash: 'unused',
    email: 'one@example.test',
    isAdmin: true,
  });
  const adminTwo = db.createAdminUser({
    username: 'admin-two',
    passwordHash: 'unused',
    email: 'two@example.test',
    isAdmin: true,
  });
  adminOneToken = db.createSession(adminOne.id).token;
  adminTwoToken = db.createSession(adminTwo.id).token;

  const app = express();
  app.use(express.json());
  app.use('/api/media', createMediaRouter(db, {
    plex: service,
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
  assert.deepEqual(result, { serverUrl: null, accessToken: null, matched: false });
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
});
