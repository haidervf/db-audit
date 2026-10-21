import type sql from 'mssql';
import type { DbEndpoint } from '../../shared/types';
import type { StoredConnection } from '../connections/store';
import type { CredentialCache, EntraMode } from './credentials';

export type EndpointName = 'target' | 'jobs';

/** Accepts "host", "tcp:host,1433", "host,1433", "host\\instance" (the forms people paste from SSMS / Azure portal). */
export function parseServer(server: string, port?: number): { host: string; port?: number; instanceName?: string } {
  let s = server.trim();
  if (/^tcp:/i.test(s)) s = s.slice(4);
  let p = port;
  const comma = s.lastIndexOf(',');
  if (comma >= 0) {
    const maybePort = Number(s.slice(comma + 1).trim());
    if (Number.isInteger(maybePort) && maybePort > 0) p = p ?? maybePort;
    s = s.slice(0, comma).trim();
  }
  let instanceName: string | undefined;
  const bs = s.indexOf('\\');
  if (bs >= 0) {
    instanceName = s.slice(bs + 1);
    s = s.slice(0, bs);
  }
  return { host: s, port: p, instanceName };
}

/** First DNS label, lower-cased: "MyServer.database.windows.net" -> "myserver". */
export function hostLabel(server: string | null | undefined): string {
  if (!server) return '';
  return parseServer(server).host.split('.')[0].toLowerCase();
}

export function endpointOf(conn: StoredConnection, endpoint: EndpointName): DbEndpoint {
  const ep = endpoint === 'target' ? conn.target : conn.jobs;
  if (!ep) throw new Error(`connection ${conn.id} has no ${endpoint} endpoint`);
  return ep;
}

export interface PoolConfigOptions {
  requestTimeoutMs?: number;
}

/**
 * Builds the mssql pool config for one endpoint of a profile.
 * sql -> tedious 'default' auth; every Entra mode -> 'token-credential' with the cached clone-safe credential.
 */
export function buildPoolConfig(
  conn: StoredConnection,
  endpoint: EndpointName,
  credentials: CredentialCache,
  opts: PoolConfigOptions = {},
): sql.config {
  const ep = endpointOf(conn, endpoint);
  const { host, port, instanceName } = parseServer(ep.server, ep.port);
  const options: sql.config['options'] = {
    encrypt: conn.options.encrypt,
    trustServerCertificate: conn.options.trustServerCertificate,
    appName: 'db-audit',
    readOnlyIntent: conn.options.readOnlyIntent ?? false,
  };
  if (instanceName) options.instanceName = instanceName;
  const base: sql.config = {
    server: host,
    database: ep.database,
    connectionTimeout: 30_000,
    requestTimeout: opts.requestTimeoutMs ?? 120_000,
    pool: { max: 4, min: 0, idleTimeoutMillis: 30_000 },
    options,
  };
  if (port !== undefined) base.port = port;

  if (conn.auth.mode === 'sql') {
    base.authentication = {
      type: 'default',
      options: { userName: conn.auth.user ?? '', password: conn.auth.password ?? '' },
    };
    return base;
  }
  const credential = credentials.get(conn.id, {
    mode: conn.auth.mode as EntraMode,
    tenantId: conn.auth.tenantId,
    clientId: conn.auth.clientId,
  });
  base.authentication = { type: 'token-credential', options: { credential } };
  return base;
}
