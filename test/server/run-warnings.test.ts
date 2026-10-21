/**
 * Refresh-run warnings carry structured object / job refs (RefreshRun.warningDetails, parallel to warnings), rows written
 * before that (warnings_json = string[]) still load, and GET /connections/:id/refresh pages with ?limit= and ?before=.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { ConnectionSummary, RefreshRun, RunWarning } from '../../shared/types';
import type { ListedObject } from '../../server/extract/catalog';
import { dependencyIssueWarnings } from '../../server/refresh/orchestrator';
import { api, connectionInput, dockerUnavailableReason, refreshAndWait, startServer, tempContext } from './helpers';

const reason = await dockerUnavailableReason();

const insertRun = (warningsJson: string, id: string, startedAt: string) => [
  `INSERT INTO refresh_runs (id, status, started_at, finished_at, request_json, progress_json, counts_json, warnings_json, segment_errors_json, error)
   VALUES (?, 'succeeded', ?, ?, '{"segments":"all","mode":"full"}', '{"phase":"done","done":1,"total":1}', '{}', ?, NULL, NULL)`,
  [id, startedAt, startedAt, warningsJson],
] as const;

describe('run warnings: storage and paging (no Docker)', () => {
  const ctx = tempContext();
  let srv: Awaited<ReturnType<typeof startServer>>;
  let id = '';
  before(async () => {
    srv = await startServer(ctx);
    id = ctx.connections.create(connectionInput('AuditDemo', 'full')).id;
  });
  after(async () => {
    await srv.close();
    await ctx.cleanup();
  });

  it('an old row with warnings_json = string[] maps to warnings + warningDetails [{message}]', () => {
    const store = ctx.caches.get(id);
    const [q, args] = insertRun(JSON.stringify(['first warning', 'second warning']), 'oldrow', '2020-01-01T00:00:00.000Z');
    store.db.prepare(q).run(...args);
    const run = store.getRun('oldrow', id)!;
    assert.deepEqual(run.warnings, ['first warning', 'second warning']);
    assert.deepEqual(run.warningDetails, [{ message: 'first warning' }, { message: 'second warning' }]);
    store.db.prepare(`DELETE FROM refresh_runs WHERE id = 'oldrow'`).run();
  });

  it('a structured row round-trips through saveRun / getRun', () => {
    const store = ctx.caches.get(id);
    const warningDetails: RunWarning[] = [
      { message: 'plain' },
      { message: 'about objects', objects: [{ kind: 'trigger', schema: '(database)', name: 'trg_x' }] },
      { message: 'about a job', job: { jobId: 'ABC-1', name: 'Nightly' } },
    ];
    const run: RefreshRun = {
      id: 'newrow',
      connectionId: id,
      status: 'succeeded',
      startedAt: '2020-01-02T00:00:00.000Z',
      finishedAt: '2020-01-02T00:00:01.000Z',
      request: { segments: 'all', mode: 'full' },
      progress: { phase: 'done', done: 1, total: 1 },
      counts: {},
      warnings: warningDetails.map((w) => w.message),
      warningDetails,
    };
    store.saveRun(run);
    assert.deepEqual(store.getRun('newrow', id), run);
    store.db.prepare(`DELETE FROM refresh_runs WHERE id = 'newrow'`).run();
  });

  it('GET /refresh pages with ?limit= and ?before= (started_at DESC, id DESC)', async () => {
    const store = ctx.caches.get(id);
    // r03a / r03b share started_at: the id breaks the tie
    const rows: Array<[string, string]> = [
      ['r01', '2021-01-01T00:00:00.000Z'],
      ['r02', '2021-01-02T00:00:00.000Z'],
      ['r03a', '2021-01-03T00:00:00.000Z'],
      ['r03b', '2021-01-03T00:00:00.000Z'],
      ['r04', '2021-01-04T00:00:00.000Z'],
    ];
    for (const [rid, at] of rows) {
      const [q, args] = insertRun('[]', rid, at);
      store.db.prepare(q).run(...args);
    }
    const ids = async (qs: string) => {
      const r = await api<RefreshRun[]>(srv.base, 'GET', `/api/connections/${id}/refresh${qs}`);
      assert.equal(r.status, 200, r.text);
      return r.body.map((x) => x.id);
    };
    assert.deepEqual(await ids(''), ['r04', 'r03b', 'r03a', 'r02', 'r01']);
    assert.deepEqual(await ids('?limit=2'), ['r04', 'r03b']);
    assert.deepEqual(await ids('?limit=2&before=r03b'), ['r03a', 'r02']);
    assert.deepEqual(await ids('?before=r02'), ['r01']);
    assert.deepEqual(await ids('?before=r01'), []);
    const all = await api<RefreshRun[]>(srv.base, 'GET', `/api/connections/${id}/refresh`);
    assert.ok(all.body.every((r) => Array.isArray(r.warningDetails)));

    for (const bad of ['?limit=0', '?limit=501', '?limit=abc', '?limit=1.5']) {
      assert.equal((await api(srv.base, 'GET', `/api/connections/${id}/refresh${bad}`)).status, 400, bad);
    }
    assert.equal((await api(srv.base, 'GET', `/api/connections/${id}/refresh?limit=500`)).status, 200);
    assert.equal((await api(srv.base, 'GET', `/api/connections/${id}/refresh?before=nope`)).status, 404);
  });

  it('the missing-references warning lists 25 names but references every module', () => {
    const mod = (i: number): ListedObject => ({
      objectId: i,
      kind: 'procedure',
      schema: 'dbo',
      name: `p${i}`,
      typeCode: 'P',
      createDate: '',
      modifyDate: '',
      parentObjectId: 0,
    });
    const missing = Array.from({ length: 30 }, (_, i) => ({ object: mod(i), message: 'references objects that do not exist (Msg 2020)' }));
    const [w] = dependencyIssueWarnings([], missing, []);
    assert.match(w.message, /^30 module\(s\) reference objects that do not exist .*dbo\.p24, \.\.\.$/);
    assert.ok(!w.message.includes('dbo.p25'));
    assert.equal(w.objects?.length, 30);
    assert.deepEqual(w.objects?.[29], { kind: 'procedure', schema: 'dbo', name: 'p29' });
  });
});

describe('run warnings: dependency issues carry object refs', { skip: reason ?? false }, () => {
  const ctx = tempContext();
  const input = () => connectionInput('AuditDemo', 'full', { jobs: null, jobsSource: 'none' });
  let srv: Awaited<ReturnType<typeof startServer>>;
  before(async () => (srv = await startServer(ctx)));
  after(async () => {
    await srv.close();
    await ctx.cleanup();
  });

  it('stale and missing-references warnings (AuditDemo seed) reference their modules; the summary keeps them parallel', async () => {
    const id = ctx.connections.create(input()).id;
    const run = await refreshAndWait(ctx, id, { segments: ['dependencies'], mode: 'full' });
    assert.equal(run.status, 'succeeded', JSON.stringify(run));
    assert.deepEqual(
      run.warningDetails.map((w) => w.message),
      run.warnings,
    );
    const stale = run.warningDetails.find((w) => w.message.startsWith('Stale module'));
    assert.deepEqual(stale?.objects, [{ kind: 'procedure', schema: 'dbo', name: 'usp_Stale' }]);
    const missing = run.warningDetails.find((w) => /module\(s\) reference objects that do not exist/.test(w.message));
    assert.deepEqual(missing?.objects, [{ kind: 'procedure', schema: 'dbo', name: 'Synthetic_HardCases' }]);

    const s = await api<ConnectionSummary>(srv.base, 'GET', `/api/connections/${id}/summary`);
    assert.equal(s.status, 200, s.text);
    assert.deepEqual(
      s.body.warningDetails.map((w) => w.message),
      s.body.warnings,
    );
    assert.deepEqual(s.body.warningDetails.find((w) => w.message.startsWith('Stale module'))?.objects, stale?.objects);
  });

  it('module calls that fail give one "Dependencies could not be read" warning per module, with its kind/schema/name', async () => {
    const conn = ctx.connections.create(input());
    // every per-module sys.dm_sql_referenced_entities call fails (as a per-query timeout would); the bulk query and listing do not
    const pool = await ctx.pools.get(ctx.connections.get(conn.id)!, 'target');
    const request = pool.request.bind(pool);
    pool.request = () => {
      const req = request();
      const query = req.query.bind(req) as (text: string) => Promise<unknown>;
      (req as unknown as { query: (text: string) => Promise<unknown> }).query = (text: string) =>
        text.includes('sys.dm_sql_referenced_entities(@name, @class)') ? Promise.reject(new Error('Query timed out after 1 ms')) : query(text);
      return req;
    };
    let run: RefreshRun;
    try {
      run = await refreshAndWait(ctx, conn.id, { segments: ['dependencies'], mode: 'full' });
    } finally {
      pool.request = request;
    }
    assert.equal(run.status, 'succeeded', JSON.stringify(run));
    const failed = run.warningDetails.filter((w) => w.message.startsWith('Dependencies could not be read for '));
    const modules = ctx.caches
      .get(conn.id)
      .db.prepare(`SELECT kind, schema_name AS schema, name FROM dependency_state WHERE kind <> 'table'`)
      .all() as Array<{ kind: string; schema: string; name: string }>;
    assert.ok(modules.length > 0);
    const key = (o: { kind: string; schema: string; name: string }) => `${o.kind}:${o.schema}.${o.name}`;
    assert.equal(failed.length, modules.length);
    for (const w of failed) {
      assert.equal(w.objects?.length, 1, w.message);
      const o = w.objects![0];
      assert.equal(w.message, `Dependencies could not be read for ${o.schema === '(database)' ? o.name : `${o.schema}.${o.name}`}: Query timed out after 1 ms`);
    }
    assert.deepEqual(failed.map((w) => key(w.objects![0])).sort(), modules.map(key).sort());
    // database-scoped DDL trigger uses schema (database)
    assert.ok(failed.some((w) => key(w.objects![0]) === 'trigger:(database).trg_ddl_NoOp'));
    assert.ok(failed.some((w) => key(w.objects![0]) === 'procedure:dbo.usp_Stale'));
  });
});
