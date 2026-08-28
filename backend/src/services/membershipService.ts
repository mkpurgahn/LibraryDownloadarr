import { config } from '../config';
import { DatabaseService, User } from '../models/database';
import {
  PlexAccountUnauthorizedError,
  PlexServerAccessDeniedError,
  PlexService,
  plexService,
} from './plexService';

export class MembershipError extends Error {
  constructor(message = 'Plex server access has been revoked') {
    super(message);
  }
}

export const ensurePlexMembership = async (
  db: DatabaseService,
  userId: string,
  force = false,
  service: PlexService = plexService
): Promise<User | undefined> => {
  if (db.getAdminUserById(userId)) return undefined;
  const user = db.getPlexUserById(userId);
  if (!user?.plexAccountToken) {
    db.deleteSessionsForUser(userId);
    throw new MembershipError('Plex sign-in must be renewed');
  }

  const stillFresh =
    user.membershipValidatedAt !== undefined &&
    Date.now() - user.membershipValidatedAt < config.plex.membershipTtlMs;
  if (!force && stillFresh) return user;

  const machineId = db.getSetting('plex_machine_id');
  if (!machineId) throw new MembershipError('Configured Plex server identity is unavailable');

  try {
    const membership = await service.validateExactServerMembership(user.plexAccountToken, machineId);
    db.updatePlexMembership(user.id, membership.serverToken);
    return db.getPlexUserById(user.id);
  } catch (error) {
    if (
      error instanceof PlexServerAccessDeniedError ||
      error instanceof PlexAccountUnauthorizedError
    ) {
      db.clearPlexMembership(user.id);
      db.deleteSessionsForUser(user.id);
      throw new MembershipError();
    }
    throw error;
  }
};
