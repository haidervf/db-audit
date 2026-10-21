/**
 * Dependencies are saved in batches as they complete: a small batch size gives the same cache contents and counts
 * as one big batch, and a run cancelled mid-loop keeps the completed batches so the next incremental run computes
 * only the remainder.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { RefreshRun } from '../../shared/types';
import type { CacheStore } from '../../server/store/cacheStore';
import { connectionInput, dockerUnavailableReason, refreshAndWait, SEED, tempContext } from './helpers';

const reason = await dockerUnavailableReason();

const MODULES = SEED.auditDemo.procedure + SEED.auditDemo.view + SEED.auditDemo.function + SEED.auditDemo.trigger;
const OBJECTS = MODULES + SEED.auditDemo.table;

/** Sorted dumps without ids / timestamps. */
function dump(store: CacheStore): { deps: string[]; states: string[]; issues: unknown } {
  const deps = (store.db.prepare(`SELECT * FROM dependencies`).all() as Array<Record<string, unknown>>).map((r) => {
    const { id, ...rest } = r;
    void id;
    return JSON.stringify(rest);
  });
  const states = (store.db.prepare(`SELECT kind, schema_name, name, server_object_id, modify_date FROM dependency_state`).all() as unknown[]).map((r) =>
    JSON.stringify(r),
  );
  return { deps: deps.sort(), states: states.sort(), issues: store.getMeta('dependency_issues') };
}

/** Counts applyDependencies calls; `onCall(n)` runs after the n-th call returned. */
function spyApply(store: CacheStore, onCall: (n: number) => void = () => undefined): { calls: number; restore(): void } {
  const original = store.applyDependencies;
  const spy = {
    calls: 0,
    restore: () => {
      store.applyDependencies = original;
    },
  };
  store.applyDependencies = (...args) => {
    const changed = original.apply(store, args);
    spy.calls++;
    onCall(spy.calls);
    return changed;
  };
  return spy;
}

describe('dependencies: batched saves', { skip: reason ?? false }, () => {
  const ctx = tempContext();
  const input = () => connectionInput('AuditDemo', 'full', { jobs: null, jobsSource: 'none' });
  let reference: ReturnType<typeof dump>;
  let referenceRun: RefreshRun;

  before(async () => {
    // batching effectively off: one batch for the tables, one for all modules
    ctx.refresh.dependencyBatchSize = 10_000;
    const id = ctx.connections.create(input()).id;
    referenceRun = await refreshAndWait(ctx, id, { segments: ['dependencies'], mode: 'full' });
    assert.equal(referenceRun.status, 'succeeded', JSON.stringify(referenceRun));
    reference = dump(ctx.caches.get(id));
  });
  after(() => ctx.cleanup());

  it('batch size 5 gives the same contents and counts as one batch', async () => {
    assert.deepEqual(referenceRun.counts.dependencies, { added: OBJECTS, updated: 0, removed: 0, unchanged: 0 });
    assert.equal(reference.states.length, OBJECTS);
    ctx.refresh.dependencyBatchSize = 5;
    const id = ctx.connections.create(input()).id;
    const spy = spyApply(ctx.caches.get(id));
    const run = await refreshAndWait(ctx, id, { segments: ['dependencies'], mode: 'full' });
    spy.restore();
    assert.equal(run.status, 'succeeded', JSON.stringify(run));
    assert.deepEqual(run.counts.dependencies, referenceRun.counts.dependencies);
    assert.deepEqual(dump(ctx.caches.get(id)), reference);
    // tables, ceil(modules / 5) module batches, the final removals call
    assert.equal(spy.calls, 1 + Math.ceil(MODULES / 5) + 1);
    assert.deepEqual([...run.warnings].sort(), [...referenceRun.warnings].sort());
  });

  it('a run cancelled mid-loop keeps the completed batches; the next incremental run computes the rest', async () => {
    ctx.refresh.dependencyBatchSize = 5;
    const id = ctx.connections.create(input()).id;
    const store = ctx.caches.get(id);
    let runId = '';
    // call 1 saves the tables, call 2 the first 5 modules: cancel right after it
    const spy = spyApply(store, (n) => {
      if (n === 2) ctx.refresh.cancel(id, runId);
    });
    runId = ctx.refresh.start(id, { segments: ['dependencies'], mode: 'full' }).id;
    await ctx.refresh.waitIdle(id);
    spy.restore();
    const cancelled = ctx.refresh.get(id, runId)!;
    assert.equal(cancelled.status, 'cancelled', JSON.stringify(cancelled));
    assert.equal(cancelled.counts.dependencies, undefined);
    const saved = dump(store).states.length;
    assert.equal(saved, SEED.auditDemo.table + 5, 'tables + the first module batch are saved');

    const resumed = await refreshAndWait(ctx, id, { segments: ['dependencies'], mode: 'incremental' });
    assert.equal(resumed.status, 'succeeded', JSON.stringify(resumed));
    assert.deepEqual(resumed.counts.dependencies, { added: OBJECTS - saved, updated: 0, removed: 0, unchanged: saved });
    assert.deepEqual(dump(store), reference);
  });
});
