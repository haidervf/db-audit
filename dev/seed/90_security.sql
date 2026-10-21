/* db-audit dev seed: logins + users for the local container. DEV TOOLING ONLY.
   Run WITHOUT -x (needs scripting variables READER_PASSWORD, FULL_PASSWORD, NOJOBS_PASSWORD from dev/.env.dev).
   Permission matrix:
     audit_reader  AuditDemo/AuditArchive: VIEW DEFINITION only (no expression-deps grant, no DB state)
                   AuditJobs: member of jobs_reader (SELECT on schema jobs)
     audit_full    AuditDemo/AuditArchive: VIEW DEFINITION + VIEW DATABASE STATE
                   + GRANT SELECT ON sys.sql_expression_dependencies
                   AuditJobs: member of jobs_reader
     both          msdb: user in SQLAgentReaderRole (the Managed Instance permission for reading Agent jobs).
                   Members of that role are DENIED direct SELECT on msdb.dbo.sysjobs/sysjobsteps/... (verified,
                   Msg 229), so the app falls back to msdb.dbo.sp_help_job* for them.
     audit_full    msdb: additionally SELECT on the Agent tables, to exercise the direct-SELECT extraction path
     audit_nojobs  AuditDemo: VIEW DEFINITION only; no msdb user (proves the "Agent jobs not readable" degradation) */
SET NOCOUNT ON;
GO
USE master;
GO
IF SUSER_ID(N'audit_reader') IS NOT NULL DROP LOGIN audit_reader;
IF SUSER_ID(N'audit_full') IS NOT NULL DROP LOGIN audit_full;
IF SUSER_ID(N'audit_nojobs') IS NOT NULL DROP LOGIN audit_nojobs;
GO
CREATE LOGIN audit_reader WITH PASSWORD = N'$(READER_PASSWORD)', CHECK_POLICY = ON, DEFAULT_DATABASE = AuditDemo;
CREATE LOGIN audit_full   WITH PASSWORD = N'$(FULL_PASSWORD)',   CHECK_POLICY = ON, DEFAULT_DATABASE = AuditDemo;
CREATE LOGIN audit_nojobs WITH PASSWORD = N'$(NOJOBS_PASSWORD)', CHECK_POLICY = ON, DEFAULT_DATABASE = AuditDemo;
GO

USE AuditDemo;
GO
CREATE USER audit_reader FOR LOGIN audit_reader;
CREATE USER audit_full   FOR LOGIN audit_full;
CREATE USER audit_nojobs FOR LOGIN audit_nojobs;
GRANT VIEW DEFINITION TO audit_reader;
GRANT VIEW DEFINITION TO audit_full;
GRANT VIEW DEFINITION TO audit_nojobs;
GRANT VIEW DATABASE STATE TO audit_full;
GRANT SELECT ON sys.sql_expression_dependencies TO audit_full;
GO

USE AuditArchive;
GO
CREATE USER audit_reader FOR LOGIN audit_reader;
CREATE USER audit_full   FOR LOGIN audit_full;
GRANT VIEW DEFINITION TO audit_reader;
GRANT VIEW DEFINITION TO audit_full;
GRANT VIEW DATABASE STATE TO audit_full;
GRANT SELECT ON sys.sql_expression_dependencies TO audit_full;
GO

USE AuditJobs;
GO
CREATE USER audit_reader FOR LOGIN audit_reader;
CREATE USER audit_full   FOR LOGIN audit_full;
ALTER ROLE jobs_reader ADD MEMBER audit_reader;
ALTER ROLE jobs_reader ADD MEMBER audit_full;
GO

/* msdb is not dropped by the database scripts, so remove any users left by a previous seed first. */
USE msdb;
GO
IF USER_ID(N'audit_reader') IS NOT NULL DROP USER audit_reader;
IF USER_ID(N'audit_full') IS NOT NULL DROP USER audit_full;
IF USER_ID(N'audit_nojobs') IS NOT NULL DROP USER audit_nojobs;
GO
CREATE USER audit_reader FOR LOGIN audit_reader;
CREATE USER audit_full   FOR LOGIN audit_full;
ALTER ROLE SQLAgentReaderRole ADD MEMBER audit_reader;
ALTER ROLE SQLAgentReaderRole ADD MEMBER audit_full;
GRANT SELECT ON dbo.sysjobs         TO audit_full;
GRANT SELECT ON dbo.sysjobsteps     TO audit_full;
GRANT SELECT ON dbo.sysschedules    TO audit_full;
GRANT SELECT ON dbo.sysjobschedules TO audit_full;
GRANT SELECT ON dbo.sysjobservers   TO audit_full;
GRANT SELECT ON dbo.sysjobhistory   TO audit_full;
GRANT SELECT ON dbo.sysjobactivity  TO audit_full;
GO
