import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import type { AiDescriptionContent, AiInsightsContent, InsightCategoryId, ObjectKind } from '../../shared/types';
import { OBJECT_KINDS } from '../../shared/types';
import { INSIGHT_CATEGORIES } from '../analysis/insights';

/** zod mirror of AiDescriptionContent (shared/types.ts). The model's JSON is validated against it. */
export const aiContentSchema = z.object({
  summary: z.string().describe('2-4 sentences, plain English: what the object or job does'),
  purpose: z.string().describe('The inferred business purpose, stated only as far as the code supports it'),
  steps: z
    .array(
      z.object({
        lines: z.string().describe('Line range of the definition, e.g. "12-20"; for jobs "Step 2"'),
        title: z.string(),
        explanation: z.string(),
      }),
    )
    .describe('The logical steps in execution order'),
  dataAccess: z
    .array(z.object({ object: z.string(), access: z.string().describe('e.g. reads, inserts, updates, deletes, merges, truncates'), why: z.string() }))
    .describe('Tables / views read or written'),
  calls: z.array(z.object({ object: z.string(), why: z.string() })).describe('Procedures / functions called'),
  risks: z.array(z.string()).describe('Concrete risks visible in the code, each with its line numbers'),
  notes: z.array(z.string()).describe('Other observations an auditor should know'),
}) satisfies z.ZodType<AiDescriptionContent>;

export const INSIGHT_CATEGORY_IDS = INSIGHT_CATEGORIES.map((c) => c.id) as [InsightCategoryId, ...InsightCategoryId[]];

/** zod mirror of AiInsightsContent / AiInsightFinding (shared/types.ts): the structured output of "Analyze insights with AI". */
export const insightsContentSchema = z.object({
  summary: z.string().describe('3-6 sentences: the overall state of the database for the selected categories and what matters most'),
  findings: z
    .array(
      z.object({
        title: z.string(),
        severity: z.enum(['high', 'medium', 'low']),
        category: z.enum(INSIGHT_CATEGORY_IDS).describe('One of the selected categories'),
        insightIds: z.array(z.string()).describe('Ids of the input insights this finding draws on'),
        explanation: z.string(),
        objects: z
          .array(z.object({ kind: z.enum(OBJECT_KINDS as [ObjectKind, ...ObjectKind[]]), schema: z.string(), name: z.string() }))
          .describe('Objects from the input insight items this finding concerns, exactly as listed (may be empty)'),
        recommendation: z.string().describe('Concrete next action for a DBA'),
      }),
    )
    .describe('Prioritized findings, most important first'),
  quickWins: z.array(z.string()).describe('Low-effort, low-risk actions with clear benefit'),
  notes: z.array(z.string()).describe('Caveats and other observations'),
}) satisfies z.ZodType<AiInsightsContent>;

/**
 * `output_config.format` for structured outputs. Only the JSON schema is sent (generated from the zod schema
 * by the SDK helper, which applies the API's schema rules); parsing + validation happen in service.ts so an
 * invalid answer becomes a 502 with a clear message instead of an SDK exception.
 */
export function outputFormat(schema: z.ZodType = aiContentSchema): { type: 'json_schema'; schema: Record<string, unknown> } {
  const f = zodOutputFormat(schema);
  return { type: 'json_schema', schema: f.schema };
}
