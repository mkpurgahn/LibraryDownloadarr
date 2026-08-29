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
  const language = stream.displayTitle || stream.title || stream.language || stream.languageCode || 'Unknown language';
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
  const [format, setFormat] = useState('original');
  const [accelerated, setAccelerated] = useState(false);
  const subtitles = useMemo(() => (part.Stream || []).filter(isSubtitle), [part.Stream]);
  const selectedSubtitle = format.startsWith('subtitle:')
    ? subtitles.find((stream) => `subtitle:${stream.id}` === format)
    : undefined;
  const active = downloads.find(
    (download) =>
      download.partKey === part.key &&
      ['requesting', 'queued', 'preparing', 'downloading', 'pausing'].includes(download.status)
  );
  const filename =
    part.filename ||
    part.file?.split('/').pop() ||
    `${title}.${part.container || mediaPart.container || 'mkv'}`;
  const videoCodec = mediaPart.videoCodec?.toUpperCase();
  const audioCodec = mediaPart.audioCodec?.toUpperCase();
  const container = (part.container || mediaPart.container || '').toUpperCase();
  const compatibleDescription =
    videoCodec === 'H264' && audioCodec === 'AAC'
      ? 'The server will quickly repackage the existing video and audio as MP4 without changing quality.'
      : videoCodec === 'H264'
        ? 'The server will keep the original video and convert only the audio for wider playback support.'
        : 'The server will create an H.264/AAC MP4 for playback in browsers and built-in device players.';

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
    if (format === 'compatible') {
      await startCompatibleJob(ratingKey, part.key, filename, title);
      return;
    }
    if (accelerated && parallelSupported) {
      await startParallelDownload(ratingKey, part.key, filename, title);
      return;
    }
    await startOriginalDownload(ratingKey, part.key, filename, title);
  };

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

          <label className="mt-3 block min-w-0">
            <span className="mb-1.5 flex items-center gap-2 text-xs font-medium text-gray-300">
              <CaptionIcon />
              Download format
            </span>
            <select
              className="input min-h-11 max-w-full text-base md:text-sm"
              value={format}
              onChange={(event) => {
                setFormat(event.target.value);
                if (event.target.value !== 'original') setAccelerated(false);
              }}
              disabled={Boolean(active)}
            >
              <option value="original">Original file - no conversion</option>
              {videoCodec && (
                <option value="compatible">Compatible MP4 - prepare on server</option>
              )}
              {subtitles.map((stream) => (
                <option
                  key={stream.id}
                  value={`subtitle:${stream.id}`}
                  disabled={stream.burnSupported === false}
                >
                  Burn subtitles: {subtitleLabel(stream)}
                  {stream.burnSupported === false ? ' - unavailable' : ''}
                </option>
              ))}
            </select>
          </label>

          {parallelSupported && format === 'original' && (
            <label className="mt-2 flex cursor-pointer items-start gap-3 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2.5 transition-colors hover:border-primary-400/40">
              <input
                type="checkbox"
                checked={accelerated}
                onChange={(event) => setAccelerated(event.target.checked)}
                disabled={Boolean(active)}
                className="mt-0.5 h-4 w-4 rounded border-white/20 bg-dark-200 text-primary-500 focus:ring-primary-500"
              />
              <span className="min-w-0">
                <span className="block text-xs font-medium text-gray-200">Accelerated download</span>
                <span className="mt-0.5 block text-xs leading-4 text-gray-400">
                  Uses up to four connections and saves directly to a file you choose.
                </span>
              </span>
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
          {selectedSubtitle ? <CaptionIcon /> : <DownloadIcon className="h-4 w-4" />}
          {active
            ? active.status === 'preparing' || active.status === 'downloading'
              ? `${active.mode === 'parallel' ? 'Downloading' : 'Preparing'} ${Math.round(active.progress)}%`
              : 'Starting...'
            : selectedSubtitle
              ? 'Prepare subtitled MP4'
              : format === 'compatible'
                ? 'Prepare compatible MP4'
                : accelerated
                  ? 'Choose file and accelerate'
                  : 'Download original'}
        </button>
      </div>

      {!compact && (
        <p className="mt-2 max-w-2xl text-xs leading-5 text-gray-400">
          {selectedSubtitle
            ? 'Creates a compatible H.264/AAC MP4 first. You can leave this page while the server prepares it.'
            : format === 'compatible'
              ? `${compatibleDescription} Compatible copies are made only when requested and expire from the server cache.`
              : accelerated
                ? 'Keep this page open while downloading. Pause before closing it. Resuming requires choosing the same partial file and enough free space to preserve it safely.'
                : container === 'MKV'
                  ? (
                    <>
                      Downloads the untouched MKV. For broad playback support, install{' '}
                      <a
                        href="https://www.videolan.org/vlc/"
                        target="_blank"
                        rel="noreferrer"
                        className="font-medium text-primary-300 underline decoration-primary-400/40 underline-offset-2 hover:text-primary-200"
                      >
                        VLC
                      </a>{' '}
                      or choose Compatible MP4.
                    </>
                  )
                  : 'Downloads the untouched original. Your browser handles pause and resume.'}
        </p>
      )}
    </div>
  );
};
