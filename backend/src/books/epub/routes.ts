import { Router, RequestHandler } from 'express';
import { pipeline } from 'node:stream/promises';
import { AuthRequest } from '../../middleware/auth';
import { BooksPrincipal } from '../mediaAuth';
import { invalidInput } from '../limits';
import { bookTarget } from '../tickets';
import { bookHandler } from '../routes';
import { EpubPreparation } from './prepare';

export function createEpubRouter(
  preparation: EpubPreparation, principal: (req: AuthRequest) => BooksPrincipal, freshMembership: RequestHandler
): Router {
  const router = Router();
  router.post('/items/:itemId/reader-progressive', freshMembership, bookHandler(async (req, res, signal) => {
    res.setHeader('X-Book-Reader-Protocol', 'cbz-progressive-v1');
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) ||
        Object.keys(req.body).some(key => !['fileId', 'contentVersion', 'page'].includes(key))) throw invalidInput();
    const page = req.body.page ?? 1;
    if (!Number.isSafeInteger(page) || page < 1 || page > 1000) throw invalidInput();
    const target = bookTarget({ itemId: req.params.itemId, fileId: req.body.fileId, contentVersion: req.body.contentVersion });
    let pending: Awaited<ReturnType<EpubPreparation['prepareProgressive']>>;
    try { pending = await preparation.prepareProgressive(principal(req), target, page, signal); }
    catch (error) { if (signal.aborted) return; throw error; }
    if (signal.aborted || res.destroyed || res.closed) { pending.cancel(); return; }
    const finish = () => { res.removeListener('close', close); pending.handoff(); };
    const close = () => {
      res.removeListener('finish', finish);
      if (res.writableFinished) pending.handoff(); else pending.cancel();
    };
    res.once('close', close);
    res.once('finish', finish);
    res.status(202).json(pending.descriptor);
  }));
  router.get('/readers/:readerId/status', bookHandler(async (req, res, signal) => {
    if (Object.keys(req.query).some(key => key !== 'page') ||
        (req.query.page !== undefined && (typeof req.query.page !== 'string' || !/^[1-9]\d{0,3}$/.test(req.query.page)))) throw invalidInput();
    const page = req.query.page === undefined ? undefined : Number(req.query.page);
    if (page !== undefined && page > 1000) throw invalidInput();
    try {
      return res.json(await preparation.progressiveStatus(principal(req), req.params.readerId, page, signal));
    } catch (error) { if (signal.aborted) return; throw error; }
  }));
  router.post('/items/:itemId/reader', freshMembership, bookHandler(async (req, res, signal) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) ||
        Object.keys(req.body).some(key => !['fileId', 'contentVersion'].includes(key))) throw invalidInput();
    const target = bookTarget({ itemId: req.params.itemId, fileId: req.body.fileId, contentVersion: req.body.contentVersion });
    return res.json(await preparation.prepareReader(principal(req), target, signal));
  }));
  router.get('/readers/:readerId/resources/:resourceId', freshMembership, bookHandler(async (req, res, signal) => {
    if (Object.keys(req.query).length) throw invalidInput();
    const identity = principal(req);
    const stream = await preparation.readResource(identity, req.params.readerId, req.params.resourceId, signal);
    try {
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', 'attachment; filename="book-resource"');
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
      res.setHeader('Content-Length', String(preparation.resourceSize(identity, req.params.readerId, req.params.resourceId)));
      if (req.method === 'HEAD') { res.end(); return; }
      await pipeline(stream, res, { signal });
    } finally { stream.destroy(); }
  }));
  router.delete('/readers/:readerId', freshMembership, bookHandler(async (req, res) => {
    preparation.release(principal(req), req.params.readerId);
    res.status(204).end();
  }));
  return router;
}
