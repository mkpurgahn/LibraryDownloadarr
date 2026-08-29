import { DownloadTicket } from '../types';

const STORAGE_PREFIX = 'librarydownloadarr:parallel';
const MAX_CONNECTIONS = 4;
const MIN_SEGMENT_BYTES = 64 * 1024 * 1024;

interface WritableFileStream {
  write(data: { type: 'write'; position: number; data: Uint8Array }): Promise<void>;
  truncate(size: number): Promise<void>;
  close(): Promise<void>;
  abort(reason?: unknown): Promise<void>;
}

export interface ParallelFileHandle {
  name: string;
  getFile(): Promise<File>;
  createWritable(options?: {
    keepExistingData?: boolean;
    mode?: 'exclusive' | 'siloed';
  }): Promise<WritableFileStream>;
}

type SaveFilePicker = (options: { suggestedName: string }) => Promise<ParallelFileHandle>;

interface FilePickerWindow extends Window {
  showSaveFilePicker?: SaveFilePicker;
}

export interface ParallelSegment {
  start: number;
  end: number;
  next: number;
}

export interface ParallelCheckpoint {
  id: string;
  userId: string;
  ratingKey: string;
  partKey: string;
  filename: string;
  title: string;
  mode?: 'original' | 'burned' | 'compatible';
  jobId?: string;
  etag: string;
  totalBytes: number;
  segments: ParallelSegment[];
  lastModified: number;
  updatedAt: number;
}

interface ParallelDownloadOptions {
  id: string;
  userId: string;
  ratingKey: string;
  partKey: string;
  filename: string;
  title: string;
  mode?: 'original' | 'burned' | 'compatible';
  jobId?: string;
  handle?: ParallelFileHandle;
  signal: AbortSignal;
  createTicket: () => Promise<DownloadTicket>;
  resolveUrl: (url: string) => Promise<string>;
  onProgress: (downloadedBytes: number, totalBytes: number) => void;
}

const checkpointKey = (userId: string, id: string): string =>
  `${STORAGE_PREFIX}:${userId}:${id}`;

const parseCheckpoint = (value: string | null): ParallelCheckpoint | undefined => {
  if (!value) return undefined;
  try {
    const checkpoint = JSON.parse(value) as ParallelCheckpoint;
    if (
      !checkpoint.id ||
      !checkpoint.userId ||
      !checkpoint.etag ||
      !Number.isFinite(checkpoint.totalBytes) ||
      !Array.isArray(checkpoint.segments)
    ) {
      return undefined;
    }
    return checkpoint;
  } catch {
    return undefined;
  }
};

const saveCheckpoint = (checkpoint: ParallelCheckpoint): void => {
  localStorage.setItem(
    checkpointKey(checkpoint.userId, checkpoint.id),
    JSON.stringify(checkpoint)
  );
};

export const removeParallelCheckpoint = (userId: string, id: string): void => {
  localStorage.removeItem(checkpointKey(userId, id));
};

export const loadParallelCheckpoints = (userId: string): ParallelCheckpoint[] => {
  const prefix = `${STORAGE_PREFIX}:${userId}:`;
  const checkpoints: ParallelCheckpoint[] = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (!key?.startsWith(prefix)) continue;
    const checkpoint = parseCheckpoint(localStorage.getItem(key));
    if (checkpoint) checkpoints.push(checkpoint);
  }
  return checkpoints.sort((left, right) => right.updatedAt - left.updatedAt);
};

export const supportsParallelDownloads = (): boolean =>
  window.isSecureContext &&
  typeof (window as FilePickerWindow).showSaveFilePicker === 'function';

export const pickParallelDownloadFile = async (
  suggestedName: string
): Promise<ParallelFileHandle> => {
  const picker = (window as FilePickerWindow).showSaveFilePicker;
  if (!picker || !window.isSecureContext) {
    throw new Error('Accelerated downloads require a desktop Chromium browser.');
  }
  return picker({ suggestedName });
};

const createSegments = (totalBytes: number): ParallelSegment[] => {
  const segmentCount = Math.max(
    1,
    Math.min(MAX_CONNECTIONS, Math.ceil(totalBytes / MIN_SEGMENT_BYTES))
  );
  const segmentSize = Math.ceil(totalBytes / segmentCount);
  return Array.from({ length: segmentCount }, (_, index) => {
    const start = index * segmentSize;
    const end = Math.min(totalBytes - 1, start + segmentSize - 1);
    return { start, end, next: start };
  });
};

export const getParallelDownloadedBytes = (segments: ParallelSegment[]): number =>
  segments.reduce(
    (total, segment) => total + Math.max(0, Math.min(segment.next, segment.end + 1) - segment.start),
    0
  );

const checkpointHighWaterMark = (segments: ParallelSegment[]): number =>
  segments.reduce(
    (highest, segment) =>
      Math.max(highest, segment.next > segment.start ? segment.next : 0),
    0
  );

const requestCredentials = (url: string): RequestCredentials =>
  new URL(url, window.location.origin).origin === window.location.origin
    ? 'same-origin'
    : 'omit';

const getTicketMetadata = async (
  url: string
): Promise<{ etag: string; totalBytes: number }> => {
  const response = await fetch(url, {
    method: 'HEAD',
    cache: 'no-store',
    credentials: requestCredentials(url),
  });
  if (!response.ok) {
    throw new Error(`The download could not be prepared (${response.status}).`);
  }
  const totalBytes = Number(response.headers.get('content-length'));
  const etag = response.headers.get('etag') || '';
  if (
    !Number.isSafeInteger(totalBytes) ||
    totalBytes <= 0 ||
    response.headers.get('accept-ranges')?.toLowerCase() !== 'bytes' ||
    !etag
  ) {
    throw new Error('This server cannot provide a safe parallel download for this file.');
  }
  return { etag, totalBytes };
};

const isValidCheckpoint = (
  checkpoint: ParallelCheckpoint | undefined,
  options: ParallelDownloadOptions,
  file: File,
  metadata: { etag: string; totalBytes: number }
): checkpoint is ParallelCheckpoint =>
  Boolean(
    checkpoint &&
      checkpoint.ratingKey === options.ratingKey &&
      checkpoint.partKey === options.partKey &&
      (checkpoint.mode || 'original') === (options.mode || 'original') &&
      checkpoint.jobId === options.jobId &&
      checkpoint.filename === file.name &&
      checkpoint.etag === metadata.etag &&
      checkpoint.totalBytes === metadata.totalBytes &&
      checkpoint.lastModified === file.lastModified &&
      file.size >= checkpointHighWaterMark(checkpoint.segments) &&
      checkpoint.segments.every(
        segment =>
          Number.isSafeInteger(segment.start) &&
          Number.isSafeInteger(segment.end) &&
          Number.isSafeInteger(segment.next) &&
          segment.start >= 0 &&
          segment.start <= segment.next &&
          segment.next <= segment.end + 1 &&
          segment.end < metadata.totalBytes
      )
  );

export const runParallelDownload = async (
  options: ParallelDownloadOptions
): Promise<{ filename: string; totalBytes: number }> => {
  // The picker must be opened before any network await so the browser preserves user activation.
  const handle = options.handle || await pickParallelDownloadFile(options.filename);
  const ticket = await options.createTicket();
  const resolvedUrl = await options.resolveUrl(ticket.url);
  const metadata = await getTicketMetadata(resolvedUrl);
  const selectedFile = await handle.getFile();
  const stored = parseCheckpoint(
    localStorage.getItem(checkpointKey(options.userId, options.id))
  );
  const resuming = isValidCheckpoint(stored, options, selectedFile, metadata);
  if (stored && !resuming) {
    throw new Error(
      'The selected file does not match this paused download. Choose its existing partial file, or discard the checkpoint before starting over.'
    );
  }
  const segments = resuming
    ? stored.segments.map(segment => ({ ...segment }))
    : createSegments(metadata.totalBytes);
  const writable = await handle.createWritable({
    keepExistingData: resuming,
    mode: 'exclusive',
  });
  if (!resuming) await writable.truncate(0);

  saveCheckpoint({
    id: options.id,
    userId: options.userId,
    ratingKey: options.ratingKey,
    partKey: options.partKey,
    filename: handle.name,
    title: options.title,
    mode: options.mode,
    jobId: options.jobId,
    etag: metadata.etag,
    totalBytes: metadata.totalBytes,
    segments,
    lastModified: selectedFile.lastModified,
    updatedAt: Date.now(),
  });

  const controller = new AbortController();
  const abort = () => controller.abort(options.signal.reason);
  if (options.signal.aborted) abort();
  options.signal.addEventListener('abort', abort, { once: true });

  let writeQueue: Promise<void> = Promise.resolve();
  let lastProgressAt = 0;
  const reportProgress = (force = false) => {
    const now = Date.now();
    if (!force && now - lastProgressAt < 200) return;
    lastProgressAt = now;
    options.onProgress(getParallelDownloadedBytes(segments), metadata.totalBytes);
  };
  const writeAt = (position: number, data: Uint8Array): Promise<void> => {
    const operation = writeQueue.then(() =>
      writable.write({ type: 'write', position, data })
    );
    writeQueue = operation.catch(() => undefined);
    return operation;
  };

  const readWithTimeout = async (
    reader: ReadableStreamDefaultReader<Uint8Array>,
    requestController: AbortController
  ): Promise<ReadableStreamReadResult<Uint8Array>> => {
    let timer: number | undefined;
    try {
      return await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = window.setTimeout(() => {
            requestController.abort();
            reject(new Error('A parallel connection stalled.'));
          }, 45_000);
        }),
      ]);
    } finally {
      if (timer !== undefined) window.clearTimeout(timer);
    }
  };

  const workers = segments.map(async segment => {
    let attempts = 0;
    while (segment.next <= segment.end) {
      attempts += 1;
      const requestController = new AbortController();
      const abortRequest = () => requestController.abort(controller.signal.reason);
      if (controller.signal.aborted) abortRequest();
      controller.signal.addEventListener('abort', abortRequest, { once: true });
      const requestStart = segment.next;
      try {
        const response = await fetch(resolvedUrl, {
          headers: {
            Range: `bytes=${requestStart}-${segment.end}`,
            'If-Range': metadata.etag,
          },
          cache: 'no-store',
          credentials: requestCredentials(resolvedUrl),
          signal: requestController.signal,
        });
        if (response.status !== 206 || !response.body) {
          throw new Error(
            response.status === 200
              ? 'The source file changed. Start a new accelerated download.'
              : `A parallel connection failed (${response.status}).`
          );
        }
        const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(
          response.headers.get('content-range') || ''
        );
        if (
          !range ||
          Number(range[1]) !== requestStart ||
          Number(range[2]) > segment.end ||
          Number(range[3]) !== metadata.totalBytes
        ) {
          throw new Error('The server returned an unexpected byte range.');
        }

        const reader = response.body.getReader();
        while (segment.next <= segment.end) {
          const { done, value } = await readWithTimeout(reader, requestController);
          if (done) break;
          if (value.byteLength > segment.end + 1 - segment.next) {
            throw new Error('The server returned an unexpected byte range.');
          }
          await writeAt(segment.next, value);
          segment.next += value.byteLength;
          reportProgress();
        }
        if (segment.next === segment.end + 1) return;
        throw new Error('A parallel connection ended before its range was complete.');
      } catch (error) {
        if (controller.signal.aborted) throw error;
        if (
          error instanceof Error &&
          (error.message.includes('source file changed') ||
            error.message.includes('unexpected byte range'))
        ) {
          throw error;
        }
        if (segment.next > requestStart) attempts = 0;
        if (attempts >= 3) throw error;
        await new Promise(resolve => window.setTimeout(resolve, attempts * 750));
      } finally {
        controller.signal.removeEventListener('abort', abortRequest);
        requestController.abort();
      }
    }
  });

  let committed = false;
  let checkpointDiscarded = false;
  try {
    reportProgress(true);
    await Promise.all(workers);
    await writeQueue;
    await writable.close();
    committed = true;
    const completedFile = await handle.getFile();
    if (completedFile.size !== metadata.totalBytes) {
      removeParallelCheckpoint(options.userId, options.id);
      checkpointDiscarded = true;
      throw new Error('The saved file size does not match the source file.');
    }
    removeParallelCheckpoint(options.userId, options.id);
    options.onProgress(metadata.totalBytes, metadata.totalBytes);
    return { filename: handle.name, totalBytes: metadata.totalBytes };
  } catch (error) {
    controller.abort();
    await Promise.allSettled(workers);
    await writeQueue.catch(() => undefined);
    if (!committed) {
      try {
        await writable.close();
        committed = true;
      } catch {
        await writable.abort(error).catch(() => undefined);
        removeParallelCheckpoint(options.userId, options.id);
        checkpointDiscarded = true;
        throw new Error(
          'The partial file could not be saved. Check the destination disk space and start again.'
        );
      }
    }
    const partialFile = await handle.getFile().catch(() => selectedFile);
    if (partialFile.size < checkpointHighWaterMark(segments)) {
      removeParallelCheckpoint(options.userId, options.id);
      checkpointDiscarded = true;
      throw new Error('The saved partial file is incomplete and cannot be resumed safely.');
    }
    if (!checkpointDiscarded) {
      saveCheckpoint({
        id: options.id,
        userId: options.userId,
        ratingKey: options.ratingKey,
        partKey: options.partKey,
        filename: handle.name,
        title: options.title,
        mode: options.mode,
        jobId: options.jobId,
        etag: metadata.etag,
        totalBytes: metadata.totalBytes,
        segments,
        lastModified: partialFile.lastModified,
        updatedAt: Date.now(),
      });
    }
    throw error;
  } finally {
    options.signal.removeEventListener('abort', abort);
  }
};
