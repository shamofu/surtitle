// SPDX-License-Identifier: GPL-3.0-or-later
import { defineConfig } from '@playwright/test';
import browserConfig from './playwright.config';

// Baselines share one browser, OS and font environment with CI. In particular,
// running --update-snapshots on Windows must not replace the Linux baselines.
if (process.platform !== 'linux' || process.env.SURTITLE_VISUAL_ENV !== 'playwright-1.63.0-noble') {
  throw new Error('Run visual checks in the pinned image built from scripts/browser-tests.Dockerfile. See e2e/README.md.');
}

export default defineConfig({
  ...browserConfig,
  testDir: './e2e/visual',
  outputDir: './test-results/visual',
  snapshotPathTemplate: '{testDir}/snapshots/{arg}{ext}',
  updateSnapshots: 'none',
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report/visual' }]],
  expect: { toHaveScreenshot: { maxDiffPixels: 0, animations: 'disabled', caret: 'hide' } },
  use: {
    ...browserConfig.use,
    browserName: 'chromium',
    viewport: { width: 1024, height: 700 },
    deviceScaleFactor: 1,
    locale: 'en-US',
    timezoneId: 'UTC',
    reducedMotion: 'reduce',
  },
  webServer: { command: 'pnpm dev', url: 'http://127.0.0.1:1420', reuseExistingServer: false, timeout: 30000 },
});
