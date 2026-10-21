import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Dev proxy target is configurable: API_TARGET=http://localhost:4000 pnpm --filter @lesscubicles/web dev
const target = process.env['API_TARGET'] ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/rooms': target,
      '/api': target,
      '/mcp': target,
      '/ws': { target, ws: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
  test: { environment: 'jsdom', setupFiles: ['./test/setup.ts'], globals: false },
});
