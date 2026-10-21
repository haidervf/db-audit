import { memo, useEffect, useMemo, useRef, useState } from 'react';
import {
  BaseEdge,
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/base.css';
import type { Graph, GraphEdge, GraphNode, GraphNodeKind } from '../../api/types';
import { displayOps, KIND_META } from '../../lib/kinds';
import { layoutGraph, type Direction, type Point } from '../../lib/layout';
import { Spinner } from '../ui';

export const NODE_H = 44;

export function nodeWidth(n: GraphNode): number {
  const text = n.kind === 'jobstep' ? n.name : (n.name ?? n.label);
  return Math.max(150, Math.min(300, 54 + text.length * 7.4));
}

type GNodeData = {
  kind: GraphNodeKind;
  schema?: string;
  name: string;
  title: string;
  dim: boolean;
  focus: boolean;
  direction: Direction;
};

type GEdgeData = {
  points: Point[] | null;
  relation: GraphEdge['relation'];
  label?: string;
  dim: boolean;
};

const GNode = memo(function GNode({ data }: NodeProps<Node<GNodeData>>) {
  const horizontal = data.direction === 'LR';
  return (
    <>
      <Handle type="target" position={horizontal ? Position.Left : Position.Top} isConnectable={false} />
      <div
        className={`gnode${data.dim ? ' dim' : ''}${data.focus ? ' focus' : ''}${data.kind === 'external' || data.kind === 'unknown' ? ' dashed' : ''}`}
        data-kind={data.kind}
        title={data.title}
        data-testid="graph-node"
      >
        <span className="kind-glyph">{KIND_META[data.kind].glyph}</span>
        <span className="gnode-text">
          <span className="gnode-schema">{data.schema ? data.schema : KIND_META[data.kind].label.toLowerCase()}</span>
          <span className="gnode-name">{data.name}</span>
        </span>
      </div>
      <Handle type="source" position={horizontal ? Position.Right : Position.Bottom} isConnectable={false} />
    </>
  );
});

const EDGE_STYLE: Record<GraphEdge['relation'], { color: string; dash?: string; width: number }> = {
  reads: { color: 'var(--e-reads)', dash: '5 4', width: 1.4 },
  writes: { color: 'var(--e-writes)', width: 2 },
  calls: { color: 'var(--e-calls)', width: 1.6 },
  references: { color: 'var(--e-references)', width: 1.2 },
  fk: { color: 'var(--e-fk)', dash: '2 3', width: 1 },
  'has-step': { color: 'var(--e-has-step)', width: 1.6 },
  'trigger-on': { color: 'var(--e-trigger-on)', dash: '6 3', width: 1.5 },
};

export function edgeStyle(rel: GraphEdge['relation']) {
  return EDGE_STYLE[rel];
}

function roundedPath(points: Point[], r = 6): string {
  if (points.length < 2) return '';
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const p0 = points[i - 1];
    const p1 = points[i];
    const p2 = points[i + 1];
    const d1 = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    const d2 = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const rr = Math.min(r, d1 / 2, d2 / 2);
    const a = { x: p1.x - ((p1.x - p0.x) / (d1 || 1)) * rr, y: p1.y - ((p1.y - p0.y) / (d1 || 1)) * rr };
    const b = { x: p1.x + ((p2.x - p1.x) / (d2 || 1)) * rr, y: p1.y + ((p2.y - p1.y) / (d2 || 1)) * rr };
    d += ` L ${a.x} ${a.y} Q ${p1.x} ${p1.y} ${b.x} ${b.y}`;
  }
  const last = points[points.length - 1];
  d += ` L ${last.x} ${last.y}`;
  return d;
}

function longestSegmentMid(points: Point[]): Point {
  let best = { x: points[0].x, y: points[0].y };
  let len = -1;
  for (let i = 1; i < points.length; i++) {
    const l = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    if (l > len) {
      len = l;
      best = { x: (points[i].x + points[i - 1].x) / 2, y: (points[i].y + points[i - 1].y) / 2 };
    }
  }
  return best;
}

/** Draws the orthogonal route computed by ELK; falls back to a straight line between the handles. */
function ElkEdge(props: EdgeProps<Edge<GEdgeData>>) {
  const { data, sourceX, sourceY, targetX, targetY, markerEnd, id } = props;
  const pts = data?.points && data.points.length >= 2 ? data.points : [{ x: sourceX, y: sourceY }, { x: targetX, y: targetY }];
  const st = EDGE_STYLE[data?.relation ?? 'references'];
  const mid = longestSegmentMid(pts);
  return (
    <BaseEdge
      id={id}
      path={roundedPath(pts)}
      markerEnd={markerEnd}
      className={data?.dim ? 'dim' : undefined}
      style={{ stroke: st.color, strokeWidth: st.width, strokeDasharray: st.dash, opacity: data?.dim ? 0.12 : 1 }}
      label={data?.label}
      labelX={mid.x}
      labelY={mid.y}
      labelShowBg
      labelBgPadding={[3, 1]}
      labelBgBorderRadius={3}
    />
  );
}

const nodeTypes = { g: GNode };
const edgeTypes = { elk: ElkEdge };

export interface GraphCanvasProps {
  graph: Graph;
  direction: Direction;
  focusId: string | null;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  minimap?: boolean;
}

function edgeLabel(e: GraphEdge): string | undefined {
  if (e.relation !== 'writes' || !e.ops?.length) return undefined;
  const ops = displayOps(e.ops).filter((o) => o !== 'SELECT');
  return ops.map((o) => o.replace('_', ' ')).join(' ') || undefined;
}

function Canvas({ graph, direction, focusId, selectedId, onSelect, minimap = true }: GraphCanvasProps) {
  const rf = useReactFlow();
  const [layout, setLayout] = useState<{ key: string; positions: Map<string, Point>; edgePoints: Map<string, Point[]> } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const layoutKey = useMemo(() => `${direction}|${graph.nodes.map((n) => n.id).join(',')}|${graph.edges.map((e) => e.id).join(',')}`, [graph, direction]);
  const fitted = useRef<string>('');

  useEffect(() => {
    let cancelled = false;
    setError(null);
    layoutGraph({
      nodes: graph.nodes.map((n) => ({ id: n.id, width: nodeWidth(n), height: NODE_H })),
      edges: graph.edges.map((e) => ({ id: e.id, source: e.source, target: e.target })),
      direction,
    })
      .then((res) => {
        if (!cancelled) setLayout({ key: layoutKey, ...res });
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutKey]);

  const ready = layout?.key === layoutKey;

  const neighbors = useMemo(() => {
    const id = hoverId;
    if (!id) return null;
    const s = new Set<string>([id]);
    for (const e of graph.edges) {
      if (e.source === id) s.add(e.target);
      if (e.target === id) s.add(e.source);
    }
    return s;
  }, [hoverId, graph.edges]);

  const nodes: Node<GNodeData>[] = useMemo(() => {
    if (!ready) return [];
    return graph.nodes.map((n) => ({
      id: n.id,
      type: 'g',
      position: layout!.positions.get(n.id) ?? { x: 0, y: 0 },
      width: nodeWidth(n),
      height: NODE_H,
      selected: n.id === selectedId,
      data: {
        kind: n.kind,
        schema: n.kind === 'jobstep' ? `step ${String((n.meta as { stepId?: number } | undefined)?.stepId ?? '')}` : n.schema,
        name: n.kind === 'job' || n.kind === 'jobstep' || n.kind === 'external' || n.kind === 'unknown' ? (n.kind === 'external' ? n.label : n.name) : n.name,
        title: `${KIND_META[n.kind].label}: ${n.label}`,
        dim: Boolean(neighbors && !neighbors.has(n.id)),
        focus: n.id === focusId,
        direction,
      },
    }));
  }, [ready, layout, graph.nodes, selectedId, neighbors, focusId, direction]);

  const edges: Edge<GEdgeData>[] = useMemo(() => {
    if (!ready) return [];
    return graph.edges.map((e) => {
      const st = EDGE_STYLE[e.relation];
      return {
        id: e.id,
        source: e.source,
        target: e.target,
        type: 'elk',
        markerEnd: { type: MarkerType.ArrowClosed, color: st.color, width: 14, height: 14 },
        data: {
          points: layout!.edgePoints.get(e.id) ?? null,
          relation: e.relation,
          label: edgeLabel(e),
          dim: Boolean(neighbors && !(neighbors.has(e.source) && neighbors.has(e.target) && (e.source === hoverId || e.target === hoverId))),
        },
      };
    });
  }, [ready, layout, graph.edges, neighbors, hoverId]);

  useEffect(() => {
    if (!ready || fitted.current === layoutKey) return;
    fitted.current = layoutKey;
    const t = window.setTimeout(() => {
      if (focusId && graph.nodes.length > 40) {
        const p = layout!.positions.get(focusId);
        if (p) {
          rf.setCenter(p.x + 100, p.y + NODE_H / 2, { zoom: 1, duration: 0 });
          return;
        }
      }
      void rf.fitView({ padding: 0.12, maxZoom: 1.2, minZoom: 0.3, duration: 0 });
    }, 30);
    return () => window.clearTimeout(t);
  }, [ready, layoutKey, rf, focusId, graph.nodes.length, layout]);

  return (
    <div className="graph-canvas" data-testid="graph-canvas" data-ready={ready ? 'true' : 'false'}>
      {!ready && !error ? (
        <div className="graph-overlay">
          <div className="row muted">
            <Spinner /> Laying out {graph.nodes.length} nodes…
          </div>
        </div>
      ) : null}
      {error ? (
        <div className="graph-overlay">
          <div className="callout" data-tone="danger">
            Layout failed: {error}
          </div>
        </div>
      ) : null}
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        edgesFocusable={false}
        minZoom={0.08}
        maxZoom={2}
        onlyRenderVisibleElements={graph.nodes.length > 150}
        onNodeClick={(_e, n) => onSelect(n.id)}
        onPaneClick={() => onSelect(null)}
        onNodeMouseEnter={(_e, n) => setHoverId(n.id)}
        onNodeMouseLeave={() => setHoverId(null)}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={18} size={1.2} color="var(--graph-dots)" />
        <Controls showInteractive={false} position="bottom-left" />
        {minimap ? (
          <MiniMap
            pannable
            zoomable
            position="bottom-right"
            nodeColor={(n) => `var(--k-${(n.data as GNodeData).kind})`}
            nodeStrokeWidth={0}
            maskColor="color-mix(in srgb, var(--graph-bg) 60%, transparent)"
            style={{ width: 180, height: 120 }}
          />
        ) : null}
      </ReactFlow>
    </div>
  );
}

export function GraphCanvas(props: GraphCanvasProps) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}
