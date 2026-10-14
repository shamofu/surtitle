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
      $value.className = 'Tauri Window'; $value.style = 0x14cf0000; $value.extendedStyle = 0x40100
      $value.clientWidth = 1440; $value.clientHeight = 900; $value.outerWidth = 1456; $value.outerHeight = 939
      return $value
    }
    function Validate($value) {
      [SurtitleWindowsStandardUser]::ValidateForegroundIdentity($value, 'C:\\owned\\APP.EXE', 'S-1-5-21-1', 1)
    }
    Validate (New-Identity)
    $smoke = New-Identity
    $smoke.className = 'WindowsForms10.Window.8.app.0.example'; $smoke.style = 0x14cc0000
    $smoke.clientWidth = 360; $smoke.clientHeight = 160
    Validate $smoke
    $otherDecorated = New-Identity; $otherDecorated.className = 'A normal decorated test window'
    Validate $otherDecorated
    $namedLikeUtility = New-Identity; $namedLikeUtility.className = 'Tao Thread Event Target'
    Validate $namedLikeUtility
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
      @{ name = 'hidden-window'; property = 'visible'; value = $false },
      @{ name = 'missing-class'; property = 'className'; value = '' },
      @{ name = 'popup-style'; property = 'style'; value = [uint32]0x94cf0000L },
      @{ name = 'child-style'; property = 'style'; value = [uint32]0x54cf0000L },
      @{ name = 'disabled-style'; property = 'style'; value = [uint32]0x1ccf0000L },
      @{ name = 'no-frame'; property = 'style'; value = [uint32]0x140f0000L },
      @{ name = 'no-system-menu'; property = 'style'; value = [uint32]0x14c70000L },
      @{ name = 'tool-window'; property = 'extendedStyle'; value = 0x80 },
      @{ name = 'no-activate'; property = 'extendedStyle'; value = 0x08000000 },
      @{ name = 'transparent-input'; property = 'extendedStyle'; value = 0x20 },
      @{ name = 'empty-client-width'; property = 'clientWidth'; value = 0 },
      @{ name = 'empty-client-height'; property = 'clientHeight'; value = 0 },
      @{ name = 'empty-outer-width'; property = 'outerWidth'; value = 0 },
      @{ name = 'empty-outer-height'; property = 'outerHeight'; value = 0 }
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
    ('Validated ' + $cases.Count + ' identity refusals without native UI access')
  `], { encoding: 'utf8', windowsHide: true, timeout: 30000,
    env: { ...process.env, SURTITLE_FOREGROUND_SOURCE: fileURLToPath(new URL('./windows-standard-user.cs', import.meta.url)) } });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  assert.match(result.stdout, /Validated 25 identity refusals/);
});

test.runIf(process.platform === 'win32')('discovery can ignore an unidentified denied image while confirmed image reads remain fatal', () => {
  const result = spawnSync('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `
    $ErrorActionPreference = 'Stop'
    Add-Type -Path $env:SURTITLE_FOREGROUND_SOURCE
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
public static class SurtitleForegroundImageReaders {
  public static int Calls;
  public static string Denied() { Calls++; throw new Win32Exception(5, "Image query denied"); }
  public static string InvalidHandle() { Calls++; throw new Win32Exception(6, "Invalid image handle"); }
  public static string InvalidOwnership() { Calls++; throw new InvalidOperationException("Ownership changed"); }
  public static string Image() { Calls++; return @"C:\\owned\\app.exe"; }
}
'@
    function Reader([string]$name) {
      return [Delegate]::CreateDelegate([Func[string]], [SurtitleForegroundImageReaders].GetMethod($name))
    }
    $denied = Reader 'Denied'
    if ($null -ne [SurtitleWindowsStandardUser]::ReadForegroundProcessImage($denied, $false)) {
      throw 'Unknown denied process became an identified image'
    }
    foreach ($case in @(
      @{ reader = $denied; confirmed = $true; message = 'Image query denied' },
      @{ reader = (Reader 'InvalidHandle'); confirmed = $false; message = 'Invalid image handle' },
      @{ reader = (Reader 'InvalidOwnership'); confirmed = $false; message = 'Ownership changed' }
    )) {
      $rejected = $false
      try { [SurtitleWindowsStandardUser]::ReadForegroundProcessImage($case.reader, $case.confirmed) }
      catch {
        if ($_.Exception.Message -notmatch $case.message) { throw }
        $rejected = $true
      }
      if (-not $rejected) { throw 'An identity or ownership failure was swallowed' }
    }
    if ([SurtitleWindowsStandardUser]::ReadForegroundProcessImage((Reader 'Image'), $false) -ne 'C:\\owned\\app.exe') {
      throw 'Readable discovery image changed'
    }
    if ([SurtitleForegroundImageReaders]::Calls -ne 5) { throw 'Unexpected image reader calls' }
    'Discovery and confirmed reads remain distinct'
  `], { encoding: 'utf8', windowsHide: true, timeout: 30000,
    env: { ...process.env, SURTITLE_FOREGROUND_SOURCE: fileURLToPath(new URL('./windows-standard-user.cs', import.meta.url)) } });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  assert.match(result.stdout, /Discovery and confirmed reads remain distinct/);
});
