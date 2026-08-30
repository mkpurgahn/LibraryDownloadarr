import { config } from '../config';
import { randomToken } from '../utils/crypto';
import { cachePlexSubtitle } from './subtitleCache';
import {
  enumerateSubtitles,
  PlexMedia,
  PlexOnlineSubtitleCandidate,
  PlexPart,
  PlexServerClient,
  PlexSubtitleAttachError,
  PlexSubtitleTrack,
} from './plexService';
import { isSubtitleBurnSupported, subtitleKind } from './subtitleSupport';

const ONLINE_RESULT_PREFIX = 'online_';

export interface OnlineSubtitleResult {
  id: string;
  title: string;
  language?: string;
  languageCode?: string;
  provider?: string;
  codec: string;
  forced: boolean;
  hearingImpaired: boolean;
  perfectMatch: boolean;
  burnSupported: boolean;
}

interface StoredOnlineSubtitle {
  userId: string;
  ratingKey: string;
  partKey: string;
  candidate: PlexOnlineSubtitleCandidate;
  expiresAt: number;
}

export type CacheSubtitle = (
  subtitle: PlexSubtitleTrack,
  client: PlexServerClient
) => Promise<void>;

export interface OnlineSubtitleServiceOptions {
  ttlMs?: number;
  maximumResults?: number;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  cleanupTimeoutMs?: number;
  now?: () => number;
  cacheSubtitle?: CacheSubtitle;
}

export class OnlineSubtitleResultUnavailableError extends Error {
  constructor() {
    super('Online subtitle result expired or is no longer available');
    this.name = 'OnlineSubtitleResultUnavailableError';
  }
}

export class OnlineSubtitleUnsupportedError extends Error {
  constructor(codec: string) {
    super(`Unsupported online subtitle codec: ${codec || 'unknown'}`);
    this.name = 'OnlineSubtitleUnsupportedError';
  }
}

const flag = (value: unknown): boolean =>
  value === true || value === 1 || value === '1';

const subtitleStreams = (part: PlexPart): any[] =>
  (part.Stream || []).filter(stream =>
    Number(stream.streamType ?? stream.streamTypeId) === 3
  );

const exactPart = (
  metadata: PlexMedia,
  partKey: string
): { part: PlexPart; mediaItemId?: number | string } => {
  for (const media of metadata.Media || []) {
    const part = (media.Part || []).find(candidate => candidate.key === partKey);
    if (part) return { part, mediaItemId: media.id };
  }
  throw new Error('partKey does not belong to the requested accessible media item');
};

const streamId = (stream: any): string => String(stream?.id ?? '');
const streamKey = (stream: any): string => String(stream?.key ?? '');

const candidateMatches = (stream: any, candidate: PlexOnlineSubtitleCandidate): boolean =>
  streamKey(stream) === candidate.key ||
  String(stream.sourceKey || '') === candidate.key ||
  streamId(stream) === candidate.id;

const stronglyMatchesCandidate = (
  stream: any,
  candidate: PlexOnlineSubtitleCandidate
): boolean => {
  if (candidateMatches(stream, candidate)) return true;
  if (
    String(stream.codec || '').toLowerCase() !== candidate.codec ||
    String(stream.title || stream.displayTitle || '') !== candidate.title
  ) {
    return false;
  }
  if (
    candidate.languageCode &&
    stream.languageCode &&
    String(stream.languageCode) !== candidate.languageCode
  ) {
    return false;
  }
  if (
    candidate.providerTitle &&
    stream.providerTitle &&
    String(stream.providerTitle) !== candidate.providerTitle
  ) {
    return false;
  }
  return true;
};

const selectedStreamId = (part: PlexPart): string =>
  streamId(subtitleStreams(part).find(stream => flag(stream.selected))) || '0';

export class OnlineSubtitleService {
  private readonly results = new Map<string, StoredOnlineSubtitle>();
  private readonly locks = new Map<string, Promise<void>>();
  private readonly ttlMs: number;
  private readonly maximumResults: number;
  private readonly pollIntervalMs: number;
  private readonly pollTimeoutMs: number;
  private readonly cleanupTimeoutMs: number;
  private readonly now: () => number;
  private readonly cacheSubtitle: CacheSubtitle;

  constructor(options: OnlineSubtitleServiceOptions = {}) {
    this.ttlMs = options.ttlMs ?? 10 * 60 * 1000;
    this.maximumResults = options.maximumResults ?? 20;
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
    this.pollTimeoutMs = options.pollTimeoutMs ?? 30_000;
    this.cleanupTimeoutMs = options.cleanupTimeoutMs ?? 30_000;
    this.now = options.now ?? Date.now;
    this.cacheSubtitle = options.cacheSubtitle ??
      ((subtitle, client) => cachePlexSubtitle(subtitle, client, config.burn.cacheDir));
  }

  isResultId(value: string): boolean {
    return value.startsWith(ONLINE_RESULT_PREFIX);
  }

  async search(input: {
    userId: string;
    ratingKey: string;
    partKey: string;
    language: string;
    mediaItemId?: number | string;
    client: PlexServerClient;
  }): Promise<{ results: OnlineSubtitleResult[]; expiresAt: number }> {
    this.prune();
    const candidates = await input.client.searchSubtitles(input.ratingKey, {
      language: input.language,
      mediaItemId: input.mediaItemId,
    });
    const ranked = [...candidates]
      .sort((left, right) =>
        Number(right.perfectMatch) - Number(left.perfectMatch) ||
        (right.score ?? -1) - (left.score ?? -1)
      )
      .slice(0, this.maximumResults);
    const expiresAt = this.now() + this.ttlMs;
    const results = ranked.map(candidate => {
      const id = `${ONLINE_RESULT_PREFIX}${randomToken(18)}`;
      this.results.set(id, {
        userId: input.userId,
        ratingKey: input.ratingKey,
        partKey: input.partKey,
        candidate,
        expiresAt,
      });
      return {
        id,
        title: candidate.title,
        language: candidate.language,
        languageCode: candidate.languageCode,
        provider: candidate.providerTitle,
        codec: candidate.codec,
        forced: candidate.forced,
        hearingImpaired: candidate.hearingImpaired,
        perfectMatch: candidate.perfectMatch,
        burnSupported: isSubtitleBurnSupported(candidate.codec),
      };
    });
    return { results, expiresAt };
  }

  async acquire(input: {
    userId: string;
    ratingKey: string;
    partKey: string;
    resultId: string;
    client: PlexServerClient;
  }): Promise<PlexSubtitleTrack> {
    this.prune();
    const stored = this.results.get(input.resultId);
    if (
      !stored ||
      stored.expiresAt <= this.now() ||
      stored.userId !== input.userId ||
      stored.ratingKey !== input.ratingKey ||
      stored.partKey !== input.partKey
    ) {
      throw new OnlineSubtitleResultUnavailableError();
    }
    if (!isSubtitleBurnSupported(stored.candidate.codec)) {
      throw new OnlineSubtitleUnsupportedError(stored.candidate.codec);
    }
    this.results.delete(input.resultId);

    return this.withLock(
      `${input.client.baseUrl}:${input.ratingKey}`,
      async () => {
        if (stored.expiresAt <= this.now()) {
          throw new OnlineSubtitleResultUnavailableError();
        }
        return this.acquireLocked(stored, input.client);
      }
    );
  }

  private async acquireLocked(
    stored: StoredOnlineSubtitle,
    client: PlexServerClient
  ): Promise<PlexSubtitleTrack> {
    const baselineMetadata = await client.getMediaMetadata(
      stored.ratingKey,
      this.pollTimeoutMs
    );
    const baseline = exactPart(baselineMetadata, stored.partKey).part;
    const baselineStreams = subtitleStreams(baseline);
    const preExisting = baselineStreams.find(stream =>
      candidateMatches(stream, stored.candidate)
    );
    if (preExisting) {
      const track = this.trackForStream(baseline, preExisting, stored);
      await this.cacheSubtitle(track, client);
      return track;
    }

    const baselineIds = new Set(baselineStreams.map(streamId).filter(Boolean));
    const baselineKeys = new Set(baselineStreams.map(streamKey).filter(Boolean));
    const previousSelectedId = selectedStreamId(baseline);
    let attached: { part: PlexPart; stream: any } | undefined;
    let mutationMayHaveStarted = false;
    let activityId: string | undefined;
    const acquisitionDeadline = this.now() + this.pollTimeoutMs;

    try {
      mutationMayHaveStarted = true;
      try {
        activityId = await client.attachSubtitle(
          stored.ratingKey,
          stored.candidate,
          this.remainingMs(acquisitionDeadline)
        );
      } catch (error) {
        if (error instanceof PlexSubtitleAttachError) {
          activityId = error.activityId;
          if (!error.mayHaveStarted) mutationMayHaveStarted = false;
        }
        throw error;
      }
      while (this.now() < acquisitionDeadline) {
        const metadata = await client.getMediaMetadata(
          stored.ratingKey,
          this.remainingMs(acquisitionDeadline)
        );
        const currentPart = exactPart(metadata, stored.partKey).part;
        const currentStreams = subtitleStreams(currentPart);
        const newStreams = currentStreams.filter(stream =>
          !baselineIds.has(streamId(stream)) &&
          !baselineKeys.has(streamKey(stream))
        );
        const strictMatch = newStreams.find(stream =>
          candidateMatches(stream, stored.candidate)
        );
        const strongMatches = newStreams.filter(stream =>
          stronglyMatchesCandidate(stream, stored.candidate)
        );
        const matched = strictMatch || (strongMatches.length === 1 ? strongMatches[0] : undefined);
        if (matched) {
          attached = { part: currentPart, stream: matched };
          break;
        }
        if (this.now() < acquisitionDeadline) {
          await new Promise(resolve => setTimeout(
            resolve,
            Math.min(this.pollIntervalMs, this.remainingMs(acquisitionDeadline))
          ));
        }
      }

      if (!attached) {
        throw new Error('Plex did not finish downloading the selected subtitle');
      }
      const track = this.trackForStream(attached.part, attached.stream, stored);
      await this.cacheSubtitle(track, client);
      return track;
    } finally {
      if (mutationMayHaveStarted) {
        await this.restoreAndDelete(
          client,
          stored.ratingKey,
          stored.partKey,
          baseline.id,
          previousSelectedId,
          baselineIds,
          baselineKeys,
          stored.candidate,
          attached?.stream,
          activityId
        );
      }
    }
  }

  private trackForStream(
    part: PlexPart,
    stream: any,
    stored: StoredOnlineSubtitle
  ): PlexSubtitleTrack {
    const attachedId = streamId(stream);
    const enumerated = enumerateSubtitles(part).find(track => track.id === attachedId);
    if (!enumerated || !streamKey(stream)) {
      throw new Error('Plex downloaded subtitle metadata is incomplete');
    }
    const kind = subtitleKind(stored.candidate.codec);
    const resourceKey = streamKey(stream);
    const key = kind === 'text'
      ? `${resourceKey}${resourceKey.includes('?') ? '&' : '?'}format=srt`
      : resourceKey;
    return {
      ...enumerated,
      id: `${ONLINE_RESULT_PREFIX}${randomToken(18)}`,
      codec: kind === 'text' ? 'srt' : stored.candidate.codec,
      language: stored.candidate.language || enumerated.language,
      languageCode: stored.candidate.languageCode || enumerated.languageCode,
      title: stored.candidate.title,
      forced: stored.candidate.forced,
      hearingImpaired: stored.candidate.hearingImpaired,
      embedded: false,
      external: true,
      key,
      file: undefined,
    };
  }

  private async restoreAndDelete(
    client: PlexServerClient,
    ratingKey: string,
    partKey: string,
    partId: number | string,
    previousSelectedId: string,
    baselineIds: Set<string>,
    baselineKeys: Set<string>,
    candidate: PlexOnlineSubtitleCandidate,
    knownAttachedStream: any | undefined,
    activityId?: string
  ): Promise<void> {
    const failures: Error[] = [];
    let attachedStream = knownAttachedStream;
    let currentPart: PlexPart | undefined;
    let cancellationConfirmed = false;
    const cleanupStartedAt = this.now();
    const deadline = cleanupStartedAt + this.cleanupTimeoutMs;

    if (!attachedStream && activityId) {
      try {
        cancellationConfirmed = await client.cancelActivity(
          activityId,
          this.remainingMs(deadline)
        );
      } catch (error) {
        failures.push(error instanceof Error ? error : new Error('Failed to cancel Plex subtitle activity'));
      }
    }

    try {
      const cancellationVerificationDeadline = cancellationConfirmed
        ? Math.min(deadline, cleanupStartedAt + Math.max(1000, this.pollIntervalMs * 2))
        : deadline;
      do {
        currentPart = await this.readPartForCleanup(
          client,
          ratingKey,
          partKey,
          deadline
        );
        const newStreams = subtitleStreams(currentPart).filter(stream =>
          !baselineIds.has(streamId(stream)) &&
          !baselineKeys.has(streamKey(stream))
        );
        if (!attachedStream) {
          const strictMatch = newStreams.find(stream => candidateMatches(stream, candidate));
          const strongMatches = newStreams.filter(stream =>
            stronglyMatchesCandidate(stream, candidate)
          );
          attachedStream =
            strictMatch ||
            (strongMatches.length === 1 ? strongMatches[0] : undefined);
        }
        if (attachedStream) break;
        if (cancellationConfirmed && this.now() >= cancellationVerificationDeadline) break;
        if (this.now() < deadline) {
          await new Promise(resolve => setTimeout(
            resolve,
            Math.min(this.pollIntervalMs, this.remainingMs(deadline))
          ));
        }
      } while (this.now() < deadline);

      if (!attachedStream) {
        const newStreams = subtitleStreams(currentPart).filter(stream =>
          !baselineIds.has(streamId(stream)) &&
          !baselineKeys.has(streamKey(stream))
        );
        if (newStreams.length > 0) {
          throw new Error('Temporary Plex subtitle could not be identified safely');
        }
        if (!cancellationConfirmed) {
          throw new Error('Temporary Plex subtitle activity could not be cancelled or verified');
        }
      }
    } catch (error) {
      failures.push(error instanceof Error ? error : new Error('Failed to inspect Plex subtitle cleanup state'));
    }

    try {
      if (!currentPart || !attachedStream) {
        if (failures.length > 0) throw failures[0];
        return;
      }
      const currentSelectedId = selectedStreamId(currentPart);
      const attachedId = streamId(attachedStream);
      if (currentSelectedId === '0' || currentSelectedId === attachedId) {
        await client.selectSubtitle(
          partId,
          previousSelectedId,
          this.remainingMs(deadline)
        );
      }
    } catch (error) {
      failures.push(error instanceof Error ? error : new Error('Failed to restore Plex subtitle selection'));
    }

    if (attachedStream) {
      try {
        await client.deleteSubtitle(
          streamKey(attachedStream),
          this.remainingMs(deadline)
        );
      } catch (error) {
        failures.push(error instanceof Error ? error : new Error('Failed to remove temporary Plex subtitle'));
      }
    }
    if (failures.length > 0) {
      throw new Error(`Temporary Plex subtitle cleanup failed: ${failures[0].message}`);
    }
  }

  private async readPartForCleanup(
    client: PlexServerClient,
    ratingKey: string,
    partKey: string,
    deadline: number
  ): Promise<PlexPart> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (this.now() >= deadline) break;
      try {
        return exactPart(
          await client.getMediaMetadata(ratingKey, this.remainingMs(deadline)),
          partKey
        ).part;
      } catch (error) {
        lastError = error;
        if (attempt < 2 && this.now() < deadline) {
          await new Promise(resolve => setTimeout(
            resolve,
            Math.min(500, this.remainingMs(deadline))
          ));
        }
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error('Failed to read Plex metadata during subtitle cleanup');
  }

  private remainingMs(deadline: number): number {
    return Math.max(1, deadline - this.now());
  }

  private prune(): void {
    const now = this.now();
    for (const [id, result] of this.results) {
      if (result.expiresAt <= now) this.results.delete(id);
    }
  }

  private async withLock<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => current);
    this.locks.set(key, tail);
    await previous.catch(() => undefined);
    try {
      return await work();
    } finally {
      release();
      if (this.locks.get(key) === tail) this.locks.delete(key);
    }
  }
}
