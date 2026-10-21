import type sql from 'mssql';
import type { EndpointCheck } from '../../shared/types';
import { errorMessage, queryRows, type QueryOptions } from '../db/query';
import { JOBS_PROBE, TARGET_PROBE } from './sql/probe';

export interface TargetProbe {
  productVersion: string;
  productLevel: string | null;
  edition: string | null;
  engineEdition: number | null;
  serverName: string | null;
  database: string;
  loginName: string | null;
  userName: string | null;
  collation: string | null;
  compatibilityLevel: number | null;
  permissions: { viewDefinition: boolean; expressionDependencies: boolean; viewDatabaseState: boolean };
  /** actual errors from the TRY/CATCH probes, e.g. "Msg 229: The SELECT permission was denied ..." */
  probeErrors: { expressionDependencies: string | null; partitionStats: string | null };
}

const b = (v: unknown): boolean => v === true || v === 1;
const s = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

export async function probeTarget(pool: sql.ConnectionPool, query: QueryOptions): Promise<TargetProbe> {
  const [r] = await queryRows(pool, TARGET_PROBE, {}, query);
  return {
    productVersion: String(r.product_version ?? ''),
    productLevel: s(r.product_level),
    edition: s(r.edition),
    engineEdition: r.engine_edition === null || r.engine_edition === undefined ? null : Number(r.engine_edition),
    serverName: s(r.server_name),
    database: String(r.database_name ?? ''),
    loginName: s(r.login_name),
    userName: s(r.user_name),
    collation: s(r.collation_name),
    compatibilityLevel: r.compatibility_level === null || r.compatibility_level === undefined ? null : Number(r.compatibility_level),
    permissions: {
      viewDefinition: b(r.view_definition),
      expressionDependencies: b(r.expression_dependencies),
      // what matters is whether sys.dm_db_partition_stats is readable (VIEW DATABASE STATE or
      // VIEW DATABASE PERFORMANCE STATE), so report the actual attempt
      viewDatabaseState: b(r.partition_stats),
    },
    probeErrors: { expressionDependencies: s(r.expression_dependencies_error), partitionStats: s(r.partition_stats_error) },
  };
}

export function targetCheck(p: TargetProbe): EndpointCheck {
  return {
    ok: true,
    serverVersion: p.productVersion,
    database: p.database,
    loginName: p.loginName ?? undefined,
    edition: p.edition ?? undefined,
    engineEdition: p.engineEdition ?? undefined,
    permissions: { ...p.permissions },
  };
}

export async function probeJobsEndpoint(pool: sql.ConnectionPool, query: QueryOptions): Promise<EndpointCheck> {
  const [r] = await queryRows(pool, JOBS_PROBE, {}, query);
  return {
    ok: true,
    serverVersion: String(r.product_version ?? ''),
    database: String(r.database_name ?? ''),
    loginName: s(r.login_name) ?? undefined,
    edition: s(r.edition) ?? undefined,
    engineEdition: r.engine_edition === null || r.engine_edition === undefined ? undefined : Number(r.engine_edition),
    permissions: {
      viewDefinition: b(r.view_definition),
      expressionDependencies: false,
      viewDatabaseState: b(r.has_view_database_state),
      jobsViews: b(r.jobs_views),
    },
  };
}

export function failedCheck(err: unknown): EndpointCheck {
  return { ok: false, error: errorMessage(err) };
}
