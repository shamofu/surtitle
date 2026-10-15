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
    requiredClient: { width: 1600, height: 940 }, requiredOuter: { width: Math.ceil(1616 * scale), height: Math.ceil(979 * scale) },
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

test('reserves the new default width as well as the existing tallest native fixture', () => {
  const initialWindow = JSON.parse(readFileSync(new URL('../../src-tauri/tauri.conf.json', import.meta.url), 'utf8')).app.windows[0];
  const required = snapshot(1920, 1080).requiredClient;
  assert(required.width >= initialWindow.width && required.height >= initialWindow.height);
  const narrowWorkArea = snapshot(1920, 1080); narrowWorkArea.workArea.width = 1500;
  assert.throws(() => assertDesktopCapacity(narrowWorkArea), /1600x940/);
  assert.equal(selectDesktopMode(narrowWorkArea).width, 2560);
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
    # Read only this PowerShell process; HWND zero cannot name a hide target.
    $probe = [SurtitleCiDesktop].GetMethod('RunnerTerminalState', [Reflection.BindingFlags]'NonPublic,Static')
    $identity = $probe.Invoke($null, [object[]]@([IntPtr]::new(-1), [IntPtr]::Zero))
    if ([IO.Path]::GetFileName($identity.executablePath) -ine 'pwsh.exe' -or $identity.creationTime -le 0) { throw 'Current process identity was not read correctly' }
    if ($identity.userSid -ne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value -or $identity.window.hwnd -ne '0x0') { throw 'Current token user or zero-window probe changed' }
    try { [SurtitleCiDesktop]::RequireHostedRunner(); throw 'Unexpected local permission' }
    catch { if ($_.Exception.Message -notmatch 'restricted to GitHub-hosted') { throw }; 'Local display untouched' }
    try { [SurtitleCiDesktop]::PrepareInputConsole(); throw 'Unexpected local console access' }
    catch { if ($_.Exception.Message -notmatch 'restricted to GitHub-hosted') { throw }; 'Local console untouched' }
  `], { encoding: 'utf8', windowsHide: true, env: { ...process.env, CI: '', GITHUB_ACTIONS: '', RUNNER_ENVIRONMENT: '', SURTITLE_CI_DESKTOP_SOURCE: fileURLToPath(new URL('./ci-desktop.cs', import.meta.url)) } });
  assert.match(result, /Local display untouched/);
  assert.match(result, /Local console untouched/);
}, 15000);

test.runIf(process.platform === 'win32')('console preparation refuses local and self-hosted runs before creating evidence', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'surtitle-ci-console-'));
  try {
    for (const environment of [{}, { ...hosted, RUNNER_ENVIRONMENT: 'self-hosted' }]) {
      const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File',
        fileURLToPath(new URL('./ci-desktop.ps1', import.meta.url)), '-Action', 'prepare-input'], {
        cwd, encoding: 'utf8', windowsHide: true,
        env: { ...process.env, CI: '', GITHUB_ACTIONS: '', RUNNER_ENVIRONMENT: '', ...environment },
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /restricted to GitHub-hosted/);
      assert.deepEqual(readdirSync(cwd), []);
    }
  } finally { rmSync(cwd, { recursive: true }); }
}, 15000);

test.runIf(process.platform === 'win32')('detached runner terminal policy rejects foreign owners and changed foreground process identities', () => {
  // Exercise only the pure identity checks. No hosted environment is fabricated
  // and no native window/process discovery or visibility API is invoked.
  const result = execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', String.raw`
    $ErrorActionPreference = 'Stop'
    Add-Type -Path $env:SURTITLE_CI_DESKTOP_SOURCE
    function New-Identity {
      [SurtitleCiDesktop+RunnerTerminalIdentity]@{
        window = [SurtitleCiDesktop+InputWindow]@{
          hwnd = '0x123'; processId = 42; sessionId = 2
          className = 'CASCADIA_HOSTING_WINDOW_CLASS'; visible = $true
        }
        executablePath = 'C:\Program Files\WindowsApps\Microsoft.WindowsTerminal_1.0_x64__8wekyb3d8bbwe\WindowsTerminal.exe'
        creationTime = 123456789; userSid = 'S-1-5-21-1-2-3-1001'
        packageFamilyName = 'Microsoft.WindowsTerminal_8wekyb3d8bbwe'
      }
    }
    function Assert-Rejected([scriptblock]$action) {
      try { & $action } catch { return }
      throw 'An unrelated or changed terminal identity was accepted'
    }
    $original = New-Identity
    foreach ($family in @('Microsoft.WindowsTerminal_8wekyb3d8bbwe', 'Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe', $null)) {
      $candidate = New-Identity
      # PowerShell coerces a null string-property assignment to an empty string.
      $candidate.GetType().GetProperty('packageFamilyName').SetValue($candidate, $family)
      [SurtitleCiDesktop]::ValidateRunnerTerminal($candidate, 2, $original.userSid)
    }
    $cases = @(
      @{ userSid = 'S-1-5-21-1-2-3-1002' },
      @{ executablePath = 'C:\Tools\pwsh.exe' },
      @{ executablePath = 'WindowsTerminal.exe' },
      @{ creationTime = 0 },
      @{ packageFamilyName = 'Unrelated.Package_untrusted' }
    )
    foreach ($change in $cases) {
      $candidate = New-Identity
      foreach ($key in $change.Keys) { $candidate.$key = $change[$key] }
      Assert-Rejected { [SurtitleCiDesktop]::ValidateRunnerTerminal($candidate, 2, $original.userSid) }
    }
    foreach ($change in @(@{ hwnd = '0x0' }, @{ processId = 0 }, @{ sessionId = 3 }, @{ className = 'UnrelatedWindow' })) {
      $candidate = New-Identity
      foreach ($key in $change.Keys) { $candidate.window.$key = $change[$key] }
      Assert-Rejected { [SurtitleCiDesktop]::ValidateRunnerTerminal($candidate, 2, $original.userSid) }
    }
    foreach ($change in @(@{ hwnd = '0x456' }, @{ processId = 43 }, @{ sessionId = 3 }, @{ className = 'UnrelatedWindow' })) {
      $candidate = New-Identity
      foreach ($key in $change.Keys) { $candidate.window.$key = $change[$key] }
      Assert-Rejected { [SurtitleCiDesktop]::ValidateSameRunnerTerminal($original, $candidate) }
    }
    foreach ($change in @(@{ creationTime = 123456790 }, @{ userSid = 'S-1-5-21-1-2-3-1002' }, @{ executablePath = 'C:\Other\WindowsTerminal.exe' }, @{ packageFamilyName = 'Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe' })) {
      $candidate = New-Identity
      foreach ($key in $change.Keys) { $candidate.$key = $change[$key] }
      Assert-Rejected { [SurtitleCiDesktop]::ValidateSameRunnerTerminal($original, $candidate) }
    }
    $hidden = New-Identity
    $hidden.window.visible = $false
    [SurtitleCiDesktop]::ValidateSameRunnerTerminal($original, $hidden)
    'Runner terminal ownership policy verified without native input'
  `], { encoding: 'utf8', windowsHide: true, env: { ...process.env, CI: '', GITHUB_ACTIONS: '', RUNNER_ENVIRONMENT: '', SURTITLE_CI_DESKTOP_SOURCE: fileURLToPath(new URL('./ci-desktop.cs', import.meta.url)) } });
  assert.match(result, /Runner terminal ownership policy verified without native input/);
}, 15000);
test('both native Windows jobs prepare desktop capacity before Rust or application builds and retain the receipt', () => {
  const lines = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8').split(/\r?\n/);
  for (const job of ['windows', 'package']) {
    const start = lines.findIndex(line => line === `  ${job}:`);
    assert(start >= 0, `${job} job must exist`);
    const next = lines.findIndex((line, index) => index > start && /^  [\w-]+:/.test(line));
    const steps = lines.slice(start, next < 0 ? undefined : next).join('\n').split(/^      - /m).slice(1);
    // Compare executable steps, independently of their display names and of
    // which job follows this one in the workflow.
    const node = steps.findIndex(step => /uses: actions\/setup-node@/.test(step));
    const setup = steps.findIndex(step => step.includes('node e2e/support/prepare-ci-desktop.mjs'));
    const rust = steps.findIndex(step => /uses: dtolnay\/rust-toolchain@/.test(step));
    assert(node >= 0 && setup > node, `${job} must prepare the desktop after installing Node`);
    assert(rust > setup, `${job} must prepare the desktop before setting up Rust`);
    const uploads = steps.filter(step => /uses: actions\/upload-artifact@/.test(step));
    assert(uploads.some(step => step.includes('always()') && step.split('\n').some(line =>
      ['test-results/', 'test-results/windows-desktop.json'].includes(line.trim()))),
    `${job} must retain the desktop receipt even after a failed run`);
  }
});
