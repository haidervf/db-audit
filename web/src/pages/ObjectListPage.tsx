import { useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { useObjects, useSummary } from '../api/hooks';
import type { ObjectSummaryView } from '../api/types';
import { Icon } from '../components/Icon';
import { Badge, DataTable, Empty, KindGlyph, Loading, ObjName, QueryError, SearchInput, type Column } from '../components/ui';
import { fmtDate, fmtNumber } from '../lib/format';
import { fuzzyScore } from '../lib/fuzzy';
import { DATABASE_SCOPE_SCHEMA, KIND_META, kindFromSegment, objectPath } from '../lib/kinds';
import { NotFound } from '../shell/RouteError';
import { useRefreshDialog } from '../shell/RefreshDialog';

function Flags({ o }: { o: ObjectSummaryView }) {
  const f = o.analysisFlags;
  return (
    <span className="row-wrap" style={{ gap: 4 }}>
      {o.isEncrypted ? (
        <Badge square title="WITH ENCRYPTION: no readable definition">
          <Icon name="lock" size={11} /> encrypted
        </Badge>
      ) : null}
      {f?.hasDynamicSql ? (
        <Badge square tone="warn" title="Uses dynamic SQL">
          dynamic SQL
        </Badge>
      ) : null}
      {f?.hasCrossDb ? (
        <Badge square tone="info" title="References other databases">
          cross-db
        </Badge>
      ) : null}
      {f && f.writesTables > 0 ? (
        <Badge square tone="danger" title={`Writes ${f.writesTables} table(s)`}>
          writes {f.writesTables}
        </Badge>
      ) : null}
      {f && f.warnings > 0 ? (
        <Badge square title={`${f.warnings} analyzer note(s)`}>
          {f.warnings} note{f.warnings === 1 ? '' : 's'}
        </Badge>
      ) : null}
    </span>
  );
}

export function ObjectListPage() {
  const { connId = '', kindSeg } = useParams();
  const kind = kindFromSegment(kindSeg);
  const q = useObjects(connId);
  const summary = useSummary(connId);
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const search = params.get('q') ?? '';
  const [schema, setSchema] = useState<string>('');
  const { openRefresh } = useRefreshDialog();

  const all = useMemo(() => (q.data ?? []).filter((o) => o.kind === kind), [q.data, kind]);
  const schemas = useMemo(() => [...new Set(all.map((o) => o.schema))].sort(), [all]);
  const rows = useMemo(() => {
    let r = schema ? all.filter((o) => o.schema === schema) : all;
    if (search.trim()) {
      r = r
        .map((o) => ({ o, s: fuzzyScore(search, `${o.schema}.${o.name}`) }))
        .filter((x) => x.s)
        .sort((a, b) => b.s!.score - a.s!.score)
        .map((x) => x.o);
    }
    return r;
  }, [all, schema, search]);

  if (!kind) return <NotFound />;
  const meta = KIND_META[kind];
  const isTable = kind === 'table';
  const hasAnalysis = all.some((o) => o.analysisFlags);

  const columns: Column<ObjectSummaryView>[] = [
    {
      id: 'name',
      header: 'Name',
      cell: (o) => (
        <span className="row" style={{ gap: 8 }}>
          <KindGlyph kind={o.kind} />
          <ObjName schema={o.schema === DATABASE_SCOPE_SCHEMA ? null : o.schema} name={o.name} />
        </span>
      ),
      sort: (o) => `${o.schema}.${o.name}`.toLowerCase(),
    },
    { id: 'schema', header: 'Schema', cell: (o) => <span className="mono small text-2">{o.schema}</span>, sort: (o) => o.schema.toLowerCase(), width: 110 },
    ...(isTable
      ? [{ id: 'rows', header: 'Rows', className: 'num', cell: (o: ObjectSummaryView) => fmtNumber(o.rowCount ?? null), sort: (o: ObjectSummaryView) => o.rowCount ?? -1, width: 100 } as Column<ObjectSummaryView>]
      : []),
    { id: 'modified', header: 'Modified', cell: (o) => <span className="small text-2 nowrap">{fmtDate(o.modifyDate)}</span>, sort: (o) => o.modifyDate, width: 120 },
    {
      id: 'out',
      header: isTable ? 'Refs out' : 'Uses',
      title: 'Objects this one references (server dependencies)',
      className: 'num',
      cell: (o) => (o.referencesCount ? o.referencesCount : <span className="muted">0</span>),
      sort: (o) => o.referencesCount,
      width: 80,
    },
    {
      id: 'in',
      header: 'Used by',
      title: 'Objects that reference this one (server dependencies)',
      className: 'num',
      cell: (o) => (o.referencedByCount ? o.referencedByCount : <span className="muted">0</span>),
      sort: (o) => o.referencedByCount,
      width: 80,
    },
    ...(!isTable
      ? [
          {
            id: 'reads',
            header: 'Reads / writes',
            title: 'Tables read / written according to static analysis',
            className: 'num',
            cell: (o: ObjectSummaryView) =>
              o.analysisFlags ? (
                <span className="nowrap">
                  {o.analysisFlags.readsTables} / {o.analysisFlags.writesTables}
                </span>
              ) : (
                <span className="muted">—</span>
              ),
            sort: (o: ObjectSummaryView) => (o.analysisFlags ? o.analysisFlags.writesTables * 1000 + o.analysisFlags.readsTables : -1),
            width: 110,
          } as Column<ObjectSummaryView>,
          {
            id: 'flags',
            header: 'Flags',
            cell: (o: ObjectSummaryView) => <Flags o={o} />,
            sort: (o: ObjectSummaryView) => (o.analysisFlags ? Number(o.analysisFlags.hasDynamicSql) * 4 + Number(o.analysisFlags.hasCrossDb) * 2 : 0) + Number(o.isEncrypted),
          } as Column<ObjectSummaryView>,
        ]
      : []),
  ];

  const neverRefreshed = summary.data && !summary.data.lastRefresh && Object.values(summary.data.counts).every((n) => n === 0);

  return (
    <div className="page" data-testid={`list-${kind}`}>
      <div className="page-header">
        <div className="grow">
          <h1 className="page-title">{meta.plural}</h1>
          <div className="page-subtitle">
            {q.data ? `${fmtNumber(rows.length)} of ${fmtNumber(all.length)}` : ' '}
            {!isTable && all.length && !hasAnalysis ? ' · analysis not available — run a refresh' : ''}
          </div>
        </div>
      </div>
      <div className="toolbar">
        <SearchInput
          value={search}
          onChange={(v) => setParams(v ? { q: v } : {}, { replace: true })}
          placeholder={`Filter ${meta.plural.toLowerCase()}…`}
          width={300}
        />
        {schemas.length > 1 ? (
          <select className="select" value={schema} onChange={(e) => setSchema(e.target.value)} aria-label="Schema">
            <option value="">All schemas</option>
            {schemas.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        ) : null}
      </div>
      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <QueryError error={q.error} onRetry={() => q.refetch()} what={meta.plural.toLowerCase()} />
      ) : neverRefreshed ? (
        <div className="card">
          <Empty
            icon="refresh"
            title="Nothing cached yet"
            body="Run the first refresh to read this database's catalog."
            action={
              <button className="btn btn-primary" onClick={() => openRefresh()}>
                Run first refresh
              </button>
            }
          />
        </div>
      ) : (
        <DataTable
          rows={rows}
          columns={columns}
          rowKey={(o) => `${o.schema}.${o.name}`}
          initialSort={{ id: 'name', dir: 'asc' }}
          onRowClick={(o) => navigate(objectPath(connId, o.kind, o.schema, o.name))}
          testId="object-table"
          maxHeight="calc(100vh - 210px)"
          empty={<Empty compact title={all.length ? 'No matches' : `No ${meta.plural.toLowerCase()} in this database`} body={all.length ? 'Try a different filter.' : undefined} />}
        />
      )}
    </div>
  );
}
