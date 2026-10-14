// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireHostedWindows } from './prepare-ci-desktop.mjs';

export function assertNativeInputDesktop(snapshot) {
  assert.equal(snapshot.integrity, '8192', 'Native input preflight must use the same medium integrity as the application');
  assert.equal(typeof snapshot.stationName, 'string', 'The restricted process could not inspect its window station');
  assert((snapshot.stationFlags?.flags & 1) !== 0, `Window station ${snapshot.stationName} is not interactive`);
  assert.equal(snapshot.threadDesktopIsInput, true,
    `The restricted thread desktop is not receiving input: ${JSON.stringify(snapshot.threadDesktopIsInput)}`);
  assert.equal(snapshot.inputDesktopError, 0,
    `The restricted process cannot open the input desktop: ${JSON.stringify(snapshot.inputDesktopName)}`);
  assert.equal(typeof snapshot.threadDesktopName, 'string', 'The restricted process could not inspect its thread desktop');
  assert.equal(snapshot.threadDesktopName, snapshot.inputDesktopName, 'The restricted process is attached to a different desktop than the input desktop');
  const stationHandle = snapshot.stationHandleAccess;
  assert(stationHandle?.ntStatus === '0x00000000' && stationHandle.returnedSize === 56
    && Number.isInteger(stationHandle.grantedAccess) && stationHandle.grantedAccess >= 0 && stationHandle.grantedAccess <= 0xffffffff,
    `The restricted process could not query its existing window station handle access: ${JSON.stringify(stationHandle)}`);
  assert((stationHandle.grantedAccess & 0x10) !== 0,
    `The restricted process's existing window station handle lacks WINSTA_WRITEATTRIBUTES: ${stationHandle.grantedAccessHex}. A successful fresh open does not grant access to the existing handle; inspect windows-input-desktop.json`);
  assert.equal(snapshot.writeAttributesAccess, true,
    `The restricted process cannot obtain WINSTA_WRITEATTRIBUTES on ${snapshot.stationName}: Win32Error=${snapshot.writeAttributesError} (${snapshot.writeAttributesMessage}). Native cursor input is not available; inspect the parent/restricted security descriptors in windows-input-desktop.json`);
}

async function main() {
  requireHostedWindows();
  const evidence = resolve('test-results/windows-input-desktop.json');
  const script = fileURLToPath(new URL('./native-video-click.ps1', import.meta.url));
  const launcher = fileURLToPath(new URL('./run-windows-standard-user.ps1', import.meta.url));
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script, '-InspectInputDesktop'];
  const options = { encoding: 'utf8', windowsHide: true, timeout: 30000 };
  const receipt = { passed: false };
  try {
    // Both probes only query handles/token information. They never call an
    // activation/input API or change a window station, desktop, token or ACL.
    receipt.parent = JSON.parse(execFileSync('pwsh.exe', args, options));
    receipt.restricted = JSON.parse(execFileSync('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', launcher,
      '-Application', 'pwsh.exe', '-ArgumentsBase64', Buffer.from(JSON.stringify(args)).toString('base64')], options));
    assertNativeInputDesktop(receipt.restricted);
    receipt.passed = true;
    console.log(`Restricted native input desktop ready: ${receipt.restricted.stationName}\\${receipt.restricted.threadDesktopName}, medium integrity, WINSTA_WRITEATTRIBUTES granted.`);
  } catch (error) {
    receipt.error = error.message ?? String(error);
    throw error;
  } finally {
    mkdirSync(resolve('test-results'), { recursive: true });
    writeFileSync(evidence, `${JSON.stringify(receipt, null, 2)}\n`);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
