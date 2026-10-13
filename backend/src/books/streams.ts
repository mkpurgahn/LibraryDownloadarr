import { BooksPrincipal } from './mediaAuth';
import { BooksError } from './limits';

export class BookStreams {
  private readonly active = new Set<{ principal: BooksPrincipal; generation: number; abort: () => void }>();
  register(principal: BooksPrincipal, generation: number, abort: () => void): () => void {
    if (principal.expiresAt <= Date.now()) throw new BooksError(401, 'BOOKS_SESSION_REQUIRED');
    if (this.active.size >= 8 || [...this.active].filter(v => v.principal.userId === principal.userId).length >= 2) {
      throw new BooksError(429, 'BOOKS_STREAM_CAPACITY', 'Too many active Books streams');
    }
    const record = { principal, generation, abort };
    this.active.add(record);
    return () => { this.active.delete(record); };
  }
  revokeSession(id: string): void {
    for (const record of [...this.active]) {
      if (record.principal.sessionId === id) { this.active.delete(record); record.abort(); }
    }
  }
  invalidateGeneration(): void {
    for (const record of [...this.active]) { this.active.delete(record); record.abort(); }
  }
}
