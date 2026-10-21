import type {
  AnalysisPayload,
  Dependency,
  DependencyRef,
  GraphEdge,
  JobDetail,
  JobExecution,
  JobStep,
  JobSummary,
  ObjectDetail,
  ObjectKind,
  ObjectSummary,
  ResolvedRef,
  TableDetails,
  UsageEdge,
} from '../../shared/types';
import { DATABASE_SCOPE_SCHEMA } from '../../shared/types';
import { jobDescribeSha, toAiDescription } from '../ai/hash';
import { extractRefs, type AnalysisRefs } from '../analysis/refs';
import { Resolver, type ResolveScope, type SynonymInfo } from '../analysis/resolver';
import type { StoredConnection } from '../connections/store';
import type { ExtractedExecution, ExtractedJob, ExtractedJobStep } from '../extract/jobTypes';
import { nextElasticRun } from '../extract/schedule';
import { evaluateTargets } from '../extract/targets';
import type { CacheStore, CachedDependencyRow, CachedJobRow, CachedObjectRow, StoredAnalysisRefs } from '../store/cacheStore';
import { buildFullGraph, type FullGraph } from './graph';

/** Graph / analysis key of an object: `procedure:dbo.Name` (DDL triggers: `trigger:(database).Name`). */
export function objectNodeId(kind: string, schema: string | null, name: string): string {
  return `${kind}:${schema ? `${schema}.` : ''}${name}`;
}
export const jobNodeId = (jobId: string): string => `job:${jobId}`;
export const jobStepNodeId = (jobId: string, stepId: number): string => `jobstep:${jobId}#${stepId}`;

const objKey = (kind: string, schema: string, name: string): string => `${kind}:${schema}.${name}`.toLowerCase();

export interface ResolvedDependency {
  row: CachedDependencyRow;
  to: DependencyRef;
  /** objKey of the target when it is a local object we can identify */
  toKey: string | null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Read-side view over one connection's cache: dependency resolution (server-bound or by name against
 * cached objects), static-analysis resolution (refs -> cached objects / external nodes, at read time so a
 * later refresh of the referenced objects is reflected without re-analysing), the merged graph, object
 * summaries/details and job summaries/details. Built per request.
 */
export class ReadModel {
  readonly objects: CachedObjectRow[];
  private readonly byName = new Map<string, CachedObjectRow>();
  private readonly byKey = new Map<string, CachedObjectRow>();
  readonly deps: ResolvedDependency[];
  private readonly outgoing = new Map<string, ResolvedDependency[]>();
  private readonly incoming = new Map<string, ResolvedDependency[]>();
  private jobsCache: CachedJobRow[] | null = null;
  private analysisCache: Map<string, StoredAnalysisRefs> | null = null;
  private resolverCache: Resolver | null = null;
  private graphCache: FullGraph | null = null;
  private stepIndex: Map<string, { job: CachedJobRow; step: ExtractedJobStep }> | null = null;

  constructor(
    readonly store: CacheStore,
    readonly conn: StoredConnection,
  ) {
    this.objects = store.listObjects();
    for (const o of this.objects) {
      this.byKey.set(objKey(o.kind, o.schema, o.name), o);
      if (o.schema !== DATABASE_SCOPE_SCHEMA) this.byName.set(`${o.schema}.${o.name}`.toLowerCase(), o);
    }
    this.deps = store.allDependencies().map((row) => this.resolve(row));
    for (const d of this.deps) {
      const from = objKey(d.row.fromKind, d.row.fromSchema, d.row.fromName);
      (this.outgoing.get(from) ?? this.outgoing.set(from, []).get(from)!).push(d);
      if (d.toKey && d.toKey !== from) (this.incoming.get(d.toKey) ?? this.incoming.set(d.toKey, []).get(d.toKey)!).push(d);
    }
  }

  private resolve(row: CachedDependencyRow): ResolvedDependency {
    const base = { server: row.refServer, database: row.refDatabase, schema: row.refSchema, name: row.refName, typeCode: row.refTypeCode };
    if (row.refServer || row.refDatabase) {
      return { row, to: { ...base, kind: 'external', resolved: false, resolution: 'unresolved' }, toKey: null };
    }
    if (row.refResolved) {
      const kind = row.refKind;
      const toKey = kind !== 'unknown' && kind !== 'external' && row.refSchema ? objKey(kind, row.refSchema, row.refName) : null;
      return { row, to: { ...base, kind, resolved: true, resolution: 'server' }, toKey };
    }
    // Not bound by the server (deferred name resolution, caller-dependent): match by name; unqualified -> dbo.
    const hit = this.byName.get(`${row.refSchema ?? 'dbo'}.${row.refName}`.toLowerCase());
    if (hit) {
      return {
        row,
        to: { ...base, schema: hit.schema, name: hit.name, kind: hit.kind, resolved: true, resolution: 'name-match', typeCode: hit.typeCode },
        toKey: objKey(hit.kind, hit.schema, hit.name),
      };
    }
    return { row, to: { ...base, kind: 'unknown', resolved: false, resolution: 'unresolved' }, toKey: null };
  }

  toDependency(d: ResolvedDependency): Dependency {
    return {
      from: { kind: d.row.fromKind, schema: d.row.fromSchema, name: d.row.fromName },
      to: d.to,
      isSelected: d.row.isSelected,
      isUpdated: d.row.isUpdated,
      isAmbiguous: d.row.isAmbiguous,
      source: d.row.source,
      isCallerDependent: d.row.isCallerDependent,
      isIncomplete: d.row.isIncomplete,
      columns: d.row.columns,
    };
  }

  referencesOf(kind: ObjectKind, schema: string, name: string): ResolvedDependency[] {
    return this.outgoing.get(objKey(kind, schema, name)) ?? [];
  }

  referencedBy(kind: ObjectKind, schema: string, name: string): ResolvedDependency[] {
    return this.incoming.get(objKey(kind, schema, name)) ?? [];
  }

  findObject(kind: string, schema: string | null, name: string): CachedObjectRow | undefined {
    return this.byKey.get(objKey(kind, schema ?? '', name));
  }

  /* ------------------------------------------------------------------ static analysis */

  /** Compact refs + flags of every analysed object / job step, by target key (graph node id). */
  analyses(): Map<string, StoredAnalysisRefs> {
    if (!this.analysisCache) this.analysisCache = new Map(this.store.listAnalysisRefs().map((a) => [a.targetKey, a]));
    return this.analysisCache;
  }

  resolver(): Resolver {
    this.resolverCache ??= new Resolver(this.objects, this.store.getMeta<SynonymInfo[]>('synonyms') ?? [], this.conn.target.database);
    return this.resolverCache;
  }

  private steps(): Map<string, { job: CachedJobRow; step: ExtractedJobStep }> {
    if (!this.stepIndex) {
      this.stepIndex = new Map();
      for (const j of this.jobs()) for (const st of j.details.steps) this.stepIndex.set(jobStepNodeId(j.jobId, st.stepId), { job: j, step: st });
    }
    return this.stepIndex;
  }

  /**
   * How refs of an analysed text resolve. Modules: local, unqualified names in the module's schema first.
   * Agent steps: local only when the step runs in the target database, else external to the step's database.
   * Elastic steps: local only when the step targets this database.
   */
  scopeFor(targetKey: string): ResolveScope {
    if (targetKey.startsWith('jobstep:')) {
      const hit = this.steps().get(targetKey);
      if (!hit) return { type: 'not-this-db' };
      const { job, step } = hit;
      if (this.stepTargets(job.details, step).targetsThisDb) return { type: 'local', moduleSchema: 'dbo' };
      if (job.source === 'agent' && step.databaseName) return { type: 'other-database', database: step.databaseName };
      return { type: 'not-this-db' };
    }
    const colon = targetKey.indexOf(':');
    const rest = targetKey.slice(colon + 1);
    const schema = rest.startsWith(`${DATABASE_SCOPE_SCHEMA}.`) ? 'dbo' : rest.slice(0, rest.indexOf('.'));
    return { type: 'local', moduleSchema: schema || 'dbo' };
  }

  resolvedFor(targetKey: string, refs: AnalysisRefs): Record<string, ResolvedRef> {
    return this.resolver().resolveAll(refs, this.scopeFor(targetKey));
  }

  /** Full analysis of one key + its resolution, as served by the API. */
  analysisPayload(targetKey: string): AnalysisPayload | null {
    const row = this.store.getAnalysis(targetKey);
    if (!row) return null;
    const refs = this.analyses().get(targetKey)?.refs ?? extractRefs(row.analysis);
    return { ...row.analysis, resolved: this.resolvedFor(targetKey, refs), analyzedAt: row.analyzedAt, definitionSha256: row.definitionSha256 ?? '' };
  }

  /** The merged graph (server dependencies + static analysis), built once per ReadModel. */
  fullGraph(): FullGraph {
    this.graphCache ??= buildFullGraph(this);
    return this.graphCache;
  }

  /** 1-hop edges of a node in the merged graph. */
  usage(nodeId: string): { uses: UsageEdge[]; usedBy: UsageEdge[] } {
    const g = this.fullGraph();
    const uses: UsageEdge[] = [];
    const usedBy: UsageEdge[] = [];
    const toUsage = (e: GraphEdge, other: string, direction: UsageEdge['direction']): UsageEdge => {
      const n = g.nodes.get(other);
      return { nodeId: other, kind: n?.kind ?? 'unknown', label: n?.label ?? other, relation: e.relation, ops: [...(e.ops ?? [])], origin: [...e.origin], direction };
    };
    for (const e of g.edges.values()) {
      if (e.source === nodeId) uses.push(toUsage(e, e.target, 'out'));
      else if (e.target === nodeId) usedBy.push(toUsage(e, e.source, 'in'));
    }
    return { uses, usedBy };
  }

  /* ------------------------------------------------------------------ objects */

  summary(o: CachedObjectRow): ObjectSummary {
    const s: ObjectSummary = {
      kind: o.kind,
      schema: o.schema,
      name: o.name,
      createDate: o.createDate,
      modifyDate: o.modifyDate,
      hasDefinition: o.hasDefinition,
      isEncrypted: o.isEncrypted,
      referencesCount: this.referencesOf(o.kind, o.schema, o.name).length,
      referencedByCount: this.referencedBy(o.kind, o.schema, o.name).length,
      typeCode: o.typeCode ?? undefined,
      analysisFlags: this.analyses().get(objectNodeId(o.kind, o.schema, o.name))?.flags ?? null,
    };
    if (o.kind === 'table') s.rowCount = o.rowCount;
    return s;
  }

  summaries(kind?: ObjectKind, q?: string): ObjectSummary[] {
    const needle = q?.trim().toLowerCase();
    return this.objects
      .filter((o) => (!kind || o.kind === kind) && (!needle || `${o.schema}.${o.name}`.toLowerCase().includes(needle)))
      .map((o) => this.summary(o));
  }

  detail(kind: ObjectKind, schema: string, name: string): ObjectDetail | null {
    const o = this.store.getObject(kind, schema, name);
    if (!o) return null;
    const details = { ...o.details };
    if (kind === 'table') {
      const incoming: NonNullable<TableDetails['referencedByForeignKeys']> = [];
      for (const t of this.objects) {
        if (t.kind !== 'table') continue;
        for (const fk of ((t.details as unknown as TableDetails).foreignKeys ?? [])) {
          if (fk.references.schema.toLowerCase() === o.schema.toLowerCase() && fk.references.name.toLowerCase() === o.name.toLowerCase()) {
            incoming.push({ name: fk.name, from: { schema: t.schema, name: t.name }, columns: fk.columns });
          }
        }
      }
      (details as unknown as TableDetails).referencedByForeignKeys = incoming;
    }
    const key = objectNodeId(o.kind, o.schema, o.name);
    const ai = this.store.getAi(key);
    return {
      ...this.summary({ ...o, hasDefinition: o.definition !== null }),
      definition: o.definition,
      details,
      references: this.referencesOf(o.kind, o.schema, o.name).map((d) => this.toDependency(d)),
      referencedBy: this.referencedBy(o.kind, o.schema, o.name).map((d) => this.toDependency(d)),
      jobsUsing: this.jobsUsing(o),
      ...this.usage(key),
      analysis: this.analysisPayload(key),
      ai: ai ? toAiDescription(ai, o.definitionSha256) : null,
      definitionSha256: o.definitionSha256,
      fetchedAt: o.fetchedAt,
    };
  }

  /**
   * Job steps that use this object. Analyzable steps with an analysis: a ref of the step resolves to this
   * object (via 'analysis'). Non-analyzable steps (and analyzable steps not analysed yet): Phase A text match
   * of the schema-qualified (optionally bracketed) name, or bare name for dbo objects, over steps that
   * target this database (via 'text-match').
   */
  private jobsUsing(o: CachedObjectRow): ObjectDetail['jobsUsing'] {
    if (o.schema === DATABASE_SCOPE_SCHEMA) return [];
    const nodeId = objectNodeId(o.kind, o.schema, o.name);
    const name = `\\[?${escapeRe(o.name)}\\]?`;
    const qualified = new RegExp(`(?<![\\w#@$])\\[?${escapeRe(o.schema)}\\]?\\s*\\.\\s*${name}(?![\\w$])`, 'i');
    const bare = o.schema.toLowerCase() === 'dbo' ? new RegExp(`(?<![\\w#@$.\\]])${name}(?![\\w$.])`, 'i') : null;
    const out: ObjectDetail['jobsUsing'] = [];
    for (const j of this.jobs()) {
      for (const st of j.details.steps) {
        const sk = jobStepNodeId(j.jobId, st.stepId);
        const analysed = st.analyzable ? this.analyses().get(sk) : undefined;
        if (analysed) {
          if (Object.values(this.resolvedFor(sk, analysed.refs)).some((r) => r.nodeId === nodeId)) {
            out.push({ jobId: j.jobId, jobName: j.name, stepId: st.stepId, source: j.source, via: 'analysis' });
          }
          continue;
        }
        if (!this.stepTargets(j.details, st).targetsThisDb) continue;
        if (qualified.test(st.command) || (bare && bare.test(st.command))) {
          out.push({ jobId: j.jobId, jobName: j.name, stepId: st.stepId, source: j.source, via: 'text-match' });
        }
      }
    }
    return out;
  }

  /* ------------------------------------------------------------------ jobs */

  jobs(): CachedJobRow[] {
    if (!this.jobsCache) this.jobsCache = this.store.listJobs();
    return this.jobsCache;
  }

  stepTargets(job: ExtractedJob, st: ExtractedJobStep): { targetsThisDb: boolean; targetMatch: NonNullable<JobStep['targetMatch']> } {
    if (job.source === 'agent') {
      const ok = Boolean(st.databaseName) && st.databaseName!.toLowerCase() === this.conn.target.database.toLowerCase();
      return { targetsThisDb: ok, targetMatch: ok ? 'database' : 'none' };
    }
    return evaluateTargets(st.targetMembers, { server: this.conn.target.server, database: this.conn.target.database });
  }

  private toExecution(e: ExtractedExecution): JobExecution {
    return {
      jobExecutionId: e.jobExecutionId,
      jobName: e.jobName,
      stepId: e.stepId,
      stepName: e.stepName,
      lifecycle: e.lifecycle,
      isActive: e.isActive,
      createTime: e.createTime,
      startTime: e.startTime,
      endTime: e.endTime,
      lastMessage: e.lastMessage,
      targetServerName: e.targetServerName,
      targetDatabaseName: e.targetDatabaseName,
      currentAttempts: e.currentAttempts,
      runStatus: e.runStatus,
      durationSeconds: e.durationSeconds,
    };
  }

  private jobSummary(j: CachedJobRow, executions: ExtractedExecution[]): JobSummary {
    const job = j.details;
    const parent = executions.find((e) => e.stepId === null) ?? executions[0] ?? null;
    return {
      jobId: j.jobId,
      source: j.source,
      name: job.name,
      description: job.description,
      enabled: job.enabled,
      version: job.version,
      scheduleText: job.scheduleText,
      stepCount: job.steps.length,
      targetsThisDb: job.steps.some((st) => this.stepTargets(job, st).targetsThisDb),
      lastExecution: parent ? this.toExecution(parent) : null,
      category: job.category,
      owner: job.owner,
      lastRunOutcome: job.lastRunOutcome ?? (parent && parent.stepId === null ? parent.lifecycle : null),
      nextRun: job.source === 'agent' ? job.nextRun : nextElasticRun(job.enabled, job.schedule),
    };
  }

  jobSummaries(): JobSummary[] {
    const all = this.store.listExecutions();
    const byJob = new Map<string, ExtractedExecution[]>();
    for (const e of all) {
      const k = e.jobId ?? e.jobName;
      (byJob.get(k) ?? byJob.set(k, []).get(k)!).push(e);
    }
    return this.jobs().map((j) => this.jobSummary(j, byJob.get(j.jobId) ?? byJob.get(j.name) ?? []));
  }

  jobDetail(jobId: string): JobDetail | null {
    const j = this.jobs().find((x) => x.jobId.toLowerCase() === jobId.toLowerCase());
    if (!j) return null;
    const job = j.details;
    const executions = this.store.listExecutions(j.jobId);
    const summary = this.jobSummary(j, executions);
    const steps: JobStep[] = job.steps.map((st) => {
      const t = this.stepTargets(job, st);
      return {
        stepId: st.stepId,
        name: st.name,
        commandType: st.commandType,
        commandSource: st.commandSource,
        command: st.command,
        credentialName: st.credentialName,
        targetGroupName: st.targetGroupName,
        targetMembers: st.targetMembers,
        retryAttempts: st.retryAttempts,
        stepTimeoutSeconds: st.stepTimeoutSeconds,
        maxParallelism: st.maxParallelism,
        targetsThisDb: t.targetsThisDb,
        targetMatch: t.targetMatch,
        analysis: st.analyzable ? this.analysisPayload(jobStepNodeId(j.jobId, st.stepId)) : null,
        subsystem: st.subsystem,
        databaseName: st.databaseName,
        onSuccess: st.onSuccess,
        onFail: st.onFail,
        retryIntervalMinutes: st.retryIntervalMinutes,
        outputFileName: st.outputFileName,
        analyzable: st.analyzable,
      };
    });
    return {
      ...summary,
      schedule: job.schedule,
      schedules:
        job.source === 'agent'
          ? job.schedules
          : [{ name: job.schedule.intervalType ?? 'Schedule', enabled: job.enabled, text: job.scheduleText, nextRun: summary.nextRun }],
      steps,
      executions: executions.map((e) => this.toExecution(e)),
      ai: ((row) => (row ? toAiDescription(row, jobDescribeSha(job)) : null))(this.store.getAi(jobNodeId(j.jobId))),
    };
  }
}
