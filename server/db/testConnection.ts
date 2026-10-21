import type { ConnectionTestResult, EndpointCheck } from '../../shared/types';
import { AGENT_ENGINE_EDITIONS, ENGINE_EDITIONS } from '../../shared/types';
import type { StoredConnection } from '../connections/store';
import { probeAgent } from '../extract/agent';
import { failedCheck, probeJobsEndpoint, probeTarget, targetCheck } from '../extract/probe';
import type { PoolManager } from './pools';
import type { QueryOptions } from './query';

/**
 * Connects to the target (and the Elastic Jobs endpoint when configured) and reports server version,
 * database, login and permission probes. Read-only.
 */
export async function testConnection(conn: StoredConnection, pools: PoolManager, query: QueryOptions): Promise<ConnectionTestResult> {
  let target: EndpointCheck;
  try {
    const pool = await pools.get(conn, 'target');
    const probe = await probeTarget(pool, query);
    target = targetCheck(probe);
    const ee = probe.engineEdition ?? -1;
    target.engineEditionLabel = ENGINE_EDITIONS[ee] ?? `unknown (${ee})`;
    // msdb.* does not even compile on Azure SQL Database (EngineEdition 5), so only probe where Agent exists.
    target.permissions!.agentJobs = AGENT_ENGINE_EDITIONS.includes(ee) ? (await probeAgent(pool, query)).readable : false;
  } catch (err) {
    target = failedCheck(err);
  }

  let jobs: EndpointCheck | null = null;
  if (conn.jobs) {
    try {
      const pool = await pools.get(conn, 'jobs');
      jobs = await probeJobsEndpoint(pool, query);
      jobs.engineEditionLabel = ENGINE_EDITIONS[jobs.engineEdition ?? -1] ?? undefined;
    } catch (err) {
      jobs = failedCheck(err);
    }
  }
  return { ok: target.ok && (jobs ? jobs.ok : true), target, jobs };
}
