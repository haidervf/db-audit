/**
 * Elastic Jobs job-database extraction (research §1, J1–J4). The docs disagree with themselves in
 * places, so the column set of every jobs.* view is probed at runtime (JOBS_COLUMNS_PROBE) and each
 * SELECT lists only the columns that exist. Column and view names come exclusively from the
 * whitelists below, never from user input or the server.
 */

export const JOBS_COLUMNS_PROBE = `
SELECT o.name AS object_name, c.name AS column_name
FROM sys.objects AS o
JOIN sys.schemas AS s ON s.schema_id = o.schema_id
JOIN sys.columns AS c ON c.object_id = o.object_id
WHERE s.name = N'jobs' AND o.type IN ('V', 'U')
ORDER BY o.name, c.column_id;
`;

export const JOB_VIEW_COLUMNS = {
  jobs: [
    'job_id', 'job_name', 'job_version', 'description', 'enabled',
    'schedule_interval_type', 'schedule_interval_count', 'schedule_start_time', 'schedule_end_time',
  ],
  jobsteps: [
    'job_id', 'job_name', 'job_version', 'step_id', 'step_name', 'command_type', 'command_source', 'command',
    'credential_name', 'target_group_id', 'target_group_name',
    'initial_retry_interval_seconds', 'maximum_retry_interval_seconds', 'retry_interval_backoff_multiplier',
    'retry_attempts', 'step_timeout_seconds', 'max_parallelism',
    'output_type', 'output_credential_name', 'output_server_name', 'output_database_name', 'output_schema_name', 'output_table_name',
  ],
  jobstep_versions: ['job_id', 'job_version', 'step_id', 'step_name'],
  target_groups: ['target_group_id', 'target_group_name'],
  target_group_members: [
    'target_group_id', 'target_group_name', 'target_id', 'membership_type', 'target_type',
    'server_name', 'database_name', 'elastic_pool_name', 'refresh_credential_name', 'subscription_id', 'resource_group_name',
  ],
  job_executions: [
    'job_execution_id', 'job_id', 'job_name', 'job_version', 'step_id', 'step_name', 'is_active', 'lifecycle',
    'create_time', 'start_time', 'end_time', 'current_attempts', 'last_message',
    'target_type', 'target_group_name', 'target_server_name', 'target_database_name',
  ],
} as const;

export type JobView = keyof typeof JOB_VIEW_COLUMNS;

/** membership_type is documented as int but described with text values: always read it as text. */
const COLUMN_EXPRESSIONS: Partial<Record<string, (alias: string) => string>> = {
  membership_type: (a) => `CAST(${a}.[membership_type] AS nvarchar(20))`,
};

function selectList(view: JobView, available: ReadonlySet<string>, alias: string): string[] {
  return (JOB_VIEW_COLUMNS[view] as readonly string[])
    .filter((c) => available.has(c))
    .map((c) => {
      const expr = COLUMN_EXPRESSIONS[c];
      return expr ? `${expr(alias)} AS [${c}]` : `${alias}.[${c}]`;
    });
}

/** SELECT <existing whitelisted columns> FROM jobs.<view>. */
export function buildJobsSelect(view: Exclude<JobView, 'job_executions'>, available: ReadonlySet<string>): string {
  const cols = selectList(view, available, 'v');
  if (!cols.length) throw new Error(`jobs.${view} exposes none of the expected columns`);
  return `SELECT ${cols.join(', ')}\nFROM jobs.[${view}] AS v;`;
}

/** Latest @limit execution rows per job (parent rows and step rows), newest first. */
export function buildExecutionsSelect(available: ReadonlySet<string>): string {
  const cols = selectList('job_executions', available, 'e');
  if (!cols.length) throw new Error('jobs.job_executions exposes none of the expected columns');
  const partition = available.has('job_id') ? 'e.[job_id]' : available.has('job_name') ? 'e.[job_name]' : '(SELECT NULL)';
  const order = available.has('create_time') ? 'e.[create_time]' : available.has('start_time') ? 'e.[start_time]' : '(SELECT NULL)';
  const outer = (JOB_VIEW_COLUMNS.job_executions as readonly string[]).filter((c) => available.has(c)).map((c) => `x.[${c}]`);
  const outerOrder = available.has('create_time') ? 'x.[create_time] DESC' : available.has('start_time') ? 'x.[start_time] DESC' : '1';
  return `SELECT ${outer.join(', ')}
FROM (
  SELECT ${cols.join(', ')}, ROW_NUMBER() OVER (PARTITION BY ${partition} ORDER BY ${order} DESC) AS rn
  FROM jobs.[job_executions] AS e
) AS x
WHERE x.rn <= @limit
ORDER BY ${outerOrder};`;
}
