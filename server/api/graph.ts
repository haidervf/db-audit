import type { Graph, GraphEdge, GraphNode, GraphNodeKind, ObjectRef, ResolvedRef, TableDetails, TriggerDetails } from '../../shared/types';
import { DATABASE_SCOPE_SCHEMA } from '../../shared/types';
import { READ_OPS, WRITE_OPS } from '../analysis/refs';
import { jobNodeId, jobStepNodeId, objectNodeId, type ReadModel, type ResolvedDependency } from './readModel';

export interface GraphOptions {
  focus?: string;
  depth: number;
  kinds?: ReadonlySet<GraphNodeKind>;
  cap: number;
}

export class GraphFocusNotFound extends Error {}

export interface FullGraph {
  nodes: Map<string, GraphNode>;
  edges: Map<string, GraphEdge>;
}

/**
 * Builds the whole-database graph from the cache (via rm.fullGraph(), once per ReadModel), then optionally
 * cuts it down:
 *  - `kinds` keeps only nodes of those kinds (the focus node is always kept);
 *  - `focus` + `depth`: breadth-first over edges in both directions, up to `depth` hops;
 *  - at most `cap` nodes (focus: closest first; no focus: highest degree first) -> truncated.
 */
export function buildGraph(rm: ReadModel, opts: GraphOptions): Graph {
  const g = rm.fullGraph();
  return cut(g.nodes, g.edges, opts);
}

/**
 * The merged graph. Edges come from server dependencies (origin 'server'), FK metadata, trigger parents and
 * job steps, plus static-analysis edges (origin 'static'): module -> table/view 'reads' (SELECT) / 'writes'
 * (INSERT/UPDATE/DELETE/MERGE/SELECT_INTO/TRUNCATE/INSERT_EXEC), module -> procedure 'calls', module ->
 * function 'references'; job step -> procedure 'calls' and job step -> table 'reads'/'writes'. Static refs to
 * other databases / linked servers point at the same `external:` nodes the server dependencies use. One edge
 * per (source, target, relation): the same edge from both origins has origin ['server', 'static']. `ops` only
 * holds the analyzer's TableOp names (static); a server dependency row maps to 'writes' (is_updated), else
 * 'reads' (is_selected), both with no ops, else 'calls' (procedure -> procedure) or 'references'. A server
 * 'references' edge to a target that also has a static reads / writes / calls edge is folded into those
 * edges (they get origin 'server'), so the pair is not listed twice.
 * Server noise that the analysis explains is dropped: unresolved, unqualified targets whose name is an alias
 * in the module's analysis (`DELETE t FROM dbo.X AS t` -> `unknown:t`), and targets that are temp tables.
 */
export function buildFullGraph(rm: ReadModel): FullGraph {
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  const analyses = rm.analyses();

  const addNode = (n: GraphNode): GraphNode => {
    const existing = nodes.get(n.id);
    if (existing) return existing;
    nodes.set(n.id, n);
    return n;
  };
  const addEdge = (e: Omit<GraphEdge, 'id'>): void => {
    const id = `${e.source}->${e.target}:${e.relation}`;
    const existing = edges.get(id);
    if (existing) {
      for (const o of e.origin) if (!existing.origin.includes(o)) existing.origin.push(o);
      if (e.ops?.length) {
        const ops = existing.ops ?? [];
        for (const op of e.ops) if (!ops.includes(op)) ops.push(op);
        existing.ops = ops;
      }
      return;
    }
    edges.set(id, { id, ...e, ops: e.ops ? [...e.ops] : undefined, origin: [...e.origin] });
  };

  for (const o of rm.objects) {
    const ddl = o.schema === DATABASE_SCOPE_SCHEMA;
    const id = objectNodeId(o.kind, o.schema, o.name);
    const flags = o.kind === 'procedure' || o.kind === 'function' ? analyses.get(id)?.flags : undefined;
    addNode({
      id,
      kind: o.kind,
      label: ddl ? o.name : `${o.schema}.${o.name}`,
      schema: o.schema,
      name: o.name,
      meta: {
        typeCode: o.typeCode,
        hasDefinition: o.hasDefinition,
        isEncrypted: o.isEncrypted,
        ...(o.kind === 'table' ? { rowCount: o.rowCount } : {}),
        ...(o.kind === 'procedure' || o.kind === 'function' ? { hasDynamicSql: flags?.hasDynamicSql ?? false, hasCrossDb: flags?.hasCrossDb ?? false } : {}),
      },
    });
  }

  const targetNode = (d: ResolvedDependency): string => {
    const t = d.to;
    if (t.kind === 'external') {
      const id = `external:${[t.server, t.database, t.schema ?? '', t.name].filter((x) => x !== null).join('.')}`;
      addNode({ id, kind: 'external', label: [t.server, t.database, t.schema, t.name].filter(Boolean).join('.'), name: t.name, meta: { server: t.server, database: t.database, schema: t.schema } });
      return id;
    }
    if (t.resolved && t.kind !== 'unknown') {
      const id = objectNodeId(t.kind, t.schema, t.name);
      addNode({ id, kind: t.kind, label: `${t.schema}.${t.name}`, schema: t.schema ?? undefined, name: t.name, meta: { cached: false } });
      return id;
    }
    const id = `unknown:${t.schema ? `${t.schema}.` : ''}${t.name}`;
    addNode({
      id,
      kind: 'unknown',
      label: t.schema ? `${t.schema}.${t.name}` : t.name,
      schema: t.schema ?? undefined,
      name: t.name,
      meta: { resolved: t.resolved, typeCode: t.typeCode ?? null, resolution: t.resolution },
    });
    return id;
  };

  /** Server dependency rows that only exist because the server could not bind an alias / temp table. */
  const isNoise = (source: string, d: ResolvedDependency): boolean => {
    if (d.to.resolved || d.to.kind === 'external') return false;
    if (d.row.refName.startsWith('#')) return true;
    if (d.row.refSchema !== null) return false;
    const a = analyses.get(source);
    return Boolean(a && a.refs.aliases.includes(d.row.refName.toLowerCase()));
  };

  for (const d of rm.deps) {
    const source = objectNodeId(d.row.fromKind, d.row.fromSchema, d.row.fromName);
    if (!nodes.has(source)) continue;
    if (isNoise(source, d)) continue;
    const target = targetNode(d);
    const relation: GraphEdge['relation'] = d.row.isUpdated
      ? 'writes'
      : d.row.isSelected
        ? 'reads'
        : d.row.fromKind === 'procedure' && d.to.kind === 'procedure'
          ? 'calls'
          : 'references';
    addEdge({ source, target, relation, ops: relation === 'reads' || relation === 'writes' ? [] : undefined, origin: ['server'] });
  }

  for (const o of rm.objects) {
    const id = objectNodeId(o.kind, o.schema, o.name);
    if (o.kind === 'table') {
      for (const fk of (o.details as unknown as TableDetails).foreignKeys ?? []) {
        const target = objectNodeId('table', fk.references.schema, fk.references.name);
        addNode({ id: target, kind: 'table', label: `${fk.references.schema}.${fk.references.name}`, schema: fk.references.schema, name: fk.references.name, meta: { cached: false } });
        addEdge({ source: id, target, relation: 'fk', ops: [fk.name], origin: ['server'] });
      }
    } else if (o.kind === 'trigger') {
      const parent = (o.details as unknown as TriggerDetails).parent;
      if (parent) {
        const target = objectNodeId(parent.kind, parent.schema, parent.name);
        if (nodes.has(target)) addEdge({ source: id, target, relation: 'trigger-on', origin: ['server'] });
      }
    }
  }

  const lastRunOutcome = new Map(rm.jobSummaries().map((j) => [j.jobId, j.lastRunOutcome]));
  for (const j of rm.jobs()) {
    const jid = jobNodeId(j.jobId);
    const job = j.details;
    addNode({
      id: jid,
      kind: 'job',
      label: job.name,
      name: job.name,
      meta: {
        source: j.source,
        enabled: job.enabled,
        lastRunOutcome: lastRunOutcome.get(j.jobId) ?? null,
        scheduleText: job.scheduleText,
        targetsThisDb: job.steps.some((s) => rm.stepTargets(job, s).targetsThisDb),
      },
    });
    for (const st of job.steps) {
      const sid = jobStepNodeId(j.jobId, st.stepId);
      addNode({
        id: sid,
        kind: 'jobstep',
        label: `${job.name} #${st.stepId} ${st.name}`,
        name: st.name,
        meta: { jobId: j.jobId, stepId: st.stepId, subsystem: st.subsystem, databaseName: st.databaseName, analyzable: st.analyzable, targetsThisDb: rm.stepTargets(job, st).targetsThisDb },
      });
      addEdge({ source: jid, target: sid, relation: 'has-step', origin: ['server'] });
    }
  }

  /* ---------------------------------------------------------------- static-analysis edges */

  /** Target node of a resolved ref: a cached local object, or an external node (created on demand). */
  const staticTarget = (source: string, ref: ObjectRef, r: ResolvedRef | undefined): string | null => {
    if (!r || !r.nodeId) return null;
    if (nodes.has(r.nodeId)) return r.nodeId;
    if (r.kind !== 'external') return null;
    const scope = rm.scopeFor(source);
    const database = ref.database ?? (scope.type === 'other-database' ? scope.database : null);
    addNode({
      id: r.nodeId,
      kind: 'external',
      label: r.nodeId.slice('external:'.length),
      name: ref.name,
      meta: { server: ref.server, database, schema: ref.schema },
    });
    return r.nodeId;
  };

  for (const a of analyses.values()) {
    const source = a.targetKey;
    if (!nodes.has(source)) continue;
    const isStep = source.startsWith('jobstep:');
    const resolved = rm.resolvedFor(source, a.refs);
    for (const t of a.refs.tables) {
      const target = staticTarget(source, t.ref, resolved[t.ref.key]);
      if (!target || target === source) continue;
      const reads = t.ops.filter((o) => READ_OPS.has(o));
      const writes = t.ops.filter((o) => WRITE_OPS.has(o));
      if (reads.length) addEdge({ source, target, relation: 'reads', ops: reads, origin: ['static'] });
      if (writes.length) addEdge({ source, target, relation: 'writes', ops: writes, origin: ['static'] });
    }
    for (const ref of a.refs.procCalls) {
      const target = staticTarget(source, ref, resolved[ref.key]);
      if (target && target !== source) addEdge({ source, target, relation: 'calls', origin: ['static'] });
    }
    if (isStep) continue; // job steps: calls + reads/writes only
    for (const f of a.refs.functionCalls) {
      const target = staticTarget(source, f.ref, resolved[f.ref.key]);
      if (target && target !== source) addEdge({ source, target, relation: 'references', origin: ['static'] });
    }
  }

  /* ------------------------------------------- fold server 'references' into static reads / writes / calls */

  const byPair = new Map<string, GraphEdge[]>();
  for (const e of edges.values()) {
    const k = `${e.source}->${e.target}`;
    (byPair.get(k) ?? byPair.set(k, []).get(k)!).push(e);
  }
  for (const list of byPair.values()) {
    const ref = list.find((e) => e.relation === 'references' && e.origin.includes('server'));
    if (!ref) continue;
    const specific = list.filter((e) => (e.relation === 'reads' || e.relation === 'writes' || e.relation === 'calls') && e.origin.includes('static'));
    if (!specific.length) continue;
    for (const e of specific) if (!e.origin.includes('server')) e.origin.push('server');
    ref.origin = ref.origin.filter((o) => o !== 'server');
    if (!ref.origin.length) edges.delete(ref.id);
  }
  for (const e of edges.values()) e.origin.sort(); // ['server', 'static']

  return { nodes, edges };
}

function cut(allNodes: Map<string, GraphNode>, allEdges: Map<string, GraphEdge>, opts: GraphOptions): Graph {
  if (opts.focus && !allNodes.has(opts.focus)) throw new GraphFocusNotFound(`focus node ${opts.focus} not found`);
  const allowed = (id: string): boolean => !opts.kinds || id === opts.focus || opts.kinds.has(allNodes.get(id)!.kind);
  const adj = new Map<string, string[]>();
  for (const e of allEdges.values()) {
    if (!allowed(e.source) || !allowed(e.target)) continue;
    (adj.get(e.source) ?? adj.set(e.source, []).get(e.source)!).push(e.target);
    (adj.get(e.target) ?? adj.set(e.target, []).get(e.target)!).push(e.source);
  }

  let keep: string[];
  let truncated = false;
  if (opts.focus) {
    keep = [opts.focus];
    const seen = new Set(keep);
    let frontier = [opts.focus];
    for (let d = 0; d < opts.depth && frontier.length; d++) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const n of adj.get(id) ?? []) {
          if (seen.has(n)) continue;
          seen.add(n);
          next.push(n);
        }
      }
      next.sort();
      keep.push(...next);
      frontier = next;
    }
  } else {
    keep = [...allNodes.keys()].filter(allowed);
    keep.sort((a, b) => (adj.get(b)?.length ?? 0) - (adj.get(a)?.length ?? 0) || a.localeCompare(b));
  }
  if (keep.length > opts.cap) {
    keep = keep.slice(0, opts.cap);
    truncated = true;
  }
  const kept = new Set(keep);
  const nodes = keep.map((id) => allNodes.get(id)!);
  const edges = [...allEdges.values()].filter((e) => kept.has(e.source) && kept.has(e.target));
  return { nodes, edges, truncated };
}
