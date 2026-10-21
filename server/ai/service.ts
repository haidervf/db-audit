import Anthropic from '@anthropic-ai/sdk';
import type { z } from 'zod';
import type { AiDescription, AiDescriptionContent, AiInsightsAnalysis, AiInsightsContent, AiSettingsInput, AiStatus, InsightCategoryId, ObjectKind } from '../../shared/types';
import { computeInsights } from '../analysis/insights';
import { HttpError } from '../api/http';
import { jobNodeId, objectNodeId, type ReadModel } from '../api/readModel';
import { anthropicClientFactory, type AiClient, type AiClientFactory } from './client';
import type { AiConfig, AiConfigStore } from './config';
import { jobDescribeSha, toAiDescription, toAiInsightsAnalysis } from './hash';
import {
  buildInsightsPrompt,
  guardInsightsContent,
  insightsPayloadSha,
  insightsTargetKey,
  INSIGHTS_PROMPT_VERSION,
  INSIGHTS_SYSTEM_PROMPT,
  selectInsights,
} from './insightsPrompt';
import { buildJobPrompt, buildObjectPrompt, PROMPT_VERSION, SYSTEM_PROMPT } from './prompt';
import { aiContentSchema, insightsContentSchema, outputFormat } from './schema';

export const MAX_TOKENS = 32_000;
export const CREDENTIALS_MESSAGE = 'Anthropic credentials missing/invalid — set a key in Settings or ANTHROPIC_API_KEY';

/**
 * Maps SDK / transport errors to API errors. Typed SDK classes are checked most-specific first; the only
 * message match is the SDK's plain Error for "no credentials could be resolved", which has no class.
 * Messages come from the API response; the key is never part of them.
 */
export function mapAiError(err: unknown): HttpError {
  if (err instanceof HttpError) return err;
  if (err instanceof Anthropic.AuthenticationError) return new HttpError(400, CREDENTIALS_MESSAGE);
  if (err instanceof Anthropic.RateLimitError) {
    const retryAfter = err.headers?.get('retry-after') ?? null;
    return new HttpError(429, `Anthropic rate limit reached${retryAfter ? `; retry after ${retryAfter} s` : '; retry later'}`, { retryAfter }, retryAfter ? { 'Retry-After': retryAfter } : undefined);
  }
  if (err instanceof Anthropic.APIConnectionError) return new HttpError(502, `could not reach the Anthropic API: ${err.message}`);
  if (err instanceof Anthropic.APIError) {
    const status = typeof err.status === 'number' ? err.status : null;
    return new HttpError(502, `Anthropic API error${status ? ` ${status}` : ''}: ${err.message}`, { upstreamStatus: status, type: err.type ?? null });
  }
  if (err instanceof Error && /Could not resolve authentication method/i.test(err.message)) return new HttpError(400, CREDENTIALS_MESSAGE);
  return new HttpError(502, `AI request failed: ${err instanceof Error ? err.message : String(err)}`);
}

export interface Generated<C> {
  content: C;
  usage: { inputTokens: number; outputTokens: number };
}
export type GeneratedDescription = Generated<AiDescriptionContent>;

/** What one structured-output call asks for: system prompt, output schema, and the wording of its errors. */
export interface AiTask<C> {
  system: string;
  schema: z.ZodType<C>;
  /** used in error messages, e.g. 'description' -> "description truncated" */
  what: string;
  /** 422 message on stop_reason refusal */
  refusal: string;
}

export const DESCRIBE_TASK: AiTask<AiDescriptionContent> = {
  system: SYSTEM_PROMPT,
  schema: aiContentSchema,
  what: 'description',
  refusal: 'Claude declined to describe this',
};
export const INSIGHTS_TASK: AiTask<AiInsightsContent> = {
  system: INSIGHTS_SYSTEM_PROMPT,
  schema: insightsContentSchema,
  what: 'insights analysis',
  refusal: 'Claude declined to analyze these insights',
};

/**
 * "Describe with AI": builds the prompt from the cache, calls Claude (streaming + finalMessage, structured
 * output), validates the JSON and caches it in ai_descriptions by (target, model, prompt version) together
 * with the sha256 of the input it was generated for. A cached description is returned (with `stale` when
 * the definition / job changed since) unless `force`. One request per target is in flight at a time; a
 * second caller awaits the same promise.
 */
export class AiService {
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(
    readonly config: AiConfigStore,
    private readonly clientFactory: AiClientFactory = anthropicClientFactory,
  ) {}

  status(): AiStatus {
    return this.config.status();
  }

  updateSettings(input: AiSettingsInput): AiStatus {
    return this.config.update(input);
  }

  private enabledConfig(): AiConfig {
    const cfg = this.config.get();
    if (cfg.disabled) throw new HttpError(400, 'AI descriptions are turned off (DB_AUDIT_AI=off)');
    return cfg;
  }

  async describeObject(connectionId: string, rm: ReadModel, kind: ObjectKind, schema: string, name: string, force: boolean): Promise<AiDescription> {
    const o = rm.store.getObject(kind, schema, name);
    if (!o) throw new HttpError(404, `${kind} ${schema}.${name} not found in the cache (refresh first?)`);
    if (o.definition === null || o.definitionSha256 === null) {
      throw new HttpError(400, `${kind} ${o.schema}.${o.name} has no definition to describe (${kind === 'table' ? 'tables have no T-SQL definition' : o.isEncrypted ? 'encrypted' : 'not visible / CLR'})`);
    }
    const key = objectNodeId(o.kind, o.schema, o.name);
    const sha = o.definitionSha256;
    const cfg = this.enabledConfig();
    if (!force) {
      const cached = rm.store.getAiFor(key, cfg.model, PROMPT_VERSION);
      if (cached) return toAiDescription(cached, sha);
    }
    // registered synchronously (before any await) so a concurrent caller finds it
    return this.once(`${connectionId}|${key}`, async () => {
      const detail = rm.detail(o.kind, o.schema, o.name)!;
      return this.generateAndStore(rm, cfg, key, sha, buildObjectPrompt(rm, detail));
    });
  }

  async describeJob(connectionId: string, rm: ReadModel, jobId: string, force: boolean): Promise<AiDescription> {
    const job = rm.jobs().find((j) => j.jobId.toLowerCase() === jobId.toLowerCase());
    if (!job) throw new HttpError(404, `job ${jobId} not found in the cache`);
    const key = jobNodeId(job.jobId);
    const sha = jobDescribeSha(job.details);
    const cfg = this.enabledConfig();
    if (!force) {
      const cached = rm.store.getAiFor(key, cfg.model, PROMPT_VERSION);
      if (cached) return toAiDescription(cached, sha);
    }
    return this.once(`${connectionId}|${key}`, async () => {
      const detail = rm.jobDetail(job.jobId)!;
      return this.generateAndStore(rm, cfg, key, sha, buildJobPrompt(rm, detail));
    });
  }

  /**
   * "Analyze insights with AI": the selected categories' insights (computed now from the cache) plus compact
   * analyzer facts go to Claude; the answer is validated, passed through the hallucination guard and cached in
   * ai_descriptions under 'insights:' + sorted categories with INSIGHTS_PROMPT_VERSION. definitionSha256 is
   * the sha256 of the selected insights payload. Cache / force / in-flight semantics as describe.
   */
  async analyzeInsights(connectionId: string, rm: ReadModel, categories: InsightCategoryId[], force: boolean): Promise<AiInsightsAnalysis> {
    const cfg = this.enabledConfig();
    const sel = selectInsights(computeInsights(rm), categories);
    const key = insightsTargetKey(sel.categories);
    const sha = insightsPayloadSha(sel);
    if (!force) {
      const cached = rm.store.getAiFor<AiInsightsContent>(key, cfg.model, INSIGHTS_PROMPT_VERSION);
      if (cached) return toAiInsightsAnalysis(cached, sel.categories, sha);
    }
    return this.once(`${connectionId}|${key}`, async () => {
      const p = buildInsightsPrompt(rm, sel);
      const g = await this.generate(cfg, p.prompt, INSIGHTS_TASK);
      const guarded = guardInsightsContent(g.content, sel, p.objects);
      const d = guarded.dropped;
      if (d.objects || d.insightIds || d.findings || d.recategorized) {
        console.warn(
          `[db-audit] AI insights analysis (${key}): dropped ${d.objects} unknown object(s), ${d.insightIds} unknown insight id(s), ` +
            `${d.findings} finding(s) with an unselected category; ${d.recategorized} finding(s) moved to a selected category`,
        );
      }
      const row = {
        targetKey: key,
        definitionSha256: sha,
        model: cfg.model,
        promptVersion: INSIGHTS_PROMPT_VERSION,
        effort: cfg.effort,
        content: guarded.content,
        usage: g.usage,
        createdAt: new Date().toISOString(),
      };
      rm.store.saveAi(row);
      return toAiInsightsAnalysis(row, sel.categories, sha);
    });
  }

  /** Cached insights analysis for exactly this category set (current model, INSIGHTS_PROMPT_VERSION), `stale` computed now; null when none. */
  getInsightsAnalysis(rm: ReadModel, categories: InsightCategoryId[]): AiInsightsAnalysis | null {
    const cfg = this.config.get();
    const sel = selectInsights(computeInsights(rm), categories);
    const key = insightsTargetKey(sel.categories);
    const cached = rm.store.getAiFor<AiInsightsContent>(key, cfg.model, INSIGHTS_PROMPT_VERSION);
    if (!cached) return null;
    return toAiInsightsAnalysis(cached, sel.categories, insightsPayloadSha(sel));
  }

  private once<T>(flightKey: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(flightKey) as Promise<T> | undefined;
    if (existing) return existing;
    const p = fn().finally(() => this.inflight.delete(flightKey));
    this.inflight.set(flightKey, p);
    return p;
  }

  private async generateAndStore(rm: ReadModel, cfg: AiConfig, key: string, sha: string, userContent: string): Promise<AiDescription> {
    const g = await this.generate(cfg, userContent, DESCRIBE_TASK);
    const row = {
      targetKey: key,
      definitionSha256: sha,
      model: cfg.model,
      promptVersion: PROMPT_VERSION,
      effort: cfg.effort,
      content: g.content,
      usage: g.usage,
      createdAt: new Date().toISOString(),
    };
    rm.store.saveAi(row);
    return toAiDescription(row, sha);
  }

  /** One Messages API call: streaming + finalMessage(), adaptive thinking (omitted = default), explicit effort, structured output. */
  async generate<C>(cfg: AiConfig, userContent: string, task: AiTask<C>): Promise<Generated<C>> {
    let message: Anthropic.Message;
    try {
      const client: AiClient = this.clientFactory(cfg.apiKey);
      message = await client
        .stream({
          model: cfg.model,
          max_tokens: MAX_TOKENS,
          system: task.system,
          messages: [{ role: 'user', content: userContent }],
          output_config: { effort: cfg.effort, format: outputFormat(task.schema) },
        })
        .finalMessage();
    } catch (err) {
      throw mapAiError(err);
    }
    // branch on stop_reason before reading content
    if (message.stop_reason === 'refusal') {
      throw new HttpError(422, `${task.refusal} (stop_reason: refusal)`, {
        category: message.stop_details?.category ?? null,
        explanation: message.stop_details?.explanation ?? null,
      });
    }
    if (message.stop_reason === 'max_tokens' || message.stop_reason === 'model_context_window_exceeded') {
      throw new HttpError(502, `${task.what} truncated (stop_reason: ${message.stop_reason})`);
    }
    if (message.stop_reason !== 'end_turn' && message.stop_reason !== 'stop_sequence') {
      throw new HttpError(502, `unexpected stop_reason from Claude: ${message.stop_reason}`);
    }
    const text = message.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (err) {
      throw new HttpError(502, `Claude returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    const parsed = task.schema.safeParse(json);
    if (!parsed.success) {
      throw new HttpError(502, `Claude returned JSON that does not match the ${task.what} schema`, {
        issues: parsed.error.issues.slice(0, 10).map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    return { content: parsed.data, usage: { inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens } };
  }
}
