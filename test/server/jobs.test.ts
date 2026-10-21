import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { JobDetail, JobSummary, RefreshRun } from '../../shared/types';
import { ReadModel } from '../../server/api/readModel';
import { connectionInput, dockerUnavailableReason, refreshAndWait, SEED, tempContext } from './helpers';

const reason = await dockerUnavailableReason();

function views(ctx: ReturnType<typeof tempContext>, id: string): { rm: ReadModel; jobs: JobSummary[]; detail: (name: string, source: 'agent' | 'elastic') => JobDetail } {
  const rm = new ReadModel(ctx.caches.get(id), ctx.connections.get(id)!);
  const jobs = rm.jobSummaries();
  return {
    rm,
    jobs,
    detail: (name, source) => {
      const j = jobs.find((x) => x.name === name && x.source === source);
      assert.ok(j, `job ${source}:${name} not found`);
      return rm.jobDetail(j.jobId)!;
    },
  };
}

describe('jobs: Elastic Jobs mock (AuditJobs) + SQL Agent (msdb), auto source', { skip: reason ?? false }, () => {
  const ctx = tempContext();
  let demo = '';
  let archive = '';
  let runDemo: RefreshRun;
  let runArchive: RefreshRun;

  before(async () => {
    demo = ctx.connections.create(connectionInput('AuditDemo', 'full')).id;
    archive = ctx.connections.create(connectionInput('AuditArchive', 'reader')).id;
    runDemo = await refreshAndWait(ctx, demo, { segments: ['jobs'], mode: 'full' });
    runArchive = await refreshAndWait(ctx, archive, { segments: ['jobs'], mode: 'full' });
  });
  after(() => ctx.cleanup());

  it('both sources are read; counts match the seeds', () => {
    assert.equal(runDemo.status, 'succeeded', JSON.stringify(runDemo));
    assert.equal(runArchive.status, 'succeeded', JSON.stringify(runArchive));
    const { jobs } = views(ctx, demo);
    const elastic = jobs.filter((j) => j.source === 'elastic');
    const agent = jobs.filter((j) => j.source === 'agent' && j.category === 'db-audit demo');
    assert.equal(elastic.length, SEED.elastic.jobs);
    assert.equal(agent.length, SEED.agent.jobs);
    assert.equal(elastic.reduce((n, j) => n + j.stepCount, 0), SEED.elastic.steps);
    assert.equal(agent.reduce((n, j) => n + j.stepCount, 0), SEED.agent.steps);
    assert.deepEqual(runDemo.counts.jobs, { added: SEED.elastic.jobs + agent.length, updated: 0, removed: 0, unchanged: 0 });
    assert.ok(jobs.every((j) => /^[0-9A-F-]{36}$/.test(j.jobId)));
  });

  it('elastic: steps, command text, members, schedule text, executions', () => {
    const { detail } = views(ctx, demo);
    const nightly = detail('NightlyMaintenance', 'elastic');
    assert.equal(nightly.version, 2);
    assert.deepEqual(nightly.steps.map((s) => s.name), ['RunNightlyBatch', 'ExpireReservations']);
    assert.match(nightly.steps[1].command, /EXEC @rc = dbo\.usp_ExpireReservations @DryRun = 1;/);
    assert.equal(nightly.scheduleText, 'Every day, starting 2026-01-01 02:00 UTC');
    assert.deepEqual(nightly.schedule, { intervalType: 'Days', intervalCount: 1, startTime: '2026-01-01T02:00:00.000Z', endTime: '9999-12-31T11:59:59.000Z' });
    assert.equal(nightly.lastRunOutcome, 'Failed');
    const failed = nightly.executions.find((e) => e.lifecycle === 'Failed' && e.stepId === 2)!;
    assert.match(failed.lastMessage ?? '', /Lock request time out/);
    assert.equal(failed.stepName, 'ExpireReservations');
    assert.equal(failed.durationSeconds, 310);
    assert.equal(nightly.executions.length, 6);

    const purge = detail('PurgeAuditAndSettings', 'elastic');
    assert.match(purge.steps[0].command, /\$\(job_name\)/, 'sqlcmd -x kept the token literal');
    assert.match(purge.steps[0].command, /DELETE TOP \(5000\) FROM dbo\.AuditLog/);
    assert.equal(purge.scheduleText, 'Every 15 minutes, starting 2026-01-01 00:00 UTC');
    const members = purge.steps[0].targetMembers;
    assert.ok(members.some((m) => m.membershipType === 'Include' && m.targetType === 'SqlServer' && m.databaseName === null));
    assert.ok(members.some((m) => m.membershipType === 'Exclude' && m.databaseName === 'AuditArchive'));
    assert.equal(detail('LegacyRebuild', 'elastic').scheduleText, 'Disabled (every week, starting 2025-06-01 03:00 UTC)');
    assert.equal(detail('ArchiveCompaction', 'elastic').scheduleText, 'Once at 2026-11-01 01:00 UTC');
    assert.equal(detail('TenantStats', 'elastic').scheduleText, 'Every 6 hours, starting 2026-03-01 00:30 UTC, until 2027-03-01 00:00 UTC');
    const total = views(ctx, demo).rm.store.listExecutions().filter((e) => e.source === 'elastic').length;
    assert.equal(total, SEED.elastic.executions);
  });

  it('elastic: targetsThisDb for AuditDemo vs AuditArchive profiles', () => {
    const pick = (id: string) =>
      Object.fromEntries(views(ctx, id).jobs.filter((j) => j.source === 'elastic').map((j) => [j.name, j.targetsThisDb]));
    assert.deepEqual(pick(demo), { ArchiveCompaction: false, LegacyRebuild: true, NightlyMaintenance: true, PurgeAuditAndSettings: true, TenantStats: false });
    assert.deepEqual(pick(archive), { ArchiveCompaction: true, LegacyRebuild: false, NightlyMaintenance: false, PurgeAuditAndSettings: false, TenantStats: false });
    const d = views(ctx, demo);
    assert.equal(d.detail('PurgeAuditAndSettings', 'elastic').steps[0].targetMatch, 'server');
    assert.equal(d.detail('NightlyMaintenance', 'elastic').steps[0].targetMatch, 'database');
    assert.equal(d.detail('TenantStats', 'elastic').steps[0].targetMatch, 'pool-unknown');
    assert.equal(views(ctx, archive).detail('PurgeAuditAndSettings', 'elastic').steps[0].targetMatch, 'excluded');
  });

  it('agent: steps, flow control, database_name, subsystems, schedules', () => {
    const { detail } = views(ctx, demo);
    const nightly = detail('AuditDemo - Nightly Maintenance', 'agent');
    assert.equal(nightly.owner, 'sa');
    assert.equal(nightly.category, 'db-audit demo');
    assert.deepEqual(
      nightly.steps.map((s) => [s.stepId, s.name, s.subsystem, s.databaseName, s.onSuccess, s.onFail, s.analyzable]),
      [
        [1, 'Run nightly batch', 'TSQL', 'AuditDemo', 'Go to next step', 'Quit reporting failure', true],
        [2, 'Expire reservations (dry run)', 'TSQL', 'AuditDemo', 'Quit reporting success', 'Quit reporting failure', true],
      ],
    );
    assert.equal(nightly.steps[0].command, 'EXEC dbo.usp_NightlyBatch;');
    assert.equal(nightly.steps[0].retryAttempts, 1);
    assert.equal(nightly.steps[0].retryIntervalMinutes, 5);
    assert.match(nightly.steps[1].command, /EXEC @rc = dbo\.usp_ExpireReservations @DryRun = 1;/);
    assert.equal(nightly.steps[1].outputFileName, '/var/opt/mssql/log/nightly_maintenance.txt');
    assert.equal(nightly.scheduleText, 'Every day at 02:00:00');
    assert.deepEqual(nightly.schedule, { intervalType: null, intervalCount: null, startTime: null, endTime: null });
    assert.ok(nightly.nextRun && nightly.nextRun.endsWith('T02:00:00.000Z'), `nextRun ${nightly.nextRun}`);
    // per-schedule next run: the job's only enabled schedule carries the job-level next run even while
    // msdb.dbo.sysjobschedules.next_run_date is still 0 (the header and the schedule row must agree)
    assert.deepEqual(nightly.schedules.map((x) => [x.name, x.enabled, x.nextRun]), [['db-audit nightly 02:00', true, nightly.nextRun]]);

    const purge = detail('AuditDemo - Purge Audit and Settings', 'agent');
    assert.deepEqual(purge.schedules.map((s) => s.text).sort(), ['Every day, every 15 minutes between 00:00:00 and 23:59:59', 'Weekly on Sun every 1 week(s) at 03:00:00']);
    assert.match(purge.steps[0].command, /UPDATE dbo\.Settings/);
    assert.match(purge.steps[0].command, /\$\(ESCAPE_SQUOTE\(JOBNAME\)\)/);

    const legacy = detail('AuditDemo - Legacy Shipment Sync', 'agent');
    assert.equal(legacy.enabled, false);
    assert.equal(legacy.nextRun, null);
    assert.equal(legacy.scheduleText, 'Disabled (weekly on Mon, Wed every 1 week(s) at 02:00:00)');
    assert.deepEqual(legacy.steps.map((s) => [s.subsystem, s.analyzable, s.onSuccess]), [['TSQL', true, 'Go to step 2'], ['CmdExec', false, 'Quit reporting success']]);
    assert.equal(legacy.steps[1].command, 'echo sync finished');

    const comp = detail('AuditArchive - Compaction', 'agent');
    assert.equal(comp.steps[0].databaseName, 'AuditArchive');
    assert.equal(comp.scheduleText, 'Monthly on day 1 every 1 month(s) at 01:00:00');
  });

  it('agent: history incl. the failed run; outcome rows map to stepId null', () => {
    const { detail } = views(ctx, demo);
    const bal = detail('AuditDemo - Points Check', 'agent');
    assert.equal(bal.lastRunOutcome, 'Failed');
    const step = bal.executions.find((e) => e.stepId === 1)!;
    assert.equal(step.runStatus, 'Failed');
    assert.equal(step.lifecycle, 'Failed');
    assert.match(step.lastMessage ?? '', /Points check failed on purpose/);
    assert.equal(step.targetDatabaseName, 'AuditDemo');
    const outcome = bal.executions.find((e) => e.stepId === null)!;
    assert.equal(outcome.stepName, '(Job outcome)');
    assert.match(outcome.lastMessage ?? '', /The job failed/);
    assert.ok(outcome.startTime && !Number.isNaN(Date.parse(outcome.startTime)));
    assert.equal(bal.lastExecution?.stepId, null);

    const nightly = detail('AuditDemo - Nightly Maintenance', 'agent');
    assert.equal(nightly.lastRunOutcome, 'Succeeded');
    assert.ok(nightly.executions.length >= 3, 'two step rows + one outcome row per run');
    assert.ok(nightly.executions.every((e) => typeof e.durationSeconds === 'number'));
  });

  it('agent: targetsThisDb = step database_name matches the profile database', () => {
    const pick = (id: string) =>
      Object.fromEntries(views(ctx, id).jobs.filter((j) => j.source === 'agent' && j.category === 'db-audit demo').map((j) => [j.name, j.targetsThisDb]));
    assert.deepEqual(pick(demo), {
      'AuditArchive - Compaction': false,
      'AuditDemo - Points Check': true,
      'AuditDemo - Legacy Shipment Sync': true,
      'AuditDemo - Nightly Maintenance': true,
      'AuditDemo - Purge Audit and Settings': true,
    });
    assert.deepEqual(pick(archive), {
      'AuditArchive - Compaction': true,
      'AuditDemo - Points Check': false,
      'AuditDemo - Legacy Shipment Sync': false,
      'AuditDemo - Nightly Maintenance': false,
      'AuditDemo - Purge Audit and Settings': false,
    });
  });

  it('jobsUsing (text match) links procedures to steps of both sources that target this DB', async () => {
    await refreshAndWait(ctx, demo, { segments: ['procedures'], mode: 'full' });
    const p = views(ctx, demo).rm.detail('procedure', 'dbo', 'usp_NightlyBatch')!;
    assert.deepEqual(p.jobsUsing.map((u) => `${u.source}:${u.jobName}#${u.stepId}`).sort(), ['agent:AuditDemo - Nightly Maintenance#1', 'elastic:NightlyMaintenance#1']);
    const e = views(ctx, demo).rm.detail('procedure', 'dbo', 'usp_ExpireReservations')!;
    assert.deepEqual(e.jobsUsing.map((u) => `${u.source}:${u.jobName}#${u.stepId}`).sort(), ['agent:AuditDemo - Nightly Maintenance#2', 'elastic:NightlyMaintenance#2']);
  });
});

describe('jobs: read paths and degradation', { skip: reason ?? false }, () => {
  const ctx = tempContext();
  after(() => ctx.cleanup());

  it('audit_full (direct SELECT) and audit_reader (sp_help_job* as SQLAgentReaderRole) produce identical Agent jobs', async () => {
    const a = ctx.connections.create(connectionInput('AuditDemo', 'full', { jobs: null, jobsSource: 'agent' })).id;
    const b = ctx.connections.create(connectionInput('AuditDemo', 'reader', { jobs: null, jobsSource: 'agent' })).id;
    const ra = await refreshAndWait(ctx, a, { segments: ['jobs'], mode: 'full' });
    const rb = await refreshAndWait(ctx, b, { segments: ['jobs'], mode: 'full' });
    assert.equal(ra.status, 'succeeded');
    assert.equal(rb.status, 'succeeded');
    assert.equal(ctx.caches.get(a).getMeta('agent_read_path'), 'direct');
    assert.equal(ctx.caches.get(b).getMeta('agent_read_path'), 'sp_help');
    const da = views(ctx, a);
    const db = views(ctx, b);
    // executions can differ if Agent ran a scheduled job between the two reads; compare definitions
    // Phase B: step analyses carry run-specific timing (analyzedAt, stats.durationMs); the rest must match
    const untimed = (st: JobDetail['steps'][number]) => ({ ...st, analysis: st.analysis && { ...st.analysis, analyzedAt: '', stats: { ...st.analysis.stats, durationMs: 0 } } });
    const strip = (id: string, v: ReturnType<typeof views>) =>
      v.jobs.map((j) => {
        const d = v.rm.jobDetail(j.jobId)!;
        // next runs are live values (and only sp_help_job names the schedule of a multi-schedule job's next run)
        return { ...d, steps: d.steps.map(untimed), schedules: d.schedules.map((x) => ({ ...x, nextRun: null })), executions: [], lastExecution: null, lastRunOutcome: null, nextRun: null };
      });
    assert.deepEqual(strip(a, da), strip(b, db));
    assert.ok(da.jobs.every((j) => j.source === 'agent'));
    for (const v of [da, db]) {
      const nightly = v.detail('AuditDemo - Nightly Maintenance', 'agent');
      assert.ok(nightly.nextRun, 'job-level next run');
      assert.equal(nightly.schedules[0]!.nextRun, nightly.nextRun, 'schedule row next run = job next run');
    }
    // sp_help path: sp_help_job's next_run_schedule_id attributes the next run to one of the two schedules
    const purge = db.detail('AuditDemo - Purge Audit and Settings', 'agent');
    assert.ok(purge.nextRun && purge.schedules.some((x) => x.nextRun === purge.nextRun), JSON.stringify(purge.schedules));
  });

  it('audit_nojobs: refresh succeeds with "Agent jobs not readable" warning and no jobs', async () => {
    const id = ctx.connections.create(connectionInput('AuditDemo', 'nojobs', { jobs: null })).id;
    const r = await refreshAndWait(ctx, id, { segments: 'all', mode: 'full' });
    assert.equal(r.status, 'succeeded', JSON.stringify(r));
    assert.ok(r.warnings.some((w) => w.startsWith('Agent jobs not readable (needs SQLAgentReaderRole in msdb)')), r.warnings.join('\n'));
    assert.equal(ctx.caches.get(id).countObjects().job, 0);
    assert.equal(ctx.caches.get(id).countObjects().procedure, SEED.auditDemo.procedure);
  });

  it("jobsSource 'none' skips (and clears) jobs; 'elastic' / 'agent' read only that source", async () => {
    const id = ctx.connections.create(connectionInput('AuditDemo', 'full')).id;
    const auto = await refreshAndWait(ctx, id, { segments: ['jobs'], mode: 'full' });
    assert.equal(auto.status, 'succeeded');
    assert.ok(ctx.caches.get(id).countObjects().job >= SEED.agent.jobs + SEED.elastic.jobs);

    ctx.connections.update(id, connectionInput('AuditDemo', 'full', { jobsSource: 'elastic' }));
    const el = await refreshAndWait(ctx, id, { segments: ['jobs'], mode: 'full' });
    assert.ok(new Set(views(ctx, id).jobs.map((j) => j.source)).size === 1 && views(ctx, id).jobs[0].source === 'elastic');
    assert.equal(el.counts.jobs?.unchanged, SEED.elastic.jobs);

    ctx.connections.update(id, connectionInput('AuditDemo', 'full', { jobsSource: 'agent' }));
    await refreshAndWait(ctx, id, { segments: ['jobs'], mode: 'full' });
    assert.ok(views(ctx, id).jobs.every((j) => j.source === 'agent'));

    ctx.connections.update(id, connectionInput('AuditDemo', 'full', { jobsSource: 'none' }));
    const none = await refreshAndWait(ctx, id, { segments: ['jobs'], mode: 'full' });
    assert.equal(none.status, 'succeeded');
    assert.equal(none.counts.jobs?.added, 0);
    assert.ok((none.counts.jobs?.removed ?? 0) >= SEED.agent.jobs);
    assert.equal(ctx.caches.get(id).countObjects().job, 0);
    assert.ok(none.warnings.some((w) => /jobsSource is "none"/.test(w)));
  });

  it("jobsSource 'elastic' without a jobs endpoint warns instead of failing", async () => {
    const id = ctx.connections.create(connectionInput('AuditDemo', 'full', { jobs: null, jobsSource: 'elastic' })).id;
    const r = await refreshAndWait(ctx, id, { segments: ['jobs'], mode: 'full' });
    assert.equal(r.status, 'succeeded');
    assert.ok(r.warnings.some((w) => /no jobs endpoint is configured/.test(w)));
  });
});
