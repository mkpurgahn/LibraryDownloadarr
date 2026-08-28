import React, { useMemo, useState } from 'react';
import { useDownloads } from '../contexts/DownloadContext';
import { MediaPart, MediaStream, Part } from '../types';

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

function DownloadIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4 w-4 fill-none stroke-current stroke-2">
      <path d="M12 3v12m0 0 4-4m-4 4-4-4M5 20h14" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
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
  const { downloads, startOriginalDownload, startBurnJob } = useDownloads();
  const [subtitleId, setSubtitleId] = useState('');
  const subtitles = useMemo(() => (part.Stream || []).filter(isSubtitle), [part.Stream]);
  const selectedSubtitle = subtitles.find((stream) => String(stream.id) === subtitleId);
  const active = downloads.find(
    (download) =>
      download.partKey === part.key &&
      ['requesting', 'queued', 'preparing'].includes(download.status)
  );
  const filename = part.file?.split('/').pop() || `${title}.${part.container || mediaPart.container || 'mkv'}`;
  const videoCodec = mediaPart.videoCodec?.toUpperCase();
  const audioCodec = mediaPart.audioCodec?.toUpperCase();
  const container = (part.container || mediaPart.container || '').toUpperCase();

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
    await startOriginalDownload(ratingKey, part.key, filename, title);
  };

  return (
    <div className={`min-w-0 ${compact ? 'w-full md:max-w-md' : 'w-full'}`}>
      <div className="flex flex-wrap gap-2 text-xs text-gray-300">
        {mediaPart.videoResolution && <span className="media-fact">{mediaPart.videoResolution}</span>}
        {videoCodec && <span className="media-fact">{videoCodec}</span>}
        {audioCodec && <span className="media-fact">{audioCodec}</span>}
        {container && <span className="media-fact">{container}</span>}
        <span className="media-fact tabular-nums">{formatFileSize(part.size)}</span>
      </div>

      {subtitles.length > 0 && (
        <label className="mt-3 block">
          <span className="mb-1.5 flex items-center gap-2 text-xs font-medium text-gray-300">
            <CaptionIcon />
            Burn in subtitles
          </span>
          <select
            className="input min-h-11 text-base md:text-sm"
            value={subtitleId}
            onChange={(event) => setSubtitleId(event.target.value)}
            disabled={Boolean(active)}
          >
            <option value="">No subtitles - original file</option>
            {subtitles.map((stream) => (
              <option key={stream.id} value={String(stream.id)} disabled={stream.burnSupported === false}>
                {subtitleLabel(stream)}
                {stream.burnSupported === false ? ' - unavailable' : ''}
              </option>
            ))}
          </select>
        </label>
      )}

      <p className="mt-2 text-xs leading-5 text-gray-400">
        {selectedSubtitle
          ? 'Creates a compatible H.264/AAC MP4 first. You can leave this page while the server prepares it.'
          : container === 'MKV'
            ? 'Downloads the untouched MKV. Your browser handles pause and resume; VLC or Infuse offers the widest device support.'
            : 'Downloads the untouched original. Your browser handles pause and resume.'}
      </p>

      <button
        type="button"
        onClick={act}
        disabled={Boolean(active) || selectedSubtitle?.burnSupported === false}
        className="btn-primary mt-3 inline-flex min-h-11 w-full items-center justify-center gap-2 disabled:cursor-not-allowed disabled:opacity-50 md:w-auto"
      >
        {selectedSubtitle ? <CaptionIcon /> : <DownloadIcon />}
        {active
          ? active.status === 'preparing'
            ? `Preparing ${Math.round(active.progress)}%`
            : 'Starting...'
          : selectedSubtitle
            ? 'Prepare subtitled MP4'
            : 'Download original'}
      </button>
    </div>
  );
};
