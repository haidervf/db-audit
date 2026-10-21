import type { ModuleSettings, ObjectKind, SegmentCounts } from '../../shared/types';
import { DATABASE_SCOPE_SCHEMA } from '../../shared/types';
import { analyzeModule, ANALYZER_VERSION } from '../analyze/tsql/index';
import type { AnalyzeOptions } from '../analyze/tsql/types';
import { sha256, type AnalysisUpsert, type CacheStore } from '../store/cacheStore';
import { computeFlags, extractRefs } from './refs';

/** Graph node ids (same as server/api/readModel.ts objectNodeId / jobStepNodeId). */
const moduleKey = (kind: ObjectKind, schema: string, name: string): string => `${kind}:${schema}.${name}`;
const stepKey = (jobId: string, stepId: number): string => `jobstep:${jobId}#${stepId}`;

const MODULE_KINDS: ObjectKind[] = ['procedure', 'view', 'function', 'trigger'];

/** One text the analyzer should look at: a module definition or an analyzable job step command. */
export interface AnalysisTarget {
  key: string;
  text: string;
  sha: string;
  opts: AnalyzeOptions;
}

/** Everything in the cache that can be analysed. Reads the cache only (no database connection). */
export function analysisTargets(store: CacheStore): AnalysisTarget[] {
  const out: AnalysisTarget[] = [];
  for (const kind of MODULE_KINDS) {
    for (const o of store.listObjects(kind, true)) {
      if (o.definition === null) continue; // encrypted / no VIEW DEFINITION / CLR
      const module = (o.details as { module?: ModuleSettings }).module;
      out.push({
        key: moduleKey(o.kind, o.schema, o.name),
        text: o.definition,
        sha: o.definitionSha256 ?? sha256(o.definition),
        opts: {
          // uses_quoted_identifier is recorded per module; unknown (null) keeps the analyzer default (ON)
          quotedIdentifier: module?.usesQuotedIdentifier !== false,
          defaultSchema: o.schema === DATABASE_SCOPE_SCHEMA ? 'dbo' : o.schema,
        },
      });
    }
  }
  for (const j of store.listJobs()) {
    for (const st of j.details.steps) {
      // Agent subsystem TSQL / Elastic Jobs command type TSql (A1 sets `analyzable` for exactly these)
      if (!st.analyzable) continue;
      out.push({ key: stepKey(j.jobId, st.stepId), text: st.command, sha: sha256(st.command), opts: {} });
    }
  }
  return out;
}

/**
 * Analyses every target whose (definition sha256, analyzer version) differs from the stored row (or all of
 * them when `force`), deletes rows of objects / steps that no longer exist, and writes everything in ONE
 * transaction. Pure CPU + SQLite: never opens a database connection.
 * Counts: added = no previous row; updated = sha or analyzer version changed; unchanged = same inputs
 * (also when re-analysed because of `force`); removed = rows deleted.
 */
export function runAnalysis(store: CacheStore, targetDatabase: string, opts: { force: boolean; onProgress?: (done: number, total: number) => void }): SegmentCounts {
  const counts: SegmentCounts = { added: 0, updated: 0, removed: 0, unchanged: 0 };
  const states = store.analysisStates();
  const targets = analysisTargets(store);
  const upserts: AnalysisUpsert[] = [];
  const todo = targets.filter((t) => {
    const st = states.get(t.key);
    const changed = !st || st.analyzerVersion !== ANALYZER_VERSION || st.definitionSha256 !== t.sha;
    if (!st) counts.added++;
    else if (changed) counts.updated++;
    else counts.unchanged++;
    return changed || opts.force;
  });
  let done = 0;
  for (const t of todo) {
    const analysis = analyzeModule(t.text, t.opts);
    const refs = extractRefs(analysis);
    upserts.push({ targetKey: t.key, definitionSha256: t.sha, analysis, refs, flags: computeFlags(analysis, refs, targetDatabase) });
    opts.onProgress?.(++done, todo.length);
  }
  const keep = new Set(targets.map((t) => t.key));
  const removed = [...states.keys()].filter((k) => !keep.has(k));
  counts.removed = removed.length;
  store.applyAnalysis(upserts, removed);
  return counts;
}
