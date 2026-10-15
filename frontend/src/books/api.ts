import { useAuthStore, SESSION_CHANGED_EVENT } from '../stores/authStore';
import {
  BookItem, BooksLibrary, BookTarget, BookTicketResult, BooksSettingsState, CatalogQuery,
  record, id, text, flag, integer, list, parseBookItem, parseBookSummary, parseCatalog, invalidResponse,
  parseReader, ProgressWrite,
} from './types';

export class BooksApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string, public readonly canonical?: unknown) {
    super(message); this.name = 'BooksApiError';
  }
}
export const aborted = (error: unknown): boolean => error instanceof DOMException && error.name === 'AbortError';
export const booksErrorMessage = (error: unknown): string => error instanceof Error ? error.message : 'Books is temporarily unavailable.';
const pending = new Set<AbortController>();
let bridge: { token: string; expiresAt: number } | undefined;
let exchange: { token: string; promise: Promise<void> } | undefined;
let generation = 0;
export const BOOKS_CHANGED_EVENT = 'librarydownloadarr:books-changed';
const booksChannel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('librarydownloadarr-books') : undefined;

function clearBooksSession(): void {
  generation += 1;
  bridge = undefined; exchange = undefined;
  for (const controller of pending) controller.abort();
  pending.clear();
}
window.addEventListener(SESSION_CHANGED_EVENT, clearBooksSession);
function invalidateBooks(broadcast = false): void {
  clearBooksSession();
  window.dispatchEvent(new Event(BOOKS_CHANGED_EVENT));
  if (broadcast) booksChannel?.postMessage({ type: 'configuration-changed' });
}
if (booksChannel) booksChannel.onmessage = event => {
  if (event.data?.type === 'configuration-changed') invalidateBooks();
};

type ResponseDecoder = (response: Response) => Promise<unknown>;
async function request(path: string, options: RequestInit = {}, signal?: AbortSignal, decode?: ResponseDecoder): Promise<unknown> {
  const token = useAuthStore.getState().token;
  if (!token) throw new BooksApiError(401, 'BOOKS_SESSION_REQUIRED', 'Sign in to LibraryDownloadarr to open Books.');
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  pending.add(controller);
  try {
    const headers = new Headers(options.headers);
    headers.set('Content-Type', 'application/json');
    headers.set('Authorization', `Bearer ${token}`);
    const response = await fetch(path, {
      ...options, cache: 'no-store', credentials: 'same-origin', redirect: 'error',
      headers,
      signal: controller.signal,
    });
    if (token !== useAuthStore.getState().token || controller.signal.aborted) throw new DOMException('Session changed', 'AbortError');
    if (response.status === 204) return undefined;
    const value: unknown = response.ok && decode ? await decode(response) :
      options.method === 'HEAD' && !response.ok ? { code: response.status === 409 ? 'BOOK_VERSION_CHANGED' : 'BOOK_CONTENT_UNAVAILABLE', error: 'Book content is unavailable.' } :
        await response.json();
    if (token !== useAuthStore.getState().token || controller.signal.aborted) throw new DOMException('Session changed', 'AbortError');
    if (!response.ok) {
      const error = record(value);
      throw new BooksApiError(
        response.status, typeof error.code === 'string' ? error.code : 'BOOKS_UNAVAILABLE',
        typeof error.error === 'string' ? error.error : 'Books is temporarily unavailable. Plex remains available.', error.canonical
      );
    }
    return value;
  } catch (error) {
    controller.abort();
    throw error;
  } finally {
    signal?.removeEventListener('abort', cancel);
    pending.delete(controller);
  }
}

async function mediaSession(signal?: AbortSignal): Promise<void> {
  const token = useAuthStore.getState().token;
  if (!token) throw new BooksApiError(401, 'BOOKS_SESSION_REQUIRED', 'Sign in to open Books.');
  if (bridge?.token === token && bridge.expiresAt > Date.now() + 30000) return;
  if (exchange?.token === token) return exchange.promise;
  const epoch = generation;
  if (signal?.aborted) throw new DOMException('Request cancelled', 'AbortError');
  const promise = request('/api/books/media-session', { method: 'POST', body: '{}' }).then(value => {
    if (epoch !== generation || token !== useAuthStore.getState().token) throw new DOMException('Session changed', 'AbortError');
    bridge = { token, expiresAt: integer(record(value).expiresAt) };
  });
  exchange = { token, promise };
  try { await promise; }
  catch (error) {
    if (error instanceof BooksApiError && (error.status === 401 || error.code === 'PLEX_ACCESS_REVOKED') &&
        token === useAuthStore.getState().token) useAuthStore.getState().setToken(null);
    throw error;
  } finally { if (exchange?.promise === promise) exchange = undefined; }
}

async function booksRequest(path: string, options: RequestInit = {}, signal?: AbortSignal, decode?: ResponseDecoder): Promise<unknown> {
  const token = useAuthStore.getState().token;
  await mediaSession(signal);
  if (token !== useAuthStore.getState().token) throw new DOMException('Session changed', 'AbortError');
  try { return await request(`/api/books${path}`, options, signal, decode); }
  catch (error) {
    if (error instanceof BooksApiError && ['BOOKS_DISABLED', 'BOOKS_CONFIGURATION_CHANGED'].includes(error.code)) invalidateBooks();
    if (error instanceof BooksApiError && (error.status === 401 || error.code === 'BOOKS_IDENTITY_MISMATCH')) {
      bridge = undefined;
      try { await mediaSession(signal); }
      catch (renewalError) {
        if (renewalError instanceof BooksApiError && ['BOOKS_DISABLED', 'BOOKS_CONFIGURATION_CHANGED'].includes(renewalError.code)) invalidateBooks();
        throw renewalError;
      }
      return request(`/api/books${path}`, options, signal, decode);
    }
    if (error instanceof BooksApiError && error.code === 'PLEX_ACCESS_REVOKED' && token === useAuthStore.getState().token) {
      useAuthStore.getState().setToken(null);
    }
    throw error;
  }
}

export interface BookContentInfo {
  size: number; mime: string; ranges: boolean; validator?: string;
}
const filePath = (target: BookTarget) =>
  `/items/${id(target.itemId)}/files/${id(target.fileId)}/content?${new URLSearchParams({ version: id(target.contentVersion) })}`;

function ticketResult(value: unknown): BookTicketResult {
  const raw = record(value);
  const target = record(raw.target);
  const result: BookTicketResult = {
    target: { itemId: id(target.itemId), fileId: id(target.fileId), contentVersion: id(target.contentVersion) },
  };
  if (raw.ticket) {
    const ticket = record(raw.ticket);
    const url = text(ticket.url, 500);
    if (!/^\/api\/books\/downloads\/[A-Za-z0-9_-]+$/.test(url)) throw invalidResponse();
    result.ticket = { url, expiresAt: integer(ticket.expiresAt), filename: text(ticket.filename, 255), size: integer(ticket.size), resumable: flag(ticket.resumable) };
  } else {
    const error = record(raw.error);
    result.error = { status: integer(error.status), code: id(error.code) };
  }
  return result;
}

function settings(value: unknown): BooksSettingsState {
  const raw = record(value);
  return {
    configured: flag(raw.configured), enabled: flag(raw.enabled), deploymentEnabled: flag(raw.deploymentEnabled),
    libraryId: id(raw.libraryId), configGeneration: integer(raw.configGeneration),
    ...(raw.providerInstanceId === undefined ? {} : { providerInstanceId: id(raw.providerInstanceId) }),
    ...(raw.serverBindingProofId === undefined ? {} : { serverBindingProofId: id(raw.serverBindingProofId) }),
  };
}

export const booksApi = {
  mediaSession,
  async libraries(signal?: AbortSignal): Promise<BooksLibrary[]> {
    return list(await booksRequest('/libraries', {}, signal), 1).map(value => {
      const raw = record(value);
      return { providerInstanceId: id(raw.providerInstanceId), libraryId: id(raw.libraryId), name: text(raw.name, 500) };
    });
  },
  async catalog(libraryId: string, query: CatalogQuery, signal?: AbortSignal) {
    const params = new URLSearchParams({
      page: String(query.page), limit: String(query.limit), filter: query.filter, sort: query.sort, desc: String(query.desc),
      ...(query.category ? { category: query.category } : {}),
      ...(query.q ? { q: query.q } : {}),
    });
    return parseCatalog(await booksRequest(`/libraries/${id(libraryId)}/items?${params}`, {}, signal));
  },
  async search(libraryId: string, q: string, signal?: AbortSignal) {
    const raw = record(await booksRequest(`/libraries/${id(libraryId)}/search?${new URLSearchParams({ q })}`, {}, signal));
    return list(raw.items, 50).map(parseBookSummary);
  },
  async item(itemId: string, signal?: AbortSignal): Promise<BookItem> {
    return parseBookItem(await booksRequest(`/items/${id(itemId)}`, {}, signal));
  },
  coverUrl(itemId: string): string { return `/api/books/items/${id(itemId)}/cover`; },
  contentUrl(target: BookTarget): string {
    return `/api/books${filePath(target)}`;
  },
  async contentInfo(target: BookTarget, signal: AbortSignal): Promise<BookContentInfo> {
    const raw = record(await booksRequest(filePath(target), { method: 'HEAD' }, signal, async response => {
      const length = response.headers.get('content-length');
      const etag = response.headers.get('etag');
      const modified = response.headers.get('last-modified');
      if (!length || !/^\d+$/.test(length)) throw invalidResponse();
      return { size: Number(length), mime: response.headers.get('content-type')?.split(';')[0],
        ranges: response.headers.get('accept-ranges') === 'bytes',
        validator: etag && !etag.startsWith('W/') ? etag : modified ?? undefined };
    }));
    return { size: integer(raw.size), mime: text(raw.mime, 100), ranges: flag(raw.ranges),
      ...(raw.validator === undefined ? {} : { validator: text(raw.validator, 1000) }) };
  },
  async contentRange(target: BookTarget, info: BookContentInfo, begin: number, end: number, signal: AbortSignal): Promise<ArrayBuffer> {
    if (!Number.isSafeInteger(begin) || !Number.isSafeInteger(end) || begin < 0 || end <= begin || end > info.size) throw invalidResponse();
    const bytes = await booksRequest(filePath(target), {
      headers: { Range: `bytes=${begin}-${end - 1}`, ...(info.validator ? { 'If-Range': info.validator } : {}) },
    }, signal, async response => {
      if (response.status !== 206 || response.headers.get('content-range') !== `bytes ${begin}-${end - 1}/${info.size}` ||
          Number(response.headers.get('content-length')) !== end - begin) {
        throw new BooksApiError(409, 'BOOK_RANGE_CHANGED', 'The original changed or no longer supports safe ranges. Open it again.');
      }
      const data = await response.arrayBuffer();
      if (data.byteLength !== end - begin) throw invalidResponse();
      return data;
    });
    if (!(bytes instanceof ArrayBuffer)) throw invalidResponse();
    return bytes;
  },
  async tickets(targets: BookTarget[], signal?: AbortSignal): Promise<BookTicketResult[]> {
    const raw = record(await booksRequest('/download-tickets', { method: 'POST', body: JSON.stringify({ targets }) }, signal));
    const results = list(raw.results, 100).map(ticketResult);
    if (results.length !== targets.length || results.some((result, index) =>
      result.target.itemId !== targets[index].itemId || result.target.fileId !== targets[index].fileId ||
      result.target.contentVersion !== targets[index].contentVersion)) throw invalidResponse();
    return results;
  },
  async prepareReader(target: BookTarget, signal?: AbortSignal) {
    return parseReader(await booksRequest(`/items/${id(target.itemId)}/reader`, {
      method: 'POST', body: JSON.stringify({ fileId: target.fileId, contentVersion: target.contentVersion }),
    }, signal));
  },
  async releaseReader(readerId: string) { await booksRequest(`/readers/${id(readerId)}`, { method: 'DELETE' }); },
  async readerResource(readerId: string, resourceId: string, size: number, signal: AbortSignal): Promise<ArrayBuffer> {
    const bytes = await booksRequest(`/readers/${id(readerId)}/resources/${id(resourceId)}`, {}, signal, async response => {
      if (Number(response.headers.get('content-length')) !== size ||
          response.headers.get('content-type') !== 'application/octet-stream') throw invalidResponse();
      const data = await response.arrayBuffer();
      if (data.byteLength !== size) throw invalidResponse();
      return data;
    });
    if (!(bytes instanceof ArrayBuffer)) throw invalidResponse();
    return bytes;
  },
  async loadProgress(itemId: string, mode: 'ebook' | 'audio', editionId: string, signal: AbortSignal) {
    return booksRequest(`/items/${id(itemId)}/progress/${mode}?${new URLSearchParams({ editionId: id(editionId) })}`, {}, signal);
  },
  async saveProgress(itemId: string, mode: 'ebook' | 'audio', editionId: string, write: ProgressWrite, signal: AbortSignal) {
    return booksRequest(`/items/${id(itemId)}/progress/${mode}`, {
      method: 'PUT', keepalive: true, body: JSON.stringify({ editionId, ...write }),
    }, signal);
  },
  async settings(signal?: AbortSignal) { return settings(await request('/api/settings/books', {}, signal)); },
  async saveSettings(value: {
    enabled: boolean; libraryId: string; origin?: string; credential?: string;
    serverBindingProofId: string; restrictedPrincipalConfirmed: boolean;
  }, signal?: AbortSignal) {
    const result = settings(await request('/api/settings/books', { method: 'PUT', body: JSON.stringify(value) }, signal));
    invalidateBooks(true);
    return result;
  },
  async verifySettings(signal?: AbortSignal) {
    const result = record(await request('/api/settings/books/verify', { method: 'POST', body: '{}' }, signal));
    if (result.connected !== true) throw new BooksApiError(502, 'ABS_UNAVAILABLE', 'Books connection could not be verified.');
  },
};
