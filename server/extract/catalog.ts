import type sql from 'mssql';
import type {
  CheckConstraintInfo,
  ColumnInfo,
  DefinitionStatus,
  ForeignKeyInfo,
  FunctionDetails,
  FunctionType,
  IndexInfo,
  ModuleSettings,
  ObjectDetails,
  ObjectKind,
  ParameterInfo,
  ProcedureDetails,
  RowCountSource,
  TableDetails,
  TriggerDetails,
  ViewDetails,
} from '../../shared/types';
import { DATABASE_SCOPE_SCHEMA } from '../../shared/types';
import { queryRows, type QueryOptions } from '../db/query';
import * as Q from './sql/catalog';

/* ------------------------------------------------------------------ shapes */

export interface ListedObject {
  objectId: number;
  kind: ObjectKind;
  schema: string;
  name: string;
  typeCode: string;
  createDate: string;
  modifyDate: string;
  parentObjectId: number;
}

export interface ExtractedObject extends ListedObject {
  definition: string | null;
  isEncrypted: boolean;
  rowCount: number | null;
  details: ObjectDetails;
}

export interface CatalogContext {
  pool: sql.ConnectionPool;
  query: QueryOptions;
  rowCountSource: RowCountSource;
}

/* ------------------------------------------------------------------ helpers */

export function kindFromTypeCode(type: string | null | undefined): ObjectKind | null {
  switch ((type ?? '').trim()) {
    case 'U':
      return 'table';
    case 'V':
      return 'view';
    case 'P':
    case 'PC':
    case 'X':
      return 'procedure';
    case 'FN':
    case 'IF':
    case 'TF':
    case 'FS':
    case 'FT':
      return 'function';
    case 'TR':
    case 'TA':
    case 'DDLTR':
      return 'trigger';
    default:
      return null;
  }
}

export function toIso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string') return v;
  return '';
}

function toIsoOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return toIso(v) || null;
}

const bool = (v: unknown): boolean => v === true || v === 1;
const boolOrNull = (v: unknown): boolean | null => (v === null || v === undefined ? null : bool(v));
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

/** Above this many ids a detail query fetches everything and filters client-side. */
const MAX_ID_FILTER = 3000;

function idsParam(objects: ListedObject[] | null): { ids: { type: 'nvarcharMax'; value: string | null } } {
  if (!objects || objects.length > MAX_ID_FILTER) return { ids: { type: 'nvarcharMax', value: null } };
  // An empty filter must match nothing: object_id is never 0.
  const xml = objects.length ? objects.map((o) => `<i>${Math.trunc(o.objectId)}</i>`).join('') : '<i>0</i>';
  return { ids: { type: 'nvarcharMax', value: xml } };
}

function groupBy<T>(rows: T[], key: (r: T) => number): Map<number, T[]> {
  const m = new Map<number, T[]>();
  for (const r of rows) {
    const k = key(r);
    let arr = m.get(k);
    if (!arr) m.set(k, (arr = []));
    arr.push(r);
  }
  return m;
}

function definitionStatus(definition: unknown, isEncrypted: boolean, hasModule: boolean): DefinitionStatus {
  if (!hasModule) return 'clr';
  if (definition !== null && definition !== undefined) return 'ok';
  return isEncrypted ? 'encrypted' : 'no-permission';
}

function moduleSettings(r: Record<string, unknown>): ModuleSettings {
  return {
    usesAnsiNulls: boolOrNull(r.uses_ansi_nulls),
    usesQuotedIdentifier: boolOrNull(r.uses_quoted_identifier),
    isSchemaBound: boolOrNull(r.is_schema_bound),
    executeAs: strOrNull(r.execute_as),
  };
}

/* ------------------------------------------------------------------ listing */

export async function listObjects(pool: sql.ConnectionPool, query: QueryOptions): Promise<ListedObject[]> {
  const rows = await queryRows(pool, Q.LIST_OBJECTS, {}, query);
  const out: ListedObject[] = [];
  for (const r of rows) {
    const typeCode = String(r.type_code);
    const kind = kindFromTypeCode(typeCode);
    if (!kind) continue;
    out.push({
      objectId: Number(r.object_id),
      kind,
      schema: typeCode === 'DDLTR' ? DATABASE_SCOPE_SCHEMA : String(r.schema_name),
      name: String(r.object_name),
      typeCode,
      createDate: toIso(r.create_date),
      modifyDate: toIso(r.modify_date),
      parentObjectId: Number(r.parent_object_id ?? 0),
    });
  }
  return out;
}

/* ------------------------------------------------------------------ detail rows -> shapes */

function mapParameters(rows: Record<string, unknown>[]): { params: ParameterInfo[]; returnType: string | null } {
  const params: ParameterInfo[] = [];
  let returnType: string | null = null;
  for (const r of rows) {
    if (Number(r.parameter_id) === 0) {
      returnType = strOrNull(r.type_display);
      continue;
    }
    params.push({
      ordinal: Number(r.parameter_id),
      name: String(r.name),
      type: String(r.type_display),
      isOutput: bool(r.is_output),
      isReadOnly: bool(r.is_readonly),
      isTableType: bool(r.is_table_type),
      default: null,
    });
  }
  return { params, returnType };
}

function mapColumns(rows: Record<string, unknown>[]): ColumnInfo[] {
  return rows.map((r) => ({
    ordinal: Number(r.column_id),
    name: String(r.column_name),
    type: String(r.type_display),
    nullable: bool(r.is_nullable),
    isIdentity: bool(r.is_identity),
    identitySeed: strOrNull(r.identity_seed),
    identityIncrement: strOrNull(r.identity_increment),
    isComputed: bool(r.is_computed),
    computedDefinition: strOrNull(r.computed_definition),
    isPersisted: bool(r.is_persisted),
    defaultName: strOrNull(r.default_constraint_name),
    defaultDefinition: strOrNull(r.default_definition),
    collation: strOrNull(r.collation_name),
  }));
}

function mapIndexes(rows: Record<string, unknown>[]): IndexInfo[] {
  const byIndex = groupBy(rows, (r) => Number(r.index_id));
  const out: IndexInfo[] = [];
  for (const [, cols] of [...byIndex.entries()].sort((a, b) => a[0] - b[0])) {
    const f = cols[0];
    out.push({
      name: String(f.index_name),
      type: String(f.type_desc),
      isUnique: bool(f.is_unique),
      isPrimaryKey: bool(f.is_primary_key),
      isUniqueConstraint: bool(f.is_unique_constraint),
      keyColumns: cols
        .filter((c) => !bool(c.is_included_column) && Number(c.key_ordinal) > 0)
        .sort((a, b) => Number(a.key_ordinal) - Number(b.key_ordinal))
        .map((c) => ({ name: String(c.column_name), descending: bool(c.is_descending_key) })),
      includedColumns: cols.filter((c) => bool(c.is_included_column)).map((c) => String(c.column_name)),
      filter: bool(f.has_filter) ? strOrNull(f.filter_definition) : null,
      isDisabled: bool(f.is_disabled),
    });
  }
  return out;
}

function mapForeignKeys(rows: Record<string, unknown>[]): ForeignKeyInfo[] {
  const byFk = groupBy(rows, (r) => Number(r.fk_id));
  const out: ForeignKeyInfo[] = [];
  for (const cols of byFk.values()) {
    const f = cols[0];
    out.push({
      name: String(f.fk_name),
      columns: cols
        .sort((a, b) => Number(a.constraint_column_id) - Number(b.constraint_column_id))
        .map((c) => ({ from: String(c.parent_column), to: String(c.referenced_column) })),
      references: { schema: String(f.ref_schema), name: String(f.ref_table) },
      onDelete: String(f.delete_referential_action_desc),
      onUpdate: String(f.update_referential_action_desc),
      isDisabled: bool(f.is_disabled),
      isNotTrusted: bool(f.is_not_trusted),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function mapChecks(rows: Record<string, unknown>[]): CheckConstraintInfo[] {
  return rows.map((r) => ({
    name: String(r.name),
    column: strOrNull(r.column_name),
    definition: String(r.definition ?? ''),
    isDisabled: bool(r.is_disabled),
  }));
}

function functionTypeOf(code: string): FunctionType {
  if (code === 'IF') return 'inline-tvf';
  if (code === 'TF' || code === 'FT') return 'multi-tvf';
  return 'scalar';
}

/* ------------------------------------------------------------------ synonyms */

export interface ExtractedSynonym {
  schema: string;
  name: string;
  baseObjectName: string;
}

export async function fetchSynonyms(pool: sql.ConnectionPool, query: QueryOptions): Promise<ExtractedSynonym[]> {
  const rows = await queryRows(pool, Q.SYNONYMS, {}, query);
  return rows.map((r) => ({ schema: String(r.schema_name), name: String(r.synonym_name), baseObjectName: String(r.base_object_name) }));
}

/* ------------------------------------------------------------------ per-kind fetchers */

export interface RowCountInfo {
  rows: number;
  reservedKb: number | null;
}

export async function fetchRowCounts(ctx: CatalogContext): Promise<Map<number, RowCountInfo>> {
  const usePs = ctx.rowCountSource === 'dm_db_partition_stats';
  const rows = await queryRows(ctx.pool, usePs ? Q.ROWCOUNTS_PARTITION_STATS : Q.ROWCOUNTS_PARTITIONS, {}, ctx.query);
  const m = new Map<number, RowCountInfo>();
  for (const r of rows) {
    m.set(Number(r.object_id), { rows: Number(r.approx_rows ?? 0), reservedKb: usePs ? Number(r.reserved_kb ?? 0) : null });
  }
  return m;
}

/**
 * Fetches definitions + details for `objects` (all of one kind). Objects that vanished between the
 * listing and the detail query are simply absent from the result.
 */
export async function fetchObjects(ctx: CatalogContext, kind: ObjectKind, objects: ListedObject[]): Promise<ExtractedObject[]> {
  if (!objects.length) return [];
  const p = idsParam(objects);
  const wanted = new Map(objects.map((o) => [o.objectId, o]));
  const out: ExtractedObject[] = [];

  if (kind === 'table') {
    const [tables, columns, indexes, fks, checks, counts] = await Promise.all([
      queryRows(ctx.pool, Q.TABLES, p, ctx.query),
      queryRows(ctx.pool, Q.COLUMNS, p, ctx.query),
      queryRows(ctx.pool, Q.INDEXES, p, ctx.query),
      queryRows(ctx.pool, Q.FOREIGN_KEYS, p, ctx.query),
      queryRows(ctx.pool, Q.CHECK_CONSTRAINTS, p, ctx.query),
      fetchRowCounts(ctx),
    ]);
    const colsBy = groupBy(columns, (r) => Number(r.object_id));
    const idxBy = groupBy(indexes, (r) => Number(r.object_id));
    const fkBy = groupBy(fks, (r) => Number(r.parent_object_id));
    const ckBy = groupBy(checks, (r) => Number(r.parent_object_id));
    for (const t of tables) {
      const id = Number(t.object_id);
      const listed = wanted.get(id);
      if (!listed) continue;
      const idx = mapIndexes(idxBy.get(id) ?? []);
      const pk = idx.find((i) => i.isPrimaryKey);
      const rc = counts.get(id);
      const details: TableDetails = {
        kind: 'table',
        columns: mapColumns(colsBy.get(id) ?? []),
        primaryKey: pk ? { name: pk.name, columns: pk.keyColumns.map((c) => c.name) } : null,
        foreignKeys: mapForeignKeys(fkBy.get(id) ?? []),
        indexes: idx,
        checkConstraints: mapChecks(ckBy.get(id) ?? []),
        rowCount: rc ? rc.rows : null,
        rowCountSource: rc ? ctx.rowCountSource : null,
        reservedKb: rc ? rc.reservedKb : null,
        temporalType: strOrNull(t.temporal_type_desc),
        isMemoryOptimized: bool(t.is_memory_optimized),
      };
      out.push({ ...listed, definition: null, isEncrypted: false, rowCount: details.rowCount, details });
    }
    return out;
  }

  if (kind === 'trigger') {
    const rows = await queryRows(ctx.pool, Q.TRIGGERS, p, ctx.query);
    for (const r of rows) {
      const listed = wanted.get(Number(r.object_id));
      if (!listed) continue;
      const isEncrypted = bool(r.is_encrypted);
      const hasModule = bool(r.has_module);
      const parentClass = Number(r.parent_class);
      const parentType = strOrNull(r.parent_type);
      const details: TriggerDetails = {
        kind: 'trigger',
        triggerType: parentClass === 0 ? 'ddl-database' : 'dml',
        parent:
          parentClass === 1 && r.parent_name
            ? { kind: parentType === 'V' ? 'view' : 'table', schema: String(r.parent_schema), name: String(r.parent_name) }
            : null,
        events: String(r.events ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        isInsteadOf: bool(r.is_instead_of_trigger),
        isDisabled: bool(r.is_disabled),
        isClr: String(r.type_code) === 'TA',
        module: moduleSettings(r),
        definitionStatus: definitionStatus(r.definition, isEncrypted, hasModule),
      };
      out.push({ ...listed, definition: strOrNull(r.definition), isEncrypted, rowCount: null, details });
    }
    return out;
  }

  // procedures, views, functions
  const needParams = kind === 'procedure' || kind === 'function';
  const needColumns = kind === 'view' || kind === 'function';
  const [modules, params, columns, indexes] = await Promise.all([
    queryRows(ctx.pool, Q.MODULES, p, ctx.query),
    needParams ? queryRows(ctx.pool, Q.PARAMETERS, p, ctx.query) : Promise.resolve([]),
    needColumns ? queryRows(ctx.pool, Q.COLUMNS, p, ctx.query) : Promise.resolve([]),
    kind === 'view' ? queryRows(ctx.pool, Q.INDEXES, p, ctx.query) : Promise.resolve([]),
  ]);
  const paramsBy = groupBy(params, (r) => Number(r.object_id));
  const colsBy = groupBy(columns, (r) => Number(r.object_id));
  const idxBy = groupBy(indexes, (r) => Number(r.object_id));
  for (const r of modules) {
    const id = Number(r.object_id);
    const listed = wanted.get(id);
    if (!listed || listed.kind !== kind) continue;
    const isEncrypted = bool(r.is_encrypted);
    const hasModule = bool(r.has_module);
    const status = definitionStatus(r.definition, isEncrypted, hasModule);
    const module = moduleSettings(r);
    let details: ProcedureDetails | ViewDetails | FunctionDetails;
    if (kind === 'procedure') {
      details = { kind: 'procedure', parameters: mapParameters(paramsBy.get(id) ?? []).params, module, definitionStatus: status };
    } else if (kind === 'view') {
      details = {
        kind: 'view',
        columns: mapColumns(colsBy.get(id) ?? []),
        indexes: mapIndexes(idxBy.get(id) ?? []),
        module,
        definitionStatus: status,
      };
    } else {
      const ft = functionTypeOf(listed.typeCode);
      const { params: fp, returnType } = mapParameters(paramsBy.get(id) ?? []);
      details = {
        kind: 'function',
        functionType: ft,
        isClr: listed.typeCode === 'FS' || listed.typeCode === 'FT',
        parameters: fp,
        returnType: ft === 'scalar' ? returnType : 'TABLE',
        returnColumns: ft === 'scalar' ? [] : mapColumns(colsBy.get(id) ?? []),
        module,
        definitionStatus: status,
      };
    }
    out.push({ ...listed, definition: strOrNull(r.definition), isEncrypted, rowCount: null, details });
  }
  return out;
}

export { toIsoOrNull };
