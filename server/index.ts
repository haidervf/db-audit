import type { Server } from 'node:http';
import { createApp } from './app';
import { createContext } from './context';

/** Entry point: `npm start`. Binds to 127.0.0.1 only. */
const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 4000);

const ctx = createContext();
const app = createApp(ctx);
const server: Server = app.listen(PORT, HOST, () => {
  console.log(`[db-audit] listening on http://${HOST}:${PORT}  (data: ${ctx.paths.dataDir})`);
});
server.on('error', (err) => {
  console.error('[db-audit] server error:', err);
  process.exit(1);
});

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(`[db-audit] ${signal}: shutting down`);
  server.close();
  try {
    await ctx.close();
  } finally {
    process.exit(0);
  }
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
