[CmdletBinding()]
param([switch]$WithDevModel)
$ErrorActionPreference = 'Stop'
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
function Get-Verified([string]$url, [string]$destination, [string]$hash) {
    if (Test-Path -LiteralPath $destination) { Assert-Hash $destination $hash; return }
    $uri = [Uri]$url
    if ($uri.Scheme -ne 'https' -or $uri.Host -notin @('github.com','raw.githubusercontent.com')) { throw "Unexpected upstream URL: $url" }
    $partial = $destination + '.partial'
    Invoke-WebRequest -Uri $url -OutFile $partial -MaximumRedirection 8 -TimeoutSec 900
    Assert-Hash $partial $hash
    Move-Item -LiteralPath $partial -Destination $destination
}
function Get-RuntimeArchive([string]$url, [string]$destination) {
    if (Test-Path -LiteralPath $destination -PathType Leaf) { return }
    $uri = [Uri]$url
    if ($uri.Scheme -ne 'https' -or $uri.Host -ne 'github.com') { throw "Unexpected upstream URL: $url" }
    $partial = $destination + '.partial'
    Invoke-WebRequest -Uri $url -OutFile $partial -MaximumRedirection 8 -TimeoutSec 900
    Move-Item -LiteralPath $partial -Destination $destination
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
$runtime = Resolve-RepoPath 'src-tauri/resources/native'
New-Item -ItemType Directory -Path $cache,$runtime -Force | Out-Null
$receipts = @()
foreach ($component in $manifest.components) {
    Write-Host "Preparing $($component.id) $($component.version) for development."
    if ($component.format -eq 'source-build') {
        $sources = Get-Content -LiteralPath (Join-Path $repoRoot 'native/build/sources.json') -Raw | ConvertFrom-Json
        $inputSource = @($sources.sources | Where-Object id -eq $component.sourceId)
        if ($inputSource.Count -ne 1) { throw 'Source-built runtime must identify one pinned source input.' }
        $sourcePage = "https://github.com/$($inputSource[0].repo)/tree/$($inputSource[0].commit)"
        $staging = Resolve-RepoPath $component.localRuntimePath
    } else {
        $sourcePage = $component.sourcePage
        if ($component.format -ne 'zip') { throw "Unsupported native archive format: $($component.format)" }
        if ($component.id -notmatch '^[A-Za-z0-9_.-]+$' -or $component.version -notmatch '^[A-Za-z0-9_.-]+$' -or
            [IO.Path]::GetFileName($component.archiveFile) -ne $component.archiveFile) { throw 'Unsafe native archive cache path' }
        $versionCache = Join-Path $cache ($component.id + '-' + $component.version)
        New-Item -ItemType Directory -Path $versionCache -Force | Out-Null
        $archive = Join-Path $versionCache $component.archiveFile
        Get-RuntimeArchive $component.archiveUrl $archive
        $staging = Join-Path $cache ($component.id + '-' + [Guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $staging | Out-Null
        Expand-Archive -LiteralPath $archive -DestinationPath $staging
    }
    foreach ($file in $component.runtimeFiles) {
        $source = [IO.Path]::GetFullPath((Join-Path $staging $file.source))
        if (-not $source.StartsWith($staging + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe archive source path' }
        if ([IO.Path]::GetFileName($file.target) -ne $file.target) { throw 'Native target must be a plain filename' }
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Missing native runtime: $source" }
        $target = Join-Path $runtime $file.target
        Copy-Runtime $source $target
        $receipts += @{component=$component.id;file=$file.target;source=$sourcePage}
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
$artifacts = Resolve-RepoPath 'artifacts'
New-Item -ItemType Directory -Path $artifacts -Force | Out-Null
@{schemaVersion=1;preparedAt=[DateTime]::UtcNow.ToString('o');files=$receipts} |
    ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $artifacts 'native-prepare.json') -Encoding utf8
Write-Host 'Native files prepared. Run the native smoke test and application tests to check playback and inference.'
