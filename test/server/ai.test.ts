/**
 * "Describe with AI" with a FAKE Anthropic client (no network, no Docker). The cache is filled directly with
 * synthetic objects / jobs, so nothing derived from real code is ever involved.
 */
import Anthropic from '@anthropic-ai/sdk';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { after, before, describe, it } from 'node:test';
import type { AiDescription, AiDescriptionContent, AiStatus, ApiError, JobDetail, ObjectDetail } from '../../shared/types';
import type { AiClientFactory } from '../../server/ai/client';
import { runAnalysis } from '../../server/analysis/runner';
import type { ConnectionInputParsed } from '../../server/connections/schema';
import type { ExtractedObject } from '../../server/extract/catalog';
import type { ExtractedJob } from '../../server/extract/jobTypes';
import { api, startServer, tempContext } from './helpers';

const CONTENT: AiDescriptionContent = {
  summary: 'Archives old rows.',
  purpose: 'Keeps the live table small.',
  steps: [{ lines: '3-4', title: 'Delete old rows', explanation: 'Deletes rows older than the cutoff.' }],
  dataAccess: [{ object: 'dbo.T', access: 'deletes', why: 'archiving' }],
  calls: [],
  risks: ['Unbounded DELETE (line 4)'],
  notes: [],
};

function message(text: string, stop_reason: string = 'end_turn', stop_details: unknown = null): Anthropic.Message {
  return {
    id: 'msg_fake',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content: [{ type: 'text', text, citations: null }],
    stop_reason,
    stop_sequence: null,
    stop_details,
    usage: { input_tokens: 1234, output_tokens: 567, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  } as unknown as Anthropic.Message;
}

class FakeAnthropic {
  calls: Array<{ apiKey: string | null; params: Anthropic.MessageStreamParams }> = [];
  next: () => Promise<Anthropic.Message> = async () => message(JSON.stringify(CONTENT));
  factory: AiClientFactory = (apiKey) => ({
    stream: (params) => {
      this.calls.push({ apiKey, params });
      return { finalMessage: () => this.next() };
    },
  });
}

const PROC_V1 = `CREATE PROCEDURE dbo.usp_Archive
AS
BEGIN
    DELETE t FROM dbo.T AS t WHERE t.CreatedAt < '2020-01-01';
    EXEC dbo.usp_Log;
END`;

function proc(name: string, objectId: number, definition: string, modifyDate = '2026-01-01T00:00:00.000Z'): ExtractedObject {
  return {
    objectId,
    kind: 'procedure',
    schema: 'dbo',
    name,
    typeCode: 'P',
    createDate: '2026-01-01T00:00:00.000Z',
    modifyDate,
    parentObjectId: 0,
    definition,
    isEncrypted: false,
    rowCount: null,
    details: { kind: 'procedure', parameters: [], module: { usesAnsiNulls: true, usesQuotedIdentifier: true, isSchemaBound: false, executeAs: null }, definitionStatus: 'ok' },
  };
}

const col = (ordinal: number, name: string, type: string) => ({
  ordinal, name, type, nullable: false, isIdentity: false, identitySeed: null, identityIncrement: null, isComputed: false,
  computedDefinition: null, isPersisted: false, defaultName: null, defaultDefinition: null, collation: null,
});

const TABLE: ExtractedObject = {
  objectId: 2001,
  kind: 'table',
  schema: 'dbo',
  name: 'T',
  typeCode: 'U',
  createDate: '2026-01-01T00:00:00.000Z',
  modifyDate: '2026-01-01T00:00:00.000Z',
  parentObjectId: 0,
  definition: null,
  isEncrypted: false,
  rowCount: 10,
  details: {
    kind: 'table', columns: [col(1, 'Id', 'bigint'), col(2, 'CreatedAt', 'datetime2(3)')], primaryKey: null, foreignKeys: [], indexes: [],
    checkConstraints: [], rowCount: 10, rowCountSource: 'sys.partitions', reservedKb: null, temporalType: null, isMemoryOptimized: false,
  },
};

function job(command: string): ExtractedJob {
  return {
    source: 'agent', jobId: 'AAAAAAAA-0000-4000-8000-000000000001', name: 'Synthetic - Nightly', description: 'synthetic test job', enabled: true,
    version: 1, category: 'test', owner: 'zz_owner_login', dateCreated: null, dateModified: null, lastRunOutcome: 'Succeeded', lastRunAt: null,
    nextRun: null, schedule: { intervalType: null, intervalCount: null, startTime: null, endTime: null }, scheduleText: 'Every day at 02:00',
    schedules: [{ name: 'nightly', enabled: true, text: 'Every day at 02:00', nextRun: null }],
    steps: [
      {
        stepId: 1, name: 'Run archive', commandType: 'TSQL', commandSource: 'Inline', command, credentialName: null, targetGroupId: null,
        targetGroupName: null, targetMembers: [], retryAttempts: 0, stepTimeoutSeconds: null, maxParallelism: null, subsystem: 'TSQL',
        databaseName: 'AuditDemo', onSuccess: 'Quit reporting success', onFail: 'Quit reporting failure', retryIntervalMinutes: 0,
        outputFileName: '/var/opt/secret/output.txt', analyzable: true, initialRetryIntervalSeconds: null, maximumRetryIntervalSeconds: null,
        retryIntervalBackoffMultiplier: null, output: null,
      },
    ],
  };
}

const KEY = 'sk-ant-fake-KEY-0123456789';
const HOST = 'sql-test-host.invalid';

describe('AI describe (fake Anthropic client)', () => {
  const fake = new FakeAnthropic();
  const ctx = tempContext({ aiClientFactory: fake.factory, aiEnv: {} });
  let srv: Awaited<ReturnType<typeof startServer>>;
  let id = '';
  const describeUrl = () => `/api/connections/${id}/objects/procedure/dbo/usp_Archive/describe`;

  before(async () => {
    srv = await startServer(ctx);
    // never connected: the cache is filled directly
    id = ctx.connections.create({
      name: 'synthetic', target: { server: HOST, database: 'AuditDemo' }, jobs: null, jobsSource: 'none',
      auth: { mode: 'sql', user: 'zz_login_name', password: 'zz-password' }, options: { encrypt: true, trustServerCertificate: false, readOnlyIntent: false },
    } as ConnectionInputParsed).id;
    const store = ctx.caches.get(id);
    store.applyObjectSegment('table', [TABLE], []);
    store.applyObjectSegment('procedure', [proc('usp_Archive', 1001, PROC_V1), proc('usp_Log', 1002, 'CREATE PROCEDURE dbo.usp_Log AS SELECT 1 AS x')], []);
    store.applyJobs('agent', [job('EXEC dbo.usp_Archive;')], []);
    runAnalysis(store, 'AuditDemo', { force: false });
  });
  after(async () => {
    await srv.close();
    await ctx.cleanup();
  });

  it('GET /api/ai/status: defaults, nothing configured', async () => {
    const s = await api<AiStatus>(srv.base, 'GET', '/api/ai/status');
    assert.deepEqual(s.body, { configured: false, keySource: null, model: 'claude-opus-5-5', effort: 'medium' });
  });

  it('PUT /api/ai/settings: key stored 0600, never returned; other settings preserved; null clears', async () => {
    const bad = await api<ApiError>(srv.base, 'PUT', '/api/ai/settings', { apiKey: '' });
    assert.equal(bad.status, 400);
    assert.equal((await api(srv.base, 'PUT', '/api/ai/settings', { effort: 'max' })).status, 400);
    assert.equal((await api(srv.base, 'PUT', '/api/ai/settings', { bogus: 1 })).status, 400);

    const r = await api<AiStatus>(srv.base, 'PUT', '/api/ai/settings', { apiKey: KEY, effort: 'high' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { configured: true, keySource: 'settings', model: 'claude-opus-5-5', effort: 'high' });
    assert.ok(!r.text.includes(KEY));
    assert.ok(!(await api(srv.base, 'GET', '/api/ai/status')).text.includes(KEY));
    const file = ctx.paths.settingsFile;
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    assert.equal(raw.apiKey, KEY);
    assert.equal(raw.aiEffort, 'high');
    assert.equal(raw.dependencyConcurrency, 4, 'numeric tunables are preserved');

    const cleared = await api<AiStatus>(srv.base, 'PUT', '/api/ai/settings', { apiKey: null });
    assert.deepEqual(cleared.body, { configured: false, keySource: null, model: 'claude-opus-5-5', effort: 'high' });
    assert.equal((JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>).apiKey, undefined);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    // restore for the following tests
    await api(srv.base, 'PUT', '/api/ai/settings', { apiKey: KEY });
  });

  it('describe: request shape (model, effort, structured output, no thinking/temperature/prefill), prompt content, cache hit', async () => {
    const r = await api<AiDescription>(srv.base, 'POST', describeUrl(), {});
    assert.equal(r.status, 200, r.text);
    assert.equal(fake.calls.length, 1);
    const { apiKey, params } = fake.calls[0]!;
    assert.equal(apiKey, KEY);
    assert.equal(params.model, 'claude-opus-5-5');
    assert.equal(params.max_tokens, 32000);
    assert.equal(params.output_config?.effort, 'high');
    assert.equal(params.output_config?.format?.type, 'json_schema');
    assert.deepEqual((params.output_config?.format?.schema as { required: string[] }).required, ['summary', 'purpose', 'steps', 'dataAccess', 'calls', 'risks', 'notes']);
    assert.equal('thinking' in params, false);
    assert.equal('temperature' in params, false);
    assert.equal(params.messages.length, 1);
    assert.equal(params.messages[0]!.role, 'user');
    const prompt = params.messages[0]!.content as string;
    assert.match(prompt, /^Object: stored procedure dbo\.usp_Archive/);
    assert.match(prompt, /\n4 \|     DELETE t FROM dbo\.T AS t/);
    assert.match(prompt, /- dbo\.T: DELETE \(line 4; local table\)/);
    assert.match(prompt, /- dbo\.T \(table\): Id bigint, CreatedAt datetime2\(3\)/);
    assert.match(prompt, /- dbo\.usp_Log \(line 5; local procedure\)/);
    for (const secret of [HOST, 'zz_login_name', 'zz-password', KEY]) assert.ok(!prompt.includes(secret), `prompt contains ${secret}`);
    assert.match(String(params.system), /senior SQL Server DBA/);

    assert.deepEqual(r.body.content, CONTENT);
    assert.deepEqual(r.body.usage, { inputTokens: 1234, outputTokens: 567 });
    assert.equal(r.body.stale, false);
    assert.equal(r.body.effort, 'high');
    assert.equal(r.body.promptVersion, 'v1');
    assert.equal(r.body.definitionSha256.length, 64);

    const again = await api<AiDescription>(srv.base, 'POST', describeUrl());
    assert.equal(again.status, 200);
    assert.equal(fake.calls.length, 1, 'cache hit: no second API call');
    assert.equal(again.body.createdAt, r.body.createdAt);
    const d = await api<ObjectDetail>(srv.base, 'GET', `/api/connections/${id}/objects/procedure/dbo/usp_Archive`);
    assert.deepEqual(d.body.ai?.content, CONTENT);
    assert.equal(d.body.ai?.stale, false);
    assert.ok(!d.text.includes(KEY));
  });

  it('stale after a definition change; cached (stale) returned without force; force regenerates', async () => {
    const store = ctx.caches.get(id);
    store.applyObjectSegment('procedure', [proc('usp_Archive', 1001, PROC_V1.replace("'2020-01-01'", "'2021-01-01'"), '2026-02-01T00:00:00.000Z')], []);
    const d = await api<ObjectDetail>(srv.base, 'GET', `/api/connections/${id}/objects/procedure/dbo/usp_Archive`);
    assert.equal(d.body.ai?.stale, true);
    const cached = await api<AiDescription>(srv.base, 'POST', describeUrl(), { force: false });
    assert.equal(cached.body.stale, true);
    assert.equal(fake.calls.length, 1);
    fake.next = async () => message(JSON.stringify({ ...CONTENT, summary: 'Archives rows older than 2021.' }));
    const fresh = await api<AiDescription>(srv.base, 'POST', describeUrl(), { force: true });
    assert.equal(fresh.status, 200, fresh.text);
    assert.equal(fake.calls.length, 2);
    assert.equal(fresh.body.stale, false);
    assert.equal(fresh.body.content.summary, 'Archives rows older than 2021.');
    assert.equal((await api<ObjectDetail>(srv.base, 'GET', `/api/connections/${id}/objects/procedure/dbo/usp_Archive`)).body.ai?.stale, false);
  });

  it('refusal -> 422 with stop_details; invalid JSON / schema mismatch / max_tokens -> 502', async () => {
    fake.next = async () => message('', 'refusal', { type: 'refusal', category: 'cyber', explanation: 'synthetic refusal' });
    const ref = await api<ApiError>(srv.base, 'POST', describeUrl(), { force: true });
    assert.equal(ref.status, 422);
    assert.deepEqual(ref.body.details, { category: 'cyber', explanation: 'synthetic refusal' });

    fake.next = async () => message('{"summary": "unterminated');
    const inv = await api<ApiError>(srv.base, 'POST', describeUrl(), { force: true });
    assert.equal(inv.status, 502);
    assert.match(inv.body.error, /invalid JSON/);

    fake.next = async () => message(JSON.stringify({ summary: 'x' }));
    const shape = await api<ApiError>(srv.base, 'POST', describeUrl(), { force: true });
    assert.equal(shape.status, 502);
    assert.match(shape.body.error, /does not match the description schema/);

    fake.next = async () => message('{"summary":', 'max_tokens');
    const trunc = await api<ApiError>(srv.base, 'POST', describeUrl(), { force: true });
    assert.equal(trunc.status, 502);
    assert.match(trunc.body.error, /description truncated/);
    // failures never overwrite the cached description
    assert.equal((await api<AiDescription>(srv.base, 'POST', describeUrl())).body.content.summary, 'Archives rows older than 2021.');
  });

  it('typed error chain: missing / invalid credentials -> 400, 429 -> 429 + Retry-After, 5xx / connection -> 502', async () => {
    const cases: Array<[() => Error, number, RegExp]> = [
      [() => new Anthropic.AuthenticationError(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, 'invalid x-api-key', new Headers()), 400, /credentials missing\/invalid/],
      [() => new Error('Could not resolve authentication method. Expected one of apiKey, authToken, credentials, config, or profile to be set.'), 400, /credentials missing\/invalid/],
      [() => new Anthropic.RateLimitError(429, { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, 'slow down', new Headers({ 'retry-after': '17' })), 429, /rate limit/],
      [() => new Anthropic.InternalServerError(529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, 'Overloaded', new Headers()), 502, /Anthropic API error 529/],
      [() => new Anthropic.APIConnectionError({ message: 'Connection error.' }), 502, /could not reach the Anthropic API/],
    ];
    for (const [mk, status, re] of cases) {
      fake.next = async () => {
        throw mk();
      };
      const r = await api<ApiError>(srv.base, 'POST', describeUrl(), { force: true });
      assert.equal(r.status, status, r.text);
      assert.match(r.body.error, re);
      assert.ok(!r.text.includes(KEY));
      if (status === 429) {
        const raw = await fetch(srv.base + describeUrl(), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"force":true}' });
        assert.equal(raw.headers.get('retry-after'), '17');
        await raw.text();
      }
    }
  });

  it('concurrent describes of one object share ONE in-flight request', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    fake.next = async () => {
      await gate;
      return message(JSON.stringify({ ...CONTENT, summary: 'concurrent' }));
    };
    const before = fake.calls.length;
    const a = api<AiDescription>(srv.base, 'POST', describeUrl(), { force: true });
    const b = api<AiDescription>(srv.base, 'POST', describeUrl(), { force: true });
    await new Promise((r) => setTimeout(r, 100));
    release();
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(ra.status, 200);
    assert.equal(rb.status, 200);
    assert.equal(fake.calls.length - before, 1, 'second caller awaited the first request');
    assert.deepEqual(ra.body, rb.body);
  });

  it('job describe: steps numbered, flow + schedules, called procs summarised; no owner / output path; stale on step change', async () => {
    fake.next = async () => message(JSON.stringify({ ...CONTENT, steps: [{ lines: 'Step 1', title: 'Archive', explanation: 'Runs dbo.usp_Archive.' }] }));
    const jobId = 'AAAAAAAA-0000-4000-8000-000000000001';
    const r = await api<AiDescription>(srv.base, 'POST', `/api/connections/${id}/jobs/${jobId.toLowerCase()}/describe`, {});
    assert.equal(r.status, 200, r.text);
    const prompt = fake.calls.at(-1)!.params.messages[0]!.content as string;
    assert.match(prompt, /^Object: SQL Server Agent job "Synthetic - Nightly"/);
    assert.match(prompt, /- "nightly" \(enabled\): Every day at 02:00/);
    assert.match(prompt, /### Step 1: Run archive\nsubsystem TSQL; runs in database AuditDemo; on success: Quit reporting success; on failure: Quit reporting failure/);
    assert.match(prompt, /1 \| EXEC dbo\.usp_Archive;/);
    assert.match(prompt, /### dbo\.usp_Archive\nSummary \(earlier AI description\): concurrent/);
    for (const secret of [HOST, 'zz_owner_login', '/var/opt/secret', KEY]) assert.ok(!prompt.includes(secret), `prompt contains ${secret}`);
    const d = await api<JobDetail>(srv.base, 'GET', `/api/connections/${id}/jobs/${jobId}`);
    assert.equal(d.body.ai?.stale, false);
    assert.equal(d.body.steps[0]!.analysis?.resolved['dbo.usp_archive']?.nodeId, 'procedure:dbo.usp_Archive');
    ctx.caches.get(id).applyJobs('agent', [job('EXEC dbo.usp_Archive; EXEC dbo.usp_Log;')], []);
    assert.equal((await api<JobDetail>(srv.base, 'GET', `/api/connections/${id}/jobs/${jobId}`)).body.ai?.stale, true);
  });

  it('nothing to describe -> 400 / 404; DB_AUDIT_AI=off -> not configured and 400', async () => {
    const t = await api<ApiError>(srv.base, 'POST', `/api/connections/${id}/objects/table/dbo/T/describe`, {});
    assert.equal(t.status, 400);
    assert.match(t.body.error, /no definition/);
    assert.equal((await api(srv.base, 'POST', `/api/connections/${id}/objects/procedure/dbo/nope/describe`, {})).status, 404);
    assert.equal((await api(srv.base, 'POST', `/api/connections/${id}/jobs/00000000-0000-0000-0000-000000000000/describe`, {})).status, 404);
    assert.equal((await api(srv.base, 'POST', describeUrl(), { force: 'yes' })).status, 400);

    const off = tempContext({ aiClientFactory: fake.factory, aiEnv: { DB_AUDIT_AI: 'off', ANTHROPIC_API_KEY: 'sk-env-x' } });
    const on = tempContext({ aiClientFactory: fake.factory, aiEnv: { ANTHROPIC_API_KEY: 'sk-env-x' } });
    try {
      assert.deepEqual(off.ai.status(), { configured: false, keySource: null, model: 'claude-opus-5-5', effort: 'medium' });
      assert.deepEqual(on.ai.status(), { configured: true, keySource: 'env', model: 'claude-opus-5-5', effort: 'medium' });
      const cid = off.connections.create({
        name: 'off', target: { server: HOST, database: 'AuditDemo' }, jobs: null, jobsSource: 'none',
        auth: { mode: 'sql', user: 'u', password: 'p' }, options: { encrypt: true, trustServerCertificate: false, readOnlyIntent: false },
      } as ConnectionInputParsed).id;
      off.caches.get(cid).applyObjectSegment('procedure', [proc('usp_Archive', 1001, PROC_V1)], []);
      const { ReadModel } = await import('../../server/api/readModel');
      await assert.rejects(off.ai.describeObject(cid, new ReadModel(off.caches.get(cid), off.connections.get(cid)!), 'procedure', 'dbo', 'usp_Archive', false), /turned off/);
    } finally {
      await off.cleanup();
      await on.cleanup();
    }
  });
});
