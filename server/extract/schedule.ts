/** Human-readable Elastic Jobs schedule text. Times are UTC (the job database stores UTC). */

export interface JobSchedule {
  intervalType: string | null;
  intervalCount: number | null;
  startTime: string | null;
  endTime: string | null;
}

const UNIT: Record<string, [string, string]> = {
  minutes: ['minute', 'minutes'],
  hours: ['hour', 'hours'],
  days: ['day', 'days'],
  weeks: ['week', 'weeks'],
  months: ['month', 'months'],
};

/** "2026-01-01T02:00:00.000Z" -> "2026-01-01 02:00 UTC" */
export function formatUtc(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** sp_add_job defaults: start 0001-01-01 ("as soon as enabled"), end 9999-12-31 11:59:59 ("never"). */
function isMinDate(iso: string | null): boolean {
  return !iso || iso.startsWith('0001-01-01');
}
function isMaxDate(iso: string | null): boolean {
  return !iso || iso.startsWith('9999-12-31');
}

export function scheduleText(enabled: boolean, s: JobSchedule): string {
  const base = describeSchedule(s);
  return enabled ? base : `Disabled (${base.charAt(0).toLowerCase()}${base.slice(1)})`;
}

function describeSchedule(s: JobSchedule): string {
  const type = (s.intervalType ?? 'Once').trim();
  const start = isMinDate(s.startTime) ? null : formatUtc(s.startTime);
  const end = isMaxDate(s.endTime) ? null : formatUtc(s.endTime);
  if (type.toLowerCase() === 'once') {
    return start ? `Once at ${start}` : 'Once, when started (no start time)';
  }
  const unit = UNIT[type.toLowerCase()];
  const count = s.intervalCount && s.intervalCount > 0 ? s.intervalCount : 1;
  let text = unit ? (count === 1 ? `Every ${unit[0]}` : `Every ${count} ${unit[1]}`) : `Every ${count} ${type}`;
  if (start) text += `, starting ${start}`;
  if (end) text += `, until ${end}`;
  return text;
}

const UNIT_MS: Record<string, number> = { minutes: 60_000, hours: 3_600_000, days: 86_400_000, weeks: 604_800_000 };

/** Next Elastic Jobs run after `now` (UTC ISO), or null when disabled / finished / unknown. */
export function nextElasticRun(enabled: boolean, s: JobSchedule, now = new Date()): string | null {
  if (!enabled) return null;
  const type = (s.intervalType ?? 'Once').trim().toLowerCase();
  const start = isMinDate(s.startTime) ? null : new Date(s.startTime as string);
  const end = isMaxDate(s.endTime) ? null : new Date(s.endTime as string);
  const t = now.getTime();
  const within = (d: Date): string | null => (end && d.getTime() > end.getTime() ? null : d.toISOString());
  if (type === 'once') return start && start.getTime() > t ? within(start) : null;
  if (!start) return null;
  if (start.getTime() > t) return within(start);
  const count = s.intervalCount && s.intervalCount > 0 ? s.intervalCount : 1;
  if (type === 'months') {
    const d = new Date(start);
    for (let i = 0; i < 100_000 && d.getTime() <= t; i++) d.setUTCMonth(d.getUTCMonth() + count);
    return d.getTime() > t ? within(d) : null;
  }
  const step = UNIT_MS[type];
  if (!step) return null;
  const k = Math.floor((t - start.getTime()) / (step * count)) + 1;
  return within(new Date(start.getTime() + k * step * count));
}
