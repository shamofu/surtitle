// SPDX-License-Identifier: GPL-3.0-or-later
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const launcher = fileURLToPath(new URL('./run-windows-standard-user.ps1', import.meta.url));

// Native probes and profile observers must share the application's standard-user
// permissions. The launcher verifies the actual token and owns the child tree.
export function spawnStandardUser(application, args, options = {}) {
  const { foregroundApplication, ...spawnOptions } = options;
  if (process.platform !== 'win32') return spawn(application, args, spawnOptions);
  return spawn('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', launcher,
    '-Application', application, '-ArgumentsBase64', Buffer.from(JSON.stringify(args)).toString('base64'),
    ...(foregroundApplication ? ['-ForegroundApplication', foregroundApplication] : [])],
  { ...spawnOptions, windowsHide: true });
}
