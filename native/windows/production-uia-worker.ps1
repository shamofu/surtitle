# SPDX-License-Identifier: GPL-3.0-or-later
# Windows PowerShell 5 supplies the OS .NET Framework UIAutomation assemblies.
# This worker is launched with the existing standard-user, kill-on-close job wrapper.
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Application,
    [Parameter(Mandatory)][string]$DataRoot,
    [Parameter(Mandatory)][string]$Fixture,
    [Parameter(Mandatory)][string]$Output,
    [Parameter(Mandatory)][string]$AppId,
    [Parameter(Mandatory)][string]$BuildReceipt,
    [switch]$DisposableProfile
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'production-uia-common.ps1')
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$identity = Get-Content -LiteralPath (Join-Path $workspace 'packaging/app.json') -Raw | ConvertFrom-Json
if ($AppId -ne $identity.identifier -and $AppId -notmatch '^app\.surtitle\.evaluation\.[a-z0-9]+$') { throw 'Unknown application identity.' }
Assert-ProbePaths $workspace $Application $Output $identity.executable
Assert-SeededProfileSkeleton $DataRoot
$local = [Environment]::GetFolderPath('LocalApplicationData')
Assert-ProbeContext ($env:OS -eq 'Windows_NT') @{CI=$env:CI;GITHUB_ACTIONS=$env:GITHUB_ACTIONS;RUNNER_ENVIRONMENT=$env:RUNNER_ENVIRONMENT;RUNNER_OS=$env:RUNNER_OS} ([bool]$DisposableProfile) $local $DataRoot $AppId
if ([IO.Path]::GetFullPath($env:LOCALAPPDATA).TrimEnd('\') -ine $local.TrimEnd('\')) { throw 'LOCALAPPDATA differs from the Windows known folder.' }
$roaming = Join-Path ([Environment]::GetFolderPath('ApplicationData')) $AppId
if ($roaming -ine $DataRoot -and (Test-Path -LiteralPath $roaming)) { throw 'Existing roaming profile is protected.' }
Assert-NoProbeLinks $BuildReceipt
$receipt = Get-Content -LiteralPath $BuildReceipt -Raw | ConvertFrom-Json
if ($receipt.schema -ne 1 -or $receipt.productionBuild -ne $true -or $receipt.command -ne 'cargo build --release --locked --package surtitle --no-default-features' -or $receipt.executableSha256 -ine (Get-FileHash -LiteralPath $Application -Algorithm SHA256).Hash) { throw 'Missing matching production build provenance.' }
$beforeText = & python -B (Join-Path $PSScriptRoot 'production-profile.py') $DataRoot $Fixture before
if ($LASTEXITCODE -ne 0) { throw 'Initial read-only production profile audit failed.' }
$before = $beforeText | ConvertFrom-Json
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase
Add-Type -Path (Join-Path $PSScriptRoot 'production-uia.cs') -ReferencedAssemblies ([System.Windows.Automation.AutomationElement].Assembly.Location), ([System.Windows.Automation.AutomationElementIdentifiers].Assembly.Location), ([System.Windows.Rect].Assembly.Location)
function Wait-For([scriptblock]$Condition, [string]$Stage, [int]$Seconds = 20) {
    $script:probeStage = $Stage
    $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
    do {
        if (& $Condition) { return }
        if ($app.HasExited) { throw "Application exited during $Stage" }
        Start-Sleep -Milliseconds 75
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "Timed out during $Stage"
}
function Find-Id([string]$Id) { [SurtitleProductionUia]::Id([SurtitleProductionUia]::Root($app), $Id) }
function Seek-Slider { [SurtitleProductionUia]::Slider([SurtitleProductionUia]::Root($app), 'Playback position', '再生位置') }
$start = New-Object Diagnostics.ProcessStartInfo
$start.FileName = $Application; $start.WorkingDirectory = [IO.Path]::GetDirectoryName($Application)
$start.UseShellExecute = $false
foreach ($name in @($start.EnvironmentVariables.Keys)) {
    if ($name -like 'SURTITLE_*' -or $name -like 'WEBVIEW2_*' -or $name -in @('GOOGLE_APPLICATION_CREDENTIALS','GOOGLE_API_KEY','OPENAI_API_KEY','AZURE_OPENAI_API_KEY')) { $start.EnvironmentVariables.Remove($name) }
}
$app = [Diagnostics.Process]::Start($start)
try {
    Wait-For { $null -ne (Find-Id 'nav-settings') } 'initial accessible window'
    [SurtitleProductionUia]::Activate((Find-Id 'nav-settings'))
    Wait-For { $null -ne (Find-Id 'settings-learningLanguage') } 'settings route'
    if ([SurtitleProductionUia]::Value((Find-Id 'settings-learningLanguage')) -ne 'en') { throw 'Default language differs from the seeded production profile.' }
    [SurtitleProductionUia]::Activate((Find-Id 'nav-library'))
    Wait-For { $null -ne (Find-Id 'study-fixture-media') } 'seeded library media'
    [SurtitleProductionUia]::Activate((Find-Id 'study-fixture-media'))
    Wait-For {
        $toggle = Find-Id 'play-toggle'; $metadata = Find-Id 'player-metadata'
        $null -ne $toggle -and $toggle.Current.IsEnabled -and $null -ne $metadata -and
            $metadata.Current.Name -match '^0:(11|12) · 640 × 360$' -and [SurtitleProductionUia]::VideoSurface($app)
    } 'real libmpv metadata and visible native video surface' 35
    $metadataName = (Find-Id 'player-metadata').Current.Name
    $volume = [SurtitleProductionUia]::Slider([SurtitleProductionUia]::Root($app), 'Volume', '音量')
    [SurtitleProductionUia]::SetRange($volume, 100, 0)
    # Seek away from the end and confirm a paused baseline before testing progress.
    if (-not [SurtitleProductionUia]::IsPaused((Find-Id 'play-toggle'))) { [SurtitleProductionUia]::Activate((Find-Id 'play-toggle')) }
    Wait-For { [SurtitleProductionUia]::IsPaused((Find-Id 'play-toggle')) } 'paused baseline'
    [SurtitleProductionUia]::SetRange((Seek-Slider), 10000, 1000)
    Wait-For { [Math]::Abs([SurtitleProductionUia]::Range((Seek-Slider),10000)-1000) -lt 200 } 'seek baseline'
    $position = [SurtitleProductionUia]::Range((Seek-Slider),10000)
    [SurtitleProductionUia]::Activate((Find-Id 'play-toggle'))
    Wait-For { -not [SurtitleProductionUia]::IsPaused((Find-Id 'play-toggle')) -and [SurtitleProductionUia]::Range((Seek-Slider),10000) -gt $position+300 } 'actual playback advancement'
    [SurtitleProductionUia]::Activate((Find-Id 'play-toggle'))
    Wait-For { [SurtitleProductionUia]::IsPaused((Find-Id 'play-toggle')) } 'pause acknowledgement'
    $paused = [SurtitleProductionUia]::Range((Seek-Slider),10000)
    $deadline = [DateTime]::UtcNow.AddMilliseconds(650)
    do {
        if (-not [SurtitleProductionUia]::IsPaused((Find-Id 'play-toggle')) -or [Math]::Abs([SurtitleProductionUia]::Range((Seek-Slider),10000)-$paused) -gt 120) { throw 'Playback did not remain paused.' }
        Start-Sleep -Milliseconds 75
    } while ([DateTime]::UtcNow -lt $deadline)
    [SurtitleProductionUia]::SetRange((Seek-Slider),10000,7000)
    Wait-For { [Math]::Abs([SurtitleProductionUia]::Range((Seek-Slider),10000)-7000) -lt 200 } 'production seek acknowledgement'
    if (-not $app.CloseMainWindow() -or -not $app.WaitForExit(15000) -or $app.ExitCode -ne 0) { throw 'Production application did not close cleanly.' }
    $afterText = & python -B (Join-Path $PSScriptRoot 'production-profile.py') $DataRoot $Fixture after
    if ($LASTEXITCODE -ne 0) { throw 'Final read-only production profile audit failed.' }
    $after = $afterText | ConvertFrom-Json
    if ($before.learningSha256 -ne $after.learningSha256) { throw 'Playback modified learning content.' }
    $result = [ordered]@{schema=1;passed=$true;normalBuild=$true;executableSha256=$receipt.executableSha256;paidRequests=0;metadata=$metadataName;nativeVideoSurface=$true;playbackAdvanced=$true;pauseStable=$true;seekAcknowledged=$true;learningSha256=$after.learningSha256;mediaCount=1;cardCount=1;subtitleCount=20000}
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($result | ConvertTo-Json -Depth 5))
    $stream = [IO.File]::Open($Output,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try { $stream.Write($bytes,0,$bytes.Length) } finally { $stream.Dispose() }
} catch {
    throw "Production UIA failed after stage '$probeStage': $($_.Exception.Message)"
} finally {
    if (-not $app.HasExited) { $app.Kill(); $app.WaitForExit() }
    $app.Dispose()
}
