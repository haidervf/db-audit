import assert from 'node:assert/strict';
import fs from 'node:fs';
import { after, before, describe, it } from 'node:test';
import type { ConnectionProfile, ConnectionTestResult } from '../../shared/types';
import { api, connectionInput, dockerUnavailableReason, startServer, tempContext } from './helpers';

const SECRET = 'S3cret!ValueThatMustNeverLeak';

describe('connections CRUD over HTTP', () => {
  const ctx = tempContext();
  let srv: Awaited<ReturnType<typeof startServer>>;
  let id = '';
  const responses: string[] = [];
  const call = async <T>(method: string, url: string, body?: unknown) => {
    const r = await api<T>(srv.base, method, url, body);
    responses.push(r.text);
    return r;
  };

  before(async () => {
    srv = await startServer(ctx);
  });
  after(async () => {
    await srv.close();
    await ctx.cleanup();
  });

  it('POST creates a profile; response has hasPassword and no password', async () => {
    const input = { ...connectionInput('AuditDemo', 'full'), auth: { mode: 'sql', user: 'audit_full', password: SECRET } };
    const r = await call<ConnectionProfile>('POST', '/api/connections', input);
    assert.equal(r.status, 201);
    id = r.body.id;
    assert.match(id, /^[a-z0-9]{8}$/);
    assert.equal(r.body.auth.hasPassword, true);
    assert.equal('password' in r.body.auth, false);
    assert.equal(r.body.jobsSource, 'auto');
    assert.equal(r.body.options.readOnlyIntent, false);
    assert.equal(r.body.lastRefreshAt, null);
  });

  it('connections.json is 0600 in a 0700 directory and holds the secret', () => {
    const st = fs.statSync(ctx.paths.connectionsFile);
    assert.equal(st.mode & 0o777, 0o600);
    assert.equal(fs.statSync(ctx.paths.dataDir).mode & 0o777, 0o700);
    assert.ok(fs.readFileSync(ctx.paths.connectionsFile, 'utf8').includes(SECRET));
    assert.deepEqual(fs.readdirSync(ctx.paths.dataDir).filter((f) => f.includes('.tmp-')), [], 'no temp files left by the atomic write');
  });

  it('GET list / GET one never include the password', async () => {
    const list = await call<ConnectionProfile[]>('GET', '/api/connections');
    assert.equal(list.status, 200);
    assert.equal(list.body.length, 1);
    const one = await call<ConnectionProfile>('GET', `/api/connections/${id}`);
    assert.equal(one.status, 200);
    assert.equal(one.body.name, 'AuditDemo as audit_full');
  });

  it('PUT without password (omitted or empty) keeps the stored one; with a password replaces it', async () => {
    const base = connectionInput('AuditDemo', 'full');
    const omitted = await call<ConnectionProfile>('PUT', `/api/connections/${id}`, { ...base, name: 'renamed', auth: { mode: 'sql', user: 'audit_full' } });
    assert.equal(omitted.status, 200);
    assert.equal(omitted.body.name, 'renamed');
    assert.equal(omitted.body.auth.hasPassword, true);
    assert.ok(fs.readFileSync(ctx.paths.connectionsFile, 'utf8').includes(SECRET));

    const empty = await call<ConnectionProfile>('PUT', `/api/connections/${id}`, { ...base, auth: { mode: 'sql', user: 'audit_full', password: '' } });
    assert.equal(empty.status, 200);
    assert.ok(fs.readFileSync(ctx.paths.connectionsFile, 'utf8').includes(SECRET));

    const replaced = await call<ConnectionProfile>('PUT', `/api/connections/${id}`, { ...base, jobsSource: 'agent', options: { encrypt: true, trustServerCertificate: true, readOnlyIntent: true } });
    assert.equal(replaced.status, 200);
    assert.equal(replaced.body.jobsSource, 'agent');
    assert.equal(replaced.body.options.readOnlyIntent, true);
    const file = fs.readFileSync(ctx.paths.connectionsFile, 'utf8');
    assert.ok(!file.includes(SECRET));
    assert.ok(file.includes(base.auth.password!));
    assert.equal(fs.statSync(ctx.paths.connectionsFile).mode & 0o777, 0o600);
  });

  it('switching to an Entra mode drops the stored password', async () => {
    const r = await call<ConnectionProfile>('PUT', `/api/connections/${id}`, { ...connectionInput('AuditDemo', 'full'), auth: { mode: 'entra-cli', tenantId: 'contoso.onmicrosoft.com' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.auth.hasPassword, false);
    assert.equal(r.body.auth.tenantId, 'contoso.onmicrosoft.com');
    // restore sql auth for the following tests
    const back = await call<ConnectionProfile>('PUT', `/api/connections/${id}`, connectionInput('AuditDemo', 'full'));
    assert.equal(back.body.auth.hasPassword, true);
  });

  it('validation: 400 with details; sql auth without password on create is rejected', async () => {
    const r = await call<{ error: string; details: unknown }>('POST', '/api/connections', { name: '', target: { server: 'x' } });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'invalid request');
    assert.ok(Array.isArray(r.body.details));
    const noPw = await call<{ error: string }>('POST', '/api/connections', { ...connectionInput('AuditDemo', 'full'), auth: { mode: 'sql', user: 'x' } });
    assert.equal(noPw.status, 400);
    const bad = await call('GET', '/api/connections/does-not-exist');
    assert.equal(bad.status, 404);
  });

  it('POST /test reports server, login and permission probes (Docker)', async (t) => {
    const reason = await dockerUnavailableReason();
    if (reason) return t.skip(reason);
    const r = await call<ConnectionTestResult>('POST', `/api/connections/${id}/test`);
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.target.database, 'AuditDemo');
    assert.equal(r.body.target.loginName, 'audit_full');
    assert.match(r.body.target.serverVersion ?? '', /^16\./);
    assert.equal(r.body.target.engineEdition, 3);
    assert.match(r.body.target.engineEditionLabel ?? '', /Enterprise/);
    assert.deepEqual(r.body.target.permissions, { viewDefinition: true, expressionDependencies: true, viewDatabaseState: true, agentJobs: true });
    assert.equal(r.body.jobs?.ok, true);
    assert.equal(r.body.jobs?.database, 'AuditJobs');
    assert.equal(r.body.jobs?.permissions?.jobsViews, true);
  });

  it('POST /test with a wrong password returns ok:false with the login error and no secret', async (t) => {
    const reason = await dockerUnavailableReason();
    if (reason) return t.skip(reason);
    const created = await call<ConnectionProfile>('POST', '/api/connections', { ...connectionInput('AuditDemo', 'reader'), auth: { mode: 'sql', user: 'audit_reader', password: SECRET } });
    const r = await call<ConnectionTestResult>('POST', `/api/connections/${created.body.id}/test`);
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, false);
    assert.match(r.body.target.error ?? '', /Login failed/);
    await call('DELETE', `/api/connections/${created.body.id}`);
  });

  it('DELETE removes the profile and its cache file', async () => {
    ctx.caches.get(id); // make sure a cache file exists
    const file = ctx.caches.fileFor(id);
    assert.ok(fs.existsSync(file));
    const r = await call('DELETE', `/api/connections/${id}`);
    assert.equal(r.status, 204);
    assert.equal(fs.existsSync(file), false);
    assert.equal((await call('GET', `/api/connections/${id}`)).status, 404);
  });

  it('no API response ever contained a password', () => {
    for (const text of responses) {
      assert.ok(!text.includes(SECRET), 'secret leaked');
      assert.ok(!text.includes(connectionInput('AuditDemo', 'full').auth.password!), 'password leaked');
      assert.ok(!/"password"\s*:/.test(text), `response has a password field: ${text.slice(0, 200)}`);
    }
    assert.ok(responses.length >= 10);
  });
});
