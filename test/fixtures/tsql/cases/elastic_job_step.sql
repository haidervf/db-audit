-- Elastic Jobs step: purge and log
DECLARE @job NVARCHAR(128) = N'$(job_name)';
INSERT INTO dbo.JobRunLog (JobName, JobExecutionId, CreatedAt)
VALUES ('$(job_name)', '$(job_execution_id)', GETDATE());
DELETE TOP (5000) FROM dbo.AuditTrail WHERE CreatedAt < DATEADD(DAY, -90, GETDATE());
EXEC dbo.usp_PurgeStaging @JobId = $(job_id), @Step = '$(step_id)';
