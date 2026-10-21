import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { WEB_DIST_DIR } from './config/paths';
import { apiRouter } from './api/routes';
import { errorHandler, localOnly } from './api/http';
import type { AppContext } from './context';

/** Express app: /api (JSON), plus web/dist with SPA fallback when a built UI exists. */
export function createApp(ctx: AppContext, webDist = WEB_DIST_DIR): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);
  app.use(localOnly);
  app.use('/api', express.json({ limit: '1mb' }), apiRouter(ctx));
  const index = path.join(webDist, 'index.html');
  if (fs.existsSync(index)) {
    app.use(express.static(webDist, { index: false }));
    app.use((req, res, next) => {
      if (req.method !== 'GET' || req.path.startsWith('/api')) return next();
      res.sendFile(index);
    });
  }
  app.use(errorHandler);
  return app;
}
