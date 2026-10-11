# SPDX-License-Identifier: GPL-3.0-or-later
param(
  [Parameter(Mandatory)] [string] $Pcm,
  [Parameter(Mandatory)] [string] $Model,
  [Parameter(Mandatory)] [string] $BaselineRuntime,
  [Parameter(Mandatory)] [string] $CandidateRuntime,
  [Parameter(Mandatory)] [string] $OutputDirectory
)
$ErrorActionPreference = 'Stop'
$repository = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$output = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $output | Out-Null
Push-Location $repository
try {
  & cargo build -p surtitle-ai --example redesign_vad --locked --offline --config 'profile.dev.package.surtitle-ai.opt-level=1'
  if ($LASTEXITCODE -ne 0) { throw 'Could not build isolated VAD comparison' }
  $executable = Join-Path $repository 'target/debug/examples/redesign_vad.exe'
  $runs = @()
  for ($round = 0; $round -lt 3; $round++) {
    $order = if ($round % 2 -eq 0) { @('baseline', 'candidate') } else { @('candidate', 'baseline') }
    foreach ($kind in $order) {
      $runtime = if ($kind -eq 'baseline') { $BaselineRuntime } else { $CandidateRuntime }
      $reportPath = Join-Path $output "$round-$kind.json"
      & $executable $Pcm $Model $runtime $reportPath
      if ($LASTEXITCODE -ne 0) { throw "$kind VAD process failed" }
      $report = Get-Content -Raw -LiteralPath $reportPath | ConvertFrom-Json
      $runs += [ordered]@{ round = $round; kind = $kind; initializationMs = $report.initializationMs; inferenceMs = $report.inferenceMs; analysisSha256 = $report.analysisSha256; runtimeSha256 = $report.runtimeSha256 }
    }
    $baseline = Get-Content -Raw -LiteralPath (Join-Path $output "$round-baseline.json") | ConvertFrom-Json
    $candidate = Get-Content -Raw -LiteralPath (Join-Path $output "$round-candidate.json") | ConvertFrom-Json
    if ($baseline.analysisSha256 -ne $candidate.analysisSha256 -or
        ($baseline.chunks | ConvertTo-Json -Depth 20 -Compress) -ne ($candidate.chunks | ConvertTo-Json -Depth 20 -Compress)) {
      throw 'Runtime candidate changed VAD evidence or immutable chunk boundaries'
    }
  }
  [ordered]@{
    schemaVersion = 1; fixture = 'Six-minute synthesized English speech, mono 16 kHz PCM16';
    pcmSha256 = $baseline.pcmSha256; modelSha256 = $baseline.modelSha256;
    totalSamples = $baseline.totalSamples; chunkCount = $baseline.chunks.Count;
    identicalEvidenceAndChunks = $true; cloudCalls = 0; runs = $runs;
    scope = 'Three alternating isolated-process pairs, production Silero streaming wrapper, one inference thread. Not a speech-quality evaluation.'
  } | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath (Join-Path $output 'comparison.json') -Encoding utf8
} finally { Pop-Location }
