import { execFile } from 'child_process';
import path from 'path';
import { promisify } from 'util';
import { config } from '../config';
import { PlexSubtitleTrack } from './plexService';

const execFileAsync = promisify(execFile);
const probeCache = new Map<string, Promise<PlexSubtitleTrack[]>>();
const languageNames: Record<string, string> = {
  eng: 'English',
  en: 'English',
  spa: 'Spanish',
  es: 'Spanish',
  fra: 'French',
  fre: 'French',
  fr: 'French',
  deu: 'German',
  ger: 'German',
  de: 'German',
  ita: 'Italian',
  it: 'Italian',
  jpn: 'Japanese',
  ja: 'Japanese',
  kor: 'Korean',
  ko: 'Korean',
  por: 'Portuguese',
  pt: 'Portuguese',
  zho: 'Chinese',
  chi: 'Chinese',
  zh: 'Chinese',
};

interface ProbeStream {
  index?: number;
  codec_name?: string;
  tags?: {
    language?: string;
    title?: string;
  };
  disposition?: {
    forced?: number;
    hearing_impaired?: number;
  };
}

const ffprobePath = (): string => {
  const directory = path.dirname(config.burn.ffmpegPath);
  return path.join(directory === '.' ? '' : directory, 'ffprobe');
};

export const probeEmbeddedSubtitles = (
  filePath: string,
  fingerprint: string
): Promise<PlexSubtitleTrack[]> => {
  const cached = probeCache.get(fingerprint);
  if (cached) return cached;

  const pending = (async () => {
    const { stdout } = await execFileAsync(
      ffprobePath(),
      [
        '-v',
        'error',
        '-select_streams',
        's',
        '-show_entries',
        'stream=index,codec_name:stream_tags=language,title:stream_disposition=forced,hearing_impaired',
        '-of',
        'json',
        filePath,
      ],
      { maxBuffer: 1024 * 1024, timeout: 15_000 }
    );
    const result = JSON.parse(stdout) as { streams?: ProbeStream[] };
    return (result.streams || []).map((stream, subtitleIndex) => {
      const languageCode = stream.tags?.language?.toLowerCase();
      const language = languageCode
        ? languageNames[languageCode] || stream.tags?.language
        : undefined;
      const trackTitle = stream.tags?.title?.trim();
      const title =
        trackTitle && language && !trackTitle.toLowerCase().includes(language.toLowerCase())
          ? `${language} - ${trackTitle}`
          : trackTitle || language || `Subtitle ${subtitleIndex + 1}`;
      return {
        id: `probe-${stream.index ?? subtitleIndex}`,
        index: stream.index ?? subtitleIndex,
        subtitleIndex,
        language,
        languageCode,
        title,
        codec: String(stream.codec_name || '').toLowerCase(),
        forced: stream.disposition?.forced === 1 || /\bforced\b/i.test(title),
        hearingImpaired:
          stream.disposition?.hearing_impaired === 1 || /\b(sdh|hearing impaired)\b/i.test(title),
        embedded: true,
        external: false,
      };
    });
  })();

  probeCache.set(fingerprint, pending);
  pending.catch(() => probeCache.delete(fingerprint));
  return pending;
};
