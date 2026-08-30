import path from 'path';

const intFromEnv = (name: string, fallback: number): number => {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

const boolFromEnv = (name: string, fallback = false): boolean => {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
};

const listFromEnv = (name: string): string[] =>
  (process.env[name] || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
    .map(value => path.resolve(value));

const originFromEnv = (name: string): string => {
  const value = (process.env[name] || '').trim();
  if (!value) return '';

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute HTTPS origin`);
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`${name} must be an HTTPS origin without credentials, a path, query, or fragment`);
  }
  return parsed.origin;
};

export const config = {
  server: {
    port: intFromEnv('PORT', 5069),
    trustProxyHops: Math.min(10, intFromEnv('TRUST_PROXY_HOPS', 0)),
  },
  plex: {
    clientIdentifier: 'librarydownloadarr',
    product: 'LibraryDownloadarr',
    version: '1.0.0',
    device: 'Server',
    allowInsecureTls: boolFromEnv('PLEX_ALLOW_INSECURE_TLS'),
    membershipTtlMs: intFromEnv('PLEX_MEMBERSHIP_TTL_SECONDS', 300) * 1000,
    requestTimeoutMs: Math.max(1000, intFromEnv('PLEX_REQUEST_TIMEOUT_SECONDS', 30) * 1000),
  },
  database: {
    path: process.env.DATABASE_PATH || path.join(process.cwd(), 'data', 'librarydownloadarr.db'),
    encryptionKey: process.env.TOKEN_ENCRYPTION_KEY || '',
  },
  media: {
    roots: listFromEnv('MEDIA_ROOTS'),
    ticketTtlMs: intFromEnv('DOWNLOAD_TICKET_TTL_SECONDS', 24 * 60 * 60) * 1000,
    publicDownloadOrigin: originFromEnv('DOWNLOAD_PUBLIC_ORIGIN'),
  },
  burn: {
    cacheDir: path.resolve(process.env.BURN_CACHE_DIR || path.join(process.cwd(), 'data', 'burn-cache')),
    ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
    encoder: process.env.FFMPEG_VIDEO_ENCODER || 'libx264',
    qsvDevice: process.env.FFMPEG_QSV_DEVICE || '/dev/dri/renderD128',
    globalConcurrency: Math.max(1, intFromEnv('BURN_GLOBAL_CONCURRENCY', 1)),
    perUserConcurrency: Math.max(1, intFromEnv('BURN_PER_USER_CONCURRENCY', 1)),
    artifactTtlMs: intFromEnv('BURN_ARTIFACT_TTL_HOURS', 168) * 60 * 60 * 1000,
    maxCacheBytes: intFromEnv('BURN_CACHE_MAX_GB', 100) * 1024 * 1024 * 1024,
  },
  logging: {
    level: process.env.LOG_LEVEL || 'info',
  },
  cors: {
    origin: process.env.CORS_ORIGIN || '*',
    credentials: true,
    exposedHeaders: [
      'Accept-Ranges',
      'Content-Length',
      'Content-Range',
      'Content-Disposition',
      'ETag',
    ],
  },
  rateLimit: {
    windowMs: 15 * 60 * 1000, // 15 minutes
    globalMax: 10000,
    loginMax: intFromEnv('LOGIN_RATE_LIMIT', 10),
    plexPollMax: intFromEnv('PLEX_POLL_RATE_LIMIT', 75),
    creationMax: intFromEnv('CREATION_RATE_LIMIT', 30),
  },
};
