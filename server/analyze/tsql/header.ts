// CREATE / ALTER / CREATE OR ALTER  PROC|PROCEDURE|FUNCTION|VIEW|TRIGGER header parsing.

import type { Token } from './tokenizer';
import type { ModuleHeader, Param } from './types';
import { isWord, makeRef, readName, skipParens, sliceSrc, truncate, type Warn } from './common';

export interface HeaderParse {
  header: ModuleHeader;
  bodyStart: number;                                     // token index of the first body token
  inlineTvf: boolean;                                    // RETURNS TABLE … RETURN (SELECT …)
  tableVariables: Array<{ name: string; line: number }>; // RETURNS @t TABLE and READONLY table-valued params
}

const PARAM_STOP = new Set(['OUTPUT', 'OUT', 'READONLY', 'VARYING', 'NULL', 'NOT', 'WITH', 'AS', 'FOR']);

/** Parse a module header at the start of a batch. Returns null when the batch is not a module definition. */
export function parseHeader(toks: Token[], src: string, defaultSchema: string, warn: Warn): HeaderParse | null {
  const end = toks.length;
  if (!isWord(toks[0], 'CREATE', 'ALTER')) return null;
  let j = 1;
  if (isWord(toks[0], 'CREATE') && isWord(toks[1], 'OR') && isWord(toks[2], 'ALTER')) j = 3;
  const kt = toks[j];
  if (!isWord(kt, 'PROC', 'PROCEDURE', 'FUNCTION', 'VIEW', 'TRIGGER')) return null;
  const kind: ModuleHeader['kind'] = kt.upper === 'PROC' || kt.upper === 'PROCEDURE' ? 'PROCEDURE' : (kt.upper as 'FUNCTION' | 'VIEW' | 'TRIGGER');
  j++;
  const nm = readName(toks, j, end);
  if (nm.parts.length === 0) return null;
  const ref = makeRef(nm.parts, sliceSrc(src, toks, nm.start, nm.last), defaultSchema);
  j = nm.next;
  if (toks[j]?.type === ';' && toks[j + 1]?.type === 'number') j += 2; // numbered procedure: name;1

  const parameters: Param[] = [];
  const tableVariables: Array<{ name: string; line: number }> = [];
  let inlineTvf = false;
  let triggerTable: ModuleHeader['triggerTable'] = undefined;

  if (kind === 'PROCEDURE' || kind === 'FUNCTION') {
    let wrapped = false;
    let close = end;
    if (toks[j]?.type === '(') { wrapped = true; close = skipParens(toks, j, end) - 1; j++; }
    j = parseParams(toks, src, j, wrapped ? close : end, parameters);
    if (wrapped) j = close + 1;
    for (const p of parameters) if (p.isReadonly) tableVariables.push({ name: p.name, line: lineOfParam(toks, p.name) });
  }

  if (kind === 'FUNCTION') {
    if (isWord(toks[j], 'RETURNS')) {
      j++;
      const rt = toks[j];
      if (rt?.type === 'variable') {
        tableVariables.push({ name: rt.value, line: rt.line });
        j++;
        if (isWord(toks[j], 'TABLE')) j++;
        if (toks[j]?.type === '(') j = skipParens(toks, j, end);
      } else if (isWord(rt, 'TABLE')) {
        inlineTvf = true;
        j++;
      } else {
        const tn = readName(toks, j, end);
        j = tn.parts.length ? tn.next : j + 1;
        if (toks[j]?.type === '(') j = skipParens(toks, j, end);
      }
    }
    // WITH options, then optional AS, then BEGIN … END or RETURN …
    while (j < end && !isWord(toks[j], 'AS', 'BEGIN', 'RETURN')) {
      if (isWord(toks[j], 'EXECUTE', 'EXEC') && isWord(toks[j + 1], 'AS')) { j += 3; continue; }
      j++;
    }
    if (isWord(toks[j], 'AS')) j++;
  } else if (kind === 'VIEW') {
    if (toks[j]?.type === '(') j = skipParens(toks, j, end);
    j = skipToBodyAs(toks, j, end);
  } else if (kind === 'TRIGGER') {
    if (isWord(toks[j], 'ON')) {
      j++;
      if (isWord(toks[j], 'DATABASE')) { triggerTable = null; j++; }
      else if (isWord(toks[j], 'ALL') && isWord(toks[j + 1], 'SERVER')) { triggerTable = null; j += 2; }
      else {
        const tn = readName(toks, j, end);
        if (tn.parts.length) { triggerTable = makeRef(tn.parts, sliceSrc(src, toks, tn.start, tn.last), defaultSchema); j = tn.next; }
        else triggerTable = null;
      }
    }
    j = skipToBodyAs(toks, j, end);
  } else {
    // PROCEDURE: WITH options / FOR REPLICATION, then AS
    j = skipToBodyAs(toks, j, end);
  }

  if (j > end) j = end;
  if (j >= end) warn(kt.line, `${kind} header has no body`);
  const bodyTok = toks[j] ?? toks[j - 1] ?? kt;
  const header: ModuleHeader = { kind, ref, parameters, bodyStartLine: bodyTok.line };
  if (kind === 'TRIGGER') header.triggerTable = triggerTable ?? null;
  return { header, bodyStart: j, inlineTvf, tableVariables };
}

/** From j, find the header-terminating AS (skipping WITH EXECUTE AS …) and return the index after it. */
function skipToBodyAs(toks: Token[], j: number, end: number): number {
  let depth = 0;
  for (let k = j; k < end; k++) {
    const t = toks[k] as Token;
    if (t.type === '(') { depth++; continue; }
    if (t.type === ')') { depth = Math.max(0, depth - 1); continue; }
    if (depth > 0) continue;
    if (isWord(t, 'EXECUTE', 'EXEC') && isWord(toks[k + 1], 'AS')) { k += 2; continue; }
    if (isWord(t, 'AS')) return k + 1;
  }
  return end;
}

function lineOfParam(toks: Token[], name: string): number {
  for (const t of toks) if (t.type === 'variable' && t.value === name) return t.line;
  return 1;
}

/** Parse `@p [AS] type [VARYING] [NULL|NOT NULL] [= default] [OUT|OUTPUT] [READONLY]` lists. Returns the index after the list. */
function parseParams(toks: Token[], src: string, j: number, end: number, out: Param[]): number {
  while (j < end && toks[j]?.type === 'variable') {
    const name = (toks[j] as Token).value;
    j++;
    if (isWord(toks[j], 'AS')) j++;
    // type
    const ts = j;
    let depth = 0;
    while (j < end) {
      const t = toks[j] as Token;
      if (t.type === '(') depth++;
      else if (t.type === ')') { if (depth === 0) break; depth--; }
      else if (depth === 0 && (t.type === ',' || (t.type === 'op' && t.value === '=') || (t.type === 'word' && PARAM_STOP.has(t.upper)) || t.type === 'variable')) break;
      j++;
    }
    const type = j > ts ? truncate(sliceSrc(src, toks, ts, j - 1), 200) : '';
    let def: string | null = null;
    let isOutput = false;
    let isReadonly = false;
    for (;;) {
      const t = toks[j];
      if (!t || j >= end) break;
      if (isWord(t, 'VARYING', 'NULL')) { j++; continue; }
      if (isWord(t, 'NOT') && isWord(toks[j + 1], 'NULL')) { j += 2; continue; }
      if (isWord(t, 'OUTPUT', 'OUT')) { isOutput = true; j++; continue; }
      if (isWord(t, 'READONLY')) { isReadonly = true; j++; continue; }
      if (t.type === 'op' && t.value === '=') {
        j++;
        const ds = j;
        let d = 0;
        while (j < end) {
          const u = toks[j] as Token;
          if (u.type === '(') d++;
          else if (u.type === ')') { if (d === 0) break; d--; }
          else if (d === 0 && (u.type === ',' || isWord(u, 'OUTPUT', 'OUT', 'READONLY', 'WITH', 'AS', 'FOR'))) break;
          j++;
        }
        def = j > ds ? truncate(sliceSrc(src, toks, ds, j - 1), 200) : '';
        continue;
      }
      break;
    }
    out.push({ name, type, default: def, isOutput, isReadonly });
    if (toks[j]?.type === ',') { j++; continue; }
    break;
  }
  return j;
}
