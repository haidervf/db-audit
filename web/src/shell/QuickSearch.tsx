import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { useJobs, useObjects } from '../api/hooks';
import type { GraphNodeKind } from '../api/types';
import { Icon } from '../components/Icon';
import { Dialog, KindGlyph, Spinner } from '../components/ui';
import { fuzzyScore } from '../lib/fuzzy';
import { DATABASE_SCOPE_SCHEMA, jobPath, objectPath } from '../lib/kinds';

interface Item {
  id: string;
  kind: GraphNodeKind | 'page';
  text: string;
  sub?: string;
  route: string;
}

const PAGES: Array<{ seg: string; label: string }> = [
  { seg: 'overview', label: 'Overview' },
  { seg: 'procedures', label: 'Procedures' },
  { seg: 'tables', label: 'Tables' },
  { seg: 'views', label: 'Views' },
  { seg: 'functions', label: 'Functions' },
  { seg: 'triggers', label: 'Triggers' },
  { seg: 'jobs', label: 'Jobs' },
  { seg: 'graph', label: 'Graph' },
];

function Highlighted({ text, positions }: { text: string; positions: number[] }) {
  if (!positions.length) return <>{text}</>;
  const set = new Set(positions);
  const out: ReactNode[] = [];
  let buf = '';
  let inMark = false;
  const flush = (k: number) => {
    if (!buf) return;
    out.push(inMark ? <mark key={k}>{buf}</mark> : <span key={k}>{buf}</span>);
    buf = '';
  };
  for (let i = 0; i < text.length; i++) {
    const m = set.has(i);
    if (m !== inMark) {
      flush(i);
      inMark = m;
    }
    buf += text[i];
  }
  flush(text.length);
  return <>{out}</>;
}

/** ⌘K / "/" palette: fuzzy search over the current connection's objects and jobs (plus pages). */
export function QuickSearch({ connId, onClose }: { connId: string; onClose: () => void }) {
  const objects = useObjects(connId);
  const jobs = useJobs(connId);
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    for (const o of objects.data ?? []) {
      out.push({
        id: `${o.kind}:${o.schema}.${o.name}`,
        kind: o.kind,
        text: o.schema === DATABASE_SCOPE_SCHEMA ? o.name : `${o.schema}.${o.name}`,
        route: objectPath(connId, o.kind, o.schema, o.name),
      });
    }
    for (const j of jobs.data ?? []) {
      out.push({ id: `job:${j.jobId}`, kind: 'job', text: j.name, sub: j.source === 'agent' ? 'SQL Agent' : 'Elastic', route: jobPath(connId, j.jobId) });
    }
    for (const p of PAGES) out.push({ id: `page:${p.seg}`, kind: 'page', text: p.label, sub: 'page', route: `/c/${encodeURIComponent(connId)}/${p.seg}` });
    return out;
  }, [objects.data, jobs.data, connId]);

  const results = useMemo(() => {
    if (!q.trim()) {
      return items.filter((i) => i.kind === 'page').map((i) => ({ item: i, positions: [] as number[] }));
    }
    const scored: Array<{ item: Item; positions: number[]; score: number }> = [];
    for (const it of items) {
      const s = fuzzyScore(q, it.text);
      if (s) scored.push({ item: it, positions: s.positions, score: s.score - (it.kind === 'page' ? 8 : 0) });
    }
    scored.sort((a, b) => b.score - a.score || a.item.text.localeCompare(b.item.text));
    return scored.slice(0, 60);
  }, [q, items]);

  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const go = (it: Item) => {
    onClose();
    navigate(it.route);
  };

  const loading = objects.isLoading || jobs.isLoading;

  return (
    <Dialog open onClose={onClose} className="qs" labelledBy="qs-label">
      <div className="qs-input">
        <Icon name="search" />
        <label id="qs-label" className="sr-only" htmlFor="qs-input">
          Search objects and jobs
        </label>
        <input
          id="qs-input"
          data-autofocus
          autoComplete="off"
          spellCheck={false}
          placeholder="Search procedures, tables, views, jobs…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          data-testid="quick-search-input"
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((a) => Math.min(results.length - 1, a + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((a) => Math.max(0, a - 1));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              const r = results[active];
              if (r) go(r.item);
            }
          }}
        />
        {loading ? <Spinner /> : null}
      </div>
      <div className="qs-results" ref={listRef} role="listbox" aria-label="Results">
        {results.length === 0 ? (
          <div className="empty compact">
            <div className="empty-title" style={{ fontSize: 'var(--fs-md)' }}>
              {loading ? 'Loading…' : `No matches for “${q}”`}
            </div>
          </div>
        ) : (
          results.map((r, i) => (
            <div
              key={r.item.id}
              className="qs-item"
              role="option"
              aria-selected={i === active}
              data-active={i === active}
              data-index={i}
              onMouseMove={() => setActive(i)}
              onClick={() => go(r.item)}
              data-testid="quick-search-item"
            >
              {r.item.kind === 'page' ? (
                <span className="kind-glyph" style={{ background: 'var(--text-3)' }}>
                  →
                </span>
              ) : (
                <KindGlyph kind={r.item.kind} />
              )}
              <span className={`grow truncate${r.item.kind === 'page' ? '' : ' mono'}`} style={{ fontSize: r.item.kind === 'page' ? undefined : 12.5 }}>
                <Highlighted text={r.item.text} positions={r.positions} />
              </span>
              <span className="xsmall muted">{r.item.sub ?? (r.item.kind === 'page' ? 'page' : r.item.kind)}</span>
            </div>
          ))
        )}
      </div>
      <div className="qs-footer">
        <span>
          <span className="kbd">↑</span> <span className="kbd">↓</span> navigate
        </span>
        <span>
          <span className="kbd">Enter</span> open
        </span>
        <span>
          <span className="kbd">Esc</span> close
        </span>
        <span className="spacer" />
        <span>{items.length - PAGES.length} objects &amp; jobs</span>
      </div>
    </Dialog>
  );
}
