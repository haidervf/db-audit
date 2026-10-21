import type { GraphEdge, GraphNodeKind, ObjectKind } from '../api/types';

export const OBJECT_KINDS: readonly ObjectKind[] = ['procedure', 'table', 'view', 'function', 'trigger'];
export const DATABASE_SCOPE_SCHEMA = '(database)';

export interface KindMeta {
  label: string;
  plural: string;
  /** URL segment under /c/:connId */
  segment: string;
  /** short glyph shown in badges and graph nodes */
  glyph: string;
}

export const KIND_META: Record<GraphNodeKind, KindMeta> = {
  procedure: { label: 'Procedure', plural: 'Procedures', segment: 'procedures', glyph: 'P' },
  table: { label: 'Table', plural: 'Tables', segment: 'tables', glyph: 'T' },
  view: { label: 'View', plural: 'Views', segment: 'views', glyph: 'V' },
  function: { label: 'Function', plural: 'Functions', segment: 'functions', glyph: 'ƒ' },
  trigger: { label: 'Trigger', plural: 'Triggers', segment: 'triggers', glyph: 'TR' },
  job: { label: 'Job', plural: 'Jobs', segment: 'jobs', glyph: 'J' },
  jobstep: { label: 'Job step', plural: 'Job steps', segment: 'jobs', glyph: 'S' },
  external: { label: 'External', plural: 'External', segment: '', glyph: '↗' },
  unknown: { label: 'Unknown', plural: 'Unknown', segment: '', glyph: '?' },
};

export const ALL_GRAPH_KINDS: readonly GraphNodeKind[] = ['procedure', 'table', 'view', 'function', 'trigger', 'job', 'jobstep', 'external', 'unknown'];

export const RELATIONS: ReadonlyArray<GraphEdge['relation']> = ['reads', 'writes', 'calls', 'references', 'fk', 'has-step', 'trigger-on'];

export const RELATION_LABEL: Record<GraphEdge['relation'], string> = {
  reads: 'Reads',
  writes: 'Writes',
  calls: 'Calls',
  references: 'References',
  fk: 'Foreign key',
  'has-step': 'Has step',
  'trigger-on': 'Trigger on',
};

export function kindFromSegment(seg: string | undefined): ObjectKind | null {
  for (const k of OBJECT_KINDS) if (KIND_META[k].segment === seg) return k;
  return null;
}

export function objectPath(connId: string, kind: ObjectKind, schema: string, name: string): string {
  return `/c/${encodeURIComponent(connId)}/${KIND_META[kind].segment}/${encodeURIComponent(schema)}/${encodeURIComponent(name)}`;
}

export function jobPath(connId: string, jobId: string, stepId?: number): string {
  return `/c/${encodeURIComponent(connId)}/jobs/${encodeURIComponent(jobId)}${stepId !== undefined ? `?step=${stepId}` : ''}`;
}

export function objectNodeId(kind: string, schema: string | null, name: string): string {
  return `${kind}:${schema ? `${schema}.` : ''}${name}`;
}

export interface ParsedNodeId {
  kind: GraphNodeKind;
  schema?: string;
  name?: string;
  jobId?: string;
  stepId?: number;
}

/** Parses graph node ids: `procedure:dbo.Name`, `job:<id>`, `jobstep:<id>#<n>`, `external:…`, `unknown:…`. */
export function parseNodeId(id: string): ParsedNodeId | null {
  const i = id.indexOf(':');
  if (i < 0) return null;
  const kind = id.slice(0, i) as GraphNodeKind;
  const rest = id.slice(i + 1);
  if (!(kind in KIND_META)) return null;
  if (kind === 'job') return { kind, jobId: rest };
  if (kind === 'jobstep') {
    const h = rest.lastIndexOf('#');
    return h < 0 ? { kind, jobId: rest } : { kind, jobId: rest.slice(0, h), stepId: Number(rest.slice(h + 1)) };
  }
  if (kind === 'external' || kind === 'unknown') return { kind, name: rest };
  if (rest.startsWith(`${DATABASE_SCOPE_SCHEMA}.`)) return { kind, schema: DATABASE_SCOPE_SCHEMA, name: rest.slice(DATABASE_SCOPE_SCHEMA.length + 1) };
  const dot = rest.indexOf('.');
  return dot < 0 ? { kind, name: rest } : { kind, schema: rest.slice(0, dot), name: rest.slice(dot + 1) };
}

/** UI route for a graph node id, or null when the node has no page (external / unknown). */
export function nodeRoute(connId: string, id: string, node?: { kind: GraphNodeKind; schema?: string; name: string; meta?: Record<string, unknown> }): string | null {
  const p = parseNodeId(id);
  if (!p) return null;
  if (p.kind === 'job' && p.jobId) return jobPath(connId, p.jobId);
  if (p.kind === 'jobstep' && p.jobId) return jobPath(connId, p.jobId, p.stepId);
  if (p.kind === 'external' || p.kind === 'unknown') return null;
  const schema = node?.schema ?? p.schema;
  const name = node?.name ?? p.name;
  if (!schema || !name) return null;
  return objectPath(connId, p.kind as ObjectKind, schema, name);
}

export const OP_CLASS: Record<string, string> = {
  SELECT: 'select',
  INSERT: 'insert',
  INSERT_EXEC: 'insert',
  UPDATE: 'update',
  DELETE: 'delete',
  MERGE: 'merge',
  TRUNCATE: 'truncate',
  SELECT_INTO: 'selectinto',
  EXEC: 'exec',
  CALLS: 'exec',
  CREATE: 'ddl',
  DROP: 'ddl',
  ALTER: 'ddl',
};

export const WRITE_OPS = new Set(['INSERT', 'INSERT_EXEC', 'UPDATE', 'DELETE', 'MERGE', 'TRUNCATE', 'SELECT_INTO', 'CREATE', 'DROP', 'ALTER']);

export function opLabel(op: string): string {
  const u = op.toUpperCase();
  if (u === 'SELECT_INTO') return 'SELECT INTO';
  if (u === 'INSERT_EXEC') return 'INSERT EXEC';
  return u;
}

/**
 * Edge ops are the analyzer's statement names (INSERT, UPDATE, …), upper-cased and de-duplicated. Edges only
 * reported by SQL Server dependencies have no ops; their relation (reads / writes) carries the meaning.
 */
export function displayOps(ops: readonly string[]): string[] {
  return [...new Set(ops.map((o) => o.toUpperCase()))];
}
