// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';

const helper = fileURLToPath(new URL('./prepare-ffmpeg.ps1', import.meta.url));
test.skipIf(process.platform !== 'win32')('missing or corrupt pinned archives fail before extraction, process execution or tool-path export', t => {
  const root = mkdtempSync(join(tmpdir(), 'surtitle ffmpeg 日本語 & '));
  t.onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const archive = join(root, 'corrupt.zip'), environmentFile = join(root, 'github-env'), pathFile = join(root, 'github-path');
  writeFileSync(archive, 'not the pinned FFmpeg archive');
  writeFileSync(environmentFile, 'unchanged\n');
  writeFileSync(pathFile, 'unchanged PATH\n');
  const command = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
function Invoke-WebRequest { throw 'Unexpected download' }
function Expand-Archive { throw 'Unexpected extraction' }
$pathBefore = $env:PATH
try {
    & $env:SURTITLE_FFMPEG_HELPER -ArchivePath $env:SURTITLE_FFMPEG_ARCHIVE -OutputDirectory $env:SURTITLE_FFMPEG_OUTPUT
    throw 'Invalid archive was accepted'
} catch {
    @{ message=$_.Exception.Message; ffmpeg=$env:FFMPEG_PATH; rust=$env:SURTITLE_TEST_FFMPEG; path=$env:PATH; pathBefore=$pathBefore } | ConvertTo-Json -Compress
}
`;
  for (const [path, message] of [[join(root, 'missing.zip'), /archive is missing/], [archive, /SHA-256 mismatch/]]) {
    const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], {
      encoding: 'utf8', windowsHide: true, timeout: 15_000,
      env: { ...process.env, FFMPEG_PATH: 'original fixture tool', SURTITLE_TEST_FFMPEG: 'original Rust tool', GITHUB_ENV: environmentFile, GITHUB_PATH: pathFile,
        SURTITLE_FFMPEG_HELPER: helper, SURTITLE_FFMPEG_ARCHIVE: path, SURTITLE_FFMPEG_OUTPUT: join(root, 'output') },
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    const observed = JSON.parse(result.stdout);
    assert.match(observed.message, message);
    assert.equal(observed.ffmpeg, 'original fixture tool');
    assert.equal(observed.rust, 'original Rust tool');
    assert.equal(observed.path, observed.pathBefore);
    assert.equal(readFileSync(environmentFile, 'utf8'), 'unchanged\n');
    assert.equal(readFileSync(pathFile, 'utf8'), 'unchanged PATH\n');
  }
}, 40_000);

test.skipIf(process.platform !== 'win32')('an interrupted download removes only its unique partial file and exports no tool path', t => {
  const root = mkdtempSync(join(tmpdir(), 'surtitle ffmpeg interruption 日本語 & '));
  t.onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const environmentFile = join(root, 'github-env'), pathFile = join(root, 'github-path');
  writeFileSync(environmentFile, 'unchanged\n');
  writeFileSync(pathFile, 'unchanged PATH\n');
  const command = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($env:SURTITLE_FFMPEG_HELPER, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'The actual FFmpeg helper did not parse' }
$download = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Invoke-TestFfmpegDownload' }, $false))
if ($download.Count -ne 1) { throw 'Expected one download boundary' }
# Replace only the network boundary. The actual hash, cleanup and export body runs unchanged.
$source = [IO.File]::ReadAllText($env:SURTITLE_FFMPEG_HELPER)
$body = $source.Remove($download[0].Extent.StartOffset, $download[0].Extent.EndOffset - $download[0].Extent.StartOffset)
function Invoke-TestFfmpegDownload([string]$Uri, [string]$Partial) {
    if ($Uri -notmatch '^https://www\.gyan\.dev/ffmpeg/builds/packages/ffmpeg-9\.0\.2-essentials_build\.zip$') { throw 'Unexpected download request' }
    [IO.File]::WriteAllText($Partial, 'interrupted download')
    throw 'Simulated network failure'
}
function Expand-Archive { throw 'Unexpected extraction' }
$pathBefore = $env:PATH
$output = $env:SURTITLE_FFMPEG_OUTPUT
New-Item -ItemType Directory -Path $output | Out-Null
$unrelated = Join-Path $output 'unrelated.partial'
[IO.File]::WriteAllText($unrelated, 'preserved')
try {
    & ([ScriptBlock]::Create($body)) -OutputDirectory $output
    throw 'Interrupted download was accepted'
} catch {
    @{ message=$_.Exception.Message; ffmpeg=$env:FFMPEG_PATH; rust=$env:SURTITLE_TEST_FFMPEG; path=$env:PATH; pathBefore=$pathBefore
       files=@(Get-ChildItem -LiteralPath $output -File | ForEach-Object Name)
       preserved=[IO.File]::ReadAllText($unrelated) } | ConvertTo-Json -Compress
}
`;
  const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], {
    encoding: 'utf8', windowsHide: true, timeout: 15_000,
    env: { ...process.env, FFMPEG_PATH: 'original fixture tool', SURTITLE_TEST_FFMPEG: 'original Rust tool', GITHUB_ENV: environmentFile, GITHUB_PATH: pathFile,
      SURTITLE_FFMPEG_HELPER: helper, SURTITLE_FFMPEG_OUTPUT: join(root, 'output') },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const observed = JSON.parse(result.stdout);
  assert.equal(observed.message, 'Simulated network failure');
  assert.deepEqual(observed.files, ['unrelated.partial']);
  assert.equal(observed.preserved, 'preserved');
  assert.equal(observed.ffmpeg, 'original fixture tool');
  assert.equal(observed.rust, 'original Rust tool');
  assert.equal(observed.path, observed.pathBefore);
  assert.equal(readFileSync(environmentFile, 'utf8'), 'unchanged\n');
  assert.equal(readFileSync(pathFile, 'utf8'), 'unchanged PATH\n');
}, 20_000);
