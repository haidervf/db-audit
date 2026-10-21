import { Link, isRouteErrorResponse, useRouteError } from 'react-router';
import { Empty } from '../components/ui';

export function RouteError() {
  const err = useRouteError();
  const msg = isRouteErrorResponse(err) ? `${err.status} ${err.statusText}` : err instanceof Error ? err.message : String(err);
  return (
    <div className="page">
      <Empty icon="alert" title="This page crashed" body={msg} action={<Link className="btn" to="/">Back to start</Link>} />
    </div>
  );
}

export function NotFound() {
  return (
    <div className="page">
      <Empty icon="alert" title="Page not found" body="This address does not match any screen." action={<Link className="btn" to="/">Back to start</Link>} />
    </div>
  );
}
