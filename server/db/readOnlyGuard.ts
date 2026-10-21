/**
 * Read-only guard for SQL text sent to target / job databases. Used at runtime by runQuery()
 * and by test/server/readonly-guard.test.ts against every constant in server/extract/sql/**.
 *
 * Strips comments, string literals and [bracketed identifiers], then rejects any write/DDL/EXEC
 * keyword. Exceptions:
 *  - `INSERT INTO @tableVariable` (server-side TRY/CATCH batches);
 *  - `EXEC msdb.dbo.<proc>` for exactly the read-only Agent procs in ALLOWED_EXEC (SQLAgentReaderRole
 *    members cannot SELECT the msdb job tables, so these are the only way to read jobs for them).
 */
export const ALLOWED_EXEC: readonly string[] = ['sp_help_job', 'sp_help_jobstep', 'sp_help_jobschedule', 'sp_help_jobhistory'];

const FORBIDDEN = ['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'EXEC', 'EXECUTE', 'GRANT', 'REVOKE', 'DENY', 'BULK', 'WRITETEXT', 'UPDATETEXT', 'DBCC', 'KILL', 'SHUTDOWN', 'RECONFIGURE', 'BACKUP', 'RESTORE', 'OPENROWSET', 'OPENQUERY', 'OPENDATASOURCE', 'INTO'];

export function stripSqlNoise(sql: string): string {
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === '-' && next === '-') {
      while (i < n && sql[i] !== '\n') i++;
      out += ' ';
    } else if (c === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth++;
          i += 2;
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth--;
          i += 2;
        } else i++;
      }
      out += ' ';
    } else if (c === "'") {
      i++;
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") i += 2;
        else if (sql[i] === "'") {
          i++;
          break;
        } else i++;
      }
      out += " '' ";
    } else if (c === '[') {
      i++;
      while (i < n) {
        if (sql[i] === ']' && sql[i + 1] === ']') i += 2;
        else if (sql[i] === ']') {
          i++;
          break;
        } else i++;
      }
      out += ' [id] ';
    } else if (c === '"') {
      i++;
      while (i < n && sql[i] !== '"') i++;
      i++;
      out += ' "id" ';
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

export interface GuardViolation {
  keyword: string;
  context: string;
}

export function findWriteStatements(sql: string): GuardViolation[] {
  const clean = stripSqlNoise(sql);
  const violations: GuardViolation[] = [];
  const re = /(?<![\w@#$.])([A-Za-z_]+)(?![\w$])/g;
  const tokens: Array<{ word: string; index: number }> = [];
  for (let m = re.exec(clean); m; m = re.exec(clean)) tokens.push({ word: m[1].toUpperCase(), index: m.index });
  for (let t = 0; t < tokens.length; t++) {
    const { word, index } = tokens[t];
    if (!FORBIDDEN.includes(word)) continue;
    if (word === 'EXEC' || word === 'EXECUTE') {
      const m = clean.slice(index).match(/^EXEC(?:UTE)?\s+msdb\.dbo\.(\w+)(?![\w$.])/i);
      if (m && ALLOWED_EXEC.includes(m[1].toLowerCase())) continue;
    }
    // Allowed: INSERT INTO @tableVariable ...
    if (word === 'INSERT' || word === 'INTO') {
      const after = clean.slice(index).match(/^INSERT\s+(?:INTO\s+)?(@\w+)/i) ?? clean.slice(index).match(/^INTO\s+(@\w+)/i);
      if (after) {
        // "INTO @x" right after an allowed INSERT is fine; a bare "SELECT ... INTO @x" is not valid T-SQL anyway.
        if (word === 'INTO') {
          const prev = tokens[t - 1];
          if (prev && prev.word === 'INSERT') continue;
        } else continue;
      }
    }
    violations.push({ keyword: word, context: clean.slice(Math.max(0, index - 30), index + 40).replace(/\s+/g, ' ') });
  }
  return violations;
}

export function assertReadOnlySql(sql: string): void {
  const v = findWriteStatements(sql);
  if (v.length) {
    throw new Error(`read-only guard rejected SQL: ${v.map((x) => `${x.keyword} near "${x.context}"`).join('; ')}`);
  }
}
