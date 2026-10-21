import fs from 'node:fs';
import path from 'node:path';
import { CacheStore } from './cacheStore';

/** Opens data/cache/<connectionId>.sqlite lazily and keeps it open for the life of the process. */
export class CacheManager {
  private readonly stores = new Map<string, CacheStore>();

  constructor(private readonly cacheDir: string) {}

  fileFor(connectionId: string): string {
    if (!/^[a-z0-9]+$/.test(connectionId)) throw new Error(`invalid connection id: ${connectionId}`);
    return path.join(this.cacheDir, `${connectionId}.sqlite`);
  }

  get(connectionId: string): CacheStore {
    let s = this.stores.get(connectionId);
    if (!s) {
      s = new CacheStore(this.fileFor(connectionId));
      this.stores.set(connectionId, s);
    }
    return s;
  }

  /** Closes and deletes the cache file (and its WAL/SHM side files). */
  remove(connectionId: string): void {
    const s = this.stores.get(connectionId);
    if (s) {
      s.close();
      this.stores.delete(connectionId);
    }
    const file = this.fileFor(connectionId);
    for (const f of [file, `${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true });
  }

  closeAll(): void {
    for (const s of this.stores.values()) s.close();
    this.stores.clear();
  }
}
