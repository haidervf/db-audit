import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { PROJECT_ROOT } from '../../server/config/paths';
import { ALLOWED_EXEC, assertReadOnlySql, findWriteStatements, stripSqlNoise } from '../../server/db/readOnlyGuard';
import { runQuery } from '../../server/db/query';
import { buildExecutionsSelect, buildJobsSelect, JOB_VIEW_COLUMNS } from '../../server/extract/sql/jobs';

const SQL_DIR = path.join(PROJECT_ROOT, 'server', 'extract', 'sql');

function sqlFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sqlFiles(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : [],
  );
}

/** Every string the sql modules export, plus every builder output for the full column whitelists. */
async function allSqlStrings(): Promise<Array<{ where: string; sql: string }>> {
  const out: Array<{ where: string; sql: string }> = [];
  for (const file of sqlFiles(SQL_DIR)) {
    const mod = (await import(file)) as Record<string, unknown>;
    for (const [name, v] of Object.entries(mod)) {
      if (typeof v === 'string') out.push({ where: `${path.basename(file)}:${name}`, sql: v });
    }
  }
  for (const view of ['jobs', 'jobsteps', 'jobstep_versions', 'target_groups', 'target_group_members'] as const) {
    out.push({ where: `jobs.ts:buildJobsSelect(${view})`, sql: buildJobsSelect(view, new Set(JOB_VIEW_COLUMNS[view])) });
  }
  out.push({ where: 'jobs.ts:buildExecutionsSelect', sql: buildExecutionsSelect(new Set(JOB_VIEW_COLUMNS.job_executions)) });
  return out;
}

/** Raw template-literal / quoted-string bodies in the .ts sources (catches non-exported SQL too). */
function rawLiterals(): Array<{ where: string; sql: string }> {
  const out: Array<{ where: string; sql: string }> = [];
  for (const file of sqlFiles(SQL_DIR)) {
    const src = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
    for (const m of src.matchAll(/`([^`]*)`/g)) out.push({ where: `${path.basename(file)}:template`, sql: m[1].replace(/\$\{[^}]*\}/g, ' x ') });
  }
  return out;
}

describe('read-only guard', () => {
  it('finds SQL in server/extract/sql/**', async () => {
    const all = await allSqlStrings();
    assert.ok(all.length >= 25, `expected many SQL constants, found ${all.length}`);
  });

  it('every SQL string in server/extract/sql/** is read-only (comments/strings stripped)', async () => {
    const offenders: string[] = [];
    for (const { where, sql } of [...(await allSqlStrings()), ...rawLiterals()]) {
      const v = findWriteStatements(sql);
      if (v.length) offenders.push(`${where}: ${v.map((x) => `${x.keyword} near "${x.context}"`).join('; ')}`);
    }
    assert.deepEqual(offenders, []);
  });

  it('the only INSERTs are INSERT INTO @tableVariable and the only EXECs are the whitelisted msdb.dbo.sp_help_job* procs', async () => {
    const all = await allSqlStrings();
    const inserts = all.flatMap(({ sql }) => [...stripSqlNoise(sql).matchAll(/\bINSERT\s+(?:INTO\s+)?(\S+)/gi)].map((m) => m[1]));
    assert.ok(inserts.length > 0);
    for (const target of inserts) assert.match(target, /^@\w+$/);
    const execs = all.flatMap(({ sql }) => [...stripSqlNoise(sql).matchAll(/\bEXEC(?:UTE)?\s+(\S+?)[\s;]/gi)].map((m) => m[1].toLowerCase()));
    assert.deepEqual([...new Set(execs)].sort(), ALLOWED_EXEC.map((p) => `msdb.dbo.${p}`).sort());
  });

  it('rejects writes, DDL and non-whitelisted EXEC', () => {
    const bad = [
      'UPDATE dbo.T SET x = 1',
      'DELETE FROM dbo.T',
      'INSERT INTO dbo.T VALUES (1)',
      'INSERT dbo.T SELECT 1',
      'MERGE dbo.T AS t USING s ON 1=1 WHEN MATCHED THEN DELETE;',
      'CREATE TABLE #x (a int)',
      'SELECT 1 AS a INTO #x',
      'ALTER PROCEDURE dbo.p AS SELECT 1',
      'DROP TABLE dbo.T',
      'TRUNCATE TABLE dbo.T',
      'EXEC dbo.usp_Anything',
      'EXEC (@sql)',
      "EXEC sp_executesql N'SELECT 1'",
      'EXEC msdb.dbo.sp_start_job @job_name = N\'x\'',
      'EXEC msdb.dbo.sp_help_job_evil',
      'EXECUTE msdb.dbo.sp_delete_job @job_id = @id',
      'SELECT 1; GRANT SELECT ON dbo.T TO public',
    ];
    for (const s of bad) assert.ok(findWriteStatements(s).length > 0, `should reject: ${s}`);
  });

  it('allows SELECTs, keywords inside comments / strings / identifiers, INSERT INTO @t, and sp_help_job*', () => {
    const ok = [
      'SELECT o.create_date, o.modify_date, d.is_updated FROM sys.objects AS o',
      "SELECT N'DELETE FROM dbo.T; EXEC x' AS s -- UPDATE in a comment\n/* DROP TABLE x */",
      'SELECT [update], [delete] FROM dbo.[insert]',
      'DECLARE @r TABLE (a int); BEGIN TRY INSERT INTO @r (a) SELECT 1; END TRY BEGIN CATCH END CATCH; SELECT a FROM @r;',
      'EXEC msdb.dbo.sp_help_job;',
      'EXEC msdb.dbo.sp_help_jobstep @job_id = @job_id;',
      "EXEC msdb.dbo.sp_help_jobhistory @mode = N'FULL';",
    ];
    for (const s of ok) assert.deepEqual(findWriteStatements(s), [], `should allow: ${s}`);
  });

  it('runQuery() applies the guard before anything is sent', async () => {
    let requested = false;
    const fakePool = { request: () => ((requested = true), {}) } as never;
    await assert.rejects(runQuery(fakePool, 'UPDATE dbo.T SET x = 1'), /read-only guard rejected SQL/);
    assert.equal(requested, false);
    assert.throws(() => assertReadOnlySql('DROP TABLE dbo.T'), /DROP/);
  });
});
