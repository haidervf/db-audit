/* db-audit dev seed: REAL SQL Server Agent jobs in msdb (the Managed Instance job source).
   DEV TOOLING ONLY. Run with: sqlcmd -C -b -I -x  (-x keeps the $(ESCAPE_SQUOTE(JOBNAME)) Agent token literal).
   Idempotent: deletes every job in category 'db-audit demo' (and their history/schedules), then recreates.
   Runs four of the jobs once (sp_start_job) and waits until msdb.dbo.sysjobhistory has their outcome rows.

   Expected (asserted by the integration tests):
     5 jobs in category 'db-audit demo' (1 disabled), 7 steps, 6 schedules (one job has two)
     AuditDemo - Nightly Maintenance        2 TSQL steps (AuditDemo), step 1 on success -> next step, on fail -> quit failure
     AuditDemo - Purge Audit and Settings   inline UPDATE/DELETE (AuditDemo); schedules: every 15 minutes + weekly Sun 03:00
     AuditDemo - Legacy Shipment Sync       DISABLED; TSQL step + CmdExec step (not analyzable); weekly Mon, Wed 02:00
     AuditArchive - Compaction              step runs in AuditArchive; monthly day 1 at 01:00
     AuditDemo - Points Check               RAISERROR -> fails; every 6 hours
   History after seeding: Nightly Maintenance, Purge, Compaction succeeded; Points Check failed. */
SET NOCOUNT ON;
GO
USE msdb;
GO
DECLARE @old uniqueidentifier;
DECLARE old_jobs CURSOR LOCAL FAST_FORWARD FOR
    SELECT j.job_id FROM msdb.dbo.sysjobs AS j
    JOIN msdb.dbo.syscategories AS c ON c.category_id = j.category_id
    WHERE c.name = N'db-audit demo';
OPEN old_jobs;
FETCH NEXT FROM old_jobs INTO @old;
WHILE @@FETCH_STATUS = 0
BEGIN
    EXEC msdb.dbo.sp_delete_job @job_id = @old, @delete_unused_schedule = 1;
    FETCH NEXT FROM old_jobs INTO @old;
END;
CLOSE old_jobs;
DEALLOCATE old_jobs;
IF EXISTS (SELECT 1 FROM msdb.dbo.syscategories WHERE name = N'db-audit demo' AND category_class = 1)
    EXEC msdb.dbo.sp_delete_category @class = N'JOB', @name = N'db-audit demo';
EXEC msdb.dbo.sp_add_category @class = N'JOB', @type = N'LOCAL', @name = N'db-audit demo';
GO

/* ---------------------------------------------------------------- 1. two-step EXEC job */
EXEC msdb.dbo.sp_add_job @job_name = N'AuditDemo - Nightly Maintenance', @enabled = 1,
     @description = N'Nightly archive + reservation expiry for AuditDemo', @category_name = N'db-audit demo', @owner_login_name = N'sa';
EXEC msdb.dbo.sp_add_jobstep @job_name = N'AuditDemo - Nightly Maintenance', @step_id = 1, @step_name = N'Run nightly batch',
     @subsystem = N'TSQL', @database_name = N'AuditDemo', @command = N'EXEC dbo.usp_NightlyBatch;',
     @on_success_action = 3, @on_fail_action = 2, @retry_attempts = 1, @retry_interval = 5;
EXEC msdb.dbo.sp_add_jobstep @job_name = N'AuditDemo - Nightly Maintenance', @step_id = 2, @step_name = N'Expire reservations (dry run)',
     @subsystem = N'TSQL', @database_name = N'AuditDemo',
     @command = N'DECLARE @rc int;
EXEC @rc = dbo.usp_ExpireReservations @DryRun = 1;
IF @rc <> 0 THROW 50001, N''usp_ExpireReservations failed'', 1;',
     @on_success_action = 1, @on_fail_action = 2, @output_file_name = N'/var/opt/mssql/log/nightly_maintenance.txt';
EXEC msdb.dbo.sp_add_schedule @schedule_name = N'db-audit nightly 02:00', @freq_type = 4, @freq_interval = 1, @active_start_time = 20000;
EXEC msdb.dbo.sp_attach_schedule @job_name = N'AuditDemo - Nightly Maintenance', @schedule_name = N'db-audit nightly 02:00';
EXEC msdb.dbo.sp_add_jobserver @job_name = N'AuditDemo - Nightly Maintenance';
GO

/* ---------------------------------------------------------------- 2. inline T-SQL, two schedules */
EXEC msdb.dbo.sp_add_job @job_name = N'AuditDemo - Purge Audit and Settings', @enabled = 1,
     @description = N'Purge old audit rows and bump the settings cache version', @category_name = N'db-audit demo', @owner_login_name = N'sa';
EXEC msdb.dbo.sp_add_jobstep @job_name = N'AuditDemo - Purge Audit and Settings', @step_id = 1, @step_name = N'Purge and bump',
     @subsystem = N'TSQL', @database_name = N'AuditDemo',
     @command = N'SET XACT_ABORT ON;
BEGIN TRAN;
DELETE TOP (5000) FROM dbo.AuditLog
WHERE CreatedAt < DATEADD(DAY, -90, SYSUTCDATETIME());
UPDATE dbo.Settings
   SET SettingValue = CAST(CAST(SettingValue AS int) + 1 AS nvarchar(400)), UpdatedAt = SYSUTCDATETIME()
 WHERE SettingKey = ''CACHE_VERSION'';
UPDATE ops.JobWatermark SET LastRunUtc = SYSUTCDATETIME(), RowsAffected = @@ROWCOUNT
 WHERE JobName = N''$(ESCAPE_SQUOTE(JOBNAME))'';
COMMIT;',
     @on_success_action = 1, @on_fail_action = 2, @retry_attempts = 3, @retry_interval = 1;
EXEC msdb.dbo.sp_add_schedule @schedule_name = N'db-audit every 15 minutes', @freq_type = 4, @freq_interval = 1,
     @freq_subday_type = 4, @freq_subday_interval = 15, @active_start_time = 0, @active_end_time = 235959;
EXEC msdb.dbo.sp_add_schedule @schedule_name = N'db-audit weekly Sun 03:00', @freq_type = 8, @freq_interval = 1,
     @freq_recurrence_factor = 1, @active_start_time = 30000;
EXEC msdb.dbo.sp_attach_schedule @job_name = N'AuditDemo - Purge Audit and Settings', @schedule_name = N'db-audit every 15 minutes';
EXEC msdb.dbo.sp_attach_schedule @job_name = N'AuditDemo - Purge Audit and Settings', @schedule_name = N'db-audit weekly Sun 03:00';
EXEC msdb.dbo.sp_add_jobserver @job_name = N'AuditDemo - Purge Audit and Settings';
GO

/* ---------------------------------------------------------------- 3. disabled job with a non-T-SQL step */
EXEC msdb.dbo.sp_add_job @job_name = N'AuditDemo - Legacy Shipment Sync', @enabled = 0,
     @description = N'Old shipment sync job - replaced, kept disabled', @category_name = N'db-audit demo', @owner_login_name = N'sa';
EXEC msdb.dbo.sp_add_jobstep @job_name = N'AuditDemo - Legacy Shipment Sync', @step_id = 1, @step_name = N'Sync shipments',
     @subsystem = N'TSQL', @database_name = N'AuditDemo', @command = N'EXEC [dbo].[usp_SyncShipmentStatus];',
     @on_success_action = 4, @on_success_step_id = 2, @on_fail_action = 2;
EXEC msdb.dbo.sp_add_jobstep @job_name = N'AuditDemo - Legacy Shipment Sync', @step_id = 2, @step_name = N'Notify (shell)',
     @subsystem = N'CmdExec', @command = N'echo sync finished',
     @on_success_action = 1, @on_fail_action = 2;
EXEC msdb.dbo.sp_add_schedule @schedule_name = N'db-audit weekly Mon Wed 02:00', @freq_type = 8, @freq_interval = 10,
     @freq_recurrence_factor = 1, @active_start_time = 20000;
EXEC msdb.dbo.sp_attach_schedule @job_name = N'AuditDemo - Legacy Shipment Sync', @schedule_name = N'db-audit weekly Mon Wed 02:00';
EXEC msdb.dbo.sp_add_jobserver @job_name = N'AuditDemo - Legacy Shipment Sync';
GO

/* ---------------------------------------------------------------- 4. step runs in AuditArchive */
EXEC msdb.dbo.sp_add_job @job_name = N'AuditArchive - Compaction', @enabled = 1,
     @description = N'Compact the archive database', @category_name = N'db-audit demo', @owner_login_name = N'sa';
EXEC msdb.dbo.sp_add_jobstep @job_name = N'AuditArchive - Compaction', @step_id = 1, @step_name = N'Compact',
     @subsystem = N'TSQL', @database_name = N'AuditArchive', @command = N'EXEC dbo.usp_CompactArchive @KeepMonths = 24;',
     @on_success_action = 1, @on_fail_action = 2;
EXEC msdb.dbo.sp_add_schedule @schedule_name = N'db-audit monthly day 1 01:00', @freq_type = 16, @freq_interval = 1,
     @freq_recurrence_factor = 1, @active_start_time = 10000;
EXEC msdb.dbo.sp_attach_schedule @job_name = N'AuditArchive - Compaction', @schedule_name = N'db-audit monthly day 1 01:00';
EXEC msdb.dbo.sp_add_jobserver @job_name = N'AuditArchive - Compaction';
GO

/* ---------------------------------------------------------------- 5. designed to fail */
EXEC msdb.dbo.sp_add_job @job_name = N'AuditDemo - Points Check', @enabled = 1,
     @description = N'Raises an error on purpose so msdb has a failed run', @category_name = N'db-audit demo', @owner_login_name = N'sa';
EXEC msdb.dbo.sp_add_jobstep @job_name = N'AuditDemo - Points Check', @step_id = 1, @step_name = N'Check points',
     @subsystem = N'TSQL', @database_name = N'AuditDemo',
     @command = N'DECLARE @n int = (SELECT COUNT(*) FROM dbo.Member_Card WHERE PointsBalance >= 0);
RAISERROR(N''Points check failed on purpose (%d cards checked)'', 16, 1, @n);',
     @on_success_action = 1, @on_fail_action = 2, @retry_attempts = 0;
EXEC msdb.dbo.sp_add_schedule @schedule_name = N'db-audit every 6 hours', @freq_type = 4, @freq_interval = 1,
     @freq_subday_type = 8, @freq_subday_interval = 6, @active_start_time = 0, @active_end_time = 235959;
EXEC msdb.dbo.sp_attach_schedule @job_name = N'AuditDemo - Points Check', @schedule_name = N'db-audit every 6 hours';
EXEC msdb.dbo.sp_add_jobserver @job_name = N'AuditDemo - Points Check';
GO

/* ---------------------------------------------------------------- run four jobs once, wait for history */
EXEC msdb.dbo.sp_start_job @job_name = N'AuditDemo - Nightly Maintenance';
EXEC msdb.dbo.sp_start_job @job_name = N'AuditDemo - Purge Audit and Settings';
EXEC msdb.dbo.sp_start_job @job_name = N'AuditArchive - Compaction';
EXEC msdb.dbo.sp_start_job @job_name = N'AuditDemo - Points Check';
GO
DECLARE @tries int = 0, @done int = 0;
WHILE @tries < 120
BEGIN
    SELECT @done = COUNT(DISTINCT h.job_id)
    FROM msdb.dbo.sysjobhistory AS h
    JOIN msdb.dbo.sysjobs AS j ON j.job_id = h.job_id
    WHERE h.step_id = 0 AND j.name IN (N'AuditDemo - Nightly Maintenance', N'AuditDemo - Purge Audit and Settings',
                                       N'AuditArchive - Compaction', N'AuditDemo - Points Check');
    IF @done = 4 BREAK;
    WAITFOR DELAY '00:00:01';
    SET @tries += 1;
END;
IF @done < 4 RAISERROR(N'Agent jobs did not finish within 120 s (%d of 4 have outcome rows)', 16, 1, @done);
GO
