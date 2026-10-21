import { defineConfig, devices } from '@playwright/test';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * E2E against a real db-audit backend that serves the built UI (web/dist).
 * The backend is started by e2e/start-backend.mjs on E2E_PORT (default 4100) with an isolated data dir
 * (E2E_DATA_DIR, default <tmp>/db-audit-e2e) that is wiped before the run. Run `npm run build` first.
 * Needs the local Docker SQL Server (npm run db:up / db:seed in the project root).
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.E2E_PORT ?? 4100);
const dataDir = process.env.E2E_DATA_DIR ?? path.join(os.tmpdir(), 'db-audit-e2e');

export default defineConfig({
  testDir: './e2e',
  timeout: 180_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: './test-results',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
  webServer: {
    // tsx is loaded through NODE_OPTIONS so the process command line stays short and distinctive.
    command: 'node web/e2e/start-backend.mjs',
    cwd: path.resolve(here, '..'),
    url: `http://127.0.0.1:${port}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { PORT: String(port), DB_AUDIT_DATA_DIR: dataDir, ANTHROPIC_API_KEY: '', NODE_OPTIONS: '--import tsx' },
  },
});
