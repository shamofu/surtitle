# SPDX-License-Identifier: GPL-3.0-or-later
# Test tooling only: CLI FFmpeg remains an on-demand dependency in the application.
[CmdletBinding()]
param(
    [string]$OutputDirectory = (Join-Path $PSScriptRoot '../../work/ci-ffmpeg'),
    [string]$ArchivePath
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
if (-not $IsWindows -or [Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64') {
    throw 'The pinned test FFmpeg package requires Windows x64.'
}
function Invoke-TestFfmpegDownload([string]$Uri, [string]$Partial) {
    # The accepted archive took 209 seconds on a slow link. Limit the
    # whole transfer, including one retry, while allowing that observed duration.
    $curl = Join-Path $env:SystemRoot 'System32/curl.exe'
    & $curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --connect-timeout 30 --max-time 300 --retry 1 --retry-all-errors --retry-delay 2 --retry-max-time 602 --output $Partial $Uri
    if ($LASTEXITCODE -ne 0) { throw "Pinned test FFmpeg download failed: $LASTEXITCODE" }
}
# This is the existing 9.0.2 CLI verified in the native acceptance evidence.
$version = '9.0.2'
$archiveHash = '60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba'
$archiveName = "ffmpeg-$version-essentials_build.zip"
$destination = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $destination -Force | Out-Null
if ($ArchivePath) {
    $archive = [IO.Path]::GetFullPath($ArchivePath)
} else {
    $archive = Join-Path $destination $archiveName
    if (-not (Test-Path -LiteralPath $archive -PathType Leaf)) {
        $partial = $archive + '.' + [Guid]::NewGuid().ToString('N') + '.partial'
        try {
            Invoke-TestFfmpegDownload "https://www.gyan.dev/ffmpeg/builds/packages/$archiveName" $partial
            if ((Get-FileHash -LiteralPath $partial -Algorithm SHA256).Hash -ne $archiveHash) { throw 'Test FFmpeg archive SHA-256 mismatch.' }
            Move-Item -LiteralPath $partial -Destination $archive
        } finally {
            if (Test-Path -LiteralPath $partial -PathType Leaf) { Remove-Item -LiteralPath $partial }
        }
    }
}
if (-not (Test-Path -LiteralPath $archive -PathType Leaf)) { throw 'The pinned test FFmpeg archive is missing.' }
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $archiveHash) { throw 'Test FFmpeg archive SHA-256 mismatch.' }
# Re-extract the verified archive so stale or partial executable files cannot be reused.
Expand-Archive -LiteralPath $archive -DestinationPath $destination -Force
$bin = Join-Path $destination "ffmpeg-$version-essentials_build/bin"
$ffmpeg = Join-Path $bin 'ffmpeg.exe'
$ffprobe = Join-Path $bin 'ffprobe.exe'
foreach ($tool in @($ffmpeg, $ffprobe)) {
    if (-not (Test-Path -LiteralPath $tool -PathType Leaf)) { throw "Pinned test FFmpeg executable is missing: $tool" }
    $output = & $tool -version
    if ($LASTEXITCODE -ne 0 -or $output[0] -notmatch ('^ff(?:mpeg|probe) version ' + [regex]::Escape($version) + '-essentials_build-')) {
        throw "Pinned test FFmpeg executable failed its version check: $tool"
    }
}
$env:FFMPEG_PATH = $ffmpeg
$env:SURTITLE_TEST_FFMPEG = $ffmpeg
# Native E2E exercises the application's PATH discovery of external tool pairs.
$env:PATH = $bin + [IO.Path]::PathSeparator + $env:PATH
if ($env:GITHUB_ENV) {
    @("FFMPEG_PATH=$ffmpeg", "SURTITLE_TEST_FFMPEG=$ffmpeg") | Out-File -LiteralPath $env:GITHUB_ENV -Append -Encoding utf8
}
if ($env:GITHUB_PATH) { $bin | Out-File -LiteralPath $env:GITHUB_PATH -Append -Encoding utf8 }
Write-Host "Prepared test FFmpeg $version and its matching ffprobe: $bin"
