[CmdletBinding()]
param([string]$PluginDirectory = 'work/nsis-plugin-build/output')
$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Set-Location -LiteralPath $workspace
if (-not $IsWindows) { throw 'NSIS tool preparation requires Windows.' }
$inputs = Get-Content -LiteralPath native/installer-inputs.json -Raw | ConvertFrom-Json
$downloads = Join-Path $workspace 'work/native-installer-downloads'
$tools = Join-Path $workspace 'target/.tauri'
foreach ($path in @($downloads, $tools)) {
    $cursor = $path
    while ($cursor.StartsWith($workspace, [StringComparison]::OrdinalIgnoreCase)) {
        if ((Test-Path -LiteralPath $cursor) -and ((Get-Item -LiteralPath $cursor).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Installer tool paths must not traverse reparse points.' }
        $cursor = [IO.Path]::GetDirectoryName($cursor)
    }
    New-Item -ItemType Directory -Path $path -Force | Out-Null
}
foreach ($item in @($inputs.toolArchive, $inputs.sourceArchive, $inputs.cacheOnlyPlugin)) {
    $file = Join-Path $downloads $item.file
    if (-not (Test-Path -LiteralPath $file)) {
        $uri = [Uri]$item.url
        if ($uri.Scheme -ne 'https' -or $uri.Host -notin @('github.com','downloads.sourceforge.net')) { throw 'Unexpected installer input origin.' }
        Write-Host "Downloading installer input $($item.file) from $($item.url)"
        # SourceForge sends a browser landing page for PowerShell's default
        # Mozilla User-Agent. Identify this command-line downloader explicitly.
        $response = Invoke-WebRequest -Uri $item.url -UserAgent 'Surtitle-installer-source-audit' -OutFile ($file + '.partial') -PassThru -TimeoutSec 300
        $actualHash = (Get-FileHash -LiteralPath ($file + '.partial') -Algorithm SHA256).Hash.ToLowerInvariant()
        $bytes = (Get-Item -LiteralPath ($file + '.partial')).Length
        $contentType = $response.Headers['Content-Type'] -join ', '
        # Redirect query strings may contain short-lived credentials; log the path only.
        $finalUrl = $response.BaseResponse.RequestMessage.RequestUri.GetLeftPart([UriPartial]::Path)
        Write-Host "Installer response: file=$($item.file); status=$($response.StatusCode); content-type=$contentType; bytes=$bytes; sha256=$actualHash; final-url=$finalUrl"
        if ($actualHash -ne $item.sha256) { throw "Installer download checksum mismatch for $($item.file): expected $($item.sha256), received $actualHash ($bytes bytes; $contentType)." }
        Move-Item -LiteralPath ($file + '.partial') -Destination $file
    }
    if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $item.sha256) { throw "Installer input checksum mismatch for $($item.file)." }
    Write-Host "Verified installer input $($item.file) against its pinned SHA-256."
}
$nsis = Join-Path $tools 'NSIS'
if (Test-Path -LiteralPath $nsis) { throw 'Private NSIS tools already exist; audit the prepared receipt or use a fresh checkout.' }
$unpacked = Join-Path $downloads ('extract-' + [Guid]::NewGuid().ToString('N'))
Expand-Archive -LiteralPath (Join-Path $downloads $inputs.toolArchive.file) -DestinationPath $unpacked
$source = [IO.Path]::GetFullPath((Join-Path $unpacked 'nsis-3.11'))
if (-not $source.StartsWith($downloads + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or -not $nsis.StartsWith($workspace + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe private tool move.' }
Move-Item -LiteralPath $source -Destination $nsis
New-Item -ItemType Directory -Path (Join-Path $nsis 'Plugins/x86-unicode/additional') -Force | Out-Null
# Tauri validates this cache-only input. The custom template never references it.
Copy-Item -LiteralPath (Join-Path $downloads $inputs.cacheOnlyPlugin.file) -Destination (Join-Path $nsis 'Plugins/x86-unicode/additional/nsis_tauri_utils.dll')
& python scripts/native-installer-tool-check.py
if ($LASTEXITCODE -ne 0) { throw 'Private NSIS tools do not match their authenticated archive.' }
& node scripts/native-installer-audit.mjs stage $PluginDirectory
if ($LASTEXITCODE -ne 0) { throw 'Installer source/plugin staging failed.' }
