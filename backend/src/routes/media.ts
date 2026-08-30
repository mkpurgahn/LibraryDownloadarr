import axios from 'axios';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import { config } from '../config';
import { AuthRequest, createAuthMiddleware } from '../middleware/auth';
import { BurnJob, DatabaseService } from '../models/database';
import {
  buildBurnCommand,
  BurnManager,
  burnCacheKey,
  classifySubtitle,
  COMPATIBLE_STREAM_ID,
} from '../services/burnService';
import { streamLocalFile } from '../services/downloadService';
import { ensurePlexMembership, MembershipError } from '../services/membershipService';
import {
  canonicalizeMediaPath,
  ensureAccessiblePart,
  fingerprintContents,
  fingerprintFile,
  resolveAuthorizedPart,
} from '../services/mediaAccess';
import { sanitizeMedia, sanitizeMediaList } from '../services/mediaSanitizer';
import {
  OnlineSubtitleResultUnavailableError,
  OnlineSubtitleService,
  OnlineSubtitleUnsupportedError,
} from '../services/onlineSubtitleService';
import { PlexMedia, PlexServerClient, PlexService, plexService } from '../services/plexService';
import { cachePlexSubtitle } from '../services/subtitleCache';
import { probeEmbeddedSubtitles } from '../services/subtitleProbe';
import { logger } from '../utils/logger';
import { readSessionCookie } from '../utils/sessionCookie';

interface MediaRouterDependencies {
  plex?: PlexService;
  burnManager?: BurnManager;
  onlineSubtitles?: OnlineSubtitleService;
}

const validRatingKey = (value: string): boolean => /^[A-Za-z0-9._:-]{1,128}$/.test(value);
const validPartKey = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 512 && /^\/library\/parts\/[^?#]+$/.test(value);
const validStreamId = (value: unknown): boolean =>
  (typeof value === 'string' || typeof value === 'number') && /^[A-Za-z0-9._:-]{1,128}$/.test(String(value));
const validSubtitleLanguage = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-z]{2}$/.test(value);
const validId = (value: string): boolean => /^[A-Za-z0-9_-]{10,128}$/.test(value);
const downloadTicketUrl = (token: string): string => {
  const pathname = `/api/media/downloads/${encodeURIComponent(token)}`;
  return config.media.publicDownloadOrigin
    ? `${config.media.publicDownloadOrigin}${pathname}`
    : pathname;
};

const compatibleJobDetails = (job: BurnJob): { mode: 'compatible' | 'subtitle'; strategy?: string } => {
  if (job.subtitleStreamId !== COMPATIBLE_STREAM_ID) return { mode: 'subtitle' };
  try {
    const strategy = (JSON.parse(job.subtitleJson) as { strategy?: string }).strategy;
    return { mode: 'compatible', strategy };
  } catch {
    return { mode: 'compatible' };
  }
};

const chooseCompatibleStrategy = (
  mediaVersion: { videoCodec?: string; audioCodec?: string },
  streams: any[] = []
): 'remux' | 'audio' | 'transcode' => {
  const videoCodec = String(
    streams.find(stream => Number(stream.streamType ?? stream.streamTypeId) === 1)?.codec ||
    mediaVersion.videoCodec ||
    ''
  ).toLowerCase();
  const audioCodec = String(
    streams.find(stream => Number(stream.streamType ?? stream.streamTypeId) === 2)?.codec ||
    mediaVersion.audioCodec ||
    ''
  ).toLowerCase();
  const videoCompatible = ['h264', 'avc', 'avc1'].includes(videoCodec);
  const audioCompatible = ['aac', 'mp4a'].includes(audioCodec);
  if (!videoCompatible) return 'transcode';
  return audioCompatible ? 'remux' : 'audio';
};

const publicJob = (job: BurnJob): object => ({
  ...compatibleJobDetails(job),
  id: job.id,
  ratingKey: job.ratingKey,
  partKey: job.partKey,
  subtitleStreamId: job.subtitleStreamId,
  status: job.status,
  progress: job.progress,
  error: job.error || null,
  filename: job.filename || null,
  size: job.size ?? null,
  createdAt: new Date(job.createdAt).toISOString(),
  updatedAt: new Date(job.updatedAt).toISOString(),
});

const formattedMediaTitle = (metadata: any): string => {
  const library = metadata.librarySectionTitle || 'Unknown Library';
  if (metadata.type === 'episode') {
    return `${library} - ${metadata.grandparentTitle || 'Unknown Show'} - ${metadata.parentTitle || 'Unknown Season'} - E${String(metadata.index || 0).padStart(2, '0')} - ${metadata.title || 'Unknown Episode'}`;
  }
  if (metadata.type === 'track') {
    return `${library} - ${metadata.parentTitle || 'Unknown Album'} - ${metadata.title || 'Unknown Track'}`;
  }
  return `${library} - ${metadata.title || 'Unknown Media'}`;
};

export const createMediaRouter = (
  db: DatabaseService,
  dependencies: MediaRouterDependencies = {}
) => {
  const router = Router();
  const service = dependencies.plex || plexService;
  const burnManager = dependencies.burnManager || new BurnManager(db);
  const onlineSubtitles = dependencies.onlineSubtitles || new OnlineSubtitleService();
  const authMiddleware = createAuthMiddleware(db, service);
  const creationLimiter = rateLimit({
    windowMs: config.rateLimit.windowMs,
    limit: config.rateLimit.creationMax,
    standardHeaders: true,
    legacyHeaders: false,
  });

  const credentials = (req: AuthRequest): { user: PlexServerClient; owner: PlexServerClient; serverUrl: string } => {
    const serverUrl = db.getSetting('plex_url');
    const ownerToken = db.getSetting('plex_token');
    const userToken = req.user?.plexToken || (req.user?.isAdmin ? ownerToken : undefined);
    if (!serverUrl || !ownerToken || !userToken) {
      throw new Error('Plex server and owner token must be configured');
    }
    return {
      user: service.createServerClient(serverUrl, userToken),
      owner: service.createServerClient(serverUrl, ownerToken),
      serverUrl,
    };
  };

  const forceMembership = async (req: AuthRequest): Promise<void> => {
    if (!req.user?.isAdmin) {
      const refreshed = await ensurePlexMembership(db, req.user!.id, true, service);
      req.user!.plexToken = refreshed!.plexToken;
    }
  };

  const needsEmbeddedSubtitleHydration = (metadata: PlexMedia): boolean =>
    (metadata.Media || []).some(media =>
      (media.Part || []).some(part =>
        (part.subtitles?.length || 0) === 0 &&
        !(part.Stream || []).some(
          stream => Number(stream.streamType ?? stream.streamTypeId) === 3
        )
      )
    );

  const hydrateMissingEmbeddedSubtitles = async (
    metadata: PlexMedia,
    ownerMetadata: PlexMedia
  ): Promise<PlexMedia> => {
    const ownerParts = ownerMetadata.Media?.flatMap(media => media.Part || []) || [];
    for (const media of metadata.Media || []) {
      for (const part of media.Part || []) {
        const hasPlexSubtitles =
          (part.subtitles?.length || 0) > 0 ||
          (part.Stream || []).some(
            stream => Number(stream.streamType ?? stream.streamTypeId) === 3
          );
        if (hasPlexSubtitles) continue;
        const ownerPart = ownerParts.find(candidate => candidate.key === part.key);
        if (!ownerPart?.file) continue;
        try {
          const sourcePath = await canonicalizeMediaPath(ownerPart.file, config.media.roots);
          const sourceFingerprint = await fingerprintFile(sourcePath);
          const subtitles = await probeEmbeddedSubtitles(sourcePath, sourceFingerprint);
          if (subtitles.length === 0) continue;
          part.subtitles = subtitles;
          part.Stream = [
            ...(part.Stream || []),
            ...subtitles.map(track => ({
              id: track.id,
              index: track.index,
              streamType: 3,
              codec: track.codec,
              language: track.language,
              languageCode: track.languageCode,
              title: track.title,
              displayTitle: track.title,
              forced: track.forced,
              hearingImpaired: track.hearingImpaired,
              embedded: true,
            })),
          ];
        } catch (error) {
          logger.warn('Embedded subtitle probe failed', {
            ratingKey: metadata.ratingKey,
            partKey: part.key,
            error,
          });
        }
      }
    }
    return metadata;
  };

  const createCompatiblePreparation = (
    userId: string,
    ratingKey: string,
    partKey: string,
    authorized: Awaited<ReturnType<typeof resolveAuthorizedPart>>
  ): BurnJob => {
    const videoCodec = String(
      authorized.part.Stream?.find(
        stream => Number(stream.streamType ?? stream.streamTypeId) === 1
      )?.codec ||
      authorized.mediaVersion.videoCodec ||
      ''
    );
    if (!videoCodec) {
      throw new Error('Compatible MP4 requires a media part with a video stream');
    }
    const strategy = chooseCompatibleStrategy(
      authorized.mediaVersion,
      authorized.part.Stream
    );
    const cacheKey = burnCacheKey(
      authorized.sourceFingerprint,
      COMPATIBLE_STREAM_ID,
      strategy,
      strategy === 'transcode' ? config.burn.encoder : 'copy',
      strategy === 'transcode' ? config.burn.qsvDevice : ''
    );
    const filename = `${path.parse(authorized.sourcePath).name}.mp4`;
    const artifact = db.getArtifactByCacheKey(cacheKey);
    const job = db.createBurnJob({
      userId,
      ratingKey,
      partKey,
      subtitleStreamId: COMPATIBLE_STREAM_ID,
      sourcePath: authorized.sourcePath,
      sourceFingerprint: authorized.sourceFingerprint,
      cacheKey,
      error: undefined,
      filename,
      size: artifact?.size,
      artifactId: artifact?.id,
      mediaDurationMs: authorized.part.duration || authorized.metadata.duration,
      subtitleJson: JSON.stringify({ strategy }),
    });
    if (artifact && fs.existsSync(artifact.filePath)) {
      db.updateBurnJob(job.id, {
        status: 'ready',
        progress: 100,
        artifactId: artifact.id,
        filename: artifact.filename,
        size: artifact.size,
      });
    } else {
      burnManager.enqueue(job);
    }
    return db.getBurnJob(job.id)!;
  };

  const validateTicketAccess = async (ticket: BurnJob | {
    userId: string;
    ratingKey: string;
    partKey: string;
  }): Promise<void> => {
    if (db.getAdminUserById(ticket.userId)) return;
    const user = await ensurePlexMembership(db, ticket.userId, true, service);
    const serverUrl = db.getSetting('plex_url');
    if (!user?.plexToken || !serverUrl) {
      throw new MembershipError('Plex sign-in must be renewed');
    }
    await ensureAccessiblePart(
      ticket.ratingKey,
      ticket.partKey,
      service.createServerClient(serverUrl, user.plexToken)
    );
  };

  const handleRouteError = (res: any, error: unknown, message: string): any => {
    if (res.headersSent) {
      res.destroy(error instanceof Error ? error : undefined);
      return;
    }
    if (error instanceof MembershipError) {
      return res.status(403).json({ error: error.message, code: 'PLEX_ACCESS_REVOKED' });
    }
    if (error instanceof OnlineSubtitleResultUnavailableError) {
      return res.status(410).json({ error: error.message });
    }
    if (error instanceof OnlineSubtitleUnsupportedError) {
      return res.status(422).json({ error: error.message });
    }
    const detail = error instanceof Error ? error.message : message;
    logger.error(message, { error });
    if (/does not belong|not accessible|cannot resolve|outside MEDIA_ROOTS|not configured/.test(detail)) {
      return res.status(403).json({ error: detail });
    }
    if (/Unsupported subtitle|Subtitle track|no local file|External subtitle|requires a media part with a video stream|Plex did not finish downloading/.test(detail)) {
      return res.status(422).json({ error: detail });
    }
    if (/changed since the ticket|ticket must be renewed/.test(detail)) {
      return res.status(409).json({ error: detail });
    }
    return res.status(500).json({ error: message });
  };

  router.route('/downloads/:ticket')
    .get(async (req, res) => {
      if (!validId(req.params.ticket)) return res.status(404).json({ error: 'Download ticket not found' });
      const ticket = db.getDownloadTicket(req.params.ticket);
      if (!ticket) return res.status(404).json({ error: 'Download ticket expired or invalid' });
      try {
        await validateTicketAccess(ticket);
        const filePath = await canonicalizeMediaPath(
          ticket.filePath,
          ticket.artifactId ? [config.burn.cacheDir] : config.media.roots
        );
        await streamLocalFile(req, res, filePath, ticket.filename, ticket.sourceFingerprint);
        return;
      } catch (error) {
        return handleRouteError(res, error, 'Download failed');
      }
    })
    .head(async (req, res) => {
      if (!validId(req.params.ticket)) return res.status(404).end();
      const ticket = db.getDownloadTicket(req.params.ticket);
      if (!ticket) return res.status(404).end();
      try {
        await validateTicketAccess(ticket);
        const filePath = await canonicalizeMediaPath(
          ticket.filePath,
          ticket.artifactId ? [config.burn.cacheDir] : config.media.roots
        );
        await streamLocalFile(req, res, filePath, ticket.filename, ticket.sourceFingerprint);
        return;
      } catch (error) {
        return handleRouteError(res, error, 'Download failed');
      }
    });

  router.get('/burn-jobs/:jobId', authMiddleware, (req: AuthRequest, res) => {
    if (!validId(req.params.jobId)) return res.status(404).json({ error: 'Burn job not found' });
    const job = db.getBurnJob(req.params.jobId);
    if (!job || job.userId !== req.user!.id) return res.status(404).json({ error: 'Burn job not found' });
    return res.json({ job: publicJob(job) });
  });

  router.delete('/burn-jobs/:jobId', authMiddleware, (req: AuthRequest, res) => {
    if (!validId(req.params.jobId)) return res.status(404).json({ error: 'Burn job not found' });
    const result = burnManager.cancel(req.params.jobId, req.user!.id);
    if (!result.job) return res.status(404).json({ error: 'Burn job not found' });
    return res.json({ cancelled: result.cancelled, job: publicJob(result.job) });
  });

  router.post(
    '/burn-jobs/:jobId/ticket',
    creationLimiter,
    authMiddleware,
    async (req: AuthRequest, res) => {
      try {
        if (!validId(req.params.jobId)) return res.status(404).json({ error: 'Burn job not found' });
        await forceMembership(req);
        const job = db.getBurnJob(req.params.jobId);
        if (!job || job.userId !== req.user!.id) return res.status(404).json({ error: 'Burn job not found' });
        await ensureAccessiblePart(job.ratingKey, job.partKey, credentials(req).user);
        if (job.status !== 'ready' || !job.artifactId) {
          return res.status(409).json({ error: 'Burn job is not ready' });
        }
        const artifact = db.getArtifact(job.artifactId);
        if (!artifact || artifact.expiresAt <= Date.now()) {
          return res.status(410).json({ error: 'Burn artifact expired' });
        }
        const artifactPath = await canonicalizeMediaPath(artifact.filePath, [config.burn.cacheDir]);
        const expiresAt = Math.min(Date.now() + config.media.ticketTtlMs, artifact.expiresAt);
        const ticket = db.createDownloadTicket({
          userId: req.user!.id,
          ratingKey: job.ratingKey,
          partKey: job.partKey,
          filePath: artifactPath,
          sourceFingerprint: await fingerprintFile(artifactPath),
          artifactId: artifact.id,
          filename: artifact.filename,
          expiresAt,
        });
        return res.json({
          url: downloadTicketUrl(ticket.token),
          expiresAt: new Date(expiresAt).toISOString(),
          filename: ticket.filename,
        });
      } catch (error) {
        return handleRouteError(res, error, 'Failed to create derivative ticket');
      }
    }
  );

  router.post(
    '/download-tickets',
    creationLimiter,
    authMiddleware,
    async (req: AuthRequest, res) => {
      const items = req.body?.items;
      if (!Array.isArray(items) || items.length === 0 || items.length > 100) {
        return res.status(400).json({ error: 'Select between 1 and 100 media files.' });
      }
      if (
        items.some(
          (item) =>
            !item ||
            typeof item !== 'object' ||
            !validRatingKey(String(item.ratingKey || '')) ||
            !validPartKey(item.partKey)
        )
      ) {
        return res.status(400).json({ error: 'Every selected file requires a valid ratingKey and partKey.' });
      }

      try {
        await forceMembership(req);
        const clients = credentials(req);
        const uniqueItems = Array.from(
          new Map(
            items.map((item) => [
              `${item.ratingKey}:${item.partKey}`,
              { ratingKey: String(item.ratingKey), partKey: String(item.partKey) },
            ])
          ).values()
        );
        const tickets: object[] = [];
        const errors: object[] = [];

        for (const item of uniqueItems) {
          try {
            const authorized = await resolveAuthorizedPart(
              item.ratingKey,
              item.partKey,
              clients.user,
              clients.owner,
              config.media.roots
            );
            const filename = path.basename(authorized.sourcePath);
            const expiresAt = Date.now() + config.media.ticketTtlMs;
            const ticket = db.createDownloadTicket({
              userId: req.user!.id,
              ratingKey: item.ratingKey,
              partKey: item.partKey,
              filePath: authorized.sourcePath,
              sourceFingerprint: authorized.sourceFingerprint,
              filename,
              expiresAt,
            });
            db.logDownload(
              req.user!.id,
              formattedMediaTitle(authorized.metadata),
              item.ratingKey,
              authorized.part.size
            );
            tickets.push({
              ratingKey: item.ratingKey,
              partKey: item.partKey,
              url: downloadTicketUrl(ticket.token),
              expiresAt: new Date(expiresAt).toISOString(),
              filename,
            });
          } catch (error) {
            logger.warn('Selected media file could not be ticketed', {
              ratingKey: item.ratingKey,
              partKey: item.partKey,
              error,
            });
            errors.push({
              ratingKey: item.ratingKey,
              partKey: item.partKey,
              error: 'This file is no longer available to download.',
            });
          }
        }

        return res.json({ tickets, errors });
      } catch (error) {
        return handleRouteError(res, error, 'Failed to create selected download tickets');
      }
    }
  );

  router.post(
    '/:ratingKey/download-ticket',
    creationLimiter,
    authMiddleware,
    async (req: AuthRequest, res) => {
      const { ratingKey } = req.params;
      const { partKey } = req.body;
      if (!validRatingKey(ratingKey) || !validPartKey(partKey)) {
        return res.status(400).json({ error: 'Valid ratingKey and partKey are required' });
      }
      try {
        await forceMembership(req);
        const clients = credentials(req);
        const authorized = await resolveAuthorizedPart(
          ratingKey, partKey, clients.user, clients.owner, config.media.roots
        );
        const filename = path.basename(authorized.sourcePath);
        const expiresAt = Date.now() + config.media.ticketTtlMs;
        const ticket = db.createDownloadTicket({
          userId: req.user!.id,
          ratingKey,
          partKey,
          filePath: authorized.sourcePath,
          sourceFingerprint: authorized.sourceFingerprint,
          filename,
          expiresAt,
        });
        db.logDownload(
          req.user!.id,
          formattedMediaTitle(authorized.metadata),
          ratingKey,
          authorized.part.size
        );
        return res.json({
          url: downloadTicketUrl(ticket.token),
          expiresAt: new Date(expiresAt).toISOString(),
          filename,
        });
      } catch (error) {
        return handleRouteError(res, error, 'Failed to create download ticket');
      }
    }
  );

  router.post(
    '/compatible-jobs',
    creationLimiter,
    authMiddleware,
    async (req: AuthRequest, res) => {
      const items = req.body?.items;
      if (!Array.isArray(items) || items.length === 0 || items.length > 100) {
        return res.status(400).json({ error: 'Select between 1 and 100 media files.' });
      }
      if (
        items.some(
          item =>
            !item ||
            typeof item !== 'object' ||
            !validRatingKey(String(item.ratingKey || '')) ||
            !validPartKey(item.partKey)
        )
      ) {
        return res.status(400).json({
          error: 'Every selected file requires a valid ratingKey and partKey.',
        });
      }

      try {
        await forceMembership(req);
        const clients = credentials(req);
        const uniqueItems = Array.from(
          new Map(
            items.map(item => [
              `${item.ratingKey}:${item.partKey}`,
              { ratingKey: String(item.ratingKey), partKey: String(item.partKey) },
            ])
          ).values()
        );
        const jobs: object[] = [];
        const errors: object[] = [];
        for (const item of uniqueItems) {
          try {
            const authorized = await resolveAuthorizedPart(
              item.ratingKey,
              item.partKey,
              clients.user,
              clients.owner,
              config.media.roots
            );
            jobs.push(publicJob(createCompatiblePreparation(
              req.user!.id,
              item.ratingKey,
              item.partKey,
              authorized
            )));
          } catch (error) {
            logger.warn('Selected media file could not be prepared as MP4', {
              ratingKey: item.ratingKey,
              partKey: item.partKey,
              error,
            });
            errors.push({
              ratingKey: item.ratingKey,
              partKey: item.partKey,
              error: 'This file could not be prepared as MP4.',
            });
          }
        }
        return res.status(202).json({ jobs, errors });
      } catch (error) {
        return handleRouteError(res, error, 'Failed to prepare selected MP4 files');
      }
    }
  );

  router.post(
    '/:ratingKey/compatible-jobs',
    creationLimiter,
    authMiddleware,
    async (req: AuthRequest, res) => {
      const { ratingKey } = req.params;
      const { partKey } = req.body;
      if (!validRatingKey(ratingKey) || !validPartKey(partKey)) {
        return res.status(400).json({ error: 'Valid ratingKey and partKey are required' });
      }
      try {
        await forceMembership(req);
        const clients = credentials(req);
        const authorized = await resolveAuthorizedPart(
          ratingKey,
          partKey,
          clients.user,
          clients.owner,
          config.media.roots
        );
        const job = createCompatiblePreparation(
          req.user!.id,
          ratingKey,
          partKey,
          authorized
        );
        return res.status(202).json({ job: publicJob(job) });
      } catch (error) {
        return handleRouteError(res, error, 'Failed to create compatible MP4 job');
      }
    }
  );

  router.post(
    '/:ratingKey/burn-jobs',
    creationLimiter,
    authMiddleware,
    async (req: AuthRequest, res) => {
      const { ratingKey } = req.params;
      const { partKey, subtitleStreamId } = req.body;
      if (!validRatingKey(ratingKey) || !validPartKey(partKey) || !validStreamId(subtitleStreamId)) {
        return res.status(400).json({ error: 'Valid ratingKey, partKey, and subtitleStreamId are required' });
      }
      try {
        await forceMembership(req);
        const clients = credentials(req);
        const onlineResultId = String(subtitleStreamId);
        const isOnlineResult = onlineSubtitles.isResultId(onlineResultId);
        const authorized = await resolveAuthorizedPart(
          ratingKey,
          partKey,
          clients.user,
          clients.owner,
          config.media.roots,
          isOnlineResult ? undefined : onlineResultId
        );
        const subtitle = isOnlineResult
          ? await onlineSubtitles.acquire({
            userId: req.user!.id,
            ratingKey,
            partKey,
            resultId: onlineResultId,
            client: clients.user,
          })
          : authorized.subtitle!;
        await cachePlexSubtitle(subtitle, clients.owner);
        classifySubtitle(subtitle.codec);
        let subtitleFingerprint = '';
        if (subtitle.external) {
          if (!subtitle.file) throw new Error('External subtitle track has no local file path');
          subtitle.file = await canonicalizeMediaPath(
            subtitle.file,
            [...config.media.roots, config.burn.cacheDir]
          );
          subtitleFingerprint = await fingerprintContents(subtitle.file);
          if (isOnlineResult) subtitle.id = `online-${subtitleFingerprint}`;
        }
        buildBurnCommand(authorized.sourcePath, 'validation.mp4', subtitle, config.burn);
        const cacheKey = burnCacheKey(
          authorized.sourceFingerprint,
          subtitle.id,
          subtitleFingerprint,
          config.burn.encoder,
          config.burn.qsvDevice
        );
        const filename = `${path.parse(authorized.sourcePath).name}.${subtitle.languageCode || subtitle.language || 'subtitled'}.mp4`;
        const artifact = db.getArtifactByCacheKey(cacheKey);
        const job = db.createBurnJob({
          userId: req.user!.id,
          ratingKey,
          partKey,
          subtitleStreamId: subtitle.id,
          sourcePath: authorized.sourcePath,
          sourceFingerprint: authorized.sourceFingerprint,
          subtitleFingerprint: subtitleFingerprint || undefined,
          cacheKey,
          error: undefined,
          filename,
          size: artifact?.size,
          artifactId: artifact?.id,
          mediaDurationMs: authorized.part.duration || authorized.metadata.duration,
          subtitleJson: JSON.stringify(subtitle),
        });
        if (artifact && fs.existsSync(artifact.filePath)) {
          db.updateBurnJob(job.id, {
            status: 'ready', progress: 100, artifactId: artifact.id,
            filename: artifact.filename, size: artifact.size,
          });
        } else {
          burnManager.enqueue(job);
        }
        return res.status(202).json({ job: publicJob(db.getBurnJob(job.id)!) });
      } catch (error) {
        return handleRouteError(res, error, 'Failed to create subtitle burn job');
      }
    }
  );

  router.get('/recently-added', authMiddleware, async (req: AuthRequest, res) => {
    try {
      const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
      const media = await credentials(req).user.getRecentlyAdded(limit);
      return res.json({ media: sanitizeMediaList(media) });
    } catch (error) {
      return handleRouteError(res, error, 'Failed to get recently added media');
    }
  });

  router.get(
    '/:ratingKey/subtitle-search',
    creationLimiter,
    authMiddleware,
    async (req: AuthRequest, res) => {
      const { ratingKey } = req.params;
      const partKey = typeof req.query.partKey === 'string' ? req.query.partKey : '';
      const language = typeof req.query.language === 'string'
        ? req.query.language.trim().toLowerCase()
        : '';
      if (
        !validRatingKey(ratingKey) ||
        !validPartKey(partKey) ||
        !validSubtitleLanguage(language)
      ) {
        return res.status(400).json({
          error: 'Valid ratingKey, partKey, and two-letter subtitle language are required',
        });
      }
      try {
        await forceMembership(req);
        const client = credentials(req).user;
        const metadata = await ensureAccessiblePart(ratingKey, partKey, client);
        const mediaVersion = metadata.Media?.find(media =>
          (media.Part || []).some(part => part.key === partKey)
        );
        const hasVideo = Boolean(
          mediaVersion?.videoCodec ||
          mediaVersion?.Part
            ?.find(part => part.key === partKey)
            ?.Stream?.some(stream =>
              Number(stream.streamType ?? stream.streamTypeId) === 1
            )
        );
        if (!hasVideo) {
          return res.status(422).json({ error: 'Subtitle search is only available for video files' });
        }
        const result = await onlineSubtitles.search({
          userId: req.user!.id,
          ratingKey,
          partKey,
          language,
          mediaItemId: mediaVersion?.id,
          client,
        });
        return res.json({
          results: result.results,
          expiresAt: new Date(result.expiresAt).toISOString(),
        });
      } catch (error) {
        return handleRouteError(res, error, 'Plex subtitle search failed');
      }
    }
  );

  router.get('/download-history', authMiddleware, (req: AuthRequest, res) => {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    return res.json({ history: db.getDownloadHistory(req.user!.id, limit) });
  });

  router.get('/download-history/all', authMiddleware, (req: AuthRequest, res) => {
    if (!req.user?.isAdmin) return res.status(403).json({ error: 'Admin access required' });
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
    return res.json({ history: db.getAllDownloadHistory(limit) });
  });

  router.get('/download-stats', authMiddleware, (_req, res) => res.json({ stats: db.getDownloadStats() }));

  router.get('/search', authMiddleware, async (req: AuthRequest, res) => {
    const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (query.length < 2 || query.length > 200) return res.status(400).json({ error: 'Invalid search query' });
    try {
      const results = await credentials(req).user.search(query);
      return res.json({ results: sanitizeMediaList(results) });
    } catch (error) {
      return handleRouteError(res, error, 'Search failed');
    }
  });

  router.get('/season/:seasonRatingKey/size', authMiddleware, async (req: AuthRequest, res) => {
    try {
      const episodes = await credentials(req).user.getEpisodes(req.params.seasonRatingKey);
      const parts = episodes.flatMap(item => item.Media?.flatMap(media => media.Part || []) || []);
      const totalSize = parts.reduce((sum, part) => sum + (part.size || 0), 0);
      return res.json({ totalSize, fileCount: parts.length, totalSizeGB: (totalSize / 1073741824).toFixed(2) });
    } catch (error) {
      return handleRouteError(res, error, 'Failed to get season size');
    }
  });

  router.get('/album/:albumRatingKey/size', authMiddleware, async (req: AuthRequest, res) => {
    try {
      const tracks = await credentials(req).user.getTracks(req.params.albumRatingKey);
      const parts = tracks.flatMap(item => item.Media?.flatMap(media => media.Part || []) || []);
      const totalSize = parts.reduce((sum, part) => sum + (part.size || 0), 0);
      return res.json({ totalSize, fileCount: parts.length, totalSizeGB: (totalSize / 1073741824).toFixed(2) });
    } catch (error) {
      return handleRouteError(res, error, 'Failed to get album size');
    }
  });

  const bulkDownloadRemoved = (_req: AuthRequest, res: any): any =>
    res.status(410).json({
      error: 'Bulk ZIP downloads were removed because they are not resumable. Download individual files instead.',
    });
  router.get('/season/:seasonRatingKey/download', authMiddleware, bulkDownloadRemoved);
  router.get('/album/:albumRatingKey/download', authMiddleware, bulkDownloadRemoved);

  router.get('/thumb/:ratingKey', async (req: AuthRequest, res) => {
    const imagePath = typeof req.query.path === 'string' ? req.query.path : '';
    const sessionToken = readSessionCookie(req);
    if (!imagePath.startsWith('/') || imagePath.startsWith('//') || imagePath.length > 1024) {
      return res.status(400).json({ error: 'A valid thumbnail path is required' });
    }
    if (!sessionToken) return res.status(401).json({ error: 'Thumbnail session is required' });
    const session = db.getSessionByToken(sessionToken);
    if (!session) return res.status(401).json({ error: 'Invalid session' });
    try {
      const user = await ensurePlexMembership(db, session.userId, false, service);
      const token = user?.plexToken;
      const serverUrl = db.getSetting('plex_url');
      if (!token || !serverUrl) return res.status(403).json({ error: 'Plex access unavailable' });
      if (!validRatingKey(req.params.ratingKey)) {
        return res.status(400).json({ error: 'Invalid ratingKey' });
      }
      const client = service.createServerClient(serverUrl, token);
      const metadata = await client.getMediaMetadata(req.params.ratingKey);
      if (imagePath !== metadata.thumb && imagePath !== metadata.art) {
        return res.status(403).json({ error: 'Thumbnail path does not belong to the requested media item' });
      }
      const resource = client.getResourceRequest(imagePath);
      const response = await axios.get(resource.url, {
        headers: resource.headers,
        maxRedirects: resource.maxRedirects,
        responseType: 'stream',
        httpsAgent: new https.Agent({ rejectUnauthorized: !config.plex.allowInsecureTls }),
      });
      res.setHeader('Content-Type', response.headers['content-type'] || 'image/jpeg');
      if (response.headers['content-length']) res.setHeader('Content-Length', response.headers['content-length']);
      await pipeline(response.data, res);
      return;
    } catch (error) {
      return handleRouteError(res, error, 'Failed to load thumbnail');
    }
  });

  router.get('/:ratingKey/seasons', authMiddleware, async (req: AuthRequest, res) => {
    try {
      const seasons = await credentials(req).user.getSeasons(req.params.ratingKey);
      return res.json({ seasons: sanitizeMediaList(seasons) });
    } catch (error) {
      return handleRouteError(res, error, 'Failed to get seasons');
    }
  });

  router.get('/:ratingKey/episodes', authMiddleware, async (req: AuthRequest, res) => {
    try {
      const clients = credentials(req);
      const episodes = await clients.user.getEpisodes(req.params.ratingKey);
      const pending = episodes.filter(needsEmbeddedSubtitleHydration);
      if (pending.length > 0) {
        const ownerEpisodes = await clients.owner.getEpisodes(req.params.ratingKey);
        const ownerByRatingKey = new Map(
          ownerEpisodes.map(episode => [episode.ratingKey, episode])
        );
        await Promise.all(
          pending.map(episode => {
            const ownerEpisode = ownerByRatingKey.get(episode.ratingKey);
            return ownerEpisode
              ? hydrateMissingEmbeddedSubtitles(episode, ownerEpisode)
              : Promise.resolve(episode);
          })
        );
      }
      return res.json({ episodes: sanitizeMediaList(episodes) });
    } catch (error) {
      return handleRouteError(res, error, 'Failed to get episodes');
    }
  });

  router.get('/:ratingKey/tracks', authMiddleware, async (req: AuthRequest, res) => {
    try {
      const tracks = await credentials(req).user.getTracks(req.params.ratingKey);
      return res.json({ tracks: sanitizeMediaList(tracks) });
    } catch (error) {
      return handleRouteError(res, error, 'Failed to get tracks');
    }
  });

  router.get('/:ratingKey/download', authMiddleware, (_req, res) =>
    res.status(410).json({ error: 'Use POST /api/media/:ratingKey/download-ticket for resumable downloads' }));

  router.get('/:ratingKey', authMiddleware, async (req: AuthRequest, res) => {
    if (!validRatingKey(req.params.ratingKey)) return res.status(400).json({ error: 'Invalid ratingKey' });
    try {
      const clients = credentials(req);
      const metadata = await clients.user.getMediaMetadata(req.params.ratingKey);
      if (needsEmbeddedSubtitleHydration(metadata)) {
        const ownerMetadata = await clients.owner.getMediaMetadata(req.params.ratingKey);
        await hydrateMissingEmbeddedSubtitles(metadata, ownerMetadata);
      }
      return res.json({ metadata: sanitizeMedia(metadata) });
    } catch (error) {
      return handleRouteError(res, error, 'Failed to get media metadata');
    }
  });

  return router;
};
