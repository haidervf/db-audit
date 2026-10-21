import type { AiDescription, AiInsightsAnalysis, AiInsightsContent, InsightCategoryId } from '../../shared/types';
import type { ExtractedJob } from '../extract/jobTypes';
import { sha256, type StoredAi } from '../store/cacheStore';

/**
 * What a job description depends on: every step's command and flow, plus the schedules. A change to any of
 * these makes a cached job description stale.
 */
export function jobDescribeSha(job: ExtractedJob): string {
  return sha256(
    JSON.stringify({
      steps: job.steps.map((s) => [s.stepId, s.name, s.subsystem, s.commandType, s.databaseName, s.onSuccess, s.onFail, s.command]),
      schedules: job.schedules.map((s) => [s.name, s.enabled, s.text]),
      schedule: job.schedule,
      scheduleText: job.scheduleText,
    }),
  );
}

/** Stored row -> API shape; `stale` when the row was generated for different input than `currentSha`. */
export function toAiDescription(row: StoredAi, currentSha: string | null): AiDescription {
  return {
    model: row.model,
    effort: row.effort,
    promptVersion: row.promptVersion,
    createdAt: row.createdAt,
    definitionSha256: row.definitionSha256 ?? '',
    stale: row.definitionSha256 !== currentSha,
    content: row.content,
    usage: row.usage,
  };
}

/** Stored insights row -> API shape; `stale` when the selected insights changed since (see insightsPayloadSha). */
export function toAiInsightsAnalysis(row: StoredAi<AiInsightsContent>, categories: InsightCategoryId[], currentSha: string): AiInsightsAnalysis {
  return {
    model: row.model,
    effort: row.effort,
    promptVersion: row.promptVersion,
    createdAt: row.createdAt,
    definitionSha256: row.definitionSha256 ?? '',
    stale: row.definitionSha256 !== currentSha,
    categories,
    content: row.content,
    usage: row.usage,
  };
}
