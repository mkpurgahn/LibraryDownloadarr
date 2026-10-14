import { booksApi, booksErrorMessage, BOOKS_CHANGED_EVENT } from './api';
import { SESSION_CHANGED_EVENT } from '../stores/authStore';

export type DownloadSource =
  { source: 'plex'; ratingKey: string; partKey: string } |
  { source: 'abs'; providerInstanceId: string; libraryId: string; itemId: string; fileId: string; contentVersion: string };
export type BookDownloadTarget = Extract<DownloadSource, { source: 'abs' }> & { title?: string; filename?: string };
export type BookQueueItem = Extract<DownloadSource, { source: 'abs' }> & {
  id: string; filename: string; title: string; status: 'requesting' | 'ready' | 'started' | 'failed';
  mode: 'original'; error?: string; manualUrl?: string; expiresAt?: number; size?: number; resumable?: boolean;
};
const queueId = (target: BookDownloadTarget) =>
  `abs-${target.providerInstanceId}-${target.libraryId}-${target.itemId}-${target.fileId}-${target.contentVersion}`;

let downloadFrame: HTMLIFrameElement | undefined;
export function bookDownloadTarget(): string {
  if (!downloadFrame) {
    const frame = document.createElement('iframe');
    frame.name = `books-download-${crypto.randomUUID()}`;
    frame.title = 'Books original download';
    frame.hidden = true;
    // Allow session cookies and native downloads, but never book scripts, plugins or top navigation.
    frame.sandbox.add('allow-same-origin', 'allow-downloads');
    document.body.appendChild(frame);
    downloadFrame = frame;
    const clear = () => {
      frame.remove(); downloadFrame = undefined;
      window.removeEventListener(SESSION_CHANGED_EVENT, clear);
      window.removeEventListener(BOOKS_CHANGED_EVENT, clear);
      window.removeEventListener('pagehide', clear);
    };
    window.addEventListener(SESSION_CHANGED_EVENT, clear);
    window.addEventListener(BOOKS_CHANGED_EVENT, clear);
    window.addEventListener('pagehide', clear);
  }
  return downloadFrame.name;
}

function handoff(url: string): void {
  const anchor = document.createElement('a');
  anchor.href = url; anchor.target = bookDownloadTarget();
  const observed: { event?: MouseEvent } = {};
  anchor.addEventListener('click', event => { observed.event = event; }, { once: true });
  document.body.appendChild(anchor);
  try {
    anchor.click();
    if (!observed.event || observed.event.defaultPrevented) throw new Error('Browser download handoff cancelled');
  } finally { anchor.remove(); }
}

export async function startBookDownloads(
  targets: BookDownloadTarget[],
  options: { signal?: AbortSignal; onUpdate?: (item: BookQueueItem) => void } = {}
): Promise<{ started: number; failed: number }> {
  const unique = [...new Map(targets.map(target => [queueId(target), target])).values()];
  let started = 0; let failed = 0;
  const prepared: BookQueueItem[] = [];
  const row = (target: BookDownloadTarget): BookQueueItem => ({
    source: 'abs', providerInstanceId: target.providerInstanceId, libraryId: target.libraryId,
    itemId: target.itemId, fileId: target.fileId, contentVersion: target.contentVersion,
    id: queueId(target), filename: target.filename ?? 'Original file', title: target.title ?? 'Book download',
    status: 'requesting', mode: 'original',
  });
  const assertActive = () => { if (options.signal?.aborted) throw new DOMException('Download cancelled', 'AbortError'); };
  assertActive();
  for (const target of unique) options.onUpdate?.(row(target));
  for (let offset = 0; offset < unique.length; offset += 100) {
    assertActive();
    const chunk = unique.slice(offset, offset + 100);
    try {
      const results = await booksApi.tickets(chunk.map(target => ({
        itemId: target.itemId, fileId: target.fileId, contentVersion: target.contentVersion,
      })), options.signal);
      assertActive();
      results.forEach((result, index) => {
        const base = row(chunk[index]);
        if (!result.ticket) {
          failed += 1;
          prepared.push({ ...base, status: 'failed', error: `Original unavailable (${result.error?.code ?? 'BOOKS_UNAVAILABLE'}). Retry this file or reopen the book if it changed.` });
          return;
        }
        const ticket = result.ticket;
        const ready = { ...base, filename: ticket.filename, manualUrl: ticket.url, expiresAt: ticket.expiresAt, size: ticket.size, resumable: ticket.resumable };
        prepared.push({ ...ready, status: 'ready' });
      });
    } catch (error) {
      assertActive();
      const remaining = unique.slice(offset);
      failed += remaining.length;
      for (const target of remaining) prepared.push({ ...row(target), status: 'failed', error: booksErrorMessage(error) });
      break;
    }
  }
  assertActive();
  const first = prepared.find(item => item.status === 'ready' && item.manualUrl);
  if (first?.manualUrl) {
    try {
      handoff(first.manualUrl);
      first.status = 'started';
      started += 1;
    } catch {
      failed += 1;
      first.status = 'failed';
      first.error = 'Your browser needs a direct click. Use Save file below.';
    }
  }
  for (const item of prepared) options.onUpdate?.(item);
  return { started, failed };
}
