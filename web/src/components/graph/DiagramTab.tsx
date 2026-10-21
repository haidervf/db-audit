import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { ALL_GRAPH_KINDS, RELATIONS } from '../../lib/kinds';
import type { Direction } from '../../lib/layout';
import { Icon } from '../Icon';
import { Segmented } from '../ui';
import { GraphExplorer } from './GraphExplorer';

const ALL_REL = new Set(RELATIONS);

/** Focused dependency diagram for one node, embedded in a detail page. */
export function DiagramTab({ connId, nodeId, defaultDepth = 1, defaultDirection = 'LR' }: { connId: string; nodeId: string; defaultDepth?: number; defaultDirection?: Direction }) {
  const [depth, setDepth] = useState(defaultDepth);
  const [direction, setDirection] = useState<Direction>(defaultDirection);
  const navigate = useNavigate();
  const graphUrl = (focus: string, d = depth) => `/c/${encodeURIComponent(connId)}/graph?focus=${encodeURIComponent(focus)}&depth=${d}&dir=${direction}`;
  return (
    <div className="stack-md">
      <div className="toolbar" style={{ marginBottom: 0 }}>
        <span className="small muted">Depth</span>
        <Segmented
          label="Depth"
          value={String(depth)}
          onChange={(v) => setDepth(Number(v))}
          options={[1, 2, 3].map((d) => ({ value: String(d), label: String(d) }))}
        />
        <span className="small muted" style={{ marginLeft: 8 }}>
          Layout
        </span>
        <Segmented
          label="Layout direction"
          value={direction}
          onChange={setDirection}
          options={[
            { value: 'LR', label: 'Left → right' },
            { value: 'TB', label: 'Top → bottom' },
          ]}
        />
        <span className="spacer" />
        <Link className="btn btn-sm" to={graphUrl(nodeId)}>
          <Icon name="graph" size={14} /> Open in Graph
        </Link>
      </div>
      <GraphExplorer
        connId={connId}
        focus={nodeId}
        depth={depth}
        kinds={[...ALL_GRAPH_KINDS]}
        relations={ALL_REL}
        direction={direction}
        onFocus={(id) => navigate(graphUrl(id))}
        embed
        emptyHint="This object has no recorded dependencies."
      />
    </div>
  );
}
