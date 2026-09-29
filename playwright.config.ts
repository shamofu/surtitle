// SPDX-License-Identifier: GPL-3.0-or-later
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e/browser',
  outputDir: './test-results/browser',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { baseURL: 'http://127.0.0.1:1420', viewport: { width: 1440, height: 1000 }, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  webServer: { command: 'pnpm dev', url: 'http://127.0.0.1:1420', reuseExistingServer: !process.env.CI, timeout: 30000 },
});
