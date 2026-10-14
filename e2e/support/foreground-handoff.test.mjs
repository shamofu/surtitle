// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, test, vi } from 'vitest';
import { spawnWebDriver } from './webdriver-process.mjs';

vi.mock('node:child_process', async importOriginal => ({ ...await importOriginal(), spawn: vi.fn() }));
afterEach(() => vi.clearAllMocks());

test('foreground handoff is an explicit outer-launcher option and never leaks into spawn options', () => {
  const application = 'C:\\owned\\driver.exe', foregroundApplication = 'C:\\owned\\app 日本語.exe';
  const env = { SURTITLE_E2E_BINARY: foregroundApplication };
  spawnWebDriver(application, ['literal & argument'], { env, foregroundApplication, stdio: 'pipe' });
  const [command, args, options] = spawn.mock.calls[0];
  assert.equal(options.env, env);
  assert.equal(options.stdio, 'pipe');
  assert.equal(Object.hasOwn(options, 'foregroundApplication'), false);
  if (process.platform === 'win32') {
    assert.equal(command, 'pwsh.exe');
    assert.deepEqual(args.slice(-2), ['-ForegroundApplication', foregroundApplication]);
    assert.equal(options.windowsHide, true);
  } else assert.equal(command, application);

  spawnWebDriver(application, [], { env });
  assert.equal(spawn.mock.calls[1][1].includes('-ForegroundApplication'), false,
    'Nested driver launches must not infer foreground authority from inherited environment');
});

test.runIf(process.platform === 'win32')('the actual C# foreground gate rejects foreign job, executable, token and HWND identities without interop', () => {
  const result = spawnSync('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `
    $ErrorActionPreference = 'Stop'
    Add-Type -Path $env:SURTITLE_FOREGROUND_SOURCE
    foreach ($integrity in @(4096, 8192, 8448)) {
      if ([SurtitleWindowsStandardUser]::RequiresForegroundHandoff($integrity)) { throw 'Ordinary local parent must not attempt foreground handoff' }
    }
    foreach ($integrity in @(12288, 16384)) {
      if (-not [SurtitleWindowsStandardUser]::RequiresForegroundHandoff($integrity)) { throw 'High parent must monitor its explicitly configured application' }
    }
    function New-Identity {
      $value = [SurtitleWindowsStandardUser+ForegroundIdentity]::new()
      $value.processId = 123; $value.creationTime = 456
      $value.executablePath = 'C:\\owned\\app.exe'; $value.userSid = 'S-1-5-21-1'
      $value.sessionId = 1; $value.integrity = 8192; $value.inJob = $true
      $value.window = 1234; $value.root = 1234; $value.owner = 0; $value.visible = $true
      return $value
    }
    function Validate($value) {
      [SurtitleWindowsStandardUser]::ValidateForegroundIdentity($value, 'C:\\owned\\APP.EXE', 'S-1-5-21-1', 1)
    }
    Validate (New-Identity)
    $cases = @(
      @{ name = 'unowned-job'; property = 'inJob'; value = $false },
      @{ name = 'missing-process'; property = 'processId'; value = 0 },
      @{ name = 'missing-creation'; property = 'creationTime'; value = 0 },
      @{ name = 'foreign-image'; property = 'executablePath'; value = 'C:\\other\\app.exe' },
      @{ name = 'foreign-user'; property = 'userSid'; value = 'S-1-5-21-2' },
      @{ name = 'foreign-session'; property = 'sessionId'; value = 2 },
      @{ name = 'elevated'; property = 'integrity'; value = 12288 },
      @{ name = 'low'; property = 'integrity'; value = 4096 },
      @{ name = 'zero-window'; property = 'window'; value = 0 },
      @{ name = 'child-window'; property = 'root'; value = 5678 },
      @{ name = 'owned-popup'; property = 'owner'; value = 5678 },
      @{ name = 'hidden-window'; property = 'visible'; value = $false }
    )
    foreach ($case in $cases) {
      $value = New-Identity; $value.($case.property) = $case.value
      $rejected = $false
      try { Validate $value } catch { $rejected = $true }
      if (-not $rejected) { throw ('Accepted invalid foreground target: ' + $case.name) }
    }
    # Invalid explicit configuration must fail before any child creation or UI calls.
    try {
      [SurtitleWindowsStandardUser]::Run('unused.exe', [string[]]@(), $PWD.Path, 'relative.exe')
      throw 'Accepted a relative foreground application'
    } catch { if ($_.Exception.Message -notmatch 'existing absolute .exe path') { throw } }
    'Validated 12 identity refusals without native UI access'
  `], { encoding: 'utf8', windowsHide: true, timeout: 30000,
    env: { ...process.env, SURTITLE_FOREGROUND_SOURCE: fileURLToPath(new URL('./windows-standard-user.cs', import.meta.url)) } });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  assert.match(result.stdout, /Validated 12 identity refusals/);
});
