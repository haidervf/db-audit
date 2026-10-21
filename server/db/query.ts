import sql from 'mssql';
import { assertReadOnlySql } from './readOnlyGuard';

export type SqlParam =
  | { type: 'int'; value: number | null }
  | { type: 'nvarchar'; value: string | null; length?: number }
  | { type: 'nvarcharMax'; value: string | null }
  | { type: 'uniqueidentifier'; value: string | null };

export interface QueryOptions {
  lockTimeoutMs?: number;
  /**
   * Hard wall-clock limit for the request, in ms (default 120000). tedious' requestTimeout stops counting at the
   * first response packet, so a query that has started returning rows could otherwise run forever.
   */
  timeoutMs?: number;
  /** aborting cancels the in-flight request; the query rejects with the signal's reason */
  signal?: AbortSignal;
}

export class QueryTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Query timed out after ${timeoutMs} ms`);
    this.name = 'QueryTimeoutError';
  }
}

/**
 * Settles with `pending`, unless the time limit expires or `signal` aborts first: then the request is cancelled
 * (tedious sends an attention; the connection goes back to the pool when the server acknowledges it, or is
 * destroyed by tedious' cancelTimeout) and the returned promise rejects right away.
 */
function limitRequest<T>(req: sql.Request, pending: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (): boolean => {
      if (settled) return false;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      return true;
    };
    const stop = (err: unknown): void => {
      if (!finish()) return;
      try {
        req.cancel();
      } catch {
        // already completed
      }
      reject(err);
    };
    const onAbort = (): void => stop(signal!.reason);
    const timer = setTimeout(() => stop(new QueryTimeoutError(timeoutMs)), timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    pending.then(
      (v) => {
        if (finish()) resolve(v);
      },
      (e: unknown) => {
        if (finish()) reject(e);
      },
    );
  });
}

/** Every batch sent to a target/job database goes through here: read-only guard + SET LOCK_TIMEOUT + time limit. */
export async function runQuery<T = Record<string, unknown>>(
  pool: sql.ConnectionPool,
  text: string,
  params: Record<string, SqlParam> = {},
  opts: QueryOptions = {},
): Promise<T[][]> {
  assertReadOnlySql(text);
  opts.signal?.throwIfAborted();
  const req = pool.request();
  for (const [name, p] of Object.entries(params)) {
    if (p.type === 'int') req.input(name, sql.Int, p.value);
    else if (p.type === 'nvarchar') req.input(name, sql.NVarChar(p.length ?? 4000), p.value);
    else if (p.type === 'uniqueidentifier') req.input(name, sql.UniqueIdentifier, p.value);
    else req.input(name, sql.NVarChar(sql.MAX), p.value);
  }
  const lock = Math.max(0, Math.floor(opts.lockTimeoutMs ?? 30_000));
  const limit = Math.max(1, Math.floor(opts.timeoutMs ?? 120_000));
  const result = await limitRequest(req, req.query(`SET LOCK_TIMEOUT ${lock};\n${text}`), limit, opts.signal);
  return (result.recordsets as unknown as T[][]) ?? [];
}

export async function queryRows<T = Record<string, unknown>>(
  pool: sql.ConnectionPool,
  text: string,
  params: Record<string, SqlParam> = {},
  opts: QueryOptions = {},
): Promise<T[]> {
  const sets = await runQuery<T>(pool, text, params, opts);
  return sets[0] ?? [];
}

/** Collects every SQL Server error number from an mssql RequestError (including precedingErrors). */
export function sqlErrorNumbers(err: unknown): number[] {
  const out: number[] = [];
  const e = err as { number?: number; precedingErrors?: Array<{ number?: number }>; originalError?: { info?: { number?: number } } };
  for (const pe of e?.precedingErrors ?? []) if (typeof pe.number === 'number') out.push(pe.number);
  if (typeof e?.number === 'number') out.push(e.number);
  else if (typeof e?.originalError?.info?.number === 'number') out.push(e.originalError.info.number);
  return out;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
