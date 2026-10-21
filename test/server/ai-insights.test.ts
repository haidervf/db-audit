/**
 * "Analyze insights with AI" with a FAKE Anthropic client (no network, no Docker). The cache is filled directly
 * with synthetic objects; the analyzer runs on them so code-risk insights have items.
 */
import Anthropic from '@anthropic-ai/sdk';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { AiInsightsAnalysis, AiInsightsContent, ApiError, Insight } from '../../shared/types';
import type { AiClientFactory } from '../../server/ai/client';
import { buildInsightsPrompt, MAX_PROMPT_CHARS, type InsightsSelection } from '../../server/ai/insightsPrompt';
import { runAnalysis } from '../../server/analysis/runner';
import { ReadModel } from '../../server/api/readModel';
import type { ConnectionInputParsed } from '../../server/connections/schema';
import type { ExtractedObject } from '../../server/extract/catalog';
import { api, startServer, tempContext } from './helpers';

function message(text: string, stop_reason: string = 'end_turn'): Anthropic.Message {
  return {
    id: 'msg_fake', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text, citations: null }],
    stop_reason, stop_sequence: null, stop_details: null,
    usage: { input_tokens: 2000, output_tokens: 300, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
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

/** valid + hallucinated references mixed; the guard keeps only what was in the input */
const CONTENT: AiInsightsContent = {
  summary: 'Dynamic SQL and cursors dominate the code risk.',
  findings: [
    {
      title: 'String-built dynamic SQL',
      severity: 'high',
      category: 'code-risk',
      insightIds: ['dynamic-sql', 'orphan-procedures', 'made-up-insight'],
      explanation: 'usp_Dyn executes a string.',
      objects: [
        { kind: 'procedure', schema: 'DBO', name: 'usp_dyn' }, // case differs: kept, canonicalized
        { kind: 'procedure', schema: 'dbo', name: 'usp_Invented' }, // not in the cache
        { kind: 'table', schema: 'dbo', name: 'Orphan' }, // in the cache but not in the selected items
      ],
      recommendation: 'Parameterize with sp_executesql.',
    },
    { title: 'Cursor', severity: 'medium', category: 'usage', insightIds: ['cursors'], explanation: 'x', objects: [], recommendation: 'set-based' },
    { title: 'Orphans', severity: 'low', category: 'usage', insightIds: ['orphan-procedures'], explanation: 'x', objects: [], recommendation: 'verify' },
  ],
  quickWins: ['Add TRY/CATCH around dbo.usp_Tx.'],
  notes: [],
};

const MARKER = 'ZZ_DEFINITION_MARKER_7731';
function proc(name: string, objectId: number, definition: string, modifyDate = '2026-01-01T00:00:00.000Z'): ExtractedObject {
  return {
    objectId, kind: 'procedure', schema: 'dbo', name, typeCode: 'P', createDate: '2026-01-01T00:00:00.000Z', modifyDate, parentObjectId: 0, definition,
    isEncrypted: false, rowCount: null,
    details: { kind: 'procedure', parameters: [], module: { usesAnsiNulls: true, usesQuotedIdentifier: true, isSchemaBound: false, executeAs: null }, definitionStatus: 'ok' },
  };
}
function table(name: string, objectId: number): ExtractedObject {
  return {
    objectId, kind: 'table', schema: 'dbo', name, typeCode: 'U', createDate: '2026-01-01T00:00:00.000Z', modifyDate: '2026-01-01T00:00:00.000Z',
    parentObjectId: 0, definition: null, isEncrypted: false, rowCount: 10,
    details: { kind: 'table', columns: [], primaryKey: null, foreignKeys: [], indexes: [], checkConstraints: [], rowCount: 10, rowCountSource: 'sys.partitions', reservedKb: null, temporalType: null, isMemoryOptimized: false },
  };
}
const DYN = `CREATE PROCEDURE dbo.usp_Dyn @t sysname
AS
BEGIN
    DECLARE @sql nvarchar(max) = N'SELECT ''${MARKER}'' FROM ' + @t;
    EXEC (@sql);
END`;
const CUR_V1 = `CREATE PROCEDURE dbo.usp_Cur
AS
BEGIN
    DECLARE c CURSOR FOR SELECT Id FROM dbo.T;
    OPEN c; CLOSE c; DEALLOCATE c;
END`;
const TX = `CREATE PROCEDURE dbo.usp_Tx
AS
BEGIN TRANSACTION;
UPDATE dbo.T SET Id = Id WHERE 1 = 0;
COMMIT;`;

const KEY = 'sk-ant-fake-KEY-insights';
const HOST = 'sql-insights-host.invalid';

describe('AI insights analysis (fake Anthropic client)', () => {
  const fake = new FakeAnthropic();
  const ctx = tempContext({ aiClientFactory: fake.factory, aiEnv: { ANTHROPIC_API_KEY: KEY } });
  let srv: Awaited<ReturnType<typeof startServer>>;
  let id = '';
  const analyzeUrl = () => `/api/connections/${id}/insights/analyze`;
  const analysisUrl = (cats: string) => `/api/connections/${id}/insights/analysis?categories=${cats}`;
  const lastPrompt = () => fake.calls.at(-1)!.params.messages[0]!.content as string;

  before(async () => {
    srv = await startServer(ctx);
    id = ctx.connections.create({
      name: 'synthetic', target: { server: HOST, database: 'AuditDemo' }, jobs: null, jobsSource: 'none',
      auth: { mode: 'sql', user: 'zz_login_name', password: 'zz-password' }, options: { encrypt: true, trustServerCertificate: false, readOnlyIntent: false },
    } as ConnectionInputParsed).id;
    const store = ctx.caches.get(id);
    store.applyObjectSegment('table', [table('T', 2001), table('Orphan', 2002)], []);
    store.applyObjectSegment('procedure', [proc('usp_Dyn', 1001, DYN), proc('usp_Cur', 1002, CUR_V1), proc('usp_Tx', 1003, TX)], []);
    store.setMeta('server_info', { serverName: HOST, loginName: 'zz_login_name', engineEdition: 5, engineEditionLabel: 'Azure SQL Database', compatibilityLevel: 160 });
    runAnalysis(store, 'AuditDemo', { force: false });
  });
  after(async () => {
    await srv.close();
    await ctx.cleanup();
  });

  it('GET analysis: 200 null before any run; 404 unknown connection for both routes', async () => {
    const r = await fetch(srv.base + analysisUrl('code-risk,dependency-health'));
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') ?? '', /^application\/json/);
    assert.equal(await r.text(), 'null');
    assert.equal((await api(srv.base, 'GET', '/api/connections/zzzzzzzz/insights/analysis?categories=usage')).status, 404);
    assert.equal((await api(srv.base, 'POST', '/api/connections/zzzzzzzz/insights/analyze', { categories: ['usage'] })).status, 404);
    assert.equal(fake.calls.length, 0);
  });

  it('validation: 400 for empty, unknown, duplicate or extra input', async () => {
    for (const body of [{}, { categories: [] }, { categories: ['bogus'] }, { categories: ['usage', 'usage'] }, { categories: ['usage'], extra: 1 }, { categories: ['usage'], force: 'yes' }, { categories: 'usage' }]) {
      const r = await api<ApiError>(srv.base, 'POST', analyzeUrl(), body);
      assert.equal(r.status, 400, `${JSON.stringify(body)}: ${r.text}`);
    }
    for (const q of ['', '?categories=', '?categories=usage,bogus', '?categories=usage,usage']) {
      const r = await api(srv.base, 'GET', `/api/connections/${id}/insights/analysis${q}`);
      assert.equal(r.status, 400, `${q}: ${r.text}`);
    }
    assert.equal(fake.calls.length, 0);
  });

  it('POST analyze: request shape, selected insights only, no definition text, hallucinations dropped', async () => {
    const r = await api<AiInsightsAnalysis>(srv.base, 'POST', analyzeUrl(), { categories: ['dependency-health', 'code-risk'] });
    assert.equal(r.status, 200, r.text);
    assert.equal(fake.calls.length, 1);
    const { apiKey, params } = fake.calls[0]!;
    assert.equal(apiKey, KEY);
    assert.equal(params.model, 'claude-opus-5-5');
    assert.equal(params.max_tokens, 32000);
    assert.equal(params.output_config?.format?.type, 'json_schema');
    assert.deepEqual((params.output_config?.format?.schema as { required: string[] }).required, ['summary', 'findings', 'quickWins', 'notes']);
    assert.match(String(params.system), /senior SQL Server \/ Azure SQL Database DBA/);
    assert.match(String(params.system), /category" must be one of the selected categories/);

    const prompt = lastPrompt();
    for (const sel of ['dynamic-sql', 'cursors', 'transactions-without-try-catch', 'unresolved-references', 'missing-references']) {
      assert.ok(prompt.includes(`## Insight ${sel}\n`), `selected insight ${sel} missing`);
    }
    for (const unsel of ['orphan-procedures', 'unreferenced-tables', 'tables-without-primary-key', 'largest-tables', 'failing-jobs']) {
      assert.ok(!prompt.includes(`## Insight ${unsel}\n`), `unselected insight ${unsel} sent`);
    }
    assert.match(prompt, /- procedure dbo\.usp_Dyn: /);
    assert.match(prompt, /- Engine edition: Azure SQL Database\n- Compatibility level: 160/);
    assert.match(prompt, /- procedure dbo\.usp_Cur \(.*cursors 1/);
    // facts, no code: no definition text, no connection details
    for (const code of [MARKER, 'EXEC (@sql)', 'DECLARE c CURSOR', 'CREATE PROCEDURE', 'UPDATE dbo.T SET', 'OPEN c']) assert.ok(!prompt.includes(code), `prompt contains code: ${code}`);
    for (const secret of [HOST, 'zz_login_name', 'zz-password', KEY]) assert.ok(!prompt.includes(secret), `prompt contains ${secret}`);

    assert.deepEqual(r.body.categories, ['code-risk', 'dependency-health']);
    assert.equal(r.body.promptVersion, 'insights-v1');
    assert.equal(r.body.stale, false);
    assert.match(r.body.definitionSha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(r.body.usage, { inputTokens: 2000, outputTokens: 300 });
    const f = r.body.content.findings;
    assert.equal(f.length, 2, 'the usage finding about orphan-procedures is dropped');
    assert.deepEqual(f[0]!.objects, [{ kind: 'procedure', schema: 'dbo', name: 'usp_Dyn' }]);
    assert.deepEqual(f[0]!.insightIds, ['dynamic-sql']);
    assert.equal(f[1]!.title, 'Cursor');
    assert.equal(f[1]!.category, 'code-risk', 'usage finding drawing on cursors moved to its selected category');
  });

  it('GET analysis returns the cached result (order-insensitive); another set is 200 null', async () => {
    const r = await api<AiInsightsAnalysis>(srv.base, 'GET', analysisUrl('dependency-health,code-risk'));
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.body.categories, ['code-risk', 'dependency-health']);
    assert.equal(r.body.stale, false);
    assert.equal(r.body.content.findings.length, 2);
    const other = await api(srv.base, 'GET', analysisUrl('code-risk'));
    assert.equal(other.status, 200, other.text);
    assert.equal(other.body, null);
    assert.equal(fake.calls.length, 1);
  });

  it('cache: POST without force returns the cached row without a model call; force regenerates', async () => {
    const cached = await api<AiInsightsAnalysis>(srv.base, 'POST', analyzeUrl(), { categories: ['code-risk', 'dependency-health'], force: false });
    assert.equal(cached.status, 200);
    assert.equal(fake.calls.length, 1, 'cache hit: no second API call');
    fake.next = async () => message(JSON.stringify({ ...CONTENT, summary: 'regenerated' }));
    const fresh = await api<AiInsightsAnalysis>(srv.base, 'POST', analyzeUrl(), { categories: ['code-risk', 'dependency-health'], force: true });
    assert.equal(fresh.status, 200, fresh.text);
    assert.equal(fake.calls.length, 2);
    assert.equal(fresh.body.content.summary, 'regenerated');
    assert.notEqual(fresh.body.createdAt, cached.body.createdAt);
  });

  it('stale: not on an unselected category change; yes on a selected insight change; cached stale returned without force', async () => {
    const store = ctx.caches.get(id);
    // a new heap table: usage + schema-health change, code-risk / dependency-health do not
    store.applyObjectSegment('table', [table('NewHeap', 2003)], []);
    const unsel = await api<AiInsightsAnalysis>(srv.base, 'GET', analysisUrl('code-risk,dependency-health'));
    assert.equal(unsel.body.stale, false);
    // usp_Cur loses its cursor: the code-risk 'cursors' insight changes
    store.applyObjectSegment('procedure', [proc('usp_Cur', 1002, 'CREATE PROCEDURE dbo.usp_Cur AS SELECT Id FROM dbo.T;', '2026-02-01T00:00:00.000Z')], []);
    runAnalysis(store, 'AuditDemo', { force: false });
    const sel = await api<AiInsightsAnalysis>(srv.base, 'GET', analysisUrl('code-risk,dependency-health'));
    assert.equal(sel.body.stale, true);
    const calls = fake.calls.length;
    const cached = await api<AiInsightsAnalysis>(srv.base, 'POST', analyzeUrl(), { categories: ['dependency-health', 'code-risk'] });
    assert.equal(cached.body.stale, true);
    assert.equal(fake.calls.length, calls);
    const fresh = await api<AiInsightsAnalysis>(srv.base, 'POST', analyzeUrl(), { categories: ['dependency-health', 'code-risk'], force: true });
    assert.equal(fresh.body.stale, false);
    assert.equal(fake.calls.length, calls + 1);
  });

  it('errors use mapAiError (429 + Retry-After, refusal 422, schema mismatch 502); failures keep the cached row', async () => {
    fake.next = async () => {
      throw new Anthropic.RateLimitError(429, { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, 'slow down', new Headers({ 'retry-after': '9' }));
    };
    const raw = await fetch(srv.base + analyzeUrl(), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"categories":["code-risk","dependency-health"],"force":true}' });
    assert.equal(raw.status, 429);
    assert.equal(raw.headers.get('retry-after'), '9');
    await raw.text();
    fake.next = async () => message('', 'refusal');
    const ref = await api<ApiError>(srv.base, 'POST', analyzeUrl(), { categories: ['code-risk', 'dependency-health'], force: true });
    assert.equal(ref.status, 422);
    assert.match(ref.body.error, /declined to analyze these insights/);
    fake.next = async () => message(JSON.stringify({ summary: 'x', findings: [{ title: 't' }], quickWins: [], notes: [] }));
    const bad = await api<ApiError>(srv.base, 'POST', analyzeUrl(), { categories: ['code-risk', 'dependency-health'], force: true });
    assert.equal(bad.status, 502);
    assert.match(bad.body.error, /does not match the insights analysis schema/);
    const still = await api<AiInsightsAnalysis>(srv.base, 'GET', analysisUrl('code-risk,dependency-health'));
    assert.equal(still.status, 200);
    assert.equal(still.body.stale, false);
  });

  it('size guard: items per insight are cut (totals kept) when the prompt exceeds MAX_PROMPT_CHARS', () => {
    const rm = new ReadModel(ctx.caches.get(id), ctx.connections.get(id)!);
    const insights: Insight[] = Array.from({ length: 25 }, (_, n) => ({
      id: `big-${n}`, category: 'code-risk', title: `Big ${n}`, description: 'd', severity: 'low', total: 500, available: true,
      items: Array.from({ length: 500 }, (_, k) => ({ label: `item ${k}`, detail: 'x'.repeat(400), value: k })),
    }));
    const sel: InsightsSelection = { categories: ['code-risk'], insights };
    const p = buildInsightsPrompt(rm, sel);
    assert.ok(p.prompt.length <= MAX_PROMPT_CHARS, String(p.prompt.length));
    assert.ok(p.itemsPerInsight < 40);
    assert.match(p.prompt, /to fit the size limit, at most \d+ items per insight are listed; totals are complete/);
    assert.match(p.prompt, /Total: 500 \(first \d+ listed\)/);
  });

  it('DB_AUDIT_AI=off -> analyze rejected like describe', async () => {
    const off = tempContext({ aiClientFactory: fake.factory, aiEnv: { DB_AUDIT_AI: 'off', ANTHROPIC_API_KEY: 'sk-env-x' } });
    try {
      const cid = off.connections.create({
        name: 'off', target: { server: HOST, database: 'AuditDemo' }, jobs: null, jobsSource: 'none',
        auth: { mode: 'sql', user: 'u', password: 'p' }, options: { encrypt: true, trustServerCertificate: false, readOnlyIntent: false },
      } as ConnectionInputParsed).id;
      const rm = new ReadModel(off.caches.get(cid), off.connections.get(cid)!);
      const calls = fake.calls.length;
      await assert.rejects(off.ai.analyzeInsights(cid, rm, ['usage'], false), /turned off/);
      assert.equal(fake.calls.length, calls);
    } finally {
      await off.cleanup();
    }
  });
});
