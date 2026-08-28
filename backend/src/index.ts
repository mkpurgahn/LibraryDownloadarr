import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import path from 'path';
import rateLimit from 'express-rate-limit';
import { config } from './config';
import { DatabaseService } from './models/database';
import { createAuthRouter } from './routes/auth';
import { createLibrariesRouter } from './routes/libraries';
import { createLogsRouter } from './routes/logs';
import { createMediaRouter } from './routes/media';
import { createSettingsRouter } from './routes/settings';
import { BurnManager } from './services/burnService';
import { logger } from './utils/logger';

export const createApp = (db: DatabaseService, burnManager: BurnManager): express.Express => {
  const app = express();
  app.disable('x-powered-by');
  if (config.server.trustProxyHops > 0) {
    app.set('trust proxy', config.server.trustProxyHops);
  }
  app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
  app.use(cors(config.cors));
  app.use('/api/', rateLimit({
    windowMs: config.rateLimit.windowMs,
    limit: config.rateLimit.globalMax,
    standardHeaders: true,
    legacyHeaders: false,
  }));
  app.use(express.json({ limit: '32kb' }));
  app.use(express.urlencoded({ extended: true, limit: '32kb' }));

  app.get('/api/health', (_req, res) =>
    res.json({ status: 'ok', timestamp: new Date().toISOString() }));
  app.use('/api/auth', createAuthRouter(db));
  app.use('/api/libraries', createLibrariesRouter(db));
  app.use('/api/media', createMediaRouter(db, { burnManager }));
  app.use('/api/settings', createSettingsRouter(db));
  app.use('/api/logs', createLogsRouter(db));

  const publicPath = path.join(__dirname, '..', 'public');
  app.use(express.static(publicPath));
  app.get('*', (_req, res) => res.sendFile(path.join(publicPath, 'index.html')));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error('Unhandled error', { error });
    return res.status(500).json({ error: 'Internal server error' });
  });
  return app;
};

export const startServer = async (): Promise<void> => {
  const db = new DatabaseService(config.database.path, config.database.encryptionKey);
  const burnManager = new BurnManager(db);
  await burnManager.start();
  const cleanup = setInterval(() => {
    db.cleanupExpiredSessions();
    void burnManager.cleanupExpiredArtifacts();
  }, 60 * 60 * 1000);
  cleanup.unref();

  const app = createApp(db, burnManager);
  const server = app.listen(config.server.port, () => {
    logger.info(`LibraryDownloadarr server started on port ${config.server.port}`);
  });
  const shutdown = (): void => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
};

if (require.main === module) {
  void startServer().catch(error => {
    logger.error('Server startup failed', { error });
    process.exit(1);
  });
}
