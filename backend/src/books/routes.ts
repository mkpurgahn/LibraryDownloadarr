import { Router, Response, NextFunction } from 'express';
import { AuthRequest, createAuthMiddleware } from '../middleware/auth';
import { DatabaseService } from '../models/database';
import { logger } from '../utils/logger';
import { BooksCatalog } from './catalog';
import { BooksError, boundedQuery, invalidInput, WindowBudget } from './limits';

export function booksError(error: unknown, res: Response): void {
  if (res.headersSent) { res.destroy(); return; }
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

export function createBooksRouter(db: DatabaseService): Router {
  const router = Router();
  const catalog = new BooksCatalog(db.books);
  const reads = new WindowBudget(120, 60000);
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });
  router.use(createAuthMiddleware(db));
  router.use((req: AuthRequest, res, next) => {
    try {
      if (!req.user?.plexId) throw new BooksError(403, 'PLEX_ACCESS_REQUIRED', 'Plex access required');
      catalog.current();
      reads.take(req.user.id);
      next();
    } catch (error) { booksError(error, res); }
  });
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
