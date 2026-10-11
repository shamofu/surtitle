// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { assertDesktopCapacity, requireHostedWindows, selectDesktopMode } from './prepare-ci-desktop.mjs';

const hosted = { CI: 'true', GITHUB_ACTIONS: 'true', RUNNER_OS: 'Windows', RUNNER_ENVIRONMENT: 'github-hosted' };
function snapshot(width = 1024, height = 768, dpi = 96) {
  const scale = dpi / 96;
  return {
    bounds: { width, height }, workArea: { width, height: height - 48 }, dpi,
    requiredClient: { width: 1440, height: 940 }, requiredOuter: { width: Math.ceil(1456 * scale), height: Math.ceil(979 * scale) },
    modes: [[1024, 768], [1920, 1080], [2560, 1440], [3840, 2160]].map(([width, height], index) => ({ index, width, height, bitsPerPixel: 32, frequency: 60, interlaced: false })),
  };
}
test('only the ephemeral GitHub-hosted Windows environment is eligible', () => {
  requireHostedWindows(hosted, 'win32');
  for (const key of Object.keys(hosted)) assert.throws(() => requireHostedWindows({ ...hosted, [key]: '' }, 'win32'), /restricted to GitHub-hosted/);
  assert.throws(() => requireHostedWindows({ ...hosted, RUNNER_ENVIRONMENT: 'self-hosted' }, 'win32'), /restricted to GitHub-hosted/);
  assert.throws(() => requireHostedWindows(hosted, 'linux'), /restricted to GitHub-hosted/);
});
test('selects the smallest supported full-HD mode for the observed 1024x720 work area', () => {
  const observed = snapshot(), original = structuredClone(observed);
  assert.equal(selectDesktopMode(observed).index, 1);
  assert.deepEqual(observed, original);
  assert.throws(() => assertDesktopCapacity(observed), /at least 1920x1080/);
});
test('keeps a sufficient desktop unchanged and validates the observed result after a change', () => {
  assert.equal(selectDesktopMode(snapshot(1920, 1080)), null);
  assertDesktopCapacity(snapshot(1920, 1080));
  const unchanged = snapshot(); selectDesktopMode(unchanged);
  assert.throws(() => assertDesktopCapacity(unchanged), /at least 1920x1080/);
});
test('accounts for actual DPI, window frame and taskbar instead of only raw resolution', () => {
  const scaled = snapshot(1920, 1080, 144);
  assert.throws(() => assertDesktopCapacity(scaled), /144 DPI/);
  assert.equal(selectDesktopMode(scaled).width, 3840);
  assertDesktopCapacity(snapshot(3840, 2160, 144));
  const tallTaskbar = snapshot(1920, 1080); tallTaskbar.workArea.height = 950;
  assert.throws(() => assertDesktopCapacity(tallTaskbar), /work area/);
  assert.equal(selectDesktopMode(tallTaskbar).width, 2560);
});
test('fails early when all fitting modes are unsupported and rejects invalid capacity data', () => {
  const unavailable = snapshot();
  unavailable.modes[1].bitsPerPixel = 16;
  unavailable.modes[2].interlaced = true;
  unavailable.modes.pop();
  assert.throws(() => selectDesktopMode(unavailable), /No supported desktop mode/);
  const missingFrame = snapshot(1920, 1080, 144); missingFrame.requiredOuter = { width: 1456, height: 979 };
  assert.throws(() => assertDesktopCapacity(missingFrame), /omits the requested logical client/);
});
test('the CLI rejects a local invocation before interop or evidence writes', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'surtitle-ci-desktop-'));
  try {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./prepare-ci-desktop.mjs', import.meta.url))], { cwd, encoding: 'utf8', env: { ...process.env, CI: '', GITHUB_ACTIONS: '', RUNNER_ENVIRONMENT: '' }, windowsHide: true });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /restricted to GitHub-hosted/);
    assert.deepEqual(readdirSync(cwd), []);
  } finally { rmSync(cwd, { recursive: true }); }
});
test.runIf(process.platform === 'win32')('compiles the Win32 layout and refuses local interop without calling display APIs', () => {
  const result = execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', `
    $ErrorActionPreference = 'Stop'
    Add-Type -Path $env:SURTITLE_CI_DESKTOP_SOURCE
    if ([Runtime.InteropServices.Marshal]::SizeOf([type][SurtitleCiDesktop+DevMode]) -ne 220) { throw 'Invalid DEVMODEW layout' }
    try { [SurtitleCiDesktop]::RequireHostedRunner(); throw 'Unexpected local permission' }
    catch { if ($_.Exception.Message -notmatch 'restricted to GitHub-hosted') { throw }; 'Local display untouched' }
  `], { encoding: 'utf8', windowsHide: true, env: { ...process.env, CI: '', GITHUB_ACTIONS: '', RUNNER_ENVIRONMENT: '', SURTITLE_CI_DESKTOP_SOURCE: fileURLToPath(new URL('./ci-desktop.cs', import.meta.url)) } });
  assert.match(result, /Local display untouched/);
}, 15000);
test('both native Windows jobs prepare desktop capacity before Rust or application builds and retain the receipt', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  for (const [job, next] of [['windows', 'package'], ['package', 'ci']]) {
    const section = workflow.split(`  ${job}:`)[1].split(`  ${next}:`)[0];
    const setup = section.indexOf('node e2e/support/prepare-ci-desktop.mjs');
    assert(setup > section.indexOf('uses: actions/setup-node@'));
    assert(setup < section.indexOf('Read the native Rust toolchain pin'));
    assert.match(section, /test-results\//);
  }
});
