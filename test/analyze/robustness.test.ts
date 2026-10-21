// analyzeModule must never throw: every .sql under DB_AUDIT_QUERY_FOLDER (read-only), 200 seeded
// truncations/garbage inputs, pathological nesting, and non-string inputs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { analyzeModule, type ModuleAnalysis } from '../../server/analyze/tsql/index';
import { FIXTURES, PRIVATE_FIXTURES, QUERY_FOLDER, internalErrors, listSqlFiles, rng } from './helpers';

function assertShape(r: ModuleAnalysis, label: string): void {
  assert.equal(typeof r.analyzerVersion, 'string', label);
  for (const k of ['tables', 'tempTables', 'tableVariables', 'ctes', 'procCalls', 'functionCalls', 'sequences', 'dynamicSql',
    'crossDatabaseRefs', 'linkedServerRefs', 'cursors', 'gotoLabels', 'outline', 'warnings'] as const) {
    assert.ok(Array.isArray(r[k]), `${label}: ${k} is an array`);
  }
  assert.equal(typeof r.stats.durationMs, 'number', label);
  for (const d of r.dynamicSql) assert.ok(d.snippet.length <= 200, label);
}

const queryFolderFiles = listSqlFiles(QUERY_FOLDER);

const queryFolderSkip = !QUERY_FOLDER ? 'DB_AUDIT_QUERY_FOLDER not set'
  : queryFolderFiles.length ? false : `DB_AUDIT_QUERY_FOLDER has no .sql files (or does not exist): ${QUERY_FOLDER}`;

test('every .sql under DB_AUDIT_QUERY_FOLDER analyzes without throwing or internal errors', { skip: queryFolderSkip }, () => {
  for (const f of queryFolderFiles) {
    const r = analyzeModule(readFileSync(f, 'utf8'));
    assertShape(r, f);
    assert.deepEqual(internalErrors(r), [], f);
  }
});

const corpusTexts = [...listSqlFiles(FIXTURES), ...listSqlFiles(PRIVATE_FIXTURES)].map(f => readFileSync(f, 'utf8'));
const VOCAB = ['SELECT', 'FROM', 'WHERE', 'INSERT', 'INTO', 'UPDATE', 'SET', 'DELETE', 'MERGE', 'USING', 'WHEN', 'THEN', 'EXEC', 'EXECUTE',
  'IF', 'ELSE', 'BEGIN', 'END', 'TRY', 'CATCH', 'WHILE', 'WITH', 'AS', 'CASE', 'DECLARE', 'CURSOR', 'FOR', 'TABLE', 'GO', 'RETURN',
  'TRAN', 'COMMIT', 'ROLLBACK', 'UNION', 'ALL', 'JOIN', 'ON', 'OUTPUT', 'NEXT', 'VALUE', 'TOP', 'DROP', 'CREATE', 'PROC', 'FUNCTION',
  'TRIGGER', 'VIEW', 'RETURNS', 'OPENQUERY', 'AT', 'GOTO', 'lbl:', 'dbo', '.', '..', ',', ';', '(', ')', '((', '))', '=', '@x', '@@ROWCOUNT',
  '#t', '##g', '[a]]b]', '"q"', "'s'", "N'x''y'", "'", '[', '"', '/*', '*/', '--', '\n', '\r\n', '$(job_name)', '0x1F', '1.5e3', 'TRIM',
  'DISTINCT', 'NOLOCK', 'ROWS', 'FETCH', 'OFFSET', 'XMLNAMESPACES', 'sp_executesql', 'x.y.value', 'UPDATE(', ' ', '﻿', '😀'];

function garbage(rand: () => number, i: number): string {
  const kind = i % 4;
  if (kind === 0 && corpusTexts.length) {                          // random prefix truncation of a real file
    const s = corpusTexts[Math.floor(rand() * corpusTexts.length)]!;
    return s.slice(0, Math.floor(rand() * s.length));
  }
  if (kind === 1 && corpusTexts.length) {                          // random middle slice
    const s = corpusTexts[Math.floor(rand() * corpusTexts.length)]!;
    const a = Math.floor(rand() * s.length);
    return s.slice(a, a + Math.floor(rand() * 2000));
  }
  if (kind === 2) {                                                // keyword soup
    const n = 1 + Math.floor(rand() * 300);
    const parts: string[] = [];
    for (let k = 0; k < n; k++) parts.push(VOCAB[Math.floor(rand() * VOCAB.length)]!);
    return parts.join(rand() < 0.5 ? ' ' : '');
  }
  let out = '';                                                    // random code units incl. lone surrogates
  const n = Math.floor(rand() * 500);
  for (let k = 0; k < n; k++) out += String.fromCharCode(Math.floor(rand() * (rand() < 0.8 ? 128 : 0xffff)));
  return out;
}

test('200 seeded random truncations / slices / keyword soups / random code units never throw', () => {
  const rand = rng(20261014);
  for (let i = 0; i < 200; i++) {
    const s = garbage(rand, i);
    let r: ModuleAnalysis | undefined;
    assert.doesNotThrow(() => { r = analyzeModule(s); }, `case ${i}`);
    assertShape(r!, `case ${i}`);
    assert.deepEqual(internalErrors(r!), [], `case ${i}: ${JSON.stringify(s.slice(0, 120))}`);
  }
});

test('unterminated constructs produce warnings', () => {
  const cases: Array<[string, RegExp]> = [
    ['CREATE PROC dbo.P AS SELECT 1 /* never closed', /Unterminated block comment/],
    ["SELECT 'never closed FROM dbo.T", /Unterminated string/],
    ['SELECT * FROM [dbo].[Open', /Unterminated quoted identifier/],
    ['SELECT (1 FROM dbo.T', /Unbalanced parentheses/],
    ['BEGIN SELECT 1', /Missing END/],
    ['SELECT 1 END', /Unmatched END/],
    ['BEGIN TRY SELECT 1 END TRY', /END TRY not followed by BEGIN CATCH/],
    ['IF @x = 1', /IF without a body/],
  ];
  for (const [sql, re] of cases) {
    const r = analyzeModule(sql);
    assert.ok(r.warnings.some(w => re.test(w.message)), `${sql} → ${JSON.stringify(r.warnings)}`);
  }
});

test('pathological nesting and non-string inputs do not throw', () => {
  const deepIf = 'IF 1 = 1 '.repeat(3000) + 'SELECT 1 FROM dbo.T';
  const deepBegin = 'BEGIN '.repeat(3000) + 'SELECT 1' + ' END'.repeat(3000);
  const deepParens = 'SELECT ' + '('.repeat(5000) + '1' + ')'.repeat(5000);
  for (const s of [deepIf, deepBegin, deepParens]) {
    const r = analyzeModule(s);
    assertShape(r, s.slice(0, 20));
    assert.deepEqual(internalErrors(r), []);
  }
  for (const v of [null, undefined, 42, {}, ''] as unknown[]) {
    const r = analyzeModule(v as string);
    assertShape(r, String(v));
  }
});
