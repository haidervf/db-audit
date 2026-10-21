import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { errorMessage } from '../api/client';
import { useConnections, useDeleteConnection, useSaveConnection, useTestConnection } from '../api/hooks';
import type { AuthMode, ConnectionInput, ConnectionProfile, ConnectionTestResult, EndpointCheck, JobsSource } from '../api/types';
import { Icon } from '../components/Icon';
import { Badge, Callout, ConfirmButton, Empty, Loading, QueryError, Spinner } from '../components/ui';
import { fmtRelative } from '../lib/format';
import { hintFor, JOBS_PERMISSIONS, TARGET_PERMISSIONS, type PermissionInfo } from '../lib/hints';
import { endpointLabel, rememberConnectionId, storedConnectionId } from '../shell/connection';

const AUTH_LABEL: Record<AuthMode, string> = {
  sql: 'SQL login',
  'entra-cli': 'Entra – Azure CLI',
  'entra-interactive': 'Entra – Browser sign-in',
  'entra-default': 'Entra – Default chain',
};

const JOBS_SOURCE_LABEL: Record<JobsSource, string> = {
  auto: 'Auto (Agent + Elastic if set)',
  agent: 'SQL Agent (msdb) only',
  elastic: 'Elastic Jobs only',
  none: 'No jobs',
};

const ENGINE_EDITIONS: Record<number, string> = {
  1: 'Personal or Desktop Engine',
  2: 'Standard',
  3: 'Enterprise (incl. Developer, Evaluation)',
  4: 'Express',
  5: 'Azure SQL Database',
  6: 'Azure Synapse Analytics',
  8: 'Azure SQL Managed Instance',
  9: 'Azure SQL Edge',
  11: 'Azure Synapse serverless SQL pool',
  12: 'Microsoft Fabric SQL database',
};

interface FormState {
  name: string;
  server: string;
  database: string;
  port: string;
  mode: AuthMode;
  user: string;
  password: string;
  tenantId: string;
  clientId: string;
  encrypt: boolean;
  trustServerCertificate: boolean;
  readOnlyIntent: boolean;
  jobsSource: JobsSource;
  jobsEnabled: boolean;
  jobsServer: string;
  jobsDatabase: string;
  jobsPort: string;
}

const EMPTY: FormState = {
  name: '',
  server: '',
  database: '',
  port: '',
  mode: 'sql',
  user: '',
  password: '',
  tenantId: '',
  clientId: '',
  encrypt: true,
  trustServerCertificate: false,
  readOnlyIntent: false,
  jobsSource: 'auto',
  jobsEnabled: false,
  jobsServer: '',
  jobsDatabase: '',
  jobsPort: '',
};

function fromProfile(p: ConnectionProfile): FormState {
  return {
    name: p.name,
    server: p.target.server,
    database: p.target.database,
    port: p.target.port ? String(p.target.port) : '',
    mode: p.auth.mode,
    user: p.auth.user ?? '',
    password: '',
    tenantId: p.auth.tenantId ?? '',
    clientId: p.auth.clientId ?? '',
    encrypt: p.options.encrypt,
    trustServerCertificate: p.options.trustServerCertificate,
    readOnlyIntent: p.options.readOnlyIntent,
    jobsSource: p.jobsSource,
    jobsEnabled: Boolean(p.jobs),
    jobsServer: p.jobs?.server ?? '',
    jobsDatabase: p.jobs?.database ?? '',
    jobsPort: p.jobs?.port ? String(p.jobs.port) : '',
  };
}

function toInput(f: FormState): ConnectionInput {
  const auth: ConnectionInput['auth'] = { mode: f.mode };
  if (f.mode === 'sql') {
    auth.user = f.user.trim();
    if (f.password) auth.password = f.password;
  } else {
    if (f.tenantId.trim()) auth.tenantId = f.tenantId.trim();
    if (f.mode !== 'entra-cli' && f.clientId.trim()) auth.clientId = f.clientId.trim();
  }
  const port = f.port.trim() ? Number(f.port) : undefined;
  const jobsPort = f.jobsPort.trim() ? Number(f.jobsPort) : undefined;
  return {
    name: f.name.trim(),
    target: { server: f.server.trim(), database: f.database.trim(), ...(port ? { port } : {}) },
    jobs: f.jobsEnabled && f.jobsServer.trim() && f.jobsDatabase.trim() ? { server: f.jobsServer.trim(), database: f.jobsDatabase.trim(), ...(jobsPort ? { port: jobsPort } : {}) } : null,
    jobsSource: f.jobsSource,
    auth,
    options: { encrypt: f.encrypt, trustServerCertificate: f.trustServerCertificate, readOnlyIntent: f.readOnlyIntent },
  };
}

function validate(f: FormState, hasPassword: boolean): string | null {
  if (!f.name.trim()) return 'Name is required.';
  if (!f.server.trim()) return 'Server is required.';
  if (!f.database.trim()) return 'Database is required.';
  if (f.port.trim() && !(Number(f.port) >= 1 && Number(f.port) <= 65535)) return 'Port must be between 1 and 65535.';
  if (f.mode === 'sql' && !f.user.trim()) return 'User is required for SQL login.';
  if (f.mode === 'sql' && !f.password && !hasPassword) return 'Password is required for SQL login.';
  if (f.jobsEnabled && (!f.jobsServer.trim() || !f.jobsDatabase.trim())) return 'Elastic Jobs database needs a server and a database (or untick it).';
  if (f.jobsPort.trim() && !(Number(f.jobsPort) >= 1 && Number(f.jobsPort) <= 65535)) return 'Jobs port must be between 1 and 65535.';
  return null;
}

export function ConnectionsPage() {
  const q = useConnections();
  const [params, setParams] = useSearchParams();
  const edit = params.get('edit');
  const list = q.data ?? [];
  const editing = edit === 'new' ? null : list.find((c) => c.id === edit) ?? null;
  // Stable form identity: saving a new connection switches the URL to ?edit=<id> without remounting the form.
  const [formKey, setFormKey] = useState(() => `${edit ?? ''}`);
  const open = (id: string) => {
    setFormKey(`${id}-${Date.now()}`);
    setParams({ edit: id });
  };

  if (q.isLoading) return <Loading />;
  if (q.error) return <div className="page"><QueryError error={q.error} onRetry={() => q.refetch()} what="connections" /></div>;

  const showForm = Boolean(edit);
  return (
    <div className="page" data-testid="connections-page">
      <div className="page-header">
        <div className="grow">
          <h1 className="page-title">Connections</h1>
          <div className="page-subtitle">Saved database profiles. Everything db-audit sends to a database is read-only.</div>
        </div>
        {!showForm && list.length ? (
          <button className="btn btn-primary" onClick={() => open('new')} data-testid="add-connection">
            <Icon name="plus" size={14} /> Add connection
          </button>
        ) : null}
      </div>

      {showForm ? (
        <ConnectionForm
          key={formKey}
          profile={editing}
          onSaved={(p) => setParams({ edit: p.id }, { replace: true })}
          onDone={() => setParams({})}
        />
      ) : list.length === 0 ? (
        <div className="card onboarding" data-testid="onboarding">
          <div className="empty-icon" style={{ margin: '0 auto' }}>
            <Icon name="database" size={20} />
          </div>
          <h2>Connect your first database</h2>
          <p className="text-2" style={{ margin: '0 0 6px' }}>
            db-audit reads the catalog of an Azure SQL Managed Instance (or any SQL Server) database — procedures, tables, views, functions, triggers, dependencies and SQL Agent / Elastic jobs — caches it locally and explains it.
          </p>
          <p className="muted small" style={{ margin: '0 0 16px' }}>
            Read-only: every statement goes through a read-only guard.
          </p>
          <button className="btn btn-primary" onClick={() => open('new')} data-testid="add-connection">
            <Icon name="plus" size={14} /> Add connection
          </button>
        </div>
      ) : null}

      {list.length ? (
        <div style={{ marginTop: showForm ? 20 : 0 }}>
          {showForm ? <h2 className="section-title" style={{ marginBottom: 10 }}>All connections</h2> : null}
          <div className="conn-list">
            {list.map((c) => (
              <ConnectionCard key={c.id} c={c} onEdit={() => open(c.id)} />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ConnectionCard({ c, onEdit }: { c: ConnectionProfile; onEdit: () => void }) {
  const del = useDeleteConnection();
  const test = useTestConnection();
  const selected = storedConnectionId() === c.id;
  return (
    <div className="card" data-testid="connection-card" data-name={c.name}>
      <div className="card-header">
        <span className="status-dot" data-status={c.lastRefreshAt ? 'succeeded' : 'never'} />
        <h3 className="grow truncate">{c.name}</h3>
        {selected ? <Badge tone="accent">selected</Badge> : null}
      </div>
      <div className="card-body">
        <dl className="kv small">
          <dt>Target</dt>
          <dd className="mono">{endpointLabel(c)}</dd>
          <dt>Auth</dt>
          <dd>
            {AUTH_LABEL[c.auth.mode]}
            {c.auth.user ? <span className="mono"> · {c.auth.user}</span> : null}
          </dd>
          <dt>Jobs</dt>
          <dd>
            {c.jobsSource}
            {c.jobs ? <span className="mono"> · Elastic DB {c.jobs.server}{c.jobs.port ? `,${c.jobs.port}` : ''} / {c.jobs.database}</span> : null}
          </dd>
          <dt>Refreshed</dt>
          <dd>{fmtRelative(c.lastRefreshAt)}</dd>
        </dl>
        {test.data || test.error || test.isPending ? (
          <div style={{ marginTop: 12 }}>
            {test.isPending ? (
              <div className="row muted">
                <Spinner /> Testing…
              </div>
            ) : test.error ? (
              <Callout tone="danger" title="Test failed">
                {errorMessage(test.error)}
              </Callout>
            ) : test.data ? (
              <TestResultPanel result={test.data} profile={c} />
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="row" style={{ padding: '0 14px 12px', flexWrap: 'wrap' }}>
        <Link
          className="btn btn-sm btn-primary"
          to={`/c/${encodeURIComponent(c.id)}/overview`}
          onClick={() => rememberConnectionId(c.id)}
          data-testid="open-connection"
        >
          Open
        </Link>
        <button className="btn btn-sm" onClick={onEdit} data-testid="edit-connection">
          <Icon name="edit" size={13} /> Edit
        </button>
        <button className="btn btn-sm" onClick={() => test.mutate(c.id)} disabled={test.isPending}>
          Test
        </button>
        <span className="spacer" />
        <ConfirmButton
          label="Delete"
          icon="trash"
          className="btn btn-sm btn-ghost"
          confirmLabel="Delete connection and cache"
          busy={del.isPending}
          onConfirm={() =>
            del.mutate(c.id, {
              onSuccess: () => {
                if (storedConnectionId() === c.id) rememberConnectionId(null);
              },
            })
          }
        />
      </div>
      {del.error ? (
        <div style={{ padding: '0 14px 12px' }}>
          <Callout tone="danger">{errorMessage(del.error)}</Callout>
        </div>
      ) : null}
    </div>
  );
}

function Field({ label, hint, children, wide }: { label: string; hint?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <label className="field" style={wide ? { gridColumn: '1 / -1' } : undefined}>
      <span className="field-label">{label}</span>
      {children}
      {hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

function ConnectionForm({ profile, onSaved, onDone }: { profile: ConnectionProfile | null; onSaved: (p: ConnectionProfile) => void; onDone: () => void }) {
  const initial = useMemo(() => (profile ? fromProfile(profile) : EMPTY), [profile]);
  const [f, setF] = useState<FormState>(initial);
  const [baseline, setBaseline] = useState(JSON.stringify(initial));
  const [problem, setProblem] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const save = useSaveConnection();
  const test = useTestConnection();
  const navigate = useNavigate();
  const dirty = JSON.stringify(f) !== baseline;
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((s) => ({ ...s, [k]: v }));

  useEffect(() => {
    if (!savedNote) return;
    const t = window.setTimeout(() => setSavedNote(null), 4000);
    return () => window.clearTimeout(t);
  }, [savedNote]);

  const doSave = async (): Promise<ConnectionProfile | null> => {
    const err = validate(f, Boolean(profile?.auth.hasPassword));
    setProblem(err);
    if (err) return null;
    try {
      const p = await save.mutateAsync({ id: profile?.id ?? null, input: toInput(f) });
      const next = { ...f, password: '' };
      setF(next);
      setBaseline(JSON.stringify(next));
      setSavedNote(profile ? 'Changes saved.' : 'Connection saved.');
      rememberConnectionId(p.id);
      onSaved(p);
      return p;
    } catch {
      return null;
    }
  };

  const doTest = async () => {
    let id = profile?.id ?? null;
    if (!id || dirty) {
      const p = await doSave();
      if (!p) return;
      id = p.id;
    }
    test.mutate(id);
  };

  return (
    <div className="grid-2" style={{ alignItems: 'start', gridTemplateColumns: 'minmax(0, 1.15fr) minmax(0, 1fr)' }}>
      <form
        className="card"
        data-testid="connection-form"
        onSubmit={(e) => {
          e.preventDefault();
          void doSave();
        }}
      >
        <div className="card-header">
          <h3 className="grow">{profile ? `Edit ${profile.name}` : 'New connection'}</h3>
          {dirty ? <Badge tone="warn">unsaved</Badge> : null}
        </div>
        <div className="card-body">
          <div className="form-section">
            <div className="field-grid">
              <Field label="Name" wide>
                <input className="input" value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="Sales prod (MI)" name="name" data-testid="f-name" autoFocus />
              </Field>
            </div>
          </div>
          <div className="form-section">
            <h3>Target</h3>
            <div className="field-grid" style={{ gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1.4fr) 110px' }}>
              <Field label="Server" hint={<>host, host,port or tcp:host,port — MI public endpoint uses port 3342</>}>
                <input className="input mono" value={f.server} onChange={(e) => set('server', e.target.value)} placeholder="my-mi.public.abc123.database.windows.net" data-testid="f-server" />
              </Field>
              <Field label="Database">
                <input className="input mono" value={f.database} onChange={(e) => set('database', e.target.value)} placeholder="SalesDb" data-testid="f-database" />
              </Field>
              <Field label="Port">
                <input className="input mono" value={f.port} onChange={(e) => set('port', e.target.value.replace(/[^0-9]/g, ''))} placeholder="1433" inputMode="numeric" data-testid="f-port" />
              </Field>
            </div>
          </div>
          <div className="form-section">
            <h3>Authentication</h3>
            <div className="field-grid">
              <Field label="Mode" wide>
                <select className="select" value={f.mode} onChange={(e) => set('mode', e.target.value as AuthMode)} data-testid="f-mode">
                  {(Object.keys(AUTH_LABEL) as AuthMode[]).map((m) => (
                    <option key={m} value={m}>
                      {AUTH_LABEL[m]}
                    </option>
                  ))}
                </select>
              </Field>
              {f.mode === 'sql' ? (
                <>
                  <Field label="User">
                    <input className="input mono" value={f.user} onChange={(e) => set('user', e.target.value)} autoComplete="off" data-testid="f-user" />
                  </Field>
                  <Field label="Password" hint={profile?.auth.hasPassword ? 'Stored in data/connections.json on this machine.' : 'Stored in plain text in data/connections.json on this machine; prefer Entra.'}>
                    <input
                      className="input"
                      type="password"
                      value={f.password}
                      onChange={(e) => set('password', e.target.value)}
                      placeholder={profile?.auth.hasPassword ? 'saved — leave blank to keep' : ''}
                      autoComplete="new-password"
                      data-testid="f-password"
                    />
                  </Field>
                </>
              ) : (
                <>
                  <Field label="Tenant ID (optional)" hint="Set when your account spans several tenants.">
                    <input className="input mono" value={f.tenantId} onChange={(e) => set('tenantId', e.target.value)} placeholder="contoso.onmicrosoft.com" />
                  </Field>
                  {f.mode !== 'entra-cli' ? (
                    <Field label="Client ID (optional)" hint={f.mode === 'entra-default' ? 'Managed identity client id.' : 'Custom public client app; default is the Azure CLI app.'}>
                      <input className="input mono" value={f.clientId} onChange={(e) => set('clientId', e.target.value)} />
                    </Field>
                  ) : null}
                  <div className="field-hint" style={{ gridColumn: '1 / -1' }}>
                    {f.mode === 'entra-cli'
                      ? 'Uses the account from `az login` on this machine.'
                      : f.mode === 'entra-interactive'
                        ? 'Opens a browser sign-in once per server process.'
                        : 'DefaultAzureCredential: environment, managed identity, VS Code, Azure CLI, …'}
                  </div>
                </>
              )}
            </div>
          </div>
          <div className="form-section">
            <h3>Options</h3>
            <div className="field-grid">
              <div className="col" style={{ gap: 8 }}>
                <label className="check">
                  <input type="checkbox" checked={f.encrypt} onChange={(e) => set('encrypt', e.target.checked)} /> Encrypt
                </label>
                <label className="check">
                  <input type="checkbox" checked={f.trustServerCertificate} onChange={(e) => set('trustServerCertificate', e.target.checked)} data-testid="f-trust" /> Trust server certificate
                </label>
                <label className="check" title="ApplicationIntent=ReadOnly, e.g. a failover-group read-only listener">
                  <input type="checkbox" checked={f.readOnlyIntent} onChange={(e) => set('readOnlyIntent', e.target.checked)} /> Read-only intent
                </label>
              </div>
              <Field label="Jobs source">
                <select className="select" value={f.jobsSource} onChange={(e) => set('jobsSource', e.target.value as JobsSource)} data-testid="f-jobs-source">
                  {(Object.keys(JOBS_SOURCE_LABEL) as JobsSource[]).map((m) => (
                    <option key={m} value={m}>
                      {JOBS_SOURCE_LABEL[m]}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          </div>
          <div className="form-section">
            <details className="collapsible" open={f.jobsEnabled || undefined}>
              <summary data-testid="f-jobs-toggle">
                <Icon name="chevronRight" size={12} /> Elastic Jobs database (optional)
              </summary>
              <label className="check" style={{ marginBottom: 10 }}>
                <input type="checkbox" checked={f.jobsEnabled} onChange={(e) => set('jobsEnabled', e.target.checked)} data-testid="f-jobs-enabled" /> Read Elastic Jobs from a job database
              </label>
              <div className="field-grid" style={{ gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1.4fr) 110px', opacity: f.jobsEnabled ? 1 : 0.5 }}>
                <Field label="Server" hint="The job agent's logical server; may differ from the target's.">
                  <input className="input mono" value={f.jobsServer} disabled={!f.jobsEnabled} onChange={(e) => set('jobsServer', e.target.value)} data-testid="f-jobs-server" />
                </Field>
                <Field label="Job database">
                  <input className="input mono" value={f.jobsDatabase} disabled={!f.jobsEnabled} onChange={(e) => set('jobsDatabase', e.target.value)} data-testid="f-jobs-database" />
                </Field>
                <Field label="Port">
                  <input className="input mono" value={f.jobsPort} disabled={!f.jobsEnabled} onChange={(e) => set('jobsPort', e.target.value.replace(/[^0-9]/g, ''))} data-testid="f-jobs-port" />
                </Field>
              </div>
            </details>
          </div>
          {problem ? <Callout tone="danger">{problem}</Callout> : null}
          {save.error ? (
            <Callout tone="danger" title="Could not save">
              {errorMessage(save.error)}
            </Callout>
          ) : null}
        </div>
        <div className="dialog-footer" style={{ justifyContent: 'flex-start' }}>
          <button type="submit" className="btn btn-primary" disabled={save.isPending} data-testid="f-save">
            {save.isPending ? <Spinner /> : null}
            {profile ? 'Save changes' : 'Save connection'}
          </button>
          <button type="button" className="btn" onClick={() => void doTest()} disabled={save.isPending || test.isPending} data-testid="f-test">
            {test.isPending ? <Spinner /> : null}
            {dirty || !profile ? 'Save & test' : 'Test connection'}
          </button>
          {savedNote ? (
            <span className="small" style={{ color: 'var(--ok)' }} data-testid="f-saved">
              <Icon name="check" size={13} /> {savedNote}
            </span>
          ) : null}
          <span className="spacer" />
          {profile ? (
            <button type="button" className="btn btn-ghost" onClick={() => navigate(`/c/${encodeURIComponent(profile.id)}/overview`)} data-testid="f-open">
              Open overview
            </button>
          ) : null}
          <button type="button" className="btn btn-ghost" onClick={onDone}>
            {profile ? 'Done' : 'Cancel'}
          </button>
        </div>
      </form>
      <div className="stack-md">
        {test.isPending ? (
          <div className="card">
            <Loading label="Testing connection…" />
          </div>
        ) : test.error ? (
          <Callout tone="danger" title="Test failed">
            {errorMessage(test.error)}
          </Callout>
        ) : test.data ? (
          <div className="card">
            <div className="card-header">
              <h3 className="grow">Test result</h3>
              <Badge tone={test.data.ok ? 'ok' : 'danger'}>{test.data.ok ? 'connected' : 'failed'}</Badge>
            </div>
            <div className="card-body">
              <TestResultPanel result={test.data} profile={profile} />
            </div>
          </div>
        ) : (
          <div className="card">
            <Empty
              compact
              icon="check"
              title="Test the connection"
              body="Checks that db-audit can sign in, reports the engine edition and version, and probes the permissions it needs (with the GRANT to fix each missing one)."
            />
          </div>
        )}
      </div>
    </div>
  );
}

function permState(check: EndpointCheck, p: PermissionInfo, profile: Pick<ConnectionProfile, 'jobsSource'> | null): 'ok' | 'bad' | 'na' {
  const v = check.permissions?.[p.key];
  if (p.key === 'agentJobs') {
    if (check.engineEdition === 5) return 'na';
    if (profile && (profile.jobsSource === 'elastic' || profile.jobsSource === 'none')) return v ? 'ok' : 'na';
  }
  if (v === undefined) return 'na';
  return v ? 'ok' : 'bad';
}

function EndpointResult({ title, check, perms, profile }: { title: string; check: EndpointCheck; perms: PermissionInfo[]; profile: Pick<ConnectionProfile, 'jobsSource'> | null }) {
  const edition = check.engineEdition !== undefined ? (check.engineEditionLabel ?? ENGINE_EDITIONS[check.engineEdition] ?? `EngineEdition ${check.engineEdition}`) : null;
  return (
    <div className="stack-sm" data-testid="endpoint-result">
      <div className="row">
        <strong className="grow">{title}</strong>
        <Badge tone={check.ok ? 'ok' : 'danger'}>{check.ok ? 'ok' : 'error'}</Badge>
      </div>
      {!check.ok && check.error ? (
        <Callout tone="danger">
          <span style={{ overflowWrap: 'anywhere' }}>{check.error}</span>
          {hintFor(check.error) ? <div className="fix">{hintFor(check.error)}</div> : null}
        </Callout>
      ) : null}
      {check.ok ? (
        <dl className="kv small">
          {edition ? (
            <>
              <dt>Engine</dt>
              <dd data-testid="engine-edition">
                {edition}
                {check.engineEdition !== undefined ? <span className="muted"> (EngineEdition {check.engineEdition})</span> : null}
              </dd>
            </>
          ) : null}
          {check.edition ? (
            <>
              <dt>Edition</dt>
              <dd>{check.edition}</dd>
            </>
          ) : null}
          {check.serverVersion ? (
            <>
              <dt>Version</dt>
              <dd className="mono">{check.serverVersion}</dd>
            </>
          ) : null}
          {check.database ? (
            <>
              <dt>Database</dt>
              <dd className="mono">{check.database}</dd>
            </>
          ) : null}
          {check.loginName ? (
            <>
              <dt>Login</dt>
              <dd className="mono">{check.loginName}</dd>
            </>
          ) : null}
        </dl>
      ) : null}
      {check.ok && check.permissions ? (
        <ul className="perm-list" data-testid="permission-list">
          {perms.map((p) => {
            const s = permState(check, p, profile);
            return (
              <li key={p.key} data-perm={p.key} data-state={s}>
                <span className={s === 'ok' ? 'perm-ok' : s === 'bad' ? 'perm-bad' : 'perm-na'}>
                  <Icon name={s === 'ok' ? 'check' : s === 'bad' ? 'x' : 'info'} size={15} />
                </span>
                <div>
                  <div style={{ fontWeight: 550 }}>
                    {p.label} {!p.required ? <span className="muted small">(optional)</span> : null}
                  </div>
                  <div className="small muted">
                    {s === 'na'
                      ? p.key === 'agentJobs' && check.engineEdition === 5
                        ? 'Not applicable: Azure SQL Database has no SQL Agent.'
                        : 'Not checked for this connection.'
                      : p.impact}
                  </div>
                  {s === 'bad' ? <div className="fix">Fix: {p.fix}</div> : null}
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

export function TestResultPanel({ result, profile }: { result: ConnectionTestResult; profile: Pick<ConnectionProfile, 'jobsSource'> | null }) {
  return (
    <div className="stack-md" data-testid="test-result">
      <EndpointResult title="Target database" check={result.target} perms={TARGET_PERMISSIONS} profile={profile} />
      {result.jobs ? (
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
          <EndpointResult title="Elastic Jobs database" check={result.jobs} perms={JOBS_PERMISSIONS} profile={profile} />
        </div>
      ) : null}
    </div>
  );
}
