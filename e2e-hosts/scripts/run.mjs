// `test` (default pnpm -r test): skips unless RUN_HOSTS=1. `hosts`: always runs, then writes results/latest.md.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
const force = process.argv.includes('--force');
if (!force && process.env.RUN_HOSTS !== '1') {
  console.log('e2e-hosts: SKIPPED (opt-in real-host tests; they spend vendor usage). Run: RUN_HOSTS=1 pnpm --filter @agent-otter/e2e-hosts hosts');
  process.exit(0);
}
if (force && process.env.RUN_HOSTS !== '1') {
  console.error('e2e-hosts: refusing to run without RUN_HOSTS=1 (explicit opt-in: this spends real vendor usage).');
  process.exit(2);
}
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const env = { ...process.env, HOSTS_RUN_ID: runId };
const sh = (cmd, args) => spawnSync(cmd, args, { stdio: 'inherit', env, shell: process.platform === 'win32' });
const started = Date.now();
const t = sh('npx', ['vitest', 'run', '--config', 'vitest.config.ts']);
mkdirSync(`results/${runId}`, { recursive: true });
writeFileSync(`results/${runId}/meta.json`, JSON.stringify({ elapsedSeconds: (Date.now() - started) / 1000, vitestStatus: t.status }));
const r = sh('node', ['scripts/report.mjs', runId]);
process.exit(t.status || r.status || 0);
