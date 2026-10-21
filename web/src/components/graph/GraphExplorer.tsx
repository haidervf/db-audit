import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useGraph } from '../../api/hooks';
import type { Graph, GraphEdge, GraphNode, GraphNodeKind } from '../../api/types';
import { KIND_META, RELATION_LABEL, RELATIONS, nodeRoute } from '../../lib/kinds';
import type { Direction } from '../../lib/layout';
import { fmtNumber } from '../../lib/format';
import { Icon } from '../Icon';
import { Empty, KindBadge, Loading, OpBadges, OriginBadge, QueryError } from '../ui';
import { GraphCanvas, edgeStyle } from './GraphCanvas';

export const LARGE_GRAPH = 300;

export function Legend({ kinds, relations }: { kinds: GraphNodeKind[]; relations: Array<GraphEdge['relation']> }) {
  return (
    <div className="legend" data-testid="graph-legend">
      {kinds.map((k) => (
        <span key={k} className="legend-item" data-kind={k}>
          <span className="kind-glyph" style={k === 'external' || k === 'unknown' ? { outline: '1px dashed var(--kc)', outlineOffset: 1 } : undefined}>
            {KIND_META[k].glyph}
          </span>
          {KIND_META[k].label}
        </span>
      ))}
      {relations.map((r) => {
        const st = edgeStyle(r);
        return (
          <span key={r} className="legend-item">
            <svg className="legend-line" width="22" height="6" aria-hidden>
              <line x1="0" y1="3" x2="22" y2="3" stroke={st.color} strokeWidth={Math.max(2, st.width + 0.4)} strokeDasharray={st.dash} />
            </svg>
            {RELATION_LABEL[r]}
          </span>
        );
      })}
    </div>
  );
}

function metaRows(n: GraphNode): Array<[string, ReactNode]> {
  const m = (n.meta ?? {}) as Record<string, unknown>;
  const rows: Array<[string, ReactNode]> = [];
  if (n.kind === 'table' && m.rowCount !== undefined && m.rowCount !== null) rows.push(['Rows', fmtNumber(Number(m.rowCount))]);
  if (n.kind === 'job') {
    if (m.source) rows.push(['Source', String(m.source) === 'agent' ? 'SQL Agent' : 'Elastic Jobs']);
    if (m.enabled !== undefined) rows.push(['Enabled', m.enabled ? 'yes' : 'no']);
    if (m.scheduleText) rows.push(['Schedule', String(m.scheduleText)]);
  }
  if (n.kind === 'jobstep') {
    if (m.subsystem) rows.push(['Subsystem', String(m.subsystem)]);
    if (m.databaseName) rows.push(['Database', <span className="mono">{String(m.databaseName)}</span>]);
  }
  if (n.kind === 'external') {
    if (m.database) rows.push(['Database', <span className="mono">{String(m.database)}</span>]);
    if (m.server) rows.push(['Server', <span className="mono">{String(m.server)}</span>]);
  }
  if (m.isEncrypted) rows.push(['Encrypted', 'yes']);
  if (m.cached === false) rows.push(['Cache', 'referenced only (not in the cache)']);
  if (n.kind === 'unknown') rows.push(['Status', 'not found in this database (missing, temp or alias)']);
  return rows;
}

export function NodePanel({
  connId,
  graph,
  node,
  onSelect,
  onFocus,
  onClose,
}: {
  connId: string;
  graph: Graph;
  node: GraphNode;
  onSelect: (id: string) => void;
  onFocus: (id: string) => void;
  onClose: () => void;
}) {
  const byId = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph.nodes]);
  const out = graph.edges.filter((e) => e.source === node.id);
  const inc = graph.edges.filter((e) => e.target === node.id);
  const route = nodeRoute(connId, node.id, node);
  const rows = metaRows(node);
  const edgeList = (list: GraphEdge[], dir: 'out' | 'in') =>
    list.length === 0 ? (
      <div className="muted small" style={{ padding: '4px 12px 8px' }}>
        none
      </div>
    ) : (
      <ul className="list-plain">
        {list.map((e) => {
          const other = byId.get(dir === 'out' ? e.target : e.source);
          if (!other) return null;
          return (
            <li key={e.id} style={{ flexWrap: 'wrap', gap: 6 }}>
              <span className="xsmall" style={{ color: edgeStyle(e.relation).color, fontWeight: 650, minWidth: 64 }}>
                {RELATION_LABEL[e.relation].toLowerCase()}
              </span>
              <button className="line-link" style={{ fontSize: 12, color: 'var(--text)' }} onClick={() => onSelect(other.id)} title={other.label}>
                <span className="kind-glyph" data-kind={other.kind} style={{ marginRight: 5 }}>
                  {KIND_META[other.kind].glyph}
                </span>
                {other.label.length > 34 ? `${other.label.slice(0, 33)}…` : other.label}
              </button>
              <span className="spacer" />
              {e.relation !== 'fk' && e.ops?.length ? <OpBadges ops={e.ops} /> : null}
              <OriginBadge origin={e.origin} />
            </li>
          );
        })}
      </ul>
    );
  return (
    <aside className="graph-side" data-testid="graph-side-panel">
      <div className="graph-side-head">
        <div className="grow" style={{ minWidth: 0 }}>
          <KindBadge kind={node.kind} />
          <div className="mono" style={{ fontWeight: 600, marginTop: 6, overflowWrap: 'anywhere' }}>
            {node.label}
          </div>
        </div>
        <button className="icon-btn sm" onClick={onClose} aria-label="Close panel">
          <Icon name="x" size={14} />
        </button>
      </div>
      <div className="row" style={{ padding: '10px 12px', gap: 6 }}>
        {route ? (
          <Link className="btn btn-sm btn-primary" to={route}>
            Open details
          </Link>
        ) : null}
        <button className="btn btn-sm" onClick={() => onFocus(node.id)}>
          <Icon name="focus" size={13} /> Focus here
        </button>
      </div>
      {rows.length ? (
        <dl className="kv" style={{ padding: '0 12px 10px' }}>
          {rows.map(([k, v]) => (
            <FragmentRow key={k} k={k} v={v} />
          ))}
        </dl>
      ) : null}
      <div className="nav-section" style={{ padding: '8px 12px 2px' }}>
        Outgoing ({out.length})
      </div>
      {edgeList(out, 'out')}
      <div className="nav-section" style={{ padding: '8px 12px 2px' }}>
        Incoming ({inc.length})
      </div>
      {edgeList(inc, 'in')}
    </aside>
  );
}

function FragmentRow({ k, v }: { k: string; v: ReactNode }) {
  return (
    <>
      <dt>{k}</dt>
      <dd>{v}</dd>
    </>
  );
}

/** Applies the client-side relation filter; drops nodes left without edges (except the focus node). */
export function filterGraph(g: Graph, relations: ReadonlySet<GraphEdge['relation']>, focus: string | null): Graph {
  if (relations.size === RELATIONS.length) return g;
  const edges = g.edges.filter((e) => relations.has(e.relation));
  const used = new Set<string>();
  for (const e of edges) {
    used.add(e.source);
    used.add(e.target);
  }
  const hadEdge = new Set<string>();
  for (const e of g.edges) {
    hadEdge.add(e.source);
    hadEdge.add(e.target);
  }
  const nodes = g.nodes.filter((n) => used.has(n.id) || n.id === focus || !hadEdge.has(n.id));
  return { nodes, edges, truncated: g.truncated };
}

export function GraphExplorer({
  connId,
  focus,
  depth,
  kinds,
  relations,
  direction,
  onFocus,
  embed,
  emptyHint,
}: {
  connId: string;
  focus: string | null;
  depth: number;
  kinds: GraphNodeKind[];
  relations: ReadonlySet<GraphEdge['relation']>;
  direction: Direction;
  onFocus: (id: string) => void;
  embed?: boolean;
  emptyHint?: ReactNode;
}) {
  const q = useGraph(connId, focus, depth, kinds.length === Object.keys(KIND_META).length ? [] : kinds);
  const [selected, setSelected] = useState<string | null>(null);
  const [forceLarge, setForceLarge] = useState<string | null>(null);
  const graph = useMemo(() => (q.data ? filterGraph(q.data, relations, focus) : null), [q.data, relations, focus]);
  const sizeKey = graph ? `${focus}|${depth}|${kinds.join()}|${[...relations].join()}` : '';
  const selectedNode = graph && selected ? graph.nodes.find((n) => n.id === selected) ?? null : null;

  const shownKinds = useMemo(() => {
    const s = new Set<GraphNodeKind>();
    for (const n of graph?.nodes ?? []) s.add(n.kind);
    return (Object.keys(KIND_META) as GraphNodeKind[]).filter((k) => s.has(k));
  }, [graph]);
  const shownRelations = useMemo(() => {
    const s = new Set<GraphEdge['relation']>();
    for (const e of graph?.edges ?? []) s.add(e.relation);
    return RELATIONS.filter((r) => s.has(r));
  }, [graph]);

  let body: ReactNode;
  if (q.isLoading) body = <Loading label="Loading graph…" />;
  else if (q.error) body = <div style={{ padding: 16 }}><QueryError error={q.error} onRetry={() => q.refetch()} what="the graph" /></div>;
  else if (!graph || graph.nodes.length === 0) body = <Empty icon="graph" title="Nothing to draw" body={emptyHint ?? 'No objects match the current filters. Run a refresh or relax the filters.'} />;
  else if (graph.nodes.length > LARGE_GRAPH && forceLarge !== sizeKey)
    body = (
      <Empty
        icon="graph"
        title={`This graph has ${fmtNumber(graph.nodes.length)} nodes`}
        body="Large graphs are slow to lay out and hard to read. Focus on an object, lower the depth, or filter kinds and relations first."
        action={
          <button className="btn" onClick={() => setForceLarge(sizeKey)}>
            Draw anyway
          </button>
        }
      />
    );
  else
    body = (
      <>
        <div style={{ position: 'relative', minHeight: 0, height: '100%' }}>
          <GraphCanvas graph={graph} direction={direction} focusId={focus} selectedId={selected} onSelect={setSelected} minimap={!embed || graph.nodes.length > 12} />
          <Legend kinds={shownKinds} relations={shownRelations} />
          {graph.truncated ? (
            <div className="callout" data-tone="warn" style={{ position: 'absolute', right: 12, top: 12, zIndex: 4, maxWidth: 320 }}>
              The graph was truncated by the server node cap. Focus or filter to see everything.
            </div>
          ) : null}
        </div>
        {selectedNode ? (
          <NodePanel
            connId={connId}
            graph={graph}
            node={selectedNode}
            onSelect={setSelected}
            onFocus={(id) => {
              setSelected(id);
              onFocus(id);
            }}
            onClose={() => setSelected(null)}
          />
        ) : null}
      </>
    );

  return (
    <div className={embed ? 'graph-embed' : 'graph-body'} data-testid="graph-explorer">
      {body}
    </div>
  );
}
