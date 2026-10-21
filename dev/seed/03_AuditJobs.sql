/* db-audit dev seed: AuditJobs, a MOCK Azure Elastic Jobs job database. DEV TOOLING ONLY.
   The public surface is views in schema [jobs] named and typed like the GA Elastic Jobs views
   (jobs.jobs, jobs.job_versions, jobs.jobsteps, jobs.jobstep_versions, jobs.target_groups,
   jobs.target_group_members, jobs.job_executions). They are backed by invented jobs_internal tables
   (the real internal tables are undocumented). Modelled on the documented Elastic Jobs views.
   Run with: sqlcmd -C -b -I -x  (-x keeps the $(job_name) token literal). Idempotent.

   Expected (asserted by the integration tests):
     5 jobs (1 disabled), 6 current steps, 4 target groups, 7 members, 13 execution rows.
   targetsThisDb for a profile pointing at localhost / AuditDemo:
     NightlyMaintenance=yes (db member), PurgeAuditAndSettings=yes (server member), LegacyRebuild=yes,
     ArchiveCompaction=no, TenantStats=no (elastic pool on another server)
   ... and for localhost / AuditArchive:
     ArchiveCompaction=yes, PurgeAuditAndSettings=no (AuditArchive is excluded), all others no. */
SET NOCOUNT ON;
GO
IF DB_ID(N'AuditJobs') IS NOT NULL
BEGIN
    ALTER DATABASE AuditJobs SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
    DROP DATABASE AuditJobs;
END;
GO
CREATE DATABASE AuditJobs;
GO
USE AuditJobs;
GO
CREATE SCHEMA jobs_internal AUTHORIZATION dbo;
GO
CREATE SCHEMA jobs AUTHORIZATION dbo;
GO
CREATE TABLE jobs_internal.target_groups (
    target_group_id   uniqueidentifier NOT NULL CONSTRAINT PK_tg PRIMARY KEY DEFAULT NEWID(),
    target_group_name nvarchar(128)    NOT NULL CONSTRAINT UQ_tg_name UNIQUE
);
CREATE TABLE jobs_internal.target_group_members (
    target_id               uniqueidentifier NOT NULL CONSTRAINT PK_tgm PRIMARY KEY DEFAULT NEWID(),
    target_group_id         uniqueidentifier NOT NULL REFERENCES jobs_internal.target_groups(target_group_id),
    membership_type         nvarchar(11)     NOT NULL CHECK (membership_type IN (N'Include', N'Exclude')),
    target_type             nvarchar(128)    NOT NULL CHECK (target_type IN (N'SqlServer', N'SqlElasticPool', N'SqlDatabase')),
    refresh_credential_name nvarchar(128)    NULL,
    subscription_id         uniqueidentifier NULL,
    resource_group_name     nvarchar(128)    NULL,
    server_name             nvarchar(128)    NOT NULL,
    database_name           nvarchar(128)    NULL,
    elastic_pool_name       nvarchar(128)    NULL
);
CREATE TABLE jobs_internal.jobs (
    job_id                  uniqueidentifier NOT NULL CONSTRAINT PK_jobs PRIMARY KEY DEFAULT NEWID(),
    job_name                nvarchar(128)    NOT NULL CONSTRAINT UQ_jobs_name UNIQUE,
    job_version             int              NOT NULL,
    description             nvarchar(512)    NOT NULL DEFAULT N'',
    enabled                 bit              NOT NULL DEFAULT 0,
    schedule_interval_type  nvarchar(50)     NOT NULL DEFAULT N'Once'
        CHECK (schedule_interval_type IN (N'Once', N'Minutes', N'Hours', N'Days', N'Weeks', N'Months')),
    schedule_interval_count int              NOT NULL DEFAULT 1,
    schedule_start_time     datetime2(7)     NOT NULL DEFAULT '0001-01-01T00:00:00',
    schedule_end_time       datetime2(7)     NOT NULL DEFAULT '9999-12-31T11:59:59'
);
CREATE TABLE jobs_internal.job_versions (
    job_id      uniqueidentifier NOT NULL REFERENCES jobs_internal.jobs(job_id),
    job_version int              NOT NULL,
    CONSTRAINT PK_job_versions PRIMARY KEY (job_id, job_version)
);
CREATE TABLE jobs_internal.jobstep_versions (
    job_id                            uniqueidentifier NOT NULL,
    job_version                       int              NOT NULL,
    step_id                           int              NOT NULL,
    step_name                         nvarchar(128)    NOT NULL,
    command_type                      nvarchar(50)     NOT NULL DEFAULT N'TSql',
    command_source                    nvarchar(50)     NOT NULL DEFAULT N'Inline',
    command                           nvarchar(max)    NOT NULL,
    credential_name                   nvarchar(128)    NULL,
    target_group_id                   uniqueidentifier NOT NULL REFERENCES jobs_internal.target_groups(target_group_id),
    initial_retry_interval_seconds    int              NOT NULL DEFAULT 1,
    maximum_retry_interval_seconds    int              NOT NULL DEFAULT 120,
    retry_interval_backoff_multiplier real             NOT NULL DEFAULT 2.0,
    retry_attempts                    int              NOT NULL DEFAULT 10,
    step_timeout_seconds              int              NOT NULL DEFAULT 43200,
    output_type                       nvarchar(11)     NULL,
    output_credential_name            nvarchar(128)    NULL,
    output_subscription_id            uniqueidentifier NULL,
    output_resource_group_name        nvarchar(128)    NULL,
    output_server_name                nvarchar(256)    NULL,
    output_database_name              nvarchar(128)    NULL,
    output_schema_name                nvarchar(max)    NULL,
    output_table_name                 nvarchar(max)    NULL,
    max_parallelism                   int              NULL,
    CONSTRAINT PK_jobstep_versions PRIMARY KEY (job_id, job_version, step_id),
    CONSTRAINT FK_jsv_jv FOREIGN KEY (job_id, job_version) REFERENCES jobs_internal.job_versions(job_id, job_version)
);
CREATE TABLE jobs_internal.job_executions (
    row_id                     bigint IDENTITY(1,1) NOT NULL CONSTRAINT PK_je PRIMARY KEY,
    job_execution_id           uniqueidentifier NOT NULL,
    job_id                     uniqueidentifier NOT NULL REFERENCES jobs_internal.jobs(job_id),
    job_version                int              NOT NULL,
    step_id                    int              NULL,
    is_active                  bit              NOT NULL,
    lifecycle                  nvarchar(50)     NOT NULL CHECK (lifecycle IN (N'Created', N'InProgress', N'WaitingForRetry',
                                   N'Succeeded', N'SucceededWithSkipped', N'Failed', N'TimedOut', N'Canceled', N'Skipped',
                                   N'WaitingForChildJobExecutions')),
    create_time                datetime2(7)     NOT NULL,
    start_time                 datetime2(7)     NULL,
    end_time                   datetime2(7)     NULL,
    current_attempts           int              NOT NULL,
    current_attempt_start_time datetime2(7)     NULL,
    next_attempt_start_time    datetime2(7)     NULL,
    last_message               nvarchar(max)    NULL,
    target_type                nvarchar(128)    NULL,
    target_id                  uniqueidentifier NULL,
    target_group_name          nvarchar(128)    NULL,
    target_server_name         nvarchar(256)    NULL,
    target_database_name       nvarchar(128)    NULL
);
GO
CREATE VIEW jobs.target_groups AS
SELECT target_group_name, target_group_id FROM jobs_internal.target_groups;
GO
CREATE VIEW jobs.target_group_members AS
SELECT tg.target_group_name, m.target_group_id, m.membership_type, m.target_type, m.target_id,
       m.refresh_credential_name, m.subscription_id, m.resource_group_name,
       m.server_name, m.database_name, m.elastic_pool_name
FROM jobs_internal.target_group_members AS m
JOIN jobs_internal.target_groups AS tg ON tg.target_group_id = m.target_group_id;
GO
CREATE VIEW jobs.jobs AS
SELECT job_name, job_id, job_version, description, enabled, schedule_interval_type,
       schedule_interval_count, schedule_start_time, schedule_end_time
FROM jobs_internal.jobs;
GO
CREATE VIEW jobs.job_versions AS
SELECT j.job_name, v.job_id, v.job_version
FROM jobs_internal.job_versions AS v JOIN jobs_internal.jobs AS j ON j.job_id = v.job_id;
GO
CREATE VIEW jobs.jobstep_versions AS
SELECT j.job_name, s.job_id, s.job_version, s.step_id, s.step_name, s.command_type, s.command_source,
       s.command, s.credential_name, tg.target_group_name, s.target_group_id,
       s.initial_retry_interval_seconds, s.maximum_retry_interval_seconds,
       s.retry_interval_backoff_multiplier, s.retry_attempts, s.step_timeout_seconds,
       s.output_type, s.output_credential_name, s.output_subscription_id, s.output_resource_group_name,
       s.output_server_name, s.output_database_name, s.output_schema_name, s.output_table_name,
       s.max_parallelism
FROM jobs_internal.jobstep_versions AS s
JOIN jobs_internal.jobs AS j ON j.job_id = s.job_id
JOIN jobs_internal.target_groups AS tg ON tg.target_group_id = s.target_group_id;
GO
CREATE VIEW jobs.jobsteps AS
SELECT v.* FROM jobs.jobstep_versions AS v
JOIN jobs_internal.jobs AS j ON j.job_id = v.job_id AND j.job_version = v.job_version;
GO
CREATE VIEW jobs.job_executions AS
SELECT e.job_execution_id, j.job_name, e.job_id, e.job_version, e.step_id, e.is_active, e.lifecycle,
       e.create_time, e.start_time, e.end_time, e.current_attempts, e.current_attempt_start_time,
       e.next_attempt_start_time, e.last_message, e.target_type, e.target_id, e.target_group_name,
       e.target_server_name, e.target_database_name
FROM jobs_internal.job_executions AS e JOIN jobs_internal.jobs AS j ON j.job_id = e.job_id;
GO
CREATE ROLE jobs_reader AUTHORIZATION dbo;
GRANT SELECT ON SCHEMA::jobs TO jobs_reader;
GO

DECLARE @tgDemo    uniqueidentifier = 'A1A1A1A1-0000-4000-8000-000000000001',
        @tgServer  uniqueidentifier = 'A1A1A1A1-0000-4000-8000-000000000002',
        @tgArchive uniqueidentifier = 'A1A1A1A1-0000-4000-8000-000000000003',
        @tgPool    uniqueidentifier = 'A1A1A1A1-0000-4000-8000-000000000004',
        @mDemoDb   uniqueidentifier = 'B2B2B2B2-0000-4000-8000-000000000001',
        @mSrv      uniqueidentifier = 'B2B2B2B2-0000-4000-8000-000000000002',
        @mExclArc  uniqueidentifier = 'B2B2B2B2-0000-4000-8000-000000000003',
        @mExclJobs uniqueidentifier = 'B2B2B2B2-0000-4000-8000-000000000004',
        @mArcDb    uniqueidentifier = 'B2B2B2B2-0000-4000-8000-000000000005',
        @mPool     uniqueidentifier = 'B2B2B2B2-0000-4000-8000-000000000006',
        @mPoolExcl uniqueidentifier = 'B2B2B2B2-0000-4000-8000-000000000007',
        @jNightly  uniqueidentifier = 'C3C3C3C3-0000-4000-8000-000000000001',
        @jPurge    uniqueidentifier = 'C3C3C3C3-0000-4000-8000-000000000002',
        @jLegacy   uniqueidentifier = 'C3C3C3C3-0000-4000-8000-000000000003',
        @jArchive  uniqueidentifier = 'C3C3C3C3-0000-4000-8000-000000000004',
        @jTenant   uniqueidentifier = 'C3C3C3C3-0000-4000-8000-000000000005',
        @sub       uniqueidentifier = '11111111-2222-3333-4444-555555555555';

INSERT jobs_internal.target_groups (target_group_id, target_group_name) VALUES
 (@tgDemo, N'AuditDemoGroup'), (@tgServer, N'AllLocalDatabases'), (@tgArchive, N'ArchiveOnly'), (@tgPool, N'RemoteTenantPool');

/* server_name 'localhost' = the local container; the pool members point at a made-up remote server. */
INSERT jobs_internal.target_group_members
 (target_id, target_group_id, membership_type, target_type, refresh_credential_name, subscription_id, resource_group_name, server_name, database_name, elastic_pool_name)
VALUES
 (@mDemoDb,   @tgDemo,    N'Include', N'SqlDatabase',    NULL, @sub, N'rg-local',   N'localhost',                  N'AuditDemo',    NULL),
 (@mSrv,      @tgServer,  N'Include', N'SqlServer',      N'refresh_cred', @sub, N'rg-local', N'localhost',         NULL,            NULL),
 (@mExclArc,  @tgServer,  N'Exclude', N'SqlDatabase',    NULL, @sub, N'rg-local',   N'localhost',                  N'AuditArchive', NULL),
 (@mExclJobs, @tgServer,  N'Exclude', N'SqlDatabase',    NULL, @sub, N'rg-local',   N'localhost',                  N'AuditJobs',    NULL),
 (@mArcDb,    @tgArchive, N'Include', N'SqlDatabase',    NULL, @sub, N'rg-local',   N'localhost',                  N'AuditArchive', NULL),
 (@mPool,     @tgPool,    N'Include', N'SqlElasticPool', NULL, @sub, N'rg-tenants', N'tenants-sql.example.invalid', NULL,           N'tenant-pool-01'),
 (@mPoolExcl, @tgPool,    N'Exclude', N'SqlDatabase',    NULL, @sub, N'rg-tenants', N'tenants-sql.example.invalid', N'tenant_demo', NULL);

INSERT jobs_internal.jobs (job_id, job_name, job_version, description, enabled, schedule_interval_type, schedule_interval_count, schedule_start_time, schedule_end_time) VALUES
 (@jNightly, N'NightlyMaintenance',    2, N'Nightly archive + reservation expiry for AuditDemo',     1, N'Days',    1, '2026-01-01T02:00:00', '9999-12-31T11:59:59'),
 (@jPurge,   N'PurgeAuditAndSettings', 1, N'Purge old audit rows and bump settings cache version',   1, N'Minutes', 15, '2026-01-01T00:00:00', '9999-12-31T11:59:59'),
 (@jLegacy,  N'LegacyRebuild',         3, N'Old shipment sync job - replaced, kept disabled',        0, N'Weeks',   1, '2025-06-01T03:00:00', '9999-12-31T11:59:59'),
 (@jArchive, N'ArchiveCompaction',     1, N'One-off compaction of the archive database',             1, N'Once',    1, '2026-11-01T01:00:00', '9999-12-31T11:59:59'),
 (@jTenant,  N'TenantStats',           1, N'',                                                       1, N'Hours',   6, '2026-03-01T00:30:00', '2027-03-01T00:00:00');

INSERT jobs_internal.job_versions (job_id, job_version) VALUES
 (@jNightly, 1), (@jNightly, 2), (@jPurge, 1), (@jLegacy, 1), (@jLegacy, 2), (@jLegacy, 3), (@jArchive, 1), (@jTenant, 1);

INSERT jobs_internal.jobstep_versions
 (job_id, job_version, step_id, step_name, command, credential_name, target_group_id, retry_attempts, step_timeout_seconds, max_parallelism)
VALUES
 /* NightlyMaintenance v1 (history only) */
 (@jNightly, 1, 1, N'RunNightlyBatch', N'EXEC dbo.usp_NightlyBatch;', NULL, @tgDemo, 10, 43200, NULL),
 /* NightlyMaintenance v2 (current): 2 steps */
 (@jNightly, 2, 1, N'RunNightlyBatch', N'EXEC dbo.usp_NightlyBatch;', NULL, @tgDemo, 3, 7200, 1),
 (@jNightly, 2, 2, N'ExpireReservations',
  N'DECLARE @rc int;
EXEC @rc = dbo.usp_ExpireReservations @DryRun = 1;
IF @rc <> 0 THROW 50001, N''usp_ExpireReservations failed'', 1;', NULL, @tgDemo, 3, 3600, 1),
 /* PurgeAuditAndSettings: inline T-SQL, server-level target */
 (@jPurge, 1, 1, N'PurgeAndBump',
  N'SET XACT_ABORT ON;
BEGIN TRAN;
DELETE TOP (5000) FROM dbo.AuditLog
WHERE CreatedAt < DATEADD(DAY, -90, SYSUTCDATETIME());
UPDATE dbo.Settings
   SET SettingValue = CAST(CAST(SettingValue AS int) + 1 AS nvarchar(400)), UpdatedAt = SYSUTCDATETIME()
 WHERE SettingKey = ''CACHE_VERSION'';
UPDATE ops.JobWatermark SET LastRunUtc = SYSUTCDATETIME(), RowsAffected = @@ROWCOUNT
 WHERE JobName = N''$(job_name)'';
COMMIT;', NULL, @tgServer, 2, 600, 4),
 /* LegacyRebuild (disabled) */
 (@jLegacy, 1, 1, N'SyncShipments', N'EXEC dbo.usp_SyncShipmentStatus;', N'legacy_job_cred', @tgDemo, 10, 43200, NULL),
 (@jLegacy, 2, 1, N'SyncShipments', N'EXEC dbo.usp_SyncShipmentStatus;', N'legacy_job_cred', @tgDemo, 10, 43200, NULL),
 (@jLegacy, 3, 1, N'SyncShipments', N'EXEC [dbo].[usp_SyncShipmentStatus];', N'legacy_job_cred', @tgDemo, 5, 3600, NULL),
 /* ArchiveCompaction: targets AuditArchive */
 (@jArchive, 1, 1, N'Compact', N'EXEC dbo.usp_CompactArchive @KeepMonths = 24;', NULL, @tgArchive, 1, 1800, NULL),
 /* TenantStats: remote elastic pool */
 (@jTenant, 1, 1, N'CollectStats', N'SELECT DB_NAME() AS db, COUNT(*) AS tables FROM sys.tables;', NULL, @tgPool, 0, 300, 8);

DECLARE @e1 uniqueidentifier = 'D4D4D4D4-0000-4000-8000-000000000001',
        @e2 uniqueidentifier = 'D4D4D4D4-0000-4000-8000-000000000002',
        @e3 uniqueidentifier = 'D4D4D4D4-0000-4000-8000-000000000003',
        @e4 uniqueidentifier = 'D4D4D4D4-0000-4000-8000-000000000004',
        @e5 uniqueidentifier = 'D4D4D4D4-0000-4000-8000-000000000005',
        @tDemo uniqueidentifier = 'E5E5E5E5-0000-4000-8000-000000000001';
INSERT jobs_internal.job_executions
 (job_execution_id, job_id, job_version, step_id, is_active, lifecycle, create_time, start_time, end_time, current_attempts,
  current_attempt_start_time, next_attempt_start_time, last_message, target_type, target_id, target_group_name, target_server_name, target_database_name)
VALUES
 /* NightlyMaintenance succeeded on 2026-10-12 */
 (@e1, @jNightly, 2, NULL, 0, N'Succeeded', '2026-10-12T02:00:00.1', '2026-10-12T02:00:01', '2026-10-12T02:06:40', 0, NULL, NULL, N'Job execution succeeded.', NULL, NULL, NULL, NULL, NULL),
 (@e1, @jNightly, 2, 1, 0, N'Succeeded', '2026-10-12T02:00:01', '2026-10-12T02:00:02', '2026-10-12T02:05:10', 1, '2026-10-12T02:00:02', NULL, N'Command(s) completed successfully.', N'SqlDatabase', @mDemoDb, N'AuditDemoGroup', N'localhost', N'AuditDemo'),
 (@e1, @jNightly, 2, 2, 0, N'Succeeded', '2026-10-12T02:05:10', '2026-10-12T02:05:11', '2026-10-12T02:06:39', 1, '2026-10-12T02:05:11', NULL, N'Command(s) completed successfully.', N'SqlDatabase', @mDemoDb, N'AuditDemoGroup', N'localhost', N'AuditDemo'),
 /* NightlyMaintenance failed on 2026-10-13 */
 (@e2, @jNightly, 2, NULL, 0, N'Failed', '2026-10-13T02:00:00.1', '2026-10-13T02:00:01', '2026-10-13T02:09:12', 0, NULL, NULL, N'Job execution failed: one or more child executions failed.', NULL, NULL, NULL, NULL, NULL),
 (@e2, @jNightly, 2, 1, 0, N'Succeeded', '2026-10-13T02:00:01', '2026-10-13T02:00:02', '2026-10-13T02:04:00', 1, '2026-10-13T02:00:02', NULL, N'Command(s) completed successfully.', N'SqlDatabase', @mDemoDb, N'AuditDemoGroup', N'localhost', N'AuditDemo'),
 (@e2, @jNightly, 2, 2, 0, N'Failed', '2026-10-13T02:04:00', '2026-10-13T02:04:01', '2026-10-13T02:09:11', 4, '2026-10-13T02:08:00', NULL,
  N'Failed to execute script for target [localhost/AuditDemo]: Lock request time out period exceeded. (Msg 1222, Level 16, State 56, Line 2)',
  N'SqlDatabase', @mDemoDb, N'AuditDemoGroup', N'localhost', N'AuditDemo'),
 /* PurgeAuditAndSettings: one server expansion run + one active retry */
 (@e3, @jPurge, 1, NULL, 0, N'Succeeded', '2026-10-14T00:15:00', '2026-10-14T00:15:01', '2026-10-14T00:15:09', 0, NULL, NULL, N'Job execution succeeded.', NULL, NULL, NULL, NULL, NULL),
 (@e3, @jPurge, 1, 1, 0, N'Succeeded', '2026-10-14T00:15:01', '2026-10-14T00:15:02', '2026-10-14T00:15:03', 1, '2026-10-14T00:15:02', NULL, N'Successfully expanded server into 1 database targets.', N'SqlServer', @mSrv, N'AllLocalDatabases', N'localhost', NULL),
 (@e3, @jPurge, 1, 1, 0, N'Succeeded', '2026-10-14T00:15:03', '2026-10-14T00:15:04', '2026-10-14T00:15:08', 1, '2026-10-14T00:15:04', NULL, N'Command(s) completed successfully.', N'SqlDatabase', @tDemo, N'AllLocalDatabases', N'localhost', N'AuditDemo'),
 (@e4, @jPurge, 1, NULL, 1, N'WaitingForChildJobExecutions', '2026-10-14T00:30:00', '2026-10-14T00:30:01', NULL, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
 (@e4, @jPurge, 1, 1, 1, N'WaitingForRetry', '2026-10-14T00:30:01', '2026-10-14T00:30:02', NULL, 2, '2026-10-14T00:30:05', '2026-10-14T00:30:09',
  N'Lock request time out period exceeded. (Msg 1222, Level 16, State 56)', N'SqlDatabase', @tDemo, N'AllLocalDatabases', N'localhost', N'AuditDemo'),
 /* LegacyRebuild ran before it was disabled */
 (@e5, @jLegacy, 3, NULL, 0, N'Succeeded', '2026-09-20T03:00:00', '2026-09-20T03:00:01', '2026-09-20T03:00:30', 0, NULL, NULL, N'Job execution succeeded.', NULL, NULL, NULL, NULL, NULL),
 (@e5, @jLegacy, 3, 1, 0, N'Succeeded', '2026-09-20T03:00:01', '2026-09-20T03:00:02', '2026-09-20T03:00:29', 1, '2026-09-20T03:00:02', NULL, N'Command(s) completed successfully.', N'SqlDatabase', @mDemoDb, N'AuditDemoGroup', N'localhost', N'AuditDemo');
GO
