// Per-statement extraction: table reads/writes (with a per-statement alias map to resolve
// write targets), procedure calls, function calls, sequences, dynamic SQL, CTEs, cursors.

import type { Token } from './tokenizer';
import type { CallArg, DynamicSql, DynamicSqlKind, FunctionCall, ObjectRef, ProcCall, SequenceRef, TableOp } from './types';
import type { SegItem } from './segmenter';
import { NON_ALIAS, RESERVED, isNamePart, isWord, joinTokens, makeRef, readName, skipParens, sliceSrc, truncate, type NameRead, type Warn } from './common';

export interface ExtractContext {
  src: string;
  toks: Token[];
  defaultSchema: string;
  warn: Warn;
  inTrigger: boolean;
}

export interface ResolvedAccess { ref: ObjectRef; op: TableOp; alias: string | null; temp: boolean }

export interface StmtInfo {
  accesses: ResolvedAccess[];
  calls: ProcCall[];
  functions: FunctionCall[];
  sequences: SequenceRef[];
  dynamic: DynamicSql[];
  ctes: Array<{ name: string; line: number; base: string | null }>;
  tableVariables: Array<{ name: string; line: number }>;
  cursor: { name: string; line: number } | null;
  linkedServers: string[];
  // summary helpers
  target: { display: string; alias: string | null; viaCte: string | null; baseDisplay: string | null; tableVar: boolean } | null;
  extraTargets: string[];          // further DROP TABLE targets
  setColumns: string[];
  insertColumns: number | null;
  insertSource: 'VALUES' | 'SELECT' | 'EXEC' | 'DEFAULT' | null;
  selectInto: string | null;
  outputInto: string[];
  assignedVars: string[];
  declared: Array<{ name: string; type: string }>;
  mergeActions: string[];
  tableVarReads: string[];         // table variables read in FROM/JOIN (for summaries)
}

type OccClass = 'table' | 'temp' | 'tablevar' | 'cte' | 'pseudo';
interface Occ {
  parts: string[];
  display: string;
  cls: OccClass;
  op: TableOp;
  alias: string | null;
  tok: number;
  depth: number;
  inFrom: boolean;
  consumed: boolean;
}

const ROWSET_BUILTINS = new Set(['OPENQUERY', 'OPENROWSET', 'OPENDATASOURCE', 'OPENJSON', 'OPENXML', 'STRING_SPLIT', 'GENERATE_SERIES',
  'CHANGETABLE', 'CONTAINSTABLE', 'FREETEXTTABLE', 'PREDICT', 'SEMANTICKEYPHRASETABLE', 'SEMANTICSIMILARITYTABLE',
  'SEMANTICSIMILARITYDETAILSTABLE']);
const HINTS = new Set(['NOLOCK', 'READUNCOMMITTED', 'UPDLOCK', 'ROWLOCK', 'HOLDLOCK', 'READPAST', 'TABLOCK', 'TABLOCKX', 'XLOCK',
  'PAGLOCK', 'NOWAIT', 'SERIALIZABLE', 'REPEATABLEREAD', 'READCOMMITTED', 'READCOMMITTEDLOCK', 'INDEX', 'FORCESEEK', 'FORCESCAN',
  'SNAPSHOT', 'NOEXPAND', 'KEEPIDENTITY', 'KEEPDEFAULTS', 'IGNORE_CONSTRAINTS', 'IGNORE_TRIGGERS', 'SPATIAL_WINDOW_MAX_CELLS']);
const XML_METHODS = new Set(['value', 'query', 'exist', 'nodes', 'modify', 'write']);
const FROM_LIST_END = new Set(['WHERE', 'GROUP', 'HAVING', 'ORDER', 'UNION', 'EXCEPT', 'INTERSECT', 'OPTION', 'FOR', 'WINDOW', 'VALUES', 'SET', 'WHEN']);
const NOT_FUNC_PREV = new Set(['FROM', 'JOIN', 'APPLY', 'INTO', 'UPDATE', 'TABLE', 'EXEC', 'EXECUTE', 'MERGE', 'USING', 'INSERT',
  'DELETE', 'REFERENCES', 'TRUNCATE', 'VIEW', 'PROC', 'PROCEDURE', 'FUNCTION', 'TRIGGER', 'TYPE', 'RETURNS']);
const NO_SCAN_VERBS = new Set(['EXEC', 'GRANT', 'REVOKE', 'DENY', 'USE', 'GOTO', 'OPEN', 'CLOSE', 'DEALLOCATE', 'FETCH', 'BREAK',
  'CONTINUE', 'LABEL', 'DBCC', 'KILL', 'CHECKPOINT', 'RECONFIGURE', 'SHUTDOWN', 'BACKUP', 'RESTORE', 'REVERT', 'SETUSER', 'ELSE',
  'BEGIN', 'END', 'COMMIT', 'ROLLBACK', 'SAVE']);

export function emptyInfo(): StmtInfo {
  return { accesses: [], calls: [], functions: [], sequences: [], dynamic: [], ctes: [], tableVariables: [], cursor: null, linkedServers: [],
    target: null, extraTargets: [], setColumns: [], insertColumns: null, insertSource: null, selectInto: null, outputInto: [],
    assignedVars: [], declared: [], mergeActions: [], tableVarReads: [] };
}

export function extractStatement(ctx: ExtractContext, item: SegItem): StmtInfo {
  const info = emptyInfo();
  const { toks, src } = ctx;
  const kind = item.kind;
  if (kind === 'BEGIN' || kind === 'END' || kind === 'BEGIN_TRY' || kind === 'END_TRY' || kind === 'BEGIN_CATCH' ||
    kind === 'END_CATCH' || kind === 'ELSE' || kind === 'LABEL') return info;
  const s = item.start;
  const e = Math.min(item.end, toks.length);
  const line = (toks[s] as Token).line;
  const m = item.mainIndex;
  const verbTok = toks[m] as Token;
  const verb = kind === 'IF' || kind === 'WHILE' ? 'COND' : (verbTok.upper === 'EXECUTE' ? 'EXEC' : verbTok.upper);
  const isSelectMain = verb === 'SELECT';

  const occs: Occ[] = [];
  const aliases = new Map<string, Occ[]>();
  const setAlias = (alias: string, occ: Occ): void => {
    const up = alias.toUpperCase();
    const list = aliases.get(up);
    if (list) list.push(occ); else aliases.set(up, [occ]);
  };
  const getAlias = (up: string): Occ | undefined => {
    const list = aliases.get(up);
    return list ? (list.find(o => o.depth === 0) ?? list[0]) : undefined;
  };
  const cteBodies = new Map<string, { name: string; open: number; close: number }>();
  const skipFunc = new Set<number>();
  const dynAt = new Set<number>();
  const funcCandidates: Array<{ nm: NameRead; tok: number }> = [];

  const nameDisplay = (nm: NameRead): string => sliceSrc(src, toks, nm.start, nm.last);
  const classOf = (parts: string[], t: Token): OccClass => {
    const last = parts[parts.length - 1] ?? '';
    if (last.startsWith('#')) return 'temp';
    if (parts.length === 1 && cteBodies.has(last.toUpperCase())) return 'cte';
    if (parts.length === 1 && ctx.inTrigger && !t.quoted && (t.upper === 'INSERTED' || t.upper === 'DELETED')) return 'pseudo';
    return 'table';
  };
  const depthAt = (idx: number): number => {
    let d = 0;
    for (let k = s; k < idx && k < e; k++) {
      const t = toks[k] as Token;
      if (t.type === '(') d++; else if (t.type === ')' && d > 0) d--;
    }
    return d;
  };
  const addOcc = (nm: NameRead, op: TableOp, inFrom: boolean, depth: number): Occ => {
    const first = toks[nm.start] as Token;
    const o: Occ = { parts: nm.parts, display: nameDisplay(nm), cls: classOf(nm.parts, first), op, alias: null, tok: nm.start, depth, inFrom, consumed: false };
    occs.push(o);
    skipFunc.add(nm.start);
    return o;
  };
  const addVarOcc = (t: Token, idx: number, op: TableOp, inFrom: boolean, depth: number): Occ => {
    const o: Occ = { parts: [t.value], display: t.value, cls: 'tablevar', op, alias: null, tok: idx, depth, inFrom, consumed: false };
    occs.push(o);
    return o;
  };
  const addDynamic = (k: DynamicSqlKind, idx: number, snippetEnd: number): void => {
    if (dynAt.has(idx)) return;
    dynAt.add(idx);
    const a = toks[idx] as Token;
    const endTok = toks[Math.max(idx, Math.min(snippetEnd, e) - 1)] as Token;
    info.dynamic.push({ line: a.line, kind: k, snippet: truncate(src.slice(a.start, endTok.end), 200) });
  };
  const addLinked = (name: string | undefined): void => {
    if (name && !info.linkedServers.includes(name)) info.linkedServers.push(name);
  };

  // ---- CTE list (WITH a AS (…), b AS (…) <main>)
  if (kind === 'WITH_CTE' || (verb === 'WITH' && kind === 'OTHER')) {
    let j = s + 1;
    for (let guard = 0; guard < 1000 && j < m; guard++) {
      if (isWord(toks[j], 'XMLNAMESPACES')) { j++; if (toks[j]?.type === '(') j = skipParens(toks, j, e); }
      else {
        const nt = toks[j] as Token;
        j++;
        if (toks[j]?.type === '(') j = skipParens(toks, j, e);
        if (isWord(toks[j], 'AS')) j++;
        if (toks[j]?.type === '(') {
          const close = skipParens(toks, j, e) - 1;
          cteBodies.set(nt.name.toUpperCase(), { name: nt.name, open: j, close });
          info.ctes.push({ name: nt.name, line: nt.line, base: null });
          j = close + 1;
        }
      }
      if (toks[j]?.type === ',') { j++; continue; }
      break;
    }
  }

  // ---- statement-specific write target
  let targetOcc: Occ | null = null;
  let targetOp: TableOp | null = null;
  let deleteFromIdx = -1;
  let insertIntoIdx = -1;
  let bulk = false;
  const skipTop = (j: number): number => {
    if (isWord(toks[j], 'TOP')) {
      j++;
      if (toks[j]?.type === '(') j = skipParens(toks, j, e); else j++;
      if (isWord(toks[j], 'PERCENT')) j++;
    }
    return j;
  };
  const targetAt = (j: number, op: TableOp): number => {
    const t = toks[j];
    if (!t || j >= e) return j;
    if (t.type === 'variable') { targetOcc = addVarOcc(t, j, op, false, 0); targetOp = op; return j + 1; }
    if (isWord(t) && ROWSET_BUILTINS.has(t.upper) && toks[j + 1]?.type === '(') return j; // INSERT INTO OPENQUERY(…) — generic scan flags it
    if (isWord(t) && RESERVED.has(t.upper)) return j;
    const nm = readName(toks, j, e);
    if (!nm.parts.length) return j;
    targetOcc = addOcc(nm, op, false, 0);
    targetOp = op;
    return nm.next;
  };

  if (verb === 'INSERT' || verb === 'BULK') {
    let j = m + 1;
    if (verb === 'BULK') { bulk = true; if (isWord(toks[j], 'INSERT')) j++; j = targetAt(j, 'INSERT'); }
    else {
      j = skipTop(j);
      if (isWord(toks[j], 'INTO')) { insertIntoIdx = j; j++; }
      j = targetAt(j, 'INSERT');
      if (isWord(toks[j], 'WITH') && toks[j + 1]?.type === '(') j = skipParens(toks, j + 1, e);
      if (toks[j]?.type === '(' && !isWord(toks[j + 1], 'SELECT')) {
        const close = skipParens(toks, j, e);
        let cols = 1;
        let d = 0;
        for (let k = j + 1; k < close - 1; k++) {
          const t = toks[k] as Token;
          if (t.type === '(') d++; else if (t.type === ')') d--; else if (t.type === ',' && d === 0) cols++;
        }
        info.insertColumns = close - 1 > j + 1 ? cols : 0;
        j = close;
      }
      let d = 0;
      for (let k = j; k < e; k++) {
        const t = toks[k] as Token;
        if (t.type === '(') { d++; if (d === 1 && isWord(toks[k + 1], 'SELECT') && !info.insertSource) info.insertSource = 'SELECT'; continue; }
        if (t.type === ')') { d--; continue; }
        if (d > 0) continue;
        if (isWord(t, 'VALUES')) { info.insertSource = 'VALUES'; break; }
        if (isWord(t, 'SELECT') || isWord(t, 'WITH')) { info.insertSource = 'SELECT'; break; }
        if (isWord(t, 'EXEC', 'EXECUTE')) { info.insertSource = 'EXEC'; break; }
        if (isWord(t, 'DEFAULT') && isWord(toks[k + 1], 'VALUES')) { info.insertSource = 'DEFAULT'; break; }
      }
    }
  } else if (verb === 'UPDATE' && kind !== 'OTHER') {
    targetAt(skipTop(m + 1), 'UPDATE');
  } else if (verb === 'DELETE') {
    let j = skipTop(m + 1);
    if (isWord(toks[j], 'FROM')) { deleteFromIdx = j; j++; }
    targetAt(j, 'DELETE');
  } else if (verb === 'MERGE') {
    let j = skipTop(m + 1);
    if (isWord(toks[j], 'INTO')) { insertIntoIdx = j; j++; }
    j = targetAt(j, 'MERGE');
    if (isWord(toks[j], 'WITH') && toks[j + 1]?.type === '(') j = skipParens(toks, j + 1, e);
    const occ = targetOcc as Occ | null;
    if (occ) {
      let alias: string | null = null;
      if (isWord(toks[j], 'AS') && toks[j + 1]) alias = (toks[j + 1] as Token).name;
      else if (isAliasTok(toks[j])) alias = (toks[j] as Token).name;
      if (alias) { occ.alias = alias; setAlias(alias, occ); }
    }
    for (let k = m; k < e - 1; k++) {
      if (isWord(toks[k], 'THEN')) {
        const a = toks[k + 1] as Token;
        if (isWord(a, 'UPDATE', 'INSERT', 'DELETE') && !info.mergeActions.includes(a.upper)) info.mergeActions.push(a.upper);
      }
    }
  } else if (verb === 'TRUNCATE') {
    let j = m + 1;
    if (isWord(toks[j], 'TABLE')) j++;
    targetAt(j, 'TRUNCATE');
  } else if (kind === 'CREATE_TABLE') {
    targetAt(m + 2, 'CREATE');
  } else if (kind === 'ALTER_TABLE') {
    targetAt(m + 2, 'ALTER');
  } else if (kind === 'CREATE_INDEX') {
    for (let k = m + 1; k < e; k++) if (isWord(toks[k], 'ON')) { targetAt(k + 1, 'ALTER'); break; }
  } else if (kind === 'DROP_TABLE') {
    let j = m + 2;
    if (isWord(toks[j], 'IF') && isWord(toks[j + 1], 'EXISTS')) j += 2;
    j = targetAt(j, 'DROP');
    while (toks[j]?.type === ',' && j < e) {
      const nm = readName(toks, j + 1, e);
      if (!nm.parts.length) break;
      const o = addOcc(nm, 'DROP', false, 0);
      info.extraTargets.push(o.display);
      j = nm.next;
    }
  } else if (kind === 'DECLARE' || kind === 'CURSOR') {
    parseDeclare(ctx, s, e, info);
  }

  // ---- generic scan: FROM/JOIN/APPLY sources, INTO, OUTPUT INTO, functions, sequences, OPEN* rowsets
  const isAliasTokLocal = isAliasTok;
  const readAlias = (k: number, occ: Occ | null): number => {
    if (isWord(toks[k], 'FOR') && isWord(toks[k + 1], 'SYSTEM_TIME')) k = skipSystemTime(toks, k + 2, e);
    let alias: string | null = null;
    if (isWord(toks[k], 'AS') && (toks[k + 1]?.type === 'ident' || toks[k + 1]?.type === 'word')) { alias = (toks[k + 1] as Token).name; k += 2; }
    else if (isAliasTokLocal(toks[k])) { alias = (toks[k] as Token).name; k++; }
    if (alias && occ) { occ.alias = alias; setAlias(alias, occ); }
    if (alias && !occ && toks[k]?.type === '(') k = skipParens(toks, k, e);            // v(c1, c2) column aliases
    if (toks[k]?.type === '(' && isLegacyHint(toks, k)) k = skipParens(toks, k, e);    // t x (NOLOCK)
    if (isWord(toks[k], 'WITH') && toks[k + 1]?.type === '(') k = skipParens(toks, k + 1, e);
    return k;
  };
  const readSource = (j: number, depth: number): number => {
    const t = toks[j];
    if (!t || j >= e) return j;
    if (t.type === '(') return j;
    if (t.type === 'variable') {
      if (toks[j + 1]?.type === '.') return j;
      const o = addVarOcc(t, j, 'SELECT', true, depth);
      return readAlias(j + 1, o);
    }
    if (t.type === 'word' && ROWSET_BUILTINS.has(t.upper) && toks[j + 1]?.type === '(') {
      let k = skipParens(toks, j + 1, e);
      flagRowset(j, k);
      if (t.upper === 'OPENDATASOURCE' && toks[k]?.type === '.') {
        const nm = readName(toks, k + 1, e);
        k = nm.parts.length ? nm.next : k;
        if (nm.parts.length) skipFunc.add(k);
      }
      return readAlias(k, null);
    }
    if (t.type === 'word' && RESERVED.has(t.upper)) return j;
    if (!isNamePart(t)) return j;
    const nm = readName(toks, j, e);
    const k = nm.next;
    if (toks[k]?.type === '(') {
      if (isLegacyHint(toks, k)) {
        const o = addOcc(nm, 'SELECT', true, depth);
        return readAlias(skipParens(toks, k, e), o);
      }
      const lastPart = (nm.parts[nm.parts.length - 1] ?? '').toLowerCase();
      skipFunc.add(nm.start);
      if (nm.parts.length >= 2 && XML_METHODS.has(lastPart)) return k;               // t.col.nodes('…')
      info.functions.push({ ref: makeRef(nm.parts, nameDisplay(nm), ctx.defaultSchema), line: (toks[nm.start] as Token).line, kind: 'table-valued' });
      return k;
    }
    const o = addOcc(nm, 'SELECT', true, depth);
    return readAlias(k, o);
  };
  const flagRowset = (j: number, closeExcl: number): void => {
    const u = (toks[j] as Token).upper;
    if (u === 'OPENQUERY' || u === 'OPENROWSET' || u === 'OPENDATASOURCE') {
      addDynamic(u as DynamicSqlKind, j, closeExcl);
      if (u === 'OPENQUERY') { const srv = toks[j + 2]; if (isNamePart(srv)) addLinked(srv.name); }
    }
  };

  if (!NO_SCAN_VERBS.has(verb) && !(kind === 'OTHER' && (verb === 'GRANT' || verb === 'REVOKE' || verb === 'DENY'))) {
    const scanStart = kind === 'IF' || kind === 'WHILE' ? s + 1 : s;
    let depth = 0;
    const fromList: boolean[] = [false];
    const parenPrev: Array<Token | undefined> = [];
    let outputActive = false;
    for (let j = scanStart; j < e; j++) {
      const t = toks[j] as Token;
      const prev = toks[j - 1];
      if (t.type === '(') { parenPrev.push(prev); depth++; fromList[depth] = false; continue; }
      if (t.type === ')') { if (depth > 0) { fromList[depth] = false; depth--; parenPrev.pop(); } continue; }
      if (t.type === ',') { if (fromList[depth]) j = readSource(j + 1, depth) - 1; continue; }
      if (t.type === 'variable') {
        if (toks[j + 1]?.type === '.') { const nm = readName(toks, j + 2, e); j = nm.parts.length ? nm.next - 1 : j + 1; }
        continue;
      }
      if (t.type !== 'word' && t.type !== 'ident') continue;
      if (prev?.type === '.') continue;
      if (t.type === 'word') {
        const u = t.upper;
        if (u === 'FROM') {
          const encl = parenPrev[parenPrev.length - 1];
          if (j === deleteFromIdx || bulk || isWord(prev, 'DISTINCT') || isWord(encl, 'TRIM')) continue;
          fromList[depth] = true;
          j = readSource(j + 1, depth) - 1;
          continue;
        }
        if (u === 'JOIN') { j = readSource(j + 1, depth) - 1; continue; }
        if (u === 'APPLY' && isWord(prev, 'CROSS', 'OUTER')) { j = readSource(j + 1, depth) - 1; continue; }
        if (u === 'USING' && verb === 'MERGE' && depth === 0) { j = readSource(j + 1, depth) - 1; continue; }
        if (FROM_LIST_END.has(u)) { fromList[depth] = false; if (u === 'FOR' && isWord(toks[j + 1], 'SYSTEM_TIME')) j++; continue; }
        if (u === 'OUTPUT' && (verb === 'INSERT' || verb === 'UPDATE' || verb === 'DELETE' || verb === 'MERGE')) { outputActive = true; fromList[depth] = false; continue; }
        if (u === 'INTO') {
          if (j === insertIntoIdx || isWord(prev, 'INSERT', 'MERGE')) continue;
          const nt = toks[j + 1];
          if (outputActive) {
            outputActive = false;
            if (nt?.type === 'variable') { addVarOcc(nt, j + 1, 'INSERT', false, depth); info.outputInto.push(nt.value); j++; continue; }
            const nm = readName(toks, j + 1, e);
            if (nm.parts.length) { const o = addOcc(nm, 'INSERT', false, depth); info.outputInto.push(o.display); j = nm.next - 1; }
            continue;
          }
          if (isSelectMain && depth === 0) {
            const nm = readName(toks, j + 1, e);
            if (nm.parts.length) { const o = addOcc(nm, 'SELECT_INTO', false, depth); info.selectInto = o.display; j = nm.next - 1; }
          }
          continue;
        }
        if (u === 'NEXT' && isWord(toks[j + 1], 'VALUE') && isWord(toks[j + 2], 'FOR')) {
          const nm = readName(toks, j + 3, e);
          if (nm.parts.length) {
            info.sequences.push({ ref: makeRef(nm.parts, nameDisplay(nm), ctx.defaultSchema), line: t.line });
            skipFunc.add(nm.start);
            j = nm.next - 1;
          }
          continue;
        }
        if ((u === 'OPENQUERY' || u === 'OPENROWSET' || u === 'OPENDATASOURCE') && toks[j + 1]?.type === '(') {
          flagRowset(j, skipParens(toks, j + 1, e));
          continue;
        }
        if ((u === 'EXEC' || u === 'EXECUTE') && verb === 'INSERT' && j > m) {
          parseExec(ctx, j, e, true, info, addDynamic, addLinked);
          break;
        }
      }
      // schema.fn( — scalar UDF candidates (filtered after the scan against aliases)
      if (toks[j + 1]?.type === '.' && !skipFunc.has(j)) {
        const nm = readName(toks, j, e);
        if (nm.parts.length >= 2 && toks[nm.next]?.type === '(' && !(prev && prev.type === 'word' && NOT_FUNC_PREV.has(prev.upper)) &&
          !(kind === 'CREATE_INDEX' && isWord(prev, 'ON'))) {
          funcCandidates.push({ nm, tok: j });
        }
        j = Math.max(j, nm.next - 1);
      }
    }
  }

  if (verb === 'EXEC' && kind === 'EXEC') parseExec(ctx, m, e, false, info, addDynamic, addLinked);

  // ---- scalar function candidates: drop alias.col.method( and alias.method(
  const tableNames = new Set<string>();
  for (const o of occs) { const last = o.parts[o.parts.length - 1]; if (last) tableNames.add(last.toUpperCase()); }
  for (const c of funcCandidates) {
    const first = (c.nm.parts[0] ?? '').toUpperCase();
    const lastPart = (c.nm.parts[c.nm.parts.length - 1] ?? '').toLowerCase();
    if (aliases.has(first) || cteBodies.has(first)) continue;
    if (XML_METHODS.has(lastPart)) continue;
    if (c.nm.parts.length >= 3 && tableNames.has((c.nm.parts[c.nm.parts.length - 3] ?? '').toUpperCase())) continue;
    info.functions.push({ ref: makeRef(c.nm.parts, nameDisplay(c.nm), ctx.defaultSchema), line: (toks[c.tok] as Token).line, kind: 'scalar' });
  }

  // ---- CTE base tables (single top-level FROM source inside the CTE body)
  const cteBase = (name: string, guard: number): Occ | null => {
    const body = cteBodies.get(name.toUpperCase());
    if (!body || guard > 20) return null;
    const bodyDepth = depthAt(body.open) + 1;
    const cands = occs.filter(o => o.inFrom && o.tok > body.open && o.tok < body.close && o.depth === bodyDepth && o.cls !== 'pseudo');
    const keys = new Set(cands.map(o => o.parts.join('.').toLowerCase()));
    if (keys.size !== 1) return null;
    const c = cands[0] as Occ;
    if (c.cls === 'cte') return cteBase(c.parts[0] as string, guard + 1);
    return c;
  };
  for (const c of info.ctes) { const b = cteBase(c.name, 0); c.base = b && b.cls !== 'tablevar' ? b.display : null; }

  // ---- resolve the write target through aliases / CTEs
  const tOcc = targetOcc as Occ | null;
  const tOp = targetOp as TableOp | null;
  const writes: Array<{ occ: Occ; op: TableOp }> = [];
  if (tOcc && tOp) {
    info.target = { display: tOcc.display, alias: tOcc.alias, viaCte: null, baseDisplay: null, tableVar: tOcc.cls === 'tablevar' };
    if (tOcc.cls !== 'tablevar') {
      tOcc.consumed = true; // replaced by the resolved write below
      let resolved: Occ | null = tOcc;
      if (tOcc.parts.length === 1) {
        const up = (tOcc.parts[0] as string).toUpperCase();
        const a = getAlias(up);
        if (a && a !== tOcc) {
          resolved = a;
          info.target.alias = a.alias;
          if (a.cls === 'cte') resolved = resolveCte(a.parts[0] as string);
        } else if (tOcc.cls === 'cte') {
          resolved = resolveCte(tOcc.parts[0] as string);
        }
      }
      if (resolved && resolved !== tOcc && resolved.cls !== 'tablevar') {
        resolved.consumed = true;
        info.target.baseDisplay = resolved.display;
        writes.push({ occ: resolved, op: tOp });
      } else if (resolved === tOcc) {
        // UPDATE dbo.T … FROM dbo.T JOIN … : the unaliased FROM entry is the same instance
        const key = tOcc.parts.join('.').toLowerCase();
        const same = occs.find(o => o !== tOcc && o.inFrom && !o.alias && o.depth === 0 && o.parts.join('.').toLowerCase() === key);
        if (same) same.consumed = true;
        writes.push({ occ: tOcc, op: tOp });
      } else if (resolved && resolved.cls === 'tablevar') {
        info.target.tableVar = true;
      }
    }
  }
  function resolveCte(name: string): Occ | null {
    const b = cteBase(name, 0);
    if (info.target) info.target.viaCte = cteBodies.get(name.toUpperCase())?.name ?? name;
    if (!b) ctx.warn(line, `Write through CTE ${name} could not be mapped to a single base table`);
    return b;
  }

  // ---- table variables seen in this statement's target / sources are not tables
  const pushAccess = (o: Occ, op: TableOp): void => {
    if (o.cls !== 'table' && o.cls !== 'temp') return;
    const ref = makeRef(o.parts, o.display, ctx.defaultSchema);
    info.accesses.push({ ref, op, alias: o.alias, temp: o.cls === 'temp' });
    if (ref.server) addLinked(ref.server);
  };
  for (const w of writes) {
    if (w.op === 'INSERT' && info.insertSource === 'EXEC') pushAccess(w.occ, 'INSERT_EXEC');
    else pushAccess(w.occ, w.op);
  }
  for (const o of occs) {
    if (!o.consumed) pushAccess(o, o.op);
    if (o.cls === 'tablevar' && o.inFrom && !info.tableVarReads.includes(o.display)) info.tableVarReads.push(o.display);
  }

  // ---- summary helpers
  if (verb === 'UPDATE' && kind !== 'OTHER') info.setColumns = updateSetColumns(toks, m, e);
  if (isSelectMain || kind === 'SELECT') info.assignedVars = selectAssignedVars(toks, m, e);
  return info;
}

function isAliasTok(t: Token | undefined): boolean {
  return !!t && ((t.type === 'ident') || (t.type === 'word' && !NON_ALIAS.has(t.upper)));
}

function isLegacyHint(toks: Token[], k: number): boolean {
  const a = toks[k + 1];
  const b = toks[k + 2];
  if (!a || a.type !== 'word' || !HINTS.has(a.upper)) return false;
  return !!b && (b.type === ')' || b.type === ',' || b.type === '(' || (b.type === 'op' && b.value === '='));
}

function skipSystemTime(toks: Token[], k: number, e: number): number {
  const skipValue = (j: number): number => {
    if (isNamePart(toks[j]) && toks[j + 1]?.type === '(') return skipParens(toks, j + 1, e);
    return j + 1;
  };
  if (isWord(toks[k], 'ALL')) return k + 1;
  if (isWord(toks[k], 'AS') && isWord(toks[k + 1], 'OF')) return skipValue(k + 2);
  if (isWord(toks[k], 'FROM')) { const a = skipValue(k + 1); return isWord(toks[a], 'TO') ? skipValue(a + 1) : a; }
  if (isWord(toks[k], 'BETWEEN')) { const a = skipValue(k + 1); return isWord(toks[a], 'AND') ? skipValue(a + 1) : a; }
  if (isWord(toks[k], 'CONTAINED') && isWord(toks[k + 1], 'IN') && toks[k + 2]?.type === '(') return skipParens(toks, k + 2, e);
  return k;
}

function parseExec(ctx: ExtractContext, i: number, e: number, viaInsertExec: boolean, info: StmtInfo,
  addDynamic: (k: DynamicSqlKind, idx: number, end: number) => void, addLinked: (n: string | undefined) => void): void {
  const { toks, src } = ctx;
  let k = i + 1;
  const execTok = toks[i] as Token;
  let stop = e;
  if (toks[stop - 1]?.type === ';') stop--;
  if (toks[k]?.type === '(') {
    let p = skipParens(toks, k, e);
    if (isWord(toks[p], 'AS') && isWord(toks[p + 1], 'LOGIN', 'USER')) p += 4;
    if (isWord(toks[p], 'AT')) {
      let srv = toks[p + 1];
      if (isWord(srv, 'DATA_SOURCE')) srv = toks[p + 2];
      addDynamic('EXEC_AT', i, stop);
      if (isNamePart(srv) && !isWord(toks[p + 1], 'DATA_SOURCE')) addLinked(srv.name);
    } else addDynamic('EXEC_STRING', i, stop);
    return;
  }
  if (isWord(toks[k], 'AS')) return; // EXECUTE AS USER/LOGIN/CALLER
  let returnVar: string | null = null;
  if (toks[k]?.type === 'variable' && toks[k + 1]?.type === 'op' && toks[k + 1]?.value === '=') { returnVar = (toks[k] as Token).value; k += 2; }
  if (toks[k]?.type === 'variable') { addDynamic('EXEC_PROC_VARIABLE', i, stop); return; }
  const nm = readName(toks, k, stop);
  if (!nm.parts.length) return;
  const ref = makeRef(nm.parts, sliceSrc(src, toks, nm.start, nm.last), ctx.defaultSchema);
  let a = nm.next;
  if (toks[a]?.type === ';' && toks[a + 1]?.type === 'number') a += 2;
  // arguments, up to WITH RECOMPILE / WITH RESULT SETS
  let argEnd = stop;
  let d = 0;
  for (let q = a; q < stop; q++) {
    const t = toks[q] as Token;
    if (t.type === '(') d++; else if (t.type === ')') d--;
    else if (d === 0 && isWord(t, 'WITH')) { argEnd = q; break; }
  }
  const args: CallArg[] = [];
  let cur: number[] = [];
  d = 0;
  const flush = (): void => {
    if (!cur.length) return;
    const first = toks[cur[0] as number] as Token;
    const second = toks[(cur[0] as number) + 1];
    let vs = cur[0] as number;
    let name: string | null = null;
    if (first.type === 'variable' && cur.length >= 2 && second?.type === 'op' && second.value === '=') { name = first.value; vs = (cur[0] as number) + 2; }
    let ve = (cur[cur.length - 1] as number) + 1;
    let isOutput = false;
    if (ve - 1 >= vs && isWord(toks[ve - 1], 'OUTPUT', 'OUT')) { isOutput = true; ve--; }
    args.push({ name, value: truncate(joinTokens(toks, vs, ve), 200), isOutput });
    cur = [];
  };
  for (let q = a; q < argEnd; q++) {
    const t = toks[q] as Token;
    if (t.type === '(') d++; else if (t.type === ')') d--;
    if (t.type === ',' && d === 0) { flush(); continue; }
    cur.push(q);
  }
  flush();
  const lastLower = ref.name.toLowerCase();
  const schemaLower = (ref.schema ?? '').toLowerCase();
  const isSystem = lastLower.startsWith('sp_') || schemaLower === 'sys';
  if (lastLower === 'sp_executesql' || lastLower === 'sp_sqlexec') addDynamic('SP_EXECUTESQL', i, stop);
  if (ref.server) addLinked(ref.server);
  info.calls.push({ ref, line: execTok.line, returnVar, args, isSystem, viaInsertExec });
}

function parseDeclare(ctx: ExtractContext, s: number, e: number, info: StmtInfo): void {
  const { toks, src } = ctx;
  const n1 = toks[s + 1];
  if (n1 && n1.type !== 'variable') {
    for (let k = s + 2; k < Math.min(e, s + 5); k++) {
      if (isWord(toks[k], 'CURSOR')) { info.cursor = { name: n1.name, line: n1.line }; return; }
    }
  }
  let j = s + 1;
  while (j < e) {
    const v = toks[j];
    if (!v || v.type !== 'variable') break;
    j++;
    if (isWord(toks[j], 'AS')) j++;
    const ts = j;
    let d = 0;
    while (j < e) {
      const t = toks[j] as Token;
      if (t.type === '(') d++;
      else if (t.type === ')') d--;
      else if (d === 0 && (t.type === ',' || t.type === ';' || (t.type === 'op' && t.value === '='))) break;
      j++;
    }
    const typeEnd = j;
    if (isWord(toks[ts], 'TABLE')) {
      info.tableVariables.push({ name: v.value, line: v.line });
      info.declared.push({ name: v.value, type: 'TABLE' });
    } else if (isWord(toks[ts], 'CURSOR')) {
      info.cursor = { name: v.value, line: v.line };
      info.declared.push({ name: v.value, type: 'CURSOR' });
    } else {
      info.declared.push({ name: v.value, type: typeEnd > ts ? truncate(sliceSrc(src, toks, ts, typeEnd - 1), 60) : '' });
    }
    if (toks[j]?.type === 'op' && (toks[j] as Token).value === '=') {
      j++;
      d = 0;
      while (j < e) {
        const t = toks[j] as Token;
        if (t.type === '(') d++;
        else if (t.type === ')') d--;
        else if (d === 0 && (t.type === ',' || t.type === ';')) break;
        j++;
      }
    }
    if (toks[j]?.type === ',') { j++; continue; }
    break;
  }
}

function updateSetColumns(toks: Token[], m: number, e: number): string[] {
  let d = 0;
  let setIdx = -1;
  for (let k = m + 1; k < e; k++) {
    const t = toks[k] as Token;
    if (t.type === '(') d++; else if (t.type === ')') d--;
    else if (d === 0 && isWord(t, 'SET')) { setIdx = k; break; }
  }
  if (setIdx < 0) return [];
  const cols: string[] = [];
  let segStart = setIdx + 1;
  d = 0;
  const take = (a: number, b: number): void => {
    // left side of the first '=' (or compound op); `@v = col = expr` assigns col
    let k = a;
    if (toks[k]?.type === 'variable' && toks[k + 1]?.type === 'op' && toks[k + 1]?.value === '=' && isNamePart(toks[k + 2])) k += 2;
    if (!isNamePart(toks[k])) return;
    const nm = readName(toks, k, b);
    let parts = nm.parts;
    if (parts.length >= 2 && (parts[parts.length - 1] ?? '').toLowerCase() === 'write' && toks[nm.next]?.type === '(') parts = parts.slice(0, -1);
    const col = parts[parts.length - 1];
    if (col && !cols.includes(col)) cols.push(col);
  };
  let k = segStart;
  for (; k < e; k++) {
    const t = toks[k] as Token;
    if (t.type === '(') { d++; continue; }
    if (t.type === ')') { d--; continue; }
    if (d > 0) continue;
    if (t.type === ',') { take(segStart, k); segStart = k + 1; continue; }
    if (t.type === ';' || isWord(t, 'FROM', 'WHERE', 'OUTPUT', 'OPTION')) break;
  }
  take(segStart, k);
  return cols;
}

function selectAssignedVars(toks: Token[], m: number, e: number): string[] {
  const vars: string[] = [];
  let d = 0;
  let k = m + 1;
  for (; k < e; k++) {
    const t = toks[k] as Token;
    if (t.type === '(') { d++; continue; }
    if (t.type === ')') { d--; continue; }
    if (d > 0) continue;
    if (isWord(t, 'FROM', 'INTO', 'WHERE', 'UNION', 'ORDER', 'GROUP', 'OPTION', 'FOR')) break;
    if (t.type === 'variable' && (toks[k - 1]?.type === ',' || isWord(toks[k - 1], 'SELECT', 'DISTINCT') || toks[k - 1]?.type === ')' || toks[k - 1]?.type === 'number' || isWord(toks[k - 1], 'PERCENT', 'TIES'))) {
      const nx = toks[k + 1];
      if (nx && nx.type === 'op' && (nx.value === '=' || nx.value.endsWith('='))) vars.push(t.value);
    }
  }
  return vars;
}
