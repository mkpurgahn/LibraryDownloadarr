import fs from 'fs/promises';
import { createReadStream } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { Stats } from 'fs';
import { PlexMedia, PlexPart, PlexServerClient, PlexSubtitleTrack } from './plexService';

export interface AuthorizedPart {
  metadata: PlexMedia;
  part: PlexPart;
  subtitle?: PlexSubtitleTrack;
  sourcePath: string;
  sourceFingerprint: string;
}

const findPart = (metadata: PlexMedia, partKey: string): PlexPart | undefined =>
  metadata.Media?.flatMap(media => media.Part || []).find(part => part.key === partKey);

const findSubtitle = (part: PlexPart, streamId: string): PlexSubtitleTrack | undefined =>
  part.subtitles?.find(track => track.id === streamId);

export const canonicalizeMediaPath = async (filePath: string, mediaRoots: string[]): Promise<string> => {
  if (mediaRoots.length === 0) {
    throw new Error('MEDIA_ROOTS is not configured');
  }
  const [canonicalPath, canonicalRoots] = await Promise.all([
    fs.realpath(filePath),
    Promise.all(mediaRoots.map(root => fs.realpath(root))),
  ]);
  const allowed = canonicalRoots.some(root =>
    canonicalPath === root || canonicalPath.startsWith(`${root}${path.sep}`)
  );
  if (!allowed) throw new Error('Resolved media file is outside MEDIA_ROOTS');
  const stat = await fs.stat(canonicalPath);
  if (!stat.isFile()) throw new Error('Resolved media path is not a regular file');
  return canonicalPath;
};

export const fingerprintStat = (filePath: string, stat: Pick<Stats, 'dev' | 'ino' | 'size' | 'mtimeMs'>): string =>
  crypto.createHash('sha256')
    .update(`${filePath}\0${stat.dev}\0${stat.ino}\0${stat.size}\0${stat.mtimeMs}`)
    .digest('hex');

export const fingerprintFile = async (filePath: string): Promise<string> =>
  fingerprintStat(filePath, await fs.stat(filePath));

export const fingerprintContents = async (filePath: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', chunk => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', () => resolve(hash.digest('hex')));
  });

export const ensureAccessiblePart = async (
  ratingKey: string,
  partKey: string,
  userClient: PlexServerClient
): Promise<PlexMedia> => {
  const metadata = await userClient.getMediaMetadata(ratingKey);
  if (!findPart(metadata, partKey)) {
    throw new Error('partKey does not belong to the requested accessible media item');
  }
  return metadata;
};

export const resolveAuthorizedPart = async (
  ratingKey: string,
  partKey: string,
  userClient: PlexServerClient,
  ownerClient: PlexServerClient,
  mediaRoots: string[],
  subtitleStreamId?: string
): Promise<AuthorizedPart> => {
  // This portal deliberately authorizes by current visibility on the exact
  // configured server, not Plex's separate allowSync client feature.
  const userMetadata = await ensureAccessiblePart(ratingKey, partKey, userClient);
  const userPart = findPart(userMetadata, partKey)!;

  const userSubtitle = subtitleStreamId ? findSubtitle(userPart, subtitleStreamId) : undefined;
  if (subtitleStreamId && !userSubtitle) {
    throw new Error('Subtitle track does not belong to the selected media part');
  }

  const ownerMetadata = await ownerClient.getMediaMetadata(ratingKey);
  const ownerPart = findPart(ownerMetadata, partKey);
  if (!ownerPart?.file) {
    throw new Error('The configured Plex owner cannot resolve the selected local file');
  }

  const ownerSubtitle = subtitleStreamId ? findSubtitle(ownerPart, subtitleStreamId) : undefined;
  if (subtitleStreamId && !ownerSubtitle) {
    throw new Error('Subtitle track could not be resolved on the selected media part');
  }

  const sourcePath = await canonicalizeMediaPath(ownerPart.file, mediaRoots);
  return {
    metadata: userMetadata,
    part: ownerPart,
    subtitle: ownerSubtitle,
    sourcePath,
    sourceFingerprint: await fingerprintFile(sourcePath),
  };
};
