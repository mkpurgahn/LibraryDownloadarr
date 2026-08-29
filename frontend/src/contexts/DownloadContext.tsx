import React, { createContext, useContext, useEffect, useMemo, useState, ReactNode } from 'react';
import { api } from '../services/api';
import { BatchDownloadTarget, BatchDownloadTicket, BurnJob, BurnJobStatus } from '../types';

export type DownloadStatus = BurnJobStatus | 'requesting' | 'started';

export interface Download {
  id: string;
  ratingKey: string;
  partKey: string;
  filename: string;
  title: string;
  progress: number;
  status: DownloadStatus;
  mode: 'original' | 'burned';
  subtitleLabel?: string;
  jobId?: string;
  size?: number;
  error?: string;
}

interface DownloadContextType {
  downloads: Download[];
  startOriginalDownload: (
    ratingKey: string,
    partKey: string,
    filename: string,
    title: string
  ) => Promise<void>;
  startOriginalDownloads: (
    targets: BatchDownloadTarget[]
  ) => Promise<{ started: number; failed: number }>;
  startBurnJob: (
    ratingKey: string,
    partKey: string,
    filename: string,
    title: string,
    subtitleStreamId: number | string,
    subtitleLabel: string
  ) => Promise<void>;
  downloadPrepared: (id: string) => Promise<void>;
  cancelBurnJob: (id: string) => Promise<void>;
  removeDownload: (id: string) => void;
}

const STORAGE_KEY = 'librarydownloadarr:burn-jobs';
const ACTIVE_STATUSES = new Set<DownloadStatus>(['queued', 'preparing']);

const DownloadContext = createContext<DownloadContextType | undefined>(undefined);

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
  return error instanceof Error ? error.message : 'The download could not be started.';
}

function triggerBrowserDownload(url: string, filename: string): void {
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function storedDownloads(userId: string): Download[] {
  try {
    localStorage.removeItem(STORAGE_KEY);
    const parsed = JSON.parse(localStorage.getItem(`${STORAGE_KEY}:${userId}`) || '[]') as Download[];
    return parsed.filter((download) => download.mode === 'burned' && download.jobId);
  } catch {
    localStorage.removeItem(`${STORAGE_KEY}:${userId}`);
    return [];
  }
}

function responseStatus(error: unknown): number | undefined {
  if (
    typeof error === 'object' &&
    error !== null &&
    'response' in error &&
    typeof error.response === 'object' &&
    error.response !== null &&
    'status' in error.response &&
    typeof error.response.status === 'number'
  ) {
    return error.response.status;
  }
  return undefined;
}

function mergeJob(download: Download, job: BurnJob): Download {
  return {
    ...download,
    id: job.id,
    jobId: job.id,
    ratingKey: job.ratingKey || download.ratingKey,
    partKey: job.partKey || download.partKey,
    filename: job.filename || download.filename,
    progress: Number.isFinite(job.progress) ? Math.max(0, Math.min(100, job.progress)) : download.progress,
    status: job.status,
    size: job.size,
    error: job.error,
  };
}

export const useDownloads = () => {
  const context = useContext(DownloadContext);
  if (!context) throw new Error('useDownloads must be used within a DownloadProvider');
  return context;
};

export const DownloadProvider: React.FC<{ children: ReactNode; userId: string }> = ({
  children,
  userId,
}) => {
  const [downloads, setDownloads] = useState<Download[]>(() => storedDownloads(userId));

  const activeJobKey = useMemo(
    () =>
      downloads
        .filter((download) => download.jobId && ACTIVE_STATUSES.has(download.status))
        .map((download) => download.jobId)
        .sort()
        .join(','),
    [downloads]
  );

  useEffect(() => {
    localStorage.setItem(
      `${STORAGE_KEY}:${userId}`,
      JSON.stringify(downloads.filter((download) => download.mode === 'burned' && download.jobId))
    );
  }, [downloads, userId]);

  useEffect(() => {
    const jobIds = activeJobKey.split(',').filter(Boolean);
    if (jobIds.length === 0) return;

    let active = true;
    const refresh = async () => {
      const results = await Promise.allSettled(jobIds.map((jobId) => api.getBurnJob(jobId)));
      if (!active) return;
      setDownloads((current) =>
        current.map((download) => {
          const index = jobIds.indexOf(download.jobId || '');
          if (index < 0) return download;
          const result = results[index];
          if (result.status === 'fulfilled') return mergeJob(download, result.value);
          const status = responseStatus(result.reason);
          if (status === 403 || status === 404) {
            return {
              ...download,
              status: 'failed',
              error: status === 403
                ? 'Your Plex access to this server is no longer active.'
                : 'This preparation job is no longer available.',
            };
          }
          return download;
        })
      );
    };

    void refresh();
    const timer = window.setInterval(refresh, 3000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [activeJobKey]);

  const startOriginalDownload: DownloadContextType['startOriginalDownload'] = async (
    ratingKey,
    partKey,
    filename,
    title
  ) => {
    const id = `original-${ratingKey}-${partKey}`;
    setDownloads((current) => [
      ...current.filter((download) => download.id !== id),
      {
        id,
        ratingKey,
        partKey,
        filename,
        title,
        progress: 0,
        status: 'requesting',
        mode: 'original',
      },
    ]);

    try {
      const ticket = await api.createDownloadTicket(ratingKey, partKey);
      triggerBrowserDownload(ticket.url, ticket.filename || filename);
      setDownloads((current) =>
        current.map((download) =>
          download.id === id
            ? { ...download, filename: ticket.filename || filename, progress: 100, status: 'started' }
            : download
        )
      );
      window.setTimeout(() => {
        setDownloads((current) => current.filter((download) => download.id !== id));
      }, 8000);
    } catch (error) {
      setDownloads((current) =>
        current.map((download) =>
          download.id === id ? { ...download, status: 'failed', error: errorMessage(error) } : download
        )
      );
    }
  };

  const startOriginalDownloads: DownloadContextType['startOriginalDownloads'] = async (targets) => {
    const uniqueTargets = Array.from(
      new Map(targets.map((target) => [`${target.ratingKey}:${target.partKey}`, target])).values()
    );
    const ids = uniqueTargets.map((target) => `original-${target.ratingKey}-${target.partKey}`);
    setDownloads((current) => [
      ...current.filter((download) => !ids.includes(download.id)),
      ...uniqueTargets.map((target) => ({
        id: `original-${target.ratingKey}-${target.partKey}`,
        ratingKey: target.ratingKey,
        partKey: target.partKey,
        filename: target.filename,
        title: target.title,
        progress: 0,
        status: 'requesting' as const,
        mode: 'original' as const,
      })),
    ]);

    const tickets: BatchDownloadTicket[] = [];
    const failures: Array<{ ratingKey: string; partKey: string; error: string }> = [];
    for (let index = 0; index < uniqueTargets.length; index += 100) {
      const chunk = uniqueTargets.slice(index, index + 100);
      try {
        const result = await api.createDownloadTickets(chunk);
        tickets.push(...result.tickets);
        failures.push(...result.errors);
      } catch (error) {
        const message = errorMessage(error);
        failures.push(
          ...chunk.map((target) => ({
            ratingKey: target.ratingKey,
            partKey: target.partKey,
            error: message,
          }))
        );
      }
    }

    const ticketKeys = new Set(tickets.map((ticket) => `${ticket.ratingKey}:${ticket.partKey}`));
    const errorByKey = new Map(
      failures.map((failure) => [`${failure.ratingKey}:${failure.partKey}`, failure.error])
    );

    for (const ticket of tickets) {
      const target = uniqueTargets.find(
        (item) => item.ratingKey === ticket.ratingKey && item.partKey === ticket.partKey
      );
      triggerBrowserDownload(ticket.url, ticket.filename || target?.filename || 'download');
    }

    setDownloads((current) =>
      current.map((download) => {
        const key = `${download.ratingKey}:${download.partKey}`;
        if (!ids.includes(download.id)) return download;
        if (ticketKeys.has(key)) {
          const ticket = tickets.find(
            (item) => item.ratingKey === download.ratingKey && item.partKey === download.partKey
          );
          return {
            ...download,
            filename: ticket?.filename || download.filename,
            progress: 100,
            status: 'started',
          };
        }
        return {
          ...download,
          status: 'failed',
          error: errorByKey.get(key) || 'The download could not be started.',
        };
      })
    );
    window.setTimeout(() => {
      setDownloads((current) =>
        current.filter((download) => !ids.includes(download.id) || download.status !== 'started')
      );
    }, 8000);
    return { started: tickets.length, failed: failures.length };
  };

  const startBurnJob: DownloadContextType['startBurnJob'] = async (
    ratingKey,
    partKey,
    filename,
    title,
    subtitleStreamId,
    subtitleLabel
  ) => {
    const pendingId = `burn-${ratingKey}-${partKey}-${subtitleStreamId}`;
    setDownloads((current) => [
      ...current.filter((download) => download.id !== pendingId),
      {
        id: pendingId,
        ratingKey,
        partKey,
        filename,
        title,
        progress: 0,
        status: 'requesting',
        mode: 'burned',
        subtitleLabel,
      },
    ]);

    try {
      const job = await api.createBurnJob(ratingKey, partKey, subtitleStreamId);
      setDownloads((current) => {
        const pending = current.find((download) => download.id === pendingId);
        if (!pending) return current;
        return [
          ...current.filter((download) => download.id !== pendingId && download.id !== job.id),
          mergeJob(pending, job),
        ];
      });
    } catch (error) {
      setDownloads((current) =>
        current.map((download) =>
          download.id === pendingId ? { ...download, status: 'failed', error: errorMessage(error) } : download
        )
      );
    }
  };

  const downloadPrepared: DownloadContextType['downloadPrepared'] = async (id) => {
    const download = downloads.find((item) => item.id === id);
    if (!download?.jobId || download.status !== 'ready') return;
    try {
      const ticket = await api.createBurnJobTicket(download.jobId);
      triggerBrowserDownload(ticket.url, ticket.filename || download.filename);
      setDownloads((current) =>
        current.map((item) => (item.id === id ? { ...item, error: undefined } : item))
      );
    } catch (error) {
      setDownloads((current) =>
        current.map((item) =>
          item.id === id ? { ...item, error: errorMessage(error) } : item
        )
      );
    }
  };

  const cancelBurnJob: DownloadContextType['cancelBurnJob'] = async (id) => {
    const download = downloads.find((item) => item.id === id);
    if (!download?.jobId) {
      setDownloads((current) => current.filter((item) => item.id !== id));
      return;
    }
    try {
      const job = await api.cancelBurnJob(download.jobId);
      setDownloads((current) =>
        current.map((item) => (item.id === id ? mergeJob(item, job) : item))
      );
    } catch (error) {
      setDownloads((current) =>
        current.map((item) =>
          item.id === id ? { ...item, status: 'failed', error: errorMessage(error) } : item
        )
      );
    }
  };

  const removeDownload = (id: string) => {
    setDownloads((current) => current.filter((download) => download.id !== id));
  };

  return (
    <DownloadContext.Provider
      value={{
        downloads,
        startOriginalDownload,
        startOriginalDownloads,
        startBurnJob,
        downloadPrepared,
        cancelBurnJob,
        removeDownload,
      }}
    >
      {children}
    </DownloadContext.Provider>
  );
};
