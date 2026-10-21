import sql from 'mssql';
import type { StoredConnection } from '../connections/store';
import { CredentialCache } from './credentials';
import { buildPoolConfig, type EndpointName } from './poolConfig';

/**
 * One mssql.ConnectionPool per (profile, endpoint), created lazily on first use and closed when the
 * profile is updated or deleted. A pool whose connect() fails is discarded so the next call retries.
 */
export class PoolManager {
  private readonly pools = new Map<string, Promise<sql.ConnectionPool>>();

  constructor(
    readonly credentials: CredentialCache = new CredentialCache(),
    private readonly requestTimeoutMs = 120_000,
  ) {}

  private key(id: string, endpoint: EndpointName): string {
    return `${id}:${endpoint}`;
  }

  get(conn: StoredConnection, endpoint: EndpointName): Promise<sql.ConnectionPool> {
    const key = this.key(conn.id, endpoint);
    let p = this.pools.get(key);
    if (!p) {
      const pool = new sql.ConnectionPool(buildPoolConfig(conn, endpoint, this.credentials, { requestTimeoutMs: this.requestTimeoutMs }));
      pool.on('error', () => {
        // Background pool errors (e.g. a dropped idle connection) are not fatal; tarn replaces the connection.
      });
      p = pool.connect().catch((err: unknown) => {
        this.pools.delete(key);
        pool.close().catch(() => undefined);
        throw err;
      });
      this.pools.set(key, p);
    }
    return p;
  }

  /** Closes both endpoint pools of a profile. Pass `forgetCredential` when auth settings changed or the profile is gone. */
  async close(profileId: string, forgetCredential = false): Promise<void> {
    const keys = [this.key(profileId, 'target'), this.key(profileId, 'jobs')];
    await Promise.all(
      keys.map(async (k) => {
        const p = this.pools.get(k);
        this.pools.delete(k);
        if (!p) return;
        try {
          const pool = await p;
          await pool.close();
        } catch {
          // connect failed or already closed
        }
      }),
    );
    if (forgetCredential) this.credentials.delete(profileId);
  }

  async closeAll(): Promise<void> {
    const ids = new Set([...this.pools.keys()].map((k) => k.slice(0, k.lastIndexOf(':'))));
    await Promise.all([...ids].map((id) => this.close(id)));
  }
}
