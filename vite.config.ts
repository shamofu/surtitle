// SPDX-License-Identifier: GPL-3.0-or-later
import { defineConfig } from 'vitest/config';
import { createLogger } from 'vite';
import react from '@vitejs/plugin-react';
import { stripVTControlCharacters } from 'node:util';

const browserTest = process.env.SURTITLE_BROWSER_TEST === '1';
const browserLogger = browserTest ? createLogger('info', { allowClearScreen: false }) : undefined;
if (browserLogger) {
  const warn = browserLogger.warn;
  // Each browser page emits this expected development warning. Keep one copy
  // in the server log; browser console events and other diagnostics stay intact.
  const reducedMotionWarning = '[console.warn] You have Reduced Motion enabled on your device. Animations may not appear as expected.. For more information and steps for solving, visit https://motion.dev/troubleshooting/reduced-motion-disabled';
  browserLogger.warn = (message, options) => {
    if (stripVTControlCharacters(message) === reducedMotionWarning) browserLogger.warnOnce(reducedMotionWarning, options);
    else warn(message, options);
  };
}

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  customLogger: browserLogger,
  server: { port: 1420, strictPort: true, forwardConsole: browserTest ? true : undefined, watch: { ignored: ['**/src-tauri/**', '**/crates/**', '**/work/**'] } },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: { target: 'es2022', outDir: 'work/dist' },
  test: {
    silent: process.env.CI ? 'passed-only' : false,
    reporters: process.env.CI || process.env.SURTITLE_TEST_REPORT ? ['default', 'junit'] : ['default'],
    outputFile: { junit: process.env.SURTITLE_TEST_REPORT || 'work/test-results/vitest/results.xml' },
    // Windows script tests compile C# and start nested PowerShell processes.
    // Bound the shared UI/scripts pool so those children have CPU capacity too.
    maxWorkers: process.platform === 'win32' ? 2 : undefined,
    projects: [
      {
        extends: true,
        test: {
          name: 'ui',
          include: ['src/test/**/*.test.{ts,tsx}'],
          environment: 'jsdom',
          setupFiles: './src/test/setup.ts',
          css: false,
        },
      },
      {
        test: {
          name: 'scripts',
          include: ['scripts/**/*.test.mjs', 'native/build/**/*.test.mjs', 'native/windows/**/*.test.mjs', 'e2e/support/**/*.test.mjs'],
          environment: 'node',
          setupFiles: './scripts/test-setup.mjs',
          pool: 'forks',
          isolate: true,
        },
      },
    ],
  },
});
