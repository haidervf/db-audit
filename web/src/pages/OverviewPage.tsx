import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { useInsights, useObjects, useRuns, useSummary } from '../api/hooks';
import type { GraphNodeKind, Insight as InsightData, InsightCategoryId, InsightsReport, ObjectKind, RefreshRun } from '../api/types';
import { Icon } from '../components/Icon';
import { InsightsAiPanel, type InsightsAiHandle } from '../components/InsightsAiPanel';
import { resolveRef, useObjIndex, type ObjIndex } from '../components/ObjectChip';
import { Badge, Callout, Empty, KindGlyph, Loading, QueryError } from '../components/ui';
import { durationBetween, fmtDateTime, fmtDuration, fmtNumber, fmtRelative } from '../lib/format';
import { severityTone } from '../lib/insights';
import { KIND_META, jobPath } from '../lib/kinds';
import { endpointLabel } from '../shell/connection';
import { RunView, WarningsList, runTone, useRefreshDialog } from '../shell/RefreshDialog';

const CARD_KINDS: Array<{ kind: GraphNodeKind; seg: string }> = [
  { kind: 'procedure', seg: 'procedures' },
  { kind: 'table', seg: 'tables' },
  { kind: 'view', seg: 'views' },
  { kind: 'function', seg: 'functions' },
  { kind: 'trigger', seg: 'triggers' },
  { kind: 'job', seg: 'jobs' },
];

function Insight({
  title,
  count,
  children,
  hint,
  testId,
  action,
  badge,
  flash,
}: {
  title: string;
  count?: number | null;
  children: ReactNode;
  hint?: ReactNode;
  testId?: string;
  action?: ReactNode;
  badge?: ReactNode;
  flash?: boolean;
}) {
  return (
    <section className={`card${flash ? ' insight-flash' : ''}`} data-testid={testId} style={{ display: 'flex', flexDirection: 'column' }}>
      <div className="card-header">
        <h3 className="grow">{title}</h3>
        {badge}
        {count !== undefined && count !== null ? <span className="badge">{count}</span> : null}
        {action}
      </div>
      <div className="card-body flush scroll" style={{ flex: 1 }}>
        {children}
      </div>
      {hint ? <div className="xsmall muted" style={{ padding: '8px 14px', borderTop: '1px solid var(--border)' }}>{hint}</div> : null}
    </section>
  );
}

export function OverviewPage() {
  const { connId = '' } = useParams();
  const summary = useSummary(connId);
  const objects = useObjects(connId);
  const runs = useRuns(connId);
  const insights = useInsights(connId);
  const { openRefresh } = useRefreshDialog();
  const hasData = Boolean(summary.data && (summary.data.lastRefresh || Object.values(summary.data.counts).some((n) => n > 0)));
  const aiPanel = useRef<InsightsAiHandle>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const flashTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(flashTimer.current), []);

  /** Scrolls to the insight's card (or its entry in a "No findings" line) and highlights it briefly. */
  const showInsight = (id: string) => {
    document.querySelector(`[data-testid="insight-${CSS.escape(id)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setFlash(null);
    window.clearTimeout(flashTimer.current);
    requestAnimationFrame(() => setFlash(id));
    flashTimer.current = window.setTimeout(() => setFlash(null), 1800);
  };

  const noAnalysis = useMemo(() => {
    const procs = (objects.data ?? []).filter((o) => o.kind === 'procedure');
    return procs.length > 0 && !procs.some((p) => p.analysisFlags);
  }, [objects.data]);

  if (summary.isLoading) return <Loading />;
  if (summary.error) return <div className="page"><QueryError error={summary.error} onRetry={() => summary.refetch()} what="the overview" /></div>;
  const s = summary.data!;
  const c = s.connection;
  const running = runs.data?.find((r) => r.status === 'running') ?? null;

  if (!hasData) {
    return (
      <div className="page">
        <Header name={c.name} sub={endpointLabel(c)} onRefresh={() => openRefresh()} />
        {running ? (
          <div className="card">
            <div className="card-body">
              <RunView run={running} />
            </div>
          </div>
        ) : (
          <div className="card onboarding" data-testid="first-refresh">
            <div className="empty-icon" style={{ margin: '0 auto' }}>
              <Icon name="refresh" size={20} />
            </div>
            <h2>Run the first refresh</h2>
            <p className="text-2" style={{ margin: '0 0 16px' }}>
              Nothing is cached for this connection yet. A refresh reads the catalog (read-only) and stores it locally, then analyzes every procedure, function, view, trigger and job step.
            </p>
            <button className="btn btn-primary" onClick={() => openRefresh()} data-testid="first-refresh-button">
              <Icon name="play" size={13} /> Run first refresh
            </button>
          </div>
        )}
      </div>
    );
  }

  const last = s.lastRefresh;

  return (
    <div className="page" data-testid="overview-page">
      <Header name={c.name} sub={endpointLabel(c)} onRefresh={() => openRefresh()} serverInfo={s.serverInfo} />

      <div className="grid-cards" style={{ gridTemplateColumns: 'repeat(6, minmax(0, 1fr))', marginBottom: 14 }}>
        {CARD_KINDS.map((k) => (
          <Link key={k.kind} to={`/c/${encodeURIComponent(connId)}/${k.seg}`} className="card stat-card" data-testid={`count-${k.kind}`}>
            <span className="row small muted" style={{ gap: 6 }}>
              <KindGlyph kind={k.kind} /> {KIND_META[k.kind].plural}
            </span>
            <span className="stat-value">{fmtNumber(s.counts[k.kind as ObjectKind | 'job'] ?? 0)}</span>
          </Link>
        ))}
      </div>

      <div className="grid-2" style={{ marginBottom: 14, gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)' }}>
        <section className="card" data-testid="last-refresh">
          <div className="card-header">
            <h3 className="grow">Last refresh</h3>
            {last ? <Badge tone={runTone(last.status)}>{last.status}</Badge> : null}
          </div>
          <div className="card-body">
            {running ? (
              <RunView run={running} />
            ) : last ? (
              <LastRefresh run={last} />
            ) : (
              <span className="muted">No refresh run recorded. The cache was filled earlier.</span>
            )}
          </div>
        </section>
        <section className="card" data-testid="warnings-card">
          <div className="card-header">
            <h3 className="grow">Warnings</h3>
            <span className="badge" data-tone={s.warnings.length ? 'warn' : 'ok'}>
              {s.warnings.length}
            </span>
          </div>
          <div className="card-body scroll">
            {s.warningDetails.length ? <WarningsList connId={connId} warnings={s.warningDetails} max={6} /> : <span className="muted">No warnings from the last refresh.</span>}
          </div>
        </section>
      </div>

      <h2 className="section-title" style={{ margin: '20px 0 10px' }}>
        Audit insights
      </h2>
      {noAnalysis ? (
        <div style={{ marginBottom: 12 }}>
          <Callout tone="info" title="Analysis not available — run a refresh">
            Dynamic SQL, cross-database and job→procedure insights come from static analysis of the cached code. Run a refresh including the “analysis” segment.
          </Callout>
        </div>
      ) : null}
      {insights.isLoading ? (
        <Loading label="Computing insights…" />
      ) : insights.error ? (
        <QueryError error={insights.error} onRetry={() => insights.refetch()} what="the insights" />
      ) : insights.data ? (
        <>
          <InsightsAiPanel ref={aiPanel} connId={connId} report={insights.data} onShowInsight={showInsight} />
          <InsightCategories connId={connId} report={insights.data} flash={flash} onAskAi={(cat) => aiPanel.current?.ask(cat)} />
        </>
      ) : null}
      <div className="grid-3" style={{ alignItems: 'start', marginTop: 14 }}>
        <Insight
          title="Recent refresh runs"
          count={runs.data?.length ?? null}
          testId="recent-runs"
          action={
            <Link to={`/c/${encodeURIComponent(connId)}/refreshes`} className="small" data-testid="recent-runs-all">
              View all
            </Link>
          }
        >
          {runs.data?.length ? (
            <ul className="list-plain" style={{ padding: '4px 0' }}>
              {runs.data.slice(0, 8).map((r) => (
                <li key={r.id}>
                  <Link to={`/c/${encodeURIComponent(connId)}/refreshes?run=${encodeURIComponent(r.id)}`} className="row grow run-link" style={{ minWidth: 0 }}>
                    <Badge tone={runTone(r.status)}>{r.status}</Badge>
                    <span className="small grow truncate" title={fmtDateTime(r.startedAt)}>
                      {fmtRelative(r.startedAt)} · {r.request.objects?.length ? `${r.request.objects.length} object(s)` : r.request.mode}
                      {r.request.objects?.length ? '' : r.request.segments === 'all' ? ' · all' : ` · ${r.request.segments.join(', ')}`}
                    </span>
                    <span className="small muted nowrap">{r.finishedAt ? fmtDuration(durationBetween(r.startedAt, r.finishedAt)) : '…'}</span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <Empty compact title="No refresh runs yet" />
          )}
        </Insight>
      </div>
    </div>
  );
}

/** Server insights grouped by category; available insights without findings collapse into one "No findings" line. */
function InsightCategories({
  connId,
  report,
  flash,
  onAskAi,
}: {
  connId: string;
  report: InsightsReport;
  flash: string | null;
  onAskAi: (category: InsightCategoryId) => void;
}) {
  const index = useObjIndex(connId);
  return (
    <div className="stack-lg">
      {report.categories.map((cat) => {
        const list = report.insights.filter((i) => i.category === cat.id);
        const cards = list.filter((i) => !i.available || i.total > 0);
        const zero = list.filter((i) => i.available && i.total === 0);
        return (
          <section key={cat.id} data-testid={`insight-category-${cat.id}`} className="insight-category">
            <div className="insight-category-head">
              <h3>{cat.title}</h3>
              <div className="small muted">{cat.description}</div>
            </div>
            {cards.length ? (
              <div className="grid-3 insight-grid" style={{ alignItems: 'start' }}>
                {cards.map((i) => (
                  <InsightCard key={i.id} connId={connId} insight={i} index={index} flash={flash === i.id} onAskAi={() => onAskAi(cat.id)} />
                ))}
              </div>
            ) : null}
            {zero.length ? (
              <div className="small muted insights-zero" data-testid="insights-zero">
                <Icon name="check" size={13} />
                <span>
                  No findings:{' '}
                  {zero.map((i, n) => (
                    <span key={i.id}>
                      {n ? ' · ' : null}
                      <span className={flash === i.id ? 'insight-flash' : undefined} title={i.description} data-testid={`insight-${i.id}`}>
                        {i.title}
                      </span>
                    </span>
                  ))}
                </span>
              </div>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

/** details longer than this go on their own line under the label (short ones, e.g. "6 refs", stay on the right) */
const LONG_DETAIL = 28;

function InsightCard({ connId, insight: i, index, flash, onAskAi }: { connId: string; insight: InsightData; index: ObjIndex | null; flash: boolean; onAskAi: () => void }) {
  return (
    <Insight
      title={i.title}
      testId={`insight-${i.id}`}
      flash={flash}
      badge={<Badge tone={severityTone(i.severity)}>{i.severity}</Badge>}
      count={i.available ? i.total : null}
      action={
        <button type="button" className="btn btn-ghost btn-xs nowrap" onClick={onAskAi} title="Select this category in the AI analysis" data-testid="insight-ask-ai">
          <Icon name="sparkles" size={12} /> Ask AI
        </button>
      }
      hint={
        <>
          {i.description}
          {i.caveat ? <div style={{ marginTop: 4, fontStyle: 'italic' }}>{i.caveat}</div> : null}
        </>
      }
    >
      {!i.available ? (
        <Empty compact title="Not available" body={i.unavailableReason ?? 'The data this insight needs is not in the cache.'} />
      ) : (
        <ul className="list-plain" style={{ padding: '4px 0' }}>
          {i.items.map((it, n) => (
            <li key={n} data-testid="insight-item" className={it.detail && it.detail.length > LONG_DETAIL ? 'insight-item-long' : undefined}>
              <InsightItemLabel connId={connId} item={it} index={index} />
              {it.detail ? (
                <span className="small muted insight-detail" title={it.detail}>
                  {it.detail}
                </span>
              ) : null}
            </li>
          ))}
          {i.items.length < i.total ? (
            <li className="small muted" data-testid="insight-truncated">
              Showing {fmtNumber(i.items.length)} of {fmtNumber(i.total)}
            </li>
          ) : null}
        </ul>
      )}
    </Insight>
  );
}

function InsightItemLabel({ connId, item, index }: { connId: string; item: InsightData['items'][number]; index: ObjIndex | null }) {
  if (item.object) {
    const r = resolveRef(connId, item.object, index);
    return (
      <>
        <KindGlyph kind={item.object.kind} />
        {r.to ? (
          <Link to={r.to} className="truncate grow mono small" style={{ color: 'inherit' }} title={r.title} data-testid="insight-object" data-linked="true">
            {r.label}
          </Link>
        ) : (
          <span className="truncate grow mono small muted" title={r.title} data-testid="insight-object" data-linked="false">
            {r.label}
          </span>
        )}
      </>
    );
  }
  if (item.job) {
    return (
      <>
        <KindGlyph kind="job" />
        <Link to={jobPath(connId, item.job.jobId)} className="truncate grow" title={`Open job ${item.job.name}`} data-testid="insight-job">
          {item.label}
        </Link>
      </>
    );
  }
  return <span className="truncate grow">{item.label}</span>;
}

function Header({ name, sub, onRefresh, serverInfo }: { name: string; sub: string; onRefresh: () => void; serverInfo?: Record<string, unknown> | null }) {
  const info = serverInfo ?? {};
  const edition = typeof info.engineEditionLabel === 'string' ? info.engineEditionLabel : typeof info.edition === 'string' ? info.edition : null;
  const version = typeof info.serverVersion === 'string' ? info.serverVersion : typeof info.productVersion === 'string' ? info.productVersion : null;
  return (
    <div className="page-header">
      <div className="grow">
        <h1 className="page-title">{name}</h1>
        <div className="page-subtitle row" style={{ gap: 10, flexWrap: 'wrap' }}>
          <span className="mono">{sub}</span>
          {edition ? <span>· {edition}</span> : null}
          {version ? <span className="mono">· {version}</span> : null}
        </div>
      </div>
      <button className="btn" onClick={onRefresh} data-testid="overview-refresh">
        <Icon name="refresh" size={14} /> Refresh…
      </button>
    </div>
  );
}

function LastRefresh({ run }: { run: RefreshRun }) {
  const counts = Object.entries(run.counts);
  return (
    <div className="stack-md">
      <dl className="kv">
        <dt>Finished</dt>
        <dd>
          {fmtDateTime(run.finishedAt)} <span className="muted">({fmtRelative(run.finishedAt)})</span>
        </dd>
        <dt>Duration</dt>
        <dd>{fmtDuration(durationBetween(run.startedAt, run.finishedAt))}</dd>
        <dt>Request</dt>
        <dd>
          {run.request.objects?.length ? `${run.request.objects.length} object(s)` : `${run.request.mode}, ${run.request.segments === 'all' ? 'all segments' : run.request.segments.join(', ')}`}
        </dd>
      </dl>
      {counts.length ? (
        <div className="table-wrap">
          <table className="data compact">
            <thead>
              <tr>
                <th>Segment</th>
                <th className="num">Added</th>
                <th className="num">Updated</th>
                <th className="num">Removed</th>
                <th className="num">Unchanged</th>
              </tr>
            </thead>
            <tbody>
              {counts.map(([seg, c]) => (
                <tr key={seg}>
                  <td style={{ textTransform: 'capitalize' }}>{seg}</td>
                  <td className="num">{fmtNumber(c!.added)}</td>
                  <td className="num">{fmtNumber(c!.updated)}</td>
                  <td className="num">{fmtNumber(c!.removed)}</td>
                  <td className="num muted">{fmtNumber(c!.unchanged)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {run.error ? <Callout tone={run.status === 'cancelled' ? 'warn' : 'danger'}>{run.error}</Callout> : null}
    </div>
  );
}
