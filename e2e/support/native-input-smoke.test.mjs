// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { assertNativeInputSmoke } from './native-input-smoke.mjs';

test('requires acknowledged foreground, movement and exactly one delivered native click', () => {
  const valid = { passed: true, foregroundConfirmed: true, cursorConfirmed: true, buttonUps: 1 };
  assertNativeInputSmoke(valid);
  for (const field of ['passed', 'foregroundConfirmed', 'cursorConfirmed'])
    assert.throws(() => assertNativeInputSmoke({ ...valid, [field]: false }));
  for (const buttonUps of [0, 2, undefined]) assert.throws(() => assertNativeInputSmoke({ ...valid, buttonUps }));
});

test('CLI rejects local invocation before launching a window or writing evidence', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'surtitle-input-smoke-'));
  try {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./native-input-smoke.mjs', import.meta.url))],
      { cwd, encoding: 'utf8', windowsHide: true, env: { ...process.env, CI: '', GITHUB_ACTIONS: '', RUNNER_ENVIRONMENT: '' } });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /restricted to GitHub-hosted/);
    assert.deepEqual(readdirSync(cwd), []);
  } finally { rmSync(cwd, { recursive: true }); }
});

test.runIf(process.platform === 'win32')('compiles the real native smoke without showing a window', () => {
  const application = join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  execFileSync(application, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    "Add-Type -Path $env:SURTITLE_INPUT_SMOKE_SOURCE -ReferencedAssemblies System.Windows.Forms, System.Drawing -ErrorAction Stop"],
  { encoding: 'utf8', windowsHide: true, timeout: 30000,
    env: { ...process.env, SURTITLE_INPUT_SMOKE_SOURCE: fileURLToPath(new URL('./native-input-smoke.cs', import.meta.url)) } });
}, 35000);
