import { useLocation } from 'react-router';
import { useConnections } from '../api/hooks';
import type { ConnectionProfile } from '../api/types';
import { readStored, writeStored } from '../lib/storage';

const KEY = 'connectionId';

export function storedConnectionId(): string | null {
  return readStored(KEY);
}

export function rememberConnectionId(id: string | null): void {
  writeStored(KEY, id);
}

/** The connection in the URL (/c/:connId/...), else the remembered one (if it still exists). */
export function useCurrentConnection(): { connId: string | null; connection: ConnectionProfile | null; fromUrl: boolean; loading: boolean } {
  const location = useLocation();
  const conns = useConnections();
  const m = /^\/c\/([^/]+)/.exec(location.pathname);
  const fromUrl = m ? decodeURIComponent(m[1]) : null;
  // Outside /c/:connId (connections, settings) the remembered connection stays selected.
  const id = fromUrl ?? storedConnectionId();
  const connection = conns.data?.find((c) => c.id === id) ?? (fromUrl ? null : (conns.data?.[0] ?? null));
  return { connId: connection ? connection.id : fromUrl, connection, fromUrl: Boolean(fromUrl), loading: conns.isLoading };
}

export function endpointLabel(c: Pick<ConnectionProfile, 'target'>): string {
  return `${c.target.server}${c.target.port ? `,${c.target.port}` : ''} / ${c.target.database}`;
}
