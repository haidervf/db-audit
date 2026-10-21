/**
 * Dependency extraction. Two sources, merged per (referencing object, referenced entity):
 *  - sys.sql_expression_dependencies in bulk (needs GRANT SELECT ON sys.sql_expression_dependencies);
 *  - sys.dm_sql_referenced_entities per module, inside a server-side TRY/CATCH (research finding 3:
 *    a stale module or a missing object must not fail the request). Works with VIEW DEFINITION alone.
 */

/**
 * Bulk expression dependencies, object-level (referenced_class 1). CHECK/DEFAULT constraint rows are
 * attributed to their parent table (owner_id). Database DDL triggers have referencing_class 12.
 * Unfiltered: the caller keeps only the owners it asked for.
 */
export const EXPRESSION_DEPENDENCIES = `
SELECT d.owner_id, d.referencing_class, d.referencing_minor_id,
       d.referenced_server_name, d.referenced_database_name, d.referenced_schema_name, d.referenced_entity_name,
       d.referenced_id, d.referenced_minor_id,
       ts.name AS resolved_schema, tgt.name AS resolved_name, RTRIM(tgt.type) AS referenced_type,
       COL_NAME(d.referenced_id, NULLIF(d.referenced_minor_id, 0)) AS referenced_column,
       d.is_caller_dependent, d.is_ambiguous
FROM (
  SELECT CASE WHEN sd.referencing_class = 1 AND ro.type IN ('C', 'D') THEN ro.parent_object_id ELSE sd.referencing_id END AS owner_id,
         sd.referencing_class, sd.referencing_minor_id,
         sd.referenced_server_name, sd.referenced_database_name, sd.referenced_schema_name, sd.referenced_entity_name,
         sd.referenced_id, sd.referenced_minor_id, sd.referenced_class, sd.is_caller_dependent, sd.is_ambiguous
  FROM sys.sql_expression_dependencies AS sd
  LEFT JOIN sys.objects AS ro ON sd.referencing_class = 1 AND ro.object_id = sd.referencing_id
) AS d
LEFT JOIN sys.objects AS tgt ON tgt.object_id = d.referenced_id
LEFT JOIN sys.schemas AS ts ON ts.schema_id = tgt.schema_id
WHERE d.referenced_class = 1 AND d.referencing_class IN (1, 12);
`;

/**
 * One module. @name = QUOTENAME(schema) + '.' + QUOTENAME(name) (or the bare trigger name for
 * database DDL triggers), @class = N'OBJECT' | N'DATABASE_DDL_TRIGGER'.
 * Result set 1: entity + column rows. Result set 2: the caught error, if any.
 * The INSERT targets a table variable only (allowed by the read-only guard).
 */
export const REFERENCED_ENTITIES = `
SET NOCOUNT ON;
DECLARE @r TABLE (
  referenced_server_name sysname NULL, referenced_database_name sysname NULL, referenced_schema_name sysname NULL,
  referenced_entity_name sysname NULL, referenced_minor_name sysname NULL, referenced_id int NULL, referenced_minor_id int NULL,
  referenced_class tinyint NULL, is_caller_dependent bit NULL, is_ambiguous bit NULL, is_selected bit NULL, is_updated bit NULL,
  is_select_all bit NULL, is_all_columns_found bit NULL, is_incomplete bit NULL);
DECLARE @error_number int = NULL, @error_message nvarchar(4000) = NULL;
BEGIN TRY
  INSERT INTO @r (referenced_server_name, referenced_database_name, referenced_schema_name, referenced_entity_name,
                  referenced_minor_name, referenced_id, referenced_minor_id, referenced_class, is_caller_dependent, is_ambiguous,
                  is_selected, is_updated, is_select_all, is_all_columns_found, is_incomplete)
  SELECT re.referenced_server_name, re.referenced_database_name, re.referenced_schema_name, re.referenced_entity_name,
         re.referenced_minor_name, re.referenced_id, re.referenced_minor_id, re.referenced_class, re.is_caller_dependent, re.is_ambiguous,
         re.is_selected, re.is_updated, re.is_select_all, re.is_all_columns_found, re.is_incomplete
  FROM sys.dm_sql_referenced_entities(@name, @class) AS re;
END TRY
BEGIN CATCH
  SELECT @error_number = ERROR_NUMBER(), @error_message = ERROR_MESSAGE();
END CATCH;
SELECT r.referenced_server_name, r.referenced_database_name, r.referenced_schema_name, r.referenced_entity_name,
       r.referenced_minor_name, r.referenced_id, r.referenced_minor_id, r.referenced_class,
       r.is_caller_dependent, r.is_ambiguous, r.is_selected, r.is_updated, r.is_select_all, r.is_all_columns_found, r.is_incomplete,
       ts.name AS resolved_schema, tgt.name AS resolved_name, RTRIM(tgt.type) AS referenced_type
FROM @r AS r
LEFT JOIN sys.objects AS tgt ON r.referenced_class = 1 AND tgt.object_id = r.referenced_id
LEFT JOIN sys.schemas AS ts ON ts.schema_id = tgt.schema_id;
SELECT @error_number AS error_number, @error_message AS error_message;
`;

/**
 * Diagnostic call WITHOUT TRY/CATCH, made only for modules whose rows came back is_incomplete = 1.
 * The request is expected to fail; the error numbers classify the module: 207/208/4104 (binding
 * error -> stale module) vs 2020 alone (references objects that do not exist). Errors are handled
 * client-side and never fail the refresh.
 */
export const REFERENCED_ENTITIES_DIAGNOSE = `
SELECT COUNT_BIG(*) AS n FROM sys.dm_sql_referenced_entities(@name, @class);
`;
