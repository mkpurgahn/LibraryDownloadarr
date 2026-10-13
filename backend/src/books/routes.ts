import { Router, Response, NextFunction } from 'express';
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
    const controller = new AbortController();
    const close = () => { if (!res.writableFinished) controller.abort(); };
    res.once('close', close);
    void handler(req, res, controller.signal).catch(error => booksError(error, res))
      .finally(() => res.removeListener('close', close));
  };
}

export function createBooksRouter(db: DatabaseService, dependencies: { plex?: PlexService } = {}): Router {
  const router = Router();
  const catalog = new BooksCatalog(db.books);
  const plex = dependencies.plex ?? plexService;
  const auth = new BooksMediaAuth(db, plex);
  const streams = new BookStreams();
  const relay = new BooksRelay(db, catalog, streams, plex);
  const tickets = new BooksTickets(db, relay);
  const principals = new WeakMap<AuthRequest, BooksPrincipal>();
  const reads = new WindowBudget(120, 60000);
  const mutations = new WindowBudget(20, 60000);
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
    const force = req.path.startsWith('/downloads/') || req.path.endsWith('/content') || req.path === '/download-tickets';
    void (mutating ? auth.requireBooksMutation(req, false, force) : auth.authenticateBooks(req, force)).then(principal => {
      catalog.current();
      (mutating ? mutations : reads).take(principal.userId);
      principals.set(req, principal);
      const user = db.getPlexUserById(principal.userId)!;
      req.user = { id: user.id, username: user.username, plexId: user.plexId, isAdmin: false };
      next();
    }).catch(error => booksError(error, res));
  });
  router.delete('/media-session', bookHandler(async (req, res) => {
    const principal = principals.get(req)!;
    auth.clear(res, principal);
    streams.revokeSession(principal.sessionId);
    return res.status(204).end();
  }));
  router.post('/download-tickets', bookHandler(async (req, res, signal) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) ||
        Object.keys(req.body).some(key => key !== 'targets')) throw invalidInput();
    return res.json({ results: await tickets.issue(principals.get(req)!, req.body.targets, signal) });
  }));
  router.get('/downloads/:ticket', bookHandler(async (req, res) => {
    const principal = principals.get(req)!;
    await relay.relayOriginal(req, res, principal, tickets.resolve(principal, req.params.ticket), 'attachment');
  }));
  router.get('/items/:itemId/files/:fileId/content', bookHandler(async (req, res) => {
    if (Object.keys(req.query).some(key => key !== 'version')) throw invalidInput();
    const target = bookTarget({ itemId: req.params.itemId, fileId: req.params.fileId, contentVersion: req.query.version });
    await relay.relayOriginal(req, res, principals.get(req)!, target, 'inline');
  }));
  router.get('/libraries', bookHandler(async (_req, res, signal) => res.json(await catalog.libraries(signal))));
  router.get('/libraries/:libraryId/items', bookHandler(async (req, res, signal) =>
    res.json(await catalog.list(req.user!.id, req.params.libraryId, boundedQuery(req.query), signal))));
  router.get('/libraries/:libraryId/search', bookHandler(async (req, res, signal) => {
    if (Object.keys(req.query).some(key => key !== 'q') || typeof req.query.q !== 'string') throw invalidInput();
    return res.json({ items: await catalog.search(req.user!.id, req.params.libraryId, req.query.q, signal) });
  }));
  router.get('/items/:itemId', bookHandler(async (req, res, signal) =>
    res.json((await catalog.authorizeItem(req.user!.id, req.params.itemId, signal)).item)));
  router.get('/items/:itemId/cover', bookHandler(async (req, res, signal) => {
    const { body, mime } = await catalog.cover(req.user!.id, req.params.itemId, signal);
    return res.type(mime).send(body);
  }));
  router.use((_req, res) => res.status(404).json({ error: 'Book not found', code: 'BOOK_NOT_FOUND' }));
  return router;
}
