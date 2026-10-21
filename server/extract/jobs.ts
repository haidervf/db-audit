import type sql from 'mssql';
import type { TargetMember } from '../../shared/types';
import { queryRows, type QueryOptions } from '../db/query';
import { toIsoOrNull } from './catalog';
import { scheduleText, type JobSchedule } from './schedule';
import { normalizeMembership } from './targets';
import type { ExtractedExecution, ExtractedJob, JobsExtractionResult } from './jobTypes';
import { buildExecutionsSelect, buildJobsSelect, JOBS_COLUMNS_PROBE, type JobView } from './sql/jobs';

export interface JobsExtraction extends JobsExtractionResult {
  /** columns found per jobs.* view (research finding 5: probe, don't assume) */
  columns: Record<string, string[]>;
}

const s = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const n = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));
const b = (v: unknown): boolean => v === true || v === 1 || v === '1';
const guid = (v: unknown): string | null => (v === null || v === undefined ? null : String(v).toUpperCase());

export async function extractJobs(pool: sql.ConnectionPool, query: QueryOptions, executionsPerJob: number): Promise<JobsExtraction> {
  const warnings: string[] = [];
  const probe = await queryRows(pool, JOBS_COLUMNS_PROBE, {}, query);
  const columns: Record<string, string[]> = {};
  for (const r of probe) (columns[String(r.object_name)] ??= []).push(String(r.column_name));
  const cols = (v: JobView): Set<string> => new Set(columns[v] ?? []);

  const jobCols = cols('jobs');
  if (!jobCols.has('job_name') || !jobCols.has('job_id')) {
    throw new Error('jobs.jobs is not readable or lacks job_id/job_name (is this an Elastic Jobs job database, and is the login in jobs_reader?)');
  }
  for (const v of ['jobsteps', 'target_group_members', 'job_executions'] as const) {
    if (!columns[v]) warnings.push(`jobs.${v} not found or not readable; related data is missing`);
  }
  for (const [v, need] of [['jobsteps', 'command'], ['jobsteps', 'step_id']] as const) {
    if (columns[v] && !cols(v).has(need)) warnings.push(`jobs.${v} has no ${need} column`);
  }

  const [jobRows, stepRows, memberRows, stepVersionRows, execRows] = await Promise.all([
    queryRows(pool, buildJobsSelect('jobs', jobCols), {}, query),
    columns.jobsteps ? queryRows(pool, buildJobsSelect('jobsteps', cols('jobsteps')), {}, query) : Promise.resolve([]),
    columns.target_group_members ? queryRows(pool, buildJobsSelect('target_group_members', cols('target_group_members')), {}, query) : Promise.resolve([]),
    columns.jobstep_versions && !cols('job_executions').has('step_name')
      ? queryRows(pool, buildJobsSelect('jobstep_versions', cols('jobstep_versions')), {}, query)
      : Promise.resolve([]),
    columns.job_executions
      ? queryRows(pool, buildExecutionsSelect(cols('job_executions')), { limit: { type: 'int', value: executionsPerJob } }, query)
      : Promise.resolve([]),
  ]);

  const membersByGroup = new Map<string, TargetMember[]>();
  for (const r of memberRows) {
    const key = (guid(r.target_group_id) ?? s(r.target_group_name) ?? '').toLowerCase();
    const list = membersByGroup.get(key) ?? [];
    list.push({
      membershipType: normalizeMembership(s(r.membership_type)),
      targetType: s(r.target_type) ?? '',
      serverName: s(r.server_name),
      databaseName: s(r.database_name),
      elasticPoolName: s(r.elastic_pool_name),
    });
    membersByGroup.set(key, list);
    // also index by name, for views that expose only target_group_name
    const nameKey = (s(r.target_group_name) ?? '').toLowerCase();
    if (nameKey && nameKey !== key) membersByGroup.set(`name:${nameKey}`, list);
  }

  const jobs = new Map<string, ExtractedJob>();
  const byName = new Map<string, ExtractedJob>();
  for (const r of jobRows) {
    const schedule: JobSchedule = {
      intervalType: s(r.schedule_interval_type),
      intervalCount: n(r.schedule_interval_count),
      startTime: toIsoOrNull(r.schedule_start_time),
      endTime: toIsoOrNull(r.schedule_end_time),
    };
    const enabled = b(r.enabled);
    const job: ExtractedJob = {
      source: 'elastic',
      jobId: guid(r.job_id) ?? '',
      name: String(r.job_name),
      description: s(r.description) || null,
      enabled,
      version: n(r.job_version) ?? 0,
      category: null,
      owner: null,
      dateCreated: null,
      dateModified: null,
      lastRunOutcome: null,
      lastRunAt: null,
      nextRun: null,
      schedule,
      scheduleText: scheduleText(enabled, schedule),
      schedules: [],
      steps: [],
    };
    jobs.set(job.jobId, job);
    byName.set(job.name.toLowerCase(), job);
  }

  for (const r of stepRows) {
    const job = (r.job_id ? jobs.get(guid(r.job_id) ?? '') : undefined) ?? byName.get(String(r.job_name ?? '').toLowerCase());
    if (!job) continue;
    // jobs.jobsteps is documented both as "current version only" and "all versions": keep the current one.
    if (r.job_version !== undefined && r.job_version !== null && job.version && Number(r.job_version) !== job.version) continue;
    const groupId = guid(r.target_group_id);
    const groupName = s(r.target_group_name);
    const members =
      (groupId ? membersByGroup.get(groupId.toLowerCase()) : undefined) ??
      (groupName ? (membersByGroup.get(`name:${groupName.toLowerCase()}`) ?? membersByGroup.get(groupName.toLowerCase())) : undefined) ??
      [];
    const hasOutput = r.output_type !== undefined && r.output_type !== null;
    const commandType = s(r.command_type) ?? 'TSql';
    job.steps.push({
      stepId: n(r.step_id) ?? 0,
      name: s(r.step_name) ?? `step ${r.step_id}`,
      commandType,
      subsystem: commandType,
      databaseName: null,
      onSuccess: null,
      onFail: null,
      retryIntervalMinutes: null,
      outputFileName: null,
      analyzable: commandType.toLowerCase() === 'tsql',
      commandSource: s(r.command_source) ?? 'Inline',
      command: s(r.command) ?? '',
      credentialName: s(r.credential_name),
      targetGroupId: groupId,
      targetGroupName: groupName,
      targetMembers: members,
      retryAttempts: n(r.retry_attempts),
      stepTimeoutSeconds: n(r.step_timeout_seconds),
      maxParallelism: n(r.max_parallelism),
      initialRetryIntervalSeconds: n(r.initial_retry_interval_seconds),
      maximumRetryIntervalSeconds: n(r.maximum_retry_interval_seconds),
      retryIntervalBackoffMultiplier: n(r.retry_interval_backoff_multiplier),
      output: hasOutput
        ? {
            type: s(r.output_type),
            serverName: s(r.output_server_name),
            databaseName: s(r.output_database_name),
            schemaName: s(r.output_schema_name),
            tableName: s(r.output_table_name),
            credentialName: s(r.output_credential_name),
          }
        : null,
    });
  }
  for (const job of jobs.values()) job.steps.sort((a, b2) => a.stepId - b2.stepId);

  const stepNames = new Map<string, string>();
  for (const r of stepVersionRows) stepNames.set(`${guid(r.job_id)}|${r.job_version}|${r.step_id}`, String(r.step_name));

  const executions: ExtractedExecution[] = execRows.map((r) => {
    const jobId = guid(r.job_id);
    const stepId = n(r.step_id);
    const jobName = s(r.job_name) ?? (jobId ? jobs.get(jobId)?.name : undefined) ?? '';
    const startTime = toIsoOrNull(r.start_time);
    const endTime = toIsoOrNull(r.end_time);
    return {
      source: 'elastic' as const,
      runStatus: null,
      durationSeconds: startTime && endTime ? Math.round((Date.parse(endTime) - Date.parse(startTime)) / 1000) : null,
      jobExecutionId: guid(r.job_execution_id) ?? '',
      jobName,
      stepId,
      stepName: s(r.step_name) ?? (stepId !== null ? (stepNames.get(`${jobId}|${r.job_version}|${stepId}`) ?? null) : null),
      lifecycle: s(r.lifecycle) ?? '',
      isActive: b(r.is_active),
      createTime: toIsoOrNull(r.create_time),
      startTime,
      endTime,
      lastMessage: s(r.last_message),
      targetServerName: s(r.target_server_name),
      targetDatabaseName: s(r.target_database_name),
      currentAttempts: n(r.current_attempts),
      jobId,
      jobVersion: n(r.job_version),
      targetType: s(r.target_type),
      targetGroupName: s(r.target_group_name),
    };
  });

  return { jobs: [...jobs.values()].sort((a, b2) => a.name.localeCompare(b2.name)), executions, warnings, columns };
}
