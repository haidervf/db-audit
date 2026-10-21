import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { ConnectionProfile, ConnectionSummary, Graph, JobDetail, JobSummary, ObjectDetail, ObjectSummary, RefreshRun } from '../../shared/types';
import { createApp } from '../../server/app';
import { api, connectionInput, dockerUnavailableReason, pollRun, SEED, startServer, tempContext } from './helpers';

const reason = await dockerUnavailableReason();

function rawRequest(port: number, headers: Record<string, string>, urlPath = '/api/health'): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'GET', headers }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('api: guards and basics (no Docker)', () => {
  const ctx = tempContext();
  let srv: Awaited<ReturnType<typeof startServer>>;
  before(async () => (srv = await startServer(ctx)));
  after(async () => {
    await srv.close();
    await ctx.cleanup();
  });

  it('GET /api/health', async () => {
    const r = await api<{ ok: boolean }>(srv.base, 'GET', '/api/health');
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
  });

  it('rejects a non-local Host header (DNS rebinding) and a foreign Origin', async () => {
    assert.equal((await rawRequest(srv.port, { Host: 'evil.example.com' })).status, 403);
    assert.equal((await rawRequest(srv.port, { Host: `attacker.test:${srv.port}` })).status, 403);
    assert.equal((await rawRequest(srv.port, { Host: `localhost:${srv.port}` })).status, 200);
    assert.equal((await rawRequest(srv.port, { Host: `127.0.0.1:${srv.port}` })).status, 200);
    assert.equal((await rawRequest(srv.port, { Host: `localhost:${srv.port}`, Origin: 'https://evil.example.com' })).status, 403);
    assert.equal((await rawRequest(srv.port, { Host: `localhost:${srv.port}`, Origin: 'http://localhost:5173' })).status, 200);
  });

  it('unknown routes, bad ids and bad JSON give ApiError JSON', async () => {
    const a = await api<{ error: string }>(srv.base, 'GET', '/api/nope');
    assert.equal(a.status, 404);
    assert.ok(a.body.error);
    assert.equal((await api(srv.base, 'GET', '/api/connections/../../etc/summary')).status, 404);
    const res = await fetch(srv.base + '/api/connections', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad' });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'malformed JSON body' });
  });

  it('serves web/dist with SPA fallback when it exists (API still wins)', async () => {
    const dist = path.join(ctx.paths.dataDir, 'fake-dist');
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>db-audit</title>');
    fs.writeFileSync(path.join(dist, 'app.js'), 'console.log(1)');
    const server = createApp(ctx, dist).listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const port = (server.address() as { port: number }).port;
    try {
      const page = await rawRequest(port, { Host: `localhost:${port}` }, '/connections/abc/graph');
      assert.equal(page.status, 200);
      assert.match(page.body, /<title>db-audit<\/title>/);
      assert.equal((await rawRequest(port, { Host: `localhost:${port}` }, '/app.js')).body, 'console.log(1)');
      assert.equal((await rawRequest(port, { Host: `localhost:${port}` }, '/api/health')).status, 200);
      assert.equal((await rawRequest(port, { Host: `localhost:${port}` }, '/api/nothing')).status, 404);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

describe('api: end-to-end over HTTP against Docker', { skip: reason ?? false }, () => {
  const ctx = tempContext();
  let srv: Awaited<ReturnType<typeof startServer>>;
  let id = '';
  before(async () => {
    srv = await startServer(ctx);
    const c = await api<ConnectionProfile>(srv.base, 'POST', '/api/connections', connectionInput('AuditDemo', 'full'));
    id = c.body.id;
  });
  after(async () => {
    await srv.close();
    await ctx.cleanup();
  });

  it('POST /refresh -> 202 {runId}; concurrent POST -> 409; GET status polls to completion', async () => {
    const r = await api<{ runId: string }>(srv.base, 'POST', `/api/connections/${id}/refresh`, { segments: 'all', mode: 'full' });
    assert.equal(r.status, 202);
    assert.ok(r.body.runId);
    const again = await api<{ error: string }>(srv.base, 'POST', `/api/connections/${id}/refresh`, { segments: ['tables'], mode: 'full' });
    assert.equal(again.status, 409);
    const busyDelete = await api(srv.base, 'DELETE', `/api/connections/${id}`);
    assert.equal(busyDelete.status, 409);
    const run = await pollRun(srv.base, id, r.body.runId);
    assert.equal(run.status, 'succeeded', JSON.stringify(run));
    assert.deepEqual(run.progress, { phase: 'done', done: 8, total: 8 }); // 'all' = 7 extraction segments + 'analysis'
    const list = await api<RefreshRun[]>(srv.base, 'GET', `/api/connections/${id}/refresh`);
    assert.equal(list.body[0].id, r.body.runId);
    const bad = await api(srv.base, 'POST', `/api/connections/${id}/refresh`, { segments: ['nope'], mode: 'full' });
    assert.equal(bad.status, 400);
    assert.equal((await api(srv.base, 'GET', `/api/connections/${id}/refresh/doesnotexist`)).status, 404);
  });

  it('GET /summary', async () => {
    const s = await api<ConnectionSummary>(srv.base, 'GET', `/api/connections/${id}/summary`);
    assert.equal(s.status, 200);
    assert.deepEqual({ ...s.body.counts, job: undefined }, { ...SEED.auditDemo, job: undefined });
    assert.ok(s.body.counts.job >= SEED.agent.jobs + SEED.elastic.jobs);
    assert.equal(s.body.lastRefresh?.status, 'succeeded');
    assert.ok(s.body.warnings.some((w) => w.includes('usp_Stale')));
    assert.equal(s.body.serverInfo?.database, 'AuditDemo');
    assert.ok(s.body.connection.lastRefreshAt);
  });

  it('GET /objects?kind=&q= and object details', async () => {
    const procs = await api<ObjectSummary[]>(srv.base, 'GET', `/api/connections/${id}/objects?kind=procedure`);
    assert.equal(procs.body.length, SEED.auditDemo.procedure);
    const q = await api<ObjectSummary[]>(srv.base, 'GET', `/api/connections/${id}/objects?q=archive`);
    assert.ok(q.body.length >= 4 && q.body.every((o) => /archive/i.test(o.name)));
    const t = await api<ObjectSummary[]>(srv.base, 'GET', `/api/connections/${id}/objects?kind=table&q=orderlog`);
    assert.deepEqual(t.body.map((x) => [x.name, x.rowCount]).sort(), [['OrderLog', 200], ['OrderLogArchive', 30]]);
    assert.equal((await api(srv.base, 'GET', `/api/connections/${id}/objects?kind=bogus`)).status, 400);

    const d = await api<ObjectDetail>(srv.base, 'GET', `/api/connections/${id}/objects/procedure/dbo/usp_Checkout`);
    assert.equal(d.status, 200);
    assert.ok(d.body.references.some((x) => x.to.name === 'usp_PlaceOrder' && x.to.kind === 'procedure'));
    assert.equal(d.body.analysis?.header?.ref.name, 'usp_Checkout'); // Phase B: analysed during the refresh
    assert.equal(d.body.ai, null);
    assert.equal(d.body.definitionSha256?.length, 64);
    const ddl = await api<ObjectDetail>(srv.base, 'GET', `/api/connections/${id}/objects/trigger/(database)/trg_ddl_NoOp`);
    assert.equal(ddl.status, 200);
    const caseInsensitive = await api<ObjectDetail>(srv.base, 'GET', `/api/connections/${id}/objects/table/DBO/member_card`);
    assert.equal(caseInsensitive.status, 200);
    assert.equal(caseInsensitive.body.name, 'Member_Card');
    assert.equal((await api(srv.base, 'GET', `/api/connections/${id}/objects/procedure/dbo/nope`)).status, 404);
  });

  it('GET /jobs and /jobs/:jobId (both sources)', async () => {
    const jobs = await api<JobSummary[]>(srv.base, 'GET', `/api/connections/${id}/jobs`);
    assert.equal(jobs.status, 200);
    const agent = jobs.body.find((j) => j.source === 'agent' && j.name === 'AuditDemo - Nightly Maintenance')!;
    const elastic = jobs.body.find((j) => j.source === 'elastic' && j.name === 'NightlyMaintenance')!;
    const a = await api<JobDetail>(srv.base, 'GET', `/api/connections/${id}/jobs/${agent.jobId}`);
    assert.equal(a.status, 200);
    assert.equal(a.body.steps.length, 2);
    const e = await api<JobDetail>(srv.base, 'GET', `/api/connections/${id}/jobs/${elastic.jobId.toLowerCase()}`);
    assert.equal(e.status, 200);
    assert.equal(e.body.schedules.length, 1);
    assert.equal((await api(srv.base, 'GET', `/api/connections/${id}/jobs/00000000-0000-0000-0000-000000000000`)).status, 404);
  });

  it('GET /graph: whole DB, focus + depth, kinds filter, node cap', async () => {
    const all = await api<Graph>(srv.base, 'GET', `/api/connections/${id}/graph`);
    assert.equal(all.status, 200);
    assert.equal(all.body.truncated, false);
    const ids = new Set(all.body.nodes.map((n) => n.id));
    for (const n of ['procedure:dbo.usp_NightlyBatch', 'table:dbo.OrderLog', 'external:AuditArchive.dbo.OrderArchiveSummary', 'trigger:(database).trg_ddl_NoOp']) {
      assert.ok(ids.has(n), `missing node ${n}`);
    }
    const agentJob = all.body.nodes.find((n) => n.kind === 'job' && n.label === 'AuditDemo - Nightly Maintenance')!;
    assert.match(agentJob.id, /^job:[0-9A-F-]{36}$/);
    assert.ok(all.body.nodes.some((n) => n.id === `jobstep:${agentJob.id.slice(4)}#2`));
    const rel = (s: string, t: string) => all.body.edges.filter((e) => e.source === s && e.target === t).map((e) => e.relation).sort();
    assert.deepEqual(rel('procedure:dbo.usp_NightlyBatch', 'procedure:dbo.usp_ArchiveOrders'), ['calls']);
    assert.deepEqual(rel('procedure:dbo.usp_PlaceOrder', 'table:dbo.OrderLog'), ['writes']);
    assert.deepEqual(rel('view:dbo.vw_MemberPoints', 'table:dbo.Member'), ['reads']);
    assert.deepEqual(rel('table:dbo.OrderLog', 'table:dbo.Member_Card'), ['fk']);
    // the trigger reads its parent through inserted/deleted (server dependency) and is attached to it
    assert.deepEqual(rel('trigger:dbo.trg_Member_Card_Audit', 'table:dbo.Member_Card'), ['reads', 'trigger-on']);
    assert.deepEqual(rel('trigger:dbo.trg_Member_Card_Audit', 'table:dbo.AuditLog'), ['writes']);
    assert.deepEqual(rel(agentJob.id, `jobstep:${agentJob.id.slice(4)}#1`), ['has-step']);
    // Phase B adds static-analysis edges (origin 'static'); server-only edges keep origin ['server']
    assert.ok(all.body.edges.every((e) => e.origin.length > 0 && e.origin.every((o) => o === 'server' || o === 'static')));
    assert.ok(all.body.edges.some((e) => e.origin.length === 1 && e.origin[0] === 'server'));

    const focus = await api<Graph>(srv.base, 'GET', `/api/connections/${id}/graph?focus=${encodeURIComponent('procedure:dbo.usp_Checkout')}&depth=2`);
    const fIds = focus.body.nodes.map((n) => n.id);
    assert.equal(fIds[0], 'procedure:dbo.usp_Checkout');
    assert.ok(fIds.includes('procedure:dbo.usp_PlaceOrder'), 'depth 1');
    assert.ok(fIds.includes('procedure:dbo.usp_WriteAudit'), 'depth 2');
    assert.ok(!fIds.includes('procedure:dbo.usp_NightlyBatch'), 'not within 2 hops');

    const kinds = await api<Graph>(srv.base, 'GET', `/api/connections/${id}/graph?focus=${encodeURIComponent('procedure:dbo.usp_Checkout')}&depth=3&kinds=procedure`);
    assert.ok(kinds.body.nodes.every((n) => n.kind === 'procedure'));
    assert.equal((await api(srv.base, 'GET', `/api/connections/${id}/graph?depth=9`)).status, 400);
    assert.equal((await api(srv.base, 'GET', `/api/connections/${id}/graph?kinds=bogus`)).status, 400);
    assert.equal((await api(srv.base, 'GET', `/api/connections/${id}/graph?focus=procedure:dbo.nope`)).status, 404);

    const cap = ctx.settings.graphNodeCap;
    ctx.settings.graphNodeCap = 5;
    try {
      const t = await api<Graph>(srv.base, 'GET', `/api/connections/${id}/graph`);
      assert.equal(t.body.truncated, true);
      assert.equal(t.body.nodes.length, 5);
      const kept = new Set(t.body.nodes.map((n) => n.id));
      assert.ok(t.body.edges.every((e) => kept.has(e.source) && kept.has(e.target)));
    } finally {
      ctx.settings.graphNodeCap = cap;
    }
  });
});
