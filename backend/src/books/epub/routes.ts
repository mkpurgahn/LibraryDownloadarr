import { Router } from 'express';
import { pipeline } from 'node:stream/promises';
import { AuthRequest } from '../../middleware/auth';
import { BooksPrincipal } from '../mediaAuth';
import { invalidInput } from '../limits';
import { bookTarget } from '../tickets';
import { bookHandler } from '../routes';
import { EpubPreparation } from './prepare';

export function createEpubRouter(preparation: EpubPreparation, principal: (req: AuthRequest) => BooksPrincipal): Router {
  const router = Router();
  router.post('/items/:itemId/reader', bookHandler(async (req, res, signal) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) ||
        Object.keys(req.body).some(key => !['fileId', 'contentVersion'].includes(key))) throw invalidInput();
    const target = bookTarget({ itemId: req.params.itemId, fileId: req.body.fileId, contentVersion: req.body.contentVersion });
    return res.json(await preparation.prepareEpub(principal(req), target, signal));
  }));
  router.get('/readers/:readerId/resources/:resourceId', bookHandler(async (req, res, signal) => {
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
  router.delete('/readers/:readerId', bookHandler(async (req, res) => {
    preparation.release(principal(req), req.params.readerId);
    res.status(204).end();
  }));
  return router;
}
