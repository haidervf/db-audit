const dateFmt = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
const dateOnlyFmt = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: '2-digit' });
const numFmt = new Intl.NumberFormat();

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : dateFmt.format(d);
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : dateOnlyFmt.format(d);
}

export function fmtNumber(n: number | null | undefined): string {
  return n === null || n === undefined ? '—' : numFmt.format(n);
}

export function fmtDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || Number.isNaN(seconds)) return '—';
  if (seconds === 0) return '< 1 s';
  if (seconds === 0) return '< 1 s';
  if (seconds < 1) return `${Math.round(seconds * 1000)} ms`;
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function durationBetween(start: string | null | undefined, end: string | null | undefined): number | null {
  if (!start || !end) return null;
  const a = new Date(start).getTime();
  const b = new Date(end).getTime();
  return Number.isNaN(a) || Number.isNaN(b) ? null : (b - a) / 1000;
}

export function fmtRelative(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'never';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const diff = (now - t) / 1000;
  const future = diff < 0;
  const a = Math.abs(diff);
  let s: string;
  if (a < 45) s = 'just now';
  else if (a < 3600) s = `${Math.round(a / 60)} min`;
  else if (a < 86400) s = `${Math.round(a / 3600)} h`;
  else s = `${Math.round(a / 86400)} d`;
  if (s === 'just now') return s;
  return future ? `in ${s}` : `${s} ago`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${numFmt.format(n)} ${n === 1 ? one : many}`;
}
