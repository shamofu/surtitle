# SPDX-License-Identifier: GPL-3.0-or-later
[CmdletBinding()]
param([switch]$NoBuild)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true

if (-not $IsWindows -or [Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64') {
    throw 'The Windows x64 package requires a Windows x64 host.'
}

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))

function Assert-RegularFile([string]$path, [string]$label) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Missing ${label}: $path"
    }
    $item = Get-Item -LiteralPath $path -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw "Refusing link for ${label}: $path"
    }
    if ($item.Length -le 0) {
        throw "Empty ${label}: $path"
    }
}

function Format-NsisDefine([string]$value) {
    if ($value -match '[\r\n"]') {
        throw "Unsafe NSIS argument: $value"
    }
    return $value.Replace('$', '$$')
}

function Resolve-CargoAbout([string]$root) {
    $candidates = @()
    if ($env:SURTITLE_CARGO_ABOUT) {
        $candidates += [IO.Path]::GetFullPath($env:SURTITLE_CARGO_ABOUT)
    }
    $cmd = Get-Command cargo-about -ErrorAction SilentlyContinue
    if ($cmd) {
        $candidates += $cmd.Source
    }
    $candidates += (Join-Path $root 'work/package-tools/bin/cargo-about.exe')
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf -ErrorAction SilentlyContinue)) {
            return $candidate
        }
    }
    throw 'cargo-about is required to generate notices/rust.html (install cargo-about or set SURTITLE_CARGO_ABOUT).'
}

function Resolve-Makensis {
    $candidates = @()
    if ($env:SURTITLE_NSIS_COMPILER) {
        $candidates += [IO.Path]::GetFullPath($env:SURTITLE_NSIS_COMPILER)
    } else {
        $cmd = Get-Command makensis -ErrorAction SilentlyContinue
        if ($cmd) {
            $candidates += $cmd.Source
        }
        foreach ($base in @(${env:ProgramFiles(x86)}, ${env:ProgramFiles})) {
            if ($base) {
                $candidates += (Join-Path $base 'NSIS/makensis.exe')
            }
        }
        if ($env:LOCALAPPDATA) {
            $candidates += (Join-Path $env:LOCALAPPDATA 'tauri/NSIS/Bin/makensis.exe')
            $candidates += (Join-Path $env:LOCALAPPDATA 'tauri/NSIS/makensis.exe')
        }
    }
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf -ErrorAction SilentlyContinue)) {
            Assert-RegularFile $candidate 'NSIS compiler'
            return $candidate
        }
    }
    throw 'makensis.exe was not found. Install NSIS or set SURTITLE_NSIS_COMPILER.'
}

$cargoToml = Get-Content -LiteralPath (Join-Path $repoRoot 'Cargo.toml') -Raw -Encoding UTF8
$wsMatch = [regex]::Match($cargoToml, '(?ms)^\[workspace\.package\]\s*\r?\n(.*?)(?=^\[|\z)')
$verMatch = if ($wsMatch.Success) { [regex]::Match($wsMatch.Groups[1].Value, '(?m)^version\s*=\s*"([^"]+)"\s*(?:#.*)?$') } else { $null }
$version = if ($verMatch -and $verMatch.Success) { $verMatch.Groups[1].Value } else { '' }
if ($version -notmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$') {
    throw 'Cargo [workspace.package].version must be an explicit stable X.Y.Z version.'
}

$identity = Get-Content -LiteralPath (Join-Path $repoRoot 'packaging/app.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($identity.productName -notmatch '^[A-Za-z0-9 ._-]+$' -or
    $identity.publisher -notmatch '^[A-Za-z0-9 ._-]+$' -or
    $identity.identifier -notmatch '^[a-zA-Z0-9.-]+$' -or
    $identity.executable -ne 'surtitle.exe') {
    throw 'Invalid application packaging identity in packaging/app.json.'
}

$manifest = Get-Content -LiteralPath (Join-Path $repoRoot 'native/runtime-windows-x64.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$vcPrereq = @($manifest.prerequisites | Where-Object { $_.id -eq 'microsoft-vc-runtime-x64' })
if ($vcPrereq.Count -ne 1) {
    throw 'Expected one microsoft-vc-runtime-x64 prerequisite in native/runtime-windows-x64.json.'
}
$vcMinimum = [string]$vcPrereq[0].minimumVersion
$vcDownloadUrl = [string]$vcPrereq[0].downloadUrl
if ($vcMinimum -notmatch '^\d+\.\d+\.\d+\.\d+$' -or -not $vcDownloadUrl.StartsWith('https://')) {
    throw 'Invalid microsoft-vc-runtime-x64 configuration.'
}
$vcMinDisplay = if ($vcMinimum.EndsWith('.0')) { $vcMinimum.Substring(0, $vcMinimum.Length - 2) } else { $vcMinimum }

$targetDirRaw = if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } elseif ($env:CARGO_BUILD_TARGET_DIR) { $env:CARGO_BUILD_TARGET_DIR } else { 'work/target' }
$targetDir = if ([IO.Path]::IsPathRooted($targetDirRaw)) { [IO.Path]::GetFullPath($targetDirRaw) } else { [IO.Path]::GetFullPath((Join-Path $repoRoot $targetDirRaw)) }
$resourcesDir = Join-Path $repoRoot 'work/resources'
$nativeDir = Join-Path $resourcesDir 'native'
$noticesDir = Join-Path $resourcesDir 'notices'

Push-Location $repoRoot
try {
    $treeLines = & cargo tree --locked --package surtitle --no-default-features --edges normal,build --prefix none --format '{p}|{f}'
    if ($LASTEXITCODE -ne 0) { throw 'cargo tree failed.' }
    if ($treeLines | Where-Object { $_ -match '^(?:tauri(?:-\S+)?|wry|webview2(?:-\S+)?|webkit2gtk(?:-\S+)?) v' }) {
        throw 'Browser runtime dependency detected in production desktop graph.'
    }
    $appRows = @($treeLines | Where-Object { $_ -match '^surtitle(?:-ai)? v' })
    if (-not ($appRows | Where-Object { $_ -match '^surtitle v' }) -or -not ($appRows | Where-Object { $_ -match '^surtitle-ai v' })) {
        throw 'Production dependency graph is missing surtitle or surtitle-ai.'
    }
    foreach ($row in $appRows) {
        $featuresText = ($row -split '\|', 2)[1] -replace '\s*\(\*\)$', ''
        foreach ($feature in ($featuresText -split ',')) {
            if ($feature.Trim() -in @('development-validation', 'e2e-fixtures', 'e2e-test', 'test-support')) {
                throw "Development-only feature in production graph: $row"
            }
        }
    }

    $expectedNativeFiles = @()
    foreach ($component in $manifest.components) {
        foreach ($file in $component.runtimeFiles) {
            if (-not $file.target -or $file.target -match '[\\/]' -or $file.target -eq '..') { throw 'Native target must be a plain filename.' }
            $expectedNativeFiles += [string]$file.target
        }
        foreach ($notice in $component.noticeFiles) {
            $name = [IO.Path]::GetFileName([string]$notice.path)
            $expectedNativeFiles += $name
        }
    }
    $missingNative = @($expectedNativeFiles | Where-Object { -not (Test-Path -LiteralPath (Join-Path $nativeDir $_) -PathType Leaf) })
    if ($missingNative.Count -gt 0) {
        & pwsh -NoProfile -NonInteractive -File (Join-Path $repoRoot 'native/windows/native-prepare.ps1')
        if ($LASTEXITCODE -ne 0) { throw 'native-prepare.ps1 failed.' }
    }
    foreach ($file in $expectedNativeFiles) {
        Assert-RegularFile (Join-Path $nativeDir $file) 'native runtime resource'
    }

    if (Test-Path -LiteralPath $noticesDir) {
        Remove-Item -LiteralPath $noticesDir -Recurse -Force
    }
    New-Item -ItemType Directory -Path $noticesDir -Force | Out-Null

    $cargoAbout = Resolve-CargoAbout $repoRoot
    & $cargoAbout generate --manifest-path (Join-Path $repoRoot 'crates/desktop/Cargo.toml') --target x86_64-pc-windows-msvc --no-default-features --locked --fail --config (Join-Path $repoRoot 'about.toml') (Join-Path $repoRoot 'packaging/licenses.hbs') --output-file (Join-Path $noticesDir 'rust.html')
    if ($LASTEXITCODE -ne 0) { throw 'cargo-about failed.' }
    Assert-RegularFile (Join-Path $noticesDir 'rust.html') 'Rust dependency license notices'

    foreach ($noticeCopy in @(
        @{ src = 'LICENSE'; dst = 'LICENSE' },
        @{ src = 'native/silero-LICENSE'; dst = 'silero-LICENSE' },
        @{ src = 'native/installer-notices/NSIS-3.11-COPYING.txt'; dst = 'NSIS-3.11-COPYING.txt' },
        @{ src = 'native/installer-notices/NSIS-Modern-UI-2-LICENSE.txt'; dst = 'NSIS-Modern-UI-2-LICENSE.txt' }
    )) {
        $srcPath = Join-Path $repoRoot $noticeCopy.src
        Assert-RegularFile $srcPath 'notice file'
        Copy-Item -LiteralPath $srcPath -Destination (Join-Path $noticesDir $noticeCopy.dst) -Force
    }

    $metadataJson = (& cargo metadata --locked --offline --format-version 1 --filter-platform x86_64-pc-windows-msvc) -join "`n"
    if ($LASTEXITCODE -ne 0) { throw 'cargo metadata failed.' }
    $metadata = $metadataJson | ConvertFrom-Json
    $assetPackages = @($metadata.packages | Where-Object { $_.name -eq 'gpui-kit-assets' })
    if ($assetPackages.Count -eq 0) {
        throw 'Required dependency gpui-kit-assets was not found in cargo metadata.'
    }
    foreach ($pkg in $assetPackages) {
        $crateDir = Split-Path -Path $pkg.manifest_path -Parent
        $lucideNotice = Join-Path $crateDir 'LICENSE-LUCIDE'
        Assert-RegularFile $lucideNotice 'gpui-kit-assets LICENSE-LUCIDE'
        Copy-Item -LiteralPath $lucideNotice -Destination (Join-Path $noticesDir 'gpui-kit-assets-LICENSE-LUCIDE') -Force
    }

    if (-not $NoBuild) {
        $env:CARGO_TARGET_DIR = $targetDir
        & cargo build --release --locked --package surtitle --no-default-features
        if ($LASTEXITCODE -ne 0) { throw 'cargo build failed.' }
    }

    $binary = Join-Path $targetDir 'release/surtitle.exe'
    Assert-RegularFile $binary 'production executable'

    $makensis = Resolve-Makensis
    $nsisDir = Join-Path $targetDir 'release/bundle/nsis'
    if (Test-Path -LiteralPath $nsisDir) {
        Remove-Item -LiteralPath $nsisDir -Recurse -Force
    }
    New-Item -ItemType Directory -Path $nsisDir -Force | Out-Null
    $outputExe = Join-Path $nsisDir ("{0}_{1}_x64-setup.exe" -f $identity.productName, $version)

    & $makensis `
        '/INPUTCHARSET' 'UTF8' `
        '/NOCD' `
        '/V3' `
        ("/DAPP_VERSION=" + (Format-NsisDefine $version)) `
        ("/DAPP_PRODUCT=" + (Format-NsisDefine ([string]$identity.productName))) `
        ("/DAPP_PUBLISHER=" + (Format-NsisDefine ([string]$identity.publisher))) `
        ("/DAPP_BINARY=" + (Format-NsisDefine $binary)) `
        ("/DAPP_RESOURCES=" + (Format-NsisDefine $resourcesDir)) `
        ("/DAPP_OUTPUT=" + (Format-NsisDefine $outputExe)) `
        ("/DSURTITLE_VC_MINIMUM_VERSION=" + (Format-NsisDefine $vcMinDisplay)) `
        ("/DSURTITLE_VC_DOWNLOAD_URL=" + (Format-NsisDefine $vcDownloadUrl)) `
        (Join-Path $repoRoot 'packaging/windows.nsi')
    if ($LASTEXITCODE -ne 0) { throw 'makensis failed.' }

    Assert-RegularFile $outputExe 'Windows NSIS installer'
    Write-Output $outputExe
} finally {
    Pop-Location
}
