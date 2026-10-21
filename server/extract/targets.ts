import type { JobStep, TargetMember } from '../../shared/types';
import { hostLabel } from '../db/poolConfig';

export interface TargetDb {
  server: string;
  database: string;
}

/** membership_type may come back as text ('Include'/'Exclude') or, per one doc page, an int (assumed 0/1). */
export function normalizeMembership(v: string | null | undefined): 'Include' | 'Exclude' | string {
  const s = String(v ?? '').trim();
  if (/^include$/i.test(s) || s === '0') return 'Include';
  if (/^exclude$/i.test(s) || s === '1') return 'Exclude';
  return s;
}

function sameServer(member: string | null, target: TargetDb): boolean {
  return Boolean(member) && hostLabel(member) === hostLabel(target.server);
}

function sameDb(member: string | null, target: TargetDb): boolean {
  return Boolean(member) && String(member).toLowerCase() === target.database.toLowerCase();
}

/**
 * Does a step's target group (statically) include the profile's target database?
 *  - Include SqlDatabase member: database_name equal (case-insensitive) AND same server (first host label).
 *  - Include SqlServer member (database_name NULL): same server -> every database on it.
 *  - Exclude members of either type remove a match. Elastic-pool members cannot be resolved from the
 *    job database (membership is dynamic and needs ARM / master access), so they never count as a match.
 * This is an approximation of run-time expansion (research gotcha 13); job_executions shows where steps really ran.
 */
export function evaluateTargets(members: TargetMember[], target: TargetDb): { targetsThisDb: boolean; targetMatch: NonNullable<JobStep['targetMatch']> } {
  let match: 'database' | 'server' | null = null;
  let hasPool = false;
  let excluded = false;
  for (const m of members) {
    const membership = normalizeMembership(m.membershipType);
    const type = (m.targetType ?? '').toLowerCase();
    const isDb = type === 'sqldatabase' && sameDb(m.databaseName, target) && sameServer(m.serverName, target);
    const isServer = type === 'sqlserver' && sameServer(m.serverName, target);
    if (membership === 'Include') {
      if (isDb) match = 'database';
      else if (isServer && match !== 'database') match = 'server';
      else if (type === 'sqlelasticpool') hasPool = true;
    } else if (membership === 'Exclude' && (isDb || isServer)) {
      excluded = true;
    }
  }
  if (match && excluded) return { targetsThisDb: false, targetMatch: 'excluded' };
  if (match) return { targetsThisDb: true, targetMatch: match };
  return { targetsThisDb: false, targetMatch: hasPool ? 'pool-unknown' : 'none' };
}
