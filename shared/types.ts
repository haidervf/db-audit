/**
 * db-audit REST API contract, shared by the server and the (future) web UI.
 * Fields marked "added" are additions to the Phase A spec; nothing from the spec was renamed or removed.
 */

export type { ModuleAnalysis, ObjectRef, TableAccess, TableOp, ProcCall, OutlineNode, StatementKind, DynamicSql } from '../server/analyze/tsql/types';
import type { ModuleAnalysis } from '../server/analyze/tsql/types';

export type AuthMode = 'sql' | 'entra-cli' | 'entra-interactive' | 'entra-default';

/**
 * Where jobs come from. 'auto' (default): SQL Server Agent jobs from msdb on the TARGET connection when
 * SERVERPROPERTY('EngineEdition') is 2/3/4/8 (8 = Managed Instance; 5 = Azure SQL Database has no Agent)
 * and msdb is readable, plus Elastic Jobs when a `jobs` endpoint is configured.
 */
export type JobsSource = 'auto' | 'agent' | 'elastic' | 'none';
export type JobSourceKind = 'agent' | 'elastic';

export interface DbEndpoint {
  server: string;
  database: string;
  port?: number;
}

export interface ConnectionInput {
  name: string;
  target: DbEndpoint;
  /** Elastic Jobs job database (optional) */
  jobs: DbEndpoint | null;
  /** added (scope change): default 'auto' */
  jobsSource?: JobsSource;
  auth: { mode: AuthMode; user?: string; password?: string; tenantId?: string; clientId?: string };
  /** readOnlyIntent (added, default false) -> ApplicationIntent=ReadOnly, e.g. for MI failover-group secondary listeners */
  options: { encrypt: boolean; trustServerCertificate: boolean; readOnlyIntent?: boolean };
}

export interface ConnectionProfile extends Omit<ConnectionInput, 'auth' | 'jobsSource' | 'options'> {
  id: string;
  jobsSource: JobsSource;
  options: { encrypt: boolean; trustServerCertificate: boolean; readOnlyIntent: boolean };
  createdAt: string;
  updatedAt: string;
  auth: { mode: AuthMode; user?: string; hasPassword: boolean; tenantId?: string; clientId?: string };
  lastRefreshAt: string | null;
}

export interface EndpointCheck {
  ok: boolean;
  error?: string;
  serverVersion?: string;
  database?: string;
  loginName?: string;
  permissions?: {
    viewDefinition: boolean;
    expressionDependencies: boolean;
    viewDatabaseState: boolean;
    jobsViews?: boolean;
    /** added (scope change): SQL Agent jobs readable from msdb (direct SELECT or msdb.dbo.sp_help_job*) */
    agentJobs?: boolean;
  };
  /** added: SERVERPROPERTY('Edition'), e.g. "SQL Azure" or "Developer Edition (64-bit)" */
  edition?: string;
  /** added: SERVERPROPERTY('EngineEdition'); 5 = Azure SQL Database, 8 = Azure SQL Managed Instance */
  engineEdition?: number;
  /** added: label for engineEdition, e.g. "Azure SQL Managed Instance" */
  engineEditionLabel?: string;
}

export interface ConnectionTestResult {
  ok: boolean;
  target: EndpointCheck;
  jobs: EndpointCheck | null;
}

export type ObjectKind = 'procedure' | 'table' | 'view' | 'function' | 'trigger';
export type Segment = 'procedures' | 'tables' | 'views' | 'functions' | 'triggers' | 'dependencies' | 'jobs' | 'analysis';
// 'analysis' = re-run the analyzer over cached definitions/step commands, no DB access. 'all' includes it.

export const OBJECT_KINDS: readonly ObjectKind[] = ['procedure', 'table', 'view', 'function', 'trigger'];
export const SEGMENTS: readonly Segment[] = ['tables', 'views', 'functions', 'procedures', 'triggers', 'dependencies', 'jobs', 'analysis'];

/** Schema name used for database-level DDL triggers (they have no schema). */
export const DATABASE_SCOPE_SCHEMA = '(database)';

/* ------------------------------------------------------------------ static analysis (Phase B) */

export interface ResolvedRef {
  key: string;                    // ObjectRef.key
  nodeId: string | null;          // graph node id if it maps to a cached local object ('table:dbo.OrderLog') or an external node ('external:otherdb.dbo.x')
  kind: ObjectKind | 'external' | 'unknown';
  exists: boolean;                // found in the local cache
  sameDatabaseQualified: boolean; // written as [ThisDb].[dbo].[X] (database == profile target DB, case-insensitive) -> treated as LOCAL
}
export interface AnalysisPayload extends ModuleAnalysis { resolved: Record<string, ResolvedRef>; analyzedAt: string; definitionSha256: string }
export interface AnalysisFlags { hasDynamicSql: boolean; hasCrossDb: boolean; readsTables: number; writesTables: number; callsProcs: number; warnings: number }
export interface UsageEdge { nodeId: string; kind: GraphNodeKind; label: string; relation: GraphEdge['relation']; ops: string[]; origin: Array<'server' | 'static'>; direction: 'in' | 'out' }

/* ------------------------------------------------------------------ AI descriptions (Phase B) */

export interface AiDescriptionContent {
  summary: string;   // 2-4 sentences, plain English
  purpose: string;   // inferred business purpose
  steps: Array<{ lines: string /* "12-20" or "Step 2" for jobs */; title: string; explanation: string }>;
  dataAccess: Array<{ object: string; access: string; why: string }>;
  calls: Array<{ object: string; why: string }>;
  risks: string[];   // e.g. NOLOCK dirty reads, swallowed errors, dynamic SQL, missing transactions
  notes: string[];
}
export interface AiDescription { model: string; effort: string; promptVersion: string; createdAt: string; definitionSha256: string; stale: boolean;
  content: AiDescriptionContent; usage: { inputTokens: number; outputTokens: number } | null }
export type AiDescriptionPayload = AiDescription;
export type AiEffort = 'low' | 'medium' | 'high' | 'xhigh';
export interface AiStatus { configured: boolean; keySource: 'settings' | 'env' | null; model: string; effort: AiEffort }
export interface AiSettingsInput { apiKey?: string | null; model?: string; effort?: AiEffort }  // apiKey null = clear

export interface ObjectSummary {
  kind: ObjectKind;
  schema: string;
  name: string;
  createDate: string;
  modifyDate: string;
  hasDefinition: boolean;
  isEncrypted: boolean;
  rowCount?: number | null;
  referencesCount: number;
  referencedByCount: number;
  /** added: sys.objects.type, e.g. 'P', 'U', 'FN', 'IF', 'TR', or 'DDLTR' for database DDL triggers */
  typeCode?: string;
  /** Phase B: static-analysis flags (null when the object has no analysis, e.g. tables or encrypted modules) */
  analysisFlags: AnalysisFlags | null;
}

export interface DependencyRef {
  server: string | null;
  database: string | null;
  schema: string | null;
  name: string;
  kind: ObjectKind | 'unknown' | 'external';
  resolved: boolean;
  /** added: sys.objects.type of the referenced object when the server resolved it (e.g. 'SO' for a sequence) */
  typeCode?: string | null;
  /**
   * added: how `resolved` was decided.
   * 'server'     the server bound the reference (referenced_id not null)
   * 'name-match' unbound by the server, but a cached object with the same schema.name exists
   *              (unqualified names are matched against schema dbo)
   * 'unresolved' nothing matched (missing object, alias artifact, temp object, or external)
   */
  resolution?: 'server' | 'name-match' | 'unresolved';
}

export interface Dependency {
  from: { kind: ObjectKind; schema: string; name: string };
  to: DependencyRef;
  isSelected: boolean | null;
  isUpdated: boolean | null;
  isAmbiguous: boolean;
  source: Array<'expression-dependencies' | 'referenced-entities'>;
  /** added */
  isCallerDependent?: boolean;
  /** added: sys.dm_sql_referenced_entities.is_incomplete (binding error / missing object); null when not available */
  isIncomplete?: boolean | null;
  /** added: column-level usage from sys.dm_sql_referenced_entities (empty when unavailable) */
  columns?: Array<{ name: string; isSelected: boolean; isUpdated: boolean }>;
}

/* ------------------------------------------------------------------ kind-specific details */

export interface ModuleSettings {
  usesAnsiNulls: boolean | null;
  usesQuotedIdentifier: boolean | null;
  isSchemaBound: boolean | null;
  /** null = EXECUTE AS CALLER (default); 'OWNER'; or a principal name */
  executeAs: string | null;
}

/** 'ok' definition present; 'encrypted' WITH ENCRYPTION; 'no-permission' NULL without IsEncrypted; 'clr' no sql_modules row */
export type DefinitionStatus = 'ok' | 'encrypted' | 'no-permission' | 'clr';

export interface ParameterInfo {
  ordinal: number;
  name: string;
  /** rendered like nvarchar(50), decimal(18,2), varchar(max), dbo.MyTableType */
  type: string;
  isOutput: boolean;
  isReadOnly: boolean;
  isTableType: boolean;
  /** always null: sys.parameters.has_default_value is unreliable for T-SQL modules (Phase B may parse it) */
  default: string | null;
}

export interface ColumnInfo {
  ordinal: number;
  name: string;
  type: string;
  nullable: boolean;
  isIdentity: boolean;
  identitySeed: string | null;
  identityIncrement: string | null;
  isComputed: boolean;
  computedDefinition: string | null;
  isPersisted: boolean;
  defaultName: string | null;
  defaultDefinition: string | null;
  collation: string | null;
}

export interface IndexInfo {
  name: string;
  type: string;
  isUnique: boolean;
  isPrimaryKey: boolean;
  isUniqueConstraint: boolean;
  keyColumns: Array<{ name: string; descending: boolean }>;
  includedColumns: string[];
  filter: string | null;
  isDisabled: boolean;
}

export interface ForeignKeyInfo {
  name: string;
  columns: Array<{ from: string; to: string }>;
  references: { schema: string; name: string };
  onDelete: string;
  onUpdate: string;
  isDisabled: boolean;
  isNotTrusted: boolean;
}

export interface CheckConstraintInfo {
  name: string;
  column: string | null;
  definition: string;
  isDisabled: boolean;
}

export type RowCountSource = 'dm_db_partition_stats' | 'sys.partitions';

export interface TableDetails {
  kind: 'table';
  columns: ColumnInfo[];
  primaryKey: { name: string; columns: string[] } | null;
  foreignKeys: ForeignKeyInfo[];
  /** FKs on other tables that point at this table (computed when the detail is read) */
  referencedByForeignKeys?: Array<{ name: string; from: { schema: string; name: string }; columns: Array<{ from: string; to: string }> }>;
  indexes: IndexInfo[];
  checkConstraints: CheckConstraintInfo[];
  rowCount: number | null;
  rowCountSource: RowCountSource | null;
  /** only with VIEW DATABASE STATE (sys.dm_db_partition_stats) */
  reservedKb: number | null;
  temporalType: string | null;
  isMemoryOptimized: boolean;
}

export interface ProcedureDetails {
  kind: 'procedure';
  parameters: ParameterInfo[];
  module: ModuleSettings;
  definitionStatus: DefinitionStatus;
}

export interface ViewDetails {
  kind: 'view';
  columns: ColumnInfo[];
  indexes: IndexInfo[];
  module: ModuleSettings;
  definitionStatus: DefinitionStatus;
}

export type FunctionType = 'scalar' | 'inline-tvf' | 'multi-tvf';

export interface FunctionDetails {
  kind: 'function';
  functionType: FunctionType;
  isClr: boolean;
  parameters: ParameterInfo[];
  /** scalar functions: rendered return type; table-valued: 'TABLE' */
  returnType: string | null;
  /** table-valued functions: the returned columns */
  returnColumns: ColumnInfo[];
  module: ModuleSettings;
  definitionStatus: DefinitionStatus;
}

export interface TriggerDetails {
  kind: 'trigger';
  triggerType: 'dml' | 'ddl-database';
  parent: { kind: 'table' | 'view'; schema: string; name: string } | null;
  events: string[];
  isInsteadOf: boolean;
  isDisabled: boolean;
  isClr: boolean;
  module: ModuleSettings;
  definitionStatus: DefinitionStatus;
}

export type ObjectDetails = TableDetails | ProcedureDetails | ViewDetails | FunctionDetails | TriggerDetails;

export interface ObjectDetail extends ObjectSummary {
  definition: string | null;
  /** kind-specific: one of TableDetails | ProcedureDetails | ViewDetails | FunctionDetails | TriggerDetails */
  details: Record<string, unknown>;
  references: Dependency[];
  referencedBy: Dependency[];
  /**
   * Job steps that use this object. 'analysis': the step's static analysis resolves a reference to this
   * object. 'text-match' (non-analyzable steps, or analyzable steps without an analysis row yet): text match
   * of the step command (schema-qualified name, or bare name for dbo) over steps whose targetsThisDb is true.
   */
  jobsUsing: Array<{ jobId: string; jobName: string; stepId: number; source: 'agent' | 'elastic'; via: 'analysis' | 'text-match' }>;
  /** outgoing 1-hop edges from the MERGED graph (server dependencies + static analysis) */
  uses: UsageEdge[];
  /** incoming 1-hop edges from the MERGED graph, incl. job steps that call/touch it */
  usedBy: UsageEdge[];
  analysis: AnalysisPayload | null;
  ai: AiDescription | null;
  /** added: sha256 of the definition (null when no definition) */
  definitionSha256?: string | null;
  /** added: when this object was last fetched from the server */
  fetchedAt?: string;
}

/* ------------------------------------------------------------------ jobs */

export interface TargetMember {
  membershipType: string;
  targetType: string;
  serverName: string | null;
  databaseName: string | null;
  elasticPoolName: string | null;
}

export interface JobStep {
  stepId: number;
  name: string;
  commandType: string;
  commandSource: string;
  command: string;
  credentialName: string | null;
  targetGroupName: string | null;
  targetMembers: TargetMember[];
  retryAttempts: number | null;
  stepTimeoutSeconds: number | null;
  maxParallelism: number | null;
  targetsThisDb: boolean;
  analysis: AnalysisPayload | null;
  /** added (scope change): Agent subsystem ('TSQL', 'CmdExec', 'PowerShell', 'SSIS', ...); elastic: the command type */
  subsystem: string | null;
  /** Agent: database the step runs in; elastic: null (targets come from the target group) */
  databaseName: string | null;
  /** Agent flow control, e.g. "Go to next step", "Go to step 3", "Quit reporting failure"; elastic: null */
  onSuccess: string | null;
  onFail: string | null;
  retryIntervalMinutes: number | null;
  outputFileName: string | null;
  /** only T-SQL steps can be statically analysed (Phase B); SSIS/PowerShell/CmdExec keep subsystem + command only */
  analyzable: boolean;
  /**
   * added: why targetsThisDb is what it is.
   * Agent: 'database' when database_name equals the profile's target database, else 'none'.
   * Elastic: 'database' an Include SqlDatabase member matches; 'server' an Include SqlServer member matches;
   * 'excluded' matched but an Exclude member removes it; 'pool-unknown' only elastic-pool members
   * (pool membership cannot be read from the job database); 'none' no match.
   */
  targetMatch?: 'database' | 'server' | 'excluded' | 'pool-unknown' | 'none';
}

export interface JobExecution {
  jobExecutionId: string;
  jobName: string;
  stepId: number | null;
  stepName: string | null;
  lifecycle: string;
  isActive: boolean;
  createTime: string | null;
  startTime: string | null;
  endTime: string | null;
  lastMessage: string | null;
  targetServerName: string | null;
  targetDatabaseName: string | null;
  currentAttempts: number | null;
  /** added (scope change). Agent: run_status label (Failed / Succeeded / Retry / Canceled / In progress); elastic: null */
  runStatus: string | null;
  /** Agent: decoded run_duration; elastic: end - start when both are known */
  durationSeconds: number | null;
}

export interface JobSummary {
  /** uniqueidentifier, upper case (both sources); used in GET /jobs/:jobId and graph ids job:<jobId> */
  jobId: string;
  /** added (scope change) */
  source: JobSourceKind;
  /** Agent job category; elastic: null */
  category: string | null;
  /** Agent job owner login; elastic: null */
  owner: string | null;
  /** Agent: last_run_outcome (Succeeded / Failed / Canceled / Unknown); elastic: lifecycle of the last job execution */
  lastRunOutcome: string | null;
  /** next scheduled run (ISO, UTC) when known */
  nextRun: string | null;
  name: string;
  description: string | null;
  enabled: boolean;
  version: number;
  scheduleText: string;
  stepCount: number;
  targetsThisDb: boolean;
  lastExecution: JobExecution | null;
}

export interface JobDetail extends JobSummary {
  /** Elastic Jobs schedule; all fields null for Agent jobs (see `schedules`) */
  schedule: { intervalType: string | null; intervalCount: number | null; startTime: string | null; endTime: string | null };
  /** added (scope change): Agent schedules (a job can have several); elastic: one entry derived from `schedule` */
  schedules: Array<{ name: string; enabled: boolean; text: string; nextRun: string | null }>;
  steps: JobStep[];
  executions: JobExecution[];
  ai: AiDescription | null;
}

/* ------------------------------------------------------------------ refresh */

export interface RefreshRequest {
  segments: Segment[] | 'all';
  mode: 'full' | 'incremental';
  /** when present and non-empty, only these objects (and their dependencies) are refreshed; `segments` is ignored */
  objects?: Array<{ kind: ObjectKind; schema: string; name: string }>;
}

export interface SegmentCounts {
  added: number;
  updated: number;
  removed: number;
  unchanged: number;
}

/** added: a DB object a refresh warning is about (database-scoped objects use schema DATABASE_SCOPE_SCHEMA) */
export interface WarningObjectRef { kind: ObjectKind; schema: string; name: string }

/** added: structured form of a refresh warning; `message` is identical to the matching entry in RefreshRun.warnings */
export interface RunWarning {
  message: string;
  /** DB objects this warning is about (may be many) */
  objects?: WarningObjectRef[];
  /** Agent job this warning is about (jobId as used by GET /connections/:id/jobs/:jobId) */
  job?: { jobId: string; name: string };
}

export interface RefreshRun {
  id: string;
  connectionId: string;
  /** 'cancelled' (added): stopped by the user via POST .../refresh/:runId/cancel */
  status: 'running' | 'succeeded' | 'failed' | 'partial' | 'cancelled';
  startedAt: string;
  finishedAt: string | null;
  request: RefreshRequest;
  /**
   * while running: units of the current phase (objects / modules); when finished: phase 'done', segments completed / attempted.
   * step (added, optional): human-readable sub-step of the current phase, e.g. "Reading expression dependencies".
   */
  progress: { phase: string; done: number; total: number; step?: string };
  counts: Partial<Record<Segment, SegmentCounts>>;
  warnings: string[];
  /** added: always present; same order and length as `warnings` */
  warningDetails: RunWarning[];
  error?: string;
  /** added: per-segment error messages for segments that failed (status 'partial' or 'failed') */
  segmentErrors?: Partial<Record<Segment, string>>;
}

/* ------------------------------------------------------------------ graph */

export type GraphNodeKind = ObjectKind | 'job' | 'jobstep' | 'external' | 'unknown';

export interface GraphNode {
  id: string;
  kind: GraphNodeKind;
  label: string;
  schema?: string;
  name: string;
  meta?: Record<string, unknown>;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  relation: 'calls' | 'reads' | 'writes' | 'references' | 'has-step' | 'trigger-on' | 'fk';
  ops?: string[];
  origin: Array<'server' | 'static'>;
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated: boolean;
}

export const ENGINE_EDITIONS: Readonly<Record<number, string>> = {
  1: 'Personal or Desktop Engine',
  2: 'Standard',
  3: 'Enterprise (incl. Developer, Evaluation)',
  4: 'Express',
  5: 'Azure SQL Database',
  6: 'Azure Synapse Analytics',
  8: 'Azure SQL Managed Instance',
  9: 'Azure SQL Edge',
  11: 'Azure Synapse serverless SQL pool',
  12: 'Microsoft Fabric SQL database',
};

/** Engine editions that have SQL Server Agent / msdb jobs (5 = Azure SQL Database does not). */
export const AGENT_ENGINE_EDITIONS: readonly number[] = [2, 3, 4, 8];

/* ------------------------------------------------------------------ insights */

/**
 * GET /api/connections/:id/insights -> InsightsReport. Computed on request from the cache only (no SQL Server
 * queries). The same report is rendered by the web UI and sent to Claude for an AI review (AiInsightsAnalysis).
 */
export type InsightCategoryId = 'usage' | 'code-risk' | 'dependency-health' | 'schema-health' | 'jobs-ops';
/** How much a non-empty insight matters. Fixed per insight id (it does not change with `total`); 'info' = context, not a problem. */
export type InsightSeverity = 'info' | 'low' | 'medium' | 'high';

/** One row of an insight: a DB object, a job, or (rarely) plain text. */
export interface InsightItem {
  /** display text, e.g. 'dbo.Orders' (DDL triggers: the bare name); job items: the job name, or 'Job #2 Step' for job steps */
  label: string;
  /** set when the item is a DB object (database-scoped objects use schema DATABASE_SCOPE_SCHEMA) */
  object?: WarningObjectRef;
  /** set when the item is a job or a job step (jobId as used by GET /connections/:id/jobs/:jobId) */
  job?: { jobId: string; name: string };
  /** short fact, e.g. '42 refs', 'BEGIN TRAN ×2, no TRY/CATCH' */
  detail?: string;
  /** metric the items are sorted by, when meaningful (e.g. reference count, row count, seconds) */
  value?: number;
}

export interface Insight {
  /** stable kebab-case id, e.g. 'most-referenced-tables'; every id is always present in the report */
  id: string;
  category: InsightCategoryId;
  title: string;
  /** 1–2 sentences for a DBA: what it means / why it matters */
  description: string;
  severity: InsightSeverity;
  /** number of items before truncation */
  total: number;
  /** sorted most important first; capped at 500 (some insights cap lower, e.g. largest-tables at 50) */
  items: InsightItem[];
  /** limits of the data behind it, e.g. 'dynamic SQL and app calls are invisible, verify before dropping' */
  caveat?: string;
  /** false when the data it needs is not in the cache (segment never refreshed, no static analysis); items is empty and total 0 then */
  available: boolean;
  /** why available is false */
  unavailableReason?: string;
}

export interface InsightCategory { id: InsightCategoryId; title: string; description: string }

export interface InsightsReport {
  /** ISO timestamp of the computation */
  generatedAt: string;
  /** in display order */
  categories: InsightCategory[];
  /** in display order, grouped by category (same order as `categories`) */
  insights: Insight[];
  /** sha256 (hex) of JSON.stringify({ categories, insights }), i.e. everything except generatedAt; used for AI staleness */
  sha256: string;
}

/* ------------------------------------------------------------------ AI insights review */

export interface AiInsightFinding {
  title: string;
  severity: 'high' | 'medium' | 'low';
  category: InsightCategoryId;
  /** Insight.id(s) this finding draws on */
  insightIds: string[];
  explanation: string;
  /** objects it concerns (may be empty) */
  objects: WarningObjectRef[];
  recommendation: string;
}
export interface AiInsightsContent { summary: string; findings: AiInsightFinding[]; quickWins: string[]; notes: string[] }
/**
 * AI review of the insights of selected categories (POST /connections/:id/insights/analyze, cached:
 * GET /connections/:id/insights/analysis?categories=a,b, which answers 200 with JSON `null` when no review is
 * cached for that category set). Same envelope as AiDescription (model, effort,
 * promptVersion, createdAt, definitionSha256, stale, usage), with these meanings here: `definitionSha256` =
 * sha256 of the selected insights payload the review was generated from (the insights of `categories` only,
 * not the whole report); `stale` = that sha recomputed now from the current cache differs, so a change in an
 * unselected category never makes it stale.
 */
export interface AiInsightsAnalysis extends Omit<AiDescription, 'content'> {
  /** categories that were sent to the model (the review covers only these) */
  categories: InsightCategoryId[];
  content: AiInsightsContent;
}

export interface ConnectionSummary {
  connection: ConnectionProfile;
  counts: Record<ObjectKind | 'job', number>;
  lastRefresh: RefreshRun | null;
  warnings: string[];
  /** added: parallel to `warnings` */
  warningDetails: RunWarning[];
  serverInfo: Record<string, unknown> | null;
}

export interface ApiError {
  error: string;
  details?: unknown;
}
