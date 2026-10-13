import { DatabaseService } from '../models/database';
import { BooksPrincipal } from './mediaAuth';
import { BooksRelay } from './relay';
import { BooksError, invalidInput, notFound, opaqueSegment } from './limits';

export interface BookTarget {
  itemId: string;
  fileId: string;
  contentVersion: string;
}
export function bookTarget(value: unknown): BookTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidInput();
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !['itemId', 'fileId', 'contentVersion'].includes(key))) throw invalidInput();
  return {
    itemId: opaqueSegment(input.itemId), fileId: opaqueSegment(input.fileId),
    contentVersion: opaqueSegment(input.contentVersion),
  };
}
export interface BookTicketResult {
  target: BookTarget;
  ticket?: { url: string; expiresAt: number; filename: string; size: number; resumable: boolean };
  error?: { status: number; code: string };
}

export class BooksTickets {
  constructor(private readonly db: DatabaseService, private readonly relay: BooksRelay) {}
  async issue(principal: BooksPrincipal, targets: BookTarget[], signal: AbortSignal = new AbortController().signal): Promise<BookTicketResult[]> {
    if (!Array.isArray(targets) || targets.length < 1 || targets.length > 100) throw invalidInput();
    const validated = targets.map(bookTarget);
    const results: BookTicketResult[] = [];
    for (const target of validated) {
      if (signal.aborted) throw new BooksError(503, 'BOOKS_REQUEST_CANCELLED');
      try {
        const { file, configGeneration, resumable } = await this.relay.inspect(principal, target, signal);
        const expiresAt = Math.min(principal.expiresAt, Date.now() + 15 * 60 * 1000);
        const token = this.db.books.createBookTicket({ ...principal, ...target, expiresAt, configGeneration });
        results.push({ target, ticket: { url: `/api/books/downloads/${token}`, expiresAt, filename: file.basename, size: file.size, resumable } });
      } catch (error) {
        if (!(error instanceof BooksError)) throw error;
        results.push({ target, error: { status: error.status, code: error.code } });
      }
    }
    return results;
  }
  resolve(principal: BooksPrincipal, token: string): BookTarget {
    opaqueSegment(token);
    const ticket = this.db.books.getBookTicket(token);
    if (!ticket) throw new BooksError(410, 'BOOK_TICKET_EXPIRED', 'Book download ticket must be renewed');
    if (ticket.sessionId !== principal.sessionId || ticket.userId !== principal.userId) throw notFound();
    return { itemId: ticket.itemId, fileId: ticket.fileId, contentVersion: ticket.contentVersion };
  }
}
