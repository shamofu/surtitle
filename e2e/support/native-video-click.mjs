// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const script = fileURLToPath(new URL('./native-video-click.ps1', import.meta.url));

async function nativePointer(args = []) {
  assert.equal(process.platform, 'win32', 'Native video pointer input requires Windows');
  const application = process.env.SURTITLE_E2E_BINARY;
  assert(application && isAbsolute(application), 'Set an absolute test binary for native video input');
  const { stdout } = await execute('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script,
    '-Application', application, ...args], { windowsHide: true, timeout: 15000 });
  return JSON.parse(stdout);
}
/** Activate the uniquely identified test window, using its verified caption when needed. */
export const activateNativeApplication = () => nativePointer(['-ActivateOnly']);
/** Click uncovered owned video after verified test-window activation. */
export const clickNativeVideo = () => nativePointer();
