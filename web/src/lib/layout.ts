import ELK from 'elkjs/lib/elk-api';
import type { ELK as ElkInstance, ElkExtendedEdge, ElkNode } from 'elkjs/lib/elk-api';
import elkWorkerUrl from 'elkjs/lib/elk-worker.min.js?url';

/** ELK runs in a Web Worker (elk-worker.min.js); one worker for the app, created lazily. */
let elk: ElkInstance | null = null;
function getElk(): ElkInstance {
  if (!elk) elk = new ELK({ workerUrl: elkWorkerUrl });
  return elk;
}

export type Direction = 'LR' | 'TB';

export interface LayoutInput {
  nodes: Array<{ id: string; width: number; height: number }>;
  edges: Array<{ id: string; source: string; target: string }>;
  direction: Direction;
}

export interface Point {
  x: number;
  y: number;
}

export interface LayoutResult {
  positions: Map<string, Point>;
  edgePoints: Map<string, Point[]>;
}

export async function layoutGraph(input: LayoutInput): Promise<LayoutResult> {
  const ids = new Set(input.nodes.map((n) => n.id));
  const graph: ElkNode = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': input.direction === 'LR' ? 'RIGHT' : 'DOWN',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.layered.spacing.nodeNodeBetweenLayers': input.direction === 'LR' ? '80' : '60',
      'elk.spacing.nodeNode': input.direction === 'LR' ? '18' : '28',
      'elk.layered.spacing.edgeNodeBetweenLayers': '24',
      'elk.spacing.edgeEdge': '10',
      'elk.spacing.edgeNode': '14',
      'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
      'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      'elk.separateConnectedComponents': 'true',
      'elk.spacing.componentComponent': '48',
      'elk.layered.mergeEdges': 'false',
    },
    children: input.nodes.map((n) => ({ id: n.id, width: n.width, height: n.height })),
    edges: input.edges
      .filter((e) => ids.has(e.source) && ids.has(e.target) && e.source !== e.target)
      .map((e): ElkExtendedEdge => ({ id: e.id, sources: [e.source], targets: [e.target] })),
  };
  const res = await getElk().layout(graph);
  const positions = new Map<string, Point>();
  for (const c of res.children ?? []) positions.set(c.id, { x: c.x ?? 0, y: c.y ?? 0 });
  const edgePoints = new Map<string, Point[]>();
  for (const e of (res.edges ?? []) as ElkExtendedEdge[]) {
    const s = e.sections?.[0];
    if (!s) continue;
    edgePoints.set(e.id, [s.startPoint, ...(s.bendPoints ?? []), s.endPoint]);
  }
  return { positions, edgePoints };
}
