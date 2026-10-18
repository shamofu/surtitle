# SPDX-License-Identifier: GPL-3.0-or-later
param([switch]$Target, [Parameter(Mandatory)][string]$EvidenceDirectory)
$ErrorActionPreference = 'Stop'
Add-Type -Path (Join-Path $PSScriptRoot 'foreground-activation-fixture.cs')
function Write-FixtureJson($Value, [string]$Name) {
    $destination = Join-Path $EvidenceDirectory $Name
    [IO.File]::WriteAllText($destination + '.tmp', ($Value | ConvertTo-Json -Compress))
    [IO.File]::Move($destination + '.tmp', $destination)
}
try {
    Add-Type -Path (Join-Path $PSScriptRoot 'windows-standard-user.cs')
    if ($Target) {
        $window = [ForegroundActivationFixture]::StartWindow('Surtitle activation target', 500)
        $targetScope = [ForegroundActivationFixture]::ScopeSelf()
        Write-FixtureJson @{ window = $window.ToInt64(); processId = $PID } 'target-ready.json'
        $clock = [Diagnostics.Stopwatch]::StartNew()
        while (-not (Test-Path -LiteralPath (Join-Path $EvidenceDirectory 'activate.flag'))) {
            if ($clock.ElapsedMilliseconds -ge 15000) { throw 'The controller did not establish its owned foreground lock.' }
            Start-Sleep -Milliseconds 25
        }
        # The locked foreground process can still transfer its own foreground.
        # The other owned process must call the real API to observe the denial.
        $handoff = [SurtitleWindowsStandardUser]::ActivateForegroundJob($targetScope, [Environment]::ProcessPath)
        $handoff | ConvertTo-Json -Depth 10 -Compress | ForEach-Object {
            $destination = Join-Path $EvidenceDirectory 'target-handoff.json'
            [IO.File]::WriteAllText($destination + '.tmp', $_)
            [IO.File]::Move($destination + '.tmp', $destination)
        }
        $click = [ForegroundActivationFixture]::WaitForClick()
        Write-FixtureJson $click 'target-click.json'
        exit 0
    }
    $window = [ForegroundActivationFixture]::StartWindow('Surtitle foreground policy fixture', 100)
    $application = [Environment]::ProcessPath
    $selfJob = [ForegroundActivationFixture]::ScopeSelf()
    $setup = [SurtitleWindowsStandardUser]::ActivateForegroundJob($selfJob, $application)
    if (-not $setup.acknowledged -or [ForegroundActivationFixture]::ForegroundWindow() -ne $window.ToInt64()) {
        throw 'The owned policy fixture did not become foreground.'
    }
    $targetJob = [ForegroundActivationFixture]::StartTarget($application, $PSCommandPath, $EvidenceDirectory)
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $readyPath = Join-Path $EvidenceDirectory 'target-ready.json'
    while (-not (Test-Path -LiteralPath $readyPath)) {
        if ([ForegroundActivationFixture]::TargetExited()) { throw [ForegroundActivationFixture]::TargetError() }
        if ($clock.ElapsedMilliseconds -ge 15000) { throw 'The owned target fixture did not create a window.' }
        Start-Sleep -Milliseconds 25
    }
    $targetState = Get-Content -LiteralPath $readyPath -Raw | ConvertFrom-Json
    if ($targetState.processId -ne [ForegroundActivationFixture]::TargetProcessId()) { throw 'Target fixture identity changed.' }
    if ([ForegroundActivationFixture]::ForegroundWindow() -ne $window.ToInt64()) { throw 'The nonactivating target changed the foreground.' }
    [ForegroundActivationFixture]::LockForeground()
    [IO.File]::WriteAllText((Join-Path $EvidenceDirectory 'activate.flag'), '')
    $clock.Restart()
    $handoffPath = Join-Path $EvidenceDirectory 'target-handoff.json'
    while (-not (Test-Path -LiteralPath $handoffPath)) {
        if ([ForegroundActivationFixture]::TargetExited()) { throw [ForegroundActivationFixture]::TargetError() }
        if ($clock.ElapsedMilliseconds -ge 6000) { throw 'The owned target did not finish the foreground handoff.' }
        Start-Sleep -Milliseconds 25
    }
    $handoff = Get-Content -LiteralPath $handoffPath -Raw | ConvertFrom-Json
    if ($handoff.accepted -or $handoff.attempts -ne 1 -or -not $handoff.captionClicked -or -not $handoff.acknowledged) {
        throw ('The real denied-SetForegroundWindow caption path was not exercised: ' + ($handoff | ConvertTo-Json -Depth 8 -Compress))
    }
    if ($handoff.expected.window -ne $targetState.window -or $handoff.expected.processId -ne $targetState.processId -or
        [ForegroundActivationFixture]::ForegroundWindow() -ne $targetState.window) { throw 'Handoff did not acknowledge the exact owned target.' }
    [ForegroundActivationFixture]::RequestClick($targetState.window)
    $clock.Restart()
    $clickPath = Join-Path $EvidenceDirectory 'target-click.json'
    while (-not (Test-Path -LiteralPath $clickPath)) {
        if ([ForegroundActivationFixture]::TargetExited()) { throw [ForegroundActivationFixture]::TargetError() }
        if ($clock.ElapsedMilliseconds -ge 5000) { throw 'The foreground target did not acknowledge its native client click.' }
        Start-Sleep -Milliseconds 25
    }
    $click = Get-Content -LiteralPath $clickPath -Raw | ConvertFrom-Json
    'SURTITLE_FOREGROUND_ACTIVATION:' + (@{ setup = $setup; handoff = $handoff; click = $click } | ConvertTo-Json -Depth 10 -Compress)
} finally { [ForegroundActivationFixture]::Dispose() }
