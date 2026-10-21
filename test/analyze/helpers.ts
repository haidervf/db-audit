// Shared helpers for the T-SQL analyzer tests.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ModuleAnalysis, OutlineNode, TableAccess } from '../../server/analyze/tsql/index';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURES = join(HERE, '..', 'fixtures', 'tsql');
export const PRIVATE_FIXTURES = join(HERE, '..', 'fixtures', 'private', 'tsql');
export const QUERY_FOLDER = process.env.DB_AUDIT_QUERY_FOLDER ?? '';

export function readFixture(rel: string): string {
  return readFileSync(join(FIXTURES, rel), 'utf8');
}

export function table(r: ModuleAnalysis, key: string): TableAccess | undefined {
  return r.tables.find(t => t.ref.key === key);
}

export function temp(r: ModuleAnalysis, key: string): TableAccess | undefined {
  return r.tempTables.find(t => t.ref.key === key);
}

/** Compact `key → ops` view used for exact table assertions. */
export function opsByKey(list: TableAccess[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const t of list) out[t.ref.key] = t.ops;
  return out;
}

export function flatten(nodes: OutlineNode[]): OutlineNode[] {
  const out: OutlineNode[] = [];
  const walk = (ns: OutlineNode[]): void => { for (const n of ns) { out.push(n); walk(n.children); } };
  walk(nodes);
  return out;
}

export function nodeAt(r: ModuleAnalysis, startLine: number, kind?: string): OutlineNode | undefined {
  return flatten(r.outline).find(n => n.startLine === startLine && (!kind || n.kind === kind));
}

export function listSqlFiles(root: string): string[] {
  const out: string[] = [];
  if (!existsSync(root)) return out;
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const p = join(dir, name);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p);
      else if (name.toLowerCase().endsWith('.sql')) out.push(p);
    }
  };
  walk(root);
  return out.sort();
}

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function internalErrors(r: ModuleAnalysis): string[] {
  return r.warnings.filter(w => w.message.startsWith('Analyzer internal error')).map(w => w.message);
}
