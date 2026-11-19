[CmdletBinding()]
param([switch]$WithDevModel)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
Add-Type -AssemblyName System.IO.Compression.FileSystem
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$manifestPath = Join-Path $repoRoot 'native/runtime-windows-x64.json'
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if (-not $IsWindows -or [Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64') {
    throw 'These development native artifacts require Windows x64.'
}
function Resolve-RepoPath([string]$relative) {
    if ([IO.Path]::IsPathRooted($relative)) { throw "Expected repository-relative path: $relative" }
    $resolved = [IO.Path]::GetFullPath((Join-Path $repoRoot $relative))
    if (-not $resolved.StartsWith($repoRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Path escapes repository: $relative"
    }
    return $resolved
}
function Assert-Hash([string]$path, [string]$expected) {
    if ($expected -notmatch '^[0-9a-fA-F]{64}$' -or -not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Missing artifact or invalid manifest hash: $path" }
    if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ne $expected) { throw "SHA-256 mismatch: $path" }
}
function Invoke-HttpsDownload([string]$url, [string]$destination, [string[]]$allowedHosts, [string]$expectedHash) {
    $uri = [Uri]$url
    if ($uri.Scheme -ne 'https' -or $uri.Host -notin $allowedHosts) { throw "Unexpected upstream URL: $url" }
    if (Test-Path -LiteralPath $destination -PathType Leaf) {
        if ($expectedHash) { Assert-Hash $destination $expectedHash }
        return
    }
    $partial = $destination + '.' + [Guid]::NewGuid().ToString('N') + '.partial'
    $curl = Join-Path $env:SystemRoot 'System32/curl.exe'
    try {
        & $curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --connect-timeout 30 --max-time 600 --retry 2 --retry-all-errors --retry-delay 2 --output $partial $url
        if ($LASTEXITCODE -ne 0) { throw "Download failed ($LASTEXITCODE): $url" }
        if ($expectedHash) { Assert-Hash $partial $expectedHash }
        Move-Item -LiteralPath $partial -Destination $destination
    } finally {
        if (Test-Path -LiteralPath $partial -PathType Leaf) { Remove-Item -LiteralPath $partial -Force }
    }
}
function Get-Verified([string]$url, [string]$destination, [string]$hash) {
    Invoke-HttpsDownload $url $destination @('github.com', 'raw.githubusercontent.com') $hash
}
function Get-RuntimeArchive([string]$url, [string]$destination, [string]$expectedHash) {
    Invoke-HttpsDownload $url $destination @('github.com', 'api.nuget.org') $expectedHash
}
function Extract-SelectedZipEntries([string]$archivePath, [string]$destinationRoot, $runtimeFiles) {
    $zip = [IO.Compression.ZipFile]::OpenRead($archivePath)
    try {
        foreach ($file in $runtimeFiles) {
            $rel = [string]$file.source
            if (-not $rel -or [IO.Path]::IsPathRooted($rel) -or ($rel -split '[\\/]' -contains '..')) {
                throw "Unsafe archive source path: $rel"
            }
            $entryName = $rel.Replace('\', '/')
            $entry = $zip.GetEntry($entryName)
            if (-not $entry) {
                throw "Missing entry in native archive: $entryName"
            }
            $outPath = [IO.Path]::GetFullPath((Join-Path $destinationRoot $rel))
            if (-not $outPath.StartsWith($destinationRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
                throw "Unsafe archive extract path: $rel"
            }
            New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($outPath)) -Force | Out-Null
            [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $outPath, $true)
        }
    } finally {
        $zip.Dispose()
    }
}
function Copy-Runtime([string]$source, [string]$target) {
    # Avoid replacing an identical DLL that an open application may have loaded.
    # Equality only avoids a redundant copy; it never rejects a different build.
    if ((Test-Path -LiteralPath $target -PathType Leaf) -and
        (Get-Item -LiteralPath $source).Length -eq (Get-Item -LiteralPath $target).Length -and
        [Linq.Enumerable]::SequenceEqual[byte]([IO.File]::ReadAllBytes($source), [IO.File]::ReadAllBytes($target))) { return }
    Copy-Item -LiteralPath $source -Destination $target -Force
}
$cache = Resolve-RepoPath 'work/native-cache'
$runtime = Resolve-RepoPath 'work/resources/native'
New-Item -ItemType Directory -Path $cache,$runtime -Force | Out-Null
foreach ($component in $manifest.components) {
    Write-Host "Preparing $($component.id) $($component.version) for development."
    $tempStaging = $null
    try {
        if ($component.format -eq 'source-build') {
            $staging = Resolve-RepoPath $component.localRuntimePath
        } else {
            if ($component.format -ne 'zip') { throw "Unsupported native archive format: $($component.format)" }
            if ($component.id -notmatch '^[A-Za-z0-9_.-]+$' -or $component.version -notmatch '^[A-Za-z0-9_.-]+$' -or
                [IO.Path]::GetFileName($component.archiveFile) -ne $component.archiveFile) { throw 'Unsafe native archive cache path' }
            $versionCache = Join-Path $cache ($component.id + '-' + $component.version)
            New-Item -ItemType Directory -Path $versionCache -Force | Out-Null
            $archive = Join-Path $versionCache $component.archiveFile
            $expectedHash = if ($component.PSObject.Properties['archiveSha256']) { [string]$component.archiveSha256 } else { '' }
            Get-RuntimeArchive $component.archiveUrl $archive $expectedHash
            $tempStaging = Join-Path $cache ($component.id + '-' + [Guid]::NewGuid().ToString('N'))
            New-Item -ItemType Directory -Path $tempStaging | Out-Null
            Extract-SelectedZipEntries $archive $tempStaging $component.runtimeFiles
            $staging = $tempStaging
        }
        foreach ($file in $component.runtimeFiles) {
            $source = [IO.Path]::GetFullPath((Join-Path $staging $file.source))
            if (-not $source.StartsWith($staging + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe archive source path' }
            if ([IO.Path]::GetFileName($file.target) -ne $file.target) { throw 'Native target must be a plain filename' }
            if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Missing native runtime: $source" }
            $target = Join-Path $runtime $file.target
            Copy-Runtime $source $target
        }
    } finally {
        if ($tempStaging -and (Test-Path -LiteralPath $tempStaging)) {
            Remove-Item -LiteralPath $tempStaging -Recurse -Force
        }
    }
    foreach ($notice in $component.noticeFiles) {
        $source = Resolve-RepoPath $notice.path
        Copy-Item -LiteralPath $source -Destination (Join-Path $runtime ([IO.Path]::GetFileName($source))) -Force
    }
}
if ($WithDevModel) {
    foreach ($model in $manifest.models) {
        if ($model.bundled) { throw 'VAD model must remain a first-use download, not a bundled native resource.' }
        $target = Resolve-RepoPath $model.developmentPath
        New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($target)) -Force | Out-Null
        Get-Verified $model.url $target $model.sha256
    }
}
Write-Host 'Native files prepared. Run the native smoke test and application tests to check playback and inference.'
