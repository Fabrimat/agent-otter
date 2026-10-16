// Builds protocol, web and server once. Every test then boots its own real server process from the built output (see fixtures.ts).
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { REPO } from './paths';

export default function globalSetup() {
  execSync('pnpm build', { cwd: REPO, stdio: 'inherit' });
  for (const f of ['apps/web/dist/index.html', 'apps/server/dist/main.js']) if (!existsSync(`${REPO}/${f}`)) throw new Error(`build output missing: ${f}`);
}
