// Small targeted fixtures under test/fixtures/tsql/cases/ plus a few inline edge cases.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeModule } from '../../server/analyze/tsql/index';
import { flatten, nodeAt, opsByKey, readFixture, table } from './helpers';

const run = (rel: string, opts?: Parameters<typeof analyzeModule>[1]) => analyzeModule(readFixture(`cases/${rel}`), opts);

test('comments containing SQL yield nothing', () => {
  const r = run('comments_with_sql.sql');
  assert.deepEqual(opsByKey(r.tables), { 'dbo.realtable': ['SELECT'] });
  assert.deepEqual(r.procCalls, []);
  assert.deepEqual(r.outline.map(n => [n.kind, n.startLine]), [['SELECT', 3]]);
  assert.deepEqual(r.warnings, []);
});

test('string literals with keywords and dotted URLs yield no refs', () => {
  const r = run('string_literals.sql');
  assert.deepEqual(opsByKey(r.tables), { 'dbo.messages': ['SELECT'], 'dbo.links': ['INSERT'] });
  assert.deepEqual(r.procCalls, []);
  assert.deepEqual(r.crossDatabaseRefs, []);
  assert.deepEqual(r.linkedServerRefs, []);
  assert.deepEqual(r.functionCalls, []);
});

test('WITH (NOLOCK), legacy (NOLOCK) and hint lists are not CTEs / functions; aliases captured', () => {
  const r = run('table_hints.sql');
  assert.deepEqual(opsByKey(r.tables), {
    'dbo.books': ['SELECT'], 'dbo.authors': ['SELECT'], 'dbo.legacy': ['SELECT'], 'dbo.legacyaliased': ['SELECT'],
    'dbo.comma1': ['SELECT'], 'dbo.comma2': ['SELECT'], 'dbo.hinted': ['UPDATE'],
  });
  assert.deepEqual(table(r, 'dbo.legacyaliased')!.aliases, ['la']);
  assert.deepEqual(table(r, 'dbo.comma2')!.aliases, ['c2']);
  assert.deepEqual(r.ctes, []);
  assert.deepEqual(r.functionCalls, []);
});

test('TRIM(x FROM col) and IS [NOT] DISTINCT FROM are not FROM clauses', () => {
  const r = run('not_from_clauses.sql');
  assert.deepEqual(opsByKey(r.tables), { 'dbo.codes': ['SELECT'] });
  assert.deepEqual(r.functionCalls, []);
});

test('alias.col.value(…) / col.query(…) / .nodes / .exist are XML methods; schema.fn() are scalar UDFs', () => {
  const r = run('xml_methods.sql');
  assert.deepEqual(r.functionCalls.map(f => [f.ref.key, f.kind]), [['dbo.fn_calc', 'scalar'], ['reporting.fn_score', 'scalar']]);
  assert.deepEqual(opsByKey(r.tables), { 'dbo.orders': ['SELECT'] });
});

test('QUOTED_IDENTIFIER OFF (in-script SET and via option): "…" is a string', () => {
  const r = run('quoted_identifier_off.sql');
  assert.equal(r.header?.ref.key, 'dbo.qioff');
  assert.deepEqual(opsByKey(r.tables), { 'dbo.members': ['SELECT'] });
  assert.deepEqual(r.procCalls, []);
  const viaOpt = analyzeModule('SELECT * FROM dbo.Members WHERE Note = "FROM dbo.Fake"', { quotedIdentifier: false });
  assert.deepEqual(opsByKey(viaOpt.tables), { 'dbo.members': ['SELECT'] });
  const on = run('quoted_identifier_on.sql');
  assert.deepEqual(opsByKey(on.tables), { 'dbo.quotedtable': ['SELECT'] });
  assert.equal(on.tables[0]!.ref.display, '"dbo"."QuotedTable"');
});

test('EXEC … AT server, EXEC @procVar, EXECUTE AS', () => {
  const r = run('exec_at.sql');
  assert.deepEqual(r.dynamicSql.map(d => [d.kind, d.line]), [['EXEC_AT', 1], ['EXEC_AT', 2], ['EXEC_PROC_VARIABLE', 3], ['EXEC_PROC_VARIABLE', 4]]);
  assert.deepEqual(r.linkedServers, ['LINKSRV2', 'Other Server']);
  assert.deepEqual(r.procCalls, []);
  assert.deepEqual(r.tables, []);
  assert.equal(nodeAt(r, 1)!.summary, 'EXEC (dynamic SQL) AT LINKSRV2');
  assert.equal(nodeAt(r, 5)!.kind, 'OTHER');           // EXECUTE AS USER = … is not a call
});

test('NEXT VALUE FOR sequences', () => {
  const r = run('sequences.sql');
  assert.deepEqual(r.sequences.map(s => [s.ref.key, s.line]), [['dbo.orderseq', 1], ['sales.refseq', 2], ['dbo.batchseq', 3]]);
  assert.deepEqual(r.functionCalls, []);
  assert.deepEqual(opsByKey(r.tables), { 'dbo.orders': ['INSERT'] });
});

test('GOTO and labels', () => {
  const r = run('goto_labels.sql');
  assert.deepEqual(r.gotoLabels, ['Retry', 'Done']);
  const kinds = flatten(r.outline).map(n => `${n.kind}@${n.startLine}`);
  assert.deepEqual(kinds, ['BLOCK@3', 'DECLARE@4', 'LABEL@5', 'SET@6', 'IF@7', 'GOTO@7', 'IF@8', 'GOTO@8', 'UPDATE@9', 'LABEL@10', 'RETURN@11']);
  assert.deepEqual(nodeAt(r, 7, 'IF')!.children.map(n => n.summary), ['GOTO Retry']);
});

test('single-statement IF bodies, IF … ELSE, ELSE IF chains, single-statement WHILE', () => {
  const r = run('if_chains.sql');
  const shape = (ns: typeof r.outline): unknown[] => ns.map(n => (n.children.length ? [n.kind, n.startLine, shape(n.children)] : [n.kind, n.startLine]));
  assert.deepEqual(shape(r.outline), [
    ['IF', 1, [['PRINT', 1]]],
    ['IF', 2, [['UPDATE', 3]]],
    ['ELSE', 4, [['DELETE', 5]]],
    ['IF', 6, [['SELECT', 7]]],
    ['ELSE', 8, [
      ['IF', 8, [['SELECT', 9]]],
      ['ELSE', 10, [
        ['IF', 10, [['SELECT', 11]]],
        ['ELSE', 12, [['PRINT', 14], ['RETURN', 15]]],
      ]],
    ]],
    ['WHILE', 17, [['SET', 17]]],
  ]);
  assert.equal(nodeAt(r, 8, 'ELSE')!.summary, 'ELSE IF @c = 2');
  assert.equal(nodeAt(r, 10, 'IF')!.summary, 'IF EXISTS (SELECT … dbo.T3 …)');
  assert.equal(nodeAt(r, 12, 'ELSE')!.endLine, 16);
  assert.deepEqual(opsByKey(r.tables), { 'dbo.t1': ['UPDATE'], 'dbo.t2': ['DELETE'], 'dbo.t3': ['SELECT'] });
});

test('statements without semicolons split correctly', () => {
  const r = run('no_semicolons.sql');
  assert.deepEqual(r.outline.map(n => `${n.kind}@${n.startLine}`),
    ['DECLARE@1', 'SET@2', 'UPDATE@3', 'SELECT@4', 'INSERT@5', 'DELETE@6', 'EXEC@7', 'PRINT@8', 'BEGIN_TRAN@9', 'UPDATE@10', 'COMMIT@11', 'SELECT@12']);
  assert.deepEqual(opsByKey(r.tables), {
    'dbo.a': ['SELECT', 'UPDATE'], 'dbo.b': ['INSERT'], 'dbo.c': ['DELETE'], 'dbo.d': ['UPDATE'], 'dbo.e': ['SELECT'], 'dbo.f': ['SELECT'],
  });
  assert.deepEqual(r.transactions, { begin: 1, commit: 1, rollback: 0, save: 0 });
});

test('CRLF line endings give the same lines and results as LF', () => {
  for (const f of ['if_chains.sql', 'no_semicolons.sql', 'trigger.sql']) {
    const lf = readFixture(`cases/${f}`).replace(/\r\n/g, '\n');
    const crlf = lf.replace(/\n/g, '\r\n');
    const a = analyzeModule(lf);
    const b = analyzeModule(crlf);
    assert.deepEqual(b.outline, a.outline, f);
    assert.deepEqual(b.tables, a.tables, f);
    assert.equal(b.stats.lines, a.stats.lines, f);
    for (const n of flatten(b.outline)) assert.ok(!n.text.includes('\r'), f);
  }
});

test('header-only CREATE PROC with WITH EXECUTE AS', () => {
  const r = run('header_only_proc.sql');
  assert.ok(r.header);
  assert.equal(r.header.kind, 'PROCEDURE');
  assert.equal(r.header.ref.key, 'dbo.headeronly');
  assert.deepEqual(r.header.parameters, [
    { name: '@a', type: 'INT', default: null, isOutput: false, isReadonly: false },
    { name: '@b', type: 'NVARCHAR(10)', default: "N'x'", isOutput: true, isReadonly: false },
  ]);
  assert.equal(r.header.bodyStartLine, 5);
  assert.deepEqual(r.outline, []);
  assert.deepEqual(r.procCalls, []);
  assert.deepEqual(r.warnings.map(w => w.message), ['PROCEDURE header has no body']);
  const withBody = analyzeModule('CREATE PROC dbo.P WITH EXECUTE AS OWNER AS SET NOCOUNT ON; SELECT 1 FROM dbo.T');
  assert.equal(withBody.header?.bodyStartLine, 1);
  assert.deepEqual(withBody.outline.map(n => n.kind), ['SET_OPTION', 'SELECT']);
  assert.deepEqual(withBody.warnings, []);
});

test('CREATE TRIGGER ON table AFTER INSERT, UPDATE: triggerTable, inserted/deleted are not tables, IF UPDATE()', () => {
  const r = run('trigger.sql');
  assert.equal(r.header?.kind, 'TRIGGER');
  assert.equal(r.header?.ref.key, 'dbo.trg_orders_audit');
  assert.equal(r.header?.triggerTable?.key, 'dbo.orders');
  assert.equal(r.header?.bodyStartLine, 5);
  assert.deepEqual(opsByKey(r.tables), { 'dbo.orderaudit': ['INSERT'] });
  const ifn = nodeAt(r, 7, 'IF')!;
  assert.equal(ifn.summary, 'IF UPDATE(Status)');
  assert.deepEqual(ifn.children.map(n => [n.kind, n.startLine, n.endLine]), [['INSERT', 8, 11]]);
});

test('CREATE FUNCTION RETURNS TABLE (inline) and RETURNS @t TABLE (multi-statement)', () => {
  const r = run('function_tvf.sql');
  assert.equal(r.header?.kind, 'FUNCTION');
  assert.equal(r.header?.ref.key, 'dbo.tvf_activeorders');
  assert.deepEqual(r.header?.parameters.map(p => [p.name, p.type, p.default]), [['@MemberId', 'INT', null], ['@Since', 'DATE', 'NULL']]);
  assert.equal(r.header?.bodyStartLine, 5);
  assert.deepEqual(opsByKey(r.tables), { 'dbo.orders': ['SELECT'] });
  assert.deepEqual(r.functionCalls.map(f => [f.ref.key, f.kind]), [['dbo.fn_isactive', 'scalar']]);
  assert.deepEqual(r.outline.map(n => [n.kind, n.startLine, n.endLine]), [['RETURN', 5, 10]]);

  const m = run('function_multistatement.sql');
  assert.equal(m.header?.kind, 'FUNCTION');
  assert.deepEqual(m.tableVariables, [{ name: '@Result', line: 2 }]);
  assert.deepEqual(opsByKey(m.tables), { 'dbo.reviews': ['SELECT'] });
});

test('Elastic Jobs step command with $(job_name) tokens', () => {
  const r = run('elastic_job_step.sql');
  assert.equal(r.header, null);
  assert.deepEqual(opsByKey(r.tables), { 'dbo.jobrunlog': ['INSERT'], 'dbo.audittrail': ['DELETE'] });
  assert.deepEqual(r.procCalls.map(c => [c.ref.key, c.args]), [['dbo.usp_purgestaging', [
    { name: '@JobId', value: '$(job_id)', isOutput: false },
    { name: '@Step', value: "'$(step_id)'", isOutput: false },
  ]]]);
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.outline.map(n => n.kind), ['DECLARE', 'INSERT', 'DELETE', 'EXEC']);
});

test('inline edge cases: CTE writes through alias and multi-base CTE warns; OFFSET/FETCH; FK ON DELETE; GRANT; cursor FOR UPDATE', () => {
  const r = analyzeModule([
    ';WITH b AS (SELECT Id, Flag FROM dbo.Z) UPDATE t SET Flag = 1 FROM b t',
    ';WITH a AS (SELECT x.Id FROM dbo.X x JOIN dbo.Y y ON y.Id = x.Id) UPDATE a SET Id = 0',
    'SELECT Id FROM dbo.Page ORDER BY Id OFFSET 10 ROWS FETCH NEXT 5 ROWS ONLY',
    'ALTER TABLE dbo.Child ADD CONSTRAINT FK_C FOREIGN KEY (ParentId) REFERENCES dbo.Parent (Id) ON DELETE CASCADE ON UPDATE SET NULL',
    'GRANT SELECT, INSERT, UPDATE ON dbo.SomeTable TO AppRole',
    'DECLARE c2 CURSOR FOR SELECT Id FROM dbo.Q FOR UPDATE OF Id',
    'SELECT * INTO dbo.Backup_2024 FROM dbo.Live',
    'MERGE INTO dbo.Tgt WITH (HOLDLOCK) AS t USING dbo.Src s ON t.Id = s.Id WHEN NOT MATCHED BY SOURCE THEN DELETE;',
  ].join('\n'));
  assert.deepEqual(opsByKey(r.tables), {
    'dbo.z': ['UPDATE'], 'dbo.x': ['SELECT'], 'dbo.y': ['SELECT'], 'dbo.page': ['SELECT'], 'dbo.child': ['ALTER'], 'dbo.q': ['SELECT'],
    'dbo.backup_2024': ['SELECT_INTO'], 'dbo.live': ['SELECT'], 'dbo.tgt': ['MERGE'], 'dbo.src': ['SELECT'],
  });
  assert.deepEqual(r.outline.map(n => `${n.kind}@${n.startLine}`),
    ['WITH_CTE@1', 'WITH_CTE@2', 'SELECT@3', 'ALTER_TABLE@4', 'OTHER@5', 'CURSOR@6', 'SELECT@7', 'MERGE@8']);
  assert.deepEqual(r.warnings, [{ line: 2, message: 'Write through CTE a could not be mapped to a single base table' }]);
  assert.deepEqual(r.functionCalls, []);
  assert.deepEqual(r.cursors, [{ name: 'c2', line: 6 }]);
});

test('defaultSchema option is applied to unqualified names', () => {
  const r = analyzeModule('SELECT * FROM Orders JOIN app.Lines ON 1 = 1; EXEC DoThing', { defaultSchema: 'Sales' });
  assert.deepEqual(r.tables.map(t => t.ref.key), ['sales.orders', 'app.lines']);
  assert.equal(r.tables[0]!.ref.schema, null);
  assert.equal(r.procCalls[0]!.ref.key, 'sales.dothing');
});
