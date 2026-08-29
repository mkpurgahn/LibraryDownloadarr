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
const ORIGIN_PROBE_TTL_MS = 30_000;
const ORIGIN_PROBE_TIMEOUT_MS = 2_500;
const originReachability = new Map<string, { expiresAt: number; reachable: boolean }>();
const originProbes = new Map<string, Promise<boolean>>();

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

function sameOriginTicketUrl(url: string): string {
  const parsed = new URL(url, window.location.origin);
  return `${parsed.pathname}${parsed.search}`;
}

async function canReachDownloadOrigin(url: string): Promise<boolean> {
  const parsed = new URL(url, window.location.origin);
  if (parsed.origin === window.location.origin) return true;

  const cached = originReachability.get(parsed.origin);
  if (cached && cached.expiresAt > Date.now()) return cached.reachable;

  const pending = originProbes.get(parsed.origin);
  if (pending) return pending;

  const probe = (async () => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), ORIGIN_PROBE_TIMEOUT_MS);
    try {
      const response = await fetch(new URL('/api/health', parsed.origin), {
        method: 'HEAD',
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        signal: controller.signal,
      });
      return response.ok;
    } catch {
      return false;
    } finally {
      window.clearTimeout(timer);
    }
  })();

  originProbes.set(parsed.origin, probe);
  try {
    const reachable = await probe;
    originReachability.set(parsed.origin, {
      expiresAt: Date.now() + ORIGIN_PROBE_TTL_MS,
      reachable,
    });
    return reachable;
  } finally {
    originProbes.delete(parsed.origin);
  }
}

async function resolveTicketUrls(urls: string[]): Promise<string[]> {
  if (urls.length === 0) return [];
  if (await canReachDownloadOrigin(urls[0])) return urls;

  const fallbackUrls = urls.map(sameOriginTicketUrl);
  let response: Response;
  try {
    response = await fetch(fallbackUrls[0], {
      method: 'HEAD',
      cache: 'no-store',
      credentials: 'same-origin',
    });
  } catch {
    throw new Error('The download connection is unavailable. Check your network and try again.');
  }
  if (response.ok) return fallbackUrls;
  if (response.status === 403) {
    throw new Error('Your Plex access to this file is no longer active.');
  }
  if (response.status === 404) {
    throw new Error('The download ticket expired. Start the download again.');
  }
  if (response.status === 409) {
    throw new Error('This file changed after the ticket was created. Start the download again.');
  }
  throw new Error('The download service is temporarily unavailable. Try again shortly.');
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
      const [resolvedUrl] = await resolveTicketUrls([ticket.url]);
      triggerBrowserDownload(resolvedUrl, ticket.filename || filename);
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

    let startedTickets = tickets;
    try {
      const resolvedUrls = await resolveTicketUrls(tickets.map((ticket) => ticket.url));
      tickets.forEach((ticket, index) => {
        const target = uniqueTargets.find(
          (item) => item.ratingKey === ticket.ratingKey && item.partKey === ticket.partKey
        );
        triggerBrowserDownload(
          resolvedUrls[index],
          ticket.filename || target?.filename || 'download'
        );
      });
    } catch (error) {
      const message = errorMessage(error);
      failures.push(
        ...tickets.map((ticket) => ({
          ratingKey: ticket.ratingKey,
          partKey: ticket.partKey,
          error: message,
        }))
      );
      startedTickets = [];
    }

    const ticketKeys = new Set(
      startedTickets.map((ticket) => `${ticket.ratingKey}:${ticket.partKey}`)
    );
    const errorByKey = new Map(
      failures.map((failure) => [`${failure.ratingKey}:${failure.partKey}`, failure.error])
    );

    setDownloads((current) =>
      current.map((download) => {
        const key = `${download.ratingKey}:${download.partKey}`;
        if (!ids.includes(download.id)) return download;
        if (ticketKeys.has(key)) {
          const ticket = startedTickets.find(
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
    return { started: startedTickets.length, failed: failures.length };
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
      const [resolvedUrl] = await resolveTicketUrls([ticket.url]);
      triggerBrowserDownload(resolvedUrl, ticket.filename || download.filename);
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
