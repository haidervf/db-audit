/**
 * SQL Server Agent jobs from msdb, read over the TARGET connection with 3-part names (SQL Server and
 * Azure SQL Managed Instance only; never sent when EngineEdition = 5, where msdb.* does not compile).
 *
 * Two read paths, chosen by AGENT_PROBE:
 *  - direct SELECT on msdb.dbo.sysjobs / sysjobsteps / sysschedules / sysjobschedules / sysjobservers /
 *    sysjobhistory / syscategories / sysjobactivity (sysadmin, or explicit grants);
 *  - SQLAgentReaderRole members are DENIED those SELECTs (verified in Docker: Msg 229), so they use the
 *    read-only msdb.dbo.sp_help_job / sp_help_jobstep / sp_help_jobschedule / sp_help_jobhistory procs.
 *    These four EXECs are the only EXECs the read-only guard allows.
 * Agent dates/times are server-local; AGENT_PROBE returns the current UTC offset to convert them.
 */

export const AGENT_PROBE = `
SET NOCOUNT ON;
DECLARE @x int, @direct bit = 0, @direct_error nvarchar(400) = NULL;
BEGIN TRY
  SELECT TOP (1) @x = 1 FROM msdb.dbo.sysjobs;
  SELECT TOP (1) @x = 1 FROM msdb.dbo.sysjobsteps;
  SELECT TOP (1) @x = 1 FROM msdb.dbo.sysschedules;
  SELECT TOP (1) @x = 1 FROM msdb.dbo.sysjobschedules;
  SELECT TOP (1) @x = 1 FROM msdb.dbo.sysjobservers;
  SELECT TOP (1) @x = 1 FROM msdb.dbo.sysjobhistory;
  SELECT TOP (1) @x = 1 FROM msdb.dbo.syscategories;
  SELECT TOP (1) @x = 1 FROM msdb.dbo.sysjobactivity;
  SET @direct = 1;
END TRY
BEGIN CATCH
  SET @direct_error = CONCAT(N'Msg ', ERROR_NUMBER(), N': ', ERROR_MESSAGE());
END CATCH;
SELECT
  @direct AS direct_select,
  @direct_error AS direct_error,
  CAST(ISNULL(HAS_PERMS_BY_NAME(N'msdb.dbo.sp_help_job', 'OBJECT', 'EXECUTE'), 0) AS bit)         AS help_job,
  CAST(ISNULL(HAS_PERMS_BY_NAME(N'msdb.dbo.sp_help_jobstep', 'OBJECT', 'EXECUTE'), 0) AS bit)     AS help_jobstep,
  CAST(ISNULL(HAS_PERMS_BY_NAME(N'msdb.dbo.sp_help_jobschedule', 'OBJECT', 'EXECUTE'), 0) AS bit) AS help_jobschedule,
  CAST(ISNULL(HAS_PERMS_BY_NAME(N'msdb.dbo.sp_help_jobhistory', 'OBJECT', 'EXECUTE'), 0) AS bit)  AS help_jobhistory,
  DATEDIFF(MINUTE, SYSUTCDATETIME(), SYSDATETIME()) AS utc_offset_minutes;
`;

/* ------------------------------------------------------------------ direct path */

export const AGENT_JOBS = `
SELECT j.job_id, j.name, j.enabled, j.description, j.start_step_id, c.name AS category, SUSER_SNAME(j.owner_sid) AS owner,
       j.date_created, j.date_modified, j.version_number,
       srv.last_run_outcome, srv.last_run_date, srv.last_run_time, srv.last_run_duration,
       nxt.next_run_date, nxt.next_run_time, act.next_scheduled_run_date
FROM msdb.dbo.sysjobs AS j
LEFT JOIN msdb.dbo.syscategories AS c ON c.category_id = j.category_id
OUTER APPLY (SELECT TOP (1) s.last_run_outcome, s.last_run_date, s.last_run_time, s.last_run_duration
             FROM msdb.dbo.sysjobservers AS s WHERE s.job_id = j.job_id ORDER BY s.server_id) AS srv
OUTER APPLY (SELECT TOP (1) js.next_run_date, js.next_run_time
             FROM msdb.dbo.sysjobschedules AS js
             JOIN msdb.dbo.sysschedules AS sc ON sc.schedule_id = js.schedule_id
             WHERE js.job_id = j.job_id AND sc.enabled = 1 AND js.next_run_date > 0
             ORDER BY js.next_run_date, js.next_run_time) AS nxt
-- sysjobschedules.next_run_* is only recalculated by Agent every ~20 minutes; the current Agent
-- session's sysjobactivity row has the live value (this is what sp_help_job reports)
OUTER APPLY (SELECT TOP (1) ja.next_scheduled_run_date
             FROM msdb.dbo.sysjobactivity AS ja WHERE ja.job_id = j.job_id ORDER BY ja.session_id DESC) AS act
ORDER BY j.name;
`;

export const AGENT_STEPS = `
SELECT s.job_id, s.step_id, s.step_name, s.subsystem, s.command, s.database_name, s.database_user_name,
       s.on_success_action, s.on_success_step_id, s.on_fail_action, s.on_fail_step_id,
       s.retry_attempts, s.retry_interval, s.output_file_name, s.proxy_id,
       s.last_run_outcome, s.last_run_date, s.last_run_time, s.last_run_duration
FROM msdb.dbo.sysjobsteps AS s
ORDER BY s.job_id, s.step_id;
`;

export const AGENT_SCHEDULES = `
SELECT js.job_id, sc.schedule_id, sc.name AS schedule_name, sc.enabled,
       sc.freq_type, sc.freq_interval, sc.freq_subday_type, sc.freq_subday_interval, sc.freq_relative_interval,
       sc.freq_recurrence_factor, sc.active_start_date, sc.active_end_date, sc.active_start_time, sc.active_end_time,
       js.next_run_date, js.next_run_time
FROM msdb.dbo.sysjobschedules AS js
JOIN msdb.dbo.sysschedules AS sc ON sc.schedule_id = js.schedule_id
ORDER BY js.job_id, sc.schedule_id;
`;

/** Latest @limit history rows per job (step rows + step_id 0 job-outcome rows). */
export const AGENT_HISTORY = `
SELECT x.instance_id, x.job_id, x.step_id, x.step_name, x.sql_message_id, x.sql_severity, x.message,
       x.run_status, x.run_date, x.run_time, x.run_duration, x.retries_attempted, x.server
FROM (
  SELECT h.instance_id, h.job_id, h.step_id, h.step_name, h.sql_message_id, h.sql_severity, h.message,
         h.run_status, h.run_date, h.run_time, h.run_duration, h.retries_attempted, h.server,
         ROW_NUMBER() OVER (PARTITION BY h.job_id ORDER BY h.instance_id DESC) AS rn
  FROM msdb.dbo.sysjobhistory AS h
) AS x
WHERE x.rn <= @limit
ORDER BY x.instance_id DESC;
`;

/* ------------------------------------------------------------------ SQLAgentReaderRole path (read-only system procs) */

/** One row per job: job_id, name, enabled, description, category, owner, date_created, date_modified,
 *  version_number, last_run_date/time/outcome, next_run_date/time, ... */
export const AGENT_HELP_JOBS = `EXEC msdb.dbo.sp_help_job;`;

export const AGENT_HELP_JOBSTEPS = `EXEC msdb.dbo.sp_help_jobstep @job_id = @job_id;`;

export const AGENT_HELP_JOBSCHEDULES = `EXEC msdb.dbo.sp_help_jobschedule @job_id = @job_id;`;

/** All history rows (msdb retention applies); trimmed per job client-side. */
export const AGENT_HELP_JOBHISTORY = `EXEC msdb.dbo.sp_help_jobhistory @mode = N'FULL';`;
