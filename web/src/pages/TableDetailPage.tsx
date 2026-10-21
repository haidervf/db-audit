import { Link, useSearchParams } from 'react-router';
import type { ColumnInfo, ObjectDetailView, TableDetails } from '../api/types';
import { DiagramTab } from '../components/graph/DiagramTab';
import { TableUsedBy, usedByOf } from '../components/Usage';
import { Badge, DataTable, Empty, Tabs } from '../components/ui';
import { fmtNumber } from '../lib/format';
import { objectNodeId, objectPath } from '../lib/kinds';
import { DetailHeader } from './DetailHeader';

function columnExtras(c: ColumnInfo, pk: Set<string>, fkCols: Set<string>) {
  return (
    <span className="row-wrap" style={{ gap: 4 }}>
      {pk.has(c.name) ? (
        <Badge square tone="accent" title="Primary key">
          PK
        </Badge>
      ) : null}
      {fkCols.has(c.name) ? (
        <Badge square tone="info" title="Foreign key">
          FK
        </Badge>
      ) : null}
      {c.isIdentity ? (
        <Badge square title={`IDENTITY(${c.identitySeed ?? 1}, ${c.identityIncrement ?? 1})`}>
          identity({c.identitySeed ?? 1},{c.identityIncrement ?? 1})
        </Badge>
      ) : null}
      {c.isComputed ? (
        <Badge square title={c.computedDefinition ?? undefined}>
          computed{c.isPersisted ? ', persisted' : ''}
        </Badge>
      ) : null}
    </span>
  );
}

export function TableDetailPage({ connId, d }: { connId: string; d: ObjectDetailView }) {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'structure';
  const setTab = (t: string) => setParams(t === 'structure' ? {} : { tab: t }, { replace: true });
  const t = d.details as unknown as TableDetails;
  const pk = new Set(t.primaryKey?.columns ?? []);
  const fkCols = new Set((t.foreignKeys ?? []).flatMap((f) => f.columns.map((c) => c.from)));
  const usedBy = usedByOf(d).filter((e) => e.relation !== 'fk');
  const incomingFks = t.referencedByForeignKeys ?? [];

  return (
    <div className="page" data-testid="table-detail">
      <DetailHeader
        connId={connId}
        d={d}
        extra={
          <>
            <span>
              {fmtNumber(t.rowCount)} rows{t.rowCountSource ? <span className="muted"> ({t.rowCountSource === 'dm_db_partition_stats' ? 'exact, dm_db_partition_stats' : 'approx., sys.partitions'})</span> : null}
            </span>
            {t.reservedKb !== null && t.reservedKb !== undefined ? <span>{t.reservedKb < 1024 ? `${fmtNumber(t.reservedKb)} KB` : `${fmtNumber(Math.round(t.reservedKb / 1024))} MB`} reserved</span> : null}
            {t.temporalType && t.temporalType !== 'NON_TEMPORAL_TABLE' ? <span>{t.temporalType}</span> : null}
            {t.isMemoryOptimized ? <span>memory-optimized</span> : null}
          </>
        }
      />
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'structure', label: 'Structure & usage' },
          { id: 'diagram', label: 'Diagram' },
        ]}
      />
      {tab === 'diagram' ? (
        <DiagramTab connId={connId} nodeId={objectNodeId('table', d.schema, d.name)} />
      ) : (
        <div className="grid-2" style={{ gridTemplateColumns: 'minmax(0, 1.5fr) minmax(320px, 1fr)', alignItems: 'start' }}>
          <div className="stack-md" style={{ minWidth: 0 }}>
            <section className="card">
              <div className="card-header">
                <h3>Columns</h3>
                <span className="badge">{t.columns.length}</span>
                <span className="spacer" />
                {t.primaryKey ? <span className="xsmall muted mono">PK {t.primaryKey.name}</span> : <span className="xsmall muted">no primary key</span>}
              </div>
              <DataTable
                compact
                testId="columns-table"
                rows={t.columns}
                rowKey={(c) => `${c.ordinal}`}
                columns={[
                  { id: 'ord', header: '#', className: 'num', cell: (c) => <span className="muted">{c.ordinal}</span>, width: 36 },
                  { id: 'name', header: 'Column', cell: (c) => <span className="mono" style={{ fontWeight: pk.has(c.name) ? 650 : undefined }}>{c.name}</span> },
                  { id: 'type', header: 'Type', cell: (c) => <span className="mono text-2">{c.type}</span> },
                  { id: 'null', header: 'Nullable', cell: (c) => (c.nullable ? <span className="muted small">null</span> : <span className="small">not null</span>) },
                  {
                    id: 'default',
                    header: 'Default / computed',
                    cell: (c) =>
                      c.isComputed ? (
                        <span className="mono xsmall text-2">{c.computedDefinition}</span>
                      ) : c.defaultDefinition ? (
                        <span className="mono xsmall text-2" title={c.defaultName ?? undefined}>
                          {c.defaultDefinition}
                        </span>
                      ) : null,
                  },
                  { id: 'keys', header: 'Keys', cell: (c) => columnExtras(c, pk, fkCols) },
                ]}
              />
            </section>

            <section className="card">
              <div className="card-header">
                <h3>Indexes</h3>
                <span className="badge">{t.indexes.length}</span>
              </div>
              {t.indexes.length ? (
                <DataTable
                  compact
                  rows={t.indexes}
                  rowKey={(i) => i.name}
                  columns={[
                    { id: 'name', header: 'Index', cell: (i) => <span className="mono">{i.name}</span> },
                    { id: 'type', header: 'Type', cell: (i) => <span className="small text-2">{i.type.toLowerCase()}</span> },
                    {
                      id: 'keys',
                      header: 'Key columns',
                      cell: (i) => (
                        <span className="mono small">
                          {i.keyColumns.map((k) => `${k.name}${k.descending ? ' DESC' : ''}`).join(', ')}
                          {i.includedColumns.length ? <span className="muted"> INCLUDE ({i.includedColumns.join(', ')})</span> : null}
                        </span>
                      ),
                    },
                    {
                      id: 'flags',
                      header: '',
                      cell: (i) => (
                        <span className="row-wrap" style={{ gap: 4 }}>
                          {i.isPrimaryKey ? <Badge square tone="accent">PK</Badge> : null}
                          {i.isUnique && !i.isPrimaryKey ? <Badge square>unique</Badge> : null}
                          {i.filter ? <Badge square title={i.filter}>filtered</Badge> : null}
                          {i.isDisabled ? <Badge square tone="warn">disabled</Badge> : null}
                        </span>
                      ),
                    },
                  ]}
                />
              ) : (
                <div className="card-body muted small">No indexes (heap).</div>
              )}
            </section>

            <div className="grid-2">
              <section className="card">
                <div className="card-header">
                  <h3>Foreign keys (out)</h3>
                  <span className="badge">{t.foreignKeys.length}</span>
                </div>
                {t.foreignKeys.length ? (
                  <ul className="list-plain" style={{ padding: '4px 0' }}>
                    {t.foreignKeys.map((f) => (
                      <li key={f.name} style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}>
                        <span className="row-wrap" style={{ gap: '2px 6px' }}>
                          <span className="mono small">{f.columns.map((c) => c.from).join(', ')}</span>
                          <span className="muted">→</span>
                          <Link className="mono small" to={objectPath(connId, 'table', f.references.schema, f.references.name)}>
                            {f.references.schema}.{f.references.name}
                          </Link>
                          <span className="mono small muted">({f.columns.map((c) => c.to).join(', ')})</span>
                        </span>
                        <span className="xsmall muted">
                          {f.name}
                          {f.onDelete !== 'NO_ACTION' ? ` · ON DELETE ${f.onDelete.replace(/_/g, ' ')}` : ''}
                          {f.isNotTrusted ? ' · not trusted' : ''}
                          {f.isDisabled ? ' · disabled' : ''}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="card-body muted small">None.</div>
                )}
              </section>
              <section className="card">
                <div className="card-header">
                  <h3>Foreign keys (in)</h3>
                  <span className="badge">{incomingFks.length}</span>
                </div>
                {incomingFks.length ? (
                  <ul className="list-plain" style={{ padding: '4px 0' }}>
                    {incomingFks.map((f) => (
                      <li key={`${f.from.schema}.${f.from.name}.${f.name}`} style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}>
                        <span className="row-wrap" style={{ gap: '2px 6px' }}>
                          <Link className="mono small" to={objectPath(connId, 'table', f.from.schema, f.from.name)}>
                            {f.from.schema}.{f.from.name}
                          </Link>
                          <span className="mono small muted">({f.columns.map((c) => c.from).join(', ')})</span>
                          <span className="muted">→</span>
                          <span className="mono small">{f.columns.map((c) => c.to).join(', ')}</span>
                        </span>
                        <span className="xsmall muted">{f.name}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="card-body muted small">None.</div>
                )}
              </section>
            </div>

            {t.checkConstraints.length ? (
              <section className="card">
                <div className="card-header">
                  <h3>Check constraints</h3>
                  <span className="badge">{t.checkConstraints.length}</span>
                </div>
                <ul className="list-plain" style={{ padding: '4px 0' }}>
                  {t.checkConstraints.map((c) => (
                    <li key={c.name}>
                      <span className="mono small">{c.name}</span>
                      <code className="small text-2 truncate grow">{c.definition}</code>
                      {c.isDisabled ? <Badge tone="warn">disabled</Badge> : null}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </div>

          <section className="panel-section" style={{ position: 'sticky', top: 0 }}>
            <header>
              Used by <span className="count">{usedBy.length + d.jobsUsing.length}</span>
            </header>
            {usedBy.length || d.jobsUsing.length ? (
              <TableUsedBy connId={connId} edges={usedBy} jobs={d.jobsUsing} />
            ) : (
              <Empty compact title="Nothing uses this table" body="No procedure, view, function, trigger or job step references it." />
            )}
          </section>
        </div>
      )}
    </div>
  );
}
