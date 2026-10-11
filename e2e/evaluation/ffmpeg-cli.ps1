# SPDX-License-Identifier: GPL-3.0-or-later
# Compare explicit, isolated CLI pairs; never install or change tool selection.
param(
  [Parameter(Mandatory)] [string] $BaselineFfmpeg,
  [Parameter(Mandatory)] [string] $CandidateFfmpeg,
  [Parameter(Mandatory)] [string] $Source,
  [Parameter(Mandatory)] [string] $Model,
  [Parameter(Mandatory)] [string] $Runtime,
  [Parameter(Mandatory)] [string] $PreparationExecutable,
  [Parameter(Mandatory)] [string] $AppTestExecutable,
  [Parameter(Mandatory)] [string] $ToolsTestExecutable,
  [Parameter(Mandatory)] [string] $OutputDirectory,
  [switch] $SummarizeOnly
)
$ErrorActionPreference = 'Stop'
$output = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $output | Out-Null
function Hash([string] $Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Compact($Value) { ConvertTo-Json -InputObject $Value -Depth 50 -Compress }
function Run([string] $Executable, [string[]] $Arguments, [string] $Name, [int] $TimeoutSeconds = 900) {
  # ProcessStartInfo.ArgumentList preserves Unicode, spaces, and shell metacharacters.
  $start = [Diagnostics.ProcessStartInfo]::new([IO.Path]::GetFullPath($Executable))
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  foreach ($argument in $Arguments) { $start.ArgumentList.Add($argument) }
  $timer = [Diagnostics.Stopwatch]::StartNew()
  $process = [Diagnostics.Process]::Start($start)
  $stdout = $process.StandardOutput.ReadToEndAsync()
  $stderr = $process.StandardError.ReadToEndAsync()
  if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
    $process.Kill($true)
    $process.WaitForExit()
    throw "$Name exceeded $TimeoutSeconds seconds"
  }
  $out = $stdout.GetAwaiter().GetResult()
  $err = $stderr.GetAwaiter().GetResult()
  $out | Set-Content -LiteralPath (Join-Path $output "$Name.stdout.log") -Encoding utf8
  $err | Set-Content -LiteralPath (Join-Path $output "$Name.stderr.log") -Encoding utf8
  if ($process.ExitCode -ne 0) { throw "$Name failed: $err $out" }
  Write-Host "$Name passed ($([Math]::Round($timer.Elapsed.TotalSeconds, 3)) s)"
  return [ordered]@{ name = $Name; seconds = $timer.Elapsed.TotalSeconds; stdout = $out }
}
$previousFfmpeg = $env:SURTITLE_TEST_FFMPEG
try {
  $reports = [ordered]@{}
  foreach ($kind in @('baseline', 'candidate')) {
    if ($SummarizeOnly) {
      $reports[$kind] = Get-Content -Raw -LiteralPath (Join-Path $output "$kind.json") | ConvertFrom-Json -AsHashtable
      continue
    }
    $ffmpeg = [IO.Path]::GetFullPath($(if ($kind -eq 'baseline') { $BaselineFfmpeg } else { $CandidateFfmpeg }))
    $ffprobe = Join-Path (Split-Path $ffmpeg) 'ffprobe.exe'
    $version = Run $ffmpeg @('-version') "$kind-version" 30
    $companionVersion = Run $ffprobe @('-version') "$kind-companion-version" 30
    $encoders = Run $ffmpeg @('-hide_banner', '-encoders') "$kind-encoders" 30
    foreach ($encoder in @('flac', 'pcm_s16le')) {
      if ($encoders.stdout -notmatch "(?m)^\s*A\S*\s+$encoder\s") { throw "$kind lacks $encoder" }
    }
    $preparationDirectory = Join-Path $output "$kind-preparation"
    $null = Run $PreparationExecutable @($Source, $ffmpeg, $Model, $Runtime, $preparationDirectory) "$kind-preparation"
    $preparation = Get-Content -Raw -LiteralPath (Join-Path $preparationDirectory 'preparation.json') | ConvertFrom-Json
    $receipts = @(Get-ChildItem -LiteralPath (Join-Path $preparationDirectory 'baseline-0') -Recurse -Filter receipt.json)
    if ($receipts.Count -ne 1) { throw 'Expected exactly one serial receipt for cross-version comparison' }
    $receipt = Get-Content -LiteralPath $receipts[0].FullName -Raw | ConvertFrom-Json
    $audio = @()
    foreach ($request in $receipt.prepared_job.requests) {
      $index = $audio.Count
      $pcm = Join-Path $output "$kind-chunk-$index.pcm"
      # Decode both outputs with the same baseline decoder to compare sample bytes.
      $null = Run $BaselineFfmpeg @('-hide_banner', '-loglevel', 'error', '-nostdin', '-i', $request.audio.path, '-f', 's16le', '-c:a', 'pcm_s16le', '-y', $pcm) "$kind-decode-$index" 60
      $audio += [ordered]@{ flacSha256 = $request.audio.sha256; pcmSha256 = Hash $pcm; pcmBytes = (Get-Item -LiteralPath $pcm).Length; durationMs = $request.audio.duration_ms }
    }
    $env:SURTITLE_TEST_FFMPEG = $ffmpeg
    $tests = @()
    foreach ($name in @('installed_ffmpeg_preserves_native_rate_wav_tail_without_padding', 'installed_ffmpeg_preserves_source_clock_and_cleans_failed_outputs')) {
      $result = Run $AppTestExecutable @("application::media_tools::card_audio::tests::$name", '--exact', '--ignored', '--nocapture', '--test-threads=1') "$kind-$name" 600
      if ($result.stdout -notmatch 'test result: ok\. 1 passed; 0 failed; 0 ignored;') { throw "Exact required test did not execute: $name" }
      $tests += [ordered]@{ name = $name; passed = $true; seconds = $result.seconds }
    }
    $name = 'command::tests::multitrack_extraction_preserves_selected_stream'
    $result = Run $ToolsTestExecutable @($name, '--exact', '--ignored', '--nocapture', '--test-threads=1') "$kind-multitrack" 180
    if ($result.stdout -notmatch 'test result: ok\. 1 passed; 0 failed; 0 ignored;') { throw "Exact required test did not execute: $name" }
    $tests += [ordered]@{ name = $name; passed = $true; seconds = $result.seconds }
    $reports[$kind] = [ordered]@{
      executableSha256 = Hash $ffmpeg; ffprobeSha256 = Hash $ffprobe;
      executableBytes = (Get-Item -LiteralPath $ffmpeg).Length;
      version = ($version.stdout -split "`n")[0].Trim(); configuration = ($version.stdout -split "`n")[2].Trim();
      companionVersion = ($companionVersion.stdout -split "`n")[0].Trim();
      preparation = $preparation; chunks = $receipt.chunks; vadPauseEvidence = $receipt.vad_pause_evidence;
      binding = $receipt.prepared_job.binding; audio = $audio; tests = $tests
    }
    $reports[$kind] | ConvertTo-Json -Depth 50 | Set-Content -LiteralPath (Join-Path $output "$kind.json") -Encoding utf8
  }
  $sameChunks = (Compact $reports.baseline.chunks) -eq (Compact $reports.candidate.chunks)
  $sameVad = (Compact $reports.baseline.vadPauseEvidence) -eq (Compact $reports.candidate.vadPauseEvidence)
  $sameSourceBinding = $reports.baseline.binding.media_id -eq $reports.candidate.binding.media_id -and
    $reports.baseline.binding.transcript_revision -eq $reports.candidate.binding.transcript_revision -and
    $reports.baseline.binding.source_sha256 -eq $reports.candidate.binding.source_sha256
  # A receipt freezes the tool identity too. New binaries MUST change that digest.
  $toolChanged = $reports.baseline.executableSha256 -ne $reports.candidate.executableSha256 -or
    $reports.baseline.ffprobeSha256 -ne $reports.candidate.ffprobeSha256
  $settingsChanged = $reports.baseline.binding.settings_sha256 -ne $reports.candidate.binding.settings_sha256
  if ($toolChanged -and -not $settingsChanged) { throw 'Changed tool retained its old immutable preparation settings digest' }
  $samePcm = (Compact @($reports.baseline.audio | ForEach-Object { $_.pcmSha256 })) -eq (Compact @($reports.candidate.audio | ForEach-Object { $_.pcmSha256 }))
  if (-not ($sameChunks -and $sameVad -and $sameSourceBinding -and $samePcm)) { throw 'Candidate changed source scope, sample bytes, boundaries, or VAD evidence' }
  [ordered]@{
    schemaVersion = 1; measuredAt = [DateTime]::UtcNow.ToString('o'); cloudCalls = 0;
    sourceSha256 = Hash $Source; modelSha256 = Hash $Model; runtimeSha256 = Hash $Runtime;
    preparationExecutableSha256 = Hash $PreparationExecutable; appTestExecutableSha256 = Hash $AppTestExecutable; toolsTestExecutableSha256 = Hash $ToolsTestExecutable;
    chunksIdentical = $sameChunks; vadIdentical = $sameVad; sourceBindingIdentical = $sameSourceBinding; decodedPcmIdentical = $samePcm;
    toolSnapshotChanged = $toolChanged; preparationSettingsDigestChanged = $settingsChanged;
    flacFilesIdentical = (Compact @($reports.baseline.audio | ForEach-Object { $_.flacSha256 })) -eq (Compact @($reports.candidate.audio | ForEach-Object { $_.flacSha256 }));
    reports = $reports;
    limitations = 'One synthesized English six-minute fixture. Each CLI ran the same existing production preparation evaluator with three alternating serial/staged pairs and cancellation/source-mutation cleanup. CLI versions were measured in baseline-then-candidate order; compiler, configuration, file size and host load also differ. Card tests verify source timing and cleanup, not general recognition quality. No production CLI/profile was changed.'
  } | ConvertTo-Json -Depth 60 | Set-Content -LiteralPath (Join-Path $output 'comparison.json') -Encoding utf8
} finally { $env:SURTITLE_TEST_FFMPEG = $previousFfmpeg }
