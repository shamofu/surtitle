// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { afterEach, test, vi } from 'vitest';
import { spawnWebDriver } from './webdriver-process.mjs';

vi.mock('./webdriver-process.mjs', () => ({ spawnWebDriver: vi.fn() }));
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

for (const [mode, expected] of [[undefined, false], ['0', false], ['true', false], ['1', true]]) {
  test(`native E2E foreground assistance requires explicit native input mode (${mode ?? 'unset'})`, async () => {
    vi.resetModules();
    vi.stubEnv('SURTITLE_E2E_NATIVE_INPUT', mode);
    vi.stubEnv('SURTITLE_E2E_BINARY', 'C:\\owned\\surtitle.exe');
    const child = Object.assign(new EventEmitter(), { pid: 123, exitCode: null, signalCode: null, kill: vi.fn() });
    spawnWebDriver.mockReturnValue(child);
    const previousExitCode = process.exitCode;
    try {
      await import('./run-native-e2e.mjs');
      assert.equal(spawnWebDriver.mock.calls.length, 1);
      const [, args, options] = spawnWebDriver.mock.calls[0];
      assert.equal(args[1], '--surtitle-native-e2e-worker');
      assert.equal(options.env, process.env);
      assert.equal(options.foregroundApplication, expected ? process.env.SURTITLE_E2E_BINARY : undefined);
      child.exitCode = 0;
      child.emit('close', 0, null);
      assert.equal(child.kill.mock.calls.length, 0);
    } finally {
      // Release the runner's process listeners even if an assertion fails.
      child.exitCode = 0;
      child.emit('close', 0, null);
      process.exitCode = previousExitCode;
    }
  });
}
