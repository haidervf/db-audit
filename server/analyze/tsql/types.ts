// Public contract of the T-SQL static analyzer. Fields marked "added" are optional
// extensions beyond the original contract; everything else is the agreed shape.

export interface AnalyzeOptions { defaultSchema?: string /* default 'dbo' */; quotedIdentifier?: boolean /* default true */ }
export interface ObjectRef {
  server: string | null;   // linked server (4-part name)
  database: string | null; // 3-part name
  schema: string | null;   // as written; null if omitted
  name: string;            // unquoted
  key: string;             // normalized lowercase; defaultSchema applied: 'dbo.orderlog', 'otherdb.dbo.x', 'srv.db.dbo.x'
  display: string;         // as written, e.g. '[dbo].[OrderLog]'
}
export type TableOp = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'MERGE' | 'SELECT_INTO' | 'TRUNCATE' | 'CREATE' | 'DROP' | 'ALTER' | 'INSERT_EXEC';
export interface TableAccess {
  ref: ObjectRef; ops: TableOp[]; aliases: string[]; lines: number[] /* statement start lines, deduped, sorted */;
  isSystem?: boolean;      // added: schema is sys or INFORMATION_SCHEMA
}
export interface CallArg { name: string | null; value: string; isOutput: boolean }
export interface ProcCall { ref: ObjectRef; line: number; returnVar: string | null; args: CallArg[]; isSystem: boolean /* sp_* or sys schema */; viaInsertExec: boolean }
export interface FunctionCall { ref: ObjectRef; line: number; kind: 'scalar' | 'table-valued' }
export interface SequenceRef { ref: ObjectRef; line: number }
export type DynamicSqlKind = 'EXEC_STRING' | 'SP_EXECUTESQL' | 'EXEC_PROC_VARIABLE' | 'OPENQUERY' | 'OPENROWSET' | 'OPENDATASOURCE' | 'EXEC_AT';
export interface DynamicSql { line: number; kind: DynamicSqlKind; snippet: string /* ≤200 chars */ }
export type StatementKind = 'DECLARE' | 'SET' | 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'MERGE' | 'TRUNCATE' | 'EXEC' | 'IF' | 'ELSE' | 'WHILE'
  | 'BLOCK' | 'TRY' | 'CATCH' | 'BEGIN_TRAN' | 'COMMIT' | 'ROLLBACK' | 'SAVE_TRAN' | 'RETURN' | 'RAISERROR' | 'THROW' | 'PRINT'
  | 'CREATE_TABLE' | 'DROP_TABLE' | 'ALTER_TABLE' | 'CREATE_INDEX' | 'CURSOR' | 'OPEN' | 'FETCH' | 'CLOSE' | 'DEALLOCATE'
  | 'GOTO' | 'LABEL' | 'WAITFOR' | 'BREAK' | 'CONTINUE' | 'USE' | 'SET_OPTION' | 'WITH_CTE' | 'OTHER';
export interface OutlineNode { kind: StatementKind; startLine: number; endLine: number; text: string /* first line trimmed ≤160 chars */;
  summary: string; targets: string[] /* ObjectRef.key values touched */; children: OutlineNode[];
  mainKind?: StatementKind; // added: for WITH_CTE nodes, the kind of the statement the CTEs feed (SELECT/INSERT/UPDATE/DELETE/MERGE)
}
export interface Param { name: string; type: string; default: string | null; isOutput: boolean; isReadonly: boolean }
export interface ModuleHeader { kind: 'PROCEDURE' | 'FUNCTION' | 'VIEW' | 'TRIGGER'; ref: ObjectRef; parameters: Param[]; bodyStartLine: number; triggerTable?: ObjectRef | null }
export interface ModuleAnalysis {
  analyzerVersion: string;
  header: ModuleHeader | null;              // null for scripts / job step commands
  tables: TableAccess[];                    // objects in table position (real tables or views; NOT temp tables / table variables / CTEs)
  tempTables: TableAccess[];                // #t, ##t
  tableVariables: Array<{ name: string; line: number }>;
  ctes: Array<{ name: string; line: number }>;
  procCalls: ProcCall[];
  functionCalls: FunctionCall[];
  sequences: SequenceRef[];
  dynamicSql: DynamicSql[];
  crossDatabaseRefs: ObjectRef[];           // any ref with database != null (deduped by key)
  linkedServerRefs: ObjectRef[];            // any ref with server != null
  transactions: { begin: number; commit: number; rollback: number; save: number };
  hasTryCatch: boolean;
  cursors: Array<{ name: string; line: number }>;
  gotoLabels: string[];
  outline: OutlineNode[];
  warnings: Array<{ line: number | null; message: string }>;
  stats: { lines: number; statements: number; batches: number; durationMs: number };
  linkedServers?: string[];                 // added: linked server names seen via 4-part names, OPENQUERY(srv, …) and EXEC (…) AT srv
}
export declare function analyzeModule(sqlText: string, opts?: AnalyzeOptions): ModuleAnalysis; // implemented in index.ts — MUST NEVER THROW
