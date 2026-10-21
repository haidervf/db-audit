import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { api, enc, isApiError } from './client';
import type {
  AiDescription,
  AiInsightsAnalysis,
  AiSettingsInput,
  AiStatus,
  ConnectionInput,
  ConnectionProfile,
  ConnectionSummary,
  ConnectionTestResult,
  Graph,
  InsightCategoryId,
  InsightsReport,
  JobDetailView,
  JobSummary,
  ObjectDetailView,
  ObjectKind,
  ObjectSummaryView,
  RefreshRequest,
  RefreshRun,
} from './types';

export const qk = {
  connections: ['connections'] as const,
  conn: (id: string) => ['conn', id] as const,
  summary: (id: string) => ['conn', id, 'summary'] as const,
  objects: (id: string) => ['conn', id, 'objects'] as const,
  object: (id: string, kind: ObjectKind, schema: string, name: string) => ['conn', id, 'object', kind, schema, name] as const,
  jobs: (id: string) => ['conn', id, 'jobs'] as const,
  job: (id: string, jobId: string) => ['conn', id, 'job', jobId] as const,
  graph: (id: string, focus: string | null, depth: number, kinds: string) => ['conn', id, 'graph', focus, depth, kinds] as const,
  runs: (id: string) => ['conn', id, 'runs'] as const,
  /** under qk.runs so every invalidation of the runs list also refetches the history */
  runHistory: (id: string) => ['conn', id, 'runs', 'history'] as const,
  run: (id: string, runId: string) => ['conn', id, 'run', runId] as const,
  /** under qk.conn, so invalidateConnectionData (after a refresh) refetches the insights and the analysis staleness */
  insights: (id: string) => ['conn', id, 'insights'] as const,
  /** `categories`: comma-joined, in report order */
  insightsAnalysis: (id: string, categories: string) => ['conn', id, 'insights', 'analysis', categories] as const,
  aiStatus: ['ai-status'] as const,
};

export function useConnections() {
  return useQuery({ queryKey: qk.connections, queryFn: () => api<ConnectionProfile[]>('/connections') });
}

export function useSummary(connId: string | undefined) {
  return useQuery({
    queryKey: qk.summary(connId ?? '-'),
    queryFn: () => api<ConnectionSummary>(`/connections/${enc(connId!)}/summary`),
    enabled: Boolean(connId),
  });
}

/** All objects of the connection (one request; pages filter by kind client-side). */
export function useObjects(connId: string | undefined) {
  return useQuery({
    queryKey: qk.objects(connId ?? '-'),
    queryFn: () => api<ObjectSummaryView[]>(`/connections/${enc(connId!)}/objects`),
    enabled: Boolean(connId),
  });
}

export function useObjectDetail(connId: string, kind: ObjectKind, schema: string, name: string) {
  return useQuery({
    queryKey: qk.object(connId, kind, schema, name),
    queryFn: () => api<ObjectDetailView>(`/connections/${enc(connId)}/objects/${kind}/${enc(schema)}/${enc(name)}`),
    retry: (count, e) => !isApiError(e, 404) && count < 2,
  });
}

export function useJobs(connId: string | undefined) {
  return useQuery({
    queryKey: qk.jobs(connId ?? '-'),
    queryFn: () => api<JobSummary[]>(`/connections/${enc(connId!)}/jobs`),
    enabled: Boolean(connId),
  });
}

export function useJobDetail(connId: string, jobId: string) {
  return useQuery({
    queryKey: qk.job(connId, jobId),
    queryFn: () => api<JobDetailView>(`/connections/${enc(connId)}/jobs/${enc(jobId)}`),
    retry: (count, e) => !isApiError(e, 404) && count < 2,
  });
}

export function useGraph(connId: string | undefined, focus: string | null, depth: number, kinds: string[] = [], enabled = true) {
  const k = [...kinds].sort().join(',');
  return useQuery({
    queryKey: qk.graph(connId ?? '-', focus, depth, k),
    queryFn: () => {
      const p = new URLSearchParams();
      if (focus) {
        p.set('focus', focus);
        p.set('depth', String(depth));
      }
      if (k) p.set('kinds', k);
      const qs = p.toString();
      return api<Graph>(`/connections/${enc(connId!)}/graph${qs ? `?${qs}` : ''}`);
    },
    enabled: Boolean(connId) && enabled,
    retry: (count, e) => !isApiError(e, 404) && count < 2,
  });
}

/** Server-computed audit insights (from the cache only). */
export function useInsights(connId: string | undefined) {
  return useQuery({
    queryKey: qk.insights(connId ?? '-'),
    queryFn: () => api<InsightsReport>(`/connections/${enc(connId!)}/insights`),
    enabled: Boolean(connId),
  });
}

/** Cached AI analysis for exactly this set of categories (pass them in report order); `null` when none yet (the server answers 200 `null`; a 404 from an older server is also `null`). */
export function useInsightsAnalysis(connId: string, categories: InsightCategoryId[], enabled = true) {
  const cats = categories.join(',');
  return useQuery({
    queryKey: qk.insightsAnalysis(connId, cats),
    queryFn: async () => {
      try {
        return await api<AiInsightsAnalysis | null>(`/connections/${enc(connId)}/insights/analysis?categories=${enc(cats)}`);
      } catch (e) {
        if (isApiError(e, 404)) return null;
        throw e;
      }
    },
    enabled: Boolean(connId) && categories.length > 0 && enabled,
    retry: (count, e) => !isApiError(e, 404) && count < 2,
  });
}

/** Runs (or, without `force`, may return the cached) AI analysis and stores it in the useInsightsAnalysis cache. */
export function useAnalyzeInsights(connId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ categories, force }: { categories: InsightCategoryId[]; force: boolean }) =>
      api<AiInsightsAnalysis>(`/connections/${enc(connId)}/insights/analyze`, { method: 'POST', body: { categories, force } }),
    onSuccess: (res, v) => {
      qc.setQueryData(qk.insightsAnalysis(connId, v.categories.join(',')), res);
    },
  });
}

export function useRuns(connId: string | undefined) {
  return useQuery({
    queryKey: qk.runs(connId ?? '-'),
    queryFn: () => api<RefreshRun[]>(`/connections/${enc(connId!)}/refresh`),
    enabled: Boolean(connId),
    refetchInterval: (q) => (q.state.data?.some((r) => r.status === 'running') ? 1000 : false),
  });
}

export const RUN_HISTORY_PAGE = 50;

/** All runs of the connection, newest first, in pages of RUN_HISTORY_PAGE (cursor: `before=<last run id>`). */
export function useRunHistory(connId: string | undefined) {
  return useInfiniteQuery({
    queryKey: qk.runHistory(connId ?? '-'),
    queryFn: ({ pageParam }) =>
      api<RefreshRun[]>(`/connections/${enc(connId!)}/refresh?limit=${RUN_HISTORY_PAGE}${pageParam ? `&before=${enc(pageParam)}` : ''}`),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last.length >= RUN_HISTORY_PAGE ? last[last.length - 1].id : undefined),
    enabled: Boolean(connId),
    refetchInterval: (q) => (q.state.data?.pages.some((p) => p.some((r) => r.status === 'running')) ? 1000 : false),
  });
}

export function useRun(connId: string, runId: string | null) {
  return useQuery({
    queryKey: qk.run(connId, runId ?? '-'),
    queryFn: () => api<RefreshRun>(`/connections/${enc(connId)}/refresh/${enc(runId!)}`),
    enabled: Boolean(runId),
    refetchInterval: (q) => (!q.state.data || q.state.data.status === 'running' ? 700 : false),
  });
}

export function invalidateConnectionData(qc: QueryClient, connId: string): Promise<void> {
  return Promise.all([
    qc.invalidateQueries({ queryKey: qk.conn(connId) }),
    qc.invalidateQueries({ queryKey: qk.connections }),
  ]).then(() => undefined);
}

export function useStartRefresh(connId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: RefreshRequest | (Omit<RefreshRequest, 'segments'> & { segments: RefreshRequest['segments'] | string[] })) =>
      api<{ runId: string }>(`/connections/${enc(connId)}/refresh`, { method: 'POST', body: req }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.runs(connId) }),
  });
}

export function useCancelRefresh(connId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (runId: string) => api<{ runId: string }>(`/connections/${enc(connId)}/refresh/${enc(runId)}/cancel`, { method: 'POST' }),
    onSuccess: (_r, runId) =>
      Promise.all([qc.invalidateQueries({ queryKey: qk.runs(connId) }), qc.invalidateQueries({ queryKey: qk.run(connId, runId) })]).then(() => undefined),
  });
}

export function useSaveConnection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string | null; input: ConnectionInput }) =>
      id
        ? api<ConnectionProfile>(`/connections/${enc(id)}`, { method: 'PUT', body: input })
        : api<ConnectionProfile>('/connections', { method: 'POST', body: input }),
    onSuccess: async (p, v) => {
      qc.setQueryData<ConnectionProfile[]>(qk.connections, (prev) => (prev ? (prev.some((c) => c.id === p.id) ? prev.map((c) => (c.id === p.id ? p : c)) : [...prev, p]) : [p]));
      await qc.invalidateQueries({ queryKey: qk.connections });
      if (v.id) await qc.invalidateQueries({ queryKey: qk.conn(p.id) });
    },
  });
}

export function useDeleteConnection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/connections/${enc(id)}`, { method: 'DELETE' }),
    onSuccess: async (_r, id) => {
      qc.removeQueries({ queryKey: qk.conn(id) });
      await qc.invalidateQueries({ queryKey: qk.connections });
    },
  });
}

export function useTestConnection() {
  return useMutation({
    mutationFn: (id: string) => api<ConnectionTestResult>(`/connections/${enc(id)}/test`, { method: 'POST' }),
  });
}

/** AI status; a 404 means the server has no AI endpoints (older backend) and is reported as `null`. */
export function useAiStatus() {
  return useQuery({
    queryKey: qk.aiStatus,
    queryFn: async () => {
      try {
        return await api<AiStatus>('/ai/status');
      } catch (e) {
        if (isApiError(e, 404)) return null;
        throw e;
      }
    },
    retry: false,
  });
}

export function useSaveAiSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: AiSettingsInput) => api<AiStatus>('/ai/settings', { method: 'PUT', body: input }),
    onSuccess: (s) => {
      if (s && typeof s === 'object' && 'configured' in s) qc.setQueryData(qk.aiStatus, s);
      return qc.invalidateQueries({ queryKey: qk.aiStatus });
    },
  });
}

export function useDescribe(connId: string, target: { type: 'object'; kind: ObjectKind; schema: string; name: string } | { type: 'job'; jobId: string }) {
  const qc = useQueryClient();
  const path =
    target.type === 'object'
      ? `/connections/${enc(connId)}/objects/${target.kind}/${enc(target.schema)}/${enc(target.name)}/describe`
      : `/connections/${enc(connId)}/jobs/${enc(target.jobId)}/describe`;
  const key = target.type === 'object' ? qk.object(connId, target.kind, target.schema, target.name) : qk.job(connId, target.jobId);
  return useMutation({
    mutationFn: async (force: boolean) => normalizeAi(await api<unknown>(path, { method: 'POST', body: { force } })),
    onSuccess: (ai) => {
      qc.setQueryData(key, (prev: unknown) => (prev && typeof prev === 'object' ? { ...prev, ai } : prev));
    },
  });
}

/** The describe endpoint returns the AiDescription (tolerates a `{ ai }` wrapper). */
function normalizeAi(res: unknown): AiDescription {
  if (res && typeof res === 'object') {
    if ('content' in res) return res as AiDescription;
    if ('ai' in res && (res as { ai: unknown }).ai && typeof (res as { ai: unknown }).ai === 'object') return (res as { ai: AiDescription }).ai;
  }
  throw new Error('Unexpected response from the describe endpoint');
}
