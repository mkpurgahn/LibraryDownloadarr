import { Router } from 'express';
import { DatabaseService } from '../models/database';
import { plexService } from '../services/plexService';
import { logger } from '../utils/logger';
import { AuthRequest, createAuthMiddleware, createAdminMiddleware } from '../middleware/auth';

export const createSettingsRouter = (db: DatabaseService) => {
  const router = Router();
  const authMiddleware = createAuthMiddleware(db);
  const adminMiddleware = createAdminMiddleware();

  // Get settings (admin only)
  router.get('/', authMiddleware, adminMiddleware, (_req: AuthRequest, res) => {
    try {
      const plexUrl = db.getSetting('plex_url') || '';
      const plexToken = db.getSetting('plex_token') || '';
      const plexMachineId = db.getSetting('plex_machine_id') || '';
      const plexServerName = db.getSetting('plex_server_name') || '';

      return res.json({
        settings: {
          plexUrl,
          hasPlexToken: !!plexToken,
          plexMachineId,
          plexServerName,
        },
      });
    } catch (error) {
      logger.error('Failed to get settings', { error });
      return res.status(500).json({ error: 'Failed to get settings' });
    }
  });

  // Update settings (admin only)
  router.put('/', authMiddleware, adminMiddleware, async (req: AuthRequest, res) => {
    try {
      const { plexUrl, plexToken } = req.body;

      if (plexUrl !== undefined && (typeof plexUrl !== 'string' || !/^https?:\/\//.test(plexUrl) || plexUrl.length > 2048)) {
        return res.status(400).json({ error: 'A valid http(s) Plex URL is required' });
      }
      if (plexToken !== undefined && (typeof plexToken !== 'string' || plexToken.length < 8 || plexToken.length > 1024)) {
        return res.status(400).json({ error: 'A valid Plex token is required' });
      }

      // Update Plex service connection and auto-fetch server identity
      if (plexUrl || plexToken) {
        const url = plexUrl || db.getSetting('plex_url') || '';
        const token = plexToken || db.getSetting('plex_token') || '';

        if (url && token) {
          // Auto-fetch machine ID and server name
          try {
            const client = plexService.createServerClient(url, token);
            const serverInfo = await client.getServerIdentity();

            if (serverInfo?.machineIdentifier) {
              db.setSetting('plex_url', url);
              db.setSetting('plex_token', token);
              db.setSetting('plex_machine_id', serverInfo.machineIdentifier);
              db.setSetting('plex_server_name', serverInfo.friendlyName);

              logger.debug('Auto-fetched server identity', {
                machineId: serverInfo.machineIdentifier,
                serverName: serverInfo.friendlyName
              });
            } else {
              return res.status(400).json({ error: 'Plex server identity could not be verified' });
            }
          } catch (error) {
            return res.status(400).json({ error: 'Plex server identity could not be verified' });
          }
        }
      }

      logger.info('Settings updated by admin');

      return res.json({ message: 'Settings updated successfully' });
    } catch (error) {
      logger.error('Failed to update settings', { error });
      return res.status(500).json({ error: 'Failed to update settings' });
    }
  });

  // Test Plex connection (admin only)
  router.post('/test-connection', authMiddleware, adminMiddleware, async (req: AuthRequest, res) => {
    try {
      const { plexUrl, plexToken } = req.body;

      // If URL and token provided in request, test those; otherwise test saved settings
      if (plexUrl && plexToken) {
        const isConnected = await plexService.testConnectionWithCredentials(plexUrl, plexToken);
        return res.json({ connected: isConnected });
      } else {
        const url = db.getSetting('plex_url');
        const token = db.getSetting('plex_token');
        const isConnected = Boolean(url && token) &&
          await plexService.testConnectionWithCredentials(url!, token!);
        return res.json({ connected: isConnected });
      }
    } catch (error) {
      logger.error('Connection test failed', { error });
      return res.status(500).json({ error: 'Connection test failed', connected: false });
    }
  });

  return router;
};
