// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
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
