import { createBrowserRouter, Navigate } from 'react-router';
import { AppShell } from './shell/AppShell';
import { ConnectionScope } from './shell/ConnectionScope';
import { HomeRedirect } from './shell/HomeRedirect';
import { RouteError, NotFound } from './shell/RouteError';
import { ConnectionsPage } from './pages/ConnectionsPage';
import { SettingsPage } from './pages/SettingsPage';
import { OverviewPage } from './pages/OverviewPage';
import { ObjectListPage } from './pages/ObjectListPage';
import { ObjectDetailRoute } from './pages/ObjectDetailRoute';
import { JobsPage } from './pages/JobsPage';
import { JobDetailPage } from './pages/JobDetailPage';
import { GraphPage } from './pages/GraphPage';
import { RefreshHistoryPage } from './pages/RefreshHistoryPage';

export const router = createBrowserRouter([
  {
    path: '/',
    element: <AppShell />,
    errorElement: <RouteError />,
    children: [
      { index: true, element: <HomeRedirect /> },
      { path: 'connections', element: <ConnectionsPage /> },
      { path: 'settings', element: <SettingsPage /> },
      {
        path: 'c/:connId',
        element: <ConnectionScope />,
        children: [
          { index: true, element: <Navigate to="overview" replace /> },
          { path: 'overview', element: <OverviewPage /> },
          { path: 'graph', element: <GraphPage /> },
          { path: 'jobs', element: <JobsPage /> },
          { path: 'jobs/:jobId', element: <JobDetailPage /> },
          { path: 'refreshes', element: <RefreshHistoryPage /> },
          { path: ':kindSeg', element: <ObjectListPage /> },
          { path: ':kindSeg/:schema/:name', element: <ObjectDetailRoute /> },
        ],
      },
      { path: '*', element: <NotFound /> },
    ],
  },
]);
