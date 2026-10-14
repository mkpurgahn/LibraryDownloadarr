import React from 'react';
import { useDownloads } from '../contexts/DownloadContext';
import { BookQueueItem, bookDownloadTarget } from '../books/downloads';
import { booksErrorMessage } from '../books/api';

function BookDownloadRow({ item, dismiss, retry, started }: {
  item: BookQueueItem; dismiss: () => void; retry: () => Promise<void>; started: (url: string) => void;
}) {
  const [retrying, setRetrying] = React.useState(false);
  const [notice, setNotice] = React.useState('');
  const renew = async () => {
    setRetrying(true); setNotice('');
    try { await retry(); } catch (error) { setNotice(booksErrorMessage(error)); }
    finally { setRetrying(false); }
  };
  return (
    <section className="rounded-xl bg-dark-100 p-4 shadow-2xl ring-1 ring-white/10" aria-live="polite">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{item.title}</div>
          <div className="mt-1 break-words text-xs text-gray-400">{item.filename}</div>
        </div>
        <button className="grid min-h-11 min-w-11 flex-none place-items-center rounded-lg hover:bg-white/5" onClick={dismiss} aria-label="Dismiss Books download"><CloseIcon /></button>
      </div>
      <p className="mt-3 text-sm font-medium">
        {item.status === 'requesting' ? 'Securing original...' : item.status === 'started' ? 'Started' : item.status === 'ready' ? 'Ready to save' : 'Needs attention'}
      </p>
      {item.status === 'started' && <p className="mt-1 text-xs text-gray-400">Sent to your browser, not confirmed complete. If it was blocked, use Save file.</p>}
      {item.status === 'ready' && <p className="mt-1 text-xs text-gray-400">Save this original when your current transfer finishes. Books allows two active streams per user.</p>}
      {item.resumable === false && <p className="mt-2 text-xs text-amber-300">Fresh original download only; this provider cannot safely resume.</p>}
      {(item.error || notice) && <p className="mt-2 rounded bg-red-500/10 p-2 text-xs text-red-200">{notice || item.error}</p>}
      {item.manualUrl && (
        <a tabIndex={0} className="btn-primary mt-3 flex min-h-11 w-full items-center justify-center" href={item.manualUrl}
          onClick={event => {
            if (!item.expiresAt || item.expiresAt <= Date.now()) {
              event.preventDefault(); setNotice('This link expired. Renew it before saving.');
              return;
            }
            if (event.defaultPrevented) return;
            event.currentTarget.target = bookDownloadTarget();
            const nativeEvent = event.nativeEvent;
            const url = item.manualUrl!;
            window.setTimeout(() => { if (!nativeEvent.defaultPrevented) started(url); }, 0);
          }}>
          Save file
        </a>
      )}
      {item.status !== 'requesting' && (
        <button className="btn-secondary mt-2 min-h-11 w-full" disabled={retrying} onClick={() => void renew()}>
          {retrying ? 'Renewing...' : 'Renew link and retry'}
        </button>
      )}
    </section>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4 w-4 fill-none stroke-current stroke-2">
      <path d="m6 6 12 12M18 6 6 18" strokeLinecap="round" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4 w-4 fill-current">
      <rect x="6" y="5" width="4" height="14" rx="1" />
      <rect x="14" y="5" width="4" height="14" rx="1" />
    </svg>
  );
}

function formatBytes(bytes = 0): string {
  if (!bytes) return '0 MB';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index > 2 ? 1 : 0)} ${units[index]}`;
}

export const DownloadManager: React.FC = () => {
  const {
    downloads,
    downloadPrepared,
    cancelBurnJob,
    removeDownload,
    pauseParallelDownload,
    resumeParallelDownload,
    retryBookDownload,
    markBookDownloadStarted,
  } = useDownloads();

  if (downloads.length === 0) return null;

  return (
    <aside
      aria-label="Download activity"
      className="fixed inset-x-3 bottom-[calc(0.75rem+var(--books-player-height,0px))] z-50 max-h-[calc(70vh-var(--books-player-height,0px))] space-y-2 overflow-y-auto md:inset-x-auto md:bottom-auto md:right-6 md:top-20 md:max-h-[min(70vh,calc(100vh_-_var(--books-player-height,0px)_-_6rem))] md:w-[23rem]"
    >
      {downloads.map((download) => {
        if (download.source === 'abs') {
          return <BookDownloadRow key={download.id} item={download} dismiss={() => removeDownload(download.id)}
            retry={() => retryBookDownload(download.id)} started={url => markBookDownloadStarted(download.id, url)} />;
        }
        const isPreparing = download.status === 'queued' || download.status === 'preparing';
        const isParallelActive =
          (download.transfer === 'parallel' || download.mode === 'parallel') &&
          (download.status === 'downloading' || download.status === 'pausing');
        const preparationLabel =
          download.status === 'queued'
            ? 'Waiting for the media worker'
            : download.mode === 'compatible'
              ? download.strategy === 'remux'
                ? 'Packaging as MP4'
                : download.strategy === 'audio'
                  ? 'Converting audio for MP4'
                  : 'Creating compatible MP4'
              : 'Burning in subtitles';
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
                  isPreparing
                    ? void cancelBurnJob(download.id)
                    : isParallelActive
                      ? pauseParallelDownload(download.id)
                      : removeDownload(download.id)
                }
                className="grid h-9 w-9 flex-none place-items-center rounded-lg text-gray-400 transition-colors hover:bg-white/5 hover:text-white focus:outline-none focus:ring-2 focus:ring-primary-500"
                aria-label={
                  isPreparing
                    ? 'Cancel preparation'
                    : isParallelActive
                      ? 'Pause download'
                      : 'Dismiss download'
                }
              >
                {isParallelActive ? <PauseIcon /> : <CloseIcon />}
              </button>
            </div>

            {isPreparing && (
              <div className="mt-3">
                <div className="mb-1.5 flex items-center justify-between text-xs">
                  <span className="text-gray-300">
                    {preparationLabel}
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
                  You can close this page and return later. The MP4 downloads automatically when ready.
                </p>
              </div>
            )}

            {download.status === 'ready' && (
              <div className="mt-3">
                <p className="text-xs leading-5 text-emerald-300">
                  Your MP4 is ready. {download.error ? 'Automatic download needs your help.' : 'Starting download...'}
                </p>
                {download.error && (
                  <>
                    <p className="mt-2 rounded-lg bg-red-500/10 px-3 py-2 text-xs leading-5 text-red-200">
                      {download.error}
                    </p>
                    <button
                      type="button"
                      onClick={() => void downloadPrepared(download.id)}
                      className="btn-primary mt-3 min-h-11 w-full"
                    >
                      Retry download
                    </button>
                  </>
                )}
              </div>
            )}

            {download.status === 'requesting' && (
              <p className="mt-3 text-xs text-gray-300">
                {download.mode === 'compatible' || download.mode === 'burned'
                  ? 'Starting media preparation...'
                  : 'Securing your download...'}
              </p>
            )}

            {download.status === 'started' && (
              <p className="mt-3 text-xs leading-5 text-emerald-300">
                Sent to your browser. Use its Downloads panel to pause or resume.
              </p>
            )}

            {(download.transfer === 'parallel' || download.mode === 'parallel') &&
              ['downloading', 'pausing', 'paused'].includes(download.status) && (
                <div className="mt-3">
                  <div className="mb-1.5 flex items-center justify-between gap-3 text-xs">
                    <span className="text-gray-300">
                      {download.status === 'paused'
                        ? 'Paused'
                        : download.status === 'pausing'
                          ? 'Saving progress...'
                          : `${formatBytes(download.downloadedBytes)} of ${formatBytes(download.size)}`}
                    </span>
                    <span className="tabular-nums text-primary-300">
                      {Math.round(download.progress)}%
                    </span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-dark-200">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-primary-500 to-secondary-500 transition-[width] duration-300"
                      style={{ width: `${download.progress}%` }}
                    />
                  </div>
                  {download.status === 'paused' && (
                    <div className="mt-3 grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={() => void resumeParallelDownload(download.id)}
                        className="btn-primary min-h-11"
                      >
                        Resume
                      </button>
                      <button
                        type="button"
                        onClick={() => removeDownload(download.id)}
                        className="btn-secondary min-h-11"
                      >
                        Discard
                      </button>
                    </div>
                  )}
                  <p className="mt-2 text-xs leading-5 text-gray-400">
                    {download.status === 'paused'
                      ? 'Choose the same partial file when prompted to continue safely.'
                      : 'Keep this page open. Pause before closing it to save a resumable checkpoint.'}
                  </p>
                </div>
              )}

            {download.status === 'complete' && (
              <p className="mt-3 text-xs leading-5 text-emerald-300">
                Saved to the file you selected.
              </p>
            )}

            {(download.status === 'failed' || download.status === 'cancelled') && (
              <div className="mt-3">
                <div className="rounded-lg bg-red-500/10 px-3 py-2 text-xs leading-5 text-red-200">
                  {download.status === 'cancelled'
                    ? 'Preparation was cancelled.'
                    : download.error || 'The download could not be prepared. Try again.'}
                </div>
                {(download.transfer === 'parallel' || download.mode === 'parallel') &&
                  download.status === 'failed' && (
                  <button
                    type="button"
                    onClick={() => void resumeParallelDownload(download.id)}
                    className="btn-primary mt-3 min-h-11 w-full"
                  >
                    Retry accelerated download
                  </button>
                  )}
              </div>
            )}
          </section>
        );
      })}
    </aside>
  );
};
