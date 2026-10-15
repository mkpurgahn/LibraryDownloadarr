import { Router, Response, NextFunction, RequestHandler } from 'express';
import { AuthRequest } from '../middleware/auth';
import { DatabaseService } from '../models/database';
import { logger } from '../utils/logger';
import { BooksCatalog } from './catalog';
import { BooksError, boundedQuery, invalidInput, WindowBudget } from './limits';
import { BooksMediaAuth, BooksPrincipal } from './mediaAuth';
import { BookStreams } from './streams';
import { BooksRelay } from './relay';
import { BooksTickets, bookTarget } from './tickets';
import { PlexService, plexService } from '../services/plexService';
import { createBooksProgressRouter } from './progressRoutes';
import { EpubPreparation } from './epub/prepare';
import { createEpubRouter } from './epub/routes';

export function booksError(error: unknown, res: Response): void {
  if (res.headersSent) { res.destroy(); return; }
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (error instanceof BooksError) {
    if (error.status === 429) res.setHeader('Retry-After', '2');
    if (error.status >= 500) logger.warn('Books request unavailable', { code: error.code, status: error.status });
    res.status(error.status).json({ error: error.message, code: error.code });
    return;
  }
  logger.error('Books request failed', { code: 'BOOKS_INTERNAL_ERROR' });
  res.status(500).json({ error: 'Books request failed', code: 'BOOKS_INTERNAL_ERROR' });
}

export function bookHandler(
  handler: (req: AuthRequest, res: Response, signal: AbortSignal) => Promise<unknown>
) {
  return (req: AuthRequest, res: Response, _next: NextFunction): void => {
    // Authentication may outlive the client; request-readable completion alone is not a disconnect.
    if (req.aborted || res.destroyed || res.closed) return;
    const controller = new AbortController();
    const close = () => { if (!res.writableFinished) controller.abort(); };
    res.once('close', close);
    void handler(req, res, controller.signal).catch(error => booksError(error, res))
      .finally(() => res.removeListener('close', close));
  };
}

export function createBooksRouter(db: DatabaseService, dependencies: { plex?: PlexService; preparation?: EpubPreparation } = {}): Router {
  const router = Router();
  const catalog = new BooksCatalog(db.books);
  const plex = dependencies.plex ?? plexService;
  const auth = new BooksMediaAuth(db, plex);
  const streams = new BookStreams();
  const relay = new BooksRelay(db, catalog, streams, plex);
  const tickets = new BooksTickets(db, relay);
  const preparation = dependencies.preparation ?? new EpubPreparation(db, catalog, relay, plex);
  const principals = new WeakMap<AuthRequest, BooksPrincipal>();
  const reads = new WindowBudget(120, 60000);
  const mutations = new WindowBudget(20, 60000);
  const positions = new WindowBudget(120, 60000);
  db.onSessionRevoked(id => { db.books.revokeBooksSession(id); streams.revokeSession(id); });
  db.books.onConfigChanged(() => streams.invalidateGeneration());
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });
  router.post('/media-session', bookHandler(async (req, res) => {
    const principal = await auth.requireBooksMutation(req, true);
    catalog.current();
    mutations.take(principal.userId);
    auth.exchange(res, principal);
    return res.json({ expiresAt: principal.expiresAt });
  }));
  router.use((req: AuthRequest, res, next) => {
    const mutating = !['GET', 'HEAD'].includes(req.method);
    void (mutating ? auth.requireBooksMutation(req) : auth.authenticateBooks(req, false)).then(principal => {
      catalog.current();
      (mutating ? (/\/progress\/(ebook|audio)$/.test(req.path) ? positions : mutations) : reads).take(principal.userId);
      principals.set(req, principal);
      const user = db.getPlexUserById(principal.userId)!;
      req.user = { id: user.id, username: user.username, plexId: user.plexId, isAdmin: false };
      next();
    }).catch(error => booksError(error, res));
  });
  const freshMembership: RequestHandler = (req, res, next) => {
    void auth.authenticateBooks(req, true).then(principal => {
      principals.set(req, principal);
      next();
    }).catch(error => booksError(error, res));
  };
  const catalogHandler = (
    handler: (req: AuthRequest, signal: AbortSignal, identity: BooksPrincipal) => Promise<unknown>
  ) => bookHandler(async (req, res, signal) => {
    const identity = principals.get(req);
    if (!identity || req.user?.id !== identity.userId) throw new BooksError(401, 'BOOKS_SESSION_REQUIRED');
    const generation = catalog.current().config.configGeneration;
    const check = () => {
      const session = db.getSessionById(identity.sessionId);
      if (!session || session.userId !== identity.userId || identity.expiresAt <= Date.now()) {
        throw new BooksError(401, 'BOOKS_SESSION_REQUIRED');
      }
      if (db.books.readConfig()?.configGeneration !== generation) {
        throw new BooksError(409, 'BOOKS_CONFIGURATION_CHANGED');
      }
    };
    check();
    const controller = new AbortController();
    const unsubscribeSession = db.onSessionRevoked(id => { if (id === identity.sessionId) controller.abort(); });
    const unsubscribeConfig = db.books.onConfigChanged(() => controller.abort());
    const expiry = setTimeout(() => controller.abort(), Math.max(0, Math.min(2147483647, identity.expiresAt - Date.now())));
    expiry.unref();
    const combined = AbortSignal.any([signal, controller.signal]);
    try {
      const result = await handler(req, combined, identity);
      check();
      if (combined.aborted) throw new BooksError(503, 'ABS_UNAVAILABLE');
      return res.json(result);
    } catch (error) {
      check();
      throw error;
    } finally {
      clearTimeout(expiry); unsubscribeSession(); unsubscribeConfig();
    }
  });
  router.delete('/media-session', bookHandler(async (req, res) => {
    const principal = principals.get(req)!;
    auth.clear(res, principal);
    streams.revokeSession(principal.sessionId);
    preparation.revokeSession(principal.sessionId);
    return res.status(204).end();
  }));
  router.post('/download-tickets', freshMembership, bookHandler(async (req, res, signal) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) ||
        Object.keys(req.body).some(key => key !== 'targets')) throw invalidInput();
    return res.json({ results: await tickets.issue(principals.get(req)!, req.body.targets, signal) });
  }));
  router.get('/downloads/:ticket', freshMembership, bookHandler(async (req, res) => {
    const principal = principals.get(req)!;
    await relay.relayOriginal(req, res, principal, tickets.resolve(principal, req.params.ticket), 'attachment');
  }));
  router.get('/items/:itemId/files/:fileId/content', freshMembership, bookHandler(async (req, res) => {
    if (Object.keys(req.query).some(key => key !== 'version')) throw invalidInput();
    const target = bookTarget({ itemId: req.params.itemId, fileId: req.params.fileId, contentVersion: req.query.version });
    await relay.relayOriginal(req, res, principals.get(req)!, target, 'inline');
  }));
  router.get('/libraries', catalogHandler(async (_req, signal) => catalog.libraries(signal)));
  router.get('/libraries/:libraryId/items', catalogHandler(async (req, signal, identity) =>
    catalog.list(identity.userId, req.params.libraryId, boundedQuery(req.query), signal)));
  router.get('/libraries/:libraryId/search', catalogHandler(async (req, signal, identity) => {
    if (Object.keys(req.query).some(key => key !== 'q') || typeof req.query.q !== 'string') throw invalidInput();
    return { items: await catalog.search(identity.userId, req.params.libraryId, req.query.q, signal) };
  }));
  router.get('/items/:itemId', bookHandler(async (req, res, signal) =>
    res.json((await catalog.authorizeItem(req.user!.id, req.params.itemId, signal)).item)));
  router.get('/items/:itemId/cover', bookHandler(async (req, res, signal) => {
    const { body, mime } = await catalog.cover(req.user!.id, req.params.itemId, signal);
    return res.type(mime).send(body);
  }));
  router.use(createEpubRouter(preparation, req => principals.get(req)!, freshMembership));
  router.use(createBooksProgressRouter(db, catalog, preparation, req => principals.get(req)!));
  router.use((_req, res) => res.status(404).json({ error: 'Book not found', code: 'BOOK_NOT_FOUND' }));
  return router;
}
