/**
 * Decoders for SQL Server Agent's integer-encoded msdb columns.
 * Agent stores dates as yyyymmdd ints and times as hhmmss ints in SERVER-LOCAL time; callers pass the
 * server's current UTC offset (minutes) to get UTC ISO strings. DST transitions are not modelled.
 */

export interface AgentScheduleFields {
  freq_type: number;
  freq_interval: number;
  freq_subday_type: number;
  freq_subday_interval: number;
  freq_relative_interval: number;
  freq_recurrence_factor: number;
  active_start_date: number;
  active_end_date: number;
  active_start_time: number;
  active_end_time: number;
}

const pad = (n: number, w = 2): string => String(n).padStart(w, '0');

/** 23000 -> "02:30:00" */
export function agentTime(hhmmss: number): string {
  const t = Math.max(0, Math.trunc(hhmmss || 0));
  return `${pad(Math.floor(t / 10000))}:${pad(Math.floor(t / 100) % 100)}:${pad(t % 100)}`;
}

/** 20261101 -> "2026-11-01" */
export function agentDate(yyyymmdd: number): string {
  const d = Math.trunc(yyyymmdd || 0);
  return `${Math.floor(d / 10000)}-${pad(Math.floor(d / 100) % 100)}-${pad(d % 100)}`;
}

/** (20261014, 25549, offset) -> UTC ISO; null for 0 / missing dates. */
export function agentDateTimeToIso(yyyymmdd: number | null | undefined, hhmmss: number | null | undefined, utcOffsetMinutes: number): string | null {
  const d = Math.trunc(Number(yyyymmdd ?? 0));
  if (!d || d < 19000101) return null;
  const t = Math.max(0, Math.trunc(Number(hhmmss ?? 0)));
  const ms = Date.UTC(Math.floor(d / 10000), (Math.floor(d / 100) % 100) - 1, d % 100, Math.floor(t / 10000), Math.floor(t / 100) % 100, t % 100);
  return new Date(ms - utcOffsetMinutes * 60_000).toISOString();
}

export interface AgentScheduleNextRunInput {
  scheduleId: number | null;
  enabled: boolean;
  /** sysjobschedules.next_run_date / next_run_time (sp_help_jobschedule returns the same columns) */
  nextRunDate: number | null;
  nextRunTime: number | null;
}

/**
 * Next run per schedule (UTC ISO or null), in input order.
 * sysjobschedules.next_run_date/time is only written by Agent from time to time and stays 0 until then
 * (e.g. right after the job was created), while the job-level next run (sysjobactivity.next_scheduled_run_date,
 * or sp_help_job's next_run_*) is live. So the job-level value is given to the schedule it belongs to:
 * the one sp_help_job names (next_run_schedule_id), else the job's only enabled schedule. Other schedules
 * keep their stored value (null when 0). Disabled jobs or jobs without a next run: stored values only.
 */
export function agentScheduleNextRuns(
  schedules: readonly AgentScheduleNextRunInput[],
  job: { enabled: boolean; nextRun: string | null; nextRunScheduleId: number | null },
  utcOffsetMinutes: number,
): Array<string | null> {
  const stored = schedules.map((s) => agentDateTimeToIso(s.nextRunDate, s.nextRunTime, utcOffsetMinutes));
  if (!job.enabled || !job.nextRun) return stored;
  const enabled = schedules.filter((s) => s.enabled);
  const owner = (job.nextRunScheduleId ? enabled.find((s) => s.scheduleId === job.nextRunScheduleId) : undefined) ?? (enabled.length === 1 ? enabled[0] : undefined);
  return schedules.map((s, i) => (s === owner ? job.nextRun : stored[i]));
}

/** A server-local DATETIME that mssql read as if it were UTC -> real UTC ISO. */
export function localDateToIso(v: unknown, utcOffsetMinutes: number): string | null {
  if (!(v instanceof Date)) return null;
  return new Date(v.getTime() - utcOffsetMinutes * 60_000).toISOString();
}

/** run_duration is HHMMSS packed into an int (hours can exceed 99): 10203 -> 3723 s. */
export function agentDurationSeconds(hhmmss: number | null | undefined): number | null {
  if (hhmmss === null || hhmmss === undefined) return null;
  const t = Math.max(0, Math.trunc(Number(hhmmss)));
  return Math.floor(t / 10000) * 3600 + (Math.floor(t / 100) % 100) * 60 + (t % 100);
}

export const RUN_STATUS: Record<number, { label: string; lifecycle: string }> = {
  0: { label: 'Failed', lifecycle: 'Failed' },
  1: { label: 'Succeeded', lifecycle: 'Succeeded' },
  2: { label: 'Retry', lifecycle: 'Retry' },
  3: { label: 'Canceled', lifecycle: 'Canceled' },
  4: { label: 'In progress', lifecycle: 'InProgress' },
};

/** sysjobservers / sp_help_job last_run_outcome */
export function lastRunOutcomeLabel(outcome: number | null | undefined, lastRunDate: number | null | undefined): string | null {
  if (!lastRunDate) return null; // never run
  switch (Number(outcome)) {
    case 0:
      return 'Failed';
    case 1:
      return 'Succeeded';
    case 3:
      return 'Canceled';
    case 4:
      return 'In progress';
    case 5:
      return 'Unknown';
    default:
      return null;
  }
}

/** on_success_action / on_fail_action -> "Go to next step", "Go to step 3", ... */
export function stepActionText(action: number | null | undefined, stepId: number | null | undefined): string | null {
  switch (Number(action)) {
    case 1:
      return 'Quit reporting success';
    case 2:
      return 'Quit reporting failure';
    case 3:
      return 'Go to next step';
    case 4:
      return `Go to step ${stepId}`;
    default:
      return null;
  }
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const RELATIVE: Record<number, string> = { 1: 'first', 2: 'second', 4: 'third', 8: 'fourth', 16: 'last' };
const RELATIVE_DAY: Record<number, string> = {
  1: 'Sunday',
  2: 'Monday',
  3: 'Tuesday',
  4: 'Wednesday',
  5: 'Thursday',
  6: 'Friday',
  7: 'Saturday',
  8: 'day',
  9: 'weekday',
  10: 'weekend day',
};

function subday(s: AgentScheduleFields): string {
  const start = agentTime(s.active_start_time);
  const end = agentTime(s.active_end_time);
  const unit = s.freq_subday_type === 2 ? 'second' : s.freq_subday_type === 4 ? 'minute' : s.freq_subday_type === 8 ? 'hour' : null;
  if (!unit) return ` at ${start}`;
  const n = s.freq_subday_interval || 1;
  return `, every ${n} ${unit}${n === 1 ? '' : 's'} between ${start} and ${end}`;
}

/**
 * Human text for an Agent schedule, e.g.
 *   "Every day, every 15 minutes between 00:00:00 and 23:59:59"
 *   "Weekly on Mon, Wed every 1 week(s) at 02:00:00"
 *   "Monthly on day 1 every 1 month(s) at 01:00:00"
 */
export function agentScheduleText(s: AgentScheduleFields): string {
  let text: string;
  switch (s.freq_type) {
    case 1:
      text = `Once on ${agentDate(s.active_start_date)} at ${agentTime(s.active_start_time)}`;
      break;
    case 4: {
      const n = s.freq_interval || 1;
      text = (n === 1 ? 'Every day' : `Every ${n} days`) + subday(s);
      break;
    }
    case 8: {
      const days = DAYS.filter((_, i) => (s.freq_interval & (1 << i)) !== 0);
      text = `Weekly on ${days.join(', ') || '(no days)'} every ${s.freq_recurrence_factor || 1} week(s)` + subday(s);
      break;
    }
    case 16:
      text = `Monthly on day ${s.freq_interval} every ${s.freq_recurrence_factor || 1} month(s)` + subday(s);
      break;
    case 32:
      text =
        `Monthly on the ${RELATIVE[s.freq_relative_interval] ?? `#${s.freq_relative_interval}`} ${RELATIVE_DAY[s.freq_interval] ?? `day ${s.freq_interval}`}` +
        ` every ${s.freq_recurrence_factor || 1} month(s)` +
        subday(s);
      break;
    case 64:
      return 'When SQL Server Agent starts';
    case 128:
      return 'When the computer is idle';
    default:
      return `Unknown schedule (freq_type ${s.freq_type})`;
  }
  if (s.active_end_date && s.active_end_date !== 99991231 && s.freq_type !== 1) text += `, until ${agentDate(s.active_end_date)}`;
  return text;
}
