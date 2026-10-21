import fs from 'node:fs';
import { writeFileAtomicPrivate } from './paths';

/** Tunables persisted in data/settings.json. Missing keys fall back to these defaults. */
export interface Settings {
  /** max concurrent per-module sys.dm_sql_referenced_entities calls (capped at 4) */
  dependencyConcurrency: number;
  /** SET LOCK_TIMEOUT for every extraction batch, in ms */
  lockTimeoutMs: number;
  /** request timeout for extraction queries, in ms (also the hard wall-clock limit per query) */
  requestTimeoutMs: number;
  /** wall-clock limit for the bulk sys.sql_expression_dependencies query, in ms */
  bulkQueryTimeoutMs: number;
  /** wall-clock limit for a whole refresh run, in ms; the run is aborted when exceeded */
  refreshTimeoutMs: number;
  /** most recent job_executions rows kept per job */
  executionsPerJob: number;
  /** node cap for GET /graph */
  graphNodeCap: number;
}

export const DEFAULT_SETTINGS: Settings = {
  dependencyConcurrency: 4,
  lockTimeoutMs: 30_000,
  requestTimeoutMs: 120_000,
  bulkQueryTimeoutMs: 300_000,
  refreshTimeoutMs: 3_600_000,
  executionsPerJob: 200,
  graphNodeCap: 2000,
};

export function loadSettings(file: string): Settings {
  let stored: Partial<Settings> = {};
  if (fs.existsSync(file)) {
    try {
      stored = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<Settings>;
    } catch {
      stored = {};
    }
  } else {
    writeFileAtomicPrivate(file, JSON.stringify(DEFAULT_SETTINGS, null, 2) + '\n');
  }
  const merged: Settings = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof Settings>) {
    const v = stored[key];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) merged[key] = v;
  }
  merged.dependencyConcurrency = Math.min(4, Math.max(1, Math.floor(merged.dependencyConcurrency)));
  return merged;
}
