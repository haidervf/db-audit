import type { AiInsightFinding, AiInsightsAnalysis, InsightSeverity, InsightsReport } from '../api/types';
import type { Tone } from '../components/ui';
import { refLabel } from '../components/ObjectChip';

/** Badge tone of an insight / finding severity ('info' is context, not a problem: neutral). */
export function severityTone(s: InsightSeverity): Tone {
  return s === 'high' ? 'danger' : s === 'medium' ? 'warn' : s === 'low' ? 'info' : undefined;
}

const SEVERITY_RANK: Record<AiInsightFinding['severity'], number> = { high: 0, medium: 1, low: 2 };

/** Findings high → medium → low (stable within a severity). */
export function sortFindings(findings: AiInsightFinding[]): AiInsightFinding[] {
  return findings
    .map((f, i) => [f, i] as const)
    .sort((a, b) => (SEVERITY_RANK[a[0].severity] ?? 3) - (SEVERITY_RANK[b[0].severity] ?? 3) || a[1] - b[1])
    .map(([f]) => f);
}

export function categoryTitle(report: InsightsReport | undefined, id: string): string {
  return report?.categories.find((c) => c.id === id)?.title ?? id;
}

export function insightTitle(report: InsightsReport | undefined, id: string): string {
  return report?.insights.find((i) => i.id === id)?.title ?? id;
}

/** Plain-text / markdown form of one finding; objects as `<kind> <schema>.<name>`. */
export function findingText(f: AiInsightFinding, report: InsightsReport | undefined): string {
  const lines = [`[${f.severity}] ${f.title}`];
  const meta = [`Category: ${categoryTitle(report, f.category)}`];
  if (f.insightIds.length) meta.push(`Insights: ${f.insightIds.map((id) => insightTitle(report, id)).join(', ')}`);
  lines.push(meta.join(' · '));
  if (f.explanation) lines.push(f.explanation);
  if (f.recommendation) lines.push(`Recommendation: ${f.recommendation}`);
  if (f.objects.length) {
    lines.push('Objects:');
    for (const o of f.objects) lines.push(`- ${o.kind} ${refLabel(o)}`);
  }
  return lines.join('\n');
}

/** The whole analysis as markdown: summary, findings (high first), quick wins, notes. */
export function analysisText(a: AiInsightsAnalysis, report: InsightsReport | undefined): string {
  const c = a.content;
  const parts = [`# AI analysis of audit insights (${a.categories.map((id) => categoryTitle(report, id)).join(', ')})`, `## Summary\n${c.summary}`];
  if (c.findings.length) parts.push(`## Findings\n${sortFindings(c.findings).map((f) => `### ${findingText(f, report)}`).join('\n\n')}`);
  if (c.quickWins.length) parts.push(`## Quick wins\n${c.quickWins.map((q) => `- ${q}`).join('\n')}`);
  if (c.notes.length) parts.push(`## Notes\n${c.notes.map((n) => `- ${n}`).join('\n')}`);
  return parts.join('\n\n');
}
