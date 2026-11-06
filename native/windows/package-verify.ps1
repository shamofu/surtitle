[CmdletBinding()]
param([switch]$DisposableProfile, [string]$ProductionProbe = 'native/windows/package-production-uia.ps1', [switch]$RequireNativeAcceptance, [string]$NativeExternalEvidence, [string]$InstallerDirectory = 'work/target/release/bundle/nsis')
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
$workspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
Set-Location -LiteralPath $workspace
$archiveRef = & node scripts/check-release.mjs --source
if ($LASTEXITCODE -ne 0) { throw 'Corresponding-source packaging requires a clean checkout of the tested revision.' }
& node scripts/check-release.mjs --version-only
if ($LASTEXITCODE -ne 0) { throw 'Release version mismatch.' }
& node scripts/check-production-features.mjs
if ($LASTEXITCODE -ne 0) { throw 'Development-only AI code must not be packaged.' }
$releaseDir = Join-Path $workspace 'work/artifacts/release'
$sourceDir = Join-Path $workspace 'work/release-source'
foreach ($path in @($releaseDir, $sourceDir)) {
    if (Test-Path -LiteralPath $path) { throw "Release verification requires a fresh directory: $path" }
    New-Item -ItemType Directory -Path $path -Force | Out-Null
}
$installers = @(Get-ChildItem -LiteralPath $InstallerDirectory -Filter '*.exe' -File)
if ($installers.Count -ne 1) { throw 'Exactly one NSIS installer is required.' }
$installer = $installers[0]
$receipt = Get-Content -LiteralPath ($installer.FullName + '.build.json') -Raw | ConvertFrom-Json
if ($receipt.sourceRevision -ne $archiveRef.Trim() -or $receipt.sourceTreeClean -ne $true) { throw 'The selected installer must be built from the exact clean source revision being packaged.' }
$profileArguments = if ($DisposableProfile) { @('-DisposableProfile') } else { @() }
$verifyNative = $RequireNativeAcceptance -or [bool]$NativeExternalEvidence
$nativeArguments = if ($verifyNative) { @('-RequireNativeAcceptance') } else { @() }
$externalArguments = if ($NativeExternalEvidence) { @('-NativeExternalEvidence',$NativeExternalEvidence) } else { @() }
& pwsh -NoProfile -File native/windows/package-installer-smoke.ps1 -Installer $installer.FullName -InstallDirectory 'work/installer-test/日本語 & application' -ProductionProbe $ProductionProbe @profileArguments @nativeArguments @externalArguments
if ($LASTEXITCODE -ne 0) { throw 'Installer lifecycle or production application verification failed.' }
if ($verifyNative) {
    & node scripts/check-native-acceptance.mjs work/artifacts/native-acceptance/gpui-native-acceptance.json ($installer.FullName + '.build.json')
    if ($LASTEXITCODE -ne 0) { throw 'Requested native acceptance evidence is incomplete or belongs to another production binary.' }
}
Copy-Item -LiteralPath $installer.FullName -Destination $releaseDir
Copy-Item -LiteralPath ($installer.FullName + '.build.json') -Destination $releaseDir
foreach ($name in @('native-smoke.json', 'installer-smoke.json', 'production-smoke.json')) {
    Copy-Item -LiteralPath (Join-Path 'work/artifacts' $name) -Destination $releaseDir
}
if ($verifyNative) {
    foreach ($file in Get-ChildItem -LiteralPath 'work/artifacts/native-acceptance' -File) {
        # Evidence references are relative to the comprehensive report. Keep those
        # exact file names together in release staging; publication uploads payloads only.
        if ($file.Name -eq 'production-smoke.json') { continue }
        if (Test-Path -LiteralPath (Join-Path $releaseDir $file.Name)) { throw 'Native acceptance evidence collides with a release asset.' }
        Copy-Item -LiteralPath $file.FullName -Destination $releaseDir
    }
}
Copy-Item -LiteralPath 'native/runtime-windows-x64.json' -Destination (Join-Path $releaseDir 'native-runtime-manifest.json')
& cargo metadata --locked --offline --format-version 1 | Out-File -LiteralPath (Join-Path $releaseDir 'rust-dependencies.json') -Encoding utf8
if ($LASTEXITCODE -ne 0) { throw 'Rust dependency inventory failed.' }
& git archive --format=zip --output=work/application-source.zip $archiveRef
if ($LASTEXITCODE -ne 0) { throw 'Application source archive failed.' }
Expand-Archive -LiteralPath 'work/application-source.zip' -DestinationPath $sourceDir -Force
Push-Location -LiteralPath $sourceDir
try {
    $vendorConfiguration = @(& cargo vendor --respect-source-config --locked --offline vendor)
    if ($LASTEXITCODE -ne 0) { throw 'Rust corresponding source could not be vendored.' }
    $configuration = "# >>> pnpm-managed cargo sources >>>`n" + ($vendorConfiguration -join "`n") + "`n# <<< pnpm-managed cargo sources <<<`n"
    New-Item -ItemType Directory -Path '.cargo' -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $sourceDir '.cargo/config.toml'), $configuration, [Text.UTF8Encoding]::new($false))
} finally { Pop-Location }
& node scripts/audit-js-licenses.mjs (Join-Path $sourceDir 'javascript-packages')
if ($LASTEXITCODE -ne 0) { throw 'JavaScript dependency source collection failed.' }
Copy-Item -LiteralPath 'work/artifacts/js-sbom.cdx.json', 'work/artifacts/js-licenses.json' -Destination $releaseDir
Copy-Item -LiteralPath 'work/installer-sources' -Destination (Join-Path $sourceDir 'native-installer-sources') -Recurse
$nativeManifest = Get-Content -LiteralPath 'native/runtime-windows-x64.json' -Raw | ConvertFrom-Json
foreach ($component in $nativeManifest.components) {
    if ($component.id -notmatch '^[a-zA-Z0-9_-]+$') { throw 'Native source component ID must be a plain name.' }
    foreach ($field in @('correspondingSource', 'dependencyInventory')) {
        $evidence = $component.redistribution.$field
        if (-not $evidence) { continue }
        if ([IO.Path]::IsPathRooted($evidence.path)) { throw 'Native source paths must be relative to the workspace.' }
        $original = [IO.Path]::GetFullPath((Join-Path $workspace $evidence.path))
        if (-not $original.StartsWith($workspace + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Native source path escapes the workspace.' }
        if ($field -eq 'dependencyInventory' -and -not (Test-Path -LiteralPath $original)) {
            continue
        }
        $item = Get-Item -LiteralPath $original
        if ($item.PSIsContainer) { throw 'Native sources must be regular files.' }
        $ancestor = $item
        while ($ancestor -and $ancestor.FullName.Length -ge $workspace.Length) {
            if ($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Native source paths must not traverse links.' }
            $ancestor = Get-Item -LiteralPath ([IO.Path]::GetDirectoryName($ancestor.FullName))
        }
        $relative = 'native-sources/' + $component.id + '/' + $field + '-' + $item.Name
        $destination = Join-Path $sourceDir $relative
        New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($destination)) -Force | Out-Null
        Copy-Item -LiteralPath $original -Destination $destination
    }
}
$sevenZip = (Get-Command 7z.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
Push-Location -LiteralPath $sourceDir
try {
    & $sevenZip a '-tzip' '-mx=5' (Join-Path $releaseDir 'surtitle-source.zip') '.' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Corresponding-source ZIP creation failed.' }
} finally { Pop-Location }
$version = (& node scripts/check-release.mjs --version-only) -replace '^Version (\d+\.\d+\.\d+) is consistent\.$', '$1'
if ($LASTEXITCODE -ne 0 -or $version -notmatch '^\d+\.\d+\.\d+$') { throw 'Workspace version could not be read.' }
@{ schemaVersion=1; version=$version; installer=$installer.Name; installerSmokePassed=$true; nativeAcceptanceRequired=[bool]$verifyNative } |
    ConvertTo-Json | Set-Content -LiteralPath (Join-Path $releaseDir 'release-manifest.json') -Encoding utf8NoBOM
& node scripts/release.mjs --check
if ($LASTEXITCODE -ne 0) { throw 'Release asset verification failed.' }
