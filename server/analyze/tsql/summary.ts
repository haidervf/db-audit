// Template one-line summaries for outline nodes.

import type { Token } from './tokenizer';
import type { StatementKind } from './types';
import type { SegItem } from './segmenter';
import type { StmtInfo } from './extractor';
import { isWord, joinTokens, prettyName, readName, skipParens, truncate } from './common';

/** '[dbo].[OrderLog]' → 'dbo.OrderLog' */
export function plainName(display: string): string {
  return display
    .replace(/\[((?:[^\]]|\]\])*)\]/g, (_m, x: string) => x.replace(/\]\]/g, ']'))
    .replace(/"((?:[^"]|"")*)"/g, (_m, x: string) => x.replace(/""/g, '"'))
    .replace(/\s+/g, '');
}

function list(items: string[], max: number): string {
  if (items.length <= max) return items.join(', ');
  return `${items.slice(0, max).join(', ')} (+${items.length - max} more)`;
}

function plural(n: number, one: string, many: string): string { return `${n} ${n === 1 ? one : many}`; }

function reads(info: StmtInfo, exclude: string | null): string[] {
  const out: string[] = [];
  const ex = exclude ? exclude.toLowerCase() : null;
  for (const a of info.accesses) {
    if (a.op !== 'SELECT') continue;
    const n = prettyName(a.ref);
    if (ex && n.toLowerCase() === ex) continue;
    if (!out.includes(n)) out.push(n);
  }
  for (const f of info.functions) if (f.kind === 'table-valued') { const n = prettyName(f.ref) + '()'; if (!out.includes(n)) out.push(n); }
  for (const v of info.tableVarReads) if (!out.includes(v)) out.push(v);
  return out;
}

function compact(toks: Token[], s: number, e: number, max: number): string {
  let end = e;
  if (toks[end - 1]?.type === ';') end--;
  return truncate(joinTokens(toks, s, end), max);
}

/** Condition text with subqueries collapsed: `NOT EXISTS (SELECT … dbo.Z …)`. */
export function conditionText(toks: Token[], s: number, e: number, max = 120): string {
  const pieces: Token[] = [];
  let out = '';
  const flush = (): void => {
    if (pieces.length) { out += (out && !out.endsWith('(') ? ' ' : '') + joinTokens(pieces, 0, pieces.length); pieces.length = 0; }
  };
  for (let k = s; k < e; k++) {
    const t = toks[k] as Token;
    if (t.type === '(' && isWord(toks[k + 1], 'SELECT', 'WITH')) {
      const close = skipParens(toks, k, e);
      const names: string[] = [];
      for (let q = k + 1; q < close; q++) {
        if (isWord(toks[q], 'FROM', 'JOIN')) {
          const nt = toks[q + 1];
          if (!nt) continue;
          if (nt.type === 'variable') { if (!names.includes(nt.value)) names.push(nt.value); continue; }
          const nm = readName(toks, q + 1, close);
          if (nm.parts.length) { const n = nm.parts.join('.'); if (!names.includes(n)) names.push(n); }
        }
      }
      flush();
      out += (out && !out.endsWith('(') ? ' ' : '') + (names.length ? `(SELECT … ${names.join(', ')} …)` : '(SELECT …)');
      k = close - 1;
      continue;
    }
    pieces.push(t);
  }
  flush();
  return truncate(out.replace(/\( /g, '(').replace(/ \)/g, ')'), max);
}

export function summarize(kind: StatementKind, item: SegItem, info: StmtInfo, toks: Token[]): string {
  const s = item.start;
  const e = item.end;
  const m = item.mainIndex;
  switch (kind) {
    case 'IF': case 'WHILE': {
      const c = conditionText(toks, s + 1, e);
      return c ? `${kind} ${c}` : kind;
    }
    case 'WITH_CTE': {
      const names = info.ctes.map(c => c.name);
      const mainKind = (toks[m]?.upper ?? 'SELECT') as StatementKind;
      const head = names.length ? `WITH ${list(names, 3)} (CTE)` : 'WITH XMLNAMESPACES';
      return `${head} → ${summarize(mainKind, item, info, toks)}`;
    }
    case 'UPDATE': case 'DELETE': case 'MERGE': {
      const t = info.target;
      if (!t) return compact(toks, m, e, 120);
      const name = plainName(t.baseDisplay ?? t.display);
      let out = kind === 'UPDATE' ? `UPDATE ${name}` : kind === 'DELETE' ? `DELETE FROM ${name}` : `MERGE INTO ${name}`;
      if (t.viaCte) out = (kind === 'UPDATE' ? 'UPDATE ' : kind === 'DELETE' ? 'DELETE FROM ' : 'MERGE INTO ') +
        `${t.viaCte} (CTE over ${t.baseDisplay ? plainName(t.baseDisplay) : 'unresolved base'})`;
      if (t.alias) out += ` (alias ${t.alias})`;
      const others = reads(info, t.baseDisplay ? plainName(t.baseDisplay) : name);
      if (kind === 'UPDATE') {
        if (info.setColumns.length) out += `: sets ${list(info.setColumns, 6)}`;
        if (others.length) out += `; joins ${list(others, 4)}`;
      } else if (kind === 'DELETE') {
        if (others.length) out += `; joins ${list(others, 4)}`;
      } else {
        if (others.length) out += ` using ${list(others, 4)}`;
        if (info.mergeActions.length) out += `: ${info.mergeActions.map(a => a.toLowerCase()).join('/')}`;
      }
      if (info.outputInto.length) out += `; OUTPUT INTO ${list(info.outputInto.map(plainName), 2)}`;
      return out;
    }
    case 'INSERT': {
      const t = info.target;
      if (!t) return compact(toks, m, e, 120);
      let out = `${item.verb === 'BULK' ? 'BULK INSERT' : 'INSERT INTO'} ${plainName(t.display)}`;
      if (info.insertColumns !== null) out += ` (${plural(info.insertColumns, 'col', 'cols')})`;
      if (info.insertSource === 'VALUES') out += ' VALUES';
      else if (info.insertSource === 'DEFAULT') out += ' DEFAULT VALUES';
      else if (info.insertSource === 'EXEC') {
        const c = info.calls[0];
        out += c ? ` from EXEC ${plainName(c.ref.display)}` : ' from EXEC (dynamic SQL)';
      } else if (info.insertSource === 'SELECT') {
        const r = reads(info, plainName(t.display));
        out += r.length ? ` from SELECT on ${list(r, 4)}` : ' from SELECT';
      }
      if (info.outputInto.length) out += `; OUTPUT INTO ${list(info.outputInto.map(plainName), 2)}`;
      return out;
    }
    case 'SELECT': {
      const r = reads(info, null);
      const from = r.length ? ` from ${list(r, 4)}` : '';
      if (info.selectInto) return `SELECT INTO ${plainName(info.selectInto)}${from}`;
      if (info.assignedVars.length) return `SELECT into ${list(info.assignedVars, 3)}${from}`;
      if (r.length) return `SELECT${from}`;
      return compact(toks, m, e, 120);
    }
    case 'TRUNCATE':
      return info.target ? `TRUNCATE TABLE ${plainName(info.target.display)}` : compact(toks, s, e, 120);
    case 'EXEC': {
      const c = info.calls[0];
      const d = info.dynamic[0];
      if (c) {
        let out = `EXEC ${plainName(c.ref.display)} (${plural(c.args.length, 'arg', 'args')})`;
        if (c.returnVar) out += ` → ${c.returnVar}`;
        if (d) out += ' [dynamic SQL]';
        return out;
      }
      if (d?.kind === 'EXEC_AT') {
        const at = toks.slice(s, e).findIndex(t => isWord(t, 'AT'));
        const srv = at >= 0 ? toks[s + at + 1]?.name : undefined;
        return `EXEC (dynamic SQL) AT ${srv ?? '?'}`;
      }
      if (d?.kind === 'EXEC_PROC_VARIABLE') {
        const v = toks.slice(s, e).filter(t => t.type === 'variable');
        const pv = toks[s + 2]?.type === 'op' && toks[s + 2]?.value === '=' ? v[1] : v[0];
        return `EXEC ${pv?.value ?? '@?'} (procedure name in variable)`;
      }
      if (d) return 'EXEC (dynamic SQL)';
      return compact(toks, s, e, 120);
    }
    case 'DECLARE': {
      if (!info.declared.length) return compact(toks, s, e, 120);
      const shown = info.declared.slice(0, 2).map(v => (v.type ? `${v.name} ${v.type}` : v.name));
      const more = info.declared.length - shown.length;
      return `DECLARE ${shown.join(', ')}${more > 0 ? ` (+${more} more)` : ''}`;
    }
    case 'CURSOR': {
      const r = reads(info, null);
      return `DECLARE CURSOR ${info.cursor?.name ?? '?'}${r.length ? ` FOR SELECT from ${list(r, 4)}` : ''}`;
    }
    case 'BEGIN_TRAN': {
      const nm = toks.slice(s + 2, e).find(t => t.type === 'word' || t.type === 'ident' || t.type === 'variable');
      const dist = isWord(toks[s + 1], 'DISTRIBUTED') ? 'DISTRIBUTED ' : '';
      return `BEGIN ${dist}TRANSACTION${nm && !isWord(nm, 'TRAN', 'TRANSACTION', 'WITH') ? ' ' + nm.name : ''}`;
    }
    case 'COMMIT': case 'ROLLBACK': {
      const rest = toks.slice(s + 1, e).filter(t => t.type !== ';' && !isWord(t, 'TRAN', 'TRANSACTION', 'WORK'));
      const nm = rest[0] && (rest[0].type === 'word' || rest[0].type === 'ident' || rest[0].type === 'variable') && !isWord(rest[0], 'WITH') ? ' ' + rest[0].name : '';
      return `${kind} TRANSACTION${nm}`;
    }
    case 'SAVE_TRAN': {
      const nm = toks.slice(s + 1, e).find(t => (t.type === 'word' && !isWord(t, 'TRAN', 'TRANSACTION')) || t.type === 'ident' || t.type === 'variable');
      return `SAVE TRANSACTION${nm ? ' ' + nm.name : ''}`;
    }
    case 'RAISERROR':
      return 'RAISERROR(…)';
    case 'THROW': {
      const rest = compact(toks, s + 1, e, 110);
      return rest ? `THROW ${rest}` : 'THROW (re-throw)';
    }
    case 'RETURN': {
      const r = reads(info, null);
      if (r.length) return `RETURN query on ${list(r, 4)}`;
      const rest = compact(toks, s + 1, e, 110);
      return rest ? `RETURN ${rest}` : 'RETURN';
    }
    case 'CREATE_TABLE': {
      const t = info.target;
      let cols = 0;
      const open = toks.findIndex((x, idx) => idx > s && idx < e && x.type === '(');
      if (open >= 0) {
        const close = skipParens(toks, open, e);
        let d = 0;
        cols = close - 1 > open + 1 ? 1 : 0;
        for (let k = open + 1; k < close - 1; k++) {
          const x = toks[k] as Token;
          if (x.type === '(') d++; else if (x.type === ')') d--; else if (x.type === ',' && d === 0) cols++;
        }
      }
      return t ? `CREATE TABLE ${plainName(t.display)}${cols ? ` (${plural(cols, 'col', 'cols')})` : ''}` : compact(toks, s, e, 120);
    }
    case 'DROP_TABLE': {
      const t = info.target;
      if (!t) return compact(toks, s, e, 120);
      const ifEx = isWord(toks[s + 2], 'IF') ? 'IF EXISTS ' : '';
      return `DROP TABLE ${ifEx}${[t.display, ...info.extraTargets].map(plainName).join(', ')}`;
    }
    case 'OPEN': case 'CLOSE': case 'DEALLOCATE': {
      const nm = toks.slice(s + 1, e).find(t => t.type !== ';' && !isWord(t, 'GLOBAL'));
      return `${kind} cursor ${nm?.name ?? nm?.value ?? '?'}`;
    }
    case 'GOTO': return `GOTO ${toks[s + 1]?.name ?? '?'}`;
    case 'LABEL': return `Label ${toks[s]?.name ?? '?'}:`;
    case 'BREAK': return 'BREAK (exit loop)';
    case 'CONTINUE': return 'CONTINUE (next loop iteration)';
    case 'USE': return `USE ${toks[s + 1]?.name ?? '?'}`;
    default:
      return compact(toks, s, e, 120);
  }
}
