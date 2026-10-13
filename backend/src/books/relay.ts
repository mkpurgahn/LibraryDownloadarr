import { IncomingMessage } from 'node:http';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Request, Response } from 'express';
import { config } from '../config';
import { DatabaseService } from '../models/database';
import { ensurePlexMembership } from '../services/membershipService';
import { PlexService, plexService } from '../services/plexService';
import { parseRange } from '../services/downloadService';
import { BooksCatalog } from './catalog';
import { BooksPrincipal } from './mediaAuth';
import { BookRepresentation } from './repository';
import { BookStreams } from './streams';
import { BooksError } from './limits';
import type { BookTarget } from './tickets';

function inspectHeaders(message: IncomingMessage, allowPartial = false): BookRepresentation {
  const status = message.statusCode ?? 502;
  if (status === 401 || status === 403) throw new BooksError(502, 'ABS_CONNECTION_DENIED');
  if (status === 404) throw new BooksError(404, 'BOOK_NOT_FOUND');
  if ((status !== 200 && !(allowPartial && status === 206)) || message.headers['x-accel-redirect'] ||
      (message.headers['content-encoding'] && message.headers['content-encoding'] !== 'identity')) {
    throw new BooksError(status >= 500 ? 503 : 502, 'ABS_INVALID_FILE_RESPONSE');
  }
  const length = message.headers['content-length'];
  if (!length || !/^\d+$/.test(length) || !Number.isSafeInteger(Number(length))) {
    throw new BooksError(502, 'ABS_FILE_SIZE_UNAVAILABLE');
  }
  const rawEtag = message.headers.etag;
  const etag = rawEtag && /^(W\/)?"[\x21\x23-\x7e]*"$/.test(rawEtag) ? rawEtag : undefined;
  const rawModified = message.headers['last-modified'];
  const lastModified = rawModified && Number.isFinite(Date.parse(rawModified)) ? rawModified : undefined;
  return { size: Number(length), etag, lastModified, ranges: message.headers['accept-ranges'] === 'bytes' };
}
function sameRepresentation(a: BookRepresentation, b: BookRepresentation): boolean {
  return a.etag === b.etag && a.lastModified === b.lastModified;
}
function matchesIfRange(header: string | string[] | undefined, representation: BookRepresentation): boolean {
  if (!header) return true;
  if (typeof header !== 'string' || header.startsWith('W/')) return false;
  if (header.startsWith('"')) return header === representation.etag && !representation.etag?.startsWith('W/');
  return !!representation.lastModified && Number.isFinite(Date.parse(header)) &&
    Date.parse(header) === Date.parse(representation.lastModified);
}
function dispositionHeader(name: string, disposition: 'inline' | 'attachment'): string {
  const safe = name.replace(/["\\\r\n]/g, '_').replace(/[^\x20-\x7e]/g, '_');
  const encoded = encodeURIComponent(name).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${disposition}; filename="${safe}"; filename*=UTF-8''${encoded}`;
}

export class BooksRelay {
  constructor(
    private readonly db: DatabaseService,
    private readonly catalog: BooksCatalog,
    private readonly streams: BookStreams,
    private readonly plex: PlexService = plexService
  ) {}
  private currentSession(principal: BooksPrincipal): void {
    const session = this.db.getSessionById(principal.sessionId);
    if (!session || session.userId !== principal.userId) throw new BooksError(401, 'BOOKS_SESSION_REQUIRED');
  }
  async inspect(principal: BooksPrincipal, target: BookTarget, signal: AbortSignal) {
    this.currentSession(principal);
    const resolved = await this.catalog.resolveFile(principal.userId, target.itemId, target.fileId, target.contentVersion, signal);
    const current = this.catalog.current();
    if (current.config.configGeneration !== resolved.configGeneration) throw new BooksError(409, 'BOOKS_CONFIGURATION_CHANGED');
    const head = await current.client.openFile(target.itemId, resolved.ino, { method: 'HEAD', attachment: false, signal });
    try {
      const representation = inspectHeaders(head);
      this.currentSession(principal);
      if (this.catalog.current().config.configGeneration !== resolved.configGeneration) throw new BooksError(409, 'BOOKS_CONFIGURATION_CHANGED');
      if (representation.size !== resolved.file.size) throw new BooksError(409, 'BOOK_VERSION_CHANGED');
      if (!this.db.books.observeRepresentation(resolved.file, representation)) throw new BooksError(409, 'BOOK_VERSION_CHANGED');
      const resumable = representation.ranges &&
        Boolean(representation.lastModified || (representation.etag && !representation.etag.startsWith('W/')));
      const mime = head.headers['content-type']?.split(';')[0];
      if (!mime || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(mime)) throw new BooksError(502, 'ABS_FILE_TYPE_UNAVAILABLE');
      return { ...resolved, representation, resumable, mime, client: current.client };
    } finally { head.destroy(); }
  }
  async relayOriginal(
    req: Request, res: Response, principal: BooksPrincipal, target: BookTarget, disposition: 'inline' | 'attachment'
  ): Promise<void> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    const generation = this.catalog.current().config.configGeneration;
    const release = this.streams.register(principal, generation, abort);
    let timer: NodeJS.Timeout | undefined;
    const revalidate = () => {
      const delay = Math.max(1, Math.min(config.plex.membershipTtlMs || 100, principal.expiresAt - Date.now()));
      timer = setTimeout(() => {
        void (async () => {
          this.currentSession(principal);
          await ensurePlexMembership(this.db, principal.userId, true, this.plex);
          this.currentSession(principal);
        })().then(() => { if (!controller.signal.aborted) revalidate(); }, abort);
      }, delay);
      timer.unref();
    };
    req.once('aborted', abort);
    res.once('close', abort);
    revalidate();
    try {
      const checked = await this.inspect(principal, target, controller.signal);
      if (disposition === 'inline' && (!['pdf', 'mp3', 'm4b'].includes(checked.file.extension) ||
          !['application/pdf', 'audio/mpeg', 'audio/mp4', 'audio/x-m4b'].includes(checked.mime))) {
        throw new BooksError(422, 'BOOK_DOWNLOAD_ONLY', 'This original is download-only');
      }
      const range = parseRange(req.headers.range, checked.file.size);
      if (range === 'invalid') {
        res.setHeader('Content-Range', `bytes */${checked.file.size}`);
        res.status(416).end();
        return;
      }
      const requestedRange = checked.resumable && matchesIfRange(req.headers['if-range'], checked.representation) ? range : null;
      let status = requestedRange ? 206 : 200;
      let length = requestedRange ? requestedRange.end - requestedRange.start + 1 : checked.file.size;
      let upstream: IncomingMessage | undefined;
      if (req.method !== 'HEAD') {
        upstream = await checked.client.openFile(target.itemId, checked.ino, {
          method: 'GET', attachment: disposition === 'attachment', signal: controller.signal,
          ...(requestedRange ? { range: `bytes=${requestedRange.start}-${requestedRange.end}` } : {}),
        });
        try {
          const response = inspectHeaders(upstream, true);
          if (!sameRepresentation(response, checked.representation)) {
            this.db.books.observeRepresentation(checked.file, { ...response, size: checked.file.size });
            throw new BooksError(409, 'BOOK_VERSION_CHANGED');
          }
          if (upstream.statusCode === 206) {
            if (!requestedRange || response.size !== length ||
                upstream.headers['content-range'] !== `bytes ${requestedRange.start}-${requestedRange.end}/${checked.file.size}`) {
              throw new BooksError(502, 'ABS_INVALID_RANGE_RESPONSE');
            }
          } else {
            status = 200; length = checked.file.size;
            if (response.size !== length) throw new BooksError(409, 'BOOK_VERSION_CHANGED');
          }
          this.currentSession(principal);
          if (this.catalog.current().config.configGeneration !== generation) throw new BooksError(409, 'BOOKS_CONFIGURATION_CHANGED');
        } catch (error) { upstream.destroy(); throw error; }
      }
      const ranges = checked.resumable && !(requestedRange && status === 200);
      res.status(status);
      res.setHeader('Content-Type', checked.mime);
      res.setHeader('Content-Length', String(length));
      res.setHeader('Content-Disposition', dispositionHeader(checked.file.basename, disposition));
      res.setHeader('Accept-Ranges', ranges ? 'bytes' : 'none');
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (checked.representation.etag) res.setHeader('ETag', checked.representation.etag);
      if (checked.representation.lastModified) res.setHeader('Last-Modified', checked.representation.lastModified);
      if (status === 206 && requestedRange) res.setHeader('Content-Range', `bytes ${requestedRange.start}-${requestedRange.end}/${checked.file.size}`);
      if (!upstream) { res.end(); return; }
      let received = 0;
      const exactBytes = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          received += chunk.length;
          callback(received > length ? new Error('Original byte length exceeded') : null, chunk);
        },
        flush(callback) { callback(received === length ? null : new Error('Original byte length incomplete')); },
      });
      await pipeline(upstream, exactBytes, res, { signal: controller.signal });
    } finally {
      if (timer) clearTimeout(timer);
      req.removeListener('aborted', abort);
      res.removeListener('close', abort);
      controller.abort();
      release();
    }
  }
}
