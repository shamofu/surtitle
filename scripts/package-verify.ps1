[CmdletBinding()]
param([switch]$DisposableProfile)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
$workspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
Set-Location -LiteralPath $workspace
& node scripts/check-version.mjs
if ($LASTEXITCODE -ne 0) { throw 'Release version mismatch.' }
& node scripts/check-production-features.mjs
if ($LASTEXITCODE -ne 0) { throw 'Development-only AI code must not be packaged.' }
& node scripts/native-audit.mjs --release
if ($LASTEXITCODE -ne 0) { throw 'Native source and notice verification failed.' }
$releaseDir = Join-Path $workspace 'artifacts/release'
$sourceDir = Join-Path $workspace 'work/release-source'
$sourceCheck = Join-Path $workspace 'work/release-source-check'
foreach ($path in @($releaseDir, $sourceDir, $sourceCheck)) {
    if (Test-Path -LiteralPath $path) { throw "Release verification requires a fresh directory: $path" }
    New-Item -ItemType Directory -Path $path -Force | Out-Null
}
$installers = @(Get-ChildItem -LiteralPath 'target/release/bundle/nsis' -Filter '*.exe' -File)
if ($installers.Count -ne 1) { throw 'Exactly one NSIS installer is required.' }
$installer = $installers[0]
# Extract once, then use the observed executable hash throughout the lifecycle test.
& pwsh -NoProfile -File scripts/native-installer-audit.ps1 -Installer $installer.FullName
if ($LASTEXITCODE -ne 0) { throw 'Installer payload verification failed.' }
$profileArguments = if ($DisposableProfile) { @('-DisposableProfile') } else { @() }
& pwsh -NoProfile -File scripts/package-installer-smoke.ps1 -Installer $installer.FullName -InstallDirectory 'work/installer-test/日本語 & application' @profileArguments
if ($LASTEXITCODE -ne 0) { throw 'Installer lifecycle or production application verification failed.' }
Copy-Item -LiteralPath $installer.FullName -Destination $releaseDir
foreach ($name in @('native-audit.json', 'native-smoke.json', 'installer-smoke.json', 'production-smoke.json', 'installer-audit.json')) {
    Copy-Item -LiteralPath (Join-Path 'artifacts' $name) -Destination $releaseDir
}
Copy-Item -LiteralPath 'native/runtime-windows-x64.json' -Destination (Join-Path $releaseDir 'native-runtime-manifest.json')
& cargo metadata --locked --offline --format-version 1 | Out-File -LiteralPath (Join-Path $releaseDir 'rust-dependencies.json') -Encoding utf8
if ($LASTEXITCODE -ne 0) { throw 'Rust dependency inventory failed.' }
$archiveRef = if ($env:GITHUB_SHA) { $env:GITHUB_SHA } else { 'HEAD' }
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
Copy-Item -LiteralPath 'artifacts/js-sbom.cdx.json', 'artifacts/js-licenses.json' -Destination $releaseDir
Copy-Item -LiteralPath 'work/installer-sources' -Destination (Join-Path $sourceDir 'native-installer-sources') -Recurse
$nativeManifest = Get-Content -LiteralPath 'native/runtime-windows-x64.json' -Raw | ConvertFrom-Json
foreach ($component in $nativeManifest.components) {
    foreach ($field in @('correspondingSource', 'dependencyInventory', 'reviewEvidence')) {
        $evidence = $component.redistribution.$field
        if (-not $evidence) { continue }
        $original = [IO.Path]::GetFullPath((Join-Path $workspace $evidence.path))
        if (-not $original.StartsWith($workspace + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Native source evidence escapes the workspace.' }
        $item = Get-Item -LiteralPath $original
        if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Native source evidence must be a regular file.' }
        if ((Get-FileHash -LiteralPath $original -Algorithm SHA256).Hash -ne $evidence.sha256) { throw 'Native source evidence changed.' }
        $relative = 'native-sources/' + $component.id + '/' + $field + '-' + $item.Name
        $destination = Join-Path $sourceDir $relative
        New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($destination)) -Force | Out-Null
        Copy-Item -LiteralPath $original -Destination $destination
        $evidence.path = $relative
    }
}
$nativeManifest | ConvertTo-Json -Depth 50 | Set-Content -LiteralPath (Join-Path $sourceDir 'native/runtime-windows-x64.json') -Encoding utf8NoBOM
$sevenZip = (Get-Command 7z.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
Push-Location -LiteralPath $sourceDir
try {
    & $sevenZip a '-tzip' '-mx=5' (Join-Path $releaseDir 'surtitle-source.zip') '.' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Corresponding-source ZIP creation failed.' }
} finally { Pop-Location }
# Verify the actual ZIP's source archives, not just the directory used to create it.
& $sevenZip x '-y' ('-o' + $sourceCheck) (Join-Path $releaseDir 'surtitle-source.zip') 'native/*' 'native-sources/*' 'native-installer-sources/*' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Cannot extract the source ZIP for verification.' }
& node scripts/native-ci-artifact.mjs verify-source $sourceCheck
if ($LASTEXITCODE -ne 0) { throw 'Native source files are missing or changed in the source ZIP.' }
& node scripts/native-installer-audit.mjs source-check $sourceCheck
if ($LASTEXITCODE -ne 0) { throw 'Installer or Rust source files are missing or changed in the source ZIP.' }
$version = (Get-Content -LiteralPath 'package.json' -Raw | ConvertFrom-Json).version
$audit = Get-Content -LiteralPath 'artifacts/installer-audit.json' -Raw | ConvertFrom-Json
@{ schemaVersion=1; version=$version; installer=$installer.Name; installerSha256=$audit.installerSha256; applicationSha256=$audit.applicationSha256; installerSmokePassed=$true } |
    ConvertTo-Json | Set-Content -LiteralPath (Join-Path $releaseDir 'release-manifest.json') -Encoding utf8NoBOM
Get-ChildItem -LiteralPath $releaseDir -File | Sort-Object Name | ForEach-Object {
    "$( (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant())  $($_.Name)"
} | Set-Content -LiteralPath (Join-Path $releaseDir 'SHA256SUMS.txt') -Encoding utf8NoBOM
& node --input-type=module -e 'import { readFileSync } from "node:fs"; import { validateRelease } from "./scripts/release-contract.mjs"; validateRelease("artifacts/release", JSON.parse(readFileSync("package.json", "utf8")).version);'
if ($LASTEXITCODE -ne 0) { throw 'Release asset verification failed.' }
