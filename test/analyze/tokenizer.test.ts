import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, countLines } from '../../server/analyze/tsql/tokenizer';
import { splitBatches } from '../../server/analyze/tsql/batches';

const code = (src: string, qi = true) => tokenize(src, { quotedIdentifier: qi }).tokens.filter(t => t.type !== 'comment');

test('nested block comments and line comments are single comment tokens', () => {
  const { tokens, warnings } = tokenize("/* a /* b */ UPDATE Y */ SELECT 1 -- DELETE FROM X\nGO");
  assert.deepEqual(tokens.map(t => t.type), ['comment', 'word', 'number', 'comment', 'word']);
  assert.equal(tokens[0]!.value, '/* a /* b */ UPDATE Y */');
  assert.equal(tokens[3]!.value, '-- DELETE FROM X');
  assert.deepEqual(warnings, []);
});

test("strings: N'…' and '' escapes; keywords and comment markers inside stay in the string", () => {
  const t = code("SELECT N'it''s -- not /* a */ comment', 'x''y'");
  assert.deepEqual(t.map(x => x.type), ['word', 'string', ',', 'string']);
  assert.equal(t[1]!.value, "N'it''s -- not /* a */ comment'");
  assert.equal(t[3]!.value, "'x''y'");
});

test('bracketed identifiers unescape ]] and double-quoted identifiers follow QUOTED_IDENTIFIER', () => {
  const t = code('SELECT [a]]b], "c""d" FROM [dbo].[T]');
  assert.equal(t[1]!.type, 'ident');
  assert.equal(t[1]!.name, 'a]b');
  assert.equal(t[3]!.type, 'ident');
  assert.equal(t[3]!.name, 'c"d');
  const off = code('SELECT "c d"', false);
  assert.equal(off[1]!.type, 'string');
});

test('SET QUOTED_IDENTIFIER OFF inside the script switches "x" to strings for later tokens', () => {
  const t = code('SELECT "a"\nSET QUOTED_IDENTIFIER OFF\nSELECT "b"\nSET QUOTED_IDENTIFIER ON\nSELECT "c"');
  const quoted = t.filter(x => x.value.startsWith('"'));
  assert.deepEqual(quoted.map(x => x.type), ['ident', 'string', 'ident']);
});

test('variables, system variables, temp tables, placeholders, numbers, operators', () => {
  const t = code('SELECT @a, @@ROWCOUNT, #t, ##g, $(job_name), 1.5e3, 0x1F, $action, 12 <> 3 :: x');
  const types = t.filter(x => x.type !== ',').map(x => `${x.type}:${x.value}`);
  assert.deepEqual(types, ['word:SELECT', 'variable:@a', 'sysvar:@@ROWCOUNT', 'temp:#t', 'temp:##g', 'placeholder:$(job_name)',
    'number:1.5e3', 'number:0x1F', 'word:$action', 'number:12', 'op:<>', 'number:3', 'op:::', 'word:x']);
});

test('1-based line and column, CRLF counted once', () => {
  const t = code('SELECT 1\r\n  FROM dbo.T\r\n\r\nWHERE x = 1');
  const from = t.find(x => x.upper === 'FROM')!;
  const where = t.find(x => x.upper === 'WHERE')!;
  assert.equal(from.line, 2);
  assert.equal(from.col, 3);
  assert.equal(where.line, 4);
  assert.equal(where.col, 1);
  assert.equal(countLines('a\r\nb\r\n'), 2);
  assert.equal(countLines(''), 0);
});

test('multi-line tokens record endLine', () => {
  const { tokens } = tokenize("SELECT 'a\nb\nc' AS x");
  assert.equal(tokens[1]!.line, 1);
  assert.equal(tokens[1]!.endLine, 3);
});

test('unterminated constructs produce warnings, never throw', () => {
  assert.match(tokenize('SELECT 1 /* open').warnings[0]!.message, /Unterminated block comment/);
  assert.match(tokenize("SELECT 'open").warnings[0]!.message, /Unterminated string/);
  assert.match(tokenize('SELECT [open').warnings[0]!.message, /Unterminated quoted identifier/);
  assert.match(tokenize('SELECT "open').warnings[0]!.message, /Unterminated quoted identifier/);
});

test('GO splits batches only when alone on its line (count and trailing comment allowed)', () => {
  const src = [
    'SELECT 1',
    'GO',
    "SELECT 'GO' -- GO",
    '/* GO */',
    'GO 5',
    'SELECT 2 GO',
    '  go  -- trailing comment',
    'SELECT 3',
  ].join('\n');
  const b = splitBatches(tokenize(src).tokens);
  assert.equal(b.length, 4);
  assert.deepEqual(b.map(x => x.startLine), [1, 3, 6, 8]);
  assert.equal(b[1]!.repeat, 5);
  assert.deepEqual(b[2]!.tokens.map(t => t.value), ['SELECT', '2', 'GO']);
});
