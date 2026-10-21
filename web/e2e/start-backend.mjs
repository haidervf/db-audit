// Starts the db-audit backend for the e2e run (cwd = project root, tsx loader via NODE_OPTIONS=--import tsx).
// Wipes DB_AUDIT_DATA_DIR first, but only if it is empty or was created by this script (marker file),
// so it can never delete a real data directory.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

// Never touch the data dir when another server already owns the port.
const port = Number(process.env.PORT || 4000);
const busy = await new Promise((resolve) => {
  const s = net.connect({ host: '127.0.0.1', port }, () => {
    s.destroy();
    resolve(true);
  });
  s.on('error', () => resolve(false));
});
if (busy) {
  console.error(`[e2e] port ${port} is already in use; not starting (data dir left untouched)`);
  process.exit(1);
}

const dir = process.env.DB_AUDIT_DATA_DIR;
if (!dir) {
  console.error('[e2e] DB_AUDIT_DATA_DIR is not set');
  process.exit(1);
}
const marker = path.join(dir, '.db-audit-e2e');
if (fs.existsSync(dir) && fs.readdirSync(dir).length > 0 && !fs.existsSync(marker)) {
  console.error(`[e2e] refusing to wipe ${dir}: it is not empty and has no ${path.basename(marker)} marker`);
  process.exit(1);
}
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
fs.writeFileSync(marker, 'created by web/e2e/start-backend.mjs; wiped at the start of every e2e run\n');
if (!fs.existsSync(path.resolve('web/dist/index.html'))) {
  console.error('[e2e] web/dist is missing: run `npm --prefix web run build` first');
  process.exit(1);
}
console.log(`[e2e] backend data dir: ${dir}`);
await import(new URL('../../server/index.ts', import.meta.url).href);
