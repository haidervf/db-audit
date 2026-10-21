import { AzureCliCredential, DefaultAzureCredential, InteractiveBrowserCredential } from '@azure/identity';
import type { AccessToken, GetTokenOptions, TokenCredential } from '@azure/identity';
import type { AuthMode } from '../../shared/types';

export type EntraMode = Exclude<AuthMode, 'sql'>;

export interface EntraAuthOptions {
  mode: EntraMode;
  tenantId?: string;
  clientId?: string;
}

/**
 * Plain-object TokenCredential that caches tokens per scope until `skewMs` before expiry and
 * de-duplicates concurrent requests (research §3). Two reasons to wrap:
 *  - it survives any config deep-clone (an own `getToken` function property passes isTokenCredential);
 *  - AzureCliCredential shells out to `az` on every call and has no cache of its own.
 * tedious calls getToken on every new physical connection and derives the scope from the server.
 */
export function cloneSafeCredential(inner: TokenCredential, skewMs = 5 * 60 * 1000): TokenCredential {
  const cache = new Map<string, AccessToken>();
  const inflight = new Map<string, Promise<AccessToken | null>>();
  return {
    getToken(scopes: string | string[], options?: GetTokenOptions): Promise<AccessToken | null> {
      const key = ([] as string[]).concat(scopes).join(' ');
      const hit = cache.get(key);
      if (hit && hit.expiresOnTimestamp - skewMs > Date.now()) return Promise.resolve(hit);
      let p = inflight.get(key);
      if (!p) {
        p = Promise.resolve(inner.getToken(scopes, options))
          .then((t) => {
            if (t) cache.set(key, t);
            return t;
          })
          .finally(() => inflight.delete(key));
        inflight.set(key, p);
      }
      return p;
    },
  };
}

/** Constructs (does not call) the @azure/identity credential for an Entra mode. */
export function createIdentityCredential(opts: EntraAuthOptions): TokenCredential {
  const tenantId = opts.tenantId || undefined;
  const clientId = opts.clientId || undefined;
  switch (opts.mode) {
    case 'entra-cli':
      return new AzureCliCredential({ tenantId });
    case 'entra-interactive':
      // No clientId -> @azure/identity uses its default public client (the Azure CLI app id).
      return new InteractiveBrowserCredential(clientId ? { tenantId, clientId } : { tenantId });
    case 'entra-default':
      return new DefaultAzureCredential(clientId ? { tenantId, managedIdentityClientId: clientId } : { tenantId });
  }
}

export type CredentialFactory = (opts: EntraAuthOptions) => TokenCredential;

/**
 * One wrapped credential per connection profile, kept for the life of the server process so an
 * interactive login happens once. Invalidated when the profile's auth settings change or it is deleted.
 */
export class CredentialCache {
  private readonly entries = new Map<string, { signature: string; credential: TokenCredential }>();

  constructor(private readonly factory: CredentialFactory = createIdentityCredential) {}

  get(profileId: string, opts: EntraAuthOptions): TokenCredential {
    const signature = JSON.stringify([opts.mode, opts.tenantId ?? '', opts.clientId ?? '']);
    const hit = this.entries.get(profileId);
    if (hit && hit.signature === signature) return hit.credential;
    const credential = cloneSafeCredential(this.factory(opts));
    this.entries.set(profileId, { signature, credential });
    return credential;
  }

  delete(profileId: string): void {
    this.entries.delete(profileId);
  }
}
