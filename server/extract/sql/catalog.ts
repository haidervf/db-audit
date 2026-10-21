/**
 * Catalog extraction (research §2, Q1–Q7), adapted: joins to sys.schemas instead of SCHEMA_NAME()
 * where possible, and an optional @ids object-id filter (see common.ts). All SELECT-only.
 */
import { EXECUTE_AS_DISPLAY, IDS_PREAMBLE, idFilter, typeDisplay } from './common';

/** Lightweight listing used for change detection (one row per user object, + database DDL triggers). */
export const LIST_OBJECTS = `
SELECT o.object_id, s.name AS schema_name, o.name AS object_name, RTRIM(o.type) AS type_code,
       o.create_date, o.modify_date, o.parent_object_id
FROM sys.objects AS o
JOIN sys.schemas AS s ON s.schema_id = o.schema_id
WHERE o.is_ms_shipped = 0
  AND o.type IN ('U', 'V', 'P', 'PC', 'FN', 'IF', 'TF', 'FS', 'FT', 'TR', 'TA')
UNION ALL
SELECT t.object_id, NULL, t.name, 'DDLTR', t.create_date, t.modify_date, 0
FROM sys.triggers AS t
WHERE t.parent_class = 0 AND t.is_ms_shipped = 0;
`;

/** Procedures, views and functions. definition NULL = encrypted (is_encrypted = 1) or no VIEW DEFINITION. */
export const MODULES = `
${IDS_PREAMBLE}
SELECT o.object_id, RTRIM(o.type) AS type_code, m.definition,
       CAST(ISNULL(OBJECTPROPERTY(o.object_id, 'IsEncrypted'), 0) AS bit) AS is_encrypted,
       CAST(CASE WHEN m.object_id IS NULL THEN 0 ELSE 1 END AS bit) AS has_module,
       m.uses_ansi_nulls, m.uses_quoted_identifier, m.is_schema_bound,
       ${EXECUTE_AS_DISPLAY} AS execute_as
FROM sys.objects AS o
LEFT JOIN sys.sql_modules AS m ON m.object_id = o.object_id
LEFT JOIN sys.database_principals AS dp ON dp.principal_id = m.execute_as_principal_id
WHERE o.is_ms_shipped = 0
  AND o.type IN ('P', 'PC', 'V', 'FN', 'IF', 'TF', 'FS', 'FT')
  AND ${idFilter('o.object_id')};
`;

/** parameter_id 0 = scalar function return value (name ''). has_default_value is not read: it is always 0 for T-SQL. */
export const PARAMETERS = `
${IDS_PREAMBLE}
SELECT p.object_id, p.parameter_id, p.name, ${typeDisplay('ty', 'p')} AS type_display,
       ty.is_table_type, p.is_output, p.is_readonly
FROM sys.parameters AS p
JOIN sys.objects AS o ON o.object_id = p.object_id
JOIN sys.types AS ty ON ty.user_type_id = p.user_type_id
WHERE o.is_ms_shipped = 0
  AND ${idFilter('p.object_id')}
ORDER BY p.object_id, p.parameter_id;
`;

/** Columns of tables, views and table-valued functions. */
export const COLUMNS = `
${IDS_PREAMBLE}
SELECT c.object_id, c.column_id, c.name AS column_name, ${typeDisplay('ty', 'c')} AS type_display,
       c.is_nullable, c.is_identity,
       CAST(ic.seed_value AS nvarchar(40)) AS identity_seed, CAST(ic.increment_value AS nvarchar(40)) AS identity_increment,
       c.is_computed, cc.definition AS computed_definition, cc.is_persisted,
       dc.name AS default_constraint_name, dc.definition AS default_definition,
       c.collation_name
FROM sys.columns AS c
JOIN sys.objects AS o ON o.object_id = c.object_id
JOIN sys.types AS ty ON ty.user_type_id = c.user_type_id
LEFT JOIN sys.computed_columns AS cc ON cc.object_id = c.object_id AND cc.column_id = c.column_id
LEFT JOIN sys.identity_columns AS ic ON ic.object_id = c.object_id AND ic.column_id = c.column_id
LEFT JOIN sys.default_constraints AS dc ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id
WHERE o.is_ms_shipped = 0 AND o.type IN ('U', 'V', 'IF', 'TF', 'FT')
  AND ${idFilter('c.object_id')}
ORDER BY c.object_id, c.column_id;
`;

export const TABLES = `
${IDS_PREAMBLE}
SELECT t.object_id, t.temporal_type_desc, t.is_memory_optimized
FROM sys.tables AS t
WHERE t.is_ms_shipped = 0
  AND ${idFilter('t.object_id')};
`;

/** Indexes / PK / UQ with key + included columns (tables and indexed views). */
export const INDEXES = `
${IDS_PREAMBLE}
SELECT i.object_id, i.index_id, i.name AS index_name, i.type_desc, i.is_primary_key, i.is_unique_constraint, i.is_unique,
       i.has_filter, i.filter_definition, i.is_disabled,
       ic.index_column_id, ic.key_ordinal, ic.is_included_column, ic.is_descending_key, c.name AS column_name
FROM sys.indexes AS i
JOIN sys.objects AS o ON o.object_id = i.object_id
JOIN sys.index_columns AS ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
JOIN sys.columns AS c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
WHERE o.is_ms_shipped = 0 AND o.type IN ('U', 'V') AND i.index_id > 0
  AND ${idFilter('i.object_id')}
ORDER BY i.object_id, i.index_id, ic.is_included_column, ic.key_ordinal, ic.index_column_id;
`;

/** Outgoing foreign keys of the selected tables, with column pairs. */
export const FOREIGN_KEYS = `
${IDS_PREAMBLE}
SELECT fk.object_id AS fk_id, fk.name AS fk_name, fk.parent_object_id,
       rs.name AS ref_schema, ro.name AS ref_table,
       fkc.constraint_column_id, pc.name AS parent_column, rc.name AS referenced_column,
       fk.delete_referential_action_desc, fk.update_referential_action_desc, fk.is_disabled, fk.is_not_trusted
FROM sys.foreign_keys AS fk
JOIN sys.objects AS ro ON ro.object_id = fk.referenced_object_id
JOIN sys.schemas AS rs ON rs.schema_id = ro.schema_id
JOIN sys.foreign_key_columns AS fkc ON fkc.constraint_object_id = fk.object_id
JOIN sys.columns AS pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
JOIN sys.columns AS rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
WHERE ${idFilter('fk.parent_object_id')}
ORDER BY fk.parent_object_id, fk.object_id, fkc.constraint_column_id;
`;

export const CHECK_CONSTRAINTS = `
${IDS_PREAMBLE}
SELECT cc.parent_object_id, cc.name, COL_NAME(cc.parent_object_id, cc.parent_column_id) AS column_name,
       cc.definition, cc.is_disabled
FROM sys.check_constraints AS cc
WHERE ${idFilter('cc.parent_object_id')}
ORDER BY cc.parent_object_id, cc.name;
`;

/** Row counts + size; needs VIEW DATABASE STATE (or VIEW DATABASE PERFORMANCE STATE). */
export const ROWCOUNTS_PARTITION_STATS = `
SELECT ps.object_id,
       SUM(CASE WHEN ps.index_id IN (0, 1) THEN ps.row_count ELSE 0 END) AS approx_rows,
       SUM(ps.reserved_page_count) * 8 AS reserved_kb
FROM sys.dm_db_partition_stats AS ps
JOIN sys.objects AS o ON o.object_id = ps.object_id
WHERE o.type = 'U' AND o.is_ms_shipped = 0
GROUP BY ps.object_id;
`;

/** Row counts with metadata visibility only. */
export const ROWCOUNTS_PARTITIONS = `
SELECT p.object_id, SUM(p.rows) AS approx_rows
FROM sys.partitions AS p
JOIN sys.objects AS o ON o.object_id = p.object_id
WHERE o.type = 'U' AND o.is_ms_shipped = 0 AND p.index_id IN (0, 1)
GROUP BY p.object_id;
`;

/** Synonyms (Phase B: the static-analysis resolver follows them to their base object). */
export const SYNONYMS = `
SELECT s.name AS schema_name, sy.name AS synonym_name, sy.base_object_name
FROM sys.synonyms AS sy
JOIN sys.schemas AS s ON s.schema_id = sy.schema_id;
`;

/** DML triggers (parent_class 1) and database DDL triggers (parent_class 0; not in sys.objects). */
export const TRIGGERS = `
${IDS_PREAMBLE}
SELECT t.object_id, t.parent_class, t.parent_id, ps.name AS parent_schema, po.name AS parent_name, RTRIM(po.type) AS parent_type,
       RTRIM(t.type) AS type_code, t.is_disabled, t.is_instead_of_trigger,
       STUFF((SELECT N',' + te.type_desc FROM sys.trigger_events AS te
              WHERE te.object_id = t.object_id ORDER BY te.type FOR XML PATH(''), TYPE).value('.', 'nvarchar(max)'), 1, 1, N'') AS events,
       m.definition,
       CAST(ISNULL(OBJECTPROPERTY(t.object_id, 'IsEncrypted'), 0) AS bit) AS is_encrypted,
       CAST(CASE WHEN m.object_id IS NULL THEN 0 ELSE 1 END AS bit) AS has_module,
       m.uses_ansi_nulls, m.uses_quoted_identifier, m.is_schema_bound,
       ${EXECUTE_AS_DISPLAY} AS execute_as
FROM sys.triggers AS t
LEFT JOIN sys.objects AS po ON t.parent_class = 1 AND po.object_id = t.parent_id
LEFT JOIN sys.schemas AS ps ON ps.schema_id = po.schema_id
LEFT JOIN sys.sql_modules AS m ON m.object_id = t.object_id
LEFT JOIN sys.database_principals AS dp ON dp.principal_id = m.execute_as_principal_id
WHERE t.is_ms_shipped = 0
  AND ${idFilter('t.object_id')};
`;
