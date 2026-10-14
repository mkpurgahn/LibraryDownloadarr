import { booksApi, booksErrorMessage } from './api';

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

function handoff(url: string): void {
  const anchor = document.createElement('a');
  anchor.href = url; anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  try { anchor.click(); } finally { anchor.remove(); }
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
