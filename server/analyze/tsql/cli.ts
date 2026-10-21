// Review CLI: npx tsx server/analyze/tsql/cli.ts <file.sql> [--outline] [--default-schema=x] [--quoted-identifier=off]
// Prints the ModuleAnalysis as JSON. The outline is omitted unless --outline is given.

import { readFileSync } from 'node:fs';
import { analyzeModule } from './index';

function main(argv: string[]): number {
  const args = argv.slice(2);
  const file = args.find(a => !a.startsWith('--'));
  if (!file) {
    process.stderr.write('usage: tsx server/analyze/tsql/cli.ts <file.sql> [--outline] [--default-schema=dbo] [--quoted-identifier=off]\n');
    return 2;
  }
  const withOutline = args.includes('--outline');
  const ds = args.find(a => a.startsWith('--default-schema='))?.split('=')[1];
  const qi = args.find(a => a.startsWith('--quoted-identifier='))?.split('=')[1];
  const sql = readFileSync(file, 'utf8');
  const result = analyzeModule(sql, { defaultSchema: ds, quotedIdentifier: qi === undefined ? undefined : qi.toLowerCase() !== 'off' });
  const out: Record<string, unknown> = { ...result };
  if (!withOutline) delete out.outline;
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  return 0;
}

process.exitCode = main(process.argv);
