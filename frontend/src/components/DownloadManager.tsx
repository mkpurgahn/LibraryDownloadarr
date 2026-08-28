import React from 'react';
import { useDownloads } from '../contexts/DownloadContext';

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4 w-4 fill-none stroke-current stroke-2">
      <path d="m6 6 12 12M18 6 6 18" strokeLinecap="round" />
    </svg>
  );
}

export const DownloadManager: React.FC = () => {
  const { downloads, downloadPrepared, cancelBurnJob, removeDownload } = useDownloads();

  if (downloads.length === 0) return null;

  return (
    <aside
      aria-label="Download activity"
      className="fixed inset-x-3 bottom-3 z-50 max-h-[70vh] space-y-2 overflow-y-auto md:inset-x-auto md:bottom-auto md:right-6 md:top-20 md:w-[23rem]"
    >
      {downloads.map((download) => {
        const isPreparing = download.status === 'queued' || download.status === 'preparing';
        return (
          <section
            key={download.id}
            className="rounded-xl bg-dark-100 p-4 shadow-2xl shadow-black/40 ring-1 ring-white/10"
            aria-live="polite"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-white">{download.title}</div>
                <div className="mt-0.5 truncate text-xs text-gray-400">{download.filename}</div>
                {download.subtitleLabel && (
                  <div className="mt-1 line-clamp-2 text-xs text-primary-300">{download.subtitleLabel}</div>
                )}
              </div>
              <button
                type="button"
                onClick={() =>
                  isPreparing ? void cancelBurnJob(download.id) : removeDownload(download.id)
                }
                className="grid h-9 w-9 flex-none place-items-center rounded-lg text-gray-400 transition-colors hover:bg-white/5 hover:text-white focus:outline-none focus:ring-2 focus:ring-primary-500"
                aria-label={isPreparing ? 'Cancel preparation' : 'Dismiss download'}
              >
                <CloseIcon />
              </button>
            </div>

            {isPreparing && (
              <div className="mt-3">
                <div className="mb-1.5 flex items-center justify-between text-xs">
                  <span className="text-gray-300">
                    {download.status === 'queued' ? 'Waiting for the encoder' : 'Burning in subtitles'}
                  </span>
                  <span className="tabular-nums text-primary-300">{Math.round(download.progress)}%</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-dark-200">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-primary-500 to-secondary-500 transition-[width] duration-500"
                    style={{ width: `${download.progress}%` }}
                  />
                </div>
                <p className="mt-2 text-xs leading-5 text-gray-400">
                  You can close this page and return later. The original media is never changed.
                </p>
              </div>
            )}

            {download.status === 'ready' && (
              <div className="mt-3">
                <p className="text-xs leading-5 text-emerald-300">
                  Your subtitled MP4 is ready. The browser can pause and resume this file.
                </p>
                {download.error && (
                  <p className="mt-2 rounded-lg bg-red-500/10 px-3 py-2 text-xs leading-5 text-red-200">
                    {download.error}
                  </p>
                )}
                <button
                  type="button"
                  onClick={() => void downloadPrepared(download.id)}
                  className="btn-primary mt-3 min-h-11 w-full"
                >
                  Download prepared file
                </button>
              </div>
            )}

            {download.status === 'requesting' && (
              <p className="mt-3 text-xs text-gray-300">Securing your download...</p>
            )}

            {download.status === 'started' && (
              <p className="mt-3 text-xs leading-5 text-emerald-300">
                Sent to your browser. Use its Downloads panel to pause or resume.
              </p>
            )}

            {(download.status === 'failed' || download.status === 'cancelled') && (
              <div className="mt-3 rounded-lg bg-red-500/10 px-3 py-2 text-xs leading-5 text-red-200">
                {download.status === 'cancelled'
                  ? 'Preparation was cancelled.'
                  : download.error || 'The download could not be prepared. Try again.'}
              </div>
            )}
          </section>
        );
      })}
    </aside>
  );
};
