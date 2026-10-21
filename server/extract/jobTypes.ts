import type { JobExecution, JobSourceKind, TargetMember } from '../../shared/types';
import type { JobSchedule } from './schedule';

/** Normalised job shape shared by the Agent (msdb) and Elastic Jobs extractors; stored as jobs.details_json. */
export interface ExtractedJobStep {
  stepId: number;
  name: string;
  commandType: string;
  commandSource: string;
  command: string;
  credentialName: string | null;
  targetGroupId: string | null;
  targetGroupName: string | null;
  targetMembers: TargetMember[];
  retryAttempts: number | null;
  stepTimeoutSeconds: number | null;
  maxParallelism: number | null;
  subsystem: string | null;
  databaseName: string | null;
  onSuccess: string | null;
  onFail: string | null;
  retryIntervalMinutes: number | null;
  outputFileName: string | null;
  analyzable: boolean;
  /** elastic only */
  initialRetryIntervalSeconds: number | null;
  maximumRetryIntervalSeconds: number | null;
  retryIntervalBackoffMultiplier: number | null;
  output: {
    type: string | null;
    serverName: string | null;
    databaseName: string | null;
    schemaName: string | null;
    tableName: string | null;
    credentialName: string | null;
  } | null;
  /** agent only: per-step last run (from sysjobsteps / sp_help_jobstep) */
  lastRunOutcome?: string | null;
  lastRunAt?: string | null;
}

export interface ExtractedJobSchedule {
  name: string;
  enabled: boolean;
  text: string;
  nextRun: string | null;
}

export interface ExtractedJob {
  source: JobSourceKind;
  jobId: string;
  name: string;
  description: string | null;
  enabled: boolean;
  version: number;
  category: string | null;
  owner: string | null;
  dateCreated: string | null;
  dateModified: string | null;
  /** agent: from sysjobservers / sp_help_job; elastic: null (derived from executions when read) */
  lastRunOutcome: string | null;
  lastRunAt: string | null;
  /** agent: from msdb; elastic: null (computed from the schedule when read) */
  nextRun: string | null;
  /** elastic schedule; all-null for agent */
  schedule: JobSchedule;
  scheduleText: string;
  /** agent schedules (elastic: empty, derived when read) */
  schedules: ExtractedJobSchedule[];
  steps: ExtractedJobStep[];
}

export interface ExtractedExecution extends JobExecution {
  source: JobSourceKind;
  jobId: string | null;
  jobVersion: number | null;
  targetType: string | null;
  targetGroupName: string | null;
}

export interface JobsExtractionResult {
  jobs: ExtractedJob[];
  executions: ExtractedExecution[];
  warnings: string[];
}
