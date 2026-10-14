import http, { IncomingMessage } from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import { createHash } from 'node:crypto';
import { BooksRepository } from './repository';
import { BookFile, BookItem, BookSummary, BooksConfig, CatalogPage, CatalogQuery } from './types';
import {
  BOOKS_LIMITS, BooksError, invalidInput, notFound, opaqueSegment, privateAddress, providerOrigin, validateCover,
} from './limits';

type Json = Record<string, unknown>;
const optionalObject = (value: unknown): Json | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : undefined;
const object = (value: unknown): Json => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BooksError(502, 'ABS_INVALID_RESPONSE');
  return value as Json;
};
const optionalArray = (value: unknown, max = 10000): unknown[] =>
  Array.isArray(value) && value.length <= max ? value : [];
const array = (value: unknown, max = 10000): unknown[] => {
  if (!Array.isArray(value) || value.length > max) throw new BooksError(502, 'ABS_INVALID_RESPONSE');
  return value;
};
const text = (value: unknown, max = 10000): string => typeof value === 'string' ?
  value.slice(0, max).replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<[^>]*>/g, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '') : '';
const number = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new BooksError(502, 'ABS_INVALID_RESPONSE');
  return value;
};
const names = (value: unknown, fallback?: unknown): string[] => {
  if (Array.isArray(value)) return value.slice(0, 1000).map(v => text(typeof v === 'string' ? v : optionalObject(v)?.name, 500)).filter(Boolean);
  const name = text(fallback, 1000);
  return name ? [name] : [];
};
const MIME: Record<string, string> = {
  epub: 'application/epub+zip', pdf: 'application/pdf', cbz: 'application/vnd.comicbook+zip',
  mp3: 'audio/mpeg', m4b: 'audio/mp4', m4a: 'audio/mp4', flac: 'audio/flac',
  ogg: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', aac: 'audio/aac',
};

export class AbsClient {
  private readonly origin: URL;
  constructor(
    private readonly config: BooksConfig,
    private readonly credential: string,
    private readonly files: Pick<BooksRepository, 'fileId'>
  ) {
    this.origin = providerOrigin(config.origin);
    if (!credential || /[\r\n]/.test(credential)) throw invalidInput();
  }
  private request(
    path: string, method: 'GET' | 'HEAD', signal: AbortSignal, headers: Record<string, string> = {}
  ): Promise<IncomingMessage> {
    const url = new URL(path, this.origin);
    if (url.origin !== this.origin.origin) throw invalidInput();
    return new Promise((resolve, reject) => {
      const request = (url.protocol === 'https:' ? https : http).request(url, {
        method, signal,
        headers: { Authorization: `Bearer ${this.credential}`, 'Accept-Encoding': 'identity', ...headers },
        lookup: (hostname, options, callback) => {
          dns.lookup(hostname, options, (error, addresses, family) => {
            if (error) { callback(error, addresses, family); return; }
            const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family }];
            if (url.protocol === 'http:' && list.some(entry => !privateAddress(entry.address))) {
              callback(new Error('Private provider address required'), '', 4); return;
            }
            callback(null, addresses, family);
          });
        },
      });
      const timeout = setTimeout(() => request.destroy(new Error('Provider connection deadline')), BOOKS_LIMITS.connectionTimeoutMs);
      request.once('response', response => {
        clearTimeout(timeout);
        response.setTimeout(BOOKS_LIMITS.idleTimeoutMs, () => response.destroy(new Error('Provider idle deadline')));
        // The consumer may not attach its stream handlers until the next microtask.
        response.on('error', () => undefined);
        if ((response.statusCode ?? 500) >= 300 && (response.statusCode ?? 500) < 400) {
          response.destroy(); reject(new BooksError(502, 'ABS_REDIRECT_REJECTED')); return;
        }
        resolve(response);
      });
      request.once('error', () => { clearTimeout(timeout); reject(new BooksError(503, 'ABS_UNAVAILABLE', 'Books provider unavailable')); });
      request.end();
    });
  }
  private checkStatus(response: IncomingMessage): void {
    const status = response.statusCode ?? 502;
    if (status === 404) { response.destroy(); throw notFound(); }
    if (status === 401 || status === 403) {
      response.destroy(); throw new BooksError(502, 'ABS_CONNECTION_DENIED', 'Books provider connection needs administrator attention');
    }
    if (status !== 200) { response.destroy(); throw new BooksError(status >= 500 ? 503 : 502, 'ABS_UNAVAILABLE'); }
  }
  private async body(response: IncomingMessage, max: number): Promise<Buffer> {
    this.checkStatus(response);
    const encoding = response.headers['content-encoding'];
    if (encoding && encoding !== 'identity') { response.destroy(); throw new BooksError(502, 'ABS_ENCODED_RESPONSE'); }
    if (Number(response.headers['content-length']) > max) { response.destroy(); throw new BooksError(502, 'ABS_RESPONSE_TOO_LARGE'); }
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of response) {
        const bytes: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > max) { response.destroy(); throw new BooksError(502, 'ABS_RESPONSE_TOO_LARGE'); }
        chunks.push(bytes);
      }
    } catch (error) {
      if (error instanceof BooksError) throw error;
      throw new BooksError(503, 'ABS_UNAVAILABLE');
    }
    return Buffer.concat(chunks, size);
  }
  private async json(path: string, signal: AbortSignal): Promise<Json> {
    const abort = new AbortController();
    const cancel = () => abort.abort();
    if (signal.aborted) abort.abort();
    signal.addEventListener('abort', cancel, { once: true });
    const timeout = setTimeout(cancel, BOOKS_LIMITS.metadataTimeoutMs);
    try {
      const response = await this.request(path, 'GET', abort.signal);
      const body = await this.body(response, BOOKS_LIMITS.metadataBytes);
      try { return object(JSON.parse(body.toString('utf8'))); }
      catch { throw new BooksError(502, 'ABS_INVALID_RESPONSE'); }
    } finally {
      clearTimeout(timeout); signal.removeEventListener('abort', cancel);
    }
  }
  private key(raw: Json) {
    if (raw.libraryId !== this.config.libraryId || raw.mediaType !== 'book') throw notFound();
    return { providerInstanceId: this.config.providerInstanceId, libraryId: this.config.libraryId, itemId: opaqueSegment(raw.id) };
  }
  private summary(raw: Json): BookSummary {
    const key = this.key(raw);
    const media = object(raw.media);
    const meta = optionalObject(media.metadata) ?? {};
    const hasEbook = Boolean(media.ebookFile || media.ebookFormat);
    const audioTrackCount = number(media.numTracks ?? media.numAudioFiles ??
      (Array.isArray(media.tracks) ? media.tracks.length : Array.isArray(media.audioFiles) ? media.audioFiles.length : 0));
    const missing = raw.isMissing === true;
    const invalid = raw.isInvalid === true;
    const available = !missing && !invalid;
    return {
      ...key, title: text(meta.title, 1000) || 'Untitled',
      authors: names(meta.authors, meta.authorName), narrators: names(meta.narrators, meta.narratorName),
      series: names(meta.series, meta.seriesName), description: text(meta.description),
      missing, invalid, hasEbook, audioTrackCount,
      read: { available: available && hasEbook, ...(!available || !hasEbook ? { reason: 'No available ebook' } : {}) },
      listen: { available: available && audioTrackCount > 0, ...(!available || audioTrackCount === 0 ? { reason: 'No available audio' } : {}) },
    };
  }
  async library(signal: AbortSignal): Promise<{ libraryId: string; name: string }> {
    const all = await this.json('/api/libraries', signal);
    if (!array(all.libraries, 10000).some(value => {
      const library = object(value);
      return library.id === this.config.libraryId && library.mediaType === 'book';
    })) throw notFound();
    const library = await this.json(`/api/libraries/${opaqueSegment(this.config.libraryId)}`, signal);
    if (library.id !== this.config.libraryId || library.mediaType !== 'book') throw notFound();
    return { libraryId: this.config.libraryId, name: text(library.name, 500) || 'Books' };
  }
  async list(query: CatalogQuery, signal: AbortSignal): Promise<CatalogPage> {
    if (!Number.isInteger(query.page) || query.page < 0 || !Number.isInteger(query.limit) ||
        query.limit < 1 || query.limit > 100 || !['title', 'author'].includes(query.sort) ||
        !['all', 'ebook', 'single', 'multi'].includes(query.filter)) throw invalidInput();
    const params = new URLSearchParams({
      page: String(query.page), limit: String(query.limit), sort: `media.metadata.${query.sort === 'author' ? 'authorName' : 'title'}`,
      desc: query.desc ? '1' : '0', minified: '1',
    });
    if (query.filter !== 'all') {
      const group = query.filter === 'ebook' ? 'ebooks' : 'tracks';
      params.set('filter', `${group}.${Buffer.from(query.filter).toString('base64')}`);
    }
    const json = await this.json(`/api/libraries/${opaqueSegment(this.config.libraryId)}/items?${params}`, signal);
    return {
      items: array(json.results, query.limit).map(raw => this.summary(object(raw))),
      total: number(json.total), page: query.page, limit: query.limit,
    };
  }
  async search(libraryId: string, q: string, signal: AbortSignal): Promise<BookSummary[]> {
    if (libraryId !== this.config.libraryId) throw notFound();
    if (typeof q !== 'string' || !q.trim() || q.length > 200) throw invalidInput();
    const params = new URLSearchParams({ q: q.trim(), limit: '50' });
    const json = await this.json(`/api/libraries/${opaqueSegment(libraryId)}/search?${params}`, signal);
    return array(json.book ?? [], 50).map(match => this.summary(object(object(match).libraryItem)));
  }
  async item(itemId: string, signal: AbortSignal): Promise<BookItem> {
    const raw = await this.json(`/api/items/${opaqueSegment(itemId)}?expanded=1`, signal);
    const key = this.key(raw);
    if (key.itemId !== itemId) throw notFound();
    const { hasEbook: _hasEbook, audioTrackCount: _audioTrackCount, ...summary } = this.summary(raw);
    const media = object(raw.media);
    const libraryFiles = array(raw.libraryFiles).map(object);
    const seen = new Set<string>();
    const files: BookFile[] = [];
    const byIno = new Map<string, BookFile>();
    for (const entry of libraryFiles) {
      const ino = opaqueSegment(entry.ino);
      if (seen.has(ino)) throw new BooksError(502, 'ABS_AMBIGUOUS_MANIFEST');
      seen.add(ino);
      if (entry.fileType !== 'ebook' && entry.fileType !== 'audio') continue;
      const metadata = object(entry.metadata);
      const originalName = typeof metadata.filename === 'string' ? metadata.filename : '';
      const basename = originalName.replace(/\\/g, '/').split('/').pop()!.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 255);
      if (!basename || basename === '.' || basename === '..') throw new BooksError(502, 'ABS_INVALID_MANIFEST');
      const extension = basename.split('.').pop()!.toLowerCase();
      const size = number(metadata.size);
      if (!Number.isSafeInteger(size)) throw new BooksError(502, 'ABS_INVALID_MANIFEST');
      const fileId = this.files.fileId(key, ino);
      const contentVersion = createHash('sha256').update(JSON.stringify([
        key.providerInstanceId, key.libraryId, key.itemId, ino, size,
        metadata.mtimeMs ?? null, metadata.ctimeMs ?? null, metadata.birthtimeMs ?? null,
      ])).digest('hex');
      const file: BookFile = {
        fileId, basename, role: entry.fileType, extension, size,
        mime: MIME[extension] ?? 'application/octet-stream',
        available: !summary.missing && !summary.invalid && entry.isMissing !== true,
        contentVersion,
      };
      files.push(file); byIno.set(ino, file);
    }
    const tracks: BookItem['tracks'] = [];
    let offset = 0;
    let validTimeline = true;
    for (const value of optionalArray(media.tracks)) {
      const track = optionalObject(value);
      if (!track) { validTimeline = false; break; }
      const file = typeof track.ino === 'string' ? byIno.get(track.ino) : undefined;
      const duration = typeof track.duration === 'number' ? track.duration : NaN;
      const startOffset = typeof track.startOffset === 'number' ? track.startOffset : NaN;
      if (!file || file.role !== 'audio' || !file.available || !Number.isFinite(duration) || duration <= 0 ||
          !Number.isFinite(startOffset) || Math.abs(startOffset - offset) > 0.05 ||
          tracks.some(t => t.fileId === file.fileId)) { validTimeline = false; break; }
      tracks.push({ fileId: file.fileId, duration, startOffset });
      offset += duration;
    }
    if (!validTimeline) tracks.length = 0;
    let chapters: BookItem['chapters'] = [];
    let previous = 0;
    for (const value of optionalArray(media.chapters)) {
      const chapter = optionalObject(value);
      if (!validTimeline || !chapter || typeof chapter.start !== 'number' || typeof chapter.end !== 'number' ||
          !Number.isFinite(chapter.start) || !Number.isFinite(chapter.end) || chapter.start < previous ||
          chapter.end <= chapter.start || chapter.end > offset + 0.05) { chapters = []; break; }
      chapters.push({ id: String(chapter.id), title: text(chapter.title, 500), start: chapter.start, end: chapter.end });
      previous = chapter.end;
    }
    const canRead = files.some(f => f.role === 'ebook' && f.available && ['epub', 'pdf', 'cbz'].includes(f.extension));
    const canListen = tracks.length > 0 && tracks.every(t =>
      files.some(f => f.fileId === t.fileId && ['mp3', 'm4b'].includes(f.extension)));
    return {
      ...summary, files, tracks, chapters,
      read: { available: canRead, ...(!canRead ? { reason: 'No supported available EPUB, PDF, or CBZ; download original' } : {}) },
      listen: { available: canListen, ...(!canListen ? { reason: 'No supported complete audio timeline; download originals' } : {}) },
    };
  }
  async cover(itemId: string, signal: AbortSignal): Promise<{ body: Buffer; mime: string }> {
    const timeoutSignal = AbortSignal.any([signal, AbortSignal.timeout(BOOKS_LIMITS.metadataTimeoutMs)]);
    const response = await this.request(`/api/items/${opaqueSegment(itemId)}/cover?width=512&height=512`, 'GET', timeoutSignal);
    const mime = (response.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    const body = await this.body(response, BOOKS_LIMITS.coverBytes);
    if (!validateCover(body, mime)) throw notFound();
    return { body, mime };
  }
  async openFile(
    itemId: string, ino: string,
    options: { method: 'GET' | 'HEAD'; attachment: boolean; range?: string; ifRange?: string; signal: AbortSignal }
  ): Promise<IncomingMessage> {
    const headers: Record<string, string> = {};
    if (options.range) headers.Range = options.range;
    if (options.ifRange) headers['If-Range'] = options.ifRange;
    return this.request(
      `/api/items/${opaqueSegment(itemId)}/file/${opaqueSegment(ino)}${options.attachment ? '/download' : ''}`,
      options.method, options.signal, headers
    );
  }
}
