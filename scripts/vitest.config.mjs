// SPDX-License-Identifier: GPL-3.0-or-later
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('..', import.meta.url)),
  test: {
    include: ['scripts/**/*.test.mjs', 'native/build/**/*.test.mjs', 'native/windows/**/*.test.mjs', 'e2e/support/**/*.test.mjs'],
    environment: 'node',
    setupFiles: ['./scripts/test-setup.mjs'],
    pool: 'forks',
    isolate: true,
    maxWorkers: process.platform === 'win32' ? 2 : undefined,
    silent: process.env.CI ? 'passed-only' : false,
    reporters: process.env.CI || process.env.SURTITLE_TEST_REPORT ? ['default', 'junit'] : ['default'],
    outputFile: { junit: process.env.SURTITLE_TEST_REPORT || 'work/test-results/vitest/results.xml' },
  },
});
