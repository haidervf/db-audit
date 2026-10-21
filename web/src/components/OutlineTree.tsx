import { useMemo, useState, type ReactNode } from 'react';
import type { OutlineNode, StatementKind } from '../api/types';
import { Icon } from './Icon';

const CATEGORY: Partial<Record<StatementKind, string>> = {
  SELECT: 'select',
  INSERT: 'insert',
  UPDATE: 'update',
  DELETE: 'delete',
  MERGE: 'merge',
  TRUNCATE: 'truncate',
  EXEC: 'exec',
  IF: 'flow',
  ELSE: 'flow',
  WHILE: 'flow',
  BLOCK: 'flow',
  TRY: 'flow',
  CATCH: 'flow',
  GOTO: 'flow',
  LABEL: 'flow',
  BREAK: 'flow',
  CONTINUE: 'flow',
  RETURN: 'flow',
  WAITFOR: 'flow',
  BEGIN_TRAN: 'tran',
  COMMIT: 'tran',
  ROLLBACK: 'tran',
  SAVE_TRAN: 'tran',
  RAISERROR: 'error',
  THROW: 'error',
  CREATE_TABLE: 'ddl',
  DROP_TABLE: 'ddl',
  ALTER_TABLE: 'ddl',
  CREATE_INDEX: 'ddl',
  CURSOR: 'cursor',
  OPEN: 'cursor',
  FETCH: 'cursor',
  CLOSE: 'cursor',
  DEALLOCATE: 'cursor',
};

const LABEL: Partial<Record<StatementKind, string>> = {
  BEGIN_TRAN: 'BEGIN TRAN',
  SAVE_TRAN: 'SAVE TRAN',
  SET_OPTION: 'SET',
  CREATE_TABLE: 'CREATE',
  DROP_TABLE: 'DROP',
  ALTER_TABLE: 'ALTER',
  CREATE_INDEX: 'INDEX',
  WITH_CTE: 'WITH',
  BLOCK: 'BEGIN',
  RAISERROR: 'RAISE',
  DEALLOCATE: 'DEALLOC',
};

export function statementCategory(n: Pick<OutlineNode, 'kind' | 'mainKind'>): string {
  if (n.kind === 'WITH_CTE') return (n.mainKind && CATEGORY[n.mainKind]) || 'select';
  return CATEGORY[n.kind] ?? 'var';
}

export function statementLabel(kind: StatementKind): string {
  return LABEL[kind] ?? kind;
}

export function nodePathKey(path: number[]): string {
  return path.join('.');
}

function collectKeys(nodes: OutlineNode[], maxDepth: number, path: number[] = [], out = new Set<string>()): Set<string> {
  nodes.forEach((n, i) => {
    const p = [...path, i];
    if (n.children.length && p.length <= maxDepth) out.add(nodePathKey(p));
    collectKeys(n.children, maxDepth, p, out);
  });
  return out;
}

export function OutlineTree({
  nodes,
  selectedKey,
  onSelect,
  onHover,
  short,
  testId,
}: {
  nodes: OutlineNode[];
  selectedKey: string | null;
  onSelect: (node: OutlineNode, key: string) => void;
  onHover?: (node: OutlineNode | null) => void;
  short?: boolean;
  testId?: string;
}) {
  const initial = useMemo(() => collectKeys(nodes, 3), [nodes]);
  const [open, setOpen] = useState<Set<string>>(initial);
  const toggle = (k: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });

  const render = (list: OutlineNode[], path: number[], depth: number): ReactNode =>
    list.map((n, i) => {
      const p = [...path, i];
      const key = nodePathKey(p);
      const hasChildren = n.children.length > 0;
      const isOpen = open.has(key);
      const lines = n.startLine === n.endLine ? `L${n.startLine}` : `L${n.startLine}–${n.endLine}`;
      return (
        <div key={key} role="treeitem" aria-expanded={hasChildren ? isOpen : undefined} aria-selected={selectedKey === key}>
          <div
            className="on-row"
            aria-selected={selectedKey === key}
            style={{ paddingLeft: 6 + depth * 14 }}
            onClick={() => onSelect(n, key)}
            onMouseEnter={onHover ? () => onHover(n) : undefined}
            onMouseLeave={onHover ? () => onHover(null) : undefined}
            title={n.text}
            data-testid="outline-node"
            data-lines={`${n.startLine}-${n.endLine}`}
          >
            {hasChildren ? (
              <button
                type="button"
                className="on-toggle"
                aria-expanded={isOpen}
                aria-label={isOpen ? 'Collapse' : 'Expand'}
                onClick={(e) => {
                  e.stopPropagation();
                  toggle(key);
                }}
              >
                <Icon name="chevronRight" size={12} />
              </button>
            ) : (
              <span style={{ width: 16, flex: 'none' }} />
            )}
            <span className="on-kind" data-op={statementCategory(n)}>
              {n.kind === 'WITH_CTE' && n.mainKind ? `WITH ${statementLabel(n.mainKind)}` : statementLabel(n.kind)}
            </span>
            <span className="on-summary">{n.summary || n.text}</span>
            <span className="on-lines">{lines}</span>
          </div>
          {hasChildren && isOpen ? <div role="group">{render(n.children, p, depth + 1)}</div> : null}
        </div>
      );
    });

  return (
    <div>
      <div className="row" style={{ padding: '4px 10px 0', justifyContent: 'flex-end', gap: 2 }}>
        <button type="button" className="btn btn-ghost btn-xs" onClick={() => setOpen(collectKeys(nodes, 99))}>
          Expand all
        </button>
        <button type="button" className="btn btn-ghost btn-xs" onClick={() => setOpen(new Set())}>
          Collapse all
        </button>
      </div>
      <div className={`outline${short ? ' short' : ''}`} role="tree" data-testid={testId}>
        {render(nodes, [], 0)}
      </div>
    </div>
  );
}
