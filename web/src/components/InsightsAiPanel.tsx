import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { Link } from 'react-router';
import { errorMessage } from '../api/client';
import { useAiStatus, useAnalyzeInsights, useInsightsAnalysis } from '../api/hooks';
import type { AiInsightFinding, InsightCategoryId, InsightsReport } from '../api/types';
import { analysisText, categoryTitle, findingText, insightTitle, severityTone, sortFindings } from '../lib/insights';
import { plural } from '../lib/format';
import { AiConsentDialog, Elapsed, aiErrorTitle, aiMetaText, useConsent } from './AiPanel';
import { CopyButton } from './CopyButton';
import { Icon } from './Icon';
import { ObjectChip, useObjIndex, type ObjIndex } from './ObjectChip';
import { Badge, Callout, Empty, Loading, QueryError, Spinner } from './ui';

export interface InsightsAiHandle {
  /** Selects only this category, scrolls to the panel and focuses Analyze. Never starts a run (runs cost money). */
  ask: (category: InsightCategoryId) => void;
}

/** AI review of the insights report for a chosen set of categories (cached per set on the server). */
export function InsightsAiPanel({
  connId,
  report,
  onShowInsight,
  ref,
}: {
  connId: string;
  report: InsightsReport;
  onShowInsight: (insightId: string) => void;
  ref?: Ref<InsightsAiHandle>;
}) {
  const allIds = report.categories.map((c) => c.id);
  const [picked, setPicked] = useState<ReadonlySet<InsightCategoryId>>(() => new Set(allIds));
  const selected = allIds.filter((id) => picked.has(id));
  const status = useAiStatus();
  const st = status.data;
  const cached = useInsightsAnalysis(connId, selected, Boolean(st));
  const analyze = useAnalyzeInsights(connId);
  const index = useObjIndex(connId);
  const [consented, giveConsent] = useConsent();
  const [askConsent, setAskConsent] = useState<null | boolean>(null);
  const root = useRef<HTMLElement>(null);
  const analyzeBtn = useRef<HTMLButtonElement>(null);
  const allBox = useRef<HTMLInputElement>(null);
  const [focusTick, setFocusTick] = useState(0);
  const busy = analyze.isPending;

  const select = (next: ReadonlySet<InsightCategoryId>) => {
    if (busy) return;
    setPicked(next);
    analyze.reset();
  };

  useImperativeHandle(ref, () => ({
    ask: (category) => {
      // a running analysis keeps its selection; just bring the panel into view
      if (!busy) select(new Set([category]));
      setFocusTick((t) => t + 1);
    },
  }));

  useEffect(() => {
    if (!focusTick) return;
    root.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    analyzeBtn.current?.focus({ preventScroll: true });
  }, [focusTick]);

  const allChecked = selected.length === allIds.length;
  useEffect(() => {
    if (allBox.current) allBox.current.indeterminate = selected.length > 0 && !allChecked;
  });

  const run = (force: boolean) => {
    if (!selected.length) return;
    if (!consented) {
      setAskConsent(force);
      return;
    }
    analyze.mutate({ categories: selected, force });
  };

  const current = cached.data ?? null;
  const err = analyze.error;
  const errTitle = aiErrorTitle(err, 'The model declined to analyze these insights', 'Could not generate the analysis');
  const errCallout = err ? (
    <Callout tone="danger" title={errTitle}>
      {errorMessage(err)}
    </Callout>
  ) : null;

  let body;
  if (status.isLoading) body = <Loading label="Checking AI configuration…" />;
  else if (status.error) body = <Callout tone="danger" title="Could not read the AI status">{errorMessage(status.error)}</Callout>;
  else if (!st)
    body = (
      <Empty
        icon="sparkles"
        title="AI analysis is not available on this server"
        body="The connected db-audit server does not expose the AI endpoints yet. Update the server to use this feature."
      />
    );
  else if (!selected.length) body = <div className="muted small">Select at least one category to analyze.</div>;
  else if (busy)
    body = (
      <div className="empty" data-testid="insights-ai-loading">
        <Spinner large />
        <div className="empty-title">Analyzing insights…</div>
        <div className="empty-body">
          Asking {st.model} ({st.effort} effort) to review {plural(selected.length, 'category', 'categories')}. This can take a minute. <Elapsed />
        </div>
      </div>
    );
  else if (cached.isLoading) body = <Loading label="Looking for a saved analysis…" />;
  else if (cached.error) body = <QueryError error={cached.error} onRetry={() => cached.refetch()} what="the saved analysis" />;
  else if (!current)
    body = (
      <>
        {errCallout}
        {!st.configured ? (
          <Empty
            icon="sparkles"
            title="AI not configured — add a key in Settings"
            body="Add an Anthropic API key in Settings (or set ANTHROPIC_API_KEY for the server) to get an AI review of these insights."
            action={
              <Link className="btn btn-primary" to="/settings">
                Open Settings
              </Link>
            }
          />
        ) : (
          <Empty
            icon="sparkles"
            title="No analysis for this selection yet"
            body={`Analyze sends the selected categories of the insights report to ${st.model} (${st.effort} effort) for a prioritized review: findings, recommendations and quick wins.`}
          />
        )}
      </>
    );
  else {
    const c = current.content;
    body = (
      <div className="stack-md" data-testid="insights-ai-result">
        {errCallout}
        {current.stale ? (
          <Callout
            tone="warn"
            title="The insights changed since this analysis was generated"
            action={
              <button className="btn btn-sm" onClick={() => run(true)} disabled={!st.configured}>
                <Icon name="refresh" size={13} /> Regenerate
              </button>
            }
          >
            The analysis may no longer match the current insights.
          </Callout>
        ) : null}
        <div className="ai-section">
          <h4>Summary</h4>
          <div className="ai-summary" data-testid="insights-ai-summary">
            {c.summary}
          </div>
        </div>
        {c.findings.length ? (
          <div className="ai-section">
            <h4>Findings ({c.findings.length})</h4>
            <div>
              {sortFindings(c.findings).map((f, i) => (
                <Finding key={i} connId={connId} finding={f} report={report} index={index} onShowInsight={onShowInsight} />
              ))}
            </div>
          </div>
        ) : null}
        {c.quickWins.length ? (
          <div className="ai-section">
            <h4>Quick wins</h4>
            <ul style={{ margin: 0, paddingLeft: 20 }} data-testid="insights-ai-quickwins">
              {c.quickWins.map((q, i) => (
                <li key={i} className="text-2" style={{ marginBottom: 4 }}>
                  {q}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {c.notes.length ? (
          <div className="ai-section">
            <h4>Notes</h4>
            <ul style={{ margin: 0, paddingLeft: 20 }}>
              {c.notes.map((n, i) => (
                <li key={i} className="text-2" style={{ marginBottom: 4 }}>
                  {n}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <div className="row small muted" style={{ flexWrap: 'wrap' }} data-testid="insights-ai-meta">
          <span>{aiMetaText(current)}</span>
          <span className="spacer" />
          <button
            className="btn btn-sm"
            onClick={() => run(true)}
            disabled={!st.configured}
            title={st.configured ? undefined : 'AI not configured'}
            data-testid="insights-ai-regenerate"
          >
            <Icon name="refresh" size={13} /> Regenerate
          </button>
        </div>
      </div>
    );
  }

  return (
    <section className="card" data-testid="insights-ai" ref={root} style={{ scrollMarginTop: 12, marginBottom: 14 }}>
      <div className="card-header">
        <Icon name="sparkles" size={14} />
        <h3 className="grow">AI analysis</h3>
        {current && !busy ? <CopyButton label="Copy analysis" title="Copy the whole analysis" text={() => analysisText(current, report)} testId="insights-ai-copy" /> : null}
      </div>
      <div className="card-body stack-md">
        {st ? (
          <div className="row insights-ai-toolbar" role="group" aria-label="Categories to analyze">
            <label className="check">
              <input
                ref={allBox}
                type="checkbox"
                checked={allChecked}
                disabled={busy}
                onChange={() => select(new Set(allChecked ? [] : allIds))}
                data-testid="insights-ai-all"
              />
              All
            </label>
            {report.categories.map((cat) => (
              <label className="check" key={cat.id}>
                <input
                  type="checkbox"
                  checked={picked.has(cat.id)}
                  disabled={busy}
                  onChange={() => {
                    const next = new Set(picked);
                    if (next.has(cat.id)) next.delete(cat.id);
                    else next.add(cat.id);
                    select(next);
                  }}
                  data-testid={`insights-ai-cat-${cat.id}`}
                />
                {cat.title}
              </label>
            ))}
            <span className="spacer" />
            <button
              ref={analyzeBtn}
              className="btn btn-primary btn-sm"
              onClick={() => run(false)}
              disabled={busy || !selected.length || !st.configured}
              title={st.configured ? undefined : 'AI not configured'}
              data-testid="insights-ai-analyze"
            >
              <Icon name="sparkles" size={13} /> Analyze
            </button>
          </div>
        ) : null}
        {body}
      </div>
      <AiConsentDialog
        open={askConsent !== null}
        onClose={() => setAskConsent(null)}
        title="Send the insights report to Anthropic?"
        onContinue={() => {
          const force = askConsent ?? false;
          giveConsent();
          setAskConsent(null);
          if (selected.length) analyze.mutate({ categories: selected, force });
        }}
      >
        <p style={{ margin: 0 }}>
          This sends the selected categories of the insights report (object and job names, counts and the short details shown on the cards) to Anthropic&apos;s API to generate the analysis.
        </p>
      </AiConsentDialog>
    </section>
  );
}

function Finding({
  connId,
  finding: f,
  report,
  index,
  onShowInsight,
}: {
  connId: string;
  finding: AiInsightFinding;
  report: InsightsReport;
  index: ObjIndex | null;
  onShowInsight: (id: string) => void;
}) {
  return (
    <div className="insight-finding" data-testid="insights-ai-finding" data-severity={f.severity}>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <Badge tone={severityTone(f.severity)}>{f.severity}</Badge>
        <div className="grow" style={{ minWidth: 0, fontWeight: 600 }}>
          {f.title}
        </div>
        <span className="small muted nowrap">{categoryTitle(report, f.category)}</span>
        <CopyButton text={() => findingText(f, report)} title="Copy finding" testId="insights-ai-finding-copy" />
      </div>
      {f.explanation ? <div className="text-2">{f.explanation}</div> : null}
      {f.recommendation ? (
        <div>
          <span className="muted small">Recommendation: </span>
          {f.recommendation}
        </div>
      ) : null}
      {f.objects.length || f.insightIds.length ? (
        <div className="warning-refs" style={{ marginTop: 0 }}>
          {f.objects.map((o) => (
            <ObjectChip key={`${o.kind}:${o.schema}.${o.name}`} connId={connId} obj={o} index={index} testId="insights-ai-object" />
          ))}
          {f.insightIds.map((id) => (
            <button
              key={id}
              type="button"
              className="btn btn-ghost btn-xs"
              onClick={() => onShowInsight(id)}
              title="Show this insight"
              data-testid="insights-ai-insight-link"
              data-insight={id}
            >
              <Icon name="link" size={12} /> {insightTitle(report, id)}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
