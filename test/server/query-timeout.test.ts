import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import sql from 'mssql';
import { queryRows, runQuery } from '../../server/db/query';
import { dockerUnavailableReason, LOGINS, saConfig } from './helpers';

const reason = await dockerUnavailableReason();

/**
 * RAISERROR ... WITH NOWAIT flushes the first result to the client right away, which clears tedious' requestTimeout;
 * then the batch stalls for 10 s. (Without the flush SQL Server holds `SELECT 1` in the unfilled TDS packet and
 * tedious' own requestTimeout still fires; with it, plain mssql with requestTimeout 2000 runs the full 10 s.)
 */
const STALL_AFTER_FIRST_PACKET = `SELECT 1 AS a; RAISERROR('flush', 0, 1) WITH NOWAIT; WAITFOR DELAY '00:00:10'; SELECT 2 AS b;`;
const STALL = `SELECT 1 AS a; WAITFOR DELAY '00:00:10'; SELECT 2 AS b;`;

describe('runQuery: hard wall-clock limit and abort', { skip: reason ?? false }, () => {
  // max 1: the follow-up query must reuse the cancelled connection (or a replacement if it was discarded)
  const pool = new sql.ConnectionPool({
    ...saConfig('AuditDemo'),
    user: LOGINS.reader.user,
    password: LOGINS.reader.password,
    pool: { max: 1, min: 0 },
  });
  let spid = 0;

  before(async () => {
    await pool.connect();
    spid = Number((await queryRows<{ spid: number }>(pool, 'SELECT @@SPID AS spid'))[0].spid);
  });
  after(() => pool.close());

  for (const [label, batch] of [
    ['after the first response packet', STALL_AFTER_FIRST_PACKET],
    ['before any response', STALL],
  ] as const) {
    it(`rejects at the limit ${label}, and the pool stays usable`, async () => {
      const started = Date.now();
      await assert.rejects(runQuery(pool, batch, {}, { timeoutMs: 2000 }), /Query timed out after 2000 ms/);
      const elapsed = Date.now() - started;
      assert.ok(elapsed >= 1900 && elapsed < 4000, `rejected after ${elapsed} ms`);

      const next = await queryRows<{ spid: number; x: number }>(pool, 'SELECT @@SPID AS spid, 42 AS x');
      assert.equal(next[0].x, 42);
      assert.equal(Number(next[0].spid), spid, 'the cancelled connection went back to the pool');
      assert.ok(Date.now() - started < 6000, 'follow-up did not wait for the stalled batch');
    });
  }

  it('an aborted signal cancels the in-flight request with the signal reason', async () => {
    const ac = new AbortController();
    const started = Date.now();
    setTimeout(() => ac.abort(new Error('Cancelled by user')), 500);
    await assert.rejects(runQuery(pool, STALL_AFTER_FIRST_PACKET, {}, { timeoutMs: 60_000, signal: ac.signal }), /Cancelled by user/);
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 2000, `rejected after ${elapsed} ms`);
    assert.equal((await queryRows<{ x: number }>(pool, 'SELECT 7 AS x'))[0].x, 7);
  });

  it('an already-aborted signal rejects without sending the batch', async () => {
    const ac = new AbortController();
    ac.abort(new Error('Refresh timed out after 5 s'));
    await assert.rejects(queryRows(pool, 'SELECT 1 AS a', {}, { signal: ac.signal }), /Refresh timed out after 5 s/);
  });

  it('a query that finishes within the limit is unaffected', async () => {
    const [a, b] = await runQuery(pool, `SELECT 1 AS a; WAITFOR DELAY '00:00:00.300'; SELECT 2 AS b;`, {}, { timeoutMs: 5000 });
    assert.deepEqual([a[0], b[0]], [{ a: 1 }, { b: 2 }]);
  });
});
