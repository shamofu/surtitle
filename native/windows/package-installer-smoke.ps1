[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Installer,
    [string]$InstallDirectory = 'work/installer-test/日本語 & application',
    [switch]$DisposableProfile,
    [string]$ConfigPath = 'packaging/app.json',
    [string]$ProductionProbe = 'native/windows/package-production-uia.ps1',
    [string]$NativeAcceptance = 'native/windows/native-acceptance.ps1',
    [switch]$RequireNativeAcceptance,
    [string]$NativeExternalEvidence,
    [string]$EvidenceDirectory = 'work/artifacts'
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
Set-Location -LiteralPath $workspace
if (-not $IsWindows) { throw 'NSIS verification requires Windows.' }
. (Join-Path $PSScriptRoot 'production-uia-common.ps1')
$installerPath = (Resolve-Path -LiteralPath $Installer).Path
$installRoot = [IO.Path]::GetFullPath($InstallDirectory, $workspace)
if (-not $installRoot.StartsWith($workspace + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Test install path must stay inside the repository.' }
if (Test-Path -LiteralPath $installRoot) { throw 'Test install directory must be fresh.' }
$evidenceRoot = [IO.Path]::GetFullPath($EvidenceDirectory, $workspace)
if (-not $evidenceRoot.StartsWith($workspace + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Test evidence must stay inside the repository.' }
New-Item -ItemType Directory -Path $evidenceRoot -Force | Out-Null
$config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
if ($ConfigPath -ne 'packaging/app.json' -and ($config.identifier -notmatch '^app\.surtitle\.evaluation\.[a-z0-9]+$' -or $config.productName -notmatch '^Surtitle Evaluation [A-Za-z0-9]+$')) { throw 'An override must identify a separate evaluation app, never the installed product.' }
Assert-ProbeContext $IsWindows @{CI=$env:CI;GITHUB_ACTIONS=$env:GITHUB_ACTIONS;RUNNER_ENVIRONMENT=$env:RUNNER_ENVIRONMENT;RUNNER_OS=$env:RUNNER_OS} ([bool]$DisposableProfile) ([Environment]::GetFolderPath('LocalApplicationData')) (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) $config.identifier) $config.identifier
$buildReceipt = $installerPath + '.build.json'
$receipt = Get-Content -LiteralPath $buildReceipt -Raw | ConvertFrom-Json
if ($receipt.productionBuild -ne $true -or $receipt.installerSha256 -ine (Get-FileHash -LiteralPath $installerPath -Algorithm SHA256).Hash) { throw 'Installer lacks a matching production build receipt.' }
$dataRoots = @(
    (Join-Path ([Environment]::GetFolderPath('ApplicationData')) $config.identifier),
    (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) $config.identifier)
) | Select-Object -Unique
foreach ($dataRoot in $dataRoots) {
    if (Test-Path -LiteralPath $dataRoot) { throw "Existing app data is protected; use a fresh Windows user profile: $dataRoot" }
}
foreach ($hive in @('HKCU:', 'HKLM:')) {
    $key = "$hive\Software\Microsoft\Windows\CurrentVersion\Uninstall\$($config.productName)"
    if (Test-Path -LiteralPath $key) { throw 'An existing installation is protected; use a fresh Windows user profile.' }
}
$manifest = Get-Content -LiteralPath 'native/runtime-windows-x64.json' -Raw | ConvertFrom-Json
$binary = Join-Path $installRoot 'surtitle.exe'
$payloadHashes = [ordered]@{}
function Run-Installer([string]$path, [string[]]$arguments) {
    $process = Start-Process -FilePath $path -ArgumentList $arguments -PassThru -WindowStyle Hidden
    $deadline = [DateTime]::UtcNow.AddMinutes(3)
    while (-not $process.WaitForExit(1000)) {
        if ([DateTime]::UtcNow -gt $deadline) { $process.Kill($true); throw 'Installer exceeded the three-minute limit.' }
    }
    if ($process.ExitCode -ne 0) { throw "Installer exited with $($process.ExitCode)" }
}
function Assert-InstalledFile([string]$path) {
    $absolute = [IO.Path]::GetFullPath($path)
    if (-not $absolute.StartsWith($installRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Installed resource path escapes the test installation.' }
    $item = Get-Item -LiteralPath $absolute
    if ($item.PSIsContainer) { throw "Installed resource must be a regular file: $path" }
    while ($item -and $item.FullName.Length -ge $installRoot.Length) {
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Installed resource path must not traverse links.' }
        $item = Get-Item -LiteralPath ([IO.Path]::GetDirectoryName($item.FullName))
    }
}
function Assert-Payload {
    Assert-InstalledFile $binary
    $payloadHashes['surtitle.exe'] = (Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash.ToLowerInvariant()
    $runtime = Join-Path $installRoot 'native'
    foreach ($component in $manifest.components) {
        foreach ($file in $component.runtimeFiles) {
            $path = Join-Path $runtime $file.target
            Assert-InstalledFile $path
            $expected = Join-Path (Join-Path $workspace 'work/resources/native') $file.target
            $expectedHash = (Get-FileHash -LiteralPath $expected -Algorithm SHA256).Hash.ToLowerInvariant()
            $installedHash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($installedHash -ne $expectedHash) { throw "Installed native payload differs from the selected runtime: $($file.target)" }
            $payloadHashes[('native/' + $file.target)] = $installedHash
        }
        foreach ($notice in $component.noticeFiles) {
            $path = Join-Path $runtime ([IO.Path]::GetFileName($notice.path))
            Assert-InstalledFile $path
        }
    }
    if (Get-ChildItem -LiteralPath $installRoot -Recurse -File | Where-Object { $_.Name -in @('ffmpeg.exe','ffprobe.exe') -or $_.Extension -eq '.onnx' }) { throw 'On-demand dependencies were bundled.' }
    if (Get-ChildItem -LiteralPath $installRoot -Recurse -File | Where-Object { $_.Name -in @('msvcp140.dll','msvcp140_1.dll','vcruntime140.dll','vcruntime140_1.dll','vulkan-1.dll','MicrosoftEdgeWebview2Setup.exe','MicrosoftEdgeWebView2RuntimeInstaller.exe') }) { throw 'A separately installed or unused Microsoft/Vulkan runtime was bundled.' }
    & pwsh -NoProfile -File native/windows/native-smoke.ps1 -RuntimeDirectory $runtime
    if ($LASTEXITCODE -ne 0) { throw 'Installed native libraries failed to initialize.' }
}
function Probe-Production {
    $fixture = Join-Path $workspace 'work/test-results/fixtures/日本語 & sample.mp4'
    $localData = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) $config.identifier
    if (-not (Test-Path -LiteralPath $fixture -PathType Leaf)) { throw 'Generate the local media fixture before production verification.' }
    & pnpm build:fixtures
    if ($LASTEXITCODE -ne 0) { throw 'Disposable production learning fixture build failed.' }
    $seedApplication = Join-Path $workspace 'work/target/debug/examples/seed_fixture.exe'
    $seedArguments = ConvertTo-Json -InputObject @($localData, $fixture) -Compress
    $seedArgumentsBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($seedArguments))
    & pwsh -NoProfile -File e2e/support/run-windows-standard-user.ps1 -Application $seedApplication -ArgumentsBase64 $seedArgumentsBase64
    if ($LASTEXITCODE -ne 0) { throw 'Disposable production learning fixture preparation failed.' }
    $profileArguments = if ($DisposableProfile) { @('-DisposableProfile') } else { @() }
    & pwsh -NoProfile -File $ProductionProbe -Application $binary -DataRoot $localData -Fixture $fixture -Output (Join-Path $evidenceRoot 'production-smoke.json') -BuildReceipt $buildReceipt -AppId $config.identifier @profileArguments
    if ($LASTEXITCODE -ne 0) { throw 'Installed production GPUI verification failed.' }
    $result = Get-Content -LiteralPath (Join-Path $evidenceRoot 'production-smoke.json') -Raw | ConvertFrom-Json
    if ($result.passed -ne $true -or $result.normalBuild -ne $true -or $result.paidRequests -ne 0) { throw 'Native production evidence is missing or invalid.' }
}
function Snapshot-Data {
    $values = @{}
    foreach ($dataRoot in $dataRoots) {
        # WAL can contain committed pages absent from the main database; rollback
        # journals can be needed for recovery. The rebuildable SHM index is excluded.
        Get-ChildItem -LiteralPath $dataRoot -Recurse -File | Where-Object {
            $_.Name -eq 'installer-retention-sentinel.json' -or $_.Extension -eq '.wav' -or
            $_.Name -match '\.(sqlite|db)(-(wal|journal))?$'
        } | ForEach-Object {
            $values[$_.FullName] = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        }
    }
    return $values
}
function Assert-Data($before) {
    foreach ($path in $before.Keys) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf) -or (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ne $before[$path]) { throw "Installer changed retained learning data: $path" }
    }
}
function Invoke-NativeAcceptance {
    if (-not ($RequireNativeAcceptance -or $NativeExternalEvidence)) { return $false }
    $localData = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) $config.identifier
    $profileArguments = if ($DisposableProfile) { @('-DisposableProfile') } else { @() }
    $externalArguments = if ($NativeExternalEvidence) { @('-ExternalEvidence',$NativeExternalEvidence) } else { @() }
    & pwsh -NoProfile -File $NativeAcceptance -Application $binary -DataRoot $localData -Fixture (Join-Path $workspace 'work/test-results/fixtures/日本語 & sample.mp4') -BuildReceipt $buildReceipt -ProductionSmoke (Join-Path $evidenceRoot 'production-smoke.json') -Output (Join-Path $evidenceRoot 'native-acceptance/gpui-native-acceptance.json') -AppId $config.identifier @profileArguments @externalArguments | Out-Host
    if ($LASTEXITCODE -ne 0) { throw 'Requested GPUI native acceptance failed or is incomplete; retained evidence lists missing cases.' }
    return $true
}
if (-not $ProductionProbe -or -not (Test-Path -LiteralPath $ProductionProbe -PathType Leaf)) { throw 'A native GPUI installed-production UIA probe is required; legacy WebDriver cannot verify this binary.' }
# /D and _?= deliberately remain last: NSIS treats their remaining text as one path.
Run-Installer $installerPath @('/S', "/D=$installRoot")
Assert-Payload
Probe-Production
$nativeAcceptancePassed = Invoke-NativeAcceptance
$audioRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) ($config.identifier + '/card-audio')
New-Item -ItemType Directory -Path $audioRoot -Force | Out-Null
$ffmpeg = if ($env:FFMPEG_PATH) { $env:FFMPEG_PATH } else { (Get-Command ffmpeg -CommandType Application -ErrorAction Stop).Source }
& $ffmpeg -v error -i (Join-Path $workspace 'work/test-results/fixtures/日本語 & sample.mp4') -t 1 -map '0:a:0' -ac 1 -ar 16000 -c:a pcm_s16le (Join-Path $audioRoot 'installer-retention.wav')
if ($LASTEXITCODE -ne 0) { throw 'Generated card-audio retention fixture failed.' }
foreach ($dataRoot in $dataRoots) {
    New-Item -ItemType Directory -Path $dataRoot -Force | Out-Null
    @{ purpose='disposable NSIS retention test'; createdAt=[DateTime]::UtcNow.ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $dataRoot 'installer-retention-sentinel.json') -Encoding utf8
}
$before = Snapshot-Data
if ($before.Count -lt $dataRoots.Count) { throw 'No retention test data was created.' }
if (-not @($before.Keys | Where-Object { [IO.Path]::GetExtension($_) -eq '.wav' }).Count) { throw 'No card-audio retention evidence was created.' }
Run-Installer $installerPath @('/S', "/D=$installRoot")
Assert-Payload
Assert-Data $before
$uninstaller = Join-Path $installRoot 'uninstall.exe'
if (-not (Test-Path -LiteralPath $uninstaller -PathType Leaf)) { throw 'Uninstaller is missing.' }
Run-Installer $uninstaller @('/S', "_?=$installRoot")
if (Test-Path -LiteralPath $binary) { throw 'Uninstall retained the application executable.' }
foreach ($file in $manifest.components.runtimeFiles) {
    if (Test-Path -LiteralPath (Join-Path (Join-Path $installRoot 'native') $file.target)) { throw 'Uninstall retained a bundled native DLL.' }
}
Assert-Data $before
$report = @{
    schemaVersion=1; sha=$env:GITHUB_SHA; testedAt=[DateTime]::UtcNow.ToString('o')
    freshInstallPassed=$true; startupPassed=$true; overwriteInstallPassed=$true
    uninstallPassed=$true; defaultDataRetentionPassed=$true; retainedFileCount=$before.Count
    nonAsciiSpaceAmpersandInstallPath=$true; retainedDataRemoved=$false
    applicationIdentifier=$config.identifier; isolatedIdentity=($config.identifier -ne 'app.surtitle.desktop')
    nativeAcceptancePassed=$nativeAcceptancePassed
    nativeAcceptanceStatus=$(if ($nativeAcceptancePassed) { 'passed' } else { 'not_run' })
    payloadSha256=$payloadHashes
}
$report | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $evidenceRoot 'installer-smoke.json') -Encoding utf8
Write-Host 'Fresh install, same-version overwrite and default-retention uninstall passed. Test data remains in the disposable profile.'
