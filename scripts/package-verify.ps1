$ErrorActionPreference = 'Stop'
$workspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
Set-Location -LiteralPath $workspace
if ($env:GITHUB_SHA -notmatch '^[a-f0-9]{40}$') { throw 'Run installer verification in the isolated CI package job.' }
$head = (& git rev-parse HEAD)
if ($LASTEXITCODE -ne 0 -or $head -ne $env:GITHUB_SHA) { throw 'Checkout differs from the commit being packaged.' }
& node scripts/check-version.mjs
if ($LASTEXITCODE -ne 0) { throw 'Release version mismatch.' }
& node scripts/check-production-features.mjs
if ($LASTEXITCODE -ne 0) { throw 'Development-only AI code must not be packaged.' }
& node scripts/native-audit.mjs --release
if ($LASTEXITCODE -ne 0) { throw 'Native source and license review is incomplete.' }
$releaseDir = Join-Path $workspace 'artifacts/release'
$sourceDir = Join-Path $workspace 'work/release-source'
$installDir = Join-Path $workspace 'work/installer-test/日本語 & application'
foreach ($target in @($releaseDir, $sourceDir)) {
    $resolved = [IO.Path]::GetFullPath($target)
    if (-not $resolved.StartsWith($workspace + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe workspace path' }
    if (Test-Path -LiteralPath $resolved) { throw "Release packaging requires a fresh directory: $resolved" }
    New-Item -ItemType Directory -Force -Path $resolved | Out-Null
}
$installers = @(Get-ChildItem -LiteralPath (Join-Path $workspace 'target/release/bundle/nsis') -Filter '*.exe' -File)
if ($installers.Count -ne 1) { throw 'Exactly one NSIS installer is required.' }
$installer = $installers[0]
& pwsh -NoProfile -File scripts/native-installer-audit.ps1 -Installer $installer.FullName
if ($LASTEXITCODE -ne 0) { throw 'Exact embedded installer component/source audit failed.' }
& pwsh -NoProfile -File scripts/package-installer-smoke.ps1 -Installer $installer.FullName -InstallDirectory $installDir
if ($LASTEXITCODE -ne 0) { throw 'Fresh install, overwrite, uninstall or default data retention verification failed.' }
$nativeManifest = Get-Content -LiteralPath (Join-Path $workspace 'native/runtime-windows-x64.json') -Raw | ConvertFrom-Json
Copy-Item -LiteralPath $installer.FullName -Destination $releaseDir
Copy-Item -LiteralPath (Join-Path $workspace 'artifacts/native-audit.json') -Destination $releaseDir
Copy-Item -LiteralPath (Join-Path $workspace 'artifacts/native-smoke.json') -Destination $releaseDir
Copy-Item -LiteralPath (Join-Path $workspace 'artifacts/installer-smoke.json') -Destination $releaseDir
Copy-Item -LiteralPath (Join-Path $workspace 'artifacts/production-smoke.json') -Destination $releaseDir
Copy-Item -LiteralPath (Join-Path $workspace 'artifacts/installer-audit.json') -Destination $releaseDir
Copy-Item -LiteralPath (Join-Path $workspace 'work/native-installer-tools/receipt.json') -Destination (Join-Path $releaseDir 'installer-build-receipt.json')
Copy-Item -LiteralPath (Join-Path $workspace 'native/runtime-windows-x64.json') -Destination (Join-Path $releaseDir 'native-runtime-manifest.json')
Copy-Item -LiteralPath (Join-Path $workspace 'work/native-ci-artifact/native-build-artifact.json') -Destination $releaseDir
node scripts/audit-js-licenses.mjs
if ($LASTEXITCODE -ne 0) { throw 'JavaScript license audit failed.' }
Copy-Item -Path (Join-Path $workspace 'artifacts/*sbom*'), (Join-Path $workspace 'artifacts/js-licenses.json') -Destination $releaseDir
cargo metadata --locked --offline --format-version 1 | Out-File -LiteralPath (Join-Path $releaseDir 'rust-dependencies.json') -Encoding utf8
if ($LASTEXITCODE -ne 0) { throw 'Rust dependency inventory failed.' }
& git diff --exit-code -- Cargo.toml Cargo.lock package.json pnpm-lock.yaml pnpm-workspace.yaml
if ($LASTEXITCODE -ne 0) { throw 'Dependency manifests changed after the tested checkout; do not archive different source inputs.' }
git archive --format=zip --output=work/application-source.zip $env:GITHUB_SHA
if ($LASTEXITCODE -ne 0) { throw 'Source archive failed.' }
Expand-Archive -LiteralPath (Join-Path $workspace 'work/application-source.zip') -DestinationPath $sourceDir -Force
# CI-built native hashes are generated without a commit. Ship the effective
# manifest that was tested, rather than the checkout's local candidate hashes.
Copy-Item -LiteralPath (Join-Path $workspace 'native/runtime-windows-x64.json') -Destination (Join-Path $sourceDir 'native/runtime-windows-x64.json') -Force
Copy-Item -LiteralPath (Join-Path $workspace 'work/native-ci-artifact/native-build-artifact.json') -Destination (Join-Path $sourceDir 'native/native-build-artifact.json')
Push-Location -LiteralPath $sourceDir
try {
    # Keep the emitted source replacement portable after extracting the ZIP.
    $vendorConfiguration = @(cargo vendor --respect-source-config --locked --offline vendor)
    if ($LASTEXITCODE -ne 0) { throw 'Rust corresponding source could not be vendored.' }
    # A later pnpm install can replace this portable mapping without duplicate tables.
    $portableConfiguration = "# >>> pnpm-managed cargo sources >>>`n" + ($vendorConfiguration -join "`n") + "`n# <<< pnpm-managed cargo sources <<<`n"
    [IO.File]::WriteAllText((Join-Path $sourceDir 'vendor-config.toml'), $portableConfiguration, [Text.UTF8Encoding]::new($false))
    New-Item -ItemType Directory -Path '.cargo' -Force | Out-Null
    Copy-Item -LiteralPath 'vendor-config.toml' -Destination '.cargo/config.toml'
} finally { Pop-Location }
# Complete installed JavaScript packages retain the license/source files needed
# to reconstruct the exact renderer dependency tree; lockfiles identify versions.
node scripts/audit-js-licenses.mjs (Join-Path $sourceDir 'javascript-packages')
if ($LASTEXITCODE -ne 0) { throw 'JavaScript dependency source collection failed.' }
$nativeSources = Join-Path $sourceDir 'native-sources'
$installerSources = Join-Path $sourceDir 'native-installer-sources'
New-Item -ItemType Directory -Path $installerSources | Out-Null
$installerReceipt = Get-Content -LiteralPath (Join-Path $workspace 'work/native-installer-tools/receipt.json') -Raw | ConvertFrom-Json
Copy-Item -LiteralPath (Join-Path $workspace 'work/native-installer-tools/receipt.json') -Destination (Join-Path $installerSources 'installer-build-receipt.json')
foreach ($item in $installerReceipt.sourcePackages) {
    if ([IO.Path]::GetFileName($item.file) -ne $item.file) { throw 'Installer source filename must be plain.' }
    Copy-Item -LiteralPath (Join-Path $workspace ('work/native-installer-tools/sources/' + $item.file)) -Destination (Join-Path $installerSources $item.file)
}
& node scripts/native-installer-audit.mjs source-check $sourceDir
if ($LASTEXITCODE -ne 0) { throw 'Installer corresponding-source staging failed.' }
New-Item -ItemType Directory -Path $nativeSources | Out-Null
# Copy the exact files bound to the successful audit. Never recursively copy an
# unbounded/symlinked artifact directory into the corresponding-source bundle.
foreach ($component in $nativeManifest.components) {
    $componentSources = Join-Path $nativeSources $component.id
    New-Item -ItemType Directory -Path $componentSources | Out-Null
    foreach ($field in @('correspondingSource','dependencyInventory','reviewEvidence')) {
        $evidence = $component.redistribution.$field
        if (-not $evidence) { continue }
        $evidencePath = [IO.Path]::GetFullPath((Join-Path $workspace $evidence.path))
        if (-not $evidencePath.StartsWith($workspace + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Native evidence escapes workspace.' }
        $item = Get-Item -LiteralPath $evidencePath
        if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Native evidence must be a regular file.' }
        if ((Get-FileHash -LiteralPath $evidencePath -Algorithm SHA256).Hash -ne $evidence.sha256) { throw 'Native evidence changed after audit.' }
        Copy-Item -LiteralPath $evidencePath -Destination (Join-Path $componentSources ($field + '-' + $item.Name))
    }
}
& node scripts/native-ci-source-check.mjs $sourceDir (Join-Path $workspace 'work/native-ci-artifact') $env:GITHUB_SHA --reference-workspace $workspace
if ($LASTEXITCODE -ne 0) { throw 'Corresponding source differs from the tested native artifact or committed inputs.' }
$sevenZip = Get-Command 7z.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
$archiver = if ($sevenZip) { $sevenZip.Source } else { Join-Path ${env:ProgramFiles} '7-Zip/7z.exe' }
if (-not (Test-Path -LiteralPath $archiver)) { throw '7-Zip is required for a ZIP64 source archive with all dotfiles.' }
Push-Location -LiteralPath $sourceDir
try {
    & $archiver a '-tzip' '-mx=5' (Join-Path $releaseDir 'surtitle-source.zip') '.' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Corresponding-source archive failed.' }
} finally { Pop-Location }
$sourceCheck = Join-Path $workspace 'work/release-source-check'
if (Test-Path -LiteralPath $sourceCheck) { throw 'Source archive verification directory must be fresh.' }
New-Item -ItemType Directory -Path $sourceCheck | Out-Null
& $archiver x '-y' ('-o' + $sourceCheck) (Join-Path $releaseDir 'surtitle-source.zip') 'native/runtime-windows-x64.json' 'native/native-build-artifact.json' 'native/build/*' 'scripts/native-build.sh' 'scripts/native-source-inputs.py' 'scripts/native-build-evidence.py' 'native-sources/*' 'native-installer-sources/*' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Cannot verify the effective native manifest inside the source archive.' }
& node scripts/native-ci-source-check.mjs $sourceCheck (Join-Path $workspace 'work/native-ci-artifact') $env:GITHUB_SHA --reference-workspace $workspace
if ($LASTEXITCODE -ne 0) { throw 'The source archive does not contain the exact tested native manifest and receipt.' }
& node scripts/native-installer-audit.mjs source-check $sourceCheck
if ($LASTEXITCODE -ne 0) { throw 'The source archive omitted exact installer sources or its build receipt.' }
$files = @{}
Get-ChildItem -LiteralPath $releaseDir -File | ForEach-Object { $files[$_.Name] = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant() }
$version = (Get-Content -LiteralPath 'package.json' -Raw | ConvertFrom-Json).version
@{schemaVersion=1;sha=$env:GITHUB_SHA;version=$version;installerSmokePassed=$true;files=$files} |
    ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $releaseDir 'release-manifest.json') -Encoding utf8
Get-ChildItem -LiteralPath $releaseDir -File | Where-Object Name -NE 'SHA256SUMS.txt' | Sort-Object Name | ForEach-Object { "$( (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant())  $($_.Name)" } | Set-Content -LiteralPath (Join-Path $releaseDir 'SHA256SUMS.txt') -Encoding utf8
# Validate the complete artifact on main and PRs as well as release pushes.
# This contract checks evidence and hashes only; it never publishes anything.
& node --input-type=module -e 'import { readFileSync } from "node:fs"; import { validateRelease } from "./scripts/release-contract.mjs"; validateRelease("artifacts/release", process.env.GITHUB_SHA, JSON.parse(readFileSync("package.json", "utf8")).version, { expectedRunId: process.env.GITHUB_RUN_ID, expectedReceiptSha256: process.env.SURTITLE_EXPECTED_NATIVE_RECEIPT_SHA256 });'
if ($LASTEXITCODE -ne 0) { throw 'The packaged artifact failed the same-SHA release contract.' }
if (-not $env:GITHUB_OUTPUT) { throw 'Package verification requires the Actions job output channel.' }
$releaseManifestSha256 = (Get-FileHash -LiteralPath (Join-Path $releaseDir 'release-manifest.json') -Algorithm SHA256).Hash.ToLowerInvariant()
"release-manifest-sha256=$releaseManifestSha256" >> $env:GITHUB_OUTPUT
