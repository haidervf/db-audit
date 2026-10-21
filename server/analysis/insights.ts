import type {
  Insight,
  InsightCategory,
  InsightCategoryId,
  InsightItem,
  InsightSeverity,
  InsightsReport,
  JobSummary,
  ModuleSettings,
  ObjectKind,
  TableDetails,
  TriggerDetails,
  WarningObjectRef,
} from '../../shared/types';
import { DATABASE_SCOPE_SCHEMA } from '../../shared/types';
import type { FullGraph } from '../api/graph';
import { objectNodeId, type ReadModel, type ResolvedDependency } from '../api/readModel';
import type { ExtractedExecution } from '../extract/jobTypes';
import { formatUtc } from '../extract/schedule';
import { sha256, type AnalysisSignals, type CachedJobRow, type CachedObjectRow, type StoredAnalysisRefs } from '../store/cacheStore';

/**
 * Audit insights: a structured report computed from one connection's cache (no SQL Server access). Every
 * insight id in INSIGHT_IDS is always present; an insight whose source data is not in the cache has
 * available = false and an unavailableReason instead of items.
 *
 * buildInsightsReport() is pure over InsightsInput; insightsInput() gathers that input from a ReadModel.
 */

/** item cap of every insight (largest-tables uses LARGEST_TABLES_CAP) */
export const INSIGHT_ITEM_CAP = 500;
export const LARGEST_TABLES_CAP = 50;

/** shape of the `dependency_issues` meta written by the refresh orchestrator */
export interface DependencyIssueMeta {
  kind: ObjectKind;
  schema: string;
  name: string;
  type: 'stale' | 'missing-references' | 'failed';
  message: string;
}

export interface InsightsInput {
  objects: CachedObjectRow[];
  /** objectNodeId -> number of server dependency rows that reference it from another object (= ObjectSummary.referencedByCount) */
  referencedByCount: Map<string, number>;
  deps: ResolvedDependency[];
  /** merged graph (server dependencies + static analysis), uncut */
  graph: FullGraph;
  /** compact analysis refs + flags by target key */
  analyses: Map<string, StoredAnalysisRefs>;
  /** code-risk fields of every analysis row */
  signals: AnalysisSignals[];
  /** `dependency_issues` meta; null when it was never written */
  dependencyIssues: Record<string, DependencyIssueMeta> | null;
  jobs: CachedJobRow[];
  jobSummaries: JobSummary[];
  executions: ExtractedExecution[];
  /** segments with counts in any stored refresh run */
  refreshedSegments: Set<string>;
  /** the profile's target database (for cross-database detection) */
  targetDatabase: string;
}

export function insightsInput(rm: ReadModel): InsightsInput {
  const referencedByCount = new Map<string, number>();
  for (const o of rm.objects) referencedByCount.set(objectNodeId(o.kind, o.schema, o.name), rm.referencedBy(o.kind, o.schema, o.name).length);
  return {
    objects: rm.objects,
    referencedByCount,
    deps: rm.deps,
    graph: rm.fullGraph(),
    analyses: rm.analyses(),
    signals: rm.store.listAnalysisSignals(),
    dependencyIssues: rm.store.getMeta<Record<string, DependencyIssueMeta>>('dependency_issues'),
    jobs: rm.jobs(),
    jobSummaries: rm.jobSummaries(),
    executions: rm.store.listExecutions(),
    refreshedSegments: rm.store.refreshedSegments(),
    targetDatabase: rm.conn.target.database,
  };
}

export function computeInsights(rm: ReadModel, now = new Date()): InsightsReport {
  return buildInsightsReport(insightsInput(rm), now);
}

/* ------------------------------------------------------------------ categories + insight definitions */

export const INSIGHT_CATEGORIES: InsightCategory[] = [
  { id: 'usage', title: 'Usage', description: 'Which tables and procedures are used, and which look unused, based on server dependencies, static analysis and job steps.' },
  { id: 'code-risk', title: 'Code risk', description: 'Patterns in module code (procedures, functions, views, triggers) that make it fragile, insecure or hard to audit.' },
  { id: 'dependency-health', title: 'Dependency health', description: 'Modules that no longer compile, point at objects that do not exist, or whose references SQL Server could not resolve.' },
  { id: 'schema-health', title: 'Schema health', description: 'Table-level integrity and maintenance issues: missing keys, untrusted constraints, disabled indexes and triggers, and size.' },
  { id: 'jobs-ops', title: 'Jobs and operations', description: 'SQL Server Agent and Elastic Jobs that fail, are disabled or unscheduled, are getting slower, or ignore step failures.' },
];

interface InsightDef {
  id: string;
  category: InsightCategoryId;
  title: string;
  description: string;
  severity: InsightSeverity;
  caveat?: string;
  cap?: number;
}

const D = {
  mostReferencedTables: {
    id: 'most-referenced-tables',
    category: 'usage',
    title: 'Most-referenced tables',
    description: 'Tables referenced by the most modules. Changes to these tables have the widest blast radius, so test and review them first.',
    severity: 'info',
    caveat: 'Counts server-recorded dependencies from other objects (one per referencing object); job steps, static-analysis-only references, dynamic SQL and application code are not counted.',
  },
  orphanProcedures: {
    id: 'orphan-procedures',
    category: 'usage',
    title: 'Orphan procedure candidates',
    description: 'Procedures that no procedure, trigger, function, view or job step in this database calls. They may be dead code, or entry points called only by applications.',
    severity: 'low',
    caveat: 'Calls from applications, other databases, dynamic SQL and ad-hoc scripts are invisible; verify before dropping.',
  },
  unreferencedTables: {
    id: 'unreferenced-tables',
    category: 'usage',
    title: 'Unreferenced tables',
    description: 'Tables that no module or job step in this database reads or writes. They may be obsolete, or used only by applications, ETL or other databases.',
    severity: 'low',
    caveat: 'Application queries, ad-hoc SQL, other databases and dynamic SQL are invisible, and foreign keys do not count as use; verify before dropping.',
  },
  dynamicSql: {
    id: 'dynamic-sql',
    category: 'code-risk',
    title: 'Dynamic SQL',
    description: 'Modules that build and execute SQL at run time. The objects they touch are invisible to dependency tracking, and string-built SQL is a SQL-injection risk.',
    severity: 'medium',
  },
  crossDatabase: {
    id: 'cross-database',
    category: 'code-risk',
    title: 'Cross-database and linked-server references',
    description: 'Modules that reference other databases or linked servers. They break when a database is renamed, moved or restored on its own, and Azure SQL Database does not support them.',
    severity: 'low',
  },
  transactionsWithoutTryCatch: {
    id: 'transactions-without-try-catch',
    category: 'code-risk',
    title: 'Transactions without TRY/CATCH',
    description: 'Modules that open a transaction but have no TRY/CATCH. An error can leave the transaction open, holding locks until the connection closes; "unbalanced" ones have no COMMIT or ROLLBACK at all.',
    severity: 'medium',
    caveat: 'Static counts only: SET XACT_ABORT ON, or a transaction committed by the caller, can make this safe.',
  },
  cursors: {
    id: 'cursors',
    category: 'code-risk',
    title: 'Cursors',
    description: 'Modules that declare cursors. Row-by-row processing is usually much slower than a set-based statement and holds locks longer.',
    severity: 'low',
  },
  executeAs: {
    id: 'execute-as',
    category: 'code-risk',
    title: 'EXECUTE AS (impersonation)',
    description: 'Modules that run as OWNER or another principal instead of the caller. Callers get that principal\'s permissions inside the module, so review them for privilege escalation.',
    severity: 'medium',
  },
  ansiSettingsOff: {
    id: 'ansi-settings-off',
    category: 'code-risk',
    title: 'ANSI_NULLS / QUOTED_IDENTIFIER off',
    description: 'Modules created with ANSI_NULLS or QUOTED_IDENTIFIER OFF. NULL comparisons and quoting behave differently, and these modules cannot use indexed views, filtered indexes or indexes on computed columns.',
    severity: 'medium',
  },
  unauditableModules: {
    id: 'unauditable-modules',
    category: 'code-risk',
    title: 'Modules without a readable definition',
    description: 'Encrypted modules, CLR modules, and modules whose definition this login may not read. Their code, dependencies and risks cannot be audited.',
    severity: 'low',
  },
  selectStar: {
    id: 'select-star',
    category: 'code-risk',
    title: 'SELECT *',
    description: 'Modules that select all columns of a table. A column added to or dropped from the table silently changes their result set and can break callers.',
    severity: 'low',
    caveat: 'From sys.dm_sql_referenced_entities (is_select_all); not seen inside dynamic SQL or when referenced entities could not be read for the module.',
  },
  staleModules: {
    id: 'stale-modules',
    category: 'dependency-health',
    title: 'Stale modules (do not compile)',
    description: 'Modules with binding errors, such as invalid columns or objects: they would fail when recompiled or executed today.',
    severity: 'high',
  },
  missingReferences: {
    id: 'missing-references',
    category: 'dependency-health',
    title: 'References to missing objects',
    description: 'Modules that reference objects that do not exist (deferred name resolution). They fail at run time when the code path that uses the missing object runs.',
    severity: 'medium',
  },
  dependencyReadFailures: {
    id: 'dependency-read-failures',
    category: 'dependency-health',
    title: 'Dependency read failures',
    description: 'Modules whose referenced entities SQL Server could not report during the last refresh. Their dependencies in this audit are incomplete.',
    severity: 'low',
  },
  unresolvedReferences: {
    id: 'unresolved-references',
    category: 'dependency-health',
    title: 'Unresolved or ambiguous references',
    description: 'References SQL Server could not bind to one object: missing objects or ambiguous names. They make dependency analysis and execution plans less reliable.',
    severity: 'low',
    caveat: 'Cross-database references, temp tables and table aliases explained by static analysis are left out. Caller-dependent references (unqualified names whose schema depends on the caller, e.g. every unqualified procedure call) are not counted on their own; they are only mentioned in the detail of rows already listed.',
  },
  tablesWithoutPrimaryKey: {
    id: 'tables-without-primary-key',
    category: 'schema-health',
    title: 'Tables without a primary key',
    description: 'Tables with no primary key. Rows cannot be identified reliably, duplicates go unnoticed, and replication, CDC and many tools need a key.',
    severity: 'medium',
  },
  untrustedOrDisabledForeignKeys: {
    id: 'untrusted-or-disabled-foreign-keys',
    category: 'schema-health',
    title: 'Untrusted or disabled foreign keys',
    description: 'Foreign keys that are disabled or not trusted (created or re-enabled WITH NOCHECK). Existing rows may violate them, and the optimizer cannot use untrusted keys.',
    severity: 'medium',
  },
  disabledIndexes: {
    id: 'disabled-indexes',
    category: 'schema-health',
    title: 'Disabled indexes',
    description: 'Indexes that are disabled: they are not maintained or used. A disabled clustered index makes the whole table unreadable.',
    severity: 'low',
  },
  disabledTriggers: {
    id: 'disabled-triggers',
    category: 'schema-health',
    title: 'Disabled triggers',
    description: 'Triggers that are disabled, so the auditing or integrity logic they implement is not running.',
    severity: 'medium',
  },
  largestTables: {
    id: 'largest-tables',
    category: 'schema-health',
    title: 'Largest tables',
    description: 'The biggest tables by row count (reserved space when the row count is unknown). Context for capacity, maintenance windows and the impact of changes.',
    severity: 'info',
    caveat: 'Row counts are approximate (partition stats) as of the last table refresh.',
    cap: LARGEST_TABLES_CAP,
  },
  failingJobs: {
    id: 'failing-jobs',
    category: 'jobs-ops',
    title: 'Failing jobs',
    description: 'Jobs whose last run failed. Whatever they maintain (loads, cleanup, backups) may be out of date.',
    severity: 'high',
  },
  disabledJobs: {
    id: 'disabled-jobs',
    category: 'jobs-ops',
    title: 'Disabled jobs',
    description: 'Jobs that are disabled. Confirm they are meant to be off; otherwise the work they do is not happening.',
    severity: 'info',
  },
  jobsWithoutSchedule: {
    id: 'jobs-without-schedule',
    category: 'jobs-ops',
    title: 'Enabled jobs without a schedule',
    description: 'Enabled jobs that will not run on their own: Agent jobs with no enabled schedule, Elastic Jobs with no upcoming run.',
    severity: 'low',
    caveat: 'Jobs started by other jobs, alerts or applications (sp_start_job) are expected to have no schedule.',
  },
  slowingJobs: {
    id: 'slowing-jobs',
    category: 'jobs-ops',
    title: 'Jobs getting slower',
    description: 'Jobs whose last 5 successful runs took on average at least 1.5x, and at least 60 s, longer than their earlier successful runs. Often a sign of data growth or a plan regression.',
    severity: 'medium',
    caveat: 'Needs at least 8 successful runs in the cached history, which is capped per job; jobs with a short history are not evaluated.',
  },
  stepsWithoutFailureHandling: {
    id: 'steps-without-failure-handling',
    category: 'jobs-ops',
    title: 'Job steps that ignore failure',
    description: 'SQL Server Agent steps whose on-failure action is "Quit reporting success" or "Go to next step": a failed step does not make the job fail, so nobody is alerted.',
    severity: 'medium',
    caveat: 'Agent jobs only. "Go to step N" (often an error-handling step) is not flagged; "Go to next step" can be intentional.',
  },
} satisfies Record<string, InsightDef>;

/** every insight id, in display order */
export const INSIGHT_IDS: readonly string[] = Object.values(D).map((d) => d.id);

/* ------------------------------------------------------------------ helpers */

type Result = { items: InsightItem[]; caveat?: string } | { unavailable: string };

function make(def: InsightDef, r: Result): Insight {
  const base = { id: def.id, category: def.category, title: def.title, description: def.description, severity: def.severity };
  if ('unavailable' in r) return { ...base, total: 0, items: [], ...(def.caveat ? { caveat: def.caveat } : {}), available: false, unavailableReason: r.unavailable };
  const caveat = [def.caveat, r.caveat].filter(Boolean).join(' ');
  return { ...base, total: r.items.length, items: r.items.slice(0, def.cap ?? INSIGHT_ITEM_CAP), ...(caveat ? { caveat } : {}), available: true };
}

const labelOf = (o: { schema: string; name: string }): string => (o.schema === DATABASE_SCOPE_SCHEMA ? o.name : `${o.schema}.${o.name}`);
const refOf = (o: { kind: ObjectKind; schema: string; name: string }): WarningObjectRef => ({ kind: o.kind, schema: o.schema, name: o.name });
const objectItem = (o: { kind: ObjectKind; schema: string; name: string }, detail?: string, value?: number): InsightItem => ({
  label: labelOf(o),
  object: refOf(o),
  ...(detail !== undefined ? { detail } : {}),
  ...(value !== undefined ? { value } : {}),
});
const byLabel = (a: InsightItem, b: InsightItem): number => a.label.localeCompare(b.label) || (a.object?.kind ?? '').localeCompare(b.object?.kind ?? '');
/** value descending, then label */
const byValueDesc = (a: InsightItem, b: InsightItem): number => (b.value ?? -Infinity) - (a.value ?? -Infinity) || byLabel(a, b);
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const fmtInt = (n: number): string => n.toLocaleString('en-US');
const truncate = (s: string, max = 300): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const listText = (xs: string[], max = 10): string => (xs.length > max ? `${xs.slice(0, max).join(', ')} +${xs.length - max} more` : xs.join(', '));
const countKinds = (kinds: string[]): string => {
  const m = new Map<string, number>();
  for (const k of kinds) m.set(k, (m.get(k) ?? 0) + 1);
  return [...m].map(([k, n]) => `${k} ×${n}`).join(', ');
};
const fmtSeconds = (s: number): string => {
  const t = Math.round(s);
  if (t < 60) return `${t}s`;
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = t % 60;
  return h ? `${h}h ${m}m` : `${m}m ${sec}s`;
};

const MODULE_KINDS: ReadonlySet<ObjectKind> = new Set(['procedure', 'function', 'view', 'trigger']);
const KIND_SEGMENT: Record<ObjectKind, string> = { procedure: 'procedures', table: 'tables', view: 'views', function: 'functions', trigger: 'triggers' };

const reasons = {
  kind: (k: string) => `${k} have not been refreshed for this connection; run a refresh that includes them.`,
  deps: 'Dependencies have not been refreshed for this connection; run a refresh that includes the dependencies segment.',
  analysis: 'Static analysis has not run for this connection; run a refresh that includes the analysis segment.',
  jobs: 'Jobs have not been refreshed for this connection (or no job source is configured); run a refresh that includes the jobs segment.',
  modules: 'No procedures, functions, views or triggers have been refreshed for this connection.',
};

/* ------------------------------------------------------------------ report */

export function buildInsightsReport(input: InsightsInput, now = new Date()): InsightsReport {
  const seg = input.refreshedSegments;
  const hasKind = (k: ObjectKind): boolean => seg.has(KIND_SEGMENT[k]) || input.objects.some((o) => o.kind === k);
  const tablesOk = hasKind('table');
  const procsOk = hasKind('procedure');
  const triggersOk = hasKind('trigger');
  const modulesOk = [...MODULE_KINDS].some(hasKind);
  const depsOk = seg.has('dependencies') || input.deps.length > 0;
  const jobsOk = seg.has('jobs') || input.jobs.length > 0;

  const byNode = new Map<string, CachedObjectRow>();
  for (const o of input.objects) byNode.set(objectNodeId(o.kind, o.schema, o.name), o);
  const tables = input.objects.filter((o) => o.kind === 'table');
  const modules = input.objects.filter((o) => MODULE_KINDS.has(o.kind));
  /** analysis signals of cached modules (job steps left out) */
  const moduleSignals = input.signals.filter((s) => byNode.has(s.targetKey) && MODULE_KINDS.has(byNode.get(s.targetKey)!.kind));
  const analysisOk = seg.has('analysis') || moduleSignals.length > 0;

  const nodeKind = (id: string): string | undefined => input.graph.nodes.get(id)?.kind;

  /** server dependency rows that only exist because the server could not bind an alias / temp table (same rule as the graph) */
  const isNoise = (d: ResolvedDependency): boolean => {
    if (d.to.resolved || d.to.kind === 'external') return false;
    if (d.row.refName.startsWith('#')) return true;
    if (d.row.refSchema !== null) return false;
    const a = input.analyses.get(objectNodeId(d.row.fromKind, d.row.fromSchema, d.row.fromName));
    return Boolean(a && a.refs.aliases.includes(d.row.refName.toLowerCase()));
  };
  const depTargetLabel = (d: ResolvedDependency): string => [d.to.server, d.to.database, d.to.schema, d.to.name].filter(Boolean).join('.');

  const insights: Insight[] = [];

  /* ---------------------------------------------------------------- usage */

  insights.push(
    make(
      D.mostReferencedTables,
      !tablesOk
        ? { unavailable: reasons.kind('Tables') }
        : !depsOk
          ? { unavailable: reasons.deps }
          : {
              items: tables
                .map((t) => ({ t, n: input.referencedByCount.get(objectNodeId('table', t.schema, t.name)) ?? 0 }))
                .filter((x) => x.n > 0)
                .sort((a, b) => b.n - a.n || a.t.name.localeCompare(b.t.name) || a.t.schema.localeCompare(b.t.schema))
                .map((x) => objectItem(x.t, plural(x.n, 'ref'), x.n)),
            },
    ),
  );

  // Same edge semantics as the Overview page's client computation, over the uncut graph: a procedure is
  // "called" when it is the target of any edge from a job step, or of a calls / references edge from a
  // procedure, trigger, function or view.
  {
    let r: Result;
    if (!procsOk) r = { unavailable: reasons.kind('Procedures') };
    else if (!depsOk && !analysisOk) r = { unavailable: `${reasons.deps} Static analysis has not run either.` };
    else {
      const callers = new Set(['procedure', 'trigger', 'function', 'view']);
      const called = new Set<string>();
      for (const e of input.graph.edges.values()) {
        const from = nodeKind(e.source);
        if (from === 'jobstep' || (from && callers.has(from) && (e.relation === 'calls' || e.relation === 'references'))) called.add(e.target);
      }
      const extra = [
        !analysisOk ? 'Static analysis has not run, so only server-recorded dependencies count.' : '',
        !depsOk ? 'Dependencies have not been refreshed, so only static-analysis edges count.' : '',
        !jobsOk ? 'Jobs have not been refreshed, so calls from job steps are not seen.' : '',
      ].filter(Boolean);
      r = {
        items: input.objects
          .filter((o) => o.kind === 'procedure' && !called.has(objectNodeId(o.kind, o.schema, o.name)))
          .sort((a, b) => a.name.localeCompare(b.name) || a.schema.localeCompare(b.schema))
          .map((o) => objectItem(o)),
        ...(extra.length ? { caveat: extra.join(' ') } : {}),
      };
    }
    insights.push(make(D.orphanProcedures, r));
  }

  {
    let r: Result;
    if (!tablesOk) r = { unavailable: reasons.kind('Tables') };
    else if (!depsOk && !analysisOk) r = { unavailable: `${reasons.deps} Static analysis has not run either.` };
    else {
      const users = new Set(['procedure', 'trigger', 'function', 'view', 'jobstep']);
      const used = new Set<string>();
      for (const e of input.graph.edges.values()) {
        if (e.relation === 'trigger-on' || e.relation === 'fk' || e.relation === 'has-step') continue;
        const from = nodeKind(e.source);
        if (from && users.has(from)) used.add(e.target);
      }
      const extra = [
        !analysisOk ? 'Static analysis has not run, so only server-recorded dependencies count.' : '',
        !depsOk ? 'Dependencies have not been refreshed, so only static-analysis edges count.' : '',
        !jobsOk ? 'Jobs have not been refreshed, so job steps are not seen.' : '',
      ].filter(Boolean);
      r = {
        items: tables
          .filter((t) => !used.has(objectNodeId('table', t.schema, t.name)))
          .map((t) => objectItem(t, t.rowCount !== null ? `${fmtInt(t.rowCount)} rows` : undefined, t.rowCount ?? undefined))
          .sort(byValueDesc),
        ...(extra.length ? { caveat: extra.join(' ') } : {}),
      };
    }
    insights.push(make(D.unreferencedTables, r));
  }

  /* ---------------------------------------------------------------- code risk */

  const fromSignals = (pick: (s: AnalysisSignals, o: CachedObjectRow) => InsightItem | null, sort: (a: InsightItem, b: InsightItem) => number): Result => {
    if (!analysisOk) return { unavailable: reasons.analysis };
    const items: InsightItem[] = [];
    for (const s of moduleSignals) {
      const it = pick(s, byNode.get(s.targetKey)!);
      if (it) items.push(it);
    }
    return { items: items.sort(sort) };
  };

  insights.push(
    make(
      D.dynamicSql,
      fromSignals((s, o) => (s.dynamicSqlKinds.length ? objectItem(o, countKinds(s.dynamicSqlKinds), s.dynamicSqlKinds.length) : null), byValueDesc),
    ),
  );

  {
    let r: Result;
    if (!analysisOk) r = { unavailable: reasons.analysis };
    else {
      const target = input.targetDatabase.toLowerCase();
      const linked = new Map(input.signals.map((s) => [s.targetKey, s.linkedServers]));
      const items: InsightItem[] = [];
      for (const [key, a] of input.analyses) {
        const o = byNode.get(key);
        if (!o || !MODULE_KINDS.has(o.kind) || !a.flags.hasCrossDb) continue;
        const targets = new Set<string>();
        for (const ref of a.refs.crossDatabaseRefs) {
          if (ref.server !== null) targets.add(`${ref.server}.${ref.database ?? ''}`);
          else if (ref.database !== null && ref.database.toLowerCase() !== target) targets.add(ref.database);
        }
        for (const srv of linked.get(key) ?? []) if (![...targets].some((t) => t.toLowerCase().startsWith(`${srv.toLowerCase()}.`))) targets.add(`${srv} (linked server)`);
        const list = [...targets].sort();
        items.push(objectItem(o, list.length ? `→ ${listText(list)}` : undefined, list.length));
      }
      r = { items: items.sort(byValueDesc) };
    }
    insights.push(make(D.crossDatabase, r));
  }

  {
    const UNBALANCED = 'unbalanced: no COMMIT or ROLLBACK';
    const isUnbalanced = (it: InsightItem): number => Number(Boolean(it.detail?.includes(UNBALANCED)));
    insights.push(
      make(
        D.transactionsWithoutTryCatch,
        fromSignals(
          (s, o) => {
            const t = s.transactions;
            if (t.begin <= 0 || s.hasTryCatch) return null;
            const unbalanced = t.commit === 0 && t.rollback === 0;
            return objectItem(o, `BEGIN TRAN ×${t.begin}, no TRY/CATCH${unbalanced ? `; ${UNBALANCED}` : `, COMMIT ×${t.commit}, ROLLBACK ×${t.rollback}`}`, t.begin);
          },
          // unbalanced first, then most BEGIN TRANs
          (a, b) => isUnbalanced(b) - isUnbalanced(a) || byValueDesc(a, b),
        ),
      ),
    );
  }

  insights.push(
    make(
      D.cursors,
      fromSignals((s, o) => (s.cursors.length ? objectItem(o, `${plural(s.cursors.length, 'cursor')}: ${listText(s.cursors)}`, s.cursors.length) : null), byValueDesc),
    ),
  );

  const moduleSettings = (o: CachedObjectRow): ModuleSettings | undefined => (o.details as { module?: ModuleSettings }).module;
  const fromModules = (pick: (o: CachedObjectRow) => InsightItem | null): Result => {
    if (!modulesOk) return { unavailable: reasons.modules };
    return { items: modules.map(pick).filter((x): x is InsightItem => x !== null).sort(byLabel) };
  };

  insights.push(
    make(
      D.executeAs,
      fromModules((o) => {
        const ea = moduleSettings(o)?.executeAs;
        return ea && ea.toUpperCase() !== 'CALLER' ? objectItem(o, `EXECUTE AS ${ea}`) : null;
      }),
    ),
  );

  insights.push(
    make(
      D.ansiSettingsOff,
      fromModules((o) => {
        const m = moduleSettings(o);
        const off = [m?.usesAnsiNulls === false ? 'ANSI_NULLS OFF' : '', m?.usesQuotedIdentifier === false ? 'QUOTED_IDENTIFIER OFF' : ''].filter(Boolean);
        return off.length ? objectItem(o, off.join(', ')) : null;
      }),
    ),
  );

  const STATUS_TEXT: Record<string, string> = { encrypted: 'encrypted (WITH ENCRYPTION)', 'no-permission': 'no permission to read the definition', clr: 'CLR module' };
  insights.push(
    make(
      D.unauditableModules,
      fromModules((o) => {
        const st = (o.details as { definitionStatus?: string }).definitionStatus;
        return st && STATUS_TEXT[st] ? objectItem(o, STATUS_TEXT[st]) : null;
      }),
    ),
  );

  {
    let r: Result;
    if (!depsOk) r = { unavailable: reasons.deps };
    else {
      const per = new Map<string, { o: { kind: ObjectKind; schema: string; name: string }; targets: Set<string> }>();
      for (const d of input.deps) {
        if (d.row.isSelectAll !== true || !MODULE_KINDS.has(d.row.fromKind)) continue;
        const k = objectNodeId(d.row.fromKind, d.row.fromSchema, d.row.fromName);
        const e = per.get(k) ?? per.set(k, { o: { kind: d.row.fromKind, schema: d.row.fromSchema, name: d.row.fromName }, targets: new Set() }).get(k)!;
        e.targets.add(depTargetLabel(d));
      }
      r = { items: [...per.values()].map(({ o, targets }) => objectItem(o, listText([...targets].sort()), targets.size)).sort(byValueDesc) };
    }
    insights.push(make(D.selectStar, r));
  }

  /* ---------------------------------------------------------------- dependency health */

  const issues = input.dependencyIssues ?? (depsOk ? {} : null);
  /** unresolved local targets per module (for missing-references details) */
  const unresolvedByModule = new Map<string, string[]>();
  for (const d of input.deps) {
    if (d.to.resolution !== 'unresolved' || d.to.kind === 'external' || isNoise(d)) continue;
    const k = objectNodeId(d.row.fromKind, d.row.fromSchema, d.row.fromName);
    (unresolvedByModule.get(k) ?? unresolvedByModule.set(k, []).get(k)!).push(depTargetLabel(d));
  }
  const fromIssues = (type: DependencyIssueMeta['type'], detail: (i: DependencyIssueMeta) => string): Result => {
    if (!issues) return { unavailable: reasons.deps };
    return {
      items: Object.values(issues)
        .filter((i) => i.type === type)
        .map((i) => objectItem(i, truncate(detail(i))))
        .sort(byLabel),
    };
  };
  insights.push(make(D.staleModules, fromIssues('stale', (i) => i.message)));
  insights.push(
    make(
      D.missingReferences,
      fromIssues('missing-references', (i) => {
        const missing = [...new Set(unresolvedByModule.get(objectNodeId(i.kind, i.schema, i.name)) ?? [])].sort();
        return missing.length ? `missing: ${listText(missing)}` : i.message;
      }),
    ),
  );
  insights.push(make(D.dependencyReadFailures, fromIssues('failed', (i) => i.message)));

  {
    let r: Result;
    if (!depsOk) r = { unavailable: reasons.deps };
    else {
      const per = new Map<string, { o: { kind: ObjectKind; schema: string; name: string }; unresolved: Set<string>; ambiguous: Set<string>; caller: Set<string>; rows: number }>();
      for (const d of input.deps) {
        if (d.to.kind === 'external' || isNoise(d)) continue;
        const unresolved = d.to.resolution === 'unresolved';
        if (!unresolved && !d.row.isAmbiguous) continue; // caller-dependent alone is not counted (true for every unqualified proc call)
        const k = objectNodeId(d.row.fromKind, d.row.fromSchema, d.row.fromName);
        const e =
          per.get(k) ??
          per.set(k, { o: { kind: d.row.fromKind, schema: d.row.fromSchema, name: d.row.fromName }, unresolved: new Set(), ambiguous: new Set(), caller: new Set(), rows: 0 }).get(k)!;
        const label = depTargetLabel(d);
        e.rows++;
        if (unresolved) e.unresolved.add(label);
        if (d.row.isAmbiguous) e.ambiguous.add(label);
        if (d.row.isCallerDependent) e.caller.add(label);
      }
      r = {
        items: [...per.values()]
          .map((e) => {
            const parts = [
              e.unresolved.size ? `unresolved: ${listText([...e.unresolved].sort(), 5)}` : '',
              e.ambiguous.size ? `ambiguous: ${listText([...e.ambiguous].sort(), 5)}` : '',
              e.caller.size ? `caller-dependent: ${listText([...e.caller].sort(), 5)}` : '',
            ].filter(Boolean);
            return objectItem(e.o, parts.join('; '), e.rows);
          })
          .sort(byValueDesc),
      };
    }
    insights.push(make(D.unresolvedReferences, r));
  }

  /* ---------------------------------------------------------------- schema health */

  const td = (t: CachedObjectRow): Partial<TableDetails> => t.details as Partial<TableDetails>;
  const fromTables = (pick: (t: CachedObjectRow) => InsightItem[], sort: (a: InsightItem, b: InsightItem) => number): Result => {
    if (!tablesOk) return { unavailable: reasons.kind('Tables') };
    return { items: tables.flatMap(pick).sort(sort) };
  };

  insights.push(
    make(
      D.tablesWithoutPrimaryKey,
      fromTables((t) => {
        if (td(t).primaryKey !== null || td(t).kind !== 'table') return [];
        const heap = !(td(t).indexes ?? []).some((i) => i.type.toUpperCase().includes('CLUSTERED') && !i.type.toUpperCase().includes('NONCLUSTERED'));
        const facts = [t.rowCount !== null ? `${fmtInt(t.rowCount)} rows` : '', heap ? 'heap (no clustered index)' : ''].filter(Boolean);
        return [objectItem(t, facts.length ? facts.join(', ') : undefined, t.rowCount ?? undefined)];
      }, byValueDesc),
    ),
  );

  insights.push(
    make(
      D.untrustedOrDisabledForeignKeys,
      fromTables(
        (t) =>
          (td(t).foreignKeys ?? [])
            .filter((fk) => fk.isDisabled || fk.isNotTrusted)
            .map((fk) =>
              objectItem(t, `${fk.name} → ${fk.references.schema}.${fk.references.name}: ${[fk.isDisabled ? 'disabled' : '', fk.isNotTrusted ? 'not trusted' : ''].filter(Boolean).join(', ')}`),
            ),
        (a, b) => byLabel(a, b) || (a.detail ?? '').localeCompare(b.detail ?? ''),
      ),
    ),
  );

  {
    let r: Result;
    const viewsOk = hasKind('view');
    if (!tablesOk && !viewsOk) r = { unavailable: reasons.kind('Tables and views') };
    else {
      const items: InsightItem[] = [];
      for (const o of input.objects) {
        if (o.kind !== 'table' && o.kind !== 'view') continue;
        for (const ix of ((o.details as { indexes?: TableDetails['indexes'] }).indexes ?? [])) {
          if (ix.isDisabled) items.push(objectItem(o, `${ix.name} (${ix.type.toLowerCase()}${ix.isPrimaryKey ? ', primary key' : ''})`));
        }
      }
      r = { items: items.sort((a, b) => byLabel(a, b) || (a.detail ?? '').localeCompare(b.detail ?? '')) };
    }
    insights.push(make(D.disabledIndexes, r));
  }

  insights.push(
    make(
      D.disabledTriggers,
      !triggersOk
        ? { unavailable: reasons.kind('Triggers') }
        : {
            items: input.objects
              .filter((o) => o.kind === 'trigger' && (o.details as Partial<TriggerDetails>).isDisabled === true)
              .map((o) => {
                const d = o.details as Partial<TriggerDetails>;
                const on = d.parent ? `on ${d.parent.schema}.${d.parent.name}` : 'database DDL trigger';
                return objectItem(o, d.events?.length ? `${on} (${d.events.join(', ')})` : on);
              })
              .sort(byLabel),
          },
    ),
  );

  insights.push(
    make(
      D.largestTables,
      !tablesOk
        ? { unavailable: reasons.kind('Tables') }
        : {
            items: tables
              .map((t) => ({ t, rows: t.rowCount, kb: td(t).reservedKb ?? null }))
              .filter((x) => (x.rows ?? 0) > 0 || (x.kb ?? 0) > 0)
              // rows desc (unknown row counts last), then reserved KB desc
              .sort((a, b) => (b.rows ?? -1) - (a.rows ?? -1) || (b.kb ?? -1) - (a.kb ?? -1) || labelOf(a.t).localeCompare(labelOf(b.t)))
              .map((x) =>
                objectItem(x.t, [x.rows !== null ? `${fmtInt(x.rows)} rows` : '', x.kb !== null ? `${fmtInt(x.kb)} KB reserved` : ''].filter(Boolean).join(', '), x.rows ?? undefined),
              ),
          },
    ),
  );

  /* ---------------------------------------------------------------- jobs + operations */

  const summaries = new Map(input.jobSummaries.map((j) => [j.jobId, j]));
  const jobItem = (j: CachedJobRow, detail?: string, value?: number): InsightItem => ({
    label: j.name,
    job: { jobId: j.jobId, name: j.name },
    ...(detail !== undefined ? { detail } : {}),
    ...(value !== undefined ? { value } : {}),
  });
  const fromJobs = (pick: (j: CachedJobRow, s: JobSummary | undefined) => InsightItem | null, sort: (a: InsightItem, b: InsightItem) => number = byLabel): Result => {
    if (!jobsOk) return { unavailable: reasons.jobs };
    return { items: input.jobs.map((j) => pick(j, summaries.get(j.jobId))).filter((x): x is InsightItem => x !== null).sort(sort) };
  };

  insights.push(
    make(
      D.failingJobs,
      fromJobs((j, s) => {
        const outcome = s?.lastRunOutcome ?? '';
        if (!outcome.toLowerCase().includes('fail')) return null;
        const iso = s?.lastExecution?.startTime ?? s?.lastExecution?.createTime ?? null;
        const at = iso ? (formatUtc(iso) ?? iso) : null;
        return jobItem(j, `${j.source === 'agent' ? 'Agent' : 'Elastic'}: last run ${outcome}${at ? ` at ${at}` : ''}`);
      }),
    ),
  );

  insights.push(make(D.disabledJobs, fromJobs((j) => (j.details.enabled ? null : jobItem(j, `${j.source === 'agent' ? 'Agent' : 'Elastic'} job, ${plural(j.details.steps.length, 'step')}`)))));

  insights.push(
    make(
      D.jobsWithoutSchedule,
      fromJobs((j, s) => {
        if (!j.details.enabled) return null;
        if (j.source === 'agent') {
          if (j.details.schedules.some((x) => x.enabled)) return null;
          return jobItem(j, j.details.schedules.length ? `Agent: ${plural(j.details.schedules.length, 'schedule')}, none enabled` : 'Agent: no schedule');
        }
        if (s?.nextRun) return null;
        return jobItem(j, `Elastic: no upcoming run (${j.details.scheduleText || 'no schedule'})`);
      }),
    ),
  );

  {
    let r: Result;
    if (!jobsOk) r = { unavailable: reasons.jobs };
    else {
      const byJob = new Map<string, ExtractedExecution[]>();
      for (const e of input.executions) {
        const k = e.jobId ?? e.jobName;
        (byJob.get(k) ?? byJob.set(k, []).get(k)!).push(e);
      }
      const items: InsightItem[] = [];
      for (const j of input.jobs) {
        const runs = (byJob.get(j.jobId) ?? byJob.get(j.name) ?? [])
          .filter((e) => e.stepId === null && (e.runStatus ?? e.lifecycle) === 'Succeeded' && e.durationSeconds !== null && (e.startTime ?? e.createTime))
          .sort((a, b) => (a.startTime ?? a.createTime ?? '').localeCompare(b.startTime ?? b.createTime ?? ''));
        if (runs.length < 8) continue;
        const avg = (xs: ExtractedExecution[]): number => xs.reduce((n, e) => n + (e.durationSeconds ?? 0), 0) / xs.length;
        const recent = avg(runs.slice(-5));
        const earlier = avg(runs.slice(0, -5));
        if (recent >= 1.5 * earlier && recent - earlier >= 60) {
          items.push(jobItem(j, `last 5 runs avg ${fmtSeconds(recent)} vs ${fmtSeconds(earlier)} over the ${runs.length - 5} earlier successful runs`, Math.round(recent - earlier)));
        }
      }
      r = { items: items.sort(byValueDesc) };
    }
    insights.push(make(D.slowingJobs, r));
  }

  {
    let r: Result;
    const agentJobs = input.jobs.filter((j) => j.source === 'agent');
    if (!jobsOk) r = { unavailable: reasons.jobs };
    else if (!agentJobs.length) r = { unavailable: 'No SQL Server Agent jobs in the cache. On-failure actions exist only for Agent job steps (Elastic Jobs fail the job execution when a step fails).' };
    else {
      const SILENT = new Set(['quit reporting success', 'go to next step']);
      const items: InsightItem[] = [];
      for (const j of agentJobs) {
        for (const st of j.details.steps) {
          if (!st.onFail || !SILENT.has(st.onFail.toLowerCase())) continue;
          items.push({
            label: `${j.name} #${st.stepId} ${st.name}`,
            job: { jobId: j.jobId, name: j.name },
            detail: `on failure: ${st.onFail}${j.details.enabled ? '' : ' (job disabled)'}`,
            value: st.stepId,
          });
        }
      }
      r = { items: items.sort((a, b) => a.job!.name.localeCompare(b.job!.name) || (a.value ?? 0) - (b.value ?? 0)) };
    }
    insights.push(make(D.stepsWithoutFailureHandling, r));
  }

  const content = { categories: INSIGHT_CATEGORIES, insights };
  return { generatedAt: now.toISOString(), ...content, sha256: sha256(JSON.stringify(content)) };
}
