import { useEffect } from 'react';
import { Link, Outlet, useParams } from 'react-router';
import { useConnections } from '../api/hooks';
import { Empty, Loading, QueryError } from '../components/ui';
import { rememberConnectionId } from './connection';

/** Guards /c/:connId/* : the connection must exist; remembers it as the selected one. */
export function ConnectionScope() {
  const { connId } = useParams();
  const q = useConnections();
  const exists = Boolean(q.data?.some((c) => c.id === connId));
  useEffect(() => {
    if (exists && connId) rememberConnectionId(connId);
  }, [exists, connId]);
  if (q.isLoading) return <Loading />;
  if (q.error) return <div className="page"><QueryError error={q.error} onRetry={() => q.refetch()} what="connections" /></div>;
  if (!exists) {
    return (
      <div className="page">
        <Empty
          icon="database"
          title="Connection not found"
          body={`There is no saved connection with id "${connId}". It may have been deleted.`}
          action={<Link className="btn btn-primary" to="/connections">Manage connections</Link>}
        />
      </div>
    );
  }
  return <Outlet key={connId} />;
}
