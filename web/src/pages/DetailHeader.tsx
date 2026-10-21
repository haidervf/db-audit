import type { ReactNode } from 'react';
import { Link } from 'react-router';
import type { ObjectDetailView } from '../api/types';
import { Icon } from '../components/Icon';
import { Badge, KindBadge } from '../components/ui';
import { fmtDateTime } from '../lib/format';
import { DATABASE_SCOPE_SCHEMA, objectNodeId } from '../lib/kinds';
import { useRefreshDialog } from '../shell/RefreshDialog';

export function DetailHeader({ connId, d, extra }: { connId: string; d: ObjectDetailView; extra?: ReactNode }) {
  const { openRefresh } = useRefreshDialog();
  const f = d.analysisFlags;
  const ddl = d.schema === DATABASE_SCOPE_SCHEMA;
  return (
    <div className="detail-header">
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="row" style={{ gap: 8, marginBottom: 4 }}>
          <KindBadge kind={d.kind} label={d.typeCode === 'DDLTR' ? 'DDL trigger' : undefined} />
          {d.isEncrypted ? (
            <Badge square>
              <Icon name="lock" size={11} /> encrypted
            </Badge>
          ) : null}
          {f?.hasDynamicSql ? (
            <Badge square tone="warn">
              dynamic SQL
            </Badge>
          ) : null}
          {f?.hasCrossDb ? (
            <Badge square tone="info">
              cross-database
            </Badge>
          ) : null}
          {f && f.writesTables ? (
            <Badge square tone="danger">
              writes {f.writesTables} table{f.writesTables === 1 ? '' : 's'}
            </Badge>
          ) : null}
          {f && f.readsTables ? <Badge square>reads {f.readsTables}</Badge> : null}
          {f && f.callsProcs ? <Badge square>calls {f.callsProcs}</Badge> : null}
        </div>
        <h1 className="detail-title" data-testid="detail-title">
          {ddl ? null : <span className="schema">{d.schema}.</span>}
          {d.name}
        </h1>
        <div className="detail-meta">
          <span>Modified {fmtDateTime(d.modifyDate)}</span>
          <span>Created {fmtDateTime(d.createDate)}</span>
          {d.fetchedAt ? <span>Fetched {fmtDateTime(d.fetchedAt)}</span> : null}
          {extra}
        </div>
      </div>
      <div className="row" style={{ flex: 'none' }}>
        <Link className="btn btn-sm" to={`/c/${encodeURIComponent(connId)}/graph?focus=${encodeURIComponent(objectNodeId(d.kind, d.schema, d.name))}&depth=2`}>
          <Icon name="graph" size={13} /> Graph
        </Link>
        <button className="btn btn-sm" onClick={() => openRefresh({ objects: [{ kind: d.kind, schema: d.schema, name: d.name }] })} data-testid="object-refresh">
          <Icon name="refresh" size={13} /> Refresh object
        </button>
      </div>
    </div>
  );
}

