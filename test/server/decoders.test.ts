import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseServer, hostLabel } from '../../server/db/poolConfig';
import {
  agentDateTimeToIso,
  agentDurationSeconds,
  agentScheduleNextRuns,
  agentScheduleText,
  lastRunOutcomeLabel,
  stepActionText,
  type AgentScheduleFields,
} from '../../server/extract/agentDecode';
import { nextElasticRun, scheduleText } from '../../server/extract/schedule';
import { evaluateTargets, normalizeMembership } from '../../server/extract/targets';

const sched = (o: Partial<AgentScheduleFields>): AgentScheduleFields => ({
  freq_type: 4,
  freq_interval: 1,
  freq_subday_type: 1,
  freq_subday_interval: 0,
  freq_relative_interval: 0,
  freq_recurrence_factor: 0,
  active_start_date: 20260101,
  active_end_date: 99991231,
  active_start_time: 0,
  active_end_time: 235959,
  ...o,
});

describe('agent decoders', () => {
  it('schedule text', () => {
    assert.equal(agentScheduleText(sched({ freq_subday_type: 4, freq_subday_interval: 15 })), 'Every day, every 15 minutes between 00:00:00 and 23:59:59');
    assert.equal(agentScheduleText(sched({ freq_type: 8, freq_interval: 2 | 8, freq_recurrence_factor: 1, active_start_time: 20000 })), 'Weekly on Mon, Wed every 1 week(s) at 02:00:00');
    assert.equal(agentScheduleText(sched({ freq_type: 4, freq_interval: 2, active_start_time: 233000 })), 'Every 2 days at 23:30:00');
    assert.equal(agentScheduleText(sched({ freq_type: 16, freq_interval: 15, freq_recurrence_factor: 3, active_start_time: 10000 })), 'Monthly on day 15 every 3 month(s) at 01:00:00');
    assert.equal(agentScheduleText(sched({ freq_type: 32, freq_interval: 2, freq_relative_interval: 16, freq_recurrence_factor: 1 })), 'Monthly on the last Monday every 1 month(s) at 00:00:00');
    assert.equal(agentScheduleText(sched({ freq_type: 1, active_start_date: 20261101, active_start_time: 13000 })), 'Once on 2026-11-01 at 01:30:00');
    assert.equal(agentScheduleText(sched({ freq_type: 64 })), 'When SQL Server Agent starts');
    assert.equal(agentScheduleText(sched({ freq_subday_type: 8, freq_subday_interval: 1, active_end_date: 20261231 })), 'Every day, every 1 hour between 00:00:00 and 23:59:59, until 2026-12-31');
  });

  it('dates, durations, outcomes, flow control', () => {
    assert.equal(agentDateTimeToIso(20261014, 25549, 0), '2026-10-14T02:55:49.000Z');
    assert.equal(agentDateTimeToIso(20261014, 25549, 780), '2026-10-13T13:55:49.000Z', 'server at UTC+13 -> UTC');
    assert.equal(agentDateTimeToIso(0, 0, 0), null);
    assert.equal(agentDurationSeconds(13), 13);
    assert.equal(agentDurationSeconds(10203), 3723);
    assert.equal(agentDurationSeconds(1000000), 360000, 'hours > 99');
    assert.equal(lastRunOutcomeLabel(0, 20261014), 'Failed');
    assert.equal(lastRunOutcomeLabel(1, 0), null, 'never run');
    assert.equal(stepActionText(3, 0), 'Go to next step');
    assert.equal(stepActionText(4, 3), 'Go to step 3');
    assert.equal(stepActionText(2, 0), 'Quit reporting failure');
  });

  it('per-schedule next run: stored sysjobschedules value, else the live job-level value for its schedule', () => {
    const live = '2026-10-15T02:00:00.000Z';
    const nightly = { scheduleId: 14, enabled: true, nextRunDate: 0, nextRunTime: 0 };
    // sysjobschedules.next_run_* still 0 (Agent has not written it yet), one enabled schedule -> the job's live next run
    assert.deepEqual(agentScheduleNextRuns([nightly], { enabled: true, nextRun: live, nextRunScheduleId: null }, 0), [live]);
    // ... the same through sp_help_job's next_run_schedule_id
    assert.deepEqual(agentScheduleNextRuns([nightly], { enabled: true, nextRun: live, nextRunScheduleId: 14 }, 0), [live]);
    // stored value decoded (server at UTC+13) when Agent provides it
    assert.deepEqual(
      agentScheduleNextRuns([{ ...nightly, nextRunDate: 20261015, nextRunTime: 20000 }], { enabled: true, nextRun: null, nextRunScheduleId: null }, 780),
      ['2026-10-14T13:00:00.000Z'],
    );
    // two enabled schedules: the live value goes only to the schedule sp_help_job names; the other keeps its stored value
    const every15 = { scheduleId: 20, enabled: true, nextRunDate: 0, nextRunTime: 0 };
    const weekly = { scheduleId: 21, enabled: true, nextRunDate: 20261018, nextRunTime: 30000 };
    assert.deepEqual(agentScheduleNextRuns([every15, weekly], { enabled: true, nextRun: live, nextRunScheduleId: 20 }, 0), [live, '2026-10-18T03:00:00.000Z']);
    // ... and is not guessed without it (direct path)
    assert.deepEqual(agentScheduleNextRuns([every15, weekly], { enabled: true, nextRun: live, nextRunScheduleId: null }, 0), [null, '2026-10-18T03:00:00.000Z']);
    // a disabled schedule never gets the job's next run; the enabled one does
    assert.deepEqual(agentScheduleNextRuns([{ ...every15, enabled: false }, { ...weekly, nextRunDate: 0 }], { enabled: true, nextRun: live, nextRunScheduleId: null }, 0), [null, live]);
    // disabled job / no job-level next run: stored values only
    assert.deepEqual(agentScheduleNextRuns([nightly], { enabled: false, nextRun: null, nextRunScheduleId: 14 }, 0), [null]);
    assert.deepEqual(agentScheduleNextRuns([nightly], { enabled: true, nextRun: null, nextRunScheduleId: 14 }, 0), [null]);
  });
});

describe('elastic schedule + targets', () => {
  it('schedule text and next run', () => {
    const s = { intervalType: 'Minutes', intervalCount: 15, startTime: '2026-01-01T00:00:00.000Z', endTime: '9999-12-31T11:59:59.000Z' };
    assert.equal(scheduleText(true, s), 'Every 15 minutes, starting 2026-01-01 00:00 UTC');
    assert.equal(scheduleText(false, s), 'Disabled (every 15 minutes, starting 2026-01-01 00:00 UTC)');
    assert.equal(scheduleText(true, { intervalType: 'Once', intervalCount: 1, startTime: '0001-01-01T00:00:00.000Z', endTime: null }), 'Once, when started (no start time)');
    assert.equal(nextElasticRun(true, s, new Date('2026-10-14T03:07:00Z')), '2026-10-14T03:15:00.000Z');
    assert.equal(nextElasticRun(false, s), null);
    assert.equal(nextElasticRun(true, { intervalType: 'Months', intervalCount: 1, startTime: '2026-01-31T00:00:00.000Z', endTime: null }, new Date('2026-02-01T00:00:00Z'))?.slice(0, 7), '2026-03');
    assert.equal(nextElasticRun(true, { ...s, endTime: '2026-06-01T00:00:00.000Z' }, new Date('2026-10-14T00:00:00Z')), null);
  });

  it('targetsThisDb rules', () => {
    const t = { server: 'myserver.database.windows.net', database: 'SalesDb' };
    const m = (membershipType: string, targetType: string, serverName: string, databaseName: string | null) => ({ membershipType, targetType, serverName, databaseName, elasticPoolName: null });
    assert.deepEqual(evaluateTargets([m('Include', 'SqlDatabase', 'MyServer.database.windows.net', 'salesdb')], t), { targetsThisDb: true, targetMatch: 'database' });
    assert.deepEqual(evaluateTargets([m('Include', 'SqlDatabase', 'otherserver.database.windows.net', 'SalesDb')], t), { targetsThisDb: false, targetMatch: 'none' });
    assert.deepEqual(evaluateTargets([m('Include', 'SqlServer', 'myserver.database.windows.net', null)], t), { targetsThisDb: true, targetMatch: 'server' });
    assert.deepEqual(
      evaluateTargets([m('Include', 'SqlServer', 'myserver.database.windows.net', null), m('Exclude', 'SqlDatabase', 'myserver.database.windows.net', 'SalesDb')], t),
      { targetsThisDb: false, targetMatch: 'excluded' },
    );
    assert.deepEqual(evaluateTargets([m('Include', 'SqlElasticPool', 'myserver.database.windows.net', null)], t), { targetsThisDb: false, targetMatch: 'pool-unknown' });
    assert.equal(normalizeMembership('0'), 'Include');
    assert.equal(normalizeMembership('exclude'), 'Exclude');
  });

  it('server string parsing', () => {
    assert.deepEqual(parseServer('tcp:myserver.database.windows.net,1433'), { host: 'myserver.database.windows.net', port: 1433, instanceName: undefined });
    assert.deepEqual(parseServer('localhost', 14340), { host: 'localhost', port: 14340, instanceName: undefined });
    assert.deepEqual(parseServer('host\\SQL2022'), { host: 'host', port: undefined, instanceName: 'SQL2022' });
    assert.equal(hostLabel('MyMI.abc123.database.windows.net'), 'mymi');
  });
});
