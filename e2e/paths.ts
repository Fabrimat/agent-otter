import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
export const WEB_DIST = join(REPO, 'apps', 'web', 'dist');
export const SERVER_MAIN = join(REPO, 'apps', 'server', 'dist', 'main.js');
