// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

test.skipIf(process.platform !== 'win32')('VC prerequisite uses Windows PowerShell built-ins despite an incompatible inherited Security module', t => {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'surtitle VC modules 日本語 & ')));
  t.onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
  const powershell = join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const builtinModules = join(dirname(powershell), 'Modules');
  const shadowRoot = join(directory, 'modules'), shadow = join(shadowRoot, 'Microsoft.PowerShell.Security');
  mkdirSync(shadow, { recursive: true });
  // A discoverable but incompatible module mirrors an inherited PowerShell 7
  // module tree. Its command must never replace the Windows PowerShell built-in.
  writeFileSync(join(shadow, 'Microsoft.PowerShell.Security.psd1'), `@{
RootModule = 'Microsoft.PowerShell.Security.psm1'
ModuleVersion = '99.0.0'
PowerShellVersion = '7.0'
FunctionsToExport = @('Get-AuthenticodeSignature')
CmdletsToExport = @()
AliasesToExport = @()
}
`);
  writeFileSync(join(shadow, 'Microsoft.PowerShell.Security.psm1'), "throw 'The incompatible shadow Security module must not execute'\n");
  const unsigned = join(directory, 'unsigned.ps1');
  writeFileSync(unsigned, '# An unsigned local signature fixture; never executed.\n');
  const inheritedModules = shadowRoot + ';' + builtinModules;
  // Vitest also exports uppercase environment keys on Windows. Remove either
  // spelling so Node cannot choose the inherited value ahead of our fixture.
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath'));
  const script = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
if ($PSVersionTable.PSVersion.Major -ne 5 -or -not [Environment]::Is64BitProcess) { throw 'Expected x64 Windows PowerShell 5' }
if (-not $env:PSModulePath.StartsWith($env:SURTITLE_VC_SHADOW_ROOT + ';', [StringComparison]::OrdinalIgnoreCase)) { throw 'The incompatible module path was not inherited' }
if (@(Get-Module -Name Microsoft.PowerShell.Security).Count -ne 0) { throw 'Security must not already be imported' }
$tokens = $null
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($env:SURTITLE_VC_HELPER, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'The actual prerequisite helper did not parse' }
$functions = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $false))
if ($functions.Count -lt 1 -or $functions[0].Name -ne 'Test-MicrosoftSignature') { throw 'Expected the signature function immediately after helper initialization' }
$signatureFunctions = @($functions | Where-Object Name -eq 'Test-MicrosoftSignature')
if ($signatureFunctions.Count -ne 1) { throw 'Expected exactly one actual signature function' }
if ($env:SURTITLE_VC_INITIALIZE -eq '1') {
    # Execute the actual parameter/initialization/guard prefix, not a test copy.
    # Test-Prerequisite and the installer/download/registry body are never loaded.
    $source = [IO.File]::ReadAllText($env:SURTITLE_VC_HELPER)
    . ([ScriptBlock]::Create($source.Substring(0, $functions[0].Extent.StartOffset))) -CheckOnly
}
. ([ScriptBlock]::Create($signatureFunctions[0].Extent.Text))
$signatureVerified = $false
$unsignedRejected = $false
$errorId = $null
try {
    $signatureVerified = Test-MicrosoftSignature $env:SURTITLE_VC_SIGNED
    $unsignedRejected = -not (Test-MicrosoftSignature $env:SURTITLE_VC_UNSIGNED)
} catch { $errorId = $_.FullyQualifiedErrorId }
$security = Get-Module -Name Microsoft.PowerShell.Security
@{ signatureVerified=$signatureVerified; unsignedRejected=$unsignedRejected; errorId=$errorId;
   modulePath=$env:PSModulePath; securityModulePath=$security.Path } | ConvertTo-Json -Compress
`;
  const invoke = initialize => {
    const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      encoding: 'utf8', windowsHide: true, timeout: 15_000,
      env: { ...environment, PSModulePath: inheritedModules, SURTITLE_VC_SHADOW_ROOT: shadowRoot,
        SURTITLE_VC_HELPER: fileURLToPath(new URL('../native/vc-prerequisite.ps1', import.meta.url)),
        SURTITLE_VC_INITIALIZE: initialize ? '1' : '0', SURTITLE_VC_SIGNED: powershell, SURTITLE_VC_UNSIGNED: unsigned },
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const control = invoke(false);
  assert.equal(control.signatureVerified, false);
  assert.equal(control.unsignedRejected, false);
  assert.match(control.errorId, /^CouldNotAutoloadMatchingModule/);
  assert.equal(control.securityModulePath, null);
  const initialized = invoke(true);
  assert.equal(initialized.errorId, null);
  assert.equal(initialized.signatureVerified, true, 'The actual helper must verify a Microsoft-signed executable');
  assert.equal(initialized.unsignedRejected, true, 'An unsigned file must still fail signature verification');
  assert.equal(realpathSync.native(initialized.modulePath), realpathSync.native(builtinModules));
  assert.equal(realpathSync.native(initialized.securityModulePath),
    realpathSync.native(join(builtinModules, 'Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1')));
}, 35_000);
