import type { AnalysisFlags, ModuleAnalysis, ObjectRef, TableOp } from '../../shared/types';

/**
 * The part of a ModuleAnalysis the resolver, the graph and the summaries need, stored next to the full
 * analysis (analysis.refs_json) so list / graph requests never parse whole analyses. System objects
 * (sys / INFORMATION_SCHEMA tables, sp_* / sys procedures) are already left out.
 */
export interface AnalysisRefs {
  tables: Array<{ ref: ObjectRef; ops: TableOp[]; aliases: string[] }>;
  procCalls: ObjectRef[];
  functionCalls: Array<{ ref: ObjectRef; kind: 'scalar' | 'table-valued' }>;
  sequences: ObjectRef[];
  crossDatabaseRefs: ObjectRef[];
  /** lower-cased aliases of every table / temp-table access (used to drop server alias noise like `unknown:t`) */
  aliases: string[];
}

/** Ops that change data (or the table) -> a 'writes' edge; SELECT alone -> 'reads'. */
export const WRITE_OPS: ReadonlySet<TableOp> = new Set<TableOp>(['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'SELECT_INTO', 'TRUNCATE', 'INSERT_EXEC']);
/** Ops that read. */
export const READ_OPS: ReadonlySet<TableOp> = new Set<TableOp>(['SELECT']);

const SYSTEM_SCHEMAS = new Set(['sys', 'information_schema']);

export function isSystemRef(ref: ObjectRef): boolean {
  return SYSTEM_SCHEMAS.has((ref.schema ?? '').toLowerCase());
}

function dedupe(refs: ObjectRef[]): ObjectRef[] {
  const seen = new Map<string, ObjectRef>();
  for (const r of refs) if (!seen.has(r.key)) seen.set(r.key, r);
  return [...seen.values()];
}

export function extractRefs(a: ModuleAnalysis): AnalysisRefs {
  const aliases = new Set<string>();
  for (const t of [...a.tables, ...a.tempTables]) for (const al of t.aliases) aliases.add(al.toLowerCase());
  return {
    tables: a.tables.filter((t) => !t.isSystem && !isSystemRef(t.ref)).map((t) => ({ ref: t.ref, ops: t.ops, aliases: t.aliases })),
    procCalls: dedupe(a.procCalls.filter((c) => !c.isSystem && !isSystemRef(c.ref)).map((c) => c.ref)),
    functionCalls: [...new Map(a.functionCalls.filter((f) => !isSystemRef(f.ref)).map((f) => [f.ref.key, { ref: f.ref, kind: f.kind }])).values()],
    sequences: dedupe(a.sequences.filter((q) => !isSystemRef(q.ref)).map((q) => q.ref)),
    crossDatabaseRefs: dedupe(a.crossDatabaseRefs.filter((r) => !isSystemRef(r))),
    aliases: [...aliases],
  };
}

/**
 * Summary flags. `targetDatabase` is the profile's target database: a 3-part name that names it
 * ([ThisDb].[dbo].[X]) is local, so it does not count as cross-database.
 */
export function computeFlags(a: ModuleAnalysis, refs: AnalysisRefs, targetDatabase: string): AnalysisFlags {
  const target = targetDatabase.toLowerCase();
  const isCross = (r: ObjectRef): boolean => r.server !== null || (r.database !== null && r.database.toLowerCase() !== target);
  return {
    hasDynamicSql: a.dynamicSql.length > 0,
    hasCrossDb: refs.crossDatabaseRefs.some(isCross) || a.linkedServerRefs.length > 0,
    readsTables: refs.tables.filter((t) => t.ops.some((o) => READ_OPS.has(o))).length,
    writesTables: refs.tables.filter((t) => t.ops.some((o) => WRITE_OPS.has(o))).length,
    callsProcs: refs.procCalls.length,
    warnings: a.warnings.length,
  };
}
