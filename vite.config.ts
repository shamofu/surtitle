// SPDX-License-Identifier: GPL-3.0-or-later
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true, watch: { ignored: ['**/target/**', '**/src-tauri/**', '**/crates/**', '**/work/**', '**/test-results/**'] } },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: { target: 'es2022' },
  test: {
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
          include: ['scripts/**/*.test.mjs', '.devcontainer/**/*.test.mjs'],
          environment: 'node',
          setupFiles: './scripts/test-setup.mjs',
          pool: 'forks',
          isolate: true,
        },
      },
    ],
  },
});
