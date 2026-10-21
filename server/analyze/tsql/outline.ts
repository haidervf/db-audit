// Outline tree: IF/ELSE/WHILE nest their single-statement or BEGIN…END bodies (a BEGIN…END
// body is flattened into the IF/WHILE/ELSE children); ELSE is the sibling right after its IF;
// standalone BEGIN…END becomes a BLOCK; BEGIN TRY/CATCH become TRY and CATCH siblings.

import type { Token } from './tokenizer';
import type { OutlineNode, StatementKind } from './types';
import type { SegItem } from './segmenter';
import type { StmtInfo } from './extractor';
import { summarize } from './summary';
import type { Warn } from './common';

const MAX_NESTING = 500;

export interface OutlineInput { items: SegItem[]; infos: StmtInfo[]; toks: Token[]; src: string; warn: Warn }

export function firstLineText(src: string, toks: Token[], s: number, e: number): string {
  const a = toks[s];
  if (!a) return '';
  let stop = src.indexOf('\n', a.start);
  if (stop < 0) stop = src.length;
  const last = toks[Math.max(s, e - 1)];
  if (last && last.end < stop && last.endLine === a.line) stop = last.end;
  const line = src.slice(a.start, stop).trim();
  return line.length <= 160 ? line : line.slice(0, 159).trimEnd() + '…';
}

function endLineOf(toks: Token[], s: number, e: number): number {
  for (let k = Math.min(e, toks.length) - 1; k >= s; k--) {
    const t = toks[k] as Token;
    if (t.type !== ';') return t.endLine;
  }
  return toks[s]?.line ?? 1;
}

export function targetsOf(info: StmtInfo): string[] {
  const out: string[] = [];
  const add = (k: string): void => { if (!out.includes(k)) out.push(k); };
  for (const a of info.accesses) add(a.ref.key);
  for (const c of info.calls) add(c.ref.key);
  for (const f of info.functions) add(f.ref.key);
  for (const q of info.sequences) add(q.ref.key);
  return out;
}

export function buildOutline(inp: OutlineInput): OutlineNode[] {
  const { items, infos, toks, src, warn } = inp;
  let p = 0;

  const leaf = (idx: number): OutlineNode => {
    const it = items[idx] as SegItem;
    const info = infos[idx] as StmtInfo;
    const kind = it.kind as StatementKind;
    const node: OutlineNode = {
      kind,
      startLine: (toks[it.start] as Token).line,
      endLine: endLineOf(toks, it.start, it.end),
      text: firstLineText(src, toks, it.start, it.end),
      summary: summarize(kind, it, info, toks),
      targets: targetsOf(info),
      children: [],
    };
    if (kind === 'WITH_CTE') node.mainKind = (toks[it.mainIndex]?.upper ?? 'SELECT') as StatementKind;
    return node;
  };
  const container = (kind: StatementKind, idx: number, summary: string): OutlineNode => {
    const it = items[idx] as SegItem;
    return { kind, startLine: (toks[it.start] as Token).line, endLine: endLineOf(toks, it.start, it.end),
      text: firstLineText(src, toks, it.start, it.end), summary, targets: [], children: [] };
  };
  const isEnd = (k: string): boolean => k === 'END' || k === 'END_TRY' || k === 'END_CATCH';
  const lastEnd = (nodes: OutlineNode[], fallback: number): number => nodes.reduce((mx, n) => Math.max(mx, n.endLine), fallback);

  /** Parse statements until an END-type marker; consumes the expected terminator when present. */
  function parseSeq(terminator: 'END' | 'END_TRY' | 'END_CATCH' | null, depth: number): { nodes: OutlineNode[]; endLine: number | null } {
    const nodes: OutlineNode[] = [];
    while (p < items.length) {
      const it = items[p] as SegItem;
      if (isEnd(it.kind)) {
        if (terminator === null) {
          warn((toks[it.start] as Token).line, `Unmatched ${it.kind.replace('_', ' ')} (no open BEGIN)`);
          p++;
          continue;
        }
        if (it.kind !== terminator) warn((toks[it.start] as Token).line, `Expected ${terminator.replace('_', ' ')} but found ${it.kind.replace('_', ' ')}`);
        p++;
        return { nodes, endLine: endLineOf(toks, it.start, it.end) };
      }
      nodes.push(...parseOne(depth));
    }
    if (terminator !== null) warn(null, `Missing ${terminator.replace('_', ' ')} at end of batch`);
    return { nodes, endLine: null };
  }

  /** Parse one statement (with its body for IF/WHILE/ELSE/BEGIN/TRY). May return [IF, ELSE] or [TRY, CATCH]. */
  function parseOne(depth: number): OutlineNode[] {
    const idx = p;
    const it = items[p++] as SegItem;
    const tooDeep = depth > MAX_NESTING;
    if (tooDeep && depth === MAX_NESTING + 1) warn((toks[it.start] as Token).line, 'Nesting too deep; outline flattened below this point');
    switch (it.kind) {
      case 'BEGIN': {
        const node = container('BLOCK', idx, '');
        if (tooDeep) { node.summary = 'BEGIN … END'; return [node]; }
        const r = parseSeq('END', depth + 1);
        node.children = r.nodes;
        node.endLine = r.endLine ?? lastEnd(r.nodes, node.endLine);
        node.summary = `BEGIN … END (${count(r.nodes)})`;
        return [node];
      }
      case 'BEGIN_TRY': case 'BEGIN_CATCH': {
        const isTry = it.kind === 'BEGIN_TRY';
        const node = container(isTry ? 'TRY' : 'CATCH', idx, '');
        if (tooDeep) { node.summary = isTry ? 'BEGIN TRY' : 'BEGIN CATCH'; return [node]; }
        const r = parseSeq(isTry ? 'END_TRY' : 'END_CATCH', depth + 1);
        node.children = r.nodes;
        node.endLine = r.endLine ?? lastEnd(r.nodes, node.endLine);
        node.summary = `${isTry ? 'BEGIN TRY' : 'BEGIN CATCH'} (${count(r.nodes)})`;
        if (isTry && items[p]?.kind === 'BEGIN_CATCH') return [node, ...parseOne(depth)];
        if (isTry) warn(node.endLine, 'END TRY not followed by BEGIN CATCH');
        return [node];
      }
      case 'IF': case 'WHILE': {
        const node = leaf(idx);
        if (tooDeep) return [node];
        const next = items[p];
        if (!next || isEnd(next.kind) || next.kind === 'ELSE') {
          warn(node.startLine, `${it.kind} without a body`);
        } else {
          const body = parseOne(depth + 1);
          node.children = flatten(body);
          node.endLine = Math.max(node.endLine, lastEnd(body, node.endLine));
        }
        if (it.kind === 'IF' && items[p]?.kind === 'ELSE') return [node, parseElse(depth)];
        return [node];
      }
      case 'ELSE': {
        p--;
        warn((toks[it.start] as Token).line, 'ELSE without a matching IF');
        return [parseElse(depth)];
      }
      default:
        return [leaf(idx)];
    }
  }

  function parseElse(depth: number): OutlineNode {
    const idx = p;
    p++;
    const node = container('ELSE', idx, 'ELSE');
    const next = items[p];
    if (!next || isEnd(next.kind) || depth > MAX_NESTING) {
      if (!next || isEnd(next.kind)) warn(node.startLine, 'ELSE without a body');
      return node;
    }
    const body = parseOne(depth + 1);
    node.children = flatten(body);
    node.endLine = Math.max(node.endLine, lastEnd(body, node.endLine));
    const first = body[0];
    if (first && first.kind === 'IF' && first.startLine === node.startLine && body.length >= 1) {
      node.summary = `ELSE ${first.summary}`;
    }
    return node;
  }

  const roots = parseSeq(null, 0).nodes;
  return roots;
}

function flatten(body: OutlineNode[]): OutlineNode[] {
  if (body.length === 1 && body[0]?.kind === 'BLOCK') return body[0].children;
  return body;
}

function count(nodes: OutlineNode[]): string {
  return `${nodes.length} statement${nodes.length === 1 ? '' : 's'}`;
}
