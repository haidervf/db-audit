import crypto from 'node:crypto';
import fs from 'node:fs';
import type { AuthMode, ConnectionProfile, DbEndpoint, JobsSource } from '../../shared/types';
import { writeFileAtomicPrivate } from '../config/paths';
import type { ConnectionInputParsed } from './schema';

/** What is persisted in data/connections.json (includes the password; never returned by the API). */
export interface StoredConnection {
  id: string;
  name: string;
  target: DbEndpoint;
  jobs: DbEndpoint | null;
  jobsSource: JobsSource;
  auth: { mode: AuthMode; user?: string; password?: string; tenantId?: string; clientId?: string };
  options: { encrypt: boolean; trustServerCertificate: boolean; readOnlyIntent: boolean };
  createdAt: string;
  updatedAt: string;
  lastRefreshAt: string | null;
}

interface FileShape {
  version: 1;
  connections: StoredConnection[];
}

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

export function newSlug(length = 8): string {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += ID_ALPHABET[bytes[i] % ID_ALPHABET.length];
  return out;
}

/** Strips secrets. This is the only shape the API returns. */
export function toProfile(c: StoredConnection): ConnectionProfile {
  const auth: ConnectionProfile['auth'] = { mode: c.auth.mode, hasPassword: Boolean(c.auth.password) };
  if (c.auth.user !== undefined) auth.user = c.auth.user;
  if (c.auth.tenantId !== undefined) auth.tenantId = c.auth.tenantId;
  if (c.auth.clientId !== undefined) auth.clientId = c.auth.clientId;
  return {
    id: c.id,
    name: c.name,
    target: { ...c.target },
    jobs: c.jobs ? { ...c.jobs } : null,
    jobsSource: c.jobsSource ?? 'auto',
    auth,
    options: {
      encrypt: c.options.encrypt,
      trustServerCertificate: c.options.trustServerCertificate,
      readOnlyIntent: c.options.readOnlyIntent ?? false,
    },
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    lastRefreshAt: c.lastRefreshAt,
  };
}

function cleanEndpoint(e: DbEndpoint): DbEndpoint {
  const out: DbEndpoint = { server: e.server, database: e.database };
  if (e.port !== undefined) out.port = e.port;
  return out;
}

function buildAuth(input: ConnectionInputParsed['auth'], existing?: StoredConnection['auth']): StoredConnection['auth'] {
  const auth: StoredConnection['auth'] = { mode: input.mode };
  if (input.user) auth.user = input.user;
  if (input.tenantId) auth.tenantId = input.tenantId;
  if (input.clientId) auth.clientId = input.clientId;
  if (input.mode === 'sql') {
    // An omitted or empty password keeps the stored one.
    const pw = input.password ? input.password : existing?.mode === 'sql' ? existing.password : undefined;
    if (pw) auth.password = pw;
  }
  return auth;
}

export class ConnectionStore {
  private connections: StoredConnection[] = [];

  constructor(private readonly file: string) {
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as FileShape;
      this.connections = (Array.isArray(parsed.connections) ? parsed.connections : []).map((c) => ({
        ...c,
        jobsSource: c.jobsSource ?? 'auto',
        options: { ...c.options, readOnlyIntent: c.options?.readOnlyIntent ?? false },
      }));
      fs.chmodSync(file, 0o600);
    }
  }

  private persist(): void {
    const body: FileShape = { version: 1, connections: this.connections };
    writeFileAtomicPrivate(this.file, JSON.stringify(body, null, 2) + '\n');
  }

  list(): ConnectionProfile[] {
    return this.connections.map(toProfile);
  }

  get(id: string): StoredConnection | undefined {
    return this.connections.find((c) => c.id === id);
  }

  create(input: ConnectionInputParsed): StoredConnection {
    let id = newSlug();
    while (this.get(id)) id = newSlug();
    const now = new Date().toISOString();
    const rec: StoredConnection = {
      id,
      name: input.name,
      target: cleanEndpoint(input.target),
      jobs: input.jobs ? cleanEndpoint(input.jobs) : null,
      jobsSource: input.jobsSource,
      auth: buildAuth(input.auth),
      options: {
        encrypt: input.options.encrypt,
        trustServerCertificate: input.options.trustServerCertificate,
        readOnlyIntent: input.options.readOnlyIntent,
      },
      createdAt: now,
      updatedAt: now,
      lastRefreshAt: null,
    };
    this.connections.push(rec);
    this.persist();
    return rec;
  }

  update(id: string, input: ConnectionInputParsed): StoredConnection | undefined {
    const idx = this.connections.findIndex((c) => c.id === id);
    if (idx < 0) return undefined;
    const prev = this.connections[idx];
    const rec: StoredConnection = {
      ...prev,
      name: input.name,
      target: cleanEndpoint(input.target),
      jobs: input.jobs ? cleanEndpoint(input.jobs) : null,
      jobsSource: input.jobsSource,
      auth: buildAuth(input.auth, prev.auth),
      options: {
        encrypt: input.options.encrypt,
        trustServerCertificate: input.options.trustServerCertificate,
        readOnlyIntent: input.options.readOnlyIntent,
      },
      updatedAt: new Date().toISOString(),
    };
    this.connections[idx] = rec;
    this.persist();
    return rec;
  }

  delete(id: string): boolean {
    const before = this.connections.length;
    this.connections = this.connections.filter((c) => c.id !== id);
    if (this.connections.length === before) return false;
    this.persist();
    return true;
  }

  setLastRefreshAt(id: string, iso: string): void {
    const c = this.get(id);
    if (!c) return;
    c.lastRefreshAt = iso;
    this.persist();
  }
}
