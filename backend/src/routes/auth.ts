import { Router } from 'express';
import bcrypt from 'bcrypt';
import { DatabaseService } from '../models/database';
import {
  PlexAuthResponse,
  PlexAccountUnauthorizedError,
  PlexServerAccessDeniedError,
  plexService,
} from '../services/plexService';
import { logger } from '../utils/logger';
import { AuthRequest, createAuthMiddleware } from '../middleware/auth';
import rateLimit from 'express-rate-limit';
import { config } from '../config';
import { clearSessionCookie, setSessionCookie } from '../utils/sessionCookie';

export const createAuthRouter = (db: DatabaseService) => {
  const router = Router();
  const authMiddleware = createAuthMiddleware(db);
  const loginLimiter = rateLimit({
    windowMs: config.rateLimit.windowMs,
    limit: config.rateLimit.loginMax,
    standardHeaders: true,
    legacyHeaders: false,
  });
  const plexPollLimiter = rateLimit({
    windowMs: config.rateLimit.windowMs,
    limit: config.rateLimit.plexPollMax,
    standardHeaders: true,
    legacyHeaders: false,
  });
  const savePlexOwner = (owner: { id: string; username: string }): void => {
    db.setSetting('plex_owner_id', owner.id);
    db.setSetting('plex_owner_username', owner.username);
    db.setSetting('plex_owner_validated_at', String(Date.now()));
    db.setExclusivePlexAdminByPlexId(owner.id);
    db.removeLocalAdminAccounts();
  };
  const getConfiguredPlexOwner = async (
    authenticated: PlexAuthResponse,
    authenticatedOwnsServer: boolean
  ): Promise<{ id: string; username: string } | undefined> => {
    let savedId = db.getSetting('plex_owner_id');
    if (authenticatedOwnsServer) {
      const owner = {
        id: authenticated.user.uuid,
        username: authenticated.user.username,
      };
      savePlexOwner(owner);
      return owner;
    }
    if (savedId === authenticated.user.uuid) {
      db.clearPlexOwner();
      savedId = undefined;
    }
    if (savedId) {
      return {
        id: savedId,
        username: db.getSetting('plex_owner_username') || 'Plex owner',
      };
    }
    const ownerToken = db.getSetting('plex_token');
    const machineId = db.getSetting('plex_machine_id');
    if (!ownerToken || !machineId) {
      return undefined;
    }
    try {
      const owner = await plexService.getServerOwnerIdentity(ownerToken, machineId);
      savePlexOwner(owner);
      return owner;
    } catch (error) {
      logger.warn('Legacy Plex owner token could not establish administrator identity', {
        error,
        machineId,
      });
      return undefined;
    }
  };

  // Check if initial setup is required
  router.get('/setup/required', (_req, res) => {
    const setupRequired = !db.getSetting('plex_machine_id');
    return res.json({ setupRequired });
  });

  // Initial local bootstrap, retired as soon as a Plex owner is configured.
  router.post('/setup', loginLimiter, async (req, res) => {
    try {
      if (db.getSetting('plex_machine_id')) {
        return res.status(400).json({ error: 'Setup already completed' });
      }

      const { username, password } = req.body;

      if (typeof username !== 'string' || typeof password !== 'string') {
        return res.status(400).json({ error: 'Username and password are required' });
      }
      if (!/^[A-Za-z0-9_.-]{3,64}$/.test(username) || password.length < 12 || password.length > 256) {
        return res.status(400).json({ error: 'Username is invalid or password is shorter than 12 characters' });
      }

      const existing = db.getAdminUserByUsername(username);
      let adminUser = existing;
      if (db.hasAdminUser()) {
        if (!existing || !await bcrypt.compare(password, existing.passwordHash)) {
          return res.status(401).json({ error: 'Invalid bootstrap credentials' });
        }
        db.updateAdminLastLogin(existing.id);
      } else {
        const passwordHash = await bcrypt.hash(password, 10);
        adminUser = db.createAdminUser({
          username,
          passwordHash,
          email: `${username}@localhost`,
          isAdmin: true,
        });
      }

      // Create session
      const session = db.createSession(adminUser!.id);
      setSessionCookie(req, res, session.token);

      logger.info(existing ? 'Initial setup resumed' : 'Initial setup started');

      return res.json({
        message: existing ? 'Setup resumed successfully' : 'Setup started successfully',
        user: {
          id: adminUser!.id,
          username: adminUser!.username,
          email: adminUser!.email,
          isAdmin: adminUser!.isAdmin,
        },
        token: session.token,
      });
    } catch (error) {
      logger.error('Setup error', { error });
      return res.status(500).json({ error: 'Setup failed' });
    }
  });

  // Plex OAuth: Generate PIN
  router.post('/plex/pin', loginLimiter, async (_req, res) => {
    try {
      const pin = await plexService.generatePin();
      return res.json({
        id: pin.id,
        code: pin.code,
        url: `https://app.plex.tv/auth#?clientID=${encodeURIComponent(
          'librarydownloadarr'
        )}&code=${encodeURIComponent(pin.code)}&context[device][product]=${encodeURIComponent(
          'LibraryDownloadarr'
        )}`,
      });
    } catch (error) {
      logger.error('Plex PIN generation error', { error });
      return res.status(500).json({ error: 'Failed to generate Plex PIN' });
    }
  });

  // Plex OAuth: Check PIN and authenticate
  router.post('/plex/authenticate', plexPollLimiter, async (req, res) => {
    try {
      const { pinId } = req.body;

      if (!Number.isInteger(pinId) || pinId <= 0) {
        return res.status(400).json({ error: 'PIN ID is required' });
      }

      logger.debug('Checking Plex PIN', { pinId });

      const authResponse = await plexService.checkPin(pinId);
      if (!authResponse) {
        return res.status(400).json({ error: 'PIN not yet authorized' });
      }

      logger.debug('Plex PIN authorized', { username: authResponse.user.username });

      // SECURITY: Validate user has access to admin's configured Plex server
      const adminServerUrl = db.getSetting('plex_url') || '';
      const adminMachineId = db.getSetting('plex_machine_id') || '';

      if (!adminServerUrl) {
        logger.error('Admin Plex server not configured');
        return res.status(500).json({ error: 'Plex server not configured. Please contact administrator.' });
      }

      if (!adminMachineId) {
        logger.error('Admin Plex machine ID not configured');
        return res.status(500).json({ error: 'Plex server machine ID not configured. Please contact administrator.' });
      }

      // Get user's accessible servers and validate they have access to admin's server
      let userToken: string;
      let authenticatedOwnsServer = false;
      try {
        const membership = await plexService.validateExactServerMembership(
          authResponse.authToken,
          adminMachineId
        );
        if (!membership.serverToken) {
          logger.warn('User does not have access to admin Plex server', {
            username: authResponse.user.username,
            adminMachineId,
          });
          return res.status(403).json({
            error: 'Access denied. You do not have access to this Plex server.'
          });
        }

        // For shared servers, use the server's accessToken; for owned servers, use the user's auth token
        userToken = membership.serverToken;
        authenticatedOwnsServer = membership.owned;

        logger.debug('User validated for admin server', {
          username: authResponse.user.username,
          hasAccessToken: userToken !== authResponse.authToken,
          isSharedServer: userToken !== authResponse.authToken
        });
      } catch (error) {
        if (error instanceof PlexAccountUnauthorizedError) {
          return res.status(401).json({
            error: 'Plex authorization expired. Please start sign-in again.',
          });
        }
        if (error instanceof PlexServerAccessDeniedError) {
          logger.warn('Plex identity denied for configured server', {
            username: authResponse.user.username,
            adminMachineId,
          });
          return res.status(403).json({
            error: 'Access denied. You do not have access to this Plex server.',
          });
        }
        throw error;
      }

      const owner = await getConfiguredPlexOwner(authResponse, authenticatedOwnsServer);
      const isAdmin = authResponse.user.uuid === owner?.id;

      // Create or update Plex user. Only the configured server owner is an admin.
      const plexUser = db.createOrUpdatePlexUser({
        username: authResponse.user.username,
        email: authResponse.user.email,
        plexToken: userToken,
        plexAccountToken: authResponse.authToken,
        plexId: authResponse.user.uuid,
        isAdmin,
      });

      // Create session
      const session = db.createSession(plexUser.id);
      setSessionCookie(req, res, session.token);

      logger.info(`Plex user authenticated: ${plexUser.username}`);

      return res.json({
        user: {
          id: plexUser.id,
          username: plexUser.username,
          email: plexUser.email,
          isAdmin: plexUser.isAdmin,
        },
        token: session.token,
      });
    } catch (error: any) {
      logger.error('Plex authentication error', {
        error: error.message,
        stack: error.stack,
        pinId: req.body.pinId
      });
      return res.status(500).json({ error: 'Plex authentication failed' });
    }
  });

  // Get current user
  router.get('/me', authMiddleware, (req: AuthRequest, res) => {
    setSessionCookie(req, res, req.authSession!.token);
    return res.json({
      user: {
        id: req.user!.id,
        username: req.user!.username,
        isAdmin: req.user!.isAdmin,
      },
    });
  });

  // Logout
  router.post('/logout', authMiddleware, (req: AuthRequest, res) => {
    try {
      if (req.authSession?.token) {
        db.deleteSession(req.authSession.token);
      }
      clearSessionCookie(req, res);
      return res.json({ message: 'Logged out successfully' });
    } catch (error) {
      logger.error('Logout error', { error });
      return res.status(500).json({ error: 'Logout failed' });
    }
  });

  return router;
};
