import { useEffect, useId, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { GraphNodeKind } from '../api/types';
import { errorMessage, isApiError } from '../api/client';
import { displayOps, KIND_META, OP_CLASS, opLabel } from '../lib/kinds';
import { Icon } from './Icon';

/* ------------------------------------------------------------------ badges */

export function KindBadge({ kind, label, compact }: { kind: GraphNodeKind; label?: string; compact?: boolean }) {
  const m = KIND_META[kind];
  return (
    <span className="kind-badge" data-kind={kind} title={m.label}>
      <span className="kind-glyph">{m.glyph}</span>
      {compact ? null : (label ?? m.label)}
    </span>
  );
}

export function KindGlyph({ kind }: { kind: GraphNodeKind }) {
  return (
    <span className="kind-glyph" data-kind={kind} title={KIND_META[kind].label}>
      {KIND_META[kind].glyph}
    </span>
  );
}

export function OpBadge({ op }: { op: string }) {
  const u = op.toUpperCase();
  return (
    <span className="op-badge" data-op={OP_CLASS[u] ?? 'ddl'} title={opLabel(u)}>
      {opLabel(u)}
    </span>
  );
}

export function OpBadges({ ops }: { ops: readonly string[] }) {
  if (!ops.length) return null;
  return (
    <span className="row-wrap" style={{ gap: 3 }}>
      {displayOps(ops).map((o) => (
        <OpBadge key={o} op={o} />
      ))}
    </span>
  );
}

export type Tone = 'ok' | 'warn' | 'danger' | 'info' | 'accent' | undefined;

export function Badge({ tone, children, title, square, outline }: { tone?: Tone; children: ReactNode; title?: string; square?: boolean; outline?: boolean }) {
  return (
    <span className={`badge${square ? ' square' : ''}${outline ? ' outline' : ''}`} data-tone={tone} title={title}>
      {children}
    </span>
  );
}

export function OriginBadge({ origin }: { origin: ReadonlyArray<'server' | 'static'> }) {
  const both = origin.includes('server') && origin.includes('static');
  const label = both ? 'server + static' : origin.includes('static') ? 'static' : 'server';
  const title = both
    ? 'Reported by SQL Server dependencies and found by static analysis'
    : origin.includes('static')
      ? 'Found by static analysis of the code only'
      : 'Reported by SQL Server dependency metadata only';
  return (
    <span className="origin-badge" title={title}>
      {label}
    </span>
  );
}

export function outcomeTone(outcome: string | null | undefined): Tone {
  const o = (outcome ?? '').toLowerCase();
  if (!o) return undefined;
  if (o.includes('fail') || o.includes('timedout') || o.includes('timed out')) return 'danger';
  if (o.includes('succeed')) return 'ok';
  if (o.includes('cancel') || o.includes('retry') || o.includes('skipped')) return 'warn';
  if (o.includes('progress') || o.includes('waiting') || o.includes('running') || o.includes('created')) return 'info';
  return undefined;
}

export function Outcome({ value }: { value: string | null | undefined }) {
  if (!value) return <span className="muted">—</span>;
  return (
    <span className="outcome" data-tone={outcomeTone(value)}>
      {value}
    </span>
  );
}

export function ObjName({ schema, name }: { schema?: string | null; name: string }) {
  return (
    <span className="obj-name">
      {schema ? <span className="schema">{schema}.</span> : null}
      {name}
    </span>
  );
}

/* ------------------------------------------------------------------ feedback */

export function Spinner({ large }: { large?: boolean }) {
  return <span className={`spinner${large ? ' lg' : ''}`} role="status" aria-label="Loading" />;
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="loading">
      <Spinner />
      <span>{label}</span>
    </div>
  );
}

export function Callout({ tone, title, children, icon, action }: { tone?: Tone; title?: ReactNode; children?: ReactNode; icon?: string; action?: ReactNode }) {
  const ic = icon ?? (tone === 'danger' || tone === 'warn' ? 'alert' : tone === 'ok' ? 'check' : 'info');
  return (
    <div className="callout" data-tone={tone} role={tone === 'danger' ? 'alert' : undefined}>
      <Icon name={ic} />
      <div className="grow">
        {title ? <div className="callout-title">{title}</div> : null}
        {children ? <div className={title ? 'text-2' : undefined}>{children}</div> : null}
      </div>
      {action}
    </div>
  );
}

export function ErrorBox({ error, title = 'Something went wrong', onRetry }: { error: unknown; title?: string; onRetry?: () => void }) {
  return (
    <Callout
      tone="danger"
      title={title}
      action={
        onRetry ? (
          <button className="btn btn-sm" onClick={onRetry}>
            Retry
          </button>
        ) : undefined
      }
    >
      {errorMessage(error)}
    </Callout>
  );
}

export function QueryError({ error, onRetry, what = 'data' }: { error: unknown; onRetry?: () => void; what?: string }) {
  if (isApiError(error, 404)) {
    return (
      <Empty icon="alert" title="Not found" body={errorMessage(error)} />
    );
  }
  return <ErrorBox error={error} title={`Could not load ${what}`} onRetry={onRetry} />;
}

export function Empty({ icon = 'info', title, body, action, compact }: { icon?: string; title: ReactNode; body?: ReactNode; action?: ReactNode; compact?: boolean }) {
  return (
    <div className={`empty${compact ? ' compact' : ''}`}>
      {compact ? null : (
        <div className="empty-icon">
          <Icon name={icon} size={20} />
        </div>
      )}
      <div className="empty-title" style={compact ? { fontSize: 'var(--fs-md)' } : undefined}>
        {title}
      </div>
      {body ? <div className="empty-body">{body}</div> : null}
      {action ? <div style={{ marginTop: 6 }}>{action}</div> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ dialog */

export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  wide,
  className,
  labelledBy,
  dismissable = true,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  className?: string;
  labelledBy?: string;
  dismissable?: boolean;
}) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && dismissable) {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey, true);
    const t = window.setTimeout(() => {
      const el = ref.current?.querySelector<HTMLElement>('[data-autofocus], input, select, textarea, button:not([data-dialog-close])');
      el?.focus();
    }, 0);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      window.clearTimeout(t);
      prev?.focus?.();
    };
  }, [open, onClose, dismissable]);
  if (!open) return null;
  return createPortal(
    <div
      className="dialog-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && dismissable) onClose();
      }}
    >
      <div ref={ref} className={`dialog${wide ? ' wide' : ''}${className ? ` ${className}` : ''}`} role="dialog" aria-modal="true" aria-labelledby={labelledBy ?? (title ? id : undefined)}>
        {title ? (
          <div className="dialog-header">
            <h2 id={id} className="grow">
              {title}
            </h2>
            {dismissable ? (
              <button className="icon-btn sm" onClick={onClose} aria-label="Close dialog" data-dialog-close>
                <Icon name="x" size={14} />
              </button>
            ) : null}
          </div>
        ) : null}
        {children}
        {footer ? <div className="dialog-footer">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}

/* ------------------------------------------------------------------ tabs */

export interface TabDef {
  id: string;
  label: ReactNode;
  count?: number | null;
  disabled?: boolean;
}

export function Tabs({ tabs, value, onChange }: { tabs: TabDef[]; value: string; onChange: (id: string) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          className="tab"
          aria-selected={t.id === value}
          disabled={t.disabled}
          onClick={() => onChange(t.id)}
          data-tab={t.id}
        >
          {t.label}
          {t.count !== undefined && t.count !== null ? <span className="count">{t.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ inputs */

export function SearchInput({ value, onChange, placeholder = 'Search…', width = 260, autoFocus }: { value: string; onChange: (v: string) => void; placeholder?: string; width?: number; autoFocus?: boolean }) {
  return (
    <div className="input-search" style={{ width }}>
      <Icon name="search" size={14} />
      <input
        className="input"
        style={{ width: '100%' }}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        autoFocus={autoFocus}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && value) {
            e.stopPropagation();
            onChange('');
          }
        }}
      />
    </div>
  );
}

export function Segmented<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: Array<{ value: T; label: ReactNode }>; label?: string }) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Inline two-step confirmation (no browser confirm()). */
export function ConfirmButton({ label, confirmLabel = 'Confirm', onConfirm, busy, className = 'btn btn-sm', icon }: { label: ReactNode; confirmLabel?: string; onConfirm: () => void; busy?: boolean; className?: string; icon?: string }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = window.setTimeout(() => setArmed(false), 6000);
    return () => window.clearTimeout(t);
  }, [armed]);
  if (!armed) {
    return (
      <button type="button" className={className} onClick={() => setArmed(true)} disabled={busy}>
        {icon ? <Icon name={icon} size={14} /> : null}
        {label}
      </button>
    );
  }
  return (
    <span className="row" style={{ gap: 4 }}>
      <button type="button" className="btn btn-sm btn-danger" onClick={onConfirm} disabled={busy}>
        {busy ? <Spinner /> : null}
        {confirmLabel}
      </button>
      <button type="button" className="btn btn-sm btn-ghost" onClick={() => setArmed(false)} disabled={busy}>
        Cancel
      </button>
    </span>
  );
}

/* ------------------------------------------------------------------ sortable table */

export interface Column<T> {
  id: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  sort?: (row: T) => string | number | null | undefined;
  className?: string;
  width?: number | string;
  title?: string;
}

export function DataTable<T>({
  rows,
  columns,
  rowKey,
  onRowClick,
  initialSort,
  empty,
  compact,
  maxHeight,
  testId,
}: {
  rows: T[];
  columns: Column<T>[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T, e: MouseEvent) => void;
  initialSort?: { id: string; dir: 'asc' | 'desc' };
  empty?: ReactNode;
  compact?: boolean;
  maxHeight?: number | string;
  testId?: string;
}) {
  const [sort, setSort] = useState(initialSort ?? null);
  const col = sort ? columns.find((c) => c.id === sort.id) : undefined;
  const sorted = col?.sort
    ? [...rows].sort((a, b) => {
        const va = col.sort!(a);
        const vb = col.sort!(b);
        let r: number;
        if (va === vb) r = 0;
        else if (va === null || va === undefined) r = 1;
        else if (vb === null || vb === undefined) r = -1;
        else if (typeof va === 'number' && typeof vb === 'number') r = va - vb;
        else r = String(va).localeCompare(String(vb), undefined, { numeric: true, sensitivity: 'base' });
        return sort!.dir === 'asc' ? r : -r;
      })
    : rows;
  return (
    <div className="table-wrap" style={maxHeight ? { maxHeight } : undefined} data-testid={testId}>
      <table className={`data${compact ? ' compact' : ''}`}>
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c.id}
                className={`${c.className ?? ''}${c.sort ? ' sortable' : ''}`}
                style={c.width ? { width: c.width } : undefined}
                title={c.title}
                onClick={
                  c.sort
                    ? () =>
                        setSort((s) => (s && s.id === c.id ? { id: c.id, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { id: c.id, dir: c.className?.includes('num') ? 'desc' : 'asc' }))
                    : undefined
                }
                aria-sort={sort?.id === c.id ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}
              >
                {c.header}
                {c.sort ? <span className="sort">{sort?.id === c.id ? (sort.dir === 'asc' ? '↑' : '↓') : ''}</span> : null}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <tr key={rowKey(r)} className={onRowClick ? 'clickable' : undefined} onClick={onRowClick ? (e) => onRowClick(r, e) : undefined}>
              {columns.map((c) => (
                <td key={c.id} className={c.className}>
                  {c.cell(r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {sorted.length === 0 ? empty ?? <Empty compact title="Nothing to show" /> : null}
    </div>
  );
}
