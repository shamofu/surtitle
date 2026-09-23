// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('VC prerequisite manifest pins the actual hook and helper bytes', () => {
  const manifest = JSON.parse(readFileSync(new URL('../native/runtime-windows-x64.json', import.meta.url), 'utf8'));
  const prerequisites = manifest.prerequisites.filter(item => item.id === 'microsoft-vc-runtime-x64');
  assert.equal(prerequisites.length, 1);
  const prerequisite = prerequisites[0];
  for (const [field, path] of [['hook', 'native/windows-prerequisite.nsh'], ['helper', 'native/vc-prerequisite.ps1']]) {
    assert.equal(prerequisite[`${field}Path`], path);
    assert.match(prerequisite[`${field}Sha256`], /^[a-f0-9]{64}$/);
    const actual = createHash('sha256').update(readFileSync(new URL('../' + path, import.meta.url))).digest('hex');
    assert.equal(prerequisite[`${field}Sha256`], actual, `VC prerequisite ${field} hash must match the committed input bytes`);
  }
});

test.skipIf(process.platform !== 'win32')('VC prerequisite resolves its adjacent manifest under Windows PowerShell -File and honors explicit paths', t => {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'surtitle VC manifest 日本語 & ')));
  t.onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
  const helper = join(directory, 'vc-prerequisite.ps1');
  copyFileSync(new URL('../native/vc-prerequisite.ps1', import.meta.url), helper);
  const cwd = join(directory, 'caller');
  mkdirSync(cwd);
  writeFileSync(join(cwd, 'runtime-windows-x64.json'), '{}');
  const manifest = version => JSON.stringify({ prerequisites: [{
    id: 'microsoft-vc-runtime-x64', minimumVersion: version,
    downloadUrl: 'https://example.invalid/never-download.exe', requiredSystemFiles: ['vcruntime_future.dll'],
  }] });
  writeFileSync(join(directory, 'runtime-windows-x64.json'), manifest('65535.0.0.0'));
  const explicit = join(directory, 'explicit.json');
  writeFileSync(explicit, manifest('65534.0.0.0'));
  const powershell = join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const invoke = args => {
    const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper, '-CheckOnly', ...args], {
      cwd, encoding: 'utf8', windowsHide: true, timeout: 15_000,
    });
    assert.ifError(result.error);
    return result;
  };
  for (const [args, version] of [[[], '65535.0.0'], [['-ManifestPath', explicit], '65534.0.0']]) {
    const result = invoke(args);
    assert.equal(result.status, 10, result.stdout + result.stderr);
    assert.ok(result.stdout.includes(`Runtime ${version} or newer`), result.stdout);
  }
  const missing = invoke(['-ManifestPath', join(directory, 'missing.json')]);
  assert.equal(missing.status, 12, missing.stdout + missing.stderr);
  assert.match(missing.stdout, /prerequisite input could not be read/);
}, 50_000);

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
  const manifestPath = join(directory, 'runtime-windows-x64.json');
  const prerequisite = { id: 'microsoft-vc-runtime-x64', minimumVersion: '14.99.12345.1',
    downloadUrl: 'https://example.invalid/new-vc.exe', requiredSystemFiles: ['vcruntime_future.dll'] };
  writeFileSync(manifestPath, JSON.stringify({ prerequisites: [prerequisite] }));
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
    . ([ScriptBlock]::Create($source.Substring(0, $functions[0].Extent.StartOffset))) -CheckOnly -ManifestPath $env:SURTITLE_VC_MANIFEST
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
   minimumVersion=[string]$minimum; minimumDisplay=$minimumDisplay; downloadUrl=$downloadUrl; requiredSystemFiles=$prerequisite.requiredSystemFiles;
   modulePath=$env:PSModulePath; securityModulePath=$security.Path } | ConvertTo-Json -Compress
`;
  const invoke = initialize => {
    const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      encoding: 'utf8', windowsHide: true, timeout: 15_000,
      env: { ...environment, PSModulePath: inheritedModules, SURTITLE_VC_SHADOW_ROOT: shadowRoot,
        SURTITLE_VC_HELPER: fileURLToPath(new URL('../native/vc-prerequisite.ps1', import.meta.url)),
        SURTITLE_VC_MANIFEST: manifestPath,
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
  assert.equal(initialized.minimumVersion, prerequisite.minimumVersion);
  assert.equal(initialized.minimumDisplay, prerequisite.minimumVersion);
  assert.equal(initialized.downloadUrl, prerequisite.downloadUrl);
  assert.deepEqual(initialized.requiredSystemFiles, prerequisite.requiredSystemFiles);
  assert.equal(realpathSync.native(initialized.modulePath), realpathSync.native(builtinModules));
  assert.equal(realpathSync.native(initialized.securityModulePath),
    realpathSync.native(join(builtinModules, 'Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1')));
}, 35_000);
