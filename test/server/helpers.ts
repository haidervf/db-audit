/**
 * Shared helpers for the server tests. Integration tests run against the LOCAL Docker SQL Server from
 * dev/docker-compose.yml (localhost:14340) and skip with a clear message when it is not reachable.
 * Test setup that changes the database (ALTER/DROP of throwaway procs) uses the dev-only `sa` login.
 */
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import sql from 'mssql';
import type { ConnectionInput, ObjectKind, RefreshRequest, RefreshRun } from '../../shared/types';
import { createApp } from '../../server/app';
import { PROJECT_ROOT } from '../../server/config/paths';
import { createContext, type AppContext } from '../../server/context';
import type { ConnectionInputParsed } from '../../server/connections/schema';

function readEnvDev(): Record<string, string> {
  const out: Record<string, string> = {};
  const file = path.join(PROJECT_ROOT, 'dev', '.env.dev');
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

export const ENV = readEnvDev();
export const HOST = 'localhost';
export const PORT = Number(ENV.DB_AUDIT_MSSQL_PORT ?? 14340);

export const LOGINS = {
  full: { user: 'audit_full', password: ENV.DB_AUDIT_FULL_PASSWORD },
  reader: { user: 'audit_reader', password: ENV.DB_AUDIT_READER_PASSWORD },
  nojobs: { user: 'audit_nojobs', password: ENV.DB_AUDIT_NOJOBS_PASSWORD },
} as const;

/** Expected seed counts (dev/seed/02_AuditDemo.sql, 03_AuditJobs.sql, 95_agent_jobs.sql). */
export const SEED = {
  auditDemo: { procedure: 18, table: 11, view: 2, function: 2, trigger: 2 },
  auditArchive: { procedure: 2, table: 3, view: 0, function: 0, trigger: 0 },
  elastic: { jobs: 5, steps: 6, executions: 13 },
  agent: { jobs: 5, steps: 7, schedules: 6 },
};

export function saConfig(database = 'master'): sql.config {
  return {
    server: HOST,
    port: PORT,
    database,
    user: 'sa',
    password: ENV.DB_AUDIT_SA_PASSWORD,
    options: { encrypt: true, trustServerCertificate: true },
    connectionTimeout: 5000,
    requestTimeout: 60000,
  };
}

let availability: Promise<string | null> | null = null;
/** null when the Docker SQL Server is reachable and seeded, else a reason string (used as the skip message). */
export function dockerUnavailableReason(): Promise<string | null> {
  availability ??= (async () => {
    const pool = new sql.ConnectionPool(saConfig('master'));
    try {
      await pool.connect();
      const r = await pool.request().query(`SELECT DB_ID(N'AuditDemo') AS d, DB_ID(N'AuditArchive') AS a, DB_ID(N'AuditJobs') AS j`);
      const row = r.recordset[0];
      if (!row.d || !row.a || !row.j) return 'Docker SQL Server is up but not seeded: run `npm run db:seed`';
      return null;
    } catch (err) {
      return `Docker SQL Server not reachable at ${HOST}:${PORT} (${(err as Error).message}); run \`npm run db:up && npm run db:seed\``;
    } finally {
      await pool.close().catch(() => undefined);
    }
  })();
  return availability;
}

/** Runs dev-only setup SQL as sa (NOT through the app's read-only path). */
export async function saExec(database: string, batches: string[]): Promise<void> {
  const pool = await new sql.ConnectionPool(saConfig(database)).connect();
  try {
    for (const b of batches) await pool.request().batch(b);
  } finally {
    await pool.close();
  }
}

export function connectionInput(
  database: 'AuditDemo' | 'AuditArchive',
  login: keyof typeof LOGINS,
  extra: Partial<ConnectionInput> = {},
): ConnectionInputParsed {
  return {
    name: `${database} as ${LOGINS[login].user}`,
    target: { server: HOST, database, port: PORT },
    jobs: { server: HOST, database: 'AuditJobs', port: PORT },
    jobsSource: 'auto',
    auth: { mode: 'sql', user: LOGINS[login].user, password: LOGINS[login].password },
    options: { encrypt: true, trustServerCertificate: true, readOnlyIntent: false },
    ...extra,
  } as ConnectionInputParsed;
}

const TEST_DATA_ROOT = path.join(PROJECT_ROOT, 'data', 'test-runs');

/** Fresh context in data/test-runs/<random> (data/ is gitignored). */
export function tempContext(opts: Parameters<typeof createContext>[0] = {}): AppContext & { cleanup(): Promise<void> } {
  fs.mkdirSync(TEST_DATA_ROOT, { recursive: true });
  const dir = fs.mkdtempSync(path.join(TEST_DATA_ROOT, 'run-'));
  const ctx = createContext({ ...opts, dataDir: dir });
  return Object.assign(ctx, {
    async cleanup() {
      await ctx.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  });
}

export async function refreshAndWait(ctx: AppContext, connectionId: string, request: RefreshRequest): Promise<RefreshRun> {
  const run = ctx.refresh.start(connectionId, request);
  await ctx.refresh.waitIdle(connectionId);
  const done = ctx.refresh.get(connectionId, run.id);
  if (!done) throw new Error('run vanished');
  return done;
}

export function countKinds(ctx: AppContext, connectionId: string): Record<ObjectKind | 'job', number> {
  return ctx.caches.get(connectionId).countObjects();
}

/** Starts the real Express app on an ephemeral 127.0.0.1 port. */
export async function startServer(ctx: AppContext): Promise<{ base: string; port: number; close(): Promise<void> }> {
  const app = createApp(ctx, path.join(PROJECT_ROOT, 'data', 'test-runs', 'no-web-dist'));
  const server = await new Promise<import('node:http').Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export async function api<T = unknown>(base: string, method: string, url: string, body?: unknown): Promise<{ status: number; body: T; text: string }> {
  const res = await fetch(base + url, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = undefined;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed as T, text };
}

export async function pollRun(base: string, id: string, runId: string, timeoutMs = 120_000): Promise<RefreshRun> {
  const t0 = Date.now();
  for (;;) {
    const r = await api<RefreshRun>(base, 'GET', `/api/connections/${id}/refresh/${runId}`);
    if (r.status !== 200) throw new Error(`poll failed: ${r.status} ${r.text}`);
    if (r.body.status !== 'running') return r.body;
    if (Date.now() - t0 > timeoutMs) throw new Error('refresh did not finish in time');
    await new Promise((res) => setTimeout(res, 200));
  }
}
