import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  globalSetup: './global-setup.ts',
  fullyParallel: true,
  retries: process.env['CI'] ? 1 : 0,
  workers: process.env['CI'] ? 2 : undefined,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  outputDir: 'test-results',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  use: { ...devices['Desktop Chrome'], headless: true, trace: 'retain-on-failure', permissions: ['clipboard-read', 'clipboard-write'] },
  projects: [{ name: 'chromium' }],
});
