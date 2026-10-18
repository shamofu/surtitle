// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout } from 'node:timers/promises';

export function requireHostedWindows(environment = process.env, platform = process.platform) {
  assert(platform === 'win32' && environment.GITHUB_ACTIONS === 'true' && environment.CI === 'true'
    && environment.RUNNER_OS === 'Windows' && environment.RUNNER_ENVIRONMENT === 'github-hosted',
  'Desktop setup is restricted to GitHub-hosted Windows CI; local and self-hosted displays must not change.');
}
function validateSnapshot(snapshot) {
  for (const size of [snapshot.bounds, snapshot.workArea, snapshot.requiredOuter]) {
    assert(size && Number.isInteger(size.width) && size.width > 0 && Number.isInteger(size.height) && size.height > 0, 'Invalid desktop geometry');
  }
  assert(Number.isInteger(snapshot.dpi) && snapshot.dpi >= 96 && snapshot.dpi <= 768, 'Invalid desktop DPI');
  assert(snapshot.workArea.width <= snapshot.bounds.width && snapshot.workArea.height <= snapshot.bounds.height, 'Work area exceeds the monitor');
  // Covers the 1600x900 default and existing 1440x940 rendering checks.
  assert.deepEqual(snapshot.requiredClient, { width: 1600, height: 940 });
  assert(snapshot.requiredOuter.width >= Math.ceil(1600 * snapshot.dpi / 96) && snapshot.requiredOuter.height >= Math.ceil(940 * snapshot.dpi / 96), 'Window frame capacity omits the requested logical client');
}
export function assertDesktopCapacity(snapshot) {
  validateSnapshot(snapshot);
  assert(snapshot.bounds.width >= 1920 && snapshot.bounds.height >= 1080, 'Hosted desktop must be at least 1920x1080 physical pixels');
  assert(snapshot.workArea.width >= snapshot.requiredOuter.width && snapshot.workArea.height >= snapshot.requiredOuter.height,
    `Desktop work area ${snapshot.workArea.width}x${snapshot.workArea.height} cannot hold the 1600x940 test envelope at ${snapshot.dpi} DPI with its ${snapshot.requiredOuter.width}x${snapshot.requiredOuter.height} window frame`);
}
export function selectDesktopMode(snapshot) {
  validateSnapshot(snapshot);
  try { assertDesktopCapacity(snapshot); return null; } catch { /* Select a supported larger mode. */ }
  const insetWidth = snapshot.bounds.width - snapshot.workArea.width, insetHeight = snapshot.bounds.height - snapshot.workArea.height;
  const supported = snapshot.modes.filter(mode => Number.isInteger(mode.index) && mode.index >= 0 && mode.index < 4096
    && mode.bitsPerPixel === 32 && !mode.interlaced && mode.width >= 1920 && mode.height >= 1080
    && mode.width - insetWidth >= snapshot.requiredOuter.width && mode.height - insetHeight >= snapshot.requiredOuter.height);
  supported.sort((a, b) => a.width * a.height - b.width * b.height || b.frequency - a.frequency);
  assert(supported.length > 0, 'No supported desktop mode can fit the native test client and window frame; inspect the desktop receipt');
  return supported[0];
}

async function main() {
  // Guard before invoking PowerShell or writing evidence. Importing the pure
  // policy above is safe for local tests and never inspects/changes a display.
  requireHostedWindows();
  const receipt = { minimumDisplay: { width: 1920, height: 1080 }, passed: false };
  const evidence = resolve('work/test-results/windows-desktop.json');
  const inspect = (...args) => JSON.parse(execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', fileURLToPath(new URL('./ci-desktop.ps1', import.meta.url)), ...args], { encoding: 'utf8', windowsHide: true, timeout: 30000 }));
  try {
    receipt.before = inspect('-Action', 'inspect');
    receipt.selected = selectDesktopMode(receipt.before);
    receipt.after = receipt.selected ? inspect('-Action', 'apply', '-ModeIndex', String(receipt.selected.index), '-Width', String(receipt.selected.width), '-Height', String(receipt.selected.height)) : receipt.before;
    // Monitor work area can settle after WM_DISPLAYCHANGE. Re-read it; never
    // infer success solely from the requested mode or ChangeDisplaySettingsEx.
    for (let retry = 0; retry < 5; retry++) {
      try { assertDesktopCapacity(receipt.after); break; } catch { await setTimeout(500); receipt.after = inspect('-Action', 'inspect'); }
    }
    assertDesktopCapacity(receipt.after);
    receipt.passed = true;
    console.log(`Hosted desktop ready: ${receipt.after.bounds.width}x${receipt.after.bounds.height}, work area ${receipt.after.workArea.width}x${receipt.after.workArea.height}, ${receipt.after.dpi} DPI.`);
  } catch (error) { receipt.error = String(error.message ?? error); throw error; }
  finally { mkdirSync(resolve('work/test-results'), { recursive: true }); writeFileSync(evidence, JSON.stringify(receipt, null, 2) + '\n'); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
