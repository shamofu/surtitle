// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test.skipIf(process.platform !== 'win32')('installer smoke resolves relative and absolute inputs once and rejects escaped or existing paths before touching the profile', () => {
  const relative = 'work/installer-test/' + randomUUID() + ' 日本語 & application';
  const absolute = join(workspace, relative);
  const cases = [
    { name: 'relative', input: relative },
    { name: 'absolute', input: absolute },
    { name: 'parent traversal', input: '../installer-path-' + randomUUID() },
    { name: 'existing directory', input: 'scripts' },
  ];
  const command = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
# Stop at the first configuration read, before profile inspection or installation.
function Get-Content {
    param([string]$LiteralPath, [switch]$Raw)
    if ($LiteralPath -ne 'src-tauri/tauri.conf.json') { throw 'Unexpected configuration read' }
    throw ('validated-install-root:' + $installRoot)
}
function Start-Process { throw 'Unexpected process launch' }
$results = foreach ($case in ($env:SURTITLE_INSTALLER_TEST_CASES | ConvertFrom-Json)) {
    try {
        & $env:SURTITLE_INSTALLER_TEST_SCRIPT -Installer $env:SURTITLE_INSTALLER_TEST_INPUT -InstallDirectory $case.input -DisposableProfile
        throw 'Smoke script unexpectedly returned'
    } catch {
        @{ name = $case.name; message = $_.Exception.Message }
    }
}
$results | ConvertTo-Json -Compress
`;
  const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], {
    cwd: workspace, encoding: 'utf8', windowsHide: true, timeout: 15_000,
    env: {
      ...process.env,
      SURTITLE_INSTALLER_TEST_CASES: JSON.stringify(cases),
      SURTITLE_INSTALLER_TEST_SCRIPT: join(workspace, 'scripts/package-installer-smoke.ps1'),
      SURTITLE_INSTALLER_TEST_INPUT: join(workspace, 'package.json'),
    },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  const observations = Object.fromEntries(JSON.parse(result.stdout).map(value => [value.name, value.message]));
  assert.equal(observations.relative, 'validated-install-root:' + absolute);
  assert.equal(observations.absolute, 'validated-install-root:' + absolute);
  assert.equal(observations['parent traversal'], 'Test install path must stay inside the repository.');
  assert.equal(observations['existing directory'], 'Test install directory must be fresh.');
  assert.equal(existsSync(absolute), false, 'Path validation must not create the installation directory');
});

test.skipIf(process.platform !== 'win32')('installer retention requires unchanged database WAL and rollback journals while allowing SHM regeneration', t => {
  // Node's TEMP may use RUNNER~1 while PowerShell enumerates the long user name.
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'surtitle-retention 日本語 & ')));
  t.onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const retained = [
    'local/learning.sqlite', 'local/learning.sqlite-wal', 'local/learning.sqlite-journal',
    'local/card-audio/saved.wav', 'local/installer-retention-sentinel.json',
    'roaming/nested/archive.db', 'roaming/nested/archive.db-wal', 'roaming/nested/archive.db-journal',
    'roaming/installer-retention-sentinel.json',
  ];
  for (const name of [...retained, 'local/learning.sqlite-shm', 'roaming/nested/archive.db-shm']) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `Synthetic retention fixture: ${name}`);
  }
  const command = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
function Start-Process { throw 'No installer or application may run in this retention test' }
function Invoke-WebRequest { throw 'No download may run in this retention test' }
# Load only the two actual retention functions, never the script's profile guards
# or installer/application execution. File enumeration and hashing remain real.
$tokens = $null
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($env:SURTITLE_RETENTION_TEST_SCRIPT, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Installer smoke script did not parse' }
foreach ($name in @('Snapshot-Data', 'Assert-Data')) {
    $functions = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $false))
    if ($functions.Count -ne 1) { throw "Expected exactly one real $name function" }
    . ([ScriptBlock]::Create($functions[0].Extent.Text))
}
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class RetentionPathAlias {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern uint GetShortPathNameW(string path, StringBuilder output, uint capacity);
    public static string Get(string path) {
        var output = new StringBuilder(32768);
        uint length = GetShortPathNameW(path, output, (uint)output.Capacity);
        if (length == 0) throw new Win32Exception(Marshal.GetLastWin32Error());
        if (length >= output.Capacity) throw new InvalidOperationException("Short path exceeded the fixture path buffer");
        return output.ToString();
    }
}
'@
$longRoot = $env:SURTITLE_RETENTION_TEST_ROOT
$shortRoot = [RetentionPathAlias]::Get($longRoot)
# Filesystems without short names return the original path; never change their settings.
$shortPathAvailable = -not [string]::Equals($longRoot, $shortRoot, [StringComparison]::OrdinalIgnoreCase)
$pathForms = @($longRoot)
if ($shortPathAvailable) { $pathForms += $shortRoot }
$observations = foreach ($root in $pathForms) {
    $dataRoots = @((Join-Path $root 'local'), (Join-Path $root 'roaming'))
    foreach ($name in @('local/learning.sqlite-shm', 'roaming/nested/archive.db-shm')) {
        [IO.File]::WriteAllText((Join-Path $root $name), 'synthetic shared memory index')
    }
    $before = Snapshot-Data
    Assert-Data $before
    $unchangedPassed = $true
    [IO.File]::WriteAllText((Join-Path $root 'local/learning.sqlite-shm'), 'regenerated index')
    Remove-Item -LiteralPath (Join-Path $root 'roaming/nested/archive.db-shm')
    Assert-Data $before
    $shmChangesPassed = $true
    $mutations = foreach ($name in @('local/learning.sqlite-wal', 'local/learning.sqlite-journal', 'roaming/nested/archive.db-wal', 'roaming/nested/archive.db-journal')) {
        $path = Join-Path $root $name
        $original = [IO.File]::ReadAllBytes($path)
        foreach ($change in @('modified', 'deleted')) {
            if ($change -eq 'modified') { [IO.File]::WriteAllText($path, 'changed synthetic journal pages') }
            else { Remove-Item -LiteralPath $path }
            $message = $null
            try { Assert-Data $before } catch { $message = $_.Exception.Message }
            finally { [IO.File]::WriteAllBytes($path, $original) }
            @{ name=$name; change=$change; message=$message }
        }
    }
    Assert-Data $before
    @{ inputRoot=$root; retained=@($before.Keys); unchangedPassed=$unchangedPassed; shmChangesPassed=$shmChangesPassed; mutations=@($mutations) }
}
@{ shortPathAvailable=$shortPathAvailable; observations=@($observations) } | ConvertTo-Json -Depth 6 -Compress
`;
  const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], {
    cwd: workspace, encoding: 'utf8', windowsHide: true, timeout: 15_000,
    env: { ...process.env, SURTITLE_RETENTION_TEST_ROOT: root, SURTITLE_RETENTION_TEST_SCRIPT: join(workspace, 'scripts/package-installer-smoke.ps1') },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  const { shortPathAvailable, observations } = JSON.parse(result.stdout);
  assert.equal(observations.length, shortPathAvailable ? 2 : 1);
  const expectedMutations = retained.filter(name => /-(wal|journal)$/.test(name))
    .flatMap(name => ['modified', 'deleted'].map(change => `${change}:${name}`)).sort();
  const errorPrefix = 'Installer changed retained learning data: ';
  let aliasErrorPaths = 0;
  for (const observation of observations) {
    assert.equal(realpathSync.native(observation.inputRoot), root);
    assert.deepEqual(observation.retained.map(path => realpathSync.native(path)).sort(),
      retained.map(name => realpathSync.native(join(root, name))).sort());
    assert.equal(observation.unchangedPassed, true);
    assert.equal(observation.shmChangesPassed, true);
    assert.equal(observation.mutations.length, 8);
    assert.deepEqual(observation.mutations.map(({ change, name }) => `${change}:${name}`).sort(), expectedMutations);
    for (const mutation of observation.mutations) {
      const message = `A ${mutation.change} ${mutation.name} must fail even when the main database is unchanged`;
      assert.equal(typeof mutation.message, 'string', message);
      assert.ok(mutation.message.startsWith(errorPrefix), message);
      const reportedPath = mutation.message.slice(errorPrefix.length);
      assert.ok(isAbsolute(reportedPath), message);
      // Every file is restored in finally, so even deletion errors can be checked
      // against the exact expected file rather than accepting a matching suffix.
      assert.equal(realpathSync.native(reportedPath), realpathSync.native(join(root, mutation.name)), message);
      if (reportedPath !== join(observation.inputRoot, mutation.name)) aliasErrorPaths++;
    }
  }
  console.log(`Installer retention: ${observations.length} path form(s), ${observations.length * 8} mutation checks, short alias ${shortPathAvailable ? 'available' : 'unavailable'}, ${aliasErrorPaths} normalized error path(s)`);
});
