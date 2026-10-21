import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import type { ApiError } from '../../shared/types';
import { ConflictError, NotFoundError } from '../refresh/orchestrator';
import { GraphFocusNotFound } from './graph';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
    /** extra response headers, e.g. Retry-After on 429 */
    readonly headers?: Record<string, string>,
  ) {
    super(message);
  }
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function hostnameOf(hostHeader: string): string {
  const h = hostHeader.trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1);
  const colon = h.lastIndexOf(':');
  return colon >= 0 ? h.slice(0, colon) : h;
}

/**
 * DNS-rebinding guard: only requests addressed to localhost / 127.0.0.1 are served. Requests that carry
 * an Origin header must also come from a local origin (blocks cross-site form posts / fetches).
 */
export function localOnly(req: Request, res: Response, next: NextFunction): void {
  const host = req.headers.host ?? '';
  if (!LOCAL_HOSTS.has(hostnameOf(host))) {
    res.status(403).json({ error: `host "${host}" is not allowed; use http://localhost or http://127.0.0.1` } satisfies ApiError);
    return;
  }
  const origin = req.headers.origin;
  if (origin && origin !== 'null') {
    let ok = false;
    try {
      ok = LOCAL_HOSTS.has(new URL(origin).hostname.toLowerCase());
    } catch {
      ok = false;
    }
    if (!ok) {
      res.status(403).json({ error: `origin "${origin}" is not allowed` } satisfies ApiError);
      return;
    }
  }
  next();
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  let status = 500;
  let body: ApiError;
  if (err instanceof HttpError) {
    status = err.status;
    body = { error: err.message, details: err.details };
    if (err.headers) res.set(err.headers);
  } else if (err instanceof ZodError) {
    status = 400;
    body = { error: 'invalid request', details: err.issues };
  } else if (err instanceof ConflictError) {
    status = 409;
    body = { error: err.message };
  } else if (err instanceof NotFoundError || err instanceof GraphFocusNotFound) {
    status = 404;
    body = { error: err.message };
  } else if (err instanceof SyntaxError && 'body' in (err as object)) {
    status = 400;
    body = { error: 'malformed JSON body' };
  } else if (typeof err === 'object' && err !== null && 'status' in err && typeof (err as { status: unknown }).status === 'number') {
    status = (err as { status: number }).status;
    body = { error: (err as unknown as Error).message };
  } else {
    body = { error: err instanceof Error ? err.message : String(err) };
  }
  if (status >= 500) console.error('[db-audit] request failed:', err);
  if (body.details === undefined) delete body.details;
  res.status(status).json(body);
}
