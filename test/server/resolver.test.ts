import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ObjectRef } from '../../shared/types';
import { analyzeModule } from '../../server/analyze/tsql/index';
import { computeFlags, extractRefs } from '../../server/analysis/refs';
import { Resolver, splitMultipartName } from '../../server/analysis/resolver';

const ref = (server: string | null, database: string | null, schema: string | null, name: string, defaultSchema = 'dbo'): ObjectRef => ({
  server,
  database,
  schema,
  name,
  key: [server, database, schema ?? defaultSchema, name].filter((x) => x !== null).join('.').toLowerCase(),
  display: [server, database, schema, name].filter((x) => x !== null).join('.'),
});

const objects = [
  { kind: 'table' as const, schema: 'dbo', name: 'OrderLog' },
  { kind: 'view' as const, schema: 'ops', name: 'vw_Summary' },
  { kind: 'procedure' as const, schema: 'dbo', name: 'usp_NightlyBatch' },
  { kind: 'procedure' as const, schema: 'ops', name: 'usp_Purge' },
  { kind: 'function' as const, schema: 'dbo', name: 'fn_CalcShipping' },
  { kind: 'trigger' as const, schema: '(database)', name: 'trg_ddl' },
];
const synonyms = [
  { schema: 'dbo', name: 'syn_Order', baseObjectName: '[dbo].[OrderLog]' },
  { schema: 'dbo', name: 'syn_Remote', baseObjectName: '[AuditArchive].[dbo].[Summary]' },
  { schema: 'dbo', name: 'syn_Linked', baseObjectName: '[LINKSRV].[RemoteDb].[dbo].[Quotas]' },
  { schema: 'dbo', name: 'syn_Self', baseObjectName: '[AuditDemo].[ops].[vw_Summary]' },
  { schema: 'dbo', name: 'syn_Missing', baseObjectName: '[dbo].[Nope]' },
];
const r = new Resolver(objects, synonyms, 'AuditDemo');
const local = { type: 'local' as const, moduleSchema: 'dbo' };

describe('static-analysis resolver', () => {
  it('local schema.name, case-insensitive, across kinds', () => {
    assert.deepEqual(r.resolve(ref(null, null, 'DBO', 'orderlog'), local), {
      key: 'dbo.orderlog',
      nodeId: 'table:dbo.OrderLog',
      kind: 'table',
      exists: true,
      sameDatabaseQualified: false,
    });
    assert.equal(r.resolve(ref(null, null, 'dbo', 'fn_calcshipping'), local).nodeId, 'function:dbo.fn_CalcShipping');
    assert.equal(r.resolve(ref(null, null, 'ops', 'VW_SUMMARY'), local).kind, 'view');
  });

  it('[ThisDb].[dbo].[X] is local with sameDatabaseQualified; other databases and linked servers are external', () => {
    const same = r.resolve(ref(null, 'auditdemo', 'dbo', 'OrderLog'), local);
    assert.deepEqual(same, { key: 'auditdemo.dbo.orderlog', nodeId: 'table:dbo.OrderLog', kind: 'table', exists: true, sameDatabaseQualified: true });
    assert.deepEqual(r.resolve(ref(null, 'AuditArchive', 'dbo', 'X'), local), {
      key: 'auditarchive.dbo.x',
      sameDatabaseQualified: false,
      nodeId: 'external:AuditArchive.dbo.X',
      kind: 'external',
      exists: false,
    });
    assert.equal(r.resolve(ref(null, 'Archive', null, 'OldOrders'), local).nodeId, 'external:Archive..OldOrders');
    assert.equal(r.resolve(ref('LINKSRV', 'RemoteDb', 'dbo', 'Quotas'), local).nodeId, 'external:LINKSRV.RemoteDb.dbo.Quotas');
  });

  it('unqualified names: module schema first, then dbo; misses are unknown', () => {
    const ops = { type: 'local' as const, moduleSchema: 'ops' };
    assert.equal(r.resolve(ref(null, null, null, 'usp_Purge', 'ops'), ops).nodeId, 'procedure:ops.usp_Purge');
    assert.equal(r.resolve(ref(null, null, null, 'usp_NightlyBatch', 'ops'), ops).nodeId, 'procedure:dbo.usp_NightlyBatch');
    assert.deepEqual(r.resolve(ref(null, null, 'dbo', 'Nope'), local), { key: 'dbo.nope', nodeId: null, kind: 'unknown', exists: false, sameDatabaseQualified: false });
    // database DDL triggers have no schema.name and are never a ref target
    assert.equal(r.resolve(ref(null, null, '(database)', 'trg_ddl'), local).kind, 'unknown');
  });

  it('synonyms resolve through their base object', () => {
    assert.equal(r.resolve(ref(null, null, 'dbo', 'syn_Order'), local).nodeId, 'table:dbo.OrderLog');
    assert.equal(r.resolve(ref(null, null, 'dbo', 'syn_Order'), local).key, 'dbo.syn_order');
    assert.equal(r.resolve(ref(null, null, 'dbo', 'syn_Remote'), local).nodeId, 'external:AuditArchive.dbo.Summary');
    assert.equal(r.resolve(ref(null, null, 'dbo', 'syn_Linked'), local).nodeId, 'external:LINKSRV.RemoteDb.dbo.Quotas');
    assert.equal(r.resolve(ref(null, null, 'dbo', 'syn_Self'), local).nodeId, 'view:ops.vw_Summary');
    assert.equal(r.resolve(ref(null, null, 'dbo', 'syn_Missing'), local).kind, 'unknown');
  });

  it('job-step scopes: another Agent database -> external of that database; Elastic not targeting -> external without node', () => {
    assert.deepEqual(r.resolve(ref(null, null, 'dbo', 'usp_NightlyBatch'), { type: 'other-database', database: 'AuditArchive' }), {
      key: 'dbo.usp_nightlybatch',
      sameDatabaseQualified: false,
      nodeId: 'external:AuditArchive.dbo.usp_NightlyBatch',
      kind: 'external',
      exists: false,
    });
    assert.deepEqual(r.resolve(ref(null, null, 'dbo', 'usp_NightlyBatch'), { type: 'not-this-db' }), {
      key: 'dbo.usp_nightlybatch',
      sameDatabaseQualified: false,
      nodeId: null,
      kind: 'external',
      exists: false,
    });
  });

  it('splitMultipartName handles brackets, escaped ]] , quotes and empty parts', () => {
    assert.deepEqual(splitMultipartName('[a].[b c].d'), ['a', 'b c', 'd']);
    assert.deepEqual(splitMultipartName('[x]]y].[z]'), ['x]y', 'z']);
    assert.deepEqual(splitMultipartName('"q".t'), ['q', 't']);
    assert.deepEqual(splitMultipartName('Archive..OldOrders'), ['Archive', '', 'OldOrders']);
  });

  it('extractRefs / computeFlags on real analyzer output: system refs dropped, same-db 3-part not cross-db', () => {
    const a = analyzeModule(`CREATE PROCEDURE dbo.p AS
BEGIN
  DELETE t FROM dbo.OrderLog AS t JOIN #x AS x ON x.Id = t.Id;
  SELECT * FROM [AuditDemo].[dbo].[OrderLog];
  SELECT name FROM sys.objects;
  EXEC sp_executesql N'SELECT 1';
  EXEC dbo.usp_NightlyBatch;
END`);
    const refs = extractRefs(a);
    assert.deepEqual(refs.tables.map((t) => t.ref.key).sort(), ['auditdemo.dbo.orderlog', 'dbo.orderlog']);
    assert.deepEqual(refs.procCalls.map((c) => c.key), ['dbo.usp_nightlybatch']);
    assert.ok(refs.aliases.includes('t') && refs.aliases.includes('x'));
    const flags = computeFlags(a, refs, 'AuditDemo');
    assert.equal(flags.hasCrossDb, false);
    assert.equal(flags.hasDynamicSql, true);
    assert.equal(flags.callsProcs, 1);
    assert.equal(flags.writesTables, 1);
    assert.equal(computeFlags(a, refs, 'OtherDb').hasCrossDb, true);
    const resolved = r.resolveAll(refs, local);
    assert.equal(resolved['auditdemo.dbo.orderlog']!.sameDatabaseQualified, true);
    assert.equal(resolved['dbo.usp_nightlybatch']!.nodeId, 'procedure:dbo.usp_NightlyBatch');
  });
});
