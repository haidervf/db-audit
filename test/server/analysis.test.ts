/**
 * Phase B static-analysis pipeline against the Docker seed: refresh -> analysis rows -> resolver -> merged
 * graph / object + job details. Setup that changes the database runs as `sa` (dev only) on throwaway
 * objects dbo.zz_an_* that are created in before() and dropped in after().
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { GraphEdge, RefreshRun } from '../../shared/types';
import { READ_OPS, WRITE_OPS } from '../../server/analysis/refs';
import { ReadModel } from '../../server/api/readModel';
import { ANALYZER_VERSION } from '../../server/analyze/tsql/index';
import { connectionInput, dockerUnavailableReason, refreshAndWait, saExec, SEED, tempContext } from './helpers';

const reason = await dockerUnavailableReason();

const DROP_ALL = `
IF OBJECT_ID(N'dbo.zz_an_a') IS NOT NULL DROP PROCEDURE dbo.zz_an_a;
IF OBJECT_ID(N'dbo.zz_an_syn') IS NOT NULL DROP PROCEDURE dbo.zz_an_syn;
IF OBJECT_ID(N'dbo.zz_an_ord') IS NOT NULL DROP SYNONYM dbo.zz_an_ord;`;

describe('static analysis pipeline', { skip: reason ?? false }, () => {
  const ctx = tempContext();
  let id = '';
  let first: RefreshRun;
  const rm = () => new ReadModel(ctx.caches.get(id), ctx.connections.get(id)!);

  before(async () => {
    await saExec('AuditDemo', [
      DROP_ALL,
      `CREATE PROCEDURE dbo.zz_an_a AS SELECT BranchId FROM dbo.Branch;`,
      `CREATE SYNONYM dbo.zz_an_ord FOR [dbo].[OrderLog];`,
      `CREATE PROCEDURE dbo.zz_an_syn AS SELECT COUNT(*) AS n FROM dbo.zz_an_ord;`,
    ]);
    id = ctx.connections.create(connectionInput('AuditDemo', 'full')).id;
    first = await refreshAndWait(ctx, id, { segments: 'all', mode: 'full' });
  });
  after(async () => {
    await saExec('AuditDemo', [DROP_ALL]);
    await ctx.cleanup();
  });

  it('full refresh: every procedure / function / view / trigger with a definition has an analysis row', () => {
    assert.equal(first.status, 'succeeded', JSON.stringify(first));
    assert.equal(first.progress.total, 8);
    const store = ctx.caches.get(id);
    const states = store.analysisStates();
    let modules = 0;
    for (const kind of ['procedure', 'function', 'view', 'trigger'] as const) {
      for (const o of store.listObjects(kind, true)) {
        const key = `${o.kind}:${o.schema}.${o.name}`;
        if (o.definition === null) {
          assert.ok(!states.has(key), `${key} has no definition but an analysis row`);
          continue;
        }
        modules++;
        assert.equal(states.get(key)?.analyzerVersion, ANALYZER_VERSION, `${key} missing analysis`);
        assert.equal(states.get(key)?.definitionSha256, o.definitionSha256);
      }
    }
    // 18 seed procs - 1 encrypted + zz_an_a + zz_an_syn, 2 views, 2 functions, 2 triggers
    assert.equal(modules, SEED.auditDemo.procedure - 1 + 2 + 2 + 2 + 2);
    const steps = [...states.keys()].filter((k) => k.startsWith('jobstep:')).length;
    assert.ok(steps >= 6 + 6, `expected the analyzable Agent + Elastic seed steps, got ${steps}`);
    assert.equal(first.counts.analysis?.added, states.size);
  });

  it('summaries carry analysisFlags (null for tables and encrypted modules)', () => {
    const procs = rm().summaries('procedure');
    const by = new Map(procs.map((p) => [p.name, p]));
    assert.equal(by.get('usp_Secret')!.analysisFlags, null);
    assert.deepEqual(by.get('usp_DynamicReport')!.analysisFlags, { hasDynamicSql: true, hasCrossDb: false, readsTables: 0, writesTables: 0, callsProcs: 0, warnings: 0 });
    assert.equal(by.get('usp_ArchiveOrders')!.analysisFlags!.hasCrossDb, true);
    assert.equal(by.get('usp_DailyOrderTotals')!.analysisFlags!.hasCrossDb, false, '[AuditDemo].[dbo].[X] is not cross-database');
    assert.equal(by.get('usp_NightlyBatch')!.analysisFlags!.callsProcs, 3);
    assert.ok(rm().summaries('table').every((t) => t.analysisFlags === null));
  });

  it('resolver: same-db 3-part name -> local table (sameDatabaseQualified); AuditArchive.dbo.X -> external; synonym -> base table', () => {
    const d = rm().detail('procedure', 'dbo', 'usp_DailyOrderTotals')!;
    assert.deepEqual(d.analysis!.resolved['auditdemo.dbo.orderlog'], {
      key: 'auditdemo.dbo.orderlog',
      nodeId: 'table:dbo.OrderLog',
      kind: 'table',
      exists: true,
      sameDatabaseQualified: true,
    });
    assert.ok(d.uses.some((u) => u.nodeId === 'table:dbo.OrderLog' && u.relation === 'reads' && u.origin.includes('static')));
    const a = rm().detail('procedure', 'dbo', 'usp_ArchiveOrders')!;
    const x = a.analysis!.resolved['auditarchive.dbo.orderarchivesummary']!;
    assert.equal(x.kind, 'external');
    assert.equal(x.exists, false);
    assert.equal(x.nodeId, 'external:AuditArchive.dbo.OrderArchiveSummary');
    assert.ok(a.analysis!.analyzedAt.length > 0);
    assert.equal(a.analysis!.definitionSha256, a.definitionSha256);
    const s = rm().detail('procedure', 'dbo', 'zz_an_syn')!;
    assert.equal(s.analysis!.resolved['dbo.zz_an_ord']!.nodeId, 'table:dbo.OrderLog', 'resolved through sys.synonyms');
  });

  it('graph: alias noise unknown:t is gone and replaced by a static writes edge with ops DELETE', () => {
    const g = rm().fullGraph();
    assert.ok(!g.nodes.has('unknown:t'), 'unknown:t still in graph');
    assert.ok(!g.nodes.has('unknown:a'), 'unknown:a (Synthetic_HardCases alias) still in graph');
    const w = g.edges.get('procedure:dbo.usp_ArchiveOrders->table:dbo.OrderLog:writes');
    assert.ok(w, 'no writes edge');
    assert.deepEqual(w.ops, ['DELETE']);
    assert.deepEqual(w.origin, ['static']);
    // same edge from both origins -> merged
    const c = g.edges.get('procedure:dbo.usp_NightlyBatch->procedure:dbo.usp_ArchiveOrders:calls')!;
    assert.deepEqual(c.origin, ['server', 'static']);
    // node meta for the UI
    assert.deepEqual(
      (({ hasDynamicSql, isEncrypted, hasCrossDb }) => ({ hasDynamicSql, isEncrypted, hasCrossDb }))(g.nodes.get('procedure:dbo.usp_DynamicReport')!.meta!),
      { hasDynamicSql: true, isEncrypted: false, hasCrossDb: false },
    );
  });

  it('graph: server references fold into static reads/writes/calls; one edge per relation; ops are TableOp names only', () => {
    const m = rm();
    const fmt = (u: { relation: string; nodeId: string; ops: string[]; origin: string[] }) => `${u.relation} ${u.nodeId} [${u.ops.join(',')}] ${u.origin.join('+')}`;
    // the side panel / Dependencies tab of usp_ArchiveOrders: no extra `references` next to the static writes
    assert.deepEqual(m.detail('procedure', 'dbo', 'usp_ArchiveOrders')!.uses.map(fmt).sort(), [
      'calls procedure:dbo.usp_WriteAudit [] server+static',
      'reads table:dbo.OrderLog [SELECT] server+static',
      'reads table:dbo.ShipmentLogs [SELECT] server+static',
      'writes external:AuditArchive.dbo.OrderArchiveSummary [INSERT] server+static',
      'writes table:dbo.OrderLog [DELETE] static', // the server reported a read only
      'writes table:dbo.OrderLogArchive [INSERT] server+static',
    ]);
    assert.deepEqual(
      m.detail('table', 'dbo', 'OrderLogArchive')!.usedBy.filter((u) => u.nodeId === 'procedure:dbo.usp_ArchiveOrders').map(fmt),
      ['writes procedure:dbo.usp_ArchiveOrders [INSERT] server+static'],
    );

    // the whole graph
    const g = m.fullGraph();
    const byPair = new Map<string, GraphEdge[]>();
    for (const e of g.edges.values()) {
      const k = `${e.source} -> ${e.target}`;
      (byPair.get(k) ?? byPair.set(k, []).get(k)!).push(e);
    }
    const tableOps = new Set<string>([...READ_OPS, ...WRITE_OPS]);
    for (const [pair, list] of byPair) {
      const rels = list.map((e) => e.relation);
      assert.equal(new Set(rels).size, rels.length, `${pair}: more than one edge per relation`);
      const hasStatic = list.some((e) => (e.relation === 'reads' || e.relation === 'writes' || e.relation === 'calls') && e.origin.includes('static'));
      assert.ok(!(hasStatic && rels.includes('references')), `${pair}: references next to a static edge (${list.map((e) => `${e.relation}[${e.origin}]`).join(' ')})`);
    }
    for (const e of g.edges.values()) {
      assert.ok(!(e.ops ?? []).some((o) => /^(read|write)$/i.test(o)), `${e.id}: server op token in ${JSON.stringify(e.ops)}`);
      if (e.relation === 'reads' || e.relation === 'writes') {
        assert.ok(Array.isArray(e.ops) && e.ops.every((o) => tableOps.has(o)), `${e.id}: ops ${JSON.stringify(e.ops)}`);
        if (!e.origin.includes('static')) assert.deepEqual(e.ops, [], `${e.id}: server-only edge has ops`);
      }
      assert.ok(['server', 'static', 'server,static'].includes(e.origin.join(',')), `${e.id}: origin ${JSON.stringify(e.origin)}`);
    }
  });

  it('Agent job "AuditDemo - Nightly Maintenance": step 1 calls usp_NightlyBatch (static); jobsUsing via analysis', () => {
    const m = rm();
    const job = m.jobSummaries().find((j) => j.source === 'agent' && j.name === 'AuditDemo - Nightly Maintenance')!;
    const e = m.fullGraph().edges.get(`jobstep:${job.jobId}#1->procedure:dbo.usp_NightlyBatch:calls`);
    assert.ok(e, 'missing jobstep -> procedure calls edge');
    assert.ok(e.origin.includes('static'));
    const jobNode = m.fullGraph().nodes.get(`job:${job.jobId}`)!;
    assert.deepEqual([jobNode.meta!.enabled, jobNode.meta!.source, jobNode.meta!.lastRunOutcome], [true, 'agent', 'Succeeded']);
    const p = m.detail('procedure', 'dbo', 'usp_NightlyBatch')!;
    assert.deepEqual(
      p.jobsUsing.map((u) => `${u.source}:${u.jobName}#${u.stepId}:${u.via}`).sort(),
      ['agent:AuditDemo - Nightly Maintenance#1:analysis', 'elastic:NightlyMaintenance#1:analysis'],
    );
    assert.ok(p.usedBy.some((u) => u.kind === 'jobstep' && u.relation === 'calls' && u.direction === 'in'));
    const step = m.jobDetail(job.jobId)!.steps[0]!;
    assert.equal(step.analysis!.resolved['dbo.usp_nightlybatch']!.nodeId, 'procedure:dbo.usp_NightlyBatch');
  });

  it('Agent step that runs in AuditArchive: refs are external to that database; non-T-SQL steps have no analysis', () => {
    const m = rm();
    const comp = m.jobSummaries().find((j) => j.name === 'AuditArchive - Compaction')!;
    const st = m.jobDetail(comp.jobId)!.steps[0]!;
    assert.deepEqual(st.analysis!.resolved['dbo.usp_compactarchive'], {
      key: 'dbo.usp_compactarchive',
      sameDatabaseQualified: false,
      nodeId: 'external:AuditArchive.dbo.usp_CompactArchive',
      kind: 'external',
      exists: false,
    });
    const legacy = m.jobSummaries().find((j) => j.name === 'AuditDemo - Legacy Shipment Sync')!;
    const cmd = m.jobDetail(legacy.jobId)!.steps.find((s) => s.subsystem === 'CmdExec')!;
    assert.equal(cmd.analyzable, false);
    assert.equal(cmd.analysis, null);
  });

  it('table detail usedBy lists writers with ops', () => {
    const t = rm().detail('table', 'dbo', 'OrderLog')!;
    const writers = t.usedBy.filter((u) => u.relation === 'writes').map((u) => `${u.nodeId}[${u.ops.filter((o) => o === o.toUpperCase()).join(',')}]`);
    assert.ok(writers.includes('procedure:dbo.usp_ArchiveOrders[DELETE]'), writers.join(' '));
    assert.ok(writers.includes('procedure:dbo.usp_PlaceOrder[INSERT]'), writers.join(' '));
    assert.ok(t.usedBy.every((u) => u.direction === 'in'));
    assert.ok(t.uses.some((u) => u.relation === 'fk' && u.nodeId === 'table:dbo.Member_Card'));
  });

  it("segment 'analysis' re-analyses everything from the cache without opening a database connection", async () => {
    const store = ctx.caches.get(id);
    const before = store.getAnalysis('procedure:dbo.usp_NightlyBatch')!.analyzedAt;
    const total = store.analysisStates().size;
    let pools = 0;
    const orig = ctx.pools.get.bind(ctx.pools);
    ctx.pools.get = ((...args: Parameters<typeof orig>) => {
      pools++;
      return orig(...args);
    }) as typeof ctx.pools.get;
    try {
      await new Promise((r) => setTimeout(r, 5));
      const r = await refreshAndWait(ctx, id, { segments: ['analysis'], mode: 'full' });
      assert.equal(r.status, 'succeeded', JSON.stringify(r));
      assert.deepEqual(r.counts.analysis, { added: 0, updated: 0, removed: 0, unchanged: total });
      assert.deepEqual(r.progress, { phase: 'done', done: 1, total: 1 });
      assert.equal(pools, 0, 'a pool was requested');
      assert.notEqual(store.getAnalysis('procedure:dbo.usp_NightlyBatch')!.analyzedAt, before, 'full analysis segment re-analyses');
    } finally {
      ctx.pools.get = orig;
    }
  });

  it('incremental after ALTER of one proc re-analyses only that proc; DROP removes its row', async () => {
    const store = ctx.caches.get(id);
    const untouched = store.getAnalysis('procedure:dbo.usp_NightlyBatch')!.analyzedAt;
    const total = store.analysisStates().size;
    await saExec('AuditDemo', [`ALTER PROCEDURE dbo.zz_an_a AS SELECT SettingKey FROM dbo.Settings;`]);
    const r = await refreshAndWait(ctx, id, { segments: ['procedures'], mode: 'incremental' });
    assert.equal(r.status, 'succeeded', JSON.stringify(r));
    assert.deepEqual(r.counts.analysis, { added: 0, updated: 1, removed: 0, unchanged: total - 1 });
    assert.equal(store.getAnalysis('procedure:dbo.usp_NightlyBatch')!.analyzedAt, untouched);
    const a = rm().detail('procedure', 'dbo', 'zz_an_a')!;
    assert.deepEqual(a.analysis!.tables.map((t) => t.ref.key), ['dbo.settings']);
    assert.equal(a.analysis!.definitionSha256, a.definitionSha256);

    await saExec('AuditDemo', [`DROP PROCEDURE dbo.zz_an_a;`]);
    const d = await refreshAndWait(ctx, id, { segments: ['procedures'], mode: 'incremental' });
    assert.deepEqual(d.counts.analysis, { added: 0, updated: 0, removed: 1, unchanged: total - 1 });
    assert.equal(store.getAnalysis('procedure:dbo.zz_an_a'), null);
  });
});
