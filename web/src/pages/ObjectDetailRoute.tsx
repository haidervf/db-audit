import { useState, type ReactNode } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { useObjectDetail } from '../api/hooks';
import type {
  ColumnInfo,
  FunctionDetails,
  ObjectDetailView,
  ObjectKind,
  ParameterInfo,
  ProcedureDetails,
  TriggerDetails,
  ViewDetails,
} from '../api/types';
import { AiPanel } from '../components/AiPanel';
import type { LineRange } from '../components/CodeView';
import { ExplainView, type ExternalHighlight } from '../components/ExplainView';
import { DiagramTab } from '../components/graph/DiagramTab';
import { JobsUsingList, UsageGroups, usedByOf, usesOf } from '../components/Usage';
import { Badge, Callout, DataTable, Empty, Loading, QueryError, Tabs } from '../components/ui';
import { KIND_META, kindFromSegment, objectNodeId, objectPath } from '../lib/kinds';
import { NotFound } from '../shell/RouteError';
import { TableDetailPage } from './TableDetailPage';
import { DetailHeader } from './DetailHeader';

export function ObjectDetailRoute() {
  const { connId = '', kindSeg, schema = '', name = '' } = useParams();
  const kind = kindFromSegment(kindSeg);
  if (!kind) return <NotFound />;
  return <ObjectDetailLoader key={`${kind}:${schema}.${name}`} connId={connId} kind={kind} schema={schema} name={name} />;
}

function ObjectDetailLoader({ connId, kind, schema, name }: { connId: string; kind: ObjectKind; schema: string; name: string }) {
  const q = useObjectDetail(connId, kind, schema, name);
  if (q.isLoading) return <Loading label={`Loading ${KIND_META[kind].label.toLowerCase()}…`} />;
  if (q.error || !q.data)
    return (
      <div className="page">
        <QueryError error={q.error} onRetry={() => q.refetch()} what={`${schema}.${name}`} />
      </div>
    );
  if (kind === 'table') return <TableDetailPage connId={connId} d={q.data} />;
  return <ModuleDetailPage connId={connId} d={q.data} />;
}

type ModuleDetailsAny = Partial<Omit<ProcedureDetails, 'kind'> & Omit<FunctionDetails, 'kind'> & Omit<ViewDetails, 'kind'> & Omit<TriggerDetails, 'kind'>>;

export function ParametersTable({ params }: { params: ParameterInfo[] }) {
  if (!params.length) return <div className="muted small">No parameters.</div>;
  return (
    <DataTable
      compact
      rows={params}
      rowKey={(p) => String(p.ordinal)}
      columns={[
        { id: 'name', header: 'Parameter', cell: (p) => <span className="mono">{p.name}</span> },
        { id: 'type', header: 'Type', cell: (p) => <span className="mono text-2">{p.type}</span> },
        {
          id: 'flags',
          header: '',
          cell: (p) => (
            <span className="row-wrap" style={{ gap: 4 }}>
              {p.isOutput ? <Badge square tone="accent">OUTPUT</Badge> : null}
              {p.isReadOnly ? <Badge square>READONLY</Badge> : null}
              {p.isTableType ? <Badge square>table type</Badge> : null}
            </span>
          ),
        },
      ]}
    />
  );
}

export function ColumnsTable({ columns, maxHeight }: { columns: ColumnInfo[]; maxHeight?: string }) {
  return (
    <DataTable
      compact
      rows={columns}
      rowKey={(c) => `${c.ordinal}-${c.name}`}
      maxHeight={maxHeight}
      columns={[
        { id: 'ord', header: '#', className: 'num', cell: (c) => <span className="muted">{c.ordinal}</span>, width: 36 },
        { id: 'name', header: 'Column', cell: (c) => <span className="mono">{c.name}</span> },
        { id: 'type', header: 'Type', cell: (c) => <span className="mono text-2">{c.type}</span> },
        { id: 'null', header: 'Null', cell: (c) => (c.nullable ? <span className="muted">null</span> : <span className="small">not null</span>) },
      ]}
    />
  );
}

function definitionMessage(d: ObjectDetailView): ReactNode {
  const st = (d.details as { definitionStatus?: string }).definitionStatus;
  if (st === 'encrypted' || d.isEncrypted) return 'This module is WITH ENCRYPTION; its definition cannot be read or analyzed.';
  if (st === 'no-permission') return 'The definition is not visible to this login. GRANT VIEW DEFINITION to read it.';
  if (st === 'clr') return 'This is a CLR module; it has no T-SQL definition.';
  return 'No definition cached for this object. Try refreshing it.';
}

function ModuleMeta({ d }: { d: ObjectDetailView }) {
  const det = d.details as unknown as ModuleDetailsAny;
  const module = det.module;
  const items: ReactNode[] = [];
  if (d.kind === 'function') {
    items.push(det.functionType === 'scalar' ? 'scalar function' : det.functionType === 'inline-tvf' ? 'inline table-valued function' : 'multi-statement table-valued function');
    if (det.returnType) items.push(<>returns <span className="mono">{det.returnType}</span></>);
  }
  if (d.kind === 'trigger') {
    items.push(det.triggerType === 'ddl-database' ? 'database DDL trigger' : `DML trigger, ${det.isInsteadOf ? 'INSTEAD OF' : 'AFTER'}`);
    if (det.events?.length) items.push(<span className="mono">{det.events.join(', ')}</span>);
    if (det.isDisabled) items.push(<Badge tone="warn">disabled</Badge>);
  }
  if (module) {
    items.push(<>execute as {module.executeAs ?? 'CALLER'}</>);
    if (module.isSchemaBound) items.push('schema bound');
    if (module.usesQuotedIdentifier === false) items.push('QUOTED_IDENTIFIER OFF');
    if (module.usesAnsiNulls === false) items.push('ANSI_NULLS OFF');
  }
  return (
    <>
      {items.map((it, i) => (
        <span key={i}>{it}</span>
      ))}
    </>
  );
}

function ModuleDetailPage({ connId, d }: { connId: string; d: ObjectDetailView }) {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'explain';
  const [ext, setExt] = useState<ExternalHighlight | null>(null);
  const setTab = (t: string) => setParams(t === 'explain' ? {} : { tab: t }, { replace: true });
  const det = d.details as unknown as ModuleDetailsAny;
  const uses = usesOf(d);
  const usedBy = usedByOf(d);
  const nodeId = objectNodeId(d.kind, d.schema, d.name);
  const showLines = (r: LineRange) => {
    setExt((e) => ({ range: r, nonce: (e?.nonce ?? 0) + 1 }));
    setTab('explain');
  };
  const parent = det.parent;

  return (
    <div className="page" data-testid="module-detail">
      <DetailHeader
        connId={connId}
        d={d}
        extra={
          <>
            {parent ? (
              <span>
                on{' '}
                <Link className="mono" to={objectPath(connId, parent.kind, parent.schema, parent.name)}>
                  {parent.schema}.{parent.name}
                </Link>
              </span>
            ) : null}
            <ModuleMeta d={d} />
          </>
        }
      />
      {det.parameters?.length ? (
        <section className="card" style={{ marginBottom: 14 }}>
          <div className="card-header">
            <h3>Parameters</h3>
            <span className="badge">{det.parameters.length}</span>
          </div>
          <ParametersTable params={det.parameters} />
        </section>
      ) : d.kind === 'view' && det.columns?.length ? (
        <section className="card" style={{ marginBottom: 14 }}>
          <div className="card-header">
            <h3>Columns</h3>
            <span className="badge">{det.columns.length}</span>
          </div>
          <ColumnsTable columns={det.columns} maxHeight="220px" />
        </section>
      ) : null}

      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'explain', label: 'Explain' },
          { id: 'deps', label: 'Dependencies', count: uses.length + usedBy.length + d.jobsUsing.length },
          { id: 'diagram', label: 'Diagram' },
          { id: 'ai', label: 'AI explanation' },
        ]}
      />

      {tab === 'explain' ? (
        d.definition ? (
          <ExplainView connId={connId} code={d.definition} analysis={d.analysis} external={ext} />
        ) : (
          <div className="card">
            <Empty icon="lock" title="No definition" body={definitionMessage(d)} />
          </div>
        )
      ) : tab === 'deps' ? (
        <div className="grid-2" style={{ alignItems: 'start' }} data-testid="deps-tab">
          <section className="panel-section">
            <header>
              Uses <span className="count">{uses.length}</span>
            </header>
            <UsageGroups connId={connId} edges={uses} direction="out" emptyText="This object does not reference anything." testId="uses" />
          </section>
          <div className="stack-md">
            <section className="panel-section">
              <header>
                Used by <span className="count">{usedBy.length}</span>
              </header>
              <UsageGroups connId={connId} edges={usedBy} direction="in" emptyText="Nothing in this database references this object." testId="used-by" />
            </section>
            <section className="panel-section">
              <header>
                Jobs <span className="count">{d.jobsUsing.length}</span>
              </header>
              <JobsUsingList connId={connId} jobs={d.jobsUsing} />
            </section>
          </div>
          {!d.uses ? (
            <div style={{ gridColumn: '1 / -1' }}>
              <Callout tone="info">Showing SQL Server dependency metadata only; static-analysis edges appear after an analysis refresh.</Callout>
            </div>
          ) : null}
        </div>
      ) : tab === 'diagram' ? (
        <DiagramTab connId={connId} nodeId={nodeId} />
      ) : (
        <AiPanel
          connId={connId}
          target={{ type: 'object', kind: d.kind, schema: d.schema, name: d.name }}
          ai={d.ai}
          hasSource={Boolean(d.definition)}
          onShowLines={showLines}
          subject={`${d.schema}.${d.name}`}
        />
      )}
    </div>
  );
}
