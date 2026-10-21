import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { useJobs, useObjects } from '../api/hooks';
import type { GraphEdge, GraphNodeKind } from '../api/types';
import { GraphExplorer } from '../components/graph/GraphExplorer';
import { edgeStyle } from '../components/graph/GraphCanvas';
import { Icon } from '../components/Icon';
import { KindGlyph, Segmented } from '../components/ui';
import { fuzzyScore } from '../lib/fuzzy';
import { ALL_GRAPH_KINDS, DATABASE_SCOPE_SCHEMA, KIND_META, RELATION_LABEL, RELATIONS, parseNodeId } from '../lib/kinds';
import type { Direction } from '../lib/layout';

function parseList<T extends string>(v: string | null, all: readonly T[]): T[] {
  if (!v) return [...all];
  const set = new Set(v.split(',').filter(Boolean));
  return all.filter((x) => set.has(x));
}

interface Candidate {
  id: string;
  kind: GraphNodeKind;
  label: string;
}

function FocusSearch({ connId, onPick }: { connId: string; onPick: (id: string) => void }) {
  const objects = useObjects(connId);
  const jobs = useJobs(connId);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const candidates = useMemo<Candidate[]>(() => {
    const out: Candidate[] = [];
    for (const o of objects.data ?? []) out.push({ id: `${o.kind}:${o.schema}.${o.name}`, kind: o.kind, label: o.schema === DATABASE_SCOPE_SCHEMA ? o.name : `${o.schema}.${o.name}` });
    for (const j of jobs.data ?? []) out.push({ id: `job:${j.jobId}`, kind: 'job', label: j.name });
    return out;
  }, [objects.data, jobs.data]);
  const results = useMemo(() => {
    if (!q.trim()) return [];
    return candidates
      .map((c) => ({ c, s: fuzzyScore(q, c.label) }))
      .filter((x) => x.s)
      .sort((a, b) => b.s!.score - a.s!.score)
      .slice(0, 12)
      .map((x) => x.c);
  }, [q, candidates]);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);
  const pick = (c: Candidate) => {
    setQ('');
    setOpen(false);
    onPick(c.id);
  };
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <div className="input-search" style={{ width: 260 }}>
        <Icon name="search" size={14} />
        <input
          className="input"
          style={{ width: '100%' }}
          placeholder="Focus on an object or job…"
          aria-label="Focus on an object or job"
          value={q}
          data-testid="graph-focus-search"
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
            setActive(0);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((a) => Math.min(results.length - 1, a + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((a) => Math.max(0, a - 1));
            } else if (e.key === 'Enter' && results[active]) {
              e.preventDefault();
              pick(results[active]);
            } else if (e.key === 'Escape') setOpen(false);
          }}
        />
      </div>
      {open && results.length ? (
        <div className="menu" style={{ top: 'calc(100% + 4px)', left: 0, width: 360, maxHeight: 340, overflowY: 'auto' }} role="listbox">
          {results.map((c, i) => (
            <button key={c.id} className="menu-item" data-active={i === active} onMouseEnter={() => setActive(i)} onClick={() => pick(c)} role="option" aria-selected={i === active}>
              <KindGlyph kind={c.kind} />
              <span className={`truncate${c.kind === 'job' ? '' : ' mono'}`} style={{ fontSize: c.kind === 'job' ? undefined : 12.5 }}>
                {c.label}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function GraphPage() {
  const { connId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const focus = params.get('focus');
  const depth = Math.min(4, Math.max(1, Number(params.get('depth') ?? 2) || 2));
  const kinds = parseList<GraphNodeKind>(params.get('kinds'), ALL_GRAPH_KINDS);
  const relations = useMemo(() => new Set(parseList<GraphEdge['relation']>(params.get('rel'), RELATIONS)), [params]);
  const direction: Direction = params.get('dir') === 'TB' ? 'TB' : 'LR';
  const objects = useObjects(connId);
  const jobs = useJobs(connId);

  const update = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === '') next.delete(k);
      else next.set(k, v);
    }
    setParams(next, { replace: false });
  };

  const toggleKind = (k: GraphNodeKind) => {
    const set = new Set(kinds);
    if (set.has(k)) set.delete(k);
    else set.add(k);
    const list = ALL_GRAPH_KINDS.filter((x) => set.has(x));
    update({ kinds: list.length === ALL_GRAPH_KINDS.length ? null : list.join(',') || 'procedure' });
  };
  const toggleRel = (r: GraphEdge['relation']) => {
    const set = new Set(relations);
    if (set.has(r)) set.delete(r);
    else set.add(r);
    const list = RELATIONS.filter((x) => set.has(x));
    update({ rel: list.length === RELATIONS.length ? null : list.join(',') || 'calls' });
  };

  const focusLabel = useMemo(() => {
    if (!focus) return null;
    const p = parseNodeId(focus);
    if (p?.kind === 'job') return jobs.data?.find((j) => j.jobId.toLowerCase() === (p.jobId ?? '').toLowerCase())?.name ?? focus;
    if (p?.kind === 'jobstep') {
      const j = jobs.data?.find((x) => x.jobId.toLowerCase() === (p.jobId ?? '').toLowerCase());
      return j ? `${j.name} · step ${p.stepId}` : focus;
    }
    return focus.slice(focus.indexOf(':') + 1);
  }, [focus, jobs.data]);
  const focusKind = focus ? parseNodeId(focus)?.kind ?? 'unknown' : null;

  return (
    <div className="page-full" data-testid="graph-page">
      <div className="graph-page">
        <div className="graph-toolbar">
          <FocusSearch connId={connId} onPick={(id) => update({ focus: id, depth: String(depth) })} />
          {focus ? (
            <span className="chip" style={{ cursor: 'default' }} data-testid="graph-focus-chip">
              <Icon name="focus" size={13} />
              <KindGlyph kind={focusKind ?? 'unknown'} />
              <span className="mono">{focusLabel}</span>
              <button className="icon-btn sm" style={{ width: 18, height: 18 }} onClick={() => update({ focus: null })} aria-label="Show whole database">
                <Icon name="x" size={12} />
              </button>
            </span>
          ) : (
            <span className="small muted">Whole database{objects.data ? ` · ${objects.data.length + (jobs.data?.length ?? 0)} objects & jobs` : ''}</span>
          )}
          {focus ? (
            <>
              <span className="small muted">Depth</span>
              <Segmented label="Depth" value={String(depth)} onChange={(v) => update({ depth: v })} options={[1, 2, 3, 4].map((d) => ({ value: String(d), label: String(d) }))} />
            </>
          ) : null}
          <span className="spacer" />
          <Segmented<Direction>
            label="Layout direction"
            value={direction}
            onChange={(v) => update({ dir: v === 'LR' ? null : v })}
            options={[
              { value: 'LR', label: 'LR' },
              { value: 'TB', label: 'TB' },
            ]}
          />
          <div style={{ flexBasis: '100%', height: 0 }} />
          <div className="filter-group" aria-label="Kinds">
            <span className="xsmall muted" style={{ marginRight: 2 }}>
              Kinds
            </span>
            {ALL_GRAPH_KINDS.map((k) => (
              <button key={k} type="button" className="filter-chip" aria-pressed={kinds.includes(k)} onClick={() => toggleKind(k)} data-kind={k} data-testid={`kind-filter-${k}`}>
                <span className="swatch" style={{ background: 'var(--kc)' }} />
                {KIND_META[k].plural}
              </button>
            ))}
          </div>
          <div className="filter-group" aria-label="Relations" style={{ marginLeft: 8 }}>
            <span className="xsmall muted" style={{ marginRight: 2 }}>
              Relations
            </span>
            {RELATIONS.map((r) => (
              <button key={r} type="button" className="filter-chip" aria-pressed={relations.has(r)} onClick={() => toggleRel(r)} data-testid={`rel-filter-${r}`}>
                <span className="swatch" style={{ background: edgeStyle(r).color }} />
                {RELATION_LABEL[r]}
              </button>
            ))}
          </div>
        </div>
        <GraphExplorer
          connId={connId}
          focus={focus}
          depth={depth}
          kinds={kinds}
          relations={relations}
          direction={direction}
          onFocus={(id) => update({ focus: id })}
        />
      </div>
    </div>
  );
}
