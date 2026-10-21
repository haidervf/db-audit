import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type {
  FunctionDetails,
  ProcedureDetails,
  RefreshRun,
  TableDetails,
  TriggerDetails,
  ViewDetails,
} from '../../shared/types';
import { ReadModel } from '../../server/api/readModel';
import { connectionInput, countKinds, dockerUnavailableReason, refreshAndWait, SEED, tempContext } from './helpers';

const reason = await dockerUnavailableReason();

describe('extraction: AuditDemo as audit_full (full refresh)', { skip: reason ?? false }, () => {
  const ctx = tempContext();
  let id = '';
  let run: RefreshRun;
  let rm: ReadModel;

  before(async () => {
    id = ctx.connections.create(connectionInput('AuditDemo', 'full', { jobs: null, jobsSource: 'none' })).id;
    run = await refreshAndWait(ctx, id, { segments: 'all', mode: 'full' });
    rm = new ReadModel(ctx.caches.get(id), ctx.connections.get(id)!);
  });
  after(() => ctx.cleanup());

  it('run succeeds and object counts match the seed', () => {
    assert.equal(run.status, 'succeeded', JSON.stringify(run));
    const c = countKinds(ctx, id);
    assert.deepEqual({ procedure: c.procedure, table: c.table, view: c.view, function: c.function, trigger: c.trigger }, SEED.auditDemo);
    assert.deepEqual(run.counts.procedures, { added: SEED.auditDemo.procedure, updated: 0, removed: 0, unchanged: 0 });
    assert.deepEqual(run.counts.tables, { added: 11, updated: 0, removed: 0, unchanged: 0 });
    assert.ok(ctx.connections.get(id)!.lastRefreshAt);
  });

  it('encrypted proc: definition null + isEncrypted, with a warning', () => {
    const p = rm.detail('procedure', 'dbo', 'usp_Secret')!;
    assert.equal(p.definition, null);
    assert.equal(p.isEncrypted, true);
    assert.equal(p.hasDefinition, false);
    assert.equal((p.details as unknown as ProcedureDetails).definitionStatus, 'encrypted');
    assert.ok(run.warnings.some((w) => /procedures: 1 NULL definition\(s\): 1 encrypted/.test(w)), run.warnings.join('\n'));
  });

  it('stale proc: warning names the binding error, run still succeeds', () => {
    assert.ok(run.warnings.some((w) => w.includes('dbo.usp_Stale') && w.includes('Msg 207') && w.includes('LegacyFax')), run.warnings.join('\n'));
    const p = rm.detail('procedure', 'dbo', 'usp_Stale')!;
    assert.ok(p.definition?.includes('LegacyFax'));
    const mem = p.references.find((d) => d.to.name === 'Member')!;
    assert.equal(mem.isIncomplete, true);
  });

  it('procedure details: parameters rendered with type + output flag; definition + quoted identifier', () => {
    const p = rm.detail('procedure', 'dbo', 'usp_PlaceOrder')!;
    const d = p.details as unknown as ProcedureDetails;
    assert.deepEqual(
      d.parameters.map((x) => [x.name, x.type, x.isOutput]),
      [
        ['@CardId', 'bigint', false],
        ['@Amount', 'decimal(18,2)', false],
        ['@OrderType', 'varchar(10)', false],
        ['@OrderId', 'bigint', true],
      ],
    );
    assert.ok(d.parameters.every((x) => x.default === null));
    assert.equal(d.module.usesQuotedIdentifier, true);
    assert.match(p.definition!, /NEXT VALUE FOR dbo\.seq_OrderRef/);
    const hard = rm.detail('procedure', 'dbo', 'Synthetic_HardCases')!.details as unknown as ProcedureDetails;
    assert.equal(hard.module.executeAs, 'OWNER');
  });

  it('table details: identity, computed, defaults, PK, FKs, indexes with included columns, row counts', () => {
    const t = rm.detail('table', 'dbo', 'OrderLog')!;
    const d = t.details as unknown as TableDetails;
    const col = (n: string) => d.columns.find((c) => c.name === n)!;
    assert.equal(col('OrderId').isIdentity, true);
    assert.equal(col('OrderId').identitySeed, '1');
    assert.equal(col('NetAmount').isComputed, true);
    assert.equal(col('NetAmount').isPersisted, true);
    assert.equal(col('NetAmount').computedDefinition, '([Amount]-[Shipping])');
    assert.equal(col('OrderRef').defaultDefinition, '(NEXT VALUE FOR [dbo].[seq_OrderRef])');
    assert.equal(col('Amount').type, 'decimal(18,2)');
    assert.equal(col('CreatedAt').type, 'datetime2(3)');
    assert.deepEqual(d.primaryKey, { name: 'PK_OrderLog', columns: ['OrderId'] });
    assert.deepEqual(d.foreignKeys.map((f) => [f.name, f.references.name, f.columns]), [['FK_OrderLog_Card', 'Member_Card', [{ from: 'CardId', to: 'CardId' }]]]);
    const ix = d.indexes.find((i) => i.name === 'IX_OrderLog_Card_Created')!;
    assert.deepEqual(ix.keyColumns, [{ name: 'CardId', descending: false }, { name: 'CreatedAt', descending: true }]);
    assert.deepEqual(ix.includedColumns, ['Amount', 'Status']);
    assert.equal(d.rowCount, 200);
    assert.equal(d.rowCountSource, 'dm_db_partition_stats');
    assert.ok((d.reservedKb ?? 0) > 0);
    assert.deepEqual(d.referencedByForeignKeys?.map((f) => f.from.name), ['ShipmentLogs']);
    const mem = rm.detail('table', 'dbo', 'Member')!.details as unknown as TableDetails;
    assert.ok(!mem.columns.some((c) => c.name === 'LegacyFax'));
    assert.deepEqual(mem.checkConstraints.map((c) => c.name), ['CK_Member_Tier']);
    assert.ok(rm.summaries('table').some((s) => s.schema === 'ops' && s.name === 'ErrorLog'));
  });

  it('views, functions, triggers', () => {
    const v = rm.detail('view', 'dbo', 'vw_MemberPoints')!;
    assert.ok((v.details as unknown as ViewDetails).columns.some((c) => c.name === 'AvailablePoints'));
    const fn = rm.detail('function', 'dbo', 'fn_CalcShipping')!.details as unknown as FunctionDetails;
    assert.equal(fn.functionType, 'scalar');
    assert.equal(fn.returnType, 'decimal(18,2)');
    assert.deepEqual(fn.parameters.map((p) => p.type), ['decimal(18,2)', 'varchar(10)']);
    const tvf = rm.detail('function', 'dbo', 'tvf_CardOrders')!.details as unknown as FunctionDetails;
    assert.equal(tvf.functionType, 'inline-tvf');
    assert.ok(tvf.returnColumns.some((c) => c.name === 'NetAmount'));
    const tr = rm.detail('trigger', 'dbo', 'trg_Member_Card_Audit')!.details as unknown as TriggerDetails;
    assert.deepEqual([tr.triggerType, tr.parent?.name, tr.events, tr.isInsteadOf, tr.isDisabled], ['dml', 'Member_Card', ['UPDATE'], false, false]);
    const ddl = rm.detail('trigger', '(database)', 'trg_ddl_NoOp')!.details as unknown as TriggerDetails;
    assert.equal(ddl.triggerType, 'ddl-database');
    assert.deepEqual(ddl.events, ['CREATE_TABLE']);
  });

  it('dependencies: both sources merged, read/write flags, EXEC chain, cross-database reference', () => {
    const post = rm.detail('procedure', 'dbo', 'usp_PlaceOrder')!;
    const ref = (n: string) => post.references.find((d) => d.to.name === n)!;
    assert.deepEqual(ref('Member_Card').source.sort(), ['expression-dependencies', 'referenced-entities']);
    assert.equal(ref('Member_Card').isUpdated, true);
    assert.equal(ref('OrderLog').isUpdated, true);
    assert.equal(ref('usp_WriteAudit').to.kind, 'procedure');
    assert.equal(ref('fn_CalcShipping').to.kind, 'function');
    assert.equal(ref('seq_OrderRef').to.typeCode, 'SO');
    assert.ok(post.referencedBy.some((d) => d.from.name === 'usp_Checkout'));
    const arch = rm.detail('procedure', 'dbo', 'usp_ArchiveOrders')!;
    const x = arch.references.find((d) => d.to.database === 'AuditArchive')!;
    assert.deepEqual([x.to.kind, x.to.schema, x.to.name], ['external', 'dbo', 'OrderArchiveSummary']);
    const nightly = rm.detail('procedure', 'dbo', 'usp_NightlyBatch')!;
    assert.deepEqual(nightly.references.filter((d) => d.to.kind === 'procedure').map((d) => d.to.name).sort(), ['usp_ArchiveOrders', 'usp_ArchiveShipments', 'usp_PurgeAuditLog']);
    // trigger pseudo-tables are filtered out
    const trg = rm.detail('trigger', 'dbo', 'trg_Member_Card_Audit')!;
    assert.ok(!trg.references.some((d) => ['inserted', 'deleted'].includes(d.to.name)));
    // table-level dependency (DEFAULT NEXT VALUE FOR) needs sys.sql_expression_dependencies
    const tl = rm.detail('table', 'dbo', 'OrderLog')!;
    assert.ok(tl.references.some((d) => d.to.name === 'seq_OrderRef'));
  });
});

describe('extraction: permission degradation (audit_reader vs audit_full)', { skip: reason ?? false }, () => {
  const ctx = tempContext();
  let reader = '';
  let full = '';
  let runReader: RefreshRun;
  let runFull: RefreshRun;

  before(async () => {
    reader = ctx.connections.create(connectionInput('AuditDemo', 'reader', { jobs: null, jobsSource: 'none' })).id;
    full = ctx.connections.create(connectionInput('AuditDemo', 'full', { jobs: null, jobsSource: 'none' })).id;
    runReader = await refreshAndWait(ctx, reader, { segments: 'all', mode: 'full' });
    runFull = await refreshAndWait(ctx, full, { segments: 'all', mode: 'full' });
  });
  after(() => ctx.cleanup());

  it('audit_reader: succeeds with permission warnings and referenced-entities-only dependencies', () => {
    assert.equal(runReader.status, 'succeeded', JSON.stringify(runReader));
    assert.ok(runReader.warnings.some((w) => /sys\.sql_expression_dependencies is not readable \(Msg 229/.test(w)), runReader.warnings.join('\n'));
    assert.ok(runReader.warnings.some((w) => /VIEW DATABASE STATE not granted/.test(w)));
    const deps = ctx.caches.get(reader).allDependencies();
    assert.ok(deps.length > 20);
    assert.ok(deps.every((d) => d.source.length === 1 && d.source[0] === 'referenced-entities'));
    assert.deepEqual(countKinds(ctx, reader), countKinds(ctx, full));
  });

  it('audit_full: expression dependencies present', () => {
    assert.equal(runFull.status, 'succeeded');
    assert.ok(!runFull.warnings.some((w) => /sql_expression_dependencies/.test(w)));
    const deps = ctx.caches.get(full).allDependencies();
    assert.ok(deps.some((d) => d.source.includes('expression-dependencies')));
    // only expression deps see table-level references (DEFAULT ... NEXT VALUE FOR)
    assert.ok(deps.some((d) => d.fromKind === 'table' && d.refName === 'seq_OrderRef'));
    assert.ok(!ctx.caches.get(reader).allDependencies().some((d) => d.fromKind === 'table'));
  });

  it('row count source differs: sys.partitions vs dm_db_partition_stats', () => {
    const r = new ReadModel(ctx.caches.get(reader), ctx.connections.get(reader)!).detail('table', 'dbo', 'Member')!.details as unknown as TableDetails;
    const f = new ReadModel(ctx.caches.get(full), ctx.connections.get(full)!).detail('table', 'dbo', 'Member')!.details as unknown as TableDetails;
    assert.equal(r.rowCountSource, 'sys.partitions');
    assert.equal(r.reservedKb, null);
    assert.equal(f.rowCountSource, 'dm_db_partition_stats');
    assert.equal(r.rowCount, 20);
    assert.equal(f.rowCount, 20);
  });

  it('server info is stored with the permission probe', () => {
    const info = ctx.caches.get(reader).getMeta<{ permissions: Record<string, boolean>; loginName: string }>('server_info')!;
    assert.deepEqual(info.permissions, { viewDefinition: true, expressionDependencies: false, viewDatabaseState: false });
    assert.equal(info.loginName, 'audit_reader');
  });
});
