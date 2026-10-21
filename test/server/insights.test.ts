/**
 * Audit insights (GET /api/connections/:id/insights). A pure test of buildInsightsReport over a hand-built
 * input (no Docker), and an end-to-end test against the Docker seed (AuditDemo + jobs) after a full refresh.
 * The Docker test adds throwaway objects dbo.zz_in_* as `sa` in before() and drops them in after().
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { ConnectionProfile, Graph, Insight, InsightsReport, JobSummary, ObjectKind, ObjectSummary, RefreshRun } from '../../shared/types';
import { buildInsightsReport, INSIGHT_ITEM_CAP, INSIGHT_IDS, type InsightsInput } from '../../server/analysis/insights';
import type { FullGraph } from '../../server/api/graph';
import { objectNodeId, type ResolvedDependency } from '../../server/api/readModel';
import type { ExtractedExecution, ExtractedJob, ExtractedJobStep } from '../../server/extract/jobTypes';
import type { CachedDependencyRow, CachedJobRow, CachedObjectRow, StoredAnalysisRefs } from '../../server/store/cacheStore';
import { api, connectionInput, dockerUnavailableReason, pollRun, saExec, startServer, tempContext } from './helpers';

const reason = await dockerUnavailableReason();

const EXPECTED_IDS = [
  'most-referenced-tables',
  'orphan-procedures',
  'unreferenced-tables',
  'dynamic-sql',
  'cross-database',
  'transactions-without-try-catch',
  'cursors',
  'execute-as',
  'ansi-settings-off',
  'unauditable-modules',
  'select-star',
  'stale-modules',
  'missing-references',
  'dependency-read-failures',
  'unresolved-references',
  'tables-without-primary-key',
  'untrusted-or-disabled-foreign-keys',
  'disabled-indexes',
  'disabled-triggers',
  'largest-tables',
  'failing-jobs',
  'disabled-jobs',
  'jobs-without-schedule',
  'slowing-jobs',
  'steps-without-failure-handling',
];

const get = (r: InsightsReport, id: string): Insight => {
  const i = r.insights.find((x) => x.id === id);
  assert.ok(i, `insight ${id} missing`);
  return i;
};
const labels = (i: Insight): string[] => i.items.map((x) => x.label);

function assertShape(r: InsightsReport): void {
  assert.match(r.generatedAt, /^\d{4}-\d\d-\d\dT/);
  assert.match(r.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(r.categories.map((c) => c.id), ['usage', 'code-risk', 'dependency-health', 'schema-health', 'jobs-ops']);
  assert.deepEqual(r.insights.map((i) => i.id), EXPECTED_IDS);
  // grouped by category, in category order
  const order = r.categories.map((c) => c.id);
  const idx = r.insights.map((i) => order.indexOf(i.category));
  assert.deepEqual(idx, [...idx].sort((a, b) => a - b));
  for (const i of r.insights) {
    assert.match(i.id, /^[a-z]+(-[a-z]+)*$/);
    assert.ok(i.title && i.description, i.id);
    assert.ok(['info', 'low', 'medium', 'high'].includes(i.severity), i.id);
    assert.ok(i.items.length <= INSIGHT_ITEM_CAP && i.items.length <= i.total, i.id);
    if (!i.available) {
      assert.ok(i.unavailableReason, i.id);
      assert.equal(i.items.length, 0, i.id);
    }
    for (const it of i.items) assert.ok(it.label && (it.object || it.job || it.detail), `${i.id}: ${JSON.stringify(it)}`);
  }
}

/* ------------------------------------------------------------------ pure builder */

function obj(kind: ObjectKind, name: string, details: Record<string, unknown> = {}, rowCount: number | null = null): CachedObjectRow {
  return {
    kind,
    schema: 'dbo',
    name,
    serverObjectId: 1,
    typeCode: null,
    createDate: '',
    modifyDate: '',
    definition: null,
    hasDefinition: kind !== 'table',
    isEncrypted: false,
    definitionSha256: null,
    details: { kind, ...details },
    rowCount,
    fetchedAt: '',
  };
}
const mod = (ansiNulls = true, executeAs: string | null = null) => ({ usesAnsiNulls: ansiNulls, usesQuotedIdentifier: true, isSchemaBound: false, executeAs });
const table = (name: string, d: Record<string, unknown> = {}, rows: number | null = 10) =>
  obj('table', name, { primaryKey: { name: `PK_${name}`, columns: ['Id'] }, foreignKeys: [], indexes: [], reservedKb: 16, ...d }, rows);

function dep(from: string, to: string, extra: Partial<CachedDependencyRow> = {}, resolved = true): ResolvedDependency {
  return {
    row: {
      fromKind: 'procedure',
      fromSchema: 'dbo',
      fromName: from,
      refServer: null,
      refDatabase: null,
      refSchema: 'dbo',
      refName: to,
      refKind: resolved ? 'table' : 'unknown',
      refTypeCode: null,
      refResolved: resolved,
      isAmbiguous: false,
      isCallerDependent: false,
      isSelected: true,
      isUpdated: false,
      isSelectAll: null,
      isIncomplete: null,
      columns: [],
      source: ['referenced-entities'],
      ...extra,
    },
    to: { server: null, database: null, schema: 'dbo', name: to, kind: resolved ? 'table' : 'unknown', resolved, resolution: resolved ? 'server' : 'unresolved' },
    toKey: resolved ? `table:dbo.${to}`.toLowerCase() : null,
  };
}

function step(stepId: number, onFail: string | null): ExtractedJobStep {
  return {
    stepId, name: `s${stepId}`, commandType: 'TSQL', commandSource: 'Inline', command: 'SELECT 1', credentialName: null, targetGroupId: null, targetGroupName: null,
    targetMembers: [], retryAttempts: 0, stepTimeoutSeconds: null, maxParallelism: null, subsystem: 'TSQL', databaseName: 'X', onSuccess: 'Quit reporting success',
    onFail, retryIntervalMinutes: 0, outputFileName: null, analyzable: true, initialRetryIntervalSeconds: null, maximumRetryIntervalSeconds: null,
    retryIntervalBackoffMultiplier: null, output: null,
  };
}
function job(jobId: string, name: string, steps: ExtractedJobStep[], schedules: ExtractedJob['schedules'], enabled = true): CachedJobRow {
  const details: ExtractedJob = {
    source: 'agent', jobId, name, description: null, enabled, version: 1, category: null, owner: null, dateCreated: null, dateModified: null,
    lastRunOutcome: 'Succeeded', lastRunAt: null, nextRun: null, schedule: { intervalType: null, intervalCount: null, startTime: null, endTime: null },
    scheduleText: '', schedules, steps,
  };
  return { jobId, source: 'agent', name, enabled, version: 1, details, fetchedAt: '' };
}
function runs(jobId: string, durations: number[]): ExtractedExecution[] {
  return durations.map((d, i) => ({
    source: 'agent', jobExecutionId: `${jobId}-${i}`, jobName: jobId, stepId: null, stepName: null, lifecycle: 'Succeeded', isActive: false,
    createTime: null, startTime: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(), endTime: null, lastMessage: null, targetServerName: null,
    targetDatabaseName: null, currentAttempts: null, runStatus: 'Succeeded', durationSeconds: d, jobId, jobVersion: null, targetType: null, targetGroupName: null,
  }));
}

function syntheticInput(): InsightsInput {
  const objects: CachedObjectRow[] = [
    table('Used'),
    table('Heap', { primaryKey: null, indexes: [{ name: 'IX_Heap', type: 'NONCLUSTERED', isPrimaryKey: false, isDisabled: true }] }, 5000),
    table('Child', {
      foreignKeys: [
        { name: 'FK_ok', references: { schema: 'dbo', name: 'Used' }, isDisabled: false, isNotTrusted: false },
        { name: 'FK_bad', references: { schema: 'dbo', name: 'Used' }, isDisabled: true, isNotTrusted: true },
      ],
    }),
    obj('procedure', 'p_tx', { module: mod(), definitionStatus: 'ok' }),
    obj('procedure', 'p_ansi', { module: mod(false, 'OWNER'), definitionStatus: 'ok' }),
    obj('procedure', 'p_clr', { module: mod(), definitionStatus: 'clr' }),
    obj('trigger', 'trg_off', { module: mod(), definitionStatus: 'ok', isDisabled: true, parent: { kind: 'table', schema: 'dbo', name: 'Used' }, events: ['INSERT'] }),
  ];
  for (let i = 0; i < INSIGHT_ITEM_CAP + 20; i++) objects.push(obj('procedure', `p_many_${String(i).padStart(4, '0')}`, { module: mod(), definitionStatus: 'ok' }));
  const graph: FullGraph = { nodes: new Map(), edges: new Map() };
  for (const o of objects) {
    const id = objectNodeId(o.kind, o.schema, o.name);
    graph.nodes.set(id, { id, kind: o.kind, label: `dbo.${o.name}`, name: o.name });
  }
  // p_tx reads Used and calls p_ansi; the trigger-on edge does not make Used "used"
  graph.edges.set('a', { id: 'a', source: 'procedure:dbo.p_tx', target: 'table:dbo.Used', relation: 'reads', origin: ['server'] });
  graph.edges.set('b', { id: 'b', source: 'procedure:dbo.p_tx', target: 'procedure:dbo.p_ansi', relation: 'calls', origin: ['static'] });
  graph.edges.set('c', { id: 'c', source: 'trigger:dbo.trg_off', target: 'table:dbo.Heap', relation: 'trigger-on', origin: ['server'] });
  const deps = [
    dep('p_tx', 'Used', { isSelectAll: true }),
    dep('p_tx', 'Missing', {}, false),
    dep('p_tx', '#tmp', { refSchema: null }, false), // temp table noise: ignored
  ];
  const jobs = [
    job('J1', 'Slow job', [step(1, 'Quit reporting failure'), step(2, 'Go to next step'), step(3, 'Quit reporting success')], [{ name: 'n', enabled: true, text: '', nextRun: null }]),
    job('J2', 'Unscheduled', [step(1, 'Go to step 3')], [{ name: 'n', enabled: false, text: '', nextRun: null }]),
    job('J3', 'Steady', [step(1, 'Quit reporting failure')], [{ name: 'n', enabled: true, text: '', nextRun: null }]),
  ];
  return {
    objects,
    referencedByCount: new Map([['table:dbo.Used', 3]]),
    deps,
    graph,
    analyses: new Map(),
    signals: [
      { targetKey: 'procedure:dbo.p_tx', transactions: { begin: 2, commit: 0, rollback: 0, save: 0 }, hasTryCatch: false, cursors: [], dynamicSqlKinds: [], linkedServers: [] },
      { targetKey: 'procedure:dbo.p_ansi', transactions: { begin: 1, commit: 1, rollback: 0, save: 0 }, hasTryCatch: false, cursors: [], dynamicSqlKinds: [], linkedServers: [] },
      { targetKey: 'jobstep:J1#1', transactions: { begin: 1, commit: 0, rollback: 0, save: 0 }, hasTryCatch: false, cursors: [], dynamicSqlKinds: ['EXEC_STRING'], linkedServers: [] },
    ],
    dependencyIssues: { a: { kind: 'procedure', schema: 'dbo', name: 'p_tx', type: 'missing-references', message: 'references objects that do not exist (Msg 2020)' } },
    jobs,
    jobSummaries: [],
    // J1: 6 earlier runs at 100 s, last 5 at 200 s (>= 1.5x and >= 60 s more); J3: 10 runs, last 5 only 50 s slower
    executions: [...runs('J1', [100, 100, 100, 100, 100, 100, 200, 200, 200, 200, 200]), ...runs('J3', [100, 100, 100, 100, 100, 150, 150, 150, 150, 150])],
    refreshedSegments: new Set(['tables', 'procedures', 'triggers', 'dependencies', 'jobs', 'analysis']),
    targetDatabase: 'X',
  };
}

describe('insights: pure report builder (no Docker)', () => {
  it('computes every insight from a synthetic cache', () => {
    const r = buildInsightsReport(syntheticInput(), new Date('2026-10-20T00:00:00Z'));
    assertShape(r);
    assert.deepEqual(INSIGHT_IDS, EXPECTED_IDS);
    assert.deepEqual(labels(get(r, 'most-referenced-tables')), ['dbo.Used']);
    assert.deepEqual(labels(get(r, 'unreferenced-tables')), ['dbo.Heap', 'dbo.Child']); // by row count desc; trigger-on is not use
    const orphans = get(r, 'orphan-procedures');
    assert.equal(orphans.total, INSIGHT_ITEM_CAP + 20 + 2); // all but p_ansi (called by p_tx)
    assert.equal(orphans.items.length, INSIGHT_ITEM_CAP);
    assert.ok(!labels(orphans).includes('dbo.p_ansi'));
    const tx = get(r, 'transactions-without-try-catch');
    assert.deepEqual(labels(tx), ['dbo.p_tx', 'dbo.p_ansi']); // unbalanced first; job step signals ignored
    assert.match(tx.items[0].detail!, /BEGIN TRAN ×2, no TRY\/CATCH; unbalanced/);
    assert.doesNotMatch(tx.items[1].detail!, /unbalanced/);
    assert.equal(get(r, 'dynamic-sql').total, 0); // the only dynamic SQL is in a job step
    assert.deepEqual(get(r, 'execute-as').items, [{ label: 'dbo.p_ansi', object: { kind: 'procedure', schema: 'dbo', name: 'p_ansi' }, detail: 'EXECUTE AS OWNER' }]);
    assert.equal(get(r, 'ansi-settings-off').items[0].detail, 'ANSI_NULLS OFF');
    assert.deepEqual(labels(get(r, 'unauditable-modules')), ['dbo.p_clr']);
    assert.deepEqual(get(r, 'select-star').items.map((i) => [i.label, i.detail]), [['dbo.p_tx', 'dbo.Used']]);
    assert.deepEqual(get(r, 'missing-references').items.map((i) => [i.label, i.detail]), [['dbo.p_tx', 'missing: dbo.Missing']]);
    assert.equal(get(r, 'stale-modules').total, 0);
    assert.deepEqual(get(r, 'unresolved-references').items.map((i) => [i.label, i.detail, i.value]), [['dbo.p_tx', 'unresolved: dbo.Missing', 1]]);
    assert.deepEqual(labels(get(r, 'tables-without-primary-key')), ['dbo.Heap']);
    assert.match(get(r, 'tables-without-primary-key').items[0].detail!, /5,000 rows, heap/);
    assert.deepEqual(get(r, 'untrusted-or-disabled-foreign-keys').items.map((i) => i.detail), ['FK_bad → dbo.Used: disabled, not trusted']);
    assert.deepEqual(get(r, 'disabled-indexes').items.map((i) => [i.label, i.detail]), [['dbo.Heap', 'IX_Heap (nonclustered)']]);
    assert.deepEqual(get(r, 'disabled-triggers').items.map((i) => i.detail), ['on dbo.Used (INSERT)']);
    assert.deepEqual(labels(get(r, 'largest-tables')), ['dbo.Heap', 'dbo.Child', 'dbo.Used']);
    assert.deepEqual(labels(get(r, 'jobs-without-schedule')), ['Unscheduled']);
    const slow = get(r, 'slowing-jobs');
    assert.deepEqual(slow.items.map((i) => [i.label, i.value]), [['Slow job', 100]]);
    assert.deepEqual(get(r, 'steps-without-failure-handling').items.map((i) => [i.label, i.detail]), [
      ['Slow job #2 s2', 'on failure: Go to next step'],
      ['Slow job #3 s3', 'on failure: Quit reporting success'],
    ]);
    // sha256 covers everything but generatedAt
    const again = buildInsightsReport(syntheticInput(), new Date('2027-01-01T00:00:00Z'));
    assert.equal(again.sha256, r.sha256);
  });

  it('unresolved-references: counts unresolved or ambiguous rows; caller-dependent alone is not counted', () => {
    const input = syntheticInput();
    input.deps = [
      dep('p_tx', 'Missing', { isCallerDependent: true }, false), // unresolved + caller-dependent: counted, both mentioned
      dep('p_ansi', 'Used', { isCallerDependent: true }), // caller-dependent only (every unqualified proc call): not counted
      dep('p_clr', 'Used', { isAmbiguous: true, isCallerDependent: true }), // ambiguous: counted
      dep('p_clr', 'Other', { isCallerDependent: true }), // caller-dependent only in a listed module: not counted, not mentioned
    ];
    const u = get(buildInsightsReport(input), 'unresolved-references');
    assert.equal(u.total, 2);
    assert.deepEqual(u.items.map((i) => [i.label, i.detail, i.value]), [
      ['dbo.p_clr', 'ambiguous: dbo.Used; caller-dependent: dbo.Used', 1],
      ['dbo.p_tx', 'unresolved: dbo.Missing; caller-dependent: dbo.Missing', 1],
    ]);
  });

  it('unresolved / missing references: one-part names that are table aliases of the same module are left out', () => {
    const input = syntheticInput();
    // usp_ArchiveOrders on AuditDemo: `DELETE t FROM dbo.OrderLog AS t` -> the server reports `t` as a one-part unresolved reference
    const onePart = (from: string, name: string): ResolvedDependency => {
      const d = dep(from, name, { refSchema: null }, false);
      return { ...d, to: { ...d.to, schema: null } };
    };
    input.deps = [
      onePart('p_tx', 't'), // alias of p_tx: left out
      onePart('p_tx', 'x'), // one-part, not an alias: kept
      dep('p_tx', 't', {}, false), // dbo.t has a schema: kept even though `t` is an alias
      dep('p_tx', 'Missing', {}, false), // real missing object: kept
      onePart('p_ansi', 't'), // `t` is an alias of p_tx only: kept for p_ansi
    ];
    const refs = { tables: [], procCalls: [], functionCalls: [], sequences: [], crossDatabaseRefs: [], aliases: ['t'] };
    input.analyses = new Map([['procedure:dbo.p_tx', { targetKey: 'procedure:dbo.p_tx', flags: {} as StoredAnalysisRefs['flags'], refs }]]);
    const r = buildInsightsReport(input);
    assert.equal(get(r, 'unresolved-references').title, 'Unresolved or ambiguous references');
    assert.deepEqual(get(r, 'unresolved-references').items.map((i) => [i.label, i.detail, i.value]), [
      ['dbo.p_tx', 'unresolved: dbo.Missing, dbo.t, x', 3],
      ['dbo.p_ansi', 'unresolved: t', 1],
    ]);
    assert.deepEqual(get(r, 'missing-references').items.map((i) => [i.label, i.detail]), [['dbo.p_tx', 'missing: dbo.Missing, dbo.t, x']]);
  });

  it('failing-jobs: last run time as `YYYY-MM-DD HH:MM UTC`', () => {
    const input = syntheticInput();
    const summary = (jobId: string, name: string, outcome: string, exec: { startTime: string | null; createTime: string | null } | null): JobSummary => ({
      jobId, source: 'agent', category: null, owner: null, lastRunOutcome: outcome, nextRun: null, name, description: null, enabled: true, version: 1,
      scheduleText: '', stepCount: 1, targetsThisDb: true,
      lastExecution: exec && {
        jobExecutionId: 'e', jobName: name, stepId: null, stepName: null, lifecycle: outcome, isActive: false, ...exec, endTime: null, lastMessage: null,
        targetServerName: null, targetDatabaseName: null, currentAttempts: null, runStatus: outcome, durationSeconds: null,
      },
    });
    input.jobSummaries = [
      summary('J1', 'Slow job', 'Failed', { startTime: '2026-10-16T00:00:00.000Z', createTime: null }),
      summary('J2', 'Unscheduled', 'Failed', { startTime: null, createTime: '2026-10-13T02:00:01.000Z' }),
      summary('J3', 'Steady', 'Succeeded', { startTime: '2026-10-16T00:00:00.000Z', createTime: null }),
    ];
    assert.deepEqual(get(buildInsightsReport(input), 'failing-jobs').items.map((i) => [i.label, i.detail]), [
      ['Slow job', 'Agent: last run Failed at 2026-10-16 00:00 UTC'],
      ['Unscheduled', 'Agent: last run Failed at 2026-10-13 02:00 UTC'],
    ]);
  });

  it('marks insights unavailable when their data is not in the cache', () => {
    const empty: InsightsInput = {
      objects: [], referencedByCount: new Map(), deps: [], graph: { nodes: new Map(), edges: new Map() }, analyses: new Map(), signals: [],
      dependencyIssues: null, jobs: [], jobSummaries: [], executions: [], refreshedSegments: new Set(), targetDatabase: 'X',
    };
    const r = buildInsightsReport(empty);
    assertShape(r);
    for (const i of r.insights) assert.equal(i.available, false, i.id);
    assert.match(get(r, 'dynamic-sql').unavailableReason!, /analysis/);
    assert.match(get(r, 'failing-jobs').unavailableReason!, /jobs/i);
    // jobs refreshed but only Elastic jobs (here: none at all) -> on-fail actions are not applicable
    const r2 = buildInsightsReport({ ...empty, refreshedSegments: new Set(['jobs']) });
    assert.equal(get(r2, 'failing-jobs').available, true);
    assert.equal(get(r2, 'steps-without-failure-handling').available, false);
  });
});

/* ------------------------------------------------------------------ Docker end to end */

const DROP_ALL = `
IF OBJECT_ID(N'dbo.zz_in_star') IS NOT NULL DROP PROCEDURE dbo.zz_in_star;
IF OBJECT_ID(N'dbo.zz_in_tx') IS NOT NULL DROP PROCEDURE dbo.zz_in_tx;
IF OBJECT_ID(N'dbo.zz_in_heap') IS NOT NULL DROP TABLE dbo.zz_in_heap;`;

describe('insights: AuditDemo over HTTP after a full refresh', { skip: reason ?? false }, () => {
  const ctx = tempContext();
  let srv: Awaited<ReturnType<typeof startServer>>;
  let id = '';
  let report: InsightsReport;

  before(async () => {
    await saExec('AuditDemo', [
      DROP_ALL,
      `CREATE PROCEDURE dbo.zz_in_star AS SELECT * FROM dbo.Settings;`,
      `CREATE PROCEDURE dbo.zz_in_tx AS BEGIN TRANSACTION; UPDATE dbo.Settings SET SettingValue = SettingValue WHERE 1 = 0;`,
      `CREATE TABLE dbo.zz_in_heap (Id int NOT NULL, BranchId int NOT NULL);`,
      `CREATE INDEX IX_zz_in_heap ON dbo.zz_in_heap (Id); ALTER INDEX IX_zz_in_heap ON dbo.zz_in_heap DISABLE;`,
      `ALTER TABLE dbo.zz_in_heap WITH NOCHECK ADD CONSTRAINT FK_zz_in_heap_Branch FOREIGN KEY (BranchId) REFERENCES dbo.Branch (BranchId);`,
    ]);
    srv = await startServer(ctx);
    id = (await api<ConnectionProfile>(srv.base, 'POST', '/api/connections', connectionInput('AuditDemo', 'full'))).body.id;
    const r = await api<{ runId: string }>(srv.base, 'POST', `/api/connections/${id}/refresh`, { segments: 'all', mode: 'full' });
    const run: RefreshRun = await pollRun(srv.base, id, r.body.runId);
    assert.equal(run.status, 'succeeded', JSON.stringify(run));
    const res = await api<InsightsReport>(srv.base, 'GET', `/api/connections/${id}/insights`);
    assert.equal(res.status, 200, res.text);
    report = res.body;
  });
  after(async () => {
    await saExec('AuditDemo', [DROP_ALL]);
    await srv.close();
    await ctx.cleanup();
  });

  it('404 for an unknown connection', async () => {
    const r = await api<{ error: string }>(srv.base, 'GET', '/api/connections/zzzzzzzz/insights');
    assert.equal(r.status, 404);
    assert.match(r.body.error, /not found/);
  });

  it('report shape: every insight id, in category order, all available after a full refresh', () => {
    assertShape(report);
    for (const i of report.insights) assert.equal(i.available, true, `${i.id}: ${i.unavailableReason}`);
  });

  it('seed facts: stale, missing references, dynamic SQL, failing jobs', () => {
    assert.ok(labels(get(report, 'stale-modules')).includes('dbo.usp_Stale'));
    assert.ok(labels(get(report, 'missing-references')).includes('dbo.Synthetic_HardCases'));
    const dyn = get(report, 'dynamic-sql');
    const report_ = dyn.items.find((i) => i.label === 'dbo.usp_DynamicReport');
    assert.ok(report_, JSON.stringify(dyn.items));
    assert.match(report_.detail!, /EXEC_STRING/);
    assert.match(report_.detail!, /SP_EXECUTESQL/);
    assert.ok(labels(get(report, 'unauditable-modules')).includes('dbo.usp_Secret'));
    assert.ok(labels(get(report, 'failing-jobs')).includes('AuditDemo - Points Check'));
    assert.ok(get(report, 'failing-jobs').items.every((i) => i.job?.jobId));
    for (const i of get(report, 'failing-jobs').items) assert.match(i.detail!, /^(Agent|Elastic): last run \S.* at \d{4}-\d\d-\d\d \d\d:\d\d UTC$/);
    assert.ok(labels(get(report, 'disabled-jobs')).includes('AuditDemo - Legacy Shipment Sync'));
    assert.ok(labels(get(report, 'execute-as')).includes('dbo.Synthetic_HardCases'));
  });

  it('unresolved / missing references: table aliases left out, real missing objects kept', () => {
    const u = get(report, 'unresolved-references');
    // usp_ArchiveOrders: `DELETE t FROM dbo.OrderLog AS t` -> server row `t` (alias), nothing else unresolved
    assert.ok(!labels(u).includes('dbo.usp_ArchiveOrders'), JSON.stringify(u.items));
    const hard = u.items.find((i) => i.label === 'dbo.Synthetic_HardCases');
    assert.ok(hard, JSON.stringify(u.items));
    assert.match(hard.detail!, /unresolved: .*dbo\.GetAuditRows/);
    const missing = get(report, 'missing-references').items.find((i) => i.label === 'dbo.Synthetic_HardCases');
    assert.match(missing?.detail ?? '', /^missing: .*dbo\.Shelves/);
  });

  it('throwaway objects: SELECT *, unbalanced transaction, heap, disabled index, untrusted FK', () => {
    const star = get(report, 'select-star').items.find((i) => i.label === 'dbo.zz_in_star');
    assert.equal(star?.detail, 'dbo.Settings');
    const tx = get(report, 'transactions-without-try-catch').items.find((i) => i.label === 'dbo.zz_in_tx');
    assert.match(tx?.detail ?? '', /unbalanced/);
    assert.ok(labels(get(report, 'tables-without-primary-key')).includes('dbo.zz_in_heap'));
    assert.ok(get(report, 'disabled-indexes').items.some((i) => i.label === 'dbo.zz_in_heap' && i.detail?.startsWith('IX_zz_in_heap')));
    assert.ok(get(report, 'untrusted-or-disabled-foreign-keys').items.some((i) => i.detail === 'FK_zz_in_heap_Branch → dbo.Branch: not trusted'));
    assert.ok(labels(get(report, 'unreferenced-tables')).includes('dbo.zz_in_heap'));
  });

  it('orphan-procedures matches the Overview page client computation over /graph + /objects', async () => {
    const g = await api<Graph>(srv.base, 'GET', `/api/connections/${id}/graph?kinds=procedure,trigger,jobstep,function,view`);
    assert.equal(g.status, 200);
    assert.equal(g.body.truncated, false);
    const objs = await api<ObjectSummary[]>(srv.base, 'GET', `/api/connections/${id}/objects`);
    // copy of web/src/pages/OverviewPage.tsx (insights useMemo, orphans)
    const called = new Set<string>();
    const kindOf = new Map(g.body.nodes.map((n) => [n.id, n.kind]));
    for (const e of g.body.edges) {
      const from = kindOf.get(e.source);
      if (from && from !== 'jobstep' && e.relation !== 'calls' && e.relation !== 'references') continue;
      called.add(e.target);
    }
    const expected = objs.body
      .filter((o) => o.kind === 'procedure' && !called.has(objectNodeId('procedure', o.schema, o.name)))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((o) => `${o.schema}.${o.name}`);
    const orphans = get(report, 'orphan-procedures');
    assert.ok(expected.length > 0);
    assert.deepEqual(labels(orphans), expected);
    assert.equal(orphans.total, expected.length);
  });

  it('most-referenced-tables matches referencedByCount from /objects', async () => {
    const objs = await api<ObjectSummary[]>(srv.base, 'GET', `/api/connections/${id}/objects?kind=table`);
    const expected = objs.body
      .filter((o) => o.referencedByCount > 0)
      .sort((a, b) => b.referencedByCount - a.referencedByCount || a.name.localeCompare(b.name))
      .map((o) => [`${o.schema}.${o.name}`, o.referencedByCount]);
    assert.deepEqual(get(report, 'most-referenced-tables').items.map((i) => [i.label, i.value]), expected);
  });

  it('sha256 is stable across requests; generatedAt is not part of it', async () => {
    const again = await api<InsightsReport>(srv.base, 'GET', `/api/connections/${id}/insights`);
    assert.equal(again.body.sha256, report.sha256);
  });
});
