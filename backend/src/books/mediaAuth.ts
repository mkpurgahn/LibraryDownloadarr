import { Request, Response } from 'express';
import { DatabaseService, Session } from '../models/database';
import { ensurePlexMembership, MembershipError } from '../services/membershipService';
import { PlexService, plexService } from '../services/plexService';
import { BooksError, sameOrigin } from './limits';

export interface BooksPrincipal {
  userId: string;
  sessionId: string;
  expiresAt: number;
}
export const BOOKS_COOKIE = '__Secure-lda_books';

export class BooksMediaAuth {
  constructor(private readonly db: DatabaseService, private readonly plex: PlexService = plexService) {}

  async authenticateBooks(req: Request, forceMembership: boolean, exchange = false): Promise<BooksPrincipal> {
    const header = req.headers.authorization;
    const bearer = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    const cookies = (req.headers.cookie ?? '').split(';').map(c => c.trim()).filter(c => c.startsWith(`${BOOKS_COOKIE}=`));
    if (!exchange && cookies.length > 1) throw new BooksError(401, 'BOOKS_SESSION_REQUIRED');
    const cookie = cookies[0]?.slice(BOOKS_COOKIE.length + 1);
    const bearerSession = bearer ? this.db.getSessionByToken(bearer) : undefined;
    if (header !== undefined && !bearerSession) throw new BooksError(401, 'BOOKS_SESSION_REQUIRED');
    let cookieSession: Session | undefined;
    if (cookie && !exchange) {
      const bridge = this.db.books.getMediaSession(cookie);
      cookieSession = bridge ? this.db.getSessionById(bridge.sessionId) : undefined;
      if (!cookieSession || bridge?.userId !== cookieSession.userId) throw new BooksError(401, 'BOOKS_SESSION_REQUIRED');
    }
    if (bearerSession && cookieSession && bearerSession.id !== cookieSession.id) {
      throw new BooksError(403, 'BOOKS_IDENTITY_MISMATCH', 'Books session does not match the signed-in session');
    }
    const session = bearerSession ?? cookieSession;
    if (!session) throw new BooksError(401, 'BOOKS_SESSION_REQUIRED', 'Sign in to access Books');
    try {
      const user = await ensurePlexMembership(this.db, session.userId, forceMembership, this.plex);
      if (!user || !this.db.getSessionById(session.id)) throw new BooksError(401, 'BOOKS_SESSION_REQUIRED');
    } catch (error) {
      if (error instanceof BooksError) throw error;
      if (error instanceof MembershipError) throw new BooksError(403, 'PLEX_ACCESS_REVOKED', 'Plex access has been revoked');
      throw new BooksError(503, 'BOOKS_MEMBERSHIP_UNAVAILABLE', 'Cannot verify Books access right now');
    }
    return { userId: session.userId, sessionId: session.id, expiresAt: session.expiresAt };
  }
  async requireBooksMutation(req: Request, exchange = false, forceMembership = false): Promise<BooksPrincipal> {
    if (!req.headers.authorization?.startsWith('Bearer ')) throw new BooksError(401, 'BOOKS_BEARER_REQUIRED');
    sameOrigin(req);
    return this.authenticateBooks(req, forceMembership, exchange);
  }
  exchange(res: Response, principal: BooksPrincipal): void {
    const token = this.db.books.createMediaSession(principal);
    res.cookie(BOOKS_COOKIE, token, {
      path: '/api/books', httpOnly: true, secure: true, sameSite: 'strict',
      maxAge: Math.max(0, principal.expiresAt - Date.now()),
    });
  }
  clear(res: Response, principal: BooksPrincipal): void {
    this.db.books.revokeBooksSession(principal.sessionId);
    res.clearCookie(BOOKS_COOKIE, { path: '/api/books', httpOnly: true, secure: true, sameSite: 'strict' });
  }
}
