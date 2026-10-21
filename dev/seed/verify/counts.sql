/* Prints counts of the seeded objects (run by dev/scripts/db-seed.sh). Read-only. */
SET NOCOUNT ON;
USE AuditDemo;
SELECT 'AuditDemo' AS db,
  (SELECT COUNT(*) FROM sys.tables WHERE is_ms_shipped = 0)                                AS tables,
  (SELECT COUNT(*) FROM sys.views WHERE is_ms_shipped = 0)                                 AS views,
  (SELECT COUNT(*) FROM sys.objects WHERE type IN ('FN','IF','TF','FS','FT') AND is_ms_shipped = 0) AS functions,
  (SELECT COUNT(*) FROM sys.procedures WHERE is_ms_shipped = 0)                            AS procedures,
  (SELECT COUNT(*) FROM sys.triggers WHERE is_ms_shipped = 0)                              AS triggers,
  (SELECT COUNT(*) FROM sys.sequences)                                                     AS sequences,
  (SELECT COUNT(*) FROM sys.sql_modules WHERE definition IS NULL)                          AS null_definitions;
SELECT 'AuditDemo' AS db, SCHEMA_NAME(t.schema_id) + '.' + t.name AS table_name, SUM(p.rows) AS row_count
FROM sys.tables AS t JOIN sys.partitions AS p ON p.object_id = t.object_id AND p.index_id IN (0, 1)
GROUP BY t.schema_id, t.name ORDER BY table_name;
USE AuditArchive;
SELECT 'AuditArchive' AS db,
  (SELECT COUNT(*) FROM sys.tables WHERE is_ms_shipped = 0)     AS tables,
  (SELECT COUNT(*) FROM sys.procedures WHERE is_ms_shipped = 0) AS procedures;
USE AuditJobs;
SELECT 'AuditJobs' AS db,
  (SELECT COUNT(*) FROM jobs.jobs)                        AS jobs,
  (SELECT COUNT(*) FROM jobs.jobs WHERE enabled = 0)      AS disabled_jobs,
  (SELECT COUNT(*) FROM jobs.jobsteps)                    AS current_steps,
  (SELECT COUNT(*) FROM jobs.jobstep_versions)            AS step_versions,
  (SELECT COUNT(*) FROM jobs.target_groups)               AS target_groups,
  (SELECT COUNT(*) FROM jobs.target_group_members)        AS members,
  (SELECT COUNT(*) FROM jobs.job_executions)              AS executions;
USE msdb;
SELECT 'msdb (Agent)' AS db,
  (SELECT COUNT(*) FROM dbo.sysjobs AS j JOIN dbo.syscategories AS c ON c.category_id = j.category_id WHERE c.name = N'db-audit demo') AS jobs,
  (SELECT COUNT(*) FROM dbo.sysjobs AS j JOIN dbo.syscategories AS c ON c.category_id = j.category_id WHERE c.name = N'db-audit demo' AND j.enabled = 0) AS disabled_jobs,
  (SELECT COUNT(*) FROM dbo.sysjobsteps AS s JOIN dbo.sysjobs AS j ON j.job_id = s.job_id JOIN dbo.syscategories AS c ON c.category_id = j.category_id WHERE c.name = N'db-audit demo') AS steps,
  (SELECT COUNT(*) FROM dbo.sysjobschedules AS s JOIN dbo.sysjobs AS j ON j.job_id = s.job_id JOIN dbo.syscategories AS c ON c.category_id = j.category_id WHERE c.name = N'db-audit demo') AS schedules,
  (SELECT COUNT(*) FROM dbo.sysjobhistory AS h JOIN dbo.sysjobs AS j ON j.job_id = h.job_id JOIN dbo.syscategories AS c ON c.category_id = j.category_id WHERE c.name = N'db-audit demo') AS history_rows;
SELECT j.name AS job_name, h.step_id, h.run_status, LEFT(h.message, 90) AS message
FROM dbo.sysjobhistory AS h JOIN dbo.sysjobs AS j ON j.job_id = h.job_id
JOIN dbo.syscategories AS c ON c.category_id = j.category_id
WHERE c.name = N'db-audit demo' ORDER BY j.name, h.instance_id;
USE master;
SELECT name AS login_name FROM sys.server_principals WHERE name IN (N'audit_reader', N'audit_full', N'audit_nojobs') ORDER BY name;
