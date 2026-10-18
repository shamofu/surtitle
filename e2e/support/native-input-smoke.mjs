// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireHostedWindows } from './prepare-ci-desktop.mjs';

export function assertNativeInputSmoke(receipt) {
  assert.equal(receipt.passed, true, receipt.error || 'Native input smoke did not pass');
  assert.equal(receipt.foregroundConfirmed, true, 'The smoke window never acknowledged foreground');
  assert.equal(receipt.cursorConfirmed, true, 'The cursor never reached the owned smoke point');
  assert.equal(receipt.buttonUps, 1, 'The owned window must receive exactly one native click');
}

// Also callable explicitly by local verification; the CLI is hosted-CI-only.
export function runNativeInputSmoke(evidence = resolve('work/test-results/windows-input-smoke.json')) {
  assert.equal(process.platform, 'win32', 'Native input smoke requires Windows');
  const application = resolve(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const script = fileURLToPath(new URL('./native-input-smoke.ps1', import.meta.url));
  const launcher = fileURLToPath(new URL('./run-windows-standard-user.ps1', import.meta.url));
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script];
  const receipt = { passed: false };
  try {
    const result = spawnSync('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', launcher,
      '-Application', application, '-ArgumentsBase64', Buffer.from(JSON.stringify(args)).toString('base64'),
      '-ForegroundApplication', application], { encoding: 'utf8', windowsHide: true, timeout: 45000 });
    receipt.launcherDiagnostics = result.stderr;
    if (result.stdout) receipt.probe = JSON.parse(result.stdout);
    if (result.error) throw result.error;
    assert.equal(result.status, 0, `Native input smoke failed: ${result.stderr}\n${result.stdout}`);
    assert.equal(result.signal, null, 'Native input smoke was terminated');
    assertNativeInputSmoke(receipt.probe);
    receipt.passed = true;
    return receipt;
  } catch (error) {
    receipt.error = error.message;
    if (error.stdout) { try { receipt.probe = JSON.parse(error.stdout); } catch { receipt.stdout = String(error.stdout); } }
    if (error.stderr) receipt.stderr = String(error.stderr);
    throw error;
  } finally {
    mkdirSync(dirname(evidence), { recursive: true });
    writeFileSync(evidence, `${JSON.stringify(receipt, null, 2)}\n`);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    requireHostedWindows();
    runNativeInputSmoke();
    console.log('Medium native input verified: owned foreground, cursor movement and native click acknowledged.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
