import type sql from 'mssql';
import type { ObjectKind } from '../../shared/types';
import { DATABASE_SCOPE_SCHEMA } from '../../shared/types';
import { errorMessage, queryRows, runQuery, sqlErrorNumbers, type QueryOptions } from '../db/query';
import { kindFromTypeCode, type ListedObject } from './catalog';
import * as Q from './sql/dependencies';

export type DependencySource = 'expression-dependencies' | 'referenced-entities';

export interface ExtractedDependency {
  refServer: string | null;
  refDatabase: string | null;
  refSchema: string | null;
  refName: string;
  refKind: ObjectKind | 'unknown' | 'external';
  refTypeCode: string | null;
  /** the server bound the reference (referenced_id not null) */
  refResolved: boolean;
  isAmbiguous: boolean;
  isCallerDependent: boolean;
  isSelected: boolean | null;
  isUpdated: boolean | null;
  isSelectAll: boolean | null;
  isIncomplete: boolean | null;
  columns: Array<{ name: string; isSelected: boolean; isUpdated: boolean }>;
  sources: DependencySource[];
}

export interface ModuleIssue {
  object: ListedObject;
  message: string;
}

export interface DependencyExtraction {
  /** keyed by referencing ListedObject.objectId; every requested object has an entry (possibly empty) */
  byObject: Map<number, ExtractedDependency[]>;
  /** binding errors (invalid column / object): the module would fail to compile today */
  stale: ModuleIssue[];
  /** references to objects that do not exist (deferred name resolution) */
  missingReferences: ModuleIssue[];
  /** referenced-entities could not be read for the module (caught server-side or request error) */
  failed: ModuleIssue[];
}

/** Objects whose dependencies are final, with the issues of exactly those objects (see DependencyContext.onBatch). */
export interface DependencyBatch {
  objects: Array<{ object: ListedObject; deps: ExtractedDependency[] }>;
  stale: ModuleIssue[];
  missingReferences: ModuleIssue[];
  failed: ModuleIssue[];
}

/** Completed modules per DependencyContext.onBatch call. */
export const DEPENDENCY_BATCH_SIZE = 100;

export interface DependencyContext {
  pool: sql.ConnectionPool;
  query: QueryOptions;
  currentDatabase: string;
  expressionDependencies: boolean;
  concurrency: number;
  /** wall-clock limit for the bulk sys.sql_expression_dependencies query (default: query.timeoutMs) */
  bulkQueryTimeoutMs?: number;
  onProgress?: (done: number, total: number) => void;
  /** human-readable sub-step of the extraction (shown next to the phase) */
  onStep?: (step: string) => void;
  /** concise progress log lines (no per-row / per-module output) */
  log?: (msg: string) => void;
  /**
   * Called (synchronously) with results as they become final: once for the non-module objects after the bulk
   * query, then every `batchSize` completed modules and once for the rest at the end of the module loop (also
   * when the loop is aborted). Modules still in flight when the signal aborts are not reported.
   */
  onBatch?: (batch: DependencyBatch) => void;
  /** completed modules per onBatch call (default DEPENDENCY_BATCH_SIZE) */
  batchSize?: number;
}

const MODULE_KINDS: ReadonlySet<ObjectKind> = new Set(['procedure', 'view', 'function', 'trigger']);
const PSEUDO_TABLES = new Set(['inserted', 'deleted']);
/** binding errors that mean "this module no longer compiles" */
const STALE_ERRORS = new Set([207, 208, 209, 213, 4104, 4121, 8144, 2812, 1913]);

const bool = (v: unknown): boolean => v === true || v === 1;
const nn = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v);
  return s === '' ? null : s;
};

function quoteName(s: string): string {
  return `[${s.replace(/]/g, ']]')}]`;
}

export function moduleNameParam(o: ListedObject): { name: string; cls: string } {
  if (o.typeCode === 'DDLTR') return { name: quoteName(o.name), cls: 'DATABASE_DDL_TRIGGER' };
  return { name: `${quoteName(o.schema)}.${quoteName(o.name)}`, cls: 'OBJECT' };
}

interface RawRef {
  server: string | null;
  database: string | null;
  schema: string | null;
  entity: string;
  referencedId: number | null;
  resolvedSchema: string | null;
  resolvedName: string | null;
  referencedType: string | null;
  column: string | null;
  isCallerDependent: boolean;
  isAmbiguous: boolean;
  isSelected: boolean | null;
  isUpdated: boolean | null;
  isSelectAll: boolean | null;
  isAllColumnsFound: boolean | null;
  isIncomplete: boolean | null;
}

class Merger {
  private readonly items = new Map<string, ExtractedDependency & { _flagRows: RawRef[] }>();

  constructor(
    private readonly owner: ListedObject,
    private readonly currentDb: string,
  ) {}

  add(raw: RawRef, source: DependencySource): void {
    if (!raw.entity) return;
    let database = raw.database;
    if (database && database.toLowerCase() === this.currentDb.toLowerCase() && !raw.server) database = null;
    const external = Boolean(raw.server) || Boolean(database);
    if (!external && raw.referencedId === null && raw.schema === null && PSEUDO_TABLES.has(raw.entity.toLowerCase())) return;
    if (!external && raw.referencedId !== null && raw.referencedId === this.owner.objectId) return; // computed-column / constraint self-reference
    const resolved = !external && raw.referencedId !== null && raw.resolvedName !== null;
    const schema = resolved ? raw.resolvedSchema : raw.schema;
    const name = resolved ? (raw.resolvedName as string) : raw.entity;
    const key = (resolved ? `local|${schema}|${name}` : `${raw.server ?? ''}|${database ?? ''}|${schema ?? ''}|${name}`).toLowerCase();
    let item = this.items.get(key);
    if (!item) {
      const k = resolved ? kindFromTypeCode(raw.referencedType) : null;
      item = {
        refServer: raw.server,
        refDatabase: database,
        refSchema: schema,
        refName: name,
        refKind: external ? 'external' : (k ?? 'unknown'),
        refTypeCode: resolved ? raw.referencedType : null,
        refResolved: resolved,
        isAmbiguous: false,
        isCallerDependent: false,
        isSelected: null,
        isUpdated: null,
        isSelectAll: null,
        isIncomplete: null,
        columns: [],
        sources: [],
        _flagRows: [],
      };
      this.items.set(key, item);
    }
    if (!item.sources.includes(source)) item.sources.push(source);
    item.isAmbiguous ||= raw.isAmbiguous;
    item.isCallerDependent ||= raw.isCallerDependent;
    if (source === 'referenced-entities') {
      item._flagRows.push(raw);
      if (raw.column) {
        const existing = item.columns.find((c) => c.name.toLowerCase() === raw.column!.toLowerCase());
        if (existing) {
          existing.isSelected ||= Boolean(raw.isSelected);
          existing.isUpdated ||= Boolean(raw.isUpdated);
        } else item.columns.push({ name: raw.column, isSelected: Boolean(raw.isSelected), isUpdated: Boolean(raw.isUpdated) });
      }
    }
  }

  result(): ExtractedDependency[] {
    const out: ExtractedDependency[] = [];
    for (const item of this.items.values()) {
      const rows = item._flagRows;
      if (rows.length) {
        const anySel = rows.some((r) => r.isSelected === true);
        const anyUpd = rows.some((r) => r.isUpdated === true);
        const incomplete = rows.some((r) => r.isIncomplete === true);
        // Research §2 "flags go blank": with is_incomplete = 1, or a table/view whose columns could not be
        // bound (is_all_columns_found = 0), a 0 flag means "unknown", not "no".
        const columnBearing = item.refKind === 'table' || item.refKind === 'view';
        const allFound = rows.every((r) => r.isAllColumnsFound !== false);
        const reliable = !incomplete && (!columnBearing || allFound);
        item.isSelected = anySel ? true : reliable ? false : null;
        item.isUpdated = anyUpd ? true : reliable ? false : null;
        item.isSelectAll = rows.some((r) => r.isSelectAll === true);
        item.isIncomplete = incomplete;
      }
      const { _flagRows, ...dep } = item;
      void _flagRows;
      dep.columns.sort((a, b) => a.name.localeCompare(b.name));
      out.push(dep);
    }
    return out.sort((a, b) => `${a.refSchema}.${a.refName}`.localeCompare(`${b.refSchema}.${b.refName}`));
  }
}

function rawFromExpression(r: Record<string, unknown>): RawRef {
  return {
    server: nn(r.referenced_server_name),
    database: nn(r.referenced_database_name),
    schema: nn(r.referenced_schema_name),
    entity: String(r.referenced_entity_name ?? ''),
    referencedId: r.referenced_id === null || r.referenced_id === undefined ? null : Number(r.referenced_id),
    resolvedSchema: nn(r.resolved_schema),
    resolvedName: nn(r.resolved_name),
    referencedType: nn(r.referenced_type),
    column: nn(r.referenced_column),
    isCallerDependent: bool(r.is_caller_dependent),
    isAmbiguous: bool(r.is_ambiguous),
    isSelected: null,
    isUpdated: null,
    isSelectAll: null,
    isAllColumnsFound: null,
    isIncomplete: null,
  };
}

function rawFromReferenced(r: Record<string, unknown>): RawRef | null {
  if (r.referenced_class !== null && r.referenced_class !== undefined && Number(r.referenced_class) !== 1) return null;
  const b = (v: unknown): boolean | null => (v === null || v === undefined ? null : bool(v));
  return {
    server: nn(r.referenced_server_name),
    database: nn(r.referenced_database_name),
    schema: nn(r.referenced_schema_name),
    entity: String(r.referenced_entity_name ?? ''),
    referencedId: r.referenced_id === null || r.referenced_id === undefined ? null : Number(r.referenced_id),
    resolvedSchema: nn(r.resolved_schema),
    resolvedName: nn(r.resolved_name),
    referencedType: nn(r.referenced_type),
    column: nn(r.referenced_minor_name),
    isCallerDependent: bool(r.is_caller_dependent),
    isAmbiguous: bool(r.is_ambiguous),
    isSelected: b(r.is_selected),
    isUpdated: b(r.is_updated),
    isSelectAll: b(r.is_select_all),
    isAllColumnsFound: b(r.is_all_columns_found),
    isIncomplete: b(r.is_incomplete),
  };
}

/** Stops starting new items once `signal` is aborted (in-flight items finish or fail on their own). */
async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>, signal?: AbortSignal): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length && !signal?.aborted) {
      const i = next++;
      await fn(items[i]);
    }
  });
  await Promise.all(workers);
}

function describe(o: ListedObject): string {
  return o.schema === DATABASE_SCOPE_SCHEMA ? o.name : `${o.schema}.${o.name}`;
}

/**
 * Dependencies for `referencing` (modules and tables). Tables only get expression dependencies
 * (computed columns, CHECK/DEFAULT constraints); modules additionally get one TRY/CATCH-wrapped
 * sys.dm_sql_referenced_entities call each (concurrency <= ctx.concurrency).
 */
export async function extractDependencies(ctx: DependencyContext, referencing: ListedObject[]): Promise<DependencyExtraction> {
  const byId = new Map(referencing.map((o) => [o.objectId, o]));
  const mergers = new Map<number, Merger>(referencing.map((o) => [o.objectId, new Merger(o, ctx.currentDatabase)]));
  const result: DependencyExtraction = { byObject: new Map(), stale: [], missingReferences: [], failed: [] };

  if (ctx.expressionDependencies && referencing.length) {
    // Unfiltered on purpose: an owner-id filter over the computed owner column is pathologically slow
    // server-side. Owners outside `referencing` are dropped below (no merger for them).
    ctx.onStep?.('Reading expression dependencies');
    ctx.log?.(`dependencies: reading sys.sql_expression_dependencies (${referencing.length} object(s) to compute)`);
    const started = Date.now();
    const rows = await queryRows(ctx.pool, Q.EXPRESSION_DEPENDENCIES, {}, { ...ctx.query, timeoutMs: ctx.bulkQueryTimeoutMs ?? ctx.query.timeoutMs });
    let kept = 0;
    for (const r of rows) {
      const owner = Number(r.owner_id);
      const m = mergers.get(owner);
      if (m) {
        m.add(rawFromExpression(r), 'expression-dependencies');
        kept++;
      }
    }
    ctx.log?.(`dependencies: sys.sql_expression_dependencies returned ${rows.length} row(s), ${kept} kept, in ${Date.now() - started} ms`);
  }

  const emit = (objects: ListedObject[]): void => {
    if (!ctx.onBatch || !objects.length) return;
    const ids = new Set(objects.map((o) => o.objectId));
    const mine = (list: ModuleIssue[]) => list.filter((i) => ids.has(i.object.objectId));
    ctx.onBatch({
      objects: objects.map((o) => ({ object: o, deps: mergers.get(o.objectId)!.result() })),
      stale: mine(result.stale),
      missingReferences: mine(result.missingReferences),
      failed: mine(result.failed),
    });
  };
  // Non-module objects (tables) only have expression dependencies: final once the bulk query is read.
  emit(referencing.filter((o) => !MODULE_KINDS.has(o.kind)));

  const modules = referencing.filter((o) => MODULE_KINDS.has(o.kind));
  const batchSize = Math.max(1, ctx.batchSize ?? DEPENDENCY_BATCH_SIZE);
  let pending: ListedObject[] = [];
  // a failing onBatch (cache write) stops the loop: no new modules start, nothing more is reported
  const stop = new AbortController();
  let batchError: unknown = null;
  const flush = (): void => {
    const batch = pending;
    pending = [];
    if (batchError !== null) return;
    try {
      emit(batch);
    } catch (err) {
      batchError = err;
      stop.abort(err);
    }
  };
  let done = 0;
  const loopStarted = Date.now();
  const loopStatus = (): string => `${done}/${modules.length}, failed ${result.failed.length}, elapsed ${Date.now() - loopStarted} ms`;
  ctx.onStep?.('Resolving module references');
  ctx.log?.(`dependencies: resolving references of ${modules.length} module(s) (concurrency ${ctx.concurrency})`);
  ctx.onProgress?.(0, modules.length);
  await mapLimit(modules, ctx.concurrency, async (o) => {
    const { name, cls } = moduleNameParam(o);
    const params = { name: { type: 'nvarchar' as const, value: name, length: 1100 }, class: { type: 'nvarchar' as const, value: cls, length: 60 } };
    try {
      const [rows = [], errRows = []] = await runQuery(ctx.pool, Q.REFERENCED_ENTITIES, params, ctx.query);
      const m = mergers.get(o.objectId)!;
      let incomplete = false;
      for (const r of rows) {
        const raw = rawFromReferenced(r);
        if (!raw) continue;
        if (raw.isIncomplete) incomplete = true;
        m.add(raw, 'referenced-entities');
      }
      const caught = errRows[0] as Record<string, unknown> | undefined;
      if (caught && caught.error_number !== null && caught.error_number !== undefined) {
        result.failed.push({ object: o, message: `Msg ${caught.error_number}: ${caught.error_message}` });
      } else if (incomplete) {
        await diagnose(ctx, o, params, result);
      }
    } catch (err) {
      result.failed.push({ object: o, message: errorMessage(err) });
    } finally {
      done++;
      // a module interrupted by the abort is incomplete: not reported, so the next run computes it again
      if (!ctx.query.signal?.aborted) {
        pending.push(o);
        if (pending.length >= batchSize) flush();
      }
      ctx.onProgress?.(done, modules.length);
      if (done % 100 === 0 && done < modules.length) ctx.log?.(`dependencies: modules ${loopStatus()}`);
    }
  }, ctx.query.signal ? AbortSignal.any([ctx.query.signal, stop.signal]) : stop.signal);
  // modules completed before an abort are reported too (the caller saves them, the next run skips them)
  flush();
  if (batchError !== null) throw batchError;
  if (ctx.query.signal?.aborted) {
    ctx.log?.(`dependencies: modules aborted ${loopStatus()}`);
    ctx.query.signal.throwIfAborted();
  }
  ctx.log?.(`dependencies: modules done ${loopStatus()}`);

  for (const [id, m] of mergers) {
    if (byId.has(id)) result.byObject.set(id, m.result());
  }
  return result;
}

async function diagnose(
  ctx: DependencyContext,
  o: ListedObject,
  params: Parameters<typeof runQuery>[2],
  result: DependencyExtraction,
): Promise<void> {
  try {
    await runQuery(ctx.pool, Q.REFERENCED_ENTITIES_DIAGNOSE, params, ctx.query);
  } catch (err) {
    const numbers = sqlErrorNumbers(err);
    const all = [err, ...(((err as { precedingErrors?: unknown[] }).precedingErrors ?? []) as unknown[])] as Array<{ number?: number; message?: string }>;
    const staleErr = all.find((e) => typeof e?.number === 'number' && STALE_ERRORS.has(e.number));
    if (staleErr) {
      result.stale.push({ object: o, message: `Msg ${staleErr.number}: ${staleErr.message}` });
    } else if (numbers.includes(2020)) {
      result.missingReferences.push({ object: o, message: 'references objects that do not exist (Msg 2020)' });
    }
  }
}

export { describe as describeObject };
