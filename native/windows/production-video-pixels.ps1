# SPDX-License-Identifier: GPL-3.0-or-later
# Shared by guarded, disposable-profile production workers. Dot sourcing is inert.
function Assert-ProductionVideoPixels($App, [string]$Fixture, [string]$Output, $Viewport, $Slider, [string]$Stage) {
    $geometry = [SurtitleProductionUia]::OwnedViewportCapture($App, $Viewport)
    $fraction = [SurtitleProductionUia]::Range($Slider, 10000) / 10000.0
    $image = $Output + '.' + $Stage + '.png'
    Assert-NoProbeLinks $image
    if (Test-Path -LiteralPath $image) { throw 'Existing viewport evidence is protected.' }
    $ffmpeg = if ($env:SURTITLE_TEST_FFMPEG) { $env:SURTITLE_TEST_FFMPEG } elseif ($env:FFMPEG_PATH) { $env:FFMPEG_PATH } else { (Get-Command ffmpeg -CommandType Application -ErrorAction Stop).Source }
    $ffmpeg = (Resolve-Path -LiteralPath $ffmpeg).Path
    $arguments = @('-B', (Join-Path $PSScriptRoot 'production-video-pixels.py'), '--ffmpeg', $ffmpeg,
        '--fixture', $Fixture, '--output', $image, '--fraction', $fraction.ToString('R',[Globalization.CultureInfo]::InvariantCulture), '--geometry') + @($geometry)
    $text = & python @arguments
    if ($LASTEXITCODE -ne 0) { throw 'Actual composed fixture pixels failed verification.' }
    $after = [SurtitleProductionUia]::OwnedViewportCapture($App, $Viewport)
    if (($geometry -join ',') -ne ($after -join ',') -or [Math]::Abs([SurtitleProductionUia]::Range($Slider,10000)/10000.0-$fraction) -gt 0.002) {
        throw 'Viewport ownership, geometry or paused position changed during capture.'
    }
    return ($text | ConvertFrom-Json)
}

function Copy-ProductionPixelEvidence([string]$ReportPath, [string]$Destination) {
    $report = Get-Content -LiteralPath $ReportPath -Raw | ConvertFrom-Json
    if (@($report.pixelEvidence).Count -ne 2) { throw 'Production smoke lacks two verified fixture-position crops.' }
    foreach ($record in $report.pixelEvidence) {
        if (-not $record.path -or [IO.Path]::GetFileName($record.path) -cne $record.path -or $record.sha256 -notmatch '^[a-f0-9]{64}$') {
            throw 'Invalid production pixel evidence reference.'
        }
        $source = Join-Path ([IO.Path]::GetDirectoryName($ReportPath)) $record.path
        $target = Join-Path $Destination $record.path
        Assert-NoProbeLinks $source
        Assert-NoProbeLinks $target
        if ((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash -ine $record.sha256) { throw 'Production pixel evidence hash changed.' }
        if (Test-Path -LiteralPath $target) { throw 'Existing archived pixel evidence is protected.' }
        [IO.File]::Copy($source, $target, $false)
    }
}
