/** Thin fetch wrapper for the db-audit REST API (`/api`). Errors carry the server's `{ error, details }`. */

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

export function isApiError(e: unknown, status?: number): e is ApiRequestError {
  return e instanceof ApiRequestError && (status === undefined || e.status === status);
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiRequestError) {
    const details = formatDetails(e.details);
    return details ? `${e.message} (${details})` : e.message;
  }
  if (e instanceof Error) return e.message;
  return String(e);
}

function formatDetails(details: unknown): string {
  if (!Array.isArray(details)) return '';
  const parts: string[] = [];
  for (const d of details.slice(0, 3)) {
    if (d && typeof d === 'object' && 'message' in d) {
      const path = 'path' in d && Array.isArray((d as { path: unknown }).path) ? (d as { path: unknown[] }).path.join('.') : '';
      parts.push(path ? `${path}: ${String((d as { message: unknown }).message)}` : String((d as { message: unknown }).message));
    }
  }
  return parts.join('; ');
}

export async function api<T>(path: string, init?: { method?: string; body?: unknown; signal?: AbortSignal }): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method: init?.method ?? 'GET',
      headers: init?.body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: init?.signal,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new ApiRequestError(0, 'Cannot reach the db-audit server. Is it running?');
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  if (!res.ok) {
    const b = body as { error?: unknown; details?: unknown } | null;
    const msg = b && typeof b.error === 'string' ? b.error : `${res.status} ${res.statusText || 'request failed'}`;
    throw new ApiRequestError(res.status, msg, b?.details);
  }
  return body as T;
}

export const enc = encodeURIComponent;
