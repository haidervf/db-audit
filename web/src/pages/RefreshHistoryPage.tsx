import { Fragment, useMemo, type KeyboardEvent } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { useRunHistory } from '../api/hooks';
import type { RefreshRun } from '../api/types';
import { Icon } from '../components/Icon';
import { Badge, Callout, Empty, Loading, QueryError, Spinner } from '../components/ui';
import { durationBetween, fmtDateTime, fmtDuration, fmtNumber, fmtRelative, plural } from '../lib/format';
import { RunView, runTone } from '../shell/RefreshDialog';

/** Same wording as the Overview's "Recent refresh runs" list. */
function requestSummary(r: RefreshRun): string {
  if (r.request.objects?.length) return `${r.request.objects.length} object(s)`;
  return `${r.request.mode} · ${r.request.segments === 'all' ? 'all' : r.request.segments.join(', ')}`;
}

export function RefreshHistoryPage() {
  const { connId = '' } = useParams();
  const q = useRunHistory(connId);
  const [params, setParams] = useSearchParams();
  const openId = params.get('run');

  const runs = useMemo(() => {
    const seen = new Set<string>();
    const out: RefreshRun[] = [];
    for (const page of q.data?.pages ?? [])
      for (const r of page)
        if (!seen.has(r.id)) {
          seen.add(r.id);
          out.push(r);
        }
    return out;
  }, [q.data]);

  const toggle = (id: string) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        if (n.get('run') === id) n.delete('run');
        else n.set('run', id);
        return n;
      },
      { replace: true },
    );
  const onKey = (e: KeyboardEvent, id: string) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggle(id);
    }
  };
  const openMissing = Boolean(openId && q.data && !runs.some((r) => r.id === openId));

  return (
    <div className="page" data-testid="refresh-history-page">
      <div className="page-header">
        <div className="grow">
          <h1 className="page-title">Refresh history</h1>
          <div className="page-subtitle">{q.data ? `${plural(runs.length, 'run')}${q.hasNextPage ? ' loaded' : ''} · newest first` : ' '}</div>
        </div>
      </div>
      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <QueryError error={q.error} onRetry={() => q.refetch()} what="the refresh history" />
      ) : !runs.length ? (
        <div className="card">
          <Empty icon="clock" title="No refresh runs yet" body="Every refresh of this connection is listed here once it has run." />
        </div>
      ) : (
        <div className="stack-md">
          {openMissing ? (
            <Callout
              tone="info"
              title="Linked run not shown"
              action={
                q.hasNextPage ? (
                  <button className="btn btn-sm" onClick={() => q.fetchNextPage()} disabled={q.isFetchingNextPage}>
                    Load more
                  </button>
                ) : undefined
              }
            >
              Run <code>{openId}</code> {q.hasNextPage ? 'is not among the loaded runs.' : 'was not found for this connection.'}
            </Callout>
          ) : null}
          <div className="table-wrap">
            <table className="data compact run-history" data-testid="run-history">
              <thead>
                <tr>
                  <th style={{ width: 28 }} aria-label="Expand" />
                  <th>Status</th>
                  <th>Started</th>
                  <th className="num">Duration</th>
                  <th className="run-col-opt">Request</th>
                  <th className="num">Warnings</th>
                  <th className="run-col-opt">Error</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => {
                  const open = r.id === openId;
                  return (
                    <Fragment key={r.id}>
                      <tr
                        className={`clickable${open ? ' expanded' : ''}`}
                        onClick={() => toggle(r.id)}
                        onKeyDown={(e) => onKey(e, r.id)}
                        tabIndex={0}
                        aria-expanded={open}
                        data-testid="run-row"
                        data-run-id={r.id}
                        data-status={r.status}
                      >
                        <td className="muted">
                          <Icon name={open ? 'chevronDown' : 'chevronRight'} size={13} />
                        </td>
                        <td>
                          <Badge tone={runTone(r.status)}>{r.status}</Badge>
                        </td>
                        <td className="nowrap">
                          {fmtDateTime(r.startedAt)} <span className="run-rel muted small">({fmtRelative(r.startedAt)})</span>
                        </td>
                        <td className="num nowrap">{r.status === 'running' ? <span className="muted">running</span> : fmtDuration(durationBetween(r.startedAt, r.finishedAt))}</td>
                        <td className="run-col-opt small">{requestSummary(r)}</td>
                        <td className="num">{r.warnings.length ? <Badge tone="warn">{fmtNumber(r.warnings.length)}</Badge> : <span className="muted">0</span>}</td>
                        <td className="run-col-opt">
                          {r.error ? (
                            <span className="run-error truncate small" title={r.error}>
                              {r.error}
                            </span>
                          ) : null}
                        </td>
                      </tr>
                      {open ? (
                        <tr className="run-detail-row">
                          <td colSpan={7} data-testid="run-detail">
                            <RunView run={r} runHeaderInCopy />
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          {q.hasNextPage ? (
            <div className="row" style={{ justifyContent: 'center' }}>
              <button className="btn btn-sm" onClick={() => q.fetchNextPage()} disabled={q.isFetchingNextPage} data-testid="runs-load-more">
                {q.isFetchingNextPage ? <Spinner /> : null}
                Load more
              </button>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
