/**
 * Shared SQL fragments. Every statement built from these is a SELECT against catalog views.
 *
 * Object-id filters: detail queries take @ids nvarchar(max) holding "<i>1</i><i>2</i>..." (NULL = all
 * objects). XML shredding is used instead of OPENJSON / STRING_SPLIT because those need database
 * compatibility level 130+.
 */
export const IDS_PREAMBLE = `DECLARE @idx xml = CAST(@ids AS xml);`;

export function idFilter(column: string): string {
  return `(@ids IS NULL OR ${column} IN (SELECT n.i.value('.', 'int') FROM @idx.nodes('/i') AS n(i)))`;
}

/** Renders a type like nvarchar(50), decimal(18,2), varchar(max), datetime2(3), dbo.MyType. */
export function typeDisplay(ty: string, c: string): string {
  return `CASE
    WHEN ${ty}.is_user_defined = 1 THEN SCHEMA_NAME(${ty}.schema_id) + N'.' + ${ty}.name
    WHEN ${ty}.name IN (N'varchar', N'char', N'varbinary', N'binary')
      THEN ${ty}.name + N'(' + CASE WHEN ${c}.max_length = -1 THEN N'max' ELSE CAST(${c}.max_length AS nvarchar(10)) END + N')'
    WHEN ${ty}.name IN (N'nvarchar', N'nchar')
      THEN ${ty}.name + N'(' + CASE WHEN ${c}.max_length = -1 THEN N'max' ELSE CAST(${c}.max_length / 2 AS nvarchar(10)) END + N')'
    WHEN ${ty}.name IN (N'decimal', N'numeric')
      THEN ${ty}.name + N'(' + CAST(${c}.precision AS nvarchar(10)) + N',' + CAST(${c}.scale AS nvarchar(10)) + N')'
    WHEN ${ty}.name IN (N'datetime2', N'time', N'datetimeoffset')
      THEN ${ty}.name + N'(' + CAST(${c}.scale AS nvarchar(10)) + N')'
    WHEN ${ty}.name = N'float' AND ${c}.precision <> 53
      THEN N'float(' + CAST(${c}.precision AS nvarchar(10)) + N')'
    ELSE ${ty}.name
  END`;
}

export const EXECUTE_AS_DISPLAY = `CASE WHEN m.execute_as_principal_id IS NULL THEN NULL
       WHEN m.execute_as_principal_id = -2 THEN N'OWNER'
       ELSE dp.name END`;
