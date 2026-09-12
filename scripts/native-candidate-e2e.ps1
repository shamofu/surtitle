# SPDX-License-Identifier: GPL-3.0-or-later
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$CandidateDirectory,
    [Parameter(Mandatory)][string]$RunDirectory,
    [Parameter(Mandatory)][string]$ExpectedSha256,
    [string]$Av1Fixture,
    [int]$Port = 4473
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
if (-not $IsWindows) { throw 'Candidate application E2E requires Windows.' }
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$workRoot = [IO.Path]::GetFullPath((Join-Path $workspace 'work')) + [IO.Path]::DirectorySeparatorChar
$candidate = (Resolve-Path -LiteralPath $CandidateDirectory).Path
$run = [IO.Path]::GetFullPath($RunDirectory)
if (-not $candidate.StartsWith($workRoot, [StringComparison]::OrdinalIgnoreCase) -or
    -not $run.StartsWith($workRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Candidate and disposable run must stay inside the workspace work directory.'
}
if (Test-Path -LiteralPath $run) { throw 'A fresh disposable run directory is required.' }
if ($Av1Fixture -and (-not [IO.Path]::IsPathFullyQualified($Av1Fixture) -or -not (Test-Path -LiteralPath $Av1Fixture -PathType Leaf))) {
    throw 'Select an existing absolute path for the optional AV1 fixture.'
}
$evidence = Get-Content -LiteralPath (Join-Path $candidate 'build-evidence.json') -Raw | ConvertFrom-Json
$candidateDll = Join-Path $candidate 'runtime/mpv-2.dll'
if ($ExpectedSha256 -notmatch '^[a-fA-F0-9]{64}$' -or
    $evidence.status -ne 'candidate-needs-review' -or
    $evidence.runtime.sha256 -ne $ExpectedSha256 -or
    (Get-FileHash -LiteralPath $candidateDll -Algorithm SHA256).Hash -ne $ExpectedSha256) {
    throw 'The candidate does not match the explicitly selected build evidence.'
}
$sourceBundle = [IO.Path]::GetFullPath((Join-Path $candidate $evidence.correspondingSourceCandidate.file))
if (-not $sourceBundle.StartsWith($candidate + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or
    (Get-FileHash -LiteralPath $sourceBundle -Algorithm SHA256).Hash -ne $evidence.correspondingSourceCandidate.sha256) {
    throw 'Candidate source bundle verification failed.'
}
$baselineFiles = @('surtitle.exe', 'surtitle.pdb')
$baseline = @{}
foreach ($file in $baselineFiles) {
    $baseline[$file] = (Get-FileHash -LiteralPath (Join-Path $workspace "target/debug/$file") -Algorithm SHA256).Hash
}
$productionFiles = @('native/runtime-windows-x64.json', 'src-tauri/resources/native/mpv-2.dll')
$productionHashes = @{}
foreach ($file in $productionFiles) {
    $productionHashes[$file] = (Get-FileHash -LiteralPath (Join-Path $workspace $file) -Algorithm SHA256).Hash
}
New-Item -ItemType Directory -Path (Join-Path $run 'baseline') -Force | Out-Null
foreach ($file in $baselineFiles) {
    Copy-Item -LiteralPath (Join-Path $workspace "target/debug/$file") -Destination (Join-Path $run "baseline/$file")
}
$baseline | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $run 'baseline.json')
function Restore-Baseline {
    foreach ($file in $baselineFiles) {
        $source = Join-Path $run "baseline/$file"
        if ((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash -ne $baseline[$file]) { throw 'Baseline backup changed.' }
        Copy-Item -LiteralPath $source -Destination (Join-Path $workspace "target/debug/$file") -Force
        if ((Get-FileHash -LiteralPath (Join-Path $workspace "target/debug/$file") -Algorithm SHA256).Hash -ne $baseline[$file]) {
            throw 'Normal executable restoration failed.'
        }
    }
}
$result = @{ passed = $false; baselineRestored = $false; productionNativeUnchanged = $false; releaseEligible = $false; candidateSha256 = $ExpectedSha256; sourceBundleSha256 = $evidence.correspondingSourceCandidate.sha256 }
$previousLocation = Get-Location
$environmentNames = @('GOOGLE_APPLICATION_CREDENTIALS', 'SURTITLE_E2E_AI_RECOVERY', 'SURTITLE_E2E_TRANSCRIPT_REVIEW', 'SURTITLE_E2E_AV1_FIXTURE', 'SURTITLE_E2E_DATA_DIR', 'SURTITLE_E2E_BINARY', 'SURTITLE_TAURI_DRIVER', 'SURTITLE_NATIVE_DRIVER', 'SURTITLE_WEBDRIVER_PORT')
$previousEnvironment = @{}
foreach ($name in $environmentNames) { $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
try {
    Set-Location -LiteralPath $workspace
    Remove-Item Env:GOOGLE_APPLICATION_CREDENTIALS, Env:SURTITLE_E2E_AI_RECOVERY, Env:SURTITLE_E2E_TRANSCRIPT_REVIEW -ErrorAction SilentlyContinue
    pnpm build *> (Join-Path $run 'build-ui.log')
    # Compile from a private source/resource snapshot. Production manifest pins
    # and DLLs never change, and publication remains blocked in the private copy.
    $snapshot = Join-Path $run 'source'
    New-Item -ItemType Directory -Path (Join-Path $snapshot 'src-tauri') -Force | Out-Null
    foreach ($item in @('Cargo.toml', 'Cargo.lock', 'LICENSE', 'crates', 'dist', 'native')) {
        Copy-Item -LiteralPath (Join-Path $workspace $item) -Destination $snapshot -Recurse
    }
    foreach ($item in @('Cargo.toml', 'build.rs', 'tauri.conf.json', 'src', 'capabilities', 'icons', 'resources')) {
        Copy-Item -LiteralPath (Join-Path $workspace "src-tauri/$item") -Destination (Join-Path $snapshot 'src-tauri') -Recurse
    }
    $privateManifestPath = Join-Path $snapshot 'native/runtime-windows-x64.json'
    $privateManifest = Get-Content -LiteralPath $privateManifestPath -Raw | ConvertFrom-Json
    $mpv = @($privateManifest.components | Where-Object id -EQ 'libmpv')
    if ($mpv.Count -ne 1 -or $mpv[0].runtimeFiles.Count -ne 1 -or $mpv[0].runtimeFiles[0].target -ne 'mpv-2.dll') {
        throw 'Unexpected runtime manifest structure.'
    }
    $mpv[0].runtimeFiles[0].sha256 = $ExpectedSha256.ToLowerInvariant()
    $mpv[0].redistribution.status = 'incomplete'
    $mpv[0].redistribution.reason = 'Private candidate E2E fixture only; not approved for redistribution.'
    $privateManifest | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $privateManifestPath
    Copy-Item -LiteralPath $candidateDll -Destination (Join-Path $snapshot 'src-tauri/resources/native/mpv-2.dll') -Force
    cargo build --manifest-path (Join-Path $snapshot 'Cargo.toml') --target-dir (Join-Path $workspace 'target') -p surtitle --features e2e-test,custom-protocol --locked --offline *> (Join-Path $run 'build-native.log')
    $privateExecutable = Join-Path $run 'surtitle.exe'
    Copy-Item -LiteralPath (Join-Path $workspace 'target/debug/surtitle.exe') -Destination $privateExecutable
    $result.executableSha256 = (Get-FileHash -LiteralPath $privateExecutable -Algorithm SHA256).Hash
    Restore-Baseline
    $env:SURTITLE_E2E_DATA_DIR = Join-Path $run 'data'
    cargo run -p surtitle-core --example seed_fixture --locked --offline -- $env:SURTITLE_E2E_DATA_DIR (Join-Path $workspace 'work/e2e-fixtures/日本語 & sample.mp4') *> (Join-Path $run 'seed.log')
    $env:SURTITLE_E2E_BINARY = $privateExecutable
    $env:SURTITLE_TAURI_DRIVER = Join-Path $workspace 'work/driver/bin/tauri-driver.exe'
    $env:SURTITLE_NATIVE_DRIVER = Join-Path $workspace 'work/webdriver/msedgedriver.exe'
    $env:SURTITLE_WEBDRIVER_PORT = [string]$Port
    [Environment]::SetEnvironmentVariable('SURTITLE_E2E_AV1_FIXTURE', $Av1Fixture, 'Process')
    if ($Av1Fixture) { $result.av1FixtureSha256 = (Get-FileHash -LiteralPath $Av1Fixture -Algorithm SHA256).Hash }
    pnpm exec wdio run ./wdio.conf.js --spec ./e2e/native/media-management.e2e.js --mochaOpts.timeout 300000 *> (Join-Path $run 'native-e2e.log')
    foreach ($name in @('media-resume-tracks.png', 'background-downloads.png', 'candidate-av1.png')) {
        $checkpoint = Join-Path $workspace "test-results/native/$name"
        if (Test-Path -LiteralPath $checkpoint) { Copy-Item -LiteralPath $checkpoint -Destination (Join-Path $run $name) }
    }
    $result.passed = $true
} catch {
    $result.error = $_.ToString()
    throw
} finally {
    try {
        Restore-Baseline
        $result.baselineRestored = $true
        foreach ($file in $productionFiles) {
            if ((Get-FileHash -LiteralPath (Join-Path $workspace $file) -Algorithm SHA256).Hash -ne $productionHashes[$file]) { throw "Production native file changed: $file" }
        }
        $result.productionNativeUnchanged = $true
    } finally {
        foreach ($name in $environmentNames) { [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], 'Process') }
        Set-Location -LiteralPath $previousLocation
        $result | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $run 'result.json')
    }
}
