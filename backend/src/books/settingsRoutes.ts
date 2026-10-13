import { Router } from 'express';
import { DatabaseService } from '../models/database';
import { AuthRequest, createAdminMiddleware, createAuthMiddleware } from '../middleware/auth';
import { AbsClient } from './absClient';
import { bookHandler, booksError } from './routes';
import { BooksError, invalidInput, providerOrigin, sameOrigin, SELECTED_LIBRARY_ID, WindowBudget } from './limits';
import { BooksConfig } from './types';
import { PlexService, plexService } from '../services/plexService';

export function createBooksSettingsRouter(db: DatabaseService, service: PlexService = plexService): Router {
  const router = Router();
  const mutations = new WindowBudget(20, 60000);
  const status = () => {
    const config = db.books.readConfig();
    return {
      configured: Boolean(config && db.books.readCredential()),
      enabled: process.env.BOOKS_ENABLED === 'true' && config?.enabled === true,
      deploymentEnabled: process.env.BOOKS_ENABLED === 'true',
      libraryId: config?.libraryId ?? SELECTED_LIBRARY_ID,
      providerInstanceId: config?.providerInstanceId,
      configGeneration: config?.configGeneration ?? 0,
      serverBindingProofId: config?.serverBindingProofId,
    };
  };
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'private, no-store'); next(); });
  router.use(createAuthMiddleware(db, service), createAdminMiddleware(db));
  router.use((req: AuthRequest, res, next) => {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sameOrigin(req);
        mutations.take(req.user!.id);
      }
      next();
    } catch (error) { booksError(error, res); }
  });
  router.get('/', (_req, res) => res.json(status()));
  router.put('/', bookHandler(async (req, res) => {
    const body: unknown = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalidInput();
    const input = body as Record<string, unknown>;
    if (Object.keys(input).some(key => !['enabled', 'origin', 'libraryId', 'credential', 'serverBindingProofId', 'restrictedPrincipalConfirmed'].includes(key))) throw invalidInput();
    const old = db.books.readConfig();
    if (typeof input.enabled !== 'boolean') throw invalidInput();
    if (input.enabled && process.env.BOOKS_ENABLED !== 'true') throw new BooksError(409, 'BOOKS_DEPLOYMENT_DISABLED', 'Books deployment flag is disabled');
    const origin = input.origin ?? old?.origin;
    const libraryId = input.libraryId ?? old?.libraryId ?? SELECTED_LIBRARY_ID;
    const binding = input.serverBindingProofId ?? old?.serverBindingProofId;
    if (typeof origin !== 'string' || libraryId !== SELECTED_LIBRARY_ID || typeof binding !== 'string' ||
        (input.credential !== undefined && typeof input.credential !== 'string')) throw invalidInput();
    if (input.enabled && input.restrictedPrincipalConfirmed !== true) {
      throw new BooksError(409, 'ABS_PRINCIPAL_CONFIRMATION_REQUIRED', 'Confirm the restricted ABS principal and server binding before enabling');
    }
    const config: BooksConfig = {
      enabled: input.enabled, origin: providerOrigin(origin).origin, libraryId,
      serverBindingProofId: binding, providerInstanceId: old?.providerInstanceId ?? '', configGeneration: 0,
    };
    if (config.enabled && !(input.credential || db.books.readCredential())) throw invalidInput();
    if (old && config.enabled && (old.origin !== config.origin || old.serverBindingProofId !== binding) &&
        !input.credential) throw invalidInput();
    db.books.setConfig(config, input.credential as string | undefined);
    return res.json(status());
  }));
  router.post('/verify', bookHandler(async (_req, res, signal) => {
    const config = db.books.readConfig();
    const credential = db.books.readCredential();
    if (!config || !credential) throw new BooksError(409, 'BOOKS_NOT_CONFIGURED');
    const library = await new AbsClient(config, credential, db.books).library(signal);
    return res.json({ connected: true, libraryId: library.libraryId, providerPermissions: 'owner-attestation-required' });
  }));
  return router;
}
