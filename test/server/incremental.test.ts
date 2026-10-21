/**
 * Incremental / single-object / segment refresh. Setup changes the database as `sa` (dev only) using
 * throwaway procedures dbo.zz_inc_* that are created in before() and dropped in after().
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { connectionInput, countKinds, dockerUnavailableReason, refreshAndWait, saExec, SEED, tempContext } from './helpers';

const reason = await dockerUnavailableReason();

const DROP_ALL = `
IF OBJECT_ID(N'dbo.zz_inc_a') IS NOT NULL DROP PROCEDURE dbo.zz_inc_a;
IF OBJECT_ID(N'dbo.zz_inc_b') IS NOT NULL DROP PROCEDURE dbo.zz_inc_b;
IF OBJECT_ID(N'dbo.zz_inc_c') IS NOT NULL DROP PROCEDURE dbo.zz_inc_c;`;

describe('incremental refresh', { skip: reason ?? false }, () => {
  const ctx = tempContext();
  let id = '';

  before(async () => {
    await saExec('AuditDemo', [
      DROP_ALL,
      `CREATE PROCEDURE dbo.zz_inc_a AS SELECT BranchId FROM dbo.Branch;`,
      `CREATE PROCEDURE dbo.zz_inc_b AS SELECT SettingKey FROM dbo.Settings;`,
      `CREATE PROCEDURE dbo.zz_inc_c AS SELECT 1 AS one;`,
    ]);
    id = ctx.connections.create(connectionInput('AuditDemo', 'full', { jobs: null, jobsSource: 'none' })).id;
    const first = await refreshAndWait(ctx, id, { segments: 'all', mode: 'full' });
    assert.equal(first.status, 'succeeded');
    assert.equal(countKinds(ctx, id).procedure, SEED.auditDemo.procedure + 3);
  });
  after(async () => {
    await saExec('AuditDemo', [DROP_ALL]);
    await ctx.cleanup();
  });

  it('nothing changed -> everything unchanged', async () => {
    const r = await refreshAndWait(ctx, id, { segments: 'all', mode: 'incremental' });
    assert.equal(r.status, 'succeeded');
    assert.deepEqual(r.counts.procedures, { added: 0, updated: 0, removed: 0, unchanged: SEED.auditDemo.procedure + 3 });
    assert.deepEqual(r.counts.tables, { added: 0, updated: 0, removed: 0, unchanged: SEED.auditDemo.table });
    assert.equal(r.counts.dependencies?.updated, 0);
    assert.equal(r.counts.dependencies?.added, 0);
  });

  it('ALTER one proc -> only it is updated; DROP one -> removed; others unchanged', async () => {
    await saExec('AuditDemo', [`ALTER PROCEDURE dbo.zz_inc_a AS SELECT SettingKey, SettingValue FROM dbo.Settings;`, `DROP PROCEDURE dbo.zz_inc_b;`]);
    const store = ctx.caches.get(id);
    const before = store.getObject('procedure', 'dbo', 'usp_NightlyBatch')!.fetchedAt;
    const r = await refreshAndWait(ctx, id, { segments: 'all', mode: 'incremental' });
    assert.equal(r.status, 'succeeded', JSON.stringify(r));
    assert.deepEqual(r.counts.procedures, { added: 0, updated: 1, removed: 1, unchanged: SEED.auditDemo.procedure + 1 });
    assert.deepEqual(r.counts.dependencies, { added: 0, updated: 1, removed: 1, unchanged: SEED.auditDemo.procedure + 1 + 11 + 2 + 2 + 2 });
    assert.match(store.getObject('procedure', 'dbo', 'zz_inc_a')!.definition!, /SettingValue/);
    assert.equal(store.getObject('procedure', 'dbo', 'zz_inc_b'), null);
    assert.equal(store.getObject('procedure', 'dbo', 'usp_NightlyBatch')!.fetchedAt, before, 'unchanged objects are not re-fetched');
    const deps = store.allDependencies().filter((d) => d.fromName === 'zz_inc_a').map((d) => d.refName);
    assert.deepEqual(deps, ['Settings']);
    assert.ok(!store.allDependencies().some((d) => d.fromName === 'zz_inc_b'));
  });

  it('single-object refresh updates just that object (and removes it when gone)', async () => {
    await saExec('AuditDemo', [`ALTER PROCEDURE dbo.zz_inc_c AS SELECT 2 AS two FROM dbo.Branch;`]);
    const r = await refreshAndWait(ctx, id, { segments: 'all', mode: 'incremental', objects: [{ kind: 'procedure', schema: 'dbo', name: 'zz_inc_c' }] });
    assert.equal(r.status, 'succeeded', JSON.stringify(r));
    // Phase B: the refresh brings the static analysis up to date afterwards (counts.analysis)
    assert.deepEqual(Object.keys(r.counts).sort(), ['analysis', 'dependencies', 'procedures']);
    assert.equal(r.counts.analysis?.updated, 1);
    assert.deepEqual(r.counts.procedures, { added: 0, updated: 1, removed: 0, unchanged: 0 });
    const store = ctx.caches.get(id);
    assert.match(store.getObject('procedure', 'dbo', 'zz_inc_c')!.definition!, /two/);
    assert.deepEqual(store.allDependencies().filter((d) => d.fromName === 'zz_inc_c').map((d) => d.refName), ['Branch']);

    await saExec('AuditDemo', [`DROP PROCEDURE dbo.zz_inc_c;`]);
    const gone = await refreshAndWait(ctx, id, { segments: 'all', mode: 'incremental', objects: [{ kind: 'procedure', schema: 'dbo', name: 'zz_inc_c' }] });
    assert.deepEqual(gone.counts.procedures, { added: 0, updated: 0, removed: 1, unchanged: 0 });
    assert.equal(store.getObject('procedure', 'dbo', 'zz_inc_c'), null);
    assert.ok(!store.allDependencies().some((d) => d.fromName === 'zz_inc_c'));
  });

  it("segment refresh ['tables'] leaves other segments untouched", async () => {
    await saExec('AuditDemo', [`ALTER PROCEDURE dbo.zz_inc_a AS SELECT 'segment-test' AS marker;`]);
    const store = ctx.caches.get(id);
    const procBefore = store.getObject('procedure', 'dbo', 'zz_inc_a')!;
    const depsBefore = JSON.stringify(store.allDependencies());
    const tableBefore = store.getObject('table', 'dbo', 'Branch')!.fetchedAt;
    const r = await refreshAndWait(ctx, id, { segments: ['tables'], mode: 'full' });
    assert.equal(r.status, 'succeeded');
    assert.deepEqual(Object.keys(r.counts), ['tables']);
    assert.deepEqual(r.counts.tables, { added: 0, updated: 0, removed: 0, unchanged: SEED.auditDemo.table });
    const procAfter = store.getObject('procedure', 'dbo', 'zz_inc_a')!;
    assert.equal(procAfter.definition, procBefore.definition, 'procedure definition must not change');
    assert.equal(procAfter.fetchedAt, procBefore.fetchedAt);
    assert.equal(JSON.stringify(store.allDependencies()), depsBefore);
    assert.notEqual(store.getObject('table', 'dbo', 'Branch')!.fetchedAt, tableBefore, 'full table segment re-fetched tables');
    // and the procedures segment alone picks the change up
    const p = await refreshAndWait(ctx, id, { segments: ['procedures'], mode: 'incremental' });
    // zz_inc_b / zz_inc_c are gone by now; zz_inc_a is the updated one -> the 18 seed procs are unchanged
    assert.deepEqual(p.counts.procedures, { added: 0, updated: 1, removed: 0, unchanged: SEED.auditDemo.procedure });
    assert.match(store.getObject('procedure', 'dbo', 'zz_inc_a')!.definition!, /segment-test/);
  });

  it('a failing segment keeps the previous cached data (one transaction per segment)', async () => {
    const store = ctx.caches.get(id);
    const before = store.listObjects('view').map((o) => o.fetchedAt);
    const original = store.applyObjectSegment.bind(store);
    store.applyObjectSegment = () => {
      throw new Error('simulated write failure');
    };
    try {
      const r = await refreshAndWait(ctx, id, { segments: ['views', 'functions'], mode: 'full' });
      assert.equal(r.status, 'failed');
      assert.match(r.segmentErrors?.views ?? '', /simulated write failure/);
    } finally {
      store.applyObjectSegment = original;
    }
    assert.deepEqual(store.listObjects('view').map((o) => o.fetchedAt), before);
    assert.equal(store.listObjects('view').length, SEED.auditDemo.view);
  });

  it('one active run per connection: a second start is a conflict', async () => {
    ctx.refresh.start(id, { segments: ['procedures'], mode: 'full' });
    assert.throws(() => ctx.refresh.start(id, { segments: ['tables'], mode: 'full' }), /already running/);
    await ctx.refresh.waitIdle(id);
    const runs = ctx.refresh.list(id, 50);
    assert.ok(runs.length >= 7);
    assert.ok(runs.every((x) => x.status !== 'running'));
  });
});
