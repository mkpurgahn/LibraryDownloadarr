import React, { useEffect, useMemo, useState } from 'react';
import { useDownloads } from '../contexts/DownloadContext';
import { api } from '../services/api';
import { MediaPart, MediaStream, OnlineSubtitleResult, Part } from '../types';
import { DownloadIcon } from './Icons';

interface DownloadChoiceProps {
  ratingKey: string;
  title: string;
  mediaPart: MediaPart;
  part: Part;
  compact?: boolean;
}

function formatFileSize(bytes: number): string {
  if (!bytes) return 'Unknown size';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index > 2 ? 1 : 0)} ${units[index]}`;
}

function isSubtitle(stream: MediaStream): boolean {
  return (stream.streamType ?? stream.streamTypeId) === 3;
}

function subtitleLabel(stream: MediaStream): string {
  const language =
    stream.displayTitle || stream.title || stream.language || stream.languageCode || 'Unknown language';
  const normalizedLanguage = language.toLowerCase();
  const details = [
    stream.forced && !normalizedLanguage.includes('forced') ? 'Forced' : null,
    stream.hearingImpaired && !normalizedLanguage.includes('sdh') ? 'SDH' : null,
    stream.codec?.toUpperCase(),
    stream.embedded === false || stream.key ? 'External' : 'Embedded',
  ].filter(Boolean);
  return details.length ? `${language} - ${details.join(' - ')}` : language;
}

function CaptionIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4 w-4 fill-none stroke-current stroke-2">
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M7 11h4m2 0h4m-10 4h3m3 0h4" strokeLinecap="round" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4 w-4 fill-none stroke-current stroke-2">
      <circle cx="11" cy="11" r="6" />
      <path d="m16 16 4 4" strokeLinecap="round" />
    </svg>
  );
}

const SUBTITLE_LANGUAGES = [
  ['en', 'English'],
  ['es', 'Spanish'],
  ['fr', 'French'],
  ['de', 'German'],
  ['it', 'Italian'],
  ['pt', 'Portuguese'],
  ['nl', 'Dutch'],
  ['pl', 'Polish'],
  ['sv', 'Swedish'],
  ['da', 'Danish'],
  ['no', 'Norwegian'],
  ['fi', 'Finnish'],
  ['ja', 'Japanese'],
  ['ko', 'Korean'],
  ['zh', 'Chinese'],
] as const;

function onlineSubtitleDetails(result: OnlineSubtitleResult): string {
  const language = result.language || result.languageCode || 'Unknown language';
  const details = [
    result.forced ? 'Forced' : null,
    result.hearingImpaired ? 'SDH' : null,
    result.provider,
  ].filter(Boolean);
  return details.length ? `${language} - ${details.join(' - ')}` : language;
}

function onlineSubtitleLabel(result: OnlineSubtitleResult): string {
  return `${result.title} - ${onlineSubtitleDetails(result)}`;
}

function errorMessage(error: unknown): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    'response' in error &&
    typeof error.response === 'object' &&
    error.response !== null &&
    'data' in error.response
  ) {
    const data = error.response.data as { error?: string };
    if (data.error) return data.error;
  }
  return error instanceof Error ? error.message : 'Plex subtitle search failed.';
}

export const DownloadChoice: React.FC<DownloadChoiceProps> = ({
  ratingKey,
  title,
  mediaPart,
  part,
  compact = false,
}) => {
  const {
    downloads,
    startOriginalDownload,
    startBurnJob,
    startCompatibleJob,
    startParallelDownload,
    parallelSupported,
  } = useDownloads();
  const [subtitleId, setSubtitleId] = useState('');
  const [subtitleSearchOpen, setSubtitleSearchOpen] = useState(false);
  const [subtitleLanguage, setSubtitleLanguage] = useState('en');
  const [onlineSubtitles, setOnlineSubtitles] = useState<OnlineSubtitleResult[]>([]);
  const [onlineSubtitleExpiresAt, setOnlineSubtitleExpiresAt] = useState(0);
  const [subtitleSearchState, setSubtitleSearchState] =
    useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [subtitleSearchError, setSubtitleSearchError] = useState('');
  const subtitles = useMemo(() => (part.Stream || []).filter(isSubtitle), [part.Stream]);
  const selectedSubtitle = subtitles.find(stream => stream.id === subtitleId);
  const selectedOnlineSubtitle = onlineSubtitles.find(result => result.id === subtitleId);
  const active = downloads.find(
    download =>
      download.partKey === part.key &&
      ['requesting', 'queued', 'preparing', 'ready', 'downloading', 'pausing', 'paused'].includes(download.status)
  );
  const filename =
    part.filename ||
    part.file?.split('/').pop() ||
    `${title}.${part.container || mediaPart.container || 'mkv'}`;
  const videoCodec = mediaPart.videoCodec?.toUpperCase();
  const audioCodec = mediaPart.audioCodec?.toUpperCase();
  const container = (part.container || mediaPart.container || '').toUpperCase();
  const isVideo = Boolean(videoCodec);
  const isMp4 = container === 'MP4';
  const compatibleDescription =
    videoCodec === 'H264' && audioCodec === 'AAC'
      ? 'This video only needs quick MP4 packaging, with no quality change.'
      : videoCodec === 'H264'
        ? 'The original video is kept while its audio is converted for wider playback.'
        : 'The server creates an H.264/AAC MP4 for browsers and built-in device players.';

  useEffect(() => {
    setSubtitleId('');
    setSubtitleSearchOpen(false);
    setOnlineSubtitles([]);
    setOnlineSubtitleExpiresAt(0);
    setSubtitleSearchState('idle');
    setSubtitleSearchError('');
  }, [ratingKey, part.key]);

  const searchSubtitles = async () => {
    if (subtitleSearchState === 'loading') return;
    setSubtitleSearchState('loading');
    setSubtitleSearchError('');
    try {
      const response = await api.searchSubtitles(ratingKey, part.key, subtitleLanguage);
      if (selectedOnlineSubtitle) setSubtitleId('');
      setOnlineSubtitles(response.results);
      setOnlineSubtitleExpiresAt(Date.parse(response.expiresAt));
      setSubtitleSearchState('ready');
    } catch (error) {
      setSubtitleSearchError(errorMessage(error));
      setSubtitleSearchState('error');
    }
  };

  const toggleSubtitleSearch = () => {
    const opening = !subtitleSearchOpen;
    setSubtitleSearchOpen(opening);
    if (opening && subtitleSearchState === 'idle') void searchSubtitles();
  };

  const act = async () => {
    if (selectedSubtitle || selectedOnlineSubtitle) {
      if (selectedOnlineSubtitle && onlineSubtitleExpiresAt <= Date.now()) {
        setSubtitleId('');
        setOnlineSubtitles(current =>
          current.filter(result => result.id !== selectedOnlineSubtitle.id)
        );
        setSubtitleSearchOpen(true);
        setSubtitleSearchState('error');
        setSubtitleSearchError('These subtitle results expired. Search Plex again.');
        return;
      }
      const language =
        selectedSubtitle?.language ||
        selectedOnlineSubtitle?.language ||
        selectedOnlineSubtitle?.languageCode ||
        'subtitled';
      const label = selectedSubtitle
        ? subtitleLabel(selectedSubtitle)
        : onlineSubtitleLabel(selectedOnlineSubtitle!);
      const result = await startBurnJob(
        ratingKey,
        part.key,
        filename.replace(/\.[^.]+$/, '') + ` - ${language}.mp4`,
        title,
        (selectedSubtitle || selectedOnlineSubtitle)!.id,
        label
      );
      if (selectedOnlineSubtitle && result === 'started') {
        setSubtitleId('');
        setOnlineSubtitles(current =>
          current.filter(subtitle => subtitle.id !== selectedOnlineSubtitle.id)
        );
      } else if (selectedOnlineSubtitle && result === 'expired') {
        setSubtitleId('');
        setOnlineSubtitles(current =>
          current.filter(subtitle => subtitle.id !== selectedOnlineSubtitle.id)
        );
        setSubtitleSearchOpen(true);
        setSubtitleSearchState('error');
        setSubtitleSearchError('That subtitle result expired. Search Plex again.');
      }
      return;
    }
    if (isVideo && !isMp4) {
      await startCompatibleJob(ratingKey, part.key, filename, title);
      return;
    }
    if (isVideo && parallelSupported) {
      await startParallelDownload(ratingKey, part.key, filename, title);
      return;
    }
    await startOriginalDownload(ratingKey, part.key, filename, title);
  };

  const activeLabel =
    active?.status === 'preparing' || active?.status === 'downloading'
      ? `${active.status === 'downloading' ? 'Downloading' : 'Preparing'} ${Math.round(active.progress)}%`
      : active?.status === 'queued'
        ? 'Queued for MP4'
        : active?.status === 'paused'
          ? 'Paused in downloads'
        : 'Starting...';

  return (
    <div className="min-w-0 w-full">
      <div className={compact ? 'grid min-w-0 gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end' : ''}>
        <div className="min-w-0">
          <div className="flex flex-wrap gap-2 text-xs text-gray-300">
            {mediaPart.videoResolution && <span className="media-fact">{mediaPart.videoResolution}</span>}
            {videoCodec && <span className="media-fact">{videoCodec}</span>}
            {audioCodec && <span className="media-fact">{audioCodec}</span>}
            {container && <span className="media-fact">{container}</span>}
            <span className="media-fact tabular-nums">{formatFileSize(part.size)}</span>
          </div>

          {isVideo && (
            <div className="mt-3 min-w-0">
              <label className="block min-w-0">
                <span className="mb-1.5 flex items-center gap-2 text-xs font-medium text-gray-300">
                  <CaptionIcon />
                  Subtitles (optional)
                </span>
                <div className="flex min-w-0 flex-col gap-2 sm:flex-row">
                  <select
                    className="input min-h-11 min-w-0 max-w-full text-base md:text-sm"
                    value={subtitleId}
                    onChange={event => setSubtitleId(event.target.value)}
                    disabled={Boolean(active)}
                  >
                    <option value="">No burned-in subtitles</option>
                    {subtitles.length > 0 && (
                      <optgroup label="Available in Plex">
                        {subtitles.map(stream => (
                          <option
                            key={stream.id}
                            value={stream.id}
                            disabled={stream.burnSupported === false}
                          >
                            {subtitleLabel(stream)}
                            {stream.burnSupported === false ? ' - unavailable' : ''}
                          </option>
                        ))}
                      </optgroup>
                    )}
                    {onlineSubtitles.length > 0 && (
                      <optgroup label="Found online">
                        {onlineSubtitles.map(result => (
                          <option
                            key={result.id}
                            value={result.id}
                            disabled={!result.burnSupported}
                          >
                            {onlineSubtitleLabel(result)}
                            {!result.burnSupported ? ' - unavailable' : ''}
                          </option>
                        ))}
                      </optgroup>
                    )}
                  </select>
                  <button
                    type="button"
                    onClick={toggleSubtitleSearch}
                    disabled={Boolean(active)}
                    aria-expanded={subtitleSearchOpen}
                    aria-controls={`subtitle-search-${part.id}`}
                    className="btn-secondary inline-flex min-h-11 shrink-0 items-center justify-center gap-2 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <SearchIcon />
                    {subtitleSearchOpen ? 'Hide search' : 'Find subtitles'}
                  </button>
                </div>
              </label>
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={act}
          disabled={
            Boolean(active) ||
            selectedSubtitle?.burnSupported === false ||
            selectedOnlineSubtitle?.burnSupported === false
          }
          className={`btn-primary inline-flex min-h-11 w-full shrink-0 items-center justify-center gap-2 disabled:cursor-not-allowed disabled:opacity-50 ${
            compact ? 'sm:w-auto' : 'mt-3 md:w-auto'
          }`}
        >
          <DownloadIcon className="h-4 w-4" />
          {active ? activeLabel : isVideo ? 'Download MP4' : 'Download file'}
        </button>
      </div>

      {isVideo && subtitleSearchOpen && (
        <div
          id={`subtitle-search-${part.id}`}
          className="mt-3 rounded-lg bg-dark-200 p-3 ring-1 ring-white/10"
        >
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <label className="min-w-0 flex-1">
              <span className="mb-1.5 block text-xs font-medium text-gray-300">
                Subtitle language
              </span>
              <select
                className="input min-h-11 text-base md:text-sm"
                value={subtitleLanguage}
                onChange={event => setSubtitleLanguage(event.target.value)}
                disabled={subtitleSearchState === 'loading'}
              >
                {SUBTITLE_LANGUAGES.map(([code, language]) => (
                  <option key={code} value={code}>{language}</option>
                ))}
              </select>
            </label>
            <button
              type="button"
              onClick={() => void searchSubtitles()}
              disabled={subtitleSearchState === 'loading'}
              className="btn-secondary inline-flex min-h-11 items-center justify-center gap-2 disabled:cursor-wait disabled:opacity-60"
            >
              <SearchIcon />
              {subtitleSearchState === 'loading' ? 'Searching Plex...' : 'Search again'}
            </button>
          </div>

          <div className="mt-3" aria-live="polite">
            {subtitleSearchState === 'loading' && (
              <div className="space-y-2" aria-label="Searching for subtitles">
                {[0, 1, 2].map(index => (
                  <div key={index} className="h-14 animate-pulse rounded-lg bg-white/5" />
                ))}
              </div>
            )}

            {subtitleSearchState === 'error' && (
              <div className="rounded-lg bg-red-500/10 px-3 py-2 text-sm leading-6 text-red-200">
                {subtitleSearchError}
              </div>
            )}

            {subtitleSearchState === 'ready' && onlineSubtitles.length === 0 && (
              <div className="rounded-lg bg-white/5 px-3 py-3 text-sm leading-6 text-gray-300">
                Plex found no matches in this language. Choose another language and search again.
              </div>
            )}

            {subtitleSearchState === 'ready' && onlineSubtitles.length > 0 && (
              <div className="space-y-1">
                <p className="mb-2 text-xs leading-5 text-gray-400">
                  Choose a match, then use Download MP4 to burn it into the video.
                </p>
                {onlineSubtitles.map((result, index) => (
                  <button
                    key={result.id}
                    type="button"
                    onClick={() => {
                      setSubtitleId(result.id);
                      setSubtitleSearchOpen(false);
                    }}
                    disabled={!result.burnSupported}
                    className="group flex min-h-14 w-full min-w-0 items-center justify-between gap-3 rounded-lg px-3 py-2 text-left transition-colors hover:bg-white/5 focus:outline-none focus:ring-2 focus:ring-primary-500 disabled:cursor-not-allowed disabled:opacity-45"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-gray-100">
                        {result.title}
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-gray-400">
                        {onlineSubtitleDetails(result)}
                      </span>
                    </span>
                    <span className="shrink-0 text-xs font-medium text-gray-400 group-hover:text-gray-200">
                      {!result.burnSupported
                        ? 'Unavailable'
                        : result.perfectMatch || index === 0
                          ? 'Top match'
                          : 'Select'}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {!compact && (
        <p className="mt-2 max-w-2xl text-xs leading-5 text-gray-400">
          {selectedSubtitle || selectedOnlineSubtitle
            ? 'The server burns your selected subtitles into the MP4, then starts the download automatically.'
            : isVideo && !isMp4
              ? `${compatibleDescription} The download starts automatically when it is ready.`
              : isVideo && parallelSupported
                ? 'Saves the MP4 directly to a location you choose using up to four download connections.'
                : isVideo
                  ? 'Downloads the ready-to-play MP4 immediately.'
                  : 'Downloads the original audio file immediately.'}
        </p>
      )}
    </div>
  );
};
