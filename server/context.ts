import type { AiClientFactory } from './ai/client';
import { AiConfigStore } from './ai/config';
import { AiService } from './ai/service';
import { resolveDataPaths, ensurePrivateDir, type DataPaths } from './config/paths';
import { loadSettings, type Settings } from './config/settings';
import { ConnectionStore } from './connections/store';
import { CredentialCache, type CredentialFactory } from './db/credentials';
import { PoolManager } from './db/pools';
import { RefreshManager } from './refresh/orchestrator';
import { CacheManager } from './store/cacheManager';

/** Everything the API needs, wired once per process (tests build one per temp data dir). */
export interface AppContext {
  paths: DataPaths;
  settings: Settings;
  connections: ConnectionStore;
  pools: PoolManager;
  caches: CacheManager;
  refresh: RefreshManager;
  ai: AiService;
  close(): Promise<void>;
}

export interface ContextOptions {
  dataDir?: string;
  /** tests inject a fake credential factory so no real Azure credential is ever constructed or called */
  credentialFactory?: CredentialFactory;
  /** tests inject a fake Anthropic client so no real API call is ever made */
  aiClientFactory?: AiClientFactory;
  /** environment for the AI settings (ANTHROPIC_API_KEY, DB_AUDIT_AI); default process.env */
  aiEnv?: NodeJS.ProcessEnv;
}

export function createContext(opts: ContextOptions = {}): AppContext {
  const paths = resolveDataPaths(opts.dataDir);
  ensurePrivateDir(paths.dataDir);
  ensurePrivateDir(paths.cacheDir);
  const settings = loadSettings(paths.settingsFile);
  const connections = new ConnectionStore(paths.connectionsFile);
  const pools = new PoolManager(new CredentialCache(opts.credentialFactory), settings.requestTimeoutMs);
  const caches = new CacheManager(paths.cacheDir);
  const refresh = new RefreshManager({ connections, pools, caches, settings });
  const ai = new AiService(new AiConfigStore(paths.settingsFile, opts.aiEnv), opts.aiClientFactory);
  return {
    paths,
    settings,
    connections,
    pools,
    caches,
    refresh,
    ai,
    async close() {
      await refresh.waitAll();
      await pools.closeAll();
      caches.closeAll();
    },
  };
}
