// SPDX-License-Identifier: GPL-3.0-or-later
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const launcher = fileURLToPath(new URL('./run-windows-standard-user.ps1', import.meta.url));

// WebView2 150+ ignores WebDriver's environment overrides in elevated hosts.
// Keep the tested application intact and lower the entire driver process tree
// to restricted medium integrity, including for installed production binaries.
// The Windows launcher checks groups and privileges, independently of UAC mode.
export function spawnWebDriver(application, args, options = {}) {
  if (process.platform !== 'win32') return spawn(application, args, options);
  return spawn('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', launcher,
    '-Application', application, '-ArgumentsBase64', Buffer.from(JSON.stringify(args)).toString('base64')],
  { ...options, windowsHide: true });
}
