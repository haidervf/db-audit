import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { errorMessage, isApiError } from '../api/client';
import { invalidateConnectionData, useCancelRefresh, useRun, useRuns, useStartRefresh } from '../api/hooks';
import type { ObjectKind, RefreshRun, RunWarning, Segment, WarningObjectRef } from '../api/types';
import { CopyButton } from '../components/CopyButton';
import { Icon } from '../components/Icon';
import { JobChip, ObjectChip, nameKey, refLabel, useObjIndex, type ObjIndex } from '../components/ObjectChip';
import { Badge, Callout, Dialog, Segmented, Spinner } from '../components/ui';
import { durationBetween, fmtDateTime, fmtDuration, fmtNumber, plural } from '../lib/format';
import { hintFor } from '../lib/hints';

export const SEGMENT_OPTIONS: Array<{ id: Segment; label: string; hint?: string }> = [
  { id: 'tables', label: 'Tables' },
  { id: 'views', label: 'Views' },
  { id: 'functions', label: 'Functions' },
  { id: 'procedures', label: 'Procedures' },
  { id: 'triggers', label: 'Triggers' },
  { id: 'dependencies', label: 'Dependencies' },
  { id: 'jobs', label: 'Jobs' },
  { id: 'analysis', label: 'Analysis', hint: 're-analyze cached code, no DB access' },
];

type ObjectTarget = { kind: ObjectKind; schema: string; name: string };

interface RefreshCtx {
  openRefresh: (opts?: { objects?: ObjectTarget[] }) => void;
}

const Ctx = createContext<RefreshCtx>({ openRefresh: () => undefined });

export function useRefreshDialog(): RefreshCtx {
  return useContext(Ctx);
}

export function RefreshProvider({ connId, children }: { connId: string | null; children: ReactNode }) {
  const [state, setState] = useState<{ open: boolean; objects?: ObjectTarget[]; nonce: number }>({ open: false, nonce: 0 });
  useRunWatcher(connId);
  return (
    <Ctx.Provider value={{ openRefresh: (o) => setState((s) => ({ open: true, objects: o?.objects, nonce: s.nonce + 1 })) }}>
      {children}
      {connId && state.open ? (
        <RefreshDialog key={`${connId}-${state.nonce}`} connId={connId} objects={state.objects} onClose={() => setState((s) => ({ ...s, open: false }))} />
      ) : null}
    </Ctx.Provider>
  );
}

/** When a run of this connection finishes (seen running, now done), refetch everything for the connection. */
function useRunWatcher(connId: string | null) {
  const qc = useQueryClient();
  const runs = useRuns(connId ?? undefined);
  const seenRunning = useRef(new Set<string>());
  useEffect(() => {
    if (!connId || !runs.data) return;
    let finished = false;
    for (const r of runs.data) {
      if (r.status === 'running') seenRunning.current.add(r.id);
      else if (seenRunning.current.has(r.id)) {
        seenRunning.current.delete(r.id);
        finished = true;
      }
    }
    if (finished) void invalidateConnectionData(qc, connId);
  }, [runs.data, connId, qc]);
}

export function activeRun(runs: RefreshRun[] | undefined): RefreshRun | null {
  return runs?.find((r) => r.status === 'running') ?? null;
}

export function runTone(status: RefreshRun['status']): 'ok' | 'warn' | 'danger' | 'info' {
  return status === 'succeeded' ? 'ok' : status === 'partial' || status === 'cancelled' ? 'warn' : status === 'failed' ? 'danger' : 'info';
}

function RefreshDialog({ connId, objects, onClose }: { connId: string; objects?: ObjectTarget[]; onClose: () => void }) {
  const qc = useQueryClient();
  const runs = useRuns(connId);
  const start = useStartRefresh(connId);
  const [segments, setSegments] = useState<Set<Segment>>(() => new Set(SEGMENT_OPTIONS.map((s) => s.id)));
  const [mode, setMode] = useState<'incremental' | 'full'>(objects?.length ? 'full' : 'incremental');
  const [runId, setRunId] = useState<string | null>(null);
  const running = activeRun(runs.data);
  const trackedId = runId ?? running?.id ?? null;
  const run = useRun(connId, trackedId);
  const r = run.data ?? (running && running.id === trackedId ? running : null);
  const done = r && r.status !== 'running';
  const invalidated = useRef<string | null>(null);

  useEffect(() => {
    if (r && r.status !== 'running' && invalidated.current !== r.id) {
      invalidated.current = r.id;
      void invalidateConnectionData(qc, connId);
    }
  }, [r, qc, connId]);

  const allSelected = segments.size === SEGMENT_OPTIONS.length;
  const toggle = (s: Segment) =>
    setSegments((cur) => {
      const n = new Set(cur);
      if (n.has(s)) n.delete(s);
      else n.add(s);
      return n;
    });

  const submit = () => {
    start.mutate(
      objects?.length
        ? { segments: 'all', mode: 'full', objects }
        : { segments: allSelected ? 'all' : SEGMENT_OPTIONS.map((s) => s.id).filter((s) => segments.has(s)), mode },
      {
        onSuccess: (res) => setRunId(res.runId),
        onError: (e) => {
          if (isApiError(e, 409)) void runs.refetch();
        },
      },
    );
  };

  const busy = Boolean(r && r.status === 'running');
  const pct = r && r.progress.total > 0 ? Math.min(100, Math.round((r.progress.done / r.progress.total) * 100)) : 0;

  return (
    <Dialog
      open
      onClose={onClose}
      wide
      title={objects?.length ? 'Refresh object' : 'Refresh cache'}
      footer={
        <>
          {done ? (
            <button className="btn" onClick={() => setRunId(null)} disabled={start.isPending} data-testid="refresh-again">
              New run
            </button>
          ) : null}
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            {busy ? 'Run in background' : 'Close'}
          </button>
          {!r ? (
            <button
              className="btn btn-primary"
              onClick={submit}
              disabled={start.isPending || (!objects?.length && segments.size === 0)}
              data-testid="refresh-run"
            >
              {start.isPending ? <Spinner /> : <Icon name="play" size={13} />}
              Run refresh
            </button>
          ) : null}
        </>
      }
    >
      <div className="dialog-body stack-md" data-testid="refresh-dialog">
        {!r ? (
          <>
            {objects?.length ? (
              <Callout tone="info" title="Only this object">
                Re-fetches{' '}
                {objects.map((o) => (
                  <code key={`${o.kind}${o.schema}${o.name}`}>
                    {o.schema}.{o.name}
                  </code>
                ))}{' '}
                and its dependencies from the database, then re-analyzes it.
              </Callout>
            ) : (
              <>
                <div>
                  <div className="row" style={{ marginBottom: 8 }}>
                    <span className="field-label">Segments</span>
                    <span className="spacer" />
                    <button
                      type="button"
                      className="btn btn-ghost btn-xs"
                      onClick={() => setSegments(allSelected ? new Set() : new Set(SEGMENT_OPTIONS.map((s) => s.id)))}
                    >
                      {allSelected ? 'Clear all' : 'Select all'}
                    </button>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '8px 16px' }}>
                    {SEGMENT_OPTIONS.map((s) => (
                      <label key={s.id} className="check" style={s.hint ? { gridColumn: '1 / -1' } : undefined}>
                        <input type="checkbox" checked={segments.has(s.id)} onChange={() => toggle(s.id)} data-testid={`segment-${s.id}`} />
                        <span>
                          {s.label}
                          {s.hint ? <span className="muted"> — {s.hint}</span> : null}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
                <div className="field">
                  <span className="field-label">Mode</span>
                  <div className="row">
                    <Segmented
                      label="Refresh mode"
                      value={mode}
                      onChange={setMode}
                      options={[
                        { value: 'incremental', label: 'Incremental' },
                        { value: 'full', label: 'Full' },
                      ]}
                    />
                    <span className="small muted">
                      {mode === 'incremental' ? 'Only new or changed objects are re-fetched (by modify date).' : 'Re-fetches everything in the selected segments.'}
                    </span>
                  </div>
                </div>
                <div className="small muted">
                  Every statement sent to the database is read-only. Jobs are always re-read in full.
                </div>
              </>
            )}
            {start.error ? (
              <Callout tone="danger" title={isApiError(start.error, 409) ? 'A refresh is already running' : 'Could not start the refresh'}>
                {errorMessage(start.error)}
              </Callout>
            ) : null}
          </>
        ) : (
          <RunView run={r} pct={pct} />
        )}
      </div>
    </Dialog>
  );
}

/** `runHeaderInCopy`: "Copy all" of the warnings starts with a run header line (id, status, start time). */
export function RunView({ run, pct, runHeaderInCopy }: { run: RefreshRun; pct?: number; runHeaderInCopy?: boolean }) {
  const p = pct ?? (run.progress.total > 0 ? Math.round((run.progress.done / run.progress.total) * 100) : 0);
  const running = run.status === 'running';
  const cancel = useCancelRefresh(run.connectionId);
  const segs = Object.entries(run.counts) as Array<[Segment, { added: number; updated: number; removed: number; unchanged: number }]>;
  return (
    <div className="stack-md" data-testid="refresh-run-view" data-status={run.status}>
      <div className="row">
        {running ? <Spinner /> : <Icon name={run.status === 'succeeded' ? 'check' : 'alert'} />}
        <strong>
          {running
            ? 'Refreshing…'
            : run.status === 'succeeded'
              ? 'Refresh complete'
              : run.status === 'partial'
                ? 'Refresh partially succeeded'
                : run.status === 'cancelled'
                  ? 'Refresh cancelled'
                  : 'Refresh failed'}
        </strong>
        <Badge tone={runTone(run.status)}>{run.status}</Badge>
        <span className="spacer" />
        <span className="small muted">
          {running ? `${run.progress.phase}${run.progress.step ? ` · ${run.progress.step}` : ''} · ${run.progress.done}/${run.progress.total}` : `took ${fmtDuration(durationBetween(run.startedAt, run.finishedAt))}`}
        </span>
        {running ? (
          <button className="btn btn-sm" onClick={() => cancel.mutate(run.id)} disabled={cancel.isPending || cancel.isSuccess} data-testid="refresh-cancel">
            {cancel.isPending || cancel.isSuccess ? <Spinner /> : <Icon name="x" size={13} />}
            {cancel.isPending || cancel.isSuccess ? 'Cancelling…' : 'Cancel'}
          </button>
        ) : null}
      </div>
      {running && cancel.error ? (
        <Callout tone="danger" title="Could not cancel the refresh">
          {errorMessage(cancel.error)}
        </Callout>
      ) : null}
      <div className={`progress${running && run.progress.total === 0 ? ' indeterminate' : ''}`} aria-label="Refresh progress">
        <div style={{ width: `${running ? p : 100}%`, background: run.status === 'failed' ? 'var(--danger)' : run.status === 'partial' || run.status === 'cancelled' ? 'var(--warn)' : undefined }} />
      </div>
      {run.error ? (
        <Callout tone={run.status === 'cancelled' ? 'warn' : 'danger'} title={run.status === 'cancelled' ? 'Cancelled' : 'Error'}>
          {run.error}
          {hintFor(run.error) ? <div className="fix">{hintFor(run.error)}</div> : null}
        </Callout>
      ) : null}
      {segs.length ? (
        <div className="table-wrap">
          <table className="data compact">
            <thead>
              <tr>
                <th>Segment</th>
                <th className="num">Added</th>
                <th className="num">Updated</th>
                <th className="num">Removed</th>
                <th className="num">Unchanged</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              {segs.map(([s, c]) => (
                <tr key={s}>
                  <td style={{ textTransform: 'capitalize' }}>{s}</td>
                  <td className="num">{fmtNumber(c.added)}</td>
                  <td className="num">{fmtNumber(c.updated)}</td>
                  <td className="num">{fmtNumber(c.removed)}</td>
                  <td className="num muted">{fmtNumber(c.unchanged)}</td>
                  <td className="small" style={{ color: 'var(--danger)' }}>
                    {run.segmentErrors?.[s] ?? ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {run.segmentErrors && Object.keys(run.segmentErrors).some((k) => !(k in run.counts)) ? (
        <Callout tone="danger" title="Segment errors">
          {Object.entries(run.segmentErrors).map(([k, v]) => (
            <div key={k}>
              <strong>{k}:</strong> {v}
            </div>
          ))}
        </Callout>
      ) : null}
      {run.warningDetails.length ? (
        <WarningsList connId={run.connectionId} warnings={run.warningDetails} copyHeader={runHeaderInCopy ? runCopyHeader(run) : undefined} />
      ) : null}
    </div>
  );
}

export function runCopyHeader(run: RefreshRun): string {
  return `Refresh run ${run.id} · ${run.status} · started ${fmtDateTime(run.startedAt)}`;
}

const CHIP_LIMIT = 10;

/** Plain-text form of a warning: the message, one line per object (`<kind> <schema>.<name>`), then the job if any. */
export function warningText(w: RunWarning): string {
  const lines = [w.message];
  for (const o of w.objects ?? []) lines.push(`${o.kind} ${refLabel(o)}`);
  if (w.job) lines.push(`job ${w.job.name}`);
  return lines.join('\n');
}

export function warningsText(warnings: RunWarning[], header?: string): string {
  const body = warnings.map(warningText).join('\n\n');
  return header ? `${header}\n\n${body}` : body;
}

const IDENT = String.raw`(?:\[((?:[^\]]|\]\])+)\]|([A-Za-z_@#][\w@#$]*))`;
/** exactly two-part names (`schema.name`, either part optionally bracketed); parts of 3/4-part names are skipped */
const TWO_PART = new RegExp(String.raw`(?<![\w@#$\].\[])${IDENT}\.${IDENT}(?![\w@#$]|\.[\[A-Za-z_@#])`, 'g');

/** Fallback for warnings without refs (older runs): `schema.name` tokens in the message that exist in the cache. */
function inferRefs(message: string, index: ObjIndex): WarningObjectRef[] {
  const out: WarningObjectRef[] = [];
  const seen = new Set<string>();
  for (const m of message.matchAll(TWO_PART)) {
    const schema = m[1] !== undefined ? m[1].replace(/\]\]/g, ']') : m[2];
    const name = m[3] !== undefined ? m[3].replace(/\]\]/g, ']') : m[4];
    for (const o of index.byName.get(nameKey(schema, name)) ?? []) {
      const k = `${o.kind}:${nameKey(o.schema, o.name)}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ kind: o.kind, schema: o.schema, name: o.name });
    }
  }
  return out;
}

/** Warnings with hints, object / job chips and copy buttons. `copyHeader`: first line of "Copy all". */
export function WarningsList({ connId, warnings, max, copyHeader }: { connId: string; warnings: RunWarning[]; max?: number; copyHeader?: string }) {
  const [all, setAll] = useState(false);
  const index = useObjIndex(connId);
  const shown = max && !all ? warnings.slice(0, max) : warnings;
  return (
    <div className="stack-sm" data-testid="warnings">
      <div className="row">
        <span className="small muted grow">{plural(warnings.length, 'warning')}</span>
        <CopyButton label="Copy all" title="Copy all warnings" text={() => warningsText(warnings, copyHeader)} testId="warnings-copy-all" />
      </div>
      {shown.map((w, i) => (
        <WarningItem key={i} connId={connId} warning={w} index={index} />
      ))}
      {max && warnings.length > max ? (
        <button className="btn btn-ghost btn-sm" onClick={() => setAll((v) => !v)}>
          {all ? 'Show fewer' : `Show all ${warnings.length} warnings`}
        </button>
      ) : null}
    </div>
  );
}

function WarningItem({ connId, warning: w, index }: { connId: string; warning: RunWarning; index: ObjIndex | null }) {
  const [more, setMore] = useState(false);
  const hint = hintFor(w.message);
  const explicit = Boolean(w.objects?.length || w.job);
  const refs = explicit ? (w.objects ?? []) : index ? inferRefs(w.message, index) : [];
  const shownRefs = more ? refs : refs.slice(0, CHIP_LIMIT);
  return (
    <div className="callout" data-tone="warn" style={{ padding: '7px 10px' }} data-testid="warning">
      <Icon name="alert" size={14} />
      <div className="grow" style={{ minWidth: 0 }}>
        <div style={{ overflowWrap: 'anywhere' }}>{w.message}</div>
        {hint ? <div className="fix">{hint}</div> : null}
        {refs.length || w.job ? (
          <div className="warning-refs" data-testid="warning-refs">
            {shownRefs.map((o) => (
              <ObjectChip key={`${o.kind}:${o.schema}.${o.name}`} connId={connId} obj={o} index={index} />
            ))}
            {refs.length > CHIP_LIMIT ? (
              <button type="button" className="btn btn-ghost btn-xs" onClick={() => setMore((v) => !v)}>
                {more ? 'Show fewer' : `+${refs.length - CHIP_LIMIT} more`}
              </button>
            ) : null}
            {w.job ? <JobChip connId={connId} job={w.job} /> : null}
          </div>
        ) : null}
      </div>
      <CopyButton text={() => warningText(w)} title="Copy warning" testId="warning-copy" />
    </div>
  );
}
