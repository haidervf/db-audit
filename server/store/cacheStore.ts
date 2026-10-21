import crypto from 'node:crypto';
import type { AiDescriptionContent, AnalysisFlags, JobSourceKind, ModuleAnalysis, ObjectKind, RefreshRun, RunWarning, SegmentCounts } from '../../shared/types';
import type { AnalysisRefs } from '../analysis/refs';
import type { ExtractedObject } from '../extract/catalog';
import type { ExtractedDependency } from '../extract/dependencies';
import type { ExtractedExecution, ExtractedJob } from '../extract/jobTypes';
import { openCacheDb, type Db } from './cacheDb';

export function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

export interface ObjectKey {
  kind: ObjectKind;
  schema: string;
  name: string;
}

export interface CachedObjectState extends ObjectKey {
  serverObjectId: number | null;
  modifyDate: string | null;
  contentSha256: string | null;
}

export interface CachedObjectRow {
  kind: ObjectKind;
  schema: string;
  name: string;
  serverObjectId: number | null;
  typeCode: string | null;
  createDate: string;
  modifyDate: string;
  definition: string | null;
  hasDefinition: boolean;
  isEncrypted: boolean;
  definitionSha256: string | null;
  details: Record<string, unknown>;
  rowCount: number | null;
  fetchedAt: string;
}

export interface CachedDependencyRow {
  fromKind: ObjectKind;
  fromSchema: string;
  fromName: string;
  refServer: string | null;
  refDatabase: string | null;
  refSchema: string | null;
  refName: string;
  refKind: ObjectKind | 'unknown' | 'external';
  refTypeCode: string | null;
  refResolved: boolean;
  isAmbiguous: boolean;
  isCallerDependent: boolean;
  isSelected: boolean | null;
  isUpdated: boolean | null;
  isSelectAll: boolean | null;
  isIncomplete: boolean | null;
  columns: Array<{ name: string; isSelected: boolean; isUpdated: boolean }>;
  source: Array<'expression-dependencies' | 'referenced-entities'>;
}

export interface CachedJobRow {
  jobId: string;
  source: JobSourceKind;
  name: string;
  enabled: boolean;
  version: number;
  details: ExtractedJob;
  fetchedAt: string;
}

/** One row of the analysis table (the full analyzer output). */
export interface StoredAnalysis {
  targetKey: string;
  analyzerVersion: string;
  definitionSha256: string | null;
  analyzedAt: string;
  analysis: ModuleAnalysis;
}

/** The compact columns of an analysis row (summary flags + refs for the resolver / graph). */
export interface StoredAnalysisRefs {
  targetKey: string;
  flags: AnalysisFlags;
  refs: AnalysisRefs;
}

/** Code-risk fields of an analysis row (see listAnalysisSignals). */
export interface AnalysisSignals {
  targetKey: string;
  transactions: { begin: number; commit: number; rollback: number; save: number };
  hasTryCatch: boolean;
  /** cursor names, in order of declaration */
  cursors: string[];
  /** DynamicSql.kind of every dynamic SQL occurrence */
  dynamicSqlKinds: string[];
  /** ModuleAnalysis.linkedServers (empty when the analysis predates that field) */
  linkedServers: string[];
}

export interface AnalysisUpsert {
  targetKey: string;
  definitionSha256: string;
  analysis: ModuleAnalysis;
  flags: AnalysisFlags;
  refs: AnalysisRefs;
}

/** One row of ai_descriptions. `C`: AiDescriptionContent for objects / jobs, AiInsightsContent for 'insights:*' keys. */
export interface StoredAi<C = AiDescriptionContent> {
  targetKey: string;
  definitionSha256: string | null;
  model: string;
  promptVersion: string;
  effort: string;
  content: C;
  usage: { inputTokens: number; outputTokens: number } | null;
  createdAt: string;
}

const triBool = (v: unknown): boolean | null => (v === null || v === undefined ? null : v === 1 || v === true);
const toInt = (v: boolean | null): number | null => (v === null ? null : v ? 1 : 0);

/** Hash of an object's definition + metadata. Row counts / sizes are data, not schema, so they are excluded. */
export function objectContentSha(o: ExtractedObject): string {
  let details: unknown = o.details;
  if (o.details.kind === 'table') {
    const { rowCount, rowCountSource, reservedKb, ...rest } = o.details;
    void rowCount;
    void rowCountSource;
    void reservedKb;
    details = rest;
  }
  return sha256(JSON.stringify([o.objectId, o.modifyDate, o.definition, o.isEncrypted, details]));
}

function jobContentSha(j: ExtractedJob): string {
  return sha256(JSON.stringify(j));
}

/** One SQLite file per connection profile. Each segment write is a single transaction. */
export class CacheStore {
  readonly db: Db;

  constructor(readonly file: string) {
    this.db = openCacheDb(file);
    // A run that was 'running' when the process died will never finish.
    this.db
      .prepare(`UPDATE refresh_runs SET status = 'failed', error = 'interrupted: the server stopped during the run', finished_at = COALESCE(finished_at, ?) WHERE status = 'running'`)
      .run(new Date().toISOString());
  }

  close(): void {
    this.db.close();
  }

  /* ------------------------------------------------------------ meta */

  getMeta<T>(k: string): T | null {
    const r = this.db.prepare(`SELECT v FROM meta WHERE k = ?`).get(k) as { v: string } | undefined;
    return r ? (JSON.parse(r.v) as T) : null;
  }

  setMeta(k: string, v: unknown): void {
    this.db.prepare(`INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v`).run(k, JSON.stringify(v));
  }

  /* ------------------------------------------------------------ objects */

  objectStates(kind: ObjectKind): CachedObjectState[] {
    const rows = this.db
      .prepare(`SELECT kind, schema_name, name, server_object_id, modify_date, content_sha256 FROM objects WHERE kind = ?`)
      .all(kind) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      kind: r.kind as ObjectKind,
      schema: String(r.schema_name),
      name: String(r.name),
      serverObjectId: r.server_object_id === null ? null : Number(r.server_object_id),
      modifyDate: (r.modify_date as string | null) ?? null,
      contentSha256: (r.content_sha256 as string | null) ?? null,
    }));
  }

  /**
   * Upserts fetched objects and deletes removed ones in ONE transaction. `rowCounts` (tables only)
   * refreshes row counts of tables that were not re-fetched.
   */
  applyObjectSegment(
    kind: ObjectKind,
    upserts: ExtractedObject[],
    removals: Array<{ schema: string; name: string }>,
    rowCounts?: Map<string, { rowCount: number | null; source: string | null; reservedKb: number | null }>,
  ): void {
    const now = new Date().toISOString();
    const upsert = this.db.prepare(`
      INSERT INTO objects (kind, schema_name, name, server_object_id, type_code, create_date, modify_date, definition,
                           is_encrypted, definition_sha256, details_json, row_count, content_sha256, fetched_at)
      VALUES (@kind, @schema, @name, @objectId, @typeCode, @createDate, @modifyDate, @definition,
              @isEncrypted, @definitionSha256, @detailsJson, @rowCount, @contentSha256, @fetchedAt)
      ON CONFLICT (kind, schema_name, name) DO UPDATE SET
        schema_name = excluded.schema_name, name = excluded.name,
        server_object_id = excluded.server_object_id, type_code = excluded.type_code,
        create_date = excluded.create_date, modify_date = excluded.modify_date, definition = excluded.definition,
        is_encrypted = excluded.is_encrypted, definition_sha256 = excluded.definition_sha256,
        details_json = excluded.details_json, row_count = excluded.row_count,
        content_sha256 = excluded.content_sha256, fetched_at = excluded.fetched_at`);
    const del = this.db.prepare(`DELETE FROM objects WHERE kind = ? AND schema_name = ? AND name = ?`);
    const getDetails = this.db.prepare(`SELECT details_json FROM objects WHERE kind = 'table' AND schema_name = ? AND name = ?`);
    const setRowCount = this.db.prepare(`UPDATE objects SET row_count = ?, details_json = ? WHERE kind = 'table' AND schema_name = ? AND name = ?`);
    this.db.transaction(() => {
      for (const o of upserts) {
        upsert.run({
          kind,
          schema: o.schema,
          name: o.name,
          objectId: o.objectId,
          typeCode: o.typeCode,
          createDate: o.createDate,
          modifyDate: o.modifyDate,
          definition: o.definition,
          isEncrypted: o.isEncrypted ? 1 : 0,
          definitionSha256: o.definition === null ? null : sha256(o.definition),
          detailsJson: JSON.stringify(o.details),
          rowCount: o.rowCount,
          contentSha256: objectContentSha(o),
          fetchedAt: now,
        });
      }
      for (const r of removals) del.run(kind, r.schema, r.name);
      if (rowCounts && kind === 'table') {
        const fetched = new Set(upserts.map((o) => `${o.schema}.${o.name}`.toLowerCase()));
        for (const [key, rc] of rowCounts) {
          if (fetched.has(key.toLowerCase())) continue;
          const dot = key.indexOf('.');
          const schema = key.slice(0, dot);
          const name = key.slice(dot + 1);
          const cur = getDetails.get(schema, name) as { details_json: string } | undefined;
          if (!cur) continue;
          const details = JSON.parse(cur.details_json) as Record<string, unknown>;
          details.rowCount = rc.rowCount;
          details.rowCountSource = rc.source;
          details.reservedKb = rc.reservedKb;
          setRowCount.run(rc.rowCount, JSON.stringify(details), schema, name);
        }
      }
    })();
  }

  private mapObject(r: Record<string, unknown>): CachedObjectRow {
    return {
      kind: r.kind as ObjectKind,
      schema: String(r.schema_name),
      name: String(r.name),
      serverObjectId: r.server_object_id === null ? null : Number(r.server_object_id),
      typeCode: (r.type_code as string | null) ?? null,
      createDate: String(r.create_date ?? ''),
      modifyDate: String(r.modify_date ?? ''),
      definition: (r.definition as string | null) ?? null,
      hasDefinition: r.has_def !== undefined ? r.has_def === 1 : r.definition !== null && r.definition !== undefined,
      isEncrypted: r.is_encrypted === 1,
      definitionSha256: (r.definition_sha256 as string | null) ?? null,
      details: JSON.parse(String(r.details_json ?? '{}')) as Record<string, unknown>,
      rowCount: r.row_count === null || r.row_count === undefined ? null : Number(r.row_count),
      fetchedAt: String(r.fetched_at),
    };
  }

  listObjects(kind?: ObjectKind, withDefinition = false): CachedObjectRow[] {
    const cols = `kind, schema_name, name, server_object_id, type_code, create_date, modify_date, ${withDefinition ? 'definition' : 'NULL AS definition, CASE WHEN definition IS NULL THEN 0 ELSE 1 END AS has_def'}, is_encrypted, definition_sha256, details_json, row_count, fetched_at`;
    const rows = (kind
      ? this.db.prepare(`SELECT ${cols} FROM objects WHERE kind = ? ORDER BY schema_name, name`).all(kind)
      : this.db.prepare(`SELECT ${cols} FROM objects ORDER BY kind, schema_name, name`).all()) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapObject(r));
  }

  getObject(kind: ObjectKind, schema: string, name: string): CachedObjectRow | null {
    const r = this.db.prepare(`SELECT * FROM objects WHERE kind = ? AND schema_name = ? AND name = ?`).get(kind, schema, name) as
      | Record<string, unknown>
      | undefined;
    return r ? this.mapObject(r) : null;
  }

  countObjects(): Record<ObjectKind | 'job', number> {
    const counts: Record<ObjectKind | 'job', number> = { procedure: 0, table: 0, view: 0, function: 0, trigger: 0, job: 0 };
    for (const r of this.db.prepare(`SELECT kind, COUNT(*) AS n FROM objects GROUP BY kind`).all() as Array<{ kind: ObjectKind; n: number }>) {
      counts[r.kind] = r.n;
    }
    counts.job = (this.db.prepare(`SELECT COUNT(*) AS n FROM jobs`).get() as { n: number }).n;
    return counts;
  }

  /* ------------------------------------------------------------ dependencies */

  dependencyStates(): Map<string, { serverObjectId: number | null; modifyDate: string | null }> {
    const m = new Map<string, { serverObjectId: number | null; modifyDate: string | null }>();
    for (const r of this.db.prepare(`SELECT kind, schema_name, name, server_object_id, modify_date FROM dependency_state`).all() as Array<
      Record<string, unknown>
    >) {
      m.set(`${r.kind}|${r.schema_name}|${r.name}`.toLowerCase(), {
        serverObjectId: r.server_object_id === null ? null : Number(r.server_object_id),
        modifyDate: (r.modify_date as string | null) ?? null,
      });
    }
    return m;
  }

  /**
   * Replaces the dependencies of `computed` objects and deletes those of `removed` objects, in ONE
   * transaction. `computed[i].deps` may be empty (object has no dependencies). Returns the
   * `kind|schema|name` keys (lower case) whose stored dependency rows actually changed.
   */
  applyDependencies(
    computed: Array<{ object: ObjectKey & { serverObjectId: number; modifyDate: string }; deps: ExtractedDependency[] }>,
    removed: ObjectKey[],
  ): Set<string> {
    const now = new Date().toISOString();
    const delDeps = this.db.prepare(`DELETE FROM dependencies WHERE from_kind = ? AND from_schema = ? AND from_name = ?`);
    const delState = this.db.prepare(`DELETE FROM dependency_state WHERE kind = ? AND schema_name = ? AND name = ?`);
    const selDeps = this.db.prepare(
      `SELECT ref_server, ref_database, ref_schema, ref_name, ref_kind, is_selected, is_updated, source, columns_json FROM dependencies WHERE from_kind = ? AND from_schema = ? AND from_name = ? ORDER BY ref_schema, ref_name`,
    );
    const ins = this.db.prepare(`
      INSERT INTO dependencies (from_kind, from_schema, from_name, ref_server, ref_database, ref_schema, ref_name, ref_kind,
        ref_type_code, ref_resolved, is_ambiguous, is_caller_dependent, is_selected, is_updated, is_select_all, is_incomplete,
        columns_json, source)
      VALUES (@fromKind, @fromSchema, @fromName, @refServer, @refDatabase, @refSchema, @refName, @refKind,
        @refTypeCode, @refResolved, @isAmbiguous, @isCallerDependent, @isSelected, @isUpdated, @isSelectAll, @isIncomplete,
        @columnsJson, @source)`);
    const upState = this.db.prepare(`
      INSERT INTO dependency_state (kind, schema_name, name, server_object_id, modify_date, computed_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (kind, schema_name, name) DO UPDATE SET server_object_id = excluded.server_object_id,
        modify_date = excluded.modify_date, computed_at = excluded.computed_at`);
    const changed = new Set<string>();
    this.db.transaction(() => {
      for (const { object: o, deps } of computed) {
        const before = JSON.stringify(selDeps.all(o.kind, o.schema, o.name));
        delDeps.run(o.kind, o.schema, o.name);
        for (const d of deps) {
          ins.run({
            fromKind: o.kind,
            fromSchema: o.schema,
            fromName: o.name,
            refServer: d.refServer,
            refDatabase: d.refDatabase,
            refSchema: d.refSchema,
            refName: d.refName,
            refKind: d.refKind,
            refTypeCode: d.refTypeCode,
            refResolved: d.refResolved ? 1 : 0,
            isAmbiguous: d.isAmbiguous ? 1 : 0,
            isCallerDependent: d.isCallerDependent ? 1 : 0,
            isSelected: toInt(d.isSelected),
            isUpdated: toInt(d.isUpdated),
            isSelectAll: toInt(d.isSelectAll),
            isIncomplete: toInt(d.isIncomplete),
            columnsJson: d.columns.length ? JSON.stringify(d.columns) : null,
            source: d.sources.join(','),
          });
        }
        upState.run(o.kind, o.schema, o.name, o.serverObjectId, o.modifyDate, now);
        if (JSON.stringify(selDeps.all(o.kind, o.schema, o.name)) !== before) changed.add(`${o.kind}|${o.schema}|${o.name}`.toLowerCase());
      }
      for (const o of removed) {
        delDeps.run(o.kind, o.schema, o.name);
        delState.run(o.kind, o.schema, o.name);
      }
    })();
    return changed;
  }

  private mapDep(r: Record<string, unknown>): CachedDependencyRow {
    return {
      fromKind: r.from_kind as ObjectKind,
      fromSchema: String(r.from_schema),
      fromName: String(r.from_name),
      refServer: (r.ref_server as string | null) ?? null,
      refDatabase: (r.ref_database as string | null) ?? null,
      refSchema: (r.ref_schema as string | null) ?? null,
      refName: String(r.ref_name),
      refKind: r.ref_kind as CachedDependencyRow['refKind'],
      refTypeCode: (r.ref_type_code as string | null) ?? null,
      refResolved: r.ref_resolved === 1,
      isAmbiguous: r.is_ambiguous === 1,
      isCallerDependent: r.is_caller_dependent === 1,
      isSelected: triBool(r.is_selected),
      isUpdated: triBool(r.is_updated),
      isSelectAll: triBool(r.is_select_all),
      isIncomplete: triBool(r.is_incomplete),
      columns: r.columns_json ? (JSON.parse(String(r.columns_json)) as CachedDependencyRow['columns']) : [],
      source: String(r.source).split(',').filter(Boolean) as CachedDependencyRow['source'],
    };
  }

  allDependencies(): CachedDependencyRow[] {
    return (this.db.prepare(`SELECT * FROM dependencies ORDER BY from_kind, from_schema, from_name, ref_schema, ref_name`).all() as Array<
      Record<string, unknown>
    >).map((r) => this.mapDep(r));
  }

  /* ------------------------------------------------------------ jobs */

  /**
   * Replaces all jobs + executions of ONE source in a single transaction and returns counts.
   * Rows of the other source are untouched.
   */
  applyJobs(source: JobSourceKind, jobs: ExtractedJob[], executions: ExtractedExecution[]): SegmentCounts {
    const now = new Date().toISOString();
    const prev = new Map<string, string>();
    for (const r of this.db.prepare(`SELECT job_id, content_sha256 FROM jobs WHERE source = ?`).all(source) as Array<{ job_id: string; content_sha256: string }>) {
      prev.set(r.job_id, r.content_sha256);
    }
    const counts: SegmentCounts = { added: 0, updated: 0, removed: 0, unchanged: 0 };
    const upsert = this.db.prepare(`
      INSERT INTO jobs (job_id, source, name, enabled, version, details_json, content_sha256, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (job_id) DO UPDATE SET source = excluded.source, name = excluded.name, enabled = excluded.enabled, version = excluded.version,
        details_json = excluded.details_json, content_sha256 = excluded.content_sha256, fetched_at = excluded.fetched_at`);
    const del = this.db.prepare(`DELETE FROM jobs WHERE job_id = ?`);
    const delByName = this.db.prepare(`DELETE FROM jobs WHERE source = ? AND name = ? AND job_id <> ?`);
    const insExec = this.db.prepare(`
      INSERT INTO job_executions (source, job_execution_id, job_id, job_name, step_id, step_name, lifecycle, is_active, create_time, start_time,
        end_time, last_message, target_server_name, target_database_name, current_attempts, details_json)
      VALUES (@source, @jobExecutionId, @jobId, @jobName, @stepId, @stepName, @lifecycle, @isActive, @createTime, @startTime,
        @endTime, @lastMessage, @targetServerName, @targetDatabaseName, @currentAttempts, @detailsJson)`);
    this.db.transaction(() => {
      const seen = new Set<string>();
      for (const j of jobs) {
        seen.add(j.jobId);
        const sha = jobContentSha(j);
        const before = prev.get(j.jobId);
        if (before === undefined) counts.added++;
        else if (before !== sha) counts.updated++;
        else counts.unchanged++;
        delByName.run(source, j.name, j.jobId);
        upsert.run(j.jobId, source, j.name, j.enabled ? 1 : 0, j.version, JSON.stringify(j), sha, now);
      }
      for (const id of prev.keys()) {
        if (!seen.has(id)) {
          del.run(id);
          counts.removed++;
        }
      }
      this.db.prepare(`DELETE FROM job_executions WHERE source = ?`).run(source);
      for (const e of executions) {
        insExec.run({
          source,
          jobExecutionId: e.jobExecutionId,
          jobId: e.jobId,
          jobName: e.jobName,
          stepId: e.stepId,
          stepName: e.stepName,
          lifecycle: e.lifecycle,
          isActive: e.isActive ? 1 : 0,
          createTime: e.createTime,
          startTime: e.startTime,
          endTime: e.endTime,
          lastMessage: e.lastMessage,
          targetServerName: e.targetServerName,
          targetDatabaseName: e.targetDatabaseName,
          currentAttempts: e.currentAttempts,
          detailsJson: JSON.stringify({
            jobVersion: e.jobVersion,
            targetType: e.targetType,
            targetGroupName: e.targetGroupName,
            runStatus: e.runStatus,
            durationSeconds: e.durationSeconds,
          }),
        });
      }
    })();
    return counts;
  }

  /** Removes every job (and execution) of a source; returns how many jobs were removed. */
  clearJobs(source: JobSourceKind): number {
    let removed = 0;
    this.db.transaction(() => {
      removed = this.db.prepare(`DELETE FROM jobs WHERE source = ?`).run(source).changes;
      this.db.prepare(`DELETE FROM job_executions WHERE source = ?`).run(source);
    })();
    return removed;
  }

  listJobs(): CachedJobRow[] {
    return (this.db.prepare(`SELECT * FROM jobs ORDER BY source, name`).all() as Array<Record<string, unknown>>).map((r) => ({
      jobId: String(r.job_id),
      source: r.source as JobSourceKind,
      name: String(r.name),
      enabled: r.enabled === 1,
      version: Number(r.version),
      details: JSON.parse(String(r.details_json)) as ExtractedJob,
      fetchedAt: String(r.fetched_at),
    }));
  }

  listExecutions(jobId?: string): ExtractedExecution[] {
    const rows = (jobId
      ? this.db.prepare(`SELECT * FROM job_executions WHERE job_id = ? ORDER BY create_time DESC, id`).all(jobId)
      : this.db.prepare(`SELECT * FROM job_executions ORDER BY create_time DESC, id`).all()) as Array<Record<string, unknown>>;
    return rows.map((r) => {
      const extra = r.details_json ? (JSON.parse(String(r.details_json)) as Record<string, unknown>) : {};
      return {
        source: r.source as JobSourceKind,
        jobExecutionId: String(r.job_execution_id),
        jobName: String(r.job_name),
        stepId: r.step_id === null ? null : Number(r.step_id),
        stepName: (r.step_name as string | null) ?? null,
        lifecycle: String(r.lifecycle ?? ''),
        isActive: r.is_active === 1,
        createTime: (r.create_time as string | null) ?? null,
        startTime: (r.start_time as string | null) ?? null,
        endTime: (r.end_time as string | null) ?? null,
        lastMessage: (r.last_message as string | null) ?? null,
        targetServerName: (r.target_server_name as string | null) ?? null,
        targetDatabaseName: (r.target_database_name as string | null) ?? null,
        currentAttempts: r.current_attempts === null ? null : Number(r.current_attempts),
        runStatus: (extra.runStatus as string | null) ?? null,
        durationSeconds: (extra.durationSeconds as number | null) ?? null,
        jobId: (r.job_id as string | null) ?? null,
        jobVersion: (extra.jobVersion as number | null) ?? null,
        targetType: (extra.targetType as string | null) ?? null,
        targetGroupName: (extra.targetGroupName as string | null) ?? null,
      };
    });
  }

  /* ------------------------------------------------------------ analysis */

  /** target_key -> (analyzer_version, definition_sha256) of the stored analysis (latest row per key). */
  analysisStates(): Map<string, { analyzerVersion: string; definitionSha256: string | null }> {
    const m = new Map<string, { analyzerVersion: string; definitionSha256: string | null }>();
    for (const r of this.db.prepare(`SELECT target_key, analyzer_version, definition_sha256 FROM analysis ORDER BY analyzed_at`).all() as Array<
      Record<string, unknown>
    >) {
      m.set(String(r.target_key), { analyzerVersion: String(r.analyzer_version), definitionSha256: (r.definition_sha256 as string | null) ?? null });
    }
    return m;
  }

  /** Replaces the analysis of every upserted key (all analyzer versions) and deletes removed keys, in ONE transaction. */
  applyAnalysis(upserts: AnalysisUpsert[], removed: string[]): void {
    const now = new Date().toISOString();
    const del = this.db.prepare(`DELETE FROM analysis WHERE target_key = ?`);
    const ins = this.db.prepare(`
      INSERT INTO analysis (target_key, analyzer_version, definition_sha256, analysis_json, analyzed_at, flags_json, refs_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    this.db.transaction(() => {
      for (const u of upserts) {
        del.run(u.targetKey);
        ins.run(u.targetKey, u.analysis.analyzerVersion, u.definitionSha256, JSON.stringify(u.analysis), now, JSON.stringify(u.flags), JSON.stringify(u.refs));
      }
      for (const k of removed) del.run(k);
    })();
  }

  getAnalysis(targetKey: string): StoredAnalysis | null {
    const r = this.db
      .prepare(`SELECT target_key, analyzer_version, definition_sha256, analysis_json, analyzed_at FROM analysis WHERE target_key = ? ORDER BY analyzed_at DESC LIMIT 1`)
      .get(targetKey) as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      targetKey: String(r.target_key),
      analyzerVersion: String(r.analyzer_version),
      definitionSha256: (r.definition_sha256 as string | null) ?? null,
      analyzedAt: String(r.analyzed_at),
      analysis: JSON.parse(String(r.analysis_json)) as ModuleAnalysis,
    };
  }

  /** Compact flags + refs of every analysis row (rows written before schema v2 have none and are skipped). */
  listAnalysisRefs(): StoredAnalysisRefs[] {
    const rows = this.db.prepare(`SELECT target_key, flags_json, refs_json FROM analysis WHERE refs_json IS NOT NULL ORDER BY analyzed_at`).all() as Array<
      Record<string, unknown>
    >;
    const byKey = new Map<string, StoredAnalysisRefs>();
    for (const r of rows) {
      byKey.set(String(r.target_key), {
        targetKey: String(r.target_key),
        flags: JSON.parse(String(r.flags_json)) as AnalysisFlags,
        refs: JSON.parse(String(r.refs_json)) as AnalysisRefs,
      });
    }
    return [...byKey.values()];
  }

  /**
   * The few code-risk fields of every analysis row (latest row per key), extracted by SQLite (json_extract) so
   * insights never parse whole analyses (outlines are large).
   */
  listAnalysisSignals(): AnalysisSignals[] {
    const rows = this.db
      .prepare(
        `SELECT target_key,
                json_extract(analysis_json, '$.transactions') AS tx,
                json_extract(analysis_json, '$.hasTryCatch') AS try_catch,
                json_extract(analysis_json, '$.cursors') AS cursors,
                json_extract(analysis_json, '$.dynamicSql') AS dyn,
                json_extract(analysis_json, '$.linkedServers') AS linked
         FROM analysis ORDER BY analyzed_at`,
      )
      .all() as Array<Record<string, unknown>>;
    const byKey = new Map<string, AnalysisSignals>();
    const arr = <T>(v: unknown): T[] => (typeof v === 'string' ? (JSON.parse(v) as T[]) : []);
    for (const r of rows) {
      const tx = typeof r.tx === 'string' ? (JSON.parse(r.tx) as AnalysisSignals['transactions']) : { begin: 0, commit: 0, rollback: 0, save: 0 };
      byKey.set(String(r.target_key), {
        targetKey: String(r.target_key),
        transactions: tx,
        hasTryCatch: r.try_catch === 1 || r.try_catch === true,
        cursors: arr<{ name: string; line: number }>(r.cursors).map((c) => c.name),
        dynamicSqlKinds: arr<{ kind: string }>(r.dyn).map((d) => d.kind),
        linkedServers: arr<string>(r.linked),
      });
    }
    return [...byKey.values()];
  }

  /** Segments that completed (have counts) in any stored refresh run, i.e. whose data has been read at least once. */
  refreshedSegments(): Set<string> {
    const out = new Set<string>();
    for (const r of this.db.prepare(`SELECT counts_json FROM refresh_runs`).all() as Array<{ counts_json: string }>) {
      for (const k of Object.keys(JSON.parse(r.counts_json) as Record<string, unknown>)) out.add(k);
    }
    return out;
  }

  /* ------------------------------------------------------------ ai descriptions */

  private mapAi<C = AiDescriptionContent>(r: Record<string, unknown>): StoredAi<C> {
    return {
      targetKey: String(r.target_key),
      definitionSha256: (r.definition_sha256 as string | null) ?? null,
      model: String(r.model),
      promptVersion: String(r.prompt_version),
      effort: String(r.effort),
      content: JSON.parse(String(r.content_json)) as C,
      usage: r.usage_json ? (JSON.parse(String(r.usage_json)) as StoredAi['usage']) : null,
      createdAt: String(r.created_at),
    };
  }

  /** Latest AI description of a key (any model / prompt version). */
  getAi(targetKey: string): StoredAi | null {
    const r = this.db.prepare(`SELECT * FROM ai_descriptions WHERE target_key = ? ORDER BY created_at DESC LIMIT 1`).get(targetKey) as
      | Record<string, unknown>
      | undefined;
    return r ? this.mapAi(r) : null;
  }

  getAiFor<C = AiDescriptionContent>(targetKey: string, model: string, promptVersion: string): StoredAi<C> | null {
    const r = this.db.prepare(`SELECT * FROM ai_descriptions WHERE target_key = ? AND model = ? AND prompt_version = ?`).get(targetKey, model, promptVersion) as
      | Record<string, unknown>
      | undefined;
    return r ? this.mapAi<C>(r) : null;
  }

  saveAi(a: StoredAi<unknown>): void {
    this.db
      .prepare(`
        INSERT INTO ai_descriptions (target_key, definition_sha256, model, prompt_version, effort, content_json, usage_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (target_key, model, prompt_version) DO UPDATE SET definition_sha256 = excluded.definition_sha256, effort = excluded.effort,
          content_json = excluded.content_json, usage_json = excluded.usage_json, created_at = excluded.created_at`)
      .run(a.targetKey, a.definitionSha256, a.model, a.promptVersion, a.effort, JSON.stringify(a.content), a.usage ? JSON.stringify(a.usage) : null, a.createdAt);
  }

  /* ------------------------------------------------------------ refresh runs */

  saveRun(run: RefreshRun): void {
    this.db
      .prepare(`
        INSERT INTO refresh_runs (id, status, started_at, finished_at, request_json, progress_json, counts_json, warnings_json, segment_errors_json, error)
        VALUES (@id, @status, @startedAt, @finishedAt, @request, @progress, @counts, @warnings, @segmentErrors, @error)
        ON CONFLICT (id) DO UPDATE SET status = excluded.status, finished_at = excluded.finished_at, progress_json = excluded.progress_json,
          counts_json = excluded.counts_json, warnings_json = excluded.warnings_json, segment_errors_json = excluded.segment_errors_json,
          error = excluded.error`)
      .run({
        id: run.id,
        status: run.status,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        request: JSON.stringify(run.request),
        progress: JSON.stringify(run.progress),
        counts: JSON.stringify(run.counts),
        warnings: JSON.stringify(run.warningDetails),
        segmentErrors: run.segmentErrors ? JSON.stringify(run.segmentErrors) : null,
        error: run.error ?? null,
      });
  }

  private mapRun(r: Record<string, unknown>, connectionId: string): RefreshRun {
    // warnings_json: RunWarning[] (current) or string[] (rows written before structured warnings); elements may mix
    const warningDetails = (JSON.parse(String(r.warnings_json)) as Array<string | RunWarning>).map((w): RunWarning => (typeof w === 'string' ? { message: w } : w));
    const run: RefreshRun = {
      id: String(r.id),
      connectionId,
      status: r.status as RefreshRun['status'],
      startedAt: String(r.started_at),
      finishedAt: (r.finished_at as string | null) ?? null,
      request: JSON.parse(String(r.request_json)) as RefreshRun['request'],
      progress: JSON.parse(String(r.progress_json)) as RefreshRun['progress'],
      counts: JSON.parse(String(r.counts_json)) as RefreshRun['counts'],
      warnings: warningDetails.map((w) => w.message),
      warningDetails,
    };
    if (r.segment_errors_json) run.segmentErrors = JSON.parse(String(r.segment_errors_json)) as RefreshRun['segmentErrors'];
    if (r.error) run.error = String(r.error);
    return run;
  }

  getRun(id: string, connectionId: string): RefreshRun | null {
    const r = this.db.prepare(`SELECT * FROM refresh_runs WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return r ? this.mapRun(r, connectionId) : null;
  }

  /** newest first; `before`: only runs ordered strictly after it (started_at DESC, id DESC) */
  listRuns(connectionId: string, limit = 20, before?: { startedAt: string; id: string }): RefreshRun[] {
    const rows = before
      ? this.db
          .prepare(`SELECT * FROM refresh_runs WHERE started_at < @startedAt OR (started_at = @startedAt AND id < @id) ORDER BY started_at DESC, id DESC LIMIT @limit`)
          .all({ startedAt: before.startedAt, id: before.id, limit })
      : this.db.prepare(`SELECT * FROM refresh_runs ORDER BY started_at DESC, id DESC LIMIT ?`).all(limit);
    return (rows as Array<Record<string, unknown>>).map((r) => this.mapRun(r, connectionId));
  }

  lastFinishedRun(connectionId: string): RefreshRun | null {
    const r = this.db.prepare(`SELECT * FROM refresh_runs WHERE status <> 'running' ORDER BY started_at DESC LIMIT 1`).get() as
      | Record<string, unknown>
      | undefined;
    return r ? this.mapRun(r, connectionId) : null;
  }
}
