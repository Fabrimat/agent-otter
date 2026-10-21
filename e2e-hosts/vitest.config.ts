import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@lesscubicles/protocol': fileURLToPath(new URL('../packages/protocol/src/index.ts', import.meta.url)) } },
  test: {
    include: ['test/**/*.test.ts'],
    fileParallelism: false, // real hosts, one at a time: keeps cost and timing measurable
    testTimeout: 15 * 60_000,
    hookTimeout: 60_000,
    reporters: ['default'],
  },
});
