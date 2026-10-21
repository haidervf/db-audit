// Statement segmentation. A statement starts at a statement keyword at paren depth 0
// (outside CASE … END) and runs until the next such keyword or ';', with continuation
// rules for keywords that are part of the current statement (INSERT … SELECT, UPDATE … SET,
// MERGE … WHEN … UPDATE, cursor FOR SELECT, UNION SELECT, DROP … IF EXISTS, …).
// Output is a flat list; outline.ts nests IF/ELSE/WHILE/BEGIN…END/TRY/CATCH.

import type { Token } from './tokenizer';
import type { StatementKind } from './types';
import { RESERVED, isNamePart, isWord, skipParens } from './common';

export type SegKind = StatementKind | 'BEGIN' | 'END' | 'BEGIN_TRY' | 'END_TRY' | 'BEGIN_CATCH' | 'END_CATCH';

export interface SegItem {
  kind: SegKind;
  start: number;     // token range [start, end); for IF/WHILE: keyword + condition
  end: number;
  mainIndex: number; // index of the main verb (after the CTE list for WITH_CTE); = start otherwise
  verb: string;      // upper-case main verb (EXECUTE normalized to EXEC)
}

export interface SegmentContext { inlineTvf: boolean }

const STARTERS = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'WITH', 'DECLARE', 'SET', 'IF', 'ELSE', 'WHILE',
  'BEGIN', 'END', 'EXEC', 'EXECUTE', 'PRINT', 'RETURN', 'RAISERROR', 'THROW', 'TRUNCATE', 'CREATE', 'ALTER', 'DROP', 'OPEN',
  'FETCH', 'CLOSE', 'DEALLOCATE', 'COMMIT', 'ROLLBACK', 'SAVE', 'GOTO', 'WAITFOR', 'BREAK', 'CONTINUE', 'USE', 'GRANT',
  'REVOKE', 'DENY', 'BULK', 'DBCC', 'KILL', 'CHECKPOINT', 'RECONFIGURE', 'SHUTDOWN', 'BACKUP', 'RESTORE', 'READTEXT',
  'WRITETEXT', 'UPDATETEXT', 'REVERT', 'SETUSER']);

const DROPPABLE = new Set(['TABLE', 'VIEW', 'PROC', 'PROCEDURE', 'FUNCTION', 'TRIGGER', 'INDEX', 'SEQUENCE', 'TYPE', 'SYNONYM',
  'SCHEMA', 'USER', 'ROLE', 'DEFAULT', 'RULE', 'STATISTICS', 'DATABASE', 'COLUMN', 'CONSTRAINT', 'ASSEMBLY', 'LOGIN']);
const NOT_ALTER_DROP = new Set(['TABLE', 'VIEW', 'PROC', 'PROCEDURE', 'FUNCTION', 'TRIGGER', 'SYNONYM', 'TYPE', 'SEQUENCE',
  'SCHEMA', 'USER', 'ROLE', 'STATISTICS', 'DATABASE', 'INDEX', 'LOGIN', 'ASSEMBLY']);
const DML = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'MERGE']);

/** `WITH name [(cols)] AS (` or `WITH XMLNAMESPACES (` — so `WITH (NOLOCK)` is not a CTE. */
export function isCteStart(toks: Token[], i: number, end: number = toks.length): boolean {
  if (!isWord(toks[i], 'WITH')) return false;
  let j = i + 1;
  const t = toks[j];
  if (isWord(t, 'XMLNAMESPACES') && toks[j + 1]?.type === '(') return true;
  if (!t || !(t.type === 'ident' || (t.type === 'word' && !RESERVED.has(t.upper)))) return false;
  j++;
  if (toks[j]?.type === '(') j = skipParens(toks, j, end);
  return isWord(toks[j], 'AS') && toks[j + 1]?.type === '(';
}

export function isLabelAt(toks: Token[], j: number): boolean {
  const t = toks[j];
  const nx = toks[j + 1];
  return !!t && t.type === 'word' && !RESERVED.has(t.upper) && !!nx && nx.type === 'op' && nx.value === ':';
}

export function isStarterAt(toks: Token[], j: number, end: number = toks.length): boolean {
  const t = toks[j];
  if (!t || t.type !== 'word' || !STARTERS.has(t.upper)) return false;
  const prev = toks[j - 1];
  const next = j + 1 < end ? toks[j + 1] : undefined;
  if (prev?.type === '.' || next?.type === '.') return false;          // alias.[End], End.col
  switch (t.upper) {
    case 'WITH': return isCteStart(toks, j, end);
    case 'THROW':
      return !next || next.type === ';' || next.type === 'number' || next.type === 'variable' || next.type === 'string' ||
        next.type === 'placeholder' || (next.type === 'word' && STARTERS.has(next.upper));
    case 'UPDATE': return next?.type !== '(';                          // IF UPDATE(col) in triggers
    case 'FETCH': return !isWord(prev, 'ROW', 'ROWS');                 // OFFSET … ROWS FETCH NEXT … ROWS ONLY
    default: return true;
  }
}

/** Index after a CTE list starting at the WITH token i. */
export function skipCteList(toks: Token[], i: number, end: number): number {
  let j = i + 1;
  for (let guard = 0; guard < 10000 && j < end; guard++) {
    if (isWord(toks[j], 'XMLNAMESPACES')) {
      j++;
      if (toks[j]?.type === '(') j = skipParens(toks, j, end);
    } else {
      j++; // name
      if (toks[j]?.type === '(') j = skipParens(toks, j, end);
      if (isWord(toks[j], 'AS')) j++;
      if (toks[j]?.type === '(') j = skipParens(toks, j, end);
    }
    if (toks[j]?.type === ',') { j++; continue; }
    break;
  }
  return Math.min(j, end);
}

interface ScanState { insertBody: boolean; updateSet: boolean; cteOpen: boolean }

function continues(toks: Token[], j: number, verb: string, st: ScanState, ctx: SegmentContext): boolean {
  const t = toks[j] as Token;
  const u = t.upper === 'EXECUTE' ? 'EXEC' : t.upper;
  const prev = toks[j - 1];
  const prev2 = toks[j - 2];
  const next = toks[j + 1];
  if (isWord(prev, 'FOR')) return true;                                  // cursor FOR SELECT / FOR UPDATE
  if (u === 'SELECT' && (isWord(prev, 'UNION', 'EXCEPT', 'INTERSECT') || (isWord(prev, 'ALL') && isWord(prev2, 'UNION')))) return true;
  if (st.cteOpen && DML.has(u)) { st.cteOpen = false; return true; }
  switch (verb) {
    case 'INSERT':
      if (!st.insertBody && (u === 'SELECT' || u === 'EXEC' || u === 'WITH')) { st.insertBody = true; if (u === 'WITH') st.cteOpen = true; return true; }
      return false;
    case 'BULK':
      return u === 'INSERT' && isWord(prev, 'BULK');
    case 'UPDATE':
      if (!st.updateSet && u === 'SET') { st.updateSet = true; return true; }
      return false;
    case 'MERGE':
      return u === 'UPDATE' || u === 'INSERT' || u === 'DELETE' || u === 'SET';
    case 'DROP':
      return u === 'IF' && isWord(next, 'EXISTS') && !!prev && prev.type === 'word' && DROPPABLE.has(prev.upper);
    case 'ALTER':
      if (u === 'SET') return true;
      if (u === 'ALTER' && isWord(next, 'COLUMN')) return true;
      if (u === 'DROP' && !(next && next.type === 'word' && NOT_ALTER_DROP.has(next.upper))) return true;
      if (u === 'IF' && isWord(next, 'EXISTS') && isWord(prev, 'COLUMN', 'CONSTRAINT', 'DROP')) return true;
      if ((u === 'DELETE' || u === 'UPDATE') && isWord(prev, 'ON')) return true;
      if (u === 'SET' && isWord(prev, 'DELETE', 'UPDATE') && isWord(prev2, 'ON')) return true;
      return false;
    case 'CREATE':
      if ((u === 'DELETE' || u === 'UPDATE') && isWord(prev, 'ON')) return true;
      if (u === 'SET' && isWord(prev, 'DELETE', 'UPDATE') && isWord(prev2, 'ON')) return true;
      return false;
    case 'GRANT': case 'REVOKE': case 'DENY':
      return !!prev && (isWord(prev, 'GRANT', 'REVOKE', 'DENY') || prev.type === ',');
    case 'RETURN':
      if (ctx.inlineTvf && isWord(prev, 'RETURN') && (u === 'SELECT' || u === 'WITH')) { if (u === 'WITH') st.cteOpen = true; return true; }
      return false;
    default:
      return false;
  }
}

/** Scan a statement body from i (the verb) and return its exclusive end. */
function scanBody(toks: Token[], i: number, end: number, verb: string, ctx: SegmentContext): number {
  let depth = 0;
  let caseDepth = 0;
  const st: ScanState = { insertBody: false, updateSet: false, cteOpen: false };
  for (let j = i; j < end; j++) {
    const t = toks[j] as Token;
    if (t.type === '(') { depth++; continue; }
    if (t.type === ')') { if (depth > 0) depth--; continue; }
    if (depth > 0) continue;
    if (t.type === ';') return j + 1;
    if (j === i) continue;
    if (isWord(t, 'CASE')) { caseDepth++; continue; }
    if (caseDepth > 0) { if (isWord(t, 'END')) caseDepth--; continue; }
    if (isLabelAt(toks, j)) return j;
    if (!isStarterAt(toks, j, end)) {
      if (verb === 'INSERT' && isWord(t, 'VALUES', 'DEFAULT')) st.insertBody = true;
      continue;
    }
    if (continues(toks, j, verb, st, ctx)) continue;
    return j;
  }
  return end;
}

/** End of an IF/WHILE condition starting at i: the first statement start at depth 0. */
function scanCondition(toks: Token[], i: number, end: number): number {
  let depth = 0;
  let caseDepth = 0;
  for (let j = i; j < end; j++) {
    const t = toks[j] as Token;
    if (t.type === '(') { depth++; continue; }
    if (t.type === ')') { if (depth > 0) depth--; continue; }
    if (depth > 0) continue;
    if (t.type === ';') return j;
    if (isWord(t, 'CASE')) { caseDepth++; continue; }
    if (caseDepth > 0) { if (isWord(t, 'END')) caseDepth--; continue; }
    if (isStarterAt(toks, j, end) || isLabelAt(toks, j)) return j;
  }
  return end;
}

function classify(toks: Token[], i: number, verb: string, hasMain: boolean): StatementKind {
  const n1 = toks[i + 1];
  switch (verb) {
    case 'SELECT': case 'INSERT': case 'DELETE': case 'MERGE': case 'TRUNCATE': case 'RETURN': case 'RAISERROR':
    case 'THROW': case 'PRINT': case 'OPEN': case 'FETCH': case 'CLOSE': case 'DEALLOCATE': case 'GOTO': case 'WAITFOR':
    case 'BREAK': case 'CONTINUE': case 'USE': case 'COMMIT': case 'ROLLBACK':
      return verb as StatementKind;
    case 'BULK': return 'INSERT';
    case 'UPDATE': return isWord(n1, 'STATISTICS') ? 'OTHER' : 'UPDATE';
    case 'WITH': return hasMain ? 'WITH_CTE' : 'OTHER';
    case 'EXEC': return isWord(n1, 'AS') ? 'OTHER' : 'EXEC';
    case 'SAVE': return 'SAVE_TRAN';
    case 'BEGIN': return 'BEGIN_TRAN';
    case 'SET': return n1?.type === 'variable' ? 'SET' : 'SET_OPTION';
    case 'DECLARE': {
      if (n1 && n1.type !== 'variable') {
        for (let k = i + 2; k < i + 5 && k < toks.length; k++) if (isWord(toks[k], 'CURSOR')) return 'CURSOR';
      }
      return 'DECLARE';
    }
    case 'CREATE': {
      if (isWord(n1, 'TABLE')) return 'CREATE_TABLE';
      for (let k = i + 1; k < i + 5 && k < toks.length; k++) {
        const t = toks[k];
        if (isWord(t, 'INDEX')) return 'CREATE_INDEX';
        if (!isWord(t, 'UNIQUE', 'CLUSTERED', 'NONCLUSTERED', 'COLUMNSTORE', 'XML', 'SPATIAL', 'PRIMARY')) break;
      }
      return 'OTHER';
    }
    case 'DROP': return isWord(n1, 'TABLE') ? 'DROP_TABLE' : 'OTHER';
    case 'ALTER': return isWord(n1, 'TABLE') ? 'ALTER_TABLE' : 'OTHER';
    default: return 'OTHER';
  }
}

export function segment(toks: Token[], start: number, end: number, ctx: SegmentContext): SegItem[] {
  const items: SegItem[] = [];
  const push = (kind: SegKind, s: number, e: number, verb: string, mainIndex = s): void => {
    items.push({ kind, start: s, end: Math.max(e, s + 1), mainIndex, verb });
  };
  let i = start;
  while (i < end) {
    const t = toks[i] as Token;
    if (t.type === ';') { i++; continue; }
    if (isLabelAt(toks, i)) { push('LABEL', i, i + 2, 'LABEL'); i += 2; continue; }
    const nx = toks[i + 1];
    if (isWord(t, 'BEGIN') && nx?.type !== '.') {
      if (isWord(nx, 'TRY')) { push('BEGIN_TRY', i, i + 2, 'BEGIN'); i += 2; continue; }
      if (isWord(nx, 'CATCH')) { push('BEGIN_CATCH', i, i + 2, 'BEGIN'); i += 2; continue; }
      if (isWord(nx, 'TRAN', 'TRANSACTION') || (isWord(nx, 'DISTRIBUTED') && isWord(toks[i + 2], 'TRAN', 'TRANSACTION'))) {
        const e = scanBody(toks, i, end, 'BEGIN', ctx);
        push('BEGIN_TRAN', i, e, 'BEGIN'); i = Math.max(e, i + 1); continue;
      }
      if (isWord(nx, 'DIALOG', 'CONVERSATION')) {
        const e = scanBody(toks, i, end, 'OTHER', ctx);
        push('OTHER', i, e, 'BEGIN'); i = Math.max(e, i + 1); continue;
      }
      let k = i + 1;
      if (isWord(nx, 'ATOMIC')) { k = i + 2; if (isWord(toks[k], 'WITH') && toks[k + 1]?.type === '(') k = skipParens(toks, k + 1, end); }
      push('BEGIN', i, k, 'BEGIN'); i = k; continue;
    }
    if (isWord(t, 'END') && nx?.type !== '.') {
      if (isWord(nx, 'TRY')) { push('END_TRY', i, i + 2, 'END'); i += 2; continue; }
      if (isWord(nx, 'CATCH')) { push('END_CATCH', i, i + 2, 'END'); i += 2; continue; }
      if (isWord(nx, 'CONVERSATION')) { const e = scanBody(toks, i, end, 'OTHER', ctx); push('OTHER', i, e, 'END'); i = Math.max(e, i + 1); continue; }
      push('END', i, i + 1, 'END'); i++; continue;
    }
    if (isWord(t, 'IF', 'WHILE') && nx?.type !== '.') {
      const ce = scanCondition(toks, i + 1, end);
      push(t.upper as 'IF' | 'WHILE', i, ce, t.upper); i = Math.max(ce, i + 1); continue;
    }
    if (isWord(t, 'ELSE') && nx?.type !== '.') { push('ELSE', i, i + 1, 'ELSE'); i++; continue; }
    if (isStarterAt(toks, i, end)) {
      const verb = t.upper === 'EXECUTE' ? 'EXEC' : t.upper;
      if (verb === 'BREAK' || verb === 'CONTINUE') { push(verb, i, i + 1, verb); i++; continue; }
      if (verb === 'GOTO') { const e = isNamePart(nx) ? i + 2 : i + 1; push('GOTO', i, e, verb); i = e; continue; }
      if (verb === 'WITH') {
        const m = skipCteList(toks, i, end);
        const mv = toks[m];
        if (m < end && isWord(mv) && DML.has(mv.upper)) {
          const e = scanBody(toks, m, end, mv.upper, ctx);
          push('WITH_CTE', i, e, 'WITH', m); i = Math.max(e, i + 1); continue;
        }
        push('OTHER', i, Math.max(m, i + 1), 'WITH'); i = Math.max(m, i + 1); continue;
      }
      const e = scanBody(toks, i, end, verb, ctx);
      push(classify(toks, i, verb, true), i, e, verb); i = Math.max(e, i + 1); continue;
    }
    // unknown leading token: consume until the next statement start
    const e = scanBody(toks, i, end, 'OTHER', ctx);
    push('OTHER', i, e, t.type === 'word' ? t.upper : t.type); i = Math.max(e, i + 1);
  }
  return items;
}
