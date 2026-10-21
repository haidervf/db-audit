/**
 * Entra modes are verified WITHOUT contacting Azure:
 *  1. each mode builds a pool config with authentication.type 'token-credential' whose credential passes
 *     tedious's own check (the real `new tedious.Connection(config)` constructor validation) — the real
 *     @azure/identity classes are constructed but getToken is never called;
 *  2. connecting to the LOCAL Docker server with a FAKE credential fails with a login/auth error, not
 *     "TypeError ... must be an instance of the token credential class".
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AzureCliCredential, DefaultAzureCredential, InteractiveBrowserCredential } from '@azure/identity';
import type { AccessToken, TokenCredential } from '@azure/identity';
import { Connection } from 'tedious';
import type { StoredConnection } from '../../server/connections/store';
import { cloneSafeCredential, CredentialCache, createIdentityCredential, type EntraAuthOptions, type EntraMode } from '../../server/db/credentials';
import { buildPoolConfig } from '../../server/db/poolConfig';
import { PoolManager } from '../../server/db/pools';
import { dockerUnavailableReason, HOST, PORT } from './helpers';

const MODES: EntraMode[] = ['entra-cli', 'entra-interactive', 'entra-default'];

function profile(mode: EntraMode, extra: Partial<StoredConnection['auth']> = {}): StoredConnection {
  return {
    id: `entra${mode.replace(/[^a-z]/g, '')}`,
    name: mode,
    target: { server: HOST, database: 'AuditDemo', port: PORT },
    jobs: null,
    jobsSource: 'none',
    auth: { mode, ...extra },
    options: { encrypt: true, trustServerCertificate: true, readOnlyIntent: false },
    createdAt: '',
    updatedAt: '',
    lastRefreshAt: null,
  };
}

/** A credential that must never be asked for a real token. */
function tripwireFactory(record: EntraAuthOptions[]): (o: EntraAuthOptions) => TokenCredential {
  return (o) => {
    record.push(o);
    const real = createIdentityCredential(o); // construct the real class (no network), never call it
    return {
      getToken: () => {
        throw new Error(`getToken must not be called in tests (${real.constructor.name})`);
      },
    };
  };
}

describe('entra: pool config + tedious credential check (no network)', () => {
  for (const mode of MODES) {
    it(`${mode}: token-credential config accepted by tedious`, () => {
      const seen: EntraAuthOptions[] = [];
      const cache = new CredentialCache(tripwireFactory(seen));
      const cfg = buildPoolConfig(profile(mode, { tenantId: '00000000-0000-0000-0000-000000000001' }), 'target', cache);
      assert.equal(cfg.authentication?.type, 'token-credential');
      const credential = (cfg.authentication as { options: { credential: TokenCredential } }).options.credential;
      assert.equal(typeof credential.getToken, 'function');
      assert.equal(cfg.options?.appName, 'db-audit');
      assert.equal(cfg.connectionTimeout, 30000);
      assert.equal(cfg.requestTimeout, 120000);
      assert.equal(cfg.pool?.max, 4);
      // tedious validates authentication in the Connection constructor (connect() is never called here)
      assert.doesNotThrow(
        () => new Connection({ server: cfg.server, authentication: cfg.authentication, options: { port: cfg.port, database: cfg.database, encrypt: true } }),
      );
      assert.equal(seen.length, 1);
      assert.equal(seen[0].mode, mode);
      // same profile -> cached credential (interactive login happens once per process)
      buildPoolConfig(profile(mode, { tenantId: '00000000-0000-0000-0000-000000000001' }), 'target', cache);
      assert.equal(seen.length, 1);
    });
  }

  it('constructs the expected @azure/identity class per mode (constructed only, never called)', () => {
    assert.ok(createIdentityCredential({ mode: 'entra-cli' }) instanceof AzureCliCredential);
    assert.ok(createIdentityCredential({ mode: 'entra-interactive' }) instanceof InteractiveBrowserCredential);
    assert.ok(createIdentityCredential({ mode: 'entra-interactive', clientId: '11111111-1111-1111-1111-111111111111' }) instanceof InteractiveBrowserCredential);
    assert.ok(createIdentityCredential({ mode: 'entra-default' }) instanceof DefaultAzureCredential);
  });

  it('the wrapped real credential also passes tedious\'s check', () => {
    for (const mode of MODES) {
      const wrapped = cloneSafeCredential(createIdentityCredential({ mode }));
      assert.doesNotThrow(() => new Connection({ server: HOST, authentication: { type: 'token-credential', options: { credential: wrapped } }, options: { port: PORT } }));
    }
  });

  it('a non-credential is rejected by tedious (proves the check is real)', () => {
    assert.throws(
      () => new Connection({ server: HOST, authentication: { type: 'token-credential', options: { credential: {} as TokenCredential } }, options: { port: PORT } }),
      /must be an instance of the token credential class/,
    );
  });

  it('cloneSafeCredential caches per scope and de-duplicates concurrent calls', async () => {
    let calls = 0;
    const inner: TokenCredential = {
      getToken: async () => {
        calls++;
        return { token: `T${calls}`, expiresOnTimestamp: Date.now() + 3600_000 } as AccessToken;
      },
    };
    const c = cloneSafeCredential(inner);
    const [a, b] = await Promise.all([c.getToken('https://database.windows.net/.default'), c.getToken('https://database.windows.net/.default')]);
    const d = await c.getToken('https://database.windows.net/.default');
    assert.equal(calls, 1);
    assert.equal(a?.token, 'T1');
    assert.equal(b?.token, 'T1');
    assert.equal(d?.token, 'T1');
  });

  it('credential cache is invalidated when auth settings change', () => {
    const seen: EntraAuthOptions[] = [];
    const cache = new CredentialCache(tripwireFactory(seen));
    cache.get('p1', { mode: 'entra-cli' });
    cache.get('p1', { mode: 'entra-cli' });
    cache.get('p1', { mode: 'entra-cli', tenantId: 't2' });
    cache.delete('p1');
    cache.get('p1', { mode: 'entra-cli', tenantId: 't2' });
    assert.equal(seen.length, 3);
  });
});

describe('entra: connect to the local Docker server with a FAKE credential', async () => {
  const reason = await dockerUnavailableReason();
  for (const mode of MODES) {
    it(`${mode}: fails with a login/auth error, not a TypeError`, { skip: reason ?? false, timeout: 60_000 }, async () => {
      const calls: string[] = [];
      const fake = (): TokenCredential => ({
        getToken: async (scopes) => {
          calls.push(([] as string[]).concat(scopes).join(' '));
          return { token: 'fake-token-not-a-jwt', expiresOnTimestamp: Date.now() + 3600_000 };
        },
      });
      const pools = new PoolManager(new CredentialCache(fake));
      let err: unknown = null;
      try {
        await pools.get(profile(mode), 'target');
      } catch (e) {
        err = e;
      } finally {
        await pools.closeAll();
      }
      assert.ok(err, 'connect must fail: local SQL Server has no Entra');
      const e = err as Error & { code?: string; originalError?: Error };
      const msg = `${e.name}: ${e.message} ${e.originalError?.message ?? ''}`;
      assert.doesNotMatch(msg, /token credential class/);
      assert.notEqual(e.name, 'TypeError');
      // observed: ELOGIN "Login failed for user ''" — local SQL Server never asks for a federated token,
      // so tedious does not call getToken; the token round-trip itself can only be verified against Azure.
      assert.equal(e.code, 'ELOGIN', `unexpected error code ${e.code}: ${msg}`);
      console.log(`    [${mode}] connect error: code=${e.code} ${e.message} (fake getToken calls: ${calls.length}${calls.length ? `, scope ${calls[0]}` : ''})`);
    });
  }
});
