import express, { type Request } from 'express';
import { z } from 'zod';
import type { AiEffort, ConnectionSummary, GraphNodeKind, ObjectKind, RunWarning } from '../../shared/types';
import { AI_EFFORTS } from '../ai/config';
import { INSIGHT_CATEGORY_IDS } from '../ai/schema';
import { computeInsights } from '../analysis/insights';
import { OBJECT_KINDS } from '../../shared/types';
import { CONNECTION_ID_RE, connectionInputSchema, refreshRequestSchema } from '../connections/schema';
import { toProfile, type StoredConnection } from '../connections/store';
import { testConnection } from '../db/testConnection';
import type { AppContext } from '../context';
import { buildGraph } from './graph';
import { HttpError } from './http';
import { ReadModel } from './readModel';

const GRAPH_KINDS: GraphNodeKind[] = ['procedure', 'table', 'view', 'function', 'trigger', 'job', 'jobstep', 'external', 'unknown'];

const objectsQuery = z.object({
  kind: z.enum(OBJECT_KINDS as [ObjectKind, ...ObjectKind[]]).optional(),
  q: z.string().max(200).optional(),
});
const refreshListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(20),
  before: z.string().min(1).max(100).optional(),
});
const graphQuery = z.object({
  focus: z.string().min(1).max(600).optional(),
  depth: z.coerce.number().int().min(1).max(4).default(2),
  kinds: z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (!v) return undefined;
      const parts = v.split(',').map((s) => s.trim()).filter(Boolean);
      for (const p of parts) {
        if (!GRAPH_KINDS.includes(p as GraphNodeKind)) {
          ctx.addIssue({ code: 'custom', message: `unknown kind "${p}"; expected ${GRAPH_KINDS.join(',')}` });
          return z.NEVER;
        }
      }
      return new Set(parts as GraphNodeKind[]);
    }),
});

const aiSettingsBody = z
  .object({
    apiKey: z.union([z.string().trim().min(1).max(500), z.null()]).optional(),
    model: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/, 'invalid model id')
      .optional(),
    effort: z.enum(AI_EFFORTS as [AiEffort, ...AiEffort[]]).optional(),
  })
  .strict();
const describeBody = z.object({ force: z.boolean().optional() }).strict();
/** non-empty, unique, known InsightCategoryIds */
const insightCategoryList = z
  .array(z.enum(INSIGHT_CATEGORY_IDS))
  .min(1)
  .refine((xs) => new Set(xs).size === xs.length, 'categories must be unique');
const analyzeInsightsBody = z.object({ categories: insightCategoryList, force: z.boolean().optional() }).strict();
const insightsAnalysisQuery = z.object({
  categories: z
    .string()
    .transform((v) => v.split(',').map((s) => s.trim()))
    .pipe(insightCategoryList),
});

export function apiRouter(ctx: AppContext): express.Router {
  const r = express.Router();

  const conn = (req: Request): StoredConnection => {
    const id = String(req.params.id);
    if (!CONNECTION_ID_RE.test(id)) throw new HttpError(404, `connection ${id} not found`);
    const c = ctx.connections.get(id);
    if (!c) throw new HttpError(404, `connection ${id} not found`);
    return c;
  };
  const query = { lockTimeoutMs: ctx.settings.lockTimeoutMs, timeoutMs: ctx.settings.requestTimeoutMs };

  r.get('/health', (_req, res) => {
    res.json({ ok: true, time: new Date().toISOString(), connections: ctx.connections.list().length });
  });

  /* ---------------------------------------------------------------- connections */

  r.get('/connections', (_req, res) => {
    res.json(ctx.connections.list());
  });

  r.post('/connections', (req, res) => {
    const input = connectionInputSchema.parse(req.body);
    if (input.auth.mode === 'sql' && !input.auth.password) throw new HttpError(400, 'password is required for sql auth');
    const created = ctx.connections.create(input);
    res.status(201).json(toProfile(created));
  });

  r.get('/connections/:id', (req, res) => {
    res.json(toProfile(conn(req)));
  });

  r.put('/connections/:id', async (req, res) => {
    const prev = conn(req);
    if (ctx.refresh.isActive(prev.id)) throw new HttpError(409, 'a refresh is running for this connection; try again when it finishes');
    const input = connectionInputSchema.parse(req.body);
    if (input.auth.mode === 'sql' && !input.auth.password && !(prev.auth.mode === 'sql' && prev.auth.password)) {
      throw new HttpError(400, 'password is required for sql auth');
    }
    const updated = ctx.connections.update(prev.id, input)!;
    const authChanged = JSON.stringify([prev.auth.mode, prev.auth.tenantId, prev.auth.clientId]) !== JSON.stringify([updated.auth.mode, updated.auth.tenantId, updated.auth.clientId]);
    await ctx.pools.close(prev.id, authChanged);
    // The cache describes one database; pointing the profile somewhere else invalidates it.
    const targetChanged =
      prev.target.server.toLowerCase() !== updated.target.server.toLowerCase() ||
      prev.target.database.toLowerCase() !== updated.target.database.toLowerCase() ||
      (prev.target.port ?? null) !== (updated.target.port ?? null);
    if (targetChanged) ctx.caches.remove(prev.id);
    res.json(toProfile(updated));
  });

  r.delete('/connections/:id', async (req, res) => {
    const c = conn(req);
    if (ctx.refresh.isActive(c.id)) throw new HttpError(409, 'a refresh is running for this connection; try again when it finishes');
    ctx.connections.delete(c.id);
    await ctx.pools.close(c.id, true);
    ctx.caches.remove(c.id);
    res.status(204).end();
  });

  r.post('/connections/:id/test', async (req, res) => {
    res.json(await testConnection(conn(req), ctx.pools, query));
  });

  r.get('/connections/:id/summary', (req, res) => {
    const c = conn(req);
    const store = ctx.caches.get(c.id);
    const lastRefresh = ctx.refresh.list(c.id, 1)[0] ?? null;
    const issues = store.getMeta<Record<string, { type: string; kind: string; schema: string; name: string; message: string }>>('dependency_issues') ?? {};
    const warnings = [...(lastRefresh?.warnings ?? [])];
    const warningDetails: RunWarning[] = [...(lastRefresh?.warningDetails ?? [])];
    for (const i of Object.values(issues)) {
      if (i.type !== 'stale') continue;
      const w = `Stale module (binding error, would fail to compile): ${i.schema}.${i.name}: ${i.message}`;
      if (!warnings.includes(w)) {
        warnings.push(w);
        warningDetails.push({ message: w, objects: [{ kind: i.kind as ObjectKind, schema: i.schema, name: i.name }] });
      }
    }
    const body: ConnectionSummary = {
      connection: toProfile(c),
      counts: store.countObjects(),
      lastRefresh,
      warnings,
      warningDetails,
      serverInfo: store.getMeta<Record<string, unknown>>('server_info'),
    };
    res.json(body);
  });

  /* ---------------------------------------------------------------- refresh */

  r.post('/connections/:id/refresh', (req, res) => {
    const c = conn(req);
    const request = refreshRequestSchema.parse(req.body ?? {});
    const run = ctx.refresh.start(c.id, request);
    res.status(202).json({ runId: run.id });
  });

  r.get('/connections/:id/refresh', (req, res) => {
    const c = conn(req);
    const q = refreshListQuery.parse(req.query);
    res.json(ctx.refresh.list(c.id, q.limit, q.before));
  });

  r.get('/connections/:id/refresh/:runId', (req, res) => {
    const c = conn(req);
    const run = ctx.refresh.get(c.id, String(req.params.runId));
    if (!run) throw new HttpError(404, `refresh run ${req.params.runId} not found`);
    res.json(run);
  });

  r.post('/connections/:id/refresh/:runId/cancel', (req, res) => {
    const c = conn(req);
    const run = ctx.refresh.cancel(c.id, String(req.params.runId));
    res.status(202).json({ runId: run.id });
  });

  /* ---------------------------------------------------------------- objects */

  r.get('/connections/:id/objects', (req, res) => {
    const c = conn(req);
    const q = objectsQuery.parse(req.query);
    res.json(new ReadModel(ctx.caches.get(c.id), c).summaries(q.kind, q.q));
  });

  r.get('/connections/:id/objects/:kind/:schema/:name', (req, res) => {
    const c = conn(req);
    const kind = z.enum(OBJECT_KINDS as [ObjectKind, ...ObjectKind[]]).parse(req.params.kind);
    const detail = new ReadModel(ctx.caches.get(c.id), c).detail(kind, String(req.params.schema), String(req.params.name));
    if (!detail) throw new HttpError(404, `${kind} ${req.params.schema}.${req.params.name} not found in the cache (refresh first?)`);
    res.json(detail);
  });

  /* ---------------------------------------------------------------- jobs */

  r.get('/connections/:id/jobs', (req, res) => {
    const c = conn(req);
    res.json(new ReadModel(ctx.caches.get(c.id), c).jobSummaries());
  });

  r.get('/connections/:id/jobs/:jobId', (req, res) => {
    const c = conn(req);
    const detail = new ReadModel(ctx.caches.get(c.id), c).jobDetail(String(req.params.jobId));
    if (!detail) throw new HttpError(404, `job ${req.params.jobId} not found in the cache`);
    res.json(detail);
  });

  /* ---------------------------------------------------------------- insights */

  r.get('/connections/:id/insights', (req, res) => {
    const c = conn(req);
    res.json(computeInsights(new ReadModel(ctx.caches.get(c.id), c)));
  });

  r.post('/connections/:id/insights/analyze', async (req, res) => {
    const c = conn(req);
    const body = analyzeInsightsBody.parse(req.body ?? {});
    const rm = new ReadModel(ctx.caches.get(c.id), c);
    res.json(await ctx.ai.analyzeInsights(c.id, rm, body.categories, body.force ?? false));
  });

  r.get('/connections/:id/insights/analysis', (req, res) => {
    const c = conn(req);
    const q = insightsAnalysisQuery.parse(req.query);
    res.json(ctx.ai.getInsightsAnalysis(new ReadModel(ctx.caches.get(c.id), c), q.categories));
  });

  /* ---------------------------------------------------------------- AI descriptions */

  r.get('/ai/status', (_req, res) => {
    res.json(ctx.ai.status());
  });

  r.put('/ai/settings', (req, res) => {
    res.json(ctx.ai.updateSettings(aiSettingsBody.parse(req.body ?? {})));
  });

  r.post('/connections/:id/objects/:kind/:schema/:name/describe', async (req, res) => {
    const c = conn(req);
    const kind = z.enum(OBJECT_KINDS as [ObjectKind, ...ObjectKind[]]).parse(req.params.kind);
    const body = describeBody.parse(req.body ?? {});
    const rm = new ReadModel(ctx.caches.get(c.id), c);
    res.json(await ctx.ai.describeObject(c.id, rm, kind, String(req.params.schema), String(req.params.name), body.force ?? false));
  });

  r.post('/connections/:id/jobs/:jobId/describe', async (req, res) => {
    const c = conn(req);
    const body = describeBody.parse(req.body ?? {});
    const rm = new ReadModel(ctx.caches.get(c.id), c);
    res.json(await ctx.ai.describeJob(c.id, rm, String(req.params.jobId), body.force ?? false));
  });

  /* ---------------------------------------------------------------- graph */

  r.get('/connections/:id/graph', (req, res) => {
    const c = conn(req);
    const q = graphQuery.parse(req.query);
    res.json(buildGraph(new ReadModel(ctx.caches.get(c.id), c), { focus: q.focus, depth: q.depth, kinds: q.kinds, cap: ctx.settings.graphNodeCap }));
  });

  r.use((req, _res, next) => next(new HttpError(404, `no route for ${req.method} /api${req.path}`)));
  return r;
}
