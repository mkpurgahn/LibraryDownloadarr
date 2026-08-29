import path from 'path';
import { PlexMedia, PlexPart, PlexSubtitleTrack } from './plexService';
import { isSubtitleBurnSupported } from './subtitleSupport';

const flag = (value: unknown): boolean =>
  value === true || value === 1 || value === '1';

const sanitizeStream = (stream: any): any => {
  const { file: _file, ...safe } = stream;
  if (Number(stream.streamType) !== 3) return safe;

  const external = Boolean(stream.key || stream.file);
  return {
    ...safe,
    id: String(stream.id ?? stream.index ?? ''),
    streamType: 3,
    codec: String(stream.codec || '').toLowerCase(),
    language: stream.language || undefined,
    languageCode: stream.languageCode || undefined,
    displayTitle: stream.displayTitle || stream.title || undefined,
    title: stream.title || stream.displayTitle || undefined,
    forced: flag(stream.forced),
    hearingImpaired: flag(stream.hearingImpaired) || flag(stream.sdh),
    key: stream.key || undefined,
    embedded: !external,
    external,
    burnSupported: isSubtitleBurnSupported(String(stream.codec || '')),
  };
};

const sanitizeSubtitle = (track: PlexSubtitleTrack): Omit<PlexSubtitleTrack, 'file'> & {
  burnSupported: boolean;
} => {
  const { file: _file, ...safe } = track;
  return {
    ...safe,
    burnSupported: isSubtitleBurnSupported(track.codec),
  };
};

const sanitizePart = (part: PlexPart): PlexPart => {
  const { file: _file, ...safe } = part;
  return {
    ...safe,
    filename: part.file ? path.basename(part.file) : undefined,
    Stream: part.Stream?.map(sanitizeStream),
    subtitles: part.subtitles?.map(sanitizeSubtitle),
  };
};

export const sanitizeMedia = (media: PlexMedia): PlexMedia => ({
  ...media,
  Media: media.Media?.map(mediaVersion => ({
    ...mediaVersion,
    Part: mediaVersion.Part.map(sanitizePart),
  })),
});

export const sanitizeMediaList = (media: PlexMedia[]): PlexMedia[] =>
  media.map(sanitizeMedia);
