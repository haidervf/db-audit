#!/usr/bin/env node
// `npm run dev`: the API server (tsx watch, restarts on change) + the web UI dev server (Vite), together.
// Zero dependencies. Ctrl-C / SIGTERM is forwarded to both; when one exits, the other is stopped.
// Without web/ (or its node_modules) only the server runs, with a hint.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const bin = (name) => path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? `${name}.cmd` : name);
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const children = [];
let stopping = false;

function run(label, cmd, args) {
  const child = spawn(cmd, args, { cwd: root, stdio: 'inherit', env: process.env });
  child.on('exit', (code, signal) => {
    console.log(`[dev] ${label} exited (${signal ?? code})`);
    if (!stopping) stop(code ?? 1);
  });
  child.on('error', (err) => {
    console.error(`[dev] could not start ${label}: ${err.message}`);
    if (!stopping) stop(1);
  });
  children.push(child);
  return child;
}

function stop(code, signal = 'SIGTERM') {
  stopping = true;
  for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill(signal);
  // give children a moment to shut down cleanly
  const t = setTimeout(() => process.exit(code), 3000);
  t.unref();
  Promise.all(children.map((c) => (c.exitCode !== null || c.signalCode !== null ? null : new Promise((r) => c.once('exit', r))))).then(() => process.exit(code));
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    if (stopping) return;
    console.log(`[dev] ${sig}: stopping`);
    stop(0, sig);
  });
}

run('server', bin('tsx'), ['watch', 'server/index.ts']);

const web = path.join(root, 'web');
if (!fs.existsSync(path.join(web, 'package.json'))) {
  console.log(`[dev] web/ not found: running the API server only (http://127.0.0.1:${process.env.PORT || 4000}). The UI dev server starts once web/ exists.`);
} else if (!fs.existsSync(path.join(web, 'node_modules'))) {
  console.log('[dev] web/node_modules missing: running the API server only. Run `npm --prefix web install`, then `npm run dev` again.');
} else {
  run('web', npm, ['--prefix', 'web', 'run', 'dev']);
}
