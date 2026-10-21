import { Link } from 'react-router';
import type { Dependency, GraphEdge, JobUsing, ObjectDetailView, UsageEdge } from '../api/types';
import { displayOps, jobPath, nodeRoute, objectNodeId, opLabel, WRITE_OPS } from '../lib/kinds';
import { Badge, Empty, KindGlyph, OpBadges, OriginBadge } from './ui';

/** Phase A fallback: server dependencies shaped like UsageEdge (used when the server sends no uses/usedBy). */
function depToUsage(d: Dependency, direction: 'in' | 'out'): UsageEdge {
  const other = direction === 'out' ? d.to : { ...d.from, server: null, database: null, resolved: true };
  const kind = direction === 'out' ? d.to.kind : d.from.kind;
  const relation: GraphEdge['relation'] = d.isUpdated ? 'writes' : d.isSelected ? 'reads' : kind === 'procedure' ? 'calls' : 'references';
  const local = kind !== 'external' && kind !== 'unknown' && other.schema;
  const label = [other.server, other.database, other.schema, other.name].filter(Boolean).join('.');
  return {
    nodeId: local ? objectNodeId(kind, other.schema, other.name) : `${kind}:${label}`,
    kind,
    label,
    relation,
    ops: [],
    origin: ['server'],
    direction,
  };
}

export function usesOf(d: ObjectDetailView): UsageEdge[] {
  return d.uses ?? d.references.map((r) => depToUsage(r, 'out'));
}

export function usedByOf(d: ObjectDetailView): UsageEdge[] {
  return d.usedBy ?? d.referencedBy.map((r) => depToUsage(r, 'in'));
}

const OUT_GROUPS: Array<{ rel: GraphEdge['relation']; label: string }> = [
  { rel: 'writes', label: 'Writes' },
  { rel: 'reads', label: 'Reads' },
  { rel: 'calls', label: 'Calls' },
  { rel: 'references', label: 'References' },
  { rel: 'trigger-on', label: 'Trigger on' },
  { rel: 'fk', label: 'Foreign keys' },
  { rel: 'has-step', label: 'Steps' },
];
const IN_GROUPS: Array<{ rel: GraphEdge['relation']; label: string }> = [
  { rel: 'writes', label: 'Written by' },
  { rel: 'reads', label: 'Read by' },
  { rel: 'calls', label: 'Called by' },
  { rel: 'references', label: 'Referenced by' },
  { rel: 'trigger-on', label: 'Triggers' },
  { rel: 'fk', label: 'Foreign keys from' },
  { rel: 'has-step', label: 'Step of' },
];

function UsageRow({ connId, e }: { connId: string; e: UsageEdge }) {
  const route = nodeRoute(connId, e.nodeId);
  const ops = e.relation === 'fk' ? [] : e.ops;
  // reported by SQL Server dependencies only: no statement known, the relation says it all
  const relationOnly = !ops.length && (e.relation === 'reads' || e.relation === 'writes');
  return (
    <li>
      <KindGlyph kind={e.kind} />
      {route ? (
        <Link to={route} className="mono small truncate grow" title={e.label}>
          {e.label}
        </Link>
      ) : (
        <span className="mono small truncate grow" title={e.kind === 'external' ? 'object in another database' : 'not found in this database'}>
          {e.label}
        </span>
      )}
      {e.relation === 'fk' && e.ops.length ? (
        <span className="xsmall muted mono">{e.ops.join(', ')}</span>
      ) : relationOnly ? (
        <span className="xsmall muted" title="SQL Server dependency metadata does not name the statement">
          {e.relation}
        </span>
      ) : (
        <OpBadges ops={ops} />
      )}
      <OriginBadge origin={e.origin} />
    </li>
  );
}

export function UsageGroups({ connId, edges, direction, emptyText, testId }: { connId: string; edges: UsageEdge[]; direction: 'in' | 'out'; emptyText: string; testId?: string }) {
  const groups = (direction === 'out' ? OUT_GROUPS : IN_GROUPS)
    .map((g) => ({ ...g, items: edges.filter((e) => e.relation === g.rel).sort((a, b) => a.label.localeCompare(b.label)) }))
    .filter((g) => g.items.length);
  if (!groups.length) return <div className="muted small" style={{ padding: '10px 12px' }} data-testid={testId}>{emptyText}</div>;
  return (
    <div data-testid={testId}>
      {groups.map((g) => (
        <div key={g.rel}>
          <div className="nav-section" style={{ padding: '10px 12px 2px' }}>
            {g.label} ({g.items.length})
          </div>
          <ul className="list-plain">
            {g.items.map((e) => (
              <UsageRow key={`${e.nodeId}-${e.relation}`} connId={connId} e={e} />
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

export function JobsUsingList({ connId, jobs }: { connId: string; jobs: JobUsing[] }) {
  if (!jobs.length) return <div className="muted small" style={{ padding: '10px 12px' }}>No job step uses this object.</div>;
  return (
    <ul className="list-plain" data-testid="jobs-using" style={{ padding: '2px 0' }}>
      {jobs.map((j, i) => (
        <li key={`${j.jobId ?? j.jobName}-${j.stepId}-${i}`}>
          <KindGlyph kind="jobstep" />
          {j.jobId ? (
            <Link to={jobPath(connId, j.jobId, j.stepId)} className="truncate grow">
              {j.jobName} <span className="muted">· step {j.stepId}</span>
            </Link>
          ) : (
            <span className="truncate grow">
              {j.jobName} <span className="muted">· step {j.stepId}</span>
            </span>
          )}
          {j.source ? <Badge square>{j.source === 'agent' ? 'Agent' : 'Elastic'}</Badge> : null}
          {j.via ? (
            <span className="origin-badge" title={j.via === 'analysis' ? 'Found by analysis of the step command' : 'Name appears in the step command text'}>
              {j.via}
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/** Table-centric "Used by": writers grouped by operation, then readers, then other references. */
export function TableUsedBy({ connId, edges, jobs }: { connId: string; edges: UsageEdge[]; jobs: JobUsing[] }) {
  const writers = edges.filter((e) => e.relation === 'writes' || e.ops.some((o) => WRITE_OPS.has(o.toUpperCase())));
  const readers = edges.filter((e) => !writers.includes(e) && e.relation === 'reads');
  const others = edges.filter((e) => !writers.includes(e) && !readers.includes(e) && e.relation !== 'fk');
  const byOp = new Map<string, UsageEdge[]>();
  /** writers without a statement (SQL Server dependencies only): listed directly under Writers */
  const plainWriters: UsageEdge[] = [];
  for (const w of writers) {
    const ops = displayOps(w.ops).filter((o) => WRITE_OPS.has(o));
    if (!ops.length) plainWriters.push(w);
    for (const op of ops) (byOp.get(op) ?? byOp.set(op, []).get(op)!).push(w);
  }
  const opOrder = ['INSERT', 'INSERT_EXEC', 'UPDATE', 'MERGE', 'DELETE', 'TRUNCATE', 'SELECT_INTO', 'CREATE', 'ALTER', 'DROP'];
  const opGroups = [...byOp.entries()].sort((a, b) => opOrder.indexOf(a[0]) - opOrder.indexOf(b[0]));
  if (!edges.length && !jobs.length) return <Empty compact title="Nothing uses this table" body="No procedure, view, function, trigger or job step references it." />;
  return (
    <div data-testid="table-used-by">
      <div className="nav-section" style={{ padding: '10px 12px 2px' }}>
        Writers ({writers.length})
      </div>
      {plainWriters.length ? (
        <ul className="list-plain">
          {plainWriters.map((e) => (
            <UsageRow key={`w-${e.nodeId}`} connId={connId} e={e} />
          ))}
        </ul>
      ) : null}
      {writers.length ? (
        opGroups.map(([op, list]) => (
          <div key={op}>
            <div className="row" style={{ padding: '6px 12px 2px' }}>
              <OpBadges ops={[op]} />
              <span className="xsmall muted">{opLabel(op).toLowerCase()}</span>
            </div>
            <ul className="list-plain">
              {list.map((e) => (
                <UsageRow key={`${op}-${e.nodeId}`} connId={connId} e={e} />
              ))}
            </ul>
          </div>
        ))
      ) : (
        <div className="muted small" style={{ padding: '4px 12px 6px' }}>
          No writers.
        </div>
      )}
      <div className="nav-section" style={{ padding: '10px 12px 2px' }}>
        Readers ({readers.length})
      </div>
      {readers.length ? (
        <ul className="list-plain">
          {readers.map((e) => (
            <UsageRow key={`r-${e.nodeId}`} connId={connId} e={e} />
          ))}
        </ul>
      ) : (
        <div className="muted small" style={{ padding: '4px 12px 6px' }}>
          No readers.
        </div>
      )}
      {others.length ? (
        <>
          <div className="nav-section" style={{ padding: '10px 12px 2px' }}>
            Other references ({others.length})
          </div>
          <ul className="list-plain">
            {others.map((e) => (
              <UsageRow key={`o-${e.nodeId}-${e.relation}`} connId={connId} e={e} />
            ))}
          </ul>
        </>
      ) : null}
      <div className="nav-section" style={{ padding: '10px 12px 2px' }}>
        Job steps ({jobs.length})
      </div>
      <JobsUsingList connId={connId} jobs={jobs} />
    </div>
  );
}
