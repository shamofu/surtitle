[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Installer,
    [string]$InstallDirectory = 'work/installer-test/日本語 & application',
    [switch]$DisposableProfile,
    [string]$ConfigPath = 'src-tauri/tauri.conf.json',
    [switch]$RenderingAcceptance,
    [string]$EvidenceDirectory = 'artifacts'
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
Set-Location -LiteralPath $workspace
if (-not $IsWindows) { throw 'NSIS verification requires Windows.' }
if ($env:CI -ne 'true' -and -not $DisposableProfile) { throw 'Use an isolated CI runner or explicitly supply -DisposableProfile in a disposable Windows user profile.' }
$installerPath = (Resolve-Path -LiteralPath $Installer).Path
$installRoot = [IO.Path]::GetFullPath($InstallDirectory, $workspace)
if (-not $installRoot.StartsWith($workspace + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Test install path must stay inside the repository.' }
if (Test-Path -LiteralPath $installRoot) { throw 'Test install directory must be fresh.' }
$evidenceRoot = [IO.Path]::GetFullPath($EvidenceDirectory, $workspace)
if (-not $evidenceRoot.StartsWith($workspace + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Test evidence must stay inside the repository.' }
New-Item -ItemType Directory -Path $evidenceRoot -Force | Out-Null
$config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
if ($ConfigPath -ne 'src-tauri/tauri.conf.json' -and ($config.identifier -notmatch '^app\.surtitle\.evaluation\.[a-z0-9]+$' -or $config.productName -notmatch '^Surtitle Evaluation [A-Za-z0-9]+$')) { throw 'An override must identify a separate evaluation app, never the installed product.' }
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
            $expected = Join-Path (Join-Path $workspace 'src-tauri/resources/native') $file.target
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
    if (Get-ChildItem -LiteralPath $installRoot -Recurse -File | Where-Object { $_.Name -in @('ffmpeg.exe','ffprobe.exe','yt-dlp.exe','deno.exe') -or $_.Extension -eq '.onnx' }) { throw 'On-demand dependencies were bundled.' }
    if (Get-ChildItem -LiteralPath $installRoot -Recurse -File | Where-Object { $_.Name -in @('msvcp140.dll','msvcp140_1.dll','vcruntime140.dll','vcruntime140_1.dll','vulkan-1.dll','MicrosoftEdgeWebview2Setup.exe','MicrosoftEdgeWebView2RuntimeInstaller.exe') }) { throw 'A separately installed or unused Microsoft/Vulkan runtime was bundled.' }
    & pwsh -NoProfile -File native/windows/native-smoke.ps1 -RuntimeDirectory $runtime
    if ($LASTEXITCODE -ne 0) { throw 'Installed native libraries failed to initialize.' }
}
function Probe-Production {
    $fixture = Join-Path $workspace 'test-results/fixtures/日本語 & sample.mp4'
    $localData = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) $config.identifier
    if (-not (Test-Path -LiteralPath $fixture -PathType Leaf)) { throw 'Generate the local 12-second media fixture before production verification.' }
    & cargo build -p surtitle-core --example seed_fixture --locked
    if ($LASTEXITCODE -ne 0) { throw 'Disposable production learning fixture build failed.' }
    # Create the profile and SQLite files with the same restricted token as the app.
    $seedApplication = Join-Path $workspace 'target/debug/examples/seed_fixture.exe'
    $seedArguments = ConvertTo-Json -InputObject @($localData, $fixture) -Compress
    $seedArgumentsBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($seedArguments))
    & pwsh -NoProfile -File e2e/support/run-windows-standard-user.ps1 -Application $seedApplication -ArgumentsBase64 $seedArgumentsBase64
    if ($LASTEXITCODE -ne 0) { throw 'Disposable production learning fixture preparation failed.' }
    $arguments = @('native/windows/package-production-smoke.mjs', '--application', $binary,
        '--data-root', $localData, '--fixture', $fixture,
        '--driver', (Join-Path $workspace 'work/driver/bin/tauri-driver.exe'),
        '--native-driver', (Join-Path $workspace 'work/webdriver/msedgedriver.exe'),
        '--output', (Join-Path $evidenceRoot 'production-smoke.json'))
    if ($DisposableProfile) { $arguments += '--disposable-profile' }
    if ($config.identifier -ne 'app.surtitle.desktop') { $arguments += @('--app-id', $config.identifier) }
    & node @arguments
    if ($LASTEXITCODE -ne 0) { throw 'Installed production application readiness, playback or accounting verification failed.' }
    if ($RenderingAcceptance) {
        if ($config.identifier -notmatch '^app\.surtitle\.evaluation\.[a-z0-9]+$') { throw 'Extra rendering checks require an isolated evaluation identity.' }
        $names = @('SURTITLE_E2E_BINARY', 'SURTITLE_E2E_DATA_DIR', 'SURTITLE_TAURI_DRIVER', 'SURTITLE_NATIVE_DRIVER', 'SURTITLE_WEBDRIVER_PORT')
        $previous = @{}
        foreach ($name in $names) { $previous[$name] = [Environment]::GetEnvironmentVariable($name) }
        try {
            $env:SURTITLE_E2E_BINARY = $binary
            $env:SURTITLE_E2E_DATA_DIR = $localData
            $env:SURTITLE_TAURI_DRIVER = Join-Path $workspace 'work/driver/bin/tauri-driver.exe'
            $env:SURTITLE_NATIVE_DRIVER = Join-Path $workspace 'work/webdriver/msedgedriver.exe'
            $env:SURTITLE_WEBDRIVER_PORT = '4471'
            & node e2e/support/run-native-e2e.mjs --spec e2e/native/rendering-occlusion.e2e.js --spec e2e/native/motion.e2e.js --spec e2e/native/phrase-inspection.e2e.js --spec e2e/native/learning-continuity.e2e.js
            if ($LASTEXITCODE -ne 0) { throw 'Installed production rendering checks failed.' }
        } finally {
            foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name, $previous[$name]) }
        }
    }
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
# /D and _?= deliberately remain last: NSIS treats their remaining text as one path.
Run-Installer $installerPath @('/S', "/D=$installRoot")
Assert-Payload
Probe-Production
$audioRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) ($config.identifier + '/card-audio')
New-Item -ItemType Directory -Path $audioRoot -Force | Out-Null
& ffmpeg -v error -i (Join-Path $workspace 'test-results/fixtures/日本語 & sample.mp4') -t 1 -map '0:a:0' -ac 1 -ar 16000 -c:a pcm_s16le (Join-Path $audioRoot 'installer-retention.wav')
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
    renderingAcceptancePassed=[bool]$RenderingAcceptance
    learningContinuityPassed=[bool]$RenderingAcceptance
    payloadSha256=$payloadHashes
}
$report | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $evidenceRoot 'installer-smoke.json') -Encoding utf8
Write-Host 'Fresh install, same-version overwrite and default-retention uninstall passed. Test data remains in the disposable profile.'
