import { Router } from 'express';
import { DatabaseService } from '../models/database';
import { logger } from '../utils/logger';
import { BookItem } from './types';
import { BooksCatalog } from './catalog';
import { BooksError, invalidInput, notFound, opaqueSegment } from './limits';
import { audioEdition, ProgressKey, ProgressWrite, progressLocator, progressWrite } from './progressTypes';
import { bookHandler } from './routes';
import { EpubPreparation } from './epub/prepare';
import { epubContentVersion } from './epub/manifest';
import { AuthRequest } from '../middleware/auth';
import { BooksPrincipal } from './mediaAuth';

function currentEdition(item: BookItem, mode: 'ebook' | 'audio', editionId: string) {
  if (mode === 'audio') {
    const edition = audioEdition(item);
    return edition?.editionId === editionId ? edition : undefined;
  }
  const file = item.files.find(file => file.fileId === editionId && file.role === 'ebook' && file.available);
  return file ? { editionId, contentVersion: file.extension === 'epub' ? epubContentVersion(file.contentVersion) : file.contentVersion } : undefined;
}

export async function validateProgressLocator(item: BookItem, editionId: string, write: ProgressWrite): Promise<boolean> {
  let locator;
  try { locator = progressLocator(write.locator); } catch (error) {
    if (error instanceof BooksError) return false;
    throw error;
  }
  if (locator.kind === 'epub') return false;
  if (locator.kind === 'pdf') {
    return item.files.some(file => file.fileId === editionId && file.available &&
      file.extension === 'pdf' && file.contentVersion === write.contentVersion);
  }
  const edition = audioEdition(item);
  if (!edition || edition.editionId !== editionId || edition.contentVersion !== write.contentVersion) return false;
  const track = item.tracks.find(track => track.fileId === locator.trackId);
  return Boolean(track && locator.localSeconds <= track.duration &&
    Math.abs(track.startOffset + locator.localSeconds - locator.globalSeconds) <= 0.001);
}

export function createBooksProgressRouter(
  db: DatabaseService, catalog: BooksCatalog, preparation?: EpubPreparation,
  principal?: (req: AuthRequest) => BooksPrincipal
): Router {
  const router = Router();
  router.get('/items/:itemId/progress/:mode', bookHandler(async (req, res, signal) => {
    if (!req.user) throw new BooksError(401, 'BOOKS_SESSION_REQUIRED');
    if (!['ebook', 'audio'].includes(req.params.mode) ||
        Object.keys(req.query).some(key => key !== 'editionId')) throw invalidInput();
    const editionId = opaqueSegment(req.query.editionId);
    const { item } = await catalog.authorizeItem(req.user.id, req.params.itemId, signal);
    const mode = req.params.mode as 'ebook' | 'audio';
    const key: ProgressKey = {
      providerInstanceId: item.providerInstanceId, libraryId: item.libraryId, itemId: item.itemId,
      userId: req.user.id, mode, editionId,
    };
    const progress = db.booksProgress.read(key);
    const edition = currentEdition(item, mode, editionId);
    if (!edition && !progress) throw notFound();
    const history = db.booksProgress.history(key).filter(record =>
      record.key.editionId !== editionId || record.contentVersion !== edition?.contentVersion);
    const compatible = Boolean(edition && (progress
      ? progress.contentVersion === edition.contentVersion
      : history.length === 0));
    return res.json({ progress: progress ?? null, compatible, history, edition: edition ?? null });
  }));
  router.put('/items/:itemId/progress/:mode', bookHandler(async (req, res, signal) => {
    if (!req.user) throw new BooksError(401, 'BOOKS_SESSION_REQUIRED');
    if (!['ebook', 'audio'].includes(req.params.mode) || !req.body || typeof req.body !== 'object' || Array.isArray(req.body)) throw invalidInput();
    const { editionId: rawEdition, ...input } = req.body as Record<string, unknown>;
    const editionId = opaqueSegment(rawEdition);
    const write = progressWrite(input);
    const mode = req.params.mode as 'ebook' | 'audio';
    if ((mode === 'audio') !== (write.locator.kind === 'audio')) throw invalidInput();
    const { item, configGeneration } = await catalog.authorizeItem(req.user.id, req.params.itemId, signal);
    const key: ProgressKey = {
      providerInstanceId: item.providerInstanceId, libraryId: item.libraryId, itemId: item.itemId,
      userId: req.user.id, mode, editionId,
    };
    const edition = currentEdition(item, mode, editionId);
    const current = db.booksProgress.read(key);
    if (!edition && !current) throw notFound();
    if (!edition || edition.contentVersion !== write.contentVersion) {
      return res.status(409).json({ code: 'BOOK_VERSION_CHANGED', error: 'The original changed; choose a new position', canonical: current ?? null });
    }
    const original = item.files.find(file => file.fileId === editionId);
    const valid = write.locator.kind === 'epub' && original?.extension === 'epub' && preparation && principal
      ? await preparation.validateLocator(principal(req), {
        itemId: item.itemId, fileId: editionId, contentVersion: original.contentVersion,
      }, write.locator, signal)
      : await validateProgressLocator(item, editionId, write);
    if (!valid) {
      throw new BooksError(422, 'BOOK_PROGRESS_LOCATION_UNSUPPORTED', 'Cannot save this position for the current original');
    }
    if (catalog.current().config.configGeneration !== configGeneration) throw new BooksError(409, 'BOOKS_CONFIGURATION_CHANGED');
    const result = db.booksProgress.write(key, write);
    if (result.status === 'saved') return res.json({ progress: result.value, compatible: true });
    logger.info('Books progress conflict', { code: 'BOOK_PROGRESS_CONFLICT' });
    return res.status(409).json({ code: 'BOOK_PROGRESS_CONFLICT', error: 'Another writer or version owns the saved position', canonical: result.canonical ?? null });
  }));
  return router;
}
