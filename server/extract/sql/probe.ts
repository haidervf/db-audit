/**
 * Server info + permission probes (connection test and the start of every refresh).
 * The permission-sensitive reads run inside TRY/CATCH: Msg 229 (SELECT denied on
 * sys.sql_expression_dependencies) and Msg 262 (VIEW DATABASE PERFORMANCE STATE denied on
 * sys.dm_db_partition_stats) are execution-time errors and are caught.
 */
export const TARGET_PROBE = `
SET NOCOUNT ON;
DECLARE @x int, @deps bit = 0, @dps bit = 0, @deps_error nvarchar(400) = NULL, @dps_error nvarchar(400) = NULL;
BEGIN TRY
  SELECT TOP (1) @x = d.referencing_id FROM sys.sql_expression_dependencies AS d;
  SET @deps = 1;
END TRY
BEGIN CATCH
  SET @deps_error = CONCAT(N'Msg ', ERROR_NUMBER(), N': ', ERROR_MESSAGE());
END CATCH;
BEGIN TRY
  SELECT TOP (1) @x = ps.partition_number FROM sys.dm_db_partition_stats AS ps;
  SET @dps = 1;
END TRY
BEGIN CATCH
  SET @dps_error = CONCAT(N'Msg ', ERROR_NUMBER(), N': ', ERROR_MESSAGE());
END CATCH;
SELECT
  CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(128))  AS product_version,
  CAST(SERVERPROPERTY('ProductLevel') AS nvarchar(128))    AS product_level,
  CAST(SERVERPROPERTY('Edition') AS nvarchar(128))         AS edition,
  CAST(SERVERPROPERTY('EngineEdition') AS int)             AS engine_edition,
  @@SERVERNAME                                             AS server_name,
  DB_NAME()                                                AS database_name,
  SUSER_SNAME()                                            AS login_name,
  USER_NAME()                                              AS user_name,
  CAST(DATABASEPROPERTYEX(DB_NAME(), 'Collation') AS nvarchar(128)) AS collation_name,
  (SELECT d.compatibility_level FROM sys.databases AS d WHERE d.database_id = DB_ID()) AS compatibility_level,
  CAST(ISNULL(HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'VIEW DEFINITION'), 0) AS bit) AS view_definition,
  CAST(ISNULL(HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'VIEW DATABASE STATE'), 0) AS bit) AS has_view_database_state,
  @deps       AS expression_dependencies,
  @deps_error AS expression_dependencies_error,
  @dps        AS partition_stats,
  @dps_error  AS partition_stats_error;
`;

/** Job database probe. OBJECT_ID + HAS_PERMS_BY_NAME instead of TRY/CATCH: a missing view is a
 *  deferred-name-resolution error, which TRY/CATCH at the same level cannot catch. */
export const JOBS_PROBE = `
SELECT
  CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(128))  AS product_version,
  CAST(SERVERPROPERTY('Edition') AS nvarchar(128))         AS edition,
  CAST(SERVERPROPERTY('EngineEdition') AS int)             AS engine_edition,
  DB_NAME()                                                AS database_name,
  SUSER_SNAME()                                            AS login_name,
  CAST(ISNULL(HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'VIEW DEFINITION'), 0) AS bit) AS view_definition,
  CAST(ISNULL(HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'VIEW DATABASE STATE'), 0) AS bit) AS has_view_database_state,
  CAST(CASE WHEN OBJECT_ID(N'jobs.jobs') IS NOT NULL
             AND HAS_PERMS_BY_NAME(N'jobs.jobs', 'OBJECT', 'SELECT') = 1 THEN 1 ELSE 0 END AS bit) AS jobs_views;
`;
