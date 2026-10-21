// T-SQL static analyzer entry point. Pure, synchronous, zero dependencies. Never throws.

import type { AnalyzeOptions, DynamicSql, FunctionCall, ModuleAnalysis, ModuleHeader, ObjectRef, OutlineNode, ProcCall, SequenceRef, TableAccess, TableOp } from './types';
import { countLines, tokenize, type Token } from './tokenizer';
import { splitBatches } from './batches';
import { parseHeader } from './header';
import { segment } from './segmenter';
import { extractStatement, type StmtInfo } from './extractor';
import { buildOutline, firstLineText } from './outline';
import { prettyName, type Warn } from './common';

export type * from './types';

export const ANALYZER_VERSION = '1.0.0';

const OP_ORDER: TableOp[] = ['SELECT', 'INSERT', 'INSERT_EXEC', 'UPDATE', 'DELETE', 'MERGE', 'SELECT_INTO', 'TRUNCATE', 'CREATE', 'ALTER', 'DROP'];
const MAX_WARNINGS = 200;
const MARKERS = new Set(['BEGIN', 'END', 'BEGIN_TRY', 'END_TRY', 'BEGIN_CATCH', 'END_CATCH', 'ELSE']);

function now(): number {
  const perf = (globalThis as { performance?: { now(): number } }).performance;
  return perf ? perf.now() : Date.now();
}

function emptyAnalysis(lines: number): ModuleAnalysis {
  return {
    analyzerVersion: ANALYZER_VERSION, header: null, tables: [], tempTables: [], tableVariables: [], ctes: [], procCalls: [],
    functionCalls: [], sequences: [], dynamicSql: [], crossDatabaseRefs: [], linkedServerRefs: [],
    transactions: { begin: 0, commit: 0, rollback: 0, save: 0 }, hasTryCatch: false, cursors: [], gotoLabels: [], outline: [],
    warnings: [], stats: { lines, statements: 0, batches: 0, durationMs: 0 }, linkedServers: [],
  };
}

class TableAgg {
  private map = new Map<string, { ref: ObjectRef; ops: Set<TableOp>; aliases: string[]; lines: Set<number> }>();
  add(ref: ObjectRef, op: TableOp, alias: string | null, line: number): void {
    let e = this.map.get(ref.key);
    if (!e) { e = { ref, ops: new Set(), aliases: [], lines: new Set() }; this.map.set(ref.key, e); }
    e.ops.add(op);
    if (alias && !e.aliases.includes(alias)) e.aliases.push(alias);
    e.lines.add(line);
  }
  list(): TableAccess[] {
    const out: TableAccess[] = [];
    for (const e of this.map.values()) {
      const t: TableAccess = { ref: e.ref, ops: OP_ORDER.filter(o => e.ops.has(o)), aliases: e.aliases, lines: [...e.lines].sort((a, b) => a - b) };
      const sch = (e.ref.schema ?? '').toLowerCase();
      if (sch === 'sys' || sch === 'information_schema') t.isSystem = true;
      out.push(t);
    }
    return out;
  }
}

export function analyzeModule(sqlText: string, opts?: AnalyzeOptions): ModuleAnalysis {
  const t0 = now();
  let src = '';
  try { src = typeof sqlText === 'string' ? sqlText : String(sqlText ?? ''); } catch { src = ''; }
  const lines = countLines(src);
  try {
    return analyzeInner(src, opts ?? {}, t0, lines);
  } catch (err) {
    const r = emptyAnalysis(lines);
    const msg = err instanceof Error ? err.message : String(err);
    r.warnings.push({ line: null, message: `Analyzer internal error (result is empty): ${msg}` });
    r.stats.durationMs = now() - t0;
    return r;
  }
}

function analyzeInner(src: string, opts: AnalyzeOptions, t0: number, lines: number): ModuleAnalysis {
  const defaultSchema = (opts.defaultSchema && opts.defaultSchema.trim()) || 'dbo';
  const r = emptyAnalysis(lines);
  const warnings = r.warnings;
  const warn: Warn = (line, message) => {
    if (warnings.length < MAX_WARNINGS) warnings.push({ line, message });
    else if (warnings.length === MAX_WARNINGS) warnings.push({ line: null, message: 'Too many warnings; further warnings suppressed' });
  };

  const tk = tokenize(src, { quotedIdentifier: opts.quotedIdentifier !== false });
  for (const w of tk.warnings) warn(w.line, w.message);
  const batches = splitBatches(tk.tokens);
  r.stats.batches = batches.length;

  const tables = new TableAgg();
  const temps = new TableAgg();
  const procCalls: ProcCall[] = [];
  const functionCalls: FunctionCall[] = [];
  const sequences: SequenceRef[] = [];
  const dynamicSql: DynamicSql[] = [];
  const linkedServers: string[] = [];
  const labels: string[] = [];
  const seenFn = new Set<string>();
  const seenSeq = new Set<string>();
  const seenTv = new Set<string>();
  const outline: OutlineNode[] = [];
  let header: ModuleHeader | null = null;
  let statements = 0;

  const addLinked = (n: string): void => { if (!linkedServers.some(x => x.toLowerCase() === n.toLowerCase())) linkedServers.push(n); };
  const addTv = (tv: { name: string; line: number }): void => {
    const k = `${tv.name.toLowerCase()}@${tv.line}`;
    if (!seenTv.has(k)) { seenTv.add(k); r.tableVariables.push(tv); }
  };

  for (const b of batches) {
    const toks = b.tokens;
    const hp = parseHeader(toks, src, defaultSchema, warn);
    let bodyStart = 0;
    let isPrimary = false;
    if (hp) {
      if (!header) { header = hp.header; isPrimary = true; }
      else warn((toks[0] as Token).line, `Additional module definition ${hp.header.ref.display} in batch ${b.index + 1}; header reflects the first module`);
      bodyStart = hp.bodyStart;
      for (const tv of hp.tableVariables) addTv(tv);
    }
    const items = segment(toks, bodyStart, toks.length, { inlineTvf: !!hp?.inlineTvf });
    const ctx = { src, toks, defaultSchema, warn, inTrigger: hp?.header.kind === 'TRIGGER' };
    const infos: StmtInfo[] = items.map(it => extractStatement(ctx, it));

    let depth = 0;
    for (const t of toks) { if (t.type === '(') depth++; else if (t.type === ')') depth--; }
    if (depth !== 0) warn(b.startLine, `Unbalanced parentheses in batch starting at line ${b.startLine} (${depth > 0 ? 'missing )' : 'extra )'})`);

    for (let i = 0; i < items.length; i++) {
      const it = items[i]!;
      const info = infos[i]!;
      const line = (toks[it.start] as Token).line;
      if (!MARKERS.has(it.kind)) statements++;
      switch (it.kind) {
        case 'BEGIN_TRAN': r.transactions.begin++; break;
        case 'COMMIT': r.transactions.commit++; break;
        case 'ROLLBACK': r.transactions.rollback++; break;
        case 'SAVE_TRAN': r.transactions.save++; break;
        case 'BEGIN_TRY': r.hasTryCatch = true; break;
        case 'LABEL': { const n = (toks[it.start] as Token).name; if (!labels.includes(n)) labels.push(n); break; }
        case 'GOTO': { const n = toks[it.start + 1]?.name; if (n && it.end > it.start + 1 && !labels.includes(n)) labels.push(n); break; }
        default: break;
      }
      for (const a of info.accesses) (a.temp ? temps : tables).add(a.ref, a.op, a.alias, line);
      for (const c of info.calls) procCalls.push(c);
      for (const f of info.functions) {
        const k = `${f.ref.key}|${f.line}|${f.kind}`;
        if (!seenFn.has(k)) { seenFn.add(k); functionCalls.push(f); }
      }
      for (const q of info.sequences) {
        const k = `${q.ref.key}|${q.line}`;
        if (!seenSeq.has(k)) { seenSeq.add(k); sequences.push(q); }
      }
      for (const d of info.dynamic) dynamicSql.push(d);
      for (const c of info.ctes) r.ctes.push({ name: c.name, line: c.line });
      for (const tv of info.tableVariables) addTv(tv);
      if (info.cursor) r.cursors.push(info.cursor);
      for (const ls of info.linkedServers) addLinked(ls);
    }

    const nodes = buildOutline({ items, infos, toks, src, warn });
    if (hp && !isPrimary) {
      const first = toks[0] as Token;
      outline.push({
        kind: 'OTHER', startLine: first.line, endLine: b.endLine, text: firstLineText(src, toks, 0, Math.max(1, bodyStart)),
        summary: `${hp.header.kind === 'PROCEDURE' ? 'CREATE PROCEDURE' : 'CREATE ' + hp.header.kind} ${prettyName(hp.header.ref)} (additional module)`,
        targets: [hp.header.ref.key], children: nodes,
      });
    } else outline.push(...nodes);
  }

  r.header = header;
  r.tables = tables.list();
  r.tempTables = temps.list();
  r.procCalls = procCalls;
  r.functionCalls = functionCalls;
  r.sequences = sequences;
  r.dynamicSql = dynamicSql;
  r.gotoLabels = labels;
  r.outline = outline;
  r.linkedServers = linkedServers;

  const cross = new Map<string, ObjectRef>();
  const linked = new Map<string, ObjectRef>();
  const consider = (ref: ObjectRef): void => {
    if (ref.database !== null && !cross.has(ref.key)) cross.set(ref.key, ref);
    if (ref.server !== null && !linked.has(ref.key)) linked.set(ref.key, ref);
  };
  for (const t of r.tables) consider(t.ref);
  for (const t of r.tempTables) consider(t.ref);
  for (const c of procCalls) consider(c.ref);
  for (const f of functionCalls) consider(f.ref);
  for (const q of sequences) consider(q.ref);
  if (header) { consider(header.ref); if (header.triggerTable) consider(header.triggerTable); }
  r.crossDatabaseRefs = [...cross.values()];
  r.linkedServerRefs = [...linked.values()];

  r.stats = { lines, statements, batches: batches.length, durationMs: now() - t0 };
  return r;
}
