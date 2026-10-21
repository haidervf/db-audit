// Shared helpers: keyword sets, multi-part name reading, ObjectRef construction.

import type { Token } from './tokenizer';
import type { ObjectRef } from './types';

/** T-SQL reserved keywords (cannot be unquoted object names or aliases). */
export const RESERVED = new Set([
  'ADD', 'ALL', 'ALTER', 'AND', 'ANY', 'AS', 'ASC', 'AUTHORIZATION', 'BACKUP', 'BEGIN', 'BETWEEN', 'BREAK', 'BROWSE', 'BULK', 'BY',
  'CASCADE', 'CASE', 'CHECK', 'CHECKPOINT', 'CLOSE', 'CLUSTERED', 'COALESCE', 'COLLATE', 'COLUMN', 'COMMIT', 'COMPUTE', 'CONSTRAINT',
  'CONTAINS', 'CONTAINSTABLE', 'CONTINUE', 'CONVERT', 'CREATE', 'CROSS', 'CURRENT', 'CURRENT_DATE', 'CURRENT_TIME', 'CURRENT_TIMESTAMP',
  'CURRENT_USER', 'CURSOR', 'DATABASE', 'DBCC', 'DEALLOCATE', 'DECLARE', 'DEFAULT', 'DELETE', 'DENY', 'DESC', 'DISK', 'DISTINCT',
  'DISTRIBUTED', 'DOUBLE', 'DROP', 'DUMP', 'ELSE', 'END', 'ERRLVL', 'ESCAPE', 'EXCEPT', 'EXEC', 'EXECUTE', 'EXISTS', 'EXIT', 'EXTERNAL',
  'FETCH', 'FILE', 'FILLFACTOR', 'FOR', 'FOREIGN', 'FREETEXT', 'FREETEXTTABLE', 'FROM', 'FULL', 'FUNCTION', 'GOTO', 'GRANT', 'GROUP',
  'HAVING', 'HOLDLOCK', 'IDENTITY', 'IDENTITY_INSERT', 'IDENTITYCOL', 'IF', 'IN', 'INDEX', 'INNER', 'INSERT', 'INTERSECT', 'INTO', 'IS',
  'JOIN', 'KEY', 'KILL', 'LEFT', 'LIKE', 'LINENO', 'LOAD', 'MERGE', 'NATIONAL', 'NOCHECK', 'NONCLUSTERED', 'NOT', 'NULL', 'NULLIF', 'OF',
  'OFF', 'OFFSETS', 'ON', 'OPEN', 'OPENDATASOURCE', 'OPENQUERY', 'OPENROWSET', 'OPENXML', 'OPTION', 'OR', 'ORDER', 'OUTER', 'OVER',
  'PERCENT', 'PIVOT', 'PLAN', 'PRECISION', 'PRIMARY', 'PRINT', 'PROC', 'PROCEDURE', 'PUBLIC', 'RAISERROR', 'READ', 'READTEXT',
  'RECONFIGURE', 'REFERENCES', 'REPLICATION', 'RESTORE', 'RESTRICT', 'RETURN', 'REVERT', 'REVOKE', 'RIGHT', 'ROLLBACK', 'ROWCOUNT',
  'ROWGUIDCOL', 'RULE', 'SAVE', 'SCHEMA', 'SECURITYAUDIT', 'SELECT', 'SEMANTICKEYPHRASETABLE', 'SEMANTICSIMILARITYDETAILSTABLE',
  'SEMANTICSIMILARITYTABLE', 'SESSION_USER', 'SET', 'SETUSER', 'SHUTDOWN', 'SOME', 'STATISTICS', 'SYSTEM_USER', 'TABLE', 'TABLESAMPLE',
  'TEXTSIZE', 'THEN', 'TO', 'TOP', 'TRAN', 'TRANSACTION', 'TRIGGER', 'TRUNCATE', 'TRY_CONVERT', 'TSEQUAL', 'UNION', 'UNIQUE', 'UNPIVOT',
  'UPDATE', 'UPDATETEXT', 'USE', 'USER', 'VALUES', 'VARYING', 'VIEW', 'WAITFOR', 'WHEN', 'WHERE', 'WHILE', 'WITH', 'WRITETEXT',
]);

/** Words that may follow a table source but are never its alias. */
export const NON_ALIAS = new Set([...RESERVED, 'OUTPUT', 'USING', 'WINDOW', 'APPLY', 'OFFSET', 'MATCHED', 'THROW', 'RETURNS',
  'HASH', 'LOOP', 'REMOTE', 'INCLUDE', 'GO']);

export type Warn = (line: number | null, message: string) => void;

/** Narrowing targets are strict subtypes so a false result never narrows a Token to `never`. */
export interface WordToken extends Token { type: 'word' }
export interface NameToken extends Token { type: 'word' | 'ident' | 'temp' }

export function isWord(t: Token | undefined, ...words: string[]): t is WordToken {
  if (!t || t.type !== 'word') return false;
  return words.length === 0 || words.includes(t.upper);
}

export function isNamePart(t: Token | undefined): t is NameToken {
  return !!t && (t.type === 'word' || t.type === 'ident' || t.type === 'temp');
}

export interface NameRead {
  parts: string[];   // '' for an omitted middle part (db..table)
  next: number;      // index after the name
  start: number;     // index of the first name token
  last: number;      // index of the last name token
}

/** Read a dotted multi-part name starting at i. Returns parts=[] when toks[i] is not a name part. */
export function readName(toks: Token[], i: number, end: number = toks.length): NameRead {
  const parts: string[] = [];
  const first = toks[i];
  if (i >= end || !isNamePart(first)) return { parts, next: i, start: i, last: i };
  parts.push(first.name);
  let j = i + 1;
  let last = i;
  while (j < end && toks[j]?.type === '.') {
    let k = j;
    let dots = 0;
    while (k < end && toks[k]?.type === '.') { dots++; k++; }
    const nx = toks[k];
    if (k < end && isNamePart(nx)) {
      for (let d = 1; d < dots; d++) parts.push('');   // db..table → ['db', '', 'table']
      parts.push(nx.name);
      last = k;
      j = k + 1;
      continue;
    }
    break; // trailing dot(s) not followed by a name (alias.*): stop at the first dot
  }
  return { parts, next: j, start: i, last };
}

export function sliceSrc(src: string, toks: Token[], s: number, eInclusive: number): string {
  const a = toks[s];
  const b = toks[eInclusive];
  if (!a || !b) return '';
  return src.slice(a.start, b.end);
}

/** Build an ObjectRef from name parts (as returned by readName). */
export function makeRef(partsIn: string[], display: string, defaultSchema: string): ObjectRef {
  let parts = partsIn.slice();
  if (parts.length > 4) parts = parts.slice(parts.length - 4);
  const name = parts[parts.length - 1] ?? '';
  let schema: string | null = null;
  let database: string | null = null;
  let server: string | null = null;
  if (parts.length >= 2) schema = parts[parts.length - 2] || null;
  if (parts.length >= 3) database = parts[parts.length - 3] || null;
  if (parts.length >= 4) server = parts[parts.length - 4] || null;
  const isTemp = name.startsWith('#');
  const keyParts: string[] = [];
  if (server) keyParts.push(server);
  if (server || database) keyParts.push(database ?? '');
  if (!isTemp || schema) keyParts.push(schema ?? defaultSchema);
  keyParts.push(name);
  return { server, database, schema, name, key: keyParts.join('.').toLowerCase(), display };
}

export function prettyName(ref: ObjectRef): string {
  const parts: string[] = [];
  if (ref.server) parts.push(ref.server);
  if (ref.server || ref.database) parts.push(ref.database ?? '');
  if (ref.schema || ref.database || ref.server) parts.push(ref.schema ?? '');
  parts.push(ref.name);
  return parts.join('.');
}

/** Index just after the parenthesis group opening at j (toks[j] must be '('). */
export function skipParens(toks: Token[], j: number, end: number = toks.length): number {
  let d = 0;
  for (let k = j; k < end; k++) {
    const t = toks[k] as Token;
    if (t.type === '(') d++;
    else if (t.type === ')') { d--; if (d <= 0) return k + 1; }
  }
  return end;
}

/** Compact single-line rendering of tokens [s, e). */
export function joinTokens(toks: Token[], s: number, e: number): string {
  let out = '';
  let prev: Token | undefined;
  for (let k = s; k < e; k++) {
    const t = toks[k] as Token;
    if (t.type === 'comment') continue;
    const v = t.type === 'string' ? t.value.replace(/\s+/g, ' ') : t.value;
    if (prev) {
      const noSpace = t.type === ')' || t.type === ',' || t.type === '.' || t.type === ';' || prev.type === '(' || prev.type === '.' ||
        (t.type === '(' && (prev.type === 'word' || prev.type === 'ident')) ;
      if (!noSpace) out += ' ';
    }
    out += v;
    prev = t;
  }
  return out;
}

export function truncate(s: string, max: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  if (one.length <= max) return one;
  return one.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}
