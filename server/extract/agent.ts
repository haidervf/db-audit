import type sql from 'mssql';
import { errorMessage, queryRows, type QueryOptions } from '../db/query';
import {
  agentDateTimeToIso,
  agentDurationSeconds,
  agentScheduleNextRuns,
  agentScheduleText,
  lastRunOutcomeLabel,
  localDateToIso,
  RUN_STATUS,
  stepActionText,
  type AgentScheduleFields,
} from './agentDecode';
import type { ExtractedExecution, ExtractedJob, ExtractedJobSchedule, ExtractedJobStep, JobsExtractionResult } from './jobTypes';
import * as Q from './sql/agent';

export type AgentReadPath = 'direct' | 'sp_help';

export interface AgentProbe {
  readable: boolean;
  path: AgentReadPath | null;
  /** why direct SELECT failed (e.g. Msg 229 for SQLAgentReaderRole members) */
  directError: string | null;
  utcOffsetMinutes: number;
  /** set when the probe itself failed (e.g. no access to msdb at all) */
  error: string | null;
}

const b = (v: unknown): boolean => v === true || v === 1;
const s = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const n = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));
const guid = (v: unknown): string => String(v ?? '').toUpperCase();

export async function probeAgent(pool: sql.ConnectionPool, query: QueryOptions): Promise<AgentProbe> {
  try {
    const [r] = await queryRows(pool, Q.AGENT_PROBE, {}, query);
    const direct = b(r.direct_select);
    const help = b(r.help_job) && b(r.help_jobstep) && b(r.help_jobschedule) && b(r.help_jobhistory);
    return {
      readable: direct || help,
      path: direct ? 'direct' : help ? 'sp_help' : null,
      directError: s(r.direct_error),
      utcOffsetMinutes: Number(r.utc_offset_minutes ?? 0),
      error: null,
    };
  } catch (err) {
    return { readable: false, path: null, directError: null, utcOffsetMinutes: 0, error: errorMessage(err) };
  }
}

/* ------------------------------------------------------------------ raw rows (same column names on both paths) */

interface RawJob {
  job_id: string;
  name: string;
  enabled: unknown;
  description: unknown;
  category: unknown;
  owner: unknown;
  date_created: unknown;
  date_modified: unknown;
  version_number: unknown;
  last_run_outcome: unknown;
  last_run_date: unknown;
  last_run_time: unknown;
  next_run_date: unknown;
  next_run_time: unknown;
  /** direct path only */
  next_scheduled_run_date?: unknown;
  /** sp_help_job only: the schedule the next run comes from (0 when unknown) */
  next_run_schedule_id?: unknown;
}

type Row = Record<string, unknown>;

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
      while (next < items.length) await fn(items[next++]);
    }),
  );
}

async function readDirect(pool: sql.ConnectionPool, query: QueryOptions, historyPerJob: number) {
  const [jobs, steps, schedules, history] = await Promise.all([
    queryRows(pool, Q.AGENT_JOBS, {}, query),
    queryRows(pool, Q.AGENT_STEPS, {}, query),
    queryRows(pool, Q.AGENT_SCHEDULES, {}, query),
    queryRows(pool, Q.AGENT_HISTORY, { limit: { type: 'int', value: historyPerJob } }, query),
  ]);
  return { jobs: jobs as unknown as RawJob[], steps, schedules, history, warnings: [] as string[], warningJobs: [] as Array<{ jobId: string; name: string } | undefined> };
}

async function readViaHelpProcs(pool: sql.ConnectionPool, query: QueryOptions, concurrency: number) {
  const jobs = (await queryRows(pool, Q.AGENT_HELP_JOBS, {}, query)) as unknown as RawJob[];
  const steps: Row[] = [];
  const schedules: Row[] = [];
  const warnings: string[] = [];
  /** parallel to `warnings`: the job each warning is about */
  const warningJobs: Array<{ jobId: string; name: string } | undefined> = [];
  await mapLimit(jobs, concurrency, async (j) => {
    const p = { job_id: { type: 'uniqueidentifier' as const, value: String(j.job_id) } };
    try {
      const [st, sc] = await Promise.all([
        queryRows(pool, Q.AGENT_HELP_JOBSTEPS, p, query),
        queryRows(pool, Q.AGENT_HELP_JOBSCHEDULES, p, query),
      ]);
      for (const r of st) steps.push({ ...r, job_id: j.job_id });
      for (const r of sc) schedules.push({ ...r, job_id: j.job_id });
    } catch (err) {
      warnings.push(`Agent job ${j.name}: steps/schedules not readable: ${errorMessage(err)}`);
      warningJobs.push({ jobId: guid(j.job_id), name: String(j.name) });
    }
  });
  const history = await queryRows(pool, Q.AGENT_HELP_JOBHISTORY, {}, query);
  return { jobs, steps, schedules, history, warnings, warningJobs };
}

/* ------------------------------------------------------------------ normalise */

function scheduleFields(r: Row): AgentScheduleFields {
  return {
    freq_type: Number(r.freq_type ?? 0),
    freq_interval: Number(r.freq_interval ?? 0),
    freq_subday_type: Number(r.freq_subday_type ?? 0),
    freq_subday_interval: Number(r.freq_subday_interval ?? 0),
    freq_relative_interval: Number(r.freq_relative_interval ?? 0),
    freq_recurrence_factor: Number(r.freq_recurrence_factor ?? 0),
    active_start_date: Number(r.active_start_date ?? 0),
    active_end_date: Number(r.active_end_date ?? 0),
    active_start_time: Number(r.active_start_time ?? 0),
    active_end_time: Number(r.active_end_time ?? 0),
  };
}

function summarizeSchedules(enabled: boolean, schedules: ExtractedJobSchedule[]): string {
  const active = schedules.filter((x) => x.enabled);
  let text: string;
  if (!schedules.length) text = 'No schedule (runs on demand)';
  else if (!active.length) text = `No enabled schedule (${schedules.length} disabled)`;
  else text = active.map((x) => x.text).join('; ');
  return enabled ? text : `Disabled (${text.charAt(0).toLowerCase()}${text.slice(1)})`;
}

/**
 * Reads every Agent job visible to the login. `path` comes from probeAgent(). History is capped at
 * `historyPerJob` rows per job (step rows and step_id 0 job-outcome rows).
 */
export async function extractAgentJobs(
  pool: sql.ConnectionPool,
  query: QueryOptions,
  probe: AgentProbe,
  historyPerJob: number,
  concurrency = 4,
): Promise<JobsExtractionResult & { path: AgentReadPath; warningJobs: Array<{ jobId: string; name: string } | undefined> }> {
  if (!probe.readable || !probe.path) throw new Error('Agent jobs are not readable');
  const raw = probe.path === 'direct' ? await readDirect(pool, query, historyPerJob) : await readViaHelpProcs(pool, query, concurrency);
  const off = probe.utcOffsetMinutes;

  const stepsBy = new Map<string, Row[]>();
  for (const r of raw.steps) {
    const k = guid(r.job_id);
    (stepsBy.get(k) ?? stepsBy.set(k, []).get(k)!).push(r);
  }
  const schedBy = new Map<string, Row[]>();
  for (const r of raw.schedules) {
    const k = guid(r.job_id);
    (schedBy.get(k) ?? schedBy.set(k, []).get(k)!).push(r);
  }

  const jobs: ExtractedJob[] = [];
  const stepDb = new Map<string, string | null>();
  for (const j of raw.jobs) {
    const jobId = guid(j.job_id);
    const enabled = b(j.enabled);
    const steps: ExtractedJobStep[] = (stepsBy.get(jobId) ?? [])
      .map((r): ExtractedJobStep => {
        const subsystem = s(r.subsystem) ?? 'TSQL';
        const databaseName = s(r.database_name);
        stepDb.set(`${jobId}|${r.step_id}`, databaseName);
        return {
          stepId: Number(r.step_id),
          name: s(r.step_name) ?? `step ${r.step_id}`,
          commandType: subsystem,
          commandSource: 'Inline',
          command: s(r.command) ?? '',
          credentialName: null,
          targetGroupId: null,
          targetGroupName: null,
          targetMembers: [],
          retryAttempts: n(r.retry_attempts),
          stepTimeoutSeconds: null,
          maxParallelism: null,
          subsystem,
          databaseName,
          onSuccess: stepActionText(n(r.on_success_action), n(r.on_success_step_id)),
          onFail: stepActionText(n(r.on_fail_action), n(r.on_fail_step_id)),
          retryIntervalMinutes: n(r.retry_interval),
          outputFileName: s(r.output_file_name) || null,
          analyzable: subsystem.toUpperCase() === 'TSQL',
          initialRetryIntervalSeconds: null,
          maximumRetryIntervalSeconds: null,
          retryIntervalBackoffMultiplier: null,
          output: null,
          lastRunOutcome: lastRunOutcomeLabel(n(r.last_run_outcome), n(r.last_run_date)),
          lastRunAt: agentDateTimeToIso(n(r.last_run_date), n(r.last_run_time), off),
        };
      })
      .sort((a, c) => a.stepId - c.stepId);
    const nextRun = enabled
      ? (localDateToIso(j.next_scheduled_run_date, off) ?? agentDateTimeToIso(n(j.next_run_date), n(j.next_run_time), off))
      : null;
    const schedRows = schedBy.get(jobId) ?? [];
    const schedNext = agentScheduleNextRuns(
      schedRows.map((r) => ({ scheduleId: n(r.schedule_id), enabled: b(r.enabled), nextRunDate: n(r.next_run_date), nextRunTime: n(r.next_run_time) })),
      { enabled, nextRun, nextRunScheduleId: n(j.next_run_schedule_id) },
      off,
    );
    const schedules: ExtractedJobSchedule[] = schedRows.map((r, i) => ({
      name: s(r.schedule_name) ?? `schedule ${r.schedule_id}`,
      enabled: b(r.enabled),
      text: agentScheduleText(scheduleFields(r)),
      nextRun: schedNext[i],
    }));
    jobs.push({
      source: 'agent',
      jobId,
      name: String(j.name),
      description: s(j.description) || null,
      enabled,
      version: n(j.version_number) ?? 0,
      category: s(j.category),
      owner: s(j.owner),
      dateCreated: localDateToIso(j.date_created, off),
      dateModified: localDateToIso(j.date_modified, off),
      lastRunOutcome: lastRunOutcomeLabel(n(j.last_run_outcome), n(j.last_run_date)),
      lastRunAt: agentDateTimeToIso(n(j.last_run_date), n(j.last_run_time), off),
      nextRun,
      schedule: { intervalType: null, intervalCount: null, startTime: null, endTime: null },
      scheduleText: summarizeSchedules(enabled, schedules),
      schedules,
      steps,
    });
  }
  jobs.sort((a, c) => a.name.localeCompare(c.name));
  const names = new Map(jobs.map((j) => [j.jobId, j.name]));

  // newest first, capped per job (sp_help_jobhistory returns everything)
  const perJob = new Map<string, number>();
  const executions: ExtractedExecution[] = [];
  const history = [...raw.history].sort((a, c) => Number(c.instance_id) - Number(a.instance_id));
  for (const r of history) {
    const jobId = guid(r.job_id);
    const count = perJob.get(jobId) ?? 0;
    if (count >= historyPerJob) continue;
    perJob.set(jobId, count + 1);
    const status = RUN_STATUS[Number(r.run_status)];
    const stepId = Number(r.step_id);
    const start = agentDateTimeToIso(n(r.run_date), n(r.run_time), off);
    const duration = agentDurationSeconds(n(r.run_duration));
    const active = Number(r.run_status) === 4;
    executions.push({
      source: 'agent',
      jobExecutionId: String(r.instance_id),
      jobName: names.get(jobId) ?? s(r.job_name) ?? '',
      stepId: stepId === 0 ? null : stepId,
      stepName: stepId === 0 ? '(Job outcome)' : s(r.step_name),
      lifecycle: status?.lifecycle ?? String(r.run_status),
      isActive: active,
      createTime: start,
      startTime: start,
      endTime: start && duration !== null && !active ? new Date(Date.parse(start) + duration * 1000).toISOString() : null,
      lastMessage: s(r.message),
      targetServerName: s(r.server),
      targetDatabaseName: stepId === 0 ? null : (stepDb.get(`${jobId}|${stepId}`) ?? null),
      currentAttempts: n(r.retries_attempted),
      runStatus: status?.label ?? null,
      durationSeconds: duration,
      jobId,
      jobVersion: null,
      targetType: null,
      targetGroupName: null,
    });
  }
  return { jobs, executions, warnings: raw.warnings, warningJobs: raw.warningJobs, path: probe.path };
}
