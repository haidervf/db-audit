import { Fragment, useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { useJobDetail } from '../api/hooks';
import type { JobDetailView, JobExecution, JobStepView } from '../api/types';
import { AiPanel } from '../components/AiPanel';
import { CodeView } from '../components/CodeView';
import { ExplainView } from '../components/ExplainView';
import { DiagramTab } from '../components/graph/DiagramTab';
import { Icon } from '../components/Icon';
import { Badge, Callout, Empty, KindBadge, KindGlyph, Loading, OpBadges, Outcome, QueryError, Tabs } from '../components/ui';
import { fmtDateTime, fmtDuration, fmtRelative } from '../lib/format';
import { nodeRoute } from '../lib/kinds';
import { SourceBadge } from './JobsPage';

export function JobDetailPage() {
  const { connId = '', jobId = '' } = useParams();
  const q = useJobDetail(connId, jobId);
  if (q.isLoading) return <Loading label="Loading job…" />;
  if (q.error || !q.data)
    return (
      <div className="page">
        <QueryError error={q.error} onRetry={() => q.refetch()} what="the job" />
      </div>
    );
  return <JobDetail key={jobId} connId={connId} job={q.data} />;
}

function JobDetail({ connId, job }: { connId: string; job: JobDetailView }) {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'steps';
  const stepParam = params.get('step');
  const setTab = (t: string) => setParams(t === 'steps' ? {} : { tab: t }, { replace: true });

  return (
    <div className="page" data-testid="job-detail">
      <div className="detail-header">
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="row" style={{ gap: 8, marginBottom: 4 }}>
            <KindBadge kind="job" />
            <SourceBadge source={job.source} />
            {job.enabled ? <Badge tone="ok">enabled</Badge> : <Badge tone="warn">disabled</Badge>}
            {job.targetsThisDb ? <Badge square>targets this database</Badge> : <Badge square outline>does not target this database</Badge>}
          </div>
          <h1 className="detail-title" style={{ fontFamily: 'var(--font-ui)' }} data-testid="detail-title">
            {job.name}
          </h1>
          {job.description ? <div className="text-2" style={{ marginTop: 4 }}>{job.description}</div> : null}
          <div className="detail-meta">
            <span>
              Last outcome: <Outcome value={job.lastRunOutcome} />
            </span>
            {job.lastExecution?.startTime ? <span>last run {fmtRelative(job.lastExecution.startTime)}</span> : null}
            {job.nextRun ? <span title={fmtDateTime(job.nextRun)}>next run {fmtRelative(job.nextRun)}</span> : null}
            {job.category ? <span>category {job.category}</span> : null}
            {job.owner ? <span className="mono">owner {job.owner}</span> : null}
            <span className="mono xsmall">{job.jobId}</span>
          </div>
        </div>
      </div>

      <section className="card" style={{ marginBottom: 14 }}>
        <div className="card-header">
          <h3>Schedules</h3>
          <span className="badge">{job.schedules.length}</span>
        </div>
        {job.schedules.length ? (
          <ul className="list-plain" style={{ padding: '4px 0' }} data-testid="schedules">
            {job.schedules.map((s, i) => (
              <li key={`${s.name}-${i}`}>
                <Icon name="clock" size={14} className="muted" />
                <span style={{ fontWeight: 550 }}>{s.name}</span>
                <span className="text-2 grow truncate">{s.text}</span>
                {!s.enabled ? <Badge tone="warn">disabled</Badge> : null}
                {/* per-schedule next run unknown while the job has one (Agent has not stored it per schedule): omit */}
                {s.nextRun || !job.nextRun ? (
                  <span className="small muted nowrap" title={fmtDateTime(s.nextRun)} data-testid="schedule-next-run">
                    {s.nextRun ? `next ${fmtDateTime(s.nextRun)}` : 'no next run'}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <div className="card-body muted small">No schedule — runs only when started manually or by another process.</div>
        )}
      </section>

      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'steps', label: 'Steps', count: job.steps.length },
          { id: 'executions', label: 'Executions', count: job.executions.length },
          { id: 'diagram', label: 'Diagram' },
          { id: 'ai', label: 'AI explanation' },
        ]}
      />

      {tab === 'steps' ? (
        <StepFlow connId={connId} job={job} initialStep={stepParam ? Number(stepParam) : null} />
      ) : tab === 'executions' ? (
        <Executions executions={job.executions} />
      ) : tab === 'diagram' ? (
        <DiagramTab connId={connId} nodeId={`job:${job.jobId}`} defaultDepth={3} />
      ) : (
        <AiPanel
          connId={connId}
          target={{ type: 'job', jobId: job.jobId }}
          ai={job.ai}
          hasSource={job.steps.length > 0}
          subject={`the job “${job.name}”`}
          onShowLines={(r) => setParams({ step: String(r[0]) }, { replace: true })}
        />
      )}
    </div>
  );
}

function flowTone(text: string | null): 'ok' | 'danger' | undefined {
  if (!text) return undefined;
  const t = text.toLowerCase();
  if (t.includes('failure')) return 'danger';
  if (t.includes('success') || t.includes('next step') || t.includes('go to step')) return 'ok';
  return undefined;
}

function StepFlow({ connId, job, initialStep }: { connId: string; job: JobDetailView; initialStep: number | null }) {
  const [open, setOpen] = useState<Set<number>>(() => new Set([initialStep ?? job.steps[0]?.stepId ?? 1]));
  const refs = useRef(new Map<number, HTMLDivElement>());
  useEffect(() => {
    if (initialStep === null) return;
    setOpen((s) => new Set([...s, initialStep]));
    const t = window.setTimeout(() => refs.current.get(initialStep)?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 50);
    return () => window.clearTimeout(t);
  }, [initialStep]);
  if (!job.steps.length) return <Empty icon="job" title="This job has no steps" />;
  const toggle = (id: number) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  return (
    <div className="flow" data-testid="step-flow">
      {job.steps.map((st, i) => {
        const last = i === job.steps.length - 1;
        return (
          <Fragment key={st.stepId}>
            <div ref={(el) => void (el ? refs.current.set(st.stepId, el) : refs.current.delete(st.stepId))}>
              <StepCard connId={connId} step={st} source={job.source} open={open.has(st.stepId)} onToggle={() => toggle(st.stepId)} selected={initialStep === st.stepId} />
            </div>
            {job.source === 'agent' ? (
              last ? (
                <div className="flow-end">
                  {st.onSuccess ? (
                    <span className="flow-tag" data-tone={flowTone(st.onSuccess)}>
                      <Icon name="check" size={12} /> on success: {st.onSuccess}
                    </span>
                  ) : null}
                  {st.onFail ? (
                    <span className="flow-tag" data-tone="danger">
                      <Icon name="x" size={12} /> on failure: {st.onFail}
                    </span>
                  ) : null}
                </div>
              ) : (
                <div className="flow-link">
                  <div className="stem" />
                  <div className="flow-labels">
                    <span className="flow-tag" data-tone={flowTone(st.onSuccess) ?? 'ok'}>
                      <Icon name="check" size={12} /> on success: {st.onSuccess ?? 'Go to the next step'}
                    </span>
                    {st.onFail ? (
                      <span className="flow-tag" data-tone="danger">
                        <Icon name="x" size={12} /> on failure: {st.onFail}
                      </span>
                    ) : null}
                  </div>
                </div>
              )
            ) : !last ? (
              <div className="flow-link">
                <div className="stem" />
                <div className="flow-labels muted">then</div>
              </div>
            ) : null}
          </Fragment>
        );
      })}
    </div>
  );
}

function StepCard({ connId, step, source, open, onToggle, selected }: { connId: string; step: JobStepView; source: 'agent' | 'elastic'; open: boolean; onToggle: () => void; selected: boolean }) {
  const a = step.analysis;
  const calls = a?.procCalls ?? [];
  const tables = a?.tables ?? [];
  return (
    <div className="step-card" data-selected={selected} data-testid="step-card">
      <div className="step-head" onClick={onToggle} role="button" aria-expanded={open} tabIndex={0} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onToggle())}>
        <span className="step-num">{step.stepId}</span>
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <strong>{step.name}</strong>
            {step.subsystem ? <Badge square>{step.subsystem}</Badge> : null}
            {step.databaseName ? (
              <span className="mono small text-2" title="Database the step runs in">
                <Icon name="database" size={11} /> {step.databaseName}
              </span>
            ) : null}
            {step.targetGroupName ? <span className="small text-2">target group {step.targetGroupName}</span> : null}
            {step.targetsThisDb ? (
              <Badge square tone="ok">this DB</Badge>
            ) : (
              <Badge square outline title={step.targetMatch ? `target match: ${step.targetMatch}` : undefined}>
                other DB
              </Badge>
            )}
            {!step.analyzable ? <Badge square tone="warn">not analyzable</Badge> : null}
          </div>
          <div className="row small muted" style={{ gap: 12, marginTop: 3, flexWrap: 'wrap' }}>
            {calls.length ? (
              <span className="row" style={{ gap: 4 }}>
                runs
                {calls.slice(0, 4).map((c, i) => {
                  const r = a?.resolved?.[c.ref.key];
                  const route = r?.nodeId && r.exists ? nodeRoute(connId, r.nodeId) : null;
                  return route ? (
                    <Link key={i} className="mono" to={route} onClick={(e) => e.stopPropagation()}>
                      {c.ref.display}
                    </Link>
                  ) : (
                    <span key={i} className="mono">
                      {c.ref.display}
                    </span>
                  );
                })}
                {calls.length > 4 ? <span>+{calls.length - 4}</span> : null}
              </span>
            ) : null}
            {tables.length ? <span>touches {tables.length} table{tables.length === 1 ? '' : 's'}</span> : null}
            {step.retryAttempts ? (
              <span>
                retries {step.retryAttempts}
                {step.retryIntervalMinutes ? ` every ${step.retryIntervalMinutes} min` : ''}
              </span>
            ) : (
              <span>no retries</span>
            )}
            {step.stepTimeoutSeconds ? <span>timeout {fmtDuration(step.stepTimeoutSeconds)}</span> : null}
          </div>
        </div>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} className="muted" />
      </div>
      {open ? (
        <div className="step-body stack-md">
          {source === 'elastic' && step.targetMembers.length ? (
            <div>
              <div className="field-label" style={{ marginBottom: 4 }}>
                Target group {step.targetGroupName}
              </div>
              <ul className="list-plain small" style={{ border: '1px solid var(--border)', borderRadius: 6 }}>
                {step.targetMembers.map((m, i) => (
                  <li key={i}>
                    <Badge square tone={m.membershipType.toLowerCase() === 'exclude' ? 'danger' : 'ok'}>
                      {m.membershipType}
                    </Badge>
                    <span>{m.targetType}</span>
                    <span className="mono text-2 truncate">{[m.serverName, m.elasticPoolName, m.databaseName].filter(Boolean).join(' / ')}</span>
                  </li>
                ))}
              </ul>
              {step.credentialName ? <div className="xsmall muted" style={{ marginTop: 4 }}>credential {step.credentialName}</div> : null}
            </div>
          ) : null}
          {tables.length ? (
            <div className="row-wrap">
              <span className="small muted">Tables:</span>
              {tables.map((t) => {
                const r = a?.resolved?.[t.ref.key];
                const route = r?.nodeId && r.exists ? nodeRoute(connId, r.nodeId) : null;
                const body = (
                  <>
                    <KindGlyph kind={t.ref.database ? 'external' : r?.kind && r.kind !== 'unknown' ? r.kind : 'unknown'} />
                    <span className="mono">{t.ref.display}</span>
                    <OpBadges ops={t.ops} />
                  </>
                );
                return route ? (
                  <Link key={t.ref.key} to={route} className="chip" style={{ color: 'inherit', textDecoration: 'none' }}>
                    {body}
                  </Link>
                ) : (
                  <span key={t.ref.key} className="chip dashed">
                    {body}
                  </span>
                );
              })}
            </div>
          ) : null}
          {step.analyzable ? (
            <ExplainView
              connId={connId}
              code={step.command}
              analysis={a}
              compact
              testIdPrefix={`step-${step.stepId}`}
              emptyAnalysisMessage="This step's command has not been analyzed yet."
            />
          ) : (
            <>
              <Callout tone="info" title={`${step.subsystem ?? step.commandType} step — not analyzed`}>
                Only T-SQL steps can be statically analyzed. The command is shown as text.
              </Callout>
              <div className="code-panel">
                <CodeView code={step.command} selected={null} maxHeight="320px" />
              </div>
            </>
          )}
          {step.outputFileName ? <div className="xsmall muted mono">output file {step.outputFileName}</div> : null}
          {!a && step.analyzable ? (
            <div className="small muted">Analysis not available — run a refresh to see the outline, tables and procedures this step runs.</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Executions({ executions }: { executions: JobExecution[] }) {
  const [openId, setOpenId] = useState<string | null>(null);
  if (!executions.length) return <Empty icon="clock" title="No executions recorded" body="msdb job history (or the Elastic Jobs execution views) has no rows for this job." />;
  return (
    <div className="table-wrap" data-testid="executions-table">
      <table className="data">
        <thead>
          <tr>
            <th>Status</th>
            <th>Started</th>
            <th className="num">Duration</th>
            <th>Step</th>
            <th>Target</th>
            <th>Message</th>
          </tr>
        </thead>
        <tbody>
          {executions.map((e, idx) => {
            const key = `${e.jobExecutionId}-${e.stepId ?? 'job'}-${idx}`;
            const isOpen = openId === key;
            return (
              <Fragment key={key}>
                <tr className={e.lastMessage ? 'clickable' : undefined} onClick={() => e.lastMessage && setOpenId(isOpen ? null : key)}>
                  <td>
                    <Outcome value={e.runStatus ?? e.lifecycle} />
                  </td>
                  <td className="small nowrap" title={e.startTime ?? undefined}>
                    {fmtDateTime(e.startTime ?? e.createTime)}
                  </td>
                  <td className="num small">{fmtDuration(e.durationSeconds)}</td>
                  <td className="small">
                    {e.stepId === null || e.stepId === 0 ? (
                      <span className="muted">(job outcome)</span>
                    ) : (
                      <>
                        <span className="mono">#{e.stepId}</span> {e.stepName}
                      </>
                    )}
                  </td>
                  <td className="mono small text-2">{[e.targetServerName, e.targetDatabaseName].filter(Boolean).join(' / ') || '—'}</td>
                  <td className="small text-2" style={{ maxWidth: 420 }}>
                    {e.lastMessage ? (
                      <span className="row" style={{ gap: 4 }}>
                        <Icon name={isOpen ? 'chevronDown' : 'chevronRight'} size={12} />
                        <span className={isOpen ? undefined : 'truncate'} style={isOpen ? undefined : { display: 'block' }}>
                          {isOpen ? 'hide message' : e.lastMessage}
                        </span>
                      </span>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
                {isOpen ? (
                  <tr>
                    <td colSpan={6} style={{ background: 'var(--surface-2)' }}>
                      <pre className="mono small" style={{ margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }} data-testid="execution-message">
                        {e.lastMessage}
                      </pre>
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
