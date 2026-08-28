export type SubtitleKind = 'text' | 'bitmap';

const TEXT_CODECS = new Set(['srt', 'subrip', 'ass', 'ssa', 'webvtt', 'vtt', 'mov_text']);
const BITMAP_CODECS = new Set(['pgs', 'hdmv_pgs_subtitle', 'dvd_subtitle', 'vobsub', 'dvb_subtitle']);

export const subtitleKind = (codec: string): SubtitleKind | undefined => {
  const normalized = codec.toLowerCase();
  if (TEXT_CODECS.has(normalized)) return 'text';
  if (BITMAP_CODECS.has(normalized)) return 'bitmap';
  return undefined;
};

export const isSubtitleBurnSupported = (codec: string): boolean =>
  subtitleKind(codec) !== undefined;
