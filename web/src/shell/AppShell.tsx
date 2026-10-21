import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { useConnections, useObjects, useJobs, useRuns, useSummary } from '../api/hooks';
import type { ConnectionProfile, GraphNodeKind } from '../api/types';
import { Icon } from '../components/Icon';
import { Spinner } from '../components/ui';
import { fmtRelative } from '../lib/format';
import { KIND_META, kindFromSegment } from '../lib/kinds';
import { useTheme } from '../lib/theme';
import { endpointLabel, rememberConnectionId, useCurrentConnection } from './connection';
import { QuickSearch } from './QuickSearch';
import { activeRun, RefreshProvider, useRefreshDialog } from './RefreshDialog';

const NAV: Array<{ seg: string; label: string; icon: string; countKey?: GraphNodeKind }> = [
  { seg: 'overview', label: 'Overview', icon: 'overview' },
  { seg: 'procedures', label: 'Procedures', icon: 'procedure', countKey: 'procedure' },
  { seg: 'tables', label: 'Tables', icon: 'table', countKey: 'table' },
  { seg: 'views', label: 'Views', icon: 'view', countKey: 'view' },
  { seg: 'functions', label: 'Functions', icon: 'function', countKey: 'function' },
  { seg: 'triggers', label: 'Triggers', icon: 'trigger', countKey: 'trigger' },
  { seg: 'jobs', label: 'Jobs', icon: 'job', countKey: 'job' },
  { seg: 'graph', label: 'Graph', icon: 'graph' },
  { seg: 'refreshes', label: 'Refresh history', icon: 'clock' },
];

export function AppShell() {
  const { connId, connection } = useCurrentConnection();
  const [searchOpen, setSearchOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
      if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setSearchOpen(true);
      } else if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <RefreshProvider connId={connection ? connId : null}>
      <div className="app">
        <Sidebar connId={connection ? connId : null} connection={connection} />
        <div className="main">
          <TopBar connection={connection} onSearch={() => setSearchOpen(true)} />
          <main className="content" id="content">
            <Outlet />
          </main>
        </div>
      </div>
      {searchOpen && connection ? <QuickSearch connId={connection.id} onClose={() => setSearchOpen(false)} /> : null}
      {searchOpen && !connection ? <NoConnectionSearch onClose={() => setSearchOpen(false)} /> : null}
    </RefreshProvider>
  );
}

function NoConnectionSearch({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  useEffect(() => {
    onClose();
    navigate('/connections');
  }, [navigate, onClose]);
  return null;
}

function connStatus(connId: string | null, last: string | undefined, running: boolean): string {
  if (!connId) return 'none';
  if (running) return 'running';
  return last ?? 'never';
}

function Sidebar({ connId, connection }: { connId: string | null; connection: ConnectionProfile | null }) {
  const summary = useSummary(connId ?? undefined);
  const runs = useRuns(connId ?? undefined);
  const counts = summary.data?.counts;
  const status = connStatus(connId, summary.data?.lastRefresh?.status, Boolean(activeRun(runs.data)));
  return (
    <aside className="sidebar" aria-label="Main navigation">
      <Link to="/" className="sidebar-brand" style={{ textDecoration: 'none' }}>
        <span className="brand-mark">
          <Icon name="database" size={14} />
        </span>
        db-audit
      </Link>
      <ConnectionSwitcher connection={connection} status={status} />
      <nav className="sidebar-nav">
        <div className="nav-section">Explore</div>
        {NAV.map((n) =>
          connId ? (
            <NavLink key={n.seg} to={`/c/${encodeURIComponent(connId)}/${n.seg}`} className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`} data-testid={`nav-${n.seg}`}>
              <Icon name={n.icon} />
              {n.label}
              {n.countKey && counts ? <span className="count">{counts[n.countKey as keyof typeof counts] ?? 0}</span> : null}
            </NavLink>
          ) : (
            <span key={n.seg} className="nav-item" aria-disabled="true">
              <Icon name={n.icon} />
              {n.label}
            </span>
          ),
        )}
        <div className="nav-section">App</div>
        <NavLink to="/connections" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`} data-testid="nav-connections">
          <Icon name="database" />
          Connections
        </NavLink>
        <NavLink to="/settings" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`} data-testid="nav-settings">
          <Icon name="settings" />
          Settings
        </NavLink>
      </nav>
      <div className="sidebar-footer small muted" style={{ padding: '10px 14px' }}>
        {connection ? (
          <span title={connection.lastRefreshAt ?? undefined}>Last refresh {fmtRelative(connection.lastRefreshAt)}</span>
        ) : (
          <span>Read-only auditing for SQL Server</span>
        )}
      </div>
    </aside>
  );
}

function ConnectionSwitcher({ connection, status }: { connection: ConnectionProfile | null; status: string }) {
  const conns = useConnections();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const location = useLocation();
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const switchTo = (c: ConnectionProfile) => {
    setOpen(false);
    rememberConnectionId(c.id);
    const m = /^\/c\/[^/]+\/([^/?]+)/.exec(location.pathname);
    const seg = m?.[1] ?? 'overview';
    navigate(`/c/${encodeURIComponent(c.id)}/${seg}`);
  };

  return (
    <div className="conn-switcher" ref={ref}>
      <button className="conn-button" onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open} data-testid="conn-switcher">
        <span className="status-dot" data-status={status} title={`Last refresh: ${status}`} />
        <span className="grow" style={{ minWidth: 0 }}>
          <div className="conn-name truncate">{connection ? connection.name : conns.data?.length ? 'Select a connection' : 'No connections'}</div>
          <div className="conn-sub truncate">{connection ? endpointLabel(connection) : 'add one to get started'}</div>
        </span>
        <Icon name="chevronsUpDown" size={14} className="muted" />
      </button>
      {open ? (
        <div className="menu conn-menu" role="menu">
          {(conns.data ?? []).map((c) => (
            <button key={c.id} className="menu-item" role="menuitemradio" aria-checked={c.id === connection?.id} onClick={() => switchTo(c)} data-testid="conn-option">
              <span className="status-dot" data-status={c.lastRefreshAt ? 'succeeded' : 'never'} />
              <span className="grow" style={{ minWidth: 0 }}>
                <div className="truncate" style={{ fontWeight: 550 }}>
                  {c.name}
                </div>
                <div className="truncate mono xsmall muted">{endpointLabel(c)}</div>
              </span>
              {c.id === connection?.id ? <Icon name="check" size={14} /> : null}
            </button>
          ))}
          {conns.data?.length ? <div className="menu-sep" /> : null}
          <Link className="menu-item" to="/connections" onClick={() => setOpen(false)}>
            <Icon name="settings" size={14} /> Manage connections
          </Link>
          <Link className="menu-item" to="/connections?edit=new" onClick={() => setOpen(false)}>
            <Icon name="plus" size={14} /> Add connection
          </Link>
        </div>
      ) : null}
    </div>
  );
}

function Breadcrumb({ connection }: { connection: ConnectionProfile | null }) {
  const location = useLocation();
  const segs = location.pathname.split('/').map((x) => {
    try {
      return decodeURIComponent(x);
    } catch {
      return x;
    }
  });
  const params = { jobId: segs[3] === 'jobs' ? segs[4] : undefined, schema: segs[4], name: segs[5] };
  const jobs = useJobs(params.jobId && connection ? connection.id : undefined);
  const parts: Array<{ label: string; to?: string; mono?: boolean }> = [];
  const path = location.pathname;
  if (path.startsWith('/connections')) parts.push({ label: 'Connections' });
  else if (path.startsWith('/settings')) parts.push({ label: 'Settings' });
  else if (path.startsWith('/c/') && connection) {
    const base = `/c/${encodeURIComponent(connection.id)}`;
    parts.push({ label: connection.name, to: `${base}/overview` });
    const seg = path.split('/')[3];
    const kind = kindFromSegment(seg);
    if (seg === 'overview') parts.push({ label: 'Overview' });
    else if (seg === 'graph') parts.push({ label: 'Graph' });
    else if (seg === 'refreshes') parts.push({ label: 'Refresh history' });
    else if (seg === 'jobs') {
      parts.push({ label: 'Jobs', to: params.jobId ? `${base}/jobs` : undefined });
      if (params.jobId) parts.push({ label: jobs.data?.find((j) => j.jobId.toLowerCase() === params.jobId!.toLowerCase())?.name ?? params.jobId, mono: !jobs.data });
    } else if (kind) {
      parts.push({ label: KIND_META[kind].plural, to: params.name ? `${base}/${seg}` : undefined });
      if (params.name) parts.push({ label: `${params.schema}.${params.name}`, mono: true });
    }
  }
  return (
    <nav className="breadcrumb grow" aria-label="Breadcrumb" data-testid="breadcrumb">
      {parts.map((p, i) => (
        <span key={i} className="row" style={{ gap: 6, minWidth: 0 }}>
          {i > 0 ? <span className="sep">/</span> : null}
          {p.to && i < parts.length - 1 ? (
            <Link to={p.to}>{p.label}</Link>
          ) : (
            <span className={`current${p.mono ? ' mono' : ''}`} data-crumb-current>
              {p.label}
            </span>
          )}
        </span>
      ))}
    </nav>
  );
}

function TopBar({ connection, onSearch }: { connection: ConnectionProfile | null; onSearch: () => void }) {
  const { theme, toggle } = useTheme();
  const isMac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform || navigator.userAgent);
  return (
    <header className="topbar">
      <Breadcrumb connection={connection} />
      {connection ? (
        <button className="search-trigger" onClick={onSearch} data-testid="search-trigger" aria-label="Quick search">
          <Icon name="search" size={14} />
          <span className="grow" style={{ textAlign: 'left' }}>
            Search objects &amp; jobs…
          </span>
          <span className="kbd">/</span>
          <span className="kbd">{isMac ? '⌘K' : 'Ctrl K'}</span>
        </button>
      ) : null}
      {connection ? <RefreshButton connId={connection.id} /> : null}
      <button className="icon-btn" onClick={toggle} aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'} title={theme === 'dark' ? 'Light mode' : 'Dark mode'} data-testid="theme-toggle">
        <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
      </button>
    </header>
  );
}

function RefreshButton({ connId }: { connId: string }) {
  const runs = useRuns(connId);
  const { openRefresh } = useRefreshDialog();
  // Preload lists used by quick search so it opens instantly.
  useObjects(connId);
  useJobs(connId);
  const run = activeRun(runs.data);
  const last = runs.data?.[0];
  return (
    <button
      className="btn"
      onClick={() => openRefresh()}
      data-testid="refresh-button"
      title={last ? `Last run ${last.status} ${fmtRelative(last.finishedAt ?? last.startedAt)}` : 'Never refreshed'}
    >
      {run ? <Spinner /> : <Icon name="refresh" size={14} />}
      {run ? (
        <span>
          Refreshing… <span className="muted small">{run.progress.total ? `${run.progress.done}/${run.progress.total}` : run.progress.step ? `${run.progress.phase} · ${run.progress.step}` : run.progress.phase}</span>
        </span>
      ) : (
        'Refresh'
      )}
      {!run && last && last.status !== 'succeeded' ? <span className="status-dot" data-status={last.status} /> : null}
    </button>
  );
}
