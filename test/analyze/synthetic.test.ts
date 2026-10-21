// Exact assertions for every hard case in test/fixtures/tsql/synthetic/SYNTHETIC_HardCases.sql.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeModule } from '../../server/analyze/tsql/index';
import { flatten, nodeAt, opsByKey, readFixture, table, temp } from './helpers';

const r = analyzeModule(readFixture('synthetic/SYNTHETIC_HardCases.sql'));

test('synthetic: header, batches, no warnings', () => {
  assert.equal(r.stats.batches, 2);
  assert.deepEqual(r.warnings, []);
  assert.ok(r.header);
  assert.equal(r.header.kind, 'PROCEDURE');
  assert.equal(r.header.ref.key, 'dbo.synthetic_hardcases');
  assert.equal(r.header.ref.display, '[dbo].[Synthetic_HardCases]');
  assert.deepEqual(r.header.parameters, [
    { name: '@tbl', type: 'SYSNAME', default: null, isOutput: false, isReadonly: false },
    { name: '@id', type: 'INT', default: '0', isOutput: false, isReadonly: false },
  ]);
  assert.equal(r.header.bodyStartLine, 9);
});

test('synthetic: exact real-table set with ops (nothing from comments/strings, no aliases or CTEs as tables)', () => {
  assert.deepEqual(opsByKey(r.tables), {
    'dbo.orders': ['SELECT'],
    'dbo.reviews': ['DELETE'],                        // ;WITH Dupes AS (… FROM dbo.Reviews) DELETE FROM Dupes
    'dbo.stocklevels': ['MERGE'],
    'otherdb.dbo.members': ['SELECT'],
    'dbo.mergeaudit': ['INSERT'],                     // MERGE … OUTPUT … INTO dbo.MergeAudit
    'dbo.shelves': ['UPDATE', 'DELETE'],              // UPDATE a … FROM dbo.Shelves a / DELETE a FROM dbo.Shelves a
    'linksrv.remotedb.dbo.quotas': ['SELECT'],
    'dbo.auditlog': ['DELETE'],                       // DELETE TOP (100) FROM
    'dbo.staging': ['TRUNCATE'],
    'dbo.queue': ['SELECT'],                          // cursor FOR SELECT … WITH (READPAST)
    'dbo.vw_active': ['SELECT'],
    'dbo.lookup': ['SELECT'],
    'archive.dbo.oldorders': ['SELECT'],              // Archive..OldOrders
  });
  assert.deepEqual(table(r, 'dbo.shelves')!.aliases, ['a']);
  assert.deepEqual(table(r, 'dbo.shelves')!.lines, [32, 37]);
  assert.deepEqual(table(r, 'dbo.stocklevels')!.aliases, ['t']);
  assert.deepEqual(table(r, 'dbo.orders')!.aliases, ['o']);
  for (const bad of ['dbo.notreal', 'dbo.fake', 'dbo.dupes', 'dbo.a', 'dbo.t', 'remote.dbo.t', 'dbo.s', 'dbo.cur']) assert.equal(table(r, bad), undefined, bad);
});

test('synthetic: cross-db and linked-server refs', () => {
  const arch = table(r, 'archive.dbo.oldorders')!.ref;
  assert.deepEqual({ ...arch }, { server: null, database: 'Archive', schema: null, name: 'OldOrders', key: 'archive.dbo.oldorders', display: 'Archive..OldOrders' });
  const lim = table(r, 'linksrv.remotedb.dbo.quotas')!.ref;
  assert.equal(lim.server, 'LINKSRV');
  assert.equal(lim.database, 'RemoteDb');
  assert.equal(lim.display, '[LINKSRV].[RemoteDb].[dbo].[Quotas]');
  assert.deepEqual(r.crossDatabaseRefs.map(x => x.key).sort(),
    ['archive.dbo.oldorders', 'linksrv.remotedb.dbo.quotas', 'linksrv.remotedb.dbo.remoteproc', 'otherdb.dbo.members']);
  assert.deepEqual(r.linkedServerRefs.map(x => x.key).sort(), ['linksrv.remotedb.dbo.quotas', 'linksrv.remotedb.dbo.remoteproc']);
  assert.deepEqual(r.linkedServers, ['LINKSRV']);
});

test('synthetic: temp tables (#, ##) with CREATE / SELECT INTO / INSERT / DROP; table variables', () => {
  assert.deepEqual(opsByKey(r.tempTables), {
    '#work': ['SELECT', 'INSERT', 'CREATE', 'DROP'],
    '#snap': ['SELECT', 'SELECT_INTO', 'DROP'],
    '##globalstage': ['INSERT'],
  });
  assert.deepEqual(temp(r, '#work')!.lines, [15, 17, 25, 37, 65]);
  assert.deepEqual(r.tableVariables, [{ name: '@audit', line: 12 }]);
  assert.equal(r.tables.some(t => t.ref.name.startsWith('@') || t.ref.name.startsWith('#')), false);
});

test('synthetic: CTE recorded and its write mapped to the base table', () => {
  assert.deepEqual(r.ctes, [{ name: 'Dupes', line: 20 }]);
  const n = nodeAt(r, 20, 'WITH_CTE')!;
  assert.equal(n.mainKind, 'DELETE');
  assert.equal(n.endLine, 23);
  assert.deepEqual(n.targets, ['dbo.reviews']);
  assert.equal(n.summary, 'WITH Dupes (CTE) → DELETE FROM Dupes (CTE over dbo.Reviews)');
});

test('synthetic: procedure calls — named + positional args, EXEC @rc =, linked server, INSERT…EXEC, system proc', () => {
  assert.deepEqual(r.procCalls.map(c => ({ key: c.ref.key, line: c.line, rc: c.returnVar, n: c.args.length, sys: c.isSystem, ie: c.viaInsertExec })), [
    { key: 'dbo.processitem', line: 46, rc: null, n: 2, sys: false, ie: false },
    { key: 'dbo.processitem2', line: 47, rc: '@rc', n: 2, sys: false, ie: false },
    { key: 'dbo.sp_executesql', line: 60, rc: null, n: 3, sys: true, ie: false },
    { key: 'linksrv.remotedb.dbo.remoteproc', line: 61, rc: null, n: 1, sys: false, ie: false },
    { key: 'dbo.getauditrows', line: 62, rc: null, n: 1, sys: false, ie: true },
  ]);
  assert.deepEqual(r.procCalls[0]!.args, [
    { name: '@ItemId', value: '@cid', isOutput: false },
    { name: '@Mode', value: "'FAST'", isOutput: false },
  ]);
  assert.deepEqual(r.procCalls[1]!.args, [
    { name: null, value: '@cid', isOutput: false },
    { name: null, value: '1', isOutput: false },
  ]);
  assert.equal(r.procCalls[1]!.ref.schema, null);
  assert.deepEqual(r.procCalls[2]!.args.map(a => a.name), [null, null, '@p']);
});

test('synthetic: dynamic SQL flagged (EXEC(@sql), sp_executesql, OPENQUERY) and its string not mined for refs', () => {
  assert.deepEqual(r.dynamicSql.map(d => [d.kind, d.line]), [['EXEC_STRING', 59], ['SP_EXECUTESQL', 60], ['OPENQUERY', 63]]);
  assert.equal(r.dynamicSql[2]!.snippet, "OPENQUERY(LINKSRV, 'SELECT * FROM remote.dbo.T')");
  for (const d of r.dynamicSql) assert.ok(d.snippet.length <= 200);
});

test('synthetic: scalar and table-valued functions', () => {
  assert.deepEqual(r.functionCalls.map(f => [f.ref.key, f.kind, f.line]), [
    ['dbo.fn_resolveid', 'scalar', 35],
    ['dbo.tvf_split', 'table-valued', 55],
  ]);
  assert.deepEqual(r.sequences, []);
});

test('synthetic: cursor, transactions, labels', () => {
  assert.deepEqual(r.cursors, [{ name: 'cur', line: 41 }]);
  assert.deepEqual(r.transactions, { begin: 0, commit: 0, rollback: 0, save: 0 });
  assert.equal(r.hasTryCatch, false);
  assert.deepEqual(r.gotoLabels, []);
});

test('synthetic: outline structure (WHILE body, single-statement IF/ELSE, CASE END/ELSE inside SELECT)', () => {
  assert.deepEqual(r.outline.map(n => [n.kind, n.startLine, n.endLine]), [['SET_OPTION', 1, 1], ['BLOCK', 9, 68]]);
  const w = nodeAt(r, 44, 'WHILE')!;
  assert.equal(w.endLine, 50);
  assert.deepEqual(w.children.map(n => [n.kind, n.startLine]), [['EXEC', 46], ['EXEC', 47], ['IF', 48], ['FETCH', 49]]);
  assert.deepEqual(w.children[2]!.children.map(n => n.kind), ['BREAK']);
  const sel = nodeAt(r, 54, 'SELECT')!;
  assert.equal(sel.endLine, 56);                       // CASE … 'END' ELSE 'BEGIN' END stays one statement
  const ifn = nodeAt(r, 66, 'IF')!;
  assert.deepEqual(ifn.children.map(n => n.kind), ['DROP_TABLE']);
  const els = nodeAt(r, 67, 'ELSE')!;
  assert.deepEqual(els.children.map(n => n.kind), ['PRINT']);
  const kinds = flatten(r.outline).map(n => n.kind);
  assert.equal(kinds.filter(k => k === 'OTHER').length, 0);
});

test('synthetic: summaries', () => {
  assert.equal(nodeAt(r, 32)!.summary, 'UPDATE dbo.Shelves (alias a): sets Flag; joins LINKSRV.RemoteDb.dbo.Quotas; OUTPUT INTO @audit');
  assert.equal(nodeAt(r, 25)!.summary, 'MERGE INTO dbo.StockLevels (alias t) using #Work, OtherDb.dbo.Members: update/insert; OUTPUT INTO dbo.MergeAudit');
  assert.equal(nodeAt(r, 16)!.summary, 'SELECT INTO #Snap from dbo.Orders');
  assert.equal(nodeAt(r, 17)!.summary, 'INSERT INTO #Work (2 cols) from SELECT on #Snap');
  assert.equal(nodeAt(r, 47)!.summary, 'EXEC ProcessItem2 (2 args) → @rc');
  assert.equal(nodeAt(r, 62)!.summary, 'INSERT INTO @audit (2 cols) from EXEC dbo.GetAuditRows');
  assert.equal(nodeAt(r, 13)!.summary, 'DECLARE @rc INT, @cid INT');
  assert.equal(nodeAt(r, 37)!.summary, 'DELETE FROM dbo.Shelves (alias a); joins #Work');
  assert.equal(nodeAt(r, 59)!.summary, 'EXEC (dynamic SQL)');
});
