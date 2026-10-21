import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useJobs, useSummary } from '../api/hooks';
import type { JobSummary } from '../api/types';
import { Icon } from '../components/Icon';
import { Badge, DataTable, Empty, KindGlyph, Loading, Outcome, QueryError, SearchInput, Segmented, outcomeTone } from '../components/ui';
import { fmtDateTime, fmtNumber, fmtRelative } from '../lib/format';
import { fuzzyScore } from '../lib/fuzzy';
import { jobPath } from '../lib/kinds';

type SourceFilter = 'all' | 'agent' | 'elastic';
type EnabledFilter = 'all' | 'enabled' | 'disabled';
type OutcomeFilter = 'all' | 'failed' | 'succeeded' | 'other';

export function SourceBadge({ source }: { source: 'agent' | 'elastic' }) {
  return (
    <Badge square tone={source === 'agent' ? 'accent' : 'info'} title={source === 'agent' ? 'SQL Server Agent (msdb)' : 'Azure Elastic Jobs'}>
      {source === 'agent' ? 'Agent' : 'Elastic'}
    </Badge>
  );
}

export function JobsPage() {
  const { connId = '' } = useParams();
  const q = useJobs(connId);
  const summary = useSummary(connId);
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [source, setSource] = useState<SourceFilter>('all');
  const [enabled, setEnabled] = useState<EnabledFilter>('all');
  const [outcome, setOutcome] = useState<OutcomeFilter>('all');

  const all = useMemo(() => q.data ?? [], [q.data]);
  const rows = useMemo(() => {
    let r = all.filter((j) => {
      if (source !== 'all' && j.source !== source) return false;
      if (enabled === 'enabled' && !j.enabled) return false;
      if (enabled === 'disabled' && j.enabled) return false;
      const tone = outcomeTone(j.lastRunOutcome);
      if (outcome === 'failed' && tone !== 'danger') return false;
      if (outcome === 'succeeded' && tone !== 'ok') return false;
      if (outcome === 'other' && (tone === 'danger' || tone === 'ok')) return false;
      return true;
    });
    if (search.trim()) r = r.filter((j) => fuzzyScore(search, j.name));
    return r;
  }, [all, source, enabled, outcome, search]);

  const hasElastic = all.some((j) => j.source === 'elastic');
  const hasAgent = all.some((j) => j.source === 'agent');

  return (
    <div className="page" data-testid="jobs-page">
      <div className="page-header">
        <div className="grow">
          <h1 className="page-title">Jobs</h1>
          <div className="page-subtitle">
            {q.data ? `${fmtNumber(rows.length)} of ${fmtNumber(all.length)} · SQL Agent jobs from msdb${hasElastic || summary.data?.connection.jobs ? ' and Elastic Jobs' : ''}` : ' '}
          </div>
        </div>
      </div>
      <div className="toolbar">
        <SearchInput value={search} onChange={setSearch} placeholder="Filter jobs…" width={260} />
        {hasAgent && hasElastic ? (
          <Segmented<SourceFilter>
            label="Source"
            value={source}
            onChange={setSource}
            options={[
              { value: 'all', label: 'All sources' },
              { value: 'agent', label: 'Agent' },
              { value: 'elastic', label: 'Elastic' },
            ]}
          />
        ) : null}
        <Segmented<EnabledFilter>
          label="Enabled"
          value={enabled}
          onChange={setEnabled}
          options={[
            { value: 'all', label: 'All' },
            { value: 'enabled', label: 'Enabled' },
            { value: 'disabled', label: 'Disabled' },
          ]}
        />
        <Segmented<OutcomeFilter>
          label="Last outcome"
          value={outcome}
          onChange={setOutcome}
          options={[
            { value: 'all', label: 'Any outcome' },
            { value: 'failed', label: 'Failed' },
            { value: 'succeeded', label: 'Succeeded' },
            { value: 'other', label: 'Other' },
          ]}
        />
      </div>
      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <QueryError error={q.error} onRetry={() => q.refetch()} what="jobs" />
      ) : (
        <DataTable<JobSummary>
          rows={rows}
          rowKey={(j) => j.jobId}
          initialSort={{ id: 'name', dir: 'asc' }}
          onRowClick={(j) => navigate(jobPath(connId, j.jobId))}
          testId="jobs-table"
          maxHeight="calc(100vh - 210px)"
          empty={
            <Empty
              compact
              title={all.length ? 'No jobs match the filters' : 'No jobs cached'}
              body={all.length ? undefined : 'SQL Agent jobs need SQLAgentReaderRole in msdb; Elastic Jobs need a job database in the connection.'}
            />
          }
          columns={[
            {
              id: 'name',
              header: 'Job',
              cell: (j) => (
                <span className="row" style={{ gap: 8 }}>
                  <KindGlyph kind="job" />
                  <span style={{ fontWeight: 550 }}>{j.name}</span>
                </span>
              ),
              sort: (j) => j.name.toLowerCase(),
            },
            { id: 'source', header: 'Source', cell: (j) => <SourceBadge source={j.source} />, sort: (j) => j.source, width: 80 },
            {
              id: 'enabled',
              header: 'Enabled',
              cell: (j) => (j.enabled ? <span className="small">yes</span> : <Badge tone="warn">disabled</Badge>),
              sort: (j) => (j.enabled ? 1 : 0),
              width: 80,
            },
            { id: 'schedule', header: 'Schedule', cell: (j) => <span className="small text-2">{j.scheduleText || '—'}</span>, sort: (j) => j.scheduleText },
            { id: 'outcome', header: 'Last outcome', cell: (j) => <Outcome value={j.lastRunOutcome} />, sort: (j) => j.lastRunOutcome ?? '', width: 150 },
            {
              id: 'last',
              header: 'Last run',
              cell: (j) => <span className="small text-2 nowrap" title={fmtDateTime(j.lastExecution?.startTime)}>{j.lastExecution?.startTime ? fmtRelative(j.lastExecution.startTime) : '—'}</span>,
              sort: (j) => j.lastExecution?.startTime ?? '',
              width: 100,
            },
            {
              id: 'next',
              header: 'Next run',
              cell: (j) => <span className="small text-2 nowrap" title={fmtDateTime(j.nextRun)}>{j.nextRun ? fmtRelative(j.nextRun) : '—'}</span>,
              sort: (j) => j.nextRun ?? '',
              width: 100,
            },
            { id: 'steps', header: 'Steps', className: 'num', cell: (j) => j.stepCount, sort: (j) => j.stepCount, width: 60 },
            {
              id: 'targets',
              header: 'This DB',
              title: 'At least one step runs against this connection’s database',
              cell: (j) =>
                j.targetsThisDb ? (
                  <span className="row small" style={{ gap: 4, color: 'var(--ok)' }}>
                    <Icon name="check" size={13} /> targets
                  </span>
                ) : (
                  <span className="small muted">other</span>
                ),
              sort: (j) => (j.targetsThisDb ? 1 : 0),
              width: 80,
            },
          ]}
        />
      )}
    </div>
  );
}
