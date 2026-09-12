// SPDX-License-Identifier: GPL-3.0-or-later
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true, watch: { ignored: ['**/target/**', '**/src-tauri/**', '**/crates/**', '**/work/**', '**/test-results/**'] } },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: { target: 'es2022' },
  test: { include: ['src/test/**/*.test.{ts,tsx}'], environment: 'jsdom', setupFiles: './src/test/setup.ts', css: false },
});
