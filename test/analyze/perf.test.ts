// Each corpus file must analyze in < 50 ms warm. Reports the max (median of 5 warm runs per file).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { analyzeModule } from '../../server/analyze/tsql/index';
import { FIXTURES, PRIVATE_FIXTURES, QUERY_FOLDER, listSqlFiles } from './helpers';

const LIMIT_MS = 50;
const files = [...new Set([...listSqlFiles(QUERY_FOLDER), ...listSqlFiles(PRIVATE_FIXTURES), ...listSqlFiles(FIXTURES)])];

test(`each corpus file analyzes in < ${LIMIT_MS} ms (warm, median of 5)`, (t) => {
  let max = { file: '', ms: 0, lines: 0 };
  let totalLines = 0;
  for (const f of files) {
    const sql = readFileSync(f, 'utf8');
    analyzeModule(sql); analyzeModule(sql);              // warm-up
    const times: number[] = [];
    for (let k = 0; k < 5; k++) {
      const t0 = performance.now();
      analyzeModule(sql);
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    const med = times[2]!;
    const lines = sql.split('\n').length;
    totalLines += lines;
    if (med > max.ms) max = { file: f, ms: med, lines };
    assert.ok(med < LIMIT_MS, `${f}: ${med.toFixed(2)} ms`);
  }
  if (!QUERY_FOLDER) t.diagnostic('DB_AUDIT_QUERY_FOLDER not set; timing repo fixtures only');
  const msg = `perf: ${files.length} files, ${totalLines} lines; max median ${max.ms.toFixed(2)} ms (${basename(max.file)}, ${max.lines} lines)`;
  t.diagnostic(msg);
  console.log(msg);
});
