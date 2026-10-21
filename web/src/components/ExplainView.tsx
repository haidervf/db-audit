import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import type { AnalysisPayload, OutlineNode, ResolvedRef, TableAccess } from '../api/types';
import { plural } from '../lib/format';
import { nodeRoute, WRITE_OPS } from '../lib/kinds';
import { CodeView, type LineRange } from './CodeView';
import { Icon } from './Icon';
import { OutlineTree } from './OutlineTree';
import { Callout, Empty, KindGlyph, OpBadges } from './ui';

export interface ExternalHighlight {
  range: LineRange;
  nonce: number;
}

/** Deepest outline node that starts on `line` (and touches `key`, when given). */
function statementAt(nodes: OutlineNode[], line: number, key?: string): OutlineNode | null {
  let best: OutlineNode | null = null;
  const walk = (list: OutlineNode[]) => {
    for (const n of list) {
      if (n.startLine > line || n.endLine < line) continue;
      if (n.startLine === line && (!key || n.targets.includes(key) || !best)) best = n;
      walk(n.children);
    }
  };
  walk(nodes);
  return best;
}

function findNodeKey(nodes: OutlineNode[], range: LineRange, path: number[] = []): string | null {
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const p = [...path, i];
    if (n.startLine === range[0] && n.endLine === range[1]) {
      const deeper = findNodeKey(n.children, range, p);
      return deeper ?? p.join('.');
    }
    if (n.startLine <= range[0] && n.endLine >= range[1]) {
      const deeper = findNodeKey(n.children, range, p);
      if (deeper) return deeper;
    }
  }
  return null;
}

function refLabel(t: TableAccess): string {
  const r = t.ref;
  return [r.server, r.database, r.schema ?? (r.database ? '' : null), r.name].filter((x) => x !== null && x !== undefined).join('.') || r.display;
}

function resolvedOf(a: AnalysisPayload, key: string): ResolvedRef | undefined {
  return a.resolved?.[key];
}

function chipKind(t: TableAccess, r: ResolvedRef | undefined): 'table' | 'view' | 'external' | 'unknown' | 'function' | 'procedure' | 'trigger' {
  if (t.ref.database || t.ref.server) return 'external';
  if (r && r.kind !== 'unknown') return r.kind;
  return 'unknown';
}

export function ExplainView({
  connId,
  code,
  analysis,
  external,
  compact,
  emptyAnalysisMessage,
  testIdPrefix = 'explain',
}: {
  connId: string;
  code: string;
  analysis: AnalysisPayload | null | undefined;
  external?: ExternalHighlight | null;
  compact?: boolean;
  emptyAnalysisMessage?: ReactNode;
  testIdPrefix?: string;
}) {
  const navigate = useNavigate();
  const [selected, setSelected] = useState<{ range: LineRange; key: string | null; nonce: number } | null>(null);
  const [hover, setHover] = useState<LineRange[]>([]);

  useEffect(() => {
    if (!external) return;
    const key = analysis?.outline ? findNodeKey(analysis.outline, external.range) : null;
    setSelected({ range: external.range, key, nonce: external.nonce });
  }, [external, analysis]);

  const select = (range: LineRange, key: string | null = null) => setSelected((s) => ({ range, key, nonce: (s?.nonce ?? 0) + 1 }));

  const tableRanges = (t: TableAccess): LineRange[] => {
    if (!analysis) return [];
    return t.lines.map((l) => {
      const n = statementAt(analysis.outline, l, t.ref.key);
      return n ? ([n.startLine, n.endLine] as LineRange) : ([l, l] as LineRange);
    });
  };

  const tables = useMemo(() => {
    if (!analysis) return [];
    return [...analysis.tables].sort((a, b) => {
      const wa = a.ops.some((o) => WRITE_OPS.has(o)) ? 0 : 1;
      const wb = b.ops.some((o) => WRITE_OPS.has(o)) ? 0 : 1;
      return wa - wb || refLabel(a).localeCompare(refLabel(b));
    });
  }, [analysis]);

  const codeMax = compact ? '420px' : 'calc(100vh - 250px)';
  const codePanel = (
    <div className="code-panel">
      <div className="code-panel-header">
        <Icon name="procedure" size={14} />
        <span>T-SQL</span>
        <span className="spacer" />
        {selected ? (
          <>
            <span className="mono xsmall">
              L{selected.range[0]}
              {selected.range[1] !== selected.range[0] ? `–${selected.range[1]}` : ''}
            </span>
            <button type="button" className="btn btn-ghost btn-xs" onClick={() => setSelected(null)}>
              Clear
            </button>
          </>
        ) : (
          <span className="xsmall">{plural(code.split('\n').length, 'line')}</span>
        )}
      </div>
      <CodeView code={code} selected={selected?.range ?? null} hover={hover} maxHeight={codeMax} testId={`${testIdPrefix}-code`} scrollKey={selected?.nonce} />
    </div>
  );

  if (!analysis) {
    return (
      <div className="explain" style={compact ? { gridTemplateColumns: 'minmax(0,1fr)' } : undefined}>
        {codePanel}
        {compact ? null : (
          <div className="side-panel">
            <div className="panel-section" data-testid={`${testIdPrefix}-no-analysis`}>
              <Empty
                compact
                icon="layers"
                title="Analysis not available — run a refresh"
                body={emptyAnalysisMessage ?? 'The statement outline, table access and calls come from static analysis of the cached code. Run a refresh (or the "analysis" segment) to produce it.'}
              />
            </div>
          </div>
        )}
      </div>
    );
  }

  const a = analysis;
  const userCalls = a.procCalls;
  const hasTemp = a.tempTables.length + a.tableVariables.length + a.ctes.length > 0;

  return (
    <div className={`explain${compact ? ' compact' : ''}`}>
      {codePanel}
      <div className="side-panel">
        {a.dynamicSql.length ? (
          <Callout tone="warn" title={`Dynamic SQL (${a.dynamicSql.length})`}>
            <div className="stack-sm" style={{ marginTop: 4 }}>
              {a.dynamicSql.map((d, i) => (
                <div key={i} className="row" style={{ alignItems: 'flex-start' }}>
                  <button type="button" className="line-link" onClick={() => select([d.line, d.line])}>
                    L{d.line}
                  </button>
                  <span className="badge square">{d.kind.replace(/_/g, ' ')}</span>
                  <code className="grow truncate" title={d.snippet}>
                    {d.snippet}
                  </code>
                </div>
              ))}
              <div className="xsmall">Objects reached through dynamic SQL are not visible to static analysis.</div>
            </div>
          </Callout>
        ) : null}

        <section className="panel-section" data-testid={`${testIdPrefix}-touches`}>
          <header>
            Touches <span className="count">{tables.length}</span>
            <span className="spacer" />
            <span className="xsmall muted" style={{ fontWeight: 400 }}>
              hover to highlight
            </span>
          </header>
          <div className="body">
            {tables.length === 0 ? (
              <span className="muted small">No tables or views referenced.</span>
            ) : (
              <div className="row-wrap">
                {tables.map((t) => {
                  const r = resolvedOf(a, t.ref.key);
                  const kind = chipKind(t, r);
                  const route = r?.nodeId && r.exists ? nodeRoute(connId, r.nodeId) : null;
                  return (
                    <button
                      type="button"
                      key={t.ref.key}
                      className={`chip${route ? '' : ' dashed'}`}
                      title={`${t.ref.display} — ${t.ops.join(', ')} at line ${t.lines.join(', ')}${route ? '' : kind === 'external' ? ' (other database)' : ' (not found in this database)'}`}
                      onMouseEnter={() => setHover(tableRanges(t))}
                      onMouseLeave={() => setHover([])}
                      onFocus={() => setHover(tableRanges(t))}
                      onBlur={() => setHover([])}
                      onClick={() => (route ? navigate(route) : select(tableRanges(t)[0] ?? [t.lines[0] ?? 1, t.lines[0] ?? 1]))}
                      data-testid="touch-chip"
                    >
                      <KindGlyph kind={kind} />
                      <span className="mono">{refLabel(t)}</span>
                      <OpBadges ops={t.ops} />
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </section>

        <section className="panel-section">
          <header>
            Outline <span className="count">{plural(a.stats.statements, 'statement')}</span>
          </header>
          {a.outline.length ? (
            <OutlineTree
              nodes={a.outline}
              selectedKey={selected?.key ?? null}
              onSelect={(n, key) => select([n.startLine, n.endLine], key)}
              short={compact}
              testId={`${testIdPrefix}-outline`}
            />
          ) : (
            <div className="body muted small">No statements found.</div>
          )}
        </section>

        <section className="panel-section">
          <header>
            Calls <span className="count">{userCalls.length}</span>
          </header>
          {userCalls.length === 0 ? (
            <div className="body muted small">No procedure calls.</div>
          ) : (
            <ul className="list-plain" style={{ padding: '2px 0' }}>
              {userCalls.map((c, i) => {
                const r = resolvedOf(a, c.ref.key);
                const route = r?.nodeId && r.exists ? nodeRoute(connId, r.nodeId) : null;
                return (
                  <li key={i}>
                    <button type="button" className="line-link" onClick={() => select([c.line, c.line])}>
                      L{c.line}
                    </button>
                    <KindGlyph kind={c.ref.database || c.ref.server ? 'external' : route ? 'procedure' : 'unknown'} />
                    {route ? (
                      <Link to={route} className="mono small truncate">
                        {c.ref.display}
                      </Link>
                    ) : (
                      <span className="mono small truncate" title={c.isSystem ? 'system procedure' : 'not found in this database'}>
                        {c.ref.display}
                      </span>
                    )}
                    <span className="spacer" />
                    {c.isSystem ? <span className="badge square">system</span> : null}
                    {c.viaInsertExec ? <span className="badge square">INSERT…EXEC</span> : null}
                    {c.returnVar ? <span className="badge square mono" title="return value captured">{c.returnVar} =</span> : null}
                    <span className="xsmall muted nowrap">{c.args.length} arg{c.args.length === 1 ? '' : 's'}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {a.functionCalls.length || a.sequences.length ? (
          <section className="panel-section">
            <header>
              Functions &amp; sequences <span className="count">{a.functionCalls.length + a.sequences.length}</span>
            </header>
            <ul className="list-plain" style={{ padding: '2px 0' }}>
              {a.functionCalls.map((f, i) => {
                const r = resolvedOf(a, f.ref.key);
                const route = r?.nodeId && r.exists ? nodeRoute(connId, r.nodeId) : null;
                return (
                  <li key={`f${i}`}>
                    <button type="button" className="line-link" onClick={() => select([f.line, f.line])}>
                      L{f.line}
                    </button>
                    <KindGlyph kind="function" />
                    {route ? (
                      <Link to={route} className="mono small truncate">
                        {f.ref.display}
                      </Link>
                    ) : (
                      <span className="mono small truncate">{f.ref.display}</span>
                    )}
                    <span className="spacer" />
                    <span className="xsmall muted">{f.kind}</span>
                  </li>
                );
              })}
              {a.sequences.map((s, i) => (
                <li key={`s${i}`}>
                  <button type="button" className="line-link" onClick={() => select([s.line, s.line])}>
                    L{s.line}
                  </button>
                  <KindGlyph kind="unknown" />
                  <span className="mono small truncate">{s.ref.display}</span>
                  <span className="spacer" />
                  <span className="xsmall muted">sequence</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {hasTemp ? (
          <section className="panel-section">
            <header>Temp tables, table variables &amp; CTEs</header>
            <ul className="list-plain" style={{ padding: '2px 0' }}>
              {a.tempTables.map((t) => (
                <li key={`t${t.ref.key}`}>
                  <button type="button" className="line-link" onClick={() => select(tableRanges(t)[0] ?? [1, 1])}>
                    L{t.lines[0]}
                  </button>
                  <span className="mono small">{t.ref.name}</span>
                  <span className="badge square">temp table</span>
                  <span className="spacer" />
                  <OpBadges ops={t.ops} />
                </li>
              ))}
              {a.tableVariables.map((t) => (
                <li key={`v${t.name}${t.line}`}>
                  <button type="button" className="line-link" onClick={() => select([t.line, t.line])}>
                    L{t.line}
                  </button>
                  <span className="mono small">{t.name}</span>
                  <span className="badge square">table variable</span>
                </li>
              ))}
              {a.ctes.map((t) => (
                <li key={`c${t.name}${t.line}`}>
                  <button type="button" className="line-link" onClick={() => select([t.line, t.line])}>
                    L{t.line}
                  </button>
                  <span className="mono small">{t.name}</span>
                  <span className="badge square">CTE</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {a.transactions.begin + a.cursors.length > 0 || a.hasTryCatch ? (
          <div className="row-wrap small muted" style={{ padding: '0 2px' }}>
            {a.hasTryCatch ? <span className="badge square">TRY / CATCH</span> : null}
            {a.transactions.begin ? (
              <span className="badge square" title="BEGIN / COMMIT / ROLLBACK">
                transactions {a.transactions.begin}/{a.transactions.commit}/{a.transactions.rollback}
              </span>
            ) : null}
            {a.cursors.map((c) => (
              <span key={c.name} className="badge square">
                cursor {c.name}
              </span>
            ))}
            {a.crossDatabaseRefs.length ? <span className="badge square" data-tone="warn">cross-database: {a.crossDatabaseRefs.map((r) => r.database).filter((v, i, arr) => arr.indexOf(v) === i).join(', ')}</span> : null}
          </div>
        ) : null}

        {a.warnings.length ? (
          <section className="panel-section">
            <header>
              Analyzer notes <span className="count">{a.warnings.length}</span>
            </header>
            <ul className="list-plain" style={{ padding: '2px 0' }}>
              {a.warnings.map((w, i) => (
                <li key={i} style={{ alignItems: 'flex-start' }}>
                  {w.line ? (
                    <button type="button" className="line-link" onClick={() => select([w.line!, w.line!])}>
                      L{w.line}
                    </button>
                  ) : null}
                  <span className="small text-2">{w.message}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </div>
  );
}
