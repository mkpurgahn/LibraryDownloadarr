import React, { useMemo, useState } from 'react';
import { useDownloads } from '../contexts/DownloadContext';
import { MediaPart, MediaStream, Part } from '../types';
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
  const subtitles = useMemo(() => (part.Stream || []).filter(isSubtitle), [part.Stream]);
  const selectedSubtitle = subtitles.find(stream => stream.id === subtitleId);
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

  const act = async () => {
    if (selectedSubtitle) {
      await startBurnJob(
        ratingKey,
        part.key,
        filename.replace(/\.[^.]+$/, '') + ` - ${selectedSubtitle.language || 'subtitled'}.mp4`,
        title,
        selectedSubtitle.id,
        subtitleLabel(selectedSubtitle)
      );
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

          {isVideo && subtitles.length > 0 && (
            <label className="mt-3 block min-w-0">
              <span className="mb-1.5 flex items-center gap-2 text-xs font-medium text-gray-300">
                <CaptionIcon />
                Subtitles (optional)
              </span>
              <select
                className="input min-h-11 max-w-full text-base md:text-sm"
                value={subtitleId}
                onChange={event => setSubtitleId(event.target.value)}
                disabled={Boolean(active)}
              >
                <option value="">No burned-in subtitles</option>
                {subtitles.map(stream => (
                  <option key={stream.id} value={stream.id} disabled={stream.burnSupported === false}>
                    {subtitleLabel(stream)}
                    {stream.burnSupported === false ? ' - unavailable' : ''}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>

        <button
          type="button"
          onClick={act}
          disabled={Boolean(active) || selectedSubtitle?.burnSupported === false}
          className={`btn-primary inline-flex min-h-11 w-full shrink-0 items-center justify-center gap-2 disabled:cursor-not-allowed disabled:opacity-50 ${
            compact ? 'sm:w-auto' : 'mt-3 md:w-auto'
          }`}
        >
          <DownloadIcon className="h-4 w-4" />
          {active ? activeLabel : isVideo ? 'Download MP4' : 'Download file'}
        </button>
      </div>

      {!compact && (
        <p className="mt-2 max-w-2xl text-xs leading-5 text-gray-400">
          {selectedSubtitle
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
