# SPDX-License-Identifier: GPL-3.0-or-later
# Invoked inside the existing restricted-medium, kill-on-close process job.
# No RPC, browser automation, pointer, keyboard or test feature is used.
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Application,
    [Parameter(Mandatory)][string]$DataRoot,
    [Parameter(Mandatory)][string]$Fixture,
    [Parameter(Mandatory)][string]$Output,
    [Parameter(Mandatory)][string]$AppId,
    [Parameter(Mandatory)][string]$BuildReceipt,
    [Parameter(Mandatory)][string]$ProductionSmoke,
    [switch]$DisposableProfile
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'production-uia-common.ps1')
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$identity = Get-Content -LiteralPath (Join-Path $workspace 'packaging/app.json') -Raw | ConvertFrom-Json
if ($AppId -ne $identity.identifier -and $AppId -notmatch '^app\.surtitle\.evaluation\.[a-z0-9]+$') { throw 'Unknown application identity.' }
Assert-ProbeContext ($env:OS -eq 'Windows_NT') @{CI=$env:CI;GITHUB_ACTIONS=$env:GITHUB_ACTIONS;RUNNER_ENVIRONMENT=$env:RUNNER_ENVIRONMENT;RUNNER_OS=$env:RUNNER_OS} ([bool]$DisposableProfile) ([Environment]::GetFolderPath('LocalApplicationData')) $DataRoot $AppId
Assert-ProbePaths $workspace $Application $Output $identity.executable
Assert-NoProbeLinks $DataRoot
$local = [Environment]::GetFolderPath('LocalApplicationData')
if ([IO.Path]::GetFullPath($env:LOCALAPPDATA).TrimEnd('\') -ine $local.TrimEnd('\')) { throw 'LOCALAPPDATA differs from the Windows known folder.' }
$roaming = Join-Path ([Environment]::GetFolderPath('ApplicationData')) $AppId
if ($roaming -ine $DataRoot -and (Test-Path -LiteralPath $roaming)) { throw 'Existing roaming profile is protected.' }
foreach ($inputPath in @($BuildReceipt,$ProductionSmoke)) { Assert-NoProbeLinks $inputPath }
$receipt = Get-Content -LiteralPath $BuildReceipt -Raw | ConvertFrom-Json
$smoke = Get-Content -LiteralPath $ProductionSmoke -Raw | ConvertFrom-Json
if ($receipt.schema -ne 1 -or $receipt.productionBuild -ne $true -or $receipt.command -ne 'cargo build --release --locked --package surtitle --no-default-features' -or $receipt.executableSha256 -ine (Get-FileHash -LiteralPath $Application -Algorithm SHA256).Hash -or $smoke.executableSha256 -ine $receipt.executableSha256 -or $smoke.passed -ne $true -or $smoke.paidRequests -ne 0) { throw 'Actual installed executable and successful production smoke must match.' }
$revision = & git -C $workspace rev-parse HEAD
if ($LASTEXITCODE -ne 0 -or $receipt.sourceRevision -ne $revision.Trim() -or $receipt.installerSha256 -notmatch '^[a-f0-9]{64}$') { throw 'Native worker must identify the current source revision and installer.' }
$beforeText = & python -B (Join-Path $PSScriptRoot 'production-profile.py') $DataRoot $Fixture after
if ($LASTEXITCODE -ne 0) { throw 'Existing production-smoke fixture failed its read-only audit.' }
$before = $beforeText | ConvertFrom-Json
if ($before.learningSha256 -ne $smoke.learningSha256) { throw 'Learning content changed since production smoke.' }
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes,WindowsBase
Add-Type -Path (Join-Path $PSScriptRoot 'production-uia.cs') -ReferencedAssemblies ([System.Windows.Automation.AutomationElement].Assembly.Location),([System.Windows.Automation.AutomationElementIdentifiers].Assembly.Location),([System.Windows.Rect].Assembly.Location)
$inventory = Get-Content -LiteralPath (Join-Path $workspace 'packaging/native-acceptance.json') -Raw | ConvertFrom-Json
$records = [ordered]@{}
foreach ($item in $inventory.requiredCases) {
    $records[$item.id] = [ordered]@{id=$item.id;method=$item.method;status='not_run';observations=@{summary='An earlier native stage must complete first.'};evidence=@()}
}
$pending = @{
    'dpi-monitor-transitions'='Actual 100/125/150 percent DPI samples and monitor transitions with viewport/native geometry remain unmeasured.'
    'keyboard-clipboard-accessibility'='Real keyboard shortcuts, clipboard round trip and principal screen-reader operations remain unexecuted; ValuePattern is insufficient.'
    'rendered-composition'='No verified GPUI/GPU owned-window capture and pixel/composition analysis has been executed.'
    'real-japanese-ime'='Real Windows Japanese IME preedit, candidate placement, commit and restart remain unimplemented/unexecuted; setting Unicode text is insufficient.'
    'audio-output'='Muted playback does not measure an output signal/device or direct listening. No signal/output observation was acquired.'
    'interval-auto-stop'='This worker has no measured source/sentence interval stop test. Manual pause does not establish timed auto-stop.'
    'long-media'='A 12-second source and synthetic 20000-cue transcript do not establish real long-duration decode/seek/recovery.'
    'gpu-performance'='No CPU/GPU load, dropped-frame or A/V-sync measurements and explicit hardware/workload criteria have been recorded.'
}
foreach ($key in $pending.Keys) { $records[$key].observations.summary = $pending[$key] }
$observations = [ordered]@{}
$copy=Join-Path ([IO.Path]::GetDirectoryName($Output)) 'production-smoke.json'
$app = $null; $mainHandle = 0L; $currentCase = 'production-playback'; $paidRequests = $null
function Wait-For([scriptblock]$Condition, [string]$Stage, [int]$Seconds=20) {
    $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
    do {
        if (& $Condition) { return }
        if ($app -and $app.HasExited) { throw "Application exited during $Stage" }
        Start-Sleep -Milliseconds 75
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "Timed out during $Stage"
}
function Find-Id([string]$Id) { [SurtitleProductionUia]::Id([SurtitleProductionUia]::FromHandle($mainHandle),$Id) }
function Native([string]$Action,[string[]]$Extra=@()) {
    # Reuse the existing application-scoped native helper and its physical-DPI context.
    # PS7 compiles that existing helper's modern C#; the UIA worker uses OS PS5 assemblies.
    $text = & pwsh -NoProfile -NonInteractive -File (Join-Path $workspace 'e2e/support/native-window.ps1') -Action $Action -Application $Application @Extra
    if ($LASTEXITCODE -ne 0) { throw "Owned native window helper failed during $Action" }
    $text | ConvertFrom-Json
}
function Start-App {
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName=$Application; $start.WorkingDirectory=[IO.Path]::GetDirectoryName($Application); $start.UseShellExecute=$false
    foreach($name in @($start.EnvironmentVariables.Keys)) {
        if ($name -like 'SURTITLE_*' -or $name -like 'WEBVIEW2_*' -or $name -in @('GOOGLE_APPLICATION_CREDENTIALS','GOOGLE_API_KEY','OPENAI_API_KEY','AZURE_OPENAI_API_KEY')) { $start.EnvironmentVariables.Remove($name) }
    }
    $script:app=[Diagnostics.Process]::Start($start)
    Wait-For { $app.Refresh(); $app.MainWindowHandle -ne [IntPtr]::Zero } 'native main window'
    $script:mainHandle=$app.MainWindowHandle.ToInt64()
    Wait-For { $null -ne (Find-Id 'nav-library') } 'accessible application routes'
}
function Close-App {
    if (-not $app.CloseMainWindow() -or -not $app.WaitForExit(15000) -or $app.ExitCode -ne 0) { throw 'Application failed clean close/checkpoint.' }
    $app.Dispose(); $script:app=$null; $script:mainHandle=0L
}
function Open-Study {
    [SurtitleProductionUia]::Invoke((Find-Id 'nav-library'))
    Wait-For { $null -ne (Find-Id 'study-fixture-media') } 'seeded library'
    [SurtitleProductionUia]::Invoke((Find-Id 'study-fixture-media'))
    Wait-For { $toggle=Find-Id 'play-toggle'; $meta=Find-Id 'player-metadata'; $toggle -and $toggle.Current.IsEnabled -and $meta -and $meta.Current.Name -match '^0:(11|12) · 640 × 360$' } 'real fixture ready' 35
}
function Mark-Passed([string]$Id,[string]$Summary,$Details) {
    $records[$Id].status='passed'; $records[$Id].observations=@{summary=$Summary;measurements=$Details}; $records[$Id]['source']=@{kind='native-uia';operator='native-acceptance-worker';observedAt=[DateTime]::UtcNow.ToString('o')}; $observations[$Id]=$Details
}
function Same-Rect($Left,$Right,[double]$Tolerance=2) {
    foreach($key in @('Left','Top','Right','Bottom')) { if([Math]::Abs($Left.$key-$Right.$key)-gt $Tolerance){return $false} }; return $true
}
function Assert-Viewport {
    $native=@(Native 'inspect'); $root=$native[0]
    $video=@($native|Where-Object{$_.parent -eq $mainHandle -and $_.visible -and $_.className -ieq 'STATIC'})
    if($video.Count -ne 1){throw 'Expected one visible native video child'}
    $bounds=[SurtitleProductionUia]::Bounds((Find-Id 'player-viewport'))
    $expected=@{Left=$bounds[0];Top=$bounds[1];Right=$bounds[0]+$bounds[2];Bottom=$bounds[1]+$bounds[3]}
    if(-not (Same-Rect $video[0].screen $expected)){throw 'Native child physical bounds disagree with accessible video viewport'}
    return @{windowDpi=$root.dpi;viewport=$expected;nativeVideo=$video[0];root=$root}
}
try {
    [IO.File]::Copy($ProductionSmoke,$copy,$false)
    Mark-Passed 'production-playback' 'Matching installed production smoke observed metadata, video, progress, pause, seek and zero AI activity.' $smoke
    $currentCase='window-geometry'
    Start-App; Open-Study
    $initial=@(Native 'inspect')[0]; $monitor=Native 'monitor'
    $area=@($monitor.monitors|Where-Object{$_.handle -eq $monitor.current})
    if($area.Count -ne 1){throw 'Current monitor identity is ambiguous'}
    $scale=$initial.dpi/96.0
    $frameWidth=($initial.screen.Right-$initial.screen.Left)-($initial.client.Right-$initial.client.Left)
    $frameHeight=($initial.screen.Bottom-$initial.screen.Top)-($initial.client.Bottom-$initial.client.Top)
    if(($area[0].workArea.Right-$area[0].workArea.Left)-lt (1440*$scale+$frameWidth) -or ($area[0].workArea.Bottom-$area[0].workArea.Top)-lt (900*$scale+$frameHeight)){throw 'Desktop work area cannot fit required 1440x900 logical geometry plus its native frame'}
    $null=Native 'resize' @('-Width','1024','-Height','700')
    Wait-For { $r=@(Native 'inspect')[0]; [Math]::Abs(($r.client.Right-$r.client.Left)-[Math]::Floor(1280*$scale))-le 2 -and [Math]::Abs(($r.client.Bottom-$r.client.Top)-[Math]::Floor(720*$scale))-le 2 } 'enforced HD minimum'
    $minimum=@(Native 'inspect')[0]
    $null=Native 'resize' @('-Width','1440','-Height','900')
    Wait-For { $r=@(Native 'inspect')[0]; [Math]::Abs(($r.client.Right-$r.client.Left)-[Math]::Round(1440*$scale))-le 2 -and [Math]::Abs(($r.client.Bottom-$r.client.Top)-[Math]::Round(900*$scale))-le 2 } 'exact native client resize'
    $normal=@(Native 'inspect')[0]
    $null=Native 'maximize'; Wait-For { (@(Native 'inspect')[0]).maximized } 'maximize'
    Close-App; Start-App
    Wait-For { (@(Native 'inspect')[0]).maximized } 'maximized restart persistence'
    $maximized=@(Native 'inspect')[0]
    $null=Native 'restore'; Wait-For { $r=@(Native 'inspect')[0]; -not $r.maximized -and (Same-Rect $r.screen $normal.screen) } 'restored normal bounds'
    Close-App; Start-App
    Wait-For { $r=@(Native 'inspect')[0]; -not $r.maximized -and (Same-Rect $r.screen $normal.screen) } 'normal restart persistence'
    Mark-Passed 'window-geometry' 'Observed enforced minimum, exact resize, maximization and two real restart placements.' @{initial=$initial;minimum=$minimum;normal=$normal;maximizedAfterRestart=$maximized;restoredAfterRestart=@(Native 'inspect')[0];monitor=$monitor}
    Open-Study
    $currentCase='dpi-video-bounds'
    $bounds=Assert-Viewport
    Mark-Passed 'dpi-video-bounds' 'Accessible physical viewport agrees with its visible native child at the recorded window DPI.' $bounds
    $currentCase='fullscreen'
    $beforeFull=@(Native 'inspect')[0]
    [SurtitleProductionUia]::Invoke((Find-Id 'player-fullscreen'))
    Wait-For { Same-Rect (@(Native 'inspect')[0]).screen $area[0].bounds } 'fullscreen monitor bounds'
    $full=Assert-Viewport
    [SurtitleProductionUia]::Invoke((Find-Id 'player-fullscreen'))
    Wait-For { Same-Rect (@(Native 'inspect')[0]).screen $beforeFull.screen } 'fullscreen restore'
    Mark-Passed 'fullscreen' 'Native fullscreen filled its monitor, retained matching video bounds, and restored the prior window.' @{before=$beforeFull;fullscreen=$full;after=@(Native 'inspect')[0]}
    $currentCase='owned-dialog-focus'
    [SurtitleProductionUia]::Focus((Find-Id 'study-manage-media'))
    [SurtitleProductionUia]::Invoke((Find-Id 'study-manage-media'))
    Wait-For { [SurtitleProductionUia]::OwnedDialog($app.Id,$mainHandle)-ne 0 } 'native owned media dialog'
    $dialog=[SurtitleProductionUia]::OwnedDialog($app.Id,$mainHandle)
    Wait-For { -not [SurtitleProductionUia]::Enabled($mainHandle) -and [SurtitleProductionUia]::FocusWithin($dialog,$app.Id) } 'disabled parent and dialog focus'
    $underlying=Find-Id 'nav-library'
    if($underlying.Current.IsEnabled -or -not [SurtitleProductionUia]::RejectsInvoke($underlying)){throw 'Owned dialog did not reject underlying accessible navigation'}
    $close=[SurtitleProductionUia]::Id([SurtitleProductionUia]::FromHandle($dialog),'close-media')
    [SurtitleProductionUia]::Invoke($close)
    Wait-For { [SurtitleProductionUia]::OwnedDialog($app.Id,$mainHandle)-eq 0 -and [SurtitleProductionUia]::Enabled($mainHandle) -and [SurtitleProductionUia]::FocusWithin($mainHandle,$app.Id) } 'dialog close and parent focus return'
    Mark-Passed 'owned-dialog-focus' 'Observed native GW_OWNER, disabled parent, rejected underlying Invoke, focused dialog and focus returned after close.' @{mainHandle=$mainHandle;dialogHandle=$dialog;ownerConfirmed=$true;parentDisabled=$true;underlyingInvokeRejected=$true;focusReturned=$true}
    $currentCase='raw-input-restart'
    [SurtitleProductionUia]::Invoke((Find-Id 'nav-settings'))
    Wait-For { $null -ne  (Find-Id 'settings-learningLanguage') } 'settings raw input'
    $raw='   '
    [SurtitleProductionUia]::SetValue((Find-Id 'settings-learningLanguage'),$raw)
    Wait-For { [SurtitleProductionUia]::Value((Find-Id 'settings-learningLanguage'))-ceq $raw } 'unfinished input acknowledgement'
    Close-App; Start-App
    [SurtitleProductionUia]::Invoke((Find-Id 'nav-settings'))
    Wait-For { $field=Find-Id 'settings-learningLanguage'; $field -and [SurtitleProductionUia]::Value($field)-ceq $raw } 'actual raw input restored after clean restart'
    [SurtitleProductionUia]::SetValue((Find-Id 'settings-learningLanguage'),'en')
    Wait-For { [SurtitleProductionUia]::Value((Find-Id 'settings-learningLanguage'))-eq 'en' } 'restored disposable setting'
    Close-App
    Mark-Passed 'raw-input-restart' 'Unfinished whitespace language input survived a real clean process restart and was restored through ValuePattern.' @{field='settings-learningLanguage';rawLength=$raw.Length;exactRawMatched=$true;restartCount=1;restoredValue='en';inputMethod='UIAutomation ValuePattern, not physical typing or IME'}
} catch {
    $records[$currentCase].status='failed'
    $records[$currentCase].observations=@{summary=$_.Exception.Message}
    $observations['failure']=@{case=$currentCase;message=$_.Exception.Message}
} finally {
    if($app){if(-not $app.HasExited){$app.Kill();$null=$app.WaitForExit(5000)};$app.Dispose()}
}
$afterText = & python -B (Join-Path $PSScriptRoot 'production-profile.py') $DataRoot $Fixture after
if($LASTEXITCODE -eq 0){
    $after=$afterText|ConvertFrom-Json
    if($before.learningSha256 -eq $after.learningSha256){$paidRequests=$after.paidRequests}else{$records['raw-input-restart'].status='failed';$records['raw-input-restart'].observations=@{summary='Native acceptance changed learning content'}}
}else{$observations['finalAudit']='Final profile audit failed; zero paid requests cannot be asserted.'}
function Write-NewJson([string]$Path,$Value){
    $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($Value|ConvertTo-Json -Depth 24))
    $stream=[IO.File]::Open($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try{$stream.Write($bytes,0,$bytes.Length)}finally{$stream.Dispose()}
}
$detailsPath=Join-Path ([IO.Path]::GetDirectoryName($Output)) 'native-observations.json'
Write-NewJson $detailsPath $observations
$detailHash=(Get-FileHash -LiteralPath $detailsPath -Algorithm SHA256).Hash.ToLowerInvariant()
foreach($record in $records.Values){
    if($record.status -ne 'not_run'){$record.evidence=@(@{path='native-observations.json';sha256=$detailHash})}
}
if(Test-Path -LiteralPath $copy){$records['production-playback'].evidence=@(@{path='production-smoke.json';sha256=(Get-FileHash -LiteralPath $copy -Algorithm SHA256).Hash.ToLowerInvariant()})}
$allPassed=@($records.Values|Where-Object{$_.status -ne 'passed'}).Count -eq 0 -and $paidRequests -eq 0
$report=[ordered]@{schemaVersion=$inventory.schemaVersion;suite=$inventory.suite;executableSha256=$receipt.executableSha256;installerSha256=$receipt.installerSha256;sourceRevision=$receipt.sourceRevision;normalBuild=$true;paidRequests=$paidRequests;passed=$allPassed;cases=@($records.Values);limitations=@('Only the observed monitor DPI is covered by automated bounds checks.','UIAutomation ValuePattern does not establish physical keyboard, Japanese IME or candidate-window behavior.','The automated UIA phase alone makes no direct-listening, audio-output, long-media or GPU-efficiency claim; completed external phases identify their own measurements.','The external cases in the authoritative inventory remain required; not_run blocks release, including display/monitor, keyboard/clipboard/screen-reader and current 1080p60/4K30 workload measurements.')}
Write-NewJson $Output $report
