import { Request, Response, NextFunction } from 'express';
import { DatabaseService } from '../models/database';
import { logger } from '../utils/logger';
import { ensurePlexMembership, MembershipError } from '../services/membershipService';
import {
  PlexServerOwnershipRequiredError,
  PlexService,
  plexService,
} from '../services/plexService';
import { config } from '../config';

export interface AuthRequest extends Request {
  user?: {
    id: string;
    username: string;
    isAdmin: boolean;
    plexToken?: string;
    plexId?: string;
    serverUrl?: string;
  };
  authSession?: {
    id: string;
    token: string;
  };
}

export const createAuthMiddleware = (db: DatabaseService, service: PlexService = plexService) => {
  return async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const authHeader = req.headers.authorization;
      const token = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : null;

      if (!token) {
        return res.status(401).json({ error: 'No token provided' });
      }

      const session = db.getSessionByToken(token);
      if (!session) {
        return res.status(401).json({ error: 'Invalid or expired token' });
      }

      // A local admin session is only valid during first-run Plex configuration.
      const adminUser = db.getAdminUserById(session.userId);
      if (adminUser && !db.getSetting('plex_machine_id')) {
        req.user = {
          id: adminUser.id,
          username: adminUser.username,
          isAdmin: adminUser.isAdmin,
        };
        req.authSession = {
          id: session.id,
          token,
        };
        return next();
      }

      // Try plex user
      const plexUser = db.getPlexUserById(session.userId);
      if (plexUser) {
        const activeUser = await ensurePlexMembership(db, plexUser.id, false, service);
        const ownerId = db.getSetting('plex_owner_id');
        let isAdmin = Boolean(ownerId && activeUser!.plexId === ownerId);
        if (isAdmin) {
          const machineId = db.getSetting('plex_machine_id');
          const validatedAt = Number(db.getSetting('plex_owner_validated_at') || 0);
          const validationFresh =
            Number.isFinite(validatedAt) &&
            validatedAt > Date.now() - config.plex.membershipTtlMs;
          if (!machineId || !activeUser!.plexAccountToken) {
            isAdmin = false;
          } else if (!validationFresh) {
            try {
              const identity = await service.getServerOwnerIdentity(
                activeUser!.plexAccountToken,
                machineId
              );
              isAdmin = identity.id === ownerId;
              if (isAdmin) {
                db.setSetting('plex_owner_validated_at', String(Date.now()));
              }
            } catch (error) {
              isAdmin = false;
              if (error instanceof PlexServerOwnershipRequiredError) {
                db.clearPlexOwner();
                logger.warn('Configured Plex owner no longer owns the server', {
                  userId: activeUser!.id,
                  machineId,
                });
              } else {
                logger.warn('Could not revalidate Plex owner access', {
                  userId: activeUser!.id,
                  error,
                });
              }
            }
          }
        }
        req.user = {
          id: activeUser!.id,
          username: activeUser!.username,
          isAdmin,
          plexToken: activeUser!.plexToken,
          plexId: activeUser!.plexId,
        };
        req.authSession = {
          id: session.id,
          token,
        };
        return next();
      }

      return res.status(401).json({ error: 'User not found' });
    } catch (error) {
      if (error instanceof MembershipError) {
        return res.status(403).json({ error: error.message, code: 'PLEX_ACCESS_REVOKED' });
      }
      logger.error('Authentication error', { error });
      return res.status(500).json({ error: 'Authentication failed' });
    }
  };
};

export const createAdminMiddleware = (db: DatabaseService) => {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    const machineId = db.getSetting('plex_machine_id');
    if (!machineId && req.user?.isAdmin && !req.user.plexId) {
      return next();
    }
    const ownerId = db.getSetting('plex_owner_id');
    if (!req.user?.isAdmin || !ownerId || req.user.plexId !== ownerId) {
      return res.status(403).json({ error: 'Plex owner access required' });
    }
    return next();
  };
};
