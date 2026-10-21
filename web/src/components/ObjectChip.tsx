import { useMemo } from 'react';
import { Link } from 'react-router';
import { useObjects } from '../api/hooks';
import type { ObjectKind, ObjectSummaryView, WarningObjectRef } from '../api/types';
import { DATABASE_SCOPE_SCHEMA, KIND_META, jobPath, objectPath } from '../lib/kinds';
import { KindGlyph } from './ui';

/**
 * Object / job chips for refs that come from the server (refresh warnings, insights, AI insight findings):
 * linked to the object (modules: Dependencies tab) when it is in the cache, muted and unlinked otherwise.
 */

const MODULE_KINDS: ReadonlySet<ObjectKind> = new Set(['procedure', 'view', 'function', 'trigger']);

export function refLabel(o: { schema: string; name: string }): string {
  return o.schema === DATABASE_SCOPE_SCHEMA ? o.name : `${o.schema}.${o.name}`;
}

export interface ObjIndex {
  byRef: Map<string, ObjectSummaryView>;
  byName: Map<string, ObjectSummaryView[]>;
}

export const nameKey = (schema: string, name: string) => `${schema.toLowerCase()}.${name.toLowerCase()}`;

export function buildIndex(objects: ObjectSummaryView[]): ObjIndex {
  const byRef = new Map<string, ObjectSummaryView>();
  const byName = new Map<string, ObjectSummaryView[]>();
  for (const o of objects) {
    const k = nameKey(o.schema, o.name);
    byRef.set(`${o.kind}:${k}`, o);
    const list = byName.get(k);
    if (list) list.push(o);
    else byName.set(k, [o]);
  }
  return { byRef, byName };
}

/** Index of the cached objects of the connection; null while loading. */
export function useObjIndex(connId: string): ObjIndex | null {
  const objects = useObjects(connId);
  return useMemo(() => (objects.data ? buildIndex(objects.data) : null), [objects.data]);
}

/** The cached object a ref points at, its label and link (null when not in the cache). */
export function resolveRef(connId: string, obj: WarningObjectRef, index: ObjIndex | null): { label: string; to: string | null; title?: string } {
  const hit = index?.byRef.get(`${obj.kind}:${nameKey(obj.schema, obj.name)}`);
  const label = refLabel(hit ?? obj);
  if (!hit) return { label, to: null, title: index ? 'not in cache' : undefined };
  return {
    label,
    to: objectPath(connId, hit.kind, hit.schema, hit.name) + (MODULE_KINDS.has(hit.kind) ? '?tab=deps' : ''),
    title: `Open ${KIND_META[hit.kind].label.toLowerCase()} ${label}`,
  };
}

/** Links to the object (modules: Dependencies tab) when it is in the cache; otherwise a muted, unlinked chip. */
export function ObjectChip({ connId, obj, index, testId = 'warning-object' }: { connId: string; obj: WarningObjectRef; index: ObjIndex | null; testId?: string }) {
  const r = resolveRef(connId, obj, index);
  const body = (
    <>
      <KindGlyph kind={obj.kind} />
      <span className="mono">{r.label}</span>
    </>
  );
  if (r.to) {
    return (
      <Link to={r.to} className="chip warning-chip" title={r.title} data-testid={testId} data-linked="true">
        {body}
      </Link>
    );
  }
  return (
    <span className={`chip warning-chip${index ? ' missing' : ''}`} title={r.title} data-testid={testId} data-linked="false">
      {body}
    </span>
  );
}

export function JobChip({ connId, job, testId = 'warning-job' }: { connId: string; job: { jobId: string; name: string }; testId?: string }) {
  return (
    <Link to={jobPath(connId, job.jobId)} className="chip warning-chip" title={`Open job ${job.name}`} data-testid={testId}>
      <KindGlyph kind="job" />
      <span className="mono">{job.name}</span>
    </Link>
  );
}
