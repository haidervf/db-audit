import { Navigate } from 'react-router';
import { useConnections } from '../api/hooks';
import { Loading, QueryError } from '../components/ui';
import { storedConnectionId } from './connection';

export function HomeRedirect() {
  const q = useConnections();
  if (q.isLoading) return <Loading />;
  if (q.error) return <div className="page"><QueryError error={q.error} onRetry={() => q.refetch()} what="connections" /></div>;
  const list = q.data ?? [];
  if (list.length === 0) return <Navigate to="/connections" replace />;
  const stored = storedConnectionId();
  const target = list.find((c) => c.id === stored) ?? list[0];
  return <Navigate to={`/c/${encodeURIComponent(target.id)}/overview`} replace />;
}
