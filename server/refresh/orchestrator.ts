import type sql from 'mssql';
import { AGENT_ENGINE_EDITIONS, ENGINE_EDITIONS, SEGMENTS } from '../../shared/types';
import type { ObjectKind, RefreshRequest, RefreshRun, RunWarning, Segment, SegmentCounts, WarningObjectRef } from '../../shared/types';
import type { Settings } from '../config/settings';
import { newSlug, type ConnectionStore, type StoredConnection } from '../connections/store';
import { runAnalysis } from '../analysis/runner';
import type { PoolManager } from '../db/pools';
import { errorMessage, type QueryOptions } from '../db/query';
import { extractAgentJobs, probeAgent } from '../extract/agent';
import { fetchObjects, fetchRowCounts, fetchSynonyms, listObjects, type CatalogContext, type ListedObject } from '../extract/catalog';
import { DEPENDENCY_BATCH_SIZE, describeObject, extractDependencies, type DependencyBatch, type ModuleIssue } from '../extract/dependencies';
import { extractJobs } from '../extract/jobs';
import { probeTarget, type TargetProbe } from '../extract/probe';
import type { CacheManager } from '../store/cacheManager';
import { objectContentSha, type CacheStore, type ObjectKey } from '../store/cacheStore';

export const SEGMENT_KIND: Record<Exclude<Segment, 'dependencies' | 'jobs' | 'analysis'>, ObjectKind> = {
  tables: 'table',
  views: 'view',
  functions: 'function',
  procedures: 'procedure',
  triggers: 'trigger',
};
export const KIND_SEGMENT: Record<ObjectKind, Segment> = {
  table: 'tables',
  view: 'views',
  function: 'functions',
  procedure: 'procedures',
  trigger: 'triggers',
};

export class ConflictError extends Error {}
export class NotFoundError extends Error {}

/** Abort reason of a run: user cancel ('cancelled') or the run time limit ('failed'). */
export class RunAbortedError extends Error {
  constructor(
    message: string,
    readonly status: 'cancelled' | 'failed',
  ) {
    super(message);
    this.name = 'RunAbortedError';
  }
}

export interface RefreshDeps {
  connections: ConnectionStore;
  pools: PoolManager;
  caches: CacheManager;
  settings: Settings;
}

interface DependencyIssue {
  kind: ObjectKind;
  schema: string;
  name: string;
  type: 'stale' | 'missing-references' | 'failed';
  message: string;
}

const zero = (): SegmentCounts => ({ added: 0, updated: 0, removed: 0, unchanged: 0 });
const lower = (o: { schema: string; name: string }): string => `${o.schema}.${o.name}`.toLowerCase();
const depKey = (o: ObjectKey): string => `${o.kind}|${o.schema}|${o.name}`.toLowerCase();
const fmtCounts = (c: SegmentCounts | undefined): string =>
  c ? `added ${c.added}, updated ${c.updated}, removed ${c.removed}, unchanged ${c.unchanged}` : 'no counts';
const fmtLimit = (ms: number): string => (ms % 60_000 === 0 ? `${ms / 60_000} min` : ms % 1000 === 0 ? `${ms / 1000} s` : `${ms} ms`);

/** Mutable state of one run + throttled persistence to refresh_runs. */
class RunContext {
  private lastSave = 0;

  constructor(
    readonly run: RefreshRun,
    private readonly store: CacheStore,
  ) {}

  phase(phase: string, total = 0): void {
    this.run.progress = { phase, done: 0, total };
    this.save(true);
  }

  tick(done: number, total: number): void {
    this.run.progress.done = done;
    this.run.progress.total = total;
    this.save(false);
  }

  /** Human-readable sub-step of the current phase; resets done/total until the next tick. */
  step(step: string): void {
    this.run.progress = { ...this.run.progress, step, done: 0, total: 0 };
    this.save(true);
  }

  log(msg: string): void {
    console.log(`[refresh ${this.run.id}] ${msg}`);
  }

  /** `details`: optional object / job refs, kept parallel in run.warningDetails */
  warn(msg: string, details?: Omit<RunWarning, 'message'>): void {
    if (this.run.warnings.includes(msg)) return;
    this.run.warnings.push(msg);
    this.run.warningDetails.push({ message: msg, ...details });
  }

  save(force: boolean): void {
    const now = Date.now();
    if (!force && now - this.lastSave < 500) return;
    this.lastSave = now;
    this.store.saveRun(this.run);
  }
}

interface Ctx {
  conn: StoredConnection;
  store: CacheStore;
  pool: sql.ConnectionPool;
  query: QueryOptions;
  probe: TargetProbe;
  rc: RunContext;
  listing: ListedObject[];
  /** sys.synonyms is read once per run (by the first tables / procedures segment) */
  synonymsRead: boolean;
}

export class RefreshManager {
  private readonly active = new Map<string, { run: RefreshRun; promise: Promise<void>; abort: AbortController }>();
  /** completed modules saved per dependencies transaction (tests lower it) */
  dependencyBatchSize = DEPENDENCY_BATCH_SIZE;

  constructor(private readonly d: RefreshDeps) {}

  isActive(connectionId: string): boolean {
    return this.active.has(connectionId);
  }

  /** Starts a run in the background and returns its initial state. One active run per connection. */
  start(connectionId: string, request: RefreshRequest): RefreshRun {
    if (this.active.has(connectionId)) {
      throw new ConflictError(`a refresh is already running for connection ${connectionId} (run ${this.active.get(connectionId)!.run.id})`);
    }
    const conn = this.d.connections.get(connectionId);
    if (!conn) throw new NotFoundError(`connection ${connectionId} not found`);
    const store = this.d.caches.get(connectionId);
    const run: RefreshRun = {
      id: newSlug(12),
      connectionId,
      status: 'running',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      request,
      progress: { phase: 'starting', done: 0, total: 0 },
      counts: {},
      warnings: [],
      warningDetails: [],
    };
    store.saveRun(run);
    const abort = new AbortController();
    const limit = this.d.settings.refreshTimeoutMs;
    const timer = setTimeout(() => abort.abort(new RunAbortedError(`Refresh timed out after ${fmtLimit(limit)}`, 'failed')), limit);
    const promise = this.execute(conn, store, run, abort.signal).finally(() => {
      clearTimeout(timer);
      this.active.delete(connectionId);
    });
    this.active.set(connectionId, { run, promise, abort });
    return run;
  }

  /** Aborts a running run (in-flight queries are cancelled); the run then finalizes as 'cancelled'. */
  cancel(connectionId: string, runId: string): RefreshRun {
    const a = this.active.get(connectionId);
    if (!a || a.run.id !== runId) {
      const run = this.d.caches.get(connectionId).getRun(runId, connectionId);
      if (!run) throw new NotFoundError(`refresh run ${runId} not found`);
      throw new ConflictError(`refresh run ${runId} is not running (status ${run.status})`);
    }
    if (!a.abort.signal.aborted) a.abort.abort(new RunAbortedError('Cancelled by user', 'cancelled'));
    return structuredClone(a.run);
  }

  get(connectionId: string, runId: string): RefreshRun | null {
    const a = this.active.get(connectionId);
    if (a && a.run.id === runId) return structuredClone(a.run);
    return this.d.caches.get(connectionId).getRun(runId, connectionId);
  }

  /** `before`: run id; only runs started strictly before it (started_at DESC, id DESC) */
  list(connectionId: string, limit = 20, before?: string): RefreshRun[] {
    const store = this.d.caches.get(connectionId);
    let cursor: { startedAt: string; id: string } | undefined;
    if (before !== undefined) {
      const b = store.getRun(before, connectionId);
      if (!b) throw new NotFoundError(`refresh run ${before} not found`);
      cursor = { startedAt: b.startedAt, id: b.id };
    }
    const runs = store.listRuns(connectionId, limit, cursor);
    const a = this.active.get(connectionId);
    return a ? runs.map((r) => (r.id === a.run.id ? structuredClone(a.run) : r)) : runs;
  }

  /** Resolves when the connection's active run (if any) has finished. */
  async waitIdle(connectionId: string): Promise<void> {
    await this.active.get(connectionId)?.promise;
  }

  async waitAll(): Promise<void> {
    await Promise.all([...this.active.values()].map((a) => a.promise));
  }

  /* ------------------------------------------------------------------ run */

  private async execute(conn: StoredConnection, store: CacheStore, run: RefreshRun, signal: AbortSignal): Promise<void> {
    const rc = new RunContext(run, store);
    const query: QueryOptions = { lockTimeoutMs: this.d.settings.lockTimeoutMs, timeoutMs: this.d.settings.requestTimeoutMs, signal };
    const onAbort = () => rc.log(`aborting (phase ${run.progress.phase}${run.progress.step ? ` / ${run.progress.step}` : ''}): ${errorMessage(signal.reason)}`);
    signal.addEventListener('abort', onAbort, { once: true });
    const segmentErrors: Partial<Record<Segment, string>> = {};
    let attempted: Segment[] = [];
    try {
      const objectMode = Boolean(run.request.objects && run.request.objects.length);
      const requested: Segment[] = objectMode
        ? []
        : run.request.segments === 'all'
          ? [...SEGMENTS]
          : SEGMENTS.filter((s) => (run.request.segments as Segment[]).includes(s));

      if (!objectMode && requested.length > 0 && requested.every((s) => s === 'analysis')) {
        // 'analysis' alone works on the cache only: no pool, no probe, no listing
        attempted = requested;
        this.analysisSegment(store, conn, rc, run.request.mode, segmentErrors);
      } else {
        rc.phase('connecting');
        const pool = await this.d.pools.get(conn, 'target');
        signal.throwIfAborted();
        rc.phase('probing permissions');
        const probe = await probeTarget(pool, query);
        store.setMeta('server_info', { ...probe, engineEditionLabel: ENGINE_EDITIONS[probe.engineEdition ?? -1] ?? null, probedAt: new Date().toISOString() });
        if (!probe.permissions.viewDefinition) {
          rc.warn('VIEW DEFINITION is not granted: objects and definitions this login cannot see are silently missing.');
        }

        const needsListing = objectMode || requested.some((s) => s !== 'jobs' && s !== 'analysis');
        let listing: ListedObject[] = [];
        if (needsListing) {
          rc.phase('listing objects');
          listing = await listObjects(pool, query);
        }
        const ctx: Ctx = { conn, store, pool, query, probe, rc, listing, synonymsRead: false };

        if (objectMode) {
          attempted = await this.refreshObjects(ctx, run.request.objects!, segmentErrors);
        } else {
          attempted = requested;
          for (const seg of requested) {
            signal.throwIfAborted();
            rc.phase(seg);
            rc.log(`segment ${seg}: start (${run.request.mode})`);
            const segStarted = Date.now();
            if (seg === 'analysis') {
              this.analysisSegment(store, conn, rc, run.request.mode, segmentErrors);
            } else {
              try {
                if (seg === 'dependencies') run.counts.dependencies = await this.refreshDependencies(ctx, run.request.mode);
                else if (seg === 'jobs') run.counts.jobs = await this.refreshJobs(ctx);
                else run.counts[seg] = await this.refreshKind(ctx, SEGMENT_KIND[seg], run.request.mode);
              } catch (err) {
                if (signal.aborted) {
                  rc.log(`segment ${seg}: aborted after ${Date.now() - segStarted} ms`);
                  throw err;
                }
                segmentErrors[seg] = errorMessage(err);
                rc.warn(`segment ${seg} failed (previous cached data kept): ${errorMessage(err)}`);
              }
            }
            rc.log(
              segmentErrors[seg]
                ? `segment ${seg}: failed after ${Date.now() - segStarted} ms`
                : `segment ${seg}: done in ${Date.now() - segStarted} ms (${fmtCounts(run.counts[seg])})`,
            );
          }
        }
        signal.throwIfAborted();
        // Definitions / job steps may have changed: bring the static analysis up to date (only what changed).
        // Not a segment of its own here (progress counts only the requested segments); a failure is a warning.
        if (!requested.includes('analysis') && (objectMode || requested.some((s) => s !== 'dependencies' && s !== 'tables'))) {
          rc.phase('analysis');
          try {
            run.counts.analysis = runAnalysis(store, conn.target.database, { force: false, onProgress: (d, t) => rc.tick(d, t) });
          } catch (err) {
            rc.warn(`static analysis failed (previous analysis kept): ${errorMessage(err)}`);
          }
        }
      }
      const failed = Object.keys(segmentErrors).length;
      run.status = failed === 0 ? 'succeeded' : failed >= attempted.length ? 'failed' : 'partial';
      if (failed) run.segmentErrors = segmentErrors;
      if (run.status === 'failed') run.error = 'all segments failed';
    } catch (err) {
      const aborted = signal.aborted && signal.reason instanceof RunAbortedError ? signal.reason : null;
      run.status = aborted ? aborted.status : 'failed';
      run.error = aborted ? aborted.message : errorMessage(err);
      if (Object.keys(segmentErrors).length) run.segmentErrors = segmentErrors;
    }
    signal.removeEventListener('abort', onAbort);
    run.finishedAt = new Date().toISOString();
    // final progress is in segments: how many of the attempted segments completed without error
    // (an aborted run counts only the segments that finished before the abort)
    const completed = signal.aborted
      ? attempted.filter((s) => s in run.counts && !segmentErrors[s]).length
      : attempted.length - Object.keys(segmentErrors).length;
    run.progress = { phase: 'done', done: completed, total: attempted.length };
    if (signal.aborted) rc.log(`run ${run.status} after ${Date.now() - Date.parse(run.startedAt)} ms: ${run.error ?? 'finished before the abort took effect'}`);
    store.saveRun(run);
    if (run.status === 'succeeded' || run.status === 'partial') this.d.connections.setLastRefreshAt(conn.id, run.finishedAt);
  }

  /** Segment 'analysis': re-analyse from the cache (mode 'full': everything; 'incremental': changed only). */
  private analysisSegment(store: CacheStore, conn: StoredConnection, rc: RunContext, mode: RefreshRequest['mode'], errors: Partial<Record<Segment, string>>): void {
    rc.phase('analysis');
    try {
      rc.run.counts.analysis = runAnalysis(store, conn.target.database, { force: mode === 'full', onProgress: (d, t) => rc.tick(d, t) });
    } catch (err) {
      errors.analysis = errorMessage(err);
      rc.warn(`segment analysis failed (previous analysis kept): ${errorMessage(err)}`);
    }
  }

  private catalogCtx(ctx: Ctx): CatalogContext {
    return {
      pool: ctx.pool,
      query: ctx.query,
      rowCountSource: ctx.probe.permissions.viewDatabaseState ? 'dm_db_partition_stats' : 'sys.partitions',
    };
  }

  /* ------------------------------------------------------------------ object segments */

  private async refreshKind(ctx: Ctx, kind: ObjectKind, mode: RefreshRequest['mode']): Promise<SegmentCounts> {
    const server = ctx.listing.filter((o) => o.kind === kind);
    const cached = new Map(ctx.store.objectStates(kind).map((c) => [lower(c), c]));
    const toFetch =
      mode === 'full'
        ? server
        : server.filter((o) => {
            const c = cached.get(lower(o));
            return !c || c.serverObjectId !== o.objectId || c.modifyDate !== o.modifyDate;
          });
    ctx.rc.tick(0, toFetch.length);
    const cat = this.catalogCtx(ctx);
    const fetched = await fetchObjects(cat, kind, toFetch);
    ctx.rc.tick(fetched.length, toFetch.length);
    const serverKeys = new Set(server.map(lower));
    const removals = [...cached.values()].filter((c) => !serverKeys.has(lower(c)));

    // Tables: refresh row counts of tables that were not re-fetched (counts change without modify_date).
    let rowCounts: Map<string, { rowCount: number | null; source: string | null; reservedKb: number | null }> | undefined;
    if (kind === 'table') {
      if (!ctx.probe.permissions.viewDatabaseState) {
        ctx.rc.warn(
          `VIEW DATABASE STATE not granted (${ctx.probe.probeErrors.partitionStats ?? 'sys.dm_db_partition_stats not readable'}): row counts come from sys.partitions; sizes unavailable.`,
        );
      }
      if (fetched.length < server.length) {
        const counts = await fetchRowCounts(cat);
        rowCounts = new Map();
        for (const o of server) {
          const rcInfo = counts.get(o.objectId);
          rowCounts.set(`${o.schema}.${o.name}`, { rowCount: rcInfo?.rows ?? null, source: rcInfo ? cat.rowCountSource : null, reservedKb: rcInfo?.reservedKb ?? null });
        }
      }
    }

    const counts = zero();
    const fetchedKeys = new Set(fetched.map(lower));
    for (const o of fetched) {
      const c = cached.get(lower(o));
      if (!c) counts.added++;
      else if (mode === 'full') {
        // full mode re-fetches everything: only count real changes as updated
        if (c.serverObjectId !== o.objectId || c.modifyDate !== o.modifyDate || c.contentSha256 !== objectContentSha(o)) counts.updated++;
        else counts.unchanged++;
      } else counts.updated++;
    }
    if (mode !== 'full') counts.unchanged = server.filter((o) => !fetchedKeys.has(lower(o)) && cached.has(lower(o))).length;
    counts.removed = removals.length;
    const vanished = toFetch.length - fetched.length;
    if (vanished > 0) ctx.rc.warn(`${KIND_SEGMENT[kind]}: ${vanished} object(s) disappeared between listing and fetch; refresh again`);

    ctx.store.applyObjectSegment(kind, fetched, removals, rowCounts);
    this.warnNullDefinitions(ctx, kind);
    if ((kind === 'table' || kind === 'procedure') && !ctx.synonymsRead) await this.refreshSynonyms(ctx);
    return counts;
  }

  /** sys.synonyms -> meta 'synonyms' (used by the static-analysis resolver). Failure keeps the previous list. */
  private async refreshSynonyms(ctx: Ctx): Promise<void> {
    ctx.synonymsRead = true;
    try {
      ctx.store.setMeta('synonyms', await fetchSynonyms(ctx.pool, ctx.query));
    } catch (err) {
      ctx.rc.warn(`synonyms could not be read (static-analysis refs through synonyms stay unresolved): ${errorMessage(err)}`);
    }
  }

  private warnNullDefinitions(ctx: Ctx, kind: ObjectKind): void {
    if (kind === 'table') return;
    const rows = ctx.store.db
      .prepare(`SELECT is_encrypted, COUNT(*) AS n FROM objects WHERE kind = ? AND definition IS NULL AND type_code NOT IN ('PC','FS','FT','TA') GROUP BY is_encrypted`)
      .all(kind) as Array<{ is_encrypted: number; n: number }>;
    const enc = rows.find((r) => r.is_encrypted === 1)?.n ?? 0;
    const noPerm = rows.find((r) => r.is_encrypted === 0)?.n ?? 0;
    if (enc + noPerm > 0) {
      ctx.rc.warn(`${KIND_SEGMENT[kind]}: ${enc + noPerm} NULL definition(s): ${enc} encrypted (WITH ENCRYPTION), ${noPerm} not visible (no VIEW DEFINITION)`);
    }
  }

  /** request.objects: refresh exactly these (remove the ones gone from the server) + their dependencies. */
  private async refreshObjects(ctx: Ctx, objects: NonNullable<RefreshRequest['objects']>, errors: Partial<Record<Segment, string>>): Promise<Segment[]> {
    const attempted = new Set<Segment>();
    const computeDeps: ListedObject[] = [];
    const removedKeys: ObjectKey[] = [];
    const kinds = [...new Set(objects.map((o) => o.kind))];
    for (const kind of kinds) {
      const seg = KIND_SEGMENT[kind];
      attempted.add(seg);
      ctx.rc.phase(seg);
      ctx.rc.log(`segment ${seg}: start (objects)`);
      const segStarted = Date.now();
      try {
        const wanted = objects.filter((o) => o.kind === kind);
        const server = new Map(ctx.listing.filter((o) => o.kind === kind).map((o) => [lower(o), o]));
        const cached = new Map(ctx.store.objectStates(kind).map((c) => [lower(c), c]));
        const found: ListedObject[] = [];
        const removals: Array<{ schema: string; name: string }> = [];
        for (const w of wanted) {
          const s = server.get(lower(w));
          if (s) found.push(s);
          else if (cached.has(lower(w))) {
            const c = cached.get(lower(w))!;
            removals.push({ schema: c.schema, name: c.name });
            removedKeys.push({ kind, schema: c.schema, name: c.name });
          } else ctx.rc.warn(`${kind} ${w.schema}.${w.name} not found on the server or in the cache`, { objects: [{ kind, schema: w.schema, name: w.name }] });
        }
        const fetched = await fetchObjects(this.catalogCtx(ctx), kind, found);
        ctx.store.applyObjectSegment(kind, fetched, removals);
        computeDeps.push(...found);
        const c = zero();
        for (const o of fetched) cached.has(lower(o)) ? c.updated++ : c.added++;
        c.removed = removals.length;
        ctx.rc.run.counts[seg] = c;
        ctx.rc.log(`segment ${seg}: done in ${Date.now() - segStarted} ms (${fmtCounts(c)})`);
      } catch (err) {
        if (ctx.query.signal?.aborted) {
          ctx.rc.log(`segment ${seg}: aborted after ${Date.now() - segStarted} ms`);
          throw err;
        }
        errors[seg] = errorMessage(err);
        ctx.rc.warn(`segment ${seg} failed (previous cached data kept): ${errorMessage(err)}`);
        ctx.rc.log(`segment ${seg}: failed after ${Date.now() - segStarted} ms`);
      }
    }
    ctx.query.signal?.throwIfAborted();
    attempted.add('dependencies');
    ctx.rc.phase('dependencies');
    ctx.rc.log('segment dependencies: start (objects)');
    const depStarted = Date.now();
    try {
      ctx.rc.run.counts.dependencies = await this.refreshDependencies(ctx, 'incremental', { compute: computeDeps, removed: removedKeys });
      ctx.rc.log(`segment dependencies: done in ${Date.now() - depStarted} ms (${fmtCounts(ctx.rc.run.counts.dependencies)})`);
    } catch (err) {
      if (ctx.query.signal?.aborted) {
        ctx.rc.log(`segment dependencies: aborted after ${Date.now() - depStarted} ms`);
        throw err;
      }
      errors.dependencies = errorMessage(err);
      ctx.rc.warn(`segment dependencies failed (previous cached data kept): ${errorMessage(err)}`);
      ctx.rc.log(`segment dependencies: failed after ${Date.now() - depStarted} ms`);
    }
    return [...attempted];
  }

  /* ------------------------------------------------------------------ dependencies */

  private async refreshDependencies(
    ctx: Ctx,
    mode: RefreshRequest['mode'],
    only?: { compute: ListedObject[]; removed: ObjectKey[] },
  ): Promise<SegmentCounts> {
    const expr = ctx.probe.permissions.expressionDependencies;
    if (!expr) {
      ctx.rc.warn(
        `sys.sql_expression_dependencies is not readable (${ctx.probe.probeErrors.expressionDependencies ?? 'permission denied'}): dependencies come from sys.dm_sql_referenced_entities only, and table-level dependencies (computed columns, constraints) are missing. Fix: GRANT SELECT ON sys.sql_expression_dependencies TO <user>.`,
      );
    }
    // Tables only have expression dependencies (computed columns / constraints).
    const candidates = ctx.listing.filter((o) => o.kind !== 'table' || expr);
    const states = ctx.store.dependencyStates();
    let toCompute: ListedObject[];
    let removed: ObjectKey[];
    if (only) {
      toCompute = only.compute.filter((o) => o.kind !== 'table' || expr);
      removed = only.removed;
    } else {
      toCompute =
        mode === 'full'
          ? candidates
          : candidates.filter((o) => {
              const st = states.get(depKey(o));
              return !st || st.serverObjectId !== o.objectId || st.modifyDate !== o.modifyDate;
            });
      const keep = new Set(candidates.map(depKey));
      removed = [...states.keys()]
        .filter((k) => !keep.has(k))
        .map((k) => {
          const [kind, schema, ...rest] = k.split('|');
          return { kind: kind as ObjectKind, schema, name: rest.join('|') };
        });
    }

    // Results are saved batch by batch as they become final (each batch its own transaction), so an aborted
    // or failed run keeps what was computed and the next incremental run computes only the remainder.
    const counts = zero();
    const issues = ctx.store.getMeta<Record<string, DependencyIssue>>('dependency_issues') ?? {};
    const saved: Pick<DependencyBatch, 'stale' | 'missingReferences' | 'failed'> = { stale: [], missingReferences: [], failed: [] };
    let batches = 0;
    let savedObjects = 0;
    const save = (batch: DependencyBatch) => {
      const changed = ctx.store.applyDependencies(
        batch.objects.map(({ object: o, deps }) => ({
          object: { kind: o.kind, schema: o.schema, name: o.name, serverObjectId: o.objectId, modifyDate: o.modifyDate },
          deps,
        })),
        [],
      );
      // Persist per-module issues so the summary keeps reporting them after incremental runs.
      for (const { object: o } of batch.objects) delete issues[depKey(o)];
      const add = (list: ModuleIssue[], type: DependencyIssue['type']) => {
        for (const i of list) issues[depKey(i.object)] = { kind: i.object.kind, schema: i.object.schema, name: i.object.name, type, message: i.message };
      };
      add(batch.stale, 'stale');
      add(batch.missingReferences, 'missing-references');
      add(batch.failed, 'failed');
      ctx.store.setMeta('dependency_issues', issues);
      saved.stale.push(...batch.stale);
      saved.missingReferences.push(...batch.missingReferences);
      saved.failed.push(...batch.failed);
      for (const { object: o } of batch.objects) {
        const k = depKey(o);
        if (!states.has(k)) counts.added++;
        else if (changed.has(k)) counts.updated++;
        else counts.unchanged++;
      }
      batches++;
      savedObjects += batch.objects.length;
      ctx.rc.log(`dependencies: saved ${batch.objects.length} object(s) (batch ${batches}, ${savedObjects}/${toCompute.length})`);
    };

    try {
      await extractDependencies(
        {
          pool: ctx.pool,
          query: ctx.query,
          currentDatabase: ctx.probe.database || ctx.conn.target.database,
          expressionDependencies: expr,
          concurrency: Math.min(4, this.d.settings.dependencyConcurrency),
          bulkQueryTimeoutMs: this.d.settings.bulkQueryTimeoutMs,
          onProgress: (done, total) => ctx.rc.tick(done, total),
          onStep: (step) => ctx.rc.step(step),
          log: (msg) => ctx.rc.log(msg),
          onBatch: save,
          batchSize: this.dependencyBatchSize,
        },
        toCompute,
      );
    } finally {
      for (const w of dependencyIssueWarnings(saved.stale, saved.missingReferences, saved.failed)) ctx.rc.warn(w.message, { objects: w.objects });
    }

    // Removals only after every computed object was saved.
    ctx.store.applyDependencies([], removed);
    for (const o of removed) delete issues[depKey(o)];
    ctx.store.setMeta('dependency_issues', issues);

    if (!only) counts.unchanged += candidates.length - toCompute.length;
    counts.removed = removed.length;
    return counts;
  }

  /* ------------------------------------------------------------------ jobs */

  private async refreshJobs(ctx: Ctx): Promise<SegmentCounts> {
    const counts = zero();
    const add = (c: SegmentCounts) => {
      counts.added += c.added;
      counts.updated += c.updated;
      counts.removed += c.removed;
      counts.unchanged += c.unchanged;
    };
    const source = ctx.conn.jobsSource ?? 'auto';
    const edition = ctx.probe.engineEdition ?? -1;
    const agentSupported = AGENT_ENGINE_EDITIONS.includes(edition);
    const agentWanted = source === 'agent' || (source === 'auto' && agentSupported);
    const elasticWanted = source === 'elastic' || (source === 'auto' && ctx.conn.jobs !== null);
    const errors: string[] = [];

    if (source === 'none') {
      counts.removed += ctx.store.clearJobs('agent') + ctx.store.clearJobs('elastic');
      ctx.rc.warn('jobs: jobsSource is "none"; no jobs were read');
      return counts;
    }

    if (agentWanted) {
      if (!agentSupported) {
        ctx.rc.warn(`jobs: SQL Server Agent is not available on ${ENGINE_EDITIONS[edition] ?? `engine edition ${edition}`}; Agent jobs skipped`);
      } else {
        const probe = await probeAgent(ctx.pool, ctx.query);
        if (!probe.readable) {
          // previous cached Agent jobs are kept
          ctx.rc.warn(`Agent jobs not readable (needs SQLAgentReaderRole in msdb): ${probe.error ?? probe.directError ?? 'EXECUTE on msdb.dbo.sp_help_job denied'}`);
        } else {
          try {
            const ex = await extractAgentJobs(ctx.pool, ctx.query, probe, this.d.settings.executionsPerJob, Math.min(4, this.d.settings.dependencyConcurrency));
            add(ctx.store.applyJobs('agent', ex.jobs, ex.executions));
            ctx.store.setMeta('agent_read_path', ex.path);
            ex.warnings.forEach((w, i) => {
              const job = ex.warningJobs[i];
              ctx.rc.warn(w, job ? { job } : undefined);
            });
          } catch (err) {
            errors.push(`Agent jobs: ${errorMessage(err)}`);
          }
        }
      }
    } else {
      counts.removed += ctx.store.clearJobs('agent');
    }

    if (elasticWanted) {
      if (!ctx.conn.jobs) {
        ctx.rc.warn('jobs: jobsSource is "elastic" but no jobs endpoint is configured; Elastic Jobs skipped');
      } else {
        try {
          const pool = await this.d.pools.get(ctx.conn, 'jobs');
          const ex = await extractJobs(pool, ctx.query, this.d.settings.executionsPerJob);
          add(ctx.store.applyJobs('elastic', ex.jobs, ex.executions));
          for (const w of ex.warnings) ctx.rc.warn(`Elastic Jobs: ${w}`);
        } catch (err) {
          errors.push(`Elastic Jobs: ${errorMessage(err)}`);
        }
      }
    } else {
      counts.removed += ctx.store.clearJobs('elastic');
    }

    if (errors.length) throw new Error(errors.join('; '));
    return counts;
  }
}

const objectRef = (o: ModuleIssue['object']): WarningObjectRef => ({ kind: o.kind, schema: o.schema, name: o.name });

export function dependencyIssueWarnings(stale: ModuleIssue[], missing: ModuleIssue[], failed: ModuleIssue[]): RunWarning[] {
  const out: RunWarning[] = [];
  for (const s of stale) out.push({ message: `Stale module (binding error, would fail to compile): ${describeObject(s.object)}: ${s.message}`, objects: [objectRef(s.object)] });
  if (missing.length) {
    const names = missing.map((m) => describeObject(m.object));
    out.push({
      message: `${missing.length} module(s) reference objects that do not exist (deferred name resolution): ${names.slice(0, 25).join(', ')}${names.length > 25 ? ', ...' : ''}`,
      objects: missing.map((m) => objectRef(m.object)),
    });
  }
  for (const f of failed) out.push({ message: `Dependencies could not be read for ${describeObject(f.object)}: ${f.message}`, objects: [objectRef(f.object)] });
  return out;
}

