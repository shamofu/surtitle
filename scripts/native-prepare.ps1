[CmdletBinding()]
param([switch]$WithDevModel)
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
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
$cache = Resolve-RepoPath 'work/native-cache'
$runtime = Resolve-RepoPath 'src-tauri/resources/native'
New-Item -ItemType Directory -Path $cache,$runtime -Force | Out-Null
$receipts = @()
foreach ($component in $manifest.components) {
    Write-Host "Preparing $($component.id) $($component.version) for development."
    if ($component.format -eq 'source-build') {
        $staging = Resolve-RepoPath $component.localRuntimePath
        $sourceBundle = Resolve-RepoPath $component.redistribution.correspondingSource.path
        if (-not (Test-Path -LiteralPath $sourceBundle)) { throw 'The reviewed source-built runtime and source bundle are missing. Acquire the same-SHA native-build CI artifact or build the recorded native recipe; an upstream substitute is not permitted.' }
        Assert-Hash $sourceBundle $component.redistribution.correspondingSource.sha256
    } else {
        if ($component.format -ne 'zip') { throw "Unsupported native archive format: $($component.format)" }
        $archive = Join-Path $cache $component.archiveFile
        Get-Verified $component.archiveUrl $archive $component.archiveSha256
        $staging = Join-Path $cache ($component.id + '-' + [Guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $staging | Out-Null
        Expand-Archive -LiteralPath $archive -DestinationPath $staging
    }
    foreach ($file in $component.runtimeFiles) {
        $source = [IO.Path]::GetFullPath((Join-Path $staging $file.source))
        if (-not $source.StartsWith($staging + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe archive source path' }
        if ([IO.Path]::GetFileName($file.target) -ne $file.target) { throw 'Native target must be a plain filename' }
        Assert-Hash $source $file.sha256
        $target = Join-Path $runtime $file.target
        if (-not (Test-Path -LiteralPath $target) -or (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ne $file.sha256) {
            Copy-Item -LiteralPath $source -Destination $target -Force
        }
        Assert-Hash $target $file.sha256
        $receipts += @{component=$component.id;file=$file.target;sha256=$file.sha256;source=$component.sourcePage}
    }
    foreach ($notice in $component.noticeFiles) {
        $source = Resolve-RepoPath $notice.path
        Assert-Hash $source $notice.sha256
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
@{schemaVersion=1;sha=$env:GITHUB_SHA;preparedAt=[DateTime]::UtcNow.ToString('o');releaseEligible=$false;files=$receipts} |
    ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $artifacts 'native-prepare.json') -Encoding utf8
Write-Host 'Native files verified. Run node scripts/native-audit.mjs --release and the separate application/installer checks before packaging.'
