import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Project root (the directory that contains package.json). */
export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export interface DataPaths {
  dataDir: string;
  connectionsFile: string;
  settingsFile: string;
  cacheDir: string;
}

/**
 * Runtime data lives in <project>/data by default (gitignored). DB_AUDIT_DATA_DIR overrides it
 * (the tests point it at a throwaway directory under data/).
 */
export function resolveDataPaths(dataDir = process.env.DB_AUDIT_DATA_DIR || path.join(PROJECT_ROOT, 'data')): DataPaths {
  const dir = path.resolve(dataDir);
  return {
    dataDir: dir,
    connectionsFile: path.join(dir, 'connections.json'),
    settingsFile: path.join(dir, 'settings.json'),
    cacheDir: path.join(dir, 'cache'),
  };
}

/** Creates a directory (recursively) and forces mode 0700 on it. */
export function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

/** Atomically writes a file with mode 0600: write a temp file in the same directory, fsync, rename. */
export function writeFileAtomicPrivate(file: string, content: string): void {
  ensurePrivateDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

export const WEB_DIST_DIR = path.join(PROJECT_ROOT, 'web', 'dist');
